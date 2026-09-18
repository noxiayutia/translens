/**
 * @vitest-environment jsdom
 *
 * 采集端静默漏翻的复现与钉死（2026-09，digitalocean mega-menu 卡片事故）。
 *
 * 根因形状：一个 `display:inline` 的载体（`<a>`，整张卡片包在链接里）之下全是块级元素。
 * 旧判据先看载体自己的 display——纯 `inline` 不在四条透明包裹豁免名单里，直接判"不是块级边界"；
 * 而 `inlineText()` 的语义又是"块级后代各自成段、这里一概不碰"→ 对这种载体恒返回空串
 * → `if (text === '') continue;` → **整棵子树既不成段也不参与拼接，静默消失**。
 *
 * 主修判据：不看"这个元素自己的 display 是什么"，看"这个元素里有没有需要独立成段的块级内容"——
 * 对一切非块级 display 都做一次 {@link hasBlockDescendant} 探查（`display:none` 短路例外，
 * 隐藏子树由 isHidden 那道闸统一处理，不该为它遍历一棵可能很大的树）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  carriesVisibleText,
  collectSegments,
  createStyleLookup,
  findLeafTextAncestor,
  inlineText,
  isBlockBoundary,
  MAX_WRAPPER_DEPTH,
} from '../../src/content/extractor';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

/** 真实测得的 digitalocean 祖先链（逐层 isBlockBoundary 实测：`a` 以上全是块级边界，`a` 是 inline）。 */
const DO_NAV_CARD =
  '<div class="Layout"><div class="HeaderStyles"><header><div class="HeaderContainer"><nav>' +
  '<div class="NavContainer"><ul class="NavList"><li class="NavItem">' +
  '<div class="Dropdown"><div class="DropdownContainer"><div class="DropdownContent">' +
  '<div class="Gridstyles"><div class="GridItemstyles">' +
  '<a class="CardLink" href="/products/droplets">' +
  '<div class="Cardstyles__StyledCard"><div class="CardContentContainer"><div class="CardContent">' +
  '<h3 class="Typographystyles">Droplets</h3>' +
  '<p class="Typographystyles">Quickly spin up a single Droplet on our fastest cloud VMs.</p>' +
  '</div></div></div></a>' +
  '</div></div></div></div></li></ul></div></nav></div></header></div></div>';

const TITLE = 'Droplets';
const BODY = 'Quickly spin up a single Droplet on our fastest cloud VMs.';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('复现：inline 载体包着块级内容必须下钻（digitalocean mega-menu 卡片）', () => {
  it('整条实测祖先链：修复前 0 段（静默丢弃），修复后 h3 与 p 各成一段', () => {
    const root = mount(DO_NAV_CARD);
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    // 卡片里的两段文字必须各自成段——这是事故的直接复现断言。
    expect(segments.map((s) => s.text)).toEqual([TITLE, BODY]);
  });

  it('成段的是卡片内部的 h3 与 p 本身，而不是链接或任何容器', () => {
    mount(DO_NAV_CARD);
    const h3 = document.querySelector('h3') as HTMLElement;
    const p = document.querySelector('p') as HTMLElement;
    const link = document.querySelector('a.CardLink') as HTMLElement;
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });

    expect(segments.map((s) => s.element)).toEqual([h3, p]);
    // 整元素段落：落点是 auto（渲染器按布局规则决定）。
    expect(segments.every((s) => s.anchor.kind === 'auto')).toBe(true);
    // 承载段落的 h3/p 拿到 id 与"已处理"标记；`<a>` 与中间容器一个都不许有
    //（容器被标成已处理会短路整棵子树的未来重扫，见 extractor Fix 5）。
    expect(h3.hasAttribute('data-jy-id')).toBe(true);
    expect(p.hasAttribute('data-jy-id')).toBe(true);
    expect(h3.getAttribute('data-jy-translated')).toBe('1');
    expect(p.getAttribute('data-jy-translated')).toBe('1');
    expect(link.hasAttribute('data-jy-translated')).toBe(false);
    expect(link.hasAttribute('data-jy-id')).toBe(false);
  });

  it('卡片链上每一级 inline 载体单独成立时也一样下钻（span/font/自定义元素/显式 inline 包 div>p）', () => {
    const cases: Array<[string, string, string]> = [
      ['span', '<span class="w">', '</span>'],
      ['font', '<font class="w">', '</font>'],
      ['自定义元素', '<my-card class="w">', '</my-card>'],
      ['显式 inline 的 div', '<div class="w" style="display:inline">', '</div>'],
    ];
    for (const [label, open, close] of cases) {
      document.body.innerHTML = '';
      const root = mount(
        `<div class="outer">${open}<div class="inner"><p>${label} paragraph text</p></div>${close}</div>`,
      );
      const segments = collectSegments(root, { targetLang: 'zh-Hans' });
      expect(segments.map((s) => s.text), label).toEqual([`${label} paragraph text`]);
      expect((document.querySelector('p') as Element).hasAttribute('data-jy-id'), label).toBe(true);
    }
  });
});

