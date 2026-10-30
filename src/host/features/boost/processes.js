// src/host/features/boost/processes.js
//
// 进程层：内存大户、浏览器里的非活跃窗口、后台高占 CPU 的任务、孤儿子进程。
//
// 这一层与「磁盘清理」是两回事 —— 它不删文件，它动**正在跑的程序**。所以护栏
// 比磁盘那层更严：
//
//   1. **只读先做足**：内存按应用聚合（不是一个 pid 一行，浏览器是几十个进程），
//      CPU 用**两次采样求差**算瞬时占用（ps 的 %cpu 是「进程活着的平均」，对
//      一个开了三天的 Chrome 毫无参考价值）。
//   2. **不碰的清单**：DSH 自己及其子进程、root 拥有的进程、系统目录下的可执行
//      文件、前台应用、以及一份系统进程名单。
//   3. **默认动作无损**：降优先级（renice）不杀进程、不丢数据；结束进程与关闭
//      窗口会丢未保存的内容，所以**默认不勾**，交给用户自己决定。
//
// 浏览器窗口用各家自己的 AppleScript 字典枚举（Chrome / Edge / Brave 同一套
// 字典，Safari 另一套）。这条路子不需要「辅助功能」权限 —— 而 AX 那条路在很多
// 机器上是被系统直接拒掉的。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 采样间隔（毫秒）。太短噪声大，太长用户等不住。 */
const CPU_SAMPLE_MS = 1200;

/**
 * 永远不碰的进程名（小写匹配 basename）。
 *
 * 这些要么是系统骨架（动了机器会出问题），要么是别的插件/工具的命脉
 * （比如 chrome-devtools-mcp 的浏览器 —— 停了它，工具链就断了）。
 */
export const PROTECTED_NAMES = new Set([
  'launchd', 'kernel_task', 'windowserver', 'loginwindow', 'dock', 'systemuiserver',
  'mds', 'mds_stores', 'mdworker', 'mdworker_shared', 'mdworkers_shared', 'mds_stores',
  'logd', 'syslogd', 'fseventsd', 'usernoted', 'cfprefsd', 'diskarbitrationd',
  'coreaudiod', 'bluetoothd', 'powerd', 'opendirectoryd', 'securityd', 'trustd',
  'notifyd', 'runningboardd', 'zabbix', 'backupd', 'nsurlsessiond',
  'hidd', 'corebrightnessd', 'coreservicesd', 'secd', 'taskgated',
]);

/**
 * 命令行里出现这些标记的进程一律不碰。
 *
 * 光靠「DSH 自己那棵进程树」不够：插件跑在 DSH 进程里时 `process.pid` 就是它，
 * 树能护住；但插件跑在别的进程里（CLI 组合、测试脚本、宿主换了个启动方式）时，
 * 树就够不着 DSH 的主进程了 —— 那时它会变成一条「占内存的应用」出现在清单里，
 * 用户一勾就是把 DSH 自己杀了。所以按**命令行标记**再护一道。
 */
export const PROTECTED_COMMAND_PATTERNS = [
  /@deepseek-ai\/dsh/,
  /\.dsh\/profiles\//,
  /dsh-mcp-cli-bridge/,
  /dsh-ai-coding/,
  /dsh-usage-aggregator/,
  // MCP 服务器自己拉起来的浏览器：关掉它，工具就断了。
  /chrome-devtools-mcp/,
];

/**
 * 可执行文件在这些目录里的一律不碰。
 *
 * /System 与 /usr/libexec 是系统组件；/usr/lib 是系统库；这几个下面的东西一旦
 * 被结束，机器会出现很难查的怪问题。
 */
export const PROTECTED_PATH_PREFIXES = ['/System/', '/usr/libexec/', '/usr/lib/', '/usr/sbin/', '/sbin/'];

