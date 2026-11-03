#!/usr/bin/env node
/**
 * scripts/autocomplete-check.mjs
 *
 * 「AI 自动补全」的自检（node scripts/autocomplete-check.mjs）。
 *
 * 覆盖三块：
 *   1. **纯计算** —— 候选怎么变成「插在输入框里的那一段」、对话上下文怎么摘、
 *      设置怎么夹边界。这些决定了用户按 Tab 之后看到什么，不能靠人记。
 *   2. **Host 行为** —— 模型不可用时安静退成「没有建议」；同一个草稿不重复花
 *      模型调用；同一个会话里旧请求被掐掉；设置能落盘再读回来。
 *   3. **路由** —— 四条路由的路径与方法固定（路径重复会让 webserver 直接 throw）。
 *
 * 落盘的读写只在一个**临时 DSH_HOME** 里做，绝不碰用户真实的设置。
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeCompletion, buildPrompt, lowestReasoningEffort, parseSuggestions } from '../src/host/features/autocomplete/analyze.js';
import { createOps } from '../src/host/features/autocomplete/ops.js';
import { createRouteSpecs } from '../src/host/features/autocomplete/server.js';
import { DEFAULT_SETTINGS, defaultsFromConfig, normalizeSettings } from '../src/host/features/autocomplete/settings.js';
import { callModelText } from '../src/host/shared/llm.js';
import { completionSuffix, contextFromChat, moveIndex } from '../src/client/features/autocomplete/complete.js';
import { modelOptions } from '../src/client/features/autocomplete/panel.js';

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
 * 假模型：按脚本吐出指定的文本。
 *
 * @param {string} text 模型输出。
 * @returns {object} 假的 llm 服务。
 */
function fakeLlm(text) {
  return {
    async *stream() {
      yield { type: 'text-delta', text: text };
    },
  };
}

/**
 * 记调用次数的假模型。
 *
 * @param {string} text 模型输出。
 * @returns {{llm: object, calls: number}} 假服务与计数器。
 */
function countingLlm(text) {
  const box = { calls: 0, llm: null };
  box.llm = {
    async *stream() {
      box.calls += 1;
      yield { type: 'text-delta', text: text };
    },
  };
  return box;
}

console.log('→ 纯计算：按 Tab 之后输入框里变成什么');
await check('草稿与候选有重叠时，只插重叠之后的那一段', () => {
  assert.equal(completionSuffix('帮我分析', '帮我分析这段代码的性能瓶颈'), '这段代码的性能瓶颈');
  assert.equal(completionSuffix('帮我', '帮我分析'), '分析');
  assert.equal(completionSuffix('a', 'abc'), 'bc');
});

await check('没有重叠时宁可不插（空串），不硬塞整句', () => {
  assert.equal(completionSuffix('写代码', '帮我分析这段代码'), '');
  assert.equal(completionSuffix('代码', '帮我分析这段代码'), '');
});

await check('空草稿时整条候选都算要插的内容', () => {
  assert.equal(completionSuffix('', '帮我查一下用量'), '帮我查一下用量');
  assert.equal(completionSuffix('   \n ', '帮我查一下用量'), '帮我查一下用量');
});

await check('只按最后一行找重叠（前一行不影响）', () => {
  assert.equal(completionSuffix('第一行\n帮我分析', '帮我分析这段代码'), '这段代码');
});

await check('候选是空串 / 不是字符串时什么都不插', () => {
  assert.equal(completionSuffix('帮我分析', '   '), '');
  assert.equal(completionSuffix('帮我分析', undefined), '');
});

console.log('');
console.log('→ 纯计算：对话上下文');
await check('从 Chat 快照里摘出用户与助手的文本', () => {
  const chat = {
    nodes: {
      values: () => [
        { kind: 'user', data: { content: [{ kind: 'text', text: '查一下用量' }] } },
        { kind: 'assistant-step', data: { blocks: [{ kind: 'text', text: '你有 3 个接口' }, { kind: 'image' }] } },
        { kind: 'tool', data: {} },
      ],
    },
  };
  assert.deepEqual(contextFromChat(chat, 4), [
    { role: 'user', text: '查一下用量' },
    { role: 'assistant', text: '你有 3 个接口' },
  ]);
});

await check('上下文条数上限生效，且只留最后几条', () => {
  const chat = {
    nodes: {
      values: () => [
        { kind: 'user', data: { content: [{ kind: 'text', text: '一' }] } },
        { kind: 'user', data: { content: [{ kind: 'text', text: '二' }] } },
        { kind: 'user', data: { content: [{ kind: 'text', text: '三' }] } },
      ],
    },
  };
  assert.deepEqual(contextFromChat(chat, 2), [{ role: 'user', text: '二' }, { role: 'user', text: '三' }]);
  assert.deepEqual(contextFromChat(chat, 0), []);
});

