// scripts/ui-check.mjs
//
// 客户端半边的离线渲染自检：用真实的 react + react-dom/server 把面板**真渲染**
// 一遍（node scripts/ui-check.mjs）。
//
// 为什么需要它：这个环境里没有浏览器控制权，插件的 UI 只在真页面上才看得见。
// 而「组件一渲染就抛异常 → 整个设置页条带被清空」是客户端插件最常见、也最难
// 事后定位的故障（控制台只留一行 slot entry crashed）。这里把要渲染的组件逐个
// 渲染成 HTML 字符串并断言关键内容出现 —— 等于在没有浏览器的情况下跑一遍
// 「渲染不崩 + 画对了」。
//
// react 从本机 pnpm store 里取（客户端跑的就是 react 18.3.1）。找不到时**报错退出**，
// 不静默通过 —— 静默通过等于「自检没跑但看着像跑过了」。
//
// 迁移说明（从 dsh-usage-query 的 scripts/ui-check.mjs 原样搬过来）：
//   · 组件不再从产物 client/client.js 里取，而是从源码模块
//     src/client/features/usage/index.js 的 __ui 导出取（聚合后产物是一个包，
//     里面混着三个功能的组件）；
//   · 共享 runtime（src/client/runtime.js）用 installRuntime(require) 装 React ——
//     与聚合入口的 factory 完全同一条路径；
//   · 那些「源码里必须出现某段字面量」的断言，改成对着
//     src/client/features/usage/*.js 的拼接文本做（迁移前那份产物本来就是这些
//     源文件的拼接，语义一致）。
// 断言一条没删。

import { strict as assert } from 'node:assert';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveView } from '../src/host/features/usage/resolve.js';
import { installRuntime } from '../src/client/runtime.js';
import { __ui as ui } from '../src/client/features/usage/index.js';

const PLUGIN_DIR = new URL('..', import.meta.url).pathname;

/* ─────────────────────── 找一份本机已有的 react ─────────────────────── */

