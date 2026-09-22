// src/content/diagnose.ts
/**
 * 诊断模式：**Alt+Shift + 点击任意元素 → 页面内弹一条提示说明"这段为什么没被翻译"**。
 *
 * 为什么要有它：真实站点上的漏翻（digitalocean 顶部导航下拉菜单里那几张卡片）发生在
 * **渲染后的 DOM** 里，复现不了就查不动——让用户去 DevTools 里找那个元素、Copy element，
 * 门槛高到试两次都只拿到了整棵树的根。于是把"为什么"这件事交给扩展自己回答：
 * 用户点一下那个没翻的地方，结论直接显示在页面上，**一张截图就能发回来**；
 * 同时完整链路进 `console.table`、结论进剪贴板（比截图更准，粘回来就行）。
 *
 * 三条纪律（对应三处容易写歪的地方）：
 * 1. **判据一律从 extractor 复用**，本文件一条判定逻辑都不自己写——"什么算隐藏"、
 *    "什么算一段"、"什么算可编辑区域"在采集端与诊断里必须逐字相同，两处各写一份注定漂移。
 *    采集判定本身也是**真的跑一遍采集**（`ExtractorOptions.readOnly`），不是另写一套模拟。
 *    连"这一段归谁"也要按采集端**真正会走的那条路**问：判据的入口是
 *    `findLeafTextAncestor` 与 `isBlockBoundary`，重跑的根取**归属元素**而不是点击处
 *    ——以点击处为根重跑会绕过祖先那几道闸门，结论就会说反（见 `findSegmentOwner`）。
 * 2. **绝不改变页面**：不 preventDefault、不 stopPropagation、不写标记、不插节点、不发请求。
 *    诊断是观察，不是干预——用户点它是为了看结论，不是为了改页面。
 * 3. **只在 Alt+Shift+点击时工作**，其余时候一个监听回调都不跑（见 {@link installDiagnose}）。
 *
 * 触发方式就写在提示的第一行里，用户不用记文档。
 */
import { detectScript, isTranslatableText, shouldSkip } from '../core/lang';
import {
  collectSegmentsWithin,
  createStyleLookup,
  detectHiddenKind,
  findLeafTextAncestor,
  hasBlockBoundaryChild,
  hasSkipTag,
  inlineText,
  isBlockBoundary,
  isEditable,
  isHidden,
  MAX_WRAPPER_DEPTH,
  type ExtractorOptions,
  type StyleLookup,
} from './extractor';
import { FULL_RESCAN_MAX_ELEMENTS, type IncrementalStats } from './observer';
import { toast } from './toast';

/**
 * 一级的结论码。顺序即排查顺序（见 README 的「诊断模式」一节）：
 * 前四条是"这一处本来就不该翻"，中间三条是"这里不是那一段"，最后几条是采集/渲染环节。
 */
export type DiagnoseReason =
  /** 在 `[data-jy-root]` 子树里：插件自己的浮层，本就不该翻。 */
  | 'own-overlay'
  /** 可编辑区域（contenteditable 及其后代）：有意跳过。 */
  | 'editable'
  /** 不可见（`display:none` / `visibility` / `hidden` / `aria-hidden`）。 */
  | 'hidden'
  /** 元素自身或祖先带 `data-jy-translated`：已经被当作整段处理过。 */
  | 'already-translated'
  /** 会下钻到子元素：这一级不是段落，真正该看的是子元素。 */
  | 'drills-down'
  /** 文本本身不合格（少于两个字母等噪声闸）。 */
  | 'noise'
  /** 一个字的可见文本都没有（纯装饰容器 / 只有图标）。 */
  | 'empty'
  /** 判定为"已是目标语言"而跳过。 */
  | 'target-language'
  /**
   * 元素自身**或某个祖先**是"一律跳过"的标签（表单控件的值、code/pre/svg 等）。
   * 祖先被跳过 ⇒ 整棵子树在采集端永远不会被访问，所以这一条与"点击处自己是 code"
   * 是同一个结论码，只在 `detail` 里分清"自身"还是"哪个祖先"。
   */
  | 'skip-tag'
  /** 页面压根没开始翻译（观察者未启用）：此时"没采集"与请求/渲染环节无关。 */
  | 'page-idle'
  /**
   * 页面已翻译，但这一段**不在已处理账本里**：多半是翻译后才出现的、增量轮或交互
   * 重扫还没轮到它（也可能页面大到整页重扫被护栏跳过）。与"采了没渲染"是两回事。
   */
  | 'not-in-ledger'
  /**
   * 这一段自己会成段（owner 往下的判据全过），**但从采集根走不到 owner**（owner 往上的
   * 下钻通路断了）：某个祖先既不是块级、`isBlockBoundary` 又不认为它内部有块级内容，
   * `visitBlock` 从不下钻进去 → 整棵子树永远采不到。与 "not-in-ledger" 的区别是决定性的：
   * 那种**等一次交互重扫就好**，这种**重扫一万次也不会采到，要修采集判据**。
   */
  | 'not-drillable'
  /** 真的采集过这一段，但查不到译文宿主（采了没渲染 → 请求/渲染环节）。 */
  | 'collected'
  /** 已经采集为一整段，但宿主还停在「翻译中…」。 */
  | 'pending'
  /** 就是这一段，而且已有译文。 */
  | 'translated';

