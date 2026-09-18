/**
 * @vitest-environment jsdom
 *
 * 内容脚本编排（WU8）的集成测试：抽取 → 分批 → 消息 → 渲染 → 还原，一条链路走通。
 *
 * 消息链路的对端是**测试自己注册的** `onMessage` 监听器（见 `loadContentScript` 的 `worker`），
 * 它按 `background/service-worker.ts` + `background/scheduler.ts` 的真实契约回话：
 * 响应形状是 `TranslateTextsResponse`，引擎类失败一律表现为
 * `{ ok: true, results: [{ id, text: null, code, message }] }`（条目级，不是 `ok: false`）。
 * 这里不 import service worker 本身——它 import 时就要 `storage.session`、还会拉起
 * 缓存对账，与被测的编排层无关。
 */
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';
import { MSG, type PageState, type TranslateItemResult } from '../../src/shared/messages';
import { CURRENT_VERSION, SETTINGS_KEY } from '../../src/shared/settings';

/** 从生产消息类型里取"内容脚本发出的那一条"的形状，不手抄 payload 结构。 */
type SentMessage = { type: string; payload: { items: Array<{ id: string; text: string }>; targetLang?: string } };

type SendResponse = (response?: unknown) => void;

/** `onMessage` 的监听器签名（与 `@types/chrome` / chrome-stub 一致）。 */
type MessageListener = (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean | undefined;

/**
 * 对端（service worker）替身：由每个用例决定怎么回话，`sendMessage` 的响应契约由它驱动。
 * 参数按 `unknown` 收（跨进程边界上消息本来就是 unknown），用例内部再按形状校验。
 */
type FakeWorker = MessageListener;

/** 内容脚本模块的句柄；每个用例都重新 import 一份（模块里持有一整页的状态）。 */
type ContentScript = typeof import('../../src/content/index');

/**
 * 与 `src/content/index.ts` 里的同名常量一致。不 import 它：静态 import 会在装 DOM
 * 之前执行内容脚本模块（那里一 import 就注册消息监听器）。超时时长是用户看得见的
 * 行为（失败文案里就写着秒数），钉在这里是有意的。
 */
const BACKGROUND_TIMEOUT_MS = 60_000;

let chromeStub: ChromeStub;

async function loadContentScript(): Promise<{
  module: ContentScript;
  worker: MockInstance<MessageListener>;
  contentListener: MessageListener;
}> {
  const module = await import('../../src/content/index');
  // 内容脚本自己在 import 时就注册了监听器，此时它是唯一的一个。
  const contentListener = chromeStub.runtime.onMessage.listeners()[0];
  if (contentListener === undefined) throw new Error('内容脚本没有注册 onMessage 监听器');

  // 对端替身 = "service worker 那一侧的 onMessage"。`chrome.runtime.sendMessage`
  // 会把内容脚本发出去的翻译请求派给它；走 `chrome.tabs.sendMessage` 的消息在真机上
  // 到不了它手里，用例用 `dispatch` 直接投给内容脚本（见下）。
  const worker = vi.fn<MessageListener>(() => undefined);
  chromeStub.runtime.onMessage.addListener(worker);
  return { module, worker, contentListener };
}

/**
 * 收到的这条是不是"内容脚本 → 后台"的翻译请求。
 *
 * 对端替身与内容脚本共用同一个 `onMessage` 通道（替身就是拿它当"service worker 那一侧"
 * 用的）。真机上只有 `chrome.runtime.sendMessage` 会跨进程到后台，`chrome.tabs.sendMessage`
 * 发的那些（TRANSLATE_PAGE 等）不会，所以替身必须先把它们筛掉，否则它会对着
 * "发给内容脚本的消息"做响应。
 */
function isTranslateRequest(message: unknown): boolean {
  return (message as { type?: string } | null)?.type === MSG.TRANSLATE_TEXTS;
}

/**
 * 把消息投给内容脚本并等它的响应（真机上这就是"弹窗 / 右键菜单 → tabs.sendMessage"那一步）。
 *
 * **直接调用内容脚本自己的监听器**，不走 `runtime.dispatchMessage`：那会把同一条消息
 * 广播给对端替身，而替身若抢先 `sendResponse`，这里拿到的就是替身的响应而不是内容脚本的
 * （`ok: false` 那条用例当初就是这么假失败的）。
 */
async function dispatch(contentListener: MessageListener, type: string, payload?: unknown): Promise<PageState> {
  let responded = false;
  let settle: ((response: unknown) => void) | undefined;
  const response = new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => resolve('NO_RESPONSE'), 1000);
    settle = (incoming: unknown) => {
      clearTimeout(timer);
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

  // chrome 的响应契约：同步 sendResponse（GET_PAGE_STATE / RESTORE_PAGE）或者
  // 返回 true 保持通道（TRANSLATE_PAGE / TOGGLE_PAGE）。两条都不成立就是没人处理。
  if (!responded && returned !== true) {
    throw new Error(`内容脚本没有接管 ${type}：既没有响应，也没有保持消息通道`);
  }

  const result = await response;
  if (result === 'NO_RESPONSE') throw new Error(`${type} 的响应在 1000ms 内没有到达`);
  return result as PageState;
}

/**
 * 投一条**内容脚本有意不处理**的消息：返回监听器的返回值与它有没有响应。
 * 用来钉住"这条消息没人管"（右键菜单的划词消息、陌生的 type 都该走这条路）。
 */
function dispatchIgnored(
  contentListener: MessageListener,
  message: unknown,
): { returned: boolean | undefined; responded: boolean } {
  let responded = false;
  const returned = contentListener(message, { id: 'jinyi-test' }, () => {
    responded = true;
  });
  return { returned, responded };
}

/**
 * 与 `dispatch` 同形，但**不挂兜底计时器**。只在用例自己推动假定时器时使用：
 * `dispatch` 那个 1000ms 的兜底计时器同样是假的，推时间时会先于被测的 60 秒超时触发，
 * 用例就变成了"测试自己超时"而不是"被测超时"。
 */
async function dispatchWithoutFallbackTimer(
  contentListener: MessageListener,
  type: string,
  payload?: unknown,
): Promise<PageState> {
  let responded = false;
  let settle: ((response: unknown) => void) | undefined;
  const response = new Promise<unknown>((resolve) => {
    settle = resolve;
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

  return (await response) as PageState;
}

/**
 * 内容脚本发出的翻译请求，按顺序解析出 items（id 是随机的，只取文本）。
 *
 * `dispatch` 直接投给内容脚本，所以对端替身的 `mock.calls` 里本来就只该有翻译请求
 * （真机上后台也只收得到这一类）；仍然筛一遍，免得将来别处再走 `dispatchMessage` 时静默串味。
 */
function translateRequests(worker: MockInstance<MessageListener>): SentMessage[] {
  return worker.mock.calls
    .map(([message]) => message as SentMessage)
    .filter((message) => isTranslateRequest(message));
}

function sentBatches(worker: MockInstance<MessageListener>): Array<Array<{ id: string; text: string }>> {
  return translateRequests(worker).map((message) => message.payload.items);
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

/**
 * 元素里**可见**的文本：跳过被藏起来的原文（`display:none` 的 span），译文读宿主的
 * Shadow DOM。`textContent` 分不出可见性——「仅译文」模式正是靠"原文还在、只是不可见"
 * 实现的，用它断言"只剩译文"会永远成立。
 */
function visibleTextOf(element: Element): string {
  const pieces: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      pieces.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (child.tagName === 'JY-TRANSLATION') {
      pieces.push(bodyTextOf(child));
      return;
    }
    if (child.ownerDocument.defaultView?.getComputedStyle(child).display === 'none') return;
    for (const grandChild of Array.from(child.childNodes)) walk(grandChild);
  };
  for (const child of Array.from(element.childNodes)) walk(child);
  return pieces.join('');
}

function hasRetryButton(host: Element): boolean {
  return host.shadowRoot?.querySelector('.jy-retry') !== null;
}

function authedHosts(): Element[] {
  return hosts().filter((host) => bodyTextOf(host).includes('译'));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时：条件始终不成立');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 让已经排队的微任务链（替身的即时响应 → 浮层渲染）跑完。 */
async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 参照实现：与 `core/lang.ts` 的 `isTranslatableText` 无关地算一遍"这段文字值不值得翻"，
 * 用来在用例里独立算出期望的段落集合（含 `\p{N}`，见那边 2 个字母/数字的门槛）。
 */
function looksTranslatable(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 2 && (trimmed.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 2;
}

/** `Hello world` → `译:Hello world`：让"哪段原文对应哪条译文"一眼可辨。 */
function translate(text: string): string {
  return `译:${text}`;
}

function failure(id: string, code: TranslateItemResult['code'], message: string): TranslateItemResult {
  return { id, text: null, code, message };
}

/** 跨进程边界上的消息是 unknown：按形状收窄，顺带钉住"内容脚本发的是翻译请求"。 */
function asTranslateRequest(message: unknown): SentMessage {
  const received = message as SentMessage;
  expect(received.type).toBe(MSG.TRANSLATE_TEXTS);
  expect(Array.isArray(received.payload.items)).toBe(true);
  return received;
}

/** 对端替身：逐条成功回话。 */
function autoReply(textOf: (text: string) => string = translate): FakeWorker {
  return (message, _sender, sendResponse) => {
    if (!isTranslateRequest(message)) return false;
    const { items } = asTranslateRequest(message).payload;
    sendResponse({ ok: true, results: items.map((item) => ({ id: item.id, text: textOf(item.text) })) });
    return true;
  };
}

/** 对端替身：每个条目都按给的错误回话（条目级失败的真实形状）。 */
function engineErrorReply(code: TranslateItemResult['code'], message: string): FakeWorker {
  return (received, _sender, sendResponse) => {
    if (!isTranslateRequest(received)) return false;
    const { items } = asTranslateRequest(received).payload;
    sendResponse({ ok: true, results: items.map((item) => failure(item.id, code, message)) });
    return true;
  };
}

/**
 * 用例之间必须把 toast 也清掉：它挂在 `documentElement` 上（有意不受页面布局影响），
 * 清 `body.innerHTML` 是清不掉的，上一条用例的提示会漏到下一条里。
 */
function clearToast(): void {
  for (const host of Array.from(document.querySelectorAll('[data-jy-root]'))) host.remove();
}

/**
 * 数"这一轮一共新建了几个 toast 节点"，也就是 `toast()` 真实被调用的次数。
 *
 * `toast()` 每次都先删旧节点再建新节点（`content/toast.ts`），所以 `#jy-toast` 的数量
 * 在任何时刻都只有 0 或 1——调用 3 次也仍然只有 1 个节点，数节点证明不了"只弹一次"。
 * MutationObserver 记的是每一次新增，`count()` 会把还没投递的记录一起收进来
 * （回调与 `takeRecords()` 是两条互斥的投递路径，同一条记录只会计一次）。
 */
function watchToastInserts(): { count: () => number; stop: () => void } {
  const inserted: Element[] = [];
  const collect = (records: MutationRecord[]): void => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof Element && node.id === 'jy-toast') inserted.push(node);
      }
    }
  };
  const observer = new MutationObserver(collect);
  observer.observe(document.documentElement, { childList: true });
  return {
    count: () => {
      collect(observer.takeRecords());
      return inserted.length;
    },
    stop: () => observer.disconnect(),
  };
}

beforeEach(async () => {
  document.body.innerHTML = '';
  clearToast();
  vi.resetModules();
  chromeStub = installChromeStub();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('内容脚本编排：翻译整页', () => {
  it('页面上没有可翻译内容时给出提示，且一次请求都不发', async () => {
    mount('<div><button>点击</button></div>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(sentBatches(worker)).toEqual([]);
    expect(state).toEqual({ translated: false, mode: 'translated-only', total: 0, done: 0, failed: 0 });

    const toastHost = document.getElementById('jy-toast');
    expect(toastHost).not.toBeNull();
    expect(toastHost?.shadowRoot?.textContent).toContain('没有找到需要翻译的内容');
  });

  it('正常链路：抽取 → 分批 → 渲染，译文宿主出现在对应原文旁边', async () => {
    mount(
      [
        '<article>',
        '  <h1>Hello world</h1>',
        '  <p>Second paragraph here</p>',
        '  <div id="box">Intro sentence<p id="body">Nested body text</p></div>',
        '  <p>42</p>',
        '</article>',
      ].join(''),
    );
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    const expected = ['Hello world', 'Second paragraph here', 'Intro sentence', 'Nested body text'].filter(
      looksTranslatable,
    );
    expect(state).toEqual({ translated: true, mode: 'translated-only', total: 4, done: 4, failed: 0 });

    // 每段原文都被藏进自己的 `[data-jy-originals]` span，且它的译文宿主紧跟在这个 span 后面：
    // 整元素段落（h1 / p）里就是宿主在元素内部、span 之后；
    // 松散文本段（#box 的直接文本）里 span 与宿主也都留在容器内部，落在紧随其后的块级子元素之前。
    for (const text of expected) {
      const hidden = Array.from(document.querySelectorAll('article [data-jy-originals]')).find(
        (span) => span.textContent === text,
      );
      expect(hidden, `找不到这段原文藏在哪里：${text}`).toBeDefined();
      const host = hidden?.nextElementSibling;
      expect(host?.tagName, `${text} 的译文宿主不在它的原文后面`).toBe('JY-TRANSLATION');
      expect(bodyTextOf(host as Element)).toBe(translate(text));
    }
    // 松散文本段的原文与宿主都必须留在容器内部、在 Body 之前（跑出去或被隔开就错位了）。
    const box = document.getElementById('box') as HTMLElement;
    const body = document.getElementById('body') as HTMLElement;
    const boxOrder = Array.from(box.childNodes).map((node) =>
      node.nodeType === Node.TEXT_NODE ? '#text' : (node as Element).nodeName,
    );
    expect(boxOrder).toEqual(['SPAN', 'JY-TRANSLATION', 'P']);
    // Intro 的隐藏原文与译本都排在 Body 之前 —— 否则「Intro 译文 / Outro 译文」会一起挤到 Body 后面。
    expect(box.firstElementChild?.hasAttribute('data-jy-originals')).toBe(true);
    expect(box.firstElementChild?.nextElementSibling?.tagName).toBe('JY-TRANSLATION');
    expect(box.lastElementChild).toBe(body);
    expect(hosts()).toHaveLength(expected.length);

    const batches = sentBatches(worker);
    expect(batches.flat().map((item) => item.text).sort()).toEqual([...expected].sort());
  });

  /**
   * 用户主诉求（digitalocean 顶部导航 Products/Solutions/Developers/Partners 完全没被翻）：
   * 按钮文字从 SKIP_TAGS 放开后，双语与仅译文两种显示模式都要走到"发请求→渲染"。
   */
  it('仅译文模式：导航按钮里的文字被翻译', async () => {
    mount(
      '<nav><ul><li><button type="button" aria-expanded="false">' +
        '<span>Products</span><svg viewBox="0 0 12 12"><polyline points="2,4 6,8 10,4"/></svg>' +
        '</button></li><li><p>Pricing</p></li></ul></nav>',
    );
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(sentBatches(worker).flat().map((item) => item.text)).toEqual(['Products', 'Pricing']);
    expect(state.mode).toBe('translated-only');
    expect(state.total).toBe(2);
    expect(authedHosts().map((host) => bodyTextOf(host))).toEqual(['译:Products', '译:Pricing']);
  });

  it('双语模式：按钮文字同样被翻译，原文留在原位', async () => {
    await chromeStub.storage.local.set({
      [SETTINGS_KEY]: { version: CURRENT_VERSION, displayMode: 'bilingual' },
    });
    mount('<button>Products</button>');
    const button = document.querySelector('button') as HTMLElement;
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(sentBatches(worker).flat().map((item) => item.text)).toEqual(['Products']);
    expect(state.mode).toBe('bilingual');
    expect(bodyTextOf(hosts()[0] as Element)).toBe('译:Products');
    // 原文一个字符没动，双语宿主插在按钮之后。
    expect(button.textContent).toBe('Products');
    expect(button.nextElementSibling?.tagName).toBe('JY-TRANSLATION');
  });

  it('图标按钮不送接口：× / ☰ / 3 一个请求都不发（噪声闸还在）', async () => {
    mount(
      '<div><button type="button" aria-label="Close">×</button>' +
        '<button aria-label="Menu">☰</button><button>3</button></div>',
    );
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(sentBatches(worker)).toEqual([]);
    expect(state.total).toBe(0);
  });

  it('批次按设置切分：maxSegmentsPerBatch 为 1 时逐条发请求', async () => {
    await chromeStub.storage.local.set({
      'jinyi:settings': { version: 1, maxSegmentsPerBatch: 1, concurrency: 2 },
    });
    mount('<p>Alpha text</p><p>Beta text</p><p>Gamma text</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(sentBatches(worker).map((batch) => batch.length)).toEqual([1, 1, 1]);
    expect(authedHosts()).toHaveLength(3);
  });

  it('某条目返回 text: null 时渲染失败态且带重试按钮', async () => {
    mount('<p>Okay text</p><p>Broken text</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = asTranslateRequest(message).payload;
      sendResponse({
        ok: true,
        results: items.map((item) =>
          item.text === 'Broken text'
            ? failure(item.id, 'NETWORK', '网络错误')
            : { id: item.id, text: translate(item.text) },
        ),
      });
      return true;
    });

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(state).toEqual({ translated: true, mode: 'translated-only', total: 2, done: 1, failed: 1 });

    const broken = hosts().find((host) => bodyTextOf(host).includes('网络错误'));
    expect(broken).toBeDefined();
    expect(hasRetryButton(broken as Element)).toBe(true);
    // 部分失败不弹 toast：逐条标注已经够了。
    expect(document.getElementById('jy-toast')).toBeNull();
  });

  /**
   * 重试按钮的判据只有 `engines/types.ts` 的 `RETRYABLE_CODES` 一份，内容脚本复用它
   * （`isRetryable`）。这条用例逐码钉住"点了有没有用"：只有网络抖动与限流重发还有机会成功；
   * `AUTH` 重试多少次都是同一个结果（规格 §8：不重试，改为页面 toast）、`TOO_LONG` 该走
   * 切分降级、`BAD_RESPONSE` 重试同一个输入没有意义——给它们挂上按钮，用户只会对着注定
   * 失败的段落反复点。
   *
   * 期望值是**手写**的，不从 `RETRYABLE_CODES` 推导：用被测集合自己算期望值等于没测。
   */
  it('重试按钮只挂在可重试的错误码上（判据来自 RETRYABLE_CODES）', async () => {
    const cases: Array<{ code: TranslateItemResult['code']; label: string; retry: boolean }> = [
      { code: 'NETWORK', label: '网络抖动', retry: true },
      { code: 'RATE_LIMIT', label: '接口限流', retry: true },
      { code: 'AUTH', label: '鉴权失败', retry: false },
      { code: 'TOO_LONG', label: '文本过长', retry: false },
      { code: 'BAD_RESPONSE', label: '响应分段错乱', retry: false },
      { code: 'ABORTED', label: '请求已取消', retry: false },
      { code: 'UNKNOWN', label: '未知错误', retry: false },
      // 没有错误码的失败（响应形状不符、后台漏了这条）是"这次没拿到结果"，不是"这段翻不了"。
      { code: undefined, label: '没有错误码', retry: true },
    ];
    mount(cases.map((_entry, index) => `<p>Paragraph ${index}</p>`).join(''));
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = asTranslateRequest(message).payload;
      sendResponse({
        ok: true,
        results: items.map((item) => {
          const entry = cases[Number(item.text.replace('Paragraph ', ''))];
          return failure(item.id, entry?.code, entry?.label ?? '未知错误');
        }),
      });
      return true;
    });

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(state).toEqual({
      translated: true,
      mode: 'translated-only',
      total: cases.length,
      done: 0,
      failed: cases.length,
    });
    for (const entry of cases) {
      const host = hosts().find((candidate) => bodyTextOf(candidate).includes(entry.label));
      expect(host, `找不到「${entry.label}」的失败宿主`).toBeDefined();
      expect(hasRetryButton(host as Element), `${entry.code ?? '(无错误码)'} 的重试判据不对`).toBe(entry.retry);
    }
  });

  it('全部条目网络失败时，toast 要指出「接口到不了」并指向设置页', async () => {
    // 这不是假想场景：默认的免费 Google 接口在很多网络下被完全阻断，
    // 表现就是整批 NETWORK 失败。只说"翻译失败"会让用户以为插件坏了，
    // 而真正该做的是去设置页换成自己能访问的接口（规格 §8「免费接口失效」）。
    mount('<p>First text</p><p>Second text</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(engineErrorReply('NETWORK', '免费接口请求失败：The operation was aborted'));

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(state.failed).toBe(2);
    const toastText = document.getElementById('jy-toast')?.shadowRoot?.textContent ?? '';
    expect(toastText).toContain('免费接口请求失败');
    // 必须给出可执行的下一步，而不是让用户对着"翻译失败"发呆。
    expect(toastText).toContain('到不了');
    expect(toastText).toContain('扩展设置');
    expect(toastText).toContain('自定义 API');
    // 网络错误是瞬时错误（RETRYABLE_CODES），逐段重试按钮要保留。
    for (const host of hosts()) expect(hasRetryButton(host)).toBe(true);
  });

  it('全部条目同码失败（AUTH）时整轮只弹一次 toast，且不挂重试按钮', async () => {
    // 必须按 1 条一批：默认 12 条一批会把三段塞进同一个请求，那样"等整批回完才弹"只是
    // "请求还没回来"的同义反复（审查实测：requestCount = 1）。
    await chromeStub.storage.local.set({
      'jinyi:settings': { version: 1, maxSegmentsPerBatch: 1, concurrency: 1 },
    });
    mount('<p>First text</p><p>Second text</p><p>Third text</p>');
    const { worker, contentListener } = await loadContentScript();
    const toasts = watchToastInserts();
    // 第三条故意挂住：验证 toast 是**整轮跑完**才弹的，不是前几批回来就弹。
    let releaseThird: (() => void) | undefined;
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = asTranslateRequest(message).payload;
      const results = items.map((item) => failure(item.id, 'AUTH', '尚未填写 API Key，请在设置中配置'));
      if (items.some((item) => item.text === 'Third text')) {
        releaseThird = () => sendResponse({ ok: true, results });
        return true;
      }
      sendResponse({ ok: true, results });
      return true;
    });

    const pending = dispatch(contentListener, MSG.TRANSLATE_PAGE);
    await waitFor(() => releaseThird !== undefined);
    // 前两批已经回来、错误标注已经落地——所以下面"还没弹"不是"请求还没回来"的同义反复。
    expect(hosts().filter((host) => bodyTextOf(host).includes('尚未填写 API Key'))).toHaveLength(2);
    expect(toasts.count()).toBe(0);

    releaseThird?.();
    const state = await pending;

    expect(state).toEqual({ translated: true, mode: 'translated-only', total: 3, done: 0, failed: 3 });
    expect(hosts()).toHaveLength(3);
    for (const host of hosts()) {
      expect(bodyTextOf(host)).toContain('尚未填写 API Key');
      // 重试多少次都是同一个结果（规格 §8）：不挂按钮，只标原因。
      expect(hasRetryButton(host)).toBe(false);
    }

    const toastHost = document.getElementById('jy-toast');
    expect(toastHost).not.toBeNull();
    expect(toastHost?.shadowRoot?.textContent).toContain('尚未填写 API Key');
    // 用户必须知道该去哪儿解决。
    expect(toastHost?.shadowRoot?.textContent).toContain('扩展设置');
    // 三个批次全 AUTH，但整轮只弹这一次（每批各弹一次的写法在这里是 3 次）。
    expect(toasts.count()).toBe(1);
    toasts.stop();
  });

  it('重复触发翻译不会重复挂宿主（renderer 守卫）', async () => {
    mount('<p>Hello world</p><p>Second paragraph here</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    const firstHosts = hosts();
    expect(firstHosts).toHaveLength(2);

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(hosts()).toHaveLength(2);
    expect(hosts()).toEqual(firstHosts);
    expect(state).toEqual({ translated: true, mode: 'translated-only', total: 2, done: 2, failed: 0 });
    expect(translateRequests(worker)).toHaveLength(1);
    // 光数宿主钉不住这条守卫：首次翻译已经给原文打了 `data-jy-translated`，第二次采集本
    // 来就采不到东西，删掉守卫也会走"没有找到需要翻译的内容"早退（审查实测照样全绿）。
    // 那次早退会弹提示，所以"一条提示都没有"才是守卫真正生效的读数。
    expect(document.getElementById('jy-toast')).toBeNull();

    // 页面在两次触发之间长出新内容也一样：已经有 renderer 就不再接管（要重来先还原），
    // 否则会再建一个 renderer 只翻新段落，先前那些宿主则永远失去还原入口。
    const extra = document.createElement('p');
    extra.textContent = 'Third paragraph here';
    document.body.append(extra);

    const again = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(hosts()).toHaveLength(2);
    expect(translateRequests(worker)).toHaveLength(1);
    expect(again).toEqual({ translated: true, mode: 'translated-only', total: 2, done: 2, failed: 0 });
    expect(document.getElementById('jy-toast')).toBeNull();
  });

  it('翻译进行中再触发两次都不会重复挂宿主（running 守卫）', async () => {
    mount('<p>Hello world</p>');
    const { worker, contentListener } = await loadContentScript();
    let releaseFirstBatch: (() => void) | undefined;
    let requests = 0;
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      requests += 1;
      // 挂住第一批，让第一次翻译停在"进行中"（不用计时器：真/假计时器切换容易假通过）。
      if (requests === 1) {
        releaseFirstBatch = () => sendResponse({ ok: true, results: [] });
        return true;
      }
      // 真有第二次请求就立刻回话：删掉守卫的变异体停在断言上，而不是 1000ms 超时上。
      sendResponse({ ok: true, results: [] });
      return true;
    });
    const first = dispatch(contentListener, MSG.TRANSLATE_PAGE);
    await waitFor(() => releaseFirstBatch !== undefined);
    expect(hosts()).toHaveLength(1);

    // 没有还原、这一轮还在飞：第二次与第三次触发都必须被 running 拦住，
    // 于是它们看到的是**在飞那一轮**的状态（renderer 已建好、还没跑完），而不是新起一轮。
    // 两次早退分别发生在"renderer 还没建好"与"renderer 已经建好"两种页面状态下，
    // 所以这条用例同时钉住了守卫的存在和它在 renderer 守卫之前的位置。
    const secondState = await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    const thirdState = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(hosts()).toHaveLength(1);
    expect(translateRequests(worker)).toHaveLength(1);
    expect(secondState).toEqual({ translated: true, mode: 'translated-only', total: 1, done: 0, failed: 0 });
    expect(thirdState).toEqual(secondState);

    releaseFirstBatch?.();
    await first;
    expect(hosts()).toHaveLength(1);
  });

  /**
   * 这条用例原来钉的是**错误行为**：还原之后立刻再触发翻译时，第二次触发被 running 守卫
   * 静默吞掉（响应照回，页面什么都不做）。它当时把"没有第二个宿主、没有第二个请求"当成
   * 期望，而那个现象正是缺陷本身——还原已经把 renderer 置空，此刻唯一能拦住第二次触发的
   * 就是 running，而 running 是上一轮的事，跟"页面现在是否需要翻译"无关。
   * Alt+T 连按两下（第一次翻译、第二次还原，再按一下翻译）就能触到这条路径。
   * 现在改成钉正确行为：还原接管在飞的一轮并当场放行下一次翻译。
   */
  it('还原后立即再触发翻译（running 守卫已释放）：第二轮真的跑起来', async () => {
    mount('<p>Hello world</p>');
    const { worker, contentListener } = await loadContentScript();
    let releaseFirst: (() => void) | undefined;
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      if (releaseFirst === undefined) {
        // 挂住第一批，让第一次翻译停在"进行中"（不用计时器：真/假计时器切换容易假通过）。
        releaseFirst = () => sendResponse({ ok: true, results: [] });
        return true;
      }
      const { items } = asTranslateRequest(message).payload;
      sendResponse({ ok: true, results: items.map((item) => ({ id: item.id, text: translate(item.text) })) });
      return true;
    });
    const first = dispatch(contentListener, MSG.TRANSLATE_PAGE);
    await waitFor(() => releaseFirst !== undefined);
    expect(hosts()).toHaveLength(1);

    // 还原把 renderer 置空了，但第一次翻译还在跑；此刻唯一还立着的守卫就是 running，
    // 所以"还原之后能不能再翻译"这条用例真正钉住的是它有没有被释放。
    expect(await dispatch(contentListener, MSG.RESTORE_PAGE)).toEqual({
      translated: false,
      mode: 'translated-only',
      total: 0,
      done: 0,
      failed: 0,
    });

    const secondState = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    // 第二轮必须真的发请求、真的挂宿主——不能被入口守卫吞掉（吞掉的表现是监听器
    // 照常回状态，用户却看到"没有译文、也没有任何提示"）。
    expect(translateRequests(worker)).toHaveLength(2);
    expect(hosts()).toHaveLength(1);
    expect(bodyTextOf(hosts()[0])).toBe(translate('Hello world'));
    expect(secondState).toEqual({ translated: true, mode: 'translated-only', total: 1, done: 1, failed: 0 });

    // 第一轮仍然在飞（它的响应还没回）：它收尾时不许再动这一轮的页面状态。
    releaseFirst?.();
    await first;

    expect(hosts()).toHaveLength(1);
    expect(bodyTextOf(hosts()[0])).toBe(translate('Hello world'));
    expect(document.getElementById('jy-toast')).toBeNull();
  });

  /**
   * 这条用例钉的是「跨世代不会互相破坏」这个**可观察结果**，不是 `if (mine === generation)`
   * 那道守卫本身。
   *
   * 变异测试的结论要如实记下来：把 finally 改成无条件 `running = false`（即去掉世代判断）后，
   * 这条用例**仍然通过**。插桩定位到的原因是——第三次触发必须与「还原后立即再触发」处于
   * 同一个同步调用栈才会被 running 守卫拦住，而任何异步延迟都会让它先撞上 `renderer` 守卫
   * （第二轮挂好宿主之后 renderer 恒非空）。也就是说在当前所有可达时序下，真正起作用的是
   * renderer 守卫，世代号是**防御性**的：它防的是将来有人在 renderer 建好之前插入 await。
   * 保留它是对的，但不要再声称某条用例「删掉守卫就会红」——那是没有证据的。
   */
  it('旧的一轮收尾不会破坏新一轮的状态与宿主（跨世代互不干扰）', async () => {
    mount('<p>Hello world</p>');
    const { worker, contentListener } = await loadContentScript();
    const releases = new Map<number, () => void>();
    let requests = 0;
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = asTranslateRequest(message).payload;
      requests += 1;
      releases.set(requests, () => {
        sendResponse({ ok: true, results: items.map((item) => ({ id: item.id, text: translate(item.text) })) });
      });
      return true;
    });

    const first = dispatch(contentListener, MSG.TRANSLATE_PAGE);
    await waitFor(() => releases.has(1));
    await dispatch(contentListener, MSG.RESTORE_PAGE);

    const second = dispatch(contentListener, MSG.TRANSLATE_PAGE);
    await waitFor(() => releases.has(2));
    const secondHost = hosts()[0];
    expect(secondHost).toBeDefined();
    expect(bodyTextOf(secondHost)).toContain('翻译中…');

    // 第一轮先结束，第二轮还在飞：第一轮的 finally 不能把第二轮的 running 守卫清掉。
    releases.get(1)?.();
    await first;
    expect(hosts()).toEqual([secondHost]);

    const thirdState = await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    expect(translateRequests(worker)).toHaveLength(2);
    expect(hosts()).toEqual([secondHost]);
    expect(thirdState).toEqual({ translated: true, mode: 'translated-only', total: 1, done: 0, failed: 0 });

    releases.get(2)?.();
    const secondState = await second;

    expect(secondState).toEqual({ translated: true, mode: 'translated-only', total: 1, done: 1, failed: 0 });
    expect(hosts()).toHaveLength(1);
    expect(bodyTextOf(hosts()[0])).toBe(translate('Hello world'));
  });

  it('还原后页面回到原状：无残留节点、无残留属性', async () => {
    const html = '<article><h1>Hello world</h1><div id="box">Intro sentence<p>Nested body text</p></div></article>';
    mount(html);
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    expect(hosts().length).toBeGreaterThan(0);

    const state = await dispatch(contentListener, MSG.RESTORE_PAGE);

    expect(state).toEqual({ translated: false, mode: 'translated-only', total: 0, done: 0, failed: 0 });
    expect(hosts()).toHaveLength(0);
    expect(document.body.innerHTML).toBe(html);
    expect(document.querySelector('[data-jy-root]')).toBeNull();
    expect(document.querySelector('[data-jy-id]')).toBeNull();
    expect(document.querySelector('[data-jy-translated]')).toBeNull();
  });

  it('默认显示模式就是「仅译文」：正文只剩译文，原文（含链接）完整地藏在 display:none 里', async () => {
    // 存储里什么都不写 —— 这条钉的就是**默认值**本身（DEFAULT_SETTINGS.displayMode）。
    mount('<p id="p">Click <a href="/x">here</a> now</p>');
    const p = document.getElementById('p') as HTMLElement;
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(state).toEqual({ translated: true, mode: 'translated-only', total: 1, done: 1, failed: 0 });

    const hidden = p.querySelector('[data-jy-originals]') as HTMLElement;
    expect(hidden).not.toBeNull();
    expect(hidden.style.display).toBe('none');
    // 原文一个节点都没销毁：文本、行内链接、href 全在，只是不可见。
    expect(hidden.textContent).toBe('Click here now');
    expect(hidden.querySelector('a')?.getAttribute('href')).toBe('/x');
    // 宿主在元素内部，可见文本只剩译文（双语模式是"原文 + 译文"两段）。
    const host = p.querySelector('jy-translation') as Element;
    expect(host.parentElement).toBe(p);
    expect(visibleTextOf(p)).toBe(translate('Click here now'));
  });

  it('还原逐字节：body.outerHTML 与翻译前完全相同（含链接、图片与嵌套结构）', async () => {
    const html = [
      '<article>',
      '<h1>Hello world</h1>',
      '<p>Click <a href="/x">here</a> now</p>',
      '<p>An image <img src="a.png" alt="pic"> inside</p>',
      '<div id="box">Intro sentence<p>Nested body text</p>Outro sentence</div>',
      '<table><tbody><tr><td>Cell text</td><td>Second cell</td></tr></tbody></table>',
      '<ul><li>Item text</li></ul>',
      '<p>Line one<br>Line two</p>',
      '</article>',
    ].join('');
    mount(html);
    const before = document.body.outerHTML;
    const { worker, contentListener } = await loadContentScript();
    // 译文用固定标记、不含原文：这样"可见文本里只有译文"才是一条真断言。
    worker.mockImplementation(autoReply(() => 'MOCK'));

    await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    // 一段可能有多个隐藏容器（不承载文字的节点留原位会把搬走的断成几串），
    // 所以"可见的只有译文"的计数基准是译文宿主数，不是 span 数。
    const hidden = document.querySelectorAll('[data-jy-originals]');
    expect(hidden.length).toBeGreaterThan(5);
    expect(visibleTextOf(document.body)).toBe('MOCK'.repeat(hosts().length));
    expect(hosts().length).toBeGreaterThan(5);
    expect(hidden.length).toBeGreaterThanOrEqual(hosts().length);

    await dispatch(contentListener, MSG.RESTORE_PAGE);

    expect(document.body.outerHTML).toBe(before);
    expect(
      document.querySelectorAll(
        '[data-jy-root],[data-jy-originals],[data-jy-id],[data-jy-translated],[data-jy-for]',
      ),
    ).toHaveLength(0);
  });

  it('TOGGLE_PAGE 在"已翻译"与"还原"之间切换', async () => {
    mount('<p>Hello world</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    const translated = await dispatch(contentListener, MSG.TOGGLE_PAGE);
    expect(translated.translated).toBe(true);
    expect(hosts()).toHaveLength(1);

    const restored = await dispatch(contentListener, MSG.TOGGLE_PAGE);
    expect(restored.translated).toBe(false);
    expect(hosts()).toHaveLength(0);
  });
});

