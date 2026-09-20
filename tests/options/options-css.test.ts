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
    // 暗色块不许把亮色令牌漏一半：正文里出现的**颜色**令牌必须都在暗色块里有值。
    //
    // 查的必须是 `dark`，不能是 `light`：按设计每个正文令牌在亮色 `:root` 里都有值，
    // 拿 `light` 去查 `used` 的话 `missing` **恒为 `[]`**——实测把暗色块里 8 个彩色令牌
    // 一次删光，7 条断言照样全绿。
    const body = stripCssComments(optionsCss);
    const used = new Set([...body.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1] as string));
    const light = declarations(optionsCss, ':root');
    // 下面这组是"**不是颜色**、因此不该在暗色块里重复定义"的令牌（少列一个就是一条假红）。
    // 口径选的是"列例外"而不是"列颜色白名单"：白名单写不全会**静默漏掉**真正该抓的令牌
    // （假绿，正是这条断言原本的病），列例外写不全会**响**（假红，当场就能看见并补上）。
    // 两个方向都往严格一侧失败，但只有假红是安全的失败方向。
    //
    // `--border*` 故意**不**列进来：它们**是**颜色，且暗色块里确实各有自己的同名值
    // （`rgba(255, 255, 255, …)`）——所以它们会被正常检查，不需要豁免。
    const NOT_A_COLOR = new Set([
      '--radius-sm',
      '--radius-md',
      '--radius-pill',
      '--shadow-card',
      // 强调色上的文字色，亮/暗都是 `#ffffff`：暗色下强调色仍是深蓝，白字照样可读。
      // 这是设计上有据可查的例外，不是漏定义。
      '--on-accent',
    ]);
    const darkMissing = [...used].filter(
      (token) => light[token] !== undefined && dark[token] === undefined && !NOT_A_COLOR.has(token),
    );
    expect(darkMissing).toEqual([]);
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

  it('`hidden` 有强制规则兜底：导航项是 flex，没有它就藏不住（搜索全靠这个属性）', () => {
    // jsdom 没有布局，`element.hidden = true` 在测试里永远"看起来生效"——真正的显隐
    // 靠这条 CSS。删掉它，搜索结果在真机上会「全都显示、只是变了颜色」。
    expect(declarations(optionsCss, '[hidden]')['display']).toBe('none !important');
  });
});
