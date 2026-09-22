// src/content/index.ts
import { runPool } from '../core/pool';
import { planBatches, type TextSegment } from '../core/segmenter';
import { isNeverTranslate } from '../core/site-rules';
import { RETRYABLE_CODES } from '../engines/types';
import { MSG, type PageState, type TranslateItemResult, type TranslateTextsResponse } from '../shared/messages';
import { DEFAULT_SETTINGS, loadUiSettings, type DisplayMode, type UiSettings } from '../shared/settings';
import { collectSegments, pageHasKana, type ExtractedSegment, type ExtractorOptions } from './extractor';
import { installDiagnose } from './diagnose';
import { createHoverTranslator, type HoverController } from './hover';
import type { InlineTranslation } from './inline-types';
import { createIncrementalObserver } from './observer';
import { DomRenderer } from './renderer';
import { createSelectionTranslator, type SelectionController } from './selection';
import { hideTooltip } from './tooltip';
import { toast } from './toast';

/**
 * 每一轮翻译的世代号：`translatePage` 认领一次就自增，`restorePage` 也自增。
 *
 * 它给"一轮"一个身份，解决两件靠 `running` 一个布尔量表达不了的事：
 *
 * - **还原必须立刻放行下一次翻译**。还原把 renderer 置空了，但上一轮可能还在飞；
 *   如果 running 一直卡到那一轮跑完，用户"还原 → 再翻译"（Alt+T 连按两下就是这条路径）
 *   期间的所有请求都会被入口守卫悄悄吞掉——监听器照常回响应，页面什么都不做。
 * - **旧的一轮不能回来干扰新的一轮**。被接管的那一轮在 await 返回后要安静退出：
 *   不写状态（renderer / 页面级提示属于新的一轮）、也不能在 finally 里把新的一轮的
 *   running 守卫清掉（否则新的一轮在飞时又放进来第三个 renderer）。
 */
let generation = 0;
let renderer: DomRenderer | null = null;
let segments: ExtractedSegment[] = [];
let running = false;
let displayMode: DisplayMode = DEFAULT_SETTINGS.displayMode;
/**
 * 页面翻译那一刻的**设置快照**。增量翻译只复用这份快照，绝不重读设置：
 * 用户中途在弹窗里改了显示模式/目标语言，当前页面也不该一半旧模式一半新模式
 * （改动对新页面生效，本要重来请先还原）。还原时收回。
 */
let pageSnapshot: UiSettings | null = null;
/**
 * 本轮的页面级假名判定（与 `pageSnapshot` 同生同灭）。
 *
 * `shouldSkip` 在单段层面分不出"中文"与"只用汉字的日文"（见 `core/lang.ts`），
 * 这个盲区在整页翻译里表现为「東京都港区赤坂」这类纯汉字段落被当成"已是中文"静默跳过。
 * 采集前对整页 `textContent` 做一次廉价扫描补足上下文：页面出现过假名 → 本轮所有采集
 * （含增量轮）不因"看起来已是目标语言"而跳过。**每轮只扫这一次**，增量轮沿用缓存——
 * 每轮重读全文对大页面就是 O(整页) 的字符串拼接，而页面是不是日文页面不会中途翻转。
 */
let pageKanaSnapshot = false;
const finished = new Set<string>();
const failedIds = new Set<string>();

/**
 * 本内容脚本实例的身份章。同页出现**更新的一份**实例（扩展热更新；测试里的
 * resetModules + 重新 import 是同一形状）时，旧实例的 MutationObserver 仍挂在
 * **同一个** document.body 上、它自己的防抖定时器也还活着——不清理，旧实例就会
 * 往现在的页面里写自己的宿主、把请求塞进新实例的链路。增量观察者每次被唤醒
 * 都先对一下这份章：不是我就退役。
 */
const INSTANCE_TOKEN = Symbol('jinyi-content-instance');
(globalThis as { __jinyiContentInstance?: symbol }).__jinyiContentInstance = INSTANCE_TOKEN;

function currentState(): PageState {
  return {
    translated: renderer !== null,
    mode: displayMode,
    total: segments.length,
    done: finished.size,
    failed: failedIds.size,
  };
}

/**
 * 内容脚本 → 后台单次请求的超时。
 *
 * MV3 的 service worker 空闲约 30 秒就会被浏览器回收。翻译中途被回收时
 * `chrome.runtime.sendMessage` 的 promise **可能永不兑现**：端口既不关闭也不报错，
 * 于是这一批永远停在「翻译中…」——`runPool` 永不 settle、`running` 永不释放，
 * 页面卡死且连重试按钮都出不来（规格 §8：绝不静默失败）。
 *
 * 取 60 秒：默认批次（12 段 / 1000 字符）正常几秒内就回来；这个上限要容得下调度器
 * 一次退避重试（500ms + 1500ms）与慢接口的往返，又不至于让用户对着一个死页面干等。
 * 超时归这一层——调度器自身不设超时（见 `background/scheduler.ts` 的 `callEngine`）。
 */
const BACKGROUND_TIMEOUT_MS = 60_000;

/**
 * 后台在超时预算内一次都没响应。文案自带完整语义，所以不再套「无法连接后台」的壳：
 * 用户看到的应该是「后台没响应」，而不是一句会被理解成"网络不通"的通用错误。
 */
class BackgroundTimeoutError extends Error {
  constructor() {
    super(
      `后台 ${Math.round(BACKGROUND_TIMEOUT_MS / 1000)} 秒没有响应（翻译服务可能已被浏览器回收），请重试`,
    );
    this.name = 'BackgroundTimeoutError';
  }
}

/**
 * 发一条消息给后台，**最多等 `BACKGROUND_TIMEOUT_MS`**。
 *
 * 超时与消息本身的成败都收敛成同一个 promise 的两种结局，调用方（批任务 / 单条重试）
 * 原有的 try/catch 照旧兜住——失败走已有的 `failBatch` 路径进失败态并可重试，
 * 不会让整个 `runPool` 挂起。
 *
 * 定时器在两种收尾里都会清掉：内容脚本活在页面进程里，一个永不清除的定时器会被页面
 * 一直持有（页面上有几百个批次时就是几百个悬挂的定时器）。
 */
