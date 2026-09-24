// 极简 CDP 客户端：只用 Node 标准库（fetch + 全局 WebSocket），零依赖。
// 为什么不用 puppeteer：本仓库 devDeps 里没有，且不为一次体检引入依赖。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(url, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* Chrome 还没起监听，继续等 */
    }
    await sleep(250);
  }
  throw new Error(`CDP HTTP 端点不可达: ${url}`);
}

export class Cdp {
  constructor(session) {
    this.ws = session.ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.handlers = [];
    session.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.method}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        for (const h of this.handlers) h(msg);
      }
    });
  }

  static async connect(port) {
    const info = await httpJson(`http://127.0.0.1:${port}/json/version`);
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Cdp({ ws });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 120000);
    });
  }

  onEvent(handler) {
    this.handlers.push(handler);
  }

  /** 某个 tab 的全部执行上下文（含内容脚本的 isolated world，world 名通常是扩展 id）。 */
  contexts(sessionId) {
    return this.events
      .filter((e) => e.method === 'Runtime.executionContextCreated' && e.sessionId === sessionId)
      .map((e) => e.params.context);
  }

  /** 在指定 contextId（内容脚本世界）里求值。 */
  evalIn(sessionId, contextId, expression) {
    return this.send(
      'Runtime.evaluate',
      { expression, contextId, returnByValue: true, awaitPromise: true },
      sessionId,
    );
  }

  /** 页面/console 侧的报错，用来抓「扩展在真机上报了什么」。 */
  consoleErrors() {
    return this.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => ({
        url: e.params.exceptionDetails.url,
        text: e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text,
      }));
  }

  async targets() {
    return (await this.send('Target.getTargets')).targetInfos;
  }

  /** 打开一个 tab，返回 { sessionId, targetId }；attach 后默认自动 enable Runtime/Page。 */
  async openTab(url) {
    const { targetId } = await this.send('Target.createTarget', { url });
    return this.attach(targetId);
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
    return { sessionId, targetId };
  }

  async navigate(sessionId, url) {
    await this.send('Page.navigate', { url }, sessionId);
    for (let i = 0; i < 80; i += 1) {
      const ready = await this.eval(sessionId, 'document.readyState');
      if (ready === 'complete' || ready === 'interactive') return;
      await sleep(100);
    }
  }

  /** 在页面主世界求值；expression 需是一个表达式，返回值必须 JSON 可序列化。 */
  async eval(sessionId, expression) {
    const res = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (res.exceptionDetails) {
      throw new Error(
        `页面求值异常: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`,
      );
    }
    return res.result.value;
  }

  /** 派发一次按键（按下+抬起）。modifiers 用 CDP 位掩码：Alt=1 Ctrl=2 Meta=4 Shift=8。 */
  async key(sessionId, { key, code, keyCode = 0, modifiers = 0 }) {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, ...base }, sessionId);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...base }, sessionId);
  }

  /** CDP 鼠标事件：type 为 mouseMoved / mousePressed / mouseReleased / mouseWheel。 */
  async mouse(sessionId, type, x, y, opts = {}) {
    const params = { type, x, y, modifiers: opts.modifiers ?? 0 };
    if (type !== 'mouseMoved') {
      params.button = opts.button ?? 'left';
      params.clickCount = opts.clickCount ?? 1;
    } else {
      params.button = 'none';
    }
    await this.send('Input.dispatchMouseEvent', params, sessionId);
  }

  /** 在 service worker 会话里求值（表达式需返回 JSON 可序列化的值）。 */
  async swEval(sw, expression) {
    const res = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sw.sessionId,
    );
    if (res.exceptionDetails) {
      throw new Error(`SW 求值异常: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result.value;
  }

  async screenshot(sessionId) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    return Buffer.from(data, 'base64');
  }
}

export const MODIFIANTS = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };

export { sleep, httpJson };
