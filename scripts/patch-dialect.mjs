/**
 * 补丁 YAML 的方言与解析。
 *
 * DSH 装载器用 js-yaml 的 JSON schema 加一个 `!!js` 表达式类型
 * （@deepseek-ai/dsh-app-boot 里的 JsExpr / entryListSchema）。
 * 少这一段,补丁里的 `!!js process.platform === 'win32'` 会被当成未知标签,
 * 整份补丁解析失败 —— 表现是「装上了但不出现」。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  represent: (data) => data?.__jsExpr,
});

/** 装载器同款 schema。 */
export const patchSchema = yaml.JSON_SCHEMA.extend(JsExpr);

/**
 * 用装载器同款方言解析一份补丁。
 *
 * @param {string} file 补丁文件路径。
 * @returns {{ok: true, entries: unknown[]}|{ok: false, error: string}} 解析结果。
 */
export function parsePatchFile(file) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, error: error.message };
  }
  try {
    const parsed = yaml.load(content, { schema: patchSchema });
    if (!Array.isArray(parsed)) return { ok: false, error: '顶层不是数组' };
    return { ok: true, entries: parsed };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * 取一份补丁里所有 insert 行。
 *
 * @param {unknown[]} entries 解析出来的补丁条目。
 * @returns {object[]} insert 行。
 */
export function insertRows(entries) {
  const rows = [];
  for (const patch of entries) {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) continue;
    if (!Array.isArray(patch.insert)) continue;
    for (const row of patch.insert) {
      if (typeof row === 'object' && row !== null && !Array.isArray(row)) rows.push(row);
    }
  }
  return rows;
}

/**
 * 找出解析结果里所有 `!!js` 表达式节点所在的键路径。
 *
 * 装载器只在 disabled 上认表达式;写到别处会在装载时被拒。
 *
 * @param {unknown} node 解析结果。
 * @param {string} path 当前键路径。
 * @returns {string[]} 表达式所在路径。
 */
export function findJsExpressions(node, path = '') {
  const found = [];
  if (Array.isArray(node)) {
    node.forEach((item, index) => found.push(...findJsExpressions(item, `${path}[${index}]`)));
    return found;
  }
  if (typeof node !== 'object' || node === null) return found;
  for (const [key, value] of Object.entries(node)) {
    const child = path === '' ? key : `${path}.${key}`;
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.__jsExpr === 'string') {
      found.push(child);
      continue;
    }
    found.push(...findJsExpressions(value, child));
  }
  return found;
}
