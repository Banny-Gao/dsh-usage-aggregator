// scripts/smoke-renewal.mjs
//
// 自动续期（src/host/features/usage/renewal/）的离线自测：不需要 DSH 运行时，
// 也**不会拉起浏览器**。
//
// 这里断的是三件最容易悄悄坏掉的事：
//   1. 换 token 之后，原请求里除 authorization 之外的东西一个字节都没变；
//   2. 面板拿到的投影里不含 token 本身（安全断言，与 store.js 原有那条同级）；
//   3. 判定「什么时候该去开一次浏览器」—— 它有个反直觉的失败模式：
//      每分钟试一次，一天就会拉起 1440 次 Chrome，必须靠冷却把它钉住。
//
// 真正需要浏览器的链路（拉起 Chrome → 走钉钉 OAuth）只能真机跑，由
// `node scripts/renew.mjs <id>` 验证，不在这里假装测。
//
// 迁移说明（从 dsh-usage-query 的 scripts/smoke-renewal.mjs 原样搬过来）：
//   · import 路径 ../lib/*.js → ../src/host/features/usage/*.js
//   · 读源码做正则断言的 new URL('../lib/…') → new URL('../src/host/features/usage/…')
// 断言一条没删。

import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOps } from '../src/host/features/usage/ops.js';
import { makeProvider, upsert, writeStore } from '../src/host/features/usage/store.js';
import { dueRenewals } from '../src/host/features/usage/auto.js';
import { issuedAt, tokenFromUrl } from '../src/host/features/usage/renewal/dingtalk.js';
import { applyToken, canRenewSilently, describeRenewal, renewalFor } from '../src/host/features/usage/renewal/index.js';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n     ${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n     ${error.message}`);
  }
}
// ─────────────────────── 自动续期 ───────────────────────

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
// 真 JWT 是「头.载荷.签名」三段。之前这里多写了一个裸 'h'，分段整体错位，
// 于是 decodeJwtPayload / issuedAt 读到的都是 header（里面没有 iat/exp），
// 断言却因为只手工填了 credential.exp 而照样「通过」—— 夹具骗过了测试。
const JWT = (exp, iat = exp - 86400) => `${b64({ alg: 'HS256' })}.${b64({ sub: '20', iat, exp })}.sig`;

const axzoRecord = () => ({
  id: 'axzoone',
  source: 'curl',
  request: {
    method: 'GET',
    url: 'https://one-api.axzo.cn/manage/api/v1/my/quota-status',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${JWT(Math.floor(Date.now() / 1000) + 3600)}`,
      origin: 'https://one.axzo.cn',
      referer: 'https://one.axzo.cn/',
      'sec-ch-ua': '"Chromium";v="155"',
    },
    body: null,
  },
  credential: { found: true, kind: 'jwt', exp: Math.floor(Date.now() / 1000) + 3600 },
});

console.log('\n→ 自动续期：认站点');

check('认得 AxzoOne 的钉钉登录', () => {
  const found = renewalFor(axzoRecord());
  assert.ok(found !== null, '应该匹配到钉钉续期档案');
  assert.equal(found.profile.id, 'axzoone');
});

check('不认得 minimax（登录方式不同，不瞎猜）', () => {
  const record = axzoRecord();
  record.request.url = 'https://www.minimax.cn/backend/account/token_plan/remains_percent';
  record.request.headers = { cookie: 'a=1' };
  assert.equal(renewalFor(record), null);
  assert.equal(describeRenewal(record).supported, false);
});

check('没有 Bearer 的记录不认（换了 token 也传不上去）', () => {
  const record = axzoRecord();
  delete record.request.headers.authorization;
  assert.equal(renewalFor(record), null);
});

check('钉钉标记为「必须人工点同意」，因此不进自动续期队列', () => {
  assert.equal(describeRenewal(axzoRecord()).interactiveOnly, true);
  assert.equal(canRenewSilently(axzoRecord()), false);
});

console.log('\n→ 自动续期：只换凭证，不动别的');

check('换 token 后只改 authorization 一处', () => {
  const record = axzoRecord();
  const next = applyToken(record.request, 'NEW.TOKEN.VALUE');
  assert.equal(next.headers.authorization, 'Bearer NEW.TOKEN.VALUE');
  assert.equal(next.headers.accept, 'application/json');
  assert.equal(next.headers.origin, 'https://one.axzo.cn');
  assert.equal(next.headers.referer, 'https://one.axzo.cn/');
  // 浏览器指纹头是「这台浏览器访问这个站点」的事实，换掉反而更像机器人。
  assert.equal(next.headers['sec-ch-ua'], '"Chromium";v="155"');
  assert.equal(next.url, record.request.url);
  assert.equal(next.method, 'GET');
  // 原请求不能被就地改坏。
  assert.ok(record.request.headers.authorization !== 'Bearer NEW.TOKEN.VALUE');
});

