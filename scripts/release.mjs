#!/usr/bin/env node
/**
 * 交互式发布：pnpm release
 *
 * 为什么要有这个命令
 * ------------------
 * 版本号原本散在两处 —— package.json 的 version、CHANGELOG 的节标题。手改必然
 * 漏一处，两个仓库就都漂过：package.json 停在 0.1.10，而 CHANGELOG 已经写到
 * 0.1.12。这个脚本把「改版本号」收敛成一次动作：两处一起算、一起写、一起提交。
 * 人是选版本类型（patch / minor / major），不是敲数字。
 *
 * 流程
 * ----
 *   1. 前置检查：工作区必须干净 —— 否则会把没提交的改动混进 release 提交
 *   2. 定基线 = max(package.json.version, CHANGELOG 里最高的已发布版本)
 *      （本仓库还没发过版时基线取 0.0.0，好让首个 minor 就是 0.1.0）
 *   3. 交互式问：版本类型 / 是否跑验证 / 是否打 tag / 是否 push
 *   4. 跑验证：verify.sh（含 check-host / check-client / check-routes / smoke /
 *      ui-check）
 *   5. 写 package.json.version，并把 CHANGELOG 的 Unreleased 节改成版本节
 *   6. 提交：release: <version> — <title>
 *   7. 可选：打 annotated tag v<version>
 *   8. 可选：push 分支与 tag
 *
 * 有意不做的事
 * ------------
 *   - 不替你决定版本号（只给三个建议值让你选）
 *   - 不默认 push（推远端是对外且不可逆的动作）
 *   - 不自动新建空的 Unreleased 节（本仓库的习惯是「有内容才出现」）
 *
 * 用法
 * ----
 *   pnpm release              全交互
 *   pnpm release minor        指定版本类型，其余仍交互
 *   pnpm release --yes        非交互，全用默认值（版本类型默认 patch）
 *   pnpm release --dry-run    只打印将要发生什么，不落任何改动
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG_PATH = join(ROOT, 'package.json');
const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md');

/** 换行常量。全脚本刻意不出现反斜杠转义：需要拼接多行时一律用 NL。 */
const NL = String.fromCharCode(10);

/* ── 小工具 ─────────────────────────────────────────────────────── */

/**
 * 跑一条 git 命令，返回退出码与输出。
 *
 * @param {string[]} args git 参数。
 * @returns {{code: number, out: string, err: string}} 结果。
 */
function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status === null ? 1 : r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/**
 * 跑一条验证命令，实时打印结果；失败时把输出末尾打出来。
 *
 * @param {string} label 步骤名。
 * @param {string} cmd 可执行文件。
 * @param {string[]} args 参数。
 * @returns {boolean} 是否通过。
 */
function runStep(label, cmd, args) {
  process.stdout.write('  → ' + label + ' ... ');
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  const code = r.status === null ? 1 : r.status;
  if (code === 0) {
    console.log('通过');
    return true;
  }
  console.log('失败');
  const text = ((r.stdout || '') + (r.stderr || '')).trim();
  const tail = text.split(NL).slice(-12);
  for (const line of tail) console.log('      ' + line);
  return false;
}

