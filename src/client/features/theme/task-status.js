// src/client/features/theme/task-status.js
//
// 官方 sessionStatus 快照的探针。
//
// 为什么需要它：任务徽标要判「完成 / 在等你」，得知道每个会话的
// running / pendingInteraction / completionUnread。这三个事实由
// `@deepseek-ai/dsh-client-ui-session` 的 UiSession 服务维护，并以**根 hook**
// `sessionStatus` 的形式提供（宿主 UI 自己就是用它画侧栏状态点的）。
//
// 根 hook 没有非 React 的公开读法 —— 它只以「标准 props」的形式发给槽位组件
// （hook 名 sessionStatus → 标准 prop 名 useSessionStatus）。所以这里挂一个
// 什么都不渲染的小组件，把快照喂给任务徽标。
//
// 槽位选 `sidebar.footer.action`：侧栏底部一直挂着，主题的侧栏质感/背景宿主
// 也挂在这里，它要是没挂，主题本来就不完整。

import { h, useEffect } from '../../runtime.js';
import { setTaskStatuses } from './tasks.js';

/**
 * 探针组件：读官方 sessionStatus 快照，喂给任务徽标。
 *
 * @param {{useSessionStatus: Function}} props 槽位标准 props。
 * @returns {null} 不渲染任何东西。
 */
export function TaskStatusProbe(props) {
  // 官方 UI 自己也是这么取整张表的（useSessionStatus((s) => s)）。
  const statuses = props.useSessionStatus(function (all) { return all; });
  useEffect(function () {
    setTaskStatuses(statuses);
  }, [statuses]);
  return null;
}

/**
 * 槽位渲染入口。
 *
 * 只有宿主真的提供了 useSessionStatus（老版本 DSH 可能没有）才挂探针 ——
 * 挂上去却拿不到函数会在渲染时炸。
 *
 * @param {object} props 槽位 props。
 * @returns {object|null} React 元素。
 */
export function renderTaskStatusProbe(props) {
  if (props === undefined || props === null) return null;
  if (typeof props.useSessionStatus !== 'function') return null;
  return h(TaskStatusProbe, props);
}
