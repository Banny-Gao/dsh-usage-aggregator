#!/usr/bin/env node
/**
 * scripts/boost-check.mjs
 *
 * 「电脑加速与清理」的 Host 半边自检（node scripts/boost-check.mjs）。
 *
 * 覆盖三块：
 *   1. **护栏** —— 路径合法性、在用即跳过。这两条是「不影响系统稳定性、正在运行的
 *      任务及用户数据」的落点，必须有守卫，不能靠人记。
 *   2. **目录表** —— 每个适配器自己声明得完整（探测 / 定位 / 清理命令）。
 *   3. **诊断兜底** —— 没有模型时规则版照样给得出结论。
 *
 * 执行器的删除动作只在一个**临时目录**里做，绝不碰用户真实缓存。
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { ADAPTERS, adapterSupported, formatCommand, runCommand } from '../src/host/features/boost/catalog.js';
import { checkPathAllowed, createExecutor, findInUseSubdirs, isPathInUse, listRunningCommandLines } from '../src/host/features/boost/execute.js';
import { humanBytes, ruleAnalysis } from '../src/host/features/boost/analyze.js';
import { createBoostTool } from '../src/host/features/boost/tool.js';
import { createRouteSpecs } from '../src/host/features/boost/server.js';
import { buildRoutes } from '../src/host/shared/http.js';
import {
  appNameOf,
  checkProcessAllowed,
  findOrphanProcesses,
  parseCpuTime,
  protectedByAncestry,
} from '../src/host/features/boost/processes.js';
import { listDshItems, listSessions } from '../src/host/features/boost/dshself.js';

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

console.log('→ 护栏：路径');

await check('拒绝根目录、家目录本身、层级过浅的路径', () => {
  assert.equal(checkPathAllowed('/', '/Users/x').ok, false);
  assert.equal(checkPathAllowed('/Users/x', '/Users/x').ok, false);
  assert.equal(checkPathAllowed('/Users', '/Users/x').ok, false);
  assert.equal(checkPathAllowed('relative/path', '/Users/x').ok, false);
  assert.equal(checkPathAllowed('', '/Users/x').ok, false);
  assert.equal(checkPathAllowed('/Users/x/../etc', '/Users/x').ok, false);
});

await check('正常的缓存目录放行', () => {
  assert.equal(checkPathAllowed('/Users/x/.npm/_cacache', '/Users/x').ok, true);
  assert.equal(checkPathAllowed('/opt/homebrew/lib/ruby/gems/4.0.0', '/Users/x').ok, true);
});

console.log('→ 护栏：在用即跳过');

await check('命令行里出现过的子目录会被认出来', () => {
  const lines = [
    'node /Users/x/.npm/_npx/abc123/node_modules/.bin/tool',
    '/usr/bin/node /Users/x/.npm/_npx/def456/node_modules/x.js',
    'node /Users/x/.npm/_npx/abc123/node_modules/other',
    'node /Users/x/.npm/_cacache/content-v2/sha512/xyz',
  ];
  const used = findInUseSubdirs('/Users/x/.npm/_npx', lines);
  assert.deepEqual([...used].sort(), ['abc123', 'def456']);
});

await check('「整体在用」只认完整参数，不认更深的路径', () => {
  assert.equal(isPathInUse('/Users/x/cache', ['tail -f /Users/x/cache/inuse/a.txt']), false, '子目录在用不该算整体在用');
  assert.equal(isPathInUse('/Users/x/profile', ['node --user-data-dir=/Users/x/profile']), true);
  assert.equal(isPathInUse('/Users/x/profile', ['node /Users/x/profile/Default/x.js']), false);
});

await check('不同目录不会被认错', () => {
  const used = findInUseSubdirs('/Users/x/.npm/_npx', ['node /Users/x/.npm/_cacache/x']);
  assert.equal(used.size, 0);
});

await check('真机上核对一次：正在跑的进程的目录确实被认出来', async () => {
  const lines = await listRunningCommandLines();
  assert.ok(lines.length > 0, '读不到任何运行中的进程');
  // 拿本机真实的 npx 临时目录来验（有 MCP server 常驻时一定能撞上）。
  const npxRoot = `${process.env.HOME}/.npm/_npx`;
  if (!existsSync(npxRoot)) return;
  const entries = readdirSync(npxRoot);
  if (entries.length === 0) return;
  const expected = new Set();
  for (const line of lines) {
    if (!line.includes(`${npxRoot}/`)) continue;
    expected.add(line.slice(line.indexOf(`${npxRoot}/`) + npxRoot.length + 1).split('/')[0]);
  }
  if (expected.size === 0) return;
  const used = findInUseSubdirs(npxRoot, lines);
  for (const name of expected) {
    assert.ok(used.has(name), `正在运行的目录 ${name} 没被认出来`);
  }
});

await check('执行器：清空目录内容，但保留正在被使用的子目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boost-check-'));
  const cache = join(root, 'cache');
  const inuse = join(cache, 'inuse');
  await mkdir(inuse, { recursive: true });
  await mkdir(join(cache, 'free'), { recursive: true });
  await writeFile(join(inuse, 'a.txt'), 'x');
  await writeFile(join(cache, 'free', 'b.txt'), 'x');

  // 起一个**真的**在跑的进程，它的命令行里带着那个目录 —— 执行器读的是真实的
  // ps 输出，所以这条断言验的是真护栏，不是模拟。
  // 用 tail -f 而不是 sleep：sleep 不接受第二个参数，会立刻退出，
  // 那样 ps 就看不到它了，护栏也就没被真正验到。
  const child = spawn('tail', ['-f', join(inuse, 'a.txt')], { stdio: 'ignore' });
  try {
    // 等 ps 能看见它
    for (let i = 0; i < 20; i += 1) {
      const lines = await listRunningCommandLines();
      if (lines.some((line) => line.includes(inuse))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const executor = createExecutor({ home: root, env: process.env, logPath: '' });
    const outcome = await executor.execute([{
      id: 'test',
      label: '测试',
      group: 'cache',
      path: cache,
      sizeBytes: 0,
      action: { type: 'remove-dir', path: cache },
    }]);
    assert.equal(outcome.results.length, 1);
    assert.equal(outcome.results[0].ok, true, outcome.results[0].reason);
    const left = readdirSync(cache);
    assert.deepEqual(left, ['inuse'], `正在使用的目录被删了，或者别的没删干净：${left.join(',')}`);
    assert.ok(outcome.results[0].reason.includes('inuse'), '结果里没提到保留了哪个目录');
  } finally {
    child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

await check('执行器：拒绝不合法的路径', async () => {
  const executor = createExecutor({ home: '/Users/x', env: process.env, logPath: '' });
  const outcome = await executor.execute([{
    id: 'test',
    label: '测试',
    group: 'cache',
    path: '/',
    sizeBytes: 0,
    action: { type: 'remove-dir', path: '/' },
  }]);
  assert.equal(outcome.results[0].ok, false);
  assert.equal(outcome.results[0].skipped, false);
  assert.ok(outcome.results[0].reason.length > 0, '拒绝时没给出原因');
});

await check('执行器：目录不存在时如实报告「已跳过」', async () => {
  const executor = createExecutor({ home: '/Users/x', env: process.env, logPath: '' });
  const outcome = await executor.execute([{
    id: 'test',
    label: '测试',
    group: 'cache',
    path: '/Users/x/does-not-exist-boost-check',
    sizeBytes: 0,
    action: { type: 'remove-dir', path: '/Users/x/does-not-exist-boost-check' },
  }]);
  assert.equal(outcome.results[0].skipped, true);
  assert.ok(outcome.results[0].reason.includes('不存在'), outcome.results[0].reason);
});

console.log('→ 目录表');

await check('每个适配器都声明齐了（探测 / 定位或路径 / 清理动作）', () => {
  const ids = new Set();
  for (const adapter of ADAPTERS) {
    assert.equal(typeof adapter.id, 'string');
    assert.ok(!ids.has(adapter.id), `id 重复：${adapter.id}`);
    ids.add(adapter.id);
    assert.equal(typeof adapter.label, 'string');
    assert.equal(typeof adapter.tool, 'string');
    assert.ok(adapter.semantics === 'prune' || adapter.semantics === 'full', `${adapter.id} 的 semantics 不认识`);
    assert.ok(adapter.risk === 'low' || adapter.risk === 'medium', `${adapter.id} 的 risk 不认识`);
    assert.ok(typeof adapter.note === 'string' && adapter.note !== '', `${adapter.id} 没有说明`);
    assert.ok(adapter.detect !== undefined && adapter.detect !== null, `${adapter.id} 没有探测命令`);
    assert.ok(typeof adapter.detect.cmd === 'string', `${adapter.id} 的 detect.cmd 不是字符串`);
    // 定位：要么问工具（locate），要么自己算路径（locatePath）
    const hasLocate = adapter.locate !== undefined && adapter.locate !== null;
    const hasPath = typeof adapter.locatePath === 'function';
    assert.ok(hasLocate || hasPath, `${adapter.id} 既没有 locate 也没有 locatePath`);
    // 清理动作：要么有官方命令，要么声明「定向删除」
    const hasClean = adapter.clean !== undefined && adapter.clean !== null;
    assert.ok(hasClean || adapter.cleanPath === true, `${adapter.id} 既没有 clean 命令也不是 cleanPath`);
    if (hasClean) {
      assert.equal(typeof adapter.clean.cmd, 'string', `${adapter.id} 的 clean.cmd 不是字符串`);
      assert.ok(Array.isArray(adapter.clean.args), `${adapter.id} 的 clean.args 不是数组`);
    }
  }
});

await check('平台限制：darwin 独有的工具在别的平台不出现', () => {
  const darwinOnly = ADAPTERS.filter((a) => Array.isArray(a.platforms) && a.platforms.includes('darwin'));
  assert.ok(darwinOnly.length > 0, '没有声明平台限制的适配器');
  for (const adapter of darwinOnly) {
    assert.equal(adapterSupported(adapter, 'darwin'), true);
    assert.equal(adapterSupported(adapter, 'linux'), false);
  }
});

await check('命令渲染成给人看的文本', () => {
  assert.equal(formatCommand({ cmd: 'npm', args: ['cache', 'clean', '--force'] }), 'npm cache clean --force');
  assert.equal(formatCommand(null), '');
});

await check('命令跑不通时如实报告，不抛异常', async () => {
  const result = await runCommand('dsh-boost-check-no-such-binary', [], { timeoutMs: 3000 });
  assert.equal(result.ok, false);
});

console.log('→ 诊断兜底');

await check('规则版在没有模型时也给得出结论', () => {
  const analysis = ruleAnalysis({
    platform: 'darwin',
    cpuCount: 8,
    load: { avg1: 2, avg5: 3, avg15: 10 },
    memory: { totalBytes: 8e9, freeBytes: 1e9, usedBytes: 7e9, swapTotalBytes: 6e9, swapUsedBytes: 5e9, swapPressure: true },
    disk: [{ path: '/', totalBytes: 228e9, usedBytes: 207e9, freeBytes: 21e9, usePct: 91 }],
    topProcesses: [{ pid: 1, name: 'node', cpuPct: 3, rssBytes: 500e6 }],
    dsh: { home: '/x', parts: [] },
  }, [
    { id: 'npm', label: 'npm 下载缓存', sizeBytes: 2.8e9, semantics: 'full' },
    { id: 'pnpm', label: 'pnpm 全局存储', sizeBytes: 9.9e9, semantics: 'prune' },
  ]);
  assert.equal(analysis.source, 'rules');
  assert.ok(analysis.diagnosis.length > 0);
  assert.ok(analysis.findings.length > 0);
  // 顺序：收益大的在前
  assert.deepEqual(analysis.priority, ['pnpm', 'npm']);
});

await check('字节数说成人话', () => {
  assert.equal(humanBytes(0), '0 B');
  assert.equal(humanBytes(1024), '1 KB');
  assert.equal(humanBytes(1024 ** 3 * 2), '2 GB');
  assert.equal(humanBytes(1024 ** 2 * 3.5), '3.5 MB');
});

console.log('→ Agent 工具');

await check('工具名与参数 schema 是对外契约', () => {
  const tool = createBoostTool({
    scan: () => ({ running: false, items: [], analysis: null }),
    status: () => null,
    execute: async () => ({ ok: true, results: [], reclaimedBytes: 0 }),
  });
  assert.equal(tool.name, 'system_boost');
  assert.deepEqual(tool.parameters.properties.action.enum, ['scan', 'execute']);
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.equal(tool.isConcurrencySafe(), false);
});

await check('scan 返回条目清单与结论', async () => {
  const tool = createBoostTool({
    scan: () => ({
      running: false,
      items: [{ id: 'npm', label: 'npm 下载缓存', sizeBytes: 2816 * 1024 * 1024, semantics: 'full', commandText: 'npm cache clean --force' }],
      analysis: { diagnosis: '磁盘快满了', findings: ['磁盘剩余 19 GB'], warnings: [], priority: ['npm'] },
    }),
    status: () => null,
    execute: async () => ({ ok: true, results: [], reclaimedBytes: 0 }),
  });
  const result = await tool.execute({ action: 'scan' }, {});
  assert.equal(result.ok, true);
  assert.ok(result.text.includes('磁盘快满了'));
  assert.ok(result.text.includes('[npm]'));
});

await check('execute 没有指定条目时拒绝', async () => {
  const tool = createBoostTool({
    scan: () => ({ running: false, items: [], analysis: null }),
    status: () => null,
    execute: async () => ({ ok: true, results: [], reclaimedBytes: 0 }),
  });
  const result = await tool.execute({ action: 'execute' }, {});
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('没有指定'));
});

await check('execute 要 danger-full-access', async () => {
  let checked = false;
  const tool = createBoostTool({
    scan: () => ({ running: false, items: [], analysis: null }),
    status: () => null,
    execute: async () => ({ ok: true, results: [], reclaimedBytes: 0 }),
  }, {
    assertPrivileged: () => { checked = true; throw new Error('需要 danger-full-access'); },
  });
  const result = await tool.execute({ action: 'execute', items: ['npm'] }, {});
  assert.equal(checked, true);
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('danger-full-access'));
});

console.log('→ HTTP 契约');

/**
 * 造一个假的请求。
 *
 * @param {string} method 方法。
 * @param {string} url URL。
 * @param {object|null} body 请求体。
 * @returns {object} 请求。
 */
