// src/host/features/expander/index.js
//
// 「插件更新」功能的 Host 装配（聚合体的三块能力之一）。
//
// 这里只做接线，每块能力各自住在自己的模块里：
//   registry.js   版本比较 + 依赖 spec 解析（纯函数）
//   lockfile.js   从 pnpm-lock.yaml 读出 git 依赖钉住的提交
//   proc.js       跑 pnpm view / git ls-remote
//   ops.js        检测 + 更新（面板与 Agent 工具共用的同一份实现）
//   server.js     浏览器入口的路由声明（同源 HTTP 路由）
//   tool.js       Agent 入口（plugin_update 工具）
//
// 已装清单与安装动作都复用官方插件管理器（ctx.pluginManager），本功能不自己
// 碰 pnpm add / pnpm remove —— 官方管理器才有那把 profile 写锁、失败回滚、
// HMR 重载和构建脚本审批。
//
// inject 里只写**必然存在**的服务：多写一个不存在的服务会让 entry 永远
// pending（整页 Failed to load plugins）。webServer / pluginManager / profileContext
// 都走可选注入。
//
// ⚠️ 别在这里读 ctx.config：cordis 的 ctx 代理只放行 inject 里声明过的属性，
// 读 ctx.config 会直接抛错。配置从 apply 的参数进来。

import { createOps } from './ops.js';
import { createRouteSpecs } from './server.js';
import { createUpdaterTool } from './tool.js';

/** 稳定标识。 */
export const id = 'expander';

/**
 * 该功能的路由前缀（挂在共享前缀之后）。
 *
 * ⚠️ 路由路径必须全局唯一（webserver 的 register 对重复路径直接 throw），
 * 所以这里必须与客户端 src/client/shared/constants.js 的 EXPANDER_ENDPOINT
 * 拼出来的路径一致：<shared.base>/expander。
 */
export const routePrefix = 'expander';

/**
 * 装配「插件更新」功能。
 *
 * @param {object} ctx 插件上下文。
 * @param {object} featureConfig config.expander 那一段（checkTimeoutMs / gitTimeoutMs）。
 * @param {object} shared 共享上下文（base / allowRemote / routes() / registerRoutes()）。
 */
export function apply(ctx, featureConfig = {}, shared) {
  const config = featureConfig !== null && typeof featureConfig === 'object' ? featureConfig : {};

  // 本功能的路由前缀：共享前缀 + 一段功能前缀。
  // （endpoint 与 allowRemote 不在这里读 —— 它们归共享内核管：
  //   endpoint    → shared.base（默认 /dsh-usage-aggregator）
  //   allowRemote → shared.allowRemote（默认 false）
  // 见 src/host/shared/context.js 的 resolveBase / createShared。）
  const base = `${shared.base}/${routePrefix}`;

  // profile 目录：pnpm 必须在 profile 目录里跑，才能用上 profile 自己的
  // .npmrc、锁文件与认证；锁文件也在这里。profileContext 由启动器注入，
  // 可能比本插件晚一步到位，所以这里用取值器而不是一次性取值。
  let profile = null;
  ctx.inject(['profileContext'], (host) => {
    profile = host.profileContext;
  });

  /**
   * 当前 profile 的目录。
   *
   * @returns {string} 目录路径。
   */
  const getProfileDir = () => profile?.dir ?? process.env.DSH_PROFILE_DIR ?? process.cwd();

  /**
   * 当前 profile 用的 pnpm 可执行文件。
   *
   * @returns {{command: string, args: string[]}} pnpm 调用方式。
   */
  const getPnpm = () => ({
    command: profile?.packageManager?.command ?? 'pnpm',
    args: [...(profile?.packageManager?.args ?? [])],
  });

  let manager = null;
  const ops = createOps({
    getManager: () => manager,
    getProfileDir,
    getPnpm,
    checkTimeoutMs: typeof config.checkTimeoutMs === 'number' ? config.checkTimeoutMs : undefined,
    gitTimeoutMs: typeof config.gitTimeoutMs === 'number' ? config.gitTimeoutMs : undefined,
  });

  // 官方插件管理器：已装清单（listBundles）与安装动作（remove/install）都走它。
  ctx.inject(['pluginManager'], (host) => {
    manager = host.pluginManager;
  });

  // 浏览器入口。webServer 由 web 组合提供；没有它（例如纯 CLI 组合）时
  // 这块整体不生效，工具仍然可用。
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const routes = shared.routes(createRouteSpecs(ops, base));
      return shared.registerRoutes(host, routes);
    }, 'dsh-usage-aggregator: expander http routes');
  });

  // Agent 入口。更新会改动整个 profile 的已装插件，所以要求 danger-full-access
  // —— 和官方 plugin_manager 工具同一档要求。没有 sandboxPolicy 服务时不做限制
  // （纯 CLI 组合没有会话，也没有沙箱这回事）。
  ctx.tools.register(createUpdaterTool(ops, {
    assertPrivileged: (exec) => {
      const policy = ctx.get('sandboxPolicy');
      if (policy === undefined || policy === null) return;
      const resolved = policy.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session });
      if (resolved.mode !== 'danger-full-access') {
        throw new Error('更新插件会改动整个 profile 的已装插件，需要 danger-full-access 权限；也可以在网页「插件 → 更新」里操作。');
      }
    },
  }));
}
