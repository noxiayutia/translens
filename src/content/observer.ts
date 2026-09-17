// src/content/observer.ts
import {
  collectSegmentsWithin,
  createStyleLookup,
  isBlockDisplay,
  isHidden,
  type ExtractedSegment,
  type ExtractorOptions,
  type StyleLookup,
} from './extractor';

/**
 * 防抖窗口（毫秒）。设计文档 §4.1-7 点名的值。
 *
 * 无限滚动拨一下滚轮就是几十次 childList：每来一批节点就扫一遍、发一遍，
 * 就是把同一屏内容反复送接口。窗口内再有变动就重置计时——处理的永远是
 * 「页面安静下来后攒下的那一坨」。代价如实说：新内容的译文最多晚这么久才出现。
 */
export const INCREMENTAL_DEBOUNCE_MS = 500;

/**
 * 单轮最多处理几段；超出的段留到下一轮。
 *
 * 取值理由：默认 `maxSegmentsPerBatch`（12）的 5 倍——一轮最多 5 个满批次，
 * 默认并发 3 就是两波请求。防抖窗口已经合并了「一次滚动」，这个上限防的是
 * 另一个方向：一次大变动（切标签页回来、展开长楼层）攒下几百段时，
 * 不该几十个请求一次性砸向接口，分几轮、每轮之间隔着防抖的节奏更稳。
 * 它是增量层自己的突发保护，与用户设置的批次大小没有联动关系，
 * 所以写成显式常量并由测试钉住，而不是拿设置值现算。
 */
export const INCREMENTAL_MAX_SEGMENTS_PER_ROUND = 60;

/**
 * 「用户交互后的整页重扫」的防抖窗口（毫秒）。
 *
 * 比 `INCREMENTAL_DEBOUNCE_MS` 短，因为两者的语义不同：500ms 那一条是在等**变动潮**
 * 安静下来（滚动、框架批量插入会连着来几十条记录）；这一条是在等**点击带出的那一次渲染**
 * 落地。React/Vue 的 portal 面板走的是 `flushSync` 或一次微任务，一帧（16ms）之内就在 DOM 里了，
 * 400ms 余量足够，又能让「点开菜单」的译文几乎立刻出现，而不是等半秒。
 */
export const INTERACTION_RESCAN_DEBOUNCE_MS = 400;

/**
 * 两次整页重扫之间的最小间隔（毫秒）。
 *
 * 防抖只在**静默**时收敛：用户噼里啪啦点一串（下拉菜单、标签页、翻页器）时每次点击都会
 * 重置防抖窗口，没有节流的话这串点击结束时会连着跑好几轮整页采集。1 秒是"人连续点击的
 * 最小间隔"量级，既不打断正常的单次交互（点一下 → 400ms 后重扫一次），又能把连点收敛成
 * 至多每秒一次整页采集。
 */
export const INTERACTION_RESCAN_THROTTLE_MS = 1000;

/**
 * 整页重扫的元素数上限：超过它就**跳过**这次整页重扫，只保留原有的
 * childList / 属性可见性两条窄路径。
 *
 * 取值理由：一次整页采集的成本 ≈ 每个元素一次 `getComputedStyle` + 隐藏/块级判定。
 * 15000 元素在主流机器上仍是一次可接受的重排代价（几十毫秒），且覆盖了绝大多数
 * 内容型页面；再往上——电商列表、地图、超长文档——单次采集会到几百毫秒量级，
 * 挂在**用户每一次点击**后面就是把主线程按在地上摩擦。取 15000 是"覆盖大多数页面"
 * 与"点击绝不可能卡顿"之间的分界：超过这条线的页面退回到既有的窄路径，
 * 代价是 portal 型内容可能要还原重译才能翻（如实写进 README，不做成静默行为）。
 *
 * 判据是**点击那一刻**的实时元素数，不是页面翻译时的数量——页面可能在翻译后长出几万个节点。
 */
export const FULL_RESCAN_MAX_ELEMENTS = 15000;

/** 触发整页重扫的事件。捕获阶段挂，`passive`（我们从不 `preventDefault`）。 */
const INTERACTION_EVENTS = ['pointerdown', 'click', 'keydown'] as const;

/**
 * 一轮是被谁排起来的：`mutation` = DOM 变动（500ms 防抖），
 * `interaction` = 用户交互要求的整页重扫（400ms 防抖 + 节流，见 `schedule`）。
 * 两者的**处理链完全相同**，只有窗口与「本轮到点时扫什么根」不同。
 */
