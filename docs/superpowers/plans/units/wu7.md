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
import { collectSegments, isBlockDisplay } from '../../src/content/extractor';

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
import { isTranslatableText, normalizeText, shouldSkip } from '../core/lang';

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
  shouldSkipText?: (text: string) => boolean;
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

/**
 * `getComputedStyle` 每次都强制样式解析，而一次采集会对同一元素问好几遍
 * （隐藏判定、块级判定、文本段扫描），10k 元素的页面就是 3 万次。
 * 一次采集内同一元素的结果不会变（这期间我们不插节点、不改样式），缓存起来即可。
 * 跨采集必须丢弃：页面可能在这之间改了样式。
 */
function createStyleLookup(): (element: Element) => ElementStyle {
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

function isHidden(element: Element, styleOf: (element: Element) => ElementStyle): boolean {
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
  return SKIP_TAGS.has(element.tagName) || element.closest('[data-jy-root]') !== null;
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
function isBlockBoundary(element: Element, styleOf: (element: Element) => ElementStyle, depth: number): boolean {
  const display = styleOf(element).display;
  if (isBlockDisplay(display)) return true;
  if (!TRANSPARENT_DISPLAYS.has(display)) return false;
  return hasBlockDescendant(element, styleOf, depth);
}

function hasBlockDescendant(
  element: Element,
  styleOf: (element: Element) => ElementStyle,
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
 */
function inlineText(element: Element, styleOf: (element: Element) => ElementStyle): string {
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
 * **副作用（调用方必须知道）**：会给成段元素打上 `data-jy-id`，
 * 给**真正产出过段落的最内层文本块**打上 `data-jy-translated`。因此**每次调用都会让上一轮的全部 id 失效**，
 * 调用方不能拿旧 id 去索引新结果，也不能预期 id 跨调用稳定；
 * 这两类标记由渲染器的 `restore()` 统一清除。
 */
export function collectSegments(root: ParentNode, options: ExtractorOptions): ExtractedSegment[] {
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
    if (shouldSkip(text, options.targetLang)) return false;

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

  for (const element of rootElements(root)) visitBlock(element, false);
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
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/content/renderer.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 4: 写实现**

```ts
// src/content/renderer.ts
import type { ExtractedSegment } from './extractor';
import { isBlockDisplay } from './extractor';
import { TRANSLATION_CSS } from './styles';

export type DisplayMode = 'bilingual' | 'replace';
export type RenderState = 'pending' | 'done' | 'error';

const HOST_TAG = 'jy-translation';
const PENDING_TEXT = '翻译中…';

interface InsertionTarget {
  parent: HTMLElement;
  /** 插到 parent 内部（末尾，或 before 指定的子节点之前）；否则插到 parent 里 before 那个位置。 */
  inside: boolean;
  before: Node | null;
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
 * 决定译文宿主插到哪里。只用于 `anchor.kind === 'auto'` 的段落——
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

/** 还原时要写回的元素内容。直接克隆子节点，不用 innerHTML 快照——省掉一次 HTML 解析。 */
function snapshotChildren(element: Element): Node[] {
  return Array.from(element.childNodes, (node) => node.cloneNode(true));
}

function swapChildren(element: Element, nodes: Node[]): void {
  // 克隆节点可以直接搬进文档，不必再克隆一次。
  element.replaceChildren(...nodes);
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class DomRenderer {
  private readonly hosts = new Map<string, HTMLElement>();
  /** 替换模式下被改写的元素 → 改写前的子节点快照。用 Map 是因为 restore() 要遍历它。 */
  private readonly originals = new Map<string, { element: HTMLElement; nodes: Node[] }>();

  constructor(
    private readonly document: Document,
    private readonly mode: DisplayMode,
    private readonly onRetry?: (segmentId: string) => void,
  ) {}

  mount(segment: ExtractedSegment, state: RenderState, text?: string): void {
    if (this.mode === 'replace' && this.isReplaceable(segment)) {
      if (!this.originals.has(segment.id)) {
        this.originals.set(segment.id, { element: segment.element, nodes: snapshotChildren(segment.element) });
      }
      if (state === 'done' && text !== undefined) segment.element.textContent = text;
      return;
    }
    // 双语模式，以及替换模式下「就地替换会毁掉行内标记」的段落：
    // 后者仍然要翻出来，所以退回双语注入。替换模式本身是有意破坏性的，
    // 但把 <a> 这类行内元素永久毁掉属于用户无法撤销的破坏，不做。
    this.setContent(this.ensureHost(segment), state, text);
  }

  update(segmentId: string, text: string): void {
    const host = this.hosts.get(segmentId);
    if (host) {
      this.setContent(host, 'done', text);
      return;
    }
    const original = this.originals.get(segmentId);
    if (original) {
      original.element.textContent = text;
      original.element.setAttribute('data-jy-translated', '1');
    }
  }

  fail(segmentId: string, message: string): void {
    const host = this.hosts.get(segmentId);
    // 替换模式下失败必须保持原文，否则用户会看到一片空白。
    if (!host) return;
    this.setContent(host, 'error', message);
  }

  /**
   * 只有在「节点内容就是这一整段文本」时才允许就地替换。
   * 有任何元素子节点（行内链接、`<br>`）都不能用 textContent 盖掉：那会永久销毁宿主的行内标记。
   */
  private isReplaceable(segment: ExtractedSegment): boolean {
    return segment.textRun !== true && segment.element.childElementCount === 0;
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
    style.textContent = TRANSLATION_CSS;
    const body = this.document.createElement('span');
    body.className = 'jy-body';
    shadow.append(style, body);
    return host;
  }

  /** 一律用 textContent 写入，杜绝引擎返回内容被当成 HTML 执行。 */
  private setContent(host: HTMLElement, state: RenderState, text?: string): void {
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

  restore(): void {
    for (const host of this.hosts.values()) host.remove();
    this.hosts.clear();

    for (const { element, nodes } of this.originals.values()) {
      const live = this.resolveLive(element);
      if (live !== undefined) swapChildren(live, nodes);
      element.removeAttribute('data-jy-translated');
    }
    this.originals.clear();

    // 剩下的标记全部清掉：插件没留下的痕迹才算还原干净。
    // 这一步也负责把「框架重建过、带着旧标记的新节点」解锁，否则那些节点会被永久跳过。
    for (const element of Array.from(this.document.querySelectorAll('[data-jy-id], [data-jy-translated]'))) {
      element.removeAttribute('data-jy-id');
      element.removeAttribute('data-jy-translated');
    }
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
