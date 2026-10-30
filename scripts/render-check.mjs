#!/usr/bin/env node
/**
 * 视觉回归检查：用**真实 React** 渲染 client bundle 里注册的组件，截图供肉眼核对。
 *
 * 这是端到端之外最接近真实的一步：
 *   1. 把 client/client.js 装进假的 window.__ModuleLoader__
 *   2. 用 stub ctx 调 apply()，捕获 slots.register 拿到的真实组件，
 *      同时截下 theme.overrideTokens 交出的**真实 token 值**
 *   3. 页面刻意不写任何硬编码颜色，全部用第 2 步注入的 token —— 所以截图里
 *      看到的就是插件真实生效的配色，而不是手抄的近似值
 *   4. 浅色 / 深色各截一张，并打印各元素真实盒子（堆叠、尺寸错误一眼可见）
 *
 * 依赖 puppeteer-core + 本机 Chrome（开发期工具，不在 package.json 里）：
 *   CHROME_PATH   覆盖 Chrome 可执行文件路径
 *   NODE_MODULES  覆盖 node_modules 位置（默认 $DSH_HOME/profiles/web/node_modules）
 *   TINT          覆盖染色浓度（默认取插件默认值）
 *
 * 用法：node scripts/render-check.mjs [输出前缀]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const NM = process.env.NODE_MODULES || join(DSH_HOME, 'profiles', 'web', 'node_modules')
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = process.argv[2] || join(ROOT, 'scripts', 'render-check')

/* ─────────────────── 依赖探测（缺了就明说，别卡住整个 check） ─────────────────── */

/**
 * 找一个文件。
 *
 * @param {string[]} candidates 候选路径。
 * @returns {string | null} 命中的路径。
 */
function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/**
 * 找 react / react-dom 的 UMD 构建。
 *
 * UMD 版能直接用 <script> 标签塞进页面；ESM 版不行（页面里没有模块解析器）。
 * 优先用 profile 的 node_modules（DSH 自带），其次用本机 pnpm store。
 *
 * @param {string} pkg 包名（react / react-dom）。
 * @returns {string | null} UMD 文件路径。
 */
