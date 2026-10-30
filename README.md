# dsh-usage-aggregator

## 定位

一个 DSH 插件，装下多件能力（当前四项）：

| 能力 | 做什么 |
|---|---|
| **用量查询** | 把第三方接口的额度 / 余量 / 次数 / 账单变成卡片。粘一次请求即接入，之后 Agent 自己查 |
| **安心筑品牌主题** | 侧栏 logo、43 个主题 token、玻璃首屏、会话区品牌背景、任务状态徽标 |
| **插件更新** | 检测并安装 profile 里已装插件的新版本（官方「插件」页只管官方 bundle） |
| **电脑加速与清理** | 右下角一枚可拖动的「小火箭」：体检这台机器为什么慢，列出**本机实际装了**的包管理器缓存、DSH 自己的冗余数据、占内存/占 CPU 的进程与浏览器里非活跃的窗口，让你勾选，交给 Agent 执行 |

**插件管理器里占一行，设置面板里占一个入口**（`AxzoAggregator`，内含四个页签）。
这是本包存在的理由：此前三个插件各占一行、各占一个设置入口。

## 结构

一个 DSH 插件 = 一个 npm 包 = 一个 `client/client.js` + 一个 Host 入口。
客户端（浏览器）与 Host（Node）通过 HTTP 路由通信 —— 路由是最小的跨半边契约。

```
src/client/          客户端半边
  index.js           装配层：注册 4 个 locale 命名空间 → 建 4 个 translator → 依次 apply
  hub/               聚合设置页：一个 settings.section + 四个页签
  shared/            i18n / api / constants
  features/          theme · usage · expander · boost（互不 import）
src/host/            Host 半边
  index.js           装配层：遍历功能，交给各功能的 apply
  shared/            http（统一的路由与安全网关）· context（配置与端点）· llm（收模型正文）
  features/          theme（空座位）· usage · expander · boost
client/client.js     构建产物（DSH 加载它）
vite.config.mjs      构建链（必须在仓库根）
scripts/             验证套件
docs/adr/            架构决策记录
```

**功能契约**（新增功能 = 一个目录 + 两行登记）：

- 客户端模块导出 `meta` / `dictionaries` / `apply(ctx, t)` / `HubView(props)`
- Host 模块导出 `id` / `routePrefix` / `apply(ctx, cfg, shared)`
- 功能之间零 import，只依赖各自半边的 `shared/`

## API

**Agent 工具**（Host 注册）：

| 工具 | 动作 |
|---|---|
| `usage_query` | `list` · `refresh` · `renew` · `import` · `remove` |
| `plugin_update` | `check`（只读）· `update` |
| `system_boost` | `scan`（体检，只读）· `execute`（清理勾选的缓存） |

**HTTP 路由**（16 条，全部在 `/dsh-usage-aggregator/` 之下）：

| 前缀 | 条数 | 用途 |
|---|---|---|
| `/usage` | 11 | 查询 / 接入 / 续期 / 重分析 / 移除 / 字段顺序 / 模型 / 芯片 / 原始响应 |
| `/expander` | 2 | `state`（已装清单与更新状态）· `update`（执行更新） |
| `/boost` | 3 | `scan`（开始体检）· `status`（轮询体检进度）· `execute`（清理勾选的条目） |

**配置**：写在 profile 的 `cordis.patch.yml` 里，**只对 Host 半边生效**。

```yaml
- insert:
    - id: dsh-usage-aggregator
      name: 'dsh-usage-aggregator'
      config:
        endpoint: /dsh-usage-aggregator
        allowRemote: false
```

配置项全貌见 [`cordis.patch.yml`](cordis.patch.yml)。

## 示例

**安装**（顺序不能反，见下）：

```bash
dsh plugin --profile web remove dsh-axzo-theme
dsh plugin --profile web remove dsh-usage-query
dsh plugin --profile web remove dsh-plugin-expander
dsh plugin --profile web add https://axzsource.com/gaozhipeng/dsh-usage-aggregator.git
```

