/**
 * @vitest-environment jsdom
 *
 * 断言约定：断言"还是原来那个节点"必须用 `toBe` / `===`，不能用 `toEqual`。
 * vitest 的 `equals` 对 DOM 节点走 DOM3 `isEqualNode`（**结构比较**，见本仓库 vitest 5.0.0 的
 * `node_modules/vitest/dist/chunks/index.OVGXnVRj.js:1289`）。实测探针读数：
 *   `expect(段落.cloneNode(true)).toEqual(段落)`            → **PASS**
 *   `expect({kind:'before',node:克隆体}).toEqual({…原节点})` → **PASS**
 * 也就是"落点/载体指错成了一个同构节点"在 `toEqual` 下是假通过，必须比身份。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomRenderer } from '../../src/content/renderer';
import { collectSegments } from '../../src/content/extractor';
import type { ExtractedSegment } from '../../src/content/extractor';

function paragraph(text: string): ExtractedSegment {
  const element = document.createElement('p');
  element.textContent = text;
  document.body.append(element);
  return { id: 'jy-1', text, order: 0, element, anchor: { kind: 'auto' } };
}

function bodyTextOf(host: Element): string {
  return host.shadowRoot?.querySelector('.jy-body')?.textContent ?? '';
}

/**
 * 元素里**可见**的文本。
 *
 * `el.textContent` 分不出可见性——藏起来的原文也在里面（这正是「仅译文」模式的实现方式），
 * 所以自己走一遍：跳过 `display:none` 的子树，译文宿主读它 Shadow DOM 里的正文。
 */
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
    if (child.ownerDocument.defaultView?.getComputedStyle(child).display === 'none') return;
    for (const grandChild of Array.from(child.childNodes)) walk(grandChild);
  };
  for (const child of Array.from(element.childNodes)) walk(child);
  return pieces.join('');
}

/** 元素里那个装着原文的隐藏 span（仅译文模式）。 */
function originalsOf(element: Element): HTMLElement {
  const span = element.querySelector('[data-jy-originals]');
  if (!(span instanceof HTMLElement)) throw new Error('元素里没有藏着原文的 span');
  return span;
}

/** 插件留在页面上的全部标记；还原之后必须一个都不剩。 */
const JY_MARKERS = '[data-jy-id],[data-jy-translated],[data-jy-root],[data-jy-originals],[data-jy-for]';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('DomRenderer 双语模式', () => {
  it('把译文宿主插到原段落之后', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '你好，世界');

    const host = document.querySelector('jy-translation');
    expect(host).not.toBeNull();
    expect(segment.element.nextElementSibling).toBe(host);
    expect(bodyTextOf(host as Element)).toBe('你好，世界');
  });

  it('原文保持不变', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '你好，世界');
    expect(segment.element.textContent).toBe('Hello world');
  });

  it('重复 mount 同一个 id 不会插入两个宿主', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    renderer.mount(segment, 'pending');
    expect(document.querySelectorAll('jy-translation')).toHaveLength(1);
  });

  it('宿主带 data-jy-root 标记，避免被再次采集', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    const host = document.querySelector('jy-translation') as Element;
    expect(host.hasAttribute('data-jy-root')).toBe(true);
    expect(host.getAttribute('data-jy-for')).toBe('jy-1');
  });

  it('表格单元格的译文插进单元格内部而不是行之间', () => {
    document.body.innerHTML = '<table><tbody><tr><td id="cell">Cell text</td></tr></tbody></table>';
    const cell = document.getElementById('cell') as HTMLElement;
    const segment: ExtractedSegment = {
      id: 'jy-1',
      text: 'Cell text',
      order: 0,
      element: cell,
      anchor: { kind: 'auto' },
    };
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    expect(cell.querySelector('jy-translation')).not.toBeNull();
  });

  it('弹性布局父容器下译文插到段落内部', () => {
    document.body.innerHTML =
      '<div style="display:flex"><p id="p" style="display:block">Flex child text</p></div>';
    const p = document.getElementById('p') as HTMLElement;
    const segment: ExtractedSegment = {
      id: 'jy-1',
      text: 'Flex child text',
      order: 0,
      element: p,
      anchor: { kind: 'auto' },
    };
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    expect(p.querySelector('jy-translation')).not.toBeNull();
  });

  it('列表项的译文插进列表项内部', () => {
    document.body.innerHTML = '<ul><li id="li">Item text</li></ul>';
    const li = document.getElementById('li') as HTMLElement;
    const segment: ExtractedSegment = {
      id: 'jy-1',
      text: 'Item text',
      order: 0,
      element: li,
      anchor: { kind: 'auto' },
    };
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    expect(li.querySelector('jy-translation')).not.toBeNull();
  });
});

describe('DomRenderer 状态与还原', () => {
  it('pending 状态显示占位文案', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    expect(bodyTextOf(document.querySelector('jy-translation') as Element)).toBe('翻译中…');
  });

  it('fail 状态显示错误文案与重试按钮', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    renderer.fail(segment.id, '网络错误');

    const host = document.querySelector('jy-translation') as Element;
    expect(bodyTextOf(host)).toContain('网络错误');
    expect(host.shadowRoot?.querySelector('.jy-retry')).not.toBeNull();
  });

  /**
   * 实测渲染成「接口限流，请稍后重试重试」：`margin-left` 只是**视觉**分隔，
   * 文本层面错误文案与按钮的「重试」直接相连——复制译文连着"重试"、读屏念"重试重试"、
   * 禁用样式时挤成一团。要在按钮前补一个真正的空格文本节点，双语与仅译文两套样式都要。
   */
  it('双语模式：错误文案与重试按钮之间有空格文本节点（复制/读屏不粘连）', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    renderer.fail(segment.id, '接口限流，请稍后重试');

    const host = document.querySelector('jy-translation') as Element;
    // textContent 是"复制/读屏"看到的整体文本：两个"重试"之间必须有分隔的空格。
    expect(bodyTextOf(host)).toBe('接口限流，请稍后重试 重试');
    // 不挂按钮的失败（canRetry:false）不许多出这个空格。
    const plain = paragraph('Second text');
    const plainRenderer = new DomRenderer(document, 'bilingual');
    plainRenderer.mount(plain, 'pending');
    plainRenderer.fail(plain.id, '缺少 API Key', false);
    expect(bodyTextOf(document.querySelectorAll('jy-translation')[1] as Element)).toBe('缺少 API Key');
  });

  it('仅译文模式：同样以空格文本节点分隔错误文案与重试按钮', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'pending');
    renderer.fail(segment.id, '接口限流，请稍后重试');

    const host = segment.element.querySelector('jy-translation') as Element;
    expect(bodyTextOf(host)).toBe('接口限流，请稍后重试 重试');
  });

  it('点击重试按钮触发回调', () => {
    const segment = paragraph('Hello world');
    const onRetry = vi.fn();
    const renderer = new DomRenderer(document, 'bilingual', onRetry);
    renderer.mount(segment, 'pending');
    renderer.fail(segment.id, '网络错误');

    const host = document.querySelector('jy-translation') as Element;
    const button = host.shadowRoot?.querySelector('.jy-retry') as HTMLButtonElement;
    button.click();
    expect(onRetry).toHaveBeenCalledWith('jy-1');
  });

  it('restore 移除全部译文宿主并清掉标记', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '你好，世界');
    renderer.restore();

    expect(document.querySelector('jy-translation')).toBeNull();
    expect(segment.element.hasAttribute('data-jy-id')).toBe(false);
    expect(segment.element.getAttribute('data-jy-translated')).toBeNull();
  });
});

