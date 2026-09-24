// 场景脚本共用的台架：启动、挂载、拿一个「扩展页面」上下文来驱动扩展 API、
// 驱动设置页 UI、读存储、查假引擎统计。
//
// 为什么用设置页而不是 service worker 做调度入口：CDP 挂到一个休眠的 MV3 worker 时，
// 它的执行上下文里 `chrome` 是未定义的（worker 脚本还没跑起来），求值只能拿到
// ReferenceError。设置页是同一个扩展的普通页面，chrome.* 全套可用，且它本身就是被测对象之一。
//
// 写新的场景脚本之前先读 `docs/qa/2026-09-24-measurement-traps.md`（十个会骗读数的坑：零延迟、闸放晚、旧标签页、
// 两级缓存、通知类消息的替身、"只看 DOM 判断一轮跑完了"、并发日志 doneAt 记错条目、
// "注入时钟的起点把产品初值缺陷判成通过"、"刷新常驻页把自己注入的助手一起刷掉"、
// "译文在 shadow DOM 里，读宿主的 textContent 永远是空"）。
import { startMock, startChrome, loadUnpacked, kill, loadDir, sleep, FIXTURE_BASE, PROFILE_DIR, PORT } from './harness.mjs';
import { Cdp } from './cdp.mjs';
import { rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export { sleep, FIXTURE_BASE };

export const ENGINE_BASE = `http://127.0.0.1:8787/v1`;
export const PATTERN = 'http://127.0.0.1:8787/*';
export const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'state.json');

/**
 * 把 `qaFindTab` 装到扩展页上（所有 `openFixture` 靠它把 URL 里的 token 换成 tabId）。
 * **可重复调用**：常驻实例里这个页面可能被 Chrome 丢弃或重载（内存节省模式一 discard，
 * 页面上的全局就没了——实测扫到一半报 `qaFindTab is not defined`），所以 `openFixture`
 * 每次先自己补装一次，而不是只在 `boot()` 时装那一次。
 */
async function installFindTab(cdp, sessionId) {
  return cdp.eval(
    sessionId,
    `globalThis.qaFindTab = async (name) => {
      const tabs = await chrome.tabs.query({});
      const byUrl = tabs.find((t) => (t.url ?? '').includes(name));
      if (byUrl) return byUrl.id;
      const active = await chrome.tabs.query({ active: true, currentWindow: true });
      return active[0]?.id ?? -1;
    }; 'ok'`,
  );
}

/**
 * JY_QA_ATTACH=1：连到 daemon 已经起好的那个 Chrome（授权在里面是活的），
 * 而不是每次重启——CDP 挂载的 unpacked 扩展**每次启动都会丢掉已授权的 host**。
 */
