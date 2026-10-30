// src/client/features/usage/index.js
//
// 「用量查询」功能的装配入口（对应源插件的 14-assembly.js）。
//
// 源插件里这是一个 `return { inject, __ui, apply }` 的工厂返回值 —— 它依赖「所有片段
// 拼进同一个 factory 作用域」这件事。现在整包走 Vite + 真 ESM，共享作用域没了，
// 于是这里改成**具名导出**，并按聚合插件的功能契约导出四个东西：
//
//   meta         { id, namespace, hubOrder, hubTabKey }
//   dictionaries { zh, en }
//   apply(ctx, t)
//   HubView(props)
//
// ⚠️ 模块顶层**不要调用 h(...)**：React 要等聚合入口的 installRuntime(require) 之后
// 才就绪（原来靠拼接时 `var h = React.createElement` 在 factory 里执行，位置不同了）。
// 顶层只声明函数与常量。

import { h } from '../../runtime.js';
import { zh, en } from './i18n.js';
import { NS, PANEL_ID } from './constants.js';
import { PanelShell } from './styles.js';
import { UsageChip, QuickPopover, QuickProvider } from './quick.js';
import { Panel } from './panel.js';
import { ProviderDetail } from './provider.js';
import { ImportPanel } from './import-panel.js';
import { AnalysisModelPicker } from './model-picker.js';
import { UsageView, MetricBlock, CardGrid, ImageDrop } from './atoms.js';
import { FieldOrderEditor, fieldRows, moveItem } from './field-order.js';
import { pickChipProvider, isInsideRect, isInsideUnion, createHoverLiveness, UsageIcon } from './hover.js';
import { clipText } from './format.js';

/**
 * 功能元信息。
 *
 * namespace 保持 'usage-query'（改名会让新旧命名空间并存）。
 * hubTabKey 'tabUsage' —— 聚合页里本功能页签的标签键，标签文案在聚合页自己的
 * 字典里（src/client/hub/i18n.js）。不放在本功能的命名空间下，是因为同一个
 * 命名空间同时只能被一个包注册 —— 新旧插件并存时本功能探不到自己的字典，
 * 页签上会显示裸的 key 名。
 */
export const meta = { id: 'usage', namespace: 'usage-query', hubOrder: 20, hubTabKey: 'tabUsage' };

/** 完整字典。 */
export const dictionaries = { zh, en };

/**
 * 装配本功能。
 *
 * 只装**本功能自己的**槽位：
 *   · 会话头右侧的紧凑入口：芯片 + 浮层，能看数也能直接刷新。
 *   · ~~settings.section~~ —— **刻意不注册**：设置面板的入口由聚合页统一声明
 *     （见 src/client/hub/panel.js），这正是「一个插件一个设置入口」的落点。
 *   · ~~ctx.locale.register(NS, …)~~ —— **刻意不注册**：聚合入口统一注册各功能的
 *     命名空间（见 src/client/index.js），字典在这里以 dictionaries 导出。
 *
 * @param {object} ctx 插件上下文。
 * @param {Function} t 本功能命名空间的 translator。
 */
export function apply(ctx, t) {
  ctx.slots.inject('conversation.session.header.utilities', function () {
    return ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: PANEL_ID,
      order: 30,
      label: t('tab'),
      locale: NS,
      inject: function () { return { t: t }; }
    }, function (slotProps) { return h(UsageChip, slotProps); });
  });
}

/**
 * 聚合设置页里本功能的视图。
 *
 * 渲染原来的 PanelShell（= <Styles/> + <Panel/>）—— **每个挂载点各渲染一份 <Styles/>**
 * 是刻意保留的设计：会话头芯片住在设置面板之外，样式必须跟着组件走，
 * 否则裸 DOM 会撑开页面。
 *
 * @param {{t: Function, ctx: object}} props 属性。
 * @returns {object} React 元素。
 */
export function HubView(props) {
  return h(PanelShell, { t: props.t, ctx: props.ctx });
}

/**
 * 离线渲染自检用（scripts/render-check.mjs）：把面板内部组件暴露出来，好在没有
 * 浏览器的环境里用 react-dom/server 真渲染一遍，抓「组件一渲染就崩」这类
 * 只在页面上才暴露的问题。运行时不受影响（聚合入口只认 apply / meta / …）。
 */
export const __ui = {
  Panel: Panel,
  PanelShell: PanelShell,
  ProviderDetail: ProviderDetail,
  ImportPanel: ImportPanel,
  UsageView: UsageView,
  MetricBlock: MetricBlock,
  CardGrid: CardGrid,
  ImageDrop: ImageDrop,
  AnalysisModelPicker: AnalysisModelPicker,
  pickChipProvider: pickChipProvider,
  clipText: clipText,
  FieldOrderEditor: FieldOrderEditor,
  fieldRows: fieldRows,
  moveItem: moveItem,
  UsageChip: UsageChip,
  QuickPopover: QuickPopover,
  QuickProvider: QuickProvider,
  isInsideRect: isInsideRect,
  isInsideUnion: isInsideUnion,
  createHoverLiveness: createHoverLiveness,
  UsageIcon: UsageIcon,
  zh: zh,
  en: en,
};
