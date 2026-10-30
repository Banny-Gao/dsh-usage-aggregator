// src/host/shared/http.js
//
// 共用的同源 HTTP 传输层。
//
// 为什么用路由而不是 Remote（typert/@Remote）：客户端 bundle 与 Host 是两套独立
// 加载的代码，路由是最小的跨半边契约 —— 一半是 path，一半是 fetch，没有类型
// 生成、没有协议升级要跟。
//
// ⚠️ 路由路径必须**全局唯一**：dsh-host-webserver 的 register() 以
// (kind, path) 为键，重复注册会直接 throw —— 那会让插件 entry 加载失败，
// 整页报 "Failed to load plugins"。三个功能因此各自挂一段前缀
// （/dsh-usage-aggregator/usage、/dsh-usage-aggregator/expander）。

/** 默认请求体上限：1MB（只传 JSON 的接口够用）。 */
export const BODY_LIMIT_DEFAULT = 1024 * 1024;

/** 用量查询要传截图（base64），请求体上限放宽到 12MB。 */
export const BODY_LIMIT_WITH_IMAGE = 12 * 1024 * 1024;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * 请求是不是来自本机。
 *
 * @param {object} req 请求。
 * @returns {boolean} 是否回环地址。
 */
export function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return LOOPBACK.has(address);
}

/**
 * 请求是不是同源。
 *
 * webServer 注册的路由没有鉴权钩子（浏览器页面本身有 DSH 的 token 保护），
 * 所以一个恶意网页可以用「简单请求」让浏览器替它打这个地址：跨站 POST 不带
 * Origin 校验的话，本机就会替它装插件。这里比对 Origin 的 host 与请求的 Host：
 * 跨站请求的 Origin 是外站，必然对不上。同源请求（浏览器同源 GET 有时甚至不带
 * Origin）放行。
 *
 * @param {object} req 请求。
 * @returns {boolean} 是否同源。
 */
export function isSameOrigin(req) {
  const origin = req.headers?.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  const host = req.headers?.host;
  if (typeof host !== 'string' || host === '') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * 请求体是不是声明了 JSON。
 *
 * 带 application/json 的跨站请求会先走 CORS 预检，我们不回 CORS 头，预检就
 * 失败 —— 这是第二道防线，和上面的 Origin 校验一起用。
 *
 * @param {object} req 请求。
 * @returns {boolean} 是否是 JSON 请求。
 */
export function isJsonRequest(req) {
  const type = req.headers?.['content-type'];
  return typeof type === 'string' && type.toLowerCase().includes('application/json');
}

/**
 * 回一个 JSON 响应。
 *
 * @param {object} res 响应。
 * @param {number} status HTTP 状态码。
 * @param {unknown} payload 响应体。
 */
export function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 读取请求体（JSON）。超限或解析失败都以明确的 4xx 返回。
 *
 * @param {object} req 请求。
 * @param {number} bodyLimit 上限字节数。
 * @returns {Promise<{ok: boolean, status?: number, value?: object, error?: string}>} 读取结果。
 */
export function readJson(req, bodyLimit) {
  const limit = bodyLimit ?? BODY_LIMIT_DEFAULT;
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve({ ok: false, status: 413, error: `请求体过大（>${Math.round(limit / 1024 / 1024)}MB）` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolve({ ok: true, value: {} });
        return;
      }
      try {
        const value = JSON.parse(text);
        resolve({ ok: true, value: value !== null && typeof value === 'object' ? value : {} });
      } catch {
        resolve({ ok: false, status: 400, error: '请求体不是合法 JSON' });
      }
    });
    req.on('error', (error) => resolve({ ok: false, status: 400, error: `读取请求体失败：${error.message}` }));
  });
}

/**
 * 生成路由表。
 *
 * 三个功能共用这一份实现，语义与迁移前完全一致：
 *   · GET  一律 200（即便返回体里 ok===false，客户端自己判断）；
 *   · POST 返回体 ok===false 时给 400，否则 200；
 *   · 处理器抛异常一律 500 {ok:false,error}。
 *
 * @param {Array<{method: 'GET'|'POST', path: string, run: Function}>} specs 路由声明。
 * @param {{allowRemote?: boolean, bodyLimit?: number}} options 选项。
 * @returns {Array<{path: string, handler: (req: object, res: object) => Promise<void>}>} 路由表。
 */
export function buildRoutes(specs, options = {}) {
  const allowRemote = options.allowRemote === true;
  const bodyLimit = options.bodyLimit ?? BODY_LIMIT_DEFAULT;

  const guard = (req, res) => {
    if (!allowRemote && !isLoopback(req)) {
      send(res, 403, { ok: false, error: '这些接口会读到你的登录态并替它发请求，只允许本机访问（allowRemote 未开启）' });
      return false;
    }
    if (!isSameOrigin(req)) {
      send(res, 403, { ok: false, error: '跨站请求不接受' });
      return false;
    }
    return true;
  };

  const get = (path, run) => ({
    path,
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      try {
        const result = await run(req);
        send(res, 200, result);
      } catch (error) {
        send(res, 500, { ok: false, error: `${error?.message ?? String(error)}` });
      }
    },
  });

  const json = (path, run) => ({
    path,
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      if (!isJsonRequest(req)) {
        send(res, 415, { ok: false, error: '只接受 application/json 请求' });
        return;
      }
      const parsed = await readJson(req, bodyLimit);
      if (!parsed.ok) {
        send(res, parsed.status, { ok: false, error: parsed.error });
        return;
      }
      try {
        const result = await run(parsed.value, req);
        send(res, result !== null && result.ok === false ? 400 : 200, result);
      } catch (error) {
        send(res, 500, { ok: false, error: `${error?.message ?? String(error)}` });
      }
    },
  });

  return specs.map((spec) => (spec.method === 'GET' ? get(spec.path, spec.run) : json(spec.path, spec.run)));
}