/** 不可见的来源：元素自己，还是某个祖先（这决定是"真隐藏"还是"展开后没重新扫"）。 */
export type HiddenBy = 'self' | 'ancestor';

/** 一级的结论。`detail` 是给用户看的补充（点名是哪个祖先、哪种隐藏、什么字符集）。 */
export interface DiagnoseLevel {
  element: Element;
  /**
   * 元素的可读标识：`main#app > div.card > p`。
   * 只用标签名/id/类名拼，**不含任何文本内容**——诊断输出会被复制粘贴出去，
   * 片段文本可能就是用户在草稿里的东西（见 `isEditable` 的隐私取舍）。
   */
  path: string;
  /** 唯一有值的一级，`detail` 带上具体情况；其余是空对象。 */
  reason?: DiagnoseReason;
  detail?: string;
  /** `reason === 'hidden'` 时有值：谁把这一级藏了，以及是哪种隐藏方式。 */
  hiddenBy?: HiddenBy;
  hiddenKind?: string;
  /**
   * 这一级的结论**指向**哪个元素：默认就是这一级，但两种结论指向别处——
   * 浮层指向最近的那个 `[data-jy-root]`，隐藏指向真正把它藏起来的那个祖先。
   * 用户点击处与"该负责的元素"不是一回事，分开报才不会让人对着一个 span 猜。
   */
  reportedElement?: Element;
}

/** 一次诊断的完整结果。 */
export interface Diagnosis {
  /** 点击处本身（`event.target` 是文本节点时，是它的父元素）。 */
  element: Element;
  /** 取到结论的那一级；极端输入（走到上限都没有元素）时是 null。 */
  level: DiagnoseLevel | null;
  /** 最靠近点击处的那一级的结论（要显示给用户的主结论）。 */
  finding: {
    reason: DiagnoseReason;
    detail?: string;
    /** 一行结论（可读标识 + 补充）。 */
    text: string;
    hiddenBy?: HiddenBy;
    /** 结论指向的元素（见 {@link DiagnoseLevel.reportedElement}）。 */
    reportedElement: Element;
    hiddenKind?: string;
  };
  /** 从点击处到 `body` 的完整链路（含中间那些没有结论的层）。 */
  levels: DiagnoseLevel[];
  /** 分析用的采集选项（页面没翻译时为 null——那时不因"看起来已是目标语言"而跳过）。 */
  options: ExtractorOptions | null;
  /** 观察者读数快照；接线层没给就是 null。 */
  stats: IncrementalStats | null;
}

/** 诊断的依赖：全部由内容脚本注入，本模块不自己去读页面状态。 */
export interface DiagnoseDeps {
  /**
   * 本轮采集选项（页面翻译那一刻的设置快照，含目标语言与页面级假名判定）。
   * `() => null` = 页面未处于已翻译状态——诊断照样能跑（那正是要区分的一种情况）。
   */
  scanOptions(): ExtractorOptions | null;
  /**
   * 观察者读数（增量层的状态）。`() => null` = 没有观察者信息（诊断的分析内核
   * 与观察者无关，纯分析场景就该拿到 null，而不是被迫编一份假读数）。
   */
  stats(): IncrementalStats | null;
}

/**
 * 一行的可读标识。只取标签名 / id / 第一个类名：够定位，又不会把页面文本带进剪贴板。
 * 刻意不用 `:nth-child` 之类的完整 CSS 路径——提示是给人一眼看的，不是给选择器用的。
 */
function describeElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.id === '' ? '' : `#${element.id}`;
  const first = element.classList.item(0);
  return `${tag}${id}${first === null ? '' : `.${first}`}`;
}

/**
 * **是谁把这一级藏起来的**：祖先链上"自己是隐藏的、而它的父元素不是隐藏的"那个
 * **最外层**元素，就是引入者（含点击处自身）。
 *
 * 为什么要这条判据，而不是"从点击处往上找第一个隐藏的节点"：
 * `visibility` 是**继承属性**，祖先 `visibility:hidden` 时每个后代的 computed 值都是
 * `hidden`——"第一个命中的节点"永远是被点的那个元素，真凶一次都点不到名。
 * 而"自身 vs 祖先"这个区分决定用户下一步该做什么（真隐藏 vs 展开后没重新扫），
 * 报错了就是把排查引向不存在的 bug。
 *
 * 一条逻辑同时覆盖 `display:none` 与 `visibility`：判据不关心是哪种隐藏，只关心
 * "隐藏是从哪一层开始的"（`display:none` 不继承，因此它天然命中引入者那一层）。
 * 隐藏方式本身仍由 extractor 的 `detectHiddenKind` 如实报出。
 */
function locateHidden(element: Element, styleOf: StyleLookup): { kind: string; target: Element } | undefined {
  let culprit: { kind: string; target: Element } | undefined;
  // 走到 `null`（含 `documentElement`）而不是停在 body：隐藏也可能加在 `<html>` 上
  // （`<html style="visibility:hidden">` 这类加载态/过渡态），停在 body 就找不到引入者了。
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const kind = detectHiddenKind(node, styleOf);
    if (kind !== undefined) {
      const parent = node.parentElement;
      // 父元素也隐藏 ⇒ 这一层只是"继承来的隐藏"，不是引入者；越靠外层的引入者越有资格。
      if (parent === null || detectHiddenKind(parent, styleOf) === undefined) culprit = { kind, target: node };
    }
  }
  return culprit;
}

