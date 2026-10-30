# dsh-usage-aggregator · 架构设计

> 一个 DSH 插件装下三件能力：**用量查询**、**安心筑品牌主题**、**插件更新**。
> 三个功能在设置面板里共用**一个**入口，插件管理器里只占**一行**。

---

## 1. 背景与目标

### 1.1 收拢的原因

迁移前这三件能力住在三个仓库、装三个包：

| 源插件 | 版本 | 职责 | Host 半边 | 客户端半边 | 构建方式 |
|---|---|---|---|---|---|
| `dsh-axzo-theme` | 0.1.13 | 安心筑品牌主题 | **空座位**（无路由、无工具） | 20 个 ESM 模块 / 2291 行产物 | Vite 8（lib/IIFE） |
| `dsh-usage-query` | 0.2.0 | 第三方用量接口查询 | 16 个模块（路由 + 工具 + 定时续期） | 14 个共享作用域片段 / 2059 行产物 | 字符串拼接（零依赖） |
| `dsh-plugin-expander` | 0.3.0 | 检测并安装已装插件的新版本 | 7 个模块（路由 + 工具） | 单文件 571 行 | 无构建（手写） |

代价有两处：

1. **插件管理器里多三行**，设置面板里多两个入口（用量查询、AxzoTheme），插件页里多一个「更新」标签页 —— 每加一个功能就多一行。
2. **三套构建链、三套自检脚本、三份文档**，各自演进，共享的任何改进都要复制三遍。

### 1.2 目标

- **一个 npm 包 = 一个 DSH 插件 = 一行插件管理器条目 = 一个设置面板入口**。
- **零能力丢失**：迁移后每一个既有能力（槽位、路由、工具、文案、token、CSS 变量、本地数据、交互细节）都还在，行为不变。
- **可扩展**：加第 4、第 5 个功能时，**只加一个目录 + 一行登记**，不碰装配层、不碰构建链、不碰共享内核。
- **长期可维护**：模块之间只有显式契约，没有隐式共享作用域、没有魔法字符串散落各处。

---

## 2. 源插件职责分析（迁移的基线）

### 2.1 dsh-axzo-theme —— 纯客户端的品牌与视觉层

Host 侧是空座位（`export const name` + 空 `apply()`），**100% 的行为在浏览器端**：

| 能力 | 挂载点 | 关键机制 |
|---|---|---|
| 侧栏品牌替换（logo + 字标） | `sidebar.brand.mark` / `sidebar.brand.name`，**priority −1** | 压过 `dsh-client-ui-brand-official` 的 priority 0 |
| 43 个主题 token 覆盖 | `ctx.theme.overrideTokens('dsh-axzo-theme', …)` | 26 个 `--dsw-*` + 17 个 `--dsh-axzo-*`；覆盖层有**唯一所有者**（面板不得持有 disposer） |
| 玻璃首屏舞台 | `conversation.hero.brand.mark`，priority −1 | 关闭时**真的注销槽位**（单值槽只渲染 priority 最低的那个） |
| 会话主区品牌背景 | `sidebar.footer.action`（id `axzo-backdrop`） | `react-dom.createPortal` 挂进会话区容器 |
| 侧栏玻璃质感 | `sidebar.footer.action`（id `axzo-sidebar`） | 运行时探测侧栏列并打 `data-axzo-sidebar` 属性 |
| 任务状态徽标 | `sidebar.footer.action`（id `axzo-task-status`）+ `body[data-axzo-taskwatch]` / `[data-axzo-run]` | 数据源 = 官方 **sessionStatus** 快照（`running` / `pendingInteraction` / `completionUnread`）；完成=事件（边沿、粘性）、关注=状态（每拍派生）；**子代理不计入** |
| 全域氛围光 / 顶部流光 | `body::before` / `body::after` | z-index 2.1e9 |
| 设置面板 | `settings.section`（id `axzo-theme`，order 93） | 6 套预设 + HSL 三滑杆 + 5 个视觉开关 + 品牌自定义 |

**关键不变量**（改名即破坏）：locale 命名空间 `settings.axzoTheme`；localStorage 三个 key `dsh-axzo-theme:primary` / `:fx` / `:brand`；17 个 `--dsh-axzo-*` CSS 变量名；`overrideTokens` 的 source 标识。

