import { containsKana, isTranslatableText, normalizeText, shouldSkip } from '../core/lang';

/** 译文宿主的落点。整元素段落交给渲染器按布局规则决定；松散文本段落必须显式给出位置。 */
export type SegmentAnchor =
  | { kind: 'auto' }
  | { kind: 'before'; node: Node | null }; // null = 追加到 element 末尾

export interface ExtractedSegment {
  id: string;
  text: string;
  order: number;
  /**
   * 段落锚点。整元素段落就是**承载整段文本的元素**；
   * 松散文本段落（见 `textRun`）则是**包裹这些直接文本节点的容器**——
   * 因为文本节点本身没有属性可挂，也没有插入点语义，落点改由 `anchor` 显式给出。
   */
  element: HTMLElement;
  /** 译文宿主的落点；松散文本段落一定是 `before`，见 {@link SegmentAnchor}。 */
  anchor: SegmentAnchor;
  /**
   * 该段只是锚点里的**一部分直接文本**，同容器里还有别的块级子元素（它们的文本各自成段）。
   * 渲染器必须把译文留在锚点**内部**，否则译文与对应原文会被块级子元素隔开。
   */
  textRun?: boolean;
  /**
   * 旧字段，采集端在 Fix 4（显式落点）之后**不再产出**：落点一律由 `anchor` 给出，
   * 这一项只是为了不动对外接口而保留声明（`resolveInsertion` 仍认识它）。
   */
  prepend?: boolean;
}

export interface ExtractorOptions {
  targetLang: string;
  /**
   * 页面级判定：**整页**文本里出现过假名（由 {@link pageHasKana} 在采集前算一次，
   * 调用方负责本轮复用）。true 时本段的"看起来已是目标语言"不再构成跳过理由——
   * 汉字是中日共用的书写系统，有假名的页面上纯汉字段落更可能是日文。
   * 省略/false 时行为与逐段判据完全相同。
   */
  pageHasKana?: boolean;
  shouldSkipText?: (text: string) => boolean;
}

/**
 * 廉价页面级扫描：给定根（通常是 `document.body`）之下是否出现过假名/片假名。
 *
 * 读的是整棵子树的 `textContent`——**整页一次**的量，不是每段一次，调用方必须
 * 缓存本轮结果（`translatePage` 拿它喂采集，增量轮直接沿用，见 index.ts）。
 * 方向上只会多翻不会漏翻：`<script>`/隐藏节点里的假名也算数（宁可保守），
 * 换来的是日文页面不再整片静默没有译文。
 */
export function pageHasKana(root: ParentNode): boolean {
  return containsKana(root.textContent ?? '');
}

/**
 * 这些标签里的内容一律不翻译：代码、表单控件**的值**、多媒体与元数据。
 *
 * **BUTTON 刻意不在名单里**：当初把 BUTTON 放进来是为了"别翻表单控件"，加错了对象——
 * `<input>` / `<select>` / `<textarea>` / `<option>` 的值不是页面正文，该跳；
 * 而 `<button>` 上承载的正是用户最想翻的界面文字（digitalocean 顶部导航
 * Products / Solutions / Developers / Partners 整排不翻的事故）。图标按钮（`×`、`☰`、`3`）
 * 仍然由 {@link isTranslatableText} 的噪声闸挡在门外，不会送接口。
 */
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
]);

/**
 * `SKIP_TAGS` 的成员判定。**必须按大小写不敏感来对**：`Element.tagName` 只对 HTML
 * 命名空间的元素大写化——内联 `<svg>`（以及它里面的 `<title>` / `<style>` / `<script>`）
 * 的 tagName 是**小写**的，`SKIP_TAGS.has('SVG')` 永远对不上，"svg 一律跳过"其实一直没生效。
 * 两处各写一份大写化的判断迟早漂移，所以只留这一个谓词给三个调用点用。
 */
function hasSkipTag(element: Element): boolean {
  return SKIP_TAGS.has(element.tagName) || SKIP_TAGS.has(element.tagName.toUpperCase());
}

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

/**
 * 透明包裹：自身不生成块级盒（`contents` 连盒都不生成），但里面的块级后代仍然要按块处理。
 * 只看 BLOCK_DISPLAYS 会把这些包裹整体当成行内，于是整棵子树既不成段也不参与拼接，
 * 那片区域永远没有译文，父容器还会被标记成已翻译——静默漏翻。
 */
