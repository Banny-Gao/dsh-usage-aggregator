# 迁移对照表 —— dsh-plugin-expander 的 Host 半边 → dsh-usage-aggregator

> 这是「零能力丢失」审计的依据。每一处**没改**的地方都写在最后一节，
> 每一处**改了**的地方都写在中间的对照表里 —— 没有「顺手改的小地方」。

源仓库：`/Users/gaozhipeng/Desktop/work/dsh-plugin-expander`
目标仓库：`/Users/gaozhipeng/Desktop/work/dsh-usage-aggregator`
写入范围：仅 `src/host/features/expander/**`。

---

## 1. 文件对照

| 原文件（dsh-plugin-expander） | 新文件（dsh-usage-aggregator） | 状态 | 说明 |
|---|---|---|---|
| `lib/registry.js` | `src/host/features/expander/registry.js` | 逐字搬过来 | 只有文件头两行注释改了路径。semver 子集比较与依赖 spec 解析一行未动。 |
| `lib/lockfile.js` | `src/host/features/expander/lockfile.js` | 逐字搬过来 | 只有文件头两行注释改了路径。importers 段的缩进规则一行未动。 |
| `lib/proc.js` | `src/host/features/expander/proc.js` | 逐字搬过来 | 只有文件头两行注释改了路径。「永不抛异常」约定一行未动。 |
| `lib/ops.js` | `src/host/features/expander/ops.js` | 搬过来 **+ 自我保护** | 业务编排（检测、判状态、串行更新、60s 缓存、单一全局任务槽）一行未动；新增 `RETIRED_PACKAGES` / `SELF_PACKAGE` 与四条自我保护规则，见第 4 节。 |
| `lib/server.js` | `src/host/features/expander/server.js` | **改写为「路由声明层」** | 传输层（回环 / 同源 / JSON 校验、请求体上限、状态码语义）搬到了共享内核 `src/host/shared/http.js` 的 `buildRoutes`；本文件只保留「有哪几条路由、各自跑什么」。对外的 HTTP 语义完全等价，见第 2 节。 |
| `lib/tool.js` | `src/host/features/expander/tool.js` | 逐字搬过来 | 只有文件头注释里的路径名换了位置。工具名、schema、描述、返回形状、`isConcurrencySafe` 一行未动。 |
| `lib/index.js` | `src/host/features/expander/index.js` | **拆成两个文件** | 原 `lib/index.js` 的**装配逻辑**搬进 `apply(ctx, featureConfig, shared)`；原 `export const name` / `export const inject` **删掉**（聚合入口 `src/host/index.js` 统一声明 `name = 'dsh-usage-aggregator'` / `inject = ['tools']`）。 |
| `fixtures/state.json` | `src/host/features/expander/fixtures/state.json` | 原样复制 | 真机抓的 `/state` 响应夹具，供离线自检断言真实形状。 |
| `scripts/ui-check.mjs` | —— | **未搬** | 那是**客户端**半边的离线渲染自检（react 渲染插件页的「更新」标签页），属于 client 功能的范围，不在 Host 半边。 |

新增（非源仓库文件）：

| 文件 | 用途 |
|---|---|
| `src/host/features/expander/MIGRATION.md` | 本文件。 |
| `src/host/features/expander/selfcheck.mjs` | 离线自检：`node src/host/features/expander/selfcheck.mjs`。72 项断言，覆盖 registry / lockfile / proc / ops / tool / server / 夹具形状。 |

---

## 2. 路由对照

新的路由前缀 = `shared.base + '/expander'`。`shared.base` 默认 `/dsh-usage-aggregator`
（与客户端 `src/client/shared/constants.js` 的 `ENDPOINT_BASE` 必须一致）。

| 语义 | 原路径（dsh-plugin-expander） | 新路径（dsh-usage-aggregator） | 方法 | 处理器 |
|---|---|---|---|---|
| 插件清单 | `/dsh-plugin-expander/state` | `/dsh-usage-aggregator/expander` | GET | `ops.state({ refresh: url.searchParams.get('refresh') === '1' })` |
| 插件清单（兼容别名） | —— | `/dsh-usage-aggregator/expander/state` | GET | 同上（同一个 `run` 函数） |
| 启动更新 | `/dsh-plugin-expander/update` | `/dsh-usage-aggregator/expander/update` | POST | `ops.startUpdate(names)` / `ops.startUpdate(await ops.updatableNames())` |

**为什么保留 `/state` 这个别名**：客户端半边（`src/client/features/expander/`）是从原
`client/client.js` 搬过来的，那边写的是 `ENDPOINT + '/state'`。两个 GET 路径指向
同一个处理器，客户端用哪个都对 —— 迁移过程中不会因为路径写法不同而 404。

**HTTP 语义（与原实现逐条等价）**：

