// src/client/features/dingtalk/styles.js
//
// 「钉钉沙发」的样式。
//
// 这套样式是**照宿主抄的**，不是自己发明的：
//   · 卡片外框、标题、正文、折叠按钮 → 宿主的卡片框架（dsh-client-ui-action-cards）
//     已经画好（16px 标题 / 13px 次级正文 / 发丝级描边 / --dsw-radius-lg 圆角），
//     我们只负责往里放内容；
//   · 按钮 → 宿主 Button 原语的形状（无边框、28px 高、--dsw-radius-sm、size=sm）；
//   · 输入框 → 宿主 Input 原语的形状（34px 高、.5px 描边、--dsw-alias-bg-layer-3）。
// 只用 --dsw-alias-* 与 --dsw-radius-* 主题 token —— 浅色/深色两边都跟着宿主走。
//
// ⚠️ 样式随组件渲染（卡片与设置页各带一份 <Styles/>），不往 document.head 里塞。

import { h } from '../../runtime.js';

const CSS = [
  // ── 卡片正文（挂在宿主的卡片框架里）────────────────────────────────────
  '.dsh-dt-root{display:flex;flex-direction:column;}',
  // 顶部条：跟宿主「插件推荐」卡片一样，是一条低对比度的标题带。
  '.dsh-dt-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 20px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;}',
  '.dsh-dt-badge{flex:0 0 auto;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;}',
  '.dsh-dt-badge.is-ok{color:var(--dsw-alias-state-success-primary);}',
  '.dsh-dt-badge.is-warn{color:var(--dsw-alias-state-warn-primary);}',
  '.dsh-dt-badge.is-error{color:var(--dsw-alias-state-error-primary);}',
  '.dsh-dt-body{display:flex;flex-direction:column;gap:12px;padding:16px 20px 20px;}',
  // 收件人 / 为什么发他：一块软底，信息成组。
  '.dsh-dt-meta{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0;padding:10px 12px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);}',
  '.dsh-dt-meta dt{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}',
  '.dsh-dt-meta dd{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}',
  '.dsh-dt-idhint{color:var(--dsw-alias-label-tertiary);font-size:12px;}',
  '.dsh-dt-section-label{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary);}',
  '.dsh-dt-tag{margin-left:6px;padding:0 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;}',
  '.dsh-dt-label{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary);}',
  // 拟好的正文：软底一块，可滚动。
  '.dsh-dt-content{padding:12px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);font-size:13px;line-height:1.7;max-height:280px;overflow-y:auto;}',
  // 同名候选：一行一个，点一个就是「发给这个人」。
  '.dsh-dt-candidates{display:flex;flex-direction:column;gap:6px;}',
  '.dsh-dt-candidates-title{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary);}',
  '.dsh-dt-candidate{box-sizing:border-box;width:100%;text-align:left;padding:8px 10px;border:none;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;cursor:pointer;}',
  '.dsh-dt-candidate:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
  '.dsh-dt-candidate:disabled{opacity:.4;cursor:not-allowed;}',
  '.dsh-dt-status{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
  '.dsh-dt-status.is-ok{color:var(--dsw-alias-state-success-primary);}',
  '.dsh-dt-status.is-warn{color:var(--dsw-alias-state-warn-primary);}',
  '.dsh-dt-status.is-error{color:var(--dsw-alias-state-error-primary);}',
  '.dsh-dt-status.is-info{color:var(--dsw-alias-state-info-primary);}',
  '.dsh-dt-status.is-muted{color:var(--dsw-alias-label-tertiary);}',
  // 底部动作条：发丝级分隔线，右侧是按钮。
  '.dsh-dt-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:16px;padding:16px 20px;border-top:.5px solid var(--dsw-alias-border-l1);}',
  '.dsh-dt-input{flex:1 1 220px;min-width:0;box-sizing:border-box;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);}',
  '.dsh-dt-input::placeholder{color:var(--dsw-alias-label-tertiary);}',
  '.dsh-dt-actions{display:flex;align-items:center;gap:8px;margin-left:auto;}',
  // 按钮：宿主 Button 原语的形状（size=sm）。
  '.dsh-dt-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;}',
  '.dsh-dt-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
  '.dsh-dt-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active);}',
  '.dsh-dt-btn:disabled{opacity:.4;cursor:not-allowed;}',
  '.dsh-dt-btn.is-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);}',
  '.dsh-dt-btn.is-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}',
  '.dsh-dt-btn:focus-visible,.dsh-dt-input:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));}',

  // ── 设置页签 ──────────────────────────────────────────────────────────
  '.dsh-dt-page{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary);}',
  '.dsh-dt-intro{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);max-width:76ch;}',
  '.dsh-dt-card-box{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);}',
  '.dsh-dt-card-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}',
  '.dsh-dt-field{display:flex;align-items:flex-start;justify-content:space-between;gap:12px 16px;flex-wrap:wrap;}',
  '.dsh-dt-field-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}',
  '.dsh-dt-label{font-size:12px;font-weight:500;}',
  '.dsh-dt-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);}',
  '.dsh-dt-control{flex:0 0 auto;display:flex;align-items:center;gap:8px;}',
  '.dsh-dt-number{box-sizing:border-box;width:92px;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;}',
  '.dsh-dt-check{width:15px;height:15px;accent-color:var(--dsw-alias-button-primary-fill);cursor:pointer;}',
  '.dsh-dt-msg{font-size:12px;color:var(--dsw-alias-label-secondary);}',
  '.dsh-dt-msg.is-error{color:var(--dsw-alias-state-error-primary);}',
  '.dsh-dt-msg.is-ok{color:var(--dsw-alias-state-success-primary);}',
  '.dsh-dt-msg.is-warn{color:var(--dsw-alias-state-warn-primary);}',
  '.dsh-dt-foot-note{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary);}',

  // ── 悬浮栏里的钉钉入口（待处理清单）────────────────────────────────────
  // 入口按钮与面板外壳由悬浮栏统一（src/client/shared/dock-style.js），
  // 这里只管这个入口自己的样子：闪烁的光晕、清单里的排版。
  // 有新消息时呼吸式闪：只动光晕，不动位置 —— 常驻但不影响页面。
  '.dsh-dt-badge-blinking{animation:dsh-dt-badge-pulse 1.8s ease-in-out infinite;}',
  '@keyframes dsh-dt-badge-pulse{0%,100%{box-shadow:0 0 0 0 rgba(47,111,237,.45);}50%{box-shadow:0 0 0 8px rgba(47,111,237,0);}}',
  '.dsh-dt-badge-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
  '.dsh-dt-badge-title{font-size:12px;font-weight:600;}',
  '.dsh-dt-badge-close{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px;}',
  '.dsh-dt-badge-list{display:flex;flex-direction:column;gap:8px;padding:10px 12px;overflow-y:auto;}',
  '.dsh-dt-badge-item{display:flex;flex-wrap:wrap;gap:8px;padding:10px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);}',
  '.dsh-dt-badge-item-main{flex:1 1 240px;min-width:0;display:flex;flex-direction:column;gap:4px;}',
  '.dsh-dt-badge-item-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:12px;}',
  '.dsh-dt-badge-at{padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:10px;}',
  '.dsh-dt-badge-chat{color:var(--dsw-alias-label-secondary);}',
  '.dsh-dt-badge-time{color:var(--dsw-alias-label-tertiary);font-size:11px;}',
  '.dsh-dt-badge-excerpt{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
  '.dsh-dt-badge-routed{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary);}',
  '.dsh-dt-badge-actions{display:flex;align-items:center;gap:6px;margin-left:auto;}',
  '.dsh-dt-badge-choice{display:flex;align-items:center;gap:6px;flex:1 1 100%;padding-top:4px;border-top:1px dashed var(--dsw-alias-border-l1);}',
  '.dsh-dt-badge-btn{height:26px;padding:0 10px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;}',
  '.dsh-dt-badge-btn.is-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent;}',
  '.dsh-dt-badge-btn:disabled{opacity:.5;cursor:not-allowed;}',
  '.dsh-dt-badge-empty{margin:0;padding:16px 14px;font-size:12px;color:var(--dsw-alias-label-tertiary);}',
  '.dsh-dt-badge-note{margin:0;padding:8px 14px 12px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
].join('\n');

/**
 * 样式组件。
 *
 * @returns {object} React 元素。
 */
export function Styles() {
  return h('style', { 'data-dsh-usage-aggregator': 'dingtalk', dangerouslySetInnerHTML: { __html: CSS } });
}
