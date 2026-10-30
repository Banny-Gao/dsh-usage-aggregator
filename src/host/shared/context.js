// src/host/shared/context.js
//
// Host 半边的共享上下文：配置解析 + 路由注册助手。
//
// 三个功能共用同一份 config，但各自只读自己的那一段（config.usage /
// config.expander），互不干扰。

import { buildRoutes } from './http.js';

/** 所有插件路由的公共前缀（与客户端 src/client/shared/constants.js 必须一致）。 */
export const DEFAULT_BASE = '/dsh-usage-aggregator';

/**
 * 取某个功能自己的配置段。
 *
 * @param {object} config 整份 config。
 * @param {string} id 功能 id。
 * @returns {object} 该功能的配置（没有就用空对象）。
 */
export function featureConfig(config, id) {
  const value = config?.[id];
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

/**
 * 解析路由公共前缀。
 *
 * @param {object} config 整份 config。
 * @returns {string} 去掉尾部斜杠的前缀。
 */
export function resolveBase(config) {
  const value = config?.endpoint;
  if (typeof value === 'string' && value.trim() !== '') return value.trim().replace(/\/+$/, '');
  return DEFAULT_BASE;
}

/**
 * 造一份共享上下文。
 *
 * @param {object} config 整份 config。
 * @returns {object} 共享上下文。
 */
export function createShared(config) {
  const base = resolveBase(config);
  const allowRemote = config?.allowRemote === true;

  return {
    /** 路由公共前缀。 */
    base,
    /** 是否允许非回环地址访问。 */
    allowRemote,

    /**
     * 某个功能自己的配置段。
     *
     * @param {string} id 功能 id。
     * @returns {object} 配置。
     */
    configOf(id) {
      return featureConfig(config, id);
    },

    /**
     * 生成路由表（统一传输层语义）。
     *
     * @param {Array<{method: 'GET'|'POST', path: string, run: Function}>} specs 路由声明。
     * @param {{bodyLimit?: number}} options 选项。
     * @returns {Array<{path: string, handler: Function}>} 路由表。
     */
    routes(specs, options = {}) {
      return buildRoutes(specs, { allowRemote, ...options });
    },

    /**
     * 把路由表挂到 webServer 上。
     *
     * @param {object} host ctx.inject(['webServer']) 拿到的 scope。
     * @param {Array<{path: string, handler: Function}>} routes 路由表。
     * @returns {() => void} 注销全部路由的 disposer。
     */
    registerRoutes(host, routes) {
      const disposers = routes.map((route) =>
        host.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
      );
      return () => {
        for (const dispose of disposers) dispose();
      };
    },
  };
}