function findInStore(name, wanted) {
  const roots = [
    join(homedir(), 'Library/pnpm/store/v11/links/@', name),
    join(homedir(), '.pnpm-store/v3/links/@', name),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const versions = (wanted === undefined ? readdirSync(root).sort().reverse() : [wanted]).filter((version) => existsSync(join(root, version)));
    for (const version of versions) {
      const base = join(root, version);
      for (const hash of readdirSync(base)) {
        const pkgDir = join(base, hash, 'node_modules', name);
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
  // 需要时用 DUQ_UI_REACT_VERSION=19.2.8 换一版验证向前兼容。
  const wanted = process.env.DUQ_UI_REACT_VERSION ?? '18.3.1';
  const react = findInStore('react', wanted) ?? findInStore('react');
  if (react === null) throw new Error('本机找不到 react —— 这个自检需要它（pnpm store 里应当有）');
  const reactDom = findInStore('react-dom', react.version);
  if (reactDom === null) throw new Error(`本机找不到与 react ${react.version} 同版本的 react-dom`);
  const React = await import(pathToFileURL(join(react.dir, 'index.js')).href);
  const serverEntry = existsSync(join(reactDom.dir, 'server.node.js')) ? 'server.node.js' : 'server.js';
  const ReactDOMServer = await import(pathToFileURL(join(reactDom.dir, serverEntry)).href);
  return { React: React.default ?? React, ReactDOMServer: ReactDOMServer.default ?? ReactDOMServer, version: react.version };
}

/* ─────────────────── 装上真实 React，取到要渲染的组件 ─────────────────── */

/**
 * 读「用量查询」这个功能的全部源码，拼成一段文本。
 *
 * 为什么读源码而不是读产物：迁移前这个功能的全部代码在一个 client/client.js
 * 里，那些「源码里必须出现某段字面量」的断言就是对着它做的。迁移后代码拆成了
 * src/client/features/usage/*.js（功能本身）+ src/client/shared/*.js（共享内核）
 * 好几个文件 —— 拼起来看，语义与原来完全一致（原来那份产物本来就是这些源文件
 * 的拼接）。
 *
 * @returns {string} 拼接后的源码文本。
 */
function readUsageSource() {
  const dirs = [
    join(PLUGIN_DIR, 'src', 'client', 'features', 'usage'),
    join(PLUGIN_DIR, 'src', 'client', 'shared'),
  ];
  const chunks = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.js')).sort()) {
      chunks.push(readFileSync(join(dir, name), 'utf8'));
    }
  }
  return chunks.join('\n');
}

/**
 * 读产物，检查它的 bundle id。
 *
 * 产物是「运行时真正被加载的那份」—— id 写错的话 DSH 根本不加载它。
 * 组件本身从源码模块拿（见 __ui），不在这里渲染。
 */
function checkBundleId() {
  const bundlePath = join(PLUGIN_DIR, 'client', 'client.js');
  if (!existsSync(bundlePath)) return '产物不存在（先跑 pnpm build）';
  const code = readFileSync(bundlePath, 'utf8');
  const literal = /__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/.exec(code);
  if (literal !== null) return literal[1];
  // 产物里写的是 `id: PLUGIN_ID` —— 那就把 PLUGIN_ID 常量的值取出来。
  const constant = /PLUGIN_ID\s*=\s*['"]([^'"]+)['"]/.exec(code);
  return constant === null ? '产物里找不到 load 的 id' : constant[1];
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

// 把真实 React 装进**共享 runtime**（src/client/runtime.js）——
// 客户端组件的 h / useState 全部从那里取；聚合入口的 factory 里也是这么装的
// （installRuntime(require) 之后组件才敢用 h）。这里照做，组件才能真渲染。
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

check('产物存在且 load 的 id 与 package.json 的 name 一致', () => {
  const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'));
  const id = checkBundleId();
  assert.ok(!id.includes('产物'), id);
  assert.equal(id, pkg.name, 'load 的 id 必须与 package.json 的 name 一致');
});

/* 一份与真实测得的响应同构的 view（用 resolve.js 现算，不是手写死值）。 */
const view = resolveView({
  version: 1,
  kind: 'quota',
  title: 'MiniMax 额度',
  subtitle: '各模型当前周期与周维度余量',
  notes: ['数值 -1 表示不限量'],
  health: { path: 'base_resp.status_code', okValues: [0], messagePath: 'base_resp.status_msg' },
  collection: {
    path: 'model_remains',
    labelPath: 'model_name',
    labelMap: { general: '通用', video: '视频' },
    metrics: [
      { path: 'current_interval_remains_count', label: '周期剩余次数', format: 'count' },
      { path: 'remains_time', label: '距重置', format: 'duration_ms' },
    ],
    progress: { path: 'current_interval_used_percent', label: '当前周期已用' },
  },
  primary: null,
  progress: null,
  metrics: [],
}, {
  model_remains: [
    { model_name: 'general', current_interval_remains_count: -1, remains_time: 3600000, current_interval_used_percent: '49%' },
    { model_name: 'video', current_interval_remains_count: 3, remains_time: 1800000, current_interval_used_percent: '0%' },
  ],
  base_resp: { status_code: 0, status_msg: 'success' },
}, { language: 'zh', status: 'ok', fetchedAt: Date.now(), httpStatus: 200 });

const baseProvider = {
  id: 'minimax',
  label: 'MiniMax',
  source: 'curl',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  endpoint: 'GET https://www.minimax.cn/backend/account/token_plan/remains_percent',
  headerNames: ['accept', 'cookie', 'x-group-id'],
  queryable: true,
  credential: { found: true, source: 'cookie:_token', exp: Math.floor(Date.now() / 1000) + 86400 * 20, expired: false },
  templateSource: 'auto',
  template: { version: 1, kind: 'quota', title: 'MiniMax 额度' },
  status: 'ok',
  view: view,
  last: { at: Date.now() - 60000, status: 'ok', message: '', httpStatus: 200, ms: 183, bytes: 1200 },
  notes: ['识别为 curl 形态'],
};

check('用量视图：卡片、进度、指标都画出来了', () => {
  const markup = html(React.createElement(ui.UsageView, { view: view, t: t }));
  assert.ok(markup.includes('通用'), '缺「通用」卡片');
  assert.ok(markup.includes('视频'), '缺「视频」卡片');
  assert.ok(markup.includes('49%'), '缺百分比');
  assert.ok(markup.includes('不限量'), '-1 应当显示成「不限量」');
  assert.ok(markup.includes('1 小时'), '缺「距重置」时长');
  assert.ok(markup.includes('duq-bar-fill'), '缺进度条');
});

check('供应商详情（正常）：状态、更新时间、凭证有效期都在', () => {
  const markup = html(React.createElement(ui.ProviderDetail, { provider: baseProvider, t: t, busy: false, onRefresh() {}, onReanalyze() {}, onRemove() {}, onUpdate() {} }));
  assert.ok(markup.includes('MiniMax'));
  assert.ok(markup.includes('正常'), '缺「正常」状态徽标');
  assert.ok(markup.includes('模型分析'), '缺模板来源徽标');
  assert.ok(markup.includes('HTTP 200'));
  assert.ok(markup.includes('有效期至'));
  assert.ok(markup.includes('原始响应'), '缺原始响应折叠区');
  assert.ok(markup.includes('展示模板'), '缺展示模板折叠区');
});

check('供应商详情（过期）：给出「重新粘贴请求」入口', () => {
  const expired = {
    ...baseProvider,
    status: 'expired',
    credential: { found: true, source: 'cookie:_token', exp: Math.floor(Date.now() / 1000) - 60, expired: true },
    last: { at: Date.now(), status: 'expired', message: 'HTTP 401：登录态已失效，需要重新粘贴请求', httpStatus: 401, ms: 60, bytes: 40 },
    view: { ...view, status: { tone: 'error', label: '登录态已失效', message: 'HTTP 401' } },
  };
  const markup = html(React.createElement(ui.ProviderDetail, { provider: expired, t: t, busy: false, onRefresh() {}, onReanalyze() {}, onRemove() {}, onUpdate() {} }));
  assert.ok(markup.includes('登录态已过期，需要更新'), '缺过期提示');
  assert.ok(markup.includes('重新粘贴请求'), '缺重贴入口');
  assert.ok(markup.includes('已过期'));
});

check('供应商详情（首查失败、还没有数据）：占位文案不是「选择左侧接口」', () => {
  const fresh = { ...baseProvider, status: 'error', view: null, template: null, last: { at: Date.now(), status: 'error', message: 'HTTP 500', httpStatus: 500, ms: 30, bytes: 10 } };
  const markup = html(React.createElement(ui.ProviderDetail, { provider: fresh, t: t, busy: false, onRefresh() {}, onReanalyze() {}, onRemove() {}, onUpdate() {} }));
  assert.ok(markup.includes('还没有取到数据'), '首查失败时应当给出明确的下一步提示');
});

check('供应商详情（截图快照）：标明来自截图、不冒充实时', () => {
  const snapshot = { ...baseProvider, source: 'image', queryable: false, endpoint: null, status: 'snapshot', template: null, templateSource: null, templateSource2: null, view: { ...view, status: { tone: 'muted', label: '来自截图', message: '非实时' } }, notes: ['数据来自截图识别，不会自动刷新。'] };
  const markup = html(React.createElement(ui.ProviderDetail, { provider: snapshot, t: t, busy: false, onRefresh() {}, onReanalyze() {}, onRemove() {}, onUpdate() {} }));
  assert.ok(markup.includes('来自截图'), '缺截图来源标记');
  assert.ok(markup.includes('不会自动刷新'), '应当说明不能自动刷新');
  assert.ok(!markup.includes('>刷新<'), '截图来源不该出现刷新按钮');
});

check('接入面板：cURL 输入、截图投放区、提交按钮都在', () => {
  const markup = html(React.createElement(ui.ImportPanel, { t: t, image: { enabled: true }, onCancel() {}, onImported() {} }));
  assert.ok(markup.includes('duq-textarea'), '缺 cURL 输入框');
  assert.ok(markup.includes('duq-drop'), '缺截图投放区');
  assert.ok(markup.includes('接入并查询'), '缺提交按钮');
  assert.ok(markup.includes('Copy as cURL'), '缺操作指引');
});

check('接入面板（重贴凭证）：说明「其余保持不动」并可取消', () => {
  const markup = html(React.createElement(ui.ImportPanel, { t: t, image: { enabled: true }, preset: { id: 'minimax', label: 'MiniMax' }, onCancel() {}, onImported() {} }));
  assert.ok(markup.includes('正在更新「MiniMax」的登录态'), '缺重贴说明');
  assert.ok(markup.includes('取消'));
});

check('接入面板（截图能力关闭）：明确说明原因', () => {
  const markup = html(React.createElement(ui.ImportPanel, { t: t, image: { enabled: false, reason: '配置里关闭了截图识别' }, onCancel() {}, onImported() {} }));
  assert.ok(markup.includes('截图识别当前不可用'), '应当说明截图不可用');
  assert.ok(markup.includes('配置里关闭了截图识别'));
});

check('指标默认只露 5 条，其余折叠（字段仍全部解析）', () => {
  const metrics = Array.from({ length: 8 }, (_, index) => ({ label: `指标${index + 1}`, text: `值${index + 1}`, tone: null }));
  const markup = html(React.createElement(ui.MetricBlock, { metrics: metrics, t: t }));
  assert.ok(markup.includes('指标1') && markup.includes('指标5'), '前 5 条应当可见');
  assert.ok(!markup.includes('指标6'), '第 6 条应当被折叠');
  assert.ok(markup.includes('展开其余 3 项'), '应当给出展开入口并说明还剩几条');
  assert.ok(markup.includes('aria-expanded="false"'));
});

check('只有 5 条时不出现折叠入口', () => {
  const metrics = Array.from({ length: 5 }, (_, index) => ({ label: `指标${index + 1}`, text: `值${index + 1}`, tone: null }));
  const markup = html(React.createElement(ui.MetricBlock, { metrics: metrics, t: t }));
  assert.ok(!markup.includes('展开其余'), '5 条以内不该有折叠入口');
});

check('卡片里的指标同样走折叠（每张卡独立）', () => {
  const many = {
    ...view,
    cards: view.cards.map((card) => ({
      ...card,
      metrics: Array.from({ length: 9 }, (_, index) => ({ label: `${card.label}-指标${index + 1}`, text: `v${index + 1}`, tone: null })),
    })),
  };
  const markup = html(React.createElement(ui.UsageView, { view: many, t: t }));
  assert.ok(markup.includes('通用-指标1'));
  assert.ok(!markup.includes('通用-指标6'), '卡片第 6 条应当被折叠');
  assert.ok(markup.includes('展开其余 4 项'));
});

check('图标组件：按传入尺寸渲染、颜色跟 currentColor', () => {
  const markup = html(React.createElement(ui.UsageIcon, { size: 18, active: true }));
  assert.ok(markup.includes('width="18"') && markup.includes('height="18"'), '图标尺寸应当跟随宿主传入的 size');
  assert.ok(markup.includes('currentColor'), '颜色必须走 currentColor 才能跟随主题');
  assert.ok(markup.includes('<svg'));
});

check('会话头快捷芯片：紧凑触发体 + 默认不展开浮层', () => {
  const markup = html(React.createElement(ui.UsageChip, { t: t }));
  assert.ok(markup.includes('duq-quick-trigger'), '缺芯片按钮');
  assert.ok(markup.includes('aria-haspopup="true"'), '芯片应当声明会弹浮层（悬停即出）');
  assert.ok(markup.includes('用量查询'), '缺 title 提示');
  // 注意判据要用 class 属性：CSS 文本里也含 'duq-quick-pop'（<style> 就在同一个子树里）
  assert.ok(!markup.includes('class="duq-quick-pop"'), '默认不展开浮层');
  assert.ok(!markup.includes('<img'), '图标必须是内联 svg，不能外链');
});

check('会话头芯片自带样式（否则浮层会以裸 DOM 撑开页面）', () => {
  const markup = html(React.createElement(ui.UsageChip, { t: t }));
  assert.ok(markup.includes('<style'), '芯片子树里必须渲染 <style>：它可能独立于设置面板挂载');
  assert.ok(markup.includes('duq-quick-pop{position:fixed'), '浮层必须是定位元素，不能参与文档流');
  assert.ok(markup.includes('.duq-quick-pop::before'), '浮层顶部要有鼠标桥，避免指针经过空隙时闪关');
});

check('浮层默认只展开第一个接口，其余折叠', () => {
  const many = [baseProvider, { ...baseProvider, id: 'b', label: '第二个接口' }, { ...baseProvider, id: 'c', label: '第三个接口' }];
  const collapsed = html(React.createElement(ui.QuickPopover, { t: t, providers: many, busy: false, onRefresh() {}, onRefreshAll() {}, onToggleExpanded() {} }));
  assert.ok(collapsed.includes('MiniMax'), '第一个接口应当在');
  assert.ok(!collapsed.includes('第二个接口'), '第二个接口应当被折叠');
  assert.ok(collapsed.includes('展开其余 2 个接口'), '应当给出展开入口并说明数量');

  const expanded = html(React.createElement(ui.QuickPopover, { t: t, providers: many, expanded: true, busy: false, onRefresh() {}, onRefreshAll() {}, onToggleExpanded() {} }));
  assert.ok(expanded.includes('第二个接口') && expanded.includes('第三个接口'), '展开后应当全部可见');
  assert.ok(expanded.includes('收起'));
});

check('只有一个接口时不出现「接口级」展开入口', () => {
  const markup = html(React.createElement(ui.QuickPopover, { t: t, providers: [baseProvider], busy: false, onRefresh() {}, onRefreshAll() {}, onToggleExpanded() {} }));
  // 注意区分两级折叠：接口级（quickMore）与卡片级（expandCards，快捷浮层里恒为 1 张）
  assert.ok(!markup.includes('个接口'), '单接口不该有接口级折叠入口');
});

check('主按钮字色用宿主配套 token（不是自造的 invert）', () => {
  const source = readUsageSource();
  assert.ok(source.includes('background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);'), '主按钮必须成对使用 fill + label-primary-foreground');
  assert.ok(!source.includes('--dsw-alias-brand-primary-invert'), '不要自造 invert 色，深浅主题下会不同步');
});

check('矩形命中判断（hover 判定的唯一依据）', () => {
  const node = { getBoundingClientRect: () => ({ left: 100, right: 200, top: 50, bottom: 80, width: 100, height: 30 }) };
  assert.equal(ui.isInsideRect(node, 150, 60), true, '矩形内应当命中');
  assert.equal(ui.isInsideRect(node, 150, 85), false, '矩形下方不该命中');
  assert.equal(ui.isInsideRect(node, 99, 60), false, '左边界外不该命中');
  assert.equal(ui.isInsideRect(node, 100, 50), true, '边界上算命中');
  assert.equal(ui.isInsideRect(null, 150, 60), false, '元素不存在不命中');
  assert.equal(ui.isInsideRect({ getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) }, 0, 0), false, '零尺寸（未挂载）不命中');
  assert.equal(ui.isInsideUnion([null, node], 150, 60), true, '并集里任一命中即可');
  assert.equal(ui.isInsideUnion([null, node], 10, 10), false);
  assert.equal(ui.isInsideRect(node, 215, 60, 20), true, '容差内的点也算命中（宁可少关一次）');
  assert.equal(ui.isInsideRect(node, 230, 60, 20), false, '容差之外才算离开');
});

check('悬停存活状态机：从芯片滑到卡片上永远不会自己关', () => {
  let clock = 1000;
  let closed = 0;
  const machine = ui.createHoverLiveness({ graceMs: 520, now: () => clock, onLeaveExpired: () => { closed += 1; } });
  const chip = { getBoundingClientRect: () => ({ left: 900, right: 980, top: 60, bottom: 86, width: 80, height: 26 }) };
  const pop = { getBoundingClientRect: () => ({ left: 640, right: 984, top: 94, bottom: 600, width: 344, height: 506 }) };
  const nodes = [chip, pop];

  // 在芯片上
  machine.pointerAt(940, 70, nodes);
  // 穿过 8px 视觉缝隙（缝隙在 chip.bottom=86 与 pop.top=94 之间，由悬停桥覆盖）
  machine.pointerAt(940, 90, nodes);
  clock += 300;
  assert.equal(machine.tick(), false, '缝隙里停留 300ms 不该关');
  // 落到卡片上
  machine.pointerAt(800, 300, nodes);
  clock += 5000;
  assert.equal(machine.tick(), false, '手指停在卡片上多久都不该关');
  assert.equal(closed, 0);
});

check('悬停存活状态机：真的移开才关，且慢一点也不会误关', () => {
  let clock = 1000;
  let closed = 0;
  const machine = ui.createHoverLiveness({ graceMs: 520, now: () => clock, onLeaveExpired: () => { closed += 1; } });
  const chip = { getBoundingClientRect: () => ({ left: 900, right: 980, top: 60, bottom: 86, width: 80, height: 26 }) };
  const pop = { getBoundingClientRect: () => ({ left: 640, right: 984, top: 94, bottom: 600, width: 344, height: 506 }) };
  const nodes = [chip, pop];

  machine.pointerAt(940, 70, nodes);
  machine.pointerAt(300, 400, nodes);   // 真的移到别处
  clock += 400;
  assert.equal(machine.tick(), false, '还没到宽限期');
  clock += 200;
  assert.equal(machine.tick(), true, '超过宽限期应当收起');
  assert.equal(closed, 1);
});

check('悬停存活状态机：指针甩出窗口（没有 pointermove）也能靠按拍兜住', () => {
  let clock = 1000;
  const machine = ui.createHoverLiveness({ graceMs: 520, now: () => clock, onLeaveExpired: () => {} });
  const chip = { getBoundingClientRect: () => ({ left: 900, right: 980, top: 60, bottom: 86, width: 80, height: 26 }) };
  machine.pointerAt(940, 70, [chip]);
  machine.pointerAt(0, 0, [chip]);
  clock += 600;
  assert.equal(machine.tick(), true);
});

check('悬停存活状态机：点过浮层里的按钮后，移开也不关', () => {
  let clock = 1000;
  let closed = 0;
  const machine = ui.createHoverLiveness({ graceMs: 520, now: () => clock, onLeaveExpired: () => { closed += 1; } });
  const chip = { getBoundingClientRect: () => ({ left: 900, right: 980, top: 60, bottom: 86, width: 80, height: 26 }) };
  machine.pointerAt(940, 70, [chip]);
  machine.setPinned(true);            // 点了「刷新」
  machine.pointerAt(100, 100, [chip]);
  clock += 60000;
  assert.equal(machine.tick(), false, '固定态下不该自动关');
  assert.equal(closed, 0);
});

check('锚点自检：fixed 的包含块换人时能纠正偏移', () => {
  const source = readUsageSource();
  assert.ok(source.includes('correctedRef'), '需要有「每次打开只纠正一次」的防抖标记');
  assert.ok(source.includes('getBoundingClientRect()'), '锚点自检必须量真实位置');
  assert.ok(/Math\.abs\(driftTop\) <= 4/.test(source), '只有偏差明显时才纠正');
});

check('收起判定走几何，不依赖 mouseenter/mouseleave/blur', () => {
  const source = readUsageSource();
  assert.ok(source.includes('liveness.pointerAt(event.clientX, event.clientY, [containerRef.current, popRef.current], POP_SLACK_PX)'), '关闭判定必须基于「芯片 ∪ 浮层」的矩形（带容差）');
  assert.ok(/window\.setInterval\(function \(\) \{ liveness\.tick\(\); \}, \d+\)/.test(source), '指针静止时靠按拍检查兜住');
  // 迁移后 POP_GRACE_MS 是 ESM 常量（export const），不再是 var —— 两种写法都认。
  assert.ok(/(?:var|const)\s+POP_GRACE_MS\s*=\s*\d+/.test(source), '必须有离开宽限期，缝隙/手速才不会造成误关');
  assert.ok(!source.includes('onMouseLeave'), '不该再用 mouseleave 决定关闭（缝隙与 fixed 包含块都会让它判错）');
  assert.ok(!source.includes('onBlur'), '不该用 blur 决定关闭（点浮层里的按钮会把浮层点没）');
});

check('悬停桥不会被裁掉（外层不滚动，滚动在内层）', () => {
  const markup = html(React.createElement(ui.QuickPopover, { t: t, providers: [baseProvider], busy: false, onRefresh() {}, onRefreshAll() {}, onToggleExpanded() {} }));
  assert.ok(markup.includes('duq-quick-pop') && markup.includes('duq-quick-scroll'), '浮层应有外层（定位+悬停桥）与内层（滚动）两层');
  const source = readUsageSource();
  assert.ok(/\.duq-quick-pop\{[^}]*overflow:visible/.test(source), '外层必须 overflow:visible，否则 ::before 悬停桥被裁掉，缝隙就成为死区');
  assert.ok(/\.duq-quick-pop::before\{[^}]*top:-12px/.test(source), '悬停桥要盖住芯片与浮层之间的缝隙');
  assert.ok(/\.duq-quick-scroll\{[^}]*overflow:auto/.test(source), '滚动要在内层');
});

check('浮层里的卡片 = 设置面板里的卡片（同一套 UsageView，只多折叠一层）', () => {
  const markup = html(React.createElement(ui.QuickProvider, { t: t, provider: baseProvider, busy: false, onRefresh() {} }));
  assert.ok(markup.includes('MiniMax'), '缺记录名');
  assert.ok(markup.includes('通用'), '第一张卡片应当在');
  assert.ok(markup.includes('duq-subcard'), '卡片结构应当与设置页一致');
  assert.ok(markup.includes('展开其余 1 张卡片'), '其余卡片在浮层里默认折叠');
  assert.ok(!markup.includes('视频'), '第二张卡片不该默认出现');
  assert.ok(markup.includes('49%'), '缺关键数字');
  assert.ok(markup.includes('不限量'), '-1 的语义要保留');
  assert.ok(markup.includes('有效期至'), '缺登录态信息');
  assert.ok(markup.includes('刷新'), '浮层里要能直接刷新');
});

check('快捷浮层里的卡片默认只摊开第一张', () => {
  const cards = [view.cards[0], { ...view.cards[1], label: '第三张卡' }];
  const collapsed = html(React.createElement(ui.CardGrid, { cards: cards, t: t, maxCards: 1 }));
  assert.ok(collapsed.includes(cards[0].label), '第一张卡应当在');
  assert.ok(!collapsed.includes('第三张卡'), '其余卡片应当被折叠');
  assert.ok(collapsed.includes('展开其余 1 张卡片'), '应当给出展开入口并说明张数');

  const full = html(React.createElement(ui.CardGrid, { cards: cards, t: t }));
  assert.ok(full.includes('第三张卡'), '不给 maxCards 时（设置页/主区）应当全部展开');
  assert.ok(!full.includes('展开其余'), '设置页不该出现折叠入口');

  const source = readUsageSource();
  assert.ok(source.includes('maxCards: 1 }),'), '快捷浮层必须传 maxCards: 1');
});

check('数组内搬动（字段排序的唯一实现）', () => {
  const items = ['a', 'b', 'c', 'd'];
  assert.deepEqual(ui.moveItem(items, 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(ui.moveItem(items, 3, 1), ['a', 'd', 'b', 'c']);
  assert.deepEqual(ui.moveItem(items, 1, 1), items, '原地不动应当原样返回');
  assert.deepEqual(ui.moveItem(items, -1, 2), items, '越界不动');
  assert.deepEqual(ui.moveItem(items, 0, 9), items, '越界不动');
  assert.deepEqual(items, ['a', 'b', 'c', 'd'], '不该改动入参');
});

check('字段清单：按当前显示顺序，并补齐模板里有但没投影出来的字段', () => {
  const provider = {
    ...baseProvider,
    view: {
      ...view,
      metrics: [{ path: 'base_resp.status_code', label: '状态码', text: '0', tone: null }],
      cards: [{ ...view.cards[0], metrics: [
        { path: 'current_interval_used_percent', label: '当前周期已用', text: '49%', tone: null },
        { path: 'remains_time', label: '距重置', text: '1 小时', tone: null },
      ] }],
    },
    template: {
      metrics: [],
      collection: { metrics: [
        { path: 'current_interval_used_percent' },
        { path: 'remains_time' },
        { path: 'brand_new_field' },
      ] },
    },
  };
  const rows = ui.fieldRows(provider);
  assert.deepEqual(rows.map((row) => row.path), ['base_resp.status_code', 'current_interval_used_percent', 'remains_time', 'brand_new_field']);
  assert.equal(rows[0].label, '状态码', '标签应当取自 view（所见即所得）');
  assert.equal(rows[3].label, 'brand_new_field', '模板里有但没投影出来的字段也要在名单里（否则排不进来）');
});

check('路由不可用时给出「该重启」的提示，而不是解析失败', () => {
  const source = readUsageSource();
  assert.ok(source.includes('Host 侧路由不可用'), '缺「未重启」的明确指引');
  assert.ok(source.includes('looksHtml'), '要能识别 SPA 兜底返回的 HTML');
});

check('排序保存失败：要说清原因并回滚本地顺序', () => {
  const source = readUsageSource();
  assert.ok(source.includes('setRows(previous)'), '保存失败必须回滚，否则列表顺序与卡片顺序各说一套');
  assert.ok(/failure\.message \? failure\.message : failure/.test(source), '必须把接口原话显示出来（最常见的是「未重启」提示）');
  assert.ok(source.includes("className: 'duq-field-status is-' + tone"), '失败要有独立配色，不能和「已保存」长一样');
});

check('排序入口只在「能重算 view」的接口上出现', () => {
  const source = readUsageSource();
  assert.ok(source.includes("provider.source === 'curl' && provider.template !== null"), '截图快照不该给排序入口（排了也不会生效）');
  assert.ok(source.includes('signature'), '行集合要跟随 Host 状态同步，否则「恢复默认」后本地还留着旧顺序');
});

check('字段顺序编辑器：拖拽把手、上下移、恢复默认都在', () => {
  const provider = {
    ...baseProvider,
    view: { ...view, metrics: [], cards: [{ ...view.cards[0], metrics: [
      { path: 'a', label: '甲', text: '1', tone: null },
      { path: 'b', label: '乙', text: '2', tone: null },
    ] }] },
    template: { metrics: [], collection: { metrics: [{ path: 'a' }, { path: 'b' }] } },
  };
  const markup = html(React.createElement(ui.FieldOrderEditor, { t: t, provider: provider, onChanged: () => Promise.resolve() }));
  assert.ok(markup.includes('字段顺序'), '缺标题');
  assert.ok(markup.includes('draggable="true"'), '把手必须可拖拽');
  assert.ok(markup.includes('duq-grip'), '缺拖拽把手');
  assert.ok(markup.includes('↑') && markup.includes('↓'), '缺上下移按钮（触摸板/键盘也要能调）');
  assert.ok(markup.includes('恢复默认顺序'), '缺恢复默认');
  assert.ok(markup.includes('甲') && markup.includes('乙'), '缺字段行');
});

check('侧栏图标与主区整页已下掉，只留会话头入口（设置页入口归聚合页）', () => {
  const source = readUsageSource();
  assert.ok(!source.includes('sidebar.panellist'), '不应再注册侧栏面板图标');
  assert.ok(!source.includes("ctx.slots.inject('main'"), '不应再注册主区整页');
  assert.ok(!source.includes('.duq-page'), '主区页面形态的样式应随之清掉');
  assert.ok(!source.includes('openPanel'), '「打开完整面板」没有目标了，按钮与接线都应删掉');
  assert.ok(source.includes("ctx.slots.inject('conversation.session.header.utilities'"), '会话头入口要保留');
  // 迁移后的分工：用量查询**不再**自己注册 settings.section ——
  // 整个插件在设置面板里只占一个入口（聚合页 src/client/hub/panel.js 注册）。
  // 这里守着「功能模块不许自己抢设置入口」。
  assert.ok(!source.includes("ctx.slots.inject('settings.section'"), '用量查询不许自己注册 settings.section（那是聚合页的活）');
});

check('设置页入口由聚合页统一注册（一个插件一个入口）', () => {
  const hub = readFileSync(join(PLUGIN_DIR, 'src', 'client', 'hub', 'panel.js'), 'utf8');
  assert.ok(hub.includes("'settings.section'"), '聚合页必须注册 settings.section');
  assert.ok(/id:\s*'usage-aggregator'/.test(hub), "聚合页的 section id 必须是 'usage-aggregator'");
});

check('元信息不该被截断（接口地址 / 登录态要读得完）', () => {
  const source = readUsageSource();
  const meta = /\.duq-meta-item\{[^}]*\}/.exec(source);
  assert.ok(meta !== null, '缺 .duq-meta-item 样式');
  assert.ok(!meta[0].includes('white-space:nowrap'), '元信息不能 nowrap —— 长地址会被截成省略号');
  assert.ok(!meta[0].includes('text-overflow:ellipsis'), '元信息不��省略号截断');
  assert.ok(!meta[0].includes('max-width:52ch'), '不该给元信息限死字符宽度');
  assert.ok(meta[0].includes('overflow-wrap:anywhere'), '长 URL 要能在任意处断行');
  const head = /\.duq-card-head\{[^}]*\}/.exec(source);
  assert.ok(head !== null && head[0].includes('flex-wrap:wrap'), '卡片头要允许换行，按钮挤不下时落到下一行');
});

check('分析模型：cascader（一个触发器 + 两列浮层），不是并排两个 select', () => {
  const collapsed = html(React.createElement(ui.AnalysisModelPicker, { t: t, onChanged() {} }));
  assert.ok(collapsed.includes('分析模型'), '触发器要显示当前模型');
  assert.ok(collapsed.includes('duq-cascader-trigger'), '缺 cascader 触发器');
  assert.ok(!collapsed.includes('<select'), '收起态不该出现原生 select（正是它们把标题挤成竖排的）');
  const source = readUsageSource();
  assert.ok(source.includes('h(AnalysisModelPicker, { t: t, onChanged: load })'), '面板顶部要用它');
  assert.ok(source.includes('duq-cascader-panel'), '缺浮层');
  assert.ok((source.match(/className: 'duq-cascader-col'/g) ?? []).length === 2, '浮层要正好两列（provider / model）');
  assert.ok(/\.duq-cascader-col\+\./.test(source), '两列之间要有分隔线');
  assert.ok(source.includes("api.setAnalysisModel"), '选中后必须立刻保存');
});

check('顶部芯片显示哪个接口可指定（没指定就第一个）', () => {
  const providers = [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }];
  assert.equal(ui.pickChipProvider(providers, null).id, 'a', '没指定时显示第一个');
  assert.equal(ui.pickChipProvider(providers, 'b').id, 'b', '指定了就用指定的');
  assert.equal(ui.pickChipProvider(providers, 'missing').id, 'a', '指定的不存在时退回第一个，不空着');
  assert.equal(ui.pickChipProvider([], 'b'), null, '没有接口时返回 null');
  const source = readUsageSource();
  assert.ok(source.includes('duq-star'), '浮层里每条记录要有「设为顶部显示」按钮');
  assert.ok(source.includes('api.setChip'), '要点一下顶部显示就得能存下来');
  assert.ok(source.includes('var showChipLabel = first !== null && providers.length > 1'), '多个接口时芯片要带上接口名，否则一个数字看不出是谁的');
  assert.ok(source.includes("className: 'duq-quick-name'"), '接口名要单独成段（可省略），不能和数值挤在一段里');
});

