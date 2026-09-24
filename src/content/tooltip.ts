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
 * - 与 toast 不同，气泡**必须可交互**（译文屏的「复制」、划词的圆点），所以没有 `pointer-events: none`；
 * - **无障碍**：气泡骨架**常驻**（同一次打开期间只造一次），承载译文的 `.jy-text` 挂着
 *   `role="status"`，状态变化（翻译中 → 译文 / 失败文案）只更新它的文字。
 *   为什么是这种形状、而不是"给每次新建的节点加个 aria-live"，见 createBubbleSkeleton。
 *
 * 观感上与弹窗/设置页（popup.css / options.css）同一套设计语言：中性深色表面 + 单一强调色，
 * 层级靠一条细边框、一层分层阴影和留白，不靠颜色堆砌。三处共用的颜色值各写一份令牌，
 * 不引第三个文件——浮层跑在页面的 shadow DOM 里，既借不到扩展页面的 `:root`，也不该往页面
 * 的 `:root` 里写东西。
 *
 * DOM 结构（shadow 内）：
 *   .jy-layer            ← 定位与 caret 的锚（气泡自己 overflow:auto 裁不了探出去的箭头）
 *     .jy-bubble         ← 表面：背景/边框/圆角/阴影/max-height、data-placement、data-state、data-variant
 *       .jy-text         ← 译文（可选中复制），同时是常驻的 ARIA 活区（role=status）
 *       .jy-actions      ← 按钮行（没有按钮时整行不在树里）
 *         .jy-action     ← 按钮（图标 + 文案）
 *
 * `data-variant="chip"` 是划词的**待触发态**：一颗 30px 的纯图标圆点，屏幕上没有任何文字
 * （名字只在 `aria-label` 里）。整个圆点就是那个 button，配上 `hoverIntent` 之后
 * 「指针移上来并停满延时」才换成一屏译文。定位与观感语言与 bubble 同一套。
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
export type TooltipIcon = 'copy' | 'translate';

export interface TooltipButton {
  label: string;
  /** 'primary' = 实心强调色的主操作；省略即半透明白底的次操作。 */
  variant?: 'primary' | 'secondary';
  icon?: TooltipIcon;
  /**
   * 纯图标按钮：**`label` 不上屏，只当无障碍名**（写进 `aria-label`）。
   *
   * 划词的圆点用它——那颗点上屏幕一个可见文字都没有，读屏与键盘用户拿到的名字仍然完整。
   * 图标自己是 `aria-hidden` 的装饰（见 createIcon），所以名字只有一份，不会被念两遍。
   */
  iconOnly?: boolean;
  /** 点击回调；参数是按钮自身，用来就地改文案（「复制」→「已复制」）。 */
  onClick: (button: HTMLButtonElement) => void;
}

/** 气泡的一档观感尺寸：'bubble' = 承载译文那一屏；'chip' = 划词的紧凑待触发态。 */
export type TooltipVariant = 'bubble' | 'chip';

/**
 * 悬停意图：**指针在自己的指针移动下停在这个气泡上满 `delayMs` 才算数**（起算事件是
 * `pointermove`，不是 `pointerenter`——理由见 `onHostPointermove` 里的真机读数）。
 *
 * 为什么由浮层自己管，而不是划词那一侧挂监听：浮层知道这个气泡什么时候被换掉、什么时候被关掉
 * （{@link hideTooltip}），而"气泡没了、计时器还在，到点偷偷发一次请求"正是这里唯一的失效形状。
 * 它同时是一次性的（触发即摘），因为"停在上面"这件事不该有第二次。
 */
export interface TooltipHoverIntent {
  /**
   * 停留多久才触发。**必填**：延时是这个机制的全部语义，浮层不替调用方留一个默认值
   * （划词那一侧的 `DEFAULT_HOVER_DELAY_MS` 才是唯一的一份读数）。
   */
  delayMs: number;
  onTrigger: () => void;
}

