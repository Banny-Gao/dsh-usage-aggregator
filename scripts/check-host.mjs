#!/usr/bin/env node
/**
 * scripts/check-host.mjs
 *
 * 离线校验 **Host 半边**（src/host/index.js）能被真实 cordis 装载。
 *
 * 为什么需要它
 * ------------
 * Host 半边的两个导出直接决定「这一行会不会挂」：
 *   · `export const name` + `export function apply` —— 少任何一个，cordis 的
 *     unwrapExports() 就会拿到一个 Module Namespace（既不是函数也没有 apply），
 *     registry.resolve() 返回 undefined，registry.plugin() 抛
 *     "invalid plugin, expect function or object with an \"apply\" method,
 *     received object" —— 整页 Failed to load plugins。
 *   · `export const inject` —— 写进去的每个服务名都必须是**必然存在**的。
 *     多写一个不存在的服务，entry 会永远 pending（等那个永远不会来的服务），
 *     表现同样是整页 Failed to load plugins。
 *
 * 复刻 cordis-plugin-loader 的两步
 * --------------------------------
 *   1. `unwrapExports()` —— ESM 模块只认 default / __esModule：
 *        exports = exports.default ?? exports
 *        if (!exports.__esModule) return exports
 *        return exports.default ?? exports
 *   2. `ctx.registry.plugin(plugin, config)` —— 校验 plugin 形状 + 解析 inject。
 *
 * 用法：node scripts/check-host.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/* ─────────────────────────── 常量 ─────────────────────────── */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = join(ROOT, 'package.json');
const HOST_ENTRY = join(ROOT, 'src', 'host', 'index.js');
const PATCH_PATH = join(ROOT, 'cordis.patch.yml');

/**
 * 期望的插件 id。
 *
 * 为什么硬编码在这里而不是只读 package.json：package.json 的 name 是**被检查
 * 的对象**之一，如果只拿它跟自己比，name 写错了也检查不出来。所以这里写死一份
 * 「这个名字必须叫 dsh-usage-aggregator」作为基准。
 */
const EXPECTED_NAME = 'dsh-usage-aggregator';

/**
 * 期望的 Host 硬 inject。
 *
 * 为什么必须**恰好**是 ['tools']：
 *   · 'tools' 必然存在（Agent 工具注册要用它）；
 *   · webServer / llm / attachments / pluginManager / profileContext 都是
 *     「有则更好」，走 ctx.inject([...], cb) 的可选注入 —— 写进硬 inject 会让
 *     entry 永远 pending。
 */
const EXPECTED_INJECT = ['tools'];

/** 期望注册出来的 Agent 工具名。改名会打断已有会话里的工具调用。 */
const EXPECTED_TOOLS = ['usage_query', 'plugin_update'];

/**
 * 一份覆盖全部功能的 config。
 *
 * 为什么要「覆盖全部功能」：装配层会读 config.usage / config.expander 两段，
 * 少给一段就可能走不到那段代码，语法错 / 拼写错就漏过去了。这份 config 与
 * cordis.patch.yml 里的那段一一对应（下面另有断言检查 patch 文件里那几个键还在）。
 */
const FULL_CONFIG = {
  endpoint: '/dsh-usage-aggregator',
  allowRemote: false,
  usage: {
    analysis: {
      provider: 'axzo-one',
      model: 'auto/deepseek-flash',
      maxOutputTokens: 8000,
      allowImage: true,
    },
    autoRefresh: { enabled: true, intervalSeconds: 300 },
    renewal: { enabled: true, leadSeconds: 1800, cooldownSeconds: 1800 },
    request: { timeoutMs: 30000 },
  },
  expander: {
    checkTimeoutMs: 20000,
    gitTimeoutMs: 15000,
  },
};

const failures = [];
const notes = [];

function ok(label) { console.log('  ✓ ' + label); }
function bad(label) { failures.push(label); console.log('  ✗ ' + label); }
function note(label) { notes.push(label); console.log('  – ' + label); }

/* ─────────────────────── 找一份真实的 cordis ─────────────────────── */

/** 本机 pnpm store 里 @deepseek-ai 的链接根目录。 */
function storeRoots() {
  const home = homedir();
  return [
    join(home, 'Library/pnpm/store/v11/links/@deepseek-ai'),
    join(home, '.pnpm-store/v3/links/@deepseek-ai'),
  ];
}