describe('DomRenderer 仅译文模式', () => {
  it('宿主在元素内部，原文被藏进 display:none 的 span，可见文本只剩译文', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '你好，世界');

    const host = segment.element.querySelector('jy-translation') as Element;
    // 宿主在**元素内部**（双语模式是插在元素旁边的兄弟位置）。
    expect(host).not.toBeNull();
    expect(host.parentElement).toBe(segment.element);
    expect(bodyTextOf(host)).toBe('你好，世界');

    const span = originalsOf(segment.element);
    // display 为 none 且原文节点确实在里面（不是被删掉后重建的副本）。
    expect(span.style.display).toBe('none');
    expect(span.ownerDocument.defaultView?.getComputedStyle(span).display).toBe('none');
    expect(span.textContent).toBe('Hello world');
    expect(span.getAttribute('data-jy-root')).toBe('');

    // `textContent` 分不出可见性——藏起来的原文也在里面、译文反而在 Shadow DOM 里读不到，
    // 所以显式断言"可见的只剩译文"。
    expect(segment.element.textContent).toBe('Hello world');
    expect(visibleText(segment.element)).toBe('你好，世界');
  });

  it('span 在宿主之前，原文按原相对顺序留在里面', () => {
    document.body.innerHTML = '<p id="p">Click <a href="/x">here</a> now</p>';
    const p = document.getElementById('p') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });

    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'done', '点击这里');

    const order = Array.from(p.childNodes).map((node) =>
      node.nodeType === Node.TEXT_NODE ? '#text' : (node as Element).nodeName,
    );
    expect(order).toEqual(['SPAN', 'JY-TRANSLATION']);
    const span = originalsOf(p);
    expect(Array.from(span.childNodes).map((node) => node.nodeType)).toEqual([
      Node.TEXT_NODE,
      Node.ELEMENT_NODE,
      Node.TEXT_NODE,
    ]);
    expect(span.textContent).toBe('Click here now');
  });

  it('pending 也先藏起原文：正文位置不会先显示一段原文再被换成译文', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'pending');

    expect(originalsOf(segment.element).textContent).toBe('Hello world');
    expect(visibleText(segment.element)).toBe('翻译中…');
  });

  it('重复 mount 同一个 id 不会插入第二个宿主或第二个 span', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'pending');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '你好，世界');
    expect(segment.element.querySelectorAll('jy-translation')).toHaveLength(1);
    expect(segment.element.querySelectorAll('[data-jy-originals]')).toHaveLength(1);
    expect(visibleText(segment.element)).toBe('你好，世界');
  });

  it('表格单元格 / 列表项 / 弹性布局子元素：宿主都在元素内部，原文都藏在同一个元素里', () => {
    const cases = [
      { html: '<table><tbody><tr><td id="target">Cell text</td></tr></tbody></table>', text: 'Cell text' },
      { html: '<ul><li id="target">Item text</li></ul>', text: 'Item text' },
      {
        html: '<div style="display:flex"><p id="target" style="display:block">Flex child text</p></div>',
        text: 'Flex child text',
      },
    ];

    for (const item of cases) {
      document.body.innerHTML = item.html;
      const element = document.getElementById('target') as HTMLElement;
      // 用真实采集结果：锚点/元素是管线给的，不是手抄的。
      const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
      expect(segment.element, item.html).toBe(element);

      const renderer = new DomRenderer(document, 'translated-only');
      renderer.mount(segment, 'done', '译文');

      const host = element.querySelector('jy-translation') as Element;
      expect(host, item.html).not.toBeNull();
      expect(host.parentElement, item.html).toBe(element);
      expect(originalsOf(element).textContent, item.html).toBe(item.text);
      expect(visibleText(element), item.html).toBe('译文');

      // 外层容器里没有多出任何插件节点：表格行不会混进非单元格节点、
      // 列表项与弹性子元素也不会被挤成"原文 / 译文"两个兄弟。
      const parent = element.parentElement as HTMLElement;
      expect(Array.from(parent.children).map((child) => child.tagName), item.html).toEqual([element.tagName]);
    }
  });

  it('含 <a href> 的段落：链接节点仍在 DOM 里、href 未变（虽然不可见）', () => {
    document.body.innerHTML = '<p id="p">Click <a href="/x">here</a> now</p>';
    const p = document.getElementById('p') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(segment.element).toBe(p);

    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'done', '点击这里');

    const link = p.querySelector('a');
    // 旧的就地替换实现在这里会把 <a> 永久销毁（所以它当年干脆退回双语）；
    // 包起来的做法不重建任何行内标记，链接还在，只是被藏进了 span。
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/x');
    expect(link?.textContent).toBe('here');
    expect(originalsOf(p).contains(link)).toBe(true);
    expect(visibleText(p)).toBe('点击这里');
  });

  it('松散文本段只藏自己那一串：兄弟段落与它们的译文都不受牵连', () => {
    document.body.innerHTML =
      '<div id="box">Intro sentence here<p id="body">Body paragraph text</p>Outro sentence here</div>';
    const box = document.getElementById('box') as HTMLElement;
    const body = document.getElementById('body') as HTMLElement;
    const before = document.body.outerHTML;
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual([
      'Intro sentence here',
      'Body paragraph text',
      'Outro sentence here',
    ]);

    const renderer = new DomRenderer(document, 'translated-only');
    for (const segment of segments) renderer.mount(segment, 'done', `【译】${segment.text}`);

    // 容器里的三处原文各自藏进自己的 span：整块搬走会把 <p> 连它的译文一起藏掉。
    // 直属于容器的只有两处（Body 的那处在 <p> 里面）。
    expect(box.querySelectorAll(':scope > [data-jy-originals]')).toHaveLength(2);
    expect(box.querySelectorAll('[data-jy-originals]')).toHaveLength(3);
    expect(originalsOf(box).textContent).toBe('Intro sentence here');
    expect(originalsOf(body).textContent).toBe('Body paragraph text');
    expect(originalsOf(box).contains(body)).toBe(false);
    expect(visibleText(box)).toBe(
      '【译】Intro sentence here【译】Body paragraph text【译】Outro sentence here',
    );

    renderer.restore();
    expect(document.body.outerHTML).toBe(before);
  });

  it('段落里带 <br> 时按行分段，行内标记与硬换行都不被搬走', () => {
    document.body.innerHTML = '<p id="p">Line one<br>Line two</p>';
    const p = document.getElementById('p') as HTMLElement;
    const before = document.body.outerHTML;
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Line one', 'Line two']);

    const renderer = new DomRenderer(document, 'translated-only');
    for (const segment of segments) renderer.mount(segment, 'done', `【译】${segment.text}`);

    const br = p.querySelector('br') as Element;
    // `<br>` 是硬边界，必须留在可见的那一层（被包进 span 就等于把两行并成一行）。
    expect(br.parentElement).toBe(p);
    expect(p.querySelectorAll('[data-jy-originals]')).toHaveLength(2);
    expect(visibleText(p)).toBe('【译】Line one【译】Line two');

    renderer.restore();
    expect(document.body.outerHTML).toBe(before);
  });
});

