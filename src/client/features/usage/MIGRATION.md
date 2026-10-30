# 用量查询客户端半边迁移对照表

> 源：`dsh-usage-query/src/*.js`（14 个**共享作用域片段**）
> 目标：`dsh-usage-aggregator/src/client/features/usage/`（15 个**真 ESM 模块**）
>
> 这是聚合插件里风险最高的一项：源插件的 14 个文件**不是模块**，是靠字符串拼接共享
> 同一个 factory 作用域的脚本片段（没有 import/export，靠标识符互相引用）。
> 整包改用 Vite + 真 ESM 之后，共享作用域消失，**每个跨模块引用的标识符都必须变成
> 显式 import**。一个漏掉就是运行时 ReferenceError —— 而且是「一渲染就崩」的那种。
>
> 本文件是「零能力丢失」审计的依据：逐模块列出「原本依赖了哪些共享标识符 → 现在从哪 import」，
> 外加一份「刻意未改」清单。

---

## 1. 文件对照

| 原文件 | 新文件 | 行数 | 说明 |
| --- | --- | --- | --- |
| `01-runtime.js` | **删除**（拆分到两处） | — | React 句柄 → `../../runtime.js`；常量 → `constants.js` |
| `02-i18n.js` | `i18n.js` | 252 | zh/en 逐字保留（108 key，与源一致）；`makeTranslator` 改走共享实现 |
| `03-api.js` | `api.js` | 44 | `callApi` → 共享；`ENDPOINT` → `USAGE_ENDPOINT` |
| `04-format.js` | `format.js` | 105 | 纯函数，原样搬 |
| `05-atoms.js` | `atoms.js` | 225 | 原样搬 + 补 import/export |
| `06-provider.js` | `provider.js` | 209 | 原样搬 + 补 import/export |
| `07-field-order.js` | `field-order.js` | 189 | 原样搬 + 补 import/export |
| `08-import.js` | `import-panel.js` | 110 | 原样搬 + 补 import/export |
| `09-model-picker.js` | `model-picker.js` | 169 | 原样搬 + 补 import/export |
| `10-hover.js` | `hover.js` | 169 | 原样搬 + 补 import/export |
| `11-quick.js` | `quick.js` | 399 | 原样搬 + 补 import/export |
| `12-panel.js` | `panel.js` | 173 | 原样搬 + 补 import/export；`BUILD_AT` 取法变了（见 §5） |
| `13-styles.js` | `styles.js` | 224 | CSS **逐条字节一致**（171 条规则） |
| `14-assembly.js` | `index.js` | 108 | 工厂返回值 → 具名导出；删 `inject`、删 `settings.section`、删 `locale.register` |
| —（新建） | `constants.js` | 43 | 承接 `01-runtime.js` 里的 6 个常量 |

---

## 2. 逐模块：共享标识符 → import 来源

### 2.1 `constants.js`（新建，承接 `01-runtime.js`）

| 标识符 | 原处 | 现在 |
| --- | --- | --- |
| `NS` | `01-runtime.js` `var NS = 'usage-query'` | 本文件 `export const NS = 'usage-query'` |
| `STYLE_ID` | `01-runtime.js` | 本文件 `export const STYLE_ID = 'dsh-usage-query-style'` |
| `PANEL_ID` | `01-runtime.js` | 本文件 `export const PANEL_ID = 'usage-query'` |
| `DEFAULT_VISIBLE` | `01-runtime.js` | 本文件 `export const DEFAULT_VISIBLE = 5` |
| `POP_GRACE_MS` | `01-runtime.js` | 本文件 `export const POP_GRACE_MS = 520` |
| `POP_SLACK_PX` | `01-runtime.js` | 本文件 `export const POP_SLACK_PX = 20` |
| `React` / `h` / `useState` / `useEffect` / `useRef` | `01-runtime.js`（`require('react')`） | `../../runtime.js`（`export let`，live binding） |
| `ENDPOINT` | `01-runtime.js` `'/dsh-usage-query'` | **不在本文件** → `../../shared/constants.js` 的 `USAGE_ENDPOINT` |

> ⚠️ `ENDPOINT` 刻意不放本地常量文件：路由前缀是客户端与 Host 之间的**路径契约**，
> 统一住在 `src/client/shared/constants.js`（值 `/dsh-usage-aggregator/usage`），
> 改前缀只改那一处。

