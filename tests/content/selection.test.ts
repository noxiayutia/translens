/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSelectionTranslator, type SelectionController } from '../../src/content/selection';
import { hideTooltip, showTooltip } from '../../src/content/tooltip';
import { dispatchSynthetic, dispatchTrusted } from '../helpers/trusted-events';
import type { InlineTranslation } from '../../src/content/inline-types';

/**
 * 划词翻译气泡（selection.ts）。
 *
 * **两段式**：mouseup 只出紧凑小气泡（chip，零请求）；指针停在上面满延时、或点小气泡上的
 * 「翻译」按钮，才发第一次请求。停留这个机制本身由 `tooltip.test.ts` 的 hoverIntent 那组钉
 * （它住在浮层里），这里默认用 `hoverDelayMs: 0` 建控制器，只测划词这一侧的判定与状态机；
 * 唯一钉"生产默认值"的那条用例单独开假计时器。
 *
 * jsdom 没有可用的选区/剪贴板设施：`window.getSelection` 按形状替身
 * （`getBoundingClientRect` 用可控假矩形——真 jsdom 下它返回全 0，另有专门的容忍用例），
 * `navigator.clipboard` 逐用例打桩、逐用例清干净。
 * 消息接线在 index 层，由 `inline-features.test.ts` 负责。
 */

type TranslateFn = (text: string) => Promise<InlineTranslation>;

const RECT = { top: 120, left: 340, width: 100, height: 16 };

/**
 * chip 态的判据：屏幕上**一个可见文字都没有**，只有一个 icon-only 圆点按钮。
 * 名字只存在于 aria-label 里——读屏与键盘用户靠它，视觉上什么都没有。
 */
function expectDot(): void {
  expect(bubbleText()).toBe('');
  const root = bubble()?.shadowRoot;
  const dot = root?.querySelector('button') as HTMLButtonElement | null;
  expect(dot?.getAttribute('aria-label')).toBe('翻译选中的文字');
  expect(dot?.textContent).toBe('');
  expect(dot?.querySelector('.jy-action-label')).toBeNull();
  expect(dot?.type).toBe('button');
  expect(dot?.querySelector('svg')).not.toBeNull();
}

const originalGetSelection = window.getSelection;
let live: SelectionController[] = [];

function mockSelection(
  value: { text: string; rect?: typeof RECT; anchor?: Node | null; focus?: Node | null } | null,
): void {
  Object.defineProperty(window, 'getSelection', {
    configurable: true,
    writable: true,
    value:
      value === null
        ? () => null
        : () => ({
            // rangeCount 与文本一致：空串模拟"没有选区"。
            rangeCount: value.text === '' ? 0 : 1,
            toString: () => value.text,
            anchorNode: value.anchor === undefined ? document.body : value.anchor,
            focusNode:
              value.focus === undefined ? (value.anchor === undefined ? document.body : value.anchor) : value.focus,
            getRangeAt: () => ({
              // 真 jsdom 下 getBoundingClientRect 返回全 0——这里默认给一个有位置的矩形，
              // 定位断言才有意义；全 0 的容忍度由单独用例覆盖。
              getBoundingClientRect: () => value.rect ?? RECT,
            }),
          }),
  });
}

function mockClipboard(writeText: (text: string) => Promise<void>): void {
  vi.stubGlobal('navigator', { clipboard: { writeText } });
}

function bubble(): HTMLElement | null {
  return document.querySelector('[data-jy-tooltip]');
}

function bubbleNode(): HTMLElement | null {
  return bubble()?.shadowRoot?.querySelector('.jy-bubble') ?? null;
}

/** 当前这一屏是哪一档：'chip' = 还没发请求的待触发态，'bubble' = 译文那一屏。 */
function variant(): string | null {
  return bubbleNode()?.getAttribute('data-variant') ?? null;
}

function bubbleText(): string {
  return bubble()?.shadowRoot?.querySelector('.jy-text')?.textContent ?? '';
}

function bubbleState(): string | null {
  return bubbleNode()?.getAttribute('data-state') ?? null;
}

function buttonLabels(): string[] {
  const root = bubble()?.shadowRoot;
  if (root == null) return [];
  return Array.from(root.querySelectorAll('button')).map((button) => button.textContent ?? '');
}

