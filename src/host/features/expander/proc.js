// src/host/features/expander/proc.js
//
// 跑一条外部命令，拿它的退出码和输出。
//
// 用 shared/cmd.js 的跨平台执行器而不是宿主 subprocess 服务：这里跑的是
// pnpm view / git ls-remote 这类「读一眼」的查询，失败就当成「查不到」，
// 不需要沙箱与审批那一套；而 pnpm 真正的安装动作由官方插件管理器执行，
// 那里已经有完整的锁、审批与失败恢复。
//
// ⚠️ 必须走 shared/cmd.js：Windows 上 npm / pnpm / yarn 都是 **.cmd 垫片**
//   （一段转发给 node 的批处理），不带 shell 直接 spawn 会 ENOENT（找不到）
//   或 EINVAL（.cmd 不能直接执行）—— 那正是「所有插件都查不到更新」的根因。
//   shared/cmd.js 按 PATH + PATHEXT 解析可执行文件，.cmd/.bat 自动交给 cmd.exe 跑。

import { runProcess } from '../../shared/cmd.js';

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
export async function runCommand(command, args, options = {}) {
  const result = await runProcess(command, args, options);
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
}
