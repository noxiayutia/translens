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
import { DEFAULT_ENGINE_ID, getEngine } from '../../src/engines/registry';
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
  hoverToggle: HTMLInputElement;
  selectionToggle: HTMLInputElement;
  targetLang: HTMLSelectElement;
  engine: HTMLSelectElement;
  hint: HTMLParagraphElement;
  optionsButton: HTMLButtonElement;
}

/** `popup.html` 里的九个控件；按 id 取，取不到直接失败。 */
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
    hoverToggle: pick<HTMLInputElement>('hover-translate'),
    selectionToggle: pick<HTMLInputElement>('selection-translate'),
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

/**
 * 直读存储里的站点规则：解除按钮"只删了哪一条"的落盘结果从这里看。
 * 读的是**存储**而不是弹窗内存里那份 `settings`——按对象身份删的语义只有落盘之后才可观察。
 */
async function storedSiteRules(): Promise<Array<{ pattern: string; action: string }>> {
  const rules = (await storedSettings()).siteRules;
  return Array.isArray(rules) ? (rules as Array<{ pattern: string; action: string }>) : [];
}

/**
 * 给活动标签页替身装上 `url`——它是站点规则判定的唯一输入（弹窗读 `tab.url` 的主机名）。
 *
 * 替身默认的活动标签**没有** url（见 `chrome-stub` 的 `DEFAULT_ACTIVE_TAB`），和真机上
 * `chrome://` 一类受限页面同形；所以只有显式调过本函数的用例才会命中提示行，既有用例的
 * 行为一点没动。传 `undefined` 就是"拿不到 url"那条路径。
 */
function stubActiveTabUrl(url: string | undefined): void {
  chromeStub.tabs.activeTabs = [{ id: 7, active: true, currentWindow: true, url }];
}

/**
 * 让 `chrome.tabs.query` 的第 `nth` 次调用拒绝，其余照常走替身。
 *
 * 真机上它极少拒绝，但一旦拒绝就是一次"未处理的拒绝"——本文件与 `popup.ts` 都明文要求
 * 这种失败必须变成用户看得见的一句话。按**次数**而不是全局失败：初始化要查两次
 * （站点规则的主机名、页面状态的 tabId），只让其中一次失败才能观察"另一条路不受影响"。
 */
function rejectQueryCall(nth: number): void {
  const real = chromeStub.tabs.query.bind(chromeStub.tabs);
  let calls = 0;
  chromeStub.tabs.query = (queryInfo: unknown) => {
    calls += 1;
    if (calls === nth) return Promise.reject(new Error('标签页查询失败'));
    return real(queryInfo);
  };
}

/**
 * 跑一段代码并收走这期间产生的未处理拒绝。
 *
 * `expect(rejections).toEqual([])` 在这几条用例里是**承重**断言：把就地处理的 catch 删掉，
 * 未处理的拒绝本身不会让任何断言变红（vitest 只在收尾时把它算进退出码），红的是这一条。
 * 本文件已有一处内联写法（"设置读不出来时不是死弹窗"），这里抽出来给"拒绝必须就地处理"
 * 那几条用例共用，不动那处既有用例。
 */
async function unhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  try {
    await run();
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  return rejections;
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
    // 9 个控件（7 个原有 + 「悬停翻译」「划词翻译」两个快捷开关，规格 §7.1 第 5 项）
    // + 站点规则提示行 `#site-rule-hint` 与它的「解除」按钮 `#site-rule-unblock`（Task 3）。
    expect(parsed.querySelectorAll('[id]').length).toBe(11);
  });
});

