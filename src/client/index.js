// src/client/index.js
//
// 客户端插件的入口 —— 也就是 Vite 的构建入口（见 vite/config.mjs 的
// build.lib.entry）。
//
// 只做一件事：按 DSH 的 __ModuleLoader__ 契约注册插件。
//   · id      —— 必须与 package.json 的 name 一致，DSH 用它把 bundle 与插件行对上；
//   · factory —— DSH 在需要时才调用，参数是宿主注入的 require。
//
// 这里同时是**客户端半边的装配根**：注册三个功能的 locale 命名空间、各自的槽位，
// 最后注册那一个聚合设置页。新增功能只需在 features/index.js 加一行。

import { installRuntime } from './runtime.js';
import { features } from './features/index.js';
import { makeTranslator } from './shared/i18n.js';
import { registerHub } from './hub/panel.js';

/** 插件 id。必须与 package.json 的 name 一致。 */
export const PLUGIN_ID = 'dsh-usage-aggregator';

/**
 * 客户端产物的构建时间（本地时间 YYYY-MM-DD HH:mm:ss）。
 *
 * 由 vite 的 define 注入。页面上显示它，是为了回答「我改了代码，怎么没生效」——
 * 看到旧时间戳就知道进程里的还是旧产物。
 */
export const BUILD_AT = typeof __BUILD_AT__ === 'string' ? __BUILD_AT__ : '';

/**
 * 声明要等的服务。
 *
 * ⚠️ 只写**必然存在**的服务：多写一个不存在的服务会让 entry 永远 pending
 * （整页 Failed to load plugins）。
 *   · slots —— 三个功能都要注册槽位
 *   · locale —— 三个功能都要注册字典
 *   · theme —— 主题功能要覆盖主题 token
 * `sessions` 之类可有可无的服务走 ctx.inject(['sessions'], cb) 的**可选注入**。
 */
export const inject = ['slots', 'locale', 'theme'];

/**
 * 装配。
 *
 * @param {object} ctx 插件上下文。
 */
export function apply(ctx) {
  // 1. 先注册各功能的命名空间，**再**取 translator。
  //    顺序反了的话 translator 探不到命名空间，会退回内置字典，
  //    之后切换语言也不跟随。
  const disposers = [];
  for (const feature of features) {
    try {
      const dispose = ctx.locale.register(feature.meta.namespace, feature.dictionaries);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (err) {
      // 命名空间已被占用（例如 HMR 后残留）：不阻断插件，退回内置字典。
      console.warn('[' + PLUGIN_ID + '] locale register failed: ' + feature.meta.namespace, err);
    }
  }
  ctx.effect(
    function () {
      return function () {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch (err) {
            /* 已失效 */
          }
        }
      };
    },
    PLUGIN_ID + ': locale',
  );

  // 2. 每个功能拿到自己的 translator。
  const registry = features.map((feature) => ({
    feature: feature,
    t: makeTranslator(ctx.locale, feature.meta.namespace, feature.dictionaries.zh),
  }));

  // 3. 各功能装配自己的槽位。
  for (const entry of registry) {
    entry.feature.apply(ctx, entry.t);
  }

  // 4. 聚合设置页（整个插件在设置面板里只占这一个入口）。
  registerHub(ctx, registry, { buildAt: BUILD_AT });
}

window.__ModuleLoader__.load({
  id: PLUGIN_ID,
  factory: function (require) {
    installRuntime(require);
    var module = { exports: {} };
    module.exports.apply = apply;
    module.exports.inject = inject;
    module.exports.PLUGIN_ID = PLUGIN_ID;
    module.exports.BUILD_AT = BUILD_AT;
    return module.exports;
  },
});
