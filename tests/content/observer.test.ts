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
import {
  FULL_RESCAN_MAX_ELEMENTS,
  INCREMENTAL_DEBOUNCE_MS,
  INCREMENTAL_MAX_SEGMENTS_PER_ROUND,
  INTERACTION_RESCAN_DEBOUNCE_MS,
  INTERACTION_RESCAN_THROTTLE_MS,
} from '../../src/content/observer';
import { toast } from '../../src/content/toast';

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

/**
 * 清掉挂在 `documentElement` 下、`body` 之外的节点（portal 形状的用例会留下它们）。
 *
 * `document.body.innerHTML = ''` 清不到这些节点——下一页用例的"整页重扫"会把上一条用例
 * 留下的 portal 文本重新扫到，计数就跟着漂。这几条用例本来就该像 `clearToast` 一样
 * 在 beforeEach 里收干净。
 */
function clearRootChildren(): void {
  for (const child of Array.from(document.documentElement.children)) {
    if (child === document.body || child.tagName === 'HEAD') continue;
    child.remove();
  }
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
  clearRootChildren();
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
  /**
   * 关键网：观察根提到 documentElement 之后，插件自己的浮层（toast / 气泡 / 悬停高亮）
   * 第一次挂载会成为 documentElement 下的一次 childList 新增，于是作为候选根进入采集。
   * 挡下它的是 extractor 的 `closest('[data-jy-root]')` 短路——**这条守卫一旦被改坏，
   * 我们自己的浮层文字就会被当成页面内容送进翻译接口**。
   *
   * 补这条是因为它此前只在"属性路径"上有测试（见本组后面那条写隐藏 span 的用例），
   * childList 路径是**空口断言**：实测把 extractor 里那条守卫删掉，本文件的 47 条用例全绿。
   */
  it('新增的插件浮层（带 data-jy-root）里的文本不会被送去翻译', async () => {
    mount('<article><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    // 文本要用**确实可译**的英文：否则"没被翻译"可能只是被噪声闸拦下了，测不出这条守卫。
    const overlay = document.createElement('div');
    overlay.setAttribute('data-jy-root', '');
    overlay.textContent = 'Untranslated plugin layer text';
    document.body.append(overlay);
    await runDebounceWindow();

    expect(sentTexts(worker)).toEqual([]);
    expect(translateRequests(worker)).toHaveLength(0);
  });

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
        // 曾是 `<button>Push the button</button>`：BUTTON 从 SKIP_TAGS 放开后按钮文字**会**被
        // 翻译（digitalocean 导航修复），"不该被波及的元素"改用仍然跳过的下拉框来钉。
        '<nav id="nav"><select id="pick"><option>Push the option</option></select></nav>',
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

  it('增量轮复用页面级假名判定：不重扫整页，纯汉字新段落照常翻译', async () => {
    // 数 body.textContent 的读取次数（页面级扫描的读数）：只允许整页翻译那一刻的 1 次，
    // 增量轮必须沿用缓存——每轮重读全文对 3000 段页面就是每轮 O(整页) 的字符串拼接。
    const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    const originalGet = descriptor?.get;
    if (typeof originalGet !== 'function') throw new Error('textContent 必须是 Node.prototype 上的访问器');
    let reads = 0;
    Object.defineProperty(document.body, 'textContent', {
      configurable: true,
      get(): string | null {
        reads += 1;
        return originalGet.call(this) as string | null;
      },
    });
    try {
      mount('<article id="a"><p>本日はお日柄もよく</p></article>');
      const { worker, contentListener } = await loadContentScript();
      worker.mockImplementation(autoReply());
      await dispatch(contentListener, MSG.TRANSLATE_PAGE);
      expect(reads).toBe(1);
      resetCounts(worker);

      // 无假名、也无简繁特征字的纯汉字段：默认判据下"已是简体中文"。修复前增量轮
      // 照样跳过；现在沿用首轮"页面含假名"的判定，照常送翻。
      appendParagraph('日本橋三丁目', document.getElementById('a') as HTMLElement);
      await runDebounceWindow();

      expect(sentTexts(worker)).toContain('日本橋三丁目');
      expect(findHostByText(translate('日本橋三丁目'))).toBeDefined();
      // 增量轮**没有**再读整页文本：判定来自缓存。
      expect(reads).toBe(1);
    } finally {
      delete (document.body as unknown as { textContent?: unknown }).textContent;
    }
  });
});

