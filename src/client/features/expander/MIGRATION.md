# MIGRATION.md · dsh-plugin-expander 客户端半边 → dsh-usage-aggregator

本文件是「零能力丢失」审计的依据：逐条说明**原文件里有什么、现在在哪、为什么这么改**，
以及**哪些东西一个字都没动**。

---

## 1. 文件对照

| 原文件 | 新文件 | 说明 |
| --- | --- | --- |
| `/Users/gaozhipeng/Desktop/work/dsh-plugin-expander/client/client.js`（571 行，IIFE + `window.__ModuleLoader__.load`） | `src/client/features/expander/index.js`（570 行，ESM 模块） | 整文件搬运；外壳拆掉后行数几乎不变 —— 少的 1 行是 IIFE 的收尾。 |
| 同上 · `factory` 里的 `var React = require('react')` 等 5 行 | `src/client/runtime.js`（共享）→ `import { React, h, useState, useEffect, useCallback } from '../../runtime.js'` | React 由聚合入口的 `installRuntime(require)` 注入，全插件一个入口。 |
| 同上 · `var ENDPOINT = '/dsh-plugin-expander'` | `src/client/shared/constants.js` → `import { EXPANDER_ENDPOINT } from '../../shared/constants.js'` | 路由前缀成为跨半边契约的一部分，只写一处。 |
| 同上 · 本文件里的 `function callApi(method, path, body)` | `src/client/shared/api.js` → `import { callApi } from '../../shared/api.js'` | 失败翻译逻辑与原实现等价（见 §3.4）。 |
| 同上 · 本文件里的 `function makeTranslator(locale)` | `src/client/shared/i18n.js` → `import { makeTranslator } from '../../shared/i18n.js'` | 调用形式变成 `makeTranslator(locale, NS, zh)`（共享版多收命名空间与回退字典两个参数）。 |
| 同上 · `var zh = {…}` / `var en = {…}` | 同文件内的 `const zh = {…}` / `const en = {…}`，并以 `export const dictionaries = { zh, en }` 导出 | 原有 29 个 key 逐字保留；**新增** 5 个忙碌态/进度文案；**移除** `hubTab`（页签标签归聚合页）。 |
| 同上 · `apply: function (ctx) {…}` | `export function apply(ctx, t) {…}` | 签名多一个 `t`（聚合入口传进来的 translator）。 |
| 同上 · `inject: ['slots', 'locale']` | —— | **删除**：聚合入口 `src/client/index.js` 统一声明 `inject = ['slots', 'locale', 'theme']`。 |
| 同上 · `ctx.locale.register(NS, { zh, en })` 那一段 effect | —— | **删除**：聚合入口统一注册各功能命名空间（`ctx.locale.register(feature.meta.namespace, feature.dictionaries)`）。 |
| 同上 · `return { inject, __ui, apply }`（工厂返回值） | `export const meta / dictionaries / apply / HubView / __ui`（具名导出） | 改成聚合插件的**功能契约**（见 `src/client/features/index.js` 顶部的说明）。 |
| 同上 ·（没有） | `export function HubView(props)`（**新增**） | 聚合设置页里本功能的视图。 |
| `dsh-plugin-expander/scripts/ui-check.mjs` | 由聚合插件的 `scripts/render-check.mjs` 接手（工具链同事负责） | 本文件继续导出 `__ui`，自检入口不变。 |

---

## 2. 目标契约

```js
export const meta = { id: 'expander', namespace: 'pluginExpander', hubOrder: 30, hubTabKey: 'tabExpander', hubDefault: true }
export const dictionaries = { zh, en }     // 34 个 key = 原 29 个 + 5 个忙碌态/进度文案
export function apply(ctx, t) { … }        // 只装配本功能自己的槽位
export function HubView(props) { … }       // props = { t, ctx }
export const __ui = { … }                  // 离线渲染自检入口
```

`hubOrder 30` —— 主题 10 / 用量 20 / 插件更新 30（主题是原主角，用量次之，插件更新最后）。

---

## 3. 逐处改动与理由

### 3.1 拆掉外壳

- **改动**：删掉最外层 IIFE 与 `window.__ModuleLoader__.load({ id, factory })`，文件本身变成 ESM 模块。
- **理由**：`window.__ModuleLoader__.load` 由聚合入口 `src/client/index.js` 统一调用（那里才知道插件 id = `dsh-usage-aggregator`）。功能模块只负责导出契约，入口只负责装配 —— 职责分开后，新增功能不必再碰外壳。

