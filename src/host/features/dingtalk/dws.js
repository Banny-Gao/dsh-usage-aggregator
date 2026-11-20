// src/host/features/dingtalk/dws.js
//
// 只包官方 dws CLI：把一次调用变成一份结构化结果。
//
// 为什么包 CLI 而不是直连 OpenAPI：登录态、鉴权续期、多账号 profile、命令级的
// 消歧规则全在 CLI 里。插件再实现一遍只会得到一个更差的版本，还多一份凭据风险。
//
// 三条硬规矩（照 dws 的执行契约来，插件不自己发明）：
//   1. 结构化读取一律带 `--format json`；
//   2. 后续用到的 ID 必须来自真实返回，不从名字猜；
//   3. 零命中 / 多候选就停下来交给人，绝不取第一个。
//
// ⚠️ 这里只暴露**本功能要用的那几条**命令，不把 CLI 的 shortcut 全量摊开成工具。

import { runProcess } from '../../shared/cmd.js';

/** CLI 可执行文件名。 */
export const DWS_BIN = 'dws';

/** 单次调用的默认超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 30000;

/**
 * 解析 CLI 的 JSON 输出。
 *
 * CLI 偶尔会在 JSON 之前打印一行日志（升级提示之类），所以不直接 parse 整段：
 * 先试整段，失败再从第一个 '{' 或 '[' 开始截一段试。
 *
 * @param {string} text 原始输出。
 * @returns {unknown|null} 解析结果；解析不出来就是 null。
 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // 继续：从第一个可能的 JSON 起点再试一次。
  }
  const start = trimmed.search(/[[{]/);
  if (start < 0) return null;
  const tail = trimmed.slice(start);
  for (let end = tail.length; end > 0; end -= 1) {
    try {
      return JSON.parse(tail.slice(0, end));
    } catch {
      /* 继续缩短 */
    }
  }
  return null;
}

/**
 * 跑一条 dws 命令。
 *
 * 失败**不抛异常**：调用方要的是「查到了没有」，抛异常会把「CLI 没装 / 没登录」
 * 这类环境问题和「程序写错了」混成一件事。
 *
 * @param {string[]} args 命令参数（不含可执行名）。
 * @param {{timeoutMs?: number, cwd?: string, format?: boolean, bin?: string}} options 选项。
 * @returns {Promise<{ok: boolean, reason: string, code: number|null, stdout: string, stderr: string, json: unknown}>} 结果。
 */
export async function runDws(args, options = {}) {
  const list = Array.isArray(args) ? args.map((item) => String(item)) : [];
  const withFormat = options.format === false ? list : [...list, '--format', 'json'];
  const result = await runProcess(options.bin ?? DWS_BIN, withFormat, {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    cwd: options.cwd,
  });

  if (result.missing === true) {
    return {
      ok: false,
      reason: 'dws-not-found',
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      json: null,
    };
  }
  if (result.timedOut) {
    return {
      ok: false,
      reason: 'dws-timeout',
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      json: null,
    };
  }
  const json = parseJsonLoose(result.stdout);
  if (result.ok !== true) {
    return {
      ok: false,
      reason: 'dws-exit',
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      json,
    };
  }
  if (json === null && result.stdout.trim() !== '') {
    // 退出码是 0，但输出不是 JSON —— 这多半是 CLI 换了输出形态，别把它当成功。
    return {
      ok: false,
      reason: 'dws-unparsable',
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      json: null,
    };
  }
  return {
    ok: true,
    reason: '',
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    json,
  };
}

/**
 * 把一次失败翻译成人能看懂的一句。
 *
 * @param {{reason: string, stderr?: string, stdout?: string}} result 失败结果。
 * @returns {string} 一句说明。
 */
export function explainFailure(result) {
  if (result === null || result === undefined) return '钉钉调用失败';
  if (result.reason === 'dws-not-found') {
    return '本机没有装 dws 命令，装好并登录后这个功能才能用（dws 负责钉钉登录态，插件不碰凭据）';
  }
  if (result.reason === 'dws-timeout') return 'dws 调用超时（钉钉侧没在预期时间内返回）';
  const detail = typeof result.stderr === 'string' ? result.stderr.trim() : '';
  const tail = detail === '' ? '' : detail.split('\n').slice(-3).join(' ').slice(0, 300);
  if (result.reason === 'dws-unparsable') {
    return 'dws 的输出不是 JSON，无法解析：' + String(result.stdout ?? '').trim().slice(0, 200);
  }
  return tail === '' ? 'dws 调用失败' : 'dws 调用失败：' + tail;
}
