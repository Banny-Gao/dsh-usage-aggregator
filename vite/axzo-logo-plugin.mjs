// vite/axzo-logo-plugin.mjs
//
// 两个 Vite 插件，共用一份 logo 解析逻辑：
//   - axzoLogoPlugin        —— 把 src/logo.js 里的 __AXZO_*__ 占位符换成
//                              logo 数据。build 与 dev 都挂。
//   - axzoLogoPreviewPlugin —— 把同一份数据注入 preview 页：替换 HTML 里的
//                              同名占位符，并挂到 window.__AXZO_LOGO__ 供
//                              preview/main.js 读取。只在 dev 挂。
//
// 设计要点：
//   1. 替换走 transform 钩子而非 AST —— 只为改四个字符串字面量，不值得动
//      解析器；直接做文本替换，产物与源码的对应关系最直白。
//   2. 不用 createRequire/require.resolve：logo 路径本来就是绝对路径，直接
//      交给 resolveLogo 的 readFileSync 即可；缺文件时它抛出带路径的错。
//   3. 「请勿手改」横幅不在这里拼 —— Vite/Rolldown 会把 transform 结果里的
//      注释全部剥掉。横幅改由 vite.config.mjs 的 output.banner 发出，那一路
//      是在代码生成之后追加的，能活到产物里（verify.sh 有断言守着）。
//   4. dev 与 build 共用同一份替换表，所以 preview 页看到的字符与
//      DSH 实际加载的字符完全一致。
//
// 参数：插件依赖 projectRoot（仓库根），而不是 Vite 的 root —— dev 模式下
// Vite root 是 preview/，logo 仍在仓库根的 assets/ 下。projectRoot 由
// vite.config.mjs 显式传入，不读 import.meta.url：Vite 会把配置 bundle 进
// 临时文件，那时 import.meta.url 指向的是临时文件。

import { join } from 'node:path'
import { resolveLogo } from './logo-assets.mjs'

/** 只有这一个文件会被替换占位符 —— 四个 __AXZO_*__ 占位符住在主题功能的 logo.js。 */
const SRC_FILE = 'src/client/features/theme/logo.js'

/** logo 相对仓库根的位置。 */
const LOGO_REL = 'assets/axzo-official-logo.svg'

/**
 * 占位符 → logo 字段的映射。build 与 preview 共用，保证「预览所见 = 加载所得」。
 * @type {ReadonlyArray<readonly [string, 'iconPath' | 'textPath' | 'iconViewBox' | 'textViewBox']>}
 */
const PLACEHOLDERS = [
  ['__AXZO_ICON_PATH__', 'iconPath'],
  ['__AXZO_TEXT_PATH__', 'textPath'],
  ['__AXZO_ICON_VIEWBOX__', 'iconViewBox'],
  ['__AXZO_TEXT_VIEWBOX__', 'textViewBox']
]

/**
 * 校验插件参数并解析出 logo 的绝对路径。
 *
 * 两个工厂共用这一段：少一个参数校验的分支，就少一处将来会忘的改动点。
 *
 * @param {{ projectRoot?: string } | undefined} opts 插件参数。
 * @param {string} pluginName 出错信息里显示的插件名。
 * @returns {string} logo SVG 的绝对路径。
 */
function resolveLogoPath(opts, pluginName) {
  const projectRoot = opts === undefined ? undefined : opts.projectRoot
  if (typeof projectRoot !== 'string' || projectRoot === '') {
    throw new Error(pluginName + '：必须传 projectRoot —— 见 vite.config.mjs 里的调用')
  }
  return join(projectRoot, LOGO_REL)
}

/**
 * 严格替换：每个占位符都必须出现在模板里，且只出现一次。
 *
 * 严格是对的 —— src.js 少一个占位符就意味着产物少一份 logo 数据，宁可在
 * 构建期炸掉，也不要产出一个渲染空白 logo 的包。
 *
 * @param {string} source src/logo.js 正文。
 * @param {ReturnType<typeof resolveLogo>} logo logo 数据。
 * @returns {string} 替换后的正文。
 */
function replaceStrictly(source, logo) {
  let out = source
  for (const [token, field] of PLACEHOLDERS) {
    const count = out.split(token).length - 1
    if (count === 0) {
      throw new Error('[axzo-logo] 模板里找不到占位符 ' + token + ' —— src.js 是不是改名 / 删了？')
    }
    if (count > 1) {
      throw new Error('[axzo-logo] 占位符 ' + token + ' 出现 ' + count + ' 次，只应该出现 1 次')
    }
    out = out.split(token).join(logo[field])
  }
  return out
}

/**
 * 宽松替换：只替换 HTML 里真实出现的占位符，缺席不算错。
 *
 * preview/index.html 的说明文字里只用得到 viewBox；将来若有人在页面里
 * 补上别的占位符，这里不用改。
 *
 * @param {string} html preview 页 HTML。
 * @param {ReturnType<typeof resolveLogo>} logo logo 数据。
 * @returns {string} 替换后的 HTML。
 */
function replaceLoosely(html, logo) {
  let out = html
  for (const [token, field] of PLACEHOLDERS) {
    if (out.includes(token)) out = out.split(token).join(logo[field])
  }
  return out
}

/**
 * 把 src/logo.js 的占位符替换成 logo 数据。
 *
 * @param {{ projectRoot: string }} opts 必填 projectRoot（仓库根绝对路径）。
 */
export default function axzoLogoPlugin(opts) {
  const logoPath = resolveLogoPath(opts, 'axzo-logo')

  return {
    name: 'axzo-logo',
    enforce: 'pre',

    // 换 logo 后只需让 Vite 重跑 transform，path / viewBox 自动重算。
    configureServer(server) {
      server.watcher.add(logoPath)
    },

    buildStart() {
      this.addWatchFile(logoPath)
    },

    transform(code, id) {
      if (!id.endsWith(SRC_FILE)) return null
      return {
        code: replaceStrictly(code, resolveLogo(logoPath)),
        map: { mappings: '' }
      }
    }
  }
}

/**
 * dev 专用：把 logo 数据送进 preview 页。
 *
 * 两条通道各自解决一个问题：
 *   - 替换 HTML 里的占位符 → 说明文字里显示的 viewBox 是真值；
 *   - window.__AXZO_LOGO__ → preview/main.js 直接拿数据作画，不必 import
 *     （client/client.js 是自注册的 IIFE，对外没有可用的导出）。
 *
 * @param {{ projectRoot: string }} opts 必填 projectRoot（仓库根绝对路径）。
 */
export function axzoLogoPreviewPlugin(opts) {
  const logoPath = resolveLogoPath(opts, 'axzo-logo-preview')

  return {
    name: 'axzo-logo-preview',
    apply: 'serve',
    enforce: 'pre',

    configureServer(server) {
      server.watcher.add(logoPath)
    },

    transformIndexHtml(html) {
      const logo = resolveLogo(logoPath)
      const payload = JSON.stringify({
        ICON_PATH: logo.iconPath,
        TEXT_PATH: logo.textPath,
        ICON_VIEWBOX: logo.iconViewBox,
        TEXT_VIEWBOX: logo.textViewBox
      })
      return {
        html: replaceLoosely(html, logo),
        tags: [
          {
            tag: 'script',
            injectTo: 'head',
            children: 'window.__AXZO_LOGO__ = ' + payload
          }
        ]
      }
    }
  }
}