### 2.2 dsh-usage-query —— 「一份 ops，多入口」的业务闭环

```
粘贴 cURL/截图 → Host 重放请求 → 本地模型分析出「展示模板」→ 缓存
                → 确定性渲染（模板+响应 → view）→ 设置面板 / 会话头芯片
```

三条设计不变式：

1. **模型只产出模板（可校验的数据），代码负责取数与格式化** → 客户端是哑渲染器，接新接口零改动。
2. **续期只换凭证**（只改 `authorization` 一处）→ 续期不花模型调用，缓存模板继续有效。
3. **凭证永不出 Host**：`maskProvider()` 是唯一允许发给浏览器的记录投影；送模型的请求摘要也要抹掉取值。

11 条 HTTP 路由、1 个 Agent 工具（`usage_query`）、1 个自动刷新定时器（60s 一拍、按每个接口自己的上次查询时间判定）、1 套钉钉 OAuth 自动续期（零依赖 CDP 驱动 Chrome）。

### 2.3 dsh-plugin-expander —— 补上官方没有的升级入口

```
已装清单（官方 listBundles）→ 远端最新版本（pnpm view / git ls-remote）
  → semver 子集比较 → 官方 removeBundle + installBundle → 呈现
```

两条 HTTP 路由、1 个 Agent 工具（`plugin_update`，带 danger-full-access 闸门）。它**自己不碰 pnpm** —— 官方管理器才有 profile 写锁、失败回滚、HMR 重载与构建脚本审批。

---

## 3. 关键决策：单包，还是 monorepo？

### 3.1 结论

**不用 TurboRepo，也不用 pnpm workspace。采用单包 + 目录式模块架构。**

### 3.2 理由

| # | 理由 | 说明 |
|---|---|---|
| 1 | **需求本身就是「一个插件」** | 插件管理器按**包**列条目。多包 = 多行 = 正是要消除的问题。TurboRepo 的最小单位是 package，用它来装一个 package 是自相矛盾。 |
| 2 | **产物必须是一个文件** | DSH 的客户端加载器按包名注册**一个**模块（`window.__ModuleLoader__.load({id, factory})`），`exports["./client"]` 也只指向一个 `client/client.js`。三个功能必须**融进同一个 bundle**。多包方案要么每个包各出一个 bundle（DSH 只加载本包的那个，其余白做），要么再加一层「组装包」把三个 bundle 缝起来 —— 那是凭空多出来的构建层。 |
| 3 | **Turbo 的价值在这里用不上** | Turbo 的核心是**任务图 + 缓存 + 远程缓存**，为「多个独立包并行构建」服务。本仓库只有一个可发布产物、一条构建命令、一个构建产物。没有并行可缓存。 |
| 4 | **包边界解决不了这里真正的耦合** | 真正的问题是**作用域污染**（拼接式共享 factory 作用域里 `h` / `NS` / `STYLE_ID` / `zh` / `Panel` 全撞名）。这靠**模块作用域**解决，不靠包边界 —— 而且包边界会额外带来「跨包改一个功能要发两个版本」的成本。 |
| 5 | **子目录 + 显式契约已经够了** | `src/client/features/<id>/` 与 `src/host/features/<id>/` 提供了同样的隔离度、更好的本地开发体验（改一个功能不用管 workspace 拓扑），且**不需要**每个子目录一份 package.json / version / build 配置。 |
| 6 | **用户的既有生态也是这个答案** | 同一台机器上的 `axzo-dsh-plugins` 就是 **pnpm workspace（无 Turbo）** + `scripts/build-plugins.mjs` 自建构建。仓库形态上不必和它不一样。 |

### 3.3 什么情况下应该改选 monorepo

写在这里是为了将来能做判断，而不是现在就用：

- **要把某几个功能拆成独立插件发布**（那时每个功能要能单独装、单独升级 → 需要 workspace + 多包）。
- **功能数超过 ~8 个，且团队并行开发**（那时目录边界的合并冲突会开始疼 → workspace + Turbo 的任务图开始有收益）。
- **需要按功能独立发版**（聚合插件整体发版会拖住所有功能的迭代节奏）。

即便走到那一步，也建议保持「**内部包 + 一个聚合壳**」的形状：内部包用 workspace 管理，聚合壳只负责组装与对外发布 —— 插件管理器里依然只有一行。

### 3.4 现在的替代品：功能契约

