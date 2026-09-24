// P4 的真机复验：进度条会不会推进、退避重试时页面上会不会真的出现「重试中(第 n 次)」。
// 这两件事单测只能证明"代码写了"，证明不了"跨进程消息真的送到了页面"。
import { boot, sleep } from './lib.mjs';

const api = await boot();
const fail = [];
try {
  await api.engineCtl({ mode: 'ok', reset: true, delayMs: 0 });
  await api.extEval(`(async () => { for (const area of [chrome.storage.local, chrome.storage.session]) {
    const all = await area.get(null); const keys = Object.keys(all).filter((k) => k.startsWith('jt:'));
    if (keys.length) await area.remove(keys); } })()`);
  const page = await api.openFixture('scale214.html');

  /* ---- 1. 进度条推进 ---- */
  // 必须给假引擎加延迟：零延迟下 18 批在 200 毫秒内全部落地，进度条刚建出来就被撤了，
  // 采不到任何中间读数（第一次跑就是这么"失败"的）。
  await api.engineCtl({ mode: 'ok', reset: true, delayMs: 900 });
  await api.fireToPage('jinyi:translate-page');
  const seen = new Set();
  for (let i = 0; i < 80; i += 1) {
    const text = await api.cdp.eval(page.sessionId, `document.getElementById('jy-progress')?.textContent ?? null`);
    if (text) seen.add(text);
    await sleep(120);
  }
  const last = await api.cdp.eval(page.sessionId, `document.getElementById('jy-progress')?.textContent ?? null`);
  const values = [...seen].map((t) => Number(/已译 (\d+)\//.exec(t)?.[1] ?? -1)).filter((n) => n >= 0);
  console.log('进度条采样到的不同读数个数:', values.length, '首=', [...seen][0], '末=', [...seen][values.length - 1]);
  console.log('收尾后进度条是否已撤掉:', last === null);
  if (values.length < 3) fail.push(`进度条没有推进（只采到 ${values.length} 个读数）`);
  if (!values.every((n, i) => i === 0 || n >= values[i - 1])) fail.push('进度条出现倒退');
  if (last !== null) fail.push(`一轮结束后进度条还在：${last}`);

  /* ---- 2. 退避重试时页面出现「重试中(第 n 次)」 ---- */
  await api.fireToPage('jinyi:restore-page');
  await api.extEval(`(async () => { for (const area of [chrome.storage.local, chrome.storage.session]) {
    const all = await area.get(null); const keys = Object.keys(all).filter((k) => k.startsWith('jt:'));
    if (keys.length) await area.remove(keys); } })()`);
  await api.engineCtl({ mode: 'rate429', reset: true, delayMs: 1500 });
  await api.fireToPage('jinyi:translate-page');
  let retrySeen = null;
  let queuedSeen = false;
  let fetchingSeen = false;
  for (let i = 0; i < 120; i += 1) {
    const texts = await api.cdp.eval(
      page.sessionId,
      `[...new Set([...document.querySelectorAll('jy-translation')].map(h => (h.shadowRoot?.querySelector('.jy-body')?.textContent ?? '').trim()))].slice(0, 8)`,
    );
    const list = texts;
    if (list.some((t) => /重试中\(第 \d+ 次\)/.test(t))) retrySeen = list.find((t) => /重试中/.test(t));
    if (list.some((t) => t === '排队中…')) queuedSeen = true;
    if (list.some((t) => t === '翻译中…')) fetchingSeen = true;
    if (retrySeen && queuedSeen && fetchingSeen) break;
    await sleep(150);
  }
  const stats = await api.engineStats();
  console.log('重试文案:', JSON.stringify(retrySeen), '排队态出现过:', queuedSeen, '请求数:', stats.requests);
  if (!retrySeen) fail.push('页面上没出现过「重试中(第 n 次)」——ATTEMPT 推送没到页面');
  if (!queuedSeen) fail.push('页面上没出现过「排队中…」');
  if (!fetchingSeen) fail.push('页面上没出现过「翻译中…」');
  await api.engineCtl({ mode: 'ok', delayMs: 0, reset: true });
} finally {
  await api.close();
  console.log(fail.length ? 'FAIL\n' + fail.join('\n') : 'PASS  P4 真机复验：进度推进 + 三态可分辨 + 重试文案到位');
}
