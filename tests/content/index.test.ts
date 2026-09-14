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

function hasRetryButton(host: Element): boolean {
  return host.shadowRoot?.querySelector('.jy-retry') !== null;
}

/**
 * 元素**自己的直接文本**（不含后代）。松散文本段的锚点是容器，容器的
 * `textContent` 会把里面的块级子元素也算进去，用它找原文会找错元素。
 */
function directTextOf(element: Element): string {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.nodeValue ?? '')
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
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
    expect(state).toEqual({ translated: false, mode: 'bilingual', total: 0, done: 0, failed: 0 });

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
    expect(state).toEqual({ translated: true, mode: 'bilingual', total: 4, done: 4, failed: 0 });

    // 每段原文都配一个宿主，且宿主插在它的原文旁边：
    // - 整元素段落（h1 / p）：宿主是它的下一个兄弟；
    // - 松散文本段（#box 的直接文本）：宿主留在容器内部，落在紧随其后的块级子元素之前。
    for (const text of expected) {
      const sources = Array.from(document.querySelectorAll('article *')).filter(
        (element) => directTextOf(element) === text,
      );
      const source = sources[sources.length - 1];
      expect(source, `找不到原文元素：${text}`).toBeDefined();
      // 整元素段落：宿主是它的下一个兄弟；松散文本段（容器锚点）：宿主在容器内部。
      // 两种都取"原文旁最近的那个"——容器内部优先。
      const inside = Array.from(source?.children ?? []).find((child) => child.tagName === 'JY-TRANSLATION');
      const host = inside ?? source?.nextElementSibling;
      expect(host?.tagName, `${text} 的译文宿主不在原文旁边`).toBe('JY-TRANSLATION');
      expect(bodyTextOf(host as Element)).toBe(translate(text));
    }
    // 松散文本段的宿主必须留在容器内部、在 Body 之前（跑出去或被隔开就错位了）。
    const box = document.getElementById('box') as HTMLElement;
    const body = document.getElementById('body') as HTMLElement;
    const boxOrder = Array.from(box.childNodes).map((node) =>
      node.nodeType === Node.TEXT_NODE ? '#text' : node.nodeName,
    );
    expect(boxOrder).toEqual(['#text', 'JY-TRANSLATION', 'P', 'JY-TRANSLATION']);
    // Intro 的宿主在 Body 之前 —— 否则「Intro 译文 / Outro 译文」会一起挤到 Body 后面。
    const introHost = boxOrder.indexOf('JY-TRANSLATION');
    expect(box.childNodes[introHost].nextSibling).toBe(body);
    expect(body.nextSibling).toBe(box.lastChild);
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

    expect(state).toEqual({ translated: true, mode: 'bilingual', total: 2, done: 1, failed: 1 });

    const broken = hosts().find((host) => bodyTextOf(host).includes('网络错误'));
    expect(broken).toBeDefined();
    expect(hasRetryButton(broken as Element)).toBe(true);
    // 部分失败不弹 toast：逐条标注已经够了。
    expect(document.getElementById('jy-toast')).toBeNull();
  });

  it('全部条目同码失败（AUTH）时弹一次 toast，且不挂重试按钮', async () => {
    mount('<p>First text</p><p>Second text</p><p>Third text</p>');
    const { worker, contentListener } = await loadContentScript();
    // 第三条故意挂住：验证 toast 是**等整批回完**才弹的，不是第一批回来就弹。
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
    // 另外两条已经回来了，但整批还没回完——此时不该弹 toast。
    expect(document.getElementById('jy-toast')).toBeNull();

    releaseThird?.();
    const state = await pending;

    expect(state).toEqual({ translated: true, mode: 'bilingual', total: 3, done: 0, failed: 3 });
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
    expect(document.querySelectorAll('#jy-toast')).toHaveLength(1);
  });

  it('重复触发翻译不会重复挂宿主', async () => {
    mount('<p>Hello world</p><p>Second paragraph here</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    const firstHosts = hosts();
    expect(firstHosts).toHaveLength(2);

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(hosts()).toHaveLength(2);
    expect(hosts()).toEqual(firstHosts);
    expect(state.done).toBe(2);
    expect(translateRequests(worker)).toHaveLength(1);
  });

  it('翻译进行中再次触发不会重复挂宿主（running 守卫）', async () => {
    mount('<p>Hello world</p>');
    const { worker, contentListener } = await loadContentScript();
    let releaseFirstBatch: (() => void) | undefined;
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      // 挂住第一批，让第一次翻译停在"进行中"（不用计时器：真/假计时器切换容易假通过）。
      releaseFirstBatch = () => sendResponse({ ok: true, results: [] });
      return true;
    });
    const first = dispatch(contentListener, MSG.TRANSLATE_PAGE);
    await waitFor(() => releaseFirstBatch !== undefined);
    expect(hosts()).toHaveLength(1);

    const secondState = await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    expect(hosts()).toHaveLength(1);
    expect(secondState.translated).toBe(true);
    expect(translateRequests(worker)).toHaveLength(1);

    releaseFirstBatch?.();
    await first;
    expect(hosts()).toHaveLength(1);
  });

  it('还原后页面回到原状：无残留节点、无残留属性', async () => {
    const html = '<article><h1>Hello world</h1><div id="box">Intro sentence<p>Nested body text</p></div></article>';
    mount(html);
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(autoReply());

    await dispatch(contentListener, MSG.TRANSLATE_PAGE);
    expect(hosts().length).toBeGreaterThan(0);

    const state = await dispatch(contentListener, MSG.RESTORE_PAGE);

    expect(state).toEqual({ translated: false, mode: 'bilingual', total: 0, done: 0, failed: 0 });
    expect(hosts()).toHaveLength(0);
    expect(document.body.innerHTML).toBe(html);
    expect(document.querySelector('[data-jy-root]')).toBeNull();
    expect(document.querySelector('[data-jy-id]')).toBeNull();
    expect(document.querySelector('[data-jy-translated]')).toBeNull();
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
    expect(state).toEqual({ translated: false, mode: 'bilingual', total: 0, done: 0, failed: 0 });
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

  it('响应级失败（ok: false）时整页标注并弹一次提示', async () => {
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
    expect(state).toEqual({ translated: false, mode: 'bilingual', total: 0, done: 0, failed: 0 });
    expect(translateRequests(worker)).toHaveLength(0);
    expect(document.getElementById('jy-toast')?.shadowRoot?.textContent).toContain('设置版本');
  });
});
