// src/host/features/usage/labels.js
//
// 字段名 → 中文名 + 重要性排序。
//
// 存在的理由有两个，都是真实需求逼出来的：
//   1. 「所有字段都要解析」——模型分析失败时（模型偶发空手而归、或本 profile 没配
//      模型）兜底模板过去直接把 `current_interval_used_percent` 这种字段名当标题，
//      面板上就成了一片英文。这里给出确定性的中文名，兜底路径也看得懂。
//   2. 「默认展示 5 个最值得关心的，其余折叠」——顺序即优先级。模型的排序不可全信，
//      兜底路径的顺序完全由这里的 priorityForField 决定，保证「剩余/已用/距重置」
//      一定排在前五个里，而 start_time 这种低信息量字段沉到折叠区。
//
// 这是个**启发式词表**，不是词典：认不出来的字段保留原文（宁可见到陌生的英文名，
// 也不要把它错译成一个确定的错意思）。

/** 前缀词：决定「本周期 / 本周 / 当日」这类限定语。按长度从长到短匹配。 */
const PREFIXES = [
  ['current_interval', '本周期'],
  ['current_weekly', '本周'],
  ['current_monthly', '本月'],
  ['current_daily', '当日'],
  ['current_month', '本月'],
  ['this_interval', '本周期'],
  ['this_week', '本周'],
  ['this_month', '本月'],
  ['today', '当日'],
  ['yesterday', '昨日'],
  ['last', '上次'],
  ['previous', '上一'],
  ['next', '下次'],
  ['interval', '周期'],
  ['weekly', '本周'],
  ['monthly', '本月'],
  ['daily', '当日'],
  ['current', '当前'],
];

/** 词表：字段名里的一个词 → 中文。只覆盖真实见到过的语义。 */
const WORDS = {
  used: '已用',
  usage: '用量',
  consume: '消耗',
  consumed: '已消耗',
  remains: '剩余',
  remain: '剩余',
  remaining: '剩余',
  left: '剩余',
  available: '可用',
  balance: '余额',
  quota: '额度',
  credit: '积分',
  credits: '积分',
  gift: '赠送',
  bonus: '赠送',
  free: '免费',
  total: '总量',
  count: '次数',
  calls: '调用',
  call: '调用',
  requests: '请求',
  request: '请求',
  percent: '占比',
  percentage: '占比',
  ratio: '比例',
  rate: '速率',
  time: '时间',
  start: '开始',
  begin: '开始',
  end: '结束',
  expire: '到期',
  expires: '到期',
  expiry: '到期',
  expired: '已到期',
  reset: '重置',
  refresh: '刷新',
  next_reset: '下次重置',
  status: '状态',
  state: '状态',
  enabled: '是否启用',
  active: '是否激活',
  name: '名称',
  label: '名称',
  title: '标题',
  model: '模型',
  models: '模型',
  plan: '套餐',
  package: '套餐',
  product: '产品',
  level: '等级',
  tier: '等级',
  type: '类型',
  version: '版本',
  user: '用户',
  account: '账号',
  group: '分组',
  org: '组织',
  region: '区域',
  vendor: '供应方',
  provider: '供应方',
  feature: '功能',
  item: '项',
  index: '序号',
  order: '顺序',
  rank: '排名',
  value: '取值',
  amount: '金额',
  cost: '费用',
  price: '单价',
  currency: '币种',
  unit: '单位',
  size: '大小',
  bytes: '字节',
  duration: '时长',
  elapsed: '已耗时',
  latency: '延迟',
  day: '天',
  days: '天',
  month: '月',
  months: '月',
  year: '年',
  hour: '小时',
  minute: '分钟',
  second: '秒',
  msg: '文案',
  message: '文案',
  code: '编码',
  error: '错误',
  id: 'ID',
  key: '标识',
  token: 'Token',
  tokens: 'Token',
  scene: '场景',
  source: '来源',
  channel: '渠道',
};

/**
 * 给一个字段名配中文名。
 *
 * @param {string} field 原始字段名，如 `current_interval_used_percent`。
 * @returns {string} 中文名；认不出来时原样返回字段名。
 */