/**
 * 放开 BUTTON 采集之后的另一半修复：`<button><span>Products</span><svg>箭头</svg></button>`
 * 在仅译文模式下只该藏起**承载文字**的节点。svg / img / 纯空白文本节点不承载任何文字，
 * 必须留在原位保持可见——否则"产品"两个字后面的箭头会跟着原文一起消失，比不翻更糟。
 */
describe('DomRenderer 仅译文模式：纯视觉节点不被藏起来', () => {
  const ARROW_SVG = '<svg id="arrow" viewBox="0 0 12 12"><polyline points="2,4 6,8 10,4"/></svg>';

  it('按钮带箭头：文字进隐藏容器、宿主紧跟容器、svg 留在原位且仍在译文之后', () => {
    document.body.innerHTML = `<button><span>Products</span>${ARROW_SVG}</button>`;
    const button = document.querySelector('button') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(segment.element).toBe(button);

    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'done', '产品');

    const span = originalsOf(button);
    expect(span.textContent).toBe('Products');

    const arrow = document.getElementById('arrow') as Element;
    expect(arrow.parentElement, 'svg 不该被搬进隐藏容器').toBe(button);
    expect(span.contains(arrow)).toBe(false);
    // 顺序：[隐藏容器, 宿主(译文), svg] —— 图标仍跟在译文后面。
    expect(arrow.previousElementSibling?.tagName).toBe('JY-TRANSLATION');
    expect(bodyTextOf(button.querySelector('jy-translation') as Element)).toBe('产品');
    expect(visibleText(button)).toBe('产品');

    // 失败态把原文放回来：隐藏容器里的原文重新可见，图标本来就没藏。
    renderer.fail(segment.id, '网络错误');
    expect(visibleText(button)).toContain('Products');
    expect(visibleText(button)).toContain('网络错误');
  });

  it('锚点 + 文字：<a><img src=logo>Docs</a> 的图片留在原位，不被藏起来', () => {
    document.body.innerHTML = '<a id="l" href="/docs"><img id="logo" src="logo.png" alt="">Docs</a>';
    const a = document.getElementById('l') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(segment.element).toBe(a);

    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'done', '文档');

    const logo = document.getElementById('logo') as Element;
    expect(logo.parentElement).toBe(a);
    expect(originalsOf(a).contains(logo)).toBe(false);
    const order = Array.from(a.childNodes).map((node) =>
      node.nodeType === Node.TEXT_NODE ? '#text' : (node as Element).nodeName,
    );
    expect(order).toEqual(['IMG', 'SPAN', 'JY-TRANSLATION']);
    expect(visibleText(a)).toBe('文档');
  });

  it('svg 里有 <text> 也留在原位：判据走 inlineText 口径，不看 textContent', () => {
    document.body.innerHTML = '<p id="p">Read the <svg id="chart" viewBox="0 0 9 9"><text>chart label</text></svg> first</p>';
    const p = document.getElementById('p') as HTMLElement;
    const before = document.body.outerHTML;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    // 采集端就把 svg 里的文字排除在段文本外（它压根不会被翻译）——藏它反而制造"消失了段里没有的东西"。
    expect(segment.text).toBe('Read the first');

    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'done', '先读图');

    const chart = document.getElementById('chart') as Element;
    expect(chart.parentElement).toBe(p);
    for (const span of Array.from(p.querySelectorAll('[data-jy-originals]'))) {
      expect(span.contains(chart), '带文字的 svg 不该按 textContent 被误判为文字节点').toBe(false);
    }
    expect(visibleText(p)).toContain('先读图');
    expect(visibleText(p)).not.toContain('Read the');

    renderer.restore();
    // 文字被 svg 断成两组：逐字节还原钉住"每连续一段各自一个容器"的分组搬运。
    expect(document.body.outerHTML).toBe(before);
  });

  it('还原逐字节：图标 + 图片 + 空白 + 带文字 svg 的混合结构，还原后无 data-jy-* 残留', () => {
    document.body.innerHTML = [
      '<button><img id="logo" src="logo.png" alt=""><span>Products</span> ' + ARROW_SVG + '</button>',
      '<p>Read the <svg id="chart" viewBox="0 0 9 9"><text>chart label</text></svg> first</p>',
    ].join('');
    const before = document.body.outerHTML;
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(segments).toHaveLength(2);

    const renderer = new DomRenderer(document, 'translated-only');
    for (const segment of segments) renderer.mount(segment, 'done', `【译】${segment.order}`);

    // 视觉节点全部留在隐藏容器之外；被搬走的文字全部带着自己的容器。
    for (const id of ['logo', 'arrow', 'chart']) {
      const node = document.getElementById(id) as Element;
      expect(node.closest('[data-jy-originals]'), `#${id} 不该在隐藏容器里`).toBeNull();
    }
    const visible = visibleText(document.body);
    expect(visible).toContain('【译】0');
    expect(visible).toContain('【译】1');
    expect(visible).not.toContain('Products');
    expect(visible).not.toContain('Read the');
    expect(visible).not.toContain(' first');

    renderer.restore();
    expect(document.body.outerHTML).toBe(before);
    expect(document.querySelectorAll(JY_MARKERS)).toHaveLength(0);
  });
});

