// src/content/index.ts
import { runPool } from '../core/pool';
import { planBatches, type TextSegment } from '../core/segmenter';
import { RETRYABLE_CODES } from '../engines/types';
import { MSG, type PageState, type TranslateItemResult, type TranslateTextsResponse } from '../shared/messages';
import { DEFAULT_SETTINGS, loadUiSettings, type DisplayMode, type UiSettings } from '../shared/settings';
import { collectSegments, type ExtractedSegment } from './extractor';
import { DomRenderer } from './renderer';
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
 *   不写状态（renderer / lastError 属于新的一轮）、也不能在 finally 里把新的一轮的
 *   running 守卫清掉（否则新的一轮在飞时又放进来第三个 renderer）。
 */
let generation = 0;
let renderer: DomRenderer | null = null;
let segments: ExtractedSegment[] = [];
let running = false;
/** 本轮翻译攒下的页面级提示：整轮跑完只弹一次，见 `translatePage` 末尾。 */
let lastError: string | null = null;
let displayMode: DisplayMode = DEFAULT_SETTINGS.displayMode;
const finished = new Set<string>();
const failedIds = new Set<string>();

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

/** 页面级失败的文案（`ok: false`：设置读不出来这类"连请求都没发出去"的错）。 */
function describeError(response: { code: string; message: string }): string {
  if (response.code === 'AUTH') return response.message;
  if (response.code === 'RATE_LIMIT') return '免费接口限流，请稍后重试或改用自定义 API';
  return `翻译失败：${response.message}`;
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
 * 返回 null 表示不该弹 toast。
 *
 * `batchSize` 必须显式传本批的条目数，不能拿 `failures.length === results.length` 代替：
 * 调用方传进来的可能只有失败的那些条目（`applyResults` 就是这么调的），那样比较恒为真，
 * 一条失败混在成功里也会弹出"整批失败"的提示。
 */
function sameCodeFailureMessage(results: TranslateItemResult[], batchSize: number): string | null {
  const failures = results.filter((result) => result.text === null);
  if (failures.length === 0 || failures.length !== batchSize) return null;

  const [first] = failures;
  if (first?.code === undefined) return null;
  if (failures.some((failure) => failure.code !== first.code)) return null;

  const message = first.message ?? describeError({ code: first.code, message: '翻译失败' });
  if (first.code === 'AUTH') {
    return `${message}（在扩展设置里填好 API Key 后重新翻译此页）`;
  }
  if (first.code === 'NETWORK') {
    // 整批网络失败几乎从不是"抖了一下"，而是这个接口根本到不了：默认的免费 Google 接口
    // 在很多网络下被完全阻断（连超时都不返回）。只说"翻译失败"会让用户以为插件坏了，
    // 而真正该做的是去设置页换一个自己能访问的接口。规格 §8「免费接口失效」要求的
    // 就是这条提示。
    return `${message}。如果反复出现，说明当前网络到不了这个翻译接口——默认的免费 Google 接口在很多网络下无法访问，请在扩展设置里改用你能访问的自定义 API。`;
  }
  return message;
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
 * 返回该提示（不需要时返回 null）。
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
function applyResults(batch: TextSegment[], results: unknown): string | null {
  if (!Array.isArray(results)) {
    failBatch(batch, MALFORMED_RESPONSE);
    return MALFORMED_RESPONSE;
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
  if (missingResult) return MALFORMED_RESPONSE;
  return sameCodeFailureMessage([...failures.values()], batch.length);
}

/**
 * 响应级失败（`ok: false`）：连引擎都没问到，标注**本批**条目。
 *
 * 只标本批：一个响应只代表它自己那一批的对错。标整页会把别的批次已经翻译好的片段
 * 一起算成失败——`applyResults` 从不回删被误标的 id，`done + failed` 会超过 `total`，
 * 状态面板上就出现"一段既译好了又算失败"。提示不在这里弹，攒进 `lastError` 由调用方
 * 在整轮跑完后弹一次。
 */
function failBatch(batch: TextSegment[], message: string): void {
  for (const segment of batch) failSegment(segment.id, message);
}

/**
 * 把一段标成失败态（记进 `failedIds` + 渲染）。**这一步自己绝不抛异常**：
 * 它跑在并发池的任务里，`core/pool.ts` 的契约是"调用方负责在任务内部捕获"——
 * 一个异常逃出去就会 reject 掉整轮，剩下的条目会永远停在"翻译中…"，
 * 而 `if (lastError !== null) toast(...)` 那一行也永远到不了（页面静默卡死）。
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

  // **用投影**（`loadUiSettings`），不是完整设置：内容脚本跑在网页进程里，读完整设置会把
  // API Key 反序列化进网页进程的堆内存（规格 §7.3）。`UiSettings` 里根本没有 `apiKey`
  // 字段，本文件用到的 targetLang / displayMode / concurrency / maxBatchChars /
  // maxSegmentsPerBatch 全在投影里——这一层由 `tests/content/privacy-guard.test.ts` 守着。
  const settings: UiSettings = await loadUiSettings();
  // 等待设置读取期间可能已经被还原/被接管：安静退出，不碰任何状态。
  if (mine !== generation) return;

  const collected = collectSegments(document.body, { targetLang: settings.targetLang });
  if (collected.length === 0) {
    // 这里到认领之间没有 await，所以自己一定还是当前世代（generation 只能被下一轮
    // 翻译或还原推进，而两者都跑不到这里），守卫直接收回即可。
    running = false;
    toast('没有找到需要翻译的内容');
    return;
  }

  lastError = null;
  displayMode = settings.displayMode;
  finished.clear();
  failedIds.clear();
  segments = collected;
  renderer = new DomRenderer(document, settings.displayMode, (segmentId) => void retrySegment(segmentId));

  for (const segment of segments) renderer.mount(segment, 'pending');

  const textSegments: TextSegment[] = segments.map((s) => ({ id: s.id, text: s.text, order: s.order }));
  const batches = planBatches(textSegments, {
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
        // 于是 applyResults 之后那一行 `if (lastError !== null) toast(...)` 被跳过、
        // running 也在 finally 里被收走，页面就永久留在"翻译中…"（renderer 守卫还在，
        // 用户连重试都点不动）。这里统一收敛成**本批**的失败态。
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
            // `batch` 里的就是 `segments` 里那些对象本身，id 可直接用。
            if (mine !== generation) return;
            failBatch(batch, describeTransportError(raw));
            return;
          }

          // 响应回来后这一轮可能已经被还原/被接管：这一批的结论属于上一代，丢掉。
          if (mine !== generation) return;

          // 条目级失败（缺 API Key、限流、断网）走的是 ok: true + text: null 这条路，
          // 见 `sameCodeFailureMessage`：整批同码时只攒一句提示，且不挂重试按钮。
          if (!response.ok) {
            lastError = describeError(response);
            failBatch(batch, response.message);
            return;
          }
          // `applyResults` 自己校验响应形状：形状不符时整批进失败态，不抛异常。
          const notice = applyResults(batch, response.results);
          if (notice !== null) lastError = notice;
        } catch (raw) {
          // 兜底：整批进失败态（可重试）——绝不静默失败。逐条挂的是"本批没法处理"这句
          // 稳定文案（异常原文可能很长/含内部细节），原始原因只进页面级提示。
          const detail = raw instanceof Error ? raw.message : String(raw);
          if (mine !== generation) return;
          lastError = `翻译失败：${detail}`;
          failBatch(batch, MALFORMED_RESPONSE);
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

  // 整轮跑完才弹，且只弹一次：每批各弹一次的话，提示会被后一批顶掉重弹
  // （`toast()` 是"删旧节点 + 建新节点"），一个多批页面等于把同一件事播 N 遍。
  if (lastError !== null) toast(lastError);
}

async function retrySegment(segmentId: string): Promise<void> {
  const segment = segments.find((s) => s.id === segmentId);
  if (!segment) return;
  // 重试要按**当前**设置走：用户点了重试按钮，往往正是刚去设置页填完 API Key 回来。
  // 同样是投影（见 translatePage）：重试路径也不该把密钥读进网页进程。
  const settings = await loadUiSettings();

  failedIds.delete(segmentId);
  renderer?.mount(segment, 'pending');

  let response: TranslateTextsResponse;
  try {
    response = await sendToBackground({
      type: MSG.TRANSLATE_TEXTS,
      payload: { items: [{ id: segment.id, text: segment.text }], targetLang: settings.targetLang },
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

function restorePage(): void {
  renderer?.restore();
  renderer = null;
  segments = [];
  finished.clear();
  failedIds.clear();
  lastError = null;
  // 世代 +1 接管在飞的那一轮（它随后在每个 await 后安静退出），并**当场释放守卫**：
  // 还原之后紧接着的一次翻译（Alt+T 连按两下、或还原后点右键菜单）必须真的跑起来，
  // 不能被一个还在飞的上一轮挡住；上一轮跑完时也不会再动这一轮的状态。
  generation += 1;
  running = false;
}

/**
 * 响应弹窗/快捷键/右键菜单的入口。
 *
 * `TRANSLATE_SELECTION`（右键菜单的"翻译选中文本"）在 Plan 1 没有对应的划词气泡，
 * **有意不处理**：这里返回 false 表示"内容脚本不管这条消息"，后台那边的
 * `tabs.sendMessage(...).catch(...)` 照常收尾，不会变成未处理的拒绝。
 * 它是 Plan 2 划词翻译的接口预留（气泡与 `selectionTranslate` 开关一起做）。
 *
 * 带响应的两条分支都要兜住异常：`translatePage` 失败（设置版本高于本代码、存储坏了）
 * 时如果不响应，弹窗就会一直等到消息端口超时——用户看到的是一个没反应的按钮而不是原因。
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
  return false;
});