不靠包边界，靠**契约**。见 §5。

---

## 4. 目录结构

```
dsh-usage-aggregator/
├── package.json                 # 一个插件包：dsh-usage-aggregator
├── cordis.patch.yml             # 一个 bundle patch → 一个插件行
├── icon.svg
├── locale/{zh,en}.json          # 插件管理器展示元信息（meta.title / meta.description）
├── assets/
│   └── axzo-official-logo.svg   # 官方 logo（构建期切分成图标 path + 字标 path）
├── src/
│   ├── client/                  # ── 客户端半边（浏览器）──
│   │   ├── index.js             # 入口：window.__ModuleLoader__.load(...) + 装配
│   │   ├── runtime.js           # React 注入（唯一接触 require 的地方）
│   │   ├── shared/              # 共享内核：i18n.js / api.js / constants.js
│   │   ├── hub/                 # 聚合设置页：panel.js / styles.js / i18n.js
│   │   └── features/
│   │       ├── theme/           # ← 原 dsh-axzo-theme/src
│   │       ├── usage/           # ← 原 dsh-usage-query/src
│   │       └── expander/        # ← 原 dsh-plugin-expander/client
│   └── host/                    # ── Host 半边（Node）──
│       ├── index.js             # 入口：name / inject / apply
│       ├── shared/              # 共享内核：http.js / context.js
│       └── features/
│           ├── theme/           # 空座位（纯客户端功能）
│           ├── usage/           # ← 原 dsh-usage-query/lib
│           └── expander/        # ← 原 dsh-plugin-expander/lib
├── client/
│   └── client.js                # 构建产物（唯一对外的客户端文件）
├── vite.config.mjs             # 构建链配置（必须在仓库根 —— Vite 只自动发现根配置）
├── vite/                       # 构建链插件：logo 的构建期注入 + 解析
├── preview/                     # logo 的本地预览页
├── scripts/                     # 验证套件
└── docs/adr/                    # 架构决策记录
```

**为什么是 `src/` 而不是 `lib/`**：DSH 插件的惯例是 `lib/` 放 Host 代码。本仓库有**两半**代码，`src/` 下分成 `client/` 与 `host/` 更对称，也不会让「`lib/` 到底是哪一半」产生歧义。`package.json` 的 `main` / `exports` 才是权威。

**为什么 `src/client/` 与 `client/` 并存**：`client/client.js` 是 DSH 按约定加载的产物路径（`exports["./client"]`），不能改；而源码放在 `src/client/` 后，构建输出目录 `client/` 里只有产物，没有源码，不会被 Vite 的 `emptyOutDir` 波及。

---

## 5. 模块契约

### 5.1 客户端功能契约

`src/client/features/<id>/index.js` 必须导出四个成员：

```js
export const meta = { id, namespace, hubOrder }
export const dictionaries = { zh, en }
export function apply(ctx, t) { … }
export function HubView(props) { … }
```

| 成员 | 职责 | 约束 |
|---|---|---|
| `meta.id` | 功能标识 | 稳定，勿改 |
| `meta.namespace` | locale 命名空间 | **保持各功能原值**（`settings.axzoTheme` / `usage-query` / `pluginExpander`）——改名会让新旧命名空间并存，切换语言就退回内置字典 |
| `meta.hubOrder` | 聚合页页签顺序 | |
| `meta.hubTabKey` | 页签标签的键 | 指向**聚合页**字典（`src/client/hub/i18n.js`）里的键，不指向本功能的字典 |
| `meta.hubDefault` | 是否为默认选中的页签 | `true` = 打开聚合页就停在这一页 |
| `dictionaries` | 中英文字典 | **不含** `hubTab`（页签标签归聚合页） |
| `apply(ctx, t)` | 装配自己的槽位 / effect / 定时器 | **不要**注册 `settings.section` —— 那是聚合页的事 |
| `HubView(props)` | 聚合页里的视图 | `props = { t, ctx }` |

**装配顺序**（`src/client/index.js`）：

```
1. 同步注册三个功能的 locale 命名空间  ← 必须在取 translator 之前
2. 为每个功能建 translator（makeTranslator(locale, namespace, zh)）
3. 各功能 apply(ctx, t) —— 注册自己的槽位
4. registerHub(ctx, registry) —— 注册那**一个** settings.section
```

