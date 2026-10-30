// preview/main.js
//
// Vite dev server（pnpm dev）的入口，承接原 scripts/preview.html 的职责：
// 把品牌资产的三种用法摆出来给人肉眼看 —— 侧栏展开/收起、预设色板、官方
// lockup 对照。
//
// ```范围说明（别误会它在预览什么）```
//   本页**只**反映 assets/axzo-official-logo.svg —— 换 logo，整页跟着变。
//   它**不**渲染 src/ 里的 React 组件，所以改组件样式 / 结构不会体现在这里；
//   那类改动请开 pnpm dev:enable，在真实 DSH 里看。
//   之所以不直接复用那些组件：src/index.js 是自注册的（调
//   window.__ModuleLoader__.load），产物 client.js 对外没有可 import 的导出。
//
// 数据来源：axzo-logo-preview 插件在 transformIndexHtml 里把 logo 数据挂到
// window.__AXZO_LOGO__（同一趟还会替换本页 HTML 里的 __AXZO_*__ 占位符），
// 主入口从这里读，不写死任何路径。

const {
  ICON_PATH,
  TEXT_PATH,
  ICON_VIEWBOX,
  TEXT_VIEWBOX
} = window.__AXZO_LOGO__

const aspect = (vb) => {
  const p = vb.trim().split(/[\s,]+/).map(Number)
  return p[2] / p[3]
}

const icon = (px, color) =>
  `<svg width="${px}" height="${px}" viewBox="${ICON_VIEWBOX}" style="display:block;color:${color}"><path d="${ICON_PATH}" fill="currentColor"/></svg>`
const word = (hgt, color) =>
  `<svg width="${(hgt * aspect(TEXT_VIEWBOX)).toFixed(2)}" height="${hgt}" viewBox="${TEXT_VIEWBOX}" style="display:block;color:${color}"><path d="${TEXT_PATH}" fill="currentColor"/></svg>`

const presets = [
  ['#0aa96c', '安心筑绿'],
  ['#1a9a9a', '松石青'],
  ['#2b7fe0', '科技蓝'],
  ['#7a52d9', '靛紫'],
  ['#e07a22', '暮橙'],
  ['#4a5b66', '石墨']
]

const sidebarHtml = (dark, brand) => {
  const bg = dark ? '#1c1c1c' : '#ffffff'
  const fg = dark ? '#e7f3ef' : '#1a2b27'
  const bd = dark ? '#333' : '#e8e8e8'
  return `<div style="display:flex;flex-direction:column;gap:10px">
    <div style="background:${bg};padding:12px 14px;border-radius:10px;display:flex;align-items:center;gap:8px;width:220px;border:1px solid ${bd}">${icon(24, brand)}${word(19, fg)}</div>
    <div style="background:${bg};padding:12px 14px;border-radius:10px;display:flex;align-items:center;justify-content:center;gap:8px;width:56px;border:1px solid ${bd}">${icon(24, brand)}</div>
  </div>`
}

document.getElementById('sidebar-light').innerHTML = sidebarHtml(false, '#0aa96c')
document.getElementById('sidebar-dark').innerHTML = sidebarHtml(true, '#34d399')
document.getElementById('presets').innerHTML = presets
  .map(([c, n]) => `<div class="swatch">${icon(32, c)}<span>${n}</span></div>`)
  .join('')
document.getElementById('lockup').innerHTML = `<svg width="176" height="53" viewBox="0 0 110 33"><path d="${ICON_PATH}" fill="#41AF89"/><path d="${TEXT_PATH}" fill="#617470"/></svg>`
