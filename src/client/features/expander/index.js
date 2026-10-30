// src/client/features/expander/index.js
//
// 「插件更新」功能（dsh-plugin-expander 的客户端半边）在聚合插件里的入口。
//
// 这里是**功能契约**的实现。src/client/features/index.js 登记本模块，
// 聚合入口（src/client/index.js）按契约调用：
//
//   meta         { id, namespace, hubOrder }   —— 功能标识
//   dictionaries { zh, en }                    —— 完整字典（含 hubTab）
//   apply(ctx, t)                             —— 装配本功能自己的槽位与 effect
//   HubView(props)                            —— 聚合设置页里渲染的视图（props = { t, ctx }）
//
// 与旧插件的对应关系：
//   旧 client/client.js（IIFE + window.__ModuleLoader__.load） → 本文件
//   旧文件里的 factory scope（React / h / useState / ENDPOINT / callApi /
//   makeTranslator）→ 共享内核 src/client/runtime.js、shared/api.js、
//   shared/i18n.js、shared/constants.js
//   旧文件里的 apply(ctx)                                 → 本文件的 apply(ctx, t)
//
// 三条硬规则（照 cordis-plugin-development 的 UI 约定，迁移后仍然成立）：
//   · 只通过 ctx.slots 注册，不动别人的节点与样式；
//   · 样式只用 --dsw-alias-* 主题 token，所以浅色/深色两边都跟着宿主走；
//   · 不 import 任何 DSH 客户端包，React 走共享 runtime（宿主注入）。
//
// 渲染是**哑的**：查版本、跑更新、判状态全在 Host 侧（src/host/features/expander/），
// 这里只画 —— 所以 Host 那边加了能力，这个文件一行都不用改。
//
// ⚠️ 模块顶层**不要调用 h(...)**：共享 runtime 的 React 要等聚合入口的 factory 里
//   installRuntime(require) 之后才就绪。顶层只声明函数与常量。

import { React, h, useState, useEffect, useCallback } from '../../runtime.js';
import { makeTranslator } from '../../shared/i18n.js';
import { callApi } from '../../shared/api.js';
import { EXPANDER_ENDPOINT } from '../../shared/constants.js';

/**
 * locale 命名空间。
 *
 * ⚠️ 保持 'pluginExpander' 不变：改名会让新旧命名空间并存
 * （locale 服务按命名空间存字典，旧的不注销就一直占着）。
 */
const NS = 'pluginExpander';

/** <style> 元素的 data-* 标记值。 */
const STYLE_ID = 'dsh-plugin-expander-style';

/* ─────────────────────────── 文案 ─────────────────────────── */
// zh 是基准字典；en 缺 key 时回落到 zh（见共享的 makeTranslator）。

const zh = {
  tab: '更新',
  title: '插件更新',
  intro: '检测当前 profile 已装插件的新版本：npm 包查注册表，git 包比远端仓库的 HEAD。更新走 DSH 官方插件管理器的「卸载 + 安装」两步，完成后立即生效。',
  check: '检查更新',
  updateAll: '全部更新',
  updateSelected: '更新选中',
  update: '更新',
  empty: '没有可检测的插件：这个 profile 的插件都由 DSH 发行版提供。',
  nothingUpdatable: '全部都是最新版本。',
  unknown: '查不到',
  statusUpdate: '有更新',
  statusCurrent: '已是最新',
  statusAhead: '本地版本更新',
  statusUnknown: '状态未知',
  statusPinned: '固定提交',
  statusLocal: '本地开发包',
  kindNpm: 'npm',
  kindGit: 'git',
  kindLocal: '本地',
  kindUnknown: '未知来源',
  running: '正在更新 {name}…',
  done: '已更新 {count} 个插件。',
  failed: '有 {count} 个更新失败。',
  selectAll: '全选可更新的',
  unselectAll: '取消全选',
  resultOk: '已更新',
  resultFail: '失败',
  restart: '更新已保存，但需要重启 DSH 才生效。',
  foot: '检测到的最新版本来自 npm 注册表与远端 git 仓库；安装动作由 DSH 官方插件管理器执行（同一把 profile 写锁、失败自动回滚）。',
  // 聚合设置页的页签标签（src/client/hub/panel.js 取的是这个 key）。
  hubTab: '插件更新',
};

