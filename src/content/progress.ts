/**
 * 页面级的翻译进度（「已译 n/m 段」）。
 *
 * 为什么要有它：一轮整页翻译在几百段的页面上要跑几十秒到几分钟，而页面上只有
 * 一片「翻译中…」/「排队中…」的占位文本——**没有任何一个数字告诉用户总共多少段、
 * 现在到哪儿了**。真机读数还证明了更糟的一层：标签页被节流到每分钟醒一次时，
 * 进度数字是唯一能看出"它在推进"的东西（`.qa/p0-probe.mjs`）。
 *
 * 刻意**不带 `aria-live`**：每批落地都刷一次，一个 40 批的页面就是 40 次播报，
 * 屏幕阅读器会被它淹掉——而这一轮结束后结果本来就在正文里。
 * 它是一条给人眼看的进度，不是给读屏的状态公告。
 */
const PROGRESS_ID = 'jy-progress';

function host(document: Document): HTMLElement {
  const existing = document.getElementById(PROGRESS_ID);
  if (existing !== null) return existing;
  const element = document.createElement('div');
  element.id = PROGRESS_ID;
  // `data-jy-root` 让采集端与观察者对这一整棵子树一票否决（插件自己的浮层不能自增）。
  element.setAttribute('data-jy-root', '');
  element.style.cssText = [
    'position:fixed',
    'z-index:2147483646',
    'left:12px',
    'bottom:12px',
    'padding:6px 10px',
    'border-radius:6px',
    'background:rgba(17,24,39,0.85)',
    'color:#fff',
    'font:12px/1.4 system-ui,sans-serif',
    'pointer-events:none',
  ].join(';');
  document.documentElement.append(element);
  return element;
}

/** 显示或更新进度。done 包含失败的那些段——它们也是"有结论了"。 */
export function showProgress(document: Document, done: number, total: number): void {
  const element = host(document);
  element.textContent = `已译 ${String(done)}/${String(total)} 段`;
  element.hidden = false;
}

export function clearProgress(document: Document): void {
  document.getElementById(PROGRESS_ID)?.remove();
}

/** 进度条的 id，测试与还原路径都按它找。 */
export const PROGRESS_ELEMENT_ID = PROGRESS_ID;
