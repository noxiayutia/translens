/**
 * @vitest-environment jsdom
 *
 * 「点一下告诉我这段为什么没被翻译」的分析内核（`src/content/diagnose.ts`）。
 *
 * 这个文件测的是**分析**本身：给一个元素，返回从它到 `body` 每一级的结论、
 * 以及取最靠近点击处那一级得到的主结论。分析不碰 DOM（不写标记、不插节点）、
 * 不发请求、不弹提示——那三件事分别由渲染器、请求链路与 index 的接线负责
 * （接线在 `diagnose-wiring.test.ts`）。
 *
 * 判据必须来自 extractor：所以下面**刻意用真实标记**（`data-jy-translated`、
 * `data-jy-root`）与真实样式（`display:none`、`contenteditable`）构造现场，
 * 而不是打桩那些谓词——打桩就等于在测试里再写一份判据，两处一起漂。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  collectSegments,
  createStyleLookup,
  findLeafTextAncestor,
  inlineText,
  MAX_WRAPPER_DEPTH,
} from '../../src/content/extractor';
import { FULL_RESCAN_MAX_ELEMENTS, type IncrementalStats } from '../../src/content/observer';
import { diagnoseElement, formatClipboard, formatToast, type Diagnosis } from '../../src/content/diagnose';

/** 分析上下文：目标语言一定是中文（下面所有现场都是英文文本）。 */
const OPTIONS = { targetLang: 'zh-Hans', pageHasKana: false };

function analyze(target: EventTarget, options: typeof OPTIONS | null = OPTIONS): Diagnosis {
  // 观察者读数在接线层才注入，分析内核不依赖它（这里的 null 就是"没有观察者信息"）。
  return diagnoseElement(target, { scanOptions: () => options, stats: () => null });
}

/** 一份观察者读数的现场（M1 的三分要靠它区分：页面到底翻译了没有、这一段进没进过账本）。 */
function stats(overrides: Partial<IncrementalStats> = {}): IncrementalStats {
  return {
    enabled: true,
    processedSegments: 2,
    lastIncrementalAt: undefined,
    lastIncrementalSegments: undefined,
    lastInteractionRescanAt: undefined,
    lastInteractionRescan: undefined,
    lastInteractionRescanSegments: undefined,
    elementCount: 12,
    pendingInteractionRescan: false,
    ...overrides,
  };
}

/** 带观察者读数的分析（纯分析场景没有观察者，这里的读数就是接线层会喂进来的那些）。 */
function analyzeWithStats(target: EventTarget, reading: IncrementalStats | null): Diagnosis {
  return diagnoseElement(target, { scanOptions: () => OPTIONS, stats: () => reading });
}

/**
 * 造一个与渲染器同形的译文宿主：`[data-jy-root]` + `data-jy-for` + shadow 里的 `.jy-body`。
 * 现场一律用真实标记构造（不用桩替掉谓词），免得在测试里再写一份判据。
 */
function makeHost(segmentId: string, text: string, pending = false): HTMLElement {
  const host = document.createElement('jy-translation');
  host.setAttribute('data-jy-root', '');
  host.setAttribute('data-jy-for', segmentId);
  const body = document.createElement('span');
  body.className = pending ? 'jy-body jy-pending' : 'jy-body';
  body.textContent = pending ? '翻译中…' : text;
  host.attachShadow({ mode: 'open' }).append(body);
  return host;
}

/** 一次诊断的**结论指向**（用于"自身 vs 祖先"那组矩阵断言）。 */
function culpritOf(diagnosis: Diagnosis): string {
  const element = diagnosis.finding.reportedElement as HTMLElement;
  return element.id === '' ? element.tagName.toLowerCase() : `#${element.id}`;
}

/** 主结论的原因码。 */
function reasonOf(target: EventTarget, options: typeof OPTIONS | null = OPTIONS): string {
  return analyze(target, options).finding.reason;
}

beforeEach(() => {
  document.body.innerHTML = '';
  for (const host of Array.from(document.querySelectorAll('[data-jy-root]'))) host.remove();
});

