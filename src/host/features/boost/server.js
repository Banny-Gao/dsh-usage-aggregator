// src/host/features/boost/server.js
//
// 浏览器侧入口：同源 HTTP 路由的声明层。
//
// 三条路由：
//   GET  <base>/scan     —— 启动/复用一次体检，返回当前任务快照
//   GET  <base>/status   —— 任务当前状态（客户端轮询用）
//   POST <base>/execute  —— 执行用户勾选的条目
//
// 体检是**后台任务**：量一个 17 GB 的 pnpm store 要十几秒，所以不可能同步返回。
// 客户端拿到任务快照后轮询 /status，条目会一个一个冒出来。

/**
 * 生成路由声明表。
 *
 * @param {{scan: Function, status: Function, execute: Function}} ops 操作层。
 * @param {string} base 本功能的路由前缀（shared.base + '/boost'）。
 * @returns {Array<{method: 'GET'|'POST', path: string, run: Function}>} 路由声明。
 */
export function createRouteSpecs(ops, base) {
  const prefix = typeof base === 'string' ? base.replace(/\/+$/, '') : '';

  // 启动或复用一次体检。?refresh=1 时强制重查，否则用五分钟内的缓存。
  const scan = (req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    return ops.scan({ force: url.searchParams.get('refresh') === '1' });
  };

  const status = () => ops.status() ?? { id: '', running: false, startedAt: 0, finishedAt: 0, facts: null, items: [], analysis: null, error: '' };

  // 执行用户勾选的条目。ids 只接受已知条目，其余会被跳过并如实报告。
  const execute = async (body) => {
    const items = Array.isArray(body.items)
      ? body.items.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
      : [];
    if (items.length === 0) return { ok: false, error: '没有勾选任何项目' };
    return ops.execute(items);
  };

  return [
    { method: 'GET', path: `${prefix}/scan`, run: scan },
    { method: 'GET', path: `${prefix}/status`, run: status },
    { method: 'POST', path: `${prefix}/execute`, run: execute },
  ];
}
