// src/client/features/autocomplete/overlay.js
//
// 输入框里的补全界面：下拉列表 + 行内灰字 + Tab 采纳。
//
// 落点（都在官方槽位里，不改别人的节点）：
//   · 下拉列表与灰字都挂在 conversation.input.overlay —— 官方 `/`、`@` 菜单
//     就走这里，它本来就是「浮在输入框卡片里的一层」。
//   · 官方 placeholder 由 ui-conversation 拥有（[data-composer-placeholder]），
//     插件不去改它 —— 所以「空输入时的占位提示」做成浮层里的一行提示。
//
// 三处交互细节：
//   1. Tab 只在「我们有建议 + 官方菜单没开 + 没有 IME 组合」时接管；
//      Shift+Tab 永不接管（留给焦点遍历）。
//   2. 采纳走官方的 inputActions（captureInsertion + insertText）——
//      编辑器（Lexical）持有草稿，直接改 DOM 会被它下一次更新抹掉。
//   3. 灰字是**定位叠加**：量光标的位置画在自己那一层，不往编辑器里插节点
//      （编辑器会跟 DOM 打架）。

import { h, useEffect, useRef, useState } from '../../runtime.js';
import { completionSuffix, moveIndex } from './complete.js';
import { noInput, useAutocompleteEngine } from './engine.js';
import { acceptSuggestion, setState } from './store.js';
import { Styles } from './styles.js';

/**
 * 量出光标的位置。
/**
 * 量出「光标后面该从哪儿开始画灰字」。
 *
 * ⚠️ 为什么不用折叠光标的矩形：`range.getBoundingClientRect()` 对一个折叠
 * 选区（光标）返回的是**光标矩形**，它未必等于字形框 —— 实测比字形高出一截，
 * 灰字就会跟输入的文字错行（截图里那次的错位就是这么来的）。
 *
 * 所以优先量**光标前一个字符的字形矩形**：它的 right 就是光标 x，它的
 * top / height 就是这一行字真正占据的上下边界。量不到（光标在行首、或选区
 * 跨节点）再退回光标矩形。
 *
 * @param {Element} editor 编辑器（contenteditable）。
 * @returns {{left: number, top: number, height: number}|null} 位置；量不到就是 null。
 */
function caretAnchor(editor) {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const container = range.startContainer;
  if (container === null || container === undefined) return null;
  if (typeof Node !== 'undefined' && !(container instanceof Node)) return null;
  if (!editor.contains(container)) return null;

  const collapsed = range.getBoundingClientRect();

  // ① 光标前一个字符的字形框（最准）。
  if (container.nodeType === 3 && range.startOffset > 0) {
    try {
      const before = document.createRange();
      before.setStart(container, range.startOffset - 1);
      before.setEnd(container, range.startOffset);
      const rect = before.getBoundingClientRect();
      // 只有「跟光标同一行」时才算数：光标在行首时，前一个字符在上一行末尾。
      const sameLine = collapsed === null || collapsed === undefined || Math.abs(rect.top - collapsed.top) <= Math.max(rect.height, 1);
      if (rect.height > 0 && sameLine) {
        return { left: rect.right, top: rect.top, height: rect.height };
      }
    } catch {
      /* 跨节点选区会抛错，走下面的兜底 */
    }
  }

  // ② 折叠光标矩形（上下可能差一点，但位置对）。
  if (collapsed !== null && collapsed !== undefined && collapsed.height > 0) {
    return { left: collapsed.left, top: collapsed.top, height: collapsed.height };
  }
  const rects = range.getClientRects();
  if (rects !== null && rects !== undefined && rects.length > 0 && rects[0].height > 0) {
    return { left: rects[0].left, top: rects[0].top, height: rects[0].height };
  }
  return null;
}

/**
 * 输入框浮层：下拉列表 + 行内灰字 + 键盘接管。
 *
 * @param {{t: Function, sessionId: string, useInput: Function, inputActions: object, useChat?: Function}} props 属性。
 * @returns {object} React 元素。
 */
