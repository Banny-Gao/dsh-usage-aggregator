// src/host/features/boost/ops.js
//
// 加速清理的操作层：面板与 Agent 工具共用的同一份实现。
//
// 三段语义不可切碎：
//   · scan()  —— 一次体检。产出「机器事实 + 这台机器上发现的缓存条目 + 诊断」。
//                是个**后台任务**：测量体积可能要十几秒（pnpm store 就有 17 GB），
//                所以测量一个出一个，客户端轮询看得到条目逐个冒出来。
//   · status() —— 体检任务的当前状态（客户端轮询用）。
//   · execute() —— 执行用户勾选的条目。**路径在这里重新解析一次**，客户端传回来的
//                只有条目 id，它没有任何机会指定要删哪个目录。
//
// 体检结果有 TTL：同一台机器上反复点小火箭，不该每次都重新量一遍 30 GB 的目录。

import { ADAPTERS, adapterSupported, detectTool, findOrphanStoreVersions, formatCommand, locateCacheDir } from './catalog.js';
import { analyzeSystem, humanBytes } from './analyze.js';
import { createExecutor } from './execute.js';
import { isMachineIdle, measureBytes, probeSystem } from './probe.js';
import { listDshItems } from './dshself.js';
import {
  aggregateByApp,
  checkProcessAllowed,
  displayApp,
  findOrphanProcesses,
  listBrowserWindows,
  processLabel,
  sampleProcesses,
} from './processes.js';

/**
 * 体检结果的保鲜期（毫秒）。
 *
 * 体检要读几十 GB 的目录，是 I/O 密集的活儿。等后台自动体检把结果备好之后，
 * 点小火箭应该是**秒开** —— 所以保鲜期跟自动体检的节奏对齐（12 小时），
 * 期间重复打开直接复用缓存，不重新量。
 */
const SCAN_TTL_MS = 12 * 60 * 60 * 1000;

/** 后台自动体检的间隔（毫秒）—— 12 小时一次，即每天两次。 */
export const AUTO_SCAN_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** 后台自动体检多久看一眼（毫秒）。看的是「该不该扫」，本身很便宜。 */
export const AUTO_SCAN_TICK_MS = 5 * 60 * 1000;

/**
 * 现在该不该自动体检一次。
 *
 * 三道门：机器闲、上一次没在跑、上一次的结果够旧了。
 *
 * @param {{idle: boolean, running: boolean, lastFinishedAt: number, now: number, intervalMs: number}} state 判定输入。
 * @returns {boolean} 该不该扫。
 */
export function shouldAutoScan(state) {
  if (state.idle !== true) return false;
  if (state.running === true) return false;
  return state.now - state.lastFinishedAt >= state.intervalMs;
}

/** 多大内存的应用才值得列出来（字节）。 */
const BIG_APP_BYTES = 300 * 1024 * 1024;

/** 多大内存的单个进程才值得单独列出来（字节）。 */
const BIG_PROC_BYTES = 120 * 1024 * 1024;

/** 多高 CPU 才算「占得高」（百分比）。 */
const HOT_CPU_PCT = 5;

/** 最多列几个内存大户应用 / 单个大进程 / CPU 大户。 */
const MAX_PROCESS_ITEMS = 6;
const MAX_PROC_ITEMS = 8;

/**
 * 造一份操作层。
 *
 * @param {{home: string, env: object, llm: () => object|null, analysis: object, platform?: string, liveSessionIds?: () => string[], unarchiveSession?: Function}} options 选项。
 * @returns {object} 操作层。
 */