/**
 * 找 @deepseek-ai/cordis 的入口文件。
 *
 * 先看本仓库的 node_modules（pnpm install 之后就有），再看本机 pnpm store ——
 * 后者保证「没在本仓库装依赖也能跑」。
 *
 * @returns {{file: string, from: string} | null} 入口路径与来源。
 */
function findCordis() {
  const local = join(ROOT, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js');
  if (existsSync(local)) return { file: local, from: '本仓库 node_modules' };

  for (const root of storeRoots()) {
    const base = join(root, 'cordis');
    if (!existsSync(base)) continue;
    for (const version of readdirSync(base).sort().reverse()) {
      const vdir = join(base, version);
      if (!statSync(vdir).isDirectory()) continue;
      for (const hash of readdirSync(vdir)) {
        const p = join(vdir, hash, 'node_modules/@deepseek-ai/cordis/lib/index.js');
        if (existsSync(p)) return { file: p, from: `pnpm store（cordis ${version}）` };
      }
    }
  }
  return null;
}

/**
 * 找「提供某个服务」的 DSH 包。
 *
 * 为什么要现找：inject 里写的服务名必须真实存在。'tools' 由
 * @deepseek-ai/dsh-tools 提供（class ToolsService extends Service，
 * 构造时 super(ctx, 'tools')）。DSH 的服务不来自 cordis 核心里，所以只能去
 * store 里把提供方找出来 —— 找不到就说明 inject 写了一个不存在的服务。
 *
 * @param {string} service 服务名。
 * @returns {{pkg: string, file: string} | null} 提供方包名与命中文件。
 */
function findServiceProvider(service) {
  const needle = new RegExp(`super\\(ctx,\\s*['"\`]${service}['"\`]\\)|provide\\(\\s*['"\`]${service}['"\`]`);
  for (const root of storeRoots()) {
    if (!existsSync(root)) continue;
    for (const pkg of readdirSync(root).sort()) {
      if (!pkg.includes('tool')) continue;
      const base = join(root, pkg);
      for (const version of readdirSync(base).sort().reverse()) {
        const vdir = join(base, version);
        if (!statSync(vdir).isDirectory()) continue;
        for (const hash of readdirSync(vdir)) {
          const libDir = join(vdir, hash, 'node_modules/@deepseek-ai', pkg, 'lib');
          if (!existsSync(libDir)) continue;
          for (const file of readdirSync(libDir)) {
            if (!file.endsWith('.js')) continue;
            const p = join(libDir, file);
            try {
              if (needle.test(readFileSync(p, 'utf8'))) return { pkg, file: p };
            } catch { /* 读不到就跳过 */ }
          }
        }
      }
    }
  }
  return null;
}

/* ─────────────────── 复刻 cordis-plugin-loader 的 unwrapExports ─────────────────── */

/**
 * 与 cordis-plugin-loader 的 Loader#unwrapExports 逐字等价。
 *
 * @param {any} exports 模块导出。
 * @returns {any} 解包后的插件。
 */
function unwrapExports(exports) {
  if (exports === null || exports === undefined) return exports;
  exports = exports.default ?? exports;
  if (!exports.__esModule) return exports;
  return exports.default ?? exports;
}

/** 与 cordis 的 isApplicable 同款：对象且带 apply 方法。 */
function isApplicable(object) {
  return object !== null && typeof object === 'object' && typeof object.apply === 'function';
}

/** 给一个 promise 加超时（超时返回 'timeout' 而不是抛错）。 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise.then(() => 'settled', () => 'rejected'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), ms)),
  ]);
}

/**
 * cordis 的 FiberState（源码里是 `const enum`，编译后没有运行时的值对象，
 * 所以这里按定义抄一份数字）。
 *
 * 为什么不用 `await fiber.await()` 判断 pending：这个版本的 cordis 在依赖缺失时
 * 只是不执行插件体（epoch = INACTIVE），`inertia` 为空，`await()` 会**立刻**
 * 返回 —— 拿它判 pending 会误判成「已就绪」。真正的状态位是 fiber.state。
 */
const FIBER_STATE = { PENDING: 0, LOADING: 1, ACTIVE: 2, FAILED: 3, DISPOSED: 4, UNLOADING: 5 };

/* ───────────────────────────── 主流程 ───────────────────────────── */

console.log('→ 源文件形状');

if (!existsSync(PKG_PATH)) {
  bad('package.json 不存在：' + PKG_PATH);
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));

