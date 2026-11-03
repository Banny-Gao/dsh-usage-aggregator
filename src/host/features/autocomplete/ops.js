// src/host/features/autocomplete/ops.js
//
// 自动补全的操作层（门面）：设置读写、模型清单、给建议。
//
// 两件 Host 侧必须替用户省下来的事：
//   1. **别重复花钱**：同一个草稿 + 同一段上下文，只要模型给过一次就复用
//      （5 分钟内的缓存）。用户改一个字就是一个新键，改回来还能命中旧的。
//   2. **别同时跑两个**：同一个会话里，新的请求发出就把上一个还没回来的掐掉 ——
//      用户打字的速度远快于模型思考，留下来的那个才是他要的。

import { analyzeCompletion } from './analyze.js';
import { readOverrides, writeOverrides } from './store.js';
import { normalizeSettings } from './settings.js';

/** 建议缓存的存活时间（毫秒）。 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** 缓存里最多留几条。 */
const CACHE_MAX = 50;

/** 用户偏好里认识的键（其余键直接丢掉）。 */
const SETTING_KEYS = [
  'enabled', 'maxSuggestions', 'provider', 'model', 'minChars', 'debounceMs',
  'contextMessages', 'maxInputChars', 'allowMultiline', 'inlineHint', 'placeholderHint',
];

/**
 * 造一份操作层。
 *
 * @param {object} options 选项。
 * @param {object} options.env 环境变量（落盘用）。
 * @param {() => (object|null)} options.llm 取 Host 的 llm 服务。
 * @param {object} options.defaults 插件配置给出的默认设置。
 * @returns {object} 操作层。
 */