### 3.2 React 从共享 runtime 取

- **改动**：`var React = require('react')` + `var h = React.createElement` 等 → `import { React, h, useState, useEffect, useCallback } from '../../runtime.js'`。
- **理由**：`require` 只在聚合入口的 factory 里存在（宿主注入），功能模块拿不到；共享 runtime 把「React 是外部注入的」这件事收敛到唯一一个文件。
- **注意**：`runtime.js` 用的是 `export let` + 活绑定，`installRuntime()` 之后 `h` / `useState` 立刻变成真值。因此**模块顶层不得调用 `h(...)`** —— 本文件顶层只有常量与函数声明，渲染全部发生在组件函数体内。

### 3.3 ENDPOINT

- **改动**：`var ENDPOINT = '/dsh-plugin-expander'` → `import { EXPANDER_ENDPOINT } from '../../shared/constants.js'`（值 `/dsh-usage-aggregator/expander`）。
- **理由**：客户端 bundle 在浏览器里独立加载，读不到 Host 的 config，路由前缀只能两边各写一份 —— 聚合之后把它收进 `constants.js` 这**唯一一处**。
- **对端已核对**：Host 半边 `src/host/features/expander/server.js` 注册的是 `GET <base>/state` 与 `POST <base>/update`（`base` = `shared.base + '/expander'`），与本文件拼出的 URL 完全对得上。

### 3.4 callApi

- **改动**：本文件里的 `callApi` 定义删掉，改 `import { callApi } from '../../shared/api.js'`。
- **理由**：与用量查询共用同一份同源 HTTP 封装。
- **等价性已逐条核对**（8 种响应形态，共享版与原版结果逐字相同）：

  | 场景 | 结果 |
  | --- | --- |
  | 返回 HTML（SPA 兜底） | `Host 侧路由不可用：插件已更新但进程还没重启，重启 dsh web 后再试` |
  | 404 / 405 | 同上（405 在 body 不是 HTML 时为 `HTTP 405`） |
  | `{ok:false,error}` | 抛出 `error` 原文 |
  | HTTP 500 + error | `HTTP 500：<error>` |
  | 非 JSON 文本 | `返回不是 JSON：<前 160 字>` |
  | 正常 JSON / 空 body | 原样返回 / `{}` |

### 3.5 makeTranslator

- **改动**：`function makeTranslator(locale) {…}` 删掉，改 `import { makeTranslator } from '../../shared/i18n.js'`，调用形式 `makeTranslator(locale, NS, zh)`。
- **理由**：共享版多收「命名空间」与「回退字典」两个参数，才能服务三个命名空间各自独立的字典。
- **行为保留**：共享版与原版一样 —— **永远返回非空字符串**（`t()` 返回 `undefined` 会让整块渲染崩），`en` 缺 key 时回落到 `zh`（两者都再回落到 key 本身）。
- **调用点**：聚合入口已经绑好了本命名空间的 translator 并传进来（`apply(ctx, t)`）；`apply` 里仍保留一道兜底 —— 没拿到 `t` 时用 `makeTranslator(ctx.locale, NS, zh)` 自己绑一次（独立装配时用得上）。

### 3.6 字典

- **改动**：`var zh` / `var en` → `const zh` / `const en`，并导出 `dictionaries = { zh, en }`。原有 29 个 key **内容逐字未动**；新增 5 个忙碌态 / 进度文案；移除了 `hubTab`：

  | | zh | en |
  | --- | --- | --- |
  | `checking` | `检查中…` | `Checking…` |
  | `updating` | `正在更新中` | `Updating` |
  | `progress` | `已完成 {done} / {total}` | `{done} of {total} done` |
  | `current` | `当前：{name}` | `Current: {name}` |
  | `updateAllRunning` | `正在更新 {count} 个插件…` | `Updating {count} plugin(s)…` |

- **核对**：原 29 个 key 全部保留、值逐字相同（脚本逐 key 比对：`zh` 29→34、`en` 29→34，多出来的只有上面 5 个新键）。
- **页签标签不在本字典里** —— 归聚合页自己的命名空间（`meta.hubTabKey` 指向
  `src/client/hub/i18n.js` 的 `tabExpander`）。理由：同一个 locale 命名空间同时只能
  被一个包注册，标签放在功能自己的命名空间下，新旧插件并存时功能探不到自己的
  字典，页签上会出现裸的 key 名（这个坑踩过）。
