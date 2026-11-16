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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../presets/hard-metrics-guard.js';

const AGENT = { id: 'session-1', session: { header: { delegationDepth: 0 } } };
const SUBAGENT = { id: 'session-sub', session: { header: { delegationDepth: 1 } } };
/** 顶层会话:会话头里可能根本没有委托深度这个字段。 */
const TOP_LEVEL = { id: 'session-plain', session: { header: {} } };
/** 子代理会话:靠 origin 标记,深度字段可能没写。 */
const SUBAGENT_ORIGIN = { id: 'session-origin', session: { header: { origin: 'subagent' } } };

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
function questionExecution(callId = 'call-q1', agent = AGENT, questions = []) {
  return { name: 'ask_user_question', callId, agent, arguments: { questions } };
}

/**
 * 造一个临时项目:脚本名看不出轻重,内容里藏着重命令。
 *
 * 守卫按会话的工作目录读 package.json,所以这个项目要挂在会话头的 cwd 上。
 */
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-project-'));
fs.writeFileSync(
  path.join(PROJECT_DIR, 'package.json'),
  JSON.stringify({
    scripts: {
      verify: 'bash scripts/verify.sh',
      dev: 'vite',
      hello: 'echo hi',
      'lint:fix': 'eslint --fix .',
    },
  }),
);
fs.mkdirSync(path.join(PROJECT_DIR, 'scripts'));
fs.writeFileSync(path.join(PROJECT_DIR, 'scripts/verify.sh'), 'pnpm exec vite build\n');

/** 项目内的会话:cwd 指向临时项目。 */
const PROJECT_AGENT = { id: 'session-proj', session: { header: { delegationDepth: 0, cwd: PROJECT_DIR } } };

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
async function startTurn(harness, text, id = 'msg-1', turn = 1, agent = AGENT) {
  const message = userMessage(id, text);
  await harness.emitWaterfall('agent/pre-step', { agent, messages: [message], turn, step: 1 });
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

// ------------------------------------------------- 提问卡片点名命令

/** 只跑一个文件的测试命令:选项文案里没有「测试」这类类别词。 */
const H23_COMMAND = 'pnpm vitest run packages/bazi/src/__tests__/F2.H23-geBing.test.ts';
/** 同一类里的另一条命令:卡片没点名它。 */
const H58_COMMAND = 'pnpm vitest run packages/bazi/src/__tests__/F2.H58-mingLi-jianYan.test.ts';

/** 一张点名了某条命令的授权卡片;另外两条命令只是顺带提到。 */
function commandCard(command) {
  return [
    {
      id: 'run_h23',
      header: '跑测试授权',
      question: `是否允许我现在跑单文件测试 \`${command}\`?全量测试 \`pnpm test\` 需另行同意;不要跑 \`pnpm build\`。`,
      options: [
        { label: '允许跑该单文件(推荐)', description: '只跑这一个文件。' },
        { label: '暂不跑', description: '先看 diff。' },
      ],
    },
  ];
}

/** 卡片答案:选中的选项。 */
function cardAnswer(selected) {
  return { isError: false, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'run_h23', selected }] }) }] };
}

check('卡片点名的命令按命令授权:同一条命令放行一次,第二次拒绝', () => {
  const harness = createHarness();
  harness.emit('tools/result', questionExecution('call-q1', AGENT, commandCard(H23_COMMAND)), cardAnswer(['允许跑该单文件(推荐)']));
  assertAllowed(harness.guard(bashExecution(H23_COMMAND)), '点名命令第一次');
  assertDenied(harness.guard(bashExecution(H23_COMMAND)), '点名命令第二次');
});

check('卡片点名一条命令不等于授权整类', () => {
  const harness = createHarness();
  harness.emit('tools/result', questionExecution('call-q1', AGENT, commandCard(H23_COMMAND)), cardAnswer(['允许跑该单文件(推荐)']));
  assertDenied(harness.guard(bashExecution(H58_COMMAND)), '同类里的另一条命令');
  assertDenied(harness.guard(bashExecution('pnpm test')), '全量测试');
});

check('卡片里选「暂不跑」时,卡片写明的命令也不授权', () => {
  const harness = createHarness();
  harness.emit('tools/result', questionExecution('call-q1', AGENT, commandCard(H23_COMMAND)), cardAnswer(['暂不跑']));
  assertDenied(harness.guard(bashExecution(H23_COMMAND)), '暂不跑');
});

