/**
 * @vitest-environment jsdom
 *
 * 设置页（服务商档案版）的行为测试。
 *
 * 被测的 `src/options/options.ts` 在 **import 时**就跑 `init()`：模块顶层按 id 取 DOM 元素
 * （所以 DOM 必须先就位），`init()` 同步挂好事件委托，然后才 `await loadSettings()`。于是
 * 每个用例的顺序固定为：装替身 → 写存储 → 装 DOM → `import` → 等初始化那串 await 跑完。
 * `vi.resetModules()` 保证每个用例拿到一份新的模块实例（页面里持有 `settings` 快照）。
 *
 * DOM 用 `src/options/options.html` 的**真实内容**（`DOMParser` 解析后取 body），不手抄一份
 * 结构。档案行是动态渲染的：用例一律按 `data-profile-id` 找行、按 class 找编辑控件、
 * 按 `data-action` 点按钮——与实现共用的是**契约**（这些属性名），不是查询细节。
 *
 * v3 的档案列表带来两类新断言（任务书点名）：
 * - 增删改**直读存储**确认（不是只看内存副本）；
 * - **隐私**：编辑框的 Key 永远从空开始，任何档案的任何密钥都不许出现在 DOM 里。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANGUAGES } from '../../src/core/lang';
import { DEFAULT_ENGINE_ID, getEngine } from '../../src/engines/registry';
import { CURRENT_VERSION, DISPLAY_MODES, PROVIDER_PRESETS, SETTINGS_KEY } from '../../src/shared/settings';
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

/** 档案的种子形状；用例只覆盖自己在意的那几个字段。 */
function profileSeed(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'p-a', label: '我的 DeepSeek', baseUrl: CUSTOM_BASE_URL, model: 'deepseek-chat', apiKey: 'sk-a', ...over };
}

function pick<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`options.html 里没有 #${id}`);
  return found as T;
}

/** 全部档案行（含"新增"草稿行），按渲染顺序。 */
function profileRows(): HTMLElement[] {
  return Array.from(pick<HTMLElement>('profiles').querySelectorAll<HTMLElement>('.profile-row[data-profile-id]'));
}

function rowOf(id: string): HTMLElement {
  const row = profileRows().find((candidate) => candidate.dataset.profileId === id);
  if (row === undefined) throw new Error(`档案行不存在：${id}`);
  return row;
}

function editorOf(id: string): Element {
  const editor = rowOf(id).querySelector('.profile-editor');
  if (editor === null) throw new Error(`档案 ${id} 没有展开编辑区`);
  return editor;
}

function fieldOf(editor: Element, selector: string): HTMLInputElement {
  const input = editor.querySelector<HTMLInputElement>(selector);
  if (input === null) throw new Error(`编辑区缺控件 ${selector}`);
  return input;
}

function actionButton(editor: Element, action: string): HTMLButtonElement {
  const button = editor.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  if (button === null) throw new Error(`编辑区缺按钮 ${action}`);
  return button;
}

/** 展开某个档案的编辑区（点它自己那一行的摘要按钮；已经展开就原样返回，点了不重复收起）。 */
function expand(id: string): Element {
  const row = rowOf(id);
  const existing = row.querySelector('.profile-editor');
  if (existing !== null) return existing;
  row.querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
  return editorOf(id);
}

