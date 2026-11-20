// src/host/features/dingtalk/server.js
//
// 浏览器侧入口：同源 HTTP 路由的声明层。
//
// 三条路由：
//   GET  <base>/settings        —— 读设置与状态（面板初始化）
//   POST <base>/settings/save   —— 保存设置（开关、轮询间隔）
//   POST <base>/poll            —— 手动拉一次钉钉消息
//   POST <base>/install         —— 启动一次 dws 安装（缺依赖时自动补装）
//
// 传输层（限流、JSON 解析、状态码语义、同源校验）走共享实现
// （src/host/shared/http.js）；这里只负责**这一段路径**与**这一组操作**的对应。

/** 该功能在公共前缀下的那一段（/dsh-usage-aggregator/dingtalk）。 */
export const ROUTE_PREFIX = 'dingtalk';

/**
 * 生成路由声明表。
 *
 * @param {{controller: object, base: string}} options 控制器与本功能的路由前缀。
 * @returns {Array<{method: 'GET'|'POST', path: string, run: Function}>} 路由声明。
 */
export function createRouteSpecs(options) {
  const controller = options.controller;
  const prefix = typeof options.base === 'string' ? options.base.replace(/\/+$/, '') : '';

  return [
    { method: 'GET', path: `${prefix}/settings`, run: () => controller.status() },
    { method: 'POST', path: `${prefix}/settings/save`, run: (body) => controller.saveSettings(body) },
    { method: 'POST', path: `${prefix}/poll`, run: () => controller.pollNow() },
    { method: 'POST', path: `${prefix}/install`, run: () => controller.install() },
  ];
}
