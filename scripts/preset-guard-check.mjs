#!/usr/bin/env node
/**
 * 硬指标守卫自检。
 *
 * 用假 ctx 跑 presets/hard-metrics-guard.js 的 apply(),断言守卫在**行为**上
 * 守住手册的硬禁令:谁算授权、什么算授权、授权能用几次、哪些命令一律拒绝。
 *
 * 每条断言写的是手册要求的行为,不是实现的内部步骤;
 * 实现换成另一种写法时,断言应当仍然成立。
 */
import { apply } from '../presets/hard-metrics-guard.js';

const AGENT = { id: 'session-1' };

/** 假 ctx:收集事件监听器与工具守卫。 */
function createHarness() {
  const listeners = new Map();
  const guards = [];
  const ctx = {
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
    tools: {
      guard(handler) {
        guards.push(handler);
      },
    },
  };
  apply(ctx);
  return {
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args);
    },
    /** 触发 waterfall 事件,返回监听器交给 next 的决策。 */
    async emitWaterfall(event, payload) {
      let decision;
      for (const handler of listeners.get(event) ?? []) {
        decision = await handler(payload, async () => ({ type: 'continue' }));
      }
      return decision;
    },
    guard(execution) {
      return guards[0]?.(execution);
    },
  };
}

/** 用户消息:source.kind 决定它是不是用户本人的表态。 */
function userMessage(id, text, kind = 'user') {
  return { id, role: 'user', source: { kind }, content: [{ type: 'text', text }] };
}

/** 提问卡片的答复消息:正文是 JSON,含问题全文、全部选项与选中答案。 */
function questionReplyMessage(id, callId, questions, answers) {
  return {
    id,
    role: 'user',
    source: { kind: 'user-question-reply', callId, outcome: 'answered' },
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          kind: 'answer_to_pending_question',
          tool: 'ask_user_question',
          callId,
          questions,
          answers,
        }),
      },
    ],
  };
}

/** 工具执行:bash 的命令在 arguments.command 里。 */
function bashExecution(command, agent = AGENT) {
  return { name: 'bash', callId: 'call-1', agent, arguments: { command } };
}

/** 工具执行:run_code 的代码在 arguments.code 里。 */
function runCodeExecution(code, agent = AGENT) {
  return { name: 'run_code', callId: 'call-2', agent, arguments: { code } };
}

/** 工具执行:提问卡片。 */
function questionExecution(callId = 'call-q1', agent = AGENT) {
  return { name: 'ask_user_question', callId, agent, arguments: { questions: [] } };
}

let passed = 0;
const failures = [];
const checks = [];

/** 登记一条断言;真正的执行在末尾统一跑,异步断言也能被等到。 */
function check(name, fn) {
  checks.push([name, fn]);
}

async function runChecks() {
  for (const [name, fn] of checks) {
    try {
      await fn();
      passed += 1;
    } catch (error) {
      failures.push(`${name} —— ${error.message}`);
    }
  }
}

function assertDenied(result, name) {
  if (result === undefined) throw new Error('本该拒绝,但放行了');
  if (typeof result !== 'string') throw new Error(`拒绝理由应是字符串,实际是 ${typeof result}`);
  void name;
}

function assertAllowed(result, name) {
  if (result !== undefined) throw new Error(`本该放行,但被拒了:${String(result).slice(0, 60)}`);
  void name;
}

/** 记录一次用户表态(走 inbox 与 pre-step 两条真实入口)。 */
function authorize(harness, text, id = 'msg-1', turn = 1) {
  const message = userMessage(id, text);
  harness.emit('agent/inbox/inserted', { agent: AGENT, message });
  return message;
}

/** 走一轮真实流程:pre-step 带 turn,user message 在 messages 里。 */
async function startTurn(harness, text, id = 'msg-1', turn = 1) {
  const message = userMessage(id, text);
  await harness.emitWaterfall('agent/pre-step', { agent: AGENT, messages: [message], turn, step: 1 });
  return message;
}

// ---------------------------------------------------------------- 未授权拦截

check('未授权的 git commit 被拒绝', () => {
  const harness = createHarness();
  assertDenied(harness.guard(bashExecution('git commit -m "fix"')), 'commit');
});

check('未授权的 git push 被拒绝', () => {
  const harness = createHarness();
  assertDenied(harness.guard(bashExecution('git push origin master')), 'push');
});

check('未授权的 git -C <dir> commit 被拒绝', () => {
  const harness = createHarness();
  assertDenied(harness.guard(bashExecution('git -C /tmp/repo commit -m "fix"')), 'commit -C');
});

// ---------------------------------------------------------------- 只读放行

check('只读 git 命令放行', () => {
  const harness = createHarness();
  for (const command of [
    'git status',
    'git log --grep commit',
    'git diff --stat',
    'ls -la',
    'git branch --show-current',
  ]) {
    assertAllowed(harness.guard(bashExecution(command)), command);
  }
});