export function labelForField(field) {
  const raw = typeof field === 'string' ? field.trim() : '';
  if (raw === '') return '字段';
  // 已经含中文（例如接口自己给的中文字段名）就别动它。
  if (/[\u4e00-\u9fa5]/.test(raw)) return raw;

  let rest = raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  let prefixLabel = '';
  for (const [prefix, label] of PREFIXES) {
    if (rest === prefix) break;
    if (rest.startsWith(`${prefix}_`)) {
      prefixLabel = label;
      rest = rest.slice(prefix.length + 1);
      break;
    }
  }

  const tokens = rest.split(/[_.\-\[\]]+/).filter((token) => token !== '');
  const words = tokens.map((token) => WORDS[token] ?? (/^\d+$/.test(token) ? `#${token}` : null));
  if (words.every((word) => word === null)) return raw;

  // 「次数」在已经有量语义（已用/剩余/总量）时是冗余的：current_interval_total_count
  // 读成「本周期总量」而不是「本周期总量次数」。
  const hasAmountWord = tokens.some((token) => ['used', 'usage', 'remains', 'remain', 'remaining', 'left', 'available', 'balance', 'quota', 'credit', 'credits', 'total'].includes(token));
  const parts = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const word = words[index];
    if (word === null) {
      parts.push(tokens[index]);
      continue;
    }
    if (word === '次数' && hasAmountWord) continue;
    parts.push(word);
  }
  let body = parts.join('');
  // 「剩余时间」在用量语境里就是「距重置」——说清是什么剩下多久，比直译有用。
  if (body === '剩余时间') body = '距重置';
  if (body === '剩余次数') body = '剩余次数';
  if (body === '') return prefixLabel === '' ? raw : prefixLabel;
  return `${prefixLabel}${body}`;
}

/**
 * 重要性：数字越小越靠前（默认展示区）。
 *
 * 依据是「用量面板上用户先看什么」：先看还剩多少、已用多少、什么时候重置；
 * 总量和状态次之；起止时间、ID 这类只适合放进折叠区。
 *
 * @param {string} field 原始字段名。
 * @returns {number} 优先级。
 */
export function priorityForField(field) {
  const name = typeof field === 'string' ? field.toLowerCase() : '';
  if (name === '') return 90;
  // 总量占比基本恒为 100%，信息量最低，压到最后。
  if (/(total|sum)_percent|percent_total/.test(name)) return 95;
  if (/remain|left|available|balance|quota|credit/.test(name)) {
    if (/percent|ratio|rate/.test(name)) return 5;
    if (/time|second|minute|hour|day|date|at$/.test(name)) return 35;
    return 12;
  }
  if (/used|usage|consume/.test(name)) {
    if (/percent|ratio|rate/.test(name)) return 8;
    return 25;
  }
  if (/percent|percentage|ratio|rate/.test(name)) return 15;
  if (/reset|expire|renew|next_?period|deadline/.test(name)) return 30;
  if (/status|state|enabled|active/.test(name)) return 60;
  if (/total|limit|cap|max/.test(name)) return 45;
  if (/(^|_)(start|begin|end|create|update|last_?update)_?(time|at|date)?$|_at$|_time$|_date$/.test(name)) return 75;
  return 55;
}

/**
 * 猜格式：兜底模板用它把取值渲染成合适的文本。
 *
 * @param {string} field 字段名。
 * @param {unknown} value 其中一个取样值。
 * @returns {string} template.js 认可的 format。
 */
export function guessFormatForField(field, value) {
  const name = typeof field === 'string' ? field.toLowerCase() : '';
  if (typeof value === 'string' && /^-?\d+(\.\d+)?\s*%$/.test(value.trim())) return 'percent';
  if (/percent|percentage|ratio|_rate$/.test(name)) return 'percent';
  if (/remain_time|remains_time|left_time|ttl|duration|elapsed/.test(name)) return 'duration_ms';
  if (/(_at|_time|_date|timestamp)$/.test(name)) {
    if (typeof value === 'number' && value > 1e11) return 'datetime';
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return 'datetime';
    return 'text';
  }
  if (/status|state|enabled|active|name|label|title|type|model|code|msg|message|currency|unit|url|locale|email|phone/.test(name)) return 'text';
  if (typeof value === 'number') return Number.isInteger(value) ? 'count' : 'number';
  if (typeof value === 'boolean') return 'text';
  return 'text';
}

/**
 * 一组字段名按重要性排序（稳定排序，同优先级保持接口里的原始顺序）。
 *
 * @param {Array<{path: string}>} metrics 待排序的指标。
 * @returns {Array} 新数组。
 */
export function sortByPriority(metrics) {
  return metrics
    .map((metric, index) => ({ metric, index, priority: priorityForField(metric.path) }))
    .sort((a, b) => (a.priority === b.priority ? a.index - b.index : a.priority - b.priority))
    .map((entry) => entry.metric);
}
