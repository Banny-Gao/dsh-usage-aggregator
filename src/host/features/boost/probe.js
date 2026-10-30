// src/host/features/boost/probe.js
//
// 机器事实：磁盘、内存、交换、负载、占资源的进程、DSH 自己的家目录。
//
// 这一层**只读**，不改动任何东西。它产出的数字是后面两件事的输入：
//   · 面板上「为什么慢」的体检结论；
//   · Agent 判断该先清哪一项的排序依据。
//
// 跨平台：每个平台有自己的实现；不认识��平台只返回能拿到的那部分
// （负载与 CPU 核数是 os 模块给的，任何平台都有）。

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadavg, cpus } from 'node:os';
import { runCommand } from './catalog.js';
import { aggregateByApp, sampleProcesses } from './processes.js';

/**
 * 量一个目录占多少字节。
 *
 * 用 du -sk 而不是自己遍历：系统工具更快也更准（能算稀疏文件与硬链接）。
 *
 * @param {string} path 路径。
 * @param {{timeoutMs?: number}} options 选项。
 * @returns {Promise<number|null>} 字节数；量不了就是 null。
 */
export async function measureBytes(path, options = {}) {
  const result = await runCommand('du', ['-sk', path], { timeoutMs: options.timeoutMs ?? 60000 });
  if (!result.ok) return null;
  const head = result.stdout.split(/\s+/)[0];
  const value = Number(head);
  if (!Number.isFinite(value)) return null;
  return value * 1024;
}

/**
 * 读 /proc/meminfo 风格的内存信息（Linux）。
 *
 * @returns {Promise<{totalBytes: number, freeBytes: number, swapTotalBytes: number, swapFreeBytes: number}|null>}
 */
async function readLinuxMeminfo() {
  let text = '';
  try {
    text = await readFile('/proc/meminfo', 'utf8');
  } catch {
    return null;
  }
  const pick = (key) => {
    const match = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text);
    return match === null ? 0 : Number(match[1]) * 1024;
  };
  const totalBytes = pick('MemTotal');
  const availableBytes = pick('MemAvailable');
  const swapTotalBytes = pick('SwapTotal');
  const swapFreeBytes = pick('SwapFree');
  if (totalBytes === 0) return null;
  return {
    totalBytes,
    freeBytes: availableBytes === 0 ? pick('MemFree') : availableBytes,
    swapTotalBytes,
    swapFreeBytes,
  };
}

/**
 * macOS 的内存与交换。
 *
 * @returns {Promise<{totalBytes: number, freeBytes: number, swapTotalBytes: number, swapFreeBytes: number}|null>}
 */
async function readDarwinMeminfo() {
  const total = await runCommand('sysctl', ['-n', 'hw.memsize'], { timeoutMs: 5000 });
  const totalBytes = Number(total.stdout.trim());
  if (!total.ok || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;

  const vm = await runCommand('vm_stat', [], { timeoutMs: 5000 });
  let freeBytes = 0;
  if (vm.ok) {
    const sizeMatch = /page size of (\d+) bytes/.exec(vm.stdout);
    const pageSize = sizeMatch === null ? 4096 : Number(sizeMatch[1]);
    const freePages = /Pages free:\s+(\d+)/.exec(vm.stdout);
    freeBytes = freePages === null ? 0 : Number(freePages[1]) * pageSize;
  }

  const swap = await runCommand('sysctl', ['vm.swapusage'], { timeoutMs: 5000 });
  let swapTotalBytes = 0;
  let swapFreeBytes = 0;
  if (swap.ok) {
    const totalMatch = /total = ([\d.]+)M/.exec(swap.stdout);
    const freeMatch = /free = ([\d.]+)M/.exec(swap.stdout);
    swapTotalBytes = totalMatch === null ? 0 : Number(totalMatch[1]) * 1024 * 1024;
    swapFreeBytes = freeMatch === null ? 0 : Number(freeMatch[1]) * 1024 * 1024;
  }
  return { totalBytes, freeBytes, swapTotalBytes, swapFreeBytes };
}

/**
 * 内存与交换。
 *
 * @param {string} platform process.platform。
 * @returns {Promise<{totalBytes: number, freeBytes: number, swapTotalBytes: number, swapFreeBytes: number}|null>}
 */
async function readMemory(platform) {
  if (platform === 'darwin') return readDarwinMeminfo();
  if (platform === 'linux') return readLinuxMeminfo();
  return null;
}

/**
 * 磁盘占用。
 *
 * @param {string} path 要量的挂载点。
 * @returns {Promise<{path: string, totalBytes: number, usedBytes: number, freeBytes: number, usePct: number}|null>}
 */
async function readDisk(path) {
  const result = await runCommand('df', ['-k', path], { timeoutMs: 8000 });
  if (!result.ok) return null;
  const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
  if (lines.length < 2) return null;
  // 只请求了一个路径，所以数据行只有一条；按位置取数字，忽略挂载点名
  // （挂载点可能带空格，比如「Macintosh HD」）。
  const fields = lines[lines.length - 1].trim().split(/\s+/);
  if (fields.length < 8) return null;
  const totalBytes = Number(fields[1]) * 1024;
  const usedBytes = Number(fields[2]) * 1024;
  const freeBytes = Number(fields[3]) * 1024;
  const usePct = Number(String(fields[4]).replace('%', ''));
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  return {
    path,
    totalBytes,
    usedBytes,
    freeBytes,
    usePct: Number.isFinite(usePct) ? usePct : 0,
  };
}

/**
 * 占资源最多的进程。
 *
 * @param {number} limit 取前几个。
 * @returns {Promise<Array<{pid: number, name: string, cpuPct: number, rssBytes: number}>>}
 */
async function readTopProcesses(limit) {
  const result = await runCommand('ps', ['-Ao', 'pid=,rss=,pcpu=,comm='], { timeoutMs: 8000 });
  if (!result.ok) return [];
  const rows = [];
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const rssBytes = Number(parts[1]) * 1024;
    const cpuPct = Number(parts[2]);
    if (!Number.isFinite(pid)) continue;
    rows.push({
      pid,
      name: basename(parts.slice(3).join(' ')),
      cpuPct: Number.isFinite(cpuPct) ? Math.round(cpuPct * 10) / 10 : 0,
      rssBytes: Number.isFinite(rssBytes) ? rssBytes : 0,
    });
  }
  rows.sort((a, b) => b.rssBytes - a.rssBytes);
  return rows.slice(0, limit);
}

