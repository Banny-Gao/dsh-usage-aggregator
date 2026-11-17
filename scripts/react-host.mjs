// scripts/react-host.mjs
//
// 找到一份可用的 react / react-dom（**同一版本**），供离线渲染自检使用。
//
// 为什么单独抽出来：四个离线渲染自检（ui-check / ui-check-boost /
// ui-check-expander / ui-check-autocomplete）都要用它，而「react 装在哪」
// 这件事各平台、各安装方式都不一样：
//   · pnpm store 的位置跟平台与 pnpm 版本走（macOS 是 ~/Library/pnpm/store/v11、
//     Linux 是 ~/.pnpm-store/v3、Windows 是 %LOCALAPPDATA%\pnpm\store\v10）；
//   · pnpm 10 起 store 里不再有 links 目录，按 store 布局找包这条路在
//     新版 pnpm 上本来就断了；
//   · DSH 自己的 profile 里带着 react —— 客户端跑的就是它；
//   · 本仓库的 node_modules 里也可能装了一份。
//
// 原来四个脚本各自写死 macOS 与 Linux 两条路径，在 Windows 上一个都找不到 →
// 自检以「找不到 react」直接退出，等于在 Windows 上没法验渲染。
//
// 查找顺序：DUA_UI_REACT_DIR 指定的目录 → 本仓库的 node_modules →
// DSH 的 profile → pnpm store 的 links 布局（老 pnpm）。
//
// 用法：const { React, ReactDOMServer, version } = await loadReact();

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 默认对齐生产：DSH 客户端的 react 是 18.x（dsh-client-ui-* 的 peer 是 ^18.2.0）。 */
const DEFAULT_VERSION = '18.3.1';

/**
 * 读一个包目录里的版本号。
 *
 * @param {string} dir 包目录。
 * @returns {string|null} 版本号；读不到就是 null。
 */
function versionOf(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * 一组候选的 node_modules 根目录。
 *
 * @returns {string[]} 根目录列表。
 */
function nodeModulesRoots() {
  const home = homedir();
  const roots = [];
  const override = process.env.DUA_UI_REACT_DIR;
  if (typeof override === 'string' && override !== '') roots.push(override);
  roots.push(join(REPO_DIR, 'node_modules'));
  // DSH 的 profile 里带着客户端用的 react。
  const profiles = join(home, '.dsh', 'profiles');
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles).sort()) {
      roots.push(join(profiles, name, 'node_modules'));
    }
  }
  return roots;
}

/**
 * 按老 pnpm 的 store 布局找包（links/@<name>/<版本>/<hash>/node_modules/<name>）。
 *
 * @param {string} name 包名。
 * @param {string} [wanted] 想要的版本。
 * @returns {{dir: string, version: string}|null} 包目录与版本。
 */
function findInStore(name, wanted) {
  const home = homedir();
  const roots = [
    join(home, 'Library/pnpm/store/v11/links/@', name),
    join(home, '.pnpm-store/v3/links/@', name),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const versions = (wanted === undefined ? readdirSync(root).sort().reverse() : [wanted])
      .filter((version) => existsSync(join(root, version)));
    for (const version of versions) {
      const base = join(root, version);
      for (const hash of readdirSync(base)) {
        const pkgDir = join(base, hash, 'node_modules', name);
        if (existsSync(join(pkgDir, 'package.json'))) return { dir: pkgDir, version };
      }
    }
  }
  return null;
}

/**
 * 找一个包（先看 node_modules 目录，再看 pnpm store 的 links 布局）。
 *
 * @param {string} name 包名。
 * @param {string} [wanted] 想要的版本。
 * @returns {{dir: string, version: string}|null} 包目录与版本。
 */
export function findPackage(name, wanted) {
  for (const root of nodeModulesRoots()) {
    const dir = join(root, name);
    if (!existsSync(join(dir, 'package.json'))) continue;
    const version = versionOf(dir);
    if (version === null) continue;
    if (wanted !== undefined && version !== wanted) continue;
    return { dir, version };
  }
  return findInStore(name, wanted);
}

/**
 * 载入 react 与 react-dom。
 *
 * react 与 react-dom 必须**同版本**：跨版本混用会在渲染时报
 * 「Objects are not valid as a React child」这种指错方向的错。
 *
 * @param {{versionEnv?: string}} options versionEnv 是指定版本的环境变量名。
 * @returns {Promise<{React: object, ReactDOMServer: object, version: string}>} 载入结果。
 */
export async function loadReact(options = {}) {
  const versionEnv = options.versionEnv ?? 'DUA_UI_REACT_VERSION';
  const wanted = process.env[versionEnv] ?? DEFAULT_VERSION;
  const react = findPackage('react', wanted) ?? findPackage('react');
  if (react === null) {
    console.error('✗ 本机找不到 react —— 这个自检需要它。');
    console.error('  找法（按顺序）：');
    console.error('    · DSH 自己的 profile 里通常有一份（~/.dsh/profiles/*/node_modules/react）；');
    console.error('    · 或者用 DUA_UI_REACT_DIR 指定一个装着 react 与 react-dom 的 node_modules 目录；');
    console.error('    · 或者在本仓库里装：pnpm add -D react@18.3.1 react-dom@18.3.1');
    process.exit(1);
  }
  const reactDom = findPackage('react-dom', react.version);
  if (reactDom === null) {
    console.error(`✗ 本机找不到与 react ${react.version} 同版本的 react-dom —— 版本必须一致。`);
    console.error('  用 DUA_UI_REACT_DIR 指定一份装着两个包的 node_modules 目录。');
    process.exit(1);
  }
  const React = await import(pathToFileURL(join(react.dir, 'index.js')).href);
  const serverEntry = existsSync(join(reactDom.dir, 'server.node.js')) ? 'server.node.js' : 'server.js';
  const ReactDOMServer = await import(pathToFileURL(join(reactDom.dir, serverEntry)).href);
  return {
    React: React.default ?? React,
    ReactDOMServer: ReactDOMServer.default ?? ReactDOMServer,
    version: react.version,
  };
}