### 2.2 `i18n.js`

| 标识符 | 原处 | 现在 |
| --- | --- | --- |
| `zh` / `en` | `02-i18n.js` | 本文件 `export const`（**逐字保留**，108 key 与源一致） |
| `NS` | 共享作用域 | `import { NS } from './constants.js'` |
| `makeTranslator` | `02-i18n.js` 本地实现 | `import { makeTranslator as sharedMakeTranslator } from '../../shared/i18n.js'`，本文件包一层：`return sharedMakeTranslator(locale, NS, zh)` |

### 2.3 `api.js`

| 标识符 | 原处 | 现在 |
| --- | --- | --- |
| `callApi` | `03-api.js` 本地实现 | `import { callApi } from '../../shared/api.js'` |
| `ENDPOINT` | `01-runtime.js` | `import { USAGE_ENDPOINT } from '../../shared/constants.js'` |

### 2.4 `format.js`

无跨模块依赖（叶子节点）。导出：`relativeTime` `clockTime` `durationText` `intervalText`
`dueText` `clipText` `statusTone`。

### 2.5 `atoms.js`

| 标识符 | 原处 | 现在 |
| --- | --- | --- |
| `h` `useState` | `01-runtime.js` | `../../runtime.js` |
| `DEFAULT_VISIBLE` | `01-runtime.js` | `./constants.js` |

导出：`Badge` `Bar` `Button` `MetricBlock` `CardGrid` `readImageFile` `ImageDrop` `Banner` `UsageView`。

### 2.6 `provider.js`

| 标识符 | 原处 | 现在 |
| --- | --- | --- |
| `React` `h` `useState` `useEffect` | `01-runtime.js` | `../../runtime.js` |
| `api` | `03-api.js` | `./api.js` |
| `clockTime` `durationText` `relativeTime` `statusTone` `dueText` | `04-format.js` | `./format.js` |
| `Badge` `Banner` `Button` `ImageDrop` `UsageView` | `05-atoms.js` | `./atoms.js` |
| `FieldOrderEditor` | `07-field-order.js` | `./field-order.js` |

导出：`ProviderDetail` `statusKey`（`statusKey` 顺带变成导出 —— `quick.js` 要用；
函数声明会提升，放文件开头还是末尾都一样）。

### 2.7 `field-order.js`

| 标识符 | 原处 | 现在 |
| --- | --- | --- |
| `h` `useState` `useEffect` `useRef` | `01-runtime.js` | `../../runtime.js` |
| `api` | `03-api.js` | `./api.js` |
| `Button` | `05-atoms.js` | `./atoms.js` |

导出：`fieldRows` `moveItem` `FieldOrderEditor`。

### 2.8 `import-panel.js`

| 标识符 | 原处 | 现在 |
| --- | --- | --- |
| `h` `useState` | `01-runtime.js` | `../../runtime.js` |
| `api` | `03-api.js` | `./api.js` |
| `Banner` `Button` `ImageDrop` `readImageFile` | `05-atoms.js` | `./atoms.js` |

导出：`ImportPanel`。

### 2.9 `model-picker.js`

| 标识符 | 原处 | 现在 |
| --- | --- | --- |
| `h` `useState` `useEffect` `useRef` | `01-runtime.js` | `../../runtime.js` |
| `api` | `03-api.js` | `./api.js` |

导出：`AnalysisModelPicker`。

### 2.10 `hover.js`

| 标识符 | 原处 | 现在 |
| --- | --- | --- |
| `h` | `01-runtime.js` | `../../runtime.js` |

导出：`UsageIcon` `pickChipProvider` `providerSummary` `isInsideRect` `isInsideUnion` `createHoverLiveness`。

### 2.11 `quick.js`

| 标识符 | 原处 | 现在 |
| --- | --- | --- |
| `h` `useState` `useEffect` `useRef` | `01-runtime.js` | `../../runtime.js` |
| `api` | `03-api.js` | `./api.js` |
| `clipText` `clockTime` `durationText` `relativeTime` `statusTone` | `04-format.js` | `./format.js` |
| `Badge` `Button` `UsageView` | `05-atoms.js` | `./atoms.js` |
| `statusKey` | `06-provider.js` | `./provider.js` |
| `UsageIcon` `createHoverLiveness` `pickChipProvider` `providerSummary` | `10-hover.js` | `./hover.js` |
| `POP_GRACE_MS` `POP_SLACK_PX` | `01-runtime.js` | `./constants.js` |
| `Styles` | `13-styles.js` | `./styles.js` |