await check('快照形状不认识时安静返回空数组', () => {
  assert.deepEqual(contextFromChat(null, 4), []);
  assert.deepEqual(contextFromChat({}, 4), []);
  assert.deepEqual(contextFromChat({ nodes: {} }, 4), []);
});

await check('上下移动在高亮项上绕圈', () => {
  assert.equal(moveIndex(['a', 'b', 'c'], 2, 1), 0);
  assert.equal(moveIndex(['a', 'b', 'c'], 0, -1), 2);
  assert.equal(moveIndex([], 0, 1), 0);
});

console.log('');
console.log('→ 共享内核：模型调用的流协议（回归）');
await check('finish 之前先来一个 usage 块也不会炸（回归：|| 优先级写错那次）', async () => {
  // pi-ai 适配器在 finish 之前会先吐 usage 块。原来那行
  // `type==='finish' && reason.kind==='error' || reason.kind==='aborted'`
  // 里后半截没被 type 护住 → 对 usage 块去读 chunk.reason.kind → 当场抛
  // 「Cannot read properties of undefined (reading 'kind')」，
  // 于是**每一次**模型调用都死掉（用量查询的分析也一直在走兜底）。
  const llm = {
    async *stream() {
      yield { type: 'text-delta', text: '{"suggestions": ["帮我查用量"]}' };
      yield { type: 'usage', usage: { totalTokens: 12 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const text = await callModelText(llm, {
    provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  });
  assert.equal(text, '{"suggestions": ["帮我查用量"]}');
});

await check('finish 块没有 reason 时也不炸（当普通结束处理）', async () => {
  const llm = {
    async *stream() {
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'finish' };
    },
  };
  const text = await callModelText(llm, {
    provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  });
  assert.equal(text, 'ok');
});

await check('finish 说是 error 时如实报错', async () => {
  const llm = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'HTTP 429' } } };
    },
  };
  await assert.rejects(
    () => callModelText(llm, { provider: 'p', model: 'm', messages: [] }),
    /模型调用失败：HTTP 429/
  );
});

console.log('');
console.log('→ Host：速度（思考档位 / 输出量）');
await check('模型支持思考档位时挑最省力的那档', async () => {
  const llm = {
    async resolveModelInfo() {
      return { provider: 'p', id: 'm-low', name: 'm-low', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }] } };
    },
    async *stream() { yield { type: 'text-delta', text: '{}' }; },
  };
  assert.equal(await lowestReasoningEffort(llm, 'p', 'm-low'), 'low');
});

await check('模型不支持思考时不该传档位（传了 llm 服务会当场报错）', async () => {
  const llm = {
    async resolveModelInfo() { return { provider: 'p', id: 'm-nothink', name: 'm-nothink', reasoning: false }; },
    async *stream() { yield { type: 'text-delta', text: '{}' }; },
  };
  assert.equal(await lowestReasoningEffort(llm, 'p', 'm-nothink'), null);
});

await check('查不到档位时安静退成 null（旧版 llm 服务没有这个接口）', async () => {
  const llm = { async *stream() { yield { type: 'text-delta', text: '{}' }; } };
  assert.equal(await lowestReasoningEffort(llm, 'p', 'm-nomethod'), null);
});