describe('诊断分析：逐级给结论，主结论取最靠近点击处的那一级', () => {
  it('真的采集过、但宿主不存在：结论是「已采集未翻译」，并指向这一段真正的归属元素', () => {
    document.body.innerHTML = '<div id="card"><span id="s">Intro text</span><p id="body">Body text</p></div>';
    // 真的跑一遍采集（**非** readOnly）：它给成段元素写下 `data-jy-id`，
    // 那就是"这一段进过采集"的现场证据。松散文本段的归属元素是**容器**
    // （见 extractor 的 SegmentAnchor），所以证据落在 #card 上。
    const segments = collectSegments(document.body, OPTIONS);
    expect(segments[0]?.element).toBe(document.getElementById('card'));
    const span = document.getElementById('s') as HTMLElement;

    const diagnosis = analyze(span);

    expect(diagnosis.element).toBe(span);
    // 采过 + 没渲染 = 请求/渲染环节的问题——这正是这一条结论要指出的。
    expect(diagnosis.finding.reason).toBe('collected');
    expect(diagnosis.finding.detail).toContain('宿主不存在');
    // 主结论就是**最靠近点击处**那一级的结论（下面每一级的链路都能看到）。
    expect(diagnosis.levels[0]?.element).toBe(span);
    expect(diagnosis.levels[0]?.reason).toBe('collected');
    // 点击处自己就有结论：链路到此为止，不需要再往上找（这正是"最靠近点击处"的含义）。
    expect(diagnosis.levels).toHaveLength(1);
  });

  it('行内包裹与它的段落给同一个结论（判据同源，不会一个说能翻、一个说不能）', () => {
    // `<span><b>world</b></span>`：`inlineText` 会把行内后代的文字算给最近的容器，
    // 所以包裹与段落**都是同一条结论**——这正是"判据只此一份"该有的样子。
    // （真想造一个"自己没话说"的级要吊起 extractor 的内部判据，那属于给测试造特例。）
    document.body.innerHTML = '<p id="p">Hello <span id="s"><b>world</b></span></p>';

    const wrapper = analyze(document.getElementById('s') as HTMLElement);
    const paragraph = analyze(document.getElementById('p') as HTMLElement);

    // 页面已翻译（有采集快照）、但这一段还没进过账本：两条路给**同一句话**。
    // 注意这里**不能**说"已采集"：没跑过采集的段落说自己采过，就是把排查引向不存在的 bug（M1）。
    expect(wrapper.finding.reason).toBe('not-in-ledger');
    expect(paragraph.finding.reason).toBe(wrapper.finding.reason);
    expect(wrapper.finding.detail).toBe(paragraph.finding.detail);
    // 链路至少含点击处自己那一级。
    expect(wrapper.levels[0]?.element).toBe(document.getElementById('s'));

    // 真的采集过一遍之后：两条路依旧一致（这一次是「已翻译」——段落被标记，采集端会整段跳过）。
    collectSegments(document.body, OPTIONS);
    expect(reasonOf(document.getElementById('s') as HTMLElement)).toBe('already-translated');
    expect(reasonOf(document.getElementById('p') as HTMLElement)).toBe('already-translated');
  });

  it('已经被整段翻译过的段落：结论是「已翻译」', () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';
    const paragraph = document.getElementById('p') as HTMLElement;
    paragraph.setAttribute('data-jy-translated', '1');

    expect(reasonOf(paragraph)).toBe('already-translated');
  });

  it('已翻译段落里的行内后代：同样报「已翻译」，而不是「下钻」', () => {
    document.body.innerHTML = '<p id="p">Hello <b id="b">world</b></p>';
    const bold = document.getElementById('b') as HTMLElement;
    // 采集端标记的是承载整段的**段落元素**，不是每个行内子元素。
    (document.getElementById('p') as HTMLElement).setAttribute('data-jy-translated', '1');

    const diagnosis = analyze(bold);

    expect(diagnosis.finding.reason).toBe('already-translated');
    expect(diagnosis.element).toBe(bold);
  });

  it('已采集但宿主里还是「翻译中…」：结论区分于「已翻译」与「未采集」', () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';
    const paragraph = document.getElementById('p') as HTMLElement;
    // 真实形态（见 renderer 的 createHost / setContent）：宿主带 shadow DOM，
    // 里面那个 `.jy-body` 就是承载译文/状态的节点。
    paragraph.setAttribute('data-jy-translated', '1');
    paragraph.setAttribute('data-jy-id', 'jy-1-abc');
    const host = document.createElement('jy-translation');
    host.setAttribute('data-jy-root', '');
    host.setAttribute('data-jy-for', 'jy-1-abc');
    const shadow = host.attachShadow({ mode: 'open' });
    const body = document.createElement('span');
    body.className = 'jy-body jy-pending';
    shadow.append(body);
    paragraph.append(host);

    const diagnosis = analyze(paragraph);

    // "还在翻译中"比"已翻译"准确：用户此刻看到的正是「翻译中…」，两处不能自相矛盾。
    expect(diagnosis.finding.reason).toBe('pending');
    expect(diagnosis.finding.detail).toContain('翻译中');
  });

  it('插件自己的浮层（[data-jy-root] 子树）：结论是「插件自己的浮层，本就不该翻」', () => {
    document.body.innerHTML = '<p>Ready to deploy</p>';
    const host = document.createElement('jy-translation');
    host.setAttribute('data-jy-root', '');
    host.textContent = '翻译中…';
    document.body.append(host);
    const inside = document.createElement('span');
    inside.textContent = '翻译中…';
    host.append(inside);

    const diagnosis = analyze(inside);

    expect(diagnosis.finding.reason).toBe('own-overlay');
    // 报的是**浮层本身**，即最近的那个 [data-jy-root] 祖先。
    expect(diagnosis.finding.reportedElement).toBe(host);
  });

  it('可编辑区域：结论是「可编辑区域，有意跳过」', () => {
    document.body.innerHTML = '<div id="editor" contenteditable="true"><p id="draft">Draft text here</p></div>';
    const draft = document.getElementById('draft') as HTMLElement;

    expect(reasonOf(draft)).toBe('editable');
  });

  it('contenteditable="false" 的只读片段不算可编辑区域（判据与采集端同一份）', () => {
    document.body.innerHTML =
      '<div contenteditable="true"><p id="readonly" contenteditable="false">Read only text</p></div>';
    const readonly = document.getElementById('readonly') as HTMLElement;

    // 不是"可编辑"这一支；它确实会成段，只是还没进过采集（页面已翻译、这一段不在账本里）。
    expect(reasonOf(readonly)).toBe('not-in-ledger');
  });

  it('元素自身 display:none：点名是**自身**隐藏', () => {
    document.body.innerHTML = '<p id="p" style="display:none">Hidden by itself</p>';
    const paragraph = document.getElementById('p') as HTMLElement;

    const diagnosis = analyze(paragraph);

    expect(diagnosis.finding.reason).toBe('hidden');
    expect(diagnosis.finding.hiddenBy).toBe('self');
    expect(diagnosis.finding.detail).toContain('自身');
  });

  it('隐藏来自某个祖先：点名那个祖先，并写清是哪种隐藏', () => {
    document.body.innerHTML = '<div id="panel" style="display:none"><p id="p">Inside the closed panel</p></div>';
    const paragraph = document.getElementById('p') as HTMLElement;

    const diagnosis = analyze(paragraph);

    expect(diagnosis.finding.reason).toBe('hidden');
    expect(diagnosis.finding.hiddenBy).toBe('ancestor');
    // 结论指向那个**真正把它藏起来的祖先**（点击处本身仍是那个段落）。
    const culprit = diagnosis.finding.reportedElement as HTMLElement;
    expect(culprit.id).toBe('panel');
    expect(diagnosis.element).toBe(paragraph);
    // 这一条正是"真隐藏"与"展开后没重新扫"的分界线：必须说得出是哪个祖先、哪种隐藏。
    expect(diagnosis.finding.detail).toContain('panel');
    expect(diagnosis.finding.hiddenKind).toBe('display:none');
  });

  it('visibility:hidden 也算不可见（与 extractor 的 isHidden 同一口径）', () => {
    document.body.innerHTML = '<p id="p" style="visibility:hidden">Invisible text</p>';

    expect(reasonOf(document.getElementById('p') as HTMLElement)).toBe('hidden');
  });

  it('aria-hidden="true" 也算不可见', () => {
    document.body.innerHTML = '<div aria-hidden="true"><p id="p">Decorated text</p></div>';

    expect(reasonOf(document.getElementById('p') as HTMLElement)).toBe('hidden');
  });

  it('文本本身不合格（少于两个字母）：结论是噪声闸，不是"没采集"', () => {
    document.body.innerHTML = '<p id="p">42</p>';

    const diagnosis = analyze(document.getElementById('p') as HTMLElement);

    expect(diagnosis.finding.reason).toBe('noise');
    expect(diagnosis.finding.detail).toContain('42');
  });

  it('判定为「已是目标语言」而跳过：报告检测到的字符集', () => {
    document.body.innerHTML = '<p id="p">这已经是一段中文</p>';

    const diagnosis = analyze(document.getElementById('p') as HTMLElement);

    expect(diagnosis.finding.reason).toBe('target-language');
    expect(diagnosis.finding.detail).toContain('zh');
    expect(diagnosis.finding.detail).toContain('zh-Hans');
  });

  it('同一段中文不会在页面含假名时被当成"已是目标语言"而跳过（页面级上下文生效）', () => {
    document.body.innerHTML = '<p id="p">这已经是一段中文</p>';

    // 页面级判定的唯一作用点就是这个开关（见 core/lang.ts 的 shouldSkip）。
    // 关掉"已是目标语言"这条跳过之后，它就是一整段会被采集的文本（还没进过账本，见 M1）。
    expect(reasonOf(document.getElementById('p') as HTMLElement, { ...OPTIONS, pageHasKana: true })).toBe(
      'not-in-ledger',
    );
  });

  it('会下钻的容器（含块级子元素）：结论提示点更里面的元素', () => {
    document.body.innerHTML = '<div id="card">Intro text<p id="body">Body text</p></div>';
    const card = document.getElementById('card') as HTMLElement;

    const diagnosis = analyze(card);

    expect(diagnosis.finding.reason).toBe('drills-down');
    expect(diagnosis.finding.detail).toContain('子元素');
    // 子元素自己才是那一段：主结论确实取了最近一级，而不是容器的。
    expect(reasonOf(document.getElementById('body') as HTMLElement)).toBe('not-in-ledger');
  });

  it('会下钻的容器即使已被采集过（悬浮文本段）也提示点里面：那里才是独立的一段', () => {
    document.body.innerHTML = '<div id="card">Intro text<p id="body">Body text</p></div>';
    const card = document.getElementById('card') as HTMLElement;
    // 松散文本段的容器不打 data-jy-translated（打了会短路掉新追加的内容，见 extractor 的 Fix 5）。
    card.setAttribute('data-jy-id', 'jy-1-abc');

    expect(reasonOf(card)).toBe('drills-down');
  });

  it('被跳过的标签（表单控件 / code / svg）单独成一类原因，不混进"可编辑区域"', () => {
    document.body.innerHTML = '<div id="box"><button id="btn">Submit now</button><code id="code">const a = 1</code></div>';

    // 按钮**不在**跳过名单里（digitalocean 的事故就是它）：照常算可采集
    // （这里还没跑过采集，所以是"不在账本里"这一支；跑过之后才谈得上"采了没渲染"）。
    expect(reasonOf(document.getElementById('btn') as HTMLElement)).toBe('not-in-ledger');
    expect(reasonOf(document.getElementById('code') as HTMLElement)).toBe('skip-tag');
  });

  it('极端输入 document.body：不抛错，并给出可读结论', () => {
    document.body.innerHTML = '<p>Ready to deploy</p>';

    const diagnosis = analyze(document.body);

    // body 自己就是采集根：它承载的直接文本不进采集范围，采的是它的子元素。
    expect(diagnosis.finding.reason).toBe('drills-down');
    expect(diagnosis.finding.text).not.toBe('');
    expect(diagnosis.levels.length).toBeGreaterThan(0);
  });

  it('极端输入 documentElement：不抛错，给出可读结论', () => {
    document.body.innerHTML = '<p>Ready to deploy</p>';

    const diagnosis = analyze(document.documentElement);

    expect(diagnosis.finding.reason).toBe('drills-down');
    expect(diagnosis.finding.text).not.toBe('');
  });

  it('极端输入裸文本节点：先归到它的父元素再分析', () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';
    const text = (document.getElementById('p') as HTMLElement).firstChild as Text;

    const diagnosis = analyze(text);

    expect(diagnosis.element).toBe(document.getElementById('p'));
    expect(diagnosis.finding.reason).toBe('not-in-ledger');
  });

  it('极端输入一张空白页：结论可读、不抛错', () => {
    const diagnosis = analyze(document.body);

    // 一个字的可见文本都没有：如实说"这里没有可见文本"，而不是硬报一个"下钻"。
    expect(diagnosis.finding.reason).toBe('empty');
    expect(diagnosis.finding.text).not.toBe('');
  });
});

