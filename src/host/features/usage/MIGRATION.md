# 迁移对照表 · dsh-usage-query（Host 半边）→ dsh-usage-aggregator

本次迁移把 **dsh-usage-query 插件的 Host 半边**整体搬进聚合插件，成为
`src/host/features/usage/` 这一个功能模块。

> 源：`/Users/gaozhipeng/Desktop/work/dsh-usage-query/lib/**`
> 目标：`/Users/gaozhipeng/Desktop/work/dsh-usage-aggregator/src/host/features/usage/**`

**结论：零能力丢失。** 16 个模块全部到位；14 个文件逐字节一致（仅注释里的路径
从 `lib/` 改成 `src/host/features/usage/`），2 个文件按聚合契约重写（`server.js`
改用共享传输层、`index.js` 改成功能契约）。下表是「零能力丢失」审计的依据。

---

## 1. 文件对照表

| 原文件 | 新文件 | 状态 | 说明 |
| --- | --- | --- | --- |
| `lib/curl.js` | `src/host/features/usage/curl.js` | 逐字节一致 | 粘贴请求 → 可重放请求描述 + 凭证过期时间 |
| `lib/request.js` | `src/host/features/usage/request.js` | 逐字节一致 | 真实重放 + ok / expired / error 判定 |
| `lib/paths.js` | `src/host/features/usage/paths.js` | 逐字节一致 | ⚠️ **JSON 取数路径求值器**（`$.a.b[0].c`），不是磁盘路径 |
| `lib/labels.js` | `src/host/features/usage/labels.js` | 逐字节一致 | 字段名启发式词表（英 → 中）+ 重要性排序 |
| `lib/resolve.js` | `src/host/features/usage/resolve.js` | 逐字节一致 | 模板 + 响应 → 可渲染 view（确定性，不再调模型） |
| `lib/template.js` | `src/host/features/usage/template.js` | 逐字节一致 | 模板校验 + 无模型时的结构兜底 |
| `lib/analyze.js` | `src/host/features/usage/analyze.js` | 逐字节一致 | 调本地模型：响应 → 模板；截图 → 快照 |
| `lib/store.js` | `src/host/features/usage/store.js` | 逐字节一致 | 落盘与脱敏（`maskProvider()` 是唯一可外发投影） |
| `lib/auto.js` | `src/host/features/usage/auto.js` | 逐字节一致 | 自动查询 / 自动续期的**纯函数**判定 |
| `lib/cdp.js` | `src/host/features/usage/cdp.js` | 逐字节一致 | 驱动带持久化 profile 的 Chrome（CDP） |
| `lib/renewal/index.js` | `src/host/features/usage/renewal/index.js` | 逐字节一致 | 续期分发：认站点 / 换 token / 拼回请求 |
| `lib/renewal/dingtalk.js` | `src/host/features/usage/renewal/dingtalk.js` | 逐字节一致 | 钉钉 OAuth 的具体走法 |
| `lib/ops.js` | `src/host/features/usage/ops.js` | 逐字节一致 | 对外能力唯一实现（面板与工具共用） |
| `lib/tool.js` | `src/host/features/usage/tool.js` | 逐字节一致 | Agent 工具定义（`usage_query`） |
| `lib/server.js` | `src/host/features/usage/server.js` | **重写** | 传输层换成共享 `buildRoutes`（见 §4） |
| `lib/index.js` | `src/host/features/usage/index.js` | **重写** | 装配逻辑搬进 `apply(ctx, featureConfig, shared)`（见 §5） |

> 「逐字节一致」= 代码零改动；仅文件头注释与正文里指向 `lib/` 的路径说明改成了
> 新路径（`lib/xxx.js` → `xxx.js`，`lib/renewal/` → `renewal/`）。
> 已用脚本逐行校验：**14 个文件的每一处差异都是注释行**。

### 新增文件

| 文件 | 作用 |
| --- | --- |
| `src/host/features/usage/index.js` | 功能契约：`export const id` / `export const routePrefix` / `export function apply(ctx, featureConfig, shared)` |
| `src/host/features/usage/MIGRATION.md` | 本文件 |

---

## 2. 路由对照表（11 条，顺序未变）

公共前缀：`/dsh-usage-aggregator`（`shared.base`，默认取 `config.endpoint`）。
功能段：`/usage`（`routePrefix`）。

