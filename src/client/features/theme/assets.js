// src/client/features/theme/assets.js
// 品牌资源工具：本地文件 / 在线链接 → 可渲染的 data URL。
//
// 以及侧栏装饰位（SidebarDecorHost）。

import { hslToHex } from './color.js';
import { LOGO_MAX_CHARS } from './constants.js';
import { ICON_PATH, ICON_VIEWBOX } from './logo.js';
import { h, useEffect } from '../../runtime.js';


/* ─────────────── 品牌资源工具（本地文件 / 在线地址） ───────────── */
/**
 * 本地图片 → data URL。
 * 位图先缩到 256px 再转 PNG：用户随手选一张 2MB 的照片，原样塞进
 * localStorage 会超配额，而且是**静默失败**，事后极难排查。
 * SVG 是矢量、通常很小，原样保留。
 */
export function fileToLogo(file, done, fail) {
  if (!file || !/^image\//i.test(file.type || "")) { fail("badImage"); return; }
  var reader = new FileReader();
  reader.onerror = function () { fail("readFail"); };
  reader.onload = function () {
    var url = String(reader.result || "");
    if (/^data:image\/svg\+xml/i.test(url)) {
      if (url.length > LOGO_MAX_CHARS) fail("tooBig"); else done(url);
      return;
    }
    var img = new Image();
    img.onerror = function () { fail("readFail"); };
    img.onload = function () {
      try {
        var max = 256;
        var w0 = img.naturalWidth || max;
        var h0 = img.naturalHeight || max;
        var scale = Math.min(1, max / Math.max(w0, h0));
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w0 * scale));
        canvas.height = Math.max(1, Math.round(h0 * scale));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        var out = canvas.toDataURL("image/png");
        if (out.length > LOGO_MAX_CHARS) fail("tooBig"); else done(out);
      } catch (err) { fail("readFail"); }
    };
    img.src = url;
  };
  reader.readAsDataURL(file);
}


/**
 * 面板里的 logo 预览。没自定义时不能用 ./assets/... 引用内置图标 ——
 * DSH 的静态服务不路由插件的 assets 目录（会 404），所以用已切好的
 * path 现场拼一个 data URL。中文不走 btoa（非 Latin1 会抛），用 encodeURIComponent。
 */
export function brandPreviewSrc(brand, primary) {
  if (brand.logo !== "") return brand.logo;
  var svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='" + ICON_VIEWBOX + "'>" +
    "<path d='" + ICON_PATH + "' fill='" + hslToHex(primary.h, primary.s, primary.l) + "'/></svg>";
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}


/**
 * 侧栏装饰宿主。
 *
 * 侧栏根节点的类名形如 `<hash>_root`：哈希随构建变，而 `_root` 这个子串
 * **别的模块也在用**（会话区就是 wSkVaW_root），所以不能直接写选择器打样式。
 * 改成从我们自己挂在侧栏里的这个探针往上爬，第一个 `*_root` 祖先即侧栏根 ——
 * 哈希变了照样命中，也不会误伤别的 _root。
 */
export function SidebarDecorHost() {
  useEffect(function () {
    var node = document.querySelector(".dsh-axzo-sb-probe");
    if (node === null) return undefined;
    var marked = null;
    var sync = function () {
      // 策略一（首选）：往上走到「装着侧栏、但不装会话区」的最高一层 ——
      // 那正好是侧栏那一列。用会话区做判据而不是类名：类名带构建哈希，
      // 而且内层的 *_root 只是侧栏组件的根，真正铺底的是外面那一列
      // （实测是 .<hash>_sidebarCol）。
      var next = null;
      var conversation = null;
      try { conversation = document.querySelector("[class*='_root'][data-phase]"); }
      catch (err) { conversation = null; }
      if (conversation !== null) {
        var cur = node.parentElement;
        while (cur !== null && cur !== document.body && cur !== document.documentElement) {
          if (cur.contains(conversation)) break;
          next = cur;
          cur = cur.parentElement;
        }
      }
      // 策略二（兜底）：会话区还没挂上时，退回按 *_root 类名找最近的一层
      if (next === null) {
        var el2 = node.parentElement;
        while (el2 !== null && el2 !== document.body) {
          var cls = el2.getAttribute("class") || "";
          if (/(^|\s)[^\s]*_root(\s|$)/.test(cls)) break;
          el2 = el2.parentElement;
        }
        next = el2 !== null && el2 !== document.body ? el2 : null;
      }
      if (next === null && marked === null) {
        console.warn("[dsh-axzo-theme] 没找到侧栏容器，玻璃与纹理不会生效");
      }
      if (next === marked) return;
      if (marked !== null) marked.removeAttribute("data-axzo-sidebar");
      marked = next;
      if (marked !== null) marked.setAttribute("data-axzo-sidebar", "");
    };
    sync();
    var observer = null;
    try {
      observer = new MutationObserver(sync);
      observer.observe(document.body, { childList: true, subtree: true });
    } catch (err) { observer = null; }
    return function () {
      if (observer !== null) observer.disconnect();
      if (marked !== null) marked.removeAttribute("data-axzo-sidebar");
    };
  }, []);
  // 探针自身不可见，它只是「我在侧栏里」这个事实的锚点
  return h("span", { className: "dsh-axzo-sb-probe", "aria-hidden": "true" });
}
