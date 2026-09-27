import { describe, expect, it } from 'vitest';
import { openAiCompatEngine } from '../../src/engines/openai-compat';
import { ENGINES, getEngine, kindNeedsModel } from '../../src/engines/registry';

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

/**
 * 单元 F 第 1 步：契约层加 `needsModel`。
 *
 * 它是**适配器契约**（与 `needsKey` / `supportsGlossary` 同一类），不是"以后可能用得上"的字段：
 * 第 2 步的 `resolveEngine` 就靠它决定"档案没有当前模型算不算错误"。
 *
 * ⚠ 本批**故意不写** `kindNeedsModel('azure-translator') === false`——那个适配器还没注册进来
 * （§10 第 4 步，卡在凭据闸之后）。现在就写等于让它去查一个不存在的 id，只能靠 `?? true`
 * 或硬编码蒙对，那是没有牙的断言（规格 §9.3）。它已记在规格 §12 的欠账清单里。
 */
describe('kindNeedsModel（单元 F 第 1 步）', () => {
  /** 牙：把 `openAiCompatEngine.needsModel` 删掉或改成 false，这条当场红。 */
  it('OpenAI 兼容适配器要模型', () => {
    expect(openAiCompatEngine.needsModel).toBe(true);
  });

  it('注册表里查得到的类型按它自己的契约回答', () => {
    expect(kindNeedsModel('openai-compat')).toBe(true);
  });

  /**
   * 认不出的类型按"要模型"处理——**保守方向**：它不会被 `firstUsableProfileId` 选中，
   * 也不会因为"没有模型"被放行。
   *
   * 牙：把兜底从 `?? true` 改成 `?? false`（或改成 `Boolean(getEngine(kind))` 之类的反向写法），
   * 这条红。而"能不能翻"看不出差别——差别只在一份本版本不认识的档案会不会被当成可用。
   */
  it('认不出的类型按"要模型"处理（保守：不会被判成可用）', () => {
    expect(kindNeedsModel('未来版本的类型')).toBe(true);
    expect(kindNeedsModel('')).toBe(true);
  });
});
