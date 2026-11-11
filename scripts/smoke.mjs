// scripts/smoke.mjs
//
// 纯函数自测：不需要 DSH 运行时就能跑（node scripts/smoke.mjs）。
//
// 覆盖的是这条链路里最容易悄悄坏掉的部分 —— 解析、判过期、模板校验、取数与
// 格式化。夹具用的是 minimax 那条真实响应（已删去任何真实凭证），所以这些断言
// 断的是一手事实，不是我自己编的期望值。
//
// 特别有一条**安全断言**：脱敏后的记录里不能出现任何请求头取值。
//
// 迁移说明（从 dsh-usage-query 的 scripts/smoke.mjs 原样搬过来）：
//   · import 路径 ../lib/*.js → ../src/host/features/usage/*.js
//   · 路由前缀 /dsh-usage-query → /dsh-usage-aggregator/usage
//     （公共前缀 /dsh-usage-aggregator + 用量查询自己的 /usage 段）
//   · createRoutes 的入参从 { ops, endpoint } 改成 { ops, shared } ——
//     共享内核（src/host/shared/context.js）统一管前缀与 allowRemote。
// 断言一条没删。

import { strict as assert } from 'node:assert';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inspectCredential, maskUrl, parseRequestText, tokenizeShell } from '../src/host/features/usage/curl.js';
import { detectBusinessFailure, performRequest } from '../src/host/features/usage/request.js';
import { FALLBACK_VERSION, fallbackTemplate, validateTemplate } from '../src/host/features/usage/template.js';
import { labelForField, priorityForField, sortByPriority } from '../src/host/features/usage/labels.js';
import { analyzeResponse, callModelText } from '../src/host/features/usage/analyze.js';
import { asPercent, formatDuration, resolveView } from '../src/host/features/usage/resolve.js';
import { getPath, listPaths } from '../src/host/features/usage/paths.js';
import { createOps, fingerprint } from '../src/host/features/usage/ops.js';
import { maskProvider, makeProvider, readStore, upsert, writeStore } from '../src/host/features/usage/store.js';
import { createRoutes } from '../src/host/features/usage/server.js';
import { dueProviders, nextDueIn, normalizeIntervalSeconds } from '../src/host/features/usage/auto.js';
import { createShared } from '../src/host/shared/context.js';
import { Readable } from 'node:stream';

/**
 * 所有插件路由的公共前缀（与 cordis.patch.yml 的 config.endpoint 一致）。
 */
const ENDPOINT_BASE = '/dsh-usage-aggregator';

/**
 * 用量查询自己的路由前缀：公共前缀 + /usage 段。
 *
 * 为什么不是 /dsh-usage-query：聚合之后三个功能共用一个公共前缀，各挂一段
 * （/usage、/expander）。路由路径必须全局唯一，重复注册 webserver 会直接 throw。
 */
const MODULE_BASE = ENDPOINT_BASE + '/usage';

/**
 * 造一份共享上下文（路由前缀 / allowRemote 都归它管）。
 *
 * @returns {object} 共享上下文。
 */
function makeShared() {
  return createShared({ endpoint: ENDPOINT_BASE });
}

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n     ${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n     ${error.message}`);
  }
}

/**
 * 轮询等某个条件成立，最多等 timeoutMs 毫秒。
 *
 * 用固定 setTimeout 去赌一段异步链跑完，在机器忙的时候会偶发不够 ——
 * 那种失败重跑又好了，最难查。这里等到条件真的成立为止。
 *
 * @param {() => boolean} predicate 条件。
 * @param {number} timeoutMs 最长等待毫秒数。
 * @returns {Promise<boolean>} 条件最终是否成立。
 */
async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

/* ─────────────────── 夹具：一条真实的 minimax 用量响应 ─────────────────── */

// 夹具里的 token 带一个 exp（真实抓包就是这样）。写死它等于在测试里埋一颗
// 时间炸弹：过了那个时刻，依赖「登录态还没过期」的断言会全线变红（该夹具
// 原本在 2026-11-01 过期）。这里按当下时间现造一枚，断言用同一个常量。
const TOKEN_EXP = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
const TOKEN_PAYLOAD = Buffer.from(JSON.stringify({
  exp: TOKEN_EXP,
  user: { id: '484027974882263046', name: '', avatar: '', deviceID: '', isAnonymous: false },
})).toString('base64url');
const TOKEN = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${TOKEN_PAYLOAD}.3GkM0r4Qngddt9RM5dUOlzMnuFAIhcuzcBMZKU64seU`;

const CURL = `curl --url 'https://www.minimax.cn/backend/account/token_plan/remains_percent' \\
  -H 'accept: application/json, text/plain, */*' \\
  -H 'accept-language: zh-CN,zh;q=0.9,en;q=0.8' \\
  -b '_gc_usr_id_cs0_d0_sec0_part0=5d362123-6226-4084-a1c9-abf13d115785; _oauth_state=; _token=${TOKEN}; minimax_group_id_v2=2021855341230170230' \\
  -H 'origin: https://platform.minimax.cn' \\
  -H 'referer: https://platform.minimax.cn/' \\
  -H 'sec-fetch-dest: empty' \\
  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' \\
  -H 'x-group-id: 2021855341230170230'`;

const RESPONSE = {
  model_remains: [
    {
      model_name: 'general',
      start_time: 1791511200000,
      end_time: 1791529200000,
      remains_time: 10544434,
      current_interval_total_count: -1,
      current_interval_used_count: -1,
      current_interval_remains_count: -1,
      current_interval_used_percent: '49%',
      current_interval_total_percent: '100%',
      current_interval_status: 1,
      weekly_start_time: 1791129600000,
      weekly_end_time: 1791734400000,
      weekly_remains_time: 215744434,
      current_weekly_total_count: -1,
      current_weekly_used_count: -1,
      current_weekly_remains_count: -1,
      current_weekly_used_percent: '0%',
      current_weekly_total_percent: '100%',
      current_weekly_status: 3,
    },
    {
      model_name: 'video',
      start_time: 1791475200000,
      end_time: 1791561600000,
      remains_time: 42944434,
      current_interval_total_count: 3,
      current_interval_used_count: 0,
      current_interval_remains_count: 3,
      current_interval_used_percent: '0%',
      current_interval_total_percent: '100%',
      current_interval_status: 1,
      weekly_start_time: 1791129600000,
      weekly_end_time: 1791734400000,
      weekly_remains_time: 215744434,
      current_weekly_total_count: 21,
      current_weekly_used_count: 0,
      current_weekly_remains_count: 21,
      current_weekly_used_percent: '0%',
      current_weekly_total_percent: '100%',
      current_weekly_status: 1,
    },
  ],
  base_resp: { status_code: 0, status_msg: 'success' },
};

/** 这份模板就是模型该给出的东西（此处手写，用来验证「模板→view」这段是确定的）。 */
const TEMPLATE = {
  version: 1,
  kind: 'quota',
  title: 'MiniMax 用量',
  subtitle: null,
  notes: ['按模型分别统计当前周期与本周额度'],
  health: { path: 'base_resp.status_code', okValues: [0], messagePath: 'base_resp.status_msg' },
  primary: null,
  progress: null,
  metrics: [],
  collection: {
    path: 'model_remains',
    labelPath: 'model_name',
    labelMap: { general: '通用对话', video: '视频生成' },
    subtitlePath: null,
    emptyText: '暂无数据',
    progress: { path: 'current_interval_used_percent', label: '本周期已用' },
    metrics: [
      { path: 'current_interval_remains_count', label: '剩余次数', format: 'count' },
      { path: 'remains_time', label: '距重置', format: 'duration_ms' },
      { path: 'current_weekly_used_percent', label: '本周已用', format: 'percent' },
      { path: 'weekly_remains_time', label: '距周重置', format: 'duration_ms' },
    ],
  },
};

/* ───────────────────────────── 断言 ───────────────────────────── */

console.log('→ curl 解析');

check('shell 分词：引号与续行', () => {
  const { tokens } = tokenizeShell("curl 'a b' -H \"x: y\" \\\n z");
  assert.deepEqual(tokens, ['curl', 'a b', '-H', 'x: y', 'z']);
});

check('真实 cURL → 可重放的请求', () => {
  const parsed = parseRequestText(CURL);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.shape, 'curl');
  assert.equal(parsed.request.method, 'GET');
  assert.equal(parsed.request.url, 'https://www.minimax.cn/backend/account/token_plan/remains_percent');
  assert.equal(parsed.request.headers['x-group-id'], '2021855341230170230');
  assert.ok(parsed.request.headers.cookie.includes('_token='));
  assert.ok(parsed.request.headers.cookie.includes('minimax_group_id_v2=2021855341230170230'));
  assert.equal(parsed.request.body, null);
});

