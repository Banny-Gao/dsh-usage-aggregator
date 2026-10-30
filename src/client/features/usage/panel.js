// src/client/features/usage/panel.js
//
// 根面板（对应源插件的 12-panel.js）。
//
// 聚合页里这个面板由 HubView → PanelShell 渲染（PanelShell = <Styles/> + <Panel/>）。

import { h, useState, useEffect } from '../../runtime.js';
import { api } from './api.js';
import { intervalText, statusTone } from './format.js';
import { Banner, Button } from './atoms.js';
import { ProviderDetail } from './provider.js';
import { ImportPanel } from './import-panel.js';
import { AnalysisModelPicker } from './model-picker.js';

/**
 * 客户端构建时间。
 *
 * 旧插件的构建脚本（scripts/build-client.mjs）在产物最外层注入 `var BUILD_AT = "…"`，
 * 本文件用 `typeof BUILD_AT === 'string'` 读它。现在整包走 Vite，注入方式换成
 * `define: { __BUILD_AT__: … }`（见 vite/config.mjs）—— 读法跟着换，但**判定与降级一致**：
 * 取不到就是空串，页面上那一小段不显示，不报错。
 *
 * `typeof __BUILD_AT__` 对未声明标识符不抛异常，所以没注入 define 的构建
 * （比如单独跑 esbuild 校验）也安全 —— true 分支根本不会被求值。
 *
 * @see src/client/index.js —— 聚合入口用同一套 define，聚合页自己也会显示构建时间。
 */
/* global __BUILD_AT__ */
const BUILD_AT = (function () {
  if (typeof __BUILD_AT__ === 'string') return __BUILD_AT__;
  var scope = typeof globalThis !== 'undefined' ? globalThis : {};
  if (typeof scope.__DSH_CLIENT_BUILD_AT__ === 'string') return scope.__DSH_CLIENT_BUILD_AT__;
  return '';
})();

/**
 * 根面板：接口列表 + 详情 + 接入。
 *
 * @param {{t: Function}} props 属性。
 * @returns {object} React 元素。
 */
