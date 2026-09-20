/**
 * @vitest-environment jsdom
 *
 * 采集规模基准（主修的代价必须有数字，不是感觉）。
 *
 * 修复让**每一个非块级、非 none 的元素**都可能付一次 `hasBlockDescendant` 探查
 * （旧判据只放 4 种 display 进去）。这个页面按事故站点的构成配比：
 * 大量行内载体（`a`/`span`/`b`/`i`，含 3 层行内嵌套的纯文本链）+ 常规块级段落 +
 * 大棵 `display:none` 隐藏子树（none 短路该让它一次都不深入）。
 *
 * **默认跑、不受环境变量影响的两条断言**：
 * 1. **样式查询次数**与元素数同阶（`styleOf` 每元素至多一次；探查靠缓存不靠重问）——
 *    这条确定、无时钟抖动，是复杂度的硬证据；
 * 2. **段数 1175**，其中 150 段来自形态 B（inline `<a>` 包块级卡片，正是旧判据整棵跳过、
 *    静默丢掉的那 150 段）——这是 inline 载体修复的验收数字。
 *
 * **绝对耗时上界是显式的规模基准，默认不跑**（要跑就设 `JY_SCALE_MS=1`，pwsh / bash 两种写法
 * 见 README「开发」一节）：并发跑多份套件时 CPU 被抢，同一条断言会飘——复核实测单独跑 1948ms
 * （余量 1.80×）、单份全量并行 2443ms（1.43×）、**三份套件并发 2 红 1 绿**（绿的那次只剩 1.3%）；
 * 本次复核在三份并发下实测 median 3472 / 3563 / 3995ms，同一个 3500ms 上界下同样是 2 红 1 绿。
 * 调高阈值不是出路：要覆盖实测最差 6293ms 得放到 8000+，那"2000 → 8000 的四倍回归"照样通过。
 *
 * **相对判据（大页面 ÷ 小页面耗时之比）评估过、没有采用**，两条量出来的理由：
 * ① 主页面是本进程里的**第一次**采集，单位成本与之后测的页面不同档（同一份页面在进程不同位置
 *    实测 0.20 vs 0.42 ms/元素；单次样式读取 0.41 vs 0.80 ms），于是"主页面 ÷ ROWS/4 页面"的
 *    比值在 11 次运行里从 2.04 飘到 3.44（含三份并发）——它同时包含档位差，不是规模比；
 * ② 同档位的相邻两档小页面（ROWS/8 与 ROWS/4、ROWS/4 与 ROWS/2）确实稳定（12 次读数
 *    1.82~2.13，含三份并发），但相邻两档的规模跨度只有 2 倍：留 2 倍余量的上界（≥4.3）连
 *    O(n²) 回归（纯 O(n²) 那种情形该读出 ≈3.9）都拦不住；要让跨度到 4 倍上下（ROWS/8 对
 *    ROWS/2），每次 `npm test` 就得多跑 ~8 秒。
 * 结论：不留一条没有真牙、或者会飘的断言。复杂度的默认守卫是上面那条样式读取断言；
 * 具体耗时数字要人看的时候，用 `JY_SCALE_MS=1` 把绝对值那条打开。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectSegments } from '../../src/content/extractor';

/** 卡片行数（每行再派生 3 种真实形态，整页 ≈ 1 万，真实站点单次采集的量级）。 */
const ROWS = 300;

/** 测几轮取中位数（单轮噪声大：GC、别的进程抢 CPU 都可能只落在某一轮上）。 */
const RUNS = 3;

function buildPage(): string {
  const rows: string[] = [];
  for (let i = 0; i < ROWS; i += 1) {
    // 形态 A：常规卡片——行内导航链 + 块级正文 + 大棵 display:none 抽屉。
    rows.push(
      `<div class="card card-${i}">` +
        '<a class="link" href="#x">' +
        `<span class="s1"><span class="s2"><span class="s3">Nav entry ${i} <b>bold ${i}</b> <i>italic tail</i></span></span></span>` +
        '</a>' +
        `<div class="body"><p>Card paragraph one describing feature ${i} in words.</p>` +
        `<p>Card paragraph two with more detail about item ${i}.</p></div>` +
        '<div class="drawer" style="display:none">' +
        '<div><span>drawer text alpha</span><span>drawer text beta</span></div>' +
        '<div><span>drawer text gamma</span><span>drawer text delta</span></div>' +
        '<div><span>drawer text epsilon</span><span>drawer text zeta</span></div>' +
        '<div><span>drawer text eta</span><span>drawer text theta</span></div>' +
        '<div><span>drawer text iota</span><span>drawer text kappa</span></div>' +
        '</div>' +
        '</div>',
    );
    // 形态 B（事故本体，每 4 行一张）：**inline `<a>` 包块级卡片**——新判据要为它下钻，
    // 旧判据整棵跳过。它的探查代价正是本次修复新增的成本来源，必须进基准。
    if (i % 4 === 0) {
      rows.push(
        '<div class="grid-item">' +
          `<a class="menulink" href="/m${i}" style="display:inline">` +
          `<span class="mw"><span class="mt">Menu ${i}</span></span>` +
          `<div class="mcard"><h4>Menu card heading ${i}</h4>` +
          `<p>Menu card description sentence ${i} here.</p></div>` +
          '</a></div>',
      );
    }
    // 形态 C（纯行内肥链接，每 6 行一条）：10 层行内嵌套、**没有任何块级后代**——
    // 新判据对每一层都要探完才判负，这是探查的最坏情况（不得误报成边界）。
    if (i % 6 === 0) {
      let fat = `Fat inline link text ${i}`;
      for (let d = 0; d < 10; d += 1) fat = `<span class="f${d}">${fat}</span>`;
      rows.push(`<p>Paragraph around fat link ${i} ${fat}</p>`);
    }
  }
  return rows.join('');
}

