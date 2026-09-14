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
  return { id: 'jy-1', text, order: 0, element };
}

function bodyTextOf(host: Element): string {
  return host.shadowRoot?.querySelector('.jy-body')?.textContent ?? '';
}

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
    const segment: ExtractedSegment = { id: 'jy-1', text: 'Cell text', order: 0, element: cell };
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    expect(cell.querySelector('jy-translation')).not.toBeNull();
  });

  it('弹性布局父容器下译文插到段落内部', () => {
    document.body.innerHTML =
      '<div style="display:flex"><p id="p" style="display:block">Flex child text</p></div>';
    const p = document.getElementById('p') as HTMLElement;
    const segment: ExtractedSegment = { id: 'jy-1', text: 'Flex child text', order: 0, element: p };
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    expect(p.querySelector('jy-translation')).not.toBeNull();
  });

  it('列表项的译文插进列表项内部', () => {
    document.body.innerHTML = '<ul><li id="li">Item text</li></ul>';
    const li = document.getElementById('li') as HTMLElement;
    const segment: ExtractedSegment = { id: 'jy-1', text: 'Item text', order: 0, element: li };
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

describe('DomRenderer 替换模式', () => {
  it('把原文替换成译文', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'replace');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '你好，世界');
    expect(segment.element.textContent).toBe('你好，世界');
  });

  it('不插入额外宿主', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'replace');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '你好，世界');
    expect(document.querySelector('jy-translation')).toBeNull();
  });

  it('restore 还原原文', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'replace');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '你好，世界');
    renderer.restore();
    expect(segment.element.textContent).toBe('Hello world');
  });

  it('失败时不破坏原文', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'replace');
    renderer.mount(segment, 'pending');
    renderer.fail(segment.id, '网络错误');
    expect(segment.element.textContent).toBe('Hello world');
  });

  it('段落里带行内元素时退回双语注入，绝不销毁行内标记', () => {
    document.body.innerHTML = '<p id="p">Click <a href="/x">here</a> now</p>';
    const p = document.getElementById('p') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(segment.element).toBe(p);

    const renderer = new DomRenderer(document, 'replace');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '点击这里');

    // 原文（含链接）原样保留，译文另起宿主。
    expect(p.querySelector('a')).not.toBeNull();
    expect(p.textContent).toBe('Click here now');
    expect(document.querySelector('jy-translation')).not.toBeNull();

    renderer.restore();
    expect(p.querySelector('a')).not.toBeNull();
    expect(p.innerHTML).toBe('Click <a href="/x">here</a> now');
  });
});

describe('DomRenderer 文本段（混合内容里的直接文本）', () => {
  it('锚点是容器时插进容器内部、在下一个块级子元素之前', () => {
    document.body.innerHTML = '<div id="box">Intro sentence here<p id="body">Body paragraph text</p></div>';
    const box = document.getElementById('box') as HTMLElement;
    // 用真实抽取结果：锚点是容器本身（后面紧跟块级子元素）。
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(segment.textRun).toBe(true);
    expect(segment.element).toBe(box);

    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');

    const host = document.querySelector('jy-translation') as Element;
    expect(host.parentElement).toBe(box);
    expect(host.nextElementSibling).toBe(document.getElementById('body'));
  });

  it('锚点是段后面的块级子元素时插到它之前', () => {
    document.body.innerHTML = '<div id="box"><p id="first">Block one text</p>stray text here<p id="second">Block two text</p></div>';
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const stray = segments.find((item) => item.text.includes('stray'));
    expect(stray?.textRun).toBe(true);
    expect(stray?.element).toBe(document.getElementById('second'));

    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(stray as ExtractedSegment, 'pending');

    const host = document.querySelector('jy-translation') as Element;
    expect(host.parentElement).toBe(document.getElementById('box'));
    expect(host.nextElementSibling).toBe(document.getElementById('second'));
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

  it('混合内容全部渲染后再采集不会重复成段', () => {
    document.body.innerHTML = '<div id="box">Intro sentence here<p id="body">Body paragraph text</p></div>';
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'bilingual');
    for (const segment of segments) renderer.mount(segment, 'pending');

    expect(document.querySelectorAll('jy-translation')).toHaveLength(2);
    // 容器的直接文本段也渲染过之后，整棵子树都该被标记，再采集不能冒出新的段。
    expect(collectSegments(document.body, { targetLang: 'zh-Hans' })).toHaveLength(0);
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

describe('DomRenderer 还原的边界', () => {
  it('页面在翻译之后换掉节点，restore 也能把原文写回活着的那个', () => {
    document.body.innerHTML = '<div id="box"><p id="p">Original english text</p></div>';
    const box = document.getElementById('box') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'replace');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '替换后的译文');
    expect(segment.element.textContent).toBe('替换后的译文');

    // 框架重渲染：新节点继承了旧节点上的插件标记。
    const replacement = document.createElement('p');
    replacement.setAttribute('data-jy-id', segment.id);
    replacement.setAttribute('data-jy-translated', '1');
    replacement.textContent = '替换后的译文';
    box.replaceChildren(replacement);

    renderer.restore();

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
