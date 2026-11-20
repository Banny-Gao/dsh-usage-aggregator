// src/host/features/dingtalk/index.js
//
// 「钉钉沙发」功能的 Host 装配。
//
// 这里只做接线：
//   dws.js       官方 CLI 的包装（业务调用走这里）
//   install.js   环境自检与依赖安装（缺 dws 就装上；只做装 / 问版本 / 问登录态）
//   shapes.js    把 CLI 的 JSON 变成插件要的字段
//   relevance.js 粗筛：这条消息跟当前项目有没有关系（纯函数）
//   context.js   从会话里取项目上下文（分支 / 需求号 / 最近进展）
//   store.js     开关与轮询间隔的落盘
//   ops.js       操作层：解析收件人 / 发送 / 回查 / 读消息
//   card.js      动作卡片类型（发 / 改稿）
//   skill.js     随包附带的技能（模型什么时候该提议外发）
//   receiver.js  收消息的那一半（拉取 → 粗筛 → 注入分析）
//   tool.js      两个 Agent 工具（读消息 / 找收件人）
//   server.js    浏览器入口的路由声明
//
// ⚠️ 三个服务都是**可选注入**：actionCards（卡片）与 skills（技能）来自
// profile 里的个性化推荐 bundle，agents 是会话注册表。缺任何一个都不该让
// 插件 entry 永远 pending —— 缺了就少一块能力，其余照常。

import { createSendKind, userMessage } from './card.js';
import { createContextReader } from './context.js';
import { createOps } from './ops.js';
import { createReceiver } from './receiver.js';
import { createRouteSpecs } from './server.js';
import { createSkillProvider } from './skill.js';
import { createFindTool, createReadTool } from './tool.js';

/** 稳定标识。 */
export const id = 'dingtalk';

/** 该功能路由相对公共前缀的一段（/dsh-usage-aggregator/dingtalk）。 */
export const routePrefix = 'dingtalk';

/**
 * 装配「钉钉沙发」功能。
 *
 * @param {object} ctx 插件上下文。
 * @param {object} featureConfig config.dingtalk 那一段。
 * @param {object} shared 共享上下文（base / allowRemote / routes() / registerRoutes()）。
 */
