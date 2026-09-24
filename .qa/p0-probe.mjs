// P0 判别实验：给页面装一个「定时器还活着吗」探针，然后把标签页长时间切到后台，
// 用一条时间线把三种可能一次分开：
//   ① 429 退避风暴    → 定时器照跑（ticks 跟得上墙上时间），批一直不 settle，但请求条数在涨
//   ② 页面被冻结/节流  → 定时器停或退到 1 次/分钟（ticks 明显落后墙上时间），请求条数不动
//   ③ 真死等           → 定时器照跑，请求条数不动，且超时文案会按时出现
// 上一轮我只把标签页切到后台 9 秒就下了"无差别"的结论——那是无效的：Chrome 的
// intensive timer throttling 要隐藏满 5 分钟才生效。这次把时长推过门槛。
import { boot, sleep } from './lib.mjs';

const DELAY_MS = Number(process.env.P0_DELAY ?? 45000);
const HIDDEN_SECONDS = Number(process.env.P0_HIDDEN ?? 480);

const PROBE = `(() => {
  const p = { startedAt: Date.now(), ticks: 0, timeline: [] };
  globalThis.__qaProbe = p;
  p.timerId = setInterval(() => {
    p.ticks += 1;
    p.timeline.push([Date.now() - p.startedAt, document.visibilityState]);
  }, 1000);
  return 'probe-on';
})()`;

const api = await boot();
try {
  await api.extEval(
    `chrome.storage.local.get('jinyi:settings').then(o => chrome.storage.local.set({ 'jinyi:settings': ` +
      `{ ...o['jinyi:settings'], concurrency: 3, maxSegmentsPerBatch: 12, maxBatchChars: 1000 } }))`,
  );
  await api.extEval(`(async () => { for (const area of [chrome.storage.local, chrome.storage.session]) {
    const all = await area.get(null); const keys = Object.keys(all).filter((k) => k.startsWith('jt:'));
    if (keys.length) await area.remove(keys); } })()`);
  await api.engineCtl({ mode: 'ok', reset: true, delayMs: DELAY_MS, profile: false });

  const page = await api.openFixture('scale214.html');
  await api.cdp.eval(page.sessionId, PROBE);
  await api.fireToPage('jinyi:translate-page');
  await sleep(2000);

  const blocker = await api.cdp.openTab('about:blank');
  await api.activate(blocker.targetId);
  console.log(`已切后台，隐藏 ${HIDDEN_SECONDS} 秒（单批延迟 ${DELAY_MS}ms，18 批 / 并发 3 ⇒ 前台理论值 ${Math.ceil(18 / 3) * (DELAY_MS / 1000)}s）`);

  const marks = [];
  for (let i = 0; i < HIDDEN_SECONDS / 30; i += 1) {
    await sleep(30000);
    const probe = await api.cdp.eval(page.sessionId, `({ ticks: __qaProbe.ticks, elapsed: Date.now() - __qaProbe.startedAt, vis: document.visibilityState })`).catch((e) => ({ error: String(e.message).slice(0, 60) }));
    const eng = await api.engineStats();
    const dom = await api.cdp.eval(page.sessionId, `(() => { const h = [...document.querySelectorAll('jy-translation')];
      return { hosts: h.length, pending: h.filter((x) => x.shadowRoot?.querySelector('.jy-pending')).length }; })()`).catch(() => null);
    marks.push({ 秒: Math.round((i + 1) * 30), ticks: probe.ticks, elapsedMs: probe.elapsed ? Math.round(probe.elapsed / 1000) : null, vis: probe.vis, 请求数: eng.requests, hosts: dom?.hosts, pending: dom?.pending });
    console.log(JSON.stringify(marks[marks.length - 1]));
  }

  await api.activate(page.targetId);
  await sleep(5000);
  const tail = await api.cdp.eval(page.sessionId, `({ ticks: __qaProbe.ticks, elapsed: Math.round((Date.now() - __qaProbe.startedAt)/1000), 最近30条: __qaProbe.timeline.slice(-30) })`);
  const eng = await api.engineStats();
  const dom = await api.cdp.eval(page.sessionId, `(() => { const h = [...document.querySelectorAll('jy-translation')];
    return { hosts: h.length, pending: h.filter((x) => x.shadowRoot?.querySelector('.jy-pending')).length,
             errored: h.filter((x) => x.shadowRoot?.querySelector('.jy-error')).length,
             文案: [...new Set(h.map((x) => (x.shadowRoot?.querySelector('.jy-body')?.textContent ?? '').trim().slice(0, 40)))].slice(0, 4) }; })()`);
  console.log('切回前台后:', JSON.stringify({ ticks: tail.ticks, elapsed: tail.elapsed, 请求数: eng.requests, ...dom }));
  const gaps = [];
  for (let i = 1; i < tail.最近30条.length; i += 1) gaps.push(tail.最近30条[i][0] - tail.最近30条[i - 1][0]);
  console.log('最后 30 个 tick 的间隔（ms）:', JSON.stringify(gaps));
  console.log('判读:', JSON.stringify({
    定时器是否落后墙上时间: tail.elapsed - tail.ticks,
    隐藏期间请求是否仍在增加: marks.filter((m) => m.请求数 > 0).length > 0 && marks[marks.length - 1].请求数 > marks[0].请求数,
    结束时仍pending: dom.pending,
  }));
  await api.closeTab(blocker.targetId);
} finally {
  await api.engineCtl({ delayMs: 0 });
  await api.close();
}