describe('增量翻译：页面级提示与整页同一套判择逻辑', () => {
  /** 逐条失败按文本给错误码（条目级形状，同整页路径）；映射外的文本回成功。 */
  function codedFailureReply(
    byText: Record<string, { code: TranslateItemResult['code']; message: string }>,
  ): FakeWorker {
    return (message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = asTranslateRequest(message).payload;
      sendResponse({
        ok: true,
        results: items.map((item) => {
          const entry = byText[item.text];
          return entry === undefined
            ? { id: item.id, text: translate(item.text) }
            : { id: item.id, text: null, code: entry.code, message: entry.message };
        }),
      });
      return true;
    };
  }

  /**
   * 已翻译页面上两个新段落各成一轮失败（1 段 1 批 + 并发 1：先后由文档顺序决定），
   * 返回整轮跑完后的 toast 文案。每个方向各自占一条用例——模块状态（renderer、
   * 增量账本）不跨用例复用，beforeEach 负责从零重建。
   */
  async function incrementalNoticeRound(
    first: { code: TranslateItemResult['code']; message: string },
    second: { code: TranslateItemResult['code']; message: string },
  ): Promise<string> {
    await chromeStub.storage.local.set({
      'jinyi:settings': { version: 1, maxSegmentsPerBatch: 1, concurrency: 1 },
    });
    mount('<article id="a"><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    worker.mockImplementation(
      codedFailureReply({
        'Increment first text': first,
        'Increment second text': second,
      }),
    );
    const feed = document.getElementById('a') as HTMLElement;
    appendParagraph('Increment first text', feed);
    appendParagraph('Increment second text', feed);
    await runDebounceWindow();

    return document.getElementById('jy-toast')?.shadowRoot?.textContent ?? '';
  }

  const AUTH = { code: 'AUTH' as const, message: '尚未填写 API Key，请在设置中配置' };
  const NETWORK = { code: 'NETWORK' as const, message: '免费接口请求失败：socket hang up' };

  it('增量轮里后到的 NETWORK 不顶掉先到的 AUTH（与整页同一条优先级）', async () => {
    const toastText = await incrementalNoticeRound(AUTH, NETWORK);
    expect(toastText).toContain('尚未填写 API Key');
    expect(toastText).not.toContain('socket hang up');
  });

  it('反向先后同样弹 AUTH：判据是错误码，不是写入顺序', async () => {
    const toastText = await incrementalNoticeRound(NETWORK, AUTH);
    expect(toastText).toContain('尚未填写 API Key');
    expect(toastText).not.toContain('socket hang up');
  });
});

/**
 * 可见性变化触发增量翻译（下拉菜单 / mega menu）。
 *
 * 场景取自 nature.com 顶部导航 "Explore content"：菜单内容**一开始就在 DOM 里**，
 * 被 CSS 类藏起来，悬停/点击展开只是**切换 class 改变可见性**，没有任何节点增删——
 * 纯 childList 观察者收不到一条记录，展开后露出的内容就永远没人翻。
 *
 * 这一组用样式表（而不是内联样式）来隐藏/显示，形状与真实站点一致：
 * `.c-header__dropdown { display: none }` + `.c-header__item--open .c-header__dropdown { display: block }`。
 * jsdom 的 getComputedStyle 会对文档里的 <style> 规则求值（含后代组合器），实测可用。
 */
const DROPDOWN_CSS = `
  <style>
    .c-header__dropdown { display: none; }
    .c-header__item--open .c-header__dropdown { display: block; }
  </style>
`;

/** nature.com 形状的导航：li 挂开关类，真正变可见的是它内部的 dropdown 子树。 */
function mountHeader(): void {
  mount(
    `${DROPDOWN_CSS}
     <ul class="c-header">
       <li id="mi" class="c-header__item">
         <div id="dd" class="c-header__dropdown">
           <h2 class="c-header__heading">Explore content heading</h2>
           <p>Nobel prize roundup text</p>
           <p>Quantum physics explainer text</p>
         </div>
       </li>
     </ul>
     <article id="feed"><p>Visible body paragraph</p></article>`,
  );
}

function setMenuOpen(open: boolean): void {
  document.getElementById('mi')?.classList.toggle('c-header__item--open', open);
}

