// src/client/features/boost/index.js
//
// 「电脑加速与清理」功能的客户端半边在聚合插件里的入口。
//
// 这里是**功能契约**的实现（见 ARCHITECTURE.md §5.1）：
//   meta         { id, namespace, hubOrder, hubTabKey }
//   dictionaries { zh, en }
//   apply(ctx, t) —— 装配本功能自己的槽位
//   HubView(props) —— 聚合设置页里渲染的视图
//
// 两个入口，一份体检结果：
//   · 悬浮栏里的小火箭 —— 登记进共享层的 dock（src/client/shared/dock.js），
//     由聚合层渲染成一条窄窄的浮层栏；
//   · 聚合设置页的「加速」页签 —— 同一份清单的整页视图。
//
// ⚠️ 模块顶层不要调用 h(...)：共享 runtime 的 React 要等聚合入口的 factory 里
//   installRuntime(require) 之后才就绪。顶层只声明函数与常量。

import { h } from '../../runtime.js';
import { registerDockEntry } from '../../shared/dock.js';
import { NS, en, zh } from './i18n.js';
import { BoostPanel } from './panel.js';
import { useHandoff } from './view.js';
import { DiagnosisBlock, ItemList } from './parts.js';
import { BOOST_RUNTIME } from './ref.js';
import { BoostEntry } from './widget.js';

/**
 * 功能标识。
 *
 * namespace 'pcBoost' —— 新功能，没有历史包袱，取一个不会与别的包撞的名字。
 * hubOrder 40 —— 聚合页里排第四（主题 10 / 用量 20 / 插件更新 30 / 加速 40）。
 * hubTabKey 'tabBoost' —— 聚合页里本功能页签的标签键，标签文案在聚合页自己的
 * 字典里（src/client/hub/i18n.js）。
 */
export const meta = { id: 'boost', namespace: NS, hubOrder: 40, hubTabKey: 'tabBoost' };

/**
 * 完整字典。聚合入口拿它注册 locale 命名空间。
 */
export const dictionaries = { zh, en };

/**
 * 装配本功能。
 *
 * @param {object} ctx 插件上下文。
 * @param {(key: string, vars?: object) => string} t 本功能命名空间的 translator。
 */
export function apply(ctx, t) {
  const translator = typeof t === 'function' ? t : (key) => (zh[key] !== undefined ? zh[key] : key);

  // 悬浮栏里的小火箭。
  //
  // 登记进共享层的 dock（src/client/shared/dock.js）—— 功能之间零 import，
  // 所以不能自己注册 shell.overlay 槽（那会跟钉钉入口各占一个浮层，凑不成一条栏）。
  //
  // 标准属性（useSessions）由 dock 透传：据此算出「用户当前正在看的那个会话」，
  // 交给 Agent 时消息才会落到用户眼前这个对话里。
  registerDockEntry({
    id: 'axzo-boost',
    order: 30,
    t: translator,
    Component: function (entryProps) {
      return h(BoostEntry, {
        t: translator,
        runtime: BOOST_RUNTIME,
        open: entryProps.open,
        onToggle: entryProps.onToggle,
        onClose: entryProps.onClose,
        slotProps: entryProps.slotProps,
      });
    },
  });

  // 客户端的 sessions 服务（可选注入）：交给 Agent 时要拿会话 scope。
  // 服务缺失不影响别的能力 —— 只是那一下会退回到「面板直接执行」。
  ctx.inject(['sessions'], function (scope) {
    BOOST_RUNTIME.sessions = scope.sessions;
    return function () {
      BOOST_RUNTIME.sessions = null;
    };
  });
}

/**
 * 聚合设置页里本功能的视图。
 *
 * @param {{t: Function}} props 属性。
 * @returns {object} React 元素。
 */
export const HubView = (props) => h(BoostPanel, props);

/**
 * 离线渲染自检用（scripts/ui-check-boost.mjs）：把组件暴露出来，好在没有浏览器的
 * 环境里用 react-dom/server 真渲染一遍，抓「组件一渲染就崩」这类只在页面上
 * 才暴露的问题。运行时不受影响（聚合入口只认 meta / dictionaries / apply / HubView）。
 */
export const __ui = {
  BoostEntry: BoostEntry,
  BoostPanel: BoostPanel,
  DiagnosisBlock: DiagnosisBlock,
  ItemList: ItemList,
  useHandoff: useHandoff,
  zh: zh,
  en: en,
};
