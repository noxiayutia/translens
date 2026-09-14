import { describe, expect, it } from 'vitest';
import { ENGINES, getEngine } from '../../src/engines/registry';

describe('getEngine', () => {
  it('按 id 取到引擎', () => {
    expect(getEngine('openai-compat').id).toBe('openai-compat');
  });

  it('未知 id 回退到默认免费引擎', () => {
    expect(getEngine('不存在的引擎').id).toBe('google');
  });

  it('注册表包含免费引擎与自定义引擎', () => {
    expect(ENGINES.map((e) => e.id).sort()).toEqual(['google', 'openai-compat']);
  });

  it('免费引擎不需要 Key，自定义引擎需要', () => {
    expect(getEngine('google').needsKey).toBe(false);
    expect(getEngine('openai-compat').needsKey).toBe(true);
  });
});
