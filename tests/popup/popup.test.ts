/**
 * @vitest-environment jsdom
 *
 * 弹窗（WU9 / Task 18）的行为测试。
 *
 * 被测的 `src/popup/popup.ts` 在 **import 时**就跑 `init()`：模块顶层先按 id 取 DOM
 * 元素（所以 DOM 必须先就位），然后 `await loadSettings()`。于是每个用例的顺序固定为
 * 装替身 → 写存储 → 装 DOM → `import` → 等 `init()` 跑完。`vi.resetModules()` 保证
 * 每个用例拿到一份新的模块实例——弹窗里持有 `settings` 与若干闭包，共享实例会让用例互相串味。
 *
 * DOM 用 `src/popup/popup.html` 的**真实内容**（`DOMParser` 解析后取 body），不手抄一份结构：
 * id 改名、控件漏写这类错误应当在测试里失败，而不是两边一起错。同理，下拉框的期望值来自
 * `core/lang` 与 `engines/registry`，不手抄语言表。
 *
 * 内容脚本在真机上是 `chrome.tabs.sendMessage` 的接收方，替身不注册它（见 `chrome-stub`
 * 的 `StubTabs.responder`），由用例扮演：**只回话、不断言**——弹窗把 sendMessage 的拒绝
 * 当作"受限页面"吞掉了，在 responder 里断言失败会被吞成一次静默降级。要断言的东西一律
 * 事后再查 `chromeStub.tabs.sent`。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANGUAGES } from '../../src/core/lang';
import { ENGINES } from '../../src/engines/registry';
import { MSG, type PageState } from '../../src/shared/messages';
import { CURRENT_VERSION, SETTINGS_KEY } from '../../src/shared/settings';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';

/**
 * 用 `import.meta.dirname` 拼路径，而不是 `new URL('...', import.meta.url)`：后者会被
 * Vite 的资源转换改写成 http 地址（jsdom 环境下 `fileURLToPath` 直接拒绝它）。
 */
const POPUP_HTML_PATH = join(import.meta.dirname, '..', '..', 'src', 'popup', 'popup.html');

let chromeStub: ChromeStub;

interface PopupUi {
  toggle: HTMLButtonElement;
  status: HTMLParagraphElement;
  targetLang: HTMLSelectElement;
  engine: HTMLSelectElement;
  hint: HTMLParagraphElement;
  optionsButton: HTMLButtonElement;
}

/** `popup.html` 里的六个控件；按 id 取，取不到直接失败。 */
function ui(): PopupUi {
  const pick = <T extends HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`popup.html 里没有 #${id}`);
    return found as T;
  };
  return {
    toggle: pick<HTMLButtonElement>('toggle'),
    status: pick<HTMLParagraphElement>('status'),
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
    // 弹窗只会发这两条；真机上发别的也没人接，这里如实拒绝。
    return Promise.reject(new Error(`内容脚本不处理 ${String(type)}`));
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
    expect(parsed.querySelectorAll('[id]').length).toBe(6);
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
    expect(toggle.textContent).toBe('此页面不可用');
    expect(status.textContent).toContain('不支持翻译');

    // 置灰的按钮点不动。拒绝已经被 `init` 吞掉（`void init()` 一旦 reject，
    // vitest 会作为未处理的拒绝报出来），所以这里能跑到底本身就是"没抛错"的证据。
    toggle.click();
    await settle();
    expect(sentTypes()).toEqual([MSG.GET_PAGE_STATE]);
  });

  it('点击时接收方才消失：降级为不可用文案，不抛错', async () => {
    respondWithState(() => pageState());
    await loadPopup();

    const { toggle, status } = ui();
    expect(toggle.disabled).toBe(false);

    chromeStub.tabs.rejectSendMessage = true;
    toggle.click();
    await waitFor(() => toggle.disabled);
    expect(toggle.textContent).toBe('此页面不可用');
    expect(status.textContent).toContain('不支持翻译');
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
    expect(hint.textContent).toBe('使用你自己配置的接口。');
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
});

describe('设置入口', () => {
  it('齿轮按钮打开设置页', async () => {
    await loadPopup();

    expect(chromeStub.runtime.openOptionsPageCalls).toBe(0);
    ui().optionsButton.click();
    expect(chromeStub.runtime.openOptionsPageCalls).toBe(1);
  });
});