const en = {
  tab: 'Updates',
  title: 'Plugin updates',
  intro: 'Checks the plugins installed in this profile for newer releases: npm packages against the registry, git packages against the remote HEAD. Updates reuse the DSH plugin manager\'s remove-then-install flow and take effect immediately.',
  check: 'Check for updates',
  updateAll: 'Update all',
  updateSelected: 'Update selected',
  update: 'Update',
  empty: 'Nothing to check: every plugin in this profile ships with the DSH release.',
  nothingUpdatable: 'Everything is up to date.',
  unknown: 'unknown',
  statusUpdate: 'Update available',
  statusCurrent: 'Up to date',
  statusAhead: 'Local is newer',
  statusUnknown: 'Status unknown',
  statusPinned: 'Pinned commit',
  statusLocal: 'Local checkout',
  kindNpm: 'npm',
  kindGit: 'git',
  kindLocal: 'local',
  kindUnknown: 'unknown source',
  running: 'Updating {name}…',
  done: 'Updated {count} plugin(s).',
  failed: '{count} update(s) failed.',
  selectAll: 'Select all updatable',
  unselectAll: 'Clear selection',
  resultOk: 'updated',
  resultFail: 'failed',
  restart: 'The change is saved but needs a DSH restart to take effect.',
  foot: 'Latest versions come from the npm registry and remote git repositories; installs are executed by the DSH plugin manager (same profile lock, automatic rollback on failure).',
  // 聚合设置页的页签标签。
  hubTab: 'Updates',
};

/* ─────────────────────────── 功能契约 ──────────────────────────── */

/**
 * 功能标识。
 *
 * namespace 保持 pluginExpander；hubOrder 30 —— 聚合页里排第三
 * （主题 10 / 用量 20 / 插件更新 30）。
 */
export const meta = { id: 'expander', namespace: NS, hubOrder: 30 };

/**
 * 完整字典。聚合入口拿它注册 locale 命名空间
 * （src/client/index.js → ctx.locale.register(feature.meta.namespace, feature.dictionaries)）。
 * 必须含 hubTab —— 聚合页的页签标签取自它。
 */
export const dictionaries = { zh, en };

/* ─────────────────────────── 文案工具 ─────────────────────────── */

/**
 * 兜底翻译：直接用内置字典（zh 是基准；en 缺 key 时也回落到这里）。
 *
 * @param {string} key 键名。
 * @param {object} [vars] 插值变量。
 * @returns {string} 文案。
 */
function fallbackTranslate(key, vars) {
  const text = zh[key] !== undefined ? zh[key] : key;
  return vars === undefined ? text : text.replace(/\{(\w+)\}/g, function (match, name) {
    return vars[name] === undefined ? match : String(vars[name]);
  });
}

/* ─────────────────────────── 接口 ─────────────────────────── */

// 路由前缀走共享常量：/dsh-usage-aggregator/expander
// （旧插件是 /dsh-plugin-expander —— 聚合后前缀变了，但两个方法的语义没变）。
const api = {
  state: function (refresh) { return callApi('GET', EXPANDER_ENDPOINT + '/state' + (refresh === true ? '?refresh=1' : '')); },
  update: function (payload) { return callApi('POST', EXPANDER_ENDPOINT + '/update', payload); },
};

/* ─────────────────────────── 样式（只用主题 token） ─────────────────────────── */

const CSS = [
  '.dpe-root{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary);}',
  '.dpe-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;}',
  '.dpe-headtext{flex:1 1 auto;min-width:0;}',
  '.dpe-title{margin:0;font-size:16px;font-weight:600;white-space:nowrap;}',
  '.dpe-sub{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary);max-width:76ch;}',
  '.dpe-head-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end;}',
  '.dpe-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
  '.dpe-row{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}',
  '.dpe-row:hover{background:var(--dsw-alias-interactive-bg-hover);}',
  '.dpe-row.is-busy{opacity:.7;}',
  '.dpe-check{margin-top:3px;width:15px;height:15px;flex:0 0 auto;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;}',
  '.dpe-check:disabled{opacity:.4;cursor:not-allowed;}',
  '.dpe-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px;}',
  '.dpe-titlerow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
  '.dpe-name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.dpe-desc{font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
  '.dpe-meta{display:flex;align-items:center;gap:6px 12px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary);}',
  '.dpe-version{font-variant-numeric:tabular-nums;}',
  '.dpe-version b{color:var(--dsw-alias-label-primary);font-weight:600;}',
  '.dpe-arrow{color:var(--dsw-alias-label-secondary);}',
  '.dpe-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
  '.dpe-badge.is-update{background:color-mix(in srgb,var(--dsw-alias-state-info-primary) 16%,transparent);color:var(--dsw-alias-state-info-primary);}',
  '.dpe-badge.is-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-state-success-primary);}',
  '.dpe-badge.is-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent);color:var(--dsw-alias-state-warn-primary);}',
  '.dpe-badge.is-idle{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}',
  '.dpe-actions{display:flex;align-items:center;gap:8px;flex-shrink:0;}',
  '.dpe-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;}',
  '.dpe-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
  '.dpe-btn.is-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);}',
  '.dpe-btn.is-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}',
  '.dpe-btn.is-quiet{border-color:transparent;color:var(--dsw-alias-label-secondary);}',
  '.dpe-btn.is-quiet:hover:not(:disabled){color:var(--dsw-alias-label-primary);}',
  '.dpe-btn:disabled{opacity:.5;cursor:not-allowed;}',
  '.dpe-banner{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);}',
  '.dpe-banner.is-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);}',
  '.dpe-banner.is-info{background:color-mix(in srgb,var(--dsw-alias-state-info-primary) 8%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-state-info-primary) 30%,transparent);}',
  '.dpe-banner.is-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,transparent);}',
  '.dpe-banner-text{font-size:12px;color:var(--dsw-alias-label-secondary);}',
  '.dpe-banner-title{font-weight:600;font-size:12px;}',
  '.dpe-empty{padding:18px 14px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary);}',
  '.dpe-foot{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);}',
  '.dpe-list{display:flex;flex-direction:column;gap:8px;}'
].join('\n');

