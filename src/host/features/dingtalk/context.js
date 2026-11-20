// src/host/features/dingtalk/context.js
//
// 从「当前会话」里取出项目上下文：工作目录、当前分支、需求号、协议名、最近进展。
//
// 这些是「这条钉钉消息跟我在做的活有没有关系」的判据来源，也是注入给模型的分析
// 上下文。取的是**会话自己的事实**，不是插件的猜测：
//   · 分支 —— 在会话的工作目录里问 git；
//   · 需求号 / 协议名 —— 从会话最近的消息里抽（会话里出现过什么，就是正在做什么）；
//   · 最近进展 —— 会话最后一条用户消息与最后一条助手消息（截断）。
//
// 消息正文不落盘：这里只读会话日志，产物只在内存里传给模型。

import { basename } from 'node:path';
import { runProcess } from '../../shared/cmd.js';
import { extractKeywords, extractReqCodes, narrowKeywords } from './relevance.js';

/** 从会话尾部往回看多少条事件。 */
const EVENT_WINDOW = 80;

/** 最近进展每段最多留多少字。 */
const RECENT_LIMIT = 400;

/** 分支的缓存时长（毫秒）—— 同一次拉取里不必反复问 git。 */
const BRANCH_TTL_MS = 60000;

/**
 * 从一段消息内容里取出纯文本。
 *
 * @param {unknown} content 内容块数组。
 * @returns {string} 拼起来的文本。
 */
function textOf(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * 读会话尾部的事件。
 *
 * @param {object} session 会话。
 * @returns {Array<object>} 事件数组（读不到就是空数组）。
 */
function tailEvents(session) {
  try {
    const seq = typeof session?.seq === 'number' ? session.seq : 0;
    const from = Math.max(0, seq - EVENT_WINDOW);
    const events = session.snapshotEvents(from, seq);
    return Array.isArray(events) ? events : [];
  } catch {
    return [];
  }
}

/**
 * 从会话事件里抽出用户与助手说过的话。
 *
 * @param {object} session 会话。
 * @returns {{user: string, assistant: string, all: string}} 三段文本。
 */
export function recentConversation(session) {
  const events = tailEvents(session);
  let user = '';
  let assistant = '';
  const parts = [];
  for (const event of events) {
    const type = event?.type;
    if (type !== 'user/message' && type !== 'assistant/message' && type !== 'developer/message') continue;
    const text = textOf(event?.data?.message?.content);
    if (text === '') continue;
    parts.push(text);
    if (type === 'user/message') user = text;
    else if (type === 'assistant/message') assistant = text;
  }
  return { user, assistant, all: parts.join('\n') };
}

/**
 * 截断一段文本。
 *
 * @param {string} text 原文。
 * @param {number} limit 上限。
 * @returns {string} 截断后的文本。
 */
function clip(text, limit) {
  const value = typeof text === 'string' ? text : '';
  return value.length <= limit ? value : value.slice(0, limit) + '…';
}

/**
 * 造一个「项目上下文读取器」。
 *
 * @param {{run?: Function}} deps 依赖（run 用来跑 git，便于自检时替换）。
 * @returns {{read: Function}} 读取器。
 */
export function createContextReader(deps = {}) {
  const run = deps.run ?? runProcess;
  const branchCache = new Map();

  /**
   * 问 git 当前分支。
   *
   * @param {string} cwd 工作目录。
   * @returns {Promise<string>} 分支名（不是仓库就是空串）。
   */
  async function branchOf(cwd) {
    if (typeof cwd !== 'string' || cwd === '') return '';
    const cached = branchCache.get(cwd);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < BRANCH_TTL_MS) return cached.value;
    let value = '';
    try {
      const result = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 5000 });
      if (result.ok === true) value = String(result.stdout ?? '').trim();
    } catch {
      value = '';
    }
    branchCache.set(cwd, { at: now, value });
    return value;
  }

  /**
   * 读一个会话的项目上下文。
   *
   * @param {object} agent 活的 Agent。
   * @returns {Promise<{cwd: string, project: string, branch: string, reqCodes: string[], keywords: string[], recent: string}>} 上下文。
   */
  async function read(agent) {
    const session = agent?.session;
    const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : '';
    const conversation = recentConversation(session);
    const branch = await branchOf(cwd);
    const project = cwd === '' ? '' : basename(cwd);

    const reqCodes = extractReqCodes(conversation.all);
    const keywords = narrowKeywords([
      ...extractKeywords(conversation.all),
      ...(project === '' ? [] : [project.toLowerCase()]),
      ...(branch === '' ? [] : [branch.toLowerCase()]),
    ]);

    const recent = [
      conversation.user === '' ? '' : '用户最近说：' + clip(conversation.user, RECENT_LIMIT),
      conversation.assistant === '' ? '' : '助手最近回：' + clip(conversation.assistant, RECENT_LIMIT),
    ].filter((line) => line !== '').join('\n');

    return { cwd, project, branch, reqCodes, keywords, recent };
  }

  return { read };
}