/**
 * 「仅译文」模式的端到端（任务书点名用例）：`<a style="display:inline">` 包整张卡片时，
 * 卡片里的 h3 与 p 各自成段、各自有译文，而 `<a>` **本身**不许被搬进隐藏原文容器——
 * 它是块级边界（extractor 的 `isBlockBoundary`，与渲染器 `carriesVisibleText` 同一份判据），
 * 不承载文字；搬走它就会把段落连同它们的译文一起藏掉。
 */
describe('DomRenderer 仅译文模式：inline 载体包卡片（digitalocean 形状）端到端', () => {
  it('h3 与 p 都有译文、原文各藏各的、<a> 留在原位仍可点击、还原逐字节', () => {
    document.body.innerHTML =
      '<div class="grid-item">' +
      '<a id="card" href="/products/droplets" style="display:inline">' +
      '<div class="styled"><div class="cc"><div class="content">' +
      '<h3 id="t">Cloud Titles Here</h3><p id="d">Card description sentence here</p>' +
      '</div></div></div></a></div>';
    const before = document.body.outerHTML;
    const link = document.getElementById('card') as HTMLElement;
    const gridItem = document.querySelector('.grid-item') as HTMLElement;
    const h3 = document.getElementById('t') as HTMLElement;
    const p = document.getElementById('d') as HTMLElement;

    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    // 载体必须**就是** h3 与 p 本身：`toEqual` 在 DOM 节点上是结构比较（`isEqualNode`），
    // 同构克隆体会假通过（探针：克隆体 toEqual=PASS / toBe=FAIL）。
    const carriers = segments.map((s) => s.element);
    expect(carriers).toHaveLength(2);
    expect(carriers[0]).toBe(h3);
    expect(carriers[1]).toBe(p);

    const renderer = new DomRenderer(document, 'translated-only');
    for (const segment of segments) renderer.mount(segment, 'done', `【译】${segment.order}`);

    // T 与 D 都有可见译文；原文被藏进各自段落内部的隐藏容器（不跨段落混装）。
    expect(visibleText(h3)).toBe('【译】0');
    expect(visibleText(p)).toBe('【译】1');
    expect(originalsOf(h3).textContent).toBe('Cloud Titles Here');
    expect(originalsOf(p).textContent).toBe('Card description sentence here');

    // <a> 仍可点击、不破坏布局：它留在原位（没被搬进任何隐藏容器），href 与父子关系原样，
    // 两个段落也仍在它的子树里——只是段落内部多了各自的原容器与宿主。
    expect(link.closest('[data-jy-originals]')).toBeNull();
    expect(link.parentElement).toBe(gridItem);
    expect(link.getAttribute('href')).toBe('/products/droplets');
    expect(link.contains(h3)).toBe(true);
    expect(link.contains(p)).toBe(true);

    // 逐字节还原：卡片链一个字符都不该被渲染器的搬运弄乱。
    renderer.restore();
    expect(document.body.outerHTML).toBe(before);
    expect(document.querySelectorAll(JY_MARKERS)).toHaveLength(0);
  });

  it('inline 载体自带直接文字时也只藏文字：载体本身留在原位（旧判据会整棵搬走）', () => {
    document.body.innerHTML =
      '<div class="host"><a id="w" href="/x">Link label <div class="card">Card body text</div></a></div>';
    const before = document.body.outerHTML;
    const link = document.getElementById('w') as HTMLElement;
    const hostDiv = document.querySelector('.host') as HTMLElement;
    const card = document.querySelector('.card') as HTMLElement;

    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    // "Link label" 归 <a>（松散文本段），"Card body text" 归 div.card（整元素段）。
    expect(segments.map((s) => s.text)).toEqual(['Link label', 'Card body text']);

    const renderer = new DomRenderer(document, 'translated-only');
    for (const segment of segments) renderer.mount(segment, 'done', `【译】${segment.order}`);

    // <a> 没被搬走：它的直接文字进隐藏容器，宿主插在容器后面，卡片原地不动。
    expect(link.parentElement).toBe(hostDiv);
    expect(link.closest('[data-jy-originals]')).toBeNull();
    const order = Array.from(link.childNodes).map((n) =>
      n.nodeType === Node.TEXT_NODE ? '#text' : (n as Element).nodeName,
    );
    expect(order).toEqual(['SPAN', 'JY-TRANSLATION', 'DIV']);
    expect(card.parentElement).toBe(link);
    expect(originalsOf(link).textContent).toBe('Link label ');
    expect(visibleText(link)).toContain('【译】0');
    expect(visibleText(link)).toContain('【译】1');

    renderer.restore();
    expect(document.body.outerHTML).toBe(before);
  });
});

