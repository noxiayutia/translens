/**
 * @vitest-environment jsdom
 *
 * 增量翻译（observer.ts）的行为测试。
 *
 * 对端替身与消息链路沿用 `index.test.ts` 的做法：内容脚本 import 时注册监听器，
 * `chrome.runtime.sendMessage` 派发给测试自己挂的 worker。时间全部走假定时器
 * （防抖 500ms 的窗口不真等）；`toFake` 刻意**不含 queueMicrotask**——jsdom 的
 * MutationObserver 回调投递走原生微任务（`Promise.resolve().then`，见
 * jsdom/lib/jsdom/living/helpers/mutation-observers.js），把它一起伪造了
 * 「flush 观察者」就没法用 `advanceTimersByTimeAsync` 自然驱动。
 *
 * 「只扫新增子树」的复杂度断言靠的是把 extractor 的采集入口包成 spy（vi.mock）：
 * 调用**次数与实参**是最直接的证据，纯结果断言分不清"扫了三段"与"扫了整页后跳过"。
 */
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';
import { MSG, type TranslateItemResult } from '../../src/shared/messages';
import { INCREMENTAL_DEBOUNCE_MS, INCREMENTAL_MAX_SEGMENTS_PER_ROUND } from '../../src/content/observer';

vi.mock('../../src/content/extractor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/content/extractor')>();
  return {
    ...original,
    // 包一层而不是替身：测试要数真实采集的调用次数与实参，行为必须原样。
    collectSegments: vi.fn(original.collectSegments),
    collectSegmentsWithin: vi.fn(original.collectSegmentsWithin),
  };
});

