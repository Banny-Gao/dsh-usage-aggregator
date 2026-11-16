/**
 * 硬指标守卫:把《硬指标手册》的「硬禁令」从提示层落到工具执行层。
 *
 * 职责:
 *   1. 绝对拦截会丢弃工作区改动的 git 命令(`git checkout --` / `git checkout .` /
 *      `git restore` / `git reset --hard` / `git clean -f` / `git stash`),手册
 *      「硬禁令」第二条,没有任何授权例外。
 *   2. 拦截 `git commit` / `git push`;只有用户本轮显式授权对应动作时才放行,
 *      且每个动作的授权各只够用一次(手册「硬禁令」第一条)。
 *   3. 拦截重命令(类型检查 / 静态检查 / 全量测试 / 端到端测试 / 构建):子代理一律
 *      不跑;主代理每跑一次都要有用户本轮的明确同意,一次同意只够跑一次
 *      (手册「硬禁令」第三条)。
 *
 * 实现原理:
 *   - 用 `ctx.tools.guard()` 注册单调守卫:返回字符串即拒绝并作为拒绝理由,
 *     后续监听器无法推翻已发生的拒绝。
 *   - 守卫在 preset scope 注册;preset scope 是使用该预设的 agent scope 的祖先,
 *     工具运行时按 agent 的 scope 链查找守卫层,因此本守卫只对本预设的会话生效。
 *   - 授权来源只有用户本人的消息(`source.kind === 'user'`)。助手自述、子代理转发
 *     (agent-message / team-message)、计划、目标、定时任务等来源都不是用户表态,
 *     一律不构成授权。
 *   - 提问卡片(`ask_user_question`)的答案有两种回法:工具结果(`tools/result`)与一条
 *     `user-question-reply` 用户消息。两者正文都带着问题全文与全部选项,
 *     因此只取用户**选中**的那些项;两条路径按同一个 `question:<callId>` 记账,
 *     一次点击只算一次授权。
 *   - 授权判定是意图判定而非关键词命中:先按句切分,再按分句边界把句子拆成小段,
 *     动作词只在自己的小段里判定——否定式(不要/未/没有/尚未…)与谈论词
 *     (什么/是否/历史/已经…)只否定它们所在的那一段,不会连坐同一句里的其他动作。
 *     所以「提交,然后继续深入分析是否…」里的「提交」仍然算授权。
 *   - 重命令按类别授权(类型检查 / 静态检查 / 测试 / 端到端 / 构建):用户同意跑测试
 *     不等于同意构建。
 *   - 重命令的识别先看命令本身(二进制、子命令、包脚本名),再看包脚本的脚本体:
 *     名字看不出轻重的自定义脚本(verify / ci / check…)会读项目 package.json 里的
 *     脚本体,脚本体里或它引用的仓库脚本文件里有重命令就算重命令。
 *   - 主代理与子代理的判据是会话的委托深度:顶层会话为 0,子代理会话为父会话 +1
 *     (与 dsh-subagent 的 delegationDepthOf 同源:读不到深度按 0 算),会话头标了
 *     origin=subagent 也算子代理;连执行者是谁都读不到才不放行。
 *   - 扣减授权是先验后扣:整条命令需要的动作都拿到可用授权才扣;否则命令本身没有
 *     执行,授权也不能被这一次失败的执行烧掉。
 *   - `agent/pre-step` 是 waterfall 事件:监听器不调用 `next()` 就会截断链条,
 *     外层监听器拿到的 decision 会变成 undefined。因此这里必须把 `next()` 的
 *     结果原样交回,只做「记录授权」这一件事。
 *
 * 本文件由本包以 exports 子路径 `./preset-guard` 暴露,供预设 `hard-metrics` 引用。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 插件名。 */
export const name = 'hard-metrics-guard';

/** 需要注入的服务:工具运行时。 */
export const inject = ['tools'];

/** 提问卡片工具名:它的结果里带用户选中的答案。 */
const QUESTION_TOOL = 'ask_user_question';

/**
 * 动作与用户授权词的对应关系。
 *
 * 每个动作的授权各只够用一次;这里只放「用户明确点名这个动作」的词,
 * 日常措辞不构成授权。
 */
const ACTION_WORDS = [
  { action: 'commit', words: /提交|\bcommit\b/i },
  { action: 'push', words: /推送|\bpush\b/i },
];
/**
 * 重命令的类别:授权按类别给,同意跑测试不等于同意构建。
 *
 * 类别名同时是授权表里的动作名,所以「跑一次」的记账与 commit / push 同一套机制。
 */
