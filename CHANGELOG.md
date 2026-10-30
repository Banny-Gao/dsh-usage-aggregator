# CHANGELOG

本文件记录 **dsh-usage-aggregator** 的版本变化。

格式：`## <版本> · <日期> · <标题>`；发布前先写 `## Unreleased` 节，
`pnpm release` 会把它改写成正式版本节。

---

## Unreleased · 2026-10-30 · 聚合三个插件：用量查询 / 安心筑主题 / 插件更新

首个版本。三件能力合并成一个 DSH 插件 —— 插件管理器里只占一行，设置面板里只占
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

- 主题的 OS 偏好监听原本在模块顶层注册且**没有 disposer**（插件反复启停时监听会
  累积）→ 改为 effect 内注册并回收。
- 主题字典里 `heroHint` / `wmHint` / `washHint` 在中英文中**各被定义两次**，前一次
  是死代码、永远不显示 → 删除较早的那一份（保留实际生效的较完整文案），**行为零变化**。

### 文档

- [ARCHITECTURE.md](ARCHITECTURE.md) —— 模块划分、模块交互方式、monorepo 选型结论、
  不变量清单、扩展指南。
- [docs/migration-checklist.md](docs/migration-checklist.md) —— 逐项能力对照与审计。
- [docs/adr/](docs/adr/) —— 四条架构决策记录。
