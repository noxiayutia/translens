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

function css(): string {
  return host()?.shadowRoot?.querySelector('style')?.textContent ?? '';
}

/** 取样式表里某条规则的声明块（从选择器字面量切到下一个 `}`）。 */
function rule(selector: string): string {
  const text = css();
  const start = text.indexOf(selector);
  if (start < 0) throw new Error(`样式表里没有 ${selector}`);
  return text.slice(start, text.indexOf('}', start));
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

  it('超长译文：max-height + overflow:auto，不靠撑高页面解决', () => {
    showTooltip(RECT, { text: '很长' });
    const css = host()?.shadowRoot?.querySelector('style')?.textContent ?? '';
    expect(css).toContain('max-height');
    expect(css).toMatch(/overflow:\s*auto/);
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
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
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

  it('点气泡内部（按钮）不关闭——否则复制/朗读永远点不到', () => {
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
    expect(css()).toContain('--jy-surface: rgba(24, 26, 30, 0.97)');
    expect(css()).toContain('--jy-border: rgba(255, 255, 255, 0.1)');
    expect(css()).toContain('--jy-radius-md: 10px');

    const box = rule('.jy-bubble {');
    expect(box).toContain('background: var(--jy-surface)');
    expect(box).toContain('border: 1px solid var(--jy-border)');
    expect(box).toContain('border-radius: var(--jy-radius-md)');
    expect(box).toContain('padding: 12px 14px');
    expect(box).toContain('max-width: 400px');
  });

  it('阴影分两层：近处一条细阴影 + 远处一片柔阴影（不是单层大黑影）', () => {
    showTooltip(RECT, { text: '译文' });
    expect(rule('.jy-bubble {')).toMatch(
      /box-shadow:\s*0 1px 2px rgba\(0, 0, 0, 0\.28\),\s*0 8px 24px rgba\(0, 0, 0, 0\.32\)/,
    );
  });

  it('文字：13px/1.65 + 抗锯齿 + pre-wrap/break-word + 译文可选中复制', () => {
    showTooltip(RECT, { text: '译文' });
    const box = rule('.jy-bubble {');
    expect(box).toContain('font: 13px/1.65');
    expect(box).toContain('-webkit-font-smoothing: antialiased');

    const text = rule('.jy-text {');
    expect(text).toContain('white-space: pre-wrap');
    expect(text).toContain('overflow-wrap: break-word');
    // 译文要能被框选去复制；页面上的 user-select:none 会顺着继承查到浮层头上，得显式挡住。
    expect(text).toMatch(/user-select:\s*text/);
  });

  it('滚动条：细 + 深色适配（scrollbar-* 与 ::-webkit-scrollbar 两套都写）', () => {
    showTooltip(RECT, { text: '译文' });
    const box = rule('.jy-bubble {');
    expect(box).toContain('scrollbar-width: thin');
    expect(box).toMatch(/scrollbar-color:\s*rgba\(255, 255, 255, 0\.28\) transparent/);
    expect(css()).toContain('.jy-bubble::-webkit-scrollbar {');
    expect(rule('.jy-bubble::-webkit-scrollbar-thumb {')).toMatch(/background:\s*rgba\(255, 255, 255, 0\.28\)/);
  });

  /**
   * 尺寸口径：shadow 里统一 border-box，声明出来的 400px / 40vh / 26px 就是**看得见**的那个盒子。
   * 少了这一条，400px 的内容盒会渲染成 428px，而宿主（`measure()` 量的、caret 与越界收回都按它算）
   * 只有 400px——右边缘的收回会差出 28px。
   */
  it('shadow 里统一 border-box：声明的 400px / 26px 就是可见盒子，宿主量与气泡等宽', () => {
    showTooltip(RECT, { text: '译文' });
    const reset = rule('.jy-layer,\n  .jy-layer * {');
    expect(reset).toContain('box-sizing: border-box');
    // 上限仍写在气泡上（400px），收边口径的那一层也跟着它。
    expect(rule('.jy-bubble {')).toContain('max-width: 400px');
    expect(rule('.jy-layer {')).toContain('max-width: 400px');
  });
});

describe('按钮：主操作实心、次操作半透明，都带内联 SVG 图标', () => {
  function twoButtons(): HTMLButtonElement[] {
    showTooltip(RECT, {
      text: '译文',
      buttons: [
        { label: '复制', variant: 'primary', icon: 'copy', onClick: () => {} },
        { label: '朗读', icon: 'speak', onClick: () => {} },
      ],
    });
    return buttons();
  }

  it('复制是实心强调色主按钮、朗读是半透明白底次按钮；两者仍是 <button type="button">', () => {
    const [copy, speak] = twoButtons();
    expect(copy?.tagName).toBe('BUTTON');
    expect(copy?.type).toBe('button');
    expect(copy?.getAttribute('data-variant')).toBe('primary');
    expect(speak?.tagName).toBe('BUTTON');
    expect(speak?.getAttribute('data-variant')).toBe('secondary');

    expect(css()).toContain('--jy-accent: #2563eb');
    expect(rule('.jy-action[data-variant="primary"] {')).toContain('background: var(--jy-accent)');
    const base = rule('.jy-action {');
    expect(base).toMatch(/background:\s*rgba\(255, 255, 255, 0\.1\)/);
    expect(base).toContain('height: 26px');
    expect(base).toContain('padding: 0 10px');
    expect(base).toContain('font-size: 12px');
    expect(base).toContain('gap: 6px');
    expect(base).toContain('border-radius: var(--jy-radius-sm)');
  });

  it('三态齐全：hover / active / focus-visible（焦点环是浅色，深底上看得见）', () => {
    twoButtons();
    expect(rule('.jy-action:hover {')).toMatch(/background:\s*rgba\(255, 255, 255, 0\.16\)/);
    expect(rule('.jy-action:active {')).toMatch(/background:\s*rgba\(255, 255, 255, 0\.22\)/);
    expect(rule('.jy-action[data-variant="primary"]:hover {')).toContain('var(--jy-accent-hover)');
    expect(rule('.jy-action[data-variant="primary"]:active {')).toContain('filter: brightness(0.94)');
    expect(rule('.jy-action:focus-visible {')).toMatch(/outline:\s*2px solid rgba\(255, 255, 255, 0\.85\)/);
  });

  it('每个按钮前面一个内联 SVG 图标：14×14、currentColor、纯装饰、排在标签之前', () => {
    const rendered = twoButtons();
    // 复制是两个方框（rect + path），朗读是喇叭 + 声波（path + path）。
    const shapesPerIcon = [2, 2];

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

    expect(rule('.jy-action-icon {')).toMatch(/width:\s*14px/);
    expect(rule('.jy-action-icon {')).toMatch(/height:\s*14px/);
  });

  it('点图标本身也算点按钮：委托认的是 composedPath 里的按钮，不是 event.target', () => {
    const onClick = vi.fn();
    showTooltip(RECT, { text: '译文', buttons: [{ label: '复制', variant: 'primary', icon: 'copy', onClick }] });

    const button = buttons()[0] as HTMLButtonElement;
    const svg = button.querySelector('svg') as SVGElement;
    // composed:true：真实点击落在 shadow 里的图标上，照样要穿过边界到 host 的委托。
    svg.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0]?.[0]).toBe(button);
  });

  it('两个按钮各自回调、互不串台', () => {
    const copy = vi.fn();
    const speak = vi.fn();
    showTooltip(RECT, {
      text: '译文',
      buttons: [
        { label: '复制', variant: 'primary', icon: 'copy', onClick: copy },
        { label: '朗读', icon: 'speak', onClick: speak },
      ],
    });

    const [first, second] = buttons();
    first?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    second?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(copy).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it('改文案走 setActionLabel：图标留下、只换标签（直接写 textContent 会把图标抹掉）', () => {
    showTooltip(RECT, {
      text: '译文',
      buttons: [
        { label: '复制', variant: 'primary', icon: 'copy', onClick: (button) => setActionLabel(button, '已复制') },
      ],
    });

    const button = buttons()[0] as HTMLButtonElement;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(button.textContent).toBe('已复制');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.querySelector('.jy-action-label')?.textContent).toBe('已复制');
  });
});

