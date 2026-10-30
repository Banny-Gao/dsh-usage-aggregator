// src/client/features/theme/os-prefs.js
// OS 级可访问性偏好：prefers-reduced-motion / prefers-contrast。
//
// DSH 不监听这两条媒体查询，本功能代为检测，把结果折成「默认 flag 的修正量」。
// 用户在面板里手动改过的优先 —— 应用顺序见 prefs.js 的 normalizeFlags：
// 显式 stored > OS 偏好 > 默认值。
//
// 检测一次就够（插件生命周期内不会变），但保留 change 订阅，hot-reload / dev 下能跟着更新。
//
// ⚠️ 迁移时补的一件事：原来的 3 条 matchMedia 监听在模块顶层注册、**没有 disposer**
//   （既有隐患：插件被反复 apply 时监听会越积越多）。现在监听有明确的生命周期：
//   startOsPrefs() 注册、stopOsPrefs() 摘掉，由 index.js 的 apply 在 effect
//   cleanup 里调用。osFlagOverrides() / osTintMax() 的 API 与行为**完全不变**。


/* ── OS 偏好（prefers-reduced-motion / prefers-contrast） ──────────
 * DSH 不监听这些；本功能代为检测，把结果折成「默认 flag」的修正量。
 * 用户在面板里手动改过的优先：见 normalizeFlags 里的 osOverrides 应用
 * 顺序 —— 显式 stored > OS 偏好 > DEFAULT_FLAGS。
 *
 * 检测一次就够（matchMedia 在插件生命周期内不会变化，OS 切换不算），
 * 但保留订阅以便 hot-reload / dev 模式下能跟着更新。
 */
const OS_PREFS = { reducedMotion: false, contrastMore: false, contrastLess: false };

/** 三条媒体查询。少一条少一条监听，顺序无关。 */
const OS_QUERIES = [
  "(prefers-reduced-motion: reduce)",
  "(prefers-contrast: more)",
  "(prefers-contrast: less)"
];

/** 已注册的监听器（MediaQueryList + 回调），供 stopOsPrefs 摘除。 */
const osCleanups = [];

/** 是否正在监听。保证 start/stop 幂等。 */
let osStarted = false;

function detectOsPrefs() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  OS_PREFS.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // prefers-contrast: more / less 都是有效值，但 less 较罕见，先简单支持 more
  OS_PREFS.contrastMore = window.matchMedia("(prefers-contrast: more)").matches;
  OS_PREFS.contrastLess = window.matchMedia("(prefers-contrast: less)").matches;
}
detectOsPrefs();


/**
 * 注册 3 条 matchMedia 监听（幂等：已注册时直接返回）。
 *
 * 模块加载时调用一次（保持「加载即开始监听」的旧行为），
 * apply 里也调用一次 —— 插件被 dispose 再 apply 时监听能自动补回来。
 */
export function startOsPrefs() {
  if (osStarted) return;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  osStarted = true;
  var onMq = function () { detectOsPrefs(); };
  try {
    for (let i = 0; i < OS_QUERIES.length; i += 1) {
      const mq = window.matchMedia(OS_QUERIES[i]);
      mq.addEventListener("change", onMq);
      osCleanups.push(function () {
        try { mq.removeEventListener("change", onMq); } catch (err) { /* 老 Safari */ }
      });
    }
  } catch (err) { /* 老 Safari 不支持 addEventListener，忽略 */ }
}
startOsPrefs();


/**
 * 摘掉 3 条 matchMedia 监听（幂等：没注册时直接返回）。
 *
 * 由 index.js 的 apply 在 effect cleanup 里调用 —— 插件卸载时把监听还回去，
 * 免得插件反复 apply 时监听越积越多。
 */
export function stopOsPrefs() {
  if (!osStarted) return;
  osStarted = false;
  while (osCleanups.length > 0) {
    const fn = osCleanups.pop();
    try { fn(); } catch (err) { /* 已失效 */ }
  }
}


/**
 * 把 OS 偏好折成 DEFAULT_FLAGS 的覆盖项。会在 normalizeFlags 里跟用户
 * 显式设置合并：用户改过的优先，OS 偏好只在「恢复默认」路径里生效。
 */
export function osFlagOverrides() {
  var p = {};
  if (OS_PREFS.reducedMotion) {
    // 减弱动效 → 关掉所有会动的东西：动画、舞台旋转弧、环境光叠加
    p.motion = false;
    p.hero = false;
    p.wash = false;
  }
  return p;
}


/**
 * OS 偏好带来的 tint 上限。prefers-contrast: more → 不让薄荷染色盖掉内容
 * 对比度，把染色浓度压到 40 以下（视觉上接近 DSH 默认底色，但主色和按钮
 * 等还是品牌色，所以「看着像默认」不等于「关掉主题」）。
 */
export function osTintMax() {
  if (OS_PREFS.contrastMore) return 40;
  return 100;
}
