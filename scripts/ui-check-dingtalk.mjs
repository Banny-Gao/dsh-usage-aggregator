#!/usr/bin/env node
/**
 * scripts/ui-check-dingtalk.mjs
 *
 * 「钉钉沙发」的离线渲染自检：用真实的 react + react-dom/server 把**卡片正文**
 * 与**设置页视图**真渲染一遍（node scripts/ui-check-dingtalk.mjs）。
 *
 * 为什么需要它：组件一渲染就抛异常 → 整块卡片被清空，是客户端插件最难事后
 * 定位的故障（控制台只留一行 slot entry crashed）。这里把组件渲染成 HTML
 * 字符串并断言关键内容出现 —— 等于在没有浏览器的情况下跑一遍
 * 「渲染不崩 + 画对了 + 三个按钮都在 + 状态行对得上」。
 *
 * react 从本机 pnpm store 里取（客户端跑的就是 react 18.3.1）。找不到时**报错退出**，
 * 不静默通过 —— 静默通过等于「自检没跑但看着像跑过了」。
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';

import { installRuntime } from '../src/client/runtime.js';
import { DingtalkCardBody } from '../src/client/features/dingtalk/card.js';
import { DingtalkPanel } from '../src/client/features/dingtalk/panel.js';
import { zh } from '../src/client/features/dingtalk/i18n.js';

// 卡片正文里的 <style> 要一个 document 才能插进去 —— Node 里没有，补一个最小的。
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    head: { appendChild() {} },
    createElement: () => ({ setAttribute() {}, remove() {}, appendChild() {}, textContent: '', style: {} }),
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

/** 把 {占位} 换成值的 translator。 */
const t = (key, vars) => {
  const text = zh[key] ?? key;
  if (vars === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (_all, name) => String(vars[name] ?? ''));
};

/** 假的折叠组件（宿主的 FoldedText 在离线环境里用不着真折叠）。 */
const Folded = (props) => React.createElement('p', { className: 'folded' }, props.text);

/** 卡片提议。 */
const proposal = {
  callId: 'call-1',
  turn: 1,
  action: 'dingtalk.send',
  title: '验收示例：把结论发给验收人',
  brief: '验收用的一张示例卡片',
  details: {
    recipient: '验收示例·假人',
    recipientId: 'odt-fake-person-0001',
    channel: 'dm',
    reason: '验收三个按钮与回执回写',
    body: '结论：钉钉沙发已装进插件。\n复现步骤：设置页 → 钉钉 → 打开。',
  },
};

/**
 * 去掉 <style> 块再断言。
 *
 * 样式随组件渲染，里面也有 .dsh-dt-actions 这些类名 —— 直接在整段 HTML 上
 * 找会命中样式表，断言就分不清「元素在」还是「规则在」。
 *
 * @param {string} html 渲染结果。
 * @returns {string} 去掉样式块后的标记。
 */
function markup(html) {
  return html.replace(/<style[\s\S]*?<\/style>/g, '');
}

/** 渲染卡片正文。 */
function renderCard(decision) {
  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(DingtalkCardBody, {
      proposal,
      decision,
      sessionId: 'session-1',
      summary: React.createElement('strong', { className: 'title' }, proposal.title),
      Folded,
      act: async () => ({ status: 'accepted' }),
      t,
    })
  );
}

/* ── 卡片：未确认时的样子 ── */

const fresh = renderCard(undefined);
const freshMarkup = markup(fresh);

check('卡片渲染得出来', () => assert.ok(fresh.length > 0));
check('顶部有标题带与状态徽标', () => {
  assert.ok(freshMarkup.includes('dsh-dt-head'));
  assert.ok(freshMarkup.includes('dsh-dt-badge'));
});
check('收件人带姓名与唯一标识片段', () => {
  assert.ok(freshMarkup.includes('验收示例·假人'));
  assert.ok(freshMarkup.includes('…0001'));
});
check('写了为什么发给他', () => assert.ok(freshMarkup.includes('验收三个按钮与回执回写')));
check('拟好的正文在卡片里', () => assert.ok(freshMarkup.includes('钉钉沙发已装进插件')));
check('三个按钮都在', () => {
  assert.ok(freshMarkup.includes('>发送<'));
  assert.ok(freshMarkup.includes('改一下'));
  assert.ok(freshMarkup.includes('不用了'));
});
check('有改稿输入框', () => assert.ok(freshMarkup.includes('dsh-dt-input')));
check('主按钮是 primary', () => assert.ok(freshMarkup.includes('dsh-dt-btn is-primary')));

/* ── 卡片：已发送 / 未确认送达 / 失败 ── */

