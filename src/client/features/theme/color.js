// src/client/features/theme/color.js
// 主色 → 一组派生色的纯函数工具。


/* ─────────────────────────── 颜色工具 ──────────────────────────── */
export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }


export function hslToHex(hue, sat, lig) {
  var hh = ((hue % 360) + 360) % 360;
  var s = clamp(sat, 0, 100) / 100;
  var l = clamp(lig, 0, 100) / 100;
  var c = (1 - Math.abs(2 * l - 1)) * s;
  var x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  var m = l - c / 2;
  var r = 0, g = 0, b = 0;
  if (hh < 60) { r = c; g = x; }
  else if (hh < 120) { r = x; g = c; }
  else if (hh < 180) { g = c; b = x; }
  else if (hh < 240) { g = x; b = c; }
  else if (hh < 300) { r = x; b = c; }
  else { r = c; b = x; }
  var to = function (n) {
    var t = clamp(Math.round((n + m) * 255), 0, 255).toString(16);
    return t.length === 1 ? "0" + t : t;
  };
  return "#" + to(r) + to(g) + to(b);
}


/** 8 位十六进制 #RRGGBBAA（alpha 在末尾，符合 CSS Color 4）。 */
export function withAlpha(hex, alpha) {
  var a = clamp(Math.round(alpha * 255), 0, 255).toString(16);
  return hex + (a.length === 1 ? "0" + a : a);
}


/** RGBA 字符串，给需要半透明的表面用。 */
export function rgba(hue, sat, lig, alpha) {
  var hex = hslToHex(hue, sat, lig);
  var r = parseInt(hex.slice(1, 3), 16);
  var g = parseInt(hex.slice(3, 5), 16);
  var b = parseInt(hex.slice(5, 7), 16);
  return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
}