describe('诊断分析：不改变页面（分析是纯读）', () => {
  it('分析一个未采集的段落：不写任何 data-jy-* 标记、不插节点', () => {
    document.body.innerHTML = '<div id="card">Intro text<p id="body">Body text</p></div>';
    const before = document.body.outerHTML;
    const paragraph = document.getElementById('body') as HTMLElement;
    const textBefore = inlineText(paragraph, createStyleLookup());

    analyze(paragraph);
    analyze(document.getElementById('card') as HTMLElement);

    expect(document.body.outerHTML).toBe(before);
    expect(paragraph.hasAttribute('data-jy-translated')).toBe(false);
    expect(paragraph.hasAttribute('data-jy-id')).toBe(false);
    // 顺带钉住"分析没有把文本读歪"：判据用的是 extractor 的 inlineText。
    expect(inlineText(paragraph, createStyleLookup())).toBe(textBefore);
  });

  it('页面还没翻译（没有采集选项）时也能跑：结论说"页面还没开始翻译"，不说"已采集"', () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';

    const diagnosis = analyze(document.getElementById('p') as HTMLElement, null);

    // 没有快照就没有目标语言可判：不因"看起来已是目标语言"而报跳过。
    expect(diagnosis.finding.reason).toBe('page-idle');
    expect(diagnosis.finding.text).toContain('还没开始翻译');
    // 用户要的下一步就在这里（触发方式不该只写在文档里）。
    expect(diagnosis.finding.text).toContain('Alt+T');
    // 一句"已采集"会把排查引向不存在的请求/渲染 bug——这是 M1 要修的原文案。
    expect(diagnosis.finding.text).not.toContain('已采集');
  });
});

