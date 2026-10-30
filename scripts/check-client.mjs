#!/usr/bin/env node
/**
 * scripts/check-client.mjs
 *
 * 离线校验 **客户端产物**（client/client.js）能被 cordis 正常装载。
 *
 * 模拟 cordis 的关键行为
 * ----------------------
 *   1. `ctx` 是 Proxy —— 读任何没在 `inject` 里声明过的属性都抛
 *      `cannot get property "X" without inject`（cordis 的 reflect 层同款）。
 *   2. `apply(ctx, config)` —— config 是第二参数。
 *   3. `slots.inject(name, cb)` 的回调可以返回 **generator**：cordis 会把它
 *      迭代到底，generator 体里的 `ctx.slots.register(...)` 才会真正执行。
 *      模拟器必须照做 —— 否则注册项根本不会出现，断言会空转。
 *   4. `ctx.effect(fn)` **立即执行** fn 并返回 disposer（cordis 的语义）。
 *
 * 为什么这些断言重要
 * ------------------
 *   · inject 多写一个不存在的服务 → entry 永远 pending → 整页 Failed to load plugins；
 *   · 少注册 / 重复注册 settings.section → 设置面板里一个插件出现两个入口
 *     （本次聚合要消除的正是这个）；
 *   · 品牌槽 priority 不是 -1 → 压不过 dsh-client-ui-brand-official，主题不生效；
 *   · overrideTokens 的值不是 { light, dark } → ui-theme 直接抛错，页面炸。
 *
 * 用法：node scripts/check-client.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const BUNDLE = process.argv[2] || join(ROOT, 'client', 'client.js');

/**
 * 期望的 bundle id。必须与 package.json 的 name 一致 ——
 * DSH 用它把 bundle 与插件行对上，写错了插件根本不加载。
 */
const EXPECTED_ID = 'dsh-usage-aggregator';

/**
 * 期望的客户端硬 inject。
 *
 * 为什么必须**恰好**是这三个：
 *   · slots   —— 三个功能都要注册槽位；
 *   · locale  —— 三个功能都要注册字典；
 *   · theme   —— 主题功能要覆盖主题 token。
 * `sessions` 之类可有可无的服务必须走 ctx.inject(['sessions'], cb) 的**可选注入**。
 */
const EXPECTED_INJECT = ['slots', 'locale', 'theme'];

/**
 * 已被 dsh-client-ui-brand-official 以 priority 0 占住的 single 槽。
 *
 * single 槽按 priority 升序取第一个渲染 —— 所以要压过它必须给更低的值（-1）。
 */
const OCCUPIED_SINGLE_SLOTS = {
  'sidebar.brand.mark': 'dsh-client-ui-brand-official',
  'sidebar.brand.name': 'dsh-client-ui-brand-official',
};

/** 期望的主题 token 总数：26 个 --dsw-* + 17 个 --dsh-axzo-*。 */
const EXPECTED_TOKEN_COUNT = 43;
const EXPECTED_DSW_COUNT = 26;
const EXPECTED_AXZO_COUNT = 17;

/**
 * 期望的三个**功能**locale 命名空间（保持各功能原值不变，改名会让新旧并存）。
 * 聚合页自己还有一个命名空间（src/client/hub/i18n.js 的 NS），它放设置入口的
 * 标签，不需要 hubTab —— 见 HUB_NAMESPACE。
 */
const EXPECTED_NAMESPACES = ['settings.axzoTheme', 'usage-query', 'pluginExpander'];

/** 聚合页自己的命名空间（设置入口的标签在这里）。 */
const HUB_NAMESPACE = 'dsh-usage-aggregator';

/** 期望的槽位注册表：槽名 → { id, priority?, order? }。 */
const EXPECTED_SLOTS = {
  'settings.section': { id: 'usage-aggregator' },
  'conversation.session.header.utilities': { id: 'usage-query' },
  'plugins.tab': { id: 'updates' },
  'sidebar.brand.mark': { priority: -1 },
  'sidebar.brand.name': { priority: -1 },
  'conversation.hero.brand.mark': { priority: -1 },
};

/** 期望在 sidebar.footer.action 上注册的项：id → order。 */
const EXPECTED_FOOTER_ACTIONS = [
  { id: 'axzo-backdrop', order: 900 },
  { id: 'axzo-sidebar', order: 901 },
  // 任务状态探针：把官方 sessionStatus 快照喂给侧栏工作区的任务徽标。
  { id: 'axzo-task-status', order: 902 },
];

