// src/client/features/autocomplete/api.js
//
// 与 Host 半边的四条路由一一对应。
//
// 路径前缀走共享常量（/dsh-usage-aggregator/autocomplete）—— 客户端 bundle 在
// 浏览器里独立加载，读不到 Host 的 config，前缀只能两边各写一份。

import { callApi } from '../../shared/api.js';
import { AUTOCOMPLETE_ENDPOINT } from '../../shared/constants.js';

export const api = {
  /** 读设置。 */
  settings: function () { return callApi('GET', AUTOCOMPLETE_ENDPOINT + '/settings'); },
  /** 保存设置（只传要改的字段）。 */
  saveSettings: function (patch) { return callApi('POST', AUTOCOMPLETE_ENDPOINT + '/settings/save', patch); },
  /** 可用的 provider / model 清单。 */
  models: function () { return callApi('GET', AUTOCOMPLETE_ENDPOINT + '/models'); },
  /**
   * 要候选。
   *
   * @param {{sessionId: string, draft: string, context: Array<object>, limit: number}} payload 请求体。
   * @returns {Promise<object>} { ok, suggestions, source }。
   */
  suggest: function (payload) { return callApi('POST', AUTOCOMPLETE_ENDPOINT + '/suggest', payload); },
};
