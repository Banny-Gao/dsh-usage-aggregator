#!/usr/bin/env node
/**
 * scripts/ui-check-autocomplete.mjs
 *
 * 「AI 自动补全」功能的离线渲染自检：用真实的 react + react-dom/server 把
 * 提示条、下拉列表与设置页视图**真渲染**一遍（node scripts/ui-check-autocomplete.mjs）。
 *
 * 为什么需要它：组件一渲染就抛异常 → 整个浮层被清空，是客户端插件最难事后
 * 定位的故障（控制台只留一行 slot entry crashed）。这里把组件渲染成 HTML
 * 字符串并断言关键内容出现 —— 等于在没有浏览器的情况下跑一遍
 * 「渲染不崩 + 画对了 + 建议条数对得上 + 设置项都在」。
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
import * as autocomplete from '../src/client/features/autocomplete/index.js';
import { setState } from '../src/client/features/autocomplete/store.js';
import { DEFAULT_SETTINGS } from '../src/host/features/autocomplete/settings.js';

// 补全组件要用 window（setTimeout / getSelection）—— Node 里没有 window，补一个最小的。
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

installRuntime((name) => {
  if (name === 'react') return React;
  if (name === 'react-dom' || name === 'react-dom/client') {
    return { createPortal: () => { throw new Error('SSR 环境不应调用 createPortal'); } };
  }
  throw new Error(`客户端只允许 require('react') / 'react-dom'，实际要了：${name}`);
});

const zh = autocomplete.dictionaries.zh;
const en = autocomplete.dictionaries.en;
const t = (key, vars) => {
  const text = zh[key] ?? key;
  return vars === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])));
};
const html = (element) => ReactDOMServer.renderToStaticMarkup(element);

/** 假的官方输入状态。 */
function fakeUseInput(draft) {
  return (selector) => selector({ draft: draft, draftRev: 1, phase: 'plain', attachmentIds: [], occurrences: [], queue: [] });
}

/** 假的官方输入动作。 */
const fakeInputActions = {
  captureInsertion: () => ({ start: 0, end: 0, revision: 1 }),
  insertText: () => true,
  setDraft: () => {},
};

check('功能契约：meta / dictionaries / apply / HubView 都在', () => {
  assert.ok(autocomplete.meta !== undefined, '缺 meta');
  assert.equal(autocomplete.meta.id, 'autocomplete');
  assert.equal(autocomplete.meta.namespace, 'pcAutocomplete');
  assert.equal(typeof autocomplete.meta.hubOrder, 'number');
  assert.equal(autocomplete.meta.hubTabKey, 'tabAutocomplete');
  assert.ok(autocomplete.dictionaries !== undefined, '缺 dictionaries');
  assert.ok(typeof autocomplete.dictionaries.zh === 'object', '缺 zh 字典');
  assert.ok(typeof autocomplete.dictionaries.en === 'object', '缺 en 字典');
  assert.equal(typeof autocomplete.apply, 'function', 'apply 必须是函数');
  assert.equal(typeof autocomplete.HubView, 'function', 'HubView 必须是函数');
});

check('中英字典的键一一对应（en 缺 key 会退回中文）', () => {
  for (const key of Object.keys(zh)) {
    assert.equal(typeof en[key], 'string', `en 字典缺 '${key}'`);
  }
  for (const key of Object.keys(en)) {
    assert.equal(typeof zh[key], 'string', `zh 字典缺 '${key}'`);
  }
});

check('提示条：没有建议时什么都不画（不打扰用户）', () => {
  const markup = html(React.createElement(autocomplete.__ui.AutocompleteDock, {
    t: t,
    sessionId: 'ui-check-empty',
    useInput: fakeUseInput('帮我'),
    inputActions: fakeInputActions,
  }));
  assert.equal(markup, '', '没有建议时不该画出提示条');
});

check('提示条：有建议时画出第一条建议与「Tab 补全」', () => {
  const sessionId = 'ui-check-bar';
  setState(sessionId, {
    settings: { ...DEFAULT_SETTINGS },
    suggestions: ['帮我查一下用量', '看看插件有没有更新'],
    activeIndex: 0,
    status: 'ready',
    open: false,
  });
  const markup = html(React.createElement(autocomplete.__ui.AutocompleteDock, {
    t: t,
    sessionId: sessionId,
    useInput: fakeUseInput('帮我'),
    inputActions: fakeInputActions,
  }));
  assert.ok(markup.includes('class="dsh-ac-bar"'), '缺提示条');
  assert.ok(markup.includes('帮我查一下用量'), '缺第一条建议');
  assert.ok(markup.includes(zh.hintTab), '缺「Tab 补全」提示');
});

