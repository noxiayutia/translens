import { isTranslatableText, normalizeText, shouldSkip } from '../core/lang';

export interface ExtractedSegment {
  id: string;
  text: string;
  order: number;
  /**
   * 段落锚点。普通段落就是**承载整段文本的元素**；文本段（见下）则是**包裹这些直接文本节点的容器**——
   * 因为文本节点本身没有属性可挂，也没有插入点语义。
   */
  element: HTMLElement;
  /**
   * 该段只是锚点里的**一部分直接文本**，同容器里还有别的块级子元素（它们的文本各自成段）。
   * 渲染器必须把译文留在锚点**内部**，否则译文与对应原文会被块级子元素隔开。
   */
  textRun?: boolean;
  /**
   * 译文宿主插到锚点**之前**。锚点正好是紧随其后的那个块级子元素时才有这个标记
   * （没有它时锚点是容器本身，译文补在容器内部）。
   */
  prepend?: boolean;
}

export interface ExtractorOptions {
  targetLang: string;
  shouldSkipText?: (text: string) => boolean;
}

/** 这些标签里的内容一律不翻译：代码、表单控件、多媒体与元数据。 */
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'CODE',
  'PRE',
  'KBD',
  'SAMP',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'SVG',
  'CANVAS',
  'IFRAME',
  'VIDEO',
  'AUDIO',
  'HEAD',
  'TITLE',
  'META',
  'LINK',
  'BUTTON',
]);

const BLOCK_DISPLAYS = new Set([
  'block',
  'flow-root',
  'list-item',
  'table',
  'table-row',
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'table-cell',
  'table-caption',
  'flex',
  'grid',
  '-webkit-box',
]);

/** 未知或空 display 一律按行内处理，让最近的块级祖先成为段落边界。 */
export function isBlockDisplay(display: string | undefined): boolean {
  return display !== undefined && BLOCK_DISPLAYS.has(display);
}

interface ElementStyle {
  display: string;
  visibility: string;
}

/**
 * `getComputedStyle` 每次都强制样式解析，而一次采集会对同一元素问好几遍
 * （隐藏判定、块级判定、文本段扫描），10k 元素的页面就是 3 万次。
 * 一次采集内同一元素的结果不会变（这期间我们不插节点、不改样式），缓存起来即可。
 * 跨采集必须丢弃：页面可能在这之间改了样式。
 */
function createStyleLookup(): (element: Element) => ElementStyle {
  const cache = new WeakMap<Element, ElementStyle>();
  return (element) => {
    const cached = cache.get(element);
    if (cached !== undefined) return cached;
    // 不用宿主全局：元素属于哪个文档就问哪个文档的视图，同源 iframe 里也拿得到它自己的样式。
    const view = element.ownerDocument?.defaultView;
    const style = view?.getComputedStyle(element);
    const entry: ElementStyle = {
      display: style?.display ?? '',
      visibility: style?.visibility ?? '',
    };
    cache.set(element, entry);
    return entry;
  };
}

function isHidden(element: Element, styleOf: (element: Element) => ElementStyle): boolean {
  if (element.hasAttribute('hidden')) return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;
  const style = styleOf(element);
  if (style.display === 'none') return true;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  return false;
}

/**
 * 这些元素既不贡献文本，也不下钻。文本段扫描与块级判定共用同一份口径，
 * 免得「这里跳过、那里不跳过」两处规则漂移。
 */
function isSkippedForText(element: Element): boolean {
  return SKIP_TAGS.has(element.tagName) || element.closest('[data-jy-root]') !== null;
}

/**
 * 拼行内文本时补一个空格，避免 `<b>a</b><i>b</i>` 被粘成 `ab`。
 * 只在「词字符 + 词字符」之间补，所以 `</b>.` 这类标点边界不会多出空格。
 */
function needsSeparator(previous: string, next: string): boolean {
  if (previous === '' || next === '') return false;
  if (/\s$/.test(previous) || /^\s/.test(next)) return false;
  return /[\p{L}\p{N}]$/u.test(previous) && /^[\p{L}\p{N}]/u.test(next);
}

/**
 * 去掉标记之间被补出来的空格：`**` 中间的空白一律挤掉，
 * 于是 `<b>bold</b>, and` 拼成 `bold, and` 而不是 `bold , and`。
 */
