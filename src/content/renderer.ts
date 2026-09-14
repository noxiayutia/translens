import type { ExtractedSegment } from './extractor';
import { TRANSLATION_CSS } from './styles';

export type DisplayMode = 'bilingual' | 'replace';
export type RenderState = 'pending' | 'done' | 'error';

const HOST_TAG = 'jy-translation';
const PENDING_TEXT = '翻译中…';

interface InsertionTarget {
  parent: HTMLElement;
  inside: boolean;
}

/**
 * 决定译文宿主插到哪里。
 * 表格单元格、列表项、以及弹性/网格布局的子元素都必须插到内部——
 * 否则会在 <tr> 里插入非单元格节点破坏表格，或在 flex 行里被挤成一行。
 */
export function resolveInsertion(element: HTMLElement): InsertionTarget {
  if (element.tagName === 'TD' || element.tagName === 'TH' || element.tagName === 'LI') {
    return { parent: element, inside: true };
  }
  const parent = element.parentElement;
  if (!parent) return { parent: element, inside: true };
  const display = getComputedStyle(parent).display;
  if (display === 'flex' || display === 'inline-flex' || display === 'grid' || display === 'inline-grid') {
    return { parent: element, inside: true };
  }
  return { parent, inside: false };
}

export class DomRenderer {
  private readonly hosts = new Map<string, HTMLElement>();
  private readonly originals = new Map<string, { element: HTMLElement; text: string }>();

  constructor(
    private readonly document: Document,
    private readonly mode: DisplayMode,
    private readonly onRetry?: (segmentId: string) => void,
  ) {}

  mount(segment: ExtractedSegment, state: RenderState, text?: string): void {
    if (this.mode === 'replace') {
      if (!this.originals.has(segment.id)) {
        this.originals.set(segment.id, { element: segment.element, text: segment.element.textContent ?? '' });
      }
      if (state === 'done' && text !== undefined) segment.element.textContent = text;
      return;
    }
    this.setContent(this.ensureHost(segment), state, text);
  }

  update(segmentId: string, text: string): void {
    const host = this.hosts.get(segmentId);
    if (host) {
      this.setContent(host, 'done', text);
      return;
    }
    const original = this.originals.get(segmentId);
    if (original) {
      original.element.textContent = text;
      original.element.setAttribute('data-jy-translated', '1');
    }
  }

  fail(segmentId: string, message: string): void {
    const host = this.hosts.get(segmentId);
    // 替换模式下失败必须保持原文，否则用户会看到一片空白。
    if (!host) return;
    this.setContent(host, 'error', message);
  }

  private ensureHost(segment: ExtractedSegment): HTMLElement {
    const existing = this.hosts.get(segment.id);
    if (existing) return existing;

    const host = this.document.createElement(HOST_TAG);
    host.setAttribute('data-jy-root', '');
    host.setAttribute('data-jy-for', segment.id);

    const shadow = host.attachShadow({ mode: 'open' });
    const style = this.document.createElement('style');
    style.textContent = TRANSLATION_CSS;
    const body = this.document.createElement('span');
    body.className = 'jy-body';
    shadow.append(style, body);

    const target = resolveInsertion(segment.element);
    if (target.inside) target.parent.append(host);
    else target.parent.insertBefore(host, segment.element.nextSibling);

    // 标记原文已翻译：即使后续被重复采集，extractor 也会跳过它。
    segment.element.setAttribute('data-jy-translated', '1');
    this.hosts.set(segment.id, host);
    return host;
  }

  /** 一律用 textContent 写入，杜绝引擎返回内容被当成 HTML 执行。 */
  private setContent(host: HTMLElement, state: RenderState, text?: string): void {
    const body = host.shadowRoot?.querySelector('.jy-body');
    if (!body) return;

    body.textContent = '';
    body.className = 'jy-body';
    if (state === 'pending') {
      body.classList.add('jy-pending');
      body.textContent = PENDING_TEXT;
      return;
    }
    if (state === 'error') {
      body.classList.add('jy-error');
      body.textContent = text ?? '翻译失败';
      const button = this.document.createElement('button');
      button.className = 'jy-retry';
      button.type = 'button';
      button.textContent = '重试';
      const segmentId = host.getAttribute('data-jy-for');
      button.addEventListener('click', () => {
        if (segmentId) this.onRetry?.(segmentId);
      });
      body.append(button);
      return;
    }
    body.textContent = text ?? '';
  }

  restore(): void {
    for (const host of this.hosts.values()) host.remove();
    this.hosts.clear();

    for (const { element, text } of this.originals.values()) {
      element.textContent = text;
      element.removeAttribute('data-jy-translated');
    }
    this.originals.clear();

    for (const element of Array.from(this.document.querySelectorAll('[data-jy-id], [data-jy-translated]'))) {
      element.removeAttribute('data-jy-id');
      element.removeAttribute('data-jy-translated');
    }
  }
}