/**
 * 样式组件。样式随组件渲染，卸载时一起消失（不往 document.head 里塞）。
 *
 * @returns {object} React 元素。
 */
function Styles() {
  return h('style', { 'data-dsh-plugin-expander': STYLE_ID, dangerouslySetInnerHTML: { __html: CSS } });
}

/* ─────────────────────────── 视图 ─────────────────────────── */

/**
 * 状态 → 文案与色调。
 *
 * @param {string} status Host 给的状态。
 * @param {function} t 翻译函数。
 * @returns {{text: string, tone: string}} 文案与色调类名后缀。
 */
function statusText(status, t) {
  if (status === 'update-available') return { text: t('statusUpdate'), tone: 'is-update' };
  if (status === 'current') return { text: t('statusCurrent'), tone: 'is-ok' };
  if (status === 'ahead') return { text: t('statusAhead'), tone: 'is-warn' };
  if (status === 'pinned') return { text: t('statusPinned'), tone: 'is-idle' };
  if (status === 'local') return { text: t('statusLocal'), tone: 'is-idle' };
  return { text: t('statusUnknown'), tone: 'is-idle' };
}

/**
 * 来源 → 文案。
 *
 * @param {string} kind Host 给的来源。
 * @param {function} t 翻译函数。
 * @returns {string} 文案。
 */
function kindText(kind, t) {
  if (kind === 'npm') return t('kindNpm');
  if (kind === 'git') return t('kindGit');
  if (kind === 'local') return t('kindLocal');
  return t('kindUnknown');
}

/**
 * 一个插件行。
 *
 * @param {object} props 组件属性。
 * @returns {object} React 元素。
 */
function PackageRow(props) {
  const item = props.item;
  const t = props.t;
  const badge = statusText(item.status, t);
  const busy = props.busy;
  return h('div', { className: 'dpe-row' + (busy ? ' is-busy' : '') },
    h('input', {
      type: 'checkbox',
      className: 'dpe-check',
      checked: props.selected === true,
      disabled: item.updatable !== true || busy === true,
      onChange: function (event) { props.onToggle(item.name, event.target.checked); }
    }),
    h('div', { className: 'dpe-main' },
      h('div', { className: 'dpe-titlerow' },
        h('span', { className: 'dpe-name' }, item.title || item.name),
        h('span', { className: 'dpe-badge ' + badge.tone }, badge.text),
        h('span', { className: 'dpe-badge' }, kindText(item.kind, t))
      ),
      item.description !== undefined && item.description !== null && item.description !== ''
        ? h('div', { className: 'dpe-desc' }, item.description)
        : null,
      h('div', { className: 'dpe-meta' },
        h('span', { className: 'dpe-version' },
          h('b', null, item.version === null || item.version === undefined ? t('unknown') : item.version),
          item.latest !== null && item.latest !== undefined && item.latest !== item.version
            ? h('span', { className: 'dpe-arrow' }, ' → ' + item.latest)
            : null
        ),
        h('span', null, item.name)
      )
    ),
    h('div', { className: 'dpe-actions' },
      item.updatable === true
        ? h('button', {
          type: 'button',
          className: 'dpe-btn',
          disabled: busy === true,
          onClick: function () { props.onUpdate(item.name); }
        }, t('update'))
        : null
    )
  );
}

