/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHoverTranslator, type HoverController } from '../../src/content/hover';
import { hideTooltip } from '../../src/content/tooltip';
import { declarationBlock, declarations, parseDeclarations } from '../helpers/css';
import { dispatchSynthetic, dispatchTrusted } from '../helpers/trusted-events';
import type { InlineTranslation } from '../../src/content/inline-types';

/**
 * Shift + 悬停翻译（hover.ts）的行为测试。
 * 翻译入口用注入的假 `translate`——消息协议、超时、缓存的接线在 index 那一层，
 * 由 `inline-features.test.ts` 集成用例负责，这里只测悬停自己的判定与状态机。
 * 每个用例自己创建并 enable 控制器（afterEach 统一 disable），避免上一例的
 * 监听器还挂在共享的 window/document 上跟本用例抢事件。
 */

type TranslateFn = (text: string) => Promise<InlineTranslation>;

const HTML = [
  '<article>',
  '  <p id="one">First paragraph</p>',
  '  <p id="two">Second paragraph</p>',
  '  <div id="wrap"><p id="three">Third <b id="threeb">bold section</b> tail</p></div>',
  '</article>',
  '<button id="btn"><span id="btnspan">Products</span>' +
    '<svg id="btnsvg" viewBox="0 0 12 12"><polyline points="2,4 6,8 10,4"/></svg></button>',
].join('\n');

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`没有 #${id}`);
  return node;
}

function bubble(): HTMLElement | null {
  return document.querySelector('[data-jy-tooltip]');
}

function bubbleText(): string {
  return bubble()?.shadowRoot?.querySelector('.jy-text')?.textContent ?? '';
}

/** 气泡的视觉状态（data-state）：pending / error / done。 */
function bubbleState(): string | null {
  return bubble()?.shadowRoot?.querySelector('.jy-bubble')?.getAttribute('data-state') ?? null;
}

function highlightHost(): HTMLElement | null {
  return document.querySelector('[data-jy-hover-highlight]');
}

/**
 * 「真实用户手势」与合成事件走同一派发路径，唯一区别是 {@link dispatchTrusted} 会把
 * isTrusted 翻成 true（jsdom 下这个不可配置访问器改不动，见 helper 的注释）。
 * 正负成对：只测「合成事件被拒」会掩盖「永远拒绝」的假通过。
 */
function pressShift(): void {
  dispatchTrusted(window, new KeyboardEvent('keydown', { key: 'Shift' }));
}

/** keyup 不是请求入口（只做状态清理），不受闸门管辖：普通派发即可。 */
function releaseShift(): void {
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
}

function enter(id: string): void {
  dispatchTrusted(byId(id), new MouseEvent('mouseover', { bubbles: true }));
}

/**
 * 按住 Alt 时进入段落。
 *
 * `Alt` 在这条链路里是**事件自己的物理修饰键状态**：抑制判据读的就是这个 mouseover 带的
 * `altKey`，不读任何"Alt 按着没有"的缓存变量——所以每个事件都要把它如实带上，
 * 这也是"keyup 丢了也不会坏"的根源（见下面「吞 keyup」那条用例）。
 */
function enterWithAlt(id: string): void {
  dispatchTrusted(byId(id), new MouseEvent('mouseover', { bubbles: true, altKey: true }));
}

function syntheticPressShift(): void {
  dispatchSynthetic(window, new KeyboardEvent('keydown', { key: 'Shift' }));
}

/** 按住 Alt：诊断模式（Alt+Shift+点击）的修饰键，与 Shift 同一套 isTrusted 闸门。 */
function pressAlt(): void {
  dispatchTrusted(window, new KeyboardEvent('keydown', { key: 'Alt' }));
}

/** keyup 不是请求入口（只做状态清理），不受闸门管辖：普通派发即可。 */
function releaseAlt(): void {
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
}

