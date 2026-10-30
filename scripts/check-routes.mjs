#!/usr/bin/env node
/**
 * scripts/check-routes.mjs
 *
 * 收集三个功能注册的全部路由路径，断言**全局唯一**。
 *
 * 为什么这条要单独一个脚本
 * ----------------------
 * dsh-host-webserver 的 register() 以 (kind, path) 为键，重复注册会**直接 throw**
 * —— 那会让插件 entry 加载失败，整页报 "Failed to load plugins"。
 *
 * 聚合之后三个功能住在同一个插件里、各自挂一段前缀（/usage、/expander）。
 * 只要有人把某段前缀写错（比如两个功能都挂在 /usage 下），或者某个功能忘了
 * 加前缀直接挂在公共前缀上，就会在真机上炸 —— 而这里跑一次就抓得到。
 *
 * 怎么收集
 * --------
 * 不去猜每个功能的内部 API：直接按功能契约调用 `feature.apply(ctx, config, shared)`，
 * 给它一个**假的 webServer**，把 register() 收到的路径全记下来。
 * 这样新增功能时这条断言自动覆盖到，不需要改脚本。
 *
 * 用法：node scripts/check-routes.mjs
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 公共前缀。与 cordis.patch.yml 的 config.endpoint 一致。 */
const ENDPOINT = '/dsh-usage-aggregator';

const failures = [];
function bad(label) { failures.push(label); console.log('  ✗ ' + label); }
function ok(label) { console.log('  ✓ ' + label); }

/* ── 临时 DSH_HOME：绝不去动用户真实的 store ── */
const home = await mkdtemp(join(tmpdir(), 'dua-routes-'));
const realDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;

