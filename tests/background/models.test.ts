// tests/background/models.test.ts
/**
 * `/models` 拉取的后台侧：URL、鉴权、10 秒超时、三种响应形状的宽容解析、失败分类、权限闸。
 *
 * **node 环境**：被测模块只依赖 `engines/api-error`、`shared/host-permission` 与一个
 * `EngineProfile` 的**类型**，不碰 DOM。权限那一支要装 chrome 替身（`hasHostPermission` 在
 * 没有权限 API 的环境里恒为 true，而本文件要**正面**钉住"未授权时不发请求"）。
 * "后台自己从存储读 Key"这件事在 `service-worker.test.ts` 里端到端钉住——那是"谁去读"的问题。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODELS_TIMEOUT_MS, describeModelsStatus, fetchModels, parseModelsPayload } from '../../src/background/models';
import type { EngineProfile } from '../../src/shared/settings';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';

let chromeStub: ChromeStub;

function profile(over: Partial<EngineProfile> = {}): EngineProfile {
  return {
    id: 'p-a',
    label: 'A 家',
    kind: 'openai-compat',
    baseUrl: 'https://api.example.com/v1',
    models: [],
    activeModel: '',
    apiKey: 'sk-secret',
    ...over,
  };
}

/** 假 `fetch`：记下每次请求的 URL 与鉴权头，按队列给响应（用完了复用最后一个）。 */
function stubFetch(responses: Array<() => Promise<Response>>): Array<{ url: string; auth: string | null }> {
  const calls: Array<{ url: string; auth: string | null }> = [];
  let index = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
    const next = responses[Math.min(index, responses.length - 1)] as () => Promise<Response>;
    index += 1;
    return next();
  });
  return calls;
}

/** 一个 JSON 响应工厂（`status` 默认 200）。 */
const json = (data: unknown, status = 200) => async () =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** 一句失败文案的读数（`ok: false` 那一支才读得到 `message`）。 */
function messageOf(result: Awaited<ReturnType<typeof fetchModels>>): string {
  if (result.ok) throw new Error('这次拉取是成功的，用例想读的是失败文案');
  return result.message;
}