check('提示条：没有关闭按钮（关闭按钮属于下拉卡片），「更多」在右侧', () => {
  const sessionId = 'ui-check-bar';
  setState(sessionId, {
    settings: { ...DEFAULT_SETTINGS },
    suggestions: ['帮我查一下用量', '看看插件有没有更新'],
    activeIndex: 0,
    status: 'ready',
    open: false,
  });
  const markup = html(React.createElement(autocomplete.__ui.AutocompleteDock, {
    t: t,
    sessionId: sessionId,
    useInput: fakeUseInput(''),
    inputActions: fakeInputActions,
  }));
  assert.ok(!markup.includes('class="dsh-ac-bar-close"'), '提示条上不该有关闭按钮（它在卡片里）');
  assert.ok(markup.includes('class="dsh-ac-bar-more"'), '缺「更多」');
});

check('下拉卡片：关闭按钮在卡片内部', () => {
  const sessionId = 'ui-check-menu';
  setState(sessionId, {
    settings: { ...DEFAULT_SETTINGS },
    suggestions: ['帮我查一下用量', '看看插件有没有更新'],
    activeIndex: 1,
    status: 'ready',
    open: true,
  });
  const markup = html(React.createElement(autocomplete.__ui.AutocompleteDock, {
    t: t,
    sessionId: sessionId,
    useInput: fakeUseInput('帮我'),
    inputActions: fakeInputActions,
  }));
  assert.ok(markup.includes('class="dsh-ac-menu"'), '缺下拉卡片');
  assert.ok(markup.includes('role="listbox"'), '缺 listbox 语义');
  const menuAt = markup.indexOf('class="dsh-ac-menu"');
  const closeAt = markup.indexOf('class="dsh-ac-menu-close"');
  assert.ok(closeAt > menuAt, '关闭按钮要在下拉卡片内部（DOM 上位于卡片之后）');
  assert.ok(markup.includes('aria-label="' + zh.close + '"'), '关闭按钮要有可读标签');
  // 「更多」在提示条右侧：靠建议文字吃掉剩余空间把它推过去。
  const textAt = markup.indexOf('class="dsh-ac-bar-text"');
  const moreAt = markup.indexOf('class="dsh-ac-bar-more"');
  assert.ok(textAt !== -1 && moreAt > textAt, '「更多」要在建议之后（行尾）');
  const source = readFileSync(join(PLUGIN_DIR, 'src', 'client', 'features', 'autocomplete', 'styles.js'), 'utf8');
  const text = /\.dsh-ac-bar-text\{[^}]*\}/.exec(source);
  assert.ok(text !== null && text[0].includes('flex:1 1 auto'), '建议文字要吃满剩余空间，才能把「更多」推到右侧');
});

check('下拉卡片挂在提示条头顶（宽度跟输入框同宽、不量坐标）', () => {
  const source = readFileSync(join(PLUGIN_DIR, 'src', 'client', 'features', 'autocomplete', 'styles.js'), 'utf8');
  const wrap = /\.dsh-ac-wrap\{[^}]*\}/.exec(source);
  assert.ok(wrap !== null, '缺 .dsh-ac-wrap 样式');
  assert.ok(wrap[0].includes('max-width:var(--dsh-composer-card-max-width)'), '外层要与输入框卡片同宽');
  assert.ok(wrap[0].includes('position:relative'), '外层要给卡片当坐标系');
  const menu = /\.dsh-ac-menu\{[^}]*\}/.exec(source);
  assert.ok(menu !== null, '缺 .dsh-ac-menu 样式');
  assert.ok(menu[0].includes('bottom:calc(100% + 6px)'), '卡片要贴在提示条头顶（6px 间隙）');
  assert.ok(!menu[0].includes('transform:translateY'), '不该再用 transform 往上推（那会飘在半空）');
});

check('浮层只画行内灰字，不再画菜单', () => {
  const sessionId = 'ui-check-closed';
  setState(sessionId, {
    settings: { ...DEFAULT_SETTINGS },
    suggestions: ['帮我查一下用量'],
    activeIndex: 0,
    status: 'ready',
    open: false,
  });
  const markup = html(React.createElement(autocomplete.__ui.AutocompleteOverlay, {
    t: t,
    sessionId: sessionId,
    useInput: fakeUseInput('帮我'),
    inputActions: fakeInputActions,
    useChat: (selector) => selector(null),
  }));
  assert.ok(!markup.includes('class="dsh-ac-menu"'), '菜单归 dock 那边，浮层里不该再画');
  assert.ok(markup.includes('class="dsh-ac-root"'), '缺浮层根节点');
});