type InteractionRescanMode = 'mutation' | 'interaction';

export interface IncrementalDeps {
  /**
   * 本轮扫描的采集选项（页面翻译时的设置快照）。
   * 页面**不处于已翻译状态**（设置快照已被还原收回）时返回 null：本轮直接作废。
   */
  scanOptions(): ExtractorOptions | null;
  /** 页面仍是已翻译（renderer 还在）。还原发生在轮次中途时，在飞的批次自己丢弃。 */
  isTranslated(): boolean;
  /**
   * 本实例已被更新的内容脚本实例接管（扩展热更新、测试里的 resetModules + 重新 import）。
   * 陈旧实例的一切回调与定时器就地自裁——旧模块的 observer 挂的是**同一个** documentElement，
   * 不清理就会在下一条用例/下一次注入里往现在的页面乱写。
   */
  isStale(): boolean;
  /**
   * 把新段落送进**现有**的批次/并发/缓存链路（planBatches + runPool + sendToBackground）。
   * 两条硬契约（自变更防护窗口的收口方式依赖它们）：
   * 1. 所有页面写入（挂宿主、搬原文）**必须在第一个 await 之前同步完成**——本函数的同步段
   *    跑在观察者 disconnect 的窗口里，异步段只写 Shadow DOM（childList 看不到，天然安全）
   *    与 `[data-jy-root]` 子树内的属性（回调的属性排除挡下，见下）；
   * 2. 永远 resolve、不要 reject——逐段失败在链路内部已经收敛成失败态，抛出来只会让观察者
   *    这一轮烂尾。防御性地，这里也会兜住违约的 reject。
   */
  translate(segments: ExtractedSegment[]): Promise<void>;
}

export interface IncrementalObserver {
  /**
   * 页面翻译完成后启用增量监听，并把**首轮已翻译的段落**作为「已处理」种子。
   *
   * 种子化不可省：整元素段落有 `data-jy-translated`，重扫自然跳过；但松散文本段按上一单元
   * 的取舍**不打标记**（打了会把容器里新追加的内容一起短路掉）。不种子化，首次增量轮
   * 重扫混合容器时会把首轮的 Intro/Outro 再采一遍、再插一个宿主。
   */
  enable(alreadyTranslated: readonly ExtractedSegment[]): void;
  /** 还原时停用：断开观察、清掉在排的防抖与全部积压（含排队中的溢出段）。 */
  disable(): void;
}

/**
 * 观察哪些变动会「让内容变得可见」。
 *
 * - `childList`：新内容进 DOM（无限滚动、SPA 追加楼层）。
 * - `attributes` + **attributeFilter**：内容本来就在 DOM 里、只是改可见性——
 *   nature.com 顶部 "Explore content" 这类悬停下拉菜单是实证的形状：
 *   `<div class="c-header__dropdown">`（CSS 规则 `display:none`）在 hover 时被
 *   JS 在父 `<li>` 上切换 class 点亮，**整棵子树零节点增删**，只看 childList 的
 *   观察者一条记录都收不到，展开后露出的内容就永远没人翻。
 *
 * 为什么必须带 `attributeFilter` 而不是裸 `attributes: true`：动画库逐帧改 style、
 * 埋点脚本乱加 `data-*` 会疯狂触发回调；这里只认领**能改变可见性**的那 5 个属性
 * （class / style / hidden / aria-hidden / inert）。而且插件自己高频写的
 * `data-jy-id`、`data-jy-translated` **恰好都不在名单里**——整页标记根本不会入队，
 * 自触发面只剩「给隐藏 span 设 display」这一条，由回调里的 `[data-jy-root]` 排除挡下。
 *
 * **观察根是 `document.documentElement`，不是 `document.body`**（见 {@link resolveObserveRoot}）：
 * portal 把面板挂到 `<html>` 下、成为 body 的**兄弟**时，挂在 body 上的观察者一个字节都看不见。
 */
const OBSERVE_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'inert'],
};