try {
  const featuresModule = await import(pathToFileURL(join(ROOT, 'src', 'host', 'features', 'index.js')).href);
  const contextModule = await import(pathToFileURL(join(ROOT, 'src', 'host', 'shared', 'context.js')).href);

  const features = featuresModule.features ?? [];
  if (!Array.isArray(features) || features.length === 0) {
    bad('src/host/features/index.js 没有导出 features');
  } else {
    ok('功能登记表里有 ' + features.length + ' 个功能：' + features.map((f) => f.id).join(', '));
  }

  /**
   * 共享上下文。
   *
   * ⚠️ autoRefresh 关掉：用量查询功能会在 apply 里起一个 60 秒的定时器 ——
   * 那是给真机用的，自动查询跑起来会去读 store、打上游。自检里留着它会让
   * 脚本不退出，还可能真的去请求外部接口。
   */
  const shared = contextModule.createShared({
    endpoint: ENDPOINT,
    allowRemote: false,
    usage: { autoRefresh: { enabled: false } },
    expander: {},
  });

  /** 收集到的路由：path → 来自哪个功能。 */
  const routes = [];

  const ctx = {
    // 真实 cordis 的 effect 立即执行 fn 并返回 disposer。
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    // 可选注入：给一个假的 webServer，把注册路径记下来。
    //
    // ⚠️ cordis 的 inject 回调收到的是一个 **scope** —— 被注入的服务直接挂在
    // scope 上（scope.webServer），同时 scope 本身还有 context 的方法
    // （scope.effect / scope.on / scope.get）。少了 effect，功能里的
    // `host.effect(() => …)` 就会炸 —— 这里必须照做。
    inject(deps, cb) {
      const scope = {
        effect(fn) {
          const dispose = fn();
          return typeof dispose === 'function' ? dispose : () => {};
        },
        on: () => () => {},
        get: () => null,
      };
      for (const name of deps) {
        if (name === 'webServer') {
          scope.webServer = {
            register(spec) {
              routes.push({ path: spec.path, kind: spec.kind ?? 'exact' });
              return () => {};
            },
            effect(fn) {
              const dispose = fn();
              return typeof dispose === 'function' ? dispose : () => {};
            },
          };
        } else {
          scope[name] = {};
        }
      }
      const dispose = cb(scope);
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get: () => null,
    on: () => () => {},
    tools: { register: () => () => {} },
  };

  for (const feature of features) {
    const before = routes.length;
    try {
      feature.apply(ctx, shared.configOf(feature.id), shared);
    } catch (error) {
      bad(`功能 ${feature.id} 的 apply 抛错：${error?.message ?? String(error)}`);
      continue;
    }
    const added = routes.slice(before);
    if (added.length === 0) {
      console.log('  – 功能 ' + feature.id + ' 没有 Host 路由（纯客户端功能）');
    } else {
      ok('功能 ' + feature.id + ' 注册了 ' + added.length + ' 条路由：' + added.map((r) => r.path).join(', '));
    }
  }

  /* ── 唯一性 ── */
  const seen = new Map();
  const duplicates = [];
  for (const route of routes) {
    if (seen.has(route.path)) duplicates.push(route.path);
    else seen.set(route.path, route);
  }
  if (duplicates.length === 0) ok('全部 ' + routes.length + ' 条路由路径互不相同');
  else bad('路由路径重复（webserver 会直接 throw）：' + [...new Set(duplicates)].join(', '));

  /* ── 每个功能的路由集合必须与约定一致 ──
   * 用量查询：11 条（/usage 下）；插件更新：2 条（/expander/state + /expander/update）。
   *
   * ⚠️ 插件更新**没有**裸的 /expander 那条 —— 原插件 dsh-plugin-expander 本来
   * 就是 GET <base>/state + POST <base>/update，客户端
   * src/client/features/expander/index.js 用的也是 ENDPOINT + '/state'。
   * 多挂一条裸路由既没出处，也会占用一个本该留给别人的路径。
   */
  const EXPECTED = {
    usage: [
      '/usage', '/usage/import', '/usage/refresh', '/usage/renew', '/usage/reanalyze',
      '/usage/remove', '/usage/order', '/usage/models', '/usage/analysis-model',
      '/usage/chip', '/usage/raw',
    ],
    expander: ['/expander/state', '/expander/update'],
  };
  for (const [featureId, suffixes] of Object.entries(EXPECTED)) {
    const actual = routes
      .filter((route) => route.path.startsWith(ENDPOINT + '/' + featureId + '/') || route.path === ENDPOINT + '/' + featureId)
      .map((route) => route.path.slice(ENDPOINT.length))
      .sort();
    const want = suffixes.slice().sort();
    const same = actual.length === want.length && want.every((w, i) => actual[i] === w);
    if (same) ok(`功能 ${featureId} 的 ${want.length} 条路由与约定一致`);
    else bad(`功能 ${featureId} 的路由是 [${actual.join(', ')}]，应当是 [${want.join(', ')}]`);
  }

  /* ── 前缀必须在公共前缀之下 ── */
  const outside = routes.filter((route) => !route.path.startsWith(ENDPOINT + '/'));
  if (outside.length === 0) ok('全部路由都在 ' + ENDPOINT + '/ 之下');
  else bad('有路由挂在公共前缀之外：' + outside.map((r) => r.path).join(', '));

  /* ── 各功能之间不能互相踩（同一段前缀只能有一个功能用）── */
  const prefixes = new Map();
  for (const feature of features) {
    if (typeof feature.routePrefix !== 'string' || feature.routePrefix === '') continue;
    if (prefixes.has(feature.routePrefix)) {
      bad(`两个功能用了同一段路由前缀 '${feature.routePrefix}'：${prefixes.get(feature.routePrefix)} 与 ${feature.id}`);
    } else {
      prefixes.set(feature.routePrefix, feature.id);
    }
  }
  if (prefixes.size > 0) ok('每个功能的路由前缀互不相同：' + [...prefixes.entries()].map(([p, id]) => p + '(' + id + ')').join(', '));
} catch (error) {
  bad('脚本执行失败：' + (error?.message ?? String(error)));
} finally {
  if (realDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = realDshHome;
  await rm(home, { recursive: true, force: true });
}

console.log('');
if (failures.length > 0) {
  console.error('✗ 路由检查失败（' + failures.length + ' 项）：');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 路由路径全局唯一');
