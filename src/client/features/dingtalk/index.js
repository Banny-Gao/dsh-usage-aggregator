// src/client/features/dingtalk/index.js
//
// 「钉钉沙发」功能的装配入口（客户端半边）。
//
// 按聚合插件的功能契约导出四样东西：
//   meta         { id, namespace, hubOrder, hubTabKey }
//   dictionaries { zh, en }
//   apply(ctx, t)
//   HubView(props)
//
// 只装两处：
//   · 卡片正文 —— 注册到宿主共享的卡片框架里（actionCards 注册表）；
//   · 悬浮栏里的气泡入口 —— 有钉钉待处理的消息就呼吸式闪一下；点开是待处理清单。
//   ~~settings.section~~ —— **刻意不注册**：设置面板的入口由聚合页统一声明。
//
// ⚠️ actionCards 是**可选注入**：宿主没装个性化推荐 bundle 时就没有这个服务，
// 那时这块能力只是没有卡片界面，其余照常（写进硬 inject 会让整页加载失败）。
//
// ⚠️ sessions 也是**可选注入**：点【处理】要把消息投进某个会话，靠它。
// 没有它，徽标照样显示，只是「处理」按钮交不出去（面板里会说明原因）。

import { h } from '../../runtime.js';
import { registerDockEntry } from '../../shared/dock.js';
import { zh, en, NS } from './i18n.js';
import { DingtalkEntry } from './badge.js';
import { DingtalkCardBody, idHint, readDetails } from './card.js';
import { DingtalkPanel } from './panel.js';
import { Styles } from './styles.js';

/** 卡片动作名（与 Host 侧 card.js 里的 ACTION 一致）。 */
export const CARD_ACTION = 'dingtalk.send';

/**
 * 跨组件的一小块共享状态。
 *
 * sessions 服务是**后注入**的（ctx.inject），而徽标可能先渲染 —— 所以渲染时
 * 现读现用，不能在 apply() 里把当时的值捕获进闭包。
 */
const RUNTIME = { sessions: null };

/**
 * 功能元信息。
 *
 * namespace 'pcDingtalk' —— 新功能，没有历史包袱，但规矩一样：定了就不改。
 * hubTabKey 'tabDingtalk' —— 聚合页里本功能页签的标签键，标签文案在聚合页自己的
 * 字典里（src/client/hub/i18n.js）。
 */
export const meta = { id: 'dingtalk', namespace: NS, hubOrder: 60, hubTabKey: 'tabDingtalk' };

/** 完整字典。 */
export const dictionaries = { zh, en };

/**
 * 装配本功能。
 *
 * @param {object} ctx 插件上下文。
 * @param {Function} t 本功能命名空间的 translator。
 */
export function apply(ctx, t) {
  const translator = typeof t === 'function' ? t : (key) => (zh[key] !== undefined ? zh[key] : key);

  // 悬浮栏里的气泡入口：待处理清单。
  //
  // 登记进共享层的 dock（src/client/shared/dock.js）—— 功能之间零 import，
  // 所以不能自己注册 shell.overlay 槽（那会跟小火箭各占一个浮层，凑不成一条栏）。
  //
  // 标准属性（useSessions）由 dock 透传：据此算出「用户当前正在看的那个会话」，
  // 点【处理】才有「处理到当前会话」这一路。
  registerDockEntry({
    id: 'axzo-dingtalk-badge',
    order: 31,
    t: translator,
    Component: function (entryProps) {
      return h(DingtalkEntry, {
        t: translator,
        open: entryProps.open,
        onToggle: entryProps.onToggle,
        onClose: entryProps.onClose,
        slotProps: entryProps.slotProps,
        sessions: RUNTIME.sessions,
      });
    },
  });

  // 客户端的 sessions 服务（可选注入）：点【处理】要把消息投进会话。
  ctx.inject(['sessions'], function (scope) {
    RUNTIME.sessions = scope.sessions;
    return function () {
      RUNTIME.sessions = null;
    };
  });

  // ⚠️ inject 的回调收到的是 **scope**，被注入的服务挂在 scope 的属性上。
  ctx.inject(['actionCards'], (scope) => {
    ctx.effect(() => scope.actionCards.register({
      action: CARD_ACTION,
      locale: NS,
      Body: DingtalkCardBody,
    }), 'dsh-usage-aggregator: dingtalk card body');
  });
}

/**
 * 聚合设置页里本功能的视图。
 *
 * @param {{t: Function, ctx: object}} props 属性。
 * @returns {object} React 元素。
 */
export function HubView(props) {
  return h(DingtalkPanel, { t: props.t });
}

/**
 * 离线渲染自检用（scripts/ui-check-dingtalk.mjs）。
 */
export const __ui = {
  DingtalkCardBody: DingtalkCardBody,
  DingtalkPanel: DingtalkPanel,
  DingtalkEntry: DingtalkEntry,
  Styles: Styles,
  readDetails: readDetails,
  idHint: idHint,
  zh: zh,
  en: en,
};
