// src/client/features/theme/tokens.js
// 43 个主题 token 的推导，以及覆盖层的唯一所有者。
//
// 覆盖层由 apply() 的 effect 单例持有：overrideTokens 对同一 source 只保留一层，
// 若让设置面板也持有 disposer，用户切走 AxzoTheme 页就会把整层色盘撤掉。

import { clamp, hslToHex, rgba, withAlpha } from './color.js';
import { PLUGIN_ID } from './constants.js';


/**
 * 主色 → alias token 覆盖层。
 * token 名全部取自 dsh-client-ui-theme 的真实清单 —— 写错名字不会报错，
 * 只会静默不生效。浅深两套独立计算。
 *
 * 分两组：
 *   · 强调组（brand / button / link）—— 让控件有品牌色
 *   · 表面组（bg / border）—— 让整个应用**看起来**是安心筑主题；
 *     这一组是「像不像主题」的决定因素，用极低饱和的薄荷色，保证文字对比度。
 */
function deriveTokens(primary, tint, sbClear) {
  var hue = primary.h, sat = primary.s, lig = primary.l;

  /* 强调色 */
  var lightFill = hslToHex(hue, sat, clamp(lig, 30, 48));
  var lightHover = hslToHex(hue, sat, clamp(lig - 7, 24, 42));
  var lightText = hslToHex(hue, sat, clamp(lig - 6, 24, 42));
  // 深色模式下把饱和度再压一档：同样是那个色相，夜里高饱和就是更刺眼，
  // 压 10% 肉眼几乎看不出「不是同一个主色」，但久看明显省力。
  var darkSat = sat * 0.9;
  var darkFill = hslToHex(hue, clamp(darkSat - 4, 40, 92), clamp(lig + 20, 44, 64));
  var darkHover = hslToHex(hue, clamp(darkSat - 4, 40, 92), clamp(lig + 28, 52, 72));
  var darkText = hslToHex(hue, clamp(darkSat - 12, 34, 88), clamp(lig + 36, 60, 80));

  var tokens = {};
  tokens["--dsw-alias-brand-primary"] = { light: lightFill, dark: darkFill };
  tokens["--dsw-alias-brand-primary-invert"] = { light: lightText, dark: darkText };
  tokens["--dsw-alias-button-primary-fill"] = { light: lightFill, dark: darkFill };
  tokens["--dsw-alias-button-primary-hover"] = { light: lightHover, dark: darkHover };
  tokens["--dsw-alias-button-ghost-active-fill"] = {
    light: withAlpha(lightFill, 0.13), dark: withAlpha(darkFill, 0.20)
  };
  tokens["--dsw-alias-interactive-bg-active"] = {
    light: withAlpha(lightFill, 0.18), dark: withAlpha(darkFill, 0.26)
  };
  tokens["--dsw-alias-link"] = { light: lightText, dark: darkText };

  /* 本功能自用 */
  tokens["--dsh-axzo-brand"] = { light: lightFill, dark: darkFill };
  tokens["--dsh-axzo-brand-soft"] = { light: withAlpha(lightFill, 0.14), dark: withAlpha(darkFill, 0.22) };
  tokens["--dsh-axzo-brand-ring"] = { light: withAlpha(lightFill, 0.34), dark: withAlpha(darkFill, 0.46) };
  tokens["--dsh-axzo-brand-line"] = { light: withAlpha(lightFill, 0.38), dark: withAlpha(darkFill, 0.44) };
  /* 侧栏玻璃底色：与表面同色系，但**留一点透明度** —— 不透明的话「玻璃」就只是
     一块色板，和普通面板没有任何区别。染色越浓越实（文字越清楚），越淡越透。 */
  var sbT = clamp(tint, 0, 100) / 100;
  /*
   * 侧栏必须先和内容区拉开一个**明确的明度台阶** —— 否则它会被全域氛围光
   * 一起糊掉，看起来「没有玻璃也没有纹理」。教训：这里曾经是 0.30 的 alpha，
   * 背后又是 DSH 不透明的 #1b1b1c，合成出来 ≈ #191c1b，和默认灰几乎一样，
   * 等于把侧栏做没了。
   * 「通透度」只在这个台阶内微调：真正的玻璃感来自受光边 / 内侧柔光 / 磨砂，
   * 不是透明本身 —— 侧栏背后没有内容可透，纯降 alpha 只会让它消失在背景里。
   */
  var clear = typeof sbClear === "number" && isFinite(sbClear) ? clamp(sbClear, 0, 100) / 100 : 0.3;
  var sbAlpha = clamp(0.97 - clear * 0.26, 0.68, 0.98);
  tokens["--dsh-axzo-sidebar"] = {
    // 浅色往「白」走、深色往「亮」走 —— 两侧都是「比内容区更亮的一层」，
    // 这才是玻璃片浮在上面的观感。反过来压暗只会和背景糊在一起。
    // 浅色这侧要更「白」一点：内容区是薄荷底，侧栏做成一片更白的玻璃，
    // 台阶才够醒目（实测 1% 的差在浅色下几乎看不出来）
    light: rgba(hue, 5 + sbT * 9, clamp(99.6 - sbT * 0.6, 0, 100), clamp(sbAlpha + 0.08, 0.72, 0.99)),
    dark: rgba(hue, 8 + sbT * 14, clamp(13.8 - sbT * 0.6, 0, 100), sbAlpha)
  };
  /* 玻璃的「厚度」三件套：顶部短促受光边、右侧内高光、外侧一道很淡的投影 */
  tokens["--dsh-axzo-sb-sheen"] = {
    // 浅色面板本身已经接近白，再加白高光等于没有；改成极淡的顶缘冷色，用来压出边界
    light: "rgba(24,72,56,0.055)", dark: "rgba(255,255,255,0.075)"
  };
  tokens["--dsh-axzo-sb-edge"] = {
    light: "rgba(255,255,255,0.90)", dark: "rgba(255,255,255,0.09)"
  };
  tokens["--dsh-axzo-sb-shadow"] = {
    light: "rgba(14,46,36,0.18)", dark: "rgba(0,0,0,0.60)"
  };
  /* 侧栏自己的角光要比 --dsh-axzo-brand-soft 强一档：
     后者是给大面积铺底用的，用来做「一束光」太弱，浅色下基本看不见。 */
  tokens["--dsh-axzo-sb-glow"] = {
    light: withAlpha(lightFill, 0.30), dark: withAlpha(darkFill, 0.30)
  };
  /* 面板底部的极淡沉色：让玻璃有上下明暗，而不是一块平白 */
  tokens["--dsh-axzo-sb-deep"] = {
    light: withAlpha(lightFill, 0.10), dark: "rgba(0,0,0,0.22)"
  };

  /* 玻璃与氛围光 */
  tokens["--dsh-axzo-glass-hi"] = {
    light: "rgba(255,255,255,0.88)", dark: "rgba(255,255,255,0.09)"
  };
  tokens["--dsh-axzo-glass-lo"] = {
    light: rgba(hue, clamp(sat - 40, 16, 60), 96, 0.42),
    dark: rgba(hue, clamp(sat - 48, 12, 52), 22, 0.38)
  };
  tokens["--dsh-axzo-glass-line"] = {
    light: rgba(hue, clamp(sat - 10, 24, 80), clamp(lig + 44, 74, 90), 0.55),
    dark: rgba(hue, clamp(sat - 6, 22, 76), clamp(lig + 26, 46, 66), 0.30)
  };

  /*
   * 氛围光。
   * 浅色模式下不能拿「高亮度 + 低透明」当光 —— 白色底上加亮光等于没有。
   * 浅色必须用**更饱和、更暗**的薄荷色作为一层薄染色才有存在感；
   * 深色模式反过来，用提亮的色当辉光。
   */
  var t = clamp(tint, 0, 100) / 100;
  tokens["--dsh-axzo-wash-1"] = {
    light: rgba(hue, clamp(sat - 12, 34, 78), clamp(84 - t * 4, 78, 88), 0.22 + t * 0.26),
    dark: rgba(hue, clamp(sat - 12, 30, 82), clamp(lig + 14, 34, 54), 0.14 + t * 0.14)
  };
  tokens["--dsh-axzo-wash-2"] = {
    light: rgba(hue, clamp(sat - 20, 28, 72), clamp(88 - t * 4, 82, 92), 0.18 + t * 0.22),
    dark: rgba(hue, clamp(sat - 20, 24, 74), clamp(lig + 22, 40, 62), 0.10 + t * 0.10)
  };
  tokens["--dsh-axzo-blob-a"] = {
    light: rgba(hue, clamp(sat - 6, 40, 92), clamp(lig + 26, 48, 68), 0.55),
    dark: rgba(hue, clamp(sat - 6, 40, 92), clamp(lig + 18, 40, 60), 0.42)
  };
  tokens["--dsh-axzo-blob-b"] = {
    light: rgba((hue + 34) % 360, clamp(sat - 30, 26, 74), clamp(lig + 34, 56, 76), 0.45),
    dark: rgba((hue + 34) % 360, clamp(sat - 26, 28, 72), clamp(lig + 22, 44, 64), 0.34)
  };

  /*
   * 表面染色：整个应用的底色 / 卡片 / 分隔线。
   *
   * 浓度由 tint(0-100) 控制。教训：浅色表面如果只做到 98~99% 亮度，
   * 那是肉眼分辨不出的白 —— 参考图的底色约 #eef7f3（HSL≈160/39%/95%），
   * 所以默认 70 时底色落在 L≈95.7%，才真的看得出是薄荷主题。
   */
  if (tint > 0) {
    var L1 = 99.4 - t * 4.6;              // 底色：99.4% → 94.8%
    var S1 = 8 + t * 30;                   // 底色饱和度：8% → 38%
    var lift = 1.0 + t * 1.4;              // 每一层比底色亮多少

    tokens["--dsw-alias-bg-base"] = {
      light: hslToHex(hue, S1, L1),
      dark: hslToHex(hue, 6 + t * 18, 7.4 + t * 1.6)
    };
    tokens["--dsw-alias-bg-layer-1"] = {
      light: hslToHex(hue, S1 * 0.9, clamp(L1 + lift, 0, 99.6)),
      dark: hslToHex(hue, 6 + t * 16, 9.2 + t * 1.6)
    };
    tokens["--dsw-alias-bg-layer-2"] = {
      light: hslToHex(hue, S1 * 0.8, clamp(L1 + lift * 1.9, 0, 99.8)),
      dark: hslToHex(hue, 6 + t * 14, 11.0 + t * 1.8)
    };
    tokens["--dsw-alias-bg-layer-3"] = {
      light: hslToHex(hue, S1 * 0.66, clamp(L1 + lift * 3.1, 0, 100)),
      dark: hslToHex(hue, 6 + t * 12, 13.4 + t * 2.0)
    };
    tokens["--dsw-alias-bg-module-platform"] = {
      light: hslToHex(hue, S1 * 0.84, clamp(L1 + lift * 1.2, 0, 99.6)),
      dark: hslToHex(hue, 6 + t * 15, 10.4 + t * 1.7)
    };
    tokens["--dsw-alias-bg-overlay"] = {
      light: hslToHex(hue, S1 * 0.7, clamp(L1 + lift * 2.4, 0, 99.9)),
      dark: hslToHex(hue, 6 + t * 13, 12.2 + t * 1.9)
    };

    /* 分隔线：同色系、低对比，边界清楚但不抢内容 */
    tokens["--dsw-alias-border-l1"] = {
      light: rgba(hue, S1 * 0.9, clamp(L1 - lift * 5, 0, 100), 0.9),
      dark: rgba(hue, 6 + t * 14, 12 + t * 14, 0.5)
    };
    tokens["--dsw-alias-border-l2"] = {
      light: rgba(hue, S1 * 0.84, clamp(L1 - lift * 7, 0, 100), 0.78),
      dark: rgba(hue, 6 + t * 13, 16 + t * 16, 0.46)
    };
    tokens["--dsw-alias-border-l3"] = {
      light: rgba(hue, S1 * 0.8, clamp(L1 - lift * 10, 0, 100), 0.72),
      dark: rgba(hue, 6 + t * 12, 22 + t * 16, 0.5)
    };
    tokens["--dsw-alias-border-l4"] = {
      light: rgba(hue, S1 * 0.76, clamp(L1 - lift * 13, 0, 100), 0.7),
      dark: rgba(hue, 6 + t * 12, 28 + t * 16, 0.54)
    };

    tokens["--dsw-alias-interactive-bg-hover"] = {
      light: rgba(hue, S1, clamp(L1 - lift * 6, 0, 100), 0.28 + t * 0.14),
      dark: rgba(hue, 6 + t * 16, clamp(22 + t * 22, 20, 48), 0.16 + t * 0.12)
    };
  }

  /* 状态色（status signal —— 错误 / 警告 / 成功 / 信息）。覆盖 DSH 默认值
     是为了两件事：
       ① 状态色不属于品牌表达，不应该跟主色漂移（warn/error/success 全固定
          在红 / 黄 / 绿轴上），但要保证浅深两套都有合理对比。
       ② 关注徽标（dsh-axzo-attention）原本写死了 #f59e0b / #d97706，改成
          `var(--dsw-alias-state-warn-primary)` 后，DSH 其他用了这个 token
          的位置（toast、banner、状态行）也跟着统一。
     info 走品牌色 —— 信息提示一般就是「系统在告诉你它做了什么」，品牌色
     比固定的蓝色更贴合主题。 */
  tokens["--dsw-alias-state-warn-primary"] = {
    light: "#f59e0b", dark: "#d97706"
  };
  tokens["--dsw-alias-state-error-primary"] = {
    light: "#dc2626", dark: "#f87171"
  };
  tokens["--dsw-alias-state-success-primary"] = {
    light: "#16a34a", dark: "#4ade80"
  };
  tokens["--dsw-alias-state-info-primary"] = {
    light: lightFill, dark: darkFill
  };

  /* 会话主区：composer 输入底、assistant 消息气泡、选中态气泡、侧栏 DSH
     默认底。全部接到已经覆盖过的 alias 层上：换主色 / 改染色浓度时整片
     会话区跟着走，不会出现「品牌色改了但消息气泡还是 DSH 默认冷灰」 */
  tokens["--dsw-specific-input-major"] = {
    light: tokens["--dsw-alias-bg-layer-1"].light,
    dark: tokens["--dsw-alias-bg-layer-1"].dark
  };
  tokens["--dsw-specific-bubble"] = {
    light: tokens["--dsw-alias-bg-module-platform"].light,
    dark: tokens["--dsw-alias-bg-module-platform"].dark
  };
  tokens["--dsw-specific-bubble-highlight"] = {
    light: withAlpha(lightFill, 0.18),
    dark: withAlpha(darkFill, 0.26)
  };
  /* DSH 自带的 sidebar 填充 token。--dsh-axzo-sidebar 走 data-attr 那一路
     （侧栏玻璃效果需要透明度叠加），这条直接同步过去给 DSH 自己那侧的引
     用 —— 比如 .bhn1Oq_fade 渐变终点、某些原生组件的兜底底色。侧栏一直
     是品牌载体，跟 tint 浓度无关，所以无条件覆盖。 */
  tokens["--dsw-specific-sidebar-fill"] = {
    light: tokens["--dsh-axzo-sidebar"].light,
    dark: tokens["--dsh-axzo-sidebar"].dark
  };

  return tokens;
}


/* ───────────────────── 主色覆盖层的唯一所有者 ──────────────────── */
/**
 * overrideTokens 对同一个 source 只保留一层；再次调用会替换旧层，
 * 被替换那次的 disposer 退化成 no-op。所以覆盖层必须有唯一所有者，
 * 否则「用户切走设置页」会把整层色盘撤掉。
 */
let overlayOwner = null;


export function setBrandTokens(ctx, primary, tint, sbClear) {
  if (!ctx.theme) return;
  if (typeof overlayOwner === "function") {
    try { overlayOwner(); } catch (err) { /* 已失效 */ }
    overlayOwner = null;
  }
  overlayOwner = ctx.theme.overrideTokens(PLUGIN_ID, deriveTokens(primary, tint, sbClear));
}


export function releaseBrandTokens() {
  if (typeof overlayOwner === "function") {
    try { overlayOwner(); } catch (err) { /* 已失效 */ }
    overlayOwner = null;
  }
}
