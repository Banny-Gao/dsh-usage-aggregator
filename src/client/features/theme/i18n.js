// src/client/features/theme/i18n.js
// 设置面板的中英文案。
//
// zh 是基准字典（key 的完整集合）；en 缺 key 时回落到 zh —— 见 makeTranslator。
//
// ⚠️ 命名空间**保持 settings.axzoTheme 不变**（见 constants.js 的 NS）。
//   改名会让新旧命名空间并存 —— locale 服务按命名空间存字典，旧的不注销就一直占着。
//
// ⚠️ 字典内容**逐字保留**：用户在旧插件里看到的每一句文案都对应一个 key，
//   删 key = 界面上出现裸的 key 名。
//
// 唯一新增的是 `hubTab` —— 聚合设置页（hub）用它作为本功能的页签标签。

import { NS } from './constants.js';
import { makeTranslator as sharedMakeTranslator } from '../../shared/i18n.js';


/* ───────────────────────────── 字典 ───────────────────────────── */
export const zh = {
  tab: "AxzoTheme",
  hubTab: "主题外观",
  sectionPreset: "预设色板",
  sectionColor: "主色微调",
  hue: "色相",
  saturation: "饱和度",
  lightness: "明度",
  reset: "恢复默认色",
  sectionFx: "视觉开关",
  glassTitle: "顶部流光",
  glassHint: "顶边一条随主色流动的渐变光带。",
  motionTitle: "品牌呼吸",
  motionHint: "侧栏 logo 与首屏光弧持续缓慢动；系统开启「减弱动效」时此开关默认关掉（已手动开过的保持）。",
  washTitle: "全域氛围光",
  heroTitle: "首屏品牌舞台",
  wmTitle: "会话区品牌背景",
  surfaceTitle: "表面染色",
  surfaceHint: "把背景、卡片、分隔线一起染上主色。0% 只剩强调色；70% 为推荐值。系统开启「增强对比度」时浓度上限压到 40%。",
  tintLabel: "浓度",
  preview: "实时预览",
  previewBrand: "侧栏品牌",
  previewHero: "首屏舞台",
  previewSurface: "表面染色",
  previewUser: "把主题色换成安心筑绿",
  previewReply: "已应用 {hex}",
  hintPersist: "改动立即生效并记住，刷新后保留。",
  tokenNote: "覆盖 {n} 个 DSH 主题 token",
  sectionBrand: "品牌自定义",
  brandHint: "换成自己的 logo 与文案。留空则回到内置官方素材 / 不显示该行。",
  logoLabel: "Logo",
  pickFile: "选择本地文件",
  logoUrlPlaceholder: "或粘贴图片地址（https://…）",
  logoBuiltin: "内置",
  logoCustom: "自定义",
  resetLogo: "恢复内置 logo",
  nameLabel: "品牌名",
  taglineLabel: "主标语",
  subtagLabel: "副标语",
  resetBrand: "恢复默认文案",
  badImage: "请选择图片文件",
  tooBig: "图片太大了，换一张更小的（建议 < 200KB）",
  readFail: "读取失败，换一张试试",
  logoReady: "已应用自定义 logo",
  logoUrlBad: "地址要以 https:// 或 http:// 开头",
  sectionComfort: "视觉舒适度（预防视觉疲劳）",
  comfortHint: "长时间盯屏时：环境色块越小越省力，文字对比度越高越不易疲劳。",
  washLevelLabel: "环境光强度",
  comfortPreset: "一键护眼（低刺激）",
  comfortApplied: "已切到低刺激配置：环境光 25%、关闭流光与动效",
  heroHint: "空会话时用玻璃圆盘 + 品牌标语替换 DSH 默认首屏文案。关掉则完整还原 DSH 默认首屏。",
  wmHint: "有会话时把整套品牌（光晕+玻璃盘+字标+标语）铺成会话主区背景，不随内容滚动。",
  washHint: "整个界面铺一层薄荷渐变光晕，玻璃质感的主要来源。强度可单独调。",
  doneBadge: "该工作区有任务刚完成，点击清除标记",
  attentionBadge: "该工作区任务被暂停或出错，点击清除标记",
  sbSection: "侧栏质感",
  sbHint: "给侧栏加一层玻璃与磨砂纹理。数值调低更通透，调高更沉稳。",
  sbGlassTitle: "玻璃面板",
  sbGlassHint: "半透明底色 + 内侧主色柔光，并带一条右侧细描边。\u901a\u900f\u5ea6\u8d8a\u9ad8\u8d8a\u900f\u3002",
  sbClearLabel: "通透度",
  sbGrainLabel: "磨砂纹理",
  fontLabel: "字体"

};