await check('补全调用会把最省力的档位带上去', async () => {
  let seen = null;
  const llm = {
    async resolveModelInfo() {
      return { provider: 'p', id: 'm', name: 'm', reasoning: { efforts: [{ id: 'low', name: '低' }] } };
    },
    async *stream(options) {
      seen = options;
      yield { type: 'text-delta', text: '{"suggestions": ["好"]}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const result = await analyzeCompletion({ llm: llm, provider: 'p', model: 'm', draft: '帮', context: [], limit: 3 });
  assert.deepEqual(result.suggestions, ['好']);
  assert.equal(seen.reasoningEffort, 'low');
});

console.log('');
console.log('→ Host：空输入时的推荐要贴着上下文');
await check('空草稿的提示词要求贴着对话给具体候选', () => {
  const prompt = buildPrompt({
    draft: '',
    context: [{ role: 'assistant', text: '我把 boost.log 写到 $DSH_HOME 下了' }],
    limit: 3,
  });
  assert.ok(prompt.includes('boost.log'), '提示词里要有上下文');
  assert.ok(prompt.includes('具体'), '提示词里要要求具体');
  assert.ok(prompt.includes('还没开始打字'), '提示词里要说清是空输入');
});

await check('有草稿时提示词要求「接着写下去」', () => {
  const prompt = buildPrompt({ draft: '帮我分析', context: [], limit: 3 });
  assert.ok(prompt.includes('接着他写下去'), '提示词里要要求续写');
  assert.ok(!prompt.includes('还没开始打字'), '有草稿时不该走空输入那一支');
});

console.log('');
console.log('→ Host：设置的边界');
await check('越界的数字被夹回区间', () => {
  const settings = normalizeSettings({ maxSuggestions: 99, minChars: -5, debounceMs: 999999, contextMessages: 3.6 });
  assert.equal(settings.maxSuggestions, 5);
  assert.equal(settings.minChars, 0);
  assert.equal(settings.debounceMs, 5000);
  assert.equal(settings.contextMessages, 4);
});

await check('类型不对的字段退回默认值', () => {
  const settings = normalizeSettings({ enabled: 'yes', maxSuggestions: '三', allowMultiline: null });
  assert.equal(settings.enabled, DEFAULT_SETTINGS.enabled);
  assert.equal(settings.maxSuggestions, DEFAULT_SETTINGS.maxSuggestions);
  assert.equal(settings.allowMultiline, DEFAULT_SETTINGS.allowMultiline);
});

await check('配置里的 analysis 段决定默认模型', () => {
  const defaults = defaultsFromConfig({
    analysis: { provider: 'axzo-one', model: 'auto/deepseek-flash' },
    defaults: { maxSuggestions: 5 },
  });
  assert.equal(defaults.provider, 'axzo-one');
  assert.equal(defaults.model, 'auto/deepseek-flash');
  assert.equal(defaults.maxSuggestions, 5);
});

console.log('');
console.log('→ Host：候选的解析与降级');
await check('模型加的序号、引号、markdown 都被清掉', () => {
  const list = parseSuggestions(['1. "帮我查用量"', '- **帮我查用量**', '帮我查用量', '  '], 5);
  assert.deepEqual(list, ['帮我查用量']);
});

await check('候选条数按上限截断', () => {
  const list = parseSuggestions(['一', '二', '三', '四'], 2);
  assert.deepEqual(list, ['一', '二']);
});

await check('提示词里带上草稿与上下文', () => {
  const prompt = buildPrompt({
    draft: '帮我分析',
    context: [{ role: 'user', text: '看看这个项目' }],
    limit: 3,
  });
  assert.ok(prompt.includes('帮我分析'), '提示词里要有草稿');
  assert.ok(prompt.includes('看看这个项目'), '提示词里要有上下文');
  assert.ok(prompt.includes('3 条候选'), '提示词里要有条数');
});

await check('空草稿在提示词里说清楚是「还没输入」', () => {
  const prompt = buildPrompt({ draft: '', context: [], limit: 3 });
  assert.ok(prompt.includes('（还没输入）'));
});

await check('没有模型时安静退成空候选（不抛错）', async () => {
  const result = await analyzeCompletion({ llm: null, provider: 'p', model: 'm', draft: 'x', context: [], limit: 3 });
  assert.deepEqual(result.suggestions, []);
  assert.equal(result.source, 'none');
});

await check('模型只出散文时也退成空候选（不抛错）', async () => {
  const result = await analyzeCompletion({
    llm: fakeLlm('我觉得你可以这样写……'),
    provider: 'p', model: 'm', draft: 'x', context: [], limit: 3,
  });
  assert.deepEqual(result.suggestions, []);
});

await check('模型给出 JSON 时解析出候选', async () => {
  const result = await analyzeCompletion({
    llm: fakeLlm('{"suggestions": ["帮我查用量", "看看插件更新"]}'),
    provider: 'p', model: 'm', draft: '帮我', context: [], limit: 3,
  });
  assert.deepEqual(result.suggestions, ['帮我查用量', '看看插件更新']);
  assert.equal(result.source, 'model');
});

console.log('');
console.log('→ Host：门面（设置 / 缓存 / 掐旧请求）');

/**
 * 在一个**全新的**临时 DSH_HOME 里跑一段门面逻辑。
 *
 * 每个用例都要自己的目录 —— 设置是落盘的，前一个用例存的东西会渗到下一个
 * 用例里去（那正是「关掉功能就没有候选」这种用例最容易假通过的坑）。
 *
 * @param {Function} fn 拿到操作层后跑的逻辑。
 * @returns {Promise<void>} 完成。
 */
async function withOps(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dua-autocomplete-'));
  const realHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    await fn(dir);
  } finally {
    if (realHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = realHome;
    await rm(dir, { recursive: true, force: true });
  }
}

await check('设置能存能读（落在临时 DSH_HOME 里）', () => withOps(async () => {
  const ops = createOps({ env: process.env, llm: () => null, defaults: { ...DEFAULT_SETTINGS } });
  const before = await ops.settings();
  assert.equal(before.settings.maxSuggestions, 3);
  const saved = await ops.saveSettings({ maxSuggestions: 5, enabled: false });
  assert.equal(saved.settings.maxSuggestions, 5);
  assert.equal(saved.settings.enabled, false);
  const again = await ops.settings();
  assert.equal(again.settings.maxSuggestions, 5);
  assert.equal(again.settings.enabled, false);
}));

await check('越界的设置存不进去（存的是夹过的值）', () => withOps(async () => {
  const ops = createOps({ env: process.env, llm: () => null, defaults: { ...DEFAULT_SETTINGS } });
  const saved = await ops.saveSettings({ maxSuggestions: 99 });
  assert.equal(saved.settings.maxSuggestions, 5);
}));

await check('同一个草稿不重复花模型调用', () => withOps(async () => {
  const box = countingLlm('{"suggestions": ["帮我查用量"]}');
  const ops = createOps({
    env: process.env,
    llm: () => box.llm,
    defaults: { ...DEFAULT_SETTINGS, provider: 'p', model: 'm' },
  });
  const first = await ops.suggest({ sessionId: 's1', draft: '帮我', context: [], limit: 3 });
  const second = await ops.suggest({ sessionId: 's1', draft: '帮我', context: [], limit: 3 });
  assert.deepEqual(first.suggestions, ['帮我查用量']);
  assert.deepEqual(second.suggestions, ['帮我查用量']);
  assert.equal(box.calls, 1, '第二次应当命中缓存');
}));

await check('关掉功能就没有候选', () => withOps(async () => {
  const box = countingLlm('{"suggestions": ["帮我查用量"]}');
  const ops = createOps({
    env: process.env,
    llm: () => box.llm,
    defaults: { ...DEFAULT_SETTINGS, provider: 'p', model: 'm', enabled: false },
  });
  const result = await ops.suggest({ sessionId: 's2', draft: '帮我', context: [], limit: 3 });
  assert.deepEqual(result.suggestions, []);
  assert.equal(box.calls, 0);
}));

await check('太短的草稿不触发（省一次模型调用）', () => withOps(async () => {
  const box = countingLlm('{"suggestions": ["帮我查用量"]}');
  const ops = createOps({
    env: process.env,
    llm: () => box.llm,
    defaults: { ...DEFAULT_SETTINGS, provider: 'p', model: 'm', minChars: 5 },
  });
  const result = await ops.suggest({ sessionId: 's3', draft: '帮', context: [], limit: 3 });
  assert.deepEqual(result.suggestions, []);
  assert.equal(box.calls, 0);
}));

await check('多行草稿在关掉多行补全时不给候选', () => withOps(async () => {
  const box = countingLlm('{"suggestions": ["帮我查用量"]}');
  const ops = createOps({
    env: process.env,
    llm: () => box.llm,
    defaults: { ...DEFAULT_SETTINGS, provider: 'p', model: 'm', allowMultiline: false },
  });
  const result = await ops.suggest({ sessionId: 's4', draft: '第一行\n第二行', context: [], limit: 3 });
  assert.deepEqual(result.suggestions, []);
  assert.equal(box.calls, 0);
}));

await check('条数按设置的上限截断', () => withOps(async () => {
  const box = countingLlm('{"suggestions": ["一", "二", "三", "四", "五"]}');
  const ops = createOps({
    env: process.env,
    llm: () => box.llm,
    defaults: { ...DEFAULT_SETTINGS, provider: 'p', model: 'm', maxSuggestions: 2 },
  });
  const result = await ops.suggest({ sessionId: 's5', draft: '帮我', context: [], limit: 5 });
  assert.equal(result.suggestions.length, 2);
}));

console.log('');
console.log('→ 路由');
await check('四条路由的路径与方法固定', () => {
  const specs = createRouteSpecs({ ops: {}, base: '/dsh-usage-aggregator/autocomplete' });
  const map = specs.map((spec) => `${spec.method} ${spec.path}`).sort();
  assert.deepEqual(map, [
    'GET /dsh-usage-aggregator/autocomplete/models',
    'GET /dsh-usage-aggregator/autocomplete/settings',
    'POST /dsh-usage-aggregator/autocomplete/settings/save',
    'POST /dsh-usage-aggregator/autocomplete/suggest',
  ]);
});

await check('模型清单摊平成下拉选项', () => {
  const options = modelOptions([
    { id: 'axzo-one', name: 'AxzoOne', models: [{ id: 'auto/deepseek-flash', name: 'auto/deepseek-flash' }] },
    { id: 'empty', name: '空', models: [] },
  ]);
  assert.deepEqual(options, [
    { value: 'axzo-one\u0000auto/deepseek-flash', label: 'AxzoOne · auto/deepseek-flash', group: 'AxzoOne' },
  ]);
});

console.log('');
if (failures.length > 0) {
  console.error(`✗ 有 ${failures.length} 项未通过：`);
  for (const failure of failures) console.error(`  - ${failure.name}: ${failure.error.message}`);
  process.exit(1);
}
console.log(`✓ 自动补全自检通过（${passed} 项）`);
