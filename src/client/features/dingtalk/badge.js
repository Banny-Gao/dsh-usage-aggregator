// src/client/features/dingtalk/badge.js
//
// 钉钉待处理：在悬浮栏里的那个气泡入口。
//
// 为什么要有它：项目外的消息原先只累一个计数，而那个计数**只出现在设置页的
// 「钉钉」页签里** —— 你不打开那个页签，就等于没有提示。这个入口常驻在悬浮栏
// 上（小火箭旁边），哪一页都看得见，又不挡页面。
//
// 交互三条：
//   1. 有**新**消息 → 图标呼吸式闪烁并显示条数；
//   2. 点开 → 展开待处理清单（发送者 + 会话 + 摘要 + 时间）；
//   3. 每条两个动作：【处理】交给会话、【忽略】从清单里去掉。
//
// 「处理」落到哪个会话（用户定的规矩）：
//   · 当初判定为项目内、路由到过的会话 → 回到那个会话；
//   · 没有路由过的 → 让用户选：交给当前会话，或新开一个会话
//     （开在消息判定时那个项目的工作目录里 —— 这就是「找到合适的项目」）。
//
// 入口的及时性受 Host 侧拉取间隔约束（默认 180 秒，设置页可调）——
// 这里查的是 Host 已经拉到的清单，不是自己去问钉钉。

import { h, useCallback, useEffect, useRef, useState } from '../../runtime.js';
import { DockButton, DockPanel } from '../../shared/dock.js';
import { api } from './api.js';
import { BubbleIcon } from './icon.js';
import { Styles } from './styles.js';

/** 入口多久查一次待处理清单（毫秒）。 */
const POLL_MS = 20000;

/**
 * 没有 useSessions 时的占位（保持 Hook 调用顺序稳定）。
 *
 * @param {Function} selector 选择器。
 * @returns {null} 永远没有会话。
 */
function noSessions(selector) {
  return selector(null);
}

/**
 * 找出用户当前正在看的那个会话。
 *
 * 判据跟 DSH 自己的一致：会话列表里 **retainedBy.mainView > 0** 的那个。
 * 子代理的会话没有这个标记，天然被排除在外。
 *
 * @param {object} state 会话列表快照。
 * @returns {string|null} 会话 id。
 */
export function currentSessionId(state) {
  if (state === null || state === undefined || typeof state !== 'object') return null;
  const byId = state.byId;
  if (byId === null || byId === undefined || typeof byId !== 'object') return null;
  for (const row of Object.values(byId)) {
    if (row === null || typeof row !== 'object') continue;
    const retained = row.retainedBy;
    let count = 0;
    if (typeof retained === 'number') count = retained;
    else if (retained !== null && typeof retained === 'object' && typeof retained.mainView === 'number') count = retained.mainView;
    if (count > 0) return typeof row.id === 'string' ? row.id : null;
  }
  return null;
}

/**
 * 把时间戳变成一句能读的时间。
 *
 * @param {number} ms 毫秒时间戳。
 * @returns {string} 文本。
 */
function stamp(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  );
}

/**
 * 造交给 Agent 的那段话。
 *
 * 原文**整段**带上：Agent 要判断这条消息要怎么处理，光看一句摘要不够。
 * 正文只在内存里（Host 侧的清单不落盘），这里只是把它转成一条会话消息。
 *
 * @param {Function} t 翻译函数。
 * @param {object} item 待处理条目。
 * @returns {string} 交给 Agent 的正文。
 */
export function buildTask(t, item) {
  const lines = [t('taskTitle'), ''];
  lines.push('- ' + t('taskFrom') + '：' + (item.sender === '' ? t('unknownSender') : item.sender));
  if (typeof item.chatName === 'string' && item.chatName !== '') lines.push('- ' + t('taskChat') + '：' + item.chatName);
  const at = stamp(item.at);
  if (at !== '') lines.push('- ' + t('taskTime') + '：' + at);
  lines.push('- ' + t('taskText') + '：' + String(item.text ?? item.excerpt ?? ''));
  lines.push('');
  lines.push(t('taskHint'));
  return lines.join('\n');
}

/**
 * 悬浮栏里的钉钉入口（图标 + 待处理清单）。
 *
 * @param {{t: Function, open?: boolean, onToggle?: Function, onClose?: Function, slotProps?: object|null, sessions?: object|null, initialItems?: Array<object>, initialBlinking?: boolean}} props 属性。
 *   initialItems / initialBlinking 只给离线渲染自检用。
 * @returns {object} React 元素。
 */
