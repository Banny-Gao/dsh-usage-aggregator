// src/client/features/boost/rocket.js
//
// 小火箭的图形。
//
// 自绘 SVG 而不是用 emoji：emoji 在不同系统上是不同的画风，而且没法做发射动画。
// 火焰单独一个 class（.dsh-boost-flame），发射时由 CSS 抖。

import { h } from '../../runtime.js';

/**
 * 火箭图标。
 *
 * @param {{size?: number}} props 属性。
 * @returns {object} React 元素。
 */
export function RocketIcon(props) {
  const size = typeof props.size === 'number' ? props.size : 26;
  return h(
    'svg',
    { viewBox: '0 0 32 32', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
    // 尾焰
    h('g', { className: 'dsh-boost-flame' },
      h('path', {
        d: 'M13.6 21.5h4.8l-2.4 7.2z',
        fill: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
        opacity: '0.9',
      })
    ),
    // 左鳍
    h('path', {
      d: 'M9.6 19.4 5.4 25.8l4.6-1.1z',
      fill: 'var(--dsw-alias-bg-layer-2)',
      stroke: 'currentColor',
      strokeWidth: '1.2',
      strokeLinejoin: 'round',
    }),
    // 右鳍
    h('path', {
      d: 'M22.4 19.4l4.2 6.4-4.6-1.1z',
      fill: 'var(--dsw-alias-bg-layer-2)',
      stroke: 'currentColor',
      strokeWidth: '1.2',
      strokeLinejoin: 'round',
    }),
    // 箭身
    h('path', {
      d: 'M16 2.4c-4.4 4.6-6 10.6-6 16.2v2.6h12v-2.6c0-5.6-1.6-11.6-6-16.2z',
      fill: 'var(--dsw-alias-bg-layer-2)',
      stroke: 'currentColor',
      strokeWidth: '1.4',
      strokeLinejoin: 'round',
    }),
    // 舷窗
    h('circle', {
      cx: '16',
      cy: '12.4',
      r: '3.1',
      fill: 'var(--dsw-alias-brand-primary)',
      stroke: 'currentColor',
      strokeWidth: '1.2',
    }),
    // 尾翼分界线
    h('path', {
      d: 'M10 18.4h12',
      stroke: 'currentColor',
      strokeWidth: '1.1',
      strokeLinecap: 'round',
      opacity: '0.55',
    }),
  );
}
