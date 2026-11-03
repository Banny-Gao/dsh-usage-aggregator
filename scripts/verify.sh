#!/usr/bin/env bash
# scripts/verify.sh
#
# 本地自检：pnpm run check 的入口。
#
# 覆盖：语法 / 关键文件 / 清单一致性 / 路由前缀三处一致 / 构建产物一致性 /
#       主题 token / 注入依赖 / 槽位唯一 / i18n / 持久化 key / 落盘路径 /
#       工具名 / 旧包名退役 / 路由唯一 / 真实 cordis 装载 / 纯函数自检 /
#       离线渲染 / 版本一致性。
#
# 用法：bash scripts/verify.sh
#
# ⚠️ 不开 `set -e`：这里要的是「一次跑完所有检查、把失败都列出来」，
#    一条失败就中止等于把后面的信息全藏了。失败用 FAIL=1 累积，最后统一退出码。
set -uo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0

ok()   { echo "  ✓ $1"; }
bad()  { echo "  ✗ $1"; FAIL=1; }
skip() { echo "  – $1"; }

# 语法检查用的临时目录（.js 拷成 .mjs 再 node --check ——
# node --check 对 ESM 会误报：它按扩展名 + package.json type 判定模块类型，
# 而产物 client/client.js 是 IIFE、源码是 ESM，两种判定都不可靠）。
SYNTAX_TMP="$(mktemp -d)"
cleanup() { rm -rf "$SYNTAX_TMP"; }
trap cleanup EXIT

syntax_ok() {
  local file="$1"
  cp "$file" "$SYNTAX_TMP/probe.mjs" 2>/dev/null || return 1
  node --check "$SYNTAX_TMP/probe.mjs" >/dev/null 2>&1
}

echo "→ 语法"
SYNTAX_COUNT=0
SYNTAX_BAD=0
while IFS= read -r FILE; do
  SYNTAX_COUNT=$((SYNTAX_COUNT + 1))
  if syntax_ok "$FILE"; then
    :
  else
    bad "语法错误：${FILE#$PLUGIN_DIR/}"
    SYNTAX_BAD=1
  fi
done < <(find "$PLUGIN_DIR/src" "$PLUGIN_DIR/vite" "$PLUGIN_DIR/scripts" -type f \( -name '*.js' -o -name '*.mjs' \) 2>/dev/null | sort)
if [ -f "$PLUGIN_DIR/client/client.js" ]; then
  SYNTAX_COUNT=$((SYNTAX_COUNT + 1))
  syntax_ok "$PLUGIN_DIR/client/client.js" || { bad "语法错误：client/client.js"; SYNTAX_BAD=1; }
fi
if [ "$SYNTAX_BAD" = "0" ]; then ok "$SYNTAX_COUNT 个 .js/.mjs 全部通过 node --check"; fi

echo ""
echo "→ 关键文件"
check_file() {
  if [ -f "$PLUGIN_DIR/$1" ]; then ok "$1"; else bad "MISSING: $1"; fi
}
check_file "package.json"
check_file "cordis.patch.yml"
check_file "icon.svg"
check_file "locale/zh.json"
check_file "locale/en.json"
check_file "vite.config.mjs"
check_file "vite/axzo-logo-plugin.mjs"
check_file "vite/logo-assets.mjs"
check_file "assets/axzo-official-logo.svg"
check_file "src/client/index.js"
check_file "src/host/index.js"
check_file "src/client/shared/constants.js"
check_file "src/host/shared/context.js"
check_file "src/client/hub/panel.js"
check_file "src/host/features/usage/store.js"
check_file "src/host/features/usage/tool.js"
check_file "src/host/features/expander/tool.js"
check_file "src/host/features/expander/ops.js"
check_file "src/host/features/expander/fixtures/state.json"
check_file "src/host/features/boost/index.js"
check_file "src/host/features/boost/catalog.js"
check_file "src/host/features/boost/probe.js"
check_file "src/host/features/boost/execute.js"
check_file "src/host/features/boost/analyze.js"
check_file "src/host/features/boost/ops.js"
check_file "src/host/features/boost/tool.js"
check_file "src/host/features/boost/fixtures/scan.json"
check_file "src/host/features/autocomplete/index.js"
check_file "src/host/features/autocomplete/ops.js"
check_file "src/host/features/autocomplete/analyze.js"
check_file "src/host/features/autocomplete/settings.js"
check_file "src/host/features/autocomplete/store.js"
check_file "src/host/features/autocomplete/server.js"
check_file "src/client/features/autocomplete/index.js"
check_file "src/client/features/autocomplete/overlay.js"
check_file "src/client/features/autocomplete/dock.js"
check_file "src/client/features/autocomplete/panel.js"
check_file "src/client/features/autocomplete/engine.js"
check_file "src/client/features/autocomplete/store.js"
check_file "src/client/features/autocomplete/complete.js"
check_file "src/client/features/autocomplete/api.js"
check_file "src/client/features/autocomplete/i18n.js"
check_file "src/client/features/autocomplete/styles.js"
check_file "scripts/check-host.mjs"
check_file "scripts/check-client.mjs"
check_file "scripts/smoke.mjs"
check_file "scripts/smoke-renewal.mjs"
check_file "scripts/ui-check.mjs"
check_file "scripts/ui-check-expander.mjs"
check_file "scripts/ui-check-tasks.mjs"
check_file "scripts/ui-check-boost.mjs"
check_file "scripts/boost-check.mjs"
check_file "scripts/ui-check-autocomplete.mjs"
check_file "scripts/autocomplete-check.mjs"
check_file "scripts/render-check.mjs"
check_file "scripts/release.mjs"
check_file "scripts/verify.sh"