function fakeReq(method, url, body) {
  return {
    method: method,
    url: url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: body === null || body === undefined ? {} : { 'content-type': 'application/json' },
    on(event, handler) {
      if (event === 'data') handler(Buffer.from(JSON.stringify(body ?? {}), 'utf8'));
      if (event === 'end') handler();
    },
  };
}

/**
 * 造一个假的响应，收集状态码与响应体。
 *
 * @returns {{res: object, status: number, body: object|null}} 响应。
 */
function fakeRes() {
  const out = { res: null, status: 0, body: null };
  out.res = {
    writeHead(status) { out.status = status; },
    end(text) { try { out.body = JSON.parse(text); } catch { out.body = null; } },
  };
  return out;
}

await check('scan 路由立刻返回任务快照（体检在后台跑）', async () => {
  const ops = {
    scan: () => ({ id: 'boost-1', running: true, items: [], analysis: null }),
    status: () => ({ id: 'boost-1', running: false, items: [{ id: 'npm' }], analysis: null }),
    execute: async () => ({ ok: true, results: [], reclaimedBytes: 0 }),
  };
  const routes = buildRoutes(createRouteSpecs(ops, '/dsh-usage-aggregator/boost'), { allowRemote: false });
  const scan = routes.find((route) => route.path.endsWith('/scan'));
  assert.ok(scan !== undefined, '缺 scan 路由');
  const out = fakeRes();
  await scan.handler(fakeReq('GET', '/x'), out.res);
  assert.equal(out.status, 200);
  assert.equal(out.body.id, 'boost-1');
});

