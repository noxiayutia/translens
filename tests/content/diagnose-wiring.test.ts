/**
 * @vitest-environment jsdom
 *
 * 诊断模式的**接线**：Alt+Shift+点击 → 页面内 toast + 剪贴板 + 控制台链路，
 * 以及它"其它时候一行代码都不多跑"的承诺。
 *
 * 与 `diagnose.test.ts` 的分工：那边测分析结论（纯读、无接线），这边测触发条件、
 * 输出通道与"不改变页面"的硬约束。分析内核里能看见的东西这边一概不重复。
 *
 * `isTrusted` 的成对纪律沿用 `tests/helpers/trusted-events.ts`（见那里的文件头注释）：
 * 负向用 `dispatchSynthetic`、正向用 `dispatchTrusted`，同一块派发代码路径，
 * 唯一区别就是可信标志——只测负向会掩盖"永远拒绝"的假通过。
 */
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';
import { dispatchSynthetic, dispatchTrusted } from '../helpers/trusted-events';
import { MSG, type PageState } from '../../src/shared/messages';

type SendResponse = (response?: unknown) => void;
type MessageListener = (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean | undefined;

const TOAST_ID = 'jy-toast';

let chromeStub: ChromeStub;
/** 每一次 `navigator.clipboard.writeText` 收到的文本（空数组 = 一次都没写过）。 */
let clipboardWrites: string[];

function isTranslateRequest(message: unknown): boolean {
  return (message as { type?: string } | null)?.type === MSG.TRANSLATE_TEXTS;
}

function sentTexts(worker: MockInstance<MessageListener>): string[] {
  return worker.mock.calls
    .filter(([message]) => isTranslateRequest(message))
    .flatMap(([message]) =>
      (message as { payload: { items: Array<{ text: string }> } }).payload.items.map((item) => item.text),
    );
}

/** 页面内那条 toast 的纯文本内容（`toast()` 把消息写进 shadow DOM）。 */
function toastText(): string | null {
  return document.getElementById(TOAST_ID)?.shadowRoot?.textContent ?? null;
}

async function dispatch(
  contentListener: MessageListener,
  type: string,
  payload?: unknown,
): Promise<PageState> {
  let responded = false;
  let settle: ((response: unknown) => void) | undefined;
  const response = new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => resolve('NO_RESPONSE'), 1000);
    settle = (incoming: unknown) => {
      clearTimeout(timer);
      resolve(incoming);
    };
  });
  const returned = contentListener(payload === undefined ? { type } : { type, payload }, { id: 'test' }, (
    incoming?: unknown,
  ) => {
    if (responded) return;
    responded = true;
    settle?.(incoming);
  });
  if (!responded && returned !== true) throw new Error(`内容脚本没有接管 ${type}`);
  const result = await response;
  if (result === 'NO_RESPONSE') throw new Error(`${type} 的响应没有到达`);
  return result as PageState;
}

/** Alt+Shift+点击（或按需去掉修饰键）。 */
function click(
  target: EventTarget,
  init: MouseEventInit = {},
  mode: 'trusted' | 'synthetic' = 'trusted',
): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true, shiftKey: true, ...init });
  if (mode === 'trusted') dispatchTrusted(target, event);
  else dispatchSynthetic(target, event);
  return event;
}

/**
 * 加载内容脚本并把页面翻译好；返回监听器、对端替身与"翻译后新插入的未翻译段落"。
 *
 * 新段落**故意不推动定时器**：它模拟的正是"翻译完成后页面新增了内容、增量那一轮
 * 还没跑"的场景——诊断模式的用户看到的就是这个时刻。
 */
async function translatedPage(): Promise<{
  contentListener: MessageListener;
  worker: MockInstance<MessageListener>;
  fresh: HTMLElement;
  translated: HTMLElement;
}> {
  document.body.innerHTML = '<main id="root"><p id="first">Ready to deploy</p></main>';
  await import('../../src/content/index');
  const contentListener = chromeStub.runtime.onMessage.listeners()[0];
  if (contentListener === undefined) throw new Error('内容脚本没有注册 onMessage 监听器');
  const worker = vi.fn<MessageListener>(() => undefined);
  chromeStub.runtime.onMessage.addListener(worker);
  worker.mockImplementation((message, _sender, sendResponse) => {
    if (!isTranslateRequest(message)) return false;
    const { items } = (message as { payload: { items: Array<{ id: string; text: string }> } }).payload;
    sendResponse({ ok: true, results: items.map((item) => ({ id: item.id, text: `译:${item.text}` })) });
    return true;
  });

  await dispatch(contentListener, MSG.TRANSLATE_PAGE);
  worker.mockClear();

  const translated = document.getElementById('first') as HTMLElement;
  const fresh = document.createElement('p');
  fresh.textContent = 'Brand new paragraph';
  (document.getElementById('root') as HTMLElement).append(fresh);
  return { contentListener, worker, fresh, translated };
}