function syntheticPressAlt(): void {
  dispatchSynthetic(window, new KeyboardEvent('keydown', { key: 'Alt' }));
}

function syntheticEnter(id: string): void {
  dispatchSynthetic(byId(id), new MouseEvent('mouseover', { bubbles: true }));
}

let live: HoverController[] = [];

function givenHover(translate: TranslateFn, delayMs?: number): HoverController {
  const controller = createHoverTranslator({ translate, delayMs });
  controller.enable();
  live.push(controller);
  return controller;
}

/** 推过悬停延时（默认 180ms）并把请求→响应→渲染的微任务链跑完。 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(220);
}

function autoTranslate() {
  return vi.fn(async (text: string): Promise<InlineTranslation> => ({ ok: true, text: `译文:${text}` }));
}

function deferredTranslate() {
  const pending = new Map<string, (value: InlineTranslation) => void>();
  const translate = vi.fn((text: string) => {
    return new Promise<InlineTranslation>((resolve) => {
      pending.set(text, resolve);
    });
  });
  return {
    translate,
    resolve: (text: string, value: InlineTranslation) => pending.get(text)?.(value),
  };
}

beforeEach(() => {
  document.body.innerHTML = HTML;
  vi.useFakeTimers();
});

afterEach(() => {
  for (const controller of live) controller.disable();
  live = [];
  hideTooltip();
  for (const node of Array.from(document.querySelectorAll('[data-jy-root]'))) node.remove();
  vi.useRealTimers();
});

describe('Shift 状态跟踪', () => {
  it('未按 Shift：悬停段落什么都不发生', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    enter('one');
    await settle();

    expect(translate).not.toHaveBeenCalled();
    expect(bubble()).toBeNull();
    expect(highlightHost()).toBeNull();
  });

  it('按着 Shift 进入段落：到点发一次请求，结果只进浮层', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    pressShift();
    enter('one');
    await settle();

    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledWith('First paragraph');
    expect(bubbleText()).toBe('译文:First paragraph');
    expect(bubble()?.parentElement).toBe(document.documentElement);
  });

  it('延时未到就离开：一次请求都不发（鼠标快速划过不轰炸）', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    pressShift();
    enter('one');
    await vi.advanceTimersByTimeAsync(170);
    expect(translate).not.toHaveBeenCalled(); // 180ms 还没到

    enter('wrap'); // 离开段落 → 取消未触发的请求
    await settle();
    expect(translate).not.toHaveBeenCalled();
  });

  it('松开 Shift：撤掉描边，但已出来的译文保留（设计文档 §4.2「移出保留译文」）', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    pressShift();
    enter('one');
    await settle();
    expect(highlightHost()).not.toBeNull();

    releaseShift();
    expect(highlightHost()).toBeNull();
    expect(bubbleText()).toBe('译文:First paragraph');
  });

  it('窗口失焦（keyup Shift 收不到的场景）：Shift 状态与描边一起复位', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    pressShift();
    enter('one');
    await settle();
    window.dispatchEvent(new Event('blur'));
    expect(highlightHost()).toBeNull();

    // 幽灵 Shift 状态被清掉：不重新按下 Shift，换段落也不会再请求。
    enter('two');
    await settle();
    expect(translate).toHaveBeenCalledTimes(1);
  });
});

/**
 * Alt 按住时整条悬停链路停摆。
 *
 * 起因是实测出来的冲突：诊断模式的手势是 **Alt+Shift+点击**，里面含 Shift——用户按住它
 * 移向目标元素的路上会**扫过沿途每一个段落**，每一段都描边、弹气泡、并且真的发一次引擎
 * 请求（用户自己付费的额度）。这里每一条都钉住其中一面。
 *
 * 判据取 **mouseover 事件自己的 `altKey`**（事件发生那一刻的物理修饰键状态），不是
 * "Alt 按着没有"的缓存变量——每个事件都带着当下的真相，而缓存要靠配对的 keyup 维护：
 * Windows 的 `Alt+Shift` 切换输入法会**吞掉 keyup 且窗口不失焦**，丢一次就永久卡死。
 * 所以下面每条都按"这个 mouseover 有没有带 Alt"派发，而不是靠先按一次 Alt 顶状态。
 */
