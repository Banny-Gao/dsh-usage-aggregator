// src/host/features/dingtalk/receiver.js
//
// 收钉钉消息的那一半：拉取 → 粗筛 → 注入分析 → 让模型问你要不要处理。
//
// 关键取舍：**项目外的消息不打扰模型**。项目外的进「待处理清单」，由页面上的
// 小徽标提示你；要不要处理由你点。真正唤醒模型只发生在项目内的消息上。
//
// 清单里收什么（用户定的规矩）：**明确 @我 的** + **命中项目判据的**。
// 群里别人回复别人、机器人自动播报都不进清单 —— 只累未读计数。
//
// 消息正文不落盘：seen 里只留 messageId 集合；待处理清单里的正文**只在内存里**
// 留一句摘要，处理掉或忽略后即从清单里消失。

import { classifyMessage } from './relevance.js';
import { formatTime } from './shapes.js';

/** seen 集合的上限 —— 免得长时间运行把它撑大。 */
const SEEN_LIMIT = 2000;

/** 待处理清单的上限 —— 多了页面上的徽标就没法一眼看完。 */
const PENDING_LIMIT = 50;

/** 清单里留多长的正文摘要。 */
const EXCERPT_LIMIT = 80;

/**
 * 取一句摘要。
 *
 * @param {string} text 正文。
 * @returns {string} 摘要。
 */
function excerptOf(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_LIMIT ? flat : flat.slice(0, EXCERPT_LIMIT) + '…';
}

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
  /** 待处理清单：页面上的小徽标按它提示你。 */
  let pending = [];
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

      // 第一轮只做基线：历史消息不该在一打开功能时就变成一屏分析，
      // 也不该一开就把徽标点亮 —— 那一屏是你打开功能之前就有的。
      const first = baselined === false;
      baselined = true;

      const relevant = [];
      const added = [];
      for (const message of fresh) {
        const verdict = classifyMessage(message, context);
        const inProject = verdict.inProject === true;
        if (!inProject) unread += 1;
        if (inProject) {
          relevant.push({
            label: message.sender === '' ? '（未知发送者）' : message.sender,
            kind: message.conversationId === '' ? '单聊' : '会话',
            time: formatTime(message.createTime),
            text: message.text,
          });
        }
        // 什么进「待处理清单」（用户定的规矩）：
        //   · 明确 @我 的 —— 有人在找我，一定要我看见；
        //   · 命中项目判据的（需求号 / 分支 / 协议名）—— 哪怕没 @ 我，也可能是我的活。
        // 群里别人回复别人、机器人自动播报这类，**不进清单**，只累未读计数 ——
        // 否则清单会被噪声淹掉，真正的 @我 反而看不见。
        if (!first && (message.at === true || inProject)) {
          added.push(pendingItem(message, context, verdict, agent, inProject));
        }
      }

      if (added.length > 0) {
        pending = pending.concat(added);
        if (pending.length > PENDING_LIMIT) pending = pending.slice(pending.length - PENDING_LIMIT);
      }

      lastPoll = {
        at: now(),
        count: fresh.length,
        relevant: relevant.length,
        baselined: first ? relevant.length : 0,
        error: '',
      };

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

  /**
   * 造一条待处理条目。
   *
   * 记下「当初这条消息被路由到了哪个会话」—— 点【处理】时好回到那个会话去；
   * 项目外的消息没有路由，记下来的是当时那个会话的项目上下文（cwd / 分支），
   * 供「新开会话处理」时把新会话开在正确的目录里。
   *
   * @param {object} message 消息。
   * @param {object} context 判定时的会话上下文。
   * @param {{reasons: string[]}} verdict 粗筛结论。
   * @param {object|null} agent 判定时的会话。
   * @param {boolean} inProject 是否项目内。
   * @returns {object} 待处理条目。
   */
  function pendingItem(message, context, verdict, agent, inProject) {
    const id = message.messageId !== ''
      ? message.messageId
      : 'x-' + excerptOf(message.text).slice(0, 24) + '@' + message.createTime;
    return {
      id,
      sender: message.sender === '' ? '（未知发送者）' : message.sender,
      excerpt: excerptOf(message.text),
      at: message.createTime,
      chatName: message.chatName,
      conversationId: message.conversationId,
      inProject,
      // 是不是明确 @我 的（清单里的「@我」标记）。
      at: message.at === true,
      reasons: Array.isArray(verdict?.reasons) ? verdict.reasons : [],
      sessionId: inProject && agent !== null ? agent.id : '',
      cwd: typeof context?.cwd === 'string' ? context.cwd : '',
      branch: typeof context?.branch === 'string' ? context.branch : '',
      reqCodes: Array.isArray(context?.reqCodes) ? context.reqCodes : [],
    };
  }

  return {
    poll,
    markActive,
    clearUnread,
    pickAgent,
    /** 待处理清单（页面上的小徽标按它提示）。 */
    pending() {
      return { items: pending.map((item) => ({ ...item })), count: pending.length };
    },
    /** 把一条从清单里去掉（用户点【忽略】或已经处理完）。 */
    ignore(id) {
      const key = String(id ?? '');
      const before = pending.length;
      pending = pending.filter((item) => item.id !== key);
      return { ok: true, removed: before - pending.length };
    },
    status() {
      return {
        unread,
        baselined,
        pendingCount: pending.length,
        lastPollAt: lastPoll.at,
        lastPollCount: lastPoll.count,
        lastRelevant: lastPoll.relevant,
        lastBaselined: lastPoll.baselined,
        lastError: lastPoll.error,
      };
    },
  };
}