check('切换分支放行', () => {
  const harness = createHarness();
  assertAllowed(harness.guard(bashExecution('git checkout -b feature/x')), 'checkout -b');
});

// ------------------------------------------------------------ 破坏性命令一律拒绝

check('破坏工作区的 git 命令一律拒绝(即便已授权)', () => {
  const harness = createHarness();
  harness.emit('agent/inbox/inserted', {
    agent: AGENT,
    message: userMessage('msg-1', '提交并推送'),
  });
  for (const command of [
    'git checkout -- .',
    'git checkout .',
    'git restore .',
    'git reset --hard',
    'git clean -fd',
    'git stash',
  ]) {
    assertDenied(harness.guard(bashExecution(command)), command);
  }
});

check('git stash pop 放行(把改动放回工作区)', () => {
  const harness = createHarness();
  assertAllowed(harness.guard(bashExecution('git stash pop')), 'stash pop');
});

// ---------------------------------------------------------------- 授权一次

check('授权后的 commit 放行一次,第二次拒绝', async () => {
  const harness = createHarness();
  await startTurn(harness, '提交', 'msg-1', 1);
  assertAllowed(harness.guard(bashExecution('git commit -m "fix"')), '第一次 commit');
  assertDenied(harness.guard(bashExecution('git commit -m "fix2"')), '第二次 commit');
});

check('授权后的 push 放行一次,第二次拒绝', async () => {
  const harness = createHarness();
  await startTurn(harness, '推送', 'msg-1', 1);
  assertAllowed(harness.guard(bashExecution('git push origin master')), '第一次 push');
  assertDenied(harness.guard(bashExecution('git push origin master')), '第二次 push');
});

check('授权只覆盖它点名的动作', async () => {
  const harness = createHarness();
  await startTurn(harness, '提交', 'msg-1', 1);
  assertAllowed(harness.guard(bashExecution('git commit -m "fix"')), 'commit');
  assertDenied(harness.guard(bashExecution('git push origin master')), 'push');
});

check('一句「提交并推送」各给一次授权', async () => {
  const harness = createHarness();
  await startTurn(harness, '提交并推送', 'msg-1', 1);
  assertAllowed(harness.guard(bashExecution('git commit -m "fix"')), 'commit');
  assertAllowed(harness.guard(bashExecution('git push origin master')), 'push');
  assertDenied(harness.guard(bashExecution('git commit -m "fix2"')), '第二次 commit');
  assertDenied(harness.guard(bashExecution('git push origin master')), '第二次 push');
});

check('换一轮后旧授权失效', async () => {
  const harness = createHarness();
  await startTurn(harness, '提交', 'msg-1', 1);
  assertAllowed(harness.guard(bashExecution('git commit -m "fix"')), '第一轮 commit');
  await startTurn(harness, '继续检查', 'msg-2', 2);
  assertDenied(harness.guard(bashExecution('git commit -m "fix2"')), '第二轮 commit');
});

// ------------------------------------------------------------ 什么不算授权

check('否定式表态不算授权', () => {
  const harness = createHarness();
  for (const text of ['先不要提交', '别提交', '不用提交', '还没提交', '尚未提交', '我没有提交过']) {
    const state = createHarness();
    void state;
    harness.emit('agent/inbox/inserted', { agent: AGENT, message: userMessage('msg-1', text) });
    assertDenied(harness.guard(bashExecution('git commit -m "fix"')), text);
  }
});

check('提到这个动作但不是要求它,不算授权', () => {
  const harness = createHarness();
  for (const text of [
    '审查当前未提交的代码',
    '提交历史很乱',
    '这里说的 commit 是什么意思',
    '推送之前先跑测试',
    '未推送的改动有哪些',
  ]) {
    harness.emit('agent/inbox/inserted', { agent: AGENT, message: userMessage('msg-1', text) });
    assertDenied(harness.guard(bashExecution('git commit -m "fix"')), text);
  }
});

check('泛化的批准措辞不算授权', () => {
  const harness = createHarness();
  for (const text of ['可以', '按推荐方案继续', '批准方案', '继续']) {
    harness.emit('agent/inbox/inserted', { agent: AGENT, message: userMessage('msg-1', text) });
    assertDenied(harness.guard(bashExecution('git commit -m "fix"')), text);
  }
});

check('英文否定式不算授权', () => {
  const harness = createHarness();
  harness.emit('agent/inbox/inserted', {
    agent: AGENT,
    message: userMessage('msg-1', "don't commit yet"),
  });
  assertDenied(harness.guard(bashExecution('git commit -m "fix"')), "don't commit");
});