describe('DomRenderer 仅译文模式：单一链接为主的段落保留链接指引', () => {
  /** nature.com 作者署名行的形状：整段几乎就是一个链接。 */
  const BYLINE_HTML =
    '<p id="p">By <a id="l" href="https://example.com/auth" ' +
    'style="color: rgb(0, 102, 204); text-decoration-line: underline">Davide Castelvecchi</a></p>';
  const TRANSLATION = '作者：达维德·卡斯泰尔韦基';

  function hostOf(element: Element): Element | undefined {
    return element.querySelector('jy-translation') ?? undefined;
  }

  function shadowAnchor(element: Element): HTMLAnchorElement | null {
    return (element.querySelector('jy-translation')?.shadowRoot?.querySelector('a') as HTMLAnchorElement) ?? null;
  }

  it('译文渲染成 <a>：href 正确、下划线与颜色抄自原链接（shadow 隔离了页面 CSS，必须抄）', () => {
    document.body.innerHTML = BYLINE_HTML;
    const p = document.getElementById('p') as HTMLElement;
    const before = document.body.outerHTML;
    const originalLink = document.getElementById('l') as HTMLElement;
    const view = document.defaultView as Window;
    const expectedColor = view.getComputedStyle(originalLink).color;
    expect(expectedColor).toBe('rgb(0, 102, 204)'); // 探针确认 cssstyle 会规范化十六进制/rgb 写法

    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'done', TRANSLATION);

    const anchor = shadowAnchor(p);
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe('https://example.com/auth'); // 存在且正确 = 可点；不做真导航断言
    expect(anchor?.textContent).toBe(TRANSLATION);
    expect(anchor?.style.textDecorationLine).toBe('underline');
    expect(anchor?.style.color).toBe(expectedColor);
    // 可见文本仍是译文本身（包成链接没有把文字弄丢或弄脏）。
    expect(visibleText(p)).toBe(TRANSLATION);
    // 原文节点一个没动：还原之后依旧逐字节回到原样。
    renderer.restore();
    expect(document.body.outerHTML).toBe(before);
  });

  it('pending 与失败态不包链接；重试成功后的 update 让链接回来', () => {
    document.body.innerHTML = BYLINE_HTML;
    const p = document.getElementById('p') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'translated-only');

    renderer.mount(segment, 'pending');
    expect(shadowAnchor(p)).toBeNull(); // 「翻译中…」只是占位文本

    renderer.fail(segment.id, '网络错误');
    expect(shadowAnchor(p)).toBeNull(); // 错误标注不包链接（原文此刻已放回可见，真链接就在原地可点）

    renderer.mount(segment, 'pending');
    renderer.update(segment.id, TRANSLATION);
    expect(shadowAnchor(p)?.getAttribute('href')).toBe('https://example.com/auth');
    expect(visibleText(p)).toBe(TRANSLATION);
  });

  it('一段正文里只有一个小链接（占比 < 0.6）：译文保持纯文本，防止整段变蓝', () => {
    document.body.innerHTML =
      '<p id="p">Introduction paragraph text about climate research findings ' +
      'with plenty more words describing the study in detail <a href="https://example.com/supplement">supplement</a></p>';
    const p = document.getElementById('p') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'done', '译文');

    expect(shadowAnchor(p)).toBeNull();
    expect(bodyTextOf(hostOf(p) as Element)).toBe('译文');
    expect(visibleText(p)).toBe('译文');
  });

  it('阈值恰好取到 0.6 时包；0.5x 时不包（边界钉死）', () => {
    // 段文本 'Lead-in abcdefghijkl' = 20 字符，链接文本 12 → 12/20 = 0.6 → 包。
    document.body.innerHTML = '<p id="p">Lead-in <a href="https://example.com/x">abcdefghijkl</a></p>';
    let p = document.getElementById('p') as HTMLElement;
    let [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(segment.text).toBe('Lead-in abcdefghijkl');
    let renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'done', '译文');
    expect(shadowAnchor(p)).not.toBeNull();

    // 段文本多一个字符 → 12/21 < 0.6 → 不包。
    document.body.innerHTML = '<p id="p">Lead-in1 <a href="https://example.com/x">abcdefghijkl</a></p>';
    p = document.getElementById('p') as HTMLElement;
    [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'done', '译文');
    expect(shadowAnchor(p)).toBeNull();
  });

  it('段落里有两个 <a href>：语义不明，保持纯文本（哪怕第一个单独看已过阈值）', () => {
    // 形状刻意让 link1 占 19/31 ≥ 0.6——拦住它的必须**只有**"恰好一个"这条闸，
    // 不然变异实验分不清是占比救的还是数量闸生效的。
    document.body.innerHTML =
      '<p id="p"><a href="https://a.example/one">Davide Castelvecchi</a> &amp; <a href="https://b.example/two">Liz Else</a></p>';
    const p = document.getElementById('p') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(segment.text).toBe('Davide Castelvecchi & Liz Else');
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'done', '译文');

    expect(shadowAnchor(p)).toBeNull();
    expect(bodyTextOf(hostOf(p) as Element)).toBe('译文');
  });

  it.each([
    ['javascript:', 'javascript:document.title="pwned"'],
    ['带前导空白的 javascript:', ' JavaScript:document.title="pwned"'],
    ['data:', 'data:text/html,<script>document.title="pwned"</script>'],
    ['vbscript:', 'vbscript:msgbox("pwned")'],
    ['自定义协议', 'weird-thing:whatever'],
    ['相对协议 //host', '//evil.example/x'],
    ['反斜杠变体 \\\\host', '\\\\evil.example\\x'],
  ])('危险/不可用协议 %s：不设置 href，降级为纯文本译文，且无脚本执行', (_label, href) => {
    document.body.innerHTML =
      `<p id="p">By <a href="${href}">Davide Castelvecchi</a></p>`;
    const p = document.getElementById('p') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'translated-only');
    expect(() => renderer.mount(segment, 'done', TRANSLATION)).not.toThrow();

    expect(shadowAnchor(p)).toBeNull(); // 连不带 href 的 <a> 都不许出现——纯文本才是这份契约
    expect(bodyTextOf(hostOf(p) as Element)).toBe(TRANSLATION);
    expect(document.title).not.toBe('pwned');
  });

  it('mailto 与页内锚点在允许名单内：照常包成链接', () => {
    document.body.innerHTML =
      '<p id="p1">By <a href="mailto:author@example.com">Davide Castelvecchi</a></p>' +
      '<p id="p2">Jump to <a href="#section-one">Section One</a> for details of the section</p>';
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'translated-only');
    for (const segment of segments) renderer.mount(segment, 'done', `译:${segment.text}`);

    const mail = shadowAnchor(document.getElementById('p1') as HTMLElement);
    expect(mail).not.toBeNull();
    expect(mail?.getAttribute('href')).toBe('mailto:author@example.com');
    // 页内 #锚点：p2 整段文本里链接占比不足，不包是**占比规则**的正确行为——
    // 协议允许性由 mailto 分支钉；相对 http 解析在阈值用例里天然是通过协议校验的。
    expect(shadowAnchor(document.getElementById('p2') as HTMLElement)).toBeNull();
  });

  it('隐藏的子树里的链接不计数也不参与包裹（占比按可见文本算）', () => {
    document.body.innerHTML =
      '<p id="p">By <a id="l" href="https://example.com/auth">Davide Castelvecchi</a>' +
      '<span style="display:none"><a href="https://example.com/hidden">gone</a></span></p>';
    const p = document.getElementById('p') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    // 采集端就把隐藏 span 排除了——链接判据必须同一口径，否则"恰好一个"被隐藏链接搅黄。
    expect(segment.text).toBe('By Davide Castelvecchi');
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'done', TRANSLATION);
    expect(shadowAnchor(p)?.getAttribute('href')).toBe('https://example.com/auth');
  });

  it('松散文本段：只在本段节点里找链接，兄弟段落（含它自己的链接）绝不串台', () => {
    document.body.innerHTML =
      '<div id="box">By <a href="https://example.com/auth">Davide Castelvecchi</a>' +
      '<p id="body">See <a href="https://other.example/doc">unrelated doc link</a> for details about this</p></div>';
    const box = document.getElementById('box') as HTMLElement;
    const body = document.getElementById('body') as HTMLElement;
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual([
      'By Davide Castelvecchi',
      'See unrelated doc link for details about this',
    ]);

    const renderer = new DomRenderer(document, 'translated-only');
    for (const segment of segments) renderer.mount(segment, 'done', `译:${segment.text}`);

    // 本段（容器直接文本）几乎全是它的链接 → 包；链接节点已搬进本段的隐藏 span。
    const bylineHosts = Array.from(box.querySelectorAll(':scope > jy-translation'));
    expect(bylineHosts).toHaveLength(1);
    const anchor = bylineHosts[0]?.shadowRoot?.querySelector('a') as HTMLAnchorElement | null;
    expect(anchor?.getAttribute('href')).toBe('https://example.com/auth');

    // 兄弟段落自己链接占比不足 → 纯文本；它的链接没有污染本段判定。
    expect(bodyTextOf(hostOf(body) as Element)).toBe('译:See unrelated doc link for details about this');
    const bodyAnchor = body.querySelector('jy-translation')?.shadowRoot?.querySelector('a');
    expect(bodyAnchor).toBeNull();
  });

  it('双语模式：这个段落的行为与改动前逐字一致（不藏原文、译文纯文本、还原回原样）', () => {
    document.body.innerHTML = BYLINE_HTML;
    const p = document.getElementById('p') as HTMLElement;
    const pristine = p.outerHTML;
    const originalLink = document.getElementById('l') as HTMLAnchorElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    // 既有形状：段里有行内子元素 → 整元素段仍成段，但带 textRun（不可就地替换），
    // 双语宿主因此落在**段尾内部**。本条钉的是"链接包译文不渗透进双语模式"。

    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, TRANSLATION);

    // 原文没有被搬进任何隐藏 span：链接节点还在原位、属性未动、一个字符没改。
    expect(p.querySelector('[data-jy-originals]')).toBeNull();
    expect(originalLink.parentElement).toBe(p);
    expect(originalLink.getAttribute('href')).toBe('https://example.com/auth');
    expect(originalLink.textContent).toBe('Davide Castelvecchi');
    expect(p.firstChild?.textContent).toBe('By ');

    // 译文是纯文本：链接包译文**不**渗透进双语模式。
    const host = p.querySelector('jy-translation') as Element;
    expect(host).not.toBeNull();
    expect(host.shadowRoot?.querySelector('a')).toBeNull();
    expect(host.shadowRoot?.querySelector('.jy-body')?.textContent).toBe(TRANSLATION);

    // 更强的"逐字一致"证据：还原之后整段回到翻译前的原样（标记全清、结构未动）。
    renderer.restore();
    expect(p.outerHTML).toBe(pristine);
  });
});