check('设置页：推荐条数、分析模型与开关都在', () => {
  const markup = html(React.createElement(autocomplete.__ui.AutocompletePanel, {
    t: t,
    initialSettings: { ...DEFAULT_SETTINGS, provider: 'axzo-one', model: 'auto/deepseek-flash' },
    initialModels: {
      providers: [{ id: 'axzo-one', name: 'AxzoOne', models: [{ id: 'auto/deepseek-flash', name: 'auto/deepseek-flash' }] }],
      current: { provider: 'axzo-one', model: 'auto/deepseek-flash' },
    },
  }));
  assert.ok(markup.includes(zh.title) || markup.includes(zh.intro), '缺介绍');
  assert.ok(markup.includes(zh.maxSuggestions), '缺「推荐条数」');
  assert.ok(markup.includes(zh.analysisModel), '缺「分析模型」');
  assert.ok(markup.includes(zh.allowMultiline), '缺「多行输入也补全」');
  assert.ok(markup.includes(zh.inlineHint), '缺「行内灰字」');
  assert.ok(markup.includes(zh.minChars), '缺「最少字数」');
  assert.ok(markup.includes(zh.debounce), '缺「触发延迟」');
  assert.ok(markup.includes(zh.contextMessages), '缺「上下文条数」');
  assert.ok(markup.includes(zh.maxInputChars), '缺「最长输入」');
  assert.ok(markup.includes('AxzoOne'), '模型清单没进下拉');
});

check('槽位注册：只注册输入框那两个槽位，id 固定', () => {
  const registered = [];
  const fakeCtx = {
    effect: (fn) => { fn(); return () => {}; },
    locale: { register: () => () => {} },
    inject: (names, callback) => { callback({}); return () => {}; },
    slots: {
      inject: (name, callback) => {
        registered.push({ name, callback });
        return () => {};
      },
      register: (options, render) => ({ options, render }),
    },
  };
  autocomplete.apply(fakeCtx, t);
  assert.equal(registered.length, 2, `注册了 ${registered.length} 个槽位`);
  const names = registered.map((entry) => entry.name).sort();
  assert.deepEqual(names, ['conversation.input.dock', 'conversation.input.overlay']);
  const ids = registered.map((entry) => entry.callback().options.id).sort();
  assert.deepEqual(ids, ['axzo-autocomplete', 'axzo-autocomplete-bar']);
});

check('键盘接管：装在 document 捕获阶段，且认官方菜单的真实标记', () => {
  const source = readFileSync(join(PLUGIN_DIR, 'src', 'client', 'features', 'autocomplete', 'overlay.js'), 'utf8');
  assert.ok(source.includes("document.addEventListener('keydown', onKeyDown, true)"), '要装在 document 捕获阶段（才能抢在 Lexical 之前）');
  assert.ok(source.includes("closest('[data-composer-input]')"), '要从 event.target 反查编辑器，不依赖自己挂在哪儿');
  assert.ok(source.includes('[data-trigger-menu]'), '官方菜单让路要认 data-trigger-menu（它的真实标记）');
  assert.ok(!source.includes('data-conversation-composer-overlay'), '那个属性没人设置，不能拿它当判据');
});

check('灰字对齐：量「光标前一个字符的字形框」，不用折叠光标矩形', () => {
  const source = readFileSync(join(PLUGIN_DIR, 'src', 'client', 'features', 'autocomplete', 'overlay.js'), 'utf8');
  assert.ok(source.includes('function caretAnchor('), '缺 caretAnchor');
  assert.ok(!source.includes('function caretRect('), '旧的光标矩形测量要删掉（它就是错行的原因）');
  // 必须真的去量前一个字符：createRange + setStart(offset-1)
  assert.ok(source.includes('range.startOffset - 1'), '要量光标前一个字符');
  assert.ok(source.includes('rect.right'), '起点 x 取前一个字符的右边缘');
  assert.ok(source.includes('sameLine'), '要防止「光标在行首时量到上一行」');
  // 灰字盒子高度跟着字形框走
  assert.ok(source.includes("height: ghost.height + 'px'"), '灰字要给显式高度');
  assert.ok(source.includes("lineHeight: ghost.height + 'px'"), 'line-height 要等于字形框高度');
});

check('功能模块不注册 settings.section（设置入口只能有一个）', () => {
  const source = readFileSync(join(PLUGIN_DIR, 'src', 'client', 'features', 'autocomplete', 'index.js'), 'utf8');
  assert.ok(!source.includes('settings.section'), '功能模块不该注册 settings.section');
});

console.log('');
if (failures.length === 0) {
  console.log(`✓ ${passed} 项断言全部通过`);
  process.exit(0);
}
console.log(`✗ ${failures.length} 项断言未通过（共 ${passed + failures.length} 项）`);
process.exit(1);
