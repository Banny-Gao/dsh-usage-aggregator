// src/host/features/usage/store.js
//
// 落盘与脱敏。
//
// 存在 $DSH_HOME/dsh-usage-query/store.json（目录 0700 / 文件 0600）——这里放着
// 用户粘贴的 Cookie / Token，属于凭证，绝不出现在任何返回给浏览器的字段里。
// 客户端拿到的永远经过 maskProvider()：URL 查询串打码、只留请求头「名字」。
//
// 为什么不进 profile 的 config（cordis.patch.yml）：粘贴发生在运行时，config 是
// 启动期只读的。为什么不进 session 日志：这份数据跨会话、跨项目复用，不属于任何
// 一次会话。

import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { headerNames, inspectCredential, maskUrl } from './curl.js';
import { describeRenewal } from './renewal/index.js';

export const STORE_VERSION = 1;

/** 解析 $DSH_HOME：与 dsh 自身一致，env 优先，其次 ~/.dsh。 */
export function resolveDshHome(env = process.env) {
  const explicit = env.DSH_HOME;
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
  return join(homedir(), '.dsh');
}

/** 插件自己的数据目录。 */
export function dataDir(env = process.env) {
  return join(resolveDshHome(env), 'dsh-usage-query');
}

function emptyStore() {
  // settings 是**本 profile 级**的偏好（当前只有「分析用哪个模型」），不放进每条记录：
  // 换个模型对所有接口都生效，也不该在「移除某个接口」时被一起带走。
  return { version: STORE_VERSION, settings: { analysisModel: null, chipId: null }, providers: [] };
}

/** 补齐缺字段，保证读到的记录形状一致（升级旧文件时不会到处判 undefined）。 */
function normalizeProvider(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : null;
  if (id === null || id === '') return null;
  return {
    id,
    label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : id,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    // 'curl' = 真实重放；'image' = 只从截图里读到的快照，不能自动刷新。
    source: raw.source === 'image' ? 'image' : 'curl',
    request: raw.request !== undefined && raw.request !== null ? raw.request : null,
    credential: raw.credential !== undefined && raw.credential !== null ? raw.credential : null,
    template: raw.template !== undefined && raw.template !== null ? raw.template : null,
    // 用户手工拖出来的字段顺序（path 数组）。空 = 用模型/启发式给的顺序。
    fieldOrder: Array.isArray(raw.fieldOrder) ? raw.fieldOrder.filter((item) => typeof item === 'string').slice(0, 40) : null,
    templateSource: raw.templateSource === 'auto' ? 'auto' : raw.templateSource === 'fallback' ? 'fallback' : null,
    // 自动续期（renewal/）的最近一次尝试。记时间是为了给「静默续期失败」加冷却，
    // 否则每分钟一次的自动查询会把 Chrome 拉起来 1440 次/天。
    renewal: raw.renewal !== null && typeof raw.renewal === 'object'
      ? {
        lastAttemptAt: typeof raw.renewal.lastAttemptAt === 'number' ? raw.renewal.lastAttemptAt : null,
        lastResult: typeof raw.renewal.lastResult === 'string' ? raw.renewal.lastResult : null,
        lastMessage: typeof raw.renewal.lastMessage === 'string' ? raw.renewal.lastMessage : null,
        lastMode: typeof raw.renewal.lastMode === 'string' ? raw.renewal.lastMode : null,
      }
      : null,
    last: raw.last !== undefined && raw.last !== null ? raw.last : null,
    view: raw.view !== undefined && raw.view !== null ? raw.view : null,
    snapshot: raw.snapshot !== undefined && raw.snapshot !== null ? raw.snapshot : null,
    notes: Array.isArray(raw.notes) ? raw.notes : [],
  };
}

/** 读取整份 store；文件缺失 / 损坏都退回空 store（宁可重来一次，不要启动失败）。 */
export async function readStore(env = process.env) {
  const file = join(dataDir(env), 'store.json');
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyStore();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`store.json 解析失败（${file}）：${error.message}`);
  }
  const providers = Array.isArray(parsed.providers) ? parsed.providers.map(normalizeProvider).filter((item) => item !== null) : [];
  const rawSettings = parsed.settings !== null && typeof parsed.settings === 'object' ? parsed.settings : {};
  const model = rawSettings.analysisModel;
  return {
    version: STORE_VERSION,
    settings: {
      analysisModel: model !== null && typeof model === 'object' && typeof model.provider === 'string' && model.provider !== ''
        ? { provider: model.provider, model: typeof model.model === 'string' ? model.model : '' }
        : null,
      // 会话头那颗芯片显示哪个接口（null = 第一个）。
      chipId: typeof rawSettings.chipId === 'string' && rawSettings.chipId !== '' ? rawSettings.chipId : null,
    },
    providers,
  };
}

