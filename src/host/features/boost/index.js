// src/host/features/boost/index.js
//
// 「电脑加速与清理」功能的 Host 装配。
//
// 这里只做接线：
//   catalog.js   工具链目录（运行时发现：装了什么、缓存在哪、官方怎么清）
//   dshself.js   DSH 自己的可清理面（会话 / 归档 / 回收站 / 投影缓存 / 附件）
//   processes.js 进程与窗口（内存大户 / CPU 大户 / 非活跃窗口 / 孤儿子进程）
//   probe.js     机器事实（磁盘 / 内存 / 交换 / 负载 / 进程，只读）
//   analyze.js   诊断（模型分析，规则兜底）
//   execute.js   执行器（在用即跳过、白名单、超时、审计日志）
//   ops.js      门面（面板与 Agent 工具共用）
//   server.js   浏览器入口的路由声明
//   tool.js     Agent 入口（system_boost 工具）
//
// ⚠️ 别在这里读 ctx.config：cordis 的 ctx 代理只放行 inject 里声明过的属性，
// 读 ctx.config 会直接抛错。配置从 apply 的参数进来。

import { homedir } from 'node:os';
import { createOps } from './ops.js';
import { createRouteSpecs } from './server.js';
import { createBoostTool } from './tool.js';

/** 稳定标识。 */
export const id = 'boost';

/**
 * 该功能的路由前缀（挂在共享前缀之后）。
 *
 * ⚠️ 路由路径必须全局唯一（webserver 的 register 对重复路径直接 throw），
 * 所以这里必须与客户端 src/client/shared/constants.js 的 BOOST_ENDPOINT
 * 拼出来的路径一致：<shared.base>/boost。
 */
export const routePrefix = 'boost';

/**
 * 装配「电脑加速与清理」功能。
 *
 * @param {object} ctx 插件上下文。
 * @param {object} featureConfig config.boost 那一段（analysis / timeoutMs）。
 * @param {object} shared 共享上下文（base / allowRemote / routes() / registerRoutes()）。
 */
export function apply(ctx, featureConfig = {}, shared) {
  const config = featureConfig !== null && typeof featureConfig === 'object' ? featureConfig : {};
  const analysis = config.analysis ?? {};
  const base = `${shared.base}/${routePrefix}`;

  const ops = createOps({
    home: homedir(),
    env: process.env,
    platform: process.platform,
    llm: () => ctx.get('llm') ?? null,
    // 正在跑的会话：它们的日志还在被追加，清理时必须跳过。
    // 把会话从 DSH 的归档清单里摘掉（归档集合是注册表里的内存状态，改文件
    // 会被 DSH 下一次写回覆盖 —— 走官方的 unarchiveSession）。
    unarchiveSession: async (sessionId) => {
      try {
        const registry = ctx.get('workspaceRegistry');
        if (registry === undefined || registry === null) return false;
        await registry.unarchiveSession(sessionId);
        return true;
      } catch {
        return false;
      }
    },
    liveSessionIds: () => {
      try {
        const registry = ctx.get('agents');
        if (registry === undefined || registry === null) return [];
        return registry.list().map((agent) => agent.id);
      } catch {
        return [];
      }
    },
    analysis: {
      provider: typeof analysis.provider === 'string' ? analysis.provider : '',
      model: typeof analysis.model === 'string' ? analysis.model : '',
      maxOutputTokens: typeof analysis.maxOutputTokens === 'number' ? analysis.maxOutputTokens : undefined,
    },
  });

  // 浏览器入口。webServer 由 web 组合提供；没有它（例如纯 CLI 组合）时
  // 这块整体不生效，工具仍然可用。
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const routes = shared.routes(createRouteSpecs(ops, base));
      return shared.registerRoutes(host, routes);
    }, 'dsh-usage-aggregator: boost http routes');
  });

  // Agent 入口。清理会删用户磁盘上的缓存，要求 danger-full-access ——
  // 和官方 plugin_manager 工具同一档要求。没有 sandboxPolicy 服务时不做限制。
  ctx.tools.register(createBoostTool(ops, {
    assertPrivileged: (exec) => {
      const policy = ctx.get('sandboxPolicy');
      if (policy === undefined || policy === null) return;
      const resolved = policy.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session });
      if (resolved.mode !== 'danger-full-access') {
        throw new Error('清理缓存会删除用户磁盘上的文件，需要 danger-full-access 权限；也可以在网页右下角的小火箭里操作。');
      }
    },
  }));
}