/**
 * 祖先链上最近的"这类标签一律跳过"的那一级（含自身，见 {@link hasSkipTag}）。
 *
 * **必须沿祖先链查**：采集端的跳过是**整棵子树**的（`visitBlock` 在 `isSkippable` 上一票
 * 否决，后代永远不会被访问）。只看点击处自己，`<pre><span>`、`<svg><text>`、
 * `<code><span class="token">` 这些形态就会被误报成"采了这一段但没渲染"。
 */
function locateSkipTag(element: Element): Element | undefined {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (hasSkipTag(node)) return node;
  }
  return undefined;
}

/**
 * 「**从采集根走不走得到 owner**」——owner 自己成不成段是另一半问题（{@link isOwnParagraph}），
 * 这里查的是下钻通路：真实采集从 `document.body` 的直接子元素进 `visitBlock`，
 * 之后只会钻进「块级边界」的孩子（{@link isBlockBoundary}，与采集端**同一条判据**，不另写一份）。
 * 链上第一个不被认成边界的元素，就是采集永不到达的断点：它连同整棵子树永远采不到，
 * 而"这一段自己会不会成段"从 owner 往下问却一切正常——只问下半问题就会给出
 * "等一次交互重扫就好"的**假希望**（digitalocean 卡片事故的诊断盲区，正是这条闸门出现的理由）。
 *
 * 主修（2026-09，inline 载体包块级）之后，真实可达的断点只剩一类形态：
 * **连续非块级包裹超过 `MAX_WRAPPER_DEPTH`（16）层**，块级后代探查被深度上限截断
 * （styled-components 的深层 wrapper 链可复现；README 已知限制有记载）。
 * 隐藏 / 跳过标签 / 插件浮层那些断法各有闸门在先（classify 的 1~4 条），轮不到这里报。
 * 所以这条闸门报出的每一句都是"要修代码/收窄包裹"，与 ledgerHint 的"等一下就好"严格区分。
 */
function locateDrillBreak(owner: Element, styleOf: StyleLookup): { element: Element; display: string } | undefined {
  if (owner === document.body || document.body.contains(owner) === false) return undefined;
  // owner 往上走到 body（不含），再倒序 = 从采集根往下的通路。
  const chain: Element[] = [];
  for (let node: Element | null = owner; node !== null && node !== document.body; node = node.parentElement) {
    chain.unshift(node);
  }
  // chain[0] 是 body 的直接子元素：整页采集无条件 visitBlock 每一个孩子（collectSegments 的
  // 语义就是"扫 root 的孩子"），从它往下的每一跳都必须被认成块级边界，父级才会下钻进去。
  for (const hop of chain.slice(1)) {
    if (!isBlockBoundary(hop, styleOf, 0)) return { element: hop, display: styleOf(hop).display };
  }
  return undefined;
}

/** 断点那一级的点名：tag/类与 display，以及"为什么等多久都没用"。 */
function drillBreakHint(breakPoint: { element: Element; display: string }): string {
  const { element, display } = breakPoint;
  return (
    `采集的下钻在 ${describeElement(element)}（display:${display}）处断：` +
    `它不是块级边界，里面的块级内容在 ${MAX_WRAPPER_DEPTH} 层探查上限内不可见——` +
    `重扫一万次也不会采到，需要修采集代码或收窄包裹链`
  );
}

/**
 * 这一段的**归属元素**：真实采集会把它算成哪一段的承载元素（译文宿主就挂在它上面/里面）。
 *
 * 为什么不能拿点击处当根重跑采集：`collectSegmentsWithin(点击处)` 把点击处当成一个块根，
 * 于是祖先那几道闸门（跳过标签、隐藏、可编辑）一次都不会被问到，松散文本段还会凭空多出
 * 一段"以点击处为归属"的假段落。两条判据按顺序取，都是 extractor 自己的：
 *
 * 1. {@link findLeafTextAncestor}——"整元素段落"的归属元素（段落里的行内后代 → 那个段落）；
 * 2. **块根回退**——`findLeafTextAncestor` 有一个文档里写明的已知边界（混合容器不成段，
 *    见 extractor 的注释），松散文本段拿不到，返回 null。此时归属元素是**块根**：
 *    真实采集只从两处进入 `visitBlock`——body 的直接子元素，或某个被访问块未被跳过的
 *    块级边界子元素（见 extractor 的 `visitContent`）——所以从点击处往上找第一个这样的
 *    元素，就是这一段被访问时所在的那一级。`<div><span>Intro</span><p>Body</p></div>` 的
 *    Intro 因此归到那个 `div`：宿主正是插在它里面的。
 *
 * 取不到（脱离文档、`documentElement` 这类极端输入）时返回 undefined，调用方退回
 * "就在点击处这一级问采集"的老口径。
 */
function findSegmentOwner(element: Element, styleOf: StyleLookup): Element | undefined {
  const leaf = findLeafTextAncestor(element);
  if (leaf !== null) return leaf;
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    // body 自己的直接文本不在采集范围里（整页采集以它为根，扫的是它的孩子）。
    if (node === document.body) return undefined;
    if (node.parentElement === document.body) return node;
    if (isBlockBoundary(node, styleOf, 0) && !isHidden(node, styleOf)) return node;
  }
  return undefined;
}

