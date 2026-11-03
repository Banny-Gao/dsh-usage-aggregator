// src/client/features/autocomplete/complete.js
//
// 补全的纯计算：候选怎么变成「插进输入框的那一段」、对话上下文怎么摘出来。
//
// 为什么单独一个文件：这两件事决定了「按 Tab 之后输入框里变成什么」——
// 逻辑错一点，用户按了 Tab 看到的就是莫名其妙的一串字。写成纯函数才能单测，
// 不用起浏览器。

/** 上下文里每条消息最多带多少字（再多对模型没用，只是烧 token）。 */
export const CONTEXT_TEXT_LIMIT = 300;

/**
 * 求「插在光标处的那一段」。
 *
 * 模型给的是**一句完整的话**（"帮我分析这段代码的性能瓶颈"），而用户已经打了
 * 半句（"帮我分析"）。按 Tab 时不能把整句再插一遍 —— 那会变成
 * "帮我分析帮我分析这段代码的性能瓶颈"。所以这里找出「草稿结尾」与「候选开头」
 * 的最长重叠，把重叠之后的部分作为要插入的片段。
 *
 * 没有重叠时返回空串：**不自动插**。这时候候选与用户写的不是同一条句子，
 * 硬插只会得到一句怪话；用户点选候选时再整句替换。
 *
 * @param {string} draft 当前草稿。
 * @param {string} suggestion 候选（完整的一句话）。
 * @returns {string} 要插进输入框的片段（空串 = 不该自动插）。
 */
export function completionSuffix(draft, suggestion) {
  if (typeof suggestion !== 'string') return '';
  const text = suggestion.trim();
  if (text === '') return '';
  if (typeof draft !== 'string' || draft.trim() === '') return text;

  // 只看最后一行：光标一般在这一行的末尾，前面的行与重叠无关。
  const lines = draft.split('\n');
  const tail = lines[lines.length - 1];
  const max = Math.min(tail.length, text.length);
  for (let size = max; size > 0; size -= 1) {
    if (tail.slice(tail.length - size) === text.slice(0, size)) return text.slice(size);
  }
  return '';
}

/**
 * 从内容块里摘出纯文本。
 *
 * 内容块是模型的 ContentBlock（text / image 等）；这里只取 text，其余丢掉。
 *
 * @param {unknown} blocks 内容块数组。
 * @returns {string} 文本（可能是空串）。
 */
export function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (block.kind !== 'text') continue;
    if (typeof block.text !== 'string') continue;
    const text = block.text.trim();
    if (text !== '') parts.push(text);
  }
  return parts.join('\n');
}

/**
 * 从 Chat 快照里摘最近几条对话。
 *
 * Chat 的节点形状：node.kind 是渲染器种类（user / steering / assistant-step …），
 * 载荷在 node.data 里（user 的 data.content、assistant-step 的 data.blocks）。
 * 认不出的节点直接跳过 —— 聊天视图的节点种类会变，这里不能写死。
 *
 * @param {object|null} chat Chat 快照。
 * @param {number} limit 最多几条。
 * @returns {Array<{role: string, text: string}>} 上下文条目。
 */
export function contextFromChat(chat, limit) {
  const max = Number.isFinite(limit) ? Math.max(0, Math.min(20, Math.round(limit))) : 0;
  if (max === 0) return [];
  if (chat === null || typeof chat !== 'object') return [];
  const store = chat.nodes;
  if (store === null || typeof store !== 'object' || typeof store.values !== 'function') return [];

  let nodes;
  try {
    nodes = store.values();
  } catch {
    return [];
  }
  if (!Array.isArray(nodes)) return [];

  const out = [];
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue;
    const data = node.data !== null && typeof node.data === 'object' ? node.data : {};
    let role = '';
    let text = '';
    if (node.kind === 'user' || node.kind === 'steering') {
      role = 'user';
      text = textFromBlocks(data.content);
    } else if (node.kind === 'assistant-step') {
      role = 'assistant';
      text = textFromBlocks(data.blocks);
    }
    if (text === '') continue;
    out.push({ role: role, text: text.length > CONTEXT_TEXT_LIMIT ? text.slice(0, CONTEXT_TEXT_LIMIT) : text });
  }
  return out.slice(-max);
}

/**
 * 候选列表里挑一条（用于键盘上下移动）。
 *
 * @param {Array<string>} list 候选。
 * @param {number} index 当前下标。
 * @param {number} delta 移动方向（-1 / +1）。
 * @returns {number} 新的下标（越界时回到另一头）。
 */
export function moveIndex(list, index, delta) {
  const count = Array.isArray(list) ? list.length : 0;
  if (count === 0) return 0;
  const current = Number.isFinite(index) ? index : 0;
  return ((current + delta) % count + count) % count;
}
