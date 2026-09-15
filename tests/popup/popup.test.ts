/**
 * @vitest-environment jsdom
 *
 * 弹窗（WU9 / Task 18）的行为测试。
 *
 * 被测的 `src/popup/popup.ts` 在 **import 时**就跑 `init()`：模块顶层先按 id 取 DOM
 * 元素（所以 DOM 必须先就位），`init()` 同步挂好监听器并置灰主按钮，然后才 `await
 * loadSettings()`。于是每个用例的顺序固定为：装替身 → 写存储 → 装 DOM → `import` →
 * 等 `init()` 那串 await 跑完。`vi.resetModules()` 保证每个用例拿到一份新的模块实例——
 * 弹窗里持有 `settings` 与若干闭包，共享实例会让用例互相串味。
 *
 * DOM 用 `src/popup/popup.html` 的**真实内容**（`DOMParser` 解析后取 body），不手抄一份结构：
 * id 改名、控件漏写这类错误应当在测试里失败，而不是两边一起错。同理，下拉框的期望值来自
 * `core/lang` 与 `engines/registry`，不手抄语言表。
 *
 * 内容脚本在真机上是 `chrome.tabs.sendMessage` 的接收方，替身不注册它（见 `chrome-stub`
 * 的 `StubTabs.responder`），由用例扮演：**只回话、不断言**——responder 里断言失败会变成
 * 一次普通的调用失败，被弹窗渲染成"无法与页面通信"，测试反而看不出真正的原因。
 * 要断言的东西一律事后再查 `chromeStub.tabs.sent`。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANGUAGES } from '../../src/core/lang';
import { ENGINES } from '../../src/engines/registry';
import { MSG, type PageState } from '../../src/shared/messages';
import { CURRENT_VERSION, DISPLAY_MODES, SETTINGS_KEY } from '../../src/shared/settings';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';

/**
 * 用 `import.meta.dirname` 拼路径，而不是 `new URL('...', import.meta.url)`：后者会被
 * Vite 的资源转换改写成 http 地址（jsdom 环境下 `fileURLToPath` 直接拒绝它）。
 */
const POPUP_HTML_PATH = join(import.meta.dirname, '..', '..', 'src', 'popup', 'popup.html');

/**
 * 与 `popup.ts` 里的同名常量一致。不 import 它：静态 import 会在装 DOM 之前执行
 * 弹窗模块的顶层 `init()`。超时时长是**用户看得见的**行为（文案里就写着秒数），
 * 钉在这里是有意的。
 */
const TOGGLE_TIMEOUT_MS = 30_000;

let chromeStub: ChromeStub;

interface PopupUi {
  toggle: HTMLButtonElement;
  status: HTMLParagraphElement;
  displayMode: HTMLSelectElement;
  targetLang: HTMLSelectElement;
  engine: HTMLSelectElement;
  hint: HTMLParagraphElement;
  optionsButton: HTMLButtonElement;
}

/** `popup.html` 里的七个控件；按 id 取，取不到直接失败。 */
function ui(): PopupUi {
  const pick = <T extends HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`popup.html 里没有 #${id}`);
    return found as T;
  };
  return {
    toggle: pick<HTMLButtonElement>('toggle'),
    status: pick<HTMLParagraphElement>('status'),
    displayMode: pick<HTMLSelectElement>('display-mode'),
    targetLang: pick<HTMLSelectElement>('target-lang'),
    engine: pick<HTMLSelectElement>('engine'),
    hint: pick<HTMLParagraphElement>('engine-hint'),
    optionsButton: pick<HTMLButtonElement>('open-options'),
  };
}

/**
 * 往存储里写一份**故意不完整**的设置：`loadSettings` 是逐字段补齐的反序列化边界，
 * 用例只声明它关心的字段（存储里的东西对它来说本来就是 `unknown`）。
 */
async function seedSettings(patch: Record<string, unknown>): Promise<void> {
  await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: CURRENT_VERSION, ...patch } });
}

/** 直读存储：验证"改动真的落盘了"，而不是只改了弹窗里的内存副本。 */
async function storedSettings(): Promise<Record<string, unknown>> {
  const raw = await chromeStub.storage.local.get([SETTINGS_KEY]);
  return (raw[SETTINGS_KEY] ?? {}) as Record<string, unknown>;
}

