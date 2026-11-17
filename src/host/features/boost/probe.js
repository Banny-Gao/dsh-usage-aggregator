// src/host/features/boost/probe.js
//
// 机器事实：磁盘、内存、交换、负载、占资源的进程、DSH 自己的家目录。
//
// 这一层**只读**，不改动任何东西。它产出的数字是后面两件事的输入：
//   · 面板上「为什么慢」的体检结论；
//   · Agent 判断该先清哪一项的排序依据。
//
// 跨平台：每个平台有自己的实现；不认识的平台只返回能拿到的那部分
// （CPU 核数是 os 模块给的，任何平台都有）。

import { readFile, opendir, lstat, statfs } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { loadavg, cpus, totalmem, freemem } from 'node:os';
import { runCommand } from './catalog.js';
import { aggregateByApp, sampleProcesses } from './processes.js';

/**
 * 量一个目录占多少字节。
 *
 * POSIX 上用 du -sk（系统工具更快也更准）；du 拿不到就退回自己遍历。
 * Windows 上不用 du —— 它（Git 自带的那个）遇到没权限的子目录就整体失败，
 * 量不了 C:\Windows\Temp 这种地方，所以直接自己遍历。
 *
 * @param {string} path 路径。
 * @param {{timeoutMs?: number}} options 选项。
 * @returns {Promise<number|null>} 字节数；量不了就是 null。
 */
export async function measureBytes(path, options = {}) {
  if (process.platform !== 'win32') {
    const result = await runCommand('du', ['-sk', path], { timeoutMs: options.timeoutMs ?? 60000 });
    if (result.ok) {
      const head = result.stdout.split(/\s+/)[0];
      const value = Number(head);
      if (Number.isFinite(value)) return value * 1024;
    }
  }
  return measureByWalking(path);
}

/**
 * 自己遍历一个目录，累加文件字节数。
 *
 * 流式遍历：一次只把**一个**目录的条目读进内存（待访问的目录只记路径），
 * 几十 GB 的目录也不会把整棵目录树装进内存。读不到的子目录跳过，
 * 不影响其余部分的统计；根目录都读不到才算量不了。
 *
 * @param {string} root 根目录。
 * @returns {Promise<number|null>} 字节数；量不了就是 null。
 */
async function measureByWalking(root) {
  const pending = [root];
  let total = 0;
  let opened = false;
  while (pending.length > 0) {
    const current = pending.pop();
    let dir;
    try {
      dir = await opendir(current);
    } catch {
      continue;
    }
    opened = true;
    const files = [];
    for await (const entry of dir) {
      if (entry.isDirectory()) pending.push(join(current, entry.name));
      else if (entry.isFile()) files.push(join(current, entry.name));
    }
    const sizes = await Promise.all(files.map(async (file) => {
      try {
        return (await lstat(file)).size;
      } catch {
        return 0;
      }
    }));
    for (const size of sizes) total += size;
  }
  return opened ? total : null;
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
 * Windows 的内存与交换。
 *
 * 内存用 os 模块（totalmem / freemem）；交换分区是页面文件，没有对应的
 * os 接口，只能问 WMI：AllocatedBaseSize 是页面文件分配的大小、
 * CurrentUsage 是已经用掉的部分，单位都是 MB。
 *
 * @returns {Promise<{totalBytes: number, freeBytes: number, swapTotalBytes: number, swapFreeBytes: number}|null>}
 */
async function readWindowsMeminfo() {
  const script = [
    '$p = Get-CimInstance Win32_PageFileUsage',
    '(($p | Measure-Object -Property AllocatedBaseSize -Sum).Sum), (($p | Measure-Object -Property CurrentUsage -Sum).Sum)',
  ].join('; ');
  const result = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 20000 });

  let swapTotalBytes = 0;
  let swapFreeBytes = 0;
  if (result.ok) {
    const numbers = result.stdout.match(/\d+/g) ?? [];
    const allocatedMb = Number(numbers[0]);
    const usedMb = Number(numbers[1]);
    if (Number.isFinite(allocatedMb) && allocatedMb > 0) {
      const used = Number.isFinite(usedMb) ? usedMb : 0;
      swapTotalBytes = allocatedMb * 1024 * 1024;
      swapFreeBytes = Math.max(0, allocatedMb - used) * 1024 * 1024;
    }
  }
  return { totalBytes: totalmem(), freeBytes: freemem(), swapTotalBytes, swapFreeBytes };
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
  if (platform === 'win32') return readWindowsMeminfo();
  return null;
}

