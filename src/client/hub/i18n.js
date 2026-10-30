// src/client/hub/i18n.js
//
// 聚合设置页自己的文案。
//
// 命名空间与三个功能的命名空间完全分开（settings.axzoTheme / usage-query /
// pluginExpander），**不要合并** —— 合并后 `tab` / `title` / `reset` 这类 key
// 会互相覆盖（三个字典的重叠面很大）。
//
// ⚠️ 页签标签由**聚合页自己**拥有（tabTheme / tabUsage / tabExpander），不再
//   从各功能的字典里取 `hubTab`。原因（踩过的坑）：
//   功能的 `hubTab` 原本放在功能自己的 locale 命名空间下。而同一个命名空间
//   在同一时刻只能被一个包注册 —— 新旧插件并存时（迁移期很常见），命名空间
//   归旧插件，聚合插件的功能就**探不到** `hubTab`，翻译服务把 key 本身当答案
//   返回，页签上就出现了字面量 "hubTab"。
//   页签标签本来就是聚合页的文案，归聚合页自己就没有这个耦合；
//   功能要改自己的标签，改 meta.hubTabKey 指向的 hub 键即可。

/** 聚合页的 locale 命名空间。 */
export const NS = 'dsh-usage-aggregator';

export const zh = {
  // 设置面板左侧导航里的入口名。
  tab: 'AxzoAggregator',
  // 三个页签的标签。键名 = 功能 meta.hubTabKey。
  tabTheme: 'Theme',
  tabUsage: '流量',
  tabExpander: '插件更新',
  hint: '三个功能在同一个插件里。左侧切换，下方是当前功能的设置。',
  empty: '没有可用的功能。',
  buildAt: '客户端构建于 {at}',
};

export const en = {
  tab: 'AxzoAggregator',
  tabTheme: 'Theme',
  tabUsage: 'Traffic',
  tabExpander: 'Plugin Updates',
  hint: 'Three capabilities in one plugin. Switch below to configure each one.',
  empty: 'No capability available.',
  buildAt: 'Client built at {at}',
};
