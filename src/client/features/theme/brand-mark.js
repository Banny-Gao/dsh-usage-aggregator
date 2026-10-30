// src/client/features/theme/brand-mark.js
// 品牌位：图标（BrandMark）与字标（BrandName）。
//
// 官方 logo 是 110×33 的横向 lockup，构建期按真实包围盒切成图标 + 字标两份，
// 分别占 sidebar.brand.mark / .name 两个 slot，才不会渲染出两个图标。
//
// 两个尺寸坑（都会静默画错）：
//   · 内联 <svg> 只给 height 时宽度会退化成父容器的 100%，字标被横向拉伸 ——
//     必须按 viewBox 宽高比算显式宽度；
//   · 光晕 / 光弧写百分比落在 grid 区域里会与容器尺寸互相依赖，正圆变椭圆 ——
//     改用内联像素。

import { DEFAULT_BRAND, OFFICIAL_NAME } from './brand.js';
import { ICON_PATH, ICON_VIEWBOX, TEXT_PATH, TEXT_VIEWBOX } from './logo.js';
import { prefs, usePrefs } from './prefs.js';
import { h } from '../../runtime.js';


/* ────────────────────────── 品牌 SVG 组件 ──────────────────────── */
function viewBoxAspect(viewBox) {
  var parts = viewBox.trim().split(/[\s,]+/).map(Number);
  if (parts.length < 4 || !parts[2] || !parts[3]) return 1;
  return parts[2] / parts[3];
}


const WORDMARK_HEIGHT = 19;


export function iconSvg(className, size, fill) {
  return h("svg", {
    className: className,
    width: size,
    height: size,
    viewBox: ICON_VIEWBOX,
    "aria-hidden": "true",
    focusable: "false",
    preserveAspectRatio: "xMidYMid meet"
  }, h("path", { d: ICON_PATH, fill: fill || "currentColor" }));
}


export function textSvg(className, height, fill) {
  var width = Math.round(height * viewBoxAspect(TEXT_VIEWBOX) * 100) / 100;
  return h("svg", {
    className: className,
    width: width,
    height: height,
    viewBox: TEXT_VIEWBOX,
    "aria-hidden": "true",
    focusable: "false",
    preserveAspectRatio: "xMidYMid meet"
  }, h("path", { d: TEXT_PATH, fill: fill || "currentColor" }));
}


/**
 * 侧栏图标：优先用自定义 logo，没设才用内置官方图标。
 * 订阅 store，所以用户换 logo 后侧栏会立刻跟着变。
 */
export function BrandMark(props) {
  var size = (props && props.size) || 28;
  var prefs = usePrefs();
  var brand = prefs.brand;
  if (brand.logo !== "") {
    return h("img", {
      className: "dsh-axzo-mark dsh-axzo-mark-img",
      src: brand.logo,
      width: size,
      height: size,
      alt: brand.name,
      draggable: "false"
    });
  }
  return h("svg", {
    className: "dsh-axzo-mark",
    width: size,
    height: size,
    viewBox: ICON_VIEWBOX,
    role: "img",
    "aria-label": brand.name || DEFAULT_BRAND.name,
    focusable: "false",
    preserveAspectRatio: "xMidYMid meet"
  }, h("path", { d: ICON_PATH, fill: "currentColor" }));
}


/**
 * 侧栏字标：品牌名没改过就用官方矢量字标（还原度最高），
 * 改过才降级成文本 —— 官方那条 path 是「安心筑」三个字的轮廓，换字没法复用。
 * 注意内置 svg 必须显式给宽度，否则会被拉满父容器。
 */
export function BrandName() {
  var prefs = usePrefs();
  var name = prefs.brand.name;
  if (name === "") return null;
  if (name === OFFICIAL_NAME) return textSvg("dsh-axzo-wordmark", WORDMARK_HEIGHT, "currentColor");
  return h("span", { className: "dsh-axzo-wordmark dsh-axzo-wordmark-text" }, name);
}
