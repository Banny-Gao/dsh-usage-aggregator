// src/host/features/autocomplete/analyze.js
//
// 补全分析：把「对话上下文 + 用户正在打的字」变成几条候选。
//
// 一次模型调用给一个答案，输出是 JSON：{"suggestions": ["...", "..."]}。
//
// 两条硬规则：
//   1. **模型只产出候选文本**，取数与格式化都不归它管（与另外两个功能一致）。
//   2. 模型不可用不是错误 —— 补全是「锦上添花」，模型挂了就返回空列表，
//      面板上什么都不显示，绝不弹错误打断用户打字。

import { callModelText, extractJson } from '../../shared/llm.js';

/** 送去分析的提示词：只输出 JSON，不客套。 */
const SYSTEM_PROMPT = [
  '你是一个「输入框补全」助手。',
  '用户正在对话输入框里打字，你要给出他接下来最可能写的内容。',
  '你的唯一产出是一段 JSON，不能有解释文字、不能有多余的开场白。',
].join('\n');

/**
 * provider|model → 最省力的思考档位（查不到就是 null）。
 *
 * 为什么要挑「最省力的那档」：补全是**要快**的功能 —— 用户停下打字的那一刻
 * 就在等结果。思考档位越高，模型想得越久，候选来得越晚。efforts 是按
 * 「从低到高」排的，所以取第一个就是最省力的那档。
 *
 * 缓存的理由：问一次就够，模型列表不会在一次会话里变。
 */
const effortCache = new Map();

/**
 * 查这个模型支持的最省力思考档位。
 *
 * @param {object} llm Host 的 llm 服务。
 * @param {string} provider provider。
 * @param {string} model 模型。
 * @returns {Promise<string|null>} effort id；不该传就返回 null。
 */
export async function lowestReasoningEffort(llm, provider, model) {
  const key = `${provider}|${model}`;
  if (effortCache.has(key)) return effortCache.get(key);
  let effort = null;
  try {
    // llm 服务有 resolveModelInfo 才能问；旧版本没有就当「没有思考档」。
    if (llm !== null && llm !== undefined && typeof llm.resolveModelInfo === 'function') {
      const info = await llm.resolveModelInfo(provider, model);
      const reasoning = info !== null && typeof info === 'object' ? info.reasoning : null;
      const efforts = reasoning !== null && typeof reasoning === 'object' && Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
      if (efforts.length > 0 && efforts[0] !== null && typeof efforts[0] === 'object' && typeof efforts[0].id === 'string') {
        effort = efforts[0].id;
      }
    }
  } catch {
    // 查不到就不传 —— 让模型用它自己的默认档。
    effort = null;
  }
  effortCache.set(key, effort);
  return effort;
}

/**
 * 把上下文条目规范化。
 *
 * 客户端送来的可能是 {role, text}，也可能直接是字符串 —— 两种都收。
 *
 * @param {unknown} raw 原始条目。
 * @returns {{role: string, text: string}|null} 规范化条目。
 */
export function normalizeContextEntry(raw) {
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text === '' ? null : { role: 'user', text: text };
  }
  if (raw === null || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (text === '') return null;
  const role = raw.role === 'assistant' ? 'assistant' : 'user';
  return { role: role, text: text };
}

/**
 * 从模型输出里取出候选列表。
 *
 * 为什么要这么严：模型偶尔会带序号、带引号、带「建议：」前缀，还可能返回
 * 对象而不是数组。这些都要在这里被清掉 —— 候选文本是**要直接插进输入框的**，
 * 带上任何装饰都会变成用户看得见的垃圾。
 *
 * @param {unknown} raw 模型给的原始值。
 * @param {number} limit 最多几条。
 * @returns {string[]} 干净的候选文本。
 */
export function parseSuggestions(raw, limit) {
  const max = Number.isFinite(limit) ? Math.max(0, Math.min(8, Math.round(limit))) : 3;
  if (max === 0) return [];
  const list = Array.isArray(raw) ? raw : (raw !== null && typeof raw === 'object' && Array.isArray(raw.suggestions) ? raw.suggestions : []);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    let text = item.trim();
    // 去掉模型爱加的包装：序号、"引号"、markdown 粗体。
    text = text.replace(/^\s*\d+[.、)]\s*/, '');
    text = text.replace(/^[-*•]\s*/, '');
    text = text.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '');
    text = text.replace(/\*\*/g, '').replace(/^`|`$/g, '').trim();
    if (text === '') continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 拼提示词。
 *
 * @param {{draft: string, context: Array<object>, limit: number}} input 输入。
 * @returns {string} 提示词正文。
 */