await check('status 路由返回当前任务', async () => {
  const ops = {
    scan: () => ({}),
    status: () => ({ id: 'boost-1', running: false, items: [{ id: 'npm' }], analysis: null }),
    execute: async () => ({ ok: true }),
  };
  const routes = buildRoutes(createRouteSpecs(ops, '/dsh-usage-aggregator/boost'), { allowRemote: false });
  const status = routes.find((route) => route.path.endsWith('/status'));
  const out = fakeRes();
  await status.handler(fakeReq('GET', '/x'), out.res);
  assert.equal(out.status, 200);
  assert.equal(out.body.items.length, 1);
});

await check('execute 路由：勾了才执行，没勾返回 400', async () => {
  let called = null;
  const ops = {
    scan: () => ({}),
    status: () => null,
    execute: async (ids) => { called = ids; return { ok: true, results: [], reclaimedBytes: 0 }; },
  };
  const routes = buildRoutes(createRouteSpecs(ops, '/dsh-usage-aggregator/boost'), { allowRemote: false });
  const execute = routes.find((route) => route.path.endsWith('/execute'));

  const empty = fakeRes();
  await execute.handler(fakeReq('POST', '/x', { items: [] }), empty.res);
  assert.equal(empty.status, 400);
  assert.equal(called, null);

  const ok = fakeRes();
  await execute.handler(fakeReq('POST', '/x', { items: ['npm', 'pnpm'] }), ok.res);
  assert.equal(ok.status, 200);
  assert.deepEqual(called, ['npm', 'pnpm']);
});

