// src/client/features/theme/tasks.js
// 任务状态：会话 running / completed → 侧栏工作区行的视觉信号。
//
// 两种徽标语义刻意分开：
//   · 完成（done）—— 事件：粘性，用户点掉才消
//   · 关注（attention）—— 状态：状态收敛即消
//
// 注意 DSH 的语义陷阱（见 session.d.ts 注释）：completed: true 只在「session
// 完成且当时没被用户打开」时打点。用户打开过的 session 永远 completed=false，
// 所以不能只看 !running && !completed。


/* ─────────────────── 任务状态（会话 running / completed） ───────── */
/**
 * DSH 的 sessions 服务给每条会话记录带了两个状态字段（cwd 不算状态）：
 *   running    —— 这一轮任务还在跑；错误 / 暂停时也会翻 false
 *   completed  —— 这一轮「真完成」才置 true（DSH 注释：「Finished while
 *                 not selected and not yet opened — the sidebar's green
 *                 "done" reminder」）；错误 / 暂停下 DSH 不动这字段
 *   cwd        —— 它属于哪个工作区（用来对应到侧栏那一行）
 *
 * 触发条件必须用 `completed` 而不是 `running→!running`：
 *   - 错误 / 暂停：DSH 把 running 翻 false 但 completed 不动，旧逻辑会被
 *     误判成「完成」、侧栏行冒出完成徽标 —— 是这个 bug 的根因。
 *   - 真完成：DSH 把 completed 翻 true → 记边沿。
 *
 * 边沿的两道守门（防页面刷新时把历史已完成的会话全刷成标记）：
 *   1. `TASK.runningIds[id] === true` —— 必须亲眼见过这 id 在跑，
 *      否则加载时已 completed 的会话会被全刷。
 *   2. `TASK.completedIds[id] !== true` —— 必须是「刚翻 true」，
 *      同一会话再跑再完成也能再次触发（running false→true 时把上次记的
 *      completed 状态清掉，让下一次完成能再算边沿）。
 *
 * 顶部流光与侧栏行的「呼吸」用 running；完成徽标用 completed。两者分别听。
 *
 * 还需要一条「需要关注」徽标（暂停 / 错误）：DSH 把 running 翻 false 但
 * completed 不动 —— 这两态没法直接区分（sessions.list 只给 running /
 * completed 两字段），用「曾经 running、现在不是、还没 completed」的统一
 * 信号标一个琥珀色徽标，先解决「错误悄无声息」的问题。等 DSH 把 phase
 * 暴露给 SessionSummary 时再拆成两个独立的徽标。
 *
 * 与完成徽标刻意区分：完成是「事件」（这一轮 turn 真结束 → 记边沿 → 粘性 →
 * 用户点掉才消），关注是「状态」。
 *
 * 实现：attentionKeys 不再做边沿累积，而是每拍从 nextAttentionIds 按
 * workspace 派生；nextAttentionIds 的填充条件是
 *   !running && !completed && (wasAttention || wasRunning)
 * —— 边沿（wasRunning）+ 持久化（wasAttention）两者居一即可。这样：
 *   - session 从 running 转入停 → wasRunning 边沿打上 → 徽标挂
 *   - 之后多拍保持 !running → wasAttention 持久化 → 徽标继续挂
 *   - session 恢复 running 或真完成 → 下一拍不进 nextAttentionIds → 徽标
 *     自动摘掉
 *   - 用户点徽标 / 点会话行 → clearEdgeStateFor 抹掉 wasAttention → 下
 *     一拍除非又有新边沿，否则不重现
 *
 * 单看 !running && !completed 不够 —— DSH 的 completed=true 只对「用户没
 * 打开过的 session 完成」打点（见 session.d.ts 注释），用户打开过的 session
 * 正常结束也是 completed=false，会被错认为「需要关注」。这条守门
 * (wasAttention || wasRunning) 就是把这种「长期 idle 不算关注」滤掉。
 */
export const TASK = {
  watching: false,
  busy: false,
  runKeys: [],
  markKeys: [],         // 完成（绿色对勾）
  attentionKeys: [],    // 需要关注（琥珀色叹号）
  runningIds: {},
  completedIds: {},
  attentionIds: {},
  t: null,
  observer: null,
  queued: false
};


function normalizeKey(text) {
  return String(text === undefined || text === null ? "" : text).trim().toLowerCase();
}


/** 会话 cwd → 工作区标识（取路径末段，与侧栏行的名字对齐）。 */
function workspaceKeyOf(cwd) {
  if (typeof cwd !== "string" || cwd === "") return "";
  var parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return normalizeKey(parts[parts.length - 1]);
}