/**
 * 这一段自己的译文宿主：宿主挂在**归属元素**上（整元素段落挂在元素里或紧随其后，
 * 松散文本段挂在容器里——见 renderer 的 `ensureHost` / `insertHostAtAnchor`）。
 *
 * **已知边界（刻意保守）**：查的是归属元素这棵子树，认不出"这个宿主是不是这一段的"。
 * 容器里还留着兄弟段落的宿主、而这一段自己的宿主没了时，这里会当作"有宿主"，
 * 于是不说"宿主不存在"。宁可少报一次"采了没渲染"，也不要把"译文其实在页面上"说成缺失
 * ——后者正是 F2 那一类错，比不报更难查。真正的"框架把卡片里的节点整个重建"（宿主全没）
 * 仍然是能报出来的。
 */
function hostFor(owner: Element): HTMLElement | undefined {
  const host = owner.querySelector('[data-jy-for]');
  return host instanceof HTMLElement ? host : undefined;
}

function hostState(host: HTMLElement): 'pending' | 'error' | 'done' {
  const body = host.shadowRoot?.querySelector('.jy-body');
  if (body?.classList.contains('jy-pending') === true) return 'pending';
  if (body?.classList.contains('jy-error') === true) return 'error';
  return 'done';
}

/**
 * 「这一段真的进过采集吗」——**唯一的现场证据是采集端自己写下的段落标记**。
 *
 * `data-jy-id` 只在真采集里写：它由 `collectFrom` 的 `push` 给每个产出段落的承载元素打上，
 * 而诊断的重跑是 `readOnly`（只分析、不落笔），永远不会写它；`restore()` 统一清掉。
 * 观察者的「已处理账本」记的正是这些段落（每个被生产出来的段落要么当场入账、要么早就在账里），
 * 所以"有标记"就是"在账本里"的可靠读数——诊断不需要、也不许为此再维护一套状态。
 */
function wasCollected(owner: Element): boolean {
  return owner.hasAttribute('data-jy-id');
}

/**
 * "不在账本里"的下一步提示：两种真实成因都写出来。
 * 元素数上限用的是 observer 导出的那一个常量（与护栏同一个判据），不在这里另写一份阈值。
 */
function ledgerHint(stats: IncrementalStats | null): string {
  const parts = ['可能是翻译后才出现的，点一下页面或等一次交互重扫'];
  if (stats !== null && stats.elementCount > FULL_RESCAN_MAX_ELEMENTS) {
    parts.push(`也可能落在整页重扫的元素数上限之外（${stats.elementCount} 元素）`);
  }
  return parts.join('；');
}

/**
 * 这一级自己会不会**成段**。判据与采集端 `visitBlock` 的分叉逐字相同：
 * 没有块级边界子元素 ⇒ 它就是最内层的文本块，整块作为一段。
 */
function isOwnParagraph(element: Element, styleOf: StyleLookup): boolean {
  return !hasBlockBoundaryChild(element, styleOf);
}

/**
 * 这一级自己的结论。返回 null 表示"这一级没有话说"，继续向上找
 * （行内包裹、纯装饰元素等：它们既不是段落、也没被任何闸拦下）。
 */
type Verdict = Omit<DiagnoseLevel, 'element' | 'path' | 'reportedElement'> & {
  /** 报给用户时该指向哪一个元素：默认是这一级自己，浮层/隐藏则指向那个真正的源头。 */
  reportAs?: Element;
};