await check('execute 路由：客户端传不认识的条目也不执行它', async () => {
  let called = null;
  const ops = {
    scan: () => ({}),
    status: () => null,
    execute: async (ids) => { called = ids; return { ok: true, results: [], reclaimedBytes: 0 }; },
  };
  const routes = buildRoutes(createRouteSpecs(ops, '/dsh-usage-aggregator/boost'), { allowRemote: false });
  const execute = routes.find((route) => route.path.endsWith('/execute'));
  const out = fakeRes();
  await execute.handler(fakeReq('POST', '/x', { items: ['../../etc', 'npm'] }), out.res);
  assert.equal(out.status, 200);
  assert.deepEqual(called, ['../../etc', 'npm'], '路由层不做过滤是对的 —— 过滤在 ops.execute 里按目录表重解析');
});

await check('ops.execute 只认目录表里的条目：客户端传不存在的 id 会被跳过', async () => {
  // 这一条跑的是**真实**的 ops —— 它会现场探测本机的工具链（几秒），
  // 然后按目录表重新解析路径。客户端给的只是 id，路径它碰不到。
  const { createOps } = await import('../src/host/features/boost/ops.js');
  const ops = createOps({
    home: process.env.HOME,
    env: process.env,
    platform: process.platform,
    llm: () => null,
    analysis: { provider: '', model: '' },
  });
  const outcome = await ops.execute(['definitely-not-a-real-item']);
  assert.equal(outcome.ok, false, '不存在的条目不该算成功');
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].skipped, true);
  assert.ok(outcome.results[0].reason.includes('找不到'), outcome.results[0].reason);
});