function countElements(root: Element): number {
  return root.querySelectorAll('*').length;
}

/** 同一个现场跑 {@link RUNS} 轮，每轮先清掉 `data-jy-*` 标记；返回每轮耗时与最后一轮的段数。 */
function timeRuns(html: string): { samples: number[]; segments: number } {
  const samples: number[] = [];
  let segments = 0;
  for (let run = 0; run < RUNS; run += 1) {
    document.body.innerHTML = html;
    const started = performance.now();
    segments = collectSegments(document.body, { targetLang: 'zh-Hans' }).length;
    samples.push(performance.now() - started);
  }
  return { samples, segments };
}

function medianOf(samples: number[]): number {
  return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)] as number;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('collectSegments 规模基准（inline 载体判据修复的前后代价）', () => {
  it('万级元素页面：样式查询线性、段数 1175，形态 B 的卡片两段必须采到', () => {
    const html = buildPage();
    document.body.innerHTML = html;
    const elementCount = countElements(document.body);
    // 整页实测 ≈ 8875（形态 A 26 + 每 4 行 B 7 + 每 6 行 C 11），与真实站点单次采集同量级。
    expect(elementCount).toBeGreaterThanOrEqual(ROWS * 25);

    const view = document.defaultView as Window & typeof globalThis;
    const real = view.getComputedStyle.bind(view);
    let styleReads = 0;
    const spy = vi.spyOn(view, 'getComputedStyle').mockImplementation((...args) => {
      styleReads += 1;
      return real(...args);
    });

    let samples: number[] = [];
    let lastTexts = 0;
    try {
      const measured = timeRuns(html);
      samples = measured.samples;
      lastTexts = measured.segments;
    } finally {
      spy.mockRestore();
    }

    const median = medianOf(samples);
    // eslint-disable-next-line no-console
    console.log(
      `[scale] elements=${String(elementCount)} median=${median.toFixed(1)}ms samples=${samples.map((s) => s.toFixed(1)).join('/')} readsPerRun=${String(styleReads / RUNS)} segments=${String(lastTexts)} gate=${process.env.JY_SCALE_MS === '1' ? 'on' : 'off'}`,
    );

    // 形态 A 每行 3 段（卡片松散文本 + 两个 p）=900；B 每张 3 段（Menu 松散 + h4 + p）=225；
    // C 每条 1 段=50。旧判据下 B 只剩 1 段/张（h4/p 静默丢失）→ 这条计数同时是事故的反证。
    expect(lastTexts).toBe(ROWS * 3 + Math.ceil(ROWS / 4) * 3 + Math.ceil(ROWS / 6));

    // 每次采集的样式读取 ≤ 元素数 ×1.2：靠 createStyleLookup 的每轮缓存；
    // 修复新增的 hasBlockDescendant 探查读的是同一份缓存，不该翻倍。
    expect(styleReads / RUNS).toBeLessThanOrEqual(elementCount * 1.2);

    // 绝对耗时上界 3500ms：本机实测——旧判据 median ≈ 1666ms，新判据 ≈ 2010-2050ms（×1.22，
    // 其中还包含把形态 B 漏掉的 150 段**真的采出来**的工作量；纯探查开销约 ×1.13）。
    // jsdom 的 getComputedStyle 比真实浏览器贵一个量级，这个绝对值不当浏览器预算。
    // **默认不跑**（见文件头）：它是显式的规模基准，并发跑多份套件时 CPU 被抢会飘；
    // 要跑就设 JY_SCALE_MS=1。
    if (process.env.JY_SCALE_MS === '1') {
      expect(median).toBeLessThan(3_500);
    }
  }, 60_000);
});
