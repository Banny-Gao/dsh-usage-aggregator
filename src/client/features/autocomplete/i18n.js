// src/client/features/autocomplete/i18n.js
//
// 「AI 自动补全」功能的文案。
//
// ⚠️ 命名空间必须与别的功能互不相同（settings.axzoTheme / usage-query /
// pluginExpander / pcBoost）—— 同一个命名空间同时只能被一个包注册，撞名会让
// 新旧插件并存时探不到自己的字典，界面上一片裸的 key。
//
// 页签标签不在这里：它归**聚合页自己**的字典（见 src/client/hub/i18n.js 与
// 本功能的 meta.hubTabKey）。

/** locale 命名空间。 */
export const NS = 'pcAutocomplete';

/** 中文（基准字典）。 */
export const zh = {
  tab: 'AI 补全',

  // 设置页
  title: 'AI 自动补全',
  intro: '在会话输入框里自动补全：打字停顿后由模型给出候选，按 Tab 采纳第一条，下拉列表里可以换其他候选。',
  sectionSuggest: '建议',
  sectionTrigger: '触发',
  sectionDisplay: '显示',
  enabled: '启用自动补全',
  enabledHint: '关掉后输入框里不再出现补全提示，也不会再调用模型。',
  maxSuggestions: '推荐条数',
  maxSuggestionsHint: '下拉列表里最多给几条（1–5）。',
  analysisModel: '分析模型',
  analysisModelHint: '分析用的模型。留空表示用插件配置里的默认模型。',
  analysisMissing: '未配置',
  analysisDefault: '默认',
  minChars: '最少字数',
  minCharsHint: '输入少于这么多个字时不触发补全（省一次模型调用）。',
  debounce: '触发延迟',
  debounceHint: '输入停顿多少毫秒后才去问模型。',
  contextMessages: '上下文条数',
  contextMessagesHint: '把最近几条对话一起给模型参考（0 = 不带，只看输入框）。',
  maxInputChars: '最长输入',
  maxInputCharsHint: '只分析输入框里的前 N 个字符。',
  allowMultiline: '多行输入也补全',
  allowMultilineHint: '关掉后，输入框里有换行时不给补全。',
  inlineHint: '行内灰字',
  inlineHintHint: '在光标后面用灰字显示待补全的片段（量不到光标位置时自动退成提示条）。',
  placeholderHint: '空输入时给提示',
  placeholderHintHint: '输入框为空时给出「你可能想问」的几条候选。',
  save: '保存设置',
  saved: '已保存',
  saveFailed: '保存失败：{error}',
  loadFailed: '读设置失败：{error}',
  foot: '补全的候选由本地模型分析产生，不会离开这台机器；插件自己不存对话内容。',

  // 输入框里的提示
  idle: 'AI 补全已开启',
  thinking: '正在想…',
  hintTab: 'Tab 补全',
  hintMore: '更多',
  dropdownTitle: 'AI 建议',
  dropdownEmpty: '暂时没有建议',
  dropdownHint: '↑↓ 选择 · Enter 采纳 · Tab 采纳当前 · Esc 关闭',
  close: '关闭建议',
  ghostLabel: '补全',
};

/** 英文。 */
export const en = {
  tab: 'AI Complete',

  title: 'AI autocomplete',
  intro: 'Autocomplete in the conversation composer: the model proposes candidates after you pause typing, Tab accepts the first one, and the dropdown offers the others.',
  sectionSuggest: 'Suggestions',
  sectionTrigger: 'Trigger',
  sectionDisplay: 'Display',
  enabled: 'Enable autocomplete',
  enabledHint: 'Off: the composer shows no completion hints and no model call is made.',
  maxSuggestions: 'Number of suggestions',
  maxSuggestionsHint: 'How many candidates the dropdown offers (1–5).',
  analysisModel: 'Analysis model',
  analysisModelHint: 'The model used for the analysis. Leave empty to use the plugin default.',
  analysisMissing: 'Not configured',
  analysisDefault: 'Default',
  minChars: 'Minimum characters',
  minCharsHint: 'Below this many characters no completion is requested (saves a model call).',
  debounce: 'Trigger delay',
  debounceHint: 'How long typing must pause before the model is asked.',
  contextMessages: 'Context messages',
  contextMessagesHint: 'How many recent conversation turns to show the model (0 = none).',
  maxInputChars: 'Maximum input',
  maxInputCharsHint: 'Only the first N characters of the draft are analyzed.',
  allowMultiline: 'Complete multi-line drafts',
  allowMultilineHint: 'Off: drafts containing a line break get no completion.',
  inlineHint: 'Inline ghost text',
  inlineHintHint: 'Show the pending fragment as grey text after the caret (falls back to the hint bar when the caret cannot be located).',
  placeholderHint: 'Suggest while empty',
  placeholderHintHint: 'Offer a few "you might ask" candidates when the composer is empty.',
  save: 'Save settings',
  saved: 'Saved',
  saveFailed: 'Save failed: {error}',
  loadFailed: 'Could not read the settings: {error}',
  foot: 'Candidates come from a local model and never leave this machine; the plugin stores no conversation content.',

  idle: 'AI completion on',
  thinking: 'Thinking…',
  hintTab: 'Tab to complete',
  hintMore: 'More',
  dropdownTitle: 'AI suggestions',
  dropdownEmpty: 'No suggestions yet',
  dropdownHint: '↑↓ to pick · Enter to accept · Tab accepts the current one · Esc closes',
  close: 'Dismiss suggestions',
  ghostLabel: 'complete',
};