const HEAVY_TARGETS = [
  { kind: 'heavy:typecheck', words: /(?:类型检查|类型校验|类型核对|vue-tsc|svelte-check|\btsc\b|typecheck|type-check)/i },
  { kind: 'heavy:e2e', words: /(?:端到端|e2e|浏览器测试|集成测试|playwright|cypress)/i },
  { kind: 'heavy:test', words: /(?:单元测试|单测|测试|用例|vitest|jest|mocha|\btests?\b)/i },
  { kind: 'heavy:lint', words: /(?:代码检查|静态检查|规范检查|代码风格|格式检查|格式化|lint|eslint|stylelint|biome|prettier|oxlint)/i },
  { kind: 'heavy:build', words: /(?:构建|编译|打包|\bbuild\b)/i },
];

/**
 * 用户点名要跑重活时说的动词。
 *
 * 「构建 / 编译 / 打包」只在带「一下」这类副词时才算动词:光说「构建脚本在哪」
 * 是在聊,不是在让谁去跑 —— 宁可少给一次授权,也不要凭空多给。
 */
const HEAVY_VERB = /(?:跑一?下|跑个|跑|运行|执行一?下|执行|试一?下|试试|过一遍|走一遍|来一遍|构建一?下|编译一?下|打包一?下|检查一?下|校验一?下|格式化一?下|规范一?下|\brun\b|\bbuild\b|\btest\b|\blint\b|\bexecute\b)/i;

/** 直接调用的重工具 → 重命令类别。 */
const HEAVY_TOOLS = new Map([
  ['vue-tsc', 'heavy:typecheck'],
  ['tsc', 'heavy:typecheck'],
  ['svelte-check', 'heavy:typecheck'],
  ['eslint', 'heavy:lint'],
  ['stylelint', 'heavy:lint'],
  ['biome', 'heavy:lint'],
  ['oxlint', 'heavy:lint'],
  ['prettier', 'heavy:lint'],
  ['vitest', 'heavy:test'],
  ['jest', 'heavy:test'],
  ['mocha', 'heavy:test'],
  ['playwright', 'heavy:e2e'],
  ['cypress', 'heavy:e2e'],
  ['webpack', 'heavy:build'],
  ['rollup', 'heavy:build'],
  ['esbuild', 'heavy:build'],
  ['parcel', 'heavy:build'],
  ['rspack', 'heavy:build'],
]);

/** 带子命令的构建器:只有「构建」这个子命令才算重命令(开发服务器不算)。 */
const HEAVY_TOOL_SUBCOMMANDS = new Map([
  ['vite', 'build'],
  ['next', 'build'],
  ['ng', 'build'],
  ['astro', 'build'],
  ['remix', 'build'],
  ['svelte-kit', 'build'],
  ['vue-cli-service', 'build'],
  ['storybook', 'build'],
]);

/** 全仓编排器:一次调用就是整个仓库的活,一律算重命令。 */
const HEAVY_MONOREPO_RUNNERS = new Set(['turbo', 'nx']);

/** 包管理器脚本名 → 重命令类别。 */
const HEAVY_SCRIPTS = [
  { kind: 'heavy:typecheck', pattern: /^(?:typecheck|type-check|check-types?|types|tsc)(?:[:@][\w.-]+)?$/ },
  { kind: 'heavy:e2e', pattern: /^(?:e2e|e2e:[A-Za-z0-9_.-]+|cypress|playwright|integration|test-e2e)(?:[:@][\w.-]+)?$/ },
  { kind: 'heavy:test', pattern: /^(?:test|tests|unit|unit-test|vitest|jest)(?:[:@][\w.-]+)?$/ },
  { kind: 'heavy:lint', pattern: /^(?:lint|eslint|stylelint|format|prettier|biome|check-format|oxlint)(?:[:@][\w.-]+)?$/ },
  { kind: 'heavy:build', pattern: /^(?:build|compile|bundle|dist|storybook:build)(?:[:@][\w.-]+)?$/ },
];

/** 读到的项目脚本缓存:cwd → { mtimeMs, scripts }。 */
const scriptCache = new Map();

/** 扫引用的脚本文件时的体积上限:太大的文件不读,免得拖慢守卫。 */
const MAX_SCRIPT_BYTES = 256 * 1024;

/**
 * 读项目 package.json 里的 scripts。
 *
 * 只在脚本名本身看不出轻重时才用:项目自定义的名字(check / verify / ci…)背后
 * 往往就是一整条重命令链,光看名字看不出来。
 *
 * @param {string|undefined} cwd 会话工作目录。
 * @returns {Record<string, string>} scripts 表;读不到时是空对象。
 */
