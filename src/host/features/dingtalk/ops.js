// src/host/features/dingtalk/ops.js
//
// 「钉钉沙发」的操作层：面板、Agent 工具、卡片处理器**共用同一份实现**。
//
// 这里是唯一碰 dws 的地方。三条规矩贯穿全文件：
//   1. 绝不猜收件人 —— 零命中就报没找到，多候选就把候选列出来交给人；
//   2. 绝不信「发送任务 ID」是消息 ID —— 发完必须回查，回查不到就报「未确认送达」；
//   3. 任何回显都带「姓名 + 唯一标识片段」，避免同名发错人。

import { runProcess } from '../../shared/cmd.js';
import { detectEnvironment, installDws } from './install.js';
import { explainFailure, runDws } from './dws.js';
import { collectMessages, collectPeople, idHint } from './shapes.js';
import { readStored, writePreferences, normalize } from './store.js';

/** 钉钉单聊的正文上限（字符）。超了要分段或改发文档链接。 */
export const BODY_LIMIT = 5000;

/** 回查时用来定位消息的关键词长度。 */
const KEYWORD_LENGTH = 18;

/**
 * 在 JSON 里深找一个带指定键名的值。
 *
 * @param {unknown} node 当前节点。
 * @param {string[]} keys 键名候选。
 * @param {number} depth 当前深度。
 * @returns {string} 找到的值（没有就是空串）。
 */
function deepFindString(node, keys, depth = 0) {
  if (depth > 6 || node === null || typeof node !== 'object') return '';
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = deepFindString(item, keys, depth + 1);
      if (found !== '') return found;
    }
    return '';
  }
  for (const key of keys) {
    const value = node[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  for (const key of Object.keys(node)) {
    const found = deepFindString(node[key], keys, depth + 1);
    if (found !== '') return found;
  }
  return '';
}

/**
 * 时间戳转成 dws 认的 ISO 串（带本地时区偏移）。
 *
 * @param {number} ms 毫秒时间戳。
 * @returns {string} ISO 串。
 */
export function toIso(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
    sign + pad(Math.floor(absolute / 60)) + ':' + pad(absolute % 60)
  );
}

/**
 * 这串东西像不像一个稳定标识（openDingTalkId / userId）。
 *
 * @param {string} value 待判断的串。
 * @returns {boolean} 是否像标识。
 */
export function looksLikeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,}$/.test(value.trim());
}

/**
 * 从正文里挑一段用来回查的关键词。
 *
 * @param {string} body 正文。
 * @returns {string} 关键词。
 */
export function keywordOf(body) {
  const flat = String(body ?? '').replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  return flat.slice(0, KEYWORD_LENGTH);
}

/**
 * 造操作层。
 *
 * @param {{dws?: Function, run?: Function, now?: Function, env?: object}} deps 依赖（便于自检替换）。
 * @returns {object} 操作层。
 */
