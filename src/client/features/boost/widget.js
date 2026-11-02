// src/client/features/boost/widget.js
//
// 小火箭：内容区域右下角的浮动入口。
//
// 交互四条：
//   1. 入口在右下角，视觉像电脑管家的「一键加速」；
//   2. 点一下 → 火箭发射动画 → 展开可勾选的清理清单；
//   3. 可以拖动，位置记住（下次打开还在原地）；
//   4. 确认后交给 Agent 执行；会话不可用时面板直接执行兜底。
//
// 挂在 shell.overlay（root scope 的浮层槽）—— DSH 自己的设置弹窗与日程提醒
// 都走这个槽，它天生就是「浮在所有列之上」的一层。

import { h, useCallback, useEffect, useRef, useState } from '../../runtime.js';
import { currentSessionId, formatBytes, scanAgeLabel, useBoostJob, useHandoff, useSelection } from './view.js';
import { DiagnosisBlock, ItemList } from './parts.js';
import { BOOST_RUNTIME } from './ref.js';
import { RocketIcon } from './rocket.js';
import { Styles } from './styles.js';

/** 按钮位置记在哪。 */
const POS_KEY = 'dsh-usage-aggregator:boost:pos';

/** 按钮边长（与样式里的 48px 对齐）。 */
const BUTTON_SIZE = 48;

/** 离屏幕边缘的距离。 */
const EDGE = 24;

/** 发射动画时长（毫秒），与样式里的 .85s 对齐。 */
const LAUNCH_MS = 850;

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
 * 读记住的位置。
 *
 * @returns {{x: number, y: number}|null} 位置；没有就是 null。
 */
function readPos() {
  try {
    const raw = window.localStorage.getItem(POS_KEY);
    if (raw === null || raw === '') return null;
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object') return null;
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
    return { x: value.x, y: value.y };
  } catch {
    return null;
  }
}

/**
 * 记住位置。
 *
 * @param {{x: number, y: number}} pos 位置。
 */
function writePos(pos) {
  try {
    window.localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* 存不了就算了，下次还在默认位置 */
  }
}

/**
 * 把位置夹回屏幕内。
 *
 * @param {{x: number, y: number}} pos 位置。
 * @returns {{x: number, y: number}} 夹好之后的位置。
 */
function clampPos(pos) {
  const maxX = Math.max(EDGE, window.innerWidth - BUTTON_SIZE - EDGE);
  const maxY = Math.max(EDGE, window.innerHeight - BUTTON_SIZE - EDGE);
  return {
    x: Math.min(Math.max(EDGE, pos.x), maxX),
    y: Math.min(Math.max(EDGE, pos.y), maxY),
  };
}

/**
 * 小火箭浮层。
 *
 * @param {{t: Function, runtime: {sessions: object|null}, useSessions?: Function}} props 属性。
 * @returns {object} React 元素。
 */
