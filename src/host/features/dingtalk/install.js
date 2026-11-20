// src/host/features/dingtalk/install.js
//
// 环境自检与依赖安装：把「本机没有 dws 命令」从一句提示变成一次真的安装。
//
// 为什么要有这一层：dws 是**外部 CLI**，插件不自带。缺了它，这块功能就是空转 ——
// 面板上写一句「请自行安装」等于把活甩回给用户。官方给的安装方式就三条
// （npm 全局 / Homebrew / 官方安装脚本），这一层按「本机有什么就用哪条」把它装上。
//
// 三条硬规矩：
//   1. 只装 dws 这一个东西，不顺手装别的；
//   2. 不碰登录态 —— dws auth login 要扫码，那是用户的事，这里只检测并如实说；
//   3. 装完必须**重新探测**：装上 ≠ 能用（可能不在 PATH 上、可能版本太老）。
//
// 为什么装完要记绝对路径：官方脚本装到 ~/.local/bin，npm 全局装到
// `npm prefix -g/bin` —— 这两个目录**经常不在宿主进程的 PATH 上**。
// 只认 PATH 的话，用户明明装好了，插件却还在说「没装」。

import { access, constants, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../../shared/cmd.js';
import { parseJsonLoose } from './dws.js';

/** dws 的 npm 包名（装完 bin 名就是 dws）。 */
export const DWS_NPM_PACKAGE = 'dingtalk-workspace-cli';

/** 官方安装脚本（macOS / Linux）。 */
export const DWS_INSTALL_SH = 'https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.sh';

/** 官方安装脚本（Windows）。 */
export const DWS_INSTALL_PS1 = 'https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.ps1';

/** 登录态：问不出来（命令失败、输出看不懂）。 */
export const LOGIN_UNKNOWN = 'unknown';

/** 登录态：已登录。 */
export const LOGIN_YES = 'yes';

/** 登录态：没登录。 */
export const LOGIN_NO = 'no';

/** 装 dws 的超时（毫秒）。要下平台二进制，npm 冷启动经常一两分钟。 */
const INSTALL_TIMEOUT_MS = 600000;

/** 探测一条命令的超时（毫秒）。 */
const PROBE_TIMEOUT_MS = 8000;

/**
 * 取用户主目录（各平台变量名不一样）。
 *
 * @param {object} env 环境变量。
 * @returns {string} 主目录；取不到就是空串。
 */
export function homeOf(env) {
  const value = env.HOME ?? env.USERPROFILE ?? '';
  return typeof value === 'string' ? value : '';
}

/**
 * 输出第一行（版本横幅都是一行文本）。
 *
 * @param {string} text 原始输出。
 * @returns {string} 第一行；没有就是空串。
 */
function firstLine(text) {
  return String(text ?? '').trim().split('\n')[0].trim();
}

/**
 * 这个路径是不是可执行的。
 *
 * @param {string} path 路径。
 * @returns {Promise<boolean>} 可执行就是 true。
 */
async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 问 npm 全局前缀在哪。
 *
 * @param {object} env 环境变量。
 * @param {Function} run 跑命令的函数。
 * @returns {Promise<string>} 前缀；问不到就是空串。
 */
async function npmPrefix(env, run) {
  const result = await run('npm', ['config', 'get', 'prefix'], { timeoutMs: PROBE_TIMEOUT_MS, env });
  if (result.ok !== true) return '';
  return firstLine(result.stdout);
}

/**
 * 列出 dws 可能待着的绝对路径。
 *
 * 顺序即优先级：npm 全局前缀在前（npm 装的就在那儿），其次是官方脚本装的
 * ~/.local/bin，最后是 Homebrew 与系统目录。
 *
 * @param {object} env 环境变量。
 * @param {string} prefix npm 全局前缀（没有就是空串）。
 * @returns {string[]} 候选路径。
 */
export function candidateBins(env, prefix) {
  const list = [];
  if (prefix !== '') {
    list.push(join(prefix, 'bin', 'dws'));
    list.push(join(prefix, 'bin', 'dws.cmd'));
    list.push(join(prefix, 'dws.cmd'));
  }
  const home = homeOf(env);
  if (home !== '') {
    list.push(join(home, '.local', 'bin', 'dws'));
    list.push(join(home, '.local', 'bin', 'dws.exe'));
  }
  list.push('/opt/homebrew/bin/dws');
  list.push('/usr/local/bin/dws');
  list.push('/usr/bin/dws');
  return list;
}

/**
 * 问一个 dws 的版本。
 *
 * @param {string} bin 可执行名或绝对路径。
 * @param {Function} run 跑命令的函数。
 * @param {object} env 环境变量。
 * @returns {Promise<string>} 版本行；问不到就是空串。
 */
async function versionOf(bin, run, env) {
  const result = await run(bin, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS, env });
  if (result.ok !== true) return '';
  return firstLine(result.stdout);
}

