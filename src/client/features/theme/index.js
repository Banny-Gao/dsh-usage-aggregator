// src/client/features/theme/index.js
//
// 主题功能（dsh-axzo-theme 的客户端半边）在聚合插件里的入口。
//
// 这里是**功能契约**的实现。src/client/features/index.js 登记本模块，
// 聚合入口（src/client/index.js）按契约调用：
//
//   meta         { id, namespace, hubOrder }   —— 功能标识
//   dictionaries { zh, en }                    —— 完整字典（含 hubTab）
//   apply(ctx, t)                             —— 装配本功能自己的槽位与 effect
//   HubView(props)                            —— 聚合设置页里渲染的视图（props = { t, ctx }）
//
// 与旧插件的对应关系：
//   旧 src/index.js   → 本文件（不再调 window.__ModuleLoader__.load）
//   旧 src/plugin.js  → 本文件的 apply(ctx, t)
//   旧 src/runtime.js → **删掉**，改用共享的 src/client/runtime.js
//
// ⚠️ 迁移时**刻意没改**的东西（都是对外可见的既有契约）：
//   · localStorage key：dsh-axzo-theme:primary / :fx / :brand
//   · locale 命名空间：settings.axzoTheme
//   · 43 个主题 token 名 + 17 个 --dsh-axzo-* CSS 变量名
//   · 槽位 id / priority / order
//   · overrideTokens 的 source：dsh-axzo-theme
//   逐条对照见同目录 MIGRATION.md。
//
// ⚠️ 模块顶层不要调用 h(...)：共享 runtime 的 React 要等聚合入口的 factory 里
//   installRuntime(require) 之后才就绪。顶层只声明函数与常量。

import { SidebarDecorHost } from './assets.js';
import { BrandMark, BrandName } from './brand-mark.js';
import { NS, PLUGIN_ID, STYLE_ID } from './constants.js';
import { BackdropHost, HeroBrandMark } from './hero.js';
import { en, makeTranslator, zh } from './i18n.js';
import { osTintMax, startOsPrefs, stopOsPrefs } from './os-prefs.js';
import { Panel } from './panel.js';
import { getPrefs, subscribePrefs } from './prefs.js';
import { h } from '../../runtime.js';
import { applyGlobalStyle } from './styles.js';
import { TASK, startTaskWatch } from './tasks.js';
import { releaseBrandTokens, setBrandTokens } from './tokens.js';


/* ─────────────────────────── 功能契约 ──────────────────────────── */

/**
 * 功能标识。
 *
 * namespace 保持 settings.axzoTheme —— 改名会让新旧命名空间并存
 * （locale 服务按命名空间存字典，旧的不注销就一直占着）。
 * hubOrder 10 —— 聚合页里排第一个（主题是聚合插件的原主角）。
 */
export const meta = { id: 'theme', namespace: NS, hubOrder: 10 };

/**
 * 完整字典。聚合入口拿它注册 locale 命名空间
 * （src/client/index.js → ctx.locale.register(feature.meta.namespace, feature.dictionaries)）。
 * 必须含 hubTab —— 聚合页的页签标签取自它。
 */
export const dictionaries = { zh, en };


/**
 * 命名空间是否已被注册。
 *
 * locale 服务的 register 对同一个 (命名空间, 语言) 再注册会直接抛错
 * （"locale namespace ... already has locale ..."）。聚合入口已经用
 * feature.dictionaries 注册过本命名空间，所以这里必须先探一下。
 *
 * 探测用一个**只属于本字典**的 key（sectionPreset）：命名空间没注册时，
 * locale.translate 回落成 key 本身；common 命名空间里没有这个 key。
 *
 * @param {object} locale locale 服务。
 * @param {string} ns 命名空间。
 * @returns {boolean} 是否已注册。
 */
function namespaceRegistered(locale, ns) {
  try {
    const probe = locale.bind(ns)('sectionPreset');
    return typeof probe === 'string' && probe !== 'sectionPreset';
  } catch (err) {
    return false;
  }
}