function clickButton(labelPrefix: string): HTMLButtonElement | undefined {
  const button = findButton(labelPrefix);
  // composed:true 与真实 UI 事件一致——非合成事件不会穿过 shadow 边界，host 上的委托收不到。
  // 走 dispatchTrusted：委托层的闸门只认真实手势（见下面「安全闸门：浮层里的按钮」那组），
  // 正例必须用可信派发才打得到回调。
  if (button !== undefined) dispatchTrusted(button, new MouseEvent('click', { bubbles: true, composed: true }));
  return button;
}

function findButton(labelPrefix: string): HTMLButtonElement | undefined {
  const root = bubble()?.shadowRoot;
  if (root == null) return undefined;
  return Array.from(root.querySelectorAll('button')).find((candidate) =>
    (candidate.getAttribute('aria-label') ?? candidate.textContent ?? '').startsWith(labelPrefix),
  ) as HTMLButtonElement | undefined;
}

/** 页面脚本那一侧的点击：isTrusted=false，与真实 UI 事件唯一的区别就是这个。 */
function syntheticClickButton(labelPrefix: string): HTMLButtonElement | undefined {
  const button = findButton(labelPrefix);
  if (button !== undefined) dispatchSynthetic(button, new MouseEvent('click', { bubbles: true, composed: true }));
  return button;
}

/**
 * 按真机的顺序派发一次完整的按钮点击（mousedown → mouseup → click），并**在 mouseup 派发
 * 途中**记录被按下的那个按钮还在不在文档里。
 *
 * 为什么在途中取值：Chrome 合成 click 看的是"抬起那一刻的目标还与按下时相连"，而按钮在
 * click 之后被换掉是**正确的**（气泡要转成「翻译中…」那一屏）。jsdom 不会自己合成 click，
 * 手工发的 click 甚至能打到已脱离文档的节点上——所以"click 生效"在这里证明不了任何事，
 * 真机暴露的那个量才是判据（`.qa/probe-click3.mjs` 记的就是同一个时刻的 isConnected）。
 */
function pressButton(labelPrefix: string): { button: HTMLButtonElement | undefined; connectedAtMouseup: boolean } {
  const button = findButton(labelPrefix);
  if (!(button instanceof HTMLButtonElement)) return { button: undefined, connectedAtMouseup: false };
  let connectedAtMouseup = true;
  const probe = (): void => {
    connectedAtMouseup = button.isConnected;
  };
  // 产品那个 document 捕获监听先注册，因此本监听器排在它之后：取到的正是"产品处理完这次
  // mouseup 之后、click 还没派发之前"的状态，与真机台架的口径逐字对齐。
  document.addEventListener('mouseup', probe, true);
  dispatchTrusted(button, new MouseEvent('mousedown', { bubbles: true, composed: true, button: 0 }));
  dispatchTrusted(button, new MouseEvent('mouseup', { bubbles: true, composed: true, button: 0 }));
  document.removeEventListener('mouseup', probe, true);
  dispatchTrusted(button, new MouseEvent('click', { bubbles: true, composed: true, button: 0 }));
  return { button, connectedAtMouseup };
}

/**
 * 「真实用户手势」与合成事件走同一派发路径，唯一区别是 {@link dispatchTrusted} 会把
 * isTrusted 翻成 true（jsdom 下这个不可配置访问器改不动，见 helper 的注释）。
 * 两条成对出现：只有「伪造成 true 会请求」也绿，「合成事件被拒」那条才算数
 * （否则「永远拒绝」的实现同样能让负向用例假通过）。
 */
function mouseup(button = 0): void {
  dispatchTrusted(document.body, new MouseEvent('mouseup', { bubbles: true, button }));
}

function syntheticMouseup(button = 0): void {
  dispatchSynthetic(document.body, new MouseEvent('mouseup', { bubbles: true, button }));
}

/** 第二段的两条入口之一：把真实指针停到小气泡上（enter + move，真机移动进气泡就是这两件）。 */
function hoverChip(): void {
  const node = bubble();
  if (node === null) throw new Error('划词没有先出小气泡');
  dispatchTrusted(node, new MouseEvent('pointerenter'));
  dispatchTrusted(node, new MouseEvent('pointermove'));
}