/**
 * 观察根。取 `documentElement` 而不是 `body`，覆盖两类真实形态：
 *
 * - **portal 挂到 `<html>` 下**：React 的 `createPortal(…, document.body)` 是常见写法，
 *   但 Radix / Headless UI 这类库允许任意容器，`document.documentElement` 也在其中；
 *   面板此时是 body 的**兄弟**，挂在 body 上的观察者完全看不见它（digitalocean 顶部
 *   导航下拉菜单的候选原因之一）。
 * - **`<body>` 之外、`<html>` 之内的任何改动**：CSS 变量写在 `<html>` 的 style 上、
 *   站点脚本给 `<html>` 加 class（主题/滚动锁/菜单打开态）都属于这一类。
 *
 * 提根会带进更多噪音（我们自己的浮层就挂在 `documentElement` 上），噪音由既有的两道
 * 防护挡下，缺一不可（各自的测试见 observer.test.ts 的「自变更防护」一组）：
 * 1. 属性路径在回调里对 `[data-jy-root]` 子树一票否决（`closest()` 不看挂在哪，只看祖先链）；
 * 2. childList 路径上新增的插件宿主由 extractor 的 `isSkippedForText` 整体短路
 *    ——包括那一轮的唯一代价：一次函数调用。
 *
 * 写成函数而不是模块级常量：与模块里其他 DOM 读取同一个纪律，**用的时候**才读
 * `document`（内容脚本注入时机上 documentElement 一定已经有了，但没必要把这条
 * 隐含前提焊进模块求值顺序里）。
 */
function resolveObserveRoot(): Element {
  return document.documentElement;
}

/**
 * 同页共存的增量观察者注册表（挂在 globalThis：内容脚本被二次注入时是**两份模块实例**，
 * 模块级变量各一份，拦住不了另一份；测试里的 resetModules 同理）。
 * 新实例创建时把旧实例全部退役——每个实例只可能有一个 observer，两个都活着就是双份宿主。
 */
/** 同页注册表里的身份：对外接口 + 供新实例调用的 teardown。 */
interface InternalHandle extends IncrementalObserver {
  teardown(): void;
}

function globalRegistry(): InternalHandle[] {
  const holder = globalThis as { __jinyiIncrementalObservers?: InternalHandle[] };
  return (holder.__jinyiIncrementalObservers ??= []);
}

/**
 * 增量翻译观察者：页面翻译好之后**新出现**的内容也走同一条翻译链路。
 *
 * 五条骨架规则，各自钉着一类真实事故（细节与测试对应见各方法注释）：
 * 1. **自变更防护**：我们每译一段都会写 DOM（宿主、仅译文模式的隐藏 span——包括给它
 *    设 `display` 这类属性写入），这些变动本身会触发 MutationObserver。轮次全程在
 *    `disconnect()` 的窗口里写、写完 `takeRecords()` 丢弃攒下的记录、最后一步才重新
 *    `observe()`。两者的分工经实测钉过（见 `process()` 内注释与测试的变异结论）：
 *    disconnect 让自写入不进队列并丢弃未投递积压；写后的 takeRecords 兜住「注册态开轮」
 *    （溢出补轮从定时器直接起步）时漏进队列的那批记录——两个一起拆，第二轮无效扫描当场
 *    可见；只拆任何一个，另一个都还兜得住。异步阶段剩下的 light DOM 属性写入
 *    （`setOriginalsHidden` 的 style.display）由回调里的 `[data-jy-root]` 排除挡下。
 * 2. **只扫新增/新可见的子树**：候选根取自 `addedNodes`（新增元素的父容器是混合容器时
 *    改扫父容器）与「属性变化后变得可见的被改动元素」，绝不重跑整页采集——
 *    3000 段的页面上每次变动都 O(整页) 会把主线程打满。
 * 3. **属性路径只为「变得可见」服务**：被改动元素连同祖先链仍然隐藏的当场丢弃
 *    （hover 高亮、埋点类名、动画——绝大多数属性变化都是这类），从可见变隐藏的收起
 *    同样不触发；两类都走不到扫描那一步，测试按 `collectSegmentsWithin` 的调用计数钉死。
 * 4. **(容器元素, 段文本) 去重**：松散文本段不带「已处理」标记，重扫必然再采到；
 *    这张 WeakMap 是防重复插宿主的唯一屏障。键带元素——纯文本集合会把页面另一处
 *    恰好同文的段落误判成已处理。反复开合的菜单每轮都会重新扫到同一批文本，
 *    靠这一层加上整元素段的 `data-jy-translated` 短路保证请求数不涨。
 * 5. **用户交互兜底整页重扫**：前三条都建立在「内容出现时留下了我们能观察到的痕迹」之上，
 *    而这个前提有真实的破口——digitalocean 顶部导航的下拉菜单就是实证：面板由 React 在
 *    点击时现渲染，六张卡片一个都不在初始 HTML 里，正常的 childList 路径却什么都没收到
 *    （portal 挂到 `<html>` 下、或站点只切自定义属性、或面板早已在 DOM 里只是被祖先的
 *    某个我们看不见的样式控制）。**不猜是哪一种**：页面只要被用户碰一下
 *    （pointerdown / click / keydown），就调一次与整页翻译完全相同的采集，
 *    靠规则 4 的账本跳过已经翻过的内容。于是"新内容是怎么出现的"不再是触发条件的一部分。
 *    这条兜底**只由用户交互触发，绝不由 MutationObserver 触发**（有测试按调用计数锁死）：
 *    否则规则 2 的复杂度承诺当场作废，每次 DOM 变动都变成一次 O(整页)。
 */
