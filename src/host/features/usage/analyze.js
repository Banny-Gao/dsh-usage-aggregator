// src/host/features/usage/analyze.js
//
// 模型分析层：整条链路里唯一调用 LLM 的地方。
//
// 三件事：
//   1. analyzeResponse —— 把「请求 + 响应」翻成展示模板（主路径，只在第一次与
//      手动「重新分析」时跑；结果缓存进 store，之后每次查询都不再花模型调用）；
//   2. analyzeRequestText —— cURL 解析失败时，从乱七八糟的粘贴里把 URL/头捞出来；
//   3. analyzeImage —— 截图识别：读图得到「快照」（不能自动刷新，但能立刻看懂）。
//
// 模型来自插件 config（analysis.provider / analysis.model），必须是本 profile
// 已配置的 provider —— 插件自己没有密钥，也不该有。

import { FORMATS } from './template.js';

/** 送去分析的响应体积上限（字符）。再大就是接口返回了不该给模型看的东西。 */
const RESPONSE_CHAR_LIMIT = 40000;

/** 默认的分析用 system 提示：把模型钉死在「输出 JSON、不许编造字段」。 */
const SYSTEM_PROMPT = [
  '你是一个把「HTTP 请求 + 响应」翻译成展示模板的工程助手。',
  '你的唯一产出是一段 JSON，不能有解释文字、不能有 Markdown 代码块之外的内容。',
  '模板里出现的每个 path 都必须来自真实响应；不存在的字段一律不要写。',
  '宁可少写字段，也不要写猜的字段：展示层会用路径取数，写错的路径只会让面板变空。',
].join('\n');

function formatList() {
  return FORMATS.join(' | ');
}

/** 分析用的输出契约说明（中文模板 / 英文模板只差标签语言）。 */
function templateContract(language) {
  const labelLanguage = language === 'zh' ? '中文' : 'English';
  return [
    '输出这个 JSON（不要多余键）：',
    '{',
    '  "kind": "quota | balance | usage | list | generic",',
    '  "title": "面板标题",',
    '  "subtitle": "可选副标题",',
    '  "notes": ["可选的一句话说明，最多 3 条"],',
    '  "health": { "path": "业务状态码路径", "okValues": [0], "messagePath": "状态文案路径" },',
    '  "primary": { "path": "...", "label": "...", "format": "..." }            // 唯一的主指标，只在有「一个数说了算」时给',
    '  "progress": { "path": "...", "label": "..." },                          // 一条 0-100 的进度条，值可以是 49 或 "49%"',
    '  "metrics": [ { "path": "...", "label": "...", "format": "...", "unit": "可选单位", "hideWhen": "可选：取该值时隐藏", "tone": "ok|warn|error|muted" } ],',
    '  "collection": {',
    '     "path": "数组路径（每项渲染成一张卡片）",',
    '     "labelPath": "每项的标题字段", "labelMap": { "原始值": "更好懂的名字" },',
    '     "subtitlePath": "可选", "emptyText": "可选",',
    '     "progress": { "path": "每项里的百分比字段", "label": "..." },',
    '     "metrics": [ { "path": "每项里的字段（相对该项）", "label": "...", "format": "..." } ]',
    '  }',
    '}',
    `format 只能取：${formatList()}。`,
    `label 用${labelLanguage}，短、直白，不超过 12 个字。`,
    '规则：',
    '- path 写相对响应根的路径，允许 a.b[0].c 这种写法；collection.metrics 里的 path 相对**数组项**。',
    '- **字段要全**：响应里每一个有意义的标量字段都要出现在 metrics / collection.metrics 里（含状态码、时间戳、计数字段），漏字段比多字段更糟。',
    '- **顺序即优先级**：数组按「用户最关心的在前」排列 —— 剩余/余额/额度 → 已用/消耗占比 → 距重置/到期 → 总量/上限 → 计数 → 状态 → 时间戳。**前 5 条会被默认展示，其余折叠**，所以前 5 条必须是真正该看的。',
    '- 不要遗漏百分比字段；如果某个百分比字段被用作 collection.progress，就不要在 metrics 里重复一遍。',
    '- 每一项最多 24 条字段，超出就只保留前 24 条（按上面的优先级）。',
    '- 百分比字段（"49%" 或 0.49 或 49）用 format "percent"。',
    '- 数值为 -1 通常表示「不限量」，这种字段加 "hideWhen": -1，或者用 format "count"（渲染器会把负数显示成「不限量」）。',
    '- 时间戳用 format "datetime"；剩余毫秒数用 "duration_ms"；剩余秒数用 "seconds"。',
    '- 只有当响应里真的存在业务状态码时才写 health；成功值写进 okValues。',
    '- 不要把整段响应塞进 title/subtitle/notes。',
  ].join('\n');
}