/**
 * 旧插件 id。
 *
 * 它只允许作为**主题 token 覆盖层的 source 标识**出现（ctx.theme.overrideTokens
 * 的第一个参数）；绝不能作为 bundle id —— 否则 DSH 会把三个插件当成三个。
 */
const LEGACY_ID = 'dsh-axzo-theme';

const failures = [];
function bad(label) { failures.push(label); console.log('  ✗ ' + label); }
function ok(label) { console.log('  ✓ ' + label); }

/* ─────────────────── 1. 把 bundle 装进一个假的 window.__ModuleLoader__ ─────────────────── */

if (!existsSync(BUNDLE)) {
  console.error('✗ 找不到客户端产物：' + BUNDLE);
  console.error('  先构建：pnpm build   （产物由 vite/config.mjs 写到 client/client.js）');
  process.exit(1);
}

let captured = null;

globalThis.window = {
  __ModuleLoader__: {
    load(spec) { captured = spec; },
  },
  setInterval: () => 0,
  clearInterval: () => {},
  // 主题功能在模块顶层就会调 matchMedia（os-prefs.js）—— 缺了它会直接 return，
  // 但给出桩更接近真机，也让「OS 偏好没生效」这类问题不被静默吞掉。
  matchMedia: (query) => ({
    media: query,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }),
  localStorage: null, // 下面单独装
};

/* ── 最小 DOM / storage shim（apply 会碰这些）── */
const styleEl = { setAttribute() {}, remove() {}, appendChild() {}, textContent: '', style: {} };
globalThis.document = {
  head: { appendChild() {} },
  body: { appendChild() {}, setAttribute() {}, removeAttribute() {} },
  createElement: () => ({ ...styleEl }),
  createElementNS: () => ({ ...styleEl }),
  getElementById: () => null,
  querySelectorAll: () => [],
  querySelector: () => null,
  documentElement: { style: { setProperty() {}, removeProperty() {} } },
};

/**
 * localStorage 桩。
 *
 * 一律返回 null —— 也就是「用户从没改过设置」的状态。
 * 这样主题用默认 tint（70）推导 token，正好是完整的 43 个；
 * 如果桩里预置了 tint=0 的偏好，表面染色那 9 个 token 就不存在了。
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
};
globalThis.window.localStorage = globalThis.localStorage;

const bundleSource = readFileSync(BUNDLE, 'utf8');
// 用 new Function 而不是 import：bundle 依赖全局 window/document，且不是 ESM
new Function(bundleSource)();

if (captured === null) {
  console.error('✗ bundle 没有调用 window.__ModuleLoader__.load');
  process.exit(1);
}

/* ─────────────────── 2. 导出形状 ─────────────────── */

console.log('→ 导出形状');

if (captured.id === EXPECTED_ID) ok(`load 的 id 是 '${EXPECTED_ID}'`);
else bad(`load 的 id 是 ${JSON.stringify(captured.id)}，必须是 '${EXPECTED_ID}'`);

if (captured.id === PKG.name) ok('load 的 id 与 package.json 的 name 一致');
else bad(`load 的 id(${captured.id}) ≠ package.json 的 name(${PKG.name})`);

if (captured.id !== LEGACY_ID) ok(`bundle id 不是旧插件 id（${LEGACY_ID}）`);
else bad(`bundle id 还是旧插件 id（${LEGACY_ID}）—— 三个插件会被当成三个`);

