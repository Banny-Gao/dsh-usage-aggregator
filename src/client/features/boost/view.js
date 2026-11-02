// src/client/features/boost/view.js
//
// 小火箭浮层与聚合设置页共用的那一半：数据获取、体积格式化、清单渲染、
// 以及「交给 Agent」那段话的组装。
//
// 两个入口共用同一份实现 —— 浮层是小的，设置页是大的，内容是同一份体检结果。
// 渲染是**哑的**：探测、测量、诊断、清理全在 Host 侧
// （src/host/features/boost/），这里只画。

import { useCallback, useEffect, useState } from '../../runtime.js';
import { callApi } from '../../shared/api.js';
import { BOOST_ENDPOINT } from '../../shared/constants.js';

/** 与 Host 侧同一套路径（src/client/shared/constants.js）。 */
export const api = {
  scan: (refresh) => callApi('GET', `${BOOST_ENDPOINT}/scan${refresh === true ? '?refresh=1' : ''}`),
  status: () => callApi('GET', `${BOOST_ENDPOINT}/status`),
  // 执行是后台任务：这里立刻返回任务号，进度靠 executeStatus 轮询。
  execute: (items) => callApi('POST', `${BOOST_ENDPOINT}/execute`, { items }),
  executeStatus: () => callApi('GET', `${BOOST_ENDPOINT}/execute-status`),
};

/**
 * 字节数 → 人话。
 *
 * @param {number} bytes 字节。
 * @returns {string} 文本。
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 || index <= 1 ? Math.round(value) : Math.round(value * 10) / 10} ${units[index]}`;
}

/**
 * 找出用户当前正在看的那个会话。
 *
 * 判据是 DSH 自己用的那一条：会话列表里 **retainedBy.mainView > 0** 的那个。
 * 子代理的会话没有这个标记，所以天然被排除在外。
 *
 * @param {object} state 会话列表快照。
 * @returns {string|null} 会话 id。
 */
export function currentSessionId(state) {
  if (state === null || state === undefined || typeof state !== 'object') return null;
  const byId = state.byId;
  if (byId === null || byId === undefined || typeof byId !== 'object') return null;
  for (const row of Object.values(byId)) {
    if (row === null || typeof row !== 'object') continue;
    const retained = row.retainedBy;
    let count = 0;
    if (typeof retained === 'number') count = retained;
    else if (retained !== null && typeof retained === 'object' && typeof retained.mainView === 'number') count = retained.mainView;
    if (count > 0) return typeof row.id === 'string' ? row.id : null;
  }
  return null;
}

/**
 * 体检任务的状态钩子：启动 + 轮询。
 *
 * 体检是后台任务（量一个 10 GB 的目录要十几秒），所以是「启动 → 轮询」两段，
 * 条目会随着测量完成一个个出现在界面上。
 *
 * @param {Function} t 翻译函数。
 * @returns {{job: object|null, error: string, scanning: boolean, start: Function}} 状态。
 */
export function useBoostJob(t, initialJob) {
  // initialJob 只给离线渲染自检用（scripts/ui-check-boost.mjs）：真页面上永远是
  // null，数据由下面的 useEffect 去 Host 拉。
  const [job, setJob] = useState(initialJob ?? null);
  const [error, setError] = useState('');

  const start = useCallback(function (refresh) {
    setError('');
    return api.scan(refresh === true).then(function (next) {
      setJob(next);
      return next;
    }).catch(function (failure) {
      setError(String(failure.message || failure));
      return null;
    });
  }, []);

  const running = job !== null && job.running === true;
  useEffect(function () {
    if (!running) return undefined;
    const timer = window.setInterval(function () {
      api.status().then(function (next) {
        if (next !== null && next !== undefined) setJob(next);
      }).catch(function () {
        /* 轮询失败不打断界面：下一次轮询会再试 */
      });
    }, 1000);
    return function () { window.clearInterval(timer); };
  }, [running]);

  return { job, error, scanning: running, start };
}

/**
 * 这次体检是什么时候做的（人话）。
 *
 * 体检现在由后台自动跑（机器空闲时每 12 小时一次），所以面板上得说清楚
 * 这份结果是多久前的 —— 用户看到「12 小时前」才知道它可能已经过时。
 *
 * @param {Function} t 翻译函数。
 * @param {object|null} job 体检任务。
 * @returns {string} 人话时间；没有体检记录时返回空串。
 */
