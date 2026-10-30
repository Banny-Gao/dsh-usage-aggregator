// src/host/features/boost/tool.js
//
// Agent 入口：system_boost 工具。
//
// 与面板共用同一份 ops —— 工具不是第二套逻辑，只是第二个调用者：
//   scan    体检：读磁盘 / 内存 / 进程，发现这台机器上可清理的缓存条目并给诊断
//   execute 执行用户勾选的条目
//
// execute 会动用户的磁盘（删缓存），所以和插件更新一样要求 danger-full-access：
// 没有沙箱策略的纯 CLI 组合不做限制（那里也没有会话、没有沙箱这回事）。

/**
 * 构造工具定义。
 *
 * @param {object} ops 操作层。
 * @param {{assertPrivileged?: (exec: object) => void}} guards 权限检查。
 * @returns {object} ToolDefinition
 */
export function createBoostTool(ops, guards = {}) {
  const assertPrivileged = guards.assertPrivileged ?? (() => {});
  return {
    name: 'system_boost',
    description: [
      '体检并清理这台电脑上的过期缓存。',
      'scan 读磁盘、内存、交换分区、负载与占资源的进程，并在**当前这台机器上**发现',
      '装了哪些包管理器、各自的缓存在哪、有多大，给出「为什么慢」的诊断和清理建议；',
      'execute 执行用户勾选的条目（items 传条目 id），每一条都是该工具官方的清理命令；',
      '正在被运行中的进程占用的目录会自动跳过，不会打断正在跑的程序。',
      '执行前先用一两句说明将要做什么，执行后如实报告每一项的结果。',
      '不要向用户索要密码、API Key 或验证码。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['scan', 'execute'],
          description: 'scan = 体检（只读）；execute = 执行清理。',
        },
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'execute 时要清理的条目 id（先用 scan 看 id）。留空表示没有要执行的项。',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
          error: { type: 'string' },
          items: { type: 'array', items: { type: 'object' } },
        },
      },
      render(_args, value) {
        const payload = value !== null && typeof value === 'object' ? value : {};
        if (payload.ok === false) return [{ type: 'text', text: `加速清理失败：${payload.error ?? '未知原因'}` }];
        return [{ type: 'text', text: typeof payload.text === 'string' ? payload.text : JSON.stringify(payload, null, 2) }];
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {};
      const action = typeof input.action === 'string' ? input.action : '';
      try {
        if (action === 'scan') {
          const job = ops.scan({ force: true });
          const analysis = job.analysis;
          const lines = [];
          if (analysis !== null && analysis !== undefined) {
            lines.push(`诊断：${analysis.diagnosis}`);
            for (const finding of analysis.findings ?? []) lines.push(`- ${finding}`);
            for (const warning of analysis.warnings ?? []) lines.push(`! ${warning}`);
          }
          const items = Array.isArray(job.items) ? job.items : [];
          if (items.length === 0) {
            lines.push('没有发现可清理的缓存条目。');
          } else {
            lines.push('可清理的条目：');
            for (const item of items) {
              const mb = Math.round((item.sizeBytes ?? 0) / 1024 / 1024);
              lines.push(`- [${item.id}] ${item.label}：${mb} MB · ${item.semantics === 'prune' ? '只删没人引用的' : '整个清空'} · ${item.commandText}`);
            }
          }
          return { ok: true, text: lines.join('\n'), items };
        }
        if (action === 'execute') {
          assertPrivileged(exec);
          const items = Array.isArray(input.items)
            ? input.items.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
            : [];
          if (items.length === 0) return { ok: false, error: '没有指定要清理的条目（先用 scan 看 id）' };
          const outcome = await ops.execute(items);
          const results = Array.isArray(outcome.results) ? outcome.results : [];
          const lines = results.map((item) => {
            const state = item.ok === true ? '已完成' : item.skipped === true ? '已跳过' : '失败';
            const reclaimed = item.reclaimedBytes > 0 ? `，回收约 ${Math.round(item.reclaimedBytes / 1024 / 1024)} MB` : '';
            return `- ${item.label}（${item.id}）：${state}${reclaimed}${item.reason ? ` — ${item.reason}` : ''}`;
          });
          const text = `清理完成：\n${lines.join('\n')}`;
          return { ok: outcome.ok === true, text, items: results };
        }
        return { ok: false, error: `不认识的 action：${action}` };
      } catch (error) {
        return { ok: false, error: `${error?.message ?? String(error)}` };
      }
    },
  };
}
