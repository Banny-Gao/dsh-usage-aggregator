// src/host/features/autocomplete/server.js
//
// 浏览器侧入口：同源 HTTP 路由的声明层。
//
// 四条路由：
//   GET  <base>/settings        —— 读设置（面板初始化 + 客户端启动时读一次）
//   POST <base>/settings/save   —— 保存设置
//   GET  <base>/models          —— 可用的 provider / model 清单（模型选择器用）
//   POST <base>/suggest         —— 给候选（客户端打字停顿后调用）
//
// ⚠️ 同一个路径不能挂两条路由：webserver 的 register() 以路径为键，重复注册
// 直接 throw。读设置与存设置因此分成两条路径（settings / settings/save）。
//
// 传输层（限流、JSON 解析、状态码语义、同源校验）走共享实现
// （src/host/shared/http.js）；这里只负责**这一段路径**与**这一组操作**的对应。

/** 该功能在公共前缀下的那一段（/dsh-usage-aggregator/autocomplete）。 */
export const ROUTE_PREFIX = 'autocomplete';

/**
 * 生成路由声明表。
 *
 * @param {{ops: object, base: string}} options 操作层与本功能的路由前缀。
 * @returns {Array<{method: 'GET'|'POST', path: string, run: Function}>} 路由声明。
 */
export function createRouteSpecs(options) {
  const ops = options.ops;
  const prefix = typeof options.base === 'string' ? options.base.replace(/\/+$/, '') : '';

  const suggest = (body) => ops.suggest({
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
    draft: typeof body.draft === 'string' ? body.draft : '',
    context: Array.isArray(body.context) ? body.context : [],
    limit: Number.isFinite(body.limit) ? body.limit : undefined,
  });

  const saveSettings = (body) => ops.saveSettings(body);

  return [
    { method: 'GET', path: `${prefix}/settings`, run: () => ops.settings() },
    { method: 'POST', path: `${prefix}/settings/save`, run: saveSettings },
    { method: 'GET', path: `${prefix}/models`, run: () => ops.listModels() },
    { method: 'POST', path: `${prefix}/suggest`, run: suggest },
  ];
}