/** 指针移出小气泡（"还没停够就走"）。 */
function leaveChip(): void {
  const node = bubble();
  if (node === null) return;
  dispatchTrusted(node, new MouseEvent('pointerleave'));
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 跨过某个真实毫秒数——这几条用例要钉的就是"到点 / 没到点"。 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 完整两段：划词 → 真实指针停上小气泡 → 满延时（控制器默认 hoverDelayMs: 0）。 */
async function selectAndTranslate(text: string): Promise<void> {
  mockSelection({ text });
  mouseup();
  await settle();
  hoverChip();
  await settle();
}

function autoTranslate(): { translate: TranslateFn; calls: string[] } {
  const calls: string[] = [];
  const translate: TranslateFn = (text) => {
    calls.push(text);
    return Promise.resolve({ ok: true, text: `译文:${text}` });
  };
  return { translate, calls };
}

/** 按调用顺序排队、可逐个兑现的翻译替身：用来测"旧请求迟到的结果被作废"。 */
function queueTranslate(): { translate: TranslateFn; resolveNext: (value: InlineTranslation) => void } {
  const queue: ((value: InlineTranslation) => void)[] = [];
  return {
    translate: () => new Promise<InlineTranslation>((resolve) => queue.push(resolve)),
    resolveNext: (value) => queue.shift()?.(value),
  };
}

function givenSelection(translate: TranslateFn, hoverDelayMs = 0): SelectionController {
  const controller = createSelectionTranslator({ translate, hoverDelayMs });
  controller.enable();
  live.push(controller);
  return controller;
}

beforeEach(() => {
  document.body.innerHTML = '<p id="page">Some page text</p>';
  mockSelection(null);
});

afterEach(() => {
  for (const controller of live) controller.disable();
  live = [];
  hideTooltip();
  for (const node of Array.from(document.querySelectorAll('[data-jy-root]'))) node.remove();
  Object.defineProperty(window, 'getSelection', {
    configurable: true,
    writable: true,
    value: originalGetSelection,
  });
  vi.unstubAllGlobals();
});

describe('第一段：划词只出小气泡，一次请求都不发', () => {
  it('合法选区 + 真实手势：出 chip 档小气泡（提示语 + 「翻译」按钮），定位在选区下方，零请求', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate);
    mockSelection({ text: 'Hello world' });

    mouseup();
    await settle();

    expect(calls).toEqual([]);
    expect(variant()).toBe('chip');
    expectDot();
    // 定位：选区底（120+16）+ 间距 8。两档共用同一套定位数学，没有第二份。
    expect(bubble()?.style.top).toBe('144px');
    expect(bubble()?.style.left).toBe('340px');
    expect(bubble()?.parentElement).toBe(document.documentElement);
  });

  it('指针停在选区上不动（从未进入气泡）：始终零请求，气泡一直是 chip', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate, 30);
    mockSelection({ text: 'Hello world' });

    mouseup();
    await settle();
    await wait(80);

    expect(calls).toEqual([]);
    expect(variant()).toBe('chip');
  });

  it('jsdom 式全 0 矩形也照常出小气泡（不崩、不静默）', async () => {
    const { translate } = autoTranslate();
    givenSelection(translate);
    mockSelection({ text: 'Zero rect', rect: { top: 0, left: 0, width: 0, height: 0 } });

    mouseup();
    await settle();
    expect(variant()).toBe('chip');
    expectDot();
  });

  it('超长选区（>2000）连小气泡都不出', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate);
    mockSelection({ text: 'x'.repeat(2001) });

    mouseup();
    await settle();
    expect(calls).toEqual([]);
    expect(bubble()).toBeNull();
  });

  it('无选区 / 空白选区不触发', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate);

    mockSelection(null);
    mouseup();
    await settle();
    mockSelection({ text: '   \n  ' });
    mouseup();
    await settle();
    expect(calls).toEqual([]);
    expect(bubble()).toBeNull();
  });

  it('右键（button=2）的 mouseup 不触发——上下文菜单走菜单消息那条路径', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate);
    mockSelection({ text: 'Hello world' });

    mouseup(2);
    await settle();
    expect(calls).toEqual([]);
    expect(bubble()).toBeNull();
  });

  it('选区起点在插件自己的浮层里：不触发（否则气泡里的译文会被反复回译）', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate);
    showTooltip({ top: 10, left: 10, width: 5, height: 5 }, { text: '已有气泡' });
    const anchor = bubble() as HTMLElement;
    mockSelection({ text: '已有气泡', anchor });

    mouseup();
    await settle();
    expect(calls).toEqual([]);
    expect(bubbleText()).toBe('已有气泡'); // 旧气泡内容未被替换
  });
});

