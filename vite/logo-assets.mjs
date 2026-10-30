// vite/logo-assets.mjs
//
// 把官方 logo（assets/axzo-official-logo.svg）解析成渲染需要的四份数据：
//   - iconPath / textPath      —— 图标与字标各自的 SVG path d
//   - iconViewBox / textViewBox —— 两者各自的紧包围盒（带一点 padding）
//
// 为什么叫 logo-assets 而不是 path-bounds：这个模块的主要职责是「把一张
// 官方 lockup 拆成图标 + 字标两件可渲染资产」，算包围盒只是其中一步。按
// 最窄的一步命名会让人以为它只处理几何。
//
// 调用方：vite/axzo-logo-plugin.mjs。模块外只需要 resolveLogo 一个入口，
// 其余三个函数是它的内部实现，故意不导出 —— 没有第二个使用者，导出就是
// 预付抽象。

import { readFileSync } from 'node:fs'

/**
 * 遍历 SVG path 指令，追踪当前点，收集坐标得到包围盒。
 *
 * **包含控制点**：对 C/S/Q/T 指令，函数把控制点与端点一并收进 pts，所以
 * 得到的是「控制多边形包围盒」——真实贝塞尔极值点的保守超集，不会切掉
 * 曲线。
 *
 * 这是刻意保留的行为，不是疏漏：原 scripts/build-client.mjs 就是这么算的，
 * 两者必须逐字节一致，否则 viewBox 会变、README 里记录的
 * `-1.404 -1.524 37.898 35.745` 等数值会失效，渲染出来的 logo 也会被切边。
 * 换成真实贝塞尔极值需要同时改 README 与全部视觉断言，收益为零。
 *
 * @param {string} d SVG path 的 d 属性。
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }}
 */
function pathBounds(d) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e-?\d+)?/g) || []
  const pts = []
  let cx = 0, cy = 0, sx = 0, sy = 0, cmd = null, i = 0

  const next = () => Number(tokens[i++])

  while (i < tokens.length) {
    const t = tokens[i]
    if (/[A-Za-z]/.test(t)) { cmd = t; i += 1; continue }
    if (cmd === null) { i += 1; continue }

    const up = cmd.toUpperCase()
    const rel = cmd !== up

    if (up === 'M') {
      const x = next(), y = next()
      cx = rel ? cx + x : x
      cy = rel ? cy + y : y
      sx = cx; sy = cy
      pts.push([cx, cy])
      cmd = rel ? 'l' : 'L'
    } else if (up === 'L') {
      const x = next(), y = next()
      cx = rel ? cx + x : x
      cy = rel ? cy + y : y
      pts.push([cx, cy])
    } else if (up === 'H') {
      const x = next()
      cx = rel ? cx + x : x
      pts.push([cx, cy])
    } else if (up === 'V') {
      const y = next()
      cy = rel ? cy + y : y
      pts.push([cx, cy])
    } else if (up === 'C' || up === 'S' || up === 'Q' || up === 'T') {
      const n = { C: 6, S: 4, Q: 4, T: 2 }[up]
      const vals = Array.from({ length: n }, next)
      for (let k = 0; k < n; k += 2) {
        const px = vals[k], py = vals[k + 1]
        pts.push([rel ? cx + px : px, rel ? cy + py : py])
      }
      cx = pts[pts.length - 1][0]
      cy = pts[pts.length - 1][1]
    } else if (up === 'A') {
      const vals = Array.from({ length: 7 }, next)
      const px = vals[5], py = vals[6]
      cx = rel ? cx + px : px
      cy = rel ? cy + py : py
      pts.push([cx, cy])
    } else if (up === 'Z') {
      cx = sx; cy = sy
      pts.push([cx, cy])
    } else {
      i += 1
    }
  }

  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys)
  }
}

/** 保留 3 位小数 —— viewBox 字符串的既有精度，改了会让产物与前版不一致。 */
const round3 = (v) => Number(v.toFixed(3))

/**
 * 由 path d 算出带 padding 的 viewBox 字符串。
 *
 * @param {string} d SVG path 的 d 属性。
 * @param {number} padRatio 包围盒宽 / 高各自向外留的比例。
 * @returns {string} "minX minY width height"，各保留 3 位小数。
 */
function viewBoxFor(d, padRatio) {
  const b = pathBounds(d)
  const w = b.maxX - b.minX
  const h = b.maxY - b.minY
  const px = w * padRatio
  const py = h * padRatio
  return [round3(b.minX - px), round3(b.minY - py), round3(w + px * 2), round3(h + py * 2)].join(' ')
}

/**
 * 从完整 SVG 文本里抽出所有 <path d="...">。
 *
 * @param {string} svg 整个 SVG 文本。
 * @returns {string[]} 每个 path 的 d 属性值。
 */
function extractPaths(svg) {
  return [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1])
}

/**
 * 把官方 logo 拆成「图标」与「字标」两件可渲染资产。
 *
 * 官方 logo 是一张 110×33 的横向 lockup（图标 + 三字），拆开才能既保持
 * 官方字形，又不重复出现图标 —— DSH 侧栏把品牌渲染成 [mark][name] 两个
 * 独立 slot，不拆就会渲染出两个图标。
 *
 * 两条 padding 比例（图标 4% / 字标 2%）是既有取值：图标带光弧留白、
 * 字标只需极窄边距。
 *
 * @param {string} svgPath 官方 logo 文件绝对路径。
 * @returns {{ iconPath: string, textPath: string, iconViewBox: string, textViewBox: string }}
 * @throws 当 path 少于两个（拆分不成立）时抛错，由 Vite 转成可读的构建错误。
 */
export function resolveLogo(svgPath) {
  const svg = readFileSync(svgPath, 'utf8')
  const paths = extractPaths(svg)
  if (paths.length < 2) {
    throw new Error(
      `[axzo-logo] 期望官方 logo 里至少两个 path（图标 + 文字），实际 ${paths.length}（${svgPath}）`
    )
  }
  const [iconPath, textPath] = paths
  return {
    iconPath,
    textPath,
    iconViewBox: viewBoxFor(iconPath, 0.04),
    textViewBox: viewBoxFor(textPath, 0.02)
  }
}
