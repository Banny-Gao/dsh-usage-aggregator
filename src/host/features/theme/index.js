// src/host/features/theme/index.js
//
// 品牌主题的 Host 半边 —— **空座位**。
//
// 主题的全部视觉与行为都在客户端（src/client/features/theme/）：替换侧栏品牌、
// 覆盖 43 个 DSH 主题 token、玻璃首屏、会话区品牌背景。
//
// 为什么保留这个空模块：
//   · features/index.js 是「这个插件有哪几块能力」的唯一清单，
//     少一行就看不出主题也是这个插件的一部分；
//   · 将来主题若需要 Host 侧配置（例如部署方预设主色），这里就是落点，
//     不必再动装配层。
//
// ⚠️ 别在这里读 ctx.config：cordis 的 ctx 代理只放行 inject 里声明过的属性，
// 读 ctx.config 会直接抛错。配置从 apply 的第二个参数进来。

/** 稳定标识。 */
export const id = 'theme';

/**
 * 该功能没有 Host 路由。
 *
 * ⚠️ 路由路径必须全局唯一（webserver 的 register 对重复路径直接 throw），
 * 所以这里不声明前缀。
 */
export const routePrefix = null;

/**
 * Host 侧装配 —— 无行为。
 *
 * @param {object} ctx 插件上下文（未使用）。
 * @param {object} featureConfig 本功能的配置段（未使用）。
 * @param {object} shared 共享上下文（未使用）。
 */
export function apply(ctx, featureConfig, shared) {
  // 故意为空：主题是纯客户端功能。
}