export interface TooltipContent {
  /** 唯一的内容通道：一律 textContent 写入，引擎返回什么都只是文字。 */
  text: string;
  /** 视觉状态；省略即普通译文。 */
  state?: TooltipState;
  buttons?: TooltipButton[];
  /** 观感档位；省略即 'bubble'（译文那一屏的尺寸一个字没变）。 */
  variant?: TooltipVariant;
  /** 悬停意图；省略即普通气泡——指针在它上进进出出什么都不做。 */
  hoverIntent?: TooltipHoverIntent;
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
  // 翻译：左半「文」、右半「A」——14px 上唯一还认得出来的"翻成另一种文字"画法。
  translate: [
    // 「文」：丶、一、撇、捺。
    { tag: 'path', attrs: { d: 'M8.4 4 9.9 5.9' } },
    { tag: 'path', attrs: { d: 'M3.4 9.2h9.8' } },
    { tag: 'path', attrs: { d: 'M9.5 10.4 3.7 20' } },
    { tag: 'path', attrs: { d: 'M7.8 13.2 13 20' } },
    // 「A」：一撇一捺 + 横梁。
    { tag: 'path', attrs: { d: 'M14.5 20 17.6 10.6 20.7 20' } },
    { tag: 'path', attrs: { d: 'M15.7 16.4h3.8' } },
  ],
};