| 场景 | 原实现 | 现在（共享内核 `buildRoutes`） |
|---|---|---|
| GET 正常 | 200 + JSON | 200 + JSON |
| GET 处理时抛异常 | 500 `{ok:false,error}` | 500 `{ok:false,error}` |
| POST 返回体 `ok===false` | 400 + JSON | 400 + JSON |
| POST 返回体 `ok!==false` | 200 + JSON | 200 + JSON |
| POST 处理时抛异常 | 500 `{ok:false,error}` | 500 `{ok:false,error}` |
| 非回环地址（`allowRemote` 未开） | 403 | 403 |
| 跨站（Origin 与 Host 对不上） | 403 | 403 |
| POST 不是 `application/json` | 415 | 415 |
| 请求体超过上限 | 413（1MB） | 413（1MB，默认 `BODY_LIMIT_DEFAULT`） |
| 请求体不是合法 JSON | 400 | 400 |

唯一可见的差别是 403 的**文案**：共享内核用了一段通用措辞（三个功能共用一份传输层）。
状态码与放行/拒绝的判断条件完全没变。

---

## 3. 配置键映射

| 原 config 键（dsh-plugin-expander） | 现在读哪里 | 默认值 | 说明 |
|---|---|---|---|
| `endpoint` | `shared.base` | `/dsh-usage-aggregator` | 路由公共前缀由共享内核解析（`resolveBase`），功能再挂一段 `/expander`。 |
| `allowRemote` | `shared.allowRemote` | `false` | 三个功能共用一份开关（`createShared`）。 |
| `checkTimeoutMs` | `featureConfig.checkTimeoutMs` | `20000` | `pnpm view` 的超时上限。 |
| `gitTimeoutMs` | `featureConfig.gitTimeoutMs` | `15000` | `git ls-remote` 的超时上限。 |

在 `cordis.patch.yml` 里的位置也跟着变了：

```yaml
- insert:
    - id: dsh-usage-aggregator
      name: 'dsh-usage-aggregator'
      config:
        endpoint: /dsh-usage-aggregator      # ← 公共前缀（原 dsh-plugin-expander 的 endpoint）
        allowRemote: false                  # ← 公共开关
        expander:                           # ← 本功能的配置段
          checkTimeoutMs: 20000
          gitTimeoutMs: 15000
```

`featureConfig` 就是 `config.expander` 那一段（由 `src/host/features/index.js` 用
`shared.configOf('expander')` 取出来再传进 `apply`）。

---

## 4. 自我保护（本次聚合迁移特有）

### 4.1 背景

清单是**无条件枚举全部 profile 插件**的（`listBundles()` → 过滤 `availability === 'profile'`）。
迁到聚合体之后，这一份清单同时会看到三个「已经并进来」的老插件，以及**聚合包自己**。

### 4.2 常量

`src/host/features/expander/ops.js`：

```js
export const RETIRED_PACKAGES = new Set([
  'dsh-axzo-theme',       // 品牌主题 → 已并入 theme 功能
  'dsh-usage-query',      // 用量查询 → 已并入 usage 功能
  'dsh-plugin-expander',  // 本功能的老家 → 已并入 expander 功能
]);

export const SELF_PACKAGE = 'dsh-usage-aggregator';
```

**精确匹配**：过滤与排除都只按包名全等（`Set.has` / `===`），不用模糊匹配 ——
`dsh-usage-query` 与 `dsh-usage-query-helper` 是两个不同的包，模糊匹配会误伤后者。

### 4.3 三条规则（对应「自我毁灭」）

| # | 位置 | 规则 | 防止什么 |
|---|---|---|---|
| ① | `updatableNames()` | 「全部更新」的目标列表**排除自己** | 点一次「全部更新」不会把正在运行的自己卸载再装回来 |
| ② | `updateOne(SELF_PACKAGE)` | 直接返回 `{ok:false, stage:'check', error:'不能更新正在运行的插件自己'}`，**不做任何 remove/install** | Agent 工具显式点名自己时同样挡住 |
| ③ | `describeAll()` → `applySelfGuard()` | 清单里自己那条**保留可见**，但 `updatable` 恒为 `false`，描述里追加「这是正在运行的插件自己，不能由它更新自己」 | 用户看得到自己，但复选框是灰的、也不会进「全部更新」名单 |

自己那条的 `status` 仍**如实反映注册表**（例如远端确实有新版时仍是 `update-available`），
只有 `updatable` 被强制改成 `false` —— 状态是事实，可更新性才是策略。

### 4.4 一条规则（对应「旧插件复活」）

| # | 位置 | 规则 | 防止什么 |
|---|---|---|---|
| ④ | `describeAll()` | 枚举清单时**过滤掉** `RETIRED_PACKAGES` 里的包 | 它们不该再存在；列出来只会诱导用户点「更新」把它们用 `name@latest`（npm）或**原始 source**（git）装回来 |
| ⑤ | `updateOne(退役包)` | 额外挡住：`{ok:false, stage:'check', error:'这个插件已经退役，能力已并入 dsh-usage-aggregator，不应再装回来'}` | ⑤ 是**超出清单的第 4 条的补充**：显式点名（Agent 工具 / 手写 POST body）也是一条复活路径，一并挡住 |