/** 侧栏行 → 工作区标识（行上没有路径，只有标题文本）。 */
function rowKeyOf(row) {
  var el = row.querySelector("[class*='_title']");
  return el === null ? "" : normalizeKey(el.textContent);
}


function makeDoneBadge(key) {
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dsh-axzo-done";
  btn.setAttribute("aria-label", TASK.t === null ? "clear" : TASK.t("doneBadge"));
  btn.setAttribute("title", TASK.t === null ? "" : TASK.t("doneBadge"));
  btn.innerHTML = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">' +
    '<path d="M3.2 8.4l3 3 6.8-7.2" fill="none" stroke="currentColor" ' +
    'stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  btn.addEventListener("click", function (event) {
    // 行本身是「展开/折叠」的点击目标，必须拦住，否则点标记会顺带切换分组
    event.preventDefault();
    event.stopPropagation();
    clearMarks(key);
  });
  return btn;
}


/**
 * 「需要关注」徽标：DSH 把 running 翻 false 但 completed 没动时的边沿产物。
 * 形状用叹号（比完成的对勾更警觉），颜色走琥珀，让用户一眼分清
 * 「这事办完了」vs「这事没办完、我去看一眼」。
 */
function makeAttentionBadge(key) {
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dsh-axzo-attention";
  var label = TASK.t === null ? "需要关注" : TASK.t("attentionBadge");
  btn.setAttribute("aria-label", label);
  btn.setAttribute("title", label);
  btn.innerHTML = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">' +
    '<path d="M8 2 L8 10" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>' +
    '<circle cx="8" cy="13" r="1.1" fill="currentColor"/></svg>';
  btn.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    clearAttention(key);
  });
  return btn;
}


/**
 * 从会话行往上找它所属分组的工作区行。
 * 分组容器（*_groupSection）同时装着项目行与会话行，所以这是一次可靠的结构查询，
 * 不依赖「第几个」这类易碎假设。
 */
function workspaceRowOf(node) {
  if (node === null || typeof node.closest !== "function") return null;
  var section = node.closest("[class*='_groupSection']");
  if (section === null) return null;
  return section.querySelector("[class*='_projectRow']");
}


/**
 * 点会话行也算「我来看过这个工作区了」，把标记一并清掉。
 * 用捕获阶段监听 document：React 的事件委托挂在根容器上，行自己的 onClick
 * 有可能提前 stopPropagation，捕获阶段最稳。
 */
/** 从数组里去掉一个 key，返回新数组（不原地改）。 */
function removeKey(arr, key) {
  var next = [];
  for (var i = 0; i < arr.length; i += 1) {
    if (arr[i] !== key) next.push(arr[i]);
  }
  return next;
}


/**
 * 清掉该 workspace 下所有 session id 的边沿状态（completedIds / attentionIds）。
 * 不能直接 workspace → ids 反查，用 `TASK._lastById` 快照做反查。
 * 两类徽标共用：用户主动清除某类徽标时，把对应边沿状态也作废 ——
 * 否则同一会话再次「完成 / 出错」时 wasCompleted / wasAttention 还是 true、
 * 边沿不会再次触发，「我看过」和「我处理完了」会被混作一件事。
 */
function clearEdgeStateFor(track, key) {
  var trackState = track === "completed" ? TASK.completedIds : TASK.attentionIds;
  for (var id in trackState) {
    var rec = TASK._lastById === undefined ? null : TASK._lastById[id];
    if (rec === null) continue;
    if (workspaceKeyOf(rec.cwd) === key) delete trackState[id];
  }
}


function clearMarks(key) {
  TASK.markKeys = removeKey(TASK.markKeys, key);
  clearEdgeStateFor("completed", key);
  paintTaskState();
}


/**
 * 清除「需要关注」徽标。逻辑跟 `clearMarks` 对称 —— 边沿状态作废，
 * 下一轮同会话出错能再次触发徽标。
 */
function clearAttention(key) {
  TASK.attentionKeys = removeKey(TASK.attentionKeys, key);
  clearEdgeStateFor("attention", key);
  paintTaskState();
}


/**
 * 点会话行也算「我来看过这个工作区了」—— 同时清掉完成 / 关注两类徽标。
 * 用捕获阶段监听 document：React 的事件委托挂在根容器上，行自己的 onClick
 * 有可能提前 stopPropagation，捕获阶段最稳。
 * 完成优先于关注：同一 workspace 同时有两条徽标只清绿色（更明确的状态）。
 */