describe('第二段：停在气泡上、或点「翻译」，才发那一次请求', () => {
  it('指针停上小气泡满延时：恰好一次请求，送出的是选区原文，气泡转成 pending → 译文', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate, 30);
    mockSelection({ text: 'Hello world' });

    mouseup();
    await settle();
    expect(calls).toEqual([]);

    hoverChip();
    await wait(15);
    expect(calls).toEqual([]); // 30ms 还没到
    await wait(20);
    expect(calls).toEqual(['Hello world']);
    expect(bubbleText()).toBe('译文:Hello world');
    expect(variant()).toBe('bubble');
    expect(buttonLabels()).toEqual(['复制']);
  });

  it('点小气泡（icon-only 圆点）：同样一次请求（纯悬停对键盘用户是死路，这是确定入口）', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate, 10_000); // 指针一次都没进来：只有点击这一条路
    mockSelection({ text: 'Hello world' });

    mouseup();
    await settle();
    clickButton('翻译');
    await settle();

    expect(calls).toEqual(['Hello world']);
    expect(bubbleText()).toBe('译文:Hello world');
  });

  it('快速划过：进入又马上离开 ⇒ 取消，到点也不发（与悬停翻译同一套先例）', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate, 30);
    mockSelection({ text: 'Hello world' });

    mouseup();
    await settle();
    hoverChip();
    await wait(15);
    leaveChip();
    await wait(80);

    expect(calls).toEqual([]);
    expect(variant()).toBe('chip');
  });

  it('关闭 chip（点外部）之后到点也不补发：计时器必须随气泡一起作废', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate, 30);
    mockSelection({ text: 'Hello world' });

    mouseup();
    await settle();
    hoverChip();
    await wait(10);
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(bubble()).toBeNull();

    await wait(80);
    expect(calls).toEqual([]);
  });

  it('页面还原 reset() 作废未到点的停留：计时器照样到点，但这一次不算数', async () => {
    const { translate, calls } = autoTranslate();
    const controller = givenSelection(translate, 30);
    mockSelection({ text: 'Hello world' });

    mouseup();
    await settle();
    hoverChip();
    controller.reset(); // 不关气泡，只推进世代
    await wait(80);

    expect(calls).toEqual([]);
  });

  it('换一次划词就把上一代的停留作废：只有最后划的那段会被翻出来', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate, 30);

    mockSelection({ text: 'First text' });
    mouseup();
    await settle();
    hoverChip();
    await wait(10);

    mockSelection({ text: 'Second text' });
    mouseup(); // 新的小气泡替掉旧的，同一份意图也跟着换
    await settle();
    hoverChip();
    await wait(80);

    expect(calls).toEqual(['Second text']);
    expect(bubbleText()).toBe('译文:Second text');
  });

  it('生产默认停留是 150ms：差 1ms 不算"停住"（测试用的 0 掩盖不了它）', async () => {
    vi.useFakeTimers();
    try {
      const { translate, calls } = autoTranslate();
      const controller = createSelectionTranslator({ translate }); // 不传 hoverDelayMs
      controller.enable();
      mockSelection({ text: 'Hello world' });

      mouseup();
      await vi.advanceTimersByTimeAsync(0);
      hoverChip();
      await vi.advanceTimersByTimeAsync(149);
      expect(calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toEqual(['Hello world']);

      controller.disable();
    } finally {
      vi.useRealTimers();
    }
  });

  it('译文出来之后再进进出出：不会再来第二次请求', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate, 30);
    mockSelection({ text: 'Hello world' });

    mouseup();
    await settle();
    hoverChip();
    await wait(80);
    expect(calls).toEqual(['Hello world']);

    hoverChip();
    await wait(80);
    leaveChip();
    await wait(80);
    expect(calls).toEqual(['Hello world']);
  });

  it('移开指针后译文保留（与悬停翻译「移出保留译文」一致）', async () => {
    const { translate } = autoTranslate();
    givenSelection(translate);
    await selectAndTranslate('Hello world');
    expect(bubbleText()).toBe('译文:Hello world');

    leaveChip();
    await settle();
    expect(bubbleText()).toBe('译文:Hello world');
    expect(bubble()).not.toBeNull();
  });

  it('后台失败时气泡显示错误文案，不静默、不挂按钮', async () => {
    const translate = (): Promise<InlineTranslation> =>
      Promise.resolve({ ok: false, message: '无法连接后台：Receiving end does not exist.' });
    givenSelection(translate);
    mockSelection({ text: 'Hello world' });

    mouseup();
    await settle();
    hoverChip();
    await settle();
    expect(bubbleText()).toContain('无法连接后台');
    expect(bubbleState()).toBe('error');
    expect(buttonLabels()).toEqual([]);
  });

  it('在飞的划词：用户已把气泡关掉（点外部）后，迟到的译文不许把它弹回来', async () => {
    const queued = queueTranslate();
    givenSelection(queued.translate);
    mockSelection({ text: 'Hello world' });

    mouseup();
    await settle();
    hoverChip();
    await settle();
    expect(bubbleText()).toBe('翻译中…');

    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(bubble()).toBeNull();

    queued.resolveNext({ ok: true, text: '迟到的译文' });
    await settle();
    expect(bubble()).toBeNull();
  });

  it('更新的划词会作废旧请求：迟到的第一次结果不覆盖第二次的进行中', async () => {
    const queued = queueTranslate();
    givenSelection(queued.translate);

    await selectAndTranslate('First text');
    await selectAndTranslate('Second text');
    expect(bubbleText()).toBe('翻译中…');

    // 先兑现**第一次**划词的请求：它已经不是最新一代，结果必须被丢弃。
    queued.resolveNext({ ok: true, text: '第一次的迟到结果' });
    await settle();
    expect(bubbleText()).toBe('翻译中…');

    // 第二次兑现：这才是当前划词的结论。
    queued.resolveNext({ ok: true, text: '第二次的结果' });
    await settle();
    expect(bubbleText()).toBe('第二次的结果');
  });
});

