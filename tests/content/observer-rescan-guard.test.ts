/**
 * @vitest-environment jsdom
 *
 * 「整页重扫的元素数护栏」单独成文件，理由是**测试环境本身的成本**：
 * 要验的是「页面大到某个程度时跳过整页重扫」，而唯一诚实的构造就是真造一棵那么大的 DOM。
 * 在 jsdom 里那有两笔硬开销——采集器爬一遍（隐藏/块级判定对同一批元素反复做样式解析，
 * 实测一万五千个平铺 div 约 6~13 秒）与一万五千条 childList 记录入队（同样十几秒）——
 * 合起来会把 `observer.test.ts`（本来就有无限滚动模拟那类重负载用例）推到几十秒。
 *
 * 所以这里只把**一个读数**撑到阈值之上：`documentElement.getElementsByTagName('*').length`，
 * 它正是护栏的判据本身（见 `observer.ts` 的 `fullRescanAllowed`）。其余一切保持真实：
 * 页面是普通的小页面，触发走真实的 pointerdown/click/keydown 监听，采集走真实的
 * `collectSegmentsWithin`。护栏若失效、整页重扫真的跑起来，断言照样见红。
 *
 * 对端替身与时间伪造沿用 `observer.test.ts` 的既有做法（详见那边的文件头注释）。
 */
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';
import { MSG } from '../../src/shared/messages';
import {
  FULL_RESCAN_MAX_ELEMENTS,
  INCREMENTAL_DEBOUNCE_MS,
  INTERACTION_RESCAN_DEBOUNCE_MS,
  INTERACTION_RESCAN_THROTTLE_MS,
} from '../../src/content/observer';

vi.mock('../../src/content/extractor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/content/extractor')>();
  return {
    ...original,
    // 包一层而不是替身：测试要数真实采集的调用次数与实参，行为必须原样。
    collectSegments: vi.fn(original.collectSegments),
    collectSegmentsWithin: vi.fn(original.collectSegmentsWithin),
  };
});

