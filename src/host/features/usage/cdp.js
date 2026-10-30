// src/host/features/usage/cdp.js
//
// 最小可用的 Chrome 驱动（零依赖）。
//
// 为什么不用 Playwright / Puppeteer：这个插件至今一条依赖都没有，Node 22+ 自带
// WebSocket，而我们需要的能力其实很窄 —— 拉起一个**带持久化 profile** 的 Chrome、
// 打开一个 URL、在页面里读一个值、关掉它。为此装一个几十 MB 的运行时并不划算，
// 而且 `npx playwright` 在无人值守的定时任务里还要现下载浏览器。
//
// 做法是直接说 DevTools 协议：
//   Chrome --remote-debugging-port=0 → stderr 打印浏览器级 ws 地址
//   → WebSocket 连上 → Target.createTarget / attachToTarget（扁平会话）
//   → Page.navigate / Runtime.evaluate 干活 → Browser.close 收工。
//
// **profile 必须持久化**：这正是「一次授权、长期免登」的全部秘密所在。钉钉的登录
// 态在自己的 cookie 里，profile 一旦被删，下次就得重新扫码。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 单条 DevTools 命令的默认超时。超过就该当成失败，而不是继续等下去。 */
const DEFAULT_COMMAND_TIMEOUT_MS = 15000;

/** 各平台 Chrome 的常见安装位置。按顺序探测，第一个存在的胜出。 */
const CHROME_PATHS = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

/**
 * 找到本机的 Chrome。找不到就抛出可执行的指引，而不是让调用方猜。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} 可执行文件路径。
 */
export function resolveChrome(env = process.env) {
  const override = env.DSH_CHROME_PATH;
  if (typeof override === 'string' && override.trim() !== '') {
    if (!existsSync(override)) throw new Error(`DSH_CHROME_PATH 指向的文件不存在：${override}`);
    return override;
  }
  for (const candidate of CHROME_PATHS[process.platform] ?? []) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 Chrome。装一个 Google Chrome，或用 DSH_CHROME_PATH 指定可执行文件路径。');
}

/** 传给 Chrome 的固定参数：安静、少做事、别弹任何 UI。 */
function chromeArgs({ userDataDir, headless }) {
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-sync',
    '--disable-extensions',
    '--disable-features=Translate,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion',
    '--no-service-autorun',
    '--password-store=basic',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');
  return args;
}

/**
 * DevTools 协议客户端。
 *
 * 只封了续期真正需要的方法；每条命令都是一个 Promise，事件用 `on()` 订阅。
 * 浏览器级连接 + 一个扁平化 attach 的标签页会话。
 */
export class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    socket.addEventListener('message', (event) => { this.#dispatch(String(event.data)); });
    socket.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('DevTools 连接已关闭'));
      this.pending.clear();
    });
  }

  #dispatch(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${message.error.message}（${message.error.code ?? 'CDP'}）`));
      else entry.resolve(message.result ?? {});
      return;
    }
    const handlers = this.listeners.get(message.method);
    if (handlers === undefined) return;
    for (const handler of [...handlers]) {
      try { handler(message.params ?? {}); } catch { /* 事件处理器不该拖垮连接 */ }
    }
  }

  /**
   * 发一条协议命令。
   *
   * **每条命令都必须有超时。** DevTools 对某些命令（例如 `Browser.close`）不保证回包，
   * 没有超时的话调用方就永久挂在那里。踩过的坑：续期流程收尾时 await Browser.close
   * 卡了两分钟，浏览器端那个「正在续期…」按钮就一直转，用户完全不知道发生了什么。
   * 一个挂死的 HTTP 请求比一个报错难查一百倍。
   *
   * @param {string} method 例如 Page.navigate。
   * @param {object} params 参数。
   * @param {string} [sessionId] 目标会话；省略表示浏览器级命令。
   * @param {number} [timeoutMs] 超时（默认 15 秒）。
   * @returns {Promise<object>}
   */
  send(method, params = {}, sessionId, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error('DevTools 连接已关闭'));
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      const wrap = (fn) => (value) => { clearTimeout(timer); fn(value); };
      this.pending.set(id, { resolve: wrap(resolve), reject: wrap(reject) });
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /**
   * 订阅事件。
   *
   * @param {string} method 事件名。
   * @param {(params: object) => void} handler 回调。
   * @returns {() => void} 退订函数。
   */
  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => { this.listeners.get(method)?.delete(handler); };
  }

  /** 断开连接（不负责关浏览器）。 */
  close() {
    this.closed = true;
    try { this.socket.close(); } catch { /* 已经断了就算了 */ }
  }
}

/**
 * 拉起一个 Chrome 并连上它的 DevTools。
 *
 * @param {{userDataDir: string, headless?: boolean, timeoutMs?: number, onLog?: (text: string) => void}} options
 * @returns {Promise<{client: CdpClient, process: import('node:child_process').ChildProcess, browserTargetId: string}>}
 */