describe('内容脚本编排：消息接口', () => {
  it('GET_PAGE_STATE 同步返回当前状态', async () => {
    mount('<p>Hello world</p>');
    const { contentListener } = await loadContentScript();

    const state = await dispatch(contentListener, MSG.GET_PAGE_STATE);
    expect(state).toEqual({ translated: false, mode: 'translated-only', total: 0, done: 0, failed: 0 });
  });

  /**
   * 右键菜单的选区消息从 Plan 1 的"有意忽略"变成实际实现（WU·Plan2 划词单元）：
   * 内容脚本接管并回执 `{ok:true}`；读不到选区时用菜单带来的 payload.text 兜底
   * （jsdom 的 `window.getSelection().rangeCount` 恒为 0，正是这条路径），
   * 发一条正常的 TRANSLATE_TEXTS 请求，结果进浮层，不动页面。
   */
  it('TRANSLATE_SELECTION 走划词路径：兜底文本发起一次翻译并显示在气泡里', async () => {
    mount('<p>Hello world</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    const result = dispatchIgnored(contentListener, {
      type: MSG.TRANSLATE_SELECTION,
      payload: { text: 'Hello world' },
    });
    expect(result.returned).toBe(false);
    expect(result.responded).toBe(true);
    await settle();

    const batches = sentBatches(worker);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((item) => item.text)).toEqual(['Hello world']);
    const bubble = document.querySelector('[data-jy-tooltip]');
    expect(bubble?.shadowRoot?.textContent).toContain('译:Hello world');
    // 浮层挂 documentElement：页面内容一个字节都不动。
    expect(document.body.innerHTML).toBe('<p>Hello world</p>');
    expect(hosts()).toHaveLength(0);
  });

  it('只处理自己的消息，陌生的 type 不会被误当成翻译请求', async () => {
    mount('<p>Hello world</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    const result = dispatchIgnored(contentListener, { type: 'jinyi:unknown-message' });

    expect(result.returned).toBe(false);
    expect(result.responded).toBe(false);
    expect(translateRequests(worker)).toHaveLength(0);
    expect(hosts()).toHaveLength(0);
  });
});

