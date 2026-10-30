// src/host/features/usage/curl.js
//
// 「粘贴一次接口请求」的解析层：把用户从 DevTools 复制出来的东西变成一份可重放
// 的请求描述。
//
// 支持四种粘贴形态（按真实使用频率排）：
//   1. Copy as cURL（bash）—— 主路径，含 \ 换行续行、单双引号、-H/-b/--data-raw
//   2. 原始 HTTP 报文（GET /path HTTP/1.1 + 头 + 空行 + body）
//   3. 只有一行 URL
//   4. JSON（{"url": ..., "headers": {...}}，某些站点「Copy as fetch」的变体）
//
// 解析是纯函数，不碰网络、不碰存储，便于单测（见 scripts/smoke.mjs）。
//
// 为什么自己做词法而不是交给模型：cURL 是机器生成的格式，规则确定；解析失败再
// 由调用方退回 LLM 提取（analyze.js 的 extractRequest）。确定性优先，模型兜底。

/** 重放时不应该带上的头：走谁的网络栈谁定，硬抄过去只会出错。 */
const DROP_HEADERS = new Set([
  'content-length',
  'accept-encoding',
  'connection',
  'host',
  'transfer-encoding',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'priority',
]);

/** 头名规范化：curl 里大小写随意，落库统一成小写。 */
const lower = (name) => String(name).trim().toLowerCase();

/**
 * 把 shell 风格的命令行切成 token。
 *
 * 只实现 cURL 实际会用到的子集：单引号原样、双引号解转义、反斜杠换行续行、
 * 反斜杠转义。不做变量展开、不做命令替换 —— 这些在粘贴里出现就是用户复制错了。
 *
 * @param {string} text 命令行文本。
 * @returns {{tokens: string[], error: string|null}}
 */
export function tokenizeShell(text) {
  const tokens = [];
  let current = '';
  let has = false;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\' && i + 1 < text.length) {
        const next = text[i + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next;
          i += 1;
        } else if (next === '\n') {
          i += 1;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === '\n') i += 1;
      else {
        current += next;
        i += 1;
        has = true;
      }
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (has) {
        tokens.push(current);
        current = '';
        has = false;
      }
      continue;
    }
    current += ch;
    has = true;
  }
  if (quote !== null) return { tokens, error: `引号没有闭合（${quote}）` };
  if (has) tokens.push(current);
  return { tokens, error: null };
}

/** curl 的取值型参数：这些 flag 后面跟的参数不是 URL，也不该被当成位置参数。 */
const VALUE_FLAGS = new Set([
  '-h', '--header', '-b', '--cookie', '-d', '--data', '--data-raw', '--data-binary',
  '--data-urlencode', '-x', '--request', '-a', '--user-agent', '-e', '--referer',
  '-u', '--user', '--url', '-o', '--output', '--connect-timeout', '-m', '--max-time',
  '--compressed-encoding', '-c', '--cookie-jar', '--proxy', '-k',
]);

/**
 * 解析 cURL 命令。
 *
 * @param {string} text 粘贴的命令行（允许前缀 $ / > 与首尾空白）。
 * @returns {{ok: true, request: RequestSpec, notes: string[]} | {ok: false, error: string}}
 */
