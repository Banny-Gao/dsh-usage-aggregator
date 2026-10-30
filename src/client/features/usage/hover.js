// src/client/features/usage/hover.js
//
// 侧栏图标 / 会话头快捷入口 / 悬停几何判定（对应源插件的 10-hover.js）。
//
// 这里的判定逻辑（isInsideRect / isInsideUnion / createHoverLiveness）是**纯函数**，
// 刻意不碰 DOM：它可以用假时钟 + 假矩形把真实场景逐个跑一遍。
// ⚠️ 一个字都不要改 —— 关闭浮层的判定方式（纯几何，不碰 mouseenter/mouseleave/blur）
// 是踩过三个坑之后定下来的。

import { h } from '../../runtime.js';

/**
 * 面板图标：宿主按 `{ size, active }` 传参，颜色跟 currentColor 走（深浅色都协调）。
 *
 * @param {{size?: number, active?: boolean}} props 属性。
 * @returns {object} React 元素。
 */
export function UsageIcon(props) {
  var size = typeof props.size === 'number' && props.size > 0 ? props.size : 16;
  return h('svg', {
    viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
    style: { display: 'block', opacity: props.active === false ? 0.75 : 1 }
  },
  h('path', {
    d: 'M5 19v-5.5M12 19V5M19 19v-8.5',
    fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round'
  })
  );
}

/**
 * 一条记录的「一眼摘要」。
 *
 * 芯片上只放**一个短值**（49% / 需更新 / 未查询），长文案留给悬停浮层 ——
 * 会话头是给别人用的地方，不该被一个接口名 + 时间戳撑成一长条。
 */
/**
 * 会话头芯片显示哪个接口：用户在浮层里点过「顶部显示」就用它，没点过用第一个。
 * 单独做成纯函数，才能离线断言「选第二个时芯片不再是第一个」。
 *
 * @param {Array<object>} providers 全部接口。
 * @param {string|null} chipId 顶部显示的接口 id。
 * @returns {object|null} 被选中的接口。
 */
export function pickChipProvider(providers, chipId) {
  if (typeof chipId === 'string' && chipId !== '') {
    const picked = providers.filter(function (item) { return item.id === chipId; })[0];
    if (picked !== undefined) return picked;
  }
  return providers.length > 0 ? providers[0] : null;
}

/**
 * 一条记录的摘要（值 / 细节 / 色调）。
 *
 * @param {object} provider 接口记录。
 * @param {Function} t translator。
 * @returns {{value: string, detail: string, tone: string}} 摘要。
 */
export function providerSummary(provider, t) {
  if (provider.status === 'expired') {
    return { value: t('chipNeedUpdate'), detail: provider.last && provider.last.message ? provider.last.message : '', tone: 'error' };
  }
  if (provider.status === 'error') {
    return { value: t('chipFailed'), detail: provider.last && provider.last.message ? provider.last.message : '', tone: 'error' };
  }
  var view = provider.view;
  if (view === null || view === undefined) {
    return { value: provider.source === 'image' ? t('chipFromImage') : t('chipNotQueried'), detail: '', tone: 'idle' };
  }
  if (view.primary !== null && view.primary !== undefined) {
    return { value: view.primary.text, detail: view.primary.label + ' · ' + view.title, tone: 'ok' };
  }
  var card = Array.isArray(view.cards) && view.cards.length > 0 ? view.cards[0] : null;
  if (card !== null) {
    var hot = Array.isArray(card.metrics) && card.metrics.length > 0 ? card.metrics[0] : null;
    var value = card.percent !== null && card.percent !== undefined ? card.percent + '%' : (hot === null ? '' : hot.text);
    return { value: value, detail: card.label + ' ' + (hot === null ? '' : hot.label + ' ' + hot.text), tone: 'ok' };
  }
  var metric = Array.isArray(view.metrics) && view.metrics.length > 0 ? view.metrics[0] : null;
  if (metric !== null) return { value: metric.text, detail: metric.label + ' · ' + view.title, tone: 'ok' };
  return { value: view.title, detail: '', tone: 'info' };
}