check('已发送：显示 messageId，不再给动作', () => {
  const html = markup(renderCard({ callId: 'call-1', action: 'dingtalk.send', phase: 'sent', data: { messageId: 'msg-1' } }));
  assert.ok(html.includes('已发送'));
  assert.ok(html.includes('msg-1'));
  assert.ok(!html.includes('dsh-dt-actions'));
});
check('未确认送达：明说没确认，不报成功', () => {
  const html = markup(renderCard({ callId: 'call-1', action: 'dingtalk.send', phase: 'submitted', data: { taskId: 'task-1' } }));
  assert.ok(html.includes('未确认送达'));
});
check('失败：显示原因并留着重试', () => {
  const html = markup(renderCard({ callId: 'call-1', action: 'dingtalk.send', phase: 'failed', data: { error: '本机没有装 dws 命令' } }));
  assert.ok(html.includes('本机没有装 dws 命令'));
  assert.ok(html.includes('dsh-dt-actions'));
});
check('同名多人：列出候选', () => {
  const html = markup(renderCard({
    callId: 'call-1',
    action: 'dingtalk.send',
    phase: 'ambiguous',
    data: { candidates: [{ name: '张伟', label: '张伟（…0002）', openDingTalkId: 'odt-2' }] },
  }));
  assert.ok(html.includes('dsh-dt-candidate'));
  assert.ok(html.includes('张伟'));
});

/* ── 设置页 ── */

/**
 * 渲染设置页。
 *
 * @param {object} overrides 要覆盖的状态字段。
 * @returns {string} 渲染结果。
 */
function renderPanel(overrides) {
  const base = {
    ok: true,
    enabled: true,
    settings: { enabled: true, pollIntervalSeconds: 180 },
    availability: { installed: false, version: '', path: '', loggedIn: 'unknown', installers: [] },
    install: { running: false, stage: '', method: '', ok: false, error: '' },
    unread: 2,
    baselined: true,
    lastPollAt: 0,
    lastPollCount: 0,
    lastRelevant: 0,
    lastBaselined: 3,
    lastError: '',
  };
  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(DingtalkPanel, { t, initialStatus: { ...base, ...overrides } })
  );
}

const panel = renderPanel({});

check('设置页渲染得出来', () => assert.ok(panel.length > 0));
check('设置页有开关与状态', () => {
  assert.ok(markup(panel).includes('启用'));
  assert.ok(markup(panel).includes('未读'));
});
check('没有 dws 时如实说没有', () => assert.ok(markup(panel).includes('没有 dws 命令')));

/* ── 设置页：缺 dws 时的自动安装 ── */

check('缺 dws 时给出自动安装按钮', () => {
  const html = markup(renderPanel({ availability: { installed: false, version: '', path: '', loggedIn: 'unknown', installers: [{ id: 'npm', label: 'npm 全局安装' }] } }));
  assert.ok(html.includes('自动安装 dws'), '要有安装按钮');
  assert.ok(html.includes('npm 全局'), '要说清会用哪条路');
});

check('本机没有安装器时如实说没有，并提示手动装', () => {
  const html = markup(renderPanel({ availability: { installed: false, version: '', path: '', loggedIn: 'unknown', installers: [] } }));
  assert.ok(html.includes('没找到可用的安装器'));
});

check('安装中：按钮禁用并显示进度', () => {
  const html = markup(renderPanel({
    availability: { installed: false, version: '', path: '', loggedIn: 'unknown', installers: [{ id: 'npm', label: 'npm 全局安装' }] },
    install: { running: true, stage: 'installing', method: 'npm', ok: false, error: '' },
  }));
  assert.ok(html.includes('正在装 dws'));
  assert.ok(html.includes('npm 全局'));
  assert.ok(html.includes('disabled'), '安装中按钮要禁用');
});

check('装完：报成功并说清用的哪条路', () => {
  const html = markup(renderPanel({
    availability: { installed: true, version: 'dws 1.0.99', path: '/home/u/.local/bin/dws', loggedIn: 'yes', installers: [] },
    install: { running: false, stage: 'done', method: 'npm', ok: true, error: '' },
  }));
  assert.ok(html.includes('dws 装好了'));
  assert.ok(html.includes('npm 全局'));
  assert.ok(html.includes('/home/u/.local/bin/dws'), '要显示 dws 的实际路径');
});

check('装不上：显示原因', () => {
  const html = markup(renderPanel({
    availability: { installed: false, version: '', path: '', loggedIn: 'unknown', installers: [{ id: 'npm', label: 'npm 全局安装' }] },
    install: { running: false, stage: 'failed', method: 'npm', ok: false, error: 'E404 not found' },
  }));
  assert.ok(html.includes('装不上'));
  assert.ok(html.includes('E404 not found'));
});

check('装了但没登录：提示用户自己扫码（插件不碰凭据）', () => {
  const html = markup(renderPanel({
    availability: { installed: true, version: 'dws 1.0.99', path: '', loggedIn: 'no', installers: [] },
  }));
  assert.ok(html.includes('dws auth login'), '要给出登录命令');
  assert.ok(!html.includes('自动安装 dws'), '已经装了就不该再显示安装按钮');
});

/* ───────────────────────────── 报告 ───────────────────────────── */

console.log('');
if (failures.length > 0) {
  console.error('✗ 钉钉沙发渲染自检未通过（' + failures.length + ' 项）：');
  for (const failure of failures) console.error('  - ' + failure.name + '：' + failure.error.message);
  process.exit(1);
}
console.log('✓ 钉钉沙发渲染自检通过（' + passed + ' 项）');
console.log('');
console.log('── 卡片渲染结果（未确认状态）─────────────────────────────');
console.log(fresh);
console.log('── 设置页渲染结果 ──────────────────────────────────────');
console.log(panel);
