// P2 / P2b 验收扫描：假引擎开一个"同时只允许 N 路在飞"的限流窗口（超出的请求直接回 429），
// 扫用户并发档位，看阀 + slow start + 轮末补译有没有把"整页 429 失败"消掉。
//
// 两行读数是**配对**的，缺一不可（2026-09-24 用户裁决后的判据，理由见报告）：
//   窄窗口（1 格）：失败段必须为 0，且总时长 ≤ 并发 1 对照点 ×1.4（或落在 ≈17-18 秒的绝对区间）。
//     只测这一行的话，一个"把并发永远摁在 1"的实现也能通过，那等于悄悄取消了并行。
//   宽窗口：**任一**宽窗口档位下并发 6 明显快于并发 3（≥1.4×）。不绑定格数——4 格那一档
//     结构上给不出 1.4×（吞吐下限就贴着并发 3 的实测值），详见报告的"已知限制：翻倍回升会过冲"。
//
// 用法：JY_QA_ATTACH=1 node .qa/run-429-scan.mjs "1:d,3,6,8|8:3,6"     （`d` = 出厂默认并发）
import { boot, sleep } from './lib.mjs';
import { peakInflight } from './peak.mjs';

/** 计划串 "窗口:并发档,并发档|窗口:并发档,…"；`d` 表示用出厂默认值。 */
const PLAN = process.argv[2] ?? '1:d,3,6,8|8:3,6';
const FIXTURE = process.env.JY_QA_FIXTURE ?? 'scale214.html';
const DELAY_MS = Number(process.env.JY_QA_DELAY ?? 700);

const api = await boot();

