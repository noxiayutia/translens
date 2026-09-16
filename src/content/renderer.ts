import type { ExtractedSegment } from './extractor';
import { createStyleLookup, inlineText, isBlockDisplay, isHidden } from './extractor';
import { normalizeText } from '../core/lang';
import type { DisplayMode } from '../shared/settings';
import { TRANSLATION_CSS, TRANSLATION_INLINE_CSS } from './styles';

export type { DisplayMode };

export type RenderState = 'pending' | 'done' | 'error';

const HOST_TAG = 'jy-translation';
const PENDING_TEXT = '翻译中…';

/**
 * 「这段文本几乎全部来自同一个链接」的占比阈值：链接可见文本长度 / 段文本长度。
 *
 * 有阈值才有边界：自然句里嵌一个小链接（"…see the <a>supplement</a>"）占段不足六成，
 * 包起来等于把一整段正文涂蓝、伪装成可点区；而作者署名行（"By <a>人名</a>"）链接
 * 就是这段的全部语义，不包才是把链接指引弄丢。0.6 取在"链接是段落的主体"这一侧。
 */
export const LINK_WRAPPING_MIN_SHARE = 0.6;

/** 仅译文模式下允许包译文链接的协议——来自页面的 href 一律过白名单，绝不放行可执行协议。 */
const ALLOWED_HREF_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** 相对协议前缀：`//` 与反斜杠族（`\` 对特殊协议等同 `/`，浏览器按 `//` 解析）。 */
const PROTOCOL_RELATIVE = /^[\\/][\\/]/;

/**
 * 校验来自页面的 href：解析成功后**只认协议白名单**，返回绝对化后的安全 href；
 * 一切不合规（`javascript:` / `data:` / `vbscript:` / 自定义协议 / 相对协议
 * `//host` 与其反斜杠变体 / 解析失败）返回 null，由调用方降级为纯文本译文——
 * 不抛错、不"清洗"后保留、也不留一个不带 href 的空壳 `<a>`。
 *
 * 相对协议先按原始字符串拦：`new URL('//x/y', base)` 会把它升级成页面的对案协议
 * 从而溜过白名单，而任务书点名它不许设 href。
 */
export function resolveSafeHref(raw: string | null, baseURI: string): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (PROTOCOL_RELATIVE.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed, baseURI);
  } catch {
    return null;
  }
  return ALLOWED_HREF_PROTOCOLS.has(url.protocol) ? url.href : null;
}

/**
 * 仅译文模式下把译文渲染成链接所需、且必须在原文被搬走**之前**采集好的一切。
 * Shadow DOM 隔离了页面 CSS，颜色与下划线只能趁链接还挂在页面上时从计算样式抄下来。
 */
interface LinkPlan {
  href: string;
  color: string;
  textDecorationLine: string;
}

/**
 * 仅译文模式下装原文的容器。
 *
 * `style="display:none"` 是**内联**样式：页面 CSS 里一条 `.jy-originals { display:block }`
 * 就能把「只显示译文」破掉，内联样式不依赖页面上有没有我们的样式表，也不给别人改写的机会。
 * `data-jy-root` 让采集端把整棵子树当成插件自己的节点跳过。
 */
const ORIGINALS_TAG = 'span';
const ORIGINALS_ATTR = 'data-jy-originals';

interface InsertionTarget {
  parent: HTMLElement;
  /** 插到 parent 内部（末尾，或 before 指定的子节点之前）；否则插到 parent 里 before 那个位置。 */
  inside: boolean;
  before: Node | null;
}

/** 仅译文模式下被藏起来的一段原文：节点都还在，只是被移进了这个 span。 */
interface HiddenOriginals {
  element: HTMLElement;
  span: HTMLElement;
  /**
   * 整元素段落（`anchor.kind === 'auto'`）：元素里装的就是这一段，全部子节点都在 span 里。
   * 元素被框架整体换掉时可以把原文搬进新元素（松散文本段不行——它的父元素是容器，
   * 里面还有别的段落，整块替换会把兄弟段落删掉）。
   */
  wholeElement: boolean;
}