/**
 * 装配本功能。
 *
 * 只装配**本功能自己的**槽位与 effect。settings.section 由聚合页统一注册
 * （src/client/hub/panel.js），这里**不要**再注册一份 —— 那正是本次聚合
 * 要消除的「一个插件一个设置入口」。
 *
 * @param {object} ctx 插件上下文。
 * @param {(key: string, vars?: object) => string} t 本功能命名空间的 translator。
 */
export function apply(ctx, t) {
  // 0. OS 偏好监听（prefers-reduced-motion / prefers-contrast）。
  //    旧实现在模块顶层注册这 3 条 matchMedia 监听、**没有 disposer** ——
  //    插件被反复 apply 时监听会越积越多（既有隐患）。现在监听有了明确的
  //    生命周期：apply 时补注册（幂等），effect cleanup 时摘掉。
  //    osFlagOverrides() / osTintMax() 的 API 与行为不变。
  ctx.effect(function () {
    startOsPrefs();
    return function () { stopOsPrefs(); };
  }, PLUGIN_ID + ": os prefs");

  // 1. 常驻 token 覆盖层：强调色 + 表面染色。
  //    所有权在这里，设置面板只负责换色，不负责回收。
  //    取值写在 effect 体内：cordis 会在依赖服务变动时重跑 effect，
  //    闭包住加载时的快照的话，重跑就会把用户后来选的颜色打回旧值。
  if (ctx.theme) {
    ctx.effect(function () {
      // 订阅 store：换主色 / 改染色浓度立刻重算覆盖层，面板不需要碰 token。
      // tint 在传给 deriveTokens 之前再过一次 OS 偏好上限
      // （prefers-contrast: more → 染色浓度最多 40，否则表面染色会盖掉对比度）。
      // 用户的 flags.tint 原值不动 —— 面板里还显示 70，只是渲染时被压到 40。
      var applyTokens = function () {
        var live = getPrefs();
        var tintMax = osTintMax();
        var tintForTokens = live.flags.tint > tintMax ? tintMax : live.flags.tint;
        setBrandTokens(ctx, live.primary, tintForTokens, live.flags.sbClear);
      };
      applyTokens();
      var unsubscribe = subscribePrefs(applyTokens);
      return function () { unsubscribe(); releaseBrandTokens(); };
    }, PLUGIN_ID + ": token overlay");
  } else {
    console.warn("[" + PLUGIN_ID + "] ctx.theme 不可用，主题色不会生效");
  }

  // 2. 品牌位。
  //    sidebar.brand.* 是 kind:"single" 槽，dsh-client-ui-brand-official 已在
  //    priority 0 占了；single 槽按 priority 升序取第一个渲染，所以用 -1 压过它。
  var BRAND_PRIORITY = -1;
  ctx.slots.inject("sidebar.brand.mark", function () {
    return ctx.slots.inject("sidebar.brand.name", function* () {
      yield ctx.slots.register({ name: "sidebar.brand.mark", priority: BRAND_PRIORITY }, BrandMark);
      yield ctx.slots.register({ name: "sidebar.brand.name", priority: BRAND_PRIORITY }, BrandName);
    });
  });

  // 首屏玻璃舞台 —— **可开关，且关掉时必须真的让出槽位**。
  // 只是「不渲染」是不够的：单值槽只有最低 priority 那一个会渲染，我们让不出去，
  // 官方品牌就永远回不来，结果是官方标语配着我们的舞台（就是这个 bug）。
  // slots.inject 返回的是幂等 disposer，且「销毁后再声明会重跑」，
  // 所以这里可以随开关反复注入 / 撤销。
  var heroInject = null;
  var disposeHeroSlot = function () {
    if (heroInject === null) return;
    var dispose = heroInject;
    heroInject = null;
    try { dispose(); } catch (err) { /* 已失效 */ }
  };
  var syncHeroSlot = function () {
    if (getPrefs().flags.hero) {
      if (heroInject !== null) return;
      try {
        heroInject = ctx.slots.inject("conversation.hero.brand.mark", function () {
          return ctx.slots.register(
            { name: "conversation.hero.brand.mark", priority: BRAND_PRIORITY }, HeroBrandMark);
        });
      } catch (err) {
        heroInject = null;
        console.warn("[" + PLUGIN_ID + "] 首屏槽注册失败", err);
      }
    } else {
      disposeHeroSlot();
    }
  };
  ctx.effect(function () {
    syncHeroSlot();
    var unsubscribe = subscribePrefs(syncHeroSlot);
    return function () {
      unsubscribe();
      disposeHeroSlot();
    };
  }, PLUGIN_ID + ": hero slot");

  // 会话主区的品牌背景宿主。挂在这个 slot 只是因为它是「始终挂载」的 ——
  // 组件自身渲染 null，真正的产出是那个 portal。
  ctx.slots.inject("sidebar.footer.action", function () {
    return ctx.slots.register({ name: "sidebar.footer.action", id: "axzo-backdrop", order: 900 }, BackdropHost);
  });

  // 侧栏质感宿主：自身只渲染一个不可见探针，真正的作用是把 data-axzo-sidebar
  // 打到侧栏根节点上（侧栏根的类名带构建哈希，只能运行时认）。
  ctx.slots.inject("sidebar.footer.action", function () {
    return ctx.slots.register({ name: "sidebar.footer.action", id: "axzo-sidebar", order: 901 }, SidebarDecorHost);
  });

  // 3. 全局样式（表面染色之外的氛围光 / 舞台 / 流光）
  ctx.effect(function () {
    var lastFlags = null;
    var lastFont = null;
    var applyStyle = function () {
      var live = getPrefs();
      // 主色变了不必重建 CSS；只有开关与品牌字体影响它。
      // 只认 font 而不是整个 brand：否则每敲一个品牌名字符都会重建一次。
      if (live.flags === lastFlags && live.brand.font === lastFont) return;
      lastFlags = live.flags;
      lastFont = live.brand.font;
      applyGlobalStyle(live.flags, live.brand);
    };
    applyStyle();
    var unsubscribe = subscribePrefs(applyStyle);
    return function () {
      unsubscribe();
      var tag = document.getElementById(STYLE_ID);
      if (tag !== null) tag.remove();
    };
  }, PLUGIN_ID + ": global style");

  // 4. 字典（先注册再取 translator）。
  //    ⚠️ 聚合入口已经用 feature.dictionaries 注册过本命名空间了
  //    （src/client/index.js），locale 服务对同一个 (命名空间, 语言) 重复注册
  //    会直接抛错。所以这里**只在还没注册时**补注册：
  //      · 被聚合入口装配时 → 跳过，不会重复注册、也不会误 dispose 掉别人的注册；
  //      · 本功能被单独使用时 → 仍然自洽地注册自己的字典。
  ctx.effect(function () {
    if (namespaceRegistered(ctx.locale, NS)) return undefined;
    var dispose = null;
    try { dispose = ctx.locale.register(NS, dictionaries); }
    catch (err) { console.warn("[" + PLUGIN_ID + "] locale register failed", err); }
    return function () { if (typeof dispose === "function") dispose(); };
  }, PLUGIN_ID + ": locale");

  // translator：优先用聚合入口传进来的（它已经绑定到本命名空间），
  // 拿不到时退回本功能自己的 makeTranslator（独立装配时用得上）。
  var translator = typeof t === "function" ? t : makeTranslator(ctx.locale);
  TASK.t = translator;

  // 5. 任务状态（**可选注入**）。
  //    用 ctx.inject 而不是写进 inject 数组：这是「有则更好」的能力，
  //    服务缺失时只是这段不生效，不会让插件永远 pending
  //    —— 那会让整页报 Failed to load plugins（这个坑踩过一次）。
  ctx.inject(["sessions"], function (scope) {
    return startTaskWatch(scope.sessions);
  });

  // ⚠️ 旧实现在这里注册 settings.section（id 'axzo-theme'、order 93）——
  //    **已删除**：聚合设置页（src/client/hub/panel.js）统一注册入口，
  //    本功能只通过 HubView 提供视图内容。
}


/**
 * 聚合设置页里本功能的视图。
 *
 * 聚合页用 h(View, { t, ctx }) 渲染，而原 Panel 收到的正是 { t, ctx } ——
 * 原样透传即可。
 */
export const HubView = (props) => h(Panel, props);