await check('非回环地址被拒绝', async () => {
  const ops = { scan: () => ({}), status: () => null, execute: async () => ({ ok: true }) };
  const routes = buildRoutes(createRouteSpecs(ops, '/dsh-usage-aggregator/boost'), { allowRemote: false });
  const scan = routes.find((route) => route.path.endsWith('/scan'));
  const req = fakeReq('GET', '/x');
  req.socket.remoteAddress = '203.0.113.7';
  const out = fakeRes();
  await scan.handler(req, out.res);
  assert.equal(out.status, 403);
});

console.log('→ DSH 自己的数据');

/**
 * 造一个临时的 DSH 数据目录。
 *
 * @returns {Promise<{root: string, cleanup: Function}>} 目录与清理函数。
 */
async function makeTempDsh() {
  const root = await mkdtemp(join(tmpdir(), 'boost-dsh-'));
  const cleanup = async () => { await rm(root, { recursive: true, force: true }); };
  return { root, cleanup };
}

/**
 * 把一段文本写成 zstd 压缩的会话日志。
 *
 * @param {string} file 目标文件。
 * @param {string} text 内容。
 * @returns {Promise<void>} 完成。
 */
async function writeZstd(file, text) {
  const { execFileSync } = await import('node:child_process');
  await mkdir(join(file, '..'), { recursive: true });
  const buffer = execFileSync('zstd', ['-q', '-c'], { input: text, maxBuffer: 16 * 1024 * 1024 });
  await writeFile(file, buffer);
}

await check('会话清单：读得出 origin 与父会话', async () => {
  const { root, cleanup } = await makeTempDsh();
  try {
    const sessionsRoot = join(root, 'sessions', '--Users-x--');
    await writeZstd(
      join(sessionsRoot, 'sub-1', 'session.v4.jsonl.zstd'),
      `${JSON.stringify({ type: 'session', version: 4, id: 'sub-1', origin: 'subagent', parentSession: 'session-gone', cwd: '/x' })}\n`,
    );
    await writeZstd(
      join(sessionsRoot, 'lead-1', 'session.v4.jsonl.zstd'),
      `${JSON.stringify({ type: 'session', version: 4, id: 'lead-1', cwd: '/x' })}\n`,
    );
    const sessions = await listSessions(join(root, 'sessions'));
    assert.equal(sessions.length, 2);
    const sub = sessions.find((item) => item.id === 'sub-1');
    assert.equal(sub.origin, 'subagent');
    assert.equal(sub.parentSession, 'session-gone');
    const lead = sessions.find((item) => item.id === 'lead-1');
    assert.equal(lead.origin, 'lead');
  } finally {
    await cleanup();
  }
});