/**
 * DSH 自己的家目录构成。
 *
 * @param {string} home 家目录。
 * @param {object} env 环境变量。
 * @returns {Promise<{home: string, parts: Array<{name: string, bytes: number}>}>}
 */
async function readDshHome(home, env) {
  const dshHome = env.DSH_HOME ?? `${home}/.dsh`;
  const names = ['trash', 'sessions', 'attachments', 'profiles', 'storages'];
  const parts = [];
  for (const name of names) {
    const bytes = await measureBytes(`${dshHome}/${name}`, { timeoutMs: 20000 });
    if (bytes === null || bytes <= 0) continue;
    parts.push({ name, bytes });
  }
  parts.sort((a, b) => b.bytes - a.bytes);
  return { home: dshHome, parts };
}

/**
 * 采集一次机器事实。
 *
 * @param {{home: string, env: object, platform?: string, topLimit?: number}} options 选项。
 * @returns {Promise<object>} 事实快照。
 */
export async function probeSystem(options) {
  const home = options.home;
  const env = options.env;
  const platform = options.platform ?? process.platform;
  const topLimit = options.topLimit ?? 8;

  const memory = await readMemory(platform);
  const load = loadavg();
  const [homeDisk, rootDisk, top, dsh, sampled] = await Promise.all([
    readDisk(home),
    platform === 'darwin' ? readDisk('/System/Volumes/Data') : readDisk('/'),
    readTopProcesses(topLimit),
    readDshHome(home, env),
    sampleProcesses(),
  ]);

  const swapTotalBytes = memory === null ? 0 : memory.swapTotalBytes;
  const swapUsedBytes = memory === null ? 0 : Math.max(0, memory.swapTotalBytes - memory.swapFreeBytes);

  return {
    platform,
    cpuCount: cpus().length,
    load: {
      avg1: Math.round(load[0] * 100) / 100,
      avg5: Math.round(load[1] * 100) / 100,
      avg15: Math.round(load[2] * 100) / 100,
    },
    memory: memory === null
      ? null
      : {
        totalBytes: memory.totalBytes,
        freeBytes: memory.freeBytes,
        usedBytes: Math.max(0, memory.totalBytes - memory.freeBytes),
        swapTotalBytes,
        swapUsedBytes,
        // 交换分区用掉一半以上就说明内存已经不够用了 —— 这个阈值是常见的经验值，
        // 用来在面板上给出一句「内存吃紧」的判断，不是精确的压力指标。
        swapPressure: swapTotalBytes > 0 && swapUsedBytes / swapTotalBytes >= 0.5,
      },
    disk: [homeDisk, rootDisk].filter((item) => item !== null),
    topProcesses: top,
    // 内存按应用聚合（浏览器是几十个进程，逐个列用户没法判断），
    // CPU 是两次采样求差算出来的**瞬时**占用。
    apps: aggregateByApp(sampled.processes).slice(0, 10),
    topCpu: [...sampled.processes]
      .filter((proc) => proc.cpuPct >= 5)
      .sort((a, b) => b.cpuPct - a.cpuPct)
      .slice(0, 8),
    frontApp: sampled.frontApp,
    dsh,
  };
}
