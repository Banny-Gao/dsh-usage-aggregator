// src/host/features/autocomplete/index.js
//
// 「AI 自动补全」功能的 Host 装配。
//
// 这里只做接线：
//   settings.js  设置的默认值与归一化（纯函数）
//   store.js     用户偏好的落盘（$DSH_HOME/dsh-usage-aggregator/autocomplete.json）
//   analyze.js   候选分析（模型出文本，解析与清洗在这里）
//   ops.js       门面：设置读写 / 模型清单 / 给建议（含缓存与掐掉旧请求）
//   server.js    浏览器入口的路由声明
//
// ⚠️ 别在这里读 ctx.config：cordis 的 ctx 代理只放行 inject 里声明过的属性，
// 读 ctx.config 会直接抛错。配置从 apply 的参数进来。

import { createOps } from './ops.js';
import { createRouteSpecs } from './server.js';
import { defaultsFromConfig } from './settings.js';

/** 稳定标识。 */
export const id = 'autocomplete';

/**
 * 该功能的路由前缀（挂在共享前缀之后）。
 *
 * ⚠️ 路由路径必须全局唯一（webserver 的 register 对重复路径直接 throw），
 * 所以这里必须与客户端 src/client/shared/constants.js 的 AUTOCOMPLETE_ENDPOINT
 * 拼出来的路径一致：<shared.base>/autocomplete。
 */
export const routePrefix = 'autocomplete';

/**
 * 装配「AI 自动补全」功能。
 *
 * @param {object} ctx 插件上下文。
 * @param {object} featureConfig config.autocomplete 那一段（analysis / defaults）。
 * @param {object} shared 共享上下文（base / allowRemote / routes() / registerRoutes()）。
 */
export function apply(ctx, featureConfig = {}, shared) {
  const config = featureConfig !== null && typeof featureConfig === 'object' ? featureConfig : {};
  const analysis = config.analysis !== null && typeof config.analysis === 'object' ? config.analysis : {};
  const base = `${shared.base}/${routePrefix}`;

  const ops = createOps({
    env: process.env,
    llm: () => ctx.get('llm') ?? null,
    defaults: defaultsFromConfig(config),
    maxOutputTokens: typeof analysis.maxOutputTokens === 'number' ? analysis.maxOutputTokens : undefined,
  });

  // 浏览器入口。webServer 由 web 组合提供；没有它（例如纯 CLI 组合）时
  // 这块整体不生效 —— 补全是浏览器里的能力，没有浏览器就没有补全。
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const routes = shared.routes(createRouteSpecs({ ops: ops, base: base }));
      return shared.registerRoutes(host, routes);
    }, 'dsh-usage-aggregator: autocomplete http routes');
  });
}