const TRANSPARENT_DISPLAYS = new Set(['inline-block', 'inline-flex', 'inline-grid', 'contents']);

/** 递归判定的深度上限。DOM 是树、不可能成环，但病态深树不该把调用栈吃掉。 */
const MAX_WRAPPER_DEPTH = 16;

interface ElementStyle {
  display: string;
  visibility: string;
}

/** `styleOf` 的读取口径。渲染器要复用 {@link inlineText}，所以这个形状是导出的。 */
export interface StyleLookup {
  (element: Element): ElementStyle;
}

/**
 * `getComputedStyle` 每次都强制样式解析，而一次采集会对同一元素问好几遍
 * （隐藏判定、块级判定、文本段扫描），10k 元素的页面就是 3 万次。
 * 一次采集内同一元素的结果不会变（这期间我们不插节点、不改样式），缓存起来即可。
 * 跨采集必须丢弃：页面可能在这之间改了样式。
 *
 * 渲染器也用同一条口径（见 {@link inlineText}）："这个元素为这一段贡献了哪些文字"
 * 只能有一份实现，两边各写一套必然随改动漂移。
 */
export function createStyleLookup(): StyleLookup {
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

/**
 * 「这个元素自己藏没藏」的**唯一**判据（`hidden` / `aria-hidden` / `display:none` / `visibility`）。
 *
 * **导出**：增量观察者的属性路径（`observer.ts`）要用同一条口径判断"被改动的元素
 * 现在到底可不可见"——"什么算看不见"在整页采集与增量触发里必须逐字相同，两处各写
 * 一份必然随改动漂移（`isEditable` 是同一个教训）。
 * 注意它只看元素**自身**：祖先的隐藏由调用方沿祖先链自行处理（见 observer 的
 * `isEffectivelyHidden`），整页采集则是自顶向下把 `ancestorHidden` 传下去。
 */
export function isHidden(element: Element, styleOf: StyleLookup): boolean {
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
  return hasSkipTag(element) || isEditable(element) || element.closest('[data-jy-root]') !== null;
}

/**
 * 可编辑区域（`contenteditable`）里的文本一律不采集。
 *
 * 用户**正在写、还没保存**的内容——邮件草稿、笔记、评论框——是隐私：它确实"在网页里可见"，
 * 但它是用户的半成品，不是网页的内容，不该被送去外部接口（README 的隐私承诺）。
 *
 * 两层判定：
 * 1. `element.isContentEditable` 是标准做法，浏览器把可编辑性**继承**给后代
 *    （`<div contenteditable="true"><p>草稿</p></div>` 里的 `p` 也是可编辑的）；
 * 2. 宿主没实现该属性时（老引擎、测试环境）退回按最近的 `[contenteditable]` 祖先判定，
 *    显式的 `contenteditable="false"` 会把它自己与子树重新变回不可编辑（所见即所得编辑器
 *    用它嵌只读片段），`inherit` 则继续往上找。
 *
 * **导出**：划词选区（`selection.ts` 的 `readSelection`）判 anchor/focus 所在祖先时
 * 复用这一份——"什么算可编辑区域"整页采集与划词必须同一口径（README 对两者承诺同一件事），
 * 两处各写一份必然随改动漂移。
 */
export function isEditable(element: Element): boolean {
  if ((element as HTMLElement).isContentEditable === true) return true;
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const value = node.getAttribute('contenteditable');
    if (value === null || value === 'inherit') continue;
    return value !== 'false';
  }
  return false;
}

