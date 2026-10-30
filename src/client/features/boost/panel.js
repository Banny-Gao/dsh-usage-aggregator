// src/client/features/boost/panel.js
//
// 聚合设置页里的「加速」页签。
//
// 与右下角的小火箭是**同一份体检结果**：浮层是窄卡片，这里是整页 ——
// 结论、观察、逐项清单、勾选、交给 Agent，一个都不少。
//
// 为什么设置页也要有：清单可能有十几项，窄卡片里看不全也点不准；
// 而设置页是「配置」的地方，用户在这里能慢慢看、能重新体检。

import { h, useEffect } from '../../runtime.js';
import { formatBytes, useBoostJob, useHandoff, useSelection } from './view.js';
import { DiagnosisBlock, ItemList } from './parts.js';
import { BOOST_RUNTIME } from './ref.js';
import { Styles } from './styles.js';

/**
 * 「加速」页签。
 *
 * @param {{t: Function}} props 属性。
 * @returns {object} React 元素。
 */
export function BoostPanel(props) {
  const t = props.t;
  const { job, error, scanning, start } = useBoostJob(t, props.initialJob);
  const items = Array.isArray(job?.items) ? job.items : [];
  const { selected, toggle, setAll } = useSelection(items);
  const handoff = useHandoff({
    t,
    job,
    selected,
    runtime: BOOST_RUNTIME,
    sessionId: BOOST_RUNTIME.sessionId,
  });

  // 打开这一页就体检一次（结果有五分钟缓存，重复打开不重测）。
  useEffect(function () {
    start(false);
  }, [start]);

  const totalBytes = items.reduce(function (sum, item) { return sum + (item.sizeBytes ?? 0); }, 0);
  const analysis = job?.analysis ?? null;

  return h(
    'div',
    { className: 'dsh-boost-hub' },
    h(Styles, null),
    h('p', { className: 'dsh-boost-sub' }, t('hubIntro')),
    h('div', { className: 'dsh-boost-hub-row' },
      h('span', { className: 'dsh-boost-msg' },
        items.length === 0 ? t('totalUnknown') : t('total', { size: formatBytes(totalBytes) })),
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
    scanning === true
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
    h(ItemList, { items: items, selected: selected, toggle: toggle, t: t }),
    handoff.message !== ''
      ? h('p', { className: 'dsh-boost-msg ' + handoff.tone }, handoff.message)
      : null,
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
      : null
  );
}
