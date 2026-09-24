// 量具校准：只测 `.qa/mock-engine.mjs` 自己，**不需要 Chrome、不跑扩展**。
//
// 为什么值得单独有一份：窄/宽窗口那张验收表全部出自这个假引擎的计数器。它已经出过两次
// "读数恒好但结论是假的"（`docs/qa/2026-09-24-measurement-traps.md` 第 2 条：限流闸插在延迟之后 ⇒ 被拒 429 恒 0；
// 第 7 条：doneAt 记在最后一条日志上 ⇒ 峰值在飞恒 1）。那两类 bug 不会让任何一条产品用例变红，
// 只会让验收表整体作废。所以这里把"量具的语义"钉成可复跑的断言。
//
// 用法：node .qa/mock-selfcheck.mjs      （退出码非 0 就是有断言红了）
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { peakByMidpoints, peakBySweepLine } from './peak.mjs';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];

function check(name, pass, reading) {
  results.push({ 检查项: name, 结果: pass ? 'PASS' : 'FAIL', 读数: reading });
  if (!pass) process.exitCode = 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 发一批并发翻译请求，返回每个的 {status, ms}。 */
async function fire(n, texts) {
  const started = Date.now();
  const settled = await Promise.all(
    Array.from({ length: n }, (_, i) => {
      const t0 = Date.now();
      return fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'mock-mini',
          messages: [
            { role: 'system', content: 'sys' },
            { role: 'user', content: `<<<1>>>\n${texts[i]}` },
          ],
        }),
      }).then(async (res) => ({ status: res.status, ms: Date.now() - t0, body: await res.json() }));
    }),
  );
  return { settled, wall: Date.now() - started };
}

const ctl = async () => (await fetch(`${BASE}/__ctl`)).json();
const log = async () => (await fetch(`${BASE}/__log`)).json();

const child = spawn(
  process.execPath,
  [process.env.JY_QA_MOCK ?? join(dirname(fileURLToPath(import.meta.url)), 'mock-engine.mjs'), String(PORT)],
  { stdio: 'ignore' },
);

try {
  for (let i = 0; i < 60; i += 1) {
    if (await fetch(`${BASE}/__ctl`).then(() => true).catch(() => false)) break;
    await sleep(200);
  }

  // ① 限流闸必须在**延迟之前**判：窗口 1 格 + 单请求 300ms，两个并发请求里被拒的那个
  //    不该睡满 300ms（旧实现就是睡完之后才判，于是闸永远不触发）。
  await fire(1, ['warmup']);
  await fetch(`${BASE}/__ctl`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reset: true, mode: 'ok', delayMs: 300, allowConcurrent: 1 }),
  });
  const narrow = await fire(2, ['A one', 'B two']);
  const rejected = narrow.settled.filter((r) => r.status === 429);
  const accepted = narrow.settled.filter((r) => r.status === 200);
  check(
    '窗口 1 格：两路并发恰好一拒一过',
    rejected.length === 1 && accepted.length === 1,
    `200=${String(accepted.length)} 429=${String(rejected.length)}`,
  );
  check(
    '被拒的请求**不等延迟**就返回（闸在 await 之前）',
    rejected.length === 1 && rejected[0].ms < 200,
    `被拒耗时=${String(rejected[0]?.ms ?? 'n/a')}ms（延迟设的 300ms）`,
  );
  check(
    '被拒的请求不占窗口：成功的请求拿满了延迟',
    accepted.length === 1 && accepted[0].ms >= 290,
    `成功耗时=${String(accepted[0]?.ms ?? 'n/a')}ms（延迟设的 300ms，容差 10ms）`,
  );

  // ⚠ 「被拒 < 200ms」这一条是**判别性**断言：它抓的正是"闸放在延迟之后 ⇒ 被拒计数恒 0"
  //    那类假读数。哪天它偶发红，该查的是机器负载，**不要放宽它**。可以加容差的只有
  //    "成功 >= 290" 这种纯计时断言（Node 的 setTimeout 不会早触发，实测读数 305ms，
  //    那 10ms 只是给 HTTP 开销留的余量）。

  // ② inflight 不泄漏（跑完一批含被拒的请求之后必须归零），以及计数器的口径。
  const afterNarrow = await ctl();
  check('一批跑完 inflight 归零（不泄漏）', afterNarrow.inflight === 0, `inflight=${String(afterNarrow.inflight)}`);
  check(
    'requests 数的是**每一次尝试**（含被拒），rejected429 只数被拒',
    afterNarrow.requests === 2 && afterNarrow.rejected429 === 1,
    `requests=${String(afterNarrow.requests)} rejected429=${String(afterNarrow.rejected429)}（上面那一步 reset 过，所以只算这一批的两次尝试）`,
  );
  check(
    '段次把被拒的尝试也算进去（扫描表里"段次"这一列的口径）',
    afterNarrow.segments === 2,
    `segments=${String(afterNarrow.segments)}`,
  );

  // ③ doneAt 记在**自己那条**日志上：窗口 4 格、4 路并发 ⇒ 峰值必须是 4。
  await fetch(`${BASE}/__ctl`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reset: true, mode: 'ok', delayMs: 250, allowConcurrent: 4 }),
  });
  await fire(4, ['w1', 'w2', 'w3', 'w4']);
  const entries = (await log()).log;
  const withDone = entries.filter((e) => typeof e.doneAt === 'number');
  check('四条并发请求各自带 doneAt', withDone.length === 4, `有 doneAt 的条目=${String(withDone.length)}/${String(entries.length)}`);
  check(
    '并发 4 路 ⇒ 峰值在飞 4（不是恒 1）',
    peakByMidpoints(entries) === 4,
    `峰值=${String(peakByMidpoints(entries))}`,
  );
  // 两份算法必须给同一个数（`run-429-scan.mjs` 每一行也当场对账一次）。
  check(
    '两法对账：扫描线 == 覆盖中点',
    peakBySweepLine(entries) === peakByMidpoints(entries),
    `扫描线=${String(peakBySweepLine(entries))} 中点法=${String(peakByMidpoints(entries))}`,
  );
  check(
    '每条区间的长度就是它自己的延迟（没有互相串）',
    withDone.every((e) => e.doneAt - e.at >= 200),
    withDone.map((e) => `${String(e.n)}:${String(e.doneAt - e.at)}ms`).join(' '),
  );

  // ④ 译文形状：扫描表"译出段"那一列靠 `译·` 前缀数段落，形状变了读数会静默失真。
  const ok = accepted[0]?.body?.choices?.[0]?.message?.content ?? '';
  check('回文是 `<<<n>>>` + `译·` 前缀', ok === '<<<1>>>\n译·A one', JSON.stringify(ok));

  // ⑤ 窗口 0 = 不限量（其余场景脚本依赖这个语义）。
  await fetch(`${BASE}/__ctl`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reset: true, mode: 'ok', delayMs: 50, allowConcurrent: 0 }),
  });
  const free = await fire(6, ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
  check(
    'allowConcurrent=0 时零拒绝',
    free.settled.every((r) => r.status === 200) && (await ctl()).rejected429 === 0,
    `状态=${free.settled.map((r) => r.status).join(',')} 总耗时=${String(free.wall)}ms（6×50ms 并发 ⇒ 应远小于 300ms）`,
  );
} finally {
  child.kill();
  console.table(results);
  const failed = results.filter((r) => r.结果 === 'FAIL');
  console.log(failed.length ? `✗ ${String(failed.length)} 项红：${failed.map((f) => f.检查项).join(' / ')}` : `✓ ${String(results.length)} 项全绿（量具可信）`);
}
