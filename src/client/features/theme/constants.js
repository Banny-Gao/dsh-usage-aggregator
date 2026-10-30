// src/client/features/theme/constants.js
// 本功能（聚合插件的主题半边）的标识符与主题默认值。
//
// 两类东西放一起，因为都是「不会随运行时变化的值」：
//   · 标识符（DOM id / localStorage key / 设置命名空间）—— 改了会影响持久化与槽位
//   · 主题默认值（主色 / 预设 / 默认开关 / 上限）—— 改了会影响首屏观感


/* ───────────────────────────── 常量 ───────────────────────────── */
/**
 * 主题覆盖层的 **source 标识**。
 *
 * ⚠️ 迁进 dsh-usage-aggregator 之后，它**不再是包名** —— 它是
 * `ctx.theme.overrideTokens(source, tokens)` 那个 source 键。
 * 值必须保持 "dsh-axzo-theme"：DSH 的 theme service 是「一 source 一层」，
 * 换 source 会与迁移期间仍然装着的旧插件形成**双层叠加**（两套色盘互相覆盖，
 * 谁后注册谁赢，视觉上就成了随机结果）。
 *
 * 同理，下面的 STYLE_ID / PANEL_STYLE_ID / LS_* 也都是**对外可见的既有标识**，
 * 一律不改 —— 改了用户的本地存储与已注入的 <style> 就对不上了。
 */
export const PLUGIN_ID = "dsh-axzo-theme";

/**
 * locale 命名空间。**保持不变**：改名会让新旧命名空间并存（locale 服务按命名
 * 空间存字典，旧的不注销就一直占着）。
 */
export const NS = "settings.axzoTheme";

export const STYLE_ID = "dsh-axzo-theme-style";

export const PANEL_STYLE_ID = "dsh-axzo-theme-panel-style";

/** localStorage key —— **保持不变**：改了用户已保存的主色 / 开关 / 品牌名全丢。 */
export const LS_PRIMARY = "dsh-axzo-theme:primary";

export const LS_FLAGS = "dsh-axzo-theme:fx";

export const LS_BRAND = "dsh-axzo-theme:brand";


export const DEFAULT_PRIMARY = { h: 156, s: 88, l: 35 };


export const PRESETS = [
  { id: "axzo",     label: "安心筑绿", labelEn: "AnxinZhu", h: 156, s: 88, l: 35 },
  { id: "mint",     label: "薄荷青",   labelEn: "Mint",     h: 168, s: 76, l: 38 },
  { id: "tech",     label: "科技蓝",   labelEn: "Tech",     h: 214, s: 84, l: 46 },
  { id: "indigo",   label: "靛紫",     labelEn: "Indigo",   h: 262, s: 66, l: 52 },
  { id: "amber",    label: "暮橙",     labelEn: "Amber",    h: 28,  s: 86, l: 46 },
  { id: "graphite", label: "石墨",     labelEn: "Graphite", h: 210, s: 12, l: 42 }
];


// tint 是数值（0-100，表面染色浓度），其余是开关
export const DEFAULT_FLAGS = { tint: 70, wash: true, washLevel: 62, hero: true, watermark: true, motion: true, glass: true,
  sbGlass: true, sbClear: 55, sbGrain: 24 };

const DEFAULT_TINT = DEFAULT_FLAGS.tint;

/** data URL 最终要塞进 localStorage，必须有上限。约 320K 字符 ≈ 240KB 图片。 */
export const LOGO_MAX_CHARS = 320000;

/** 磨砂颗粒：feTurbulence 生成的灰度噪声。纯 ASCII，encodeURIComponent 足够。 */
export const NOISE_URL = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'>" +
  "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/></filter>" +
  "<rect width='140' height='140' filter='url(#n)'/></svg>");
