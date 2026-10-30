// src/host/features/boost/server.js
//
// 浏览器侧入口：同源 HTTP 路由的声明层。
//
// 四条路由：
//   GET  <base>/scan            —— 启动/复用一次体检，返回当前任务快照
//   GET  <base>/status          —— 体检任务当前状态（客户端轮询用）
//   POST <base>/execute         —— 执行用户勾选的条目（起后台任务，立刻返回任务号）
//   GET  <base>/execute-status  —— 执行任务当前状态（跑到第几项了）
//
// 两个都是**后台任务**：量一个 17 GB 的 pnpm store 要十几秒，清一批缓存要好几分钟，
// 同步返回的话浏览器只能干等。所以都是「立刻返回任务号 + 客户端轮询」。

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
  // 起的是后台任务：清一批缓存要好几分钟，同步返回浏览器只能干等。
  const execute = async (body) => {
    const items = Array.isArray(body.items)
      ? body.items.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
      : [];
    if (items.length === 0) return { ok: false, error: '没有勾选任何项目' };
    return ops.executeAsync(items);
  };

  // 执行任务的当前状态：跑到第几项、这一项在做什么、回收了多少。
  const executeStatus = () => ops.executeStatus() ?? {
    id: '',
    running: false,
    startedAt: 0,
    finishedAt: 0,
    total: 0,
    done: 0,
    currentLabel: '',
    items: [],
    results: [],
    reclaimedBytes: 0,
    error: '',
  };

  return [
    { method: 'GET', path: `${prefix}/scan`, run: scan },
    { method: 'GET', path: `${prefix}/status`, run: status },
    { method: 'POST', path: `${prefix}/execute`, run: execute },
    { method: 'GET', path: `${prefix}/execute-status`, run: executeStatus },
  ];
}
