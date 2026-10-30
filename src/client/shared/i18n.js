// src/client/shared/i18n.js
//
// 共用的 translator 工厂。
//
// 三个功能各自有**独立**的 locale 命名空间（settings.axzoTheme / usage-query /
// pluginExpander），字典也各自独立 —— 不要把三份字典合并进同一个命名空间，
// `tab` / `title` / `reset` 这类 key 会互相覆盖。
//
// 本文件只提供「怎么从一个命名空间取文案」这一层，取谁的字典由各功能自己决定。

/**
 * 把 {name} 这样的占位符替换掉。
 *
 * @param {string} text 原文。
 * @param {Record<string, unknown> | undefined} vars 变量表。
 * @returns {string} 替换后的文本。
 */
export function interpolate(text, vars) {
  if (vars === undefined || vars === null) return text;
  return String(text).replace(/\{(\w+)\}/g, function (match, name) {
    return vars[name] === undefined ? match : String(vars[name]);
  });
}

/**
 * 取 translator，保证**永远返回非空字符串**。
 *
 * 面板里多处直接拼字符串 / .replace()，t() 返回 undefined 会让整个面板崩掉。
 *
 * @param {object} locale ctx.locale 服务。
 * @param {string} namespace 字典所在的命名空间。
 * @param {Record<string, string>} fallback 回退字典（通常是 zh）。
 * @returns {(key: string, vars?: Record<string, unknown>) => string} translator。
 */
export function makeTranslator(locale, namespace, fallback) {
  const dict = fallback || {};
  try {
    const bound = locale.bind(namespace);
    const probe = bound('tab');
    if (typeof probe === 'string' && probe.length > 0) {
      return function (key, vars) {
        const value = bound(key);
        const text = typeof value === 'string' && value.length > 0
          ? value
          : (dict[key] !== undefined ? dict[key] : key);
        return interpolate(text, vars);
      };
    }
  } catch (err) {
    // 命名空间还没注册（locale 服务晚一步到位）时落到兜底字典。
  }
  return function (key, vars) {
    return interpolate(dict[key] !== undefined ? dict[key] : key, vars);
  };
}
