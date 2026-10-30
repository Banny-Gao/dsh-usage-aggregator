// src/host/features/usage/template.js
//
// 展示模板：模型看完「请求 + 响应」之后给出的**可复算的取数说明**。
//
// 关键取舍：模板不是渲染指令，而是一张路径表。模型只负责回答「哪个字段是什么
// 意思、该按哪种格式显示」，真正的取值/格式化由 resolve.js 用代码完成。
// 这样换接口只换模板，客户端渲染器一行不用改 —— 这正是「后面还会有其他接口」
// 所需的扩展方式；也让模型的输出永远可以被校验、被拒绝、被兜底替换。
//
// 本文件只做两件事：校验模型输出（validateTemplate）、在没有模型时给一份启发式
// 模板（fallbackTemplate）。

import { guessFormatForField, labelForField, sortByPriority } from './labels.js';
import { detectBusinessFailure } from './request.js';

export const TEMPLATE_VERSION = 1;

/**
 * 兜底模板的「生成器版本」。
 *
 * 兜底模板是按结构推断的，它的**质量**会随代码改进（例如现在会翻中文名、按重要性排序）。
 * 已经在磁盘上的旧兜底模板不会自己变好，所以带一个版本号：ops.js 发现版本落后就
 * 重新生成 —— 顺便再试一次模型分析。
 */
export const FALLBACK_VERSION = 2;

/** 允许的格式。模板里出现别的一律降级成 text（渲染器不认识的不猜）。 */
export const FORMATS = ['percent', 'number', 'count', 'duration_ms', 'datetime', 'date', 'seconds', 'bytes', 'currency', 'text'];

const KINDS = ['quota', 'balance', 'usage', 'list', 'generic'];

/** 字段条数上限。
 *
 * 需求是「所有字段都要解析，默认展示 5 个最值得关心的，其余折叠」：所以上限要够
 * 宽（能装下真实接口的全部字段），却又不能无限（模板来自模型，得防跑偏）。
 * 24 是「够用」与「跑偏」之间的取值；默认展示多少由客户端决定（DEFAULT_VISIBLE）。
 */
const MAX_METRICS = 24;

function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** 路径语法只允许「点 + 下标」，拒绝一切表达式 —— 模板是数据，不是代码。 */
export function isPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return /^\$?\.?[A-Za-z0-9_$.[\]-]*$/.test(value.trim()) && /[A-Za-z0-9_$\]]/.test(value.trim());
}

function normalizeMetric(raw, path) {
  if (raw === null || typeof raw !== 'object') return null;
  const metricPath = asString(raw.path);
  if (metricPath === null || !isPath(metricPath)) return null;
  const label = asString(raw.label) ?? metricPath;
  const format = FORMATS.includes(raw.format) ? raw.format : 'text';
  const metric = { path: metricPath, label: label.slice(0, 40), format };
  if (raw.hideWhen !== undefined) metric.hideWhen = raw.hideWhen;
  if (typeof raw.unit === 'string' && raw.unit.length <= 8) metric.unit = raw.unit;
  if (raw.tone === 'ok' || raw.tone === 'warn' || raw.tone === 'error' || raw.tone === 'muted') metric.tone = raw.tone;
  if (raw.emphasis === true) metric.emphasis = true;
  void path;
  return metric;
}

function normalizeMetrics(raw) {
  if (!Array.isArray(raw)) return [];
  const metrics = [];
  for (const item of raw.slice(0, MAX_METRICS)) {
    const metric = normalizeMetric(item);
    if (metric !== null) metrics.push(metric);
  }
  return metrics;
}

function normalizeProgress(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const path = asString(raw.path);
  if (path === null || !isPath(path)) return null;
  const progress = { path, label: asString(raw.label) ?? null };
  if (raw.invert === true) progress.invert = true;
  if (raw.max !== undefined && Number.isFinite(Number(raw.max))) progress.max = Number(raw.max);
  return progress;
}

function normalizeHealth(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const path = asString(raw.path);
  if (path === null || !isPath(path)) return null;
  const health = { path };
  if (Array.isArray(raw.okValues)) health.okValues = raw.okValues.filter((item) => typeof item === 'number' || typeof item === 'string').slice(0, 8);
  if (Array.isArray(raw.expiredValues)) health.expiredValues = raw.expiredValues.filter((item) => typeof item === 'number' || typeof item === 'string').slice(0, 8);
  const messagePath = asString(raw.messagePath);
  if (messagePath !== null && isPath(messagePath)) health.messagePath = messagePath;
  return health;
}

/**
 * 校验并规范化模型给出的模板。
 *
 * @param {unknown} raw 模型输出（已解析成 JSON 对象）。
 * @returns {{ok: true, template: object, warnings: string[]} | {ok: false, error: string}}
 */