export function createOps(deps = {}) {
  const dws = deps.dws ?? runDws;
  const now = deps.now ?? (() => Date.now());
  const env = deps.env ?? process.env;
  /** 自检注入的假 dws —— 有它就不用去真机上探测。 */
  const hasCustomDws = deps.dws !== undefined && deps.dws !== null;
  /** 跑外部命令。 */
  const runner = deps.run ?? runProcess;
  /** 环境探测（可注入，便于自检）。 */
  const detect = deps.detect ?? ((options) => detectEnvironment(options));
  /** 装 dws（可注入，便于自检）。 */
  const installer = deps.installer ?? installDws;
  /** 目标平台（自检可以指定，免得去真机上试 brew）。 */
  const platform = deps.platform ?? process.platform;

  /** 会话 → 姓名 → 人员。同一会话里解析过一次就不再问通讯录。 */
  const resolvedBySession = new Map();
  /** dws 是否装着的探测结果。 */
  let probe = null;
  /** 安装任务状态（装 dws 可能要一两分钟，HTTP 不能一直挂着）。 */
  let installJob = {
    running: false,
    stage: '',
    method: '',
    startedAt: 0,
    finishedAt: 0,
    ok: false,
    error: '',
  };

  /**
   * 用注入的 dws 问版本（自检里那套假 dws 走这条路）。
   *
   * @returns {Promise<{version: string, path: string}|null>} 问不到就是 null。
   */
  async function probeInjected() {
    const result = await dws(['--version'], { format: false });
    if (result.reason === 'dws-not-found') return null;
    return { version: String(result.stdout ?? '').trim().split('\n')[0], path: '' };
  }

  /**
   * dws 装没装、在哪、登录了没有、有哪些安装器可用。
   *
   * @returns {Promise<{installed: boolean, version: string, path: string, loggedIn: string, installers: Array<object>}>} 探测结果。
   */
  async function availability() {
    if (probe !== null && now() - probe.at < 60000) return probe.value;
    const value = await detect({
      env,
      run: runner,
      platform,
      // 注入了假 dws 时不去真机上找 —— 那是自检，不该被本机环境影响。
      probe: hasCustomDws ? probeInjected : undefined,
      installers: hasCustomDws ? false : true,
    });
    probe = { at: now(), value };
    return value;
  }

  /**
   * 调 dws：优先用探测到的绝对路径。
   *
   * 为什么：官方脚本装到 ~/.local/bin、npm 全局装到 `npm prefix -g/bin`，
   * 这两个目录常常不在宿主进程的 PATH 上 —— 只认 PATH 的话，用户明明装好了，
   * 插件却还在说「没装」。
   *
   * @param {string[]} args 命令参数。
   * @param {object} options 选项。
   * @returns {Promise<object>} 调用结果。
   */
  async function callDws(args, options = {}) {
    if (probe === null) await availability();
    const known = probe?.value?.path ?? '';
    return dws(args, known === '' ? options : { ...options, bin: known });
  }

  /**
   * 启动一次安装（后台跑，调用方立刻返回）。
   *
   * @returns {Promise<{ok: boolean, error?: string, started?: boolean}>} 启动结果。
   */
  async function startInstall() {
    if (installJob.running) return { ok: false, error: '安装已经在进行中' };
    installJob = {
      running: true,
      stage: 'detecting',
      method: '',
      startedAt: now(),
      finishedAt: 0,
      ok: false,
      error: '',
    };
    void (async () => {
      try {
        const result = await installer({
          env,
          run: runner,
          platform,
          onStage: (stage, method) => {
            installJob.stage = stage;
            if (method !== '') installJob.method = method;
          },
        });
        // 装完必须重探：装上 ≠ 能用。
        probe = null;
        installJob.ok = result.ok === true;
        installJob.error = result.error ?? '';
        installJob.stage = result.ok === true ? 'done' : 'failed';
        if (result.ok === true && result.method !== '') installJob.method = result.method;
      } catch (error) {
        installJob.ok = false;
        installJob.error = String(error?.message ?? error);
        installJob.stage = 'failed';
      }
      installJob.running = false;
      installJob.finishedAt = now();
    })();
    return { ok: true, started: true };
  }

  /**
   * 缺 dws 就装上。
   *
   * @returns {Promise<{ok: boolean, skipped?: boolean, error?: string}>} 结果。
   */
  async function ensureInstalled() {
    const state = await availability();
    if (state.installed === true) return { ok: true, skipped: true };
    return startInstall();
  }

  /**
   * 读安装任务的状态（面板轮询用）。
   *
   * @returns {object} 任务状态。
   */
  function installState() {
    return { ...installJob };
  }

  /**
   * 读偏好。
   *
   * @param {boolean} defaultEnabled 用户还没设过时用的默认值（来自配置）。
   * @returns {Promise<{enabled: boolean, pollIntervalSeconds: number}>} 偏好。
   */
  async function settings(defaultEnabled = false) {
    try {
      const stored = await readStored(env);
      if (stored === null) {
        return normalize({ enabled: defaultEnabled, pollIntervalSeconds: stored?.pollIntervalSeconds });
      }
      return normalize(stored);
    } catch {
      return normalize({ enabled: defaultEnabled });
    }
  }

  /**
   * 存偏好。
   *
   * @param {object} patch 要改的字段。
   * @returns {Promise<{ok: boolean, settings: object}>} 结果。
   */
  async function saveSettings(patch) {
    const current = await settings();
    const next = normalize({
      enabled: patch?.enabled === undefined ? current.enabled : patch.enabled === true,
      pollIntervalSeconds: patch?.pollIntervalSeconds ?? current.pollIntervalSeconds,
    });
    await writePreferences(next, env);
    return { ok: true, settings: next };
  }

  /**
   * 取会话里的解析缓存。
   *
   * @param {string} sessionId 会话 id。
   * @returns {Map<string, object>} 缓存表。
   */
  function cacheOf(sessionId) {
    const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : '_';
    let table = resolvedBySession.get(key);
    if (table === undefined) {
      table = new Map();
      resolvedBySession.set(key, table);
    }
    return table;
  }

  /**
   * 解析收件人。
   *
   * 优先级：明确指定的标识 > 会话里已解析过的对象 > 通讯录解析。
   *
   * @param {string} query 姓名或标识。
   * @param {string} sessionId 会话 id（用于复用）。
   * @returns {Promise<{status: string, person?: object, candidates?: Array<object>, error?: string}>} 解析结果。
   */
  async function resolveRecipient(query, sessionId) {
    const name = String(query ?? '').trim();
    if (name === '') return { status: 'not-found', error: '没有指定收件人' };

    if (looksLikeId(name)) {
      return { status: 'resolved', person: { name, userId: '', openDingTalkId: name, department: '' } };
    }

    const cached = cacheOf(sessionId).get(name);
    if (cached !== undefined) return { status: 'resolved', person: cached };

    const result = await callDws(['aisearch', 'person', '--query', name, '--dimension', 'name']);
    if (!result.ok) {
      return { status: 'error', error: explainFailure(result) };
    }
    const people = collectPeople(result.json);
    if (people.length === 0) {
      return { status: 'not-found', error: `通讯录里没有找到「${name}」` };
    }

    // 名字完全对上的优先：语义搜索常把同事也带出来，但同名同姓才是真歧义。
    const exact = people.filter((person) => person.name === name);
    if (exact.length === 1) {
      cacheOf(sessionId).set(name, exact[0]);
      return { status: 'resolved', person: exact[0] };
    }
    if (exact.length > 1) {
      return { status: 'ambiguous', candidates: exact };
    }
    if (people.length === 1) {
      cacheOf(sessionId).set(name, people[0]);
      return { status: 'resolved', person: people[0] };
    }
    return { status: 'ambiguous', candidates: people.slice(0, 10) };
  }

  /**
   * 组出发送命令的目标参数。
   *
   * @param {{person: object, recipientId: string, recipientIdKind: string, channel: string}} target 目标。
   * @returns {string[]} 参数数组。
   */
  function targetArgs(target) {
    if (target.channel === 'group') return ['--group', target.recipientId];
    const person = target.person ?? {};
    if (person.openDingTalkId !== '') return ['--open-dingtalk-id', person.openDingTalkId];
    if (person.userId !== '') return ['--user', person.userId];
    const id = String(target.recipientId ?? '');
    if (id !== '') {
      return target.recipientIdKind === 'userId' ? ['--user', id] : ['--open-dingtalk-id', id];
    }
    return ['--user-query', person.name];
  }

  /**
   * 发一条消息。
   *
   * @param {{recipient: string, recipientId: string, recipientIdKind: string, channel: string, body: string, sessionId: string}} request 请求。
   * @returns {Promise<{status: string, taskId?: string, messageId?: string, error?: string, candidates?: Array<object>}>} 结果。
   */
  async function sendMessage(request) {
    const body = String(request?.body ?? '');
    if (body.trim() === '') return { status: 'failed', error: '正文是空的' };
    if (body.length > BODY_LIMIT) {
      return {
        status: 'failed',
        error: `正文 ${body.length} 字，超过钉钉单聊 ${BODY_LIMIT} 字上限 —— 拆成几条发，或者改发一个文档链接`,
      };
    }

    const channel = request?.channel === 'group' ? 'group' : 'dm';
    const recipientId = String(request?.recipientId ?? '');
    const recipientIdKind = request?.recipientIdKind === 'userId' ? 'userId' : 'openDingTalkId';
    let person = { name: String(request?.recipient ?? ''), userId: '', openDingTalkId: '', department: '' };
    if (channel === 'dm' && recipientId !== '') {
      // 已经有标识（模型解析过，或用户在卡片上选过了）：不再问通讯录。
      person = recipientIdKind === 'userId'
        ? { name: person.name, userId: recipientId, openDingTalkId: '', department: '' }
        : { name: person.name, userId: '', openDingTalkId: recipientId, department: '' };
    } else if (channel === 'dm') {
      const resolution = await resolveRecipient(request?.recipient ?? '', request?.sessionId ?? '');
      if (resolution.status === 'ambiguous') return { status: 'ambiguous', candidates: resolution.candidates };
      if (resolution.status === 'not-found') return { status: 'failed', error: resolution.error };
      if (resolution.status === 'error') return { status: 'failed', error: resolution.error };
      person = resolution.person;
    }

    const args = ['chat', '+messages-send', '--as', 'user', ...targetArgs({
      person,
      recipientId,
      recipientIdKind,
      channel,
    }), '--content', body];
    const result = await callDws(args);
    if (!result.ok) return { status: 'failed', error: explainFailure(result) };

    // openTaskId 是**发送任务 ID**，不是消息 ID —— 别拿它当回执。
    const taskId = deepFindString(result.json, ['openTaskId', 'taskId', 'openTaskID']);
    return { status: 'submitted', taskId };
  }

  /**
   * 回查刚才那条消息的真实 messageId。
   *
   * 按「收件人 + 关键词 + 时间窗」搜最近的消息；搜不到就是搜不到，
   * 上层要报「已提交，未确认送达」，不能报成功。
   *
   * @param {{person: object, recipientName: string, body: string, sinceMs: number}} request 请求。
   * @returns {Promise<{found: boolean, messageId: string}>} 回查结果。
   */
  async function confirmReceipt(request) {
    const keyword = keywordOf(request?.body ?? '');
    if (keyword === '') return { found: false, messageId: '' };

    const args = ['chat', '+search-msg'];
    const person = request?.person ?? {};
    if (person.openDingTalkId !== '') args.push('--senders', person.openDingTalkId);
    else if (person.userId !== '') args.push('--senders', person.userId);
    else if (String(request?.recipientName ?? '') !== '') args.push('--sender-query', String(request.recipientName));
    args.push('--query', keyword);
    args.push('--start', toIso(Math.max(0, (request?.sinceMs ?? now()) - 60000)));
    args.push('--end', toIso(now() + 60000));

    const result = await callDws(args);
    if (!result.ok) return { found: false, messageId: '' };

    const messages = collectMessages(result.json);
    const senderId = person.openDingTalkId || person.userId;
    for (const message of messages) {
      if (!message.text.includes(keyword)) continue;
      if (senderId !== '' && message.senderId !== '' && message.senderId !== senderId) continue;
      if (message.messageId === '') continue;
      return { found: true, messageId: message.messageId };
    }
    return { found: false, messageId: '' };
  }

  /**
   * 拉一次 @我的 / 未读会话里的消息。
   *
   * @param {{limit?: number, sinceMs?: number}} options 选项。
   * @returns {Promise<{ok: boolean, messages: Array<object>, error?: string}>} 结果。
   */
  async function readMessages(options = {}) {
    const result = await callDws(['chat', '+at-me', '--page-all']);
    if (!result.ok) return { ok: false, messages: [], error: explainFailure(result) };
    let messages = collectMessages(result.json);
    if (Number.isFinite(options?.sinceMs) && options.sinceMs > 0) {
      messages = messages.filter((message) => message.createTime === 0 || message.createTime >= options.sinceMs);
    }
    if (Number.isFinite(options?.limit) && options.limit > 0) {
      messages = messages.slice(0, options.limit);
    }
    return { ok: true, messages };
  }

  return {
    availability,
    /** 启动一次安装（后台跑）。 */
    startInstall,
    /** 缺 dws 就装上。 */
    ensureInstalled,
    /** 读安装任务状态。 */
    installState,
    settings,
    saveSettings,
    resolveRecipient,
    sendMessage,
    confirmReceipt,
    readMessages,
    /** 给回显用的人一类标签：姓名 + 唯一标识片段。 */
    labelOf(person) {
      const name = person?.name || '';
      const hint = idHint(person ?? {});
      return hint === '' ? name : name + '（' + hint + '）';
    },
  };
}
