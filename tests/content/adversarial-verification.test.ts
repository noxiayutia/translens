/**
 * @vitest-environment jsdom
 *
 * 对抗性核验（一次性探针，不属于交付物）。独立于实现者的用例：自己构造页面、
 * 自己按"用户能看见什么"遍历 DOM，不复用 renderer.test.ts 的任何辅助函数。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomRenderer } from '../../src/content/renderer';
import { collectSegments } from '../../src/content/extractor';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';

beforeEach(() => {
  document.body.innerHTML = '';
});

function bodyTextOf(host: Element): string {
  return host.shadowRoot?.querySelector('.jy-body')?.textContent ?? '';
}

/** 用户**看得见**的文本：跳过 display:none 的子树，宿主读 Shadow DOM。 */
function visibleText(element: Element): string {
  const pieces: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      pieces.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (child.tagName === 'JY-TRANSLATION') {
      pieces.push(bodyTextOf(child));
      return;
    }
    const display = child.ownerDocument.defaultView?.getComputedStyle(child).display;
    if (display === 'none') return;
    for (const grandChild of Array.from(child.childNodes)) walk(grandChild);
  };
  for (const child of Array.from(element.childNodes)) walk(child);
  return pieces.join('');
}

function originals(element: Element): HTMLElement {
  const span = element.querySelector('[data-jy-originals]');
  if (!(span instanceof HTMLElement)) throw new Error('没有藏着原文的 span');
  return span;
}

const JY_MARKERS = '[data-jy-id],[data-jy-translated],[data-jy-root],[data-jy-originals],[data-jy-for]';

/** 采集 + 逐段 mount（done），返回 (renderer, segments)。 */
function translateAll(
  mode: 'bilingual' | 'translated-only',
  textOf: (segment: { text: string; order: number }) => string,
): { renderer: DomRenderer; segments: ReturnType<typeof collectSegments> } {
  const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
  const renderer = new DomRenderer(document, mode);
  for (const segment of segments) renderer.mount(segment, 'done', textOf(segment));
  return { renderer, segments };
}

describe('核验 1：可见性（含链接与图片的段落）', () => {
  it('computed display 为 none，原文节点在同一批里，可见文本只有译文', () => {
    document.body.innerHTML =
      '<p id="p">Read <a id="link" href="/x">this page</a> and <img id="pic" src="a.png" alt="pic"> now</p>';
    const p = document.getElementById('p') as HTMLElement;
    const link = document.getElementById('link') as HTMLAnchorElement;
    const pic = document.getElementById('pic') as HTMLImageElement;
    const linkIdentity = link;
    const picIdentity = pic;

    const { renderer, segments } = translateAll('translated-only', () => '请读这一页');
    expect(segments).toHaveLength(1);
    expect(segments[0].element).toBe(p);

    const span = originals(p);
    // ① display:none —— 内联样式与 computed 两处都要成立（页面 CSS 覆盖不掉）。
    expect(span.style.display).toBe('none');
    expect(getComputedStyle(span).display).toBe('none');
    // ② 原文节点是**同一批**节点（不是克隆/重建）：补段落全部 5 个子节点
    expect(span.contains(linkIdentity)).toBe(true);
    expect(span.contains(picIdentity)).toBe(true);
    expect(linkIdentity.isConnected).toBe(true);
    expect(span.childNodes).toHaveLength(5);
    expect(Array.from(span.childNodes).map((node) => (node as Element).nodeName)).toEqual([
      '#text',
      'A',
      '#text',
      'IMG',
      '#text',
    ]);
    // href / src 原样
    expect(linkIdentity.getAttribute('href')).toBe('/x');
    expect(picIdentity.getAttribute('src')).toBe('a.png');
    // ③ 可见文本只剩译文
    expect(visibleText(p)).toBe('请读这一页');
    // 元素自己的 textContent 仍然含原文 —— 证明"用 textContent 断言可见性"会假通过
    expect(p.textContent).toContain('Read');
    expect(p.querySelectorAll('jy-translation')).toHaveLength(1);

    renderer.restore();
    expect(p.querySelector('a')).toBe(linkIdentity);
    expect(p.querySelector('img')).toBe(picIdentity);
  });

  it('三步结构：宿主是元素的**末尾子节点**，span 在它之前，其余子节点按原顺序保留', () => {
    document.body.innerHTML = '<p id="p">Alpha text</p>';
    const p = document.getElementById('p') as HTMLElement;
    translateAll('translated-only', () => '甲');

    const span = originals(p);
    const host = p.querySelector('jy-translation') as Element;
    expect(host.parentElement).toBe(p);
    expect(Array.from(p.childNodes).map((node) => (node as Element).nodeName)).toEqual([
      'SPAN',
      'JY-TRANSLATION',
    ]);
    expect(p.lastChild).toBe(host);
    expect(span.previousSibling).toBeNull();
  });

  it('段落同时含 <a>/<b>/<em>/<img>：四个行内标记都被保留、都被藏起来，可见的只有译文', () => {
    document.body.innerHTML =
      '<p id="p">Read <a id="l" href="/x">this</a> <b id="b">bold</b> <em id="e">em</em> <img id="i" src="a.png" alt="pic"> now</p>';
    const p = document.getElementById('p') as HTMLElement;
    const before = document.body.outerHTML;
    const link = document.getElementById('l') as HTMLAnchorElement;
    const bold = document.getElementById('b') as HTMLElement;
    const em = document.getElementById('e') as HTMLElement;
    const img = document.getElementById('i') as HTMLImageElement;

    const { renderer } = translateAll('translated-only', () => '译文');

    const span = originals(p);
    expect(getComputedStyle(span).display).toBe('none');
    for (const node of [link, bold, em, img]) {
      expect(span.contains(node)).toBe(true);
      expect(node.isConnected).toBe(true);
    }
    expect(link.getAttribute('href')).toBe('/x');
    expect(img.getAttribute('src')).toBe('a.png');
    // 可见的只有译文：四个行内标记一个都不在可见层
    expect(visibleText(p)).toBe('译文');
    for (const node of [link, bold, em, img]) {
      expect(node.ownerDocument.defaultView?.getComputedStyle(node).display).not.toBe('none');
      expect(getComputedStyle(node).visibility).toBe('visible');
    }

    renderer.restore();
    expect(document.body.outerHTML).toBe(before);
  });
});

