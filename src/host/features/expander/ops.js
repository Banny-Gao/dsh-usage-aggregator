// src/host/features/expander/ops.js
//
// 原 dsh-plugin-expander/lib/ops.js —— 整体搬过来，只多了「自我保护」那一节
// （RETIRED_PACKAGES / SELF_PACKAGE，见下）。
//
// 这个插件的全部业务都在这里：查出每个已装插件的「有没有新版本」，以及执行更新。
//
// 两件要复用、绝不重写的事：
//   · 已装清单 → 官方插件管理器的 listBundles()（它是唯一的事实来源）。
//   · 更新动作 → 官方插件管理器的 removeBundle() + installBundle()。
//     官方 Web 页的「更新」按钮做的也是这两步；我们只是把「卸载再安装」这件事
//     变成一次点击，并补上它缺的那一环：**查注册表里的真实最新版本**。
//
// 官方管理器的 inspect() 对已安装包直接返回 already-installed，所以「最新版本」
// 只能自己问：npm 包用 pnpm view（和官方管理器同一套注册表顺序、同一套认证），
// git 包用 git ls-remote 拿远端 HEAD，和锁文件里钉住的提交比。

import { join } from 'node:path';
import { runCommand } from './proc.js';
import { compareVersions, isUpgrade, parseDependencySource } from './registry.js';
import { readLockedCommits } from './lockfile.js';

/**
 * 已退役的包名：**能力已经并进本聚合插件的三个老插件**。
 *
 * 为什么必须把它们挡在清单之外：
 *   这些包一旦还留在 profile 的 package.json / pnpm-lock.yaml 里，就会被
 *   listBundles() 枚举出来。清单是「无条件枚举全部 profile 插件」的，而
 *   「更新全部」会用 `name@latest`（npm）或**原始 source**（git）把它们装回来 ——
 *   那等于把已经并进来的功能又装一份，与聚合体功能重复。
 *
 * 所以：它们不该再出现在清单里。列出来只会诱导用户点「更新」把它们复活。
 *
 * ⚠️ 精确匹配包名，不要用模糊匹配（正则 / 前缀 / includes）：
 *   `dsh-usage-query` 与 `dsh-usage-query-helper` 是两个不同的包，
 *   模糊匹配会误伤无辜的后者。
 */
export const RETIRED_PACKAGES = new Set([
  /** 品牌主题：已并入本聚合插件的 theme 功能。 */
  'dsh-axzo-theme',
  /** 用量查询：已并入本聚合插件的 usage 功能。 */
  'dsh-usage-query',
  /** 本功能的老家：已并入本聚合插件的 expander 功能。 */
  'dsh-plugin-expander',
]);

/**
 * 本聚合包自己的包名。
 *
 * 为什么它要特殊对待：
 *   聚合包自己也在清单里（这是对的 —— check 时应该能看到自己）。但它**不能被自己
 *   更新**：若它以 npm 形式安装，「更新全部」会走
 *   removeBundle('dsh-usage-aggregator') + installBundle(...) ——
 *   也就是**把正在运行的那个插件卸载掉再装回来**，中途整个插件（含本功能自己）
 *   从宿主上消失，等于自我毁灭。
 *
 * 规则：
 *   ① 清单里保留自己（可见），但 updatable 恒为 false，描述里说明原因；
 *   ② updatableNames()（「全部更新」的目标列表）排除自己；
 *   ③ updateOne(自己) 直接拒绝，不做任何 remove/install。
 */
export const SELF_PACKAGE = 'dsh-usage-aggregator';

/** 一个插件此刻的状态。 */
export const STATUS = {
  /** 远端有更新。 */
  UPDATE: 'update-available',
  /** 已是最新。 */
  CURRENT: 'current',
  /** 本地版本比远端还新（多半是 pin 住的预发布版），不该动它。 */
  AHEAD: 'ahead',
  /** 查不到（源不可达、包已下架、锁文件读不出来……），不猜。 */
  UNKNOWN: 'unknown',
  /** git 依赖固定在某个提交上，重装也拿不到新代码。 */
  PINNED: 'pinned',
  /** 本地开发包（link:/file:），版本由你自己的工作区决定。 */
  LOCAL: 'local',
};

