# 主题功能迁移对照表（dsh-axzo-theme → dsh-usage-aggregator）

本文是「零能力丢失」审计的依据。逐条说明：**哪个文件搬到哪、每一处改动为什么改、
以及哪些标识符是刻意保持不变的**（改了就会丢用户数据 / 破坏公共契约）。

- 源：`/Users/gaozhipeng/Desktop/work/dsh-axzo-theme/src/`（18 个模块，真 ESM）
- 目标：`src/client/features/theme/`（17 个文件）

---

## 一、文件对照表

| 原文件 | 新文件 | 改动 |
|---|---|---|
| `src/index.js` | `src/client/features/theme/index.js` | 合并（见下） |
| `src/plugin.js` | `src/client/features/theme/index.js` | 合并（见下） |
| `src/runtime.js` | — | **删除**，改用共享的 `src/client/runtime.js` |
| `src/constants.js` | `constants.js` | 仅注释 + 头部路径 |
| `src/color.js` | `color.js` | 仅头部路径 |
| `src/logo.js` | `logo.js` | 仅头部路径 + 一处 `src/` 引用 |
| `src/os-prefs.js` | `os-prefs.js` | **新增 `stopOsPrefs()` / `startOsPrefs()`** |
| `src/storage.js` | `storage.js` | 仅头部路径 |
| `src/prefs.js` | `prefs.js` | runtime import 路径 + 头部路径 |
| `src/brand.js` | `brand.js` | 仅头部路径 |
| `src/brand-mark.js` | `brand-mark.js` | runtime import 路径 + 头部路径 |
| `src/hero.js` | `hero.js` | runtime import 路径 + 头部路径 |
| `src/i18n.js` | `i18n.js` | `makeTranslator` 委托共享实现；字典逐字保留（60 key，与源一致） |
| `src/panel.js` | `panel.js` | runtime import 路径 + 头部路径 |
| `src/styles.js` | `styles.js` | 仅头部路径 |
| `src/tasks.js` | `tasks.js` | 仅头部路径 |
| `src/tokens.js` | `tokens.js` | 仅头部路径 |
| `src/assets.js` | `assets.js` | runtime import 路径 + 头部路径 |

`src/index.js` + `src/plugin.js` → 新 `index.js` 的映射：

| 旧 | 新 |
|---|---|
| `src/index.js` 的 `window.__ModuleLoader__.load({...})` | **删除**（聚合入口 `src/client/index.js` 负责） |
| `src/index.js` 的 `installRuntime(require)` 调用 | **删除**（聚合入口已调；本功能不得重复调） |
| `src/plugin.js` 的 `export const inject = [...]` | **删除**（聚合入口统一声明 `['slots','locale','theme']`） |
| `src/plugin.js` 的 `export function apply(ctx)` | `export function apply(ctx, t)` |
| `src/plugin.js` 的 `settings.section` 槽位注册 | **删除**（聚合页 `src/client/hub/panel.js` 统一注册） |
| — | 新增 `export const meta` / `export const dictionaries` / `export const HubView` |

---

## 二、逐处改动与理由

### 1. runtime 依赖

- **删除** `src/runtime.js`（旧插件自带的 React 注入点），全部改为
  `import { h, useState, useEffect, useCallback, reactDom } from '../../runtime.js'`
  （共享内核 `src/client/runtime.js`，全插件唯一注入点）。
- 受影响文件：`prefs.js`、`brand-mark.js`、`hero.js`、`panel.js`、`assets.js`。
- 共享 runtime 额外导出 `useRef` / `useMemo` / `React`，本功能没用到，不引入。
- `installRuntime` **不在这里调用** —— 聚合入口 `src/client/index.js` 的 factory 已调。

### 2. `os-prefs.js`：补上 disposer（唯一的行为性改动）

- 旧实现在**模块顶层**注册 3 条 `matchMedia` 监听（`prefers-reduced-motion: reduce` /
  `prefers-contrast: more` / `prefers-contrast: less`），**没有 disposer** —— 既有隐患：
  插件被反复 apply 时监听会越积越多。
- 改法：导出 `stopOsPrefs()`（摘掉 3 条监听），由 `index.js` 的 apply 在 effect cleanup 里调用。
  另导出 `startOsPrefs()`（幂等补注册），保证插件被 dispose 再 apply 时监听能自动回来。
- **`osFlagOverrides()` / `osTintMax()` 的 API 与行为完全不变**；模块加载时仍然
  `detectOsPrefs()` + 注册监听（旧行为原样保留）。
- 新增 effect：`<PLUGIN_ID>: os prefs`。

### 3. `i18n.js`：字典 + translator