function projectScripts(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return {};
  const file = path.join(cwd, 'package.json');
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return {};
  }
  const cached = scriptCache.get(cwd);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.scripts;
  let scripts = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.scripts === 'object' && parsed.scripts !== null) {
      scripts = Object.fromEntries(Object.entries(parsed.scripts).filter(([, value]) => typeof value === 'string'));
    }
  } catch {
    scripts = {};
  }
  scriptCache.set(cwd, { mtimeMs, scripts });
  return scripts;
}

/**
 * 脚本体里引用的仓库脚本文件(只认相对路径,且必须留在项目里)。
 *
 * @param {string} body 脚本文本。
 * @param {string} cwd 项目目录。
 * @returns {string[]} 绝对路径列表。
 */
function referencedFiles(body, cwd) {
  const root = path.resolve(cwd);
  const files = [];
  for (const match of body.matchAll(/[A-Za-z0-9_./@-]+[.](?:sh|mjs|cjs|js|ts)(?![A-Za-z0-9_])/g)) {
    const relative = match[0];
    if (relative.startsWith('/')) continue;
    const full = path.resolve(root, relative);
    if (!full.startsWith(root + path.sep)) continue;
    files.push(full);
  }
  return files;
}

/**
 * 这个包脚本是不是重命令;是的话是哪一类。
 *
 * 先看脚本名(约定俗成的名字直接认),再看脚本体(项目自定义的名字靠内容认)。
 *
 * @param {string} name 脚本名。
 * @param {{cwd?: string, depth?: number}} context 上下文。
 * @returns {string|undefined} 重命令类别。
 */
function scriptKind(name, context) {
  for (const { kind, pattern } of HEAVY_SCRIPTS) {
    if (pattern.test(name)) return kind;
  }
  const depth = context?.depth ?? 0;
  if (depth >= 2) return undefined;
  const cwd = context?.cwd;
  const body = projectScripts(cwd)[name];
  if (typeof body !== 'string') return undefined;
  return bodyKind(body, { cwd, depth: depth + 1 });
}

/**
 * 脚本体里有没有重命令:本体里直接有,或者本体引用的仓库脚本文件里有。
 *
 * @param {string} body 脚本文本。
 * @param {{cwd?: string, depth?: number}} context 上下文。
 * @returns {string|undefined} 重命令类别。
 */
function bodyKind(body, context) {
  const inner = heavyCommands({ name: 'bash', arguments: { command: body } }, context);
  if (inner.length > 0) return inner[0].kind;
  const cwd = context?.cwd;
  if (typeof cwd !== 'string') return undefined;
  for (const file of referencedFiles(body, cwd)) {
    let content;
    try {
      if (fs.statSync(file).size > MAX_SCRIPT_BYTES) continue;
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const nested = heavyCommands({ name: 'bash', arguments: { command: content } }, { cwd, depth: (context?.depth ?? 0) + 1 });
    if (nested.length > 0) return nested[0].kind;
  }
  return undefined;
}

/** 能把命令包起来的包装器,包完还是同一条命令。 */
const WRAPPER_COMMANDS = new Set(['sudo', 'doas', 'nohup', 'time', 'nice', 'ionice', 'xargs', 'env', 'stdbuf', 'setsid', 'command', 'exec']);

/** 带执行前缀的包管理器:前缀后面跟的是被执行的二进制。 */
const RUNNER_PREFIXES = new Set(['pnpm exec', 'pnpm dlx', 'yarn dlx', 'bun x']);

/** 包管理器:脚本名在它们自己的命令行里。 */
const PACKAGE_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'bunx', 'npx']);

/** 包管理器的全局选项:跳过它们才轮到脚本名。 */
const FLAG_WITH_VALUE = new Set(['-C', '--dir', '--filter', '-F', '-w', '--workspace', '--project', '-p', '--scope']);

/** 动词之前出现这些词,表示这件事没被要求做。 */
const NEGATION_BEFORE = /(?:不要|不用|不需要|无需|不必|甭|别|勿|禁止|不能|不可|没有|还没|尚未|未(?:必)?|不|无|莫|免得)(?:再|先|急着|轻易|乱)?\s*$/;

/** 英文否定式:出现在动词之前表示这件事没被要求做。 */
const NEGATION_BEFORE_EN = /\b(?:do not|don't|never|no|not|without|cannot|can not|will not|won't)\s*$/i;

/**
 * 小段里出现这些词,说明只是在校验这个动作本身,而不是在要求它。
 *
 * 只否定所在的那一小段,不会连坐同一句里的其他动作。
 */