describe('按住 Alt 抑制悬停（与诊断模式 Alt+Shift 手势冲突）', () => {
  it('按住 Alt，真实鼠标进入段落：零请求、无描边、无气泡', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    pressShift();
    pressAlt();
    enterWithAlt('one');
    await settle();

    expect(translate).not.toHaveBeenCalled();
    expect(bubble()).toBeNull();
    expect(highlightHost()).toBeNull();
  });

  it('先悬停出描边 → 按下 Alt：描边立刻撤掉，未到点的请求被取消', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    pressShift();
    enter('one');
    await vi.advanceTimersByTimeAsync(170); // 180ms 还没到：请求仍在延时里
    expect(highlightHost()).not.toBeNull();
    expect(translate).not.toHaveBeenCalled();

    pressAlt();

    // 描边必须当场消失：留着它，用户下一步点击时看到的"目标"是上一次悬停的段落。
    expect(highlightHost()).toBeNull();
    await settle();
    expect(translate).not.toHaveBeenCalled();
  });

  it('按 Alt 保留已展示的译文气泡（与「移出保留译文」同一约定）', async () => {
    const translate = autoTranslate();
    givenHover(translate, 0);
    pressShift();
    enter('one');
    await vi.advanceTimersByTimeAsync(10);
    expect(bubbleText()).toBe('译文:First paragraph');
    expect(highlightHost()).not.toBeNull();

    pressAlt();

    expect(highlightHost()).toBeNull();
    expect(bubbleText()).toBe('译文:First paragraph');

    // 按住 Alt 期间掠过别的段落：这次 mouseover 自己带着 altKey，气泡换成新段就是
    // "又发了一次请求"，一个字都不许变。
    enterWithAlt('two');
    await settle();
    expect(translate).toHaveBeenCalledTimes(1);
    expect(bubbleText()).toBe('译文:First paragraph');
  });

  it('松开 Alt 后悬停恢复：指针没离开原段落也照常重新进入', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    pressShift();
    enter('one');
    await settle();
    expect(highlightHost()).not.toBeNull();

    releaseShift(); // 撤描边，但"当前段落"仍是 #one（既有行为）
    pressAlt(); // 按 Alt 必须把"当前段落"一起撤销，否则下面这次进入会被当成重复进入
    enterWithAlt('one'); // 按住 Alt 路过同一段：被抑制，且一个状态都不该被它改动
    releaseAlt();
    pressShift();
    enter('one');

    expect(highlightHost()).not.toBeNull();
    await settle();
    expect(bubbleText()).toBe('译文:First paragraph');
    expect(translate).toHaveBeenCalledTimes(1); // 同段走会话缓存，零往返
  });

  /**
   * 幽灵 Alt 会让悬停功能**永久失效**，这条钉的就是那个现场——而且是最毒的一种：
   * **keyup 被吞掉、窗口还不失焦**，`blur` 兜底根本不会触发。
   *
   * Windows 的 `Alt+Shift` 切换输入法在部分环境就是这么干的：键按下去了（keydown 到），
   * 松开时那个 keyup 被输入法吃掉，焦点一直在页面上。旧设计把"Alt 按着"记在状态变量里，
   * 于是它永远卡在 true，之后每一个 Shift 悬停都被早退——用户只会觉得"悬停翻译坏了"，
   * 没有任何可见症状指向原因（`Alt+Tab` 那条路径至少有 blur 兜底，这条没有）。
   *
   * 新设计的判据是 mouseover 事件自己的 `altKey`：**下一次鼠标进入段落时就自带真相**，
   * 不需要 keyup、也不需要 blur。所以这条用例**故意什么都不派发**——没有 keyup(Alt)，
   * 也没有 blur——直接把指针移到段落上，悬停必须照常工作。
   */
  it('Alt 的 keyup 被输入法吞掉且窗口不失焦（无 keyup、无 blur）：悬停照常恢复', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    pressShift();
    pressAlt(); // 只派发 keydown(Alt)：keyup 被吞掉
    enterWithAlt('one'); // 按住 Alt 移向诊断目标：沿途段落被抑制
    await settle();
    expect(translate).not.toHaveBeenCalled();
    expect(highlightHost()).toBeNull();

    // Alt 在物理上已经松开了（keyup 被输入法吞了、窗口一直有焦点、blur 一次都没来）：
    // 下一个 mouseover 自己就带着真相，悬停必须立即恢复。
    enter('one');
    await settle();

    expect(translate).toHaveBeenCalledTimes(1);
    expect(bubbleText()).toBe('译文:First paragraph');
    expect(highlightHost()).not.toBeNull();
  });

  /**
   * `Alt+Tab` 切走窗口：keyup(Alt) 与 keyup(Shift) 都收不到，这一次是 `blur` 该救的路径
   * （Shift 那个状态仍然需要配对 keyup 维护，所以兜底必须留着）。
   */
  it('Alt 的 keyup 丢失 + blur（Alt+Tab 切走）：悬停必须能恢复', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    pressShift();
    pressAlt();
    enterWithAlt('one');
    await settle();
    expect(translate).not.toHaveBeenCalled(); // 按住 Alt：被抑制

    // Alt+Tab 切走窗口：keyup(Alt) 与 keyup(Shift) 都不会到。
    window.dispatchEvent(new Event('blur'));

    // 回来重新按住 Shift 悬停同一段：必须照常描边、发请求、出气泡。
    pressShift();
    enter('one');
    await settle();

    expect(translate).toHaveBeenCalledTimes(1);
    expect(bubbleText()).toBe('译文:First paragraph');
    expect(highlightHost()).not.toBeNull();
  });

  /**
   * `isTrusted` 与 Shift 同一套：伪造 Alt **只能关掉自己的功能**（fail 的方向是安全方向），
   * 但闸门只有一套——页面脚本合成一个 keydown(Alt) 就把悬停静音，是白送的拒绝服务。
   */
  it('合成 keydown(Alt)：不改变行为（真实 Shift+悬停照常出结果）', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    syntheticPressAlt();
    pressShift();
    enter('one');
    await settle();

    expect(translate).toHaveBeenCalledTimes(1);
    expect(bubbleText()).toBe('译文:First paragraph');
    expect(highlightHost()).not.toBeNull();

    // 按下 Alt 那一刻清描边/取消请求是**真实 keydown 的职权**：合成的那一个必须被闸门挡在
    // 外面，否则页面脚本能让用户当前这次悬停凭空消失（白送的拒绝服务）。
    syntheticPressAlt();
    expect(highlightHost()).not.toBeNull();
  });

  it('不按 Alt 时悬停与从前逐字相同（成对断言：抑制只由真实 Alt 触发）', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    pressShift();
    enter('one');
    await settle();
    expect(translate).toHaveBeenCalledTimes(1);

    releaseAlt(); // 没按下过也松一下：不该影响任何状态
    enter('two');
    await settle();
    expect(translate).toHaveBeenCalledTimes(2);
    expect(bubbleText()).toBe('译文:Second paragraph');
  });
});

