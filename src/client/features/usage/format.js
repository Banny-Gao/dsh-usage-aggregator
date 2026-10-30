// src/client/features/usage/format.js
//
// 时间 / 数值 / 状态的小工具（对应源插件的 04-format.js）。
//
// 纯函数，不依赖任何其它模块 —— 迁移后这里是叶子节点，import 图的底端。

/**
 * 相对时间（「3 分钟前」）。
 *
 * @param {number} ms 时间戳（毫秒）。
 * @param {Function} t translator。
 * @returns {string} 文案。
 */
export function relativeTime(ms, t) {
  if (typeof ms !== 'number') return t('neverQueried');
  var delta = Date.now() - ms;
  if (delta < 45000) return '刚刚';
  if (delta < 3600000) return Math.round(delta / 60000) + ' 分钟前';
  if (delta < 86400000) return Math.round(delta / 3600000) + ' 小时前';
  return Math.round(delta / 86400000) + ' 天前';
}

/**
 * 时刻（「10-16 15:27」）。
 *
 * @param {number} ms 时间戳（毫秒）。
 * @returns {string} 文案。
 */
export function clockTime(ms) {
  try {
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  } catch (err) {
    return new Date(ms).toISOString();
  }
}

/**
 * 时长（「2 小时 5 分」）。
 *
 * @param {number} ms 时长（毫秒）。
 * @returns {string} 文案。
 */
export function durationText(ms) {
  if (typeof ms !== 'number' || ms <= 0) return '不到 1 秒';
  var seconds = Math.floor(ms / 1000);
  var days = Math.floor(seconds / 86400);
  var hours = Math.floor((seconds % 86400) / 3600);
  var minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return days + ' 天' + (hours > 0 ? ' ' + hours + ' 小时' : '');
  if (hours > 0) return hours + ' 小时' + (minutes > 0 ? ' ' + minutes + ' 分' : '');
  if (minutes > 0) return minutes + ' 分钟';
  return seconds + ' 秒';
}

/**
 * 间隔秒数 → 「每 5 分钟 / 每 2 小时」这种短文案。
 *
 * @param {number} seconds 间隔（秒）。
 * @param {Function} t translator。
 * @returns {string} 文案。
 */
export function intervalText(seconds, t) {
  if (typeof seconds !== 'number' || seconds <= 0) return t('autoOff');
  if (seconds < 3600) return seconds % 60 === 0 ? t('autoEveryMinutes', { n: seconds / 60 }) : t('autoEverySeconds', { n: seconds });
  return t('autoEveryHours', { n: Math.round((seconds / 3600) * 10) / 10 });
}

/**
 * 距离下次自动查询的剩余毫秒 → 「14:35 / 即将」。
 *
 * @param {number} ms 剩余毫秒。
 * @returns {string|null} 文案；不需要显示时返回 null。
 */
export function dueText(ms) {
  if (typeof ms !== 'number') return null;
  if (ms <= 5000) return null;
  return clockTime(Date.now() + ms);
}

/**
 * 超长文本截断并加省略号（顶部芯片这类窄地方用；宽的地方不要用，见 resolve.js）。
 *
 * @param {unknown} text 原文。
 * @param {number} max 最大长度。
 * @returns {string} 截断后的文本。
 */
export function clipText(text, max) {
  var value = String(text == null ? '' : text).trim();
  if (value.length <= max) return value;
  return value.slice(0, max) + '…';
}

/**
 * 状态 → 色调（ok / error / info / idle）。
 *
 * @param {string} status 状态。
 * @returns {string} 色调。
 */
export function statusTone(status) {
  if (status === 'ok') return 'ok';
  if (status === 'expired') return 'error';
  if (status === 'error') return 'error';
  if (status === 'snapshot') return 'info';
  return 'idle';
}