> 第 1 步的顺序不能反：translator 会先探一次 `locale.bind(ns)('tab')`，探不到就退回内置字典，之后切换语言也不跟随。

### 5.2 Host 功能契约

`src/host/features/<id>/index.js` 必须导出三个成员：

```js
export const id = 'usage'
export const routePrefix = 'usage'
export function apply(ctx, featureConfig, shared) { … }
```

`shared` 由 `src/host/shared/context.js` 的 `createShared(config)` 提供：

| 成员 | 说明 |
|---|---|
| `shared.base` | 路由公共前缀（默认 `/dsh-usage-aggregator`） |
| `shared.allowRemote` | 是否允许非回环地址访问 |
| `shared.configOf(id)` | 取某个功能自己的配置段 |
| `shared.routes(specs, options)` | 生成路由表（统一传输层语义） |
| `shared.registerRoutes(host, routes)` | 挂到 webServer，返回注销函数 |

`featureConfig` 是 `config[id]` 那一段 —— 配置按功能分段，互不干扰。

### 5.3 两半之间只靠 HTTP 契约耦合

客户端与 Host 是两套独立加载的代码（浏览器 `<script>` vs Node 进程）。**路由是最小的跨半边契约**：一半是 path，一半是 fetch，没有类型生成、没有协议升级要跟。

---

## 6. 路由与端点

### 6.1 路径划分

```
/dsh-usage-aggregator/usage/…       用量查询（11 条）
/dsh-usage-aggregator/expander/…    插件更新（2 条）
```

**为什么必须分段**：`dsh-host-webserver` 的 `register()` 以 `(kind, path)` 为键，**重复注册直接 throw** → 插件 entry 加载失败 → 整页 `Failed to load plugins`。而且路由匹配**只看 path，不看 HTTP 方法** —— 客户端用 GET/POST 区分读写只是约定。

### 6.2 三处常量必须同步

客户端读不到 Host 的 config（cordis 的 ctx 代理只放行 `inject` 里声明过的属性，读 `ctx.config` 直接抛错），所以前缀只能各写一份：

| 位置 | 常量 |
|---|---|
| `cordis.patch.yml` | `config.endpoint: /dsh-usage-aggregator` |
| `src/client/shared/constants.js` | `ENDPOINT_BASE` |
| `src/host/shared/context.js` | `DEFAULT_BASE` |

`scripts/verify.sh` 断言这三处同值 —— 这是一条硬约束，改前缀只改这三处。

### 6.3 统一传输层

`src/host/shared/http.js` 的 `buildRoutes(specs, options)` 统一了三个功能原本重复的传输层代码：

- GET 一律 200（即使返回体里 `ok===false`，客户端自己判断）
- POST 返回体 `ok===false` → 400，否则 200
- 处理器抛异常 → 500 `{ok:false, error}`
- 请求体超限 → 413；JSON 非法 → 400；POST 非 `application/json` → 415
- 守卫：**回环地址 + 同源**（迁移前只有插件更新那侧有同源校验，现在统一到更严的一侧）

请求体上限按功能区分：用量查询要传截图（base64），12MB；插件更新 1MB。

---

## 7. 配置

`cordis.patch.yml` 里**一个** `config` 块，按功能分段：

```yaml
config:
  endpoint: /dsh-usage-aggregator      # 公共前缀
  allowRemote: false                  # 只允许本机访问
  usage:
    analysis: { provider, model, maxOutputTokens, allowImage }
    autoRefresh: { enabled, intervalSeconds }
    renewal: { enabled, leadSeconds, cooldownSeconds }
    request: { timeoutMs }
  expander:
    checkTimeoutMs: 20000
    gitTimeoutMs: 15000
```

原三个插件的每一个配置项都**原样保留**（只是归了组），默认值也全部不变。

> 配置是**启动期只读**的（`apply(ctx, config)` 的第二个参数），运行时可改的只有落盘 store 里的 `settings`（分析模型、芯片选中项）。

---

## 8. i18n

**三个命名空间保持独立**：`settings.axzoTheme` / `usage-query` / `pluginExpander`，外加聚合页自己的 `dsh-usage-aggregator`。

> 绝不能把三份字典合并进同一个命名空间：三者都有 `tab` / `title` / `reset` / `loading` 这类 key，合并即互相覆盖 —— 表现是「一个功能的界面显示另一个功能的文案」。