function sendToBackground(message: unknown): Promise<TranslateTextsResponse> {
  return new Promise<TranslateTextsResponse>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BackgroundTimeoutError()), BACKGROUND_TIMEOUT_MS);
    const settle = (run: () => void): void => {
      clearTimeout(timer);
      run();
    };
    try {
      (chrome.runtime.sendMessage(message) as Promise<TranslateTextsResponse>).then(
        (response) => settle(() => resolve(response)),
        (error: unknown) => settle(() => reject(error)),
      );
    } catch (raw) {
      // `sendMessage` 自己抛（极端情况下扩展上下文已失效）：与异步失败同一条路。
      settle(() => reject(raw));
    }
  });
}

/** 传输层失败的条目文案：超时自带完整语义，其余套「无法连接后台」的壳。 */
function describeTransportError(raw: unknown): string {
  if (raw instanceof BackgroundTimeoutError) return raw.message;
  return `无法连接后台：${raw instanceof Error ? raw.message : String(raw)}`;
}

/**
 * 页面级失败的文案（`ok: false`：设置读不出来这类"连请求都没发出去"的错）。
 *
 * `RATE_LIMIT` 曾经有一句罐头文案（「免费接口限流，请稍后重试或改用自定义 API」）：它**只为
 * 免费引擎写**，而删掉引擎之后剩下的**唯一**来源是 `openai-compat`（它给的是「接口限流，请稍后重试」），
 * 所以那句话 100% 是假的；更糟的是它**顶掉**了引擎自己更有信息量的那句——`response.message`
 * 本来就是引擎给的话。现在原样透传。
 *
 * **如实记账**：这一支今天**没有任何测试钉住**（T2a 改这句话之前，全仓只有这里与 `README.md`
 * 出现过那句罐头文案；README 在 T3 里也已经改掉），改动不会有测试红。
 * **不许**为此补一条"读起来像是守住了"的恒真断言——正确的守卫是
 * "没有可用引擎 ⇒ 零请求"与空态那几条，它们测的是行为，不是这句话。
 *
 * ⚠ `noticePriority`（哪种错更该先弹）**一个字都不动**：那条判的是优先级，与文案里提不提
 * 免费接口无关。
 */
function describeError(response: { code: string; message: string }): string {
  if (response.code === 'AUTH') return response.message;
  if (response.code === 'RATE_LIMIT') return response.message;
  return `翻译失败：${response.message}`;
}

/**
 * 一条页面级提示候选：文案 + 它的错误码。
 * 错误码不是装饰——整轮弹哪一条由它决定（`pickNotice`），文案自己看不出来。
 */
interface PageNotice {
  code: TranslateItemResult['code'];
  message: string;
}

/**
 * 页面级提示的优先级：`AUTH` > `RATE_LIMIT` > 其它。
 *
 * 取舍理由与规格 §8 一致：AUTH 要用户**去设置页填 Key**，不处理整页永远翻不出来；
 * RATE_LIMIT 只要等一等；其余（网络抖动、后台超时、形状不符）大多是瞬时或局部问题，
 * 段级标注已经够看到。让"最需要用户采取行动"的那条赢，而不是让"最后写入"的那条赢。
 */
function noticePriority(code: TranslateItemResult['code']): number {
  if (code === 'AUTH') return 2;
  if (code === 'RATE_LIMIT') return 1;
  return 0;
}

/**
 * 择一：优先级更高的候选顶掉较低的；**打平时保留先到的**——同码的 N 条失败说的是
 * 同一件事，后到的一条不该把先到的换掉（更不该各弹一次）。整轮收尾只 toast 这一条。
 */
function pickNotice(current: PageNotice | null, next: PageNotice): PageNotice {
  if (current === null) return next;
  return noticePriority(next.code) > noticePriority(current.code) ? next : current;
}

/** 一轮翻译（或一个增量轮）攒下的页面级提示候选集。见 {@link createNoticeTracker}。 */
interface NoticeTracker {
  record(next: PageNotice): void;
  peek(): PageNotice | null;
}

/**
 * 建一份"本轮页面级提示"账本：批次任务并发往里 `record`，整轮跑完 `peek` 一条去弹。
 *
 * 状态收在闭包里而不是模块变量上，有两个好处：每一轮天然从零开始（旧实现靠
 * `lastError = null` 手动清，清漏一次上一轮的错误就会混进这一轮）；并且
 * 整页（`translatePage`）与增量（`translateIncremental`）共用**同一套**择一逻辑，
 * 不再两处各写一份覆盖规则。
 */
function createNoticeTracker(): NoticeTracker {
  let current: PageNotice | null = null;
  return {
    record(next: PageNotice): void {
      current = pickNotice(current, next);
    },
    peek(): PageNotice | null {
      return current;
    },
  };
}

/**
 * 条目级失败要不要挂重试按钮，判据是 `engines/types.ts` 的 `RETRYABLE_CODES` 那一份，
 * 本层不再自带一套集合——两处各写一份时「哪个码算可重试」会随改动漂移。
 *
 * - 可重试：`NETWORK`（抖动）、`RATE_LIMIT`（限流），重发还有机会成功。
 * - 不可重试：`AUTH` 重试多少次都是同一个结果（规格 §8：不重试，改为页面 toast）；
 *   `TOO_LONG` 该走切分降级、`BAD_RESPONSE` 重试同一个输入没有意义——给它们挂上按钮，
 *   用户只会对着注定失败的段落反复点（一个 200 段的页面就是 200 个没用的按钮）。
 * - `code === undefined` 仍算可重试：没有错误码的失败（响应形状不符、后台漏了这条）
 *   是「这次没拿到结果」，不是「这段翻不了」。
 */
function isRetryable(code: TranslateItemResult['code']): boolean {
  return code === undefined || RETRYABLE_CODES.has(code);
}

