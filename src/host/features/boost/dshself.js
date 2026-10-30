// src/host/features/boost/dshself.js
//
// DSH 自己的可清理面：会话日志、归档、回收站、投影缓存、附件、以及用量查询
// 自动续期用的那个浏览器配置。
//
// 与「工具链缓存」那层的根本区别：那些是**别人的**缓存，删了��自己重建；
// 这里的每一个都是 DSH 自己的数据 —— 有些是可重建的缓存（投影缓存），
// 有些是**用户的历史**（会话日志、附件）。所以：
//
//   · 可重建的（投影缓存、浏览器缓存）→ 低风险，默认勾选；
//   · 已经删掉的东西（回收站里的快照、旧格式日志）→ 低风险，默认勾选；
//   · **用户的历史**（会话正文、附件）→ 中风险，默认**不勾**，让用户自己决定。
//
// 会话日志是 `session.v4.jsonl.zstd`（zstd 压缩的 JSONL 事件流）。第一行是
// 会话头，里面有 origin（subagent / lead）、parentSession（父会话）、cwd、
// createdAt —— 判断「这是不是冗余」全靠它。

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { measureBytes } from './probe.js';

/** 会话日志的当前格式。DSH 0.2.x 只读这一种。 */
const CURRENT_FORMAT = 'session.v4.jsonl.zstd';

/** 回收站保留几份快照。剩下的都是「早就删掉的东西」的化石。 */
export const TRASH_KEEP_NEWEST = 3;

/** 多久算「旧会话」（天）。 */
export const OLD_SESSION_DAYS = 7;

/** 多久算「旧附件」（天）。 */
export const OLD_ATTACHMENT_DAYS = 30;

/**
 * 读一个会话日志的头（第一行）。
 *
 * @param {string} file 会话日志路径。
 * @returns {Promise<object|null>} 头；读不出来就是 null。
 */
export function readSessionHeader(file) {
  return new Promise((resolve) => {
    const child = spawn('zstd', ['-dcq', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buffer = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* 已经退了 */ }
      resolve(value);
    };
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      try {
        finish(JSON.parse(buffer.slice(0, index)));
      } catch {
        finish(null);
      }
    });
    child.on('close', () => {
      if (buffer.trim() === '') {
        finish(null);
        return;
      }
      try {
        finish(JSON.parse(buffer.split('\n')[0]));
      } catch {
        finish(null);
      }
    });
    child.on('error', () => finish(null));
  });
}

/**
 * 列出磁盘上的所有会话。
 *
 * @param {string} sessionsRoot 会话根目录。
 * @returns {Promise<Array<object>>} 会话列表。
 */