describe('内容脚本编排：失败与边界', () => {
  it('后台连不上（没有接收方）时给出失败态而不是永远停在翻译中', async () => {
    mount('<p>Hello world</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    chromeStub.runtime.noReceiver = true;

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(state.failed).toBe(1);
    expect(bodyTextOf(hosts()[0])).toContain('无法连接后台');
    // 这种失败是可重试的（SW 可能只是被回收了）：给按钮。
    expect(hasRetryButton(hosts()[0])).toBe(true);
  });

  /**
   * MV3 的 service worker 空闲约 30 秒会被回收。翻译中途被回收时 `sendMessage` 的
   * promise **可能永不兑现**（端口既不关闭也不报错），这一批就永远停在「翻译中…」：
   * `runPool` 永不 settle、`running` 永不释放，页面卡死且无法重试。
   *
   * 用一个**永不回话**的发送端钉住它。时间用假定时器推：推过 60 秒之前必须还停在
   * 「翻译中…」（超时不是立刻发生的），推过去之后这一批必须进失败态。
   */
  it('后台永不响应时本批超时进失败态：页面不卡死、可重试、重新翻译仍能工作', async () => {
    mount('<p>Hello world</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    const originalSendMessage = chromeStub.runtime.sendMessage;
    const delivered: unknown[] = [];
    const neverSettles = new Promise<never>(() => {});
    chromeStub.runtime.sendMessage = (message: unknown) => {
      delivered.push(message);
      return neverSettles;
    };

    vi.useFakeTimers();
    const pending = dispatchWithoutFallbackTimer(contentListener, MSG.TRANSLATE_PAGE);
    // 让设置读取、采集、分批这条微任务链走完，请求真的发出去。
    for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toHaveLength(1);
    expect(bodyTextOf(hosts()[0])).toContain('翻译中…');

    // 差 1 毫秒到点：仍在等（这条断言同时挡掉"把超时写成 0 或写在别处"的实现）。
    await vi.advanceTimersByTimeAsync(BACKGROUND_TIMEOUT_MS - 1);
    expect(bodyTextOf(hosts()[0])).toContain('翻译中…');

    await vi.advanceTimersByTimeAsync(1);
    const state = await pending;

    // 整批进失败态：不是永远 pending，也不是静默什么都不做。
    expect(state).toEqual({ translated: true, mode: 'translated-only', total: 1, done: 0, failed: 1 });
    expect(bodyTextOf(hosts()[0])).toContain('没有响应');
    expect(bodyTextOf(hosts()[0])).not.toContain('翻译中…');
    expect(hasRetryButton(hosts()[0])).toBe(true);

    // 超时后 running 守卫必须已经释放：还原 + 重新翻译要真的跑起来（卡死的实现里
    // 第二次触发会被入口守卫吞掉，表现是"响应照回、页面什么都不做"）。
    chromeStub.runtime.sendMessage = originalSendMessage;
    expect(await dispatchWithoutFallbackTimer(contentListener, MSG.RESTORE_PAGE)).toEqual({
      translated: false,
      mode: 'translated-only',
      total: 0,
      done: 0,
      failed: 0,
    });
    const again = await dispatchWithoutFallbackTimer(contentListener, MSG.TRANSLATE_PAGE);

    expect(again).toEqual({ translated: true, mode: 'translated-only', total: 1, done: 1, failed: 0 });
    expect(hosts()).toHaveLength(1);
    expect(bodyTextOf(hosts()[0])).toBe(translate('Hello world'));
  });

  it('响应级失败（ok: false）时标注该批条目并弹一次提示', async () => {
    mount('<p>Hello world</p><p>Second paragraph here</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation((_message, _sender, sendResponse) => {
      sendResponse({ ok: false, code: 'RATE_LIMIT', message: '接口限流，请稍后重试' });
      return true;
    });

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(state.failed).toBe(2);
    expect(hosts().every((host) => hasRetryButton(host))).toBe(true);
    expect(document.getElementById('jy-toast')?.shadowRoot?.textContent).toContain('限流');
  });

  it('响应级失败只算在本批头上：另一批已经译好的片段不会被算成失败', async () => {
    // 一批失败、一批成功要真的分成两批才会发生（审查探针用的是 1 条一批）。
    await chromeStub.storage.local.set({
      'jinyi:settings': { version: 1, maxSegmentsPerBatch: 1, concurrency: 1 },
    });
    mount('<p>First text</p><p>Second text</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = asTranslateRequest(message).payload;
      if (items[0]?.text === 'First text') {
        sendResponse({ ok: false, code: 'RATE_LIMIT', message: '接口限流，请稍后重试' });
        return true;
      }
      sendResponse({ ok: true, results: items.map((item) => ({ id: item.id, text: translate(item.text) })) });
      return true;
    });

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    // 标整页的写法会让"已经显示译文"的那段也算进 failed：done + failed > total（审查实测 1 + 2 > 2）。
    expect(state).toEqual({ translated: true, mode: 'translated-only', total: 2, done: 1, failed: 1 });
    expect(authedHosts()).toHaveLength(1);
    expect(bodyTextOf(authedHosts()[0])).toBe(translate('Second text'));
    // 失败批的条目照常标注并带重试按钮，整轮跑完弹一次提示。
    expect(hosts().filter((host) => hasRetryButton(host))).toHaveLength(1);
    expect(document.getElementById('jy-toast')?.shadowRoot?.textContent).toContain('限流');
  });

  it('响应里 results 是 undefined 时整批标注失败态并给重试，页面不会卡在「翻译中…」', async () => {
    mount('<p>Hello world</p><p>Second paragraph here</p>');
    const { worker, contentListener } = await loadContentScript();
    // 形状不符的响应：跨进程边界上类型断言是拦不住它的（真机上这就是后台/引擎版本不匹配）。
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      sendResponse({ ok: true });
      return true;
    });

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(hosts()).toHaveLength(2);
    for (const host of hosts()) {
      expect(bodyTextOf(host)).not.toContain('翻译中…');
      expect(hasRetryButton(host)).toBe(true);
    }
    expect(state).toEqual({ translated: true, mode: 'translated-only', total: 2, done: 0, failed: 2 });
    // 响应形状不对是一种失败，不是"什么也没发生"：用户至少要知道出了什么事。
    expect(document.getElementById('jy-toast')?.shadowRoot?.textContent).toContain('响应');
  });

  it('results 里的元素形状不对时：好的条目照常显示译文，坏的条目失败态可重试', async () => {
    mount('<p>Hello world</p><p>Second paragraph here</p><p>Third paragraph here</p>');
    const { worker, contentListener } = await loadContentScript();
    // 逐条坏形状混一条好的：一条是字符串（连对象都不是）、一条缺 id，
    // 剩下那条带着真 id 的必须照常落地（不能因为同批里有坏形状就整批丢弃）。
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = asTranslateRequest(message).payload;
      sendResponse({
        ok: true,
        results: items.map((item) => {
          if (item.text === 'Hello world') return 'oops';
          if (item.text === 'Second paragraph here') return { text: '没有 id' };
          return { id: item.id, text: translate(item.text) };
        }),
      });
      return true;
    });

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(state).toEqual({ translated: true, mode: 'translated-only', total: 3, done: 1, failed: 2 });
    expect(hosts()).toHaveLength(3);
    // 带真 id 的那条照常显示译文。注意不能用 `authedHosts()`（它按"含译字"筛）：
    // 失败文案「翻译响应格式不正确」里也有"译"字，那样三条都算"有译文"。
    const done = hosts().filter((host) => bodyTextOf(host).startsWith('译:'));
    expect(done).toHaveLength(1);
    expect(bodyTextOf(done[0])).toBe(translate('Third paragraph here'));
    // 形状不对的两条：明确失败态 + 可重试，绝不停在 pending。
    for (const host of hosts()) expect(bodyTextOf(host)).not.toContain('翻译中…');
    const broken = hosts().filter((host) => bodyTextOf(host).includes('翻译响应格式不正确'));
    expect(broken).toHaveLength(2);
    for (const host of broken) expect(hasRetryButton(host)).toBe(true);
    expect(document.getElementById('jy-toast')?.shadowRoot?.textContent).toContain('响应');
  });

  it('同一条消息重复发送不会出现第二个 toast 节点', async () => {
    mount('<p>First text</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(engineErrorReply('AUTH', '尚未填写 API Key，请在设置中配置'));

    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    // 还原后重来一次：第二次的 toast 应该替换掉第一个，而不是叠两个。
    await dispatch(contentListener, MSG.RESTORE_PAGE);
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(document.querySelectorAll('#jy-toast')).toHaveLength(1);
  });

  it('设置读不出来（版本高于本代码）时给出提示，而不是把弹窗吊死', async () => {
    // loadSettings 遇到比本代码更新的版本号会抛错——这是设置损坏/扩展回退的真实路径。
    await chromeStub.storage.local.set({ 'jinyi:settings': { version: 99 } });
    mount('<p>Hello world</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    // 响应必须到达（否则弹窗那边等到端口超时，用户只看到按钮没反应）。
    expect(state).toEqual({ translated: false, mode: 'translated-only', total: 0, done: 0, failed: 0 });
    expect(translateRequests(worker)).toHaveLength(0);
    expect(document.getElementById('jy-toast')?.shadowRoot?.textContent).toContain('设置版本');
  });
});

