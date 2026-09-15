/**
 * @vitest-environment jsdom
 *
 * 悬停/划词与内容脚本编排（index.ts）的接线测试（WU·Plan 2）：
 * 设置读取 → 挂/摘监听、后台消息链路（`TRANSLATE_TEXTS`）、右键菜单消息、
 * `APPLY_SETTINGS` 的即时生效、还原时的浮层清理，以及本单元的验收重点——
 * **布局不变式**（一切浮层都挂在 documentElement 上，body 逐字节不动）。
 *
 * 用例间的隔离：每个用例 `vi.resetModules()` 后重新 import 内容脚本，**上一份模块实例
 * 的事件监听器还挂在共享的 window/document 上**（DOM 监听器不受模块重置影响），
 * 所以下面前置步骤是先通过当前 contentListener 发一条 `APPLY_SETTINGS(false,false)`
 * 把这一例的监听器摘掉（afterEach），否则下一例会收到两份请求。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';
import { MSG } from '../../src/shared/messages';
import { SETTINGS_KEY } from '../../src/shared/settings';

type MessageListener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | undefined;
type SentMessage = { type: string; payload: { items: Array<{ id: string; text: string }>; targetLang?: string } };

const originalGetSelection = window.getSelection;

let chromeStub: ChromeStub;
let contentListener: MessageListener | undefined;

function mount(html: string): void {
  document.body.innerHTML = html;
}

async function loadContentScript(): Promise<{ worker: MockInstance<MessageListener> }> {
  await import('../../src/content/index');
  const listener = chromeStub.runtime.onMessage.listeners()[0];
  if (listener === undefined) throw new Error('内容脚本没有注册 onMessage 监听器');
  contentListener = listener;
  const worker = vi.fn<MessageListener>(() => undefined);
  chromeStub.runtime.onMessage.addListener(worker);
  return { worker };
}

function isTranslateRequest(message: unknown): boolean {
  return (message as { type?: string } | null)?.type === MSG.TRANSLATE_TEXTS;
}

function asTranslateRequest(message: unknown): SentMessage {
  return message as SentMessage;
}

function autoReply(): MessageListener {
  return (message, _sender, sendResponse) => {
    if (!isTranslateRequest(message)) return false;
    const { items } = asTranslateRequest(message).payload;
    sendResponse({
      ok: true,
      results: items.map((item) => ({ id: item.id, text: `译:${item.text}` })),
    });
    return true;
  };
}

/** 直接把消息投给内容脚本自己的监听器（真机上这就是 tabs.sendMessage 的接收端）。 */
function dispatch(type: string, payload?: unknown): Promise<unknown> {
  if (contentListener === undefined) throw new Error('还没有加载内容脚本');
  let settleResponse: ((response: unknown) => void) | undefined;
  const response = new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => resolve('NO_RESPONSE'), 1000);
    settleResponse = (incoming: unknown) => {
      clearTimeout(timer);
      resolve(incoming);
    };
  });
  contentListener(
    payload === undefined ? { type } : { type, payload },
    { id: 'jinyi-test' },
    (incoming?: unknown) => settleResponse?.(incoming),
  );
  return response;
}

async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 悬停默认延时 180ms + 微任务链：真实时间等一轮。 */
async function afterHoverDelay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 260));
}

function translateRequests(worker: MockInstance<MessageListener>): SentMessage[] {
  return worker.mock.calls
    .map(([message]) => message as SentMessage)
    .filter((message) => isTranslateRequest(message));
}

function sentTexts(worker: MockInstance<MessageListener>): string[][] {
  return translateRequests(worker).map((message) => message.payload.items.map((item) => item.text));
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

function mockSelection(text: string | null): void {
  Object.defineProperty(window, 'getSelection', {
    configurable: true,
    writable: true,
    value:
      text === null
        ? () => null
        : () => ({
            rangeCount: text === '' ? 0 : 1,
            toString: () => text,
            anchorNode: document.body,
            getRangeAt: () => ({
              getBoundingClientRect: () => ({ top: 120, left: 340, width: 100, height: 16 }),
            }),
          }),
  });
}

function mouseup(): void {
  document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
}

function pressShift(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
}

function enter(id: string): void {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`没有 #${id}`);
  node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
}