/**
 * 只用一次性的命令行包装器 —— 这类进程跑完就该退出，留在盘上多半是崩了。
 *
 * 判据是**命令行的形态**，不是名字：只匹配「临时安装目录」里的可执行文件。
 * 常驻的服务（MCP server、DSH 自己）用的都是固定的绝对路径，不在这里面。
 */
const ONE_SHOT_PATTERNS = [
  /\/node_modules\/\.bin\//,
  /\.npm\/_npx\//,
  /\/pnpm\/dlx\//,
  /\/uv\/tools\//,
  /\/pipx\/venvs\//,
];

/**
 * 跑一条命令。
 *
 * @param {string} cmd 可执行文件。
 * @param {string[]} args 参数。
 * @param {{timeoutMs?: number}} options 选项。
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>} 结果。
 */
async function run(cmd, args, options = {}) {
  try {
    const result = await execFileAsync(cmd, args, {
      timeout: options.timeoutMs ?? 15000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { ok: true, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  } catch (error) {
    return { ok: false, stdout: '', stderr: String(error?.stderr ?? error?.message ?? error) };
  }
}

/**
 * 解析 ps 的累计 CPU 时间（[[dd-]hh:]mm:ss.ss）。
 *
 * @param {string} text 时间串。
 * @returns {number} 秒。
 */
export function parseCpuTime(text) {
  if (typeof text !== 'string' || text.trim() === '') return 0;
  let value = text.trim();
  let days = 0;
  const dash = value.indexOf('-');
  if (dash >= 0) {
    days = Number(value.slice(0, dash)) || 0;
    value = value.slice(dash + 1);
  }
  const parts = value.split(':').map((part) => Number(part) || 0);
  while (parts.length < 3) parts.unshift(0);
  const [hours, minutes, seconds] = parts;
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/**
 * 取一个进程所属的应用名。
 *
 * 入参是**可执行文件路径**（ps 的 comm 字段），不是整条命令行 —— 命令行后面
 * 还跟着参数，算进去名字就变成「bin.js web」这种没法看的东西；而且 macOS 上
 * 应用路径里带空格（「Google Chrome Helper (Aperitif Renderer).app」），按空格
 * 切命令��会把路径切坏。
 *
 * 口径是**路径里第一个 .app**：Chrome 的渲染进程跑在
 * `/Applications/Google Chrome.app/Contents/.../Helpers/Google Chrome Helper (Aperitif Renderer).app/…`
 * 里，按最后一个 .app 算就会把一个浏览器拆成十几个「应用」。
 * 按第一个算，它们才都是「Google Chrome.app」。
 *
 * @param {string} executable 可执行文件路径。
 * @returns {string} 应用名（带 .app 后缀）。
 */
export function appNameOf(executable) {
  if (typeof executable !== 'string' || executable === '') return '(未知)';
  const appMatch = /^(.*?\.app)\//.exec(executable);
  if (appMatch !== null) {
    const parts = appMatch[1].split('/');
    return parts[parts.length - 1];
  }
  const parts = executable.split('/');
  return parts[parts.length - 1] || '(未知)';
}

/**
 * 应用名的展示形态（去掉 .app 后缀）。
 *
 * @param {string} app 应用名。
 * @returns {string} 展示名。
 */
export function displayApp(app) {
  return typeof app === 'string' ? app.replace(/\.app$/, '') : '';
}

/**
 * 这个进程能不能被碰。
 *
 * @param {object} proc 进程信息。
 * @param {Set<number>} protectedPids 受保护的 pid 集合（DSH 自己那棵树 + 系统）。
 * @param {string|null} frontApp 前台应用名。
 * @returns {{ok: boolean, reason?: string}} 结论。
 */
export function checkProcessAllowed(proc, protectedPids, frontApp) {
  if (protectedPids.has(proc.pid)) return { ok: false, reason: '系统进程或 DSH 自己的进程' };
  if (PROTECTED_COMMAND_PATTERNS.some((pattern) => pattern.test(proc.command ?? ''))) {
    return { ok: false, reason: 'DSH 自己的进程' };
  }
  if (proc.uid === 0) return { ok: false, reason: 'root 拥有的进程' };
  const name = (proc.app ?? '').replace(/\.app$/, '').toLowerCase();
  const base = proc.command.split('/').pop().toLowerCase();
  if (PROTECTED_NAMES.has(base) || PROTECTED_NAMES.has(name)) return { ok: false, reason: '系统进程' };
  for (const prefix of PROTECTED_PATH_PREFIXES) {
    if (proc.command.startsWith(prefix)) return { ok: false, reason: '系统组件' };
  }
  if (frontApp !== null && frontApp !== '' && (proc.app ?? '') === frontApp) {
    return { ok: false, reason: '用户当前正在用的应用' };
  }
  return { ok: true };
}

/**
 * 拿到前台应用的名字。
 *
 * 用 lsappinfo —— 它不需要「辅助功能」权限，而 AX 那套在很多机器上是被系统
 * 直接拒掉的（-25211）。
 *
 * @returns {Promise<string|null>} 应用名。
 */
export async function frontmostApp() {
  const asn = await run('lsappinfo', ['front'], { timeoutMs: 5000 });
  if (!asn.ok) return null;
  const id = asn.stdout.trim().split('\n')[0].trim();
  if (id === '') return null;
  const info = await run('lsappinfo', ['info', '-only', 'name', id], { timeoutMs: 5000 });
  if (!info.ok) return null;
  const match = /"LSDisplayName"\s*=\s*"([^"]+)"/.exec(info.stdout);
  if (match === null) return null;
  const name = match[1];
  return name.endsWith('.app') ? name : `${name}.app`;
}

/**
 * 采一次进程表。
 *
 * @returns {Promise<Map<number, {pid: number, ppid: number, uid: number, rssBytes: number, cpuSeconds: number, command: string, app: string}>>}
 */
async function sampleOnce() {
  // 两张表：comm 是可执行文件路径（用来认应用），command 是整条命令行
  // （用来判在用、判孤儿子进程）。macOS 上应用路径里带空格，只能靠 comm。
  const [table, lines] = await Promise.all([
    run('ps', ['-Ao', 'pid=,ppid=,rss=,time=,comm='], { timeoutMs: 10000 }),
    run('ps', ['-Ao', 'pid=,command='], { timeoutMs: 10000 }),
  ]);
  const commandByPid = new Map();
  if (lines.ok) {
    for (const line of lines.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const space = trimmed.indexOf(' ');
      if (space <= 0) continue;
      commandByPid.set(Number(trimmed.slice(0, space)), trimmed.slice(space + 1));
    }
  }
  const map = new Map();
  if (!table.ok) return map;
  for (const line of table.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(trimmed);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid)) continue;
    const executable = match[5].trim();
    map.set(pid, {
      pid,
      ppid: Number(match[2]) || 0,
      uid: 0,
      rssBytes: (Number(match[3]) || 0) * 1024,
      cpuSeconds: parseCpuTime(match[4]),
      executable,
      command: commandByPid.get(pid) ?? executable,
      app: appNameOf(executable),
    });
  }
  // 归属用户：单独查一次 uid（ps 的 ruser 是名字，转 uid 要 id -u）。
  const ids = [...map.keys()];
  if (ids.length > 0) {
    const uids = await run('ps', ['-Ao', 'pid=,uid='], { timeoutMs: 10000 });
    if (uids.ok) {
      for (const line of uids.stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const pid = Number(parts[0]);
        const entry = map.get(pid);
        if (entry !== undefined) entry.uid = Number(parts[1]) || 0;
      }
    }
  }
  return map;
}