const isDigits = (s) => s.length > 0 && s.split('').every((c) => c >= '0' && c <= '9');
const isSemver = (s) => {
  const p = String(s).split('.');
  return p.length === 3 && p.every(isDigits);
};
const tuple = (v) => v.split('.').map(Number);
const compare = (a, b) => {
  const x = tuple(a);
  const y = tuple(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
const bump = (v, kind) => {
  const p = tuple(v);
  if (kind === 'major') return p[0] + 1 + '.0.0';
  if (kind === 'minor') return p[0] + '.' + (p[1] + 1) + '.0';
  return p[0] + '.' + p[1] + '.' + (p[2] + 1);
};
const today = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/* ── 读现状 ─────────────────────────────────────────────────────── */

/**
 * 读 package.json。
 *
 * @returns {{raw: string, version: string}} 原文与版本号。
 */
function readPackage() {
  const raw = readFileSync(PKG_PATH, 'utf8');
  return { raw, version: JSON.parse(raw).version };
}

/**
 * 扫 CHANGELOG 的顶层节标题，分出已发布版本与 Unreleased 节。
 * 标题形态： ## <版本|Unreleased> · <日期> [· <标题>]
 *
 * @returns {{released: Array<object>, highest: string|null, unreleased: object|null}} 解析结果。
 */
function readChangelog() {
  const lines = readFileSync(CHANGELOG_PATH, 'utf8').split(NL);
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('## ')) continue;
    const parts = lines[i].slice(3).split(' · ');
    sections.push({
      line: i,
      label: parts[0].trim(),
      title: parts.slice(2).join(' · ').trim(),
    });
  }
  const released = sections.filter((s) => isSemver(s.label));
  let highest = null;
  for (const s of released) if (highest === null || compare(s.label, highest) > 0) highest = s.label;
  return {
    released,
    highest,
    unreleased: sections.filter((s) => s.label === 'Unreleased')[0] || null,
  };
}

/* ── 交互 ───────────────────────────────────────────────────────── */

/**
 * 造一个提问器。
 *
 * 分两种 stdin：
 *   · TTY（正常终端）：用 readline 逐问逐答。同时挂一个 close 竞速 —— 用户按
 *     Ctrl-D 时 readline 会关闭而挂起的 question 永不 resolve，不竞速的话脚本
 *     会**静默结束**：什么都没做，退出码还是 0。
 *   · 非 TTY（被管道接了）：先把 stdin 一次性读完，再按行喂给提问。
 *
 * @param {string[] | null} stdinLines 非 TTY 时预读出来的行；TTY 时传 null。
 * @returns {{ask: Function, close: Function}} 提问器。
 */
