// src/host/features/usage/paths.js
//
// 模板里的取数路径。
//
// 只支持「点 + 下标」这一种语法（`$.data.list[0].name`、`data.list[0].name`）——
// 刻意不支持表达式、通配与函数：模板是模型给的**数据**，能求值的模板等于让模型
// 往渲染链路里塞代码。拿不到的路径返回 undefined，由调用方决定是忽略还是提示。

/**
 * 按路径从 JSON 里取值。
 *
 * @param {unknown} data JSON 数据。
 * @param {string} path 形如 `$.a.b[0].c` / `a.b[0].c` 的路径。
 * @returns {unknown} 取不到时返回 undefined。
 */
export function getPath(data, path) {
  if (data === null || data === undefined) return undefined;
  if (typeof path !== 'string' || path.trim() === '') return undefined;
  const segments = splitPath(path);
  let current = data;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * 把路径切成段：字符串键与数字下标。
 *
 * @param {string} path 路径文本。
 * @returns {(string|number)[]} 段列表。
 */
export function splitPath(path) {
  const clean = path.trim().replace(/^\$/, '').replace(/^\./, '');
  const segments = [];
  let buffer = '';
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch === '.') {
      if (buffer !== '') {
        segments.push(buffer);
        buffer = '';
      }
      continue;
    }
    if (ch === '[') {
      if (buffer !== '') {
        segments.push(buffer);
        buffer = '';
      }
      const close = clean.indexOf(']', i);
      if (close === -1) {
        buffer += ch;
        continue;
      }
      const inner = clean.slice(i + 1, close).replace(/['"]/g, '').trim();
      if (/^-?\d+$/.test(inner)) segments.push(Number(inner));
      else if (inner !== '') segments.push(inner);
      i = close;
      continue;
    }
    buffer += ch;
  }
  if (buffer !== '') segments.push(buffer);
  return segments;
}

/** 列出 JSON 里所有可展示的路径（给「字段」下拉与调试用，深度受限）。 */
export function listPaths(data, options = {}) {
  const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : 4;
  const maxItems = typeof options.maxItems === 'number' ? options.maxItems : 200;
  const out = [];
  const walk = (node, prefix, depth) => {
    if (out.length >= maxItems || depth > maxDepth) return;
    if (Array.isArray(node)) {
      if (node.length > 0) walk(node[0], `${prefix}[0]`, depth + 1);
      return;
    }
    if (node === null || typeof node !== 'object') {
      out.push(prefix);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const next = prefix === '' ? key : `${prefix}.${key}`;
      if (value !== null && typeof value === 'object') walk(value, next, depth + 1);
      else out.push(next);
      if (out.length >= maxItems) return;
    }
  };
  walk(data, '', 0);
  return out;
}
