/**
 * @vitest-environment jsdom
 *
 * 设置页（最小可用版）的行为测试。
 *
 * 被测的 `src/options/options.ts` 在 **import 时**就跑 `init()`：模块顶层按 id 取 DOM 元素
 * （所以 DOM 必须先就位），`init()` 同步挂好监听器，然后才 `await loadSettings()`。于是每个
 * 用例的顺序固定为：装替身 → 写存储 → 装 DOM → `import` → 等初始化那串 await 跑完。
 * `vi.resetModules()` 保证每个用例拿到一份新的模块实例（页面里持有 `settings` 快照）。
 *
 * DOM 用 `src/options/options.html` 的**真实内容**（`DOMParser` 解析后取 body），不手抄一份
 * 结构：id 改名、控件漏写这类错误应当在测试里失败，而不是两边一起错。下拉框的期望值来自
 * `engines/registry` 与 `core/lang`，也不手抄。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANGUAGES } from '../../src/core/lang';
import { ENGINES } from '../../src/engines/registry';
import { CURRENT_VERSION, DISPLAY_MODES, SETTINGS_KEY } from '../../src/shared/settings';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';

/**
 * 用 `import.meta.dirname` 拼路径，而不是 `new URL('...', import.meta.url)`：后者会被
 * Vite 的资源转换改写成 http 地址（jsdom 环境下 `fileURLToPath` 直接拒绝它）。
 */
const OPTIONS_HTML_PATH = join(import.meta.dirname, '..', '..', 'src', 'options', 'options.html');

const CUSTOM_BASE_URL = 'https://api.example.com/v1';
/** 与 shared/host-permission 的 originPattern 同形：申请授权的对象是整串匹配模式。 */
const CUSTOM_ORIGIN_PATTERN = 'https://api.example.com/*';

let chromeStub: ChromeStub;

interface OptionsUi {
  engine: HTMLSelectElement;
  hint: HTMLParagraphElement;
  baseUrl: HTMLInputElement;
  apiKey: HTMLInputElement;
  toggleKey: HTMLButtonElement;
  model: HTMLInputElement;
  save: HTMLButtonElement;
  test: HTMLButtonElement;
  engineStatus: HTMLParagraphElement;
  targetLang: HTMLSelectElement;
  displayMode: HTMLSelectElement;
  clearCache: HTMLButtonElement;
  cacheStatus: HTMLParagraphElement;
}

/** `options.html` 里的控件；按 id 取，取不到直接失败（改名就该在这里响）。 */
function ui(): OptionsUi {
  const pick = <T extends HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`options.html 里没有 #${id}`);
    return found as T;
  };
  return {
    engine: pick<HTMLSelectElement>('engine'),
    hint: pick<HTMLParagraphElement>('engine-hint'),
    baseUrl: pick<HTMLInputElement>('base-url'),
    apiKey: pick<HTMLInputElement>('api-key'),
    toggleKey: pick<HTMLButtonElement>('toggle-key'),
    model: pick<HTMLInputElement>('model'),
    save: pick<HTMLButtonElement>('save'),
    test: pick<HTMLButtonElement>('test-connection'),
    engineStatus: pick<HTMLParagraphElement>('engine-status'),
    targetLang: pick<HTMLSelectElement>('target-lang'),
    displayMode: pick<HTMLSelectElement>('display-mode'),
    clearCache: pick<HTMLButtonElement>('clear-cache'),
    cacheStatus: pick<HTMLParagraphElement>('cache-status'),
  };
}

/** 往存储里写一份**故意不完整**的设置：`loadSettings` 是逐字段补齐的反序列化边界。 */
async function seedSettings(patch: Record<string, unknown> = {}): Promise<void> {
  await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: CURRENT_VERSION, ...patch } });
}

/** 直读存储：验证「改动真的落盘了」，而不是只改了页面里的内存副本。 */
async function storedSettings(): Promise<Record<string, unknown>> {
  const raw = await chromeStub.storage.local.get([SETTINGS_KEY]);
  return (raw[SETTINGS_KEY] ?? {}) as Record<string, unknown>;
}

