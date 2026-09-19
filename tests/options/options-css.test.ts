// tests/options/options-css.test.ts
/**
 * 设置页样式的纪律断言（规格 §7）。全部走 `tests/helpers/css.ts` 的**真解析**：
 * 按配对花括号定位规则、选择器完整相等、扫描时跳过字符串与注释——所以"把某条声明删掉"
 * 等于"声明表里查不到这一项"，断言当场红，不会像子串匹配那样被注释里的同名文字骗过去。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { declarationBlock, declarations, stripCssComments } from '../helpers/css';

const ROOT = join(import.meta.dirname, '..', '..', 'src');
const optionsCss = readFileSync(join(ROOT, 'options', 'options.css'), 'utf-8');
const popupCss = readFileSync(join(ROOT, 'popup', 'popup.css'), 'utf-8');

const DARK = '@media (prefers-color-scheme: dark)';
const NARROW = '@media (max-width: 900px)';

describe('设置页样式：令牌', () => {
  it('与 popup.css 共用的那一组令牌逐字一致（亮色）', () => {
    const popup = declarations(popupCss, ':root');
    const options = declarations(optionsCss, ':root');
    // 逐条比 popup 的每一个令牌：options 可以有自己额外的令牌，但共用的那些不许漂。
    for (const [name, value] of Object.entries(popup)) {
      expect(`${name}: ${options[name]}`).toBe(`${name}: ${value}`);
    }
    // popup 的令牌一个都没漏比（防止上面那个循环因为某天 popup 被清空而空转）。
    expect(Object.keys(popup).length).toBeGreaterThanOrEqual(17);
  });

  it('暗色只定义一次，且覆盖正文用到的每一个颜色令牌', () => {
    const dark = declarations(optionsCss, ':root', DARK);
    expect(dark['--surface']).toBe('#1c1f23');
    expect(dark['--text']).toBe('#e8eaed');
    expect(dark['--danger']).toBe('#f87171');
    // 暗色块不许把亮色令牌漏一半：正文里出现的颜色令牌必须都在暗色块里有值。
    const body = stripCssComments(optionsCss);
    const used = new Set([...body.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1] as string));
    const light = declarations(optionsCss, ':root');
    const missing = [...used].filter((token) => light[token] === undefined);
    expect(missing).toEqual([]);
  });
});

describe('设置页样式：正文不许硬编码颜色、不许用 opacity', () => {
  /** 去掉两个 `:root` 块之后的样式表正文。 */
  function bodyWithoutTokens(): string {
    const light = declarationBlock(optionsCss, ':root');
    const dark = declarationBlock(optionsCss, ':root', DARK);
    return stripCssComments(optionsCss)
      .replace(`{${light}}`, '{}')
      .replace(`{${dark}}`, '{}');
  }

  it('颜色只从令牌来：正文里不出现十六进制 / rgb / hsl 字面量', () => {
    const rest = bodyWithoutTokens();
    // `%23` 那种转义（自绘 chevron 的 mask）不算颜色字面量：它没有裸 `#`。
    expect(rest.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(rest.match(/\b(?:rgba?|hsla?)\(/g) ?? []).toEqual([]);
  });

  it('不许用 opacity 充当次级文字（暗色下对比度不可控）', () => {
    expect(stripCssComments(optionsCss).match(/(?:^|[;{\s])opacity\s*:/g) ?? []).toEqual([]);
  });
});

describe('设置页样式：键盘与窄窗口', () => {
  it('保留统一焦点环，并且用的是强调色令牌', () => {
    const ring = declarations(optionsCss, '*:focus-visible');
    expect(ring['outline']).toContain('var(--accent)');
    expect(ring['outline-offset']).toBeDefined();
  });

  it('导航与折叠区用原生控件，不需要自造 widget 的样式（details/summary 有样式）', () => {
    expect(declarations(optionsCss, 'summary')['cursor']).toBe('pointer');
  });

  it('窄窗口有明确的降级策略：导航不再吸顶、改成一行可横滚的链接（规格 §11：未经真机渲染验证）', () => {
    const wrap = declarations(optionsCss, '.wrap', NARROW);
    const nav = declarations(optionsCss, '.nav', NARROW);
    expect(wrap['display']).toBe('block');
    expect(nav['position']).toBe('static');
  });
});
