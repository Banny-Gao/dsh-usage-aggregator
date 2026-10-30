// src/client/features/boost/styles.js
//
// 小火箭与清单面板的样式。
//
// 只用 --dsw-alias-* 主题 token，所以浅色 / 深色两边都跟着宿主走
// （照 cordis-plugin-development 的 UI 约定）。
//
// 样式随组件渲染，卸载时一起消失 —— 不往 document.head 里塞。

import { h } from '../../runtime.js';

/** 样式表正文。 */
export const CSS = [
  // ── 浮层容器 ────────────────────────────────────────────────
  // shell.overlay 这一层本身是 click-through 的（点不中的），
  // 所以这里必须显式把指针事件要回来，否则按钮点不动。
  // 默认停在内容区域右下角；用户拖过之后由内联样式接管（left/top + right/bottom:auto）。
  '.dsh-boost{position:fixed;right:24px;bottom:24px;z-index:2147483000;pointer-events:auto;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary);}',

  // ── 发射按钮 ────────────────────────────────────────────────
  '.dsh-boost-launch{position:relative;display:flex;align-items:center;justify-content:center;width:48px;height:48px;padding:0;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:grab;box-shadow:0 6px 18px rgba(0,0,0,.18);transition:transform .15s ease,box-shadow .15s ease,background .15s ease;user-select:none;touch-action:none;-webkit-user-select:none;}',
  '.dsh-boost-launch:hover{background:var(--dsw-alias-interactive-bg-hover);box-shadow:0 8px 22px rgba(0,0,0,.24);}',
  '.dsh-boost-launch:active{cursor:grabbing;}',
  '.dsh-boost-launch.is-dragging{cursor:grabbing;transform:scale(1.06);box-shadow:0 10px 26px rgba(0,0,0,.28);}',
  '.dsh-boost-launch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
  '.dsh-boost-launch svg{width:26px;height:26px;display:block;pointer-events:none;}',

  // 拖动时的落点提示
  '.dsh-boost.is-dragging .dsh-boost-launch{border-color:var(--dsw-alias-brand-primary);}',

  // ── 发射动画 ────────────────────────────────────────────────
  '@keyframes dsh-boost-rise{0%{transform:translateY(0) scale(1);opacity:1;}18%{transform:translateY(4px) scale(.92);opacity:1;}100%{transform:translateY(-220px) scale(.55);opacity:0;}}',
  '.dsh-boost-launch.is-launching{animation:dsh-boost-rise .85s cubic-bezier(.28,.72,.35,1) forwards;pointer-events:none;}',
  '@keyframes dsh-boost-flame{0%,100%{transform:scaleY(1);opacity:.95;}50%{transform:scaleY(1.45) translateY(1px);opacity:.7;}}',
  '.dsh-boost-flame{transform-origin:center top;transform-box:fill-box;}',
  '.dsh-boost-launch.is-launching .dsh-boost-flame{animation:dsh-boost-flame .18s linear infinite;}',
  '@keyframes dsh-boost-land{from{transform:scale(.6);opacity:0;}to{transform:scale(1);opacity:1;}}',
  '.dsh-boost-launch.is-landing{animation:dsh-boost-land .28s ease-out;}',
  '@keyframes dsh-boost-smoke{0%{transform:translate(0,0) scale(.4);opacity:.55;}100%{transform:translate(-6px,16px) scale(1.5);opacity:0;}}',
  '.dsh-boost-smoke{opacity:0;}',
  '.dsh-boost-launch.is-launching .dsh-boost-smoke{animation:dsh-boost-smoke .7s ease-out infinite;}',

  // ── 清单面板 ────────────────────────────────────────────────
  '.dsh-boost-panel{position:absolute;bottom:calc(100% + 12px);right:0;width:min(420px,calc(100vw - 32px));max-height:min(72vh,620px);display:flex;flex-direction:column;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-shadow:0 16px 44px rgba(0,0,0,.26);overflow:hidden;}',
  // 按钮被拖到屏幕上方时，面板改挂在下面，不然会顶出屏幕外。
  '.dsh-boost.is-high .dsh-boost-panel{bottom:auto;top:calc(100% + 12px);}',
  '.dsh-boost-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
  '.dsh-boost-title{margin:0;font-size:15px;font-weight:600;}',
  '.dsh-boost-sub{margin:3px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary);}',
  '.dsh-boost-close{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px;}',
  '.dsh-boost-close:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);}',

  '.dsh-boost-body{flex:1 1 auto;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px;}',

  // 诊断块
  '.dsh-boost-diag{border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);padding:10px 12px;display:flex;flex-direction:column;gap:6px;}',
  '.dsh-boost-diag-title{font-size:11px;color:var(--dsw-alias-label-secondary);text-transform:none;}',
  '.dsh-boost-diag-main{font-size:13px;font-weight:600;}',
  '.dsh-boost-diag-list{margin:0;padding-left:16px;font-size:12px;color:var(--dsw-alias-label-secondary);}',
  '.dsh-boost-diag-warn{font-size:12px;color:var(--dsw-alias-state-warn-primary);}',

  // 清单
  '.dsh-boost-list{display:flex;flex-direction:column;gap:6px;}',
  '.dsh-boost-group{margin-top:10px;}',
  '.dsh-boost-group:first-child{margin-top:0;}',
  '.dsh-boost-group-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.04em;padding:6px 2px 2px;}',
  '.dsh-boost-item{display:flex;align-items:flex-start;gap:9px;padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);cursor:pointer;}',
  '.dsh-boost-item:hover{background:var(--dsw-alias-interactive-bg-hover);}',
  '.dsh-boost-check{margin-top:2px;width:15px;height:15px;flex:0 0 auto;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;}',
  '.dsh-boost-item-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}',
  '.dsh-boost-item-name{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
  '.dsh-boost-item-size{font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary);font-weight:600;}',
  '.dsh-boost-item-meta{font-size:11px;color:var(--dsw-alias-label-secondary);}',
  '.dsh-boost-item-note{font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
  '.dsh-boost-tag{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;font-size:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
  '.dsh-boost-tag.is-danger{background:rgba(180,35,24,.12);color:var(--dsw-alias-state-error-primary,#b42318);}',
  '.dsh-boost-tag.is-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent);color:var(--dsw-alias-state-warn-primary);}',

  // 底栏
  '.dsh-boost-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary);}',
  '.dsh-boost-foot-actions{display:flex;align-items:center;gap:8px;}',
  '.dsh-boost-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;}',
  '.dsh-boost-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
  '.dsh-boost-btn.is-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);}',
  '.dsh-boost-btn.is-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}',
  '.dsh-boost-btn:disabled{opacity:.5;cursor:not-allowed;}',
  '.dsh-boost-btn.is-quiet{border-color:transparent;color:var(--dsw-alias-label-secondary);}',

  '.dsh-boost-msg{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);}',
  '.dsh-boost-msg.is-error{color:var(--dsw-alias-state-error-primary);}',
  '.dsh-boost-msg.is-ok{color:var(--dsw-alias-state-success-primary);}',
  '.dsh-boost-empty{padding:14px 4px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:4px;}',

  // ── 聚合设置页里的视图 ──────────────────────────────────────
  '.dsh-boost-hub{display:flex;flex-direction:column;gap:14px;}',
  '.dsh-boost-hub-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}',
].join('\n');

/**
 * 样式组件。
 *
 * @returns {object} React 元素。
 */
export function Styles() {
  // h 在模块顶层不可用（runtime 要等 factory 跑完），所以这里用全局 React
  // 的 createElement —— 由 runtime.js 在装配时注入。
  return h('style', { 'data-dsh-boost': 'dsh-boost-style', dangerouslySetInnerHTML: { __html: CSS } });
}
