// tests/options/options-css.test.ts
/**
 * 设置页样式的纪律断言（规格 §7）。全部走 `tests/helpers/css.ts` 的**真解析**：
 * 按配对花括号定位规则、选择器完整相等、扫描时跳过字符串与注释——所以"把某条声明删掉"
 * 等于"声明表里查不到这一项"，断言当场红，不会像子串匹配那样被注释里的同名文字骗过去。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { declarationBlock, declarations, hasRule, stripCssComments } from '../helpers/css';

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
    expect(dark['--surface']).toBe('#1e1c19');
    expect(dark['--text']).toBe('#f2efe6');
    expect(dark['--danger']).toBe('#ff453a');
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
      '--radius-card',
      '--radius-pill',
      '--ease',
      '--dur',
      '--shadow-card',
      // 开关旋钮：亮/暗都是 `#ffffff`（规格 §3.1）。iOS 的白钮在暗色下依然对——
      // 底下是 `--track-off`/`--ok`，不是深色文字底。
      // （`--on-accent` 以前也走这条例外——亮暗都是白。换品牌色板后它**真的**分亮暗了：
      // 亮色是碳黑底上的象牙字，暗色反转为象牙底上的碳黑字，所以它必须进暗色块。）
      '--knob',
    ]);
    const darkMissing = [...used].filter(
      (token) => light[token] !== undefined && dark[token] === undefined && !NOT_A_COLOR.has(token),
    );
    expect(darkMissing).toEqual([]);
  });

  it('对比度纪律：--ok/--danger 只出现在非文字属性上，绿/红文字一律走 --ok-text/--danger-text（规格 §7.8）', () => {
    const body = stripCssComments(optionsCss);
    // 正文里任何 `color:` 拿 `--ok`/`--danger` 都是不可读的亮绿/亮红文字（#34c759 白底约 2.2:1）。
    // 背景（状态点、开关轨道）不受此限——它们本来就该用 iOS 亮色。
    // 正则带 `^|[;{\s]` 边界：`background-color:` 之类不会被误伤，注释已由 stripCssComments 排除。
    expect(body.match(/(?:^|[;{\s])color:\s*var\(--ok\)/g) ?? []).toEqual([]);
    expect(body.match(/(?:^|[;{\s])color:\s*var\(--danger\)/g) ?? []).toEqual([]);
    // 四处已核实的文字用法必须指向文字令牌（popup.css 的 `.hint.warn` 是第四处）。
    expect(declarations(optionsCss, '.status[data-kind="ok"]')['color']).toBe('var(--ok-text)');
    expect(declarations(optionsCss, '.status[data-kind="err"]')['color']).toBe('var(--danger-text)');
    expect(declarations(optionsCss, '.link-danger')['color']).toBe('var(--danger-text)');
    expect(declarations(popupCss, '.hint.warn')['color']).toBe('var(--danger-text)');
    // 硬币的另一半：点与开关的背景仍用 --ok/--danger——迁移它们就是把 2.2:1 换成 4.5:1 再换回去。
    expect(declarations(optionsCss, '.dot[data-state="ok"]')['background']).toBe('var(--ok)');
    expect(declarations(optionsCss, '.dot[data-state="bad"]')['background']).toBe('var(--danger)');
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

describe('设置页样式：D2 控件层', () => {
  it('按钮体系：主按钮药丸+--accent、次级是赤褐链接 --link、危险链接悬停用 color-mix（样机映射）', () => {
    // 合并规则按解析器语义整体点名（选择器必须完整相等），这正是它比子串匹配强的地方。
    const shell = declarations(optionsCss, '.primary, .ghost');
    expect(shell['border-radius']).toBe('var(--radius-pill)');
    expect(shell['height']).toBeUndefined(); // 高度回到内容盒（样机 padding 撑高），旧 34px 必须已删
    const primary = declarations(optionsCss, '.primary');
    expect(primary['background']).toBe('var(--accent)');
    expect(primary['color']).toBe('var(--on-accent)');
    expect(primary['padding']).toBe('7px 17px');
    expect(declarations(optionsCss, '.primary:hover')['background']).toBe('var(--accent-hover)');
    const ghost = declarations(optionsCss, '.ghost');
    expect(ghost['color']).toBe('var(--link)');
    expect(ghost['background']).toBe('transparent');
    expect(declarations(optionsCss, '.ghost:hover')['background']).toBe('var(--accent-weak)');
    expect(declarations(optionsCss, '.link-danger')['background']).toBe('transparent');
    expect(declarations(optionsCss, '.link-danger:hover')['background']).toBe(
      'color-mix(in srgb, var(--danger) 12%, transparent)',
    );
  });

  it('iOS 开关直接画在原生 checkbox 上（--track-off 关态 / --ok 开态 / --knob 旋钮 / translateX 滑动）', () => {
    const sw = declarations(optionsCss, '.switch');
    expect(sw['appearance']).toBe('none');
    expect(sw['background']).toBe('var(--track-off)');
    expect(sw['width']).toBe('44px');
    expect(sw['height']).toBe('26px');
    expect(declarations(optionsCss, '.switch:checked')['background']).toBe('var(--ok)');
    const knob = declarations(optionsCss, '.switch::after');
    expect(knob['background']).toBe('var(--knob)');
    expect(knob['position']).toBe('absolute');
    expect(declarations(optionsCss, '.switch:checked::after')['transform']).toBe('translateX(18px)');
  });

  it('按压收缩只给未禁用的按钮（P1：:not(:disabled) 钉在选择器上，禁用态不许反馈）', () => {
    // 牙在选择器本身：解析器按**完整相等**找规则，样式若写成裸 `button:active` / `.primary:active`，
    // 这里查 `…:not(:disabled)` 就抛「样式表里没有该选择器」= 当场红，不靠值断言兜选择器。
    // 禁用按钮按下去照样 scale，就是"看着还能按"——与 `.add:disabled`、`.primary:disabled`
    // 那两条"禁用必须如实画灰"的纪律正相反。popup 有 `.primary:disabled` 的三条变体，
    // 所以两边钉同一手法（同置一条用例：popup 的断言不另占一格计数）。
    expect(declarations(optionsCss, 'button:active:not(:disabled)')['transform']).toBe('scale(0.975)');
    expect(declarations(popupCss, '.primary:active:not(:disabled)')['transform']).toBe('scale(0.975)');
  });
});

describe('设置页样式：popup 镜像纪律（D1 复盘补牙②）', () => {
  it('popup.css 正文：color: 不许拿 --ok/--danger（对比度），:root 之外不许有颜色字面量', () => {
    const light = declarationBlock(popupCss, ':root');
    const dark = declarationBlock(popupCss, ':root', DARK);
    const rest = stripCssComments(popupCss)
      .replace(`{${light}}`, '{}')
      .replace(`{${dark}}`, '{}');
    // 与 options 侧同款边界正则：background-color: 之类不误伤；注释已由 stripCssComments 排除。
    expect(rest.match(/(?:^|[;{\s])color:\s*var\(--ok\)/g) ?? []).toEqual([]);
    expect(rest.match(/(?:^|[;{\s])color:\s*var\(--danger\)/g) ?? []).toEqual([]);
    expect(rest.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(rest.match(/\b(?:rgba?|hsla?)\(/g) ?? []).toEqual([]);
    // 刻意**不**断言 opacity：`.field-toggle > input[type="checkbox"]` 上的 `opacity: 0` 是无障碍
    // 隐藏通道（appearance 方案的一部分），它必须活着——options 侧的 opacity 禁令不外推。
    // （注释里引用样式一律写选择器/符号名，**不钉行号**：行号随改动漂移，钉了就是假话源头。）
    // 同理 %23000（data-URI 转义）不含裸 #，hex 扫描对它天然免疫，与 options 守卫同一口径。
  });
});

describe('设置页样式：暗色块跨文件一致（D1 复盘补牙③）', () => {
  it('popup 暗色声明集 ⊆ options 暗色声明集，同名同值（守卫①镜像到暗块；防空转下限 ≥20）', () => {
    const popupDark = declarations(popupCss, ':root', DARK);
    const optionsDark = declarations(optionsCss, ':root', DARK);
    for (const [name, value] of Object.entries(popupDark)) {
      expect(`${name}: ${optionsDark[name]}`).toBe(`${name}: ${value}`);
    }
    // 防「popup 暗块被清空 → 循环空转恒真」：与守卫①的 >=17 同一手法，按现块 20 条声明钉底。
    expect(Object.keys(popupDark).length).toBeGreaterThanOrEqual(20);
  });
});

describe('设置页样式：D3 版式层（只钉两条，其余肉眼验收——不造恒真式）', () => {
  it('统计数字 24px/650/-0.03em 且 tabular-nums（刷新时数字不跳位）；状态点带 color-mix 光环', () => {
    const stat = declarations(optionsCss, '.stat b');
    expect(stat['font-size']).toBe('24px');
    expect(stat['font-weight']).toBe('650');
    expect(stat['letter-spacing']).toBe('-0.03em');
    expect(stat['font-variant-numeric']).toBe('tabular-nums');
    expect(declarations(optionsCss, '.dot[data-state="ok"]')['box-shadow']).toBe(
      '0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent)',
    );
    expect(declarations(optionsCss, '.dot[data-state="bad"]')['box-shadow']).toBe(
      '0 0 0 3px color-mix(in srgb, var(--danger) 22%, transparent)',
    );
  });
});

describe('设置页样式：D4 前置修正（「显示原文」态的两路反馈也只给未禁用按钮）', () => {
  it('popup 的 [data-active="true"]：hover / active 两路的 filter 都带 :not(:disabled)（后缀是契约）', () => {
    // 解析器对查不到的选择器直接抛错：CSS 若漂回那条合并规则
    // `.primary[data-active="true"]:hover, .primary[data-active="true"]:active`，
    // 这两条查询就当场红（Error 形态，不是断言 diff）——这就是这条断言的牙的读法。
    // ⚠ 两条断言写在同一个 it 里：vitest 遇首个失败即抛出，所以**一次运行只响一层**；
    //    要分别证明两半各有牙，必须按 0d 做两次独立运行（本计划第②条硬规矩）。
    expect(declarations(popupCss, '.primary[data-active="true"]:hover:not(:disabled)')['filter']).toBe('brightness(0.92)');
    expect(declarations(popupCss, '.primary[data-active="true"]:active:not(:disabled)')['filter']).toBe('brightness(0.92)');
  });
});

/*
 * 这一组来自**真机反馈**（用户报「悬停翻译 / 划词翻译 有效果但开关不置亮」）：
 * 标记是 `<input>` → `<span class="field-toggle-text">` → `<span class="toggle-track">`，
 * 而规则写的是 `input:checked + .toggle-track`（相邻兄弟）——中间隔着一个元素，`+` 永远匹配不上。
 * 开关的状态真的会变（功能生效），但轨道与旋钮的视觉一直停在关态。
 *
 * 为什么以前没人发现：**jsdom 不计算 CSS**，`tests/popup/popup.test.ts` 里那些
 * 「勾选后存储里 hoverTranslate 变成 true」的断言全是真的、也全在绿——它们看的是状态，
 * 不是观感。这类"选择器与标记结构对不上"的缺陷只能靠眼睛或靠这条结构性断言。
 * 该缺陷自 `b4299f5`（单元 B 弹窗重做）起就在，D 单元的样式改动只是把它带到了暗色下更显眼。
 */
