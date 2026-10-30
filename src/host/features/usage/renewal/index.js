// src/host/features/usage/renewal/index.js
//
// 自动续期：让「每天重贴一次 cURL」这件事变成「过期前自己换一枚 token」。
//
// 分层刻意做得很薄：
//   renewal/index.js    —— 分发：认站点、换 token、拼回请求
//   renewal/dingtalk.js —— 钉钉 OAuth 的具体走法
//   cdp.js              —— 驱动一个带持久化 profile 的 Chrome
//
// 核心不变式只有一条：**续期只换凭证，不碰别的**。原请求的 URL、方法、请求头模板
// 原样保留，只把 authorization 里的 token 换掉。接口没变，缓存的展示模板继续用，
// 因此续期不花一次模型调用 —— 这也是它比「重新导入」轻得多的地方。

import { join } from 'node:path';

import { defaultProfileDir } from '../cdp.js';
import { listProfiles, matchProfile, renewDingtalk } from './dingtalk.js';

// 刻意**不**从 store.js 取数据目录：store.js 需要用 describeRenewal() 标注面板可见
// 的字段，从这里 import 回去就成环了。数据目录由调用方（ops / CLI）传进来 ——
// 反向依赖永远是更好的方向。

export { listProfiles };

/**
 * 一条记录能不能自动续期。
 *
 * @param {object} record store 里的完整记录。
 * @returns {{profile: object, renew: Function}|null}
 */
export function renewalFor(record) {
  const profile = matchProfile(record);
  if (profile === null) return null;
  return { profile, renew: renewDingtalk };
}

/** 对外描述：面板用它决定要不要显示「自动续期」按钮。凭证本身永远不出这里。 */
export function describeRenewal(record) {
  const found = renewalFor(record);
  if (found === null) return { supported: false };
  return {
    supported: true,
    id: found.profile.id,
    title: found.profile.title,
    // 必须人工点一次同意的站点：面板上给按钮，不进自动续期的调度队列。
    interactiveOnly: found.profile.interactiveOnly === true,
  };
}

/** 这条记录能不能**无人值守**续期（决定要不要进自动续期队列）。 */
export function canRenewSilently(record) {
  const found = renewalFor(record);
  return found !== null && found.profile.interactiveOnly !== true;
}

/**
 * 把新 token 拼回原请求。
 *
 * 只改 authorization 一处；Bearer 前缀沿用原来的写法（大写 Bearer / 小写 bearer 都
 * 见过），其余请求头一个字节都不动 —— 包括那些 sec-ch-ua 之类的浏览器指纹头，
 * 它们是「这台浏览器访问这个站点」的事实，换掉反而更像机器人。
 *
 * @param {object} request 原请求描述。
 * @param {string} token 新 token。
 * @returns {object} 新的请求描述。
 */
export function applyToken(request, token) {
  const headers = { ...(request?.headers ?? {}) };
  const previous = String(headers.authorization ?? '');
  const prefix = /^Bearer\b/i.test(previous) ? previous.slice(0, previous.indexOf(' ') + 1) : 'Bearer ';
  headers.authorization = `${prefix}${token}`;
  return { ...request, headers };
}

/**
 * 给一条记录续期。
 *
 * @param {{record: object, appDir: string, interactive?: boolean, onLog?: (text: string) => void}} args
 * @returns {Promise<{ok: boolean, request?: object, message?: string, mode?: string, needsInteraction?: boolean, unsupported?: boolean}>}
 */
export async function renewRecord(args) {
  const found = renewalFor(args.record);
  if (found === null) {
    return { ok: false, unsupported: true, message: '这个接口不在自动续期的支持范围内 —— 请重新粘贴一次请求' };
  }
  const profileDir = defaultProfileDir(args.appDir, found.profile.id);
  const result = await found.renew({
    record: args.record,
    profile: found.profile,
    interactive: args.interactive === true,
    profileDir,
    onLog: args.onLog,
  });
  if (result.ok !== true) return result;
  return {
    ok: true,
    mode: result.mode,
    message: result.mode === 'silent' ? '已静默换到新登录态' : '已授权并换到新登录态',
    request: applyToken(args.record.request, result.token),
  };
}

/** Chrome profile 目录（CLI 与面板提示用户「删掉它就得重新授权」时要用）。 */
export function profileDirFor(id, appDir) {
  return join(defaultProfileDir(appDir, id));
}