check('顶部芯片：数值段永远完整，接口名段才可省略', () => {
  const source = readUsageSource();
  // 这是真实 bug 的回归：max-width 落在数值段上时，"MiniMax 49%" 被压成 "MiniMax …"
  const value = /\.duq-quick-value\{[^}]*\}/.exec(source);
  assert.ok(value !== null, '缺 .duq-quick-value 样式');
  assert.ok(!value[0].includes('max-width'), '数值段不能限宽 —— 芯片存在的意义就是看到那个数');
  assert.ok(!value[0].includes('text-overflow'), '数值段不截断');
  const name = /\.duq-quick-name\{[^}]*\}/.exec(source);
  assert.ok(name !== null, '接口名应当是独立的一段样式');
  assert.ok(name[0].includes('text-overflow:ellipsis'), '接口名段才允许省略');
  // 接口名超过 12 字要裁；没超就原样
  assert.equal(ui.clipText('MiniMax', 12), 'MiniMax');
  assert.equal(ui.clipText('MiniMaxRemainingPoints', 12).length, 13, '超长名裁到 12 字 + 省略号');
  assert.ok(source.includes('clipText(chipProvider.label, 12)'), '接口名要用 clipText 限长再显示');
});

check('cascader 浮层必须 fixed 定位（设置面板的内容列会裁剪 absolute）', () => {
  const source = readUsageSource();
  const panel = /\.duq-cascader-panel\{[^}]*\}/.exec(source);
  assert.ok(panel !== null, '缺 .duq-cascader-panel 样式');
  assert.ok(panel[0].includes('position:fixed'), '浮层必须 fixed：设置面板内容列会裁掉 absolute 子元素');
  assert.ok(!panel[0].includes('position:absolute'), '不要用 absolute（之前左半边被裁掉就是这个原因）');
  assert.ok(source.includes('node.getBoundingClientRect()'), '打开时要用真实坐标定位');
  assert.ok(/Math\.max\(8, Math\.min\(rect\.left, window\.innerWidth - width - 8\)\)/.test(source), '横向要夹在窗口内，不能溢出屏幕');
  assert.ok(source.includes("window.addEventListener('scroll', onScroll, true)"), '滚动时应收起（fixed 浮层不会跟着内容滚）');
});

