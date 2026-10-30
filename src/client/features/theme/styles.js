// src/client/features/theme/styles.js
// 插件注入到 DSH 页面的全局 CSS。
//
// 视觉分层（从下到上）：
//   ① 表面 token 染色（见 tokens.js）—— 让整个应用有安心筑的薄荷底色
//   ② 全域氛围光 —— body::before 一层 fixed 的渐变，制造玻璃氛围
//   ③ 顶部光带 —— body::after 一条流光
//
// 为什么不碰消息气泡等内部 DOM：DSH 用 CSS-module 哈希类名渲染，没有 data-*
// 稳定钩子，[class*="userMessage"] 这类选择器只会静默失效。

import { resolveFont } from './brand.js';
import { clamp } from './color.js';
import { NOISE_URL, PLUGIN_ID, STYLE_ID } from './constants.js';


/* ────────────────────────── 全局样式注入 ───────────────────────── */
function buildGlobalCss(flags, brand) {
  var out = [];

  /* ── ① 全域氛围光 ── */
  if (flags.wash) {
    // 强度用一个 opacity 缩放整层：这是全屏面积最大的色块，直接决定「看久了累不累」
    var washAlpha = clamp(typeof flags.washLevel === "number" ? flags.washLevel : 62, 0, 100) / 100;
    out.push("body::before{content:'';position:fixed;inset:0;pointer-events:none;");
    out.push("z-index:2147482000;");
    out.push("opacity:" + washAlpha.toFixed(2) + ";");
    out.push("background:");
    out.push("radial-gradient(1100px 560px at 10% -6%,var(--dsh-axzo-wash-1,rgba(66,180,140,.18)) 0%,transparent 62%),");
    out.push("radial-gradient(820px 480px at 94% 4%,var(--dsh-axzo-wash-2,rgba(66,180,140,.14)) 0%,transparent 66%),");
    out.push("radial-gradient(1000px 700px at 50% 112%,var(--dsh-axzo-wash-1,rgba(66,180,140,.16)) 0%,transparent 70%);");
    out.push("}");
  }

  /* ── ② 顶部流光 ── */
  if (flags.glass) {
    out.push("body::after{content:'';position:fixed;left:0;right:0;top:0;height:4px;");
    out.push("z-index:2147483000;pointer-events:none;");
    out.push("background:linear-gradient(90deg,transparent 0%,");
    out.push("var(--dsh-axzo-brand-soft,rgba(10,169,108,.25)) 22%,");
    out.push("var(--dsh-axzo-brand,#0aa96c) 50%,");
    out.push("var(--dsh-axzo-brand-soft,rgba(10,169,108,.25)) 78%,transparent 100%);");
    out.push("background-size:200% 100%;transition:opacity .35s ease;}");
    // 接上任务状态之后不再自顾自地流动：有任务在跑才出现，而且是「呼吸」，
    // 停下来的那一刻就消失。没接上 sessions 服务时退回原来的常驻流光 ——
    // 宁可保持旧行为，也不要让整条光带彻底不出现。
    out.push("body:not([data-axzo-taskwatch])::after{animation:dsh-axzo-sheen 7.5s linear infinite;}");
    out.push("body[data-axzo-taskwatch]::after{opacity:0;}");
    out.push("body[data-axzo-taskwatch][data-axzo-busy]::after{");
    out.push("opacity:1;animation:dsh-axzo-breathe-line 2.6s ease-in-out infinite;}");
    out.push("@keyframes dsh-axzo-breathe-line{0%,100%{opacity:.28;transform:scaleY(1)}");
    out.push("50%{opacity:1;transform:scaleY(1.8)}}");
  }

  /* ── ③ 首屏：隐藏 DSH 默认标语，让出舞台 ──
     只按语义子串命中；万一类名变了，最坏结果是标语重新出现，不会崩。 */
  if (flags.hero) {
    out.push("[class*='_titleGroup']{display:none !important;}");
    out.push("[class*='_headline']{gap:0 !important;}");
  }

  /* ── ④ 首屏玻璃舞台 ── */
  out.push(".dsh-axzo-hero{position:relative;display:flex;flex-direction:column;");
  out.push("align-items:center;color:var(--dsh-axzo-brand,#0aa96c);");
  out.push("-webkit-user-select:none;user-select:none;}");
  out.push(".dsh-axzo-stage{position:relative;display:grid;place-items:center;flex:none;}");
  out.push(".dsh-axzo-stage>*{grid-area:1/1;}");

  /*
   * 形状：刻意**不**声明 corner-shape:round。
   * DSH 的 corner-shape.css 会给所有元素套 superellipse，把 border-radius:50%
   * 压成圆角方盘 —— 这个方圆形正是我们要的（与参考图的圆角立方体同气质）。
   * 盘面与光弧都不覆盖它，两者才同心同形。
   */
  out.push(".dsh-axzo-disc{position:relative;border-radius:50%;overflow:hidden;");
  out.push("background:linear-gradient(150deg,rgba(255,255,255,.42) 0%,");
  out.push("var(--dsh-axzo-glass-lo,rgba(230,248,242,.22)) 58%,rgba(255,255,255,.30) 100%);");
  out.push("border:1px solid var(--dsh-axzo-glass-line,rgba(120,200,175,.55));");
  out.push("box-shadow:inset 0 2px 1px -1px rgba(255,255,255,.95),");
  out.push("inset 0 -18px 30px -20px var(--dsh-axzo-brand-ring,rgba(10,169,108,.4)),");
  out.push("0 20px 46px -22px var(--dsh-axzo-brand-ring,rgba(10,169,108,.55)),");
  out.push("0 2px 10px -4px rgba(20,60,48,.16);");
  out.push("-webkit-backdrop-filter:blur(16px) saturate(1.7);backdrop-filter:blur(16px) saturate(1.7);");
  out.push("display:grid;place-items:center;}");
  /* 盘面斜向高光 + 底部反光弧 */
  out.push(".dsh-axzo-disc::after{content:'';position:absolute;inset:0;border-radius:50%;");
  out.push("background:");
  out.push("linear-gradient(132deg,rgba(255,255,255,.72) 0%,rgba(255,255,255,.10) 34%,rgba(255,255,255,0) 52%),");
  out.push("radial-gradient(circle at 50% 118%,var(--dsh-axzo-brand-soft,rgba(10,169,108,.35)) 0%,transparent 58%);");
  out.push("pointer-events:none;}");

  /* 舞台后面的彩色光斑（玻璃靠它们才有内容可糊）。两者同心居中，不加位移。 */
  out.push(".dsh-axzo-blob{position:absolute;border-radius:50%;");
  out.push("pointer-events:none;filter:blur(20px);}");
  out.push(".dsh-axzo-blob-a{background:var(--dsh-axzo-blob-a,rgba(80,200,160,.5));}");
  out.push(".dsh-axzo-blob-b{background:var(--dsh-axzo-blob-b,rgba(120,210,220,.42));}");

  if (flags.motion || flags.hero) {
    /* 旋转光弧：完整一圈（0deg 与 360deg 同色，接缝不可见），
       环上分布两段亮两段暗，旋转时读得出在转。
       形状跟着盘面走（同样不写 corner-shape），所以它是一个方圆形环，
       与盘面同心同形，而不是套在外面的一个普通正圆。 */
    out.push(".dsh-axzo-arc{position:relative;border-radius:50%;pointer-events:none;");
    out.push("background:conic-gradient(from 0deg,");
    out.push("var(--dsh-axzo-brand,#0aa96c) 0deg,");
    out.push("var(--dsh-axzo-brand-soft,rgba(10,169,108,.30)) 72deg,");
    out.push("var(--dsh-axzo-brand,#0aa96c) 180deg,");
    out.push("var(--dsh-axzo-brand-soft,rgba(10,169,108,.30)) 288deg,");
    out.push("var(--dsh-axzo-brand,#0aa96c) 360deg);");
    out.push("-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 1px));");
    out.push("mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 1px));");
    out.push("filter:drop-shadow(0 0 7px var(--dsh-axzo-brand-ring,rgba(10,169,108,.5)));");
    if (flags.motion) out.push("animation:dsh-axzo-spin 12s linear infinite;");
    out.push("}");
    /* 呼吸光晕 */
    out.push(".dsh-axzo-glow{position:absolute;border-radius:50%;pointer-events:none;");
    out.push("background:radial-gradient(circle,var(--dsh-axzo-brand-ring,rgba(10,169,108,.32)) 0%,");
    out.push("var(--dsh-axzo-brand-soft,rgba(10,169,108,.14)) 42%,transparent 70%);");
    out.push("filter:blur(9px);");
    if (flags.motion) out.push("animation:dsh-axzo-pulse 5.5s ease-in-out infinite;");
    out.push("}");
  }

  out.push(".dsh-axzo-mark-core{position:relative;display:block;z-index:1;color:var(--dsh-axzo-brand,#0aa96c);");
  out.push("filter:drop-shadow(0 6px 16px var(--dsh-axzo-brand-ring,rgba(10,169,108,.4)));");
  if (flags.motion) out.push("animation:dsh-axzo-float 6.5s ease-in-out infinite;");
  out.push("}");

  /* 字标与标语 */
  /* ── ⑥ 会话主区（.wSkVaW_body）的品牌水印 ──
     直接把它做成该容器的**背景图**，而不是叠一层浮层：
     背景天然在内容之下，没有 stacking / z-index / pointer-events 的一堆坑。
     选择器只按键名里稳定的语义子串 + DSH 自己的 data-phase 命中；
     CSS-module 的哈希前缀（wSkVaW）会随构建变，不能写死。
     命中失败只是没有水印，不会有副作用。 */
  if (flags.watermark) {
    // BackdropHost 会把一个 .dsh-axzo-backdrop 容器插进会话主区，
    // 里面 portal 的是**与首屏同一个 HeroBrandMark 组件**（见 BackdropHost）。
    // 这里只负责把它摆成背景：铺满主区、居中、不吃指针事件。
    // 因为它绝对定位在 .wSkVaW_body 里，而滚动的是内部的 scrollBody，
    // 所以内容滚、背景不动。
    out.push(".dsh-axzo-backdrop{position:absolute;inset:0;display:grid;");
    out.push("place-items:center;pointer-events:none;z-index:0;overflow:hidden;}");
    // 这是唯一长期停在正文后面的装饰，透明度直接换算成阅读疲劳；
    // 再用 radial mask 把边缘化掉，避免硬边压在文字行上。
    out.push(".dsh-axzo-backdrop .dsh-axzo-hero{opacity:.26;");
    out.push("-webkit-mask-image:radial-gradient(closest-side,#000 40%,transparent 100%);");
    out.push("mask-image:radial-gradient(closest-side,#000 40%,transparent 100%);}");
    out.push("body[data-ds-dark-theme] .dsh-axzo-backdrop .dsh-axzo-hero{opacity:.16;}");
    // 空会话态下正中央就是首屏舞台本体，背景再放一份只会两个「安心筑」
    // 互相压住 —— 那里让位。
    out.push("[class*='_root'][data-phase=hero] > [class*='_body'] > .dsh-axzo-backdrop{display:none;}");
  } else {
    // 关掉开关时 portal 仍在（React 不订阅 flag），由 CSS 负责隐藏
    out.push(".dsh-axzo-backdrop{display:none !important;}");
  }

  out.push(".dsh-axzo-hero-word{display:block;margin-top:16px;color:var(--dsw-alias-label-primary,#1a2b27);}");
  out.push(".dsh-axzo-hero-tag{margin-top:10px;color:var(--dsh-axzo-brand,#0aa96c);");
  out.push("font-size:19px;font-weight:600;letter-spacing:.06em;line-height:1.4;}");
  out.push(".dsh-axzo-hero-sub{margin-top:5px;color:var(--dsw-alias-label-tertiary,#8b95a3);");
  out.push("font-size:12.5px;font-weight:400;letter-spacing:.14em;line-height:1.5;}");
  out.push("body[data-ds-dark-theme] .dsh-axzo-hero-word{color:#e7f3ef;}");

  /* ── ④b 侧栏质感：玻璃 + 磨砂纹理 ──
     全部挂在运行时打上的 data-axzo-sidebar（见 SidebarDecorHost）：
     侧栏根类名是 <hash>_root，哈希随构建变，而且 _root 这个子串别的模块也在用，
     所以不打静态选择器。命中失败最坏就是没有质感，不会有副作用。 */
  if (flags.sbGlass) {
    var sbGrainPct = clamp(typeof flags.sbGrain === "number" ? flags.sbGrain : 28, 0, 100) / 100;
    // ⚠️ 这里**不能**用 backdrop-filter / filter，也不能给根加 isolation：
    //    设置弹窗（*_overlay, position:fixed; inset:0）是渲染在侧栏子树里的，
    //    backdrop-filter 会让本元素成为 fixed 后代的包含块 —— inset:0 就从「视口」
    //    变成「侧栏那一块」，弹窗被压扁成竖排文字。而且它本来也没用：侧栏背后是
    //    纯色底，没有可糊的内容。玻璃靠「半透明底色 + 内侧柔光 + 细描边 + 磨砂」成立。
    // 属性写两遍把优先级抬到 (0,2,0)：DSH 的 .<hash>_root 是 (0,1,0) 且**懒注入**，
    // 注入顺序比我们晚 —— 同优先级下后注入者胜，不抬优先级我们的 background 会被整条压掉。
    out.push("[data-axzo-sidebar][data-axzo-sidebar]{position:relative;");
    out.push("background:");
    // ① 顶部一条短促的受光边：玻璃的「厚度」主要来自它，而不是透明度
    out.push("linear-gradient(180deg,var(--dsh-axzo-sb-sheen,rgba(255,255,255,.07)) 0,transparent 92px),");
    // ② 主色柔光收紧到左上角，跟大面积的氛围光拉开形态差异（一个是角光，一个是全屏）
    out.push("radial-gradient(82% 52% at 2% -10%,");
    out.push("var(--dsh-axzo-sb-glow,rgba(10,169,108,.22)) 0%,transparent 66%),");
    // 底部沉色：一条很淡的竖向明暗，玻璃才不像一块平涂
    out.push("linear-gradient(180deg,transparent 44%,var(--dsh-axzo-sb-deep,rgba(10,169,108,.07)) 100%),");
    // ③ 实心一点的底色，保证和内容区有明确台阶
    out.push("var(--dsh-axzo-sidebar,rgba(255,255,255,.72));");
    out.push("box-shadow:inset -1px 0 0 var(--dsh-axzo-sb-edge,rgba(255,255,255,.09)),");
    out.push("10px 0 30px -22px var(--dsh-axzo-sb-shadow,rgba(0,0,0,.55));");
    out.push("border-right:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));}");
    // 侧栏里头还有一层 *_root 也铺了不透明底：不清掉的话，玻璃的「透」被两层实色
    // 挡死，看起来就像没生效。范围限定在标记内，不会误伤别处。
    out.push("[data-axzo-sidebar] [class*='_root']{background:transparent;}");
    // 列表底边 fade 浮层（DSH 默认 class 形如 <hash>_fade）。它本身是
    // `linear-gradient(transparent, var(--dsw-specific-sidebar-fill))`，渐变
    // 终点是冷调近白/近黑；侧栏一染上薄荷，这条 24px 就会变成原色色差条。
    // 直接 background:none 把它关掉 —— fade 元素仍在 DOM（仍占位、不吃指针），
    // 但不再画任何东西，列表底边直接接到侧栏玻璃底，色差消失。
    // 写 [class*='_fade'] 而不是写死 bhn1Oq_fade：DSH 把这个类做成 CSS Module，
    // 哈希随构建变；语义后缀 _fade 才是稳定钩子（其它模块里的 fadeTop /
    // fadeBottom 走 mask-image 不吃 background，这里顺手置 none 也是 no-op）。
    // 加 !important：DSH 的 .<hash>_fade 是 (0,1,0) 且懒注入落在我们之后，
    // 同优先级下后注入者胜，不抬优先级 background 又会被渐变压回来。
    out.push("[data-axzo-sidebar] [class*='_fade']{background:none !important;}");
    if (sbGrainPct > 0) {
      out.push("[data-axzo-sidebar][data-axzo-sidebar]::after{content:'';position:absolute;inset:0;z-index:1;");
      out.push("pointer-events:none;background-image:url(\"" + NOISE_URL + "\");");
      // 不用 mix-blend-mode:overlay —— 深色底上 overlay 的结果几乎等于原色，
      // 纹理直接看不出来。普通叠加在深浅两套下都稳定可见。
      out.push("background-size:140px 140px;opacity:" + (sbGrainPct * 0.38).toFixed(3) + ";}");
    }
  }

  /* ── ⑤ 侧栏工作区行的任务状态 ──
     只加我们自己的属性和徽标，不动 React 的节点结构。
     命中失败最坏就是不动效，不会有副作用。 */
  out.push("[class*='_projectRow'][data-axzo-run]{");
  out.push("box-shadow:inset 0 0 0 1px var(--dsh-axzo-brand-ring,rgba(10,169,108,.4));");
  out.push("animation:dsh-axzo-row-breathe 2.8s ease-in-out infinite;}");
  out.push("[class*='_projectRow'][data-axzo-run] [class*='_folder']{color:var(--dsh-axzo-brand,#0aa96c);}");
  out.push("@keyframes dsh-axzo-row-breathe{0%,100%{box-shadow:inset 0 0 0 1px rgba(0,0,0,0)}");
  out.push("50%{box-shadow:inset 0 0 0 1px var(--dsh-axzo-brand-ring,rgba(10,169,108,.4))}}");
  out.push(".dsh-axzo-done{flex:none;display:inline-flex;align-items:center;justify-content:center;");
  out.push("width:16px;height:16px;margin-left:6px;padding:0;border:none;border-radius:50%;cursor:pointer;");
  out.push("background:var(--dsh-axzo-brand,#0aa96c);color:#fff;transition:transform .15s ease;}");
  out.push(".dsh-axzo-done:hover{transform:scale(1.18);}");
  /* 「需要关注」徽标：琥珀色 + 叹号，与「完成」的对勾区分清楚。
     色值走 --dsw-alias-state-warn-primary（在 deriveTokens 里固定浅 / 深
     两档琥珀，#f59e0b / #d97706）—— 错误 / 暂停是状态信号，不是品牌表
     达，所以不跟主色漂移；但用 token 表达，DSH 其他用了这个 token 的位
     置（toast、banner、状态行）也跟着统一。 */
  out.push(".dsh-axzo-attention{flex:none;display:inline-flex;align-items:center;justify-content:center;");
  out.push("width:16px;height:16px;margin-left:6px;padding:0;border:none;border-radius:50%;cursor:pointer;");
  out.push("background:var(--dsw-alias-state-warn-primary,#f59e0b);color:#fff;transition:transform .15s ease;}");
  out.push(".dsh-axzo-attention:hover{transform:scale(1.18);}");

  /* ── ⑥ 侧栏品牌 ── */
  out.push(".dsh-axzo-mark{display:block;color:var(--dsh-axzo-brand,#0aa96c);");
  out.push("transform-origin:50% 58%;");
  if (flags.motion) out.push("animation:dsh-axzo-breathe 6s ease-in-out infinite;");
  out.push("}");
  out.push(".dsh-axzo-wordmark{display:block;color:var(--dsw-alias-label-primary,#1a2b27);transition:color .2s;}");
  // 自定义 logo 是位图/矢量图，一律 contain，不裁不裁；不套圆角，避免把小方标切花
  out.push(".dsh-axzo-mark-img{display:block;object-fit:contain;background:transparent;}");
  // 品牌名改过之后降级成文本，字号按侧栏一行的高度对齐
  // 官方字标是**矢量轮廓**（SVG 里没有任何 font 信息），所以严格意义上的
  // 「同款字体」不存在。这两条是按真实字标实测对齐出来的：字号 ≈ 0.95×字标高度、
  // 字重 800、字距 -0.03em —— 视觉上与内置字标同高同重，而不是小一号的正文。
  var font = resolveFont(brand);
  out.push(".dsh-axzo-wordmark-text{font-size:20px;line-height:1;white-space:nowrap;");
  out.push("font-weight:" + font.weight + ";letter-spacing:" + font.tracking + ";");
  out.push("font-family:" + font.stack + ";");
  if (font.squeeze) out.push("transform:scaleX(.9);transform-origin:left center;");
  out.push("}");
  out.push(".dsh-axzo-hero-word-text{font-size:32px;line-height:1.1;");
  out.push("font-weight:" + font.weight + ";letter-spacing:" + font.tracking + ";");
  out.push("font-family:" + font.stack + ";");
  if (font.squeeze) out.push("transform:scaleX(.9);transform-origin:center;");
  out.push("}");
  out.push("body[data-ds-dark-theme] .dsh-axzo-wordmark{color:#e7f3ef;}");

  /* ── 关键帧 ── */
  if (flags.motion) {
    out.push("@keyframes dsh-axzo-breathe{0%{transform:translateY(0) rotate(0) scale(1)}");
    out.push("50%{transform:translateY(-3px) rotate(3.5deg) scale(1.05)}");
    out.push("100%{transform:translateY(0) rotate(0) scale(1)}}");
    out.push("@keyframes dsh-axzo-float{0%{transform:translateY(0) rotate(0)}");
    out.push("50%{transform:translateY(-3px) rotate(1.5deg)}100%{transform:translateY(0) rotate(0)}}");
    out.push("@keyframes dsh-axzo-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}");
    out.push("@keyframes dsh-axzo-pulse{0%{opacity:.5;transform:scale(.93)}");
    out.push("50%{opacity:1;transform:scale(1.07)}100%{opacity:.5;transform:scale(.93)}}");
  }
  if (flags.glass) {
    out.push("@keyframes dsh-axzo-sheen{0%{background-position:150% 0}100%{background-position:-150% 0}}");
  }

  /* ── 减弱动效守卫 ── */
  out.push("@media (prefers-reduced-motion: reduce){");
  out.push(".dsh-axzo-mark,.dsh-axzo-mark-core,.dsh-axzo-arc,.dsh-axzo-glow{animation:none !important}");
  out.push("body::after{animation:none !important}");
  // 关掉动画但要保留「这里在跑」的静态标识，不能直接消失
  out.push("[class*='_projectRow'][data-axzo-run]{animation:none !important;");
  out.push("box-shadow:inset 0 0 0 1px var(--dsh-axzo-brand-ring,rgba(10,169,108,.4)) !important}}");

  return out.join("\n");
}


export function applyGlobalStyle(flags, brand) {
  if (typeof document === "undefined") return;
  var tag = document.getElementById(STYLE_ID);
  if (tag === null) {
    tag = document.createElement("style");
    tag.id = STYLE_ID;
    tag.setAttribute("data-plugin", PLUGIN_ID);
    document.head.appendChild(tag);
  }
  tag.textContent = buildGlobalCss(flags, brand);
}
