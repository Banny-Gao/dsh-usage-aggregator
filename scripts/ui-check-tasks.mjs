#!/usr/bin/env node
/**
 * scripts/ui-check-tasks.mjs
 *
 * 侧栏工作区任务徽标的逻辑自检（node scripts/ui-check-tasks.mjs）。
 *
 * 为什么单独写：这个逻辑是**纯状态机**（会话 running / 完成 / 在等你 → 徽标），
 * 却在页面上才看得见 —— 一旦判错，表现只是「徽标颜色不对」，没有任何报错，
 * 事后极难定位。所以在这里用假的会话列表 + 假的官方 sessionStatus 快照，
 * 把每一条判定都跑一遍。
 *
 * 覆盖的场景（每一条都对应一次真实踩坑）：
 *   1. 任务正常跑完 → 绿色「完成」徽标（不是琥珀色叹号）
 *   2. 当前会话（你正看着的那个）跑完 → 也要报完成
 *      —— DSH 的 completionUnread 对当前会话不置位，只能靠 running 边沿
 *   3. 会话在等你（审批 / 提问）→ 琥珀「需要关注」，且**不是**完成
 *   4. 子代理的完成 / 等待**不**进统计（只算主代理 Lead）
 *   5. 页面加载时历史已空闲的会话 → 不刷徽标
 *   6. 点掉徽标后不会立刻重现
 *   7. 同一个会话重新开跑、再完成 → 能再次报完成
 */

import { strict as assert } from 'node:assert';

import { TASK, recomputeTaskState, setTaskStatuses } from '../src/client/features/theme/tasks.js';

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

/** 造一个会话摘要。 */
function session(id, cwd, extra = {}) {
  return { id, cwd, running: false, blank: false, displayTitle: id, ...extra };
}

/** 造一个官方 status 条目。 */
function status(running, pendingInteraction = undefined, completionUnread = false) {
  return { running, pendingInteraction, completionUnread };
}

/** 清空状态机并装入一批会话。 */
function setup(sessions, statuses) {
  TASK._lastById = {};
  for (const s of sessions) TASK._lastById[s.id] = s;
  TASK.statuses = statuses === undefined ? null : statuses;
  TASK.runningIds = {};
  TASK.completionUnreadIds = {};
  TASK.dismissedKeys = {};
  TASK.attentionItems = {};
  TASK.markKeys = [];
  TASK.attentionKeys = [];
  TASK.runKeys = [];
  TASK.busy = false;
  recomputeTaskState();
}

console.log('→ 侧栏任务徽标逻辑');

check('正常跑完 → 绿色「完成」徽标（不是琥珀叹号）', () => {
  setup([session('a', '/w/alpha')]);
  // 第一拍：在跑
  setTaskStatuses(new Map([['a', status(true)]]));
  recomputeTaskState();
  assert.deepEqual(TASK.markKeys, [], '还在跑不该有徽标');
  assert.deepEqual(TASK.attentionKeys, [], '还在跑不该有「需要关注」');
  assert.deepEqual(TASK.runKeys, ['alpha'], '应该标记「在跑」');

  // 第二拍：跑完了
  setTaskStatuses(new Map([['a', status(false)]]));
  recomputeTaskState();
  assert.deepEqual(TASK.markKeys, ['alpha'], '正常完成应挂「完成」徽标');
  assert.deepEqual(TASK.attentionKeys, [], '正常完成不该挂「需要关注」徽标');
});

check('当前会话跑完（completionUnread 恒 false）也报完成', () => {
  setup([session('a', '/w/alpha')]);
  setTaskStatuses(new Map([['a', status(true)]]));
  recomputeTaskState();
  // DSH 只对「你正看着的会话之外」的会话置 completionUnread —— 这里模拟主会话
  setTaskStatuses(new Map([['a', status(false, undefined, false)]]));
  recomputeTaskState();
  assert.deepEqual(TASK.markKeys, ['alpha'], '主会话完成也要报完成（靠 running 边沿）');
});

check('DSH 的 completionUnread 边沿也算完成', () => {
  setup([session('a', '/w/alpha')]);
  setTaskStatuses(new Map([['a', status(true)]]));
  recomputeTaskState();
  setTaskStatuses(new Map([['a', status(false, undefined, true)]]));
  recomputeTaskState();
  assert.deepEqual(TASK.markKeys, ['alpha'], 'completionUnread 翻 true 应报完成');
});

