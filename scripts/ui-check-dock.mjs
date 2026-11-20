#!/usr/bin/env node
/**
 * scripts/ui-check-dock.mjs
 *
 * 悬浮栏（dock）的离线渲染自检：把这条栏真渲染一遍，并守住它与各功能之间的契约
 * （node scripts/ui-check-dock.mjs）。
 *
 * 为什么单独一个脚本：悬浮栏是**共享层**的东西（src/client/shared/dock.js）——
 * 小火箭、钉钉入口都登记进它。它一旦坏了，坏的是两个功能的入口，所以它的契约
 * 不能只挂在某一个功能的自检里。
 *
 * 这里守三件事：
 *   1. 渲染不崩，且几个入口确实在**同一条栏**里（不是一个一个散在页面上）；
 *   2. 栏的样式与行为约定：默认右下角、能拖、位置记住、一次只展开一个；
 *   3. 架构约束：共享层不许 import 任何一个功能（功能之间零 import）。
 *
 * react 从本机 pnpm store 里取（客户端跑的就是 react 18.3.1）。找不到时**报错退出**，
 * 不静默通过 —— 静默通过等于「自检没跑但看着像跑过了」。
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installRuntime } from '../src/client/runtime.js';
import { DockHost, registerDockEntry } from '../src/client/shared/dock.js';

const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url));

// SSR 里 effect 不会跑，但保险起见给个最小的 window。
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener() {},
    removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    innerWidth: 1440,
    innerHeight: 900,
  };
}

/* ─────────────────────── 找一份本机已有的 react ─────────────────────── */

// react 在哪，各平台不一样（pnpm store 的位置、DSH profile、仓库 node_modules），
// 查找逻辑统一放在 scripts/react-host.mjs 里。
const { loadReact } = await import('./react-host.mjs');

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

installRuntime((name) => {
  if (name === 'react') return React;
  if (name === 'react-dom' || name === 'react-dom/client') {
    return { createPortal: () => { throw new Error('SSR 环境不应调用 createPortal'); } };
  }
  throw new Error(`客户端只允许 require('react') / 'react-dom'，实际要了：${name}`);
});

const html = (element) => ReactDOMServer.renderToStaticMarkup(element);

// 登记两个假条目 —— 就像小火箭与钉钉入口那样。
const entries = [
  { id: 'fake-a', order: 30, label: 'A' },
  { id: 'fake-b', order: 31, label: 'B' },
];
for (const entry of entries) {
  registerDockEntry({
    id: entry.id,
    order: entry.order,
    t: (key) => key,
    Component: function (props) {
      return React.createElement(
        'span',
        { className: 'fake-entry', 'data-open': props.open ? 'yes' : 'no' },
        entry.label
      );
    },
  });
}

const dockSource = readFileSync(join(PLUGIN_DIR, 'src', 'client', 'shared', 'dock.js'), 'utf8');
const dockStyleSource = readFileSync(join(PLUGIN_DIR, 'src', 'client', 'shared', 'dock-style.js'), 'utf8');

check('悬浮栏渲染得出来', () => {
  const markup = html(React.createElement(DockHost, { slotProps: null }));
  assert.ok(markup.length > 0, '渲染结果为空');
  assert.ok(markup.includes('dsh-dock-rail'), '缺那条栏');
});

check('几个入口在同一条栏里（不是散落的按钮）', () => {
  const markup = html(React.createElement(DockHost, { slotProps: null }));
  const rails = markup.match(/class="dsh-dock-rail"/g) ?? [];
  assert.equal(rails.length, 1, `栏应该只有一条（实际 ${rails.length} 条）`);
  assert.ok(markup.includes('fake-entry'), '入口没画出来');
  assert.equal((markup.match(/class="fake-entry"/g) ?? []).length, 2, '两个入口都要在');
});

check('入口按 order 排序', () => {
  const markup = html(React.createElement(DockHost, { slotProps: null }));
  const first = markup.indexOf('>A<');
  const second = markup.indexOf('>B<');
  assert.ok(first >= 0 && second > first, '顺序不对（order 小的该在前）');
});

check('样式随组件渲染，不塞进 document.head', () => {
  const markup = html(React.createElement(DockHost, { slotProps: null }));
  assert.ok(markup.includes('data-dsh-usage-aggregator="dock"'), '缺样式标签');
});

check('栏默认停在右下角', () => {
  assert.ok(dockStyleSource.includes('.dsh-dock{position:fixed;right:24px;bottom:24px;'), '默认位置不是右下角');
});

check('栏能拖，且位置记住（localStorage）', () => {
  assert.ok(dockSource.includes('onPointerDown'), '没有拖拽处理');
  assert.ok(dockSource.includes('onPointerMove'), '拖拽没有跟手');
  assert.ok(dockSource.includes('dsh-usage-aggregator:dock:pos'), '位置没记住');
});

check('拖拽不许用 setPointerCapture（那会把点击改派给容器，按钮点不动）', () => {
  // 指针捕获在容器上时，浏览器把随后那记 click 也改派给容器（兼容鼠标事件跟着
  // 捕获目标走），按钮自己的 onClick 永远收不到 —— 实测「点图标没反应」。
  // 实测方式：无头 Chrome + CDP 派发真实鼠标事件，捕获版 clicked=false，
  // 改用 window 监听 clicked=true。
  // 只查**调用**（注释里提到这个名字不算）。
  assert.ok(!/\.setPointerCapture\s*\(/.test(dockSource), '容器上不能捕获指针');
  assert.ok(dockSource.includes("window.addEventListener('pointermove'"), '拖拽要改在 window 上跟手');
});

check('一次只展开一个面板', () => {
  assert.ok(dockSource.includes('current === id ? null : id'), '展开状态没有做成互斥');
});

check('面板里的点击不会被当成拖栏', () => {
  assert.ok(dockSource.includes('data-dock-panel'), '面板没有标记出来（拖拽会误触发）');
});

check('共享层不 import 任何一个功能（功能之间零 import）', () => {
  assert.ok(!dockSource.includes('features/'), '共享层不许 import 功能');
  assert.ok(!dockStyleSource.includes('features/'), '共享层不许 import 功能');
});

check('条目可以注销', () => {
  const dispose = registerDockEntry({
    id: 'fake-c',
    order: 32,
    t: (key) => key,
    Component: function () { return React.createElement('span', null, 'C'); },
  });
  let markup = html(React.createElement(DockHost, { slotProps: null }));
  assert.ok(markup.includes('>C<'), '登记后没画出来');
  dispose();
  markup = html(React.createElement(DockHost, { slotProps: null }));
  assert.ok(!markup.includes('>C<'), '注销后还在');
});

console.log('');
if (failures.length === 0) {
  console.log(`✓ 悬浮栏自检通过（${passed} 项）`);
  process.exit(0);
}
console.error(`✗ 悬浮栏自检未通过（${failures.length} 项）：`);
for (const failure of failures) console.error(`  - ${failure.name}：${failure.error.message}`);
process.exit(1);
