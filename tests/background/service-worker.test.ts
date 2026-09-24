// tests/background/service-worker.test.ts
/**
 * service worker 是整条链路的集成点：消息校验 → 设置 → 引擎 → 调度器 → 两层缓存。
 *
 * 它在 **import 时**就注册监听器（模块级副作用），所以 chrome 替身必须先装好：
 * 本文件在模块体里先 `installChromeStub()`，再用 `beforeAll` 动态 import，静态 import
 * 会把求值顺序反过来（ESM 的静态 import 先于模块体执行）。
 *
 * 引擎走的是真实现 + 假 `fetch`：唯一剩下的适配器一次请求带多条文本，假响应把请求体里每个
 * 编号标记后面的文本回显成 `【…】`，于是"发了几个请求、请求带什么参数、结果有没有落盘"
 * 都能直接断言。
 */
import process from 'node:process';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationCache } from '../../src/core/cache';
import { chromeArea } from '../../src/shared/chrome-area';
import { MSG } from '../../src/shared/messages';
import { CURRENT_VERSION, NO_ENGINE_PROBLEM, SETTINGS_KEY } from '../../src/shared/settings';
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

interface StubCall {
  url: URL;
  body: { model: string; messages: Array<{ role: string; content: string }> };
}

/**
 * 唯一剩下那个适配器（OpenAI 兼容）的假响应：把请求体里每个编号标记后面的文本回显成 `【…】`，
 * 并记下每个请求的 URL 与请求体。
 *
 * 名字与形状都换了：旧版是 `stubGoogleFetch`，造的是免费接口那份**嵌套数组**
 * （`[[[译文, 原文, …], …], null, 源语言, …]`）。那个形状随 `src/engines/google.ts`
 * 一起删掉了——**今天没有任何生产代码会解析它**，留着一个"看起来还在"的假响应只会误导下一个人。
 */
function stubEngineFetch(): StubCall[] {
  const calls: StubCall[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as StubCall['body'];
    calls.push({ url, body });
    const user = body.messages.find((message) => message.role === 'user')?.content ?? '';
    // 两种请求形状都要认：多段带 `<<<N>>>` 编号，单段不带（`openai-compat.ts` 的 `SINGLE_RULES`）。
    // 只认标记的话，单段请求在这里会解析出 0 条文本 ⇒ 回一个空 content ⇒ 引擎抛
    // BAD_RESPONSE ⇒ 缓存一条都不写，而红的是"缓存层次顺序"那两条毫不相干的用例。
    const numbered = /<<<\d+>>>/.test(user);
    const texts = numbered
      ? [...user.matchAll(/<<<\d+>>>\n([^\n]*)/g)].map((match) => match[1] as string)
      : user.trim() === ''
        ? []
        : [user.trim()];
    const content = numbered
      ? texts.map((text, index) => `<<<${index + 1}>>>\n【${text}】`).join('\n')
      : `【${texts[0] ?? ''}】`;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

/** 「能真的发出请求」的档案：baseUrl 固定，Key 非空，模型是当前项。 */
const ENGINE_BASE_URL = 'https://api.example.com/v1';
const ENGINE_ORIGIN_PATTERN = 'https://api.example.com/*';

function usableProfile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p-a',
    label: '我的接口',
    baseUrl: ENGINE_BASE_URL,
    models: ['m'],
    activeModel: 'm',
    apiKey: 'sk-a',
    ...over,
  };
}

/**
 * 显式播种"有可用引擎"的设置，并把这个 origin 标成**已授权**。
 *
 * ⚠ 授权这一步不能省：`beforeEach` 的 `stub.reset()` 会清空 `grantedOrigins`，而
 * `openai-compat` 在 `fetch` 之前会先查宿主权限（没授权就抛 AUTH，一个请求都不发）。
 * 旧版这四条用例之所以"什么都不用写"，是因为它们靠 `DEFAULT_SETTINGS.engineId === 'google'`
 * 走通了免费接口那条**不需要授权**的路——v5 起默认是 `''`，那条路没有了。
 */