export const en = {
  tab: "AxzoTheme",
  hubTab: "Theme",
  sectionPreset: "Presets",
  sectionColor: "Fine-tune",
  hue: "Hue",
  saturation: "Saturation",
  lightness: "Lightness",
  reset: "Reset color",
  sectionFx: "Visual switches",
  glassTitle: "Top light trail",
  glassHint: "A primary-tinted gradient trail flowing along the top edge.",
  motionTitle: "Brand motion",
  motionHint: "Sidebar logo and hero arc keep moving slowly. Default off when the system asks for reduced motion (manual toggle is preserved once you've set it).",
  washTitle: "Ambient wash",
  heroTitle: "Brand hero stage",
  wmTitle: "Conversation backdrop",
  surfaceTitle: "Surface tinting",
  surfaceHint: "Tints backgrounds, cards and dividers. 0% = accents only; 70% is the recommended default. Capped at 40% when the system asks for more contrast.",
  tintLabel: "Strength",
  preview: "Live preview",
  previewBrand: "Sidebar brand",
  previewHero: "Hero stage",
  previewSurface: "Tinted surface",
  previewUser: "Tint the theme with AnxinZhu green",
  previewReply: "Applied {hex}",
  hintPersist: "Changes apply instantly and survive reloads.",
  tokenNote: "Overrides {n} DSH theme tokens",
  sectionBrand: "Brand",
  brandHint: "Use your own logo and copy. Leave a field empty to fall back to the built-in asset or hide that line.",
  logoLabel: "Logo",
  pickFile: "Choose a local file",
  logoUrlPlaceholder: "or paste an image URL (https://…)",
  logoBuiltin: "Built-in",
  logoCustom: "Custom",
  resetLogo: "Reset to built-in logo",
  nameLabel: "Brand name",
  taglineLabel: "Tagline",
  subtagLabel: "Sub-tagline",
  resetBrand: "Reset copy",
  badImage: "Please choose an image file",
  tooBig: "Image too large — pick a smaller one (under ~200KB)",
  readFail: "Could not read the file, try another",
  logoReady: "Custom logo applied",
  logoUrlBad: "URL must start with https:// or http://",
  sectionComfort: "Visual comfort",
  comfortHint: "For long sessions: the less ambient colour on screen the easier on the eyes.",
  washLevelLabel: "Ambient strength",
  comfortPreset: "Low-strain preset",
  comfortApplied: "Low-strain preset applied: wash 25%, glass and motion off",
  heroHint: "Replaces the default blank-session copy with a glass disc and brand tagline. Turning it off restores DSH's own hero.",
  wmHint: "Paints the whole brand as the conversation backdrop; it does not scroll with content.",
  washHint: "A mint gradient wash across the whole UI — the main source of the glassy feel. Strength is adjustable.",
  doneBadge: "A task just finished here — click to clear the mark",
  attentionBadge: "A task here was paused or errored — click to clear the mark",
  sbSection: "Sidebar finish",
  sbHint: "Adds a glass layer and a frosted grain to the sidebar. Lower values read clearer, higher ones calmer.",
  sbGlassTitle: "Glass panel",
  sbGlassHint: "Translucent fill, a soft primary glow inside, and a hairline right border. Higher transparency lets more through.",
  sbClearLabel: "Transparency",
  sbGrainLabel: "Frosted grain",
  fontLabel: "Typeface"

};


/**
 * 取 translator，保证**永远返回非空字符串**。
 * 面板里多处直接拼字符串 / .replace()，t() 返回 undefined 会让整个面板崩掉。
 *
 * 现在委托给共享的 makeTranslator(locale, namespace, fallback)
 * （见 src/client/shared/i18n.js）。行为与原来**完全一致**：
 *   · 命名空间仍是 settings.axzoTheme；
 *   · 回落字典仍是本文件的 zh —— en 缺 key 时回落到 zh；
 *   · 永远返回非空字符串。
 *
 * 唯一多出来的能力：translator 支持第二个参数 vars 做 {name} 插值（共享实现带的）。
 * 旧调用点全都只传 key，行为不变。
 */
export function makeTranslator(locale) {
  return sharedMakeTranslator(locale, NS, zh);
}
