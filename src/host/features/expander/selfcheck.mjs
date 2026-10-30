// src/host/features/expander/selfcheck.mjs
//
// 离线自检：不开浏览器、不连网络，把「零能力丢失」与「自我保护」两条都断言一遍。
//
//   node src/host/features/expander/selfcheck.mjs
//
// 覆盖：
//   · registry.js  —— 版本比较（semver 子集）与依赖 spec 解析；
//   · lockfile.js  —— importers 段的缩进规则与 40 位提交提取；
//   · proc.js      —— 「永不抛异常」约定；
//   · ops.js       —— 清单枚举的过滤、自我保护的三条规则、串行更新；
//   · tool.js      —— 工具名 / schema / isConcurrencySafe；
//   · server.js    —— 两条路由的路径与方法；
//   · fixtures/state.json —— 真实响应夹具的形状（按新的过滤逻辑同步过）。

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { compareVersions, isUpgrade, parseDependencySource } from './registry.js';
import { parseLockedCommits, parseLockedVersions } from './lockfile.js';
import { runCommand } from './proc.js';
import { createOps, RETIRED_PACKAGES, SELF_PACKAGE } from './ops.js';
import { createRouteSpecs } from './server.js';
import { createUpdaterTool } from './tool.js';

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures = [];

/**
 * 断言一个条件成立。
 *
 * @param {boolean} condition 条件。
 * @param {string} label 断言的名字（失败时打印）。
 */
function check(condition, label) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(label);
}

/* ─────────────────────────── registry.js ─────────────────────────── */

check(compareVersions('1.2.3', '1.2.3') === 0, '同版本相等');
check(compareVersions('1.3.0', '1.2.9') > 0, '次版本更大');
check(compareVersions('2.0.0', '1.9.9') > 0, '主版本更大');
check(compareVersions('1.0.0', '1.0.0-rc.1') > 0, '正式版比预发布新');
check(compareVersions('1.0.0-rc.2', '1.0.0-rc.1') > 0, 'rc.2 比 rc.1 新');
check(compareVersions('1.0.0-rc.1', '1.0.0-beta.1') > 0, 'rc 比 beta 新');
check(compareVersions('1.0.0-alpha', '1.0.0-1') > 0, '字母标识符比数字标识符大');
check(compareVersions('v1.2.3', '1.2.3') === 0, 'v 前缀被忽略');
check(compareVersions('1.2', '1.2.0') === null, '非 semver 返回 null（比不了）');
check(isUpgrade('1.0.0', '1.0.1') === true, 'isUpgrade：远端更新');
check(isUpgrade('1.0.0', '1.0.0') === false, 'isUpgrade：同版本不更新');
check(isUpgrade('1.0.1', '1.0.0') === false, 'isUpgrade：本地更新不降级');

check(parseDependencySource('dsh-token-use@^0.3.3').kind === 'npm', 'npm spec');
check(parseDependencySource('dsh-token-use@^0.3.3').range === '^0.3.3', 'npm spec 的 range');
check(parseDependencySource('@scope/pkg@^1.0.0').name === '@scope/pkg', '作用域包名按最后一个 @ 拆');
check(parseDependencySource('link:/abs/path').kind === 'local', 'link: 是本地包');
check(parseDependencySource('file:/abs/path').kind === 'local', 'file: 是本地包');
check(parseDependencySource('name@npm:real').kind === 'alias', '别名被识别');
check(parseDependencySource('name@npm:real').target === 'real', '别名的目标包名');
// 原实现的语义：包名与范围之间按**最后一个** @ 拆，所以别名带版本范围时
// 会被当成普通 npm spec。这条断言钉住原行为，别在迁移里悄悄改掉。
check(parseDependencySource('name@npm:real@^1').kind === 'npm', '别名带版本范围时按最后一个 @ 拆（保持原实现语义）');
check(parseDependencySource('git+https://host/repo.git#path:sub').kind === 'git', 'git spec');
check(parseDependencySource('git+https://host/repo.git#path:sub').path === 'sub', 'git spec 的 path');
check(parseDependencySource(`git+https://host/repo.git#${'a'.repeat(40)}`).pinned === 'a'.repeat(40), '40 位提交算 pinned');
check(parseDependencySource('git+https://host/repo.git#main').pinned === null, '分支不算 pinned');

/* ─────────────────────────── lockfile.js ─────────────────────────── */