check('重放时丢掉不该抄的头', () => {
  const parsed = parseRequestText(CURL);
  assert.equal(parsed.request.headers['sec-fetch-dest'], undefined);
  assert.equal(parsed.request.headers.host, undefined);
});

check('URL 打码只留结构', () => {
  assert.equal(maskUrl('https://a.b/c?token=secret&page=2'), 'https://a.b/c?token=***&page=***');
  assert.equal(maskUrl('https://a.b/c'), 'https://a.b/c');
});

check('凭证过期时间从 JWT 里读出来（离线可算）', () => {
  const info = inspectCredential(parseRequestText(CURL).request);
  assert.equal(info.found, true);
  assert.equal(info.exp, TOKEN_EXP);
  assert.equal(info.subject, '484027974882263046');
});

check('原始 HTTP 报文也能用', () => {
  const parsed = parseRequestText('GET /api/usage HTTP/1.1\nHost: example.com\nCookie: a=b\n\n');
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.request.url, 'https://example.com/api/usage');
  assert.equal(parsed.request.headers.cookie, 'a=b');
});

check('认不出来的粘贴给出可读原因', () => {
  const parsed = parseRequestText('这不是请求');
  assert.equal(parsed.ok, false);
  assert.ok(parsed.error.length > 0);
});

console.log('\n→ 状态判定');

check('base_resp.status_code=0 不算失败', () => {
  assert.equal(detectBusinessFailure(RESPONSE), null);
});

check('业务码非 0 且文案含登录 → 判过期', () => {
  const expired = { base_resp: { status_code: 1004, status_msg: '未登录或登录已过期' } };
  const failure = detectBusinessFailure(expired);
  assert.ok(failure !== null);
  assert.equal(failure.expired, true);
});

check('业务码非 0 但文案无关 → 判错误而非过期', () => {
  const failure = detectBusinessFailure({ base_resp: { status_code: 5001, status_msg: '参数不合法' } });
  assert.ok(failure !== null);
  assert.equal(failure.expired, false);
});

