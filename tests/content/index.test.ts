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

    const hidden = document.querySelectorAll('[data-jy-originals]');
    expect(hidden.length).toBeGreaterThan(5);
    expect(visibleTextOf(document.body)).toBe('MOCK'.repeat(hidden.length));

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

  it('TRANSLATE_SELECTION 被忽略：不报错、不发请求、不改页面', async () => {
    mount('<p>Hello world</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    const result = dispatchIgnored(contentListener, {
      type: MSG.TRANSLATE_SELECTION,
      payload: { text: 'Hello world' },
    });

    // Plan 1 没有划词气泡：内容脚本不接管这条消息（返回 false 即"没人处理"），
    // 也不会响应——后台那边的 tabs.sendMessage 照常收尾，不会变成未处理的拒绝。
    expect(result.returned).toBe(false);
    expect(result.responded).toBe(false);
    expect(translateRequests(worker)).toHaveLength(0);
    expect(hosts()).toHaveLength(0);
    expect(document.getElementById('jy-toast')).toBeNull();
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
