# CHANGELOG

本文件记录 **dsh-usage-aggregator** 的版本变化。

格式：`## <版本> · <日期> · <标题>`；发布前先写 `## Unreleased` 节，
`pnpm release` 会把它改写成正式版本节。

---

## 0.2.2 · 2026-11-02 · 体检挪到后台自动做；执行完清单自动刷新

### 变更

- **体检改成后台自动做**：机器空闲（1 分钟负载 < 2）时每 12 小时自动体检一次，
  即每天两次。点小火箭直接看缓存好的结果（原来点开才扫，得等半分钟到一分多钟）。
  体检结果的保鲜期跟着自动体检的节奏走（12 小时）。面板上写着这份结果是多久前的
  （「3 小时前体检的」），免得把旧数据当成眼前的实况。
- **执行完清单自动重扫**：清掉的条目从清单里消失，面板内容区回到当下的实况
  （原来执行完还挂着那份已经清掉的清单，看着像还有 36 GB 可清）。

---

## 0.2.1 · 2026-10-30 · 修掉「交给 Agent」卡住不动

### 修复

- **交接不再可能永远卡住**：点「交给 Agent 执行」之后，那条 `conversation.send`
  的 RPC 可能既不 resolve 也不 reject（会话取不到、通道断了、Host 那边正忙），
  于是按钮永远停在「正在交给 Agent…」，什么也没发生。现在取会话、取
  conversation、发消息三步全都裹了异常处理，**再加 10 秒超时**：任何一步不成，
  立刻改由面板直接执行，并在面板上写明为什么改走这条路。
- **执行改成后台任务，界面上看得见进度**：清一批缓存要好几分钟（npm cache
  clean --force 一下就是一两分钟），原来是一个同步请求干等，用户既看不到跑到
  哪了，也不知道是不是还活着。现在 `POST /boost/execute` 起一个后台任务立刻
  返回任务号，客户端轮询 `GET /boost/execute-status`，面板上有一条进度条和
  「正在执行 3/12：npm cache clean --force」。

### 变更

- 交接单里写明执行清理需要 danger-full-access 权限；权限不够就让 Agent 直接
  说明并停手，别反复重试。
- 新增 1 条 HTTP 路由（`/boost/execute-status`），boost 共 4 条、全包 17 条。

---

## 0.2.0 · 2026-10-30 · 电脑加速与清理

第四块能力：内容区域右下角一枚可拖动的「小火箭」。

### 新增

- **电脑加速与清理**
  点小火箭 → 播放发射动画 → 展开这台机器的体检结论与可加速 / 可清理的清单 →
  逐项勾选 → 「交给 Agent 执行」：Agent 先用一两句话说明要做什么，再调
  `system_boost` 的 `execute` 动作执行；会话不可用时面板直接执行兜底。
  设置页「加速」页签是同一份结果的整页视图。
  清单分三段，**全部在运行时现场发现**：
  - **工具链缓存**：探测工具装没装 → 问工具要自己的缓存目录 → 用工具官方的清理
    命令（npm / pnpm / yarn / bun / uv / pip / brew / cargo / CocoaPods / gem /
    go / composer / dotnet，以及 pnpm 升级后留下的旧版本存储目录）。只清可再生的
    缓存 —— 不碰源码、不碰工作区 `node_modules`、不用 `sudo`。
  - **DSH 自己**：回收站里的旧快照、旧格式会话日志、孤儿子代理会话（父会话已被
    删掉的那些）、N 天没动过的会话、已归档会话的正文、会话投影缓存的残留、旧附件、
    自动续期用的那个浏览器的用户配置。
  - **进程与窗口**：按应用聚合的内存大户（可整组结束，也可只结束其中某个进程）、
    后台高占 CPU 的任务（降优先级，无损）、孤儿子进程、浏览器里非聚焦的窗口
    （用浏览器自己的 AppleScript 枚举，不需要辅助功能权限）。

  默认勾选按代价分档：可重建 / 已删除 / 无损的默认勾上；**会删用户历史、
  会关程序、会关窗口的默认不勾**，每条旁边写清楚「做了会怎样」。
  Agent 工具 `system_boost`（`scan` / `execute`，execute 走 danger-full-access
  闸门）。4 条 HTTP 路由。