function mountPopupHtml(): void {
  const html = readFileSync(POPUP_HTML_PATH, 'utf-8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
}

/** 让已经排队的微任务跑完（替身里的存储与 tabs 调用都是立即兑现的 promise）。 */
async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 轮询直到条件成立；用来等 `change` 事件里那条异步的 persist 链落盘。 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('waitFor 超时：条件始终不成立');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 装 DOM、import 弹窗模块，并等 `init()` 那串 await（存储 → tabs.query → tabs.sendMessage）跑完。 */
async function loadPopup(): Promise<void> {
  mountPopupHtml();
  await import('../../src/popup/popup');
  await settle();
}

function pageState(patch: Partial<PageState> = {}): PageState {
  return { translated: false, mode: 'bilingual', total: 0, done: 0, failed: 0, ...patch };
}

/** 内容脚本侧替身：状态查询与开关都回 `read()` 的当前值。 */
function respondWithState(read: () => PageState): void {
  chromeStub.tabs.responder = (_tabId, message) => {
    const type = (message as { type?: string } | null)?.type;
    if (type === MSG.GET_PAGE_STATE || type === MSG.TOGGLE_PAGE) return read();
    // 真机上内容脚本对不认得的消息是 `return false`（不响应），于是端口关闭、
    // sendMessage 以 "port closed" 拒绝——不是 responder 主动抛错。这里如实返回
    // undefined，免得有人照抄这个替身写出与真机不符的用例。
    return undefined;
  };
}

/** 弹窗发给内容脚本的消息类型，按发送顺序。 */
function sentTypes(): string[] {
  return chromeStub.tabs.sent.map(({ message }) => (message as { type?: string } | null)?.type ?? '');
}

beforeEach(() => {
  chromeStub = installChromeStub();
  vi.resetModules();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.resetModules();
});

describe('popup.html 结构', () => {
  it('引用了 popup.css 与模块脚本，构建才能把样式和逻辑挂上', () => {
    const parsed = new DOMParser().parseFromString(readFileSync(POPUP_HTML_PATH, 'utf-8'), 'text/html');

    expect(parsed.querySelector('link[rel="stylesheet"]')?.getAttribute('href')).toBe('./popup.css');
    const script = parsed.querySelector('script');
    expect(script?.getAttribute('type')).toBe('module');
    expect(script?.getAttribute('src')).toBe('./popup.ts');
    // 测试靠这些 id 取控件；HTML 里少一个，上面 `ui()` 就会失败——这里再钉一次更直白的原因。
    expect(parsed.querySelectorAll('[id]').length).toBe(7);
  });
});

describe('弹窗初始化', () => {
  it('按存储里的设置选中目标语言与引擎，而不是写死默认值', async () => {
    await seedSettings({
      targetLang: 'ja',
      engineId: 'openai-compat',
      engineConfig: { apiKey: 'sk-test' },
    });
    await loadPopup();

    const { targetLang, engine } = ui();
    expect(targetLang.value).toBe('ja');
    expect(engine.value).toBe('openai-compat');
    expect(Array.from(targetLang.selectedOptions).map((option) => option.value)).toEqual(['ja']);

    // 选项清单来自 core/lang 与 engines/registry，弹窗不另抄一份。
    expect(Array.from(targetLang.options).map((option) => option.value)).toEqual(
      LANGUAGES.map((lang) => lang.code),
    );
    expect(Array.from(engine.options).map((option) => option.value)).toEqual(ENGINES.map((item) => item.id));
    // 活动标签页是唯一的查询口径：后台标签页的状态不该被读进来。
    expect(chromeStub.tabs.queries).toEqual([{ active: true, currentWindow: true }]);
  });

  it('初始文案取自内容脚本的 PageState，而不是猜一个默认值', async () => {
    respondWithState(() => pageState({ translated: true, total: 5, done: 3 }));
    await loadPopup();

    const { toggle, status } = ui();
    expect(sentTypes()).toEqual([MSG.GET_PAGE_STATE]);
    expect(toggle.disabled).toBe(false);
    expect(toggle.textContent).toBe('显示原文');
    expect(toggle.dataset.active).toBe('true');
    expect(status.textContent).toBe('已翻译 3 / 5 段');
  });

  it('设置还没读出来之前按钮是置灰的，不让出一段点了没反应的窗口期', async () => {
    // 让读存储**停住**——这正是"第一个 await 还没回来"的那一刻，而不是靠微任务时序撞运气。
    const realGet = chromeStub.storage.local.get.bind(chromeStub.storage.local);
    let releaseStorage: (() => void) | undefined;
    let storageCalls = 0;
    chromeStub.storage.local.get = (keys) => {
      storageCalls += 1;
      if (storageCalls > 1) return realGet(keys);
      return new Promise((resolve) => {
        releaseStorage = () => void realGet(keys).then(resolve);
      });
    };
    respondWithState(() => pageState());
    mountPopupHtml();
    await import('../../src/popup/popup');

    const { toggle } = ui();
    // `init()` 里那句同步的置灰：这会儿监听器已挂好但设置还没到，按钮必须是不可点的。
    expect(toggle.disabled).toBe(true);
    toggle.click();
    await settle();
    expect(sentTypes()).toEqual([]);

    releaseStorage?.();
    await waitFor(() => !toggle.disabled);
    // 设置读完之后回到正常流程：初始化自己那条 GET_PAGE_STATE 才发出去。
    expect(sentTypes()).toEqual([MSG.GET_PAGE_STATE]);
  });
});

describe('翻译开关', () => {
  it('点主按钮发 TOGGLE_PAGE，并按返回的 PageState 双向更新文案', async () => {
    let state = pageState({ total: 4, done: 0 });
    respondWithState(() => state);
    await loadPopup();

    const { toggle, status } = ui();
    expect(toggle.textContent).toBe('翻译此页');

    state = pageState({ translated: true, total: 4, done: 4 });
    toggle.click();
    await waitFor(() => toggle.textContent === '显示原文');
    expect(toggle.dataset.active).toBe('true');
    expect(toggle.disabled).toBe(false);
    expect(status.textContent).toBe('已翻译 4 / 4 段');

    state = pageState({ total: 4, done: 0, failed: 2 });
    toggle.click();
    await waitFor(() => toggle.textContent === '翻译此页');
    expect(toggle.dataset.active).toBe('false');

    // 两次都是 TOGGLE_PAGE：方向由内容脚本按自己的状态决定，弹窗不拿 dataset 当决策依据。
    expect(sentTypes()).toEqual([MSG.GET_PAGE_STATE, MSG.TOGGLE_PAGE, MSG.TOGGLE_PAGE]);
    expect(chromeStub.tabs.sent.every(({ tabId }) => tabId === 7)).toBe(true);
  });

  it('请求在飞时禁用主按钮，连点不会发出第二次 TOGGLE_PAGE', async () => {
    let resolveToggle: ((state: PageState) => void) | undefined;
    chromeStub.tabs.responder = (_tabId, message) => {
      const type = (message as { type?: string } | null)?.type;
      if (type === MSG.GET_PAGE_STATE) return pageState();
      return new Promise<PageState>((resolve) => {
        resolveToggle = resolve;
      });
    };
    await loadPopup();

    const { toggle } = ui();
    toggle.click();
    await waitFor(() => toggle.disabled);
    // 置灰期间再点：不能再发一条（真机上连点会开出两份译文宿主）。
    toggle.click();
    await settle();
    expect(sentTypes()).toEqual([MSG.GET_PAGE_STATE, MSG.TOGGLE_PAGE]);

    resolveToggle?.(pageState({ translated: true, total: 1, done: 1 }));
    await waitFor(() => !toggle.disabled);
    expect(toggle.textContent).toBe('显示原文');
    expect(sentTypes()).toEqual([MSG.GET_PAGE_STATE, MSG.TOGGLE_PAGE]);
  });
});

describe('受限页面', () => {
  it('初始化时没有接收方：按钮置灰、给不可用文案，不发多余消息', async () => {
    chromeStub.tabs.rejectSendMessage = true;
    await loadPopup();

    const { toggle, status } = ui();
    expect(sentTypes()).toEqual([MSG.GET_PAGE_STATE]);
    expect(toggle.disabled).toBe(true);
    expect(toggle.dataset.active).toBeUndefined();
    expect(toggle.textContent).toBe('此页面不可用');
    expect(status.textContent).toContain('不支持翻译');

    // 置灰的按钮点不动：这里是 jsdom 按规范抑制 disabled 元素上的 click（实测监听器
    // 被调用 0 次），断言真实有效，与 init 有没有吞掉拒绝无关。
    toggle.click();
    await settle();
    expect(sentTypes()).toEqual([MSG.GET_PAGE_STATE]);
  });

  it('设置读不出来时不是死弹窗：说明原因，入口都还活着', async () => {
    // 真实可达：用户装过新版扩展又回退，存储里的版本号高于本代码，loadSettings 明确拒绝。
    await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: CURRENT_VERSION + 1 } });

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      await loadPopup();
      // 未处理的拒绝在真机上只出现在控制台；弹窗必须自己说出来。
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }

    const { toggle, status, optionsButton } = ui();
    expect(status.textContent).toContain('设置读取失败');
    expect(status.textContent).toContain(String(CURRENT_VERSION + 1));
    // 按钮可点（页面本身没坏，只是设置读不出来），点了不能是"毫无反应"：
    // 这里替身没有接收方，`sendMessage` 兑现为 undefined，于是按"拿不到状态"如实渲染。
    expect(toggle.disabled).toBe(false);
    toggle.click();
    // 等待条件要能区分「点击前那次渲染」与「点击后这次渲染」：两者文案都是"重新试一次"
    // （初始化时设置读取失败也是 retryable），所以按状态行的对象判断。
    await waitFor(() => !status.textContent.includes('设置读取失败'));
    expect(toggle.textContent).toBe('重新试一次');
    expect(toggle.disabled).toBe(false);
    // 设置都没读出来，初始化那一步根本没走到发消息；这条 TOGGLE_PAGE 是点击发出的，
    // 也就是说监听器确实在第一个 await 之前就挂好了。
    expect(sentTypes()).toEqual([MSG.TOGGLE_PAGE]);

    // 关键出路：监听器在第一个 await 之前就挂好了，齿轮还能打开设置页。
    expect(chromeStub.runtime.openOptionsPageCalls).toBe(0);
    optionsButton.click();
    expect(chromeStub.runtime.openOptionsPageCalls).toBe(1);
  });

  it('点击时接收方才消失：如实说明通信失败并放开按钮，不冒充"此页面不可用"', async () => {
    respondWithState(() => pageState({ translated: true, total: 3, done: 3 }));
    await loadPopup();

    const { toggle, status } = ui();
    expect(toggle.disabled).toBe(false);
    expect(toggle.dataset.active).toBe('true');

    chromeStub.tabs.rejectSendMessage = true;
    toggle.click();
    await waitFor(() => status.textContent.includes('无法与页面通信'));
    expect(toggle.textContent).toBe('重新试一次');
    // 残留的"已翻译"配色会让深灰底挂在一句错误文案上，两个信号自相矛盾。
    expect(toggle.dataset.active).toBeUndefined();
    // 页面本身是可以翻译的，只是这一条消息没走通：再点一次是合理动作，不该被锁死。
    expect(toggle.disabled).toBe(false);
    expect(status.textContent).toContain('请重新打开弹窗重试');
    // 不要建议重新加载页面：翻译可能正在跑，那是唯一会丢掉已完成部分的建议。
    expect(status.textContent).not.toContain('重新加载页面');
    expect(sentTypes()).toEqual([MSG.GET_PAGE_STATE, MSG.TOGGLE_PAGE]);
  });

  it('内容脚本整轮翻译期间不响应：超时后给出原因，不留下没有理由的置灰按钮', async () => {
    chromeStub.tabs.responder = (_tabId, message) => {
      const type = (message as { type?: string } | null)?.type;
      if (type === MSG.GET_PAGE_STATE) return pageState();
      // 真机上的对应场景：`translatePage()` 的 `if (running) return` 早返回，
      // 没有任何人调用 sendResponse——这一条 TOGGLE_PAGE 会永远挂着。
      return new Promise<never>(() => {});
    };
    await loadPopup();

    const { toggle, status } = ui();
    expect(toggle.disabled).toBe(false);

    vi.useFakeTimers();
    try {
      toggle.click();
      await vi.advanceTimersByTimeAsync(TOGGLE_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }

    expect(status.textContent).toBe(
      '页面已翻译超过 30 秒仍在进行，这里先不打扰它——重新打开弹窗即可看到最新进度。',
    );
    expect(toggle.textContent).toBe('翻译进行中');
    expect(toggle.dataset.active).toBeUndefined();
    // **必须保持置灰**。弹窗主按钮是幂等开关：内容脚本看到 renderer 非空就执行还原，
    // 所以在这个状态下放开按钮等于给用户一个"点一下就把正在跑的翻译静默撤掉"的陷阱。
    // 几百段的页面本来就会超过兜底时限，这条路径在真机上很常见。
    expect(toggle.disabled).toBe(true);
    // 也绝不能建议重新加载页面——那是唯一会把已完成部分全丢掉的建议。
    expect(status.textContent).not.toContain('重新加载页面');
    expect(sentTypes()).toEqual([MSG.GET_PAGE_STATE, MSG.TOGGLE_PAGE]);
  });
});