export function parseCurl(text) {
  const cleaned = String(text == null ? '' : text)
    .replace(/^\s*[$#>]\s*/gm, '')
    .trim();
  if (cleaned === '') return { ok: false, error: '粘贴内容为空' };
  const { tokens, error } = tokenizeShell(cleaned);
  if (error !== null) return { ok: false, error };

  const headers = {};
  let url = null;
  let method = null;
  const datas = [];
  const notes = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const bare = token.trim();
    const flag = lower(bare);
    if (bare.startsWith('-')) {
      const eq = bare.indexOf('=');
      const name = eq > 0 ? lower(bare.slice(0, eq)) : flag;
      const inline = eq > 0 ? bare.slice(eq + 1) : null;
      if (VALUE_FLAGS.has(name)) {
        const value = inline !== null ? inline : tokens[i + 1];
        if (inline === null) i += 1;
        if (typeof value !== 'string') return { ok: false, error: `参数 ${bare} 缺少取值` };
        if (name === '-h' || name === '--header') {
          const colon = value.indexOf(':');
          if (colon > 0) headers[lower(value.slice(0, colon))] = value.slice(colon + 1).trim();
        } else if (name === '-b' || name === '--cookie') {
          const existing = headers.cookie === undefined ? '' : headers.cookie;
          headers.cookie = existing === '' ? value.trim() : `${existing}; ${value.trim()}`;
        } else if (name === '-d' || name === '--data' || name === '--data-raw' || name === '--data-binary' || name === '--data-urlencode') {
          datas.push(value);
        } else if (name === '-x' || name === '--request') {
          method = value.trim().toUpperCase();
        } else if (name === '-a' || name === '--user-agent') {
          headers['user-agent'] = value.trim();
        } else if (name === '-e' || name === '--referer') {
          headers.referer = value.trim();
        } else if (name === '--url') {
          url = value.trim();
        } else if (name === '-c' || name === '--cookie-jar' || name === '-o' || name === '--output' || name === '--proxy' || name === '--connect-timeout' || name === '-m' || name === '--max-time' || name === '-u' || name === '--user' || name === '--compressed-encoding') {
          notes.push(`已忽略 ${name} ${redactValue(name, value)}`);
        }
      } else if (bare === '--compressed' || bare === '-l' || bare === '-i' || bare === '-s' || bare === '-v' || bare === '-g' || bare === '-k' || bare === '--insecure') {
        // 这些只影响 curl 自己的行为，重放时由 Node 的 fetch 决定。
      } else {
        notes.push(`已忽略未知参数 ${bare}`);
      }
      continue;
    }
    if (url === null) {
      url = bare;
    } else {
      notes.push(`已忽略多余的位置参数 ${truncate(bare, 40)}`);
    }
  }

  if (url === null) return { ok: false, error: '没找到 URL —— 请确认复制的是「Copy as cURL」整段' };
  if (!/^https?:\/\//i.test(url)) {
    if (/^https?:\/\//i.test(`https://${url}`)) url = `https://${url}`;
    else return { ok: false, error: `URL 不可用：${truncate(url, 60)}` };
  }
  for (const name of Object.keys(headers)) {
    if (DROP_HEADERS.has(name)) delete headers[name];
  }
  const body = datas.length === 0 ? null : datas.join('&');
  const resolvedMethod = method !== null ? method : body === null ? 'GET' : 'POST';
  return {
    ok: true,
    notes,
    request: { method: resolvedMethod, url, headers, body },
  };
}

/**
 * 解析「原始 HTTP 报文」粘贴（GET /path HTTP/1.1 + 头 + 空行 + body）。
 * 需要 Host 头才能补出 URL —— 拿不到 Host 就交回失败，让调用方走模型兜底。
 */
export function parseRawHttp(text) {
  const source = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
  const lines = source.split('\n');
  const first = lines[0] === undefined ? '' : lines[0].trim();
  const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s+HTTP\/\d(?:\.\d)?$/i.exec(first);
  if (match === null) return { ok: false, error: '不是原始 HTTP 报文' };
  const headers = {};
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') break;
    const colon = line.indexOf(':');
    if (colon > 0) headers[lower(line.slice(0, colon))] = line.slice(colon + 1).trim();
  }
  const body = lines.slice(index + 1).join('\n').trim();
  const host = headers.host;
  if (host === undefined || host === '') return { ok: false, error: '报文里没有 Host 头，补不出完整 URL' };
  const scheme = /:443$/.test(host) ? 'https' : 'https';
  const path = match[2];
  const url = `${scheme}://${host}${path.startsWith('/') ? path : `/${path}`}`;
  for (const name of Object.keys(headers)) {
    if (DROP_HEADERS.has(name)) delete headers[name];
  }
  return { ok: true, notes: [], request: { method: match[1].toUpperCase(), url, headers, body: body === '' ? null : body } };
}

/** 解析 JSON 形态的请求描述（{"url": ..., "headers": {...}}）。 */
function parseJsonRequest(text) {
  const trimmed = String(text).trim();
  if (!trimmed.startsWith('{')) return { ok: false, error: '不是 JSON' };
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { ok: false, error: 'JSON 解析失败' };
  }
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.url !== 'string') {
    return { ok: false, error: 'JSON 里没有 url 字段' };
  }
  const headers = {};
  if (parsed.headers !== null && typeof parsed.headers === 'object') {
    for (const [name, value] of Object.entries(parsed.headers)) {
      if (typeof value === 'string') headers[lower(name)] = value;
    }
  }
  for (const name of Object.keys(headers)) {
    if (DROP_HEADERS.has(name)) delete headers[name];
  }
  const method = typeof parsed.method === 'string' ? parsed.method.toUpperCase() : 'GET';
  const body = typeof parsed.body === 'string' ? parsed.body : null;
  return { ok: true, notes: [], request: { method, url: parsed.url, headers, body } };
}

