#!/usr/bin/env node
/**
 * scripts/ui-check-boost.mjs
 *
 * 「电脑加速与清理」功能的离线渲染自检：用真实的 react + react-dom/server 把
 * 小火箭浮层与设置页视图**真渲染**一遍（node scripts/ui-check-boost.mjs）。
 *
 * 为什么需要它：组件一渲染就抛异常 → 整个浮层被清空，是客户端插件最难事后
 * 定位的故障（控制台只留一行 slot entry crashed）。这里把组件渲染成 HTML
 * 字符串并断言关键内容出现 —— 等于在没有浏览器的情况下跑一遍
 * 「渲染不崩 + 画对了 + 默认全选 + 交接单说清楚了」。
 *
 * 数据用 src/host/features/boost/fixtures/scan.json：那是真机上跑出来的
 * 一次体检结果（跑法见该目录下的 README），所以断言的是真实形状。
 *
 * react 从本机 pnpm store 里取（客户端跑的就是 react 18.3.1）。找不到时**报错退出**，
 * 不静默通过 —— 静默通过等于「自检没跑但看着像跑过了」。
 */

import { strict as assert } from 'node:assert';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { installRuntime } from '../src/client/runtime.js';
import * as boost from '../src/client/features/boost/index.js';
import {
  api,
  buildHandoffText,
  currentSessionId,
  formatBytes,
  HANDOFF_TIMEOUT_MS,
} from '../src/client/features/boost/view.js';

// 交接那段要用 window.setTimeout —— Node 里没有 window，补一个最小的。
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval };
}

const PLUGIN_DIR = new URL('..', import.meta.url).pathname;

/* ─────────────────────── 找一份本机已有的 react ─────────────────────── */

function findInStore(name, wanted) {
  const roots = [
    join(homedir(), 'Library/pnpm/store/v11/links/@', name),
    join(homedir(), '.pnpm-store/v3/links/@', name),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const versions = (wanted === undefined ? readdirSync(root).sort().reverse() : [wanted])
      .filter((version) => existsSync(join(root, version)));
    for (const version of versions) {
      for (const hash of readdirSync(join(root, version))) {
        const pkgDir = join(root, version, hash, 'node_modules', name);
        if (existsSync(join(pkgDir, 'package.json'))) return { dir: pkgDir, version: version };
      }
    }
  }
  return null;
}

async function loadReact() {
  // react 与 react-dom 必须**同版本**：跨版本混用会在渲染时报
  // 「Objects are not a valid as a React child」这种指错方向的错。
  const wanted = process.env.DUA_UI_REACT_VERSION ?? '18.3.1';
  const react = findInStore('react', wanted) ?? findInStore('react');
  if (react === null) {
    console.error('✗ 本机找不到 react —— 这个自检需要它。');
    console.error('  react / react-dom 应当在 pnpm store 里（DSH 自带的 profile 里有）；');
    console.error('  也可以在本仓库里装：pnpm add -D react@18.3.1 react-dom@18.3.1');
    process.exit(1);
  }
  const reactDom = findInStore('react-dom', react.version);
  if (reactDom === null) {
    console.error(`✗ 本机找不到与 react ${react.version} 同版本的 react-dom —— 版本必须一致。`);
    process.exit(1);
  }
  const React = await import(pathToFileURL(join(react.dir, 'index.js')).href);
  const serverEntry = existsSync(join(reactDom.dir, 'server.node.js')) ? 'server.node.js' : 'server.js';
  const ReactDOMServer = await import(pathToFileURL(join(reactDom.dir, serverEntry)).href);
  return { React: React.default ?? React, ReactDOMServer: ReactDOMServer.default ?? ReactDOMServer, version: react.version };
}