describe('状态：翻译中与失败', () => {
  it('pending：降饱和的次级色 + 轻微脉冲，reduced-motion 下不动', () => {
    showTooltip(RECT, { text: '翻译中…', state: 'pending' });
    expect(bubbleNode()?.getAttribute('data-state')).toBe('pending');
    expect(css()).toContain('--jy-text-2: #a8b0bb');

    const pending = rule('.jy-bubble[data-state="pending"] .jy-text {');
    expect(pending).toContain('color: var(--jy-text-2)');
    expect(pending).toContain('animation: jy-pulse');
    expect(css()).toContain('@keyframes jy-pulse');
    // 降级在 media query 里：拿第一段 pending 规则之后的整块来核对 animation:none。
    const reduced = css().slice(css().indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/animation:\s*none/);
  });

  it('error：深底上提亮过的红，且只是文字——不挂可点的按钮', () => {
    showTooltip(RECT, { text: '无法连接后台：Receiving end does not exist.', state: 'error' });
    expect(bubbleNode()?.getAttribute('data-state')).toBe('error');
    expect(css()).toContain('--jy-danger: #f87171');
    expect(rule('.jy-bubble[data-state="error"] .jy-text {')).toContain('color: var(--jy-danger)');
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
    const caret = rule('.jy-layer::after {');
    expect(caret).toMatch(/width:\s*8px/);
    expect(caret).toMatch(/height:\s*8px/);
    expect(caret).toContain('rotate(45deg)');
    expect(caret).toContain('background: var(--jy-surface)');
    // 方向跟着气泡上的 data-placement：翻到上方时箭头改露在下边缘。
    expect(css()).toContain('.jy-layer:has(> .jy-bubble[data-placement="top"])::after');
  });
});
