// src/client/features/boost/parts.js
//
// 清单与诊断的渲染片段 —— 小火箭浮层与聚合设置页共用同一份。
//
// 拆出来是因为两处要显示的是**同一份体检结果**：浮层是窄卡片，设置页是整页，
// 内容必须一致，不能各画各的。

import { h } from '../../runtime.js';
import { formatBytes } from './view.js';

/**
 * 诊断块。
 *
 * @param {{analysis: object, t: Function}} props 属性。
 * @returns {object} React 元素。
 */
export function DiagnosisBlock(props) {
  const analysis = props.analysis;
  const t = props.t;
  if (analysis === null || analysis === undefined) return null;
  const findings = Array.isArray(analysis.findings) ? analysis.findings : [];
  const warnings = Array.isArray(analysis.warnings) ? analysis.warnings : [];
  return h('div', { className: 'dsh-boost-diag' },
    h('div', { className: 'dsh-boost-diag-title' }, t('diagnosis')),
    h('div', { className: 'dsh-boost-diag-main' }, analysis.diagnosis),
    findings.length > 0
      ? h('ul', { className: 'dsh-boost-diag-list' },
        findings.map(function (finding, index) {
          return h('li', { key: `f${index}` }, finding);
        }))
      : null,
    warnings.length > 0
      ? h('div', { className: 'dsh-boost-diag-warn' },
        warnings.map(function (warning, index) {
          return h('div', { key: `w${index}` }, `! ${warning}`);
        }))
      : null
  );
}

/** 条目的语义 → 标签。语义说的是「这条动作会做什么」。 */
export const SEMANTICS_LABEL = {
  prune: 'itemSemanticsPrune',
  full: 'itemSemanticsFull',
  terminate: 'itemSemanticsTerminate',
  renice: 'itemSemanticsRenice',
  'close-window': 'itemSemanticsCloseWindow',
};

/**
 * 这一条的风险标签。
 *
 * 「需重下」是缓存的说法（删了下次要重新下载）；会话那种是「会丢历史」；
 * 进程那种是「会关掉程序」。按分组说不同的词。
 *
 * @param {object} item 条目。
 * @returns {string|null} 标签的 key。
 */
export function riskLabelKey(item) {
  if (item.risk === 'high') return 'itemRiskHigh';
  if (item.risk !== 'medium') return null;
  if (item.group === 'dsh') return 'itemRiskHistory';
  if (item.group === 'process') return 'itemRiskInterrupt';
  return 'itemRiskMedium';
}

/** 清单的分组顺序。顺序也是风险的顺序：先无损的，后有代价的。 */
export const ITEM_GROUPS = [
  { key: 'cache', labelKey: 'groupCache' },
  { key: 'dsh', labelKey: 'groupDsh' },
  { key: 'process', labelKey: 'groupProcess' },
];

/**
 * 一条清理项。
 *
 * @param {{item: object, selected: boolean, toggle: Function, t: Function}} props 属性。
 * @returns {object} React 元素。
 */
function ItemRow(props) {
  const item = props.item;
  const t = props.t;
  // 磁盘类条目显示体积；进程类条目显示它占的内存（sizeBytes 对它是 0）。
  const memoryBytes = item.group === 'process' && item.detail !== undefined && item.detail !== null
    ? Number(item.detail.rssBytes ?? 0)
    : 0;
  const size = item.sizeBytes > 0
    ? formatBytes(item.sizeBytes)
    : memoryBytes > 0
      ? formatBytes(memoryBytes)
      : (typeof item.count === 'number' && item.count > 1
        ? (item.group === 'process' ? `${item.count} 个进程` : `${item.count} 项`)
        : '');
  return h('label', { className: 'dsh-boost-item' },
    h('input', {
      type: 'checkbox',
      className: 'dsh-boost-check',
      checked: props.selected,
      onChange: function (event) { props.toggle(item.id, event.target.checked); }
    }),
    h('div', { className: 'dsh-boost-item-main' },
      h('div', { className: 'dsh-boost-item-name' },
        h('span', null, item.label),
        size === '' ? null : h('span', { className: 'dsh-boost-item-size' }, size),
        h('span', { className: 'dsh-boost-tag' }, t(SEMANTICS_LABEL[item.semantics] ?? 'itemSemanticsFull')),
        riskLabelKey(item) === null
          ? null
          : h('span', {
            className: `dsh-boost-tag ${item.risk === 'high' ? 'is-danger' : 'is-warn'}`,
          }, t(riskLabelKey(item)))
      ),
      h('div', { className: 'dsh-boost-item-meta' }, item.commandText),
      typeof item.note === 'string' && item.note !== ''
        ? h('div', { className: 'dsh-boost-item-note' }, item.note)
        : null
    )
  );
}

/**
 * 清理清单（按组分段）。
 *
 * @param {{items: Array<object>, selected: string[], toggle: Function, t: Function}} props 属性。
 * @returns {object} React 元素。
 */
export function ItemList(props) {
  const items = props.items;
  const selected = props.selected;
  const toggle = props.toggle;
  const t = props.t;
  if (items.length === 0) return null;
  const groups = ITEM_GROUPS.map(function (group) {
    return {
      group: group,
      items: items.filter(function (item) { return (item.group ?? 'cache') === group.key; }),
    };
  }).filter(function (entry) { return entry.items.length > 0; });

  // 组里没被认领的条目（比如以后新增了一组）也���显示，不能凭空丢。
  const claimed = new Set(groups.reduce(function (all, entry) {
    return all.concat(entry.items.map(function (item) { return item.id; }));
  }, []));
  const rest = items.filter(function (item) { return !claimed.has(item.id); });
  if (rest.length > 0) {
    groups.push({ group: { key: 'other', labelKey: 'groupCache' }, items: rest });
  }

  return h('div', { className: 'dsh-boost-list' },
    groups.map(function (entry) {
      return h('div', { key: entry.group.key, className: 'dsh-boost-group' },
        h('div', { className: 'dsh-boost-group-title' }, t(entry.group.labelKey)),
        entry.items.map(function (item) {
          return h(ItemRow, {
            key: item.id,
            item: item,
            selected: selected.includes(item.id),
            toggle: toggle,
            t: t,
          });
        })
      );
    })
  );
}