export function scanAgeLabel(t, job) {
  const at = job !== null && job !== undefined ? job.finishedAt : 0;
  if (typeof at !== 'number' || at <= 0) return '';
  const ms = Date.now() - at;
  if (ms < 60 * 1000) return t('ageNow');
  if (ms < 60 * 60 * 1000) return t('ageMinutes', { n: Math.floor(ms / (60 * 1000)) });
  if (ms < 24 * 60 * 60 * 1000) return t('ageHours', { n: Math.floor(ms / (60 * 60 * 1000)) });
  return t('ageDays', { n: Math.floor(ms / (24 * 60 * 60 * 1000)) });
}

/**
 * 勾选状态。
 *
 * 默认值由条目自己决定（`selectedByDefault`）：
 *   · 可再生的缓存、可重建的缓存、已经删掉的东西 → **默认勾上**；
 *   · 会结束进程、会关窗口、会删掉用户历史的 → **默认不勾**。
 *
 * 「默认全勾」和「不影响用户数据」在结束进程、删历史这两件事上是冲突的。
 * 这里选后者：默认值写在条目上，用户想执行时自己勾 —— 面板把每一项的后果
 * 都写在旁边（note），不藏着。
 *
 * 用户手动改过的条目记住他的选择；新出现的条目按自己的默认值来。
 *
 * @param {Array<object>} items 条目。
 * @returns {{selected: string[], toggle: Function, setAll: Function}} 状态。
 */
export function useSelection(items) {
  const [overrides, setOverrides] = useState({});
  const ids = items.map((item) => item.id);
  const defaults = new Map(items.map((item) => [item.id, item.selectedByDefault !== false]));

  const selected = ids.filter(function (id) {
    if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id] === true;
    return defaults.get(id) !== false;
  });

  const toggle = useCallback(function (id, checked) {
    setOverrides(function (current) {
      const next = Object.assign({}, current);
      next[id] = checked === true;
      return next;
    });
  }, []);

  const setAll = useCallback(function (checked) {
    setOverrides(function (current) {
      const next = Object.assign({}, current);
      for (const id of ids) next[id] = checked === true;
      return next;
    });
  }, [ids.join(',')]);

  return { selected, toggle, setAll };
}

/** 条目的语义 → 交接单里的说法。 */
const SEMANTICS_TEXT = {
  prune: '只删没人引用的',
  full: '整个清空',
  terminate: '会结束进程',
  renice: '只降优先级，不关进程',
  'close-window': '会关窗口',
};

/**
 * 组装「交给 Agent」的那段话。
 *
 * 这段话是用户与 Agent 之间的交接单：说清楚体检结论、勾了哪几项、每一项
 * 做什么、能回收多少，以及要求 Agent **先说明再动手**。
 *
 * @param {object} t 翻译函数。
 * @param {object} job 体检任务。
 * @param {string[]} selected 勾选的条目 id。
 * @returns {string} 文本。
 */
export function buildHandoffText(t, job, selected) {
  const items = Array.isArray(job?.items) ? job.items : [];
  const chosen = items.filter((item) => selected.includes(item.id));
  const analysis = job?.analysis ?? null;
  const lines = [];
  lines.push('【小火箭 · 电脑加速与清理】');
  if (analysis !== null && analysis !== undefined) {
    lines.push('');
    lines.push(`体检结论：${analysis.diagnosis}`);
    for (const finding of analysis.findings ?? []) lines.push(`- ${finding}`);
    for (const warning of analysis.warnings ?? []) lines.push(`! ${warning}`);
  }
  lines.push('');
  lines.push(`用户已勾选以下 ${chosen.length} 项并点击了「交给 Agent 执行」：`);
  chosen.forEach((item, index) => {
    const size = item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : `${item.count} 项`;
    lines.push(
      `${index + 1}. [${item.id}] ${item.label} — ${size} — `
      + `${SEMANTICS_TEXT[item.semantics] ?? '整个清空'} — ${item.commandText}`,
    );
    if (typeof item.note === 'string' && item.note !== '') lines.push(`   ${item.note}`);
  });
  lines.push('');
  lines.push('请先用一两句话说明将要做什么，然后调用 system_boost 工具的 execute 动作执行（items 传上面的条目 id）。');
  lines.push('执行清理需要 danger-full-access 权限；如果当前会话的权限不够，直接说明并停手，不要反复重试。');
  lines.push('只执行清单里的项目，不要自作主张清理别的东西；某一项失败就如实报告，不要反复重试。');
  return lines.join('\n');
}

/** 交给 Agent 的交接最多等这么久（毫秒）。超了就面板直接执行。 */
export const HANDOFF_TIMEOUT_MS = 10000;