export async function boot() {
  const attach = process.env.JY_QA_ATTACH === '1';
  let mock = null;
  let child = null;
  let cdp;
  let id;
  if (attach) {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    cdp = await Cdp.connect(PORT.cdp);
    id = state.id;
  } else {
    mock = await startMock();
    ({ child, cdp } = await startChrome());
    id = await loadUnpacked(cdp, loadDir());
    writeFileSync(STATE_FILE, JSON.stringify({ id, cdp: PORT.cdp }, null, 1));
  }
  const keep = process.env.JY_QA_KEEP === '1';

  const ext = await cdp.openTab(`chrome-extension://${id}/options/options.html`);
  await sleep(1200);
  await installFindTab(cdp, ext.sessionId);

  const api = {
    cdp,
    id,
    mock,
    child,
    ext,
    sleep,
    async close() {
      if (attach) {
        // 常驻模式：只断开自己的调试连接。**不关标签页**——关掉窗口里最后一个标签页会让
        // Chrome 整个退出，把 daemon 与它的授权一起带走（实测踩过一次）。
        cdp.ws.close();
        return;
      }
      // 必须**干净退出** Chrome：宿主授权写在 Secure Preferences 里，只有正常关闭才会落盘。
      await cdp.send('Browser.close').catch(() => {});
      await sleep(2000);
      await kill(child);
      await kill(mock);
      if (!keep) rmSync(PROFILE_DIR, { recursive: true, force: true });
    },
    opened: [],
    track(t) {
      api.opened.push(t.targetId);
      return t;
    },
    async closeTab(targetId) {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    },
    async extEval(expr) {
      return cdp.eval(ext.sessionId, expr);
    },
    async activate(targetId) {
      await cdp.send('Target.activateTarget', { targetId });
      await sleep(300);
    },
    async openFixture(name) {
      // URL 上带一次性 token：常驻实例里堆着上一轮的同名标签页，后台按 URL 找标签页时
      // 它们全是候选者（实测把翻译发进了旧标签页，新页面什么都没发生）。
      // token 只写在 URL 上、不做全局变量，正是为了**标签页被丢弃重载也不会失效**；
      // 页面全局（qaFindTab）反而是会没的，所以这里每次都补装一次。
      const token = `qa${Date.now()}${Math.floor(Math.random() * 1e4)}`;
      const t = api.track(await cdp.openTab(`${FIXTURE_BASE}/${name}?token=${token}`));
      await api.activate(t.targetId);
      await sleep(1200);
      await installFindTab(cdp, ext.sessionId);
      const tabId = await api.extEval(`qaFindTab(${JSON.stringify(token)})`);
      api.lastFixture = { ...t, tabId, name, token };
      return api.lastFixture;
    },
    /** 走扩展后台消息通道给内容脚本发消息（等价于点弹窗按钮 / 按 Alt+T 的那一条链路）。 */
    async sendToPage(type, payload = {}) {
      const target = api.lastFixture;
      if (!target) throw new Error('还没打开测试页面');
      await api.activate(target.targetId);
      return api.extEval(
        `(async () => { const t = await qaFindTab(${JSON.stringify(target.token)}); ` +
          `return await chrome.tabs.sendMessage(t, ${JSON.stringify({ type, ...payload })}); })()`,
      );
    },
    /**
     * 只把消息发出去、**不等回应**。
     * 内容脚本的 `translate-page` 处理器要等整轮翻完才 sendResponse，接真实（或故意拖慢的）
     * 引擎时这个 promise 会挂几十秒，await 它会被调试通道的超时掐掉——测延迟必须用这条。
     */
    async fireToPage(type, payload = {}) {
      const target = api.lastFixture;
      if (!target) throw new Error('还没打开测试页面');
      await api.activate(target.targetId);
      return api.extEval(
        `(async () => { const t = await qaFindTab(${JSON.stringify(target.token)});
          chrome.tabs.sendMessage(t, ${JSON.stringify({ type, ...payload })}).catch(() => {});
          return 'sent'; })()`,
      );
    },
    async pageState() {
      return api.sendToPage('jinyi:get-page-state');
    },
    async engineCtl(body) {
      const res = await fetch(`http://127.0.0.1:8787/__ctl`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json();
    },
    async engineStats() {
      return (await fetch(`http://127.0.0.1:8787/__ctl`)).json();
    },
    async engineLog() {
      return (await fetch(`http://127.0.0.1:8787/__log`)).json();
    },
  };
  return api;
}

/**
 * 走**真实设置页 UI**建一个指向本地假引擎的档案（不复用任何内部函数）。
 * 填值用 JS（vanilla 代码在保存时读 .value），但「保存」这一下用真鼠标点击——
 * 可选宿主权限必须在用户手势里申请，JS 合成点击不会被 Chrome 认。
 */
export async function seedProfileViaUi(api, { label = 'QA Mock', key = 'mock-key', model = 'mock-mini' } = {}) {
  const tab = await api.cdp.openTab(`chrome-extension://${api.id}/options/options.html`);
  await sleep(1200);
  const prepared = await api.cdp.eval(
    tab.sessionId,
    `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      document.getElementById('add-profile').click();
      await wait(300);
      const ed = [...document.querySelectorAll('.profile-editor')].pop();
      if (!ed) return JSON.stringify({ error: '没有展开出编辑框' });
      const set = (sel, value) => {
        const el = ed.querySelector(sel);
        if (!el) return '缺控件 ' + sel;
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return null;
      };
      let err = set('.profile-label', ${JSON.stringify(label)}) ?? set('.profile-base-url', ${JSON.stringify(ENGINE_BASE)})
        ?? set('.profile-api-key', ${JSON.stringify(key)});
      if (err) return JSON.stringify({ error: err });
      ed.querySelector('[data-action="add-model"]').click();
      await wait(200);
      err = set('.profile-model-new', ${JSON.stringify(model)});
      if (err) return JSON.stringify({ error: err });
      ed.querySelector('[data-action="confirm-model"]').click();
      await wait(300);
      const save = ed.querySelector('[data-action="save-profile"]');
      if (!save) return JSON.stringify({ error: '没有保存按钮' });
      const rect = save.getBoundingClientRect();
      return JSON.stringify({
        x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
        models: [...ed.querySelectorAll('.model-row')].map((r) => r.textContent.trim().slice(0, 40)),
      });
    })()`,
  );
  const info = JSON.parse(prepared);
  if (info.error) return { error: info.error };

  await api.cdp.mouse(tab.sessionId, 'mousePressed', info.x, info.y);
  await api.cdp.mouse(tab.sessionId, 'mouseReleased', info.x, info.y);
  await sleep(1200);
  const granted = await api.cdp.eval(
    tab.sessionId,
    `chrome.permissions.contains({ origins: ['http://127.0.0.1:8787/*'] })`,
  );
  const status = await api.cdp.eval(
    tab.sessionId,
    `([...document.querySelectorAll('#engine-section .status, #engine-status, [id*=status]')].map(e => e.textContent.trim()).filter(Boolean)[0] ?? '(无状态文本)').slice(0, 200)`,
  );
  return { granted, status, models: info.models, tab };
}
