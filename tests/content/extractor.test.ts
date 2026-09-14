/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { collectSegments, isBlockDisplay, isHidden, resolveText } from '../../src/content/extractor';

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

describe('isHidden', () => {
  it('display:none 视为隐藏', () => {
    const root = mount('<p id="t" style="display:none">Hello world</p>');
    expect(isHidden(root.querySelector('#t') as Element)).toBe(true);
  });

  it('visibility:hidden 视为隐藏', () => {
    const root = mount('<p id="t" style="visibility:hidden">Hello world</p>');
    expect(isHidden(root.querySelector('#t') as Element)).toBe(true);
  });

  it('hidden 属性视为隐藏', () => {
    const root = mount('<p id="t" hidden>Hello world</p>');
    expect(isHidden(root.querySelector('#t') as Element)).toBe(true);
  });

  it('正常段落不算隐藏', () => {
    const root = mount('<p id="t">Hello world</p>');
    expect(isHidden(root.querySelector('#t') as Element)).toBe(false);
  });
});

describe('resolveText', () => {
  it('折叠空白', () => {
    const root = mount('<p id="t">  Hello\n   world  </p>');
    expect(resolveText(root.querySelector('#t') as Element)).toBe('Hello world');
  });
});

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
});