describe('译文样式：两种模式的诉求相反', () => {
  /** 宿主 Shadow DOM 里实际注入的那份样式表。 */
  const injectedCss = (): string =>
    document.querySelector('jy-translation')?.shadowRoot?.querySelector('style')?.textContent ?? '';

  it('仅译文模式对排版透明：不写死颜色、不加边框内边距、不撑成块', () => {
    // 回归的是实测 bug：apple.com 的小按钮（<a class="button">Learn more</a>，白字蓝底、
    // 写死行高与 nowrap）在仅译文下变宽、变高、字号与颜色都变了。根因全在我们自己
    // 注入的译文样式里——那套区分性样式在双语模式是特性，在替代原文时是破坏。
    const segment = paragraph('Learn more');
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '了解更多');

    const css = injectedCss();
    expect(css.length).toBeGreaterThan(0);

    // 硬编码颜色会让白字按钮上的译文变成"蓝底上的深蓝字"，几乎看不见。
    expect(css).toContain('color: inherit');
    expect(css).not.toContain('#2b6cb0');
    // 左边框 + 左内边距给按钮凭空加了约 11px 宽（用户报的「变长了」）。
    expect(css).not.toContain('border-left');
    expect(css).toContain('border: 0');
    // 0.97em 让字号与周围文字脱节；line-height 1.6 撑高行盒（用户报的「大小变了」）。
    expect(css).not.toContain('0.97em');
    expect(css).toContain('font: inherit');
    // 块级盒子会把行内按钮里的文字撑成两行。
    expect(css).toContain('display: inline');
    expect(css).not.toContain('display: block');
    // 按钮常写 white-space:nowrap，我们若强行 pre-wrap 就会把它撑开。
    expect(css).toContain('white-space: inherit');
  });

  it('双语模式保留区分性样式：译文要看得出是译文', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '你好世界');

    const css = injectedCss();
    expect(css).toContain('#2b6cb0');
    expect(css).toContain('border-left');
    expect(css).toContain('display: block');
  });
});

