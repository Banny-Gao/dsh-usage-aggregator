// src/client/features/autocomplete/engine.js
//
// 补全的触发循环：读设置 → 看草稿 → 停顿够了就问模型 → 把候选放进 store。
//
// 三条不能省的规矩：
//   1. **一次只留一个请求**。用户打字比模型快，留下的那个才是他要的；过期的
//      响应回来时序号对不上，直接丢掉。
//   2. **模型调用要花钱**。所以有防抖、有最短字数、有 Host 侧的缓存，
//      同一段草稿不会反复问。
//   3. **失败要安静**。Host 路由没起来、模型不可用，都只表现为「没有建议」，
//      绝不在用户打字时弹错误。

import { useEffect, useRef } from '../../runtime.js';
import { api } from './api.js';
import { contextFromChat } from './complete.js';
import { setState, useAutocompleteState } from './store.js';

/**
 * 没有 useChat 时的占位（保持 Hook 调用顺序稳定）。
 *
 * 与「电脑加速与清理」里 noSessions 同一个用法：Chat 视图不在时，插槽里
 * 拿不到对话快照，补全就只剩「看草稿」这一路。
 *
 * @param {Function} selector 选择器。
 * @returns {null} 永远没有对话。
 */
function noChat(selector) {
  return selector(null);
}

/**
 * 没有 useInput 时的占位（保持 Hook 调用顺序稳定）。
 *
 * 输入状态是会话级的标准属性，正常一定在。但插槽里少一个 Hook 就崩，
 * 崩了会把**整个输入框区域**清空 —— 那比「没有补全」严重得多，所以兜住。
 *
 * @param {Function} selector 选择器。
 * @returns {null} 永远没有输入状态。
 */
export function noInput(selector) {
  return selector(null);
}

/**
 * 补全引擎。
 *
 * @param {object} props 属性。
 * @param {string} props.sessionId 当前会话 id。
 * @param {Function} props.useInput 官方的输入状态选择器。
 * @param {Function} [props.useChat] 官方的对话快照选择器。
 * @returns {object} 当前状态（settings / suggestions / …）。
 */
export function useAutocompleteEngine(props) {
  const sessionId = props.sessionId;
  const state = useAutocompleteState(sessionId);
  const input = props.useInput(function (snapshot) { return snapshot; });
  const chat = (typeof props.useChat === 'function' ? props.useChat : noChat)(function (snapshot) { return snapshot; });

  const seqRef = useRef(0);
  const settings = state.settings;
  const draft = input !== null && input !== undefined && typeof input.draft === 'string' ? input.draft : '';
  const draftRev = input !== null && input !== undefined && typeof input.draftRev === 'number' ? input.draftRev : -1;
  const phase = input !== null && input !== undefined && typeof input.phase === 'string' ? input.phase : 'plain';

  // 1. 读一次设置。读不到（Host 半边还没重启）就当没这个功能。
  useEffect(function () {
    let alive = true;
    api.settings().then(function (result) {
      if (!alive) return;
      const loaded = result !== null && typeof result === 'object' && result.settings !== null && typeof result.settings === 'object'
        ? result.settings
        : null;
      setState(sessionId, { settings: loaded });
    }).catch(function () {
      // Host 路由不可用 —— 补全静默不工作，不打扰用户。
    });
    return function () { alive = false; };
  }, [sessionId]);

  // 2. 草稿（或上下文）变了 → 停顿够了就去问。
  useEffect(function () {
    if (settings === null || settings.enabled !== true) return undefined;
    // 官方输入机在裁决/提交/命令 chip 状态下不接受外部写入 —— 那时不给建议。
    if (phase !== 'plain') return undefined;

    const trimmed = draft.trim();
    if (trimmed === '') {
      // 空输入：给「你可能想问」的几条（用户可以在设置里关掉）。
      if (settings.placeholderHint !== true) return undefined;
    } else {
      if (trimmed.length < settings.minChars) {
        setState(sessionId, { suggestions: [], activeIndex: 0, status: 'idle', open: false });
        return undefined;
      }
      if (draft.includes('\n') && settings.allowMultiline !== true) return undefined;
    }

    const timer = window.setTimeout(function () {
      const seq = seqRef.current + 1;
      seqRef.current = seq;
      setState(sessionId, { status: 'thinking' });
      const context = contextFromChat(chat, settings.contextMessages);
      api.suggest({
        sessionId: sessionId,
        draft: draft,
        context: context,
        limit: settings.maxSuggestions,
      }).then(function (result) {
        if (seqRef.current !== seq) return;
        const list = result !== null && typeof result === 'object' && Array.isArray(result.suggestions) ? result.suggestions : [];
        setState(sessionId, {
          suggestions: list,
          activeIndex: 0,
          status: list.length > 0 ? 'ready' : 'idle',
          error: '',
        });
      }).catch(function () {
        if (seqRef.current !== seq) return;
        setState(sessionId, { suggestions: [], activeIndex: 0, status: 'idle' });
      });
    }, settings.debounceMs);

    return function () { window.clearTimeout(timer); };
  }, [sessionId, draft, draftRev, phase, settings, chat]);

  return state;
}
