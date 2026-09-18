import { describe, expect, it } from 'vitest';
import { isNeverTranslate, matchSiteRule } from '../../src/core/site-rules';

/** 只关心 pattern/action 两个字段，用最小形状构造，避免与设置层耦合。 */
function rule(pattern: string, action: 'translate' | 'never') {
  return { pattern, action };
}

/**
 * 匹配内核 `hostMatchesPattern` 是模块私有的：它的一切行为只能经 `matchSiteRule` 观察。
 * 下面各组保留原计划给它的**全部**输入与判定（逐条对应，布尔断言换成 `not.toBeNull()` /
 * `toBeNull()`，一条不减、不放宽）。
 *
 * 走公开入口的结构性红利：凡是"模式与主机名长得不一样"的用例（通配、子域、尾点……），
 * 内部实参一旦对调，host 与 pattern 会立刻互相解释错误、当场变红——
 * 若直测私有函数，精确匹配那组里两实参恒等，对调变异根本打不到。
 */
describe('matchSiteRule：主机名匹配语义', () => {
  it('精确匹配只认裸域本身，不带上子域', () => {
    expect(matchSiteRule([rule('example.com', 'never')], 'example.com')).not.toBeNull();
    expect(matchSiteRule([rule('example.com', 'never')], 'www.example.com')).toBeNull();
  });

  it('*. 前缀通配同时匹配裸域与任意层子域', () => {
    expect(matchSiteRule([rule('*.example.com', 'never')], 'example.com')).not.toBeNull();
    expect(matchSiteRule([rule('*.example.com', 'never')], 'www.example.com')).not.toBeNull();
    expect(matchSiteRule([rule('*.example.com', 'never')], 'a.b.example.com')).not.toBeNull();
  });

  it('后缀相似不算命中（这是最容易写错的一类）', () => {
    expect(matchSiteRule([rule('*.example.com', 'never')], 'notexample.com')).toBeNull();
    expect(matchSiteRule([rule('*.example.com', 'never')], 'example.com.evil.io')).toBeNull();
    expect(matchSiteRule([rule('example.com', 'never')], 'example.com.evil.io')).toBeNull();
  });

  it('大小写与首尾空白不参与判定（主机名侧大写 + 模式侧空白）', () => {
    expect(matchSiteRule([rule(' *.example.com ', 'never')], 'WWW.Example.COM')).not.toBeNull();
  });

  it('另一半同样要防：模式侧大写 + 主机名侧空白（pickSiteRules 对 pattern 原样入库）', () => {
    expect(matchSiteRule([rule('*.EXAMPLE.COM', 'never')], 'www.example.com')).not.toBeNull();
    expect(matchSiteRule([rule('*.example.com', 'never')], ' www.example.com ')).not.toBeNull();
  });

  it('空主机名 / 空模式 / 光杆 *. 一律不匹配', () => {
    expect(matchSiteRule([rule('example.com', 'never')], '')).toBeNull();
    expect(matchSiteRule([rule('', 'never')], 'example.com')).toBeNull();
    expect(matchSiteRule([rule('*.', 'never')], 'example.com')).toBeNull();
    expect(matchSiteRule([rule('', 'never')], '')).toBeNull();
  });

  it('光杆 *. 的杀伤面是尾点 FQDN——「example.com.」也不许命中（删守卫的见证用例）', () => {
    // 上一条里 `rule('*.') × 'example.com'` 无论有没有 `suffix === ''` 守卫都返回不命中，
    // 它钉得住"光杆写法不匹配常规主机名"这个语义，但**杀不死删守卫的变异体**。
    // 真正能见证守卫存在的输入只有以点结尾的主机名（`new URL` 会保留尾点，是真实形态）。
    expect(matchSiteRule([rule('*.', 'never')], 'example.com.')).toBeNull();
    // 对照组：去掉守卫后 `*.` 能命中的也只有上面那种输入，**不是**旧注释误称的"全站"；
    // 子域在有无守卫时都不命中（host.endsWith('.') 为假），这里钉住现状。
    expect(matchSiteRule([rule('*.', 'never')], 'www.example.com')).toBeNull();
    expect(matchSiteRule([rule('*.', 'never')], 'example.com')).toBeNull();
  });

  it('自上而下首条命中即生效，顺序就是优先级', () => {
    const rules = [rule('example.com', 'never'), rule('example.com', 'translate')];
    expect(matchSiteRule(rules, 'example.com')).toBe(rules[0]);
  });

  it('命中的是第二条就返回第二条：通配 × 非首位 × 主机名≠模式（Task 3 按对象身份解除的前提）', () => {
    const rules = [rule('other.com', 'never'), rule('*.example.com', 'translate')];
    expect(matchSiteRule(rules, 'www.example.com')).toBe(rules[1]);
  });

  it('没有任何规则命中时返回 null', () => {
    expect(matchSiteRule([rule('other.com', 'never')], 'example.com')).toBeNull();
    expect(matchSiteRule([], 'example.com')).toBeNull();
  });
});

describe('isNeverTranslate', () => {
  it('只有命中且动作是 never 才为真', () => {
    expect(isNeverTranslate([rule('example.com', 'never')], 'example.com')).toBe(true);
    expect(isNeverTranslate([rule('example.com', 'translate')], 'example.com')).toBe(false);
    expect(isNeverTranslate([], 'example.com')).toBe(false);
  });

  it('同域多条规则按首条命中定性，不是 any-never', () => {
    // pickSiteRules 不去重、不排序，`[translate, never]` 同 pattern 今天就能出现在脏存储里。
    // 整条换成 `rules.some(...)` 必须在第一条变红——两种语义在这里结果相反。
    expect(
      isNeverTranslate([rule('example.com', 'translate'), rule('example.com', 'never')], 'example.com'),
    ).toBe(false);
    expect(
      isNeverTranslate([rule('*.example.com', 'translate'), rule('www.example.com', 'never')], 'www.example.com'),
    ).toBe(false);
    expect(
      isNeverTranslate([rule('*.example.com', 'never'), rule('other.com', 'translate')], 'www.example.com'),
    ).toBe(true);
  });
});
