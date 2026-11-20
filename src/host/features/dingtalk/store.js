// src/host/features/dingtalk/store.js
//
// 「钉钉沙发」的用户偏好落盘：功能开关与轮询间隔。
//
// 落在 $DSH_HOME/dsh-usage-aggregator/dingtalk.json（目录 0700 / 文件 0600）。
//
// 为什么不进 profile 的 config：开关是**运行时**的事（用户在设置页里改），
// config 是启动期只读的；为什么不进 localStorage：这是这台机器上的选择，
// 换台机器就该重来，而且浏览器本地存的东西没有备份。

import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 落盘文件名。 */
export const STORE_FILE = 'dingtalk.json';

/** 轮询间隔的默认值与上下限（秒）。 */
export const DEFAULT_INTERVAL_SECONDS = 180;
export const MIN_INTERVAL_SECONDS = 60;
export const MAX_INTERVAL_SECONDS = 3600;

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
 * 归一化偏好。
 *
 * @param {unknown} raw 原始偏好。
 * @returns {{enabled: boolean, pollIntervalSeconds: number}} 归一化结果。
 */
export function normalize(raw) {
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let interval = Number(value.pollIntervalSeconds);
  if (!Number.isFinite(interval)) interval = DEFAULT_INTERVAL_SECONDS;
  interval = Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, Math.round(interval)));
  return {
    enabled: value.enabled === true,
    pollIntervalSeconds: interval,
  };
}

/**
 * 读落盘的用户偏好（原始的，没归一化）。
 *
 * 文件不存在返回 null（表示「用户还没设过」，上层可以退回配置里的默认值）；
 * 文件损坏则抛错 —— 宁可报错也不要静默吞掉用户的设置。
 *
 * @param {object} [env] 环境变量。
 * @returns {Promise<object|null>} 原始偏好。
 */
export async function readStored(env = process.env) {
  const file = join(dataDir(env), STORE_FILE);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(`dingtalk.json 解析失败（${file}）：${error.message}`);
  }
}

/**
 * 读取落盘的用户偏好。
 *
 * 文件缺失 / 损坏都退回默认（宁可回到默认值，也不要启动失败）。
 *
 * @param {object} [env] 环境变量。
 * @returns {Promise<{enabled: boolean, pollIntervalSeconds: number}>} 偏好。
 */
export async function readPreferences(env = process.env) {
  try {
    return normalize(await readStored(env));
  } catch {
    return normalize({});
  }
}

/**
 * 原子写：先写临时文件再 rename，避免半截文件。
 *
 * @param {object} preferences 用户偏好。
 * @param {object} [env] 环境变量。
 * @returns {Promise<string>} 落盘路径。
 */
export async function writePreferences(preferences, env = process.env) {
  const dir = dataDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, STORE_FILE);
  const tmp = join(dir, `.dingtalk.${process.pid}.${Date.now()}.json`);
  const payload = JSON.stringify(normalize(preferences), null, 2);
  await writeFile(tmp, `${payload}\n`, { mode: 0o600 });
  await rename(tmp, file);
  try {
    await chmod(file, 0o600);
  } catch {
    // 某些文件系统不支持 chmod（例如挂载卷）；写失败不该拖垮保存。
  }
  return file;
}
