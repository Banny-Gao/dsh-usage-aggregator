# dsh-usage-aggregator

> 一个 DSH 插件装下三件能力：**用量查询**、**安心筑品牌主题**、**插件更新**。
> 插件管理器里只占一行，设置面板里只占一个入口。

```yaml
# profile 的 cordis.patch.yml
- insert:
    - id: dsh-usage-aggregator
      name: 'dsh-usage-aggregator'
```

安装后打开 **设置 → 用量聚合**，三个功能在页签里切换。

---

## 三件能力

### 1. 用量查询

粘贴一次接口请求（浏览器 DevTools → Network → 右键 → Copy as cURL）或一张用量截图，就能把第三方的额度 / 余量 / 次数 / 账单变成一眼看得懂的卡片。

- Host 端**真实重放**你的请求（绕开 CORS，Cookie 不进前端）
- 本地已配置的模型分析「请求 + 响应」生成**展示模板**并缓存 —— 模型只产出数据（路径表），取数与格式化由代码负责，所以**接新接口时客户端一行都不用改**
- 凭证过期时**直接引导重贴**：接口地址与展示模板都保留，不用重新分析
- 支持**自动续期**（钉钉 OAuth，零依赖 CDP 驱动）：只换 `authorization` 里的 token，其余请求头一个字节不动 → 不花模型调用
- 面板侧不主动打上游：只在「你点刷新 / 接入即首查 / 响应结构变了」时重放请求；**自动查询**默认每 5 分钟一轮，按每个接口自己的上次查询时间判定
- 凭证**永不出 Host**：只有脱敏后的投影会发给浏览器

Agent 工具：`usage_query`（`list` / `refresh` / `renew` / `import` / `remove`）。

### 2. 安心筑品牌主题

把侧栏品牌换成安心筑官方 logo，覆盖 **43 个真实的 DSH 主题 token**（26 个 `--dsw-*` + 17 个 `--dsh-axzo-*`），并加上一层玻璃质感。

- **品牌替换**：侧栏 logo + 字标（内联 SVG path，浅深两套）
- **主题 token**：主色 HSL → 43 个 token，浅深各自计算；表面染色、强调色、状态色
- **玻璃首屏**：空会话时用玻璃圆盘 + 旋转光弧 + 品牌标语替换默认首屏（可开关，关掉时**真的让出槽位**）
- **会话区品牌背景**：有会话时把整套品牌铺成主区背景，不随内容滚动
- **侧栏质感**：半透明底 + 顶部受光边 + 柔光 + 内联磨砂纹理，三档可调
- **任务状态徽标**：完成=事件（边沿、粘性、点掉才消），关注=状态（每拍派生、收敛自动消）
- **跟随系统偏好**：`prefers-reduced-motion` → 默认关动效；`prefers-contrast: more` → 染色浓度上限压到 40%

可调项：6 套预设色板、HSL 三滑杆、5 个视觉开关、侧栏质感三项、品牌自定义（logo / 名字 / 主标语 / 副标语 / 11 套字体）、一键「低刺激」护眼预设。

### 3. 插件更新

补上 DSH 官方没有的那一段：官方「插件」页的 Update 只对官方 bundle 生效，比对的是随发行版走的那份安装目标；profile 自己装的 npm / git / 本地插件**没有任何升级入口**。

- 已装清单走**官方** `pluginManager.listBundles()`（唯一事实来源）
- 远端最新版本：npm 走 `pnpm view`，git 走 `git ls-remote` + 锁文件提交号比对
- 版本比较是自实现的 semver 子集（不降级、本地更新不算可更新）
- 安装动作**不自己碰 pnpm**：一律走官方 `removeBundle` + `installBundle`，继承 profile 写锁、失败回滚、HMR 重载与构建脚本审批
- 只管 `availability === 'profile'` 的插件；local / alias / 钉死提交 / 本地更新的一律不可更新
- Agent 工具：`plugin_update`（`check` / `update`），更新走 **danger-full-access** 闸门