check('HTTP 401 判过期（用假 fetch）', async () => {
  const result = await performRequest({ method: 'GET', url: 'https://x.test/a', headers: {}, body: null }, {
    fetchImpl: async () => new Response('{"message":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } }),
  });
  assert.equal(result.status, 'expired');
  assert.equal(result.httpStatus, 401);
});

check('非 JSON 响应不装作成功', async () => {
  const result = await performRequest({ method: 'GET', url: 'https://x.test/a', headers: {}, body: null }, {
    fetchImpl: async () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  assert.equal(result.status, 'error');
});

console.log('\n→ 模板与渲染');

check('合法模板通过校验', () => {
  const result = validateTemplate(TEMPLATE);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.template.collection.metrics.length, 4);
});

check('模型跑偏的模板被拒', () => {
  assert.equal(validateTemplate({ kind: 'quota' }).ok, false);
  assert.equal(validateTemplate({ title: 'x' }).ok, false);
  assert.equal(validateTemplate({ title: 'x', metrics: [{ path: 'T(java.lang.Runtime)', label: 'x', format: 'text' }] }).ok, false);
});

check('未知 format 降级成 text 而不是崩', () => {
  const result = validateTemplate({ title: 'x', metrics: [{ path: 'a', label: 'a', format: 'sneaky' }] });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.template.metrics[0].format, 'text');
});

check('结构兜底：能从数组里推出明细', () => {
  const template = fallbackTemplate(RESPONSE, 'MiniMax');
  assert.ok(template !== null);
  assert.equal(template.collection.path, 'model_remains');
  assert.equal(template.collection.labelPath, 'model_name');
  assert.ok(template.collection.metrics.length > 0);
});

check('字段名翻中文（真实接口里的那批）', () => {
  assert.equal(labelForField('current_interval_used_percent'), '本周期已用占比');
  assert.equal(labelForField('current_interval_remains_count'), '本周期剩余');
  assert.equal(labelForField('current_interval_total_count'), '本周期总量');
  assert.equal(labelForField('weekly_remains_time'), '本周距重置');
  assert.equal(labelForField('model_name'), '模型名称');
  assert.equal(labelForField('start_time'), '开始时间');
  assert.equal(labelForField('balance'), '余额');
  assert.equal(labelForField('已用额度'), '已用额度', '已经是中文的字段名不该被改写');
  assert.equal(labelForField('weirdzyx'), 'weirdzyx', '认不出来就保留原文，不瞎猜');
});

check('重要性顺序：剩余/已用在前，时间戳垫底', () => {
  const sorted = sortByPriority([
    { path: 'start_time' },
    { path: 'current_interval_total_count' },
    { path: 'current_interval_remains_count' },
    { path: 'current_interval_used_percent' },
  ]).map((metric) => metric.path);
  assert.equal(sorted[0], 'current_interval_used_percent');
  assert.equal(sorted[1], 'current_interval_remains_count');
  assert.equal(sorted[sorted.length - 1], 'start_time');
  assert.ok(priorityForField('start_time') > priorityForField('remaining_balance'));
});

check('兜底模板：所有字段都在、都有中文名、按重要性排序', () => {
  const template = fallbackTemplate(RESPONSE, 'MiniMax');
  assert.ok(template !== null);
  const metrics = template.collection.metrics;
  // 每个中文标签都不该还是原始的英文字段名（除非词表真的不认识）
  for (const metric of metrics) {
    const known = ['model_name'];
    if (!known.includes(metric.path)) assert.notEqual(metric.label, metric.path, `${metric.path} 没有翻成中文`);
  }
  assert.ok(metrics.some((metric) => metric.label === '本周期剩余'));
  assert.ok(metrics.some((metric) => metric.label === '距重置'));
  assert.equal(metrics[0].path, 'current_weekly_used_percent', '首条应当是百分比量字段');
  // 百分比字段被拿去当进度条后不再重复出现在列表里
  assert.equal(template.collection.progress.path, 'current_interval_used_percent');
  assert.ok(!metrics.some((metric) => metric.path === template.collection.progress.path));
  // 时间戳仍然被解析，只是沉到后面（前端默认折叠）
  assert.ok(metrics.some((metric) => metric.path === 'start_time'));
  assert.ok(metrics.findIndex((metric) => metric.path === 'start_time') >= 5, '低信息量字段应当落在默认展示区之外');
});

check('取数路径支持点与下标', () => {
  assert.equal(getPath(RESPONSE, 'model_remains[1].model_name'), 'video');
  assert.equal(getPath(RESPONSE, '$.base_resp.status_code'), 0);
  assert.equal(getPath(RESPONSE, 'nope.deeper'), undefined);
  assert.ok(listPaths(RESPONSE).includes('base_resp.status_code'));
});

check('百分比 / 时长格式化', () => {
  assert.equal(asPercent('49%'), 49);
  assert.equal(asPercent(0.49), 49);
  assert.equal(asPercent(49), 49);
  assert.equal(formatDuration(10544434, 'zh'), '2 小时 55 分');
  assert.equal(formatDuration(215744434, 'zh'), '2 天 11 小时');
  assert.equal(formatDuration(-1000, 'zh'), '已过期 1 秒');
});

check('模板 + 真实响应 → view（每次都是同一个结果）', () => {
  const view = resolveView(TEMPLATE, RESPONSE, { language: 'zh', fetchedAt: 1730000000000, httpStatus: 200, status: 'ok' });
  assert.equal(view.title, 'MiniMax 用量');
  assert.equal(view.status.tone, 'ok');
  assert.equal(view.cards.length, 2);
  assert.equal(view.cards[0].label, '通用对话');
  assert.equal(view.cards[0].percent, 49);
  assert.deepEqual(view.cards[1].metrics.map((item) => `${item.label}=${item.text}`), ['剩余次数=3', '距重置=11 小时 55 分', '本周已用=0%', '距周重置=2 天 11 小时']);
  const again = resolveView(TEMPLATE, RESPONSE, { language: 'zh', fetchedAt: 1730000000000, httpStatus: 200, status: 'ok' });
  assert.deepEqual(again, view);
});

check('负数次数显示成「不限量」，不显示 -1', () => {
  const view = resolveView(TEMPLATE, RESPONSE, { language: 'zh', status: 'ok' });
  // 按标签找，不按位置：零信息指标现在会被后移（见下面那条断言）
  const remains = view.cards[0].metrics.find((metric) => metric.label === '剩余次数');
  assert.ok(remains !== undefined);
  assert.equal(remains.text, '不限量');
  assert.ok(!view.cards[0].metrics.some((metric) => metric.text === '-1'), '面板上不该出现 -1');
});

check('凭证失效的英文文案也判过期（minimax 真实返回）', () => {
  const failure = detectBusinessFailure({ base_resp: { status_code: 1016, status_msg: 'invalid api key' } });
  assert.ok(failure !== null);
  assert.equal(failure.expired, true, '「invalid api key」应当走「凭证失效 → 引导重贴」这一档');
});

check('模型给的字段过多时按上限截断', () => {
  const many = { title: 'x', metrics: Array.from({ length: 40 }, (_, index) => ({ path: `f${index}`, label: `f${index}`, format: 'number' })) };
  const result = validateTemplate(many);
  assert.equal(result.ok, true, result.error);
  assert.ok(result.template.metrics.length <= 24, `应当截断到 24 条，实际 ${result.template.metrics.length}`);
  assert.ok(result.template.metrics.length > 6, '上限要放宽到能装下真实接口的全部字段');
});

check('「不限量」这类零信息指标后移，默认区先放有数字的', () => {
  const template = {
    title: '额度', kind: 'quota', health: null, primary: null, progress: null, metrics: [],
    collection: {
      path: 'items', labelPath: 'name', labelMap: null, subtitlePath: null, emptyText: '—', progress: null,
      metrics: [
        { path: 'a', label: '剩余', format: 'count' },
        { path: 'b', label: '总量', format: 'count' },
        { path: 'c', label: '本周已用', format: 'percent' },
        { path: 'd', label: '距重置', format: 'duration_ms' },
      ],
    },
  };
  const view = resolveView(template, { items: [{ name: '通用', a: -1, b: -1, c: '0%', d: 3600000 }] }, { language: 'zh', status: 'ok' });
  const order = view.cards[0].metrics.map((metric) => metric.label);
  assert.deepEqual(order, ['本周已用', '距重置', '剩余', '总量'], `零信息指标应当排到后面，实际 ${order.join(' > ')}`);
});

check('全是不限量时不乱序（稳定排序）', () => {
  const template = {
    title: '额度', kind: 'quota', health: null, primary: null, progress: null, metrics: [],
    collection: { path: 'items', labelPath: 'name', labelMap: null, subtitlePath: null, emptyText: '—', progress: null, metrics: [{ path: 'a', label: '甲', format: 'count' }, { path: 'b', label: '乙', format: 'count' }] },
  };
  const view = resolveView(template, { items: [{ name: 'x', a: -1, b: -1 }] }, { language: 'zh', status: 'ok' });
  assert.deepEqual(view.cards[0].metrics.map((metric) => metric.label), ['甲', '乙']);
});

check('明细字段消失时给出提示而不是白屏', () => {
  const view = resolveView(TEMPLATE, { base_resp: { status_code: 0 } }, { language: 'zh', status: 'ok' });
  assert.equal(view.cards.length, 0);
  assert.ok(view.notes.some((note) => note.includes('model_remains')));
});

console.log('\n→ 模型输出收集（假 llm，离线可跑）');

/** 用一段固定的 chunk 序列伪装一次模型调用。 */
function fakeLlm(chunkSets) {
  let call = 0;
  return {
    calls: () => call,
    stream() {
      const set = chunkSets[Math.min(call, chunkSets.length - 1)];
      call += 1;
      return (async function* () {
        for (const chunk of set) yield chunk;
      })();
    },
  };
}

/** 假 llm 目录：两个 provider，其中一个拉模型清单会失败（验证不会被整体带崩）。 */
function fakeLlmCatalog() {
  return {
    listProviders() {
      return [
        { id: 'alpha', name: 'Alpha' },
        { id: 'beta', name: 'Beta' },
        { id: 'broken', name: 'Broken' },
      ];
    },
    async listModels(provider) {
      if (provider === 'broken') throw new Error('这个 provider 不支持列举模型');
      return [{ id: `${provider}-fast`, name: `${provider} fast` }, { id: `${provider}-deep`, name: `${provider} deep` }];
    },
  };
}

/** 假附件服务：只记下调用，返回一个可辨识的引用。 */
function fakeAttachments() {
  const saved = [];
  return {
    saved: saved,
    async saveImage(input) {
      saved.push(input);
      return { attachmentId: 'att-1', mediaType: input.mediaType, bytes: input.data.length, width: 100, height: 60 };
    },
  };
}

const templateJson = JSON.stringify({
  title: '用量',
  kind: 'quota',
  metrics: [{ path: 'a', label: 'A', format: 'number' }],
});

check('逐字 delta 正常收集', async () => {
  const llm = fakeLlm([[
    { type: 'text-delta', index: 0, text: '{"title":' },
    { type: 'text-delta', index: 0, text: '1}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]]);
  assert.equal(await callModelText(llm, { provider: 'p', model: 'm', messages: [] }), '{"title":1}');
});

check('只有 block-end（非流式）也不丢内容', async () => {
  const llm = fakeLlm([[
    { type: 'block-end', index: 0, block: { type: 'text', text: templateJson } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]]);
  const text = await callModelText(llm, { provider: 'p', model: 'm', messages: [] });
  assert.ok(text.includes('"title"'));
});

check('答案只出现在思维链里也能救回来', async () => {
  const llm = fakeLlm([[
    { type: 'reasoning-delta', index: 0, text: `嗯…应该是这样：${templateJson}` },
    { type: 'finish', reason: { kind: 'stop' } },
  ]]);
  const text = await callModelText(llm, { provider: 'p', model: 'm', messages: [] });
  assert.ok(text.includes('"title"'));
});

await checkAsync('空手而归会重试一次，而不是直接降级', async () => {
  const llm = fakeLlm([
    [{ type: 'finish', reason: { kind: 'stop' } }],
    [{ type: 'text-delta', index: 0, text: templateJson }, { type: 'finish', reason: { kind: 'stop' } }],
  ]);
  const text = await callModelText(llm, { provider: 'p', model: 'm', messages: [] });
  assert.ok(text.includes('"title"'));
  assert.equal(llm.calls(), 2);
});

await checkAsync('两次都空 → 报错交给上层兜底', async () => {
  const llm = fakeLlm([[{ type: 'finish', reason: { kind: 'stop' } }]]);
  await assert.rejects(() => callModelText(llm, { provider: 'p', model: 'm', messages: [] }), /没有返回任何内容/);
});

await checkAsync('analyzeResponse 端到端（假 llm）：请求+响应 → 模板', async () => {
  const llm = fakeLlm([[
    { type: 'text-delta', index: 0, text: '```json\n' + JSON.stringify({ ...TEMPLATE, title: '来自模型' }) + '\n```' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]]);
  const result = await analyzeResponse(llm, { request: parseRequestText(CURL).request, response: RESPONSE, label: 'MiniMax', provider: 'p', model: 'm' });
  assert.equal(result.ok, true, result.error);
  const validated = validateTemplate(result.raw);
  assert.equal(validated.ok, true, validated.error);
  assert.equal(validated.template.title, '来自模型');
});

console.log('\n→ 分析模型选择');

await checkAsync('可列出 provider 与模型；单个 provider 失败不影响其它', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-models-'));
  try {
    const ops = createOps({ config: { analysis: { provider: 'alpha', model: 'alpha-fast' } }, env: { DSH_HOME: home }, llm: () => fakeLlmCatalog() });
    const list = await ops.listAnalysisModels();
    assert.equal(list.ok, true);
    assert.equal(list.providers.length, 3, '拉不到清单的 provider 也要出现（只是模型列表为空）');
    assert.deepEqual(list.providers[0].models.map((model) => model.id), ['alpha-fast', 'alpha-deep']);
    assert.equal(list.providers[2].models.length, 0);
    assert.ok(typeof list.providers[2].error === 'string', '失败原因要带回来');
    assert.equal(list.current.provider, 'alpha');
    assert.equal(list.current.source, 'config', '没选过就是用配置里的默认值');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await checkAsync('面板里选的模型优先于配置默认值，且能恢复默认', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-models2-'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(RESPONSE), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const seen = [];
    const llm = {
      ...fakeLlmCatalog(),
      stream(options) {
        seen.push(options);
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: JSON.stringify(TEMPLATE) };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    };
    const ops = createOps({ config: { analysis: { provider: 'alpha', model: 'alpha-fast' } }, env: { DSH_HOME: home }, llm: () => llm });

    const saved = await ops.setAnalysisModel('beta', 'beta-deep');
    assert.equal(saved.ok, true, saved.error);
    assert.equal(saved.current.provider, 'beta');
    assert.equal(saved.current.source, 'user');

    await ops.import({ text: CURL, label: '换模型' });
    assert.equal(seen.length >= 1, true, '应当真的调过模型');
    assert.equal(seen[seen.length - 1].provider, 'beta', '分析必须用面板选的 provider');
    assert.equal(seen[seen.length - 1].model, 'beta-deep', '分析必须用面板选的 model');

    const cleared = await ops.setAnalysisModel('', '');
    assert.equal(cleared.ok, false, 'provider 为空是无效调用');
    const back = await ops.setAnalysisModel('alpha', '');
    assert.equal(back.cleared, true, 'model 传空 = 回到配置默认值');
    assert.equal(back.current.source, 'config');
    assert.equal(back.current.provider, 'alpha');
  } finally {
    globalThis.fetch = realFetch;
    await rm(home, { recursive: true, force: true });
  }
});

await checkAsync('store 能持久化分析模型的选择（重启后仍然是它）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-models3-'));
  try {
    const ops = createOps({ config: { analysis: { provider: 'alpha', model: 'alpha-fast' } }, env: { DSH_HOME: home }, llm: () => fakeLlmCatalog() });
    await ops.setAnalysisModel('beta', 'beta-deep');
    // 换一个「进程」读同一份 store
    const fresh = createOps({ config: { analysis: { provider: 'alpha', model: 'alpha-fast' } }, env: { DSH_HOME: home }, llm: () => fakeLlmCatalog() });
    const list = await fresh.listAnalysisModels();
    assert.equal(list.current.provider, 'beta', '重启后仍应沿用面板里的选择');
    assert.equal(list.current.source, 'user');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

console.log('\n→ 辅助截图（图片只作解释，数字仍以响应为准）');

/** 假 llm：把收到的消息原样留下来，便于断言「图片块到底进没进请求」。 */
function capturingLlm(chunkSets) {
  const seen = [];
  let call = 0;
  return {
    seen: seen,
    stream(options) {
      seen.push(options);
      const set = chunkSets[Math.min(call, chunkSets.length - 1)];
      call += 1;
      return (async function* () {
        for (const chunk of set) yield chunk;
      })();
    },
  };
}

await checkAsync('带辅助图分析：请求里同时有 image 块与文本，且写明「数字以响应为准」', async () => {
  const llm = capturingLlm([[
    { type: 'text-delta', index: 0, text: JSON.stringify(TEMPLATE) },
    { type: 'finish', reason: { kind: 'stop' } },
  ]]);
  const attachment = { attachmentId: 'att-9', mediaType: 'image/png', bytes: 1, width: 1, height: 1 };
  const result = await analyzeResponse(llm, {
    request: parseRequestText(CURL).request,
    response: RESPONSE,
    label: 'MiniMax',
    provider: 'p',
    model: 'm',
    imageAttachment: attachment,
  });
  assert.equal(result.ok, true, result.error);
  const content = llm.seen[0].messages[0].content;
  assert.equal(content.length, 2, '应当是 image + text 两个块');
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].attachment.attachmentId, 'att-9');
  assert.ok(content[1].text.includes('数字与状态一律以响应为准'), '必须在提示词里钉住「图不是数据源」');
  assert.ok(content[1].text.includes('【辅助截图】'));
});

await checkAsync('不带辅助图：请求里不该出现 image 块', async () => {
  const llm = capturingLlm([[
    { type: 'text-delta', index: 0, text: JSON.stringify(TEMPLATE) },
    { type: 'finish', reason: { kind: 'stop' } },
  ]]);
  await analyzeResponse(llm, { request: parseRequestText(CURL).request, response: RESPONSE, label: 'MiniMax', provider: 'p', model: 'm' });
  const content = llm.seen[0].messages[0].content;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'text');
  assert.ok(!content[0].text.includes('【辅助截图】'));
});

await checkAsync('cURL + 图片：走真实请求（不是快照），图片只当分析辅助', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-hint-'));
  const realFetch = globalThis.fetch;
  const attachments = fakeAttachments();
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify(RESPONSE), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const llm = capturingLlm([[
      { type: 'text-delta', index: 0, text: JSON.stringify(TEMPLATE) },
      { type: 'finish', reason: { kind: 'stop' } },
    ]]);
    const ops = createOps({ config: {}, env: { DSH_HOME: home }, llm: () => llm, attachments: () => attachments });
    const imported = await ops.import({
      text: CURL,
      image: { data: 'aGVsbG8=', mediaType: 'image/png' },
      label: '带图接入',
    });
    assert.equal(imported.ok, true, imported.error);
    assert.equal(imported.provider.source, 'curl', '有 cURL 就必须走真实请求，不能退化成快照');
    assert.equal(imported.provider.status, 'ok');
    assert.equal(upstreamCalls, 1);
    assert.equal(attachments.saved.length, 1, '辅助图应当交给附件服务保存');
    const content = llm.seen[0].messages[0].content;
    assert.equal(content[0].type, 'image', '这次分析必须带上图片块');
  } finally {
    globalThis.fetch = realFetch;
    await rm(home, { recursive: true, force: true });
  }
});

await checkAsync('重新分析可以临时补一张辅助图（不需要重新查接口）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-hint2-'));
  const realFetch = globalThis.fetch;
  const attachments = fakeAttachments();
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify(RESPONSE), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const llm = capturingLlm([[
      { type: 'text-delta', index: 0, text: JSON.stringify(TEMPLATE) },
      { type: 'finish', reason: { kind: 'stop' } },
    ]]);
    const ops = createOps({ config: {}, env: { DSH_HOME: home }, llm: () => llm, attachments: () => attachments });
    const imported = await ops.import({ text: CURL, label: '重分析带图' });
    const callsAfterImport = upstreamCalls;
    const redone = await ops.reanalyze(imported.provider.id, { image: { data: 'aGVsbG8=', mediaType: 'image/png' } });
    assert.equal(redone.ok, true, redone.error);
    assert.equal(upstreamCalls, callsAfterImport, '重新分析不该再打一次上游接口');
    assert.equal(llm.seen[llm.seen.length - 1].messages[0].content[0].type, 'image', '最后一次分析应当带图');
  } finally {
    globalThis.fetch = realFetch;
    await rm(home, { recursive: true, force: true });
  }
});