export function DingtalkEntry(props) {
  const t = props.t;
  const open = props.open === true;
  const sessions = props.sessions ?? null;
  const slotProps = props.slotProps ?? null;
  const useSessions = slotProps !== null && typeof slotProps.useSessions === 'function'
    ? slotProps.useSessions
    : noSessions;
  const sessionsState = useSessions(function (all) { return all; });
  const currentId = currentSessionId(sessionsState);

  const [items, setItems] = useState(Array.isArray(props.initialItems) ? props.initialItems : []);
  const [blinking, setBlinking] = useState(props.initialBlinking === true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [choice, setChoice] = useState('');
  /** 见过的消息 id —— 用来判断哪条是「新的」。 */
  const seenRef = useRef(new Set());
  /** 第一轮只记不闪（页面刚打开就闪一下没意义）。 */
  const primedRef = useRef(false);

  useEffect(function () {
    let alive = true;
    const tick = function () {
      api.pending().then(function (result) {
        if (!alive || result === null || typeof result !== 'object') return;
        const list = Array.isArray(result.items) ? result.items : [];
        setItems(list);
        const fresh = list.filter((item) => seenRef.current.has(item.id) === false);
        for (const item of list) seenRef.current.add(item.id);
        if (primedRef.current === false) {
          primedRef.current = true;
          return;
        }
        if (fresh.length > 0) setBlinking(true);
      }).catch(function () {
        /* 查不到就下一轮再说 */
      });
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return function () { alive = false; window.clearInterval(timer); };
  }, []);

  /**
   * 把一条消息投进某个会话。
   *
   * @param {string} sessionId 会话 id。
   * @param {object} item 待处理条目。
   * @returns {Promise<void>} 投递完成。
   */
  const deliverTo = useCallback(function (sessionId, item) {
    const service = sessions;
    if (service === null || typeof service.scope !== 'function') {
      return Promise.reject(new Error(t('noSessions')));
    }
    const scope = service.scope(sessionId);
    const conversation = scope === undefined || scope === null ? undefined : scope.conversation;
    if (conversation === undefined || conversation === null || typeof conversation.send !== 'function') {
      return Promise.reject(new Error(t('noSession')));
    }
    return conversation.send(buildTask(t, item));
  }, [sessions, t]);

  /**
   * 新开一个会话，把消息投进去。
   *
   * 开在消息判定时那个项目的工作目录里 —— 这就是「找到合适的项目再处理」。
   *
   * @param {object} item 待处理条目。
   * @returns {Promise<void>} 投递完成。
   */
  const openNewSession = useCallback(function (item) {
    const service = sessions;
    if (service === null || typeof service.create !== 'function') {
      return Promise.reject(new Error(t('noSessions')));
    }
    const opts = typeof item.cwd === 'string' && item.cwd !== '' ? { cwd: item.cwd } : {};
    return service.create(opts).then(function (id) {
      // 新会话还没被谁 retain 过 —— 借它的作用域要自己 hold 住。
      if (typeof service.using !== 'function') return deliverTo(id, item);
      return service.using(id, { source: 'controllerOperation' }, function () {
        return deliverTo(id, item);
      });
    });
  }, [sessions, t, deliverTo]);

  /**
   * 处理完一条：从清单里去掉，停止闪烁。
   *
   * @param {object} item 待处理条目。
   * @returns {void}
   */
  const done = useCallback(function (item) {
    setItems((current) => current.filter((row) => row.id !== item.id));
    seenRef.current.add(item.id);
    setChoice('');
    setBusy(false);
    api.ignore(item.id).catch(function () {
      /* Host 那边去不掉也只是清单还在，不影响本地 */
    });
  }, []);

  /**
   * 点【处理】。
   *
   * @param {object} item 待处理条目。
   * @returns {void}
   */
  const handle = useCallback(function (item) {
    setNote('');
    if (typeof item.sessionId === 'string' && item.sessionId !== '') {
      // 当初路由到过的会话 → 直接回到那个会话。
      setBusy(true);
      deliverTo(item.sessionId, item).then(function () {
        done(item);
        setNote(t('handled'));
      }).catch(function (failure) {
        setBusy(false);
        setNote(t('handleFailed', { error: String(failure && failure.message ? failure.message : failure) }));
      });
      return;
    }
    // 没有路由过 → 让用户选去哪儿处理。
    setChoice(item.id);
  }, [deliverTo, done, t]);

  /**
   * 忽略一条。
   *
   * @param {object} item 待处理条目。
   * @returns {void}
   */
  const ignore = useCallback(function (item) {
    setBusy(true);
    api.ignore(item.id).then(function () {
      done(item);
    }).catch(function (failure) {
      setBusy(false);
      setNote(t('handleFailed', { error: String(failure && failure.message ? failure.message : failure) }));
    });
  }, [done, t]);

  /**
   * 投到当前会话。
   *
   * @param {object} item 待处理条目。
   * @returns {void}
   */
  const toCurrent = useCallback(function (item) {
    if (currentId === null) {
      setNote(t('noCurrent'));
      return;
    }
    setBusy(true);
    deliverTo(currentId, item).then(function () {
      done(item);
      setNote(t('handled'));
    }).catch(function (failure) {
      setBusy(false);
      setNote(t('handleFailed', { error: String(failure && failure.message ? failure.message : failure) }));
    });
  }, [currentId, deliverTo, done, t]);

  /**
   * 新开会话处理。
   *
   * @param {object} item 待处理条目。
   * @returns {void}
   */
  const toNew = useCallback(function (item) {
    setBusy(true);
    openNewSession(item).then(function () {
      done(item);
      setNote(t('handledNew'));
    }).catch(function (failure) {
      setBusy(false);
      setNote(t('handleFailed', { error: String(failure && failure.message ? failure.message : failure) }));
    });
  }, [openNewSession, done, t]);

  const count = items.length;

  const onButtonClick = useCallback(function () {
    setBlinking(false);
    if (typeof props.onToggle === 'function') props.onToggle();
  }, [props.onToggle]);

  return h(
    'div',
    { className: 'dsh-dock-entry' },
    h(Styles, null),
    open
      ? h(
        DockPanel,
        { label: t('panelTitle', { count: String(count) }) },
        h('div', { className: 'dsh-dt-badge-head' },
          h('span', { className: 'dsh-dt-badge-title' }, t('panelTitle', { count: String(count) })),
          h('button', {
            type: 'button',
            className: 'dsh-dt-badge-close',
            'aria-label': t('close'),
            onClick: function () { if (typeof props.onClose === 'function') props.onClose(); },
          }, '×')
        ),
        count === 0
          ? h('p', { className: 'dsh-dt-badge-empty' }, t('empty'))
          : h('div', { className: 'dsh-dt-badge-list' },
            items.map(function (item) {
              const at = stamp(item.at);
              return h('div', { className: 'dsh-dt-badge-item', key: item.id },
                h('div', { className: 'dsh-dt-badge-item-main' },
                  h('span', { className: 'dsh-dt-badge-item-head' },
                    h('strong', null, item.sender === '' ? t('unknownSender') : item.sender),
                    item.at === true ? h('span', { className: 'dsh-dt-badge-at' }, t('atTag')) : null,
                    item.chatName !== undefined && item.chatName !== '' ? h('span', { className: 'dsh-dt-badge-chat' }, item.chatName) : null,
                    at !== '' ? h('span', { className: 'dsh-dt-badge-time' }, at) : null
                  ),
                  h('p', { className: 'dsh-dt-badge-excerpt' }, String(item.excerpt ?? '')),
                  item.sessionId !== undefined && item.sessionId !== ''
                    ? h('p', { className: 'dsh-dt-badge-routed' }, t('routed'))
                    : null
                ),
                h('div', { className: 'dsh-dt-badge-actions' },
                  h('button', {
                    type: 'button',
                    className: 'dsh-dt-badge-btn is-primary',
                    disabled: busy === true,
                    onClick: function () { handle(item); },
                  }, t('handle')),
                  h('button', {
                    type: 'button',
                    className: 'dsh-dt-badge-btn',
                    disabled: busy === true,
                    onClick: function () { ignore(item); },
                  }, t('ignore'))
                ),
                choice === item.id
                  ? h('div', { className: 'dsh-dt-badge-choice' },
                    h('button', {
                      type: 'button',
                      className: 'dsh-dt-badge-btn is-primary',
                      disabled: busy === true || currentId === null,
                      onClick: function () { toCurrent(item); },
                    }, t('toCurrent')),
                    h('button', {
                      type: 'button',
                      className: 'dsh-dt-badge-btn',
                      disabled: busy === true,
                      onClick: function () { toNew(item); },
                    }, t('toNew'))
                  )
                  : null
              );
            })
          ),
        note !== '' ? h('p', { className: 'dsh-dt-badge-note' }, note) : null
      )
      : null,
    h(
      DockButton,
      {
        className: blinking === true ? 'dsh-dt-badge-blinking' : '',
        title: t('panelTitle', { count: String(count) }),
        onClick: onButtonClick,
        open: open,
      },
      h(BubbleIcon, { size: 19 }),
      count > 0 ? h('span', { className: 'dsh-dock-count' }, String(count)) : null
    )
  );
}
