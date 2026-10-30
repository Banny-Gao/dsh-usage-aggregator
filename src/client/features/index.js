// src/client/features/index.js
//
// 客户端功能登记表。
//
// 新增一个功能 = 在这里加一行 + 建一个 features/<id>/ 目录。
// 每个功能模块必须导出：
//
//   meta         { id, namespace, hubOrder }
//                · id        —— 稳定标识，勿改
//                · namespace —— locale 命名空间，**保持各功能原值不变**
//                                （改名会让已注册的名字空间与新名字空间并存）
//                · hubOrder  —— 聚合页里的页签顺序
//   dictionaries { zh, en }
//                —— 完整的中英文字典，必须包含 `hubTab` 键（聚合页的页签标签）
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