function dropMarkupGaps(text: string): string {
  return text.replace(/ (?=[\p{P}\p{S}])/gu, '');
}

/**
 * 元素**自身和行内后代**的可见文本；块级后代各自成段，这里一概不碰，
 * `<br>` 是硬换行也是段边界，同样不跨。
 * 用文本节点而不是 `innerText`：行为确定、可测，且不依赖布局。
 */
function inlineText(element: Element, styleOf: (element: Element) => ElementStyle): string {
  let result = '';

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const piece = node.nodeValue ?? '';
      if (needsSeparator(result, piece)) result += ' ';
      result += piece;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (isSkippedForText(child) || isHidden(child, styleOf) || child.nodeName === 'BR') return;
    if (isBlockDisplay(styleOf(child).display)) return;
    for (const grandChild of Array.from(child.childNodes)) walk(grandChild);
  };

  for (const child of Array.from(element.childNodes)) walk(child);
  return normalizeText(result);
}

function isSkippable(element: Element): boolean {
  if (SKIP_TAGS.has(element.tagName)) return true;
  if (element.hasAttribute('data-jy-translated')) return true;
  // 插件自己注入的译文宿主，避免二次翻译。
  if (element.closest('[data-jy-root]')) return true;
  return false;
}

/** 同时支持传入 Element（通常是 document.body）与 Document。 */
function rootElements(root: ParentNode): Element[] {
  if (root instanceof Element) return Array.from(root.children);
  return Array.from(root.childNodes).filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE);
}

/**
 * 段落识别的核心规则：一个元素若含有块级子元素就继续下钻，
 * 否则它就是最内层的文本块，整块作为一段。
 * 这样 <p>Hello <b>world</b></p> 是一段，而 <div><p>a</p><p>b</p></div> 是两段。
 *
 * 混合内容是常态而不是特例（CMS 正文、带标签的 <li>、卡片），所以容器自己的直接文本
 * 也必须成段，且按文档顺序与块级子元素交错：
 * `<div>Intro<p>Body</p>Outro</div>` → Intro / Body / Outro 三段。
 * 同一容器的多个直接文本段共享容器锚点（`textRun`），锚点正好是紧随其后的那块时带 `prepend`。
 *
 * **副作用（调用方必须知道）**：会给每个成段元素打上 `data-jy-id`，
 * 给处理过的元素打上 `data-jy-translated`。因此**每次调用都会让上一轮的全部 id 失效**，
 * 调用方不能拿旧 id 去索引新结果，也不能预期 id 跨调用稳定；
 * 这两类标记由渲染器的 `restore()` 统一清除。
 */