function onTaskDocumentClick(event) {
  if (TASK.markKeys.length === 0 && TASK.attentionKeys.length === 0) return;
  var target = event.target;
  if (target === null || target === undefined || typeof target.closest !== "function") return;
  if (target.closest("[class*='_sessionRow']") === null) return;
  var row = workspaceRowOf(target);
  if (row === null) return;
  var key = rowKeyOf(row);
  if (key === "") return;
  if (TASK.markKeys.indexOf(key) >= 0) clearMarks(key);
  else if (TASK.attentionKeys.indexOf(key) >= 0) clearAttention(key);
}


/** 把任务状态画到 DOM 上。只增删我们自己的属性和徽标，不碰 React 的节点结构。 */
function paintTaskState() {
  // document.body 在极早期或测试环境里可能是 undefined，两个都要挡
  if (typeof document === "undefined" || !document.body) return;
  var body = document.body;
  if (TASK.watching) body.setAttribute("data-axzo-taskwatch", "");
  else body.removeAttribute("data-axzo-taskwatch");
  if (TASK.busy) body.setAttribute("data-axzo-busy", "");
  else body.removeAttribute("data-axzo-busy");

  var rows = document.querySelectorAll("[class*='_projectRow']");
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    var key = rowKeyOf(row);
    var isRun = key !== "" && TASK.runKeys.indexOf(key) >= 0;
    var isDone = key !== "" && TASK.markKeys.indexOf(key) >= 0;
    // 完成徽标优先于关注徽标（同时存在说明状态在迁移中，绿色更明确）
    var isAttention = !isDone && key !== "" && TASK.attentionKeys.indexOf(key) >= 0;

    if (isRun) row.setAttribute("data-axzo-run", "");
    else row.removeAttribute("data-axzo-run");

    var doneBadge = row.querySelector(":scope > .dsh-axzo-done");
    var attentionBadge = row.querySelector(":scope > .dsh-axzo-attention");
    if (isDone && doneBadge === null) row.appendChild(makeDoneBadge(key));
    else if (!isDone && doneBadge !== null) doneBadge.remove();
    if (isAttention && attentionBadge === null) row.appendChild(makeAttentionBadge(key));
    else if (!isAttention && attentionBadge !== null) attentionBadge.remove();
  }
}


function scheduleTaskPaint() {
  if (TASK.queued) return;
  TASK.queued = true;
  var run = function () { TASK.queued = false; paintTaskState(); };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 60);
}


/**
 * 订阅会话列表。返回 disposer。
 * 侧栏行是 React 动态渲染的，列表变化本身不保证行已经挂上，
 * 所以额外用一个 rAF 节流的 MutationObserver 兜底重绘。
 */
