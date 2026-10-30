// src/client/shared/constants.js
//
// 客户端与 Host 之间唯一的「路径契约」。
//
// ⚠️ 这里必须与 cordis.patch.yml 里的 config.endpoint 保持一致。
// 客户端 bundle 在浏览器里独立加载，读不到 Host 的 config，所以这个前缀只能
// 两边各写一份 —— 但**只写这一处**：改前缀只改这个文件 + patch 一处。
//
// 三段路由：
//   /dsh-usage-aggregator/usage/*      —— 用量查询
//   /dsh-usage-aggregator/expander/*   —— 插件更新
// 主题功能没有 Host 路由（它的可调项走 localStorage）。

/** 所有插件路由的公共前缀。 */
export const ENDPOINT_BASE = '/dsh-usage-aggregator';

/** 用量查询的路由前缀。 */
export const USAGE_ENDPOINT = ENDPOINT_BASE + '/usage';

/** 插件更新的路由前缀。 */
export const EXPANDER_ENDPOINT = ENDPOINT_BASE + '/expander';