await check('DSH 自检项：孤儿子代理、旧格式日志、投影缓存残留都能发现', async () => {
  const { root, cleanup } = await makeTempDsh();
  try {
    const sessionsRoot = join(root, 'sessions', '--Users-x--');
    await writeZstd(
      join(sessionsRoot, 'sub-1', 'session.v4.jsonl.zstd'),
      `${JSON.stringify({ type: 'session', version: 4, id: 'sub-1', origin: 'subagent', parentSession: 'session-gone', cwd: '/x' })}\n`,
    );
    await writeZstd(
      join(sessionsRoot, 'old-1', 'session.v3.jsonl.zstd'),
      `${JSON.stringify({ type: 'session', version: 3, id: 'old-1' })}\n`,
    );
    await writeZstd(
      join(root, 'storages', 'session_projcache', 'sessions', 'gone-1.json'),
      '{"stale":true}',
    );
    await writeZstd(
      join(root, 'storages', 'session_projcache', 'sessions', 'sub-1.json'),
      '{"live":true}',
    );
    const items = await listDshItems({ dshHome: root, liveSessionIds: [] });
    const byId = new Map(items.map((item) => [item.id, item]));
    assert.ok(byId.has('dsh-legacy-sessions'), '没发现旧格式日志');
    assert.equal(byId.get('dsh-legacy-sessions').count, 1);
    assert.ok(byId.has('dsh-orphan-sessions'), '没发现孤儿子代理会话');
    assert.equal(byId.get('dsh-orphan-sessions').count, 1);
    assert.ok(byId.has('dsh-projcache'), '没发现投影缓存残留');
    assert.equal(byId.get('dsh-projcache').count, 1, '只有 gone-1 没有对应会话，sub-1 有');
    // 有代价的默认不勾。
    assert.equal(byId.get('dsh-orphan-sessions').selectedByDefault, false);
    assert.equal(byId.get('dsh-legacy-sessions').selectedByDefault, true);
  } finally {
    await cleanup();
  }
});

await check('执行器：旧格式日志被删掉，当前的会话日志留着', async () => {
  const { root, cleanup } = await makeTempDsh();
  try {
    const sessionsRoot = join(root, 'sessions', '--Users-x--');
    await writeZstd(join(sessionsRoot, 'old-1', 'session.v3.jsonl.zstd'), '{"type":"session","version":3}\n');
    await writeZstd(join(sessionsRoot, 'new-1', 'session.v4.jsonl.zstd'), '{"type":"session","version":4}\n');
    const executor = createExecutor({ home: root, env: {}, dshHome: root, logPath: '' });
    const outcome = await executor.execute([{
      id: 'dsh-legacy-sessions',
      label: '旧格式的会话日志',
      group: 'dsh',
      sizeBytes: 0,
      action: { type: 'remove-legacy-logs' },
    }]);
    assert.equal(outcome.results[0].ok, true, outcome.results[0].reason);
    const left = await readdir(join(sessionsRoot, 'old-1'));
    assert.equal(left.length, 0, '旧格式日志没删掉');
    const kept = await readdir(join(sessionsRoot, 'new-1'));
    assert.ok(kept.includes('session.v4.jsonl.zstd'), '当前格式的日志被误删了');
  } finally {
    await cleanup();
  }
});

await check('执行器：回收站只删旧的快照，最近几份留着', async () => {
  const { root, cleanup } = await makeTempDsh();
  try {
    for (const name of ['20260101-000000', '20260102-000000', '20260103-000000', '20260104-000000']) {
      await mkdir(join(root, 'trash', name), { recursive: true });
      await writeFile(join(root, 'trash', name, 'x.txt'), 'x');
    }
    // 让 mtime 有明确先后：靠 utimes 设置。
    const { utimes } = await import('node:fs/promises');
    const names = ['20260101-000000', '20260102-000000', '20260103-000000', '20260104-000000'];
    for (let index = 0; index < names.length; index += 1) {
      const when = new Date(Date.UTC(2026, 0, index + 1));
      await utimes(join(root, 'trash', names[index]), when, when);
    }
    const executor = createExecutor({ home: root, env: {}, dshHome: root, logPath: '' });
    const outcome = await executor.execute([{
      id: 'dsh-trash',
      label: '回收站',
      group: 'dsh',
      sizeBytes: 0,
      action: { type: 'remove-trash-snapshots', keepNewest: 2 },
    }]);
    assert.equal(outcome.results[0].ok, true, outcome.results[0].reason);
    const left = (await readdir(join(root, 'trash'))).sort();
    assert.equal(left.length, 2, `回收站应该剩 2 份，实际 ${left.length}`);
    assert.deepEqual(left, ['20260103-000000', '20260104-000000']);
  } finally {
    await cleanup();
  }
});

