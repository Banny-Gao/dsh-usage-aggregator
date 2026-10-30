# ADR 0003 · 统一的客户端构建链（Vite + 真 ESM）

- **状态**：已采纳
- **日期**：2026-10-30

## 背景

迁移前三个插件有三套客户端构建方式：

| 插件 | 方式 | 源码形态 |
|---|---|---|
| `dsh-axzo-theme` | Vite 8（`build.lib` / IIFE） | 真 ESM，有 import/export |
| `dsh-usage-query` | `scripts/build-client.mjs` 纯字符串拼接 | **无 import 的脚本片段**，14 个文件靠共享同一个 factory 作用域互相引用标识符 |
| `dsh-plugin-expander` | 无构建 | 手写单文件 571 行 |

聚合后必须只剩**一个** `client/client.js`。

## 决策

**统一到 Vite + 真 ESM**。把用量查询的 14 个片段改写成真模块（每个跨模块引用变成显式 import），插件更新的单文件改写成 ESM 模块，主题的代码基本原样保留。

## 理由

1. **拼接方式在这里行不通。** 用量查询的顶层标识符（`h` / `useState` / `useEffect` / `React` / `NS` / `STYLE_ID` / `zh` / `en` / `makeTranslator` / `Panel` / `Styles` / `CSS` / `api` / `callApi` / `t` …）与主题的 ESM 顶层名**硬冲突** —— 同一个作用域里 `var`/`let` 重声明就是 `SyntaxError`，裸拼直接构建失败。
2. **反过来把主题改成片段，工作量更大**：主题有 20 个 ESM 模块，要逐个去掉 import/export 并补齐共享作用域依赖。
3. **ESM 天然给出隔离**：每个模块有自己的作用域，标识符随便取。这正是「三个功能共存」需要的东西。
4. **Vite 已经就位**：主题那套 `build.lib` / IIFE / `output.banner` / 自定义 transform 插件直接复用，不用从零搭。`dev:watch` 还能接上 DSH 的 client-hmr。
5. **logo 注入需要一个 transform 钩子**，Vite 的插件机制正好干这个（严格占位符替换 —— 占位符必须出现且只出现一次，否则构建期抛错，而不是产出一个渲染空白 logo 的包）。

## 后果

- **正面**：一条构建链、一个产物、一个 `inject` 声明点；将来加功能只需要写 ESM。
- **负面**：构建从「零依赖可离线构建」变成「依赖 vite」（devDependency，不是运行时依赖）。用量查询原来的 `scripts/build-client.mjs` 拼接触发器被 Vite 取代。
- **代价**：用量查询那 14 个文件的改造是本次迁移里最容易出错的一步 —— 漏掉一个 import 就是「一渲染就崩」。因此配套做了两件事：① `esbuild --bundle` 一次性抓出所有漏掉的引用；② `scripts/check-client.mjs` 在真实 cordis reflect 层的 Proxy 模拟器里跑一遍 `apply`。
- **保留**：`minify:false` + `target:esnext` + 不产 sourcemap（DSH 只在 `client.js.map` 存在时才读它），与主题原做法一致。

## 备选方案

- **保留拼接，但给每个功能包一层 IIFE 命名空间**：改动最小（每个功能整体缩进一层）。但拼接器要手工维护 `ORDER` 数组（顺序即依赖），加功能就要改构建脚本；且嵌套 IIFE 里再写 ESM 风格的 import/export 不成立。放弃。
- **多入口 Vite 构建**：DSH 只加载 `exports["./client"]` 指向的那一个文件，多入口产出没人加载。放弃。