- **`meta.hubDefault = true`** —— 本页签是聚合页**默认选中**的那一页：打开设置页
  就先自动检测可更新的插件。

### 3.7 删掉 inject 导出与 locale 注册

- **改动**：
  - 删 `inject: ['slots', 'locale']` —— 聚合入口统一声明。
  - 删 `ctx.locale.register(NS, { zh, en })` 那一段 effect（含它的 try/catch 与 disposer）—— 聚合入口按 `feature.meta.namespace` + `feature.dictionaries` 统一注册。
- **理由**：这正是本次聚合要消除的重复：命名空间注册、依赖声明都只留一处。
- **副作用已核对**：`locale.register` 对同一 (命名空间, 语言) 重复注册会抛错，所以留在本文件里反而会炸（主题功能的同款问题见 `src/client/features/theme/index.js` 的 `namespaceRegistered` 探测）。

### 3.8 保留 plugins.tab 槽位注册

- **改动**：签名从 `apply(ctx)` 变成 `apply(ctx, t)`；注册项本身**一字未改**：

  ```js
  ctx.slots.inject('plugins.tab', function () {
    return ctx.slots.register({
      name: 'plugins.tab',
      id: 'updates',
      order: 20,
      label: function () { return translator('tab'); },
      locale: NS,
      inject: function () { return { t: translator }; }
    }, function () {
      return h(UpdatesTab, { t: translator });
    });
  });
  ```

- **`label` 必须是函数**（不是字符串）：宿主每次投影都重新求值，切换语言不必重新注册 —— 原代码本来就是对的，**没有改成字符串**。
- `translator` 就是聚合入口传进来的 `t`（`typeof t === 'function' ? t : makeTranslator(...)`），与原代码里 `var t = makeTranslator(ctx.locale)` 的效果等价。

### 3.9 保留 `__ui` 导出

- **改动**：原样保留 8 个键 —— `UpdatesTab` / `PackageRow` / `Styles` / `statusText` / `kindText` / `fallbackTranslate` / `zh` / `en`。
- **理由**：离线渲染自检（`scripts/render-check.mjs`）靠它在没有浏览器的环境里用 `react-dom/server` 真渲染一遍，抓「组件一渲染就崩」。运行时不受影响（聚合入口只认 `meta` / `dictionaries` / `apply` / `HubView`）。

### 3.10 样式

- **改动**：CSS 字符串**逐字未动**（42 条规则，脚本逐条比对 byte-identical）；渲染方式仍是 `<style data-dsh-plugin-expander="dsh-plugin-expander-style">` 组件，**不注入 `document.head`**。
- **核对**：CSS 里没有 `#rrggbb`、没有 `rgb()`/`hsl()`；用到的 15 个自定义属性**全部**是 `--dsw-alias-*` token；42 个 `.dpe-` 类名一个不少。

### 3.11 交互语义全部保留

状态**全部**挂在组件内（`state` / `selected` / `busy` / `error` / `message`）：

- 槽位注册的渲染函数每次渲染都新建一个组件实例 —— 状态挂在 `apply()` 里会在 Hook 调用处直接崩（原注释已经写明这一点）。
- 首次挂载强制 `load(true)`（重查注册表）。
- 任务运行中每 **2000ms** 轮询 `load(false)`。
- 运行状态从 `running=true` 变 `false` 时解除置灰，并按 `results` 里 `ok !== true` 的条数报 `done` / `failed`，随后 `setSelected([])` 并 `load(true)` 刷新清单。

### 3.12 新增 HubView

```js
export function HubView(props) {
  const t = typeof props.t === 'function' ? props.t : fallbackTranslate;
  return h(React.Fragment, null, h(Styles, null), h(UpdatesTab, { t: t }));
}
```

- 聚合页用 `h(View, { t, ctx })` 渲染，与另外两个功能（主题 / 用量）同构。
- `Styles` 在这里多渲染了一份：这是**无害的重复** —— `UpdatesTab` 内部自己也带一份（原代码如此，样式跟着组件走，插件页那个槽位不在设置面板里、必须自带样式），两份 CSS 内容完全相同，浏览器行为一致。
- `props.t` 缺失时退回 `fallbackTranslate`（永远返回非空字符串），避免整页渲染崩。

### 3.13 顶部注释

- **改动**：路径与「自包含的单文件 / 没有 src 拆分与构建脚本」的说明，改写成新结构（ESM 模块 + 共享内核 + 聚合入口负责 `__ModuleLoader__.load`）。

