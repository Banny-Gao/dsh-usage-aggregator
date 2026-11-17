// src/host/features/expander/registry.js
//
// 原 dsh-plugin-expander/lib/registry.js —— 逐字搬过来，只多了「简写地址还原」
// 一节（SHORTHAND_HOSTS / resolveShorthand，见下）。
//
// 两个纯函数家族：版本比较，和「profile 记录的依赖 spec」的结构化。
//
// 版本比较自己写而不引 semver：这个包的依赖表是空的（离线可构建、装进 profile
// 不拖任何第三方包）。比较规则只覆盖 semver 的主干与 prerelease 先后，
// 不处理 build metadata —— 那一段不影响「谁更新」，所以忽略。

/**
 * 仓库地址的简写前缀：pnpm 允许 `github:owner/repo` 这种写法，git 不认。
 *
 * 识别与还原都用这一张表 —— 少一张表就会「认得出、还原不出」或反过来。
 */
const SHORTHAND_HOSTS = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
};

/** 简写前缀本身（带冒号）。 */
const SHORTHAND_PREFIX = /^(github|gitlab|bitbucket):/;

/** 简写后面的仓库路径：至少 owner/repo，段内不许有空白。 */
const SHORTHAND_PATH = /^[^\s/]+\/[^\s/]+(?:\/[^\s/]+)*$/;

/**
 * 把简写仓库地址还原成真实地址。
 *
 * 为什么必须还原：pnpm 认 `github:owner/repo`，git 不认 —— 直接把它喂给
 * `git ls-remote` 只会得到「仓库不存在」，git 源的插件永远拿不到远端 HEAD，
 * 于是永远停在「未知」。
 *
 * @param {string} url 去掉片段与 git+ 前缀后的地址。
 * @returns {string} 真实地址；不是简写就原样返回。
 */
function resolveShorthand(url) {
  const match = SHORTHAND_PREFIX.exec(url);
  if (match === null) return url;
  const path = url.slice(match[0].length);
  if (!SHORTHAND_PATH.test(path)) return url;
  return `https://${SHORTHAND_HOSTS[match[1]]}/${path.replace(/\.git$/, '')}.git`;
}

/**
 * 拆一个版本号：主版本、次版本、修订号、prerelease 标识符数组。
 *
 * @param {string} value 版本号字符串。
 * @returns {{core: number[], pre: string[]}|null} 拆不出就是 null。
 */
function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^v/, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(trimmed);
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  };
}

/**
 * 比较两个 prerelease 标识符：纯数字按数值比，数字小于字母，字母按字典序。
 *
 * @param {string} left 左侧标识符。
 * @param {string} right 右侧标识符。
 * @returns {number} 小于 0 / 等于 0 / 大于 0。
 */
function comparePre(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) === Number(right) ? 0 : Number(left) < Number(right) ? -1 : 1;
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * 比较两个版本号：左边更新返回正数，相等返回 0，左边更旧返回负数。
 * 拆不出 semver（写不出来的版本号）时返回 null，表示「比不了」。
 *
 * @param {string} left 左侧版本号。
 * @param {string} right 右侧版本号。
 * @returns {number|null} 比较结果。
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  // 没有 prerelease 的版本比有 prerelease 的新（1.0.0 > 1.0.0-rc.1）。
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= a.pre.length) return -1;
    if (index >= b.pre.length) return 1;
    const result = comparePre(a.pre[index], b.pre[index]);
    if (result !== 0) return result;
  }
  return 0;
}

/**
 * 远端版本是否比已装版本新。
 *
 * 只在「确实更新」时返回 true：版本相同是 false，本地版本比远端还新（pin 住的
 * 预发布版）也是 false —— 那不是更新，把它降级反而是坏事。
 *
 * @param {string} installed 已装版本。
 * @param {string} latest 远端版本。
 * @returns {boolean} 是否值得更新。
 */
export function isUpgrade(installed, latest) {
  if (typeof installed !== 'string' || typeof latest !== 'string') return false;
  const result = compareVersions(latest, installed);
  return result !== null && result > 0;
}

/**
 * 解析 profile 记录的依赖 spec，看它是从哪儿装的。
 *
 * spec 的形态由 DSH 插件管理器写进 profile 的 package.json：
 *   · 注册表版本范围 / 标签 / 别名 → `name@^1.2.3`、`name@latest`、`name@npm:real@^1`
 *   · git 地址 → `git+https://host/repo.git#path:sub`、`git+https://host/repo.git#<commit>`
 *   · git 地址的简写 → `github:owner/repo`、`gitlab:owner/repo`、`bitbucket:owner/repo`
 *   · 本地路径 → `link:/abs/path`、`file:/abs/path`
 *
 * @param {string|undefined} source profile 记录的 spec。
 * @returns {{kind: string, [key: string]: unknown}} spec 的结构化结果。
 */
export function parseDependencySource(source) {
  const raw = typeof source === 'string' ? source.trim() : '';
  if (raw === '') return { kind: 'unknown' };
  if (raw.startsWith('link:') || raw.startsWith('file:')) {
    return { kind: 'local', path: raw.slice(raw.indexOf(':') + 1) };
  }
  if (raw.includes('://') || raw.startsWith('git+') || SHORTHAND_PREFIX.test(raw)) {
    return parseGitSource(raw);
  }
  // 注册表：包名与范围之间用最后一个 @ 分开（作用域包名的 @ 在最前面，不能用第一个）。
  const at = raw.lastIndexOf('@');
  if (at > 0) {
    const name = raw.slice(0, at);
    const range = raw.slice(at + 1);
    // 别名（name@npm:real@^1）：真正要查的包名是 real，本插件暂不处理别名。
    if (range.startsWith('npm:')) return { kind: 'alias', name, target: range.slice(4) };
    return { kind: 'npm', name, range };
  }
  return { kind: 'npm', name: raw, range: undefined };
}

/**
 * 拆 git spec：仓库地址、固定提交、子目录、分支。
 *
 * fragment 的几种写法都见过：`#<40位提交>`、`#path:sub`、`#branch`、
 * `#<提交>&path:sub`。只有 40 位十六进制才算「固定提交」——那种包重装也拿不到
 * 新代码，检测时不该报「有更新」。
 *
 * 地址本身可能是简写（`github:owner/repo`）—— 片段拆完之后才还原成真实地址，
 * 否则简写里的冒号会被误当成地址的一部分。
 *
 * @param {string} raw git spec 原文。
 * @returns {{kind: string, url: string, pinned: string|null, path: string|null, ref: string|null}} 结构化结果。
 */
function parseGitSource(raw) {
  let url = raw;
  let fragment = '';
  const hash = url.indexOf('#');
  if (hash >= 0) {
    fragment = url.slice(hash + 1);
    url = url.slice(0, hash);
  }
  if (url.startsWith('git+')) url = url.slice(4);
  url = resolveShorthand(url);
  let pinned = null;
  let path = null;
  let ref = null;
  for (const part of fragment.split('&')) {
    if (part === '') continue;
    if (part.startsWith('path:')) path = part.slice('path:'.length);
    else if (/^[0-9a-f]{40}$/i.test(part)) pinned = part;
    else ref = part;
  }
  return { kind: 'git', url, pinned, path, ref };
}