function mountOptionsHtml(): void {
  const html = readFileSync(OPTIONS_HTML_PATH, 'utf-8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
}

/** 让已经排队的微任务跑完（替身里的存储与权限调用都是立即兑现的 promise）。 */
async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 轮询直到条件成立（点击后的收尾是异步的）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时：条件始终不成立');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 装 DOM、import 设置页模块，并等 `init()` 那串 await（loadSettings → 填表单）跑完。 */
async function loadOptions(): Promise<OptionsUi> {
  mountOptionsHtml();
  await import('../../src/options/options');
  await settle();
  return ui();
}

/**
 * 引擎只读 `status` / `ok` / `json()`，所以不必真的构造 `Response`——jsdom 环境里
 * 全局 `Response` 是 Node 那份，用它只会把用例和运行时实现绑在一起。
 */
function jsonResponse(data: unknown, status = 200): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => data } as unknown as Response;
}

/** OpenAI 兼容接口的编号响应。 */
function chatResponse(content: string): Response {
  return jsonResponse({ choices: [{ message: { role: 'assistant', content } }] });
}

/** 免费接口的响应形状：[[[译文, 原文, …], …], …]。 */
function googleResponse(text: string): Response {
  return jsonResponse([[[`【${text}】`, text]], null, 'en']);
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.resetModules();
  chromeStub = installChromeStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('设置页：初始化', () => {
  it('用存储里的设置填好引擎、目标语言、显示模式、接口地址、Key 与模型', async () => {
    await seedSettings({
      engineId: 'openai-compat',
      engineConfig: { apiKey: 'sk-seeded', baseUrl: CUSTOM_BASE_URL, model: 'gpt-4o-mini' },
      targetLang: 'ja',
      displayMode: 'bilingual',
    });

    const page = await loadOptions();

    // 下拉项的来源是 ENGINES / LANGUAGES，不是手抄的一份表。
    expect(Array.from(page.engine.options).map((option) => [option.value, option.textContent])).toEqual(
      ENGINES.map((engine) => [engine.id, engine.name]),
    );
    expect(Array.from(page.targetLang.options).map((option) => [option.value, option.textContent])).toEqual(
      LANGUAGES.map((lang) => [lang.code, lang.label]),
    );
    expect(page.engine.value).toBe('openai-compat');
    expect(page.targetLang.value).toBe('ja');
    expect(page.displayMode.value).toBe('bilingual');
    expect(page.baseUrl.value).toBe(CUSTOM_BASE_URL);
    expect(page.apiKey.value).toBe('sk-seeded');
    expect(page.model.value).toBe('gpt-4o-mini');
  });

  it('显示模式的两项与默认值与弹窗一致：仅译文 / 双语对照，默认仅译文', async () => {
    await seedSettings();
    const page = await loadOptions();

    // 选项清单来自 shared/settings 的那一份（弹窗与设置页共用），不手抄。
    expect(Array.from(page.displayMode.options).map((option) => [option.value, option.textContent])).toEqual(
      DISPLAY_MODES.map((mode) => [mode.value, mode.label]),
    );
    expect(page.displayMode.value).toBe('translated-only');
    // 设置页也要如实说明"仅译文"的代价：段落里的链接点不了。
    expect(document.getElementById('target-hint')?.textContent).toContain('链接点不了');
  });

  it('API Key 以 password 呈现，显示 / 隐藏按钮可切换且不动值', async () => {
    await seedSettings({ engineConfig: { apiKey: 'sk-secret' } });
    const page = await loadOptions();

    // 默认必须是遮住的：设置页可能被投屏或截图。
    expect(page.apiKey.type).toBe('password');
    expect(page.toggleKey.textContent).toBe('显示');

    page.toggleKey.click();
    expect(page.apiKey.type).toBe('text');
    expect(page.toggleKey.textContent).toBe('隐藏');
    expect(page.toggleKey.getAttribute('aria-pressed')).toBe('true');

    page.toggleKey.click();
    expect(page.apiKey.type).toBe('password');
    expect(page.toggleKey.getAttribute('aria-pressed')).toBe('false');
    // 值从头到尾没被动过。
    expect(page.apiKey.value).toBe('sk-secret');
  });

  it('隐私说明写明密钥只存本机、不上传，且除翻译请求外不发网络请求', async () => {
    await loadOptions();
    const text = document.body.textContent ?? '';
    expect(text).toContain('API Key 只存在本机');
    expect(text).toContain('不上传、不同步');
    expect(text).toContain('除翻译请求本身外，不发起任何网络请求');
    expect(text).toContain('contenteditable');
  });
});

describe('设置页：保存', () => {
  it('把表单内容写进 chrome.storage.local', async () => {
    await seedSettings();
    const page = await loadOptions();

    page.engine.value = 'openai-compat';
    page.engine.dispatchEvent(new Event('change'));
    page.baseUrl.value = CUSTOM_BASE_URL;
    page.apiKey.value = 'sk-typed';
    page.model.value = 'deepseek-chat';
    page.targetLang.value = 'en';
    page.displayMode.value = 'bilingual';

    page.save.click();
    await waitFor(() => page.engineStatus.dataset.kind !== undefined);

    expect(page.engineStatus.dataset.kind).toBe('ok');
    const stored = await storedSettings();
    expect(stored.engineId).toBe('openai-compat');
    expect(stored.engineConfig).toEqual({ apiKey: 'sk-typed', baseUrl: CUSTOM_BASE_URL, model: 'deepseek-chat' });
    expect(stored.targetLang).toBe('en');
    // 显示模式也归这一页管：不写进去的话，下拉看着改了、其实下次打开还是旧值。
    expect(stored.displayMode).toBe('bilingual');
  });

  /**
   * 任务书要求：保存时（用户手势里）用 BaseURL 的 origin 申请可选宿主权限。
   * manifest 里只声明 `optional_host_permissions` 是不够的——不申请就永远没授权，
   * 发往用户自己端点的 fetch 会被浏览器拦下，而且错误会伪装成 NETWORK。
   */
  it('保存自定义引擎时按 origin 申请宿主权限', async () => {
    await seedSettings({ engineId: 'openai-compat', engineConfig: { baseUrl: CUSTOM_BASE_URL, apiKey: 'sk-x' } });
    const page = await loadOptions();

    page.save.click();
    await waitFor(() => page.engineStatus.dataset.kind !== undefined);

    expect(chromeStub.permissions.requests).toEqual([[CUSTOM_ORIGIN_PATTERN]]);
    expect([...chromeStub.permissions.grantedOrigins]).toEqual([CUSTOM_ORIGIN_PATTERN]);
    expect(page.engineStatus.dataset.kind).toBe('ok');
    expect(page.engineStatus.textContent).toContain('已保存');
    expect(page.engineStatus.textContent).toContain(CUSTOM_ORIGIN_PATTERN);
  });

  it('已经授权过就不再弹授权框', async () => {
    await seedSettings({ engineId: 'openai-compat', engineConfig: { baseUrl: CUSTOM_BASE_URL, apiKey: 'sk-x' } });
    chromeStub.permissions.grantedOrigins.add(CUSTOM_ORIGIN_PATTERN);
    const page = await loadOptions();

    page.save.click();
    await waitFor(() => page.engineStatus.dataset.kind !== undefined);

    expect(chromeStub.permissions.requests).toEqual([]);
    expect(page.engineStatus.dataset.kind).toBe('ok');
  });

  it('用户拒绝授权时如实提示会被浏览器拦下，但 Key 与地址照常保存', async () => {
    await seedSettings();
    chromeStub.permissions.approveRequests = false;
    const page = await loadOptions();

    page.engine.value = 'openai-compat';
    page.engine.dispatchEvent(new Event('change'));
    page.baseUrl.value = CUSTOM_BASE_URL;
    page.apiKey.value = 'sk-typed';

    page.save.click();
    await waitFor(() => page.engineStatus.dataset.kind !== undefined);

    expect(page.engineStatus.dataset.kind).toBe('err');
    expect(page.engineStatus.textContent).toContain('未授权访问该地址，翻译请求会被浏览器拦下');
    // 用户可能只是暂时不想授权：凭据照常落盘，不能因为没授权就丢掉他填的东西。
    const stored = await storedSettings();
    expect((stored.engineConfig as Record<string, unknown>).apiKey).toBe('sk-typed');
    expect((stored.engineConfig as Record<string, unknown>).baseUrl).toBe(CUSTOM_BASE_URL);
  });

  it('免费引擎保存时不申请任何宿主权限', async () => {
    await seedSettings({ engineId: 'google' });
    const page = await loadOptions();

    page.save.click();
    await waitFor(() => page.engineStatus.dataset.kind !== undefined);

    expect(chromeStub.permissions.requests).toEqual([]);
    expect(page.engineStatus.dataset.kind).toBe('ok');
  });

  it('接口地址不是合法 URL 时明确报错：不保存、不申请权限', async () => {
    await seedSettings({ engineId: 'openai-compat', engineConfig: { apiKey: 'sk-old', baseUrl: CUSTOM_BASE_URL } });
    const page = await loadOptions();

    page.baseUrl.value = 'api.example.com/v1';
    page.save.click();
    await waitFor(() => page.engineStatus.dataset.kind !== undefined);

    expect(page.engineStatus.dataset.kind).toBe('err');
    expect(page.engineStatus.textContent).toContain('不是合法的 URL');
    expect(chromeStub.permissions.requests).toEqual([]);
    // 存储里还是上一次的合法地址：坏值不该被写进去。
    expect((await storedSettings()).engineConfig).toMatchObject({ baseUrl: CUSTOM_BASE_URL, apiKey: 'sk-old' });
  });

  it('非本机的 http 地址按同一套判据被拒绝', async () => {
    await seedSettings({ engineId: 'openai-compat', engineConfig: { baseUrl: CUSTOM_BASE_URL } });
    const page = await loadOptions();

    page.baseUrl.value = 'http://api.example.com/v1';
    page.save.click();
    await waitFor(() => page.engineStatus.dataset.kind !== undefined);

    expect(page.engineStatus.dataset.kind).toBe('err');
    expect(page.engineStatus.textContent).toContain('必须用 https://');
    expect(chromeStub.permissions.requests).toEqual([]);
  });

  it('本机回环地址允许 http（Ollama 这类本地服务就是这样）', async () => {
    await seedSettings({ engineId: 'openai-compat' });
    const page = await loadOptions();

    page.baseUrl.value = 'http://localhost:11434/v1';
    page.save.click();
    await waitFor(() => page.engineStatus.dataset.kind !== undefined);

    expect(page.engineStatus.dataset.kind).toBe('ok');
    expect(chromeStub.permissions.requests).toEqual([['http://localhost:11434/*']]);
    expect((await storedSettings()).engineConfig).toMatchObject({ baseUrl: 'http://localhost:11434/v1' });
  });

  /**
   * `saveSettings` 是整份覆盖，而弹窗也能改目标语言与引擎。设置页若拿"打开页面时那份快照"
   * 整份回写，会把用户在弹窗里的改动静默抹掉——这是 `shared/settings.ts` 注释里点名的坑。
   */
  it('保存只覆盖本页管的字段：弹窗在期间改过的其它字段不会被旧快照抹掉', async () => {
    await seedSettings({ concurrency: 3 });
    const page = await loadOptions();

    // 页面已经打开，用户在弹窗里改了并发数（本页没有这个控件）。
    const current = await storedSettings();
    await chromeStub.storage.local.set({ [SETTINGS_KEY]: { ...current, concurrency: 7 } });

    page.targetLang.value = 'ja';
    page.save.click();
    await waitFor(() => page.engineStatus.dataset.kind !== undefined);

    const stored = await storedSettings();
    expect(stored.targetLang).toBe('ja');
    expect(stored.concurrency).toBe(7);
  });

  it('存储里的设置版本高于本代码时如实报错，不静默失败', async () => {
    await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: CURRENT_VERSION + 1 } });
    const page = await loadOptions();

    // 初始化那一步就该失败（loadSettings 拒读），而不是让页面停在半初始化状态。
    expect(page.engineStatus.dataset.kind).toBe('err');
    expect(page.engineStatus.textContent).toContain('设置读取失败');

    page.save.click();
    await waitFor(() => page.engineStatus.dataset.kind === 'err');
    expect(page.engineStatus.textContent).toContain('设置还没读出来');
  });
});