function clip(text, limit) {
  if (typeof text !== 'string') return '';
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字符）`;
}

/** 请求的「已经脱敏过」的摘要：头只给名字，查询串打码，body 只给前 500 字符。 */
export function requestSummary(request) {
  if (request === null || typeof request !== 'object') return '（无请求信息）';
  const lines = [`${request.method ?? 'GET'} ${maskForPrompt(request.url)}`];
  const headers = request.headers ?? {};
  for (const [name, value] of Object.entries(headers)) {
    if (/^(cookie|authorization|token|x-api-key|api-key)$/i.test(name)) {
      lines.push(`${name}: <已省略（这是登录凭证，不要参考它的取值）>`);
      continue;
    }
    lines.push(`${name}: ${clip(String(value), 120)}`);
  }
  if (typeof request.body === 'string' && request.body !== '') lines.push(`\nbody: ${clip(request.body, 500)}`);
  return lines.join('\n');
}

function maskForPrompt(url) {
  try {
    const parsed = new URL(url);
    const keys = [...parsed.searchParams.keys()];
    return keys.length === 0 ? url : `${parsed.origin}${parsed.pathname}?${keys.map((key) => `${key}=***`).join('&')}`;
  } catch {
    return String(url);
  }
}

/**
 * 收集一次模型调用的完整文本输出，并做三层兜底。
 *
 * 为什么要兜：这个模型偶尔会「只出思维链不出正文」，或者整段回答只以
 * `block-end` 的形式到达（而非逐字 `text-delta`）。表现都是「空文本」，
 * 但一次空手而归还把整次接入降级成结构兜底，代价太大。三层依次是：
 *   1. 优先用 text-delta 拼接；没有 delta 就取 block-end 里的 text 块；
 *   2. 两者都没有但有 reasoning 内容时，直接从思维链里抠 JSON（抠出来仍要过校验）；
 *   3. 还不行就重试一次（同样的请求），只在第二次仍为空时抛错。
 *
 * @param {object} llm Host 的 llm 服务。
 * @param {{provider: string, model: string, system?: string, messages: unknown[], maxTokens?: number, signal?: AbortSignal}} options
 * @returns {Promise<string>} 模型输出的文本（可能是从思维链里抠出来的 JSON）。
 */
export async function callModelText(llm, options) {
  const attempts = options.attempts ?? 2;
  let lastFailure = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const collected = await streamOnce(llm, options);
    if (collected.text !== '') return collected.text;
    if (collected.reasoningJson !== null) return collected.reasoningJson;
    lastFailure = collected.emptyReason;
  }
  throw new Error(`模型没有返回任何内容（${lastFailure}）；请检查 analysis.provider / analysis.model 是否可用`);
}

/** 跑一次流，收集正文 / 思维链 / 空手原因。 */
async function streamOnce(llm, options) {
  const deltas = [];
  const blocks = [];
  const reasoning = [];
  let failure = null;
  const stream = llm.stream({
    provider: options.provider,
    model: options.model,
    system: options.system ?? SYSTEM_PROMPT,
    messages: options.messages,
    ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
    ...options.signal === undefined ? {} : { signal: options.signal },
  });
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') deltas.push(chunk.text);
    else if (chunk.type === 'block-end' && chunk.block !== null && chunk.block !== undefined && chunk.block.type === 'text') blocks.push(chunk.block.text);
    else if (chunk.type === 'reasoning-delta') reasoning.push(chunk.text);
    else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) failure = chunk.reason.failure;
    else if (chunk.type === 'finish' && chunk.reason.kind === 'max-tokens') failure = { message: 'max-tokens：输出被 maxOutputTokens 截断' };
  }
  if (failure !== null && failure !== undefined) {
    throw new Error(`模型调用失败：${failure.message}${failure.status === undefined ? '' : `（HTTP ${failure.status}）`}`);
  }
  const text = (deltas.length > 0 ? deltas.join('') : blocks.join('')).trim();
  const reasoningText = reasoning.join('').trim();
  // 思维链里出现完整 JSON 时也认：模型把答案写进思考通道是自己的毛病，
  // 但内容仍是它给的，且后面还会过 template.js 的校验。
  const fromReasoning = text === '' && reasoningText !== '' ? extractJson(reasoningText) : null;
  return {
    text,
    reasoningJson: fromReasoning === null ? null : JSON.stringify(fromReasoning),
    emptyReason: reasoningText === '' ? '流里没有正文也没有思维链' : '只有思维链，且其中没有完整 JSON',
  };
}

/**
 * 从模型输出里抠出第一个完整的 JSON 对象。
 *
 * 模型偶尔会裹 ```json 代码块或加一句话，所以这里做宽松提取：找第一个 `{`，
 * 按括号深度扫到配对的 `}`（跳过字符串里的括号）。
 *
 * @param {string} text 模型输出。
 * @returns {object|null} 解析结果。
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced === null ? text : fenced[1];
  const start = body.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(body.slice(start, i + 1));
          return parsed !== null && typeof parsed === 'object' ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 主路径：分析「请求 + 响应」（可选再附一张截图作辅助），产出展示模板。
 *
 * 辅助截图的用途：接口返回一串 `current_interval_used_percent` 时，模型未必知道
 * 「这个字段在页面上叫什么、单位是什么、几十条里哪两条才重要」；给它一张该平台的
 * 用量页面截图，字段命名与分组会明显更贴人类说法。**数字仍以响应为准**，截图只用来
 * 解释含义 —— 这条会写进提示词，避免模型拿图里的旧数字覆盖真实数据。
 *
 * @param {object} llm Host 的 llm 服务。
 * @param {{request: object, response: unknown, label: string, provider: string, model: string, language?: string, maxTokens?: number, signal?: AbortSignal, rawText?: string|null, imageAttachment?: object|null}} options
 * @returns {Promise<{ok: true, raw: object} | {ok: false, error: string}>} raw 是模型给的原始 JSON（由 template.js 校验）。
 */
export async function analyzeResponse(llm, options) {
  const language = options.language === 'en' ? 'en' : 'zh';
  const responseText = options.response === null || options.response === undefined
    ? clip(options.rawText ?? '', RESPONSE_CHAR_LIMIT)
    : clip(JSON.stringify(options.response, null, 2), RESPONSE_CHAR_LIMIT);
  const hasImage = options.imageAttachment !== undefined && options.imageAttachment !== null;
  const prompt = [
    `下面是接口「${options.label}」的一次真实请求与响应${hasImage ? '，另附一张该平台的用量页面截图' : ''}。请把它翻译成展示模板。`,
    '',
    '【请求】',
    requestSummary(options.request),
    '',
    '【响应】',
    responseText,
    ...hasImage
      ? [
        '',
        '【辅助截图】',
        '这张图是该平台用量页面的截图，用来看「这些字段在页面上叫什么、单位是什么、哪几项是人真正在看的」。',
        '硬规则：**数字与状态一律以响应为准**，截图里的数值可能已经过时；截图只用来说明含义、单位与分组命名。',
      ]
      : [],
    '',
    templateContract(language),
  ].join('\n');
  const text = await callModelText(llm, {
    provider: options.provider,
    model: options.model,
    messages: [{
      role: 'user',
      content: [
        ...hasImage ? [{ type: 'image', attachment: options.imageAttachment }] : [],
        { type: 'text', text: prompt },
      ],
    }],
    maxTokens: options.maxTokens,
    signal: options.signal,
  });
  const raw = extractJson(text);
  if (raw === null) return { ok: false, error: `模型输出不是 JSON：${clip(text, 200)}` };
  return { ok: true, raw };
}

/**
 * cURL 解析失败时的兜底：让模型从任意粘贴文本里把请求捞出来。
 *
 * 只认字段名，不认解释 —— 返回的 request 会再走一遍 parseCurl 级别的校验
 * （见调用方 ops.js）。
 */
export async function analyzeRequestText(llm, options) {
  const prompt = [
    '下面是从浏览器 DevTools 或接口文档里复制出来的一段文本。请提取出可以直接重放的 HTTP 请求。',
    '只输出 JSON：{"request": {"method": "...", "url": "https://...", "headers": {"名": "值"}, "body": null 或字符串}, "note": "可选的一句话"}',
    '规则：',
    '- url 必须是完整的 http(s) 地址；能从 Host 头推出就补全。',
    '- headers 只保留原文本里真实出现的头；Cookie 原样保留（它就是要重放的登录态），不要替换成占位符。',
    '- 没有 body 就写 null；method 缺失时按有 body 判断 POST，否则 GET。',
    '',
    '【待提取文本】',
    clip(options.text, 20000),
  ].join('\n');
  const text = await callModelText(llm, {
    provider: options.provider,
    model: options.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: options.maxTokens,
    signal: options.signal,
  });
  const raw = extractJson(text);
  if (raw === null || raw.request === null || typeof raw.request !== 'object') {
    return { ok: false, error: `模型没给出可用请求：${clip(text, 160)}` };
  }
  const url = typeof raw.request.url === 'string' ? raw.request.url.trim() : '';
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '模型给出的 url 不是完整 http(s) 地址' };
  const headers = {};
  if (raw.request.headers !== null && typeof raw.request.headers === 'object') {
    for (const [name, value] of Object.entries(raw.request.headers)) {
      if (typeof value === 'string' && value !== '') headers[String(name).toLowerCase()] = value;
    }
  }
  const body = typeof raw.request.body === 'string' && raw.request.body !== '' ? raw.request.body : null;
  const method = typeof raw.request.method === 'string' && raw.request.method.trim() !== ''
    ? raw.request.method.trim().toUpperCase()
    : body === null ? 'GET' : 'POST';
  return { ok: true, request: { method, url, headers, body }, note: typeof raw.note === 'string' ? raw.note : null };
}