export async function launchChrome(options) {
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 30000;
  const log = typeof options.onLog === 'function' ? options.onLog : () => {};
  const userDataDir = options.userDataDir;
  await mkdir(userDataDir, { recursive: true, mode: 0o700 });

  const executable = resolveChrome();
  const child = spawn(executable, chromeArgs({ userDataDir, headless: options.headless === true }), {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Chrome 启动超时（${timeoutMs}ms）—— 没等到 DevTools 地址`));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += String(chunk);
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buffer);
      if (match === null) return;
      cleanup();
      resolve(match[1]);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Chrome 启动即退出（code=${code}）：${buffer.trim().split('\n').slice(-3).join(' ')}`));
    };
    const onError = (error) => { cleanup(); reject(error); };
    function cleanup() {
      clearTimeout(timer);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    }
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });

  log(`Chrome 已启动：${executable}`);
  const client = await connect(wsUrl);
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  return { client, process: child, browserTargetId: targetId };
}

/**
 * 连上一个已经在跑的 DevTools 端点（`/json/version` 里的 webSocketDebuggerUrl）。
 *
 * @param {string} wsUrl
 * @returns {Promise<CdpClient>}
 */
export async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接 DevTools 超时')), 15000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('无法连接 Chrome 的 DevTools 端口')); }, { once: true });
  });
  return new CdpClient(socket);
}

/**
 * 浏览器会话：把「一个标签页」这件事包起来，让调用方只关心 navigate / evaluate。
 */
export class BrowserSession {
  /**
   * @param {CdpClient} client
   * @param {string} targetId
   */
  constructor(client, targetId) {
    this.client = client;
    this.targetId = targetId;
    this.sessionId = null;
  }

  /** 附上这个标签页并打开需要的协议域。 */
  async open() {
    const { sessionId } = await this.client.send('Target.attachToTarget', { targetId: this.targetId, flatten: true });
    this.sessionId = sessionId;
    await this.client.send('Page.enable', {}, this.sessionId);
    await this.client.send('Runtime.enable', {}, this.sessionId);
    return this;
  }

  /**
   * 打开一个 URL。
   *
   * @param {string} url
   */
  async navigate(url) {
    await this.client.send('Page.navigate', { url }, this.sessionId);
  }

  /** 把标签页切到前台（headed 模式下让用户看得见）。 */
  async bringToFront() {
    try { await this.client.send('Page.bringToFront', {}, this.sessionId); } catch { /* 无头模式没有前台 */ }
  }

  /**
   * 在当前页面里求值。
   *
   * @param {string} expression
   * @returns {Promise<unknown>} 按值返回的结果。
   */
  async evaluate(expression) {
    const result = await this.client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, this.sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '页面内求值失败');
    }
    return result.result?.value;
  }

  /**
   * 订阅事件（自动带上本会话的 sessionId）。
   *
   * @param {string} method
   * @param {(params: object, sessionId: string|undefined) => void} handler
   * @returns {() => void}
   */
  on(method, handler) {
    return this.client.on(method, (params) => handler(params, this.sessionId));
  }
}

/**
 * 一次性开一个会话、用完就关（含异常路径与进程兜底 kill）。
 *
 * 没有它的话，每条 early-return 都要自己写一遍 close()，漏一条就会在用户机器上
 * 留下一堆后台 Chrome —— 这是驱动类代码最常见的泄漏方式。
 *
 * @template T
 * @param {{userDataDir: string, headless?: boolean, onLog?: (text: string) => void}} options
 * @param {(session: BrowserSession) => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function withSession(options, run) {
  const launched = await launchChrome(options);
  const session = await new BrowserSession(launched.client, launched.browserTargetId).open();
  try {
    return await run(session);
  } finally {
    // 收尾每一步都必须有界：Browser.close 不保证回包（实测能卡住整整两分钟，
    // 把调用方的 HTTP 请求一起拖死），所以这里显式给短超时，并且无论关没关掉
    // 都走到 kill —— 宁可强杀，也绝不在这里无限期等着。
    try { await launched.client.send('Browser.close', {}, undefined, 5000); } catch { /* 可能已经关了 */ }
    launched.client.close();
    await Promise.race([
      new Promise((resolve) => { launched.process.once('exit', resolve); }),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (launched.process.exitCode === null) {
      try { launched.process.kill('SIGKILL'); } catch { /* 已经退出了 */ }
    }
  }
}

/** 默认 profile 目录：钉钉的登录态放这里，删了就得重新授权。 */
export function defaultProfileDir(appDir, name) {
  return join(appDir, 'profiles', name);
}

/** 用户主目录下的 Chrome profile（仅在用户显式要求复用时才会用到）。 */
export function userChromeProfile(env = process.env) {
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library/Application Support/Google/Chrome');
  if (process.platform === 'win32') return join(home, 'AppData/Local/Google/Chrome/User Data');
  return join(home, '.config/google-chrome');
}
