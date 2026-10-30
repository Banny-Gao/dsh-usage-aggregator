// src/client/features/theme/prefs.js
// 运行时偏好（唯一真源）。
//
// apply() 整个页面只跑一次，面板却每点开一次就重新 mount。所以偏好必须住在
// 模块级单例里，由覆盖层与面板共同订阅 —— 把「apply 时读到的值」当快照传进
// 面板，重开设置就会把用户刚选的颜色打回旧值。

import { DEFAULT_BRAND, normalizeBrand } from './brand.js';
import { DEFAULT_FLAGS, DEFAULT_PRIMARY, LS_BRAND, LS_FLAGS, LS_PRIMARY } from './constants.js';
import { useEffect, useState } from '../../runtime.js';
import { normalizeFlags, normalizePrimary, readStored, writeStored } from './storage.js';


/* ─────────────────── 运行时偏好（唯一真源） ───────────────────── */
/**
 * 面板每点开一次就会重新 mount，而 apply() 整个页面只跑一次。
 * 若把「加载时读到的偏好」当快照传给面板，重新挂载就会用旧值把用户刚改的
 * 颜色冲掉（表现为：重开设置，主题被打回上一次的颜色）。
 * 因此偏好只存在这个模块级单例里，覆盖层与面板都从它读、往它写。
 */
export let prefs = null;

const prefsListeners = [];


export function getPrefs() {
  if (prefs === null) {
    prefs = {
      primary: normalizePrimary(readStored(LS_PRIMARY), DEFAULT_PRIMARY),
      flags: normalizeFlags(readStored(LS_FLAGS), DEFAULT_FLAGS),
      brand: normalizeBrand(readStored(LS_BRAND), DEFAULT_BRAND)
    };
  }
  return prefs;
}


function notifyPrefs() {
  // 先快照再遍历：订阅者在回调里退订是很常见的操作
  var list = prefsListeners.slice();
  for (var i = 0; i < list.length; i += 1) {
    try { list[i](); } catch (err) { /* 单个订阅者出错不该拖垮其他 */ }
  }
}


/**
 * 每次写入都**换一个新对象**再广播：React 用引用比较判断 state 变化，
 * 原地改字段会让 setState(getPrefs()) 直接 bail out，界面不更新。
 */
export function setPrefs(patch) {
  var current = getPrefs();
  var next = {
    primary: patch.primary !== undefined ? patch.primary : current.primary,
    flags: patch.flags !== undefined ? patch.flags : current.flags,
    brand: patch.brand !== undefined ? patch.brand : current.brand
  };
  prefs = next;
  if (patch.primary !== undefined) writeStored(LS_PRIMARY, next.primary);
  if (patch.flags !== undefined) writeStored(LS_FLAGS, next.flags);
  if (patch.brand !== undefined) writeStored(LS_BRAND, next.brand);
  notifyPrefs();
}


export function subscribePrefs(listener) {
  prefsListeners.push(listener);
  return function () {
    var i = prefsListeners.indexOf(listener);
    if (i >= 0) prefsListeners.splice(i, 1);
  };
}


/** 订阅运行时偏好：任一字段变化都会重渲染（logo / 文案改完立刻生效靠它）。 */
export function usePrefs() {
  var state = useState(getPrefs);
  var setState = state[1];
  useEffect(function () {
    return subscribePrefs(function () { setState(getPrefs()); });
  }, []);
  return state[0];
}
