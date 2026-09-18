/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '../../src/content/toast';

const TOAST_ID = 'jy-toast';

function toastHost(): HTMLElement | null {
  return document.getElementById(TOAST_ID);
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('页面内轻提示', () => {
  it('挂在 documentElement 上并带插件标记，不受页面布局影响', () => {
    toast('翻译失败');

    const host = toastHost();
    expect(host).not.toBeNull();
    expect(host?.parentElement).toBe(document.documentElement);
    expect(host?.hasAttribute('data-jy-root')).toBe(true);
    expect(host?.shadowRoot?.textContent).toBe('翻译失败');
  });

  it('消息一律按纯文本写入，HTML 不会被解析', () => {
    toast('<img src=x onerror="window.__pwned = 1">');

    const host = toastHost();
    expect(host?.shadowRoot?.querySelector('img')).toBeNull();
    expect(host?.shadowRoot?.textContent).toBe('<img src=x onerror="window.__pwned = 1">');
  });

  it('同一时刻只有一个 toast：后一条替换前一条', () => {
    toast('第一条');
    toast('第二条');

    expect(document.querySelectorAll(`#${TOAST_ID}`)).toHaveLength(1);
    expect(toastHost()?.shadowRoot?.textContent).toBe('第二条');
  });

  it('到点自动消失', () => {
    toast('稍纵即逝');
    expect(toastHost()).not.toBeNull();

    vi.advanceTimersByTime(3200);
    expect(toastHost()).toBeNull();
  });

  /**
   * 默认时长是**既有调用方的契约**（翻译失败提示、限流提示），不许被新参数带跑：
   * 这里正负成对地钉住 3200ms 这个数——3199ms 还在、3200ms 消失。
   */
  it('不传时长：仍然是 3.2 秒（既有调用方行为逐字不变）', () => {
    toast('翻译失败');

    vi.advanceTimersByTime(3199);
    expect(toastHost()).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(toastHost()).toBeNull();
  });

  /**
   * 诊断模式那条提示要比默认那条留得久（用户的视线在被点的元素上，不在屏幕底部；
   * 3.2 秒多半直接错过）。这条钉住"传了时长就按时长走"，而不是"参数被忽略、仍按默认"。
   */
  it('显式传时长：寿命就是那个值，不再受默认的 3.2 秒摆布', () => {
    toast('诊断结论', 15000);

    vi.advanceTimersByTime(3200);
    expect(toastHost()).not.toBeNull(); // 默认那 3.2 秒已经不是它的寿命

    vi.advanceTimersByTime(15000 - 3200 - 1);
    expect(toastHost()).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(toastHost()).toBeNull();
  });

  it('不会污染页面结构：除了自己那一个节点，body 一个字节都不动', () => {
    document.body.innerHTML = '<p>Hello world</p>';
    const before = document.body.innerHTML;

    toast('提示');
    vi.advanceTimersByTime(3200);

    expect(document.body.innerHTML).toBe(before);
  });

  it('多行消息保留换行：文字节点的计算样式里 white-space 不是 normal', () => {
    toast('第一行\n第二行');

    const span = toastHost()?.shadowRoot?.querySelector('span');
    expect(span).toBeInstanceOf(HTMLElement);
    // 消息本身带换行（诊断模式就是两行：结论 + 观察者读数）。
    expect(span?.textContent).toBe('第一行\n第二行');

    // jsdom 不做排版，"两行会不会被折叠成一行"只能读**计算样式**回答。
    // 未设时 jsdom 给的是空串（不是 'normal'），所以这两条断言缺一不可：
    // 「不是 normal」挡住"被页面 CSS 折成一行"，「就是 pre-line」挡住"根本没设"。
    expect(getComputedStyle(span as HTMLElement).whiteSpace).not.toBe('normal');
    // pre-line：保留换行，其余空白照常折叠（pre 会把长行撑爆宿主宽度）。
    expect(getComputedStyle(span as HTMLElement).whiteSpace).toBe('pre-line');
    expect((span as HTMLElement).style.whiteSpace).toBe('pre-line');
  });

  it('换行保留不影响既有调用方：单行消息照旧原样显示、HTML 照旧不被解析', () => {
    toast('<b>翻译失败</b>');

    const shadow = toastHost()?.shadowRoot;
    expect(shadow?.querySelector('b')).toBeNull();
    expect(shadow?.textContent).toBe('<b>翻译失败</b>');
    // 单行消息没有任何换行，多出来的这条规则不会改动它的文本。
    expect(shadow?.textContent?.split('\n')).toHaveLength(1);
  });
});
