// src/host/features/usage/resolve.js
//
// 模板 + 响应 → 展示模型（view）。
//
// 这是「确定性渲染」的那一步：模型产出的模板只说明字段含义，真正的取数、格式化、
// 分级（tone）全在这里用代码算完，客户端拿到的已经是可以直接画的字符串。
// 好处有两个：客户端是哑渲染器（新接口零改动），以及同一份响应永远渲染成同一个
// 结果（模型不会再被问第二次）。

import { getPath as readPath } from './paths.js';
import { detectBusinessFailure } from './request.js';

export const VIEW_VERSION = 1;

const DEFAULT_VIEW = {
  version: VIEW_VERSION,
  kind: 'generic',
  title: '用量',
  subtitle: null,
  notes: [],
  status: { tone: 'muted', label: '未接入', message: '' },
  primary: null,
  progress: null,
  cards: [],
  metrics: [],
};

/** 以「毫秒 epoch」为准把各种时间输入归一化；解不出来返回 null。 */
function asEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e15) return value / 1000; // 微秒
    if (value > 1e11) return value; // 毫秒
    if (value > 1e9) return value * 1000; // 秒
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return asEpochMs(Number(trimmed));
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** 百分比归一化：接受 49 / "49%" / 0.49，统一成 0-100 的数。 */
export function asPercent(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 0 && value <= 1) return value * 100;
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const withSign = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(trimmed);
    if (withSign !== null) return Number(withSign[1]);
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const number = Number(trimmed);
      return number >= 0 && number <= 1 ? number * 100 : number;
    }
  }
  return null;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function groupNumber(value, language) {
  try {
    return new Intl.NumberFormat(language === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 2 }).format(value);
  } catch {
    return String(value);
  }
}

/** 时长：毫秒 → 「2 天 3 小时」这类紧凑文本。 */
export function formatDuration(ms, language) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const zh = language === 'zh';
  const past = ms < 0;
  let seconds = Math.floor(Math.abs(ms) / 1000);
  const days = Math.floor(seconds / 86400);
  seconds -= days * 86400;
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  const parts = [];
  if (days > 0) parts.push(zh ? `${days} 天` : `${days}d`);
  if (hours > 0) parts.push(zh ? `${hours} 小时` : `${hours}h`);
  if (minutes > 0 && days === 0) parts.push(zh ? `${minutes} 分` : `${minutes}m`);
  if (seconds > 0 && days === 0 && hours === 0) parts.push(zh ? `${seconds} 秒` : `${seconds}s`);
  if (parts.length === 0) return zh ? '不到 1 秒' : '<1s';
  const text = parts.slice(0, 2).join(' ');
  if (!past) return text;
  return zh ? `已过期 ${text}` : `${text} ago`;
}

