#!/usr/bin/env node
/**
 * scripts/dingtalk-check.mjs
 *
 * 「钉钉沙发」的离线冒烟自检（node scripts/dingtalk-check.mjs）。
 *
 * 干什么：用一份假的 dws 可执行脚本（scripts/fixtures/dws-stub.sh），
 * 把 Host 半边的「发消息 / 收消息」链路真跑一遍并断言结果。
 *
 * 覆盖四块：
 *   1. **真 spawn** —— runDws 真的把假 dws 拉起来，JSON 能解析，失败形态如实上报；
 *   2. **发消息** —— 解析收件人、同名消歧、会话内复用、发正文，
 *      以及最要紧的一条：openTaskId 不是消息 ID，回查不到就只能说「未确认送达」；
 *   3. **收消息** —— 第一轮只做基线不打扰，第二轮才把项目内消息交给模型分析；
 *   4. **粗筛** —— 什么算「项目内」，需求号怎么归一化。
 *
 * 不联网、不碰真实钉钉、也不需要本机装 dws：假 dws 就是一个打印 JSON 的 shell 脚本。
 * 纯 node，不引测试框架：失败逐条打印，最后给一行总结。
 */

import { strict as assert } from 'node:assert';
import { register } from 'node:module';
import { access, constants } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// card.js 从宿主运行时引入 @deepseek-ai/dsh-llm（只用 createUserMessage）。
// 离线自检装不上那个包 —— 注册一个最小解析钩子，把它解析到内存里的桩模块，
// 桩只覆盖 createUserMessage 一处，不碰被测逻辑。
const LLM_STUB = 'export function createUserMessage(input) {'
  + ' return { content: input?.content ?? [], source: input?.source ?? null }; };';
register('data:text/javascript,' + encodeURIComponent([
  'export async function resolve(specifier, context, nextResolve) {',
  '  if (specifier === "@deepseek-ai/dsh-llm") {',
  '    return { url: "data:text/javascript," + ' + JSON.stringify(encodeURIComponent(LLM_STUB)) + ', shortCircuit: true };',
  '  }',
  '  return nextResolve(specifier, context);',
  '}',
].join('\n')));