/**
 * 磁盘占用。
 *
 * 用 fs.statfs 而不是解析 df：df 的输出格式各平台不同（Windows 上只有六列、
 * Linux 上也是六列），逐个平台写一套解析器既脆又没收益；statfs 给的是同一组
 * 数字，三个平台行为一致。
 *
 * @param {string} path 要量的挂载点。
 * @returns {Promise<{path: string, totalBytes: number, usedBytes: number, freeBytes: number, usePct: number}|null>}
 */
async function readDisk(path) {
  let stats;
  try {
    stats = await statfs(path);
  } catch {
    return null;
  }
  const bsize = Number(stats.bsize);
  const blocks = Number(stats.blocks);
  const available = Number(stats.bavail);
  if (!Number.isFinite(bsize) || !Number.isFinite(blocks) || blocks <= 0) return null;
  const totalBytes = bsize * blocks;
  const freeBytes = bsize * (Number.isFinite(available) ? available : 0);
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    path,
    totalBytes,
    usedBytes,
    freeBytes,
    // 百分比数值（不是 0~1 的比例）：下游按「90% 以上算快满」在用。
    usePct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
  };
}

/**
 * 要量的磁盘路径：家目录所在的那一个 + 系统盘根。
 *
 * @param {string} home 家目录。
 * @param {string} platform process.platform。
 * @returns {string[]} 路径。
 */
function diskPathsOf(home, platform) {
  if (platform === 'win32') return [home, parse(home).root];
  if (platform === 'darwin') return [home, '/System/Volumes/Data'];
  return [home, '/'];
}

/**
 * 采一张「每核累计忙时」的快照（毫秒）。
 *
 * @returns {number[]} 每核的累计忙时。
 */
function cpuBusySnapshot() {
  return cpus().map((cpu) => cpu.times.user + cpu.times.sys + cpu.times.nice + cpu.times.irq);
}

/**
 * 两张快照之间相当于几个核在忙。
 *
 * 累计时间还在涨的核就是正在忙的核，涨了多少就是忙了几分之一 —— 全部加起来
 * 就是「相当于几个满载核」，跟 Windows 自己报的 CPU 占用率对得上。
 *
 * @param {number[]} before 前一次快照。
 * @param {number[]} after 后一次快照。
 * @param {number} elapsedMs 两次采样之间的墙钟时间（毫秒）。
 * @returns {number} 忙碌核数（可带小数）。
 */
function busyCoresBetween(before, after, elapsedMs) {
  if (elapsedMs <= 0) return 0;
  let sum = 0;
  for (let index = 0; index < after.length; index += 1) {
    const delta = after[index] - (before[index] ?? after[index]);
    if (delta > 0) sum += delta / elapsedMs;
  }
  return sum;
}

/** 采两次 CPU 时间的间隔（毫秒）。 */
const CPU_SAMPLE_MS = 1000;

/**
 * 采两次 CPU 时间，间隔约一秒，算出「相当于几个核在忙」。
 *
 * Windows 上没有 loadavg（os.loadavg() 恒为 [0,0,0]），用累计 CPU 时间的
 * 增量代替：采样期间还在涨的核就是正在忙的核。
 *
 * @param {number} [intervalMs] 两次采样之间的间隔。
 * @returns {Promise<number>} 忙碌核数（可带小数）。
 */
async function measureBusyCores(intervalMs = CPU_SAMPLE_MS) {
  const before = cpuBusySnapshot();
  const startedAt = Date.now();
  await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  const after = cpuBusySnapshot();
  return busyCoresBetween(before, after, Date.now() - startedAt);
}

/**
 * DSH 自己的家目录构成。
 *
 * @param {string} home 家目录。
 * @param {object} env 环境变量。
 * @returns {Promise<{home: string, parts: Array<{name: string, bytes: number}>}>}
 */
