// src/host/features/expander/tool.js
//
// 原 dsh-plugin-expander/lib/tool.js —— 逐字搬过来，逻辑一行未改
// （只有这几行注释里的路径名换成了新位置）。
//
// Agent 工具：让「更新插件」也能在对话里完成。
//
// 与面板同一份实现（./ops.js）—— 工具不是第二套逻辑，只是第二个调用者：
//   · check  查哪些插件有新版（不改动任何东西）
//   · update 更新指定的插件，或更新全部可更新的插件
//
// 参数的 schema 直接写成 JSON Schema（而不是经 defineTool 的那种紧凑写法）：
// 这个插件是纯 JS、不依赖 dsh 的内部包，少一个解析约定就少一处版本耦合。

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['check', 'update'],
      description: 'check = 查哪些已装插件有新版本（只读）；update = 更新插件。',
    },
    names: {
      type: 'array',
      items: { type: 'string' },
      description: 'update 时要更新的插件包名（先用 check 看包名）。留空且 all=true 表示更新全部可更新的插件。',
    },
    all: {
      type: 'boolean',
      description: 'update 时为 true 表示更新全部检测到新版本的插件。',
    },
  },
  required: ['action'],
};

/**
 * 构造工具定义。
 *
 * @param {object} ops lib/ops.js 的操作层。
 * @param {{assertPrivileged?: (exec: object) => void}} guards 改动 profile 之前的权限检查。
 * @returns {object} ToolDefinition
 */
export function createUpdaterTool(ops, guards = {}) {
  const assertPrivileged = guards.assertPrivileged ?? (() => {});
  return {
    name: 'plugin_update',
    description: [
      '检测并更新当前 profile 已安装的插件。',
      'check 列出每个已装插件的已装版本、远端最新版本和有没有更新（npm 包查注册表，git 包比远端 HEAD）；',
      'update 更新指定插件，或用 all=true 更新全部有更新的插件。',
      '更新走 DSH 官方插件管理器的卸载 + 安装两步，影响使用该 profile 的全部会话；',
      '结果里带 application 字段，restart-required 表示要重启 DSH 才生效。',
      '不要向用户索要密码、API Key 或验证码。',
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
          packages: { type: 'array', items: { type: 'object' } },
        },
      },
      render(_args, value) {
        const payload = value !== null && typeof value === 'object' ? value : {};
        if (payload.ok === false) return [{ type: 'text', text: `插件更新失败：${payload.error ?? '未知原因'}` }];
        return [{ type: 'text', text: typeof payload.text === 'string' ? payload.text : JSON.stringify(payload, null, 2) }];
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {};
      const action = typeof input.action === 'string' ? input.action : '';
      try {
        if (action === 'check') {
          const state = await ops.state({ refresh: true });
          const packages = Array.isArray(state.packages) ? state.packages : [];
          const updatable = packages.filter((item) => item.updatable === true);
          const lines = packages.map((item) => {
            const latest = item.latest === null || item.latest === undefined ? '' : ` → ${item.latest}`;
            const mark = item.updatable === true ? '有更新' : item.status;
            return `- ${item.name}（${item.version ?? '未知版本'}${latest}）· ${mark}`;
          });
          const text = updatable.length === 0
            ? `没有可更新的插件。已检查 ${String(packages.length)} 个：\n${lines.join('\n')}`
            : `有 ${String(updatable.length)} 个插件可更新：\n${lines.join('\n')}`;
          return { ok: true, text, packages };
        }
        if (action === 'update') {
          assertPrivileged(exec);
          const names = Array.isArray(input.names)
            ? input.names.filter((name) => typeof name === 'string' && name.trim() !== '').map((name) => name.trim())
            : [];
          const targets = input.all === true ? await ops.updatableNames() : names;
          if (targets.length === 0) return { ok: false, error: '没有指定要更新的插件（先用 check 看包名，或用 all=true）' };
          const results = await ops.updateNow(targets);
          const failures = results.filter((item) => item.ok !== true);
          const lines = results.map((item) => {
            const state = item.ok === true ? `已更新（${item.application ?? 'applied'}）` : `失败：${item.error ?? '未知原因'}`;
            return `- ${item.name}：${state}`;
          });
          const text = failures.length === 0
            ? `已更新 ${String(results.length)} 个插件：\n${lines.join('\n')}`
            : `更新完成，${String(failures.length)} 个失败：\n${lines.join('\n')}`;
          return { ok: failures.length === 0, text, packages: results };
        }
        return { ok: false, error: `不认识的 action：${action}` };
      } catch (error) {
        return { ok: false, error: `${error?.message ?? String(error)}` };
      }
    },
  };
}