| # | 方法 | 旧路径 | 新路径 | 处理器 |
| --- | --- | --- | --- | --- |
| 1 | GET | `/dsh-usage-query` | `/dsh-usage-aggregator/usage` | `ops.state()` |
| 2 | POST | `/dsh-usage-query/import` | `/dsh-usage-aggregator/usage/import` | `ops.import({text, image, label, replaceId})` |
| 3 | POST | `/dsh-usage-query/refresh` | `/dsh-usage-aggregator/usage/refresh` | `ops.refresh(id)` |
| 4 | POST | `/dsh-usage-query/renew` | `/dsh-usage-aggregator/usage/renew` | `ops.renew(id, {interactive})` |
| 5 | POST | `/dsh-usage-query/reanalyze` | `/dsh-usage-aggregator/usage/reanalyze` | `ops.reanalyze(id, {image})` |
| 6 | POST | `/dsh-usage-query/remove` | `/dsh-usage-aggregator/usage/remove` | `ops.remove(id)` |
| 7 | POST | `/dsh-usage-query/order` | `/dsh-usage-aggregator/usage/order` | `ops.setFieldOrder(id, paths)` |
| 8 | GET | `/dsh-usage-query/models` | `/dsh-usage-aggregator/usage/models` | `ops.listAnalysisModels()` |
| 9 | POST | `/dsh-usage-query/analysis-model` | `/dsh-usage-aggregator/usage/analysis-model` | `ops.setAnalysisModel(provider, model)` |
| 10 | POST | `/dsh-usage-query/chip` | `/dsh-usage-aggregator/usage/chip` | `ops.setChipProvider(id)` |
| 11 | GET | `/dsh-usage-query/raw` | `/dsh-usage-aggregator/usage/raw` | `ops.raw(id)` |

客户端契约：`src/client/shared/constants.js` 的 `USAGE_ENDPOINT = ENDPOINT_BASE + '/usage'`
与上表一致。

### 传输层语义（等价并更严）

| 场景 | 旧实现 | 新实现（共享 `buildRoutes`） |
| --- | --- | --- |
| GET 返回 | 200 | 200（**一致**） |
| POST 且返回体 `ok === false` | 400 | 400（**一致**） |
| 处理器抛异常 | 500 `{ok:false,error}` | 500 `{ok:false,error}`（**一致**） |
| 请求体超限 | 413 | 413（**一致**，12MB） |
| JSON 非法 | 400 | 400（**一致**） |
| 非回环地址（`allowRemote:false`） | 403 | 403（**一致**，文案措辞略变） |
| **同源校验** | 无 | **新增** 403 —— 跨站 POST 不带 Origin 校验的话本机会替它装插件 |
| **POST 必须 `application/json`** | 无 | **新增** 415 —— 带 JSON 的跨站请求会先走 CORS 预检，我们不回 CORS 头，预检即失败 |

客户端一直是同源 + JSON 请求，两道新闸不影响正常路径。
请求体上限沿用旧值 **12MB**（要传 base64 截图）→ `BODY_LIMIT_WITH_IMAGE`。

---

## 3. 配置键映射表

原 `dsh-usage-query` 的 config 是**平铺**的；现在按功能分段，本功能读 `config.usage`。

| 原 config 键 | 现在读哪里 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `endpoint` | `shared.base` | `/dsh-usage-aggregator` | 公共前缀；用量段再挂 `/usage` |
| `allowRemote` | `shared.allowRemote` | `false` | 只有本机（回环）能访问路由 |
| `analysis.provider` | `featureConfig.analysis.provider` | `axzo-one` | 分析用 provider |
| `analysis.model` | `featureConfig.analysis.model` | `auto/deepseek-flash` | 分析用模型 |
| `analysis.language` | `featureConfig.analysis.language` | `zh`（`en` 走英文） | 模板标签语言 |
| `analysis.maxOutputTokens` | `featureConfig.analysis.maxOutputTokens` | `4000` | 模型输出额度 |
| `analysis.allowImage` | `featureConfig.analysis.allowImage` | `true` | 关掉后只接受粘贴请求文本 |
| `autoRefresh.enabled` | `featureConfig.autoRefresh.enabled` | `true` | `false` 时**整个定时器 effect 不注册** |
| `autoRefresh.intervalSeconds` | `featureConfig.autoRefresh.intervalSeconds` | `300` | 夹在 60 ~ 86400 秒之间 |
| `renewal.enabled` | `featureConfig.renewal.enabled` | `true` | 自动续期总开关 |
| `renewal.leadSeconds` | `featureConfig.renewal.leadSeconds` | `1800` | 到期前多久动手（30 分钟） |
| `renewal.cooldownSeconds` | `featureConfig.renewal.cooldownSeconds` | `1800` | 失败后冷却多久（30 分钟） |
| `request.timeoutMs` | `featureConfig.request.timeoutMs` | `30000` | 单次请求超时 |

