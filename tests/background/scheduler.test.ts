import { describe, expect, it } from 'vitest';
import { translateBatch, type BatchDeps } from '../../src/background/scheduler';
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
});