describe('引擎提示区', () => {
  it('引擎需要 Key 但没填时给出警告', async () => {
    // 只有空白字符也算没填：提示必须跟引擎真正判断"有没有 Key"的口径一致。
    await seedSettings({ engineId: 'openai-compat', engineConfig: { apiKey: '   ' } });
    await loadPopup();

    const { hint } = ui();
    expect(hint.classList.contains('warn')).toBe(true);
    expect(hint.textContent).toBe('该引擎需要 API Key，请先在设置中填写。');
  });

  it('填了 Key 就不再警告', async () => {
    await seedSettings({ engineId: 'openai-compat', engineConfig: { apiKey: 'sk-test' } });
    await loadPopup();

    const { hint } = ui();
    expect(hint.classList.contains('warn')).toBe(false);
    // 文案必须与"警告分支"互为补集：这句只在 Key **确实填了**时成立。
    expect(hint.textContent).toBe('已配置你自己的 API Key。');

    // 安全不变式：弹窗为了判断"要不要提示未配置 Key"必须持有完整设置（含密钥），
    // 但密钥绝不能落到 DOM 上。这条属性目前只靠上面那句判断为真，没有别的东西守着——
    // 日后有人加一句"把当前引擎配置显示出来"就会破，所以在这里钉住。
    expect(document.body.textContent).not.toContain('sk-test');
    expect(document.documentElement.outerHTML).not.toContain('sk-test');
  });

  it('零配置引擎不警告，并说明无需 Key', async () => {
    await seedSettings({ engineId: 'google' });
    await loadPopup();

    const { hint } = ui();
    expect(hint.classList.contains('warn')).toBe(false);
    expect(hint.textContent).toBe('零配置可用，无需 API Key。');
  });

  it('切换引擎后提示区跟着重算', async () => {
    await seedSettings({ engineId: 'google' });
    await loadPopup();

    const { engine, hint } = ui();
    expect(hint.classList.contains('warn')).toBe(false);

    engine.value = 'openai-compat';
    engine.dispatchEvent(new Event('change'));
    await waitFor(() => hint.classList.contains('warn'));
    expect(hint.textContent).toBe('该引擎需要 API Key，请先在设置中填写。');
  });
});

