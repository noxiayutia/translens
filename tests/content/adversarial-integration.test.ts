/**
 * @vitest-environment jsdom
 *
 * 对抗性核验（一次性探针，不属于交付物）：真实编排链路下的显示模式与失败态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';
import { MSG, type PageState } from '../../src/shared/messages';
import { SETTINGS_KEY } from '../../src/shared/settings';

type SendResponse = (response?: unknown) => void;
type MessageListener = (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean | undefined;

let chromeStub: ChromeStub;

async function loadContentScript(): Promise<{ worker: ReturnType<typeof vi.fn>; listener: MessageListener }> {
  await import('../../src/content/index');
  const listener = chromeStub.runtime.onMessage.listeners()[0];
  if (listener === undefined) throw new Error('内容脚本没有注册 onMessage');
  const worker = vi.fn<MessageListener>(() => undefined);
  chromeStub.runtime.onMessage.addListener(worker);
  return { worker, listener };
}

function isTranslateRequest(message: unknown): boolean {
  return (message as { type?: string } | null)?.type === MSG.TRANSLATE_TEXTS;
}

async function dispatch(listener: MessageListener, type: string): Promise<PageState> {
  let responded = false;
  let settle: ((value: unknown) => void) | undefined;
  const response = new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => resolve('NO_RESPONSE'), 2000);
    settle = (incoming: unknown) => {
      clearTimeout(timer);
      resolve(incoming);
    };
  });
  const returned = listener({ type }, { id: 'probe' }, (incoming?: unknown) => {
    if (responded) return;
    responded = true;
    settle?.(incoming);
  });
  // 同步响应的（RESTORE_PAGE / GET_PAGE_STATE）返回 false 并当场 sendResponse。
  if (!responded && returned !== true) throw new Error(`内容脚本没有接管 ${type}`);
  const result = await response;
  if (result === 'NO_RESPONSE') throw new Error(`${type} 没有响应`);
  return result as PageState;
}

function bodyTextOf(host: Element): string {
  return host.shadowRoot?.querySelector('.jy-body')?.textContent ?? '';
}

function visibleText(element: Element): string {
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

const AUTO_REPLY: MessageListener = (message, _sender, sendResponse) => {
  if (!isTranslateRequest(message)) return false;
  const { items } = (message as { payload: { items: Array<{ id: string; text: string }> } }).payload;
  sendResponse({ ok: true, results: items.map((item) => ({ id: item.id, text: `译:${item.text}` })) });
  return true;
};

beforeEach(() => {
  document.body.innerHTML = '';
  for (const node of Array.from(document.querySelectorAll('[data-jy-root]'))) node.remove();
  vi.resetModules();
  chromeStub = installChromeStub();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('核验 6：存储里的模式真的被渲染器采纳', () => {
  it("存储 displayMode='replace'（老用户）→ 实际按「仅译文」渲染，不是双语", async () => {
    await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: 1, displayMode: 'replace' } });
    document.body.innerHTML = '<p id="p">Click <a href="/x">here</a> now</p>';
    const p = document.getElementById('p') as HTMLElement;
    const { worker, listener } = await loadContentScript();
    worker.mockImplementation(AUTO_REPLY);

    const state = await dispatch(listener, MSG.TRANSLATE_PAGE);

    expect(state.mode).toBe('translated-only');
    // 仅译文的形状：宿主在段落内部、原文藏在 display:none 的 span 里
    expect(p.querySelector('jy-translation')?.parentElement).toBe(p);
    const hidden = p.querySelector('[data-jy-originals]') as HTMLElement | null;
    expect(hidden).not.toBeNull();
    expect(hidden?.style.display).toBe('none');
    expect(hidden?.querySelector('a')?.getAttribute('href')).toBe('/x');
    expect(visibleText(p)).toBe('译:Click here now');
    expect(p.nextElementSibling).toBeNull();
  });

  it("存储 displayMode='bilingual' → 宿主是段落的兄弟节点，不隐藏任何原文", async () => {
    await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: 1, displayMode: 'bilingual' } });
    document.body.innerHTML = '<article><p id="p">Click <a href="/x">here</a> now</p><p id="q">Second text here</p></article>';
    const p = document.getElementById('p') as HTMLElement;
    const { worker, listener } = await loadContentScript();
    worker.mockImplementation(AUTO_REPLY);

    const state = await dispatch(listener, MSG.TRANSLATE_PAGE);

    expect(state.mode).toBe('bilingual');
    const host = document.querySelector('jy-translation') as Element;
    // 双语模式的既有行为：译文宿主紧跟原段落（渲染器对 p 的落点就是 p 内部末尾）
    expect(p.querySelector('jy-translation')).toBe(host);
    expect(document.querySelectorAll('[data-jy-originals]')).toHaveLength(0);
    // 双语：原文与译文都可见
    expect(p.textContent).toBe('Click here now');
    expect(bodyTextOf(host)).toBe('译:Click here now');
  });
});

describe('核验 7：失败态在真实链路上的可见性', () => {
  it('条目级 AUTH 失败：错误文案 + 无重试按钮（不可重试）', async () => {
    document.body.innerHTML = '<p id="p">Hello world</p>';
    const p = document.getElementById('p') as HTMLElement;
    const { worker, listener } = await loadContentScript();
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = (message as { payload: { items: Array<{ id: string }> } }).payload;
      sendResponse({
        ok: true,
        results: items.map((item) => ({ id: item.id, text: null, code: 'AUTH', message: '尚未填写 API Key' })),
      });
      return true;
    });

    const state = await dispatch(listener, MSG.TRANSLATE_PAGE);

    expect(state.failed).toBe(1);
    const host = p.querySelector('jy-translation') as Element;
    expect(host).not.toBeNull();
    expect(bodyTextOf(host)).toContain('尚未填写 API Key');
    // 失败态是**可见**的：用户能看到红字（原文虽然藏起来了，但这一页不是空白）
    expect(visibleText(p)).toContain('尚未填写 API Key');
    expect(host.shadowRoot?.querySelector('.jy-retry')).toBeNull();
    // 原文没丢
    expect((p.querySelector('[data-jy-originals]') as HTMLElement).textContent).toBe('Hello world');
  });

  it('点重试按钮真的重发请求并落地译文（重试链路完整）', async () => {
    document.body.innerHTML = '<p id="p">Hello world</p>';
    const p = document.getElementById('p') as HTMLElement;
    const { worker, listener } = await loadContentScript();
    let failFirst = true;
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = (message as { payload: { items: Array<{ id: string; text: string }> } }).payload;
      if (failFirst) {
        failFirst = false;
        sendResponse({
          ok: true,
          results: items.map((item) => ({ id: item.id, text: null, code: 'NETWORK', message: '网络抖动' })),
        });
        return true;
      }
      sendResponse({ ok: true, results: items.map((item) => ({ id: item.id, text: `译:${item.text}` })) });
      return true;
    });

    const state = await dispatch(listener, MSG.TRANSLATE_PAGE);
    expect(state.failed).toBe(1);
    const host = p.querySelector('jy-translation') as Element;
    const button = host.shadowRoot?.querySelector('.jy-retry') as HTMLButtonElement;
    expect(button).not.toBeNull();

    button.click();
    // 等重试的异步链路落地
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(p.querySelectorAll('jy-translation')).toHaveLength(1);
    expect(bodyTextOf(p.querySelector('jy-translation') as Element)).toBe('译:Hello world');
    expect(visibleText(p)).toBe('译:Hello world');
  });

  it('还原之后失败文案与隐藏 span 一起消失，页面回到原文', async () => {
    document.body.innerHTML = '<p id="p">Hello world</p>';
    const before = document.body.outerHTML;
    const { worker, listener } = await loadContentScript();
    worker.mockImplementation((message, _sender, sendResponse) => {
      if (!isTranslateRequest(message)) return false;
      const { items } = (message as { payload: { items: Array<{ id: string }> } }).payload;
      sendResponse({
        ok: true,
        results: items.map((item) => ({ id: item.id, text: null, code: 'NETWORK', message: '网络抖动' })),
      });
      return true;
    });

    await dispatch(listener, MSG.TRANSLATE_PAGE);
    await dispatch(listener, MSG.RESTORE_PAGE);

    expect(document.body.outerHTML).toBe(before);
    expect(document.querySelectorAll('[data-jy-originals]')).toHaveLength(0);
  });
});
