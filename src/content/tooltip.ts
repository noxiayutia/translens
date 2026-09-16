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
 *
 * 观感上与弹窗/设置页（popup.css / options.css）同一套设计语言：中性深色表面 + 单一强调色，
 * 层级靠一条细边框、一层分层阴影和留白，不靠颜色堆砌。三处共用的颜色值各写一份令牌，
 * 不引第三个文件——浮层跑在页面的 shadow DOM 里，既借不到扩展页面的 `:root`，也不该往页面
 * 的 `:root` 里写东西。
 *
 * DOM 结构（shadow 内）：
 *   .jy-layer            ← 定位与 caret 的锚（气泡自己 overflow:auto 裁不了探出去的箭头）
 *     .jy-bubble         ← 表面：背景/边框/圆角/阴影/max-height、data-placement、data-state
 *       .jy-text         ← 译文（可选中复制）
 *       .jy-actions      ← 按钮行
 *         .jy-action     ← 按钮（图标 + 文案）
 */

/** 与给定矩形保持的间距（像素）。 */
const GAP = 8;
/** 与视口边缘保持的最小间距（像素）。 */
const MARGIN = 8;
/**
 * caret 中心距气泡左右边缘的最小距离（像素）。圆角是 10px、caret 转 45° 后的半宽约 5.7px，
 * 16px 保证箭头整个落在直边上，不骑在圆角上，也不飘出气泡。
 */
const CARET_INSET = 16;

const SVG_NS = 'http://www.w3.org/2000/svg';

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

/** 气泡落在选区的哪一侧：'bottom' = 在选区下方（caret 露在气泡上边缘，指向上）。 */
export type TooltipPlacement = 'top' | 'bottom';

/**
 * 定位结果 + 两个**只影响观感**的量。定位数学一个字没动（`positionTooltip` 仍旧是那份
 * 纯函数、仍旧只返回 `{left, top}`），这里只是在它的结果上算出 caret 该朝哪、落在哪。
 */
export interface TooltipLayout extends TooltipPosition {
  placement: TooltipPlacement;
  /** caret 中心相对气泡左边缘的水平偏移；量不到宽度时为 null（交给 CSS 的 50% 兜底）。 */
  caretX: number | null;
}

/** 气泡的视觉状态：pending = 请求在飞（次级色 + 脉冲），error = 失败文案（偏红的浅色）。 */
export type TooltipState = 'done' | 'pending' | 'error';

/** 按钮图标的名字。图标一律在 createIcon 里用 createElementNS 造出来。 */
export type TooltipIcon = 'copy' | 'speak';

export interface TooltipButton {
  label: string;
  /** 'primary' = 实心强调色的主操作（复制）；省略即半透明白底的次操作（朗读）。 */
  variant?: 'primary' | 'secondary';
  icon?: TooltipIcon;
  /** 点击回调；参数是按钮自身，用来就地改文案（「复制」→「已复制」）。 */
  onClick: (button: HTMLButtonElement) => void;
}

export interface TooltipContent {
  /** 唯一的内容通道：一律 textContent 写入，引擎返回什么都只是文字。 */
  text: string;
  /** 视觉状态；省略即普通译文。 */
  state?: TooltipState;
  buttons?: TooltipButton[];
}

const HOST_ID = 'jy-tooltip';

/**
 * 图标形状：24×24 视框、`currentColor` 描边，与文字同色、同样 14px。
 * 写成数据而不是 SVG 字符串模板：译文那条纪律（只 textContent / setAttribute，不碰
 * innerHTML）对图标同样成立——这里没有任何一处把字符串当 HTML 解析。
 */
