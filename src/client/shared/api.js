// src/client/shared/api.js
//
// 同源 HTTP 封装。
//
// 客户端 bundle 与 Host 是两套独立加载的代码，路由是最小的跨半边契约 ——
// 一半是 path，一半是 fetch，没有类型生成、没有协议升级要跟。

/**
 * 发一次同源请求并解析 JSON。
 *
 * @param {'GET'|'POST'} method 方法。
 * @param {string} path 路径（同源）。
 * @param {unknown} body 请求体（POST 时序列化）。
 * @returns {Promise<any>} 解析后的 JSON。
 */
export function callApi(method, path, body) {
  const options = { method: method, cache: 'no-store', headers: { accept: 'application/json' } };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  return fetch(path, options).then(function (response) {
    return response.text().then(function (text) {
      let parsed = null;
      try {
        parsed = text === '' ? {} : JSON.parse(text);
      } catch (err) {
        // 路由还没注册（Host 侧代码更新后没重启进程）时，请求会落到 SPA 兜底上，
        // 返回一段 HTML —— 这里把它翻成「你该做什么」，而不是丢一句解析失败。
        const looksHtml = /^\s*<(!doctype|html)/i.test(text);
        if (looksHtml || response.status === 404 || response.status === 405) {
          throw new Error('Host 侧路由不可用：插件已更新但进程还没重启，重启 dsh web 后再试');
        }
        throw new Error('返回不是 JSON：' + text.slice(0, 160));
      }
      if (parsed !== null && parsed.ok === false && typeof parsed.error === 'string') throw new Error(parsed.error);
      if (!response.ok) throw new Error('HTTP ' + response.status + (parsed !== null && parsed.error ? '：' + parsed.error : ''));
      return parsed;
    });
  });
}
