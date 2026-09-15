/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHoverTranslator, type HoverController } from '../../src/content/hover';
import { hideTooltip } from '../../src/content/tooltip';
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

function syntheticPressShift(): void {
  dispatchSynthetic(window, new KeyboardEvent('keydown', { key: 'Shift' }));
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