---

## 安装

```bash
# 1. 先卸载三个旧插件（顺序很重要，见下）
dsh plugin --profile web remove dsh-axzo-theme
dsh plugin --profile web remove dsh-usage-query
dsh plugin --profile web remove dsh-plugin-expander

# 2. 装聚合包
dsh plugin --profile web add https://axzsource.com/gaozhipeng/dsh-usage-aggregator.git
```

> **顺序不能反**：只要旧包还留在 profile 的依赖清单里，「全部更新」会用 `name@latest`（npm）或原始 source（git）把它们**装回来**。
> 聚合包内置了自我保护：三个旧包名从清单里过滤掉，聚合包自己虽然可见但不会被「全部更新」选中。

本地开发：

```bash
pnpm install
pnpm run build          # 产物 → client/client.js
pnpm run check          # 一把跑全部验证
```

---

## 目录结构

```
src/client/     客户端半边（浏览器）：runtime · shared · hub · features/{theme,usage,expander}
src/host/       Host 半边（Node）：shared · features/{theme,usage,expander}
client/client.js  构建产物（DSH 加载它）
vite.config.mjs  构建链配置（必须在仓库根）
vite/           构建链插件（logo 的构建期注入）
scripts/        验证套件
docs/adr/       架构决策记录
```

**架构说明见 [ARCHITECTURE.md](ARCHITECTURE.md)** —— 模块划分、模块之间的交互方式、monorepo 选型的结论与理由、不变量清单、扩展指南。

---

## 配置

配置在 profile 的 `cordis.patch.yml` 里，只对 **Host 半边**生效（客户端读不到 config）：

```yaml
- insert:
    - id: dsh-usage-aggregator
      name: 'dsh-usage-aggregator'
      config:
        endpoint: /dsh-usage-aggregator
        allowRemote: false
        usage:
          analysis:
            provider: axzo-one            # 分析「请求 + 响应」用的本地模型
            model: auto/deepseek-flash
            maxOutputTokens: 8000
            allowImage: true
          autoRefresh:
            enabled: true
            intervalSeconds: 300
          renewal:
            enabled: true
            leadSeconds: 1800
            cooldownSeconds: 1800
          request:
            timeoutMs: 30000
        expander:
          checkTimeoutMs: 20000
          gitTimeoutMs: 15000
```

> ⚠️ `endpoint` 必须与客户端源码里的 `ENDPOINT_BASE` 一致 —— 客户端读不到 config，两边各写一份，`scripts/verify.sh` 会断言它们同值。

---

## 数据落在哪

| 数据 | 位置 |
|---|---|
| 主题偏好 | `localStorage` 的 `dsh-axzo-theme:primary` / `:fx` / `:brand` |
| 已接入的用量接口 / 模板 / 字段顺序 | `$DSH_HOME/dsh-usage-query/store.json`（0600） |
| 续期用的 Chrome 会话 | `$DSH_HOME/dsh-usage-query/profiles/<id>/` |

> 包名变了，**数据目录没变** —— 用户已配置的接口与主题设置原样接着用。

---

## 安全

- 插件路由**默认只接受回环地址**（本机浏览器），并且校验同源、要求 POST 带 `application/json`。这些接口能读到你的登录态并替它发请求，暴露到网络上等于把账号借出去。
- 用量查询的凭证**明文存在本机**（`store.json`，权限 0600，目录 0700）—— 但**永远不会发给浏览器**：`maskProvider()` 是唯一允许外发的记录投影（URL 查询串打码、只给请求头名字、body 与原始粘贴文本完全不出现）；送模型的请求摘要也会抹掉凭证取值。
- 插件更新会改动整个 profile 的已装插件，因此 Agent 工具侧要求 **danger-full-access**。
- 自动续期会拉起本机 Chrome 打开授权页 —— 钉钉这类站点**必须人工点一次「同意」**，静默续期对它不可能成功。

---

## 许可

MIT