describe('安全闸门：只响应真实用户手势（isTrusted）', () => {
  it('合成 keydown(Shift) + 合成 mouseover：不请求、不描边、不出气泡', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    syntheticPressShift();
    syntheticEnter('one');
    await settle();

    expect(translate).not.toHaveBeenCalled();
    expect(bubble()).toBeNull();
    expect(highlightHost()).toBeNull();
  });

  it('真实按下 Shift、但 mouseover 是页面合成的：仍然零请求（两个入口各自都把门）', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    pressShift();
    syntheticEnter('one');
    await settle();

    expect(translate).not.toHaveBeenCalled();
    expect(highlightHost()).toBeNull();
  });

  /**
   * 这条单独钉 keydown 那道闸门——上面两条负例（合成+合成、真实+合成）其实都只把住了
   * mouseover 那一道：把 `onKeyDown` 里的 isTrusted 检查删掉，那两条仍然全绿。
   *
   * 攻击场景是真实的：页面合成一个 keydown(Shift) 把 `shiftDown` 抬成 true，之后
   * **用户自己的任意一次真实悬停**就会被劫持去发请求、烧用户付费引擎的额度——
   * 页面全程没有能力触发 mouseover，所以这道闸门不能只靠 mouseover 侧兜。
   */
  it('合成 keydown 抬起 Shift 状态、mouseover 是真实手势：仍然零请求（keydown 闸门独立承重）', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    syntheticPressShift();
    enter('one');
    await settle();

    expect(translate).not.toHaveBeenCalled();
    expect(highlightHost()).toBeNull();
  });

  it('成对断言：keydown 与 mouseover 都是真实手势 → 到点发请求（否则上面两条只是「永远拒绝」的假通过）', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    pressShift();
    enter('one');
    await settle();

    expect(translate).toHaveBeenCalledWith('First paragraph');
    expect(bubbleText()).toBe('译文:First paragraph');
  });
});

