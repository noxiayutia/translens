
/**
 * 注入译文宿主的 Shadow DOM。
 * 页面 CSS 进不来，译文样式也出不去，双向隔离。
 */
export const TRANSLATION_CSS = `
  :host { display: block; }
  .jy-body {
    display: block;
    margin: 0.35em 0 0.15em;
    line-height: 1.6;
    font-size: 0.97em;
    color: #2b6cb0;
    border-left: 2px solid rgba(43, 108, 176, 0.35);
    padding-left: 0.6em;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .jy-body.jy-pending { color: #9aa5b1; border-left-color: rgba(154, 165, 177, 0.35); }
  .jy-body.jy-error { color: #b3261e; border-left-color: rgba(179, 38, 30, 0.35); }
  .jy-retry {
    margin-left: 0.5em;
    padding: 0 0.5em;
    font: inherit;
    font-size: 0.85em;
    color: inherit;
    background: transparent;
    border: 1px solid currentColor;
    border-radius: 4px;
    cursor: pointer;
  }
`;

/**
 * 「仅译文」模式的译文样式：**刻意做到样式透明**。
 *
 * 这个模式下译文是**替代**原文的，所以它必须长得和原文一模一样。上面那套区分性样式
 * 在这里每一条都是破坏，而且是实测踩出来的（apple.com 的小按钮）：
 *
 * - 硬编码 `color` 会盖掉元素自己的颜色 —— `.button` 是白字蓝底，译文变成蓝底上的深蓝字，
 *   几乎看不见；
 * - `border-left` + `padding-left` 给按钮凭空加了约 11px 宽（用户报的「变长了」）；
 * - `margin` 与 `line-height: 1.6` 撑高行盒（用户报的「大小变了」）；
 * - `font-size: 0.97em` 让字号与周围文字脱节（用户报的「字体大小变了」）；
 * - `display: block` 把 `<a class="button">` 里的行内文字撑成块，直接换行。
 *
 * 所以这里一律走 `inherit`，并用 `display: inline` 让文字回到原来的行内流里。
 * `white-space` 也必须继承：按钮常写 `nowrap`，我们若强行 `pre-wrap` 就会让它撑成两行。
 *
 * 只有**错误态**保留颜色 —— 那是有意要跳出来的信号，不是排版。
 */
export const TRANSLATION_INLINE_CSS = `
  :host { display: inline; }
  .jy-body {
    display: inline;
    margin: 0;
    padding: 0;
    border: 0;
    font: inherit;
    line-height: inherit;
    color: inherit;
    white-space: inherit;
    overflow-wrap: break-word;
  }
  .jy-body.jy-pending { opacity: 0.55; }
  .jy-body.jy-error { color: #b3261e; }
  .jy-retry {
    margin-left: 0.4em;
    padding: 0 0.4em;
    font: inherit;
    font-size: 0.85em;
    color: inherit;
    background: transparent;
    border: 1px solid currentColor;
    border-radius: 4px;
    cursor: pointer;
  }
`;
