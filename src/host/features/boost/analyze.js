// src/host/features/boost/analyze.js
//
// 诊断层：把「机器事实 + 发现的缓存条目」变成一句人话和一份建议顺序。
//
// 两级：
//   1. 有模型就问模型 —— 它能把「swap 用了 5 GB」和「pnpm store 17 GB」串成
//      「内存不够 + 磁盘快满」的因果，这是规则写不出来的。
//   2. 没有模型（没配 provider / 调用失败）就退回规则 —— 只做事实陈述与按体积
//      排序。**降级不隐藏**：结果里 source 会标明 'rules'，面板上写清楚。
//
// 无论哪一级，数字都来自 probe.js 的实测，模型只负责解释，不负责报数。

import { callModelText, extractJson } from '../../shared/llm.js';

/** 送去分析的提示词：只输出 JSON，不许编数字。 */
const SYSTEM_PROMPT = [
  '你是一个电脑性能与磁盘空间诊断助手。',
  '你的唯一产出是一段 JSON，不能有解释文字、不能有 Markdown 代码块之外的内容。',
  '所有数字必须来自给你的实测数据，不许推算、不许编造、不许引用你记忆里的常识数值。',
  '结论要具体（「swap 已用 5.0 GB」而不是「内存压力较大」），中文，不要空话。',
].join('\n');

/**
 * 把字节数说成人话。
 *
 * @param {number} bytes 字节。
 * @returns {string} 文本。
 */
