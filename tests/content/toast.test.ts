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

  it('不会污染页面结构：除了自己那一个节点，body 一个字节都不动', () => {
    document.body.innerHTML = '<p>Hello world</p>';
    const before = document.body.innerHTML;

    toast('提示');
    vi.advanceTimersByTime(3200);

    expect(document.body.innerHTML).toBe(before);
  });
});
