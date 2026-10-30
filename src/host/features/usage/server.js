// src/host/features/usage/server.js
//
// 浏览器侧的唯一入口：同源 HTTP 路由。
//
// 为什么用路由而不是 Remote（typert/@Remote）：客户端 bundle 与 Host 是两套独立
// 加载的代码，路由是最小的跨半边契约 —— 一半是 path，一半是 fetch，没有类型
// 生成、没有协议升级要跟。dsh-token-use 用的也是这条路。
//
// 传输层（限流、JSON 解析、状态码语义、同源校验）已经抽到共享实现
// （src/host/shared/http.js），三个功能共用同一份语义；这里只负责**这一段路径**
// 与**这一组操作**的对应关系。
//
// ⚠️ 路由路径必须**全局唯一**：dsh-host-webserver 的 register() 以 (kind, path)
// 为键，重复注册会直接 throw —— 那会让插件 entry 加载失败，整页报
// "Failed to load plugins"。所以用量查询挂在公共前缀下的 /usage 段里。

import { BODY_LIMIT_WITH_IMAGE } from '../../shared/http.js';

/** 该功能在公共前缀下的那一段（/dsh-usage-aggregator/usage）。 */
export const ROUTE_PREFIX = 'usage';

/**
 * 生成路由表。
 *
 * 语义与迁移前完全一致：
 *   · GET  一律 200（即便返回体里 ok===false，客户端自己判断）；
 *   · POST 返回体 ok===false 时给 400，否则 200；
 *   · 处理器抛异常一律 500 {ok:false,error}。
 *
 * 共享实现额外加了两道闸（原先只有插件更新那边有）：
 *   · 同源校验 —— 跨站 POST 不带 Origin 校验的话，本机就会替它装插件；
 *   · POST 必须 application/json —— 带 JSON 的跨站请求会先走 CORS 预检，
 *     我们不回 CORS 头，预检就失败。
 * 客户端一直是同源 + JSON 请求，所以不受影响。
 *
 * @param {{ops: object, shared: object}} options ops = 操作层；shared = 共享上下文。
 * @returns {Array<{path: string, handler: (req: object, res: object) => Promise<void>}>} 路由表。
 */
export function createRoutes(options) {
  const ops = options.ops;
  const shared = options.shared;
  const base = `${shared.base}/${ROUTE_PREFIX}`;

  return shared.routes([
    { method: 'GET', path: base, run: () => ops.state() },
    { method: 'POST', path: `${base}/import`, run: (body) => ops.import({ text: body.text, image: body.image, label: body.label, replaceId: body.replaceId }) },
    { method: 'POST', path: `${base}/refresh`, run: (body) => ops.refresh(String(body.id ?? '')) },
    // interactive=true 会弹出一个真实的浏览器窗口让人扫码授权 —— 所以它是**同步阻塞**的
    // （授权可能要等一两分钟）。面板按钮因此必须先置灰，不能并发点第二次。
    { method: 'POST', path: `${base}/renew`, run: (body) => ops.renew(String(body.id ?? ''), { interactive: body.interactive === true }) },
    { method: 'POST', path: `${base}/reanalyze`, run: (body) => ops.reanalyze(String(body.id ?? ''), { image: body.image }) },
    { method: 'POST', path: `${base}/remove`, run: (body) => ops.remove(String(body.id ?? '')) },
    { method: 'POST', path: `${base}/order`, run: (body) => ops.setFieldOrder(String(body.id ?? ''), body.paths) },
    { method: 'GET', path: `${base}/models`, run: () => ops.listAnalysisModels() },
    { method: 'POST', path: `${base}/analysis-model`, run: (body) => ops.setAnalysisModel(String(body.provider ?? ''), String(body.model ?? '')) },
    { method: 'POST', path: `${base}/chip`, run: (body) => ops.setChipProvider(String(body.id ?? '')) },
    { method: 'GET', path: `${base}/raw`, run: (req) => { const url = new URL(req.url ?? '/', 'http://localhost'); return ops.raw(url.searchParams.get('id') ?? ''); } },
  ], {
    // 12MB：要传截图（base64）。
    bodyLimit: BODY_LIMIT_WITH_IMAGE,
  });
}
