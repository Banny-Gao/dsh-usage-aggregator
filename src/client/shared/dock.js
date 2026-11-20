// src/client/shared/dock.js
//
// 悬浮栏（dock）：把「常驻在页面上的小入口」收进一条窄栏里。
//
// 为什么放在共享层：功能之间零 import（README 的硬规矩）—— 谁也不能 import 谁，
// 所以「谁来渲染这条栏」不能由某个功能包办（那等于功能之间互相依赖）。
// 做法是分工：
//   · 功能各自在 apply() 里登记一个条目（registerDockEntry）；
//   · 聚合层（hub）注册**唯一**一个 shell.overlay 槽来渲染这条栏。
// 栏负责：位置、拖拽（位置记住）、一次只展开一个、面板的定位。
// 条目负责：自己的图标、角标、闪烁、面板内容。
//
// 条目契约：
//   { id, order, t, Component }
//   Component 的 props：
//     · open      —— 这个条目的面板是不是展开着（栏来管，一次只开一个）
//     · onToggle  —— 点这个条目的入口按钮（栏来管）
//     · onClose   —— 面板里的关闭按钮（栏来管）
//     · t         —— 这个功能自己的 translator
//     · slotProps —— 宿主给浮层槽的标准属性（useSessions 等），条目自己取
//
// 拖拽的坑：面板是从条目里向左展开的，落在栏的框外。拖拽手柄只挂在「栏」上，
// 面板里的点击不能被当成拖栏 —— 所以按下的位置若落在面板里，就不开始拖。

import { h, useCallback, useEffect, useRef, useState } from '../runtime.js';
import { DockStyles } from './dock-style.js';

/** 栏的位置记在哪。 */
const POS_KEY = 'dsh-usage-aggregator:dock:pos';

/** 离屏幕边缘的距离。 */
const EDGE = 16;

/** 栏的尺寸估算（只用来夹位置，不参与布局）。 */
const DOCK_WIDTH = 46;
const DOCK_HEIGHT = 88;

/** 已登记的条目（按 order 排）。 */
const entries = [];

/** 条目变化时的通知者。 */
const listeners = new Set();

/**
 * 通知所有订阅者：条目表变了，得重渲染。
 */
function notify() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      /* 一个订阅者坏了不影响别人 */
    }
  }
}

/**
 * 登记一个条目。
 *
 * 同一个 id 重复登记（热重载）会替换掉旧的。
 *
 * @param {{id: string, order?: number, t?: Function, Component: Function}} entry 条目。
 * @returns {Function} 注销函数。
 */
export function registerDockEntry(entry) {
  if (entry === null || typeof entry !== 'object') return () => {};
  if (typeof entry.Component !== 'function') return () => {};
  const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : null;
  if (id === null) return () => {};

  const existing = entries.findIndex((row) => row.id === id);
  if (existing >= 0) entries.splice(existing, 1);
  entries.push({
    id: id,
    order: Number.isFinite(entry.order) ? entry.order : 0,
    t: typeof entry.t === 'function' ? entry.t : (key) => key,
    Component: entry.Component,
  });
  entries.sort((a, b) => a.order - b.order);
  notify();

  return function () {
    const index = entries.findIndex((row) => row.id === id);
    if (index < 0) return;
    entries.splice(index, 1);
    notify();
  };
}

/**
 * 订阅条目表的变化。
 *
 * @param {Function} listener 回调。
 * @returns {Function} 退订函数。
 */
export function subscribeDock(listener) {
  listeners.add(listener);
  return function () { listeners.delete(listener); };
}

/**
 * 取当前所有条目（按 order 排）。
 *
 * @returns {Array<object>} 条目表。
 */
export function getDockEntries() {
  return entries.slice();
}

/**
 * 读记住的位置。
 *
 * @returns {{x: number, y: number}|null} 位置；没有就是 null。
 */
function readPos() {
  try {
    const raw = window.localStorage.getItem(POS_KEY);
    if (raw === null || raw === '') return null;
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object') return null;
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
    return { x: value.x, y: value.y };
  } catch {
    return null;
  }
}

/**
 * 记住位置。
 *
 * @param {{x: number, y: number}} pos 位置。
 */
function writePos(pos) {
  try {
    window.localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* 存不了就算了，下次还在默认位置 */
  }
}

/**
 * 把位置夹回屏幕内。
 *
 * @param {{x: number, y: number}} pos 位置。
 * @returns {{x: number, y: number}} 夹好之后的位置。
 */
function clampPos(pos) {
  const maxX = Math.max(EDGE, window.innerWidth - DOCK_WIDTH - EDGE);
  const maxY = Math.max(EDGE, window.innerHeight - DOCK_HEIGHT - EDGE);
  return {
    x: Math.min(Math.max(EDGE, pos.x), maxX),
    y: Math.min(Math.max(EDGE, pos.y), maxY),
  };
}

/**
 * 悬浮栏容器。
 *
 * @param {{slotProps?: object}} props 属性。
 * @returns {object} React 元素。
 */