/** 容器里第一个块级后代（`display:contents` 这类不算块级，继续往里找）。 */
function firstBlockInside(element: Element, styleOf: (element: Element) => string): Element | undefined {
  for (const child of Array.from(element.children)) {
    if (isBlockDisplay(styleOf(child))) return child;
    const nested = firstBlockInside(child, styleOf);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * 决定译文宿主插到哪里。只用于**双语模式** `anchor.kind === 'auto'` 的段落——
 * 松散文本段落带显式落点，由 ensureHost 直接按 `anchor.node` 插入，不走这里。
 *
 * 表格单元格、列表项、以及弹性/网格布局的子元素都必须插到内部——
 * 否则会在 <tr> 里插入非单元格节点破坏表格，或在 flex 行里被挤成一行。
 *
 * `textRun` 的段落必须留在锚点内部：它的锚点是「装着好几块内容的容器」，
 * 插到容器外面会让译文和它对应的那段原文被别的块级子元素隔开。
 * 例外是锚点本身就是紧随其后的那个块级子元素（`prepend`）；采集端在 Fix 4 之后
 * 不再产出 `prepend`（落点由 `anchor` 显式给出），这个分支只为兼容旧调用方保留。
 */
export function resolveInsertion(element: HTMLElement, segment?: ExtractedSegment): InsertionTarget {
  const parent = element.parentElement;
  if (segment?.textRun === true) {
    const isCell = element.tagName === 'TD' || element.tagName === 'TH' || element.tagName === 'LI';
    if (segment.prepend === true && parent !== null && !isCell) {
      return { parent, inside: false, before: element };
    }
    // 锚点是容器本身：留在容器内部，插到下一个块级子元素之前（没有就补在末尾），保证与原文同序。
    const view = element.ownerDocument.defaultView;
    const styleOf = (target: Element): string => view?.getComputedStyle(target).display ?? '';
    const anchor = firstBlockInside(element, styleOf);
    return { parent: element, inside: true, before: anchor?.parentElement === element ? anchor : null };
  }
  if (element.tagName === 'TD' || element.tagName === 'TH' || element.tagName === 'LI') {
    return { parent: element, inside: true, before: null };
  }
  if (parent === null) return { parent: element, inside: true, before: null };
  const view = element.ownerDocument.defaultView;
  const display = view?.getComputedStyle(parent).display;
  if (display === 'flex' || display === 'inline-flex' || display === 'grid' || display === 'inline-grid') {
    return { parent: element, inside: true, before: null };
  }
  return { parent, inside: false, before: element.nextSibling };
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class DomRenderer {
  private readonly hosts = new Map<string, HTMLElement>();
  /**
   * 仅译文模式下被藏起来的原文 → 装载它的 span。
   *
   * 用 `Map` 而不是 `WeakMap`：`restore()` 必须能**遍历**全部条目（双语模式不需要它——
   * 那边的原文一直可见，压根没有要还原的东西）。
   */
  private readonly hiddenOriginals = new Map<string, HiddenOriginals>();
  /**
   * 仅译文模式下的"这段译文应当渲染成链接"方案，按段落 id 记。
   *
   * 只在**首次 mount（pending 或 done）**、原文节点还没被搬进隐藏 span 时计算一次：
   * 链接的可见性判定与样式抄取都必须发生在链接还挂在页面原位、页面 CSS 还作用于它
   * 的时候。之后的 `update`（异步落地）只读这份快照，不再回页面 DOM 问样式——
   * 那时链接已经 `display:none`，再问抄到的就是一套死样式。
   */
  private readonly linkPlans = new Map<string, LinkPlan>();

  constructor(
    private readonly document: Document,
    private readonly mode: DisplayMode,
    private readonly onRetry?: (segmentId: string) => void,
  ) {}

  mount(segment: ExtractedSegment, state: RenderState, text?: string): void {
    if (this.mode === 'translated-only') {
      this.mountTranslatedOnly(segment, state, text);
      return;
    }
    this.setContent(this.ensureHost(segment), state, text);
  }

  update(segmentId: string, text: string): void {
    const host = this.hosts.get(segmentId);
    if (!host) return;
    // 重试成功：原文重新藏起来，让位给译文（失败时曾被放回来，见 fail）。
    this.setOriginalsHidden(segmentId, true);
    this.setContent(host, 'done', text);
  }

  /**
   * `canRetry === false` 用于**重试多少次都是同一个结果**的错误（缺 API Key、Key 无效）：
   * 只标注原因、不挂重试按钮。一个 200 段的页面否则会变成 200 个点了也没用的按钮，
   * 而用户真正该做的是去设置页填 Key（规格 §8：不重试，改为页面 toast + 弹窗红点）。
   *
   * 两种模式的失败都落在宿主上，所以**失败一定看得见**：仅译文模式下原文已经藏进
   * `display:none` 的 span，宿主就是这一页上唯一还能写字的地方（旧的就地替换实现在这里
   * 直接 `return`，用户既看不到原文、也看不到失败，还不能重试）。
   */
  fail(segmentId: string, message: string, canRetry = true): void {
    const host = this.hosts.get(segmentId);
    if (!host) return;
    // **失败时把原文放回来。** 仅译文模式下原文本来是藏着的，一旦整页失败（没填 Key、
    // 断网、限流），页面上就只剩一片红字——用户连想读的原文都看不见，得先按 Alt+T 才能读。
    // 那比"遮挡"更糟：遮挡只是多了一倍文字，这个是把内容整个拿走了。
    // 重试成功时 update() 会重新藏起来。
    this.setOriginalsHidden(segmentId, false);
    this.setContent(host, 'error', message, canRetry);
  }

  /** 仅译文模式下原文的显隐。双语模式没有这条记录，调用是空操作。 */
  private setOriginalsHidden(segmentId: string, hidden: boolean): void {
    const record = this.hiddenOriginals.get(segmentId);
    if (record === undefined) return;
    record.span.style.display = hidden ? 'none' : '';
  }

  /**
   * 仅译文模式：把原文**包起来藏掉**，而不是删掉它。
   *
   * 三步（见 `hideOriginals`）：
   * 1. 新建 `<span data-jy-originals data-jy-root style="display:none">`；
   * 2. 把这一段的原文节点**按原相对顺序**搬进去（是搬移不是克隆：还原就是把它们搬回去）；
   * 3. 把 span 与 `<jy-translation>` 译文宿主放进元素内部，宿主在 span 之后。
   *
   * 于是元素里**可见的只有译文**，而原文节点一个都没销毁。为什么是包起来而不是替换掉：
   * - 行内标记（链接、图片、加粗）全留在 DOM 里，还原时不需要重建任何东西；
   * - 对任何元素都成立——表格单元格、列表项、弹性/网格布局的子元素都只需要往元素**内部**
   *   追加，不必像双语模式那样分情况判断该插到兄弟位置还是内部；
   * - 原文一个字符都没丢，所以失败态、还原、切回双语这三种回退都还有东西可用。
   */
  private mountTranslatedOnly(segment: ExtractedSegment, state: RenderState, text?: string): void {
    const existing = this.hosts.get(segment.id);
    if (existing !== undefined) {
      // 重新进入"进行中"（用户点了重试）时把原文重新藏起来。
      this.setOriginalsHidden(segment.id, true);
      this.setContent(existing, state, text);
      return;
    }

    const host = this.createHost(segment.id);
    // 链接方案必须在 hideOriginals 把 <a> 搬进隐藏 span **之前**定下来（见 linkPlans 注释）。
    const plan = this.planLinkWrapping(segment);
    if (plan !== undefined) this.linkPlans.set(segment.id, plan);
    this.hideOriginals(segment, host);

    // 标记原文已翻译：即使后续被重复采集，extractor 也会跳过它（与双语模式同一条规则）。
    // 松散文本段（`textRun`）的 element 是**容器**，绝不能标记：
    // 整棵子树被短路之后，容器里新追加的内容就再也不会被采集了（见 extractor 的 Fix 5 取舍）。
    if (segment.textRun !== true) segment.element.setAttribute('data-jy-translated', '1');
    this.hosts.set(segment.id, host);
    this.setContent(host, state, text);
  }

  /**
   * 把这一段的原文节点搬进隐藏 span，并把 span 与宿主放进元素里。
   *
   * 两种段落形态的搬法不同，区别在于**这个元素是不是这一段的专属容器**：
   * - 整元素段落（`anchor.kind === 'auto'`）：元素里装的就是这一段，全部子节点都搬走，
   *   span 落在原来第一个子节点的位置（子节点全搬空后就是"元素末尾"）；
   * - 松散文本段（`anchor.kind === 'before'`）：元素是**容器**，里面还有别的块级子元素各自成段
   *   （`<div>Intro<p>Body</p>Outro</div>`），整块搬走会把兄弟段落连同它们自己的译文一起藏掉。
   *   只搬本段真正贡献了文字的那一串节点（见 `runNodes`），span 留在本段原来的位置。
   *
   * 宿主两种形态都放在 span 之后：整元素段落是追加到元素末尾（规格就是这三步），
   * 松散文本段则仍按 `anchor` 给出的落点插入——那正是"紧跟这段原文"的位置。
   */
  private hideOriginals(segment: ExtractedSegment, host: HTMLElement): void {
    const element = segment.element;
    const anchor = segment.anchor;
    const wholeElement = anchor.kind === 'auto';
    const nodes: Node[] = wholeElement ? Array.from(element.childNodes) : this.runNodes(element, anchor.node);

    if (nodes.length > 0) {
      const span = this.createOriginals();
      const first = nodes[0];
      // span 站在第一个原文节点原来的位置上，还原时把子节点搬回"span 之前"就回到原位。
      if (first !== undefined && first.parentNode === element) element.insertBefore(span, first);
      else element.append(span);
      span.append(...nodes);
      this.hiddenOriginals.set(segment.id, { element, span, wholeElement });
    }

    if (wholeElement) element.append(host);
    else this.insertHostAtAnchor(segment, host);
  }

  /**
   * 判定"这一段几乎全部来自同一个链接"，并抄下把译文渲染成链接所需的信息。
   *
   * 三条闸，缺一不包（保持纯文本现状）：
   * 1. 本段范围内**恰好一个** `<a href>`——多个链接时译文该整体指向谁没有答案；
   *    且它必须**可见**（隐藏子树里的链接没有文字进过段文本，采集端同一口径排除，
   *    不然会把它错算进"恰好一个"或搅黄占比）。
   * 2. 链接可见文本长度占段文本长度 **≥ 0.6**（见 {@link LINK_WRAPPING_MIN_SHARE}）。
   * 3. href 过协议白名单（见 {@link resolveSafeHref}）。
   *
   * 范围按段落形态收紧到"真正属于这一段的节点"：整元素段落查元素子树（含元素自身——
   * 段落本身就是 `<a>` 的形态也存在）；松散文本段只查它自己那一串节点，
   * 兄弟段落里的链接绝不串台（与 {@link runNodes}/hideOriginals 同一份节点判据）。
   */
  private planLinkWrapping(segment: ExtractedSegment): LinkPlan | undefined {
    const candidates = this.segmentLinks(segment).filter((link) => this.linkVisibleInSegment(link, segment));
    if (candidates.length !== 1) return undefined;
    const link = candidates[0] as Element;

    const [linkText, segmentText] = [
      normalizeText(inlineText(link, createStyleLookup())),
      normalizeText(segment.text),
    ];
    if (linkText === '' || segmentText === '') return undefined;
    if (linkText.length / segmentText.length < LINK_WRAPPING_MIN_SHARE) return undefined;

    const href = resolveSafeHref(link.getAttribute('href'), this.document.baseURI);
    if (href === null) return undefined;

    // Shadow DOM 把页面 CSS 隔离在门外：不抄的话用户看到的是默认色、没有下划线——
    // 这正是要修的事故本身。趁链接还在原位，把它的 color / text-decoration-line 抄下来。
    const computed = link.ownerDocument.defaultView?.getComputedStyle(link);
    return {
      href,
      color: computed?.color ?? '',
      textDecorationLine: computed?.textDecorationLine ?? '',
    };
  }

  /** 段落范围内所有带 href 的 `<a>`（嵌套不可能，节点两两不相交，无需去重）。 */
  private segmentLinks(segment: ExtractedSegment): Element[] {
    const found: Element[] = [];
    const consider = (element: Element): void => {
      if (element.matches('a[href]')) found.push(element);
      found.push(...Array.from(element.querySelectorAll('a[href]')));
    };
    if (segment.anchor.kind === 'auto') {
      consider(segment.element);
    } else {
      for (const node of this.runNodes(segment.element, segment.anchor.node)) {
        if (node.nodeType === Node.ELEMENT_NODE) consider(node as Element);
      }
    }
    return found.filter((link) => link.closest('[data-jy-root]') === null);
  }

  /**
   * 链接在**本段范围内**有效可见：从自身向上查到段落元素为止（含），任一环被
   * extractor 的 `isHidden` 判隐藏就不算——"藏着的链接不该参与是否包链接的判断"，
   * 与采集端"隐藏子树一个字都不采"共用同一份隐藏判据。
   */
  private linkVisibleInSegment(link: Element, segment: ExtractedSegment): boolean {
    const styleOf = createStyleLookup();
    for (let node: Element | null = link; node !== null; node = node.parentElement) {
      if (isHidden(node, styleOf)) return false;
      if (node === segment.element) return true;
    }
    return false;
  }

  /**
   * 松散文本段（`anchor.kind === 'before'`）自己那一串原文节点。
   *
   * 从锚点（本段之后的下一个节点）往前收，**只收采集端算进这一段的节点**：判据直接复用
   * 采集端的 `inlineText` —— 它对这个子元素返回空串就说明这个子元素没有为本段贡献任何文字
   * （被跳过的 `<code>` / 可编辑区域、隐藏元素、块级边界都是这样），到它就停。
   *
   * 这条判据同时挡住了最危险的一种错误：**把兄弟段落连它的译文一起藏掉**。凡是成段的元素
   * 都是块级边界（或内部含块级后代的透明包裹），`inlineText` 对它恒为空串。
   * 停早了只是这一小段仍显示原文（还能忍），停晚了就是整块内容凭空消失。
   */
  private runNodes(element: HTMLElement, anchorNode: Node | null): Node[] {
    const nodes: Node[] = Array.from(element.childNodes);
    const end =
      anchorNode !== null && anchorNode.parentNode === element ? nodes.indexOf(anchorNode) : nodes.length;
    if (end <= 0) return [];

    const styleOf = createStyleLookup();
    let start = end;
    while (start > 0) {
      const node = nodes[start - 1];
      if (node === undefined) break;
      if (node.nodeType === Node.TEXT_NODE) {
        start -= 1;
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) break;
      const child = node as Element;
      // `<br>` 是硬换行也是段边界；插件自己的 span/宿主一律不碰。
      if (child.nodeName === 'BR' || child.hasAttribute('data-jy-root')) break;
      if (inlineText(child, styleOf) === '') break;
      start -= 1;
    }
    return nodes.slice(start, end);
  }

  /**
   * 松散文本段的宿主落点：容器内部、`anchor.node` 之前；node 为 null（或已不在容器里）
   * 就追加到末尾。与双语模式 `ensureHost` 里那一段同一条规则。
   */
  private insertHostAtAnchor(segment: ExtractedSegment, host: HTMLElement): void {
    const element = segment.element;
    const node = segment.anchor.kind === 'before' ? segment.anchor.node : null;
    if (node !== null && node.parentNode === element) element.insertBefore(host, node);
    else element.append(host);
  }

  /** 装原文的 span：内联 `display:none`，见 {@link ORIGINALS_ATTR} 的注释。 */
  private createOriginals(): HTMLElement {
    const span = this.document.createElement(ORIGINALS_TAG);
    span.setAttribute(ORIGINALS_ATTR, '');
    span.setAttribute('data-jy-root', '');
    span.style.display = 'none';
    return span;
  }

  private ensureHost(segment: ExtractedSegment): HTMLElement {
    const existing = this.hosts.get(segment.id);
    if (existing) return existing;

    const host = this.createHost(segment.id);
    if (segment.anchor.kind === 'before') {
      // 松散文本段落：落点由采集端显式给出——容器内部、anchor.node 之前；node 为 null 就追加到末尾。
      // 容器里可能同时有好几段松散文本，只有显式落点才能保证译文与原文同序。
      const parent = segment.element;
      const before =
        segment.anchor.node !== null && segment.anchor.node.parentNode === parent ? segment.anchor.node : null;
      if (before !== null) parent.insertBefore(host, before);
      else parent.append(host);
    } else {
      // 整元素段落：按布局规则决定插到元素之后还是元素内部。
      const target = resolveInsertion(segment.element, segment);
      // 锚点必须真的还在算出来的父节点里，否则退回追加，别把节点插丢。
      const anchor = target.before !== null && target.before.parentNode === target.parent ? target.before : null;
      if (anchor !== null) target.parent.insertBefore(host, anchor);
      else target.parent.append(host);
    }

    // 标记原文已翻译：即使后续被重复采集，extractor 也会跳过它。
    // 松散文本段（`textRun`）的 element 是**容器**，绝不能标记：
    // 整棵子树被短路之后，容器里新追加的内容就再也不会被采集了（见 extractor 的 Fix 5 取舍）。
    if (segment.textRun !== true) segment.element.setAttribute('data-jy-translated', '1');
    this.hosts.set(segment.id, host);
    return host;
  }

  private createHost(segmentId: string): HTMLElement {
    const host = this.document.createElement(HOST_TAG);
    host.setAttribute('data-jy-root', '');
    host.setAttribute('data-jy-for', segmentId);

    const shadow = host.attachShadow({ mode: 'open' });
    const style = this.document.createElement('style');
    // 双语模式要"看得出这是译文"，仅译文模式要"看不出这不是原文"——两套诉求相反，
    // 共用一份样式就会互相破坏（详见 styles.ts 里 TRANSLATION_INLINE_CSS 的注释）。
    style.textContent = this.mode === 'translated-only' ? TRANSLATION_INLINE_CSS : TRANSLATION_CSS;
    const body = this.document.createElement('span');
    body.className = 'jy-body';
    shadow.append(style, body);
    return host;
  }

  /** 一律用 textContent 写入，杜绝引擎返回内容被当成 HTML 执行。 */
  private setContent(host: HTMLElement, state: RenderState, text?: string, canRetry = true): void {
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
      if (!canRetry) return;
      /**
       * 真正的空格文本节点，而不是只靠 CSS 的 `margin-left`：
       * 实测「接口限流，请稍后重试」+ 按钮「重试」在文本层面连成"重试重试"——
       * 复制走的就是这串文本、读屏逐字念出来、按钮被禁用样式压掉间距时直接在页面上
       * 贴成一团。两套译文样式（双语/仅译文）共用这条路径，所以补一次两边都好。
       * 不可重试的分支在上面就 return 了，不挂按钮也就不会多出这个空格。
       */
      body.append(this.document.createTextNode(' '));
      const button = this.document.createElement('button');
      button.className = 'jy-retry';
      button.type = 'button';
      button.textContent = '重试';
      button.addEventListener('click', () => {
        // 回调当场从宿主属性读 id，而不是捕获创建时的闭包变量：
        // 同一个宿主反复失败时，「重试的是哪一段」永远以当前 DOM 为准。
        const current = host.getAttribute('data-jy-for');
        if (current) this.onRetry?.(current);
      });
      body.append(button);
      return;
    }
    // 双语模式下没有段落登记过链接方案（只有仅译文模式会写 linkPlans），这段天然短路。
    const plan = this.linkPlans.get(host.getAttribute('data-jy-for') ?? '');
    if (plan !== undefined) {
      // 译文进链接：仍然一律 textContent，绝不 innerHTML——包的是我们自己的 <a> 壳，
      // 里面只有引擎返回的字符。
      const anchor = this.document.createElement('a');
      anchor.setAttribute('href', plan.href);
      if (plan.color !== '') anchor.style.color = plan.color;
      if (plan.textDecorationLine !== '') anchor.style.textDecorationLine = plan.textDecorationLine;
      anchor.textContent = text ?? '';
      body.append(anchor);
      return;
    }
    body.textContent = text ?? '';
  }

  /**
   * 还原：**逐字节**回到翻译前的样子。
   *
   * 双语模式只要把宿主摘掉就算完；仅译文模式还要把藏起来的原文搬回原位——
   * 搬回去的是**同一批节点**（不是重建的副本），所以行内标记、属性、文本节点边界
   * 全都原样回来，`outerHTML` 与翻译前逐字节相同。
   */
  restore(): void {
    for (const host of this.hosts.values()) host.remove();
    this.hosts.clear();
    this.linkPlans.clear();

    for (const { element, span, wholeElement } of this.hiddenOriginals.values()) {
      // 页面在翻译之后重建过节点时，缓存的引用指向的是脱离文档的孤儿：
      // 往孤儿里写原文等于什么也没还原，活着的节点会一直显示译文。
      const live = this.resolveLive(element) ?? element;
      // span 还挂在这个元素里（含"元素被整体移出文档"——那时它的父节点仍然是它）
      // 就直接拆；元素被框架**换掉**时按兜底那一条处理。
      const target = span.parentNode === live ? span : live.querySelector(`[${ORIGINALS_ATTR}]`);
      if (target instanceof HTMLElement) {
        this.unwrapOriginals(target);
      } else if (wholeElement && live !== element && span.childNodes.length > 0) {
        // 元素被框架整体换掉了：原文并没有丢——它就在 span 里。整元素段落的 span 装的就是
        // 这个元素的全部内容，所以可以整块搬进活着的那一个（与双语模式把快照写回活节点等价）。
        // 松散文本段不能这么干：它的父元素是容器，整块替换会把兄弟段落删掉。那种情况下
        // 只能清掉标记（原文留在已脱离文档的 span 里，不再可恢复）。
        live.replaceChildren(...Array.from(span.childNodes));
        span.remove();
      }
      element.removeAttribute('data-jy-translated');
      if (live !== element) live.removeAttribute('data-jy-translated');
    }
    this.hiddenOriginals.clear();

    // 剩下的标记全部清掉：插件没留下的痕迹才算还原干净。
    // 这一步也负责把「框架重建过、带着旧标记的新节点」解锁，否则那些节点会被永久跳过。
    for (const element of Array.from(this.document.querySelectorAll('[data-jy-id], [data-jy-translated]'))) {
      element.removeAttribute('data-jy-id');
      element.removeAttribute('data-jy-translated');
    }
  }

  /** 把隐藏 span 的子节点按原顺序搬回它原来的位置（span 之前），然后删掉 span。 */
  private unwrapOriginals(span: HTMLElement): void {
    const parent = span.parentNode;
    if (parent === null) return;
    for (const node of Array.from(span.childNodes)) parent.insertBefore(node, span);
    span.remove();
  }

  /**
   * 页面在翻译之后重建过节点时，缓存的引用指向的是脱离文档的孤儿：
   * 往孤儿里写原文等于什么也没还原，活着的节点会一直显示译文。
   * 所以先确认节点还在文档里，不在就按 data-jy-id / data-jy-for 重新找。
   */
  private resolveLive(element: HTMLElement): HTMLElement | undefined {
    if (element.isConnected) return element;
    for (const attribute of ['data-jy-id', 'data-jy-for']) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      const found = this.document.querySelector(`[${attribute}="${escapeAttributeValue(value)}"]`);
      if (found instanceof HTMLElement) return found;
    }
    return undefined;
  }
}