describe('DomRenderer 仅译文模式：失败态', () => {
  it('失败时显示错误文案与重试按钮，不是静默', () => {
    const segment = paragraph('Hello world');
    const onRetry = vi.fn();
    const renderer = new DomRenderer(document, 'translated-only', onRetry);
    renderer.mount(segment, 'pending');
    renderer.fail(segment.id, '网络错误');

    const host = segment.element.querySelector('jy-translation') as Element;
    expect(bodyTextOf(host)).toContain('网络错误');
    const button = host.shadowRoot?.querySelector('.jy-retry') as HTMLButtonElement;
    expect(button).not.toBeNull();
    // 失败时原文一个字符都没丢（只是藏起来了），点重试仍然有救。
    expect(originalsOf(segment.element).textContent).toBe('Hello world');
    expect(visibleText(segment.element)).toContain('网络错误');

    button.click();
    expect(onRetry).toHaveBeenCalledWith('jy-1');
  });

  it('失败时把原文放回来，重试时再藏起来', () => {
    // 这条守的是一个很容易被忽略的可用性后果：整页失败（没填 Key、断网、限流）时，
    // 如果原文还藏着，页面上就只剩一片红字——用户连想读的原文都看不见，得先按 Alt+T。
    // 那比"遮挡"更糟：遮挡只是多了一倍文字，这个是把内容整个拿走了。
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'pending');

    const span = originalsOf(segment.element);
    expect(span.style.display).toBe('none'); // 进行中：原文藏着，让位给"翻译中…"

    renderer.fail(segment.id, '网络错误');
    expect(span.style.display).not.toBe('none'); // 失败：原文必须看得见
    expect(visibleText(segment.element)).toContain('Hello world');
    expect(visibleText(segment.element)).toContain('网络错误');

    // 用户点重试 → 重新进入进行中，原文再藏起来。
    renderer.mount(segment, 'pending');
    expect(span.style.display).toBe('none');

    // 重试成功 → 保持藏着，显示译文。
    renderer.update(segment.id, '你好世界');
    expect(span.style.display).toBe('none');
    expect(visibleText(segment.element)).toBe('你好世界');
  });

  it('不可重试的失败只给原因，不挂按钮', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'pending');
    renderer.fail(segment.id, '缺少 API Key', false);

    const host = segment.element.querySelector('jy-translation') as Element;
    expect(bodyTextOf(host)).toContain('缺少 API Key');
    expect(host.shadowRoot?.querySelector('.jy-retry')).toBeNull();
  });

  it('失败之后还原：原文照原样回来', () => {
    document.body.innerHTML = '<p id="p">Click <a href="/x">here</a> now</p>';
    const before = document.body.outerHTML;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'pending');
    renderer.fail(segment.id, '网络错误');

    renderer.restore();
    expect(document.body.outerHTML).toBe(before);
  });
});

describe('DomRenderer 仅译文模式：还原逐字节', () => {
  const RICH_HTML = [
    '<article>',
    '<h1>Hello world</h1>',
    '<p>Click <a href="/x">here</a> now</p>',
    '<p>An image <img src="a.png" alt="pic"> inside</p>',
    '<div id="box">Intro sentence<p id="body">Nested body text</p>Outro sentence</div>',
    '<table><tbody><tr><td>Cell text</td><td>Second cell</td></tr></tbody></table>',
    '<ul><li>Item text</li><li>Another item</li></ul>',
    '<div style="display:flex"><p style="display:block">Flex child text</p></div>',
    '<p>Line one<br>Line two</p>',
    '</article>',
  ].join('');

  it('还原后 body.outerHTML 与翻译前完全相同，且没有 data-jy-* 残留', () => {
    document.body.innerHTML = RICH_HTML;
    const before = document.body.outerHTML;

    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(segments.length).toBeGreaterThan(6);
    const renderer = new DomRenderer(document, 'translated-only');
    // 译文刻意不含原文，否则"看不见原文"这条断言会被译文里的原文自己骗过去。
    for (const segment of segments) renderer.mount(segment, 'done', `MOCK-${segment.order}`);

    // 翻译态下正文里不应该还有可见的英文原文（藏起来的不算）。
    expect(visibleText(document.body)).not.toContain('Hello world');
    expect(visibleText(document.body)).not.toContain('Cell text');
    expect(visibleText(document.body)).toContain('MOCK-0');
    expect(visibleText(document.body)).toContain(`MOCK-${segments.length - 1}`);

    renderer.restore();

    // 逐字节：行内标记、图片、嵌套结构、文本节点边界全部回到原样。
    expect(document.body.outerHTML).toBe(before);
    expect(document.querySelectorAll(JY_MARKERS)).toHaveLength(0);
  });

  it('还原之后重新采集得到同样的段落（标记不残留、原文没被销毁）', () => {
    document.body.innerHTML = RICH_HTML;
    const renderer = new DomRenderer(document, 'translated-only');

    const first = collectSegments(document.body, { targetLang: 'zh-Hans' });
    for (const segment of first) renderer.mount(segment, 'done', `【译】${segment.text}`);
    renderer.restore();

    const second = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(second.map((s) => s.text)).toEqual(first.map((s) => s.text));
    expect(document.querySelectorAll('jy-translation')).toHaveLength(0);
    expect(document.querySelectorAll('[data-jy-originals]')).toHaveLength(0);
  });
});

describe('DomRenderer 还原的边界', () => {
  it('元素被框架移出文档之后，restore 仍把原文搬回去', () => {
    document.body.innerHTML = '<div id="box"><p id="p">Original english text</p></div>';
    const p = document.getElementById('p') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'done', '替换后的译文');
    expect(visibleText(p)).toBe('替换后的译文');

    // 框架把节点摘下来（脱离文档，但引用还在手里）：缓存的 span 仍然是它的子节点。
    p.remove();
    expect(p.isConnected).toBe(false);

    renderer.restore();

    expect(p.textContent).toBe('Original english text');
    expect(p.hasAttribute('data-jy-translated')).toBe(false);
    expect(p.querySelectorAll(JY_MARKERS)).toHaveLength(0);
  });

  it('页面在翻译之后换掉节点，restore 把原文搬进活着的那个', () => {
    document.body.innerHTML = '<div id="box"><p id="p">Original english text</p></div>';
    const box = document.getElementById('box') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'done', '替换后的译文');

    // 框架重渲染：新节点继承了旧节点上的插件标记，旧节点被丢掉。
    const replacement = document.createElement('p');
    replacement.setAttribute('data-jy-id', segment.id);
    replacement.setAttribute('data-jy-translated', '1');
    replacement.textContent = '框架重新渲染出来的文本';
    box.replaceChildren(replacement);

    renderer.restore();

    // 原文没有丢——它就在隐藏 span 里，整块搬进活着的那一个（与双语模式写回快照等价）。
    expect(replacement.textContent).toBe('Original english text');
    expect(replacement.hasAttribute('data-jy-translated')).toBe(false);
    expect(replacement.hasAttribute('data-jy-id')).toBe(false);
  });

  it('还原后重新采集仍是同样三段（标记不残留）', () => {
    document.body.innerHTML = '<div id="box">Intro sentence here<p>Body paragraph text</p>Outro sentence here</div>';
    const box = document.getElementById('box') as HTMLElement;
    const renderer = new DomRenderer(document, 'bilingual');

    const first = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(first.map((s) => s.text)).toEqual([
      'Intro sentence here',
      'Body paragraph text',
      'Outro sentence here',
    ]);
    for (const segment of first) renderer.mount(segment, 'pending');
    renderer.restore();

    const second = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(second.map((s) => s.text)).toEqual(first.map((s) => s.text));
    expect(box.querySelectorAll('jy-translation')).toHaveLength(0);
  });
});