/**
 * 页面级提示的**择一**规则：`AUTH` > `RATE_LIMIT` > 其它。
 *
 * 反例（曾经的行为）：`lastError` 是无条件覆盖——第 1 批 AUTH（用户该去设置页填 Key）、
 * 第 5 批 NETWORK（瞬时抖动）时，最后弹出的是 NETWORK 那条。最需要用户采取行动
 * 的提示恰好最容易被后到的批次顶掉。以下用例两个方向都钉：把先后反过来，弹出的
 * **仍然**必须是优先级高的那条——证明判据是错误码，不是写入顺序。
 *
 * 每段独立成批（maxSegmentsPerBatch: 1）且并发 1：批次按文档顺序**依次**跑完，
 * "先到/后到"才由用例说了算，不是竞速的偶然结果。
 */
describe('内容脚本编排：页面级提示按错误码优先级择一', () => {
  const AUTH_MESSAGE = '尚未填写 API Key，请在设置中配置';
  const NETWORK_MESSAGE = '免费接口请求失败：socket hang up';
  const RATE_LIMIT_MESSAGE = '请求过于频繁（429），已暂停写入';

  /** 逐条失败（条目级，后台 translateBatch 的真实形状）；映射外的文本回成功。 */
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
            : failure(item.id, entry.code, entry.message);
        }),
      });
      return true;
    };
  }

  async function serialSingleSegmentBatches(): Promise<void> {
    await chromeStub.storage.local.set({
      'jinyi:settings': { version: 1, maxSegmentsPerBatch: 1, concurrency: 1 },
    });
  }

  function toastText(): string {
    return document.getElementById('jy-toast')?.shadowRoot?.textContent ?? '';
  }

  /** 跑一整轮并返回 toast 文案；结束后还原并清掉节点，供同一个用例做正反两轮。 */
  async function round(contentListener: MessageListener): Promise<string> {
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    const text = toastText();
    await dispatch(contentListener, MSG.RESTORE_PAGE);
    clearToast();
    return text;
  }

  it('AUTH 优先于 NETWORK：无论谁先到（NETWORK 文案绝不吞掉填 Key 的提示）', async () => {
    await serialSingleSegmentBatches();
    mount('<p>Alpha text</p><p>Beta text</p>');
    const { worker, contentListener } = await loadContentScript();

    // 正向：第 1 批 AUTH、第 2 批 NETWORK——旧实现弹出的是后写入的 NETWORK。
    worker.mockImplementation(
      codedFailureReply({
        'Alpha text': { code: 'AUTH', message: AUTH_MESSAGE },
        'Beta text': { code: 'NETWORK', message: NETWORK_MESSAGE },
      }),
    );
    const forward = await round(contentListener);
    expect(forward).toContain('尚未填写 API Key');
    expect(forward).not.toContain('socket hang up');

    // 反向：第 1 批 NETWORK、第 2 批 AUTH——弹出的仍然是 AUTH。
    // 两条合在一起证明"弹哪条"不由批次先后决定。
    worker.mockImplementation(
      codedFailureReply({
        'Alpha text': { code: 'NETWORK', message: NETWORK_MESSAGE },
        'Beta text': { code: 'AUTH', message: AUTH_MESSAGE },
      }),
    );
    const backward = await round(contentListener);
    expect(backward).toContain('尚未填写 API Key');
    expect(backward).not.toContain('socket hang up');
  });

  it('AUTH 优先于 NETWORK 且整轮只弹一次（同码多条也只在收尾弹一条）', async () => {
    await serialSingleSegmentBatches();
    mount('<p>Alpha text</p><p>Beta text</p><p>Gamma text</p>');
    const { worker, contentListener } = await loadContentScript();
    const toasts = watchToastInserts();
    worker.mockImplementation(
      codedFailureReply({
        'Alpha text': { code: 'AUTH', message: AUTH_MESSAGE },
        'Beta text': { code: 'NETWORK', message: NETWORK_MESSAGE },
        'Gamma text': { code: 'NETWORK', message: NETWORK_MESSAGE },
      }),
    );

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(state.failed).toBe(3);
    expect(toastText()).toContain('尚未填写 API Key');
    expect(toastText()).not.toContain('socket hang up');
    // 三个批次都有页面级候选，弹出次数仍然只有 1。
    expect(toasts.count()).toBe(1);
    toasts.stop();
  });

  it('RATE_LIMIT 优先于 NETWORK（但低于 AUTH）：两个方向都钉', async () => {
    await serialSingleSegmentBatches();
    mount('<p>Alpha text</p><p>Beta text</p>');
    const { worker, contentListener } = await loadContentScript();

    // 限流先到、网络抖动后到：弹限流。
    worker.mockImplementation(
      codedFailureReply({
        'Alpha text': { code: 'RATE_LIMIT', message: RATE_LIMIT_MESSAGE },
        'Beta text': { code: 'NETWORK', message: NETWORK_MESSAGE },
      }),
    );
    const forward = await round(contentListener);
    expect(forward).toContain('429');
    expect(forward).not.toContain('socket hang up');

    // 反过来：仍然弹限流。
    worker.mockImplementation(
      codedFailureReply({
        'Alpha text': { code: 'NETWORK', message: NETWORK_MESSAGE },
        'Beta text': { code: 'RATE_LIMIT', message: RATE_LIMIT_MESSAGE },
      }),
    );
    const backward = await round(contentListener);
    expect(backward).toContain('429');
    expect(backward).not.toContain('socket hang up');

    // AUTH 高于 RATE_LIMIT：限流先到也要被鉴权失败顶掉。
    worker.mockImplementation(
      codedFailureReply({
        'Alpha text': { code: 'RATE_LIMIT', message: RATE_LIMIT_MESSAGE },
        'Beta text': { code: 'AUTH', message: AUTH_MESSAGE },
      }),
    );
    const withAuth = await round(contentListener);
    expect(withAuth).toContain('尚未填写 API Key');
    expect(withAuth).not.toContain('429');
  });

  it('响应级失败（ok: false）也参与优先级：后到的 ok:false NETWORK 不顶掉先到的条目级 AUTH', async () => {
    await serialSingleSegmentBatches();
    mount('<p>Alpha text</p><p>Beta text</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = asTranslateRequest(message).payload;
      if (items[0]?.text === 'Alpha text') {
        sendResponse({ ok: true, results: items.map((item) => failure(item.id, 'AUTH', AUTH_MESSAGE)) });
        return true;
      }
      sendResponse({ ok: false, code: 'NETWORK', message: NETWORK_MESSAGE });
      return true;
    });

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(state.failed).toBe(2);
    expect(toastText()).toContain('尚未填写 API Key');
    expect(toastText()).not.toContain('socket hang up');
  });
});