describe('诊断输出：页面内两行 / 剪贴板全文', () => {
  it('页面内提示两行：第一行是结论，第二行是观察者状态（截图里带得上的上下文）', () => {
    document.body.innerHTML = '<div id="card"><span id="s">Intro text</span><p id="body">Body text</p></div>';
    // 真的采过一遍（非 readOnly）：只有这样，"采了没渲染"这条结论才站得住（见 M1）。
    collectSegments(document.body, OPTIONS);
    const diagnosis = analyze(document.getElementById('s') as HTMLElement);

    const toast = formatToast(diagnosis);
    const lines = toast.split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('宿主不存在');
    // 分析内核不持有观察者（纯分析场景没有观察者信息），如实报"未知"而不是编一个。
    expect(lines[1]).toContain('观察者：未知');
  });

  it('剪贴板全文：结论 + 元素路径 + 采集上下文 + 观察者状态，四行可直接粘回来', () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';
    const diagnosis = analyze(document.getElementById('p') as HTMLElement);

    const text = formatClipboard(diagnosis);
    const lines = text.split('\n');

    expect(lines).toHaveLength(4);
    expect(text).toContain('【浸译诊断】');
    expect(text).toContain('p#p');
    // 采集上下文带上目标语言：目标语言判错是"这一段为什么没翻"的一个真实原因。
    expect(text).toContain('zh-Hans');
  });

  it('未翻译的页面上剪贴板全文如实写"采集上下文：无"', () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';

    const text = formatClipboard(analyze(document.getElementById('p') as HTMLElement, null));

    expect(text).toContain('采集上下文：无');
  });

  it('观察者读数如实进第二行：启用状态、段数、元素数一个都不少', () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';
    const diagnosis = diagnoseElement(document.getElementById('p') as HTMLElement, {
      scanOptions: () => OPTIONS,
      stats: () => ({
        enabled: true,
        processedSegments: 7,
        lastIncrementalAt: 1_000,
        lastIncrementalSegments: 3,
        lastInteractionRescanAt: 2_000,
        lastInteractionRescan: 'skipped-too-large',
        lastInteractionRescanSegments: 0,
        elementCount: 12345,
        pendingInteractionRescan: false,
      }),
    });

    const text = formatClipboard(diagnosis, 3_000);

    expect(text).toContain('观察者：已启用（已处理 7 段）');
    expect(text).toContain('最近增量：2s 前／3 段');
    // 被元素数上限跳过的那一次必须如实写出来：那是"点了没反应"最可能的解释。
    expect(text).toContain('被元素数上限跳过');
    expect(text).toContain('12345 元素');
  });
});

describe('F1：祖先被跳过（code/pre/svg…）——整棵子树在采集端根本不存在', () => {
  it('<pre><span> 的后代：点名祖先 pre，且与真实采集结果一致', () => {
    document.body.innerHTML = '<pre id="pre"><span id="s">const answer = 1</span></pre>';
    const span = document.getElementById('s') as HTMLElement;

    // 现场事实先钉住：真实采集**一段都不产出**（核验者的复现就是这句 expect 的实测结果）。
    expect(collectSegments(document.body, OPTIONS)).toEqual([]);

    const diagnosis = analyze(span);

    expect(diagnosis.finding.reason).toBe('skip-tag');
    expect(diagnosis.finding.detail).toContain('祖先');
    expect(diagnosis.finding.detail).toContain('pre');
    // 结论指向**真正让整棵子树不存在**的那个祖先（不是被点的 span）。
    expect(diagnosis.finding.reportedElement).toBe(document.getElementById('pre'));
    // 一句"已采集/宿主不存在"会把排查引向不存在的请求/渲染 bug——这正是 F1 要修的错。
    expect(diagnosis.finding.text).not.toContain('已采集');
    expect(diagnosis.finding.text).not.toContain('宿主不存在');
  });

  it('<svg><text> 的后代：同样点名祖先 svg（tagName 小写的内联 svg 也要认出来）', () => {
    document.body.innerHTML = '<svg id="chart"><text id="t">Chart label</text></svg>';
    const label = document.getElementById('t') as HTMLElement;

    expect(collectSegments(document.body, OPTIONS)).toEqual([]);

    const diagnosis = analyze(label);

    expect(diagnosis.finding.reason).toBe('skip-tag');
    expect(diagnosis.finding.detail).toContain('祖先');
    expect(diagnosis.finding.detail).toContain('svg');
    expect(diagnosis.finding.reportedElement).toBe(document.getElementById('chart'));
    expect(diagnosis.finding.text).not.toContain('宿主不存在');
  });

  it('间隔着几层的祖先（pre > div > span）也要认出来，且点名的是最近的那一层', () => {
    document.body.innerHTML = '<pre id="pre"><div id="inner"><span id="s">const answer = 1</span></div></pre>';
    const span = document.getElementById('s') as HTMLElement;

    expect(collectSegments(document.body, OPTIONS)).toEqual([]);

    const diagnosis = analyze(span);

    expect(diagnosis.finding.reason).toBe('skip-tag');
    expect(diagnosis.finding.reportedElement).toBe(document.getElementById('pre'));
  });

  it('四种"祖先这类标签"的形态逐例与 collectSegments 对照：都产不出段落，都不说"已采集"', () => {
    const shapes = [
      ['<pre><span id="x">Alpha beta</span></pre>', 'pre'],
      ['<code><span id="x">Alpha beta</span></code>', 'code'],
      ['<svg><text id="x">Alpha beta</text></svg>', 'svg'],
      ['<div><textarea id="x">Alpha beta</textarea></div>', 'textarea'],
    ];

    for (const [html, tag] of shapes) {
      document.body.innerHTML = html ?? '';
      // 真实采集：这段内容永远不在段落列表里。
      expect(collectSegments(document.body, OPTIONS)).toEqual([]);

      const diagnosis = analyze(document.getElementById('x') as HTMLElement);

      expect(diagnosis.finding.reason).toBe('skip-tag');
      expect(diagnosis.finding.detail).toContain(tag);
      expect(diagnosis.finding.text).not.toContain('已采集');
    }
  });

  it('点击处自己是跳过标签时照旧报"自身"（既有语义不变）', () => {
    document.body.innerHTML = '<div id="box"><code id="code">const a = 1</code></div>';

    const diagnosis = analyze(document.getElementById('code') as HTMLElement);

    expect(diagnosis.finding.reason).toBe('skip-tag');
    expect(diagnosis.finding.detail).toContain('自身');
    expect(diagnosis.finding.reportedElement).toBe(document.getElementById('code'));
  });

  it('extractor 的向上判据对"祖先被跳过"给出的正是 null（诊断复用的就是这条证据）', () => {
    document.body.innerHTML = '<pre id="pre"><span id="s">const answer = 1</span></pre>';

    // 这一段根本不存在：`findLeafTextAncestor` 撞上被跳过的祖先就返回 null。
    expect(findLeafTextAncestor(document.getElementById('s'))).toBeNull();

    document.body.innerHTML = '<p id="p">Hello <b id="b">world</b></p>';

    // 反过来，它在"整元素段落里的行内后代"上正好返回那个段落——归属元素判定的第一半。
    expect(findLeafTextAncestor(document.getElementById('b'))).toBe(document.getElementById('p'));
  });
});