describe('弹窗样式：开关的兄弟组合器必须与标记结构对得上（真机缺陷的守卫）', () => {
  const popupHtml = readFileSync(join(ROOT, 'popup', 'popup.html'), 'utf-8');

  it('为什么存在：input 与 .toggle-track 之间隔着 .field-toggle-text，所以必须用 `~` 而不是 `+`', () => {
    // 先把「中间隔着谁」钉成事实——否则下面那三条「必须用 `~`」看起来像多余的讲究。
    const firstToggle = popupHtml.slice(popupHtml.indexOf('class="field-toggle"'));
    const between = firstToggle.slice(firstToggle.indexOf('<input'), firstToggle.indexOf('toggle-track'));
    expect(between).toContain('field-toggle-text');

    // 三条规则都要用通用兄弟 `~`：`~` 在"相邻"时同样成立，
    // 所以将来标记若真把轨道挪到紧挨 input 的位置，这三条仍然对（不会假红）。
    expect(declarations(popupCss, '.field-toggle > input[type="checkbox"]:checked ~ .toggle-track')['background']).toBe(
      'var(--ok)',
    );
    expect(
      declarations(popupCss, '.field-toggle > input[type="checkbox"]:checked ~ .toggle-track::after')['transform'],
    ).toBe('translateX(18px)');
    expect(
      declarations(popupCss, '.field-toggle > input[type="checkbox"]:focus-visible ~ .toggle-track')['outline'],
    ).toContain('var(--accent)');

    // 坏掉的那版（相邻兄弟）不许回来：`hasRule` 为 false 才是对的。
    // 这一条盯的是"别再写回 `+`"，因为 `~` 那条断言在两种写法下都可能绿（当且仅当标记相邻时）。
    expect(hasRule(popupCss, '.field-toggle > input[type="checkbox"]:checked + .toggle-track')).toBe(false);
    expect(hasRule(popupCss, '.field-toggle > input[type="checkbox"]:checked + .toggle-track::after')).toBe(false);
    expect(hasRule(popupCss, '.field-toggle > input[type="checkbox"]:focus-visible + .toggle-track')).toBe(false);
  });
});
