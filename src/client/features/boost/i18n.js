// src/client/features/boost/i18n.js
//
// 「电脑加速与清理」的中英文文案。
//
// zh 是基准字典；en 缺 key 时回落到 zh（见共享的 makeTranslator）。

/** locale 命名空间。新功能，没有历史包袱，取一个不会与别的包撞的名字。 */
export const NS = 'pcBoost';

export const zh = {
  // 入口
  entry: '小火箭',
  entryTitle: '电脑加速与清理',

  // 面板
  title: '电脑加速与清理',
  subtitle: '体检这台机器，找出可以清理的过期缓存。',
  scanning: '正在体检…',
  scanningHint: '第一次体检要量一遍缓存目录，可能要几十秒。',
  scanAgain: '重新体检',
  empty: '这台机器上没有发现可清理的缓存。',
  emptyHint: '装了什么工具、缓存在哪，都是现场探测的 —— 可能是工具刚装还没用过。',
  selectAll: '全选',
  selectNone: '全不选',
  total: '共可回收 {size}',
  totalUnknown: '正在统计体积…',
  run: '交给 Agent 执行',
  running: '正在交给 Agent…',
  close: '关闭',

  // 条目
  groupCache: '工具链缓存',
  groupDsh: 'DSH 自己',
  groupProcess: '进程与窗口',
  itemSemanticsPrune: '只删没人引用的',
  itemSemanticsTerminate: '会结束进程',
  itemSemanticsRenice: '只降优先级',
  itemSemanticsCloseWindow: '会关窗口',
  itemSemanticsFull: '整个清空',
  itemRiskLow: '低风险',
  itemRiskMedium: '需重下',
  itemRiskHistory: '会丢历史',
  itemRiskInterrupt: '会中断',
  itemRiskHigh: '会关掉程序',
  itemInUse: '有正在运行的进程在用，会自动跳过',

  // 诊断
  diagnosis: '体检结论',
  findings: '观察',
  warnings: '注意',
  analysisByModel: '由模型分析',
  analysisByRules: '按固定规则排序（没有可用的模型）',

  // 结果
  done: '已交给 Agent，去对话里看它的说明与执行结果。',
  doneDirect: '已由面板直接执行。',
  executingDirect: '面板直接执行（{reason}）。接下来会执行清单里勾选的这几项，每一项做什么都写在清单上。',
  progress: '正在执行 {done}/{total}：{label}',
  ageNow: '刚刚体检过',
  ageMinutes: '{n} 分钟前体检的',
  ageHours: '{n} 小时前体检的',
  ageDays: '{n} 天前体检的',
  scannedAt: '（{age}）',
  handoffTimeout: '交接超时，Agent 那边没有回音',
  handoffNoSession: '当前会话不可用',
  failed: '执行失败：{error}',
  reclaimed: '回收了约 {size}',

  // 交给 Agent 的那段话
  handoffTitle: '交给 Agent 的内容',

  // 聚合设置页
  tab: '加速',
  hubIntro: '右下角的小火箭是同一份体检结果：这里能看到完整清单与结论。',
};

export const en = {
  entry: 'Rocket',
  entryTitle: 'Speed up & clean up',

  title: 'Speed up & clean up',
  subtitle: 'Check this machine and find expired caches worth clearing.',
  scanning: 'Checking…',
  scanningHint: 'The first check has to measure every cache directory, which can take a while.',
  scanAgain: 'Check again',
  empty: 'No cleanable cache found on this machine.',
  emptyHint: 'Tools and their cache locations are discovered at runtime — the tools may simply not have been used yet.',
  selectAll: 'Select all',
  selectNone: 'Clear selection',
  total: '{size} reclaimable',
  totalUnknown: 'Measuring…',
  run: 'Let the Agent do it',
  running: 'Handing over…',
  close: 'Close',

  groupCache: 'Toolchain caches',
  groupDsh: 'DSH itself',
  groupProcess: 'Processes & windows',
  itemSemanticsPrune: 'only unreferenced entries',
  itemSemanticsTerminate: 'ends processes',
  itemSemanticsRenice: 'lowers priority',
  itemSemanticsCloseWindow: 'closes a window',
  itemSemanticsFull: 'wiped entirely',
  itemRiskLow: 'low risk',
  itemRiskMedium: 'needs re-download',
  itemRiskHistory: 'loses history',
  itemRiskInterrupt: 'may interrupt',
  itemRiskHigh: 'closes the app',
  itemInUse: 'in use by a running process — will be skipped',

  diagnosis: 'Findings',
  findings: 'Observations',
  warnings: 'Cautions',
  analysisByModel: 'analysed by the model',
  analysisByRules: 'ranked by fixed rules (no model available)',

  done: 'Handed to the Agent — see its explanation and results in the conversation.',
  doneDirect: 'The panel ran it directly.',
  executingDirect: 'Running it here instead ({reason}). The ticked items are about to run — each one says what it does.',
  progress: 'Running {done}/{total}: {label}',
  ageNow: 'checked just now',
  ageMinutes: 'checked {n} min ago',
  ageHours: 'checked {n} h ago',
  ageDays: 'checked {n} d ago',
  scannedAt: '({age})',
  handoffTimeout: 'the handoff timed out — the Agent never answered',
  handoffNoSession: 'no usable session',
  failed: 'Failed: {error}',
  reclaimed: 'reclaimed about {size}',

  handoffTitle: 'What the Agent receives',

  tab: 'Boost',
  hubIntro: 'The rocket in the bottom-right corner shows the same check: here you get the full list and findings.',
};