聚合页的页签标签与设置入口名归**聚合页自己的**命名空间（`dsh-usage-aggregator`）：功能通过 `meta.hubTabKey` 指向 `src/client/hub/i18n.js` 里的键。

> 为什么不放回各功能的命名空间？同一个命名空间同时只能被一个包注册 —— 新旧插件并存时（迁移期很常见）命名空间归旧包，功能就探不到自己的字典，翻译服务把 key 本身当答案返回，页签上会出现字面量 `hubTab`。这个坑踩过，改成由聚合页统一持有。

聚合页的页签标签与设置入口名都是**每次渲染时求值**（不是建 `views` 时定死），所以切换语言会跟着变。

---

## 9. 状态与持久化

| 数据 | 位置 | 迁移决策 |
|---|---|---|
| 主题偏好（主色 / 开关 / 品牌名 / logo） | `localStorage` 的 `dsh-axzo-theme:primary` / `:fx` / `:brand` | **保持 key 不变** —— 改了用户已保存的主题就静默回到默认 |
| 用量接口记录（请求 / 模板 / 字段顺序 / 芯片选择） | `$DSH_HOME/dsh-usage-query/store.json`（0600） | **保持目录名不变** —— 改了用户已配置的接口、模板、字段顺序全部消失，且面板只显示「还没有接入任何接口」，没有任何提示 |
| 续期用的 Chrome profile | `$DSH_HOME/dsh-usage-query/profiles/<id>/` | 同上 —— 改名会丢钉钉会话，必须重新扫码 |
| 插件更新 | 无（60s 内存缓存） | — |

> 聚合包的名字换了，但**用户数据目录不跟着换**。这是刻意的：数据路径是历史包袱，也是用户的既得资产。

---

## 10. 构建链

**只有一条**：Vite 8（`build.lib` / IIFE / `minify:false` / `target:esnext`），产物 `client/client.js`。

### 10.1 为什么必须统一到 Vite

迁移前的主题已经是 ESM + Vite；而用量查询的 14 个 `src/` 模块是**靠字符串拼接共享同一个 factory 作用域**的脚本片段。两者的顶层名（`h` / `useState` / `useEffect` / `React` / `NS` / `STYLE_ID` / `zh` / `en` / `makeTranslator` / `Panel` / `Styles` / `CSS` / `api`）会**硬冲突**，裸拼直接 `SyntaxError`。

所以：把用量查询的片段**转成真 ESM**（每个跨模块引用变成显式 import），三个功能各自拥有独立作用域。

### 10.2 构建期注入

- **logo 数据**：`vite/axzo-logo-plugin.mjs` 在 build 时把 `src/client/features/theme/logo.js` 里的 4 个 `__AXZO_*__` 占位符**严格**替换成 logo 的 path 与 viewBox（每个占位符必须出现且只出现一次，否则构建期抛错）。
  为什么内联 path 而不是外链 `<img>`：DSH 只服务 SPA dist，插件 `assets/` 不会被任何路由服务 → 外链必然 404；而且 `<img>` 里的 SVG 无法继承 `currentColor`，浅深要两张图。
  为什么切 path 而不是整段贴：logo SVG 有两个 path（`path[0]`=图标、`path[1]`=字标），字标要单独换颜色。
- **构建时间戳**：`vite.config.mjs` 的 `define` 注入 `__BUILD_AT__`，聚合设置页会显示它 —— 回答「我改了代码怎么没生效」。

### 10.3 构建产物一致性

`scripts/verify.sh` 重跑 `vite build` 并比对 sha256（比对前抹掉构建时间戳），保证「产物与源码同步」。

---

## 11. 扩展指南：加一个新功能

1. 建目录 `src/client/features/<id>/` 与 `src/host/features/<id>/`。
2. 客户端模块导出 §5.1 的四个成员；Host 模块导出 §5.2 的三个成员。
3. 在 `src/client/features/index.js` 与 `src/host/features/index.js` 各加一行 import + 加进数组。
4. 如果需要 HTTP 路由：在 `src/host/shared/context.js` 的约定下给一个**全局唯一**的 `routePrefix`，并在客户端 `src/client/shared/constants.js` 里加对应的端点常量。
5. 如果需要配置：在 `cordis.patch.yml` 的 `config` 里加一段 `<id>:`，并在 Host 模块里用 `featureConfig.<key>` 读。
6. 如果需要新的文案：给自己的 locale 命名空间，字典里加 key；页签标签另在 `src/client/hub/i18n.js` 加一个键，并用 `meta.hubTabKey` 指过去。
7. **不需要**碰：`src/client/index.js`、`src/host/index.js`、`src/client/hub/*`、`src/host/shared/*`、构建链。

