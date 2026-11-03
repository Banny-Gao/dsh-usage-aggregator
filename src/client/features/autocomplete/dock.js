// src/client/features/autocomplete/dock.js
//
// 输入框上方的提示条 + 「AI 建议」下拉卡片。
//
// 落点：conversation.input.dock —— 官方给它的定位是「composer card 上方的整行区」。
// 它是**正常文档流**里的一行，紧贴输入框卡片，所以：
//   · 卡片宽度跟着输入框卡片（不是整行宽）；
//   · 下拉卡片挂在它头顶（`bottom:100%`），间距自然贴着，不用量坐标。
//
// 为什么下拉卡片放在这里而不是 conversation.input.overlay：overlay 的锚点
// （[data-composer-overlay]）是卡片顶部一个 height:0 的盒子，离用户正在打字的
// 地方隔着整个卡片 —— 在那儿画「浮在上方」的卡片，只能靠量坐标往上推，
// 结果就是飘在半空、离输入框很远。放在 dock 里，位置由布局本身决定。
//
// overlay 那边只留下「行内灰字 + 键盘接管」——那两件事必须活在卡片里。
//
// ⚠️ 官方 placeholder 归 ui-conversation 所有，插件不去改它 ——
//    空输入时的「你可能想问」候选由候选本身表达，不再额外加一行提示语。

import { h } from '../../runtime.js';
import { noInput } from './engine.js';
import { acceptSuggestion, setState, useAutocompleteState } from './store.js';
import { Styles } from './styles.js';

/**
 * 输入框上方的提示条（含下拉卡片）。
 *
 * @param {{t: Function, sessionId: string, useInput: Function, inputActions: object}} props 属性。
 * @returns {object} React 元素（没有建议时是 null）。
 */
export function AutocompleteDock(props) {
  const t = props.t;
  const sessionId = props.sessionId;
  const state = useAutocompleteState(sessionId);
  // 输入状态是会话级的标准属性；万一不在，用占位顶上，别让插槽崩掉。
  const useInput = typeof props.useInput === 'function' ? props.useInput : noInput;
  const input = useInput(function (snapshot) { return snapshot; });
  const draft = input !== null && input !== undefined && typeof input.draft === 'string' ? input.draft : '';

  const suggestions = Array.isArray(state.suggestions) ? state.suggestions : [];
  if (state.settings === null || state.settings.enabled !== true || suggestions.length === 0) return null;

  const top = suggestions[state.activeIndex] !== undefined ? suggestions[state.activeIndex] : suggestions[0];
  const open = state.open === true;

  /**
   * 采纳某一条。
   *
   * @param {number} index 下标。
   */
  const pick = function (index) {
    acceptSuggestion(sessionId, props.inputActions, draft, index);
  };

  /**
   * 关掉这一次的候选：清掉候选、收起卡片。不动草稿，也不关功能。
   */
  const dismiss = function () {
    setState(sessionId, { suggestions: [], activeIndex: 0, open: false, status: 'idle' });
  };

  return h(
    'div',
    { className: 'dsh-ac-wrap' },
    h(Styles, null),

    // 下拉卡片挂在提示条头顶。关闭按钮在卡片里（这是用户要的位置）：
    // 看到卡片、想关掉的时刻，手就在卡片上。
    open
      ? h('div', { className: 'dsh-ac-menu', role: 'listbox', 'aria-label': t('dropdownTitle') },
        h('div', { className: 'dsh-ac-menu-head' },
          h('span', { className: 'dsh-ac-menu-title' }, t('dropdownTitle')),
          h('span', { className: 'dsh-ac-menu-hint' }, t('dropdownHint')),
          h('button', {
            type: 'button',
            className: 'dsh-ac-menu-close',
            title: t('close'),
            'aria-label': t('close'),
            onMouseDown: function (event) {
              event.preventDefault();
              dismiss();
            },
          }, '×')
        ),
        suggestions.map(function (text, index) {
          return h('button', {
            key: text + '#' + index,
            type: 'button',
            role: 'option',
            'aria-selected': index === state.activeIndex ? 'true' : 'false',
            className: 'dsh-ac-row' + (index === state.activeIndex ? ' is-on' : ''),
            // mousedown 而不是 click：不让编辑器先失焦，光标还在原处。
            onMouseDown: function (event) {
              event.preventDefault();
              pick(index);
            },
            onMouseEnter: function () { setState(sessionId, { activeIndex: index }); },
          },
          h('span', { className: 'dsh-ac-row-index' }, String(index + 1)),
          h('span', { className: 'dsh-ac-row-text' }, text));
        })
      )
      : null,

    h('div', { className: 'dsh-ac-bar' },
      h('span', { className: 'dsh-ac-badge' }, 'AI'),
      h('button', {
        type: 'button',
        className: 'dsh-ac-bar-text',
        title: top,
        onMouseDown: function (event) {
          event.preventDefault();
          pick(state.activeIndex);
        },
      }, top),
      // 控件紧跟建议：文字抢剩余空间会把它们顶到最右边，离建议隔着一整行。
      h('span', { className: 'dsh-ac-bar-hint' }, t('hintTab')),
      suggestions.length > 1
        ? h('button', {
          type: 'button',
          className: 'dsh-ac-bar-more',
          'aria-expanded': open ? 'true' : 'false',
          onMouseDown: function (event) {
            event.preventDefault();
            setState(sessionId, { open: !open });
          },
        }, t('hintMore'))
        : null
    )
  );
}