- zh / en 字典**逐字保留**（60 个 key，与源 `src/i18n.js` 完全一致，双语 key 集合相同）。
- 页签标签**不在本字典里** —— 归聚合页自己的命名空间（`meta.hubTabKey` 指向
  `src/client/hub/i18n.js` 的 `tabTheme`）。理由：同一个 locale 命名空间同时只能
  被一个包注册，标签放在功能自己的命名空间下，新旧插件并存时功能探不到自己的
  字典，页签上会出现裸的 key 名。
- `makeTranslator(locale)` 改为委托共享实现：
  `sharedMakeTranslator(locale, NS, zh)`。
  行为不变：命名空间仍是 `settings.axzoTheme`、回落字典仍是本文件的 zh、
  **永远返回非空字符串**、en 缺 key 回落 zh。
  唯一多出来的能力：translator 支持第二个参数 `vars` 做 `{name}` 插值（共享实现带的）。
  旧调用点全都只传 key —— 行为不变。
  （`panel.js` 里的 `t("previewReply").replace("{hex}", hex)` 仍然成立：
  共享实现在 `vars === undefined` 时原样返回文本。）

### 4. `index.js`：功能契约

```js
export const meta = { id: 'theme', namespace: NS, hubOrder: 10 };
export const dictionaries = { zh, en };
export function apply(ctx, t) { ... }
export const HubView = (props) => h(Panel, props);
```

- `HubView` 原样透传 props：聚合页用 `h(View, { t, ctx })` 渲染，而原 `Panel`
  收到的正是 `{ t, ctx }`（旧 `settings.section` 的 `inject()` 返回值）。
- `apply(ctx, t)` 里 `translator` 优先用聚合入口传入的 `t`（已绑定到本命名空间），
  拿不到时退回本功能自己的 `makeTranslator(ctx.locale)`（独立装配时自洽）。

### 5. locale 注册：避免与聚合入口重复注册

- 聚合入口 `src/client/index.js` 已经用 `feature.dictionaries` 注册了本命名空间。
  DSH 的 locale 服务对同一个 `(命名空间, 语言)` **重复注册会直接抛错**
  （`locale namespace "..." already has locale "..."`）。
- 所以 `apply` 里的 locale effect 改成：**先探测命名空间是否已注册，没注册才补注册**。
  - 被聚合入口装配时 → 跳过，不重复注册，也不会误 dispose 掉别人的注册；
  - 本功能被单独使用时 → 仍然自洽地注册自己的字典。
- 探测用一个**只属于本字典**的 key（`sectionPreset`）：未注册时 locale 服务回落成 key 本身。

### 6. `constants.js`：PLUGIN_ID 的语义变了，值没变

- `PLUGIN_ID = "dsh-axzo-theme"` 的**值保持不变**。
- 语义变了：它不再是包名，而是 `ctx.theme.overrideTokens(source, tokens)` 的
  **source 标识**。
- 为什么不能改：DSH 的 theme service 是「一 source 一层」，换 source 会与迁移期间
  仍然装着的旧插件形成**双层叠加**（两套色盘互相覆盖，谁后注册谁赢）。
- 常量表里补了注释，说明哪些是「对外可见的既有标识」。

### 7. 槽位与 DOM 副作用

**槽位注册逐条对齐（唯一删除的是 `settings.section`）：**

| 槽位 | 组件 | priority / order / id | 状态 |
|---|---|---|---|
| `sidebar.brand.mark` | `BrandMark` | priority `-1` | ✅ 保留 |
| `sidebar.brand.name` | `BrandName` | priority `-1` | ✅ 保留 |
| `conversation.hero.brand.mark` | `HeroBrandMark` | priority `-1` | ✅ 保留（可开关，关闭时真正让出槽位） |
| `sidebar.footer.action` | `BackdropHost` | id `axzo-backdrop`、order `900` | ✅ 保留 |
| `sidebar.footer.action` | `SidebarDecorHost` | id `axzo-sidebar`、order `901` | ✅ 保留 |
| `settings.section` | `Panel` | id `axzo-theme`、order `93` | ❌ **删除** —— 聚合页统一注册 |

- `sessions` 继续用 `ctx.inject(['sessions'], cb)` **可选注入**，绝没有进硬 inject 数组。
- `TASK.t = translator` 保留 —— 任务徽标的中英文案靠它。
- `ctx.theme` 缺失时仍然 `console.warn`（旧行为）。

---

## 三、刻意未改的关键标识符（零能力丢失清单）

> 下列全部是**跨插件 / 跨会话可见的既有契约**。改了会丢用户数据、破坏公共契约，
> 或者在迁移期与仍装着的旧插件打架。