if (!existsSync(HOST_ENTRY)) {
  bad('Host 入口不存在：src/host/index.js');
  process.exit(1);
}
const hostSource = readFileSync(HOST_ENTRY, 'utf8');

/**
 * Host 侧必须同时导出 name 与 apply。
 *
 * 为什么：cordis 的 unwrapExports 对 ESM 命名空间只会返回它自己（没有 default
 * 也没有 __esModule）。这时 registry.resolve() 靠 `isApplicable(plugin)` 判断 ——
 * 有 apply 才认。只写 `export const name` 的话，namespace 里没有 apply，
 * resolve() 返回 undefined，registry.plugin() 抛 "received object"。
 */
if (/export\s+(const|let|var)\s+name\b/.test(hostSource)) ok('export const name');
else bad('缺 export const name');

if (/export\s+(async\s+)?function\s+apply\b/.test(hostSource)) ok('export function apply');
else bad('缺 export function apply（cordis 会报 invalid plugin … received object）');

if (/export\s+(const|let|var)\s+inject\b/.test(hostSource)) ok('export const inject');
else bad('缺 export const inject');

/* ── cordis.patch.yml 里那几段配置键必须还在（防漂移）── */
if (existsSync(PATCH_PATH)) {
  const patch = readFileSync(PATCH_PATH, 'utf8');
  for (const key of ['endpoint:', 'allowRemote:', 'usage:', 'expander:']) {
    if (patch.includes(key)) ok('cordis.patch.yml 里有 ' + key);
    else bad('cordis.patch.yml 里没有 ' + key);
  }
} else {
  bad('cordis.patch.yml 不存在');
}

console.log('');
console.log('→ 真实 cordis');

const found = findCordis();
if (found === null) {
  console.error('');
  console.error('✗ 找不到 @deepseek-ai/cordis —— 这个自检需要它。');
  console.error('  装法（任选其一）：');
  console.error('    · 在本仓库里：pnpm add -D @deepseek-ai/cordis');
  console.error('    · 或让本机 pnpm store 里有一份（DSH 自带的 profile 里有）。');
  process.exit(1);
}
ok('cordis 入口：' + found.file + '（' + found.from + '）');

const cordis = await import(pathToFileURL(found.file).href);

/* ── 注入的服务必须真实存在 ── */
for (const service of EXPECTED_INJECT) {
  const provider = findServiceProvider(service);
  if (provider === null) {
    bad(`inject 里的 "${service}" 找不到提供方 —— cordis 会永远等它，entry 卡在 pending`);
    console.error(`      装法：装上提供该服务的 DSH 包（例如 @deepseek-ai/dsh-tools 提供 tools）`);
  } else {
    ok(`inject 里的 "${service}" 由 @deepseek-ai/${provider.pkg} 提供`);
  }
}

/* ── 装载 ── */
let mod = null;
try {
  mod = await import(pathToFileURL(HOST_ENTRY).href);
  ok('src/host/index.js 可被 import');
} catch (error) {
  bad('import src/host/index.js 失败：' + (error?.message ?? String(error)));
  console.error('      （多半是 features/ 下还有没迁完的模块 —— 例如 usage/index.js 或 expander/index.js）');
}