> `ops.js` 的依赖注入形状**没变**：`createOps({ config, llm, attachments })`。
> 只是 `deps.config` 的内容从「整份 config」换成了「featureConfig（= `config.usage`）」，
> 于是 `ops.js` 里那 8 处 `config.analysis` / `config.request` / `config.autoRefresh` /
> `config.renewal` 的读法一字不改就落到了新位置。

---

## 4. `server.js` 的改动

**旧**：`createRoutes({ ops, endpoint, allowRemote })` —— 自带一份 HTTP 传输层
（`isLoopback` / `send` / `readJson` / `guard` / `json` / `get`）。

**新**：`createRoutes({ ops, shared })` —— 传输层全部交给共享实现
（`src/host/shared/http.js`），本模块只负责「这一段路径 ↔ 这一组操作」的对应关系。

```js
import { BODY_LIMIT_WITH_IMAGE } from '../../shared/http.js';
```

> ⚠️ 相对路径是 **`../../shared/http.js`**，不是 `../../../shared/http.js`。
> 本文件位于 `src/host/features/usage/`，往上两级是 `src/host/`，`src/host/shared/http.js`
> 正好在那里；三级会指到并不存在的 `src/shared/http.js`。

`allowRemote` 不再单独传 —— `shared.routes(specs, options)` 已经把它交给
`buildRoutes`，所以 `options` 里只放 `bodyLimit`。

---

## 5. `index.js` 的改动

原 `lib/index.js` 的 `export const name` / `export const inject` **已删除** ——
聚合入口 `src/host/index.js` 统一声明（`name = 'dsh-usage-aggregator'`、
`inject = ['tools']`）。

装配逻辑整体搬进功能契约：

```js
export const id = 'usage';
export const routePrefix = 'usage';          // = server.js 的 ROUTE_PREFIX
export function apply(ctx, featureConfig, shared) { … }
```

| 原 `lib/index.js` | 新 `usage/index.js` |
| --- | --- |
| `const endpoint = config.endpoint \|\| '/dsh-usage-query'` | `shared.base`（+ `/usage`） |
| `allowRemote: config.allowRemote === true` | `shared.allowRemote`（由 `shared.routes` 注入） |
| `config.autoRefresh` | `featureConfig.autoRefresh` |
| `createOps({ config, llm, attachments })` | `createOps({ config: featureConfig, llm, attachments })` |
| `ctx.inject(['webServer'], …)` | 同（**webServer 缺失时路由整体不生效，工具仍然可用**） |
| `ctx.effect(…, 'dsh-usage-query: http routes')` | `'dsh-usage-aggregator: usage http routes'` |
| `ctx.effect(…, 'dsh-usage-query: auto refresh')` | `'dsh-usage-aggregator: usage auto refresh'` |
| `ctx.effect(…, 'dsh-usage-query: usage_query tool')` | `'dsh-usage-aggregator: usage_query tool'` |
| 日志前缀 `[dsh-usage-query]` | `[dsh-usage-aggregator/usage]` |

自动刷新定时器保持原样：`setInterval(…, 60000)` 按拍检查、effect cleanup 里
`clearInterval`、`running` 防堆积标志、两行可 grep 的日志（成功 / 失败）。

---

## 6. 刻意未改清单

以下都是**故意保持原样**的 —— 改了会让用户的存量数据、存量模型用法或存量文档失效。