const TOOLTIP_CSS = `
  /* 约定：下面这一整张表是一个 JS 模板字符串。注释里**不许出现反引号**——它会从那里把
     模板截断，样式表后半段静默丢失；只有当被包住的东西恰好未定义时 typecheck 才炸，
     换成已定义的名字（GAP、HOST_ID 这类）就完全无声。要指代标识符就直接写名字或用引号。
     判据在 tooltip.test.ts 的「样式表完整」那条：钉的是本表最后一条规则，截断在它之前即红。
     （往表尾追加规则时，记得把那条钉子挪到新的末尾。） */

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
    --jy-accent: #f2efe6;
    --jy-accent-hover: #ffffff;
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

  /* 划词的小气泡（待触发态）：一颗纯图标的圆点，屏幕上没有任何文字。
     整个圆点就是那个 button（气泡零内边距 + 按钮撑满），所以"点小气泡"与"点那颗按钮"是
     同一件事——委托层的 isTrusted 闸门与悬停判据一行都不用改。
     表面/边框/阴影沿用上面 .jy-bubble 那一档：两屏是同一个东西的两种状态，不是两种控件。 */
  .jy-bubble[data-variant="chip"] {
    padding: 0;
    border-radius: 999px;
  }

  /* 按钮行本来带着 10px 上边距（译文气泡里它在文字下方）；圆点里必须归零，否则点会偏下。 */
  .jy-bubble[data-variant="chip"] .jy-actions {
    margin-top: 0;
  }

  .jy-bubble[data-variant="chip"] .jy-action {
    width: 30px;
    height: 30px;
    padding: 0;
    justify-content: center;
    border-radius: 999px;
  }

  /* 图标是圆点上唯一的图形，放大一号才压得住 30px 的圆。 */
  .jy-bubble[data-variant="chip"] .jy-action-icon {
    width: 16px;
    height: 16px;
  }

  /* 圆点不画 caret：圆形没有一条直边给箭头落位，而它离选区只有 8px，指向已经够了。
     万一引擎不认 :has()（Chrome 105 以下），退化成"圆点带个小箭头"——不破版，也不动定位数学。 */
  .jy-layer:has(> .jy-bubble[data-variant="chip"])::after {
    content: none;
  }

  /* 翻译中：降饱和的次级色 + 轻微脉冲（这一屏只有一行字，呼吸比转圈合适）。 */
  .jy-bubble[data-state="pending"] .jy-text {
    color: var(--jy-text-2);
    animation: jy-pulse 1.4s ease-in-out infinite;
  }

  /* 失败：深底上提亮过的红，是**文字**不是按钮（失败态没有可复制的东西）。 */
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
    /* 次按钮（默认档）：半透明白底 + 一道描边。
       如实写明：**产品侧当前两个按钮（译文屏的「复制」与划词的圆点）都走 primary 档**，
       这一档暂时没有按钮穿着它。保留它不是死代码——它是 entry.variant 缺省时的默认档，
       用途是"下一个按钮零成本继承"，并且正被 tooltip 用例覆盖着。
       要删就连同 variant 轴与这档上的 :focus-visible 那组 a11y 断言一起删，属独立重构。 */
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

  /* 主按钮（译文屏的「复制」、划词的圆点）：这一屏唯一的实心强调色，与弹窗的 .primary
     同一支象牙（浮层是深底，所以按钮取品牌反相档：象牙底 + 碳黑字）。 */
  .jy-action[data-variant="primary"] {
    color: #0d0d10;
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

/**
 * 气泡骨架的四块（样式表之外的全部节点）。它们是**常驻**的：showTooltip 只往里写内容、
 * 绝不替换节点——`.jy-text` 是读屏活区，换节点等于换了一个区域，播报就断了
 * （见 createBubbleSkeleton 的长注释）。
 */
interface BubbleParts {
  layer: HTMLElement;
  bubble: HTMLElement;
  /** 承载译文的节点，同时是 role=status 的常驻活区。 */
  text: HTMLElement;
  /** 按钮行的容器；没有按钮时不在树里。 */
  actions: HTMLElement;
}

let host: HTMLElement | null = null;
/** 与 host 同生共死的骨架；hideTooltip 摘掉宿主时一起置空。 */
let skeleton: BubbleParts | null = null;
/** 打开期间才存在的监听器；hide() 必须逐个摘掉，否则反复开合会把窗口挂满僵尸监听。 */
let listeners: Listeners | null = null;
/**
 * 按钮回调表：按钮元素 → 回调。点击走 host 上的**委托**（挂在 host 本身，
 * shadow 里的 click 会冒泡到 host），气泡重渲染时旧按钮连同条目一起被丢弃，
 * 用 WeakMap 就不存在"上一代气泡的回调泄漏"这回事。
 */
let buttonHandlers = new WeakMap<HTMLButtonElement, (button: HTMLButtonElement) => void>();

/**
 * 当前这一屏的悬停意图；`null` = 这一屏不吃悬停。
 * 它与 `host` 同生命周期（{@link hideTooltip} 一律清空），但**不**与 `showTooltip` 同生命周期：
 * 同一个气泡从 chip 换成 pending 那一屏时，意图必须当场作废（见 {@link armHoverIntent}）。
 */
let hoverIntent: TooltipHoverIntent | null = null;
let intentTimer: ReturnType<typeof setTimeout> | null = null;

function clearIntentTimer(): void {
  if (intentTimer === null) return;
  clearTimeout(intentTimer);
  intentTimer = null;
}

/**
 * 换一屏内容 = 换一次悬停语义：先无条件作废上一代还没到点的计时器，再决定这一屏的意图。
 * 「气泡已经关了/已经换成译文了，计时器却还在跑」在这里是唯一会偷偷烧用户额度的路径。
 */
function armHoverIntent(next: TooltipHoverIntent | undefined): void {
  clearIntentTimer();
  hoverIntent = next ?? null;
}

function onHostPointermove(event: PointerEvent): void {
  /**
   * **只认真实指针**（与划词的 mouseup、悬停的 mouseover、按钮委托的 click 同一道闸门、同一套
   * 理由）：浮层是 open shadow，页面脚本摸得到宿主，合成一个 pointermove 就能替用户"停在气泡上"，
   * 带着用户的 Key 去打用户付费的引擎。{@link TooltipHoverIntent} 的全部意义是"用户自己停上来"。
   *
   * **起算挂在 move 而不是 enter**，是真机定的（`.qa/run-selection-chip.mjs` 的 ⑭）：拖选越过
   * 最后一行的行底时，chip 会生成在静止的指针底下，而 Chrome 为这次 DOM 变化补发
   * `pointerover` + `pointerenter`、**不发** `pointermove`。挂在 enter 上就等于"用户什么也没做，
   * 150ms 后自己翻了"——那正是这次要消灭的行为。移动一下才起算，与 README/规格的说法一致。
   */
  if (!event.isTrusted || hoverIntent === null || intentTimer !== null) return;
  const intent = hoverIntent;
  intentTimer = setTimeout(() => {
    intentTimer = null;
    // 一次性：触发过就不再挂第二次意图（译文已经在路上了，指针反复进出不该反复请求）。
    hoverIntent = null;
    intent.onTrigger();
  }, intent.delayMs);
}

/** 指针移出宿主：取消还没到点的计时（但保留意图，让用户能重新停上来）。 */
function onHostPointerleave(): void {
  clearIntentTimer();
}

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

/**
 * 气泡骨架（**常驻**，同一次打开期间只造一次）：
 *
 *   .jy-layer > .jy-bubble > .jy-text + .jy-actions
 *
 * 为什么必须常驻——无障碍。`.jy-text` 是承载译文的节点，同时是 `role="status"` 的活区。
 * 读屏只播报**已经存在的活区内部**发生的变化：如果每次 show 都把节点换掉（上一版正是
 * `replaceChildren(style, layer)`），"翻译中 → 译文"这一步在无障碍树上只是"一个新节点
 * 带着文字一起出现"，读屏一声不吭——核验实测的静默就是这个形状。骨架只造一次、之后只改
 * 内容，状态变化就落在同一个活区里，才会被念出来。
 */
function createBubbleSkeleton(): BubbleParts {
  const layer = document.createElement('div');
  layer.className = 'jy-layer';

  const bubble = document.createElement('div');
  bubble.className = 'jy-bubble';

  const text = document.createElement('div');
  text.className = 'jy-text';
  // 活区语义挂在**承载译文的那个节点**上，而不是另做一个隐藏的镜像节点：念出来的就是
  // 气泡里那行字本身，不存在两份文案走神的可能。role=status 隐式带 aria-live=polite +
  // aria-atomic，这里仍显式写全——隐式值依赖引擎实现，显式声明零成本。
  text.setAttribute('role', 'status');
  text.setAttribute('aria-live', 'polite');
  text.setAttribute('aria-atomic', 'true');
  bubble.append(text);

  // 按钮行按需挂/摘（空行会白留 .jy-actions 的 10px 上边距）；按钮不在活区里，
  // 重建它不会打断播报——活区只有 .jy-text 一个。
  const actions = document.createElement('div');
  actions.className = 'jy-actions';

  layer.append(bubble);
  return { layer, bubble, text, actions };
}

/** 把内容写进骨架：只改属性与文字，**绝不换节点**（换节点＝活区收不到变化）。 */
function renderBubble(parts: BubbleParts, content: TooltipContent): void {
  parts.bubble.setAttribute('data-state', content.state ?? 'done');
  parts.bubble.setAttribute('data-variant', content.variant ?? 'bubble');
  // 只在文字真的变了时才写：同一段反复进入（缓存命中）拿到的是同一份译文，
  // 再写一遍等于又制造一次活区变化，读屏会重复念同一句话。
  if (parts.text.textContent !== content.text) parts.text.textContent = content.text;

  parts.actions.replaceChildren();
  const buttons = content.buttons ?? [];
  if (buttons.length === 0) {
    // 失败态没有可点的东西：整行摘掉。
    parts.actions.remove();
    return;
  }
  for (const entry of buttons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jy-action';
    // 主/次只是观感差异，语义上仍是普通按钮（不能靠颜色表达可点性）。
    button.setAttribute('data-variant', entry.variant ?? 'secondary');
    if (entry.icon !== undefined) button.append(createIcon(entry.icon));
    if (entry.iconOnly === true) {
      // 纯图标：名字只能活在这里。没有 aria-label 的图标按钮对读屏是一个哑按钮，
      // 而图标本身是 aria-hidden 的装饰——两者合起来等于"这个按钮没有名字"。
      button.setAttribute('aria-label', entry.label);
    } else {
      const label = document.createElement('span');
      label.className = 'jy-action-label';
      // 按钮文案虽然出自本扩展（不是引擎返回），也不破例：一律 textContent，规则只有一条。
      label.textContent = entry.label;
      button.append(label);
    }
    buttonHandlers.set(button, entry.onClick);
    parts.actions.append(button);
  }
  if (parts.actions.parentNode === null) parts.bubble.append(parts.actions);
}

/**
 * 改按钮文案（「复制」→「已复制」）。回调按契约拿到的是**按钮本身**，而 `textContent = …`
 * 是整棵子树的替换，会把图标一起抹掉，所以文案走这个口子：只换标签，图标留下。
 */
export function setActionLabel(button: HTMLButtonElement, label: string): void {
  (button.querySelector('.jy-action-label') ?? button).textContent = label;
}

function onHostClick(event: Event): void {
  /**
   * **只认真实手势**（与划词的 mouseup、悬停的 mouseover、小气泡起算用的 pointermove 同一道闸门、
   * 同一套理由）：浮层是 open shadow，页面脚本摸得到宿主，也就点得到里面的按钮。而这两个按钮
   * 一条会把文本带着用户的 Key 送去用户自己付费的引擎（划词的圆点），一条会写剪贴板（「复制」）
   * ——都是"后果在用户这一侧"的路径，不设闸就等于把闸门让给了页面。
   *
   * 门开在**委托这一层**（一处一套答案），所以 `TooltipButton` 的回调契约不用带上事件对象。
   */
  if (!event.isTrusted) return;
  for (const node of event.composedPath()) {
    if (node instanceof HTMLButtonElement) {
      buttonHandlers.get(node)?.(node);
      return;
    }
  }
}

/** 拿到（必要时创建）气泡宿主与它的常驻骨架。挂在 documentElement 上——页面脚本看不见我们。 */
function ensureHost(): { node: HTMLElement; style: HTMLStyleElement; parts: BubbleParts } {
  if (host !== null && host.shadowRoot !== null && skeleton !== null) {
    // 创建时就注入的 <style>，这里只是把类型收窄回去。
    const style = host.shadowRoot.querySelector('style') as HTMLStyleElement;
    return { node: host, style, parts: skeleton };
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
  const parts = createBubbleSkeleton();
  shadow.append(style, parts.layer);
  // 委托挂在 host 本身：气泡内容每次重建，接线却只有这一份。
  created.addEventListener('click', onHostClick);
  // 悬停意图同样挂在 host 上，与宿主同生共死（hideTooltip 丢掉节点就带走了这两个监听）。
  // 起算用 move、取消用 leave：见 onHostPointermove 里"DOM 变化会补发 enter 但不补发 move"那条。
  created.addEventListener('pointermove', onHostPointermove);
  created.addEventListener('pointerleave', onHostPointerleave);
  host = created;
  skeleton = parts;
  return { node: created, style, parts };
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
 * hide() 时全部摘掉。`content.hoverIntent` 每一屏重新起算（见 {@link armHoverIntent}）。
 */
export function showTooltip(rect: TooltipRect, content: TooltipContent): void {
  const { node, style, parts } = ensureHost();
  // 顺序有意如此：**先**把骨架（含 role=status 的活区）挂进文档，**再**写内容。
  // 读屏播报的是"已存在区域内部的变化"；反过来（先写内容、再连节点一起插入）那句文字
  // 是随区域一起出现的，不会被念。
  if (parts.layer.parentNode !== node.shadowRoot) node.shadowRoot?.replaceChildren(style, parts.layer);
  // 首次显示、以及被外部（测试清理、扩展热更）摘掉后再显示：一律确保它真的在树上。
  if (!node.isConnected) document.documentElement.append(node);
  renderBubble(parts, content);
  armHoverIntent(content.hoverIntent);

  const size = measure(node);
  const layout = layoutTooltip(rect, size, viewportSize());
  node.style.left = `${layout.left}px`;
  node.style.top = `${layout.top}px`;
  // caret 的方向与水平落点都是定位算出来的，写到 DOM 上让样式画——CSS 里不重算一遍。
  parts.bubble.setAttribute('data-placement', layout.placement);
  if (layout.caretX !== null) parts.layer.style.setProperty('--jy-caret-x', `${layout.caretX}px`);

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
  // 未到点的悬停意图必须在这里一起作废：气泡都没了还留着计时器，到点就是一次没人要的请求。
  armHoverIntent(undefined);
  if (host === null) return;
  host.remove();
  host = null;
  // 骨架随宿主一起丢：下次打开重新造一个（活区也随之重生，见 createBubbleSkeleton）。
  skeleton = null;
  // 旧气泡的按钮回调随节点一起丢；换新的表最干净（WeakMap 本也会回收，这里只是明确生命周期）。
  buttonHandlers = new WeakMap();
}

/** 当前是否有气泡打开着。 */
export function isTooltipVisible(): boolean {
  return host !== null;
}

/**
 * 这次事件的落点在不在浮层里（含 shadow 内部的那些节点）。
 *
 * 给入口闸门用：浮层里的按钮被按下再抬起时，页面上**上一次划的选区还在**，只看选区的判据
 * 会把这一下当成"又划了一次词"。而 `composedPath` 是唯一可靠的落点信号——它在 shadow 边界
 * 上会把宿主节点放进路径里，`closest()` 做不到（见 selection.ts 的 isOwnOverlay 同一话题）。
 */
export function isEventInTooltip(event: Event): boolean {
  return host !== null && event.composedPath().includes(host);
}
