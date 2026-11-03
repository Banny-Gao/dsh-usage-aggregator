// src/host/features/autocomplete/settings.js
//
// 自动补全的设置：默认值 + 归一化。
//
// 为什么单独一个文件：设置有三层来源（插件配置 → 落盘的用户偏好 → 运行时请求），
// 每一层都要按同一套边界夹一次。规则写在这里，纯函数、可单测，别处只调用它。

/**
 * 设置的默认值。
 *
 * 阈值取保守值：补全每停顿一次就要花一次模型调用，宁可少触发也不要打扰用户。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  // 总开关。默认开，但阈值保守（见下面 minChars / debounceMs）。
  enabled: true,
  // 推荐条数：下拉列表里给几条。
  maxSuggestions: 3,
  // 分析模型。空串 = 用 cordis.patch.yml 里 autocomplete.analysis 的默认值。
  provider: '',
  model: '',
  // 少于这么多字不触发（避免刚敲一个字就去问模型）。
  minChars: 2,
  // 输入停顿多久才去请求（毫秒）。
  debounceMs: 500,
  // 带入最近几条对话上下文（0 = 不带，只看草稿）。
  contextMessages: 4,
  // 只分析草稿的前 N 个字符（更长的草稿截断，省 token）。
  maxInputChars: 2000,
  // 草稿含换行时是否也补全（关掉就只在单行时补全）。
  allowMultiline: true,
  // 行内幽灵文本：光标后跟一段灰字。
  inlineHint: true,
  // 空输入时的占位提示（草稿为空时给几条「你可能想问」）。
  placeholderHint: true,
});

/** 各字段的边界：min / max / 枚举。 */
const BOUNDS = {
  maxSuggestions: { min: 1, max: 5 },
  minChars: { min: 0, max: 200 },
  debounceMs: { min: 0, max: 5000 },
  contextMessages: { min: 0, max: 10 },
  maxInputChars: { min: 100, max: 20000 },
};

/**
 * 把一个值夹进整数区间。
 *
 * @param {unknown} value 原始值。
 * @param {number} min 下界。
 * @param {number} max 上界。
 * @param {number} fallback 兜底值。
 * @returns {number} 合法整数。
 */
export function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * 归一化设置。
 *
 * 每一项都按边界夹一次：配置里写错了一个数（比如 maxSuggestions: 99）不能让
 * 面板炸掉，也不能让模型一次被要求返回 99 条建议。
 *
 * @param {unknown} raw 原始设置。
 * @param {object} defaults 兜底默认值（通常是 DEFAULT_SETTINGS）。
 * @returns {object} 合法设置。
 */
export function normalizeSettings(raw, defaults = DEFAULT_SETTINGS) {
  const base = defaults !== null && typeof defaults === 'object' ? defaults : DEFAULT_SETTINGS;
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const settings = {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : base.enabled === true,
    provider: typeof source.provider === 'string' ? source.provider.trim() : (typeof base.provider === 'string' ? base.provider : ''),
    model: typeof source.model === 'string' ? source.model.trim() : (typeof base.model === 'string' ? base.model : ''),
    allowMultiline: typeof source.allowMultiline === 'boolean' ? source.allowMultiline : base.allowMultiline !== false,
    inlineHint: typeof source.inlineHint === 'boolean' ? source.inlineHint : base.inlineHint !== false,
    placeholderHint: typeof source.placeholderHint === 'boolean' ? source.placeholderHint : base.placeholderHint !== false,
  };
  for (const [key, bound] of Object.entries(BOUNDS)) {
    settings[key] = clampInt(source[key], bound.min, bound.max, base[key]);
  }
  return settings;
}

/**
 * 把插件配置（cordis.patch.yml）里的一段读成设置。
 *
 * 配置段长这样：
 *   autocomplete:
 *     analysis: { provider, model, maxOutputTokens }
 *     defaults: { maxSuggestions: 3, ... }
 *
 * @param {object} featureConfig config.autocomplete 那一段。
 * @returns {object} 默认设置（用户偏好会覆盖它）。
 */
export function defaultsFromConfig(featureConfig) {
  const config = featureConfig !== null && typeof featureConfig === 'object' ? featureConfig : {};
  const analysis = config.analysis !== null && typeof config.analysis === 'object' ? config.analysis : {};
  const defaults = config.defaults !== null && typeof config.defaults === 'object' ? config.defaults : {};
  return normalizeSettings({
    ...defaults,
    provider: typeof analysis.provider === 'string' ? analysis.provider : '',
    model: typeof analysis.model === 'string' ? analysis.model : '',
  });
}