function classify(
  element: Element,
  options: ExtractorOptions | null,
  stats: IncrementalStats | null,
  styleOf: StyleLookup,
): Verdict | null {
  // 页面处于"已翻译"状态的**唯一**判据：有采集快照（`scanOptions`），且观察者不是在停用态。
  // 这两条分别来自 index.ts 的接线与 observer 的读数——诊断不自己去问设置、也不另存一份状态。
  // 观察者读数缺失（纯分析场景）时按"已翻译"处理：null 只说明"没有观察者信息"，
  // 不等于"页面没翻译"，拿未知冒充未启用会把结论说反。
  const pageTranslated = options !== null && (stats === null || stats.enabled);

  // 1. 插件自己的浮层：`closest` 查的是祖先链，与采集端 `isSkippedForText` 同一份语义。
  //    报**最近的那个浮层**（不是最外层的那一个）：`toast` 挂在 `documentElement` 上、
  //    译文宿主挂在段落里——用户点到的通常是宿主，说"这是插件自己的浮层"就够，
  //    但指到它到底属于哪个 [data-jy-root] 才方便开发者对照。
  const root = element.closest('[data-jy-root]');
  if (root !== null) {
    return { reason: 'own-overlay', detail: describeElement(root), reportAs: root };
  }

  // 2. 可编辑区域：用户没写完的草稿不上传到外部接口（与采集端共用 isEditable）。
  if (isEditable(element)) return { reason: 'editable' };

  // 3. 不可见：自身与祖先要分开报，见 locateHidden 的注释。
  //    排在"已翻译"之前，是因为它对用户下一步该做什么最有决定性——一个 ancestor
  //    display:none 的元素即使被标记过，用户真正需要知道的是"这个区域现在是收起的"。
  const hidden = locateHidden(element, styleOf);
  if (hidden !== undefined) {
    const by: HiddenBy = hidden.target === element ? 'self' : 'ancestor';
    return {
      reason: 'hidden',
      detail: by === 'self' ? '自身' : `祖先 ${describeElement(hidden.target)}`,
      hiddenBy: by,
      hiddenKind: hidden.kind,
      reportAs: hidden.target,
    };
  }

  // 4. 被跳过的标签：表单控件的值、code/pre、svg 等（按钮**不在**名单里，
  //    它承载的正是界面上最该翻的字）。**沿祖先链查**——祖先被跳过时整棵子树在采集端
  //    永远不会被访问，只看点击处自己就会把"这一段根本不存在"误报成"采了没渲染"。
  const skip = locateSkipTag(element);
  if (skip !== undefined) {
    return {
      reason: 'skip-tag',
      // 点名是哪一层：用户看到的是一段普通文字，得告诉他上面那层 code/pre 才是原因。
      detail: skip === element ? `自身 ${skip.tagName.toLowerCase()}` : `祖先 ${describeElement(skip)}`,
      reportAs: skip,
    };
  }

  // 5. 宿主状态：真的跑一遍采集（只分析、不落笔，见 ExtractorOptions.readOnly）问出
  //    确定答案——它是不是真的被采成一段了、以及有没有译文宿主。
  //
  //    这一条**必须排在"已翻译标记"之前**，否则一类现场永远报不出来：真实采集路径里
  //    挂宿主的同时就打了 `data-jy-translated`（见 renderer 的 ensureHost），
  //    "还在翻译中"因此必然同时带着那个标记。先看标记就会把它一律说成"已翻译"，
  //    而用户此刻看到的明明是「翻译中…」——两个通道自相矛盾。
  const host = hostFor(element);
  if (host !== undefined && hostState(host) === 'pending') {
    return { reason: 'pending', detail: '宿主在「翻译中…」' };
  }

  // 6. 已经被当作整段处理过。查的是祖先链：采集端标记的是承载整段的**段落元素**，
  //    而用户点到的往往是它里面的行内后代（`<p>` 里的 `<b>`）。
  if (element.closest('[data-jy-translated]') !== null) {
    return { reason: 'already-translated' };
  }

  // 7. 不是最内层的文本块：真正的段落是它的块级子元素。这一条**必须在文本判定之前**——
  //    容器的直接文本（松散文本段）本来就不是用户点的那个"整段"。
  if (!isOwnParagraph(element, styleOf)) return { reason: 'drills-down', detail: '子元素' };

  // 8. 文本判据：与采集端同一份（`inlineText` 算这一级自己贡献的文字）。
  const text = inlineText(element, styleOf);
  if (text.trim() === '') return { reason: 'empty' };
  if (!isTranslatableText(text)) {
    return { reason: 'noise', detail: text.trim().slice(0, 24) };
  }

  // 9. "看起来已经是目标语言"。页面级假名上下文（pageHasKana）在这里照常生效：
  //    含假名的页面上纯汉字段落不再被当成中文而跳过，诊断必须报出同一个结论。
  if (options !== null && shouldSkip(text, options.targetLang, { allowSameScriptSkip: !options.pageHasKana })) {
    return {
      reason: 'target-language',
      detail: `${detectScript(text)} → ${options.targetLang}`,
    };
  }

  // 10. 归属元素 + **以它为根**只读重跑采集：问"这一段到底会不会成段、以及宿主在不在"。
  //     根取归属元素而不是点击处，是这一条的全部要害（见 findSegmentOwner）：
  //     以点击处为根的问法会绕过祖先的闸门，并且会给松散文本段凭空造一段假段落。
  //     取不到归属元素（极端输入）时退回点击处——与这条判据出现之前的行为一致。
  const owner = findSegmentOwner(element, styleOf) ?? element;
  const segment = collectSegmentsWithin(owner, { ...(options ?? { targetLang: '' }), readOnly: true }).find(
    (candidate) => candidate.element === owner,
  );
  if (segment === undefined) {
    // 防御性分支：按上面的判据，走到这里的归属元素**一定**会成段（文本合格、不是容器、
    // 没被任何闸拦下），所以这一支在真实页面上取不到。留着是为了万一将来某个闸加了进来，
    // 诊断说的是"这一段还不在采集范围内"这句实话，而不是硬报一个"采了没渲染"。
    return { reason: 'not-in-ledger', detail: ledgerHint(stats) };
  }
  const ownerHost = hostFor(owner);
  if (ownerHost === undefined) {
    // 三种"没翻译"在这里分开（见 M1）：页面没开翻译 / 这一段还没进过账本 / 真的采了没渲染。
    // 合成一句"已采集未翻译"会把前两种也指去查请求与渲染——那是两个不存在的 bug。
    if (!pageTranslated) return { reason: 'page-idle', detail: '按 Alt+T 开始翻译整页' };
    if (!wasCollected(owner)) {
      // 闸门（见 locateDrillBreak）："不在账本"有两种成因，下一步完全不同——
      // 增量轮还没轮到 = 等一下就好；下钻通路从根上就断 = 等多久都没用。
      // 不问这一道就会对静默漏翻说出"点一下页面或等一次交互重扫"的假希望。
      const breakPoint = locateDrillBreak(owner, styleOf);
      if (breakPoint !== undefined) {
        return {
          reason: 'not-drillable',
          detail: drillBreakHint(breakPoint),
          reportAs: breakPoint.element,
        };
      }
      return { reason: 'not-in-ledger', detail: ledgerHint(stats) };
    }
    // 采了但没渲染：这正是 digitalocean 那类事故最需要区分出来的一种。
    return { reason: 'collected', detail: '宿主不存在' };
  }
  if (hostState(ownerHost) === 'pending') return { reason: 'pending', detail: '宿主在「翻译中…」' };
  return { reason: 'translated' };
}

