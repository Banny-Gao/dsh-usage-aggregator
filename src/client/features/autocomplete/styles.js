// src/client/features/autocomplete/styles.js
//
// 自动补全的样式。
//
// 只用 --dsw-alias-* 主题 token —— 浅色/深色两边都跟着宿主走，不写死颜色。
//
// ⚠️ 样式随组件渲染（每个挂了样式的组件自带一份 <Styles/>），不往 document.head 里塞。

import { h } from '../../runtime.js';

const CSS = [
  // ── 浮层根（在输入框卡片里）：只放行内灰字，绝对定位，不占布局 ──────────
  '.dsh-ac-root{position:absolute;left:0;right:0;top:0;height:0;}',
  // ── 行内灰字：跟在光标后面的待补全片段 ────────────────────────────────
  '.dsh-ac-ghost{position:absolute;white-space:pre;pointer-events:none;color:var(--dsw-alias-label-tertiary);z-index:1;}',
  // ── 提示条 + 下拉卡片：都在 dock 槽（正常文档流，紧贴输入框）───────────
  // 外层只负责「给绝对定位的下拉卡片一个坐标系」，宽度与输入框卡片对齐。
  '.dsh-ac-wrap{position:relative;width:100%;max-width:var(--dsh-composer-card-max-width);margin:0 auto;}',
  // 下拉卡片挂在提示条**头顶**：`bottom:100%` 由布局决定位置，
  // 不用量坐标 —— 原来挂在 overlay 的 height:0 锚点上，只能算着往上推，
  // 结果卡片飘在半空、离输入框隔着一整个卡片高。
  '.dsh-ac-menu{position:absolute;left:0;right:0;bottom:calc(100% + 6px);box-sizing:border-box;display:flex;flex-direction:column;gap:2px;padding:6px;border-radius:10px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 8px 24px rgba(0,0,0,.18);max-height:min(320px,50vh);overflow-y:auto;z-index:20;}',
  '.dsh-ac-menu-head{display:flex;align-items:center;gap:10px;padding:2px 2px 6px 6px;}',
  '.dsh-ac-menu-title{flex:0 0 auto;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);}',
  '.dsh-ac-menu-hint{flex:1 1 auto;min-width:0;font-size:10px;color:var(--dsw-alias-label-tertiary);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  // 关闭按钮在卡片里（用户要的位置）：看到卡片、想关掉的那一刻，手就在卡片上。
  '.dsh-ac-menu-close{flex:0 0 auto;width:18px;height:18px;padding:0;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;line-height:1;cursor:pointer;}',
  '.dsh-ac-menu-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
  '.dsh-ac-row{display:flex;align-items:flex-start;gap:8px;width:100%;text-align:left;padding:6px 8px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.5;cursor:pointer;}',
  '.dsh-ac-row:hover{background:var(--dsw-alias-interactive-bg-hover);}',
  '.dsh-ac-row.is-on{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-brand-primary);}',
  '.dsh-ac-row-index{flex:0 0 auto;min-width:16px;height:16px;margin-top:1px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:16px;text-align:center;}',
  '.dsh-ac-row-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;}',
  // ── 输入框上方的提示条 ────────────────────────────────────────────────
  '.dsh-ac-bar{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:3px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);}',
  '.dsh-ac-badge{flex:0 0 auto;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-size:10px;font-weight:600;letter-spacing:.02em;}',
  // 建议文字吃掉剩余空间：「Tab 补全」与「更多」因此被推到行尾（右侧）。
  // 文字过长就省略号 —— 撑破布局比截断难看得多。
  '.dsh-ac-bar-text{flex:1 1 auto;min-width:0;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.dsh-ac-bar-text:hover{color:var(--dsw-alias-brand-primary);}',
  '.dsh-ac-bar-hint{flex:0 0 auto;margin-left:4px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}',
  '.dsh-ac-bar-more{flex:0 0 auto;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;}',
  '.dsh-ac-bar-more:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
  // ── 设置页 ────────────────────────────────────────────────────────────
  '.dsh-ac-page{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary);}',
  '.dsh-ac-intro{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);max-width:76ch;}',
  '.dsh-ac-card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);}',
  '.dsh-ac-card-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}',
  '.dsh-ac-field{display:flex;align-items:flex-start;justify-content:space-between;gap:12px 16px;flex-wrap:wrap;}',
  '.dsh-ac-field-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}',
  '.dsh-ac-label{font-size:12px;font-weight:500;}',
  '.dsh-ac-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);}',
  '.dsh-ac-control{flex:0 0 auto;display:flex;align-items:center;gap:8px;}',
  '.dsh-ac-number{width:76px;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;}',
  '.dsh-ac-check{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;}',
  '.dsh-ac-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;}',
  '.dsh-ac-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
  '.dsh-ac-btn.is-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);}',
  '.dsh-ac-btn.is-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}',
  '.dsh-ac-btn:disabled{opacity:.5;cursor:not-allowed;}',
  '.dsh-ac-msg{font-size:12px;color:var(--dsw-alias-label-secondary);}',
  '.dsh-ac-msg.is-error{color:var(--dsw-alias-state-error-primary);}',
  '.dsh-ac-msg.is-ok{color:var(--dsw-alias-state-success-primary);}',
  '.dsh-ac-foot{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary);}',
].join('\n');

/**
 * 样式组件。
 *
 * @returns {object} React 元素。
 */
export function Styles() {
  return h('style', { 'data-dsh-usage-aggregator': 'autocomplete', dangerouslySetInnerHTML: { __html: CSS } });
}
