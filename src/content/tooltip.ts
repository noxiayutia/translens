// src/content/tooltip.ts

/**
 * 悬停翻译与划词翻译**共用**的浮层。它的设计约束来自上一个真实 bug：
 * 我们给译文宿主注入的 `border-left` + `padding-left` 把 apple.com 的小按钮撑宽了约 11px。
 * 教训是「任何参与布局的注入都会破坏页面」，所以这里：
 *
 * - 永远 `position: fixed` 挂在 `document.documentElement` 上，**绝不插进页面内容里**；
 * - 带 `data-jy-root` 标记，采集端（extractor）会把整棵子树跳过，不会被二次翻译；
 * - 所有来自接口的文字一律 `textContent` 写入，禁止 innerHTML（引擎返回内容不可信）；
 * - `max-height` + `overflow: auto`：超长译文在气泡内部滚动，不会把页面撑出滚动条；
 * - 与 toast 不同，气泡**必须可交互**（复制/朗读按钮），所以没有 `pointer-events: none`。
 */

/** 与给定矩形保持的间距（像素）。 */
const GAP = 8;
/** 与视口边缘保持的最小间距（像素）。 */
const MARGIN = 8;

/** show() 接受的矩形：DOMRect 或任何带这四个数的对象（测试可手搓）。 */
export interface TooltipRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** 气泡自身渲染后的尺寸（测量结果；jsdom 下恒为 0，定位规则由纯函数单测覆盖）。 */
export interface TooltipSize {
  width: number;
  height: number;
}

export interface TooltipViewport {
  width: number;
  height: number;
}

export interface TooltipPosition {
  left: number;
  top: number;
}

export interface TooltipButton {
  label: string;
  /** 点击回调；参数是按钮自身，用来就地改文案（「复制」→「已复制」）。 */
  onClick: (button: HTMLButtonElement) => void;
}

export interface TooltipContent {
  /** 唯一的内容通道：一律 textContent 写入，引擎返回什么都只是文字。 */
  text: string;
  buttons?: TooltipButton[];
}

const HOST_ID = 'jy-tooltip';

const TOOLTIP_CSS = `
  .jy-bubble {
    font: 13px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #fff;
    background: rgba(17, 24, 39, 0.95);
    border-radius: 8px;
    padding: 10px 12px;
    max-width: 360px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.24);
    /* 超长译文在气泡内滚动，绝不把页面撑出滚动条。 */
    max-height: 40vh;
    overflow: auto;
  }
  .jy-text { white-space: pre-wrap; overflow-wrap: break-word; }
  .jy-actions { display: flex; gap: 8px; margin-top: 8px; }
  .jy-action {
    font: inherit;
    font-size: 12px;
    color: inherit;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.55);
    border-radius: 5px;
    padding: 2px 10px;
    cursor: pointer;
  }
`;

interface Listeners {
  pointerdown: (event: PointerEvent) => void;
  keydown: (event: KeyboardEvent) => void;
  scroll: () => void;
}

let host: HTMLElement | null = null;
/** 打开期间才存在的监听器；hide() 必须逐个摘掉，否则反复开合会把窗口挂满僵尸监听。 */
let listeners: Listeners | null = null;
/**
 * 按钮回调表：按钮元素 → 回调。点击走 host 上的**委托**（挂在 host 本身，
 * shadow 里的 click 会冒泡到 host），气泡重渲染时旧按钮连同条目一起被丢弃，
 * 用 WeakMap 就不存在"上一代气泡的回调泄漏"这回事。
 */
let buttonHandlers = new WeakMap<HTMLButtonElement, (button: HTMLButtonElement) => void>();

/**
 * 定位规则（纯函数，尺寸由调用方测量后传入，方便在 jsdom 下测——那边量出来恒为 0）：
 *
 * 1. 默认放在矩形**下方**；下方放不下翻到上方；上方也放不下贴视口底；
 * 2. 上下都贴不住时至少保证顶边不越过 MARGIN（宁可被裁也不要消失）；
 * 3. 水平方向以矩形左边为起点，越界向内收，左界也不破 MARGIN。
 */
export function positionTooltip(
  rect: TooltipRect,
  size: TooltipSize,
  viewport: TooltipViewport,
): TooltipPosition {
  const bottom = rect.top + rect.height;
  let top = bottom + GAP;
  if (top + size.height > viewport.height - MARGIN) {
    top = rect.top - GAP - size.height;
  }
  if (top < MARGIN) {
    // 上方也放不下：贴 viewport 底；气泡自己比视口还高时退回顶边（宁可裁也不要消失）。
    top = Math.max(MARGIN, viewport.height - MARGIN - size.height);
  }
  let left = rect.left;
  if (left + size.width > viewport.width - MARGIN) {
    left = viewport.width - MARGIN - size.width;
  }
  if (left < MARGIN) left = MARGIN;
  return { left, top };
}