/**
 * 整页翻译的**页内文本去重**（分批之前归并，见 translatePage）：
 *
 * 调度器只在单批内按文本去重，批次之间互相看不见——实测 apple.com 首页「Store」出现
 * 59 次、「Learn more」9 次，按默认 12 段/批要发 5 次重复请求。这里要求内容脚本在
 * **分批之前**按文本归并：唯一文本只请求一次，结果摊回给所有同文本段。
 *
 * 注意两条不变式（同样是断言的一部分）：
 * - 渲染、失败态、`finished`/`failedIds` 计数都按**段**算——去重省的是请求，不是段落；
 * - 重试只重试被点的那一段，不连带把同文本的其他段一起重译。
 */
describe('内容脚本编排：同一页面的重复文本去重到一次请求', () => {
  it('60 段相同 + 2 段不同：唯一文本各请求一次，62 段全部落地译文，计数按段算', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i += 1) lines.push('<p>Learn more</p>');
    lines.push('<p>Unique one</p>', '<p>Unique two</p>');
    mount(lines.join(''));
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    const texts = sentBatches(worker).flat().map((item) => item.text);
    // 每个唯一文本恰好一次——60 段 'Learn more' 不再摊成 5 批重发。
    expect(texts.filter((text) => text === 'Learn more')).toHaveLength(1);
    expect(texts.filter((text) => text === 'Unique one')).toHaveLength(1);
    expect(texts.filter((text) => text === 'Unique two')).toHaveLength(1);
    // 3 个唯一文本远不到 12 段/批的上限：整页恰好一个请求。
    expect(sentBatches(worker)).toHaveLength(1);
    // 统计按段：62 段全部完成，不是"去重后 3 段"。
    expect(state).toEqual({ translated: true, mode: 'translated-only', total: 62, done: 62, failed: 0 });
    expect(hosts()).toHaveLength(62);
    expect(hosts().filter((host) => bodyTextOf(host) === translate('Learn more'))).toHaveLength(60);
    expect(hosts().filter((host) => bodyTextOf(host) === translate('Unique one'))).toHaveLength(1);
    expect(hosts().filter((host) => bodyTextOf(host) === translate('Unique two'))).toHaveLength(1);
  });

  it('同文本段全部进失败态；点其中一段的重试只重译那一段', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i += 1) lines.push('<p>Dup text</p>');
    lines.push('<p>Unique one</p>');
    mount(lines.join(''));
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = asTranslateRequest(message).payload;
      sendResponse({
        ok: true,
        results: items.map((item) =>
          item.text === 'Dup text' ? failure(item.id, 'NETWORK', '网络抖动') : { id: item.id, text: translate(item.text) },
        ),
      });
      return true;
    });

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    // 去重后整页只有 2 个唯一文本 → 一个请求；但失败计数仍是 60 段。
    expect(sentBatches(worker)).toHaveLength(1);
    expect(state).toEqual({ translated: true, mode: 'translated-only', total: 61, done: 1, failed: 60 });
    const broken = hosts().filter((host) => bodyTextOf(host).includes('网络抖动'));
    expect(broken).toHaveLength(60);
    for (const host of broken) expect(hasRetryButton(host)).toBe(true);

    // 重试那一段**之前**先把对端换成回成功：只有被点的那一段会重发。
    worker.mockImplementation(autoReply());
    worker.mockClear();
    const firstBroken = broken[0]?.shadowRoot?.querySelector('.jy-retry') as HTMLButtonElement | null;
    expect(firstBroken).not.toBeNull();
    firstBroken?.click();
    await settle();

    const requests = translateRequests(worker);
    expect(requests).toHaveLength(1);
    expect(requests[0].payload.items).toHaveLength(1);
    expect(requests[0].payload.items[0]?.text).toBe('Dup text');
    // 只那一段有了译文；其余 59 段仍停在失败态（**没有**被连带重译）。
    expect(hosts().filter((host) => bodyTextOf(host) === translate('Dup text'))).toHaveLength(1);
    expect(hosts().filter((host) => bodyTextOf(host).includes('网络抖动'))).toHaveLength(59);
    const after = await dispatch(contentListener, MSG.GET_PAGE_STATE);
    expect(after).toEqual({ translated: true, mode: 'translated-only', total: 61, done: 2, failed: 59 });
  });

  it('同文本段的重试各自独立：再点另一段也只重发那一段', async () => {
    mount('<p>Dup text</p><p>Dup text</p><p>Dup text</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(engineErrorReply('NETWORK', '网络抖动'));

    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    expect(sentBatches(worker).flat().map((item) => item.text)).toEqual(['Dup text']);

    worker.mockImplementation(autoReply());
    worker.mockClear();
    const buttons = hosts().map((host) => host.shadowRoot?.querySelector('.jy-retry') as HTMLButtonElement | null);
    buttons[2]?.click();
    await settle();

    expect(translateRequests(worker)).toHaveLength(1);
    expect(hosts().filter((host) => bodyTextOf(host) === translate('Dup text'))).toHaveLength(1);
    expect(hosts().filter((host) => bodyTextOf(host).includes('网络抖动'))).toHaveLength(2);
    // 前两段仍可各自点重试（互不牵连）。
    expect(hasRetryButton(hosts().find((host) => bodyTextOf(host).includes('网络抖动')) as Element)).toBe(true);
    void buttons;
  });
});