/**
 * 这些进程的 pid 也不能碰：祖先里有 DSH 自己的进程。
 *
 * 工具驱动的浏览器就是这样：它的命令行里没有 DSH 的标记，但它的**父进程**是
 * DSH 起的 MCP 服务器。关掉它，工具就断了。
 *
 * @param {Array<object>} processes 进程表。
 * @returns {Set<number>} 受保护的 pid。
 */
export function protectedByAncestry(processes) {
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const protectedPids = new Set();
  for (const proc of processes) {
    let current = proc;
    for (let depth = 0; depth < 12; depth += 1) {
      const parent = byPid.get(current.ppid);
      if (parent === undefined) break;
      if (PROTECTED_COMMAND_PATTERNS.some((pattern) => pattern.test(parent.command ?? ''))) {
        protectedPids.add(proc.pid);
        break;
      }
      current = parent;
    }
  }
  return protectedPids;
}

/**
 * DSH 自己那一棵进程的 pid（含自己）。
 *
 * @param {Array<object>} processes 进程表。
 * @returns {Set<number>} pid 集合。
 */
async function ownProcessTree(processes) {
  const protectedPids = new Set([process.pid]);
  const children = new Map();
  for (const proc of processes) {
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(proc.pid);
  }
  const queue = [process.pid];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const child of children.get(current) ?? []) {
      if (protectedPids.has(child)) continue;
      protectedPids.add(child);
      queue.push(child);
    }
  }
  return protectedPids;
}