describe('弹窗初始化', () => {
  it('按存储里的设置选中目标语言与档案；下拉 = 免费接口 + 每个档案按名字', async () => {
    await seedSettings({
      targetLang: 'ja',
      engineId: 'p-deep',
      profiles: [
        { id: 'p-deep', label: '我的 DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat'], activeModel: 'deepseek-chat', apiKey: 'sk-test' },
      ],
    });
    await loadPopup();

    const { targetLang, engine } = ui();
    expect(targetLang.value).toBe('ja');
    expect(engine.value).toBe('p-deep');
    expect(Array.from(targetLang.selectedOptions).map((option) => option.value)).toEqual(['ja']);

    // 选项清单来自 core/lang 与设置里的档案列表，弹窗不另抄一份。
    expect(Array.from(targetLang.options).map((option) => option.value)).toEqual(
      LANGUAGES.map((lang) => lang.code),
    );
    const free = getEngine(DEFAULT_ENGINE_ID);
    expect(Array.from(engine.options).map((option) => [option.value, option.textContent])).toEqual([
      [free.id, free.name],
      ['p-deep', '我的 DeepSeek'],
    ]);
    // 活动标签页是唯一的查询口径：后台标签页的状态不该被读进来。
    // 初始化时查两次、各取一件东西：`tabId`（页面状态）与 `url`（站点规则的主机名）。
    // 两次的条件必须**完全一致**——任一次带上别的条件都可能读到非活动标签页。
    expect(chromeStub.tabs.queries).toEqual([
      { active: true, currentWindow: true },
      { active: true, currentWindow: true },
    ]);
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

describe('引擎提示区（判据看的是 resolveEngine 解析出来的那一份配置）', () => {
  /** 档案快捷构造：用例只覆盖自己在意的字段。 */
  function profileOf(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'p-1',
      label: '我的接口',
      baseUrl: 'https://api.test.example/v1',
      models: ['m'],
      activeModel: 'm',
      apiKey: 'sk-test',
      ...over,
    };
  }

  it('当前档案需要 Key 但没填时给出警告（纯空白也算没填，与引擎口径一致）', async () => {
    await seedSettings({ engineId: 'p-1', profiles: [profileOf({ apiKey: '   ' })] });
    await loadPopup();

    const { hint } = ui();
    expect(hint.classList.contains('warn')).toBe(true);
    expect(hint.textContent).toBe('该引擎需要 API Key，请先在设置中填写。');
  });

  it('当前档案填了 Key 就不再警告', async () => {
    // origin 已授权（真机上这个档案必然在设置页保存过一次才可能有 Key）。
    chromeStub.permissions.grantedOrigins.add('https://api.test.example/*');
    await seedSettings({ engineId: 'p-1', profiles: [profileOf()] });
    await loadPopup();

    const { hint } = ui();
    expect(hint.classList.contains('warn')).toBe(false);
    // 文案必须与"警告分支"互为补集：这句只在 Key **确实填了**时成立。
    expect(hint.textContent).toBe('已配置你自己的 API Key。');

    // 安全不变式：弹窗为了判断"要不要提示未配置 Key"必须持有完整设置（含每个档案的密钥），
    // 但密钥绝不能落到 DOM 上。这条属性目前只靠上面那句判断为真，没有别的东西守着——
    // 日后有人加一句"把当前档案配置显示出来"就会破，所以在这里钉住。
    expect(document.body.textContent).not.toContain('sk-test');
    expect(document.documentElement.outerHTML).not.toContain('sk-test');
  });

  it('隐私：三个档案各塞不同密钥，一个都不许出现在 DOM 里（列表渲染比单字段更容易带出去）', async () => {
    chromeStub.permissions.grantedOrigins.add('https://api.test.example/*');
    await seedSettings({
      engineId: 'p-2',
      profiles: [
        profileOf({ id: 'p-1', label: 'DeepSeek 直连', apiKey: 'sk-alpha' }),
        profileOf({ id: 'p-2', label: '硅基流动', apiKey: 'sk-beta' }),
        profileOf({ id: 'p-3', label: 'Ollama 本机', apiKey: 'sk-gamma' }),
      ],
    });
    await loadPopup();

    for (const secret of ['sk-alpha', 'sk-beta', 'sk-gamma']) {
      expect(document.body.textContent).not.toContain(secret);
      expect(document.documentElement.outerHTML).not.toContain(secret);
    }
    // 下拉按名字列出三个档案——名字带出来了，密钥没带。
    const { engine } = ui();
    expect(Array.from(engine.options).map((option) => option.textContent)).toEqual([
      getEngine(DEFAULT_ENGINE_ID).name,
      'DeepSeek 直连',
      '硅基流动',
      'Ollama 本机',
    ]);
  });

  it('切到**未授权**的档案：提示区如实说要回设置页保存一次授权，不静默', async () => {
    // grantedOrigins 是空的：这个 origin 从没在用户手势里申请过。
    await seedSettings({ engineId: 'p-1', profiles: [profileOf()] });
    await loadPopup();

    const { hint } = ui();
    // Key 检查先过（填了），未授权检查是异步的（chrome.permissions.contains）——等它回来。
    await waitFor(() => hint.classList.contains('warn'));
    expect(hint.textContent).toContain('https://api.test.example/*');
    expect(hint.textContent).toContain('未授权');
    expect(hint.textContent).toContain('设置页');
  });

  it('零配置引擎不警告，并说明无需 Key', async () => {
    await seedSettings({ engineId: 'google' });
    await loadPopup();

    const { hint } = ui();
    expect(hint.classList.contains('warn')).toBe(false);
    expect(hint.textContent).toBe('零配置可用，无需 API Key。');
  });

  it('切换引擎后提示区跟着重算（免费 ↔ 没填 Key 的档案）', async () => {
    await seedSettings({ engineId: 'google', profiles: [profileOf({ apiKey: '' })] });
    await loadPopup();

    const { engine, hint } = ui();
    expect(hint.classList.contains('warn')).toBe(false);

    engine.value = 'p-1';
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

  it('选中档案即落盘档案 id，且整份回写不会抹掉任何档案已填的 Key', async () => {
    await seedSettings({
      engineId: 'google',
      profiles: [
        { id: 'p-a', label: 'A 家', baseUrl: 'https://a.example/v1', models: ['ma'], activeModel: 'ma', apiKey: 'sk-keep-a' },
        { id: 'p-b', label: 'B 家', baseUrl: 'https://b.example/v1', models: ['mb'], activeModel: 'mb', apiKey: 'sk-keep-b' },
      ],
    });
    await loadPopup();

    const { engine } = ui();
    engine.value = 'p-b';
    engine.dispatchEvent(new Event('change'));

    await waitFor(async () => (await storedSettings()).engineId === 'p-b');
    const stored = await storedSettings();
    // 落盘的是档案 id（弹窗与存储的口径：engineId = 档案 id 或 google），不是 label。
    expect(stored.engineId).toBe('p-b');
    // 保存的是弹窗手里那份**完整**设置：两份 Key 都必须原样写回，不能被投影掉的字段覆盖成空。
    const profiles = stored.profiles as Array<Record<string, unknown>>;
    expect(profiles.map((profile) => profile.apiKey)).toEqual(['sk-keep-a', 'sk-keep-b']);
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

describe('悬停/划词快捷开关', () => {
  /**
   * 开关的三段行为：① 按存储回填勾选；② 改动写进存储并**推给当前页面**
   * （内容脚本当场重新挂/摘监听器）；③ 拿不到确认回执时如实说要重新加载——
   * 绝不能静默地让用户以为生效了（任务书点名要求）。
   */

  function applySettingsResponder(ack: boolean): void {
    chromeStub.tabs.responder = (_tabId, message) => {
      const type = (message as { type?: string } | null)?.type;
      if (type === MSG.GET_PAGE_STATE || type === MSG.TOGGLE_PAGE) {
        return pageState({ translated: true, total: 2, done: 2 });
      }
      // 新版内容脚本对 APPLY_SETTINGS 回 { ok: true }；旧版/没有内容脚本走 undefined / 拒绝分支。
      return ack ? { ok: true } : undefined;
    };
  }

  it('勾选状态按存储里的设置回填', async () => {
    await seedSettings({ hoverTranslate: false, selectionTranslate: true });
    await loadPopup();

    const { hoverToggle, selectionToggle } = ui();
    expect(hoverToggle.checked).toBe(false);
    expect(selectionToggle.checked).toBe(true);
  });

  it('默认存储（没写过这两项）按默认值勾选：两个都是 true', async () => {
    await loadPopup();
    expect(ui().hoverToggle.checked).toBe(true);
    expect(ui().selectionToggle.checked).toBe(true);
  });

  it('取消勾选：写进存储，并把 APPLY_SETTINGS 推给活动标签页', async () => {
    applySettingsResponder(true);
    await seedSettings({ hoverTranslate: true, targetLang: 'fr' });
    await loadPopup();

    const { hoverToggle } = ui();
    hoverToggle.checked = false;
    hoverToggle.dispatchEvent(new Event('change'));

    await waitFor(async () => (await storedSettings()).hoverTranslate === false);
    const pushed = chromeStub.tabs.sent
      .map(({ message }) => message as { type?: string; payload?: Record<string, unknown> })
      .find((message) => message.type === MSG.APPLY_SETTINGS);
    expect(pushed?.payload).toEqual({ hoverTranslate: false, selectionTranslate: true, targetLang: 'fr' });
    // 只推这一条：不顺手发 TOGGLE_PAGE/TRANSLATE_PAGE，开关不该触发重译或还原。
    expect(sentTypes().filter((type) => type === MSG.APPLY_SETTINGS)).toHaveLength(1);
    expect(sentTypes().filter((type) => type === MSG.TOGGLE_PAGE || type === MSG.TRANSLATE_PAGE)).toHaveLength(0);
  });

  it('内容脚本确认回执：状态行明确说"当前页面即时生效"', async () => {
    applySettingsResponder(true);
    await loadPopup();

    const { selectionToggle, status } = ui();
    selectionToggle.checked = false;
    selectionToggle.dispatchEvent(new Event('change'));

    await waitFor(() => status.textContent.includes('即时生效'));
    expect(status.textContent).toContain('划词翻译');
  });

  it('没有内容脚本（sendMessage 被拒）：如实说需要重新加载页面，不假装生效', async () => {
    await seedSettings({ hoverTranslate: true });
    await loadPopup();

    const { hoverToggle, status } = ui();
    // 走"端口都没开"的真实拒绝路径（chrome:// 等没有内容脚本的页面）。
    chromeStub.tabs.rejectSendMessage = true;
    hoverToggle.checked = false;
    hoverToggle.dispatchEvent(new Event('change'));

    await waitFor(() => status.textContent.includes('重新加载页面后生效'));
    expect(status.textContent).toContain('悬停翻译');
    // 但设置本身**已经保存**：下次加载的页面会按新值挂监听。
    expect((await storedSettings()).hoverTranslate).toBe(false);
  });

  it('内容脚本没回执（旧版不认识 APPLY_SETTINGS）：同样不谎报即时生效', async () => {
    applySettingsResponder(false); // responder 对 APPLY_SETTINGS 回 undefined
    await loadPopup();

    const { hoverToggle, status } = ui();
    hoverToggle.checked = false;
    hoverToggle.dispatchEvent(new Event('change'));

    await waitFor(() => status.textContent.includes('重新加载页面后生效'));
    expect((await storedSettings()).hoverTranslate).toBe(false);
  });

  it('保存被拒绝：勾选回滚到真正生效的那一档并说明原因', async () => {
    await seedSettings({ hoverTranslate: true });
    await loadPopup();

    const { hoverToggle, status } = ui();
    await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: CURRENT_VERSION + 1 } });

    hoverToggle.checked = false;
    hoverToggle.dispatchEvent(new Event('change'));

    await waitFor(() => status.textContent.includes('设置未能保存'));
    expect(hoverToggle.checked).toBe(true);
    // 保存都没成，就更不该往页面推 APPLY_SETTINGS。
    expect(sentTypes()).toEqual([MSG.GET_PAGE_STATE]);
  });
});

/**
 * 站点规则「永不翻译」在弹窗里的那一半（内容脚本那一半见 `tests/content/index.test.ts`）。
 *
 * 判定的输入是**活动标签页的 url**：替身默认的活动标签没有 url，所以每个用例都得先
 * `stubActiveTabUrl(...)`——那正是"当前站点是哪个"的唯一来源。判定本身（通配、首条命中）
 * 由 `core/site-rules` 的测试守着，这里只钉弹窗的三件事：**什么时候显示**、**解除删哪一条**、
 * **写盘失败会不会静默**。
 *
 * `hidden` 断言用的是属性而不是样式：`popup.css` 里的 `.hint` 是 flex 容器、要显式补一条
 * `.hint[hidden] { display: none }` 才盖得住（见那份 CSS 的注释），而 `hidden` 属性正是
 * 逻辑与样式之间那个可断言的接口。
 */
describe('站点规则「永不翻译」：弹窗状态行与一键解除', () => {
  it('当前站点命中 never：提示行出现，并带一个解除按钮', async () => {
    stubActiveTabUrl('https://blocked.example.com/path');
    await seedSettings({ siteRules: [{ pattern: '*.example.com', action: 'never' }] });
    await loadPopup();
    const hint = document.getElementById('site-rule-hint') as HTMLElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('永不翻译');
    expect(document.getElementById('site-rule-unblock')).not.toBeNull();
  });

  it('未命中时提示行整行隐藏（不用空文案占位）', async () => {
    stubActiveTabUrl('https://ok.example.com/');
    await seedSettings({ siteRules: [{ pattern: 'blocked.example.com', action: 'never' }] });
    await loadPopup();
    expect((document.getElementById('site-rule-hint') as HTMLElement).hidden).toBe(true);
  });

  it('点解除：只删掉命中的那一条，其余规则原样留在存储里', async () => {
    stubActiveTabUrl('https://blocked.example.com/');
    await seedSettings({
      siteRules: [
        { pattern: '*.example.com', action: 'never' },
        { pattern: 'keep.me', action: 'never' },
      ],
    });
    await loadPopup();
    (document.getElementById('site-rule-unblock') as HTMLButtonElement).click();
    await waitFor(async () => (await storedSiteRules()).length === 1);
    expect((await storedSiteRules())[0].pattern).toBe('keep.me');
    // 解除成功的**界面**结果也要钉住：删掉成功分支里那句 `refreshSiteRuleHint()` 或那句
    // 状态文案，只有这里会红（在这之前，"点完解除界面上发生了什么"是零读数的）。
    const hint = document.getElementById('site-rule-hint') as HTMLElement;
    // `=== true` 而不是裸 `hint.hidden`：TS 的 DOM 类型里 `hidden` 是 `boolean | 'until-found'`
    // （`hidden="until-found"` 那个新形态），裸值不满足 `waitFor` 的 `boolean` 谓词。
    await waitFor(() => hint.hidden === true);
    expect(hint.hidden).toBe(true);
    expect(ui().status.textContent).toBe('已解除，点「翻译此页」开始');
  });

  /**
   * 「按对象身份删」的**唯一**读数：上面那条用例里两条规则 pattern 各不相同，按 pattern
   * 过滤与按身份过滤给出同一个结果，它杀不掉那个变异。同 pattern 两条是真实可达的脏数据
   * （`pickSiteRules` 不去重、不排序），只有它能分辨两种删法。
   */
  it('同 pattern 有多条时只撤掉生效的那一条，不按 pattern 一锅端', async () => {
    stubActiveTabUrl('https://blocked.example.com/');
    await seedSettings({
      siteRules: [
        { pattern: '*.example.com', action: 'never' },
        { pattern: '*.example.com', action: 'never' },
        { pattern: 'keep.me', action: 'never' },
      ],
    });
    await loadPopup();

    (document.getElementById('site-rule-unblock') as HTMLButtonElement).click();

    await waitFor(async () => (await storedSiteRules()).length === 2);
    // 撤掉的是首条命中的那一条；同 pattern 的第二条与无关的 keep.me 都原样留着。
    expect((await storedSiteRules()).map((rule) => rule.pattern)).toEqual(['*.example.com', 'keep.me']);
  });

  /**
   * 「总是翻译」的站点**不许**显示"此站已设为「永不翻译」"。
   *
   * 判据必须是 `isNeverTranslate`（只看首条命中的 action），不是"命中了任意一条规则"：
   * `{pattern, action: 'translate'}` 是合法的 `SiteRule`，把判据写成 `matchSiteRule(...) !== null`
   * 会在这条夹具上亮起一行彻头彻尾的假话，而其余用例（action 全是 never）一条都不会红。
   */
  it('规则是「总是翻译」时不显示：判据是 never，不是"命中任意规则"', async () => {
    stubActiveTabUrl('https://blocked.example.com/');
    await seedSettings({ siteRules: [{ pattern: '*.example.com', action: 'translate' }] });
    await loadPopup();
    expect((document.getElementById('site-rule-hint') as HTMLElement).hidden).toBe(true);
  });

  it('受限页面拿不到 url 时不报错、提示行隐藏', async () => {
    stubActiveTabUrl(undefined); // chrome:// 页面，tab.url 不可得
    await seedSettings({ siteRules: [{ pattern: '*.example.com', action: 'never' }] });
    const rejections = await unhandledRejections(loadPopup);

    const { status } = ui();
    expect(rejections).toEqual([]);
    expect((document.getElementById('site-rule-hint') as HTMLElement).hidden).toBe(true);
    // "拿不到 url"是**正常情况**（每个 chrome:// 页面都这样），不是错误：状态行仍是页面
    // 状态那句。少了 `activeHostname` 里的 url 守卫，这里会变成一句地址错误——
    // 每个浏览器内置页面都平白挨一句吓人的话。
    expect(status.textContent).not.toContain('拿不到当前标签页');
    expect(status.textContent).toContain('不支持翻译');
  });

  /**
   * url 是字符串但**解析不了**：与"拿不到"同等处理。
   *
   * 夹具的 url 原文与规则 pattern 故意是同一个串：任何"退回用 url 原文当主机名"的实现
   * （`catch { return tab.url }` 是最像样的那种写法）都会让这条规则命中、提示行亮起来。
   * 用例要钉的就是"解析失败不许拿原串硬当主机名"。
   */
  it('url 解析不了时不拿原串当主机名：提示行隐藏、不抛错', async () => {
    stubActiveTabUrl('MUTANT');
    await seedSettings({ siteRules: [{ pattern: 'MUTANT', action: 'never' }] });
    const rejections = await unhandledRejections(loadPopup);

    expect(rejections).toEqual([]);
    expect((document.getElementById('site-rule-hint') as HTMLElement).hidden).toBe(true);
  });

  /**
   * 初始化那条链上的拒绝：`start()` 直接 await `refreshSiteRuleHint()`，
   * **不在 `runSafely` 的保护里**（本文件那条纪律：任何没被就地处理的拒绝都要变成用户
   * 看得见的一句话）。初始化查两次标签页：第 1 次取 tabId（页面状态），第 2 次取 url
   * （站点规则），放第 2 次失败。
   *
   * 这条用例同时钉住**顺序**：那句话必须是状态行里最后写进去的。把 `refreshSiteRuleHint()`
   * 挪回 `applySettings` 里 fire-and-forget，紧接着的页面状态渲染会把它盖掉（两处写的是
   * 同一个 `#status`），这条就红了。
   */
  it('初始化时读不到标签页：状态行说出原因，主按钮不受影响、也不留未处理的拒绝', async () => {
    stubActiveTabUrl('https://blocked.example.com/');
    await seedSettings({ siteRules: [{ pattern: '*.example.com', action: 'never' }] });
    rejectQueryCall(2);
    const rejections = await unhandledRejections(loadPopup);

    const { status, toggle } = ui();
    expect(rejections).toEqual([]);
    expect(status.textContent).toContain('拿不到当前标签页');
    // 主按钮照旧按**页面状态**渲染（这里没有内容脚本 → 'unavailable'），不是"重新试一次"：
    // 读不到标签页地址与"这个页面能不能翻译"是两件事。
    expect(toggle.textContent).toBe('此页面不可用');
    expect(toggle.disabled).toBe(true);
    expect(status.textContent).not.toContain('重新试一次');
    expect((document.getElementById('site-rule-hint') as HTMLElement).hidden).toBe(true);
  });

  /**
   * 点解除那条链上的拒绝：`activeHostname()` 在 try/catch 之外的那次 `tabs.query`。
   * 读不到标签页就不知道要删哪一条，所以**什么都不删**，但必须说出来。
   */
  it('点解除时读不到标签页：说出原因，规则原样留在存储里、提示行还在、主按钮不动', async () => {
    stubActiveTabUrl('https://blocked.example.com/');
    await seedSettings({ siteRules: [{ pattern: '*.example.com', action: 'never' }] });
    await loadPopup();

    const { status, toggle } = ui();
    const hint = document.getElementById('site-rule-hint') as HTMLElement;
    expect(hint.hidden).toBe(false);
    const before = { text: toggle.textContent, disabled: toggle.disabled };

    // 初始化之后（这一次点击的）第 1 次查询失败。
    rejectQueryCall(1);
    const rejections = await unhandledRejections(async () => {
      (document.getElementById('site-rule-unblock') as HTMLButtonElement).click();
      await waitFor(() => status.textContent.includes('拿不到当前标签页'));
    });

    expect(rejections).toEqual([]);
    // 主按钮一个字节都不许变：这不是"页面不可用"，更不许说成"重新试一次"。
    expect(toggle.textContent).toBe(before.text);
    expect(toggle.disabled).toBe(before.disabled);
    // 什么都没删（不知道删哪条），提示行还亮着，用户可以直接再点一次。
    expect((await storedSiteRules()).length).toBe(1);
    expect(hint.hidden).toBe(false);
  });

  it('写盘失败不静默：如实说解除失败，规则与提示行都留在原地', async () => {
    stubActiveTabUrl('https://blocked.example.com/');
    await seedSettings({ siteRules: [{ pattern: '*.example.com', action: 'never' }] });
    await loadPopup();

    const hint = document.getElementById('site-rule-hint') as HTMLElement;
    expect(hint.hidden).toBe(false);
    // 真实可达：存储里的版本高于本代码时 saveSettings 明确拒绝（用户回退过版本）。
    await chromeStub.storage.local.set({
      [SETTINGS_KEY]: { version: CURRENT_VERSION + 1, siteRules: [{ pattern: '*.example.com', action: 'never' }] },
    });

    (document.getElementById('site-rule-unblock') as HTMLButtonElement).click();

    const { status } = ui();
    await waitFor(() => status.textContent.includes('解除失败'));
    // 没写盘就不能报"已解除"：提示行与存储都得留在原样，用户还能再点一次。
    expect(status.textContent).not.toContain('已解除');
    // 原因照本文件既有的 `errorText` 口径带出来，不是一句没有来路的"失败了"。
    expect(status.textContent).toContain('已跳过保存');
    expect(hint.hidden).toBe(false);
    expect((await storedSiteRules()).length).toBe(1);
  });
});