check('沿用原来的 Bearer 前缀写法', () => {
  const record = axzoRecord();
  record.request.headers.authorization = 'bearer OLD.TOKEN';
  assert.equal(applyToken(record.request, 'NEW').headers.authorization, 'bearer NEW');
});

check('原来不是 Bearer（裸 token）时补上前缀', () => {
  const record = axzoRecord();
  record.request.headers.authorization = 'OLD.TOKEN';
  assert.equal(applyToken(record.request, 'NEW').headers.authorization, 'Bearer NEW');
});

console.log('\n→ 自动续期：判定何时该动手');

// 下面的队列判定用一个「假设能无人值守续期」的档案来测（supportsRenewal 恒真），
// 因为**钉钉自己不属于这一类** —— 它每次都要人点「同意」，进队列只会白拉起浏览器。
// 那条排除规则在下面单独断。
const silentOK = () => true;

check('快到期（或已过期）且支持无人值守续期 → 续', () => {
  const record = axzoRecord();
  record.credential.exp = Math.floor(Date.now() / 1000) + 600;
  assert.deepEqual(dueRenewals([record], { now: Date.now(), supportsRenewal: silentOK }), ['axzoone']);
});

check('离过期还很早 → 不续（别白开浏览器）', () => {
  const record = axzoRecord();
  record.credential.exp = Math.floor(Date.now() / 1000) + 86400;
  assert.deepEqual(dueRenewals([record], { now: Date.now(), supportsRenewal: silentOK }), []);
});

check('刚失败过 → 冷却期内不再试（否则一天拉起 1440 次 Chrome）', () => {
  const now = Date.now();
  const record = axzoRecord();
  record.credential.exp = Math.floor(now / 1000) - 10; // 已过期
  // 只动「上次尝试时间」，now 不变 —— 否则过期门槛也跟着一起退回去，就测不到冷却了。
  record.renewal = { lastAttemptAt: now - 60000 };
  assert.deepEqual(dueRenewals([record], { now, supportsRenewal: silentOK }), [], '1 分钟前刚试过，应该还在冷却里');
  record.renewal = { lastAttemptAt: now - 31 * 60000 };
  assert.deepEqual(dueRenewals([record], { now, supportsRenewal: silentOK }), ['axzoone'], '冷却过了（默认 30 分钟）就该再试');
});

check('读不出过期时间的记录不续（宁可等 401 也不要瞎猜）', () => {
  const record = axzoRecord();
  record.credential = { found: true, kind: 'opaque', exp: null };
  assert.deepEqual(dueRenewals([record], { now: Date.now(), supportsRenewal: silentOK }), []);
});

check('钉钉这条真实记录不会被排进自动续期队列', () => {
  const record = axzoRecord();
  record.credential.exp = Math.floor(Date.now() / 1000) - 10;
  // 即便已经过期、也支持续期，用真实的支持性判定时依然不进队列。
  assert.deepEqual(dueRenewals([record], { now: Date.now(), supportsRenewal: canRenewSilently }), []);
});

check('截图来源没有 token 可换 → 不续', () => {
  const record = axzoRecord();
  record.source = 'image';
  record.request = null;
  assert.deepEqual(dueRenewals([record], { now: Date.now(), supportsRenewal: canRenewSilently }), []);
});

console.log('\n→ 自动续期：从回调里认 token');

check('hash 后面的 query 也能取到 token（登录页是 #/login?token=…）', () => {
  assert.equal(tokenFromUrl('https://one.axzo.cn/#/login?token=AAA.BBB.CCC'), 'AAA.BBB.CCC');
});

check('普通 query 也能取到', () => {
  assert.equal(tokenFromUrl('https://one.axzo.cn/login?token=XYZ&other=1'), 'XYZ');
});

check('没有 token / 空串 / 非字符串 → null，不返回脏值', () => {
  assert.equal(tokenFromUrl('https://one.axzo.cn/#/login'), null);
  assert.equal(tokenFromUrl('https://one.axzo.cn/#/login?token='), null);
  assert.equal(tokenFromUrl(''), null);
  assert.equal(tokenFromUrl(null), null);
});

check('DingTalk 回调参数里没有 token 时不会误取 state', () => {
  assert.equal(tokenFromUrl('https://one-api.axzo.cn/callback?code=abc&state=xyz'), null);
});

console.log('\n→ 自动续期：多枚 token 里挑最新的');