echo ""
echo "→ 清单一致性（package.json ↔ cordis.patch.yml）"
if node - "$PLUGIN_DIR" <<'NODE'
const fs = require('fs')
const path = require('path')
const dir = process.argv[2]
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
const patch = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
let bad = 0
const check = (label, ok, detail) => {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (detail === undefined ? '' : '（' + detail + '）'))
}

// cordis.patch.yml 的 insert id / name 必须与 package.json 的 name 一致 ——
// 不一致的话 DSH 会按 bundle 名找插件行，找不到就是「装了但不显示」。
const insertIds = [...patch.matchAll(/^\s*-?\s*id:\s*['"]?([\w.-]+)['"]?/gm)].map((m) => m[1])
const insertNames = [...patch.matchAll(/^\s*name:\s*['"]?([\w.-]+)['"]?/gm)].map((m) => m[1])
check('cordis.patch.yml 的 insert id 含 ' + pkg.name, insertIds.includes(pkg.name), insertIds.join(', '))
check('cordis.patch.yml 的 insert name 含 ' + pkg.name, insertNames.includes(pkg.name), insertNames.join(', '))

check('exports["./client"] 指向 client/client.js', pkg.exports['./client'] === './client/client.js', pkg.exports['./client'])
check('exports["."] 指向 src/host/index.js', pkg.exports['.'] === './src/host/index.js', pkg.exports['.'])
check('files 覆盖 src/host', Array.isArray(pkg.files) && pkg.files.includes('src/host'))
check('files 覆盖 client/client.js', Array.isArray(pkg.files) && pkg.files.includes('client/client.js'))
check('files 覆盖 locale', Array.isArray(pkg.files) && pkg.files.includes('locale'))
check('dsh.bundle.patch 指向存在的补丁', typeof pkg.dsh?.bundle?.patch === 'string' && fs.existsSync(path.join(dir, pkg.dsh.bundle.patch)))
check('dsh.client.platform = web', pkg.dsh?.client?.platform === 'web')
process.exit(bad === 0 ? 0 : 1)
NODE
then ok "清单字段完整"; else bad "清单字段缺失或不一致"; fi

echo ""
echo "→ 路由前缀三处一致（patch / 客户端常量 / Host 默认值）"
# 为什么必须三处同值：客户端 bundle 在浏览器里独立加载，读不到 Host 的 config。
# 前缀对不上就是 404 / SPA 兜底页，而且只在浏览器里才暴露。
if node - "$PLUGIN_DIR" <<'NODE'
const fs = require('fs')
const path = require('path')
const dir = process.argv[2]
const patch = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
const clientConst = fs.readFileSync(path.join(dir, 'src/client/shared/constants.js'), 'utf8')
const hostConst = fs.readFileSync(path.join(dir, 'src/host/shared/context.js'), 'utf8')
const grab = (src, re) => { const m = src.match(re); return m === null ? null : m[1] }
const patchBase = grab(patch, /endpoint:\s*(\S+)/)
const clientBase = grab(clientConst, /ENDPOINT_BASE\s*=\s*['"]([^'"]+)['"]/)
const hostBase = grab(hostConst, /DEFAULT_BASE\s*=\s*['"]([^'"]+)['"]/)
let bad = 0
const check = (label, ok, detail) => {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (detail === undefined ? '' : '（' + detail + '）'))
}
check('cordis.patch.yml 的 config.endpoint 存在', patchBase !== null, patchBase)
check('客户端 ENDPOINT_BASE 存在', clientBase !== null, clientBase)
check('Host DEFAULT_BASE 存在', hostBase !== null, hostBase)
check('三处同值', patchBase !== null && patchBase === clientBase && clientBase === hostBase,
  [patchBase, clientBase, hostBase].join(' / '))
process.exit(bad === 0 ? 0 : 1)
NODE
then ok "路由前缀一致"; else bad "路由前缀三处不一致"; fi

echo ""
echo "→ 构建产物一致性"
# 产物里带构建时间戳（vite define 注入 __BUILD_AT__），所以比对前要抹掉它 ——
# 否则每次构建都「不一致」。
normalize_hash() {
  node -e '
    const fs = require("fs"), crypto = require("crypto");
    let s = fs.readFileSync(process.argv[1], "utf8");
    s = s.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, "<BUILD_AT>");
    process.stdout.write(crypto.createHash("sha256").update(s).digest("hex"));
  ' "$1"
}
if [ -f "$PLUGIN_DIR/client/client.js" ]; then
  BEFORE="$(normalize_hash "$PLUGIN_DIR/client/client.js")"
  if [ ! -x "$PLUGIN_DIR/node_modules/.bin/vite" ] && [ ! -d "$PLUGIN_DIR/node_modules/vite" ]; then
    bad "没装依赖（找不到 vite）—— 先跑 pnpm install，才能重跑构建比对产物"
  elif (cd "$PLUGIN_DIR" && pnpm exec vite build) >/dev/null 2>&1; then
    AFTER="$(normalize_hash "$PLUGIN_DIR/client/client.js")"
    if [ "$BEFORE" = "$AFTER" ]; then
      ok "client/client.js 与 src/ 同步（抹掉构建时间戳后 sha256 相同）"
    else
      bad "client/client.js 落后于 src/ —— 请提交重新构建的产物（pnpm build）"
    fi
  else
    bad "重跑 vite build 失败，无法判定产物一致性（跑 pnpm build 看详情）"
  fi
else
  bad "client/client.js 不存在 —— 先跑 pnpm build"
fi

if [ -f "$PLUGIN_DIR/client/client.js" ]; then
  # 横幅走 vite/config.mjs 的 output.banner 发。若有人回退成在插件 transform 里
  # 拼注释，横幅会被剥掉 —— 这条断言就是为那时报警。
  if grep -q '请勿直接编辑' "$PLUGIN_DIR/client/client.js"; then ok "产物带「请勿直接编辑」横幅"; else bad "产物无横幅（横幅被注释剥离了？见 vite/config.mjs 的 output.banner）"; fi
fi

echo ""
echo "→ 主题 token（43 个 = 26 个 --dsw-* + 17 个 --dsh-axzo-*）"
if node - "$PLUGIN_DIR" <<'NODE'
const fs = require('fs')
const path = require('path')
const dir = process.argv[2]

// 43 个 token 的名字写死在这里：token 名是**对外契约**（主题覆盖层靠它生效），
// 少一个就有一处界面回到 DSH 默认色。改这里等于改契约，必须是有意的动作。
const DSW = [
  '--dsw-alias-brand-primary', '--dsw-alias-brand-primary-invert',
  '--dsw-alias-button-primary-fill', '--dsw-alias-button-primary-hover',
  '--dsw-alias-button-ghost-active-fill', '--dsw-alias-interactive-bg-active',
  '--dsw-alias-link',
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3', '--dsw-alias-bg-module-platform', '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l3', '--dsw-alias-border-l4',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-state-warn-primary', '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary', '--dsw-alias-state-info-primary',
  '--dsw-specific-input-major', '--dsw-specific-bubble',
  '--dsw-specific-bubble-highlight', '--dsw-specific-sidebar-fill',
]
const AXZO = [
  '--dsh-axzo-brand', '--dsh-axzo-brand-soft', '--dsh-axzo-brand-ring', '--dsh-axzo-brand-line',
  '--dsh-axzo-sidebar', '--dsh-axzo-sb-sheen', '--dsh-axzo-sb-edge',
  '--dsh-axzo-sb-shadow', '--dsh-axzo-sb-glow', '--dsh-axzo-sb-deep',
  '--dsh-axzo-glass-hi', '--dsh-axzo-glass-lo', '--dsh-axzo-glass-line',
  '--dsh-axzo-wash-1', '--dsh-axzo-wash-2',
  '--dsh-axzo-blob-a', '--dsh-axzo-blob-b',
]

const tokensPath = path.join(dir, 'src/client/features/theme/tokens.js')
const src = fs.readFileSync(tokensPath, 'utf8')
let bad = 0
const check = (label, ok, detail) => {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (detail === undefined ? '' : '（' + detail + '）'))
}

const missingDsw = DSW.filter((t) => !src.includes('"' + t + '"'))
check('26 个 --dsw-* token 都在', missingDsw.length === 0, missingDsw.join(', '))
const missingAxzo = AXZO.filter((t) => !src.includes('"' + t + '"'))
check('17 个 --dsh-axzo-* token 都在', missingAxzo.length === 0, missingAxzo.join(', '))
check('token 总数 = 43', DSW.length + AXZO.length === 43, String(DSW.length + AXZO.length))

// 不存在的 accent-* 系列：写错 token 名不会报错，只会静默不生效。
const all = fs.readFileSync(path.join(dir, 'src/client/features/theme/tokens.js'), 'utf8') +
  (fs.existsSync(path.join(dir, 'client/client.js')) ? fs.readFileSync(path.join(dir, 'client/client.js'), 'utf8') : '')
check('没有不存在的 --dsw-alias-accent-* token', !all.includes('dsw-alias-accent'))
check('没有不存在的 --dsh-axzo-alias-* token', !all.includes('dsh-axzo-alias-'))
process.exit(bad === 0 ? 0 : 1)
NODE
then ok "主题 token 齐了"; else bad "主题 token 缺了或多了"; fi

echo ""
echo "→ 注入依赖（客户端硬 inject）"
if node - "$PLUGIN_DIR" <<'NODE'
const fs = require('fs')
const path = require('path')
const dir = process.argv[2]
const src = fs.readFileSync(path.join(dir, 'src/client/index.js'), 'utf8')
let bad = 0
const check = (label, ok, detail) => {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (detail === undefined ? '' : '（' + detail + '）'))
}
// inject 必须是**最小集**：多写一个不存在的服务，entry 会永远 pending（整页
// Failed to load plugins）。这里把数组的元素集合解析出来精确比对 —— 既容忍换行，
// 又真正守住「不多不少」。
const m = src.match(/export\s+const\s+inject\s*=\s*\[([^\]]*)\]/)
if (m === null) {
  check('找到 export const inject = [...]', false)
} else {
  const names = (m[1].match(/['"][^'"]*['"]/g) || []).map((s) => s.slice(1, -1))
  const want = ['slots', 'locale', 'theme']
  const same = names.length === want.length && want.every((w, i) => names[i] === w)
  check('硬 inject 恰好是 slots / locale / theme', same, '[' + names.join(', ') + ']')
  check('sessions 不在硬 inject 里', !names.includes('sessions'))
}
// sessions 必须走可选注入。
const themeSrc = fs.readFileSync(path.join(dir, 'src/client/features/theme/index.js'), 'utf8')
check('sessions 走 ctx.inject([...]) 的可选注入', /ctx\.inject\(\s*\[[^\]]*['"]sessions['"]/.test(themeSrc))
process.exit(bad === 0 ? 0 : 1)
NODE
then ok "注入依赖符合约定"; else bad "注入依赖被破坏"; fi

echo ""
echo "→ 槽位唯一（一个插件一个设置入口）"
if node - "$PLUGIN_DIR" <<'NODE'
const fs = require('fs')
const path = require('path')
const dir = process.argv[2]
let bad = 0
const check = (label, ok, detail) => {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (detail === undefined ? '' : '（' + detail + '）'))
}
// 功能模块**不许**自己注册 settings.section —— 那是聚合页的活。
// 三个功能各自注册一个 → 设置面板里出现三个入口 → 正是本次聚合要消除的问题。
const featureDir = path.join(dir, 'src/client/features')
const offenders = []
for (const name of fs.readdirSync(featureDir)) {
  const file = path.join(featureDir, name, 'index.js')
  if (!fs.existsSync(file)) continue
  const src = fs.readFileSync(file, 'utf8')
  if (src.includes("'settings.section'") || src.includes('"settings.section"')) offenders.push(name)
}
check('功能模块不注册 settings.section', offenders.length === 0, offenders.join(', '))
const hub = fs.readFileSync(path.join(dir, 'src/client/hub/panel.js'), 'utf8')
check("聚合页注册 settings.section，id 是 'usage-aggregator'",
  /id:\s*'usage-aggregator'/.test(hub) && hub.includes("'settings.section'"))
check("聚合页里没有旧 id 'axzo-theme'", !hub.includes('axzo-theme'))
process.exit(bad === 0 ? 0 : 1)
NODE
then ok "设置入口只有一个"; else bad "设置入口不唯一"; fi

echo ""
echo "→ i18n 命名空间"
if node - "$PLUGIN_DIR" <<'NODE'
const fs = require('fs')
const path = require('path')
const dir = process.argv[2]
let bad = 0
const check = (label, ok, detail) => {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (detail === undefined ? '' : '（' + detail + '）'))
}
const read = (p) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
// 三个功能各有一个命名空间，**必须保持原值**：改名会让新旧命名空间并存
// （locale 服务按命名空间存字典，旧的不注销就一直占着）。
const specs = [
  ['theme', path.join(dir, 'src/client/features/theme/constants.js'), 'settings.axzoTheme'],
  ['usage', path.join(dir, 'src/client/features/usage/constants.js'), 'usage-query'],
  ['expander', path.join(dir, 'src/client/features/expander/index.js'), 'pluginExpander'],
  ['boost', path.join(dir, 'src/client/features/boost/i18n.js'), 'pcBoost'],
  ['autocomplete', path.join(dir, 'src/client/features/autocomplete/i18n.js'), 'pcAutocomplete'],
]
const found = []
for (const [name, file, want] of specs) {
  const src = read(file)
  const m = src.match(/NS\s*=\s*['"]([^'"]+)['"]/) || src.match(/namespace:\s*['"]([^'"]+)['"]/)
  const value = m === null ? null : m[1]
  check(name + ' 的命名空间是 ' + want, value === want, String(value))
  if (value !== null) found.push(value)
}
check('各命名空间互不相同', new Set(found).size === found.length, found.join(', '))
// 页签标签由**聚合页自己**拥有（src/client/hub/i18n.js）：
//   · 各功能通过 meta.hubTabKey 指向 hub 字典里的键；
//   · 功能的字典里**不再有** hubTab —— 同一个命名空间同时只能被一个包注册，
//     标签放在功能自己的命名空间下时，新旧插件并存会探不到，页签上显示裸的 key。
const hubDict = read(path.join(dir, 'src/client/hub/i18n.js'))
for (const key of ['tab', 'tabTheme', 'tabUsage', 'tabExpander', 'tabBoost', 'tabAutocomplete']) {
  check('聚合页字典有 ' + key, new RegExp(key + "\\s*:\\s*['\"][^'\"]+['\"]").test(hubDict))
}
const tabSpecs = [
  ['theme', path.join(dir, 'src/client/features/theme/index.js'), path.join(dir, 'src/client/features/theme/i18n.js'), 'tabTheme'],
  ['usage', path.join(dir, 'src/client/features/usage/index.js'), path.join(dir, 'src/client/features/usage/i18n.js'), 'tabUsage'],
  ['expander', path.join(dir, 'src/client/features/expander/index.js'), path.join(dir, 'src/client/features/expander/index.js'), 'tabExpander'],
  ['boost', path.join(dir, 'src/client/features/boost/index.js'), path.join(dir, 'src/client/features/boost/i18n.js'), 'tabBoost'],
  ['autocomplete', path.join(dir, 'src/client/features/autocomplete/index.js'), path.join(dir, 'src/client/features/autocomplete/i18n.js'), 'tabAutocomplete'],
]
for (const [name, metaFile, dictFile, want] of tabSpecs) {
  const metaSrc = read(metaFile)
  check(name + ' 的 meta 声明了 hubTabKey=' + want, new RegExp("hubTabKey\\s*:\\s*['\"]" + want + "['\"]").test(metaSrc))
  const dictSrc = read(dictFile)
  check(name + ' 的字典里没有 hubTab（页签标签归聚合页）', !/hubTab\s*:/.test(dictSrc))
}
check('插件更新是聚合页默认选中的页签', /hubDefault\s*:\s*true/.test(read(path.join(dir, 'src/client/features/expander/index.js'))))
process.exit(bad === 0 ? 0 : 1)
NODE
then ok "i18n 命名空间正确"; else bad "i18n 命名空间有问题"; fi

echo ""
echo "→ 持久化契约（localStorage key / 落盘路径）"
if node - "$PLUGIN_DIR" <<'NODE'
const fs = require('fs')
const path = require('path')
const dir = process.argv[2]
let bad = 0
const check = (label, ok, detail) => {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (detail === undefined ? '' : '（' + detail + '）'))
}
const consts = fs.readFileSync(path.join(dir, 'src/client/features/theme/constants.js'), 'utf8')
// 改了 localStorage key，用户已经保存过的主色 / 开关 / 品牌就全没了。
for (const key of ['dsh-axzo-theme:primary', 'dsh-axzo-theme:fx', 'dsh-axzo-theme:brand']) {
  check('localStorage key 仍是 ' + key, consts.includes(key))
}
// 落盘路径同理：改了目录，用户已配置的接口就静默消失（面板显示「还没有接入任何接口」）。
const store = fs.readFileSync(path.join(dir, 'src/host/features/usage/store.js'), 'utf8')
check('落盘目录仍是 dsh-usage-query', /'dsh-usage-query'/.test(store))
check('落盘文件仍是 store.json', /'store\.json'/.test(store))
check('dataDir 走 $DSH_HOME', /resolveDshHome\(env\)/.test(store))
process.exit(bad === 0 ? 0 : 1)
NODE
then ok "持久化契约没变"; else bad "持久化契约被改了"; fi

echo ""
echo "→ Agent 工具名"
if node - "$PLUGIN_DIR" <<'NODE'
const fs = require('fs')
const path = require('path')
const dir = process.argv[2]
let bad = 0
const check = (label, ok, detail) => {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (detail === undefined ? '' : '（' + detail + '）'))
}
// 工具名是**对外契约**：会话里已经发起过的调用靠名字对上，改名 = 旧会话失效。
const usageTool = fs.readFileSync(path.join(dir, 'src/host/features/usage/tool.js'), 'utf8')
check('用量查询的工具名仍是 usage_query', /name:\s*'usage_query'/.test(usageTool))
const expanderTool = fs.readFileSync(path.join(dir, 'src/host/features/expander/tool.js'), 'utf8')
check('插件更新的工具名仍是 plugin_update', /name:\s*'plugin_update'/.test(expanderTool))
const boostTool = fs.readFileSync(path.join(dir, 'src/host/features/boost/tool.js'), 'utf8')
check('加速清理的工具名是 system_boost', /name:\s*'system_boost'/.test(boostTool))
process.exit(bad === 0 ? 0 : 1)
NODE
then ok "工具名没变"; else bad "工具名被改了"; fi

