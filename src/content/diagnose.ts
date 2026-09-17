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
  hasBlockBoundaryChild,
  hasSkipTag,
  inlineText,
  isBlockBoundary,
  isEditable,
  isHidden,
  type ExtractorOptions,
  type StyleLookup,
} from './extractor';
import type { IncrementalStats } from './observer';
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
  /** 被跳过的标签（表单控件的值、code/svg 等）。 */
  | 'skip-tag'
  /** 会/已经被采集为一段，但查不到译文宿主（采了没渲染 → 请求/渲染环节）。 */
  | 'collected'
  /** 已经采集为一整段，但宿主还停在「翻译中…」。 */
  | 'pending'
  /** 就是这一段，而且已有译文。 */
  | 'translated'
  /** 会在下一次采集里成段，但此刻还没有宿主（**防御性**：按现有判据取不到，见 classify）。 */
  | 'would-collect';

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

/** 元素的**自身**隐藏方式（不追祖先）。`undefined` = 自己没藏。 */
function selfHiddenKind(element: Element, styleOf: StyleLookup): string | undefined {
  return detectHiddenKind(element, styleOf);
}

/**
 * 找出把元素藏起来的那个祖先（含自身，最近的优先）。
 * 自身与祖先分开报，是因为两者的处置完全不同：真隐藏（祖先被收起）不该翻，
 * 而"展开后没重新扫"要的是再扫一次——用户看到的那一行字就是他下一步动作的依据。
 */
function locateHidden(element: Element, styleOf: StyleLookup): { kind: string; target: Element } | undefined {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const kind = detectHiddenKind(node, styleOf);
    if (kind !== undefined) return { kind, target: node };
  }
  return undefined;
}

/** 宿主状态：`[data-jy-for]` 的落点。没有宿主 = 采了没渲染（请求/渲染环节的问题）。 */
function hostFor(segment: Element): HTMLElement | undefined {
  const host = segment.querySelector('[data-jy-for]');
  return host instanceof HTMLElement ? host : undefined;
}

function hostState(host: HTMLElement): 'pending' | 'error' | 'done' {
  const body = host.shadowRoot?.querySelector('.jy-body');
  if (body?.classList.contains('jy-pending') === true) return 'pending';
  if (body?.classList.contains('jy-error') === true) return 'error';
  return 'done';
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
  styleOf: StyleLookup,
): Verdict | null {
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
  //    它承载的正是界面上最该翻的字）。
  if (hasSkipTag(element)) return { reason: 'skip-tag', detail: element.tagName.toLowerCase() };

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

  const segment = collectSegmentsWithin(element, { ...(options ?? { targetLang: '' }), readOnly: true }).find(
    (candidate) => candidate.element === element,
  );
  if (segment === undefined) {
    // 防御性分支：按上面的判据，走到这里的元素**一定**会被采成一段（文本合格、不是容器、
    // 没被任何闸拦下），所以这一支在真实页面上取不到。留着是为了万一将来某个闸加了进来，
    // 诊断说的是"还不在这轮的采集范围内"这句实话，而不是硬报一个"采了没渲染"。
    return { reason: 'would-collect', detail: '还不在这轮的采集范围内' };
  }
  if (host === undefined) {
    // 采了但没渲染：这正是 digitalocean 那类事故最需要区分出来的一种。
    return { reason: 'collected', detail: '宿主不存在' };
  }
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
  collected: '已采集未翻译：宿主不存在',
  pending: '已采集，还在翻译中',
  translated: '已翻译',
  'would-collect': '未采集：宿主不存在',
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
    const verdict = classify(node, options, styleOf);
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
    `【浸译诊断】${diagnosis.finding.text}`,
    `元素：${diagnosis.level === null ? '（未定位）' : describePath(diagnosis.levels)}`,
    context,
    observerLine(diagnosis.stats, now),
  ].join('\n');
}

/** 链路里每一级的可读路径（从 body 到点击处）。 */
function describePath(levels: DiagnoseLevel[]): string {
  const chain: string[] = [];
  for (let index = levels.length - 1; index >= 0; index -= 1) {
    const level = levels[index];
    if (level !== undefined) chain.push(level.path);
  }
  const head = describeElement(document.body);
  return chain[0] === head ? chain.join(' > ') : [head, ...chain].join(' > ');
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

/** 把一次诊断的结果送到三个地方。任何一个失败都只影响它自己，绝不抛给页面。 */
function report(diagnosis: Diagnosis): void {
  // 1. 页面内一行结论：用户要截图发给开发者，这是主通道。
  try {
    toast(formatToast(diagnosis));
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
      toast('诊断失败：分析这个元素时出错了');
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