export function createOps(options) {
  const home = options.home;
  const env = options.env;
  const platform = options.platform ?? process.platform;
  const analysisConfig = options.analysis ?? {};
  const dshHome = env.DSH_HOME ?? `${home}/.dsh`;
  const liveSessionIds = typeof options.liveSessionIds === 'function' ? options.liveSessionIds : () => [];

  const executor = createExecutor({
    home,
    env,
    dshHome,
    logPath: `${dshHome}/dsh-usage-aggregator/boost.log`,
    liveSessionIds,
    unarchiveSession: typeof options.unarchiveSession === 'function' ? options.unarchiveSession : null,
  });

  /** 当前体检任务。null = 还没跑过。 */
  let job = null;
  /** 最近一次量到的体积，按条目 id 存（执行时拿来算回收量）。 */
  const sizes = new Map();
  /** 上一次体检的清单（执行时按 id 找回动作）。 */
  let lastItems = [];
  /** 最近一次后台执行任务。null = 还没执行过。 */
  let executeJob = null;
  let jobCounter = 0;

  /**
   * 发现这台机器上可以清理的缓存条目。
   *
   * 三步：
   *   1. 探测工具装没装 —— 每条命令独立，并行跑。
   *   2. 问工具要缓存目录 —— 也是并行。工具报上来的是**根目录**，派生路径
   *      （npm 的 _cacache / _npx、pnpm 的旧版本 store）从这里算。
   *   3. 量体积 —— **并行**。量一个 10 GB 的 store 要十几秒，串行的话整个体检
   *      要一分多钟；并行之后墙钟时间等于最慢的那一个。量完一个收一个，
   *      客户端轮询时能看着条目一个个冒出来。
   *
   * @param {{measure: boolean, onItem: Function|null}} params 参数。
   * @returns {Promise<Array<object>>} 条目。
   */
  async function discover(params) {
    const measure = params.measure === true;
    const onItem = typeof params.onItem === 'function' ? params.onItem : null;
    const context = {};

    const usable = ADAPTERS.filter((adapter) => adapterSupported(adapter, platform));
    const detected = await Promise.all(usable.map(async (adapter) => ({
      adapter,
      installed: await detectTool(adapter),
    })));
    const installed = new Set(detected.filter((entry) => entry.installed).map((entry) => entry.adapter.id));

    // 问工具要自己的缓存目录（这些条目彼此独立，并行问）。
    const withCommand = detected.filter((entry) => entry.installed && entry.adapter.locate !== undefined && entry.adapter.locate !== null);
    const located = await Promise.all(withCommand.map(async (entry) => ({
      adapter: entry.adapter,
      path: await locateCacheDir(entry.adapter, { home, env }, context),
    })));

    // context 填的是工具报的**根目录**（npm 报 ~/.npm，被清的是里面的 _cacache）。
    for (const entry of located) {
      if (entry.path === null) continue;
      if (entry.adapter.contextKey !== undefined) context[entry.adapter.contextKey] = entry.path;
    }

    // 靠上下文定位的条目：npx 临时目录挂在 npm 自己的缓存目录下面。
    const derived = [];
    for (const adapter of usable) {
      if (!installed.has(adapter.id)) continue;
      if (typeof adapter.locatePath !== 'function') continue;
      if (adapter.dependsOn !== undefined && !installed.has(adapter.dependsOn)) continue;
      const path = await locateCacheDir(adapter, { home, env }, context);
      if (typeof path !== 'string' || path === '') continue;
      derived.push({ adapter, path });
    }

    // 派生条目：pnpm 升级后留下的旧版本存储目录。没有官方命令能清它
    // （`pnpm store prune` 只管当前这一代），所以它是自己长出来的条目。
    const orphans = [];
    const pnpmStoreDir = context.pnpmStoreDir;
    if (typeof pnpmStoreDir === 'string' && pnpmStoreDir !== '') {
      for (const orphan of await findOrphanStoreVersions(pnpmStoreDir)) {
        orphans.push({
          adapter: {
            id: 'pnpm-store-orphan',
            label: 'pnpm 旧版本存储',
            tool: 'pnpm',
            semantics: 'prune',
            risk: 'medium',
            note: 'pnpm 升级到新版本之后，旧的一代存储目录没人再写也没人再读，但没有任何官方命令会清它。',
          },
          path: orphan,
          cleanCommand: null,
          cleanPath: true,
          commandText: '（定向删除该目录）',
        });
      }
    }

    const items = [];

    /**
     * 量一个条目的体积并造出条目对象。
     *
     * @param {object} entry 待准备的条目（adapter + path）。
     * @returns {Promise<object|null>} 条目；目录不存在就是 null。
     */
    const prepare = async (entry) => {
      const adapter = entry.adapter;
      const path = typeof adapter.itemPath === 'function' ? adapter.itemPath(entry.path) : entry.path;
      if (typeof path !== 'string' || path === '') return null;
      const sizeBytes = measure ? await measureBytes(path) : null;
      // 量不到 = 目录不存在（工具装了但从没用过）；量到 0 = 空的（或者这台机器上
      // 没权限读 —— macOS 的隐私保护会让 du 报 0）。两种都不该出现在清单里：
      // 否则用户会勾一个「清理一个不存在的东西」，或者一个量不出体积的条目。
      if (measure && (sizeBytes === null || sizeBytes === 0)) return null;
      const cleanCommand = entry.cleanCommand !== undefined ? entry.cleanCommand : (adapter.clean === undefined ? null : adapter.clean);
      return {
        id: adapter.id,
        label: adapter.label,
        group: 'cache',
        tool: adapter.tool,
        semantics: adapter.semantics,
        risk: adapter.risk,
        note: adapter.note,
        path,
        sizeBytes: sizeBytes === null ? 0 : sizeBytes,
        count: 1,
        cleanCommand,
        cleanPath: entry.cleanPath === true || adapter.cleanPath === true,
        commandText: entry.commandText !== undefined
          ? entry.commandText
          : (formatCommand(adapter.clean) !== '' ? formatCommand(adapter.clean) : '（定向删除目录，正在使用的会自动跳过）'),
        selectedByDefault: true,
        detail: { tool: adapter.tool, path },
        action: cleanCommand === null
          ? { type: 'remove-dir', path }
          : { type: 'command', cmd: cleanCommand.cmd, args: cleanCommand.args },
        orphan: adapter.id === 'pnpm-store-orphan',
      };
    };

    /**
     * 收下一个条目。
     *
     * @param {object} item 条目。
     */
    const accept = (item) => {
      if (item === null) return;
      items.push(item);
      if (onItem !== null) onItem(item);
    };

    // 体积测量全部并行。
    await Promise.all([
      ...located.filter((entry) => entry.path !== null).map((entry) => prepare(entry).then(accept)),
      ...derived.map((entry) => prepare(entry).then(accept)),
      ...orphans.map((entry) => prepare(entry).then(accept)),
    ]);

    // 收尾按适配器顺序排好（孤儿条目永远在最后）。
    const order = new Map(ADAPTERS.map((adapter, index) => [adapter.id, index]));
    items.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
    return items;
  }

  /**
   * 发现**进程与窗口**层面的可加速项。
   *
   * 这一层的护栏比磁盘那层更严：动的是**正在跑的程序**。
   *   · 内存按应用聚合（浏览器是几十个进程，逐个列用户没法判断）；
   *   · CPU 是两次采样求差算出来的瞬时占用，不是 ps 那个「进程活着的平均」；
   *   · 结束应用与关闭窗口会丢未保存的内容，所以默认**不勾**；
   *   · 降优先级无损，所以默认**勾**。
   *
   * @returns {Promise<Array<object>>} 条目。
   */
  async function discoverProcesses() {
    const { processes, protectedPids, frontApp } = await sampleProcesses();
    const items = [];

    /* 占内存的应用 —— 结束它等于关掉这个应用。 */
    const apps = aggregateByApp(processes).filter((app) => app.rssBytes >= BIG_APP_BYTES);
    for (const app of apps.slice(0, MAX_PROCESS_ITEMS)) {
      const sample = processes.find((proc) => proc.pid === app.mainPid);
      if (sample === undefined) continue;
      if (!checkProcessAllowed(sample, protectedPids, frontApp).ok) continue;
      // 只带**通过护栏**的 pid：DSH 自己那棵树上的进程（工具链的浏览器就是
      // DSH 起的）绝不能进结束名单。
      const targets = [];
      const expect = {};
      for (const proc of app.members) {
        if (!checkProcessAllowed(proc, protectedPids, frontApp).ok) continue;
        targets.push(proc.pid);
        expect[String(proc.pid)] = proc.command.split(' ')[0];
      }
      if (targets.length === 0) continue;
      items.push({
        id: `mem-app:${app.app}`,
        label: `结束 ${displayApp(app.app)} 的全部进程`,
        group: 'process',
        semantics: 'terminate',
        risk: 'high',
        note: `占 ${humanBytes(app.rssBytes)} 内存（${app.count} 个进程）。结束它等于关掉这个应用 —— 没保存的内容会丢。想只结束其中几个，看下面按进程列的那些。`,
        sizeBytes: 0,
        count: targets.length,
        commandText: `结束 ${targets.length} 个进程`,
        selectedByDefault: false,
        detail: { app: app.app, rssBytes: app.rssBytes, count: targets.length },
        action: { type: 'terminate', pids: targets, expect },
      });
    }

    /* 占内存的大进程 —— 逐个列，用户自己挑要结束哪个。 */
    const heavy = processes
      .filter((proc) => proc.rssBytes >= BIG_PROC_BYTES)
      .sort((a, b) => b.rssBytes - a.rssBytes)
      .slice(0, MAX_PROC_ITEMS);
    for (const proc of heavy) {
      if (!checkProcessAllowed(proc, protectedPids, frontApp).ok) continue;
      items.push({
        id: `mem-proc:${proc.pid}`,
        label: `结束 ${processLabel(proc)}`,
        group: 'process',
        semantics: 'terminate',
        risk: 'high',
        note: `${displayApp(proc.app)} 的一个进程，占 ${humanBytes(proc.rssBytes)} 内存（pid ${proc.pid}）。结束它通常等于关掉一个标签页或一个窗口。`,
        sizeBytes: 0,
        count: 1,
        commandText: `结束 pid ${proc.pid}`,
        selectedByDefault: false,
        detail: { pid: proc.pid, app: proc.app, rssBytes: proc.rssBytes, name: processLabel(proc) },
        action: { type: 'terminate', pids: [proc.pid], expect: { [proc.pid]: proc.command.split(' ')[0] } },
      });
    }

    /* 后台高占 CPU 的任务 —— 降优先级，无损。 */
    const hot = processes
      .filter((proc) => proc.cpuPct >= HOT_CPU_PCT)
      .sort((a, b) => b.cpuPct - a.cpuPct)
      .slice(0, MAX_PROCESS_ITEMS);
    for (const proc of hot) {
      if (!checkProcessAllowed(proc, protectedPids, frontApp).ok) continue;
      items.push({
        id: `cpu:${proc.pid}`,
        label: `降低 ${processLabel(proc)} 的优先级`,
        group: 'process',
        semantics: 'renice',
        risk: 'low',
        note: `此刻占 ${proc.cpuPct}% CPU（${humanBytes(proc.rssBytes)} 内存）。降优先级不会关掉它，只是不再抢 CPU。`,
        sizeBytes: 0,
        count: 1,
        commandText: `renice +10 ${proc.pid}`,
        selectedByDefault: true,
        detail: { pid: proc.pid, app: proc.app, cpuPct: proc.cpuPct },
        action: { type: 'renice', pids: [proc.pid], delta: 10 },
      });
    }

    /* 孤儿子进程 —— 父进程没了自己还在跑的一次性工具。 */
    const orphans = findOrphanProcesses(processes)
      .filter((proc) => checkProcessAllowed(proc, protectedPids, frontApp).ok);
    if (orphans.length > 0) {
      const expect = {};
      for (const proc of orphans) expect[String(proc.pid)] = proc.command.split(' ')[0];
      items.push({
        id: 'orphan-processes',
        label: `结束 ${orphans.length} 个孤儿子进程`,
        group: 'process',
        semantics: 'terminate',
        risk: 'medium',
        note: '父进程已经没了、自己还在跑的一次性命令行工具 —— 通常是崩了没退干净。',
        sizeBytes: 0,
        count: orphans.length,
        commandText: `结束 ${orphans.length} 个进程`,
        selectedByDefault: true,
        detail: { pids: orphans.map((proc) => proc.pid) },
        action: { type: 'terminate', pids: orphans.map((proc) => proc.pid), expect },
      });
    }

    /* 浏览器里非聚焦的窗口。 */
    const windows = await listBrowserWindows();
    for (const win of windows) {
      if (win.focused) continue;
      items.push({
        id: `window:${win.browser}:${win.windowId}`,
        label: `关闭 ${win.browserLabel} 窗口：${win.title === '' ? '(无标题)' : win.title}`,
        group: 'process',
        semantics: 'close-window',
        risk: 'medium',
        note: `${win.tabCount} 个标签页。浏览器能重开刚关掉的窗口，但页面里没保存的内容会丢。`,
        sizeBytes: 0,
        count: win.tabCount,
        commandText: `关闭 ${win.browserLabel} 的这个窗口`,
        selectedByDefault: false,
        detail: win,
        action: { type: 'close-window', windows: [win] },
      });
    }

    return items;
  }

  /**
   * 跑一次体检（后台）。
   *
   * @param {{force: boolean}} params 参数。
   * @returns {object} 任务快照。
   */
  function scan(params) {
    const force = params.force === true;
    if (!force && job !== null && job.running !== true && Date.now() - job.finishedAt < SCAN_TTL_MS) {
      return job;
    }
    jobCounter += 1;
    const current = {
      id: `boost-${jobCounter}`,
      running: true,
      startedAt: Date.now(),
      finishedAt: 0,
      facts: null,
      items: [],
      analysis: null,
      error: '',
    };
    job = current;

    const run = async () => {
      try {
        const facts = await probeSystem({ home, env, platform });
        current.facts = facts;
        const caches = await discover({
          measure: true,
          onItem: (item) => {
            sizes.set(item.id, item.sizeBytes);
            current.items.push(item);
          },
        });
        // DSH 自己的数据与进程层面的项并行发现 —— 两者都不需要等体积测量。
        const [dshItems, processItems] = await Promise.all([
          listDshItems({ dshHome, liveSessionIds: liveSessionIds() }),
          discoverProcesses(),
        ]);
        const items = [...caches, ...dshItems, ...processItems];
        current.items = items;
        lastItems = items;
        const llm = options.llm();
        current.analysis = await analyzeSystem({
          llm,
          provider: analysisConfig.provider,
          model: analysisConfig.model,
          facts,
          items,
          maxTokens: analysisConfig.maxOutputTokens,
        });
      } catch (error) {
        current.error = `${error?.message ?? String(error)}`;
      } finally {
        current.running = false;
        current.finishedAt = Date.now();
      }
    };
    run();

    return current;
  }

  /**
   * 执行用户勾选的条目（同步，等全部做完）。
   *
   * Agent 工具走这条：工具本来就要等结果，直接等最省事。
   *
   * @param {string[]} itemIds 条目 id。
   * @returns {Promise<object>} 执行结果。
   */
  async function execute(itemIds, hooks) {
    const onItem = hooks !== undefined && typeof hooks.onItem === 'function' ? hooks.onItem : null;
    const ids = Array.isArray(itemIds)
      ? itemIds.filter((id) => typeof id === 'string' && id.trim() !== '')
      : [];
    if (ids.length === 0) return { ok: false, error: '没有勾选任何项目' };

    // 路径重新解析：客户端只给 id，这里按适配器重新问一遍工具。
    // DSH 与进程类的条目从上一次体检的清单里找 —— 它们的动作在体检时就定下了，
    // 执行器会再复核一遍（pid 重新核对命令行、会话重新核对是否还活着）。
    const items = await discover({ measure: false, onItem: null });
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const item of lastItems) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
    const targets = [];
    const results = [];
    for (const id of ids) {
      const item = byId.get(id);
      if (item === undefined) {
        const skipped = {
          id,
          label: id,
          group: 'unknown',
          ok: false,
          skipped: true,
          reason: '这台机器上找不到对应的项目，已跳过',
          reclaimedBytes: 0,
          durationMs: 0,
        };
        results.push(skipped);
        if (onItem !== null) onItem(skipped);
        continue;
      }
      targets.push({
        ...item,
        sizeBytes: sizes.get(item.id) ?? 0,
      });
    }
    if (targets.length === 0) {
      return { ok: false, error: '勾选的项目在这台机器上都不存在', results };
    }
    const outcome = await executor.execute(targets, onItem);
    return {
      ok: outcome.results.every((item) => item.ok === true || item.skipped === true),
      results: [...results, ...outcome.results],
      reclaimedBytes: outcome.reclaimedBytes,
    };
  }

  /**
   * 执行用户勾选的条目（后台任务，逐项出结果）。
   *
   * 清理一条 npm 缓存可能要一分钟，整批下来好几分钟 —— 同步返回的话浏览器就
   * 干等着，用户不知道跑到哪了。所以这里起一个后台任务：立刻返回任务号，
   * 客户端轮询看「跑到第几项、这一项在做什么」。
   *
   * @param {string[]} itemIds 条目 id。
   * @returns {object} 任务快照。
   */
  function executeAsync(itemIds) {
    const ids = Array.isArray(itemIds)
      ? itemIds.filter((id) => typeof id === 'string' && id.trim() !== '')
      : [];
    jobCounter += 1;
    const current = {
      id: `boost-exec-${jobCounter}`,
      running: true,
      startedAt: Date.now(),
      finishedAt: 0,
      total: ids.length,
      done: 0,
      currentLabel: '',
      items: [],
      results: [],
      reclaimedBytes: 0,
      error: '',
    };
    executeJob = current;

    const run = async () => {
      try {
        const outcome = await execute(ids, {
          onItem: (result) => {
            current.results.push(result);
            current.done = current.results.length;
            current.currentLabel = result.label;
            if (result.reclaimedBytes) current.reclaimedBytes += result.reclaimedBytes;
          },
        });
        current.error = outcome.ok ? '' : (outcome.error ?? '');
      } catch (error) {
        current.error = `${error?.message ?? String(error)}`;
      } finally {
        current.running = false;
        current.finishedAt = Date.now();
      }
    };
    run();
    return current;
  }

  /**
   * 后台自动体检：机器空闲时，每 12 小时自己查一次（每天两次）。
   *
   * 为什么要有：小火箭是「点开就看」的东西，但体检本身要读几十 GB 的目录，
   * 点开才扫就得等半分钟到一分多钟。挪到后台之后，点开是秒开，代价是平时
   * 机器闲的时候自己扫一遍。
   *
   * 什么时候不扫：机器正忙（1 分钟负载超过阈值）、上一次体检还在跑、上一次
   * 结果还不满 12 小时。
   *
   * @param {{tickMs?: number, trigger?: Function, idle?: Function}} [params] 参数（tickMs / trigger / idle 供自检用）。
   * @returns {Function} 停掉它的函数。
   */
  function startAutoScan(params) {
    const options = params !== undefined && params !== null ? params : {};
    const tickMs = typeof options.tickMs === 'number' ? options.tickMs : AUTO_SCAN_TICK_MS;
    const trigger = typeof options.trigger === 'function'
      ? options.trigger
      : function () { scan({ force: true }); };
    const idle = typeof options.idle === 'function' ? options.idle : isMachineIdle;
    const timer = setInterval(function () {
      const current = job;
      const finishedAt = current === null ? 0 : (current.finishedAt > 0 ? current.finishedAt : current.startedAt);
      const due = shouldAutoScan({
        idle: idle(),
        running: current !== null && current.running === true,
        lastFinishedAt: finishedAt,
        now: Date.now(),
        intervalMs: AUTO_SCAN_INTERVAL_MS,
      });
      if (!due) return;
      trigger();
    }, tickMs);
    // 别让这个定时器把进程吊着。
    if (typeof timer.unref === 'function') timer.unref();
    return function () { clearInterval(timer); };
  }

  return {
    scan,
    status() {
      return job;
    },
    startAutoScan,
    execute,
    executeAsync,
    executeStatus() {
      return executeJob;
    },
  };
}
