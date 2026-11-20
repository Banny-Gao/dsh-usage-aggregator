// src/host/features/dingtalk/receiver.js
//
// 收钉钉消息的那一半：拉取 → 粗筛 → 注入分析 → 让模型问你要不要处理。
//
// 关键取舍：**项目外的消息不打扰**。项目外的只累一个未读计数（面板上看得到），
// 不唤醒模型、不挂卡片；用户主动问「钉钉有什么新消息」时再用 dingtalk_read 拉。
//
// 消息正文不落盘：seen 里只留 messageId 集合，未读只留计数。

import { classifyMessage } from './relevance.js';
import { formatTime } from './shapes.js';

/** seen 集合的上限 —— 免得长时间运行把它撑大。 */
const SEEN_LIMIT = 2000;

/**
 * 造一个消息接收器。
 *
 * @param {{ops: object, agents: object, contextReader: object, inject: Function, now?: Function, log?: Function}} deps 依赖。
 * @returns {object} 接收器。
 */
export function createReceiver(deps) {
  const ops = deps.ops;
  const agents = deps.agents;
  const contextReader = deps.contextReader;
  const inject = deps.inject;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});

  /** 已经看过的消息 id（只留 id，不留正文）。 */
  const seen = new Set();
  /** 会话 id → 最近活跃时间。 */
  const activity = new Map();
  /** 项目外消息的未读计数。 */
  let unread = 0;
  /** 最近一次拉取的结果摘要。 */
  let lastPoll = { at: 0, count: 0, relevant: 0, baselined: 0, error: '' };
  /** 正在跑的轮询（避免叠轮询）。 */
  let running = false;
  /** 第一轮只做基线（不注入分析），免得刚打开功能就被一屏旧消息砸醒。 */
  let baselined = false;

  /**
   * 记一次会话活动。
   *
   * @param {string} sessionId 会话 id。
   */
  function markActive(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') activity.set(sessionId, now());
  }

  /**
   * 挑一个「最近活跃的」live 会话。
   *
   * @returns {object|null} Agent（没有就 null）。
   */
  function pickAgent() {
    let list = [];
    try {
      list = agents.roots();
    } catch {
      list = [];
    }
    if (!Array.isArray(list) || list.length === 0) return null;
    let best = null;
    let bestAt = -1;
    let bestSeq = -1;
    for (const agent of list) {
      // 活跃时间是主序；没有记录过活跃时退回「会话日志最长」—— 那通常也是刚干过活的。
      const at = activity.get(agent.id) ?? 0;
      const seq = typeof agent?.session?.seq === 'number' ? agent.session.seq : 0;
      if (at > bestAt || (at === bestAt && seq > bestSeq)) {
        bestAt = at;
        bestSeq = seq;
        best = agent;
      }
    }
    return best;
  }

  /**
   * 造注入给模型的分析提示。
   *
   * @param {Array<object>} messages 命中的消息。
   * @param {object} context 会话上下文。
   * @returns {string} 提示正文。
   */
  function analysisPrompt(messages, context) {
    const lines = [
      '【钉钉新消息 · 先分析，不要动手】',
      '',
      '下面这几条是钉钉上 @我 或未读会话里与**当前项目**沾边的消息。',
      '',
    ];
    for (const message of messages) {
      lines.push('· 来源：' + message.label + '（' + message.kind + '）' + (message.time === '' ? '' : ' · ' + message.time));
      lines.push('  原文：' + message.text);
      lines.push('');
    }
    lines.push('当前会话在做什么：');
    lines.push('- 工作目录：' + (context.cwd === '' ? '（未知）' : context.cwd));
    lines.push('- 当前分支：' + (context.branch === '' ? '（不在 git 仓库里）' : context.branch));
    lines.push('- 正在做的需求：' + (context.reqCodes.length === 0 ? '（会话里没出现需求号）' : context.reqCodes.join('、')));
    if (context.recent !== '') lines.push('- 最近进展：' + context.recent);
    lines.push('');
    lines.push('请**只做分析，不要动手**：不要查代码、不要调接口、不要起草回复、不要发钉钉。产出三段：');
    lines.push('① 这条消息在说什么（摘要）；');
    lines.push('② 它和当前项目的关系；');
    lines.push('③ 建议我做什么。');
    lines.push('');
    lines.push('然后用 ask_user_question 问我要不要处理（选项：处理 / 忽略 / 改成……）。');
    lines.push('我点「处理」之前，不要执行任何动作。');
    return lines.join('\n');
  }

  /**
   * 拉一轮。
   *
   * @returns {Promise<{ok: boolean, count: number, relevant: number, error?: string}>} 结果。
   */
  async function poll() {
    if (running) return { ok: true, count: 0, relevant: 0, error: '' };
    running = true;
    try {
      const result = await ops.readMessages({});
      if (result.ok !== true) {
        lastPoll = { at: now(), count: 0, relevant: 0, baselined: 0, error: result.error ?? '拉取失败' };
        return { ok: false, count: 0, relevant: 0, error: lastPoll.error };
      }

      const fresh = result.messages.filter((message) => {
        if (message.messageId === '') return true;
        if (seen.has(message.messageId)) return false;
        seen.add(message.messageId);
        return true;
      });
      if (seen.size > SEEN_LIMIT) {
        // 只留最近的一段：seen 是集合，丢掉最早插入的那些。
        const keep = [...seen].slice(-Math.floor(SEEN_LIMIT / 2));
        seen.clear();
        for (const id of keep) seen.add(id);
      }

      const agent = pickAgent();
      const context = agent === null
        ? { cwd: '', project: '', branch: '', reqCodes: [], keywords: [], recent: '' }
        : await contextReader.read(agent);

      const relevant = [];
      for (const message of fresh) {
        const verdict = classifyMessage(message, context);
        if (verdict.inProject !== true) {
          unread += 1;
          continue;
        }
        relevant.push({
          label: message.sender === '' ? '（未知发送者）' : message.sender,
          kind: message.conversationId === '' ? '单聊' : '会话',
          time: formatTime(message.createTime),
          text: message.text,
        });
      }

      const first = baselined === false;
      baselined = true;
      lastPoll = {
        at: now(),
        count: fresh.length,
        relevant: relevant.length,
        baselined: first ? relevant.length : 0,
        error: '',
      };

      // 第一轮只做基线：历史消息不该在一打开功能时就变成一屏分析。
      // 想知道历史消息，用户主动问「钉钉有什么新消息」（dingtalk_read）。
      if (!first && relevant.length > 0 && agent !== null) {
        await inject(agent, analysisPrompt(relevant, context));
        markActive(agent.id);
      }
      return { ok: true, count: fresh.length, relevant: relevant.length };
    } catch (error) {
      const message = error?.message ?? String(error);
      lastPoll = { at: now(), count: 0, relevant: 0, baselined: 0, error: message };
      log('拉取钉钉消息失败：' + message);
      return { ok: false, count: 0, relevant: 0, error: message };
    } finally {
      running = false;
    }
  }

  /**
   * 未读计数清零（用户在面板上看过之后）。
   */
  function clearUnread() {
    unread = 0;
  }

  return {
    poll,
    markActive,
    clearUnread,
    pickAgent,
    status() {
      return {
        unread,
        baselined,
        lastPollAt: lastPoll.at,
        lastPollCount: lastPoll.count,
        lastRelevant: lastPoll.relevant,
        lastBaselined: lastPoll.baselined,
        lastError: lastPoll.error,
      };
    },
  };
}
