/**
 * @vitest-environment jsdom
 *
 * 悬停/划词共用的 fixed 浮层（tooltip）。两组诉求分开钉：
 * - **定位数学**是纯函数 `positionTooltip`——jsdom 量不出尺寸（offsetWidth/Height 恒为 0），
 *   翻转与收界的规则只能按 (rect, size, viewport) 显式喂给它来测；
 * - **DOM 纪律**（挂哪、带什么标记、怎么关、内容怎么写入）走 show/hide 的真实路径。
 *
 * 第二轮（界面美化）补的是第三组：**观感**。表面/文字/滚动条/按钮/状态/caret 都是样式表
 * 与 data-* 属性就能钉住的东西，所以断言直接读 shadow 里的样式表文本与算出来的落点——
 * jsdom 不做级联与布局，读"声明"是这里唯一诚实的口径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hideTooltip,
  isTooltipVisible,
  layoutTooltip,
  positionTooltip,
  setActionLabel,
  showTooltip,
} from '../../src/content/tooltip';
import { declarations, hasRule, type Declarations } from '../helpers/css';
import { dispatchSynthetic, dispatchTrusted } from '../helpers/trusted-events';

function host(): HTMLElement | null {
  return document.querySelector('[data-jy-tooltip]');
}

function bubbleText(): string {
  return host()?.shadowRoot?.querySelector('.jy-text')?.textContent ?? '';
}

function buttons(): HTMLButtonElement[] {
  const root = host()?.shadowRoot;
  if (root === undefined || root === null) return [];
  return Array.from(root.querySelectorAll('button'));
}

function bubbleNode(): HTMLElement | null {
  return host()?.shadowRoot?.querySelector('.jy-bubble') ?? null;
}

function layerNode(): HTMLElement | null {
  return host()?.shadowRoot?.querySelector('.jy-layer') ?? null;
}

/** 承载译文、同时是 ARIA 活区的那个节点。 */
function liveRegion(): HTMLElement | null {
  return host()?.shadowRoot?.querySelector('.jy-text') ?? null;
}

function css(): string {
  return host()?.shadowRoot?.querySelector('style')?.textContent ?? '';
}

/**
 * 取样式表里某条规则的**声明表**（真解析：配对花括号 + 去注释 + 选择器完整相等）。
 *
 * 上一版这里是「整表 toContain」＋「indexOf(选择器) 切到下一个 `}`」。核验把 `.jy-bubble`
 * 的 `max-height: 40vh;` 整条删掉，44 条用例全绿——因为样式表注释里恰好写着
 * `max-height:40vh` 与 `overflow:auto`，整表查找照样命中。解析成声明表之后，
 * 删掉哪条声明，哪条断言就查不到这一项。
 */
function decls(selector: string, scope?: string): Declarations {
  return declarations(css(), selector, scope);
}

/** jsdom 视口默认 1024×768；show() 的定位断言以此为前提。 */
const RECT = { top: 100, left: 100, width: 200, height: 20 };

beforeEach(() => {
  document.body.innerHTML = '<p id="page">Hello world</p>';
});

afterEach(() => {
  hideTooltip();
  // 兜底：浮层/高亮都带 data-jy-root，挂在 documentElement 上，清 body 清不到它们。
  for (const node of Array.from(document.querySelectorAll('[data-jy-root]'))) node.remove();
});

describe('positionTooltip：下方 → 上方 → 贴底', () => {
  const viewport = { width: 1000, height: 800 };

  it('默认放在矩形下方，水平对齐矩形左边', () => {
    const position = positionTooltip(RECT, { width: 300, height: 80 }, viewport);
    expect(position).toEqual({ left: 100, top: 128 });
  });

  it('下方放不下时翻到矩形上方', () => {
    const rect = { top: 650, left: 10, width: 100, height: 60 };
    const position = positionTooltip(rect, { width: 100, height: 120 }, viewport);
    expect(position.top).toBe(650 - 8 - 120);
    expect(position.top).toBeGreaterThan(8);
  });

  it('上方也放不下时贴视口底', () => {
    const rect = { top: 5, left: 10, width: 100, height: 790 };
    const position = positionTooltip(rect, { width: 100, height: 120 }, viewport);
    expect(position.top).toBe(800 - 8 - 120);
  });

  it('气泡比视口还高时也不越过顶边距', () => {
    const rect = { top: 400, left: 10, width: 10, height: 10 };
    const position = positionTooltip(rect, { width: 10, height: 2000 }, viewport);
    expect(position.top).toBe(8);
  });

  it('水平越界向内收，左右都不破边距', () => {
    const right = positionTooltip({ top: 10, left: 900, width: 50, height: 10 }, { width: 200, height: 40 }, viewport);
    expect(right.left).toBe(1000 - 8 - 200);
    const left = positionTooltip({ top: 10, left: -100, width: 50, height: 10 }, { width: 200, height: 40 }, viewport);
    expect(left.left).toBe(8);
  });
});