导出：`QuickProvider` `QuickPopover` `UsageChip`。

### 2.12 `panel.js`

| 标识符 | 原处 | 现在 |
| --- | --- | --- |
| `h` `useState` `useEffect` | `01-runtime.js` | `../../runtime.js` |
| `api` | `03-api.js` | `./api.js` |
| `intervalText` `statusTone` | `04-format.js` | `./format.js` |
| `Banner` `Button` | `05-atoms.js` | `./atoms.js` |
| `ProviderDetail` | `06-provider.js` | `./provider.js` |
| `ImportPanel` | `08-import.js` | `./import-panel.js` |
| `AnalysisModelPicker` | `09-model-picker.js` | `./model-picker.js` |
| `BUILD_AT` | 构建脚本注入的全局 | 本文件顶部从 `globalThis` 取（见 §5） |

导出：`Panel`。

### 2.13 `styles.js`

| 标识符 | 原处 | 现在 |
| --- | --- | --- |
| `React` `h` | `01-runtime.js` | `../../runtime.js` |
| `STYLE_ID` | `01-runtime.js` | `./constants.js` |
| `Panel` | `12-panel.js` | `./panel.js` |

导出：`CSS` `Styles` `PanelShell`。

### 2.14 `index.js`（承接 `14-assembly.js`）

| 标识符 | 原处 | 现在 |
| --- | --- | --- |
| `h` | `01-runtime.js` | `../../runtime.js` |
| `zh` `en` | `02-i18n.js` | `./i18n.js` |
| `NS` `PANEL_ID` | `01-runtime.js` | `./constants.js` |
| 其余 `__ui` 成员 | 各源模块 | 逐个从对应模块 import |

---

## 3. import 图（无环）

```
index.js ──┬─→ i18n.js ──→ shared/i18n.js
           │                 constants.js
           ├─→ constants.js
           ├─→ styles.js ──→ panel.js ──┬─→ api.js ──→ shared/api.js
           │        │                   │           shared/constants.js
           │        │                   ├─→ format.js
           │        │                   ├─→ atoms.js ──→ constants.js
           │        │                   ├─→ provider.js ──→ field-order.js
           │        │                   ├─→ import-panel.js
           │        │                   └─→ model-picker.js
           └─→ quick.js ──→ hover.js
                    └────→ provider.js / atoms.js / format.js / styles.js / constants.js
```

`styles.js → panel.js`（PanelShell 要包 Panel），`quick.js → styles.js`（芯片要自带 `<Styles/>`），
`panel.js` **不**回头引 `styles.js` / `quick.js` —— 无环。

---

## 4. 功能契约

`src/client/features/usage/index.js` 导出：

| 导出 | 内容 |
| --- | --- |
| `meta` | `{ id: 'usage', namespace: 'usage-query', hubOrder: 20, hubTabKey: 'tabUsage' }` |
| `dictionaries` | `{ zh, en }` —— 完整字典，108 key 与源逐字一致（**不含** `hubTab`：页签标签归聚合页） |
| `apply(ctx, t)` | 只装配**会话头芯片**这一个槽位 |
| `HubView(props)` | 渲染 `PanelShell`（= `<Styles/>` + `<Panel/>`） |
| `__ui` | 23 个条目（21 个内部组件/函数 + `zh` + `en`），供离线渲染自检用 |

### 4.1 刻意**不再**注册的东西

| 原来 | 现在 | 为什么 |
| --- | --- | --- |
| `inject: ['slots', 'locale']` | 删除 | 聚合入口（`src/client/index.js`）统一声明 |
| `ctx.locale.register(NS, {zh, en})` | 删除 | 聚合入口统一注册各功能命名空间；本功能改为导出 `dictionaries` |
| `settings.section` 槽位（原 id `usage-query` / order 92） | 删除 | 设置面板只保留**一个**入口，由 `src/client/hub/panel.js` 注册（id `usage-aggregator` / order 92） |
| `makeTranslator` 的本地实现 | 改走 `shared/i18n.js` | 三个功能共用一份 translator 工厂；共享版多了命名空间参数与统一回退（fallback = zh），行为一致 |

