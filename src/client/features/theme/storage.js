// src/client/features/theme/storage.js
// localStorage 读写与三个归一化函数。
//
// 归一化的意义：存量数据可能是旧版本写的，或被人手改过，读出来必须能安全落到
// 渲染层。

import { clamp } from './color.js';
import { DEFAULT_FLAGS } from './constants.js';
import { osFlagOverrides } from './os-prefs.js';


/* ──────────────────────── 本地偏好持久化 ───────────────────────── */
export function readStored(key) {
  try {
    var raw = window.localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch (err) { return null; }
}


export function writeStored(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); }
  catch (err) { /* 隐私模式：忽略 */ }
}


export function normalizePrimary(raw, fallback) {
  if (raw === null || typeof raw !== "object") return fallback;
  if (typeof raw.h !== "number" || typeof raw.s !== "number" || typeof raw.l !== "number") return fallback;
  return {
    h: clamp(Math.round(raw.h), 0, 360),
    s: clamp(Math.round(raw.s), 0, 100),
    l: clamp(Math.round(raw.l), 12, 82)
  };
}


export function normalizeFlags(raw, fallback) {
  var base = fallback || DEFAULT_FLAGS;
  // 没存过偏好（首次加载 / 清过 localStorage）→ 把 OS 偏好折进去。
  // 用户在面板里改过、有 stored 值的，OS 偏好不抢。
  if (raw === null || typeof raw !== "object") {
    var osO = osFlagOverrides();
    var out = {};
    for (var k in base) out[k] = base[k];
    for (var k2 in osO) out[k2] = osO[k2];
    return out;
  }
  var tint = typeof raw.tint === "number" && isFinite(raw.tint) ? clamp(Math.round(raw.tint), 0, 100) : base.tint;
  return {
    tint: tint,
    wash: raw.wash !== false,
    washLevel: typeof raw.washLevel === "number" && isFinite(raw.washLevel)
      ? clamp(Math.round(raw.washLevel), 0, 100)
      : base.washLevel,
    sbGlass: raw.sbGlass !== false,
    sbClear: typeof raw.sbClear === "number" && isFinite(raw.sbClear)
      ? clamp(Math.round(raw.sbClear), 0, 100) : base.sbClear,
    sbGrain: typeof raw.sbGrain === "number" && isFinite(raw.sbGrain)
      ? clamp(Math.round(raw.sbGrain), 0, 100) : base.sbGrain,
    hero: raw.hero !== false,
    watermark: raw.watermark !== false,
    motion: raw.motion !== false,
    glass: raw.glass !== false
  };
}