/**
 * 整批失败且**错误码相同**时的兜底提示。
 *
 * 后台的 `translateBatch` 是逐条上报失败的（见 `background/scheduler.ts`），所以缺 API Key /
 * Key 无效这类问题表现为 `{ ok: true, results: [{ text: null, code: 'AUTH', … }, …] }`，
 * 而不是 `{ ok: false }`——`describeError` 那条路收不到它。没有这一层，用户只会看到满屏
 * 一模一样的错误标签，完全不知道发生了什么（规格 §8 要求的是「不重试；页面 toast + 弹窗红点」）。
 *
 * 只对"这一批**每一条**都失败且错误码相同"生效：部分失败是正常的，逐个标注即可。
 *
 * `batchSize` 必须显式传本批的条目数，不能拿 `failures.length === results.length` 代替：
 * 调用方传进来的可能只有失败的那些条目（`applyResults` 就是这么调的），那样比较恒为真，
 * 一条失败混在成功里也会弹出"整批失败"的提示。
 *
 * 返回 `PageNotice`（不是裸文案）：错误码要跟着走完整轮，收尾时按优先级择一（`pickNotice`）。
 * 返回 null 表示不该弹提示。
 */
function sameCodeFailureMessage(results: TranslateItemResult[], batchSize: number): PageNotice | null {
  const failures = results.filter((result) => result.text === null);
  if (failures.length === 0 || failures.length !== batchSize) return null;

  const [first] = failures;
  if (first?.code === undefined) return null;
  if (failures.some((failure) => failure.code !== first.code)) return null;

  const message = first.message ?? describeError({ code: first.code, message: '翻译失败' });
  if (first.code === 'AUTH') {
    return { code: first.code, message: `${message}（在扩展设置里填好 API Key 后重新翻译此页）` };
  }
  if (first.code === 'NETWORK') {
    // 整批网络失败几乎从不是"抖了一下"，而是这个接口根本到不了（连超时都不返回）。
    // 只说"翻译失败"会让用户以为插件坏了。保留前半句的因果链，把"换一个接口"换成
    // "核对你自己填的地址"——今天用户配的**就是**他自己的接口，"默认的免费接口"这个主语
    // 已经不存在了。
    return {
      code: first.code,
      message: `${message}。如果反复出现，说明当前网络到不了这个翻译接口——请检查该档案的接口地址是否可达（在扩展设置里核对地址与网络）。`,
    };
  }
  return { code: first.code, message };
}

/**
 * 响应里的一个条目在**运行时**是不是 `TranslateItemResult`。
 *
 * 只校验身份字段 `id`：`text` 是不是 null 由后面按条目判断（null 是正常的条目级失败），
 * 但 id 缺失/不是字符串时这条结果根本对不上任何一段，只能当它不存在。
 */
function isResultItem(value: unknown): value is TranslateItemResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id.length > 0
  );
}

/** 形状不符的响应：整批收敛成失败态时给用户看的文案。 */
const MALFORMED_RESPONSE = '翻译响应格式不正确，请重试';

/**
 * 落地一批条目级结果。
 *
 * 失败条目一律标注错误文案，重试按钮按 `isRetryable` 决定——只有 `RETRYABLE_CODES`
 * 里那两类（网络抖动、限流）才挂按钮，其余错误挂上去也只是让用户白点。
 * 整个响应**全部失败且错误码相同**时，逐条标注之外再加一句整批提示，由调用方选时机弹。
 * 返回该提示（带错误码，供收尾按优先级择一；不需要时返回 null）。
 *
 * `results` 来自消息边界，类型断言拦不住它：`TranslateTextsResponse` 只是编译期声明，
 * 后台版本不匹配、引擎适配器出错都可能回一个 `results: undefined` 或元素形状不对的响应
 * （`Array.isArray` 收窄之后这里的参数其实已经是 `unknown`）。**形状不符按本批全部失败处理**
 * （逐段失败态 + 重试），不抛异常：抛出去会逃出并发池、reject 掉整轮，把页面永久留在
 * "翻译中…"——宿主停在 pending、renderer 守卫又让后续翻译变成空操作，用户既看不到失败
 * 也重试不了（规格 §8：绝不静默失败）。
 *
 * 逐条对应而不是按下标对齐：坏的条目丢掉之后下标会错位，`id` 才是唯一的身份。
 */
function applyResults(batch: TextSegment[], results: unknown): PageNotice | null {
  if (!Array.isArray(results)) {
    failBatch(batch, MALFORMED_RESPONSE);
    return { code: undefined, message: MALFORMED_RESPONSE };
  }

  // 按 id 建立索引再逐条对应：坏形状的条目被丢掉之后下标会错位，`id` 才是唯一的身份。
  const byId = new Map<string, TranslateItemResult>();
  for (const result of results) if (isResultItem(result)) byId.set(result.id, result);

  const failures = new Map<string, TranslateItemResult>();
  // 有没有哪一段**根本没拿到结果**（形状不符被丢掉，或后台漏了这一条）。
  // 这与"部分条目翻译失败"是两回事：后者是正常的（`{ id, text: null, code }`），
  // 前者说明这个响应的形状跟本批对不上，要额外给整批提示。
  let missingResult = false;
  for (const item of batch) {
    const result = byId.get(item.id);
    if (result !== undefined && result.text !== null) {
      finished.add(item.id);
      renderer?.update(item.id, result.text);
      continue;
    }
    if (result === undefined) missingResult = true;
    const marked = result ?? { id: item.id, text: null as null, message: MALFORMED_RESPONSE };
    failures.set(item.id, marked);
    // 单条渲染失败不拖垮这一批：`failSegment` 自己兜住异常（并且已经记进 failedIds），
    // 循环必须把**剩下的每一条**都标完，否则没轮到的那些会永远停在"翻译中…"。
    failSegment(item.id, marked.message ?? '翻译失败', isRetryable(marked.code));
  }

  // 整批同码提示只按**真的回来了的**那些条目算：没回来的条目没有 code 可比，
  // 它们的提示由 MALFORMED_RESPONSE 负责。
  if (missingResult) return { code: undefined, message: MALFORMED_RESPONSE };
  return sameCodeFailureMessage([...failures.values()], batch.length);
}