---

## 4. 刻意未改（对外可见的既有契约）

| 项 | 值 | 为什么不能动 |
| --- | --- | --- |
| locale 命名空间 | `pluginExpander` | 改名会让新旧命名空间并存（locale 服务按命名空间存字典，旧的不注销就一直占着），且已装插件的用户切语言会看到混合文案。 |
| `plugins.tab` 的 `id` | `updates` | 宿主侧的槽位投影按 id 认领；改了就是「标签页消失」。 |
| `plugins.tab` 的 `order` | `20` | 决定它在插件页里的位置。 |
| `plugins.tab` 的 `name` / `locale` | `plugins.tab` / `pluginExpander` | 槽位归属与字典归属。 |
| `label` 的形式 | **函数**（不是字符串） | 语言切换时重算，不必重新注册。 |
| CSS 类名前缀 | `dpe-`（42 个） | 离线自检与外部样式定位都按这个前缀找。 |
| CSS token 用法 | 只用 `--dsw-alias-*`，不写死颜色 | 浅色 / 深色两边都跟着宿主主题走；自检脚本会断言没有 `#rrggbb`。 |
| `<style>` 的 data 标记 | `data-dsh-plugin-expander="dsh-plugin-expander-style"` | 离线自检按它定位样式节点。 |
| 轮询节奏 | 2000ms | 更新任务的进度刷新频率。 |
| 状态位置 | 全部在组件内 | 挂在 `apply()` 里会在 Hook 调用处崩。 |
| 字典 key 与文案 | 29 个 key 逐字保留 | 文案是对外可见的既有内容；另加 5 个忙碌态/进度文案。 |
| `__ui` 的 8 个键 | 原样 | 离线自检的入口。 |

---

## 5. 验证记录

| 检查 | 命令 / 方式 | 结果 |
| --- | --- | --- |
| 语法 | `cp index.js /tmp/x.mjs && node --check /tmp/x.mjs` | ✅ 通过 |
| 打包（抓漏掉的 import） | `npx --yes esbuild src/client/features/expander/index.js --bundle --outfile=/dev/null --format=esm` | ✅ 通过（20.5kb，无告警） |
| 字典逐 key 比对 | 脚本比对原 29 key 的值 | ✅ 全部相同；新增的只有 5 个忙碌态/进度文案 |
| CSS 逐条比对 | 脚本比对 42 条规则 | ✅ byte-identical；无 `#rrggbb` / `rgb()` / `hsl()`；自定义属性全为 `--dsw-alias-*` |
| 逻辑等价性 | 归一化（去注释 / `var`→`const` / `function`→箭头）后逐块 diff：`PackageRow` / `UpdatesTab` / `statusText` / `kindText` / `Styles` / `fallbackTranslate` | ✅ 六块全部等价 |
| `apply` 等价性 | 同上 | ✅ 除删除 locale 注册、把 `t` 换成同义的 `translator` 外一致 |
| `callApi` 等价性 | 8 种响应形态逐条对拍 | ✅ 结果逐字相同 |
| 真渲染（react 18.3.1 + react-dom/server） | 9 项断言：契约、字典、槽位注册、locale 不自行注册、translator 回落、UpdatesTab 用真机夹具渲染、HubView 渲染、样式无写死颜色、状态/来源文案 | ✅ 9/9 通过 |
| 跨半边路由对账 | Host `server.js` 的 `GET <base>/state` / `POST <base>/update` vs 客户端拼出的 URL | ✅ 一致 |
| 聚合装配全流程（走 `src/client/features/index.js` registry） | 模拟 `src/client/index.js` 的 apply：注册三个命名空间 → 取三个 translator → 依次 apply | ✅ 三个功能契约齐全（`hubTabKey` 齐备）；命名空间 `settings.axzoTheme` / `usage-query` / `pluginExpander`；槽位里 `plugins.tab` = `{name:'plugins.tab', id:'updates', order:20, locale:'pluginExpander'}`（`label` 是函数） |
| 真实 Vite 构建产物 | `client/client.js`（工具链同事构建） | ✅ 产物里 `var EXPANDER_ENDPOINT = ENDPOINT_BASE + "/expander";` 与 `callApi("GET", EXPANDER_ENDPOINT + "/state" …)` / `callApi("POST", EXPANDER_ENDPOINT + "/update", payload)` 均在 |