/**
 * 页面级假名上下文（修「纯汉字日文被静默跳过」的已知限制）：
 *
 * `shouldSkip` 在单段层面分不出"中文"与"只用汉字的日文"，所以采集前对整页做一次
 * 廉价扫描（`document.body.textContent` 是否含假名），结果作为本轮判据传给采集层：
 * 含假名 → 本轮不因"看起来已是中文"而跳过；不含假名 → 行为与今天逐字相同
 * （中文页面翻中文仍然零请求）。扫描每轮只做一次，绝不是每段一次。
 */
describe('内容脚本编排：含假名页面的纯汉字段落不再被跳过', () => {
  /**
   * 数 `document.body.textContent` 被读了多少次（假名扫描的读数）。
   * 在 body 上盖一个**自有**访问器、代理回原型 getter：jsdom 里现有生产代码
   * 没有任何一处读 body.textContent（extractor 走 childNodes / nodeValue），
   * 所以这里的计数只可能来自本轮页面扫描。用例结束必须还原，否则会漏进后续用例。
   */
  function spyOnBodyTextContent(): { count: () => number; restore: () => void } {
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
    return {
      count: () => reads,
      restore: () => {
        delete (document.body as unknown as { textContent?: unknown }).textContent;
      },
    };
  }

  it('日文页面（含假名）：纯汉字段落照常送翻并落地译文', async () => {
    // '日本橋三丁目' 不含任何假名、也没有简繁特征字——默认判据下"已是简体中文"，
    // 修复前会被整段静默跳过；但它躺在一个有假名的页面上，更可能是日文地名。
    mount('<p>本日はお日柄もよく</p><p>日本橋三丁目</p><p>English side note here</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    const texts = sentBatches(worker).flat().map((item) => item.text);
    expect(texts).toContain('日本橋三丁目');
    expect(state).toEqual({ translated: true, mode: 'translated-only', total: 3, done: 3, failed: 0 });
    expect(hosts().filter((host) => bodyTextOf(host) === translate('日本橋三丁目'))).toHaveLength(1);
  });

  it('纯中文页面（无假名）目标中文：仍然整体跳过、零请求——旧行为逐字不变', async () => {
    mount('<p>这是一段中文内容</p><p>另一段中文内容在这里</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(sentBatches(worker)).toEqual([]);
    expect(state).toEqual({ translated: false, mode: 'translated-only', total: 0, done: 0, failed: 0 });
    expect(document.getElementById('jy-toast')?.shadowRoot?.textContent).toContain('没有找到需要翻译的内容');
  });

  it('页面扫描整轮只做一次：60 段页面里 body 全文只读一遍', async () => {
    const lines: string[] = ['<p>本日はお日柄もよく</p>'];
    for (let i = 0; i < 60; i += 1) lines.push(`<p>段落${String(i)}号の内容です</p>`);
    mount(lines.join(''));
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    const scan = spyOnBodyTextContent();
    try {
      await dispatch(contentListener, MSG.TRANSLATE_PAGE);
      // 恰好 1 次：0 = 没扫描（纯汉字段会被跳过），61 = 每段扫一遍（性能红线）。
      expect(scan.count()).toBe(1);
      // 扫描确实用上了：全部段落都进了请求（含无假名的纯汉字段）。
      expect(sentBatches(worker).flat()).toHaveLength(61);
    } finally {
      scan.restore();
    }
  });
});

/**
 * 重试的语言来源（一致性问题）：整页与增量都吃 `pageSnapshot`——"中途改语言，
 * 本页面要重来才生效"是快照写明的语义。重试若改用**当前**设置，用户改过目标语言后
 * 点某个旧失败段的重试，就会出现"那一段新语言、其余旧语言"的一语双语墙。
 * 另一半分工（Key / 接口配置走最新值）由 `tests/background/service-worker.test.ts`
 * 钉：后台每条消息现读设置，内容脚本这条路上本来就不携带任何凭据。
 */
describe('内容脚本编排：重试语言跟随页面快照', () => {
  it('翻译时快照 zh-Hans、之后设置改成 ja：点失败段的重试仍按 zh-Hans 发请求', async () => {
    await chromeStub.storage.local.set({
      [SETTINGS_KEY]: { version: CURRENT_VERSION, targetLang: 'zh-Hans' },
    });
    mount('<p>First broken paragraph</p><p>Second fine paragraph</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = asTranslateRequest(message).payload;
      sendResponse({
        ok: true,
        results: items.map((item) =>
          item.text === 'First broken paragraph'
            ? failure(item.id, 'NETWORK', '网络抖动')
            : { id: item.id, text: translate(item.text) },
        ),
      });
      return true;
    });

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    expect(state.failed).toBe(1);
    // 整页那一批带的是快照语言。
    expect(translateRequests(worker)[0]?.payload.targetLang).toBe('zh-Hans');

    // 用户去设置页把目标语言改成 ja。
    await chromeStub.storage.local.set({
      [SETTINGS_KEY]: { version: CURRENT_VERSION, targetLang: 'ja' },
    });

    // 点失败那一段的「重试」。
    const retry = hosts()
      .find((host) => bodyTextOf(host).includes('网络抖动'))
      ?.shadowRoot?.querySelector('.jy-retry') as HTMLButtonElement | null;
    expect(retry).not.toBeNull();
    retry?.click();
    await settle();

    const requests = translateRequests(worker);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.payload.items.map((item) => item.text)).toEqual(['First broken paragraph']);
    // 承重断言：重试的语言仍是**页面快照**的 zh-Hans，不是当前设置里的 ja。
    expect(requests[1]?.payload.targetLang).toBe('zh-Hans');
  });
});

