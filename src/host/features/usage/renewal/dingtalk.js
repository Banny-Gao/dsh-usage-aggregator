// src/host/features/usage/renewal/dingtalk.js
//
// 钉钉 OAuth 登录态续期。
//
// 解决的问题很具体：AxzoOne 的 JWT 有效期正好 24 小时（exp - iat = 86400），
// 于是每天都要重新去 DevTools 复制一次 cURL。
//
// 关键认知：**token 过期 ≠ 登录态过期**。token 只是钉钉 OAuth 换来的一枚 24 小时
// 通行证；钉钉那边的会话（profile 里的 cookie）可以留很久。所以只要保住一个持久化
// 的浏览器 profile，每天静默重放一次「拿授权地址 → 跳钉钉 → 回调换新 token」就能
// 自己续上，根本不用再碰 DevTools。
//
// 两种模式：
//   · 静默（silent）    —— 无头。已有钉钉会话时零交互直接换到新 token。定时任务用这个。
//   · 交互（interactive）—— 有头窗口。第一次用、或者钉钉会话也过期了才走它，
//                          用户扫一次码 / 点一次「同意」，之后回到静默。
//
// ⚠️ 这里做的只是「代替用户重复他自己已经做过的那次点击」，不碰验证码、不代持密码：
// 需要人的那一步，仍然由人在真实的浏览器窗口里完成。

import { withSession } from '../cdp.js';

/** 从请求里取出 origin，拿不到就 null。 */
function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

/** 是否是 Bearer JWT（决定能不能用「换一枚 token」这条路续期）。 */
function bearerToken(request) {
  const value = request?.headers?.authorization ?? '';
  return /^Bearer\s+\S+/i.test(String(value));
}

/**
 * 已知的站点档案。
 *
 * 为什么要做成「档案」而不是通用爬虫：不同站点的登录入口、回调参数、token 落点都不
 * 一样，猜错一次就会静默地续出一个不能用的 token —— 那比重贴 cURL 更糟。认站点、
 * 把差异写死在明处，猜错的代价是一次显而易见的失败。
 */
const PROFILES = [
  {
    id: 'axzoone',
    title: 'AxzoOne · 钉钉',
    apiBase: 'https://one-api.axzo.cn',
    loginPage: 'https://one.axzo.cn/#/login',
    authorizePath: '/manage/api/v1/auth/dingtalk/url',
    callbackPath: '/manage/api/v1/auth/dingtalk/callback',
    /** 登录页上「使用钉钉登录」那个按钮。找不到就退化成「让用户自己点」。 */
    loginButton: '.dingtalk-btn',
    /** 前端把回调里的 token 落在 localStorage 的这个键上。 */
    tokenKey: 'token',
    // 验活用的接口：必须是「只要登录态就 200」的轻接口。落库前拿它确认这枚 token
    // 此刻真的能用 —— 站点是单会话策略，后一次登录会吊销前一枚，光看 iat/exp 不算数。
    verifyPath: '/manage/api/v1/auth/userinfo',
    // 钉钉的同意页每次授权都会再弹一次（实测：删掉 prompt=consent 也一样），所以
    // 无头静默续期对它**不可能**成功。标记出来，调度器就不会每天白拉起几次 Chrome，
    // 面板改为在需要时给一个按钮 —— 点一下、弹窗、点「同意」。
    interactiveOnly: true,
    matches: (record) => {
      const host = (() => { try { return new URL(record?.request?.url ?? '').host; } catch { return ''; } })();
      return /(^|\.)axzo\.cn$/i.test(host) && bearerToken(record?.request) && /\/manage\/api\/v1\//.test(record?.request?.url ?? '');
    },
  },
];

/**
 * 给一条记录找到续期档案；不认得就返回 null（面板照旧提示重贴 cURL）。
 *
 * @param {object} record store 里的完整记录。
 * @returns {object|null}
 */