export function validateTemplate(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '模板必须是 JSON 对象' };
  const warnings = [];
  const title = asString(raw.title);
  if (title === null) return { ok: false, error: '模板缺少 title' };
  const kind = KINDS.includes(raw.kind) ? raw.kind : 'generic';
  if (!KINDS.includes(raw.kind)) warnings.push(`kind 不认识（${String(raw.kind)}），按 generic 处理`);

  const template = {
    version: TEMPLATE_VERSION,
    kind,
    title: title.slice(0, 60),
    subtitle: asString(raw.subtitle)?.slice(0, 120) ?? null,
    notes: Array.isArray(raw.notes)
      ? raw.notes.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim().slice(0, 200)).slice(0, 6)
      : [],
    health: normalizeHealth(raw.health),
    primary: normalizeMetric(raw.primary),
    progress: normalizeProgress(raw.progress),
    metrics: normalizeMetrics(raw.metrics),
    collection: null,
  };

  if (raw.collection !== null && typeof raw.collection === 'object') {
    const path = asString(raw.collection.path);
    if (path === null || !isPath(path)) {
      warnings.push('collection.path 不可用，已忽略整组明细');
    } else {
      const labelPath = asString(raw.collection.labelPath);
      const collection = {
        path,
        labelPath: labelPath !== null && isPath(labelPath) ? labelPath : null,
        labelMap: null,
        subtitlePath: null,
        emptyText: asString(raw.collection.emptyText)?.slice(0, 60) ?? null,
        progress: normalizeProgress(raw.collection.progress),
        metrics: normalizeMetrics(raw.collection.metrics),
      };
      const subtitlePath = asString(raw.collection.subtitlePath);
      if (subtitlePath !== null && isPath(subtitlePath)) collection.subtitlePath = subtitlePath;
      if (raw.collection.labelMap !== null && typeof raw.collection.labelMap === 'object' && !Array.isArray(raw.collection.labelMap)) {
        const map = {};
        for (const [key, value] of Object.entries(raw.collection.labelMap).slice(0, 24)) {
          if (typeof value === 'string' && value.trim() !== '') map[key] = value.trim().slice(0, 40);
        }
        if (Object.keys(map).length > 0) collection.labelMap = map;
      }
      template.collection = collection;
    }
  }

  const empty = template.primary === null
    && template.progress === null
    && template.metrics.length === 0
    && (template.collection === null || (template.collection.metrics.length === 0 && template.collection.progress === null));
  if (empty) return { ok: false, error: '模板没有可用字段（primary / metrics / collection 全空）' };
  return { ok: true, template, warnings };
}

/** 名称类字段的候选键名：用来给 collection 里的每一项挑一个标题。 */
const LABEL_KEYS = ['model_name', 'name', 'label', 'title', 'model', 'product', 'plan', 'plan_name', 'type', 'id', 'key'];

const NOISE_KEYS = new Set(['base_resp', 'status_code', 'status_msg', 'code', 'message', 'success', 'trace_id', 'request_id']);

function isScalar(value) {
  return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean';
}

/** 取一个字段的中文名与格式，构成指标。 */
function describeField(path, value) {
  return { path, label: labelForField(path), format: guessFormatForField(path, value) };
}

/** 从候选指标里挑一条最适合当「进度条」的百分比字段（挑中就把它从列表里去掉）。 */
function extractProgress(metrics) {
  const index = metrics.findIndex((metric) => metric.format === 'percent' && !/total/.test(metric.path));
  if (index === -1) return { progress: null, metrics };
  const [picked] = metrics.splice(index, 1);
  return { progress: { path: picked.path, label: picked.label }, metrics };
}

/**
 * 启发式兜底：模型不可用 / 输出不合法时，按响应结构推出一份模板。
 *
 * 两条硬要求（来自真实反馈）：
 *   · **所有**标量字段都要出现，且都有中文名 —— 面板上不该出现一排英文列名；
 *   · 顺序即重要性，前几条必须是最值得关心的（剩余/已用/距重置），
 *     起止时间、状态码这类沉到后面被折叠。
 * 它不追求好看，只追求「不撒谎」：取值原样显示，认不出的字段名保留原文。
 *
 * @param {unknown} data 接口返回的 JSON。
 * @param {string} label 供应商名。
 * @returns {object|null} 模板；连一个可用字段都推不出来时返回 null。
 */
export function fallbackTemplate(data, label) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const metrics = [];
  let collection = null;

  for (const [key, value] of Object.entries(data)) {
    if (NOISE_KEYS.has(key)) continue;
    if (Array.isArray(value) && value.length > 0 && value[0] !== null && typeof value[0] === 'object' && !Array.isArray(value[0])) {
      if (collection !== null) continue;
      const sample = value[0];
      const labelKey = LABEL_KEYS.find((name) => typeof sample[name] === 'string') ?? null;
      const itemMetrics = Object.entries(sample)
        .filter(([itemKey, itemValue]) => itemKey !== labelKey && isScalar(itemValue))
        .map(([itemKey, itemValue]) => describeField(itemKey, itemValue));
      if (itemMetrics.length === 0) continue;
      const sorted = sortByPriority(itemMetrics).slice(0, MAX_METRICS);
      const { progress, metrics: rest } = extractProgress(sorted);
      collection = {
        path: key,
        labelPath: labelKey,
        labelMap: null,
        subtitlePath: null,
        emptyText: '暂无数据',
        progress,
        metrics: rest,
      };
      continue;
    }
    if (isScalar(value)) metrics.push(describeField(key, value));
  }

  if (metrics.length === 0 && collection === null) return null;
  const sortedTop = sortByPriority(metrics).slice(0, MAX_METRICS);
  const business = detectBusinessFailure(data);
  return {
    version: TEMPLATE_VERSION,
    fallbackVersion: FALLBACK_VERSION,
    kind: collection === null ? 'usage' : 'list',
    title: typeof label === 'string' && label !== '' ? label : '用量',
    subtitle: collection === null ? null : `共 ${(data[collection.path] ?? []).length} 项`,
    notes: [
      '这份展示模板是插件按响应结构推断的（未经过模型分析），字段名由插件按常见命名翻译成中文。',
      business === null ? null : `响应里的业务状态：${business.message}`,
    ].filter((item) => item !== null),
    health: null,
    // 顶层的百分比字段（真实接口里很少见，见到就是主指标）当主指标用。
    primary: sortedTop.find((metric) => metric.format === 'percent') ?? null,
    progress: null,
    metrics: sortedTop,
    collection,
  };
}