// 旧 id 只允许作为主题覆盖层的 source 出现，不能是任何注册项的 id。
const legacyAsId = /id\s*:\s*['"]dsh-axzo-theme['"]/.exec(bundleSource);
if (legacyAsId === null) ok('产物里没有把旧 id 当作注册项 id');
else bad('产物里出现了 `id: "dsh-axzo-theme"` —— 旧插件会以另一个身份复活');

/* ── 最小 react shim（apply 只注册组件，不渲染）── */
const reactShim = {
  createElement: (...args) => ({ __el: args }),
  Fragment: 'Fragment',
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (init) => ({ current: init }),
};

let mod;
try {
  mod = captured.factory((name) => {
    if (name === 'react') return reactShim;
    if (name === 'react-dom' || name === 'react-dom/client') {
      return { createPortal: () => { throw new Error('SSR 环境不应调用 createPortal'); } };
    }
    throw new Error('unknown require: ' + name);
  });
} catch (error) {
  console.error('✗ factory 执行失败：' + (error?.message ?? String(error)));
  process.exit(1);
}

if (typeof mod.apply === 'function') ok('exports.apply 是函数');
else bad('exports.apply 不是函数');

const inject = mod.inject;
if (!Array.isArray(inject)) {
  bad('exports.inject 不是数组');
} else {
  const same = inject.length === EXPECTED_INJECT.length && EXPECTED_INJECT.every((v, i) => inject[i] === v);
  if (same) ok('inject 恰好是 [' + EXPECTED_INJECT.join(', ') + ']');
  else bad(`inject 实际是 [${inject.join(', ')}]，必须是 [${EXPECTED_INJECT.join(', ')}]`);

  // dsh 的第三方插件可以依赖的 client service 全清单（来自各 dsh-client-* bundle
  // 里的 ctx.provide(...) / new Service(ctx, "...")）
  const KNOWN = new Set([
    'slots', 'locale', 'theme', 'remote', 'settingsScope', 'settingsSchema',
    'connection', 'store', 'layout', 'commands', 'dialogs', 'toasts',
  ]);
  for (const name of inject) {
    if (!KNOWN.has(name)) bad(`inject 里的 "${name}" 不是已知 service —— cordis 会永远等它`);
  }
  if (inject.includes('sessions')) bad('sessions 出现在硬 inject 里 —— 必须是 ctx.inject([...], cb) 的可选注入');
  else ok('sessions 不在硬 inject 里');
}

if (mod.PLUGIN_ID === EXPECTED_ID) ok(`exports.PLUGIN_ID === '${EXPECTED_ID}'`);
else bad(`exports.PLUGIN_ID 是 ${JSON.stringify(mod.PLUGIN_ID)}，必须是 '${EXPECTED_ID}'`);

if (typeof mod.BUILD_AT === 'string') ok('exports.BUILD_AT 是字符串（构建时间戳）');
else bad('exports.BUILD_AT 不是字符串');

/* ─────────────────── 3. 用会抛错的 Proxy 跑 apply ─────────────────── */

console.log('');
console.log('→ apply(ctx) 与槽位注册');

const ALLOWED = new Set([...(inject || []), 'effect', 'on', 'config', 'provide', 'logger', 'inject']);
const slotRegs = [];
const injectedSlots = [];
const themeCalls = { register: [], overrideTokens: [] };
const dictionaries = new Map();

/** 可驱动的会话状态（主题的任务状态徽标要用）。 */
const sessionState = { running: {}, completed: {}, paused: {} };
const sessionListeners = [];
const sessions = {
  list: {
    getSnapshot() {
      const byId = {};
      for (const id of Object.keys(sessionState.running)) {
        byId[id] = { id, cwd: '/tmp', running: true, blank: false };
      }
      for (const id of Object.keys(sessionState.completed)) {
        byId[id] = { id, cwd: '/tmp', completed: true, blank: false };
      }
      for (const id of Object.keys(sessionState.paused)) {
        byId[id] = { id, cwd: '/tmp', blank: false };
      }
      return { ids: Object.keys(byId), byId, current: undefined };
    },
    subscribe(fn) { sessionListeners.push(fn); return () => {}; },
  },
};

const ctx = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (!ALLOWED.has(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      // ctx.inject([...], cb) 是**可选注入**：服务齐了才跑，不阻塞插件加载。
      if (prop === 'inject') {
        return (deps, cb) => {
          const scope = {};
          for (const name of deps) {
            if (name === 'sessions') scope.sessions = sessions;
            else scope[name] = {};
          }
          const dispose = cb(scope);
          return typeof dispose === 'function' ? dispose : () => {};
        };
      }
      // 真实 cordis 的 effect **立即执行** fn 并返回 disposer。
      if (prop === 'effect') {
        return (fn) => {
          let dispose;
          try { dispose = fn(); } catch (error) { throw error; }
          return typeof dispose === 'function' ? dispose : () => {};
        };
      }
      if (prop === 'slots') {
        return {
          /**
           * slots.inject(name, cb)。
           *
           * cb 可以返回 generator —— cordis 会把它迭代到底，
           * generator 体里的 register 才会真正执行。模拟器必须照做。
           */
          inject: (name, cb) => {
            injectedSlots.push(name);
            const result = cb();
            if (result && typeof result.next === 'function') {
              const disposes = [];
              for (const item of result) {
                if (typeof item === 'function') disposes.push(item);
              }
              return () => { for (const d of disposes) d(); };
            }
            return typeof result === 'function' ? result : () => {};
          },
          register: (spec) => { slotRegs.push(spec); return () => {}; },
        };
      }
      if (prop === 'locale') {
        return {
          register: (ns, dict) => { dictionaries.set(ns, dict); return () => {}; },
          bind: (ns) => (key) => {
            const d = dictionaries.get(ns);
            return d && d.zh && d.zh[key] !== undefined ? d.zh[key] : key;
          },
        };
      }
      if (prop === 'theme') {
        return {
          register: (def) => { themeCalls.register.push(def); return () => {}; },
          overrideTokens: (source, tokens) => { themeCalls.overrideTokens.push({ source, tokens }); return () => {}; },
        };
      }
      return undefined;
    },
    has: () => true,
  },
);