const commit = 'bf31095' + 'a'.repeat(33);
const lockText = [
  'importers:',
  '  .:',
  '    dependencies:',
  '      dsh-ai-coding:',
  '        specifier: git+https://host/repo.git#path:packages/x',
  `        version: git+https://host/repo.git#${commit}&path:packages/x`,
  "      '@sunjuntao/dsh-prompt-library':",
  '        specifier: ^0.17.2',
  '        version: 0.17.2',
].join('\n');

const locked = parseLockedVersions(lockText);
check(locked.get('dsh-ai-coding') !== undefined, '锁文件解析出 git 依赖');
check(locked.get('@sunjuntao/dsh-prompt-library') === '0.17.2', '锁文件解析出去引号的作用域包名');
const commits = parseLockedCommits(lockText);
check(commits.get('dsh-ai-coding') === commit, '锁文件解析出 40 位提交');
check(commits.has('@sunjuntao/dsh-prompt-library') === false, '普通版本不是提交号');

/* ─────────────────────────── proc.js ─────────────────────────── */

const missing = await runCommand('dsh-selfcheck-no-such-binary-xyz', ['--version'], { timeoutMs: 2000 });
check(typeof missing.code === 'number', 'proc：找不到可执行文件也不抛异常');
check(missing.timedOut === false, 'proc：超时标记是布尔值');

/* ─────────────────────────── ops.js ─────────────────────────── */

/** 造一份假的已装清单。 */
const bundles = [
  { name: 'dsh-token-use', version: '0.3.4', enabled: true, installed: true, availability: 'profile', source: 'dsh-token-use@0.3.4' },
  { name: 'dsh-usage-query', version: '0.2.0', enabled: true, installed: true, availability: 'profile', source: 'link:/tmp/dsh-usage-query' },
  { name: 'dsh-axzo-theme', version: '0.1.13', enabled: true, installed: true, availability: 'profile', source: 'git+https://host/theme.git' },
  { name: 'dsh-plugin-expander', version: '0.3.0', enabled: true, installed: true, availability: 'profile', source: 'link:/tmp/dsh-plugin-expander' },
  { name: 'dsh-usage-aggregator', version: '0.1.0', enabled: true, installed: true, availability: 'profile', source: 'dsh-usage-aggregator@0.1.0' },
  { name: 'dsh-bundled', version: '1.0.0', enabled: true, installed: true, availability: 'bundled', source: 'dsh-bundled@1.0.0' },
];

const removed = [];
const installed = [];

/** 假的官方插件管理器。 */
const manager = {
  async listBundles() {
    return bundles;
  },
  async registries() {
    return { registry: null, fallbackRegistries: [] };
  },
  async removeBundle(name) {
    removed.push(name);
    return { application: 'applied' };
  },
  async installBundle(spec, options) {
    installed.push({ spec, options });
    return { application: 'applied' };
  },
};

/** 假的外部命令：只回答一个包名。 */
async function fakeRun(command, args) {
  const view = args.indexOf('view');
  const name = view >= 0 ? args[view + 1] : '';
  const versions = {
    'dsh-token-use': '0.3.5',
    'dsh-usage-aggregator': '99.0.0',
  };
  if (versions[name] === undefined) return { code: 1, stdout: '', stderr: '', timedOut: false };
  return { code: 0, stdout: JSON.stringify({ name, version: versions[name] }), stderr: '', timedOut: false };
}

const ops = createOps({
  getManager: () => manager,
  getProfileDir: () => '/tmp/dsh-selfcheck-profile',
  getPnpm: () => ({ command: 'pnpm', args: [] }),
  run: fakeRun,
});

const state = await ops.state({ refresh: true });
const names = state.packages.map((item) => item.name);

check(state.ok === true, 'ops：state 返回 ok');
check(names.includes('dsh-token-use'), 'ops：普通 profile 插件在清单里');
check(names.includes(SELF_PACKAGE), 'ops：自己仍然在清单里（可见）');
check(names.includes('dsh-bundled') === false, 'ops：非 profile 插件不在清单里');
for (const retired of RETIRED_PACKAGES) {
  check(names.includes(retired) === false, `ops：退役包 ${retired} 不在清单里`);
}
check(state.packages.length === 2, 'ops：清单只剩 2 条');

const self = state.packages.find((item) => item.name === SELF_PACKAGE);
check(self.updatable === false, 'ops：自己不可更新');
check(typeof self.description === 'string' && self.description.includes('正在运行的插件自己'), 'ops：自己的描述里说明了原因');
check(self.status === 'update-available', 'ops：自己的状态仍如实反映注册表（99.0.0 比 0.1.0 新）');

const updatable = await ops.updatableNames();
check(updatable.includes('dsh-token-use'), 'ops：可更新列表里有普通插件');
check(updatable.includes(SELF_PACKAGE) === false, 'ops：可更新列表排除自己');

