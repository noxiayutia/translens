/**
 * @vitest-environment jsdom
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
    expect(segment.anchor).toEqual({ kind: 'before', node: document.getElementById('body') });

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
    expect(stray?.anchor).toEqual({ kind: 'before', node: second });

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
    expect(again[0].anchor).toEqual({ kind: 'before', node: document.getElementById('body') });
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
