import { describe, expect, it } from 'vitest';
import { ENGINES, getEngine } from '../../src/engines/registry';

describe('getEngine', () => {
  it('按 id 取到引擎', () => {
    expect(getEngine('openai-compat')?.id).toBe('openai-compat');
  });

  /**
   * 这条钉的是本单元**推翻的那个设计判断**：旧实现「未知 id 一律回退到默认引擎」让设置里存了
   * 废弃 id 时插件**照样能翻**（安静地用免费接口）。新语义是「没有可用引擎」：交回 `null`，
   * 由 `resolveEngine` 翻成一句可行动的话 + 零请求。
   *
   * **牙在哪**：把 `getEngine` 改回任何形式的兜底（`?? openAiCompatEngine` / `ENGINES[0]`），
   * 这条当场红。而"能不能翻"是看不出来的——兜底恰恰让它"还能翻"。
   */
  it('未知 id 返回 null：不再回落到任何引擎', () => {
    expect(getEngine('不存在的引擎')).toBeNull();
    // 残留的免费引擎 id 也只是"一个不存在的 id"，没有任何特例（不写 `if (id === 'google')` 的补丁）。
    expect(getEngine('google')).toBeNull();
  });

  /**
   * 这条钉的是「引擎列表被删到一个」**这件事本身**：有人把 `google.ts` 加回来、或把 `ENGINES`
   * 写成多成员，它当场红。比旧用例的「恰好这两个」更硬——现在是「恰好唯一的那一个」。
   */
  it('注册表恰好只剩唯一一个适配器', () => {
    expect(ENGINES.map((e) => e.id)).toEqual(['openai-compat']);
  });

  it('唯一适配器需要 Key', () => {
    expect(getEngine('openai-compat')?.needsKey).toBe(true);
  });
});