describe('请求去重与缓存', () => {
  it('同一段落重复进入不重复发请求（缓存直接展示）', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    pressShift();
    enter('one');
    await settle();
    expect(translate).toHaveBeenCalledTimes(1);

    enter('wrap'); // 离开
    enter('one'); // 再进来
    await settle();
    expect(translate).toHaveBeenCalledTimes(1);
    expect(bubbleText()).toBe('译文:First paragraph');
  });

  it('离开进入另一段：发起第二次请求，气泡换成新段', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    pressShift();
    enter('one');
    await settle();
    enter('two');
    await settle();

    expect(translate).toHaveBeenCalledTimes(2);
    expect(translate).toHaveBeenNthCalledWith(2, 'Second paragraph');
    expect(bubbleText()).toBe('译文:Second paragraph');
  });

  it('悬停行内子元素归属整段：判据与采集端共用（"什么算一段"只有一份）', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    pressShift();
    enter('threeb');
    await settle();

    // 而不是只翻加粗的那一截。
    expect(translate).toHaveBeenCalledWith('Third bold section tail');
  });

  /**
   * BUTTON 从 SKIP_TAGS 移除后，悬停落在按钮里的文字上不再是"这里不该翻译"：
   * 段落判据要命中按钮整块（svg 不并入文本），描边与气泡照常。
   */
  it('悬停按钮里的 span：整块按钮成段、请求只带可见文字、描边与气泡正常', async () => {
    const translate = autoTranslate();
    givenHover(translate);
    pressShift();
    enter('btnspan');
    await settle();

    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledWith('Products');
    expect(bubbleText()).toBe('译文:Products');

    const host = highlightHost();
    expect(host).not.toBeNull();
    expect(host?.parentElement).toBe(document.documentElement);
    const frame = host?.shadowRoot?.firstElementChild;
    expect(frame?.getAttribute('style') ?? '').toContain('outline:');
    // 页面元素一个属性都不加。
    expect(byId('btn').hasAttribute('style')).toBe(false);
  });

  it('先请求的段落结果更晚回来时不覆盖当前段的气泡（迟到结果作废）', async () => {
    const slow = deferredTranslate();
    givenHover(slow.translate, 0);
    pressShift();
    enter('one');
    await vi.advanceTimersByTimeAsync(10);
    enter('two');
    await vi.advanceTimersByTimeAsync(10);
    expect(slow.translate).toHaveBeenCalledTimes(2);

    slow.resolve('Second paragraph', { ok: true, text: '乙段译文' });
    await vi.advanceTimersByTimeAsync(10);
    expect(bubbleText()).toBe('乙段译文');

    // 甲段更晚回来：它已经不是"最后请求的那一段"，结果必须安静丢弃。
    slow.resolve('First paragraph', { ok: true, text: '甲段译文' });
    await vi.advanceTimersByTimeAsync(10);
    expect(bubbleText()).toBe('乙段译文');
  });
});