### 4.2 刻意**保留**的槽位

```js
ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
  name: 'conversation.session.header.utilities',
  id: PANEL_ID,   // 'usage-query'
  order: 30,
  label: t('tab'),
  locale: NS,     // 'usage-query'
  inject: () => ({ t }),
}, (slotProps) => h(UsageChip, slotProps)));
```

会话头芯片与会话头有关，**不是**设置入口 —— 所以留着。

---

## 5. 唯一一处「实现变了但输出不变」的地方：`BUILD_AT`

原实现：构建脚本（`scripts/build-client.mjs`）在产物最外层注入 `var BUILD_AT = "2026-10-16 15:27:03";`，
`12-panel.js` 用 `typeof BUILD_AT === 'string'` 读它。

新的 Vite 构建改用 `define: { __BUILD_AT__: … }`（见 `vite/config.mjs`），
`panel.js` 跟着换读法，但**判定与降级完全一致**：

```js
/* global __BUILD_AT__ */
const BUILD_AT = (function () {
  if (typeof __BUILD_AT__ === 'string') return __BUILD_AT__;
  var scope = typeof globalThis !== 'undefined' ? globalThis : {};
  if (typeof scope.__DSH_CLIENT_BUILD_AT__ === 'string') return scope.__DSH_CLIENT_BUILD_AT__;
  return '';
})();
```

- 脚本文案 `　客户端构建于 <时间>。` **一字未改**；
- `typeof __BUILD_AT__` 对未声明标识符**不抛异常** —— 没注入 define 的构建
  （例如单独跑 esbuild 校验）也安全，true 分支根本不会被求值，页脚那一小段只是不显示；
- 带 define 的 esbuild 实测：`typeof __BUILD_AT__ === 'string'` → `true`，
  `__BUILD_AT__` → `"2026-10-30 11:40:00"`，与旧插件的行为一致；
- 聚合入口 `src/client/index.js` 用同一套 define，**聚合页自己也会显示构建时间**
  （那是聚合插件新增的，不替代这里这一行）。

---

## 6. 「刻意未改」清单（审计依据）

### 6.1 11 个 api 方法 / 11 条 Host 路由

Host 路由来自 `src/host/features/usage/`（另一项任务），前缀 `shared.base + /usage`；
客户端这边前缀是 `USAGE_ENDPOINT = '/dsh-usage-aggregator/usage'`。

| # | `api` 方法 | HTTP | 路径（原 `/dsh-usage-query…` → 现 `/dsh-usage-aggregator/usage…`） | 请求体 |
| --- | --- | --- | --- | --- |
| 1 | `state()` | GET | `/usage` | — |
| 2 | `importRequest(payload)` | POST | `/usage/import` | `{label?, replaceId?, text?, image?}` |
| 3 | `refresh(id)` | POST | `/usage/refresh` | `{id}` |
| 4 | `renew(id, interactive)` | POST | `/usage/renew` | `{id, interactive}` |
| 5 | `reanalyze(id, image)` | POST | `/usage/reanalyze` | `{id}` / `{id, image}` |
| 6 | `remove(id)` | POST | `/usage/remove` | `{id}` |
| 7 | `setFieldOrder(id, paths)` | POST | `/usage/order` | `{id, paths}` |
| 8 | `models()` | GET | `/usage/models` | — |
| 9 | `setChip(id)` | POST | `/usage/chip` | `{id}` |
| 10 | `setAnalysisModel(providerId, modelId)` | POST | `/usage/analysis-model` | `{provider, model}` |
| 11 | `raw(id)` | GET | `/usage/raw?id=…` | — |

**11 个方法一个不少，路径后缀与原插件逐条一致**（只有公共前缀变了）。

### 6.2 locale 命名空间

`NS = 'usage-query'` **未变**（`constants.js`）。
`dictionaries` 里 zh/en 各 108 个 key，**与源逐字一致**：脚本核对结果为「删除 0 个、
值变 0 个」。

