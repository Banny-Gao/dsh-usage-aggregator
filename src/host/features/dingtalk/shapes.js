// src/host/features/dingtalk/shapes.js
//
// 把 dws 的 JSON 变成插件自己要的那几个字段。
//
// 为什么写得这么"厚"：dws 的消息结果有**成文的契约**（im.message-list.v1），
// 消息字段与信封字段的名字是定死的；但「按姓名搜人」的结果形状没有成文契约，
// 不同版本的 dws 把它放在 results / persons / items / data 里都可能。
//
// 这里的取舍：**契约内的字段按契约读，契约外的字段容错地找**。
// 找不到就返回空数组（上层按「没查到」处理），绝不猜。

/** 消息结果信封里的字段名（im.message-list.v1）。 */
const MESSAGE_ENVELOPE = 'messages';

/**
 * 依次尝试的字段名。
 *
 * @param {object} item 一个对象。
 * @param {string[]} names 候选字段名。
 * @returns {string} 第一个非空字符串值。
 */
function pickString(item, names) {
  for (const name of names) {
    const value = item[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/**
 * 深度遍历，找出所有「像人员候选」的数组。
 *
 * @param {unknown} node 当前节点。
 * @param {Array<Array<object>>} found 收集到的候选数组。
 * @param {number} depth 当前深度。
 */
function walkPeople(node, found, depth) {
  if (depth > 6 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    const people = node.filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item) && looksLikePerson(item));
    if (people.length > 0) found.push(people);
    for (const item of node) walkPeople(item, found, depth + 1);
    return;
  }
  for (const key of Object.keys(node)) walkPeople(node[key], found, depth + 1);
}

/**
 * 一个对象像不像一个人（有人名或有人 id）。
 *
 * @param {object} item 候选对象。
 * @returns {boolean} 是否像人。
 */
function looksLikePerson(item) {
  const name = pickString(item, ['name', 'displayName', 'userName', 'realName', 'nickname']);
  const id = pickString(item, ['userId', 'staffId', 'openDingTalkId', 'openDingtalkId', 'id']);
  return name !== '' || id !== '';
}

/**
 * 把 dws 的人员搜索结果整理成候选列表。
 *
 * @param {unknown} json dws 返回的 JSON。
 * @returns {Array<{name: string, userId: string, openDingTalkId: string, department: string}>} 候选列表。
 */
export function collectPeople(json) {
  const found = [];
  walkPeople(json, found, 0);
  const out = [];
  const seen = new Set();
  for (const group of found) {
    for (const item of group) {
      const person = {
        name: pickString(item, ['name', 'displayName', 'userName', 'realName', 'nickname']),
        userId: pickString(item, ['userId', 'staffId', 'userid']),
        openDingTalkId: pickString(item, ['openDingTalkId', 'openDingtalkId', 'open_ding_talk_id']),
        department: pickString(item, ['deptName', 'departmentName', 'department', 'deptNames']),
      };
      const key = person.userId + '|' + person.openDingTalkId + '|' + person.name;
      if (key === '||') continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(person);
    }
  }
  return out;
}

/**
 * 唯一标识片段：给人看的「别发错人」用的短串。
 *
 * @param {{userId: string, openDingTalkId: string}} person 候选。
 * @returns {string} 片段（取不到就是空串）。
 */
export function idHint(person) {
  const source = person?.openDingTalkId || person?.userId || '';
  if (source === '') return '';
  return source.length <= 6 ? source : '…' + source.slice(-4);
}

/**
 * 把 dws 给的时间变成毫秒时间戳。
 *
 * dws 的时间有两种形态：`+at-me` 给的是 `time` 字段，`+chat-messages` 给的是
 * `createTime` 字段 —— **两者都是「2026-11-18 17:32:07」这样的本地钟面字符串**，
 * 不是毫秒数字。另有版本给的是数字。
 *
 * 字符串按**本地时区**解析：CLI 自己就是按本地时区算的时间窗（`--days` 那些），
 * 拿 UTC 去解会差一个时区。这里显式构造本地时刻，不依赖 `Date.parse` 对非 ISO
 * 串的猜测（它在不同引擎上行为不一致）。
 *
 * @param {unknown} value 时间字段的值。
 * @returns {number} 毫秒时间戳；认不出就是 0。
 */
export function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 1e11 是个分界：现在的秒级时间戳约 1.7e9，毫秒级约 1.7e12。
    return value >= 1e11 ? value : value * 1000;
  }
  if (typeof value !== 'string') return 0;
  const text = value.trim();
  if (text === '') return 0;
  const matched = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (matched === null) {
    // 带时区偏移的 ISO 串交给引擎解（那种串自带时区，语义明确）。
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return new Date(
    Number(matched[1]),
    Number(matched[2]) - 1,
    Number(matched[3]),
    Number(matched[4]),
    Number(matched[5]),
    Number(matched[6]),
  ).getTime();
}