describe('反向用例：防过度修复（纯行内内容绝不被切碎）', () => {
  it('<p>Hello <b>world</b></p> 仍是一段', () => {
    const root = mount('<p>Hello <b>world</b></p>');
    expect(collectSegments(root, { targetLang: 'zh-Hans' }).map((s) => s.text)).toEqual(['Hello world']);
  });

  it('<p>Hello <span style="display:inline">inline</span> world</p> 仍是一段', () => {
    const root = mount('<p>Hello <span style="display:inline">inline</span> world</p>');
    expect(collectSegments(root, { targetLang: 'zh-Hans' }).map((s) => s.text)).toEqual(['Hello inline world']);
  });

  it('inline 元素只含行内后代时不得被当成边界：深链式 span 嵌套仍是一段', () => {
    const deep = (() => {
      let html = 'innermost tail';
      for (let i = 0; i < 12; i += 1) html = `<span>prefix-${i} ${html}</span>`;
      return html;
    })();
    const root = mount(`<p>${deep}</p>`);
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toContain('innermost tail');
    expect(segments[0]?.text).toContain('prefix-11');
  });

  it('<a> 里只有行内文本（导航链接常态）仍并入父段，不单独成段', () => {
    const root = mount('<nav><a><span>Home</span></a><a><span>Pricing</span></a></nav>');
    expect(collectSegments(root, { targetLang: 'zh-Hans' }).map((s) => s.text)).toEqual(['Home Pricing']);
  });
});

describe('display:none 短路：不为隐藏子树做任何递归', () => {
  it('inline 包 display:none 的块级子元素：不成段（端到端 0 段）', () => {
    const root = mount(
      '<div><a style="display:inline"><div style="display:none"><h3>Hidden heading</h3><p>Hidden body</p></div></a></div>',
    );
    expect(collectSegments(root, { targetLang: 'zh-Hans' })).toEqual([]);
  });

  it('isBlockBoundary 对 display:none 直接返回 false，且不进入隐藏子树（styleOf 调用次数钉死）', () => {
    document.body.innerHTML =
      '<a id="w" style="display:inline"><div id="hidden" style="display:none">' +
      '<div><p>Deep hidden text one here</p><p>Deep hidden text two here</p></div>' +
      '<div><span><b>More hidden inline</b></span></div>' +
      '</div></a>';
    const wrapper = document.getElementById('w') as HTMLElement;
    const hidden = document.getElementById('hidden') as HTMLElement;
    const spy = vi.fn(createStyleLookup());
    expect(isBlockBoundary(wrapper, spy, 0)).toBe(false);
    // 修复后必然多问的只有一层：载体自己 + 每个**直接子元素**的 display。
    // hidden 子树里更深的一切（上面还有 6 个元素）一个都不许被问到——
    // 这正是 `display:none` 短路要保住的东西：隐藏子树整体不可见，由 isHidden 那道闸处理。
    const queried = new Set(spy.mock.calls.map(([el]) => el as Element));
    expect(queried.has(wrapper)).toBe(true);
    expect(queried.has(hidden)).toBe(true);
    for (const deep of Array.from(hidden.querySelectorAll('*'))) {
      expect(queried.has(deep), `隐藏子树里的 ${deep.tagName} 不该被样式查询`).toBe(false);
    }
    // 且总调用数不超过「1（载体） + 直接子元素数」——多问一次就说明短路没生效。
    expect(spy).toHaveBeenCalledTimes(1 + wrapper.children.length);
  });
});

describe('深度上限的实测（MAX_WRAPPER_DEPTH 现在决定漏不漏）', () => {
  /** 构造 visited 容器下 `a` → N 层 inline `<span style="display:inline">` → div>p 的链。 */
  function inlineChain(n: number, label: string): string {
    let inner = `<div class="card"><p>${label}</p></div>`;
    for (let i = 0; i < n; i += 1) inner = `<span class="w${i}" style="display:inline">${inner}</span>`;
    return `<div class="host"><a class="wrap" href="#">${inner}</a></div>`;
  }

  it(`恰好 ${MAX_WRAPPER_DEPTH} 层 inline 包裹：块级后代仍在探查半径内，照常采到`, () => {
    const root = mount(inlineChain(MAX_WRAPPER_DEPTH, 'Deep card text within limit'));
    expect(collectSegments(root, { targetLang: 'zh-Hans' }).map((s) => s.text)).toEqual([
      'Deep card text within limit',
    ]);
  });

  it(`${MAX_WRAPPER_DEPTH + 1} 层：探查被深度上限截断，整棵子树仍会漏（已知限制，README 有记载；诊断闸门负责点名）`, () => {
    const root = mount(inlineChain(MAX_WRAPPER_DEPTH + 1, 'Beyond limit card text'));
    const texts = collectSegments(root, { targetLang: 'zh-Hans' }).map((s) => s.text);
    // 断言的是**现状**（超限即漏），不是愿望：这条是"已知限制"的活文档。
    // 若有人把上限调大，这条会红——那时该同步更新 README 与本文件的注释，而不是删断言。
    expect(texts).toEqual([]);
  });

  it(`任务书要求的实测形状：a 与 div.Card 之间垫 20 层 inline 包裹 → 仍采不到（0 段）`, () => {
    const root = mount(inlineChain(20, 'Twenty deep card text'));
    expect(collectSegments(root, { targetLang: 'zh-Hans' })).toEqual([]);
  });
});