echo ""
echo "→ 旧包名必须已退役"
if node - "$PLUGIN_DIR" <<'NODE'
const fs = require('fs')
const path = require('path')
const dir = process.argv[2]
let bad = 0
const check = (label, ok, detail) => {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (detail === undefined ? '' : '（' + detail + '）'))
}
const opsPath = path.join(dir, 'src/host/features/expander/ops.js')
const src = fs.existsSync(opsPath) ? fs.readFileSync(opsPath, 'utf8') : ''
check('expander 里有 RETIRED_PACKAGES 集合', /RETIRED_PACKAGES\s*=\s*new Set\(/.test(src))
// 三个旧包的能力都并进来了 —— 它们不该再出现在「可更新」清单里，
// 否则用户点一下「更新」就把已经合并的旧插件复活了。
for (const name of ['dsh-axzo-theme', 'dsh-usage-query', 'dsh-plugin-expander']) {
  check('RETIRED_PACKAGES 含 ' + name, new RegExp("['\"]" + name + "['\"]").test(src))
}
process.exit(bad === 0 ? 0 : 1)
NODE
then ok "旧包名已退役"; else bad "旧包名还能被当成更新目标"; fi

echo ""
echo "→ 路由路径全局唯一"
# webserver 的 register 以 (kind, path) 为键，重复注册直接 throw ——
# 那会让插件 entry 加载失败，整页 Failed to load plugins。
if node "$PLUGIN_DIR/scripts/check-routes.mjs" >"$SYNTAX_TMP/routes.log" 2>&1; then
  ok "三个功能的路由路径无重复"
  sed -n 's/^  /  /p' "$SYNTAX_TMP/routes.log" | head -20
else
  bad "路由路径有重复（跑 node scripts/check-routes.mjs 看详情）"
  tail -20 "$SYNTAX_TMP/routes.log" | sed 's/^/    /'
fi

echo ""
echo "→ 真实 cordis 装载（挡住「entry 永远 pending」这类只在运行时炸的问题）"
if node "$PLUGIN_DIR/scripts/check-host.mjs" >"$SYNTAX_TMP/host.log" 2>&1; then
  ok "Host 半边可被真实 cordis 装载"
else
  bad "cordis 装载失败（跑 node scripts/check-host.mjs 看详情）"
  tail -20 "$SYNTAX_TMP/host.log" | sed 's/^/    /'
fi

echo ""
echo "→ 客户端 bundle 契约"
if node "$PLUGIN_DIR/scripts/check-client.mjs" >"$SYNTAX_TMP/client.log" 2>&1; then
  ok "client bundle 的 inject / 槽位 / theme / locale 契约都对"
else
  bad "client bundle 契约校验失败（跑 node scripts/check-client.mjs 看详情）"
  tail -20 "$SYNTAX_TMP/client.log" | sed 's/^/    /'
fi

echo ""
echo "→ 纯函数行为（用量查询）"
if node "$PLUGIN_DIR/scripts/smoke.mjs" >"$SYNTAX_TMP/smoke.log" 2>&1; then
  ok "$(tail -1 "$SYNTAX_TMP/smoke.log")"
else
  bad "scripts/smoke.mjs 未通过（跑 node scripts/smoke.mjs 看详情）"
  tail -20 "$SYNTAX_TMP/smoke.log" | sed 's/^/    /'
fi

echo ""
echo "→ 自动续期（纯函数，不拉起浏览器）"
if node "$PLUGIN_DIR/scripts/smoke-renewal.mjs" >"$SYNTAX_TMP/renew.log" 2>&1; then
  ok "$(tail -1 "$SYNTAX_TMP/renew.log")"
else
  bad "scripts/smoke-renewal.mjs 未通过（跑 node scripts/smoke-renewal.mjs 看详情）"
  tail -20 "$SYNTAX_TMP/renew.log" | sed 's/^/    /'
fi

echo ""
echo "→ 离线渲染（真实 react，无需浏览器）"
if node "$PLUGIN_DIR/scripts/ui-check.mjs" >"$SYNTAX_TMP/ui.log" 2>&1; then
  ok "$(tail -1 "$SYNTAX_TMP/ui.log")"
else
  bad "scripts/ui-check.mjs 未通过（跑 node scripts/ui-check.mjs 看详情）"
  tail -20 "$SYNTAX_TMP/ui.log" | sed 's/^/    /'
fi

if node "$PLUGIN_DIR/scripts/ui-check-expander.mjs" >"$SYNTAX_TMP/ui-exp.log" 2>&1; then
  ok "$(tail -1 "$SYNTAX_TMP/ui-exp.log")"
else
  bad "scripts/ui-check-expander.mjs 未通过（跑 node scripts/ui-check-expander.mjs 看详情）"
  tail -20 "$SYNTAX_TMP/ui-exp.log" | sed 's/^/    /'
fi

if node "$PLUGIN_DIR/scripts/ui-check-tasks.mjs" >"$SYNTAX_TMP/ui-tasks.log" 2>&1; then
  ok "$(tail -1 "$SYNTAX_TMP/ui-tasks.log")"
else
  bad "scripts/ui-check-tasks.mjs 未通过（跑 node scripts/ui-check-tasks.mjs 看详情）"
  tail -20 "$SYNTAX_TMP/ui-tasks.log" | sed 's/^/    /'
fi

if node "$PLUGIN_DIR/scripts/ui-check-boost.mjs" >"$SYNTAX_TMP/ui-boost.log" 2>&1; then
  ok "$(tail -1 "$SYNTAX_TMP/ui-boost.log")"
else
  bad "scripts/ui-check-boost.mjs 未通过（跑 node scripts/ui-check-boost.mjs 看详情）"
  tail -20 "$SYNTAX_TMP/ui-boost.log" | sed 's/^/    /'
fi

echo ""
echo "→ 加速清理的护栏（路径合法 / 在用即跳过 / 目录表 / 诊断兜底）"
if node "$PLUGIN_DIR/scripts/boost-check.mjs" >"$SYNTAX_TMP/boost.log" 2>&1; then
  ok "$(tail -1 "$SYNTAX_TMP/boost.log")"
else
  bad "scripts/boost-check.mjs 未通过（跑 node scripts/boost-check.mjs 看详情）"
  tail -20 "$SYNTAX_TMP/boost.log" | sed 's/^/    /'
fi

echo ""
echo "→ AI 自动补全（重叠求插入片段 / 设置边界 / 缓存 / 路由）"
if node "$PLUGIN_DIR/scripts/autocomplete-check.mjs" >"$SYNTAX_TMP/autocomplete.log" 2>&1; then
  ok "$(tail -1 "$SYNTAX_TMP/autocomplete.log")"
else
  bad "scripts/autocomplete-check.mjs 未通过（跑 node scripts/autocomplete-check.mjs 看详情）"
  tail -20 "$SYNTAX_TMP/autocomplete.log" | sed 's/^/    /'
fi

if node "$PLUGIN_DIR/scripts/ui-check-autocomplete.mjs" >"$SYNTAX_TMP/ui-autocomplete.log" 2>&1; then
  ok "$(tail -1 "$SYNTAX_TMP/ui-autocomplete.log")"
else
  bad "scripts/ui-check-autocomplete.mjs 未通过（跑 node scripts/ui-check-autocomplete.mjs 看详情）"
  tail -20 "$SYNTAX_TMP/ui-autocomplete.log" | sed 's/^/    /'
fi

echo ""
echo "→ 版本一致性"
# 约定：package.json 的 version == CHANGELOG 里最高的那个已发布版本号。
# 版本号只由 `pnpm release` 改动 —— 它把两处一起算、一起写。
#
# ⚠️ 还没发过版时（CHANGELOG 只有 Unreleased 节，没有带版本号的节）跳过这条：
#    本仓库的首次发布还没发生，package.json 的 0.1.0 是「待发布的版本」，
#    与「已发布版本」本来就不是一回事。等 pnpm release 落下 0.1.0 节之后，
#    这条检查才有意义、也才会真正生效。
if [ -f "$PLUGIN_DIR/CHANGELOG.md" ]; then
  PKG_VER=$(node -p "require('$PLUGIN_DIR/package.json').version")
  TOP_VER=$(grep -E '^## [0-9]+[.][0-9]+[.][0-9]+' "$PLUGIN_DIR/CHANGELOG.md" | head -1 | sed 's/^## //' | sed 's/ ·.*//')
  if [ -z "$TOP_VER" ]; then
    if grep -qE '^## Unreleased' "$PLUGIN_DIR/CHANGELOG.md"; then
      skip "CHANGELOG 里还没有已发布版本节（只有 Unreleased）—— 首次发布前跳过"
    else
      bad "CHANGELOG.md 里既没有版本节也没有 Unreleased 节 —— 补一节再发布"
    fi
  elif [ "$PKG_VER" = "$TOP_VER" ]; then
    ok "package.json ($PKG_VER) == CHANGELOG 最新已发布节"
  else
    bad "package.json ($PKG_VER) ≠ CHANGELOG 最新已发布节 ($TOP_VER) —— 跑 pnpm release 对齐"
  fi
else
  skip "还没有 CHANGELOG.md —— 跳过版本一致性检查"
fi

echo ""
if [ "$FAIL" = "0" ]; then
  echo "✓ 全部通过"
  exit 0
else
  echo "✗ 有检查未通过（见上面 ✗ 行）"
  exit 1
fi