describe('设置页：测试连接', () => {
  it('走真实引擎代码发一次极短请求，成功时给出绿色提示与返回的译文', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好'));
    vi.stubGlobal('fetch', fetchMock);
    await seedSettings({
      engineId: 'openai-compat',
      engineConfig: { apiKey: 'sk-x', baseUrl: CUSTOM_BASE_URL, model: 'gpt-4o-mini' },
      targetLang: 'zh-Hans',
    });
    const page = await loadOptions();

    page.test.click();
    await waitFor(() => page.engineStatus.dataset.kind === 'ok' || page.engineStatus.dataset.kind === 'err');

    expect(page.engineStatus.dataset.kind).toBe('ok');
    expect(page.engineStatus.textContent).toContain('连接成功');
    // 返回的译文本身要显示出来——这是"真的通了"的唯一证据。
    expect(page.engineStatus.textContent).toContain('你好');

    // 发的就是生产引擎那条路：同一个端点、同一个请求体形状、极短的一条文本。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CUSTOM_BASE_URL}/chat/completions`);
    const body = JSON.parse(String(init.body)) as { model: string; messages: Array<{ content: string }> };
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages[1].content).toContain('hello');
    expect(body.messages[0].content).toContain('zh-Hans');
  });

  it('测试连接用的是**表单当前**的值，不是存储里的旧值', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好'));
    vi.stubGlobal('fetch', fetchMock);
    await seedSettings({
      engineId: 'openai-compat',
      engineConfig: { apiKey: 'sk-stored', baseUrl: CUSTOM_BASE_URL, model: 'old-model' },
    });
    const page = await loadOptions();

    page.model.value = 'new-model';
    page.test.click();
    await waitFor(() => fetchMock.mock.calls.length > 0);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((JSON.parse(String(init.body)) as { model: string }).model).toBe('new-model');
  });

  it('端点未授权时先申请；用户拒绝则给出红色提示且一个请求都不发', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    chromeStub.permissions.approveRequests = false;
    await seedSettings({ engineId: 'openai-compat', engineConfig: { apiKey: 'sk-x', baseUrl: CUSTOM_BASE_URL } });
    const page = await loadOptions();

    page.test.click();
    await waitFor(() => page.engineStatus.dataset.kind === 'err');

    expect(chromeStub.permissions.requests).toEqual([[CUSTOM_ORIGIN_PATTERN]]);
    expect(page.engineStatus.textContent).toContain('未授权访问该地址');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('失败时显示红色提示与具体错误码 / 文案', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'bad key' }, 401)));
    await seedSettings({ engineId: 'openai-compat', engineConfig: { apiKey: 'sk-bad', baseUrl: CUSTOM_BASE_URL } });
    const page = await loadOptions();

    page.test.click();
    await waitFor(() => page.engineStatus.dataset.kind === 'err');

    expect(page.engineStatus.textContent).toContain('连接失败');
    // 错误码是用户判断"该改 Key 还是该稍后重试"的唯一依据。
    expect(page.engineStatus.textContent).toContain('AUTH');
    expect(page.engineStatus.textContent).toContain('API Key 无效或权限不足');
  });

  it('免费引擎那条路也能测通（换引擎不需要另写一套请求逻辑）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(googleResponse('hello'));
    vi.stubGlobal('fetch', fetchMock);
    await seedSettings({ engineId: 'google' });
    const page = await loadOptions();

    page.test.click();
    await waitFor(() => page.engineStatus.dataset.kind === 'ok' || page.engineStatus.dataset.kind === 'err');

    expect(page.engineStatus.dataset.kind).toBe('ok');
    expect(page.engineStatus.textContent).toContain('【hello】');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('translate.googleapis.com');
    expect(url).toContain('q=hello');
    // 免费引擎不需要任何宿主权限申请。
    expect(chromeStub.permissions.requests).toEqual([]);
  });
});