beforeEach(() => {
  // 每个用例默认"这个 origin 已经授权过"（真机上就是用户保存档案时点过允许）。
  // 只有 §5.5 那条用例自己把它撤销——它是"未授权时不发请求"唯一的读数。
  chromeStub = installChromeStub();
  chromeStub.permissions.grantedOrigins.add('https://api.example.com/*');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('parseModelsPayload：三种形状 + 宽容', () => {
  it('认三种形状：data[].id / models[].name / 顶层数组', () => {
    expect(parseModelsPayload({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] })).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(parseModelsPayload({ models: [{ name: 'qwen2.5:14b' }] })).toEqual(['qwen2.5:14b']);
    expect(parseModelsPayload([{ id: 'a' }, { name: 'b' }])).toEqual(['a', 'b']);
  });

  it('条目取 id ?? name；非字符串 / 空名 / 重复项丢掉；首尾空白 trim', () => {
    expect(
      parseModelsPayload({ data: [{ id: 'a' }, { id: 7 }, { name: 'b' }, { id: '' }, { id: '  c  ' }, { id: 'a' }] }),
    ).toEqual(['a', 'b', 'c']);
  });

  it('整体解析不出任何一条时返回空数组（调用方按"该服务商不提供模型列表"处理，不是报错）', () => {
    for (const payload of [{}, { data: 'nope' }, { models: null }, [], 'plain', null, 7]) {
      expect([payload, parseModelsPayload(payload)]).toEqual([payload, []]);
    }
  });
});

describe('describeModelsStatus：五句各不相同，每一句都留着"手填"这条路', () => {
  it('401 / 403 → 指向 Key；404 → 指向"这个地址没有 /models"；5xx → 服务商侧；其余 4xx → 请求不对', () => {
    const auth = describeModelsStatus(401, 'invalid key');
    const forbidden = describeModelsStatus(403, '');
    const missing = describeModelsStatus(404, 'not found');
    const boom = describeModelsStatus(500, 'bad gateway');
    const bad = describeModelsStatus(400, 'bad params');

    expect(auth).toContain('HTTP 401');
    expect(auth).toContain('API Key');
    expect(auth).toContain('invalid key'); // 正文不丢（§5.3 点名复用 extractErrorDetail）
    expect(forbidden).toContain('HTTP 403');
    expect(missing).toContain('HTTP 404');
    expect(missing).toContain('/models');
    expect(boom).toContain('HTTP 500');
    expect(bad).toContain('HTTP 400');

    // 五句互不相同：任何"把分类拍平成一句"的改动都会在这里红。
    expect(new Set([auth, forbidden, missing, boom, bad]).size).toBe(5);
    // 每一句都要留着那条**永远可达**的出路。
    for (const text of [auth, forbidden, missing, boom, bad]) expect(text).toContain('添加模型');
  });
});

describe('fetchModels：URL、鉴权、四种失败、超时', () => {
  it('请求 {baseUrl}/models（尾斜杠先去掉）并带上 Bearer Key', async () => {
    const calls = stubFetch([json({ data: [{ id: 'm-1' }] })]);

    const result = await fetchModels(profile({ baseUrl: 'https://api.example.com/v1/' }));

    expect(result).toEqual({ ok: true, models: ['m-1'] });
    expect(calls).toEqual([{ url: 'https://api.example.com/v1/models', auth: 'Bearer sk-secret' }]);
  });

  it('缺地址 / 缺 Key：一个请求都不发，各说一句能读懂的话', async () => {
    const calls = stubFetch([json({})]);

    const noUrl = await fetchModels(profile({ baseUrl: '   ' }));
    const noKey = await fetchModels(profile({ apiKey: '' }));

    expect(calls).toEqual([]);
    expect(messageOf(noUrl)).toContain('接口地址');
    expect(messageOf(noKey)).toContain('API Key');
    expect(messageOf(noKey)).toContain('添加模型');
  });

  it('未授权访问这个地址：一个请求都不发，并指向"回设置页重新保存一次该档案以授权"（§5.5）', async () => {
    chromeStub.permissions.grantedOrigins.clear();
    const calls = stubFetch([json({ data: [{ id: 'm-1' }] })]);

    const text = messageOf(await fetchModels(profile()));

    expect(calls).toEqual([]);
    expect(text).toContain('还没授权访问 https://api.example.com/*');
    expect(text).toContain('重新保存一次这个档案');
  });

  it('地址不是合法 URL：也不发请求，指向"先修正接口地址"', async () => {
    const calls = stubFetch([json({ data: [] })]);

    const text = messageOf(await fetchModels(profile({ baseUrl: 'api.example.com/v1' })));

    expect(calls).toEqual([]);
    expect(text).toContain('不是合法的 URL');
  });

  it('401 / 404 / 非 JSON / 网络不可达：四句各不相同，且都指向手填', async () => {
    stubFetch([json({ error: { message: 'invalid key' } }, 401)]);
    const auth = messageOf(await fetchModels(profile()));

    stubFetch([json({}, 404)]);
    const missing = messageOf(await fetchModels(profile()));

    stubFetch([async () => new Response('<html>nope</html>', { status: 200 })]);
    const notJson = messageOf(await fetchModels(profile()));

    stubFetch([
      async () => {
        throw new Error('fetch failed');
      },
    ]);
    const offline = messageOf(await fetchModels(profile()));

    expect(auth).toContain('API Key');
    expect(missing).toContain('/models');
    expect(notJson).toContain('不是合法 JSON');
    expect(offline).toContain('拉取模型清单失败');
    expect(new Set([auth, missing, notJson, offline]).size).toBe(4);
    for (const text of [auth, missing, notJson, offline]) expect(text).toContain('添加模型');
  });

  it('超时：10 秒没有响应就中止（§5.3 的独立超时），文案说清"可以稍后重试或手填"', async () => {
    vi.useFakeTimers();
    // fetch 挂住，直到 signal 中止才拒绝——真机上 abort 就是这个形状（与 openai-compat 同源）。
    vi.stubGlobal(
      'fetch',
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );

    const pending = fetchModels(profile());
    await vi.advanceTimersByTimeAsync(MODELS_TIMEOUT_MS);
    const text = messageOf(await pending);

    // 秒数是用户看得见的行为（文案里就写着它），所以钉住常量本身。
    expect(MODELS_TIMEOUT_MS).toBe(10_000);
    expect(text).toContain('超时');
    expect(text).toContain('添加模型');
  });
});
