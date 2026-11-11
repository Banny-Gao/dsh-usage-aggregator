#!/usr/bin/env node
/**
 * 硬指标预设自检。
 *
 * 校验的是「预设能不能被 DSH 挂上」这件事：
 * 补丁的结构、插件名能不能解析、persona 与仓库里的手册是否同一份。
 *
 * 断一环的表现都是「装上了但不出现」——界面上看不出来，只能在这里拦。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { insertRows, parsePatchFile } from './patch-dialect.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATCH_FILE = path.join(ROOT, 'presets/hard-metrics.patch.yml');
const GUARD_FILE = path.join(ROOT, 'presets/hard-metrics-guard.js');
const AGENTS_FILE = path.join(ROOT, 'AGENTS.md');
const PKG_FILE = path.join(ROOT, 'package.json');

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

/**
 * 递归收集一行插件里的插件名。
 *
 * 组(cordis:group)把子插件放在自己的 config 数组里,得往下走一层。
 *
 * @param {unknown[]} rows 插件行。
 * @returns {string[]} 插件名。
 */
function collectNames(rows) {
  const names = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
    if (typeof row.name === 'string') names.push(row.name);
    if (Array.isArray(row.config)) names.push(...collectNames(row.config));
  }
  return names;
}

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

console.log('→ 硬指标预设');

// ---------------------------------------------------------------- 基础接线

check('预设补丁存在', fs.existsSync(PATCH_FILE));
check('守卫文件存在', fs.existsSync(GUARD_FILE));

const bundlePatch = pkg.dsh?.bundle?.patch;
const patchList = typeof bundlePatch === 'string' ? [bundlePatch] : (Array.isArray(bundlePatch) ? bundlePatch : []);
check(
  'dsh.bundle.patch 是补丁列表且含预设补丁',
  patchList.includes('./presets/hard-metrics.patch.yml'),
  patchList.join(', '),
);
check(
  'dsh.bundle.patch 里每份补丁都在磁盘上',
  patchList.length > 0 && patchList.every((file) => fs.existsSync(path.join(ROOT, file))),
);
check('exports 暴露 ./preset-guard', pkg.exports?.['./preset-guard'] === './presets/hard-metrics-guard.js');
check('files 覆盖 presets', Array.isArray(pkg.files) && pkg.files.includes('presets'));

// ---------------------------------------------------------------- 补丁结构

// 补丁本身能不能被装载器解析由 check-patch-yaml.mjs 管;
// 这里只关心解析之后的**预设内容**。
const parsed = parsePatchFile(PATCH_FILE);
check('预设补丁能按 DSH 方言解析', parsed.ok, parsed.ok ? undefined : parsed.error);

const rows = parsed.ok ? insertRows(parsed.entries) : [];

const presetRow = rows.find((row) => row.id === 'preset-hard-metrics');
check('补丁声明 preset-hard-metrics', presetRow !== undefined);
check('预设由 @deepseek-ai/dsh-agent-preset 承载', presetRow?.name === '@deepseek-ai/dsh-agent-preset', presetRow?.name);
check('config.id 是 hard-metrics', presetRow?.config?.id === 'hard-metrics', presetRow?.config?.id);
check('config.order 是 5', presetRow?.config?.order === 5, presetRow?.config?.order);

const pluginRows = Array.isArray(presetRow?.config?.plugins) ? presetRow.config.plugins : [];
const pluginNames = collectNames(pluginRows);

const personaRow = pluginRows.find((row) => row?.id === 'persona');
const personaPrefix = typeof personaRow?.config?.prefix === 'string' ? personaRow.config.prefix : null;

check('persona 载荷存在', personaPrefix !== null);
check('插件清单非空', pluginNames.length > 0, `${pluginNames.length} 个`);

// ---------------------------------------------------------------- 插件名可解析

// 官方包的子路径是**对外契约**：只有写在这里的两个子路径真的在包的 exports 映射里。
// 写别的子路径（例如 dsh-tool-subagent-control/list-agents）装载时该行直接失败，
// 而一行失败就是整个预设 mount 失败 —— 表现为「装上了但不出现」。
const OFFICIAL_SUBPATHS = new Set([
  '@deepseek-ai/dsh-plugin-manager/tools',
  '@deepseek-ai/dsh-plugin-market/tools',
]);

