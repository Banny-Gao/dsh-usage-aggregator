// src/client/features/dingtalk/api.js
//
// 与 Host 半边的四条路由一一对应。
//
// 路径前缀走共享常量（/dsh-usage-aggregator/dingtalk）—— 客户端 bundle 在
// 浏览器里独立加载，读不到 Host 的 config，前缀只能两边各写一份。

import { callApi } from '../../shared/api.js';
import { DINGTALK_ENDPOINT } from '../../shared/constants.js';

export const api = {
  /** 读设置与状态。 */
  status: function () { return callApi('GET', DINGTALK_ENDPOINT + '/settings'); },
  /** 保存设置（只传要改的字段）。 */
  saveSettings: function (patch) { return callApi('POST', DINGTALK_ENDPOINT + '/settings/save', patch); },
  /** 手动拉一次钉钉消息。 */
  poll: function () { return callApi('POST', DINGTALK_ENDPOINT + '/poll', {}); },
  /** 启动一次 dws 安装（后台跑，进度靠 status 轮询）。 */
  install: function () { return callApi('POST', DINGTALK_ENDPOINT + '/install', {}); },
};