/**
 * 站点规则「永不翻译」在内容脚本里的**唯一**拦截点（规格 2026-09-18 §5 与 §11）。
 *
 * 夹具一律沿用本文件已有的三样，不另造机制：
 * ① 写设置 = `chromeStub.storage.local.set({ [SETTINGS_KEY]: { … } })`（设置每轮翻译现读，
 *    所以同一条用例中间还能改它——「守卫已收回」那条就靠这个模拟"用户去设置页解除规则"）；
 * ② 派发消息 = `dispatch(contentListener, MSG.*)`；
 * ③ "零请求" = `translateRequests(worker)`（对端替身真实收到的 TRANSLATE_TEXTS 条数）。
 * toast 的读法也用文件里到处都在用的那句
 * `document.getElementById('jy-toast')?.shadowRoot?.textContent`：已有的 `toastText()`
 * 只住在"页面级提示择一"那个 describe 内部，在本 describe 的作用域之外。
 *
 * 主机名由 `vi.stubGlobal('location', …)` 控制（实测本仓库 jsdom + vitest 5 下 `location`
 * 是可配置的访问器，stub 与 `unstubAllGlobals()` 都生效）。清理挂在下面的 `afterEach` 上而
 * **不是**每条用例末尾那一句：断言一失败就走不到末尾，泄漏的 `location` 会被后面的用例读到
 * （实测：A 条失败后 B 条读到上一条的主机名）。本仓库 `vitest.config.ts` 只有
 * `restoreMocks: true`，没有 `unstubGlobals: true`，所以 vitest 不会替谁自动 unstub——
 * "每条自己收尾"那种写法今天不出事纯属两个隐式前提（每条都先自己 stub + 这个 describe
 * 恰好住在文件末尾），而前提是会被人打破的：将来在文件尾部再追一个 describe，
 * 它就会静默继承 `blocked.example.com`。
 */
