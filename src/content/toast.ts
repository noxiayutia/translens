// src/content/toast.ts

const TOAST_ID = 'jy-toast';
const VISIBLE_MS = 3200;

/** 页面内轻提示。固定挂在 documentElement 上，不受页面布局影响。 */
export function toast(message: string): void {
  const existing = document.getElementById(TOAST_ID);
  if (existing) existing.remove();

  const host = document.createElement('div');
  host.id = TOAST_ID;
  host.setAttribute('data-jy-root', '');
  host.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'left:50%',
    'bottom:32px',
    'transform:translateX(-50%)',
    'padding:10px 16px',
    'border-radius:8px',
    'background:rgba(17,24,39,0.92)',
    'color:#fff',
    'font:14px/1.5 system-ui,sans-serif',
    'box-shadow:0 4px 16px rgba(0,0,0,0.24)',
    'pointer-events:none',
  ].join(';');

  const shadow = host.attachShadow({ mode: 'open' });
  const span = document.createElement('span');
  // 一律用 textContent：错误信息里可能带引擎返回的原文片段，绝不能被当成 HTML 解析。
  span.textContent = message;
  shadow.append(span);

  document.documentElement.append(host);
  setTimeout(() => host.remove(), VISIBLE_MS);
}