check('在等你（pendingInteraction）→ 琥珀「需要关注」，且不是完成', () => {
  setup([session('a', '/w/alpha')]);
  setTaskStatuses(new Map([['a', status(true)]]));
  recomputeTaskState();
  setTaskStatuses(new Map([['a', status(false, { key: 'p1', kind: 'approval', sessionId: 'a' })]]));
  recomputeTaskState();
  assert.deepEqual(TASK.attentionKeys, ['alpha'], '等你处理应挂「需要关注」徽标');
  assert.deepEqual(TASK.markKeys, [], '等你处理不该同时挂「完成」徽标');
});

check('子代理不进入统计（origin=subagent / parentId）', () => {
  setup([
    session('lead', '/w/alpha'),
    session('child', '/w/alpha', { origin: 'subagent' }),
    session('child2', '/w/alpha', { parentId: 'lead' }),
  ]);
  setTaskStatuses(new Map([
    ['lead', status(true)],
    ['child', status(true)],
    ['child2', status(true)],
  ]));
  recomputeTaskState();
  assert.deepEqual(TASK.runKeys, ['alpha'], '只有主代理算「在跑」');

  // 子代理跑完 → 不该惊动工作区行
  setTaskStatuses(new Map([
    ['lead', status(true)],
    ['child', status(false, undefined, true)],
    ['child2', status(false, undefined, true)],
  ]));
  recomputeTaskState();
  assert.deepEqual(TASK.markKeys, [], '子代理完成不应产生「完成」徽标');
});

check('页面加载时历史已空闲的会话不刷徽标', () => {
  setup([session('old', '/w/alpha')]);
  setTaskStatuses(new Map([['old', status(false)]]));
  recomputeTaskState();
  assert.deepEqual(TASK.markKeys, [], '加载时不该把历史会话刷成「完成」');
  assert.deepEqual(TASK.attentionKeys, [], '加载时不该挂「需要关注」');
});

check('点掉徽标后不会立刻重现', () => {
  setup([session('a', '/w/alpha')]);
  setTaskStatuses(new Map([['a', status(true)]]));
  recomputeTaskState();
  setTaskStatuses(new Map([['a', status(false, undefined, true)]]));
  recomputeTaskState();
  assert.deepEqual(TASK.markKeys, ['alpha'], '先报一次完成');

  // 用户点掉徽标：markKeys 清空，但边沿状态不动
  TASK.markKeys = [];
  recomputeTaskState();
  assert.deepEqual(TASK.markKeys, [], '清掉后不该立刻又冒出来');
});

check('重新开跑再完成 → 能再次报完成', () => {
  setup([session('a', '/w/alpha')]);
  setTaskStatuses(new Map([['a', status(true)]]));
  recomputeTaskState();
  setTaskStatuses(new Map([['a', status(false, undefined, true)]]));
  recomputeTaskState();
  assert.deepEqual(TASK.markKeys, ['alpha'], '第一次完成');

  TASK.markKeys = [];
  // 重新开跑：DSH 会清掉 completionUnread
  setTaskStatuses(new Map([['a', status(true)]]));
  recomputeTaskState();
  // 再跑完
  setTaskStatuses(new Map([['a', status(false, undefined, true)]]));
  recomputeTaskState();
  assert.deepEqual(TASK.markKeys, ['alpha'], '第二轮完成应再次报出来');
});

check('没有官方状态快照时降级：只认 running 边沿，不误报「需要关注」', () => {
  setup([session('a', '/w/alpha')], null);
  TASK.statuses = null;
  recomputeTaskState();
  assert.deepEqual(TASK.attentionKeys, [], '没有状态源时不该凭空挂「需要关注」');
  assert.deepEqual(TASK.markKeys, [], '没有状态源时不该凭空挂「完成」');
});

check('子代理的「在等你」也不进统计', () => {
  setup([session('lead', '/w/alpha'), session('child', '/w/alpha', { origin: 'subagent' })]);
  setTaskStatuses(new Map([
    ['lead', status(false)],
    ['child', status(false, { key: 'p1', kind: 'approval', sessionId: 'child' })],
  ]));
  recomputeTaskState();
  assert.deepEqual(TASK.attentionKeys, [], '子代理的等待不应惊动工作区行');
});

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${passed} 项通过${failures.length === 0 ? '' : `，${failures.length} 项失败`}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n[${failure.name}]\n${failure.error.stack ?? failure.error.message}`);
  process.exitCode = 1;
}