// card.js 必须在解析钩子注册**之后**再加载，所以这里用动态 import。
const { createSendKind } = await import('../src/host/features/dingtalk/card.js');
const { explainFailure, runDws } = await import('../src/host/features/dingtalk/dws.js');
const { collectMessages, collectPeople } = await import('../src/host/features/dingtalk/shapes.js');
const { createOps } = await import('../src/host/features/dingtalk/ops.js');
const { classifyMessage, extractReqCodes } = await import('../src/host/features/dingtalk/relevance.js');
const { createContextReader } = await import('../src/host/features/dingtalk/context.js');
const { createReceiver } = await import('../src/host/features/dingtalk/receiver.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const STUB = join(HERE, 'fixtures', 'dws-stub.sh');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(() => { passed += 1; console.log(`  ✓ ${name}`); }, (error) => {
        failures.push({ name, error });
        console.log(`  ✗ ${name}\n     ${error.message}`);
      });
    }
    passed += 1;
    console.log(`  ✓ ${name}`);
    return undefined;
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n     ${error.message}`);
    return undefined;
  }
}

/**
 * 记调用次数的假 dws：把每次调用记下来，再真的拉起假脚本。
 *
 * @param {string} bin 假 dws 的路径。
 * @returns {{calls: Array<string[]>, dws: Function}} 计数器与包装函数。
 */
function countingDws(bin) {
  const calls = [];
  const dws = (args, options = {}) => {
    calls.push(args.slice());
    return runDws(args, { ...options, bin });
  };
  return { calls, dws };
}

/**
 * 假卡片服务：记住每个 callId 的决定，好断言状态流转。
 *
 * @returns {object} 卡片服务。
 */
function fakeCards() {
  const decisions = {};
  return {
    decisions,
    record(agent, decision) {
      decisions[decision.callId] = decision;
      return decision;
    },
    view(session) {
      return { proposals: {}, decisions };
    },
  };
}

/**
 * 造一张卡片提议。
 *
 * @param {string} callId 提议 id。
 * @param {{recipient: string, body: string}} details 卡片内容。
 * @returns {object} 提议。
 */
function makeProposal(callId, details) {
  return {
    callId,
    turn: 1,
    action: 'dingtalk.send',
    title: '发给 ' + details.recipient,
    brief: '待确认的钉钉消息',
    details: {
      recipient: details.recipient,
      reason: '确认一下发布申请',
      body: details.body,
    },
  };
}

// 假会话：带工作目录与两条对话事件（决定项目上下文里的需求号与关键词）。
const agent = {
  id: 'agent-1',
  session: {
    header: { cwd: REPO },
    seq: 2,
    snapshotEvents() {
      return [
        {
          type: 'user/message',
          data: { message: { content: [{ type: 'text', text: '帮我把 REQ-1234 的钉钉沙发自检跑一遍' }] } },
        },
        {
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: '正在检查 dsh-usage-aggregator 的发布流程' }] } },
        },
      ];
    },
  },
  followup() {},
};

console.log('→ 假 dws：能不能被真拉起来');
await check('假 dws 脚本在位且可执行', async () => {
  try {
    await access(STUB, constants.X_OK);
  } catch (error) {
    throw new Error('假 dws 不可执行：' + STUB + '（' + error.code + '）');
  }
});

await check('runDws 真 spawn 了假 dws：--version 拿到版本行', async () => {
  const version = await runDws(['--version'], { bin: STUB, format: false });
  assert.equal(version.code, 0, `退出码应该是 0，实际 ${version.code}`);
  assert.match(version.stdout, /dws 0\.9\.9/, 'stdout 里应该有版本行');
  // 版本横幅本来就不是 JSON —— runDws 必须如实报「输出不是 JSON」，不能当成功。
  assert.equal(version.ok, false, '非 JSON 输出不该算成功');
  assert.equal(version.reason, 'dws-unparsable');
  assert.match(explainFailure(version), /不是 JSON/);
});

await check('runDws 真 spawn 了假 dws：chat +at-me --page-all 解析出 JSON', async () => {
  const atme = await runDws(['chat', '+at-me', '--page-all'], { bin: STUB });
  assert.equal(atme.ok, true, `stderr: ${atme.stderr}`);
  assert.equal(atme.reason, '', '成功时 reason 应该是空串');
  assert.ok(Array.isArray(atme.json?.messages), 'json 里应该有 messages 数组');
  assert.equal(atme.json.messages.length, 2);
  assert.equal(atme.json.complete, true);
});

await check('未知命令按失败处理（退出码 1 + stderr 说明）', async () => {
  const bad = await runDws(['nope'], { bin: STUB });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'dws-exit');
  assert.equal(bad.code, 1);
  assert.equal(bad.stdout.trim(), '', '失败时 stdout 不该有内容');
  assert.match(explainFailure(bad), /unknown command/);
});

console.log('');
console.log('→ 形状转换：从假 dws 的 JSON 里取人 / 取消息');
await check('collectPeople 取出人（姓名 / userId / openDingTalkId / 部门）', async () => {
  const one = await runDws(['aisearch', 'person', '--query', '陈世康', '--dimension', 'name'], { bin: STUB });
  assert.equal(one.ok, true, one.stderr);
  const people = collectPeople(one.json);
  assert.equal(people.length, 1);
  assert.deepEqual(people[0], {
    name: '陈世康',
    userId: 'u-1001',
    openDingTalkId: 'odt-chen-shikang-0001',
    department: '后端组',
  });
});

await check('collectPeople 取同名候选（张伟是两个人）', async () => {
  const two = await runDws(['aisearch', 'person', '--query', '张伟', '--dimension', 'name'], { bin: STUB });
  const people = collectPeople(two.json);
  assert.equal(people.length, 2);
  assert.deepEqual(people.map((person) => person.openDingTalkId), [
    'odt-zhangwei-a-0002',
    'odt-zhangwei-b-0003',
  ]);
});

await check('collectMessages 取消息（id / 发送者 / 正文 / 时间戳）', async () => {
  const atme = await runDws(['chat', '+at-me', '--page-all'], { bin: STUB });
  const messages = collectMessages(atme.json);
  assert.equal(messages.length, 2);
  const [inside, outside] = messages;
  assert.equal(inside.messageId, 'msg-in-0001');
  assert.equal(inside.conversationId, 'conv-1');
  assert.equal(inside.sender, '陈世康');
  assert.equal(inside.senderId, 'odt-chen-shikang-0001');
  assert.ok(inside.text.includes('REQ-1234'));
  assert.ok(inside.createTime > 0, '时间戳应该是当下的毫秒数，不是写死的旧值');
  assert.equal(outside.messageId, 'msg-out-0001');
  assert.equal(outside.sender, '前台小妹');
  assert.ok(outside.createTime > 0);
});

console.log('');
console.log('→ 解析收件人：绝不猜人');
const { calls: opsCalls, dws: opsDws } = countingDws(STUB);
const ops = createOps({ dws: opsDws });

await check('resolveRecipient(陈世康) → resolved，并拿到 openDingTalkId', async () => {
  const result = await ops.resolveRecipient('陈世康', 'sess-1');
  assert.equal(result.status, 'resolved');
  assert.equal(result.person.name, '陈世康');
  assert.equal(result.person.openDingTalkId, 'odt-chen-shikang-0001');
});

await check('resolveRecipient(张伟) → ambiguous，两个候选摆出来', async () => {
  const result = await ops.resolveRecipient('张伟', 'sess-1');
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map((person) => person.userId), ['u-2001', 'u-2002']);
});

await check('resolveRecipient(查无此人) → not-found', async () => {
  const result = await ops.resolveRecipient('查无此人', 'sess-1');
  assert.equal(result.status, 'not-found');
  assert.match(result.error, /查无此人/);
});

await check('availability() 报「装了 dws」并带出版本', async () => {
  const probe = await ops.availability();
  assert.equal(probe.installed, true);
  assert.equal(probe.version, 'dws 0.9.9');
});

console.log('');
console.log('→ 会话内复用解析结果');
await check('同一会话第二次解析同名不再问 CLI', async () => {
  const local = countingDws(STUB);
  const localOps = createOps({ dws: local.dws });
  const first = await localOps.resolveRecipient('陈世康', 'sess-cache');
  const second = await localOps.resolveRecipient('陈世康', 'sess-cache');
  assert.equal(first.status, 'resolved');
  assert.equal(second.status, 'resolved');
  assert.equal(second.person.openDingTalkId, 'odt-chen-shikang-0001');
  const searches = local.calls.filter((args) => args[0] === 'aisearch');
  assert.equal(searches.length, 1, `同会话第二次不该再查通讯录，实际查了 ${searches.length} 次`);
});

await check('换一个会话又要重新查通讯录（缓存按会话隔离）', async () => {
  const local = countingDws(STUB);
  const localOps = createOps({ dws: local.dws });
  await localOps.resolveRecipient('陈世康', 'sess-a');
  await localOps.resolveRecipient('陈世康', 'sess-b');
  const searches = local.calls.filter((args) => args[0] === 'aisearch');
  assert.equal(searches.length, 2, '换个会话就该重新查一次');
});

console.log('');
console.log('→ 发消息：只拿任务 ID，不当已送达');
await check('sendMessage 成功只回 taskId，不回 messageId', async () => {
  const result = await ops.sendMessage({
    recipient: '陈世康',
    recipientId: '',
    channel: 'dm',
    body: '这是一条测试消息',
    sessionId: 'sess-send',
  });
  assert.equal(result.status, 'submitted');
  assert.equal(result.taskId, 'task-0001');
  assert.ok(!('messageId' in result), '返回值里不能有 messageId：openTaskId 是任务 ID，不是消息 ID');
});

await check('正文超过 5000 字直接失败（压根不发给钉钉）', async () => {
  const before = opsCalls.length;
  const result = await ops.sendMessage({
    recipient: '陈世康',
    channel: 'dm',
    body: '啊'.repeat(6000),
    sessionId: 'sess-send',
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /5000/, '错误里要说明 5000 字上限');
  assert.equal(opsCalls.length, before, '正文超长时不该调 dws');
});

console.log('');
console.log('→ 卡片：发送 / 改稿 / 校验');
const cards = fakeCards();
const injected = [];
const kind = createSendKind({
  ops,
  cards,
  now: () => Date.now(),
  inject: async (target, text) => { injected.push(text); },
});

await check('act(send) 回查到回执 → phase sent，带真实 messageId', async () => {
  const proposal = makeProposal('call-sent', { recipient: '陈世康', body: '回执：发布申请麻烦你确认一下' });
  const result = await kind.act(agent, proposal, 'send', {});
  assert.equal(result.status, 'settled');
  assert.equal(result.decision.phase, 'sent');
  assert.equal(result.decision.data.messageId, 'msg-real-0001');
  assert.equal(cards.decisions['call-sent'].phase, 'sent');
});

await check('act(send) 回查不到 → phase submitted（未确认送达）', async () => {
  const proposal = makeProposal('call-submitted', { recipient: '陈世康', body: '普通内容' });
  const result = await kind.act(agent, proposal, 'send', {});
  assert.equal(result.decision.phase, 'submitted');
  assert.equal(result.decision.data.taskId, 'task-0001');
  assert.ok(!('messageId' in result.decision.data), '回查不到就不该有 messageId');
  assert.equal(cards.decisions['call-submitted'].phase, 'submitted');
});

await check('act(send) 同名多人 → phase ambiguous，两个候选', async () => {
  const proposal = makeProposal('call-ambiguous', { recipient: '张伟', body: '你好' });
  const result = await kind.act(agent, proposal, 'send', {});
  assert.equal(result.decision.phase, 'ambiguous');
  assert.equal(result.decision.data.candidates.length, 2);
  assert.equal(result.decision.data.candidates[0].name, '张伟');
  assert.ok(String(result.decision.data.candidates[0].label).includes('张伟'), '候选要带「姓名 + 标识片段」的回显标签');
});

await check('act(revise) → phase revising，并把改稿要求注入会话', async () => {
  const before = injected.length;
  const proposal = makeProposal('call-revise', { recipient: '陈世康', body: '这是一段要改的正文' });
  const result = await kind.act(agent, proposal, 'revise', { instruction: '太啰嗦了' });
  assert.equal(result.decision.phase, 'revising');
  assert.equal(result.decision.data.instruction, '太啰嗦了');
  assert.equal(injected.length, before + 1, '注入器应该被调一次');
  const text = injected[injected.length - 1];
  assert.ok(text.includes('太啰嗦了'), '注入文本里要有用户的修改要求');
  assert.ok(text.includes('这是一段要改的正文'), '注入文本里要有原正文');
});

await check('未知 verb 直接拒绝（不做事）', async () => {
  const proposal = makeProposal('call-unknown', { recipient: '陈世康', body: '正文' });
  const result = await kind.act(agent, proposal, 'whatever', {});
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'unknown-verb');
});

await check('details 校验：缺字段失败，齐全时给出 trim 过的值', () => {
  const missingRecipient = kind.details.safeParse({ reason: '确认一下', body: '正文' });
  assert.equal(missingRecipient.success, false, '缺 recipient 应该校验失败');
  assert.ok(missingRecipient.error.issues.some((issue) => issue.path[0] === 'recipient'));
  const missingBody = kind.details.safeParse({ recipient: '陈世康', reason: '确认一下' });
  assert.equal(missingBody.success, false, '缺 body 应该校验失败');
  assert.ok(missingBody.error.issues.some((issue) => issue.path[0] === 'body'));
  const good = kind.details.safeParse({
    recipient: '  陈世康  ',
    reason: '  确认一下  ',
    body: '  正文  ',
    channel: 'dm',
  });
  assert.equal(good.success, true);
  assert.equal(good.data.recipient, '陈世康');
  assert.equal(good.data.body, '正文');
  assert.equal(good.data.channel, 'dm');
});

console.log('');
console.log('→ 收消息：先基线，再打扰');
const contextReader = createContextReader({
  run: async () => ({ ok: true, stdout: 'feature/dingtalk-sofa\n' }),
});
const injectCalls = [];
const receiver = createReceiver({
  ops,
  agents: { roots: () => [agent] },
  contextReader,
  inject: async (target, text) => { injectCalls.push(text); },
  now: () => Date.now(),
});

await check('第一轮 poll 只做基线：不注入提示，项目外消息只加未读', async () => {
  const result = await receiver.poll();
  assert.equal(result.ok, true, result.error);
  assert.equal(injectCalls.length, 0, '第一轮不该唤醒模型');
  const status = receiver.status();
  assert.equal(status.unread, 1, '项目外那条消息只该累一个未读');
  assert.equal(status.baselined, true);
  assert.equal(status.lastRelevant, 1, 'REQ-1234 那条算项目内');
  assert.equal(status.lastBaselined, 1);
});

await check('第二轮 poll：项目内的新消息才注入分析提示', async () => {
  process.env.DWS_STUB_EXTRA_ID = 'msg-in-0002';
  process.env.DWS_STUB_EXTRA_TEXT = 'REQ-1234 的发布申请再确认一下';
  const result = await receiver.poll();
  delete process.env.DWS_STUB_EXTRA_ID;
  delete process.env.DWS_STUB_EXTRA_TEXT;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.count, 1, '只有那条新消息算新的');
  assert.equal(injectCalls.length, 1, '第二轮应该注入一次分析提示');
  const text = injectCalls[0];
  assert.ok(text.includes('REQ-1234 的发布申请再确认一下'), '注入文本里要有消息原文');
  assert.ok(text.includes('只做分析'), '注入文本里要说明「只做分析，不要动手」');
  assert.ok(text.includes('ask_user_question'), '注入文本里要教模型用 ask_user_question 问用户');
  assert.equal(receiver.status().unread, 1, '项目外那条不该重复计数');
});

console.log('');
console.log('→ 粗筛：什么算项目内');
await check('classifyMessage：需求号 / 分支 / 关键词命中才算项目内', () => {
  const context = {
    branch: 'feature/dingtalk-sofa',
    reqCodes: ['REQ-1234'],
    keywords: ['dsh-usage-aggregator'],
  };
  const byReq = classifyMessage({ text: 'REQ-1234 的发布申请麻烦你确认一下' }, context);
  assert.equal(byReq.inProject, true);
  assert.ok(byReq.reasons.includes('req'));
  const byBranch = classifyMessage({ text: 'feature/dingtalk-sofa 这条流水线挂了' }, context);
  assert.equal(byBranch.inProject, true);
  assert.ok(byBranch.reasons.includes('branch'));
  const byKeyword = classifyMessage({ text: 'dsh-usage-aggregator 的用法要看 README' }, context);
  assert.equal(byKeyword.inProject, true);
  assert.ok(byKeyword.reasons.includes('keyword'));
  const outside = classifyMessage({ text: '楼下奶茶店今天买一送一' }, context);
  assert.equal(outside.inProject, false);
  assert.deepEqual(outside.reasons, []);
});

await check('extractReqCodes 把需求号与缺陷号归一化', () => {
  assert.deepEqual(extractReqCodes('REQ-1234 与 BUG-88'), ['REQ-1234', 'BUG-88']);
});

console.log('');
if (failures.length > 0) {
  console.error(`✗ 有 ${failures.length} 项未通过：`);
  for (const failure of failures) console.error(`  - ${failure.name}: ${failure.error.message}`);
  process.exit(1);
}
console.log(`✓ 钉钉沙发自检通过（${passed} 项）`);