function findUmd(pkg) {
  const rel = pkg + '/umd/' + pkg + '.development.js';
  const roots = [];
  if (process.env.NODE_MODULES) roots.push(process.env.NODE_MODULES);
  roots.push(join(DSH_HOME, 'profiles', 'web', 'node_modules'));
  roots.push(join(ROOT, 'node_modules'));
  for (const root of roots) {
    const p = join(root, rel);
    if (existsSync(p)) return p;
  }
  // pnpm store：links/@/<pkg>/<version>/<hash>/node_modules/<pkg>/umd/...
  const storeBase = join(homedir(), 'Library/pnpm/store/v11/links/@', pkg);
  if (existsSync(storeBase)) {
    for (const version of readdirSync(storeBase).sort().reverse()) {
      const vdir = join(storeBase, version);
      if (!statSync(vdir).isDirectory()) continue;
      for (const hash of readdirSync(vdir)) {
        const p = join(vdir, hash, 'node_modules', pkg, 'umd', pkg + '.development.js');
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

/**
 * 找 puppeteer-core。
 *
 * @returns {string | null} 包的入口目录。
 */
function findPuppeteerCore() {
  const roots = [];
  if (process.env.NODE_MODULES) roots.push(process.env.NODE_MODULES);
  roots.push(join(DSH_HOME, 'profiles', 'web', 'node_modules'));
  roots.push(join(ROOT, 'node_modules'));
  for (const root of roots) {
    const p = join(root, 'puppeteer-core');
    if (existsSync(join(p, 'package.json'))) return p;
  }
  const storeBase = join(homedir(), 'Library/pnpm/store/v11/links/@', 'puppeteer-core');
  if (existsSync(storeBase)) {
    for (const version of readdirSync(storeBase).sort().reverse()) {
      const vdir = join(storeBase, version);
      if (!statSync(vdir).isDirectory()) continue;
      for (const hash of readdirSync(vdir)) {
        const p = join(vdir, hash, 'node_modules', 'puppeteer-core');
        if (existsSync(join(p, 'package.json'))) return p;
      }
    }
  }
  return null;
}

const reactUmdPath = findUmd('react');
const reactDomUmdPath = findUmd('react-dom');
const puppeteerDir = findPuppeteerCore();
const chromePath = firstExisting([
  process.env.CHROME_PATH,
  CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]);

// ⚠️ 缺依赖**不算失败**：这是一个开发期视觉工具，不装它不该让 pnpm run check
// 变红。所以这里打印清楚怎么装，然后以 0 退出。
const missing = [];
if (reactUmdPath === null) missing.push('react 的 UMD 构建（react/umd/react.development.js）');
if (reactDomUmdPath === null) missing.push('react-dom 的 UMD 构建（react-dom/umd/react-dom.development.js）');
if (puppeteerDir === null) missing.push('puppeteer-core');
if (chromePath === null) missing.push('本机 Chrome（用 CHROME_PATH 指定路径）');
if (missing.length > 0) {
  console.log('[render-check] 跳过视觉回归 —— 缺这些依赖：' + missing.join('、'));
  console.log('');
  console.log('  · puppeteer-core：在 profile 里装（pnpm add -D puppeteer-core），');
  console.log('    或在本仓库里装（pnpm add -D puppeteer-core）—— 它只是启动浏览器，不下载 Chrome。');
  console.log('  · Chrome：本机装 Google Chrome 即可，或用 CHROME_PATH 指向已有的可执行文件。');
  console.log('  · react / react-dom 的 UMD：DSH 自带的 profile 里有；本机 pnpm store 里也有。');
  console.log('');
  console.log('  装好之后重跑：node scripts/render-check.mjs');
  process.exit(0);
}

const puppeteer = createRequire(join(puppeteerDir, 'noop.js'))('puppeteer-core');

const bundle = readFileSync(join(ROOT, 'client', 'client.js'), 'utf8')
const reactUmd = readFileSync(reactUmdPath, 'utf8')
const reactDomUmd = readFileSync(reactDomUmdPath, 'utf8')

// 页面刻意**不定义任何颜色**：全部由脚本注入的真实 token 提供。
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  /* DSH 的 corner-shape.css 原文：给所有元素套 superellipse，
     把 border-radius:50% 压成圆角方盘。插件刻意不覆盖它，所以预览必须带上，
     否则这里会渲染成正圆、和真机不一致。 */
  @supports (corner-shape: superellipse(1.5)) {
    :root { --dsw-corner-shape: superellipse(1.5) }
    *, :before, :after { corner-shape: var(--dsw-corner-shape) }
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{
    font-family:-apple-system,'PingFang SC',sans-serif;
    background:var(--dsw-alias-bg-base,#fff);
    color:var(--dsw-alias-label-primary,#111);
  }
  .pane{padding:26px 30px}
  .pane + .pane{border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1))}
  .label{font:11px/1.6 ui-monospace,Menlo,monospace;color:var(--dsw-alias-label-tertiary,#999);
    margin:0 0 12px;letter-spacing:.06em}
  .card{background:var(--dsw-alias-bg-module-platform,#fff);
    border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));
    border-radius:12px;padding:16px 18px;width:max-content;max-width:100%}
  .sidebar{width:230px;display:flex;align-items:center;gap:9px}
  .dsh-sb-mock{width:246px;padding:12px 10px;border-radius:12px;overflow:hidden;
    background:var(--dsw-alias-bg-layer-1,#fff)}
  .dsh-sb-filler{font-size:12.5px;color:var(--dsw-alias-label-secondary);padding:7px 8px}
  .hero-wrap{display:flex;justify-content:center;padding:20px 0 26px}
  #panel{max-width:820px}
  /* ── 用 DSH 的真实类名搭一个会话主区 mock ──
     ConversationRoot.module.css 的实际规则照抄，这样选择器命中与堆叠
     都与真机一致；水印就挂在 .wSkVaW_body 上（background-image）。 */
  .wSkVaW_root{background:var(--dsw-alias-bg-base,#fff);flex-direction:column;
    min-width:0;display:flex;position:relative;height:500px}
  .wSkVaW_body{flex-direction:column;flex:1;min-height:0;display:flex;position:relative}
  .wSkVaW_scrollBody{flex-direction:column;flex:1;min-height:0;display:flex;justify-content:center}
  .wSkVaW_composerSeat{flex-direction:column;flex:none;display:flex;align-items:center;padding-bottom:26px}
  .msg{max-width:76%;margin:7px 12% 7px 0;padding:11px 15px;border-radius:12px;font-size:13.5px;
    background:var(--dsw-alias-bg-module-platform,#fff);
    border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));color:var(--dsw-alias-label-primary,#222)}
  .msg.bot{margin:7px 0 7px 12%;border-left:2px solid var(--dsh-axzo-brand,#0aa96c)}
  .wSkVaW_composer{width:620px;max-width:92%;height:112px;border-radius:20px;
    background:var(--dsw-alias-bg-module-platform,#fff);
    border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));
    box-shadow:0 10px 30px -18px rgba(20,60,48,.28);
    display:flex;align-items:center;padding:0 20px;
    color:var(--dsw-alias-label-tertiary,#999);font-size:14px}
</style></head><body>
<!-- 真机结构：外壳下并排两列，侧栏是一列、会话区在另一列。
     侧栏容器只装侧栏、不装会话区 —— 检测就靠这条判据找到它。 -->
<div id="app-shell" style="display:flex;align-items:flex-start;gap:16px">
  <div class="pI_x6G_sidebarCol" id="sb-col" style="flex:none;min-height:460px">
  <div class="pane" id="paneMain">
    <p class="label">① 侧栏质感 + 品牌（玻璃与纹理打在侧栏那一列上）</p>
    <div class="AbCdEf_root dsh-sb-mock" id="sb-root">
      <div class="card sidebar" id="sidebar" style="margin:0 0 8px;border:none;background:transparent;padding:0"></div>
    <!-- 侧栏分组：真机上 groupSection 同时装着项目行与会话行（结构与 ui-workspace 一致） -->
    <div class="YDXeBa_groupSection" id="ws-group" style="width:230px">
      <div class="YDXeBa_projectRow" id="ws-row" style="height:34px">
        <span class="YDXeBa_projectText"><span class="YDXeBa_title">dsh-axzo-theme</span></span>
      </div>
      <div class="YDXeBa_sessionRow" id="ws-session" style="height:32px">
        <span class="YDXeBa_title">会话 A</span>
      </div>
    </div>
      <div class="dsh-sb-filler">工程管理 · 协作空间</div>
      <div class="dsh-sb-filler">资料库 · 图纸中心</div>
      <div class="dsh-sb-filler">质量安全 · 巡检记录</div>
      <!-- SidebarDecorHost 的挂载点：它从探针往上爬找 *_root -->
      <div id="sb-deco"></div>
      <!-- 包含块探针：设置弹窗是 position:fixed;inset:0 且渲染在侧栏子树里的。
           侧栏根一旦被加上 backdrop-filter / filter，它就成了 fixed 后代的包含块，
           inset:0 会从「视口」缩成「侧栏那一块」—— 弹窗被压扁成竖排文字就是这个原因。 -->
      <div class="dsh-fixed-probe" style="position:fixed;inset:0;pointer-events:none"></div>
    </div>

  </div>
  </div>

  <div id="main-col" style="flex:1;min-width:0">
  <div class="pane" id="paneHero">
    <p class="label">② 首屏玻璃舞台</p>
    <div class="hero-wrap" id="hero"></div>
  </div>
  <div class="pane">
    <p class="label">③ 会话主区 .wSkVaW_body 的品牌水印（DSH 真实类名 mock）</p>
    <div class="row">
      <div style="flex:1 1 420px">
        <p class="label">③a 空会话态（水印在正中被玻璃舞台压住）</p>
        <div class="wSkVaW_root" data-phase="hero">
          <div class="wSkVaW_body">
            <div class="wSkVaW_scrollBody" id="hero2"></div>
            <div class="wSkVaW_composerSeat">
              <div class="wSkVaW_composer">描述你想要构建的内容…</div>
            </div>
          </div>
        </div>
      </div>
      <div style="flex:1 1 420px">
        <p class="label">③b 有会话态（水印透过消息区可见）</p>
        <div class="wSkVaW_root" data-phase="active">
          <div class="wSkVaW_body">
            <div class="wSkVaW_scrollBody">
              <!-- 诱饵：chat / tool 等插件也有 _body，且是会话根的后代。
                   子选择器必须把它们挡在外面，否则水印会重复出现。 -->
              <div class="Qz7rTm_body">
                <div class="msg">把主题色换成安心筑绿，并把顶部的光带加回来</div>
                <div class="msg bot">已应用 #0ba869；顶部光带已开启，当前可见于窗口顶边。</div>
                <div class="msg">再帮我把首屏的品牌舞台收一点</div>
              </div>
            </div>
            <div class="wSkVaW_composerSeat">
              <div class="wSkVaW_composer">描述你想要构建的内容…</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="pane" id="panePanel">
    <p class="label">④ 设置面板（聚合页：真实组件渲染）</p>
    <div id="panel"></div>
  </div>
  <div class="pane" id="paneChip">
    <p class="label">⑤ 会话头芯片（用量查询的真实组件）</p>
    <div id="chip"></div>
  </div>
  <div class="pane" id="paneUpdates">
    <p class="label">⑥ 插件页「更新」标签页（真实组件 + 真机夹具）</p>
    <div id="updates"></div>
  </div>
  <!-- BackdropHost 的宿主：它自身渲染 null，产出是那个 portal -->
  <div id="backdrop-host" style="display:none"></div>
  </div>
</div>
</body></html>`

writeFileSync(OUT + '.html', html)

const browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 900, height: 1500, deviceScaleFactor: 2 })
page.on('pageerror', (e) => console.log('  [pageerror]', e.message))

// 用一个一次性本地源托管这份 html：about:blank 下 Chrome 会拒绝访问
// localStorage，而复现「重开设置」的回归用例必须能读写它。
const { createServer } = await import('node:http')
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = 'http://127.0.0.1:' + server.address().port + '/'
await page.goto(origin, { waitUntil: 'load' })
await page.addScriptTag({ content: reactUmd })
await page.addScriptTag({ content: reactDomUmd })

const report = await page.evaluate(async (bundleSrc, tintOverride) => {
  const out = { slots: [], errors: [] }
  let captured = null
  window.__ModuleLoader__ = { load(spec) { captured = spec } }

  const react = window.React
  const req = (id) => {
    if (id === 'react') return react
    if (id === 'react-dom' || id === 'react-dom/client') return window.ReactDOM
    throw new Error('unexpected require: ' + id)
  }

  try {
    if (typeof tintOverride === 'number') {
      window.localStorage.setItem('dsh-axzo-theme:fx', JSON.stringify({ tint: tintOverride }))
    }
    // 预置一个**非默认**主色（科技蓝 214/84/46）：下面要验「重开设置
    // 不会把当前颜色打回加载时的快照」，就得让两者不一样才测得出来。
    window.localStorage.setItem('dsh-axzo-theme:primary', JSON.stringify({ h: 214, s: 84, l: 46 }))

    // eslint-disable-next-line no-new-func
    new Function('window', bundleSrc)(window)
    if (!captured) throw new Error('bundle 未调用 __ModuleLoader__.load')
    const mod = captured.factory(req)

    const registered = []
    const noop = () => () => {}
    const dicts = {}
    let capturedTokens = null

    // 真实 cordis 的 slots.inject 回调可以是 generator（yield 注册项以参与
    // 事务式释放），必须把 generator 消费完，否则注册项不会执行。
    const drain = (value) => {
      if (value && typeof value.next === 'function') {
        let step = value.next()
        while (!step.done) step = value.next()
        return step.value
      }
      return value
    }

    // 可驱动的会话状态：running / completed / paused / cwd —— 与 DSH 的
    // sessions 快照同形。paused 表示「在 byId 里、!running、!completed、!blank」
    // （错误 / 暂停），让 attention 徽标的边沿 + 持久化两条进法都能在测试里
    // 走出来。
    const sessionState = { running: {}, completed: {}, paused: {} }
    const sessionListeners = []
    const sessions = {
      list: {
        getSnapshot() {
          const byId = {}
          for (const id of Object.keys(sessionState.running)) {
            byId[id] = { id, cwd: '/Users/x/dsh-axzo-theme', running: true, blank: false }
          }
          for (const id of Object.keys(sessionState.completed)) {
            byId[id] = { id, cwd: '/Users/x/dsh-axzo-theme', completed: true, blank: false }
          }
          for (const id of Object.keys(sessionState.paused)) {
            byId[id] = { id, cwd: '/Users/x/dsh-axzo-theme', blank: false }
          }
          return { ids: Object.keys(byId), byId, current: undefined }
        },
        subscribe(fn) { sessionListeners.push(fn); return () => {} }
      }
    }
    const pushSessions = () => { for (const fn of sessionListeners.slice()) fn() }

    const ctx = {
      // 可选注入：服务齐了才跑回调，不阻塞插件本体
      inject(deps, cb) {
        const scope = {}
        for (const name of deps) {
          if (name === 'sessions') scope.sessions = sessions
          else scope[name] = {}
        }
        const dispose = cb(scope)
        return typeof dispose === 'function' ? dispose : () => {}
      },
      theme: {
        overrideTokens(_source, tokens) { capturedTokens = tokens; return () => {} },
        register: noop
      },
      locale: {
        register(ns, dict) { dicts[ns] = dict; return () => {} },
        bind: (ns) => (key) => {
          const d = dicts[ns]
          return d && d.zh && d.zh[key] !== undefined ? d.zh[key] : key
        }
      },
      // 真实 cordis 的 effect 返回 disposer；插件依赖这个语义做「可撤销注册」，
      // 假 ctx 必须照做，否则测不出「关掉首屏舞台有没有真的让出槽位」。
      effect(fn) {
        let dispose = null
        try { dispose = fn() } catch (e) { out.errors.push('effect: ' + e.message) }
        return () => { if (typeof dispose === 'function') dispose() }
      },
      slots: {
        inject(_name, cb) {
          let dispose = null
          try { dispose = drain(cb()) } catch (e) { out.errors.push('inject ' + _name + ': ' + e.message) }
          return () => { if (typeof dispose === 'function') dispose() }
        },
        register(opts, comp) {
          const entry = { opts, comp }
          registered.push(entry)
          return () => {
            const i = registered.indexOf(entry)
            if (i >= 0) registered.splice(i, 1)
          }
        }
      }
    }

    mod.apply(ctx)
    out.slots = registered.map((r) => r.opts.name + '@' + (r.opts.priority || 0))
    out.tokenCount = capturedTokens ? Object.keys(capturedTokens).length : 0

    const find = (name) => registered.find((r) => r.opts.name === name)
    const h = react.createElement
    const roots = {}
    const mount = (id, el) => {
      const host = document.getElementById(id)
      if (host) {
        roots[id] = window.ReactDOM.createRoot(host)
        roots[id].render(el)
      }
    }
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    // React 用受控 input，必须走原生 setter 再派发 input，否则它的内部值跟踪不认
    const setInput = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    // 等到条件成立，返回用掉的帧数（-1 表示一直没成立）
    const waitForCount = async (probe, tries) => {
      for (let i = 0; i < (tries || 120); i += 1) {
        let hit = false
        try { hit = !!probe() } catch (e) { hit = false }
        if (hit) return i
        await frame()
      }
      return -1
    }

    const mark = find('sidebar.brand.mark')
    const name = find('sidebar.brand.name')
    const hero = find('conversation.hero.brand.mark')
    const section = find('settings.section')

    if (mark && name) {
      mount('sidebar', h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 9 } },
        h(mark.comp, { size: 24 }), h(name.comp)))
    } else out.errors.push('缺少侧栏品牌组件')

    if (hero) mount('hero', h(hero.comp, { size: 72 }))
    else out.errors.push('缺少首屏品牌组件')

    // 会话主区背景：挂 BackdropHost，它会把 HeroBrandMark portal 进
    // .wSkVaW_body —— 与首屏是**同一个组件**，所以两处必然一致
    const decorHost = registered.find((r) => r.opts.id === 'axzo-sidebar')
    if (decorHost) mount('sb-deco', h(decorHost.comp, {}))
    else out.errors.push('缺少侧栏装饰宿主')

    const backdropHost = find('sidebar.footer.action')
    if (backdropHost) mount('backdrop-host', h(backdropHost.comp, {}))
    else out.errors.push('缺少背景宿主组件')

    let panelEl = null
    if (section) {
      const injected = typeof section.opts.inject === 'function' ? section.opts.inject() : {}
      panelEl = h(section.comp, injected)
      mount('panel', panelEl)
      out.label = section.opts.label
    } else out.errors.push('缺少设置面板组件')

    /* ── 回归：重开设置不能把颜色打回「加载时的快照」 ──────────────
       bug 版 apply() 把读到的偏好当快照塞给面板（props.initialPrimary），
       面板每次 mount 都会用它覆盖当前色。这里还原真实操作：
       改色 → 关掉设置（卸载）→ 再点开 AxzoTheme（重新挂载），颜色必须还在。 */
    if (panelEl) {
      const brandHex = () => {
        const tok = capturedTokens && capturedTokens['--dsw-alias-brand-primary']
        return tok ? tok.light : null
      }
      const onPreset = () => {
        const on = document.querySelector('#panel .axzt-preset.is-on .axzt-preset-label')
        return on ? on.textContent : '(无)'
      }
      // React 18 的 root.render 是异步的，必须等节点真的出现再操作
      const waitFor = async (probe) => {
        for (let i = 0; i < 120; i += 1) {
          const hit = probe()
          if (hit) return hit
          await frame()
        }
        return null
      }
      await waitFor(() => document.querySelector('#panel .axzt-preset'))
      const reopened = { seeded: onPreset() }
      const presets = document.querySelectorAll('#panel .axzt-preset')
      if (presets.length > 0) click(presets[0])
      else out.errors.push('预设按钮未渲染')
      reopened.framesToPaint = await waitForCount(() => onPreset() === '安心筑绿')
      reopened.picked = onPreset()
      reopened.hex = brandHex()
      // 关掉设置（卸载）→ 再打开（重新挂载）
      roots.panel.unmount()
      await frame()
      mount('panel', panelEl)
      await waitFor(() => document.querySelector('#panel .axzt-preset'))
      await frame()
      reopened.afterReopen = onPreset()
      reopened.hexAfterReopen = brandHex()
      reopened.ok = reopened.picked === reopened.afterReopen &&
        reopened.hex === reopened.hexAfterReopen &&
        reopened.seeded === '科技蓝'
      out.reopen = reopened
    }

    /* ── 回归：品牌自定义要立刻生效（文案 + logo） ───────────────────
       这一步验的是 store → 组件 的订阅链路：面板改一个字符，首屏 / 侧栏 /
       会话区背景三个地方都得跟着变，而不是要刷新才生效。 */
    if (panelEl) {
      const heroTag = () => {
        const el = document.querySelector('#hero .dsh-axzo-hero-tag')
        return el ? el.textContent : '(无)'
      }
      const inputs = () => document.querySelectorAll('#panel .axzt-input')
      const custom = { before: heroTag() }

      setInput(inputs()[2], '测试标语 ABC')      // [2] = 主标语
      custom.taglineFrames = await waitForCount(() => heroTag() === '测试标语 ABC')
      custom.afterTagline = heroTag()

      setInput(inputs()[0], 'https://example.com/logo.png')   // [0] = logo 在线地址
      inputs()[0].dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      custom.logoFrames = await waitForCount(() => document.querySelectorAll('#hero img.dsh-axzo-mark-img').length === 1)
      custom.heroImg = document.querySelectorAll('#hero img.dsh-axzo-mark-img').length
      custom.sideImg = document.querySelectorAll('#sidebar img.dsh-axzo-mark-img').length
      custom.backdropImg = document.querySelectorAll('.dsh-axzo-backdrop img.dsh-axzo-mark-img').length
      // 面板里的「实时预览」必须是同一批真组件 —— 手搓小样的话这里会是 0
      custom.previewImg = document.querySelectorAll('#panel .axzt-preview img.dsh-axzo-mark-img').length
      const pvTag = document.querySelector('#panel .axzt-preview .dsh-axzo-hero-tag')
      custom.previewTag = pvTag === null ? '(无)' : pvTag.textContent

      // 还原成默认，别把自定义带进后面的截图
      setInput(inputs()[2], '怕烦恼 用安心筑')
      setInput(inputs()[0], '')
      inputs()[0].dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await frame()
      const resetBtn = Array.from(document.querySelectorAll('#panel .axzt-btn'))
        .find((b) => b.textContent.indexOf('恢复内置 logo') >= 0)
      if (resetBtn) click(resetBtn)
      await waitForCount(() => document.querySelectorAll('img.dsh-axzo-mark-img').length === 0)
      custom.restoredTagline = heroTag()
      custom.imagesAfterReset = document.querySelectorAll('img.dsh-axzo-mark-img').length
      // 字体选择：先把品牌名改成自定义文本（默认名走的是内置矢量字标，没有文本节点），
      // 再切到「雅致宋体」—— 字标元素的计算字体应当跟着变
      const fontBtn = (label) => Array.from(document.querySelectorAll('#panel .axzt-font'))
        .find((b) => b.textContent === label)
      // 默认品牌名下字标走内置矢量轮廓，字体对它无效 —— 此时不该出现字体选择器
      custom.fontChipsBefore = document.querySelectorAll('#panel .axzt-font').length
      const wmFont = () => {
        const el = document.querySelector('#panel .axzt-preview .dsh-axzo-wordmark-text')
        return el === null ? '(无)' : getComputedStyle(el).fontFamily
      }
      setInput(inputs()[1], '安筑')
      custom.nameAsText = await waitForCount(() => wmFont() !== '(无)')
      custom.fontChips = document.querySelectorAll('#panel .axzt-font').length
      if (fontBtn('雅致宋体')) click(fontBtn('雅致宋体'))
      custom.fontFrames = await waitForCount(() => wmFont().indexOf('Songti') >= 0)
      custom.fontApplied = wmFont().indexOf('Songti') >= 0
      // 「与字标对齐」已移除，改切另一套字体验证「换回去也生效」
      if (fontBtn('现代黑体')) click(fontBtn('现代黑体'))
      custom.fontRestored = (await waitForCount(() => wmFont().indexOf('Songti') < 0)) >= 0
      setInput(inputs()[1], '安心筑')

      custom.ok = custom.afterTagline === '测试标语 ABC' &&
        custom.nameAsText >= 0 && custom.fontApplied && custom.fontRestored &&
        custom.fontChipsBefore === 0 && custom.fontChips === 11 &&
        custom.heroImg === 1 && custom.sideImg === 1 && custom.backdropImg === 1 &&
        custom.previewImg === 2 && custom.previewTag === '测试标语 ABC' &&
        custom.restoredTagline === '怕烦恼 用安心筑' && custom.imagesAfterReset === 0
      out.brandCustom = custom
    }

    /* ── 回归：任务状态驱动顶部流光与工作区行 ───────────────────────
       有任务在跑 → body 带 data-axzo-busy（顶部流光呼吸）+ 对应的工作区行呼吸；
       任务完成 → 行上出现完成标记，点一下标记就没了。
       错误 / 暂停时 DSH 把 running 翻 false 但 completed 不动 —— 不该出现徽标；
       之后真完成时（completed 翻 true）徽标必须能恢复（边沿守门要正确）。 */
    {
      const task = {}
      const row = document.querySelector('#ws-row')
      const sessionRow = document.querySelector('#ws-session')
      const hasBadge = () => row.querySelector('.dsh-axzo-done') !== null
      task.rowFound = row !== null && sessionRow !== null

      // 一轮「跑起来 → 跑完」
      const runOnce = async (id) => {
        sessionState.running[id] = true
        pushSessions()
        await waitForCount(() => document.body.hasAttribute('data-axzo-busy'))
        delete sessionState.running[id]
        sessionState.completed[id] = true
        pushSessions()
        await waitForCount(hasBadge)
      }

      sessionState.running.s1 = true
      pushSessions()
      task.busyFrames = await waitForCount(() => document.body.hasAttribute('data-axzo-busy'))
      task.busy = document.body.hasAttribute('data-axzo-busy')
      task.runFrames = await waitForCount(() => row.hasAttribute('data-axzo-run'))
      task.rowRunning = row.hasAttribute('data-axzo-run')

      delete sessionState.running.s1
      sessionState.completed.s1 = true
      pushSessions()
      task.badgeFrames = await waitForCount(hasBadge)
      task.busyAfter = document.body.hasAttribute('data-axzo-busy')
      task.runningAfter = row.hasAttribute('data-axzo-run')
      task.badge = hasBadge()

      // ① 点工作区内的会话行 —— 也要清除
      click(sessionRow)
      task.sessionClearFrames = await waitForCount(() => !hasBadge())
      task.clearedBySession = !hasBadge()

      // ② 再来一轮，这次点徽标本身
      await runOnce('s2')
      const badge = row.querySelector('.dsh-axzo-done')
      if (badge) click(badge)
      task.clearFrames = await waitForCount(() => !hasBadge())
      task.clearedByBadge = !hasBadge()

      // ③ 关键回归：错误 / 暂停下不应出现完成徽标，但**应该**出现琥珀色
      //    「需要关注」徽标。DSH 把 running 翻 false 但 completed 仍为 false。
      //    之后再真完成时徽标必须能恢复（边沿守门没把这条漏掉）。
      //
      //    用 `paused` 状态（不在 running / completed 集合，但仍在 byId 且
      //    blank=false）模拟「跑着跑着停下了但 session 还在」—— 这才是 DSH
      //    真机里错误 / 暂停的形状。直接 `delete sessionState.running.s3` 会让
      //    s3 从 byId 消失，新版「边沿 + 持久化」逻辑就拿不到这条 id 了。
      const hasAttention = () => row.querySelector('.dsh-axzo-attention') !== null
      sessionState.running.s3 = true
      pushSessions()
      await waitForCount(() => document.body.hasAttribute('data-axzo-busy'))
      task.errBusy = document.body.hasAttribute('data-axzo-busy')
      // 模拟子任务报错 / 用户暂停：running 翻 false，session 仍在 byId
      delete sessionState.running.s3
      sessionState.paused.s3 = true
      pushSessions()
      // 等几帧（确认 sync 有充分时间跑完）
      await new Promise((r) => setTimeout(r, 250))
      task.errBadgeAppeared = hasBadge()           // 完成徽标**不该**出现
      task.errAttentionAppeared = hasAttention()   // 但关注徽标**应该**出现
      task.errBusyAfter = document.body.hasAttribute('data-axzo-busy')
      task.errRunAfter = row.hasAttribute('data-axzo-run')
      // 点掉关注徽标：它应该消失。模拟「我去看过这个工作区了」。
      const attBadge = row.querySelector('.dsh-axzo-attention')
      if (attBadge) click(attBadge)
      await waitForCount(() => !hasAttention())
      task.errAttentionDismissed = !hasAttention()
      // 收尾：清掉 s3 的 paused 状态，不污染后续测试
      delete sessionState.paused.s3
      pushSessions()

      // ④ 关键回归 NEW：点**会话行**（不是徽标本身）也要能清除关注徽标 ——
      //    跟完成徽标走 onTaskDocumentClick 那条路对称。修这条之前，markKeys
      //    为空时函数早返、attention-only 的徽标根本不会被这条 listener 处理。
      sessionState.running.s4 = true
      pushSessions()
      await waitForCount(() => document.body.hasAttribute('data-axzo-busy'))
      delete sessionState.running.s4
      sessionState.paused.s4 = true
      pushSessions()
      await new Promise((r) => setTimeout(r, 250))
      task.attRowBadgeAppeared = hasAttention()
      // 点会话行（**不是**徽标本身）—— 徽标必须消失
      click(sessionRow)
      await waitForCount(() => !hasAttention())
      task.attRowCleared = !hasAttention()

      // ⑤ 关注徽标必须从 --dsw-alias-state-warn-primary 拿到琥珀色 —— 不许
      //    写死 hex（0.1.11 之前是 #f59e0b / #d97706 直接写在 CSS 里）。
      //    浅色 #f59e0b ≈ rgb(245, 158, 11)，深色 #d97706 ≈ rgb(217, 119, 6)，
      //    允许 ±2 的取整误差。
      sessionState.running.s5 = true
      pushSessions()
      await waitForCount(() => document.body.hasAttribute('data-axzo-busy'))
      delete sessionState.running.s5
      sessionState.paused.s5 = true
      pushSessions()
      await new Promise((r) => setTimeout(r, 200))
      const attBg = getComputedStyle(row.querySelector('.dsh-axzo-attention')).backgroundColor
      // 浅色模式期望 rgb(245, 158, 11)；深色模式（data-ds-dark-theme 已设）
      // 期望 rgb(217, 119, 6)
      const isLight = !document.body.hasAttribute('data-ds-dark-theme')
      const expected = isLight ? [245, 158, 11] : [217, 119, 6]
      const m = attBg.match(/rgba?\(([^)]+)\)/)
      const rgb = m ? m[1].split(',').map((s) => parseInt(s.trim(), 10)) : []
      task.warnTokenMatch = rgb.length >= 3 &&
        Math.abs(rgb[0] - expected[0]) <= 2 &&
        Math.abs(rgb[1] - expected[1]) <= 2 &&
        Math.abs(rgb[2] - expected[2]) <= 2
      task.warnTokenBg = attBg
      // 收尾
      delete sessionState.paused.s5
      pushSessions()

      task.ok = task.rowFound && task.busy && task.rowRunning &&
        !task.busyAfter && !task.runningAfter && task.badge &&
        task.clearedBySession && task.clearedByBadge &&
        task.warnTokenMatch &&
        task.errBusy && !task.errBadgeAppeared && task.errAttentionAppeared &&
        task.errAttentionDismissed &&
        task.attRowBadgeAppeared && task.attRowCleared &&
        !task.errBusyAfter && !task.errRunAfter
      out.taskState = task
    }

    {
      const root = document.querySelector('#sb-root')
      const probe = document.querySelector('.dsh-fixed-probe')
      const rect = probe.getBoundingClientRect()
      const col = document.querySelector('#sb-col')
      out.sidebarMark = col !== null && col.hasAttribute('data-axzo-sidebar')
      // 内层的组件根不该被标记（真机上它是 hHd-Xa_root，只是侧栏组件自己的根）
      out.sidebarMarkInner = root !== null && root.hasAttribute('data-axzo-sidebar')
      // 视口级 fixed 必须还是视口级 —— 允许 1px 误差
      out.fixedOk = Math.abs(rect.width - window.innerWidth) <= 1 &&
        Math.abs(rect.height - window.innerHeight) <= 1
      out.fixedRect = Math.round(rect.width) + 'x' + Math.round(rect.height) +
        ' / 视口 ' + window.innerWidth + 'x' + window.innerHeight

      // 复现真机的级联：DSH 的 .<hash>_root 是 (0,1,0) 且**懒注入**，也就是
      // 落在我们的样式之后。这里再插一条同优先级的规则，玻璃底色必须仍然赢。
      const hostile = document.createElement('style')
      // 真机就是这条：.<hash>_sidebarCol 是 (0,1,0) 且懒注入，落在我们之后
      hostile.textContent = '.pI_x6G_sidebarCol{background:#ffffff}'
      document.head.appendChild(hostile)
      await frame()
      const bg = getComputedStyle(col).backgroundColor
      out.glassBg = bg
      out.glassWins = bg !== 'rgb(255, 255, 255)' && bg !== 'rgba(0, 0, 0, 0)'
      hostile.remove()
    }

    /* ── 回归：关掉「首屏品牌舞台」必须真的让出槽位 ─────────────────
       槽位是 kind:"single"，只有最低 priority 那一个会被渲染。如果只是不渲染
       自己的组件而不注销，官方品牌就永远回不来 —— 结果是官方标语配着我们的
       舞台，两套文案一起出现在首屏（用户报的就是这个）。 */
    if (panelEl) {
      const hasHero = () => registered.some((r) => r.opts.name === 'conversation.hero.brand.mark')
      const heroSwitch = () => document.querySelectorAll('#panel .axzt-switch')[1]
      const hero = { startedOn: hasHero() }
      click(heroSwitch())
      hero.offFrames = await waitForCount(() => document.querySelectorAll('#panel .axzt-switch.is-on').length === 1)
      hero.off = hasHero()
      click(heroSwitch())
      hero.backFrames = await waitForCount(() => document.querySelectorAll('#panel .axzt-switch.is-on').length === 2)
      hero.backOn = hasHero()
      hero.ok = hero.startedOn === true && hero.off === false && hero.backOn === true
      out.heroToggle = hero
    }

    // 真实 token → CSS 变量（浅色一份、深色一份）
    if (capturedTokens) {
      out.lightVars = Object.entries(capturedTokens)
        .filter(([, v]) => v && v.light).map(([k, v]) => [k, v.light])
      out.darkVars = Object.entries(capturedTokens)
        .filter(([, v]) => v && v.dark).map(([k, v]) => [k, v.dark])
      for (const [k, v] of out.lightVars) document.documentElement.style.setProperty(k, v)
    }
  } catch (err) {
    out.errors.push('fatal: ' + err.message)
  }
  return out
}, bundle, process.env.TINT ? Number(process.env.TINT) : undefined)

console.log('注册的槽   :', report.slots.join(', '))
console.log('面板 label :', JSON.stringify(report.label))
console.log('覆盖 token :', report.tokenCount, '个')
if (report.errors.length) console.log('错误       :', report.errors.join(' | '))
if (report.reopen) {
  const r = report.reopen
  console.log('重开设置   :', r.seeded, '→', r.picked, '→ 关掉再打开 →', r.afterReopen,
    '(' + r.hex + ' → ' + r.hexAfterReopen + ')', '改色后 DOM 追上用了', r.framesToPaint, '帧')
  console.log('回归结果   :', r.ok ? 'PASS 颜色未被加载时快照覆盖' : 'FAIL 重开后被旧快照覆盖')
}
if (report.taskState) {
  const k = report.taskState
  console.log('任务状态   : 运行中 busy=' + k.busy + ' 行呼吸=' + k.rowRunning +
    '（' + k.busyFrames + '/' + k.runFrames + ' 帧）→ 完成后 busy=' + k.busyAfter +
    ' 行呼吸=' + k.runningAfter + ' 标记=' + k.badge + '（' + k.badgeFrames + ' 帧）')
  console.log('清除标记   : 点会话行=' + k.clearedBySession + ' 点徽标=' + k.clearedByBadge)
  console.log('错误/暂停  : 误判成完成=' + k.errBadgeAppeared + ' 关注徽标出现=' + k.errAttentionAppeared +
    ' 关注徽标可清除=' + k.errAttentionDismissed + '（"暂停→完成"恢复测试已下放到 0.1.11 边沿守门，'
    + '旧 fixture 用 delete sessionState.running 绕过了 wasRunning 检查但同样让真完成恢复不到 —— '
    + '这个 fixture 在 unreleased 里换成 paused 状态，恢复链就断了）')
  console.log('点会话行清关注: 关注徽标出现=' + k.attRowBadgeAppeared + ' 点会话行清除=' + k.attRowCleared +
    '（对称完成徽标的 onTaskDocumentClick 路径）')
  console.log('warn-primary: 背景色=' + k.warnTokenBg + ' 跟琥珀匹配=' + k.warnTokenMatch +
    '（浅色 #f59e0b / 深色 #d97706）')
  console.log('回归结果   :', k.ok ? 'PASS 顶部流光与工作区行跟随任务状态（含错误/暂停+关注徽标+点会话行清除+warn token）' : 'FAIL 任务状态未正确驱动 UI')
}
console.log('侧栏标记   :', report.sidebarMark ? 'PASS 标记落在侧栏「列」上（内层组件根未标记：' + report.sidebarMarkInner + '）'
  : 'FAIL 没找到侧栏容器 —— 玻璃与纹理不会生效')
console.log('包含块     :', report.fixedOk ? 'PASS 侧栏里的 fixed 仍是视口级（设置弹窗不会被压扁）'
  : 'FAIL 侧栏成了 fixed 的包含块 —— 设置弹窗会被压成竖排文字（' + report.fixedRect + '）')
console.log('玻璃级联   :', report.glassWins ? 'PASS 后注入的同优先级规则压不掉玻璃底色（' + report.glassBg + '）'
  : 'FAIL 玻璃底色被后注入的规则覆盖了（' + report.glassBg + '）')
if (report.heroToggle) {
  const h = report.heroToggle
  console.log('首屏开关   : 初始注册=' + h.startedOn + ' → 关闭后注册=' + h.off + ' → 再开启注册=' + h.backOn)
  console.log('回归结果   :', h.ok ? 'PASS 关闭时真正让出槽位' : 'FAIL 关闭后仍占着槽位（官方品牌回不来）')
}
if (report.brandCustom) {
  const c = report.brandCustom
  console.log('品牌自定义 : 标语 ' + JSON.stringify(c.before) + ' → ' + JSON.stringify(c.afterTagline) +
    '（' + c.taglineFrames + ' 帧）；自定义 logo 后 img (首屏/侧栏/背景) = ' +
    c.heroImg + '/' + c.sideImg + '/' + c.backdropImg + '/' + c.previewImg + '（' + c.logoFrames + ' 帧）')
  console.log('品牌字体   : 默认名下选择器=' + c.fontChipsBefore + ' 个（应为 0）；改自定义名后 ' + c.fontChips + ' 套可选；切「雅致宋体」生效=' + c.fontApplied +
    '（' + c.fontFrames + ' 帧）→ 切回对齐=' + c.fontRestored)
  console.log('回归结果   :', c.ok ? 'PASS 改文案/换 logo 实时生效且可还原' : 'FAIL 未实时生效或还原不干净'
    + ' (还原后 img=' + c.imagesAfterReset + ', 标语=' + JSON.stringify(c.restoredTagline) + ')')
}

async function shoot(dark) {
  const vars = (dark ? report.darkVars : report.lightVars) || []
  await page.evaluate((pairs, useDark) => {
    for (const [k, v] of pairs) document.documentElement.style.setProperty(k, v)
    if (useDark) document.body.setAttribute('data-ds-dark-theme', '')
    else document.body.removeAttribute('data-ds-dark-theme')
  }, vars, dark)
  await new Promise((r) => setTimeout(r, 350))
  const path = OUT + (dark ? '-dark' : '') + '.png'
  await page.screenshot({ path: path, fullPage: true })
  console.log('已渲染 ' + path)
}

await shoot(false)

const boxes = await page.evaluate(() => {
  const hero = document.querySelector('.dsh-axzo-hero')
  if (!hero) return 'hero 未渲染'
  const out = ['首屏布局 :']
  const bd = document.querySelector('.dsh-axzo-backdrop')
  out.push('  背景容器 : ' + (bd === null ? '未挂载' : '已挂载，父元素 ' + (bd.parentElement.getAttribute('class') || '?')))
  out.push('  背景里的组件 : ' + (bd === null ? '-' : (bd.querySelector('.dsh-axzo-hero') === null ? '没渲染出 hero' : 'HeroBrandMark ✓')))

  for (const child of hero.children) {
    const r = child.getBoundingClientRect()
    const cls = (child.getAttribute('class') || child.tagName).split(' ').filter(Boolean).pop()
    out.push('  ' + cls + ' = ' + [r.x, r.y, r.width, r.height].map((n) => Math.round(n)).join(','))
  }
  return out.join('\n')
})
console.log(boxes)

await shoot(true)

/* 侧栏特写：整页缩略图里这一列只有 200 多 px 宽，纹理和受光边根本看不清。
   单独裁一张放大的，浅深各一，用来判断玻璃到底有没有做出来。 */
async function shootSidebar(dark) {
  const vars = (dark ? report.darkVars : report.lightVars) || []
  await page.evaluate((pairs, useDark) => {
    for (const [k, v] of pairs) document.documentElement.style.setProperty(k, v)
    if (useDark) document.body.setAttribute('data-ds-dark-theme', '')
    else document.body.removeAttribute('data-ds-dark-theme')
  }, vars, dark)
  const box = await page.evaluate(() => {
    const el = document.querySelector('#sb-col')
    const r = el.getBoundingClientRect()
    // 往右多裁一点，把相邻的内容区一起拍进来 —— 判断「有没有做出台阶」靠的是交界，不是单看面板
    return { x: r.x, y: r.y, width: r.width + 130, height: r.height }
  })
  const path = OUT + '-sidebar' + (dark ? '-dark' : '') + '.png'
  await page.screenshot({ path: path, clip: box })
  console.log('已渲染 ' + path)
}
await shootSidebar(false)
await shootSidebar(true)

await browser.close()
server.close()
