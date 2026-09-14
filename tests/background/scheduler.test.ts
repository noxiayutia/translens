import { describe, expect, it } from 'vitest';
import { translateBatch, type BatchDeps, type CacheLike } from '../../src/background/scheduler';
import { EngineError, type TranslateRequest, type Translator } from '../../src/engines/types';
import { TranslationCache } from '../../src/core/cache';
import { MemoryStorage } from '../helpers/memory-storage';

/** 可编排的假引擎：按脚本依次返回结果或抛错。 */
function fakeEngine(script: Array<string[] | Error>): { engine: Translator; calls: string[][] } {
  const calls: string[][] = [];
  let cursor = 0;
  const engine: Translator = {
    id: 'fake',
    name: 'Fake',
    needsKey: false,
    supportsGlossary: false,
    async translate(request: TranslateRequest): Promise<string[]> {
      calls.push([...request.texts]);
      const step = script[Math.min(cursor, script.length - 1)];
      cursor += 1;
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return { engine, calls };
}

function deps(engine: Translator, overrides: Partial<BatchDeps> = {}): BatchDeps {
  return {
    engine,
    engineConfig: {},
    sourceLang: 'auto',
    targetLang: 'zh-Hans',
    cache: new TranslationCache(new MemoryStorage()),
    sleep: async () => {},
    ...overrides,
  };
}

describe('translateBatch', () => {
  it('缓存命中时不调用引擎', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    const { engine, calls } = fakeEngine([['你好']]);
    const shared = deps(engine, { cache });

    await translateBatch([{ id: 'a', text: 'Hello' }], shared);
    const second = await translateBatch([{ id: 'a', text: 'Hello' }], shared);

    expect(calls).toHaveLength(1);
    expect(second[0]).toEqual({ id: 'a', text: '你好' });
  });

  it('未命中的条目翻译后写入缓存', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    const { engine } = fakeEngine([['你好']]);
    await translateBatch([{ id: 'a', text: 'Hello' }], deps(engine, { cache }));

    const key = await translateBatch([{ id: 'a', text: 'Hello' }], deps(engine, { cache }));
    expect(key[0].text).toBe('你好');
    expect(await cache.count()).toBe(1);
  });

  it('返回结果与输入顺序一致', async () => {
    const { engine } = fakeEngine([['甲', '乙']]);
    const out = await translateBatch(
      [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ],
      deps(engine),
    );
    expect(out).toEqual([
      { id: 'a', text: '甲' },
      { id: 'b', text: '乙' },
    ]);
  });

  it('鉴权失败不重试', async () => {
    const { engine, calls } = fakeEngine([new EngineError('AUTH', 'Key 无效')]);
    const out = await translateBatch([{ id: 'a', text: 'A' }], deps(engine));
    expect(calls).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'a', text: null, code: 'AUTH' });
  });

  it('网络错误退避重试后成功', async () => {
    const sleeps: number[] = [];
    const { engine, calls } = fakeEngine([new EngineError('NETWORK', '断网'), ['你好']]);
    const out = await translateBatch(
      [{ id: 'a', text: 'A' }],
      deps(engine, { sleep: async (ms) => void sleeps.push(ms) }),
    );
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([500]);
    expect(out[0].text).toBe('你好');
  });

  it('重试耗尽后返回失败结果而不是抛错', async () => {
    const { engine, calls } = fakeEngine([new EngineError('NETWORK', '一直断网')]);
    const out = await translateBatch([{ id: 'a', text: 'A' }], deps(engine));
    expect(calls).toHaveLength(3);
    expect(out[0]).toMatchObject({ text: null, code: 'NETWORK' });
  });

  it('文本过长时按句切分重试并拼接结果', async () => {
    // 必须用真正超长的文本：切分阈值是 max(200, 文本长度的一半)，短文本不会触发切分。
    const long = '第一句。'.repeat(200);
    const { engine, calls } = fakeEngine([
      new EngineError('TOO_LONG', '过长'),
      ['切分一。', '切分二。'],
    ]);
    const out = await translateBatch([{ id: 'a', text: long }], deps(engine));

    expect(calls[0]).toEqual([long]);
    expect(calls[1].length).toBeGreaterThan(1);
    // 切分不能丢字符
    expect(calls[1].join('')).toBe(long);
    expect(out[0].text).toBe('切分一。切分二。');
  });

  it('切分降级中某条失败时，另一条的译文照常返回并进缓存', async () => {
    // 切分路径也要逐条隔离：a 已经切分翻好了，不该因为 b 的 AUTH 被一起标成 AUTH、
    // 也不该把 a 的译文丢掉（translateOneByOne 早就这么做了，两条降级路径必须同形）。
    const cache = new TranslationCache(new MemoryStorage());
    const longA = '第一句。'.repeat(200);
    const longB = '第二句。'.repeat(200);
    const calls: string[][] = [];
    let cursor = 0;
    const engine: Translator = {
      id: 'fake',
      name: 'Fake',
      needsKey: false,
      supportsGlossary: false,
      async translate(request: TranslateRequest): Promise<string[]> {
        calls.push([...request.texts]);
        cursor += 1;
        // 1) 整批报过长，进入切分降级；2) a 的切片翻好；3) b 的切片报鉴权失败。
        if (cursor === 1) throw new EngineError('TOO_LONG', '过长');
        if (cursor === 2) return request.texts.map((text) => `译:${text}`);
        throw new EngineError('AUTH', 'Key 无效');
      },
    };

    const out = await translateBatch(
      [
        { id: 'a', text: longA },
        { id: 'b', text: longB },
      ],
      deps(engine, { cache }),
    );

    expect(calls).toHaveLength(3);
    expect(calls[1].length).toBeGreaterThan(1);
    expect(out[0].text).toBe(calls[1].map((text) => `译:${text}`).join(''));
    expect(out[1]).toMatchObject({ id: 'b', text: null, code: 'AUTH', message: 'Key 无效' });

    // a 的译文已经写进缓存：重试只需再翻 b，不会再请求引擎。
    await expect(cache.count()).resolves.toBe(1);
    const again = await translateBatch([{ id: 'a', text: longA }], deps(engine, { cache }));
    expect(again[0].text).toBe(out[0].text);
    expect(calls).toHaveLength(3);
  });

  it('返回条目数不符时降级为逐条翻译', async () => {
    const { engine, calls } = fakeEngine([['只有一条'], ['甲'], ['乙']]);
    const out = await translateBatch(
      [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ],
      deps(engine),
    );
    expect(calls).toHaveLength(3);
    expect(out).toEqual([
      { id: 'a', text: '甲' },
      { id: 'b', text: '乙' },
    ]);
  });

  it('SDK 抛出的非 EngineError 也会被归类', async () => {
    const { engine } = fakeEngine([new TypeError('failed to fetch')]);
    const out = await translateBatch([{ id: 'a', text: 'A' }], deps(engine));
    expect(out[0]).toMatchObject({ text: null, code: 'UNKNOWN' });
  });

  it('空输入返回空数组', async () => {
    const { engine, calls } = fakeEngine([[]]);
    expect(await translateBatch([], deps(engine))).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('只有部分命中时只请求未命中的部分', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    const { engine, calls } = fakeEngine([['你好'], ['世界']]);
    await translateBatch([{ id: 'a', text: 'Hello' }], deps(engine, { cache }));

    const out = await translateBatch(
      [
        { id: 'a', text: 'Hello' },
        { id: 'b', text: 'World' },
      ],
      deps(engine, { cache }),
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(['World']);
    expect(out).toEqual([
      { id: 'a', text: '你好' },
      { id: 'b', text: '世界' },
    ]);
  });

  it('换模型后同一段文本不会命中旧模型的缓存', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    const plain = fakeEngine([['你好']]);
    const smart = fakeEngine([['您好']]);

    const first = await translateBatch(
      [{ id: 'a', text: 'Hello' }],
      deps(plain.engine, { cache, engineConfig: { model: 'plain' } }),
    );
    const second = await translateBatch(
      [{ id: 'a', text: 'Hello' }],
      deps(smart.engine, { cache, engineConfig: { model: 'smart' } }),
    );

    expect(first[0].text).toBe('你好');
    expect(smart.calls).toHaveLength(1);
    expect(second[0].text).toBe('您好');
  });

  it('单条请求返回条目数不符时不再降级，直接报错', async () => {
    // translateWithFallback 的逐条降级以 texts.length > 1 为条件：只有一条时可退的地方
    // 都没有，只能把 BAD_RESPONSE 上报，否则会拿 [text] 反复请求同一个引擎。
    const { engine, calls } = fakeEngine([['甲', '乙']]);
    const out = await translateBatch([{ id: 'a', text: 'A' }], deps(engine));

    expect(calls).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'a', text: null, code: 'BAD_RESPONSE' });
  });

  it('缓存写入失败不影响译文，也不向调用方抛错', async () => {
    // CacheLike 是鸭子类型接口，putMany 抛错不在类型系统里排除；
    // 写失败只该意味着"这次没缓存上"，不能把翻译成功的一批上报成失败。
    const cache: CacheLike = {
      getMany: async () => new Map(),
      putMany: async () => {
        throw new Error('storage exploded');
      },
    };
    const { engine } = fakeEngine([['你好']]);

    await expect(translateBatch([{ id: 'a', text: 'Hello' }], deps(engine, { cache }))).resolves.toEqual([
      { id: 'a', text: '你好' },
    ]);
  });

  it('缓存读取失败时退化为全部未命中，仍然照常翻译', async () => {
    const cache: CacheLike = {
      getMany: async () => {
        throw new Error('storage exploded');
      },
      putMany: async () => {},
    };
    const { engine, calls } = fakeEngine([['你好']]);

    const out = await translateBatch([{ id: 'a', text: 'Hello' }], deps(engine, { cache }));

    expect(calls).toHaveLength(1);
    expect(out).toEqual([{ id: 'a', text: '你好' }]);
  });

  it('逐条降级途中的网络错误照样退避重试', async () => {
    // 降级把一批摊成 N 次请求，撞上瞬时抖动的概率比整批请求更高，
    // 规格给的退避预算在这里同样要用上。
    const sleeps: number[] = [];
    const { engine, calls } = fakeEngine([['只有一条'], new EngineError('NETWORK', '断网'), ['甲'], ['乙']]);
    const out = await translateBatch(
      [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ],
      deps(engine, { sleep: async (ms) => void sleeps.push(ms) }),
    );

    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([500]);
    expect(out).toEqual([
      { id: 'a', text: '甲' },
      { id: 'b', text: '乙' },
    ]);
  });

  it('逐条降级中某条失败时，保留已成功的译文并只标记失败的那条', async () => {
    // 成功的那条不该被邻居的错误码连坐，也不该把已经发出去的请求白费掉。
    const cache = new TranslationCache(new MemoryStorage());
    const { engine, calls } = fakeEngine([
      ['只有一条'],
      ['甲'],
      new EngineError('AUTH', 'Key 无效'),
    ]);
    const out = await translateBatch(
      [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ],
      deps(engine, { cache }),
    );

    expect(calls).toHaveLength(3);
    expect(out).toEqual([
      { id: 'a', text: '甲' },
      { id: 'b', text: null, code: 'AUTH', message: 'Key 无效' },
    ]);
    // 成功的那条已经写进缓存：重试只需再翻 B。
    await expect(cache.count()).resolves.toBe(1);
  });

  it('空文本不进引擎也不写缓存', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    const { engine, calls } = fakeEngine([['你好']]);
    const out = await translateBatch(
      [
        { id: 'a', text: '' },
        { id: 'b', text: 'Hello' },
      ],
      deps(engine, { cache }),
    );

    expect(calls).toEqual([['Hello']]);
    expect(out).toEqual([
      { id: 'a', text: '' },
      { id: 'b', text: '你好' },
    ]);
    await expect(cache.count()).resolves.toBe(1);
  });
});