/**
 * 问 dws 登录了没有。
 *
 * 只读：跑一次 `dws auth status`，从输出里认「没登录」的字样。
 * 认不出来就说不知道 —— **不猜**。登录是用户扫码的事，插件不碰凭据。
 *
 * dws 的 `auth status` 是一份 JSON，`authenticated` / `token_valid` 是权威字段；
 * 认字段比认字样准（字样匹配留给认不出 JSON 的老版本）。
 *
 * @param {string} bin dws 可执行名或绝对路径（没有就是空串）。
 * @param {Function} run 跑命令的函数。
 * @param {object} env 环境变量。
 * @returns {Promise<string>} 'yes' / 'no' / 'unknown'。
 */
export async function detectLogin(bin, run, env) {
  if (bin === '') return LOGIN_UNKNOWN;
  const result = await run(bin, ['auth', 'status'], { timeoutMs: PROBE_TIMEOUT_MS, env });
  if (result.ok !== true) return LOGIN_UNKNOWN;
  const raw = String(result.stdout ?? '');

  const parsed = parseJsonLoose(raw);
  if (parsed !== null && typeof parsed === 'object') {
    const authenticated = readBoolean(parsed, ['authenticated', 'isAuthenticated']);
    if (authenticated === false) return LOGIN_NO;
    if (authenticated === true) return LOGIN_YES;
    const tokenValid = readBoolean(parsed, ['token_valid', 'tokenValid']);
    if (tokenValid === false) return LOGIN_NO;
  }

  const text = (raw + ' ' + String(result.stderr ?? '')).toLowerCase();
  const notLoggedIn = /(not logged in|not authenticated|no active profile|unauthorized|login required|未登录|请先登录|token expired|auth_token_expired)/;
  if (notLoggedIn.test(text)) return LOGIN_NO;
  return LOGIN_YES;
}

/**
 * 在一份 JSON 里按键名找布尔值（只找顶层与一层嵌套）。
 *
 * @param {unknown} node JSON 节点。
 * @param {string[]} keys 键名候选。
 * @returns {boolean|null} 找到就是它的值；没有就是 null。
 */
function readBoolean(node, keys) {
  if (node === null || typeof node !== 'object') return null;
  for (const key of keys) {
    if (typeof node[key] === 'boolean') return node[key];
  }
  for (const value of Object.values(node)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of keys) {
        if (typeof value[key] === 'boolean') return value[key];
      }
    }
  }
  return null;
}

/**
 * 探测本机有哪些安装器能用。
 *
 * @param {{env?: object, run?: Function, platform?: string}} options 选项。
 * @returns {Promise<Array<{id: string, label: string}>>} 可用的安装器（按尝试顺序）。
 */
export async function detectInstallers(options = {}) {
  const env = options.env ?? process.env;
  const run = options.run ?? runProcess;
  const platform = options.platform ?? process.platform;
  const list = [];

  const npmProbe = await run('npm', ['--version'], { timeoutMs: PROBE_TIMEOUT_MS, env });
  if (npmProbe.ok === true) list.push({ id: 'npm', label: 'npm 全局安装' });

  if (platform !== 'win32') {
    const brewProbe = await run('brew', ['--version'], { timeoutMs: PROBE_TIMEOUT_MS, env });
    if (brewProbe.ok === true) list.push({ id: 'brew', label: 'Homebrew 安装' });
  }

  if (platform === 'win32') {
    const psProbe = await run('powershell', ['-NoProfile', '-Command', 'exit 0'], { timeoutMs: PROBE_TIMEOUT_MS, env });
    if (psProbe.ok === true) list.push({ id: 'script', label: '官方安装脚本' });
  } else {
    const curlProbe = await run('curl', ['--version'], { timeoutMs: PROBE_TIMEOUT_MS, env });
    const shProbe = await run('sh', ['-c', 'exit 0'], { timeoutMs: PROBE_TIMEOUT_MS, env });
    if (curlProbe.ok === true && shProbe.ok === true) list.push({ id: 'script', label: '官方安装脚本' });
  }

  return list;
}

/**
 * 探测环境：dws 装没装、在哪、什么版本、登录了没有、有哪些安装器可用。
 *
 * @param {{env?: object, run?: Function, platform?: string, probe?: Function, installers?: boolean}} options 选项。
 *   probe 是外部已知的 dws（自检里注入假 dws 时用），返回 {version, path} 或 null。
 * @returns {Promise<{installed: boolean, version: string, path: string, loggedIn: string, installers: Array<object>}>} 探测结果。
 */
