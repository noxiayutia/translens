// src/content/hover.ts
import { isTranslatableText, normalizeText } from '../core/lang';
import { createStyleLookup, findLeafTextAncestor, inlineText } from './extractor';
import { hideTooltip, showTooltip, type TooltipContent, type TooltipRect } from './tooltip';
import { PENDING_TEXT, type InlineTranslation, type InlineTranslator } from './inline-types';

/**
 * Shift + 悬停翻译当前段。
 *
 * 与整页翻译共用 `findLeafTextAncestor` 的段落判据（"什么算一段"只有一份实现）；
 * 结果只进 {@link tooltip} 的 fixed 浮层，**不往页面里插任何东西**。
 * 高亮是挂在 documentElement 上的 overlay 框，描边只用 `outline`——
 * 给段落元素直接写 inline style 会让 `document.body.innerHTML` 变样，
 * 而"浮层与高亮都不许碰 body"正是本单元的验收不变式（上一个 border-left 事故学的）。
 */

/** 进入段落多久之后才发请求：鼠标快速划过时一个都不该发。 */
const DEFAULT_DELAY_MS = 180;
/** 会话内文本 → 译文的记忆上限（FIFO 淘汰），防整页漫游把 Map 撑大。 */
const CACHE_MAX = 200;

export interface HoverDeps {
  translate: InlineTranslator;
  /** 测试可以缩短延时；生产用默认值。 */
  delayMs?: number;
}

export interface HoverController {
  enable(): void;
  disable(): void;
  /**
   * 撤掉高亮、取消在飞的延时请求并让**已发出**的请求结果作废（页面还原时调用）。
   * 不摘监听器，也不清缓存——还原不该让用户下一次悬停变慢。
   */
  reset(): void;
}

interface HighlightBox {
  show(rect: TooltipRect): void;
  clear(): void;
}

/**
 * 高亮框的观感（几何与两支颜色值都留在 inline style，形状/动效写在样式表里）：
 * 强调色描边 + 极淡的强调色底，出现时 120ms 淡入。
 */
const HIGHLIGHT_CSS = `
  .jy-hover-box {
    /* 圆角 6px 与气泡的 10px 是同一族的收角，不是写死的深浅色。 */
    border-radius: 6px;
    /* 出现时淡入。元素是每次进入段落时新建的，用 animation 比 transition 可靠
       （新插入的节点没有"上一态"可过渡）。 */
    animation: jy-hover-in 120ms ease-out;
  }
  @keyframes jy-hover-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .jy-hover-box { animation: none; }
  }
`;

/**
 * 段落高亮框：与气泡同样的纪律——fixed、`data-jy-root`、挂 documentElement、
 * `pointer-events:none`（它是描边不是控件，绝不能挡住页面点击），描边只用 `outline`。
 *
 * 描边与底色都用**带透明度的强调色**（同一支蓝，深浅两套页面各自混合）：深色页面上
 * 不写死深色、浅色页面上不写死浅色，两种页面都看得见。
 *
 * 两个不透明度是**核验给死的**：上一版 0.45 / 0.06 那组，描边与它框住的底色在浅色页面上
 * 只有约 1.8:1 的对比，只算"可辨"；0.6 / 0.08 是约 2.3:1——描边明显深了一档，底色仍留得
 * 很淡，观感还是柔和的描边，不是生硬的实线框。两个值各管一件事：描边管"这条线看得清"，
 * 底色管"这块区域被框住了"；要让线更清楚就加深描边，而不是把底色抹掉（底色没了，
 * 高亮就只剩一条孤线）。
 */
function createHighlightBox(): HighlightBox {
  let node: HTMLElement | null = null;
  let frame: HTMLElement | null = null;

  return {
    show(rect) {
      if (node === null || frame === null) {
        const host = document.createElement('div');
        host.setAttribute('data-jy-root', '');
        host.setAttribute('data-jy-hover-highlight', '');
        host.style.cssText = 'position:fixed;z-index:2147483646;left:0;top:0;pointer-events:none';
        const shadow = host.attachShadow({ mode: 'open' });
        const box = document.createElement('div');
        box.className = 'jy-hover-box';
        // 尺寸属于**我们自己的浮层**（fixed 挂 documentElement），不是对页面元素的注入；
        // 高亮本体是 outline：不占空间、不影响布局。没有 border / padding / margin
        // （上一个 border-left 事故就是靠这条不变式守住的，测试按字形扫这段 inline style）。
        box.style.cssText = [
          'width:100%',
          'height:100%',
          'box-sizing:border-box',
          'outline:2px solid rgba(37, 99, 235, 0.6)',
          // 极淡的强调色底：描边区域有"被框住"的感觉，又不盖住文字。
          'background:rgba(37, 99, 235, 0.08)',
        ].join(';');
        const style = document.createElement('style');
        style.textContent = HIGHLIGHT_CSS;
        // 顺序有意如此：框在前、样式在后——框必须是 shadowRoot 的第一个元素
        // （"高亮挂在浮层上"的既有断言按 firstElementChild 取框）。
        shadow.append(box, style);
        document.documentElement.append(host);
        node = host;
        frame = box;
      } else if (!node.isConnected) {
        document.documentElement.append(node);
      }
      node.style.left = `${Math.round(rect.left)}px`;
      node.style.top = `${Math.round(rect.top)}px`;
      node.style.width = `${Math.round(rect.width)}px`;
      node.style.height = `${Math.round(rect.height)}px`;
    },
    clear() {
      node?.remove();
      node = null;
      frame = null;
    },
  };
}