console.log('\n→ 存储与脱敏');

check('结构指纹对同一响应稳定', () => {
  assert.equal(fingerprint(RESPONSE), fingerprint(JSON.parse(JSON.stringify(RESPONSE))));
  assert.notEqual(fingerprint(RESPONSE), fingerprint({ base_resp: { status_code: 0 } }));
});

check('脱敏后的记录里**不含任何请求头取值**', () => {
  const parsed = parseRequestText(CURL);
  const record = makeProvider({ id: 'minimax', label: 'MiniMax', source: 'curl', request: parsed.request, notes: [] });
  const masked = maskProvider(record);
  const text = JSON.stringify(masked);
  assert.ok(!text.includes(TOKEN), 'token 泄漏到了客户端投影里');
  assert.ok(!text.includes('2021855341230170230'), 'group id 泄漏到了客户端投影里');
  assert.ok(masked.headerNames.includes('x-group-id'));
  assert.equal(masked.endpoint, 'GET https://www.minimax.cn/backend/account/token_plan/remains_percent');
  assert.equal(masked.credential.exp, TOKEN_EXP);
  assert.equal(masked.queryable, true);
});

await checkAsync('落盘 / 读回（临时 DSH_HOME）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-smoke-'));
  const env = { DSH_HOME: home };
  try {
    const parsed = parseRequestText(CURL);
    const store = await readStore(env);
    const record = makeProvider({ id: 'minimax', label: 'MiniMax', source: 'curl', request: parsed.request, notes: [] });
    upsert(store, record);
    const file = await writeStore(store, env);
    const mode = (await import('node:fs/promises')).stat;
    const info = await mode(file);
    assert.equal(info.mode & 0o777, 0o600, 'store.json 必须是仅本人可读');
    const reread = await readStore(env);
    assert.equal(reread.providers.length, 1);
    assert.equal(reread.providers[0].request.headers['x-group-id'], '2021855341230170230');
    const text = await readFile(file, 'utf8');
    assert.ok(text.includes('_token='), 'store 里应当保留凭证本身（只对客户端脱敏）');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

console.log('\n→ 操作层（假 fetch，离线跑完整链路）');

await checkAsync('接入 → 重放 → 兜底模板 → view，并且并发刷新不互相覆盖', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-ops-'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(RESPONSE), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    // 不传 llm：走「没有模型也能用」的那条路（结构兜底模板），正好覆盖降级分支。
    const ops = createOps({ config: {}, env: { DSH_HOME: home } });
    const first = await ops.import({ text: CURL, label: '甲接口' });
    const second = await ops.import({ text: CURL, label: '乙接口' });
    assert.equal(first.ok, true, first.error);
    assert.equal(second.ok, true, second.error);
    assert.notEqual(first.provider.id, second.provider.id, '同名接口应当各自有一条记录');
    assert.equal(first.provider.status, 'ok');
    assert.equal(first.provider.templateSource, 'fallback');
    assert.equal(first.provider.view.cards.length, 2);

    // 并发刷新两条：写路径串行，谁也不能把谁的结果吞掉。
    await Promise.all([ops.refresh(first.provider.id), ops.refresh(second.provider.id)]);
    const state = await ops.state();
    assert.equal(state.providers.length, 2);
    for (const provider of state.providers) {
      assert.equal(provider.status, 'ok', `${provider.id} 刷新后状态不对`);
      assert.equal(provider.view.cards.length, 2, `${provider.id} 的 view 丢了`);
    }
    // 摘要给 Agent 工具用，必须能读出数字
    const summary = await ops.summary();
    assert.ok(summary.text.includes('通用对话') || summary.text.includes('general'), '摘要里没带出明细');
    // 移除后只剩一条
    await ops.remove(second.provider.id);
    assert.equal((await ops.state()).providers.length, 1);
  } finally {
    globalThis.fetch = realFetch;
    await rm(home, { recursive: true, force: true });
  }
});