describe('增量翻译：可见性变化（下拉菜单展开也要翻）', () => {
  it('整页翻译不碰 CSS 隐藏的菜单内容（保留"不翻看不见的东西"的正确行为）', async () => {
    mountHeader();
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    await runDebounceWindow();

    expect(sentTexts(worker)).toEqual(['Visible body paragraph']);
    expect(findHostByText(translate('Nobel prize roundup text'))).toBeUndefined();
    expect(findHostByText(translate('Explore content heading'))).toBeUndefined();
    expect(hosts()).toHaveLength(1);
  });

  it('给父 li 加 class 展开菜单 → dropdown 子树里的段落被翻译（候选根 = 被改动元素的子树）', async () => {
    mountHeader();
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    setMenuOpen(true); // 模拟站点 JS 展开菜单：class 一翻，没有任何节点增删。
    await runDebounceWindow();

    expect(sentTexts(worker).sort()).toEqual(
      ['Explore content heading', 'Nobel prize roundup text', 'Quantum physics explainer text'].sort(),
    );
    // 候选根是**被改动的 li**（class 加在 li 上，变可见的是它的后代）——整轮只扫这一棵子树。
    expect(subtreeCollect.mock.calls.map((call) => call[0])).toEqual([document.getElementById('mi')]);
    expect(fullPageCollect).not.toHaveBeenCalled();
    expect(findHostByText(translate('Nobel prize roundup text'))).toBeDefined();
  });

  it('反复开合同一个菜单（class 来回切 5 次）：请求数与宿主数一点不涨（去重账本挡住）', async () => {
    mountHeader();
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    setMenuOpen(true);
    await runDebounceWindow();
    const requestsAfterOpen = translateRequests(worker).length;
    const hostsAfterOpen = hosts().length;
    expect(requestsAfterOpen).toBeGreaterThan(0);

    for (let cycle = 0; cycle < 5; cycle += 1) {
      setMenuOpen(false);
      await runDebounceWindow();
      setMenuOpen(true);
      await runDebounceWindow();
    }

    expect(translateRequests(worker)).toHaveLength(requestsAfterOpen);
    expect(hosts()).toHaveLength(hostsAfterOpen);
    // 每段菜单文本恰好一个宿主。
    for (const text of ['Explore content heading', 'Nobel prize roundup text', 'Quantum physics explainer text']) {
      expect(hosts().filter((host) => bodyTextOf(host) === translate(text))).toHaveLength(1);
    }
  });

  it('属性风暴但都与可见性无关（隐藏子树狂改 class + 可见元素改 data-*）：零扫描', async () => {
    mountHeader();
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    const dd = document.getElementById('dd') as HTMLElement;
    const feed = document.getElementById('feed') as HTMLElement;
    const hiddenParagraph = dd.querySelector('p') as HTMLElement;
    for (let i = 0; i < 12; i += 1) {
      // 仍然隐藏的 dropdown 子树内部狂改 class（动画/埋点类名的形状）：早退必须丢弃，不许扫。
      dd.classList.add(`noise-${String(i)}`);
      dd.classList.remove(`noise-${String(i)}`);
      // **自身可见、被祖先的 display:none 罩住**的元素改 class：display 不随祖先级联计算，
      // 只看自身的 isHidden 会放行——必须沿祖先链判。
      hiddenParagraph.classList.toggle(`pulse-${String(i)}`);
      // 可见元素改**不在 attributeFilter 里**的 data-*：连记录都不该入队。
      feed.setAttribute('data-jy-analytic', String(i));
    }
    for (let i = 0; i < 4; i += 1) await runDebounceWindow();

    expect(subtreeCollect).not.toHaveBeenCalled();
    expect(fullPageCollect).not.toHaveBeenCalled();
    expect(translateRequests(worker)).toHaveLength(0);
  });

  it('自触发防护：失败的增量轮写自家隐藏 span 的 style，不滚出下一轮扫描', async () => {
    // 混合容器形态：松散文本段的容器**不带** data-jy-translated（Fix 5 的取舍），
    // 失败态把隐藏 span 的 display 放回可见时，如果属性路径不排插件自己的子树，
    // 这个 span 会当场变成候选根多出一轮扫描（collectSegmentsWithin 的调用计数可见）。
    mount(
      `${DROPDOWN_CSS}
       <ul><li id="mi" class="c-header__item">
         <div id="dd" class="c-header__dropdown">Loose menu intro text<p>Menu nested body text</p></div>
       </li></ul>
       <article><p>Standing visible paragraph</p></article>`,
    );
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = asTranslateRequest(message).payload;
      const mine = items.filter((item) => item.text.includes('menu') || item.text.includes('Menu'));
      sendResponse({
        ok: true,
        results: items.map((item) =>
          mine.includes(item)
            ? { id: item.id, text: null, code: 'NETWORK' as const, message: `网络错误：${item.text}` }
            : { id: item.id, text: translate(item.text) },
        ),
      });
      return true;
    });
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    setMenuOpen(true);
    await runDebounceWindow();
    expect(sentTexts(worker).sort()).toEqual(['Loose menu intro text', 'Menu nested body text'].sort());
    // **这一轮页面内容的写入恰好只换来一次采集，而且就在那棵 li 上**：隐藏 span 的插入、
    // 失败态把它的 display 放回可见，一个都不许变成属性候选往队列里多塞一棵子树。
    // 拆掉回调里的 `[data-jy-root]` 排除，失败写回的可见 span 会多出一轮扫描——这里当场见红。
    //
    // 名单里那第二个根是**我们自己刚弹出来的 toast**，与本次事故无关、也与自变更防护无关：
    // 观察根提到 `documentElement` 之后，挂在它下面的 `#jy-toast` 成为一次 childList 新增，
    // 于是被本轮当成一个候选根扫一次（扫它得到 0 段，不产生请求——整批同码错误本来就该弹
    // 这一条提示）。保留这个"多一跳"是有意的：既不在这里提前过滤 `[data-jy-root]`
    // （那会把"自变更守卫哪天被改坏"的污染静默吞掉），也让本条的计数**更敏感**——
    // 自变更若真的滚出第三轮，多出来的扫描一样会让下面的相等断言见红。
    expect(subtreeCollect.mock.calls.map((call) => call[0])).toEqual([
      document.getElementById('mi'),
      document.getElementById('jy-toast'),
    ]);
    const scans = subtreeCollect.mock.calls.length;
    const requests = translateRequests(worker).length;
    expect(scans).toBe(2);

    // 反复 flush + 推窗口：计数一个都不许多。
    for (let i = 0; i < 5; i += 1) {
      await flushMicrotasks();
      await runDebounceWindow();
    }
    expect(subtreeCollect.mock.calls.length).toBe(scans);
    expect(translateRequests(worker)).toHaveLength(requests);
  });

  it('收起菜单（改动元素自己从可见变隐藏）：不触发任何扫描', async () => {
    mountHeader();
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    setMenuOpen(true);
    await runDebounceWindow();
    resetCounts(worker);

    // 折叠面板的常见形态：display 直接切在内容容器自己身上。
    (document.getElementById('dd') as HTMLElement).style.display = 'none';
    for (let i = 0; i < 4; i += 1) await runDebounceWindow();

    expect(subtreeCollect).not.toHaveBeenCalled();
    expect(translateRequests(worker)).toHaveLength(0);
  });

  it('已译整元素段自身被站点改属性（hover 高亮类）：祖先短路，不重扫', async () => {
    mountHeader();
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    // <p>Visible body paragraph</p> 已作为整元素段译好（带着 data-jy-translated）。
    // 站点给它自身加高亮类：这属于"改动已译内容"，按既定范围不重译——观察者的
    // insideTranslatedBlock 必须让它连 collectSegmentsWithin 都进不去（extractor 的
    // 短路只是第二道防线，扫描计数才是这道闸的证据）。
    const paragraph = document.querySelector('#feed p') as HTMLElement;
    for (let i = 0; i < 6; i += 1) paragraph.classList.toggle(`hover-${String(i)}`);
    for (let i = 0; i < 4; i += 1) await runDebounceWindow();

    expect(subtreeCollect).not.toHaveBeenCalled();
    expect(translateRequests(worker)).toHaveLength(0);
  });

  it('一个防抖窗口里同时攒下属性变动与节点新增：合并成同一轮处理（共用链路，不开第二条）', async () => {
    mountHeader();
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    setMenuOpen(true); // 属性路径的候选
    appendParagraph('Same window childList addition', document.getElementById('feed') as HTMLElement); // childList 路径的候选
    await runDebounceWindow();

    // 两路各交出自己的段，且都落在**同一个**防抖轮里（窗口只排了一次队）。
    expect(sentTexts(worker).sort()).toEqual(
      [
        'Explore content heading',
        'Nobel prize roundup text',
        'Quantum physics explainer text',
        'Same window childList addition',
      ].sort(),
    );
    const roots = new Set(subtreeCollect.mock.calls.map((call) => call[0]));
    expect(roots.has(document.getElementById('mi') as HTMLElement)).toBe(true); // li 来自属性路径
    // 每轮上限只裁一次：这里远不到 60 段，一轮吃干净，没有滚出第二轮。
    const scans = subtreeCollect.mock.calls.length;
    for (let i = 0; i < 3; i += 1) {
      await flushMicrotasks();
      await runDebounceWindow();
    }
    expect(subtreeCollect.mock.calls.length).toBe(scans);
  });

  it('防抖窗口内"改了又撤"（最终态仍隐藏）：丢弃候选，零扫描', async () => {
    mountHeader();
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    // 折叠面板型：display 直接切在内容容器自己身上。窗口内打开又关闭——
    // 属性路径按轮内**最终态**判可见性，"闪现过又消失"的子树一次采集都不该有。
    const dd = document.getElementById('dd') as HTMLElement;
    dd.style.display = 'block';
    await vi.advanceTimersByTimeAsync(200);
    dd.style.display = 'none';
    await runDebounceWindow();

    expect(subtreeCollect).not.toHaveBeenCalled();
    expect(translateRequests(worker)).toHaveLength(0);
  });

  it('li 类翻转的开合相抵：最终态隐藏时零请求（li 自身可见，允许付一次空采集）', async () => {
    mountHeader();
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    // nature 形态：类翻在 li 上，li 自己**始终**可见——早退判据看不见"里面曾闪过一帧"，
    // 允许付一次对着隐藏子树的空采集（extractor 的隐藏短路兜住内容），但绝不允许
    // 把看不见的菜单文本送接口。这一条把"承诺的边界"写死：省的是请求，不是那一次函数调用。
    setMenuOpen(true);
    await vi.advanceTimersByTimeAsync(200);
    setMenuOpen(false);
    await runDebounceWindow();

    expect(sentTexts(worker)).toEqual([]);
    expect(hosts()).toHaveLength(1); // 只有首轮的 Visible body paragraph
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

/**
 * 观察根 = `documentElement`（而不是 `body`）。
 *
 * portal 把浮层挂到 `<html>` 下、成为 body 的**兄弟**时，挂在 body 上的观察者一个字节都
 * 看不见——digitalocean 顶部导航下拉菜单的候选原因之一。这一组既钉「看得见」，
 * 也钉「提根之后自变更防护仍然有效」（我们自己的浮层全都挂在 documentElement 上）。
 */
describe('增量翻译：观察根提到 documentElement（portal 是 body 的兄弟）', () => {
  /** portal 形状：面板挂在 `<html>` 下，与 `<body>` 同级。 */
  function appendPortal(html: string): HTMLElement {
    const portal = document.createElement('div');
    portal.id = 'portal';
    portal.innerHTML = html;
    document.documentElement.append(portal);
    return portal;
  }

  it('portal 挂到 documentElement 下的新内容：被增量翻译（改回 body 做根这条必红）', async () => {
    mount('<article><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    // 注意这里**没有**派发任何用户交互：本条要钉的是 childList 路径本身看得见 portal，
    // 与「交互兜底重扫」是两回事（那条由下面一组单独钉）。
    const portal = appendPortal('<p>Portal panel text</p>');
    await runDebounceWindow();

    expect(sentTexts(worker)).toEqual(['Portal panel text']);
    expect(findHostByText(translate('Portal panel text'))).toBeDefined();
    // 扫的是 portal 自己（它是新增元素、父 <html> 不是混合容器）。
    expect(subtreeCollect.mock.calls.map((call) => call[0])).toEqual([portal]);
    expect(fullPageCollect).not.toHaveBeenCalled();
  });

  it('自变更防护在提根后仍然有效：浮层写 documentElement + 反复 flush 也不滚出第二轮', async () => {
    await chromeStub.storage.local.set({ 'jinyi:settings': { version: 2, displayMode: 'bilingual' } });
    mount('<article><p>Hello world</p></article>');
    // 我们自己的浮层写在 documentElement 上（toast / tooltip / 悬停高亮）：提根之后这些写入
    // 全都在观察范围内，自变更防护必须照样挡得住。这里**先断言浮层确实挂在 documentElement 上**
    // ——否则这条用例会在"我们的浮层换了个挂点"时静默失效，钉了个寂寞。
    // 排在整页翻译**之前**：它的挂载/替换发生在 enable 之前，不会成为本轮计数里的噪声。
    toast('提根后的自变更探针');
    const toastHost = document.getElementById('jy-toast') as HTMLElement;
    expect(toastHost.parentElement).toBe(document.documentElement);

    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    // 混合容器是最好的试金石（隐藏 span 插入 + 原文搬移 + 宿主插入，全是 childList）。
    appendMixedContainer('self-mut-root', 'Root intro echo', 'Root nested echo');
    await runDebounceWindow();
    expect(sentTexts(worker)).toEqual(['Root intro echo', 'Root nested echo']);
    const scans = subtreeCollect.mock.calls.length;
    const requests = translateRequests(worker).length;
    expect(scans).toBeGreaterThan(0);

    for (let i = 0; i < 5; i += 1) {
      await flushMicrotasks();
      await runDebounceWindow();
    }
    expect(subtreeCollect.mock.calls.length).toBe(scans);
    expect(translateRequests(worker)).toHaveLength(requests);
    expect(hosts().filter((host) => bodyTextOf(host) === translate('Root intro echo'))).toHaveLength(1);
  });
});

/**
 * 用户交互后的整页重扫。
 *
 * 兜的是「内容出现了，但没留下任何我们能观察到的痕迹」：React 在点击时现渲染 portal、
 * 站点只切自定义属性、面板早已在 DOM 里只是被某个看不见的东西控制——digitalocean 顶部
 * 导航下拉菜单就是实证。**不猜是哪一种**：用户一碰页面就重跑一次整页采集，
 * 靠既有的 (容器, 文本) 账本跳过已经翻过的内容。
 *
 * 这一组里最要紧的一条是「没把全页扫接进变动路径」：重扫**只由用户交互触发**，
 * 绝不能由 MutationObserver 触发，否则整个增量层的复杂度承诺当场作废。
 */
describe('增量翻译：用户交互后的整页重扫', () => {
  /** 用户交互（捕获阶段挂在 document 上的监听器收得到）。 */
  function click(): void {
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  /** 到目前为止，`documentElement` 当过几次采集根（= 发生过几次整页重扫）。 */
  function fullRescanCount(): number {
    return subtreeCollect.mock.calls.filter((call) => call[0] === document.documentElement).length;
  }

  /** 只推过一个交互防抖窗口：用来验"到点之前还没扫"。 */
  async function runInteractionWindow(): Promise<void> {
    await vi.advanceTimersByTimeAsync(INTERACTION_RESCAN_DEBOUNCE_MS + 1);
  }

  /** 推过一整条"防抖 + 节流 + 余量"的链路（`INTERACTION_RESCAN_THROTTLE_MS` 已含余量）。 */
  async function runThrottleWindow(): Promise<void> {
    await vi.advanceTimersByTimeAsync(
      INTERACTION_RESCAN_DEBOUNCE_MS + INTERACTION_RESCAN_THROTTLE_MS,
    );
  }

  /**
   * 推到一个"一切尘埃落定"的时刻：防抖窗口 + 节流窗口都过去了，在排的定时器全部跑完。
   *
   * 为什么不能只用防抖窗口：被节流推迟的那一轮要等到 `lastFullRescanAt + 1000ms` 才跑，
   * 而它的重排延迟是"剩余的节流等待"，只推 400ms 会让这类用例随机变红。
   *
   * 为什么每轮只推一个窗口：一次推太远会把"补排的下一轮定时器"也一起推过去，
   * 于是本来只该发生一次的整页重扫变成两次（实测坑过）。一轮一轮推，推完看还有没有
   * 待办定时器——有就再推一轮，直到干净为止。
   */
  async function runFullInteractionWindow(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await runThrottleWindow();
      if (vi.getTimerCount() === 0) return;
    }
  }

  it('只改 DOM、不加任何交互：采集次数与改动前完全一致（全页扫绝没接进变动路径）', async () => {
    mount('<article id="feed"><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);
    const feed = document.getElementById('feed') as HTMLElement;

    // 基准取在**这一步之前**：翻译轮自己可能还有在排的收尾定时器（账本与节流基准都在
    // 增量层内部，测试碰不到），断言只看"从这一刻起又多了几次"，与那些残留无关。
    const rescansBefore = fullRescanCount();

    // 两种不同形状的变动：新段落（childList）、混合容器（改扫父容器）。
    appendParagraph('Mutation only addition', feed);
    appendMixedContainer('mutation-only-box', 'Mutation only intro', 'Mutation only body');
    await runDebounceWindow();
    const scans = subtreeCollect.mock.calls.length;
    const requests = translateRequests(worker).length;
    expect(scans).toBe(2); // 新 p + 混合容器各一次
    expect(requests).toBeGreaterThan(0);

    // 再变动、再等——包括等够一个交互防抖窗口：没有交互就**不该**有整页重扫。
    appendParagraph('Second mutation only', feed);
    for (let i = 0; i < 4; i += 1) await runInteractionWindow();

    // 采集次数只涨那一次（新 p），不是"每次都 +1 次整页"。
    expect(subtreeCollect.mock.calls.length).toBe(scans + 1);
    expect(translateRequests(worker).length).toBe(requests + 1);
    expect(fullRescanCount()).toBe(rescansBefore);
    // 整页采集（`collectSegments`）从头到尾一次都没跑过。
    expect(fullPageCollect).not.toHaveBeenCalled();
  });

  it('派发一次 click：发生一次整页采集，根是 documentElement（不是某个子树）', async () => {
    mount('<article><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);
    const rescansBefore = fullRescanCount();

    click();
    await runFullInteractionWindow();

    // 一次点击恰好换来**一次**整页采集（`subtreeCollect` 的调用只有它）；
    // 根 = documentElement：与观察根同一个节点，portal 挂在它下面才捞得回来。
    expect(subtreeCollect.mock.calls.map((call) => call[0])).toEqual([document.documentElement]);
    expect(fullRescanCount() - rescansBefore).toBe(1);
    // 整页重扫走的是**现有的**入口（collectSegmentsWithin），不是另起一条整页采集。
    expect(fullPageCollect).not.toHaveBeenCalled();
    // 页面早已全部译好：重扫只花钱、不重复请求。
    expect(translateRequests(worker)).toHaveLength(0);
  });

  it('交互后新出现的 portal 内容（点击后 React 才渲染）被翻译', async () => {
    mount('<article><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    // 点击 → 面板在 200ms 后由 React 渲染出来（防抖窗口之内，但**不是**同步发生：
    // 真实站点的展开是点击处理器里的一次异步渲染）。
    click();
    setTimeout(() => {
      const portal = document.createElement('div');
      portal.id = 'late-portal';
      portal.innerHTML = '<p>Late portal card text</p>';
      document.documentElement.append(portal);
    }, 200);
    await runFullInteractionWindow();

    expect(sentTexts(worker)).toEqual(['Late portal card text']);
    expect(findHostByText(translate('Late portal card text'))).toBeDefined();
  });

  it('交互后新出现的内容（直接 append 到 body）被翻译', async () => {
    mount('<article><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    click();
    setTimeout(() => {
      const bodyChild = document.createElement('div');
      bodyChild.innerHTML = '<p>Direct body addition text</p>';
      document.body.append(bodyChild);
    }, 200);
    await runFullInteractionWindow();

    expect(sentTexts(worker)).toEqual(['Direct body addition text']);
    expect(findHostByText(translate('Direct body addition text'))).toBeDefined();
  });

  it('连续 10 次点击：整页重扫被节流限制住（同一时刻的连点只换来一次）', async () => {
    mount('<article><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);
    const rescansBefore = fullRescanCount();

    // 10 次点击**没有任何时间流逝**（同一批微任务）：防抖窗口被反复重置，
    // 没有节流的话这串点击会连着排 10 轮整页采集。
    for (let i = 0; i < 10; i += 1) click();
    await runInteractionWindow();
    expect(fullRescanCount() - rescansBefore).toBe(1);

    // 节流窗口内再点 10 次（此刻距上一次重扫只有 1ms）：整页重扫的数量一点也不许多。
    for (let i = 0; i < 10; i += 1) click();
    await runInteractionWindow();
    expect(fullRescanCount() - rescansBefore).toBe(1);
    expect(INTERACTION_RESCAN_THROTTLE_MS).toBeGreaterThan(INTERACTION_RESCAN_DEBOUNCE_MS);

    // 节流窗口过去之后点击才重新换来一次整页重扫：说明被推迟的那次不是被静默吞掉，
    // 只是等了 1 秒。
    await runFullInteractionWindow();
    expect(fullRescanCount() - rescansBefore).toBe(2);
    click();
    await runFullInteractionWindow();
    expect(fullRescanCount() - rescansBefore).toBe(3);
    expect(translateRequests(worker)).toHaveLength(0); // 整轮下来一次请求都没多发
  });

  it('一次点击风暴里两次整页重扫的最小间隔不小于节流窗口', async () => {
    mount('<article><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    const stamps: number[] = [];
    subtreeCollect.mockImplementation(((root: Element) => {
      if (root === document.documentElement) stamps.push(Date.now());
      return [];
    }) as never);

    try {
      // 1.2 秒内每 40ms 敲一下（人连点的节奏；+7ms 让定时器不与游标精确重合），
      // 之后跨过窗口再敲两下。
      for (let i = 0; i < 30; i += 1) {
        click();
        await vi.advanceTimersByTimeAsync(47);
      }
      await runFullInteractionWindow();
      click();
      await runFullInteractionWindow();
      click();
      await runFullInteractionWindow();

      expect(stamps.length).toBeGreaterThanOrEqual(2);
      const gaps = stamps.slice(1).map((at, i) => at - (stamps[i] as number));
      for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(INTERACTION_RESCAN_THROTTLE_MS);
      expect(translateRequests(worker)).toHaveLength(0);
    } finally {
      // **必须还原**：`vi.fn(original.…)` 的 spy 对象整个文件共享一份（mock factory 的返回值
      // 不随 resetModules 重建），这里的 `mockImplementation(() => [])` 若留着，后面每个用例的
      // 增量采集都会拿到空数组——本文件排在它后面的旧用例恰好只断言调用次数/参数与"零请求"，
      // 从不依赖**返回值**，才一直没暴露。任何依赖真实扫描结果的新用例都会被无声毒化。
      subtreeCollect.mockRestore();
    }
  });

  it('重扫不重复翻译已译段落：请求数与宿主数都不涨（账本与 data-jy-translated 生效）', async () => {
    await chromeStub.storage.local.set({ 'jinyi:settings': { version: 2, displayMode: 'bilingual' } });
    mount('<div id="box">Standing intro text<p>Standing body text</p></div>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);
    const hostsBefore = hosts().length;
    const requestsBefore = translateRequests(worker).length;
    const rescansBefore = fullRescanCount();

    // 连点三次（每次跨过节流窗口）：每次都是一轮完整的整页采集。
    for (let round = 0; round < 3; round += 1) {
      click();
      await runFullInteractionWindow();
    }

    // 确实扫了三遍整页——不是因为"什么都没发生"才没涨。
    expect(fullRescanCount() - rescansBefore).toBe(3);
    expect(translateRequests(worker)).toHaveLength(requestsBefore); // 一段都不重发
    expect(hosts()).toHaveLength(hostsBefore); // 也不多插一个宿主
  });

  it('未翻译时点击：零扫描零请求', async () => {
    mount('<article><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    // 注意：不发 TRANSLATE_PAGE。
    resetCounts(worker);

    for (let i = 0; i < 3; i += 1) click();
    for (let i = 0; i < 3; i += 1) await runFullInteractionWindow();

    expect(subtreeCollect).not.toHaveBeenCalled();
    expect(fullPageCollect).not.toHaveBeenCalled();
    expect(translateRequests(worker)).toHaveLength(0);
    void contentListener;
  });

  it('还原之后点击：零扫描零请求（观察者停摆）', async () => {
    mount('<article id="a"><p>Hello world</p></article>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    await dispatch(contentListener, MSG.RESTORE_PAGE);
    resetCounts(worker);

    for (let i = 0; i < 3; i += 1) click();
    for (let i = 0; i < 3; i += 1) await runFullInteractionWindow();

    expect(subtreeCollect).not.toHaveBeenCalled();
    expect(fullPageCollect).not.toHaveBeenCalled();
    expect(translateRequests(worker)).toHaveLength(0);
  });
});

/**
 * 主修（isBlockBoundary 判据改为"内部有没有块级内容"）之后，增量层各判据的连锁结论。
 *
 * `isMixedContainer` 用的是另一条**更便宜**的判据（`isBlockDisplay`——"有没有块级直接子元素"，
 * 它只为决定"要不要改扫父容器"服务，不是"什么算一段"），本次修复**不碰它**；
 * 真正受影响的是它的两个下游：candidateRoots 交给 `collectSegmentsWithin` 的子树现在能采到
 * inline 载体包着的卡片段落，`insideTranslatedBlock` 也因为卡片段落第一次拿到了
 * `data-jy-translated` 而开始在这块区域生效。逐条钉住：
 */
describe('增量翻译：inline 载体包卡片（mega-menu 形状）的连锁', () => {
  const CARD =
    '<div class="grid-item"><a class="cardlink" href="/x" style="display:inline">' +
    '<div class="styled"><div class="content">' +
    '<h3>Droplets heading</h3><p>Droplets description text</p>' +
    '</div></div></a></div>';

  function content(): HTMLElement {
    return document.querySelector('.content') as HTMLElement;
  }

  it('整页翻译就把卡片两段送出去（修复前这两段永远进不了任何一轮）', async () => {
    mount(CARD);
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    const state = (await dispatch(contentListener, MSG.TRANSLATE_PAGE)) as { total: number };
    expect(sentTexts(worker)).toEqual(['Droplets heading', 'Droplets description text']);
    expect(state.total).toBe(2);
    expect(findHostByText(translate('Droplets heading'))).toBeDefined();
    expect(findHostByText(translate('Droplets description text'))).toBeDefined();
  });

  it('往卡片深处追加新段落：增量轮照常采到并翻译（候选根 = 新增元素自己）', async () => {
    mount(CARD);
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    resetCounts(worker);

    appendParagraph('Card addition paragraph', content());
    await runDebounceWindow();

    expect(sentTexts(worker)).toEqual(['Card addition paragraph']);
    expect(findHostByText(translate('Card addition paragraph'))).toBeDefined();
  });

  it('已译卡片段落的 data-jy-translated 生效：整页重扫与子孙切入的裸文本追加都不重译', async () => {
    mount(CARD);
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    const cardP = content().querySelector('p') as HTMLElement;
    expect(cardP.hasAttribute('data-jy-translated')).toBe(true);
    resetCounts(worker);
    const hostsBefore = hosts().length;

    // 路径 A：交互重扫从祖先切入——段落自身被 data-jy-translated 短路。
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(INTERACTION_RESCAN_DEBOUNCE_MS + INTERACTION_RESCAN_THROTTLE_MS);
    expect(sentTexts(worker)).toEqual([]);

    // 路径 B：增量从子孙切入（往已译段落里追加裸文本）——insideTranslatedBlock 沿祖先查，
    // 候选根被丢弃，已译卡片内容不重发、不多挂宿主。
    cardP.append(document.createTextNode(' sneaked suffix'));
    await runDebounceWindow();
    for (let i = 0; i < 4; i += 1) await runDebounceWindow();

    expect(sentTexts(worker)).toEqual([]);
    expect(hosts()).toHaveLength(hostsBefore);
  });

  it('isMixedContainer 维持自己的便宜判据：inline 载体不算块级子元素（行为逐字不变）', async () => {
    // 容器只有「直接文本 + inline 载体（内部含块级）」时，isMixedContainer 仍返回 false：
    // 新增元素只扫自己。这不是漏翻——容器的直接文本在全页采集里就是松散文本段
    // （修复后 visitBlock 会为它成段），新增元素的子树里也没有"属于容器的旧文本"。
    // 这条钉住「观察者没有被迫 import 更重的块级探查」这个决定是深思熟虑的，不是遗漏。
    mount('<div id="box">Container loose intro<a style="display:inline"><p>Wrapped body text</p></a></div>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    // 全页链路：松散 intro 与卡片 p 两段都在（旧行为会整段丢卡片、intro 并入载体文本）。
    expect(sentTexts(worker).sort()).toEqual(['Container loose intro', 'Wrapped body text']);
    resetCounts(worker);

    appendParagraph('Added after wrap', document.getElementById('box') as HTMLElement);
    await runDebounceWindow();
    // 候选根 = 新增 p 自己（父容器不算混合）——新段落照样翻出来。
    expect(subtreeCollect.mock.calls.map((call) => (call[0] as Element).textContent)).toEqual([
      'Added after wrap',
    ]);
    expect(sentTexts(worker)).toEqual(['Added after wrap']);
  });
});
