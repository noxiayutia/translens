// tests/background/service-worker.test.ts
/**
 * service worker 是整条链路的集成点：消息校验 → 设置 → 引擎 → 调度器 → 两层缓存。
 *
 * 它在 **import 时**就注册监听器（模块级副作用），所以 chrome 替身必须先装好：
 * 本文件在模块体里先 `installChromeStub()`，再用 `beforeAll` 动态 import，静态 import
 * 会把求值顺序反过来（ESM 的静态 import 先于模块体执行）。
 *
 * 引擎走的是真实现 + 假 `fetch`：免费接口一次请求一条文本，假响应把请求里的 `q`
 * 回显成 `【q】`，于是"发了几个请求、请求带什么参数、结果有没有落盘"都能直接断言。
 */
import process from 'node:process';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationCache } from '../../src/core/cache';
import { chromeArea } from '../../src/shared/chrome-area';
import { MSG } from '../../src/shared/messages';
import { CURRENT_VERSION, SETTINGS_KEY } from '../../src/shared/settings';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';

const stub: ChromeStub = installChromeStub();

beforeAll(async () => {
  // 只有副作用，没有导出可拿：监听器注册在替身上。
  const worker = await import('../../src/background/service-worker');
  // 没有这个断言的话，"监听器没注册"只会表现为每个用例各超时 1000ms，看不出根因。
  expect(stub.runtime.onMessage.listeners()).toHaveLength(1);
  // 启动对账会写 `jt:meta`，跨用例漂着就会污染"存储里有什么"这类断言：先等它跑完。
  await worker.cachesInitialized;
});

/** 让已经排队的微任务与 `await` 链全部走完（比数微任务次数稳）。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 写入设置；缺的字段由 `loadSettings` 用默认值补齐。 */
async function useSettings(raw: Record<string, unknown>): Promise<void> {
  await stub.storage.local.set({ [SETTINGS_KEY]: { version: CURRENT_VERSION, ...raw } });
}