/**
 * 截图识别：读一张用量截图，产出「快照」。
 *
 * 快照与模板的区别：快照没有可重放的请求，因此不能自动刷新 —— 面板会明确标注
 * 数据来源与识别时间，避免把一张旧图当成实时数据。
 *
 * @param {object} llm Host 的 llm 服务。
 * @param {{attachment: object, label: string, provider: string, model: string, language?: string, maxTokens?: number, signal?: AbortSignal}} options
 * @returns {Promise<{ok: true, snapshot: object} | {ok: false, error: string}>}
 */
export async function analyzeImage(llm, options) {
  const language = options.language === 'en' ? 'en' : 'zh';
  const prompt = [
    '这是一张用量 / 额度 / 账单页面的截图。请把图里的数字读出来，组织成便于展示的结构。',
    '只输出 JSON：',
    '{',
    '  "title": "面板标题",',
    '  "subtitle": "可选",',
    '  "kind": "quota | balance | usage | list | generic",',
    '  "primary": { "label": "...", "value": "原样文本", "format": "percent|number|count|currency|text" },',
    '  "metrics": [ { "label": "...", "value": "原样文本", "format": "..." } ],',
    '  "cards": [ { "label": "分组名", "metrics": [ { "label": "...", "value": "...", "format": "..." } ] } ],',
    '  "notes": ["可选：读不清或不确定的地方，直接说明"]',
    '}',
    '规则：',
    '- 只写图里真实看得到的数字，读不清的字段宁可不写，并在 notes 里说明。',
    '- value 保留图里的写法（"49%"、"1,234"、"2026-11-01"）。',
    `- label 用${language === 'zh' ? '中文' : 'English'}。`,
    '- 如果图里同时有多组数据（多个模型 / 多个周期），用 cards 分组。',
  ].join('\n');
  const text = await callModelText(llm, {
    provider: options.provider,
    model: options.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', attachment: options.attachment },
        { type: 'text', text: prompt },
      ],
    }],
    maxTokens: options.maxTokens,
    signal: options.signal,
  });
  const raw = extractJson(text);
  if (raw === null) return { ok: false, error: `模型输出不是 JSON：${clip(text, 200)}` };
  if (raw.primary === undefined && !Array.isArray(raw.metrics) && !Array.isArray(raw.cards)) {
    return { ok: false, error: '模型没能从图里读出可展示的数据' };
  }
  return { ok: true, snapshot: raw };
}

