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
import { CURRENT_VERSION, SETTINGS_KEY } from '../../src/shared/settings';

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

/** 页面内那条 toast 的**文字节点**（M3 要读它的计算样式：真浏览器里换行折不折叠全看它）。 */
function toastSpan(): HTMLElement | null {
  const span = document.getElementById(TOAST_ID)?.shadowRoot?.querySelector('span');
  return span instanceof HTMLElement ? span : null;
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
 * 一个**会让分析内核抛错**的元素：注入故障但不 mock 模块，走真实接线、真实点击。
 *
 * `classify()` 的第一句就是 `element.closest('[data-jy-root]')`，把它换成"第一次调用就抛"
 * 即可——异常原样穿出 `diagnoseElement`，落到 `installDiagnose` 的 onClick 那个 catch 上。
 * 只抛第一次：之后恢复原样，免得注入的故障溢出到别的环节（交互重扫会在同一个元素上问
 * 同样的判据）。
 */
function brittleElement(): HTMLElement {
  const target = document.createElement('p');
  target.textContent = '这次分析会炸';
  const original = target.closest;
  target.closest = function brittle() {
    target.closest = original;
    throw new Error('分析内核炸了');
  } as unknown as typeof target.closest;
  document.body.append(target);
  return target;
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

/**
 * 用**真实链路**把任意现场翻译好（内容脚本 + 后台替身，响应是 `译:原文`）。
 *
 * 与 `translatedPage()` 的分工：那个是固定现场（首段 + 翻译后新增的一段，测状态读数用），
 * 这个给"结论必须与真实采集/渲染一致"那组用例用——F1 的 pre、F2 的松散文本段都要真翻一遍
 * 才成立（诊断里最要命的错就是结论与真实链路不一致）。
 */
async function translateFixture(html: string): Promise<void> {
  document.body.innerHTML = html;
  /**
   * 显示模式必须在内容脚本 import **之前**进存储：它读的是当时那份设置。
   * 这里用**双语对照**：只有它能让松散文本段直接可达（仅译文模式会把原文整体搬进
   * `[data-jy-root]` 隐藏容器，那一段就点不到了——说明里写明的 F2 可达性）。
   */
  await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: CURRENT_VERSION, displayMode: 'bilingual' } });
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

  it('页面还没翻译时也能跑：结论是"页面还没开始翻译"并提示按 Alt+T（不是"已采集"）', async () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';
    await import('../../src/content/index');

    click(document.getElementById('p') as HTMLElement);

    // 页面压根没翻译：说"已采集未翻译：宿主不存在"会把排查引向不存在的请求/渲染 bug（M1）。
    const text = toastText() ?? '';
    expect(text).toContain('还没开始翻译');
    expect(text).toContain('Alt+T');
    expect(text).not.toContain('宿主不存在');
    expect(text).not.toContain('已采集');
  });
});