### 变更

- 聚合页新增第四个页签 `加速`。

### 架构

- **两半 × 四功能 + 共享内核**：`src/client/` 与 `src/host/` 各有 `shared/` 与
  `features/{theme,usage,expander,boost}/`。功能之间**零 import**，只依赖共享内核。
  「收模型正文」那段实现在两个功能里都要用，提到 `src/host/shared/llm.js`。
- 加速清理的清单有三个来源（`catalog.js` 工具链缓存 / `dshself.js` DSH 自己 /
  `processes.js` 进程与窗口），合并成同一份给用户勾选；条目带上 `action`，
  执行器按动作类型分发。

### 安全

- **加速清理的护栏**：白名单（能清的目标只来自三个目录，客户端只传条目 id，
  路径在执行前重新解析）、在用即跳过（删之前扫一遍运行中进程的命令行，出现在
  要删路径里的子目录跳过不删 —— 实测 `~/.npm/_npx/<hash>` 正在跑 MCP server，
  `~/Library/Caches/pnpm/dlx/<hash>` 更是正在运行的 DSH 自己）、路径合法
  （绝对路径、存在、不是根目录、不是家目录本身、不含 `..`）。
- **进程层的护栏**：不碰 DSH 自己的进程（进程树 + 命令行标记 + 祖先三重判定，
  工具驱动的浏览器整个跳过）、root 的进程、系统进程、用户当前在前台的应用；
  结束进程前**复核 pid 现在的命令行**（pid 会被回收复用），只发 SIGTERM；
  降优先级用 renice，进程还在，只是不再抢 CPU。
- **会话层的护栏**：正在跑的会话不删；删会话时重新解析一次「哪些是孤儿子代理」
  （父会话已经不在盘上的），不按体检时的旧结论直接删；删归档会话前先把它从
  DSH 的归档清单里摘掉（走官方 `unarchiveSession`）。
- 每次清理写审计日志（`$DSH_HOME/dsh-usage-aggregator/boost.log`）。

### 验证

- `scripts/boost-check.mjs` —— 39 项断言覆盖护栏、目录表、诊断兜底、工具契约、
  HTTP 契约，以及 DSH 数据与进程层的新动作（在临时目录里做，绝不碰用户真实数据）。
  其中「在用即跳过」是**真跑一个进程**验的：起一个 `tail -f`，让执行器读真实的
  `ps` 输出，确认那个目录被留下、别的被清掉。
- `scripts/ui-check-boost.mjs` —— 14 项断言用真实 react 离线渲染小火箭与设置页视图，
  夹具是本机真跑出来的体检结果（`src/host/features/boost/fixtures/scan.json`，
  覆盖缓存 / DSH / 进程三组）。
- `scripts/verify.sh` 挂了上面两段；路由检查与客户端契约检查同步扩展（4 个功能、
  16 条路由、多一个 `shell.overlay` 槽位）。

---

## 0.1.0 · 2026-10-30 · 聚合三个插件：用量查询 / 安心筑主题 / 插件更新

首个版本。三块能力合并成一个 DSH 插件 —— 插件管理器里只占一行，设置面板里只占
一个入口（三页签）。

### 新增

- **用量查询**（原 `dsh-usage-query` 0.2.0）
  粘贴一次接口请求（cURL）或用量截图即可接入：Host 端真实重放请求，本地已配置的
  模型分析「请求 + 响应」生成展示模板并缓存，把额度 / 余量 / 次数 / 账单渲染成卡片。
  凭证过期直接引导重贴；支持钉钉 OAuth 自动续期（只换 `authorization` 里的 token，
  不花模型调用）。Agent 工具 `usage_query`（`list` / `refresh` / `renew` / `import` /
  `remove`）。11 条 HTTP 路由。