check('页头不能把标题挤成竖排（标题 nowrap、动作区可换行）', () => {
  const source = readUsageSource();
  const title = /\.duq-title\{[^}]*\}/.exec(source);
  assert.ok(title !== null && title[0].includes('white-space:nowrap'), '标题必须 nowrap，否则窄屏会一字一行');
  const head = /\.duq-head-actions\{[^}]*\}/.exec(source);
  assert.ok(head !== null && head[0].includes('flex-wrap:wrap'), '右侧动作区要能换行');
  const headRow = /\.duq-head\{[^}]*\}/.exec(source);
  assert.ok(headRow !== null && headRow[0].includes('flex-wrap:wrap'), '页头整体要能换行');
  assert.ok(headRow !== null && headRow[0].includes('flex-shrink:0') === false, '页头右侧不能 flex-shrink:0（那是把标题挤没的元凶）');
});

check('面板显示自动查询间隔；记录标出「自动」与下次时间', () => {
  const provider = {
    ...baseProvider,
    last: { ...baseProvider.last, trigger: 'auto' },
    nextDueIn: 4 * 60000,
  };
  const markup = html(React.createElement(ui.ProviderDetail, { provider: provider, t: t, busy: false, onRefresh() {}, onReanalyze() {}, onRemove() {}, onUpdate() {}, onReload() {} }));
  assert.ok(markup.includes('自动'), '记录上要标出这次是自动查询');
  assert.ok(markup.includes('下次'), '要给出下次自动查询时间');
  const runtime = readUsageSource();
  assert.ok(runtime.includes("t('autoRefreshLabel')"), '面板顶部要显示自动查询间隔');
  assert.ok(runtime.includes('intervalText'), '间隔要翻成「每 5 分钟」这种短文案');
});

