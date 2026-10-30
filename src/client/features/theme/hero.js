// src/client/features/theme/hero.js
// 首屏玻璃品牌舞台，以及会话主区的品牌背景。
//
// BackdropHost 复用同一个 HeroBrandMark，经 createPortal 挂进会话主区并居中，
// 不随内容滚动。

import { iconSvg, textSvg } from './brand-mark.js';
import { OFFICIAL_NAME } from './brand.js';
import { prefs, usePrefs } from './prefs.js';
import { h, reactDom, useEffect, useState } from '../../runtime.js';


const HERO = {
  stage: 176,
  blobA: 112,
  blobB: 92,
  glow: 186,
  arc: 146,
  disc: 112,
  core: 66,
  word: 30
};


/**
 * 首屏玻璃舞台（也是会话区背景用的那一个 —— 两处必须是同一组件）。
 *
 * 槽位（.pXSMma_fishHitbox）是 inline-flex 小图标位，所以这里自绘一个完整
 * 竖向舞台；配合 CSS 隐藏 DSH 的 _titleGroup，它就成了首屏的视觉中心。
 *
 * 所有尺寸都写成**内联像素**：百分比落在 grid 区域里会与容器尺寸互相依赖，
 * 实测正圆会渲染成椭圆。
 */
export function HeroBrandMark() {
  var prefs = usePrefs();
  var brand = prefs.brand;
  var sq = function (n, extra) {
    var style = { width: n + "px", height: n + "px" };
    if (extra) for (var k in extra) style[k] = extra[k];
    return style;
  };

  var core = brand.logo !== ""
    ? h("img", {
      className: "dsh-axzo-mark-core dsh-axzo-mark-img",
      src: brand.logo,
      width: HERO.core,
      height: HERO.core,
      alt: brand.name,
      draggable: "false"
    })
    : iconSvg("dsh-axzo-mark-core", HERO.core);

  var word = null;
  if (brand.name !== "") {
    word = brand.name === OFFICIAL_NAME
      ? textSvg("dsh-axzo-hero-word", HERO.word, "currentColor")
      : h("span", { className: "dsh-axzo-hero-word dsh-axzo-hero-word-text" }, brand.name);
  }

  return h("div", { className: "dsh-axzo-hero" },
    h("div", { className: "dsh-axzo-stage", style: sq(HERO.stage) },
      h("span", { className: "dsh-axzo-blob dsh-axzo-blob-a", "aria-hidden": "true", style: sq(HERO.blobA) }),
      h("span", { className: "dsh-axzo-blob dsh-axzo-blob-b", "aria-hidden": "true", style: sq(HERO.blobB) }),
      h("span", { className: "dsh-axzo-glow", "aria-hidden": "true", style: sq(HERO.glow) }),
      h("span", { className: "dsh-axzo-arc", "aria-hidden": "true", style: sq(HERO.arc) }),
      h("span", { className: "dsh-axzo-disc", "aria-hidden": "true", style: sq(HERO.disc) }),
      core
    ),
    word,
    brand.tagline === "" ? null : h("span", { className: "dsh-axzo-hero-tag" }, brand.tagline),
    brand.subtag === "" ? null : h("span", { className: "dsh-axzo-hero-sub" }, brand.subtag)
  );
}


/**
 * 会话主区的品牌背景宿主。
 *
 * 它自身不渲染可见内容，只把一个 **React portal** 送进会话主区
 * （DSH 的 .wSkVaW_body），里面挂的是 **与首屏完全同一个 HeroBrandMark** ——
 * 所以两处的造型、比例、配色、动效必然一致，不存在「两套实现长得不一样」。
 *
 * 为什么需要「常驻宿主」：背景在任何阶段都要在，而首屏 slot 只在空会话时
 * 挂载。所以挂在始终存在的 sidebar.footer.action 上，自身渲染 null。
 *
 * 为什么用 createPortal 而不是再开一个 React root：portal 的内容仍在当前
 * React 树里，随插件卸载一起回收，不必自己管第二个 root 的生命周期。
 */
export function BackdropHost() {
  var state = useState(null);
  var target = state[0];
  var setTarget = state[1];

  useEffect(function () {
    if (typeof document === "undefined" || reactDom === null) return undefined;

    // 子选择器定位：_body 这个类名在十几个插件里都有，只有会话根的
    // 直接子元素才是会话主区。
    var BODY_SELECTOR = "[class*='_root'][data-phase] > [class*='_body']";

    function attach() {
      var host = document.querySelector(BODY_SELECTOR);
      if (host === null) return;
      if (host.querySelector(":scope > .dsh-axzo-backdrop") !== null) return;
      var mount = document.createElement("div");
      mount.className = "dsh-axzo-backdrop";
      mount.setAttribute("aria-hidden", "true");
      host.insertBefore(mount, host.firstChild);
      setTarget(mount);
    }

    attach();

    // 切会话 / 新建会话会让 React 重建会话根，背景容器会跟着被丢掉，
    // 所以要盯着重建。用 rAF 合并同一帧内的多次变更，避免每条 DOM 变更
    // 都跑一次 querySelector。
    var queued = false;
    var observer = new MutationObserver(function () {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(function () {
        queued = false;
        attach();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return function () {
      observer.disconnect();
      var mount = document.querySelector(".dsh-axzo-backdrop");
      if (mount !== null && mount.parentNode !== null) mount.parentNode.removeChild(mount);
    };
  }, []);

  if (target === null || reactDom === null) return null;
  return reactDom.createPortal(h(HeroBrandMark, { size: HERO.core * 2 }), target);
}