const ownPackage = pkg.name;
const officialNames = pluginNames.filter((name) => name.startsWith('@deepseek-ai/'));
const ownNames = pluginNames.filter((name) => name === `${ownPackage}/preset-guard`);
const foreignSubpaths = pluginNames.filter(
  (name) => !name.startsWith('@deepseek-ai/') && !name.startsWith(`${ownPackage}/`) && name.includes('/'),
);
// 作用域包名里本来就有一个斜杠，子路径要看**第二个**斜杠之后还有没有内容。
const unexpectedSubpaths = officialNames.filter((name) => {
  const rest = name.slice(name.indexOf('/') + 1);
  return rest.includes('/') && !OFFICIAL_SUBPATHS.has(name);
});
check('官方包引用只用包根或已知的 exports 子路径', unexpectedSubpaths.length === 0 && foreignSubpaths.length === 0, unexpectedSubpaths.concat(foreignSubpaths).join(', '));
check('守卫行按裸包名 + exports 子路径引用', ownNames.length === 1, ownNames.join(', '));
check('插件名不含 file: 或绝对路径', pluginNames.every((name) => !name.startsWith('file:') && !name.startsWith('/')));

// 能解析就当场解析一遍：把「名字写得对但实际装不上」这类问题挡在这里。
const requireFromRoot = createRequire(path.join(ROOT, 'probe.cjs'));
// 「宿主有没有提供作用域」只能拿**官方包**当判据：本包自己的名字走 Node 的
// self-reference（package.json 的 name + exports），在哪台机器上都能解析，
// 拿它当判据会把「宿主没装」误判成「宿主装了」，于是缺作用域的机器上直接判失败。
let scopeDetected = false;
const unresolvable = [];
for (const name of officialNames) {
  try {
    requireFromRoot.resolve(name);
    scopeDetected = true;
  } catch {
    unresolvable.push(name);
  }
}
let ownResolvable = true;
try {
  requireFromRoot.resolve(`${ownPackage}/preset-guard`);
} catch {
  ownResolvable = false;
}
if (scopeDetected) {
  check('插件名在宿主作用域里都能解析', unresolvable.length === 0 && ownResolvable, unresolvable.join(', '));
} else {
  console.log('  – 宿主未提供 @deepseek-ai 作用域，跳过插件名解析探测（结构校验仍生效）');
}

// ---------------------------------------------------------------- persona 与手册同一份

check('仓库里有 AGENTS.md 手册', fs.existsSync(AGENTS_FILE));
if (personaPrefix !== null && fs.existsSync(AGENTS_FILE)) {
  const manual = fs.readFileSync(AGENTS_FILE, 'utf8').replace(/\n+$/, '');
  // persona 载荷比手册多一句模型引导语，其余必须逐字相同。
  const guidance = 'You are a coding agent powered by the {{model}} model.';
  // YAML 块标量保留结尾换行,手册读进来也统一去掉尾部空行再比。
  const withoutGuidance = (personaPrefix.startsWith(guidance)
    ? personaPrefix.slice(guidance.length).replace(/^\n+/, '')
    : personaPrefix).replace(/\n+$/, '');
  check('persona 载荷与 AGENTS.md 手册逐字一致', withoutGuidance === manual);
  for (const heading of ['## 编码准则', '## 论断准则', '## 工作流', '## 硬禁令', '## 交付前自检', '## 代码约定']) {
    check(`persona 含「${heading}」`, withoutGuidance.includes(heading));
  }
  check('persona 写明「绝对禁止执行 git checkout --」', withoutGuidance.includes('绝对禁止执行 git checkout --'));
}

// ---------------------------------------------------------------- 守卫导出

const guard = await import(path.join(ROOT, 'presets/hard-metrics-guard.js'));
check('守卫导出 name', typeof guard.name === 'string' && guard.name.length > 0, guard.name);
check('守卫导出 inject', Array.isArray(guard.inject) && guard.inject.includes('tools'), JSON.stringify(guard.inject));
check('守卫导出 apply', typeof guard.apply === 'function');

if (failures.length > 0) {
  console.error(`✗ 硬指标预设自检失败（${failures.length} 项）:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`✓ 硬指标预设自检通过（${passed} 项）`);