export function createOps(options) {
  const env = options.env ?? process.env;
  const getLlm = typeof options.llm === 'function' ? options.llm : () => null;
  const defaults = options.defaults ?? {};

  /** 建议缓存：key → { at, suggestions }。 */
  const cache = new Map();
  /** 每个会话当前在跑的请求：sessionId → AbortController。 */
  const running = new Map();

  /**
   * 用户偏好与默认设置合并。
   *
   * provider / model 的空串表示「回到配置里的默认值」 —— 用户在面板里清空
   * 模型选择就是想回到默认，不能被当成「选了一个空模型」。
   *
   * @returns {Promise<object>} 生效的设置。
   */
  async function effectiveSettings() {
    const overrides = await readOverrides(env);
    const merged = { ...defaults };
    for (const [key, value] of Object.entries(overrides)) {
      if (!SETTING_KEYS.includes(key)) continue;
      if (value === undefined || value === null) continue;
      if ((key === 'provider' || key === 'model') && typeof value === 'string' && value.trim() === '') continue;
      merged[key] = value;
    }
    return normalizeSettings(merged, defaults);
  }

  /**
   * 缓存键：模型 + 草稿 + 上下文 + 条数。
   *
   * @param {object} input 输入。
   * @returns {string} 键。
   */
  function cacheKey(input) {
    const context = (input.context ?? []).map((entry) => `${entry.role}:${entry.text}`).join('\n');
    return `${input.provider}|${input.model}|${input.limit}|${input.draft}\n${context}`;
  }

  /**
   * 给建议。
   *
   * @param {{sessionId?: string, draft?: string, context?: Array<object>, limit?: number}} input 输入。
   * @returns {Promise<{ok: boolean, suggestions: string[], source: string}>} 结果。
   */
  async function suggest(input) {
    const settings = await effectiveSettings();
    if (!settings.enabled) return { ok: true, suggestions: [], source: 'disabled' };

    const rawDraft = typeof input.draft === 'string' ? input.draft : '';
    const draft = rawDraft.length > settings.maxInputChars ? rawDraft.slice(0, settings.maxInputChars) : rawDraft;

    // 多行草稿：允许就照常补全，不允许就**不给候选**（面板上写的就是
    // 「输入框里有换行时不给补全」—— 悄悄换成「你可能想问」是另一回事）。
    const multiline = draft.includes('\n');
    if (multiline && !settings.allowMultiline) {
      return { ok: true, suggestions: [], source: 'multiline' };
    }
    const effectiveDraft = draft;

    // 太短的草稿不值得花一次模型调用（空草稿例外 —— 那是要「你可能想问什么」）。
    if (effectiveDraft !== '' && effectiveDraft.trim().length < settings.minChars) {
      return { ok: true, suggestions: [], source: 'short' };
    }

    const limit = Math.max(1, Math.min(settings.maxSuggestions, Number.isFinite(input.limit) ? input.limit : settings.maxSuggestions));
    const context = (Array.isArray(input.context) ? input.context : [])
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.text === 'string' && entry.text.trim() !== '')
      .slice(-settings.contextMessages);

    const provider = settings.provider;
    const model = settings.model;
    const key = cacheKey({ provider: provider, model: model, limit: limit, draft: effectiveDraft, context: context });

    const hit = cache.get(key);
    if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) {
      return { ok: true, suggestions: hit.suggestions, source: hit.suggestions.length > 0 ? 'cache' : 'none' };
    }

    // 同一个会话里，上一次还没回来的请求作废。
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
    const previous = running.get(sessionId);
    if (previous !== undefined) previous.abort();
    const controller = new AbortController();
    running.set(sessionId, controller);

    try {
      const result = await analyzeCompletion({
        llm: getLlm(),
        provider: provider,
        model: model,
        draft: effectiveDraft,
        context: context,
        limit: limit,
        maxTokens: options.maxOutputTokens,
        signal: controller.signal,
      });
      cache.set(key, { at: Date.now(), suggestions: result.suggestions });
      if (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      return { ok: true, suggestions: result.suggestions, source: result.source };
    } finally {
      if (running.get(sessionId) === controller) running.delete(sessionId);
    }
  }

  /**
   * 读设置。
   *
   * @returns {Promise<object>} { ok, settings, defaults }。
   */
  async function settings() {
    return { ok: true, settings: await effectiveSettings(), defaults: normalizeSettings(defaults, defaults) };
  }

  /**
   * 保存设置（只存用户改过的那些键）。
   *
   * @param {object} patch 要改的字段。
   * @returns {Promise<object>} { ok, settings } 或 { ok:false, error }。
   */
  async function saveSettings(patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: '设置必须是一个对象' };
    }
    const current = await readOverrides(env);
    const next = { ...current };
    for (const key of SETTING_KEYS) {
      if (!(key in patch)) continue;
      next[key] = patch[key];
    }
    // 先归一化一次：写进去的就是合法的值，面板上读回来不会是坏的。
    const normalized = normalizeSettings({ ...defaults, ...next }, defaults);
    await writeOverrides({
      ...next,
      maxSuggestions: normalized.maxSuggestions,
      minChars: normalized.minChars,
      debounceMs: normalized.debounceMs,
      contextMessages: normalized.contextMessages,
      maxInputChars: normalized.maxInputChars,
      enabled: normalized.enabled,
      allowMultiline: normalized.allowMultiline,
      inlineHint: normalized.inlineHint,
      placeholderHint: normalized.placeholderHint,
      provider: typeof next.provider === 'string' ? next.provider.trim() : '',
      model: typeof next.model === 'string' ? next.model.trim() : '',
    }, env);
    return { ok: true, settings: await effectiveSettings() };
  }

  /**
   * 可用的 provider / model 清单（面板里的模型选择器用）。
   *
   * @returns {Promise<object>} { ok, providers, current }。
   */
  async function listModels() {
    const llm = getLlm();
    const settingsNow = await effectiveSettings();
    const current = { provider: settingsNow.provider, model: settingsNow.model };
    if (llm === null) {
      return { ok: true, providers: [], current, error: '本 profile 没有可用的 llm 服务' };
    }
    let infos;
    try {
      infos = llm.listProviders();
    } catch (error) {
      return { ok: true, providers: [], current, error: `模型清单读取失败：${error?.message ?? String(error)}` };
    }
    const providers = [];
    for (const info of infos.slice(0, 50)) {
      try {
        const models = await llm.listModels(info.id);
        providers.push({
          id: info.id,
          name: typeof info.name === 'string' && info.name !== '' ? info.name : info.id,
          models: models.slice(0, 200).map((model) => ({ id: model.id, name: model.name ?? model.id })),
        });
      } catch (error) {
        // 拉不到就只留 provider 名，用户仍可手填模型 id。
        providers.push({ id: info.id, name: info.name ?? info.id, models: [], error: String(error?.message ?? error) });
      }
    }
    return { ok: true, providers: providers, current: current };
  }

  return {
    suggest: suggest,
    settings: settings,
    saveSettings: saveSettings,
    listModels: listModels,
  };
}