> 旧包只要还留在依赖清单里，「全部更新」就会用 `name@latest` 把它们**装回来**。
> 本包内置自我保护：三个旧包名从清单里过滤掉，自己虽然可见但不会被「全部更新」选中。

**本地开发**：

```bash
pnpm install
pnpm run build      # → client/client.js
pnpm run check      # 一把跑全部验证
```

**用 Agent 查用量**：

```
查一下我的用量
```

**接入一个用量接口**（面板里粘贴 DevTools → Copy as cURL，或上传用量页截图）：

```
把这个接口接进来：curl --url 'https://.../usage' -H 'accept: application/json' -b '_token=…'
```

**查已装插件有没有新版本**：

```
看看我的插件有没有能升级的
```

**加速与清理**：点右下角的「小火箭」→ 体检 → 勾选 → 「交给 Agent 执行」。
Agent 会先说明要做什么再动手；会话不可用时面板直接执行。

清单分三段：**工具链缓存**（npm / pnpm / uv / brew … 的官方清理命令）、**DSH 自己**
（回收站里的旧快照、孤儿子代理会话、过期会话、已归档会话、投影缓存残留、旧附件、
自动续期用的浏览器配置）、**进程与窗口**（占内存的应用与单个进程、后台高占 CPU 的
任务、浏览器里非聚焦的窗口）。每一条都写清楚「做了会怎样」，勾选框旁边就是代价。

也可以直接在对话里说：

```
帮我看看这台电脑为什么这么慢，把能清的缓存列出来
```

## 关系

- **DSH**：作为普通插件装进 profile。客户端半边是浏览器里的 IIFE 产物，Host 半边是 Node 里的 cordis 插件；两者都靠 `cordis.patch.yml` 的一行 insert 接入。
- **取代** `dsh-axzo-theme` / `dsh-usage-query` / `dsh-plugin-expander` 三个插件。功能、数据路径、locale 命名空间、工具名、槽位 id 全部原样保留 —— 已接入的接口与主题设置接着用。
- **依赖 DSH 官方能力**：已装清单走官方 `pluginManager.listBundles()`，安装动作走官方 `removeBundle` + `installBundle`（继承 profile 写锁、失败回滚、HMR 重载、构建脚本审批）。本包不自己碰 pnpm。
- **数据落本机**：用量凭证在 `$DSH_HOME/dsh-usage-query/store.json`（0600），**永不发往浏览器**；主题偏好在 `localStorage` 的 `dsh-axzo-theme:*`。
- **安全边界**：路由默认只接受回环地址 + 同源，POST 要求 `application/json`。`plugin_update` 的 update 动作、`system_boost` 的 execute 动作都要求 danger-full-access。
- **清理分三类，代价不同的默认状态也不同**：**工具链缓存**（在运行时按本机实际装的工具现场发现：探测工具 → 问工具要自己的缓存目录 → 用工具官方的清理命令）默认全勾；**DSH 自己的数据**（回收站、旧格式日志、孤儿子代理会话、过期会话、已归档会话、投影缓存残留、旧附件、续期用的浏览器配置）里可重建/已删除的默认勾，**会删用户历史的不勾**；**进程与窗口**（占内存的应用与单个进程、高占 CPU 的任务、浏览器里非聚焦的窗口）里无损的（降优先级、结束崩掉的残留进程）默认勾，**会关程序/关窗口的不勾**。
- **安全边界**：不用 sudo、不碰源码、不碰工作区 node_modules、不动系统目录；正在被运行中的进程占用的目录会自动跳过；结束进程前会复核 pid 现在的命令行（pid 会被回收复用）；DSH 自己的进程、系统进程、root 的进程、用户当前正在前台用的应用一律不碰。

架构细节见 [ARCHITECTURE.md](ARCHITECTURE.md)，决策理由见 [docs/adr/](docs/adr/)。

## 许可

MIT