const ICONS: Record<TooltipIcon, ReadonlyArray<{ tag: string; attrs: Record<string, string> }>> = {
  // 复制：两个叠起来的方框（前框 + 只画左上两边的后框）。
  copy: [
    { tag: 'rect', attrs: { x: '9', y: '9', width: '12', height: '12', rx: '2' } },
    { tag: 'path', attrs: { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' } },
  ],
  // 朗读：喇叭 + 一道声波。
  speak: [
    { tag: 'path', attrs: { d: 'M11 5 6 9H2v6h6l5 4z' } },
    { tag: 'path', attrs: { d: 'M15.54 8.46a5 5 0 0 1 0 7.07' } },
  ],
};

const TOOLTIP_CSS = `
  :host {
    /* 令牌：与 popup.css / options.css 同一套设计语言里的「深色浮层」一档。
       浮层永远压在**别人的页面**上，跟着页面亮暗切换只会更难看清，所以只要一套值。
       没有 backdrop-filter：底色是 0.97 不透明度，模糊几乎看不见，却要在任意页面上
       多买一个合成层——这笔账不划算，降级路径（不支持时背景仍清晰）也就不需要了。 */
    --jy-surface: rgba(24, 26, 30, 0.97);
    --jy-border: rgba(255, 255, 255, 0.1);
    --jy-border-strong: rgba(255, 255, 255, 0.16);
    --jy-text: #ffffff;
    --jy-text-2: #a8b0bb;
    --jy-danger: #f87171;
    --jy-accent: #2563eb;
    --jy-accent-hover: #1d4ed8;
    --jy-radius-md: 10px;
    --jy-radius-sm: 6px;
  }

  /* shadow 里只有我们自己的元素，统一 border-box：max-width:400px、max-height:40vh、
     26px 的按钮高度都按**可见盒子**算，caret 的收边口径（量的是宿主 = 这一层）也才和气泡的
     真实宽度完全一致。少了这一条，400px 的内容盒 + 28px 内边距 = 428px 的可见气泡，
     宿主却只量到 400px，右边缘的越界收回会差出这 28px。 */
  .jy-layer,
  .jy-layer * {
    box-sizing: border-box;
  }

  /* caret 的锚层。气泡自己必须 overflow:auto（超长译文内滚），画在它上面的 ::after
     会被那个 overflow 裁掉，所以探出气泡的箭头只能画在外层。宽度上限与气泡一致：
     宿主（定位测量量的就是这个盒子）不许比气泡更宽，caret 的收边口径才和气泡对得上。 */
  .jy-layer {
    position: relative;
    max-width: 400px;
  }

  /* 指向被划选文字的小箭头：8px 方块转 45°，露在外面的只有半个菱形。
     与气泡同色同边框，且 z-index 更低（压在气泡下面），重叠的那半被气泡自身
     近乎不透明的底盖住，接缝自然。 */
  .jy-layer::after {
    content: "";
    position: absolute;
    z-index: 0;
    left: var(--jy-caret-x, 50%);
    top: -4px;
    width: 8px;
    height: 8px;
    background: var(--jy-surface);
    border: 1px solid var(--jy-border);
    transform: translateX(-50%) rotate(45deg);
  }

  /* 气泡翻到选区上方时箭头改露在下边缘。方向跟着气泡上的 data-placement 走；
     万一引擎不认 :has()（Chrome 105 以下），退化成上面那条「箭头在上」，只是方向不对，
     不会破版，也不会动到任何定位数学。 */
  .jy-layer:has(> .jy-bubble[data-placement="top"])::after {
    top: auto;
    bottom: -4px;
  }

  .jy-bubble {
    position: relative;
    z-index: 1;
    font: 13px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
    color: var(--jy-text);
    background: var(--jy-surface);
    border: 1px solid var(--jy-border);
    border-radius: var(--jy-radius-md);
    padding: 12px 14px;
    max-width: 400px;
    /* 分层阴影：近处一条细阴影勾出边缘，远处一片柔阴影托起层次。
       单层大黑影在浅色页面上糊成一团、在深色页面上又看不见边。 */
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.28), 0 8px 24px rgba(0, 0, 0, 0.32);
    /* 超长译文在气泡内滚动，绝不把页面撑出滚动条。 */
    max-height: 40vh;
    overflow: auto;
    /* 深色浮层里的细滚动条：Firefox 走 scrollbar-*，Chrome/Safari 走 ::-webkit-scrollbar。 */
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.28) transparent;
  }

  .jy-bubble::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }
  .jy-bubble::-webkit-scrollbar-track {
    background: transparent;
  }
  .jy-bubble::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.28);
    border-radius: 999px;
  }
  .jy-bubble::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.42);
  }

  .jy-text {
    white-space: pre-wrap;
    overflow-wrap: break-word;
    /* 译文可以框选去复制。页面上的 user-select:none 会按「used value 继承」查到浮层头上，
       显式声明把门关回去。选中气泡里的文字不会造成自翻译：那是 data-jy-root 子树，
       采集端跳过、划词入口也跳过（见 selection.ts 的 isOwnOverlay）。 */
    user-select: text;
    -webkit-user-select: text;
  }

  /* 翻译中：降饱和的次级色 + 轻微脉冲（这一屏只有一行字，呼吸比转圈合适）。 */
  .jy-bubble[data-state="pending"] .jy-text {
    color: var(--jy-text-2);
    animation: jy-pulse 1.4s ease-in-out infinite;
  }

  /* 失败：深底上提亮过的红，是**文字**不是按钮（失败态没有可复制/朗读的东西）。 */
  .jy-bubble[data-state="error"] .jy-text {
    color: var(--jy-danger);
  }

  @keyframes jy-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.55;
    }
  }

  .jy-actions {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }

  .jy-action {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 10px;
    font: inherit;
    font-size: 12px;
    line-height: 1;
    border: 1px solid transparent;
    border-radius: var(--jy-radius-sm);
    cursor: pointer;
    /* 次按钮（朗读）：半透明白底 + 一道描边。 */
    color: var(--jy-text);
    background: rgba(255, 255, 255, 0.1);
    border-color: var(--jy-border-strong);
  }

  .jy-action:hover {
    background: rgba(255, 255, 255, 0.16);
  }

  .jy-action:active {
    background: rgba(255, 255, 255, 0.22);
  }

  /* 键盘焦点环在深底上必须用**浅色**：深色环落在深色气泡里等于没有焦点提示。 */
  .jy-action:focus-visible {
    outline: 2px solid rgba(255, 255, 255, 0.85);
    outline-offset: 2px;
  }

  /* 主按钮（复制）：这一屏唯一的实心强调色，与弹窗的 .primary 同一个蓝。 */
  .jy-action[data-variant="primary"] {
    color: #ffffff;
    background: var(--jy-accent);
    border-color: transparent;
  }

  .jy-action[data-variant="primary"]:hover {
    background: var(--jy-accent-hover);
  }

  .jy-action[data-variant="primary"]:active {
    background: var(--jy-accent-hover);
    filter: brightness(0.94);
  }

  .jy-action-icon {
    display: block;
    flex: 0 0 auto;
    width: 14px;
    height: 14px;
  }

  @media (prefers-reduced-motion: reduce) {
    .jy-bubble[data-state="pending"] .jy-text {
      animation: none;
    }
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

/**
 * caret 的水平落点：跟随选区中心，再收进气泡内。
 * 量不到宽度（jsdom 恒为 0）或气泡窄到放不下两倍内缩时返回 null——那种情况下
 * 「距边缘 16px」没有意义，交给样式的 50% 兜底比写一个 0 更诚实。
 */
function caretOffset(center: number, width: number): number | null {
  if (width <= CARET_INSET * 2) return null;
  return Math.min(Math.max(center, CARET_INSET), width - CARET_INSET);
}

/**
 * 定位 + 观感所需的落点（纯函数）。定位数字全部来自 {@link positionTooltip}——
 * **没有第二套数学**，翻转/收边永远只有一份实现。
 *
 * `placement` 按最终位置与选区中线的关系判定，所以它天然跟着翻转走：正常在下方 →
 * 'bottom'；翻到上方 → 'top'；上下都放不下被贴到视口底时，气泡离哪边近就算哪边，
 * 不会出现「明明在下面却画了个朝下的箭头」。
 */
export function layoutTooltip(
  rect: TooltipRect,
  size: TooltipSize,
  viewport: TooltipViewport,
): TooltipLayout {
  const position = positionTooltip(rect, size, viewport);
  const bubbleCenter = position.top + size.height / 2;
  const rectCenter = rect.top + rect.height / 2;
  const placement: TooltipPlacement = bubbleCenter < rectCenter ? 'top' : 'bottom';
  const caretX = caretOffset(rect.left + rect.width / 2 - position.left, size.width);
  return { left: position.left, top: position.top, placement, caretX };
}

function viewportSize(): TooltipViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** 造一个图标元素：只走 createElementNS + setAttribute，字符串永远不被当成标记解析。 */
function createIcon(name: TooltipIcon): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  // 纯装饰：读屏读按钮文案就够了，别把图形念成第二个名字。
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'jy-action-icon');
  for (const shape of ICONS[name]) {
    const node = document.createElementNS(SVG_NS, shape.tag);
    for (const [key, value] of Object.entries(shape.attrs)) node.setAttribute(key, value);
    svg.append(node);
  }
  return svg;
}

function buildBubble(content: TooltipContent): { layer: HTMLElement; bubble: HTMLElement } {
  const layer = document.createElement('div');
  layer.className = 'jy-layer';

  const bubble = document.createElement('div');
  bubble.className = 'jy-bubble';
  bubble.setAttribute('data-state', content.state ?? 'done');

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
      // 主/次只是观感差异，语义上仍是普通按钮（不能靠颜色表达可点性）。
      button.setAttribute('data-variant', entry.variant ?? 'secondary');
      if (entry.icon !== undefined) button.append(createIcon(entry.icon));
      const label = document.createElement('span');
      label.className = 'jy-action-label';
      // 按钮文案虽然出自本扩展（不是引擎返回），也不破例：一律 textContent，规则只有一条。
      label.textContent = entry.label;
      button.append(label);
      buttonHandlers.set(button, entry.onClick);
      actions.append(button);
    }
    bubble.append(actions);
  }

  layer.append(bubble);
  return { layer, bubble };
}

/**
 * 改按钮文案（「复制」→「已复制」）。回调按契约拿到的是**按钮本身**，而 `textContent = …`
 * 是整棵子树的替换，会把图标一起抹掉，所以文案走这个口子：只换标签，图标留下。
 */
export function setActionLabel(button: HTMLButtonElement, label: string): void {
  (button.querySelector('.jy-action-label') ?? button).textContent = label;
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
  const { layer, bubble } = buildBubble(content);
  node.shadowRoot?.replaceChildren(style, layer);
  // 首次显示、以及被外部（测试清理、扩展热更）摘掉后再显示：一律确保它真的在树上。
  if (!node.isConnected) document.documentElement.append(node);

  const size = measure(node);
  const layout = layoutTooltip(rect, size, viewportSize());
  node.style.left = `${layout.left}px`;
  node.style.top = `${layout.top}px`;
  // caret 的方向与水平落点都是定位算出来的，写到 DOM 上让样式画——CSS 里不重算一遍。
  bubble.setAttribute('data-placement', layout.placement);
  if (layout.caretX !== null) layer.style.setProperty('--jy-caret-x', `${layout.caretX}px`);

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