async function useUsableEngine(over: Record<string, unknown> = {}): Promise<void> {
  stub.permissions.grantedOrigins.add(ENGINE_ORIGIN_PATTERN);
  await useSettings({ engineId: 'p-a', profiles: [usableProfile()], ...over });
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
    const calls = stubEngineFetch();
    await useUsableEngine();

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

    // 唯一适配器一次请求带多条文本（免费接口是"一条文本一个请求"，那个形状随它一起删了）。
    expect(calls).toHaveLength(1);
    expect(calls[0].url.toString()).toBe('https://api.example.com/v1/chat/completions');
    const user = calls[0].body.messages.find((message) => message.role === 'user')?.content ?? '';
    expect(user).toContain('<<<1>>>\nHello');
    expect(user).toContain('<<<2>>>\nWorld');

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
    const calls = stubEngineFetch();
    await useUsableEngine({ targetLang: 'ja' });

    await translateTexts({ items: [{ id: 'item-1', text: 'Hello' }], targetLang: 'en' }).response();
    const systemOf = (call: StubCall): string =>
      call.body.messages.find((message) => message.role === 'system')?.content ?? '';
    // 断言写成渲染后的完整语言名（`Target language: English (en)`）而不是裸标签：
    // 提示词里现在给的是模型认得的名字。两条各自唯一对应一个目标语言，
    // "谁胜出"这个判据没有放松。
    expect(systemOf(calls[0])).toContain('Target language: English (en)');

    // 没带就按设置走（同一个 payload 形状，只有这一处差异）。
    await translateTexts({ items: [{ id: 'item-2', text: 'World' }] }).response();
    expect(systemOf(calls[1])).toContain('Target language: 日本語 (ja)');
  });

  /**
   * 与「重试语言走页面快照」互补的另一半分工（见 content/index.test.ts）：
   * **语言由内容脚本带进来（或回落当前设置），凭据永远现读当前设置**。
   * 用户点重试往往正是刚去设置页填好 Key 回来——后台要是拿着旧快照，那次重试
   * 还会用旧凭据失败。这条钉的是"每条消息各读一次设置"，不是缓存掉的长驻配置。
   * v3 形状：凭据住在 `profiles` 里被选中的那一份，`engineId` 是档案 id。
   */
  /**
   * 退避重试发生在后台，内容脚本看不见——所以后台要把"这是第几次尝试"推回去，
   * 页面才可能显示「重试中(第 n 次)」。没有这一条，用户在几百段页面上唯一能看到的
   * 就是「翻译中…」一直不变（真机读数：被节流的后台标签页里"在推进"与"卡住"同形）。
   */
  it('引擎重试时把第 n 次尝试推给发起方的标签页，带上这一批的段落 id', async () => {
    let attempt = 0;
    vi.stubGlobal('fetch', async () => {
      attempt += 1;
      if (attempt < 3) throw new Error('socket hang up');
      return new Response(JSON.stringify({ choices: [{ message: { content: '<<<1>>>\n你好\n<<<2>>>\n世界' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await useUsableEngine();

    const response = await stub.runtime.dispatchMessage(
      { type: MSG.TRANSLATE_TEXTS, payload: { items: [{ id: 'a', text: 'Hello' }, { id: 'b', text: 'World' }] } },
      { tab: { id: 7 } },
    );
    await response.response(9000); // 退避重试要 500ms + 1500ms，默认的 1 秒等待不够

    const pushed = stub.tabs.sent
      .map((entry) => ({ tabId: entry.tabId, message: entry.message as { type?: string; payload?: unknown } }))
      .filter((entry) => entry.message.type === MSG.ATTEMPT);
    expect(pushed.map((entry) => (entry.message.payload as { attempt: number }).attempt)).toEqual([2, 3]);
    expect((pushed[0]?.message.payload as { ids: string[] }).ids).toEqual(['a', 'b']);
    expect(pushed.map((entry) => entry.tabId)).toEqual([7, 7]);
  });

  /** 没有标签页可推（弹窗自己发的测试连接、或发送失败）都不能让翻译本身失败。 */
  it('没有 sender.tab 时不推尝试消息，翻译照常成功', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('socket hang up');
    });
    await useUsableEngine();
    const out = await translateTexts({ items: [{ id: 'a', text: 'Hello' }] });
    const body = (await out.response(9000)) as { ok: boolean; results: Array<{ text: string | null; code?: string }> };
    expect(body.results[0]).toMatchObject({ text: null, code: 'NETWORK' });
    expect(stub.tabs.sent.filter((e) => (e.message as { type?: string }).type === MSG.ATTEMPT)).toEqual([]);
  });

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

  /**
   * **「没有可用引擎 ⇒ 零请求」的端到端守卫**，也是本单元行为的**直接对立面**：
   * 起草规格时实测过，**改之前**同样的设置会真的发出一次 `translate.googleapis.com` 请求、
   * 返回 `{ ok: true, results: [{ text: '【Hello】' }] }`（免费接口静默兜底）。所以这条断言
   * 不是恒真式——它今天红、改完才绿。
   *
   * 牙在哪（两条各管一半，逐条记清楚，别只看"这条用例红了"）：
   * - `toEqual` 那条钉**响应形状**：`engine === null` 的提前返回被删掉时，`translateBatch`
   *   拿到 `null` 会抛成 `{ ok: false, code: 'UNKNOWN' }`（**不是** `AUTH` + 那句话）→ 红。
   *   注意：此时 `calls` **仍然是 0**——没有引擎就没有任何地方会去构造请求（这正是规格 §8.12
   *   说的"按构造"）。所以"删掉提前返回"**不会**让后台"真发请求"，规格 §10 变异表第 3 条的
   *   说法在这一点上不准确（见本计划 T1 的 M6/M6b）。
   * - `toHaveLength(0)` 那条钉**未来**：谁要是给 `resolveEngine` 加回一个**配置可用**的兜底
   *   引擎（M6b 演示的那种），请求立刻发出去，这条红。
   */
  it('没有可用引擎：整条返回 AUTH + 那句话，一个请求都不发', async () => {
    const calls = stubEngineFetch();
    await useSettings({ engineId: '', profiles: [] });

    await expect(translateTexts({ items: [{ id: 'item-1', text: 'Hello' }] }).response()).resolves.toEqual({
      ok: false,
      code: 'AUTH',
      message: NO_ENGINE_PROBLEM,
    });
    expect(calls).toHaveLength(0);
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
    stubEngineFetch(); // 引擎走真实现，给个假响应让批次真的跑完
    await useUsableEngine();
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

  it('拉取模型清单：后台自己从存储读 baseUrl 与 Key 并请求 /models（设置页只交 profileId）', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({ data: [{ id: 'm-1' }, { id: 'm-2' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    // `fetchModels` 会先查一次宿主权限（§5.5）——与引擎同一条纪律，所以这里要"已授权"。
    stub.permissions.grantedOrigins.add('https://api.example.com/*');
    await useSettings({
      engineId: 'p-a',
      profiles: [
        {
          id: 'p-a',
          label: 'A 家',
          baseUrl: 'https://api.example.com/v1',
          models: ['m-1'],
          activeModel: 'm-1',
          apiKey: 'sk-secret',
        },
      ],
    });

    const message = { type: MSG.FETCH_MODELS, payload: { profileId: 'p-a' } };

    const dispatch = stub.runtime.dispatchMessage(message);
    expect(dispatch.returns).toEqual([true]);
    expect(dispatch.responded).toBe(false); // 响应必须异步：同步返回就会丢消息
    await expect(dispatch.response()).resolves.toEqual({ ok: true, models: ['m-1', 'm-2'] });

    // 后台**确实**拿到了 Key（否则"消息里没有 Key"只是因为整条链路压根没读 Key）。
    expect(calls).toEqual([{ url: 'https://api.example.com/v1/models', auth: 'Bearer sk-secret' }]);
    // ⚠ **"消息体里不含 apiKey"这半边的读数不在这里**：本条用例手里的 `message` 是自己两行前
    // 造的字面量，对它断言"不含 sk-secret"是**恒真式**（测的是用例自己），不是守卫。
    // 那半边的真正读数在 Task C4——那里消息是由**设置页真的发出去**的
    // （`chromeStub.runtime.sentMessages` 精确相等），payload 多一个字段就红。
  });

  it('拉取的失败与"档案不在"都走 { ok: false, message }：不抛错、不留未处理的拒绝', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
    stub.permissions.grantedOrigins.add('https://api.example.com/*');
    await useSettings({
      engineId: 'p-a',
      profiles: [
        { id: 'p-a', label: 'A 家', baseUrl: 'https://api.example.com/v1', models: [], activeModel: '', apiKey: 'sk-a' },
      ],
    });

    const missing = stub.runtime.dispatchMessage({ type: MSG.FETCH_MODELS, payload: { profileId: 'gone' } });
    await expect(missing.response()).resolves.toEqual({
      ok: false,
      message: '这个档案已经不在了，请重新打开设置页再试。',
    });

    const failed = stub.runtime.dispatchMessage({ type: MSG.FETCH_MODELS, payload: { profileId: 'p-a' } });
    const response = (await failed.response()) as { ok: boolean; message: string };
    expect(response.ok).toBe(false);
    expect(response.message).toContain('HTTP 404');
  });

  it('档案没有当前模型：可读错误 + 一个请求都不发（成对：把 activeModel 填上就真的发）', async () => {
    const calls: Array<{ model: string }> = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ model: (JSON.parse(String(init?.body)) as { model: string }).model });
      return new Response(JSON.stringify({ choices: [{ message: { content: '<<<1>>> 你好' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    stub.permissions.grantedOrigins.add('https://api.example.com/*');
    const noModel = {
      id: 'p-a',
      label: 'A 家',
      baseUrl: 'https://api.example.com/v1',
      models: ['m-1'],
      activeModel: '',
      apiKey: 'sk-a',
    };
    await useSettings({ engineId: 'p-a', profiles: [noModel] });

    const dispatch = translateTexts({ items: [{ id: 'i1', text: 'Hello' }] });
    // ⚠ **顺序是承重的（落地校正）**：先收响应、**紧接着就读 `calls` 与缓存**，最后才断言错误码与文案。
    // 原来写成"先 `await expect(...).resolves.toEqual({…})` 再读 `calls`"，于是"一个请求都没发"这个读数
    // 排在了错误断言后面——那正是"测量安排本身让读数看不见"的形状（复盘 §3）。
    // ⚠ **成对的另一半是下面那条独立的用例**（原来挤在同一条 `it` 里）：挤在一起时，这一条的错误断言
    // 一红，另一半的读数就再也跑不到（本仓"前面的失败遮住后面的读数"）。两条独立用例各红各的。
    const response = await dispatch.response();
    expect(calls).toEqual([]); // ① 一次 fetch 都没有
    expect(cacheEntries('local')).toHaveLength(0); // ② 两层缓存也没留下条目
    expect(cacheEntries('session')).toHaveLength(0);
    expect(response).toEqual({
      ok: false,
      code: 'AUTH',
      message: '这个档案还没有模型，点「添加模型」或「拉取可用模型」',
    });
  });

  it('成对的另一半：把 activeModel 填上就真的发一次请求（上一条的"零请求"不是整条链路坏了）', async () => {
    // 没有这一半，上一条在"整条链路都坏了 / 永远返回 AUTH"的实现下照样是绿的。
    const calls: Array<{ model: string }> = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ model: (JSON.parse(String(init?.body)) as { model: string }).model });
      return new Response(JSON.stringify({ choices: [{ message: { content: '<<<1>>> 你好' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    stub.permissions.grantedOrigins.add('https://api.example.com/*');
    await useSettings({
      engineId: 'p-a',
      profiles: [
        {
          id: 'p-a',
          label: 'A 家',
          baseUrl: 'https://api.example.com/v1',
          models: ['m-1'],
          activeModel: 'm-1',
          apiKey: 'sk-a',
        },
      ],
    });

    const response = await translateTexts({ items: [{ id: 'i2', text: 'Hello' }] }).response();
    expect(calls).toEqual([{ model: 'm-1' }]);
    // 上一条的 `cacheEntries(...) === 0` 只有在"同一个夹具下缓存真的会写进去"时才有信息量：
    // 这两行是它的正向对照（`cacheEntries` 要是取错层 / 取错前缀，上一条会永远绿）。
    expect(cacheEntries('local')).toHaveLength(1);
    expect(cacheEntries('session')).toHaveLength(1);
    expect(response).toEqual({ ok: true, results: [{ id: 'i2', text: '你好' }] });
  });

  it('同一个档案换 activeModel：不命中上一个模型的缓存（§4 的前提，端到端钉住）', async () => {
    // `scheduler.test.ts:290` 已有一条**单元级**的网（`engineConfig.model` 变 → key 变）；这一条补的是
    // **链路上游**：`resolveEngine` 到底把 `activeModel` 映射进了 `config.model`。
    // ⚠ 这条用例**今天不存在**（计划原来把它写在 C2，而 C2 不碰 `src/background/**`）——本 Step 是它的归属地。
    // 少了它，"映射写错字段（比如取 models[0]）"只会在真机上表现为"换模型没生效"。
    const bodies: Array<{ model: string; messages: unknown }> = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { model: string; messages: unknown });
      return new Response(JSON.stringify({ choices: [{ message: { content: '<<<1>>> 你好' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    stub.permissions.grantedOrigins.add('https://api.example.com/*');
    const both = {
      id: 'p-a',
      label: 'A 家',
      baseUrl: 'https://api.example.com/v1',
      models: ['m-1', 'm-2'],
      activeModel: 'm-1',
      apiKey: 'sk-a',
    };

    await useSettings({ engineId: 'p-a', profiles: [both] });
    await translateTexts({ items: [{ id: 'i1', text: 'Hello' }] }).response();
    expect(bodies).toHaveLength(1);

    // 同一个档案、同一段文本、只把 activeModel 换成 m-2：必须再请求一次（缓存不许串味）。
    await useSettings({ engineId: 'p-a', profiles: [{ ...both, activeModel: 'm-2' }] });
    await translateTexts({ items: [{ id: 'i2', text: 'Hello' }] }).response();

    expect(bodies.map((body) => body.model)).toEqual(['m-1', 'm-2']);
  });
});

describe('两层缓存的层次顺序', () => {
  /**
   * 接线方向是这一个调用决定的：`new TieredCache(sessionCache, persistentCache)`
   * （`service-worker.ts:69`）。两个参数同型，调换顺序照样编译、照样"两层都写了"，
   * 所以断言必须落在**方向**上：读会话层优先、持久层命中回填会话层。
   */
  it('两层都有同一个 key 时读会话层，持久层里被改坏的旧译文不会顶掉它', async () => {
    const calls = stubEngineFetch();
    await useUsableEngine();

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
    const calls = stubEngineFetch();
    await useUsableEngine();

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