/** jsdom 的 `new Event(...)` 默认不冒泡；档案区的监听是事件委托，必须带 bubbles。 */
function bubble(type: string): Event {
  return new Event(type, { bubbles: true });
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

async function storedProfiles(): Promise<Array<Record<string, unknown>>> {
  return ((await storedSettings()).profiles ?? []) as Array<Record<string, unknown>>;
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
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('waitFor 超时：条件始终不成立');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 装 DOM、import 设置页模块，并等 `init()` 那串 await（loadSettings → 渲染档案）跑完。 */
async function loadOptions(): Promise<void> {
  mountOptionsHtml();
  await import('../../src/options/options');
  await settle();
}

function engineStatus(): HTMLElement {
  return pick<HTMLElement>('engine-status');
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

beforeEach(() => {
  document.body.innerHTML = '';
  vi.resetModules();
  chromeStub = installChromeStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('设置页：初始化与列表渲染', () => {
  it('每个档案一行：名字 + 接口地址 + 模型名；当前在用的那行有「使用中」', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [
        profileSeed(),
        profileSeed({ id: 'p-b', label: 'Ollama 本机', baseUrl: 'http://localhost:11434/v1', model: 'llama3' }),
      ],
    });
    await loadOptions();

    const rows = profileRows();
    expect(rows).toHaveLength(2);
    const [first, second] = rows as [HTMLElement, HTMLElement];
    expect(first.textContent).toContain('我的 DeepSeek');
    expect(first.textContent).toContain(CUSTOM_BASE_URL);
    expect(first.textContent).toContain('deepseek-chat');
    expect(first.textContent).toContain('使用中');
    expect(second.textContent).toContain('Ollama 本机');
    expect(second.textContent).not.toContain('使用中');
  });

  it('隐私：三个档案各塞不同密钥——收起与展开后，DOM 里一个都不许出现；Key 输入框永远从空开始', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [
        profileSeed({ apiKey: 'sk-alpha' }),
        profileSeed({ id: 'p-b', label: '硅基流动', apiKey: 'sk-beta' }),
        profileSeed({ id: 'p-c', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-gamma' }),
      ],
    });
    await loadOptions();

    const secrets = ['sk-alpha', 'sk-beta', 'sk-gamma'];
    for (const secret of secrets) {
      expect(document.body.textContent).not.toContain(secret);
      expect(document.documentElement.outerHTML).not.toContain(secret);
    }

    // 列表渲染天然比单字段容易把值带出去：每个档案都展开一次再各断一遍。
    for (const id of ['p-a', 'p-b', 'p-c']) {
      const editor = expand(id);
      // 名字/地址/模型回填（它们不是凭据）……
      expect(fieldOf(editor, '.profile-label').value).not.toBe('');
      // ……Key 输入框必须是空的：不回填存储里的那份。
      expect(fieldOf(editor, '.profile-api-key').value).toBe('');
      for (const secret of secrets) {
        expect(document.body.textContent).not.toContain(secret);
        expect(document.documentElement.outerHTML).not.toContain(secret);
      }
    }
  });

  it('API Key 输入框默认 password，行内显示 / 隐藏只动 type 不动值', async () => {
    await seedSettings({ profiles: [profileSeed({ apiKey: 'sk-secret' })], engineId: 'p-a' });
    await loadOptions();

    const editor = expand('p-a');
    const key = fieldOf(editor, '.profile-api-key');
    const toggle = editor.querySelector<HTMLButtonElement>('.profile-toggle-key') as HTMLButtonElement;

    // 默认必须遮住：设置页可能被投屏或截图。
    expect(key.type).toBe('password');
    expect(toggle.textContent).toBe('显示');

    key.value = 'sk-typed';
    toggle.click();
    expect(key.type).toBe('text');
    expect(toggle.textContent).toBe('隐藏');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(key.value).toBe('sk-typed');

    toggle.click();
    expect(key.type).toBe('password');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(key.value).toBe('sk-typed');
  });

  it('展开已存在的档案不重放服务商模板：表单回填的是存过的地址与模型名', async () => {
    // 名字里带「DeepSeek」、地址却是指向自建代理的档案。模板只该挂在下拉的 change 上：
    // 谁要是把 applyProviderTemplate() 挪进展开/渲染路径，用户手改的地址与模型名就会被
    // 悄悄覆盖回模板值——这里钉住"展开看到的就是存过的"。
    await seedSettings({
      engineId: 'p-a',
      profiles: [
        profileSeed({ label: '我的 DeepSeek', baseUrl: 'https://my-proxy.example/v1', model: 'deepseek-chat-selfhost' }),
      ],
    });
    await loadOptions();

    const editor = expand('p-a');
    expect(fieldOf(editor, '.profile-base-url').value).toBe('https://my-proxy.example/v1');
    expect(fieldOf(editor, '.profile-model-name').value).toBe('deepseek-chat-selfhost');
    // 展开不是"选模板"：下拉必须停在 custom，不许被按名字匹配翻成 deepseek。
    const provider = editor.querySelector('.profile-provider') as HTMLSelectElement;
    expect(provider.value).toBe('custom');
  });

  it('v2 老数据打开设置页就能用：engineConfig 已折成一行档案（id 是迁移的 legacy）', async () => {
    await chromeStub.storage.local.set({
      [SETTINGS_KEY]: {
        version: 2,
        engineId: 'openai-compat',
        providerPreset: 'deepseek',
        engineConfig: { apiKey: 'sk-ds', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      },
    });
    await loadOptions();

    const rows = profileRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('DeepSeek');
    expect(rows[0].textContent).toContain('使用中');
    // 打开页面不写存储：迁移发生在**读**的那一刻（loadSettings），存储里仍是原样的 v2。
    expect((await storedSettings()).version).toBe(2);
    expect((await storedSettings()).engineId).toBe('openai-compat');
  });

  it('目标语言与显示模式照旧按存储回填（选项清单不手抄）', async () => {
    await seedSettings({ targetLang: 'ja', displayMode: 'bilingual' });
    await loadOptions();

    const targetLang = pick<HTMLSelectElement>('target-lang');
    const displayMode = pick<HTMLSelectElement>('display-mode');
    expect(Array.from(targetLang.options).map((option) => option.value)).toEqual(
      LANGUAGES.map((lang) => lang.code),
    );
    expect(targetLang.value).toBe('ja');
    expect(Array.from(displayMode.options).map((option) => [option.value, option.textContent])).toEqual(
      DISPLAY_MODES.map((mode) => [mode.value, mode.label]),
    );
    expect(displayMode.value).toBe('bilingual');
    // §6 文案修正：旧文案说"段落里的链接点不了"，那**早就不成立**了——链接保留下划线、
    // 颜色与可点击是已经实现的行为（README「渲染」一节写的就是这个）。这里的断言因此改成
    // 钉住**如实**的说法，而不是删掉一条断言。五条断言各自承重（**同一条用例内，vitest
    // 只报第一条失败的那条**，所以改动时别以为"只红一条"就等于其余四条没事）：
    //   ① 整段几乎就是一个链接时（单链接 + 占比 ≥0.6），译文里的链接仍可点击；
    //   ② 多链接段落与链接文字不足六成的段落里，链接仍可能失去下划线与可点击（仍存在的限制）；
    //   ③ 链接地址不合规（协议白名单之外）时也会降级为纯文本——第三种失败形态；
    //   ④ 反向钉住：那句不成立的旧说法不许回来；
    //   ⑤ 结尾那句「改完点下面的『保存语言与显示』」此刻还是真的（按钮在），故意保留。
    const hint = pick<HTMLElement>('target-hint').textContent ?? '';
    expect(hint).toContain('链接仍可点击');
    expect(hint).toContain('仍可能失去下划线与可点击');
    // ③ 第三种失败形态：链接地址不合规（`tel:` / `javascript:` / `//host/x` 这类）时，
    //    即便"单链接 + 占比 100%"也照样整段降级为纯文本（`renderer.ts:342` 的白名单闸）。
    //    没有这条断言，文案漏掉整条失败路径也不会有任何用例变红。
    expect(hint).toContain('降级为纯文本');
    expect(hint).not.toContain('链接点不了');
    // ⑤ 结尾那句「改完点下面的『保存语言与显示』」本任务**故意保留**：此刻那个按钮还在
    //    （`#save` 到 Task 3 才随即时保存一起删掉），这句话在这个提交上是**真的**，
    //    现在删它反而会让文案与界面不符。它的收尾写在 Task 3 Step 13：那里删按钮，
    //    并把这条断言改成 `not.toContain('保存语言与显示')`——一句话只在一个地方改。
    expect(hint).toContain('保存语言与显示');
  });

  it('隐私说明写明：密钥只存本机、Key 输入框永远从空开始、除翻译请求外不发网络请求', async () => {
    await loadOptions();
    const text = document.body.textContent ?? '';
    expect(text).toContain('API Key 只存在本机');
    expect(text).toContain('不上传、不同步');
    expect(text).toContain('永远从空开始');
    expect(text).toContain('除翻译请求本身外，不发起任何网络请求');
    expect(text).toContain('contenteditable');
  });

  it('存储版本高于本代码：初始化如实报错；所有写入口在设置读出来之前都不放行', async () => {
    await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: CURRENT_VERSION + 1 } });
    await loadOptions();

    expect(engineStatus().dataset.kind).toBe('err');
    expect(engineStatus().textContent).toContain('设置读取失败');

    pick<HTMLButtonElement>('add-profile').click();
    expect(engineStatus().textContent).toContain('设置还没读出来');

    pick<HTMLButtonElement>('save').click();
    await waitFor(() => (engineStatus().textContent ?? '').includes('设置还没读出来'));
    expect(engineStatus().textContent).toContain('设置还没读出来');
  });
});