/**
 * 响应级失败（`ok: false`）：连引擎都没问到，标注**本批**条目。
 *
 * 只标本批：一个响应只代表它自己那一批的对错。标整页会把别的批次已经翻译好的片段
 * 一起算成失败——`applyResults` 从不回删被误标的 id，`done + failed` 会超过 `total`，
 * 状态面板上就出现"一段既译好了又算失败"。提示不在这里弹，攒进本轮的提示账本由调用方
 * 在整轮跑完后弹一次。
 */
function failBatch(batch: TextSegment[], message: string): void {
  for (const segment of batch) failSegment(segment.id, message);
}

/**
 * 把一段标成失败态（记进 `failedIds` + 渲染）。**这一步自己绝不抛异常**：
 * 它跑在并发池的任务里，`core/pool.ts` 的契约是"调用方负责在任务内部捕获"——
 * 一个异常逃出去就会 reject 掉整轮，剩下的条目会永远停在"翻译中…"，
 * 而收尾那句 `toast(页面级提示)` 也永远到不了（页面静默卡死）。
 *
 * 第一次渲染失败就退回一句纯文本：连错误标签都挂不上去的宿主，也别再让它
 * 以一个未捕获的异常收场。
 */
function failSegment(segmentId: string, message: string, canRetry = true): void {
  failedIds.add(segmentId);
  try {
    renderer?.fail(segmentId, message, canRetry);
  } catch {
    try {
      renderer?.fail(segmentId, '翻译失败');
    } catch {
      // 这一段的宿主已经彻底不可用：失败已经记进 failedIds（状态面板仍然对得上），
      // 不再往上抛——整轮的其余条目还得继续。
    }
  }
}

