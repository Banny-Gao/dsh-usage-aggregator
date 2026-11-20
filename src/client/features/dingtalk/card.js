// src/client/features/dingtalk/card.js
//
// 「发钉钉」卡片的正文（浏览器半边）。
//
// 宿主给的卡片框架负责外框、标题与折叠；本文件负责这块能力自己的东西：
// 收件人（姓名 + 唯一标识片段）、为什么要发他、拟好的正文、三个按钮
// （发送 / 改一下 / 不用了），以及发送之后的真实状态。
//
// 三个语义都在这里守住：
//   · **发不发由用户点** —— 发送只发生在点【发送】的那一刻；
//   · **同名由用户选** —— 候选直接摆出来，点一个就是「发给这个人」；
//   · **没回查到消息 ID 就不算送达** —— 状态行照实说「已提交，未确认送达」。
//
// 版式照宿主抄：顶部一条低对比度标题带 + 中间内容 + 底部动作条；
// 按钮与输入框的形状取自宿主的 Button / Input 原语（见 styles.js 的说明）。
//
// 不引 UI 组件库：自己写按钮与样式，只用 --dsw-alias-* 主题 token。

import { h, useState } from '../../runtime.js';
import { Styles } from './styles.js';

/** 卡片里各类拒绝原因对应的文案键。 */
const REASON_KEYS = {
  ambiguous: 'statusAmbigous',
  'not-found': 'statusFailed',
  unknown: 'statusFailed',
  unavailable: 'statusFailed',
  'access-denied': 'statusFailed',
  'not-live-root': 'statusFailed',
  closing: 'statusFailed',
  'unknown-verb': 'statusFailed',
};

/**
 * 取唯一标识的尾片段。
 *
 * @param {string} id 标识。
 * @returns {string} 片段（没有就是空串）。
 */
export function idHint(id) {
  const value = typeof id === 'string' ? id.trim() : '';
  if (value === '') return '';
  return value.length <= 6 ? value : '…' + value.slice(-4);
}

/**
 * 从提议里读出 details 的字符串字段。
 *
 * @param {object} proposal 卡片提议。
 * @returns {{recipient: string, recipientId: string, channel: string, reason: string, body: string}} 字段。
 */
export function readDetails(proposal) {
  const raw = proposal?.details !== null && typeof proposal?.details === 'object' ? proposal.details : {};
  const text = (value) => (typeof value === 'string' ? value : '');
  return {
    recipient: text(raw.recipient),
    recipientId: text(raw.recipientId),
    channel: text(raw.channel) === 'group' ? 'group' : 'dm',
    reason: text(raw.reason),
    body: text(raw.body),
  };
}

/**
 * 卡片当前处于什么状态（顶部徽标 + 正文下方的状态行）。
 *
 * @param {string|undefined} phase 卡片状态。
 * @param {object} data 状态数据。
 * @param {Function} t translator。
 * @returns {{badge: {text: string, tone: string}, line: {text: string, tone: string}|null}} 状态描述。
 */
export function describeState(phase, data, t) {
  if (phase === undefined) {
    return { badge: { text: t('badgePending'), tone: '' }, line: null };
  }
  if (phase === 'sent') {
    return {
      badge: { text: t('badgeSent'), tone: 'is-ok' },
      line: { text: t('statusSent', { id: String(data.messageId ?? '') }), tone: 'is-ok' },
    };
  }
  if (phase === 'submitted') {
    return {
      badge: { text: t('badgeSubmitted'), tone: 'is-warn' },
      line: { text: t('statusSubmitted'), tone: 'is-warn' },
    };
  }
  if (phase === 'failed') {
    return {
      badge: { text: t('badgeFailed'), tone: 'is-error' },
      line: { text: t('statusFailed', { error: String(data.error ?? '') }), tone: 'is-error' },
    };
  }
  if (phase === 'ambiguous') {
    return {
      badge: { text: t('badgeAmbiguous'), tone: 'is-warn' },
      line: { text: t('statusAmbigous'), tone: 'is-warn' },
    };
  }
  if (phase === 'revising') {
    return {
      badge: { text: t('badgeRevising'), tone: 'is-info' },
      line: { text: t('statusRevising'), tone: 'is-info' },
    };
  }
  if (phase === 'dismissed') {
    return { badge: { text: t('badgeDismissed'), tone: 'is-muted' }, line: null };
  }
  return { badge: { text: t('badgePending'), tone: '' }, line: null };
}

