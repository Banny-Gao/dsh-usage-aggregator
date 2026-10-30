// src/client/features/usage/styles.js
//
// 样式（只用主题 token）（对应源插件的 13-styles.js）。
//
// ⚠️ CSS 一字未改：类名前缀 `duq-` 不变、只用 `--dsw-alias-*` token、
// 样式用 `data-` 属性而不是 `id`、**不进 document.head**。
// 迁移只做了两件事：把 `var CSS = [...]` 改成 `export const CSS = [...]`，
// 以及补上 h / React / STYLE_ID / Panel 的 import。

import { React, h } from '../../runtime.js';
import { STYLE_ID } from './constants.js';
import { Panel } from './panel.js';

export const CSS = [
  '.duq-root{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#111827);}',
  // 标题不参与横向压缩（nowrap），右侧动作区可换行 —— 否则窄一点就会把标题挤成竖排。
  '.duq-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;}',
  '.duq-headtext{flex:1 1 auto;min-width:0;}',
  '.duq-title{margin:0;font-size:16px;font-weight:600;white-space:nowrap;}',
  '.duq-sub{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);max-width:76ch;}',
  '.duq-head-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end;}',
  '.duq-model{font-size:11px;padding:3px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
  '.duq-model.is-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent);color:var(--dsw-alias-state-warn-primary);}',
  '.duq-model.is-off{opacity:.65;}',
  '.duq-model.is-action{cursor:pointer;}',
  '.duq-model.is-action:hover{background:var(--dsw-alias-interactive-bg-hover);}',
  // cascader：一个触发按钮 + 两列浮层（provider / model）
  '.duq-cascader{position:relative;display:inline-flex;}',
  '.duq-cascader-trigger{display:inline-flex;align-items:center;gap:8px;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;cursor:pointer;max-width:320px;}',
  '.duq-cascader-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);}',
  '.duq-cascader-trigger.is-open{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover);}',
  '.duq-cascader-trigger.is-warn{color:var(--dsw-alias-state-warn-primary);}',
  '.duq-cascader-trigger:disabled{opacity:.6;cursor:wait;}',
  '.duq-cascader-label{color:var(--dsw-alias-label-secondary);}',
  '.duq-cascader-value{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.duq-cascader-caret{color:var(--dsw-alias-label-secondary);font-size:10px;}',
  // fixed 而非 absolute：设置面板的内容列是滚动/裁剪容器，绝对定位的浮层会被它切掉左半边
  '.duq-cascader-panel{position:fixed;z-index:80;display:flex;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 12px 32px color-mix(in srgb,#000 18%,transparent);overflow:hidden;}',
  '.duq-cascader-col{display:flex;flex-direction:column;min-width:160px;max-height:300px;overflow:auto;padding:6px;}',
  '.duq-cascader-col+.duq-cascader-col{border-left:1px solid var(--dsw-alias-border-l1);}',
  '.duq-cascader-item{display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:6px 10px;border-radius:8px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer;white-space:nowrap;}',
  '.duq-cascader-item:hover{background:var(--dsw-alias-interactive-bg-hover);}',
  '.duq-cascader-item.is-on{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);}',
  '.duq-cascader-item-sub{font-size:10px;color:var(--dsw-alias-label-secondary);}',
  '.duq-cascader-empty{padding:8px 10px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:normal;}',
  '.duq-tabs{display:flex;flex-wrap:wrap;gap:8px;}',
  '.duq-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;}',
  '.duq-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
  '.duq-chip.is-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);}',
  '.duq-chip.is-add{border-style:dashed;}',
  '.duq-chip.is-static{cursor:default;font-size:11px;padding:3px 8px;}',
  '.duq-chip-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);}',
  '.duq-chip-dot.is-ok{background:var(--dsw-alias-state-success-primary);}',
  '.duq-chip-dot.is-error{background:var(--dsw-alias-state-error-primary);}',
  '.duq-chip-dot.is-warn{background:var(--dsw-alias-state-warn-primary);}',
  '.duq-chip-dot.is-info{background:var(--dsw-alias-state-info-primary);}',
  '.duq-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px;}',
  '.duq-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px 16px;flex-wrap:wrap;}',
  // 标题与元信息拿到至少 320px；动作按钮挤不下就整体换到下一行，不与元信息抢宽度。
  '.duq-card-titles{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1 1 340px;}',
  '.duq-card-titlerow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
  '.duq-card-title{margin:0;font-size:14px;font-weight:600;}',
  '.duq-card-actions{display:flex;gap:8px;flex-wrap:wrap;flex-shrink:0;}',
  // 元信息必须能读完：接口地址、登录态有效期都可能有几十个字符，硬截成「…」等于
  // 什么都不告诉你。改成整块换行（每个信息项内部可断行）。
  '.duq-meta{display:flex;gap:4px 16px;flex-wrap:wrap;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
  '.duq-meta-item{white-space:normal;overflow-wrap:anywhere;max-width:100%;}',
  '.duq-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}',
  '.duq-badge.is-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-state-success-primary);}',
  '.duq-badge.is-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent);color:var(--dsw-alias-state-warn-primary);}',
  '.duq-badge.is-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent);color:var(--dsw-alias-state-error-primary);}',
  '.duq-badge.is-info{background:color-mix(in srgb,var(--dsw-alias-state-info-primary) 16%,transparent);color:var(--dsw-alias-state-info-primary);}',
  '.duq-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;}',
  '.duq-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
  '.duq-btn.is-quiet{border-color:transparent;color:var(--dsw-alias-label-secondary);}',
  '.duq-btn.is-quiet:hover:not(:disabled){color:var(--dsw-alias-label-primary);}',
  '.duq-btn.is-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);}',
  '.duq-btn.is-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}',
  '.duq-btn.is-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);}',
  '.duq-btn:disabled{opacity:.5;cursor:not-allowed;}',
  '.duq-banner{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);}',
  '.duq-banner.is-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);}',
  '.duq-banner.is-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,transparent);}',
  '.duq-banner.is-info{background:color-mix(in srgb,var(--dsw-alias-state-info-primary) 8%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-state-info-primary) 30%,transparent);}',
  '.duq-banner-body{min-width:0;}',
  '.duq-banner-title{font-weight:600;font-size:12px;}',
  '.duq-banner-text{font-size:12px;color:var(--dsw-alias-label-secondary);}',
  '.duq-banner-actions{flex-shrink:0;}',
  '.duq-view{display:flex;flex-direction:column;gap:14px;}',
  '.duq-hero{display:flex;flex-direction:column;gap:8px;padding:14px 16px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);}',
  '.duq-hero-label{font-size:12px;color:var(--dsw-alias-label-secondary);}',
  '.duq-hero-value{font-size:30px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums;}',
  '.duq-progress{display:flex;flex-direction:column;gap:6px;}',
  '.duq-progress-head{display:flex;justify-content:space-between;font-size:12px;color:var(--dsw-alias-label-secondary);}',
  '.duq-progress-value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;}',
  '.duq-bar{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-border-l1));overflow:hidden;}',
  '.duq-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .3s ease;}',
  '.duq-bar-fill.is-warn{background:var(--dsw-alias-state-warn-primary);}',
  '.duq-bar-fill.is-error{background:var(--dsw-alias-state-error-primary);}',
  '.duq-bar-fill.is-ok{background:var(--dsw-alias-state-success-primary);}',
  '.duq-bar-fill.is-muted{background:var(--dsw-alias-state-idle-primary);}',
  '.duq-metrics{display:flex;flex-direction:column;gap:8px;}',
  '.duq-metric{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:12px;}',
  '.duq-metric-label{color:var(--dsw-alias-label-secondary);}',
  '.duq-metric-value{font-variant-numeric:tabular-nums;font-weight:500;}',
  '.duq-metric.is-muted .duq-metric-value{color:var(--dsw-alias-label-secondary);font-weight:400;}',
  '.duq-metric.is-warn .duq-metric-value{color:var(--dsw-alias-state-warn-primary);}',
  '.duq-metric.is-error .duq-metric-value{color:var(--dsw-alias-state-error-primary);}',
  '.duq-metric.is-ok .duq-metric-value{color:var(--dsw-alias-state-success-primary);}',
  '.duq-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;}',
  '.duq-quick-pop .duq-grid{grid-template-columns:1fr;}',
  '.duq-quick-pop .duq-subcard{padding:10px;}',
  '.duq-quick-pop .duq-hero{padding:10px 12px;}',
  '.duq-quick-pop .duq-hero-value{font-size:22px;}',
  '.duq-quick-pop .duq-view{gap:10px;}',
  '.duq-subcard{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);}',
  '.duq-subcard-head{display:flex;flex-direction:column;gap:2px;}',
  '.duq-subcard-title{font-size:12px;font-weight:600;}',
  '.duq-subcard-sub{font-size:11px;color:var(--dsw-alias-label-secondary);}',
  '.duq-notes{margin:0;padding-left:18px;font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:4px;}',
  '.duq-folders{display:flex;flex-direction:column;gap:8px;}',
  '.duq-details{border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;}',
  '.duq-details summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);}',
  '.duq-details summary:hover{color:var(--dsw-alias-label-primary);}',
  '.duq-template-actions{display:flex;justify-content:flex-end;margin-top:6px;}',
  '.duq-pre{margin:8px 0 0;max-height:260px;overflow:auto;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}',
  '.duq-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}',
  '.duq-field{display:flex;flex-direction:column;gap:6px;}',
  '.duq-field-label{font-size:12px;color:var(--dsw-alias-label-secondary);}',
  '.duq-input,.duq-textarea{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;}',
  '.duq-textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;min-height:96px;}',
  '.duq-input:focus,.duq-textarea:focus{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);outline-offset:1px;border-color:var(--dsw-alias-brand-primary);}',
  '.duq-drop{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-2);}',
  '.duq-drop.has-image{padding:10px;}',
  '.duq-drop-hint{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:var(--dsw-alias-label-secondary);}',
  '.duq-file{cursor:pointer;padding:4px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);}',
  '.duq-drop-filled{display:flex;align-items:center;gap:12px;}',
  '.duq-thumb{width:96px;height:60px;object-fit:cover;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);}',
  '.duq-drop-text{font-size:12px;color:var(--dsw-alias-label-secondary);flex:1;min-width:0;}',
  '.duq-import-actions{display:flex;gap:10px;flex-wrap:wrap;}',
  '.duq-hintpanel{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:10px;border:1px dashed var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);}',
  '.duq-hintpanel-title{font-size:12px;font-weight:600;}',
  '.duq-cardgrid{display:flex;flex-direction:column;gap:8px;}',
  '.duq-fields{display:flex;flex-direction:column;gap:6px;}',
  '.duq-field-row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:8px;border:1px solid transparent;}',
  '.duq-field-row:hover{background:var(--dsw-alias-interactive-bg-hover);}',
  '.duq-field-row.is-drag{opacity:.5;}',
  '.duq-field-row.is-over{border-color:var(--dsw-alias-brand-primary);}',
  '.duq-grip{cursor:grab;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;user-select:none;}',
  '.duq-field-label{flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.duq-field-path{font-size:10px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.duq-field-index{width:18px;text-align:right;font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}',
  '.duq-iconbtn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;width:20px;height:20px;line-height:1;font-size:11px;cursor:pointer;padding:0;}',
  '.duq-iconbtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);}',
  '.duq-iconbtn:disabled{opacity:.35;cursor:not-allowed;}',
  '.duq-field-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
  '.duq-field-status{font-size:11px;line-height:1.5;}',
  '.duq-field-status.is-ok{color:var(--dsw-alias-state-success-primary);}',
  '.duq-field-status.is-error{color:var(--dsw-alias-state-error-primary);}',
  '.duq-field-status.is-idle{color:var(--dsw-alias-label-secondary);}',
  '.duq-placeholder{font-size:12px;color:var(--dsw-alias-label-secondary);}',
  '.duq-error{font-size:12px;color:var(--dsw-alias-state-error-primary);margin-top:6px;}',
  '.duq-empty{gap:6px;}',
  '.duq-foot{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);}',
  '.duq-metricblock{display:flex;flex-direction:column;gap:8px;}',
  '.duq-more{align-self:flex-start;border:0;background:transparent;padding:2px 0;color:var(--dsw-alias-link,var(--dsw-alias-brand-primary));font:inherit;font-size:11px;cursor:pointer;}',
  '.duq-more:hover{text-decoration:underline;}',
  '.duq-quick{position:relative;display:inline-flex;align-items:center;}',
  // 触发体：图标 + 一个短值 + 状态点。刻意做得比普通按钮矮、比图标宽一点，
  // 让它在会话头里像「一个数字」而不是「一个表单控件」。
  '.duq-quick-trigger{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 7px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1;cursor:pointer;}',
  '.duq-quick-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
  '.duq-quick-trigger.is-open{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1);}',
  // 数值段：永远完整（这是芯片存在的意义），不设 max-width、不截断。
  '.duq-quick-value{font-variant-numeric:tabular-nums;font-weight:500;white-space:nowrap;}',
  // 接口名段：次要信息，最多占一小段宽度，必要时省略。
  '.duq-quick-name{max-width:84px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);}',
  // 浮层：紧贴触发体下沿（不留缝），顶部留 8px 透明带做「鼠标桥」，
  // 指针从芯片滑到浮层上不会经过空隙而误触发关闭。
  '.duq-quick-pop{position:fixed;z-index:70;width:344px;box-sizing:border-box;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));box-shadow:0 16px 40px color-mix(in srgb,#000 24%,transparent);overflow:visible;}',
  // 悬停桥：浮层顶边往上 12px 也属于浮层，指针从芯片滑下来时不会掉进空隙。
  // 它必须**不被裁掉**，所以外层 overflow 是 visible，滚动放在内层。
  '.duq-quick-pop::before{content:\'\';position:absolute;left:0;right:0;top:-12px;height:12px;}',
  '.duq-quick-scroll{max-height:72vh;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px;border-radius:12px;}',
  '.duq-quick-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
  '.duq-quick-title{font-size:12px;font-weight:600;}',
  '.duq-quick-empty{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
  '.duq-pop-card{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}',
  '.duq-pop-head{display:flex;align-items:center;gap:6px;}',
  '.duq-star{border:0;background:transparent;padding:0 2px;font-size:13px;line-height:1;color:var(--dsw-alias-label-secondary);cursor:pointer;}',
  '.duq-star:hover{color:var(--dsw-alias-brand-primary);}',
  '.duq-star.is-on{color:var(--dsw-alias-brand-primary);}',
  '.duq-pop-title{font-size:12px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.duq-pop-meta{font-size:10px;line-height:1.5;color:var(--dsw-alias-label-secondary);}',
  '.duq-pop-warn{font-size:11px;line-height:1.5;padding:6px 8px;border-radius:8px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);}',
  '.duq-pop-foot{font-size:10px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.duq-quick-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;}',
  // 续期/刷新之后的一行反馈。没有它，失败时卡片只是「看起来没变化」，
  // 用户既不知道成没成、也拿不到原因。
  '.duq-quick-note{margin:2px 0 8px;padding:7px 10px;border-radius:8px;font-size:12px;line-height:1.5;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);word-break:break-word;}',
  '.duq-quick-hint{font-size:10px;color:var(--dsw-alias-label-secondary);}'
].join('\n');

/**
 * 注入插件样式。
 *
 * 每个入口组件各自渲染一份（设置页外壳、主区页面外壳、会话头芯片）：
 * 客户端的样式就是随组件渲染出来的 <style>，谁能挂载谁就得带上它 —— 只让
 * 设置页带一份，会话头芯片就会在「设置没打开」时以裸 DOM 出现。同一份 CSS
 * 重复出现是幂等的，用 data 属性标记而不是 id，避免重复 id。
 */
export function Styles() {
  return h('style', { 'data-dsh-usage-query': STYLE_ID, dangerouslySetInnerHTML: { __html: CSS } });
}

/**
 * 面板外壳：把 <style> 与内容一起渲染，卸载时样式与节点一起消失。
 *
 * 样式随组件走而不是写进全局：会话头与设置页是两个互不相邻的挂载点，只有其中
 * 一处打开时，另一处也得有样式可用。
 */
export function PanelShell(props) {
  return h(React.Fragment, null, h(Styles, null), h(Panel, props));
}