check('字段顺序：resolveView 按用户顺序排，未列出的接在后面', () => {
  const template = {
    title: 'x', kind: 'quota', health: null, primary: null, progress: null,
    metrics: [],
    collection: {
      path: 'items', labelPath: 'name', labelMap: null, subtitlePath: null, emptyText: '—', progress: null,
      metrics: [
        { path: 'a', label: '甲', format: 'number' },
        { path: 'b', label: '乙', format: 'number' },
        { path: 'c', label: '丙', format: 'number' },
      ],
    },
  };
  const data = { items: [{ name: 'x', a: 1, b: 2, c: 3 }] };
  const ordered = resolveView(template, data, { language: 'zh', status: 'ok', order: ['c', 'b'] });
  assert.deepEqual(ordered.cards[0].metrics.map((metric) => metric.label), ['丙', '乙', '甲'], '用户排过的在前，没排过的按原顺序接在后面');
  const unset = resolveView(template, data, { language: 'zh', status: 'ok', order: [] });
  assert.deepEqual(unset.cards[0].metrics.map((metric) => metric.label), ['甲', '乙', '丙'], '没有顺序时保持原样');
  assert.ok(ordered.cards[0].metrics[0].path !== undefined, '投影出来的指标必须带 path（排序 UI 依赖它）');
});

