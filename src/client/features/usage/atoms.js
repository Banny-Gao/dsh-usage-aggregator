// src/client/features/usage/atoms.js
//
// 原子组件与基础视图（对应源插件的 05-atoms.js）。
//
// h / useState 现在来自 ../../runtime.js；DEFAULT_VISIBLE 来自 ./constants.js。

import { h, useState } from '../../runtime.js';
import { DEFAULT_VISIBLE } from './constants.js';

/**
 * 小徽标。
 *
 * @param {{text: string, tone?: string}} props 属性。
 * @returns {object} React 元素。
 */
export function Badge(props) {
  return h('span', { className: 'duq-badge is-' + (props.tone || 'idle') }, props.text);
}

/**
 * 进度条。
 *
 * @param {{percent?: number, tone?: string}} props 属性。
 * @returns {object} React 元素。
 */
export function Bar(props) {
  var percent = typeof props.percent === 'number' ? Math.max(0, Math.min(100, props.percent)) : 0;
  return h('div', { className: 'duq-bar', role: 'progressbar', 'aria-valuenow': Math.round(percent), 'aria-valuemin': 0, 'aria-valuemax': 100 },
    h('div', { className: 'duq-bar-fill is-' + (props.tone || 'brand'), style: { width: percent + '%' } })
  );
}

/**
 * 按钮。
 *
 * @param {{variant?: string, quiet?: boolean, disabled?: boolean, onClick?: Function, title?: string}} props 属性。
 * @returns {object} React 元素。
 */
export function Button(props) {
  var className = 'duq-btn' + (props.variant === 'primary' ? ' is-primary' : '') + (props.variant === 'danger' ? ' is-danger' : '') + (props.quiet === true ? ' is-quiet' : '');
  return h('button', {
    type: 'button', className: className, disabled: props.disabled === true, onClick: props.onClick, title: props.title
  }, props.children);
}

/**
 * 一行指标。
 *
 * @param {object} metric 指标。
 * @param {number} index 下标（当 key 用）。
 * @returns {object} React 元素。
 */
function metricRow(metric, index) {
  return h('div', { className: 'duq-metric' + (metric.tone ? ' is-' + metric.tone : ''), key: metric.label + '#' + index },
    h('span', { className: 'duq-metric-label' }, metric.label),
    h('span', { className: 'duq-metric-value' }, metric.text)
  );
}

/**
 * 指标块：默认只展示前 DEFAULT_VISIBLE 条，其余折叠。
 *
 * 字段本身在前端已经全部解析好了（Host 侧把模板里每条 path 都算成了文本），
 * 这里只决定「先露几条」——顺序由 Host 侧的优先级给出，前 5 条就是最该看的。
 *
 * @param {{metrics: Array<object>, t: Function}} props 属性。
 * @returns {object|null} React 元素。
 */
export function MetricBlock(props) {
  var metrics = Array.isArray(props.metrics) ? props.metrics : [];
  var [expanded, setExpanded] = useState(false);
  if (metrics.length === 0) return null;
  var hidden = metrics.length - DEFAULT_VISIBLE;
  var visible = expanded || hidden <= 0 ? metrics : metrics.slice(0, DEFAULT_VISIBLE);
  return h('div', { className: 'duq-metricblock' },
    h('div', { className: 'duq-metrics' }, visible.map(metricRow)),
    hidden > 0 ? h('button', {
      type: 'button',
      className: 'duq-more',
      'aria-expanded': expanded,
      onClick: function () { setExpanded(!expanded); }
    }, expanded ? props.t('collapse') : props.t('expandMore', { n: hidden })) : null
  );
}

/**
 * 卡片网格。
 *
 * `maxCards` 只给**快捷浮层**用：那里空间是借来的，默认只摊开第一张卡片，
 * 其余折叠成一行「展开其余 N 张卡片」。设置页/主区不给这个参数，照旧全展开。
 *
 * @param {{cards: Array<object>, t: Function, maxCards?: number}} props 属性。
 * @returns {object} React 元素。
 */
export function CardGrid(props) {
  var cards = props.cards;
  var limit = typeof props.maxCards === 'number' && props.maxCards > 0 ? props.maxCards : 0;
  var [expanded, setExpanded] = useState(false);
  var collapsed = limit > 0 && !expanded && cards.length > limit;
  var shown = collapsed ? cards.slice(0, limit) : cards;
  var rest = cards.length - shown.length;
  return h('div', { className: 'duq-cardgrid' },
    h('div', { className: 'duq-grid' }, shown.map(function (card, index) {
      return h('div', { className: 'duq-subcard', key: (card.label ?? '') + index },
        h('div', { className: 'duq-subcard-head' },
          h('span', { className: 'duq-subcard-title' }, card.label),
          card.subtitle === null || card.subtitle === undefined ? null : h('span', { className: 'duq-subcard-sub' }, card.subtitle)
        ),
        card.percent === null || card.percent === undefined ? null : h(Bar, { percent: card.percent, tone: 'brand' }),
        h(MetricBlock, { metrics: card.metrics, t: props.t })
      );
    })),
    limit > 0 && cards.length > limit
      ? h('button', {
        type: 'button',
        className: 'duq-more',
        'aria-expanded': expanded,
        onClick: function () { setExpanded(!expanded); }
      }, expanded ? props.t('collapse') : props.t('expandCards', { n: rest }))
      : null
  );
}