export function matchProfile(record) {
  if (record === null || typeof record !== 'object') return null;
  if (record.source !== 'curl' || record.request === null) return null;
  return PROFILES.find((profile) => profile.matches(record)) ?? null;
}

/** 所有档案的对外描述（给面板显示「支持自动续期」）。 */
export function listProfiles() {
  return PROFILES.map((profile) => ({ id: profile.id, title: profile.title }));
}

/** 静默模式的等待上限：够钉钉跳完两三个来回，又不至于卡住定时任务。 */
const SILENT_TIMEOUT_MS = 25000;

/** 交互模式给用户留的时间：扫码 + 点确认，60 秒很宽松。 */
const INTERACTIVE_TIMEOUT_MS = 180000;

/** 轮询间隔。700ms 足够灵敏，也不会把 CPU 拉起来。 */
const POLL_INTERVAL_MS = 700;

/**
 * 向后端要一枚「授权地址」。
 *
 * 这个接口是登录页自己调的，未登录即可访问（实测无需任何凭证）。
 *
 * @param {object} profile 站点档案。
 * @param {{silent: boolean}} options
 * @returns {Promise<URL>} 钉钉授权页地址。
 */
async function fetchAuthorizeUrl(profile, options) {
  const endpoint = new URL(profile.authorizePath, profile.apiBase);
  // 前端传的是当前页地址；后端只拿它做白名单校验，这里给一个稳定的站点首页即可。
  endpoint.searchParams.set('redirect_uri', profile.loginPage);
  const response = await fetch(endpoint, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`取钉钉授权地址失败：HTTP ${response.status}`);
  const payload = await response.json();
  const target = typeof payload?.data === 'string' ? payload.data : typeof payload === 'string' ? payload : null;
  if (target === null) throw new Error(`取钉钉授权地址失败：响应里没有地址（${JSON.stringify(payload).slice(0, 120)}）`);
  const url = new URL(target);
  // **静默续命的关键**：站点给的地址带 prompt=consent，钉钉会每次都弹同意页。
  // 去掉它，已经授权过的用户会被静默放行 —— 这正是「一次扫码，长期免登」的差别。
  if (options.silent) url.searchParams.delete('prompt');
  return url;
}

/**
 * 盯着一枚 token 是否真的能用。
 *
 * **这一步不能省。** AxzoOne 是单会话策略：每次登录都会吊销上一枚会话。实测踩到过
 * 「刚签发就被顶掉」—— token 的 iat/exp 都正常，落库 2 秒后查询就 401 revoked。
 * 只有真的打一次接口问它「你还认这枚吗」，才知道该用哪一枚。
 *
 * @param {object} profile 站点档案。
 * @param {string} token
 * @returns {Promise<boolean>}
 */
