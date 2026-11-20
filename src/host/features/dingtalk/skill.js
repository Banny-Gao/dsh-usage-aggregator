// src/host/features/dingtalk/skill.js
//
// 随插件附带的技能：模型什么时候该提议「发一条钉钉消息」。
//
// 为什么要有技能：propose_action 这个工具只有在**本次会话里加载了对应技能的
// 技能**之后才会出现在模型的工具表里。没有技能，模型就既看不到这个工具，
// 也不知道卡片上有哪些字段。
//
// 技能正文放在包里（skills/dingtalk-sofa/SKILL.md），随包发布，不依赖机器上的文件。

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** 技能名（卡片类型里 skill 字段要写的就是它）。 */
export const SKILL_NAME = 'dingtalk-sofa';

/** 技能提供方名。 */
export const PROVIDER_NAME = 'dsh-usage-aggregator-dingtalk';

/** 技能正文的位置。 */
const SKILL_BODY_URL = new URL('../../../../skills/dingtalk-sofa/SKILL.md', import.meta.url);

/** 技能的说明（出现在技能目录里，模型据此决定要不要加载）。 */
export const DESCRIPTION =
  '在 DSH 会话里发钉钉消息：当用户说「把这段发给某人」「同步给某某」，' +
  '或你刚做完一个结论、判断值得同步给某个人时，用它提议一次外发。' +
  '用户会在卡片上点【发送】确认，你不能自己发出去。' +
  '收到钉钉新消息时也用它：只做分析（消息说了什么 / 和项目的关系 / 建议做什么），' +
  '再问用户要不要处理。不要用于读取用量、更新插件、清理缓存等其它能力。';

/** = BUNDLED_SKILL_RANK（见 @deepseek-ai/dsh-skill 的实现，值为 600）。 */
export const RANK = 600;

/** 技能的资源根目录（技能目录浏览用）。 */
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../../../../skills/', import.meta.url)),
};

/**
 * 剥掉 SKILL.md 的 YAML frontmatter（frontmatter 是给项目级技能用的）。
 *
 * @param {string} text 原文。
 * @returns {string} 正文。
 */
export function stripFrontmatter(text) {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;
  const after = text.indexOf('\n', end + 1);
  if (after === -1) return '';
  return text.slice(after + 1).replace(/^\s*\n/, '');
}

/** 技能候选（登记在目录里的那一份）。 */
export const CANDIDATE = {
  name: SKILL_NAME,
  description: DESCRIPTION,
  rank: RANK,
  invocation: { modelInvocable: true, userInvocable: false },
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  locator: SKILL_BODY_URL,
};

/**
 * 技能提供方：目录里列一项，模型加载时再读正文。
 *
 * @returns {{name: string, list: Function, get: Function}} 提供方。
 */
export function createSkillProvider() {
  return {
    name: PROVIDER_NAME,
    list: () => Promise.resolve([CANDIDATE]),
    async get() {
      const raw = await readFile(SKILL_BODY_URL, 'utf8');
      return {
        name: CANDIDATE.name,
        description: CANDIDATE.description,
        invocation: CANDIDATE.invocation,
        provider: CANDIDATE.provider,
        source: CANDIDATE.source,
        resourceBase: RESOURCE_BASE,
        content: stripFrontmatter(raw),
      };
    },
  };
}