/** 快照（模型读图结果）→ 与模板渲染同构的 view，客户端因此只有一套渲染代码。 */
export function snapshotToView(snapshot, meta = {}) {
  const normalizeValue = (item) => ({
    label: typeof item.label === 'string' && item.label !== '' ? item.label : '字段',
    text: typeof item.value === 'number' ? String(item.value) : String(item.value ?? '—'),
    percent: typeof item.value === 'string' && /%$/.test(item.value) ? Number(item.value.replace('%', '')) : null,
    format: typeof item.format === 'string' ? item.format : 'text',
    tone: null,
  });
  const primary = snapshot.primary !== undefined && snapshot.primary !== null && typeof snapshot.primary === 'object'
    ? normalizeValue(snapshot.primary)
    : null;
  const metrics = Array.isArray(snapshot.metrics) ? snapshot.metrics.filter((item) => item !== null && typeof item === 'object').map(normalizeValue) : [];
  const cards = Array.isArray(snapshot.cards)
    ? snapshot.cards.filter((item) => item !== null && typeof item === 'object').map((item) => ({
      label: typeof item.label === 'string' && item.label !== '' ? item.label : '分组',
      subtitle: typeof item.subtitle === 'string' ? item.subtitle : null,
      percent: null,
      progressLabel: null,
      metrics: Array.isArray(item.metrics) ? item.metrics.filter((entry) => entry !== null && typeof entry === 'object').map(normalizeValue) : [],
    }))
    : [];
  const notes = Array.isArray(snapshot.notes) ? snapshot.notes.filter((item) => typeof item === 'string' && item.trim() !== '').slice(0, 6) : [];
  return {
    version: 1,
    kind: typeof snapshot.kind === 'string' ? snapshot.kind : 'snapshot',
    title: typeof snapshot.title === 'string' && snapshot.title !== '' ? snapshot.title : meta.label ?? '用量',
    subtitle: typeof snapshot.subtitle === 'string' ? snapshot.subtitle : null,
    notes: ['以上数据由模型读取截图得到，无法自动刷新；需要实时数值请粘贴接口请求。', ...notes],
    status: { tone: 'muted', label: '来自截图', message: '非实时：截图识别结果' },
    primary: primary === null ? null : { label: primary.label, text: primary.text, format: primary.format, percent: primary.percent, tone: null },
    progress: null,
    cards,
    metrics,
    fetchedAt: null,
    httpStatus: null,
    readAt: typeof meta.readAt === 'number' ? meta.readAt : Date.now(),
  };
}