这个「新增功能只加一个目录 + 两行登记」的形状，是本架构的核心目标。

---

## 12. 迁移与回滚

### 12.1 迁移顺序（重要）

1. **先从 profile 卸载三个旧包**（`dsh-axzo-theme` / `dsh-usage-query` / `dsh-plugin-expander`）。
2. **再安装聚合包**。
3. 验证旧包没被「全部更新」装回来。

**为什么顺序不能反**：

- 旧包与聚合包的路由前缀不同，所以不会撞 `duplicate exact route`；
- 但只要旧包还留在 profile 的 `package.json` / `pnpm-lock.yaml` 里，**「全部更新」会用 `name@latest`（npm）或原始 source（git）把它们装回来** —— 旧插件复活，且两套「更新」能力并存；
- 聚合包自己也在清单里。以 npm 形式安装时，「全部更新」会把正在运行的自己卸载再装回来。

因此聚合包内置了**自我保护**（`src/host/features/expander/ops.js`）：

| 保护 | 行为 |
|---|---|
| `RETIRED_PACKAGES` | 三个旧包名**从清单里过滤掉**（它们不该再存在，列出来只会诱导用户点更新） |
| `SELF_PACKAGE` | 聚合包自己**保留在清单里可见**（check 能看到），但从「全部更新」的目标列表里排除，且显式更新自己会被拒绝 |

### 12.2 回滚

三个旧仓库保持原样直到迁移验证通过；需要回滚时把 profile 里的聚合包卸掉、把三个旧包装回去即可（用户数据路径没变，不需要迁移数据）。

---

## 13. 不变量清单（改动时必须守住）

| # | 不变量 | 破坏后果 |
|---|---|---|
| 1 | localStorage key `dsh-axzo-theme:*` | 用户已保存的主色/开关/品牌/logo 静默丢失 |
| 2 | 落盘目录 `dsh-usage-query/` | 已接入的接口、模板、字段顺序、芯片选择静默丢失；续期要重新扫码 |
| 3 | locale 命名空间三个独立 | 文案互相覆盖，英文用户突然看到中文 |
| 4 | 43 个主题 token 名 + 17 个 `--dsh-axzo-*` | 主题色失效 / 外部插件引用不到 |
| 5 | `overrideTokens` 的 source 标识 | 迁移期与旧插件形成双层叠加 |
| 6 | 工具名 `usage_query` / `plugin_update` | 已有的模型用法与文档失效 |
| 7 | 路由路径全局唯一 | `duplicate exact route` → 整页 `Failed to load plugins` |
| 8 | 客户端硬 `inject` 只写必然存在的服务 | entry 永远 pending → 整页 `Failed to load plugins` |
| 9 | `sessions` 走可选注入 | 同上 |
| 10 | 用量查询只 `require('react')` / 主题可选 `react-dom` | 缺 react-dom 会让背景 portal 整体崩掉 |
| 11 | 脱敏投影 `maskProvider()` 不绕过 | 凭证明文发到浏览器 |
| 12 | `withLock` / `effectiveAnalysis` / `applyResult` 三段语义 | 并发写坏 store / 面板选的模型不生效 / 反复烧模型调用 |

---

## 14. 已知取舍

| 取舍 | 理由 |
|---|---|
| 设置页从 2 个入口变 1 个（内部三个页签） | 用户明确要求「每新增一个插件，设置面板就会多一个入口」。插件页的「更新」标签页保留原位（那是另一个页面的自然归宿） |
| 工具名不加聚合前缀 | 改名会破坏已有的模型用法与文档；DSH 里 `usage_query` / `plugin_update` 都不与官方工具撞名 |
| 统一用更严的同源守卫 | 迁移前只有插件更新那侧有；统一后对同源客户端无影响 |
| `overrideTokens` 的 source 沿用旧标识 | 见不变量 5 |
| 数据目录不跟着包名走 | 见 §9 |