async function translatePage(): Promise<void> {
  if (running) return;
  // 已经翻译过就不重复翻译；要重来请先还原（避免插入两份译文）。
  if (renderer) return;

  // 认领这一轮的身份，并**同步**占住 running：下一个触发（同一轮宏任务里的连按）
  // 会在这里被拦住。generation 只被 restorePage 与下一轮推进，所以是"我这一轮"的凭据。
  const mine = ++generation;
  running = true;

  // **用投影**（`loadUiSettings`），不是完整设置。要把话说准：这是**类型级**的边界，
  // 不是内存级隔离——`loadUiSettings` 内部仍会把**整份设置（含 apiKey）**反序列化出来
  // 再丢掉字段，只要密钥和设置存在同一个键里，这一次瞬态出现就不可避免。投影买到的是：
  // 本层下游代码**拿不到** apiKey 字段、不可能把它写进消息或日志（规格 §7.3 的边界，
  // 由 `tests/content/privacy-guard.test.ts` 守着），而内容脚本跑在 isolated world 里，
  // 页面脚本本来就访问不到它的堆——残留风险接近 0。真正的结构性隔离要把 apiKey 拆成
  // 独立存储键（属后续工作，本版本未做，别按"密钥绝不进网页内存"来理解）。
  // 本文件用到的 targetLang / displayMode / concurrency / maxBatchChars /
  // maxSegmentsPerBatch / siteRules 全在投影里（siteRules 供下面那道「永不翻译」闸用）。
  const settings: UiSettings = await loadUiSettings();
  // 等待设置读取期间可能已经被还原/被接管：安静退出，不碰任何状态。
  if (mine !== generation) return;

  // 站点规则：命中「永不翻译」时不采集、不发任何请求（规格 2026-09-18 §5）。
  //
  // **只拦这一处就够**：三个整页翻译入口都汇到本函数——Alt+T 与弹窗主按钮发 `TOGGLE_PAGE`、
  // 右键菜单发 `TRANSLATE_PAGE`，前两者的未翻译分支与后者都落到 `runTranslate()` → 这里。
  // 反过来，把闸挂到消息层那个 `if (type === MSG.TRANSLATE_PAGE)` 分支上就只盖住三分之一
  // （另两个入口照样翻——而它们恰好占了三个入口里的两个）。这条落点之争有读数：
  // 测试里「TOGGLE_PAGE 同样被拦」那条。划词与悬停**故意不受约束**：那是用户主动发起的
  // 单段翻译，与"这站整页不该翻"是两件事。
  //
  // **位置两头都不能挪**：
  // - 再早没有意义——`siteRules` 只来自上面那次本来就必需的 `loadUiSettings()`；而且跨过
  //   `mine !== generation` 这道守卫去动 `running`，会让**被接管的那一轮**把新一轮的守卫清掉。
  // - 再晚也不行——采集有副作用（写 `data-jy-id` / `data-jy-translated`），拦晚了就把一个
  //   "不该翻"的页面**永久**标成已处理：这两类标记只由渲染器的 `restore()` 统一清除
  //   （见 `extractor.ts` 的副作用注释），而这一轮压根没建 renderer，没有东西可 restore。
  //   实测把闸挪到 `collectSegments` 之后：DOM 成了 `<p data-jy-id="jy-1-…" data-jy-translated="1">`，
  //   而且**连"解除规则再翻一次"都救不回来**——下一轮采到 0 段，页面被这个判断判了死刑，
  //   用户只剩一句提示和一堆隐形标记（"守卫已收回"那条用例在这里也是红的）。
  //
  // `running = false` **不能省**：这一轮已经认领过守卫（上面 running = true），提前 return
  // 不复位就是"第二次按 Alt+T 静默什么都不发生"那个 bug 的复发——用户解除规则后再也翻不动了，
  // 而且没有任何提示（变异验证：删掉这行，只有「守卫已收回」那条用例红）。
  // 世代号这里不用管：从上一个守卫到这里没有 await，我仍然是当前世代。能推进它的两条路都
  // 够不着这里——`restorePage()` 只能由消息处理触发，另一条就是本函数自己的入口
  // `const mine = ++generation`，而它被上面那句 `running = true` 挡在门外。
  if (isNeverTranslate(settings.siteRules, location.hostname)) {
    running = false;
    toast('此站已设为「永不翻译」，可在扩展弹窗里解除');
    return;
  }

  // 页面级假名判定：**采集之前**对整页文本扫这一次（见 pageKanaSnapshot 的注释），
  // 本轮整页与后续增量共用这份结果。
  const kanaOnPage = pageHasKana(document.body);
  const collected = collectSegments(document.body, { targetLang: settings.targetLang, pageHasKana: kanaOnPage });
  if (collected.length === 0) {
    // 这里到认领之间没有 await，所以自己一定还是当前世代（generation 只能被下一轮
    // 翻译或还原推进，而两者都跑不到这里），守卫直接收回即可。
    running = false;
    toast('没有找到需要翻译的内容');
    return;
  }

  displayMode = settings.displayMode;
  // 增量层的唯一设置来源：此后新内容一律沿用这份快照（见 translateIncremental）。
  pageSnapshot = settings;
  pageKanaSnapshot = kanaOnPage;
  // 朗读的目标语言跟着这一轮翻译用的一次刷新（翻译请求本身不依赖它，见 translateInline）。
  inlineTargetLang = settings.targetLang;
  finished.clear();
  failedIds.clear();
  segments = collected;
  renderer = new DomRenderer(document, settings.displayMode, (segmentId) => void retrySegment(segmentId));
  // 本轮的页面级提示账本：批次只往里 record，收尾统一弹**优先级最高**的一条。
  const pageErrors = createNoticeTracker();

  for (const segment of segments) renderer.mount(segment, 'pending');
  // 宿主挂完才 enable：首轮挂载不是"页面变动"；种子把首轮已翻译的段落（含不打标记的
  // 松散文本段）交给增量的「已处理」账本，重扫混合容器时才不会二次插宿主。
  incremental.enable(segments);

  const textSegments: TextSegment[] = segments.map((s) => ({ id: s.id, text: s.text, order: s.order }));
  /**
   * **页内文本去重**（分批之前）：同一页面里字面相同的段落归并成一个请求单元。
   *
   * 调度器（`background/scheduler.ts`）只在**单批内**按文本去重，而批次之间互相看不见：
   * 导航/页脚/"Learn more"这类重复文本按 12 段一批切到 5 个批次上，仍会重发 5 次
   * （实测 apple.com 首页「Store」出现 59 次）。并发在飞时后面的批次也看不到前面批次
   * 正在飞的请求，缓存来不及救。归并放到内容脚本这一层，因为它看得见**整页**。
   *
   * 省下的只是请求，不是段落：渲染、失败态、重试与 `finished`/`failedIds` 计数都
   * 按段算（结果摊回给组内每一段，见 `expandBatch` / `expandResults`）；重试走
   * `retrySegment` 的单段链路，**不**连带重译同文本的其他段。
   * 缓存粒度不受影响（缓存 key 本来就按文本算，见 scheduler 的 uniqueTexts 注释）。
   * 增量翻译路径有意不做这套——它有 (容器, 文本) 账本与单轮上限，另成体系。
   */
  const membersByText = new Map<string, TextSegment[]>();
  for (const segment of textSegments) {
    const group = membersByText.get(segment.text);
    if (group === undefined) membersByText.set(segment.text, [segment]);
    else group.push(segment);
  }
  /** 代表段 id → 同文本的全部段（含代表段自己）。代表段取每组**首次出现**的那一段。 */
  const membersByRepId = new Map<string, TextSegment[]>();
  const representatives: TextSegment[] = [];
  for (const group of membersByText.values()) {
    const representative = group[0] as TextSegment;
    representatives.push(representative);
    membersByRepId.set(representative.id, group);
  }
  /** 本批的全部落地段：代表段摊回同文本组（失败标注、形状兜底都按这个全集算）。 */
  const expandBatch = (batch: TextSegment[]): TextSegment[] =>
    batch.flatMap((representative) => membersByRepId.get(representative.id) ?? [representative]);
  /**
   * 响应条目按代表段 id 回来，逐条复制给组内每一段（换掉 id、其余原样）。
   * 认不出 id 的条目（形状不符/不属于任何组）原样交给 `applyResults` 的既有防线。
   */
  const expandResults = (results: unknown): unknown => {
    if (!Array.isArray(results)) return results;
    const out: unknown[] = [];
    for (const result of results) {
      if (!isResultItem(result)) {
        out.push(result);
        continue;
      }
      const group = membersByRepId.get(result.id);
      if (group === undefined) {
        out.push(result);
        continue;
      }
      for (const member of group) out.push({ ...result, id: member.id });
    }
    return out;
  };

  const batches = planBatches(representatives, {
    maxBatchChars: settings.maxBatchChars,
    maxSegmentsPerBatch: settings.maxSegmentsPerBatch,
  });

  try {
    await runPool(
      batches.map((batch) => async () => {
        // 被接管的那一轮不再动页面：此时 renderer / finished / failedIds 都已经属于
        // 下一代，落笔只会把新的一轮搅乱（比如把新宿主标成失败）。
        if (mine !== generation) return;

        // 整个任务体都在 try/catch 里（不只是 sendMessage）：`core/pool.ts` 的契约是
        // "调用方负责在任务内部捕获"——任何意外异常逃出去都会 reject 掉 runPool，
        // 于是收尾那句 toast 被跳过、
        // running 也在 finally 里被收走，页面就永久留在"翻译中…"（renderer 守卫还在，
        // 用户连重试都点不动）。这里统一收敛成**本批**的失败态。
        // 本批的代表段摊回的全集：请求只发 `batch`（去重后的代表段），**落地**按全集逐段算。
        const fullBatch = expandBatch(batch);
        try {
          let response: TranslateTextsResponse;
          try {
            response = await sendToBackground({
              type: MSG.TRANSLATE_TEXTS,
              payload: {
                items: batch.map((segment) => ({ id: segment.id, text: segment.text })),
                targetLang: settings.targetLang,
              },
            });
          } catch (raw) {
            // SW 被回收、扩展刚更新过时 sendMessage 会抛（"Receiving end does not exist"）；
            // SW 中途被回收时更常见的是**永不兑现**，由 `sendToBackground` 的超时收敛。
            // 一个批次炸掉不该让后面的批次跟着停：收敛成条目级失败继续跑。
            // `fullBatch` 含同文本的全部段：一个代表段炸了，摊到的每一段都进失败态。
            if (mine !== generation) return;
            failBatch(fullBatch, describeTransportError(raw));
            return;
          }

          // 响应回来后这一轮可能已经被还原/被接管：这一批的结论属于上一代，丢掉。
          if (mine !== generation) return;

          // 条目级失败（缺 API Key、限流、断网）走的是 ok: true + text: null 这条路，
          // 见 `sameCodeFailureMessage`：整批同码时只攒一句提示，且不挂重试按钮。
          if (!response.ok) {
            pageErrors.record({ code: response.code, message: describeError(response) });
            failBatch(fullBatch, response.message);
            return;
          }
          // `applyResults` 自己校验响应形状：形状不符时整批进失败态，不抛异常。
          // 响应按代表段的 id 回来，先摊回全集再落地（逐段渲染/计数，见上方去重注释）。
          const notice = applyResults(fullBatch, expandResults(response.results));
          if (notice !== null) pageErrors.record(notice);
        } catch (raw) {
          // 兜底：整批进失败态（可重试）——绝不静默失败。逐条挂的是"本批没法处理"这句
          // 稳定文案（异常原文可能很长/含内部细节），原始原因只进页面级提示。
          const detail = raw instanceof Error ? raw.message : String(raw);
          if (mine !== generation) return;
          pageErrors.record({ code: undefined, message: `翻译失败：${detail}` });
          failBatch(fullBatch, MALFORMED_RESPONSE);
        }
      }),
      settings.concurrency,
    );
  } finally {
    // 只有自己仍是当前世代时才收回守卫：被接管的那一轮在飞完时不能把**新的一轮**
    // 的 running 清掉——那会让新的一轮在飞时又放进来第三个触发（多挂一份宿主）。
    if (mine === generation) running = false;
  }

  // 一轮的收尾同样只能由当前世代做：还原已经把页面清干净了，就别再弹上一代的错误。
  if (mine !== generation) return;

  // 整轮跑完才弹，且只弹一条：每批各弹一次的话，提示会被后一批顶掉重弹
  // （`toast()` 是"删旧节点 + 建新节点"），一个多批页面等于把同一件事播 N 遍。
  // 弹账本里**优先级最高**的那条（`pickNotice`），不是最后写入的那条：AUTH 不该被
  // 后到的网络抖动顶掉——那是最需要用户去设置页处理的一条。
  const pageNotice = pageErrors.peek();
  if (pageNotice !== null) toast(pageNotice.message);
}