/** 每一级的结论换算成给用户看的两段文字。**字数按"一眼看懂的最少限度"控制**。 */
const REASON_LABEL: Record<DiagnoseReason, string> = {
  'own-overlay': '插件自己的浮层，本就不该翻',
  editable: '可编辑区域，有意跳过',
  hidden: '未采集：不可见',
  'already-translated': '已翻译',
  'drills-down': '这里不是段落，点更里面的元素',
  noise: '未采集：文本不合格',
  empty: '未采集：这里没有可见文本',
  'target-language': '未采集：已是目标语言',
  'skip-tag': '未采集：这类标签一律跳过',
  'page-idle': '页面还没开始翻译',
  'not-in-ledger': '未采集：这一段还不在已处理账本里',
  'not-drillable': '未采集：采集端下钻不到这里（交互重扫永远不会采到，需要修代码）',
  collected: '已采集未翻译：宿主不存在',
  pending: '已采集，还在翻译中',
  translated: '已翻译',
};

/** 提示的第一行（结论 + 具体情况）。 */
function reasonLine(finding: DiagnoseLevel): string {
  const label = REASON_LABEL[finding.reason as DiagnoseReason];
  if (finding.reason === 'hidden') {
    return `${label}（${finding.detail ?? ''} ${finding.hiddenKind ?? ''}）`.trim();
  }
  if (finding.detail === undefined || finding.detail === '') return label;
  return `${label}（${finding.detail}）`;
}

/** 「最近一次」的读法：没跑过就直说没跑过，不拿 0 冒充时刻。 */
function since(at: number | undefined, now: number): string {
  if (at === undefined) return '无';
  return `${Math.max(0, Math.round((now - at) / 1000))}s 前`;
}

const RESCAN_LABEL: Record<NonNullable<IncrementalStats['lastInteractionRescan']>, string> = {
  ran: '已执行',
  'skipped-too-large': '被元素数上限跳过',
  throttled: '节流中，已推迟',
};

/**
 * 观察者状态一行（只出现在链路与剪贴板里，不进页面内的提示——那是"一眼看懂"的地方）。
 *
 * 这几个读数对本次排查都可能关键：观察者没启用 = 页面根本没在翻译状态；
 * 一轮增量都没跑过 = 新内容还没进过任何一轮；最近一次交互重扫被阈值跳过
 * ——那正是"点开了菜单但没翻译"最可能的解释。
 */
function observerLine(stats: IncrementalStats | null, now: number): string {
  if (stats === null) return '观察者：未知';
  const incremental =
    stats.lastIncrementalAt === undefined
      ? '最近增量：无'
      : `最近增量：${since(stats.lastIncrementalAt, now)}／${stats.lastIncrementalSegments ?? 0} 段`;
  const rescan =
    stats.lastInteractionRescan === undefined
      ? '交互重扫：无'
      : `交互重扫：${since(stats.lastInteractionRescanAt, now)}／${RESCAN_LABEL[stats.lastInteractionRescan]}${
          stats.lastInteractionRescan === 'ran' ? `（${stats.lastInteractionRescanSegments ?? 0} 段）` : ''
        }${stats.pendingInteractionRescan ? '，另有一次待跑' : ''}`;
  const observer = stats.enabled ? `观察者：已启用（已处理 ${stats.processedSegments} 段）` : '观察者：未启用';
  return [observer, incremental, rescan, `${stats.elementCount} 元素`].join(' · ');
}

/**
 * 分析一个元素：逐级向上（元素 → 父 → … → body）给结论，主结论取**最靠近点击处**的那一级。
 *
 * 到 `body` 为止是有意的：整页采集以 `body` 为根（`collectSegments(document.body, …)`），
 * `body` 自己的直接文本根本不在采集范围内，继续往上（`html`）只会得到没有意义的一级。
 *
 * 纯读：不写标记、不插节点、不发请求。这一点由 `ExtractorOptions.readOnly` 保住
 * （否则分析本身就会把那段内容永久标成"已翻译"——用户点一下诊断，内容就再也不翻了）。
 */
export function diagnoseElement(target: EventTarget, deps: DiagnoseDeps): Diagnosis {
  const styleOf = createStyleLookup();
  const options = deps.scanOptions();
  const stats = deps.stats();

  const levels: DiagnoseLevel[] = [];
  let level: DiagnoseLevel | null = null;
  // `event.target` 可能是文本节点（点在字上）：先归到它的父元素，再沿祖先链走。
  // 用 `Node` 而不是 `EventTarget` 收窄：真正要的是 `parentElement`。
  let node: Element | null =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;

  while (node !== null) {
    const verdict = classify(node, options, stats, styleOf);
    const entry: DiagnoseLevel = { element: node, path: describeElement(node) };
    if (verdict !== null) {
      // `reportAs` 是"该指向哪个元素"，落进 `reportedElement`；其余字段原样带上。
      // 两者分得清很重要：用户点的是宿主里的 span，而"这是插件自己的浮层"这句话
      // 说的是宿主本身——只报一个元素时，必须报**那个**元素。
      const { reportAs, ...fields } = verdict;
      Object.assign(entry, fields);
      entry.reportedElement = reportAs ?? node;
      levels.push(entry);
      level = entry;
      break;
    }
    levels.push(entry);
    if (node === document.body) break;
    node = node.parentElement;
  }

  const findingLevel = level;
  const finding = findingLevel?.reason;
  if (findingLevel === null || finding === undefined) {
    // 极端输入（脱离文档的节点、被拆掉的树）：给一句能读懂的话，绝不抛错。
    const element = levels[0]?.element ?? document.body;
    return {
      element,
      level: null,
      finding: {
        reason: 'drills-down',
        text: '这个元素不在页面的采集范围里，点更里面的元素',
        reportedElement: element,
      },
      levels,
      options,
      stats,
    };
  }

  return {
    // 用户点击处与"结论指向的元素"是两件事：点的是浮层里的 span，结论说的是那个浮层。
    element: findingLevel.element,
    level: findingLevel,
    finding: {
      reason: finding,
      ...(findingLevel.detail === undefined ? {} : { detail: findingLevel.detail }),
      text: reasonLine(findingLevel),
      reportedElement: findingLevel.reportedElement ?? findingLevel.element,
      ...(findingLevel.hiddenBy === undefined ? {} : { hiddenBy: findingLevel.hiddenBy }),
      ...(findingLevel.hiddenKind === undefined ? {} : { hiddenKind: findingLevel.hiddenKind }),
    },
    levels,
    options,
    stats,
  };
}

