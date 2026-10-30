// src/host/features/usage/request.js
//
// 请求重放：拿着存下来的请求描述真实打一次接口，并把结果判成 ok / expired / error。
//
// 为什么在 Host 而不是浏览器里发：这些接口基本都不给自己页面以外的 Origin 开
// CORS（实测 minimax.cn 只放行 platform.minimax.cn），浏览器直接发必然被拦；
// 而且 Cookie 也不该常驻前端内存。
//
// 「过期」的判定分两层：
//   1. 传输层：401 / 403；
//   2. 业务层：很多中文站点 HTTP 200，真话在 body 的 status_code / msg 里
//      （minimax 就是 {"base_resp":{"status_code":0,...}} 这种形状）。
// 第二层在还没有模板时走通用启发式，有模板后以模板里的 health 规则为准。

const JSON_LIMIT_BYTES = 512 * 1024;

/** 业务失败码常见的键名。命中这些键且取值「不像成功」，就认为业务层失败了。 */
const CODE_KEYS = ['status_code', 'statuscode', 'code', 'errcode', 'error_code', 'errno', 'ret', 'result_code'];
const MESSAGE_KEYS = ['status_msg', 'statusmsg', 'message', 'msg', 'error', 'error_msg', 'errmsg', 'detail', 'reason'];
/**
 * 「凭证类失败」的文案特征。
 *
 * 为什么要把「过期」和「其它错误」分开：过期是可自愈的（用户重贴一次请求就好），
 * 面板要直接给出重贴入口；而参数不合法、限流之类的错误重贴也没用。中文站点和
 * 英文站点的说法都要覆盖 —— minimax 返回的就是英文的 "invalid api key"。
 */
const EXPIRY_PATTERN = /(登录|登陆|未登录|登出|重新登录|令牌|凭证|凭据|授权|过期|失效|无效|鉴权|签名|unauthorized|unauthenticated|forbidden|denied|not\s*logged|no\s*auth|auth|token\s*(?:expired|invalid)|expired|invalid\s*(?:token|api[-_ ]?key|credential|session)|api[-_ ]?key|credential|signature)/i;

/**
 * 重放一次请求。
 *
 * @param {{method: string, url: string, headers: Record<string,string>, body: string|null}} request
 * @param {{timeoutMs?: number, signal?: AbortSignal, fetchImpl?: typeof fetch}} options
 * @returns {Promise<object>} 结果描述（永远 resolve，失败信息写在 status/message 里）。
 */
export async function performRequest(request, options = {}) {
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 30000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs);
  const onAbort = () => controller.abort(options.signal.reason ?? new Error('已取消'));
  if (options.signal !== undefined) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body === null ? undefined : request.body,
      redirect: 'follow',
      signal: controller.signal,
    });
    const ms = Date.now() - startedAt;
    const text = await response.text();
    const bytes = Buffer.byteLength(text);
    const json = parseMaybeJson(text, response.headers.get('content-type'));
    const base = {
      at: Date.now(),
      httpStatus: response.status,
      ms,
      bytes,
      json,
      // 原始文本也留着：既给「原始响应」折叠区看，也给模型分析用。
      text: json === null && bytes > JSON_LIMIT_BYTES ? `${text.slice(0, JSON_LIMIT_BYTES)}\n…（已截断）` : text,
    };
    if (response.status === 401 || response.status === 403) {
      return { ...base, status: 'expired', message: `HTTP ${response.status}：登录态已失效，需要重新粘贴请求` };
    }
    if (!response.ok) {
      const detail = businessMessage(json) ?? preview(text);
      return { ...base, status: 'error', message: `HTTP ${response.status}${detail === null ? '' : `：${detail}`}` };
    }
    const failure = detectBusinessFailure(json);
    if (failure !== null) {
      return { ...base, status: failure.expired ? 'expired' : 'error', message: failure.message };
    }
    if (json === null) {
      return { ...base, status: 'error', message: '响应不是 JSON —— 可能被登录页重定向了，请确认接口地址与登录态' };
    }
    return { ...base, status: 'ok', message: '' };
  } catch (error) {
    const ms = Date.now() - startedAt;
    const aborted = options.signal !== undefined && options.signal.aborted;
    return {
      at: Date.now(),
      httpStatus: null,
      ms,
      bytes: 0,
      json: null,
      text: null,
      status: aborted ? 'error' : 'error',
      message: aborted ? '已取消' : `请求失败：${errorCause(error)}`,
    };
  } finally {
    clearTimeout(timer);
    if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort);
  }
}

/** 通用业务层失败识别（还没模板时的初判；有模板后由 template.health 接管）。 */
export function detectBusinessFailure(json) {
  if (json === null || typeof json !== 'object') return null;
  const found = searchCode(json, 0);
  if (found === null) return null;
  const { code, message } = found;
  const expired = EXPIRY_PATTERN.test(message) || code === 401 || code === 403 || code === 1002 || code === 1004;
  const label = code === null ? '业务返回失败' : `业务返回 ${code}`;
  return { expired, message: message === '' ? label : `${label}：${message}` };
}

function searchCode(node, depth) {
  if (node === null || typeof node !== 'object' || depth > 3) return null;
  const keys = Object.keys(node);
  for (const key of CODE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      const value = node[key];
      const code = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : null;
      const textValue = typeof value === 'string' && /^(ok|success|succeeded|true)$/i.test(value) ? 0 : null;
      const effective = code ?? textValue;
      if (effective !== null && effective !== 0) {
        const message = MESSAGE_KEYS.map((name) => (typeof node[name] === 'string' ? node[name] : null)).find((item) => item !== null) ?? '';
        return { code: effective, message };
      }
      if (typeof value === 'string' && /^(fail|failed|error|unauthorized|forbidden|invalid)$/i.test(value)) {
        const message = MESSAGE_KEYS.map((name) => (typeof node[name] === 'string' ? node[name] : null)).find((item) => item !== null) ?? '';
        return { code: null, message };
      }
    }
  }
  for (const key of keys) {
    const child = node[key];
    if (child !== null && typeof child === 'object') {
      const nested = searchCode(child, depth + 1);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function businessMessage(json) {
  if (json === null || typeof json !== 'object') return null;
  for (const key of MESSAGE_KEYS) {
    if (typeof json[key] === 'string' && json[key] !== '') return preview(json[key]);
  }
  return null;
}

function preview(text) {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length <= 160 ? flat : `${flat.slice(0, 160)}…`;
}

function parseMaybeJson(text, contentType) {
  if (typeof text !== 'string' || text === '') return null;
  const looksJson = contentType !== null && /\bjson\b/i.test(contentType);
  const trimmed = text.trim();
  if (!looksJson && !trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function errorCause(error) {
  if (error === null || typeof error !== 'object') return String(error);
  const cause = error.cause;
  if (cause !== null && typeof cause === 'object' && typeof cause.code === 'string') return `${error.message}（${cause.code}）`;
  return typeof error.message === 'string' ? error.message : String(error);
}