export function createIncrementalObserver(deps: IncrementalDeps): IncrementalObserver {
  /** 「已处理」记录：容器元素 → 该容器内已采集过的段文本。enable 时整体换新（新一轮翻译重新记账）。 */
  let processed = new WeakMap<HTMLElement, Set<string>>();
  /**
   * 本轮的待办集合：只有**真实的**新增节点。交互重扫是另一个独立的布尔标志
   * （`pendingInteractionRescan`），两者在 `process()` 里汇合成同一轮。
   */
  let pendingNodes: Set<Node> = new Set();
  /**
   * 属性变化的候选：通过「回调时的廉价排除」（非元素节点 / 插件自己的 `[data-jy-root]` 子树）
   * 后被改动的元素。**可见性判定推迟到这里**（每轮一次、按元素去重），不在回调里逐条做：
   * jsdom 与浏览器都可能在同一个防抖窗口里为同一元素排进多条记录（class+style 一起改），
   * 回调里读 `getComputedStyle` 会把样式解析塞进每一批微任务；轮内一次判"最终态"不仅便宜，
   * 还天然处理了「窗口内又开又合」的翻转——开合相抵时最终是隐藏的，直接丢弃。
   */
  let pendingAttrTargets: Set<Element> = new Set();
  /** 单轮上限裁下来的溢出段 + 处理期间新攒的节点，都并进下一轮：不丢。 */
  let queued: ExtractedSegment[] = [];
  let enabled = false;
  /** 一轮在飞：处理期间的新变动只记 dirty，不并发起第二轮（两轮互相打架）。 */
  let processing = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 用户交互要求过整页重扫，但还没被本轮取走（节流窗口内也保持为 true，等窗口过去）。 */
  let pendingInteractionRescan = false;
  /** 上一次整页重扫**执行**的时刻（节流基准）。`undefined` = 还没跑过。 */
  let lastFullRescanAt: number | undefined;

  /**
   * 整页重扫距"被节流放行"还有多久（毫秒，0 = 现在就能跑）。
   *
   * 节流纯靠时钟：`lastFullRescanAt` 只在**执行**时更新，所以窗口内连点不会把基准往后推
   * （连点 10 次 = 至多一次重扫），而窗口过去后的第一次点击自然拿到 0。
   */
  function fullRescanDelay(): number {
    const last = lastFullRescanAt ?? Number.NEGATIVE_INFINITY;
    return Math.max(0, last + INTERACTION_RESCAN_THROTTLE_MS - Date.now());
  }

  /**
   * 用户交互 → 排一次整页重扫。**只置标志、只借用同一个定时器**，绝不开第二条处理链：
   * 重扫的候选根进的是同一个 `pendingNodes`，扫描在同一个 `process()` 轮里，
   * 去重靠同一本账本，也受同一个单轮上限约束。
   */
  function onInteraction(): void {
    // 未翻译（含 restorePage 之后）一律不响应：与观察者本身的启用条件同一条（见 enable）。
    if (!enabled) return;
    pendingInteractionRescan = true;
    schedule('interaction');
  }

  /**
   * 交互监听：**捕获阶段 + passive**。捕获是为了在页面自己的处理器（可能 `stopPropagation`
   * 掉冒泡）之前拿到事件；passive 是因为我们从不 `preventDefault`，别让浏览器为一次
   * 无谓的等待而放弃滚动/点击优化。
   *
   * 挂在 `document` 上：交互的目标一定是文档里的节点（`keydown` 的事件流同样经过 document）。
   *
   * 幂等：`enable()` 可能被调用多次，重复挂监听会让一次点击排 N 次（同一轮里是无害的
   * 重复置位，但监听器泄漏是真泄漏）。
   */
  let listenersAttached = false;

  function attachInteractionListeners(): void {
    if (listenersAttached) return;
    listenersAttached = true;
    for (const type of INTERACTION_EVENTS) {
      document.addEventListener(type, onInteraction, { capture: true, passive: true });
    }
  }

  /**
   * 排一轮。两类任务**共用同一个定时器、同一条处理链**——重扫只是让这一轮的候选根里
   * 多出一个 `documentElement`（见 `process()` 里的重扫分支），不新开第二条链。
   *
   * 窗口取两者中更晚的那个，两类任务各自的窗口都不会被对方缩短：
   * - 排着变动轮时用户点了：改用交互窗口 400ms（比 500ms 短，交互的响应感优先）；
   * - 排着交互重扫时又来了一条变动：仍按交互窗口算。**不能**退回 500ms 变动窗口——
   *   那会让定时器在节流还没放行时到点，重扫被推到下一轮，用户看到的是"点了没反应"。
   *
   * 节流余量只在这里读时钟，不做任何记账；记账（`lastFullRescanAt`）唯一发生的地方是
   * `process()`，由它决定这次重扫到底跑不跑。
   */
  function schedule(mode: InteractionRescanMode = 'mutation'): void {
    if (timer !== undefined) clearTimeout(timer);
    const wantsRescan = mode === 'interaction' || pendingInteractionRescan;
    const delay = wantsRescan
      ? Math.max(INTERACTION_RESCAN_DEBOUNCE_MS, fullRescanDelay())
      : INCREMENTAL_DEBOUNCE_MS;
    timer = setTimeout(() => {
      timer = undefined;
      void process();
    }, delay);
  }

  function teardown(): void {
    enabled = false;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    observer.disconnect();
    observer.takeRecords();
    pendingNodes = new Set();
    pendingAttrTargets = new Set();
    queued = [];
    dirty = false;
    // 未取走的交互请求一并作废：还原之后不许再有整页重扫冒出来（enable 会重新开始）。
    pendingInteractionRescan = false;
  }

  function claimProcessed(segment: ExtractedSegment): boolean {
    let texts = processed.get(segment.element);
    if (texts === undefined) {
      texts = new Set();
      processed.set(segment.element, texts);
    }
    if (texts.has(segment.text)) return false;
    texts.add(segment.text);
    return true;
  }

  /**
   * 该元素是否落在某个**已翻译过的整元素段落**里面（含自身）。
   *
   * extractor 的 `data-jy-translated` 短路只查元素**自身**，整页采集自顶向下走、
   * 祖先被短路就等于子树被短路；而增量是从子孙节点切入的，会绕过那道闸。
   * 所以候选根这一侧必须自己查祖先，否则会把已译内容连着一段新文本重新译一遍。
   */
  function insideTranslatedBlock(element: Element): boolean {
    return element.closest('[data-jy-translated]') !== null;
  }

  /**
   * 「混合容器」：既有非空白直接文本、又有块级直接子元素（`<div>Intro<p>…</p>Outro</div>`
   * 的 Intro/Outro 那种松散文本段形态）。新增节点长在它里面时**必须改扫父容器**：
   * 只扫新增元素本身，那段直接文本会被漏掉（它不属于任何新增元素）。
   */
  function isMixedContainer(element: Element, styleOf: StyleLookup): boolean {
    let hasDirectText = false;
    let hasBlockChild = false;
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        if ((child.nodeValue ?? '').trim() !== '') hasDirectText = true;
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const childElement = child as Element;
      // 插件自己的宿主/隐藏容器不算「块级子元素」。
      if (childElement.hasAttribute('data-jy-root')) continue;
      if (isBlockDisplay(styleOf(childElement).display)) hasBlockChild = true;
      if (hasDirectText && hasBlockChild) return true;
    }
    return false;
  }

  /**
   * 原始新增节点 → 本轮要扫描的候选根（去重：同一个父容器被多次触发只扫一次）。
   * 被移除的节点不管（removedNodes 一律忽略）。
   *
   * 交互重扫的「整页根」不从这里来（`pendingInteractionRescan` 是独立标志，在
   * `process()` 里单独解析）——本函数只回答"新增的节点该扫哪棵子树"。
   */
  function candidateRoots(nodes: ReadonlySet<Node>, styleOf: StyleLookup): Set<Element> {
    const roots = new Set<Element>();
    for (const node of nodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        // 新增的是裸文本节点：它自己成不了段（没有可挂的落点语义），只能扫它的父元素。
        //
        // 但父元素（或它的某个祖先）可能**本身就是上一轮翻好的整元素段落**：
        // `<div>Hello <span>one</span> readers</div>` 整段译完后往里追加一个裸文本节点，
        // 扫父元素会得到一段**包含已译内容**的文本，于是旧词被再译一遍、并多挂一个宿主，
        // 与已有的那个宿主并存。extractor 的 `data-jy-translated` 短路只查元素**自身**，
        // 整页路径自顶向下天然被祖先挡住，而增量路径是从子孙切入的，绕过了它——所以这里补上
        // 祖先检查。这属于"改动了已译段落"，与"只管新增"的既定范围一致：不重译、也不重复译。
        const parent = (node as Text).parentElement;
        if (parent !== null && parent.isConnected && !insideTranslatedBlock(parent)) roots.add(parent);
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const element = node as Element;
      // 注意：这里**刻意不**过滤 `[data-jy-root]`。extractor 对插件子树本来就整体短路，
      // 多扫一个宿主只花一次函数调用；但在这里提前过滤会把"自变更守卫哪天被改坏"的
      // 污染静默吞掉——测试的扫描计数就再也钉不住那组防护了。宁可多一跳，不可漏一针。
      if (!element.isConnected) continue; // 加进来又被移走：无可扫，且锚点已失效。
      const parent = element.parentElement;
      if (parent !== null && parent.isConnected && isMixedContainer(parent, styleOf)) roots.add(parent);
      else roots.add(element);
    }
    return roots;
  }

  /**
   * 「这个元素现在到底看不看得见」：自身与**整条祖先链**逐个过 extractor 的 `isHidden`。
   *
   * 只看自身会漏：`display:none` 不向后代级联计算值（子元素自己的 computed display
   * 照常是 block——实测钉在探针里），所以「隐藏子树里的元素狂改 class」这种风暴
   * 必须沿祖先链查才能当场丢弃、一次都不扫。与整页采集 `visitBlock` 的 `ancestorHidden`
   * 传递同为"祖先隐藏即短路"的口径（不认子树上 `visibility:visible` 的重新点亮，
   * 两边一致比各自更聪明重要）。走到 body 即可停：属性路径的候选根只会是被改动的元素
   * 自身，它不可能落在 `<html>` 上——我们自己的浮层虽然挂在 documentElement 下，
   * 但都在 `[data-jy-root]` 子树里，属性路径在回调里就把它们排除了。
   */
  function isEffectivelyHidden(element: Element, styleOf: StyleLookup): boolean {
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      if (isHidden(node, styleOf)) return true;
      if (node === document.body) return false;
    }
    return false;
  }

  /**
   * 整页重扫的元素数护栏：超过 {@link FULL_RESCAN_MAX_ELEMENTS} 就不做这一轮。
   *
   * 只数元素：一次整页采集的成本 ≈ 每个元素一次 `getComputedStyle` + 隐藏/块级判定，
   * 元素数就是那个成本最好的代理量。用 `getElementsByTagName('*').length` 而不是
   * `querySelectorAll`：前者返回**活集合**、`length` 由引擎维护，不构造静态 NodeList
   * （在几万节点的页面上，为了一次计数分配一个数组本身就是可观的开销）。
   *
   * 读的是**调用这一刻**的实时数量：防抖窗口里页面还在长，点击那一刻读的是旧数字。
   */
  function fullRescanAllowed(): boolean {
    return document.documentElement.getElementsByTagName('*').length <= FULL_RESCAN_MAX_ELEMENTS;
  }

  const observer = new MutationObserver((records) => {
    if (deps.isStale()) {
      teardown();
      return;
    }
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of Array.from(record.addedNodes)) pendingNodes.add(node);
        continue;
      }
      // —— 属性记录：只做**不进样式解析**的廉价排除，可见性判定留到轮内。
      const target = record.target;
      if (target.nodeType !== Node.ELEMENT_NODE) continue;
      // **插件自己的子树一票否决**：属性路径比 childList 更容易自触发——翻译链路每落地
      // 一批都高频写 style（失败/重试时 `setOriginalsHidden` 把隐藏 span 的 display 放回
      // 可见）。这些写入不是"页面露出了新内容"，永远不该开新一轮。不能靠可见性判定兜：
      // 失败态放回原文时那个 span **就是可见的**（里面还装着没藏好的原文），
      // 全靠这道排除把自触发循环掐死。刻意不用 attributeOldValue——旧值可读不等于
      // 旧状态可复原（class 字符串无法重放样式级联），判"是谁写的"比判"写成什么样"稳。
      if ((target as Element).closest('[data-jy-root]') !== null) continue;
      pendingAttrTargets.add(target as Element);
    }
    if (!enabled) return;
    if (processing) {
      // 一轮在飞：变动已经收进两个待办集，标个记号等它跑完接着扫——不丢、也不并发。
      dirty = true;
      return;
    }
    schedule();
  });

  async function process(): Promise<void> {
    if (processing) return;
    if (deps.isStale()) {
      teardown();
      return;
    }
    processing = true;
    try {
      while (enabled) {
        const options = deps.scanOptions();
        if (options === null || !deps.isTranslated()) {
          pendingNodes = new Set();
          pendingAttrTargets = new Set();
          return;
        }
        dirty = false;

        // —— 自变更防护窗口：先 disconnect 再写，最后一步才重新 observe。
        //
        // 按规范与实测，**真正起作用的是 disconnect 这一个动作**：写入发生在注销态，
        // 记录根本不会入队（jsdom 的 `disconnect()` 同时清空 `_recordQueue`）。
        // 两处 `takeRecords()` 因此是双保险而不是承重结构——变异实验证实：单独拆掉任一处
        // takeRecords 全绿，一起拆掉 disconnect + takeRecords 才红（钉在测试「溢出补轮」
        // 那条用例的注释里，含完整数据）。
        //
        // 保留双保险的理由：如果某个宿主实现偏离规范（注销后仍入队、或写入落在注册窗口里），
        // 循环会当场红在测试里，而不是等上线才炸。
        //
        // 不要把它理解成"回调投递时规范会顺带注销观察者，所以回调触发的轮次天然安全"——
        // 规范投递只清空记录队列、**不注销注册**，注册态开轮是真会自触发的。
        observer.disconnect();
        observer.takeRecords();

        const styleOf = createStyleLookup();
        const roots = candidateRoots(pendingNodes, styleOf);
        pendingNodes = new Set();

        // —— 属性候选：**在这一刻**判可见性（回调时只做了非样式的廉价排除）。
        // 判"最终态"意味着：防抖窗口内开了又合的菜单（合是最终态）与收起动作一起丢弃；
        // 展开后一直开着的才作为候选根，扫**被改动元素的子树**——class 常常加在父 <li>
        // 上，真正变可见的是它的后代，所以根取 li 而不是更深处的谁。
        // insideTranslatedBlock 与文本节点路径同一条理由：属性改动落在**已译整元素段的
        // 后代**上（比如站点给译好的段落里的 span 加 hover 类）属于"改动已译内容"，
        // 按既定范围不重译。
        for (const element of pendingAttrTargets) {
          if (!element.isConnected) continue; // 改完就被移除：锚点已失效。
          if (insideTranslatedBlock(element)) continue;
          if (isEffectivelyHidden(element, styleOf)) continue; // 仍隐藏 / 变隐藏：不扫。
          roots.add(element);
        }
        pendingAttrTargets = new Set();

        // —— 交互重扫：三条决策都在这里做（防抖窗口之后、真正扫描之前）——
        // 节流放行了吗、页面大到不该扫吗、这一次到底扫哪个根。
        //
        // 节流窗口还没过去就推迟到下一轮（`finally` 会按剩余等待重新排队）：交互请求
        // **不能**被静默吞掉，否则点得密一点就永远等不到那一次重扫。按元素数的护栏则相反，
        // 是**直接放弃**：页面大到采集不划算，推迟到什么时候都还是这么大，重试只是白等。
        // 推迟与否只看 `pendingInteractionRescan` 还留不留着，不另设标志。
        if (pendingInteractionRescan) {
          if (fullRescanDelay() > 0) {
            // 保留标志，下一轮再试。
          } else {
            pendingInteractionRescan = false;
            if (fullRescanAllowed()) {
              lastFullRescanAt = Date.now();
              // 重扫的根是 `documentElement`：与观察根同一个节点。portal 把面板挂到
              // `<html>` 下时它是 body 的**兄弟**，只扫 body 会漏掉它——那正是这次要修的事。
              roots.add(document.documentElement);
            }
          }
        }

        const fresh: ExtractedSegment[] = [];
        for (const root of roots) {
          for (const segment of collectSegmentsWithin(root, options)) {
            if (!claimProcessed(segment)) continue; // 同容器同文本：已经插过宿主，跳过。
            fresh.push(segment);
          }
        }

        const items = queued.length > 0 ? [...queued, ...fresh] : fresh;
        const take = items.slice(0, INCREMENTAL_MAX_SEGMENTS_PER_ROUND);
        queued = items.slice(take.length); // 超出上限的段留到下一轮，不一口气打爆接口。

        let round: Promise<void> = Promise.resolve();
        if (take.length > 0) {
          try {
            // 契约：同步完成全部 DOM 写入后返回 promise（见 IncrementalDeps.translate）。
            round = deps.translate(take);
          } catch {
            round = Promise.resolve(); // 违约的同步抛错：这一轮认栽，观察者不能死在这。
          }
        }
        observer.takeRecords(); // 丢弃防护窗口期间攒下的（我们自己的写入）记录。
        observer.observe(resolveObserveRoot(), OBSERVE_OPTIONS); // 恢复监听：异步阶段新来的页面变动进下一轮。

        try {
          await round;
        } catch {
          // 违约的 reject 也不许掀翻观察者：失败态早已逐段落好（或至少宿主停在原地可重试）。
        }

        if (deps.isStale()) {
          teardown();
          return;
        }
        // 处理期间又攒了变动：不睡防抖、立刻开下一轮（无限滚动下这会自然接上节奏）。
        if (dirty) continue;
        return; // 溢出段（queued 非空）、被推迟的重扫由 finally 里补排的轮次接走，保持轮间节奏。
      }
    } finally {
      processing = false;
      if (!enabled || deps.isStale()) return;
      /** 溢出段 / 处理期间新攒的变动 / 被节流推迟的交互重扫——都补排一轮，保持轮间节奏。 */
      if (dirty || queued.length > 0 || pendingInteractionRescan) schedule();
    }
  }

  const handle: InternalHandle = {
    teardown,
    enable(alreadyTranslated: readonly ExtractedSegment[]): void {
      if (deps.isStale()) return; // 已经晚节不保：新实例不该再让旧 token 的使用者上位。
      // 新实例上位：把上一份模块实例的观察者（含它的定时器）当场退役。
      const registry = globalRegistry();
      for (const other of registry) {
        if (other !== handle) other.teardown();
      }
      registry.length = 0;
      registry.push(handle);

      processed = new WeakMap(); // 新一轮翻译：增量记账从零开始，再灌首轮种子。
      pendingNodes = new Set();
      pendingAttrTargets = new Set();
      queued = [];
      dirty = false;
      // 交互重扫的节流基准**不**跨轮重置：还原→再翻译（Alt+T 连按）之后立刻点击，
      // 上一轮刚跑过的那次重扫仍然算数——重扫的成本挂在页面上，不挂在某一轮翻译上。
      pendingInteractionRescan = false;
      for (const segment of alreadyTranslated) claimProcessed(segment);

      enabled = true;
      // 用户交互的整页重扫监听：与观察者同生，由 `enabled` 决定响不响应（见 onInteraction）。
      attachInteractionListeners();
      // 首轮挂载发生在 enable **之前**，我们的写入不会生成变动记录；
      // 从这里起页面新长出来的内容才进防抖队列（整页翻译还在飞时到达的也一样——
      // 异步阶段我们的 light DOM 写入只有两类：`[data-jy-root]` 子树内的 span 搬运与
      // 它的 style.display（回调的属性排除一票否决），以及属性名单外的 data-jy-* 标记
      // （attributeFilter 连记录都不生成）；Shadow DOM 更是根本看不见，互不污染）。
      observer.disconnect();
      observer.takeRecords();
      observer.observe(resolveObserveRoot(), OBSERVE_OPTIONS);
    },
    disable(): void {
      const registry = globalRegistry();
      const index = registry.indexOf(handle);
      if (index >= 0) registry.splice(index, 1);
      teardown();
    },
  };

  // 创建即占位：即使这一份实例从没 enable 过，也要让**下一份**实例创建时能把它退役
  // （扩展热更新时上一份脚本的定时器可能还挂着）。
  globalRegistry().push(handle);

  return handle;
}