export function BoostWidget(props) {
  const t = props.t;
  const runtime = props.runtime ?? { sessions: null };
  const useSessions = typeof props.useSessions === 'function' ? props.useSessions : noSessions;
  const sessionsState = useSessions(function (all) { return all; });
  const sessionId = currentSessionId(sessionsState);

  // initialOpen / initialJob 只给离线渲染自检用（scripts/ui-check-boost.mjs）：
  // 真页面上永远是 false / null。
  const [open, setOpen] = useState(props.initialOpen === true);
  const [launching, setLaunching] = useState(false);
  const [landing, setLanding] = useState(false);
  const [pos, setPos] = useState(null);
  const [dragging, setDragging] = useState(false);

  const buttonRef = useRef(null);
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);
  const launchTimerRef = useRef(null);

  const { job, error, scanning, start } = useBoostJob(t, props.initialJob);
  const items = Array.isArray(job?.items) ? job.items : [];
  const { selected, toggle, setAll } = useSelection(items);

  // 当前会话记进共享状态：聚合设置页里的视图拿不到标准属性，只能来读。
  useEffect(function () {
    BOOST_RUNTIME.sessionId = sessionId;
  }, [sessionId]);

  // 记住的位置：读一次，窗口尺寸变了再夹回去。
  useEffect(function () {
    const saved = readPos();
    if (saved !== null) setPos(clampPos(saved));
    const onResize = function () {
      setPos(function (current) { return current === null ? current : clampPos(current); });
    };
    window.addEventListener('resize', onResize);
    return function () { window.removeEventListener('resize', onResize); };
  }, []);

  useEffect(function () {
    return function () {
      if (launchTimerRef.current !== null) window.clearTimeout(launchTimerRef.current);
    };
  }, []);

  /**
   * 发射：火箭升空 → 落回原位 → 展开清单。
   */
  const launch = useCallback(function () {
    setLaunching(true);
    setLanding(false);
    setOpen(false);
    launchTimerRef.current = window.setTimeout(function () {
      launchTimerRef.current = null;
      setLaunching(false);
      setLanding(true);
      setOpen(true);
      start(false);
    }, LAUNCH_MS);
  }, [start]);

  // 拖动：按下的位置与移动的位移记在 ref 里，松手才写 localStorage。
  const onPointerDown = useCallback(function (event) {
    if (event.button !== 0) return;
    const node = buttonRef.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      baseX: rect.left,
      baseY: rect.top,
      moved: false,
    };
    try { node.setPointerCapture(event.pointerId); } catch { /* 某些浏览器不支持 */ }
  }, []);

  const onPointerMove = useCallback(function (event) {
    const drag = dragRef.current;
    if (drag === null) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    drag.moved = true;
    setDragging(true);
    setPos(clampPos({ x: drag.baseX + dx, y: drag.baseY + dy }));
  }, []);

  const onPointerUp = useCallback(function (event) {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    try { buttonRef.current?.releasePointerCapture(event.pointerId); } catch { /* 已经放开了 */ }
    if (drag !== null && drag.moved) {
      // 拖完紧接着的 click 不该再触发一次发射。
      suppressClickRef.current = true;
      setPos(function (current) {
        if (current !== null) writePos(current);
        return current;
      });
    }
  }, []);

  const onClick = useCallback(function () {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (open) {
      setOpen(false);
      return;
    }
    launch();
  }, [open, launch]);

  // 交给 Agent 执行；没有可用会话时由面板直接执行兜底。
  // 执行完了重扫一次：清掉的条目得从清单里消失，面板内容区才是当下的实况。
  const handoff = useHandoff({
    t,
    job,
    selected,
    runtime,
    sessionId,
    onFinished: function () { start(true); },
  });

  const totalBytes = items.reduce(function (sum, item) { return sum + (item.sizeBytes ?? 0); }, 0);
  const analysis = job?.analysis ?? null;
  const ageLabel = scanAgeLabel(t, job);
  const high = pos !== null && pos.y < 320;

  const style = pos === null
    ? undefined
    : { left: `${pos.x}px`, top: `${pos.y}px`, right: 'auto', bottom: 'auto' };

  const className = 'dsh-boost'
    + (dragging ? ' is-dragging' : '')
    + (high ? ' is-high' : '');

  return h(
    'div',
    { className, style },
    h(Styles, null),
    open ? h(
      'div',
      { className: 'dsh-boost-panel', role: 'dialog', 'aria-label': t('title') },
      h('div', { className: 'dsh-boost-head' },
        h('div', null,
          h('h2', { className: 'dsh-boost-title' }, t('title')),
          h('p', { className: 'dsh-boost-sub' }, t('subtitle')),
          ageLabel !== ''
            ? h('p', { className: 'dsh-boost-age' }, t('scannedAt', { age: ageLabel }))
            : null
        ),
        h('button', {
          type: 'button',
          className: 'dsh-boost-close',
          'aria-label': t('close'),
          onClick: function () { setOpen(false); }
        }, '×')
      ),
      h('div', { className: 'dsh-boost-body' },
        scanning === true || (job === null && error === '')
          ? h('div', { className: 'dsh-boost-empty' },
            h('span', null, t('scanning')),
            h('span', null, t('scanningHint')))
          : null,
        error !== '' ? h('div', { className: 'dsh-boost-msg is-error' }, error) : null,
        h(DiagnosisBlock, { analysis: analysis, t: t }),
        items.length === 0 && scanning !== true && error === ''
          ? h('div', { className: 'dsh-boost-empty' },
            h('span', null, t('empty')),
            h('span', null, t('emptyHint')))
          : null,
        h(ItemList, { items: items, selected: selected, toggle: toggle, t: t })
      ),
      h('div', { className: 'dsh-boost-foot' },
        h('span', null,
          items.length === 0
            ? t('totalUnknown')
            : t('total', { size: formatBytes(totalBytes) })),
        h('div', { className: 'dsh-boost-foot-actions' },
          items.length > 0
            ? h('button', {
              type: 'button',
              className: 'dsh-boost-btn is-quiet',
              onClick: function () { setAll(selected.length !== items.length); }
            }, selected.length === items.length ? t('selectNone') : t('selectAll'))
            : null,
          h('button', {
            type: 'button',
            className: 'dsh-boost-btn is-quiet',
            disabled: scanning === true,
            onClick: function () { start(true); }
          }, t('scanAgain')),
          h('button', {
            type: 'button',
            className: 'dsh-boost-btn is-primary',
            disabled: scanning === true || handoff.phase === 'running' || selected.length === 0,
            onClick: handoff.run
          }, handoff.phase === 'running' ? t('running') : t('run'))
        )
      ),
      handoff.message !== '' ? h('div', { className: 'dsh-boost-foot' },
        h('p', { className: 'dsh-boost-msg ' + handoff.tone }, handoff.message),
        handoff.progress !== null && handoff.phase === 'running'
          ? h('div', { className: 'dsh-boost-progress' },
            h('div', { className: 'dsh-boost-progress-bar' },
              h('div', {
                className: 'dsh-boost-progress-fill',
                style: {
                  width: handoff.progress.total > 0
                    ? `${Math.round((handoff.progress.done / handoff.progress.total) * 100)}%`
                    : '0%',
                },
              })),
            h('div', { className: 'dsh-boost-progress-text' },
              t('progress', {
                done: handoff.progress.done,
                total: handoff.progress.total,
                label: handoff.progress.label,
              })))
          : null) : null
    ) : null,
    h(
      'button',
      {
        ref: buttonRef,
        type: 'button',
        className: 'dsh-boost-launch'
          + (launching ? ' is-launching' : '')
          + (landing ? ' is-landing' : ''),
        title: t('entryTitle'),
        'aria-label': t('entryTitle'),
        onPointerDown: onPointerDown,
        onPointerMove: onPointerMove,
        onPointerUp: onPointerUp,
        onPointerCancel: onPointerUp,
        onClick: onClick,
      },
      h(RocketIcon, { size: 26 })
    )
  );
}