- **安心筑品牌主题**（原 `dsh-axzo-theme` 0.1.13）
  侧栏品牌替换（官方 logo 内联 SVG path）、43 个 DSH 主题 token 覆盖（26 个
  `--dsw-*` + 17 个 `--dsh-axzo-*`）、玻璃首屏舞台、会话主区品牌背景、侧栏玻璃
  质感、任务状态徽标、全域氛围光与顶部流光。跟随系统「减弱动效」与「增强对比度」
  偏好。设置面板提供 6 套预设色板、HSL 三滑杆、5 个视觉开关、品牌自定义
  （logo / 名字 / 标语 / 11 套字体）与一键「低刺激」护眼预设。
- **插件更新**（原 `dsh-plugin-expander` 0.3.0）
  检测并安装当前 profile 已装插件的新版本：已装清单走官方插件管理器，npm 包查
  注册表、git 包比远端 HEAD，安装一律走官方「卸载 + 安装」两步（继承 profile 写锁、
  失败回滚、HMR 重载与构建脚本审批）。Agent 工具 `plugin_update`（`check` /
  `update`，更新走 danger-full-access 闸门）。2 条 HTTP 路由 + 插件页「更新」标签页。
### 变更

- **设置入口改名** `用量聚合` → **`AxzoAggregator`**；聚合页三个页签改名
  `主题外观` → **`Theme`**、`用量查询` → **`流量`**、`插件更新` 不变。
- **页签选中态改样式**：去掉选中时的色块填充，改为「品牌色描边 + 品牌色文字 +
  加粗」，未选中时字重降到 500。
- **「插件更新」默认选中**：打开设置页先停在这一页，进去就自动检测可更新的
  插件；检测与更新期间所有操作按钮禁用，并显示「检查中…」/「正在更新中」提示、
  当前正在更新的包名与进度条（`已完成 n / N`）。Host 侧的 job 增加了 `total`
  字段供客户端算进度分母。

### 架构

- **单包架构**：一个 npm 包 = 一个 DSH 插件 = 一行插件管理器条目 = 一个设置面板
  入口。不采用 TurboRepo / pnpm workspace —— 产物必须是一个 `client/client.js`，
  多包要么各出一个没人加载的 bundle，要么再加一层组装包（详见
  [ADR 0001](docs/adr/0001-single-package-not-monorepo.md)）。
- **两半 × 三功能 + 共享内核**：`src/client/` 与 `src/host/` 各有 `shared/` 与
  `features/{theme,usage,expander}/`。功能之间**零 import**，只依赖共享内核。
- **显式功能契约**：客户端模块导出 `meta` / `dictionaries` / `apply(ctx, t)` /
  `HubView(props)`；Host 模块导出 `id` / `routePrefix` / `apply(ctx, cfg, shared)`。
  新增功能 = 加一个目录 + 两行登记，不碰装配层。
- **统一构建链**：Vite 8（`build.lib` / IIFE）。迁移前三个插件有三套构建方式
  （Vite / 字符串拼接 / 手写单文件），其中用量查询的 14 个客户端模块靠共享同一个
  factory 作用域互相引用标识符，与其它功能的 ESM 顶层名硬冲突 —— 已全部改写成
  真 ESM 模块（[ADR 0003](docs/adr/0003-unified-vite-client-build.md)）。
- **统一传输层**：三个功能原本各自重复的 HTTP 传输层收敛到 `src/host/shared/http.js`
  的 `buildRoutes`。守卫统一到更严的一侧（回环 + 同源 + POST 必须 `application/json`）。
- **设置面板一个入口**：原「用量查询」与「AxzoTheme」两个 `settings.section` 合并为
  一个 `usage-aggregator`，内部三页签（[ADR 0004](docs/adr/0004-single-settings-entry.md)）。