/** 原子写：先写临时文件再 rename，避免半截文件。 */
export async function writeStore(store, env = process.env) {
  const dir = dataDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'store.json');
  const tmp = join(dir, `.store.${process.pid}.${Date.now()}.json`);
  const payload = JSON.stringify({
    version: STORE_VERSION,
    settings: store.settings ?? { analysisModel: null, chipId: null },
    providers: store.providers,
  }, null, 2);
  await writeFile(tmp, `${payload}\n`, { mode: 0o600 });
  await rename(tmp, file);
  try {
    await chmod(file, 0o600);
  } catch {
    // 某些文件系统不支持 chmod（例如挂载卷）；写失败不该拖垮保存。
  }
  return file;
}

/** 由 URL 或标签推一个稳定的 id（同名加后缀）。 */
export function providerIdFrom(request, label, taken) {
  const host = (() => {
    try {
      return new URL(request.url).host.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();
  const seed = (typeof label === 'string' && label.trim() !== '' ? label.trim() : host) || 'provider';
  const slug = seed
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'provider';
  if (!taken.has(slug)) return slug;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${slug}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${slug}-${Date.now().toString(36)}`;
}

/**
 * 脱敏投影：这是**唯一**允许送给浏览器的记录形态。
 *
 * 有意省略 request.headers 的取值、request.body、原始粘贴文本。凭证只用
 * credential 里的元信息（有没有、什么时候过期）表达。
 *
 * @param {object} provider store 里的完整记录。
 * @returns {object} 客户端可安全渲染的记录。
 */
export function maskProvider(provider) {
  const request = provider.request;
  return {
    id: provider.id,
    label: provider.label,
    source: provider.source,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
    endpoint: request === null ? null : `${request.method} ${maskUrl(request.url)}`,
    headerNames: headerNames(request),
    queryable: provider.source === 'curl' && request !== null,
    credential: provider.credential === null
      ? { found: false, source: null, exp: null, expired: false }
      : {
        found: provider.credential.found === true,
        source: provider.credential.source ?? null,
        exp: typeof provider.credential.exp === 'number' ? provider.credential.exp : null,
        expired: typeof provider.credential.exp === 'number' ? provider.credential.exp * 1000 <= Date.now() : false,
      },
    templateSource: provider.templateSource,
    // 自动续期能力（能不能一键换 token）+ 上次尝试的结果。都不含凭证本身。
    renewal: {
      ...describeRenewal(provider),
      lastResult: provider.renewal?.lastResult ?? null,
      lastMessage: provider.renewal?.lastMessage ?? null,
      lastAt: provider.renewal?.lastAttemptAt ?? null,
    },
    template: provider.template,
    fieldOrder: provider.fieldOrder,
    status: statusOf(provider),
    view: provider.source === 'image' ? provider.snapshot : provider.view,
    last: provider.last === null
      ? null
      : {
        at: provider.last.at,
        status: provider.last.status,
        trigger: provider.last.trigger ?? 'manual',
        message: provider.last.message ?? null,
        httpStatus: typeof provider.last.httpStatus === 'number' ? provider.last.httpStatus : null,
        ms: typeof provider.last.ms === 'number' ? provider.last.ms : null,
        bytes: typeof provider.last.bytes === 'number' ? provider.last.bytes : null,
      },
    notes: provider.notes,
  };
}

/** 供应商的对外状态：ok / expired / error / 未查询。 */
export function statusOf(provider) {
  if (provider.source === 'image') return provider.snapshot === null ? 'empty' : 'snapshot';
  if (provider.last === null) return provider.view === null ? 'empty' : 'stale';
  if (provider.last.status === 'expired') return 'expired';
  if (provider.last.status === 'error') return 'error';
  return 'ok';
}

/** 把记录写回 store（按 id 替换，找不到就新插到最前）。 */
export function upsert(store, provider) {
  const index = store.providers.findIndex((item) => item.id === provider.id);
  if (index === -1) store.providers.unshift(provider);
  else store.providers[index] = provider;
  return provider;
}

export function findProvider(store, id) {
  return store.providers.find((item) => item.id === id) ?? null;
}

/** 建立一条新记录的公共部分。 */
export function makeProvider({ id, label, source, request, notes }) {
  const now = Date.now();
  return {
    id,
    label,
    source,
    createdAt: now,
    updatedAt: now,
    request: request ?? null,
    credential: request === undefined || request === null ? null : inspectCredential(request),
    template: null,
    templateSource: null,
    fieldOrder: null,
    renewal: null,
    last: null,
    view: null,
    snapshot: null,
    notes: Array.isArray(notes) ? notes : [],
  };
}