export function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 || index <= 1 ? Math.round(value) : Math.round(value * 10) / 10} ${units[index]}`;
}

/**
 * 事实 → 给人看的摘要文本（喂给模型 / 显示给用户）。
 *
 * @param {object} facts 机器事实。
 * @param {Array<object>} items 条目。
 * @returns {string} 文本。
 */
export function factsToText(facts, items) {
  const lines = [];
  lines.push(`平台：${facts.platform}，CPU 核数：${facts.cpuCount}`);
  lines.push(`负载：1 分钟 ${facts.load.avg1} / 5 分钟 ${facts.load.avg5} / 15 分钟 ${facts.load.avg15}`);
  if (facts.memory !== null) {
    lines.push(
      `内存：总计 ${humanBytes(facts.memory.totalBytes)}，已用 ${humanBytes(facts.memory.usedBytes)}，可用 ${humanBytes(facts.memory.freeBytes)}`,
    );
    lines.push(
      `交换分区：已用 ${humanBytes(facts.memory.swapUsedBytes)} / ${humanBytes(facts.memory.swapTotalBytes)}`,
    );
  }
  for (const disk of facts.disk) {
    lines.push(
      `磁盘 ${disk.path}：总计 ${humanBytes(disk.totalBytes)}，已用 ${humanBytes(disk.usedBytes)}，剩余 ${humanBytes(disk.freeBytes)}（${disk.usePct}%）`,
    );
  }
  if (facts.topProcesses.length > 0) {
    lines.push('占内存最多的进程：');
    for (const proc of facts.topProcesses) {
      lines.push(`  - ${proc.name}（pid ${proc.pid}）：${humanBytes(proc.rssBytes)} 内存，CPU ${proc.cpuPct}%`);
    }
  }
  if (Array.isArray(facts.apps) && facts.apps.length > 0) {
    lines.push('按应用聚合的内存占用（一个应用可能是几十个进程）：');
    for (const app of facts.apps) {
      lines.push(`  - ${app.app}：${humanBytes(app.rssBytes)}，${app.count} 个进程，合计 CPU ${app.cpuPct}%`);
    }
  }
  if (Array.isArray(facts.topCpu) && facts.topCpu.length > 0) {
    lines.push('此刻正在占 CPU 的进程（瞬时占用，两次采样求差）：');
    for (const proc of facts.topCpu) {
      lines.push(`  - ${proc.app}（pid ${proc.pid}）：${proc.cpuPct}% CPU，${humanBytes(proc.rssBytes)} 内存`);
    }
  }
  if (typeof facts.frontApp === 'string' && facts.frontApp !== '') {
    lines.push(`用户当前在前台的程序：${facts.frontApp}`);
  }
  if (facts.dsh.parts.length > 0) {
    lines.push('DSH 自己的目录：');
    for (const part of facts.dsh.parts) {
      lines.push(`  - ${part.name}：${humanBytes(part.bytes)}`);
    }
  }
  if (items.length > 0) {
    lines.push('在这台机器上发现的可加速 / 可清理条目：');
    for (const item of items) {
      const group = item.group === 'dsh' ? 'DSH 自己' : (item.group === 'process' ? '进程与窗口' : '工具链缓存');
      const size = item.sizeBytes > 0 ? humanBytes(item.sizeBytes) : `${item.count} 项`;
      lines.push(`  - [${item.id}] ${item.label}（${group}）：${size}，语义 ${item.semantics}，动作 ${item.commandText}`);
    }
  } else {
    lines.push('没有发现任何可加速 / 可清理的条目。');
  }
  return lines.join('\n');
}

/**
 * 规则兜底：只做事实陈述与排序。
 *
 * @param {object} facts 机器事实。
 * @param {Array<object>} items 条目。
 * @returns {{diagnosis: string, findings: string[], priority: string[], warnings: string[], source: string}}
 */
export function ruleAnalysis(facts, items) {
  const findings = [];
  const warnings = [];

  const disk = facts.disk.find((item) => item.path.endsWith('/')) ?? facts.disk[0] ?? null;
  if (disk !== null) {
    findings.push(`磁盘剩余 ${humanBytes(disk.freeBytes)}（已用 ${disk.usePct}%）`);
    if (disk.usePct >= 90) {
      findings.push('磁盘接近写满：系统写临时文件、交换分区、缓存都会因此变慢');
    }
  }
  if (facts.memory !== null) {
    findings.push(
      `内存已用 ${humanBytes(facts.memory.usedBytes)} / ${humanBytes(facts.memory.totalBytes)}，交换分区已用 ${humanBytes(facts.memory.swapUsedBytes)}`,
    );
    if (facts.memory.swapPressure) {
      findings.push('交换分区用掉一半以上，说明物理内存已经不够，机器在拿磁盘当内存用');
      warnings.push('内存吃紧时，腾出磁盘空间能直接缓解：交换分区需要磁盘空间');
    }
  }
  if (facts.load.avg15 > facts.load.avg1 * 2 && facts.load.avg15 > 1) {
    findings.push(`15 分钟平均负载 ${facts.load.avg15} 远高于当前 ${facts.load.avg1}：刚才跑过一波重活，负载正在回落`);
  }
  const heavy = facts.topProcesses.find((proc) => proc.rssBytes > 500 * 1024 * 1024);
  if (heavy !== undefined) {
    findings.push(`${heavy.name} 占了 ${humanBytes(heavy.rssBytes)} 内存，是当前最大的占用者`);
  }
  const diskItems = items.filter((item) => item.sizeBytes > 0);
  const totalBytes = diskItems.reduce((sum, item) => sum + item.sizeBytes, 0);
  if (items.length > 0) {
    findings.push(`这台机器上共发现 ${items.length} 项可加速 / 可清理的条目，其中 ${diskItems.length} 项是磁盘上的缓存，合计约 ${humanBytes(totalBytes)}`);
  }
  const hotApps = (facts.apps ?? []).filter((app) => app.rssBytes > 500 * 1024 * 1024);
  if (hotApps.length > 0) {
    findings.push(`内存占用最大的是 ${hotApps[0].app}（${humanBytes(hotApps[0].rssBytes)}，${hotApps[0].count} 个进程）`);
  }
  const hotCpu = (facts.topCpu ?? [])[0];
  if (hotCpu !== undefined) {
    findings.push(`此刻最占 CPU 的是 ${hotCpu.app}（${hotCpu.cpuPct}%，pid ${hotCpu.pid}）`);
  }

  const priority = [...items]
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .map((item) => item.id);

  return {
    diagnosis: items.length === 0
      ? '没有发现可加速 / 可清理的条目。'
      : `这台机器上有 ${items.length} 项可以加速或清理的内容，磁盘上的缓存合计约 ${humanBytes(totalBytes)}。`,
    findings,
    priority,
    warnings,
    source: 'rules',
  };
}

/**
 * 诊断。
 *
 * @param {object} options 选项。
 * @param {object|null} options.llm Host 的 llm 服务（没有就退规则）。
 * @param {string} options.provider 模型 provider。
 * @param {string} options.model 模型。
 * @param {object} options.facts 机器事实。
 * @param {Array<object>} options.items 条目。
 * @param {number} [options.maxTokens] 输出上限。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @returns {Promise<object>} 诊断结果。
 */
export async function analyzeSystem(options) {
  const { facts, items } = options;
  const fallback = ruleAnalysis(facts, items);
  if (options.llm === null || options.llm === undefined) return fallback;

  const prompt = [
    '下面是这台电脑的实测数据，以及在这台机器上发现的可加速 / 可清理条目。',
    '条目分三类：工具链缓存（删了会重下）、DSH 自己的数据（会话 / 归档 / 回收站）、',
    '进程与窗口（结束程序、关浏览器窗口）。',
    '请判断：现在为什么感觉慢 / 空间为什么紧张，并给出建议。',
    '',
    '【实测数据】',
    factsToText(facts, items),
    '',
    '输出这个 JSON（不要多余键）：',
    '{',
    '  "diagnosis": "一句话结论（40 字以内）",',
    '  "findings": ["2-4 条观察，每条都要带具体数字"],',
    '  "priority": ["建议的清理顺序，用条目 id"],',
    '  "warnings": ["注意事项，没有就空数组"]',
    '}',
    '规则：',
    '- priority 只能从上面列出的条目 id 里选，按「先清收益最大、且不影响正在使用的东西」排序。',
    '- findings 只写实测数据支持得了的观察，不要猜原因。',
    '- 如果实测数据看不出明显问题，diagnosis 就直说「没有明显瓶颈」，不要硬凑。',
  ].join('\n');

  try {
    const text = await callModelText(options.llm, {
      provider: options.provider,
      model: options.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: options.maxTokens,
      signal: options.signal,
    });
    const raw = extractJson(text);
    if (raw === null || typeof raw !== 'object') return fallback;
    const known = new Set(items.map((item) => item.id));
    const priority = Array.isArray(raw.priority)
      ? raw.priority.filter((id) => known.has(id))
      : fallback.priority;
    return {
      diagnosis: typeof raw.diagnosis === 'string' && raw.diagnosis !== '' ? raw.diagnosis : fallback.diagnosis,
      findings: Array.isArray(raw.findings)
        ? raw.findings.filter((line) => typeof line === 'string' && line.trim() !== '').slice(0, 6)
        : fallback.findings,
      priority: priority.length > 0 ? priority : fallback.priority,
      warnings: Array.isArray(raw.warnings)
        ? raw.warnings.filter((line) => typeof line === 'string' && line.trim() !== '').slice(0, 4)
        : fallback.warnings,
      source: 'model',
    };
  } catch {
    // 模型不可用不是错误 —— 体检照常出结果，只是诊断退成规则版。
    return fallback;
  }
}