export function Panel(props) {
  var t = props.t;
  var [state, setState] = useState(null);
  var [error, setError] = useState('');
  var [selectedId, setSelectedId] = useState(null);
  var [tab, setTab] = useState('list');
  var [preset, setPreset] = useState(null);
  var [busy, setBusy] = useState(false);
  var [message, setMessage] = useState('');

  var load = function () {
    return api.state().then(function (next) {
      setState(next);
      setError('');
      setSelectedId(function (current) {
        if (current !== null && next.providers.some(function (item) { return item.id === current; })) return current;
        return next.providers.length > 0 ? next.providers[0].id : null;
      });
    }).catch(function (failure) {
      setError(String(failure.message || failure));
    });
  };

  useEffect(function () {
    load();
    var timer = window.setInterval(function () {
      if (document.visibilityState === 'hidden') return;
      load();
    }, 20000);
    return function () { window.clearInterval(timer); };
  }, []);

  var providers = state === null ? [] : state.providers;
  var selected = providers.filter(function (item) { return item.id === selectedId; })[0] || null;

  var run = function (promise, okMessage) {
    setBusy(true);
    setMessage('');
    return promise.then(function () {
      setBusy(false);
      if (okMessage !== undefined) setMessage(okMessage);
      return load();
    }).catch(function (failure) {
      setBusy(false);
      setMessage(t('actionFail') + '：' + String(failure.message || failure));
    });
  };

  var refreshAll = function () {
    var queryable = providers.filter(function (item) { return item.queryable === true; });
    if (queryable.length === 0) return;
    setBusy(true);
    setMessage('');
    Promise.all(queryable.map(function (item) { return api.refresh(item.id).catch(function () { return null; }); }))
      .then(function () { setBusy(false); return load(); });
  };

  var analysisReady = state !== null && state.analysis !== undefined && state.analysis.ready === true;

  return h('div', { className: 'duq-root' },
    h('header', { className: 'duq-head' },
      h('div', { className: 'duq-headtext' },
        h('h2', { className: 'duq-title' }, t('title'))
      ),
      h('div', { className: 'duq-head-actions' },
        h(AnalysisModelPicker, { t: t, onChanged: load }),
        state === null || state.autoRefresh === undefined ? null : h('span', { className: 'duq-model' + (state.autoRefresh.enabled ? '' : ' is-off') },
          t('autoRefreshLabel') + '：' + (state.autoRefresh.enabled ? intervalText(state.autoRefresh.intervalSeconds, t) : t('autoOff'))),
        providers.length > 0 ? h(Button, { quiet: true, onClick: refreshAll, disabled: busy }, t('refreshAll')) : null
      )
    ),

    analysisReady ? null : h(Banner, { tone: 'warn', title: t('analysisMissing') }, t('analysisMissingBody')),
    error !== '' ? h(Banner, { tone: 'error', title: t('loadFail') }, error) : null,
    message !== '' ? h(Banner, { tone: 'info' }, message) : null,

    h('div', { className: 'duq-tabs' },
      providers.map(function (item) {
        return h('button', {
          type: 'button', key: item.id,
          className: 'duq-chip' + (tab === 'list' && item.id === selectedId ? ' is-on' : ''),
          onClick: function () { setTab('list'); setPreset(null); setSelectedId(item.id); }
        },
        h('span', { className: 'duq-chip-dot is-' + statusTone(item.status) }),
        item.label
        );
      }),
      h('button', {
        type: 'button',
        className: 'duq-chip is-add' + (tab === 'import' ? ' is-on' : ''),
        onClick: function () { setTab('import'); setPreset(null); }
      }, t('importTab'))
    ),

    tab === 'import'
      ? h(ImportPanel, {
        t: t,
        image: state === null ? undefined : state.image,
        preset: preset,
        onCancel: function () { setPreset(null); setTab('list'); },
        onImported: function (provider) {
          setTab('list');
          setPreset(null);
          if (provider !== null && provider !== undefined) setSelectedId(provider.id);
          load();
        }
      })
      : selected === null
        ? h('section', { className: 'duq-card duq-empty' },
          h('h3', { className: 'duq-card-title' }, t('emptyTitle')),
          h('p', { className: 'duq-sub' }, t('emptyBody')))
        : h(ProviderDetail, {
          key: selected.id,
          t: t,
          provider: selected,
          busy: busy,
          onReload: load,
          onRefresh: function (id) { run(api.refresh(id)); },
          // 交互续期：要等人扫码/点同意，可能一两分钟，期间面板是置灰的 ——
          // 这是有意的，不做「后台偷偷弹窗」，免得用户被一个凭空出现的窗口吓一跳。
          onRenew: function (id) { run(api.renew(id, true), t('renewDone')); },
          onReanalyze: function (id, image) { run(api.reanalyze(id, image === undefined ? undefined : image)); },
          onRemove: function (id) { run(api.remove(id)); },
          onUpdate: function (provider) { setPreset({ id: provider.id, label: provider.label }); setTab('import'); }
        }),

    h('p', { className: 'duq-foot' },
      '数据与登录态只存在本机（$DSH_HOME/dsh-usage-query/store.json，仅本人可读）。'
      + (state === null || state.autoRefresh === undefined || state.autoRefresh.enabled === false
        ? ''
        : '自动查询 ' + intervalText(state.autoRefresh.intervalSeconds, t) + '一轮。')
      // 构建时间：客户端产物**不保证**改完刷新页面就生效（dsh web 可能在进程
      // 启动时就读进了内存）。把时间摆出来，「我看到的界面是不是旧代码」一眼可知，
      // 不用再靠对比「改了什么 / 什么时候启的进程」倒推。
      + (BUILD_AT === '' ? '' : '　客户端构建于 ' + BUILD_AT + '。'))
  );
}