export function collectSegments(root: ParentNode, options: ExtractorOptions): ExtractedSegment[] {
  const segments: ExtractedSegment[] = [];
  const styleOf = createStyleLookup();
  const marked = new Set<Element>();

  const markTranslated = (element: Element): void => {
    if (marked.has(element)) return;
    element.setAttribute('data-jy-translated', '1');
    marked.add(element);
  };

  const push = (element: Element, text: string, textRun: boolean, prepend: boolean): void => {
    if (!isTranslatableText(text)) return;
    if (options.shouldSkipText?.(text)) return;
    if (shouldSkip(text, options.targetLang)) return;

    const id = `jy-${segments.length + 1}-${Math.random().toString(36).slice(2, 8)}`;
    element.setAttribute('data-jy-id', id);
    const segment: ExtractedSegment = { id, text, order: segments.length, element: element as HTMLElement };
    if (textRun) segment.textRun = true;
    if (prepend) segment.prepend = true;
    segments.push(segment);
  };

  /**
   * 处理一个元素的直接内容：自己的文本段与块级子元素**按文档顺序交错**处理，
   * 这样 `<div>Intro<p>Body</p>Outro</div>` 出来就是 Intro / Body / Outro 三段。
   * 块级子元素递归交给 visitBlock。
   */
  const visitContent = (element: Element, hidden: boolean): void => {
    interface TextRun {
      /** 译文宿主要贴着谁放：容器本身，或紧随其后的那个块级子元素。 */
      anchor: Element;
      text: string;
    }
    const runs: TextRun[] = [];
    /** 当前这段文本：{@link appendText} 一次都没跑过时为 undefined。 */
    let run: TextRun | undefined;
    /** 强制下一个文本片段另起一段（`<br>` 这样的硬边界）。 */
    let breakRun = false;
    /** 紧跟在某个块级子元素后面的这段文本；要锚到下一个块级子元素之前才能与原文同序。 */
    let pendingBlock = false;
    let hasLineBreak = false;

    /** 这段文本之后是否还有块级子元素；有就锚到那一个之前，没有就锚到容器末尾。 */
    const nextBlockAfter = (at: number): Element | undefined => {
      const nodes = element.childNodes;
      for (let cursor = at; cursor < nodes.length; cursor += 1) {
        const node = nodes[cursor];
        if (node === undefined || node.nodeType !== Node.ELEMENT_NODE) continue;
        const candidate = node as Element;
        if (isSkippedForText(candidate) || candidate.nodeName === 'BR') continue;
        if (isBlockDisplay(styleOf(candidate).display)) return candidate;
      }
      return undefined;
    };

    const appendText = (piece: string, at: number): void => {
      if (piece === '') return;
      if (run === undefined || breakRun) {
        // 同一落点的相邻块合成一段（`Hello <b>bold</b> world` 仍是一段）；
        // 落点不同（夹着块级子元素）或遇到硬边界就另起一段。
        run = { anchor: (pendingBlock ? nextBlockAfter(at) : undefined) ?? element, text: '' };
        breakRun = false;
        runs.push(run);
      }
      run.text = run.text === '' ? piece : `${run.text} ${piece}`;
    };
    const emit = (): void => {
      for (const run of runs) {
        // 文本节点是按原样拼起来的，段尾统一折叠空白、去掉首尾空格与标记间补出来的空格。
        const text = dropMarkupGaps(normalizeText(run.text));
        if (text === '') continue;
        if (run.anchor === element) {
          // 只有「整个元素就是这一段文本」才可以就地替换：多一个块级子元素或 <br> 都不行。
          const replaceable = runs.length === 1 && element.childElementCount === 0 && !hasLineBreak;
          // 插到容器末尾，不带 prepend；若渲染器看不准容器内部该放哪，仍会退化成「第一个块级子元素之前」。
          push(element, text, !replaceable, false);
        } else {
          // 锚点就是紧随其后的那块：这一段的译文插到锚点之前。
          push(run.anchor, text, true, true);
        }
      }
      runs.length = 0;
      run = undefined;
      breakRun = false;
    };

    let index = 0;
    for (const child of Array.from(element.childNodes)) {
      index += 1;
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.nodeValue ?? '').trim();
        if (text === '') continue;
        appendText(text, index);
        pendingBlock = false;
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const childElement = child as Element;
      if (isSkippedForText(childElement)) continue;
      if (childElement.nodeName === 'BR') {
        // 硬换行：不跨段，否则 "1 Main St<br>Springfield" 会被粘成一个非词。
        hasLineBreak = true;
        breakRun = true;
        run = undefined;
        pendingBlock = false;
        continue;
      }
      if (isBlockDisplay(styleOf(childElement).display)) {
        // 块级子元素：先把它前面的文本段落定下来，再递归，保证段序 = 文档序。
        emit();
        if (!hidden) visitBlock(childElement, false);
        // 紧随其后的直接文本要另起一段，并且插到这块之前才不会跑到它后面去。
        pendingBlock = true;
        run = undefined;
        continue;
      }
      const text = inlineText(childElement, styleOf);
      if (text === '') continue;
      appendText(text, index);
    }

    if (!hidden) emit();
  };

  const visitBlock = (element: Element, ancestorHidden: boolean): void => {
    if (isSkippable(element)) return;

    const hidden = ancestorHidden || isHidden(element, styleOf);
    const children = Array.from(element.children);
    const blocks = children.filter(
      (child) => !isSkippedForText(child) && isBlockDisplay(styleOf(child).display),
    );

    if (blocks.length === 0) {
      // 整块没有任何块级子元素 → 这就是最内层的文本块，整块作为一段（块内含 <br> 时按 <br> 切分）。
      if (hidden) return;
      visitContent(element, false);
      markTranslated(element);
      return;
    }

    // 有块级子元素：自己的直接文本也要成段，然后逐块下钻。
    visitContent(element, hidden);
    if (!hidden) markTranslated(element);
  };

  for (const element of rootElements(root)) visitBlock(element, false);
  return segments;
}