/**
 * 「更新」标签页。
 *
 * 状态（清单、勾选、忙碌、错误）都在这个组件里 —— 槽位注册的渲染函数每次
 * 渲染都新建一个组件实例，状态要挂在组件上，不能挂在 apply() 里（那不是
 * React 组件，Hook 在那里调用会直接崩）。
 *
 * @param {object} props 组件属性。
 * @returns {object} React 元素。
 */
function UpdatesTab(props) {
  const t = props.t;
  // initialState 只给离线渲染自检用（scripts/render-check.mjs）：真页面上永远是
  // null，数据由下面的 useEffect 去 Host 拉。
  const [state, setState] = useState(props.initialState ?? null);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const packages = state === null || state === undefined || state.packages === undefined ? [] : state.packages;
  const updatable = packages.filter(function (item) { return item.updatable === true; });
  const job = state === null || state === undefined ? undefined : state.job;
  const running = job !== undefined && job !== null && job.running === true;

  /**
   * 读一次状态。
   *
   * @param {boolean} refresh 是否强制重查注册表。
   * @returns {Promise<void>} 完成。
   */
  const load = useCallback(function (refresh) {
    return api.state(refresh === true).then(function (next) {
      setState(next);
      setError('');
    }).catch(function (failure) {
      setError(String(failure.message || failure));
    });
  }, []);

  useEffect(function () {
    load(true);
  }, [load]);

  // 有任务在跑时轮询，直到它结束。
  useEffect(function () {
    if (running !== true) return undefined;
    const timer = window.setInterval(function () {
      load(false);
    }, 2000);
    return function () { window.clearInterval(timer); };
  }, [running, load]);

  /**
   * 启动一次更新。真正的进度由轮询拿回来。
   *
   * @param {object} payload 请求体（names 或 all）。
   * @returns {void}
   */
  const startUpdate = useCallback(function (payload) {
    setBusy(true);
    setError('');
    setMessage('');
    api.update(payload).catch(function (failure) {
      setBusy(false);
      setError(String(failure.message || failure));
    });
  }, []);

  // 任务跑完（running 由 true 变 false）时解除置灰并报结果。
  useEffect(function () {
    if (busy !== true) return;
    if (state === null || state === undefined || state.job === undefined || state.job === null) return;
    if (state.job.running === true) return;
    setBusy(false);
    const results = Array.isArray(state.job.results) ? state.job.results : [];
    const failed = results.filter(function (item) { return item.ok !== true; });
    if (failed.length === 0) setMessage(t('done', { count: results.length }));
    else setMessage(t('failed', { count: failed.length }));
    setSelected([]);
    load(true);
  }, [state, busy, load, t]);

  const onToggle = useCallback(function (name, checked) {
    setSelected(function (current) {
      if (checked) return current.indexOf(name) >= 0 ? current : current.concat([name]);
      return current.filter(function (item) { return item !== name; });
    });
  }, []);

  const onSelectAll = useCallback(function (checked) {
    setSelected(checked ? updatable.map(function (item) { return item.name; }) : []);
  }, [updatable]);

  const onUpdateOne = useCallback(function (name) {
    startUpdate({ names: [name] });
  }, [startUpdate]);

  const onUpdateSelected = useCallback(function () {
    setSelected(function (current) {
      if (current.length > 0) startUpdate({ names: current });
      return current;
    });
  }, [startUpdate]);

  const onUpdateAll = useCallback(function () {
    startUpdate({ all: true });
  }, [startUpdate]);

  const onCheck = useCallback(function () {
    setBusy(true);
    load(true).then(function () { setBusy(false); });
  }, [load]);

  return h('div', { className: 'dpe-root' },
    h(Styles, null),
    h('header', { className: 'dpe-head' },
      h('div', { className: 'dpe-headtext' },
        h('h2', { className: 'dpe-title' }, t('title')),
        h('p', { className: 'dpe-sub' }, t('intro'))
      ),
      h('div', { className: 'dpe-head-actions' },
        h('button', {
          type: 'button',
          className: 'dpe-btn is-quiet',
          disabled: busy === true,
          onClick: onCheck
        }, t('check')),
        updatable.length > 0
          ? h('button', {
            type: 'button',
            className: 'dpe-btn',
            disabled: busy === true,
            onClick: function () { onSelectAll(true); }
          }, t('selectAll'))
          : null,
        selected.length > 0
          ? h('button', {
            type: 'button',
            className: 'dpe-btn is-quiet',
            disabled: busy === true,
            onClick: function () { onSelectAll(false); }
          }, t('unselectAll'))
          : null,
        selected.length > 0
          ? h('button', {
            type: 'button',
            className: 'dpe-btn',
            disabled: busy === true,
            onClick: onUpdateSelected
          }, t('updateSelected') + '（' + selected.length + '）')
          : null,
        updatable.length > 0
          ? h('button', {
            type: 'button',
            className: 'dpe-btn is-primary',
            disabled: busy === true,
            onClick: onUpdateAll
          }, t('updateAll') + '（' + updatable.length + '）')
          : null
      )
    ),

    error !== '' ? h('div', { className: 'dpe-banner is-error' },
      h('div', null,
        h('div', { className: 'dpe-banner-title' }, t('resultFail')),
        h('div', { className: 'dpe-banner-text' }, error)
      )
    ) : null,

    message !== '' ? h('div', { className: 'dpe-banner is-info' },
      h('div', null, h('div', { className: 'dpe-banner-text' }, message))
    ) : null,

    running
      ? h('div', { className: 'dpe-banner is-warn' },
        h('div', null,
          h('div', { className: 'dpe-banner-title' }, t('running', { name: job.current === null || job.current === undefined ? '' : job.current })),
          h('div', { className: 'dpe-banner-text' }, t('foot'))
        )
      )
      : null,

    packages.length === 0
      ? h('div', { className: 'dpe-card' }, h('div', { className: 'dpe-empty' }, t('empty')))
      : h('div', { className: 'dpe-list' },
        packages.map(function (item) {
          return h(PackageRow, {
            key: item.name,
            item: item,
            t: t,
            busy: busy,
            selected: selected.indexOf(item.name) >= 0,
            onToggle: onToggle,
            onUpdate: onUpdateOne
          });
        })
      ),

    packages.length > 0 && updatable.length === 0 && busy !== true
      ? h('div', { className: 'dpe-card' }, h('div', { className: 'dpe-empty' }, t('nothingUpdatable')))
      : null,

    h('p', { className: 'dpe-foot' }, t('foot'))
  );
}

