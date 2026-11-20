// src/host/shared/cmd.js
//
// 跨平台跑一条外部命令。
//
// 为什么不能直接用 child_process.execFile：
//   Windows 上 npm / pnpm / yarn / npx 都是 **.cmd 垫片**（一段转发给 node 的
//   批处理）。Node 不带 shell 时既不解析 PATHEXT 也不认 shebang，直接 spawn
//   的结果是 ENOENT（'npm' 根本找不到）或 EINVAL（'.cmd' 不能直接执行）。
//   DSH 自己的 subprocess 服务也是按 PATHEXT 解析可执行文件来绕开这一点的
//   （dsh-subprocess-local 的 executableCandidates）。
//   本插件的「清理」与「插件更新」两个功能都靠探测外部命令活着，所以这一层
//   是它们在 Windows 上能不能用的总开关。
//
// 这里做三件事：
//   1. 按 PATH + PATHEXT 解析出真实的可执行文件；
//   2. 解析出来是 .cmd / .bat 时交给 cmd.exe 跑（批处理只能这么跑），
//      参数按 Windows 的引号与元字符规则转义（与 cross-spawn 同一套算法：
//      参数加引号 + 元字符用 ^ 转义，命令行整体再包一层引号）；
//   3. 命令与参数里出现 CR / LF 一律拒绝 —— cmd.exe 把它当命令分隔符，
//      挡不住就等于开了命令注入的口子。

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';

/** 默认超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 20000;

/** Windows 上默认的可执行扩展名（PATHEXT 没设时用这个）。 */
const DEFAULT_PATH_EXT = '.COM;.EXE;.BAT;.CMD';

/** cmd.exe 会当成语法而不是文本的元字符。 */
const META_CHARS = /([()[\]%!^"`<>&|;, *?])/g;

/**
 * cmd.exe 的元字符转义（加 ^ 前缀）。
 *
 * @param {string} text 原文。
 * @returns {string} 转义后的文本。
 */
function escapeMeta(text) {
  return text.replace(META_CHARS, '^$1');
}

/**
 * 一个参数的转义：按 CommandLineToArgvW 的规则保住字面量，再把 cmd.exe 的
 * 元字符挡掉。
 *
 * @param {string} text 参数原文。
 * @returns {string} 转义后的参数。
 */
function escapeArgument(text) {
  let value = String(text);
  // 反斜杠后跟引号：反斜杠加倍，引号转义。
  value = value.replace(/(\\+?)"/g, '$1$1\\"');
  // 结尾的反斜杠（后面会补一个引号）：加倍。
  value = value.replace(/(\\+?)$/, '$1$1');
  value = `"${value}"`;
  return escapeMeta(value);
}

/**
 * 拒绝会跨命令边界的字符。
 *
 * @param {string} text 原文。
 * @param {string} what 说明（报错时用）。
 * @returns {void} 合法则什么也不做。
 */
function assertNoLineBreak(text, what) {
  if (/[\r\n]/.test(text)) {
    throw new Error(`${what} 里含有换行符，拒绝执行（Windows 上换行是命令分隔符）`);
  }
}

/**
 * 按 PATH + PATHEXT 解析出 Windows 上真实存在的可执行文件。
 *
 * @param {string} command 命令名或路径。
 * @param {object} env 环境变量。
 * @returns {Promise<string|null>} 绝对路径；找不到就是 null。
 */
export async function resolveWindowsExecutable(command, env) {
  const extensions = extname(command) === ''
    ? String(env.PATHEXT ?? DEFAULT_PATH_EXT).split(';').filter((item) => item !== '')
    : [''];
  const directories = String(env.PATH ?? '').split(delimiter).filter((item) => item !== '');
  const candidates = [];
  if (isAbsolute(command)) {
    for (const extension of extensions) candidates.push(command + extension);
  } else {
    for (const directory of directories) {
      for (const extension of extensions) candidates.push(join(directory, command + extension));
    }
  }
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      /* 不是这个，继续找 */
    }
  }
  return null;
}

/**
 * 把一条命令变成「可以直接 spawn 的」命令与参数。
 *
 * @param {string} command 命令。
 * @param {string[]} args 参数。
 * @param {object} env 环境变量。
 * @returns {Promise<{command: string, args: string[], verbatim: boolean}>} 准备好的命令。
 */
async function prepare(command, args, env) {
  if (process.platform !== 'win32') {
    return { command, args, verbatim: false };
  }
  assertNoLineBreak(command, '命令');
  for (const arg of args) assertNoLineBreak(arg, '参数');

  const resolved = await resolveWindowsExecutable(command, env);
  if (resolved === null) {
    // 解析不出来就按原样交给 spawn —— 让它以「命令不存在」的方式失败，
    // 与 POSIX 上的行为一致（调用方只关心成功与否）。
    return { command, args, verbatim: false };
  }
  const extension = extname(resolved).toLowerCase();
  if (extension !== '.cmd' && extension !== '.bat') {
    return { command: resolved, args, verbatim: false };
  }
  // 批处理只能交给 cmd.exe 跑。
  const comspec = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
  const shellCommand = [escapeMeta(resolved), ...args.map(escapeArgument)].join(' ');
  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    verbatim: true,
  };
}

/**
 * 跑一条命令，拿它的退出码与输出。
 *
 * 失败（超时、找不到命令、非零退出）都不抛异常 —— 调用方要的是「查到了没有」，
 * 抛异常会把「这个源不可用」和「程序坏了」混成一件事。
 *
 * @param {string} command 可执行文件名或路径。
 * @param {string[]} args 参数列表。
 * @param {{cwd?: string, env?: Record<string, string|undefined>, timeoutMs?: number}} options 运行选项。
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean, missing: boolean}>} 运行结果。
 */
export function runProcess(command, args, options = {}) {
  const list = Array.isArray(args) ? args.map((item) => String(item)) : [];
  const env = options.env === undefined ? process.env : { ...process.env, ...options.env };
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return prepare(String(command), list, env).then((ready) => new Promise((resolve) => {
    const child = execFile(
      ready.command,
      ready.args,
      {
        cwd: options.cwd,
        env,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: ready.verbatim,
      },
      (error, stdout, stderr) => {
        const timedOut = error !== null && error !== undefined
          && (error.killed === true || error.code === 'ETIMEDOUT');
        const code = error === null || error === undefined
          ? 0
          : typeof error.code === 'number' ? error.code : 1;
        resolve({
          ok: code === 0,
          code,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          timedOut,
          // 可执行文件不存在（ENOENT）与「跑起来了但退出码非零」是两回事：
          // 调用方常据此改话术（没装 vs 装错了），所以单独标出来。
          missing: error !== null && error !== undefined && error.code === 'ENOENT',
        });
      },
    );
    child.on('error', () => {
      // execFile 的回调已经会带 error 走完；这里只防止未捕获异常。
    });
  }));
}
