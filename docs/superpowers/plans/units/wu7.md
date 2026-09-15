## Task 15: `content/extractor.ts` — 段落识别

**Files:**
- Create: `src/content/extractor.ts`
- Test: `tests/content/extractor.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/content/extractor.test.ts
/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectSegments, isBlockDisplay, pageHasKana } from '../../src/content/extractor';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

/**
 * 参照实现：与被测代码无关，只按 WU7 的拼接规格重写一遍——
 * 「片段内部折叠空白、不 trim；拼接时只有两侧都是词字符、且都不在 CJK 区间才补一个空格」。
 * 不变量用例靠它独立算出期望值，避免拿被测函数去验证被测函数。
 */
const REF_SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'CODE',
  'PRE',
  'KBD',
  'SAMP',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'SVG',
  'CANVAS',
  'IFRAME',
  'VIDEO',
  'AUDIO',
  'HEAD',
  'TITLE',
  'META',
  'LINK',
  'BUTTON',
]);
const REF_WORD = /[\p{L}\p{N}]/u;
const REF_CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

function refJoin(previous: string, next: string): string {
  if (previous === '' || next === '') return previous + next;
  const last = previous[previous.length - 1];
  const first = next[0];
  if (/\s/.test(last) || /\s/.test(first)) return previous + next;
  if (REF_CJK.test(last) || REF_CJK.test(first)) return previous + next;
  if (!REF_WORD.test(last) || !REF_WORD.test(first)) return previous + next;
  return `${previous} ${next}`;
}

/** 参照实现：把一个只含行内内容的元素的文本按规格拼出来。 */
function refTextOf(element: Element): string {
  let out = '';
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out = refJoin(out, (node.nodeValue ?? '').replace(/\s+/g, ' '));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (REF_SKIP_TAGS.has(child.tagName)) return;
    for (const grandChild of Array.from(child.childNodes)) walk(grandChild);
  };
  for (const child of Array.from(element.childNodes)) walk(child);
  return out.replace(/\s+/g, ' ').trim();
}

/** 参照实现里「块级」按标签名判定：与被测代码的 computed display 判定互相独立。 */
const REF_BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIALOG',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HGROUP',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

/**
 * 参照实现：容器里的松散文本运行——以块级子元素为界切分，
 * 每个运行给出「拼好的文本」与「这段文本之后的下一个兄弟节点」（容器末尾是 null）。
 */
function refLooseRuns(container: Element): Array<{ text: string; before: Node | null }> {
  const nodes = Array.from(container.childNodes);
  const runs: Array<{ text: string; before: Node | null }> = [];
  let current: { text: string; before: Node | null } | null = null;

  nodes.forEach((node, index) => {
    if (node.nodeType === Node.ELEMENT_NODE && REF_BLOCK_TAGS.has((node as Element).tagName)) {
      current = null;
      return;
    }
    if (current === null) {
      current = { text: '', before: null };
      runs.push(current);
    }
    if (node.nodeType === Node.TEXT_NODE) {
      current.text = refJoin(current.text, (node.nodeValue ?? '').replace(/\s+/g, ' '));
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      current.text = refJoin(current.text, refTextOf(node as Element));
    }
    current.before = nodes[index + 1] ?? null;
  });

  return runs
    .map((run) => ({ text: run.text.replace(/\s+/g, ' ').trim(), before: run.before }))
    .filter((run) => run.text !== '');
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

  it('抽出文本与页面上写的文本逐字一致：标点与符号旁的空格不能被删掉', () => {
    const cases: Array<[string, string]> = [
      ['<p>The plan — announced today — failed.</p>', 'The plan — announced today — failed.'],
      ['<p>It costs 5 $ per unit today.</p>', 'It costs 5 $ per unit today.'],
      ['<p>Sales rose 50 % in May.</p>', 'Sales rose 50 % in May.'],
      ['<p>Compute a + b first.</p>', 'Compute a + b first.'],
      ['<p>Well ... that happened.</p>', 'Well ... that happened.'],
    ];
    for (const [html, expected] of cases) {
      expect(collectSegments(mount(html), { targetLang: 'zh-Hans' }).map((s) => s.text)).toEqual([expected]);
    }
  });

  it('中文之间不插空格，中英之间也不插', () => {
    const root = mount('<p>東京<b>タワー</b>へ行く</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['東京タワーへ行く']);
  });

  it('透明包裹里有块级后代时下钻进去成段（inline-block）', () => {
    const root = mount(
      '<div><span style="display:inline-block"><h3>Heading here</h3><p>Body text here</p></span></div>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Heading here', 'Body text here']);
  });

  it('透明包裹里有块级后代时下钻进去成段（display:contents）', () => {
    const root = mount(
      '<div><section style="display:contents"><p>One two three</p><p>Four five six</p></section></div>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['One two three', 'Four five six']);
  });

  it('inline-block 里没有块级后代时不算边界，仍并入父段', () => {
    const root = mount('<p>Hello <span style="display:inline-block">world</span></p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Hello world']);
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

  // ---- 页面级假名上下文（修「纯汉字日文被静默跳过」的已知限制）----
  it('pageHasKana 探测：整页含假名/片假名时为 true，纯汉字页为 false', () => {
    expect(pageHasKana(mount('<p>本日はお日柄もよく</p><p>東京タワー</p>'))).toBe(true);
    expect(pageHasKana(mount('<p>東京都港区赤坂</p><p>漢字 123 abc</p>'))).toBe(false);
    expect(pageHasKana(mount('<p>这是一段纯中文内容</p>'))).toBe(false);
    expect(pageHasKana(mount(''))).toBe(false);
  });

  it('pageHasKana:true 时，纯汉字段落不因"疑似已是中文"被跳过', () => {
    const root = mount('<p>日本橋</p><p>日本語です</p>');
    // 默认（无页面上下文）：'日本橋' 无简繁特征、被判定为"已是 zh"→ 跳过。
    expect(collectSegments(root, { targetLang: 'zh-Hans' }).map((s) => s.text)).not.toContain('日本橋');
    // 页面级判定为"有假名"时放行：'日本橋' 很可能只是不用假名的日文。
    expect(collectSegments(root, { targetLang: 'zh-Hans', pageHasKana: true }).map((s) => s.text)).toContain(
      '日本橋',
    );
  });

  it('pageHasKana:false（无假名页）保留旧行为：纯中文段仍整体跳过', () => {
    const root = mount('<p>这是一段中文</p><p>另一段中文内容</p>');
    expect(collectSegments(root, { targetLang: 'zh-Hans', pageHasKana: false })).toEqual([]);
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

  it('混合内容的文本段锚在容器上，落点显式指向容器里的位置', () => {
    const root = mount('<div>Intro sentence here<p>Body paragraph text</p>Outro sentence here</div>');
    const div = document.querySelector('div') as HTMLElement;
    const paragraph = document.querySelector('p') as HTMLElement;
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });

    expect(segments[0].textRun).toBe(true);
    expect(segments[0].element).toBe(div);
    // 容器开头那段：译文插到紧随其后的块级子元素之前，仍留在容器内部。
    expect(segments[0].anchor).toEqual({ kind: 'before', node: paragraph });
    expect(segments[1].textRun).toBeUndefined();
    expect(segments[1].element).toBe(paragraph);
    expect(segments[1].anchor).toEqual({ kind: 'auto' });
    expect(segments[2].textRun).toBe(true);
    expect(segments[2].element).toBe(div);
    // 段尾那段：后面再没有兄弟节点，追加到容器末尾。
    // （旧实现恒取「容器里第一个块级子元素之前」，它的译文会跑到正文段落上面去。）
    expect(segments[2].anchor).toEqual({ kind: 'before', node: null });
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

  it('段落中段的直接文本落点在容器里、它后面那个块级子元素之前', () => {
    const root = mount('<div><p>Block one text</p>stray inline text<p>Block two text</p></div>');
    const div = document.querySelector('div') as HTMLElement;
    const second = document.querySelectorAll('p')[1];
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Block one text', 'stray inline text', 'Block two text']);
    expect(segments[1].textRun).toBe(true);
    // 落点是容器（不再借用后一个块级子元素当锚点），位置显式指向那个兄弟节点。
    expect(segments[1].element).toBe(div);
    expect(segments[1].anchor).toEqual({ kind: 'before', node: second });
  });

  it('就地替换只留给「整块就是这一段文本」的元素', () => {
    const root = mount('<p>Hello <b>bold</b> world</p><p>Plain english text</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    // 带行内标记的段落不能被 textContent 盖掉，标记成 textRun 让渲染器改走双语注入。
    expect(segments[0].textRun).toBe(true);
    // 整元素段落一律走 auto 落点，由渲染器按布局规则决定插到哪。
    expect(segments[0].anchor).toEqual({ kind: 'auto' });
    expect(segments[1].textRun).toBeUndefined();
    expect(segments[1].anchor).toEqual({ kind: 'auto' });
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

  it('display:none 的容器：自己的直接文本与整棵子树都不产出', () => {
    const root = mount('<div style="display:none">Hidden intro text<p>Hidden body text</p></div>');
    expect(collectSegments(root, { targetLang: 'zh-Hans' })).toEqual([]);
  });

  it('aria-hidden="true" 的容器同样一个字符都不产出', () => {
    const root = mount('<div aria-hidden="true">Hidden intro text<p>Hidden body text</p></div>');
    expect(collectSegments(root, { targetLang: 'zh-Hans' })).toEqual([]);
  });

  it('hidden 属性的容器同样一个字符都不产出', () => {
    const root = mount('<div hidden>Hidden intro text<p>Hidden body text</p></div>');
    expect(collectSegments(root, { targetLang: 'zh-Hans' })).toEqual([]);
  });

  it('隐藏的行内子元素不并入父段', () => {
    const root = mount(
      '<p>Visible <span style="display:none">secret draft text</span> text here</p>' +
        '<p>Another <span aria-hidden="true">hidden fragment</span> sentence here</p>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Visible text here', 'Another sentence here']);
  });

  /**
   * 用户**正在写、还没保存**的内容（邮件草稿、笔记、评论框）属于隐私：它确实在网页里可见，
   * 但它是用户的半成品，不是网页的内容。README 的隐私一节承诺过它不会被翻译。
   */
  it('contenteditable 容器里的草稿不产出段落', () => {
    const root = mount(
      '<div contenteditable="true">My private unfinished English draft</div>' +
        '<p>Published paragraph text</p>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Published paragraph text']);
  });

  it('可编辑性会继承给后代：contenteditable 里的块级子元素同样不产出', () => {
    const root = mount(
      '<div contenteditable="true"><p>Draft inside a paragraph</p><p>Another draft line</p></div>' +
        '<p>Published paragraph text</p>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Published paragraph text']);
  });

  it('行内的 contenteditable 草稿不并入父段', () => {
    const root = mount(
      '<p>Visible <span contenteditable="true">private draft</span> text here</p>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Visible text here']);
  });

  it('contenteditable="false" 只是显式关掉可编辑：它的文本照常翻译', () => {
    // 所见即所得编辑器用 false 嵌只读片段，那不是"用户没写完的草稿"，不该被跳过。
    const root = mount(
      '<div contenteditable="false">Read only published text</div>' +
        '<div contenteditable="true"><span contenteditable="false">nested read only text</span></div>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Read only published text']);
  });

  it('重扫时容器里新追加的内容会被采到，已处理的段落不重复产出', () => {
    const root = mount('<div id="feed"><p>First post text</p></div>');
    const feed = document.getElementById('feed') as HTMLElement;
    expect(collectSegments(root, { targetLang: 'zh-Hans' }).map((s) => s.text)).toEqual(['First post text']);

    const added = document.createElement('p');
    added.textContent = 'Second post text';
    feed.append(added);

    // 容器本身没被标记：整棵子树短路过一次，新内容就永远不翻了。
    expect(feed.hasAttribute('data-jy-translated')).toBe(false);
    expect(collectSegments(root, { targetLang: 'zh-Hans' }).map((s) => s.text)).toEqual(['Second post text']);
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

describe('抽出文本的不变量', () => {
  /**
   * 混排结构的集合：破折号、货币、百分号、数学式、省略号、行内标记、标点边界、
   * 中日韩混排、实体、多余空白、符号紧贴字母。每一段都必须逐字等于参照实现的结果。
   */
  const MIXED_BLOCKS = [
    'The plan — announced today — failed.',
    'It costs 5 $ per unit today.',
    'Sales rose 50 % in May.',
    'Compute a + b first.',
    'Well ... that happened.',
    'Hello <b>bold</b>, and <i>italic</i>.',
    '東京<b>タワー</b>へ行く',
    'Home <a href="/pricing"><span>Pricing</span></a> page',
    'Mixed <em>mark</em>up &amp; entities  spaced   out',
    'Prefix<span>suffix</span>5 $<b>+</b>tax',
  ];

  it('每一段的 text 都等于把该段节点的内容按同一套规则独立重算的结果', () => {
    const root = mount(
      `<section class="page">${MIXED_BLOCKS.map((html) => `<p>${html}</p>`).join('\n')}</section>`,
    );
    const blocks = Array.from(document.querySelectorAll('section.page > p'));
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });

    // 每个文本块恰好一段、不多不少、顺序与文档一致，且整元素段落走 auto 落点。
    expect(segments).toHaveLength(blocks.length);
    segments.forEach((segment, index) => {
      expect(segment.element).toBe(blocks[index]);
      expect(segment.anchor.kind).toBe('auto');
      expect(segment.text).toBe(refTextOf(blocks[index]));
    });
  });

  it('每一段松散文本的 text 与落点都等于独立重算的结果', () => {
    const root = mount(
      '<div id="box">' +
        '<p>Block one text</p>' +
        'stray text here<span> tail text</span>' +
        '<p>Block two text</p>' +
        'last words here' +
        '</div>',
    );
    const box = document.getElementById('box') as HTMLElement;
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    const loose = segments.filter((segment) => segment.anchor.kind === 'before');
    const expected = refLooseRuns(box);

    expect(loose.map((segment) => segment.text)).toEqual(expected.map((run) => run.text));
    // 落点必须正好是「这一段文本之后的下一个兄弟节点」，null = 容器末尾。
    expect(
      loose.map((segment) => (segment.anchor.kind === 'before' ? segment.anchor.node : undefined)),
    ).toEqual(expected.map((run) => run.before));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/content/extractor.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/content/extractor.ts
import { containsKana, isTranslatableText, normalizeText, shouldSkip } from '../core/lang';

/** 译文宿主的落点。整元素段落交给渲染器按布局规则决定；松散文本段落必须显式给出位置。 */
export type SegmentAnchor =
  | { kind: 'auto' }
  | { kind: 'before'; node: Node | null }; // null = 追加到 element 末尾

export interface ExtractedSegment {
  id: string;
  text: string;
  order: number;
  /**
   * 段落锚点。整元素段落就是**承载整段文本的元素**；
   * 松散文本段落（见 `textRun`）则是**包裹这些直接文本节点的容器**——
   * 因为文本节点本身没有属性可挂，也没有插入点语义，落点改由 `anchor` 显式给出。
   */
  element: HTMLElement;
  /** 译文宿主的落点；松散文本段落一定是 `before`，见 {@link SegmentAnchor}。 */
  anchor: SegmentAnchor;
  /**
   * 该段只是锚点里的**一部分直接文本**，同容器里还有别的块级子元素（它们的文本各自成段）。
   * 渲染器必须把译文留在锚点**内部**，否则译文与对应原文会被块级子元素隔开。
   */
  textRun?: boolean;
  /**
   * 旧字段，采集端在 Fix 4（显式落点）之后**不再产出**：落点一律由 `anchor` 给出，
   * 这一项只是为了不动对外接口而保留声明（`resolveInsertion` 仍认识它）。
   */
  prepend?: boolean;
}

export interface ExtractorOptions {
  targetLang: string;
  /**
   * 页面级判定：**整页**文本里出现过假名（由 {@link pageHasKana} 在采集前算一次，
   * 调用方负责本轮复用）。true 时本段的"看起来已是目标语言"不再构成跳过理由——
   * 汉字是中日共用的书写系统，有假名的页面上纯汉字段落更可能是日文。
   * 省略/false 时行为与逐段判据完全相同。
   */
  pageHasKana?: boolean;
  shouldSkipText?: (text: string) => boolean;
}

/**
 * 廉价页面级扫描：给定根（通常是 `document.body`）之下是否出现过假名/片假名。
 *
 * 读的是整棵子树的 `textContent`——**整页一次**的量，不是每段一次，调用方必须
 * 缓存本轮结果（`translatePage` 拿它喂采集，增量轮直接沿用，见 index.ts）。
 * 方向上只会多翻不会漏翻：`<script>`/隐藏节点里的假名也算数（宁可保守），
 * 换来的是日文页面不再整片静默没有译文。
 */
export function pageHasKana(root: ParentNode): boolean {
  return containsKana(root.textContent ?? '');
}

/** 这些标签里的内容一律不翻译：代码、表单控件、多媒体与元数据。 */
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'CODE',
  'PRE',
  'KBD',
  'SAMP',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'SVG',
  'CANVAS',
  'IFRAME',
  'VIDEO',
  'AUDIO',
  'HEAD',
  'TITLE',
  'META',
  'LINK',
  'BUTTON',
]);

const BLOCK_DISPLAYS = new Set([
  'block',
  'flow-root',
  'list-item',
  'table',
  'table-row',
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'table-cell',
  'table-caption',
  'flex',
  'grid',
  '-webkit-box',
]);

/** 未知或空 display 一律按行内处理，让最近的块级祖先成为段落边界。 */
export function isBlockDisplay(display: string | undefined): boolean {
  return display !== undefined && BLOCK_DISPLAYS.has(display);
}

/**
 * 透明包裹：自身不生成块级盒（`contents` 连盒都不生成），但里面的块级后代仍然要按块处理。
 * 只看 BLOCK_DISPLAYS 会把这些包裹整体当成行内，于是整棵子树既不成段也不参与拼接，
 * 那片区域永远没有译文，父容器还会被标记成已翻译——静默漏翻。
 */
const TRANSPARENT_DISPLAYS = new Set(['inline-block', 'inline-flex', 'inline-grid', 'contents']);

/** 递归判定的深度上限。DOM 是树、不可能成环，但病态深树不该把调用栈吃掉。 */
const MAX_WRAPPER_DEPTH = 16;

interface ElementStyle {
  display: string;
  visibility: string;
}

/** `styleOf` 的读取口径。渲染器要复用 {@link inlineText}，所以这个形状是导出的。 */
export interface StyleLookup {
  (element: Element): ElementStyle;
}

/**
 * `getComputedStyle` 每次都强制样式解析，而一次采集会对同一元素问好几遍
 * （隐藏判定、块级判定、文本段扫描），10k 元素的页面就是 3 万次。
 * 一次采集内同一元素的结果不会变（这期间我们不插节点、不改样式），缓存起来即可。
 * 跨采集必须丢弃：页面可能在这之间改了样式。
 *
 * 渲染器也用同一条口径（见 {@link inlineText}）："这个元素为这一段贡献了哪些文字"
 * 只能有一份实现，两边各写一套必然随改动漂移。
 */
export function createStyleLookup(): StyleLookup {
  const cache = new WeakMap<Element, ElementStyle>();
  return (element) => {
    const cached = cache.get(element);
    if (cached !== undefined) return cached;
    // 不用宿主全局：元素属于哪个文档就问哪个文档的视图，同源 iframe 里也拿得到它自己的样式。
    const view = element.ownerDocument?.defaultView;
    const style = view?.getComputedStyle(element);
    const entry: ElementStyle = {
      display: style?.display ?? '',
      visibility: style?.visibility ?? '',
    };
    cache.set(element, entry);
    return entry;
  };
}

function isHidden(element: Element, styleOf: StyleLookup): boolean {
  if (element.hasAttribute('hidden')) return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;
  const style = styleOf(element);
  if (style.display === 'none') return true;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  return false;
}

/**
 * 这些元素既不贡献文本，也不下钻。文本段扫描与块级判定共用同一份口径，
 * 免得「这里跳过、那里不跳过」两处规则漂移。
 */
function isSkippedForText(element: Element): boolean {
  return SKIP_TAGS.has(element.tagName) || isEditable(element) || element.closest('[data-jy-root]') !== null;
}

/**
 * 可编辑区域（`contenteditable`）里的文本一律不采集。
 *
 * 用户**正在写、还没保存**的内容——邮件草稿、笔记、评论框——是隐私：它确实"在网页里可见"，
 * 但它是用户的半成品，不是网页的内容，不该被送去外部接口（README 的隐私承诺）。
 *
 * 两层判定：
 * 1. `element.isContentEditable` 是标准做法，浏览器把可编辑性**继承**给后代
 *    （`<div contenteditable="true"><p>草稿</p></div>` 里的 `p` 也是可编辑的）；
 * 2. 宿主没实现该属性时（老引擎、测试环境）退回按最近的 `[contenteditable]` 祖先判定，
 *    显式的 `contenteditable="false"` 会把它自己与子树重新变回不可编辑（所见即所得编辑器
 *    用它嵌只读片段），`inherit` 则继续往上找。
 */
function isEditable(element: Element): boolean {
  if ((element as HTMLElement).isContentEditable === true) return true;
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const value = node.getAttribute('contenteditable');
    if (value === null || value === 'inherit') continue;
    return value !== 'false';
  }
  return false;
}

/**
 * 「什么算一段」的**向上**判据：从给定元素出发，找最近的叶子文本块。
 * 悬停翻译用它，整页翻译（{@link collectSegments}）按同一批底层谓词向下切段——
 * 两处各写一份判据迟早会漂移，所以这些谓词（{@link isBlockBoundary}、{@link inlineText}、
 * {@link isHidden}、{@link isSkippedForText}）只此一份，谁要用谁就 import。
 *
 * 一个元素是"叶子文本块"，当且仅当：
 * 1. 它自己不在被跳过的范围里（`[data-jy-root]` 子树、`SKIP_TAGS`、可编辑区域）——
 *    命中即**直接返回 null**：右键/悬停落在按钮或输入框上不是"段落没找到"，是"这里不该翻译"；
 * 2. 它内部没有块级边界子元素（有就是容器，块级子元素各自成段，见 collectSegments 的注释）；
 * 3. 它的可见文本可翻译（{@link isTranslatableText}，与采集端同一条判据）；
 * 4. 它是"块"——自身是块级边界（{@link isBlockBoundary}），或其父是 body
 *    （采集以 `document.body` 为根，它的直接子元素一律会被 visitBlock，行内也算）。
 *    少了这条，`<p>Hello <b>world</b></p>` 里悬停 `<b>` 会把 `world` 单独当一段，
 *    而采集端认定的是整段 `Hello world`——判据就漂移了。
 *
 * 不满足 2~4 的元素（隐藏元素、容器、行内包裹）继续向上找；到根还没有就返回 null。
 *
 * 已知边界：混合容器（`<div>Intro<p>Body</p></div>` 的 Intro）在采集端是松散文本段，
 * 但它**有**块级子元素，本函数按上面的判据返回 null——指针停在容器留白上时没有可悬停的
 * 整段。这是刻意收紧：宁可少翻一处，也不在悬停路径上重做一遍 textRun 的落点判定。
 */
export function findLeafTextAncestor(element: Element | null): HTMLElement | null {
  const styleOf = createStyleLookup();
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    // 1. 命中即停：这些区域不是"还没找到段落"，是"这里永远不翻译"。
    if (node.closest('[data-jy-root]') !== null) return null;
    if (SKIP_TAGS.has(node.tagName) || isEditable(node)) return null;
    // 隐藏元素本身没有可悬停的字面（display:none 不产生盒），但它的可见祖先照常是段落，
    // 所以不返回、继续向上。（aria-hidden 的可见节点走到下面的正常判定。）
    if (isHidden(node, styleOf)) continue;
    // 2. 含块级边界 → 容器，不是叶子。
    if (hasBlockBoundaryChild(node, styleOf)) continue;
    // 3. 可见文本判据与采集端逐字相同。
    if (!isTranslatableText(inlineText(node, styleOf))) continue;
    // 4. "块"身份判据与 visitBlock 的入口一致。
    const parent = node.parentElement;
    if (parent === null || parent === document.body || isBlockBoundary(node, styleOf, 0)) {
      return node instanceof HTMLElement ? node : null;
    }
  }
  return null;
}

function hasBlockBoundaryChild(element: Element, styleOf: StyleLookup): boolean {
  for (const child of Array.from(element.children)) {
    if (isSkippedForText(child) || child.nodeName === 'BR') continue;
    if (isBlockBoundary(child, styleOf, 0)) return true;
  }
  return false;
}

/**
 * 一个子元素算不算**块级边界**（即：父元素的文本到此为止，这块自己成段）：
 * 1. 它的 computed display 在白名单里；或者
 * 2. 它是透明包裹（inline-block / inline-flex / inline-grid / contents）**并且**内部存在块级后代。
 *
 * 第 2 条是必须的：`<span style="display:inline-block"><h3>标题</h3><p>正文</p></span>`
 * 与 Tailwind 的 `contents` 工具类在真实站点里都很常见。少了它，包裹内部整棵子树
 * 既不成段也不参与拼接，那片区域永远没有译文。
 * 反过来，`<span style="display:inline-block">world</span>` 内部没有块级后代，
 * 就不算边界——它仍然是父段的一部分，`<p>Hello <span …>world</span></p>` 抽成一段。
 */
function isBlockBoundary(element: Element, styleOf: StyleLookup, depth: number): boolean {
  const display = styleOf(element).display;
  if (isBlockDisplay(display)) return true;
  if (!TRANSPARENT_DISPLAYS.has(display)) return false;
  return hasBlockDescendant(element, styleOf, depth);
}

function hasBlockDescendant(
  element: Element,
  styleOf: StyleLookup,
  depth: number,
): boolean {
  if (depth > MAX_WRAPPER_DEPTH) return false;
  for (const child of Array.from(element.children)) {
    if (isSkippedForText(child) || child.nodeName === 'BR') continue;
    if (isBlockBoundary(child, styleOf, depth + 1)) return true;
  }
  return false;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

/**
 * 只有两侧都是「词字符」且都不在 CJK 区间时才补一个空格，其余一律直接拼。
 *
 * 判定必须在**拼接处**做，不能做成对整段文本的全局后处理：全局后处理分不清
 * 「插件自己补的分隔符」与「原文本来就有、或者是唯一一个的空格」，
 * 会把 `5 $` / `50 %` / `a + b` / `Well ...` / `plan — announced` 里的空格一起删掉，
 * 抽出来的文本就不再是页面上写的文本，送翻译、算缓存 key、以后术语表匹配全都跟着偏。
 */
function needsSeparator(previous: string, next: string): boolean {
  if (previous.length === 0 || next.length === 0) return false;
  const last = previous[previous.length - 1];
  const first = next[0];
  if (/\s/.test(last) || /\s/.test(first)) return false;
  // 中日韩之间不加空格；中英之间也不加（宁可贴在一起，也不要凭空多出一个空格）。
  if (CJK_CHAR.test(last) || CJK_CHAR.test(first)) return false;
  // 标点、符号旁边不加空格：`Hello` + `, and italic.` 应该是 `Hello, and italic.`
  if (!WORD_CHAR.test(last) || !WORD_CHAR.test(first)) return false;
  return true;
}

/**
 * 文本片段内部折叠空白，但**不 trim**：片段首尾的空白正是原文的分隔信息，
 * 留给 needsSeparator 判断，段尾统一 normalizeText 时再去掉。
 */
function collapseSpaces(raw: string): string {
  return raw.replace(/\s+/g, ' ');
}

/**
 * 元素**自身和行内后代**的可见文本；块级后代各自成段，这里一概不碰，
 * `<br>` 是硬换行也是段边界，同样不跨。
 * 用文本节点而不是 `innerText`：行为确定、可测，且不依赖布局。
 *
 * 返回空串就是"这个元素没有为本段贡献任何文字"——被跳过的 `<code>` / 可编辑区域、
 * 隐藏元素、块级边界以及插件自己的宿主都是这样。渲染器的「仅译文」模式正是按这条判据
 * 决定哪些节点属于**这一段**（见 `content/renderer.ts` 的 `runNodes`）：多藏一个节点
 * 就可能把兄弟段落连它的译文一起藏掉，所以判据必须与采集端是同一份。
 */
export function inlineText(element: Element, styleOf: StyleLookup): string {
  let result = '';

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const piece = collapseSpaces(node.nodeValue ?? '');
      if (piece === '') return;
      if (needsSeparator(result, piece)) result += ' ';
      result += piece;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (isSkippedForText(child) || isHidden(child, styleOf) || child.nodeName === 'BR') return;
    if (isBlockBoundary(child, styleOf, 0)) return;
    for (const grandChild of Array.from(child.childNodes)) walk(grandChild);
  };

  for (const child of Array.from(element.childNodes)) walk(child);
  // 不 trim：首尾空白留给拼接处判断要不要补分隔符。
  return result;
}

function isSkippable(element: Element): boolean {
  if (SKIP_TAGS.has(element.tagName)) return true;
  // 可编辑区域整棵子树都不采：用户没写完的草稿不上传到外部翻译接口（见 isEditable）。
  if (isEditable(element)) return true;
  if (element.hasAttribute('data-jy-translated')) return true;
  // 插件自己注入的译文宿主，避免二次翻译。
  if (element.closest('[data-jy-root]')) return true;
  return false;
}

/** 同时支持传入 Element（通常是 document.body）与 Document。 */
function rootElements(root: ParentNode): Element[] {
  if (root instanceof Element) return Array.from(root.children);
  return Array.from(root.childNodes).filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE);
}

/**
 * 段落识别的核心规则：一个元素若含有块级边界（见 {@link isBlockBoundary}）就继续下钻，
 * 否则它就是最内层的文本块，整块作为一段。
 * 这样 <p>Hello <b>world</b></p> 是一段，而 <div><p>a</p><p>b</p></div> 是两段。
 *
 * 混合内容是常态而不是特例（CMS 正文、带标签的 <li>、卡片），所以容器自己的直接文本
 * 也必须成段，且按文档顺序与块级子元素交错：
 * `<div>Intro<p>Body</p>Outro</div>` → Intro / Body / Outro 三段。
 * 同一容器的多个直接文本段共享容器锚点（`textRun`），落点由 `anchor` 显式给出。
 *
 * **语义是「扫 root 的孩子」**：传 `document.body` 时 body 自己的直接文本不在遍历范围，
 * 传某个新元素时它**自身**的直接文本也采不到。增量翻译要「只扫新增节点本身」，
 * 用的入口是 {@link collectSegmentsWithin}，别拿本函数凑（见那边注释）。
 *
 * **副作用（调用方必须知道）**：会给成段元素打上 `data-jy-id`，
 * 给**真正产出过段落的最内层文本块**打上 `data-jy-translated`。因此**每次调用都会让上一轮的全部 id 失效**，
 * 调用方不能拿旧 id 去索引新结果，也不能预期 id 跨调用稳定；
 * 这两类标记由渲染器的 `restore()` 统一清除。
 */
export function collectSegments(root: ParentNode, options: ExtractorOptions): ExtractedSegment[] {
  return collectFrom(rootElements(root), options);
}

/**
 * 增量翻译的扫描入口：把 **element 自身**当作一个块，连同它的子树一起采段。
 *
 * 为什么不能复用 `collectSegments(element)`：那个函数的语义是「扫 element 的孩子」，
 * 新增的 `<p>新段落</p>`（它自己就是最内层文本块、没有元素孩子）会被整体漏掉。
 * 除了根语义不同，其余规则——跳过标记、隐藏判定、松散文本段、`data-jy-id` /
 * `data-jy-translated` 副作用——与 {@link collectSegments} 逐字相同（同一个 {@link collectFrom}）。
 *
 * 复杂度 O(这棵子树)：已经成段并标记过的兄弟在被重扫的容器里只付一次属性检查的代价，
 * 这正是增量层「只扫新增节点/混合父容器」敢按节点逐个调用的底气。
 */
export function collectSegmentsWithin(element: Element, options: ExtractorOptions): ExtractedSegment[] {
  return collectFrom([element], options);
}

function collectFrom(roots: Element[], options: ExtractorOptions): ExtractedSegment[] {
  const segments: ExtractedSegment[] = [];
  const styleOf = createStyleLookup();
  const marked = new Set<Element>();

  const markTranslated = (element: Element): void => {
    if (marked.has(element)) return;
    element.setAttribute('data-jy-translated', '1');
    marked.add(element);
  };

  /** 返回是否真的产出了一段：调用方靠它决定要不要把元素标记成「已处理」。 */
  const push = (element: Element, text: string, anchor: SegmentAnchor, textRun: boolean): boolean => {
    if (!isTranslatableText(text)) return false;
    if (options.shouldSkipText?.(text)) return false;
    // 页面级判定为"本页含假名"时，本轮关闭"看起来已是目标语言"的跳过（见 ExtractorOptions）。
    if (shouldSkip(text, options.targetLang, { allowSameScriptSkip: !options.pageHasKana })) return false;

    const id = `jy-${segments.length + 1}-${Math.random().toString(36).slice(2, 8)}`;
    element.setAttribute('data-jy-id', id);
    const segment: ExtractedSegment = {
      id,
      text,
      order: segments.length,
      element: element as HTMLElement,
      anchor,
    };
    if (textRun) segment.textRun = true;
    segments.push(segment);
    return true;
  };

  /**
   * 处理一个元素的直接内容：自己的文本段与块级子元素**按文档顺序交错**处理，
   * 这样 `<div>Intro<p>Body</p>Outro</div>` 出来就是 Intro / Body / Outro 三段。
   * 块级子元素递归交给 visitBlock。
   */
  const visitContent = (
    element: Element,
    hidden: boolean,
    wholeElementEligible: boolean,
    blockBoundaries: ReadonlySet<Element>,
  ): void => {
    interface TextRun {
      /** 这段文本之后的下一个兄弟节点在 `element.childNodes` 里的下标（即本运行的结束位置）。 */
      after: number;
      text: string;
    }
    const runs: TextRun[] = [];
    /** 当前这段文本：{@link appendText} 一次都没跑过时为 undefined。 */
    let run: TextRun | undefined;
    /** 强制下一个文本片段另起一段（`<br>` 这样的硬边界）。 */
    let breakRun = false;
    let hasLineBreak = false;

    /**
     * 这一段文本之后的下一个兄弟节点；走到容器末尾就是 null（追加到末尾）。
     * 跳过插件自己注入的 `[data-jy-root]`：译文宿主不该成为下一段译文的落点参照。
     */
    const anchorNodeAfter = (from: number): Node | null => {
      const nodes = element.childNodes;
      for (let cursor = from; cursor < nodes.length; cursor += 1) {
        const node = nodes[cursor];
        if (node === undefined) continue;
        if (node.nodeType === Node.ELEMENT_NODE && (node as Element).hasAttribute('data-jy-root')) continue;
        return node;
      }
      return null;
    };

    const appendText = (piece: string, after: number): void => {
      if (piece === '') return;
      if (run === undefined || breakRun) {
        // 同一落点的相邻块合成一段（`Hello <b>bold</b> world` 仍是一段）；
        // 落点不同（夹着块级边界）或遇到硬边界就另起一段。
        run = { after, text: '' };
        breakRun = false;
        runs.push(run);
      }
      run.after = after;
      // 分隔符只在拼接处补，而且只在两侧都是词字符时才补。
      run.text = needsSeparator(run.text, piece) ? `${run.text} ${piece}` : `${run.text}${piece}`;
    };

    const emit = (): void => {
      if (hidden) {
        // Fix 3：隐藏子树一个字符都不产出。这里必须兜住**所有** emit 路径，
        // 不能只管段尾那一处——块级边界处的那次 emit 一样会把隐藏容器的直接文本送出去。
        runs.length = 0;
        run = undefined;
        breakRun = false;
        return;
      }
      // 整元素段落：这个元素就是最内层的文本块，而且这一段覆盖了它的全部内容。
      const whole = wholeElementEligible && runs.length === 1 && !hasLineBreak;
      let pushed = false;
      for (const item of runs) {
        // 只折叠空白并去掉段首尾的空格：标记之间该不该有空格，拼接时已经判过了。
        const text = normalizeText(item.text);
        if (text === '') continue;
        if (whole) {
          // 只有「整个元素就是这一段文本」才可以就地替换：多一个块级子元素或 <br> 都不行。
          const replaceable = element.childElementCount === 0;
          pushed = push(element, text, { kind: 'auto' }, !replaceable) || pushed;
        } else {
          // 松散文本段：落点显式给出，否则渲染器只能猜（恒取第一个块级子元素之前），
          // `<div>Intro<p>Body</p>Outro</div>` 的 Outro 译文就会跑到 Body 原文上面去。
          pushed = push(element, text, { kind: 'before', node: anchorNodeAfter(item.after) }, true) || pushed;
        }
      }
      runs.length = 0;
      run = undefined;
      breakRun = false;
      /**
       * Fix 5：只在**真产出过段落**的最内层文本块上标记「已处理」。
       * 遍历过但没产出段落的容器一律不标——标了就会让它的块级子元素在重扫时被整棵短路，
       * 「往容器里追加的新内容」就永远不再翻译（X/Twitter 这类 SPA 的增量翻译会整片失效）。
       */
      if (pushed && wholeElementEligible) markTranslated(element);
    };

    let index = 0;
    for (const child of Array.from(element.childNodes)) {
      index += 1;
      if (child.nodeType === Node.TEXT_NODE) {
        // 折叠空白但不 trim：首尾空白是原文的分隔信息，交给 needsSeparator 判断。
        const text = collapseSpaces(child.nodeValue ?? '');
        if (text === '') continue;
        appendText(text, index);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const childElement = child as Element;
      if (isSkippedForText(childElement)) continue;
      if (childElement.nodeName === 'BR') {
        // 硬换行：不跨段，否则 "1 Main St<br>Springfield" 会被粘成一个非词。
        // `index` 已经越过它，所以上一段的落点就是它本身——译文留在本行末尾。
        hasLineBreak = true;
        breakRun = true;
        run = undefined;
        continue;
      }
      if (blockBoundaries.has(childElement)) {
        // 块级边界（含内部还有块级后代的透明包裹）：先把它前面的文本段落定下来，再递归，保证段序 = 文档序。
        emit();
        if (!hidden) visitBlock(childElement, false);
        run = undefined;
        continue;
      }
      // 隐藏的行内子元素既不并入文本、也不成段：display:none / aria-hidden 里的内容
      // （未发布草稿、折叠面板、A/B 变体）不该被送到用户自己付费的翻译 API。
      if (isHidden(childElement, styleOf)) continue;
      const text = inlineText(childElement, styleOf);
      if (text === '') continue;
      appendText(text, index);
    }

    emit();
  };

  const visitBlock = (element: Element, ancestorHidden: boolean): void => {
    if (isSkippable(element)) return;

    const hidden = ancestorHidden || isHidden(element, styleOf);
    const blocks = Array.from(element.children).filter(
      (child) => !isSkippedForText(child) && isBlockBoundary(child, styleOf, 0),
    );
    const boundaries = new Set(blocks);

    if (blocks.length === 0) {
      // 整块没有任何块级边界 → 这就是最内层的文本块，整块作为一段（块内含 <br> 时按 <br> 切分）。
      if (hidden) return;
      visitContent(element, false, true, boundaries);
      return;
    }

    // 有块级边界：自己的直接文本也要成段，然后逐块下钻。
    // 这个元素本身**不**标记已处理：它的直接文本是松散文本段，标记了会让新追加的子元素在重扫时被整棵短路。
    visitContent(element, hidden, false, boundaries);
  };

  for (const element of roots) visitBlock(element, false);
  return segments;
}
```