/**
 * 「什么算一段」的**向上**判据：从给定元素出发，找最近的叶子文本块。
 * 悬停翻译用它，整页翻译（{@link collectSegments}）按同一批底层谓词向下切段——
 * 两处各写一份判据迟早会漂移，所以这些谓词（{@link isBlockBoundary}、{@link inlineText}、
 * {@link isHidden}、{@link isSkippedForText}）只此一份，谁要用谁就 import。
 *
 * 一个元素是"叶子文本块"，当且仅当：
 * 1. 它自己不在被跳过的范围里（`[data-jy-root]` 子树、`SKIP_TAGS`、可编辑区域）——
 *    命中即**直接返回 null**：右键/悬停落在输入框、下拉框或代码块上不是"段落没找到"，是"这里不该翻译"；
 *    （按钮不在跳过名单里：悬停落在按钮文字上就该翻按钮那段——见 `SKIP_TAGS` 的注释。）
 * 2. 它内部没有块级边界子元素（有就是容器，块级子元素各自成段，见 collectSegments 的注释）；
 * 3. 它的可见文本可翻译（{@link isTranslatableText}，与采集端同一条判据）；
 * 4. 它是"块"——自身是块级边界（{@link isBlockBoundary}），或其父是 body
 *    （采集以 `document.body` 为根，它的直接子元素一律会被 visitBlock，行内也算）。
 *    少了这条，`<p>Hello <b>world</b></p>` 里悬停 `<b>` 会把 `world` 单独当一段，
 *    而采集端认定的是整段 `Hello world`——判据就漂移了。
 *
 * 不满足 2~4 的元素（隐藏元素、容器、行内包裹）继续向上找；到根还没有就返回 null。
 *
 * 已知边界：混合容器（`<div>Intro<p>Body</p></div>` 的 Intro）在采集端是松散文本段，
 * 但它**有**块级子元素，本函数按上面的判据返回 null——指针停在容器留白上时没有可悬停的
 * 整段。这是刻意收紧：宁可少翻一处，也不在悬停路径上重做一遍 textRun 的落点判定。
 */
export function findLeafTextAncestor(element: Element | null): HTMLElement | null {
  const styleOf = createStyleLookup();
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    // 1. 命中即停：这些区域不是"还没找到段落"，是"这里永远不翻译"。
    if (node.closest('[data-jy-root]') !== null) return null;
    if (hasSkipTag(node) || isEditable(node)) return null;
    // 隐藏元素本身没有可悬停的字面（display:none 不产生盒），但它的可见祖先照常是段落，
    // 所以不返回、继续向上。（aria-hidden 的可见节点走到下面的正常判定。）
    if (isHidden(node, styleOf)) continue;
    // 2. 含块级边界 → 容器，不是叶子。
    if (hasBlockBoundaryChild(node, styleOf)) continue;
    // 3. 可见文本判据与采集端逐字相同。
    if (!isTranslatableText(inlineText(node, styleOf))) continue;
    // 4. "块"身份判据与 visitBlock 的入口一致。
    const parent = node.parentElement;
    if (parent === null || parent === document.body || isBlockBoundary(node, styleOf, 0)) {
      return node instanceof HTMLElement ? node : null;
    }
  }
  return null;
}

function hasBlockBoundaryChild(element: Element, styleOf: StyleLookup): boolean {
  for (const child of Array.from(element.children)) {
    if (isSkippedForText(child) || child.nodeName === 'BR') continue;
    if (isBlockBoundary(child, styleOf, 0)) return true;
  }
  return false;
}

/**
 * 一个子元素算不算**块级边界**（即：父元素的文本到此为止，这块自己成段）：
 * 1. 它的 computed display 在白名单里；或者
 * 2. 它是透明包裹（inline-block / inline-flex / inline-grid / contents）**并且**内部存在块级后代。
 *
 * 第 2 条是必须的：`<span style="display:inline-block"><h3>标题</h3><p>正文</p></span>`
 * 与 Tailwind 的 `contents` 工具类在真实站点里都很常见。少了它，包裹内部整棵子树
 * 既不成段也不参与拼接，那片区域永远没有译文。
 * 反过来，`<span style="display:inline-block">world</span>` 内部没有块级后代，
 * 就不算边界——它仍然是父段的一部分，`<p>Hello <span …>world</span></p>` 抽成一段。
 */
function isBlockBoundary(element: Element, styleOf: StyleLookup, depth: number): boolean {
  const display = styleOf(element).display;
  if (isBlockDisplay(display)) return true;
  if (!TRANSPARENT_DISPLAYS.has(display)) return false;
  return hasBlockDescendant(element, styleOf, depth);
}

