// src/client/features/theme/tasks.js
// 任务状态：会话 running / 完成 / 在等你 → 侧栏工作区行的视觉信号。
//
// 两种徽标语义刻意分开：
//   · 完成（done，绿色对勾）—— 事件：粘性，用户点掉才消
//   · 关注（attention，琥珀色叹号）—— 状态：会话在等你，条件消失即消
//
// ⚠️ 数据来源必须是**官方 sessionStatus**，不能自己从会话列表推。
//   旧实现读的是 `rec.completed` —— 那个字段在当前的 SessionSummary 里
//   **根本不存在**（现在的字段是 running / blank / origin / parentId /
//   cwd / updatedAt / title / projectionValues）。所以：
//     · isCompleted 恒为 false → 绿色「完成」徽标**永远不会出现**；
//     · 旧逻辑的「停下来了但没 completed」→ 每一拍都命中 → 凡是停下来
//       的会话都挂上琥珀色叹号。
//   这就是「任务完成了却一直显示 warning」的根因 —— 不是配色问题，是读了一个
//   不存在的字段。
//
// 现在读的是 `@deepseek-ai/dsh-client-ui-session` 的 UiSession 服务提供的
// sessionStatus 快照（根 hook，宿主 UI 自己就是用它画侧栏状态点的）：
//
//   SessionStatus = {
//     running: boolean | undefined,       // 这一轮还在跑吗
//     pendingInteraction: Pending | undefined,  // 在等你（审批 / 计划评审 / 提问）
//     completionUnread: boolean,          // 跑完了、而你还没去看
//   }
//
// 三个信号怎么用：
//   · running → 工作区行「呼吸」（不挂徽标）
//   · completionUnread / running→停止 的边沿 → **完成**（绿色对勾）
//   · pendingInteraction → **关注**（琥珀叹号）—— 真·需要你出手
//
// completionUnread 只对「你正看着的会话之外」的会话置位，所以**当前会话**要靠
// running→停止的边沿来判定完成（下面的 wasRunning 就是干这个的）。
//
// ⚠️ 子代理不参与统计：一个会话的主代理（Lead）是这条会话本身，它的子代理是
//   另开的会话（parentId 指向 Lead、origin === 'subagent'）。子代理跑完不应
//   惊动工作区行 —— 这里把带 parentId / origin==='subagent' 的会话整个跳过。
//
// 边沿的记法（两个触发都是真正的「边沿」，所以清掉徽标后不会立刻重现）：
//   · running 边沿：上一拍在跑、这一拍不跑了 → 完成
//   · completionUnread 边沿：上一拍 false、这一拍 true → 完成
//   两者都会在会话**重新开跑**时复位，所以「同一个会话再跑再完成」能再次触发。
//
// 关注徽标是**状态**，不是事件：条件还在就一直在。清掉它靠「记住这次交互的
// key」—— pendingInteraction.key 是每个请求唯一的（换请求换 key），所以点掉
// 之后同一个交互不会再冒出来，新的交互又会正常提示。