describe('设置页：档案增删改（全部直读存储验证）', () => {
  it('新增档案：落盘的字段一字不差，id 稳定且不拿 label 当 id；不偷改 engineId', async () => {
    await seedSettings({ engineId: 'google' });
    await loadOptions();

    pick<HTMLButtonElement>('add-profile').click();
    const editor = editorOf('__new__');
    expect(rowOf('__new__').textContent).toContain('新档案（未保存）');
    fieldOf(editor, '.profile-label').value = '我的接口';
    fieldOf(editor, '.profile-base-url').value = CUSTOM_BASE_URL;
    fieldOf(editor, '.profile-model-name').value = 'gpt-4o';
    fieldOf(editor, '.profile-api-key').value = 'sk-typed';
    actionButton(editor, 'save-profile').click();

    await waitFor(async () => (await storedProfiles()).length === 1);
    const [saved] = await storedProfiles();
    expect(saved).toEqual({
      id: expect.any(String),
      label: '我的接口',
      baseUrl: CUSTOM_BASE_URL,
      model: 'gpt-4o',
      apiKey: 'sk-typed',
    });
    expect(typeof saved.id).toBe('string');
    expect((saved.id as string).trim().length).toBeGreaterThan(0);
    // id 不是 label（label 随便改，引用不能跟着漂）。
    expect(saved.id).not.toBe('我的接口');
    // 保存档案不碰选择：engineId 仍是 google，提示区如实指路弹窗。
    expect((await storedSettings()).engineId).toBe('google');
    expect(engineStatus().dataset.kind).toBe('ok');
    expect(engineStatus().textContent).toContain('弹窗');
  });

  it('从服务商模板创建：选 DeepSeek 即预填地址与模型名；手改后按自定义算；不碰 Key', async () => {
    await seedSettings();
    await loadOptions();

    pick<HTMLButtonElement>('add-profile').click();
    const editor = editorOf('__new__');
    const provider = editor.querySelector<HTMLSelectElement>('.profile-provider') as HTMLSelectElement;
    // 模板下拉与 PROVIDER_PRESETS 同源，默认 custom。
    expect(Array.from(provider.options).map((option) => [option.value, option.textContent])).toEqual(
      PROVIDER_PRESETS.map((preset) => [preset.id, preset.label]),
    );
    expect(provider.value).toBe('custom');

    provider.value = 'deepseek';
    provider.dispatchEvent(bubble('change'));
    expect(fieldOf(editor, '.profile-base-url').value).toBe('https://api.deepseek.com/v1');
    expect(fieldOf(editor, '.profile-model-name').value).toBe('deepseek-chat');
    // 预设不越界：API Key 一个字符都不碰（那是用户自己的凭据）。
    expect(fieldOf(editor, '.profile-api-key').value).toBe('');

    // 用户手改模型名 → 下拉翻回 custom（别留着个说谎的「DeepSeek」），改动不会被预设覆盖。
    fieldOf(editor, '.profile-model-name').value = 'deepseek-chat-v2';
    fieldOf(editor, '.profile-model-name').dispatchEvent(bubble('input'));
    expect(provider.value).toBe('custom');
    expect(fieldOf(editor, '.profile-model-name').value).toBe('deepseek-chat-v2');

    fieldOf(editor, '.profile-label').value = 'DeepSeek 备用';
    fieldOf(editor, '.profile-api-key').value = 'sk-ds';
    actionButton(editor, 'save-profile').click();
    await waitFor(async () => (await storedProfiles()).length === 1);
    expect((await storedProfiles())[0]).toMatchObject({
      label: 'DeepSeek 备用',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat-v2',
      apiKey: 'sk-ds',
    });
  });

  it('编辑既有档案：Key 留空保存 = 保留存储里的原 Key；填了才替换；其余字段照常更新', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed({ apiKey: 'sk-old' })] });
    await loadOptions();

    // 第一轮：只改名字与模型，Key 输入框留空。
    let editor = expand('p-a');
    expect(fieldOf(editor, '.profile-label').value).toBe('我的 DeepSeek');
    fieldOf(editor, '.profile-label').value = '改名了';
    fieldOf(editor, '.profile-model-name').value = 'deepseek-reasoner';
    actionButton(editor, 'save-profile').click();
    await waitFor(async () => ((await storedProfiles())[0]?.label === '改名了'));
    let [stored] = await storedProfiles();
    expect(stored.model).toBe('deepseek-reasoner');
    // 核心隐私语义：留空不是"清空"，是"不动"——存储里必须还是原 Key。
    expect(stored.apiKey).toBe('sk-old');

    // 第二轮：明确填了新 Key 才会替换。
    editor = expand('p-a');
    fieldOf(editor, '.profile-api-key').value = 'sk-new';
    actionButton(editor, 'save-profile').click();
    await waitFor(async () => ((await storedProfiles())[0]?.apiKey === 'sk-new'));
    stored = (await storedProfiles())[0] as Record<string, unknown>;
    expect(stored.apiKey).toBe('sk-new');
    expect(stored.label).toBe('改名了');
  });

  it('地址非法：明确报错、不保存、不申请权限；坏值不会进存储', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed({ apiKey: 'sk-old', baseUrl: CUSTOM_BASE_URL })] });
    await loadOptions();

    let editor = expand('p-a');
    fieldOf(editor, '.profile-base-url').value = 'api.example.com/v1';
    actionButton(editor, 'save-profile').click();
    await waitFor(() => engineStatus().dataset.kind === 'err');
    expect(engineStatus().textContent).toContain('不是合法的 URL');
    expect(chromeStub.permissions.requests).toEqual([]);
    // 存储里还是上一次的合法地址：坏值不该被写进去，Key 也不该被动。
    let [stored] = await storedProfiles();
    expect(stored.baseUrl).toBe(CUSTOM_BASE_URL);
    expect(stored.apiKey).toBe('sk-old');

    editor = expand('p-a');
    fieldOf(editor, '.profile-base-url').value = 'http://api.example.com/v1';
    actionButton(editor, 'save-profile').click();
    await waitFor(() => (engineStatus().textContent ?? '').includes('必须用 https://'));
    expect(engineStatus().textContent).toContain('必须用 https://');
    expect(chromeStub.permissions.requests).toEqual([]);

    editor = expand('p-a');
    fieldOf(editor, '.profile-label').value = '   ';
    actionButton(editor, 'save-profile').click();
    await waitFor(() => (engineStatus().textContent ?? '').includes('请填写档案名字'));
  });

  it('本机回环 http 在设置页可保存（Ollama），非回环的 http 仍被当场拒绝——正反成对', async () => {
    await seedSettings({ engineId: 'google' });
    await loadOptions();
    pick<HTMLButtonElement>('add-profile').click();
    const editor = editorOf('__new__');

    // 反面先行：公网 http:// 必须当场被拒。没有这半边，"一律放行 http"的实现也能让正面通过。
    fieldOf(editor, '.profile-label').value = '坏地址';
    fieldOf(editor, '.profile-base-url').value = 'http://example.com/v1';
    fieldOf(editor, '.profile-model-name').value = 'm';
    actionButton(editor, 'save-profile').click();
    await waitFor(() => engineStatus().dataset.kind === 'err');
    expect(engineStatus().textContent).toContain('必须用 https://');
    expect(await storedProfiles()).toEqual([]);
    expect(chromeStub.permissions.requests).toEqual([]);

    // 正面半边：判据允许本机回环走 http（Ollama 就是 http://localhost:11434/v1）。
    // UI 层哪天误拒它，用户就没法在本机配模型——这里钉住"存得下去、落盘原样、不报错"。
    fieldOf(editor, '.profile-label').value = 'Ollama 本机';
    fieldOf(editor, '.profile-base-url').value = 'http://localhost:11434/v1';
    fieldOf(editor, '.profile-model-name').value = 'qwen2.5';
    actionButton(editor, 'save-profile').click();
    await waitFor(() => engineStatus().dataset.kind === 'ok');
    expect(engineStatus().textContent).not.toContain('必须用 https://');
    const [stored] = await storedProfiles();
    expect(stored.baseUrl).toBe('http://localhost:11434/v1');
    expect(stored.model).toBe('qwen2.5');
    // 授权也按回环 origin 申请，恰好一次。
    expect(chromeStub.permissions.requests).toEqual([['http://localhost:11434/*']]);
  });

  it('保存档案按**该档案自己的 origin** 申请宿主权限；已授权过就不再弹框', async () => {
    await seedSettings();
    await loadOptions();

    pick<HTMLButtonElement>('add-profile').click();
    let editor = editorOf('__new__');
    fieldOf(editor, '.profile-label').value = '例子';
    fieldOf(editor, '.profile-base-url').value = CUSTOM_BASE_URL;
    fieldOf(editor, '.profile-model-name').value = 'm';
    fieldOf(editor, '.profile-api-key').value = 'sk-x';
    actionButton(editor, 'save-profile').click();
    await waitFor(() => engineStatus().dataset.kind === 'ok');
    expect(chromeStub.permissions.requests).toEqual([[CUSTOM_ORIGIN_PATTERN]]);
    expect([...chromeStub.permissions.grantedOrigins]).toEqual([CUSTOM_ORIGIN_PATTERN]);
    expect(engineStatus().textContent).toContain('已授权访问');
    expect(engineStatus().textContent).toContain(CUSTOM_ORIGIN_PATTERN);

    // 再保存同一个档案：已经 contains 过，不再弹框。
    editor = expand((await storedProfiles())[0].id as string);
    actionButton(editor, 'save-profile').click();
    await waitFor(() => (engineStatus().textContent ?? '').includes('已保存档案'));
    expect(chromeStub.permissions.requests).toEqual([[CUSTOM_ORIGIN_PATTERN]]);
  });

  it('两个档案在列且 engineId 指向第一个：保存 p-b 只申请 b2 的 origin，一次都不碰 a1', async () => {
    // profiles[0] 与正在编辑的那一行**故意不是同一个**——否则"永远申请 profiles[0] 的
    // 地址（带兜底）"这类实现能蒙混过关：用户存档案 B，授权却落在档案 A 头上，
    // A 莫名多了权限、B 仍没授权，切到 B 翻译被浏览器拦下且错误伪装成网络问题。
    await seedSettings({
      engineId: 'p-a',
      profiles: [
        profileSeed({ id: 'p-a', label: '档案A', baseUrl: 'https://a1.example/v1', model: 'model-a', apiKey: 'sk-a' }),
        profileSeed({ id: 'p-b', label: '档案B', baseUrl: 'https://b2.example/v1', model: 'model-b', apiKey: 'sk-b' }),
      ],
    });
    await loadOptions();

    const editor = expand('p-b');
    fieldOf(editor, '.profile-model-name').value = 'model-b-edited';
    actionButton(editor, 'save-profile').click();
    await waitFor(async () => ((await storedProfiles())[1]?.model === 'model-b-edited'));

    expect(engineStatus().dataset.kind).toBe('ok');
    // 恰好一次、参数是 b2——不是 a1 的 origin，也不是两个都申请。
    expect(chromeStub.permissions.requests).toEqual([['https://b2.example/*']]);
  });

  it('反向配对：保存在用的 p-a 只申请 a1 的 origin（只写上一条挡不住写反的 bug）', async () => {
    // 与上一条同形但编辑的是 profiles[0]。两条合起来才把"申请的对象 = 被编辑档案自己的
    // origin"钉死：任何"固定申请第一个 / 固定申请最后一个 / 两个都申请"的实现都至少红一条。
    await seedSettings({
      engineId: 'p-a',
      profiles: [
        profileSeed({ id: 'p-a', label: '档案A', baseUrl: 'https://a1.example/v1', model: 'model-a', apiKey: 'sk-a' }),
        profileSeed({ id: 'p-b', label: '档案B', baseUrl: 'https://b2.example/v1', model: 'model-b', apiKey: 'sk-b' }),
      ],
    });
    await loadOptions();

    const editor = expand('p-a');
    fieldOf(editor, '.profile-model-name').value = 'model-a-edited';
    actionButton(editor, 'save-profile').click();
    await waitFor(async () => ((await storedProfiles())[0]?.model === 'model-a-edited'));

    expect(engineStatus().dataset.kind).toBe('ok');
    expect(chromeStub.permissions.requests).toEqual([['https://a1.example/*']]);
  });

  it('用户拒绝授权：档案与 Key 照常落盘，并如实说会被浏览器拦下', async () => {
    chromeStub.permissions.approveRequests = false;
    await seedSettings();
    await loadOptions();

    pick<HTMLButtonElement>('add-profile').click();
    const editor = editorOf('__new__');
    fieldOf(editor, '.profile-label').value = '例子';
    fieldOf(editor, '.profile-base-url').value = CUSTOM_BASE_URL;
    fieldOf(editor, '.profile-model-name').value = 'm';
    fieldOf(editor, '.profile-api-key').value = 'sk-typed';
    actionButton(editor, 'save-profile').click();

    await waitFor(async () => (await storedProfiles()).length === 1);
    expect(engineStatus().dataset.kind).toBe('err');
    expect(engineStatus().textContent).toContain('未授权访问该地址，翻译请求会被浏览器拦下');
    // 用户可能只是暂时不想授权：凭据照常落盘，不能因为没授权就丢掉他填的东西。
    const [stored] = await storedProfiles();
    expect(stored.apiKey).toBe('sk-typed');
    expect(stored.baseUrl).toBe(CUSTOM_BASE_URL);
  });

  it('保存档案只覆盖档案列表：期间弹窗改过的其它字段不会被旧快照抹掉', async () => {
    await seedSettings({ concurrency: 3, profiles: [profileSeed()] });
    await loadOptions();

    // 页面已经打开，用户在弹窗里改了并发数（本页没有这个控件）。
    const current = await storedSettings();
    await chromeStub.storage.local.set({ [SETTINGS_KEY]: { ...current, concurrency: 7 } });

    const editor = expand('p-a');
    fieldOf(editor, '.profile-label').value = '改过了';
    actionButton(editor, 'save-profile').click();
    await waitFor(async () => ((await storedProfiles())[0]?.label === '改过了'));
    const stored = await storedSettings();
    expect(stored.concurrency).toBe(7);
  });

  it('删除当前在用的档案：engineId 落到存在的目标（免费引擎）并给出提示，绝不留下悬空引用', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed(), profileSeed({ id: 'p-b', label: '另一家', baseUrl: 'https://b.example/v1' })],
    });
    await loadOptions();

    const editor = expand('p-a');
    actionButton(editor, 'delete-profile').click();

    await waitFor(async () => (await storedProfiles()).length === 1);
    const stored = await storedSettings();
    expect((stored.profiles as Array<Record<string, unknown>>).map((profile) => profile.id)).toEqual(['p-b']);
    // 回落到一个**存在**的目标：免费引擎（下一个档案可能没填 Key / 没授权，不能用它赌）。
    expect(stored.engineId).toBe(DEFAULT_ENGINE_ID);
    expect(engineStatus().dataset.kind).toBe('ok');
    expect(engineStatus().textContent).toContain('已删除当前在用的档案「我的 DeepSeek」');
    expect(engineStatus().textContent).toContain(getEngine(DEFAULT_ENGINE_ID).name);
    expect(engineStatus().textContent).toContain('弹窗');
    // 界面上那行也跟着消失了，「使用中」不再指着幽灵。
    expect(profileRows().map((row) => row.dataset.profileId)).toEqual(['p-b']);
    expect(profileRows()[0].textContent).not.toContain('使用中');
  });

  it('删除没在用的档案：engineId 原样不动', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed(), profileSeed({ id: 'p-b', label: '另一家', baseUrl: 'https://b.example/v1' })],
    });
    await loadOptions();

    const editor = expand('p-b');
    actionButton(editor, 'delete-profile').click();

    await waitFor(async () => (await storedProfiles()).length === 1);
    const stored = await storedSettings();
    expect(stored.engineId).toBe('p-a');
    expect((stored.profiles as Array<Record<string, unknown>>).map((profile) => profile.id)).toEqual(['p-a']);
    expect(engineStatus().textContent).toContain('已删除档案「另一家」');
    // 在用的那行仍然带「使用中」。
    expect(rowOf('p-a').textContent).toContain('使用中');
  });
});

