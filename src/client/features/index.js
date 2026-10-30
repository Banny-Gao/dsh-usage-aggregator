// src/client/features/index.js
//
// 客户端功能登记表。
//
// 新增一个功能 = 在这里加一行 + 建一个 features/<id>/ 目录。
// 每个功能模块必须导出：
//
//   meta         { id, namespace, hubOrder, hubTabKey, hubDefault }
//                · id        —— 稳定标识，勿改
//                · namespace —— locale 命名空间，**保持各功能原值不变**
//                                （改名会让已注册的名字空间与新名字空间并存）
//                · hubOrder  —— 聚合页里的页签顺序
//                · hubTabKey —— 聚合页里本功能页签的标签键。标签文案在**聚合页
//                                自己的**字典里（src/client/hub/i18n.js），不在本功能
//                                的命名空间下 —— 同一个命名空间同时只能被一个包注册，
//                                新旧插件并存时本功能探不到自己的字典，页签上会显示
//                                裸的 key 名（这个坑踩过）
//                · hubDefault—— true 表示这一页是聚合页**默认选中**的页签
//   dictionaries { zh, en }
//                —— 完整的中英文字典（页签标签不在这里，见上）
//   apply(ctx, t)
//                —— 装配本功能：注册自己的槽位（**不要**注册 settings.section，
//                   那是聚合页的事）、自己的 effect、自己的定时器
//   HubView(props)
//                —— 聚合页里渲染的视图；props = { t, ctx }
//
// ⚠️ 模块顶层不要调用 h(...)：runtime 的 React 要等 factory 里的
// installRuntime(require) 之后才就绪。顶层只声明函数与常量。

import * as theme from './theme/index.js';
import * as usage from './usage/index.js';
import * as expander from './expander/index.js';

/** 全部客户端功能。顺序不影响渲染，页签顺序由 meta.hubOrder 决定。 */
export const features = [theme, usage, expander];
