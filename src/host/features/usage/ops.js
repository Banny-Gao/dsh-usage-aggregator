// src/host/features/usage/ops.js
//
// 操作层：插件对外能力的**唯一实现**。
//
// HTTP 路由（浏览器里点按钮）和 Agent 工具（对话里让我查）都调这里同一份方法，
// 不存在两套逻辑。每个方法都返回 {ok, ...} 或 {ok:false, error}，不抛异常给调用方 ——
// 失败原因是给用户看的，不是给栈追踪看的。
//
// 一次「接入」的完整链路（也是这个插件最核心的一段）：
//   粘贴文本 → 解析成请求 → 真实打一次 → 拿到响应 → 模型分析出展示模板（缓存）
//   → 模板套到响应上算出一份 view。之后每次刷新都只重放请求 + 复用模板，不再调模型。

import { analyzeImage, analyzeRequestText, analyzeResponse, snapshotToView } from './analyze.js';
import { dueProviders, dueRenewals, nextDueIn, normalizeIntervalSeconds } from './auto.js';
import { canRenewSilently, renewRecord, renewalFor } from './renewal/index.js';
import { inspectCredential, parseRequestText } from './curl.js';
import { performRequest } from './request.js';
import { evaluateHealth, guessTitle, resolveView } from './resolve.js';
import { FALLBACK_VERSION, fallbackTemplate, validateTemplate } from './template.js';
import { dataDir, findProvider, maskProvider, providerIdFrom, readStore, upsert, writeStore } from './store.js';

/** 存进 store 的响应体上限（字符）：够重放分析，又不至于把 store.json 撑爆。 */
const STORED_DATA_LIMIT = 200000;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 上一轮分析失败留下的提示（分析一旦成功就该摘掉，别让旧警告挂在面板上）。 */
const STALE_ANALYSIS_NOTE = /模型分析失败|请求提取失败|截图识别失败|已按响应结构兜底|按响应结构兜底/;

/**
 * 结构指纹：顶层键 + 第一个数组项里的键。
 *
 * 用途只有一个 —— 判断「接口结构变了没有」。变了就自动重新分析一次模板，
 * 没变就继续用缓存模板（省掉每次查询的模型调用）。
 */