describe('DomRenderer 文本段（混合内容里的直接文本）', () => {
  it('锚点是容器时插进容器内部、在下一个块级子元素之前', () => {
    document.body.innerHTML = '<div id="box">Intro sentence here<p id="body">Body paragraph text</p></div>';
    const box = document.getElementById('box') as HTMLElement;
    // 用真实抽取结果：锚点是容器本身，落点显式指向紧随其后的块级子元素。
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(segment.textRun).toBe(true);
    expect(segment.element).toBe(box);
    // 身份比较：`toEqual` 对 DOM 节点是结构比较（`isEqualNode`），把落点换成与 `#body`
    // 同构的段落（夹具里的同构兄弟/克隆体）照样绿；这里要的是**那一个**节点。
    expect(segment.anchor.kind).toBe('before');
    expect(segment.anchor.kind === 'before' ? segment.anchor.node : undefined).toBe(document.getElementById('body'));

    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');

    const host = document.querySelector('jy-translation') as Element;
    expect(host.parentElement).toBe(box);
    expect(host.nextElementSibling).toBe(document.getElementById('body'));
  });

  it('段落中段的松散文本插到它后面那个兄弟节点之前', () => {
    document.body.innerHTML =
      '<div id="box"><p id="first">Block one text</p>stray text here<p id="second">Block two text</p></div>';
    const box = document.getElementById('box') as HTMLElement;
    const second = document.getElementById('second') as HTMLElement;
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const stray = segments.find((item) => item.text.includes('stray'));
    expect(stray?.textRun).toBe(true);
    // 落点在容器上，位置由 anchor 显式给出（旧实现把后一个块级子元素本身当锚点）。
    expect(stray?.element).toBe(box);
    // 身份比较：`toEqual` 在 DOM 节点上是结构比较（`isEqualNode`），同构的同级段落会假通过。
    expect(stray?.anchor.kind).toBe('before');
    expect(stray && stray.anchor.kind === 'before' ? stray.anchor.node : undefined).toBe(second);

    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(stray as ExtractedSegment, 'pending');

    const host = document.querySelector('jy-translation') as Element;
    expect(host.parentElement).toBe(box);
    expect(host.nextElementSibling).toBe(second);
    expect(host.previousElementSibling).toBe(document.getElementById('first'));
  });

  it('容器里的文本段插在容器内部，不跑到容器外面去', () => {
    document.body.innerHTML = '<div id="outer"><div id="box">Intro sentence here<p id="body">Body paragraph text</p></div></div>';
    const outer = document.getElementById('outer') as HTMLElement;
    const box = document.getElementById('box') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });

    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');

    const host = document.querySelector('jy-translation') as Element;
    expect(host.parentElement).toBe(box);
    expect(outer.querySelectorAll(':scope > jy-translation')).toHaveLength(0);
  });

  it('松散文本段的译文宿主按原文顺序与节点交替出现', () => {
    document.body.innerHTML =
      '<div id="box">Intro sentence here<p id="body">Body paragraph text</p>Outro sentence here</div>';
    const box = document.getElementById('box') as HTMLElement;
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'bilingual');
    for (const segment of segments) renderer.mount(segment, 'done', `【译】${segment.text}`);

    const order = Array.from(box.childNodes).map((node) => {
      if (node.nodeType === Node.TEXT_NODE) return `原文:${(node.nodeValue ?? '').trim()}`;
      const element = node as Element;
      if (element.tagName === 'JY-TRANSLATION') {
        return `译文:${element.shadowRoot?.querySelector('.jy-body')?.textContent ?? ''}`;
      }
      return `块:${element.nodeName}#${element.id}`;
    });

    // 旧实现的顺序是「Intro 原文 / Intro 译 / Outro 译 / Body 原文 / Body 译 / Outro 原文」，
    // 用户会把 Outro 的译文当成 Body 的译文。
    expect(order).toEqual([
      '原文:Intro sentence here',
      '译文:【译】Intro sentence here',
      '块:P#body',
      '译文:【译】Body paragraph text',
      '原文:Outro sentence here',
      '译文:【译】Outro sentence here',
    ]);
  });

  it('重扫：已翻译的整元素段落不重复产出，松散文本段会被再次采集', () => {
    document.body.innerHTML = '<div id="box">Intro sentence here<p id="body">Body paragraph text</p></div>';
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'bilingual');
    for (const segment of segments) renderer.mount(segment, 'pending');

    expect(document.querySelectorAll('jy-translation')).toHaveLength(2);

    // 松散文本段**有意**不标记它所在的容器（标了会让容器里新追加的子元素在重扫时被整棵短路），
    // 所以它会被再次采集：这一段防重由调用方（编排层）负责，代价比「新内容永远不翻」小得多。
    const again = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(again.map((s) => s.text)).toEqual(['Intro sentence here']);
    // 落点跳过插件自己注入的 [data-jy-root]：参照的是它后面那个块级子元素。
    // 身份比较：`toEqual` 对 DOM 节点是结构比较（`isEqualNode`），同构克隆体会假通过。
    expect(again[0].anchor.kind).toBe('before');
    expect(
      again[0].anchor.kind === 'before' ? again[0].anchor.node : undefined,
    ).toBe(document.getElementById('body'));
    // 已经翻译过的段落不会再被产出。
    expect(again.some((s) => s.text === 'Body paragraph text')).toBe(false);
  });

  it('restore 后原文一字不差，标记清空', () => {
    document.body.innerHTML = '<div id="box">Intro sentence here<p id="body">Body paragraph text</p></div>';
    const before = document.body.innerHTML;
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'bilingual');
    for (const segment of segments) renderer.mount(segment, 'pending');
    renderer.restore();

    expect(document.body.innerHTML).toBe(before);
    expect(document.querySelector('[data-jy-id]')).toBeNull();
    expect(document.querySelector('[data-jy-translated]')).toBeNull();
  });
});
