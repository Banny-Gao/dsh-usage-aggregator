// src/host/features/boost/catalog.js
//
// 工具链目录：运行时发现「这台机器上装了什么、它的缓存在哪、官方怎么清」。
//
// 为什么必须是运行时发现，而不是写死一张清单：
//   插件发布后跑在**各个用户自己的机器**上。装了什么工具、缓存在哪、有多大、
//   官方清理命令是什么，每台机器都不一样。写死的清单在别人的机器上必然对不上
//   —— 要么报「缓存不存在」，要么把别人的目录当成自己的去删。
//
// 所以每个适配器声明的是「怎么找到它、怎么清它」：
//   detect —— 证明这个工具装了（命令必须成功退出）。探测不到就不出现这个条目，
//             用户看不到自己机器上不存在的工具。**可选**：目录类的条目（自己算
//             路径的 Windows 系统缓存）没有命令可探测 —— 路径本身就是证据，
//             目录不存在就不会出现在清单里。
//   locate —— **问工具自己**缓存目录在哪（工具的输出，不是我猜的路径）。
//             工具搬家、改配置、换版本管理器，路径都会变 —— 问它最准。
//   locatePath —— 自己算路径（环境变量、用户目录）。与 locate 二选一。
//   clean  —— 这个工具官方的清理命令。
//   action —— 直接给出执行器的动作，覆盖上面推导出来的动作。可以是对象，也可以
//             是 (path) => 动作对象的函数（路径随环境变量变的时候用函数）。
//
// 「过期」的两种语义（semantics），面板上要标清楚：
//   prune —— 只删**已经没人引用**的部分（pnpm store prune / uv cache prune），
//            正在用的包留着，代价是下次要用时重新下载。
//   full  —— 整个缓存清空（npm cache clean / yarn cache clean）。缓存本来就是
//            可再生的，清掉不影响任何已装好的东西。
//
// 派生条目（orphan）：有些要清的东西不是某个工具的缓存，而是工具升级后留下的
// 旧版本目录（pnpm 从 v3 换到 v11 之后，store/v3 就没人再用了）。这类没有官方
// 命令可调，只能定向删除 —— 所以它们由发现过程**派生**出来，不在适配器表里。

import { readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { runProcess } from '../../shared/cmd.js';

/** 探测一个工具的命令最多花多久（毫秒）。装没装是秒级的事，不该卡住体检。 */
const DETECT_TIMEOUT_MS = 8000;

/** 问工具要缓存目录的命令最多花多久（毫秒）。 */
const LOCATE_TIMEOUT_MS = 10000;

/**
 * 跑一条命令并拿到输出。
 *
 * 底层走 shared/cmd.js —— Windows 上 npm / pnpm 这些是 .cmd 垫片，直接 execFile
 * 会 ENOENT / EINVAL；那一层按 PATH + PATHEXT 解析，垫片交给 cmd.exe 跑。
 *
 * 超时由那一层的 timeout 保证 —— 某些工具在无网络时会挂住，不能让体检一直等下去。
 *
 * @param {string} cmd 可执行文件。
 * @param {string[]} args 参数。
 * @param {{timeoutMs?: number}} options 选项。
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>} 结果。
 */
export async function runCommand(cmd, args, options = {}) {
  const timeout = options.timeoutMs ?? DETECT_TIMEOUT_MS;
  const result = await runProcess(cmd, args, { timeoutMs: timeout });
  if (!result.ok) {
    const stderr = result.stderr.trim();
    return {
      ok: false,
      stdout: '',
      stderr: stderr === '' ? `命令执行失败（退出码 ${result.code ?? '未知'}）` : stderr,
    };
  }
  return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

/**
 * 用环境变量拼一个路径。
 *
 * 变量缺失就返回 null —— 没有它就没有这个目录，硬拼出来的相对路径会指到别处去。
 *
 * @param {object} env 环境变量。
 * @param {string} name 变量名。
 * @param {...string} rest 变量值之后的路径片段。
 * @returns {string|null} 路径；变量缺失就是 null。
 */
function envPath(env, name, ...rest) {
  const base = env?.[name];
  if (typeof base !== 'string' || base === '') return null;
  return join(base, ...rest);
}

/**
 * 全部适配器。
 *
 * 字段说明：
 *   id        —— 稳定标识（客户端传回来的就是这个）
 *   label     —— 中文名（面板显示）
 *   tool      —— 工具名
 *   semantics —— 'prune' 只删没人引用的；'full' 整个清空
 *   risk      —— 'low' 纯缓存，删了自动重建；'medium' 会影响下次构建/安装速度；
 *                'high' 有代价（删掉就找不回来），默认不勾
 *   detect    —— 探测命令（成功即认为装了）。**可选**：目录类的条目没有命令可探测，
 *                路径本身就是证据
 *   locate    —— 问工具要缓存目录的命令（stdout 就是路径）
 *   locatePath —— 自己算路径的函数 (home, env, context) => string|null
 *   clean     —— 官方清理命令
 *   action    —— 执行器动作，覆盖由 clean 推导出来的动作。可以是对象，也可以是
 *                (path) => 动作对象的函数
 *   selectedByDefault —— 默认勾不勾（默认 true）
 *   group     —— 分组（默认 'cache'；系统与磁盘类的条目用 'system'）
 *   note      —— 一句话说明这个操作实际做了什么
 *
 * 平台限制用 platforms 声明：darwin 独有的工具（brew / pod）不会在 Linux 上出现。
 * locatePath 拿到的 context 是发现过程的共享上下文（前面适配器探到的路径），
 * 供派生条目用 —— 比如 npx 临时目录挂在 npm 自己的缓存目录下面。
 */
export const ADAPTERS = [
  {
    id: 'npm',
    label: 'npm 下载缓存',
    tool: 'npm',
    semantics: 'full',
    risk: 'low',
    detect: { cmd: 'npm', args: ['--version'] },
    locate: { cmd: 'npm', args: ['config', 'get', 'cache'] },
    // npm 报的 cache 是**根目录**（~/.npm），真正被清掉的是里面的 _cacache。
    itemPath: (root) => join(root, '_cacache'),
    clean: { cmd: 'npm', args: ['cache', 'clean', '--force'] },
    contextKey: 'npmCacheRoot',
    note: '清空 npm 下载下来的包缓存；已装好的依赖不受影响，下次安装时重新下载。',
  },
  {
    id: 'npm-npx',
    label: 'npx 临时执行目录',
    tool: 'npm',
    semantics: 'full',
    risk: 'medium',
    dependsOn: 'npm',
    detect: { cmd: 'npm', args: ['--version'] },
    locatePath: (home, env, context) => {
      const base = context.npmCacheRoot;
      return typeof base === 'string' && base !== '' ? join(base, '_npx') : null;
    },
    cleanPath: true,
    note: '删掉 npx 临时安装过的包。正在被运行的那几个会自动跳过，不会打断正在跑的命令。',
  },
  {
    id: 'pnpm',
    label: 'pnpm 全局存储',
    tool: 'pnpm',
    semantics: 'prune',
    risk: 'low',
    detect: { cmd: 'pnpm', args: ['--version'] },
    locate: { cmd: 'pnpm', args: ['store', 'path'] },
    clean: { cmd: 'pnpm', args: ['store', 'prune'] },
    contextKey: 'pnpmStoreDir',
    note: '只回收已经没有任何项目引用的包；正在用的留在原地。',
  },
  {
    id: 'yarn',
    label: 'Yarn 缓存',
    tool: 'yarn',
    semantics: 'full',
    risk: 'low',
    detect: { cmd: 'yarn', args: ['--version'] },
    locate: { cmd: 'yarn', args: ['cache', 'dir'] },
    clean: { cmd: 'yarn', args: ['cache', 'clean'] },
    note: '清空 Yarn 下载的包缓存；下次 yarn install 会重新下载。',
  },
  {
    id: 'bun',
    label: 'Bun 安装缓存',
    tool: 'bun',
    semantics: 'full',
    risk: 'low',
    detect: { cmd: 'bun', args: ['--version'] },
    locate: { cmd: 'bun', args: ['pm', 'cache'] },
    clean: { cmd: 'bun', args: ['pm', 'cache', 'rm'] },
    note: '清空 Bun 的安装缓存；已装好的 node_modules 不受影响。',
  },
  {
    id: 'uv',
    label: 'uv 缓存',
    tool: 'uv',
    semantics: 'prune',
    risk: 'low',
    detect: { cmd: 'uv', args: ['--version'] },
    locate: { cmd: 'uv', args: ['cache', 'dir'] },
    clean: { cmd: 'uv', args: ['cache', 'prune'] },
    note: '回收已经装不到（不再被任何环境引用）的缓存对象；正在用的虚拟环境不受影响。',
  },
  {
    id: 'pip',
    label: 'pip 缓存',
    tool: 'pip',
    semantics: 'full',
    risk: 'low',
    detect: { cmd: 'pip', args: ['--version'] },
    locate: { cmd: 'pip', args: ['cache', 'dir'] },
    clean: { cmd: 'pip', args: ['cache', 'purge'] },
    note: '清空 pip 下载的 wheel 缓存；已装好的包不受影响。',
  },
  {
    id: 'brew',
    label: 'Homebrew 下载与旧版本',
    tool: 'brew',
    semantics: 'prune',
    risk: 'low',
    platforms: ['darwin'],
    detect: { cmd: 'brew', args: ['--version'] },
    locate: { cmd: 'brew', args: ['--cache'] },
    clean: { cmd: 'brew', args: ['cleanup', '-s'] },
    note: '删掉旧版本的 formula 与下载包；当前版本保留。',
  },
  {
    id: 'cargo',
    label: 'Cargo 已下载的 crate',
    tool: 'cargo',
    semantics: 'prune',
    risk: 'low',
    detect: { cmd: 'cargo', args: ['--version'] },
    // Cargo 没有官方的「清缓存」命令（cargo-cache 是第三方工具），
    // 所以这里定位到它下载的 .crate 归档目录并清空 —— 效果等价，且只是重下。
    locatePath: (home) => `${home}/.cargo/registry/cache`,
    cleanPath: true,
    note: '删掉已下载的 .crate 归档（只是下载件，不含编译产物）；下次 cargo build 会重新下载。',
  },
  {
    id: 'cocoapods',
    label: 'CocoaPods 缓存',
    tool: 'pod',
    semantics: 'full',
    risk: 'medium',
    platforms: ['darwin'],
    detect: { cmd: 'pod', args: ['--version'] },
    locatePath: (home) => `${home}/Library/Caches/CocoaPods`,
    clean: { cmd: 'pod', args: ['cache', 'clean', '--all'] },
    note: '清空 CocoaPods 下载的 pod 缓存；下次 pod install 会重新拉取。',
  },
  {
    id: 'gem',
    label: 'Ruby Gem 旧版本',
    tool: 'gem',
    semantics: 'prune',
    risk: 'medium',
    detect: { cmd: 'gem', args: ['--version'] },
    locate: { cmd: 'gem', args: ['env', 'home'] },
    clean: { cmd: 'gem', args: ['cleanup'] },
    // gem 没有「缓存目录」这个概念，它清的是旧版本的 gem 本体 —— 所以量的是 GEM_HOME。
    note: '卸载不再被任何项目依赖的旧版本 gem；当前使用的版本保留。',
  },
  {
    id: 'go',
    label: 'Go 模块缓存',
    tool: 'go',
    semantics: 'full',
    risk: 'low',
    detect: { cmd: 'go', args: ['version'] },
    locate: { cmd: 'go', args: ['env', 'GOMODCACHE'] },
    clean: { cmd: 'go', args: ['clean', '-modcache'] },
    note: '清空 Go 的模块下载缓存；下次 go build 会重新下载依赖。',
  },
  {
    id: 'composer',
    label: 'Composer 缓存',
    tool: 'composer',
    semantics: 'full',
    risk: 'low',
    detect: { cmd: 'composer', args: ['--version'] },
    locatePath: (home) => `${home}/.composer/cache`,
    clean: { cmd: 'composer', args: ['clear-cache'] },
    note: '清空 Composer 的下载缓存；已装好的 vendor 目录不受影响。',
  },
  {
    id: 'dotnet',
    label: 'NuGet 全局包缓存',
    tool: 'dotnet',
    semantics: 'full',
    risk: 'low',
    detect: { cmd: 'dotnet', args: ['--version'] },
    locatePath: (home) => `${home}/.nuget/packages`,
    clean: { cmd: 'dotnet', args: ['nuget', 'locals', 'all', '--clear'] },
    note: '清空 NuGet 的全局包缓存；已还原好的项目不受影响。',
  },

  /* ---- Windows 自己的系统与用户目录 ----
   *
   * 这些条目没有命令可探测 —— **路径本身就是证据**：目录不存在就不会出现在清单里。
   * 路径一律来自环境变量（LOCALAPPDATA / SystemRoot / ProgramData）：Windows 装在
   * 别的盘上时这些变量会跟着变，写死盘符就会指到不存在的盘上。
   */
  {
    id: 'win-temp-user',
    label: '用户临时文件',
    tool: 'Windows',
    semantics: 'full',
    risk: 'low',
    platforms: ['win32'],
    group: 'cache',
    locatePath: (home, env) => envPath(env, 'LOCALAPPDATA', 'Temp'),
    cleanPath: true,
    note: '清空当前用户的临时文件目录（%LOCALAPPDATA%\\Temp）。正在被程序占用的文件删不掉，会如实报告。',
  },
  {
    id: 'win-temp-system',
    label: '系统临时文件',
    tool: 'Windows',
    semantics: 'full',
    risk: 'low',
    platforms: ['win32'],
    group: 'system',
    locatePath: (home, env) => envPath(env, 'SystemRoot', 'Temp'),
    cleanPath: true,
    note: '清空 Windows 自己的临时目录（%SystemRoot%\\Temp）。多半要管理员权限：没权限时体检量不到它的大小（显示 0 B），删不掉的文件会如实报告。',
  },
  {
    id: 'win-update-cache',
    label: 'Windows 更新下载缓存',
    tool: 'Windows',
    semantics: 'full',
    risk: 'medium',
    platforms: ['win32'],
    group: 'system',
    selectedByDefault: false,
    locatePath: (home, env) => envPath(env, 'SystemRoot', 'SoftwareDistribution', 'Download'),
    cleanPath: true,
    note: '清空 Windows 更新的下载缓存。更新服务占着的时候删不掉（要停 wuauserv 服务），所以默认不勾。',
  },
  {
    id: 'win-delivery-optimization',
    label: '传递优化缓存',
    tool: 'Windows',
    semantics: 'full',
    risk: 'low',
    platforms: ['win32'],
    group: 'system',
    locatePath: (home, env) => envPath(env, 'SystemRoot', 'ServiceProfiles', 'NetworkService', 'AppData', 'Local', 'Microsoft', 'Windows', 'DeliveryOptimization', 'Cache'),
    cleanPath: true,
    note: '清空「传递优化」的缓存 —— Windows 用它从别的机器拉更新包。只影响更新速度，不影响已装好的更新。',
  },
  {
    id: 'win-d3dscache',
    label: 'DirectX 着色器缓存',
    tool: 'Windows',
    semantics: 'full',
    risk: 'low',
    platforms: ['win32'],
    group: 'cache',
    locatePath: (home, env) => envPath(env, 'LOCALAPPDATA', 'D3DSCache'),
    cleanPath: true,
    note: '清空 DirectX 的着色器缓存 —— 游戏与图形程序第一次启动会慢一点，之后自己重建。',
  },
  {
    id: 'win-error-reports',
    label: 'Windows 错误报告归档',
    tool: 'Windows',
    semantics: 'full',
    risk: 'low',
    platforms: ['win32'],
    group: 'system',
    locatePath: (home, env) => envPath(env, 'ProgramData', 'Microsoft', 'Windows', 'WER', 'ReportArchive'),
    cleanPath: true,
    note: '清空 Windows 错误报告的归档（崩溃时的诊断资料）。诊断完就没用了，多半要管理员权限：没权限时体检量不到它的大小（显示 0 B）。',
  },
  {
    id: 'win-crash-dumps',
    label: '程序崩溃转储',
    tool: 'Windows',
    semantics: 'full',
    risk: 'low',
    platforms: ['win32'],
    group: 'cache',
    locatePath: (home, env) => envPath(env, 'LOCALAPPDATA', 'CrashDumps'),
    cleanPath: true,
    note: '清空当前用户目录下的程序崩溃转储（.dmp 文件）。排查完崩溃就不需要了。',
  },
  {
    id: 'win-minidump',
    label: '系统小型转储',
    tool: 'Windows',
    semantics: 'full',
    risk: 'low',
    platforms: ['win32'],
    group: 'system',
    locatePath: (home, env) => envPath(env, 'SystemRoot', 'Minidump'),
    cleanPath: true,
    note: '清空系统蓝屏时留下的小型转储。要管理员权限：没权限时体检量不到它的大小（显示 0 B）。不想排查蓝屏的话先留着，它用得上。',
  },
  {
    id: 'win-browser-cache-chrome',
    label: 'Chrome 浏览器缓存',
    tool: 'Chrome',
    semantics: 'full',
    risk: 'low',
    platforms: ['win32'],
    group: 'cache',
    locatePath: (home, env) => envPath(env, 'LOCALAPPDATA', 'Google', 'Chrome', 'User Data'),
    // 路径随环境变量变，所以动作由路径拼出来。
    action: (path) => ({ type: 'clear-browser-profile', path }),
    note: '只清 Chrome 自己的缓存目录，不动书签、密码与登录态。Chrome 正在运行时这一项会跳过。',
  },
  {
    id: 'win-browser-cache-edge',
    label: 'Edge 浏览器缓存',
    tool: 'Edge',
    semantics: 'full',
    risk: 'low',
    platforms: ['win32'],
    group: 'cache',
    locatePath: (home, env) => envPath(env, 'LOCALAPPDATA', 'Microsoft', 'Edge', 'User Data'),
    action: (path) => ({ type: 'clear-browser-profile', path }),
    note: '只清 Edge 自己的缓存目录，不动收藏夹、密码与登录态。Edge 正在运行时这一项会跳过。',
  },
  {
    id: 'win-recycle-bin',
    label: '清空回收站',
    tool: 'Windows',
    semantics: 'full',
    risk: 'high',
    platforms: ['win32'],
    group: 'system',
    selectedByDefault: false,
    locatePath: (home, env) => {
      const root = env?.SystemRoot;
      if (typeof root !== 'string' || root === '') return null;
      // 回收站在**每个盘**的根上，这里取系统盘那一个（Windows 所在盘）。
      return join(dirname(root), '$Recycle.Bin');
    },
    action: { type: 'command', cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Clear-RecycleBin -Force'] },
    note: '清空回收站里的全部文件 —— 删掉之后就找不回来了，所以默认不勾。回收站是空的或被禁用时命令会报错，会如实报告。',
  },
  {
    id: 'win-winsxs',
    label: 'Windows 组件存储（WinSxS）',
    tool: 'Windows',
    semantics: 'prune',
    risk: 'medium',
    platforms: ['win32'],
    group: 'system',
    selectedByDefault: false,
    locatePath: (home, env) => envPath(env, 'SystemRoot', 'WinSxS'),
    action: { type: 'command', cmd: 'dism.exe', args: ['/Online', '/Cleanup-Image', '/StartComponentCleanup'] },
    // DISM 这一条要跑好几分钟，全局默认的 3 分钟会把它中途杀掉。
    timeoutMs: 15 * 60 * 1000,
    note: '用 Windows 自带的 DISM 清理组件存储里已被新版本取代的旧组件。要管理员权限，耗时几分钟；已装更新的回滚点会保留一部分，所以不一定能全释放出来。',
  },
];

/**
 * 这个适配器在当前平台上有意义吗。
 *
 * @param {object} adapter 适配器。
 * @param {string} platform process.platform。
 * @returns {boolean} 是否适用。
 */
export function adapterSupported(adapter, platform) {
  if (!Array.isArray(adapter.platforms)) return true;
  return adapter.platforms.includes(platform);
}

/**
 * 问工具要它的缓存目录。
 *
 * @param {object} adapter 适配器。
 * @param {{home: string, env: object}} homeEnv 家目录与环境变量。
 * @param {object} context 发现过程的共享上下文。
 * @returns {Promise<string|null>} 目录路径；拿不到就是 null。
 */
export async function locateCacheDir(adapter, homeEnv, context) {
  if (typeof adapter.locatePath === 'function') {
    const value = adapter.locatePath(homeEnv.home, homeEnv.env, context);
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  }
  if (adapter.locate === undefined || adapter.locate === null) return null;
  const result = await runCommand(adapter.locate.cmd, adapter.locate.args, { timeoutMs: LOCATE_TIMEOUT_MS });
  if (!result.ok) return null;
  const value = result.stdout.split('\n')[0].trim();
  return value === '' ? null : value;
}

/**
 * 工具装了没有。
 *
 * @param {object} adapter 适配器。
 * @returns {Promise<boolean>} 是否装了。
 */
export async function detectTool(adapter) {
  if (adapter.detect === undefined || adapter.detect === null) return false;
  const result = await runCommand(adapter.detect.cmd, adapter.detect.args, { timeoutMs: DETECT_TIMEOUT_MS });
  return result.ok;
}

/**
 * 从当前 pnpm store 里找出**已经没人用的旧版本目录**。
 *
 * pnpm 把不同代的存储格式放在同一个 store 根目录下面（store/v3、store/v11 …）。
 * 升级 pnpm 之后旧的那一份没人再写也没人再读，但它还占着磁盘 —— 而且没有任何
 * 官方命令会清它（`pnpm store prune` 只管当前这一代）。
 *
 * 目录清单直接读文件系统 —— 早先用 `sh -c ls`，那在 Windows 上没有 sh 的语义，
 * 路径里的反斜杠还会被 shell 吃掉。
 *
 * @param {string} storeDir 当前 store 路径（形如 <root>/v11）。
 * @returns {Promise<string[]>} 旧版本目录的绝对路径。
 */
export async function findOrphanStoreVersions(storeDir) {
  if (typeof storeDir !== 'string' || storeDir === '') return [];
  if (!isAbsolute(storeDir)) return [];
  const root = dirname(storeDir);
  const current = basename(storeDir);
  // 根目录（'/' 或 'C:\'）下面找不出「上一代」—— 那一层没有意义。
  if (root === '' || root === '.' || dirname(root) === root) return [];
  let names;
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const orphans = [];
  for (const name of names) {
    if (name === current) continue;
    // pnpm 的存储代次目录都叫 v<数字>；别的同名目录不碰。
    if (!/^v\d+$/.test(name)) continue;
    orphans.push(join(root, name));
  }
  return orphans;
}

/**
 * 把一条命令渲染成给人看的文本。
 *
 * @param {{cmd: string, args: string[]}|null} command 命令。
 * @returns {string} 文本。
 */
export function formatCommand(command) {
  if (command === null || command === undefined) return '';
  const parts = [command.cmd, ...command.args];
  return parts.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
}