describe('诊断模式：结论', () => {
  it('点一个已被翻译的段落 → 结论说「已翻译」', async () => {
    const { translated } = await translatedPage();

    click(translated);

    expect(toastText()).toContain('已翻译');
    expect(clipboardWrites[0]).toContain('已翻译');
  });

  it('点一个可见但尚未翻译的段落（翻译后新增、增量还没跑）→ 说"不在已处理账本里"', async () => {
    const { fresh } = await translatedPage();

    click(fresh);

    // 这一段从来没进过采集（翻译之后才出现的），所以**不能**说"宿主不存在"——
    // 那是"采了没渲染"的指纹，会把排查引向不存在的请求/渲染 bug（M1）。
    const text = toastText() ?? '';
    expect(text).toContain('未采集');
    expect(text).toContain('翻译后才出现');
    expect(text).not.toContain('宿主不存在');
    expect(text).not.toContain('已翻译');
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

describe('诊断模式：提示留得住（用户的视线在被点的元素上）', () => {
  /**
   * 实测出来的问题：提示只有 3.2 秒、还在屏幕底部，而用户的视线在屏幕中上部被点的元素上
   * ——低头看一眼再抬头，提示已经没了。诊断是**显式动作**（Alt+Shift+点击）触发的排查工具，
   * 不是状态反馈：留久一点没有代价（`toast` 是"删旧建新"，再点一次就替换），
   * 却决定了用户到底看没看见结论。
   *
   * 这条走**真实链路**（内容脚本 + 真实点击）钉住"诊断那一次调用传了更长的时长"，
   * 而不是只测 `toast()` 参数本身。
   */
  it('诊断那条提示比默认久：默认的 3.2 秒过去了它还在，到自己的点才消失', async () => {
    const { translated } = await translatedPage();

    click(translated);
    expect(toastText()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(3200);
    expect(toastText()).not.toBeNull(); // 默认时长下这里已经是一条空页面

    await vi.advanceTimersByTimeAsync(15000 - 3200);
    expect(toastText()).toBeNull();
  });

  /**
   * 诊断**自己出错**时那条提示也是诊断的提示：它只在这个 catch 里出现（`diagnose.ts`），
   * 用户的视线同样在被点的元素上，"低头 → 读懂 → 截图"这串动作 3.2 秒一样不够。
   * 所以它与成功那条**同一个时长**，这里按同一条正负成对的口径钉住。
   */
  it('诊断自己出错时那条提示也留 15 秒（不是默认的 3.2 秒）', async () => {
    // 逐节点建，不用 innerHTML（与"页面一个字节都不许被我们改写"同一条纪律）。
    const page = document.createElement('p');
    page.textContent = 'Ready to deploy';
    document.body.replaceChildren(page);
    await import('../../src/content/index');
    const target = brittleElement();

    click(target);

    expect(toastText()).toContain('诊断失败');
    // 分析没跑出结论：除了这条提示，什么通道都不该有输出。
    expect(clipboardWrites).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3200);
    expect(toastText()).not.toBeNull(); // 默认时长下这里已经是一条空页面

    await vi.advanceTimersByTimeAsync(15000 - 3200 - 1);
    expect(toastText()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(toastText()).toBeNull();
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

describe('诊断模式：结论与真实链路逐条对上（F1 / F2 / M1 / M3）', () => {
  it('F1：<pre><span> 的后代 → 说"祖先这类标签被跳过"，而真实链路里它一段都没产出', async () => {
    await translateFixture(
      '<p id="other">Ready to deploy</p><pre id="pre"><span id="s">const answer = 1</span></pre>',
    );
    // 真实链路只给可翻译的那一段挂了宿主：pre 整棵子树被跳过，里面一个宿主都没有。
    // （不能拿诊断自己的采集当证据——那正是 F1 的错源：以点击处为根重跑，祖先那道闸没人问。）
    expect(document.querySelectorAll('[data-jy-for]')).toHaveLength(1);
    expect(document.getElementById('pre')?.querySelector('[data-jy-for]')).toBeNull();

    click(document.getElementById('s') as HTMLElement);

    const text = toastText() ?? '';
    expect(text).toContain('祖先');
    expect(text).toContain('pre');
    expect(text).not.toContain('已采集');
    expect(text).not.toContain('宿主不存在');
  });

  it('F2：双语模式下松散文本段（译文已渲染）→ 说"已翻译"，绝不说宿主不存在', async () => {
    await translateFixture('<div id="card"><span id="s">Intro text</span><p id="body">Body text</p></div>');
    const card = document.getElementById('card') as HTMLElement;
    const host = card.querySelector('[data-jy-for]');
    // 复现现场先钉住：译文确实渲染出来了，而且宿主挂在**容器**里（不在被点的 span 里）。
    expect(host).not.toBeNull();
    expect(host?.shadowRoot?.textContent).toContain('译:Intro text');
    expect(document.getElementById('s')?.querySelector('[data-jy-for]')).toBeNull();

    click(document.getElementById('s') as HTMLElement);

    const text = toastText() ?? '';
    expect(text).toContain('已翻译');
    expect(text).not.toContain('宿主不存在');
  });

  it('M1①：完全没翻译的页面 → "页面还没开始翻译"并提示按 Alt+T', async () => {
    document.body.innerHTML = '<p id="p">Ready to deploy</p>';
    await import('../../src/content/index');

    click(document.getElementById('p') as HTMLElement);

    const text = toastText() ?? '';
    expect(text).toContain('还没开始翻译');
    expect(text).toContain('Alt+T');
    expect(text).not.toContain('宿主不存在');
    expect(text).not.toContain('已采集');
  });

  it('M1③：真的采过、宿主被框架摘掉 → 才说「已采集未翻译：宿主不存在」', async () => {
    await translateFixture('<div id="card"><span id="s">Intro text</span><p id="body">Body text</p></div>');
    const card = document.getElementById('card') as HTMLElement;
    // 模拟"框架重建卡片里的节点、顺手把宿主一起摘了"（README 写明的那一类）。
    // 这一段**确实进过采集**（容器上有 data-jy-id），此时"宿主不存在"才是请求/渲染环节的结论。
    const hosts = Array.from(card.querySelectorAll('[data-jy-for]'));
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) host.remove();

    click(document.getElementById('s') as HTMLElement);

    const text = toastText() ?? '';
    expect(text).toContain('已采集未翻译');
    expect(text).toContain('宿主不存在');
  });

  it('M3：提示的两行在真浏览器里真的分两行（文字节点的计算样式保留换行）', async () => {
    const { translated } = await translatedPage();

    click(translated);

    const span = toastSpan();
    expect(span).not.toBeNull();
    expect(span?.textContent?.split('\n')).toHaveLength(2);
    // jsdom 不做排版，所以这里读**计算样式**：只说"换行不会被折叠成空格"这件事。
    // 注意 jsdom 对"根本没设"给的是空串而不是 'normal'：两条断言都要，缺一条就拦不住漏设。
    expect(getComputedStyle(span as HTMLElement).whiteSpace).not.toBe('normal');
    expect(getComputedStyle(span as HTMLElement).whiteSpace).toBe('pre-line');
  });
});