describe('设置页：测试连接（按档案，测的是正在编辑的那一行）', () => {
  it('走真实引擎代码发一次极短请求；用**表单当前**的值，Key 留空时用存储里那份', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好'));
    vi.stubGlobal('fetch', fetchMock);
    chromeStub.permissions.grantedOrigins.add(CUSTOM_ORIGIN_PATTERN);
    await seedSettings({
      profiles: [profileSeed({ apiKey: 'sk-stored', model: 'old-model' })],
      engineId: 'p-a',
      targetLang: 'zh-Hans',
    });
    await loadOptions();

    const editor = expand('p-a');
    fieldOf(editor, '.profile-model-name').value = 'new-model';
    actionButton(editor, 'test-profile').click();
    await waitFor(() => engineStatus().dataset.kind === 'ok');

    expect(engineStatus().textContent).toContain('连接成功');
    // 返回的译文本身要显示出来——这是"真的通了"的唯一证据。
    expect(engineStatus().textContent).toContain('你好');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CUSTOM_BASE_URL}/chat/completions`);
    const body = JSON.parse(String(init.body)) as { model: string; messages: Array<{ role: string; content: string }> };
    // 未保存的模型名改动也要被测到（测的是编辑中的这一行，不是存储里的旧值）。
    expect(body.model).toBe('new-model');
    // Key 输入框留空 → 测存储里的原 Key，而不是拿空 Key 去撞 401。
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-stored');
    expect(body.messages[1].content).toContain('hello');
    expect(body.messages[0].content).toContain('zh-Hans');
  });

  it('测试连接也会先申请该档案的授权；用户拒绝则红色提示且一个请求都不发', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    chromeStub.permissions.approveRequests = false;
    await seedSettings({ profiles: [profileSeed({ apiKey: 'sk-x' })], engineId: 'p-a' });
    await loadOptions();

    const editor = expand('p-a');
    actionButton(editor, 'test-profile').click();
    await waitFor(() => engineStatus().dataset.kind === 'err');

    expect(chromeStub.permissions.requests).toEqual([[CUSTOM_ORIGIN_PATTERN]]);
    expect(engineStatus().textContent).toContain('未授权访问该地址');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('失败时显示红色提示与具体错误码（多档案时代更要看清测的是谁）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'bad key' }, 401)));
    chromeStub.permissions.grantedOrigins.add(CUSTOM_ORIGIN_PATTERN);
    await seedSettings({ profiles: [profileSeed({ apiKey: 'sk-bad', label: '硅基流动' })], engineId: 'p-a' });
    await loadOptions();

    const editor = expand('p-a');
    actionButton(editor, 'test-profile').click();
    await waitFor(() => engineStatus().dataset.kind === 'err');

    expect(engineStatus().textContent).toContain('连接失败');
    // 错误码是用户判断"该改 Key 还是该稍后重试"的唯一依据。
    expect(engineStatus().textContent).toContain('AUTH');
    expect(engineStatus().textContent).toContain('API Key 无效或权限不足');
    // 进行中的提示也要带档案名字：多个档案同开同测时不能只知道"某个档案在测"。
  });
});

describe('设置页：语言与显示（独立于档案的保存）', () => {
  it('「保存语言与显示」只写这两个字段：档案、Key 与 engineId 一律原样', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ apiKey: 'sk-keep' })],
      targetLang: 'zh-Hans',
      displayMode: 'translated-only',
    });
    await loadOptions();

    pick<HTMLSelectElement>('target-lang').value = 'en';
    pick<HTMLSelectElement>('display-mode').value = 'bilingual';
    pick<HTMLButtonElement>('save').click();
    await waitFor(() => engineStatus().dataset.kind === 'ok');

    const stored = await storedSettings();
    expect(stored.targetLang).toBe('en');
    expect(stored.displayMode).toBe('bilingual');
    expect(stored.engineId).toBe('p-a');
    expect((stored.profiles as Array<Record<string, unknown>>)[0].apiKey).toBe('sk-keep');
  });

  it('免费引擎下保存设置：一个宿主权限申请都不发（google 的地址已在 host_permissions 里）', async () => {
    // 档案化之后，"不申请权限"这条断言从保存路径上消失了：没有它，
    // "无条件给当前档案地址申请权限"这类回归不会被任何人发现——免费引擎明明
    // 不需要授权，却每次都弹一个用户看不懂的框。这里钉住：engineId=google 时
    // 保存语言与显示，permissions.request 一次都不许被调用。
    await seedSettings({ engineId: 'google', profiles: [profileSeed()] });
    await loadOptions();

    pick<HTMLSelectElement>('target-lang').value = 'ja';
    pick<HTMLButtonElement>('save').click();
    await waitFor(() => engineStatus().dataset.kind === 'ok');

    expect((await storedSettings()).targetLang).toBe('ja');
    expect(chromeStub.permissions.requests).toEqual([]);
    // 也不许有任何"顺手授予"：一次授权都不该发生。
    expect([...chromeStub.permissions.grantedOrigins]).toEqual([]);
  });

  it('期间弹窗改过的其它字段不会被旧快照抹掉', async () => {
    await seedSettings({ concurrency: 3 });
    await loadOptions();

    const current = await storedSettings();
    await chromeStub.storage.local.set({ [SETTINGS_KEY]: { ...current, concurrency: 7 } });

    pick<HTMLSelectElement>('target-lang').value = 'ja';
    pick<HTMLButtonElement>('save').click();
    await waitFor(() => engineStatus().dataset.kind === 'ok');

    const stored = await storedSettings();
    expect(stored.targetLang).toBe('ja');
    expect(stored.concurrency).toBe(7);
  });
});

describe('设置页：清除翻译缓存', () => {
  /**
   * **行为修正记录**：这条用例原先钉的是「清除只动持久层、不碰 session」——当时是
   * 有意的界面决策，测试忠实记录了它。但 `TieredCache.getMany` 先查会话层：点完"清除"
   * 立刻重译页面照样零请求命中，按钮看起来失灵；报出的条数也系统性少报。按钮的语义
   * （「清除翻译缓存」）覆盖两层，界面承诺 > 旧决策，于是断言从「钉住当时的设计」改成
   * 「钉住修正后的行为」：两层一起清、计数报两层合计。
   */
  it('持久层与会话层一并清掉，计数报两层合计；非缓存键一律不动', async () => {
    await seedSettings({ targetLang: 'ja' });
    await chromeStub.storage.local.set({
      'jt:aaa': { v: '译文一', t: 1 },
      'jt:bbb': { v: '译文二', t: 2 },
      'jt:meta': { n: 2 },
      'other:key': 'keep-me',
    });
    await chromeStub.storage.session.set({
      'jt:session': { v: '会话层', t: 3 },
      'other:session-key': 'keep-me-too',
    });

    await loadOptions();
    pick<HTMLButtonElement>('clear-cache').click();
    await waitFor(() => pick<HTMLElement>('cache-status').dataset.kind !== undefined);

    expect(pick<HTMLElement>('cache-status').dataset.kind).toBe('ok');
    // 持久层 2 条 + 会话层 1 条：少报的那一条正是"清完仍命中缓存"的来源。
    expect(pick<HTMLElement>('cache-status').textContent).toContain('已清除 3 条翻译缓存');

    const left = await chromeStub.storage.local.keys();
    expect(left.filter((key) => key.startsWith('jt:'))).toEqual([]);
    // 非缓存键一律不动（两层都是）。
    expect(left).toContain('other:key');
    expect(left).toContain(SETTINGS_KEY);
    const sessionLeft = await chromeStub.storage.session.keys();
    expect(sessionLeft.filter((key) => key.startsWith('jt:'))).toEqual([]);
    expect(sessionLeft).toEqual(['other:session-key']);
  });

  it('只有会话层有条目时也报数并清掉（重译不再零请求）', async () => {
    await seedSettings();
    await chromeStub.storage.session.set({ 'jt:only-session': { v: '会话层独苗', t: 1 } });

    await loadOptions();
    pick<HTMLButtonElement>('clear-cache').click();
    await waitFor(() => pick<HTMLElement>('cache-status').dataset.kind !== undefined);

    expect(pick<HTMLElement>('cache-status').textContent).toContain('已清除 1 条翻译缓存');
    expect((await chromeStub.storage.session.keys()).filter((key) => key.startsWith('jt:'))).toEqual([]);
  });

  it('缓存本来就是空的时候如实说明，而不是报「已清除 0 条」', async () => {
    await seedSettings();
    await loadOptions();

    pick<HTMLButtonElement>('clear-cache').click();
    await waitFor(() => pick<HTMLElement>('cache-status').dataset.kind !== undefined);

    expect(pick<HTMLElement>('cache-status').dataset.kind).toBe('ok');
    expect(pick<HTMLElement>('cache-status').textContent).toContain('缓存本来就是空的');
  });
});
