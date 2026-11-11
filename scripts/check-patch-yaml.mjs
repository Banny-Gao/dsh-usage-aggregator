#!/usr/bin/env node
/**
 * 补丁 YAML 结构自检。
 *
 * 校验的是「这两份补丁能不能被 DSH 装载器解析」——
 * 解析不过就是整个 bundle 起不来,界面上只表现为「装上了但不出现」。
 *
 * 用装载器同款方言(js-yaml + `!!js` 表达式),详见 patch-dialect.mjs。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findJsExpressions, insertRows, parsePatchFile } from './patch-dialect.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let passed = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}${detail === undefined ? '' : `（${detail}）`}`);
    return;
  }
  failures.push(`${label}${detail === undefined ? '' : `（${detail}）`}`);
  console.log(`  ✗ ${label}${detail === undefined ? '' : `（${detail}）`}`);
}

console.log('→ 补丁 YAML');

const bundlePatch = pkg.dsh?.bundle?.patch;
const patchList = typeof bundlePatch === 'string' ? [bundlePatch] : (Array.isArray(bundlePatch) ? bundlePatch : []);
check('dsh.bundle.patch 指向至少一份补丁', patchList.length > 0, patchList.join(', '));

for (const file of patchList) {
  const absolute = path.join(ROOT, file);
  const parsed = parsePatchFile(absolute);
  check(`${file} 能按 DSH 方言解析`, parsed.ok, parsed.ok ? undefined : parsed.error);
  if (!parsed.ok) continue;

  check(
    `${file} 顶层是数组且每项都是映射`,
    parsed.entries.every((patch) => typeof patch === 'object' && patch !== null && !Array.isArray(patch)),
  );

  const rows = insertRows(parsed.entries);
  check(`${file} 的 insert 行都有字面量 name`, rows.every((row) => typeof row.name === 'string'));

  const jsPaths = findJsExpressions(parsed.entries);
  check(
    `${file} 的 !!js 表达式只出现在 disabled 上`,
    jsPaths.every((path) => path.endsWith('.disabled')),
    jsPaths.filter((path) => !path.endsWith('.disabled')).join(', '),
  );
}

// 主补丁的 insert id / name 必须与 package.json 的 name 一致 ——
// 不一致的话 DSH 会按 bundle 名找插件行,找不到就是「装了但不显示」。
const mainPatch = patchList.find((file) => file === './cordis.patch.yml');
if (mainPatch !== undefined) {
  const parsed = parsePatchFile(path.join(ROOT, mainPatch));
  const rows = parsed.ok ? insertRows(parsed.entries) : [];
  check(`主补丁的 insert id 含 ${pkg.name}`, rows.some((row) => row.id === pkg.name));
  check(`主补丁的 insert name 含 ${pkg.name}`, rows.some((row) => row.name === pkg.name));
}

if (failures.length > 0) {
  console.error(`✗ 补丁 YAML 自检失败（${failures.length} 项）:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`✓ 补丁 YAML 自检通过（${passed} 项）`);