type SendResponse = (response?: unknown) => void;
type MessageListener = (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean | undefined;

let chromeStub: ChromeStub;
let fullPageCollect: MockInstance;
let subtreeCollect: MockInstance;

function isTranslateRequest(message: unknown): boolean {
  return (message as { type?: string } | null)?.type === MSG.TRANSLATE_TEXTS;
}

function translate(text: string): string {
  return `译:${text}`;
}

function autoReply(): MessageListener {
  return (message, _sender, sendResponse) => {
    if (!isTranslateRequest(message)) return false;
    const { items } = (message as { payload: { items: Array<{ id: string; text: string }> } }).payload;
    sendResponse({ ok: true, results: items.map((item) => ({ id: item.id, text: translate(item.text) })) });
    return true;
  };
}

async function dispatch(listener: MessageListener, type: string): Promise<unknown> {
  let responded = false;
  let settle: ((response: unknown) => void) | undefined;
  const response = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
  const returned = listener({ type }, { id: 'jinyi-test' }, (incoming?: unknown) => {
    if (responded) return;
    responded = true;
    settle?.(incoming);
  });
  if (!responded && returned !== true) throw new Error(`内容脚本没有接管 ${type}`);
  return response;
}

function sentTexts(worker: MockInstance<MessageListener>): string[] {
  return worker.mock.calls
    .filter(([message]) => isTranslateRequest(message))
    .flatMap(([message]) =>
      (message as { payload: { items: Array<{ text: string }> } }).payload.items.map((item) => item.text),
    );
}

/** 到目前为止，`documentElement` 当过几次采集根（= 发生过几次整页重扫）。 */
function fullRescanCount(): number {
  return subtreeCollect.mock.calls.filter((call) => call[0] === document.documentElement).length;
}

/**
 * 把元素数这一个读数伪装成"超大页面"，其余读数照常走真实实现。
 *
 * 这里的 **15001 是硬编码的**，不是 `FULL_RESCAN_MAX_ELEMENTS + 1`。
 * 原来写成 +1 时，桩会跟着常量一起漂，于是"阈值改成任意值"都测不出来——
 * 实测把 `FULL_RESCAN_MAX_ELEMENTS` 改成 `Number.MAX_SAFE_INTEGER` 仍然 3 条全绿。
 * 硬编码之后，常量一旦漂离 15000，下面的用例就会红。
 */
function stubHugePage(): MockInstance {
  const realLookup = document.documentElement.getElementsByTagName.bind(document.documentElement);
  return vi.spyOn(document.documentElement, 'getElementsByTagName').mockImplementation(((
    name: string,
  ) => {
    if (name === '*') {
      return Object.assign([], {
        length: 15001,
      }) as unknown as HTMLCollectionOf<Element>;
    }
    return realLookup(name);
  }) as typeof document.documentElement.getElementsByTagName);
}

beforeEach(async () => {
  document.body.innerHTML = '';
  for (const host of Array.from(document.querySelectorAll('[data-jy-root]'))) host.remove();
  vi.resetModules();
  chromeStub = installChromeStub();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('增量翻译：整页重扫的元素数护栏', () => {
  it('阈值本身钉在 15000（这是有意的设计取舍，不是随手写的数）', () => {
    // 为什么要显式钉一个常量：护栏用例的桩是硬编码 15001，常量漂了它们会红；
    // 但"为什么取 15000"这个决策本身也该可追溯，所以再钉一次。
    // 依据见 observer.ts 里 FULL_RESCAN_MAX_ELEMENTS 的注释：一次整页采集 ≈ 每元素一次
    // getComputedStyle，1.5 万元素在主流机器上是几十毫秒量级、且覆盖绝大多数内容型页面；
    // 再往上单次就是几百毫秒，挂在每次点击后面就是可感知的卡顿。
    expect(FULL_RESCAN_MAX_ELEMENTS).toBe(15000);
  });

  async function translatedPage(): Promise<{
    worker: MockInstance<MessageListener>;
    feed: HTMLElement;
  }> {
    document.body.innerHTML = '<article id="feed"><p>Hello world</p></article>';
    await import('../../src/content/index');
    const extractor = await import('../../src/content/extractor');
    fullPageCollect = extractor.collectSegments as unknown as MockInstance;
    subtreeCollect = extractor.collectSegmentsWithin as unknown as MockInstance;
    const listener = chromeStub.runtime.onMessage.listeners()[0];
    if (listener === undefined) throw new Error('内容脚本没有注册 onMessage 监听器');
    const worker = vi.fn<MessageListener>(() => undefined);
    chromeStub.runtime.onMessage.addListener(worker);
    worker.mockImplementation(autoReply());
    await dispatch(listener, MSG.TRANSLATE_PAGE);
    worker.mockClear();
    fullPageCollect.mockClear();
    subtreeCollect.mockClear();
    return { worker, feed: document.getElementById('feed') as HTMLElement };
  }

  it('元素数超过阈值：点击不触发整页全扫（护栏确实读了这个读数）', async () => {
    const { worker } = await translatedPage();
    const rescansBefore = fullRescanCount();
    const countSpy = stubHugePage();

    try {
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(
        INTERACTION_RESCAN_DEBOUNCE_MS + INTERACTION_RESCAN_THROTTLE_MS + 1,
      );
      // 整页重扫被护栏拦下：`documentElement` 一次都没当根用过。
      expect(fullRescanCount()).toBe(rescansBefore);
      // 护栏确实问过那个读数（而不是因为别的原因没扫）。
      expect(countSpy).toHaveBeenCalledWith('*');
      expect(worker.mock.calls.filter(([message]) => isTranslateRequest(message))).toHaveLength(0);
    } finally {
      countSpy.mockRestore();
    }
  });

  it('元素数超过阈值：窄路径照旧（护栏只挡整页重扫，不挡增量）', async () => {
    const { worker, feed } = await translatedPage();
    const countSpy = stubHugePage();

    try {
      const paragraph = document.createElement('p');
      paragraph.textContent = 'Narrow path still works';
      feed.append(paragraph);
      await vi.advanceTimersByTimeAsync(INCREMENTAL_DEBOUNCE_MS + 1);

      expect(sentTexts(worker)).toEqual(['Narrow path still works']);
      expect(subtreeCollect.mock.calls.map((call) => call[0])).toEqual([
        expect.objectContaining({ textContent: 'Narrow path still works' }),
      ]);
      expect(paragraph.hasAttribute('data-jy-translated')).toBe(true);
    } finally {
      countSpy.mockRestore();
    }
  });

  it('阈值之下：同一次点击照常触发整页重扫（护栏不是"永远跳过"）', async () => {
    await translatedPage();
    const rescansBefore = fullRescanCount();

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(
      INTERACTION_RESCAN_DEBOUNCE_MS + INTERACTION_RESCAN_THROTTLE_MS + 1,
    );

    expect(fullRescanCount()).toBe(rescansBefore + 1);
    expect(subtreeCollect.mock.calls.map((call) => call[0])).toEqual([document.documentElement]);
  });
});