describe('F2：松散文本段——译文就在页面上，不能说"宿主不存在"', () => {
  it('双语模式现场：宿主挂在容器里，点容器里的行内 span 就是「已翻译」', () => {
    document.body.innerHTML = '<div id="card"><span id="s">Intro text</span><p id="body">Body text</p></div>';
    const card = document.getElementById('card') as HTMLElement;
    const segments = collectSegments(document.body, OPTIONS);

    // 钉住"归属元素是容器"这个前提：松散文本段的宿主正是插在容器里的（见 renderer）。
    expect(segments[0]?.element).toBe(card);
    expect(segments[0]?.textRun).toBe(true);
    card.insertBefore(makeHost('jy-1-abc', '介绍文字'), document.getElementById('body'));

    const diagnosis = analyze(document.getElementById('s') as HTMLElement);

    expect(diagnosis.finding.reason).toBe('translated');
    expect(diagnosis.finding.text).toContain('已翻译');
    expect(diagnosis.finding.text).not.toContain('宿主不存在');
  });

  it('宿主还停在「翻译中…」时同理：报到归属元素上，结论是"还在翻译中"', () => {
    document.body.innerHTML = '<div id="card"><span id="s">Intro text</span><p id="body">Body text</p></div>';
    const card = document.getElementById('card') as HTMLElement;
    collectSegments(document.body, OPTIONS);
    card.insertBefore(makeHost('jy-1-abc', '', true), document.getElementById('body'));

    const diagnosis = analyze(document.getElementById('s') as HTMLElement);

    expect(diagnosis.finding.reason).toBe('pending');
    expect(diagnosis.finding.detail).toContain('翻译中');
  });

  it('查宿主时不能只看点击处的后代：松散文本段的宿主不在 span 里，而在容器里', () => {
    document.body.innerHTML = '<div id="card"><span id="s">Intro text</span><p id="body">Body text</p></div>';
    const card = document.getElementById('card') as HTMLElement;
    collectSegments(document.body, OPTIONS);
    const host = makeHost('jy-1-abc', '介绍文字');
    card.insertBefore(host, document.getElementById('body'));

    // 前提前钉死：宿主确实**不是**点击处的后代（旧实现就是在这里两头落空）。
    expect(document.getElementById('s')?.querySelector('[data-jy-for]')).toBeNull();
    expect(card.querySelector('[data-jy-for]')).toBe(host);

    expect(analyze(document.getElementById('s') as HTMLElement).finding.reason).toBe('translated');
  });

  it('钉死 findLeafTextAncestor 对松散文本段的行为：返回 null（所以归属元素要另取块根）', () => {
    document.body.innerHTML = '<div id="card"><span id="s">Intro text</span><p id="body">Body text</p></div>';

    // extractor 自己文档里写明的已知边界：混合容器（<div>Intro<p>Body</p></div>）不成段，
    // 所以它回答不了"这段归谁"——诊断必须按块根再判一次，否则就会退回到"点击处为根"的老错。
    expect(findLeafTextAncestor(document.getElementById('s'))).toBeNull();
    expect(findLeafTextAncestor(document.getElementById('card'))).toBeNull();
  });

  it('整元素段落的行内后代：归属元素就是那个段落（两条判据在这一侧一致）', () => {
    document.body.innerHTML = '<p id="p">Hello <b id="b">world</b></p>';
    const paragraph = document.getElementById('p') as HTMLElement;
    const segments = collectSegments(document.body, OPTIONS);
    expect(segments[0]?.element).toBe(paragraph);

    // 双语模式的宿主插在段落之后（兄弟位置），段落自己带 data-jy-translated：
    // 结论由那条更早的判据给出，同样不会说"宿主不存在"。
    const diagnosis = analyze(document.getElementById('b') as HTMLElement);

    expect(diagnosis.finding.reason).toBe('already-translated');
    expect(diagnosis.finding.text).toContain('已翻译');
  });

  it('已知边界（刻意保守）：容器里还留着别的宿主时，不说"宿主不存在"', () => {
    document.body.innerHTML = '<div id="card"><span id="s">Intro text</span><p id="body">Body text</p></div>';
    const card = document.getElementById('card') as HTMLElement;
    collectSegments(document.body, OPTIONS);
    // 只摘掉松散文本段自己的宿主，容器里还留着兄弟段落（p#body）的宿主：
    // 按归属元素查宿主时认不出"这个宿主是不是这一段的"，于是当作有宿主。
    card.append(makeHost('jy-2-xyz', '正文译文'));

    const diagnosis = analyze(document.getElementById('s') as HTMLElement);

    // 宁少报一次"采了没渲染"，也不要把"译文其实在页面上"说成缺失——
    // 「框架把卡片里的节点整个重建」那种宿主全没的现场照常报得出来（见 M1 的 ③）。
    expect(diagnosis.finding.reason).toBe('translated');
    expect(diagnosis.finding.text).not.toContain('宿主不存在');
  });
});