export async function detectEnvironment(options = {}) {
  const env = options.env ?? process.env;
  const run = options.run ?? runProcess;
  const platform = options.platform ?? process.platform;
  const withInstallers = options.installers !== false;

  let path = '';
  let version = '';

  if (typeof options.probe === 'function') {
    const given = await options.probe();
    if (given !== null && given !== undefined) {
      version = String(given.version ?? '');
      path = String(given.path ?? '');
    }
  }

  if (version === '') {
    // 先问 PATH 上那个（最常见的情况）。
    const onPath = await run('dws', ['--version'], { timeoutMs: PROBE_TIMEOUT_MS, env });
    if (onPath.ok === true) {
      path = 'dws';
      version = firstLine(onPath.stdout);
    }
  }

  if (version === '') {
    // 再按已知安装位置找 —— 装在 PATH 之外也要认出来。
    const prefix = await npmPrefix(env, run);
    for (const candidate of candidateBins(env, prefix)) {
      if (await isExecutable(candidate) === false) continue;
      const found = await versionOf(candidate, run, env);
      if (found !== '') {
        path = candidate;
        version = found;
        break;
      }
    }
  }

  const loggedIn = await detectLogin(path, run, env);
  const installers = withInstallers ? await detectInstallers({ env, run, platform }) : [];

  return { installed: version !== '', version, path, loggedIn, installers };
}

/**
 * 跑一条安装命令。
 *
 * @param {string} id 安装器 id。
 * @param {{env: object, run: Function, platform: string}} deps 依赖。
 * @returns {Promise<{ok: boolean, error: string}>} 结果。
 */
async function runInstall(id, deps) {
  const { env, run, platform } = deps;

  if (id === 'npm') {
    const result = await run('npm', ['install', '-g', DWS_NPM_PACKAGE], { timeoutMs: INSTALL_TIMEOUT_MS, env });
    if (result.ok === true) return { ok: true, error: '' };
    const detail = String(result.stderr ?? '').trim().split('\n').slice(-2).join(' ').slice(0, 300);
    return { ok: false, error: detail === '' ? 'npm 装不上（退出码 ' + result.code + '）' : detail };
  }

  if (id === 'brew') {
    // tap 已经存在时 tap 会返回非零 —— 那不算失败，接着装就行。
    await run('brew', ['tap', 'DingTalk-Real-AI/dingtalk-workspace-cli'], { timeoutMs: 120000, env });
    const result = await run('brew', ['install', 'dingtalk-workspace-cli'], { timeoutMs: INSTALL_TIMEOUT_MS, env });
    if (result.ok === true) return { ok: true, error: '' };
    const detail = String(result.stderr ?? '').trim().split('\n').slice(-2).join(' ').slice(0, 300);
    return { ok: false, error: detail === '' ? 'brew 装不上（退出码 ' + result.code + '）' : detail };
  }

  if (id === 'script') {
    const dir = await mkdtemp(join(tmpdir(), 'dws-install-'));
    try {
      const isWindows = platform === 'win32';
      const file = join(dir, isWindows ? 'install.ps1' : 'install.sh');
      const url = isWindows ? DWS_INSTALL_PS1 : DWS_INSTALL_SH;
      const download = await run('curl', ['-fsSL', url, '-o', file], { timeoutMs: 120000, env });
      if (download.ok !== true) {
        return { ok: false, error: '下载官方安装脚本失败（curl 退出码 ' + download.code + '）' };
      }
      // 不用 `curl | sh`：管道要走 shell，而这一层刻意不开 shell（防命令注入）。
      const executed = isWindows
        ? await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { timeoutMs: INSTALL_TIMEOUT_MS, env })
        : await run('sh', [file], { timeoutMs: INSTALL_TIMEOUT_MS, env });
      if (executed.ok === true) return { ok: true, error: '' };
      const detail = String(executed.stderr ?? '').trim().split('\n').slice(-2).join(' ').slice(0, 300);
      return { ok: false, error: detail === '' ? '官方脚本没跑成功（退出码 ' + executed.code + '）' : detail };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  return { ok: false, error: '不认识的安装方式：' + id };
}

/**
 * 装 dws：按本机可用的安装器挨个试，装完重新探测。
 *
 * @param {{env?: object, run?: Function, platform?: string, detect?: Function, onStage?: Function}} options 选项。
 *   onStage(stage, method) 用来报进度；stage 是 'installing' / 'verifying'。
 * @returns {Promise<{ok: boolean, method: string, error: string, path?: string, version?: string, loggedIn?: string}>} 结果。
 */
export async function installDws(options = {}) {
  const env = options.env ?? process.env;
  const run = options.run ?? runProcess;
  const platform = options.platform ?? process.platform;
  const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
  const detect = options.detect ?? ((opts) => detectEnvironment(opts));

  const installers = await detectInstallers({ env, run, platform });
  if (installers.length === 0) {
    return {
      ok: false,
      method: '',
      error: '本机没有可用的安装器（要 npm 或 Homebrew，或者能下脚本的 curl）',
    };
  }

  const problems = [];
  for (const installer of installers) {
    onStage('installing', installer.id);
    const result = await runInstall(installer.id, { env, run, platform });
    if (result.ok !== true) {
      problems.push(installer.label + '：' + result.error);
      continue;
    }
    onStage('verifying', installer.id);
    const detected = await detect({ env, run, platform });
    if (detected.installed === true) {
      return {
        ok: true,
        method: installer.id,
        error: '',
        path: detected.path,
        version: detected.version,
        loggedIn: detected.loggedIn,
      };
    }
    problems.push(installer.label + '：装完了还是找不到 dws 命令');
  }

  return { ok: false, method: '', error: problems.join('；') };
}