/**
 * 采样一次进程表，算出**瞬时** CPU 占用与内存。
 *
 * @param {{intervalMs?: number}} options 选项。
 * @returns {Promise<{processes: Array<object>, protectedPids: Set<number>, frontApp: string|null}>}
 */
export async function sampleProcesses(options = {}) {
  const intervalMs = options.intervalMs ?? CPU_SAMPLE_MS;
  const before = await sampleOnce();
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
  const after = await sampleOnce();
  const protectedPids = await ownProcessTree(after);
  for (const pid of protectedByAncestry([...after.values()])) protectedPids.add(pid);
  const frontApp = await frontmostApp();

  const processes = [];
  for (const [pid, current] of after) {
    const previous = before.get(pid);
    const delta = previous === undefined ? 0 : current.cpuSeconds - previous.cpuSeconds;
    const cpuPct = delta > 0 ? Math.round((delta / (intervalMs / 1000)) * 1000) / 10 : 0;
    processes.push({ ...current, cpuPct });
  }
  processes.sort((a, b) => b.rssBytes - a.rssBytes);
  return { processes, protectedPids, frontApp };
}

/**
 * 按应用聚合内存与 CPU。
 *
 * 浏览器是几十个进程，逐个列出来用户根本没法判断 —— 要看的是「Chrome 占了多少」。
 *
 * @param {Array<object>} processes 进程表。
 * @returns {Array<object>} 聚合结果。
 */
export function aggregateByApp(processes) {
  const map = new Map();
  for (const proc of processes) {
    const key = proc.app;
    const entry = map.get(key) ?? {
      app: key,
      rssBytes: 0,
      cpuPct: 0,
      pids: [],
      count: 0,
      mainPid: proc.pid,
      members: [],
    };
    entry.rssBytes += proc.rssBytes;
    entry.cpuPct = Math.round((entry.cpuPct + proc.cpuPct) * 10) / 10;
    entry.pids.push(proc.pid);
    entry.count += 1;
    entry.members.push(proc);
    map.set(key, entry);
  }
  const list = [...map.values()];
  list.sort((a, b) => b.rssBytes - a.rssBytes);
  return list;
}

/**
 * 一个进程的显示名（可执行文件的名字，不带路径）。
 *
 * Chrome 的渲染进程会显示成「Google Chrome Helper (Aperitif Renderer)」，
 * 这样用户才知道自己结束的是哪个。
 *
 * @param {object} proc 进程信息。
 * @returns {string} 显示名。
 */
export function processLabel(proc) {
  const parts = String(proc.executable ?? proc.command ?? '').split('/');
  const name = parts[parts.length - 1];
  return name === '' ? '(未知)' : name;
}