describe('F3：是谁引入的隐藏——自身 vs 祖先 × 四种隐藏方式', () => {
  interface HiddenCase {
    name: string;
    html: string;
    by: 'self' | 'ancestor';
    kind: string;
    /** 引入隐藏的那个元素：自身场景就是被点的元素，祖先场景是那个祖先。 */
    culprit: string;
  }

  const CASES: HiddenCase[] = [
    {
      name: 'display:none 自身',
      html: '<p id="x" style="display:none">Hidden text</p>',
      by: 'self',
      kind: 'display:none',
      culprit: '#x',
    },
    {
      name: 'display:none 祖先',
      html: '<div id="a" style="display:none"><p id="x">Hidden text</p></div>',
      by: 'ancestor',
      kind: 'display:none',
      culprit: '#a',
    },
    {
      name: 'visibility:hidden 自身',
      html: '<p id="x" style="visibility:hidden">Hidden text</p>',
      by: 'self',
      kind: 'visibility:hidden',
      culprit: '#x',
    },
    {
      name: 'visibility:hidden 祖先（继承属性，后代 computed 也都是 hidden）',
      html: '<div id="a" style="visibility:hidden"><p id="x">Hidden text</p></div>',
      by: 'ancestor',
      kind: 'visibility:hidden',
      culprit: '#a',
    },
    {
      name: '[hidden] 自身',
      html: '<p id="x" hidden>Hidden text</p>',
      by: 'self',
      kind: 'hidden',
      culprit: '#x',
    },
    {
      name: '[hidden] 祖先',
      html: '<div id="a" hidden><p id="x">Hidden text</p></div>',
      by: 'ancestor',
      kind: 'hidden',
      culprit: '#a',
    },
    {
      name: 'aria-hidden 自身',
      html: '<p id="x" aria-hidden="true">Hidden text</p>',
      by: 'self',
      kind: 'aria-hidden',
      culprit: '#x',
    },
    {
      name: 'aria-hidden 祖先',
      html: '<div id="a" aria-hidden="true"><p id="x">Hidden text</p></div>',
      by: 'ancestor',
      kind: 'aria-hidden',
      culprit: '#a',
    },
  ];

  for (const item of CASES) {
    it(`${item.name}：报 ${item.by}，引入者是 ${item.culprit}`, () => {
      document.body.innerHTML = item.html;
      const clicked = document.getElementById('x') as HTMLElement;

      const diagnosis = analyze(clicked);

      expect(diagnosis.finding.reason).toBe('hidden');
      expect(diagnosis.finding.hiddenBy).toBe(item.by);
      expect(diagnosis.finding.hiddenKind).toBe(item.kind);
      // "自身 vs 祖先"决定下一步该做什么（真隐藏 vs 展开后没重新扫）：必须指对元素。
      expect(culpritOf(diagnosis)).toBe(item.culprit);
      expect(diagnosis.finding.detail).toContain(item.by === 'self' ? '自身' : '祖先');
      if (item.by === 'ancestor') expect(diagnosis.finding.detail).toContain(item.culprit);
      // 点击处本身仍是那个被点的元素，与"该负责的元素"分开报。
      expect(diagnosis.element).toBe(clicked);
    });
  }

  it('嵌套现场（外层 display:none + 内层 visibility:hidden）：点名真正引入隐藏的那一层', () => {
    document.body.innerHTML =
      '<div id="outer" style="display:none"><div id="inner" style="visibility:hidden"><p id="t">Gone text</p></div></div>';

    const diagnosis = analyze(document.getElementById('t') as HTMLElement);

    expect(diagnosis.finding.reason).toBe('hidden');
    expect(diagnosis.finding.hiddenBy).toBe('ancestor');
    // 引入者 = 祖先链上"自己是隐藏的、父元素不隐藏"的最外层那一个：就是外层 div。
    expect(culpritOf(diagnosis)).toBe('#outer');
    expect(diagnosis.finding.hiddenKind).toBe('display:none');
    expect(diagnosis.finding.detail).toContain('outer');
  });

  it('自身隐藏 + 祖先隐藏：报祖先（真正引入的那一层），不把责任推给被点的元素', () => {
    document.body.innerHTML =
      '<div id="a" style="visibility:hidden"><p id="x" style="visibility:hidden">Hidden text</p></div>';

    const diagnosis = analyze(document.getElementById('x') as HTMLElement);

    expect(diagnosis.finding.hiddenBy).toBe('ancestor');
    expect(culpritOf(diagnosis)).toBe('#a');
  });

  it('同一个判据覆盖 display:none 与 visibility:hidden（不是给 visibility 打的补丁）', () => {
    // 两条现场只有一个属性不同，其余读数必须同形：隐藏方式如实报、引入者都指祖先。
    const shapes = [
      ['<div id="a" style="display:none"><p id="x">Alpha beta</p></div>', 'display:none'],
      ['<div id="a" style="visibility:hidden"><p id="x">Alpha beta</p></div>', 'visibility:hidden'],
    ];

    for (const [html, kind] of shapes) {
      document.body.innerHTML = html ?? '';
      const diagnosis = analyze(document.getElementById('x') as HTMLElement);
      expect(diagnosis.finding.hiddenBy).toBe('ancestor');
      expect(culpritOf(diagnosis)).toBe('#a');
      expect(diagnosis.finding.hiddenKind).toBe(kind);
    }
  });

  it('隐藏加在 <html> 上时也要找得到引入者（不放任它掉进采集环节的结论）', () => {
    document.body.innerHTML = '<p id="x">Alpha beta</p>';
    // 加载态/过渡态里 `<html style="visibility:hidden">` 是真实写法：整条链的 computed
    // 都是 hidden，父元素也全"隐藏"，只有最外层（父元素为 null）的那一个才算引入者。
    document.documentElement.style.visibility = 'hidden';
    try {
      const diagnosis = analyze(document.getElementById('x') as HTMLElement);

      expect(diagnosis.finding.reason).toBe('hidden');
      expect(diagnosis.finding.hiddenBy).toBe('ancestor');
      expect(diagnosis.finding.hiddenKind).toBe('visibility:hidden');
      expect(diagnosis.finding.reportedElement).toBe(document.documentElement);
    } finally {
      document.documentElement.style.visibility = '';
    }
  });
});

