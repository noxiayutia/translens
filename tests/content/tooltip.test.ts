/**
 * @vitest-environment jsdom
 *
 * 悬停/划词共用的 fixed 浮层（tooltip）。两组诉求分开钉：
 * - **定位数学**是纯函数 `positionTooltip`——jsdom 量不出尺寸（offsetWidth/Height 恒为 0），
 *   翻转与收界的规则只能按 (rect, size, viewport) 显式喂给它来测；
 * - **DOM 纪律**（挂哪、带什么标记、怎么关、内容怎么写入）走 show/hide 的真实路径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hideTooltip, isTooltipVisible, positionTooltip, showTooltip } from '../../src/content/tooltip';

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

/** jsdom 的视口默认 1024×768；show() 的定位断言以此为前提。 */
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
