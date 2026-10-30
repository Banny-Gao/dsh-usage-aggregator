# 迁移对照清单 · 零能力丢失审计

> 三个源插件迁进一个包之后，逐项核对「迁移前有的能力，迁移后还在不在、在哪里、怎么验证」。

---

## 0. 总览

| 源插件 | → 迁移后的位置 | 变更性质 |
|---|---|---|
| `dsh-axzo-theme` 0.1.13 | `src/client/features/theme/` + `src/host/features/theme/` | 客户端整体搬迁；Host 仍是空座位 |
| `dsh-usage-query` 0.2.0 | `src/client/features/usage/` + `src/host/features/usage/` | 客户端「拼接片段 → 真 ESM」；Host 整体搬迁，传输层换成共享实现 |
| `dsh-plugin-expander` 0.3.0 | `src/client/features/expander/` + `src/host/features/expander/` | 客户端「自注册 IIFE → ESM 模块」；Host 整体搬迁，**新增自我保护** |

每个功能目录里都有一份 `MIGRATION.md`，是逐文件的对照依据（文件映射 / 逐处改动理由 / 刻意未改清单 / 自检结果）。

---

## 1. dsh-axzo-theme → 客户端主题功能

### 1.1 能力清单

| # | 能力 | 迁移后位置 | 验证方式 |
|---|---|---|---|
| 1 | 侧栏 logo + 字标替换 | `sidebar.brand.mark` / `sidebar.brand.name`，priority **−1** | `check-client.mjs` 断言槽位与 priority |
| 2 | 43 个主题 token 覆盖 | `tokens.js` → `ctx.theme.overrideTokens('dsh-axzo-theme', …)` | 脚本比对源/目标的 token 名集合（**26 个 `--dsw-*` + 17 个 `--dsh-axzo-*`，完全一致**） |
| 3 | 玻璃首屏舞台 | `conversation.hero.brand.mark`，priority −1，**关闭时真的注销槽位** | `check-client.mjs` 断言槽位；源码比对保留 disposer 逻辑 |
| 4 | 会话主区品牌背景 | `sidebar.footer.action` id `axzo-backdrop` order 900 | `check-client.mjs` 断言 id/order |
| 5 | 侧栏玻璃质感探针 | `sidebar.footer.action` id `axzo-sidebar` order 901 | 同上 |
| 6 | 任务状态徽标（完成/关注） | `tasks.js` → `body[data-axzo-taskwatch]` / `[data-axzo-run]` / `.dsh-axzo-done` | 源码逐字节比对（仅注释差异） |
| 7 | 全域氛围光 / 顶部流光 | `styles.js` → `body::before` / `body::after` | 同上 |
| 8 | OS 偏好适配 | `os-prefs.js` | 同上 + 新增 disposer（见 §5） |
| 9 | 设置面板（预设/HSL/开关/品牌/字体/预览） | `panel.js` → 聚合页的「主题外观」页签 | `render-check.mjs` 真渲染 |
| 10 | 品牌字体表（11 套） | `brand.js` `FONTS` | 源码比对 |

### 1.2 刻意未改的标识符

| 标识符 | 值 | 改了会怎样 |
|---|---|---|
| localStorage key | `dsh-axzo-theme:primary` / `:fx` / `:brand` | 用户保存的主色/开关/品牌名/logo 静默丢失 |
| locale 命名空间 | `settings.axzoTheme` | 新旧命名空间并存 → 切换语言退回内置字典 |
| `overrideTokens` 的 source | `dsh-axzo-theme` | 与迁移期仍装着的旧插件形成**双层叠加** |
| 43 个 token 名 | — | 主题色失效 |
| 17 个 `--dsh-axzo-*` | — | 外部插件引用不到（事实上的公共契约） |
| 槽位 id / priority / order | 见 §1.1 | 品牌位被官方品牌压掉 / 首屏槽位让不出去 |

---

## 2. dsh-usage-query → 用量查询功能

### 2.1 Host 半边（14 个模块逐字节一致，只改了注释里的路径）

