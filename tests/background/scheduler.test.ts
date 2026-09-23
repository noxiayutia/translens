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

  /**
   * 同一批里字面完全相同的文本只翻一次。真实网页的导航、「Read more」、表头、免责声明
   * 能占 20-40% 的段落数，逐条发出去等于把同一段文本重复计费，正文反而更容易撞上 429
   * （审查实测：60 个相同段落打出 36 次 fetch）。
   */
  it('同一批里字面相同的文本只送一次引擎，结果摊回每一条且都进缓存', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    const { engine, calls } = fakeEngine([['重复段译文', '独有段译文']]);
    const items = [
      { id: 'a', text: 'Read more' },
      { id: 'b', text: 'Unique sentence here' },
      { id: 'c', text: 'Read more' },
      { id: 'd', text: 'Read more' },
    ];

    const out = await translateBatch(items, deps(engine, { cache }));

    // 3 个相同 + 1 个不同 → 引擎只收到 2 条文本。
    expect(calls).toEqual([['Read more', 'Unique sentence here']]);
    // 4 条结果都正确：重复的那 3 条拿到同一份译文，顺序与输入一致。
    expect(out).toEqual([
      { id: 'a', text: '重复段译文' },
      { id: 'b', text: '独有段译文' },
      { id: 'c', text: '重复段译文' },
      { id: 'd', text: '重复段译文' },
    ]);
    // 都进缓存：缓存 key 由文本派生，重复的那 3 条共用同一个 key，所以真实条目数是 2。
    expect(await cache.count()).toBe(2);

    // 同一批再来一次：一条都不该再打给引擎（重复段命中的是同一个 key）。
    const again = await translateBatch(items, deps(engine, { cache }));
    expect(calls).toHaveLength(1);
    expect(again).toEqual(out);
  });

  it('命中的与未命中的一起折叠：只有未命中的唯一文本进引擎', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    const { engine, calls } = fakeEngine([['重复段译文'], ['独有段译文']]);
    const shared = deps(engine, { cache });

    // 先单独翻一次，让 'Read more' 进缓存。
    await translateBatch([{ id: 'seed', text: 'Read more' }], shared);
    expect(calls).toHaveLength(1);

    // 这一批里两条命中、两条未命中同一段文本（都未命中缓存的那条只该送一次）。
    const out = await translateBatch(
      [
        { id: 'a', text: 'Read more' },
        { id: 'b', text: 'Unique sentence here' },
        { id: 'c', text: 'Unique sentence here' },
        { id: 'd', text: 'Read more' },
      ],
      shared,
    );

    expect(calls).toEqual([['Read more'], ['Unique sentence here']]);
    expect(out).toEqual([
      { id: 'a', text: '重复段译文' },
      { id: 'b', text: '独有段译文' },
      { id: 'c', text: '独有段译文' },
      { id: 'd', text: '重复段译文' },
    ]);
  });

  it('源语言变化时缓存不命中：key 里带了 sourceLang', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    const { engine, calls } = fakeEngine([['自动检测的译文'], ['按英文源的译文']]);

    await translateBatch([{ id: 'a', text: 'Hello' }], deps(engine, { cache, sourceLang: 'auto' }));
    const second = await translateBatch([{ id: 'a', text: 'Hello' }], deps(engine, { cache, sourceLang: 'en' }));

    // 换了源语言语义就必须重新问引擎；共用 key 会命中按 auto 翻出来的那一份。
    expect(calls).toHaveLength(2);
    expect(second[0].text).toBe('按英文源的译文');
    // 反过来：同样的源语言仍然命中缓存。
    await translateBatch([{ id: 'a', text: 'Hello' }], deps(engine, { cache, sourceLang: 'en' }));
    expect(calls).toHaveLength(2);
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

  /**
   * 页面上要能分辨"接口在退避重试"与"接口就是慢"——这两种状态在占位文本上长得一模一样，
   * 而用户能做的只有等或放弃。调度器是唯一知道第几次尝试的地方，所以由它上报。
   */
  it('每次引擎调用前上报"这是第几次尝试"', async () => {
    const seen: number[] = [];
    const { engine } = fakeEngine([
      new EngineError('NETWORK', '断网'),
      new EngineError('RATE_LIMIT', '限流'),
      ['你好'],
    ]);
    await translateBatch([{ id: 'a', text: 'A' }], deps(engine, { onAttempt: (n) => void seen.push(n) }));
    expect(seen).toEqual([1, 2, 3]);
  });

  it('不传 onAttempt 时照常工作（可选回调不该成为调用方的负担）', async () => {
    const { engine, calls } = fakeEngine([['你好']]);
    const out = await translateBatch([{ id: 'a', text: 'A' }], deps(engine));
    expect(calls).toHaveLength(1);
    expect(out[0].text).toBe('你好');
  });

  it('重试耗尽后返回失败结果而不是抛错', async () => {    const { engine, calls } = fakeEngine([new EngineError('NETWORK', '一直断网')]);
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

  it('外部 signal 已取消时，引擎收到的是已取消的 signal 且不重试', async () => {
    // 调度器自己不设超时，但取消必须能从 deps.signal 注入：否则后续单元做超时/取消
    // 时只能改 translate 的签名，波及所有调用点。
    const external = new AbortController();
    external.abort();
    const seen: boolean[] = [];
    let calls = 0;
    const engine: Translator = {
      id: 'fake',
      name: 'Fake',
      needsKey: false,
      supportsGlossary: false,
      async translate(request: TranslateRequest): Promise<string[]> {
        calls += 1;
        seen.push(request.signal.aborted);
        throw new EngineError('ABORTED', '请求已取消');
      },
    };

    const out = await translateBatch([{ id: 'a', text: 'A' }], deps(engine, { signal: external.signal }));

    expect(seen).toEqual([true]);
    // ABORTED 不在退避预算里：取消后再重发两次毫无意义。
    expect(calls).toBe(1);
    expect(out[0]).toMatchObject({ id: 'a', text: null, code: 'ABORTED' });
  });

  it('外部 signal 在调用途中取消时会转发给引擎', async () => {
    const external = new AbortController();
    let abortedDuringCall = false;
    const engine: Translator = {
      id: 'fake',
      name: 'Fake',
      needsKey: false,
      supportsGlossary: false,
      async translate(request: TranslateRequest): Promise<string[]> {
        return await new Promise<string[]>((_resolve, reject) => {
          if (request.signal.aborted) {
            abortedDuringCall = true;
            reject(new EngineError('ABORTED', '请求已取消'));
            return;
          }
          request.signal.addEventListener(
            'abort',
            () => {
              abortedDuringCall = true;
              reject(new EngineError('ABORTED', '请求已取消'));
            },
            { once: true },
          );
          // 请求已经在飞的时候外部才取消。
          external.abort();
        });
      },
    };

    const out = await translateBatch([{ id: 'a', text: 'A' }], deps(engine, { signal: external.signal }));

    expect(abortedDuringCall).toBe(true);
    expect(out[0]).toMatchObject({ id: 'a', text: null, code: 'ABORTED' });
  });

  it('纯空白条目原样返回，不被改写成空串', async () => {
    // 内容脚本会把结果写回节点：把 '  \n ' 改成 '' 会清空一个只含空白的节点，
    // 双语模式下的行内排版会跟着变。语义是"没什么可翻，原样保留"。
    const cache = new TranslationCache(new MemoryStorage());
    const { engine, calls } = fakeEngine([['你好']]);
    const out = await translateBatch(
      [
        { id: 'a', text: '  \n ' },
        { id: 'b', text: 'Hello' },
      ],
      deps(engine, { cache }),
    );

    expect(out).toEqual([
      { id: 'a', text: '  \n ' },
      { id: 'b', text: '你好' },
    ]);
    expect(calls).toEqual([['Hello']]);
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