function rectOf(element: Element): TooltipRect {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

export function createHoverTranslator(deps: HoverDeps): HoverController {
  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;
  const highlight = createHighlightBox();
  /** 本会话已翻过的段落：同段重复进入零请求（后台缓存是第二层，这里是零往返）。 */
  const cache = new Map<string, string>();

  let enabled = false;
  let shiftDown = false;
  let current: HTMLElement | null = null;
  /** 最后一个发起了请求（或展示了结果）的段落；结果回来时只有它还有效才展示。 */
  let lastRequested: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** reset()/disable() 自增：在飞请求回来后按世代作废。 */
  let generation = 0;

  function cancelPending(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function paragraphText(element: HTMLElement): string {
    // 与采集端逐字相同的文本口径：inlineText（行内后代并入、块级/跳过/隐藏不并）+ normalizeText。
    return normalizeText(inlineText(element, createStyleLookup()));
  }

  function showFor(element: HTMLElement, content: TooltipContent): void {
    showTooltip(rectOf(element), content);
  }

  function remember(text: string, translation: string): void {
    cache.set(text, translation);
    // 简单 FIFO 上限：Map 的迭代序就是插入序，超了从头淘汰最旧的。
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
  }

  function request(element: HTMLElement, text: string): void {
    lastRequested = element;
    const mine = generation;
    // 在飞的这一段用 pending 态：降饱和的次级色 + 脉冲，跟最终译文的观感分得开。
    showFor(element, { text: PENDING_TEXT, state: 'pending' });
    const present = (result: InlineTranslation): void => {
      // 还原/关闭之后的在飞结果：安静丢弃，不许再把气泡弹回来。
      if (mine !== generation) return;
      // 期间已进入别的段落：结论属于上一段，别覆盖新段的气泡（同段重进走缓存，不受影响）。
      if (lastRequested === element) {
        showFor(element, result.ok ? { text: result.text } : { text: result.message, state: 'error' });
      }
    };
    void deps.translate(text).then(
      (result) => {
        if (result.ok) remember(text, result.text);
        present(result);
      },
      (raw: unknown) => {
        // deps.translate 的契约是自己收敛失败；真抛出来（接线 bug）也不能变未处理拒绝。
        present({
          ok: false,
          message: `翻译失败：${raw instanceof Error ? raw.message : String(raw)}`,
        });
      },
    );
  }

  function onElementEntered(element: HTMLElement): void {
    if (element === current) return;
    current = element;
    cancelPending();
    highlight.show(rectOf(element));
    const text = paragraphText(element);
    if (text === '' || !isTranslatableText(text)) return;
    const cached = cache.get(text);
    if (cached !== undefined) {
      lastRequested = element;
      showFor(element, { text: cached });
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (current === element) request(element, text);
    }, delayMs);
  }

  function onMouseover(event: Event): void {
    /**
     * **只响应真实用户手势**（与 `selection.ts` 的 onMouseup 同一个闸门、同一套理由）：
     * 页面脚本合成 keydown(Shift) + mouseover 就能指定段落、让扩展带着用户的 API Key 去
     * 打用户自己付费的引擎，并把译文写进页面 JS 读得到的 open Shadow DOM。
     * **keydown 与 mouseover 两个入口都必须把门**——只把住 keydown，等用户真的按住 Shift
     * （本功能的正常用法）时，合成的 mouseover 依然能替它选段发请求。
     * 反过来，keyup/blur/scroll 不 gating：它们只会撤销状态、清掉描边——fail 的方向是
     * 安全方向，被伪造最坏也只是让悬停提前失效，不会送任何文本出网络。
     */
    if (!event.isTrusted) return;
    if (!shiftDown) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const element = findLeafTextAncestor(target);
    if (element === null) {
      // 指针离开段落：撤高亮、取消还没到点的请求（"离开就取消"）。
      // 已展示的气泡**保留**——设计文档 §4.2「移出保留译文」。
      if (current !== null) {
        current = null;
        cancelPending();
      }
      highlight.clear();
      return;
    }
    onElementEntered(element);
  }

  function onKeyDown(event: KeyboardEvent): void {
    // Shift 状态只认真键盘（isTrusted）：合成 keydown 能骗开的闸门等于整条悬停链路
    // 都没有闸门——见 onMouseover 的注释。
    if (!event.isTrusted) return;
    if (event.key === 'Shift') shiftDown = true;
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (event.key !== 'Shift') return;
    shiftDown = false;
    // 松开 Shift 撤掉描边与未触发的请求；已经出来的译文气泡保留。
    highlight.clear();
    cancelPending();
  }

  function onBlur(): void {
    // 焦点离开窗口时 keyup 可能收不到：不纠就会留下一个"自认为按着 Shift"的幽灵状态。
    shiftDown = false;
    highlight.clear();
    cancelPending();
  }

  function onScroll(): void {
    // 滚动时段落的视位置在变而 mouseover 不来：撤描边（气泡由 tooltip 自己关）。
    highlight.clear();
  }

  function resetState(): void {
    generation += 1;
    cancelPending();
    highlight.clear();
    current = null;
    lastRequested = null;
  }

  return {
    enable() {
      if (enabled) return;
      enabled = true;
      // 捕获阶段监听：页面上停传播的脚本不该让悬停翻译失灵（Shift 状态同理要收全量事件）。
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('keyup', onKeyUp, true);
      window.addEventListener('blur', onBlur, true);
      document.addEventListener('mouseover', onMouseover, true);
      window.addEventListener('scroll', onScroll, true);
    },
    disable() {
      if (!enabled) return;
      enabled = false;
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur, true);
      document.removeEventListener('mouseover', onMouseover, true);
      window.removeEventListener('scroll', onScroll, true);
      resetState();
      hideTooltip();
    },
    reset() {
      resetState();
    },
  };
}
