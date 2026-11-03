// src/host/shared/llm.js
//
// 共享内核：调模型并把正文收回来。
//
// 为什么在共享内核里：用量查询要它做「响应 → 展示模板」，加速清理要它做
// 「机器事实 → 诊断」。收文本这件事只有一份实现 —— 模型的流有多种到达方式
// （逐字 delta、整块 block-end、只出思维链），每种都要兜一遍，兜法写在两处
// 就会漂移。
//
// 调用方自己给 system 提示词：不同用途要的约束完全不同，共享内核不该替它们决定。

/** 没有给 system 时的兜底提示词：只要求「把结果给我，别客套」。 */
const DEFAULT_SYSTEM_PROMPT = [
  '你是一个只输出结果的助手。',
  '不要写开场白、解释、寒暄或结语。',
].join('\n');

/**
 * 收集一次模型调用的完整文本输出，并做三层兜底。
 *
 * 为什么要兜：这个模型偶尔会「只出思维链不出正文」，或者整段回答只以
 * `block-end` 的形式到达（而非逐字 `text-delta`）。表现都是「空文本」，
 * 但一次空手而归还把整次接入降级成兜底，代价太大。三层依次是：
 *   1. 优先用 text-delta 拼接；没有 delta 就取 block-end 里的 text 块；
 *   2. 两者都没有但有 reasoning 内容时，直接从思维链里抠 JSON（抠出来仍要过校验）；
 *   3. 还不行就重试一次（同样的请求），只在第二次仍为空时抛错。
 *
 * @param {object} llm Host 的 llm 服务。
 * @param {{provider: string, model: string, system?: string, messages: unknown[], maxTokens?: number, signal?: AbortSignal}} options
 * @returns {Promise<string>} 模型输出的文本（可能是从思维链里抠出来的 JSON）。
 */
export async function callModelText(llm, options) {
  const attempts = options.attempts ?? 2;
  let lastFailure = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const collected = await streamOnce(llm, options);
    if (collected.text !== '') return collected.text;
    if (collected.reasoningJson !== null) return collected.reasoningJson;
    lastFailure = collected.emptyReason;
  }
  throw new Error(`模型没有返回任何内容（${lastFailure}）；请检查 analysis.provider / analysis.model 是否可用`);
}

/** 跑一次流，收集正文 / 思维链 / 空手原因。 */
async function streamOnce(llm, options) {
  const deltas = [];
  const blocks = [];
  const reasoning = [];
  let failure = null;
  const stream = llm.stream({
    provider: options.provider,
    model: options.model,
    system: options.system ?? DEFAULT_SYSTEM_PROMPT,
    messages: options.messages,
    ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
    // 思考档位：调用方可以指定（补全这种「要快」的场景会挑最省力的那档）。
    // 不传 = 用模型自己的默认档。传了模型不支持的档位，llm 服务会当场报错。
    ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
    ...options.signal === undefined ? {} : { signal: options.signal },
  });
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') deltas.push(chunk.text);
    else if (chunk.type === 'block-end' && chunk.block !== null && chunk.block !== undefined && chunk.block.type === 'text') blocks.push(chunk.block.text);
    else if (chunk.type === 'reasoning-delta') reasoning.push(chunk.text);
    // ⚠️ 这里必须把 finish 整个圈起来再读 reason.kind。
    //   原来写成 `type==='finish' && reason.kind==='error' || reason.kind==='aborted'`，
    //   而 `&&` 比 `||` 紧 —— 后半截没被 type 护住，于是**任何**非 finish 的块
    //   （pi-ai 适配器在 finish 之前先吐的 usage 块就是这种）都会去读
    //   `chunk.reason.kind`，而 chunk.reason 是 undefined → 当场抛
    //   「Cannot read properties of undefined (reading 'kind')」。
    //   后果：每一次模型调用都当场死掉，用量查询的分析一直在走规则兜底。
    else if (chunk.type === 'finish') {
      const reason = chunk.reason;
      if (reason !== null && reason !== undefined) {
        if (reason.kind === 'error' || reason.kind === 'aborted') failure = reason.failure;
        else if (reason.kind === 'max-tokens') failure = { message: 'max-tokens：输出被 maxOutputTokens 截断' };
      }
    }
  }
  if (failure !== null && failure !== undefined) {
    throw new Error(`模型调用失败：${failure.message}${failure.status === undefined ? '' : `（HTTP ${failure.status}）`}`);
  }
  const text = (deltas.length > 0 ? deltas.join('') : blocks.join('')).trim();
  const reasoningText = reasoning.join('').trim();
  // 思维链里出现完整 JSON 时也认：模型把答案写进思考通道是自己的毛病，
  // 但内容仍是它给的，且后面还要过校验。
  const fromReasoning = text === '' && reasoningText !== '' ? extractJson(reasoningText) : null;
  return {
    text,
    reasoningJson: fromReasoning === null ? null : JSON.stringify(fromReasoning),
    emptyReason: reasoningText === '' ? '流里没有正文也没有思维链' : '只有思维链，且其中没有完整 JSON',
  };
}

/**
 * 从模型输出里抠出第一个完整的 JSON 对象。
 *
 * 模型偶尔会裹 ```json 代码块或加一句话，所以这里做宽松提取：找第一个 `{`，
 * 按括号深度扫到配对的 `}`（跳过字符串里的括号）。
 *
 * @param {string} text 模型输出。
 * @returns {object|null} 解析结果。
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced === null ? text : fenced[1];
  const start = body.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(body.slice(start, i + 1));
          return parsed !== null && typeof parsed === 'object' ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
