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
