// vite.config.mjs
//
// 单一 Vite 配置，覆盖三种模式：
//   1. `pnpm build`       —— 生产构建，产物写到 client/client.js（DSH 加载它）
//   2. `pnpm build:watch` —— 增量构建，DSH 的 client-hmr 直接接力
//   3. `pnpm dev`         —— 本地浏览器预览（Vite dev server）
//
// 为什么整个聚合插件只用这一个构建链
// --------------------------------
// 迁移前三个插件有三套构建方式：Vite 打包（主题）、字符串拼接（用量查询）、
// 手写单文件（插件更新）。合并成一个插件后**必须只剩一个 client/client.js** ——
// DSH 的客户端加载器按包名注册**一个**模块，产物也只有这一个入口。
//
// 拼接方式在这里是**行不通**的：用量查询原来的 14 个 src 模块靠共享同一个
// factory 作用域互相引用标识符，与主题的 ESM 顶层名（h / useState / NS /
// STYLE_ID / zh / en / Panel…）硬冲突，裸拼会直接 SyntaxError。
// 所以统一到 Vite + 真 ESM：每个模块有自己的作用域，名字随便取。
//
// 关于 entry：src/client/index.js 是入口（它自己调 window.__ModuleLoader__.load
// 注册插件），打成 IIFE 正是 DSH 用 script 标签加载它时需要的形态。lib.name 是
// Rolldown 对 iife 的硬性要求（必须是合法 JS 标识符）；DSH 不走 IIFE 的自动
// 导出，这个名字不会被任何代码引用。
//
// 关于 sourcemap：关闭。DSH 的 dsh-client-modules 只在 client.js.map 存在时
// 才去读它（readSourceMapSnapshot 先 stat，缺失就跳过），所以不产 map 不影响
// 加载。
//
// 关于 banner：横幅必须用 output.banner 发，不能在插件 transform 里拼 ——
// transform 返回的注释会被剥掉，横幅活不到产物里。

import { defineConfig } from 'vite';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import axzoLogoPlugin, { axzoLogoPreviewPlugin } from './vite/axzo-logo-plugin.mjs';

// 仓库根 = 本文件所在目录。这里读 import.meta.url 是安全的：vite.config.mjs
// 由 Vite 直接加载，不在被 bundle 的插件链里。
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));

/** 产物横幅。scripts/verify.sh 会断言它确实出现在 client/client.js 里。 */
const BANNER = [
  '/* dsh-usage-aggregator client — 由 pnpm build 从 src/client/ 生成，请勿直接编辑。 */',
  '/* 品牌路径源自 assets/axzo-official-logo.svg（安心筑官方 logo）。 */',
].join('\n');

/**
 * 本地时间戳：页面上一旦显示旧的构建时间，就不用再靠「改了什么、什么时候启的」
 * 倒推了。用本地时间而不是 ISO 的 UTC —— 页面上写 07:26 而用户本地是 15:26，
 * 只会让人以为看错了。
 *
 * @returns {string} YYYY-MM-DD HH:mm:ss。
 */
function buildStamp() {
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

export default defineConfig(({ command, mode }) => {
  const isDev = command === 'serve';
  const isWatchBuild = mode === 'watch';

  return {
    plugins: [
      // build + dev：替换主题功能 logo.js 里的占位符。
      axzoLogoPlugin({ projectRoot: PROJECT_ROOT }),
      // 仅 dev：把 logo 数据送进 preview 页。
      ...(isDev ? [axzoLogoPreviewPlugin({ projectRoot: PROJECT_ROOT })] : []),
    ],

    // 构建时间戳注入：客户端入口读 __BUILD_AT__，聚合设置页会显示它。
    define: {
      __BUILD_AT__: JSON.stringify(buildStamp()),
    },

    // dev 模式以 preview/ 为 root（浏览器预览入口在那里）；build 模式回到
    // 仓库根，那里才有 src/client/。
    root: isDev ? 'preview' : '.',
    publicDir: false,
    clearScreen: false,

    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      open: false,
    },

    build: {
      watch: isWatchBuild ? {} : null,
      // 产物直接覆盖 client/client.js —— 与 package.json 的
      // exports["./client"] 指向同一路径。
      // 源码在 src/client/，与产物目录 client/ 不重叠。
      outDir: './client',
      emptyOutDir: false,
      lib: {
        entry: 'src/client/index.js',
        name: 'dshUsageAggregator',
        formats: ['iife'],
        fileName: () => 'client.js',
      },
      rollupOptions: {
        output: {
          // 横幅拼在代码之前，不参与注释剥离，能活着进产物。
          banner: BANNER,
        },
      },
      sourcemap: false,
      minify: false,
      target: 'esnext',
    },
  };
});