check('issuedAt 能读出签发时间（非 JWT 返回 null）', () => {
  assert.equal(issuedAt(JWT(2000, 1000)), 1000);
  assert.equal(issuedAt(JWT(2000, 1999)), 1999);
  assert.equal(issuedAt('not-a-jwt'), null);
  assert.equal(issuedAt(undefined), null);
});

check('挑选时按 iat 倒序，而不是按抓到的先后', () => {
  const source = readFileSync(new URL('../src/host/features/usage/renewal/dingtalk.js', import.meta.url), 'utf8');
  assert.ok(/b\.iat \?\? -1\) - \(a\.iat \?\? -1\)/.test(source), '应按 iat 倒序排序候选');
  // 回调 href 这条来源不能漏：漏了就会只抓到 localStorage 里上一枚旧 token。
  assert.ok(/remember\(tokenFromUrl\(lastUrl\)\);\s*remember\(parsed\.token\);/.test(source), 'href 与 localStorage 两个来源都要记');
});

console.log('\n→ 自动续期：落库前必须验活');

check('CDP 命令有超时，不会永久挂死', () => {
  // 真机上踩过：await Browser.close 一直不返回，整个续期请求挂了两分钟，
  // 浏览器端「正在续期…」转圈转到底。超时必须是默认值而不是可选项。
  const source = readFileSync(new URL('../src/host/features/usage/cdp.js', import.meta.url), 'utf8');
  assert.ok(source.includes('DEFAULT_COMMAND_TIMEOUT_MS'), '应定义统一的命令超时');
  assert.ok(/send\(method, params = \{\}, sessionId, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS\)/.test(source), 'send 的超时应有默认值');
  assert.ok(/send\('Browser.close', \{\}, undefined, 5000\)/.test(source), '收尾关闭浏览器必须给短超时');
});

check('多枚 token 时挑最新的，验活不通过的不落库', () => {
  const source = readFileSync(new URL('../src/host/features/usage/renewal/dingtalk.js', import.meta.url), 'utf8');
  assert.ok(source.includes('pickLiveToken'), '应先验活再挑，而不是抓到第一枚就用');
  assert.ok(source.includes('isTokenLive'), '验活要真的打一次接口');
  assert.ok(!/captureToken/.test(source), '旧的「抓到就返回」实现不应残留');
  // 每枚都要验：只要有一枚验不过就不能直接用（单会话策略下旧 token 会被顶掉）。
  assert.ok(/for \(const candidate of ordered\)/.test(source), '应逐枚验活');
  assert.ok(/return \{ token: null, revoked: tokens\.length > 0 \}/.test(source), '全都验不过时必须拒绝保存');
});

console.log('\n→ 自动续期：操作层');

await checkAsync('ops.renew 对不支持的接口如实报错（而不是假装成功）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-renew-'));
  try {
    const ops = createOps({ config: {}, env: { DSH_HOME: home } });
    await ops.import({ text: `curl 'https://www.minimax.cn/backend/account/token_plan/remains_percent' -H 'cookie: _token=abc'` });
    const state = await ops.state();
    const result = await ops.renew(state.providers[0].id, { interactive: false });
    assert.equal(result.ok, false);
    assert.ok(String(result.error).includes('不支持'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await checkAsync('ops.renew 对不存在的 id 报错', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-renew2-'));
  try {
    const ops = createOps({ config: {}, env: { DSH_HOME: home } });
    const result = await ops.renew('nope', { interactive: false });
    assert.equal(result.ok, false);
    assert.ok(String(result.error).includes('nope'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await checkAsync('面板能拿到「支持自动续期」这一项（不含任何凭证）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duq-renew3-'));
  try {
    const store = { version: 1, settings: { analysisModel: null, chipId: null }, providers: [] };
    const record = makeProvider({
      id: 'axzoone',
      label: 'AxzoOne',
      source: 'curl',
      request: axzoRecord().request,
      notes: [],
    });
    upsert(store, record);
    await writeStore(store, { DSH_HOME: home });
    const ops = createOps({ config: {}, env: { DSH_HOME: home } });
    const state = await ops.state();
    const provider = state.providers[0];
    assert.equal(provider.renewal.supported, true);
    assert.equal(provider.renewal.interactiveOnly, true);
    // 安全断言：面板拿到的这份投影里不能出现 token 本身。
    const dumped = JSON.stringify(provider);
    assert.ok(!dumped.includes(record.request.headers.authorization));
    assert.ok(!dumped.includes('eyJ'), 'JWT 的头部不该出现在面板数据里');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
console.log(`\n${failures.length === 0 ? '✓' : '✗'} 自动续期：${passed} 项通过${failures.length === 0 ? '' : `，${failures.length} 项失败`}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n[${failure.name}]\n${failure.error.stack}`);
  process.exitCode = 1;
}
