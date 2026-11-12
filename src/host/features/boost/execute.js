// src/host/features/boost/execute.js
//
// 执行器：真正动东西的那一层。
//
// 六道护栏，缺一不可：
//
//   ① **白名单**：能动的目标只能来自 catalog.js（工具链缓存）、dshself.js（DSH
//      自己的数据）、processes.js（进程与窗口）三个目录。客户端传回来的只有
//      条目 id，具体路径在执行前**重新解析**一次 —— 客户端没有任何机会指定
//      要删哪个目录、杀哪个进程。
//
//   ② **在用即跳过**：删文件之前先看一遍所有正在运行的进程的命令行。凡是出现
//      了要删的路径，这个路径下对应的子目录就跳过不删。
//      这一条不是锦上添花 —— 实测这台机器上 `~/.npm/_npx/<hash>` 正在跑 MCP
//      server，`~/Library/Caches/pnpm/dlx/<hash>` 更是**正在运行的 DSH 自己**。
//
//   ③ **路径合法**：绝对路径、必须存在、不能是根目录、不能是家目录本身、
//      至少要有两段路径、不含 `..`。
//
//   ④ **活着的会话不碰**：DSH 正在跑的会话，它的日志还在被追加。
//
//   ⑤ **进程要复核**：pid 会被回收复用 —— 执行前重新看一眼那个 pid 现在的
//      命令行跟体检时是不是同一条，不是就跳过。
//
//   ⑥ **只用 SIGTERM**：不发 SIGKILL，进程还有机会自己收尾。
//
// 每条命令都有超时；所有动作都写进审计日志（DSH_HOME 下的 boost.log）。

import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { formatCommand, runCommand } from './catalog.js';
import * as processes from './processes.js';
import {
  listLegacyLogs,
  listSessions,
  listTrashSnapshots,
  readArchivedSessionIds,
} from './dshself.js';

/** 单条清理命令的超时（毫秒）。brew cleanup / pnpm store prune 都可能比较慢。 */
const CLEAN_TIMEOUT_MS = 180000;

/**
 * Windows 上必须拒绝的系统根目录（只挡「根目录本身」，不挡它下面的缓存目录）。
 *
 * 比如 C:\Windows 要拒绝，但 C:\Windows\Temp、C:\Windows\SoftwareDistribution\Download
 * 是允许清理的缓存目录 —— Windows 侧的清理项就落在这些更深的地方。
 *
 * 恢复分区（Recovery）、性能日志（PerfLogs）、系统卷信息（System Volume
 * Information）这三个是系统自己管理的目录，碰了会出事，同样挡在根目录这一层。
 */
const WINDOWS_SYSTEM_ROOTS = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'users',
  'system volume information',
  'recovery',
  'perflogs',
]);

/**
 * 浏览器每个配置目录里的缓存目录（Default、Profile 1 … 里各有一份）。
 */
const PROFILE_CACHE_DIRS = [
  'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'DawnCache',
  'GraphiteDawnCache', 'Service Worker/CacheStorage', 'Service Worker/ScriptCache',
];

/**
 * 配置根目录下的缓存目录（浏览器自己管的那些：崩溃上报、组件缓存……）。
 */
const ROOT_CACHE_DIRS = [
  ...PROFILE_CACHE_DIRS,
  'Crashpad/pending', 'component_crx_cache', 'optimization_guide_model_store',
];

/**
 * 浏览器配置目录的名字（Chrome / Edge / Brave 系）。
 *
 * Default 是第一个配置，Profile 1、Profile 2 是后来加的；Guest Profile、
 * System Profile 是浏览器自己建的。
 */
const PROFILE_DIR_PATTERN = /^(Default|Profile \d+|Guest Profile|System Profile)$/;

/** Windows 上比较路径不区分大小写（NTFS 默认如此），POSIX 上区分。 */
const CASE_INSENSITIVE = process.platform === 'win32';

/**
 * 把分隔符统一成 '/'（Windows 的命令行里两种分隔符混着用）。
 *
 * 长度不变 —— 归一化之后的下标还能直接用回原文（子目录名要保留原来的大小写）。
 *
 * @param {string} value 原文。
 * @returns {string} 统一分隔符后的文本。
 */
function unifySeparators(value) {
  return CASE_INSENSITIVE ? value.replace(/\\/g, '/') : value;
}

/**
 * 转义正则里的元字符。
 *
 * @param {string} value 原文。
 * @returns {string} 转义后的文本。
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 去掉末尾多余的分隔符（根目录本身保留）。
 *
 * @param {string} value 路径。
 * @returns {string} 去掉末尾分隔符后的路径。
 */
