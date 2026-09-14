import { afterEach, describe, expect, it, vi } from 'vitest';
import { googleEngine, parseGoogleResponse, toGoogleLang } from '../../src/engines/google';
import { EngineError } from '../../src/engines/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Google 免费接口的真实返回结构：[[[译文, 原文, ...], ...], null, "en", ...] */
function googleBody(translations: string[]): unknown {
  return [translations.map((t) => [t, 'source', null, null, 10]), null, 'en'];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toGoogleLang', () => {
  it('把 zh-Hans 映射为 zh-CN', () => {
    expect(toGoogleLang('zh-Hans')).toBe('zh-CN');
  });

  it('把 zh-Hant 映射为 zh-TW', () => {
    expect(toGoogleLang('zh-Hant')).toBe('zh-TW');
  });

  it('其它语言原样透传', () => {
    expect(toGoogleLang('ja')).toBe('ja');
  });
});

describe('parseGoogleResponse', () => {
  it('拼接多个分句', () => {
    expect(parseGoogleResponse(googleBody(['你好', '世界']))).toBe('你好世界');
  });

  it('结构异常时抛 BAD_RESPONSE', () => {
    expect(() => parseGoogleResponse({})).toThrow(EngineError);
    try {
      parseGoogleResponse({});
    } catch (err) {
      expect((err as EngineError).code).toBe('BAD_RESPONSE');
    }
  });

  it('译文为空时抛 BAD_RESPONSE', () => {
    try {
      parseGoogleResponse([[], null, 'en']);
      throw new Error('本应抛错');
    } catch (err) {
      expect((err as EngineError).code).toBe('BAD_RESPONSE');
    }
  });
});

describe('googleEngine.translate', () => {
  it('逐条请求并保持顺序', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(googleBody(['甲'])))
      .mockResolvedValueOnce(jsonResponse(googleBody(['乙'])));
    vi.stubGlobal('fetch', fetchMock);

    const out = await googleEngine.translate(
      { texts: ['A', 'B'], from: 'auto', to: 'zh-Hans', signal: new AbortController().signal },
      {},
    );

    expect(out).toEqual(['甲', '乙']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('tl=zh-CN');
  });

  it('429 抛 RATE_LIMIT', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 429)));
    await expect(
      googleEngine.translate(
        { texts: ['A'], from: 'auto', to: 'zh-Hans', signal: new AbortController().signal },
        {},
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMIT' });
  });

  it('403 抛 AUTH', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 403)));
    await expect(
      googleEngine.translate(
        { texts: ['A'], from: 'auto', to: 'zh-Hans', signal: new AbortController().signal },
        {},
      ),
    ).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('网络异常抛 NETWORK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')));
    await expect(
      googleEngine.translate(
        { texts: ['A'], from: 'auto', to: 'zh-Hans', signal: new AbortController().signal },
        {},
      ),
    ).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('响应体不是合法 JSON 时抛 BAD_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>oops</html>', { status: 200 })));
    await expect(
      googleEngine.translate(
        { texts: ['A'], from: 'auto', to: 'zh-Hans', signal: new AbortController().signal },
        {},
      ),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('批内单条瞬时抖动只重发该条，不重发整批', async () => {
    // 12 条批次里第 11 条抖一次就不该实打实发出两倍的文本量：
    // 条目级重试必须发生在引擎内部，调度器那边只看得见"整批失败"。
    const texts = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
    const attempts = new Map<string, number>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const query = new URL(String(input)).searchParams.get('q') ?? '';
      const seen = (attempts.get(query) ?? 0) + 1;
      attempts.set(query, seen);
      // 第 3 条第一次调用抖一次，第二次成功；其余全部一次成功。
      if (query === 't3' && seen === 1) throw new TypeError('failed to fetch');
      return jsonResponse(googleBody([`译:${query}`]));
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await googleEngine.translate(
      { texts, from: 'auto', to: 'zh-Hans', signal: new AbortController().signal },
      {},
    );

    expect(out).toEqual(texts.map((text) => `译:${text}`));
    // 8 条文本 + 第 3 条的那一次重发 = 9；整批重发会是 16。
    expect(fetchMock).toHaveBeenCalledTimes(9);
    for (const text of texts) expect(attempts.get(text)).toBe(text === 't3' ? 2 : 1);
  });

  it('单个批次内部并发不超过 4', async () => {
    let inFlight = 0;
    let peak = 0;
    const waiting: Array<() => void> = [];

    // 让请求在「凑够 4 个同时在飞」之前不返回，从而真实观测到并发峰值。
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length >= 4) waiting.splice(0).forEach((release) => release());
      });
      inFlight -= 1;
      const query = new URL(String(input)).searchParams.get('q') ?? '';
      return jsonResponse(googleBody([`译:${query}`]));
    });
    vi.stubGlobal('fetch', fetchMock);

    const texts = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
    const out = await googleEngine.translate(
      { texts, from: 'auto', to: 'zh-Hans', signal: new AbortController().signal },
      {},
    );

    expect(peak).toBeLessThanOrEqual(4);
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(out).toEqual(texts.map((text) => `译:${text}`));
  });
});