try {
  mod.apply(ctx, {});
} catch (error) {
  bad('apply 抛错：' + (error?.message ?? String(error)));
}

if (failures.length === 0) ok('apply(ctx) 在会抛错的 Proxy 下跑通（没读到未声明的服务）');

/* ─────────────────── 4. 槽位注册断言 ─────────────────── */

const byName = (name) => slotRegs.filter((spec) => spec.name === name);

for (const [name, expected] of Object.entries(EXPECTED_SLOTS)) {
  const found = byName(name);
  if (found.length === 0) {
    bad(`没有注册槽位 ${name}`);
    continue;
  }
  if (name === 'settings.section' && found.length !== 1) {
    bad(`settings.section 注册了 ${found.length} 次 —— 一个插件只能有一个设置入口`);
    continue;
  }
  if (expected.id !== undefined) {
    const ids = found.map((spec) => spec.id);
    if (ids.includes(expected.id)) ok(`${name} 的 id 是 '${expected.id}'`);
    else bad(`${name} 的 id 是 [${ids.join(', ')}]，必须是 '${expected.id}'`);
  }
  if (expected.priority !== undefined) {
    const priority = found[0].priority ?? 0;
    if (priority === expected.priority) ok(`${name} 的 priority 是 ${expected.priority}`);
    else bad(`${name} 的 priority 是 ${priority}，必须是 ${expected.priority}`);
  }
}

// 聚合页必须是**唯一**的 settings.section 入口。
const sections = byName('settings.section');
if (sections.length === 1) ok('settings.section 只注册一次（聚合设置页）');
else if (sections.length > 1) bad(`settings.section 注册了 ${sections.length} 次`);

// sidebar.footer.action 必须注册三次（背景宿主 + 侧栏质感宿主 + 任务状态探针），顺序固定。
const footers = byName('sidebar.footer.action');
if (footers.length === EXPECTED_FOOTER_ACTIONS.length) {
  let matched = true;
  for (const expected of EXPECTED_FOOTER_ACTIONS) {
    const hit = footers.find((spec) => spec.id === expected.id);
    if (hit === undefined) { bad(`sidebar.footer.action 缺少 id '${expected.id}'`); matched = false; continue; }
    if ((hit.order ?? 0) !== expected.order) {
      bad(`sidebar.footer.action 的 '${expected.id}' order 是 ${hit.order ?? 0}，必须是 ${expected.order}`);
      matched = false;
    }
  }
  if (matched) ok('sidebar.footer.action 注册三次（axzo-backdrop@900 / axzo-sidebar@901 / axzo-task-status@902）');
} else {
  bad(`sidebar.footer.action 注册了 ${footers.length} 次，必须是 ${EXPECTED_FOOTER_ACTIONS.length} 次`);
}

// single 槽被官方占住时，priority 必须压过它。
for (const spec of slotRegs) {
  const occupant = OCCUPIED_SINGLE_SLOTS[spec.name];
  if (!occupant) continue;
  const priority = spec.priority ?? 0;
  if (priority >= 0) {
    bad(`slot "${spec.name}" 是 single 槽，已被 ${occupant} 以 priority 0 占用；当前 priority=${priority} 会抛 "already has a registration"`);
  }
}

/* ─────────────────── 5. theme 契约 ─────────────────── */

console.log('');
console.log('→ theme 契约');

if (themeCalls.overrideTokens.length === 0) {
  bad('ctx.theme.overrideTokens 一次都没被调用 —— 主题 token 不会生效');
} else {
  ok('ctx.theme.overrideTokens 被调用了 ' + themeCalls.overrideTokens.length + ' 次');
}

// 取 token 最多的那一次作为「主覆盖层」。
let overlay = null;
for (const call of themeCalls.overrideTokens) {
  const count = Object.keys(call.tokens ?? {}).length;
  if (overlay === null || count > Object.keys(overlay.tokens).length) overlay = call;
}

