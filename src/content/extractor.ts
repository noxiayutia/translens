import { isTranslatableText, normalizeText, shouldSkip } from '../core/lang';

export interface ExtractedSegment {
  id: string;
  text: string;
  order: number;
  element: HTMLElement;
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

export function isHidden(element: Element): boolean {
  if (element.hasAttribute('hidden')) return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;
  const style = getComputedStyle(element);
  if (style.display === 'none') return true;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  return false;
}

/** 用 textContent 而不是 innerText：行为确定、可测，且不依赖布局。 */
export function resolveText(element: Element): string {
  return normalizeText(element.textContent);
}

function isSkippable(element: Element): boolean {
  if (SKIP_TAGS.has(element.tagName)) return true;
  if (element.hasAttribute('data-jy-translated')) return true;
  // 插件自己注入的译文宿主，避免二次翻译。
  if (element.closest('[data-jy-root]')) return true;
  return false;
}

function blockChildrenOf(element: Element): Element[] {
  return Array.from(element.children).filter(
    (child) => !SKIP_TAGS.has(child.tagName) && isBlockDisplay(getComputedStyle(child).display) && !isHidden(child),
  );
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
 */
export function collectSegments(root: ParentNode, options: ExtractorOptions): ExtractedSegment[] {
  const segments: ExtractedSegment[] = [];

  const visit = (element: Element): void => {
    if (isSkippable(element) || isHidden(element)) return;

    const blocks = blockChildrenOf(element);
    if (blocks.length > 0) {
      for (const block of blocks) visit(block);
      return;
    }

    const text = resolveText(element);
    if (!isTranslatableText(text)) return;
    if (options.shouldSkipText?.(text)) return;
    if (shouldSkip(text, options.targetLang)) return;

    const id = `jy-${segments.length + 1}-${Math.random().toString(36).slice(2, 8)}`;
    element.setAttribute('data-jy-id', id);
    segments.push({ id, text, order: segments.length, element: element as HTMLElement });
  };

  const roots = rootElements(root);
  for (const element of roots) visit(element);
  return segments;
}
