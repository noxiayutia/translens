/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSelectionTranslator, type SelectionController } from '../../src/content/selection';
import { hideTooltip, showTooltip } from '../../src/content/tooltip';
import type { InlineTranslation } from '../../src/content/inline-types';

/**
 * 划词翻译气泡（selection.ts）。
 *
 * jsdom 没有可用的选区/剪贴板/语音设施：`window.getSelection` 按形状替身
 * （`getBoundingClientRect` 用可控假矩形——真 jsdom 下它返回全 0，另有专门的容忍用例），
 * `navigator.clipboard` / `speechSynthesis` 逐用例打桩、逐用例清干净。
 * 消息接线在 index 层，由 `inline-features.test.ts` 负责。
 */

type TranslateFn = (text: string) => Promise<InlineTranslation>;

const RECT = { top: 120, left: 340, width: 100, height: 16 };

const originalGetSelection = window.getSelection;
let live: SelectionController[] = [];

function mockSelection(value: { text: string; rect?: typeof RECT; anchor?: Node | null } | null): void {
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

function bubbleText(): string {
  return bubble()?.shadowRoot?.querySelector('.jy-text')?.textContent ?? '';
}

function buttonLabels(): string[] {
  const root = bubble()?.shadowRoot;
  if (root == null) return [];
  return Array.from(root.querySelectorAll('button')).map((button) => button.textContent ?? '');
}

function clickButton(labelPrefix: string): HTMLButtonElement | undefined {
  const root = bubble()?.shadowRoot;
  if (root == null) return undefined;
  const button = Array.from(root.querySelectorAll('button')).find(
    (candidate) => (candidate.textContent ?? '').startsWith(labelPrefix),
  );
  // composed:true 与真实 UI 事件一致——非合成事件不会穿过 shadow 边界，host 上的委托收不到。
  button?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  return button instanceof HTMLButtonElement ? button : undefined;
}

function mouseup(button = 0): void {
  document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button }));
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

function givenSelection(translate: TranslateFn, targetLang = 'zh-Hans'): SelectionController {
  const controller = createSelectionTranslator({ translate, targetLang: () => targetLang });
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
  delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
  delete (globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
});

describe('划词触发（mouseup 路径）', () => {
  it('选中 1~2000 字符：发一次请求，气泡出现在选区下方并带复制/朗读按钮', async () => {
    const { translate, calls } = autoTranslate();
    givenSelection(translate);
    mockSelection({ text: 'Hello world' });

    mouseup();
    await settle();

    expect(calls).toEqual(['Hello world']);
    expect(bubbleText()).toBe('译文:Hello world');
    expect(buttonLabels()).toEqual(['复制', '朗读']);
    // 定位：选区底（120+16）+ 间距 8。
    expect(bubble()?.style.top).toBe('144px');
    expect(bubble()?.style.left).toBe('340px');
    expect(bubble()?.parentElement).toBe(document.documentElement);
  });

  it('jsdom 式全 0 矩形也照常出气泡（不崩、不静默）', async () => {
    const { translate } = autoTranslate();
    givenSelection(translate);
    mockSelection({ text: 'Zero rect', rect: { top: 0, left: 0, width: 0, height: 0 } });

    mouseup();
    await settle();
    expect(bubbleText()).toBe('译文:Zero rect');
  });

  it('超长选区（>2000）不触发', async () => {
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

  it('后台失败时气泡显示错误文案，不静默、不挂按钮', async () => {
    const translate = (): Promise<InlineTranslation> =>
      Promise.resolve({ ok: false, message: '无法连接后台：Receiving end does not exist.' });
    givenSelection(translate);
    mockSelection({ text: 'Hello world' });

    mouseup();
    await settle();
    expect(bubbleText()).toContain('无法连接后台');
    expect(buttonLabels()).toEqual([]);
  });

  it('在飞的划词：用户已把气泡关掉（点外部）后，迟到的译文不许把它弹回来', async () => {
    const queued = queueTranslate();
    givenSelection(queued.translate);
    mockSelection({ text: 'Hello world' });

    mouseup();
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

    mockSelection({ text: 'First text' });
    mouseup();
    await settle();
    mockSelection({ text: 'Second text' });
    mouseup();
    await settle();
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

describe('气泡按钮', () => {
  async function openTranslatedBubble(): Promise<void> {
    const { translate } = autoTranslate();
    givenSelection(translate);
    mockSelection({ text: 'Hello world' });
    mouseup();
    await settle();
  }

  it('「复制」把**译文**写入剪贴板，按钮就地变文案', async () => {
    const writeText = vi.fn(async () => undefined);
    mockClipboard(writeText);
    await openTranslatedBubble();

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
    await openTranslatedBubble();

    const button = clickButton('复制');
    await settle();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(button?.textContent).toBe('复制失败');
  });

  it('没有 clipboard 通道（非安全上下文）时不崩，也不假装成功', async () => {
    await openTranslatedBubble();

    // jsdom 的 navigator 没有 clipboard——正是这条降级路径的真实环境。
    const button = clickButton('复制');
    await settle();
    expect(button?.textContent).toBe('复制不可用');
  });

  it('「朗读」用当前目标语言说译文', async () => {
    const spoken: { text: string; lang: string }[] = [];
    (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
      text: string;
      lang = '';
      constructor(text: string) {
        this.text = text;
      }
    };
    (window as unknown as { speechSynthesis: unknown }).speechSynthesis = {
      cancel: vi.fn(),
      speak: (utterance: { text: string; lang: string }) => {
        spoken.push({ text: utterance.text, lang: utterance.lang });
      },
    };
    await openTranslatedBubble();

    clickButton('朗读');
    expect(spoken).toEqual([{ text: '译文:Hello world', lang: 'zh-Hans' }]);
  });

  it('没有 speechSynthesis 通道时点击只是无操作，不抛异常', async () => {
    await openTranslatedBubble();
    expect(() => clickButton('朗读')).not.toThrow();
  });
});

describe('右键菜单路径（MSG.TRANSLATE_SELECTION 的入口）', () => {
  it('读得到选区：用选区文本与选区矩形定位，payload 只是兜底', async () => {
    const { translate, calls } = autoTranslate();
    const controller = givenSelection(translate);
    mockSelection({ text: 'Live selection' });

    controller.translateFromMenu('Payload text');
    await settle();
    expect(calls).toEqual(['Live selection']);
    expect(bubble()?.style.top).toBe('144px'); // 选区矩形下方
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
    createSelectionTranslator({ translate: never.translate, targetLang: () => 'zh-Hans' }); // 不 enable
    mouseup();
    await settle();
    expect(never.calls).toEqual([]);

    const on = autoTranslate();
    const controller = givenSelection(on.translate);
    mouseup();
    await settle();
    expect(on.calls).toEqual(['Hello world']);

    controller.disable();
    const off = autoTranslate();
    const offController = createSelectionTranslator({ translate: off.translate, targetLang: () => 'zh-Hans' });
    offController.enable();
    offController.disable();
    mouseup();
    await settle();
    expect(off.calls).toEqual([]);
  });

  it('触发一轮划词前后，body.innerHTML 逐字节不变（浮层挂 documentElement）', async () => {
    const { translate } = autoTranslate();
    givenSelection(translate);
    mockSelection({ text: 'Hello world' });
    const before = document.body.innerHTML;

    mouseup();
    await settle();
    clickButton('复制'); // 未打桩的 clipboard → 「复制不可用」，但不崩
    await settle();

    expect(bubble()).not.toBeNull();
    expect(document.body.innerHTML).toBe(before);
    expect(bubble()?.parentElement).toBe(document.documentElement);
  });
});