describe('语言与引擎选择的持久化', () => {
  it('切换目标语言写进存储，其它字段原样保留', async () => {
    await seedSettings({ targetLang: 'zh-Hans', engineId: 'google' });
    await loadPopup();

    const { targetLang } = ui();
    expect(targetLang.value).toBe('zh-Hans');

    targetLang.value = 'fr';
    targetLang.dispatchEvent(new Event('change'));

    await waitFor(async () => (await storedSettings()).targetLang === 'fr');
    const stored = await storedSettings();
    expect(stored.targetLang).toBe('fr');
    expect(stored.engineId).toBe('google');
    expect(stored.version).toBe(CURRENT_VERSION);
  });

  it('切换引擎写进存储，且不会抹掉已填的 API Key', async () => {
    await seedSettings({ engineId: 'google', engineConfig: { apiKey: 'sk-keep' } });
    await loadPopup();

    const { engine } = ui();
    engine.value = 'openai-compat';
    engine.dispatchEvent(new Event('change'));

    await waitFor(async () => (await storedSettings()).engineId === 'openai-compat');
    const stored = await storedSettings();
    expect(stored.engineId).toBe('openai-compat');
    // 保存的是弹窗手里那份**完整**设置：Key 必须原样写回，不能被投影掉的字段覆盖成空。
    expect((stored.engineConfig as { apiKey?: string }).apiKey).toBe('sk-keep');
  });

  it('保存被拒绝时说明原因并回滚下拉，不留下"改了其实没生效"', async () => {
    await seedSettings({ targetLang: 'zh-Hans', engineId: 'google' });
    await loadPopup();

    const { targetLang, status } = ui();
    // 真实可达：存储里的版本高于本代码时 saveSettings 明确拒绝（用户回退过版本）。
    await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: CURRENT_VERSION + 1 } });

    targetLang.value = 'fr';
    targetLang.dispatchEvent(new Event('change'));

    await waitFor(() => status.textContent.includes('设置未能保存'));
    // 下拉回到真正生效的那一项：让"没保存成功"这件事立刻可见，而不是下次打开才弹回去。
    expect(targetLang.value).toBe('zh-Hans');
    expect(status.textContent).toContain('已跳过保存');
    // 存储里仍是那份更高版本的设置，没有被旧 schema 覆盖。
    expect((await storedSettings()).version).toBe(CURRENT_VERSION + 1);
  });

  it('页面已翻译时改目标语言会提示"重新翻译此页生效"', async () => {
    await seedSettings({ targetLang: 'zh-Hans' });
    respondWithState(() => pageState({ translated: true, total: 2, done: 2 }));
    await loadPopup();

    const { targetLang, status } = ui();
    expect(status.textContent).toBe('已翻译 2 / 2 段');

    targetLang.value = 'fr';
    targetLang.dispatchEvent(new Event('change'));

    await waitFor(() => status.textContent.includes('重新翻译此页生效'));
    expect(status.textContent).toBe('目标语言已更新，重新翻译此页生效。');
    expect((await storedSettings()).targetLang).toBe('fr');
  });
});

