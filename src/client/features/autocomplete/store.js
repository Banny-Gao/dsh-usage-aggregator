// src/client/features/autocomplete/store.js
//
// 每个会话一份的补全状态（提示条与下拉列表共用）。
//
// 为什么不用组件自己的 state：提示条（conversation.input.dock）与下拉列表
// （conversation.input.overlay）是**两个槽位、两个组件**，但它们要显示同一批
// 候选、同一个高亮项。所以状态放在这里，按 sessionId 分开 —— 换会话不串。
//
// 为什么按会话分：候选是「这个会话、这个输入框」的事。上一个会话的候选留在
// 屏幕上只会误导人。

import { useEffect, useState } from '../../runtime.js';
import { completionSuffix } from './complete.js';

/**
 * 新会话的初始状态。
 *
 * @returns {object} 状态。
 */
function createState() {
  return {
    /** Host 给的生效设置（null = 还没读到）。 */
    settings: null,
    /** 候选列表。 */
    suggestions: [],
    /** 当前高亮的候选下标。 */
    activeIndex: 0,
    /** idle / thinking / ready。 */
    status: 'idle',
    /** 下拉列表是否展开。 */
    open: false,
    /** 上次出错的原因（空串 = 没有错）。 */
    error: '',
  };
}

/** sessionId → { state, listeners }。 */
const sessions = new Map();

/**
 * 取某个会话的状态条目（没有就建一个）。
 *
 * @param {string} sessionId 会话 id。
 * @returns {{state: object, listeners: Set<Function>}} 条目。
 */
function entryOf(sessionId) {
  const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : '__none__';
  let item = sessions.get(key);
  if (item === undefined) {
    item = { state: createState(), listeners: new Set() };
    sessions.set(key, item);
  }
  return item;
}

/**
 * 读某个会话的状态。
 *
 * @param {string} sessionId 会话 id。
 * @returns {object} 状态。
 */
export function getState(sessionId) {
  return entryOf(sessionId).state;
}

/**
 * 改某个会话的状态并通知订阅者。
 *
 * @param {string} sessionId 会话 id。
 * @param {object} patch 要改的字段。
 */
export function setState(sessionId, patch) {
  const item = entryOf(sessionId);
  item.state = { ...item.state, ...patch };
  for (const listener of Array.from(item.listeners)) {
    try {
      listener();
    } catch {
      /* 某个订阅者坏了不能连累别人 */
    }
  }
}

/**
 * 订阅某个会话的状态（组件用）。
 *
 * @param {string} sessionId 会话 id。
 * @returns {object} 当前状态。
 */
export function useAutocompleteState(sessionId) {
  const [, bump] = useState(0);
  useEffect(function () {
    const item = entryOf(sessionId);
    const listener = function () { bump(function (n) { return n + 1; }); };
    item.listeners.add(listener);
    return function () { item.listeners.delete(listener); };
  }, [sessionId]);
  return getState(sessionId);
}

/**
 * 采纳一条候选。
 *
 * 采纳的写法必须走官方的输入动作（inputActions），不能直接改 DOM ——
 * 编辑器（Lexical）持有草稿，直接改 DOM 会被它下一次更新抹掉。
 *
 * 有重叠时只插「重叠之后的那一段」；没有重叠说明候选与用户写的不是同一条
 * 句子，这时整句替换草稿（用户是明确点了这条候选）。
 *
 * @param {string} sessionId 会话 id。
 * @param {object|null} inputActions 官方的输入动作。
 * @param {string} draft 当前草稿。
 * @param {number} index 候选下标。
 * @returns {boolean} 是否采纳成功。
 */
export function acceptSuggestion(sessionId, inputActions, draft, index) {
  const state = getState(sessionId);
  const suggestion = Array.isArray(state.suggestions) ? state.suggestions[index] : undefined;
  if (typeof suggestion !== 'string' || suggestion.trim() === '') return false;
  if (inputActions === null || inputActions === undefined) return false;

  const suffix = completionSuffix(draft, suggestion);
  let applied = false;
  if (suffix !== '' && typeof inputActions.captureInsertion === 'function' && typeof inputActions.insertText === 'function') {
    const span = inputActions.captureInsertion();
    if (span !== undefined && span !== null) {
      // 草稿在这期间被改过时 insertText 会拒绝 —— 那就什么都不做，
      // 硬塞整句会把用户刚敲的字冲掉。
      applied = inputActions.insertText(suffix, span) === true;
    }
  }
  if (!applied && suffix === '' && typeof inputActions.setDraft === 'function') {
    inputActions.setDraft(suggestion);
    applied = true;
  }
  if (applied) {
    setState(sessionId, { suggestions: [], activeIndex: 0, open: false, status: 'idle' });
  }
  return applied;
}