| 项 | 保持的值 | 为什么不能动 |
| --- | --- | --- |
| **主数据路径** | `$DSH_HOME/dsh-usage-query/store.json`（目录 `0700` / 文件 `0600`） | 目录名一旦改，用户已配置的接口 / 模板 / 字段顺序 / 芯片选择 / 分析模型选择会**静默消失** |
| **Chrome profile 路径** | `$DSH_HOME/dsh-usage-query/profiles/<profileId>/` | 改名会丢钉钉会话，用户得重新扫码授权 |
| **`providerIdFrom()` slug 规则** | 小写化 → 非 `[a-z0-9\u4e00-\u9fa5._-]` 折成 `-` → 去首尾 `-` → 截 32 字 → 同名加 `-2`/`-3`… | id 变了，面板里已排好的字段顺序、用户记住的接口名全部对不上 |
| **Agent 工具名** | `usage_query` | 改名会破坏已有的模型用法与文档（模型已经学会调这个名字） |
| **工具 schema** | `parameters` / `output.schema` / `output.render` / `isConcurrencySafe: () => false` | 同上；实测与源**逐字段一致** |
| **脱敏投影** | `maskProvider()` 仍是**唯一**允许发给浏览器的记录投影；请求头只给**名字**、URL 查询串打码、body 不外发 | 绕过它等于把 Cookie / Token 发给前端 |
| **送模型的请求摘要** | `requestSummary()` 把 `cookie` / `authorization` / `token` / `x-api-key` / `api-key` 的**取值**抹成 `<已省略…>` | 同上；凭证不进模型上下文 |
| **`withLock` 串行锁** | 写操作排队，读操作直通 | 面板「全部刷新」是并发发出去的，不锁会互相覆盖、最后写回的那条吞掉另一条 |
| **`effectiveAnalysis()` 优先级** | 面板选的模型 > 配置默认；且**每次重读 store、不缓存** | 缓存会让面板改完不立即生效 |
| **`applyResult()` 三条件** | 只有「模板缺失 / 兜底版本落后 / 结构指纹变了」才重新分析 | 多余地重新分析 = 每次刷新都花一次模型调用，且结果会飘 |
| **`renewal/` 不 import `store.js`** | 刻意保持循环依赖的反向依赖 | `store.js` 要用 `describeRenewal()`；从这里 import 回去就成环。**appDir 必须由调用方（ops / CLI）传进去** |
| **`ops.js` 末尾的 `export { guessTitle }`** | 保留 | 外部引用点 |

---

## 7. 自检结果

| 检查 | 结果 |
| --- | --- |
| 语法自检（16 个文件 `cp` 成 `/tmp/x.mjs` 后 `node --check`） | ✅ 16/16 通过 |
| 导入完整性自查（`node -e "import('./src/host/features/usage/index.js')"`） | ✅ `OK — module loaded`，导出恰为 `apply, id, routePrefix` |
| 导出面对比（源 vs 目标，14 个模块） | ✅ 逐模块一致 |
| 工具定义对比（name / description / parameters / output / render / 并发标记） | ✅ 逐字段一致 |
| 行为等价（同一组场景跑源与目标） | ✅ 输出完全一致（仅本地测试端口号不同） |
| 路由注册（11 条，路径唯一，顺序与源一致） | ✅ 通过 |
| effect 名（3 条聚合前缀） | ✅ 通过 |
| 磁盘路径 / `providerIdFrom` slug | ✅ 未变 |

### 行为等价覆盖到的三段语义

| 语义 | 场景 | 源 | 目标 |
| --- | --- | --- | --- |
| `effectiveAnalysis()` | 无选择 → 配置默认 | `axzo-one/auto/deepseek-flash` `source=config` | 同 |
| | 面板选了 → 优先 | `user-p/user-m` `source=user` | 同 |
| | 选了 provider 但 model 空 → 回落配置的 provider | `user-p/axzo-one` | 同 |
| | 换选择后立刻重读（不缓存） | `later-p` 立即生效 | 同 |
| `applyResult()` | 模板缺失 → 重新分析 | 1 次模型调用 | 同 |
| | 指纹未变 → 不重新分析 | 0 次模型调用 | 同 |
| | 指纹变了 → 重新分析 | 1 次模型调用 | 同 |
| | 兜底版本落后 → 重新分析 | 1 次模型调用 | 同 |
| `withLock` | 并发 `remove` + `setFieldOrder` × 60 轮 | 0 次丢更新 | 同 |
| 脱敏 | 投影里出现 cookie / token 取值 | 否 / 否 | 否 / 否 |

---

## 8. 留给客户端的接口约定

客户端必须把面板里所有 `fetch` 的基址从 `/dsh-usage-query` 换成
`/dsh-usage-aggregator/usage`（客户端常量：`src/client/shared/constants.js` 的
`USAGE_ENDPOINT`）。所有请求**仍是同源 + `application/json`**，共享传输层新增的
两道闸（同源校验 / POST 必须 JSON）不会误伤。

**旧路径 `/dsh-usage-query/*` 不再存在** —— 迁移后没有兼容层：这是聚合插件的一次性
切换，不做双写。