describe('核验 2：还原逐字节（含图片、br、表格、嵌套列表、flex）', () => {
  const PAGE = [
    '<article>',
    '<h1>Hello world</h1>',
    '<p>Click <a href="/x" title="t">here</a> now</p>',
    '<p>An image <img src="a.png" alt="pic"> inside</p>',
    '<figure><img src="figure.png" alt="figure"><figcaption>Caption text</figcaption></figure>',
    '<address>Line one<br>Line two</address>',
    '<div id="mix">Intro sentence<p id="inner">Nested body text</p>Outro sentence</div>',
    '<table><tbody><tr><td>Cell one</td><td>Cell two</td></tr><tr><td>Cell three</td><td>Cell four</td></tr></tbody></table>',
    '<ul><li>Item one<ul><li>Nested item</li></ul></li><li>Item two</li></ul>',
    '<div style="display:flex"><p style="display:block">Flex one</p><p style="display:block">Flex two</p></div>',
    '</article>',
  ].join('');

  it('翻译 → 还原后 body.outerHTML 逐字节相同，且无 data-jy-* 残留', () => {
    document.body.innerHTML = PAGE;
    const before = document.body.outerHTML;

    const { renderer, segments } = translateAll('translated-only', (segment) => `T${segment.order}`);
    expect(segments.length).toBeGreaterThanOrEqual(12);

    renderer.restore();

    expect(document.body.outerHTML).toBe(before);
    expect(document.querySelectorAll(JY_MARKERS)).toHaveLength(0);
  });

  it('翻译 → 还原 → 再翻译 → 再还原：可重复，两次都逐字节', () => {
    document.body.innerHTML = PAGE;
    const before = document.body.outerHTML;

    for (let round = 1; round <= 2; round += 1) {
      const { renderer, segments } = translateAll('translated-only', (segment) => `R${round}-${segment.order}`);
      // 翻译态：正文里不该还有可见的原文
      expect(visibleText(document.body)).not.toContain('Hello world');
      expect(segments.length).toBeGreaterThanOrEqual(12);
      renderer.restore();
      expect(document.body.outerHTML, `第 ${round} 轮还原后不一致`).toBe(before);
    }
    expect(document.querySelectorAll(JY_MARKERS)).toHaveLength(0);
  });

  it('还原后重新采集得到完全一样的段落集合', () => {
    document.body.innerHTML = PAGE;
    const first = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'translated-only');
    for (const segment of first) renderer.mount(segment, 'done', 'X');
    renderer.restore();

    const second = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(second.map((s) => s.text)).toEqual(first.map((s) => s.text));
    expect(second.map((s) => s.element.tagName)).toEqual(first.map((s) => s.element.tagName));
  });

  it('元素被移出文档之后 restore 仍把原文搬回该元素', () => {
    document.body.innerHTML = '<div id="box"><p id="p">Original english text</p></div>';
    const p = document.getElementById('p') as HTMLElement;
    const { renderer } = translateAll('translated-only', () => '译文');
    expect(visibleText(p)).toBe('译文');

    p.remove();
    renderer.restore();

    expect(p.textContent).toBe('Original english text');
    expect(p.querySelectorAll(JY_MARKERS)).toHaveLength(0);
  });

  it('段落里含用户自己的 display:none 元素：位置必须回到原处（不能被搬到末尾）', () => {
    document.body.innerHTML = '<p id="p">Visible text<span id="hid" style="display:none">Secret text</span> tail</p>';
    const p = document.getElementById('p') as HTMLElement;
    const before = document.body.outerHTML;

    const { renderer } = translateAll('translated-only', () => '译文');
    renderer.restore();

    expect(document.body.outerHTML).toBe(before);
    expect(Array.from(p.childNodes).map((node) => (node as Element).nodeName)).toEqual([
      '#text',
      'SPAN',
      '#text',
    ]);
  });
});

