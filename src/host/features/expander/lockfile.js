// src/host/features/expander/lockfile.js
//
// 原 dsh-plugin-expander/lib/lockfile.js —— 逐字搬过来，逻辑一行未改。
//
// 从 profile 的 pnpm-lock.yaml 里读出「每个依赖实际钉在哪个版本 / 哪个提交」。
//
// 为什么需要它：插件管理器只报告已装包的清单版本（package.json 的 version），
// 对 git 依赖来说那是「某个提交上的版本号」—— 光看版本号没法判断远端有没有新提交。
// 锁文件的 importers 段记着 git 依赖解析到的提交号，那才是能和远端 HEAD 对比的。
//
// 解析刻意做得很窄：只读 importers 段里依赖名下面的 version 行。锁文件是机器生成
// 的，结构稳定；万一读不出来，退化成「不知道」，绝不猜。

import { readFile } from 'node:fs/promises';

/**
 * 锁文件 importers 段里依赖名与 version 的对应关系。
 *
 * 结构长这样（缩进 6 空格的依赖名，缩进 8 空格的字段）：
 * ```yaml
 * importers:
 *   .:
 *     dependencies:
 *       dsh-ai-coding:
 *         specifier: git+https://host/repo.git#path:packages/x
 *         version: git+https://host/repo.git#bf31095...&path:packages/x
 * ```
 *
 * @param {string} text 锁文件全文。
 * @returns {Map<string, string>} 依赖名 → 解析到的版本或 spec 字符串。
 */
export function parseLockedVersions(text) {
  const locked = new Map();
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const name = /^ {6}([^\s:]+):\s*$/.exec(lines[index]);
    if (name === null) continue;
    // 作用域包名在锁文件里带引号（'@scope/pkg'），去掉引号才是包名。
    const dependency = name[1].replace(/^['"]|['"]$/g, '');
    // version 行就在依赖名下面几行内；先遇到别的字段就放弃这个依赖。
    for (let offset = index + 1; offset < Math.min(index + 5, lines.length); offset += 1) {
      const version = /^ {8}version:\s*(.+?)\s*$/.exec(lines[offset]);
      if (version !== null) {
        locked.set(dependency, version[1].replace(/^['"]|['"]$/g, ''));
        break;
      }
      if (/^ {0,6}\S/.test(lines[offset])) break;
    }
  }
  return locked;
}

/**
 * 取出锁文件里 git 依赖钉住的提交号。
 *
 * @param {string} text 锁文件全文。
 * @returns {Map<string, string>} 依赖名 → 提交号。
 */
export function parseLockedCommits(text) {
  const commits = new Map();
  for (const [name, value] of parseLockedVersions(text)) {
    const commit = /#([0-9a-f]{40})\b/i.exec(value);
    if (commit !== null) commits.set(name, commit[1]);
  }
  return commits;
}

/**
 * 读 profile 的锁文件，取出 git 依赖钉住的提交。
 *
 * 读不到、解析不出来都返回空表 —— 调用方据此把该插件标成「未知」，
 * 而不是谎报「已是最新」。
 *
 * @param {string} lockPath 锁文件路径。
 * @returns {Promise<Map<string, string>>} 依赖名 → 提交号。
 */
export async function readLockedCommits(lockPath) {
  try {
    return parseLockedCommits(await readFile(lockPath, 'utf8'));
  } catch {
    return new Map();
  }
}