/**
 * 共用判据的连锁影响（采集端之外每一处都要有测试钉住"变化是期望的"）：
 * {@link inlineText} / {@link carriesVisibleText} / {@link findLeafTextAncestor} 与渲染器、
 * 观察者都 import 这同一份 {@link isBlockBoundary}。
 */
describe('连锁：inlineText 的归属判定随边界判据一起收紧', () => {
  it('行内文本与块级后代混排时按文档顺序拆段：Intro / Link / 卡片文本 / tail 四段', () => {
    const root = mount(
      '<div>Intro <a style="display:inline">Link <div class="card">card body text</div></a> tail</div>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Intro', 'Link', 'card body text', 'tail']);
    // 「Link」这段归 `<a>` 自己（松散文本段，落点在 a 内、卡片之前）——
    // 修复前它是被并进父段 "Intro Link tail" 里、卡片整段丢失的。
    const linkRun = segments[1];
    expect(linkRun?.text).toBe('Link');
    expect(linkRun?.textRun).toBe(true);
    expect(linkRun?.anchor.kind).toBe('before');
    expect(linkRun?.anchor.kind === 'before' ? linkRun.anchor.node : null).toBe(document.querySelector('.card'));
    // 「Intro」与「tail」归外层 div。
    expect(segments[0]?.element).toBe(document.querySelector('div'));
    expect(segments[3]?.element).toBe(document.querySelector('div'));
  });

  it('inlineText 对「inline 包块级」的载体：只报它自己的直接文字，块级后代一个字都不并入', () => {
    document.body.innerHTML = '<a id="w"><h3>Heading deep inside</h3><p>Body deep inside</p></a>';
    const a = document.getElementById('w') as HTMLElement;
    expect(inlineText(a, createStyleLookup())).toBe('');
    document.body.innerHTML = '<a id="w">Link text <div><p>Body deep inside</p></div></a>';
    const mixed = document.getElementById('w') as HTMLElement;
    expect(inlineText(mixed, createStyleLookup())).toBe('Link text ');
  });
});

describe('连锁：carriesVisibleText（渲染器「仅译文」归属判据）', () => {
  it('inline 载体只含块级后代 → 不承载文字（两版一致：本就不该搬进隐藏容器）', () => {
    document.body.innerHTML = '<a id="w"><div><h3>Heading here</h3></div></a>';
    const a = document.getElementById('w') as HTMLElement;
    expect(carriesVisibleText(a, createStyleLookup())).toBe(false);
  });

  it('inline 载体带直接文字 + 块级子元素 → 修复后不再承载文字', () => {
    // 旧判据下 isBlockBoundary(a)=false 且 inlineText(a)="Link " 非空 → carries=true，
    // 渲染器会把**整棵子树（连同块级段落）**搬进隐藏原文容器——块级段落的译文还挂在里面，
    // 会被一起藏掉。新判据把 a 认定为边界 → carries=false → a 留在原位，各段落自己管自己。
    document.body.innerHTML = '<a id="w">Link <div class="card">Card body text</div></a>';
    const a = document.getElementById('w') as HTMLElement;
    expect(isBlockBoundary(a, createStyleLookup(), 0)).toBe(true);
    expect(carriesVisibleText(a, createStyleLookup())).toBe(false);
  });

  it('纯行内载体照旧承载文字（反向防过度修复）', () => {
    document.body.innerHTML = '<p>Hi <b id="w">there friend</b></p>';
    const b = document.getElementById('w') as HTMLElement;
    expect(carriesVisibleText(b, createStyleLookup())).toBe(true);
  });
});

describe('连锁：findLeafTextAncestor（悬停与诊断的向上判据）', () => {
  it('卡片链上悬停落在 p / h3 时依旧返回段落自己（与修复前一致：悬停本来就能翻）', () => {
    mount(DO_NAV_CARD);
    const p = document.querySelector('p') as HTMLElement;
    const h3 = document.querySelector('h3') as HTMLElement;
    expect(findLeafTextAncestor(p)).toBe(p);
    expect(findLeafTextAncestor(h3)).toBe(h3);
    // 落在 p 里的行内后代上，也归到 p。
    p.innerHTML = '<span id="s">Quickly spin up</span>';
    expect(findLeafTextAncestor(document.getElementById('s') as HTMLElement)).toBe(p);
  });

  it('悬停落在 inline 载体（容器身份）上：继续向上找不到叶子就返回 null，不把整卡当一段', () => {
    mount(DO_NAV_CARD);
    const link = document.querySelector('a.CardLink') as HTMLElement;
    // 载体内部有块级边界 → 它是容器；它的**全部**后代都是段落，悬停落在留白上没有整段可指。
    expect(isBlockBoundary(link, createStyleLookup(), 0)).toBe(true);
    expect(findLeafTextAncestor(link)).toBeNull();
  });
});