describe('M1：三种"没翻译"各自说准（页面没开翻译 / 不在账本 / 真的采了没渲染）', () => {
  it('① 页面还没开始翻译（观察者未启用）：说"页面还没开始翻译"并提示按 Alt+T', () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';

    // 页面级的那个读数就是"观察者启用没启用"（接线层喂进来的 stats）。
    const diagnosis = analyzeWithStats(document.getElementById('p') as HTMLElement, stats({ enabled: false }));

    expect(diagnosis.finding.reason).toBe('page-idle');
    expect(diagnosis.finding.text).toContain('还没开始翻译');
    expect(diagnosis.finding.text).toContain('Alt+T');
    expect(diagnosis.finding.text).not.toContain('已采集');
    expect(diagnosis.finding.text).not.toContain('宿主不存在');
  });

  it('② 页面已翻译、但这一段不在已处理账本里：说"可能是翻译后才出现的"，不说宿主不存在', () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';

    const diagnosis = analyzeWithStats(document.getElementById('p') as HTMLElement, stats());

    expect(diagnosis.finding.reason).toBe('not-in-ledger');
    expect(diagnosis.finding.detail).toContain('翻译后才出现');
    // 这一段还可能落在单轮上限之外：有读数时把话说全。
    expect(diagnosis.finding.detail).toContain('交互重扫');
    expect(diagnosis.finding.text).not.toContain('宿主不存在');
    expect(diagnosis.finding.text).not.toContain('已采集');
  });

  it('② 页面大到整页重扫会被护栏跳过时，补上"落在元素数上限之外"这个读数', () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';

    const diagnosis = analyzeWithStats(
      document.getElementById('p') as HTMLElement,
      // 与 observer 的护栏同一个判据、同一个常量：不在这里另写一份阈值。
      stats({ elementCount: FULL_RESCAN_MAX_ELEMENTS + 1 }),
    );

    expect(diagnosis.finding.reason).toBe('not-in-ledger');
    expect(diagnosis.finding.detail).toContain('上限');
    expect(diagnosis.finding.detail).toContain(String(FULL_RESCAN_MAX_ELEMENTS + 1));
  });

  it('③ 真的采集过但没有宿主：只有这一种才说「已采集未翻译：宿主不存在」', () => {
    document.body.innerHTML = '<div id="card"><span id="s">Intro text</span><p id="body">Body text</p></div>';
    const clicked = document.getElementById('s') as HTMLElement;

    // 对照组：同一个现场、同一份读数，只差"有没有真的采过"。
    const before = analyzeWithStats(clicked, stats());
    expect(before.finding.reason).toBe('not-in-ledger');

    collectSegments(document.body, OPTIONS); // 真的采一遍：容器上留下 data-jy-id
    const after = analyzeWithStats(clicked, stats());

    expect(after.finding.reason).toBe('collected');
    expect(after.finding.detail).toContain('宿主不存在');
    expect(after.finding.text).toContain('已采集未翻译');
  });

  it('三种情况的文案两两不同（诊断说错原因比没有诊断更坏）', () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';
    const clicked = document.getElementById('p') as HTMLElement;
    const idle = analyzeWithStats(clicked, stats({ enabled: false })).finding.text;
    const notLedger = analyzeWithStats(clicked, stats()).finding.text;

    document.body.innerHTML = '<div id="card"><span id="s">Intro text</span><p id="body">Body text</p></div>';
    collectSegments(document.body, OPTIONS);
    const noHost = analyzeWithStats(document.getElementById('s') as HTMLElement, stats()).finding.text;

    expect(new Set([idle, notLedger, noHost]).size).toBe(3);
  });

  it('观测者读数缺失（纯分析场景）时按"页面已翻译"处理：不拿未知冒充未启用', () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';

    // stats 为 null 只说明"没有观察者信息"，不等于"页面没翻译"——
    // 有采集快照（options）时页面就是已翻译状态，结论落在"不在账本里"这一支。
    expect(analyze(document.getElementById('p') as HTMLElement).finding.reason).toBe('not-in-ledger');
  });
});

/**
 * 第 2 项闸门：「从采集根走不走得到这一段」。
 *
 * 旧诊断只问"这一段自己成不成段"（owner 往下），从不检查 owner 往上的下钻通路——
 * 于是对采集端**结构上就到不了**的内容报出"点一下页面或等一次交互重扫"的假希望。
 * 主修（2026-09 inline 载体包块级）完成后，真实可达的断点形态是**超过探查深度上限的
 * 连续非块级包裹链**（styled-components 深链），闸门必须能点名它、并且不与"等一下就好"混淆。
 */
describe('闸门：not-drillable（下钻通路断了，等多久都不会采到）', () => {
  /** `div.host > a.wrap > N 层 display:inline span > div.card > p`（>16 层时探查被上限截断）。 */
  function deepWrapChainHtml(layers: number): string {
    let inner = '<div class="card"><p class="deep">Deeply wrapped card text</p></div>';
    for (let i = 0; i < layers; i += 1) {
      inner = `<span class="w${i}" style="display:inline">${inner}</span>`;
    }
    return `<div class="host"><a class="wrap" href="#" style="display:inline">${inner}</a></div>`;
  }

  it(`${MAX_WRAPPER_DEPTH + 1} 层连续 inline 包裹：结论是 not-drillable，点名断点元素与 display`, () => {
    document.body.innerHTML = deepWrapChainHtml(MAX_WRAPPER_DEPTH + 1);
    const deep = document.querySelector('p.deep') as HTMLElement;
    const link = document.querySelector('a.wrap') as HTMLElement;

    const diagnosis = analyzeWithStats(deep, stats());

    expect(diagnosis.finding.reason).toBe('not-drillable');
    // 点名断在哪一级祖先：采集从根往下第一个不被认成边界的元素——`a`（父容器根本没下钻给它）。
    expect(diagnosis.finding.reportedElement).toBe(link);
    expect(diagnosis.finding.detail).toContain('a.wrap');
    expect(diagnosis.finding.detail).toContain('display:inline');
    expect(diagnosis.finding.detail).toContain(String(MAX_WRAPPER_DEPTH));
  });

  it('文案与「等一次交互重扫」严格区分：not-drillable 不许说"点一下页面/等一下就好"', () => {
    document.body.innerHTML = deepWrapChainHtml(MAX_WRAPPER_DEPTH + 1);
    const text = analyzeWithStats(document.querySelector('p.deep') as HTMLElement, stats()).finding.text;

    expect(text).toContain('需要修代码');
    expect(text).not.toContain('点一下页面');
    expect(text).not.toContain('可能是翻译后才出现的');
  });

  it('对照：修复后的 digitalocean 形状（1 层 inline）通路完好 → 仍是 not-in-ledger，不许误报 not-drillable', () => {
    document.body.innerHTML =
      '<div class="Layout"><nav><ul><li><div class="Dropdown"><div class="GridItemstyles">' +
      '<a class="CardLink" href="/x"><div class="Card"><div class="Content">' +
      '<h3 class="Title">Droplets heading</h3><p class="Desc">Droplets description text</p>' +
      '</div></div></a></div></div></li></ul></nav></div>';
    const p = document.querySelector('p.Desc') as HTMLElement;

    const diagnosis = analyzeWithStats(p, stats());

    // 采集端会下钻（真实重扫采得到）→ 该给的"等一下就好"提示照给，闸门不误伤。
    expect(diagnosis.finding.reason).toBe('not-in-ledger');
    expect(diagnosis.finding.detail).toContain('点一下页面或等一次交互重扫');
    // 现场证据：真的重扫一次（非 readOnly），这两段就会被采到——"等就好"是实话。
    const rescan = collectSegments(document.body, OPTIONS);
    expect(rescan.map((s) => s.text)).toEqual(['Droplets heading', 'Droplets description text']);
  });

  it('display:none 的"断"仍由 hidden 闸门先接（各闸门不互相抢话）', () => {
    document.body.innerHTML =
      '<div><a style="display:inline"><div class="panel" style="display:none">' +
      '<p class="deep">Panel hidden card text</p></div></a></div>';

    expect(reasonOf(document.querySelector('p.deep') as HTMLElement)).toBe('hidden');
  });
});

