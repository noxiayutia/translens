/**
 * 页面级进度条。它存在的唯一理由：几百段的页面上，「翻译中…」/「排队中…」的占位文本
 * 不告诉用户总共多少段、现在到哪儿了（真机读数见 `.qa/p0-probe.mjs`）。
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clearProgress, showProgress, PROGRESS_ELEMENT_ID } from '../../src/content/progress';

const find = () => document.getElementById(PROGRESS_ELEMENT_ID);

describe('页面级翻译进度', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.querySelectorAll(`#${PROGRESS_ELEMENT_ID}`).forEach((n) => n.remove());
  });

  it('第一次显示就建出节点，文案是「已译 n/m 段」', () => {
    showProgress(document, 12, 40);
    expect(find()?.textContent).toBe('已译 12/40 段');
  });

  /** 每批都建一个新节点的话，一个 40 批的页面会在 documentElement 上堆 40 个浮层。 */
  it('重复更新是就地改文本，不堆节点', () => {
    showProgress(document, 1, 40);
    showProgress(document, 2, 40);
    showProgress(document, 3, 40);
    expect(document.querySelectorAll(`#${PROGRESS_ELEMENT_ID}`)).toHaveLength(1);
    expect(find()?.textContent).toBe('已译 3/40 段');
  });

  /**
   * 进度条挂在 documentElement 上，必须被采集端与观察者一票否决——
   * 否则它自己会被下一轮翻译，或被自己的 MutationObserver 当成页面变动。
   */
  it('带 data-jy-root：插件自己的浮层不参与采集与增量', () => {
    showProgress(document, 1, 2);
    expect(find()?.hasAttribute('data-jy-root')).toBe(true);
  });

  it('clear 之后节点消失，再显示可以重新建', () => {
    showProgress(document, 5, 5);
    clearProgress(document);
    expect(find()).toBeNull();
    showProgress(document, 1, 9);
    expect(find()?.textContent).toBe('已译 1/9 段');
  });

  /** 读屏每批被播报一次会淹掉用户；这条钉住"它只是给人眼看的"这个决定。 */
  it('不带 aria-live：进度不是给读屏的状态公告', () => {
    showProgress(document, 1, 2);
    expect(find()?.getAttribute('aria-live')).toBeNull();
  });
});
