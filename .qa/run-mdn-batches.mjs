// 量「你真实翻过的那一页」的段数 / 批数 / 波数：用假引擎但 D=0，
// 只为了拿到批次结构；再拿你在真机上观察到的总时长反推单请求延迟 L。
import { boot, sleep } from './lib.mjs';

const URL = process.argv[2] ?? 'https://developer.mozilla.org/en-US/docs/Web/API/Document/querySelector';
const api = await boot();
try {
  await api.extEval(
    `chrome.storage.local.get('jinyi:settings').then(o => chrome.storage.local.set({ 'jinyi:settings': ` +
      `{ ...o['jinyi:settings'], concurrency: 3, maxSegmentsPerBatch: 12, maxBatchChars: 1000 } }))`,
  );
  await api.extEval(`(async () => { for (const area of [chrome.storage.local, chrome.storage.session]) {
    const all = await area.get(null); const keys = Object.keys(all).filter((k) => k.startsWith('jt:'));
    if (keys.length) await area.remove(keys); } })()`);
  await api.engineCtl({ mode: 'ok', reset: true, delayMs: 0 });

  const t = await api.cdp.openTab(URL);
  await api.activate(t.targetId);
  for (let i = 0; i < 40; i += 1) {
    const ready = await api.cdp.eval(t.sessionId, `({ rs: document.readyState, href: location.href })`).catch(() => null);
    if (ready && ready.rs === 'complete' && ready.href.startsWith('http')) break;
    await sleep(700);
  }
  await sleep(2500);
  api.lastFixture = { ...t, name: URL };
  await api.extEval(`(async () => { const tabs = await chrome.tabs.query({});
    const hit = tabs.find((x) => (x.url ?? '').startsWith(${JSON.stringify(URL)})) ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    chrome.tabs.sendMessage(hit.id, { type: 'jinyi:translate-page' }).catch(() => {}); return 'sent'; })()`);
  for (let i = 0; i < 60; i += 1) {
    const s = await api.cdp.eval(
      t.sessionId,
      `(() => { const h = [...document.querySelectorAll('jy-translation')];
        return { hosts: h.length, pending: h.filter((x) => x.shadowRoot?.querySelector('.jy-pending')).length }; })()`,
    ).catch(() => null);
    if (s && s.hosts > 0 && s.pending === 0) break;
    await sleep(1000);
  }
  const log = (await api.engineLog()).log;
  const segs = log.reduce((a, e) => a + e.segs, 0);
  const chars = log.reduce((a, e) => a + e.chars, 0);
  const arrivals = log.map((e) => e.at).sort((a, b) => a - b);
  const dones = log.map((e) => e.doneAt ?? e.at).sort((a, b) => a - b);
  let cur = 0;
  let peak = 0;
  const ev = [...arrivals.map((x) => [x, 1]), ...dones.map((x) => [x, -1])].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  for (const [, d] of ev) {
    cur += d;
    peak = Math.max(peak, cur);
  }
  console.log(
    JSON.stringify({
      url: URL,
      段数: segs,
      批数: log.length,
      送出字符: chars,
      理论波数: Math.ceil(log.length / 3),
      实测峰值并发: peak,
      平均每批段数: +(segs / Math.max(1, log.length)).toFixed(1),
      平均每批字符: Math.round(chars / Math.max(1, log.length)),
    }, null, 1),
  );
} finally {
  await api.close();
}
