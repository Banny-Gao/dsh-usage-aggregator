// src/host/index.js
//
// Host 半边：装配。
//
// 这里只做接线 —— 每块能力各自住在自己的模块里：
//   features/usage/*      用量查询：重放请求 / 调模型生成展示模板 / 落盘 /
//                         自动查询 / 自动续期 / HTTP 路由 / usage_query 工具
//   features/expander/*   插件更新：查版本 / 判状态 / 装更新 / HTTP 路由 /
//                         plugin_update 工具
//   features/theme/*      品牌主题：Host 侧是空座位（全部视觉在客户端）
//
// inject 里只写**必然存在**的服务：多写一个不存在的服务会让 entry 永远
// pending（整页 Failed to load plugins）。webServer / llm / attachments /
// pluginManager / profileContext 都走可选注入或在调用时按需解析。

import { createShared } from './shared/context.js';
import { features } from './features/index.js';

/** 插件名。必须与 package.json 的 name 一致。 */
export const name = 'dsh-usage-aggregator';

/** 工具注册需要 tools；其余服务按需解析。 */
export const inject = ['tools'];

/**
 * 装配 Host 半边。
 *
 * @param {object} ctx 插件上下文。
 * @param {object} config 本行在 cordis.patch.yml 里的配置。
 */
export function apply(ctx, config = {}) {
  const shared = createShared(config);
  for (const feature of features) {
    feature.apply(ctx, shared.configOf(feature.id), shared);
  }
}
