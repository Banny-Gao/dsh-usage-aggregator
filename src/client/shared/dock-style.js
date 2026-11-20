// src/client/shared/dock-style.js
//
// 悬浮栏（dock）的样式。
//
// 只用 --dsw-alias-* 主题 token —— 浅色 / 深色两边都跟着宿主走。
// 样式随组件渲染，卸载时一起消失 —— 不往 document.head 里塞。

import { h } from '../runtime.js';

/** 样式表正文。 */
export const CSS = [
  // ── 栏本体 ────────────────────────────────────────────────────────
  // shell.overlay 这一层本身是 click-through 的（点不中的），
  // 所以这里必须显式把指针事件要回来，否则按钮点不动。
  // 默认停在右下角；用户拖过之后由内联样式接管（left/top + right/bottom:auto）。
  '.dsh-dock{position:fixed;right:24px;bottom:24px;z-index:2147483000;pointer-events:auto;}',

  // 一条窄窄的胶囊：竖排几个入口，圆角收口，看起来像「工具条」而不是几个散落的按钮。
  '.dsh-dock-rail{display:flex;flex-direction:column;align-items:center;gap:2px;padding:5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px rgba(0,0,0,.18);transition:box-shadow .15s ease;}',
  '.dsh-dock.is-dragging .dsh-dock-rail{box-shadow:0 12px 30px rgba(0,0,0,.26);}',

  // 每个条目：面板从这里向左展开（相对本条目定位）。
  '.dsh-dock-item{position:relative;display:flex;}',

  // ── 入口按钮 ──────────────────────────────────────────────────────
  '.dsh-dock-btn{position:relative;display:flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border-radius:50%;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;transition:background .15s ease,transform .15s ease,box-shadow .15s ease;user-select:none;touch-action:none;-webkit-user-select:none;}',
  '.dsh-dock-btn:hover{background:var(--dsw-alias-interactive-bg-hover);transform:translateY(-1px);}',
  '.dsh-dock-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
  '.dsh-dock-btn.is-open{background:var(--dsw-alias-bg-layer-2);}',
  '.dsh-dock-btn svg{width:19px;height:19px;display:block;pointer-events:none;}',

  // 角标（待处理条数）：贴在图标右上角，不撑大按钮。
  '.dsh-dock-count{position:absolute;top:-2px;right:-3px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-state-error-primary,#b42318);color:#fff;font-size:10px;line-height:16px;text-align:center;pointer-events:none;}',

  // ── 面板 ──────────────────────────────────────────────────────────
  // 栏在右边，面板一律向左展开（再往右就出屏了）。
  '.dsh-dock-panel{position:absolute;right:calc(100% + 10px);bottom:0;width:min(400px,calc(100vw - 32px));max-height:min(72vh,600px);display:flex;flex-direction:column;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-shadow:0 16px 44px rgba(0,0,0,.26);overflow:hidden;}',
  // 栏被拖到屏幕上方时，面板改挂在下面，不然会顶出屏幕外。
  '.dsh-dock.is-high .dsh-dock-panel{bottom:auto;top:0;}',
].join('\n');

/**
 * 样式组件。
 *
 * @returns {object} React 元素。
 */
export function DockStyles() {
  return h('style', { 'data-dsh-usage-aggregator': 'dock', dangerouslySetInnerHTML: { __html: CSS } });
}
