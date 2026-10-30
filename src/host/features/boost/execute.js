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
import { join } from 'node:path';
import { formatCommand, runCommand } from './catalog.js';
import { closeBrowserWindow, reniceProcesses, terminateProcesses } from './processes.js';
import {
  listLegacyLogs,
  listSessions,
  listTrashSnapshots,
  readArchivedSessionIds,
} from './dshself.js';

/** 单条清理命令的超时（毫秒）。brew cleanup / pnpm store prune 都可能比较慢。 */
const CLEAN_TIMEOUT_MS = 180000;

/**
 * 正在运行的进程的命令行。
 *
 * @returns {Promise<string[]>} 命令行列表。
 */
export async function listRunningCommandLines() {
  const result = await runCommand('ps', ['-Ao', 'command='], { timeoutMs: 8000 });
  if (!result.ok) return [];
  return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/**
 * 找出缓存目录里**正在被使用**的子目录名。
 *
 * 只看命令行：进程命令行里出现了 `<缓存目录>/xxx`，说明 xxx 这个子目录里有
 * 正在被运行的东西，删了就会打断它。
 *
 * @param {string} cachePath 缓存目录。
 * @param {string[]} commandLines 正在运行的命令行。
 * @returns {Set<string>} 被占用的子目录名。
 */
export function findInUseSubdirs(cachePath, commandLines) {
  const used = new Set();
  if (typeof cachePath !== 'string' || cachePath === '') return used;
  const prefix = cachePath.endsWith('/') ? cachePath : `${cachePath}/`;
  for (const line of commandLines) {
    const index = line.indexOf(prefix);
    if (index === -1) continue;
    const rest = line.slice(index + prefix.length);
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
 * 前后都要求是参数的边界：前面是行首 / 空白 / `=`，后面不能是路径字符
 * （否则 `/x/cache` 会匹配上 `/x/cache/inuse/a.txt`）。
 *
 * @param {string} path 路径。
 * @param {string[]} commandLines 正在运行的命令行。
 * @returns {boolean} 是否在用。
 */
export function isPathInUse(path, commandLines) {
  if (typeof path !== 'string' || path === '') return false;
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[\\s=])${escaped}(?![\\/\\w.-])`);
  return commandLines.some((line) => pattern.test(line));
}

/**
 * 这个路径能不能删。
 *
 * @param {string} path 路径。
 * @param {string} home 家目录。
 * @returns {{ok: boolean, reason?: string}} 结论。
 */
export function checkPathAllowed(path, home) {
  if (typeof path !== 'string' || path.trim() === '') return { ok: false, reason: '路径为空' };
  const value = path.trim();
  if (!value.startsWith('/')) return { ok: false, reason: '不是绝对路径' };
  if (value === '/') return { ok: false, reason: '拒绝操作根目录' };
  if (value === home || value === `${home}/`) return { ok: false, reason: '拒绝操作家目录本身' };
  const depth = value.split('/').filter((part) => part !== '').length;
  if (depth < 2) return { ok: false, reason: '路径层级过浅，拒绝操作' };
  if (value.includes('..')) return { ok: false, reason: '路径含 ..，拒绝操作' };
  return { ok: true };
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
        return runTerminate(action, record, commandLines);
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
    const result = await runCommand(action.cmd, action.args ?? [], { timeoutMs: timeout });
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
   * 清掉一个浏览器用户配置里的缓存目录。
   *
   * 只删浏览器自己的缓存目录，不动配置、书签、Cookie、登录态。
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
    const CACHE_DIRS = [
      'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'DawnCache',
      'GraphiteDawnCache', 'Service Worker/CacheStorage', 'Service Worker/ScriptCache',
      'Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'Default/DawnCache',
      'Default/GraphiteDawnCache', 'Default/Service Worker/CacheStorage',
      'Crashpad/pending', 'component_crx_cache', 'optimization_guide_model_store',
    ];
    let bytes = 0;
    let removed = 0;
    for (const relative of CACHE_DIRS) {
      const target = join(path, relative);
      try {
        const info = await stat(target);
        if (!info.isDirectory()) continue;
        bytes += await dirSize(target);
        await rm(target, { recursive: true, force: true });
        removed += 1;
      } catch {
        /* 没有这个目录就跳过 */
      }
    }
    return {
      ok: true,
      reclaimedBytes: bytes,
      reason: removed === 0 ? '这个浏览器配置里没有可清的缓存目录' : `已清掉 ${removed} 个缓存目录`,
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
    const results = await reniceProcesses(action.pids ?? [], action.delta ?? 10);
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
   * @param {object} action 动作。
   * @param {object} record 结果记录。
   * @param {string[]} commandLines 运行中的命令行。
   * @returns {Promise<object>} 结果。
   */
  async function runTerminate(action, record, commandLines) {
    const expect = action.expect ?? {};
    const targets = [];
    let changed = 0;
    for (const [pid, prefix] of Object.entries(expect)) {
      const line = commandLines.find((item) => item.startsWith(`${pid} `) || item.includes(` ${pid} `));
      if (line === undefined) {
        changed += 1;
        continue;
      }
      if (typeof prefix === 'string' && prefix !== '' && !line.includes(prefix)) {
        changed += 1;
        continue;
      }
      targets.push(Number(pid));
    }
    if (targets.length === 0) {
      return { ok: false, skipped: true, reason: '体检之后这些进程已经不在了（或已经换了别的进程）' };
    }
    const results = await terminateProcesses(targets);
    const failed = results.filter((item) => item.ok !== true);
    return {
      ok: failed.length === 0,
      reason: `已结束 ${results.length - failed.length} 个进程${changed > 0 ? `；${changed} 个已经不在了` : ''}${failed.length > 0 ? `；${failed.length} 个失败` : ''}`,
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
      const result = await closeBrowserWindow(win);
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