/**
 * 页面内那两行提示：第一行是结论（一眼看懂），第二行是观察者状态（截图里能带上的上下文）。
 *
 * 只做**一次** `toast()`：它是"删旧节点 + 建新节点"，多调一次就把前一条顶掉了。
 */
export function formatToast(diagnosis: Diagnosis, now = Date.now()): string {
  return `${diagnosis.finding.text}\n${observerLine(diagnosis.stats, now)}`;
}

/** 可粘贴的完整结论：主结论 + 元素 + 采集上下文 + 观察者状态。 */
export function formatClipboard(diagnosis: Diagnosis, now = Date.now()): string {
  const options = diagnosis.options;
  const context =
    options === null
      ? '采集上下文：无（页面未处于已翻译状态）'
      : `采集上下文：目标语言 ${options.targetLang}${options.pageHasKana === true ? ' · 页面含假名' : ''}`;
  return [
    `【TransLens 诊断】${diagnosis.finding.text}`,
    `元素：${diagnosis.level === null ? '（未定位）' : describePath(diagnosis)}`,
    context,
    observerLine(diagnosis.stats, now),
  ].join('\n');
}

/** 中间段被压缩掉时的占位（带省略级数，方便对照 DevTools 数层数）。 */
const ELLIPSIS = (skipped: number): string => `…${skipped} 级…`;

/** 单级路径 + 断点标记（`not-drillable` 的结论指向元素带 `⟨断点⟩`）。 */
function labelLevel(element: Element, diagnosis: Diagnosis): string {
  const base = describeElement(element);
  return element === diagnosis.finding.reportedElement && diagnosis.finding.reason === 'not-drillable'
    ? `${base}⟨断点⟩`
    : base;
}

/**
 * 一次诊断的**真实祖先链**（从 `body` 到点击处，沿 `parentElement` 逐级走）。
 *
 * 为什么不能从 `levels` 拼（旧实现的错误）：`diagnoseElement` 的循环在**第一个出结论的
 * 层级就 break**，`levels` 只有点击处到结论级那几层；旧 `describePath` 发现链头不是 body
 * 就直接补一个 `body > ` 前缀——于是把"中间 17 层不存在"的父子关系**凭空编造**出来
 * （实测输出过 `body > p.Typographystyles`，真实深度 19 级）。排查时这条假路径会把人
 * 引向完全错误的方向。这里改为只报真实的 `parentElement` 链；链很长时头尾压缩，
 * 但**结论级 / 结论指向的元素（如 not-drillable 的断点）/ 点击处**一律保留，不被压掉。
 *
 * 脱离 body 子树的极端输入（ detached 节点）：如实从链头打到点击处，不补任何假前缀。
 */
function describePath(diagnosis: Diagnosis): string {
  const clicked = diagnosis.levels[0]?.element ?? diagnosis.element;
  const chain: Element[] = [];
  for (let node: Element | null = clicked; node !== null; node = node.parentElement) {
    chain.unshift(node);
    if (node === document.body) break;
  }

  const keep = new Set<Element>([clicked, diagnosis.finding.reportedElement]);
  for (const level of diagnosis.levels) {
    if (level.reason !== undefined) keep.add(level.element);
    if (level.reportedElement !== undefined) keep.add(level.reportedElement);
  }

  // 短链整个就是信息，不做任何压缩；只有长链才留关键级、把其余折成省略段。
  if (chain.length <= 6) return chain.map((element) => labelLevel(element, diagnosis)).join(' > ');

  const parts: string[] = [];
  let skipped = 0;
  chain.forEach((element, index) => {
    // 头（链头/body）、尾两级（点击处与它爹——DevTools 里对照最常看这两级）、
    // 以及全部关键级（出结论的层、结论指向的元素，含 not-drillable 的断点）不许压掉。
    const important = keep.has(element) || index === 0 || index >= chain.length - 2;
    if (!important) {
      skipped += 1;
      return;
    }
    if (skipped > 0) {
      parts.push(ELLIPSIS(skipped));
      skipped = 0;
    }
    parts.push(labelLevel(element, diagnosis));
  });
  return parts.join(' > ');
}

// ------------------------------------------------------------------
// 触发与输出
// ------------------------------------------------------------------