export function DockHost(props) {
  const slotProps = props.slotProps ?? null;

  // 条目表是模块级状态：登记发生在装配期，但要用订阅把它变成渲染期的状态。
  const [, setVersion] = useState(0);
  useEffect(function () {
    return subscribeDock(function () { setVersion(function (value) { return value + 1; }); });
  }, []);

  const list = getDockEntries();

  const [openId, setOpenId] = useState(null);
  const [pos, setPos] = useState(null);
  const [dragging, setDragging] = useState(false);

  const dockRef = useRef(null);
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);

  // 记住的位置：读一次，窗口尺寸变了再夹回去。
  useEffect(function () {
    const saved = readPos();
    if (saved !== null) setPos(clampPos(saved));
    const onResize = function () {
      setPos(function (current) { return current === null ? current : clampPos(current); });
    };
    window.addEventListener('resize', onResize);
    return function () { window.removeEventListener('resize', onResize); };
  }, []);

  const onPointerMove = useCallback(function (event) {
    const drag = dragRef.current;
    if (drag === null) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    drag.moved = true;
    setDragging(true);
    setPos(clampPos({ x: drag.baseX + dx, y: drag.baseY + dy }));
  }, []);

  const onPointerUp = useCallback(function (event) {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (drag !== null && drag.moved) {
      // 拖完紧接着的 click 不该再触发一次点击。
      suppressClickRef.current = true;
      setPos(function (current) {
        if (current !== null) writePos(current);
        return current;
      });
    }
  }, [onPointerMove]);

  const onPointerDown = useCallback(function (event) {
    if (event.button !== 0) return;
    // 面板里的点击不算拖栏：面板在栏的框外，落在它上面就别动栏。
    const target = event.target;
    if (target !== null && target !== undefined && typeof target.closest === 'function'
      && target.closest('[data-dock-panel]') !== null) {
      return;
    }
    const node = dockRef.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    // 新一轮按下先清掉上一次的「拖过之后别响应点击」。
    suppressClickRef.current = false;
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      baseX: rect.left,
      baseY: rect.top,
      moved: false,
    };
    // ⚠️ 这里**不能**用 setPointerCapture：捕获在容器上时，浏览器会把随后那记
    // click 也改派给容器（兼容鼠标事件跟着捕获目标走），按钮自己的 onClick 就
    // 永远收不到 —— 表现就是「点图标没反应」。
    // 改成在 window 上听 pointermove / pointerup：点击照常落在按钮上，拖拽也跟手。
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }, [onPointerMove, onPointerUp]);

  const onClickCapture = useCallback(function (event) {
    if (suppressClickRef.current !== true) return;
    suppressClickRef.current = false;
    event.stopPropagation();
    event.preventDefault();
  }, []);

  const toggle = useCallback(function (id) {
    setOpenId(function (current) { return current === id ? null : id; });
  }, []);

  const close = useCallback(function () {
    setOpenId(null);
  }, []);

  const style = pos === null
    ? undefined
    : { left: `${pos.x}px`, top: `${pos.y}px`, right: 'auto', bottom: 'auto' };

  const high = pos !== null && pos.y < 320;

  return h(
    'div',
    {
      ref: dockRef,
      className: 'dsh-dock' + (dragging ? ' is-dragging' : '') + (high ? ' is-high' : ''),
      style: style,
      onPointerDown: onPointerDown,
      onClickCapture: onClickCapture,
    },
    h(DockStyles, null),
    h(
      'div',
      { className: 'dsh-dock-rail' },
      list.map(function (entry) {
        return h(
          'div',
          { className: 'dsh-dock-item', key: entry.id },
          h(entry.Component, {
            open: openId === entry.id,
            onToggle: function () { toggle(entry.id); },
            onClose: close,
            t: entry.t,
            slotProps: slotProps,
          })
        );
      })
    )
  );
}

/**
 * 栏里的入口按钮。
 *
 * 外观由栏统一（这样几个入口看起来是一套的），条目只管图标与状态 class。
 *
 * @param {{className?: string, title?: string, onClick?: Function, children?: unknown}} props 属性。
 * @returns {object} React 元素。
 */
export function DockButton(props) {
  const className = 'dsh-dock-btn'
    + (typeof props.className === 'string' && props.className !== '' ? ' ' + props.className : '')
    + (props.open === true ? ' is-open' : '');
  return h(
    'button',
    {
      type: 'button',
      className: className,
      title: typeof props.title === 'string' ? props.title : undefined,
      'aria-label': typeof props.title === 'string' ? props.title : undefined,
      onClick: typeof props.onClick === 'function' ? props.onClick : undefined,
    },
    props.children
  );
}

/**
 * 栏里的面板外壳。
 *
 * 外壳统一（尺寸、边框、阴影、定位），内容由条目自己出。
 *
 * @param {{children?: unknown, label?: string}} props 属性。
 *   label 给了就把面板标成对话框（role + aria-label）—— 读屏的人才知道
 *   这块浮出来的东西叫什么。
 * @returns {object} React 元素。
 */
export function DockPanel(props) {
  const label = typeof props.label === 'string' && props.label !== '' ? props.label : null;
  return h(
    'div',
    {
      className: 'dsh-dock-panel',
      'data-dock-panel': '1',
      role: label === null ? undefined : 'dialog',
      'aria-label': label,
    },
    props.children
  );
}