/* ───────────────────────────── 断言 ───────────────────────────── */

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n     ${error.message}`);
  }
}

const { React, ReactDOMServer, version } = await loadReact();
console.log(`→ react ${version} 离线渲染`);

// 共享 runtime：聚合入口的 factory 里也是这么装 React 的。
installRuntime((name) => {
  if (name === 'react') return React;
  if (name === 'react-dom' || name === 'react-dom/client') {
    return { createPortal: () => { throw new Error('SSR 环境不应调用 createPortal'); } };
  }
  throw new Error(`客户端只允许 require('react') / 'react-dom'，实际要了：${name}`);
});

const zh = boost.dictionaries.zh;
const en = boost.dictionaries.en;
const t = (key, vars) => {
  const text = zh[key] ?? key;
  return vars === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])));
};
const html = (element) => ReactDOMServer.renderToStaticMarkup(element);

/**
 * 跑一次交接，拿到它返回的状态。
 *
 * @param {{runtime: object, sessionId: string}} options 选项。
 * @returns {Promise<object>} 交接状态。
 */
async function renderHandoff(options) {
  let captured = null;
  function Probe() {
    const state = boost.__ui.useHandoff({
      t: t,
      job: { items: [{ id: 'dsh-projcache', label: 'x', sizeBytes: 1, count: 1, semantics: 'prune', commandText: 'y', note: '' }], analysis: null },
      selected: ['dsh-projcache'],
      runtime: options.runtime,
      sessionId: options.sessionId,
    });
    captured = state;
    return null;
  }
  html(React.createElement(Probe));
  captured.run();
  await new Promise((resolve) => setTimeout(resolve, 50));
  return captured;
}

/* 真机上跑出来的体检结果（夹具）。 */
const FIXTURE_PATH = join(PLUGIN_DIR, 'src', 'host', 'features', 'boost', 'fixtures', 'scan.json');
if (!existsSync(FIXTURE_PATH)) {
  console.error('✗ 找不到夹具：' + FIXTURE_PATH);
  process.exit(1);
}
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const items = Array.isArray(fixture.items) ? fixture.items : [];

check('功能契约：meta / dictionaries / apply / HubView 都在', () => {
  assert.ok(boost.meta !== undefined, '缺 meta');
  assert.equal(boost.meta.id, 'boost');
  assert.equal(boost.meta.namespace, 'pcBoost');
  assert.equal(typeof boost.meta.hubOrder, 'number');
  assert.equal(boost.meta.hubTabKey, 'tabBoost');
  assert.ok(boost.dictionaries !== undefined, '缺 dictionaries');
  assert.ok(typeof boost.dictionaries.zh === 'object', '缺 zh 字典');
  assert.ok(typeof boost.dictionaries.en === 'object', '缺 en 字典');
  assert.equal(typeof boost.apply, 'function', 'apply 必须是函数');
  assert.equal(typeof boost.HubView, 'function', 'HubView 必须是函数');
});

check('中英字典的键一一对应（en 缺 key 会退回中文）', () => {
  for (const key of Object.keys(zh)) {
    assert.equal(typeof en[key], 'string', `en 字典缺 '${key}'`);
  }
  for (const key of Object.keys(en)) {
    assert.equal(typeof zh[key], 'string', `zh 字典缺 '${key}'`);
  }
});

check('夹具是真实形状：每个条目都有 id / 分组 / 动作 / 命令', () => {
  assert.ok(items.length > 0, '夹具里一条都没有');
  const groups = new Set();
  for (const item of items) {
    assert.equal(typeof item.id, 'string');
    assert.equal(typeof item.label, 'string');
    assert.ok(item.group === 'cache' || item.group === 'dsh' || item.group === 'process', `${item.id} 的分组不认识：${item.group}`);
    groups.add(item.group);
    assert.equal(typeof item.sizeBytes, 'number');
    assert.ok(item.sizeBytes > 0 || item.group !== 'cache', `${item.id} 的体积是 0 —— 空缓存不该出现在清单里`);
    assert.ok(
      ['prune', 'full', 'terminate', 'renice', 'close-window'].includes(item.semantics),
      `${item.id} 的 semantics 不认识：${item.semantics}`,
    );
    assert.ok(typeof item.commandText === 'string' && item.commandText !== '', `${item.id} 没有命令`);
    assert.equal(typeof item.selectedByDefault, 'boolean', `${item.id} 没写默认勾没勾`);
    assert.ok(item.action !== undefined && typeof item.action.type === 'string', `${item.id} 没有动作`);
  }
  assert.ok(groups.has('cache'), '夹具里没有工具链缓存');
  assert.ok(groups.has('dsh'), '夹具里没有 DSH 自己的条目');
  assert.ok(groups.has('process'), '夹具里没有进程层的条目');
});

check('浮层（收起来时）：只画那个火箭按钮', () => {
  const markup = html(React.createElement(boost.__ui.BoostWidget, { t: t, runtime: { sessions: null } }));
  assert.ok(markup.includes('class="dsh-boost-launch"'), '缺火箭按钮');
  assert.ok(markup.includes(zh.entryTitle), '缺入口标题');
  // 断言**元素**而不是类名 —— 类名也出现在 <style> 的 CSS 文本里，
  // 那样断言在收起来时也会通过（自检空转，等于没测）。
  assert.ok(!markup.includes('class="dsh-boost-panel"'), '没打开时不该画面板');
});

check('浮层（展开时）：画出结论、逐项清单与勾选框', () => {
  const markup = html(React.createElement(boost.__ui.BoostWidget, {
    t: t,
    runtime: { sessions: null },
    initialOpen: true,
    initialJob: fixture,
  }));
  assert.ok(markup.includes('class="dsh-boost-panel"'), '缺面板');
  assert.ok(markup.includes(fixture.analysis.diagnosis), '缺体检结论');
  assert.ok(markup.includes(fixture.items[0].label), '缺第一条清单');
  assert.ok(markup.includes('class="dsh-boost-check"'), '缺勾选框');
  assert.ok(markup.includes(zh.run), '缺「交给 Agent 执行」按钮');
});

check('默认勾选：有代价的条目默认不勾，其余默认勾上', () => {
  const markup = html(React.createElement(boost.__ui.BoostWidget, {
    t: t,
    runtime: { sessions: null },
    initialOpen: true,
    initialJob: fixture,
  }));
  const boxes = markup.match(/<input[^>]*class="dsh-boost-check"[^>]*>/g) ?? [];
  assert.equal(boxes.length, items.length, `勾选框数量（${boxes.length}）与条目数（${items.length}）对不上`);
  const expectedChecked = items.filter((item) => item.selectedByDefault !== false).length;
  const actualChecked = boxes.filter((box) => /checked/.test(box)).length;
  assert.equal(actualChecked, expectedChecked, `默认勾上的数量（${actualChecked}）与预期（${expectedChecked}）对不上`);
  // 会结束程序、会关窗口、会删用户历史的条目必须默认不勾。
  const MUST_NOT_CHECK = [
    /^mem-app:/, /^mem-proc:/, /^window:/,
    /^dsh-orphan-sessions$/, /^dsh-old-sessions$/,
    /^dsh-archived-sessions$/, /^dsh-attachments$/,
  ];
  for (const item of items) {
    if (MUST_NOT_CHECK.some((pattern) => pattern.test(item.id))) {
      assert.equal(item.selectedByDefault, false, `${item.id} 有代价却默认勾上了`);
    }
  }
});

check('清单按组分段：三个分组标题都在', () => {
  const markup = html(React.createElement(boost.__ui.BoostWidget, {
    t: t,
    runtime: { sessions: null },
    initialOpen: true,
    initialJob: fixture,
  }));
  assert.ok(markup.includes('class="dsh-boost-group-title"'), '缺分组标题');
  assert.ok(markup.includes(zh.groupCache), '缺「工具链缓存」分组');
  assert.ok(markup.includes(zh.groupDsh), '缺「DSH 自己」分组');
  assert.ok(markup.includes(zh.groupProcess), '缺「进程与窗口」分组');
});

check('设置页视图：与浮层画的是同一份清单', () => {
  const markup = html(React.createElement(boost.__ui.BoostPanel, { t: t, initialJob: fixture }));
  assert.ok(markup.includes(fixture.analysis.diagnosis), '缺体检结论');
  assert.ok(markup.includes(fixture.items[0].label), '缺第一条清单');
  assert.ok(markup.includes('class="dsh-boost-check"'), '缺勾选框');
});

check('交接单：写清勾了哪几项、各自做什么、要求先说明再动手', () => {
  const ids = items.slice(0, 3).map((item) => item.id);
  const text = buildHandoffText(t, fixture, ids);
  assert.ok(text.includes(fixture.analysis.diagnosis), '交接单里缺体检结论');
  for (const id of ids) {
    assert.ok(text.includes(`[${id}]`), `交接单里缺条目 ${id}`);
  }
  assert.ok(text.includes('system_boost'), '交接单里没说要用哪个工具');
  assert.ok(text.includes('先'), '交接单里没有「先说明再动手」的要求');
});

check('交接单：勾选为空时不列出任何条目', () => {
  const text = buildHandoffText(t, fixture, []);
  for (const item of items) {
    assert.ok(!text.includes(`[${item.id}]`), `不该出现未勾选的条目 ${item.id}`);
  }
});

check('交接：会话取不到时改由面板直接执行', async () => {
  const original = api.execute;
  const originalStatus = api.executeStatus;
  const calls = [];
  api.execute = (ids) => {
    calls.push(ids);
    return Promise.resolve({ id: 'boost-exec-1', running: true, total: ids.length, done: 0 });
  };
  api.executeStatus = () => Promise.resolve({
    id: 'boost-exec-1', running: false, total: 1, done: 1, currentLabel: 'x', reclaimedBytes: 1024, results: [], error: '',
  });
  try {
    const runtime = { sessions: { scope: () => { throw new Error('取不到 scope'); } } };
    const result = await renderHandoff({ runtime, sessionId: 'session-x' });
    assert.equal(calls.length, 1, '没有落到面板直接执行');
    assert.deepEqual(calls[0], ['dsh-projcache']);
    assert.equal(result.phase, 'done');
  } finally {
    api.execute = original;
    api.executeStatus = originalStatus;
  }
});

check('交接：Agent 那边不回音，超时后改由面板直接执行', async () => {
  const original = api.execute;
  const originalStatus = api.executeStatus;
  const calls = [];
  api.execute = (ids) => {
    calls.push(ids);
    return Promise.resolve({ id: 'boost-exec-1', running: true, total: ids.length, done: 0 });
  };
  api.executeStatus = () => Promise.resolve({
    id: 'boost-exec-1', running: false, total: 1, done: 1, currentLabel: 'x', reclaimedBytes: 0, results: [], error: '',
  });
  try {
    // send 永不结算 —— 模拟 RPC 卡住。
    const runtime = { sessions: { scope: () => ({ conversation: { send: () => new Promise(() => {}) } }) } };
    const result = await renderHandoff({ runtime, sessionId: 'session-x' });
    assert.equal(calls.length, 1, '超时后没有落到面板直接执行');
    assert.equal(result.phase, 'done');
  } finally {
    api.execute = original;
    api.executeStatus = originalStatus;
  }
});

check('交接：Agent 收下了就不重复执行', async () => {
  const original = api.execute;
  const originalStatus = api.executeStatus;
  const calls = [];
  api.execute = (ids) => {
    calls.push(ids);
    return Promise.resolve({ id: 'boost-exec-1', running: true, total: ids.length, done: 0 });
  };
  api.executeStatus = () => Promise.resolve({
    id: 'boost-exec-1', running: false, total: 1, done: 1, currentLabel: 'x', reclaimedBytes: 0, results: [], error: '',
  });
  try {
    const runtime = { sessions: { scope: () => ({ conversation: { send: () => Promise.resolve() } }) } };
    const result = await renderHandoff({ runtime, sessionId: 'session-x' });
    await new Promise((resolve) => setTimeout(resolve, HANDOFF_TIMEOUT_MS + 200));
    assert.equal(calls.length, 0, 'Agent 已经收下了，面板又执行了一遍');
    assert.equal(result.phase, 'done');
  } finally {
    api.execute = original;
    api.executeStatus = originalStatus;
  }
});

check('当前会话：认 mainView 保留的那个，子代理不算', () => {
  const state = {
    byId: {
      'session-sub': { id: 'session-sub', retainedBy: { mainView: 0 } },
      'session-main': { id: 'session-main', retainedBy: { mainView: 1 } },
    },
  };
  assert.equal(currentSessionId(state), 'session-main');
  assert.equal(currentSessionId({ byId: {} }), null);
  assert.equal(currentSessionId(null), null);
});

check('体积格式化：字节 → 人话', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1024 * 1024 * 3.5), '3.5 MB');
  assert.equal(formatBytes(1024 ** 3 * 2), '2 GB');
});

check('槽位注册：只注册 shell.overlay 一个浮层，id 是 axzo-boost', () => {
  const registered = [];
  const fakeCtx = {
    effect: (fn) => { fn(); return () => {}; },
    locale: { register: () => () => {} },
    inject: (names, callback) => { callback({ sessions: null }); return () => {}; },
    slots: {
      inject: (name, callback) => {
        registered.push({ name, callback });
        return () => {};
      },
      register: (options, render) => ({ options, render }),
    },
  };
  boost.apply(fakeCtx, t);
  assert.equal(registered.length, 1, `注册了 ${registered.length} 个槽位`);
  assert.equal(registered[0].name, 'shell.overlay');
  const entry = registered[0].callback();
  assert.equal(entry.options.id, 'axzo-boost');
  assert.equal(entry.options.name, 'shell.overlay');
});

check('功能模块不注册 settings.section（设置入口只能有一个）', () => {
  const source = readFileSync(join(PLUGIN_DIR, 'src', 'client', 'features', 'boost', 'index.js'), 'utf8');
  assert.ok(!source.includes('settings.section'), '功能模块不该注册 settings.section');
});

console.log('');
if (failures.length === 0) {
  console.log(`✓ ${passed} 项断言全部通过`);
  process.exit(0);
}
console.log(`✗ ${failures.length} 项断言未通过（共 ${passed + failures.length} 项）`);
process.exit(1);