/**
 * 「交给 Agent 执行」的那一下。
 *
 * 优先走 DSH 自己的 prompt 管线：客户端拿到当前会话的 scope，调 conversation.send
 * —— 那条路和输入框的发送按钮是同一条，Host 侧会把它变成一条普通的用户消息
 * 排进 Agent 的下一个 turn。Agent 醒来后先说明要做什么，再调插件自己的工具执行。
 *
 * 会话不可用（没开会话 / 会话已结束）时兜底：面板直接调 Host 的执行接口。
 *
 * @param {object} options 选项。
 * @param {Function} options.t 翻译函数。
 * @param {object} options.job 体检任务。
 * @param {string[]} options.selected 勾选的条目 id。
 * @param {{sessions: object|null}} options.runtime 运行时引用（含客户端 sessions 服务）。
 * @param {string|null} options.sessionId 用户当前正在看的会话。
 * @param {Function} [options.onFinished] 执行完了的回调（外面据此重扫一次清单）。
 * @returns {{phase: string, message: string, tone: string, progress: object|null, run: Function}} 状态。
 */
export function useHandoff(options) {
  const { t, job, selected, runtime, sessionId, onFinished } = options;
  const [phase, setPhase] = useState('idle');
  const [message, setMessage] = useState('');
  const [tone, setTone] = useState('');
  const [progress, setProgress] = useState(null);

  const run = useCallback(function () {
    if (selected.length === 0) return;
    setPhase('running');
    setMessage('');
    setTone('');

    /**
     * 兜底：交给 Agent 这条路走不通，面板自己执行。
     *
     * @param {string} reason 为什么改走面板（给用户看的）。
     * @returns {void}
     */
    function runDirectly(reason) {
      if (reason !== '') {
        console.warn('[小火箭] 交给 Agent 没走通，改由面板直接执行：', reason);
      }
      setMessage(t('executingDirect', { reason }));
      setProgress({ done: 0, total: selected.length, label: '' });
      api.execute(selected).then(function () {
        // 执行是后台任务：轮询看跑到第几项了。
        pollExecute();
      }).catch(function (failure) {
        setPhase('idle');
        setTone('is-error');
        setMessage(t('failed', { error: String(failure && failure.message ? failure.message : failure) }));
      });
    }

    /**
     * 轮询执行任务的进度。
     *
     * @returns {void}
     */
    function pollExecute() {
      window.setTimeout(function () {
        api.executeStatus().then(function (state) {
          if (state === null || state === undefined) {
            setPhase('done');
            setTone('is-ok');
            setMessage(t('doneDirect'));
            return;
          }
          setProgress({ done: state.done ?? 0, total: state.total ?? 0, label: state.currentLabel ?? '' });
          if (state.running === true) {
            pollExecute();
            return;
          }
          setPhase('done');
          setTone(state.error === '' ? 'is-ok' : 'is-error');
          setMessage(
            `${t('doneDirect')} ${t('reclaimed', { size: formatBytes(state.reclaimedBytes ?? 0) })}`
            + (state.error === '' ? '' : ` ${state.error}`),
          );
          // 清过的条目得从清单里消失 —— 重扫一次，面板上的内容区才是当下的实况。
          if (typeof onFinished === 'function') onFinished();
        }).catch(function (failure) {
          setPhase('idle');
          setTone('is-error');
          setMessage(t('failed', { error: String(failure && failure.message ? failure.message : failure) }));
        });
      }, 800);
    }

    // 只结算一次：交接成功、超时、失败，三者里谁先到算谁的。
    let settled = false;
    const timer = window.setTimeout(function () {
      if (settled) return;
      settled = true;
      runDirectly(t('handoffTimeout'));
    }, HANDOFF_TIMEOUT_MS);

    /**
     * 交到 Agent 手里了。
     *
     * @returns {void}
     */
    function done() {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      setPhase('done');
      setTone('is-ok');
      setMessage(t('done'));
    }

    /**
     * 交接没成（抛错、没会话、RPC 卡住）。
     *
     * @param {string} reason 原因。
     * @returns {void}
     */
    function failed(reason) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      runDirectly(reason);
    }

    const text = buildHandoffText(t, job, selected);

    // 取会话这一步本身也可能抛（服务不在、scope 取不到）—— 一律当成交接失败。
    let conversation;
    try {
      const service = runtime === undefined || runtime === null ? null : runtime.sessions;
      const scope = sessionId !== null && service !== null && typeof service.scope === 'function'
        ? service.scope(sessionId)
        : undefined;
      conversation = scope === undefined || scope === null ? undefined : scope.conversation;
    } catch (error) {
      failed(String(error && error.message ? error.message : error));
      return;
    }

    if (conversation === undefined || conversation === null || typeof conversation.send !== 'function') {
      failed(t('handoffNoSession'));
      return;
    }

    conversation.send(text).then(done).catch(function (failure) {
      failed(String(failure && failure.message ? failure.message : failure));
    });
  }, [selected, t, job, runtime, sessionId, onFinished]);

  return { phase, message, tone, progress, run };
}