export function fingerprint(data) {
  const shape = [];
  const walk = (node, prefix, depth) => {
    if (node === null || typeof node !== 'object' || depth > 2) return;
    if (Array.isArray(node)) {
      shape.push(`${prefix}[]`);
      if (node.length > 0) walk(node[0], `${prefix}[]`, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const next = prefix === '' ? key : `${prefix}.${key}`;
      if (value !== null && typeof value === 'object') walk(value, next, depth + 1);
      else shape.push(`${next}:${value === null ? 'null' : typeof value}`);
    }
  };
  walk(data, '', 0);
  return shape.sort().join('|').slice(0, 4000);
}

/**
 * 建立操作层。
 *
 * @param {{config: object, llm?: object|Function|null, attachments?: object|Function|null, env?: NodeJS.ProcessEnv}} deps
 */
export function createOps(deps) {
  const config = deps.config ?? {};
  const analysis = config.analysis ?? {};
  const language = analysis.language === 'en' ? 'en' : 'zh';
  const provider = typeof analysis.provider === 'string' ? analysis.provider : 'axzo-one';
  const model = typeof analysis.model === 'string' ? analysis.model : 'auto/deepseek-flash';
  const maxTokens = typeof analysis.maxOutputTokens === 'number' ? analysis.maxOutputTokens : 4000;
  const timeoutMs = typeof config.request?.timeoutMs === 'number' ? config.request.timeoutMs : 30000;
  const allowImage = config.analysis?.allowImage !== false;
  // 自动查询：默认开，每 5 分钟一次。
  const autoEnabled = config.autoRefresh?.enabled !== false;
  const autoIntervalSeconds = normalizeIntervalSeconds(config.autoRefresh?.intervalSeconds, 300);
  const autoIntervalMs = autoIntervalSeconds * 1000;
  // 自动续期：默认开。提前多久动手（默认 30 分钟）与失败后冷却多久都是可配的 ——
  // 提前量太长会让「今天刚续过、晚上又续一次」的抖动变得频繁，太短则在跨零点
  // 那次刷新前就已经过期了。
  const renewalConfig = config.renewal ?? {};
  const renewalEnabled = renewalConfig.enabled !== false;
  const renewalLeadMs = typeof renewalConfig.leadSeconds === 'number' ? renewalConfig.leadSeconds * 1000 : 1800000;
  const renewalCooldownMs = typeof renewalConfig.cooldownSeconds === 'number' ? renewalConfig.cooldownSeconds * 1000 : 1800000;
  const env = deps.env ?? process.env;

  // 服务是**按需解析**的，不是启动时快照：llm / attachments 由别的插件注册，
  // 谁先谁后不确定。用 getter 之后，插件可以在 llm 就位之前就装好路由，
  // 也能在 HMR 换掉 adapter 之后继续用新的那个。
  const getLlm = typeof deps.llm === 'function' ? deps.llm : () => deps.llm ?? null;
  const getAttachments = typeof deps.attachments === 'function' ? deps.attachments : () => deps.attachments ?? null;

  /**
   * 当前生效的分析模型：**用户在面板里选的优先**，没选过才用插件配置里的默认值。
   *
   * 为什么不是「读一次缓存」：面板改完立刻就要生效，而分析是低频动作，多读一次这个
   * 小文件（几 KB）远比缓存失效的代价低。
   */
  const effectiveAnalysis = async () => {
    const store = await load();
    const chosen = store.settings?.analysisModel ?? null;
    return chosen === null
      ? { provider, model, source: 'config' }
      : { provider: chosen.provider, model: chosen.model === '' ? provider : chosen.model, source: 'user' };
  };

  const load = () => readStore(env);
  const save = (store) => writeStore(store, env);

  /** 统一的分析调用包装：把异常转成 {ok:false}。 */
  const callAnalysis = async (label, run) => {
    if (getLlm() === null) return { ok: false, error: '未配置可用的分析模型（analysis.provider / analysis.model）' };
    try {
      return await run();
    } catch (error) {
      return { ok: false, error: `${label}失败：${error?.message ?? String(error)}` };
    }
  };

  /** 用当前响应跑一次分析并落模板；失败退兜底模板。 */
  const analyzeAndStore = async (record, data, rawText, imageAttachment = null) => {
    const chosen = await effectiveAnalysis();
    const result = await callAnalysis('模型分析', () => analyzeResponse(getLlm(), {
      request: record.request,
      response: data,
      rawText,
      label: record.label,
      provider: chosen.provider,
      model: chosen.model,
      language,
      maxTokens,
      imageAttachment,
    }));
    if (result.ok) {
      const validated = validateTemplate(result.raw);
      if (validated.ok) {
        record.template = validated.template;
        record.templateSource = 'auto';
        // 分析成功就把上一轮的失败提示摘掉：否则「模型分析失败…」会一直挂在面板上，
        // 让人以为现在是坏的。
        const kept = (record.notes ?? []).filter((note) => !STALE_ANALYSIS_NOTE.test(note));
        record.notes = dedupe([...kept, ...validated.warnings]);
        return { source: 'auto', warnings: validated.warnings };
      }
      const fallback = fallbackTemplate(data, record.label);
      if (fallback !== null) {
        record.template = fallback;
        record.templateSource = 'fallback';
        record.notes = dedupe([...(record.notes ?? []), `模型给的模板不可用（${validated.error}），已按响应结构兜底`]);
        return { source: 'fallback', warnings: [validated.error] };
      }
      return { source: null, warnings: [validated.error] };
    }
    const fallback = fallbackTemplate(data, record.label);
    if (fallback !== null) {
      record.template = fallback;
      record.templateSource = 'fallback';
      record.notes = dedupe([...(record.notes ?? []), `${result.error}；已按响应结构兜底，可在面板里点「重新分析」重试`]);
      return { source: 'fallback', warnings: [result.error] };
    }
    return { source: null, warnings: [result.error] };
  };

  /**
   * 保存一张「辅助截图」，返回可交给模型/附件服务的引用。
   *
   * 与「截图快照」共用同一套附件服务，但用途不同：这里只是给分析当参考，
   * 数字仍以接口响应为准。
   */
  const saveAnalysisHint = async (image) => {
    const attachments = getAttachments();
    if (attachments === null) return { ok: false, error: '本 profile 没有附件服务，无法读取截图' };
    const bytes = decodeBase64(image.data);
    if (bytes === null) return { ok: false, error: '图片数据不是合法的 base64' };
    if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: `图片太大（${Math.round(bytes.length / 1024)}KB），请压到 8MB 以内` };
    try {
      const ref = await attachments.saveImage({ data: bytes, mediaType: image.mediaType ?? 'image/png', name: 'usage-analysis-hint' });
      return { ok: true, ref };
    } catch (error) {
      return { ok: false, error: `截图保存失败：${error?.message ?? String(error)}` };
    }
  };

  /** 把一次请求结果套用模板，写进记录的 view / last。 */
  const applyResult = async (record, result, trigger = 'manual', analysisImage = null) => {
    const fingerprintOfResponse = result.json === null ? null : fingerprint(result.json);
    // 兜底模板版本落后（老版本生成的那份）：当作缺模板重新生成 —— 会再试一次模型分析，
    // 失败也至少换上新版兜底（中文名 + 重要性排序）。老记录因此能自愈，不用手动清。
    const staleFallback = record.templateSource === 'fallback'
      && record.template !== null
      && record.template.fallbackVersion !== FALLBACK_VERSION;
    const templateMissing = record.template === null || staleFallback;
    const shapeChanged = record.template !== null && record.last?.fingerprint != null && fingerprintOfResponse !== null && record.last.fingerprint !== fingerprintOfResponse;
    const meta = {
      language,
      order: record.fieldOrder ?? [],
      fetchedAt: result.at,
      httpStatus: result.httpStatus,
      status: result.status,
      message: result.message,
    };

    let analysisSource = null;
    if (result.status === 'ok' && result.json !== null && (templateMissing || shapeChanged)) {
      const analyzed = await analyzeAndStore(record, result.json, result.text, analysisImage);
      analysisSource = analyzed.source;
      if (analyzed.source === null && templateMissing) {
        // 既没有模型也没有结构兜底：至少把原始 JSON 摆出来，不要白屏。
        record.template = null;
      }
    }

    record.last = {
      at: result.at,
      // 这次是谁触发的：manual(点刷新) / auto(定时) / import(接入即首查)
      trigger,
      status: result.status,
      message: result.message,
      httpStatus: result.httpStatus,
      ms: result.ms,
      bytes: result.bytes,
      fingerprint: fingerprintOfResponse,
      data: storeData(result.json),
      analysisSource,
    };
    if (result.status === 'ok' && record.template !== null) {
      record.view = resolveView(record.template, result.json, meta);
    } else if (record.template !== null && record.view !== null) {
      // 失败时保留上一次的 view（数据还在，只是过期了），但状态跟着结果走。
      const business = result.json === null ? { ok: true, message: '' } : evaluateHealth(record.template, result.json);
      record.view = {
        ...record.view,
        status: {
          tone: 'error',
          label: result.status === 'expired' ? '登录态已失效' : '查询失败',
          message: result.message === '' ? business.message : result.message,
        },
        httpStatus: result.httpStatus,
        staleAt: result.at,
      };
    }
    record.updatedAt = Date.now();
    return record;
  };

  // 串行锁：每个会**改 store** 的操作都排队执行。
  //
  // 为什么必须有：刷新是「读文件 → 改 → 写回」，两条并发刷新（面板的「全部刷新」
  // 就是并发发出去的）会互相覆盖，最后写回的那条把另一条的结果吞掉。锁只包住
  // 写路径，读路径（state / summary / raw）不加锁，面板轮询不受影响。
  let queue = Promise.resolve();
  const withLock = (run) => {
    const next = queue.then(run, run);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };

  const api = {
    /** 面板首屏需要的全部信息（已脱敏）。 */
    async state() {
      const store = await load();
      return {
        ok: true,
        version: 1,
        analysis: {
          ready: getLlm() !== null && (await effectiveAnalysis()).model !== '',
          provider: getLlm() !== null ? (await effectiveAnalysis()).provider : null,
          model: getLlm() !== null ? (await effectiveAnalysis()).model : null,
          source: getLlm() !== null ? (await effectiveAnalysis()).source : null,
          reason: getLlm() === null ? '本 profile 没有可用的 llm 服务或未配置分析模型' : null,
        },
        image: { enabled: allowImage && getAttachments() !== null, reason: allowImage ? (getAttachments() === null ? '本 profile 没有附件服务' : null) : '配置里关闭了截图识别' },
        autoRefresh: { enabled: autoEnabled, intervalSeconds: autoIntervalSeconds },
        // 会话头芯片显示哪个接口（用户在浮层里点的「顶部显示」）；没选过就是第一个
        chip: { id: store.settings?.chipId ?? null },
        providers: store.providers.map((provider) => ({
          ...maskProvider(provider),
          // 面板据此显示「下次 14:35」。不会自动查的（截图来源 / 登录态过期）给 null。
          nextDueIn: autoEnabled ? nextDueIn(provider, { now: Date.now(), intervalMs: autoIntervalMs }) : null,
        })),
      };
    },

    /**
     * 接入一个接口：粘贴请求文本，或给一张截图。
     *
     * `replaceId` 存在时是「重贴凭证」而不是新建：同一个接口换了登录态，重用原
     * 记录（保留已缓存的展示模板），因此过期引导不会在面板里堆出一串 minimax-2。
     *
     * @param {{text?: string, image?: {data: string, mediaType: string}, label?: string, replaceId?: string}} input
     */
    async import(input) {
      const store = await load();
      const existing = typeof input.replaceId === 'string' && input.replaceId !== '' ? findProvider(store, input.replaceId) : null;
      const text = typeof input.text === 'string' ? input.text : '';
      const hasText = text.trim() !== '';
      // 图片的角色取决于**有没有同时给请求文本**：
      //   只有图片  → 快照（读图得到一次性的数字，不能自动刷新）
      //   图片+文本 → 真实请求照跑，图片只当分析辅助
      // 这个判断必须放在最前面，否则「cURL + 图片」会被误当成快照（写测试时抓到的 bug）。
      if (input.image !== undefined && input.image !== null && !hasText) {
        if (!allowImage) return { ok: false, error: '配置里关闭了截图识别' };
        const attachments = getAttachments();
        if (attachments === null) return { ok: false, error: '本 profile 没有附件服务，无法读取截图' };
        if (getLlm() === null) return { ok: false, error: '截图识别需要可用的分析模型（analysis.provider / analysis.model）' };
        const bytes = decodeBase64(input.image.data);
        if (bytes === null) return { ok: false, error: '图片数据不是合法的 base64' };
        if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: `图片太大（${Math.round(bytes.length / 1024)}KB），请压到 8MB 以内` };
        let ref;
        try {
          ref = await attachments.saveImage({ data: bytes, mediaType: input.image.mediaType ?? 'image/png', name: input.label ?? 'usage-screenshot' });
        } catch (error) {
          return { ok: false, error: `截图保存失败：${error?.message ?? String(error)}` };
        }
        const chosenForImage = await effectiveAnalysis();
        const read = await callAnalysis('截图识别', () => analyzeImage(getLlm(), {
          attachment: ref,
          label: input.label ?? '用量',
          provider: chosenForImage.provider,
          model: chosenForImage.model,
          language,
          maxTokens,
        }));
        if (!read.ok) return { ok: false, error: read.error };
        const id = existing !== null ? existing.id : providerIdFrom({ url: '' }, input.label, new Set(store.providers.map((item) => item.id)));
        const view = snapshotToView(read.snapshot, { label: input.label ?? '用量', readAt: Date.now() });
        const record = {
          id,
          label: typeof input.label === 'string' && input.label.trim() !== '' ? input.label.trim() : view.title,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          source: 'image',
          request: null,
          credential: null,
          template: null,
          templateSource: null,
          last: null,
          view: null,
          snapshot: view,
          notes: ['数据来自截图识别，不会自动刷新。想要实时数值，请用「Copy as cURL」粘贴一次请求。'],
        };
        upsert(store, record);
        await save(store);
        return { ok: true, provider: maskProvider(record) };
      }

      if (!hasText) return { ok: false, error: '请粘贴接口请求（DevTools → Copy as cURL）或一张用量截图' };
      // 文本 + 图片：图片不是数据源，而是**分析辅助** —— 用图来解释字段含义，
      // 数字仍以接口响应为准。只有图片时才退化成「快照」模式。
      let analysisHint = null;
      if (input.image !== undefined && input.image !== null) {
        const saved = await saveAnalysisHint(input.image);
        if (!saved.ok) return { ok: false, error: saved.error };
        analysisHint = saved.ref;
      }
      let parsed = parseRequestText(text);
      const notes = parsed.ok ? [...parsed.notes] : [];
      if (!parsed.ok) {
        const chosenForRescue = await effectiveAnalysis();
        const rescued = await callAnalysis('请求提取', () => analyzeRequestText(getLlm(), { text, provider: chosenForRescue.provider, model: chosenForRescue.model, maxTokens }));
        if (!rescued.ok) return { ok: false, error: `${parsed.error}；${rescued.error}` };
        parsed = { ok: true, request: rescued.request, notes: ['cURL 解析失败，请求由模型提取，请核对面板里的接口地址'] };
        if (rescued.note !== null) parsed.notes.push(rescued.note);
      }
      const takenIds = new Set(store.providers.map((item) => item.id));
      const host = hostOf(parsed.request.url);
      const label = typeof input.label === 'string' && input.label.trim() !== '' ? input.label.trim() : host;
      let record;
      if (existing !== null) {
        // 重贴凭证：同一个接口，URL 与结构都没变 —— 已缓存的展示模板继续用，
        // 因此这次刷新不会再花一次模型调用。
        record = existing;
        record.label = label;
        record.request = parsed.request;
        record.credential = inspectCredential(parsed.request);
        record.updatedAt = Date.now();
        record.notes = dedupe([...(parsed.notes ?? []), '登录态 / 请求已更新']);
      } else {
        const id = providerIdFrom(parsed.request, input.label, takenIds);
        record = {
          id,
          label,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          source: 'curl',
          request: parsed.request,
          credential: inspectCredential(parsed.request),
          template: null,
          templateSource: null,
          last: null,
          view: null,
          snapshot: null,
          notes: dedupe([...(parsed.notes ?? []), ...(parsed.shape === undefined ? [] : [`识别为 ${parsed.shape} 形态`])]),
        };
      }
      upsert(store, record);
      await save(store);

      // 接入即首查：用户贴完就该看到数字，而不是先看到一片空白。
      const refreshed = await this.refresh(record.id, { trigger: 'import', analysisImage: analysisHint });
      if (!refreshed.ok) return { ok: true, provider: maskProvider((await load()).providers.find((item) => item.id === record.id) ?? record), warning: refreshed.error };
      const store2 = await load();
      return { ok: true, provider: maskProvider(findProvider(store2, record.id) ?? record) };
    },

    /**
     * 自动续期：换一枚新的登录态，然后顺手查一次。
     *
     * 与「重贴 cURL」的本质区别 —— 它只换 authorization 里的 token，URL、方法、
     * 其余请求头全部沿用，因此缓存的展示模板继续有效，这次续期**不花模型调用**。
     * 换完之后立刻 refresh，用户在面板上看到的是「续好了 + 新数字」，不是两次操作。
     *
     * @param {string} id
     * @param {{interactive?: boolean}} [options] interactive = 允许弹出可见的
     *        浏览器窗口让人扫码授权；默认静默（失败时提示需要人工授权一次）。
     */
    async renew(id, options = {}) {
      const store = await load();
      const record = findProvider(store, id);
      if (record === null) return { ok: false, error: `没有这个接口：${id}` };
      if (record.request === null) return { ok: false, error: '这条记录来自截图，没有登录态可续期' };
      if (renewalFor(record) === null) {
        return { ok: false, error: '这个接口暂时不支持自动续期（只认得已知的登录方式）—— 请重新粘贴一次请求' };
      }
      const logs = [];
      const result = await renewRecord({
        record,
        appDir: dataDir(env),
        interactive: options.interactive === true,
        onLog: (text) => { logs.push(text); },
      });
      record.renewal = {
        lastAttemptAt: Date.now(),
        lastResult: result.ok ? 'ok' : 'failed',
        lastMessage: result.message ?? null,
        lastMode: result.mode ?? null,
      };
      if (result.ok !== true) {
        await save(store);
        return { ok: false, error: result.message ?? '自动续期失败', needsInteraction: result.needsInteraction === true, logs };
      }
      record.request = result.request;
      record.credential = inspectCredential(record.request);
      record.updatedAt = Date.now();
      record.notes = dedupe([...(record.notes ?? []), `登录态已自动续期（${result.mode === 'silent' ? '静默' : '重新授权'}）`]);
      await save(store);
      // 续期成功就顺手查一次：用户点的动机是「想看到数字」，不是「想换 token」。
      const refreshed = await this.refresh(record.id, { trigger: 'renew' });
      const store2 = await load();
      return {
        ok: refreshed.ok !== false,
        provider: maskProvider(findProvider(store2, record.id) ?? record),
        status: refreshed.status ?? null,
        message: result.message,
        error: refreshed.ok === false ? refreshed.error : undefined,
        logs,
      };
    },

    /** 重新打一次接口（模板复用，除非结构变了）。 */
    async refresh(id, options = {}) {
      const store = await load();
      const record = findProvider(store, id);
      if (record === null) return { ok: false, error: `没有这个接口：${id}` };
      if (record.request === null) {
        return { ok: false, error: '这条记录来自截图，没有可重放的请求；请重新粘贴接口请求' };
      }
      const result = await performRequest(record.request, { timeoutMs, signal: options.signal });
      await applyResult(record, result, options.trigger ?? 'manual', options.analysisImage ?? null);
      record.credential = inspectCredential(record.request);
      await save(store);
      return { ok: result.status !== 'error', provider: maskProvider(record), status: result.status, message: result.message };
    },

    /**
     * 跑一轮自动查询：只查「到点了」的接口（见 auto.js 的判定）。
     *
     * 串行执行（外层 withLock 已经保证）：上游大多是按账号限流的接口，并发打过去
     * 只会换来一批 429。
     *
     * @param {{intervalMs?: number, now?: number}} options
     */
    async refreshDue(options = {}) {
      const intervalMs = typeof options.intervalMs === 'number' ? options.intervalMs : autoIntervalMs;
      const now = typeof options.now === 'number' ? options.now : Date.now();
      const store = await load();
      // 续期排在查询前面：token 过期时 dueProviders 会跳过这条记录，先换一枚新的，
      // 它这一轮才会被查到。顺序反了的话，每次续期都要等下一轮才见效。
      const renewals = renewalEnabled
        ? dueRenewals(store.providers, {
          now,
          leadMs: renewalLeadMs,
          cooldownMs: renewalCooldownMs,
          // 只排「能无人值守续期」的记录。钉钉这类每次都要人点「同意」的站点放进
          // 队列里毫无意义 —— 每天定时拉起一个必然失败的无头浏览器。
          supportsRenewal: canRenewSilently,
        })
        : [];
      const renewed = [];
      for (const id of renewals) {
        const result = await api.renew(id, { interactive: false });
        renewed.push({ id, ok: result.ok === true, error: result.error ?? null, needsInteraction: result.needsInteraction === true });
      }
      const store2 = await load();
      const due = dueProviders(store2.providers, { now, intervalMs });
      const results = [];
      for (const id of due) {
        const result = await api.refresh(id, { trigger: 'auto' });
        results.push({ id, ok: result.ok === true, status: result.status ?? null, error: result.error ?? null });
      }
      return { ok: true, due: due.length, renewed, refreshed: results };
    },

    /** 重新跑一次模型分析（接口结构变了、或上次模型抽风时用）。 */
    async reanalyze(id, options = {}) {
      const store = await load();
      const record = findProvider(store, id);
      if (record === null) return { ok: false, error: `没有这个接口：${id}` };
      // 可选：这次分析额外附一张截图当辅助（用户看懂了页面，想告诉模型字段叫什么）。
      let imageAttachment = null;
      if (options.image !== undefined && options.image !== null) {
        const saved = await saveAnalysisHint(options.image);
        if (!saved.ok) return { ok: false, error: saved.error };
        imageAttachment = saved.ref;
      }
      if (record.last?.data === null || record.last?.data === undefined) {
        const refreshed = await this.refresh(id, { analysisImage: imageAttachment });
        if (!refreshed.ok) return refreshed;
        return { ok: true, provider: refreshed.provider, note: '还没有缓存响应，已重新查询' };
      }
      record.template = null;
      const analyzed = await analyzeAndStore(record, record.last.data, null, imageAttachment);
      if (analyzed.source === null) return { ok: false, error: analyzed.warnings[0] ?? '分析失败' };
      record.view = resolveView(record.template, record.last.data, {
        language,
        order: record.fieldOrder ?? [],
        fetchedAt: record.last.at,
        httpStatus: record.last.httpStatus,
        status: 'ok',
        message: '',
      });
      record.updatedAt = Date.now();
      await save(store);
      return { ok: true, provider: maskProvider(record), source: analyzed.source };
    },

    /**
     * 列出可用的分析模型（provider → models）。
     *
     * 单个 provider 拉取失败（没配密钥 / 不支持列举）不影响其它：跳过并把原因带回去，
     * 免得一个坏 provider 把整个选择器搞空。
     */
    async listAnalysisModels() {
      const llm = getLlm();
      const chosen = await effectiveAnalysis();
      const current = { provider: chosen.provider, model: chosen.model, source: chosen.source };
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
          // 拉不到就只留 provider 名，用户仍可手填模型 id
          providers.push({ id: info.id, name: info.name ?? info.id, models: [], error: String(error?.message ?? error) });
        }
      }
      return { ok: true, providers, current };
    },

    /** 设定会话头芯片显示哪个接口（空 id = 回到「第一个」）。 */
    async setChipProvider(id) {
      const next = typeof id === 'string' ? id.trim() : '';
      if (next !== '') {
        const store = await load();
        if (findProvider(store, next) === null) return { ok: false, error: `没有这个接口：${next}` };
      }
      const store = await load();
      store.settings = { ...(store.settings ?? {}), chipId: next === '' ? null : next };
      await save(store);
      return { ok: true, chip: { id: store.settings.chipId } };
    },

    /** 保存面板里选的分析模型（空 provider = 回到插件配置的默认值）。 */
    async setAnalysisModel(providerId, modelId) {
      const next = typeof providerId === 'string' ? providerId.trim() : '';
      const modelText = typeof modelId === 'string' ? modelId.trim() : '';
      if (next === '') return { ok: false, error: 'provider 不能为空（传空字符串表示恢复默认）' };
      const store = await load();
      store.settings = { ...(store.settings ?? {}), analysisModel: modelText === '' ? null : { provider: next, model: modelText } };
      await save(store);
      return { ok: true, current: await effectiveAnalysis(), cleared: modelText === '' };
    },

    /**
     * 保存用户手工排的字段顺序（空数组 = 恢复默认）。
     *
     * 只重算 view，**不重新打上游接口** —— 排序是纯展示层的事，没有任何理由为此再查一次。
     */
    async setFieldOrder(id, paths) {
      const store = await load();
      const record = findProvider(store, id);
      if (record === null) return { ok: false, error: `没有这个接口：${id}` };
      const cleaned = Array.isArray(paths)
        ? [...new Set(paths.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()))].slice(0, 40)
        : [];
      record.fieldOrder = cleaned.length === 0 ? null : cleaned;
      record.updatedAt = Date.now();
      if (record.last !== null && record.last.data !== null && record.template !== null) {
        record.view = resolveView(record.template, record.last.data, {
          language,
          order: record.fieldOrder ?? [],
          fetchedAt: record.last.at,
          httpStatus: record.last.httpStatus,
          status: record.last.status === 'ok' ? 'ok' : record.last.status,
          message: record.last.status === 'ok' ? '' : record.last.message,
        });
      }
      await save(store);
      return { ok: true, provider: maskProvider(record) };
    },

    async remove(id) {
      const store = await load();
      const index = store.providers.findIndex((item) => item.id === id);
      if (index === -1) return { ok: false, error: `没有这个接口：${id}` };
      const [removed] = store.providers.splice(index, 1);
      await save(store);
      return { ok: true, removed: removed.id };
    },

    /** 供工具侧使用的紧凑摘要（给模型看的文本）。 */
    async summary() {
      const store = await load();
      if (store.providers.length === 0) return { ok: true, text: '还没有接入任何用量接口。让用户粘贴一次接口请求（DevTools → Copy as cURL）或一张用量截图即可。' };
      const lines = [];
      for (const record of store.providers) {
        const masked = maskProvider(record);
        lines.push(`- ${record.id}（${record.label}）状态=${masked.status} 来源=${record.source} 接口=${masked.endpoint ?? '—'}`);
        const view = masked.view;
        if (view !== null && view !== undefined) {
          const numbers = [];
          if (view.primary !== null) numbers.push(`${view.primary.label}=${view.primary.text}`);
          for (const metric of view.metrics ?? []) numbers.push(`${metric.label}=${metric.text}`);
          for (const card of view.cards ?? []) {
            numbers.push(`${card.label}[${(card.metrics ?? []).map((metric) => `${metric.label}=${metric.text}`).join(', ')}]`);
          }
          lines.push(`  ${view.title}：${numbers.join('；') || '（无指标）'}`);
        }
        if (record.last?.message) lines.push(`  最近提示：${record.last.message}`);
      }
      return { ok: true, text: lines.join('\n') };
    },

    /** 面板「原始响应」折叠区用：返回最近一次响应 JSON（可能有截断标记）。 */
    async raw(id) {
      const store = await load();
      const record = findProvider(store, id);
      if (record === null) return { ok: false, error: `没有这个接口：${id}` };
      return { ok: true, data: record.last?.data ?? null, text: record.last?.data === null ? null : JSON.stringify(record.last?.data, null, 2) };
    },
  };

  // 公开出口：写操作套锁，读操作直通。
  // 注意 api.import 内部调用的是 this.refresh（即 api 上**未加锁**的那份），
  // 所以「接入即首查」不会自己把自己锁死。
  return {
    state: api.state,
    summary: api.summary,
    raw: api.raw,
    import: (input) => withLock(() => api.import(input)),
    refresh: (id, options) => withLock(() => api.refresh(id, options)),
    renew: (id, options) => withLock(() => api.renew(id, options)),
    reanalyze: (id, options) => withLock(() => api.reanalyze(id, options)),
    remove: (id) => withLock(() => api.remove(id)),
    setFieldOrder: (id, paths) => withLock(() => api.setFieldOrder(id, paths)),
    setAnalysisModel: (providerId, modelId) => withLock(() => api.setAnalysisModel(providerId, modelId)),
    setChipProvider: (id) => withLock(() => api.setChipProvider(id)),
    listAnalysisModels: () => api.listAnalysisModels(),
    refreshDue: (options) => withLock(() => api.refreshDue(options)),
  };
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '用量';
  }
}

function decodeBase64(data) {
  if (typeof data !== 'string') return null;
  const cleaned = data.includes(',') && data.trim().startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data;
  try {
    const bytes = Buffer.from(cleaned, 'base64');
    return bytes.length === 0 ? null : new Uint8Array(bytes);
  } catch {
    return null;
  }
}

function storeData(json) {
  if (json === null || json === undefined) return null;
  try {
    const text = JSON.stringify(json);
    if (text.length > STORED_DATA_LIMIT) return null;
    return json;
  } catch {
    return null;
  }
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (typeof item !== 'string' || item.trim() === '' || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out.slice(-8);
}

export { guessTitle };