| 模块 | 职责 | 核对结论 |
|---|---|---|
| `curl.js` | 粘贴解析（cURL / raw HTTP / JSON）+ 凭证识别 | 代码零改动 |
| `request.js` | 请求重放 + ok/expired/error 判定 | 代码零改动 |
| `paths.js` | JSON 取数路径求值（**不是磁盘路径**） | 代码零改动 |
| `labels.js` | 字段名 → 中文名 + 重要性排序 | 代码零改动 |
| `resolve.js` | 模板 + 响应 → 可渲染 view（确定性） | 代码零改动 |
| `template.js` | 模板校验 + 无模型时的结构兜底 | 代码零改动 |
| `analyze.js` | **唯一调 LLM 的地方**（三套提示词 + JSON 提取） | 代码零改动 |
| `store.js` | 落盘 + 脱敏 + id 生成 + 记录归一化 | 代码零改动 |
| `auto.js` | 自动查询 / 续期的**纯函数**判定 | 代码零改动 |
| `cdp.js` | 零依赖 Chrome DevTools 驱动 | 代码零改动 |
| `renewal/index.js` `renewal/dingtalk.js` | 钉钉 OAuth 自动续期 | 代码零改动；**刻意不 import store.js**（防循环依赖） |
| `ops.js` | 业务编排（面板与工具共用的同一份实现） | 代码零改动 |
| `tool.js` | Agent 工具 | 代码零改动 |
| `server.js` | HTTP 路由 | **重写**：传输层换成共享 `buildRoutes` |

### 2.2 三段不可切碎的语义（源与目标实测数值相同）

| 语义 | 场景 | 源 | 目标 |
|---|---|---|---|
| `effectiveAnalysis()` | 无选择 | `axzo-one/auto/deepseek-flash`，source=config | 同 |
| | 面板选了优先 | `user-p/user-m`，source=user | 同 |
| | model 空 → 回落配置 provider | `user-p/axzo-one` | 同 |
| | 每次重读不缓存 | 换选择后立即生效 | 同 |
| `applyResult()` | 模板缺失 | 1 次模型调用 | 同 |
| | 指纹未变 | **0 次** | 同 |
| | 指纹变了 | 1 次 | 同 |
| | 兜底版本落后 | 1 次 | 同 |
| `withLock` | 并发 remove + setFieldOrder × 60 轮 | **0 次丢更新** | 同 |

### 2.3 11 条路由的路径对照

| # | 方法 | 旧路径 | 新路径 |
|---|---|---|---|
| 1 | GET | `/dsh-usage-query` | `/dsh-usage-aggregator/usage` |
| 2 | POST | `/dsh-usage-query/import` | `/dsh-usage-aggregator/usage/import` |
| 3 | POST | `/dsh-usage-query/refresh` | `/dsh-usage-aggregator/usage/refresh` |
| 4 | POST | `/dsh-usage-query/renew` | `/dsh-usage-aggregator/usage/renew` |
| 5 | POST | `/dsh-usage-query/reanalyze` | `/dsh-usage-aggregator/usage/reanalyze` |
| 6 | POST | `/dsh-usage-query/remove` | `/dsh-usage-aggregator/usage/remove` |
| 7 | POST | `/dsh-usage-query/order` | `/dsh-usage-aggregator/usage/order` |
| 8 | GET | `/dsh-usage-query/models` | `/dsh-usage-aggregator/usage/models` |
| 9 | POST | `/dsh-usage-query/analysis-model` | `/dsh-usage-aggregator/usage/analysis-model` |
| 10 | POST | `/dsh-usage-query/chip` | `/dsh-usage-aggregator/usage/chip` |
| 11 | GET | `/dsh-usage-query/raw` | `/dsh-usage-aggregator/usage/raw` |

客户端的 11 个 `api` 方法与这 11 条路由**一一对应**（`api.js` 逐条核对过路径后缀）。

> 旧路径**没有兼容层** —— 是一次性切换。客户端已同步切到 `USAGE_ENDPOINT`。

### 2.4 客户端（14 个共享作用域片段 → 14 个真 ESM 模块）

| 原文件 | 新文件 | 核对结论 |
|---|---|---|
| `01-runtime.js` | `constants.js`（+ 共享 runtime） | React 句柄改从 `../../runtime.js` 取；6 个常量拆出 |
| `02-i18n.js` | `i18n.js` | 字典 **108 → 108 key**（与源逐字一致；页签标签 `hubTab` 不在本字典里 —— 归聚合页，见 §4） |
| `03-api.js` | `api.js` | 11 个方法路径换成 `USAGE_ENDPOINT` |
| `04-format.js` | `format.js` | — |
| `05-atoms.js` | `atoms.js` | — |
| `06-provider.js` | `provider.js` | `statusKey` 提到文件开头并导出（原来靠函数声明提升侥幸成立） |
| `07-field-order.js` | `field-order.js` | `signature` 依赖、拖拽只挂 ⠿ 把手 |
| `08-import.js` | `import-panel.js` | — |
| `09-model-picker.js` | `model-picker.js` | fixed + 挂载后自纠正偏移 |
| `10-hover.js` | `hover.js` | 几何式悬停关闭（矩形并集 + 520ms + 20px） |
| `11-quick.js` | `quick.js` | 会话头芯片 + 浮层 |
| `12-panel.js` | `panel.js` | 设置页根面板 |
| `13-styles.js` | `styles.js` | **171/171 条 CSS 规则字节一致**；`duq-` 前缀不变；只用 `--dsw-alias-*`；`data-` 属性标记；不进 `document.head` |
| `14-assembly.js` | `index.js` | 删掉 `settings.section` 注册与 `locale.register`；保留会话头芯片 |

