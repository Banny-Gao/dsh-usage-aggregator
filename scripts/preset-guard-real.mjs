#!/usr/bin/env node
/**
 * 守卫真机验证:在宿主真实的 cordis / dsh-tools / dsh-scope / dsh-agent 上装载
 * presets/hard-metrics-guard.js,走真实工具执行管线,验证《硬指标手册》的硬禁令
 * 在真机上确实拦得住。
 *
 * 验证项:
 *   1. 未获本轮授权的 git commit / git push 被真实拒绝,命令没有执行;
 *   2. 用户本轮显式授权后放行,且一条授权只够用一次;
 *   3. 授权不跨 agent;
 *   4. 丢弃工作区改动的 git 命令一律拒绝(有授权也没有例外);
 *   5. 提问卡片里选中的选项算授权,一次点击只算一次;
 *   6. 守卫只作用于本预设作用域内的 agent(作用域隔离);
 *   7. 守卫的 agent/pre-step 监听器不截断 waterfall 链条;
 *   8. 进入新一轮后上一轮授权作废。
 *
 * 宿主作用域不可用时跳过(静态自检 scripts/preset-guard-check.mjs 仍然生效)。
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(ROOT, 'probe.cjs'));

/** 宿主提供的真实运行时。 */
let toolsEntry;
let nativeEntry;
let agentEntry;
try {
  toolsEntry = req.resolve('@deepseek-ai/dsh-tools');
  nativeEntry = req.resolve('@deepseek-ai/dsh-tool-executor-native');
  agentEntry = req.resolve('@deepseek-ai/dsh-agent');
} catch {
  console.log('SKIP: 宿主未提供 @deepseek-ai 作用域,跳过守卫真机验证(静态自检仍生效)');
  process.exit(0);
}

// cordis 必须取 dsh-tools 自己依赖的那一份:本仓 node_modules 里的是 4.0.5,
// 与宿主 DSH 实际使用的 4.1.0 不是同一个实例,混用会导致作用域链分裂。
const hostRequire = createRequire(toolsEntry);
const { Context } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href);
const { ToolsService, defineTool } = await import(pathToFileURL(toolsEntry).href);
const { createScope } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-scope')).href);
const nativeExecutor = await import(pathToFileURL(nativeEntry).href);
const { agentEvents } = await import(pathToFileURL(agentEntry).href);

let passed = 0;
let failed = 0;

/**
 * 记录一项断言。
 *
 * @param {string} label 断言说明。
 * @param {boolean} ok 是否成立。
 * @param {string} [detail] 失败时的补充信息。
 */
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

const ctx = new Context();
ctx.provide('systemPrompt', {
  tools() { return {}; },
  section() { return () => {}; },
});
await (ctx.plugin(ToolsService, {})).await();
await (ctx.plugin(nativeExecutor, {})).await();

/** 真实执行过的命令。 */
const executed = [];
let callSeq = 0;

