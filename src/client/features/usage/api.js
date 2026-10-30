// src/client/features/usage/api.js
//
// 与 Host 的 11 条路由一一对应（对应源插件的 03-api.js）。
//
// callApi 现在来自 ../../shared/api.js（三个功能共用一份同源 HTTP 封装），
// 路由前缀来自 ../../shared/constants.js 的 USAGE_ENDPOINT ——
// **不再**像旧插件那样在客户端硬写 '/dsh-usage-query'。
//
// ⚠️ 11 个方法 / 11 条路由，改动时必须成对：少一个就是「界面上少一个功能」。

import { callApi } from '../../shared/api.js';
import { USAGE_ENDPOINT } from '../../shared/constants.js';

/**
 * 用量查询的全部接口。
 *
 * | 方法 | 路由 |
 * | --- | --- |
 * | state | GET  /usage |
 * | importRequest | POST /usage/import |
 * | refresh | POST /usage/refresh |
 * | renew | POST /usage/renew |
 * | reanalyze | POST /usage/reanalyze |
 * | remove | POST /usage/remove |
 * | setFieldOrder | POST /usage/order |
 * | models | GET  /usage/models |
 * | setChip | POST /usage/chip |
 * | setAnalysisModel | POST /usage/analysis-model |
 * | raw | GET  /usage/raw?id=… |
 */
export const api = {
  state: function () { return callApi('GET', USAGE_ENDPOINT); },
  importRequest: function (payload) { return callApi('POST', USAGE_ENDPOINT + '/import', payload); },
  refresh: function (id) { return callApi('POST', USAGE_ENDPOINT + '/refresh', { id: id }); },
  // interactive 会弹出真实浏览器窗口等人扫码，可能要等一两分钟 —— 调用期间按钮必须置灰。
  renew: function (id, interactive) { return callApi('POST', USAGE_ENDPOINT + '/renew', { id: id, interactive: interactive === true }); },
  reanalyze: function (id, image) { return callApi('POST', USAGE_ENDPOINT + '/reanalyze', image === undefined ? { id: id } : { id: id, image: image }); },
  remove: function (id) { return callApi('POST', USAGE_ENDPOINT + '/remove', { id: id }); },
  setFieldOrder: function (id, paths) { return callApi('POST', USAGE_ENDPOINT + '/order', { id: id, paths: paths }); },
  models: function () { return callApi('GET', USAGE_ENDPOINT + '/models'); },
  setChip: function (id) { return callApi('POST', USAGE_ENDPOINT + '/chip', { id: id }); },
  setAnalysisModel: function (providerId, modelId) { return callApi('POST', USAGE_ENDPOINT + '/analysis-model', { provider: providerId, model: modelId }); },
  raw: function (id) { return callApi('GET', USAGE_ENDPOINT + '/raw?id=' + encodeURIComponent(id)); },
};