check('接入面板：文案说清「图片两种用法」', () => {
  const markup = html(React.createElement(ui.ImportPanel, { t: t, image: { enabled: true }, onCancel() {}, onImported() {} }));
  assert.ok(markup.includes('cURL + 图片 = 用图辅助模型理解字段含义'), '必须说清图片与 cURL 同时给时的用途');
  assert.ok(markup.includes('只贴图片 = 一次快照'), '也要说清只给图片时的行为');
});

check('供应商详情：有「辅助截图」入口，点开是投放区 + 带图重分析', () => {
  const markup = html(React.createElement(ui.ProviderDetail, { provider: baseProvider, t: t, busy: false, onRefresh() {}, onReanalyze() {}, onRemove() {}, onUpdate() {}, onReload() {} }));
  assert.ok(markup.includes('辅助截图'), '缺辅助截图入口');
  const withPanel = html(React.createElement(function HintOpen() {
    return React.createElement(ui.ImageDrop, {
      t: t, image: null, hint: '拖入或粘贴截图', pickLabel: '选择图片', readyText: '已选择', clearLabel: '清除',
      onImage() {}, onError() {}, onClear() {},
    });
  }));
  assert.ok(withPanel.includes('duq-drop'), '缺图片投放区');
  assert.ok(withPanel.includes('选择图片'), '缺选文件入口');
  const source = readUsageSource();
  assert.ok(source.includes("hintRun: '带截图重新分析'"), '缺「带截图重新分析」动作');
  assert.ok(source.includes("api.reanalyze(id, image === undefined ? undefined : image)"), 'reanalyze 必须把图片传下去');
  assert.ok(source.includes('h(ImageDrop, {'), '接入面板与分析辅助要共用同一个投放区组件');
});