async function seedSettings(patch: Record<string, unknown>): Promise<void> {
  await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: 2, ...patch } });
}

/**
 * 通过当前 contentListener 把两个开关关掉：摘掉本例内容脚本挂在 window/document 上的
 * 监听器。放在独立函数里而不是内联调用——内联处若先有 `contentListener = undefined`
 * 赋值，TS 会把它收窄成 undefined，后面的调用就"编译不过"了（运行时其实是监听器）。
 */
function disableCurrentContentScript(): void {
  if (contentListener === undefined) return;
  contentListener(
    { type: MSG.APPLY_SETTINGS, payload: { hoverTranslate: false, selectionTranslate: false } },
    { id: 'jinyi-test' },
    () => undefined,
  );
}

beforeEach(() => {
  document.body.innerHTML = '';
  for (const node of Array.from(document.querySelectorAll('[data-jy-root]'))) node.remove();
  mockSelection(null);
  vi.resetModules();
  chromeStub = installChromeStub();
  contentListener = undefined;
});

afterEach(() => {
  disableCurrentContentScript();
  for (const node of Array.from(document.querySelectorAll('[data-jy-root]'))) node.remove();
  Object.defineProperty(window, 'getSelection', {
    configurable: true,
    writable: true,
    value: originalGetSelection,
  });
  vi.useRealTimers();
});

describe('接线：设置决定监听器', () => {
  it('默认设置（两个开关都是 true）：划词 mouseup 走后台请求，译文出现在浮层里', async () => {
    mount('<p>Hello world</p>');
    const { worker } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await settle(); // 等启动时那一次设置读取完成（挂监听）

    mockSelection('Hello world');
    mouseup();
    await settle();

    expect(sentTexts(worker)).toEqual([['Hello world']]);
    // targetLang 故意不传：后台当场读设置，永远是最新的那个（内容脚本手里不缓存密钥语言）。
    expect(translateRequests(worker)[0]?.payload.targetLang).toBeUndefined();
    expect(bubbleText()).toBe('译:Hello world');
    expect(bubble()?.parentElement).toBe(document.documentElement);
    expect(document.body.innerHTML).toBe('<p>Hello world</p>');
  });

  it('默认设置：Shift + 悬停段落同样挂着监听（到点发请求，描边出现）', async () => {
    mount('<article><p id="one">First paragraph</p></article>');
    const { worker } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await settle();

    pressShift();
    enter('one');
    await afterHoverDelay();

    expect(sentTexts(worker)).toEqual([['First paragraph']]);
    expect(bubbleText()).toBe('译:First paragraph');
    expect(highlightHost()).not.toBeNull();
  });

  it('两个开关都 false：不挂任何监听，划词与悬停全都无响应', async () => {
    await seedSettings({ hoverTranslate: false, selectionTranslate: false });
    mount('<article><p id="one">First paragraph</p></article>');
    const { worker } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await settle();

    pressShift();
    enter('one');
    await afterHoverDelay();
    mockSelection('Hello world');
    mouseup();
    await settle();

    expect(sentTexts(worker)).toEqual([]);
    expect(bubble()).toBeNull();
    expect(highlightHost()).toBeNull();
  });

  it('APPLY_SETTINGS 即时生效：false 的页面被推 true 后监听立刻可用，推回 false 立刻失效', async () => {
    await seedSettings({ hoverTranslate: false, selectionTranslate: false });
    mount('<article><p id="one">First paragraph</p></article>');
    const { worker } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await settle();

    const off = await dispatch(MSG.APPLY_SETTINGS, { hoverTranslate: true, selectionTranslate: true, targetLang: 'ja' });
    expect(off).toEqual({ ok: true });

    mockSelection('Hello world');
    mouseup();
    await settle();
    expect(sentTexts(worker)).toEqual([['Hello world']]);

    await dispatch(MSG.APPLY_SETTINGS, { hoverTranslate: false, selectionTranslate: false });
    mouseup();
    pressShift();
    enter('one');
    await afterHoverDelay();
    // 请求数没有增加：监听器已经摘掉（当前页面上的开关真的停了）。
    expect(sentTexts(worker)).toEqual([['Hello world']]);
    expect(bubble()).toBeNull();
  });

  it('APPLY_SETTINGS 只带一半字段：缺的那项按现状保持，不当 false 处理', async () => {
    await seedSettings({ hoverTranslate: false, selectionTranslate: false });
    mount('<article><p id="one">First paragraph</p></article>');
    const { worker } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await settle();

    await dispatch(MSG.APPLY_SETTINGS, { selectionTranslate: true }); // 没带 hoverTranslate
    mockSelection('Hello world');
    mouseup();
    await settle();
    expect(sentTexts(worker)).toEqual([['Hello world']]); // 划词这一项开成功了

    // 悬停那项没带 → 按现状仍是 false：即便按住 Shift 进入段落也不该有第三次请求。
    pressShift();
    enter('one');
    await afterHoverDelay();
    expect(sentTexts(worker)).toEqual([['Hello world']]);
  });
});

