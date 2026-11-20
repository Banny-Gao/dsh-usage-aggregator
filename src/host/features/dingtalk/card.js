// src/host/features/dingtalk/card.js
//
// 「发钉钉」的动作卡片类型（action kind）。
//
// 契约来自 DSH 内置的 actionCards 服务：模型调 propose_action 提议一次外发 →
// 服务把这次提议记进会话日志 → 用户在卡片上点按钮 → 浏览器调 act() → 本文件
// 执行动作并把结果记回卡片 → 模型在下一轮收到状态通知。
//
// 这里的三条语义边界：
//   1. **模型不能绕过卡片直接发** —— 发送只发生在 act('send') 里，也就是用户点按钮时；
//   2. **同名必须由人选** —— 解析出多个候选就停下，把候选摆到卡片上让用户点；
//   3. **没回查到消息 ID 就不算送达** —— 只报「已提交，未确认送达」。

import { randomUUID } from 'node:crypto';

/** 卡片动作名（propose_action 的 action 字段）。 */
export const ACTION = 'dingtalk.send';

/** createUserMessage 的加载结果：null = 还没试，false = 拿不到，函数 = 可用。 */
let messageFactory = null;

/** 承载这个动作的技能名 —— 模型必须先加载它，卡片才会出现。 */
export const SKILL = 'dingtalk-sofa';

/** 卡片状态（phase）。 */
export const PHASES = {
  /** 已发出并回查到消息 ID。 */
  SENT: 'sent',
  /** 已提交，没回查到消息 ID。 */
  SUBMITTED: 'submitted',
  /** 发送失败，可以重试。 */
  FAILED: 'failed',
  /** 同名多人，等用户选一个。 */
  AMBIGUOUS: 'ambiguous',
  /** 用户要求改稿，等模型出新稿。 */
  REVISING: 'revising',
};

/**
 * 造一个「对象字段校验器」。
 *
 * 刻意不引 zod：actionCards 服务只用 safeParse（成功给 data、失败给
 * error.issues），自己实现就能少一个运行时依赖，装插件时不用多拉一个包。
 *
 * @param {Record<string, {optional?: boolean, maxLength?: number, enum?: string[]}>} fields 字段规则。
 * @returns {{safeParse: Function, parse: Function}} 校验器。
 */
function objectSchema(fields) {
  return {
    safeParse(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return {
          success: false,
          error: { issues: [{ path: [], message: '必须是一个对象' }] },
        };
      }
      const issues = [];
      const data = {};
      for (const key of Object.keys(fields)) {
        const rule = fields[key];
        const raw = value[key];
        if (raw === undefined || raw === null) {
          if (rule.optional === true) continue;
          issues.push({ path: [key], message: '必填' });
          continue;
        }
        if (typeof raw !== 'string') {
          issues.push({ path: [key], message: '必须是字符串' });
          continue;
        }
        const trimmed = raw.trim();
        if (trimmed === '') {
          issues.push({ path: [key], message: '不能为空' });
          continue;
        }
        if (Array.isArray(rule.enum) && !rule.enum.includes(trimmed)) {
          issues.push({ path: [key], message: '只能是 ' + rule.enum.join(' / ') });
          continue;
        }
        if (Number.isFinite(rule.maxLength) && trimmed.length > rule.maxLength) {
          issues.push({
            path: [key],
            message: rule.tooLong ?? ('不能超过 ' + rule.maxLength + ' 个字符'),
          });
          continue;
        }
        data[key] = trimmed;
      }
      if (issues.length > 0) return { success: false, error: { issues } };
      return { success: true, data };
    },
    parse(value) {
      const result = this.safeParse(value);
      if (result.success !== true) throw new Error('details 不符合约定');
      return result.data;
    },
  };
}

/** 卡片 details 的字段约定（模型按这个填）。 */
export const detailsSchema = objectSchema({
  /** 收件人姓名（回显用）。 */
  recipient: { maxLength: 60 },
  /** 已解析的收件人标识（有就带上，省一次通讯录查询）。 */
  recipientId: { optional: true, maxLength: 128 },
  /** recipientId 是哪一种标识（决定用哪个参数发）。 */
  recipientIdKind: { optional: true, enum: ['openDingTalkId', 'userId'] },
  /** 单聊还是群聊。 */
  channel: { optional: true, enum: ['dm', 'group'] },
  /** 为什么发给他 —— 卡片上要给用户看。 */
  reason: { maxLength: 200 },
  /** 拟好的正文。 */
  body: { maxLength: 5000, tooLong: '钉钉单聊正文上限 5000 字，太长请拆成几条或改发文档链接' },
});