function viewportSize(): TooltipViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function buildBubble(content: TooltipContent): HTMLElement {
  const bubble = document.createElement('div');
  bubble.className = 'jy-bubble';

  const text = document.createElement('div');
  text.className = 'jy-text';
  // 一律 textContent：`<img src=x onerror=…>` 进来也只是这串字符。
  text.textContent = content.text;
  bubble.append(text);

  if (content.buttons && content.buttons.length > 0) {
    const actions = document.createElement('div');
    actions.className = 'jy-actions';
    for (const entry of content.buttons) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'jy-action';
      // 按钮文案虽然出自本扩展（不是引擎返回），也不破例：一律 textContent，规则只有一条。
      button.textContent = entry.label;
      buttonHandlers.set(button, entry.onClick);
      actions.append(button);
    }
    bubble.append(actions);
  }
  return bubble;
}

function onHostClick(event: Event): void {
  for (const node of event.composedPath()) {
    if (node instanceof HTMLButtonElement) {
      buttonHandlers.get(node)?.(node);
      return;
    }
  }
}

/** 拿到（必要时创建）气泡宿主。挂在 documentElement 上——页面脚本看不见我们。 */
function ensureHost(): { node: HTMLElement; style: HTMLStyleElement } {
  if (host !== null && host.shadowRoot !== null) {
    // 创建时就注入的 <style>，这里只是把类型收窄回去。
    const style = host.shadowRoot.querySelector('style') as HTMLStyleElement;
    return { node: host, style };
  }
  const created = document.createElement('div');
  created.id = HOST_ID;
  // 采集端与悬停判定的整棵子树跳过标记：气泡里的文字绝不会再被当成"页面段落"。
  created.setAttribute('data-jy-root', '');
  created.setAttribute('data-jy-tooltip', '');
  created.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'left:0',
    'top:0',
    // 有意**不是** pointer-events:none——气泡里有按钮（toast 才是不吃事件的提示条）。
    'pointer-events:auto',
  ].join(';');
  const shadow = created.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = TOOLTIP_CSS;
  shadow.append(style);
  // 委托挂在 host 本身：气泡内容每次重建，接线却只有这一份。
  created.addEventListener('click', onHostClick);
  host = created;
  return { node: created, style };
}

function measure(node: HTMLElement): TooltipSize {
  // offsetWidth/offsetHeight：不含 outline、不受祖先裁剪影响的盒尺寸。
  return { width: node.offsetWidth, height: node.offsetHeight };
}

function detachListeners(): void {
  if (listeners === null) return;
  window.removeEventListener('pointerdown', listeners.pointerdown, true);
  window.removeEventListener('keydown', listeners.keydown);
  window.removeEventListener('scroll', listeners.scroll, true);
  listeners = null;
}

/**
 * 显示/刷新气泡（单例：同一时刻只存在一个，重复调用是替换内容与位置）。
 * 打开期间挂三种关闭途径：点外部（pointerdown 捕获）、Escape、页面滚动（捕获阶段）；
 * hide() 时全部摘掉。
 */
export function showTooltip(rect: TooltipRect, content: TooltipContent): void {
  const { node, style } = ensureHost();
  node.shadowRoot?.replaceChildren(style, buildBubble(content));
  // 首次显示、以及被外部（测试清理、扩展热更）摘掉后再显示：一律确保它真的在树上。
  if (!node.isConnected) document.documentElement.append(node);
  const position = positionTooltip(rect, measure(node), viewportSize());
  node.style.left = `${position.left}px`;
  node.style.top = `${position.top}px`;

  if (listeners !== null) return;
  const onPointerdown = (event: PointerEvent): void => {
    // 气泡内部（含 Shadow DOM 里的按钮）的按下不算"点外部"；composedPath 穿透 shadow 边界。
    if (host !== null && event.composedPath().includes(host)) return;
    hideTooltip();
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') hideTooltip();
  };
  // 页面滚动就消失（fixed 浮层会留在原地骗人）。与"移出段落保留译文"不冲突：
  // 静止阅读什么都没有，一旦滚动说明用户在动，浮着的气泡只会挡路。
  const onScroll = (): void => hideTooltip();
  window.addEventListener('pointerdown', onPointerdown, true);
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('scroll', onScroll, true);
  listeners = { pointerdown: onPointerdown, keydown: onKeydown, scroll: onScroll };
}

/** 关闭气泡并摘掉全部监听；没有气泡时是空操作。 */
export function hideTooltip(): void {
  detachListeners();
  if (host === null) return;
  host.remove();
  host = null;
  // 旧气泡的按钮回调随节点一起丢；换新的表最干净（WeakMap 本也会回收，这里只是明确生命周期）。
  buttonHandlers = new WeakMap();
}

/** 当前是否有气泡打开着。 */
export function isTooltipVisible(): boolean {
  return host !== null;
}