/**
 * 一个点是否落在这个元素的矩形内（元素不存在或没有尺寸都算不在）。
 *
 * `slack` 是向外扩张的容差：判定「指针还在不在浮层上」时故意放宽几十像素 ——
 * 少关一次（用户自己移开就关）远比多关一次（正要点按钮浮层没了）便宜。
 *
 * @param {object|null} node DOM 节点。
 * @param {number} x 指针横坐标。
 * @param {number} y 指针纵坐标。
 * @param {number} slack 容差（像素）。
 * @returns {boolean} 是否在矩形内。
 */
export function isInsideRect(node, x, y, slack) {
  if (node === null || node === undefined) return false;
  var rect = node.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  var pad = typeof slack === 'number' && slack > 0 ? slack : 0;
  return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
}

/**
 * 指针是否还在「触发体 ∪ 浮层」这片区域里。
 *
 * @param {Array<object>} nodes 候选节点。
 * @param {number} x 指针横坐标。
 * @param {number} y 指针纵坐标。
 * @param {number} slack 容差（像素）。
 * @returns {boolean} 是否在并集内。
 */
export function isInsideUnion(nodes, x, y, slack) {
  for (var index = 0; index < nodes.length; index += 1) {
    if (isInsideRect(nodes[index], x, y, slack)) return true;
  }
  return false;
}

/**
 * 悬停存活判定：一个不碰 DOM 的小状态机（矩形与时钟都由调用方传入）。
 *
 * 之所以把这段逻辑从组件里拎出来单独成函数：它是「浮层会不会自己消失」的唯一决定者，
 * 而它又是最难在真机上观察的一段（指针轨迹、定时器、包含块都会影响）。分开之后可以
 * 用假时钟 + 假矩形把真实场景逐个跑一遍（见 scripts/ui-check.mjs）：
 *   · 从芯片穿过缝隙滑到卡片上 → 全程不应判定为离开；
 *   · 手速慢、在缝隙里停留 300ms → 不到宽限期，仍然不关；
 *   · 指针真的离开（甩出窗口，没有 pointermove） → 靠按拍检查兜住；
 *   · 点了浮层里的按钮（pinned） → 无论离开多久都不关，直到 Esc / 点外面。
 *
 * @param {{graceMs: number, now: () => number, onLeaveExpired: () => void}} options
 * @returns {object} 存活判定器。
 */
export function createHoverLiveness(options) {
  var leaveStartedAt = 0;
  var pinned = false;
  return {
    setPinned: function (value) {
      pinned = value === true;
      if (pinned) leaveStartedAt = 0;
    },
    isPinned: function () { return pinned; },
    /** 报告一次指针位置；落在「任一矩形（含容差）」里就认为还在范围内。 */
    pointerAt: function (x, y, nodes, slack) {
      if (isInsideUnion(nodes, x, y, slack)) {
        leaveStartedAt = 0;
        return;
      }
      if (leaveStartedAt === 0) leaveStartedAt = options.now();
    },
    /** 按拍检查：离开超过宽限期才真的收起（返回 true 表示这一拍关掉了）。 */
    tick: function () {
      if (pinned) {
        leaveStartedAt = 0;
        return false;
      }
      if (leaveStartedAt === 0) return false;
      if (options.now() - leaveStartedAt <= options.graceMs) return false;
      leaveStartedAt = 0;
      options.onLeaveExpired();
      return true;
    },
    /** 距离上一次「在范围内」过去了多久（毫秒，0 表示此刻仍在范围内）。 */
    leftFor: function () { return leaveStartedAt === 0 ? 0 : options.now() - leaveStartedAt; }
  };
}

/** 浮层里的单条记录：头部（名字 + 状态 + 刷新）+ 元信息 + **与设置页同款的用量卡片**。 */
