## Task 13: `background/scheduler.ts` — 单批次缓存/引擎/重试

**Files:**
- Create: `src/background/scheduler.ts`
- Test: `tests/background/scheduler.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/background/scheduler.test.ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/background/scheduler.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/background/scheduler.ts
import { buildCacheKey, hashString } from '../core/hash';
import { joinPieces, splitBySentence } from '../core/segmenter';
import {
  EngineError,
  RETRYABLE_CODES,
  toEngineError,
  type EngineConfig,
  type Term,
  type Translator,
} from '../engines/types';
import type { TranslateItem, TranslateItemResult } from '../shared/messages';

/**
 * 批次用到的缓存子集。实现允许抛错也允许不抛错：`translateBatch` 两种都兜得住
 * （读失败当未命中、写失败当没缓存上），不把缓存异常抛给调用方。
 * 生产实现 `core/cache.ts` 不抛错，见那里的不变量 3。
 */
export interface CacheLike {
  getMany(keys: string[]): Promise<Map<string, string>>;
  putMany(items: Map<string, string>): Promise<void>;
}

export interface BatchDeps {
  engine: Translator;
  engineConfig: EngineConfig;
  sourceLang: string;
  targetLang: string;
  glossary?: Term[];
  systemPrompt?: string;
  cache: CacheLike;
  /**
   * 外部取消信号。调度器自己不设超时（超时归 content script，见 `callEngine`），
   * 但必须留一个能把取消注入引擎的入口：一旦它 abort，引擎收到的 signal 也跟着 abort。
   */
  signal?: AbortSignal;
  /** 测试可注入假定时器；默认真实等待 */
  sleep?: (ms: number) => Promise<void>;
}

/** 退避预算（规格 §8）：网络错误 / 超时退避 500ms → 1500ms 两次。 */
const BACKOFF_MS = [500, 1500];

/** 二次切分的阈值下限：切点只允许落在句子边界，见 `splitBySentence`。 */
const SPLIT_MIN_LEN = 200;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function callEngine(texts: string[], deps: BatchDeps): Promise<string[]> {
  // signal 是 TranslateRequest 的必填字段，两个引擎都真的用了它（fetch 的 signal、
  // 以及拿到响应后再查一次 aborted）。外部取消经 deps.signal 注入；调度器自身不设超时：
  // 设计规格把超时归给 content script（§8「content script 侧对请求加超时」），
  // 那个超时由 WU7 落地。这里给一个假超时反而会掐掉合法的大批次。
  const controller = new AbortController();
  if (deps.signal?.aborted) controller.abort();
  else deps.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  const translations = await deps.engine.translate(
    {
      texts,
      from: deps.sourceLang,
      to: deps.targetLang,
      glossary: deps.glossary,
      systemPrompt: deps.systemPrompt,
      signal: controller.signal,
    },
    deps.engineConfig,
  );
  if (!Array.isArray(translations) || translations.length !== texts.length) {
    throw new EngineError('BAD_RESPONSE', '引擎返回的条目数与请求不一致');
  }
  return translations;
}

/**
 * 一次引擎调用加它应得的退避重试（规格 §8：网络错误 / 超时退避 500ms → 1500ms 两次）。
 *
 * 边界：批量重试是最后手段，条目级的抖动由引擎内部吸收（见 `engines/google.ts` 的
 * `translateOneWithRetry`）。调度器只看得到「整批成功 / 整批失败」，一次调用摊成的
 * N 个请求里任意一个抖动都会让整批失败，所以引擎必须先按条目重试；否则 12 条批次里
 * 第 11 条抖一次就会实打实发出 24 条文本，免费接口的 429 还会把「抖动 → 整批重发 →
 * 限流 → 再整批重发」接成正反馈。
 *
 * 残留风险：某一条连续失败（超出引擎的条目重试预算）时，这里仍会把整批重发一次；
 * 已经成功的那几条也白翻一遍。彻底消除要等引擎能把「逐条成败」上报给调度器。
 *
 * 降级路径（切分、逐条）也必须走这里。它们把一次请求摊成 N 次，撞上瞬时抖动的概率
 * 本就比整批请求高；少了这层重试，第 11 次调用的一次抖动会让整批 12 条一起报错。
 *
 * 只重试瞬时错误（见 `RETRYABLE_CODES`）：`BAD_RESPONSE` 重试同一个输入没有意义，
 * 它是调用方决定降级还是上报的依据；`TOO_LONG` 该降到切分路径，重问一次必然还是过长。
 * 判据只有 `RETRYABLE_CODES` 一份（`engines/types`），调度器不再自带一套集合——
 * 两处各写一份时「`TOO_LONG` 算不算可重试」会随改动漂移。
 */
async function callEngineWithRetry(texts: string[], deps: BatchDeps): Promise<string[]> {
  const sleep = deps.sleep ?? defaultSleep;
  let last: EngineError | undefined;

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
    try {
      return await callEngine(texts, deps);
    } catch (raw) {
      const error = toEngineError(raw);
      last = error;

      if (!RETRYABLE_CODES.has(error.code)) throw error;

      if (attempt < BACKOFF_MS.length) await sleep(BACKOFF_MS[attempt]);
    }
  }
  throw last ?? new EngineError('UNKNOWN', '未知错误');
}

/**
 * 引擎报文本过长时，把每条按句子切开分别翻译，再拼回一段。
 *
 * 与 `translateOneByOne` 同形：逐条 try/catch，某条（或它切出的某一片）失败只把该条的
 * `EngineError` 放进对应位置。整批抛出会让 `translateBatch` 把所有 missing 条目标成
 * 同一个错误码——a 明明已经切分翻好了，却因为 b 的 AUTH 被连坐，连缓存都进不去。
 */
async function translateSplit(
  texts: string[],
  deps: BatchDeps,
): Promise<Array<string | EngineError>> {
  const out: Array<string | EngineError> = [];
  for (const text of texts) {
    try {
      const pieces = splitBySentence(text, Math.max(SPLIT_MIN_LEN, Math.ceil(text.length / 2)));
      const translated = await callEngineWithRetry(pieces, deps);
      out.push(joinPieces(translated, deps.targetLang));
    } catch (raw) {
      out.push(toEngineError(raw));
    }
  }
  return out;
}

/**
 * 模型没按编号返回时，退回逐条翻译，牺牲速度换正确性。
 *
 * 返回与 texts 等长的结果数组，而不是只成功时返回：某一条失败不该把前面已经翻好的
 * 条目一起丢掉。调用方拿到成功项照常上报与写缓存，只把失败的下标标成错误。
 */
async function translateOneByOne(
  texts: string[],
  deps: BatchDeps,
): Promise<Array<string | EngineError>> {
  const out: Array<string | EngineError> = [];
  for (const text of texts) {
    try {
      const single = await callEngineWithRetry([text], deps);
      out.push(single[0]);
    } catch (raw) {
      out.push(toEngineError(raw));
    }
  }
  return out;
}

/** 正常结果与逐条降级的半成品都从这里出来，后者见 `translateOneByOne`。 */
async function translateWithFallback(
  texts: string[],
  deps: BatchDeps,
): Promise<Array<string | EngineError>> {
  try {
    return await callEngineWithRetry(texts, deps);
  } catch (raw) {
    const error = toEngineError(raw);

    if (error.code === 'TOO_LONG') return translateSplit(texts, deps);
    // 只有一条时没有可退的地方：再拿同一个 [text] 问一次 BAD_RESPONSE，只会无限打转。
    if (error.code === 'BAD_RESPONSE' && texts.length > 1) return translateOneByOne(texts, deps);

    throw error;
  }
}

/**
 * 处理一个批次：缓存命中直接返回，未命中的合并成一次引擎请求。
 * 任何失败都转成携带错误码的结果项，绝不抛错——内容脚本据此渲染"重试"按钮。
 * 缓存读写失败不在此列：那不是"这次翻译失败"，降级即可（读当未命中、写当没缓存上）。
 */
export async function translateBatch(items: TranslateItem[], deps: BatchDeps): Promise<TranslateItemResult[]> {
  const results: TranslateItemResult[] = items.map((item) => ({ id: item.id, text: null }));
  if (items.length === 0) return results;

  const glossaryHash = hashString(JSON.stringify(deps.glossary ?? []));
  const promptHash = hashString(deps.systemPrompt ?? '');
  const configHash = hashString(
    JSON.stringify({ baseUrl: deps.engineConfig.baseUrl ?? '', model: deps.engineConfig.model ?? '' }),
  );
  const keys = items.map((item) =>
    buildCacheKey({
      engineId: deps.engine.id,
      configHash,
      targetLang: deps.targetLang,
      glossaryHash,
      promptHash,
      text: item.text,
    }),
  );

  // CacheLike 是鸭子类型接口，读失败由实现自行决定抛不抛；这里自己兜住，
  // 最坏只是把命中的条目也当成未命中重翻一遍，好过把异常抛出 translateBatch。
  let cached: Map<string, string>;
  try {
    cached = await deps.cache.getMany(keys);
  } catch {
    cached = new Map();
  }
  const missing: number[] = [];
  items.forEach((item, index) => {
    // 空文本不进引擎也不进缓存：'' 写进缓存与"翻成了空"无法区分，发给引擎也只是
    // 白发一次请求。但空白条目要原样返回：把 '  \n ' 改写成 '' 会让内容脚本清空一个
    // 只含空白的节点，双语模式下的行内排版会跟着变，而这里本来"没什么可翻"。
    if (item.text.trim() === '') {
      results[index] = { id: item.id, text: item.text };
      return;
    }
    const hit = cached.get(keys[index]);
    if (hit === undefined) missing.push(index);
    else results[index] = { id: item.id, text: hit };
  });
  if (missing.length === 0) return results;

  // 待写缓存的条目：声明在 try 之外，因为写入发生在 try/catch 之后（见下方注释）。
  const toCache = new Map<string, string>();
  /**
   * 落一条结果，返回它是否算失败。
   *
   * 类型守卫写在这里，是因为 `translateOneByOne` 的半成品用 `string | EngineError`
   * 表达逐条成败；这个判断同时承担 TS 的类型收窄和"成功才进缓存"的语义。
   */
  const settle = (index: number, translation: string | EngineError): boolean => {
    if (translation instanceof EngineError) {
      results[index] = {
        id: items[index].id,
        text: null,
        code: translation.code,
        message: translation.message,
      };
      return true;
    }
    results[index] = { id: items[index].id, text: translation };
    toCache.set(keys[index], translation);
    return false;
  };

  try {
    const translations = await translateWithFallback(
      missing.map((index) => items[index].text),
      deps,
    );
    // 逐条降级的半成品：逐条上报，别把已经翻好的条目一起丢掉，也别给它们安上
    // 邻居的错误码。成功的那几条照常进缓存，用户点重试时只需再翻失败的那几条。
    missing.forEach((index, offset) => void settle(index, translations[offset]));
  } catch (raw) {
    const error = toEngineError(raw);
    for (const index of missing) settle(index, error);
  }

  // 写缓存放在引擎 try 之外：缓存写失败只意味着这次没缓存上，
  // 放进同一个 try 会把"翻译成功但没缓存上"上报成整批失败，给用户一个错误的重试按钮。
  // 因此这里单独兜住异常——CacheLike 是鸭子类型接口，不能假定实现不抛错，
  // 而 translateBatch 的对外契约是绝不抛错。
  try {
    await deps.cache.putMany(toCache);
  } catch {
    // 没写进缓存，下次再翻一遍即可；本轮的译文结果依然有效。
  }

  return results;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/background/scheduler.test.ts`

Expected: PASS，11 个用例全绿。

- [ ] **Step 5: 提交**

```bash
git add src/background/scheduler.ts tests/background/scheduler.test.ts
git commit -m "feat(background): 单批次缓存、引擎调用与重试降级"
```

---
