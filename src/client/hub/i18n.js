// src/client/hub/i18n.js
//
// 聚合设置页自己的文案。
//
// 命名空间与三个功能的命名空间完全分开（settings.axzoTheme / usage-query /
// pluginExpander），**不要合并** —— 合并后 `tab` / `title` / `reset` 这类 key
// 会互相覆盖（三个字典的重叠面很大）。
//
// 各功能在聚合页里的标签文案放在它们自己字典的 `hubTab` 键上，
// 这样切换语言时标签跟着各自命名空间一起变。

/** 聚合页的 locale 命名空间。 */
export const NS = 'dsh-usage-aggregator';

export const zh = {
  tab: '用量聚合',
  hint: '三个功能在同一个插件里。左侧切换，下方是当前功能的设置。',
  empty: '没有可用的功能。',
  buildAt: '客户端构建于 {at}',
};

export const en = {
  tab: 'Usage Aggregator',
  hint: 'Three capabilities in one plugin. Switch below to configure each one.',
  empty: 'No capability available.',
  buildAt: 'Client built at {at}',
};