/** 同页注册表：内容脚本被二次注入时是两份模块实例，模块级变量拦不住另一份（同 observer.ts）。 */
const INSTALLED = Symbol.for('jinyi.diagnose.installed');

interface InstalledHandle {
  detach(): void;
}

function registry(): InstalledHandle[] {
  const holder = globalThis as { [INSTALLED]?: InstalledHandle[] };
  return (holder[INSTALLED] ??= []);
}

/**
 * 诊断提示的显示时长：**15 秒**（默认的 3.2 秒是给状态反馈的，诊断是另一码事）。
 *
 * 实测出来的问题：提示在**屏幕底部**、只有 3.2 秒，而用户的视线在屏幕中上部**被点的那个
 * 元素**上——移视线、读两行（结论 + 观察者读数）、掏手机截图，这一串下来提示早没了。
 * 用户看到的不是"结论写错了"，而是"什么都没弹"。
 *
 * 为什么是 15 秒：
 * - 诊断由**显式动作**触发（Alt+Shift+点击），不是状态反馈，不会连着弹；长驻留不挡路——
 *   `pointer-events:none` 不吃点击，`toast()` 又是"删旧建新"，再诊断一次直接替换。
 * - 15 秒 ≈ 移回视线 + 读完两行 + 拍照的余量；再长就开始变成"这条怎么还不走"，
 *   而它固定在底部 32px，盖久了会压住页面底部的内容。
 * - 也考虑过"点别处就消失"和"常驻到下一次诊断"：前者要给诊断加一个全局监听，破掉
 *   "只在 Alt+Shift+点击时跑一个回调"那条纪律（见 installDiagnose）；后者会在用户
 *   早就离开这块区域之后还挂着一条过期结论。两者都比"定一个更大的数"更重、更容易出新 bug。
 */
const DIAGNOSE_VISIBLE_MS = 15_000;

/** 把一次诊断的结果送到三个地方。任何一个失败都只影响它自己，绝不抛给页面。 */
function report(diagnosis: Diagnosis): void {
  // 1. 页面内一行结论：用户要截图发给开发者，这是主通道。
  try {
    toast(formatToast(diagnosis), DIAGNOSE_VISIBLE_MS);
  } catch {
    // 连提示都弹不出来（页面把 documentElement 玩坏了）：下面两个通道照走。
  }

  // 2. 完整链路：给愿意开控制台的人看每一级的结论与理由。
  try {
    console.table(
      diagnosis.levels.map((level, index) => ({
        层级: index === 0 ? '点击处' : `第 ${index} 级祖先`,
        元素: level.path,
        结论: level.reason === undefined ? '（继续向上找）' : REASON_LABEL[level.reason],
        说明: level.detail ?? '',
      })),
    );
  } catch {
    // 某些环境下 console.table 不存在/被页面改写：链路信息仍在剪贴板里。
  }

  // 3. 剪贴板：失败就算了（无权限、非安全上下文都会失败），绝不弹报错——
  //    用户要的是"为什么没翻"，不是"剪贴板不可用"。
  try {
    void navigator.clipboard?.writeText(formatClipboard(diagnosis)).catch(() => undefined);
  } catch {
    // clipboard 本身不存在（老环境）或同步抛：忽略。
  }
}

/**
 * 装上诊断模式：**Alt+Shift + 点击任意元素 → 弹一条"这段为什么没被翻译"**。
 *
 * 触发条件（三条，缺一不诊断）：
 * 1. `click`、**捕获阶段**（页面脚本 `stopPropagation` 掉冒泡也拦不住我们——诊断是排查工具，
 *    不能因为被测站点的行为而失灵）；
 * 2. `altKey && shiftKey` 同时按下（普通点击一个字节都不多跑）；
 * 3. `isTrusted === true`（与划词、悬停同一套安全闸门：页面脚本合成不出真手势）。
 *
 * **绝不干预页面**：不 `preventDefault()`、不 `stopPropagation()`、不插节点、不写标记、不发请求。
 * 诊断只读页面，然后通过 toast / 剪贴板 / console.table 说话。
 *
 * 本函数只挂一个监听器，可以在 `enable`/`disable` 之间反复调用而不会叠加
 * （旧的先摘掉，同 observer.ts 的同页注册表做法）。
 */
export function installDiagnose(deps: DiagnoseDeps): void {
  const onClick = (event: MouseEvent): void => {
    if (!event.altKey || !event.shiftKey) return;
    if (!event.isTrusted) return;
    let diagnosis: Diagnosis;
    try {
      diagnosis = diagnoseElement(event.target ?? document.body, deps);
    } catch {
      // 诊断自己炸了也不许影响页面：给一句能读懂的话，别把异常抛进页面的事件流。
      // 时长与成功那条**同一个**：这条提示同样只在诊断里出现，用户的视线同样在被点的元素上
      // ——3.2 秒走完"低头、读懂、截图"和成功那条一样不可能。
      toast('诊断失败：分析这个元素时出错了', DIAGNOSE_VISIBLE_MS);
      return;
    }
    report(diagnosis);
  };

  const handle: InstalledHandle = {
    detach(): void {
      document.removeEventListener('click', onClick, true);
    },
  };
  // 上一份实例（扩展热更新、测试里的 resetModules）先摘干净。
  for (const other of registry()) other.detach();
  registry().length = 0;
  registry().push(handle);

  document.addEventListener('click', onClick, { capture: true, passive: true });
}