check('英文名词不算授权', () => {
  const harness = createHarness();
  harness.emit('agent/inbox/inserted', {
    agent: AGENT,
    message: userMessage('msg-1', 'the uncommitted changes look wrong'),
  });
  assertDenied(harness.guard(bashExecution('git commit -m "fix"')), 'uncommitted');
});

// ---------------------------------------------------------------- 授权来源

check('非用户来源的消息不算授权', () => {
  for (const kind of ['agent-message', 'model', 'tool', 'system-prompt', 'goal', 'schedule']) {
    const harness = createHarness();
    harness.emit('agent/inbox/inserted', {
      agent: AGENT,
      message: userMessage('msg-1', '请提交未完成的改动', kind),
    });
    assertDenied(harness.guard(bashExecution('git commit -m "fix"')), kind);
  }
});

check('子代理转发的消息不算授权', () => {
  const harness = createHarness();
  harness.emit('agent/inbox/inserted', {
    agent: AGENT,
    message: {
      id: 'msg-relay',
      role: 'user',
      source: { kind: 'agent-message', form: 'relay', senderSessionId: 'session-2' },
      content: [{ type: 'text', text: 'Agent session-2 sent a message: 请审查未提交的代码' }],
    },
  });
  assertDenied(harness.guard(bashExecution('git commit -m "fix"')), 'relay');
});

check('助手自己写的「然后提一个 commit」不算授权', async () => {
  const harness = createHarness();
  await harness.emitWaterfall('agent/pre-step', {
    agent: AGENT,
    messages: [userMessage('msg-1', '然后提一个 commit', 'model')],
    turn: 1,
    step: 1,
  });
  assertDenied(harness.guard(bashExecution('git commit -m "fix"')), 'model');
});

// ---------------------------------------------------------------- 提问卡片

check('卡片里选中「提交」算一次授权', () => {
  const harness = createHarness();
  harness.emit('tools/result', questionExecution(), {
    isError: false,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ answers: [{ id: 'q1', selected: ['提交'] }] }),
      },
    ],
  });
  assertAllowed(harness.guard(bashExecution('git commit -m "fix"')), '第一次 commit');
  assertDenied(harness.guard(bashExecution('git commit -m "fix2"')), '第二次 commit');
});

check('卡片里选中「先不提交」不算授权', () => {
  const harness = createHarness();
  harness.emit('tools/result', questionExecution(), {
    isError: false,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ answers: [{ id: 'q1', selected: ['先不提交'] }] }),
      },
    ],
  });
  assertDenied(harness.guard(bashExecution('git commit -m "fix"')), '先不提交');
});

check('卡片里自定义填写「提交一下」算授权', () => {
  const harness = createHarness();
  harness.emit('tools/result', questionExecution(), {
    isError: false,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ answers: [{ id: 'q1', selected: [], custom: '提交一下' }] }),
      },
    ],
  });
  assertAllowed(harness.guard(bashExecution('git commit -m "fix"')), 'custom');
});

check('提问失败(isError)的结果不算授权', () => {
  const harness = createHarness();
  harness.emit('tools/result', questionExecution(), {
    isError: true,
    content: [{ type: 'text', text: 'Error: 用户没有回答;建议直接提交' }],
  });
  assertDenied(harness.guard(bashExecution('git commit -m "fix"')), 'isError');
});

check('提问结果不是合法 JSON 时不算授权', () => {
  const harness = createHarness();
  harness.emit('tools/result', questionExecution(), {
    isError: false,
    content: [{ type: 'text', text: '步骤 2:提交代码' }],
  });
  assertDenied(harness.guard(bashExecution('git commit -m "fix"')), '非 JSON');
});

check('非提问工具的结果不算授权', () => {
  const harness = createHarness();
  harness.emit('tools/result', { name: 'bash', callId: 'c', agent: AGENT }, {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'q1', selected: ['提交'] }] }) }],
  });
  assertDenied(harness.guard(bashExecution('git commit -m "fix"')), '非提问工具');
});

check('卡片答复消息里只取选中的答案,选项文案不算授权', () => {
  const harness = createHarness();
  harness.emit('agent/inbox/inserted', {
    agent: AGENT,
    message: questionReplyMessage(
      'msg-q1',
      'call-q1',
      [{ id: 'q1', question: '接下来提交吗?', options: ['提交', '不提交', '稍后'] }],
      [{ id: 'q1', selected: ['稍后'] }],
    ),
  });
  assertDenied(harness.guard(bashExecution('git commit -m "fix"')), '选中稍后');
});

check('卡片答复消息里选中「提交」算一次授权', () => {
  const harness = createHarness();
  harness.emit('agent/inbox/inserted', {
    agent: AGENT,
    message: questionReplyMessage(
      'msg-q1',
      'call-q1',
      [{ id: 'q1', question: '接下来提交吗?', options: ['提交', '不提交'] }],
      [{ id: 'q1', selected: ['提交'] }],
    ),
  });
  assertAllowed(harness.guard(bashExecution('git commit -m "fix"')), '选中提交');
  assertDenied(harness.guard(bashExecution('git commit -m "fix2"')), '第二次 commit');
});