/**
 * 第 3 项：诊断输出的元素路径必须是**真实祖先链**。
 *
 * 旧 `describePath` 从 `levels` 拼链，而 `diagnoseElement` 在第一个出结论的层级就 break——
 * 链头不是 body 时它直接补 `body > ` 前缀，凭空造出不存在的父子关系（实测把 19 层的卡片
 * 报成 `body > p.Typographystyles`，排查时把人引向完全错误的方向）。
 */
describe('describePath：打印的每一级在 DOM 里都真实成立', () => {
  /** 元素路径行（`元素：…`），不含前缀。 */
  function pathLine(diagnosis: Diagnosis): string {
    const line = formatClipboard(diagnosis)
      .split('\n')
      .find((row) => row.startsWith('元素：'));
    if (line === undefined) throw new Error('剪贴板里没有元素路径行');
    return line.slice('元素：'.length);
  }

  /**
   * 把打印出的路径解析成**真实元素序列**并钉住关系：
   * 相邻两级之间没有省略号 ⇒ 必须严格 `parentElement` 成立；有省略号 ⇒ 必须是真祖先。
   * （describeElement 的输出本身就是可用的 CSS 选择器：`tag`、`tag#id`、`tag.firstClass`。）
   */
  function assertRealChain(path: string): void {
    const tokens = path.split(' > ');
    expect(tokens[0], `链头必须是 body，实际 ${tokens[0]}`).toBe('body');
    let previous: { token: string; element: Element } | undefined;
    let gap = false;
    let kept = 0;
    for (const token of tokens) {
      if (/^…\d+ 级…$/.test(token)) {
        gap = true;
        continue;
      }
      const selector = token.replace(/⟨[^⟩]*⟩$/, '');
      const found = document.querySelector(selector);
      expect(found, `打印出的这一级在 DOM 里不存在：${token}`).not.toBeNull();
      if (previous !== undefined) {
        if (gap) {
          expect(previous.element.contains(found as Element), `${previous.token} 不是 ${token} 的祖先`).toBe(true);
        } else {
          expect(found?.parentElement, `假父子关系：${previous.token} > ${token}`).toBe(previous.element);
        }
      }
      previous = { token, element: found as Element };
      gap = false;
      kept += 1;
    }
    expect(kept).toBeGreaterThan(1);
  }

  it('短链（≤6 级）：全量输出且每对相邻都是真实 parentElement', () => {
    document.body.innerHTML = '<div class="L1"><div class="L2"><p class="L3">Short chain text</p></div></div>';
    const diagnosis = analyzeWithStats(document.querySelector('p.L3') as HTMLElement, stats());
    const path = pathLine(diagnosis);

    expect(path).toBe('body > div.L1 > div.L2 > p.L3');
    assertRealChain(path);
  });

  it('19 层真实形状：不再编造 "body > p" 的假路径，中间层全部真实存在', () => {
    document.body.innerHTML =
      '<div class="L0"><div class="L1"><header class="L2"><div class="L3"><nav class="L4">' +
      '<div class="L5"><ul class="L6"><li class="L7"><div class="L8"><div class="L9">' +
      '<div class="L10"><div class="L11"><div class="L12"><a class="L13"><div class="L14">' +
      '<div class="L15"><div class="L16"><h3 class="L17">Card title text</h3>' +
      '<p class="L18">Card description text</p></div></div></div></a></div></div></div></div>' +
      '</div></div></div></div></div></nav></div></header></div></div>';
    const p = document.querySelector('p.L18') as HTMLElement;

    const path = pathLine(analyzeWithStats(p, stats()));

    // 旧实现的编造输出（这条曾经真实出现过）：直接把 19 级压成 2 级的假父子。
    expect(path).not.toBe('body > p.L18');
    assertRealChain(path);
    // 链里确实有真实中间层（压缩后的省略段如实报省略级数）。
    expect(path).toMatch(/…\d+ 级…/);
  });

  it('not-drillable 现场：断点级不被头尾压缩掉，且带 ⟨断点⟩ 标记', () => {
    let inner = '<div class="card"><p class="deep">Deeply wrapped card text here</p></div>';
    for (let i = 0; i < MAX_WRAPPER_DEPTH + 1; i += 1) {
      inner = `<span class="w${i}" style="display:inline">${inner}</span>`;
    }
    document.body.innerHTML = `<div class="host"><a class="wrap" href="#" style="display:inline">${inner}</a></div>`;
    const diagnosis = analyzeWithStats(document.querySelector('p.deep') as HTMLElement, stats());

    const path = pathLine(diagnosis);
    expect(path).toContain('a.wrap⟨断点⟩');
    // 断点仍被报出、尾部的点击处也在；中间 17 层包裹允许被压缩。
    expect(path).toContain('p.deep');
    assertRealChain(path);
  });
});