/** 免费接口的假响应：把 `q` 参数回显成 `【q】`，同时记下每个请求的 URL。 */
function stubGoogleFetch(): URL[] {
  const calls: URL[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const text = url.searchParams.get('q') ?? '';
    return new Response(JSON.stringify([[[`【${text}】`, text]]]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

/** 存储区里全部缓存条目（`jt:meta` 是计数元数据，不是条目）。 */
function cacheEntries(area: 'local' | 'session'): Array<[string, unknown]> {
  return Object.entries(stub.storage[area].snapshot()).filter(
    ([key]) => key.startsWith('jt:') && key !== 'jt:meta',
  );
}

function translateTexts(payload: unknown): ReturnType<ChromeStub['runtime']['dispatchMessage']> {
  return stub.runtime.dispatchMessage({ type: MSG.TRANSLATE_TEXTS, payload });
}

beforeEach(async () => {
  await stub.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('替身自身', () => {
  it('local 与 session 是两块互不相通的存储', async () => {
    await stub.storage.local.set({ 'probe:key': 'local-value' });
    expect(await stub.storage.session.get(['probe:key'])).toEqual({});
    expect(stub.storage.session.snapshot()).toEqual({});
    expect(stub.storage.local.snapshot()).toEqual({ 'probe:key': 'local-value' });
    expect(await stub.storage.local.keys()).toEqual(['probe:key']);
    expect(await stub.storage.session.keys()).toEqual([]);
  });
});

describe('runtime.onMessage 消息路由', () => {
  it('不是本插件的消息返回 false，不占用消息通道', () => {
    const dispatch = stub.runtime.dispatchMessage({ type: 'other:whatever' });
    expect(dispatch.returns).toEqual([false]);
    expect(dispatch.keepChannelOpen).toBe(false);
    expect(dispatch.responded).toBe(false);
  });

  it('形状不对的翻译消息也返回 false（只有类型没有 items），不占用消息通道', () => {
    const dispatch = stub.runtime.dispatchMessage({ type: MSG.TRANSLATE_TEXTS, payload: {} });
    expect(dispatch.returns).toEqual([false]);
    expect(dispatch.keepChannelOpen).toBe(false);
    expect(dispatch.responded).toBe(false);
  });

  it('合法消息返回 true，异步响应 { ok: true, results } 且结果已写进两层存储', async () => {
    const calls = stubGoogleFetch();

    const dispatch = translateTexts({
      items: [
        { id: 'item-1', text: 'Hello' },
        { id: 'item-2', text: 'World' },
      ],
    });
    expect(dispatch.returns).toEqual([true]);
    expect(dispatch.keepChannelOpen).toBe(true);
    expect(dispatch.responded).toBe(false); // 响应必须是异步的：同步返回就会丢消息

    await expect(dispatch.response()).resolves.toEqual({
      ok: true,
      results: [
        { id: 'item-1', text: '【Hello】' },
        { id: 'item-2', text: '【World】' },
      ],
    });

    expect(calls.map((url) => url.searchParams.get('q'))).toEqual(['Hello', 'World']);

    // 落盘：译文不只在响应里，也在两块存储里各存了一份（session 命中优先，local 跨会话保留）。
    for (const area of ['session', 'local'] as const) {
      const entries = cacheEntries(area);
      expect(entries).toHaveLength(2);
      expect(entries.map(([, value]) => (value as { v: string }).v).sort()).toEqual([
        '【Hello】',
        '【World】',
      ]);
      // 形状是缓存认得的条目，不是随便一个对象。
      expect(await new TranslationCache(chromeArea(chrome.storage[area])).count()).toBe(2);
    }
  });

  it('payload.targetLang 优先于设置里的 targetLang', async () => {
    const calls = stubGoogleFetch();
    await useSettings({ engineId: 'google', targetLang: 'ja' });

    await translateTexts({ items: [{ id: 'item-1', text: 'Hello' }], targetLang: 'en' }).response();
    expect(calls[0].searchParams.get('tl')).toBe('en');

    // 没带就按设置走（同一个 payload 形状，只有这一处差异）。
    await translateTexts({ items: [{ id: 'item-2', text: 'World' }] }).response();
    expect(calls[1].searchParams.get('tl')).toBe('ja');
  });

  /**
   * 与「重试语言走页面快照」互补的另一半分工（见 content/index.test.ts）：
   * **语言由内容脚本带进来（或回落当前设置），凭据永远现读当前设置**。
   * 用户点重试往往正是刚去设置页填好 Key 回来——后台要是拿着旧快照，那次重试
   * 还会用旧凭据失败。这条钉的是"每条消息各读一次设置"，不是缓存掉的长驻配置。
   * v3 形状：凭据住在 `profiles` 里被选中的那一份，`engineId` 是档案 id。
   */
  it('档案配置（含 API Key）逐条消息现读：中途保存新 Key，下一条消息直接用新 Key', async () => {
    const authHeaders: Array<string | null> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      authHeaders.push(new Headers(init?.headers).get('authorization'));
      return new Response(JSON.stringify({ choices: [{ message: { content: '<<<1>>> 译文' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    stub.permissions.grantedOrigins.add('https://api.openai.com/*');
    const configFor = (apiKey: string) => ({
      engineId: 'p-open',
      profiles: [
        { id: 'p-open', label: '我的 OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini'], activeModel: 'gpt-4o-mini', apiKey },
      ],
    });

    await useSettings(configFor('sk-old'));
    await translateTexts({ items: [{ id: 'a', text: 'First text' }], targetLang: 'en' }).response();

    // 用户中途去设置页保存了新 Key。
    await useSettings(configFor('sk-new'));
    await translateTexts({ items: [{ id: 'b', text: 'Second text' }], targetLang: 'en' }).response();

    expect(authHeaders).toEqual(['Bearer sk-old', 'Bearer sk-new']);
  });

  /**
   * 缓存 key 的归属（任务书点名）：`configHash` 只由 **baseUrl + model** 构成——
   * apiKey 不进 key（换 Key 不该让全部缓存失效），档案 id 也不进 key
   * （同地址同模型的两个档案各存一份纯属浪费）。两个档案的 Key 刻意不同：
   * 若实现把 apiKey（或档案 id）混进 key，第二次翻译就会 miss 并多打一次请求。
   */
  it('两个档案同 baseUrl 同 model → 命中同一份缓存；换 model 不串', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body });
      return new Response(JSON.stringify({ choices: [{ message: { content: '<<<1>>> 你好' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    stub.permissions.grantedOrigins.add('https://api.example.com/*');
    const same = (id: string, model: string, apiKey: string) => ({
      id,
      label: id,
      baseUrl: 'https://api.example.com/v1',
      models: [model],
      activeModel: model,
      apiKey,
    });

    await useSettings({ engineId: 'p-a', profiles: [same('p-a', 'm-1', 'sk-a'), same('p-b', 'm-1', 'sk-b'), same('p-c', 'm-2', 'sk-a')] });
    await expect(translateTexts({ items: [{ id: 'i1', text: 'Hello' }] }).response()).resolves.toEqual({
      ok: true,
      results: [{ id: 'i1', text: '你好' }],
    });
    expect(calls).toHaveLength(1);

    // 切到同地址同模型的另一个档案：必须命中同一份缓存，一次请求都不发。
    await useSettings({ engineId: 'p-b', profiles: [same('p-a', 'm-1', 'sk-a'), same('p-b', 'm-1', 'sk-b'), same('p-c', 'm-2', 'sk-a')] });
    await expect(translateTexts({ items: [{ id: 'i2', text: 'Hello' }] }).response()).resolves.toEqual({
      ok: true,
      results: [{ id: 'i2', text: '你好' }],
    });
    expect(calls).toHaveLength(1);
    // 存储里确实只有这一条缓存（两个档案没有各存一份）。
    expect(cacheEntries('local')).toHaveLength(1);
    expect(cacheEntries('session')).toHaveLength(1);

    // 换 model 的档案：缓存不能串过去，得按新模型再请求一次。
    await useSettings({ engineId: 'p-c', profiles: [same('p-a', 'm-1', 'sk-a'), same('p-b', 'm-1', 'sk-b'), same('p-c', 'm-2', 'sk-a')] });
    await expect(translateTexts({ items: [{ id: 'i3', text: 'Hello' }] }).response()).resolves.toEqual({
      ok: true,
      results: [{ id: 'i3', text: '你好' }],
    });
    expect(calls).toHaveLength(2);
    expect((JSON.parse(String(calls[1].body)) as { model: string }).model).toBe('m-2');
  });

  /**
   * 弹窗切到一个**还没授权**的档案（授权只在设置页的用户手势里申请）：翻译时报的必须是
   * 可行动的 AUTH（「到设置页保存一次以授权」），不能伪装成 NETWORK（断网）。
   * 判据在引擎侧（host-permission 的 contains），这里端到端钉住 service worker 转达的形状。
   */
  it('切到未授权的档案：给出可行动的 AUTH 提示而不是网络错误，且一个请求都不发', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // grantedOrigins 保持空：模拟"这个 origin 从没在设置页保存过"。
    await useSettings({
      engineId: 'p-new',
      profiles: [
        { id: 'p-new', label: '新伙伴', baseUrl: 'https://never-granted.example/v1', models: ['m'], activeModel: 'm', apiKey: 'sk-x' },
      ],
    });

    const dispatch = await translateTexts({ items: [{ id: 'item-1', text: 'Hello' }] }).response();
    expect(dispatch).toEqual({
      ok: true,
      results: [
        {
          id: 'item-1',
          text: null,
          code: 'AUTH',
          message: '未授权访问该接口地址，请到设置页保存一次以授权',
        },
      ],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('引擎报错（缺 API Key）时把 AUTH 记在条目上，不抛错也不发请求', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await useSettings({
      engineId: 'p-open',
      profiles: [
        { id: 'p-open', label: '我的 OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini'], activeModel: 'gpt-4o-mini', apiKey: '' },
      ],
    });

    const dispatch = translateTexts({ items: [{ id: 'item-1', text: 'Hello' }] });
    await expect(dispatch.response()).resolves.toEqual({
      ok: true,
      results: [{ id: 'item-1', text: null, code: 'AUTH', message: '尚未填写 API Key，请在设置中配置' }],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('loadSettings 抛错时返回 { ok: false, code, message }', async () => {
    // 存储里的版本号高于本代码：`loadSettings` 拒读，异常在 handleTranslateTexts 里被收成响应。
    // 注意这条走的是**读设置**这条路径；`:108-111` 那个 catch 是兜底，今天没有可达的引擎触发点
    // ——引擎错误是条目级的（见下一条用例），不会从 translateBatch 里抛出来。
    await stub.storage.local.set({ [SETTINGS_KEY]: { version: CURRENT_VERSION + 1 } });

    await expect(translateTexts({ items: [{ id: 'item-1', text: 'Hello' }] }).response()).resolves.toEqual({
      ok: false,
      code: 'UNKNOWN',
      message: `设置版本 ${CURRENT_VERSION + 1} 高于当前支持的 ${CURRENT_VERSION}，请更新扩展`,
    });
  });

  it('端口已关闭（sendResponse 抛错）时静默丢弃，不留下未处理拒绝', async () => {
    stubGoogleFetch(); // 引擎走真实现，给个假响应让批次真的跑完
    stub.runtime.failSendResponse = true;
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    // 只监听、不拦截：vitest 自己的监听器照旧生效（未处理拒绝在真跑里会直接判失败）。
    process.on('unhandledRejection', onRejection);

    try {
      const dispatch = translateTexts({ items: [{ id: 'item-1', text: 'Hello' }] });
      expect(dispatch.keepChannelOpen).toBe(true);
      // 响应是异步的，所以"第一个 sendResponse 抛错"必然发生在下面这个 `await` 之前，
      // 此后整条链都已定局：一个宏任务足够让未处理拒绝冒出来。
      await flush();
    } finally {
      process.off('unhandledRejection', onRejection);
    }

    // 真正会漏的是第二个 sendResponse：`.catch` 里那个调用自己抛出的异常背后没有处理者。
    expect(rejections).toEqual([]);
  });
});

describe('两层缓存的层次顺序', () => {
  /**
   * 接线方向是这一个调用决定的：`new TieredCache(sessionCache, persistentCache)`
   * （`service-worker.ts:69`）。两个参数同型，调换顺序照样编译、照样"两层都写了"，
   * 所以断言必须落在**方向**上：读会话层优先、持久层命中回填会话层。
   */
  it('两层都有同一个 key 时读会话层，持久层里被改坏的旧译文不会顶掉它', async () => {
    const calls = stubGoogleFetch();

    await translateTexts({ items: [{ id: 'item-1', text: 'Hello' }] }).response();
    expect(calls).toHaveLength(1);

    // 同一个 key 在两层里放不同的译文：只有"先读会话层"的实现才拿得到会话层那份。
    const keys = cacheEntries('session').map(([key]) => key);
    expect(keys).toHaveLength(1);
    expect(cacheEntries('local').map(([key]) => key)).toEqual(keys);
    await stub.storage.local.set({ [keys[0]]: { v: '【持久层旧译文】', t: Date.now() } });

    await expect(translateTexts({ items: [{ id: 'item-1', text: 'Hello' }] }).response()).resolves.toEqual({
      ok: true,
      results: [{ id: 'item-1', text: '【Hello】' }],
    });
    expect(calls).toHaveLength(1); // 命中缓存就不再请求引擎
  });

  it('会话层没有时从持久层命中并回填会话层，且不打回引擎', async () => {
    const calls = stubGoogleFetch();

    await translateTexts({ items: [{ id: 'item-1', text: 'Hello' }] }).response();
    expect(calls).toHaveLength(1);

    const [key] = cacheEntries('local').map(([entryKey]) => entryKey);
    await stub.storage.session.remove(key); // 会话结束 / 被淘汰后的现场：只剩持久层
    expect(cacheEntries('session')).toEqual([]);

    await expect(translateTexts({ items: [{ id: 'item-1', text: 'Hello' }] }).response()).resolves.toEqual({
      ok: true,
      results: [{ id: 'item-1', text: '【Hello】' }],
    });
    expect(calls).toHaveLength(1); // 持久层命中，没有再请求引擎

    // 回填是"真的写进了会话层"，而不是只把值返回给调用方：下一次读要走快的那层。
    const session = stub.storage.session.snapshot();
    expect(session[key]).toEqual({ v: '【Hello】', t: expect.any(Number) });
    expect(await new TranslationCache(chromeArea(chrome.storage.session)).count()).toBe(1);
  });
});

describe('快捷键与右键菜单', () => {
  it('安装时先清空再注册两个右键菜单', () => {
    stub.runtime.install();
    expect(stub.contextMenus.removeAllCalls).toBe(1);
    expect(stub.contextMenus.created).toEqual([
      { id: 'jinyi-translate-page', title: '翻译此页', contexts: ['page'] },
      { id: 'jinyi-translate-selection', title: '翻译选中文本', contexts: ['selection'] },
    ]);
  });

  it('toggle-translate 转发给活动标签页，未知命令与无标签页都不发送', async () => {
    stub.commands.run('some-other-command');
    await flush();
    expect(stub.tabs.sent).toEqual([]);

    stub.commands.run('toggle-translate');
    await flush();
    expect(stub.tabs.sent).toEqual([{ tabId: 7, message: { type: MSG.TOGGLE_PAGE } }]);
    // 替身的 `query` 不按条件过滤，所以"活动标签页、当前窗口"只能靠条件本身断言：
    // 少传 `currentWindow` 时用例仍然会绿，除非这一行在。
    expect(stub.tabs.queries).toEqual([{ active: true, currentWindow: true }]);

    stub.tabs.activeTabs = []; // 没有任何活动标签页
    stub.commands.run('toggle-translate');
    await flush();
    expect(stub.tabs.sent).toHaveLength(1);
  });

  it('菜单点击按 id 转发：翻译此页 / 翻译选中文本', async () => {
    stub.contextMenus.click({ menuItemId: 'jinyi-translate-page' }, { id: 9 });
    stub.contextMenus.click({ menuItemId: 'jinyi-translate-selection', selectionText: 'Hello world' }, { id: 9 });
    // 没有选中文本、菜单项不认识、没有标签页：都不发。
    stub.contextMenus.click({ menuItemId: 'jinyi-translate-selection' }, { id: 9 });
    stub.contextMenus.click({ menuItemId: 'jinyi-unknown' }, { id: 9 });
    stub.contextMenus.click({ menuItemId: 'jinyi-translate-page' }, undefined);
    await flush();

    expect(stub.tabs.sent).toEqual([
      { tabId: 9, message: { type: MSG.TRANSLATE_PAGE } },
      { tabId: 9, message: { type: MSG.TRANSLATE_SELECTION, payload: { text: 'Hello world' } } },
    ]);
  });

  it('受限页面上 sendMessage 被拒时静默忽略（不产生未处理拒绝）', async () => {
    stub.tabs.rejectSendMessage = true;

    stub.commands.run('toggle-translate');
    await flush(); // 快捷键那条要先 `query` 活动标签页，发送排在下一个微任务
    stub.contextMenus.click({ menuItemId: 'jinyi-translate-page' }, { id: 9 });
    await flush();

    // 两次都真的尝试过；用例能跑到下一行就是 `.catch(() => undefined)` 兜住了的证明。
    expect(stub.tabs.sent).toEqual([
      { tabId: 7, message: { type: MSG.TOGGLE_PAGE } },
      { tabId: 9, message: { type: MSG.TRANSLATE_PAGE } },
    ]);
  });
});