if (overlay !== null) {
  const names = Object.keys(overlay.tokens);
  const dsw = names.filter((n) => n.startsWith('--dsw-'));
  const axzo = names.filter((n) => n.startsWith('--dsh-axzo-'));

  if (names.length === EXPECTED_TOKEN_COUNT) ok(`覆盖层有 ${names.length} 个 token`);
  else bad(`覆盖层有 ${names.length} 个 token，必须是 ${EXPECTED_TOKEN_COUNT} 个`);

  if (dsw.length === EXPECTED_DSW_COUNT) ok(`其中 ${dsw.length} 个 --dsw-*`);
  else bad(`其中 ${dsw.length} 个 --dsw-*，必须是 ${EXPECTED_DSW_COUNT} 个`);

  if (axzo.length === EXPECTED_AXZO_COUNT) ok(`其中 ${axzo.length} 个 --dsh-axzo-*`);
  else bad(`其中 ${axzo.length} 个 --dsh-axzo-*，必须是 ${EXPECTED_AXZO_COUNT} 个`);

  for (const name of names) {
    if (!name.startsWith('--')) bad(`token 名 "${name}" 不像 CSS 自定义属性名`);
    const value = overlay.tokens[name];
    if (typeof value === 'string') {
      bad(`token "${name}" 是裸字符串 —— ui-theme 会抛错，必须给 { light, dark }`);
      continue;
    }
    if (typeof value !== 'object' || value === null ||
        typeof value.light !== 'string' || typeof value.dark !== 'string') {
      bad(`token "${name}" 不是 { light, dark } 字符串对`);
    }
  }

  if (names.includes('--dsw-alias-accent-primary')) bad('出现了不存在的 --dsw-alias-accent-* token');
}

/* ─────────────────── 6. locale 契约 ─────────────────── */

console.log('');
console.log('→ locale 契约');

for (const ns of EXPECTED_NAMESPACES) {
  const dict = dictionaries.get(ns);
  if (dict === undefined) {
    bad(`没有注册 locale 命名空间 '${ns}'`);
    continue;
  }
  ok(`注册了 locale 命名空间 '${ns}'`);
  if (typeof dict.zh !== 'object' || dict.zh === null) bad(`命名空间 '${ns}' 缺 zh 字典`);
  if (typeof dict.en !== 'object' || dict.en === null) bad(`命名空间 '${ns}' 缺 en 字典`);
}

// 页签标签与设置入口名归**聚合页自己的**命名空间，不在各功能的命名空间下 ——
// 同一个命名空间同时只能被一个包注册，功能自己那份标签在新旧插件并存时会拿不到。
const hubDict = dictionaries.get(HUB_NAMESPACE);
if (hubDict === undefined) {
  bad(`聚合页的命名空间 '${HUB_NAMESPACE}' 没注册 —— 设置入口与页签标签没有出处`);
} else {
  for (const key of ['tab', 'tabTheme', 'tabUsage', 'tabExpander']) {
    const zhText = hubDict.zh ? hubDict.zh[key] : undefined;
    const enText = hubDict.en ? hubDict.en[key] : undefined;
    if (typeof zhText !== 'string' || zhText === '') bad(`聚合页 zh 字典缺 '${key}'`);
    else if (typeof enText !== 'string' || enText === '') bad(`聚合页 en 字典缺 '${key}'`);
    else ok(`聚合页字典 '${key}' = '${zhText}' / '${enText}'`);
  }
}

const unexpected = [...dictionaries.keys()].filter((ns) => !EXPECTED_NAMESPACES.includes(ns) && ns !== HUB_NAMESPACE);
if (unexpected.length === 0) ok(`命名空间总数正确（3 个功能 + 1 个聚合页）`);
else bad(`出现了多余的 locale 命名空间：${unexpected.join(', ')}`);

/* ─────────────────── 报告 ─────────────────── */

console.log('');
console.log('注入的槽   : ' + JSON.stringify([...new Set(injectedSlots)]));
console.log('注册的槽   : ' + JSON.stringify(slotRegs.map((s) => `${s.name}#${s.id ?? '-'}`)));
console.log('theme.register      : ' + themeCalls.register.length + ' 次');
console.log('theme.overrideTokens: ' + themeCalls.overrideTokens.length + ' 次');
console.log('');

if (failures.length > 0) {
  console.error('✗ 校验失败（' + failures.length + ' 项）：');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

console.log('✓ client bundle 通过：inject 精确、槽位唯一、theme 契约与 locale 命名空间都对');