describe('高亮：outline 描边框，零布局注入', () => {
  it('描边框挂在 documentElement 上、fixed、不吃点击', async () => {
    givenHover(autoTranslate());
    pressShift();
    enter('one');
    await settle();

    const host = highlightHost();
    expect(host).not.toBeNull();
    expect(host?.parentElement).toBe(document.documentElement);
    expect(host?.style.position).toBe('fixed');
    expect(host?.style.pointerEvents).toBe('none');
  });

  it('高亮用 outline，且没有 border / padding / margin；段落自身一个属性都不加', async () => {
    givenHover(autoTranslate());
    pressShift();
    enter('one');
    await settle();

    const frame = highlightHost()?.shadowRoot?.firstElementChild;
    const styleAttribute = frame?.getAttribute('style') ?? '';
    expect(styleAttribute).toContain('outline:');
    // 上一个单元的事故的来源就是这几样：这里一个都不许出现（`box-sizing:border-box` 不算边框）。
    expect(styleAttribute).not.toMatch(/border(-\w+)?\s*:/);
    expect(styleAttribute).not.toMatch(/(^|;)\s*(padding|margin)(-\w+)?\s*:/);
    // 页面段落：没有 inline style，没有新属性。
    expect(byId('one').hasAttribute('style')).toBe(false);
  });

  it('移出段落就撤描边；描边只在 documentElement 上，body 一个字节都不动', async () => {
    givenHover(autoTranslate());
    const before = document.body.innerHTML;
    pressShift();
    enter('one');
    await settle();
    enter('wrap');

    expect(highlightHost()).toBeNull();
    expect(document.body.innerHTML).toBe(before);
  });
});

describe('高亮观感：柔和描边 + 极淡底 + 淡入', () => {
  async function openHighlight(): Promise<HTMLElement> {
    givenHover(autoTranslate());
    pressShift();
    enter('one');
    await settle();
    const host = highlightHost();
    if (host === null) throw new Error('没有高亮浮层');
    return host;
  }

  /**
   * 两个不透明度是核验给死的（上一轮 0.45 / 0.06 那组在浅色页面上只有约 1.8:1，
   * 描边只算"可辨"）：0.6 / 0.08 约 2.3:1。断言取的是**解析后的声明表**，
   * 不是"整段字符串里有这几个字"——删掉声明或改掉数值都必须当场红。
   */
  it('描边是 60% 的强调色、底色是 8% 的强调色，都挂在我们的 fixed 浮层自己的框上', async () => {
    const host = await openHighlight();
    const style = parseDeclarations(host.shadowRoot?.firstElementChild?.getAttribute('style') ?? '');
    expect(style['outline']).toBe('2px solid rgba(37, 99, 235, 0.6)');
    expect(style['background']).toBe('rgba(37, 99, 235, 0.08)');
    // 尺寸口径与 shadow 里那套一致：100% × 100% + border-box = 正好是段落的可见矩形。
    expect(style['width']).toBe('100%');
    expect(style['height']).toBe('100%');
    expect(style['box-sizing']).toBe('border-box');
    // 描边不参与布局：只有尺寸，没有任何边框/内边距/外边距。
    expect(Object.keys(style).filter((key) => /^(border|padding|margin)/.test(key))).toEqual([]);
  });

  it('圆角与 120ms 淡入写在样式表里；reduced-motion 下不动', async () => {
    const host = await openHighlight();
    const css = host.shadowRoot?.querySelector('style')?.textContent ?? '';
    const box = declarations(css, '.jy-hover-box {');
    expect(box['border-radius']).toBe('6px');
    expect(box['animation']).toBe('jy-hover-in 120ms ease-out');
    // 关键帧真的存在，并且从透明开始淡入。
    expect(declarationBlock(css, '@keyframes jy-hover-in').replace(/\s+/g, ' ')).toContain('from { opacity: 0; }');
    // 同名的第二条规则在媒体查询里：降级为不动（按作用域取，不会拿到顶层那条）。
    const reduced = declarations(css, '.jy-hover-box {', '@media (prefers-reduced-motion: reduce)');
    expect(reduced['animation']).toBe('none');
  });

  it('样式全在浮层自己身上：页面元素一个 inline style 都没有（布局不变式照旧）', async () => {
    const host = await openHighlight();
    // 描边/底色属于**我们自己的浮层**，不是对页面元素的注入（上一个 border-left 事故的教训）。
    expect(host.shadowRoot?.firstElementChild?.className).toBe('jy-hover-box');
    for (const node of Array.from(document.querySelectorAll('article, p, b'))) {
      expect((node as HTMLElement).hasAttribute('style'), node.tagName).toBe(false);
    }
  });
});

