// src/host/features/autocomplete/store.js
//
// 自动补全的用户偏好：落盘与读回。
//
// 落在 $DSH_HOME/dsh-usage-aggregator/autocomplete.json（目录 0700 / 文件 0600）。
//
// 为什么不进 profile 的 config（cordis.patch.yml）：改推荐条数、换分析模型是
// **运行时**的事（用户在设置页里改），而 config 是启动期只读的。
// 为什么不进 localStorage：模型名与阈值是这台机器上的偏好，换台机器就该重来，
// 而且浏览器本地存的东西没有备份 —— 放 Host 侧还能被别的入口读到。

import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 落盘文件名。 */
export const STORE_FILE = 'autocomplete.json';

/**
 * 解析 $DSH_HOME：与 dsh 自身一致，env 优先，其次 ~/.dsh。
 *
 * @param {object} [env] 环境变量。
 * @returns {string} $DSH_HOME 路径。
 */
export function resolveDshHome(env = process.env) {
  const explicit = env.DSH_HOME;
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
  return join(homedir(), '.dsh');
}

/**
 * 插件自己的数据目录。
 *
 * @param {object} [env] 环境变量。
 * @returns {string} 目录路径。
 */
export function dataDir(env = process.env) {
  return join(resolveDshHome(env), 'dsh-usage-aggregator');
}

/**
 * 读取落盘的用户偏好。
 *
 * 文件缺失 / 损坏都退回空对象（宁可回到默认值，也不要启动失败）。
 *
 * @param {object} [env] 环境变量。
 * @returns {Promise<object>} 原始偏好（未归一化）。
 */
export async function readOverrides(env = process.env) {
  const file = join(dataDir(env), STORE_FILE);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(`autocomplete.json 解析失败（${file}）：${error.message}`);
  }
}

/**
 * 原子写：先写临时文件再 rename，避免半截文件。
 *
 * @param {object} overrides 用户偏好。
 * @param {object} [env] 环境变量。
 * @returns {Promise<string>} 落盘路径。
 */
export async function writeOverrides(overrides, env = process.env) {
  const dir = dataDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, STORE_FILE);
  const tmp = join(dir, `.autocomplete.${process.pid}.${Date.now()}.json`);
  const payload = JSON.stringify(overrides ?? {}, null, 2);
  await writeFile(tmp, `${payload}\n`, { mode: 0o600 });
  await rename(tmp, file);
  try {
    await chmod(file, 0o600);
  } catch {
    // 某些文件系统不支持 chmod（例如挂载卷）；写失败不该拖垮保存。
  }
  return file;
}