### 2.5 刻意未改

| 项 | 值 | 改了会怎样 |
|---|---|---|
| 磁盘路径 | `$DSH_HOME/dsh-usage-query/store.json`、`profiles/<id>/` | 已接入的接口/模板/字段顺序/芯片选择静默消失；续期要重新扫码 |
| `providerIdFrom()` slug 规则 | — | 芯片选择与字段顺序指向不存在的 id |
| 工具名 | `usage_query` | 已有模型用法与文档失效 |
| 工具 schema / render / 并发标记 | — | — |
| `maskProvider()` 脱敏投影 | — | 凭证明文发到浏览器 |
| 送模型摘要抹凭证 | — | 同上 |
| `renewal/` 不 import `store.js` | — | 循环依赖 → 模块加载失败 |
| `export { guessTitle }` | — | 重排时容易变成重复导出点 |

---

## 3. dsh-plugin-expander → 插件更新功能

### 3.1 能力清单

| # | 能力 | 迁移后位置 | 核对结论 |
|---|---|---|---|
| 1 | 已装清单（官方 `listBundles`） | `ops.js` | 保留 `availability === 'profile'` 过滤 |
| 2 | 远端最新版本（npm / git） | `ops.js` + `proc.js` | `pnpm view` / `git ls-remote`；`proc.js` 永不抛异常 |
| 3 | semver 子集比较 | `registry.js` | 纯函数，逐字节一致 |
| 4 | 锁文件提交号 | `lockfile.js` | 逐字节一致（缩进 6/8 空格的解析规则没动） |
| 5 | 装 / 更新（走官方管理器） | `ops.js` | `removeBundle` + `installBundle`；npm 用 `name@latest`、git 用原始 source |
| 6 | 60s 缓存 / 单一任务槽 / 串行批量 | `ops.js` | 保留 |
| 7 | HTTP 路由（2 条） | `server.js` | `GET /dsh-usage-aggregator/expander/state`、`POST /dsh-usage-aggregator/expander/update`（路径后缀与原插件的 `/state`、`/update` 一致） |
| 8 | Agent 工具 | `tool.js` | `plugin_update`，schema / render / `isConcurrencySafe:false` 原样 |
| 9 | 权限闸门 | `index.js` | `sandboxPolicy` → 必须 `danger-full-access`；服务不存在时不限制 |
| 10 | 「更新」标签页 | `plugins.tab` id `updates` order 20 | 保留在插件页原位 |

### 3.2 新增：自我保护（本次聚合特有）

| 保护 | 实现 | 理由 |
|---|---|---|
| `RETIRED_PACKAGES` | `dsh-axzo-theme` / `dsh-usage-query` / `dsh-plugin-expander` **从清单里过滤掉** | 旧包只要还在 profile 依赖清单里，「全部更新」就会用 `name@latest` 把它们**装回来** —— 旧插件复活，与聚合体功能重复 |
| `SELF_PACKAGE` | 聚合包**保留在清单里可见**，但从「全部更新」的目标列表排除；显式更新自己返回 `{ok:false, stage:'check'}` | 以 npm 形式安装时，自更新会运行中把自己卸载再装回来 |

两者都**只按包名精确匹配**。

---

## 4. 聚合层带来的变更（刻意、有记录）