export function buildPrompt(input) {
  const draft = typeof input.draft === 'string' ? input.draft : '';
  const context = Array.isArray(input.context) ? input.context : [];
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(8, Math.round(input.limit))) : 3;

  const lines = [];
  lines.push('【最近的对话】');
  if (context.length === 0) {
    lines.push('（还没有对话记录）');
  } else {
    for (const entry of context) {
      const normalized = normalizeContextEntry(entry);
      if (normalized === null) continue;
      lines.push(`${normalized.role === 'assistant' ? '助手' : '用户'}：${normalized.text}`);
    }
  }
  lines.push('');
  lines.push('【用户正在输入的内容】');
  lines.push(draft === '' ? '（还没输入）' : draft);
  lines.push('');
  lines.push(`请给出 ${limit} 条候选，按「最可能」排序。`);
  if (draft === '') {
    // 空输入 = 「你下一句想说什么」。这时**全靠上下文**，所以要求写得具体：
    // 泛泛的「帮我写代码」没有价值，说得出对话里那个具体东西才有。
    lines.push('- 用户**还没开始打字**。结合上面的对话，猜他此刻最可能想问的完整一句话。');
    lines.push('- 必须**贴着上面的对话**：提到对话里出现过的具体东西（文件名、函数名、接口、刚才那个结论），不要给「帮我写代码」这种放之四海皆准的废话。');
    lines.push('- 站在「刚看完助手回答、准备追问或推进下一步」的位置：可以是追问细节、可以是让他动手改、也可以是换个方向。');
  } else {
    lines.push('- 用户**已经在输入**了。第一条必须**接着他写下去**（以他已输入的结尾开头），其余给出不同走向的候选。');
    lines.push('- 后几条也要贴合上面的对话：是他真的会问的下一句，不是换个说法重复他正在写的那句。');
  }
  lines.push('- 每条都是要放进输入框的**纯文本**：不加引号、不加 markdown、不写「建议：」这类前缀。');
  lines.push('- 与用户已输入的内容同语言；用户写中文就回中文。');
  lines.push('- 每条不超过 40 个字，不要复述用户已经写过的部分。');
  lines.push('');
  lines.push('输出这个 JSON（不要多余键）：');
  lines.push('{"suggestions": ["...", "..."]}');
  return lines.join('\n');
}

/**
 * 跑一次补全分析。
 *
 * @param {object} options 选项。
 * @param {object|null} options.llm Host 的 llm 服务（没有就退成空列表）。
 * @param {string} options.provider 模型 provider。
 * @param {string} options.model 模型。
 * @param {string} options.draft 用户正在输入的内容。
 * @param {Array<object>} options.context 最近的对话。
 * @param {number} options.limit 最多几条。
 * @param {number} [options.maxTokens] 输出上限。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @returns {Promise<{suggestions: string[], source: string}>} 候选与来源。
 */
export async function analyzeCompletion(options) {
  const limit = Number.isFinite(options.limit) ? options.limit : 3;
  if (options.llm === null || options.llm === undefined) return { suggestions: [], source: 'none' };
  if (typeof options.provider !== 'string' || options.provider === '' || typeof options.model !== 'string' || options.model === '') {
    return { suggestions: [], source: 'none' };
  }

  try {
    // 补全要快：能挑最省力的思考档就挑（模型不支持思考时这里是 null）。
    const reasoningEffort = await lowestReasoningEffort(options.llm, options.provider, options.model);
    const text = await callModelText(options.llm, {
      provider: options.provider,
      model: options.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(options) }] }],
      maxTokens: options.maxTokens,
      ...reasoningEffort === null ? {} : { reasoningEffort: reasoningEffort },
      signal: options.signal,
    });
    const raw = extractJson(text);
    if (raw === null) return { suggestions: [], source: 'none' };
    const suggestions = parseSuggestions(raw, limit);
    return { suggestions: suggestions, source: suggestions.length > 0 ? 'model' : 'none' };
  } catch {
    // 模型不可用不是错误 —— 补全退成「没有建议」，面板上什么都不显示。
    return { suggestions: [], source: 'none' };
  }
}