| 类别 | 标识符 | 数量 |
|---|---|---|
| localStorage key | `dsh-axzo-theme:primary`、`dsh-axzo-theme:fx`、`dsh-axzo-theme:brand` | 3 |
| locale 命名空间 | `settings.axzoTheme` | 1 |
| 主题 token 名 | 43 个（26 个 `--dsw-*` + 17 个 `--dsh-axzo-*`） | 43 |
| CSS 变量名 | 17 个 `--dsh-axzo-*` | 17 |
| 槽位 id | `axzo-backdrop`、`axzo-sidebar` | 2 |
| 槽位 priority / order | `-1` / `900` / `901` | 3 |
| overrideTokens source | `dsh-axzo-theme` | 1 |
| DOM id（`<style>`） | `dsh-axzo-theme-style`、`dsh-axzo-theme-panel-style` | 2 |
| CSS 类名 | `.dsh-axzo-*` / `.axzt-*` | 46 + 面板类 |
| data 属性 | `data-axzo-sidebar`、`data-axzo-run`、`data-axzo-taskwatch`、`data-axzo-busy` | 4 |
| @keyframes | `dsh-axzo-breathe`、`-breathe-line`、`-float`、`-pulse`、`-row-breathe`、`-sheen`、`-spin` | 7 |
| 构建期占位符 | `__AXZO_ICON_PATH__`、`__AXZO_TEXT_PATH__`、`__AXZO_ICON_VIEWBOX__`、`__AXZO_TEXT_VIEWBOX__` | 4 |

**43 个 token 明细**（`tokens.js`）：

- `--dsw-alias-*`（22）：`brand-primary`、`brand-primary-invert`、`button-primary-fill`、
  `button-primary-hover`、`button-ghost-active-fill`、`interactive-bg-active`、`link`、
  `bg-base`、`bg-layer-1`、`bg-layer-2`、`bg-layer-3`、`bg-module-platform`、`bg-overlay`、
  `border-l1`、`border-l2`、`border-l3`、`border-l4`、`interactive-bg-hover`、
  `state-warn-primary`、`state-error-primary`、`state-success-primary`、`state-info-primary`
- `--dsw-specific-*`（4）：`input-major`、`bubble`、`bubble-highlight`、`sidebar-fill`
- `--dsh-axzo-*`（17）：`brand`、`brand-soft`、`brand-ring`、`brand-line`、`sidebar`、
  `sb-sheen`、`sb-edge`、`sb-shadow`、`sb-glow`、`sb-deep`、`glass-hi`、`glass-lo`、
  `glass-line`、`wash-1`、`wash-2`、`blob-a`、`blob-b`

**17 个 `--dsh-axzo-*` CSS 变量**：与上表第三组完全一致。

---

## 四、验证记录

| 检查 | 方法 | 结果 |
|---|---|---|
| 语法 | 逐个 `cp x.js /tmp/x.mjs && node --check /tmp/x.mjs`（17/17） | ✅ 全过 |
| 模块可加载 | `node --input-type=module -e "await import('./src/client/features/theme/index.js')"` | ✅ 4 个契约导出齐全 |
| 契约形状 | `meta` / `dictionaries` / `apply` / `HubView` | ✅ `{id:'theme', namespace:'settings.axzoTheme', hubOrder:10, hubTabKey:'tabTheme'}` |
| 字典 | zh / en key 集合一致、且与源逐字相同 | ✅ 60 = 60，差集为空 |
| token 集合 | 与源 `tokens.js` 逐一比对 | ✅ 43 = 43，集合相同 |
| CSS 变量集合 | 17 个文件全量扫描 `--dsh-axzo-*` | ✅ 17 = 17，集合相同 |
| localStorage key | 与源 `constants.js` 比对 | ✅ 3 = 3 |
| 槽位注册 | 与源 `plugin.js` 逐条比对 | ✅ 5 条保留、1 条（settings.section）按设计删除 |
| `overrideTokens` | 打桩实跑 `apply()` | ✅ `source='dsh-axzo-theme'`，`43` 个 token |
| 逐文件 diff | 13 个纯搬迁文件 vs 源 | ✅ 只有「头部路径 + runtime import 路径」两处 |

---

## 五、迁移期注意事项（给部署方 / 维护者）

1. **不要在迁移期同时装旧插件和聚合插件**：两者都会向 theme service 注册
   `dsh-axzo-theme` 这个 source —— 值相同所以**不会**双层叠加（同 source 后注册替换前
   一层），但两边的 CSS / 槽位会互相覆盖。正确做法是先卸载旧插件。
2. `logo.js` 的 4 个 `__AXZO_*__` 占位符由 vite 插件在构建期替换；
   **路径变成了 `src/client/features/theme/logo.js`** —— 构建脚本需同步改。
3. `PLUGIN_ID`（`dsh-axzo-theme`）在 `styles.js` / `panel.js` 里还用于
   `<style data-plugin="...">` 标记。值保持不变，便于排查时与旧插件对上。
