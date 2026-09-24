// 延迟×并发扫描：验证「总时长 ≈ ⌈批数 ÷ 并发⌉ × 单请求延迟 L」这条算术到底成不成立，
// 并用受控夹具把 批数 / 波数 / 实测最大并发 三个量直接量出来（不靠推算）。
import { writeFileSync } from 'node:fs';
import { boot, sleep } from './lib.mjs';

// 214 段、每段约 55 字符 ⇒ 12 段/批不会先被 1000 字符上限截断，批数就是 ⌈214/12⌉=18。
const SEGMENTS = 214;
const paras = Array.from({ length: SEGMENTS }, (_, i) => {
  const body = `Segment number ${String(i + 1).padStart(3, '0')} describes why layout shifts happen during hydration. `;
  return `<p id="p${i + 1}">${body.slice(0, 56)}</p>`;
});
writeFileSync(
  '.qa/fixture/scale214.html',
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>QA fixture — scale214</title></head><body><article id="article"><h1>Scale fixture with two hundred and fourteen paragraphs</h1>${paras.join('\n')}</article></body></html>`,
);

const CONFIGS = [
  { label: 'A 基线', delayMs: 0, concurrency: 3, maxSegmentsPerBatch: 12, maxBatchChars: 1000 },
  { label: 'B D=8 C=3', delayMs: 8000, concurrency: 3, maxSegmentsPerBatch: 12, maxBatchChars: 1000 },
  { label: 'C D=8 C=6', delayMs: 8000, concurrency: 6, maxSegmentsPerBatch: 12, maxBatchChars: 1000 },
  { label: 'D D=16 C=3', delayMs: 16000, concurrency: 3, maxSegmentsPerBatch: 12, maxBatchChars: 1000 },
  { label: 'E D=8 C=3 大批', delayMs: 8000, concurrency: 3, maxSegmentsPerBatch: 24, maxBatchChars: 2500 },
  { label: 'F D=8 C=8 大批', delayMs: 8000, concurrency: 8, maxSegmentsPerBatch: 24, maxBatchChars: 2500 },
];

const SETTLED = `(() => {
  const hosts = [...document.querySelectorAll('jy-translation')];
  const pending = hosts.filter((h) => h.shadowRoot?.querySelector('.jy-pending')).length;
  const errored = hosts.filter((h) => h.shadowRoot?.querySelector('.jy-error')).length;
  return { hosts: hosts.length, pending, errored };
})()`;

function analyzeLog(log) {
  const events = [];
  for (const e of log) {
    if (e.doneAt === undefined) continue;
    events.push([e.at, 1], [e.doneAt, -1]);
  }
  // 同一毫秒内先算「开始」再算「结束」，否则 D=0 时并发会被算成 0
  events.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let cur = 0;
  let maxInflight = 0;
  const waveStarts = [];
  let lastDone = 0;
  for (const [t, d] of events) {
    cur += d;
    if (d === 1) {
      if (t >= lastDone) waveStarts.push(t);
      maxInflight = Math.max(maxInflight, cur);
    } else lastDone = t;
  }
  const durs = log.filter((e) => e.doneAt).map((e) => e.doneAt - e.at);
  return {
    batches: log.length,
    segments: log.reduce((a, e) => a + e.segs, 0),
    maxInflight,
    avgRequestMs: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0,
    spanMs: log.length ? Math.max(...log.map((e) => e.doneAt ?? 0)) - Math.min(...log.map((e) => e.at)) : 0,
  };
}

const api = await boot();
const results = [];
const only = process.argv[2] ? process.argv[2].split(',') : null;
const RUNS = only ? CONFIGS.filter((c) => only.includes(c.label.split(' ')[0])) : CONFIGS;
try {
  for (const cfg of RUNS) {
    await api.extEval(
      `chrome.storage.local.get('jinyi:settings').then(o => chrome.storage.local.set({ 'jinyi:settings': ` +
        `{ ...o['jinyi:settings'], concurrency: ${cfg.concurrency}, maxSegmentsPerBatch: ${cfg.maxSegmentsPerBatch}, maxBatchChars: ${cfg.maxBatchChars} } }))`,
    );
    await api.extEval(`(async () => { for (const area of [chrome.storage.local, chrome.storage.session]) {
      const all = await area.get(null); const keys = Object.keys(all).filter((k) => k.startsWith('jt:'));
      if (keys.length) await area.remove(keys); } })()`);
    await api.engineCtl({ mode: 'ok', reset: true, delayMs: cfg.delayMs });

    const page = await api.openFixture('scale214.html');
    const t0 = Date.now();
    await api.fireToPage('jinyi:translate-page');
    let state = null;
    let settledAt = 0;
    for (let i = 0; i < 400; i += 1) {
      await sleep(400);
      state = await api.cdp.eval(page.sessionId, SETTLED).catch(() => null);
      if (state && state.hosts > 0 && state.pending === 0 && state.errored === 0) {
        settledAt = Date.now();
        break;
      }
    }
    const log = await api.engineLog();
    const a = analyzeLog(log.log);
    const row = {
      配置: cfg.label,
      延迟D: cfg.delayMs,
      并发C: cfg.concurrency,
      段数: a.segments,
      批数: a.batches,
      理论波数: Math.ceil(a.batches / cfg.concurrency),
      实测最大并发: a.maxInflight,
      单请求均时: a.avgRequestMs,
      总时长T秒: settledAt ? +((settledAt - t0) / 1000).toFixed(1) : null,
      宿主: state?.hosts,
      未完成: state ? state.pending + state.errored : '超时',
    };
    results.push(row);
    console.log(JSON.stringify(row));
    await api.fireToPage('jinyi:restore-page');
    await api.closeTab(page.targetId);
  }
  writeFileSync('.qa/out-latency.json', JSON.stringify(results, null, 1));
  console.table(results);
} finally {
  await api.extEval(
    `chrome.storage.local.get('jinyi:settings').then(o => chrome.storage.local.set({ 'jinyi:settings': ` +
      `{ ...o['jinyi:settings'], concurrency: 3, maxSegmentsPerBatch: 12, maxBatchChars: 1000 } }))`,
  );
  await api.close();
}
