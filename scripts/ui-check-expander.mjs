#!/usr/bin/env node
/**
 * scripts/ui-check-expander.mjs
 *
 * 「插件更新」功能的离线渲染自检：用真实的 react + react-dom/server 把
 * UpdatesTab **真渲染**一遍（node scripts/ui-check-expander.mjs）。
 *
 * 为什么需要它：这个环境里没有浏览器控制权，插件的 UI 只在真页面上才看得见。
 * 而「组件一渲染就抛异常 → 整个标签页条带被清空」是客户端插件最常见、也最难
 * 事后定位的故障（控制台只留一行 slot entry crashed）。这里把组件逐个渲染成
 * HTML 字符串并断言关键内容出现 —— 等于在没有浏览器的情况下跑一遍
 * 「渲染不崩 + 画对了」。
 *
 * 数据用 src/host/features/expander/fixtures/state.json：那是真机上抓下来的
 * Host 响应（见 expander 的 README「怎么更新这份夹具」），所以断言的是真实
 * 形状，不是手编的理想值。
 *
 * react 从本机 pnpm store 里取（客户端跑的就是 react 18.3.1）。找不到时**报错退出**，
 * 不静默通过 —— 静默通过等于「自检没跑但看着像跑过了」。
 *
 * 迁移说明（从 dsh-plugin-expander 的 scripts/ui-check.mjs 改写）：
 *   · 组件从源码模块 src/client/features/expander/index.js 的 __ui 导出取；
 *   · React 通过共享 runtime（src/client/runtime.js）的 installRuntime 装上 ——
 *     与聚合入口的 factory 同一条路径；
 *   · 夹具路径改为 src/host/features/expander/fixtures/state.json。
 */

import { strict as assert } from 'node:assert';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { installRuntime } from '../src/client/runtime.js';
import * as expander from '../src/client/features/expander/index.js';

const PLUGIN_DIR = new URL('..', import.meta.url).pathname;
const ui = expander.__ui;

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
  // 「Objects are not valid as a React child」这种指错方向的错。
  // 默认对齐生产：DSH 客户端的 react 是 18.x（dsh-client-ui-* 的 peer 是 ^18.2.0）。
  // 需要时用 DUA_UI_REACT_VERSION=19.2.8 换一版验证向前兼容。
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
    // portal 只在浏览器里真的调用；SSR 下给个会报错的桩，确保组件在 effect
    // 之外永远不尝试 portal。
    return { createPortal: () => { throw new Error('SSR 环境不应调用 createPortal'); } };
  }
  throw new Error(`客户端只允许 require('react') / 'react-dom'，实际要了：${name}`);
});

const t = (key, vars) => {
  const text = ui.zh[key] ?? key;
  return vars === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])));
};
const html = (element) => ReactDOMServer.renderToStaticMarkup(element);

/* 真机上抓下来的 Host 响应（夹具）。 */
const FIXTURE_PATH = join(PLUGIN_DIR, 'src', 'host', 'features', 'expander', 'fixtures', 'state.json');
if (!existsSync(FIXTURE_PATH)) {
  console.error('✗ 找不到夹具：' + FIXTURE_PATH);
  process.exit(1);
}
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const state = fixture.ok === true ? fixture : { ok: true, packages: fixture.packages ?? [], summary: fixture.summary ?? {}, job: fixture.job ?? {} };
const packages = Array.isArray(state.packages) ? state.packages : [];
const updatable = packages.filter((item) => item.updatable === true);

check('功能契约：meta / dictionaries / apply / HubView 都在', () => {
  assert.ok(expander.meta !== undefined, '缺 meta');
  assert.equal(expander.meta.id, 'expander');
  assert.equal(expander.meta.namespace, 'pluginExpander', '命名空间必须保持 pluginExpander 不变');
  assert.equal(typeof expander.meta.hubOrder, 'number');
  assert.ok(expander.dictionaries !== undefined, '缺 dictionaries');
  assert.ok(typeof expander.dictionaries.zh === 'object', '缺 zh 字典');
  assert.ok(typeof expander.dictionaries.en === 'object', '缺 en 字典');
  assert.equal(typeof expander.apply, 'function', 'apply 必须是函数');
  assert.equal(typeof expander.HubView, 'function', 'HubView 必须是函数');
  assert.ok(ui !== undefined, '缺 __ui（离线自检入口）');
});

check('字典里有 hubTab（聚合页的页签标签取自它）', () => {
  assert.equal(typeof ui.zh.hubTab, 'string');
  assert.ok(ui.zh.hubTab.length > 0);
  assert.equal(typeof expander.dictionaries.en.hubTab, 'string');
});