async function retrySegment(segmentId: string): Promise<void> {
  const segment = segments.find((s) => s.id === segmentId);
  if (!segment) return;
  /**
   * 两个来源要分开满足，别一锅烩：
   * - **语言走页面快照**（`pageSnapshot.targetLang`，与整页/增量同一口径）：快照的语义是
   *   "中途改语言，本页面要还原重来才生效"。重试若现读设置，用户改过目标语言后点某个
   *   旧失败段的重试，那一段会变新语言、其余还是旧语言——一语双语墙。
   *   （`pageSnapshot === null` 只在"上一帧刚被还原、按钮点击恰好排队进来"的夹缝里可达，
   *    那时不带 targetLang、让后台按当前设置兜底，见 service-worker 的 `payload.targetLang ?? …`。）
   * - **Key 与接口配置走当前设置**：用户点重试往往正是刚去设置页填好 Key 回来，重试必须
   *   用上新凭据。这一半不需要内容脚本读任何东西——凭据归后台，`handleTranslateTexts`
   *   每条消息现读一次设置（`tests/background/service-worker.test.ts` 钉着这条分工）。
   */
  const targetLang = pageSnapshot?.targetLang;

  failedIds.delete(segmentId);
  renderer?.mount(segment, 'pending');

  let response: TranslateTextsResponse;
  try {
    response = await sendToBackground({
      type: MSG.TRANSLATE_TEXTS,
      payload: { items: [{ id: segment.id, text: segment.text }], targetLang },
    });
  } catch (raw) {
    failedIds.add(segmentId);
    // 超时可能发生在用户点击重试之后：同样如实说明，而不是把页面吊在「翻译中…」。
    renderer?.fail(segment.id, describeTransportError(raw));
    return;
  }

  if (!response.ok) {
    failedIds.add(segmentId);
    renderer?.fail(segment.id, response.message);
    toast(describeError(response));
    return;
  }

  // 同 `applyResults`：`results` 来自消息边界，形状是运行时才成立的假设。
  const [result] = Array.isArray(response.results) ? response.results.filter(isResultItem) : [];
  if (result && result.text !== null) {
    finished.add(segment.id);
    renderer?.update(segment.id, result.text);
    return;
  }
  failedIds.add(segmentId);
  // 单条重试不再弹整批提示：用户就是看着这条错误点进来的，再弹一次是噪音。
  if (result === undefined) {
    // 响应里没有这一条（形状不符/后台漏了它）：按可重试的失败态标注，别停在"翻译中…"。
    // 注意 `result === undefined` 而不是 `result.text === null`：后者是正常的条目级失败，
    // 走下面那行按原样标注。
    renderer?.fail(segment.id, MALFORMED_RESPONSE);
    return;
  }
  renderer?.fail(segment.id, result.message ?? '翻译失败', isRetryable(result.code));
}

/**
 * 增量翻译的落地函数：把新采到的段落送进**现有**链路（planBatches + runPool +
 * sendToBackground + applyResults），不另起炉灶。观察者（observer.ts）保证调用时机：
 *
 * - 它在本轮**已翻译**时才会调到这里；
 * - **不参与世代号（generation）守卫**——增量轮不该把 `running` 卡住（整页那一轮早就
 *   跑完了，还原→再翻译要随时能进来），它判断"这一轮还算不算数"的依据是 renderer
 *   的身份：还原会置空它、重新翻译会换一个，在飞的批次在每个 await 后核对身份，
 *   对不上就安静丢弃（宿主已经随旧 renderer 一起被还原摘掉，写它们只会往新页面里乱插）。
 *
 * 对 observer 的两条契约见 `IncrementalDeps.translate`：挂载全部同步发生在第一个
 * await 之前；promise 永远 resolve。逐段失败沿用现有失败态与重试按钮——不静默。
 */
