// src/client/hub/styles.js
//
// 聚合设置页的样式。
//
// 只用 --dsw-alias-* 主题 token（不写死颜色），浅色/深色两边都跟着宿主走。
// 样式随组件渲染、卸载时一起消失（不往 document.head 里塞）。

import { h } from '../runtime.js';

export const CSS = `
.dua-hub{display:flex;flex-direction:column;gap:14px;min-width:0;}
.dua-hub-tabs{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
.dua-hub-tab{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:1;padding:7px 12px;border-radius:999px;cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease;}
.dua-hub-tab:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);}
.dua-hub-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
.dua-hub-tab-active{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary-invert);}
.dua-hub-body{min-width:0;}
.dua-hub-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0;}
`;

/**
 * 样式组件：把 CSS 渲染成一个 <style>，随组件树卸载。
 *
 * @returns {object} React 元素。
 */
export function Styles() {
  return h('style', { dangerouslySetInnerHTML: { __html: CSS } });
}