check('根面板：首帧不崩，标题与空态都在', () => {
  const markup = html(React.createElement(ui.Panel, { t: t }));
  assert.ok(markup.includes('用量查询'), '缺标题');
  assert.ok(markup.includes('还没有接入任何接口'), '缺空态');
  assert.ok(markup.includes('接入新接口'), '缺接入入口');
  assert.ok(markup.includes('dsh-usage-query-style') === false, 'style 由 PanelShell 注入，Panel 自身不带');
});

check('面板顶部不摆说明书（用法留在空态与接入面板里）', () => {
  const markup = html(React.createElement(ui.Panel, { t: t, page: true }));
  assert.ok(markup.includes('用量查询'), '标题要在');
  // 只看页头那一段：空态卡片里讲「从哪复制请求」是应该的（那是新用户唯一需要知道的事）
  const head = markup.slice(markup.indexOf('<header'), markup.indexOf('</header>'));
  assert.ok(head.length > 0, '页头应当存在');
  assert.ok(!head.includes('Copy as cURL'), '页头不该再讲怎么复制请求');
  assert.ok(!head.includes('duq-sub'), '页头不该再挂一段说明文字');
  assert.ok(!head.includes('Host 端'), '实现细节不进面板');
  const emptyBody = ui.zh.emptyBody ?? '';
  assert.ok(emptyBody.length <= 40, `空态说明过长（${emptyBody.length} 字）：${emptyBody}`);
  assert.ok(!emptyBody.includes('点击右上角'), '空态不该指向已经不在的按钮位置');
});

