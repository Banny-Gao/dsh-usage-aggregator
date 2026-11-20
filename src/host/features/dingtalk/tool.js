// src/host/features/dingtalk/tool.js
//
// Agent 入口：两个小工具。
//
//   dingtalk_read  —— 拉钉钉上 @我 / 未读会话的消息（只读，不动手）
//   dingtalk_find  —— 按姓名解析收件人，返回候选
//
// 为什么只有这两个：dws 的 shortcut 有几十条，全摊成工具等于把 CLI 的形状直接
// 灌进模型的选择里。发消息走**卡片**（模型提议 → 用户点按钮），不占工具位；
// 剩下的日常需求就是「看看有什么新消息」和「这人是谁」。

import { formatTime } from './shapes.js';

/** 列表里每条消息最多带多少字的正文。 */
const SNIPPET_LIMIT = 160;

/**
 * 造 dingtalk_read 工具。
 *
 * @param {{ops: object}} deps 依赖。
 * @returns {object} ToolDefinition。
 */
export function createReadTool(deps) {
  const ops = deps.ops;
  return {
    name: 'dingtalk_read',
    description: [
      '拉取钉钉上 @我的消息与未读会话，返回一份精简清单（发送者、时间、正文片段、messageId）。',
      '这是**只读**的：拉到之后不要替用户处理，也不要自动回复 —— 要不要处理由用户决定。',
      '用户问「钉钉有什么新消息」「谁找我」「有没有人 @ 我」时用它。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: {
          type: 'number',
          description: '最多返回几条（默认 20）。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
          count: { type: 'number' },
        },
      },
      render(_args, value) {
        const payload = value !== null && typeof value === 'object' ? value : {};
        if (payload.ok === false) return [{ type: 'text', text: '读钉钉消息失败：' + (payload.error ?? '未知原因') }];
        return [{ type: 'text', text: typeof payload.text === 'string' ? payload.text : JSON.stringify(payload, null, 2) }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const input = args !== null && typeof args === 'object' ? args : {};
      const limit = Number.isFinite(input.limit) && input.limit > 0 ? Math.min(50, Math.round(input.limit)) : 20;
      const result = await ops.readMessages({ limit });
      if (result.ok !== true) return { ok: false, error: result.error ?? '拉取失败' };
      const messages = result.messages;
      if (messages.length === 0) return { ok: true, count: 0, text: '没有新的 @我 消息。' };
      const lines = messages.map((message) => {
        const time = formatTime(message.createTime);
        const who = message.sender === '' ? '（未知发送者）' : message.sender;
        const snippet = message.text.length > SNIPPET_LIMIT ? message.text.slice(0, SNIPPET_LIMIT) + '…' : message.text;
        return '- ' + who + (time === '' ? '' : ' · ' + time) + '：' + snippet +
          (message.messageId === '' ? '' : '（messageId: ' + message.messageId + '）');
      });
      return { ok: true, count: messages.length, text: '钉钉上的新消息：\n' + lines.join('\n') };
    },
  };
}

/**
 * 造 dingtalk_find 工具。
 *
 * @param {{ops: object}} deps 依赖。
 * @returns {object} ToolDefinition。
 */
export function createFindTool(deps) {
  const ops = deps.ops;
  return {
    name: 'dingtalk_find',
    description: [
      '按姓名在钉钉通讯录里找收件人，返回候选（姓名 + 唯一标识片段 + 标识本身）。',
      '命中唯一一个人时把它填进 propose_action 的 details.recipientId；',
      '有多个候选时**不要挑第一个** —— 把候选列给用户选，拿到选择再继续。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          description: '要找的人的姓名（照用户原话完整传，不要截断或改写）。',
        },
      },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          status: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render(_args, value) {
        const payload = value !== null && typeof value === 'object' ? value : {};
        return [{ type: 'text', text: typeof payload.text === 'string' ? payload.text : JSON.stringify(payload, null, 2) }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {};
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (name === '') return { ok: false, status: 'not-found', text: '没有给出姓名。' };
      const sessionId = exec?.agent?.id ?? '';
      const resolution = await ops.resolveRecipient(name, sessionId);
      if (resolution.status === 'resolved') {
        const person = resolution.person;
        return {
          ok: true,
          status: 'resolved',
          text: '找到唯一一个人：' + ops.labelOf(person) + '\n收件人标识（填进 details.recipientId）：' +
            (person.openDingTalkId || person.userId),
        };
      }
      if (resolution.status === 'ambiguous') {
        const lines = resolution.candidates.map((person) => '- ' + ops.labelOf(person) + '（' + (person.department || '未知部门') + '）');
        return {
          ok: true,
          status: 'ambiguous',
          text: '有多个同名的人，**不要自己挑**，请把下面的候选列给用户选：\n' + lines.join('\n'),
        };
      }
      if (resolution.status === 'not-found') {
        return { ok: false, status: 'not-found', text: resolution.error ?? '没找到这个人。' };
      }
      return { ok: false, status: 'error', text: resolution.error ?? '查通讯录失败。' };
    },
  };
}