/**
 * 找孤儿子进程：父进程已经不在了，而且是一次性命令行工具。
 *
 * @param {Array<object>} processes 进程表。
 * @returns {Array<object>} 候选。
 */
export function findOrphanProcesses(processes) {
  const alive = new Set(processes.map((proc) => proc.pid));
  return processes.filter((proc) => {
    if (proc.ppid === 0 || proc.ppid === 1) {
      // 父进程没了（被 init 收养）—— 但要确认它确实是一次性工具。
      return ONE_SHOT_PATTERNS.some((pattern) => pattern.test(proc.command));
    }
    if (!alive.has(proc.ppid)) {
      return ONE_SHOT_PATTERNS.some((pattern) => pattern.test(proc.command));
    }
    return false;
  });
}

/* ─────────────────────────── 浏览器窗口 ─────────────────────────── */

/** Chrome 系（Chrome / Edge / Brave 共用同一套 AppleScript 字典）。 */
const CHROME_DIALECT_BROWSERS = [
  { id: 'chrome', app: 'Google Chrome', label: 'Chrome' },
  { id: 'edge', app: 'Microsoft Edge', label: 'Edge' },
  { id: 'brave', app: 'Brave Browser', label: 'Brave' },
];

/** Safari 是另一套字典。 */
const SAFARI_BROWSER = { id: 'safari', app: 'Safari', label: 'Safari' };

/**
 * 枚举某个浏览器的窗口。
 *
 * @param {object} browser 浏览器描述。
 * @returns {Promise<Array<object>>} 窗口列表（拿不到就是空数组）。
 */
async function windowsOf(browser) {
  if (browser.id === 'safari') {
    const script = `tell application "Safari"
      set out to ""
      repeat with w in windows
        set out to out & (index of w) & "\\t" & (name of w) & "\\t" & (count of tabs of w) & "\\n"
      end repeat
      return out
    end tell`;
    const result = await run('osascript', ['-e', script], { timeoutMs: 12000 });
    if (!result.ok) return [];
    const rows = [];
    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const [index, title, tabs] = trimmed.split('\t');
      rows.push({ windowId: Number(index) || 0, title: title ?? '', tabCount: Number(tabs) || 0 });
    }
    return rows;
  }
  const script = `tell application "${browser.app}"
    set out to ""
    repeat with w in windows
      set out to out & (id of w) & "\\t" & (title of w) & "\\t" & (count of tabs of w) & "\\n"
    end repeat
    return out
  end tell`;
  const result = await run('osascript', ['-e', script], { timeoutMs: 12000 });
  if (!result.ok) return [];
  const rows = [];
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const [id, title, tabs] = trimmed.split('\t');
    rows.push({ windowId: Number(id) || 0, title: title ?? '', tabCount: Number(tabs) || 0 });
  }
  return rows;
}

/**
 * 某个浏览器当前聚焦的是哪个窗口。
 *
 * Chrome 系用 `index of front window`，Safari 用 `index of front window`；
 * 没有窗口时 AppleScript 会报错（-1719），那就不是「有聚焦窗口」，按没有处理。
 *
 * @param {object} browser 浏览器描述。
 * @returns {Promise<number|null>} 窗口 id。
 */