页签标签**不在本字典里** —— 归聚合页自己的命名空间（`meta.hubTabKey` 指向
`src/client/hub/i18n.js` 的 `tabUsage`）。理由：同一个 locale 命名空间同时只能被
一个包注册，标签放在功能自己的命名空间下，新旧插件并存时功能探不到自己的字典，
页签上会出现裸的 key 名。

### 6.3 CSS

- **171 条规则逐条字节一致**（脚本核对：0 处不同）；
- 类名前缀 `duq-` **未变**（106 个类名）；
- 只用 `--dsw-alias-*` token（19 个 token，非 `--dsw-alias-` 的：0 个）；
- 样式用 `data-` 属性标记（`'data-dsh-usage-query': STYLE_ID`），**不是 `id`**；
- **不进 `document.head`**，也不 `document.createElement` / `appendChild` —— 样式随组件渲染。

### 6.4 交互设计细节（一字未改）

- **悬停关闭判定完全走几何**：`createHoverLiveness` + `isInsideRect` / `isInsideUnion`，
  矩形并集 + `POP_GRACE_MS = 520` 宽限 + `POP_SLACK_PX = 20` 容差；
  **不用** mouseenter / mouseleave / blur（三个坑的成因见 `hover.js` 注释）。
- **`FieldOrderEditor` 的 `signature` 依赖**（不是 `provider.id`）——「恢复默认」后本地不留旧顺序。
- **拖拽只挂 ⠿ 把手**——整行 draggable 的话点 ↑↓ 会误触发拖拽。
- **`AnalysisModelPicker` fixed 定位 + 挂载后自纠正偏移**（祖先有 transform/filter 时包含块会换人）。
- **每个挂载点各渲染一份 `<Styles/>`**：会话头芯片在设置面板之外，样式必须跟着组件走，
  否则裸 DOM 撑开页面。（`HubView` → `PanelShell` → `<Styles/>` + `<Panel/>`；
  `UsageChip` 内部自带一份 `<Styles/>`。）

### 6.5 其它

- `__ui` 保留 23 个条目，键名与原插件**完全一致**（离线渲染自检脚本按名字取）。
- 模块顶层**不调用 `h(...)`** —— React 要等聚合入口的 `installRuntime(require)` 之后才就绪
  （原来靠拼接时 `var h = React.createElement` 在 factory 里执行，位置不同了）。顶层只声明函数与常量。

---

## 7. 自检结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 语法 | `cp x.js /tmp/x.mjs && node --check /tmp/x.mjs`（逐个 14 个文件） | ✅ 14/14 通过 |
| 打包 | `npx esbuild src/client/features/usage/index.js --bundle --format=esm --external:react` | ✅ exit 0，无 error 无 warning |
| 全图打包 | `npx esbuild src/client/index.js --bundle --format=iife --external:react`（含 theme / expander） | ✅ exit 0，210.8kb；**6 条 warning 全部来自 `features/theme/i18n.js`（重复 key），本功能 0 条** |
| 标识符未定义 | ESLint `no-undef`（ESM + 浏览器 globals） | ✅ **0 error**；3 个 `no-unused-vars` warning 全部**继承自原代码**（`err` catch 参数 ×2、未使用的 `showRenew`） |
| 字典保真 | 自写脚本逐 key 比对 zh/en 与源 | ✅ 与源逐字相同：删除 0、值变 0（108 = 108） |
| CSS 保真 | 自写脚本逐条比对 | ✅ 171/171 字节一致 |
| 渲染 | `react-dom/server` 真渲染 15 个组件 | ✅ 全部通过；`PanelShell` / `HubView` / `UsageChip` 均含 `<style data-dsh-usage-query>` |
| 装配 | 模拟聚合入口的 4 个步骤 | ✅ 只注册 1 个槽位（会话头芯片），0 个 locale effect，无 `settings.section`，无 `inject` 导出 |
| 纯函数 | `pickChipProvider` / `moveItem` / `clipText` / `fieldRows` / `createHoverLiveness`（假时钟） | ✅ 行为与原实现一致（含 520ms 宽限、pinned 不关） |
| Host 路由对照 | 逐条比对 `src/host/features/usage/server.js` 的 11 条路由 | ✅ 11/11 方法与路径后缀一一对应（见 §6.1） |