function trimTrailingSeparators(value) {
  const trimmed = value.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * 去掉路径里的「.」段。
 *
 * 「.」解析成它自己，但留着会让层级数与家目录判定失真 —— '/Users/x/.' 会被 rm
 * 解析成家目录本身，正是路径护栏要挡的事。去掉之后再判定：等于家目录、或者
 * 层数不够，一律拒。
 *
 * 「..」不解析 —— 它一律直接拒（见 checkPosixPath / checkWindowsPath）。
 *
 * @param {string} value 已统一分隔符的路径。
 * @returns {string} 去掉「.」段后的路径。
 */
function dropDotSegments(value) {
  return value.split('/').filter((part) => part !== '.').join('/');
}

/**
 * Windows 路径里「根之后的各段」。
 *
 * 盘符（C:\）与 UNC 共享（\\server\share）都算**一级** —— 所以 Windows 上的层级
 * 判断是「根 + 至少一段」：C:\$Recycle.Bin 够得着，C:\ 太浅。
 *
 * @param {string} normalized 已统一分隔符的路径。
 * @returns {string[]} 根之后的各段。
 */
function windowsSegments(normalized) {
  if (normalized.startsWith('//')) {
    return normalized.slice(2).split('/').filter((part) => part !== '').slice(2);
  }
  return normalized.replace(/^[a-zA-Z]:\//, '').split('/').filter((part) => part !== '');
}

/**
 * 正在运行的进程的命令行。
 *
 * 命令行由进程层提供 —— 那边知道 macOS 的 ps 与 Windows 的进程查询分别怎么读，
 * 这里不重复造一遍。
 *
 * 拿不到就当没有进程在跑（降级成空数组），不让护栏把清理整个卡死。
 *
 * @returns {Promise<string[]>} 命令行列表。
 */
export async function listRunningCommandLines() {
  const provider = processes.listRunningCommandLines;
  if (typeof provider !== 'function') return [];
  try {
    const lines = await provider();
    return Array.isArray(lines) ? lines : [];
  } catch {
    return [];
  }
}

/**
 * 这个路径在不在。
 *
 * @param {string} target 路径。
 * @returns {Promise<boolean>} 在不在。
 */
async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 找出缓存目录里**正在被使用**的子目录名。
 *
 * 只看命令行：进程命令行里出现了 `<缓存目录>/xxx`，说明 xxx 这个子目录里有
 * 正在被运行的东西，删了就会打断它。
 *
 * Windows 上分隔符统一、大小写不敏感（NTFS 默认如此）；子目录名从**原文**里切，
 * 保留原来的大小写 —— 拿它跟目录项的名字比对才比得上。
 *
 * @param {string} cachePath 缓存目录。
 * @param {string[]} commandLines 正在运行的命令行。
 * @returns {Set<string>} 被占用的子目录名。
 */
export function findInUseSubdirs(cachePath, commandLines) {
  const used = new Set();
  if (typeof cachePath !== 'string' || cachePath === '') return used;
  const prefix = trimTrailingSeparators(unifySeparators(cachePath));
  const pattern = new RegExp(`${escapeRegExp(prefix)}/`, CASE_INSENSITIVE ? 'i' : '');
  for (const line of commandLines) {
    const unified = unifySeparators(line);
    const match = pattern.exec(unified);
    if (match === null) continue;
    const rest = unified.slice(match.index + match[0].length);
    const name = rest.split('/')[0];
    if (name !== '') used.add(name);
  }
  return used;
}

/**
 * 这个路径**整体**是不是正在被使用。
 *
 * 判据是「路径作为一个完整的参数出现在命令行里」：
 *   - `--user-data-dir=/x/profile` → 在用（整体被占了）；
 *   - `tail -f /x/cache/inuse/a.txt` → **不算**整体在用 —— 占用的只是它下面的
 *     一个子目录，那是 findInUseSubdirs 的活，不该把整个缓存目录都放过。
 *
 * 前后都要求是参数的边界：前面是行首 / 空白 / `=` / 引号（Windows 上带空格的
 * 路径命令行里是带引号的），后面不能是路径字符
 * （否则 `/x/cache` 会匹配上 `/x/cache/inuse/a.txt`）。
 *
 * @param {string} path 路径。
 * @param {string[]} commandLines 正在运行的命令行。
 * @returns {boolean} 是否在用。
 */
export function isPathInUse(path, commandLines) {
  if (typeof path !== 'string' || path === '') return false;
  const target = trimTrailingSeparators(unifySeparators(path));
  const pattern = new RegExp(
    `(?:^|[\\s="])${escapeRegExp(target)}(?![\\/\\w.-])`,
    CASE_INSENSITIVE ? 'i' : '',
  );
  return commandLines.some((line) => pattern.test(unifySeparators(line)));
}

/**
 * POSIX 路径的合法性（macOS / Linux）。
 *
 * 层数口径：根（'/'）**不计入层级**，根之后的段数至少 2 段 ——
 * '/Users/x' 两段放行，'/Users' 一段拒绝。
 *
 * @param {string} value 已去空白的路径。
 * @param {string} home 家目录。
 * @returns {{ok: boolean, reason?: string}} 结论。
 */
function checkPosixPath(value, home) {
  const normalized = trimTrailingSeparators(dropDotSegments(value));
  if (normalized === '/') return { ok: false, reason: '拒绝操作根目录' };
  const homeNormalized = typeof home === 'string'
    ? trimTrailingSeparators(dropDotSegments(home))
    : '';
  if (homeNormalized !== '' && homeNormalized !== '/' && normalized === homeNormalized) {
    return { ok: false, reason: '拒绝操作家目录本身' };
  }
  const depth = normalized.split('/').filter((part) => part !== '').length;
  if (depth < 2) return { ok: false, reason: '路径层级过浅，拒绝操作' };
  if (value.includes('..')) return { ok: false, reason: '路径含 ..，拒绝操作' };
  return { ok: true };
}

/**
 * Windows 路径的合法性。
 *
 * 层数口径（跟 POSIX 对称，只是 Windows 的「根」是盘符）：
 *   · 盘符（C:\）或 UNC 共享（\\server\share）本身算**一级**，但不算成「段」；
 *   · 根之后的段数至少 1 段 —— C:\$Recycle.Bin 是「盘符 + 一段」两级，放行；
 *     C:\ 只有盘符这一级，拒绝；
 *   · 于是 C:\Windows\Temp 是三段（盘符、Windows、Temp），放行。
 *
 * @param {string} value 已去空白的路径。
 * @param {string} home 家目录。
 * @returns {{ok: boolean, reason?: string}} 结论。
 */
function checkWindowsPath(value, home) {
  const unified = unifySeparators(value);
  if (!win32.isAbsolute(unified)) return { ok: false, reason: '不是绝对路径' };
  const normalized = trimTrailingSeparators(dropDotSegments(unified));
  if (/^[a-zA-Z]:\/?$/.test(normalized)) return { ok: false, reason: '拒绝操作根目录' };
  if (typeof home === 'string' && home !== '') {
    const homeNormalized = trimTrailingSeparators(dropDotSegments(unifySeparators(home))).toLowerCase();
    if (normalized.toLowerCase() === homeNormalized) {
      return { ok: false, reason: '拒绝操作家目录本身' };
    }
  }
  const segments = windowsSegments(normalized);
  // 系统根目录本身要挡下来，但它们**下面**的缓存目录（Windows 更新缓存之类）要放行。
  if (segments.length === 1 && WINDOWS_SYSTEM_ROOTS.has(segments[0].toLowerCase())) {
    return { ok: false, reason: '拒绝操作系统根目录' };
  }
  // 盘符（共享）本身算一级，之下至少还要有一段 —— C:\$Recycle.Bin 放行，C:\ 不行。
  if (segments.length < 1) return { ok: false, reason: '路径层级过浅，拒绝操作' };
  if (value.includes('..')) return { ok: false, reason: '路径含 ..，拒绝操作' };
  return { ok: true };
}

/**
 * 这个路径能不能删。
 *
 * 路径的**形状**决定用哪套规则：以 '/' 开头是 POSIX 路径，驱动器 / UNC 开头是
 * Windows 路径。POSIX 上 Windows 形状的路径不算绝对路径（macOS 上没有这种路径）。
 *
 * 层数口径两边对称：POSIX 的根（'/'）与 Windows 的盘符（C:\）都**不算成「段」**，
 * 但 Windows 的盘符本身算一级 —— 所以 C:\$Recycle.Bin（盘符 + 一段）放行，
 * C:\（只有盘符）拒绝。判定前先把「.」段去掉（'/Users/x/.' 会解析成家目录本身）。
 *
 * @param {string} path 路径。
 * @param {string} home 家目录。
 * @returns {{ok: boolean, reason?: string}} 结论。
 */
export function checkPathAllowed(path, home) {
  if (typeof path !== 'string' || path.trim() === '') return { ok: false, reason: '路径为空' };
  const value = path.trim();
  if (value.startsWith('/')) return checkPosixPath(value, home);
  if (CASE_INSENSITIVE && (win32.isAbsolute(value) || /^[a-zA-Z]:/.test(value))) {
    return checkWindowsPath(value, home);
  }
  return { ok: false, reason: '不是绝对路径' };
}

/**
 * 写一条审计日志。
 *
 * @param {string} logPath 日志文件路径。
 * @param {object} entry 一条记录。
 * @returns {Promise<void>} 完成。
 */
async function appendAudit(logPath, entry) {
  if (typeof logPath !== 'string' || logPath === '') return;
  try {
    await mkdir(join(logPath, '..'), { recursive: true });
    await appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    /* 审计日志写不了不该让清理失败 */
  }
}

/**
 * 造一个执行器。
 *
 * @param {{home: string, env: object, dshHome?: string, logPath?: string, timeoutMs?: number, liveSessionIds?: () => string[]}} options 选项。
 * @returns {{execute: Function}} 执行器。
 */
export function createExecutor(options) {
  const home = options.home;
  const env = options.env;
  const dshHome = options.dshHome ?? `${home}/.dsh`;
  const logPath = options.logPath ?? '';
  const timeoutMs = options.timeoutMs ?? CLEAN_TIMEOUT_MS;
  const liveSessionIds = typeof options.liveSessionIds === 'function' ? options.liveSessionIds : () => [];
  // 把会话从 DSH 的归档清单里摘掉。归档集合是注册表里的**内存状态**（落盘到
  // workspace.json），直接改文件会被 DSH 下一次写回覆盖掉 —— 所以走官方的
  // unarchiveSession。不摘的话，界面里会留一条点不开的归档条目。
  const unarchiveSession = typeof options.unarchiveSession === 'function' ? options.unarchiveSession : null;

  /**
   * 执行一批条目。
   *
   * @param {Array<object>} items 条目。
   * @returns {Promise<{results: Array<object>, reclaimedBytes: number}>} 结果。
   */
  async function execute(items, onItem) {
    const notify = typeof onItem === 'function' ? onItem : null;
    const commandLines = await listRunningCommandLines();
    const results = [];
    let reclaimedBytes = 0;

    for (const item of items) {
      const startedAt = Date.now();
      const record = {
        id: item.id,
        label: item.label,
        group: item.group ?? 'cache',
        command: item.commandText ?? '',
        ok: false,
        skipped: false,
        reason: '',
        reclaimedBytes: 0,
        durationMs: 0,
      };

      try {
        const outcome = await dispatch(item, record, commandLines);
        record.ok = outcome.ok === true;
        record.skipped = outcome.skipped === true;
        record.reason = outcome.reason ?? '';
        record.reclaimedBytes = outcome.reclaimedBytes ?? 0;
        reclaimedBytes += record.reclaimedBytes;
      } catch (error) {
        record.reason = `执行出错：${error?.message ?? String(error)}`;
      }

      record.durationMs = Date.now() - startedAt;
      results.push(record);
      if (notify !== null) notify(record);
      await appendAudit(logPath, {
        action: record.ok ? 'cleaned' : record.skipped ? 'skipped' : 'failed',
        id: item.id,
        group: record.group,
        command: record.command,
        reclaimedBytes: record.reclaimedBytes,
        reason: record.reason,
      });
    }

    return { results, reclaimedBytes };
  }

  /**
   * 按动作类型分发。
   *
   * @param {object} item 条目。
   * @param {object} record 结果记录（就地补字段）。
   * @param {string[]} commandLines 运行中的命令行。
   * @returns {Promise<object>} 结果。
   */
  async function dispatch(item, record, commandLines) {
    const action = item.action ?? {};
    switch (action.type) {
      case 'command':
        return runCleanCommand(item, action, record, timeoutMs);
      case 'remove-dir':
        return removeDirectoryContents(item, action, record, commandLines);
      case 'remove-paths':
        return removePaths(action.paths ?? [], record, commandLines);
      case 'remove-trash-snapshots':
        return removeTrashSnapshots(action.keepNewest ?? 3, record);
      case 'remove-legacy-logs':
        return removeLegacyLogs(record);
      case 'remove-orphan-sessions':
        return removeSessions(record, 'orphan');
      case 'remove-old-sessions':
        return removeSessions(record, 'old', action.minAgeDays ?? 7);
      case 'remove-archived-sessions':
        return removeSessions(record, 'archived');
      case 'remove-stale-projcache':
        return removeStaleProjcache(record);
      case 'remove-old-attachments':
        return removeOldAttachments(action.minAgeDays ?? 30, record);
      case 'clear-browser-profile':
        return clearBrowserProfile(action.path, record, commandLines);
      case 'renice':
        return runRenice(action, record);
      case 'terminate':
        return runTerminate(action, record);
      case 'close-window':
        return runCloseWindow(action, record);
      default:
        return { ok: false, reason: `不认识的清理动作：${action.type ?? '(空)'}` };
    }
  }

  /**
   * 跑工具自己的官方清理命令。
   *
   * @param {object} item 条目。
   * @param {object} action 动作。
   * @param {object} record 结果记录。
   * @param {number} timeoutMs 超时。
   * @returns {Promise<object>} 结果。
   */
  async function runCleanCommand(item, action, record, timeout) {
    // 条目自己声明的超时优先 —— Windows 的 WinSxS 组件清理（dism /StartComponentCleanup）
    // 要跑好几分钟，用全局默认的 180 秒会被中途杀掉，用户看到的是「命令失败」。
    const limit = item.timeoutMs ?? timeout;
    const result = await runCommand(action.cmd, action.args ?? [], { timeoutMs: limit });
    if (!result.ok) {
      return { ok: false, reason: `命令失败：${result.stderr.slice(0, 300)}` };
    }
    return {
      ok: true,
      reclaimedBytes: item.sizeBytes ?? 0,
      reason: result.stdout === '' ? '命令执行完成' : result.stdout.slice(0, 300),
    };
  }

  /**
   * 清空一个目录的内容（正在被使用的子目录跳过）。
   *
   * @param {object} item 条目。
   * @param {object} action 动作。
   * @param {object} record 结果记录。
   * @param {string[]} commandLines 运行中的命令行。
   * @returns {Promise<object>} 结果。
   */
  async function removeDirectoryContents(item, action, record, commandLines) {
    const path = action.path;
    const allowed = checkPathAllowed(path, home);
    if (!allowed.ok) return { ok: false, reason: allowed.reason };
    if (isPathInUse(path, commandLines)) {
      return { ok: false, skipped: true, reason: '这个目录正在被使用中，跳过' };
    }
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return { ok: false, skipped: true, reason: '目录已经不存在（可能刚被别的工具清过了）' };
    }
    const inUse = findInUseSubdirs(path, commandLines);
    const kept = [];
    let removed = 0;
    for (const entry of entries) {
      if (inUse.has(entry.name)) {
        kept.push(entry.name);
        continue;
      }
      await rm(join(path, entry.name), { recursive: true, force: true });
      removed += 1;
    }
    return {
      ok: true,
      reclaimedBytes: item.sizeBytes ?? 0,
      reason: kept.length === 0
        ? `已清理 ${removed} 个条目`
        : `已清理 ${removed} 个条目；保留了 ${kept.length} 个正在被使用的（${kept.join('、')}）`,
    };
  }

  /**
   * 删一批具体路径。
   *
   * @param {string[]} paths 路径列表。
   * @param {object} record 结果记录。
   * @param {string[]} commandLines 运行中的命令行。
   * @returns {Promise<object>} 结果。
   */
  async function removePaths(paths, record, commandLines) {
    let removed = 0;
    let bytes = 0;
    const skipped = [];
    for (const path of paths) {
      const allowed = checkPathAllowed(path, home);
      if (!allowed.ok) {
        skipped.push(path);
        continue;
      }
      if (isPathInUse(path, commandLines)) {
        skipped.push(path);
        continue;
      }
      try {
        const info = await stat(path);
        if (info.isDirectory()) bytes += await dirSize(path);
        else bytes += info.size;
        await rm(path, { recursive: true, force: true });
        removed += 1;
      } catch {
        skipped.push(path);
      }
    }
    return {
      ok: removed > 0 || paths.length === 0,
      reclaimedBytes: bytes,
      reason: skipped.length === 0
        ? `已删除 ${removed} 个`
        : `已删除 ${removed} 个；跳过 ${skipped.length} 个（在用或不允许）`,
    };
  }

  /**
   * 递归量一个目录的字节数。
   *
   * @param {string} dir 目录。
   * @returns {Promise<number>} 字节数。
   */
  async function dirSize(dir) {
    let total = 0;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await dirSize(path);
        continue;
      }
      try {
        total += (await stat(path)).size;
      } catch {
        /* 读不到就跳过 */
      }
    }
    return total;
  }

  /**
   * 清掉回收站里的旧快照。
   *
   * @param {number} keepNewest 保留最近几份。
   * @param {object} record 结果记录。
   * @returns {Promise<object>} 结果。
   */
  async function removeTrashSnapshots(keepNewest, record) {
    const snapshots = await listTrashSnapshots(join(dshHome, 'trash'));
    const stale = snapshots.slice(keepNewest);
    let bytes = 0;
    for (const snapshot of stale) {
      bytes += snapshot.bytes;
      await rm(snapshot.path, { recursive: true, force: true });
    }
    return { ok: true, reclaimedBytes: bytes, reason: `已删除 ${stale.length} 份旧快照，保留最近 ${keepNewest} 份` };
  }

  /**
   * 删掉旧格式的会话日志。
   *
   * @param {object} record 结果记录。
   * @returns {Promise<object>} 结果。
   */
  async function removeLegacyLogs(record) {
    const files = await listLegacyLogs(join(dshHome, 'sessions'));
    let bytes = 0;
    let removed = 0;
    for (const file of files) {
      try {
        await rm(file.path, { force: true });
        bytes += file.bytes;
        removed += 1;
      } catch {
        /* 删不掉就跳过 */
      }
    }
    return { ok: true, reclaimedBytes: bytes, reason: `已删除 ${removed} 个旧格式日志` };
  }

  /**
   * 删会话（按类别重新解析一次）。
   *
   * @param {object} record 结果记录。
   * @param {'orphan'|'old'|'archived'} kind 类别。
   * @param {number} [minAgeDays] 最小天数（old 类别用）。
   * @returns {Promise<object>} 结果。
   */
  async function removeSessions(record, kind, minAgeDays) {
    const sessionsRoot = join(dshHome, 'sessions');
    const sessions = await listSessions(sessionsRoot);
    const live = new Set(liveSessionIds());
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const archivedIds = new Set(await readArchivedSessionIds(join(dshHome, 'storages')));
    const cutoff = Date.now() - (minAgeDays ?? 7) * 86400000;

    const targets = sessions.filter((session) => {
      if (live.has(session.id)) return false;
      if (kind === 'orphan') {
        if (session.origin !== 'subagent') return false;
        if (session.parentSession === null) return false;
        const parentId = session.parentSession.replace(/^session-/, '');
        return !byId.has(session.parentSession) && !byId.has(parentId);
      }
      if (kind === 'old') return session.mtimeMs < cutoff;
      if (kind === 'archived') return archivedIds.has(session.id);
      return false;
    });

    let bytes = 0;
    let removed = 0;
    let skippedLive = 0;
    let unarchived = 0;
    for (const session of targets) {
      try {
        if (kind === 'archived' && unarchiveSession !== null) {
          const ok = await unarchiveSession(session.id);
          if (ok) unarchived += 1;
        }
        await rm(session.dir, { recursive: true, force: true });
        bytes += session.bytes;
        removed += 1;
      } catch {
        skippedLive += 1;
      }
    }
    return {
      ok: true,
      reclaimedBytes: bytes,
      reason: `已删除 ${removed} 个会话${unarchived > 0 ? `（其中 ${unarchived} 个已从归档清单里摘掉）` : ''}${skippedLive > 0 ? `；${skippedLive} 个没删掉` : ''}`,
    };
  }

  /**
   * 删掉没有对应会话的投影缓存。
   *
   * @param {object} record 结果记录。
   * @returns {Promise<object>} 结果。
   */
  async function removeStaleProjcache(record) {
    const sessionsRoot = join(dshHome, 'sessions');
    const sessions = await listSessions(sessionsRoot);
    const known = new Set(sessions.map((session) => session.id));
    const projcacheRoot = join(dshHome, 'storages', 'session_projcache', 'sessions');
    let files = [];
    try {
      files = await readdir(projcacheRoot);
    } catch {
      return { ok: true, reason: '没有投影缓存目录' };
    }
    let bytes = 0;
    let removed = 0;
    for (const name of files) {
      if (known.has(name.replace(/\.json$/, ''))) continue;
      const path = join(projcacheRoot, name);
      try {
        bytes += (await stat(path)).size;
        await rm(path, { force: true });
        removed += 1;
      } catch {
        /* 删不掉就跳过 */
      }
    }
    return { ok: true, reclaimedBytes: bytes, reason: `已删除 ${removed} 个残留缓存文件` };
  }

  /**
   * 删掉旧附件。
   *
   * @param {number} minAgeDays 最小天数。
   * @param {object} record 结果记录。
   * @returns {Promise<object>} 结果。
   */
  async function removeOldAttachments(minAgeDays, record) {
    const attachmentsRoot = join(dshHome, 'attachments');
    const cutoff = Date.now() - minAgeDays * 86400000;
    let bytes = 0;
    let removed = 0;
    const versionDirs = await readdir(attachmentsRoot, { withFileTypes: true }).catch(() => []);
    for (const version of versionDirs) {
      if (!version.isDirectory()) continue;
      const versionRoot = join(attachmentsRoot, version.name);
      const objects = await readdir(versionRoot, { withFileTypes: true }).catch(() => []);
      for (const object of objects) {
        if (!object.isDirectory()) continue;
        const objectRoot = join(versionRoot, object.name);
        const files = await readdir(objectRoot, { withFileTypes: true }).catch(() => []);
        for (const file of files) {
          if (!file.isFile()) continue;
          const path = join(objectRoot, file.name);
          try {
            const info = await stat(path);
            if (info.mtimeMs >= cutoff) continue;
            bytes += info.size;
            await rm(path, { force: true });
            removed += 1;
          } catch {
            /* 删不掉就跳过 */
          }
        }
      }
    }
    return { ok: true, reclaimedBytes: bytes, reason: `已删除 ${removed} 个附件` };
  }

  /**
   * 清掉一个缓存目录。
   *
   * @param {string} target 目标目录。
   * @returns {Promise<number|null>} 清掉的字节数；没有这个目录就是 null。
   */
  async function clearCacheDir(target) {
    try {
      const info = await stat(target);
      if (!info.isDirectory()) return null;
      const bytes = await dirSize(target);
      await rm(target, { recursive: true, force: true });
      return bytes;
    } catch {
      return null;
    }
  }

  /**
   * 列出浏览器配置根目录下的「配置目录」（Default、Profile 1 …）。
   *
   * Chrome / Edge 系的每个配置是一个子目录，里面各有 Preferences、书签和自己
   * 的缓存目录 —— 只清 Default 的话，第二个配置的缓存一直躺在那儿。
   *
   * 判定：名字像配置目录（Default / Profile N / Guest Profile / System Profile），
   * 或者目录里有 Preferences 文件。
   *
   * @param {string} profileRoot 配置根目录。
   * @returns {Promise<string[]>} 配置目录列表。
   */
  async function listProfileDirs(profileRoot) {
    const dirs = [];
    let entries;
    try {
      entries = await readdir(profileRoot, { withFileTypes: true });
    } catch {
      return dirs;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(profileRoot, entry.name);
      if (!PROFILE_DIR_PATTERN.test(entry.name) && !(await pathExists(join(dir, 'Preferences')))) {
        continue;
      }
      dirs.push(dir);
    }
    return dirs;
  }

  /**
   * 清掉一个浏览器用户配置里的缓存目录。
   *
   * 只删浏览器自己的缓存目录，不动配置、书签、Cookie、登录态。
   *
   * 根级的缓存目录照清，**每个配置目录**（Default、Profile 1 …）里的那份也清 ——
   * 只清第一个配置的话，第二个配置的缓存一直躺在那儿，条目名不副实。
   *
   * @param {string} path 浏览器配置根目录。
   * @param {object} record 结果记录。
   * @param {string[]} commandLines 运行中的命令行。
   * @returns {Promise<object>} 结果。
   */
  async function clearBrowserProfile(path, record, commandLines) {
    const allowed = checkPathAllowed(path, home);
    if (!allowed.ok) return { ok: false, reason: allowed.reason };
    if (isPathInUse(path, commandLines)) {
      return { ok: false, skipped: true, reason: '这个浏览器正在运行中，跳过' };
    }
    let bytes = 0;
    let removed = 0;
    for (const relative of ROOT_CACHE_DIRS) {
      const size = await clearCacheDir(join(path, relative));
      if (size === null) continue;
      bytes += size;
      removed += 1;
    }
    const profiles = await listProfileDirs(path);
    for (const profile of profiles) {
      for (const relative of PROFILE_CACHE_DIRS) {
        const size = await clearCacheDir(join(profile, relative));
        if (size === null) continue;
        bytes += size;
        removed += 1;
      }
    }
    return {
      ok: true,
      reclaimedBytes: bytes,
      reason: removed === 0
        ? '这个浏览器配置里没有可清的缓存目录'
        : `已清掉 ${removed} 个缓存目录${profiles.length > 0 ? `（覆盖 ${profiles.length} 个配置目录）` : ''}`,
    };
  }

  /**
   * 降优先级（无损）。
   *
   * @param {object} action 动作。
   * @param {object} record 结果记录。
   * @returns {Promise<object>} 结果。
   */
  async function runRenice(action, record) {
    const results = await processes.reniceProcesses(action.pids ?? [], action.delta ?? 10);
    const failed = results.filter((item) => item.ok !== true);
    return {
      ok: failed.length === 0,
      reason: failed.length === 0
        ? `已把 ${results.length} 个进程的优先级降下来（进程还在，只是不再抢 CPU）`
        : `${results.length - failed.length} 个成功，${failed.length} 个失败（多半不是你自己启动的进程）`,
    };
  }

  /**
   * 结束进程（SIGTERM）。
   *
   * 执行前**复核** pid 现在的命令行：pid 会被回收复用，不复核就可能杀掉一个
   * 跟体检时完全无关的新进程。
   *
   * 复核靠「pid → 命令行」的精确配对（进程层给的），**不是**在命令行列表里找
   * pid 数字 —— 命令行里本来就没有自己的 pid，那种找法一次都命中不了，复核成了
   * 摆设；退一步说，`includes(' ${pid} ')` 还会碰巧命中别的命令行里的数字，
   * 复核就假通过了。
   *
   * 命令行拿不到时（Windows 的服务与 SYSTEM 进程是空串）只按 pid 存在与否判断：
   * 进程还在就认为还是它，不因为「命令行读不到」而误跳过正当的结束。
   *
   * 进程层给不出 pid 清单时按「体检之后就没了」处理 —— 宁可不结束，也不能在
   * 没法复核的情况下动手。
   *
   * @param {object} action 动作。
   * @param {object} record 结果记录。
   * @returns {Promise<object>} 结果。
   */
  async function runTerminate(action, record) {
    const expect = action.expect ?? {};
    const targets = [];
    let changed = 0;
    let running = [];
    try {
      const provider = processes.listRunningProcesses;
      running = typeof provider === 'function' ? await provider() : [];
    } catch {
      running = [];
    }
    const byPid = new Map(
      (Array.isArray(running) ? running : []).map((proc) => [Number(proc.pid), String(proc.command ?? '')]),
    );
    for (const [pid, prefix] of Object.entries(expect)) {
      const line = byPid.get(Number(pid));
      if (line === undefined) {
        changed += 1;
        continue;
      }
      // 命令行是空串（读不到）时只按 pid 判断；能拿到才比对片段。
      if (line !== '' && typeof prefix === 'string' && prefix !== '' && !line.includes(prefix)) {
        changed += 1;
        continue;
      }
      targets.push(Number(pid));
    }
    if (targets.length === 0) {
      return { ok: false, skipped: true, reason: '体检之后这些进程已经不在了（或已经换了别的进程）' };
    }
    const results = await processes.terminateProcesses(targets);
    const failed = results.filter((item) => item.ok !== true);
    // 结束不掉要说清楚为什么：Windows 上控制台进程没有窗口可关，taskkill 不带 /F
    // 结束不掉它 —— 只报「1 个失败」用户根本不知道下一步该干什么。
    const errors = failed
      .map((item) => item.error)
      .filter((text) => typeof text === 'string' && text !== '');
    const parts = [];
    const ended = results.length - failed.length;
    if (ended > 0) parts.push(`已结束 ${ended} 个进程`);
    if (changed > 0) parts.push(`${changed} 个已经不在了`);
    if (failed.length > 0) {
      parts.push(`${failed.length} 个没结束掉${errors.length > 0 ? `（${errors.join('；')}）` : ''}`);
    }
    return {
      ok: failed.length === 0,
      reason: parts.join('；'),
    };
  }

  /**
   * 关闭浏览器窗口。
   *
   * @param {object} action 动作。
   * @param {object} record 结果记录。
   * @returns {Promise<object>} 结果。
   */
  async function runCloseWindow(action, record) {
    const windows = action.windows ?? [];
    let closed = 0;
    const failed = [];
    for (const win of windows) {
      const result = await processes.closeBrowserWindow(win);
      if (result.ok) closed += 1;
      else failed.push(`${win.browserLabel}#${win.windowId}`);
    }
    return {
      ok: failed.length === 0,
      reason: failed.length === 0
        ? `已关闭 ${closed} 个窗口`
        : `已关闭 ${closed} 个；${failed.length} 个关不掉（${failed.join('、')}）`,
    };
  }

  return { execute };
}