describe('接线：右键菜单与还原', () => {
  it('TRANSLATE_SELECTION：接管并回执；读不到选区时用 payload 文本兜底、视口中央出气泡', async () => {
    mount('<p>Hello world</p>');
    const { worker } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await settle();
    mockSelection(null);

    const response = dispatch(MSG.TRANSLATE_SELECTION, { text: 'Hello world' });
    await settle();
    expect(await response).toEqual({ ok: true });
    expect(sentTexts(worker)).toEqual([['Hello world']]);
    expect(bubbleText()).toBe('译:Hello world');
    // 视口中央兜底：jsdom 1024×768 → 中心 (512, 384) + 下间距 8。
    expect(bubble()?.style.left).toBe('512px');
    expect(bubble()?.style.top).toBe('392px');
    expect(document.body.innerHTML).toBe('<p>Hello world</p>');
  });

  it('TRANSLATE_SELECTION：选区优先于 payload（菜单点的是刚划的那段）', async () => {
    mount('<p>Hello world</p>');
    const { worker } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await settle();
    mockSelection('Live selection');

    await dispatch(MSG.TRANSLATE_SELECTION, { text: 'Stale payload' });
    await settle();
    expect(sentTexts(worker)).toEqual([['Live selection']]);
  });

  it('restorePage：关掉气泡浮层、撤掉悬停描边', async () => {
    mount('<article><p id="one">First paragraph</p></article>');
    const { worker } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await settle();

    pressShift();
    enter('one');
    await afterHoverDelay();
    expect(bubble()).not.toBeNull();
    expect(highlightHost()).not.toBeNull();

    const state = await dispatch(MSG.RESTORE_PAGE);
    expect(state).toMatchObject({ translated: false });
    expect(bubble()).toBeNull();
    expect(highlightHost()).toBeNull();
  });

  it('还原之后在飞的划词结果被丢弃：不许把气泡弹回来', async () => {
    mount('<p>Hello world</p>');
    const { worker } = await loadContentScript();
    const queued: (() => void)[] = [];
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = asTranslateRequest(message).payload;
      queued.push(() =>
        sendResponse({ ok: true, results: items.map((item) => ({ id: item.id, text: `译:${item.text}` })) }),
      );
      return true; // 全部挂起：还原之后才放行，验证迟到的结果被丢弃
    });
    await settle();

    mockSelection('Hello world');
    mouseup();
    await settle();
    expect(bubbleText()).toBe('翻译中…');

    await dispatch(MSG.RESTORE_PAGE);
    expect(bubble()).toBeNull();
    queued.forEach((release) => release());
    await settle();
    expect(bubble()).toBeNull();
  });
});