describe('showTooltip：DOM 纪律', () => {
  it('fixed + 最大 z-index + 挂在 documentElement 上 + data-jy-root 标记', () => {
    showTooltip(RECT, { text: '译文' });

    const node = host();
    expect(node).not.toBeNull();
    expect(node?.parentElement).toBe(document.documentElement);
    expect(node?.hasAttribute('data-jy-root')).toBe(true);
    expect(node?.style.position).toBe('fixed');
    expect(node?.style.zIndex).toBe('2147483647');
    // 气泡里有按钮：**绝不能**照抄 toast 的 pointer-events:none。
    expect(node?.style.pointerEvents).toBe('auto');
  });

  it('超长译文：max-height + overflow:auto 写在 .jy-bubble 自己身上，不靠撑高页面解决', () => {
    showTooltip(RECT, { text: '很长' });
    // 必须真的落在那条规则的声明块里：样式表的注释里也写着 `max-height:40vh`、
    // `overflow:auto`，整表 toContain 会被注释满足——上一轮的变异核验正是这么漏掉的。
    const box = decls('.jy-bubble {');
    expect(box['max-height']).toBe('40vh');
    expect(box['overflow']).toBe('auto');
  });

  it('定位走 positionTooltip：jsdom 下量得尺寸 0，仍按下方 8px 落位', () => {
    showTooltip(RECT, { text: '译文' });
    expect(host()?.style.top).toBe('128px');
    expect(host()?.style.left).toBe('100px');
  });

  it('单例：重复 show 只有一份节点，内容是替换不是叠加', () => {
    showTooltip(RECT, { text: '第一段' });
    showTooltip({ top: 20, left: 20, width: 50, height: 10 }, { text: '第二段' });

    expect(document.querySelectorAll('[data-jy-tooltip]')).toHaveLength(1);
    expect(bubbleText()).toBe('第二段');
  });

  it('按钮一律渲染成可点击元素，回调收到按钮自身', () => {
    const onClick = vi.fn();
    showTooltip(RECT, { text: '译文', buttons: [{ label: '复制', onClick }] });

    const button = buttons()[0];
    expect(button?.textContent).toBe('复制');
    // composed:true 与真实点击一致：事件要穿过 shadow 边界，才能被 host 上的委托收到。
    if (button !== undefined) dispatchTrusted(button, new MouseEvent('click', { bubbles: true, composed: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0]?.[0]).toBe(button);
  });

  it('译文里的 HTML 只当文字：页面与 shadow 里 img/script 数为 0', () => {
    const evil = '<img src=x onerror="window.__jy_pwned = 1">';
    showTooltip(RECT, { text: evil, buttons: [{ label: '<script>alert(1)</script>', onClick: () => {} }] });

    expect(document.querySelectorAll('img, script')).toHaveLength(0);
    expect(host()?.shadowRoot?.querySelectorAll('img, script')).toHaveLength(0);
    expect(bubbleText()).toBe(evil);
    expect(buttons()[0]?.textContent).toBe('<script>alert(1)</script>');
    expect((window as unknown as { __jy_pwned?: unknown }).__jy_pwned).toBeUndefined();
  });

  it('不往页面里插任何东西：show 与 hide 前后 body 逐字节不变', () => {
    const before = document.body.innerHTML;
    showTooltip(RECT, { text: '译文' });
    expect(document.body.contains(host())).toBe(false);
    hideTooltip();
    expect(document.body.innerHTML).toBe(before);
  });
});

describe('关闭途径', () => {
  it('按 Escape 关闭', () => {
    showTooltip(RECT, { text: '译文' });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(host()).toBeNull();
    expect(isTooltipVisible()).toBe(false);
  });

  it('其它按键不关', () => {
    showTooltip(RECT, { text: '译文' });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(host()).not.toBeNull();
  });

  it('点气泡外部关闭', () => {
    showTooltip(RECT, { text: '译文' });
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(host()).toBeNull();
  });

  it('点气泡内部（按钮）不关闭——否则复制/翻译永远点不到', () => {
    showTooltip(RECT, { text: '译文', buttons: [{ label: '复制', onClick: () => {} }] });
    const button = buttons()[0] as HTMLButtonElement;
    // composed:true：真实 pointerdown 会穿过 shadow 边界到达 window 捕获监听——
    // 关闭判据必须靠 composedPath 认出"这一下按在气泡里"。
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
    expect(host()).not.toBeNull();
  });

  it('页面滚动关闭（捕获阶段，容器滚动也算）', () => {
    showTooltip(RECT, { text: '译文' });
    window.dispatchEvent(new Event('scroll'));
    expect(host()).toBeNull();
  });

  it('hide 之后监听器全部摘掉：关闭的气泡不会被滚动/Escape 事件"复活"报错', () => {
    showTooltip(RECT, { text: '译文' });
    hideTooltip();
    expect(() => {
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    }).not.toThrow();
    expect(isTooltipVisible()).toBe(false);
    hideTooltip(); // 幂等
  });
});

describe('外观：深色玻璃表面（与弹窗/设置页同一套语言）', () => {
  it('表面：0.97 深底 + 1px 细边框 + 10px 圆角 + 12px/14px 内边距 + 400px 上限', () => {
    showTooltip(RECT, { text: '译文' });
    // 令牌整块钉住：改任何一个色值/圆角，这里当场红（观感是规格，不是随手可调的）。
    const tokens = decls(':host {');
    expect(tokens['--jy-surface']).toBe('rgba(24, 26, 30, 0.97)');
    expect(tokens['--jy-border']).toBe('rgba(255, 255, 255, 0.1)');
    expect(tokens['--jy-border-strong']).toBe('rgba(255, 255, 255, 0.16)');
    expect(tokens['--jy-text']).toBe('#ffffff');
    expect(tokens['--jy-radius-md']).toBe('10px');
    expect(tokens['--jy-radius-sm']).toBe('6px');

    const box = decls('.jy-bubble {');
    expect(box['background']).toBe('var(--jy-surface)');
    expect(box['border']).toBe('1px solid var(--jy-border)');
    expect(box['border-radius']).toBe('var(--jy-radius-md)');
    expect(box['padding']).toBe('12px 14px');
    expect(box['max-width']).toBe('400px');
  });

  it('阴影分两层：近处一条细阴影 + 远处一片柔阴影（不是单层大黑影）', () => {
    showTooltip(RECT, { text: '译文' });
    expect(decls('.jy-bubble {')['box-shadow']).toBe(
      '0 1px 2px rgba(0, 0, 0, 0.28), 0 8px 24px rgba(0, 0, 0, 0.32)',
    );
  });

  it('文字：13px/1.65 + 抗锯齿 + pre-wrap/break-word + 译文可选中复制', () => {
    showTooltip(RECT, { text: '译文' });
    const box = decls('.jy-bubble {');
    expect(box['font']).toBe('13px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif');
    expect(box['-webkit-font-smoothing']).toBe('antialiased');

    const text = decls('.jy-text {');
    expect(text['white-space']).toBe('pre-wrap');
    expect(text['overflow-wrap']).toBe('break-word');
    // 译文要能被框选去复制；页面上的 user-select:none 会顺着继承查到浮层头上，得显式挡住。
    expect(text['user-select']).toBe('text');
    expect(text['-webkit-user-select']).toBe('text');
  });

  it('滚动条：细 + 深色适配（scrollbar-* 与 ::-webkit-scrollbar 两套都写）', () => {
    showTooltip(RECT, { text: '译文' });
    const box = decls('.jy-bubble {');
    expect(box['scrollbar-width']).toBe('thin');
    expect(box['scrollbar-color']).toBe('rgba(255, 255, 255, 0.28) transparent');

    const bar = decls('.jy-bubble::-webkit-scrollbar {');
    expect(bar['width']).toBe('8px');
    expect(bar['height']).toBe('8px');
    expect(decls('.jy-bubble::-webkit-scrollbar-thumb {')['background']).toBe('rgba(255, 255, 255, 0.28)');
  });

  /**
   * 尺寸口径：shadow 里统一 border-box，声明出来的 400px / 40vh / 26px 就是**看得见**的那个盒子。
   * 少了这一条，400px 的内容盒会渲染成 428px，而宿主（`measure()` 量的、caret 与越界收回都按它算）
   * 只有 400px——右边缘的收回会差出 28px。
   */
  it('shadow 里统一 border-box：声明的 400px / 26px 就是可见盒子，宿主量与气泡等宽', () => {
    showTooltip(RECT, { text: '译文' });
    // 多行选择器（`.jy-layer,` + `.jy-layer *`）按空白归一化之后照样精确命中。
    expect(decls('.jy-layer, .jy-layer * {')['box-sizing']).toBe('border-box');
    // 上限仍写在气泡上（400px），收边口径的那一层也跟着它。
    expect(decls('.jy-bubble {')['max-width']).toBe('400px');
    expect(decls('.jy-layer {')['max-width']).toBe('400px');
  });
});

describe('按钮：主操作实心、次操作半透明，都带内联 SVG 图标', () => {
  function twoButtons(): HTMLButtonElement[] {
    showTooltip(RECT, {
      text: '译文',
      buttons: [
        { label: '复制', variant: 'primary', icon: 'copy', onClick: () => {} },
        { label: '翻译', icon: 'translate', onClick: () => {} },
      ],
    });
    return buttons();
  }

  it('复制是实心强调色主按钮、翻译是半透明白底次按钮；两者仍是 <button type="button">', () => {
    const [copy, translate] = twoButtons();
    expect(copy?.tagName).toBe('BUTTON');
    expect(copy?.type).toBe('button');
    expect(copy?.getAttribute('data-variant')).toBe('primary');
    expect(translate?.tagName).toBe('BUTTON');
    expect(translate?.getAttribute('data-variant')).toBe('secondary');

    expect(decls(':host {')['--jy-accent']).toBe('#f2efe6');
    expect(decls('.jy-action[data-variant="primary"] {')['background']).toBe('var(--jy-accent)');
    const base = decls('.jy-action {');
    expect(base['background']).toBe('rgba(255, 255, 255, 0.1)');
    expect(base['height']).toBe('26px');
    expect(base['padding']).toBe('0 10px');
    expect(base['font-size']).toBe('12px');
    expect(base['gap']).toBe('6px');
    expect(base['border-radius']).toBe('var(--jy-radius-sm)');
  });

  it('三态齐全：hover / active / focus-visible（焦点环是浅色，深底上看得见）', () => {
    twoButtons();
    expect(decls(':host {')['--jy-accent-hover']).toBe('#ffffff');
    expect(decls('.jy-action:hover {')['background']).toBe('rgba(255, 255, 255, 0.16)');
    expect(decls('.jy-action:active {')['background']).toBe('rgba(255, 255, 255, 0.22)');
    expect(decls('.jy-action[data-variant="primary"]:hover {')['background']).toBe('var(--jy-accent-hover)');
    expect(decls('.jy-action[data-variant="primary"]:active {')['filter']).toBe('brightness(0.94)');
    expect(decls('.jy-action:focus-visible {')['outline']).toBe('2px solid rgba(255, 255, 255, 0.85)');
  });

  it('每个按钮前面一个内联 SVG 图标：14×14、currentColor、纯装饰、排在标签之前', () => {
    const rendered = twoButtons();
    // 复制是两个方框（rect + path），翻译是「文」+「A」两半（文 4 笔 + A 的撇捺与横）。
    const shapesPerIcon = [2, 6];

    rendered.forEach((button, index) => {
      const svg = button.querySelector('svg');
      expect(svg).not.toBeNull();
      // 命名空间对得上 = 真的走了 createElementNS，不是把字符串当标记塞进去的。
      expect(svg?.namespaceURI).toBe('http://www.w3.org/2000/svg');
      expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg?.getAttribute('stroke')).toBe('currentColor');
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
      expect(svg?.querySelectorAll('*')).toHaveLength(shapesPerIcon[index]);
      expect(button.firstElementChild).toBe(svg);
      expect(button.querySelector('.jy-action-label')?.textContent).toBeTruthy();
    });

    const icon = decls('.jy-action-icon {');
    expect(icon['width']).toBe('14px');
    expect(icon['height']).toBe('14px');
  });

  it('点图标本身也算点按钮：委托认的是 composedPath 里的按钮，不是 event.target', () => {
    const onClick = vi.fn();
    showTooltip(RECT, { text: '译文', buttons: [{ label: '复制', variant: 'primary', icon: 'copy', onClick }] });

    const button = buttons()[0] as HTMLButtonElement;
    const svg = button.querySelector('svg') as SVGElement;
    // composed:true：真实点击落在 shadow 里的图标上，照样要穿过边界到 host 的委托。
    dispatchTrusted(svg, new MouseEvent('click', { bubbles: true, composed: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0]?.[0]).toBe(button);
  });

  it('安全闸门：合成 click（isTrusted=false）不打到回调——浮层是 open shadow，页面脚本点得到它', () => {
    const onClick = vi.fn();
    showTooltip(RECT, { text: '译文', buttons: [{ label: '复制', variant: 'primary', icon: 'copy', onClick }] });

    const button = buttons()[0] as HTMLButtonElement;
    dispatchSynthetic(button, new MouseEvent('click', { bubbles: true, composed: true }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('成对断言：同一处委托，真实手势的 click 照常打到回调（证明上一条不是"永远拒绝"）', () => {
    const onClick = vi.fn();
    showTooltip(RECT, { text: '译文', buttons: [{ label: '复制', variant: 'primary', icon: 'copy', onClick }] });

    const button = buttons()[0] as HTMLButtonElement;
    dispatchTrusted(button, new MouseEvent('click', { bubbles: true, composed: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0]?.[0]).toBe(button);
  });

  it('两个按钮各自回调、互不串台', () => {
    const copy = vi.fn();
    const translate = vi.fn();
    showTooltip(RECT, {
      text: '译文',
      buttons: [
        { label: '复制', variant: 'primary', icon: 'copy', onClick: copy },
        { label: '翻译', icon: 'translate', onClick: translate },
      ],
    });

    const [first, second] = buttons();
    if (first !== undefined) dispatchTrusted(first, new MouseEvent('click', { bubbles: true, composed: true }));
    if (second !== undefined) dispatchTrusted(second, new MouseEvent('click', { bubbles: true, composed: true }));
    expect(copy).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('改文案走 setActionLabel：图标留下、只换标签（直接写 textContent 会把图标抹掉）', () => {
    showTooltip(RECT, {
      text: '译文',
      buttons: [
        { label: '复制', variant: 'primary', icon: 'copy', onClick: (button) => setActionLabel(button, '已复制') },
      ],
    });

    const button = buttons()[0] as HTMLButtonElement;
    dispatchTrusted(button, new MouseEvent('click', { bubbles: true, composed: true }));

    expect(button.textContent).toBe('已复制');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.querySelector('.jy-action-label')?.textContent).toBe('已复制');
  });
});

describe('状态：翻译中与失败', () => {
  it('pending：降饱和的次级色 + 轻微脉冲，reduced-motion 下不动', () => {
    showTooltip(RECT, { text: '翻译中…', state: 'pending' });
    expect(bubbleNode()?.getAttribute('data-state')).toBe('pending');
    expect(decls(':host {')['--jy-text-2']).toBe('#a8b0bb');

    const pending = decls('.jy-bubble[data-state="pending"] .jy-text {');
    expect(pending['color']).toBe('var(--jy-text-2)');
    expect(pending['animation']).toBe('jy-pulse 1.4s ease-in-out infinite');
    expect(hasRule(css(), '@keyframes jy-pulse')).toBe(true);
    // 降级在媒体查询里那条**同名**规则上：按作用域取，拿到的不会是顶层这条。
    const reduced = decls('.jy-bubble[data-state="pending"] .jy-text {', '@media (prefers-reduced-motion: reduce)');
    expect(reduced['animation']).toBe('none');
  });

  it('error：深底上提亮过的红，且只是文字——不挂可点的按钮', () => {
    showTooltip(RECT, { text: '无法连接后台：Receiving end does not exist.', state: 'error' });
    expect(bubbleNode()?.getAttribute('data-state')).toBe('error');
    expect(decls(':host {')['--jy-danger']).toBe('#f87171');
    expect(decls('.jy-bubble[data-state="error"] .jy-text {')['color']).toBe('var(--jy-danger)');
    expect(buttons()).toHaveLength(0);
  });

  it('没写 state 就是普通译文态（done），不会误吃 pending/error 的观感', () => {
    showTooltip(RECT, { text: '译文' });
    expect(bubbleNode()?.getAttribute('data-state')).toBe('done');
  });

  it('失败态文案里的 HTML 也只当文字：页面与 shadow 里 img/script 数为 0', () => {
    const evil = '<img src=x onerror="window.__jy_pwned = 1">';
    showTooltip(RECT, {
      text: evil,
      state: 'error',
      buttons: [{ label: '<b>复制</b>', icon: 'copy', onClick: () => {} }],
    });

    expect(document.querySelectorAll('img, script')).toHaveLength(0);
    expect(host()?.shadowRoot?.querySelectorAll('img, script')).toHaveLength(0);
    expect(bubbleText()).toBe(evil);
    expect(buttons()[0]?.textContent).toBe('<b>复制</b>');
    expect((window as unknown as { __jy_pwned?: unknown }).__jy_pwned).toBeUndefined();
  });
});

describe('caret：方向跟着定位走，水平跟着选区中心', () => {
  const viewport = { width: 1000, height: 800 };

  it('layoutTooltip 的落点就是 positionTooltip 的落点（定位数学只有一份）', () => {
    const size = { width: 300, height: 80 };
    const layout = layoutTooltip(RECT, size, viewport);
    const position = positionTooltip(RECT, size, viewport);
    expect(layout.left).toBe(position.left);
    expect(layout.top).toBe(position.top);
  });

  it('气泡落在选区下方：placement = bottom', () => {
    const layout = layoutTooltip(RECT, { width: 300, height: 80 }, viewport);
    expect(layout.top).toBe(128); // 100 + 20 + 8，翻转数学一个字没动
    expect(layout.placement).toBe('bottom');
  });

  it('下方放不下翻到上方：placement 跟着变成 top', () => {
    const layout = layoutTooltip({ top: 650, left: 10, width: 100, height: 60 }, { width: 100, height: 120 }, viewport);
    expect(layout.top).toBe(650 - 8 - 120);
    expect(layout.placement).toBe('top');
  });

  it('上下都放不下、贴视口底时也不会指反（气泡中心仍在选区中线之下）', () => {
    const layout = layoutTooltip({ top: 400, left: 10, width: 10, height: 10 }, { width: 10, height: 2000 }, viewport);
    expect(layout.top).toBe(8);
    expect(layout.placement).toBe('bottom');
  });

  it('caret 水平跟随选区中心', () => {
    // 选区 500..700、中心 600；气泡左边 500 → caret 中心落在气泡内 100px 处。
    const layout = layoutTooltip({ top: 100, left: 500, width: 200, height: 20 }, { width: 300, height: 80 }, viewport);
    expect(layout.left).toBe(500);
    expect(layout.caretX).toBe(100);
  });

  it('气泡被水平收边时 caret 跟着偏移，且永远留在气泡里（不飘在外面）', () => {
    const size = { width: 200, height: 40 };
    // 右侧越界：气泡收到 1000-8-200 = 792；选区中心 990 → 期望 198，被收进 200-16 = 184。
    const right = layoutTooltip({ top: 10, left: 980, width: 20, height: 10 }, size, viewport);
    expect(right.left).toBe(792);
    expect(right.caretX).toBe(184);
    // 左侧越界：气泡贴到 8；选区中心 10 → 期望 2，被收进 16。
    const left = layoutTooltip({ top: 10, left: 0, width: 20, height: 10 }, size, viewport);
    expect(left.left).toBe(8);
    expect(left.caretX).toBe(16);
  });

  it('量不到宽度（jsdom 恒为 0）时 caretX 为 null，交给样式表的 50% 兜底', () => {
    expect(layoutTooltip(RECT, { width: 0, height: 0 }, viewport).caretX).toBeNull();
  });

  it('data-placement 写到 .jy-bubble 上：默认下方', () => {
    showTooltip(RECT, { text: '译文' });
    expect(bubbleNode()?.getAttribute('data-placement')).toBe('bottom');
  });

  it('翻到上方时 data-placement = top', () => {
    // jsdom 量得尺寸 0：rect 底 770 + 8 越过 768-8，于是翻到上方。
    showTooltip({ top: 750, left: 100, width: 200, height: 20 }, { text: '译文' });
    expect(bubbleNode()?.getAttribute('data-placement')).toBe('top');
  });

  it('尺寸量得到时，caret 的水平落点写到 .jy-layer 的 --jy-caret-x 上', () => {
    showTooltip(RECT, { text: '译文' }); // 先建出宿主
    const node = host() as HTMLElement;
    // jsdom 不做布局（量出来恒为 0）：按真实浏览器的结果给宿主一个盒尺寸。
    Object.defineProperty(node, 'offsetWidth', { value: 300, configurable: true });
    Object.defineProperty(node, 'offsetHeight', { value: 80, configurable: true });

    const rect = { top: 100, left: 500, width: 200, height: 20 };
    showTooltip(rect, { text: '译文' });

    const layout = layoutTooltip(rect, { width: 300, height: 80 }, { width: window.innerWidth, height: window.innerHeight });
    expect(layout.caretX).toBe(100);
    expect(layerNode()?.style.getPropertyValue('--jy-caret-x')).toBe('100px');
    // 位置也出自同一份结果：DOM 路径没有第二套数学。
    expect(node.style.left).toBe(`${layout.left}px`);
    expect(node.style.top).toBe(`${layout.top}px`);
  });

  it('caret 画在 .jy-layer 上（气泡 overflow:auto 会把挂在它身上的箭头裁掉）', () => {
    showTooltip(RECT, { text: '译文' });
    const caret = decls('.jy-layer::after {');
    expect(caret['width']).toBe('8px');
    expect(caret['height']).toBe('8px');
    expect(caret['transform']).toBe('translateX(-50%) rotate(45deg)');
    expect(caret['background']).toBe('var(--jy-surface)');
    // 方向跟着气泡上的 data-placement：翻到上方时箭头改露在下边缘。
    expect(hasRule(css(), '.jy-layer:has(> .jy-bubble[data-placement="top"])::after {')).toBe(true);
  });
});

/**
 * 无障碍：气泡里的状态变化要能被读屏播报。
 *
 * 规则是"读屏只播报**已经存在的活区内部**发生的变化"。活区如果随内容一起被插进来
 * （上一版每次 show 都 `replaceChildren` 重建整个气泡），"翻译中 → 译文"在无障碍树上
 * 就只是"一个新节点出现了"，读屏一声不吭。所以这里钉两件事：
 *   ① 活区语义确实挂在**承载译文**的那个节点上（不是另做一个空壳镜像）；
 *   ② 这个节点跨多次 show **是同一个**——变化落在同一个区域内部，才谈得上播报。
 */
describe('无障碍：状态变化能被播报（常驻活区）', () => {
  it('承载译文的 .jy-text 就是 role=status 的活区，且没有被藏起来', () => {
    showTooltip(RECT, { text: '译文' });

    const region = liveRegion();
    expect(region).not.toBeNull();
    expect(region?.getAttribute('role')).toBe('status');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.getAttribute('aria-atomic')).toBe('true');
    // 活区里装的就是译文本身：念出来的和看到的是同一份文案。
    expect(region?.textContent).toBe('译文');
    // 在文档里、且没有被 aria-hidden 或 hidden 藏掉（藏起来的活区不播报）。
    expect(region?.isConnected).toBe(true);
    expect(region?.closest('[aria-hidden="true"], [hidden]')).toBeNull();
  });

  it('pending → 译文：还是同一个活区节点，只是文字变了（换节点＝这次变化收不到）', () => {
    showTooltip(RECT, { text: '翻译中…', state: 'pending' });
    const region = liveRegion();

    showTooltip(RECT, { text: '译文' });

    expect(liveRegion()).toBe(region);
    expect(region?.textContent).toBe('译文');
    expect(bubbleNode()?.getAttribute('data-state')).toBe('done');
  });

  it('pending → 失败：错误文案同样落在同一个活区里（不是静默）', () => {
    showTooltip(RECT, { text: '翻译中…', state: 'pending' });
    const region = liveRegion();

    showTooltip(RECT, { text: '无法连接后台', state: 'error' });

    expect(liveRegion()).toBe(region);
    expect(region?.textContent).toBe('无法连接后台');
    expect(bubbleNode()?.getAttribute('data-state')).toBe('error');
  });

  it('活区里只有译文：按钮行不在里面，重建按钮不会把整块文案再念一遍', () => {
    showTooltip(RECT, { text: '翻译中…', state: 'pending' });
    const region = liveRegion();

    showTooltip(RECT, { text: '译文', buttons: [{ label: '复制', onClick: () => {} }] });

    expect(liveRegion()).toBe(region);
    expect(region?.querySelector('button')).toBeNull();
    expect(buttons()).toHaveLength(1);
  });

  it('同一段重复显示（缓存命中）：文字没变就不重写，不制造第二次播报', () => {
    showTooltip(RECT, { text: '译文' });
    const region = liveRegion();
    const written = region?.firstChild;

    showTooltip(RECT, { text: '译文' });

    expect(region?.textContent).toBe('译文');
    // 再写一遍等于又制造一次活区变化（读屏会重复念同一句话）：文本节点都没被换。
    expect(region?.firstChild).toBe(written);
  });

  it('关闭再打开：活区随宿主重生（旧节点不残留在文档里）', () => {
    showTooltip(RECT, { text: '译文' });
    const first = liveRegion();

    hideTooltip();
    showTooltip(RECT, { text: '第二段' });

    const second = liveRegion();
    expect(second).not.toBe(first);
    expect(first?.isConnected).toBe(false);
    expect(second?.textContent).toBe('第二段');
  });
});

/**
 * 划词的两段式触发：第一段是**紧凑小气泡（chip）**，指针停在它上面满延时才发请求。
 * 悬停机制放在浮层这一侧，因为只有它拥有监听器的生老病死（见下面 hideTooltip 那条）。
 */
describe('chip 变体：紧凑小气泡（.jy-bubble[data-variant]）', () => {
  it('不写 variant 就是 bubble；写 chip 才落到 chip（悬停翻译与译文态一个字没变）', () => {
    showTooltip(RECT, { text: '译文' });
    expect(bubbleNode()?.getAttribute('data-variant')).toBe('bubble');

    showTooltip(RECT, { text: '译文', variant: 'chip' });
    expect(bubbleNode()?.getAttribute('data-variant')).toBe('chip');
  });

  it('chip 是一颗圆点：气泡零内边距 + 圆角 999px，按钮撑满成 30×30 的圆', () => {
    showTooltip(RECT, {
      text: '',
      variant: 'chip',
      buttons: [{ label: '翻译选中的文字', icon: 'translate', iconOnly: true, onClick: () => {} }],
    });

    const chip = decls('.jy-bubble[data-variant="chip"] {');
    expect(chip['padding']).toBe('0');
    expect(chip['border-radius']).toBe('999px');

    // 整个圆点就是那个 button："点小气泡"与"点按钮"是同一件事，委托层一行都不用改。
    const action = decls('.jy-bubble[data-variant="chip"] .jy-action {');
    expect(action['width']).toBe('30px');
    expect(action['height']).toBe('30px');
    expect(action['padding']).toBe('0');
    expect(action['justify-content']).toBe('center');
    expect(action['border-radius']).toBe('999px');
    expect(decls('.jy-bubble[data-variant="chip"] .jy-action-icon {')['width']).toBe('16px');
    // 按钮行本来带着 10px 上边距（译文气泡里它在文字下方）；圆点里必须归零，否则点会偏下。
    expect(decls('.jy-bubble[data-variant="chip"] .jy-actions {')['margin-top']).toBe('0');
    // 三态不丢：hover / active / focus-visible 都还在基础档上，圆点没有把它们关掉。
    expect(decls('.jy-action:hover {')['background']).toBe('rgba(255, 255, 255, 0.16)');
    expect(decls('.jy-action:focus-visible {')['outline']).toBe('2px solid rgba(255, 255, 255, 0.85)');
    // 译文那一档一个字没变：圆点尺寸只属于 chip。
    expect(decls('.jy-bubble {')['padding']).toBe('12px 14px');
    expect(decls('.jy-actions {')['margin-top']).toBe('10px');
  });

  it('圆点不画 caret：圆形没有直边给箭头落位（:has() 不认时退化成带箭头，不破版）', () => {
    showTooltip(RECT, { text: '', variant: 'chip' });
    expect(decls('.jy-layer:has(> .jy-bubble[data-variant="chip"])::after {')['content']).toBe('none');
    // 译文那一屏的箭头照旧。
    expect(hasRule(css(), '.jy-layer::after {')).toBe(true);
  });

  it('iconOnly 按钮：不上屏任何文字，名字走 aria-label，仍是可聚焦的 <button type="button">', () => {
    const onClick = vi.fn();
    showTooltip(RECT, {
      text: '',
      variant: 'chip',
      buttons: [{ label: '翻译选中的文字', icon: 'translate', iconOnly: true, onClick }],
    });

    const button = buttons()[0] as HTMLButtonElement;
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    // 可见文字为零：屏幕上一个字都没有，只有图标。
    expect(button.textContent).toBe('');
    expect(button.querySelector('.jy-action-label')).toBeNull();
    // 无障碍名必须在：读屏与键盘用户靠它，图标自己是 aria-hidden 的装饰。
    expect(button.getAttribute('aria-label')).toBe('翻译选中的文字');
    const svg = button.querySelector('svg') as SVGElement;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(button.firstElementChild).toBe(svg);

    dispatchTrusted(button, new MouseEvent('click', { bubbles: true, composed: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0]?.[0]).toBe(button);
  });

  it('成对纪律：iconOnly 圆点同样吃委托层的 isTrusted 闸门（合成 click 不触发）', () => {
    const onClick = vi.fn();
    showTooltip(RECT, {
      text: '',
      variant: 'chip',
      buttons: [{ label: '翻译选中的文字', icon: 'translate', iconOnly: true, onClick }],
    });

    dispatchSynthetic(buttons()[0] as HTMLButtonElement, new MouseEvent('click', { bubbles: true, composed: true }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('带文字的按钮照旧渲染标签、不写 aria-label（iconOnly 只是少一根 span）', () => {
    showTooltip(RECT, { text: '译文', buttons: [{ label: '复制', icon: 'copy', onClick: () => {} }] });

    const button = buttons()[0] as HTMLButtonElement;
    expect(button.textContent).toBe('复制');
    expect(button.querySelector('.jy-action-label')?.textContent).toBe('复制');
    expect(button.hasAttribute('aria-label')).toBe(false);
  });

  it('translate 图标：createElementNS 造出来的 24 视框描边图形，纯装饰', () => {
    showTooltip(RECT, { text: '翻译', buttons: [{ label: '翻译', icon: 'translate', onClick: () => {} }] });

    const svg = buttons()[0]?.querySelector('svg') as SVGElement;
    expect(svg).not.toBeNull();
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(buttons()[0]?.firstElementChild).toBe(svg);
    // 六条笔画全部由 createElementNS 造出来：没有一个字符串被当成标记解析。
    const shapes = Array.from(svg.querySelectorAll('*'));
    for (const shape of shapes) {
      expect(shape.namespaceURI).toBe('http://www.w3.org/2000/svg');
      expect(shape.tagName.toLowerCase()).toBe('path');
    }
    expect(shapes.length).toBeGreaterThan(1);
  });
});

describe('hoverIntent：指针停在气泡上满延时才触发', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const DELAY = 150;

  function hostNode(): HTMLElement {
    const node = host();
    if (node === null) throw new Error('没有气泡宿主');
    return node;
  }

  /** 指针进入/离开/移动。真实手势与合成事件走同一条派发路径，唯一区别是 isTrusted。 */
  function pointerEvent(
    type: 'pointerenter' | 'pointerleave' | 'pointermove' = 'pointerenter',
    trusted = true,
  ): void {
    const event = new MouseEvent(type);
    if (trusted) dispatchTrusted(hostNode(), event);
    else dispatchSynthetic(hostNode(), event);
  }

  /**
   * 真机实测的手势形状（`.qa/run-selection-chip.mjs` 的 ⑭）：指针**移动**进气泡时，浏览器发的是
   * `pointerover` + `pointerenter` + `pointermove` 三件；而"气泡被插到静止的指针底下"时只有前两件、
   * 没有 move。起算因此挂在 move 上——enter 单独出现不代表用户把指针"停"了上来。
   */
  function pointerArrives(): void {
    pointerEvent('pointerenter');
    pointerEvent('pointermove');
  }

  function withIntent(onTrigger = vi.fn()) {
    showTooltip(RECT, { text: '', variant: 'chip', hoverIntent: { delayMs: DELAY, onTrigger } });
    return onTrigger;
  }

  it('只有 pointerenter、没有任何 pointermove：不起算（气泡被插到静止的指针底下）', async () => {
    const onTrigger = withIntent();

    // 真机 ⑭ 的形状：拖选越过行底时，chip 生成在指针底下，Chrome 补发 over + enter 但不发 move。
    pointerEvent('pointerenter');
    await vi.advanceTimersByTimeAsync(DELAY * 3);
    expect(onTrigger).not.toHaveBeenCalled();

    // 用户真的动了一下，才算"停在上面"。
    pointerEvent('pointermove');
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('进入后满延时触发一次', async () => {
    const onTrigger = withIntent();

    pointerArrives();
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(onTrigger).not.toHaveBeenCalled(); // 差 1ms 也不算"停住了"
    await vi.advanceTimersByTimeAsync(1);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('延时未到就离开：取消，之后到点也不触发', async () => {
    const onTrigger = withIntent();

    pointerArrives();
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    pointerEvent('pointerleave');
    await vi.advanceTimersByTimeAsync(DELAY * 2);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('离开再回来：重新起算，且只有一个计时器', async () => {
    const onTrigger = withIntent();

    pointerArrives();
    await vi.advanceTimersByTimeAsync(100);
    pointerEvent('pointerleave');
    pointerArrives();
    await vi.advanceTimersByTimeAsync(100);
    expect(onTrigger).not.toHaveBeenCalled(); // 第二次进入还差 50ms
    await vi.advanceTimersByTimeAsync(50);
    expect(onTrigger).toHaveBeenCalledTimes(1); // 不是两次：没有计时器叠加
  });

  it('触发是一次性的：离开再回来不再触发第二次（译文已经出来了，不该再烧一次额度）', async () => {
    const onTrigger = withIntent();

    pointerArrives();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(onTrigger).toHaveBeenCalledTimes(1);

    pointerEvent('pointerleave');
    pointerArrives();
    await vi.advanceTimersByTimeAsync(DELAY * 2);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('hideTooltip 清掉未到点的计时器：气泡关了还"到点"就是偷偷烧额度', async () => {
    const onTrigger = withIntent();

    pointerArrives();
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    hideTooltip();
    await vi.advanceTimersByTimeAsync(DELAY * 2);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('把内容换成不带意图的一屏（pending / 译文）：上一代的计时当场作废', async () => {
    const onTrigger = withIntent();

    pointerArrives();
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    showTooltip(RECT, { text: '翻译中…', state: 'pending' });
    await vi.advanceTimersByTimeAsync(DELAY * 2);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('安全闸门：合成 pointerenter（isTrusted=false）不触发——页面脚本不能替用户停在气泡上', async () => {
    const onTrigger = withIntent();

    pointerEvent('pointerenter', false);
    pointerEvent('pointermove', false);
    await vi.advanceTimersByTimeAsync(DELAY * 2);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('成对断言：同一处监听器，真实手势的 pointerenter 照常触发（证明上一条不是"永远拒绝"）', async () => {
    const onTrigger = withIntent();

    pointerArrives();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('没带 hoverIntent 的普通气泡：进进出出什么都不发生（悬停翻译的移出保留不受影响）', async () => {
    showTooltip(RECT, { text: '译文' });

    pointerArrives();
    await vi.advanceTimersByTimeAsync(DELAY * 2);
    pointerEvent('pointerleave');
    pointerArrives();
    await vi.advanceTimersByTimeAsync(DELAY * 2);

    expect(isTooltipVisible()).toBe(true);
    expect(bubbleText()).toBe('译文');
  });

  it('计时器不因反复开合而泄漏：关闭再打开，只有新一代的那一次会触发', async () => {
    const first = withIntent();
    pointerArrives();
    hideTooltip();

    const second = vi.fn();
    showTooltip(RECT, { text: '第二段', variant: 'chip', hoverIntent: { delayMs: DELAY, onTrigger: second } });
    await vi.advanceTimersByTimeAsync(DELAY * 2);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled(); // 新一代也还没被指针进入过

    pointerArrives();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