await check('执行器：删归档会话前先把它从归档清单里摘掉', async () => {
  const { root, cleanup } = await makeTempDsh();
  try {
    const sessionsRoot = join(root, 'sessions', '--Users-x--');
    await writeZstd(
      join(sessionsRoot, 'arch-1', 'session.v4.jsonl.zstd'),
      `${JSON.stringify({ type: 'session', version: 4, id: 'arch-1', cwd: '/x' })}\n`,
    );
    await mkdir(join(root, 'storages'), { recursive: true });
    await writeFile(
      join(root, 'storages', 'workspace.json'),
      JSON.stringify({ global: { archivedSessionIds: ['arch-1'] } }),
    );
    const unarchived = [];
    const executor = createExecutor({
      home: root,
      env: {},
      dshHome: root,
      logPath: '',
      unarchiveSession: async (id) => { unarchived.push(id); return true; },
    });
    const outcome = await executor.execute([{
      id: 'dsh-archived-sessions',
      label: '已归档会话的正文',
      group: 'dsh',
      sizeBytes: 0,
      action: { type: 'remove-archived-sessions' },
    }]);
    assert.equal(outcome.results[0].ok, true, outcome.results[0].reason);
    assert.deepEqual(unarchived, ['arch-1'], '没先摘掉归档清单');
    assert.equal(existsSync(join(sessionsRoot, 'arch-1')), false, '归档会话的正文没删掉');
  } finally {
    await cleanup();
  }
});

await check('执行器：浏览器配置只清缓存目录，不动配置本身', async () => {
  const { root, cleanup } = await makeTempDsh();
  try {
    const profile = join(root, 'browser-profile');
    await mkdir(join(profile, 'Default', 'Cache'), { recursive: true });
    await writeFile(join(profile, 'Default', 'Cache', 'data'), 'x'.repeat(2048));
    await writeFile(join(profile, 'Preferences'), '{"keep":true}');
    const executor = createExecutor({ home: root, env: {}, dshHome: root, logPath: '' });
    const outcome = await executor.execute([{
      id: 'dsh-usage-browser',
      label: '浏览器配置',
      group: 'dsh',
      sizeBytes: 0,
      action: { type: 'clear-browser-profile', path: profile },
    }]);
    assert.equal(outcome.results[0].ok, true, outcome.results[0].reason);
    assert.equal(existsSync(join(profile, 'Default', 'Cache')), false, '缓存目录没清掉');
    assert.equal(existsSync(join(profile, 'Preferences')), true, '配置被误删了');
  } finally {
    await cleanup();
  }
});

await check('执行器：结束进程前复核命令行，pid 换了人就跳过', async () => {
  const { root, cleanup } = await makeTempDsh();
  const child = spawn('sleep', ['30']);
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const lines = await listRunningCommandLines();
    const line = lines.find((item) => item.includes('sleep 30'));
    assert.ok(line !== undefined, '没找到刚起的 sleep 进程');
    const pid = child.pid;
    const executor = createExecutor({ home: root, env: {}, dshHome: root, logPath: '' });
    const outcome = await executor.execute([{
      id: 'orphan-processes',
      label: '结束进程',
      group: 'process',
      sizeBytes: 0,
      action: { type: 'terminate', pids: [pid], expect: { [pid]: 'definitely-not-this-binary' } },
    }]);
    assert.equal(outcome.results[0].skipped, true, '命令行对不上却还是动手了');
    assert.equal(outcome.results[0].ok, false);
  } finally {
    child.kill('SIGKILL');
    await cleanup();
  }
});

console.log('→ 进程层');