/** 开一个临时设置页标签页，读「并发请求数」输入框此刻显示的值（= 用户看到的默认值），读完就关。 */
async function readUiConcurrency(a) {
  const t = await a.cdp.openTab(`chrome-extension://${a.id}/options/options.html`);
  await sleep(1500);
  const value = await a.cdp
    .eval(t.sessionId, `document.getElementById('concurrency')?.value ?? '没有这个输入框'`)
    .catch((raw) => `读取失败：${raw.message}`);
  await a.closeTab(t.targetId);
  return value;
}
const rows = [];
try {
  for (const segment of PLAN.split('|')) {
    const [windowSlots, tiers] = segment.split(':');
    for (const tier of tiers.split(',')) {
      /** `d` = 用**出厂默认**并发（把存储里那个键删掉，让 `mergeSettings` 补默认值）。 */
      const useDefault = tier.toLowerCase() === 'd';
      const concurrency = useDefault ? '默认' : Number(tier);
      await api.extEval(
        `chrome.storage.local.get('jinyi:settings').then(o => { const s = { ...o['jinyi:settings'], ` +
        `maxSegmentsPerBatch: 12, maxBatchChars: 1000 };` +
        (useDefault ? ` delete s.concurrency;` : ` s.concurrency = ${tier};`) +
        ` return chrome.storage.local.set({ 'jinyi:settings': s }); })`,
      );
      // 默认值那一行顺手读一次设置页：界面上显示的数字就是"用户装好扩展看到的东西"。
      // **另开一个临时标签页读**——刷新 `api.ext` 那个常驻页会把 boot() 装在它上面的
      // `qaFindTab` 一起清掉，后面的 `openFixture` 立刻瞎掉（实测就是这么炸的）。
      const uiShown = useDefault ? await readUiConcurrency(api) : null;
      await api.extEval(`(async () => { for (const area of [chrome.storage.local, chrome.storage.session]) {
        const all = await area.get(null); const keys = Object.keys(all).filter((k) => k.startsWith('jt:'));
        if (keys.length) await area.remove(keys); } })()`);
      await api.engineCtl({ mode: 'ok', reset: true, delayMs: DELAY_MS, allowConcurrent: Number(windowSlots) });

      const page = await api.openFixture(FIXTURE);
      const t0 = Date.now();
      await api.fireToPage('jinyi:translate-page');
      let dom = null;
      let stats = null;
      let quiet = 0;
      for (let i = 0; i < 600; i += 1) {
        await sleep(500);
        dom = await api.cdp.eval(
          page.sessionId,
          `(() => { const h = [...document.querySelectorAll('jy-translation')];
            const body = (x) => (x.shadowRoot?.querySelector('.jy-body')?.textContent ?? '').trim();
            const queued = h.filter((x) => x.shadowRoot?.querySelector('.jy-queued')).length;
            const pending = h.filter((x) => x.shadowRoot?.querySelector('.jy-pending')).length;
            return { hosts: h.length, queued, pending,
                     errored: h.filter((x) => x.shadowRoot?.querySelector('.jy-error')).length,
                     translated: h.filter((x) => body(x).startsWith('译·')).length }; })()`,
        ).catch(() => null);
        stats = await api.engineStats();
        // 轮末补译那一遍里页面**没有** pending（重发的宿主停在失败态，不倒回占位文本），
        // 只看 DOM 会在两遍之间提前收尾；退避最长睡 4 秒，所以"静"要连续静过 8 秒才算完。
        if (dom && dom.hosts > 0 && dom.pending === 0 && stats.inflight === 0) quiet += 1;
        else quiet = 0;
        if (quiet >= 16) break;
      }
      const log = await api.engineLog();
      const entries = log.log ?? [];
      /**
       * 逐行自证「峰值在飞」这一列的**原料**：每个没被拒的请求都必须有自己的 `doneAt`，
       * 而且区间长度要 ≈ 设定的延迟。守的是读数陷阱第 7 条那一类（doneAt 记到别的条目身上
       * ⇒ 区间互不重叠 ⇒ 整列恒为 1）。
       *
       * ⚠ 两法对账（`peakInflight`）**守不住这一条**：数据坏的时候两份算法会一致地给出同一个
       *    错数（实测：doneAt 全记在最后一条上时，扫描线与中点法都返回 1）。对账只防"两份实现
       *    分道扬镳"，日志本身对不对要靠这里这两行。
       */
      const stamped = entries.filter((e) => !e.rejected);
      const missing = stamped.filter((e) => typeof e.doneAt !== 'number').length;
      if (missing > 0) {
        throw new Error(`日志坏了：${String(missing)}/${String(stamped.length)} 条没被拒的请求没有自己的 doneAt`);
      }
      const tooShort = stamped.filter((e) => e.doneAt - e.at < DELAY_MS - 20);
      if (tooShort.length > 0) {
        throw new Error(
          `日志坏了：${String(tooShort.length)} 条请求的区间短于设定延迟 ${String(DELAY_MS)}ms` +
            `（最短 ${String(Math.min(...tooShort.map((e) => e.doneAt - e.at)))}ms）——区间被记到别的请求上了`,
        );
      }
      /**
       * **收发跨度**：第一个请求到达引擎，到最后一个请求返回，中间不含台架的轮询与
       * 8 秒收尾静默窗。"总时长"那一列必然被这两样顶高 ~9 秒，比"快慢"要看这一列。
       */
      const busy = entries.length
        ? +((Math.max(...entries.map((e) => e.doneAt ?? e.at)) - Math.min(...entries.map((e) => e.at))) / 1000).toFixed(1)
        : null;
      const seconds = +((Date.now() - t0) / 1000).toFixed(1);
      rows.push({
        限流窗口: Number(windowSlots),
        用户并发: concurrency,
        设置页显示: uiShown,
        请求数: stats.requests,
        被拒429次: stats.rejected429,
        段次: stats.segments,
        峰值在飞: peakInflight(entries),
        译出段: dom?.translated,
        失败段: dom?.errored,
        仍排队: dom?.queued,
        收发跨度秒: busy,
        挂钟秒: seconds,
        整页失败: (dom?.errored ?? 0) > (dom?.translated ?? 0),
      });
      console.log(JSON.stringify(rows[rows.length - 1]));
      await api.fireToPage('jinyi:restore-page');
      await sleep(500);
      await api.closeTab(page.targetId);
    }
  }
  await api.engineCtl({ allowConcurrent: 0, delayMs: 0, mode: 'ok', reset: true });
  console.table(rows);
} finally {
  await api.close();
}