describe('核验 3：真实结构下的布局', () => {
  it('flex 容器里的多张卡片：宿主在卡片内部，兄弟卡片与其译文都不被打乱', () => {
    document.body.innerHTML = [
      '<div id="row" style="display:flex">',
      '<article class="card"><h2>Card one title</h2><p>Card one body</p></article>',
      '<article class="card"><h2>Card two title</h2><p>Card two body</p></article>',
      '</div>',
    ].join('');
    const row = document.getElementById('row') as HTMLElement;
    const before = document.body.outerHTML;
    const { renderer, segments } = translateAll('translated-only', (segment) => `T${segment.order}`);
    expect(segments).toHaveLength(4);

    // 兄弟结构：row 下仍然只有两张卡片
    expect(Array.from(row.children).map((child) => child.tagName)).toEqual(['ARTICLE', 'ARTICLE']);
    for (const card of Array.from(row.children)) {
      const host = card.querySelector('jy-translation');
      expect(host).not.toBeNull();
      expect(host?.parentElement?.tagName).toBe('H2');
      // 每张卡片里可见的只有它自己的两条译文
      expect(visibleText(card)).toMatch(/^T\dT\d$/);
    }
    renderer.restore();
    expect(document.body.outerHTML).toBe(before);
  });

  it('嵌套列表：UL 下仍是 LI，每个 li 的原文与译文都在自己内部，可见文本完整且按序', () => {
    document.body.innerHTML =
      '<ul id="outer"><li id="one">Item one<ul id="inner"><li id="nested">Nested item</li></ul></li><li id="two">Item two</li></ul>';
    const outer = document.getElementById('outer') as HTMLElement;
    const inner = document.getElementById('inner') as HTMLElement;
    const one = document.getElementById('one') as HTMLElement;
    const nested = document.getElementById('nested') as HTMLElement;
    const before = document.body.outerHTML;
    const { renderer, segments } = translateAll('translated-only', (segment) => `T${segment.order}`);
    expect(segments).toHaveLength(3);
    // 第一段是 li 里的直接文本（松散文本段），它**不能**把嵌套的 <ul> 一起藏掉
    expect(segments[0].textRun).toBe(true);

    expect(Array.from(outer.children).map((child) => child.tagName)).toEqual(['LI', 'LI']);
    expect(Array.from(inner.children).map((child) => child.tagName)).toEqual(['LI']);
    expect(originals(one).textContent).toBe('Item one');
    expect(originals(nested).textContent).toBe('Nested item');
    // 嵌套列表没有被父段藏掉：它的译文仍然可见
    expect(originals(one).contains(inner)).toBe(false);
    expect(visibleText(one)).toBe('T0T1');
    expect(visibleText(nested)).toBe('T1');
    expect(visibleText(outer)).toBe('T0T1T2');
    expect(visibleText(document.body)).not.toContain('Item one');

    renderer.restore();
    expect(document.body.outerHTML).toBe(before);
  });

  it('表格：宿主在单元格内部，TR 里没有多出非单元格节点', () => {
    document.body.innerHTML =
      '<table id="t"><tbody><tr id="r"><td id="a">Cell one</td><td id="b">Cell two</td></tr></tbody></table>';
    const row = document.getElementById('r') as HTMLElement;
    const before = document.body.outerHTML;
    const { renderer } = translateAll('translated-only', (segment) => `T${segment.order}`);

    expect(Array.from(row.children).map((child) => child.tagName)).toEqual(['TD', 'TD']);
    expect(document.querySelectorAll('tbody > jy-translation')).toHaveLength(0);
    renderer.restore();
    expect(document.body.outerHTML).toBe(before);
  });
});