ctx.tools.register(
  defineTool({
    name: 'bash',
    description: '真机验证用的命令执行',
    parameters: { command: { type: 'string', required: true, description: '要执行的命令' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: async (args) => {
      executed.push(args.command);
      return 'ok';
    },
  }),
);

// 提问卡片工具:用户点选答案以工具结果的形式回来,守卫从 tools/result 里读授权。
// 结果载荷与宿主 dsh-user-questions 的答复批次同形({answers:[{id,selected,custom?}]})。
ctx.tools.register(
  defineTool({
    name: 'ask_user_question',
    description: '真机验证用的提问卡片',
    parameters: { question: { type: 'string', required: true, description: '问题' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: async (args) => JSON.stringify({ answers: [{ id: 'q1', selected: [args.question] }] }),
  }),
);

// 预设作用域:预设由注册表挂载成一棵 scope 树,守卫在预设作用域注册。
const presetKey = {};
const preset = createScope(ctx, presetKey);
const guardModule = await import(pathToFileURL(path.join(ROOT, 'presets/hard-metrics-guard.js')).href);
await (preset.ctx.plugin(guardModule, {})).await();

/** 预设作用域内的三个 agent:授权按 agent 分桶,互不相通。 */
const agentA = { id: 'a1' };
createScope(ctx, agentA, { parent: presetKey });
const agentB = { id: 'b2' };
createScope(ctx, agentB, { parent: presetKey });
const agentC = { id: 'c3' };
createScope(ctx, agentC, { parent: presetKey });
/** 预设作用域之外的 agent:守卫对它不生效。 */
const agentOut = { id: 'out' };
createScope(ctx, agentOut);

/**
 * 走真实工具执行管线跑一条命令。
 *
 * @param {object} agent 调用方 agent(同时是它的作用域键)。
 * @param {string} command 命令文本。
 * @returns {Promise<{isError: boolean, text: string}>} 工具结果。
 */
async function runBash(agent, command) {
  return runTool(agent, 'bash', { command });
}

/**
 * 走真实工具执行管线跑一个工具调用。
 *
 * @param {object} agent 调用方 agent(同时是它的作用域键)。
 * @param {string} name 工具名。
 * @param {object} args 工具参数。
 * @returns {Promise<{isError: boolean, text: string}>} 工具结果。
 */
async function runTool(agent, name, args) {
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: `c${++callSeq}`, name, arguments: JSON.stringify(args) }],
    signal: new AbortController().signal,
    agent,
  });
  const result = batch.results[0].result;
  const text = (result.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('');
  return { isError: result.isError === true, text };
}

/**
 * 投递一条用户消息(真实事件派发:payload 带 agent,事件按作用域路由)。
 *
 * @param {object} agent 收消息的 agent。
 * @param {string} id 消息 id。
 * @param {string} text 消息正文。
 */
function userMessage(agent, id, text) {
  agentEvents(ctx, agent).emit('agent/inbox/inserted', {
    message: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  });
}

/**
 * 走一次真实的 agent/pre-step waterfall。
 *
 * @param {object} agent 目标 agent。
 * @param {number} turn 轮次。
 * @returns {Promise<string>} 内层决策(被截断时为 undefined)。
 */
function preStep(agent, turn) {
  return agentEvents(ctx, agent).waterfall('agent/pre-step', { messages: [], turn }, () => 'DECISION');
}

console.log('→ 守卫真机验证(真实 cordis / dsh-tools / dsh-scope / dsh-agent)');

// 1. 未授权的 git commit / git push
{
  const before = executed.length;
  const commit = await runBash(agentA, 'git commit -m "x"');
  check('未授权的 git commit 被拒绝', commit.isError && commit.text.includes('硬指标禁令'), commit.text);
  check('被拒绝的命令没有执行', executed.length === before);

  const push = await runBash(agentA, 'git push origin main');
  check('未授权的 git push 被拒绝', push.isError && push.text.includes('硬指标禁令'), push.text);
}

// 2. 用户本轮显式授权后放行
userMessage(agentA, 'm1', '现在提交');
{
  const commit = await runBash(agentA, 'git commit -m "x"');
  check('用户授权后的 git commit 放行', !commit.isError && commit.text.includes('ok'), commit.text);
}

// 3. 一条授权只够用一次
{
  const before = executed.length;
  const again = await runBash(agentA, 'git commit -m "y"');
  check('同一条授权的第二次 git commit 被拒绝', again.isError && again.text.includes('硬指标禁令'), again.text);
  check('被拒绝的命令没有执行', executed.length === before);
}

// 4. 授权不跨 agent:agentA 手里有一条没动过的授权,agentC 依然不被放行
userMessage(agentA, 'm1b', '现在提交');
{
  const other = await runBash(agentC, 'git commit -m "c"');
  check('另一个 agent 不继承本 agent 的授权', other.isError && other.text.includes('硬指标禁令'), other.text);

  const owner = await runBash(agentA, 'git commit -m "a"');
  check('持有授权的 agent 仍然放行', !owner.isError && owner.text.includes('ok'), owner.text);
}

// 5. 破坏工作区的命令一律拒绝(有授权也不例外)
userMessage(agentB, 'm2', '现在提交');
{
  const before = executed.length;
  const destructive = await runBash(agentB, 'git checkout -- .');
  check('git checkout -- . 被拒绝', destructive.isError && destructive.text.includes('绝对禁止'), destructive.text);
  check('被拒绝的命令没有执行', executed.length === before);

  const reset = await runBash(agentB, 'git reset --hard HEAD~1');
  check('git reset --hard 被拒绝', reset.isError && reset.text.includes('绝对禁止'), reset.text);

  const own = await runBash(agentB, 'git commit -m "b"');
  check('破坏性命令被拒不消耗已有授权', !own.isError && own.text.includes('ok'), own.text);
}

// 6. 提问卡片里的选中项算授权
{
  const card = await runTool(agentC, 'ask_user_question', { question: '现在提交' });
  check('提问卡片正常执行', !card.isError, card.text);

  const commit = await runBash(agentC, 'git commit -m "card"');
  check('提问卡片里选中的选项算授权', !commit.isError && commit.text.includes('ok'), commit.text);

  const again = await runBash(agentC, 'git commit -m "card2"');
  check('提问卡片的一次点击只算一次授权', again.isError && again.text.includes('硬指标禁令'), again.text);
}

// 7. 作用域隔离
{
  const outside = await runBash(agentOut, 'git commit -m "outside"');
  check('预设作用域之外的 agent 不受守卫管辖', !outside.isError, outside.text);
}

// 8. pre-step 不截断 waterfall
{
  const decision = await preStep(agentA, 1);
  check('agent/pre-step 的 waterfall 链条没有被截断', decision === 'DECISION', String(decision));
}

// 9. 新一轮后上一轮授权作废:m1c 同时授予 commit 与 push,先用掉 push,
//    换轮后剩下没动过的 commit 授权必须失效。
userMessage(agentA, 'm1c', '现在提交并推送');
{
  const push = await runBash(agentA, 'git push origin main');
  check('授权同时授予的 push 放行', !push.isError && push.text.includes('ok'), push.text);

  const decision = await preStep(agentA, 2);
  check('新一轮的 pre-step 仍然放行决策', decision === 'DECISION', String(decision));

  const commit = await runBash(agentA, 'git commit -m "z"');
  check('进入新一轮后上一轮授权作废', commit.isError && commit.text.includes('硬指标禁令'), commit.text);
}

if (failed > 0) {
  console.log(`✗ 守卫真机验证失败（${failed} 项未通过，共 ${passed + failed} 项）`);
  process.exit(1);
}
console.log(`✓ 守卫真机验证通过（${passed} 项）`);