describe('设置页：清除翻译缓存', () => {
  it('删掉全部 jt: 前缀的键并报出清掉的条数', async () => {
    await seedSettings({ targetLang: 'ja' });
    await chromeStub.storage.local.set({
      'jt:aaa': { v: '译文一', t: 1 },
      'jt:bbb': { v: '译文二', t: 2 },
      'jt:meta': { n: 2 },
      'other:key': 'keep-me',
    });
    // session 里的缓存不属于本按钮的职责（它随浏览器会话消失），这里顺手钉住不动它。
    await chromeStub.storage.session.set({ 'jt:session': { v: '会话层', t: 3 } });

    const page = await loadOptions();
    page.clearCache.click();
    await waitFor(() => page.cacheStatus.dataset.kind !== undefined);

    expect(page.cacheStatus.dataset.kind).toBe('ok');
    expect(page.cacheStatus.textContent).toContain('已清除 2 条翻译缓存');

    const left = await chromeStub.storage.local.keys();
    expect(left.filter((key) => key.startsWith('jt:'))).toEqual([]);
    // 非缓存键一律不动。
    expect(left).toContain('other:key');
    expect(left).toContain(SETTINGS_KEY);
    expect(await chromeStub.storage.session.keys()).toEqual(['jt:session']);
  });

  it('缓存本来就是空的时候如实说明，而不是报「已清除 0 条」', async () => {
    await seedSettings();
    const page = await loadOptions();

    page.clearCache.click();
    await waitFor(() => page.cacheStatus.dataset.kind !== undefined);

    expect(page.cacheStatus.dataset.kind).toBe('ok');
    expect(page.cacheStatus.textContent).toContain('缓存本来就是空的');
  });
});