await checkAsync('字段顺序：保存后 view 立即重排，且不会为此再查一次上游', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-order-'));
  const realFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify(RESPONSE), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const ops = createOps({ config: {}, env: { DSH_HOME: home } });
    const imported = await ops.import({ text: CURL, label: '排序测试' });
    const id = imported.provider.id;
    const before = imported.provider.view.cards[0].metrics.map((metric) => metric.path);
    const callsAfterImport = upstreamCalls;

    const target = [before[2], before[0]];
    const saved = await ops.setFieldOrder(id, target);
    assert.equal(saved.ok, true, saved.error);
    assert.deepEqual(saved.provider.view.cards[0].metrics.slice(0, 2).map((metric) => metric.path), target, '保存后顺序应当立刻生效');
    assert.equal(upstreamCalls, callsAfterImport, '排序是展示层的事，不该重新打上游接口');

    const cleared = await ops.setFieldOrder(id, []);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.provider.fieldOrder, null, '空数组应当清掉覆盖、回到默认顺序');
    assert.deepEqual(cleared.provider.view.cards[0].metrics.map((metric) => metric.path), before, '清掉后回到原顺序');
  } finally {
    globalThis.fetch = realFetch;
    await rm(home, { recursive: true, force: true });
  }
});

await checkAsync('老兜底模板会自愈（版本落后 → 重新生成）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-heal-'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(RESPONSE), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const ops = createOps({ config: {}, env: { DSH_HOME: home } });
    const imported = await ops.import({ text: CURL, label: '自愈测试' });
    const id = imported.provider.id;
    // 伪造一条「老版本兜底模板」：英文标签、没有版本号
    const { readStore, writeStore, findProvider } = await import('../src/host/features/usage/store.js');
    const store = await readStore({ DSH_HOME: home });
    const record = findProvider(store, id);
    record.template = { version: 1, kind: 'list', title: 'MiniMax', metrics: [], collection: { path: 'model_remains', labelPath: 'model_name', metrics: [{ path: 'start_time', label: 'start_time', format: 'datetime' }] } };
    record.templateSource = 'fallback';
    record.view = { ...record.view, notes: [] };
    await writeStore(store, { DSH_HOME: home });

    await ops.refresh(id);
    const after = await ops.state();
    const healed = after.providers[0].template;
    assert.equal(healed.fallbackVersion, FALLBACK_VERSION, '应当在刷新时重新生成兜底模板');
    assert.ok(healed.collection.metrics.some((metric) => /[\u4e00-\u9fa5]/.test(metric.label)), '重新生成后字段名应当是中文');
  } finally {
    globalThis.fetch = realFetch;
    await rm(home, { recursive: true, force: true });
  }
});

await checkAsync('凭证失效时操作层如实回报，不编造数据', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-ops2-'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ base_resp: { status_code: 1016, status_msg: 'invalid api key' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const ops = createOps({ config: {}, env: { DSH_HOME: home } });
    const imported = await ops.import({ text: CURL, label: '凭证失效接口' });
    assert.equal(imported.ok, true, imported.error);
    assert.equal(imported.provider.status, 'expired', `应当是 expired，实际 ${imported.provider.status}`);
    assert.equal(imported.provider.view, null, '拿不到数据时不该有 view');
    assert.ok(imported.provider.last.message.includes('1016'));
  } finally {
    globalThis.fetch = realFetch;
    await rm(home, { recursive: true, force: true });
  }
});

console.log('\n→ 自动查询判定');

const HOUR = 3600000;

check('从没查过的接口：立刻算到点', () => {
  const providers = [{ id: 'a', source: 'curl', request: {}, credential: null, last: null }];
  assert.deepEqual(dueProviders(providers, { now: 1000, intervalMs: 5 * 60000 }), ['a']);
});

check('刚查过的不重复查，到点才查', () => {
  const providers = [{ id: 'a', source: 'curl', request: {}, credential: null, last: { at: 1000 } }];
  assert.deepEqual(dueProviders(providers, { now: 1000 + 4 * 60000, intervalMs: 5 * 60000 }), [], '差一分钟不该查');
  assert.deepEqual(dueProviders(providers, { now: 1000 + 5 * 60000, intervalMs: 5 * 60000 }), ['a'], '到点该查');
  assert.deepEqual(dueProviders(providers, { now: 1000 + 9 * HOUR, intervalMs: 5 * 60000 }), ['a'], '错过很久也只查一次');
});