const selfUpdate = await ops.updateNow([SELF_PACKAGE]);
check(selfUpdate.length === 1, 'ops：updateNow 对自己返回一条结果');
check(selfUpdate[0].ok === false, 'ops：更新自己失败');
check(selfUpdate[0].stage === 'check', 'ops：更新自己停在 check 阶段');
check(selfUpdate[0].error === '不能更新正在运行的插件自己', 'ops：更新自己的错误文案');
check(removed.length === 0 && installed.length === 0, 'ops：更新自己没有真的动插件管理器');

const retiredUpdate = await ops.updateNow(['dsh-plugin-expander']);
check(retiredUpdate[0].ok === false, 'ops：更新退役包失败（不会把它复活）');
check(removed.length === 0 && installed.length === 0, 'ops：更新退役包没有真的动插件管理器');

const normal = await ops.updateNow(['dsh-token-use']);
check(normal[0].ok === true, 'ops：普通插件更新成功');
check(removed[0] === 'dsh-token-use', 'ops：普通插件先卸载');
check(installed[0].spec === 'dsh-token-use@0.3.5', 'ops：npm 包用 name@latest 重装');
check(installed[0].options.enabled === true, 'ops：重装时保持原来的启用状态');

/* ─────────────────────────── tool.js ─────────────────────────── */

const tool = createUpdaterTool(ops, { assertPrivileged: () => {} });
check(tool.name === 'plugin_update', 'tool：名字没变');
check(tool.isConcurrencySafe() === false, 'tool：isConcurrencySafe 为 false');
check(Array.isArray(tool.parameters.properties.action.enum) && tool.parameters.properties.action.enum.join(',') === 'check,update', 'tool：action 枚举没变');
check(tool.parameters.required.join(',') === 'action', 'tool：必填参数没变');
check(typeof tool.output.render === 'function', 'tool：输出渲染函数还在');

let gate = null;
const gated = createUpdaterTool(ops, {
  assertPrivileged: () => {
    gate = 'called';
  },
});
await gated.execute({ action: 'update', names: ['dsh-token-use'] }, {});
check(gate === 'called', 'tool：update 之前会走权限闸门');

/* ─────────────────────────── server.js ─────────────────────────── */

const specs = createRouteSpecs(ops, '/dsh-usage-aggregator/expander');
const get = specs.filter((spec) => spec.method === 'GET');
const post = specs.filter((spec) => spec.method === 'POST');
check(get.length >= 1, 'server：有 GET 路由');
check(post.length === 1 && post[0].path === '/dsh-usage-aggregator/expander/update', 'server：POST /update');
check(get.some((spec) => spec.path === '/dsh-usage-aggregator/expander'), 'server：GET 在功能前缀上');
check(get.some((spec) => spec.path === '/dsh-usage-aggregator/expander/state'), 'server：GET 兼容别名 /state');

/* ─────────────────────── fixtures/state.json ─────────────────────── */

const fixture = JSON.parse(await readFile(join(here, 'fixtures', 'state.json'), 'utf8'));
check(fixture.ok === true, '夹具：ok 为 true');
check(Array.isArray(fixture.packages), '夹具：packages 是数组');
check(typeof fixture.summary === 'object' && fixture.summary !== null, '夹具：有 summary');
check(typeof fixture.job === 'object' && fixture.job !== null, '夹具：有 job');
check(fixture.packages.every((item) => typeof item.name === 'string' && typeof item.updatable === 'boolean'), '夹具：每条都有 name 与 updatable');

// 夹具是迁移前抓的真机响应，里面还留着三个退役包 —— 新的过滤逻辑会把它们剔掉。
// 这条断言就是「夹具与新逻辑同步」的地方：夹具里的退役包必须正好是 RETIRED_PACKAGES。
const fixtureRetired = fixture.packages.map((item) => item.name).filter((name) => RETIRED_PACKAGES.has(name));
check(fixtureRetired.length === 3, '夹具：正好含 3 个退役包条目');
check(fixtureRetired.includes('dsh-plugin-expander'), '夹具：含旧的 dsh-plugin-expander 条目');
check(fixture.packages.some((item) => item.name === SELF_PACKAGE) === false, '夹具：抓的时候聚合包还没装上');

/* ─────────────────────────── 结果 ─────────────────────────── */

if (failures.length > 0) {
  console.error(`✗ 自检失败 ${String(failures.length)} 项：`);
  for (const label of failures) console.error(`  · ${label}`);
  process.exit(1);
}
console.log(`✓ 自检通过 ${String(passed)} 项`);