check('槽位注册：插件页只注册「更新」一个标签页', () => {
  const registered = [];
  const fakeCtx = {
    effect: (fn) => { fn(); return () => {}; },
    locale: {
      register: () => () => {},
      bind: () => (key) => ui.zh[key] ?? key,
    },
    slots: {
      inject: (name, callback) => {
        registered.push({ name, callback });
        return () => {};
      },
      register: (options, render) => ({ options, render }),
    },
  };
  expander.apply(fakeCtx, t);
  assert.equal(registered.length, 1, '应当只注册一个槽位（plugins.tab）');
  const tabs = registered.filter((entry) => entry.name === 'plugins.tab');
  assert.equal(tabs.length, 1, '插件页应当只有一个标签页');
  const ids = tabs.map((entry) => entry.callback().options.id);
  assert.deepEqual(ids, ['updates'], '唯一的标签页 id 必须是 updates');
  for (const tab of tabs) {
    const entry = tab.callback();
    assert.equal(entry.options.name, 'plugins.tab', '槽位 name 必须是 plugins.tab');
    assert.equal(typeof entry.options.label, 'function', 'label 必须是函数（多语言时才会变）');
  }
  assert.equal(tabs[0].callback().options.label(), ui.zh.tab);
  assert.equal(
    registered.find((entry) => entry.name === 'conversation.session.header.actions'),
    undefined,
    '不该再注册会话页头动作',
  );
});

check('更新标签页：真数据渲染不崩，且画出了插件行', () => {
  const markup = html(React.createElement(ui.UpdatesTab, { t: t, initialState: state }));
  assert.ok(markup.includes('dpe-root'), '缺根节点');
  assert.ok(markup.includes(ui.zh.title), '缺标题');
  for (const item of packages) {
    assert.ok(markup.includes(item.name), `列表里缺 ${item.name}`);
  }
  // 每条记录都画成一行 —— 少一行就意味着「某个插件没出现在列表里」。
  const rows = (markup.match(/class="dpe-row/g) || []).length;
  assert.equal(rows, packages.length, `应当画出 ${packages.length} 行，实际 ${rows} 行`);
});

check('更新标签页：有更新的插件显示新版本号与「有更新」徽标', () => {
  const markup = html(React.createElement(ui.UpdatesTab, { t: t, initialState: state }));
  for (const item of updatable) {
    assert.ok(markup.includes('有更新'), '缺「有更新」徽标');
    if (item.latest !== null && item.latest !== undefined && item.latest !== item.version) {
      assert.ok(markup.includes(String(item.latest)), `缺最新版本号 ${item.latest}`);
    }
  }
  // 夹具里必须至少有一条「有更新」的条目，否则这个断言是空转。
  assert.ok(updatable.length > 0, '夹具里没有「有更新」的条目，自检会空转');
});

check('状态文案：五种状态各归各类', () => {
  assert.equal(ui.statusText('update-available', t).text, ui.zh.statusUpdate);
  assert.equal(ui.statusText('current', t).text, ui.zh.statusCurrent);
  assert.equal(ui.statusText('ahead', t).text, ui.zh.statusAhead);
  assert.equal(ui.statusText('pinned', t).text, ui.zh.statusPinned);
  assert.equal(ui.statusText('local', t).text, ui.zh.statusLocal);
  assert.equal(ui.kindText('npm', t), ui.zh.kindNpm);
  assert.equal(ui.kindText('git', t), ui.zh.kindGit);
  assert.equal(ui.kindText('local', t), ui.zh.kindLocal);
});

check('状态徽标：每一行的徽标文案与它的状态对得上', () => {
  const markup = html(React.createElement(ui.UpdatesTab, { t: t, initialState: state }));
  for (const item of packages) {
    const expected = ui.statusText(item.status, t).text;
    assert.ok(markup.includes(expected), `${item.name} 的状态徽标应当是「${expected}」`);
  }
});

check('样式：只用主题 token，不写死颜色', () => {
  const markup = html(React.createElement(ui.Styles, null));
  const css = markup.replace(/&quot;/g, '"');
  assert.ok(css.includes('--dsw-alias-label-primary'), '缺主题 token');
  assert.ok(!/#[0-9a-f]{6}/i.test(css.replace(/&#x27;|&#39;/g, "'")), '样式里出现了写死的颜色');
  // 只允许 --dsw-alias-* 这一族：别的前缀说明用了别处定义的变量，
  // 在别的插件/主题下不一定存在（写错 token 名不会报错，只会静默不生效）。
  const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
  const notAlias = used.filter((name) => !name.startsWith('--dsw-alias-'));
  assert.deepEqual(notAlias, [], `用到了非 --dsw-alias-* 的 token：${notAlias.join(', ')}`);
});

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${passed} 项通过${failures.length === 0 ? '' : `，${failures.length} 项失败`}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n[${failure.name}]\n${failure.error.stack ?? failure.error.message}`);
  process.exitCode = 1;
}