/**
 * 造注入给模型的改稿提示。
 *
 * @param {{body: string, reason: string, recipient: string}} details 卡片内容。
 * @param {string} instruction 用户的修改要求（可能为空）。
 * @returns {string} 提示正文。
 */
export function revisionPrompt(details, instruction) {
  const ask = String(instruction ?? '').trim();
  const lines = [
    '【钉钉消息改稿】用户对刚才那张待发卡片点了「改一下」，请重写正文。',
    '',
    '收件人：' + (details?.recipient ?? ''),
    '为什么要发给他：' + (details?.reason ?? ''),
    '',
    '原拟正文：',
    String(details?.body ?? ''),
  ];
  if (ask !== '') {
    lines.push('', '用户的修改要求：', ask);
  } else {
    lines.push('', '用户没有写具体要求：按当前会话里最近的反馈重写，让正文更贴他要表达的意思。');
  }
  lines.push(
    '',
    '改完以后：重新调 propose_action（action 仍是 "' + ACTION + '"），把新正文放进 details.body，' +
    '其余字段照旧。**不要自己发出去** —— 用户会在新卡片上点【发送】。',
  );
  return lines.join('\n');
}

/**
 * 造一个用户角色的消息（用于往会话里注入提示）。
 *
 * 优先用 DSH 官方的 createUserMessage（它会盖上稳定 id 并冻结消息）；
 * 拿不到时退回等价的手写消息 —— 免得整个插件因为一个构造器加载不上。
 *
 * @param {string} text 文本。
 * @returns {Promise<object>} 消息。
 */
export async function userMessage(text) {
  if (messageFactory === null) {
    try {
      const mod = await import('@deepseek-ai/dsh-llm');
      messageFactory = typeof mod.createUserMessage === 'function' ? mod.createUserMessage : false;
    } catch {
      messageFactory = false;
    }
  }
  if (typeof messageFactory === 'function') {
    return messageFactory({
      content: [{ type: 'text', text }],
      source: { kind: 'dingtalk' },
    });
  }
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text }],
    source: { kind: 'dingtalk' },
  };
}

/**
 * 造「发钉钉」这个动作类型。
 *
 * @param {{ops: object, cards: object, now?: Function, inject?: Function}} deps 依赖。
 * @returns {object} 动作类型（交给 actionCards.register）。
 */