describe('接线：与整页翻译共存', () => {
  it('整页翻译在飞时，划词照常可用（独立浮层、互不干扰）', async () => {
    await seedSettings({ maxSegmentsPerBatch: 1, concurrency: 1 });
    mount('<p id="slow">Slow page paragraph</p><p id="hover">Hover target text</p>');
    const { worker } = await loadContentScript();
    let releasePageBatch: (() => void) | undefined;
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = asTranslateRequest(message).payload;
      const results = items.map((item) => ({ id: item.id, text: `译:${item.text}` }));
      if (items.some((item) => item.text === 'Slow page paragraph')) {
        releasePageBatch = () => sendResponse({ ok: true, results });
        return true; // 挂住页面那一批
      }
      sendResponse({ ok: true, results }); // 划词/悬停这一批立刻回
      return true;
    });
    await settle();

    const pendingPage = dispatch(MSG.TRANSLATE_PAGE);
    await settle();
    expect(releasePageBatch).toBeDefined();

    mockSelection('Hover target text');
    mouseup();
    await settle();

    // 页面那批还在飞，划词的气泡已经出了结果。
    expect(sentTexts(worker)).toEqual([['Slow page paragraph'], ['Hover target text']]);
    expect(bubbleText()).toBe('译:Hover target text');
    expect(bubble()?.parentElement).toBe(document.documentElement);

    releasePageBatch?.();
    const state = await pendingPage;
    expect(state).toMatchObject({ translated: true, done: 2 });
  });

  it('双语与仅译文两种显示模式下，悬停/划词浮层都与显示模式无关地工作', async () => {
    for (const displayMode of ['bilingual', 'translated-only'] as const) {
      vi.resetModules();
      document.body.innerHTML = '';
      chromeStub = installChromeStub();
      contentListener = undefined;
      await seedSettings({ displayMode });
      mount('<article><p id="one">First paragraph</p></article>');
      const { worker } = await loadContentScript();
      worker.mockImplementation(autoReply());
      await settle();

      // 悬停
      pressShift();
      enter('one');
      await afterHoverDelay();
      expect(sentTexts(worker), displayMode).toEqual([['First paragraph']]);
      expect(bubbleText(), displayMode).toBe('译:First paragraph');

      // 划词
      for (const node of Array.from(document.querySelectorAll('[data-jy-root]'))) node.remove();
      mockSelection('Hello world');
      mouseup();
      await settle();
      expect(sentTexts(worker), displayMode).toEqual([
        ['First paragraph'],
        ['Hello world'],
      ]);
      expect(bubbleText(), displayMode).toBe('译:Hello world');

      disableCurrentContentScript();
    }
  });
});

describe('验收重点：布局不变式', () => {
  it('悬停 + 划词全流程前后，document.body.innerHTML 逐字节不变', async () => {
    mount(
      [
        '<article>',
        '  <h1>Title text here</h1>',
        '  <p>Click <a href="/x">here</a> now</p>',
        '  <ul><li>Item text</li></ul>',
        '  <table><tbody><tr><td>Cell text</td></tr></tbody></table>',
        '  <p><button type="button">Do it</button></p>',
        '</article>',
      ].join('\n'),
    );
    const { worker } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await settle();
    const before = document.body.innerHTML;

    // 悬停一整个来回：进入、出结果、换段、离开、松 Shift。
    pressShift();
    const h1 = document.querySelector('h1') as HTMLElement;
    h1.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await afterHoverDelay();
    const li = document.querySelector('li') as HTMLElement;
    li.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await afterHoverDelay();
    document.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
    expect(bubbleText()).toContain('译:');

    // 划词一轮：出气泡、点复制。
    mockSelection('Copy me');
    mouseup();
    await settle();
    const copy = bubble()?.shadowRoot?.querySelector('button');
    copy?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await settle();

    // —— 以上全流程，body 一个字节都不动；一切痕迹只在 documentElement 上。
    expect(document.body.innerHTML).toBe(before);
    expect(document.querySelectorAll('body [data-jy-root], body [data-jy-id], body [data-jy-translated]')).toHaveLength(0);
    // 段落没有被打上任何 inline style。
    for (const node of Array.from(document.querySelectorAll('article, h1, p, li, td, button, a'))) {
      expect((node as HTMLElement).hasAttribute('style'), node.tagName).toBe(false);
    }
  });
});