/**
 * 卡片正文。
 *
 * @param {object} props 宿主给的属性。
 * @returns {object} React 元素。
 */
export function DingtalkCardBody(props) {
  const t = props.t;
  const details = readDetails(props.proposal);
  const decision = props.decision;
  const phase = decision?.phase;
  const data = decision?.data !== null && typeof decision?.data === 'object' ? decision.data : {};

  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [instruction, setInstruction] = useState('');

  const busy = pending !== '';
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const state = describeState(phase, data, t);
  // 失败与同名两种状态还可以再点「发送」；其余状态卡片已经定了，不再给动作。
  const settled = phase !== undefined && phase !== 'failed' && phase !== 'ambiguous';

  /**
   * 发一个用户动作。
   *
   * @param {string} verb 动作名。
   * @param {object} [payload] 动作数据。
   */
  const run = async (verb, payload) => {
    setPending(verb);
    setError('');
    try {
      const result = await props.act(verb, payload);
      if (result === undefined) setError(t('transport'));
      else if (result.status === 'refused' || result.status === 'unconfirmed') {
        const key = REASON_KEYS[result.reason];
        setError(key !== undefined ? t(key) : t('statusFailed', { error: String(result.reason) }));
      }
    } catch {
      setError(t('transport'));
    } finally {
      setPending('');
    }
  };

  return h(
    'div',
    { className: 'dsh-dt-root' },
    h(Styles, null),

    h('header', { className: 'dsh-dt-head' },
      h('span', null, t('heading')),
      h('span', { className: 'dsh-dt-badge ' + state.badge.tone }, state.badge.text)
    ),

    h('div', { className: 'dsh-dt-body' },
      // 标题与「为什么发」是框架给的（标题 16px、brief 13px 次级色）。
      props.summary,

      h('dl', { className: 'dsh-dt-meta' },
        h('dt', null, t('to')),
        h('dd', null,
          details.recipient === '' ? '—' : details.recipient,
          details.recipientId === '' ? null : h('span', { className: 'dsh-dt-idhint' }, '（' + idHint(details.recipientId) + '）'),
          h('span', { className: 'dsh-dt-tag' }, details.channel === 'group' ? t('channelGroup') : t('channelDm'))
        ),
        h('dt', null, t('why')),
        h('dd', null, details.reason === '' ? '—' : details.reason)
      ),

      h('p', { className: 'dsh-dt-section-label' }, t('content')),
      h('div', { className: 'dsh-dt-content' },
        h(props.Folded, {
          text: details.body,
          expandLabel: t('expand'),
          collapseLabel: t('collapse'),
        })
      ),

      candidates.length > 0
        ? h('div', { className: 'dsh-dt-candidates' },
          h('p', { className: 'dsh-dt-candidates-title' }, t('pickWho')),
          candidates.map((candidate) =>
            h('button', {
              key: String(candidate.openDingTalkId || candidate.userId || candidate.name),
              type: 'button',
              className: 'dsh-dt-candidate',
              disabled: busy,
              onClick: () => run('send', { recipientId: candidate.openDingTalkId || candidate.userId }),
            }, String(candidate.label || candidate.name))
          )
        )
        : null,

      state.line === null ? null : h('p', { className: 'dsh-dt-status ' + state.line.tone, role: 'status' }, state.line.text),
      error === '' ? null : h('p', { className: 'dsh-dt-status is-error', role: 'alert' }, error)
    ),

    settled
      ? null
      : h('footer', { className: 'dsh-dt-foot' },
        h('input', {
          type: 'text',
          className: 'dsh-dt-input',
          value: instruction,
          placeholder: t('revisePlaceholder'),
          'aria-label': t('reviseHint'),
          disabled: busy,
          onChange: (event) => setInstruction(event.target.value),
        }),
        h('div', { className: 'dsh-dt-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-dt-btn',
            disabled: busy,
            onClick: () => run('revise', { instruction }),
          }, pending === 'revise' ? t('working') : t('revise')),
          h('button', {
            type: 'button',
            className: 'dsh-dt-btn',
            disabled: busy,
            onClick: () => run('dismiss'),
          }, pending === 'dismiss' ? t('working') : t('dismiss')),
          h('button', {
            type: 'button',
            className: 'dsh-dt-btn is-primary',
            disabled: busy,
            onClick: () => run('send'),
          }, pending === 'send' ? t('working') : (phase === 'failed' ? t('retry') : t('send')))
        )
      )
  );
}
