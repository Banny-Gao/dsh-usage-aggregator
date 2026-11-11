/**
 * 硬指标守卫:把《硬指标手册》的「硬禁令」从提示层落到工具执行层。
 *
 * 职责:
 *   1. 绝对拦截会丢弃工作区改动的 git 命令(`git checkout --` / `git checkout .` /
 *      `git restore` / `git reset --hard` / `git clean -f` / `git stash`),手册
 *      「硬禁令」第二条,没有任何授权例外。
 *   2. 拦截 `git commit` / `git push`;只有用户本轮显式授权对应动作时才放行,
 *      且每个动作的授权各只够用一次(手册「硬禁令」第一条)。
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
 *   - 授权判定是意图判定而非关键词命中:先按句切分,再排除否定式(不要/未/没有/尚未…),
 *     排除只是在谈论这个词的句子(提交历史 / 是什么意思 / 推送之前 / 已经提交过),
 *     剩下的才当作用户当轮的表态。
 *   - 扣减授权是先验后扣:整条命令需要的动作都拿到可用授权才扣;否则命令本身没有
 *     执行,授权也不能被这一次失败的执行烧掉。
 *   - `agent/pre-step` 是 waterfall 事件:监听器不调用 `next()` 就会截断链条,
 *     外层监听器拿到的 decision 会变成 undefined。因此这里必须把 `next()` 的
 *     结果原样交回,只做「记录授权」这一件事。
 *
 * 本文件由本包以 exports 子路径 `./preset-guard` 暴露,供预设 `hard-metrics` 引用。
 */

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

/** 动词之前出现这些词,表示这件事没被要求做。 */
const NEGATION_BEFORE = /(?:不要|不用|不需要|无需|不必|甭|别|勿|禁止|不能|不可|没有|还没|尚未|未(?:必)?|不|无|莫|免得)(?:再|先|急着|轻易|乱)?\s*$/;

/** 英文否定式:出现在动词之前表示这件事没被要求做。 */
const NEGATION_BEFORE_EN = /\b(?:do not|don't|never|no|not|without|cannot|can not|will not|won't)\s*$/i;

/** 句子里出现这些词,说明只是在校验这个动作本身,而不是在要求它。 */
const MENTION_IN_CLAUSE = /什么|怎么|如何|是否|是不是|吗|意思|含义|历史|记录|刚才|已经|曾经|以前|过去|之前|之后|日志|[?？]/;

/** 把文本按句切分:授权判定在句子里做,避免跨句误判。 */
function clauses(text) {
  return text
    .split(/[。；;！!？?\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
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
    if (MENTION_IN_CLAUSE.test(clause)) continue;
    for (const { action, words } of ACTION_WORDS) {
      const pattern = new RegExp(words.source, `${words.flags}g`);
      for (const match of clause.matchAll(pattern)) {
        const before = clause.slice(0, match.index);
        const tail = before.slice(Math.max(0, before.lastIndexOf(',') + 1)).slice(-12);
        if (NEGATION_BEFORE.test(tail) || NEGATION_BEFORE_EN.test(tail)) continue;
        actions.add(action);
      }
    }
  }
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
      remember(state, message.id, grantedActions(textOf(message)));
      return;
    }
    // 提问卡片的答复消息:正文里带问题全文与全部选项,只能取用户选中的那些。
    if (kind === 'user-question-reply') {
      const payload = parseJson(textOf(message));
      const callId = payload?.callId;
      if (typeof callId !== 'string') return;
      const actions = new Set();
      for (const selected of selectedTexts(payload)) {
        for (const action of grantedActions(selected)) actions.add(action);
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
      for (const action of grantedActions(selected)) actions.add(action);
    }
    remember(state, `question:${execution.callId}`, actions);
  });

  ctx.on('agent/disposed', (payload) => {
    const key = typeof payload?.agent?.id === 'string' ? payload.agent.id : payload?.agent;
    if (key !== undefined && key !== null) states.delete(key);
  });

  ctx.tools.guard((execution) => {
    const invocations = commandTexts(execution).flatMap(gitInvocations);
    if (invocations.length === 0) return undefined;
    if (invocations.some(destroysWorktree)) return DENY_DESTRUCTIVE;

    // 这条命令一共需要哪些授权、各要几次。
    const required = new Map();
    for (const invocation of invocations) {
      const action = invocation.sub === 'commit' || invocation.sub === 'push' ? invocation.sub : undefined;
      if (action === undefined) continue;
      required.set(action, (required.get(action) ?? 0) + 1);
    }
    if (required.size === 0) return undefined;

    const state = stateOf(execution.agent);
    if (state === undefined) return DENY_UNAUTHORIZED;

    // 先确认所有动作都拿得到授权;命令没执行就不扣授权。
    const plan = [];
    for (const [action, count] of required) {
      const available = [];
      for (const [key, entry] of state.grants) {
        if (!entry.granted.has(action) || entry.used.has(action)) continue;
        available.push(key);
        if (available.length === count) break;
      }
      if (available.length < count) return DENY_UNAUTHORIZED;
      plan.push({ action, keys: available });
    }

    for (const { action, keys } of plan) {
      for (const key of keys) state.grants.get(key).used.add(action);
    }
    return undefined;
  });
}