check('手动刷新会让自动查询顺延（不会刚点完又被查一次）', () => {
  const providers = [{ id: 'a', source: 'curl', request: {}, credential: null, last: { at: 0 } }];
  const now = HOUR; // 距离上次已过 1 小时，早就到点
  assert.deepEqual(dueProviders(providers, { now, intervalMs: 5 * 60000 }), ['a']);
  // 用户此刻手动刷新 → last.at 变成 now
  providers[0].last = { at: now };
  assert.deepEqual(dueProviders(providers, { now: now + 60000, intervalMs: 5 * 60000 }), [], '手动刷新后应当顺延一个周期');
});

check('登录态明确过期、截图来源、没有请求的都不查', () => {
  const now = 10 * HOUR;
  const providers = [
    { id: 'expired', source: 'curl', request: {}, credential: { exp: Math.floor((now - 1000) / 1000) }, last: { at: 0 } },
    { id: 'image', source: 'image', request: null, credential: null, last: null },
    { id: 'no-request', source: 'curl', request: null, credential: null, last: null },
    { id: 'opaque', source: 'curl', request: {}, credential: { found: true, exp: null }, last: { at: 0 } },
  ];
  assert.deepEqual(dueProviders(providers, { now, intervalMs: 5 * 60000 }), ['opaque'], '只有「凭证不透明但有效」的那条该查');
});

check('下次查询时间：可用于「下次 14:35」', () => {
  const provider = { source: 'curl', request: {}, credential: null, last: { at: 0 } };
  assert.equal(nextDueIn(provider, { now: 60000, intervalMs: 5 * 60000 }), 4 * 60000);
  assert.equal(nextDueIn(provider, { now: 10 * 60000, intervalMs: 5 * 60000 }), 0, '已到点');
  assert.equal(nextDueIn({ source: 'image', request: null }, { now: 0, intervalMs: 5 * 60000 }), null, '截图来源没有下次');
});

check('间隔会被夹到合理区间（<60s 等于打上游，>24h 等于关掉）', () => {
  assert.equal(normalizeIntervalSeconds(300), 300);
  assert.equal(normalizeIntervalSeconds(5), 60);
  assert.equal(normalizeIntervalSeconds(999999999), 86400);
  assert.equal(normalizeIntervalSeconds(undefined), 300, '默认 5 分钟');
  assert.equal(normalizeIntervalSeconds('abc'), 300);
});

await checkAsync('refreshDue：到点的查、没到点的不查，并标出来源是自动', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-auto-'));
  const realFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify(RESPONSE), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const ops = createOps({ config: {}, env: { DSH_HOME: home } });
    const imported = await ops.import({ text: CURL, label: '自动查询测试' });
    const id = imported.provider.id;
    assert.equal(imported.provider.last.trigger, 'import', '接入即首查应当标成 import');

    const notDue = await ops.refreshDue({ intervalMs: 5 * 60000 });
    assert.equal(notDue.due, 0, '刚接入过，不该立刻又被自动查一次');
    assert.equal(upstreamCalls, 1, '自动查询不该额外打上游');

    const due = await ops.refreshDue({ intervalMs: 0 });
    assert.equal(due.due, 1);
    assert.equal(due.refreshed[0].id, id);
    assert.equal(due.refreshed[0].status, 'ok');
    assert.equal(upstreamCalls, 2);

    const state = await ops.state();
    assert.equal(state.providers[0].last.trigger, 'auto', '自动查询的结果要能区分出来');
    assert.ok(typeof state.providers[0].nextDueIn === 'number');
    assert.equal(state.autoRefresh.enabled, true);
    assert.equal(state.autoRefresh.intervalSeconds, 300, '默认 5 分钟');
  } finally {
    globalThis.fetch = realFetch;
    await rm(home, { recursive: true, force: true });
  }
});

console.log('\n→ 顶部芯片显示哪个接口');

await checkAsync('芯片接口可指定、可取消，并跨重启保留', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-chip-'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(RESPONSE), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const ops = createOps({ config: {}, env: { DSH_HOME: home } });
    await ops.import({ text: CURL, label: '甲接口' });
    await ops.import({ text: CURL, label: '乙接口' });

    let state = await ops.state();
    assert.equal(state.providers.length, 2);
    assert.equal(state.chip.id, null, '默认不指定：芯片显示第一个');

    const picked = await ops.setChipProvider(state.providers[1].id);
    assert.equal(picked.ok, true, picked.error);
    assert.equal(picked.chip.id, state.providers[1].id);

    state = await ops.state();
    assert.equal(state.chip.id, state.providers[1].id, '应当落到 state 上，客户端据此渲染');

    // 换一个「进程」读同一份 store
    const fresh = createOps({ config: {}, env: { DSH_HOME: home } });
    assert.equal((await fresh.state()).chip.id, state.providers[1].id, '重启后仍应沿用');

    const cleared = await ops.setChipProvider('');
    assert.equal(cleared.ok, true);
    assert.equal(cleared.chip.id, null, '空 id = 回到「第一个」');

    const missing = await ops.setChipProvider('nope');
    assert.equal(missing.ok, false, '不存在的接口要报错，不能悄悄存进去');
    assert.equal((await ops.state()).chip.id, null, '失败时不该改动已有选择');
  } finally {
    globalThis.fetch = realFetch;
    await rm(home, { recursive: true, force: true });
  }
});

