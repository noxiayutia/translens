// tests/options/rule-pattern.test.ts
/**
 * 站点规则的域名规范化与形状校验（纯函数，无 DOM）。
 *
 * 判据对着**真实的核心匹配语义**写（`src/core/site-rules.ts` 的注释就是规格）：只支持
 * `example.com`（精确）与 `*.example.com`（含裸域与任意层子域）。其余写法核心既不报错
 * 也不会命中——设置页这一侧的责任就是**在写入前**把它们挡住或者规范化掉。
 */
import { describe, expect, it } from 'vitest';
import { normalizeRulePattern } from '../../src/options/rule-pattern';

describe('normalizeRulePattern：能接受的写法', () => {
  it('裸域原样通过（大小写归一化成小写）', () => {
    expect(normalizeRulePattern('example.com')).toEqual({ ok: true, pattern: 'example.com' });
    expect(normalizeRulePattern('  EXAMPLE.COM  ')).toEqual({ ok: true, pattern: 'example.com' });
  });

  it('*. 前缀通配原样通过', () => {
    expect(normalizeRulePattern('*.example.com')).toEqual({ ok: true, pattern: '*.example.com' });
    expect(normalizeRulePattern('*.Example.COM')).toEqual({ ok: true, pattern: '*.example.com' });
  });

  it('整条网址规范化成主机名（路径只有 / 或没有时）', () => {
    expect(normalizeRulePattern('https://example.com')).toEqual({ ok: true, pattern: 'example.com' });
    expect(normalizeRulePattern('https://www.example.com/')).toEqual({ ok: true, pattern: 'www.example.com' });
    expect(normalizeRulePattern('http://localhost:11434/')).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('单标签主机名照收（localhost / 内网短名）：核心按精确匹配，它本来就是有效规则', () => {
    // **已决**：不因为"没有点"就拒绝。核心的 `hostMatchesPattern` 对任何非空 pattern 都做
    // 精确匹配，UI 凭空加这条限制只会让人配不了内网页面；真正该拒的是下面的端口/路径/垃圾输入。
    expect(normalizeRulePattern('localhost')).toEqual({ ok: true, pattern: 'localhost' });
    expect(normalizeRulePattern('*.wiki')).toEqual({ ok: true, pattern: '*.wiki' });
  });

  it('中文域名按 punycode 落地（核心按 ASCII 比对，填中文会静默失效——这里把它接住）', () => {
    expect(normalizeRulePattern('中文.com')).toEqual({ ok: true, pattern: 'xn--fiq228c.com' });
  });
});

describe('normalizeRulePattern：必须拒绝的写法', () => {
  it('空串与纯空白', () => {
    expect(normalizeRulePattern('')).toEqual({ ok: false, reason: '请填写域名' });
    expect(normalizeRulePattern('   ')).toEqual({ ok: false, reason: '请填写域名' });
  });

  it('光杆 * 与 *.（核心匹配器里它们是空模式）', () => {
    expect(normalizeRulePattern('*').ok).toBe(false);
    expect(normalizeRulePattern('*.').ok).toBe(false);
    expect(normalizeRulePattern('*example.com').ok).toBe(false);
  });

  it('带端口的写法：核心按 `example.com:8080` 匹配永远不命中，这里明说', () => {
    const result = normalizeRulePattern('example.com:8080');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('不该通过');
    expect(result.reason).toContain('端口');
  });

  it('带路径的网址：规则是**整个域名**，带路径会让人以为只对那个路径生效', () => {
    const result = normalizeRulePattern('https://example.com/docs/page');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('不该通过');
    expect(result.reason).toContain('路径');
  });

  it('不是域名的东西：空格、纯符号、scheme 后面什么都没有', () => {
    expect(normalizeRulePattern('not a domain').ok).toBe(false);
    expect(normalizeRulePattern('https://').ok).toBe(false);
    expect(normalizeRulePattern('???').ok).toBe(false);
  });

  it('带用户名/密码的网址：那不是"这个站"，是凭据', () => {
    expect(normalizeRulePattern('https://user:pass@example.com/').ok).toBe(false);
  });
});