export function createSendKind(deps) {
  const ops = deps.ops;
  const cards = deps.cards;
  const now = deps.now ?? (() => Date.now());
  /** 把提示送进会话（默认 agent.followup，注入器可替换）。 */
  const inject = deps.inject ?? (async (agent, text) => {
    agent.followup(await userMessage(text));
  });

  /**
   * 记一次决定。
   *
   * @param {object} agent 会话。
   * @param {object} proposal 卡片提议。
   * @param {string} phase 状态。
   * @param {object} data 状态数据。
   * @returns {{status: string, decision: object}} settled 结果。
   */
  function record(agent, proposal, phase, data) {
    const fields = Object.fromEntries(Object.entries(data ?? {}).filter(([, value]) => value !== undefined));
    const decision = {
      callId: proposal.callId,
      action: ACTION,
      phase,
      ...(Object.keys(fields).length === 0 ? {} : { data: fields }),
    };
    cards.record(agent, decision);
    return { status: 'settled', decision };
  }

  /**
   * 处理「发送」。
   *
   * @param {object} agent 会话。
   * @param {object} proposal 卡片提议。
   * @param {object} payload 用户动作带的数据（选人时带 recipientId）。
   * @returns {Promise<object>} 动作结果。
   */
  async function send(agent, proposal, payload) {
    const details = proposal.details ?? {};
    const previous = cards.view(agent.session).decisions[proposal.callId];
    if (previous !== undefined && previous.phase === PHASES.SENT) {
      return { status: 'settled', decision: previous };
    }

    const recipientId = typeof payload?.recipientId === 'string' && payload.recipientId !== ''
      ? payload.recipientId
      : (details.recipientId ?? '');
    const recipientIdKind = typeof payload?.recipientIdKind === 'string' && payload.recipientIdKind !== ''
      ? payload.recipientIdKind
      : (details.recipientIdKind ?? 'openDingTalkId');
    const channel = details.channel === 'group' ? 'group' : 'dm';

    let person = { name: details.recipient ?? '', userId: '', openDingTalkId: '', department: '' };
    if (channel === 'dm' && recipientId !== '') {
      // 已经解析过（或用户在卡片上选过了）：直接用标识，不再问一次通讯录。
      person = recipientIdKind === 'userId'
        ? { name: details.recipient ?? '', userId: recipientId, openDingTalkId: '', department: '' }
        : { name: details.recipient ?? '', userId: '', openDingTalkId: recipientId, department: '' };
    }
    if (channel === 'dm' && recipientId === '') {
      const resolution = await ops.resolveRecipient(details.recipient ?? '', agent.id);
      if (resolution.status === 'ambiguous') {
        return record(agent, proposal, PHASES.AMBIGUOUS, {
          candidates: resolution.candidates.map((item) => ({
            name: item.name,
            userId: item.userId,
            openDingTalkId: item.openDingTalkId,
            label: ops.labelOf(item),
          })),
        });
      }
      if (resolution.status !== 'resolved') {
        return record(agent, proposal, PHASES.FAILED, {
          error: resolution.error ?? '没找到这个收件人',
        });
      }
      person = resolution.person;
    }

    const startedAt = now();
    const result = await ops.sendMessage({
      recipient: details.recipient ?? '',
      recipientId,
      recipientIdKind,
      channel,
      body: details.body ?? '',
      sessionId: agent.id,
    });

    if (result.status === 'ambiguous') {
      return record(agent, proposal, PHASES.AMBIGUOUS, {
        candidates: result.candidates.map((item) => ({
          name: item.name,
          userId: item.userId,
          openDingTalkId: item.openDingTalkId,
          label: ops.labelOf(item),
        })),
      });
    }
    if (result.status !== 'submitted') {
      return record(agent, proposal, PHASES.FAILED, { error: result.error ?? '发送失败' });
    }

    // openTaskId 是发送任务 ID，不是消息 ID —— 必须回查。
    const receipt = await ops.confirmReceipt({
      person,
      recipientName: details.recipient ?? '',
      body: details.body ?? '',
      sinceMs: startedAt,
    });
    if (receipt.found === true) {
      return record(agent, proposal, PHASES.SENT, { messageId: receipt.messageId, taskId: result.taskId });
    }
    return record(agent, proposal, PHASES.SUBMITTED, { taskId: result.taskId });
  }

  /**
   * 处理「改一下」。
   *
   * @param {object} agent 会话。
   * @param {object} proposal 卡片提议。
   * @param {object} payload 用户动作带的数据（instruction）。
   * @returns {Promise<object>} 动作结果。
   */
  async function revise(agent, proposal, payload) {
    const instruction = typeof payload?.instruction === 'string' ? payload.instruction : '';
    const settled = record(agent, proposal, PHASES.REVISING, { instruction: instruction.trim() });
    await inject(agent, revisionPrompt(proposal.details ?? {}, instruction));
    return settled;
  }

  return {
    action: ACTION,
    skill: SKILL,
    details: detailsSchema,
    invitation:
      '在回答末尾用一句话邀请用户在下面的卡片上点【发送】确认；不要替用户发送，也不要重复卡片里已经写好的正文。',
    verbs: {
      send: { writes: true },
      revise: {},
    },
    // 这两个状态里卡片还开着，用户仍可以「不用了」。
    openPhases: [PHASES.FAILED, PHASES.AMBIGUOUS],
    statusGuidance:
      '钉钉卡片：sent = 已发出并回查到消息 ID；submitted = 已提交但没确认送达，别说成已送达；' +
      'failed = 发送失败，卡片上可以重试；ambiguous = 同名多人，等用户在卡片上选；' +
      'revising = 用户要求改稿，等新稿出来；dismissed = 用户放弃了，别再提这件事。',
    statusFields: ['messageId', 'taskId'],
    act: async (agent, proposal, verb, payload) => {
      if (verb === 'send') return send(agent, proposal, payload);
      if (verb === 'revise') return revise(agent, proposal, payload);
      return { status: 'refused', reason: 'unknown-verb' };
    },
  };
}