async function translateIncremental(newSegments: ExtractedSegment[]): Promise<void> {
  const current = renderer;
  const snapshot = pageSnapshot;
  if (current === null || snapshot === null) return;

  // 状态面板把新段落纳入总量：retrySegment 也靠这一步查得到它们（重试按钮沿用）。
  for (const segment of newSegments) segments.push(segment);
  // —— 同步写入区（observer 的 disconnect 窗口）：挂 pending 宿主。
  for (const segment of newSegments) current.mount(segment, 'pending');

  const batches = planBatches(
    newSegments.map((segment) => ({ id: segment.id, text: segment.text, order: segment.order })),
    { maxBatchChars: snapshot.maxBatchChars, maxSegmentsPerBatch: snapshot.maxSegmentsPerBatch },
  );
  // 与整页共用同一套判择逻辑（同一个 `createNoticeTracker` + `pickNotice`），
  // 不再两处各写一份覆盖规则。
  const pageErrors = createNoticeTracker();
  await runPool(
    batches.map((batch) => async () => {
      try {
        let response: TranslateTextsResponse;
        try {
          response = await sendToBackground({
            type: MSG.TRANSLATE_TEXTS,
            payload: {
              items: batch.map((segment) => ({ id: segment.id, text: segment.text })),
              targetLang: snapshot.targetLang,
            },
          });
        } catch (raw) {
          if (renderer !== current) return; // 页面已还原/已换代：这批作废。
          failBatch(batch, describeTransportError(raw));
          return;
        }
        if (renderer !== current) return;
        if (!response.ok) {
          pageErrors.record({ code: response.code, message: describeError(response) });
          failBatch(batch, response.message);
          return;
        }
        const resultNotice = applyResults(batch, response.results);
        if (resultNotice !== null) pageErrors.record(resultNotice);
      } catch {
        if (renderer !== current) return;
        failBatch(batch, MALFORMED_RESPONSE);
      }
    }),
    snapshot.concurrency,
  );

  // 整批同码的页面级提示照常浮出（规格 §8：绝不静默失败）；页面已经还原就不再打扰。
  const pageNotice = pageErrors.peek();
  if (pageNotice !== null && renderer === current) toast(pageNotice.message);
}

/**
 * 增量翻译观察者。生命周期跟着页面翻译状态走：
 * - `translatePage` 把首轮宿主挂完**之后** enable（我们自己的首轮挂载不产生变动记录，
 *   而整页请求在飞时页面新长出来的内容正常进防抖队列）；
 * - `restorePage` 第一件事就是 disable（还原本身就是一场 childList 洪水，
 *   绝不能进增量队列；在飞的增量批次由 renderer 身份守卫丢弃）。
 */
const incremental = createIncrementalObserver({
  scanOptions: currentScanOptions,
  isTranslated: () => renderer !== null,
  isStale: () => (globalThis as { __jinyiContentInstance?: symbol }).__jinyiContentInstance !== INSTANCE_TOKEN,
  translate: translateIncremental,
});

/**
 * 本轮采集选项：页面翻译那一刻的设置快照（未翻译时是 null，见 `pageSnapshot`）。
 * 整页采集、增量轮与**诊断模式**读的是同一份——诊断报出来的结论必须与采集端真正
 * 会做的事逐字一致，所以只留这一个出口，谁也不许另读设置。
 */
function currentScanOptions(): ExtractorOptions | null {
  if (pageSnapshot === null) return null;
  return { targetLang: pageSnapshot.targetLang, pageHasKana: pageKanaSnapshot };
}

/**
 * 诊断模式（Alt+Shift + 点击任意元素）：页面内弹一条"这段为什么没被翻译"。
 *
 * 与翻译开关无关地常驻——它**只在 Alt+Shift+点击时**工作，其余时候一个回调都不跑
 * （见 `diagnose.ts` 的 `installDiagnose`）。未翻译的页面上也照样能用：那正是要
 * 区分"压根没进采集"与"采了但没翻"的场景。
 */
installDiagnose({ scanOptions: currentScanOptions, stats: () => incremental.stats() });

/**
 * 悬停/划词的翻译入口：仍是"一条正常的 `TRANSLATE_TEXTS` 请求"，走后台——
 * 缓存、引擎选择、重试、超时全在 `background/scheduler.ts` 那一份实现里，这里不另起炉灶。
 * `targetLang` 故意**不传**：后台会用它当场读到的设置（永远比内容脚本手里的新鲜）。
 */
async function translateInline(text: string): Promise<InlineTranslation> {
  let response: TranslateTextsResponse;
  try {
    response = await sendToBackground({
      type: MSG.TRANSLATE_TEXTS,
      payload: { items: [{ id: 'jy-inline', text }] },
    });
  } catch (raw) {
    return { ok: false, message: describeTransportError(raw) };
  }
  if (!response.ok) return { ok: false, message: describeError(response) };
  const [result] = Array.isArray(response.results) ? response.results.filter(isResultItem) : [];
  if (result === undefined) return { ok: false, message: MALFORMED_RESPONSE };
  if (result.text !== null) return { ok: true, text: result.text };
  return { ok: false, message: result.message ?? '翻译失败' };
}

// ------------------------------------------------------------------
// 悬停 / 划词（Plan 2）：两个模块各持一个控制器，监听器挂不挂由设置说了算。
// 整页翻译进行中它们照常可用——独立浮层，与 renderer 的宿主注入互不相干。
// ------------------------------------------------------------------

export interface FeatureSettings {
  hoverTranslate: boolean;
  selectionTranslate: boolean;
  /** 可选携带：弹窗改动任何一项时都顺带报一次当前目标语言，朗读的语种跟着刷新。 */
  targetLang?: string;
}