/**
 * 真机实测逼出来的一组（`.qa/probe-click3.mjs` 的读数）：
 * 按下浮层里的按钮时，浏览器先派发 mouseup，而**页面上的选区还在**——旧逻辑把它当成
 * "又划了一次词"，于是重开一个小气泡、`renderBubble` 把刚被按下的那个按钮从文档里换掉。
 * Chrome 对"按下与抬起的目标已断开"的这一对**不再合成 click**：真机上按钮点不动，
 * 现场读数是"mousedown/mouseup 都到了按钮，click 永远不来、被按的节点 isConnected=false"。
 * jsdom 自己会把手发的 click 打进已脱离的节点，所以这条只能靠"节点还在不在文档里"来钉。
 */
describe('落在浮层里的 mouseup：不许把按下的按钮换掉（真机 click 的前提）', () => {
  function chipButton(label: string): HTMLButtonElement | undefined {
    return Array.from(bubble()?.shadowRoot?.querySelectorAll('button') ?? []).find((button) =>
      (button.getAttribute('aria-label') ?? button.textContent ?? '').startsWith(label),
    ) as HTMLButtonElement | undefined;
  }

  it('按下小气泡圆点：mouseup 那一刻按钮仍在文档里（Chrome 才会合成 click），且恰好一次请求', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate, 10_000); // 悬停那条路先不触发，只测按钮
    mockSelection({ text: 'Hello world' });
    mouseup();
    await settle();

    const { button, connectedAtMouseup } = pressButton('翻译');
    expect(button).toBeDefined();
    expect(connectedAtMouseup, '抬起那一刻被按下的按钮必须还挂在文档里').toBe(true);
    await settle();
    expect(calls).toEqual(['Hello world']);
    expect(bubbleText()).toBe('译文:Hello world');
  });

  it('成对断言：同一现场，落在**页面**上的 mouseup 照样重开小气泡（换掉旧按钮）——上一条不是"什么都没发生"', async () => {
    const { translate } = autoTranslate();
    givenSelection(translate, 10_000);
    mockSelection({ text: 'Hello world' });
    mouseup();
    await settle();

    const button = chipButton('翻译');
    mouseup(); // 落在页面（document.body）上：这是"又划了一次词"的形状
    await settle();
    expect(button?.isConnected).toBe(false);
  });

  it('按下译文气泡里的「复制」：按钮仍在文档里，就地变文案（既有 bug 的同一条修复）', async () => {
    const { translate } = autoTranslate();
    givenSelection(translate);
    await selectAndTranslate('Hello world');

    const { button, connectedAtMouseup } = pressButton('复制');
    expect(button).toBeDefined();
    expect(connectedAtMouseup, '抬起那一刻复制按钮必须还挂在文档里').toBe(true);
    await settle();
    // jsdom 的 navigator 没有 clipboard——正是"回调真的跑了"的证据。
    expect(button?.textContent).toBe('复制不可用');
  });

  it('落在浮层里的 mouseup 不算一次新划词：不换世代、不重开、不多发请求', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate, 10_000);
    mockSelection({ text: 'Hello world' });
    mouseup();
    await settle();

    const { connectedAtMouseup } = pressButton('翻译');
    expect(connectedAtMouseup).toBe(true);
    await settle();
    expect(calls).toEqual(['Hello world']);

    // 气泡已经是译文那一屏：再按浮层里的按钮也不该有第二次请求。
    pressButton('复制');
    await settle();
    expect(calls).toEqual(['Hello world']);
  });
});

