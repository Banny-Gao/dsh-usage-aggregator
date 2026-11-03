// src/client/features/autocomplete/index.js
//
// 「AI 自动补全」功能在聚合插件里的入口。
//
// 这里是**功能契约**的实现（见 ARCHITECTURE.md §5.1）：
//   meta         { id, namespace, hubOrder, hubTabKey }
//   dictionaries { zh, en }
//   apply(ctx, t)
//   HubView(props)
//
// 两个落点（都是官方的会话输入框槽位）：
//   · conversation.input.dock    —— 输入框上方的提示条（空输入时的占位提示 +
//                                  打字时的第一条建议 + 打开下拉列表的按钮）
//   · conversation.input.overlay —— 下拉列表 + 行内灰字（浮在输入框卡片里）
//
// **不动别人的节点与样式**：官方 placeholder 由 ui-conversation 拥有，插件
// 不去改它；编辑器的草稿由官方输入机持有，插件只通过 inputActions 读写。
//
// ⚠️ 模块顶层不要调用 h(...)：共享 runtime 的 React 要等聚合入口的 factory 里
//   installRuntime(require) 之后才就绪。顶层只声明函数与常量。

import { h } from '../../runtime.js';
import { NS, zh, en } from './i18n.js';
import { AutocompleteDock } from './dock.js';
import { AutocompleteOverlay } from './overlay.js';
import { AutocompletePanel, modelOptions } from './panel.js';

/**
 * 功能元信息。
 *
 * namespace 'pcAutocomplete' —— 新功能，取一个不会与别的包撞的名字。
 * hubOrder 50 —— 聚合页里排第五（主题 10 / 用量 20 / 插件更新 30 / 加速 40）。
 * hubTabKey 'tabAutocomplete' —— 页签标签在聚合页自己的字典里。
 */
export const meta = { id: 'autocomplete', namespace: NS, hubOrder: 50, hubTabKey: 'tabAutocomplete' };

/** 完整字典。聚合入口拿它注册 locale 命名空间。 */
export const dictionaries = { zh, en };

/**
 * 装配本功能。
 *
 * @param {object} ctx 插件上下文。
 * @param {Function} t 本功能命名空间的 translator。
 */
export function apply(ctx, t) {
  const translator = typeof t === 'function' ? t : (key) => (zh[key] !== undefined ? zh[key] : key);

  // 输入框上方的提示条。
  //
  // conversation.input.dock 是 list 槽（会话级），给一个自己的 id 就是多一格，
  // 不影响别人的格子。
  ctx.slots.inject('conversation.input.dock', function () {
    return ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'axzo-autocomplete-bar',
      order: 20,
      locale: NS,
    }, function (slotProps) {
      const props = slotProps !== undefined && slotProps !== null ? slotProps : {};
      return h(AutocompleteDock, {
        t: translator,
        sessionId: typeof props.sessionId === 'string' ? props.sessionId : '',
        useInput: props.useInput,
        inputActions: props.inputActions,
      });
    });
  });

  // 下拉列表与行内灰字：浮在输入框卡片里（官方 / 、@ 菜单走的就是这一层）。
  ctx.slots.inject('conversation.input.overlay', function () {
    return ctx.slots.register({
      name: 'conversation.input.overlay',
      id: 'axzo-autocomplete',
      order: 20,
      locale: NS,
    }, function (slotProps) {
      const props = slotProps !== undefined && slotProps !== null ? slotProps : {};
      return h(AutocompleteOverlay, {
        t: translator,
        sessionId: typeof props.sessionId === 'string' ? props.sessionId : '',
        useInput: props.useInput,
        inputActions: props.inputActions,
        useChat: props.useChat,
      });
    });
  });
}

/**
 * 聚合设置页里本功能的视图。
 *
 * @param {{t: Function}} props 属性。
 * @returns {object} React 元素。
 */
export const HubView = (props) => h(AutocompletePanel, props);

/**
 * 离线渲染自检用（scripts/ui-check-autocomplete.mjs）：把组件暴露出来，好在没有
 * 浏览器的环境里用 react-dom/server 真渲染一遍，抓「组件一渲染就崩」这类只在
 * 页面上才暴露的问题。运行时不受影响。
 */
export const __ui = {
  AutocompleteDock: AutocompleteDock,
  AutocompleteOverlay: AutocompleteOverlay,
  AutocompletePanel: AutocompletePanel,
  modelOptions: modelOptions,
  zh: zh,
  en: en,
};