const MENTION_IN_CLAUSE = /什么|怎么|如何|是否|是不是|吗|意思|含义|历史|记录|刚才|已经|曾经|以前|过去|之前|之后|日志|[?？]/;

/**
 * 重命令的谈论词:顺序词(之前 / 之后)不影响「要不要跑」的表态,只留纯粹的讨论词。
 */
const MENTION_IN_HEAVY_CLAUSE = /什么|怎么|如何|是否|是不是|吗|意思|含义|历史|记录|刚才|已经|曾经|以前|过去|日志|[?？]/;

/**
 * 句内的小段边界:动作词、谈论词、否定式各在自己的小段里判定。
 *
 * 逗号、顿号是天然边界;「然后 / 并 / 再 / 接着…」把一句话拆成动作序列,
 * 所以「提交,然后继续深入分析是否…」里「提交」与「是否…」不在同一段。
 */
const SEGMENT_BOUNDARY = /[，,、]|(?:并且|然后|接着|随后|同时|以及|而且|还有|另外|顺便|并|再)/g;

/** 把文本按句切分:授权判定在句子里做,避免跨句误判。 */
function clauses(text) {
  return text
    .split(/[。；;！!？?\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

/**
 * 把一句话拆成小段,返回每段在原句里的起止位置。
 *
 * @param {string} clause 一句话。
 * @returns {{start: number, end: number}[]} 小段位置。
 */
function segmentsOf(clause) {
  const segments = [];
  const pattern = new RegExp(SEGMENT_BOUNDARY.source, 'g');
  let start = 0;
  let match;
  while ((match = pattern.exec(clause)) !== null) {
    if (match.index > start) segments.push({ start, end: match.index });
    start = match.index + match[0].length;
  }
  if (start < clause.length) segments.push({ start, end: clause.length });
  return segments;
}

/**
 * 这个位置之前有没有否定式。
 *
 * 否定式看的是整句里动作词之前的尾巴(最近的逗号之后):否定与被否定的动作
 * 可以隔着一个小段边界,但距离不会太远。
 *
 * @param {string} clause 一句话。
 * @param {number} index 动作词在句中的位置。
 * @returns {boolean} 有否定式。
 */
function negated(clause, index) {
  const before = clause.slice(0, index);
  const tail = before.slice(Math.max(0, before.lastIndexOf(',') + 1)).slice(-12);
  return NEGATION_BEFORE.test(tail) || NEGATION_BEFORE_EN.test(tail);
}

/**
 * 这段文本授权了哪些动作。
 *
 * @param {string} text 原始文本。
 * @returns {Set<string>} 授权动作集合;空集合表示不构成授权。
 */
function grantedActions(text) {
  const actions = new Set();
  if (typeof text !== 'string' || text.length === 0) return actions;
  for (const clause of clauses(text)) {
    for (const segment of segmentsOf(clause)) {
      const body = clause.slice(segment.start, segment.end);
      if (MENTION_IN_CLAUSE.test(body)) continue;
      for (const { action, words } of ACTION_WORDS) {
        const pattern = new RegExp(words.source, `${words.flags}g`);
        for (const match of body.matchAll(pattern)) {
          if (negated(clause, segment.start + match.index)) continue;
          actions.add(action);
        }
      }
    }
  }
  return actions;
}

/**
 * 这段文字授权了哪些重命令类别。
 *
 * @param {string} text 原始文本。
 * @returns {Set<string>} 重命令类别集合。
 */
function grantedHeavy(text) {
  const kinds = new Set();
  if (typeof text !== 'string' || text.length === 0) return kinds;
  for (const clause of clauses(text)) {
    for (const segment of segmentsOf(clause)) {
      const body = clause.slice(segment.start, segment.end);
      if (MENTION_IN_HEAVY_CLAUSE.test(body)) continue;
      const verb = HEAVY_VERB.exec(body);
      if (verb === null) continue;
      if (negated(clause, segment.start + verb.index)) continue;
      for (const { kind, words } of HEAVY_TARGETS) {
        if (words.test(body)) kinds.add(kind);
      }
    }
  }
  return kinds;
}

/**
 * 这段文字总共授权了哪些动作(提交 / 推送 / 重命令类别)。
 *
 * @param {string} text 原始文本。
 * @returns {Set<string>} 授权动作集合。
 */
function granted(text) {
  const actions = grantedActions(text);
  for (const kind of grantedHeavy(text)) actions.add(kind);
  return actions;
}

/**
 * 从卡片答案里取用户**选中**的文本。
 *
 * @param {unknown} payload 已解析的 JSON 载荷。
 * @returns {string[]} 选中的选项文案与自由填写文本。
 */
function selectedTexts(payload) {
  const answers = payload?.answers;
  if (!Array.isArray(answers)) return [];
  const texts = [];
  for (const answer of answers) {
    for (const selected of answer?.selected ?? []) {
      if (typeof selected === 'string') texts.push(selected);
    }
    if (typeof answer?.custom === 'string' && answer.custom.length > 0) texts.push(answer.custom);
  }
  return texts;
}

/**
 * 取出消息或工具结果里的文本块。
 *
 * @param {object} value 消息或工具结果。
 * @returns {string} 拼接后的文本;没有文本块时是空串。
 */
function textOf(value) {
  const content = value?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * 解析 JSON 文本;不是合法 JSON 时返回 null(不拿原文当答案)。
 *
 * @param {string} text 原始文本。
 * @returns {unknown} 解析结果或 null。
 */
function parseJson(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 把 shell 文本切成便于找 git 子命令的片段。 */
function splitSegments(text) {
  return text
    .replace(/\$\(/g, '; ')
    .replace(/`/g, '; ')
    .split(/;|\n|&&|\|\||\||&/g);
}

/** 去掉 token 两端的引号与收尾标点。 */
function cleanToken(token) {
  return token.replace(/^["'`]+/, '').replace(/["'`)]+$/, '').replace(/[);,]+$/, '');
}
/**
 * run_code 里出现这些词,才可能藏着重命令。
 */
const HEAVY_HINT = /\b(?:vue-tsc|tsc|vitest|jest|mocha|vite|npm|pnpm|yarn|bun|bunx|npx|eslint|stylelint|biome|prettier|oxlint|playwright|cypress|webpack|rollup|esbuild|parcel|rspack|turbo|nx|next|ng|astro|lint)\b|构建|编译|打包|测试|检查|格式化/;

/**
 * 从一次工具执行里取出可能包含重命令的文本。
 *
 * @param {object} execution 工具执行。
 * @returns {string[]} 命令文本。
 */
function heavyCommandTexts(execution) {
  const args = execution?.arguments;
  if (typeof args !== 'object' || args === null) return [];
  if (execution.name === 'bash' || execution.name === 'pwsh') {
    return typeof args.command === 'string' ? [args.command] : [];
  }
  if (execution.name === 'run_code') {
    const code = typeof args.code === 'string' ? args.code : '';
    if (!/\b(?:child_process|execSync|spawnSync|execFileSync|spawn)\b/.test(code)) return [];
    return (code.match(/[`\'"][^`\'"\n]{0,400}[`\'"]/g) ?? [])
      .map((literal) => literal.slice(1, -1))
      .filter((literal) => HEAVY_HINT.test(literal));
  }
  return [];
}

/**
 * 这一段命令是不是重命令;是的话是哪一类。
 *
 * @param {string[]} tokens 一段命令的 token。
 * @returns {{kind: string, name: string} | undefined} 重命令。
 */
function heavyCommandOf(tokens, context) {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    if (WRAPPER_COMMANDS.has(token)) {
      index += 1;
      continue;
    }
    const prefix = token + ' ' + (tokens[index + 1] ?? '');
    if (RUNNER_PREFIXES.has(prefix)) {
      index += 2;
      continue;
    }
    break;
  }
  const command = tokens[index];
  if (command === undefined) return undefined;

  // 直接调用的二进制:允许带路径前缀(./node_modules/.bin/eslint)。
  const binary = command.slice(command.lastIndexOf('/') + 1);
  const tool = HEAVY_TOOLS.get(binary);
  if (tool !== undefined) return { kind: tool, name: binary };
  if (HEAVY_MONOREPO_RUNNERS.has(binary)) return { kind: 'heavy:build', name: binary };
  const subcommand = HEAVY_TOOL_SUBCOMMANDS.get(binary);
  if (subcommand !== undefined) {
    const next = tokens[index + 1] === undefined ? undefined : cleanToken(tokens[index + 1]);
    return next === subcommand ? { kind: 'heavy:build', name: binary + ' ' + subcommand } : undefined;
  }
  if (!PACKAGE_RUNNERS.has(command)) return undefined;

  let cursor = index + 1;
  while (cursor < tokens.length && tokens[cursor].startsWith('-')) {
    const flag = tokens[cursor];
    cursor += 1;
    if (FLAG_WITH_VALUE.has(flag)) cursor += 1;
  }
  let script = tokens[cursor];
  if (script === undefined) return undefined;

  if (script === 'run' || script === 'run-script') {
    script = tokens[cursor + 1];
    if (script === undefined) return undefined;
  } else if (script === 'exec' || script === 'dlx' || script === 'x') {
    const binary = tokens[cursor + 1];
    if (binary === undefined) return undefined;
    const binaryName = binary.slice(binary.lastIndexOf('/') + 1);
    const binaryKind = HEAVY_TOOLS.get(binaryName);
    if (binaryKind !== undefined) return { kind: binaryKind, name: binary };
    const binarySub = HEAVY_TOOL_SUBCOMMANDS.get(binaryName);
    if (binarySub !== undefined) {
      const next = tokens[cursor + 2] === undefined ? undefined : cleanToken(tokens[cursor + 2]);
      return next === binarySub ? { kind: 'heavy:build', name: binary + ' ' + binarySub } : undefined;
    }
    return undefined;
  }

  const scriptTool = HEAVY_TOOLS.get(script.slice(script.lastIndexOf('/') + 1));
  if (scriptTool !== undefined) return { kind: scriptTool, name: script };
  const kind = scriptKind(script, context);
  return kind === undefined ? undefined : { kind, name: script };
}

/**
 * 这次工具执行里有哪些重命令。
 *
 * @param {object} execution 工具执行。
 * @returns {{kind: string, name: string}[]} 重命令列表。
 */
function heavyCommands(execution, context) {
  const found = [];
  for (const text of heavyCommandTexts(execution)) {
    for (const segment of splitSegments(text)) {
      const tokens = segment.trim().split(/\s+/).filter((token) => token.length > 0).map(cleanToken);
      if (tokens.length === 0) continue;
      const heavy = heavyCommandOf(tokens, context);
      if (heavy !== undefined) found.push(heavy);
    }
  }
  return found;
}

/**
 * 当前执行者的委托深度:0 是主代理,大于 0 是子代理。
 *
 * 与 dsh-subagent 的 delegationDepthOf 同源:会话头里的 delegationDepth 是权威值,
 * 运行期 options.subagentDepth 只能把它加深;两处都读不到时按 0 算 —— 顶层会话
 * 本来就没有这个字段,把它当成读不到会误伤主代理。
 *
 * @param {object} agent 工具执行背后的 agent。
 * @returns {number} 委托深度。
 */
function delegationDepthOf(agent) {
  const headerDepth = agent?.session?.header?.delegationDepth;
  const runtimeDepth = agent?.options?.subagentDepth;
  const header = typeof headerDepth === 'number' ? headerDepth : 0;
  const runtime = typeof runtimeDepth === 'number' ? runtimeDepth : 0;
  return Math.max(header, runtime);
}

/**
 * 这个执行者是不是子代理:委托深度大于 0,或者会话头自己标了 origin=subagent。
 *
 * @param {object} agent 工具执行背后的 agent。
 * @returns {boolean} 是否子代理。
 */
function isSubagentAgent(agent) {
  if (delegationDepthOf(agent) > 0) return true;
  return agent?.session?.header?.origin === 'subagent';
}

/** 这个 token 是不是 git 可执行文件(允许带路径前缀)。 */
function isGitToken(token) {
  const cleaned = cleanToken(token);
  return cleaned.slice(cleaned.lastIndexOf('/') + 1) === 'git';
}

/**
 * 从 shell 文本里找出 git 及其子命令。
 *
 * git 出现在段落的哪个位置都要认:`bash -c "git commit"`、`sudo git commit`、
 * `env FOO=1 git commit`、`xargs git commit`、`find . -exec git commit` 都会命中。
 *
 * @param {string} text shell 文本。
 * @returns {{sub: string, args: string[]}[]} git 调用列表。
 */
function gitInvocations(text) {
  const found = [];
  for (const segment of splitSegments(text)) {
    const tokens = segment.trim().split(/\s+/).filter((token) => token.length > 0);
    const start = tokens.findIndex((token) => isGitToken(token));
    if (start === -1) continue;
    let cursor = start + 1;
    while (cursor < tokens.length && tokens[cursor].startsWith('-')) {
      const flag = tokens[cursor];
      cursor += 1;
      if (/^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path)$/.test(flag)) cursor += 1;
    }
    if (cursor >= tokens.length) continue;
    found.push({ sub: cleanToken(tokens[cursor]), args: tokens.slice(cursor + 1).map(cleanToken) });
  }
  return found;
}

/**
 * 从一次工具执行里取出可能包含 shell 命令的文本。
 *
 * @param {object} execution 工具执行。
 * @returns {string[]} 命令文本。
 */
function commandTexts(execution) {
  const args = execution?.arguments;
  if (typeof args !== 'object' || args === null) return [];
  if (execution.name === 'bash' || execution.name === 'pwsh') {
    return typeof args.command === 'string' ? [args.command] : [];
  }
  if (execution.name === 'run_code') {
    const code = typeof args.code === 'string' ? args.code : '';
    if (!/\b(?:child_process|execSync|spawnSync|execFileSync|spawn)\b/.test(code)) return [];
    return (code.match(/[`'"][^`'"\n]{0,400}[`'"]/g) ?? [])
      .map((literal) => literal.slice(1, -1))
      .filter((literal) => /\bgit\b/.test(literal));
  }
  return [];
}

/**
 * 这个 git 调用会不会丢弃或移走工作区改动。
 *
 * 判定口径与手册一致:工作区改动只能由用户决定怎么处置,助手不得自行丢。
 * `git stash pop` / `apply` 是把改动放回工作区,不在此列。
 *
 * @param {{sub: string, args: string[]}} invocation git 调用。
 * @returns {boolean} 是否丢弃工作区改动。
 */
function destroysWorktree(invocation) {
  const { sub, args } = invocation;
  if (sub === 'checkout') {
    if (args.includes('--')) return true;
    // `.` / `*` 一定是工作区路径;带扩展名的路径(如 src/app.ts)也一样;
    // 只有斜杠没有扩展名的多半是分支名(feature/x),不算丢弃改动。
    return args.some((arg) => arg === '.' || arg === '*' || (arg.includes('/') && /\.[A-Za-z0-9]+$/.test(arg)));
  }
  if (sub === 'restore') return !args.includes('--staged');
  if (sub === 'reset') return args.includes('--hard');
  if (sub === 'clean') return args.some((arg) => /^(-[a-z]*f|--force)/.test(arg));
  if (sub === 'stash') {
    const action = args.find((arg) => !arg.startsWith('-'));
    return action === undefined || action === 'push' || action === 'drop' || action === 'clear';
  }
  return false;
}

/** 子代理跑重命令时的拒绝理由。 */
const DENY_HEAVY_SUBAGENT = '硬指标禁令:子代理不得执行重命令(类型检查 / 静态检查 / 全量测试 / 端到端测试 / 构建)。请把它交回主代理,由主代理征得用户同意后执行。';

/** 未获用户同意时拒绝的重命令。 */
const DENY_HEAVY_NO_CONSENT = '硬指标禁令:本轮没有得到用户对重命令(类型检查 / 静态检查 / 全量测试 / 端到端测试 / 构建)的同意,已拒绝执行。请先用提问卡片征得用户同意;一次同意只够跑一次,同意跑测试不等于同意构建。';

/** 判不出主代理时拒绝的重命令。 */
const DENY_HEAVY_UNKNOWN = '硬指标禁令:读不到当前执行者的会话信息,无法确认它是不是主代理,已拒绝执行重命令。';

/** 丢弃工作区改动的拒绝理由。 */
const DENY_DESTRUCTIVE = '硬指标禁令:绝对禁止执行会丢弃工作区改动的 git 命令(`git checkout --` / `git checkout .` / `git restore` / `git reset --hard` / `git clean -f` / `git stash`)。请保留工作区改动,改用可回退的方式处理,并把如何恢复交给用户决定。';

/** 未获本轮授权时拒绝的命令。 */
const DENY_UNAUTHORIZED = '硬指标禁令:本轮没有用户显式的提交/推送授权,已拒绝执行 git commit / git push。请在回复里说明将要提交什么,并请用户明确说「提交 / commit / 推送」;「批准方案」「按推荐」「可以」「继续」都不构成授权。';

/**
 * 挂载守卫。
 *
 * @param {object} ctx Cordis 上下文(preset scope)。
 */
export function apply(ctx) {
  /**
   * agent 标识 -> { turn, grants:Map<key, { granted:Set<string>, used:Set<string> }> }
   *
   * 一条授权记录 = 一次表态(key 是消息 id 或 `question:<callId>`),
   * 每个动作在这次表态里各能用一次。
   */
  const states = new Map();

  const stateOf = (agent) => {
    const key = typeof agent?.id === 'string' ? agent.id : agent;
    if (key === undefined || key === null) return undefined;
    let state = states.get(key);
    if (state === undefined) {
      state = { turn: undefined, grants: new Map() };
      states.set(key, state);
    }
    return state;
  };

  /** 进入新一轮:上一轮的授权作废。 */
  const beginTurn = (state, turn) => {
    if (turn === undefined) return;
    if (state.turn !== undefined && state.turn !== turn) state.grants.clear();
    state.turn = turn;
  };

  /** 记住一次表态;同一 key 重复到达只补齐动作,不会重复计数。 */
  const remember = (state, key, actions) => {
    if (typeof key !== 'string' || actions.size === 0) return;
    const entry = state.grants.get(key);
    if (entry === undefined) {
      state.grants.set(key, { granted: new Set(actions), used: new Set() });
      return;
    }
    for (const action of actions) entry.granted.add(action);
  };

  /**
   * 记录一条消息里的表态。
   *
   * @param {object} state 该 agent 的状态。
   * @param {object} message 消息。
   */
  const record = (state, message) => {
    const kind = message?.source?.kind;
    if (kind === 'user') {
      remember(state, message.id, granted(textOf(message)));
      return;
    }
    // 提问卡片的答复消息:正文里带问题全文与全部选项,只能取用户选中的那些。
    if (kind === 'user-question-reply') {
      const payload = parseJson(textOf(message));
      const callId = payload?.callId;
      if (typeof callId !== 'string') return;
      const actions = new Set();
      for (const selected of selectedTexts(payload)) {
        for (const action of granted(selected)) actions.add(action);
      }
      remember(state, `question:${callId}`, actions);
    }
  };

  ctx.on('agent/pre-step', async (payload, next) => {
    if (payload) {
      const state = stateOf(payload.agent);
      if (state !== undefined) {
        beginTurn(state, payload.turn);
        for (const message of payload.messages ?? []) record(state, message);
      }
    }
    if (typeof next !== 'function') return undefined;
    return next();
  });

  ctx.on('agent/inbox/inserted', (payload) => {
    if (!payload) return;
    const state = stateOf(payload.agent);
    if (state === undefined) return;
    record(state, payload.message);
  });

  // 提问卡片的答案以工具结果回来:选中的选项就是用户当轮的表态,同样算授权来源。
  ctx.on('tools/result', (execution, result) => {
    if (execution?.name !== QUESTION_TOOL) return;
    if (result?.isError === true) return;
    const state = stateOf(execution.agent);
    if (state === undefined) return;
    const actions = new Set();
    for (const selected of selectedTexts(parseJson(textOf(result)))) {
      for (const action of granted(selected)) actions.add(action);
    }
    remember(state, `question:${execution.callId}`, actions);
  });

  ctx.on('agent/disposed', (payload) => {
    const key = typeof payload?.agent?.id === 'string' ? payload.agent.id : payload?.agent;
    if (key !== undefined && key !== null) states.delete(key);
  });

  ctx.tools.guard((execution) => {
    const state = stateOf(execution.agent);
    const invocations = commandTexts(execution).flatMap(gitInvocations);
    if (invocations.some(destroysWorktree)) return DENY_DESTRUCTIVE;

    // 重命令:子代理一律不跑;主代理每跑一次都要用户当轮的同意。
    const kinds = [...new Set(heavyCommands(execution, { cwd: execution.agent?.session?.header?.cwd }).map((heavy) => heavy.kind))];
    const heavyPlan = [];
    if (kinds.length > 0) {
      if (execution.agent === undefined || execution.agent === null) return DENY_HEAVY_UNKNOWN;
      if (isSubagentAgent(execution.agent)) return DENY_HEAVY_SUBAGENT;
      if (state === undefined) return DENY_HEAVY_NO_CONSENT;
      for (const kind of kinds) {
        const key = [...state.grants].find(([, entry]) => entry.granted.has(kind) && !entry.used.has(kind))?.[0];
        if (key === undefined) return DENY_HEAVY_NO_CONSENT;
        heavyPlan.push({ kind, key });
      }
    }

    // 提交 / 推送:需要用户当轮的显式授权。
    const required = new Map();
    for (const invocation of invocations) {
      const action = invocation.sub === 'commit' || invocation.sub === 'push' ? invocation.sub : undefined;
      if (action === undefined) continue;
      required.set(action, (required.get(action) ?? 0) + 1);
    }
    const gitPlan = [];
    if (required.size > 0) {
      if (state === undefined) return DENY_UNAUTHORIZED;
      for (const [action, count] of required) {
        const available = [];
        for (const [key, entry] of state.grants) {
          if (!entry.granted.has(action) || entry.used.has(action)) continue;
          available.push(key);
          if (available.length === count) break;
        }
        if (available.length < count) return DENY_UNAUTHORIZED;
        gitPlan.push({ action, keys: available });
      }
    }

    // 都拿到了才扣:命令没执行,授权不能被失败的执行烧掉。
    for (const { kind, key } of heavyPlan) state.grants.get(key).used.add(kind);
    for (const { action, keys } of gitPlan) {
      for (const key of keys) state.grants.get(key).used.add(action);
    }
    return undefined;
  });
}
