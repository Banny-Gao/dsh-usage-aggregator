// src/client/features/theme/brand.js
// 品牌自定义：默认品牌、字体表、以及外部输入的归一化。
//
// 面板允许换 logo（本地文件 / 在线链接）与三段文案，这些都来自用户输入，
// 所以每个入口都要过一遍 range / 类型检查，不能让脏值进到渲染层。

import { LOGO_MAX_CHARS } from './constants.js';


/** 品牌可自定义项。文案留空字符串 = 不显示该行；logo 留空 = 用内置官方素材。 */
export const DEFAULT_BRAND = {
  logo: "",
  font: "",
  name: "安心筑",
  tagline: "怕烦恼 用安心筑",
  subtag: "全球首创工程管理新范式"
};

/** 品牌名等于默认值时用官方矢量字标（还原度最高），改过才降级成文本。 */
/**
 * 可选的品牌字体。
 *
 * 内置「安心筑」是矢量轮廓（SVG 里没有 font 信息），所以不存在「同款字体」——
 * 与其硬凑，不如把字体选择做成功能。这里只用**系统自带 / 通用族**，不加载任何
 * 网络字体：名字靠前的是 macOS 常见字体，后面接 Windows 或通用族兜底。
 * 每套自带合适的字重与字距 —— 艺术字体被统一压成 800/负字距只会变丑。
 *
 * 内置字标是矢量轮廓、跟字体无关，所以不提供「与字标对齐」那一档 ——
 * 品牌名保持默认值时压根不显示字体选择（见 Panel）。
 */
export const FONTS = [
  { id: "hei", label: "现代黑体", weight: 700, tracking: "-.01em", squeeze: false, stack: '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif' },
  { id: "lanting", label: "兰亭黑", weight: 700, tracking: "0", stack: '"Lantinghei SC","STLantinghei","Microsoft YaHei",sans-serif' , squeeze: false },
  { id: "yuan", label: "圆润", weight: 600, tracking: "0", stack: '"Yuanti SC","STYuanti","Hiragino Maru Gothic ProN","Microsoft YaHei",sans-serif' , squeeze: false },
  { id: "song", label: "雅致宋体", weight: 700, tracking: ".02em", stack: '"Songti SC","STSong","SimSun","Noto Serif CJK SC",serif' , squeeze: false },
  { id: "kai", label: "书写楷体", weight: 500, tracking: ".02em", stack: '"Kaiti SC","STKaiti","KaiTi","STFangsong",serif' , squeeze: false },
  { id: "xingkai", label: "行楷", weight: 400, tracking: ".03em", stack: '"Xingkai SC","STXingkai","KaiTi",cursive' , squeeze: false },
  { id: "baoli", label: "隶书", weight: 400, tracking: ".03em", stack: '"Baoli SC","STBaoli","LiSu",serif' , squeeze: false },
  { id: "Didot", label: "Didot", weight: 500, tracking: ".01em", stack: '"Didot","Bodoni 72","Playfair Display",Georgia,serif' , squeeze: false },
  { id: "Futura", label: "Futura", weight: 600, tracking: ".02em", stack: '"Futura","Avenir Next","Century Gothic","Trebuchet MS",sans-serif' , squeeze: false },
  { id: "Script", label: "Script", weight: 500, tracking: "0", stack: '"Snell Roundhand","Segoe Script","Brush Script MT","Apple Chancery",cursive' , squeeze: false },
  { id: "Impact", label: "Impact", weight: 400, tracking: ".01em", stack: '"Impact","Haettenschweiler","Arial Black",sans-serif' , squeeze: false }
];


export function resolveFont(brand) {
  var id = brand !== null && brand !== undefined && typeof brand.font === "string" ? brand.font : "";
  for (var i = 0; i < FONTS.length; i += 1) {
    if (FONTS[i].id === id) return FONTS[i];
  }
  return FONTS[0];
}


function safeFontId(raw) {
  if (typeof raw !== "string") return "";
  for (var i = 0; i < FONTS.length; i += 1) {
    if (FONTS[i].id === raw) return raw;
  }
  return "";
}


export const OFFICIAL_NAME = DEFAULT_BRAND.name;


/* ─────────────────── 运行时偏好（唯一真源） ───────────────────── */
/**
 * 面板每点开一次就会重新 mount，而 apply() 整个页面只跑一次。
 * 若把「加载时读到的偏好」当快照传给面板，重新挂载就会用旧值把
 * 用户刚改的颜色冲掉（表现为：重开设置，主题被打回上一次的颜色）。
 * 因此偏好只存在这个模块级单例里，覆盖层与面板都从它读、往它写。
 */
/* ───────────────────────── 品牌自定义项 ───────────────────────── */
/**
 * logo 会被直接写进 <img src>，所以只放行两类值：
 * 内联图片（data:image/…，本地上传走这条）与 http(s) 在线地址。
 * javascript: / file: / blob: 之类一律丢弃，宁可回到内置。
 */
function safeLogoUrl(raw) {
  if (typeof raw !== "string") return "";
  var url = raw.trim();
  if (url === "" || url.length > LOGO_MAX_CHARS) return "";
  if (!/^data:image\//i.test(url) && !/^https?:\/\//i.test(url)) return "";
  return url;
}


// 刻意不 trim：面板是逐字符写回的，trim 会把用户刚敲下的空格当场吃掉
function cutText(raw, fallback, max) {
  if (typeof raw !== "string") return fallback;
  return raw.slice(0, max);
}


export function normalizeBrand(raw, fallback) {
  var base = fallback || DEFAULT_BRAND;
  if (raw === null || typeof raw !== "object") return base;
  return {
    logo: safeLogoUrl(raw.logo),
    font: safeFontId(raw.font),
    name: cutText(raw.name, base.name, 24),
    tagline: cutText(raw.tagline, base.tagline, 40),
    subtag: cutText(raw.subtag, base.subtag, 56)
  };
}