describe('核验 4：设置迁移与默认值', () => {
  it("mergeSettings：'replace' → translated-only；乱值 → 默认值（都不是 bilingual）", () => {
    expect(DEFAULT_SETTINGS.displayMode).toBe('translated-only');
    expect(mergeSettings({ displayMode: 'replace' }).displayMode).toBe('translated-only');
    expect(mergeSettings({ displayMode: 'replace', version: 1 }).displayMode).toBe('translated-only');
    expect(mergeSettings({ displayMode: 'garbage-value' }).displayMode).toBe('translated-only');
    expect(mergeSettings({ displayMode: 'garbage-value' }).displayMode).not.toBe('bilingual');
    expect(mergeSettings({ displayMode: 42 }).displayMode).toBe('translated-only');
    expect(mergeSettings({ displayMode: null }).displayMode).toBe('translated-only');
    expect(mergeSettings({ displayMode: 'bilingual' }).displayMode).toBe('bilingual');
    expect(mergeSettings({}).displayMode).toBe('translated-only');
  });

  /**
   * 与上一条的区别：这里把"未知值走的那条兜底路"当成参照，钉住迁移**与默认值解耦**。
   *
   * 核验实测（scripts/adversarial/migration-coverage.ps1 的变异 X）：只删掉
   * `pickDisplayMode` 里 `'replace'` 那半句、默认值保持 `translated-only` 时，
   * 全量 427 个用例**全部通过**——因为 `'replace'` 会掉到 `return DEFAULT_SETTINGS.displayMode`
   * 这个兜底上，读出来还是 `translated-only`，与迁移分支的行为完全等价。
   * 也就是说任何行为断言都杀不掉这一处回归，除非默认值也跟着变（变异 Y/Z 才会红）。
   * 这条用例至少把"迁移结果 == 未知值的兜底结果"这个巧合钉成显式判据：
   * 哪天默认值改了，它和实现者的 settings.test.ts 会一起红。
   */
  it("'replace' 的迁移与默认值解耦：它不是靠兜底落回默认值", () => {
    const unknownFallback = mergeSettings({ displayMode: '__unknown__' }).displayMode;
    // 默认值本身必须是「仅译文」（这条断言同时挡住"默认值被改回双语"）
    expect(unknownFallback).toBe('translated-only');
    expect(DEFAULT_SETTINGS.displayMode).toBe('translated-only');
    expect(mergeSettings({ displayMode: 'replace' }).displayMode).toBe(unknownFallback);
    expect(mergeSettings({ displayMode: 'replace' }).displayMode).not.toBe('bilingual');
  });
});

describe('核验 5：失败态可见', () => {
  it('renderer 层：错误文案 + 重试按钮，原文仍完整地藏在 span 里', () => {
    document.body.innerHTML = '<p id="p">Hello world</p>';
    const p = document.getElementById('p') as HTMLElement;
    const onRetry = vi.fn();
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'translated-only', onRetry);
    renderer.mount(segments[0], 'pending');
    renderer.fail(segments[0].id, '网络不可达');
    const host = p.querySelector('jy-translation') as Element;

    expect(host).not.toBeNull();
    expect(bodyTextOf(host)).toContain('网络不可达');
    expect(visibleText(p)).toContain('网络不可达');
    const button = host.shadowRoot?.querySelector('.jy-retry') as HTMLButtonElement;
    expect(button).not.toBeNull();
    button.click();
    expect(onRetry).toHaveBeenCalledWith(segments[0].id);
    // 原文没丢
    expect(originals(p).textContent).toBe('Hello world');
  });
});