第 ④ 条已经让「全部更新」安全（`updatableNames()` 来自过滤后的清单）；
第 ⑤ 条补上「显式点名」这条路。

### 4.5 夹具同步

`fixtures/state.json` 是迁移前抓的真机响应，里面还留着 `dsh-axzo-theme` /
`dsh-usage-query` / `dsh-plugin-expander` 三条 —— 按新的过滤逻辑，这三条**应该**
被剔掉。`selfcheck.mjs` 里的断言就是按新逻辑写的：

- 夹具里退役包的条目数 **正好是 3**，且包含旧的 `dsh-plugin-expander`；
- 夹具里**不含** `dsh-usage-aggregator`（抓的时候聚合包还没装上）；
- 夹具的 `ok` / `packages` / `summary` / `job` 形状照旧断言。

---

## 5. 刻意未改（逐条钉住）

| 项 | 说明 |
|---|---|
| **Agent 工具名 `plugin_update`** | 一个字没改。改名会破坏已有用法（对话里已经这么叫了）。 |
| **工具的 schema** | `PARAMETERS`（`action` 枚举 `check`/`update`、`names`、`all`、`required:['action']`、`additionalProperties:false`）逐字未改。 |
| **工具的描述与输出渲染** | `description` 逐字未改；`output.render` 的两段文案逐字未改；返回形状 `{ok, text, packages}` / `{ok, error}` 未改。 |
| **`isConcurrencySafe: () => false`** | 逐字未改 —— 更新会改动整个 profile，绝不与别的工具并发。 |
| **权限闸门** | `ctx.get('sandboxPolicy')` → `policy.resolve({session})` → `mode !== 'danger-full-access'` 抛错；**没有 `sandboxPolicy` 服务时不做限制**。错误文案逐字未改。 |
| **semver 比较规则** | `registry.js` 的 `parseVersion` / `comparePre` / `compareVersions` / `isUpgrade` 逐字未改：不引 semver、只比主干与 prerelease 先后、忽略 build metadata、拆不出返回 `null`（比不了）、「本地比远端新」不算更新（不降级）。 |
| **lockfile 解析的缩进规则** | 依赖名 6 空格、字段 8 空格；依赖名下面的 4 行内找 `version:`，先遇到别的字段就放弃；作用域包名去掉引号；只有 40 位十六进制才算「固定提交」。逐字未改。 |
| **proc 的永不抛异常约定** | 超时、找不到可执行文件、退出码非零**都不抛**，一律 resolve `{code, stdout, stderr, timedOut}`。逐字未改。 |
| **只管 `availability === 'profile'`** | 随 DSH 发行版装的那批不在管辖范围内。 |
| **local / alias / pinned / ahead 一律不可更新** | 四种情况的判定与 `updatable:false` 逐字未改。 |
| **npm 分支用 `name@latest`、git 分支用原始 `bundle.source` 重装** | 逐字未改。 |
| **批量串行、单条失败不中断整批** | `startUpdate` / `updateNow` 都是 `for ... await`，逐字未改。 |
| **60 秒清单缓存** | `CACHE_TTL_MS = 60000`，逐字未改。 |
| **单一全局任务槽** | `job.running` / `job.current` / `job.results` 一份，逐字未改；已有任务在跑时返回 `{ok:false, error:'已有更新任务在进行中'}`。 |
| **「全部更新」的可更新判定** | 仍是 `updatable === true`（只改了一处：额外排除自己）。 |
| **`profileContext` 用取值器** | `getProfileDir()` / `getPnpm()` 保持原形状：服务晚一步到位时，取值器返回 `process.env.DSH_PROFILE_DIR ?? process.cwd()` 与默认 `pnpm`，而不是把插件卡住。 |
| **可选注入** | `webServer` / `profileContext` / `pluginManager` 一律走 `ctx.inject([...], cb)`；顶层 `inject` 只有 `['tools']`（在聚合入口 `src/host/index.js`）。多声明一个不存在的服务会让 entry 永远 pending。 |
| **已装清单与安装动作走官方管理器** | `listBundles()` / `removeBundle()` / `installBundle()` 一行未改 —— profile 写锁、失败回滚、HMR 重载、构建脚本审批全都沿用官方机制。 |

---

## 6. 自查

```bash
# 语法自检
cp src/host/features/expander/index.js /tmp/x.mjs && node --check /tmp/x.mjs

# import 完整性（不该有副作用）
node -e "import('./src/host/features/expander/index.js').then(()=>console.log('OK'),e=>{console.error(e.message);process.exit(1)})"

# 离线自检（72 项断言）
node src/host/features/expander/selfcheck.mjs
```