beforeEach(() => {
  document.body.innerHTML = '';
  for (const host of Array.from(document.querySelectorAll('[data-jy-root]'))) host.remove();
  vi.resetModules();
  chromeStub = installChromeStub();
  clipboardWrites = [];
  // 假定时器：交互重扫的防抖、toast 的自动消失都靠它推进。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    writable: true,
    value: {
      writeText: (text: string) => {
        clipboardWrites.push(text);
        return Promise.resolve();
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('诊断模式：触发条件（必须仍走 isTrusted 闸门）', () => {
  it('合成的 Alt+Shift+click 不触发诊断（isTrusted=false：页面脚本伪造不了）', async () => {
    const { contentListener, translated } = await translatedPage();
    void contentListener;

    click(translated, {}, 'synthetic');

    expect(toastText()).toBeNull();
    expect(clipboardWrites).toHaveLength(0);
  });

  it('成对断言：同一现场把 isTrusted 伪造成 true → 诊断照常触发（证明上一条不是"永远拒绝"的假通过）', async () => {
    const { translated } = await translatedPage();

    click(translated);

    expect(toastText()).not.toBeNull();
    expect(clipboardWrites).toHaveLength(1);
  });

  it('普通点击（不带 Alt+Shift）不触发诊断——诊断不该改变页面本身的任何行为', async () => {
    const { translated } = await translatedPage();

    click(translated, { altKey: false, shiftKey: false });
    click(translated, { altKey: true, shiftKey: false });
    click(translated, { altKey: false, shiftKey: true });

    expect(toastText()).toBeNull();
    expect(clipboardWrites).toHaveLength(0);
  });

  it('页面还没翻译时也能跑（用来区分"压根没进采集"与"采了但没翻"）', async () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';
    await import('../../src/content/index');

    click(document.getElementById('p') as HTMLElement);

    // 未翻译的页面上没有采集快照：结论仍然可读，并指明是宿主不存在。
    expect(toastText()).toContain('宿主不存在');
  });
});

describe('诊断模式：结论', () => {
  it('点一个已被翻译的段落 → 结论说「已翻译」', async () => {
    const { translated } = await translatedPage();

    click(translated);

    expect(toastText()).toContain('已翻译');
    expect(clipboardWrites[0]).toContain('已翻译');
  });

  it('点一个可见但尚未翻译的段落（翻译后新增、增量还没跑）→ 说「未采集」并指明原因', async () => {
    const { fresh } = await translatedPage();

    click(fresh);

    // 会成段、但查不到译文宿主：这一条正是"采了没渲染"（请求/渲染环节）的指纹。
    expect(toastText()).toContain('宿主不存在');
    expect(toastText()).not.toContain('已翻译');
  });

  it('点一个 display:none 里的元素 → 指明是**祖先**导致不可见', async () => {
    document.body.innerHTML = '<div id="panel" style="display:none"><p id="p">Closed panel text</p></div>';
    await import('../../src/content/index');

    click(document.getElementById('p') as HTMLElement);

    expect(toastText()).toContain('未采集');
    expect(toastText()).toContain('祖先');
    expect(toastText()).toContain('display:none');
  });

  it('点一个自身 hidden 的元素 → 指明是**自身**导致不可见', async () => {
    document.body.innerHTML = '<p id="p" hidden>Self hidden text</p>';
    await import('../../src/content/index');

    click(document.getElementById('p') as HTMLElement);

    expect(toastText()).toContain('自身');
    expect(toastText()).toContain('hidden');
  });

  it('点插件自己浮层里的元素 → 说是插件自己的浮层', async () => {
    document.body.innerHTML = '<p>Ready to deploy</p>';
    await import('../../src/content/index');
    const host = document.createElement('jy-translation');
    host.setAttribute('data-jy-root', '');
    host.setAttribute('data-jy-for', 'jy-1-abc');
    document.body.append(host);

    click(host);

    expect(toastText()).toContain('浮层');
  });

  it('点 contenteditable 里的元素 → 说是可编辑区域', async () => {
    document.body.innerHTML = '<div contenteditable="true"><p id="draft">Draft text here</p></div>';
    await import('../../src/content/index');

    click(document.getElementById('draft') as HTMLElement);

    expect(toastText()).toContain('可编辑');
  });

  it('点一个会下钻的容器 → 提示点更里面的元素', async () => {
    document.body.innerHTML = '<div id="card">Intro text<p id="body">Body text</p></div>';
    await import('../../src/content/index');

    click(document.getElementById('card') as HTMLElement);

    expect(toastText()).toContain('点更里面');
  });

  it('点 document.body → 不抛错，给出可读的两行结论', async () => {
    document.body.innerHTML = '<p>Ready to deploy</p>';
    await import('../../src/content/index');

    expect(() => click(document.body)).not.toThrow();

    const text = toastText();
    expect(text).not.toBeNull();
    // 一眼看懂的最少限度：两行（结论 + 依据）。
    expect((text ?? '').split('\n')).toHaveLength(2);
  });

  it('完整链路进 console.table：每一级的元素与结论都在', async () => {
    document.body.innerHTML = '<div id="card">Intro text<p id="body">Body text</p></div>';
    await import('../../src/content/index');
    const table = vi.spyOn(console, 'table').mockImplementation(() => undefined);

    click(document.getElementById('card') as HTMLElement);

    expect(table).toHaveBeenCalledTimes(1);
    // 容器自己就有结论（下钻），链路到此为止——这正是"最靠近点击处"的含义。
    const rows = table.mock.calls[0]?.[0] as Array<Record<string, string>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['层级']).toBe('点击处');
    expect(rows[0]?.['元素']).toBe('div#card');
    // 结论与提示里那句话同源：链路表里也是「点更里面的元素」，两处不会各说一套。
    expect(rows[0]?.['结论']).toContain('点更里面的元素');
    table.mockRestore();
  });

  it('内容脚本被二次注入时先摘掉旧监听：一次点击只诊断一次，不会重复弹/重复复制', async () => {
    const { translated } = await translatedPage();
    // 热更新/二次注入是同页两份模块实例（测试里的 resetModules + 重新 import 同形）：
    // 旧实例的 document 监听器不摘，一次点击就会跑两遍诊断。
    vi.resetModules();
    await import('../../src/content/index');

    click(translated);

    expect(clipboardWrites).toHaveLength(1);
  });
});

describe('诊断模式：不改变页面', () => {
  it('触发前后 document.body.outerHTML 逐字节相同，且不产生任何翻译请求', async () => {
    const { worker, fresh } = await translatedPage();
    const before = document.body.outerHTML;

    click(fresh);

    expect(document.body.outerHTML).toBe(before);
    expect(sentTexts(worker)).toEqual([]);
  });

  it('不 preventDefault、不 stopPropagation：页面自己的 click 处理器照常收到事件', async () => {
    const { translated } = await translatedPage();
    const seen: Event[] = [];
    document.body.addEventListener('click', (event) => seen.push(event));

    const event = click(translated);

    expect(seen).toHaveLength(1);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('诊断模式：观察者状态', () => {
  it('未翻译时报告观察者未启用', async () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';
    await import('../../src/content/index');

    click(document.getElementById('p') as HTMLElement);

    expect(toastText()).toContain('观察者：未启用');
  });

  it('翻译后报告观察者已启用，并报出段数与元素数', async () => {
    const { translated } = await translatedPage();

    click(translated);
    const text = toastText() ?? '';

    expect(text).toContain('观察者：已启用');
    // 元素数是一眼能核对的读数（护栏的判据就是它）。
    expect(text).toMatch(/\d+ 元素/);
    // 「已处理段数」落在合理范围：这一页只有一段被翻过（seed 之外没有别的轮次跑过）。
    const processed = /已处理 (\d+) 段/.exec(text);
    expect(processed).not.toBeNull();
    expect(Number(processed?.[1])).toBeGreaterThanOrEqual(1);
    expect(Number(processed?.[1])).toBeLessThanOrEqual(2);
  });

  it('最近一轮增量的时刻与段数、最近一次交互重扫被阈值跳过的记录都进链路', async () => {
    const { translated } = await translatedPage();
    // 推进到增量轮跑完：新增的那一段变成"已翻译"。
    await vi.advanceTimersByTimeAsync(600);

    click(translated);
    const text = toastText() ?? '';

    expect(text).toContain('观察者：已启用');
    // 增量轮次与"最近一次交互重扫"是两个独立读数，都该出现在完整结论里（剪贴板全文）。
    expect(clipboardWrites[0]).toContain('增量');
    expect(clipboardWrites[0]).toContain('交互重扫');
  });

  it('剪贴板收到的是完整链路（结论 + 元素路径 + 采集上下文 + 观察者读数）', async () => {
    const { translated } = await translatedPage();

    click(translated);

    const text = clipboardWrites[0] ?? '';
    expect(text).toContain('【浸译诊断】');
    expect(text).toContain('已翻译');
    expect(text).toContain('p#first');
    expect(text).toContain('目标语言');
    expect(text).toContain('观察者：已启用');
  });

  it('还原之后不再报上一轮的残值：观察者未启用、没有增量轮次', async () => {
    const { translated } = await translatedPage();
    await vi.advanceTimersByTimeAsync(600);
    const restorer = chromeStub.runtime.onMessage.listeners()[0];
    if (restorer === undefined) throw new Error('内容脚本没有注册 onMessage 监听器');
    await dispatch(restorer, MSG.RESTORE_PAGE);

    click(translated);

    const text = toastText() ?? '';
    expect(text).toContain('观察者：未启用');
    // 那几个读数的语义都是"最近一轮增量如何如何"，而那一轮已经不在了。
    expect(text).toContain('最近增量：无');
    expect(text).toContain('交互重扫：无');
    // 未启用时不报账本段数（它只在"已启用"那一支里出现）。
    expect(text).not.toContain('已处理');
    // 也不该再出现"执行过/被跳过/被节流"这类属于已死那一轮的结论。
    expect(text).not.toContain('已执行');
    expect(text).not.toContain('被元素数上限跳过');
    expect(text).not.toContain('节流');
  });
});
