// src/client/features/usage/model-picker.js
//
// 分析模型 cascader（对应源插件的 09-model-picker.js）。
//
// ⚠️ 两处交互细节一个字都不要改：
//   1. 浮层用 fixed + 真实坐标定位 —— 设置面板的内容列会裁剪绝对定位的子元素；
//   2. 挂载后自纠正偏移 —— 祖先有 transform / filter / backdrop-filter 时，
//      fixed 的包含块会换人，量一次真实位置把偏差补回来（只纠正一次，避免抖动）。

import { h, useState, useEffect, useRef } from '../../runtime.js';
import { api } from './api.js';

/**
 * 分析模型级联选择器：一个按钮 + 一个浮层（先 provider 后 model）。
 *
 * @param {{t: Function, onChanged: Function}} props 属性。
 * @returns {object} React 元素。
 */
export function AnalysisModelPicker(props) {
  var t = props.t;
  var [data, setData] = useState(null);
  var [open, setOpen] = useState(false);
  var [hoverProvider, setHoverProvider] = useState(null);
  var [busy, setBusy] = useState(false);
  var [error, setError] = useState('');
  var [anchor, setAnchor] = useState(null);
  var wrapRef = useRef(null);
  var panelRef = useRef(null);

  var load = function () {
    return api.models().then(function (next) { setData(next); }).catch(function (failure) {
      setError(String(failure.message || failure));
    });
  };

  /** 浮层用 fixed + 真实坐标定位：设置面板的内容列会裁剪绝对定位的子元素。 */
  var measure = function () {
    var node = wrapRef.current;
    if (node === null || node === undefined) return;
    var rect = node.getBoundingClientRect();
    var width = 340;
    var left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setAnchor({ top: rect.bottom + 6, left: left });
  };

  useEffect(function () { load(); }, []);

  // 点击外面或 Esc 关闭；浮层贴着按钮，不跟随页面滚动移动（按钮本身是相对定位的）。
  useEffect(function () {
    if (!open) return undefined;
    var onDoc = function (event) {
      if (wrapRef.current !== null && !wrapRef.current.contains(event.target)) setOpen(false);
    };
    var onKey = function (event) { if (event.key === 'Escape') setOpen(false); };
    var onScroll = function () { setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return function () {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  var current = data === null ? null : data.current;
  var providers = data === null || !Array.isArray(data.providers) ? [] : data.providers;

  var apply = function (providerId, modelId) {
    setBusy(true);
    setError('');
    api.setAnalysisModel(providerId, modelId).then(function (result) {
      setBusy(false);
      setOpen(false);
      setData(function (prev) {
        return prev === null ? prev : { ...prev, current: result.current };
      });
      return props.onChanged();
    }).catch(function (failure) {
      setBusy(false);
      setError(String(failure.message || failure));
    });
  };

  // 浮层里正在预览的 provider（鼠标悬停即切换右列）；默认跟着当前 provider。
  var activeId = hoverProvider !== null ? hoverProvider : (current === null ? '' : current.provider);
  var active = providers.filter(function (item) { return item.id === activeId; })[0] ?? null;
  var modelOptions = active !== null && Array.isArray(active.models) ? active.models : [];
  // 当前模型若不在清单里（配置手写 / provider 拉不到清单），补一个标着「默认」的选项，避免显示空白
  if (current !== null && current.model !== '' && !modelOptions.some(function (item) { return item.id === current.model; })) {
    modelOptions = [{ id: current.model, name: current.model + '（' + t('analysisDefault') + '）' }].concat(modelOptions);
  }

  // 自纠正：fixed 的包含块本该是视口；若祖先有 transform / filter / backdrop-filter
  // 就换人了，这里量一次真实位置把偏差补回来（只纠正一次，避免抖动）。
  useEffect(function () {
    if (!open || anchor === null) return;
    var node = panelRef.current;
    var trigger = wrapRef.current;
    if (node === null || trigger === null) return;
    var driftTop = Math.round(node.getBoundingClientRect().top - anchor.top);
    var driftLeft = Math.round(node.getBoundingClientRect().left - anchor.left);
    if (Math.abs(driftTop) <= 4 && Math.abs(driftLeft) <= 4) return;
    setAnchor({ top: anchor.top + 6 - driftTop, left: Math.max(8, anchor.left - driftLeft) });
  }, [open, anchor]);

  var label = current === null || current.model === ''
    ? t('analysisMissing')
    : current.provider + ' / ' + current.model;

  return h('div', { className: 'duq-cascader', ref: wrapRef },
    h('button', {
      type: 'button',
      className: 'duq-cascader-trigger' + (current === null || current.model === '' ? ' is-warn' : '') + (open ? ' is-open' : ''),
      title: t('analysisPick'),
      'aria-expanded': open,
      'aria-haspopup': 'true',
      disabled: busy,
      onClick: function () {
        if (open) {
          setOpen(false);
          return;
        }
        measure();
        setOpen(true);
        load();
      }
    },
    h('span', { className: 'duq-cascader-label' }, t('analysisModel')),
    h('span', { className: 'duq-cascader-value' }, label),
    h('span', { className: 'duq-cascader-caret' }, '▾')
    ),
    open ? h('div', {
      className: 'duq-cascader-panel',
      ref: panelRef,
      style: anchor === null ? undefined : { top: anchor.top + 'px', left: anchor.left + 'px' }
    },
      h('div', { className: 'duq-cascader-col' },
        providers.length === 0 ? h('div', { className: 'duq-cascader-empty' }, error !== '' ? error : t('analysisMissing')) : null,
        providers.map(function (item) {
          return h('button', {
            type: 'button',
            key: item.id,
            className: 'duq-cascader-item' + (item.id === activeId ? ' is-on' : ''),
            onMouseEnter: function () { setHoverProvider(item.id); },
            onClick: function () { setHoverProvider(item.id); }
          }, h('span', { className: 'duq-cascader-item-name' }, item.name), h('span', { className: 'duq-cascader-item-sub' }, item.id));
        })
      ),
      h('div', { className: 'duq-cascader-col' },
        active === null ? h('div', { className: 'duq-cascader-empty' }, '…') : null,
        active !== null && Array.isArray(active.models) && active.models.length === 0 && active.error !== undefined
          ? h('div', { className: 'duq-cascader-empty' }, active.error)
          : null,
        modelOptions.map(function (model) {
          var isCurrent = current !== null && model.id === current.model;
          return h('button', {
            type: 'button',
            key: model.id,
            className: 'duq-cascader-item' + (isCurrent ? ' is-on' : ''),
            onClick: function () { apply(active === null ? '' : active.id, model.id); }
          }, model.name);
        })
      )
    ) : null
  );
}
