// src/client/features/boost/ref.js
//
// 跨组件的一小块共享状态。
//
// 为什么需要它：小火箭浮层挂在 shell.overlay（root scope），拿得到
// useSessions，能算出「用户正在看的那个会话」；聚合设置页里的视图挂在
// settings.section，**拿不到标准属性**，算不出当前会话。
//
// 所以由浮层把当前会话 id 记在这里，设置页来读 —— 一份数据，两个入口看到的是
// 同一个会话，交给 Agent 的消息才会落到用户眼前这个对话里。

/**
 * 运行时共享状态。
 *
 * sessions —— 客户端的 sessions 服务（可选注入拿到的）。
 * sessionId —— 用户当前正在看的会话 id（由浮层写，设置页读）。
 */
export const BOOST_RUNTIME = {
  sessions: null,
  sessionId: null,
};