function hasBlockDescendant(
  element: Element,
  styleOf: StyleLookup,
  depth: number,
): boolean {
  if (depth > MAX_WRAPPER_DEPTH) return false;
  for (const child of Array.from(element.children)) {
    if (isSkippedForText(child) || child.nodeName === 'BR') continue;
    if (isBlockBoundary(child, styleOf, depth + 1)) return true;
  }
  return false;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

/**
 * 只有两侧都是「词字符」且都不在 CJK 区间时才补一个空格，其余一律直接拼。
 *
 * 判定必须在**拼接处**做，不能做成对整段文本的全局后处理：全局后处理分不清
 * 「插件自己补的分隔符」与「原文本来就有、或者是唯一一个的空格」，
 * 会把 `5 $` / `50 %` / `a + b` / `Well ...` / `plan — announced` 里的空格一起删掉，
 * 抽出来的文本就不再是页面上写的文本，送翻译、算缓存 key、以后术语表匹配全都跟着偏。
 */
function needsSeparator(previous: string, next: string): boolean {
  if (previous.length === 0 || next.length === 0) return false;
  const last = previous[previous.length - 1];
  const first = next[0];
  if (/\s/.test(last) || /\s/.test(first)) return false;
  // 中日韩之间不加空格；中英之间也不加（宁可贴在一起，也不要凭空多出一个空格）。
  if (CJK_CHAR.test(last) || CJK_CHAR.test(first)) return false;
  // 标点、符号旁边不加空格：`Hello` + `, and italic.` 应该是 `Hello, and italic.`
  if (!WORD_CHAR.test(last) || !WORD_CHAR.test(first)) return false;
  return true;
}

/**
 * 文本片段内部折叠空白，但**不 trim**：片段首尾的空白正是原文的分隔信息，
 * 留给 needsSeparator 判断，段尾统一 normalizeText 时再去掉。
 */
function collapseSpaces(raw: string): string {
  return raw.replace(/\s+/g, ' ');
}

/**
 * 元素**自身和行内后代**的可见文本；块级后代各自成段，这里一概不碰，
 * `<br>` 是硬换行也是段边界，同样不跨。
 * 用文本节点而不是 `innerText`：行为确定、可测，且不依赖布局。
 *
 * 返回空串就是"这个元素没有为本段贡献任何文字"——被跳过的 `<code>` / 可编辑区域、
 * 隐藏元素、块级边界以及插件自己的宿主都是这样。渲染器的「仅译文」模式正是按这条判据
 * 决定哪些节点属于**这一段**（见 `content/renderer.ts` 的 `runNodes`）：多藏一个节点
 * 就可能把兄弟段落连它的译文一起藏掉，所以判据必须与采集端是同一份。
 */
export function inlineText(element: Element, styleOf: StyleLookup): string {
  let result = '';

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const piece = collapseSpaces(node.nodeValue ?? '');
      if (piece === '') return;
      if (needsSeparator(result, piece)) result += ' ';
      result += piece;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (isSkippedForText(child) || isHidden(child, styleOf) || child.nodeName === 'BR') return;
    if (isBlockBoundary(child, styleOf, 0)) return;
    for (const grandChild of Array.from(child.childNodes)) walk(grandChild);
  };

  for (const child of Array.from(element.childNodes)) walk(child);
  // 不 trim：首尾空白留给拼接处判断要不要补分隔符。
  return result;
}