type SentMessage = { type: string; payload: { items: Array<{ id: string; text: string }>; targetLang?: string } };
type SendResponse = (response?: unknown) => void;
type MessageListener = (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean | undefined;
type FakeWorker = MessageListener;
type ContentScript = typeof import('../../src/content/index');

let chromeStub: ChromeStub;

/**
 * 当前这份 extractor 模块实例上的 spy。
 * 每个用例都重新 import（resetModules 后 mock factory 重新求值），所以句柄要在
 * `loadContentScript` 里重新解析，不能拿文件顶部的静态 import。
 */
let fullPageCollect: MockInstance;
let subtreeCollect: MockInstance;

async function loadContentScript(): Promise<{
  module: ContentScript;
  worker: MockInstance<MessageListener>;
  contentListener: MessageListener;
}> {
  const module = await import('../../src/content/index');
  const extractor = await import('../../src/content/extractor');
  fullPageCollect = extractor.collectSegments as unknown as MockInstance;
  subtreeCollect = extractor.collectSegmentsWithin as unknown as MockInstance;

  const contentListener = chromeStub.runtime.onMessage.listeners()[0];
  if (contentListener === undefined) throw new Error('内容脚本没有注册 onMessage 监听器');
  const worker = vi.fn<MessageListener>(() => undefined);
  chromeStub.runtime.onMessage.addListener(worker);
  return { module, worker, contentListener };
}

function isTranslateRequest(message: unknown): boolean {
  return (message as { type?: string } | null)?.type === MSG.TRANSLATE_TEXTS;
}

function asTranslateRequest(message: unknown): SentMessage {
  const received = message as SentMessage;
  expect(received.type).toBe(MSG.TRANSLATE_TEXTS);
  expect(Array.isArray(received.payload.items)).toBe(true);
  return received;
}

async function dispatch(contentListener: MessageListener, type: string, payload?: unknown): Promise<unknown> {
  let responded = false;
  let settle: ((response: unknown) => void) | undefined;
  const response = new Promise<unknown>((resolve) => {
    settle = (incoming: unknown) => {
      resolve(incoming);
    };
  });
  const returned = contentListener(
    payload === undefined ? { type } : { type, payload },
    { id: 'jinyi-test' },
    (incoming?: unknown) => {
      if (responded) return;
      responded = true;
      settle?.(incoming);
    },
  );
  if (!responded && returned !== true) {
    throw new Error(`内容脚本没有接管 ${type}：既没有响应，也没有保持消息通道`);
  }
  // 内容脚本的响应全部由微任务驱动（存储/消息桩 promise）；假时钟不推进也不会饿死。
  return response;
}

function translateRequests(worker: MockInstance<MessageListener>): SentMessage[] {
  return worker.mock.calls.map(([message]) => message as SentMessage).filter((message) => isTranslateRequest(message));
}

function sentBatches(worker: MockInstance<MessageListener>): Array<Array<{ id: string; text: string }>> {
  return translateRequests(worker).map((message) => message.payload.items);
}

/** 到目前为止所有请求里出现过的原文（含批内顺序）。 */
function sentTexts(worker: MockInstance<MessageListener>): string[] {
  return sentBatches(worker).flat().map((item) => item.text);
}

function mount(html: string): void {
  document.body.innerHTML = html;
}

function hosts(): Element[] {
  return Array.from(document.querySelectorAll('jy-translation'));
}

function bodyTextOf(host: Element): string {
  return host.shadowRoot?.querySelector('.jy-body')?.textContent ?? '';
}

function hasRetryButton(host: Element): boolean {
  return host.shadowRoot?.querySelector('.jy-retry') !== null;
}

function findHostByText(fragment: string): Element | undefined {
  return hosts().find((host) => bodyTextOf(host).includes(fragment));
}

function clearToast(): void {
  for (const host of Array.from(document.querySelectorAll('[data-jy-root]'))) host.remove();
}

function translate(text: string): string {
  return `译:${text}`;
}

function autoReply(): FakeWorker {
  return (message, _sender, sendResponse) => {
    if (!isTranslateRequest(message)) return false;
    const { items } = asTranslateRequest(message).payload;
    sendResponse({ ok: true, results: items.map((item) => ({ id: item.id, text: translate(item.text) })) });
    return true;
  };
}

function asItemFailures(items: Array<{ id: string; text: string }>): TranslateItemResult[] {
  return items.map((item) => ({
    id: item.id,
    text: null,
    code: 'NETWORK' as const,
    message: `网络错误：${item.text}`,
  }));
}

/** 每 100 段生成一个稳定的独立文本，保证"同一文本只被请求一次"可核对。 */
function feedText(tag: string, i: number): string {
  return `${tag} item ${String(i).padStart(4, '0')} filler`;
}

function appendParagraph(text: string, parent: Element = document.body): HTMLElement {
  const p = document.createElement('p');
  p.textContent = text;
  parent.append(p);
  return p;
}

function appendMixedContainer(id: string, intro: string, bodyText: string): HTMLElement {
  const container = document.createElement('div');
  container.id = id;
  container.innerHTML = `${intro}<p>${bodyText}</p>`;
  document.body.append(container);
  return container;
}

/** 推过一整个防抖窗口（并顺带冲刷微任务：jsdom 的 MO 投递与响应链路都在微任务里）。 */
async function runDebounceWindow(extraMs = 1): Promise<void> {
  await vi.advanceTimersByTimeAsync(INCREMENTAL_DEBOUNCE_MS + extraMs);
}

/** 只冲刷微任务，不推进任何定时器。 */
async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function resetCounts(worker: MockInstance<MessageListener>): void {
  worker.mockClear();
  fullPageCollect.mockClear();
  subtreeCollect.mockClear();
}

beforeEach(async () => {
  document.body.innerHTML = '';
  clearToast();
  vi.resetModules();
  chromeStub = installChromeStub();
  // toFake 里不放 queueMicrotask / requestIdleCallback：MutationObserver 的投递是原生微任务。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('增量翻译：启用条件', () => {
  it('未翻译时页面变动：零请求、零扫描（观察者还没上岗）', async () => {
    mount('<article><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    // 注意：不发 TRANSLATE_PAGE，页面从未翻译。
    resetCounts(worker);

    appendParagraph('Untranslated addition one');
    appendParagraph('Untranslated addition two');
    for (let i = 0; i < 5; i += 1) await runDebounceWindow();

    expect(translateRequests(worker)).toHaveLength(0);
    expect(subtreeCollect).not.toHaveBeenCalled();
    expect(fullPageCollect).not.toHaveBeenCalled();
    expect(hosts()).toHaveLength(0);
    void contentListener;
  });

  it('已翻译：新增段落被增量翻译，请求里只有新文本，不重发旧段落', async () => {
    mount('<article><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    expect(findHostByText(translate('Hello world'))).toBeDefined();
    resetCounts(worker);

    appendParagraph('Fresh paragraph here');
    await runDebounceWindow();

    expect(sentTexts(worker)).toEqual(['Fresh paragraph here']);
    expect(bodyTextOf(findHostByText(translate('Fresh paragraph here')) as Element)).toBe(
      translate('Fresh paragraph here'),
    );
    // 只扫新增子树：一次针对新 p 的采集，整页采集绝不再跑。
    expect(subtreeCollect.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ textContent: 'Fresh paragraph here' }),
    ]);
    expect(fullPageCollect).not.toHaveBeenCalled();
  });

  it('还原之后 observer 停摆：再新增内容零请求，也没有残留宿主', async () => {
    mount('<article id="a"><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    const feed = document.getElementById('a') as HTMLElement;
    appendParagraph('Before restore text', feed);
    await runDebounceWindow();
    expect(sentTexts(worker)).toContain('Before restore text');

    await dispatch(contentListener, MSG.RESTORE_PAGE);
    expect(hosts()).toHaveLength(0);
    resetCounts(worker);

    appendParagraph('After restore text', feed);
    for (let i = 0; i < 5; i += 1) await runDebounceWindow();

    expect(translateRequests(worker)).toHaveLength(0);
    expect(subtreeCollect).not.toHaveBeenCalled();
    expect(hosts()).toHaveLength(0);
  });

  it('增量轮不卡 running：在飞时还原并重译照常工作，旧批次迟到也不补写', async () => {
    mount('<article id="a"><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE); // #1
    resetCounts(worker);

    // 从这起第一条翻译请求就是增量轮的那一条：挂住它。
    let heldRelease: (() => void) | undefined;
    let requestsAfterClear = 0;
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = asTranslateRequest(message).payload;
      requestsAfterClear += 1;
      const results = items.map((item) => ({ id: item.id, text: translate(item.text) }));
      if (requestsAfterClear === 1) {
        heldRelease = () => sendResponse({ ok: true, results });
        return true;
      }
      sendResponse({ ok: true, results });
      return true;
    });

    appendParagraph('Late arrival text', document.getElementById('a') as HTMLElement);
    await runDebounceWindow();
    expect(requestsAfterClear).toBe(1); // #2 增量轮（挂起）
    expect(bodyTextOf(findHostByText('翻译中…') as Element)).toContain('翻译中…');

    // 在飞期间还原 + 立即重译：running 必须没被增量轮卡住。
    await dispatch(contentListener, MSG.RESTORE_PAGE);
    await dispatch(contentListener, MSG.TRANSLATE_PAGE); // #3 整页重译（含 Late arrival）
    expect(requestsAfterClear).toBe(2);
    expect(hosts()).toHaveLength(2); // Hello + Late，各一个
    expect(findHostByText(translate('Late arrival text'))).toBeDefined();

    // 迟到的增量响应落地：renderer 身份对不上，整批作废——不得多出宿主或重复译文。
    heldRelease?.();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(hosts()).toHaveLength(2);
    expect(hosts().filter((host) => bodyTextOf(host) === translate('Late arrival text'))).toHaveLength(1);
  });
});

