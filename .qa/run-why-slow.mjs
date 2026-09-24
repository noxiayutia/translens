// 为什么真机上 MDN 一页要 10 分钟？用测得的接口画像复现，一次只改一个变量。
//   实验 1：前台标签页 + 画像延迟（≈950ms + 3.45ms/字符）
//   实验 2：同一页、同一画像，但翻译中途把标签页切到后台
import { boot, sleep } from './lib.mjs';

const MDN = 'https://developer.mozilla.org/en-US/docs/Web/API/Document/querySelector';
const SETTLED = `(() => { const h = [...document.querySelectorAll('jy-translation')];
  return { hosts: h.length, pending: h.filter((x) => x.shadowRoot?.querySelector('.jy-pending')).length,
           errored: h.filter((x) => x.shadowRoot?.querySelector('.jy-error')).length }; })()`;

const api = await boot();

async function openMdn() {
  const t = await api.cdp.openTab(MDN);
  await api.activate(t.targetId);
  for (let i = 0; i < 40; i += 1) {
    const r = await api.cdp.eval(t.sessionId, `({ rs: document.readyState, href: location.href })`).catch(() => null);
    if (r && r.rs === 'complete' && r.href.startsWith('http')) break;
    await sleep(700);
  }
  await sleep(2500);
  api.lastFixture = { ...t, name: MDN };
  return t;
}

async function clearCache() {
  await api.extEval(`(async () => { for (const area of [chrome.storage.local, chrome.storage.session]) {
    const all = await area.get(null); const keys = Object.keys(all).filter((k) => k.startsWith('jt:'));
    if (keys.length) await area.remove(keys); } })()`);
}

async function run(label, { background }) {
  await api.extEval(`chrome.storage.local.get('jinyi:settings').then(o => chrome.storage.local.set({ 'jinyi:settings':
    { ...o['jinyi:settings'], concurrency: 3, maxSegmentsPerBatch: 12, maxBatchChars: 1000 } }))`);
  await clearCache();
  await api.engineCtl({ mode: 'ok', reset: true, delayMs: 0, profile: true });
  const t = await openMdn();
  let blocker = null;
  await api.fireToPage('jinyi:translate-page');
  if (background) {
    blocker = await api.cdp.openTab('about:blank');
    await api.activate(blocker.targetId);
  }
  const t0 = Date.now();
  let s = null;
  for (let i = 0; i < 300; i += 1) {
    await sleep(1000);
    s = await api.cdp.eval(t.sessionId, SETTLED).catch(() => null);
    if (s && s.hosts > 0 && s.pending === 0 && s.errored === 0) break;
  }
  const T = ((Date.now() - t0) / 1000).toFixed(1);
  const log = (await api.engineLog()).log;
  const durs = log.filter((e) => e.doneAt).map((e) => (e.doneAt - e.at) / 1000);
  const arrivals = log.map((e) => (e.at - t0) / 1000).sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      实验: label,
      总时长T秒: T,
      段数: log.reduce((a, e) => a + e.segs, 0),
      批数: log.length,
      单批秒数: durs.map((d) => +d.toFixed(1)),
      各批发出时刻: arrivals.map((d) => +d.toFixed(1)),
      末尾状态: s,
    }),
  );
  if (blocker) await api.closeTab(blocker.targetId);
  await api.closeTab(t.targetId);
}

try {
  await run('1 前台', { background: false });
  await run('2 中途切后台', { background: true });
} finally {
  await api.engineCtl({ profile: false });
  await api.close();
}
