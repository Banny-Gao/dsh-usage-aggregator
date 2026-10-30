// src/host/features/usage/tool.js
//
// Agent 工具：让「用量查询」也能在对话里被调用。
//
// 与面板同一份实现（ops.js）—— 工具不是第二套逻辑，只是第二个调用者：
//   · list    列出现有接口与最近一次结果
//   · refresh 重新打一次接口（凭证过期时也会在这里报出来）
//   · import  用一段粘贴的请求文本接入新接口
//   · remove  移除
//
// 参数的 schema 直接写成 JSON Schema（而不是经 defineTool 的那种紧凑写法）：
// 这个插件是纯 JS、不依赖 dsh 的内部包，少一个解析约定就少一处版本耦合。

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'refresh', 'renew', 'import', 'remove'],
      description: 'list = 列出现有接口与最近结果；refresh = 重新查询某个接口；renew = 登录态过期时自动续期（支持的站点会自己换一枚新 token，不用用户再粘贴）；import = 用粘贴的请求文本接入新接口；remove = 移除某个接口。',
    },
    id: {
      type: 'string',
      description: '接口 id（refresh / renew / remove 必填）。',
    },
    interactive: {
      type: 'boolean',
      description: 'renew 时是否允许弹出浏览器窗口让用户扫码授权。静默续期失败后再用 true 重试一次；首次使用需要 true。',
    },
    request: {
      type: 'string',
      description: 'import 时粘贴的接口请求原文（DevTools → Copy as cURL 的整段内容）。',
    },
    label: {
      type: 'string',
      description: '可选：给这个接口起的名字。',
    },
  },
  required: ['action'],
};

/**
 * 构造工具定义。
 *
 * @param {object} ops ops.js 的操作层。
 * @returns {object} ToolDefinition
 */
export function createUsageTool(ops) {
  return {
    name: 'usage_query',
    description: [
      '查询已接入的第三方用量接口（额度 / 余量 / 次数 / 账单）。',
      '首次接入需要用户粘贴一次接口请求（浏览器 DevTools → Copy as cURL），之后每次查询复用保存的请求，不再需要用户重贴；',
      '凭证过期时先用 action=renew 尝试自动续期（支持的站点会自己换一枚新 token，不需要用户重新粘贴）；',
      '续期也不支持时才请用户重新粘贴请求。不要向用户索要密码、API Key 或验证码，也不要自己编造用量数字。',
    ].join(''),
    parameters: PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        const payload = value !== null && typeof value === 'object' ? value : {};
        if (payload.ok === false) return [{ type: 'text', text: `用量查询失败：${payload.error ?? '未知原因'}` }];
        return [{ type: 'text', text: typeof payload.text === 'string' ? payload.text : JSON.stringify(payload, null, 2) }];
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const input = args !== null && typeof args === 'object' ? args : {};
      const action = typeof input.action === 'string' ? input.action : '';
      const id = typeof input.id === 'string' ? input.id.trim() : '';
      try {
        if (action === 'list') {
          const summary = await ops.summary();
          return { ok: true, text: summary.text, providers: (await ops.state()).providers.map((item) => ({ id: item.id, label: item.label, status: item.status })) };
        }
        if (action === 'refresh') {
          if (id === '') return { ok: false, error: 'refresh 需要 id（先用 action=list 看有哪些接口）' };
          const result = await ops.refresh(id);
          if (!result.ok) return { ok: false, error: result.error ?? result.message ?? '刷新失败' };
          const summary = await ops.summary();
          return { ok: true, text: summary.text, status: result.status };
        }
        if (action === 'renew') {
          if (id === '') return { ok: false, error: 'renew 需要 id（先用 action=list 看有哪些接口）' };
          // 先静默：绝大多数情况下这就能换到新 token，不必打扰用户。
          let result = await ops.renew(id, { interactive: false });
          // 静默失败且明确说「需要人工授权」时，才升级成交互（会弹出浏览器窗口）。
          if (result.ok !== true && result.needsInteraction === true && input.interactive !== false) {
            result = await ops.renew(id, { interactive: true });
          }
          if (!result.ok) return { ok: false, error: result.error ?? '续期失败' };
          const summary = await ops.summary();
          return { ok: true, text: `已自动续期（${result.message ?? '完成'}）。\n${summary.text}`, status: result.status };
        }
        if (action === 'import') {
          const text = typeof input.request === 'string' ? input.request : '';
          if (text.trim() === '') return { ok: false, error: 'import 需要把用户粘贴的请求原文放进 request 字段' };
          const result = await ops.import({ text, label: input.label });
          if (!result.ok) return { ok: false, error: result.error };
          const provider = result.provider;
          const summary = await ops.summary();
          return {
            ok: true,
            text: `已接入「${provider.label}」（id=${provider.id}，状态=${provider.status}）。\n${result.warning === undefined ? '' : `注意：${result.warning}\n`}${summary.text}`,
            provider: { id: provider.id, label: provider.label, status: provider.status },
          };
        }
        if (action === 'remove') {
          if (id === '') return { ok: false, error: 'remove 需要 id' };
          const result = await ops.remove(id);
          if (!result.ok) return { ok: false, error: result.error };
          return { ok: true, text: `已移除 ${result.removed}` };
        }
        return { ok: false, error: `不认识的 action：${action}` };
      } catch (error) {
        return { ok: false, error: `${error?.message ?? String(error)}` };
      }
    },
  };
}
