// src/host/features/usage/index.js
//
// 用量查询功能的 Host 半边：装配。
//
// 这里只做接线 —— 每块能力各自住在自己的模块里：
//   curl.js    粘贴请求 → 可重放的请求描述（含凭证过期时间）
//   request.js 真实重放 + ok / expired / error 判定
//   analyze.js 调本地模型：响应 → 展示模板；截图 → 快照
//   template.js 模板校验 + 无模型时的结构兜底
//   resolve.js 模板 + 响应 → 可渲染的 view（确定性，不再调模型）
//   store.js   落盘与脱敏（凭证永不出现在返回给浏览器的字段里）
//   ops.js     对外能力（面板与 Agent 工具共用的同一份实现）
//   server.js  浏览器入口（同源 HTTP 路由）
//   tool.js    Agent 入口（usage_query 工具）
//
// 三段语义刻意不可切碎：
//   · withLock —— 串行锁：每个会改 store 的操作排队执行（面板「全部刷新」是并发
//     发出去的，不锁会互相覆盖）；
//   · effectiveAnalysis() —— 面板选的模型优先于配置默认，且**每次重读 store**、
//     不缓存（面板改完立刻要生效）；
//   · applyResult() —— 只有「模板缺失 / 兜底版本落后 / 结构指纹变了」才重新分析。
//
// 配置从哪来：featureConfig = config.usage 那一段（analysis / autoRefresh /
// renewal / request）；公共前缀与 allowRemote 来自 shared。
//
// ⚠️ 不要读 ctx.config：cordis 的 ctx 代理只放行 inject 里声明过的属性，读
// ctx.config 会直接抛错。配置从 apply 的第二个参数进来。

import { normalizeIntervalSeconds } from './auto.js';
import { createOps } from './ops.js';
import { createRoutes, ROUTE_PREFIX } from './server.js';
import { createUsageTool } from './tool.js';

/** 稳定标识。 */
export const id = 'usage';

/** 该功能路由相对公共前缀的一段（/dsh-usage-aggregator/usage）。 */
export const routePrefix = ROUTE_PREFIX;

/**
 * 装配用量查询的 Host 半边。
 *
 * @param {object} ctx 插件上下文。
 * @param {object} featureConfig 本功能的配置段（config.usage）。
 * @param {object} shared 共享上下文（base / allowRemote / routes / registerRoutes）。
 */
export function apply(ctx, featureConfig, shared) {
  const config = featureConfig ?? {};

  const ops = createOps({
    // deps.config 的内容换成 featureConfig —— ops.js 里读的是 config.analysis /
    // config.request / config.autoRefresh / config.renewal，正好对应这一段。
    config,
    llm: () => ctx.get('llm') ?? null,
    attachments: () => ctx.get('attachments') ?? null,
  });

  // 浏览器入口。webServer 由 web 组合提供；没有它（例如纯 CLI 组合）时
  // 这块整体不生效，工具仍然可用。
  ctx.inject(['webServer'], (host) => {
    host.effect(
      () => shared.registerRoutes(host, createRoutes({ ops, shared })),
      'dsh-usage-aggregator: usage http routes',
    );
  });

  // 自动查询：默认开，每 5 分钟一轮。
  //
  // 每 60 秒「按拍检查一次谁到点了」，而不是每 5 分钟全体齐步走 —— 判定按每个接口
  // 自己的上次查询时间算（见 auto.js），所以刚手动刷过的接口会自动顺延，不会出
  // 现「手动点完 5 分钟后又被打一次」。面板关着也照常工作：这活本来就该在 Host 侧。
  const autoConfig = config.autoRefresh ?? {};
  const autoEnabled = autoConfig.enabled !== false;
  const autoIntervalSeconds = normalizeIntervalSeconds(autoConfig.intervalSeconds, 300);
  if (autoEnabled) {
    ctx.effect(() => {
      let running = false;
      const timer = setInterval(() => {
        // 上一轮还没跑完（例如上游卡住）：这一拍直接跳过，不要堆积请求。
        if (running) return;
        running = true;
        Promise.resolve(ops.refreshDue({ intervalMs: autoIntervalSeconds * 1000 }))
          .then((result) => {
            if (result !== null && result !== undefined && result.due > 0) {
              // 一条都不打、或定时器整个静默死掉时，日志里什么都看不到 —— 这正是
              // 「自动查询到底有没有跑」查起来最费劲的地方。这里留一条可 grep 的痕迹。
              console.log(`[dsh-usage-aggregator/usage] 自动查询：${result.refreshed.filter((item) => item.ok).length}/${result.due} 成功`);
            }
          })
          .catch((error) => {
            // 之前这里被空 catch 吞掉：定时器出问题（配置读不到、store 写不了）时
            // 面板毫无异样，只表现为「数据永远不更新」。至少留一行到 stderr。
            console.error(`[dsh-usage-aggregator/usage] 自动查询失败：${error?.message ?? String(error)}`);
          })
          .then(() => { running = false; });
      }, 60000);
      console.log(`[dsh-usage-aggregator/usage] 自动查询已开启：每 ${autoIntervalSeconds} 秒检查一次（到点才真的请求上游）`);
      return () => clearInterval(timer);
    }, 'dsh-usage-aggregator: usage auto refresh');
  }

  // 对话入口。面板与工具共用同一份 ops，不存在第二套逻辑。
  ctx.effect(
    () => ctx.tools.register(createUsageTool(ops)),
    'dsh-usage-aggregator: usage_query tool',
  );
}