export function AutocompleteOverlay(props) {
  const t = props.t;
  const sessionId = props.sessionId;
  const inputActions = props.inputActions;
  // 输入状态是会话级的标准属性；万一不在，用占位顶上，别让插槽崩掉。
  const useInput = typeof props.useInput === 'function' ? props.useInput : noInput;

  const state = useAutocompleteEngine({
    sessionId: sessionId,
    useInput: useInput,
    useChat: props.useChat,
  });
  const input = useInput(function (snapshot) { return snapshot; });
  const draft = input !== null && input !== undefined && typeof input.draft === 'string' ? input.draft : '';

  const rootRef = useRef(null);
  const [ghost, setGhost] = useState(null);

  // 键盘处理要读「最新的」状态与草稿，但监听器只装一次 —— 用 ref 兜住最新值。
  const latestRef = useRef({ state: state, draft: draft, inputActions: inputActions });
  latestRef.current = { state: state, draft: draft, inputActions: inputActions };

  // 1. Tab / ↑↓ / Enter / Esc：装在 **document 的捕获阶段**。
  //
  //    为什么不用「挂在自己 DOM 附近的编辑器上」：浮层挂在
  //    [data-composer-overlay]（一个 height:0 的锚点）里，而编辑器是 Lexical
  //    自己管理的 contenteditable —— 两者的层级关系不是我们说了算的，而且在
  //    同一元素上，Lexical 的 keydown 先注册就会先跑。改成文档级捕获有两个好处：
  //      · 一定抢在编辑器和官方 keymap 之前拿到事件；
  //      · 只认「焦点真的在输入框里」这一件事（从 event.target 反查），
  //        不依赖我们自己被挂在哪儿。
  useEffect(function () {
    const onKeyDown = function (event) {
      const target = event.target;
      if (target === null || target === undefined || typeof target.closest !== 'function') return;
      const editor = target.closest('[data-composer-input]');
      if (editor === null) return;
      const card = editor.closest('[data-composer-card]');

      const latest = latestRef.current;
      const current = latest.state;
      if (current.settings === null || current.settings.enabled !== true) return;
      const suggestions = Array.isArray(current.suggestions) ? current.suggestions : [];
      if (suggestions.length === 0) return;
      // 官方 `/`、`@` 菜单开着（它自己带 data-trigger-menu）就让路 ——
      // 那个菜单的 Tab/Enter 是「选中菜单里的那一项」。
      if (card !== null && card.querySelector('[data-trigger-menu]') !== null) return;
      // IME 组合中不接管。
      if (event.isComposing === true) return;
      if (editor.hasAttribute('data-composer-composing')) return;

      if (event.key === 'Tab' && event.shiftKey !== true) {
        event.preventDefault();
        event.stopPropagation();
        acceptSuggestion(sessionId, latest.inputActions, latest.draft, current.activeIndex);
        return;
      }
      // 下面这几个只在列表展开时接管，免得抢走输入框正常的 ↑↓ 与 Esc。
      if (current.open !== true) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        setState(sessionId, { activeIndex: moveIndex(suggestions, current.activeIndex, 1) });
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        setState(sessionId, { activeIndex: moveIndex(suggestions, current.activeIndex, -1) });
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        acceptSuggestion(sessionId, latest.inputActions, latest.draft, current.activeIndex);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setState(sessionId, { open: false });
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return function () { document.removeEventListener('keydown', onKeyDown, true); };
  }, [sessionId]);

  // 2. 行内灰字：量光标位置，画在自己这一层（不往编辑器里插节点）。
  useEffect(function () {
    const settings = state.settings;
    if (settings === null || settings.inlineHint !== true) {
      setGhost(null);
      return;
    }
    const suggestion = Array.isArray(state.suggestions) ? state.suggestions[state.activeIndex] : undefined;
    const suffix = completionSuffix(draft, suggestion);
    if (suffix === '') {
      setGhost(null);
      return;
    }
    const root = rootRef.current;
    if (root === null) {
      setGhost(null);
      return;
    }
    const card = root.closest('[data-composer-card]');
    if (card === null) {
      setGhost(null);
      return;
    }
    const editor = card.querySelector('[data-composer-input]');
    if (editor === null) {
      setGhost(null);
      return;
    }
    const anchor = caretAnchor(editor);
    if (anchor === null) {
      setGhost(null);
      return;
    }
    const cardRect = card.getBoundingClientRect();
    const style = window.getComputedStyle(editor);
    // 灰字的盒子直接取「字形框」的高度并让 line-height 等于它 ——
    // 这样字在盒子里的垂直位置和输入框里的文字一致，不会错行。
    setGhost({
      left: anchor.left - cardRect.left,
      top: anchor.top - cardRect.top,
      height: anchor.height,
      text: suffix,
      fontSize: style.fontSize,
      fontFamily: style.fontFamily,
    });
  }, [draft, state.suggestions, state.activeIndex, state.settings]);

  // 这里只画**行内灰字**：它必须长在卡片里、贴着光标。
  // 下拉卡片在 dock 那一侧（见 dock.js 顶部为什么）。
  return h(
    'div',
    { className: 'dsh-ac-root', ref: rootRef },
    h(Styles, null),
    ghost !== null
      ? h('span', {
        className: 'dsh-ac-ghost',
        'aria-hidden': 'true',
        style: {
          left: ghost.left + 'px',
          top: ghost.top + 'px',
          height: ghost.height + 'px',
          fontSize: ghost.fontSize,
          // line-height 取字形框高度：字在盒子里居中，跟输入框那一行对齐。
          lineHeight: ghost.height + 'px',
          fontFamily: ghost.fontFamily,
        },
      }, ghost.text)
      : null
  );
}
