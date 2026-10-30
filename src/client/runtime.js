// src/client/runtime.js
//
// react 运行时：全插件唯一接触「注入进来的 require」的地方。
//
// DSH 的 __ModuleLoader__ 把 require 交给客户端插件的 factory（见 src/client/index.js）。
// 三个功能都从这里取 h / 钩子 / react-dom —— require 的生命周期只有一个入口，
// 整套代码里也没有第二处需要知道「react 是外部注入的」。
//
// 为什么用 export let 而不是包一层函数：
//   · 调用点保持 h(...) / useState(...) 原样不动；
//   · reactDom === null 这种判空（react-dom 不是每个宿主都保证有）也照旧成立。
// installRuntime 在 factory 里、任何组件渲染之前跑完，所以读到的一定是就绪值。
//
// ⚠️ 使用约定：模块顶层**不要**调用 h(...)。
// 本文件在模块求值时 h 还是 null，只有 installRuntime 之后才是真的。
// 顶层只允许声明函数与常量，渲染期再用 h。

/** react 命名空间本身（需要 React.Fragment 时用）。 */
export let React = null;

/** react.createElement 的别名。installRuntime 之后才非 null。 */
export let h = null;

/** react.useState。 */
export let useState = null;

/** react.useEffect。 */
export let useEffect = null;

/** react.useRef。 */
export let useRef = null;

/** react.useCallback。 */
export let useCallback = null;

/** react.useMemo。 */
export let useMemo = null;

/**
 * react-dom。拿不到时为 null —— 会话主区的背景 portal 依赖它，
 * 缺失时那段视觉优雅降级，不能让整个 bundle 挂掉。
 */
export let reactDom = null;

/**
 * 注入运行时。由 src/client/index.js 的 factory 调用一次。
 *
 * @param {(name: string) => unknown} require DSH 注入的模块解析函数。
 */
export function installRuntime(require) {
  React = require('react');
  h = React.createElement;
  useState = React.useState;
  useEffect = React.useEffect;
  useRef = React.useRef;
  useCallback = React.useCallback;
  useMemo = React.useMemo;
  try {
    reactDom = require('react-dom');
  } catch (err) {
    reactDom = null;
  }
}