/**
 * 译文现在可以被框选去复制（.jy-text 的 user-select:text），于是多出一条以前不存在的路径：
 * 划中气泡里的译文 → mouseup → 又把译文发去翻译一次（自翻译循环，还要白烧用户付费的额度）。
 *
 * 两种选区形状都要挡住：① 浏览器把 shadow 里的选区**重定位**到宿主上（Chrome 的做法，
 * 边上那个既有用例钉的就是它）；② 端点仍指向 shadow 内部的节点——`closest()` 不跨 shadow
 * 边界，这时它一个 `data-jy-root` 也找不到，得靠 `getRootNode()` 摸到宿主。
 */
describe('气泡内选中译文：零请求（自翻译循环的口子）', () => {
  function openBubble(): Text {
    showTooltip({ top: 10, left: 10, width: 5, height: 5 }, { text: '已有气泡译文' });
    const node = bubble()?.shadowRoot?.querySelector('.jy-text')?.firstChild;
    if (!(node instanceof Text)) throw new Error('气泡里没有译文文本节点');
    return node;
  }

  it('选区端点落在气泡 Shadow DOM 内部的 .jy-text 上：零请求、气泡不被替换', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate);
    const textNode = openBubble();

    mockSelection({ text: '已有气泡译文', anchor: textNode });
    mouseup();
    await settle();
    expect(calls).toEqual([]);
    expect(bubbleText()).toBe('已有气泡译文');
  });

  it('锚点在正文、焦点端落在气泡里：同样零请求（anchor/focus 两端都判）', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate);
    const textNode = openBubble();

    mockSelection({
      text: 'Some page text 已有气泡译文',
      anchor: document.getElementById('page'),
      focus: textNode,
    });
    mouseup();
    await settle();
    expect(calls).toEqual([]);
  });

  it('成对断言：同一现场把锚点换成页面正文 → 两段照常走通（否则上面两条只是「永远拒绝」的假通过）', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate);
    openBubble();

    mockSelection({ text: 'Some page text', anchor: document.getElementById('page') });
    mouseup();
    await settle();
    expect(calls).toEqual([]); // 第一段：此刻还只是小气泡
    hoverChip();
    await settle();
    expect(calls).toEqual(['Some page text']);
  });
});

describe('安全闸门：只响应真实用户手势（isTrusted）', () => {
  it('合成 mouseup（isTrusted=false）即便选区有效也零请求、不出气泡', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate);
    mockSelection({ text: 'Hello world' });

    syntheticMouseup();
    await settle();
    expect(calls).toEqual([]);
    expect(bubble()).toBeNull();
  });

  it('成对断言：同一现场把 isTrusted 伪造成 true → 两段照常走通（证明上一条不是「永远拒绝」的假通过）', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate);
    mockSelection({ text: 'Hello world' });

    mouseup();
    await settle();
    expect(bubble()).not.toBeNull();
    hoverChip();
    await settle();
    expect(calls).toEqual(['Hello world']);
    expect(bubbleText()).toBe('译文:Hello world');
  });
});

/**
 * 安全闸门：浮层里的按钮只认真实手势。
 *
 * 浮层是 **open** shadow DOM，页面脚本摸得到宿主，也就能替用户把「翻译」/「复制」点下去。
 * 「翻译」那条会把文本带着用户的 Key 送去用户自己付费的引擎，「复制」那条会写剪贴板——
 * 与 mouseup、pointerenter 同一类路径，就该同一类答案。委托层把门（一处一套答案），
 * 所以 `TooltipButton` 的回调契约不用改。
 */
