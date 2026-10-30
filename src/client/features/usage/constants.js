// src/client/features/usage/constants.js
//
// 用量查询功能的常量。
//
// 迁移说明：这些常量原来住在 01-runtime.js（与 React 句柄混在一起）。迁移时拆成两处：
//   · React 句柄（h / useState / useEffect / useRef）→ ../../runtime.js
//     （整个插件唯一接触「注入进来的 require」的地方）
//   · 常量 → 本文件
//
// 路由前缀（ENDPOINT）**不在这里**：它是客户端与 Host 之间的路径契约，统一住在
// ../../shared/constants.js，本功能用那里的 USAGE_ENDPOINT 拼 URL。

/**
 * locale 命名空间。
 *
 * ⚠️ 保持 'usage-query' 不变 —— 改名会让「已注册的旧命名空间」与「新命名空间」并存，
 * 字典被注册两次，切换语言时会出现两套文案。
 */
export const NS = 'usage-query';

/**
 * 样式元素的 data 属性值。
 *
 * 用 data 属性而不是 id：同一份 CSS 可能被多个挂载点各渲染一次（设置页 + 会话头芯片），
 * 重复的 id 是非法的。
 */
export const STYLE_ID = 'dsh-usage-query-style';

/**
 * 槽位注册用的 id：会话头入口用它。
 *
 * 保持 'usage-query' —— 它是槽位 id 的一部分，改了宿主侧就找不到这个入口了。
 */
export const PANEL_ID = 'usage-query';

/** 默认展示几条指标：其余折叠。字段依旧全部解析，只是想看细项时点一下。 */
export const DEFAULT_VISIBLE = 5;

/** 指针离开「芯片 ∪ 浮层」后多久才真的收起浮层（宽容一点，别让手滑变成误关）。 */
export const POP_GRACE_MS = 520;

/** 判定矩形外扩多少像素。宁可多留一会儿，也不要「正要点按钮浮层没了」。 */
export const POP_SLACK_PX = 20;