async function isTokenLive(profile, token) {
  try {
    const response = await fetch(new URL(profile.verifyPath, profile.apiBase), {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 盯着浏览器，把**所有**出现过的 token 收集起来。
 *
 * 两条来源互相兜底：
 *   1. 回调最终会落到 `/#/login?token=…`，直接看导航过的 URL；
 *   2. 登录页 onMounted 会把 token 写进 localStorage，读它。
 * 前端改版时通常还有另一条活着。
 *
 * 刻意**收集全部**而不是拿到第一枚就返回：站点单会话策略下，一次授权过程里可能
 * 发出不止一枚（重定向多走一跳、或旧 cookie 触发了补发）。先收齐，再验活挑最新的。
 *
 * @param {import('../cdp.js').BrowserSession} session
 * @param {{timeoutMs: number, tokenKey: string, settleMs?: number, onLog?: (text: string) => void}} options
 * @returns {Promise<string[]>} 按出现顺序的 token 原文。
 */
async function collectTokens(session, options) {
  const deadline = Date.now() + options.timeoutMs;
  // 收到第一枚之后再多看一会儿，等「可能出现的第二枚」露头。
  const settleMs = typeof options.settleMs === 'number' ? options.settleMs : 8000;
  const log = typeof options.onLog === 'function' ? options.onLog : () => {};
  const found = [];
  let lastUrl = '';
  let firstSeenAt = null;

  const remember = (token) => {
    if (typeof token !== 'string' || token === '' || found.includes(token)) return;
    found.push(token);
    if (firstSeenAt === null) firstSeenAt = Date.now();
    log(`抓到一枚 token（共 ${found.length} 枚）`);
  };

  const off = [
    session.on('Page.navigatedWithinDocument', (params) => { lastUrl = params.url ?? lastUrl; }),
    session.on('Page.frameNavigated', (params) => { lastUrl = params.frame?.url ?? lastUrl; }),
  ];

  try {
    while (Date.now() < deadline) {
      remember(tokenFromUrl(lastUrl));
      try {
        const snapshot = await session.evaluate(
          `JSON.stringify({ href: location.href, token: (localStorage.getItem(${JSON.stringify(options.tokenKey)}) || '') })`,
        );
        if (typeof snapshot === 'string') {
          const parsed = JSON.parse(snapshot);
          if (typeof parsed.href === 'string') lastUrl = parsed.href;
          // href 这条来源必须在这里也取一次。只更新 lastUrl 是不够的：hash 变化未必
          // 触发 navigatedWithinDocument，于是「回调带来的那枚新 token」会整个漏掉，
          // 只剩下 localStorage 里**上一次登录的旧 token** 被当成新登录态抓走。
          // 踩过这个坑：第一次能成（profile 全新、localStorage 是空的），之后必败。
          remember(tokenFromUrl(lastUrl));
          remember(parsed.token);
        }
      } catch {
        // 导航途中 evaluate 可能撞上「执行上下文已销毁」，下一拍再来。
      }
      if (firstSeenAt !== null && Date.now() - firstSeenAt >= settleMs) break;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  } finally {
    for (const dispose of off) dispose();
  }
  return found;
}



























/**
 * 在收集到的若干枚里挑一枚**此刻真的能用**的。
 *
 * 按 **iat 倒序**验，而不是按「抓到的先后」倒序 —— 两者不等价：同一个 tick 里，
 * localStorage 里的旧 token 完全可能排在回调带来的新 token 之后才被读到。签发时间
 * 才是「谁更新」的权威依据（读不出 iat 的非 JWT 才退回按抓取顺序）。
 *
 * @param {object} profile
 * @param {string[]} tokens
 * @param {(text: string) => void} log
 * @returns {Promise<{token: string|null, revoked: boolean}>}
 */
async function pickLiveToken(profile, tokens, log) {
  const ordered = tokens
    .map((token, index) => ({ token, index, iat: issuedAt(token) }))
    .sort((a, b) => (b.iat ?? -1) - (a.iat ?? -1) || b.index - a.index);
  for (const candidate of ordered) {
    if (await isTokenLive(profile, candidate.token)) {
      if (tokens.length > 1) log(`验活通过，用的是最新那枚（共 ${tokens.length} 枚）`);
      return { token: candidate.token, revoked: false };
    }
    log('有一枚 token 已被吊销（签发后又被顶掉了），跳过');
  }
  return { token: null, revoked: tokens.length > 0 };
}

/**
 * 读 JWT 的 iat（签发时间，秒）；不是 JWT 或读不出就返回 null。
 *
 * 用它排序，而不是依赖 localStorage 与回调 URL 谁先被读到 —— 那本身就是个竞态：
 * 前端 onMounted 写 localStorage 与我们轮询读 href 的先后顺序并不固定。
 */
export function issuedAt(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload.iat === 'number' ? payload.iat : null;
  } catch {
    return null;
  }
}

/** 从任意 URL 里抠出 token 参数；没有就 null。 */















export function tokenFromUrl(url) {
  if (typeof url !== 'string' || url === '') return null;
  try {
    // 回调地址形如 https://one.axzo.cn/#/login?token=xxx —— query 在 hash 之后，
    // 标准 URL 解析器看不到，这里手动切一次。
    const [beforeHash, hash = ''] = url.split('#', 2);
    const hashQuery = hash.indexOf('?');
    const candidates = [beforeHash];
    if (hashQuery !== -1) candidates.push(hash.slice(hashQuery + 1));
    for (const candidate of candidates) {
      const found = new URLSearchParams(candidate.split('?')[1] ?? candidate).get('token');
      if (typeof found === 'string' && found !== '') return found;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 续期。
 *
 * @param {object} args
 * @param {object} args.record store 里的完整记录。
 * @param {object} args.profile matchProfile 的结果。
 * @param {boolean} [args.interactive] 是否允许弹出可见窗口让人授权。
 * @param {string} args.profileDir Chrome profile 目录（持久化钉钉会话的关键）。
 * @param {(text: string) => void} [args.onLog]
 * @returns {Promise<{ok: boolean, token?: string, needsInteraction?: boolean, message?: string, mode?: string}>}
 */
export async function renewDingtalk(args) {
  const { record, profile } = args;
  const interactive = args.interactive === true;
  const onLog = typeof args.onLog === 'function' ? args.onLog : () => {};
  const mode = interactive ? 'interactive' : 'silent';

  let authorizeUrl;
  try {
    authorizeUrl = await fetchAuthorizeUrl(profile, { silent: !interactive });
  } catch (error) {
    return { ok: false, mode, message: `${error?.message ?? String(error)}` };
  }
  onLog(`拿到钉钉授权地址${interactive ? '（交互模式）' : '（静默模式）'}`);

  try {
    return await withSession(
      { userDataDir: args.profileDir, headless: !interactive, onLog },
      async (session) => {
        // 两种模式都直接落到钉钉授权页：少一跳，且用户看到的就是「谁在要授权」的那一屏。
        // 差别只在 prompt —— 交互模式保留 prompt=consent，让钉钉照常显示同意页。
        await session.navigate(authorizeUrl.toString());
        if (interactive) await session.bringToFront();
        const tokens = await collectTokens(session, {
          timeoutMs: interactive ? INTERACTIVE_TIMEOUT_MS : SILENT_TIMEOUT_MS,
          tokenKey: profile.tokenKey,
          onLog,
        });
        if (tokens.length === 0) {
          if (!interactive) {
            // 实测（2026-10-16）：钉钉的同意页**每次授权都会再弹一次**，删掉 prompt=consent
            // 也不例外 —— 带会话跑只会停在一个「同意/拒绝」按钮前，拿不到 token。
            // 所以静默模式基本不可能成功；它保留的价值是不打扰用户就能试一次，以及将来
            // 钉钉若改成静默放行，这里不用改代码就自动能用。
            return {
              ok: false,
              needsInteraction: true,
              mode,
              message: '钉钉要求每次授权都由本人点一次「同意」，静默拿不到新登录态 —— 用交互模式（会弹出一个浏览器窗口）',
            };
          }
          return { ok: false, mode, message: '等待授权超时（3 分钟），没有拿到新的登录态 —— 确认窗口里的钉钉授权页点了「同意」' };
        }
        // 落库之前必须验活：单会话策略下，刚签发的 token 也可能几秒后就被顶掉。
        const picked = await pickLiveToken(profile, tokens, onLog);
        if (picked.token !== null) return { ok: true, token: picked.token, mode };
        return {
          ok: false,
          needsInteraction: true,
          mode,
          message: '拿到了新登录态，但验活时被站点吊销了 —— 通常是同一账号在别处又登了一次；请确认没有其它窗口正在登录，然后重试',
        };
      },
    );
  } catch (error) {
    return { ok: false, mode, message: `自动续期失败：${error?.message ?? String(error)}` };
  }
}

export { originOf };