if (mod !== null) {
  const plugin = unwrapExports(mod);
  console.log('    unwrap 结果：' + (typeof plugin === 'function' ? `function ${plugin.name}` : typeof plugin));

  if (typeof plugin === 'function') ok('unwrapExports 后是函数');
  else if (isApplicable(plugin)) ok('unwrapExports 后是带 apply 的对象');
  else bad(`unwrapExports 后是 ${typeof plugin}，既不是函数也没有 apply —— cordis 会抛 "invalid plugin … received object"`);

  /* ── name ── */
  if (plugin.name === EXPECTED_NAME) ok(`name === '${EXPECTED_NAME}'`);
  else bad(`name 是 ${JSON.stringify(plugin.name)}，必须是 '${EXPECTED_NAME}'`);

  if (pkg.name === EXPECTED_NAME) ok(`package.json 的 name === '${EXPECTED_NAME}'`);
  else bad(`package.json 的 name 是 ${JSON.stringify(pkg.name)}，必须是 '${EXPECTED_NAME}'`);

  if (plugin.name === pkg.name) ok('导出 name 与 package.json 的 name 一致');
  else bad(`导出 name(${plugin.name}) ≠ package.json 的 name(${pkg.name})`);

  /* ── inject ── */
  const inject = plugin.inject;
  if (!Array.isArray(inject)) {
    bad('inject 不是数组');
  } else {
    const same = inject.length === EXPECTED_INJECT.length && EXPECTED_INJECT.every((v, i) => inject[i] === v);
    if (same) ok('inject 恰好是 [' + EXPECTED_INJECT.join(', ') + ']');
    else bad(`inject 实际是 [${inject.join(', ')}]，必须是 [${EXPECTED_INJECT.join(', ')}]（多一个不存在的服务会让 entry 永远 pending）`);
  }

  /* ── 用真实 cordis 起一个 root context 并装载 ── */
  const { Context } = cordis;
  const ctx = new Context();
  const registeredTools = [];
  const toolDisposers = [];

  // 提供一个假的 tools 服务：只记录注册了什么。
  ctx.provide('tools', {
    register(tool) {
      registeredTools.push(tool);
      const dispose = () => {};
      toolDisposers.push(dispose);
      return dispose;
    },
  });

  try {
    // 注意：把**对象**（模块命名空间）直接交给 registry.plugin ——
    // 这样 cordis 才读得到 plugin.inject（bind 过的函数会丢掉 inject）。
    const fiber = ctx.registry.plugin(plugin, FULL_CONFIG);
    const settled = await withTimeout(fiber.await(), 5000);
    if (settled === 'settled') {
      ok('真实 cordis 装载成功（用一份覆盖全部功能的 config）');
      if (fiber.state === FIBER_STATE.ACTIVE) ok('fiber 状态 = ACTIVE');
      else bad(`fiber 状态不是 ACTIVE（是 ${fiber.state}）`);
    } else if (settled === 'rejected') {
      let message = '(未知错误)';
      try { await fiber.await(); } catch (error) { message = error?.message ?? String(error); }
      bad('cordis 装载抛错：' + message);
    } else {
      bad('cordis 装载 5 秒内没有 settle —— entry 会永远 pending');
    }

    const toolNames = registeredTools.map((tool) => tool?.name).filter(Boolean);
    for (const expected of EXPECTED_TOOLS) {
      if (toolNames.includes(expected)) ok(`注册了工具 ${expected}`);
      else bad(`没有注册工具 ${expected}（实际：${toolNames.join(', ') || '无'}）`);
    }
  } catch (error) {
    bad('cordis 装载失败：' + (error?.message ?? String(error)));
  }

  /* ── 反向验证：不提供 tools 时 entry 必须 pending ──
   * 这一条证明 inject 真的被 cordis 读到了（而不是被我们抄到 apply 里就完事）。
   * 如果 inject 写空了，插件会立刻就绪 —— 那就说明「等工具服务」这条契约没了。
   */
  try {
    const bare = new Context();
    const fiber = bare.registry.plugin(plugin, FULL_CONFIG);
    await withTimeout(fiber.await(), 400);
    if (fiber.state === FIBER_STATE.PENDING) ok('不提供 tools 时 entry 保持 pending（inject 生效）');
    else bad(`不提供 tools 时 entry 状态是 ${fiber.state}，应当是 PENDING(0) —— inject 声明没生效`);
    fiber.dispose?.();
    bare.fiber?.dispose?.();
  } catch (error) {
    bad('反向验证抛错：' + (error?.message ?? String(error)));
  }

  await ctx.stop?.().catch?.(() => {});
  ctx.fiber?.dispose?.();
}

console.log('');
if (failures.length > 0) {
  console.error('✗ host 校验失败（' + failures.length + ' 项）：');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ host 侧通过：导出形状 / name / inject 契约都符合，真实 cordis 可装载');