describe('显示模式', () => {
  it('选项就是「仅译文 / 双语对照」，并按存储里的值选中', async () => {
    await seedSettings({ displayMode: 'bilingual' });
    await loadPopup();

    const { displayMode } = ui();
    // 选项清单来自 shared/settings 的那一份（弹窗与设置页共用），不手抄。
    expect(Array.from(displayMode.options).map((option) => [option.value, option.textContent])).toEqual(
      DISPLAY_MODES.map((mode) => [mode.value, mode.label]),
    );
    expect(displayMode.value).toBe('bilingual');
  });

  it('默认选中「仅译文」（用户要的就是这个）', async () => {
    await seedSettings({});
    await loadPopup();
    expect(ui().displayMode.value).toBe('translated-only');
  });

  it('切换显示模式写进存储，其它字段原样保留', async () => {
    await seedSettings({ displayMode: 'translated-only', targetLang: 'ja', engineId: 'google' });
    await loadPopup();

    const { displayMode } = ui();
    displayMode.value = 'bilingual';
    displayMode.dispatchEvent(new Event('change'));

    await waitFor(async () => (await storedSettings()).displayMode === 'bilingual');
    const stored = await storedSettings();
    expect(stored.displayMode).toBe('bilingual');
    // 整份回写：别的字段不能被这次改动抹掉。
    expect(stored.targetLang).toBe('ja');
    expect(stored.engineId).toBe('google');
  });

  it('页面已翻译时如实提示"重新翻译此页生效"，不假装立即生效', async () => {
    await seedSettings({ displayMode: 'translated-only' });
    respondWithState(() => pageState({ translated: true, total: 2, done: 2 }));
    await loadPopup();

    const { displayMode, status } = ui();
    expect(status.textContent).toBe('已翻译 2 / 2 段');

    displayMode.value = 'bilingual';
    displayMode.dispatchEvent(new Event('change'));

    await waitFor(() => status.textContent.includes('重新翻译此页生效'));
    expect(status.textContent).toBe('显示模式已更新，重新翻译此页生效。');
    // 只写设置：弹窗不顺手重译、也不还原页面（那会把已经译好的内容丢掉）。
    expect(sentTypes()).toEqual([MSG.GET_PAGE_STATE]);
  });

  it('页面还没翻译时不打扰用户（不出现"重新翻译"这句）', async () => {
    await seedSettings({ displayMode: 'translated-only' });
    respondWithState(() => pageState());
    await loadPopup();

    const { displayMode, status } = ui();
    displayMode.value = 'bilingual';
    displayMode.dispatchEvent(new Event('change'));

    await waitFor(async () => (await storedSettings()).displayMode === 'bilingual');
    expect(status.textContent).toBe('按 Alt+T 也可以快速开关。');
  });

  it('保存被拒绝时说明原因并回滚下拉，不留下"改了其实没生效"', async () => {
    await seedSettings({ displayMode: 'translated-only' });
    await loadPopup();

    const { displayMode, status } = ui();
    // 真实可达：存储里的版本高于本代码时 saveSettings 明确拒绝（用户回退过版本）。
    await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: CURRENT_VERSION + 1 } });

    displayMode.value = 'bilingual';
    displayMode.dispatchEvent(new Event('change'));

    await waitFor(() => status.textContent.includes('设置未能保存'));
    expect(displayMode.value).toBe('translated-only');
    expect(status.textContent).toContain('已跳过保存');
  });
});

describe('设置入口', () => {
  it('齿轮按钮打开设置页', async () => {
    await loadPopup();

    expect(chromeStub.runtime.openOptionsPageCalls).toBe(0);
    ui().optionsButton.click();
    expect(chromeStub.runtime.openOptionsPageCalls).toBe(1);
  });
});
