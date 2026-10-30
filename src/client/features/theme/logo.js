// src/client/features/theme/logo.js
// 构建期注入的官方 logo 数据。
//
// 四个 __AXZO_*__ 占位符由 vite/axzo-logo-plugin.mjs 从
// assets/axzo-official-logo.svg 算出后替换。这是 src/client/features/theme/ 里唯一一处
// 「值来自构建期而非运行期」的模块 —— 换 logo 只需要替换 SVG 再构建。
//
// 为什么内联 path 而不是 <img src="./assets/x.svg">：
//   1. DSH 的 host-frontend-static 只服务 SPA dist，插件自带的 assets/ 不会被
//      任何路由服务 —— 外链必然 404；
//   2. <img> 里的 SVG 无法继承 currentColor，浅深两套模式要维护两张图。


/* ── 官方 logo 路径（构建时注入，取自 assets/axzo-official-logo.svg）── */
export const ICON_PATH = "__AXZO_ICON_PATH__";

export const TEXT_PATH = "__AXZO_TEXT_PATH__";

export const ICON_VIEWBOX = "__AXZO_ICON_VIEWBOX__";

export const TEXT_VIEWBOX = "__AXZO_TEXT_VIEWBOX__";
