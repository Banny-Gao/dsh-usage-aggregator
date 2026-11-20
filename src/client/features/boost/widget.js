// src/client/features/boost/widget.js
//
// 小火箭：悬浮栏里的那个火箭入口（加速与清理）。
//
// 交互四条：
//   1. 入口在悬浮栏里（右下角），视觉像电脑管家的「一键加速」；
//   2. 点一下 → 火箭发射动画 → 展开可勾选的清理清单；
//   3. 悬浮栏整体可以拖动，位置记住（下次打开还在原地）；
//   4. 确认后交给 Agent 执行；会话不可用时面板直接执行兜底。
//
// ⚠️ 位置与拖拽**不在这里**：悬浮栏（src/client/shared/dock.js）管位置，
// 这里只管火箭自己的事 —— 图标、发射动画、清单内容。

import { h, useCallback, useEffect, useRef, useState } from '../../runtime.js';
import { DockButton, DockPanel } from '../../shared/dock.js';
import { currentSessionId, formatBytes, scanAgeLabel, useBoostJob, useHandoff, useSelection } from './view.js';
import { DiagnosisBlock, ItemList } from './parts.js';
import { BOOST_RUNTIME } from './ref.js';
import { RocketIcon } from './rocket.js';
import { Styles } from './styles.js';

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
 * 悬浮栏里的小火箭。
 *
 * @param {{t: Function, runtime: {sessions: object|null}, open?: boolean, onToggle?: Function, onClose?: Function, slotProps?: object|null, initialJob?: object|null}} props 属性。
 *   initialJob 只给离线渲染自检用。
 * @returns {object} React 元素。
 */
export function BoostEntry(props) {
  const t = props.t;
  const runtime = props.runtime ?? { sessions: null };
  const open = props.open === true;
  const slotProps = props.slotProps ?? null;
  const useSessions = slotProps !== null && typeof slotProps.useSessions === 'function'
    ? slotProps.useSessions
    : noSessions;
  const sessionsState = useSessions(function (all) { return all; });
  const sessionId = currentSessionId(sessionsState);

  const [launching, setLaunching] = useState(false);
  const [landing, setLanding] = useState(false);

  const launchTimerRef = useRef(null);
  const wasOpenRef = useRef(open);

  const { job, error, scanning, start } = useBoostJob(t, props.initialJob);
  const items = Array.isArray(job?.items) ? job.items : [];
  const { selected, toggle, setAll } = useSelection(items);

  // 当前会话记进共享状态：聚合设置页里的视图拿不到标准属性，只能来读。
  useEffect(function () {
    BOOST_RUNTIME.sessionId = sessionId;
  }, [sessionId]);

  // 面板展开的那一刻：火箭先飞一段，落地了才开始体检。
  // （展开状态由悬浮栏管 —— 栏里一次只开一个面板。）
  useEffect(function () {
    if (open === wasOpenRef.current) return;
    wasOpenRef.current = open;
    if (open !== true) return;
    setLaunching(true);
    setLanding(false);
    launchTimerRef.current = window.setTimeout(function () {
      launchTimerRef.current = null;
      setLaunching(false);
      setLanding(true);
      start(false);
    }, LAUNCH_MS);
  }, [open, start]);

  useEffect(function () {
    return function () {
      if (launchTimerRef.current !== null) window.clearTimeout(launchTimerRef.current);
    };
  }, []);

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

  const onButtonClick = useCallback(function () {
    if (typeof props.onToggle === 'function') props.onToggle();
  }, [props.onToggle]);

  const onClose = useCallback(function () {
    if (typeof props.onClose === 'function') props.onClose();
  }, [props.onClose]);

  return h(
    'div',
    { className: 'dsh-dock-entry' },
    // ⚠️ 自己的样式必须跟着组件渲染：面板的外壳由悬浮栏给，但里面的排版
    // （标题、清单、按钮）是本功能的样式 —— 漏了这张样式表，面板会变成
    // 一堆浏览器默认样式的裸元素。
    h(Styles, null),
    // 面板：外壳由悬浮栏统一（尺寸、边框、定位），这里只出内容。
    open && launching === false
      ? h(
        DockPanel,
        { label: t('title') },
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
            onClick: onClose,
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
      )
      : null,
    h(
      DockButton,
      {
        className: 'dsh-boost-launch'
          + (launching ? ' is-launching' : '')
          + (landing ? ' is-landing' : ''),
        title: t('entryTitle'),
        onClick: onButtonClick,
        open: open,
      },
      h(RocketIcon, { size: 19 })
    )
  );
}
