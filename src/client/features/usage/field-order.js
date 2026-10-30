// src/client/features/usage/field-order.js
//
// 字段顺序编辑器（对应源插件的 07-field-order.js）。
//
// ⚠️ 两处交互细节一个字都不要改：
//   1. 行集合跟着 `signature` 走（不是 provider.id）—— 否则「恢复默认」后本地还留着旧顺序；
//   2. 拖拽只挂在 ⠿ 把手上 —— 整行 draggable 的话，点 ↑↓ 时手一抖就变成拖拽，按钮点不动。

import { h, useState, useEffect, useRef } from '../../runtime.js';
import { api } from './api.js';
import { Button } from './atoms.js';

/**
 * 列出可排序的字段（按**当前显示顺序**）。
 *
 * 以 view 里已经投影出来的顺序为基准（所见即所得），再把模板里有、当前却没投影出
 * 来的字段补在后面 —— 否则接口结构变了之后，新字段会「不在名单里」，用户想把它
 * 排进前五也没门。
 *
 * @param {object} provider 接口记录。
 * @returns {Array<{path: string, label: string}>} 行集合。
 */
export function fieldRows(provider) {
  var rows = [];
  var seen = {};
  var add = function (path, label) {
    if (typeof path !== 'string' || path === '' || seen[path] === true) return;
    seen[path] = true;
    rows.push({ path: path, label: typeof label === 'string' && label !== '' ? label : path });
  };
  var view = provider.view;
  if (view !== null && view !== undefined) {
    (view.metrics ?? []).forEach(function (metric) { add(metric.path, metric.label); });
    var first = Array.isArray(view.cards) && view.cards.length > 0 ? view.cards[0] : null;
    if (first !== null) (first.metrics ?? []).forEach(function (metric) { add(metric.path, metric.label); });
  }
  var template = provider.template;
  if (template !== null && template !== undefined) {
    (template.metrics ?? []).forEach(function (metric) { add(metric.path, metric.label); });
    if (template.collection !== null && template.collection !== undefined) {
      (template.collection.metrics ?? []).forEach(function (metric) { add(metric.path, metric.label); });
    }
  }
  return rows;
}

/**
 * 数组内搬动一项（纯函数，便于离线断言）。
 *
 * @param {Array<unknown>} items 数组。
 * @param {number} from 源下标。
 * @param {number} to 目标下标。
 * @returns {Array<unknown>} 新数组。
 */
export function moveItem(items, from, to) {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  var next = items.slice();
  var [picked] = next.splice(from, 1);
  next.splice(to, 0, picked);
  return next;
}

/**
 * 字段顺序编辑器：拖拽 + ↑↓ 微调，改完立刻存（Host 只重算 view，不重打上游）。
 *
 * 交互上用 HTML5 拖拽（鼠标），并保留 ↑↓ 按钮 —— 触摸板拖拽不稳、键盘也想调；
 * 两条路都走同一个 moveItem，不存在第二套顺序逻辑。
 *
 * @param {{t: Function, provider: object, onChanged: Function}} props 属性。
 * @returns {object|null} React 元素。
 */
export function FieldOrderEditor(props) {
  var t = props.t;
  var provider = props.provider;
  var [rows, setRows] = useState(function () { return fieldRows(provider); });
  var [status, setStatus] = useState('');
  var [tone, setTone] = useState('idle');
  var dragFrom = useRef(null);
  var [overIndex, setOverIndex] = useState(-1);

  // 行集合跟着 Host 的状态走：恢复默认、刷新后模板重排、接口结构变化都会让这个
  // 签名变掉，于是列表重新对齐一次（保存中/刚保存完时，签名恰好等于用户排的结果，
  // 不会跳）。只按 provider.id 同步是不够的 —— 那样「恢复默认」后本地还留着旧顺序。
  var signature = (Array.isArray(provider.fieldOrder) ? provider.fieldOrder.join('|') : '')
    + '#'
    + fieldRows(provider).map(function (row) { return row.path; }).join('|');
  useEffect(function () {
    setRows(fieldRows(provider));
  }, [signature]);

  var persist = function (next) {
    var previous = rows;
    setStatus(t('fieldOrderSaving'));
    setTone('idle');
    setRows(next);
    api.setFieldOrder(provider.id, next.map(function (row) { return row.path; }))
      .then(function () {
        setStatus(t('fieldOrderSaved'));
        setTone('ok');
      })
      .catch(function (failure) {
        // 回滚：保存失败还把新顺序留在列表里，就会出现「列表顺序 ≠ 卡片顺序」，
        // 比直接报错更让人困惑。
        setRows(previous);
        setStatus(String(failure && failure.message ? failure.message : failure));
        setTone('error');
      });
  };

  var move = function (from, to) {
    if (from === to || to < 0 || to >= rows.length) return;
    persist(moveItem(rows, from, to));
  };

  var reset = function () {
    setStatus(t('fieldOrderSaving'));
    setTone('idle');
    api.setFieldOrder(provider.id, [])
      .then(function () {
        setStatus(t('fieldOrderSaved'));
        setTone('ok');
        return props.onChanged();
      })
      .catch(function (failure) {
        setStatus(String(failure && failure.message ? failure.message : failure));
        setTone('error');
      });
  };

  if (rows.length === 0) return null;

  return h('details', { className: 'duq-details' },
    h('summary', null, t('fieldOrderTitle') + '（' + rows.length + '）'),
    h('p', { className: 'duq-sub' }, t('fieldOrderHint', { n: rows.length })),
    h('div', { className: 'duq-fields' }, rows.map(function (row, index) {
      return h('div', {
        className: 'duq-field-row' + (dragFrom.current === index ? ' is-drag' : '') + (overIndex === index ? ' is-over' : ''),
        key: row.path,
        // 拖拽只挂在把手上：整行 draggable 的话，点 ↑↓ 时手一抖就变成拖拽，
        // 按钮点不动（这个坑在别的列表里很常见）。
        onDragOver: function (event) {
          event.preventDefault();
          setOverIndex(index);
        },
        onDragLeave: function () { setOverIndex(-1); },
        onDrop: function (event) {
          event.preventDefault();
          setOverIndex(-1);
          if (dragFrom.current === null) return;
          move(dragFrom.current, index);
          dragFrom.current = null;
        }
      },
      h('span', {
        className: 'duq-grip',
        title: '拖拽排序',
        draggable: true,
        onDragStart: function (event) {
          dragFrom.current = index;
          if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.effectAllowed = 'move';
        },
        onDragEnd: function () {
          dragFrom.current = null;
          setOverIndex(-1);
        }
      }, '⠿'),
      h('span', { className: 'duq-field-index' }, String(index + 1)),
      h('span', { className: 'duq-field-label' }, row.label),
      h('span', { className: 'duq-field-path' }, row.path),
      h('button', {
        type: 'button', className: 'duq-iconbtn', disabled: index === 0,
        title: '上移', 'aria-label': '上移',
        onClick: function () { move(index, index - 1); }
      }, '↑'),
      h('button', {
        type: 'button', className: 'duq-iconbtn', disabled: index === rows.length - 1,
        title: '下移', 'aria-label': '下移',
        onClick: function () { move(index, index + 1); }
      }, '↓')
      );
    })),
    h('div', { className: 'duq-field-actions' },
      h(Button, { quiet: true, onClick: reset }, t('fieldOrderReset')),
      // 失败时把接口返回的原话摆出来（最常见的一句是「Host 侧路由不可用 → 重启」），
      // 只写「保存失败」等于把唯一的线索藏起来。
      status === '' ? null : h('span', { className: 'duq-field-status is-' + tone }, status)
    )
  );
}