/* ─────────────────────────── 装配 ─────────────────────────── */

/**
 * 装配本功能。
 *
 * 只装**本功能自己的**槽位：
 *   · plugins.tab —— 侧栏「插件」页里的「更新」标签页（id / order 不变）。
 *   · ~~inject 导出~~ —— **刻意不导出**：聚合入口统一声明
 *     （见 src/client/index.js 的 `export const inject = ['slots', 'locale', 'theme']`）。
 *   · ~~ctx.locale.register(NS, …)~~ —— **刻意不注册**：聚合入口统一注册各功能的
 *     命名空间（见 src/client/index.js），字典在这里以 dictionaries 导出。
 *
 * @param {object} ctx 插件上下文。
 * @param {Function} t 本功能命名空间的 translator（聚合入口传进来）。
 */
export function apply(ctx, t) {
  // 聚合入口已经绑好了本命名空间的 translator；独立装配时退回共享的
  // makeTranslator（永远返回非空字符串，en 缺 key 时回落到 zh）。
  const translator = typeof t === 'function' ? t : makeTranslator(ctx.locale, NS, zh);

  ctx.slots.inject('plugins.tab', function () {
    return ctx.slots.register({
      name: 'plugins.tab',
      id: 'updates',
      order: 20,
      // 用 thunk：宿主每次投影都重新求值，切换语言不必重新注册。
      label: function () { return translator('tab'); },
      locale: NS,
      inject: function () { return { t: translator }; }
    }, function () {
      return h(UpdatesTab, { t: translator });
    });
  });
}

/**
 * 聚合设置页里本功能的视图。
 *
 * 渲染 Styles + UpdatesTab —— UpdatesTab 自己也带一份 Styles（样式跟着组件走，
 * 插件页那个槽位不在设置面板里，必须自带样式），所以这里多渲染的那一份是
 * 同内容的重复声明，浏览器行为完全一致。
 *
 * @param {{t: Function, ctx: object}} props 属性。
 * @returns {object} React 元素。
 */
export function HubView(props) {
  const t = typeof props.t === 'function' ? props.t : fallbackTranslate;
  return h(React.Fragment, null, h(Styles, null), h(UpdatesTab, { t: t }));
}

/**
 * 离线渲染自检用（scripts/render-check.mjs）：把组件暴露出来，好在没有浏览器的
 * 环境里用 react-dom/server 真渲染一遍，抓「组件一渲染就崩」这类只在页面上
 * 才暴露的问题。运行时不受影响（聚合入口只认 meta / dictionaries / apply / HubView）。
 */
export const __ui = {
  UpdatesTab: UpdatesTab,
  PackageRow: PackageRow,
  Styles: Styles,
  statusText: statusText,
  kindText: kindText,
  fallbackTranslate: fallbackTranslate,
  zh: zh,
  en: en,
};