/**
 * 自动识别粘贴形态并解析。
 *
 * @param {string} text 用户粘贴的原文。
 * @returns {{ok: true, request: RequestSpec, notes: string[], shape: string} | {ok: false, error: string}}
 */
export function parseRequestText(text) {
  const source = String(text == null ? '' : text).trim();
  if (source === '') return { ok: false, error: '粘贴内容为空' };
  if (/^(curl|\$\s*curl|>\s*curl)\b/i.test(source) || source.includes(' -H ') || source.includes('-H ')) {
    const result = parseCurl(source);
    if (result.ok) return { ...result, shape: 'curl' };
    const raw = parseRawHttp(source);
    if (raw.ok) return { ...raw, shape: 'raw-http' };
    return result;
  }
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+\s+HTTP\//i.test(source)) {
    const raw = parseRawHttp(source);
    if (raw.ok) return { ...raw, shape: 'raw-http' };
    return raw;
  }
  if (source.startsWith('{')) {
    const json = parseJsonRequest(source);
    if (json.ok) return { ...json, shape: 'json' };
  }
  if (/^https?:\/\/\S+$/i.test(source.split('\n')[0].trim()) && source.split('\n').length === 1) {
    return { ok: true, shape: 'url', notes: ['只给了 URL —— 如果接口需要登录态，请改用「Copy as cURL」'], request: { method: 'GET', url: source.trim(), headers: {}, body: null } };
  }
  return { ok: false, error: '没识别出请求：请用 DevTools 的「Copy as cURL」整段复制，或粘贴用量页面截图' };
}

/** 去掉 URL 里的敏感查询值，只留结构，用于展示与日志。 */
export function maskUrl(url) {
  try {
    const parsed = new URL(url);
    const params = [...parsed.searchParams.keys()];
    if (params.length === 0) return `${parsed.origin}${parsed.pathname}`;
    const query = params.map((key) => `${key}=***`).join('&');
    return `${parsed.origin}${parsed.pathname}?${query}`;
  } catch {
    return truncate(String(url), 80);
  }
}

/** 列出请求里出现过的请求头名（不返回取值）。 */
export function headerNames(request) {
  if (request === null || typeof request !== 'object') return [];
  return Object.keys(request.headers ?? {}).sort();
}

/**
 * 从请求里读出凭证信息：JWT 的 exp、来源头名。
 *
 * 用途有两个 —— 过期前预警、过期后给出「什么时候失效的」，都是纯本地计算，
 * 不需要先打一次请求才知道过期。
 *
 * @returns {{found: boolean, source: string|null, exp: number|null, subject: string|null, kind: string|null}}
 */
export function inspectCredential(request) {
  const empty = { found: false, source: null, exp: null, subject: null, kind: null };
  if (request === null || typeof request !== 'object') return empty;
  const headers = request.headers ?? {};
  const candidates = [];
  if (typeof headers.cookie === 'string') {
    for (const part of headers.cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) candidates.push([`cookie:${part.slice(0, eq).trim()}`, part.slice(eq + 1).trim()]);
    }
  }
  if (typeof headers.authorization === 'string') candidates.push(['authorization', headers.authorization.replace(/^Bearer\s+/i, '').trim()]);
  if (typeof headers.token === 'string') candidates.push(['token', headers.token.trim()]);
  for (const [source, value] of candidates) {
    const payload = decodeJwtPayload(value);
    if (payload !== null) {
      const exp = typeof payload.exp === 'number' ? payload.exp : null;
      const user = payload.user !== null && typeof payload.user === 'object' ? payload.user : null;
      const subject = user !== null && typeof user.id === 'string' ? user.id : typeof payload.sub === 'string' ? payload.sub : null;
      return { found: true, source, exp, subject, kind: 'jwt' };
    }
  }
  if (candidates.length > 0) return { found: true, source: candidates[0][0], exp: null, subject: null, kind: 'opaque' };
  return empty;
}

/** 解出 JWT 的 payload；不是 JWT 或解不出来都返回 null（凭证不一定是 JWT）。 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const base = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base + '='.repeat((4 - (base.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function redactValue(flag, value) {
  if (flag === '-u' || flag === '--user' || flag === '--proxy') return '（含凭证，已丢弃）';
  return truncate(String(value), 30);
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * @typedef {object} RequestSpec
 * @property {string} method
 * @property {string} url
 * @property {Record<string, string>} headers
 * @property {string|null} body
 */