async function focusedWindowOf(browser) {
  const script = `tell application "${browser.app}" to return index of front window`;
  const result = await run('osascript', ['-e', script], { timeoutMs: 8000 });
  if (!result.ok) return null;
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 这个浏览器是不是 DSH 的工具在驱动。
 *
 * 浏览器窗口可以关，但**工具驱动的浏览器不能关** —— 关了工具就断了。所以
 * 命令行里带 DSH 标记（chrome-devtools-mcp、DSH 起的浏览器）的实例整个跳过。
 *
 * @param {string} app 应用名。
 * @returns {Promise<boolean>} 是不是 DSH 自己的浏览器。
 */
async function isDshOwnedBrowser(app) {
  const probe = await run('pgrep', ['-x', app], { timeoutMs: 5000 });
  if (!probe.ok || probe.stdout.trim() === '') return false;
  const pids = probe.stdout.trim().split(/\s+/).filter((pid) => pid !== '');
  const details = await run('ps', ['-Ao', 'pid=,command='], { timeoutMs: 8000 });
  if (!details.ok) return false;
  const markers = [
    /chrome-devtools-mcp/,
    /@deepseek-ai\/dsh/,
    /\.dsh\/profiles\//,
    /dsh-mcp-/,
  ];
  for (const line of details.stdout.split('\n')) {
    const trimmed = line.trim();
    const space = trimmed.indexOf(' ');
    if (space <= 0) continue;
    if (!pids.includes(trimmed.slice(0, space))) continue;
    if (markers.some((pattern) => pattern.test(trimmed))) return true;
  }
  return false;
}

/**
 * 列出所有浏览器的窗口。
 *
 * @returns {Promise<Array<object>>} 窗口列表。
 */
export async function listBrowserWindows() {
  const out = [];
  for (const browser of [...CHROME_DIALECT_BROWSERS, SAFARI_BROWSER]) {
    // 先看这个浏览器在不在跑 —— 不在跑就别去 AppleScript 问它，
    // 问了会把浏览器**启动起来**（macOS 的默认行为）。
    const probe = await run('pgrep', ['-x', browser.app], { timeoutMs: 5000 });
    if (!probe.ok || probe.stdout.trim() === '') continue;
    // 工具驱动的浏览器不碰。
    if (await isDshOwnedBrowser(browser.app)) continue;
    const windows = await windowsOf(browser);
    if (windows.length === 0) continue;
    const focused = await focusedWindowOf(browser);
    for (const win of windows) {
      out.push({
        browser: browser.id,
        browserLabel: browser.label,
        browserApp: browser.app,
        windowId: win.windowId,
        title: win.title,
        tabCount: win.tabCount,
        focused: focused !== null && win.windowId === focused,
      });
    }
  }
  return out;
}

/**
 * 关闭一个浏览器窗口。
 *
 * @param {{browser: string, browserApp: string, windowId: number}} win 窗口。
 * @returns {Promise<{ok: boolean, error?: string}>} 结果。
 */
export async function closeBrowserWindow(win) {
  const script = win.browser === 'safari'
    ? `tell application "Safari" to close window id ${win.windowId}`
    : `tell application "${win.browserApp}" to close window id ${win.windowId}`;
  const result = await run('osascript', ['-e', script], { timeoutMs: 12000 });
  if (!result.ok) return { ok: false, error: result.stderr.slice(0, 200) };
  return { ok: true };
}

/* ─────────────────────────── 动作 ─────────────────────────── */

/**
 * 结束一批进程（SIGTERM，不 SIGKILL）。
 *
 * @param {number[]} pids pid 列表。
 * @returns {Promise<Array<{pid: number, ok: boolean, error?: string}>>} 结果。
 */
export async function terminateProcesses(pids) {
  const results = [];
  for (const pid of pids) {
    const result = await run('kill', ['-TERM', String(pid)], { timeoutMs: 5000 });
    results.push({ pid, ok: result.ok, error: result.ok ? undefined : result.stderr.slice(0, 200) });
  }
  return results;
}

/**
 * 把一批进程降优先级（无损：进程还在，只是不再抢 CPU）。
 *
 * @param {number[]} pids pid 列表。
 * @param {number} delta 增量（正数=降优先级）。
 * @returns {Promise<Array<{pid: number, ok: boolean, error?: string}>>} 结果。
 */
export async function reniceProcesses(pids, delta) {
  const results = [];
  for (const pid of pids) {
    const result = await run('renice', ['-n', String(delta), String(pid)], { timeoutMs: 5000 });
    results.push({ pid, ok: result.ok, error: result.ok ? undefined : result.stderr.slice(0, 200) });
  }
  return results;
}
