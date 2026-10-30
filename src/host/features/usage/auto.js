// src/host/features/usage/auto.js
//
// 自动查询：到点该查哪些接口。
//
// 判定逻辑单独拎成纯函数，理由和 hover 那次一样 —— 「什么时候会真的发请求」这种事
// 必须能被断言（尤其是「别把刚手动查过的接口又立刻查一遍」「登录态过期就别白跑一趟」
// 这两条），而不是靠肉眼看定时器。
//
// 两条刻意的取舍：
//   1. **按每个接口自己的上次查询时间**算是否到点，不是整点全体齐步走。手动刷过一次
//      之后，它的下一次自动查询自然顺延，不会出现「刚点完刷新，5 分钟后一到又打一次」。
//   2. **登录态明确过期的跳过**。JWT 的 exp 是权威的，拿着已经过期的 token 去打接口
//      只会拿回 401，然后让面板上多一条没用的错误提示；等用户重贴凭证即可。

/**
 * 算出现在该自动查询哪些接口。
 *
 * @param {object[]} providers store 里的记录。
 * @param {{now: number, intervalMs: number}} options
 * @returns {string[]} 该查的接口 id（顺序即执行顺序）。
 */
export function dueProviders(providers, options) {
  const now = options.now;
  const intervalMs = options.intervalMs;
  const due = [];
  for (const provider of providers) {
    // 截图来源没有可重放的请求；没有请求的也跳过。
    if (provider.source !== 'curl' || provider.request === null) continue;
    // 登录态已过期：查了也是 401，等用户重贴。
    if (provider.credential !== null && typeof provider.credential.exp === 'number' && provider.credential.exp * 1000 <= now) continue;
    // 从没查过：立刻算到点（接入时其实已经查过一次，这是兜底）。
    if (provider.last === null || typeof provider.last.at !== 'number') {
      due.push(provider.id);
      continue;
    }
    if (now - provider.last.at >= intervalMs) due.push(provider.id);
  }
  return due;
}

/**
 * 一个接口距离下次自动查询还有多久（毫秒）；不会自动查的返回 null。
 *
 * @param {object} provider store 记录。
 * @param {{now: number, intervalMs: number}} options
 * @returns {number|null} 剩余毫秒（已到点为 0）。
 */
export function nextDueIn(provider, options) {
  if (provider.source !== 'curl' || provider.request === null) return null;
  if (provider.credential !== null && typeof provider.credential.exp === 'number' && provider.credential.exp * 1000 <= options.now) return null;
  if (provider.last === null || typeof provider.last.at !== 'number') return 0;
  return Math.max(0, provider.last.at + options.intervalMs - options.now);
}

/**
 * 算出现在该给哪些接口**续期**。
 *
 * 判定独立成纯函数，理由和上面那个一样：什么时候该去开一次浏览器，是最该被断言
 * 的行为 —— 它有个反直觉的失败模式（每分钟试一次，一天拉起 1440 次 Chrome），
 * 靠肉眼看定时器是看不出来的。
 *
 * 三条门槛缺一不可：
 *   1. 有可重放的请求（截图来源没有 token 可换）；
 *   2. 凭证有明确的 exp —— 不知道什么时候过期的东西，不该靠猜去开浏览器；
 *   3. 距离上次尝试过了冷却时间（默认 30 分钟）—— 静默续期失败是常态
 *      （钉钉会话没了、Chrome 起不来），失败了就等用户点一下，别自己刷。
 *
 * @param {object[]} providers store 里的记录。
 * @param {{now: number, leadMs?: number, cooldownMs?: number, supportsRenewal?: (record: object) => boolean}} options
 * @returns {string[]} 该续期的接口 id。
 */
export function dueRenewals(providers, options) {
  const now = options.now;
  const leadMs = typeof options.leadMs === 'number' ? options.leadMs : 1800000;
  const cooldownMs = typeof options.cooldownMs === 'number' ? options.cooldownMs : 1800000;
  const supports = typeof options.supportsRenewal === 'function' ? options.supportsRenewal : () => false;
  const due = [];
  for (const provider of providers) {
    if (provider.source !== 'curl' || provider.request === null) continue;
    const exp = provider.credential?.exp;
    // 没有可读的过期时间就不知道该不该续 —— 宁可等面板报 401 再续。
    if (typeof exp !== 'number') continue;
    if (exp * 1000 - now > leadMs) continue;
    const lastAttempt = provider.renewal?.lastAttemptAt;
    if (typeof lastAttempt === 'number' && now - lastAttempt < cooldownMs) continue;
    if (!supports(provider)) continue;
    due.push(provider.id);
  }
  return due;
}

/** 把间隔规范化：小于 60 秒没有意义（上游会被打），大于 24 小时等于关掉。 */
export function normalizeIntervalSeconds(value, fallbackSeconds = 300) {
  const seconds = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallbackSeconds;
  return Math.min(86400, Math.max(60, seconds));
}
