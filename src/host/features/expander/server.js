// src/host/features/expander/server.js
//
// 浏览器侧的唯一入口：同源 HTTP 路由的**声明层**。
//
// 为什么用路由而不是 Remote（typert/@Remote）：客户端 bundle 与 Host 是两套独立
// 加载的代码，路由是最小的跨半边契约 —— 一半是 path，一半是 fetch，没有类型
// 生成、没有协议升级要跟。dsh-usage-query 与 dsh-token-use 用的也是这条路。
//
// ⚠️ 与迁移前唯一的结构差别：
//   原 dsh-plugin-expander/lib/server.js 自己带了一整套传输层（回环校验、同源
//   校验、JSON 校验、请求体上限、状态码语义）。聚合之后这层搬到了共享内核
//   src/host/shared/http.js 的 buildRoutes —— 与用量查询共用同一份实现。
//   语义与原实现等价：
//     · GET  一律 200（即便返回体里 ok===false，客户端自己判断）；
//     · POST 返回体 ok===false 时给 400，否则 200；
//     · 处理器抛异常一律 500 {ok:false,error}；
//     · 只接受回环地址（除非 allowRemote 打开）、只接受同源、POST 必须是
//       application/json —— 这三道闸门原实现本来就有，行为不变。
//   本文件因此只保留「本功能有哪几条路由、各自跑什么」。

/**
 * 生成路由声明表。
 *
 * @param {{state: Function, updatableNames: Function, startUpdate: Function}} ops 操作层。
 * @param {string} base 本功能的路由前缀（shared.base + '/expander'）。
 * @returns {Array<{method: 'GET'|'POST', path: string, run: Function}>} 路由声明。
 */
export function createRouteSpecs(ops, base) {
  const prefix = typeof base === 'string' ? base.replace(/\/+$/, '') : '';

  // 当前状态（已装插件 + 有没有新版本 + 上一次更新任务的结果）。
  // ?refresh=1 时强制重查注册表，不带就是 60 秒缓存。
  const state = (req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    return ops.state({ refresh: url.searchParams.get('refresh') === '1' });
  };

  // 启动一次更新：names 是要更新的插件包名；all 为真表示「所有可更新的都更新」。
  const update = async (body) => {
    const names = Array.isArray(body.names)
      ? body.names.filter((name) => typeof name === 'string' && name.trim() !== '').map((name) => name.trim())
      : [];
    if (body.all === true) {
      // updatableNames() 已经排除了正在运行的插件自己（自我保护 ①），
      // 也天然排除了已退役的包（它们根本不在清单里）。
      const updatable = await ops.updatableNames();
      return ops.startUpdate(updatable);
    }
    if (names.length === 0) return { ok: false, error: '没有指定要更新的插件' };
    return ops.startUpdate(names);
  };

  return [
    // GET <base>/state —— 插件清单（?refresh=1 可选）。
    //
    // 路径与原 dsh-plugin-expander 完全一致（原来就是 <base>/state，
    // 不是裸 <base>）—— 客户端那边也是按 ENDPOINT + '/state' 拼的。
    { method: 'GET', path: `${prefix}/state`, run: state },
    // POST <base>/update —— 启动更新。
    { method: 'POST', path: `${prefix}/update`, run: update },
  ];
}
