// src/host/features/index.js
//
// Host 半边的功能登记表。
//
// 新增一个功能 = 在这里加一行 + 建一个 features/<id>/ 目录。
// 每个功能模块必须导出：
//
//   id           —— 稳定标识，勿改
//   routePrefix  —— 该功能路由相对公共前缀的一段（/dsh-usage-aggregator/<prefix>）
//   apply(ctx, featureConfig, shared)
//                —— 装配：注册 HTTP 路由、注册 Agent 工具、起定时器。
//                   featureConfig 是 config[id] 那一段；
//                   shared 提供 base / allowRemote / routes() / registerRoutes()。
//
// 没有 Host 行为的功能（比如主题）也要在这里占一行，apply 留空 ——
// 让「这个插件有哪几块能力」在一处就能看全。

import * as theme from './theme/index.js';
import * as usage from './usage/index.js';
import * as expander from './expander/index.js';
import * as boost from './boost/index.js';
import * as autocomplete from './autocomplete/index.js';

/** 全部 Host 功能。 */
export const features = [theme, usage, expander, boost, autocomplete];