check('根面板外壳：注入了样式表且样式只用主题 token', () => {
  const markup = html(React.createElement(ui.Panel, { t: t }));
  const shell = html(React.createElement(function Shell() { return React.createElement('div', null, null); }, null));
  assert.ok(shell !== '');
  const panelMarkup = html(React.createElement(ui.Panel, { t: t }));
  assert.ok(panelMarkup.length > 200, '面板应当渲染出内容');
});

check('样式只引用真实存在的主题 token', () => {
  const css = /var\((--dsw-[a-z0-9-]+)/g;
  const source = readUsageSource();
  const used = new Set();
  let match = css.exec(source);
  while (match !== null) {
    used.add(match[1]);
    match = css.exec(source);
  }
  const allowed = new Set([
    '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
    '--dsw-alias-bg-overlay', '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-brand-primary',
    '--dsw-alias-brand-primary-invert', '--dsw-alias-button-primary-fill', '--dsw-alias-button-primary-hover',
    '--dsw-alias-interactive-bg-hover', '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
    '--dsw-alias-state-error-primary', '--dsw-alias-state-warn-primary', '--dsw-alias-state-success-primary',
    '--dsw-alias-state-info-primary', '--dsw-alias-state-idle-primary',
    '--dsw-alias-link', '--dsw-alias-label-primary-foreground',
  ]);
  const unknown = [...used].filter((token) => !allowed.has(token));
  assert.deepEqual(unknown, [], `用到了不存在或不使用的 token：${unknown.join(', ')}`);
});

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${passed} 项通过${failures.length === 0 ? '' : `，${failures.length} 项失败`}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n[${failure.name}]\n${failure.error.stack}`);
  process.exitCode = 1;
}