/**
 * 取会话名。
 *
 * `+at-me` 把会话名放在 `conversation` 里，形态是**数组**（["群名"]，留着扩展位）；
 * `+chat-messages` 不带会话名（要从未读会话列表补）。
 *
 * @param {object} item 一个消息对象。
 * @returns {string} 会话名；没有就是空串。
 */
function pickChatName(item) {
  const direct = pickString(item, ['chatName', 'conversationName', 'groupName']);
  if (direct !== '') return direct;
  const conversation = item.conversation;
  if (typeof conversation === 'string') return conversation.trim();
  if (Array.isArray(conversation)) {
    for (const entry of conversation) {
      if (typeof entry === 'string' && entry.trim() !== '') return entry.trim();
    }
  }
  return '';
}

/**
 * 深度遍历，找出所有「像消息」的数组。
 *
 * @param {unknown} node 当前节点。
 * @param {Array<Array<object>>} found 收集到的数组。
 * @param {number} depth 当前深度。
 */
function walkMessages(node, found, depth) {
  if (depth > 6 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    const messages = node.filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item) && looksLikeMessage(item));
    if (messages.length > 0) found.push(messages);
    for (const item of node) walkMessages(item, found, depth + 1);
    return;
  }
  for (const key of Object.keys(node)) walkMessages(node[key], found, depth + 1);
}

/**
 * 一个对象像不像一条消息。
 *
 * @param {object} item 候选对象。
 * @returns {boolean} 是否像消息。
 */
function looksLikeMessage(item) {
  const id = pickString(item, ['messageId', 'openMessageId', 'msgId']);
  const text = pickString(item, ['text', 'content', 'title']);
  const sender = pickString(item, ['sender', 'senderName', 'senderId']);
  return id !== '' || (text !== '' && sender !== '');
}

/**
 * 把 dws 的消息结果整理成插件要的形状。
 *
 * 契约内的字段（messageId / conversationId / sender / senderId / text /
 * createTime）按 im.message-list.v1 读；契约外的容器容错地找。
 *
 * @param {unknown} json dws 返回的 JSON。
 * @returns {Array<{messageId: string, conversationId: string, sender: string, senderId: string, text: string, createTime: number}>} 消息列表。
 */
export function collectMessages(json) {
  const groups = [];
  const envelope = json !== null && typeof json === 'object' && !Array.isArray(json) ? json[MESSAGE_ENVELOPE] : undefined;
  if (Array.isArray(envelope)) groups.push(envelope);
  if (groups.length === 0) walkMessages(json, groups, 0);

  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const item of group) {
      const message = {
        messageId: pickString(item, ['messageId', 'openMessageId', 'msgId']),
        conversationId: pickString(item, ['conversationId', 'openConversationId']),
        chatName: pickChatName(item),
        sender: pickString(item, ['sender', 'senderName', 'senderNick']),
        senderId: pickString(item, ['senderId', 'senderOpenDingTalkId']),
        text: pickString(item, ['text', 'content', 'title']),
        createTime: parseTime(item.createTime ?? item.time),
      };
      const key = message.messageId || message.text + '@' + message.createTime;
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      out.push(message);
    }
  }
  return out;
}

/**
 * 深度遍历，找出所有「像会话」的数组。
 *
 * @param {unknown} node 当前节点。
 * @param {Array<Array<object>>} found 收集到的数组。
 * @param {number} depth 当前深度。
 */
function walkChats(node, found, depth) {
  if (depth > 6 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    const chats = node.filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item)
      && pickString(item, ['conversationId', 'openConversationId']) !== '');
    if (chats.length > 0) found.push(chats);
    for (const item of node) walkChats(item, found, depth + 1);
    return;
  }
  for (const key of Object.keys(node)) walkChats(node[key], found, depth + 1);
}

/**
 * 把 dws 的未读会话列表整理成插件要的形状。
 *
 * `+unread-chats` 给的是 `{ conversations: [{ conversationId, name }] }`；
 * 契约外的形态容错地找，但**找不到会话 id 就丢掉这条** —— 没有 id 没法读它的消息。
 *
 * @param {unknown} json dws 返回的 JSON。
 * @returns {Array<{conversationId: string, name: string}>} 会话列表。
 */
export function collectChats(json) {
  const groups = [];
  if (json !== null && typeof json === 'object' && !Array.isArray(json) && Array.isArray(json.conversations)) {
    groups.push(json.conversations);
  }
  if (groups.length === 0) walkChats(json, groups, 0);

  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const item of group) {
      const conversationId = pickString(item, ['conversationId', 'openConversationId']);
      if (conversationId === '' || seen.has(conversationId)) continue;
      seen.add(conversationId);
      const name = pickChatName(item) !== '' ? pickChatName(item) : pickString(item, ['name', 'title', 'groupName']);
      out.push({ conversationId, name });
    }
  }
  return out;
}

/**
 * 把时间戳变成一句能读的时间。
 *
 * @param {number} createTime 毫秒时间戳（0 表示没有）。
 * @returns {string} 本地时间或空串。
 */
export function formatTime(createTime) {
  if (!Number.isFinite(createTime) || createTime <= 0) return '';
  const date = new Date(createTime);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  );
}