- [ ] **Step 4: 在 `collectSegments` 上方补上 `rootElements` 辅助函数**

```ts
/** 同时支持传入 Element（通常是 document.body）与 Document。 */
function rootElements(root: ParentNode): Element[] {
  if (root instanceof Element) return Array.from(root.children);
  return Array.from(root.childNodes).filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE);
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/content/extractor.test.ts`

Expected: PASS。

若某个用例因 jsdom 对 `display` 返回空串而失败（表现为段落被合并成父容器一段），在该元素的标签上通过 `style="display:block"` 显式声明后再断言。

- [ ] **Step 6: 提交**

```bash
git add src/content/extractor.ts tests/content/extractor.test.ts
git commit -m "feat(content): 段落识别与可翻译性过滤"
```

---

## Task 16: `content/renderer.ts` — 译文注入与还原

**Files:**
- Create: `src/content/styles.ts`
- Create: `src/content/renderer.ts`
- Test: `tests/content/renderer.test.ts`

- [ ] **Step 1: 写样式常量**

```ts
// src/content/styles.ts

/**
 * 注入译文宿主的 Shadow DOM。
 * 页面 CSS 进不来，译文样式也出不去，双向隔离。
 */
export const TRANSLATION_CSS = `
  :host { display: block; }
  .jy-body {
    display: block;
    margin: 0.35em 0 0.15em;
    line-height: 1.6;
    font-size: 0.97em;
    color: #2b6cb0;
    border-left: 2px solid rgba(43, 108, 176, 0.35);
    padding-left: 0.6em;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .jy-body.jy-pending { color: #9aa5b1; border-left-color: rgba(154, 165, 177, 0.35); }
  .jy-body.jy-error { color: #b3261e; border-left-color: rgba(179, 38, 30, 0.35); }
  .jy-retry {
    margin-left: 0.5em;
    padding: 0 0.5em;
    font: inherit;
    font-size: 0.85em;
    color: inherit;
    background: transparent;
    border: 1px solid currentColor;
    border-radius: 4px;
    cursor: pointer;
  }
`;

/**
 * 「仅译文」模式的译文样式：**刻意做到样式透明**。
 *
 * 这个模式下译文是**替代**原文的，所以它必须长得和原文一模一样。上面那套区分性样式
 * 在这里每一条都是破坏，而且是实测踩出来的（apple.com 的小按钮）：
 *
 * - 硬编码 `color` 会盖掉元素自己的颜色 —— `.button` 是白字蓝底，译文变成蓝底上的深蓝字，
 *   几乎看不见；
 * - `border-left` + `padding-left` 给按钮凭空加了约 11px 宽（用户报的「变长了」）；
 * - `margin` 与 `line-height: 1.6` 撑高行盒（用户报的「大小变了」）；
 * - `font-size: 0.97em` 让字号与周围文字脱节（用户报的「字体大小变了」）；
 * - `display: block` 把 `<a class="button">` 里的行内文字撑成块，直接换行。
 *
 * 所以这里一律走 `inherit`，并用 `display: inline` 让文字回到原来的行内流里。
 * `white-space` 也必须继承：按钮常写 `nowrap`，我们若强行 `pre-wrap` 就会让它撑成两行。
 *
 * 只有**错误态**保留颜色 —— 那是有意要跳出来的信号，不是排版。
 */
export const TRANSLATION_INLINE_CSS = `
  :host { display: inline; }
  .jy-body {
    display: inline;
    margin: 0;
    padding: 0;
    border: 0;
    font: inherit;
    line-height: inherit;
    color: inherit;
    white-space: inherit;
    overflow-wrap: break-word;
  }
  .jy-body.jy-pending { opacity: 0.55; }
  .jy-body.jy-error { color: #b3261e; }
  .jy-retry {
    margin-left: 0.4em;
    padding: 0 0.4em;
    font: inherit;
    font-size: 0.85em;
    color: inherit;
    background: transparent;
    border: 1px solid currentColor;
    border-radius: 4px;
    cursor: pointer;
  }
`;
```

- [ ] **Step 2: 写失败的测试**

```ts
// tests/content/renderer.test.ts
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
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/content/renderer.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 4: 写实现**

```ts
// src/content/renderer.ts
import type { ExtractedSegment } from './extractor';
import { createStyleLookup, inlineText, isBlockDisplay } from './extractor';
import type { DisplayMode } from '../shared/settings';
import { TRANSLATION_CSS, TRANSLATION_INLINE_CSS } from './styles';

export type { DisplayMode };

export type RenderState = 'pending' | 'done' | 'error';

const HOST_TAG = 'jy-translation';
const PENDING_TEXT = '翻译中…';

/**
 * 仅译文模式下装原文的容器。
 *
 * `style="display:none"` 是**内联**样式：页面 CSS 里一条 `.jy-originals { display:block }`
 * 就能把「只显示译文」破掉，内联样式不依赖页面上有没有我们的样式表，也不给别人改写的机会。
 * `data-jy-root` 让采集端把整棵子树当成插件自己的节点跳过。
 */
const ORIGINALS_TAG = 'span';
const ORIGINALS_ATTR = 'data-jy-originals';

interface InsertionTarget {
  parent: HTMLElement;
  /** 插到 parent 内部（末尾，或 before 指定的子节点之前）；否则插到 parent 里 before 那个位置。 */
  inside: boolean;
  before: Node | null;
}

/** 仅译文模式下被藏起来的一段原文：节点都还在，只是被移进了这个 span。 */
interface HiddenOriginals {
  element: HTMLElement;
  span: HTMLElement;
  /**
   * 整元素段落（`anchor.kind === 'auto'`）：元素里装的就是这一段，全部子节点都在 span 里。
   * 元素被框架整体换掉时可以把原文搬进新元素（松散文本段不行——它的父元素是容器，
   * 里面还有别的段落，整块替换会把兄弟段落删掉）。
   */
  wholeElement: boolean;
}

/** 容器里第一个块级后代（`display:contents` 这类不算块级，继续往里找）。 */
function firstBlockInside(element: Element, styleOf: (element: Element) => string): Element | undefined {
  for (const child of Array.from(element.children)) {
    if (isBlockDisplay(styleOf(child))) return child;
    const nested = firstBlockInside(child, styleOf);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * 决定译文宿主插到哪里。只用于**双语模式** `anchor.kind === 'auto'` 的段落——
 * 松散文本段落带显式落点，由 ensureHost 直接按 `anchor.node` 插入，不走这里。
 *
 * 表格单元格、列表项、以及弹性/网格布局的子元素都必须插到内部——
 * 否则会在 <tr> 里插入非单元格节点破坏表格，或在 flex 行里被挤成一行。
 *
 * `textRun` 的段落必须留在锚点内部：它的锚点是「装着好几块内容的容器」，
 * 插到容器外面会让译文和它对应的那段原文被别的块级子元素隔开。
 * 例外是锚点本身就是紧随其后的那个块级子元素（`prepend`）；采集端在 Fix 4 之后
 * 不再产出 `prepend`（落点由 `anchor` 显式给出），这个分支只为兼容旧调用方保留。
 */
export function resolveInsertion(element: HTMLElement, segment?: ExtractedSegment): InsertionTarget {
  const parent = element.parentElement;
  if (segment?.textRun === true) {
    const isCell = element.tagName === 'TD' || element.tagName === 'TH' || element.tagName === 'LI';
    if (segment.prepend === true && parent !== null && !isCell) {
      return { parent, inside: false, before: element };
    }
    // 锚点是容器本身：留在容器内部，插到下一个块级子元素之前（没有就补在末尾），保证与原文同序。
    const view = element.ownerDocument.defaultView;
    const styleOf = (target: Element): string => view?.getComputedStyle(target).display ?? '';
    const anchor = firstBlockInside(element, styleOf);
    return { parent: element, inside: true, before: anchor?.parentElement === element ? anchor : null };
  }
  if (element.tagName === 'TD' || element.tagName === 'TH' || element.tagName === 'LI') {
    return { parent: element, inside: true, before: null };
  }
  if (parent === null) return { parent: element, inside: true, before: null };
  const view = element.ownerDocument.defaultView;
  const display = view?.getComputedStyle(parent).display;
  if (display === 'flex' || display === 'inline-flex' || display === 'grid' || display === 'inline-grid') {
    return { parent: element, inside: true, before: null };
  }
  return { parent, inside: false, before: element.nextSibling };
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class DomRenderer {
  private readonly hosts = new Map<string, HTMLElement>();
  /**
   * 仅译文模式下被藏起来的原文 → 装载它的 span。
   *
   * 用 `Map` 而不是 `WeakMap`：`restore()` 必须能**遍历**全部条目（双语模式不需要它——
   * 那边的原文一直可见，压根没有要还原的东西）。
   */
  private readonly hiddenOriginals = new Map<string, HiddenOriginals>();

  constructor(
    private readonly document: Document,
    private readonly mode: DisplayMode,
    private readonly onRetry?: (segmentId: string) => void,
  ) {}

  mount(segment: ExtractedSegment, state: RenderState, text?: string): void {
    if (this.mode === 'translated-only') {
      this.mountTranslatedOnly(segment, state, text);
      return;
    }
    this.setContent(this.ensureHost(segment), state, text);
  }

  update(segmentId: string, text: string): void {
    const host = this.hosts.get(segmentId);
    if (!host) return;
    // 重试成功：原文重新藏起来，让位给译文（失败时曾被放回来，见 fail）。
    this.setOriginalsHidden(segmentId, true);
    this.setContent(host, 'done', text);
  }

  /**
   * `canRetry === false` 用于**重试多少次都是同一个结果**的错误（缺 API Key、Key 无效）：
   * 只标注原因、不挂重试按钮。一个 200 段的页面否则会变成 200 个点了也没用的按钮，
   * 而用户真正该做的是去设置页填 Key（规格 §8：不重试，改为页面 toast + 弹窗红点）。
   *
   * 两种模式的失败都落在宿主上，所以**失败一定看得见**：仅译文模式下原文已经藏进
   * `display:none` 的 span，宿主就是这一页上唯一还能写字的地方（旧的就地替换实现在这里
   * 直接 `return`，用户既看不到原文、也看不到失败，还不能重试）。
   */
  fail(segmentId: string, message: string, canRetry = true): void {
    const host = this.hosts.get(segmentId);
    if (!host) return;
    // **失败时把原文放回来。** 仅译文模式下原文本来是藏着的，一旦整页失败（没填 Key、
    // 断网、限流），页面上就只剩一片红字——用户连想读的原文都看不见，得先按 Alt+T 才能读。
    // 那比"遮挡"更糟：遮挡只是多了一倍文字，这个是把内容整个拿走了。
    // 重试成功时 update() 会重新藏起来。
    this.setOriginalsHidden(segmentId, false);
    this.setContent(host, 'error', message, canRetry);
  }

  /** 仅译文模式下原文的显隐。双语模式没有这条记录，调用是空操作。 */
  private setOriginalsHidden(segmentId: string, hidden: boolean): void {
    const record = this.hiddenOriginals.get(segmentId);
    if (record === undefined) return;
    record.span.style.display = hidden ? 'none' : '';
  }

  /**
   * 仅译文模式：把原文**包起来藏掉**，而不是删掉它。
   *
   * 三步（见 `hideOriginals`）：
   * 1. 新建 `<span data-jy-originals data-jy-root style="display:none">`；
   * 2. 把这一段的原文节点**按原相对顺序**搬进去（是搬移不是克隆：还原就是把它们搬回去）；
   * 3. 把 span 与 `<jy-translation>` 译文宿主放进元素内部，宿主在 span 之后。
   *
   * 于是元素里**可见的只有译文**，而原文节点一个都没销毁。为什么是包起来而不是替换掉：
   * - 行内标记（链接、图片、加粗）全留在 DOM 里，还原时不需要重建任何东西；
   * - 对任何元素都成立——表格单元格、列表项、弹性/网格布局的子元素都只需要往元素**内部**
   *   追加，不必像双语模式那样分情况判断该插到兄弟位置还是内部；
   * - 原文一个字符都没丢，所以失败态、还原、切回双语这三种回退都还有东西可用。
   */
  private mountTranslatedOnly(segment: ExtractedSegment, state: RenderState, text?: string): void {
    const existing = this.hosts.get(segment.id);
    if (existing !== undefined) {
      // 重新进入"进行中"（用户点了重试）时把原文重新藏起来。
      this.setOriginalsHidden(segment.id, true);
      this.setContent(existing, state, text);
      return;
    }

    const host = this.createHost(segment.id);
    this.hideOriginals(segment, host);

    // 标记原文已翻译：即使后续被重复采集，extractor 也会跳过它（与双语模式同一条规则）。
    // 松散文本段（`textRun`）的 element 是**容器**，绝不能标记：
    // 整棵子树被短路之后，容器里新追加的内容就再也不会被采集了（见 extractor 的 Fix 5 取舍）。
    if (segment.textRun !== true) segment.element.setAttribute('data-jy-translated', '1');
    this.hosts.set(segment.id, host);
    this.setContent(host, state, text);
  }

  /**
   * 把这一段的原文节点搬进隐藏 span，并把 span 与宿主放进元素里。
   *
   * 两种段落形态的搬法不同，区别在于**这个元素是不是这一段的专属容器**：
   * - 整元素段落（`anchor.kind === 'auto'`）：元素里装的就是这一段，全部子节点都搬走，
   *   span 落在原来第一个子节点的位置（子节点全搬空后就是"元素末尾"）；
   * - 松散文本段（`anchor.kind === 'before'`）：元素是**容器**，里面还有别的块级子元素各自成段
   *   （`<div>Intro<p>Body</p>Outro</div>`），整块搬走会把兄弟段落连同它们自己的译文一起藏掉。
   *   只搬本段真正贡献了文字的那一串节点（见 `runNodes`），span 留在本段原来的位置。
   *
   * 宿主两种形态都放在 span 之后：整元素段落是追加到元素末尾（规格就是这三步），
   * 松散文本段则仍按 `anchor` 给出的落点插入——那正是"紧跟这段原文"的位置。
   */
  private hideOriginals(segment: ExtractedSegment, host: HTMLElement): void {
    const element = segment.element;
    const anchor = segment.anchor;
    const wholeElement = anchor.kind === 'auto';
    const nodes: Node[] = wholeElement ? Array.from(element.childNodes) : this.runNodes(element, anchor.node);

    if (nodes.length > 0) {
      const span = this.createOriginals();
      const first = nodes[0];
      // span 站在第一个原文节点原来的位置上，还原时把子节点搬回"span 之前"就回到原位。
      if (first !== undefined && first.parentNode === element) element.insertBefore(span, first);
      else element.append(span);
      span.append(...nodes);
      this.hiddenOriginals.set(segment.id, { element, span, wholeElement });
    }

    if (wholeElement) element.append(host);
    else this.insertHostAtAnchor(segment, host);
  }

  /**
   * 松散文本段（`anchor.kind === 'before'`）自己那一串原文节点。
   *
   * 从锚点（本段之后的下一个节点）往前收，**只收采集端算进这一段的节点**：判据直接复用
   * 采集端的 `inlineText` —— 它对这个子元素返回空串就说明这个子元素没有为本段贡献任何文字
   * （被跳过的 `<code>` / 可编辑区域、隐藏元素、块级边界都是这样），到它就停。
   *
   * 这条判据同时挡住了最危险的一种错误：**把兄弟段落连它的译文一起藏掉**。凡是成段的元素
   * 都是块级边界（或内部含块级后代的透明包裹），`inlineText` 对它恒为空串。
   * 停早了只是这一小段仍显示原文（还能忍），停晚了就是整块内容凭空消失。
   */
  private runNodes(element: HTMLElement, anchorNode: Node | null): Node[] {
    const nodes: Node[] = Array.from(element.childNodes);
    const end =
      anchorNode !== null && anchorNode.parentNode === element ? nodes.indexOf(anchorNode) : nodes.length;
    if (end <= 0) return [];

    const styleOf = createStyleLookup();
    let start = end;
    while (start > 0) {
      const node = nodes[start - 1];
      if (node === undefined) break;
      if (node.nodeType === Node.TEXT_NODE) {
        start -= 1;
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) break;
      const child = node as Element;
      // `<br>` 是硬换行也是段边界；插件自己的 span/宿主一律不碰。
      if (child.nodeName === 'BR' || child.hasAttribute('data-jy-root')) break;
      if (inlineText(child, styleOf) === '') break;
      start -= 1;
    }
    return nodes.slice(start, end);
  }

  /**
   * 松散文本段的宿主落点：容器内部、`anchor.node` 之前；node 为 null（或已不在容器里）
   * 就追加到末尾。与双语模式 `ensureHost` 里那一段同一条规则。
   */
  private insertHostAtAnchor(segment: ExtractedSegment, host: HTMLElement): void {
    const element = segment.element;
    const node = segment.anchor.kind === 'before' ? segment.anchor.node : null;
    if (node !== null && node.parentNode === element) element.insertBefore(host, node);
    else element.append(host);
  }

  /** 装原文的 span：内联 `display:none`，见 {@link ORIGINALS_ATTR} 的注释。 */
  private createOriginals(): HTMLElement {
    const span = this.document.createElement(ORIGINALS_TAG);
    span.setAttribute(ORIGINALS_ATTR, '');
    span.setAttribute('data-jy-root', '');
    span.style.display = 'none';
    return span;
  }

  private ensureHost(segment: ExtractedSegment): HTMLElement {
    const existing = this.hosts.get(segment.id);
    if (existing) return existing;

    const host = this.createHost(segment.id);
    if (segment.anchor.kind === 'before') {
      // 松散文本段落：落点由采集端显式给出——容器内部、anchor.node 之前；node 为 null 就追加到末尾。
      // 容器里可能同时有好几段松散文本，只有显式落点才能保证译文与原文同序。
      const parent = segment.element;
      const before =
        segment.anchor.node !== null && segment.anchor.node.parentNode === parent ? segment.anchor.node : null;
      if (before !== null) parent.insertBefore(host, before);
      else parent.append(host);
    } else {
      // 整元素段落：按布局规则决定插到元素之后还是元素内部。
      const target = resolveInsertion(segment.element, segment);
      // 锚点必须真的还在算出来的父节点里，否则退回追加，别把节点插丢。
      const anchor = target.before !== null && target.before.parentNode === target.parent ? target.before : null;
      if (anchor !== null) target.parent.insertBefore(host, anchor);
      else target.parent.append(host);
    }

    // 标记原文已翻译：即使后续被重复采集，extractor 也会跳过它。
    // 松散文本段（`textRun`）的 element 是**容器**，绝不能标记：
    // 整棵子树被短路之后，容器里新追加的内容就再也不会被采集了（见 extractor 的 Fix 5 取舍）。
    if (segment.textRun !== true) segment.element.setAttribute('data-jy-translated', '1');
    this.hosts.set(segment.id, host);
    return host;
  }

  private createHost(segmentId: string): HTMLElement {
    const host = this.document.createElement(HOST_TAG);
    host.setAttribute('data-jy-root', '');
    host.setAttribute('data-jy-for', segmentId);

    const shadow = host.attachShadow({ mode: 'open' });
    const style = this.document.createElement('style');
    // 双语模式要"看得出这是译文"，仅译文模式要"看不出这不是原文"——两套诉求相反，
    // 共用一份样式就会互相破坏（详见 styles.ts 里 TRANSLATION_INLINE_CSS 的注释）。
    style.textContent = this.mode === 'translated-only' ? TRANSLATION_INLINE_CSS : TRANSLATION_CSS;
    const body = this.document.createElement('span');
    body.className = 'jy-body';
    shadow.append(style, body);
    return host;
  }

  /** 一律用 textContent 写入，杜绝引擎返回内容被当成 HTML 执行。 */
  private setContent(host: HTMLElement, state: RenderState, text?: string, canRetry = true): void {
    const body = host.shadowRoot?.querySelector('.jy-body');
    if (!body) return;

    body.textContent = '';
    body.className = 'jy-body';
    if (state === 'pending') {
      body.classList.add('jy-pending');
      body.textContent = PENDING_TEXT;
      return;
    }
    if (state === 'error') {
      body.classList.add('jy-error');
      body.textContent = text ?? '翻译失败';
      if (!canRetry) return;
      /**
       * 真正的空格文本节点，而不是只靠 CSS 的 `margin-left`：
       * 实测「接口限流，请稍后重试」+ 按钮「重试」在文本层面连成"重试重试"——
       * 复制走的就是这串文本、读屏逐字念出来、按钮被禁用样式压掉间距时直接在页面上
       * 贴成一团。两套译文样式（双语/仅译文）共用这条路径，所以补一次两边都好。
       * 不可重试的分支在上面就 return 了，不挂按钮也就不会多出这个空格。
       */
      body.append(this.document.createTextNode(' '));
      const button = this.document.createElement('button');
      button.className = 'jy-retry';
      button.type = 'button';
      button.textContent = '重试';
      button.addEventListener('click', () => {
        // 回调当场从宿主属性读 id，而不是捕获创建时的闭包变量：
        // 同一个宿主反复失败时，「重试的是哪一段」永远以当前 DOM 为准。
        const current = host.getAttribute('data-jy-for');
        if (current) this.onRetry?.(current);
      });
      body.append(button);
      return;
    }
    body.textContent = text ?? '';
  }

  /**
   * 还原：**逐字节**回到翻译前的样子。
   *
   * 双语模式只要把宿主摘掉就算完；仅译文模式还要把藏起来的原文搬回原位——
   * 搬回去的是**同一批节点**（不是重建的副本），所以行内标记、属性、文本节点边界
   * 全都原样回来，`outerHTML` 与翻译前逐字节相同。
   */
  restore(): void {
    for (const host of this.hosts.values()) host.remove();
    this.hosts.clear();

    for (const { element, span, wholeElement } of this.hiddenOriginals.values()) {
      // 页面在翻译之后重建过节点时，缓存的引用指向的是脱离文档的孤儿：
      // 往孤儿里写原文等于什么也没还原，活着的节点会一直显示译文。
      const live = this.resolveLive(element) ?? element;
      // span 还挂在这个元素里（含"元素被整体移出文档"——那时它的父节点仍然是它）
      // 就直接拆；元素被框架**换掉**时按兜底那一条处理。
      const target = span.parentNode === live ? span : live.querySelector(`[${ORIGINALS_ATTR}]`);
      if (target instanceof HTMLElement) {
        this.unwrapOriginals(target);
      } else if (wholeElement && live !== element && span.childNodes.length > 0) {
        // 元素被框架整体换掉了：原文并没有丢——它就在 span 里。整元素段落的 span 装的就是
        // 这个元素的全部内容，所以可以整块搬进活着的那一个（与双语模式把快照写回活节点等价）。
        // 松散文本段不能这么干：它的父元素是容器，整块替换会把兄弟段落删掉。那种情况下
        // 只能清掉标记（原文留在已脱离文档的 span 里，不再可恢复）。
        live.replaceChildren(...Array.from(span.childNodes));
        span.remove();
      }
      element.removeAttribute('data-jy-translated');
      if (live !== element) live.removeAttribute('data-jy-translated');
    }
    this.hiddenOriginals.clear();

    // 剩下的标记全部清掉：插件没留下的痕迹才算还原干净。
    // 这一步也负责把「框架重建过、带着旧标记的新节点」解锁，否则那些节点会被永久跳过。
    for (const element of Array.from(this.document.querySelectorAll('[data-jy-id], [data-jy-translated]'))) {
      element.removeAttribute('data-jy-id');
      element.removeAttribute('data-jy-translated');
    }
  }

  /** 把隐藏 span 的子节点按原顺序搬回它原来的位置（span 之前），然后删掉 span。 */
  private unwrapOriginals(span: HTMLElement): void {
    const parent = span.parentNode;
    if (parent === null) return;
    for (const node of Array.from(span.childNodes)) parent.insertBefore(node, span);
    span.remove();
  }

  /**
   * 页面在翻译之后重建过节点时，缓存的引用指向的是脱离文档的孤儿：
   * 往孤儿里写原文等于什么也没还原，活着的节点会一直显示译文。
   * 所以先确认节点还在文档里，不在就按 data-jy-id / data-jy-for 重新找。
   */
  private resolveLive(element: HTMLElement): HTMLElement | undefined {
    if (element.isConnected) return element;
    for (const attribute of ['data-jy-id', 'data-jy-for']) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      const found = this.document.querySelector(`[${attribute}="${escapeAttributeValue(value)}"]`);
      if (found instanceof HTMLElement) return found;
    }
    return undefined;
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/content/renderer.test.ts`

Expected: PASS，全部用例通过。

- [ ] **Step 6: 提交**

```bash
git add src/content/styles.ts src/content/renderer.ts tests/content/renderer.test.ts
git commit -m "feat(content): 译文注入渲染器与还原"
```

---