function formatDateTime(ms, language, dateOnly) {
  try {
    const formatter = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', dateOnly
      ? { year: 'numeric', month: '2-digit', day: '2-digit' }
      : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    return formatter.format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

function formatBytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = Number(value);
  let index = 0;
  while (Math.abs(size) >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${round(size, index === 0 ? 0 : 1)} ${units[index]}`;
}

/**
 * 单个取值 → 显示文本 + 可选百分比。
 *
 * @param {unknown} raw 原始取值。
 * @param {string} format 模板里声明的格式。
 * @param {{language?: string, unit?: string, now?: number}} options
 * @returns {{text: string, percent: number|null, tone: string|null}}
 */
export function formatMetricValue(raw, format, options = {}) {
  const language = options.language === 'zh' ? 'zh' : 'en';
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const unit = typeof options.unit === 'string' ? options.unit : '';
  if (raw === null || raw === undefined) return { text: '—', percent: null, tone: 'muted' };
  switch (format) {
    case 'percent': {
      const percent = asPercent(raw);
      if (percent === null) return { text: String(raw), percent: null, tone: null };
      return { text: `${round(percent, 1)}%`, percent: clampPercent(percent), tone: null };
    }
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw)
        ? { text: `${groupNumber(raw, language)}${unit}`, percent: null, tone: null }
        : { text: `${String(raw)}${unit}`, percent: null, tone: null };
    case 'count': {
      const number = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(number)) return { text: `${String(raw)}${unit}`, percent: null, tone: null };
      if (number < 0) return { text: '不限量', percent: null, tone: 'muted' };
      return { text: `${groupNumber(number, language)}${unit}`, percent: null, tone: null };
    }
    case 'duration_ms': {
      const text = formatDuration(typeof raw === 'number' ? raw : Number(raw), language);
      return text === null ? { text: String(raw), percent: null, tone: null } : { text, percent: null, tone: null };
    }
    case 'seconds': {
      const number = Number(raw);
      const text = Number.isFinite(number) ? formatDuration(number * 1000, language) : null;
      return text === null ? { text: String(raw), percent: null, tone: null } : { text, percent: null, tone: null };
    }
    case 'datetime':
    case 'date': {
      const ms = asEpochMs(raw);
      if (ms === null) return { text: String(raw), percent: null, tone: null };
      return { text: formatDateTime(ms, language, format === 'date'), percent: null, tone: null };
    }
    case 'bytes': {
      const number = Number(raw);
      return Number.isFinite(number) ? { text: formatBytes(number), percent: null, tone: null } : { text: String(raw), percent: null, tone: null };
    }
    case 'currency': {
      const number = Number(raw);
      if (!Number.isFinite(number)) return { text: String(raw), percent: null, tone: null };
      const symbol = unit === 'CNY' || unit === '¥' || unit === '' ? '¥' : unit === 'USD' ? '$' : `${unit} `;
      void now;
      return { text: `${symbol}${groupNumber(number, language)}`, percent: null, tone: null };
    }
    default: {
      if (typeof raw === 'object') return { text: compactJson(raw), percent: null, tone: null };
      if (typeof raw === 'boolean') return { text: raw ? '是' : '否', percent: null, tone: null };
      const text = String(raw);
      return { text: text.length > 120 ? `${text.slice(0, 120)}…` : text, percent: null, tone: null };
    }
  }
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, round(value, 1)));
}

function compactJson(value) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return '—';
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  } catch {
    return '—';
  }
}

/**
 * 零信息取值的显示文本。
 *
 * 「不限量」在额度面板里是常态（minimax 的 general 模型整列都是 -1），一次占满默认
 * 展示的 5 个名额就本末倒置了 —— 默认区该放真正有信息量的数字。这里只做**稳定后移**，
 * 不改模型给的相对顺序（字段的语义只有模型知道，不该由词表推翻它）。
 */
const UNINFORMATIVE = new Set(['不限量', '—', '', 'null', 'undefined']);

/**
 * 按用户手工排的顺序重排。
 *
 * 用户显式排过的字段就照他排的来 —— 不再叠加「不限量后移」那条启发式：那条是给
 * 「没人管的时候」兜底的默认观感，既然有人管了就别自作主张。没出现在顺序表里的
 * 字段（接口后来新增的）按原顺序接在后面。
 */
function applyFieldOrder(metrics, order) {
  if (!Array.isArray(order) || order.length === 0) return metrics;
  const rank = new Map(order.map((path, index) => [path, index]));
  return metrics
    .map((metric, index) => ({ metric, index, rank: rank.has(metric.path) === true ? rank.get(metric.path) : order.length + index }))
    .sort((left, right) => (left.rank === right.rank ? left.index - right.index : left.rank - right.rank))
    .map((entry) => entry.metric);
}

function deprioritizeUninformative(metrics) {
  const informative = [];
  const rest = [];
  for (const metric of metrics) {
    if (UNINFORMATIVE.has(String(metric.text).trim())) rest.push(metric);
    else informative.push(metric);
  }
  return rest.length === 0 ? metrics : [...informative, ...rest];
}

function projectMetric(metric, data, options) {
  const raw = readPath(data, metric.path);
  if (metric.hideWhen !== undefined && raw === metric.hideWhen) return null;
  if (raw === undefined) return null;
  const formatted = formatMetricValue(raw, metric.format, { language: options.language, unit: metric.unit, now: options.now });
  return {
    label: metric.label,
    path: metric.path,
    text: formatted.text,
    raw: isJsonSafe(raw) ? raw : String(raw),
    format: metric.format,
    percent: formatted.percent,
    tone: metric.tone ?? formatted.tone ?? null,
  };
}

function projectProgress(progress, data, options) {
  if (progress === null) return null;
  const raw = readPath(data, progress.path);
  const percent = asPercent(raw);
  if (percent === null) return null;
  const display = progress.invert === true ? 100 - percent : percent;
  return {
    label: progress.label,
    percent: clampPercent(display),
    text: `${round(percent, 1)}%`,
  };
}

function isJsonSafe(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value) || Array.isArray(value) || typeof value === 'object';
}

/**
 * 把模板套到一次请求结果上，得到可直接渲染的 view。
 *
 * @param {object} template 已校验的模板。
 * @param {unknown} data 响应 JSON。
 * @param {{language?: string, fetchedAt?: number|null, httpStatus?: number|null, status?: string, message?: string}} meta
 * @returns {object} view
 */
export function resolveView(template, data, meta = {}) {
  const options = { language: meta.language === 'zh' ? 'zh' : 'en', now: Date.now() };
  const order = Array.isArray(meta.order) ? meta.order : [];
  const view = {
    ...DEFAULT_VIEW,
    kind: template.kind ?? 'generic',
    title: template.title ?? DEFAULT_VIEW.title,
    subtitle: template.subtitle ?? null,
    notes: Array.isArray(template.notes) ? template.notes : [],
    metrics: [],
    cards: [],
    fetchedAt: typeof meta.fetchedAt === 'number' ? meta.fetchedAt : null,
    httpStatus: typeof meta.httpStatus === 'number' ? meta.httpStatus : null,
  };

  // 业务健康度：模板声明了 health 就按声明判，未声明时沿用通用启发式。
  const business = evaluateHealth(template, data);
  const tone = meta.status === 'expired' ? 'error' : meta.status === 'error' ? 'error' : business.ok ? 'ok' : 'warn';
  view.status = {
    tone,
    label: meta.status === 'expired' ? '登录态已失效' : meta.status === 'error' ? '查询失败' : business.ok ? '正常' : '需留意',
    message: typeof meta.message === 'string' && meta.message !== '' ? meta.message : business.message,
  };

  if (data !== null && typeof data === 'object') {
    view.primary = projectMetricWithFallback(template.primary, data, options);
    view.progress = projectProgress(template.progress ?? null, data, options);
    if (Array.isArray(template.metrics)) {
      const projected = template.metrics.map((metric) => projectMetric(metric, data, options)).filter((item) => item !== null);
      const ordered = order.length > 0 ? applyFieldOrder(projected, order) : deprioritizeUninformative(projected);
      view.metrics = ordered;
    }
    const collection = template.collection;
    if (collection !== null && typeof collection === 'object') {
      const items = readPath(data, collection.path);
      if (Array.isArray(items)) {
        view.cards = items.slice(0, 12).map((item) => ({
          label: collectionLabel(collection, item),
          subtitle: collection.subtitlePath === null ? null : selectText(readPath(item, collection.subtitlePath)),
          percent: projectProgress(collection.progress, item, options)?.percent ?? null,
          progressLabel: collection.progress === null ? null : collection.progress.label,
          metrics: order.length > 0
            ? applyFieldOrder((collection.metrics ?? []).map((metric) => projectMetric(metric, item, options)).filter((entry) => entry !== null), order)
            : deprioritizeUninformative((collection.metrics ?? []).map((metric) => projectMetric(metric, item, options)).filter((entry) => entry !== null)),
        }));
        if (view.cards.length === 0) view.notes = [...view.notes, collection.emptyText ?? '明细为空'];
      } else if (items === undefined || items === null) {
        view.notes = [...view.notes, `明细字段 ${collection.path} 不存在（接口结构可能变了）`];
      }
    }
  }
  return view;
}

function projectMetricWithFallback(metric, data, options) {
  if (metric === null || metric === undefined) return null;
  const projected = projectMetric(metric, data, options);
  if (projected === null) return null;
  return {
    label: projected.label,
    text: projected.text,
    format: projected.format,
    percent: projected.percent,
    tone: projected.tone,
  };
}

function collectionLabel(collection, item) {
  if (collection.labelPath === null) return '明细';
  const raw = readPath(item, collection.labelPath);
  const text = selectText(raw);
  if (text === null) return '明细';
  if (collection.labelMap !== null && Object.prototype.hasOwnProperty.call(collection.labelMap, String(raw))) {
    return collection.labelMap[String(raw)];
  }
  return text;
}

function selectText(value) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** health 规则 / 通用启发式，二选一。 */
export function evaluateHealth(template, data) {
  const health = template.health ?? null;
  if (health !== null && typeof health.path === 'string') {
    const raw = readPath(data, health.path);
    const message = health.messagePath === undefined ? '' : selectText(readPath(data, health.messagePath)) ?? '';
    if (raw === undefined) return { ok: true, message: '' };
    const expiredValues = health.expiredValues ?? [];
    const okValues = health.okValues ?? [];
    if (expiredValues.some((value) => value === raw)) return { ok: false, message: message === '' ? '登录态已失效，需要重新粘贴请求' : message, expired: true };
    if (okValues.length > 0) {
      const ok = okValues.some((value) => value === raw);
      return { ok, message: ok ? '' : message === '' ? `接口返回异常状态：${String(raw)}` : message };
    }
    return { ok: true, message };
  }
  const fallback = detectBusinessFailure(data);
  if (fallback === null) return { ok: true, message: '' };
  return { ok: false, message: fallback.message, expired: fallback.expired };
}

/** 从 JSON 里挖一个可读的「标题」候选（没模板时给面板用）。 */
export function guessTitle(data, fallbackLabel) {
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    for (const key of ['name', 'title', 'plan_name', 'planName', 'product_name']) {
      const value = data[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
  }
  return typeof fallbackLabel === 'string' && fallbackLabel !== '' ? fallbackLabel : '用量';
}
