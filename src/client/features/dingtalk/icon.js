// src/client/features/dingtalk/icon.js
//
// 钉钉消息的图标：一只消息气泡。
//
// 自绘 SVG 而不是用 emoji 或文字：emoji 在不同系统上是不同的画风，文字「钉」
// 在小图标里也认不出是什么。画法跟小火箭同一套（细描边 + 主题填充）。
//
// 三个点是「有消息」的通感符号；气泡本体用 currentColor 描边，跟宿主主题一起变。

import { h } from '../../runtime.js';

/**
 * 消息气泡图标。
 *
 * @param {{size?: number}} props 属性。
 * @returns {object} React 元素。
 */
export function BubbleIcon(props) {
  const size = typeof props.size === 'number' ? props.size : 19;
  return h(
    'svg',
    { viewBox: '0 0 32 32', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
    // 气泡本体（含小尾巴）
    h('path', {
      d: 'M16 3.8c-6.6 0-12 4.5-12 10.1 0 3 1.5 5.7 3.9 7.5l-1.4 5.4 5.9-3.1c1.1.2 2.3.3 3.6.3 6.6 0 12-4.5 12-10.1S22.6 3.8 16 3.8z',
      fill: 'var(--dsw-alias-bg-layer-2)',
      stroke: 'currentColor',
      strokeWidth: '1.4',
      strokeLinejoin: 'round',
    }),
    // 三个点
    h('circle', { cx: '10.6', cy: '13.9', r: '1.35', fill: 'currentColor', opacity: '0.85' }),
    h('circle', { cx: '16', cy: '13.9', r: '1.35', fill: 'currentColor', opacity: '0.85' }),
    h('circle', { cx: '21.4', cy: '13.9', r: '1.35', fill: 'currentColor', opacity: '0.85' })
  );
}