check('卡片答复消息里点名的命令同样按命令授权', () => {
  const harness = createHarness();
  harness.emit('agent/inbox/inserted', {
    agent: AGENT,
    message: questionReplyMessage('msg-q1', 'call-q1', commandCard(H23_COMMAND), [{ id: 'run_h23', selected: ['允许跑该单文件(推荐)'] }]),
  });
  assertAllowed(harness.guard(bashExecution(H23_COMMAND)), '答复消息点名命令');
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

// ------------------------------------------------------- 复合提交指令

check('复合指令里的提交算授权', async () => {
  const harness = createHarness();
  await startTurn(harness, '提交,然后继续深入分析是否应该重构', 'msg-1', 1);
  assertAllowed(harness.guard(bashExecution('git commit -m "fix"')), '复合指令');
});

check('复合指令里的提交算授权(各种说法)', async () => {
  for (const text of [
    '提交,然后继续深入分析 #67',
    '那更新文档并提交,然后继续深入分析 #67',
    '提交,然后再次简明扼要的说明 #15 本仓与书判差异',
    '提交,然后继续深入分析 #46 为什么书判与本仓不符',
  ]) {
    const harness = createHarness();
    await startTurn(harness, text, 'msg-1', 1);
    assertAllowed(harness.guard(bashExecution('git commit -m "fix"')), text);
  }
});

check('复合指令里的否定式仍然不算授权', async () => {
  for (const text of ['不要提交,然后继续任务', '不用提交,然后继续任务']) {
    const harness = createHarness();
    await startTurn(harness, text, 'msg-1', 1);
    assertDenied(harness.guard(bashExecution('git commit -m "fix"')), text);
  }
});

check('谈论词只否定自己那一段', async () => {
  const harness = createHarness();
  await startTurn(harness, '提交历史很乱,然后继续', 'msg-1', 1);
  assertDenied(harness.guard(bashExecution('git commit -m "fix"')), '提交历史很乱');
});

// ---------------------------------------------------------------- 重命令

check('主代理没拿到同意时重命令被拒绝', () => {
  const harness = createHarness();
  assertDenied(harness.guard(bashExecution('pnpm build')), '没有同意');
});

check('子代理跑重命令被拒绝', async () => {
  const harness = createHarness();
  await startTurn(harness, '跑一下测试', 'msg-1', 1);
  assertDenied(harness.guard(bashExecution('pnpm build', SUBAGENT)), '子代理');
});

check('主代理拿到同意后重命令放行一次,第二次拒绝', async () => {
  const harness = createHarness();
  await startTurn(harness, '跑一下测试', 'msg-1', 1);
  assertAllowed(harness.guard(bashExecution('pnpm vitest')), '第一次');
  assertDenied(harness.guard(bashExecution('pnpm vitest')), '第二次');
});

check('同意跑测试不等于同意构建', async () => {
  const harness = createHarness();
  await startTurn(harness, '跑一下测试', 'msg-1', 1);
  assertDenied(harness.guard(bashExecution('pnpm build')), '构建');
});

check('类型检查要单独授权', async () => {
  const harness = createHarness();
  await startTurn(harness, '跑一下测试', 'msg-1', 1);
  assertDenied(harness.guard(bashExecution('vue-tsc --noEmit')), '类型检查');
});

check('同意类型检查后放行一次', async () => {
  const harness = createHarness();
  await startTurn(harness, '跑一下类型检查', 'msg-1', 1);
  assertAllowed(harness.guard(bashExecution('vue-tsc --noEmit')), '类型检查');
  assertDenied(harness.guard(bashExecution('vue-tsc --noEmit')), '类型检查第二次');
});

check('否定式的重命令要求不算授权', async () => {
  const harness = createHarness();
  await startTurn(harness, '不用跑测试', 'msg-1', 1);
  assertDenied(harness.guard(bashExecution('pnpm vitest')), '不用跑测试');
});

check('重命令的同意换一轮就失效', async () => {
  const harness = createHarness();
  await startTurn(harness, '跑一下测试', 'msg-1', 1);
  await startTurn(harness, '继续', 'msg-2', 2);
  assertDenied(harness.guard(bashExecution('pnpm vitest')), '第二轮');
});

check('普通命令不算重命令', () => {
  const harness = createHarness();
  for (const command of ['ls -la', 'node scripts/check.mjs', 'pnpm dev', 'npm run dev', 'git status']) {
    assertAllowed(harness.guard(bashExecution(command)), command);
  }
});

check('run_code 里藏着重命令也算重命令', () => {
  const harness = createHarness();
  const code = 'exec' + 'Sync("pnpm build");';
  assertDenied(harness.guard(runCodeExecution(code, SUBAGENT)), '子代理 run_code');
});

check('会话头没写委托深度时仍按主代理放行', async () => {
  const harness = createHarness();
  await startTurn(harness, '跑一下测试', 'msg-1', 1, TOP_LEVEL);
  assertAllowed(harness.guard(bashExecution('pnpm vitest', TOP_LEVEL)), '顶层会话');
});

check('会话头标了 origin=subagent 就算子代理', async () => {
  const harness = createHarness();
  await startTurn(harness, '跑一下测试', 'msg-1', 1, SUBAGENT_ORIGIN);
  assertDenied(harness.guard(bashExecution('pnpm vitest', SUBAGENT_ORIGIN)), 'origin=subagent');
});

check('读不到执行者是谁时不放行重命令', () => {
  const harness = createHarness();
  assertDenied(harness.guard(bashExecution('pnpm vitest', null)), '执行者未知');
});

check('只是聊构建不算同意跑构建', async () => {
  const harness = createHarness();
  await startTurn(harness, '看下构建配置在哪', 'msg-1', 1);
  assertDenied(harness.guard(bashExecution('pnpm build')), '只是聊构建');
});

check('「构建一下」算同意跑构建', async () => {
  const harness = createHarness();
  await startTurn(harness, '构建一下', 'msg-1', 1);
  assertAllowed(harness.guard(bashExecution('pnpm build')), '构建一下');
});

// ------------------------------------------------------ 重命令覆盖面

check('静态检查类的重命令也要授权', async () => {
  const harness = createHarness();
  await startTurn(harness, '跑一下代码检查', 'msg-1', 1);
  assertAllowed(harness.guard(bashExecution('pnpm eslint .')), 'eslint');
  assertDenied(harness.guard(bashExecution('pnpm eslint .')), '第二次 eslint');
});

check('同意跑测试不等于同意跑端到端', async () => {
  const harness = createHarness();
  await startTurn(harness, '跑一下测试', 'msg-1', 1);
  assertDenied(harness.guard(bashExecution('playwright test')), 'playwright');
});

check('构建器的 build 子命令算重命令,dev 不算', () => {
  const harness = createHarness();
  assertDenied(harness.guard(bashExecution('vite build')), 'vite build');
  assertAllowed(harness.guard(bashExecution('vite dev')), 'vite dev');
});

check('全仓编排器算重命令', () => {
  const harness = createHarness();
  assertDenied(harness.guard(bashExecution('turbo run build')), 'turbo');
});

check('本地 bin 目录里的 eslint 也算重命令', () => {
  const harness = createHarness();
  assertDenied(harness.guard(bashExecution('./node_modules/.bin/eslint .')), 'eslint bin');
});

check('包脚本按内容判定:脚本链里有构建就算重命令', async () => {
  const harness = createHarness();
  // 只同意静态检查:按内容判定出来的构建仍要单独授权。
  await startTurn(harness, '跑一下代码检查', 'msg-1', 1, PROJECT_AGENT);
  assertDenied(harness.guard(bashExecution('npm run verify', PROJECT_AGENT)), 'npm run verify');
  await startTurn(harness, '跑一下构建', 'msg-2', 2, PROJECT_AGENT);
  assertAllowed(harness.guard(bashExecution('npm run verify', PROJECT_AGENT)), 'npm run verify');
});

check('包脚本按内容判定:内容里没有重命令就放行', () => {
  const harness = createHarness();
  for (const command of ['npm run dev', 'npm run hello']) {
    assertAllowed(harness.guard(bashExecution(command, PROJECT_AGENT)), command);
  }
});

check('包脚本的名字本身是重命令名时按名字判定', async () => {
  const harness = createHarness();
  await startTurn(harness, '跑一下代码检查', 'msg-1', 1, PROJECT_AGENT);
  assertAllowed(harness.guard(bashExecution('npm run lint:fix', PROJECT_AGENT)), 'lint:fix');
});

check('子代理跑静态检查同样被拒绝', async () => {
  const harness = createHarness();
  await startTurn(harness, '跑一下代码检查', 'msg-1', 1);
  assertDenied(harness.guard(bashExecution('pnpm eslint .', SUBAGENT)), '子代理 eslint');
});

await runChecks();

if (failures.length > 0) {
  console.error(`✗ 硬指标守卫自检失败（${failures.length} 项）:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`✓ 硬指标守卫自检通过（${passed} 项）`);