async function readDshHome(home, env) {
  const dshHome = env.DSH_HOME ?? join(home, '.dsh');
  const names = ['trash', 'sessions', 'attachments', 'profiles', 'storages'];
  const parts = [];
  for (const name of names) {
    const bytes = await measureBytes(join(dshHome, name), { timeoutMs: 20000 });
    if (bytes === null || bytes <= 0) continue;
    parts.push({ name, bytes });
  }
  parts.sort((a, b) => b.bytes - a.bytes);
  return { home: dshHome, parts };
}

/** 判定「机器空闲」的阈值：POSIX 看负载，Windows 看忙碌核数。 */
export const IDLE_LOAD_THRESHOLD = 2;

/** 两轮 CPU 采样之间的间隔（毫秒）：采样窗口 1 秒，窗口之间留 4 秒空档。 */
const CPU_SAMPLE_CYCLE_MS = 5000;

/** 读数超过这个年龄就不认了（采样器卡住时别拿旧读数当现状）。 */
const CPU_READING_MAX_AGE_MS = 15000;

/** 后台采样器读到的数：{cores: 忙碌核数, at: 读数时刻}。 */
let cpuReading = null;

/** 后台采样器的定时器句柄。 */
let cpuTimer = null;

/** 后台采样器是否已经起过。 */
let cpuSamplerStarted = false;

/**
 * 后台每隔几秒算一次「相当于几个核在忙」。
 *
 * isMachineIdle 是**同步**的（自动体检的定时器直接拿它的返回值当判据），
 *没法在调用里等一次一秒的采样，所以采样放到后台去，读数存在这里。
 */
async function sampleCpuBusy() {
  try {
    const cores = await measureBusyCores(CPU_SAMPLE_MS);
    cpuReading = { cores, at: Date.now() };
  } catch {
    // 采不到就沿用上一次的读数。
  }
  cpuTimer = setTimeout(sampleCpuBusy, CPU_SAMPLE_CYCLE_MS);
  if (typeof cpuTimer.unref === 'function') cpuTimer.unref();
}

/**
 * 保证后台采样器在跑。
 */
function ensureCpuSampler() {
  if (cpuSamplerStarted) return;
  cpuSamplerStarted = true;
  sampleCpuBusy();
}

/**
 * 这台机器现在闲不闲。
 *
 * 体检要读几十 GB 的目录，是 I/O 密集的活儿 —— 抢在用户正忙着的时候跑会让
 * 机器更卡。判据用负载：POSIX 看 1 分钟负载，Windows 没有 loadavg，改看
 * 「相当于几个核在忙」，低于阈值就算闲。
 *
 * @param {number} [threshold] 阈值。
 * @returns {boolean} 是否空闲。
 */
export function isMachineIdle(threshold = IDLE_LOAD_THRESHOLD) {
  if (process.platform === 'win32') {
    ensureCpuSampler();
    const reading = cpuReading;
    // 还没有读数、或者读数太旧：一概当作「不闲」—— 宁可这一轮不扫，
    // 也不在用户正忙着的时候开跑。
    if (reading === null) return false;
    if (Date.now() - reading.at > CPU_READING_MAX_AGE_MS) return false;
    return reading.cores < threshold;
  }
  try {
    return loadavg()[0] < threshold;
  } catch {
    return true;
  }
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
  // Windows 上没有 loadavg：负载代理是「相当于几个核在忙」。
  const busy = platform === 'win32' ? await measureBusyCores() : null;
  const load = busy === null ? loadavg() : [busy, busy, busy];

  const [disks, dsh, sampled] = await Promise.all([
    Promise.all(diskPathsOf(home, platform).map((target) => readDisk(target))),
    readDshHome(home, env),
    sampleProcesses(),
  ]);

  // 进程表只采一次 —— Windows 上采一次要一两秒，采第二次纯属浪费。
  const top = sampled.processes
    .map((proc) => ({ pid: proc.pid, name: proc.app, cpuPct: proc.cpuPct, rssBytes: proc.rssBytes }))
    .sort((a, b) => b.rssBytes - a.rssBytes)
    .slice(0, topLimit);

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
    disk: disks.filter((item) => item !== null),
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