describe('安全闸门：浮层里的按钮只认真实 click', () => {
  it('合成 click 点圆点：零请求，气泡还停在待触发那一屏', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate, 10_000);
    mockSelection({ text: 'Hello world' });
    mouseup();
    await settle();

    syntheticClickButton('翻译');
    await settle();
    expect(calls).toEqual([]);
    expect(variant()).toBe('chip');
    expectDot();
  });

  it('成对断言：同一现场把 click 换成真实手势 → 照常翻（证明上一条不是"永远拒绝"）', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate, 10_000);
    mockSelection({ text: 'Hello world' });
    mouseup();
    await settle();

    clickButton('翻译');
    await settle();
    expect(calls).toEqual(['Hello world']);
  });

  it('合成 click 点「复制」：不写剪贴板、按钮文案不动', async () => {
    const writeText = vi.fn(async () => undefined);
    mockClipboard(writeText);
    const { translate } = autoTranslate();
    givenSelection(translate);
    await selectAndTranslate('Hello world');

    const button = syntheticClickButton('复制');
    await settle();
    expect(writeText).not.toHaveBeenCalled();
    expect(button?.textContent).toBe('复制');
  });

  it('成对断言：同一现场真实手势的 click → 剪贴板照常写入、文案就地改', async () => {
    const writeText = vi.fn(async () => undefined);
    mockClipboard(writeText);
    const { translate } = autoTranslate();
    givenSelection(translate);
    await selectAndTranslate('Hello world');

    const button = clickButton('复制');
    await settle();
    expect(writeText).toHaveBeenCalledWith('译文:Hello world');
    expect(button?.textContent).toBe('已复制');
  });
});

describe('安全闸门：划词不采集可编辑区域（与整页采集口径对齐）', () => {
  it('选区锚点在 contenteditable 草稿里 + 真实手势：零请求', async () => {
    document.body.innerHTML = '<div id="draft" contenteditable="true">Unsaved private draft</div>';
    const { translate, calls } = autoTranslate();
    givenSelection(translate);
    mockSelection({ text: 'Unsaved private draft', anchor: document.getElementById('draft') });

    mouseup();
    await settle();
    expect(calls).toEqual([]);
    expect(bubble()).toBeNull();
  });

  it('锚点在正文、焦点落在 contenteditable 里：同样零请求（anchor/focus 两端都判）', async () => {
    document.body.innerHTML =
      '<p id="page">Some page text</p><div id="draft" contenteditable="true">Unsaved private draft</div>';
    const { translate, calls } = autoTranslate();
    givenSelection(translate);
    mockSelection({
      text: 'Some page text Unsaved private draft',
      anchor: document.getElementById('page'),
      focus: document.getElementById('draft'),
    });

    mouseup();
    await settle();
    expect(calls).toEqual([]);
  });

  it('可编辑性继承给后代：锚在草稿内部的普通 <p> 也算可编辑区域', async () => {
    document.body.innerHTML = '<div contenteditable="true"><p id="inner">Draft nested paragraph text</p></div>';
    const { translate, calls } = autoTranslate();
    givenSelection(translate);
    mockSelection({ text: 'Draft nested paragraph text', anchor: document.getElementById('inner') });

    mouseup();
    await settle();
    expect(calls).toEqual([]);
  });

  it('成对断言：同一页面里选普通文本 + 真实手势 → 两段照常走通（闸门没有把手势校验做过头）', async () => {
    document.body.innerHTML =
      '<p id="page">Regular page sentence</p><div id="draft" contenteditable="true">Unsaved private draft</div>';
    const { translate, calls } = autoTranslate();
    givenSelection(translate);
    mockSelection({
      text: 'Regular page sentence',
      anchor: document.getElementById('page'),
      focus: document.getElementById('page'),
    });

    mouseup();
    await settle();
    hoverChip();
    await settle();
    expect(calls).toEqual(['Regular page sentence']);
    expect(bubbleText()).toBe('译文:Regular page sentence');
  });
});

