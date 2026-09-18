// src/content/toast.ts

const TOAST_ID = 'jy-toast';
/** 默认显示时长：一眼扫过的状态反馈（翻译失败、限流、页面级提示）。 */
const VISIBLE_MS = 3200;

/**
 * 页面内轻提示。固定挂在 documentElement 上，不受页面布局影响。
 *
 * `visibleMs` 是**可选**的显示时长，不传就是既有行为（3200ms）——翻译失败、限流这些状态
 * 反馈照旧一闪而过，既有调用方一个字都不用改。要留久一点的调用方（诊断模式）自己传值：
 * **默认之外该留多久是调用方的策略**，理由写在那边的 `DIAGNOSE_VISIBLE_MS` 上。
 */
export function toast(message: string, visibleMs: number = VISIBLE_MS): void {
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
  /**
   * 保留换行。诊断模式的提示是**两行**（结论 + 观察者读数），而宿主只有 inline style、
   * shadow root 里也没有样式表——真浏览器的默认 `white-space: normal` 会把 `\n` 折叠成
   * 一个空格，用户看到的是一行连排（jsdom 不做排版，测试永远发现不了）。
   *
   * `pre-line` 而不是 `pre`：只保留换行，其余空白照旧折叠、长行照旧换行——
   * 既有调用方（翻译失败提示、限流提示）发的都是单行文案，行为逐字不变。
   */
  span.style.whiteSpace = 'pre-line';
  shadow.append(span);

  document.documentElement.append(host);
  setTimeout(() => host.remove(), visibleMs);
}
