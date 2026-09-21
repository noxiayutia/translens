import { describe, expect, it } from 'vitest';
import { buildCacheKey, hashString } from '../../src/core/hash';

describe('hashString', () => {
  it('同样的输入得到同样的输出', () => {
    expect(hashString('hello world')).toBe(hashString('hello world'));
  });

  it('不同输入得到不同输出', () => {
    expect(hashString('hello')).not.toBe(hashString('hellp'));
  });

  it('能处理空字符串', () => {
    expect(hashString('')).toMatch(/^0-[0-9a-z]+-[0-9a-z]+$/);
  });

  it('能处理中文与 emoji', () => {
    expect(hashString('你好🌏')).toBe(hashString('你好🌏'));
    expect(hashString('你好🌏')).not.toBe(hashString('你好🌍'));
  });
});

describe('buildCacheKey', () => {
  const base = {
    engineId: 'p-a',
    configHash: 'cfg-openai-gpt-4o-mini',
    sourceLang: 'auto',
    targetLang: 'zh-Hans',
    glossaryHash: '',
    promptHash: '',
    text: 'Hello world',
  };

  it('同样的字段得到同样的 key', () => {
    expect(buildCacheKey(base)).toBe(buildCacheKey({ ...base }));
  });

  it('任一字段变化都会改变 key', () => {
    const key = buildCacheKey(base);
    expect(buildCacheKey({ ...base, text: 'Hello world!' })).not.toBe(key);
    expect(buildCacheKey({ ...base, engineId: 'p-b' })).not.toBe(key);
    expect(buildCacheKey({ ...base, targetLang: 'ja' })).not.toBe(key);
    expect(buildCacheKey({ ...base, glossaryHash: 'abc' })).not.toBe(key);
    expect(buildCacheKey({ ...base, promptHash: 'abc' })).not.toBe(key);
    expect(buildCacheKey({ ...base, configHash: 'cfg-openai-gpt-4o' })).not.toBe(key);
  });

  /**
   * 源语言是设置项、会一路传到 `TranslateRequest.from`，不参与 key 就会命中按另一种
   * 源语言语义翻出来的旧译文（今天两个引擎都还没读 `from`，所以这条是防御性的：
   * 等接上就用错语义，而且事后无法自愈）。
   */
  it('源语言变化会改变 key', () => {
    const key = buildCacheKey(base);
    expect(buildCacheKey({ ...base, sourceLang: 'en' })).not.toBe(key);
    expect(buildCacheKey({ ...base, sourceLang: 'ja' })).not.toBe(key);
    // 'auto' 与具体语言是两种语义，不能共用 key。
    expect(buildCacheKey({ ...base, sourceLang: 'zh-Hans' })).not.toBe(key);
  });
});