describe('译文气泡的「复制」按钮', () => {
  it('「复制」把**译文**写入剪贴板，按钮就地变文案', async () => {
    const writeText = vi.fn(async () => undefined);
    mockClipboard(writeText);
    const { translate } = autoTranslate();
    givenSelection(translate);
    await selectAndTranslate('Hello world');

    const button = clickButton('复制');
    await settle();
    expect(writeText).toHaveBeenCalledWith('译文:Hello world');
    expect(button?.textContent).toBe('已复制');
  });

  it('剪贴板拒绝时如实标「复制失败」', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    mockClipboard(writeText);
    const { translate } = autoTranslate();
    givenSelection(translate);
    await selectAndTranslate('Hello world');

    const button = clickButton('复制');
    await settle();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(button?.textContent).toBe('复制失败');
  });

  it('没有 clipboard 通道（非安全上下文）时不崩，也不假装成功', async () => {
    const { translate } = autoTranslate();
    givenSelection(translate);
    await selectAndTranslate('Hello world');

    // jsdom 的 navigator 没有 clipboard——正是这条降级路径的真实环境。
    const button = clickButton('复制');
    await settle();
    expect(button?.textContent).toBe('复制不可用');
  });
});

describe('右键菜单路径（MSG.TRANSLATE_SELECTION 的入口）', () => {
  it('菜单是用户逐次明确的动作：不经过小气泡，当场发请求', async () => {
    const { translate, calls } = autoTranslate();
    const controller = givenSelection(translate, 10_000); // 没有任何指针停留
    mockSelection({ text: 'Live selection' });

    controller.translateFromMenu('Payload text');
    await settle();
    expect(calls).toEqual(['Live selection']);
    expect(bubble()?.style.top).toBe('144px'); // 选区矩形下方
    expect(variant()).toBe('bubble'); // 不是待触发的 chip
    expect(bubbleText()).toBe('译文:Live selection');
  });

  it('读不到选区：用 payload 文本兜底，气泡定位视口中央', async () => {
    const { translate, calls } = autoTranslate();
    const controller = givenSelection(translate);
    mockSelection(null);

    controller.translateFromMenu('Menu text');
    await settle();
    expect(calls).toEqual(['Menu text']);
    // jsdom 视口 1024×768：中心 (512, 384) + 下方间距 8。
    expect(bubble()?.style.left).toBe('512px');
    expect(bubble()?.style.top).toBe('392px');
  });

  it('选区和 payload 都没有：不请求、不出气泡', async () => {
    const { translate, calls } = autoTranslate();
    const controller = givenSelection(translate);
    mockSelection(null);

    controller.translateFromMenu(undefined);
    controller.translateFromMenu('   ');
    await settle();
    expect(calls).toEqual([]);
    expect(bubble()).toBeNull();
  });

  it('菜单路径不受 mouseup 开关管辖：disable 后显式点菜单仍生效', async () => {
    const { translate, calls } = autoTranslate();
    const controller = givenSelection(translate);
    mockSelection(null);

    controller.disable();
    controller.translateFromMenu('Menu text');
    await settle();
    expect(calls).toEqual(['Menu text']);
  });
});

describe('开关与生命周期', () => {
  it('没 enable 完全不响应；enable 后响应；disable 后又回到不响应（selectionTranslate 的三态）', async () => {
    mockSelection({ text: 'Hello world' });

    const never = autoTranslate();
    createSelectionTranslator({ translate: never.translate }); // 不 enable
    mouseup();
    await settle();
    expect(never.calls).toEqual([]);

    const on = autoTranslate();
    const controller = givenSelection(on.translate);
    await selectAndTranslate('Hello world');
    expect(on.calls).toEqual(['Hello world']);

    controller.disable();
    const off = autoTranslate();
    const offController = createSelectionTranslator({ translate: off.translate });
    offController.enable();
    offController.disable();
    mouseup();
    await settle();
    expect(off.calls).toEqual([]);
  });

  it('disable 把小气泡一起收掉：开关关掉之后页面上不留浮层', async () => {
    const { translate } = autoTranslate();
    const controller = givenSelection(translate);
    mockSelection({ text: 'Hello world' });
    mouseup();
    await settle();
    expect(bubble()).not.toBeNull();

    controller.disable();
    expect(bubble()).toBeNull();
  });

  it('触发一轮划词前后，body.innerHTML 逐字节不变（浮层挂 documentElement）', async () => {
    const { translate } = autoTranslate();
    givenSelection(translate);
    const before = document.body.innerHTML;

    await selectAndTranslate('Hello world');
    clickButton('复制'); // 未打桩的 clipboard → 「复制不可用」，但不崩
    await settle();

    expect(bubble()).not.toBeNull();
    expect(document.body.innerHTML).toBe(before);
    expect(bubble()?.parentElement).toBe(document.documentElement);
  });
});