await check('祖先里有 DSH 进程的，整个子树都护住', () => {
  const processes = [
    { pid: 10, ppid: 5, command: 'chrome-devtools-mcp', app: 'node' },
    { pid: 11, ppid: 10, command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-pipe', app: 'Google Chrome.app' },
    { pid: 12, ppid: 11, command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer', app: 'Google Chrome.app' },
    { pid: 13, ppid: 1, command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', app: 'Google Chrome.app' },
  ];
  const protectedPids = protectedByAncestry(processes);
  assert.ok(protectedPids.has(11), '工具驱动的浏览器没护住');
  assert.ok(protectedPids.has(12), '它的渲染进程没护住');
  assert.equal(protectedPids.has(13), false, '用户自己开的 Chrome 被误护了');
});

await check('应用名按「第一个 .app」算：一个浏览器不会拆成十几个应用', () => {
  const helper = '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/156.0.8078.49/Helpers/Google Chrome Helper (Aperitif Renderer).app/Contents/MacOS/Google Chrome Helper (Aperitif Renderer)';
  assert.equal(appNameOf(helper), 'Google Chrome.app');
  assert.equal(appNameOf('/opt/homebrew/bin/node'), 'node');
  assert.equal(appNameOf('/Applications/DingTalk.app/Contents/MacOS/DingTalk'), 'DingTalk.app');
});

await check('护栏：不碰系统进程、root 进程、DSH 自己的进程、前台应用', () => {
  const protectedPids = new Set([42]);
  assert.equal(checkProcessAllowed({ pid: 1, uid: 0, app: 'launchd', command: '/sbin/launchd' }, protectedPids, null).ok, false);
  assert.equal(checkProcessAllowed({ pid: 7, uid: 0, app: 'Docker.app', command: '/Applications/Docker.app/Contents/MacOS/Docker' }, protectedPids, null).ok, false);
  assert.equal(checkProcessAllowed({ pid: 42, uid: 501, app: 'node', command: '/usr/local/bin/node' }, protectedPids, null).ok, false);
  assert.equal(checkProcessAllowed({ pid: 99, uid: 501, app: 'Google Chrome.app', command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }, protectedPids, 'Google Chrome.app').ok, false);
  assert.equal(checkProcessAllowed({ pid: 100, uid: 501, app: 'node', command: '/usr/local/bin/node' }, protectedPids, null).ok, true, '/usr/local 不在保护目录里，应当放行');
  assert.equal(checkProcessAllowed({ pid: 101, uid: 501, app: 'Code.app', command: '/Applications/Code.app/Contents/MacOS/Electron' }, protectedPids, null).ok, true);
});

await check('DSH 自己的进程按命令行标记护住（插件不在 DSH 进程里也护得住）', () => {
  const protectedPids = new Set();
  const dshWeb = 'node /Users/x/pnpm/store/v11/links/@deepseek-ai/dsh/0.2.1-rc.2/abc/node_modules/@deepseek-ai/dsh/lib/bin.js web';
  assert.equal(checkProcessAllowed({ pid: 100, uid: 501, app: 'bin.js', command: dshWeb }, protectedPids, null).ok, false, 'DSH 主进程没护住');
  const bridge = 'node /Users/x/.dsh/profiles/web/node_modules/dsh-mcp-connector/lib/stdio-startup-guard.js --timeout-ms 15000 -- npx';
  assert.equal(checkProcessAllowed({ pid: 101, uid: 501, app: 'node', command: bridge }, protectedPids, null).ok, false, 'DSH 的 MCP 桥没护住');
  assert.equal(checkProcessAllowed({ pid: 102, uid: 501, app: 'Code.app', command: '/Applications/Code.app/Contents/MacOS/Electron' }, protectedPids, null).ok, true);
});

await check('应用名只取可执行文件，不带后面的参数', () => {
  assert.equal(appNameOf('/Users/x/node_modules/@deepseek-ai/dsh/lib/bin.js'), 'bin.js');
  assert.equal(appNameOf('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), 'Google Chrome.app');
});

await check('孤儿子进程只认「一次性命令行工具」，常驻服务不动', () => {
  const processes = [
    { pid: 10, ppid: 1, command: '/Users/x/.npm/_npx/abc/node_modules/.bin/mcp-server', app: 'node' },
    { pid: 11, ppid: 1, command: '/usr/local/bin/node /Users/x/.dsh/profiles/web/server.js', app: 'node' },
    { pid: 12, ppid: 1, command: '/Applications/Docker.app/Contents/MacOS/Docker', app: 'Docker.app' },
  ];
  const orphans = findOrphanProcesses(processes).map((proc) => proc.pid);
  assert.deepEqual(orphans, [10], '认错了孤儿子进程');
});

await check('CPU 时间解析：ps 的 [[dd-]hh:]mm:ss.ss', () => {
  assert.equal(parseCpuTime('3:27.45'), 207.45);
  assert.equal(parseCpuTime('1:00:00'), 3600);
  assert.equal(parseCpuTime('1-00:00:00'), 86400);
  assert.equal(parseCpuTime(''), 0);
});

console.log('');
if (failures.length === 0) {
  console.log(`✓ ${passed} 项断言全部通过`);
  process.exit(0);
}
console.log(`✗ ${failures.length} 项断言未通过（共 ${passed + failures.length} 项）`);
process.exit(1);