describe('气泡状态跟着结论走', () => {
  it('请求在飞：pending；成功落地：done', async () => {
    const slow = deferredTranslate();
    givenHover(slow.translate, 0);
    pressShift();
    enter('one');
    await vi.advanceTimersByTimeAsync(10);
    expect(bubbleState()).toBe('pending');

    slow.resolve('First paragraph', { ok: true, text: '甲段译文' });
    await vi.advanceTimersByTimeAsync(10);
    expect(bubbleState()).toBe('done');
    expect(bubbleText()).toBe('甲段译文');
  });

  it('失败结论：error 态 + 失败文案（不是 pending 的死等）', async () => {
    const slow = deferredTranslate();
    givenHover(slow.translate, 0);
    pressShift();
    enter('one');
    await vi.advanceTimersByTimeAsync(10);
    expect(bubbleState()).toBe('pending');

    slow.resolve('First paragraph', { ok: false, message: '无法连接后台' });
    await vi.advanceTimersByTimeAsync(10);
    expect(bubbleState()).toBe('error');
    expect(bubbleText()).toBe('无法连接后台');
  });
});

describe('开关与生命周期', () => {
  it('不 enable 就没有任何监听（hoverTranslate:false 的形态）', async () => {
    const translate = autoTranslate();
    createHoverTranslator({ translate }); // 造出来但没 enable —— 监听器不该存在

    pressShift();
    enter('one');
    await settle();
    expect(translate).not.toHaveBeenCalled();
    expect(bubble()).toBeNull();
  });

  it('disable 之后不再响应，并且已有描边与气泡都被收掉', async () => {
    const translate = autoTranslate();
    const controller = givenHover(translate);
    pressShift();
    enter('one');
    await settle();
    expect(bubble()).not.toBeNull();

    controller.disable();
    expect(bubble()).toBeNull();
    expect(highlightHost()).toBeNull();

    pressShift();
    enter('two');
    await settle();
    expect(translate).toHaveBeenCalledTimes(1); // 只有 disable 之前那一次
  });

  it('reset + 关气泡（页面还原的路径）：在飞结果不许把气泡弹回来', async () => {
    const slow = deferredTranslate();
    const controller = givenHover(slow.translate, 0);
    pressShift();
    enter('one');
    await vi.advanceTimersByTimeAsync(10);
    expect(bubbleText()).toBe('翻译中…');

    controller.reset();
    hideTooltip();
    slow.resolve('First paragraph', { ok: true, text: '迟到的译文' });
    await vi.advanceTimersByTimeAsync(10);
    expect(bubble()).toBeNull();
  });
});
