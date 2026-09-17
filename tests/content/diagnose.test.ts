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
import { createStyleLookup, inlineText } from '../../src/content/extractor';
import { diagnoseElement, formatClipboard, formatToast, type Diagnosis } from '../../src/content/diagnose';

/** 分析上下文：目标语言一定是中文（下面所有现场都是英文文本）。 */
const OPTIONS = { targetLang: 'zh-Hans', pageHasKana: false };

function analyze(target: EventTarget, options: typeof OPTIONS | null = OPTIONS): Diagnosis {
  // 观察者读数在接线层才注入，分析内核不依赖它（这里的 null 就是"没有观察者信息"）。
  return diagnoseElement(target, { scanOptions: () => options, stats: () => null });
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
  it('未被采集的普通段落：结论是「已采集未翻译」并指明宿主不存在', () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';
    const paragraph = document.getElementById('p') as HTMLElement;

    const diagnosis = analyze(paragraph);

    expect(diagnosis.element).toBe(paragraph);
    // "会成段"这一半是确定的——分析真的跑了一遍采集（只分析、不落笔，见 readOnly）。
    // 不确定的、也是最要命的那一半恰好是：宿主不存在 ⇒ 请求/渲染环节出了问题。
    expect(diagnosis.finding.reason).toBe('collected');
    expect(diagnosis.finding.detail).toContain('宿主不存在');
    // 主结论就是**最靠近点击处**那一级的结论（下面每一级的链路都能看到）。
    expect(diagnosis.levels[0]?.element).toBe(paragraph);
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

    expect(wrapper.finding.reason).toBe('collected');
    expect(paragraph.finding.reason).toBe('collected');
    expect(wrapper.finding.detail).toBe(paragraph.finding.detail);
    // 链路至少含点击处自己那一级。
    expect(wrapper.levels[0]?.element).toBe(document.getElementById('s'));
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

    expect(reasonOf(readonly)).toBe('collected');
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
    // 关掉"已是目标语言"这条跳过之后，它就是一整段会被采集的文本。
    expect(reasonOf(document.getElementById('p') as HTMLElement, { ...OPTIONS, pageHasKana: true })).toBe(
      'collected',
    );
  });

  it('会下钻的容器（含块级子元素）：结论提示点更里面的元素', () => {
    document.body.innerHTML = '<div id="card">Intro text<p id="body">Body text</p></div>';
    const card = document.getElementById('card') as HTMLElement;

    const diagnosis = analyze(card);

    expect(diagnosis.finding.reason).toBe('drills-down');
    expect(diagnosis.finding.detail).toContain('子元素');
    // 子元素自己才是那一段：主结论确实取了最近一级，而不是容器的。
    expect(reasonOf(document.getElementById('body') as HTMLElement)).toBe('collected');
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

    // 按钮**不在**跳过名单里（digitalocean 的事故就是它）：照常算可采集。
    expect(reasonOf(document.getElementById('btn') as HTMLElement)).toBe('collected');
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
    expect(diagnosis.finding.reason).toBe('collected');
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

  it('页面还没翻译（没有采集选项）时也能跑：结论照样可读', () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';

    const diagnosis = analyze(document.getElementById('p') as HTMLElement, null);

    // 没有快照就没有目标语言可判：不因"看起来已是目标语言"而报跳过。
    expect(diagnosis.finding.reason).toBe('collected');
    expect(diagnosis.finding.text).not.toBe('');
  });
});

describe('诊断输出：页面内两行 / 剪贴板全文', () => {
  it('页面内提示两行：第一行是结论，第二行是观察者状态（截图里带得上的上下文）', () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';
    const diagnosis = analyze(document.getElementById('p') as HTMLElement);

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