| # | 变更 | 影响 | 记录在 |
|---|---|---|---|
| 1 | 设置面板从 2 个入口变 1 个（内部三个页签） | 导航少两项，功能都在 | ADR 0004 |
| 2 | 路由前缀 `/dsh-usage-query/*` → `/dsh-usage-aggregator/usage/*`；`/dsh-plugin-expander/*` → `…/expander/*` | 旧路径无兼容层 | §2.3 |
| 3 | 客户端构建从三套链统一成 Vite + 真 ESM | 用量查询的片段改成显式 import | ADR 0003 |
| 4 | 传输层统一到共享 `buildRoutes`，**多了同源校验与「POST 必须 application/json」** | 客户端一直是同源 + JSON，正常路径不受影响 | §5 |
| 5 | 工具名**不加**聚合前缀 | 保住已有用法 | ARCHITECTURE §14 |
| 6 | `overrideTokens` 的 source 沿用 `dsh-axzo-theme` | 避免双层叠加 | §1.2 |

---

## 5. 顺手修掉的既有隐患（非本次引入，但值得记一笔）

| # | 问题 | 出处 | 处理 |
|---|---|---|---|
| 1 | `os-prefs.js` 在**模块顶层**注册 3 条 `matchMedia` 监听且**没有 disposer** → 插件反复启停时监听会累积 | `dsh-axzo-theme/src/os-prefs.js` | 导出 `stopOsPrefs()`，在 apply 的 effect cleanup 里调用；另加幂等的 `startOsPrefs()` 供 dispose→再 apply |
| 2 | 主题字典里 `heroHint` / `wmHint` / `washHint` **在 zh 与 en 中各被定义两次** → 前一次定义是死代码，永远不显示 | `dsh-axzo-theme/src/i18n.js` | 删除**较早的那一份**（保留实际生效的、较完整的那份）→ **行为零变化**，同时消除打包器的重复 key 警告 |
| 3 | `12-panel.js` 的 `showRenew` 是死变量 | `dsh-usage-query/src/12-panel.js` | **保留未删** —— 「一字不改」优先于顺手清理 |
| 4 | `06-provider.js` 的 `statusKey` 定义在文件末尾却被告 `11-quick.js` 使用 | `dsh-usage-query/src/06-provider.js` | 原来靠共享作用域的函数声明提升侥幸成立；改成显式 import 后提到文件开头并导出，语义不变 |

---

## 6. 验证清单

```bash
pnpm install
pnpm run build          # 产物 → client/client.js
pnpm run check          # 一把跑全部验证（verify.sh）
```

| 脚本 | 覆盖 |
|---|---|
| `scripts/check-host.mjs` | 用**真实 cordis** 装载 `src/host/index.js`；导出形状、`name`、硬 `inject === ['tools']` |
| `scripts/check-client.mjs` | 假 window 加载产物；loader id、硬 `inject === ['slots','locale','theme']`、**所有槽位注册**（含「`settings.section` 只有一个且 id 是 `usage-aggregator`」）、theme 的 43 token 契约、三个功能命名空间 + 聚合页命名空间的页签标签键 |
| `scripts/verify.sh` | 语法、资源、清单一致性、**三处端点常量同值**、构建产物一致性、token / CSS 变量 / localStorage key / 落盘路径 / 工具名 / 旧包名排除 / 路由路径唯一性 |
| `scripts/smoke.mjs` | 用量查询 Host 侧全部纯函数与集成断言（curl 解析、过期判定、模板校验/兜底、标签排序、格式化、脱敏、落盘、并发写、字段顺序、自动查询判定、模型选择、芯片选择、辅助截图、HTTP 路由） |
| `scripts/smoke-renewal.mjs` | 续期纯函数断言（换 token 不动别处、认站点、冷却判定、投影不含凭证） |
| `scripts/ui-check.mjs` | 用量查询客户端离线渲染（真实 react-dom/server） |
| `scripts/ui-check-expander.mjs` | 插件更新客户端离线渲染（用真机 `/state` 夹具） |
| `scripts/render-check.mjs` | 主题视觉回归（puppeteer，浅/深 × 整页/侧栏） |

---

## 7. 迁移到 profile 的操作顺序

1. **先卸载三个旧包**（顺序不能反，理由见 §3.2）：
   ```bash
   dsh plugin --profile web remove dsh-axzo-theme
   dsh plugin --profile web remove dsh-usage-query
   dsh plugin --profile web remove dsh-plugin-expander
   ```
2. **再装聚合包**：
   ```bash
   dsh plugin --profile web add https://axzsource.com/gaozhipeng/dsh-usage-aggregator.git
   ```
3. 打开 **设置 → 用量聚合**，确认三个页签都在。
4. 打开 **插件 → 更新**，确认旧包没有出现在清单里。
5. 确认用量查询的已接入接口还在（数据目录没变，应当原样出现）。
