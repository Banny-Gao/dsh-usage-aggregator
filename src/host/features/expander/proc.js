// src/host/features/expander/proc.js
//
// 原 dsh-plugin-expander/lib/proc.js —— 逐字搬过来，逻辑一行未改。
//
// 跑一条外部命令，拿它的退出码和输出。
//
// 用 node 自带的 child_process 而不是宿主的 subprocess 服务：这里跑的是
// pnpm view / git ls-remote 这类「读一眼」的查询，失败就当成「查不到」，
// 不需要沙箱与审批那一套；而 pnpm 真正的安装动作由官方插件管理器执行，
// 那里已经有完整的锁、审批与失败恢复。

import { execFile } from 'node:child_process';

/**
 * 跑一条命令。
 *
 * 超时、找不到可执行文件、退出码非零都不抛异常 —— 调用方要的是「查到了没有」，
 * 抛异常会把「这个源不可用」和「程序坏了」混成一件事。
 *
 * @param {string} command 可执行文件名或路径。
 * @param {string[]} args 参数列表。
 * @param {{cwd?: string, env?: Record<string, string|undefined>, timeoutMs?: number}} options 运行选项。
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean}>} 运行结果。
 */
export function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env === undefined ? process.env : { ...process.env, ...options.env },
        timeout: options.timeoutMs ?? 20000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const timedOut = error !== null && error !== undefined && (error.killed === true || error.code === 'ETIMEDOUT');
        resolve({
          code: error === null || error === undefined ? 0 : typeof error.code === 'number' ? error.code : 1,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          timedOut,
        });
      },
    );
    child.on('error', () => {
      // execFile 的回调已经会带 error 走完；这里只防止未捕获异常。
    });
  });
}