export async function listSessions(sessionsRoot) {
  const sessions = [];
  let slugs;
  try {
    slugs = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return sessions;
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugDir = join(sessionsRoot, slug.name);
    let ids;
    try {
      ids = await readdir(slugDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const id of ids) {
      if (!id.isDirectory()) continue;
      const dir = join(slugDir, id.name);
      const file = join(dir, CURRENT_FORMAT);
      let info;
      try {
        info = await stat(file);
      } catch {
        continue;
      }
      const header = await readSessionHeader(file);
      sessions.push({
        id: id.name,
        dir,
        file,
        bytes: info.size,
        mtimeMs: info.mtimeMs,
        origin: header?.origin ?? 'lead',
        parentSession: header?.parentSession ?? null,
        cwd: header?.cwd ?? null,
        createdAt: header?.createdAt ?? 0,
      });
    }
  }
  return sessions;
}

/**
 * 找出**旧格式**的会话日志（DSH 0.2.x 不再读它们）。
 *
 * @param {string} sessionsRoot 会话根目录。
 * @returns {Promise<Array<{path: string, bytes: number}>>} 文件列表。
 */
export async function listLegacyLogs(sessionsRoot) {
  const files = [];
  let slugs;
  try {
    slugs = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugDir = join(sessionsRoot, slug.name);
    let ids;
    try {
      ids = await readdir(slugDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const id of ids) {
      if (!id.isDirectory()) continue;
      const dir = join(slugDir, id.name);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.jsonl.zstd')) continue;
        if (entry.name === CURRENT_FORMAT) continue;
        const path = join(dir, entry.name);
        try {
          const info = await stat(path);
          files.push({ path, bytes: info.size });
        } catch {
          /* 已经没了 */
        }
      }
    }
  }
  return files;
}

/**
 * 读归档集合（哪些会话被归档了）。
 *
 * 归档集合存在 workspace.json 的 global.archivedSessionIds —— 它是
 * 「注册表全局」的，跟工作区无关。
 *
 * @param {string} storagesRoot storages 目录。
 * @returns {Promise<string[]>} 已归档的会话 id。
 */
export async function readArchivedSessionIds(storagesRoot) {
  try {
    const raw = await readFile(join(storagesRoot, 'workspace.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const ids = parsed?.global?.archivedSessionIds;
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 列出回收站快照。
 *
 * @param {string} trashRoot 回收站目录。
 * @returns {Promise<Array<{name: string, path: string, bytes: number, mtimeMs: number}>>} 快照。
 */
export async function listTrashSnapshots(trashRoot) {
  const snapshots = [];
  let entries;
  try {
    entries = await readdir(trashRoot, { withFileTypes: true });
  } catch {
    return snapshots;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(trashRoot, entry.name);
    // 用 du 量而不是自己遍历：回收站里是几百 MB 的会话快照，逐文件 readdir
    // 要好几秒，du 一下就完了。
    const bytes = (await measureBytes(path)) ?? 0;
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      /* 取不到就当是最老的 */
    }
    snapshots.push({ name: entry.name, path, bytes, mtimeMs });
  }
  snapshots.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return snapshots;
}

/**
 * 递归量一个目录的字节数。
 *
 * @param {string} dir 目录。
 * @returns {Promise<number>} 字节数。
 */
export async function dirBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirBytes(path);
      continue;
    }
    try {
      total += (await stat(path)).size;
    } catch {
      /* 读不到就跳过 */
    }
  }
  return total;
}

/**
 * 列出 DSH 自己可清理的项。
 *
 * @param {{dshHome: string, liveSessionIds: string[]}} options 选项。
 * @returns {Promise<Array<object>>} 条目。
 */
export async function listDshItems(options) {
  const dshHome = options.dshHome;
  const live = new Set(options.liveSessionIds ?? []);
  const items = [];

  const sessionsRoot = join(dshHome, 'sessions');
  const storagesRoot = join(dshHome, 'storages');
  const trashRoot = join(dshHome, 'trash');
  const attachmentsRoot = join(dshHome, 'attachments');

  /* ── 回收站 ─────────────────────────────────────────────── */
  const snapshots = await listTrashSnapshots(trashRoot);
  if (snapshots.length > TRASH_KEEP_NEWEST) {
    const stale = snapshots.slice(TRASH_KEEP_NEWEST);
    items.push({
      id: 'dsh-trash',
      label: 'DSH 回收站里的旧快照',
      group: 'dsh',
      semantics: 'prune',
      risk: 'low',
      note: `回收站里已经删掉的东西，DSH 不会自动清。这里是 ${snapshots.length} 份快照里的旧的那几份（保留最近 ${TRASH_KEEP_NEWEST} 份）。`,
      sizeBytes: stale.reduce((sum, item) => sum + item.bytes, 0),
      count: stale.length,
      commandText: `保留最近 ${TRASH_KEEP_NEWEST} 份，删掉其余 ${stale.length} 份`,
      selectedByDefault: true,
      action: { type: 'remove-trash-snapshots', keepNewest: TRASH_KEEP_NEWEST },
    });
  }

  /* ── 会话日志 ───────────────────────────────────────────── */
  const sessions = await listSessions(sessionsRoot);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const now = Date.now();

  const legacy = await listLegacyLogs(sessionsRoot);
  if (legacy.length > 0) {
    items.push({
      id: 'dsh-legacy-sessions',
      label: '旧格式的会话日志',
      group: 'dsh',
      semantics: 'full',
      risk: 'low',
      note: `这些是 DSH 旧版本格式的会话日志（当前版本只读 ${CURRENT_FORMAT}），已经没有任何功能会打开它们。`,
      sizeBytes: legacy.reduce((sum, item) => sum + item.bytes, 0),
      count: legacy.length,
      commandText: `删掉 ${legacy.length} 个旧格式日志文件`,
      selectedByDefault: true,
      action: { type: 'remove-legacy-logs' },
    });
  }

  // 孤儿子代理：父会话已经不在盘上了。父会话没了，子代理的日志就是孤儿。
  const orphans = sessions.filter((session) => {
    if (session.origin !== 'subagent') return false;
    if (live.has(session.id)) return false;
    if (session.parentSession === null) return false;
    const parentId = session.parentSession.replace(/^session-/, '');
    return !byId.has(session.parentSession) && !byId.has(parentId);
  });
  if (orphans.length > 0) {
    items.push({
      id: 'dsh-orphan-sessions',
      label: '孤儿子代理会话',
      group: 'dsh',
      semantics: 'prune',
      risk: 'medium',
      note: '父会话已经被删掉、但子代理的对话记录还留在盘上的会话。它们不会出现在任何界面里，只有占空间。',
      sizeBytes: orphans.reduce((sum, session) => sum + session.bytes, 0),
      count: orphans.length,
      commandText: `删掉 ${orphans.length} 个孤儿子代理会话`,
      selectedByDefault: false,
      action: { type: 'remove-orphan-sessions' },
    });
  }

  // 过期会话：超过 N 天没动过。
  const cutoff = now - OLD_SESSION_DAYS * 86400000;
  const old = sessions.filter((session) => !live.has(session.id) && session.mtimeMs < cutoff);
  if (old.length > 0) {
    items.push({
      id: 'dsh-old-sessions',
      label: `${OLD_SESSION_DAYS} 天没动过的会话`,
      group: 'dsh',
      semantics: 'prune',
      risk: 'medium',
      note: `超过 ${OLD_SESSION_DAYS} 天没有改动过的会话（含子代理）。删掉之后这些历史就找不回来了。`,
      sizeBytes: old.reduce((sum, session) => sum + session.bytes, 0),
      count: old.length,
      commandText: `删掉 ${old.length} 个 ${OLD_SESSION_DAYS} 天没动过的会话`,
      selectedByDefault: false,
      action: { type: 'remove-old-sessions', minAgeDays: OLD_SESSION_DAYS },
    });
  }

  // 归档会话：归档只是「收起来」，数据还在盘上。
  const archivedIds = await readArchivedSessionIds(storagesRoot);
  const archived = sessions.filter((session) => archivedIds.includes(session.id) && !live.has(session.id));
  if (archived.length > 0) {
    items.push({
      id: 'dsh-archived-sessions',
      label: '已归档会话的正文',
      group: 'dsh',
      semantics: 'prune',
      risk: 'medium',
      note: '归档只是把会话收进「已归档」列表，数据仍然在盘上占着。删掉就等于彻底放弃这几段历史 —— 删除时会先把它从归档清单里摘掉，界面里不会留一条打不开的条目。',
      sizeBytes: archived.reduce((sum, session) => sum + session.bytes, 0),
      count: archived.length,
      commandText: `删掉 ${archived.length} 个已归档会话的正文`,
      selectedByDefault: false,
      action: { type: 'remove-archived-sessions' },
    });
  }

  /* ── 投影缓存 ───────────────────────────────────────────── */
  const projcacheRoot = join(storagesRoot, 'session_projcache', 'sessions');
  let projcacheFiles = [];
  try {
    projcacheFiles = await readdir(projcacheRoot);
  } catch {
    projcacheFiles = [];
  }
  if (projcacheFiles.length > 0) {
    const stale = projcacheFiles.filter((name) => !byId.has(name.replace(/\.json$/, '')));
    if (stale.length > 0) {
      let bytes = 0;
      for (const name of stale) {
        try {
          bytes += (await stat(join(projcacheRoot, name))).size;
        } catch {
          /* 读不到就跳过 */
        }
      }
      items.push({
        id: 'dsh-projcache',
        label: '会话投影缓存的残留',
        group: 'dsh',
        semantics: 'full',
        risk: 'low',
        note: '投影缓存只是读日志的快捷方式（DSH 自己说它「永远不是权威」），会话没了它留着也没用，可以随时重建。',
        sizeBytes: bytes,
        count: stale.length,
        commandText: `删掉 ${stale.length} 个没有对应会话的缓存文件`,
        selectedByDefault: true,
        action: { type: 'remove-stale-projcache' },
      });
    }
  }

  /* ── 附件 ───────────────────────────────────────────────── */
  let attachmentBytes = 0;
  let attachmentCount = 0;
  let oldAttachmentBytes = 0;
  let oldAttachmentCount = 0;
  const attachmentCutoff = now - OLD_ATTACHMENT_DAYS * 86400000;
  const versionDirs = await readdir(attachmentsRoot, { withFileTypes: true }).catch(() => []);
  for (const version of versionDirs) {
    if (!version.isDirectory()) continue;
    const versionRoot = join(attachmentsRoot, version.name);
    const objects = await readdir(versionRoot, { withFileTypes: true }).catch(() => []);
    for (const object of objects) {
      if (!object.isDirectory()) continue;
      const objectRoot = join(versionRoot, object.name);
      const files = await readdir(objectRoot, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile()) continue;
        let info;
        try {
          info = await stat(join(objectRoot, file.name));
        } catch {
          continue;
        }
        attachmentBytes += info.size;
        attachmentCount += 1;
        if (info.mtimeMs < attachmentCutoff) {
          oldAttachmentBytes += info.size;
          oldAttachmentCount += 1;
        }
      }
    }
  }
  if (oldAttachmentCount > 0) {
    items.push({
      id: 'dsh-attachments',
      label: `${OLD_ATTACHMENT_DAYS} 天前的会话附件`,
      group: 'dsh',
      semantics: 'prune',
      risk: 'medium',
      note: '图片、截图这类附件。删掉之后，旧会话里的那张图就看不到了（会话正文还在）。',
      sizeBytes: oldAttachmentBytes,
      count: oldAttachmentCount,
      commandText: `删掉 ${oldAttachmentCount} 个超过 ${OLD_ATTACHMENT_DAYS} 天的附件`,
      selectedByDefault: false,
      action: { type: 'remove-old-attachments', minAgeDays: OLD_ATTACHMENT_DAYS },
    });
  }

  /* ── 用量查询自动续期的浏览器配置 ───────────────────────── */
  const usageProfileRoot = join(dshHome, 'dsh-usage-query', 'profiles');
  const usageProfiles = await readdir(usageProfileRoot, { withFileTypes: true }).catch(() => []);
  for (const profile of usageProfiles) {
    if (!profile.isDirectory()) continue;
    const profileRoot = join(usageProfileRoot, profile.name);
    const bytes = (await measureBytes(profileRoot)) ?? 0;
    if (bytes < 1024 * 1024) continue;
    items.push({
      id: 'dsh-usage-browser',
      label: '用量查询自动续期的浏览器配置',
      group: 'dsh',
      semantics: 'full',
      risk: 'low',
      note: '自动续期要驱动一个真实的 Chrome，那个浏览器的用户配置就落在这里。里面绝大多数是浏览器缓存，清掉不影响配置与登录态。',
      sizeBytes: bytes,
      count: 1,
      commandText: '清掉这个浏览器配置里的缓存目录',
      selectedByDefault: true,
      action: { type: 'clear-browser-profile', path: profileRoot },
    });
  }

  return items;
}