### 安全

- 插件路由默认只接受回环地址，且校验同源、要求 POST 带 `application/json`。
- 用量查询的凭证明文存本机（`store.json`，权限 0600），但**永不发往浏览器**：
  `maskProvider()` 是唯一允许外发的记录投影，送模型的请求摘要也会抹掉凭证取值。
- 插件更新新增自我保护：三个已退役的包名（`dsh-axzo-theme` / `dsh-usage-query` /
  `dsh-plugin-expander`）从清单里过滤掉，聚合包自己虽然可见但不会被「全部更新」
  选中 —— 避免旧插件复活与运行中自毁。

### 迁移注意

- **安装顺序不能反**：先从 profile 卸载三个旧包，再装本包。
- **数据路径不变**：主题偏好仍在 `localStorage` 的 `dsh-axzo-theme:*`；用量接口记录
  仍在 `$DSH_HOME/dsh-usage-query/store.json`。包名变了，数据目录没变。
- **路由前缀变了**：`/dsh-usage-query/*` → `/dsh-usage-aggregator/usage/*`，
  `/dsh-plugin-expander/*` → `/dsh-usage-aggregator/expander/*`（无兼容层）。
- **工具名不变**：`usage_query` / `plugin_update` —— 已有用法与文档不受影响。

### 顺带修掉的既有隐患

- **任务徽标恒为 warning**：主题的侧栏工作区徽标读的是会话摘要里的 `completed`
  字段 —— **那个字段在当前的 DSH `SessionSummary` 里根本不存在**。所以
  `isCompleted` 恒为 false：绿色「完成」徽标永远不会出现，而「停下来但没
  completed」每一拍都命中 → 凡是停下来的会话都挂上琥珀色叹号。现在改读官方
  `@deepseek-ai/dsh-client-ui-session` 的 **sessionStatus** 快照
  （`running` / `pendingInteraction` / `completionUnread`，宿主 UI 自己就是用它
  画侧栏状态点的）：正常完成 → 绿色对勾，在等你处理（审批 / 提问）→ 琥珀叹号。
  根 hook 没有非 React 的公开读法，新增 `task-status.js` 探针组件挂在
  `sidebar.footer.action` 上把快照喂给徽标。
- **子代理的状态混进统计**：一个会话的主代理（Lead）是这条会话本身，它的
  子代理是另开的会话（`parentId` 指向 Lead、`origin === 'subagent'`）。旧实现
  把子代理的完成也算进工作区行 —— 现在这两种标记任一命中就整个跳过。
  新增 `scripts/ui-check-tasks.mjs`：10 项断言覆盖「正常完成 / 当前会话完成 /
  在等你 / 子代理不计入 / 加载不刷屏 / 点掉不重现 / 再跑再完成能再报」。

- **页签标签兜底成 key**：页签标签原本放在各功能自己的 locale 命名空间下
  （`hubTab` 键）。同一个命名空间同时只能被一个包注册 —— 新旧插件并存时命名空间
  归旧包，功能就探不到自己的字典，翻译服务把 key 本身当答案返回，页签上出现
  字面量 `hubTab`。现在页签标签与设置入口名统一由聚合页自己的命名空间持有
  （`meta.hubTabKey` 指向它），与功能命名空间彻底解耦。

- 主题的 OS 偏好监听原本在模块顶层注册且**没有 disposer**（插件反复启停时监听会
  累积）→ 改为 effect 内注册并回收。
- 主题字典里 `heroHint` / `wmHint` / `washHint` 在中英文中**各被定义两次**，前一次
  是死代码、永远不显示 → 删除较早的那一份（保留实际生效的较完整文案），**行为零变化**。

### 文档

- [ARCHITECTURE.md](ARCHITECTURE.md) —— 模块划分、模块交互方式、monorepo 选型结论、
  不变量清单、扩展指南。
- [docs/adr/](docs/adr/) —— 四条架构决策记录。
