// src/content/hover.ts
import { isTranslatableText, normalizeText } from '../core/lang';
import { createStyleLookup, findLeafTextAncestor, inlineText } from './extractor';
import { hideTooltip, showTooltip, type TooltipRect } from './tooltip';
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
 * 段落高亮框：与气泡同样的纪律——fixed、`data-jy-root`、挂 documentElement、
 * `pointer-events:none`（它是描边不是控件，绝不能挡住页面点击），描边只用 `outline`。
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
        // 尺寸属于**我们自己的浮层**（fixed 挂 documentElement），不是对页面元素的注入；
        // 高亮本体是 outline：不占空间、不影响布局。没有 border / padding / margin。
        box.style.cssText = 'width:100%;height:100%;outline:2px solid #1a73e8;box-sizing:border-box';
        shadow.append(box);
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

  function showFor(element: HTMLElement, text: string): void {
    showTooltip(rectOf(element), { text });
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
    showFor(element, PENDING_TEXT);
    const present = (result: InlineTranslation): void => {
      // 还原/关闭之后的在飞结果：安静丢弃，不许再把气泡弹回来。
      if (mine !== generation) return;
      // 期间已进入别的段落：结论属于上一段，别覆盖新段的气泡（同段重进走缓存，不受影响）。
      if (lastRequested === element) showFor(element, result.ok ? result.text : result.message);
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
      showFor(element, cached);
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (current === element) request(element, text);
    }, delayMs);
  }

  function onMouseover(event: Event): void {
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