function isSkippable(element: Element): boolean {
  if (hasSkipTag(element)) return true;
  // 可编辑区域整棵子树都不采：用户没写完的草稿不上传到外部翻译接口（见 isEditable）。
  if (isEditable(element)) return true;
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
 * 段落识别的核心规则：一个元素若含有块级边界（见 {@link isBlockBoundary}）就继续下钻，
 * 否则它就是最内层的文本块，整块作为一段。
 * 这样 <p>Hello <b>world</b></p> 是一段，而 <div><p>a</p><p>b</p></div> 是两段。
 *
 * 混合内容是常态而不是特例（CMS 正文、带标签的 <li>、卡片），所以容器自己的直接文本
 * 也必须成段，且按文档顺序与块级子元素交错：
 * `<div>Intro<p>Body</p>Outro</div>` → Intro / Body / Outro 三段。
 * 同一容器的多个直接文本段共享容器锚点（`textRun`），落点由 `anchor` 显式给出。
 *
 * **语义是「扫 root 的孩子」**：传 `document.body` 时 body 自己的直接文本不在遍历范围，
 * 传某个新元素时它**自身**的直接文本也采不到。增量翻译要「只扫新增节点本身」，
 * 用的入口是 {@link collectSegmentsWithin}，别拿本函数凑（见那边注释）。
 *
 * **副作用（调用方必须知道）**：会给成段元素打上 `data-jy-id`，
 * 给**真正产出过段落的最内层文本块**打上 `data-jy-translated`。因此**每次调用都会让上一轮的全部 id 失效**，
 * 调用方不能拿旧 id 去索引新结果，也不能预期 id 跨调用稳定；
 * 这两类标记由渲染器的 `restore()` 统一清除。
 */
export function collectSegments(root: ParentNode, options: ExtractorOptions): ExtractedSegment[] {
  return collectFrom(rootElements(root), options);
}

/**
 * 增量翻译的扫描入口：把 **element 自身**当作一个块，连同它的子树一起采段。
 *
 * 为什么不能复用 `collectSegments(element)`：那个函数的语义是「扫 element 的孩子」，
 * 新增的 `<p>新段落</p>`（它自己就是最内层文本块、没有元素孩子）会被整体漏掉。
 * 除了根语义不同，其余规则——跳过标记、隐藏判定、松散文本段、`data-jy-id` /
 * `data-jy-translated` 副作用——与 {@link collectSegments} 逐字相同（同一个 {@link collectFrom}）。
 *
 * 复杂度 O(这棵子树)：已经成段并标记过的兄弟在被重扫的容器里只付一次属性检查的代价，
 * 这正是增量层「只扫新增节点/混合父容器」敢按节点逐个调用的底气。
 */
export function collectSegmentsWithin(element: Element, options: ExtractorOptions): ExtractedSegment[] {
  return collectFrom([element], options);
}

function collectFrom(roots: Element[], options: ExtractorOptions): ExtractedSegment[] {
  const segments: ExtractedSegment[] = [];
  const styleOf = createStyleLookup();
  const marked = new Set<Element>();

  const markTranslated = (element: Element): void => {
    if (marked.has(element)) return;
    element.setAttribute('data-jy-translated', '1');
    marked.add(element);
  };

  /** 返回是否真的产出了一段：调用方靠它决定要不要把元素标记成「已处理」。 */
  const push = (element: Element, text: string, anchor: SegmentAnchor, textRun: boolean): boolean => {
    if (!isTranslatableText(text)) return false;
    if (options.shouldSkipText?.(text)) return false;
    // 页面级判定为"本页含假名"时，本轮关闭"看起来已是目标语言"的跳过（见 ExtractorOptions）。
    if (shouldSkip(text, options.targetLang, { allowSameScriptSkip: !options.pageHasKana })) return false;

    const id = `jy-${segments.length + 1}-${Math.random().toString(36).slice(2, 8)}`;
    element.setAttribute('data-jy-id', id);
    const segment: ExtractedSegment = {
      id,
      text,
      order: segments.length,
      element: element as HTMLElement,
      anchor,
    };
    if (textRun) segment.textRun = true;
    segments.push(segment);
    return true;
  };

  /**
   * 处理一个元素的直接内容：自己的文本段与块级子元素**按文档顺序交错**处理，
   * 这样 `<div>Intro<p>Body</p>Outro</div>` 出来就是 Intro / Body / Outro 三段。
   * 块级子元素递归交给 visitBlock。
   */
  const visitContent = (
    element: Element,
    hidden: boolean,
    wholeElementEligible: boolean,
    blockBoundaries: ReadonlySet<Element>,
  ): void => {
    interface TextRun {
      /** 这段文本之后的下一个兄弟节点在 `element.childNodes` 里的下标（即本运行的结束位置）。 */
      after: number;
      text: string;
    }
    const runs: TextRun[] = [];
    /** 当前这段文本：{@link appendText} 一次都没跑过时为 undefined。 */
    let run: TextRun | undefined;
    /** 强制下一个文本片段另起一段（`<br>` 这样的硬边界）。 */
    let breakRun = false;
    let hasLineBreak = false;

    /**
     * 这一段文本之后的下一个兄弟节点；走到容器末尾就是 null（追加到末尾）。
     * 跳过插件自己注入的 `[data-jy-root]`：译文宿主不该成为下一段译文的落点参照。
     */
    const anchorNodeAfter = (from: number): Node | null => {
      const nodes = element.childNodes;
      for (let cursor = from; cursor < nodes.length; cursor += 1) {
        const node = nodes[cursor];
        if (node === undefined) continue;
        if (node.nodeType === Node.ELEMENT_NODE && (node as Element).hasAttribute('data-jy-root')) continue;
        return node;
      }
      return null;
    };

    const appendText = (piece: string, after: number): void => {
      if (piece === '') return;
      if (run === undefined || breakRun) {
        // 同一落点的相邻块合成一段（`Hello <b>bold</b> world` 仍是一段）；
        // 落点不同（夹着块级边界）或遇到硬边界就另起一段。
        run = { after, text: '' };
        breakRun = false;
        runs.push(run);
      }
      run.after = after;
      // 分隔符只在拼接处补，而且只在两侧都是词字符时才补。
      run.text = needsSeparator(run.text, piece) ? `${run.text} ${piece}` : `${run.text}${piece}`;
    };

    const emit = (): void => {
      if (hidden) {
        // Fix 3：隐藏子树一个字符都不产出。这里必须兜住**所有** emit 路径，
        // 不能只管段尾那一处——块级边界处的那次 emit 一样会把隐藏容器的直接文本送出去。
        runs.length = 0;
        run = undefined;
        breakRun = false;
        return;
      }
      // 整元素段落：这个元素就是最内层的文本块，而且这一段覆盖了它的全部内容。
      const whole = wholeElementEligible && runs.length === 1 && !hasLineBreak;
      let pushed = false;
      for (const item of runs) {
        // 只折叠空白并去掉段首尾的空格：标记之间该不该有空格，拼接时已经判过了。
        const text = normalizeText(item.text);
        if (text === '') continue;
        if (whole) {
          // 只有「整个元素就是这一段文本」才可以就地替换：多一个块级子元素或 <br> 都不行。
          const replaceable = element.childElementCount === 0;
          pushed = push(element, text, { kind: 'auto' }, !replaceable) || pushed;
        } else {
          // 松散文本段：落点显式给出，否则渲染器只能猜（恒取第一个块级子元素之前），
          // `<div>Intro<p>Body</p>Outro</div>` 的 Outro 译文就会跑到 Body 原文上面去。
          pushed = push(element, text, { kind: 'before', node: anchorNodeAfter(item.after) }, true) || pushed;
        }
      }
      runs.length = 0;
      run = undefined;
      breakRun = false;
      /**
       * Fix 5：只在**真产出过段落**的最内层文本块上标记「已处理」。
       * 遍历过但没产出段落的容器一律不标——标了就会让它的块级子元素在重扫时被整棵短路，
       * 「往容器里追加的新内容」就永远不再翻译（X/Twitter 这类 SPA 的增量翻译会整片失效）。
       */
      if (pushed && wholeElementEligible) markTranslated(element);
    };

    let index = 0;
    for (const child of Array.from(element.childNodes)) {
      index += 1;
      if (child.nodeType === Node.TEXT_NODE) {
        // 折叠空白但不 trim：首尾空白是原文的分隔信息，交给 needsSeparator 判断。
        const text = collapseSpaces(child.nodeValue ?? '');
        if (text === '') continue;
        appendText(text, index);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const childElement = child as Element;
      if (isSkippedForText(childElement)) continue;
      if (childElement.nodeName === 'BR') {
        // 硬换行：不跨段，否则 "1 Main St<br>Springfield" 会被粘成一个非词。
        // `index` 已经越过它，所以上一段的落点就是它本身——译文留在本行末尾。
        hasLineBreak = true;
        breakRun = true;
        run = undefined;
        continue;
      }
      if (blockBoundaries.has(childElement)) {
        // 块级边界（含内部还有块级后代的透明包裹）：先把它前面的文本段落定下来，再递归，保证段序 = 文档序。
        emit();
        if (!hidden) visitBlock(childElement, false);
        run = undefined;
        continue;
      }
      // 隐藏的行内子元素既不并入文本、也不成段：display:none / aria-hidden 里的内容
      // （未发布草稿、折叠面板、A/B 变体）不该被送到用户自己付费的翻译 API。
      if (isHidden(childElement, styleOf)) continue;
      const text = inlineText(childElement, styleOf);
      if (text === '') continue;
      appendText(text, index);
    }

    emit();
  };

  const visitBlock = (element: Element, ancestorHidden: boolean): void => {
    if (isSkippable(element)) return;

    const hidden = ancestorHidden || isHidden(element, styleOf);
    const blocks = Array.from(element.children).filter(
      (child) => !isSkippedForText(child) && isBlockBoundary(child, styleOf, 0),
    );
    const boundaries = new Set(blocks);

    if (blocks.length === 0) {
      // 整块没有任何块级边界 → 这就是最内层的文本块，整块作为一段（块内含 <br> 时按 <br> 切分）。
      if (hidden) return;
      visitContent(element, false, true, boundaries);
      return;
    }

    // 有块级边界：自己的直接文本也要成段，然后逐块下钻。
    // 这个元素本身**不**标记已处理：它的直接文本是松散文本段，标记了会让新追加的子元素在重扫时被整棵短路。
    visitContent(element, hidden, false, boundaries);
  };

  for (const element of roots) visitBlock(element, false);
  return segments;
}
