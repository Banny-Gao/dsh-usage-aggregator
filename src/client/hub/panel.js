// src/client/hub/panel.js
//
// 聚合设置页：一个入口，三个功能。
//
// 为什么不让三个功能各自注册一个 settings.section：
//   设置面板的导航条目就是 settings.section 的注册项 —— 每多一个功能就多一个
//   入口，这正是本次聚合要消除的问题。所以这里注册**一个** id 为
//   `usage-aggregator` 的 section，内容是一个页签条 + 当前功能的视图。
//
// 页签标签取自**聚合页自己的**字典（tabTheme / tabUsage / tabExpander），
// 键名由各功能的 meta.hubTabKey 指定 —— 见 src/client/hub/i18n.js 顶部
// 为什么不从功能的 `hubTab` 取。

import { React, h, useState } from '../runtime.js';
import { makeTranslator } from '../shared/i18n.js';
import { NS, zh, en } from './i18n.js';
import { Styles } from './styles.js';

/**
 * 聚合页主体。
 *
 * @param {{views: Array<object>, t: Function, ctx: object, buildAt?: string}} props 属性。
 * @returns {object} React 元素。
 */
export function HubPanel(props) {
  const views = props.views;
  // 默认选中的页签：优先取 meta.hubDefault 的功能（插件更新默认选中），
  // 没有就选第一个。useState 只认首次挂载的值，之后由用户点选决定。
  const fallbackId = views.length > 0 ? views[0].id : null;
  const defaultId = (function () {
    for (const view of views) {
      if (view.isDefault === true) return view.id;
    }
    return fallbackId;
  })();
  const [active, setActive] = useState(defaultId);

  let current = null;
  for (const view of views) {
    if (view.id === active) {
      current = view;
      break;
    }
  }
  if (current === null) current = views.length > 0 ? views[0] : null;

  if (current === null) {
    return h(React.Fragment, null, h(Styles, null), h('p', { className: 'dua-hub-hint' }, props.t('empty')));
  }

  return h(
    React.Fragment,
    null,
    h(Styles, null),
    h(
      'div',
      { className: 'dua-hub' },
      h(
        'div',
        { className: 'dua-hub-tabs', role: 'tablist' },
        views.map((view) =>
          h(
            'button',
            {
              key: view.id,
              type: 'button',
              role: 'tab',
              'aria-selected': view.id === current.id ? 'true' : 'false',
              className: 'dua-hub-tab' + (view.id === current.id ? ' dua-hub-tab-active' : ''),
              onClick: () => setActive(view.id),
            },
            // 每次渲染都求值 → 切换语言时标签跟着变（不能在建 views 时就定死）。
            props.t(view.hubTabKey),
          ),
        ),
      ),
      h(
        'div',
        { className: 'dua-hub-body' },
        h(current.View, { t: current.t, ctx: props.ctx }),
      ),
      props.buildAt
        ? h('p', { className: 'dua-hub-hint' }, props.t('buildAt', { at: props.buildAt }))
        : null,
    ),
  );
}

/**
 * 注册聚合设置页。
 *
 * @param {object} ctx 插件上下文。
 * @param {Array<{feature: object, t: Function}>} registry 功能登记表。
 * @param {{buildAt?: string}} meta 附加信息（构建时间等）。
 */
export function registerHub(ctx, registry, meta = {}) {
  // 聚合页自己的命名空间**必须在取 translator 之前注册** ——
  // 顺序反了的话 translator 探不到命名空间，会一直退回内置中文字典，
  // 英文用户看到的设置入口标题永远是中文。
  ctx.effect(
    function () {
      var dispose = null;
      try {
        dispose = ctx.locale.register(NS, { zh: zh, en: en });
      } catch (err) {
        // 命名空间已被占用（例如 HMR 后残留）：不阻断插件，退回内置字典。
        console.warn('[dsh-usage-aggregator] hub locale register failed', err);
      }
      return function () {
        if (typeof dispose === 'function') dispose();
      };
    },
    'dsh-usage-aggregator: hub locale',
  );

  const t = makeTranslator(ctx.locale, NS, zh);

  // 页签顺序 = 各功能 meta.hubOrder；标签键 = 各功能 meta.hubTabKey。
  const views = registry
    .map((entry) => ({
      id: entry.feature.meta.id,
      order: entry.feature.meta.hubOrder,
      hubTabKey: entry.feature.meta.hubTabKey || 'tab',
      isDefault: entry.feature.meta.hubDefault === true,
      t: entry.t,
      View: entry.feature.HubView,
    }))
    .sort((a, b) => a.order - b.order);

  ctx.slots.inject('settings.section', function () {
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'usage-aggregator',
        order: 92,
        // 用 thunk：宿主每次投影都重新求值，切换语言不必重新注册。
        label: function () {
          return t('tab');
        },
        locale: NS,
        inject: function () {
          return { t: t, ctx: ctx };
        },
      },
      function (slotProps) {
        return h(HubPanel, { t: t, ctx: ctx, views: views, buildAt: meta.buildAt });
      },
    );
  });
}