export function startTaskWatch(sessions) {
  var list = sessions === undefined || sessions === null ? null : sessions.list;
  if (list === null || typeof list.getSnapshot !== "function" ||
      typeof list.subscribe !== "function") {
    return function () {};
  }

  var sync = function () {
    var snap;
    try { snap = list.getSnapshot(); } catch (err) { return; }
    var byId = (snap === null || snap === undefined ? {} : snap.byId) || {};
    var running = {};
    var runKeys = [];
    var fresh = [];
    var nextCompletedIds = {};
    var nextAttentionIds = {};
    var id, rec, key, isRunning, isCompleted, wasRunning, wasCompleted, wasAttention;

    for (id in byId) {
      rec = byId[id];
      if (rec === undefined || rec === null || rec.blank) continue;
      key = workspaceKeyOf(rec.cwd);
      isRunning = rec.running === true;
      isCompleted = rec.completed === true;
      wasRunning = TASK.runningIds[id] === true;
      wasCompleted = TASK.completedIds[id] === true;
      wasAttention = TASK.attentionIds[id] === true;

      if (isRunning) {
        running[id] = true;
        if (key !== "" && runKeys.indexOf(key) < 0) runKeys.push(key);
      }

      // 给下一拍的边沿用：跟随 DSH 的 completed 状态，**但新一轮任务刚开始时
      // 不把刚要作废的 completed 写进去**。否则同一会话再跑再完成时，
      // 下一次 completed 翻 true 会被这条残留的「上一拍已完成」盖掉、变成
      // 「completed 未变」、边沿不触发、徽标不出现。
      if (isCompleted && !(isRunning && !wasRunning)) {
        nextCompletedIds[id] = true;
      }

      // 「需要关注」的下一拍状态：会话不在跑、也没真完成。但 DSH 把
      // completed 置 true 只会发生在「用户没打开过的 session 完成」时
      // （见 session.d.ts 注释），用户打开过的 session 即使正常结束也保持
      // completed=false。所以单看 !running && !completed 太宽 —— 几乎所有
      // 「用户看过一眼」的 session 都满足。要再扣一道：要么上一拍刚停下
      // （wasRunning 边沿），要么已经在 attention 集里（持久化）。
      // 在跑 / 真完成 → 自然不进；状态收敛后下一拍徽标自动消（由后面派生块
      // 接管 attentionKeys 计算）。
      if (!isRunning && !isCompleted && (wasAttention || wasRunning)) {
        nextAttentionIds[id] = true;
      }

      // 完成标记：DSH 把 completed 翻 true 的边沿。错误 / 暂停下 completed
      // 仍是 false，不会被误判；只在「刚翻 true」上记一次。
      //   守门 1：必须亲眼见过这 id 在跑（wasRunning），防页面加载时历史
      //           已完成的会话被全刷成标记。
      //   守门 2：上一拍 completed 不是 true（!wasCompleted），防重复触发。
      if (isCompleted && wasRunning && !wasCompleted && key !== "") {
        fresh.push(key);
      }
    }

    TASK.runningIds = running;
    TASK.runKeys = runKeys;
    TASK.completedIds = nextCompletedIds;
    TASK.attentionIds = nextAttentionIds;
    // 给 clearAttention / clearMarks 提供反查快照 —— 它需要按 workspace 清掉
    // id 状态。引用 byId 没问题：DSH 每次 snapshot 给的都是新对象、不会再被
    // 原处改。
    TASK._lastById = byId;
    TASK.busy = runKeys.length > 0 || Object.keys(running).length > 0;
    TASK.watching = true;
    for (var i = 0; i < fresh.length; i += 1) {
      if (TASK.markKeys.indexOf(fresh[i]) < 0) TASK.markKeys.push(fresh[i]);
    }
    // 关注徽标从当前快照派生（不累积）。nextAttentionIds 的填充条件已经
    // 卡死：!running && !completed && (wasAttention || wasRunning)，所以
    // session 恢复 running 或真完成 → 下一拍自动摘掉；用户点徽标 / 点会话
    // 行 → clearEdgeStateFor 把 wasAttention 抹掉，下一拍派生为空。完成徽标
    // （边沿事件、粘性、用户点掉才消）的语义刻意保留 —— 它是「事件」、这
    // 条是「状态」。
    var liveAttention = [];
    var seenAttentionKey = Object.create(null);
    for (var aid in nextAttentionIds) {
      var arec = TASK._lastById === undefined ? null : TASK._lastById[aid];
      if (arec === null || arec === undefined) continue;
      var ak = workspaceKeyOf(arec.cwd);
      if (ak === "" || seenAttentionKey[ak]) continue;
      seenAttentionKey[ak] = true;
      liveAttention.push(ak);
    }
    TASK.attentionKeys = liveAttention;
    scheduleTaskPaint();
  };

  var unsubscribe;
  try { unsubscribe = list.subscribe(sync); }
  catch (err) { return function () {}; }

  try {
    TASK.observer = new MutationObserver(scheduleTaskPaint);
    TASK.observer.observe(document.body, { childList: true, subtree: true });
  } catch (err) { TASK.observer = null; }

  try { document.addEventListener("click", onTaskDocumentClick, true); }
  catch (err) { /* 无 document，忽略 */ }

  sync();

  return function () {
    try { unsubscribe(); } catch (err) { /* 已失效 */ }
    if (TASK.observer !== null) {
      try { TASK.observer.disconnect(); } catch (err) { /* 已断开 */ }
      TASK.observer = null;
    }
    try { document.removeEventListener("click", onTaskDocumentClick, true); }
    catch (err) { /* 无 document，忽略 */ }
    TASK.watching = false;
    TASK.busy = false;
    TASK.runKeys = [];
    TASK.markKeys = [];
    TASK.attentionKeys = [];
    TASK.runningIds = {};
    TASK.completedIds = {};
    TASK.attentionIds = {};
    TASK._lastById = null;
    if (typeof document !== "undefined" && document.body !== null) {
      document.body.removeAttribute("data-axzo-busy");
      document.body.removeAttribute("data-axzo-taskwatch");
    }
    var doneBadges = document.querySelectorAll(".dsh-axzo-done");
    for (var i = 0; i < doneBadges.length; i += 1) doneBadges[i].remove();
    var attnBadges = document.querySelectorAll(".dsh-axzo-attention");
    for (var j = 0; j < attnBadges.length; j += 1) attnBadges[j].remove();
  };
}
