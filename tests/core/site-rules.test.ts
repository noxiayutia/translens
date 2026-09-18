import { describe, expect, it } from 'vitest';
import { hostMatchesPattern, isNeverTranslate, matchSiteRule } from '../../src/core/site-rules';

/** 只关心 pattern/action 两个字段，用最小形状构造，避免与设置层耦合。 */
function rule(pattern: string, action: 'translate' | 'never') {
  return { pattern, action } as const;
}

describe('hostMatchesPattern', () => {
  it('精确匹配只认裸域本身，不带上子域', () => {
    expect(hostMatchesPattern('example.com', 'example.com')).toBe(true);
    expect(hostMatchesPattern('www.example.com', 'example.com')).toBe(false);
  });

  it('*. 前缀通配同时匹配裸域与任意层子域', () => {
    expect(hostMatchesPattern('example.com', '*.example.com')).toBe(true);
    expect(hostMatchesPattern('www.example.com', '*.example.com')).toBe(true);
    expect(hostMatchesPattern('a.b.example.com', '*.example.com')).toBe(true);
  });

  it('后缀相似不算命中（这是最容易写错的一类）', () => {
    expect(hostMatchesPattern('notexample.com', '*.example.com')).toBe(false);
    expect(hostMatchesPattern('example.com.evil.io', '*.example.com')).toBe(false);
    expect(hostMatchesPattern('example.com.evil.io', 'example.com')).toBe(false);
  });

  it('大小写与首尾空白不参与判定', () => {
    expect(hostMatchesPattern('WWW.Example.COM', ' *.example.com ')).toBe(true);
  });

  it('空主机名 / 空模式 / 光杆 *. 一律不匹配', () => {
    expect(hostMatchesPattern('', 'example.com')).toBe(false);
    expect(hostMatchesPattern('example.com', '')).toBe(false);
    expect(hostMatchesPattern('example.com', '*.')).toBe(false);
    expect(hostMatchesPattern('', '')).toBe(false);
  });
});

describe('matchSiteRule', () => {
  it('自上而下首条命中即生效，顺序就是优先级', () => {
    const rules = [rule('example.com', 'never'), rule('example.com', 'translate')];
    expect(matchSiteRule(rules, 'example.com')).toBe(rules[0]);
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
});