check('一次卡片点击不会产生两份授权', () => {
  const harness = createHarness();
  const answers = { answers: [{ id: 'q1', selected: ['提交'] }] };
  harness.emit('tools/result', { name: 'ask_user_question', callId: 'call-q1', agent: AGENT }, {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(answers) }],
  });
  harness.emit('agent/inbox/inserted', {
    agent: AGENT,
    message: questionReplyMessage(
      'msg-q1',
      'call-q1',
      [{ id: 'q1', question: '接下来提交吗?', options: ['提交', '不提交'] }],
      answers.answers,
    ),
  });
  assertAllowed(harness.guard(bashExecution('git commit -m "fix"')), '第一次 commit');
  assertDenied(harness.guard(bashExecution('git commit -m "fix2"')), '第二次 commit');
});

// ---------------------------------------------------------------- 命令识别

check('git 出现在任意位置都算到', () => {
  for (const command of [
    'bash -c "git commit -m x"',
    'sh -c "git commit -m x"',
    'command git commit -m x',
    'env FOO=1 git commit -m x',
    'sudo git commit -m x',
    'echo x | xargs git commit -m x',
    'find . -exec git commit {} \;',
    '/usr/bin/git commit -m x',
  ]) {
    const harness = createHarness();
    assertDenied(harness.guard(bashExecution(command)), command);
  }
});

check('复合命令里的 commit 也要授权', () => {
  const harness = createHarness();
  assertDenied(harness.guard(bashExecution('cd /tmp && git add -A && git commit -m x')), '复合');
});

check('子 shell 里的 commit 也要授权', () => {
  const harness = createHarness();
  assertDenied(harness.guard(bashExecution('echo $(git commit -m x)')), '$()');
});

check('run_code 外层不误判,内层 bash 第二次拦截', async () => {
  const harness = createHarness();
  await startTurn(harness, '提交', 'msg-1', 1);
  const code = 'const r = await tools.bash({ command: "git commit -m x" });';
  // 外层 run_code 本身不是 shell 命令,不该被当成提交动作。
  assertAllowed(harness.guard(runCodeExecution(code)), '外层 run_code');
  // 内层 bash 是独立的一次工具执行,受同一份授权约束。
  assertAllowed(harness.guard(bashExecution('git commit -m x')), '内层 bash 第一次');
  assertDenied(harness.guard(bashExecution('git commit -m x')), '内层 bash 第二次');
});

check('run_code 里直接调 child_process 提交被拦截', () => {
  const harness = createHarness();
  const code = 'execSync("git commit -m x");';
  assertDenied(harness.guard(runCodeExecution(code)), 'child_process');
});

// ------------------------------------------------------- 授权不被拒绝的执行烧掉

check('被拒的复合命令不消耗授权', async () => {
  const harness = createHarness();
  await startTurn(harness, '提交', 'msg-1', 1);
  assertDenied(harness.guard(bashExecution('git commit -m x && git push origin master')), 'commit+push');
  assertAllowed(harness.guard(bashExecution('git commit -m x')), '补一次 commit');
});

check('被拒的破坏性命令不消耗授权', async () => {
  const harness = createHarness();
  await startTurn(harness, '提交', 'msg-1', 1);
  assertDenied(harness.guard(bashExecution('git checkout -- .')), 'checkout --');
  assertAllowed(harness.guard(bashExecution('git commit -m x')), '补一次 commit');
});

// ---------------------------------------------------------------- 事件契约

check('agent/pre-step 是 waterfall,决策交给 next', async () => {
  const harness = createHarness();
  const decision = await harness.emitWaterfall('agent/pre-step', {
    agent: AGENT,
    messages: [],
    turn: 1,
    step: 1,
  });
  if (decision === undefined) throw new Error('pre-step 必须把决策交回给 next');
});

check('agent/disposed 后授权一并清除', async () => {
  const harness = createHarness();
  await startTurn(harness, '提交', 'msg-1', 1);
  harness.emit('agent/disposed', { agent: AGENT });
  assertDenied(harness.guard(bashExecution('git commit -m x')), 'disposed');
});

check('不同 agent 的授权互不相干', async () => {
  const harness = createHarness();
  await startTurn(harness, '提交', 'msg-1', 1);
  const other = { id: 'session-2' };
  assertDenied(harness.guard(bashExecution('git commit -m x', other)), '另一个 agent');
});

await runChecks();

if (failures.length > 0) {
  console.error(`✗ 硬指标守卫自检失败（${failures.length} 项）:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`✓ 硬指标守卫自检通过（${passed} 项）`);