/* ─────────────────── 任务状态（会话 running / 完成 / 等你） ───────── */
export const TASK = {
  watching: false,
  busy: false,
  runKeys: [],
  markKeys: [],           // 完成（绿色对勾）
  attentionKeys: [],      // 需要关注（琥珀色叹号）
  runningIds: {},         // 上一拍每个会话的 running
  completionUnreadIds: {},// 上一拍每个会话的 completionUnread（判边沿）
  dismissedKeys: {},      // 被用户点掉的 pending 交互（sessionId → interaction key）
  statuses: null,         // 官方 sessionStatus 快照（Map<SessionId, SessionStatus>）
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


/**
 * 这条会话是不是子代理。
 *
 * 子代理是 Lead 另开的会话：parentId 指向 Lead、origin 为 'subagent'。
 * 两种标记任一命中就算 —— 读不到 origin 的旧版本里 parentId 也够用。
 *
 * @param {object} rec 会话摘要。
 * @returns {boolean} 是否子代理。
 */
function isSubagent(rec) {
  if (rec === undefined || rec === null) return false;
  if (rec.origin === "subagent") return true;
  return rec.parentId !== undefined && rec.parentId !== null && rec.parentId !== "";
}


/**
 * 官方 sessionStatus 里的一条状态。
 *
 * @param {object|undefined} st 状态。
 * @returns {{running: boolean, pending: boolean, pendingKey: string, completedUnread: boolean}} 归一后的状态。
 */
function readStatus(st) {
  if (st === undefined || st === null) {
    return { running: false, pending: false, pendingKey: "", completedUnread: false };
  }
  var interaction = st.pendingInteraction;
  var hasPending = interaction !== undefined && interaction !== null;
  var pendingKey = "";
  if (hasPending) {
    pendingKey = typeof interaction.key === "string" && interaction.key !== "" ? interaction.key : "pending";
  }
  return {
    running: st.running === true,
    pending: hasPending,
    pendingKey: pendingKey,
    completedUnread: st.completionUnread === true
  };
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
 * 「需要关注」徽标：会话在等你（审批 / 计划评审 / 提问）。
 * 形状用叹号（比完成的对勾更警觉），颜色走琥珀，让用户一眼分清
 * 「这事办完了」vs「这事卡在你这儿了」。
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


/** 从数组里去掉一个 key，返回新数组（不原地改）。 */
function removeKey(arr, key) {
  var next = [];
  for (var i = 0; i < arr.length; i += 1) {
    if (arr[i] !== key) next.push(arr[i]);
  }
  return next;
}


/**
 * 清掉「完成」徽标。
 *
 * 只摘徽标，**不动边沿状态** —— 两个触发（running→停止、completionUnread
 * false→true）都是真边沿：
 *   · 摘掉之后，下一拍 wasRunning / wasCompletedUnread 仍是「边沿已经发生过」
 *     的值 → 不会立刻重现；
 *   · 会话**重新开跑**时，DSH 会清掉 completionUnread、runningIds 也回到 true，
 *     下一轮跑完照样再报一次完成。
 * 旧实现把「边沿」和「去重」混在同一份状态里，清徽标时必须连带作废，才不会
 * 「我看过」和「我处理完了」被混作一件事；现在两者分开，就不用那种补偿了。
 *
 * @param {string} key 工作区标识。
 * @returns {void}
 */
function clearMarks(key) {
  TASK.markKeys = removeKey(TASK.markKeys, key);
  paintTaskState();
}


/**
 * 清除「需要关注」徽标。
 *
 * 关注是**状态**：会话还在等你，条件没消失。点掉只是「这次先不提醒我」——
 * 记住这次 pending 交互的 key，同一个交互不再冒出来；换了新交互（新 key）
 * 照常提示。
 *
 * @param {string} key 工作区标识。
 * @returns {void}
 */
function clearAttention(key) {
  TASK.attentionKeys = removeKey(TASK.attentionKeys, key);
  var items = TASK.attentionItems === undefined ? {} : TASK.attentionItems;
  var list = items[key];
  if (list !== undefined) {
    for (var i = 0; i < list.length; i += 1) {
      TASK.dismissedKeys[list[i].sessionId] = list[i].interactionKey;
    }
  }
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
 * 重算全部工作区状态。
 *
 * 数据有两个来源：会话列表（拿 cwd → 工作区、以及会话集合）和官方
 * sessionStatus 快照（拿 running / 在等你 / 完成了没看）。两者各自会变，
 * 所以都汇到这一个函数里重算。
 *
 * @returns {void}
 */
export function recomputeTaskState() {
  var byId = TASK._lastById || {};
  var statuses = TASK.statuses;
  var running = {};
  var runKeys = [];
  var fresh = [];
  var nextRunningIds = {};
  var nextCompletionUnreadIds = {};
  var attentionItems = {};
  var liveAttention = [];
  var id, rec, key, status, wasRunning, wasCompletedUnread, isRunning, isPending, isCompletedUnread, pendingKey;

  for (id in byId) {
    rec = byId[id];
    if (rec === undefined || rec === null || rec.blank) continue;
    // 子代理不参与统计：只算主代理（Lead）自己的状态。
    if (isSubagent(rec)) continue;

    key = workspaceKeyOf(rec.cwd);
    status = readStatus(statuses === null || statuses === undefined ? undefined : statuses.get(id));
    // 官方状态没有这个会话的记录时，回落到会话列表里的 running。
    if (statuses === null || statuses === undefined || statuses.get(id) === undefined) {
      status.running = rec.running === true;
    }

    wasRunning = TASK.runningIds[id] === true;
    wasCompletedUnread = TASK.completionUnreadIds[id] === true;
    isRunning = status.running;
    isPending = status.pending;
    isCompletedUnread = status.completedUnread;
    pendingKey = status.pendingKey;

    nextRunningIds[id] = isRunning;
    nextCompletionUnreadIds[id] = isCompletedUnread;

    if (isRunning) {
      running[id] = true;
      if (key !== "" && runKeys.indexOf(key) < 0) runKeys.push(key);
    }

    // 完成（事件）：会话从「在跑」变成「停了」，而且不是在等你 ——
    //   · running 边沿：上一拍在跑、这一拍不跑了（**当前会话**只能靠它 ——
    //     DSH 的 completionUnread 对你正看着的会话不置位）；
    //   · completionUnread 边沿：DSH 官方的「跑完了、你还没看」。
    // 两个都是真边沿，所以清掉徽标后不会立刻重现，会话重新开跑后还能再报。
    var runEdge = wasRunning && !isRunning;
    var unreadEdge = isCompletedUnread && !wasCompletedUnread;
    if (!isRunning && !isPending && key !== "" && (runEdge || unreadEdge)) {
      fresh.push(key);
    }

    // 关注（状态）：会话在等你（审批 / 计划评审 / 提问）。
    if (!isRunning && isPending) {
      var dismissed = TASK.dismissedKeys[id];
      if (dismissed === undefined || dismissed !== pendingKey) {
        if (attentionItems[key] === undefined) attentionItems[key] = [];
        attentionItems[key].push({ sessionId: id, interactionKey: pendingKey });
      }
    }
  }

  // 「关注」按工作区去重后展示。
  var seenAttentionKey = Object.create(null);
  for (var akey in attentionItems) {
    if (akey === "" || seenAttentionKey[akey]) continue;
    seenAttentionKey[akey] = true;
    liveAttention.push(akey);
  }

  TASK.runningIds = nextRunningIds;
  TASK.completionUnreadIds = nextCompletionUnreadIds;
  TASK.attentionItems = attentionItems;
  TASK.runKeys = runKeys;
  TASK.attentionKeys = liveAttention;
  TASK.busy = runKeys.length > 0 || Object.keys(running).length > 0;
  TASK.watching = true;
  for (var i = 0; i < fresh.length; i += 1) {
    if (TASK.markKeys.indexOf(fresh[i]) < 0) TASK.markKeys.push(fresh[i]);
  }
  scheduleTaskPaint();
}


/**
 * 喂进官方 sessionStatus 快照（由 task-status.js 的探针组件调用）。
 *
 * @param {Map<string, object>|null} statuses 状态快照。
 * @returns {void}
 */
export function setTaskStatuses(statuses) {
  TASK.statuses = statuses === undefined ? null : statuses;
  recomputeTaskState();
}


/**
 * 订阅会话列表。返回 disposer。
 * 侧栏行是 React 动态渲染的，列表变化本身不保证行已经挂上，
 * 所以额外用一个 rAF 节流的 MutationObserver 兜底重绘。
 *
 * @param {object} sessions sessions 服务。
 * @returns {Function} disposer。
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
    // DSH 每次 snapshot 给的都是新对象、不会再被原处改，留着给
    // clearDoneEdgesFor 按工作区反查会话。
    TASK._lastById = (snap === null || snap === undefined ? {} : snap.byId) || {};
    recomputeTaskState();
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
    TASK.completionUnreadIds = {};
    TASK.dismissedKeys = {};
    TASK.attentionItems = {};
    TASK.statuses = null;
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