/**
 * 图片文件 → base64（粘贴/拖拽/选择文件三条路共用）。
 *
 * @param {File} file 文件。
 * @param {Function} t translator。
 * @param {Function} onImage 成功回调。
 * @param {Function} onError 失败回调。
 */
export function readImageFile(file, t, onImage, onError) {
  if (file === null || file === undefined) return;
  if (/^image\//.test(file.type) !== true) {
    onError(t('loadFail') + '：请选择图片文件');
    return;
  }
  var reader = new FileReader();
  reader.onload = function () { onImage({ data: String(reader.result), mediaType: file.type, name: file.name }); };
  reader.onerror = function () { onError(t('loadFail')); };
  reader.readAsDataURL(file);
}

/**
 * 图片投放区：Ctrl/⌘+V 粘贴、拖入、或选文件 —— 三条路都进同一个 onImage。
 * 接入面板（新接口）与「分析辅助」（重新分析）共用这一个组件。
 *
 * @param {{t: Function, image: object|null, hint: string, pickLabel: string, readyText: string, clearLabel: string, onImage: Function, onError: Function, onClear: Function}} props 属性。
 * @returns {object} React 元素。
 */
export function ImageDrop(props) {
  var t = props.t;
  var image = props.image;
  var takeFiles = function (files) {
    if (files === null || files === undefined || files.length === 0) return;
    readImageFile(files[0], t, props.onImage, props.onError);
  };
  var takeClipboard = function (event) {
    var items = event.clipboardData === null || event.clipboardData === undefined ? [] : event.clipboardData.items;
    for (var index = 0; index < items.length; index += 1) {
      if (items[index].type !== undefined && items[index].type.indexOf('image/') === 0) takeFiles([items[index].getAsFile()]);
    }
  };
  return h('div', {
    className: 'duq-drop' + (image === null ? '' : ' has-image'),
    onDragOver: function (event) { event.preventDefault(); },
    onDrop: function (event) { event.preventDefault(); takeFiles(event.dataTransfer === null ? null : event.dataTransfer.files); },
    onPaste: takeClipboard
  },
  image === null
    ? h('div', { className: 'duq-drop-hint' },
      h('span', null, props.hint),
      h('label', { className: 'duq-file' }, props.pickLabel,
        h('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: function (event) { takeFiles(event.target.files); } })))
    : h('div', { className: 'duq-drop-filled' },
      h('img', { className: 'duq-thumb', src: image.data, alt: '' }),
      h('span', { className: 'duq-drop-text' }, props.readyText),
      h(Button, { quiet: true, onClick: props.onClear }, props.clearLabel))
  );
}

/**
 * 横幅（提示条）。
 *
 * @param {{tone?: string, title?: string, actions?: object}} props 属性。
 * @returns {object} React 元素。
 */
export function Banner(props) {
  return h('div', { className: 'duq-banner is-' + (props.tone || 'info') },
    h('div', { className: 'duq-banner-body' },
      props.title === undefined ? null : h('div', { className: 'duq-banner-title' }, props.title),
      h('div', { className: 'duq-banner-text' }, props.children)
    ),
    props.actions === undefined ? null : h('div', { className: 'duq-banner-actions' }, props.actions)
  );
}

/**
 * 用量视图：主指标 + 进度 + 明细 + 分卡片。全部字段都已由 Host 算好。
 *
 * @param {{view: object, t: Function, placeholder?: string, maxCards?: number}} props 属性。
 * @returns {object} React 元素。
 */
export function UsageView(props) {
  var view = props.view;
  if (view === null || view === undefined) {
    return h('div', { className: 'duq-placeholder' }, props.placeholder === undefined ? props.t('noSelection') : props.placeholder);
  }
  return h('div', { className: 'duq-view' },
    view.primary === null || view.primary === undefined ? null : h('div', { className: 'duq-hero' },
      h('div', { className: 'duq-hero-label' }, view.primary.label),
      h('div', { className: 'duq-hero-value' }, view.primary.text),
      view.primary.percent === null || view.primary.percent === undefined ? null : h(Bar, { percent: view.primary.percent, tone: view.primary.tone || 'brand' })
    ),
    view.progress === null || view.progress === undefined ? null : h('div', { className: 'duq-progress' },
      h('div', { className: 'duq-progress-head' },
        h('span', null, view.progress.label || props.t('metricLabel')),
        h('span', { className: 'duq-progress-value' }, view.progress.text)
      ),
      h(Bar, { percent: view.progress.percent })
    ),
    Array.isArray(view.metrics) && view.metrics.length > 0 ? h(MetricBlock, { metrics: view.metrics, t: props.t }) : null,
    Array.isArray(view.cards) && view.cards.length > 0 ? h(CardGrid, { cards: view.cards, t: props.t, maxCards: props.maxCards }) : null
  );
}