describe('内容脚本编排：站点规则「永不翻译」只拦整页翻译', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('站点规则命中 never：不采集、零请求、给一句能读懂的话', async () => {
    // 主机名要可控：内容脚本读的是 location.hostname。
    vi.stubGlobal('location', { hostname: 'blocked.example.com' });
    await chromeStub.storage.local.set({
      [SETTINGS_KEY]: {
        version: CURRENT_VERSION,
        siteRules: [{ pattern: '*.example.com', action: 'never' }],
      },
    });
    // 页面上必须有**本来会被翻走**的内容，否则"零请求"可能只是"没东西可翻"的同义反复。
    mount('<p>Hello world</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    const before = document.body.innerHTML;

    await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(translateRequests(worker).length).toBe(0); // 一个翻译请求都不许发出去
    expect(document.body.innerHTML).toBe(before); // 一个字节都不许多（采集的副作用也没落地）
    const toastText = document.getElementById('jy-toast')?.shadowRoot?.textContent ?? '';
    expect(toastText).toContain('永不翻译');
    // 光有"永不翻译"三个字不够：得告诉用户去哪儿解除，否则这是一句查不出原因的拒绝。
    // 解除入口是**扩展弹窗**里那条站点规则提示行的「解除」按钮（Task 3 落的）；这里指名的
    // 必须是那个真实存在的入口——"设置 › 站点规则"编辑器属单元 B，今天还不存在。
    expect(toastText).toContain('弹窗');
    // 反向也钉住：不许再指向设置页（那是把用户指进空处），也不许含糊地只说"设置里"。
    expect(toastText).not.toContain('设置');
    // 采集没跑 → 连 `data-jy-id` / `data-jy-translated` 这类"已处理"标记都不该留下
    // （innerHTML 相等已经覆盖，这里点名是因为这几处标记是"拦晚了就永久脏掉页面"的东西）。
    // 查询限定在 body 内：toast 自己就带 `data-jy-root` 且有意挂在 documentElement 上，
    // 从 document 往下找会把那句提示当成一个残留的译文宿主。
    expect(
      document.body.querySelector('[data-jy-id],[data-jy-translated],[data-jy-root],[data-jy-originals]'),
    ).toBeNull();
  });

  /**
   * 钉住**闸的落点**，而不是只钉"有没有闸"。
   *
   * 三个整页翻译入口里只有右键菜单发 `TRANSLATE_PAGE`（`background/service-worker.ts:76`）；
   * Alt+T（同文件 `:70` 的 `toggle-translate`）与弹窗主按钮（`popup/popup.ts:278`）
   * 发的都是 `TOGGLE_PAGE`——**两个入口走这一条**。拦在 `translatePage()` 里对两条都成立，
   * 但这句话必须有读数：把闸挪进消息层 `if (type === MSG.TRANSLATE_PAGE)` 那个分支
   * （最自然的错误落点）时，本 describe 其余用例派发的是 TRANSLATE_PAGE、TOGGLE_PAGE 的
   * **还原方向**与划词消息，没有一条走"未翻译 + TOGGLE_PAGE"这条路——全仓 853 条全绿。
   * 这条就是那一个读数。
   *
   * 前提是页面**还没翻译**（未翻译态才会进 `runTranslate()`；已翻译态走 restorePage()，
   * 那是隔壁那条"还原不受约束"的用例管的方向）。
   */
  it('Alt+T / 弹窗主按钮那条路（TOGGLE_PAGE）同样被拦：未翻译的 never 站不新起一轮', async () => {
    vi.stubGlobal('location', { hostname: 'blocked.example.com' });
    await chromeStub.storage.local.set({
      [SETTINGS_KEY]: {
        version: CURRENT_VERSION,
        siteRules: [{ pattern: '*.example.com', action: 'never' }],
      },
    });
    mount('<p>Hello world</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    const state = await dispatch(contentListener, MSG.TOGGLE_PAGE);

    // 三条读数是同一件事的三个面：没发请求、没建宿主、状态也说"这一页没在翻译"。
    expect(translateRequests(worker).length).toBe(0);
    expect(hosts()).toHaveLength(0);
    expect(state.translated).toBe(false);
    expect(document.getElementById('jy-toast')?.shadowRoot?.textContent ?? '').toContain('永不翻译');
  });

  /**
   * 这条是「命中就拦、不看 action」那个错误实现的**唯一**见证：其余用例都只喂 never 规则，
   * 把判据写成"`matchSiteRule(...) !== null`（任意动作都拦）"在它们身上读数不变；
   * 只有这条喂 translate 动作，它一红就说明 action 被忽略了。别当成冗余删掉。
   */
  it('站点规则是 translate 动作时不拦（今天它没有可观察行为）', async () => {
    vi.stubGlobal('location', { hostname: 'other.example.com' });
    await chromeStub.storage.local.set({
      [SETTINGS_KEY]: {
        version: CURRENT_VERSION,
        siteRules: [{ pattern: 'other.example.com', action: 'translate' }],
      },
    });
    mount('<p>Hello world</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(translateRequests(worker).length).toBeGreaterThan(0);
    // "有请求出去过"太弱：一轮全失败的请求也有请求。要的是**真的翻好了**（与守卫收回那条同强度）。
    expect(state.translated).toBe(true);
    expect(hosts()).toHaveLength(1);
    expect(bodyTextOf(hosts()[0])).toBe(translate('Hello world'));
  });

  it('还原不受规则约束：已翻译的页面命中 never 也要能撤掉', async () => {
    vi.stubGlobal('location', { hostname: 'blocked.example.com' });
    mount('<p>Hello world</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());
    // 先让页面处于已翻译状态（这条用例的前提是"规则落地时页面已经翻了"：
    // never 规则在翻译完成后才写进存储，正是用户"翻完这站好烦，去设置里拉黑"的真实顺序）。
    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    expect(hosts()).toHaveLength(1);
    await chromeStub.storage.local.set({
      [SETTINGS_KEY]: {
        version: CURRENT_VERSION,
        siteRules: [{ pattern: '*.example.com', action: 'never' }],
      },
    });

    // TOGGLE_PAGE 在已翻译时走 restorePage()，不经过 translatePage()：撤掉翻译不需要规则许可。
    await dispatch(contentListener, MSG.TOGGLE_PAGE);

    expect(document.querySelector('[data-jy-root]')).toBeNull();
    expect(hosts()).toHaveLength(0);
    // 还原也没有顺手再起一轮"被拦掉的"翻译：请求数还是翻译那一轮的那 1 条。
    expect(translateRequests(worker)).toHaveLength(1);
  });

  /**
   * 本 describe 最有价值的一条：**被拦下不等于把守卫卡住**。
   *
   * `translatePage()` 提前 return 之前必须把 `running` 收回 false，否则下一次翻译会被
   * 它自己的入口守卫静默吞掉——用户"解除规则后再按 Alt+T"看到的就是一片安静。
   * 这个 bug 本仓库真踩过（`restorePage()` 漏清 running，Alt+T 连按两下没反应），
   * 一个忘了复位的早退就是它换了个入口复发。删掉实现里那行 `running = false` 必须让这条红。
   */
  it('命中 never 被拦下之后守卫已收回：解除规则再触发一次要真的翻译', async () => {
    vi.stubGlobal('location', { hostname: 'blocked.example.com' });
    await chromeStub.storage.local.set({
      [SETTINGS_KEY]: {
        version: CURRENT_VERSION,
        siteRules: [{ pattern: '*.example.com', action: 'never' }],
      },
    });
    mount('<p>Hello world</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    // 第一轮：拦住，页面仍未翻译。
    expect((await dispatch(contentListener, MSG.TRANSLATE_PAGE)).translated).toBe(false);
    expect(translateRequests(worker)).toHaveLength(0);

    // 用户去设置页把这条规则删掉（存储现读，等同真机上的"解除后再按一下"）。
    await chromeStub.storage.local.set({
      [SETTINGS_KEY]: { version: CURRENT_VERSION, siteRules: [] },
    });

    // 第二轮：必须真的跑起来，而不是被卡住的 running 悄悄吞掉。
    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(translateRequests(worker)).toHaveLength(1);
    expect(hosts()).toHaveLength(1);
    expect(bodyTextOf(hosts()[0])).toBe(translate('Hello world'));
    expect(state).toEqual({ translated: true, mode: 'translated-only', total: 1, done: 1, failed: 0 });
  });

  /**
   * 划词**故意**不受本规则约束（规格 §11 已与用户确认：那是用户逐次主动发起的单段翻译，
   * 与"这站整页不该翻"是两件事）。这条钉的是别把闸拦到 `TRANSLATE_SELECTION` 分支上去。
   */
  it('命中 never 的站上右键划词照常翻：规则只管整页', async () => {
    vi.stubGlobal('location', { hostname: 'blocked.example.com' });
    await chromeStub.storage.local.set({
      [SETTINGS_KEY]: {
        version: CURRENT_VERSION,
        siteRules: [{ pattern: '*.example.com', action: 'never' }],
      },
    });
    mount('<p>Hello world</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    const result = dispatchIgnored(contentListener, {
      type: MSG.TRANSLATE_SELECTION,
      payload: { text: 'Hello world' },
    });
    expect(result.responded).toBe(true);
    await settle();

    expect(sentBatches(worker).flat().map((item) => item.text)).toEqual(['Hello world']);
    expect(document.querySelector('[data-jy-tooltip]')?.shadowRoot?.textContent).toContain('译:Hello world');
    // 页面一个字节都不动：划词本来就不写页面，规则也不该把它一起掐掉。
    expect(document.body.innerHTML).toBe('<p>Hello world</p>');
  });
});
