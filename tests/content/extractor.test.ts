/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectSegments, isBlockDisplay } from '../../src/content/extractor';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('isBlockDisplay', () => {
  it('识别块级 display', () => {
    expect(isBlockDisplay('block')).toBe(true);
    expect(isBlockDisplay('list-item')).toBe(true);
    expect(isBlockDisplay('table-cell')).toBe(true);
    expect(isBlockDisplay('flex')).toBe(true);
    expect(isBlockDisplay('grid')).toBe(true);
  });

  it('行内与空值不算块级', () => {
    expect(isBlockDisplay('inline')).toBe(false);
    expect(isBlockDisplay('inline-block')).toBe(false);
    expect(isBlockDisplay('')).toBe(false);
    expect(isBlockDisplay(undefined)).toBe(false);
  });
});

/**
 * 隐藏判定（display:none / visibility:hidden / hidden / aria-hidden）与行内文本拼装
 * 现在都只在 collectSegments 内部按元素缓存一次，所以这里不再单独断言那两个内部函数，
 * 改由下面 collectSegments 的用例端到端覆盖——那里才是它们真正影响结果的地方。
 */

describe('collectSegments', () => {
  it('把每个段落收成一段', () => {
    const root = mount('<p>Hello world</p><p>Goodbye world</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Hello world', 'Goodbye world']);
  });

  it('行内子元素不单独成段', () => {
    const root = mount('<p>Hello <b>bold</b> world</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('Hello bold world');
  });

  it('折叠空白', () => {
    const root = mount('<p>  Hello\n   world  </p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Hello world']);
  });

  it('有空白或标点做边界时不重复补分隔符', () => {
    const root = mount('<p>Hello <b>bold</b>, and <i>italic</i>.</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Hello bold, and italic.']);
  });

  it('嵌套块级结构只取最内层文本块', () => {
    const root = mount('<div><p>One two</p><p>Three four</p></div>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['One two', 'Three four']);
  });

  it('跳过 script / style / code', () => {
    const root = mount(
      '<script>var a = 1;</script><style>p{color:red}</style><pre>const a = 1</pre><p>Real content here</p>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Real content here']);
  });

  it('跳过隐藏元素', () => {
    const root = mount('<p style="display:none">Hidden text</p><p>Visible text</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Visible text']);
  });

  it('跳过纯数字与纯标点', () => {
    const root = mount('<p>12345</p><p>—— ……</p><p>Real content</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Real content']);
  });

  it('目标中文时跳过中文段落', () => {
    const root = mount('<p>这是中文段落</p><p>This is English</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['This is English']);
  });

  it('不重复采集已翻译过的节点', () => {
    const root = mount('<p data-jy-translated="1">Already done</p><p>Fresh content</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Fresh content']);
  });

  it('跳过插件自己注入的节点', () => {
    const root = mount('<p>Original text</p><jy-translation data-jy-root=""><span>译文</span></jy-translation>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Original text']);
  });

  it('给每段分配唯一 id 与递增 order', () => {
    const root = mount('<p>One two</p><p>Three four</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments[0].id).not.toBe(segments[1].id);
    expect(segments.map((s) => s.order)).toEqual([0, 1]);
    expect(segments[0].element.getAttribute('data-jy-id')).toBe(segments[0].id);
  });

  it('表格单元格各自成段', () => {
    const root = mount('<table><tbody><tr><td>First cell</td><td>Second cell</td></tr></tbody></table>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['First cell', 'Second cell']);
  });

  it('列表项各自成段且不重复', () => {
    const root = mount('<ul><li>First item</li><li>Second item</li></ul>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['First item', 'Second item']);
  });

  it('空页面返回空数组', () => {
    expect(collectSegments(mount(''), { targetLang: 'zh-Hans' })).toEqual([]);
  });

  it('支持自定义跳过谓词', () => {
    const root = mount('<p>Skip me</p><p>Keep me</p>');
    const segments = collectSegments(root, {
      targetLang: 'zh-Hans',
      shouldSkipText: (text) => text.startsWith('Skip'),
    });
    expect(segments.map((s) => s.text)).toEqual(['Keep me']);
  });

  it('混合内容里容器自己的直接文本也成段，且保持文档顺序', () => {
    const root = mount(
      '<div>Article intro sentence here<p>Body paragraph one is here</p>Article outro sentence here</div>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual([
      'Article intro sentence here',
      'Body paragraph one is here',
      'Article outro sentence here',
    ]);
  });

  it('混合内容的文本段锚在容器上，块级子元素之前的那段标出插入点', () => {
    const root = mount('<div>Intro sentence here<p>Body paragraph text</p>Outro sentence here</div>');
    const div = document.querySelector('div') as HTMLElement;
    const paragraph = document.querySelector('p') as HTMLElement;
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });

    expect(segments[0].textRun).toBe(true);
    expect(segments[0].element).toBe(div);
    // 锚点是容器：译文留在容器内部（渲染器会插到第一个块级子元素之前）。
    expect(segments[0].prepend).toBeUndefined();
    expect(segments[1].textRun).toBeUndefined();
    expect(segments[1].element).toBe(paragraph);
    expect(segments[2].textRun).toBe(true);
    expect(segments[2].element).toBe(div);
    expect(segments[2].prepend).toBeUndefined();
  });

  it('列表项里「标签文本 + 嵌套列表」两段都不丢', () => {
    const root = mount('<ul><li>Item label text<ul><li>Nested item text</li></ul></li></ul>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Item label text', 'Nested item text']);
  });

  it('相邻行内元素之间补分隔符，不在同一个非词里粘连', () => {
    const root = mount('<nav><a><span>Home</span></a><a><span>Pricing</span></a><a><span>Docs</span></a></nav>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Home Pricing Docs']);
  });

  it('<br> 是硬边界，各行分别成段', () => {
    const root = mount('<address>1 Main St<br>Springfield<br>IL 62704</address>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['1 Main St', 'Springfield', 'IL 62704']);
  });

  it('段落中段的直接文本锚到它后面的块级子元素上', () => {
    const root = mount('<div><p>Block one text</p>stray inline text<p>Block two text</p></div>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Block one text', 'stray inline text', 'Block two text']);
    expect(segments[1].textRun).toBe(true);
    // 锚点是后一个块级子元素：插到它前面就落在两段文本之间。
    expect((segments[1].element as Element).textContent).toBe('Block two text');
    expect(segments[1].prepend).toBe(true);
  });

  it('就地替换只留给「整块就是这一段文本」的元素', () => {
    const root = mount('<p>Hello <b>bold</b> world</p><p>Plain english text</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    // 带行内标记的段落不能被 textContent 盖掉，标记成 textRun 让渲染器改走双语注入。
    expect(segments[0].textRun).toBe(true);
    // 只有真的要插到锚点之前才带 prepend 标记。
    expect(segments[0].prepend).toBeUndefined();
    expect(segments[1].textRun).toBeUndefined();
    expect(segments[1].prepend).toBeUndefined();
  });

  it('跳过隐藏元素自身，也跳过整个隐藏子树', () => {
    const root = mount(
      '<div style="display:none"><p style="display:block">Hidden panel text</p></div>' +
        '<div aria-hidden="true"><p style="display:block">Aria hidden text</p></div>' +
        '<p hidden>Hidden attribute text</p>' +
        '<p style="visibility:hidden">Invisible text</p>' +
        '<p>Visible sentence here</p>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Visible sentence here']);
  });

  it('同一元素只解析一次样式：样式查询次数不超过元素总数', () => {
    const rows = Array.from(
      { length: 8 },
      (_, index) => `<div><h2>Heading number ${index}</h2><p>Body paragraph number ${index}.</p></div>`,
    ).join('');
    const root = mount(rows);

    let elementCount = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode() !== null) elementCount += 1;

    const view = document.defaultView as Window & typeof globalThis;
    const real = view.getComputedStyle.bind(view);
    let lookups = 0;
    const spy = vi.spyOn(view, 'getComputedStyle').mockImplementation((...args) => {
      lookups += 1;
      return real(...args);
    });

    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    spy.mockRestore();

    expect(segments).toHaveLength(16);
    // 采集前每个元素最多问一次；缓存失效会让这个数字掉到元素总数的两倍以上。
    expect(lookups).toBeLessThanOrEqual(elementCount);
    expect(lookups).toBeGreaterThan(0);
  });
});