await checkAsync('自动查询定时器真的会自己发起请求（假 setInterval 驱动）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-timer-'));
  const realFetch = globalThis.fetch;
  const realSetInterval = globalThis.setInterval;
  const realLog = console.log;
  const realErr = console.error;
  const logs = [];
  console.log = (...args) => { logs.push(args.join(' ')); };
  console.error = (...args) => { logs.push(args.join(' ')); };
  // 插件里有不止一个定时器（自动查询一轮 60 秒，体检后台自动扫一轮 5 分钟）。
  // 假 setInterval 只记最后一个的话，后来注册的那个会把要测的那个顶掉 ——
  // 按间隔认，才知道哪个是自动查询的。
  const timers = [];
  const realDshHome = process.env.DSH_HOME;
  globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms }); return 1; };
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify(RESPONSE), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const { createOps } = await import('../src/host/features/usage/ops.js');
    const { readStore: read, writeStore: write, findProvider } = await import('../src/host/features/usage/store.js');
    const ops = createOps({ config: { autoRefresh: { enabled: true, intervalSeconds: 300 } }, env: { DSH_HOME: home } });
    const imported = await ops.import({ text: CURL, label: '定时器验证' });
    assert.equal(imported.ok, true, imported.error);
    const callsAfterImport = upstreamCalls;

    // 装载 Host 半边（与真实 cordis 装载同一条代码路径），拿到定时器回调。
    // 注意：src/host/index.js 里的 ops 用**默认 process.env**（真实插件也是这样），
    // 所以这里必须把 DSH_HOME 指到临时目录，否则定时器会去读改**你真实的 store**。
    process.env.DSH_HOME = home;
    const mod = await import('../src/host/index.js');
    // 真实 cordis 的 effect 在注册时**立即执行**并返回 cleanup；桩要照做，
    // 否则定时器根本没被装上（第一次写这个测试就栽在这）。
    const cleanups = [];
    const ctx = {
      effect: (fn) => { cleanups.push(fn()); return 1; },
      get: () => null,
      on: () => 1,
      // 可选注入：服务齐了才跑回调。给一个假的 webServer（路由注册是空转），
      // 这样三个功能的 apply 都能跑完 —— 缺了它，功能里的 host.effect 会炸。
      inject: (deps, cb) => {
        const scope = {
          effect: (fn) => { cleanups.push(fn()); return 1; },
          on: () => 1,
          get: () => null,
          webServer: { register: () => () => {}, effect: (fn) => { cleanups.push(fn()); return 1; } },
        };
        const dispose = cb(scope);
        return typeof dispose === 'function' ? dispose : 1;
      },
      tools: { register: () => 1 },
    };
    // 聚合后的配置结构：公共前缀 + allowRemote + 各功能自己的一段。
    // 自动查询的开关在 config.usage.autoRefresh 里（原来在 config.autoRefresh）。
    mod.apply(ctx, {
      endpoint: ENDPOINT_BASE,
      allowRemote: false,
      usage: { autoRefresh: { enabled: true, intervalSeconds: 300 } },
      expander: {},
    });
    const usageTimer = timers.find((entry) => entry.ms === 60000);
    const tick = usageTimer === undefined ? null : usageTimer.fn;
    assert.ok(typeof tick === 'function', '装载后应当注册了定时器');
    assert.ok(logs.some((line) => line.includes('自动查询已开启')), '装载时应当留一条「自动查询已开启」日志');
    assert.equal(upstreamCalls, callsAfterImport, '刚装载不该立刻打上游');

    // 把 last.at 推到 10 分钟前（模拟「5 分钟已到」），然后按一拍
    const store = await read({ DSH_HOME: home });
    const record = findProvider(store, imported.provider.id);
    record.last.at = Date.now() - 10 * 60 * 1000;
    await write(store, { DSH_HOME: home });

    tick();
    // 一拍里要走：读 store → 判到点 → 真实 fetch（假的）→ 写回 store。
    // 里面全是 async fs 与 promise，跑完没有可观测的信号。
    // 早先这里固定等 120ms 再断言，机器忙的时候这一步会偶尔不够 ——
    // 日志晚到几十毫秒，断言就先判了失败。改成等条件真的成立。
    const autoQueryLogged = await waitUntil(
      () => logs.some((line) => line.includes('自动查询：1/1 成功')),
    );
    assert.equal(upstreamCalls, callsAfterImport + 1, '按一拍后应当真的发了一次上游请求');
    assert.ok(autoQueryLogged, '应当留下一条可 grep 的「自动查询 N/M」日志');

    // 卸载：插件卸载时所有 effect 的 cleanup 都会跑 —— 少了任何一个，
    // 插件重载就会叠一层定时器。
    const before = upstreamCalls;
    for (const cleanup of cleanups) {
      if (typeof cleanup === 'function') cleanup();
    }
    if (tick !== null) tick();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(upstreamCalls, before, '卸载后定时器不应再触发');
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.error = realErr;
    if (realDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = realDshHome;
    await rm(home, { recursive: true, force: true });
  }
});

console.log('\n→ HTTP 路由（假 req/res，直接打处理器）');

/** 用假 req/res 调一次路由处理器，返回 {status, body}。 */
function invokeRoute(routes, path, method, body, remoteAddress = '127.0.0.1') {
  const route = routes.find((item) => item.path === path);
  assert.ok(route !== undefined, `路由 ${path} 没有注册`);
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(payload === '' ? [] : [Buffer.from(payload)]);
  req.method = method;
  req.url = path;
  req.headers = { 'content-type': 'application/json' };
  req.socket = { remoteAddress };
  let status = 0;
  let text = '';
  const res = {
    writeHead(code) { status = code; return this; },
    end(chunk) { if (typeof chunk === 'string') text = chunk; },
    destroy() {},
  };
  return route.handler(req, res).then(() => ({ status, body: (() => { try { return JSON.parse(text); } catch { return text; } })() }));
}

await checkAsync('路由：/order 能保存字段顺序并立刻反映到 view', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-route-'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(RESPONSE), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const ops = createOps({ config: {}, env: { DSH_HOME: home } });
    const routes = createRoutes({ ops, shared: makeShared() });
    const imported = await ops.import({ text: CURL, label: '路由测试' });
    const id = imported.provider.id;
    const before = imported.provider.view.cards[0].metrics.map((metric) => metric.path);

    const saved = await invokeRoute(routes, '/dsh-usage-aggregator/usage/order', 'POST', { id, paths: [before[1], before[0]] });
    assert.equal(saved.status, 200, `期望 200，实际 ${saved.status}：${JSON.stringify(saved.body).slice(0, 200)}`);
    assert.equal(saved.body.ok, true);
    assert.deepEqual(saved.body.provider.view.cards[0].metrics.slice(0, 2).map((metric) => metric.path), [before[1], before[0]]);

    const cleared = await invokeRoute(routes, '/dsh-usage-aggregator/usage/order', 'POST', { id, paths: [] });
    assert.equal(cleared.body.provider.fieldOrder, null, '空数组 = 恢复默认');

    const listed = await invokeRoute(routes, '/dsh-usage-aggregator/usage', 'GET');
    assert.equal(listed.body.ok, true);
    assert.equal(listed.body.providers.length, 1);
    assert.equal(JSON.stringify(listed.body).includes('_token='), false, '路由返回给浏览器的内容里不能有凭证');
  } finally {
    globalThis.fetch = realFetch;
    await rm(home, { recursive: true, force: true });
  }
});

await checkAsync('路由：非回环地址一律拒绝（这些接口能替用户发带凭证的请求）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-route2-'));
  try {
    const ops = createOps({ config: {}, env: { DSH_HOME: home } });
    const routes = createRoutes({ ops, shared: makeShared() });
    for (const path of ['/dsh-usage-aggregator/usage', '/dsh-usage-aggregator/usage/order']) {
      const denied = await invokeRoute(routes, path, 'POST', { id: 'x' }, '10.0.0.9');
      assert.equal(denied.status, 403, `${path} 应当拒绝远程来源`);
      assert.equal(denied.body.ok, false);
    }
    const allowed = await invokeRoute(routes, '/dsh-usage-aggregator/usage', 'GET', undefined, '::1');
    assert.equal(allowed.status, 200, '回环地址（IPv6 ::1）应当放行');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await checkAsync('路由：未知 id 报 400 并给出可读原因', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-route3-'));
  try {
    const ops = createOps({ config: {}, env: { DSH_HOME: home } });
    const routes = createRoutes({ ops, shared: makeShared() });
    const result = await invokeRoute(routes, '/dsh-usage-aggregator/usage/order', 'POST', { id: 'nope', paths: ['a'] });
    assert.equal(result.status, 400);
    assert.ok(String(result.body.error).includes('nope'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${passed} 项通过${failures.length === 0 ? '' : `，${failures.length} 项失败`}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n[${failure.name}]\n${failure.error.stack}`);
  process.exitCode = 1;
}