function makePrompter(stdinLines) {
  if (stdinLines !== null) {
    let i = 0;
    return {
      ask: async (q) => {
        const ans = i < stdinLines.length ? stdinLines[i] : '';
        i++;
        process.stdout.write(q + ans + NL);
        return ans;
      },
      close: () => {},
    };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let fireClosed = null;
  const closed = new Promise((resolve) => {
    fireClosed = resolve;
  });
  rl.once('close', fireClosed);
  return {
    ask: (q) =>
      Promise.race([
        rl.question(q),
        closed.then(() => {
          throw new Error('stdin 提前关闭（Ctrl-D？），发布已中止，未做任何改动');
        }),
      ]),
    close: () => rl.close(),
  };
}

/**
 * 打印带编号的选项并读一个选择。回车走默认项；认不出输入也走默认项。
 *
 * @param {object} prompt 提问器。
 * @param {string} question 问题。
 * @param {Array<{key: string, label: string, hint?: string}>} options 选项。
 * @param {number} defaultIndex 默认项下标。
 * @returns {Promise<{key: string, label: string}>} 选中的项。
 */
async function choose(prompt, question, options, defaultIndex) {
  console.log('');
  console.log(question);
  for (let i = 0; i < options.length; i++) {
    const hint = options[i].hint ? '   ' + options[i].hint : '';
    console.log('  [' + (i + 1) + '] ' + options[i].label + hint);
  }
  const def = options[defaultIndex];
  const ans = (await prompt.ask('选择（回车 = ' + (defaultIndex + 1) + '，' + def.label + '）: ')).trim();
  if (ans === '') return def;
  const n = Number(ans);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
  const byKey = options.filter((o) => o.key === ans)[0];
  if (byKey) return byKey;
  console.log('  认不出「' + ans + '」，按默认（' + def.label + '）继续');
  return def;
}

/* ── 写回 ───────────────────────────────────────────────────────── */

/**
 * 只替换 package.json 里那一个 version 字段的**字面量**，其余字节原样保留
 * —— 走 JSON.parse/stringify 会把整个文件的排版和键序都重写一遍。
 *
 * @param {string} raw package.json 原文。
 * @param {string} from 旧版本。
 * @param {string} to 新版本。
 * @returns {string} 改后的原文。
 */
function applyVersion(raw, from, to) {
  const needle = '"version": "' + from + '"';
  if (raw.indexOf(needle) === -1) throw new Error('在 package.json 里找不到 ' + needle);
  return raw.split(needle).join('"version": "' + to + '"');
}

/**
 * 把 Unreleased 节改成版本节。
 *   · 标题行： ## Unreleased · <旧日期> [· <标题>]  →  ## <新版本> · <今天> [· <标题>]
 *   · 删掉紧跟标题的引用块 —— 那类说明发布后不再成立
 *   · 收拢因此产生的多余空行
 *
 * @param {string} text CHANGELOG 原文。
 * @param {string} version 新版本。
 * @param {string} title 节标题。
 * @returns {{text: string, changed: boolean}} 改后的原文。
 */
function applyChangelog(text, version, title) {
  const lines = text.split(NL);
  const idx = lines.indexOf(lines.filter((l) => l.startsWith('## Unreleased'))[0]);
  if (idx === -1) return { text, changed: false };
  lines[idx] = '## ' + version + ' · ' + today() + (title ? ' · ' + title : '');
  // 引用块与标题之间隔着一个空行，所以要先跳过空行再找引用块。
  let quoteStart = idx + 1;
  while (quoteStart < lines.length && lines[quoteStart].trim() === '') quoteStart++;
  let quoteEnd = quoteStart;
  while (quoteEnd < lines.length && lines[quoteEnd].startsWith('> ')) quoteEnd++;
  if (quoteEnd > quoteStart) lines.splice(idx + 1, quoteEnd - (idx + 1));
  let out = lines.join(NL);
  while (out.indexOf(NL + NL + NL) !== -1) out = out.split(NL + NL + NL).join(NL + NL);
  return { text: out, changed: true };
}

/* ── 主流程 ─────────────────────────────────────────────────────── */

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.indexOf('--dry-run') !== -1;
  const assumeYes = argv.indexOf('--yes') !== -1;
  const skipChecks = argv.indexOf('--skip-checks') !== -1;
  const typeArg = argv.filter((a) => ['patch', 'minor', 'major'].indexOf(a) !== -1)[0] || null;
  const KNOWN_FLAGS = ['--dry-run', '--yes', '--skip-checks'];
  const unknown = argv.filter((a) => a.startsWith('--') && KNOWN_FLAGS.indexOf(a) === -1);
  if (unknown.length) {
    console.error('未知参数：' + unknown.join(' '));
    process.exit(2);
  }

  console.log('');
  console.log('=== dsh-usage-aggregator 发布 ===');
  console.log('');

  /* 1. 前置检查 */
  const status = git(['status', '--porcelain']);
  if (status.out !== '' && !dryRun) {
    console.error('工作区不干净，先提交或 stash 再发布：');
    for (const l of status.out.split(NL)) console.error('  ' + l);
    console.error('');
    console.error('（release 会把改动写进提交，脏工作区无法区分「本次发布」与「别的改动」）');
    process.exit(1);
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
  const pkg = readPackage();
  const log = readChangelog();

  /* 2. 定基线 */
  let base = pkg.version;
  let driftNote = null;
  let firstRelease = false;
  if (log.released.length === 0) {
    // 还没发过版：基线取 0.0.0，好让首个 minor 正好是 0.1.0。
    base = '0.0.0';
    firstRelease = true;
  } else if (log.highest !== null && compare(log.highest, base) > 0) {
    driftNote = 'package.json 是 ' + base + '，而 CHANGELOG 已发布到 ' + log.highest;
    base = log.highest;
  }

  console.log('  分支        : ' + branch);
  console.log('  package.json: ' + pkg.version);
  console.log('  CHANGELOG   : 最新已发布 ' + (log.highest || '（无）'));
  console.log('  基线        : ' + base + (firstRelease ? '（首次发布）' : ''));
  if (driftNote) console.log('  ⚠ 检测到版本漂移：' + driftNote + ' → 按较高的那个算下一个版本');
  // 没有 Unreleased 节就不让发布：那样只会改 package.json 而 CHANGELOG 不记录，
  // 直接制造出「package.json ≠ CHANGELOG 最新节」的漂移 —— 正是本命令要消灭的东西。
  if (log.unreleased === null) {
    console.error('');
    console.error('  CHANGELOG 里没有 Unreleased 节，无处记录这次发布。');
    console.error('  先在 CHANGELOG.md 顶部加一节，写完再发布：');
    console.error('');
    console.error('      ## Unreleased · ' + today() + ' · <一句话标题>');
    console.error('');
    console.error('      <这次改了什么>');
    console.error('');
    console.error('  发布时本命令会把它改写成  ## <版本> · <当天日期> · <标题>。');
    process.exit(1);
  }

  const cand = {
    patch: bump(base, 'patch'),
    minor: bump(base, 'minor'),
    major: bump(base, 'major'),
  };

  /* 3. 交互 */
  let stdinLines = null;
  if (!assumeYes) {
    if (process.stdin.isTTY === true) {
      stdinLines = null;
    } else {
      const piped = readFileSync(0, 'utf8');
      if (piped === '') {
        console.error('stdin 不是终端，也没有可读的输入 —— 交互模式需要终端。');
        console.error('非交互用法： pnpm release --yes minor   （或 patch / major）');
        process.exit(2);
      }
      stdinLines = piped.split(NL);
    }
  }
  const prompt = makePrompter(stdinLines);
  let kind = typeArg;
  let runChecks = !skipChecks;
  let doTag = true;
  let doPush = false;

  if (assumeYes) {
    kind = kind || (firstRelease ? 'minor' : 'patch');
    console.log('');
    console.log(
      '  --yes：按默认走（' +
        kind +
        ' → ' +
        cand[kind] +
        '，' +
        (runChecks ? '跑验证' : '跳过验证') +
        '，打 tag，不 push）',
    );
  } else {
    if (kind === null) {
      const picked = await choose(
        prompt,
        '升到哪个版本？',
        [
          { key: 'patch', label: 'patch  ' + cand.patch, hint: '修 bug / 文档 / 内部整理' },
          { key: 'minor', label: 'minor  ' + cand.minor, hint: '向后兼容的新功能' },
          { key: 'major', label: 'major  ' + cand.major, hint: '破坏性变更' },
        ],
        firstRelease ? 1 : 0,
      );
      kind = picked.key;
    } else {
      console.log('');
      console.log('  版本类型由参数指定：' + kind + ' → ' + cand[kind]);
    }
    runChecks =
      (
        await choose(prompt, '提交前跑验证吗？', [
          { key: 'yes', label: '跑 verify.sh（含 check-host / check-client / smoke / ui-check）', hint: '（推荐，约 20 秒）' },
          { key: 'no', label: '跳过，直接发布' },
        ], 0)
      ).key === 'yes';
    doTag =
      (
        await choose(prompt, '打 annotated tag 吗？', [
          { key: 'yes', label: '打 tag v' + cand[kind] },
          { key: 'no', label: '不打 tag' },
        ], 0)
      ).key === 'yes';
    doPush =
      (
        await choose(prompt, '发布后 push 到 origin 吗？', [
          { key: 'no', label: '不 push', hint: '（推荐：先本地看一眼，推远端是不可逆的对外动作）' },
          { key: 'yes', label: 'push 分支与 tag 到 origin' },
        ], 0)
      ).key === 'yes';
  }

  const version = cand[kind];
  const title = log.unreleased ? log.unreleased.title : '';
  const subject = 'release: ' + version + (title ? ' — ' + title : '');

  /* 4. 汇总确认 */
  console.log('');
  console.log('  将执行：');
  console.log('    · package.json  ' + pkg.version + ' → ' + version);
  console.log(
    '    · CHANGELOG     ' +
      (log.unreleased ? 'Unreleased → ' + version + ' · ' + today() : '不改（无 Unreleased 节）'),
  );
  console.log('    · 提交           ' + subject);
  console.log('    · tag            ' + (doTag ? 'v' + version : '不打'));
  console.log('    · push           ' + (doPush ? 'origin ' + branch + ' + tag' : '不推'));
  console.log('    · 验证           ' + (runChecks ? '跑' : '跳过'));
  if (dryRun) {
    console.log('');
    console.log('  --dry-run：到此为止，没有改动任何文件');
    prompt.close();
    return;
  }
  if (!assumeYes) {
    const go = (await prompt.ask('继续？（回车 = yes / 输入 no 取消）: ')).trim().toLowerCase();
    if (go !== '' && go !== 'y' && go !== 'yes') {
      console.log('  已取消，未做任何改动');
      prompt.close();
      return;
    }
  }
  prompt.close();

  /* 5. 验证 */
  if (skipChecks && !assumeYes) {
    console.log('');
    console.log('  --skip-checks：按要求跳过验证');
  } else if (runChecks) {
    console.log('');
    console.log('  验证：');
    const okAll =
      runStep('verify.sh', 'bash', ['scripts/verify.sh']) &&
      runStep('check-host', 'node', ['scripts/check-host.mjs']) &&
      runStep('check-client', 'node', ['scripts/check-client.mjs']) &&
      runStep('check-routes', 'node', ['scripts/check-routes.mjs']);
    if (!okAll) {
      console.error('');
      console.error('  验证未通过，已中止 —— 没有写任何文件');
      process.exit(1);
    }
  }

  /* 6. 写回 */
  try {
    writeFileSync(PKG_PATH, applyVersion(pkg.raw, pkg.version, version));
  } catch (err) {
    console.error('  写 package.json 失败：' + err.message);
    process.exit(1);
  }
  if (log.unreleased) {
    const before = readFileSync(CHANGELOG_PATH, 'utf8');
    writeFileSync(CHANGELOG_PATH, applyChangelog(before, version, title).text);
  }
  console.log('');
  console.log('  已更新 package.json 与 CHANGELOG.md');

  /* 7. 提交 + tag */
  const staged = git(['add', 'package.json', 'CHANGELOG.md']);
  if (staged.code !== 0) {
    console.error('  git add 失败：' + staged.err);
    process.exit(1);
  }
  const committed = git(['commit', '-m', subject]);
  if (committed.code !== 0) {
    console.error('  git commit 失败：' + committed.err);
    process.exit(1);
  }
  const hash = git(['rev-parse', '--short', 'HEAD']).out;
  console.log('  已提交 ' + hash + '  ' + subject);

  if (doTag) {
    const t = git(['tag', '-a', 'v' + version, '-m', subject]);
    if (t.code !== 0) {
      console.error('  打 tag 失败：' + t.err);
      process.exit(1);
    }
    console.log('  已打 tag v' + version);
  }

  /* 8. push */
  if (doPush) {
    const p = git(['push', 'origin', branch]);
    if (p.code !== 0) {
      console.error('  push 分支失败：' + p.err);
      process.exit(1);
    }
    console.log('  已 push ' + branch);
    if (doTag) {
      const pt = git(['push', 'origin', 'v' + version]);
      if (pt.code !== 0) {
        console.error('  push tag 失败：' + pt.err);
        process.exit(1);
      }
      console.log('  已 push tag v' + version);
    }
  } else {
    console.log('');
    console.log('  下一步（想推的时候）：');
    console.log('    git push origin ' + branch + (doTag ? ' && git push origin v' + version : ''));
  }
  console.log('');
  console.log('  发布完成：' + version);
  console.log('');
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
