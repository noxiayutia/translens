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
 * 钉两件事：
 * 1. **样式查询次数**与元素数同阶（`styleOf` 每元素至多一次；探查靠缓存不靠重问）——
 *    这条确定、无时钟抖动，是复杂度的硬证据；
 * 2. **耗时**给一个按本机实测中位数放大出来的宽上界（见常量注释），只防病态回归，
 *    不代表真实性能预算（浏览器里 getComputedStyle 比 jsdom 快得多）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectSegments } from '../../src/content/extractor';

/** 卡片行数（每行再派生 3 种真实形态，整页 ≈ 1 万，真实站点单次采集的量级）。 */
const ROWS = 300;

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

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('collectSegments 规模基准（inline 载体判据修复的前后代价）', () => {
  it('万级元素页面：样式查询线性、耗时在宽上界内，形态 B 的卡片两段必须采到', () => {
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

    const samples: number[] = [];
    let lastTexts = 0;
    try {
      for (let run = 0; run < 3; run += 1) {
        document.body.innerHTML = html; // 清掉 data-jy-* 标记，每轮从同一现场开始
        const started = performance.now();
        const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
        samples.push(performance.now() - started);
        lastTexts = segments.length;
      }
    } finally {
      spy.mockRestore();
    }

    const median = [...samples].sort((a, b) => a - b)[1] as number;
    // eslint-disable-next-line no-console
    console.log(
      `[scale] elements=${String(elementCount)} median=${median.toFixed(1)}ms samples=${samples.map((s) => s.toFixed(1)).join('/')} readsPerRun=${String(styleReads / 3)} segments=${String(lastTexts)}`,
    );

    // 形态 A 每行 3 段（卡片松散文本 + 两个 p）=900；B 每张 3 段（Menu 松散 + h4 + p）=225；
    // C 每条 1 段=50。旧判据下 B 只剩 1 段/张（h4/p 静默丢失）→ 这条计数同时是事故的反证。
    expect(lastTexts).toBe(ROWS * 3 + Math.ceil(ROWS / 4) * 3 + Math.ceil(ROWS / 6));

    // 上界 3500ms：本机实测——旧判据 median ≈ 1666ms，新判据 ≈ 2010-2050ms（×1.22，
    // 其中还包含把形态 B 漏掉的 150 段**真的采出来**的工作量；纯探查开销约 ×1.13）。
    // jsdom 的 getComputedStyle 比真实浏览器贵一个量级，这个绝对值不当浏览器预算，
    // 上界留 ~1.7 倍余量，只防"病态超线性/缓存被拆"级别的回归。
    expect(median).toBeLessThan(3_500);
    // 每次采集的样式读取 ≤ 元素数 ×1.2：靠 createStyleLookup 的每轮缓存；
    // 修复新增的 hasBlockDescendant 探查读的是同一份缓存，不该翻倍。
    expect(styleReads / 3).toBeLessThanOrEqual(elementCount * 1.2);
  }, 60_000);
});