describe('增量翻译：自变更防护（不循环、不风暴）', () => {
  it('一轮增量翻译后反复 flush + 推防抖窗口：不产生第二轮扫描或请求', async () => {
    mount('<article><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    // 混合容器是最好的试金石：仅译文模式下它的写入 = 隐藏 span 插入 + 原文搬移 + 宿主插入，
    // 全是 childList 变动，自变更守卫漏掉任何一个都会在这里滚起来。
    appendMixedContainer('self-mut', 'Intro echo here', 'Nested echo body text');
    await runDebounceWindow();
    expect(sentTexts(worker)).toEqual(['Intro echo here', 'Nested echo body text']);
    const scans = subtreeCollect.mock.calls.length;
    const requests = translateRequests(worker).length;
    expect(scans).toBeGreaterThan(0);

    // 「立刻 flush 观察者」+ 多个防抖窗口：自变更若入队，这里必然出现第二轮。
    for (let i = 0; i < 5; i += 1) {
      await flushMicrotasks();
      await runDebounceWindow();
    }
    expect(subtreeCollect.mock.calls.length).toBe(scans);
    expect(translateRequests(worker).length).toBe(requests);
    expect(hosts().filter((host) => bodyTextOf(host) === translate('Intro echo here'))).toHaveLength(1);
    expect(hosts().filter((host) => bodyTextOf(host) === translate('Nested echo body text'))).toHaveLength(1);
  });

  it('双语模式（原文留在原地）同样不产生第二轮', async () => {
    await chromeStub.storage.local.set({ 'jinyi:settings': { version: 2, displayMode: 'bilingual' } });
    mount('<article><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    appendMixedContainer('self-mut-bi', 'Bilingual intro text', 'Bilingual nested body');
    await runDebounceWindow();
    const scans = subtreeCollect.mock.calls.length;
    const requests = translateRequests(worker).length;

    for (let i = 0; i < 5; i += 1) {
      await flushMicrotasks();
      await runDebounceWindow();
    }
    expect(subtreeCollect.mock.calls.length).toBe(scans);
    expect(translateRequests(worker).length).toBe(requests);
  });

  /**
   * 真正考验防护窗口的轮次：**观察者处于注册态时开轮**。
   *
   * 溢出补轮（finally 里重新排防抖的那一轮）启动时观察者还挂着，它自己的写入会真的
   * 进记录队列——只有轮内那道 `disconnect() + takeRecords()` 窗口能挡住。
   *
   * 别把这里理解成"回调投递时规范会顺带注销观察者，所以回调触发的轮次天然安全"：
   * 规范的投递算法只清空该观察者的记录队列、**不注销注册**（jsdom 的投递 helper 里
   * 那个 `filter(source !== mo)` 只对 `takeRecords` 之类的路径生效，对 `observe()`
   * 推入的条目是 no-op）。也就是说注册态开轮真的会自触发，这正是本条要防的东西。
   *
   * 删掉轮内的 disconnect/takeRecords（一起拆），这一条必须红：补轮挂载 4 段宿主的
   * childList 记录会投递给回调、滚成第三轮对自家宿主的无效扫描。
   */
  it('溢出补轮从注册态开轮：自写入被防护窗口挡下，不滚出下一轮扫描', async () => {
    mount('<article id="feed"><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);
    const feed = document.getElementById('feed') as HTMLElement;

    // 攒出「第一轮吃满上限 + 第二轮溢出」的形状——第二轮正是从注册态起步的那一轮。
    const total = INCREMENTAL_MAX_SEGMENTS_PER_ROUND + 4;
    for (let i = 0; i < total; i += 1) appendParagraph(feedText('overflow', i), feed);

    await runDebounceWindow(); // 第一轮：上限 60 段
    await runDebounceWindow(); // 第二轮：溢出的 4 段（注册态开轮）

    const scans = subtreeCollect.mock.calls.length;
    // 恰好两轮：60 个 root + 4 个 root。若补轮的自写入污染了队列，这里会多出扫自家宿主的轮次。
    expect(scans).toBe(total);
    expect(sentTexts(worker)).toHaveLength(total);

    for (let i = 0; i < 4; i += 1) {
      await flushMicrotasks();
      await runDebounceWindow();
    }
    expect(subtreeCollect.mock.calls.length).toBe(total);
    expect(sentTexts(worker)).toHaveLength(total);
  });
});

describe('增量翻译：扫描范围（只扫新增子树）', () => {
  it('大页面 + 3 段新增：采集次数与新增节点数一致，root 是新增元素且从不重扫整页', async () => {
    const bulk = Array.from({ length: 300 }, (_unused, i) => `<p>Bulk paragraph ${String(i).padStart(3, '0')} zz</p>`).join('');
    mount(`<article>${bulk}</article>`);
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    expect(hosts()).toHaveLength(300);
    resetCounts(worker);

    const added = [
      appendParagraph('Needle addition zero one'),
      appendParagraph('Needle addition zero two'),
      appendParagraph('Needle addition zero three'),
    ];
    await runDebounceWindow();

    // 调用次数 = 新增节点数（3），与页面既有 300 段无关。
    expect(subtreeCollect.mock.calls.length).toBe(3);
    const roots = new Set(subtreeCollect.mock.calls.map((call) => call[0]));
    expect(roots).toEqual(new Set(added));
    // 整页采集一个字都不重跑。
    expect(fullPageCollect).not.toHaveBeenCalled();
    expect(sentTexts(worker).sort()).toEqual(
      ['Needle addition zero one', 'Needle addition zero two', 'Needle addition zero three'].sort(),
    );
  });

  it('混合容器里新增块级子元素：改扫父容器（否则直接文本会被漏掉）', async () => {
    await chromeStub.storage.local.set({ 'jinyi:settings': { version: 2, displayMode: 'bilingual' } });
    mount('<div id="box">Standing intro text<p>Box body one text</p></div>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    const box = document.getElementById('box') as HTMLElement;
    appendParagraph('Box body two text', box);
    await runDebounceWindow();

    // root 是父容器（混合容器），不是新增的 p。
    expect(subtreeCollect.mock.calls.length).toBe(1);
    expect(subtreeCollect.mock.calls[0]?.[0]).toBe(box);
    // 只有新段落被请求：松散文本段「Standing intro text」被重采到但去重挡下。
    expect(sentTexts(worker)).toEqual(['Box body two text']);
  });

  it('混合容器裸文本节点追加：扫父容器，新松散文本被翻译', async () => {
    mount('<div id="box2"><p>Second box body one</p></div>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    const box = document.getElementById('box2') as HTMLElement;
    // SPA 往容器里追加一段直接文本（不是元素）。此时容器 = 直接文本 + 块级子元素 → 混合。
    const text = document.createTextNode('Loose addition text');
    const anchor = document.createElement('span'); // 让新增节点里也有一个元素，触发候选根解析
    anchor.append(text);
    box.append(anchor);
    await runDebounceWindow();
    // anchor 是行内元素：扫它自己（父不是混合容器），Loose addition text 随 anchor 成段。
    expect(sentTexts(worker)).toEqual(['Loose addition text']);
  });

  /**
   * 回归的是增量路径特有的一个绕过：extractor 的 `data-jy-translated` 短路只查元素**自身**，
   * 整页采集自顶向下走、祖先被短路等于整棵子树被短路；而增量是从子孙节点切入的，
   * 那道闸就被绕过了。实测过的形态：`<div>Hello <span>one</span> readers</div>` 整段译完之后
   * 往 `<span>` 里追加一个裸文本节点，扫父元素会得到一段**包含已译内容**的文本
   * （`"one two"`），于是旧词被再译一遍、并多挂一个宿主，与已有宿主并存。
   *
   * 这属于"改动了已译段落"，与"只管新增、不管改动"的既定范围一致：不重译、也不重复译。
   */
  it('往已译段落的行内后代追加裸文本：不把已译内容重新译一遍、不多挂宿主', async () => {
    await chromeStub.storage.local.set({ 'jinyi:settings': { version: 2, displayMode: 'bilingual' } });
    mount('<div id="mixed">Hello <span id="inner">one</span> readers</div>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    // 整段已经作为 "Hello one readers" 译完，#mixed 上带着 data-jy-translated。
    const hostsBefore = document.querySelectorAll('jy-translation').length;
    (document.getElementById('inner') as HTMLElement).append(document.createTextNode(' two'));
    await runDebounceWindow();

    // 不能再有任何一段文本把已译内容包进去。
    expect(sentTexts(worker).some((text) => text.includes('one'))).toBe(false);
    // 宿主数不增：一个段落不会多出第二个译文。
    expect(document.querySelectorAll('jy-translation')).toHaveLength(hostsBefore);
  });

  it('同一父容器被多次触发只扫一次（候选根去重）', async () => {
    await chromeStub.storage.local.set({ 'jinyi:settings': { version: 2, displayMode: 'bilingual' } });
    mount('<div id="box3">Third box intro text<p>Third box body one</p></div>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    const box = document.getElementById('box3') as HTMLElement;
    box.append(
      (() => {
        const a = document.createElement('p');
        a.textContent = 'Third box body two';
        return a;
      })(),
      (() => {
        const b = document.createElement('p');
        b.textContent = 'Third box body three';
        return b;
      })(),
      (() => {
        const c = document.createElement('p');
        c.textContent = 'Third box body four';
        return c;
      })(),
    );
    await runDebounceWindow();

    expect(subtreeCollect.mock.calls.length).toBe(1); // 三个新增节点 → 同一个父容器 → 一次
    expect(sentTexts(worker).sort()).toEqual(
      ['Third box body two', 'Third box body three', 'Third box body four'].sort(),
    );
  });
});

describe('增量翻译：(容器, 文本) 去重防重复插宿主', () => {
  it('同一容器的同一段松散文本被重扫两次：仍然只有一个译文宿主', async () => {
    await chromeStub.storage.local.set({ 'jinyi:settings': { version: 2, displayMode: 'bilingual' } });
    mount('<div id="boxD">Duplicated loose intro<p>Box D body one</p></div>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);
    const box = document.getElementById('boxD') as HTMLElement;

    // 第一轮：往混合容器加内容 → 重扫会再次采到「Duplicated loose intro」。
    appendParagraph('Box D body two', box);
    await runDebounceWindow();
    // 第二轮：再来一次 → 同一段松散文本又被采到。
    appendParagraph('Box D body three', box);
    await runDebounceWindow();

    expect(sentTexts(worker)).toEqual(['Box D body two', 'Box D body three']);
    // 首轮 + 两轮重扫，松散文本的宿主始终只有一个：增量层自己记了账。
    const looseHosts = hosts().filter((host) => bodyTextOf(host) === translate('Duplicated loose intro'));
    expect(looseHosts).toHaveLength(1);
  });

  it('另一容器里恰好同文的段落：照常翻译（键里带元素，不误伤）', async () => {
    await chromeStub.storage.local.set({ 'jinyi:settings': { version: 2, displayMode: 'bilingual' } });
    mount('<div id="boxA">Shared banner text<p>Box A body one</p></div>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    appendMixedContainer('boxB', 'Shared banner text', 'Box B body one');
    await runDebounceWindow();

    // boxA 的松散段已记账；boxB 是同文的不同容器——必须照翻。
    expect(sentTexts(worker).sort()).toEqual(['Shared banner text', 'Box B body one'].sort());
    const bannerHosts = hosts().filter((host) => bodyTextOf(host) === translate('Shared banner text'));
    expect(bannerHosts).toHaveLength(2);
  });
});

describe('增量翻译：防抖、单轮上限与合并', () => {
  it('连续 10 次变动（间隔小于窗口）只处理一轮', async () => {
    mount('<article id="a"><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);
    const feed = document.getElementById('a') as HTMLElement;

    for (let i = 0; i < 10; i += 1) {
      appendParagraph(feedText('burst', i), feed);
      await vi.advanceTimersByTimeAsync(100); // 每次变动都重置窗口：100ms < 500ms
    }
    await runDebounceWindow();

    // 一轮：10 段 ≤ 12 段/批 → 恰好一个请求。
    expect(translateRequests(worker)).toHaveLength(1);
    expect(sentTexts(worker).sort()).toEqual(
      Array.from({ length: 10 }, (_unused, i) => feedText('burst', i)).sort(),
    );
    for (let i = 0; i < 10; i += 1) expect(findHostByText(translate(feedText('burst', i)))).toBeDefined();
  });

  it('处理期间的变动合并到下一轮：不丢、不并发', async () => {
    mount('<article id="a"><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    // 从这起第一条是增量轮 alpha（挂住），第二条起自动回话。
    let releaseFirst: (() => void) | undefined;
    let seen = 0;
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = asTranslateRequest(message).payload;
      const results = items.map((item) => ({ id: item.id, text: translate(item.text) }));
      seen += 1;
      if (seen === 1) {
        releaseFirst = () => sendResponse({ ok: true, results });
        return true;
      }
      sendResponse({ ok: true, results });
      return true;
    });
    const feed = document.getElementById('a') as HTMLElement;

    appendParagraph('Mid round alpha text', feed);
    await runDebounceWindow(); // 第一轮起飞，请求挂起
    expect(seen).toBe(1);

    appendParagraph('Mid round beta text', feed);
    await vi.advanceTimersByTimeAsync(300);
    // 第二轮没跟第一轮并发：beta 连宿主都还没挂（扫描发生在轮内）。
    expect(seen).toBe(1);
    expect(findHostByText(translate('Mid round beta text'))).toBeUndefined();

    releaseFirst?.();
    await runDebounceWindow(); // 第一轮落地 → dirty → 立刻并入下一轮
    expect(seen).toBe(2);
    expect(sentTexts(worker)).toEqual(['Mid round alpha text', 'Mid round beta text']);
    expect(bodyTextOf(findHostByText(translate('Mid round beta text')) as Element)).toBe(
      translate('Mid round beta text'),
    );
  });

  it('单轮上限：超出 INCREMENTAL_MAX_SEGMENTS_PER_ROUND 的部分留到下一轮', async () => {
    mount('<article id="a"><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);
    const feed = document.getElementById('a') as HTMLElement;

    const total = INCREMENTAL_MAX_SEGMENTS_PER_ROUND + 8;
    for (let i = 0; i < total; i += 1) appendParagraph(feedText('cap', i), feed);
    await runDebounceWindow();

    // 第一轮只吃上限个段：默认 12 段/批 → 恰好 5 批；宿主也只挂这么多。
    expect(sentTexts(worker)).toHaveLength(INCREMENTAL_MAX_SEGMENTS_PER_ROUND);
    expect(translateRequests(worker)).toHaveLength(INCREMENTAL_MAX_SEGMENTS_PER_ROUND / 12);
    // 溢出段连宿主都没挂（写页面也受上限约束）。
    expect(hosts().filter((host) => bodyTextOf(host).startsWith(translate('cap item')))).toHaveLength(
      INCREMENTAL_MAX_SEGMENTS_PER_ROUND,
    );

    await runDebounceWindow(); // 下一轮把 8 段补上
    expect(sentTexts(worker)).toHaveLength(total);
    expect(sentTexts(worker)).toEqual(
      Array.from({ length: total }, (_unused, i) => feedText('cap', i)),
    );
    expect(hosts().filter((host) => bodyTextOf(host).startsWith(translate('cap item')))).toHaveLength(total);
  });
});

describe('增量翻译：失败处理与布局不变式', () => {
  it('新段落翻译失败：该段显示错误与重试按钮；重试成功落地译文', async () => {
    mount('<article id="a"><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = asTranslateRequest(message).payload;
      if (items.some((item) => item.text === 'Flaky new text')) {
        sendResponse({ ok: true, results: asItemFailures(items) });
        return true;
      }
      sendResponse({ ok: true, results: items.map((item) => ({ id: item.id, text: translate(item.text) })) });
      return true;
    });
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    appendParagraph('Flaky new text', document.getElementById('a') as HTMLElement);
    await runDebounceWindow();

    const broken = findHostByText('网络错误：Flaky new text');
    expect(broken).toBeDefined();
    expect(hasRetryButton(broken as Element)).toBe(true);
    const state = (await dispatch(contentListener, MSG.GET_PAGE_STATE)) as {
      total: number;
      done: number;
      failed: number;
    };
    expect(state).toEqual({ translated: true, mode: 'translated-only', total: 2, done: 1, failed: 1 });

    // 点重试：走既有单段重试链路，成功后译文落地。
    worker.mockImplementation(autoReply());
    worker.mockClear();
    (broken?.shadowRoot?.querySelector('.jy-retry') as HTMLButtonElement | null)?.click();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(sentTexts(worker)).toEqual(['Flaky new text']);
    expect(bodyTextOf(findHostByText(translate('Flaky new text')) as Element)).toBe(translate('Flaky new text'));
  });

  it('布局不变式：增量翻译前后，未被翻译的元素 outerHTML 逐字节不变', async () => {
    mount(
      [
        '<aside id="side" aria-hidden="true"><p>Sidebar hidden text</p></aside>',
        '<pre id="keepme">const answer = 42;</pre>',
        '<nav id="nav"><button>Push the button</button></nav>',
        '<article id="feed"><p>Hello world</p></article>',
      ].join(''),
    );
    const untouched = new Map(
      ['side', 'keepme', 'nav'].map((id) => [id, (document.getElementById(id) as HTMLElement).outerHTML]),
    );
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    const feed = document.getElementById('feed') as HTMLElement;
    appendParagraph('Layout probe one text', feed);
    appendMixedContainer('probe-box', 'Probe loose intro', 'Probe nested body');
    await runDebounceWindow();

    for (const [id, html] of untouched) {
      expect((document.getElementById(id) as HTMLElement).outerHTML, `元素 #${id} 被增量翻译波及`).toBe(html);
    }
    // 新内容确实被翻了（不变式不是因为"什么都没发生"才成立的）。
    expect(findHostByText(translate('Layout probe one text'))).toBeDefined();
    expect(findHostByText(translate('Probe loose intro'))).toBeDefined();
  });
});

describe('增量翻译：无限滚动模拟（X/Twitter 型验收）', () => {
  it(
    '50 轮 × 每轮 20 段：请求线性于段落数、同一文本恰好请求一次、宿主不重复',
    async () => {
    mount('<article id="feed"><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);
    const feed = document.getElementById('feed') as HTMLElement;

    const ROUNDS = 50;
    const PER_ROUND = 20;
    for (let round = 0; round < ROUNDS; round += 1) {
      for (let i = 0; i < PER_ROUND; i += 1) {
        appendParagraph(feedText('scroll', round * PER_ROUND + i), feed);
      }
      await runDebounceWindow();
    }

    const all = sentTexts(worker);
    const expected = Array.from({ length: ROUNDS * PER_ROUND }, (_unused, i) => feedText('scroll', i));
    expect(all.length).toBe(ROUNDS * PER_ROUND); // 恰好一遍：无重复请求
    expect([...new Set(all)].sort()).toEqual(expected.sort());
    // 线性：每轮 20 段 → 每轮 2 批（默认 12 段/批）。指数增长的实现这里会爆掉。
    expect(translateRequests(worker)).toHaveLength(ROUNDS * Math.ceil(PER_ROUND / 12));
    // 不风暴的另一半：扫描次数按新增节点计（1000），而不是每轮重扫整页。
    expect(subtreeCollect.mock.calls.length).toBe(ROUNDS * PER_ROUND);
    expect(fullPageCollect).not.toHaveBeenCalled();
    // 每段恰好一个宿主。
    const translatedHosts = hosts().filter((host) => bodyTextOf(host).startsWith('译:scroll item'));
    expect(translatedHosts).toHaveLength(ROUNDS * PER_ROUND);
    },
    // jsdom 给 1000 个宿主挂 Shadow DOM 本身就慢；这条是负载模拟用例，值这个预算。
    60_000,
  );
});