export function apply(ctx, featureConfig = {}, shared) {
  const config = featureConfig !== null && typeof featureConfig === 'object' ? featureConfig : {};
  const base = `${shared.base}/${routePrefix}`;

  const ops = createOps({ env: process.env });
  const contextReader = createContextReader();

  /** 可选服务：卡片 / 技能 / 会话注册表。 */
  let cards = null;
  let skills = null;
  let agents = null;

  /** 功能开关（用户自己在设置页里拨）。 */
  let enabled = false;
  /** 当前注册着的东西（卡片类型 / 技能 / 工具）。关功能时逐个退掉。 */
  let registrations = [];
  /** 轮询定时器。 */
  let timer = null;
  /** 接收器（用到才建）。 */
  let receiver = null;
  /** 插件是否已经卸载（卸载后不要再异步注册东西）。 */
  let closed = false;

  /**
   * 取接收器。
   *
   * @returns {object} 接收器。
   */
  function receiverOf() {
    if (receiver === null) {
      receiver = createReceiver({
        ops,
        agents: { roots: () => (agents === null ? [] : agents.roots()) },
        contextReader,
        inject: async (agent, text) => {
          agent.followup(await userMessage(text));
        },
        log: (message) => console.log('[dsh-usage-aggregator/dingtalk] ' + message),
      });
    }
    return receiver;
  }

  /**
   * 退掉所有注册。
   */
  function clearRegistrations() {
    for (const dispose of registrations) {
      try {
        dispose();
      } catch {
        /* 已经失效 */
      }
    }
    registrations = [];
  }

  /**
   * 注册这一块能力（卡片类型 / 技能 / 工具）。
   */
  function registerAll() {
    clearRegistrations();
    if (cards !== null) {
      registrations.push(cards.register(createSendKind({ ops, cards })));
    }
    if (skills !== null) {
      registrations.push(skills.registerProvider(() => createSkillProvider()));
    }
    registrations.push(ctx.tools.register(createReadTool({ ops })));
    registrations.push(ctx.tools.register(createFindTool({ ops })));
  }

  /**
   * 停掉轮询。
   */
  function stopTimer() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  /**
   * 起轮询（后台拉钉钉消息）。
   */
  async function startTimer() {
    stopTimer();
    const settings = await ops.settings(config.enabled === true);
    const seconds = settings.pollIntervalSeconds;
    timer = setInterval(() => {
      void receiverOf().poll();
    }, seconds * 1000);
    // 定时器不该拖住进程（插件停掉时进程要能退）。
    if (typeof timer.unref === 'function') timer.unref();
    // 立刻拉一次做**基线**：把「打开功能之前就存在的消息」认下来，
    // 免得三分钟后第一次轮询把它们当成新消息一屏分析。
    void receiverOf().poll().catch(() => {});
    console.log(`[dsh-usage-aggregator/dingtalk] 已开启：每 ${seconds} 秒拉一次钉钉消息`);
  }

  /**
   * 打开功能。
   *
   * 缺 dws 就自动装：用户拨开这个开关，就等于授权为这块功能准备依赖
   * （装的是官方 CLI，不碰登录态）。
   */
  async function enable() {
    if (enabled) return;
    enabled = true;
    registerAll();
    await startTimer();
    void ops.ensureInstalled().catch(() => {});
  }

  /**
   * 关掉功能（退掉注册、停轮询；未读计数保留，用户还能在面板上看到）。
   */
  async function disable() {
    if (enabled === false) return;
    enabled = false;
    clearRegistrations();
    stopTimer();
  }

  // 可选服务：卡片类型注册表（个性化推荐 bundle 提供）。
  // ⚠️ inject 的回调收到的是 **scope**，被注入的服务挂在 scope 的属性上。
  ctx.inject(['actionCards'], (scope) => {
    cards = scope.actionCards;
    if (enabled) registerAll();
  });

  // 可选服务：技能注册表（模型加载技能才看得见 propose_action）。
  ctx.inject(['skills'], (scope) => {
    skills = scope.skills;
    if (enabled) registerAll();
  });

  // 可选服务：会话注册表（接收侧要知道往哪个会话注入）。
  ctx.inject(['agents'], (scope) => {
    agents = scope.agents;
  });

  // 会话活动：用来挑「最近活跃的那个会话」。
  ctx.on('agent/created', (payload) => {
    if (payload?.agent !== undefined) receiverOf().markActive(payload.agent.id);
  });
  ctx.on('agent/status', (payload) => {
    if (payload?.status === 'running' && payload?.agent !== undefined) receiverOf().markActive(payload.agent.id);
  });

  // 浏览器入口（设置页的那一个页签）。
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const controller = {
        async status() {
          const settings = await ops.settings(config.enabled === true);
          const availability = await ops.availability();
          const state = receiverOf().status();
          return { ok: true, enabled, settings, availability, install: ops.installState(), ...state };
        },
        async saveSettings(body) {
          const result = await ops.saveSettings(body);
          if (result.settings.enabled) await enable();
          else await disable();
          return result;
        },
        async install() {
          return ops.startInstall();
        },
        async pollNow() {
          if (enabled === false) return { ok: false, error: '功能没开' };
          const result = await receiverOf().poll();
          return { ok: result.ok, count: result.count, relevant: result.relevant, error: result.error };
        },
      };
      const routes = shared.routes(createRouteSpecs({ controller, base }));
      return shared.registerRoutes(host, routes);
    }, 'dsh-usage-aggregator: dingtalk http routes');
  });

  // 读一次开关：用户之前打开过就直接接着用。
  ctx.effect(() => {
    let alive = true;
    void (async () => {
      const settings = await ops.settings(config.enabled === true);
      if (alive === false || closed) return;
      if (settings.enabled) await enable();
    })();
    return () => {
      alive = false;
      closed = true;
      clearRegistrations();
      stopTimer();
    };
  }, 'dsh-usage-aggregator: dingtalk feature');
}
