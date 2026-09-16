/**
 * 样式表读取器（tests/helpers/css.ts）自己的测试。
 *
 * 这个文件存在的理由就是上一轮那次"变异不红"：断言的取值方式不对，删掉真声明也照样绿。
 * 所以这里的第一组用例直接把那次假通过的形状钉下来——注释里写过、别处出现过，都不算数。
 */
import { describe, expect, it } from 'vitest';
import {
  atRuleBody,
  declarationBlock,
  declarations,
  hasRule,
  parseDeclarations,
  stripCssComments,
} from './css';

/** 与 tooltip.ts 的样式表同形：注释里提到 max-height，规则却是空的。 */
const SHEET = `
  :host {
    --jy-surface: rgba(24, 26, 30, 0.97);
  }

  /* 上一轮的假通过就在这里：注释里写着 max-height:40vh、overflow:auto，
     真声明被删掉之后，整表 toContain 仍然满足。 */
  .jy-bubble {
    position: relative;
    border-radius: var(--jy-radius-md);
  }

  .jy-bubble::-webkit-scrollbar {
    width: 8px;
  }
  .jy-bubble::-webkit-scrollbar-thumb {
    border-radius: 999px;
  }
`;

describe('声明块定位：配对花括号 + 选择器完整相等', () => {
  it('注释里的字面量不算声明（上一轮的假通过形状）', () => {
    const box = declarations(SHEET, '.jy-bubble {');
    // 注释里写着 max-height:40vh、overflow:auto，但真声明并不存在。
    expect(box).not.toHaveProperty('max-height');
    expect(box).not.toHaveProperty('overflow');
    expect(box).toEqual({ position: 'relative', 'border-radius': 'var(--jy-radius-md)' });

    // 去掉注释之后，注释里那几个字面量确实一个都不剩。
    expect(stripCssComments(SHEET)).not.toContain('max-height');
    expect(stripCssComments(SHEET)).not.toContain('overflow');
  });

  it('选择器完整相等：`.jy-bubble` 不会串到 `.jy-bubble::-webkit-scrollbar` 上', () => {
    expect(Object.keys(declarations(SHEET, '.jy-bubble {'))).toEqual(['position', 'border-radius']);
    expect(declarations(SHEET, '.jy-bubble::-webkit-scrollbar {')).toEqual({ width: '8px' });
    expect(declarations(SHEET, '.jy-bubble::-webkit-scrollbar-thumb {')).toEqual({
      'border-radius': '999px',
    });
  });

  it('花括号按配对定位：块里嵌了别的块也不会切到第一个 `}`', () => {
    const nested = `.a { color: red; @media (min-width: 1px) { color: blue; } margin: 0; } .b { color: green; }`;
    const a = declarationBlock(nested, '.a {');
    expect(a).toContain('@media (min-width: 1px)');
    expect(a).toContain('margin: 0');
    expect(a).not.toContain('.b');
    // 就声明块本身而言，`.a` 与 `.b` 各取各的（嵌套块留给 CSS 自己，这里不做嵌套级联）。
    expect(declarations(nested, '.a {')['color']).toBe('red');
    expect(declarations(nested, '.b {')['color']).toBe('green');
  });

  it('多行选择器与缩进变化都不影响（选择器按空白归一化比较）', () => {
    expect(declarations(SHEET, '.jy-bubble{')).toEqual(declarations(SHEET, '.jy-bubble {'));
    expect(declarations(SHEET, '  .jy-bubble  {\n')).toEqual(declarations(SHEET, '.jy-bubble {'));
  });

  it('找不到的规则当场抛错，不静默返回空串（否则断言会变成永远成立）', () => {
    expect(() => declarationBlock(SHEET, '.jy-nope {')).toThrow(/没有选择器/);
    expect(hasRule(SHEET, '.jy-nope {')).toBe(false);
    expect(hasRule(SHEET, '.jy-bubble {')).toBe(true);
  });

  it('@keyframes 这类没有普通声明的块用 hasRule 判存在', () => {
    const sheet = '@keyframes jy-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }';
    expect(hasRule(sheet, '@keyframes jy-pulse')).toBe(true);
    expect(hasRule(sheet, '@keyframes jy-nope')).toBe(false);
  });

  it('作用域能区分同名的两条规则（顶层一条、@media 里一条）', () => {
    const sheet = `
      .jy-text { animation: jy-pulse 1.4s; }
      @media (prefers-reduced-motion: reduce) {
        .jy-text { animation: none; }
      }
    `;
    expect(declarations(sheet, '.jy-text {')['animation']).toBe('jy-pulse 1.4s');
    expect(declarations(sheet, '.jy-text {', '@media (prefers-reduced-motion: reduce)')['animation']).toBe('none');
    // 作用域里的 at-rule 也不许把外层的规则当自己人。
    expect(hasRule(sheet, '.jy-text {', '@media print')).toBe(false);
  });
});

describe('声明解析：值里的分号/冒号/引号都不拆坏', () => {
  it('字符串里的分号不是分隔符，冒号只切第一个', () => {
    const body = 'content: "a;b"; background: url(https://x/y.png); font: 13px/1.65 system-ui;';
    expect(parseDeclarations(body)).toEqual({
      content: '"a;b"',
      background: 'url(https://x/y.png)',
      font: '13px/1.65 system-ui',
    });
  });

  it('多行值折叠空白；同一属性后写的覆盖先写的；!important 保留在值里', () => {
    const body = `
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.28),
        0 8px 24px rgba(0, 0, 0, 0.32);
      padding: 1px !important;
      padding: 12px 14px;
      ;
    `;
    const parsed = parseDeclarations(body);
    expect(parsed['box-shadow']).toBe('0 1px 2px rgba(0, 0, 0, 0.28), 0 8px 24px rgba(0, 0, 0, 0.32)');
    expect(parsed['padding']).toBe('12px 14px');
    expect(parseDeclarations('padding: 1px !important;')['padding']).toBe('1px !important');
    expect(parseDeclarations('color: red; color: blue;')['color']).toBe('blue');
  });

  it('atRuleBody 取出 at-rule 的内容；顶层查找不会误穿进 at-rule', () => {
    const sheet = '@media (min-width: 600px) { .a { color: red; } }';
    expect(declarations(atRuleBody(sheet, '@media (min-width: 600px)'), '.a {')).toEqual({ color: 'red' });
    expect(declarations(sheet, '.a {', '@media (min-width: 600px)')).toEqual({ color: 'red' });
    // 不带作用域时只看当前层级：at-rule 里的规则不属于顶层。
    expect(hasRule(sheet, '.a {')).toBe(false);
  });
});
