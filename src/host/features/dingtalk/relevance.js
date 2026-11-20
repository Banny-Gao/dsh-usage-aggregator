// src/host/features/dingtalk/relevance.js
//
// 粗筛：一条钉钉消息跟「当前项目」有没有关系。
//
// 为什么要插件先筛一遍：唤醒模型是有代价的（一次模型往返 + 一次打扰）。
// 插件能用便宜且确定的信号挡住噪声 —— 需求号、协议名、当前分支 ——
// 模型再去判断「像不像相关」这种语义部分。两层分工，不重复。
//
// 判定口径（有一条命中就算项目内）：
//   · 消息里出现**当前会话正在做**的需求号（REQ-1234 / BUG-1234）；
//   · 消息里出现当前分支名（或它的最后一段）；
//   · 消息里出现会话上下文里的协议名 / 模块名（dsh-usage-aggregator 这种）。
//
// 全部纯函数：不碰 IO、不碰 dsh，好离线自检。

/** 需求 / 缺陷编号的写法。 */
const REQ_PATTERN = /(?:^|[^A-Za-z0-9])(REQ|BUG|ISSUE|需求|问题)[-_ ]?(\d{2,})(?![0-9])/gi;

/** 像协议名 / 模块名的标识符：至少含一个分隔符（点、横线、斜杠、下划线）。 */
const IDENTIFIER_PATTERN = /[A-Za-z][A-Za-z0-9]*(?:[._\-/][A-Za-z0-9]+)+/g;

/** 这些词太常见，当关键词没有区分度。 */
const STOP_WORDS = new Set([
  'e.g', 'i.e', 'etc', 'index.html', 'readme.md', 'package.json',
]);

/**
 * 抽出会话上下文里的需求号 / 缺陷号。
 *
 * @param {string} text 文本。
 * @returns {string[]} 归一化后的编号（REQ-1234 这种，全大写）。
 */
export function extractReqCodes(text) {
  if (typeof text !== 'string' || text === '') return [];
  const out = new Set();
  REQ_PATTERN.lastIndex = 0;
  let match = REQ_PATTERN.exec(text);
  while (match !== null) {
    const prefix = match[1].toUpperCase();
    const label = prefix === '需求' || prefix === '问题' ? 'REQ' : prefix;
    out.add(label + '-' + match[2]);
    match = REQ_PATTERN.exec(text);
  }
  return [...out];
}

/**
 * 抽出文本里像协议名 / 模块名的标识符。
 *
 * @param {string} text 文本。
 * @param {number} limit 最多留几个。
 * @returns {string[]} 关键词（小写去重）。
 */
export function extractKeywords(text, limit = 24) {
  if (typeof text !== 'string' || text === '') return [];
  const out = new Set();
  IDENTIFIER_PATTERN.lastIndex = 0;
  let match = IDENTIFIER_PATTERN.exec(text);
  while (match !== null) {
    const word = match[0];
    const lower = word.toLowerCase();
    if (word.length >= 5 && !STOP_WORDS.has(lower)) out.add(lower);
    match = IDENTIFIER_PATTERN.exec(text);
  }
  return [...out].slice(0, limit);
}

/**
 * 判断一条消息是不是「项目内」。
 *
 * @param {{text: string}} message 消息（至少要 text）。
 * @param {{branch?: string, reqCodes?: string[], keywords?: string[]}} context 当前会话的项目上下文。
 * @returns {{inProject: boolean, reasons: string[]}} 判定结果与命中的理由。
 */
export function classifyMessage(message, context) {
  const text = typeof message?.text === 'string' ? message.text : '';
  const lower = text.toLowerCase();
  const reasons = [];
  if (lower === '') return { inProject: false, reasons };

  const reqCodes = Array.isArray(context?.reqCodes) ? context.reqCodes : [];
  for (const code of reqCodes) {
    if (code !== '' && lower.includes(String(code).toLowerCase())) {
      reasons.push('req');
      break;
    }
  }

  const branch = typeof context?.branch === 'string' ? context.branch.trim() : '';
  if (branch !== '') {
    const tail = branch.includes('/') ? branch.slice(branch.lastIndexOf('/') + 1) : branch;
    if (tail.length >= 3 && lower.includes(tail.toLowerCase())) reasons.push('branch');
  }

  const keywords = Array.isArray(context?.keywords) ? context.keywords : [];
  for (const keyword of keywords) {
    if (typeof keyword !== 'string' || keyword.length < 5) continue;
    if (lower.includes(keyword.toLowerCase())) {
      reasons.push('keyword');
      break;
    }
  }

  return { inProject: reasons.length > 0, reasons };
}

/**
 * 从上下文里挑出「值得拿消息去比」的关键词。
 *
 * 关键词太多会把任何消息都判成项目内，等于没筛。这里按长度与「像不像模块名」
 * 收窄，再限量。
 *
 * @param {string[]} keywords 候选关键词。
 * @param {number} limit 最多留几个。
 * @returns {string[]} 收窄后的关键词。
 */
export function narrowKeywords(keywords, limit = 12) {
  const list = Array.isArray(keywords) ? keywords : [];
  const scored = [];
  for (const keyword of list) {
    if (typeof keyword !== 'string') continue;
    if (keyword.length < 6) continue;
    // 带路径分隔符的更像协议名 / 接口名，权重高一点。
    const weight = keyword.includes('/') ? 3 : keyword.includes('.') ? 2 : 1;
    scored.push({ keyword, weight });
  }
  scored.sort((a, b) => b.weight - a.weight || b.keyword.length - a.keyword.length);
  return scored.slice(0, limit).map((item) => item.keyword);
}
