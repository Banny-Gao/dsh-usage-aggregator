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
//
// Windows 上这一层的分工：
//   · 进程表 —— Win32_Process（ CIM）一张表拿到 pid / 父 pid / 命令行 / 工作集，
//     CPU 时间取 KernelModeTime + UserModeTime；
//   · 结束进程 —— taskkill（不带 /F，对应 SIGTERM 的语义）；
//   · 降优先级 —— 改 PriorityClass（BelowNormal）；
//   · 浏览器窗口 —— 这一轮不做，直接返回空（见 listBrowserWindows）。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 是不是 Windows。进程表的取法、护栏的路径口径都按它分叉。 */
const IS_WINDOWS = process.platform === 'win32';

/** 采样间隔（毫秒）。太短噪声大，太长用户等不住。 */
const CPU_SAMPLE_MS = 1200;

/**
 * 永远不碰的进程名（小写匹配 basename，不带 .exe 后缀）。
 *
 * 这些要么是系统骨架（动了机器会出问题），要么是别的插件/工具的命脉
 * （比如 chrome-devtools-mcp 的浏览器 —— 停了它，工具链就断了）。
 */
export const PROTECTED_NAMES = new Set([
  // macOS 的系统骨架。
  'launchd', 'kernel_task', 'windowserver', 'loginwindow', 'dock', 'systemuiserver',
  'mds', 'mds_stores', 'mdworker', 'mdworker_shared', 'mdworkers_shared', 'mds_stores',
  'logd', 'syslogd', 'fseventsd', 'usernoted', 'cfprefsd', 'diskarbitrationd',
  'coreaudiod', 'bluetoothd', 'powerd', 'opendirectoryd', 'securityd', 'trustd',
  'notifyd', 'runningboardd', 'zabbix', 'backupd', 'nsurlsessiond',
  'hidd', 'corebrightnessd', 'coreservicesd', 'secd', 'taskgated',
  // Windows 的系统骨架：动了真的会出事的那几个。
  // services/svchost 停了机器上一半服务就没了；csrss/smss/wininit/lsass 停了
  // 系统直接崩；dwm/explorer 停了桌面与任务栏就没了；wmiprvse 停了 WMI 就废
  // （这一层自己查进程表也用 WMI）；msmpeng 停了就是关掉了杀毒。
  'services', 'system', 'secure system', 'registry', 'smss', 'csrss', 'wininit',
  'winlogon', 'lsass', 'lsaiso', 'svchost', 'dwm', 'explorer', 'memory compression',
  'system idle process', 'wmiprvse', 'msmpeng',
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
  // DSH 自己的包。pnpm 的虚拟目录把 / 编码成 +（@deepseek-ai+dsh），Windows 上
  // 路径分隔符又是 \ —— 三种写法都得认，否则 DSH 自己的进程会漏到清单里。
  /@deepseek-ai[\\/+]dsh/,
  /\.dsh[\\/]profiles[\\/]/,
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
 * 被结束，机器会出现很难查的怪问题。Windows 上对应的是系统目录（大小写不敏感，
 * 比较时统一转小写）。
 */
export const PROTECTED_PATH_PREFIXES = [
  '/System/', '/usr/libexec/', '/usr/lib/', '/usr/sbin/', '/sbin/',
  'C:\\Windows\\System32\\', 'C:\\Windows\\SysWOW64\\', 'C:\\Windows\\',
];

/**
 * 造一个「路径片段」的正则：分隔符可以是 / 或 \。
 *
 * 同一类临时目录在两个平台上的路径形态不同（~/.npm/_npx vs
 * %LocalAppData%\npm-cache\_npx），但**目录名**是一样的。按片段匹配、分隔符
 * 通配，比列两份正则省事，也不容易漏掉一种写法。
 *
 * @param {string} text 路径片段（用 / 分隔）。
 * @returns {RegExp} 正则。
 */
function pathFragment(text) {
  const escaped = text
    .split('/')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\\\/]');
  return new RegExp(escaped);
}

/**
 * 只用一次性的命令行包装器 —— 这类进程跑完就该退出，留在盘上多半是崩了。
 *
 * 判据是**命令行的形态**，不是名字：只匹配「临时安装目录」里的可执行文件。
 * 常驻的服务（MCP server、DSH 自己）用的都是固定的绝对路径，不在这里面。
 */
const ONE_SHOT_PATTERNS = [
  pathFragment('/node_modules/.bin/'),
  pathFragment('/.npm/_npx/'),
  pathFragment('/npm-cache/_npx/'),
  pathFragment('/pnpm/dlx/'),
  pathFragment('/pnpm-cache/dlx/'),
  pathFragment('/node_modules/.pnpm/'),
  pathFragment('/.bun/'),
  pathFragment('/uv/tools/'),
  pathFragment('/pipx/venvs/'),
];

/**
 * 跑一条命令。
 *
 * @param {string} cmd 可执行文件。
 * @param {string[]} args 参数。
 * @param {{timeoutMs?: number}} options 选项。
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: number|null}>} 结果。
 */
async function run(cmd, args, options = {}) {
  try {
    const result = await execFileAsync(cmd, args, {
      timeout: options.timeoutMs ?? 15000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
      // Windows 上不隐藏窗口的话，每采一次进程表都会闪一个黑框。
      windowsHide: true,
    });
    return {
      ok: true,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      code: 0,
    };
  } catch (error) {
    // 失败时 stdout 也要留着：Windows 的原生命令（taskkill）把出错原因写在
    // stdout 上，丢掉就只剩一个「失败了」。
    return {
      ok: false,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? error),
      code: typeof error?.code === 'number' ? error.code : null,
    };
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
 * Windows 上没有 .app 这层：按 basename 取，并去掉 .exe 后缀（chrome.exe → chrome）。
 *
 * @param {string} executable 可执行文件路径。
 * @returns {string} 应用名（macOS 带 .app 后缀，Windows 不带 .exe 后缀）。
 */
export function appNameOf(executable) {
  if (typeof executable !== 'string' || executable === '') return '(未知)';
  const appMatch = /^(.*?\.app)\//.exec(executable);
  if (appMatch !== null) {
    const parts = appMatch[1].split('/');
    return parts[parts.length - 1];
  }
  // Windows 的可执行文件路径用反斜杠分隔，所以这里按两种分隔符一起切。
  const parts = executable.split(/[\\/]/);
  const base = parts[parts.length - 1] || '(未知)';
  // .exe 后缀去掉更好读（macOS 上没有这种文件，既有口径不受影响）。
  return base.replace(/\.exe$/i, '');
}

/**
 * 进程名（basename，小写，不带 .exe 后缀）。
 *
 * 护栏按名字认系统进程：拿可执行文件的 basename 比命令行更准 —— 命令行后面
 * 还跟着参数，按空格切出来的「名字」是参数而不是程序名。
 *
 * @param {unknown} text 可执行文件路径或命令行。
 * @returns {string} 进程名；取不到就是空串。
 */
function baseNameOf(text) {
  if (typeof text !== 'string' || text === '') return '';
  const parts = text.trim().replace(/^["']/, '').split(/[\\/]/);
  const last = parts[parts.length - 1] ?? '';
  return last.toLowerCase().replace(/\.exe$/, '');
}

/**
 * 这个进程记录是不是 POSIX 上的。
 *
 * uid 只在 POSIX 上有意义 —— Windows 没有 uid，这里统一填 0。所以「uid 为 0
 * 就是 root」这条规则不能在 Windows 的记录上生效，否则 Windows 上每个进程都会
 * 被拦下来。判据是**路径形态**：POSIX 的可执行文件是 / 开头的绝对路径。
 *
 * @param {object} proc 进程信息。
 * @returns {boolean} 是不是 POSIX 的记录。
 */
function isPosixRecord(proc) {
  for (const value of [proc?.executable, proc?.command]) {
    if (typeof value !== 'string' || value === '') continue;
    if (value.trim().startsWith('/')) return true;
  }
  return false;
}

/**
 * 这个进程的可执行文件是不是在受保护的目录里。
 *
 * Windows 上命令行首部常带引号（"C:\Windows\System32\svchost.exe" -k ...），
 * 路径也大小写不敏感，所以那边要先去引号再转小写比。
 *
 * @param {object} proc 进程信息。
 * @param {string} prefix 受保护目录前缀。
 * @returns {boolean} 命中。
 */
function hitsProtectedPath(proc, prefix) {
  const candidates = IS_WINDOWS ? [proc?.executable, proc?.command] : [proc?.command];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    const value = IS_WINDOWS ? candidate.replace(/^["']/, '') : candidate;
    const hit = IS_WINDOWS
      ? value.toLowerCase().startsWith(prefix.toLowerCase())
      : value.startsWith(prefix);
    if (hit) return true;
  }
  return false;
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
  // uid 为 0 就是 root —— 但 uid 只在 POSIX 上有意义（Windows 上没有 uid，
  // 统一填 0），所以 Windows 的记录不走这条规则。
  if (proc.uid === 0 && isPosixRecord(proc)) return { ok: false, reason: 'root 拥有的进程' };
  const name = (proc.app ?? '').replace(/\.app$/, '').toLowerCase();
  const base = baseNameOf(proc.executable || proc.command);
  if (PROTECTED_NAMES.has(base) || PROTECTED_NAMES.has(name)) return { ok: false, reason: '系统进程' };
  for (const prefix of PROTECTED_PATH_PREFIXES) {
    if (hitsProtectedPath(proc, prefix)) return { ok: false, reason: '系统组件' };
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
 * Windows 上没有可靠的前台应用查询（lsappinfo 是 macOS 专有的），返回 null：
 * 面板把「前台应用」显示成未知，比猜一个应用名然后据此拦进程要诚实。
 *
 * @returns {Promise<string|null>} 应用名。
 */
export async function frontmostApp() {
  if (IS_WINDOWS) return null;
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
 * 采一次进程表（POSIX：ps）。
 *
 * @returns {Promise<Map<number, {pid: number, ppid: number, uid: number, rssBytes: number, cpuSeconds: number, command: string, app: string}>>}
 */
async function sampleOncePosix() {
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

/* ─────────────────────────── Windows 进程表 ─────────────────────────── */

/**
 * 取进程表的 PowerShell 行构造。
 *
 * 两处共用这一份（采样用、列进程用），字段口径就不会走偏。
 *
 * @type {string}
 */
const WINDOWS_ROWS_FUNCTION = [
  'function Get-Rows {',
  '  $cim = @(Get-CimInstance Win32_Process)',
  '  @(foreach ($c in $cim) {',
  '    [PSCustomObject]@{',
  '      pid = [int]$c.ProcessId',
  '      ppid = [int]$c.ParentProcessId',
  '      cmd = $c.CommandLine',
  '      name = $c.Name',
  '      path = $c.ExecutablePath',
  '      rss = [long]$c.WorkingSetSize',
  '      cpu = [double](([long]$c.KernelModeTime + [long]$c.UserModeTime) / 10000000)',
  '    }',
  '  })',
  '}',
].join('\n');

/**
 * 采两次 Windows 进程表的 PowerShell 脚本。
 *
 * Win32_Process 一张表就够：pid / 父 pid / 命令行 / 工作集大小都有。
 * CPU 时间取 KernelModeTime + UserModeTime（单位 100 纳秒）——这样连
 * Get-Process 读不到的保护进程（服务、SYSTEM 进程）也有 CPU 时间。
 *
 * 为什么两次采样放在**同一个** PowerShell 进程里：
 *   1. PowerShell 启动一次约 0.7 秒。分两次启动，光启动就多花 0.7 秒；
 *   2. 更要紧的是**采样时刻**：CIM 查询本身要 0.6 秒多，进程表里的 CPU 累计值
 *      是在查询过程中逐个读出来的。所以「第一次读数」与「第二次读数」之间真实
 *      隔了「查询耗时 + 采样间隔」，而不是采样间隔。分两次启动还要再叠一个启动
 *      时间 —— 实测单核忙进程被算成 546%（真实值 99%）。
 *      这里把两次查询放进一个进程，并把**真实间隔**一并测出来返回。
 *
 * `[Console]::OutputEncoding` 必须显式设成 UTF-8：PowerShell 5.1 默认按 OEM
 * 代码页写管道，中文命令行会被解成一串替换字符。
 *
 * 用 -InputObject 而不是管道：管道在只剩一个元素时会退化成「一个对象」而不是
 * 数组，解析端就得两头照顾。
 *
 * @param {number} intervalMs 两次采样之间至少隔多久。
 * @returns {string} 脚本。
 */
function windowsPairScript(intervalMs) {
  const sleep = Math.max(0, Math.round(intervalMs));
  return [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$ErrorActionPreference = 'SilentlyContinue'",
    WINDOWS_ROWS_FUNCTION,
    '$clock = [System.Diagnostics.Stopwatch]::StartNew()',
    '$before = Get-Rows',
    // 第一次读数的时刻：第一次查询读完的瞬间。
    '$mark1 = $clock.Elapsed.TotalMilliseconds',
    `Start-Sleep -Milliseconds ${sleep}`,
    '$after = Get-Rows',
    '$mark2 = $clock.Elapsed.TotalMilliseconds',
    '$clock.Stop()',
    '[PSCustomObject]@{ gapMs = [int]($mark2 - $mark1); before = $before; after = $after } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
}

/**
 * 采一次 Windows 进程表的 PowerShell 脚本（单次采样）。
 *
 * @returns {string} 脚本。
 */
function windowsSingleScript() {
  return [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$ErrorActionPreference = 'SilentlyContinue'",
    WINDOWS_ROWS_FUNCTION,
    'ConvertTo-Json -Compress -Depth 3 -InputObject (Get-Rows)',
  ].join('\n');
}

/**
 * 解析一段 JSON 文本。
 *
 * @param {string} text JSON 文本。
 * @returns {unknown} 解析结果；解析不了就是 null。
 */
function parseJson(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * 把一个值当成数组看。
 *
 * ConvertTo-Json 传单个元素时可能给的是对象而不是数组，两边都要照顾。
 *
 * @param {unknown} value 值。
 * @returns {Array<unknown>} 数组。
 */
function toArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * 把 CIM 查出来的行装配成进程表。
 *
 * @param {unknown} rows CIM 的行。
 * @returns {Map<number, object>} 进程表。
 */
function windowsProcessMap(rows) {
  const map = new Map();
  for (const row of toArray(rows)) {
    if (row === null || typeof row !== 'object') continue;
    const pid = Number(row.pid);
    // pid 0 是「System Idle Process」——它不是真的进程（空闲时间计数器），
    // 它的 CPU 值是个天文数字，混进来会把 CPU 排行彻底带偏。
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const command = typeof row.cmd === 'string' ? row.cmd : '';
    const name = typeof row.name === 'string' ? row.name : '';
    // ExecutablePath 在别的用户的进程上是 null，这时退回镜像名（chrome.exe）。
    const path = typeof row.path === 'string' ? row.path : '';
    const executable = path !== '' ? path : name;
    if (executable === '') continue;
    map.set(pid, {
      pid,
      ppid: Number(row.ppid) || 0,
      // Windows 没有 uid，统一填 0（护栏里这条规则只在 POSIX 上生效）。
      uid: 0,
      rssBytes: Number(row.rss) || 0,
      cpuSeconds: Number(row.cpu) || 0,
      executable,
      // 命令行为 null 的进程（服务、系统进程）退回用可执行文件名占位，
      // 免得下游拿到 null 去 split。
      command: command !== '' ? command : executable,
      app: appNameOf(executable),
    });
  }
  return map;
}

/**
 * 采两次进程表（Windows：一个 PowerShell 进程里连采两次）。
 *
 * @param {number} intervalMs 两次采样之间的间隔。
 * @returns {Promise<{before: Map<number, object>, after: Map<number, object>, gapMs: number}>} 两次采样。
 */
async function samplePairWindows(intervalMs) {
  const fallback = { before: new Map(), after: new Map(), gapMs: intervalMs };
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsPairScript(intervalMs)], {
    timeoutMs: 40000,
  });
  if (!result.ok) return fallback;
  const payload = toArray(parseJson(result.stdout)).find((row) => row !== null && typeof row === 'object');
  if (payload === undefined) return fallback;
  const gapMs = Number(payload.gapMs);
  return {
    before: windowsProcessMap(payload.before),
    after: windowsProcessMap(payload.after),
    gapMs: Number.isFinite(gapMs) && gapMs > 0 ? gapMs : intervalMs,
  };
}

/**
 * 采两次进程表（POSIX：两次 ps）。
 *
 * @param {number} intervalMs 两次采样之间的间隔。
 * @returns {Promise<{before: Map<number, object>, after: Map<number, object>, gapMs: number}>} 两次采样。
 */
async function samplePairPosix(intervalMs) {
  const before = await sampleOncePosix();
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
  return { before, after: await sampleOncePosix(), gapMs: intervalMs };
}

/**
 * 正在运行的进程：pid 与整条命令行。
 *
 * 「体检之后这个 pid 是不是还是同一条进程」要靠它来判 —— 只拿命令行列表的话，
 * 只能靠「命令行里碰巧出现这个数字」来匹配，实际上永远匹配不上。
 *
 * 命令行拿不到时给空串（服务与 SYSTEM 进程在 Windows 上就是 null）。
 *
 * @returns {Promise<Array<{pid: number, command: string}>>} 进程列表。
 */
export async function listRunningProcesses() {
  if (!IS_WINDOWS) {
    const result = await run('ps', ['-Ao', 'pid=,command='], { timeoutMs: 10000 });
    if (!result.ok) return [];
    const out = [];
    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const space = trimmed.indexOf(' ');
      if (space <= 0) continue;
      const pid = Number(trimmed.slice(0, space));
      if (!Number.isFinite(pid)) continue;
      out.push({ pid, command: trimmed.slice(space + 1) });
    }
    return out;
  }
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsSingleScript()], {
    timeoutMs: 20000,
  });
  if (!result.ok) return [];
  const out = [];
  for (const row of toArray(parseJson(result.stdout))) {
    if (row === null || typeof row !== 'object') continue;
    const pid = Number(row.pid);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    out.push({ pid, command: typeof row.cmd === 'string' ? row.cmd : '' });
  }
  return out;
}

/**
 * 正在运行的进程的命令行。
 *
 * 「在用即跳过」的依据：缓存目录里有正在跑的东西时，那个路径会出现在某个进程
 * 的命令行里。Windows 上命令行用反斜杠分隔路径，这里保持原样不做归一化 ——
 * 匹配方按自己的口径归一化即可。
 *
 * @returns {Promise<string[]>} 命令行列表；拿不到就是空数组。
 */
export async function listRunningCommandLines() {
  if (!IS_WINDOWS) {
    const result = await run('ps', ['-Ao', 'command='], { timeoutMs: 10000 });
    if (!result.ok) return [];
    return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  }
  const processes = await listRunningProcesses();
  return processes.map((proc) => proc.command).filter((line) => line !== '');
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
 * Windows 上两次采样在同一个 PowerShell 进程里连做：PowerShell 启动一次约
 * 0.7 秒，而 CIM 查询本身要 0.6 秒多 —— 两次读数之间真实隔开的不是采样间隔，
 * 而是「查询耗时 + 采样间隔」。所以 CPU 占用按**真实间隔**折算。
 *
 * @param {{intervalMs?: number}} options 选项。
 * @returns {Promise<{processes: Array<object>, protectedPids: Set<number>, frontApp: string|null}>}
 */
export async function sampleProcesses(options = {}) {
  const intervalMs = options.intervalMs ?? CPU_SAMPLE_MS;
  const pair = IS_WINDOWS ? await samplePairWindows(intervalMs) : await samplePairPosix(intervalMs);
  const { before, after } = pair;
  // CPU 占用的分母用**真实间隔**：Windows 上两次读数之间还隔着一次 CIM 查询，
  // 用采样间隔当分母会把占用率算成好几倍。
  const gapMs = pair.gapMs > 0 ? pair.gapMs : intervalMs;
  const protectedPids = await ownProcessTree(after);
  for (const pid of protectedByAncestry([...after.values()])) protectedPids.add(pid);
  const frontApp = await frontmostApp();

  const processes = [];
  for (const [pid, current] of after) {
    const previous = before.get(pid);
    const delta = previous === undefined ? 0 : current.cpuSeconds - previous.cpuSeconds;
    const cpuPct = delta > 0 ? Math.round((delta / (gapMs / 1000)) * 1000) / 10 : 0;
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
  const parts = String(proc.executable ?? proc.command ?? '').trim().replace(/^["']/, '').split(/[\\/]/);
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
 * Windows 上这一轮不做：枚举窗口要靠各浏览器的调试协议或 UI 自动化，没有
 * 哪个是稳的。宁可返回空列表，也不要拿猜出来的窗口去关用户的东西。
 *
 * @returns {Promise<Array<object>>} 窗口列表。
 */
export async function listBrowserWindows() {
  if (IS_WINDOWS) return [];
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
  if (IS_WINDOWS) return { ok: false, error: 'Windows 上暂不支持关闭浏览器窗口' };
  const script = win.browser === 'safari'
    ? `tell application "Safari" to close window id ${win.windowId}`
    : `tell application "${win.browserApp}" to close window id ${win.windowId}`;
  const result = await run('osascript', ['-e', script], { timeoutMs: 12000 });
  if (!result.ok) return { ok: false, error: result.stderr.slice(0, 200) };
  return { ok: true };
}

/* ─────────────────────────── 动作 ─────────────────────────── */

/**
 * 把失败结果整理成一句人能读的话。
 *
 * Windows 的原生命令按 OEM 代码页写 stderr，直接按 UTF-8 解码会得到一串替换
 * 字符（乱码）。这里把解不出来的字节丢掉，只留读得出来的部分；全读不出来就
 * 报退出码 —— 那也是有效信息。
 *
 * @param {string} command 命令名。
 * @param {{stdout: string, stderr: string, code: number|null}} result 失败结果。
 * @returns {string} 错误说明。
 */
function describeFailure(command, result) {
  const raw = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  const detail = raw
    .replace(/\uFFFD/g, '')
    .split('\n')
    .map((line) => line.trim().replace(/^[:：\s]+/, ''))
    .find((line) => line !== '');
  const code = typeof result.code === 'number' ? result.code : null;
  const head = code === null ? `${command} 失败` : `${command} 退出码 ${code}`;
  return detail === undefined ? head : `${head}：${detail.slice(0, 160)}`;
}

/**
 * 降优先级用的 PowerShell 脚本（一次改一批，省掉每 pid 一次进程启动）。
 *
 * PriorityClass 没有「加一级」这种语义，只能落到一档：降就是 BelowNormal，
 * 升就是 AboveNormal。
 *
 * @param {number[]} pids pid 列表。
 * @param {string} priority 目标优先级。
 * @returns {string} 脚本。
 */
function windowsPriorityScript(pids, priority) {
  const targets = pids.map((pid) => Number(pid) || 0).filter((pid) => pid > 0);
  return [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$ErrorActionPreference = 'Stop'",
    `$targets = @(${targets.join(',')})`,
    '$out = @(foreach ($targetId in $targets) {',
    '  try {',
    '    $proc = Get-Process -Id $targetId -ErrorAction Stop',
    `    $proc.PriorityClass = '${priority}'`,
    "    [PSCustomObject]@{ pid = $targetId; ok = $true; error = '' }",
    '  } catch {',
    "    [PSCustomObject]@{ pid = $targetId; ok = $false; error = $_.Exception.Message }",
    '  }',
    '})',
    'ConvertTo-Json -Compress -Depth 3 -InputObject $out',
  ].join('\n');
}

/**
 * taskkill 失败时的常见原因（按退出码）。
 *
 * Windows 的 taskkill 把出错原因按 OEM 代码页写到 stderr，直接按 UTF-8 解码
 * 是一串乱码；**退出码**才是能读懂的信息。
 *
 *   1   —— 结束不掉。不带 /F 时 taskkill 只能「关窗口」，控制台进程
 *           （node / powershell / cmd）没有窗口可关。
 *   128 —— 进程已经不在了（pid 已被回收）。
 */
const TASKKILL_REASONS = {
  1: '结束不掉：Windows 不带 /F 时只能「关窗口」，控制台进程（node / powershell / cmd）没有窗口可关',
  128: '进程已经不在了',
};

/**
 * 把 taskkill 的失败整理成一句能读的话。
 *
 * @param {{stdout: string, stderr: string, code: number|null}} result 失败结果。
 * @returns {string} 错误说明。
 */
function windowsTerminateError(result) {
  const reason = typeof result.code === 'number' ? TASKKILL_REASONS[result.code] : undefined;
  return reason ?? describeFailure('taskkill', result);
}

/**
 * 结束一批进程（SIGTERM，不 SIGKILL）。
 *
 * Windows 上对应 taskkill（不带 /F）：带 /F 是强杀，进程没有机会收尾。taskkill
 * 结束不掉就如实报失败 —— 结束不掉就结束不掉，不强杀。
 *
 * @param {number[]} pids pid 列表。
 * @returns {Promise<Array<{pid: number, ok: boolean, error?: string}>>} 结果。
 */
export async function terminateProcesses(pids) {
  const results = [];
  for (const pid of pids) {
    const result = IS_WINDOWS
      ? await run('taskkill', ['/PID', String(pid)], { timeoutMs: 8000 })
      : await run('kill', ['-TERM', String(pid)], { timeoutMs: 5000 });
    results.push({
      pid,
      ok: result.ok,
      error: result.ok
        ? undefined
        : (IS_WINDOWS ? windowsTerminateError(result) : result.stderr.slice(0, 200)),
    });
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
  if (IS_WINDOWS) {
    const priority = delta > 0 ? 'BelowNormal' : (delta < 0 ? 'AboveNormal' : 'Normal');
    const result = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', windowsPriorityScript(pids, priority)],
      { timeoutMs: 20000 },
    );
    if (!result.ok) {
      const error = describeFailure('powershell', result);
      for (const pid of pids) results.push({ pid, ok: false, error });
      return results;
    }
    const byPid = new Map(
      toArray(parseJson(result.stdout))
        .filter((row) => row !== null && typeof row === 'object')
        .map((row) => [Number(row.pid), row]),
    );
    for (const pid of pids) {
      const row = byPid.get(Number(pid));
      if (row === undefined) {
        results.push({ pid, ok: false, error: '没有返回这个进程的结果' });
        continue;
      }
      results.push({
        pid,
        ok: row.ok === true,
        error: row.ok === true ? undefined : String(row.error ?? '降优先级失败').slice(0, 200),
      });
    }
    return results;
  }
  for (const pid of pids) {
    const result = await run('renice', ['-n', String(delta), String(pid)], { timeoutMs: 5000 });
    results.push({ pid, ok: result.ok, error: result.ok ? undefined : result.stderr.slice(0, 200) });
  }
  return results;
}