/** 清单缓存的有效期：这段时间内重复打开面板不重查注册表。 */
const CACHE_TTL_MS = 60000;

/**
 * 创建操作层。
 *
 * @param {{
 *   getManager: () => {listBundles: () => Promise<object[]>, registries: () => Promise<object>, removeBundle: (name: string) => Promise<object>, installBundle: (spec: string, options?: object) => Promise<object>}|null,
 *   getProfileDir: () => string,
 *   getPnpm?: () => {command: string, args: string[]},
 *   checkTimeoutMs?: number,
 *   gitTimeoutMs?: number,
 *   run?: typeof runCommand,
 * }} options 依赖。
 * @returns {object} 操作层。
 */
export function createOps(options) {
  const getManager = options.getManager;
  const getProfileDir = options.getProfileDir;
  const getPnpm = options.getPnpm ?? (() => ({ command: 'pnpm', args: [] }));
  const checkTimeoutMs = options.checkTimeoutMs ?? 20000;
  const gitTimeoutMs = options.gitTimeoutMs ?? 15000;
  const run = options.run ?? runCommand;

  let cache = null;
  const job = { running: false, current: null, results: [], startedAt: null, finishedAt: null };

  /**
   * 官方插件管理器。没有它（组合里没装 base）就没有「已装清单」这件事。
   *
   * @returns {object|null} 管理器。
   */
  function manager() {
    const current = getManager();
    if (current === undefined || current === null) throw new Error('插件管理器不可用：当前组合没有官方插件管理服务');
    return current;
  }

  /**
   * 注册表问询顺序：先配置的那个，再依次问它的备用源。
   *
   * @returns {Promise<(string|null)[]>} 注册表列表，null 表示「用 pnpm 自己的配置」。
   */
  async function registryPlan() {
    const registries = await manager().registries();
    const plan = [];
    const push = (registry) => {
      const value = registry === undefined ? null : registry;
      if (!plan.includes(value)) plan.push(value);
    };
    push(registries.registry);
    for (const fallback of registries.fallbackRegistries ?? []) push(fallback);
    if (plan.length === 0) push(null);
    return plan;
  }

  /**
   * 从 pnpm view 的输出里取出版本号。
   *
   * @param {string} stdout 命令输出。
   * @returns {string|null} 版本号。
   */
  function parseViewVersion(stdout) {
    const text = stdout.trim();
    if (text === '') return null;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const candidate of candidates.reverse()) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
      if (candidate !== null && typeof candidate === 'object' && typeof candidate.version === 'string') return candidate.version;
    }
    return null;
  }

  /**
   * 问注册表：这个包最新的版本是多少。
   *
   * 逐个问计划里的注册表，第一个给出答案的就是它 —— 和官方管理器安装时
   * 「一个源不可达就换下一个」的策略一致。
   *
   * @param {string} name 包名。
   * @returns {Promise<string|null>} 最新版本；查不到就是 null。
   */
  async function npmLatest(name) {
    const pnpm = getPnpm();
    for (const registry of await registryPlan()) {
      const args = [...pnpm.args, 'view', name, 'name', 'version', '--json'];
      if (registry !== null) args.push(`--registry=${registry}`);
      args.push('--config.fetch-retries=0');
      const result = await run(pnpm.command, args, { cwd: getProfileDir(), timeoutMs: checkTimeoutMs });
      if (result.code !== 0) continue;
      const version = parseViewVersion(result.stdout);
      if (version !== null) return version;
    }
    return null;
  }

  /**
   * 问远端仓库：HEAD 现在指向哪个提交。
   *
   * @param {string} url 仓库地址。
   * @param {string|null} ref 分支或标签；null 表示默认分支。
   * @returns {Promise<string|null>} 提交号；问不到就是 null。
   */
  async function gitHead(url, ref) {
    const result = await run('git', ['ls-remote', url, ref ?? 'HEAD'], {
      cwd: getProfileDir(),
      timeoutMs: gitTimeoutMs,
      env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    if (result.code !== 0) return null;
    const line = result.stdout.trim().split('\n')[0] ?? '';
    const sha = line.split(/\s+/)[0] ?? '';
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  }

  /**
   * 描述一个已装插件：它从哪儿装的、有没有新版本、能不能自动更新。
   *
   * @param {object} bundle 插件管理器给的一条已装插件。
   * @param {Map<string, string>} commits 锁文件里 git 依赖钉住的提交。
   * @returns {Promise<object>} 面板与工具都能直接用的描述。
   */
  async function describeBundle(bundle, commits) {
    const base = {
      name: bundle.name,
      title: textOf(bundle.meta?.title) ?? bundle.name,
      description: textOf(bundle.meta?.description) ?? bundle.description ?? '',
      version: bundle.version ?? null,
      enabled: bundle.enabled === true,
      rows: Array.isArray(bundle.rows) ? bundle.rows.length : 0,
      spec: bundle.source ?? null,
    };
    const parsed = parseDependencySource(bundle.source);
    if (parsed.kind === 'local') {
      return { ...base, kind: 'local', status: STATUS.LOCAL, latest: null, updatable: false };
    }
    if (parsed.kind === 'alias') {
      return { ...base, kind: 'npm', status: STATUS.UNKNOWN, latest: null, updatable: false };
    }
    if (parsed.kind === 'npm') {
      const latest = await npmLatest(parsed.name);
      if (latest === null) {
        return { ...base, kind: 'npm', status: STATUS.UNKNOWN, latest: null, updatable: false };
      }
      const comparison = compareVersions(latest, base.version ?? '');
      const status = comparison === null
        ? STATUS.UNKNOWN
        : comparison > 0
          ? STATUS.UPDATE
          : comparison === 0
            ? STATUS.CURRENT
            : STATUS.AHEAD;
      return { ...base, kind: 'npm', status, latest, updatable: status === STATUS.UPDATE, range: parsed.range ?? null };
    }
    if (parsed.kind === 'git') {
      // 固定提交的包：重装还是那个提交，不该报「有更新」。
      if (parsed.pinned !== null) {
        return { ...base, kind: 'git', status: STATUS.PINNED, latest: parsed.pinned.slice(0, 7), updatable: false };
      }
      const locked = commits.get(bundle.name) ?? null;
      const head = await gitHead(parsed.url, parsed.ref);
      if (locked === null || head === null) {
        return { ...base, kind: 'git', status: STATUS.UNKNOWN, latest: head === null ? null : head.slice(0, 7), updatable: false };
      }
      const status = locked === head ? STATUS.CURRENT : STATUS.UPDATE;
      return { ...base, kind: 'git', status, latest: head.slice(0, 7), updatable: status === STATUS.UPDATE };
    }
    return { ...base, kind: 'unknown', status: STATUS.UNKNOWN, latest: null, updatable: false };
  }

  /**
   * 列出这个 profile 里所有「自己能管」的已装插件，并查它们的新版本。
   *
   * 只收 availability === 'profile' 的：随 DSH 发行版一起装的那批由 DSH 版本
   * 决定，不在这个插件的管辖范围内。
   *
   * ⚠️ 还要挡掉 RETIRED_PACKAGES：它们的能力已经并进本聚合插件，留着只会诱导
   * 用户点「更新」把它们复活（见 RETIRED_PACKAGES 的注释）。
   *
   * @returns {Promise<object[]>} 插件描述列表。
   */
  async function describeAll() {
    const bundles = await manager().listBundles();
    const commits = await readLockedCommits(join(getProfileDir(), 'pnpm-lock.yaml'));
    const owned = bundles.filter((bundle) =>
      bundle.installed === true &&
      bundle.availability === 'profile' &&
      !RETIRED_PACKAGES.has(bundle.name));
    const described = [];
    for (const bundle of owned) described.push(applySelfGuard(bundle.name, await describeBundle(bundle, commits)));
    return described;
  }

  /**
   * 把管理器的失败结果翻译成一句人能读的话。
   *
   * @param {object} result 管理器返回的结果。
   * @returns {string} 失败原因。
   */
  function errorText(result) {
    const code = result?.error?.code;
    const diagnostic = result?.error?.diagnostic;
    if (typeof code === 'string') {
      return typeof diagnostic === 'string' && diagnostic !== '' ? `${code}：${diagnostic}` : code;
    }
    const kind = result?.packageResult?.kind;
    if (typeof kind === 'string') {
      const output = String(result.packageResult?.output ?? '').trim().split('\n').slice(-3).join(' / ');
      return output === '' ? kind : `${kind}：${output}`;
    }
    return '未知错误';
  }

  /**
   * 更新一个插件：先卸载，再按目标版本装回来。
   *
   * 官方管理器的规则是「装另一个版本必须先卸载」—— 有 HMR 时它会先把旧插件停掉、
   * 逐出模块，再装新的；没有 HMR 时会报 restart-required，提示重启后生效。
   *
   * @param {string} name 插件包名。
   * @returns {Promise<object>} 更新结果。
   */
  async function updateOne(name) {
    // 自我保护 ②：正在运行的插件自己不能被自己更新 ——
    // 走一遍 remove + install 等于把宿主上正跑着的东西卸载掉再装回来。
    if (name === SELF_PACKAGE) {
      return { name, ok: false, stage: 'check', error: '不能更新正在运行的插件自己' };
    }
    // 自我保护（退役包）：这三个包的能力已经并进本聚合插件，装回来就是重复功能。
    if (RETIRED_PACKAGES.has(name)) {
      return { name, ok: false, stage: 'check', error: '这个插件已经退役，能力已并入 dsh-usage-aggregator，不应再装回来' };
    }
    const current = manager();
    const bundles = await current.listBundles();
    const bundle = bundles.find((candidate) => candidate.name === name);
    if (bundle === undefined) return { name, ok: false, stage: 'select', error: '找不到这个插件' };
    const parsed = parseDependencySource(bundle.source);
    let spec;
    if (parsed.kind === 'npm') {
      const latest = await npmLatest(parsed.name);
      if (latest === null) return { name, ok: false, stage: 'check', error: '查不到注册表里的最新版本' };
      if (bundle.version !== null && bundle.version !== undefined && !isUpgrade(bundle.version, latest)) {
        return { name, ok: false, stage: 'check', error: `已经是 ${latest}，没有可更新的版本` };
      }
      spec = `${parsed.name}@${latest}`;
    } else if (parsed.kind === 'git') {
      spec = bundle.source;
    } else {
      return { name, ok: false, stage: 'check', error: '这个插件不是从注册表或 git 装的，无法自动更新' };
    }
    const wasEnabled = bundle.enabled === true;
    const removed = await current.removeBundle(name);
    if (removed?.application === 'failed' || removed?.application === 'cancelled') {
      return { name, ok: false, stage: 'remove', error: errorText(removed) };
    }
    const installed = await current.installBundle(spec, { enabled: wasEnabled });
    const ok = installed?.application === 'applied' || installed?.application === 'restart-required';
    return {
      name,
      ok,
      stage: 'install',
      spec,
      application: installed?.application ?? 'failed',
      error: ok ? undefined : errorText(installed),
      result: installed,
    };
  }

  /**
   * 面板与工具共用的当前状态。
   *
   * @param {{refresh?: boolean}} options refresh 为真时强制重查注册表。
   * @returns {Promise<object>} 状态。
   */
  async function state(options = {}) {
    const refresh = options.refresh === true;
    const fresh = cache !== null && Date.now() - cache.checkedAt < CACHE_TTL_MS;
    if (!refresh && fresh) {
      return { ok: true, ...cache, job: jobView() };
    }
    const packages = await describeAll();
    const summary = {
      total: packages.length,
      updatable: packages.filter((item) => item.updatable).length,
      current: packages.filter((item) => item.status === STATUS.CURRENT).length,
      other: packages.filter((item) => item.status !== STATUS.UPDATE && item.status !== STATUS.CURRENT).length,
    };
    cache = { checkedAt: Date.now(), packages, summary };
    return { ok: true, ...cache, job: jobView() };
  }

  /**
   * 任务视图：正在更新谁、已经更新了哪些、哪些失败了。
   *
   * @returns {object} 任务状态。
   */
  function jobView() {
    return {
      running: job.running,
      current: job.current,
      results: job.results,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }

  /**
   * 启动一次更新（后台跑，调用方立刻返回）。
   *
   * 更新要跑 pnpm，可能几分钟；HTTP 接口不能一直挂着，所以这里开一个后台任务，
   * 面板轮询 state() 看进度。
   *
   * @param {string[]} names 要更新的插件包名。
   * @returns {Promise<object>} 启动结果。
   */
  async function startUpdate(names) {
    if (job.running) return { ok: false, error: '已有更新任务在进行中' };
    const list = [...names];
    if (list.length === 0) return { ok: false, error: '没有要更新的插件' };
    job.running = true;
    job.current = null;
    job.results = [];
    job.startedAt = Date.now();
    job.finishedAt = null;
    void (async () => {
      for (const name of list) {
        job.current = name;
        try {
          job.results.push(await updateOne(name));
        } catch (error) {
          job.results.push({ name, ok: false, stage: 'install', error: String(error?.message ?? error) });
        }
      }
      job.current = null;
      job.running = false;
      job.finishedAt = Date.now();
      cache = null;
    })();
    return { ok: true, started: list };
  }

  /**
   * 同步跑一次更新（Agent 工具用；它可以等）。
   *
   * @param {string[]} names 要更新的插件包名。
   * @returns {Promise<object[]>} 每个插件的结果。
   */
  async function updateNow(names) {
    const results = [];
    for (const name of names) {
      try {
        results.push(await updateOne(name));
      } catch (error) {
        results.push({ name, ok: false, stage: 'install', error: String(error?.message ?? error) });
      }
    }
    cache = null;
    return results;
  }

  return {
    state,
    startUpdate,
    updateNow,
    // 自我保护 ①：「全部更新」的目标列表排除自己 ——
    // 自己永远不在 updatable 名单里（describeAll 里已把它标成不可更新），
    // 这里再排一次是第二道保险。
    updatableNames: async () => (await state())
      .packages
      .filter((item) => item.updatable === true && item.name !== SELF_PACKAGE)
      .map((item) => item.name),
  };
}

/**
 * 自我保护 ③：清单里「自己」那一条 —— 可见，但不可更新，描述里说明原因。
 *
 * 只按包名**精确**匹配（=== SELF_PACKAGE），不做模糊匹配。
 *
 * @param {string} name 包名。
 * @param {object} described 描述好的插件条目。
 * @returns {object} 处理后的条目。
 */
function applySelfGuard(name, described) {
  if (name !== SELF_PACKAGE) return described;
  const note = '这是正在运行的插件自己，不能由它更新自己';
  const description = typeof described.description === 'string' && described.description !== ''
    ? `${described.description}（${note}）`
    : `（${note}）`;
  return { ...described, updatable: false, description };
}

/**
 * 从本地化的元信息里取一句文本。
 *
 * 元信息可能是字符串，也可能是一张按语言分的表；这里只取能直接显示的那一份。
 *
 * @param {unknown} value 元信息字段。
 * @returns {string|null} 文本。
 */
function textOf(value) {
  if (typeof value === 'string') return value === '' ? null : value;
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      if (typeof entry === 'string' && entry !== '') return entry;
    }
  }
  return null;
}