let hover: HoverController | null = null;
let selection: SelectionController | null = null;
/** 朗读语言缓存；来源同 `displayMode`——读一次设置，翻译请求本身不受它影响（见 translateInline）。 */
let inlineTargetLang: string = DEFAULT_SETTINGS.targetLang;
/** 上一次实际应用的两项开关：APPLY_SETTINGS 允许只带一半字段，缺的按现状保持。 */
let appliedFeatures: { hoverTranslate: boolean; selectionTranslate: boolean } = {
  hoverTranslate: DEFAULT_SETTINGS.hoverTranslate,
  selectionTranslate: DEFAULT_SETTINGS.selectionTranslate,
};

function controllers(): { hover: HoverController; selection: SelectionController } {
  if (hover === null || selection === null) {
    hover = createHoverTranslator({ translate: translateInline });
    selection = createSelectionTranslator({
      translate: translateInline,
      targetLang: () => inlineTargetLang,
    });
  }
  return { hover, selection };
}

/**
 * 应用「悬停翻译 / 划词翻译」开关：重新挂/摘监听器。
 * 导出给测试钉行为；生产路径是弹窗的 `MSG.APPLY_SETTINGS`（开关即时生效）
 * 与启动时读的那一次设置。
 */
export function applyFeatureSettings(next: FeatureSettings): void {
  const pair = controllers();
  if (typeof next.targetLang === 'string' && next.targetLang !== '') inlineTargetLang = next.targetLang;
  appliedFeatures = { hoverTranslate: next.hoverTranslate, selectionTranslate: next.selectionTranslate };
  if (next.hoverTranslate) pair.hover.enable();
  else pair.hover.disable();
  if (next.selectionTranslate) pair.selection.enable();
  else pair.selection.disable();
}

/** 启动时读一次设置（投影——类型级隔离，见 translatePage 处的注释：密钥会在读取瞬间
 *  经过本 isolated world 的堆，但拿不到字段、页面脚本也摸不到这里）。读不出来按默认值挂监听——
 *  翻译路径会另行报告设置损坏。 */
function initFeatureSettings(): void {
  void loadUiSettings().then(
    (settings) => {
      inlineTargetLang = settings.targetLang;
      applyFeatureSettings(settings);
    },
    () => applyFeatureSettings(DEFAULT_SETTINGS),
  );
}
initFeatureSettings();

function restorePage(): void {
  // 增量观察者先停：restore 是一场 childList 洪水（摘宿主、搬回原文），
  // 断开必须在写之前；在飞的增量批次由 renderer 身份守卫丢弃（见 translateIncremental）。
  incremental.disable();
  renderer?.restore();
  renderer = null;
  segments = [];
  pageSnapshot = null;
  pageKanaSnapshot = false;
  finished.clear();
  failedIds.clear();
  // 页面级提示账本是每一轮的局部状态（见 translatePage 的 createNoticeTracker），
  // 还原推进了世代号，在飞那一轮的收尾 toast 本来就被守卫拦下，这里无需再清什么。
  // 还原是一个明确的"都给我撤掉"信号：浮层气泡关掉、悬停描边撤掉、
  // 在飞的悬停/划词结果作废（监听器保持原样——用户接下来还要用）。
  hideTooltip();
  hover?.reset();
  selection?.reset();
  // 世代 +1 接管在飞的那一轮（它随后在每个 await 后安静退出），并**当场释放守卫**：
  // 还原之后紧接着的一次翻译（Alt+T 连按两下、或还原后点右键菜单）必须真的跑起来，
  // 不能被一个还在飞的上一轮挡住；上一轮跑完时也不会再动这一轮的状态。
  generation += 1;
  running = false;
}

/**
 * 响应弹窗/快捷键/右键菜单的入口。
 *
 * `TRANSLATE_SELECTION`（右键菜单的"翻译选中文本"）走划词的同一条路径：内容脚本自己读
 * 选区取文本与定位，读不到就用菜单带来的 `payload.text` 兜底、视口中央定位。菜单是用户
 * 逐次明确点击的动作，所以它**不受 `selectionTranslate` 开关管辖**（那个开关只管自动的
 * mouseup 气泡）。
 *
 * 带响应的分支都要兜住异常：`translatePage` 失败（设置版本高于本代码、存储坏了）时如果
 * 不响应，弹窗就会一直等到消息端口超时——用户看到的是一个没反应的按钮而不是原因。
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = (message as { type?: string } | null)?.type;

  const runTranslate = (): void => {
    translatePage()
      .catch((raw: unknown) => {
        const detail = raw instanceof Error ? raw.message : String(raw);
        toast(`翻译失败：${detail}`);
      })
      .then(() => sendResponse(currentState()));
  };

  if (type === MSG.TRANSLATE_PAGE) {
    runTranslate();
    return true;
  }
  if (type === MSG.RESTORE_PAGE) {
    restorePage();
    sendResponse(currentState());
    return false;
  }
  if (type === MSG.TOGGLE_PAGE) {
    if (renderer) {
      restorePage();
      sendResponse(currentState());
      return false;
    }
    runTranslate();
    return true;
  }
  if (type === MSG.GET_PAGE_STATE) {
    sendResponse(currentState());
    return false;
  }
  if (type === MSG.TRANSLATE_SELECTION) {
    // 菜单文本由后台带过来；定位靠内容脚本自己读的选区，读不到会退回视口中央。
    const payload = (message as { payload?: { text?: unknown } } | null)?.payload;
    controllers().selection.translateFromMenu(payload?.text);
    sendResponse({ ok: true });
    return false;
  }
  if (type === MSG.APPLY_SETTINGS) {
    const raw = (message as { payload?: Partial<FeatureSettings> } | null)?.payload ?? {};
    applyFeatureSettings({
      hoverTranslate: typeof raw.hoverTranslate === 'boolean' ? raw.hoverTranslate : appliedFeatures.hoverTranslate,
      selectionTranslate:
        typeof raw.selectionTranslate === 'boolean' ? raw.selectionTranslate : appliedFeatures.selectionTranslate,
      targetLang: typeof raw.targetLang === 'string' ? raw.targetLang : undefined,
    });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
