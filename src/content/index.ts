// src/content/index.ts
import { runPool } from '../core/pool';
import { planBatches, type TextSegment } from '../core/segmenter';
import { MSG, type PageState, type TranslateItemResult, type TranslateTextsResponse } from '../shared/messages';
import { loadSettings, type Settings } from '../shared/settings';
import { collectSegments, type ExtractedSegment } from './extractor';
import { DomRenderer } from './renderer';
import { toast } from './toast';

let renderer: DomRenderer | null = null;
let segments: ExtractedSegment[] = [];
let running = false;
/** 本轮翻译攒下的页面级提示：整轮跑完只弹一次，见 `translatePage` 末尾。 */
let lastError: string | null = null;
let displayMode: 'bilingual' | 'replace' = 'bilingual';
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

function sendToBackground(message: unknown): Promise<TranslateTextsResponse> {
  return chrome.runtime.sendMessage(message) as Promise<TranslateTextsResponse>;
}

/** 页面级失败的文案（`ok: false`：设置读不出来这类"连请求都没发出去"的错）。 */
function describeError(response: { code: string; message: string }): string {
  if (response.code === 'AUTH') return response.message;
  if (response.code === 'RATE_LIMIT') return '免费接口限流，请稍后重试或改用自定义 API';
  return `翻译失败：${response.message}`;
}

/**
 * 鉴权失败这类"重试多少次都是同一个结果"的条目级错误不挂重试按钮：
 * 一个 200 段的页面会变成 200 个点了也没用的按钮（规格 §8：不重试，改为页面 toast）。
 */
function isRetryable(code: TranslateItemResult['code']): boolean {
  return code !== 'AUTH';
}

/**
 * 整批失败且**错误码相同**时的兜底提示。
 *
 * 后台的 `translateBatch` 是逐条上报失败的（见 `background/scheduler.ts`），所以缺 API Key /
 * Key 无效这类问题表现为 `{ ok: true, results: [{ text: null, code: 'AUTH', … }, …] }`，
 * 而不是 `{ ok: false }`——`describeError` 那条路收不到它。没有这一层，用户只会看到满屏
 * 一模一样的错误标签，完全不知道发生了什么（规格 §8 要求的是「不重试；页面 toast + 弹窗红点」）。
 *
 * 只对"一次响应里全部条目都失败"生效：部分失败是正常的，逐个标注即可。
 * 返回 null 表示不该弹 toast。
 */
function sameCodeFailureMessage(results: TranslateItemResult[]): string | null {
  const failures = results.filter((result) => result.text === null);
  if (failures.length === 0 || failures.length !== results.length) return null;

  const [first] = failures;
  if (first?.code === undefined) return null;
  if (failures.some((failure) => failure.code !== first.code)) return null;

  const message = first.message ?? describeError({ code: first.code, message: '翻译失败' });
  if (first.code === 'AUTH') {
    return `${message}（在扩展设置里填好 API Key 后重新翻译此页）`;
  }
  return message;
}

/**
 * 落地一批条目级结果。
 *
 * 失败条目一律标注错误文案，重试按钮按 `isRetryable` 决定——重试多少次都是同一个结果
 * （`AUTH`）时不挂按钮，否则用户会拿到一排点了也没用的按钮。
 * 整个响应**全部失败且错误码相同**时，逐条标注之外再加一句整批提示，由调用方选时机弹。
 * 返回该提示（不需要时返回 null）。
 */
function applyResults(results: TranslateItemResult[]): string | null {
  const message = sameCodeFailureMessage(results);

  for (const result of results) {
    if (result.text !== null) {
      finished.add(result.id);
      renderer?.update(result.id, result.text);
      continue;
    }

    failedIds.add(result.id);
    renderer?.fail(result.id, result.message ?? '翻译失败', isRetryable(result.code));
  }

  return message;
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
  for (const segment of batch) {
    failedIds.add(segment.id);
    renderer?.fail(segment.id, message);
  }
}

async function translatePage(): Promise<void> {
  if (running) return;
  // 已经翻译过就不重复翻译；要重来请先还原（避免插入两份译文）。
  if (renderer) return;

  const settings: Settings = await loadSettings();
  const collected = collectSegments(document.body, { targetLang: settings.targetLang });
  if (collected.length === 0) {
    toast('没有找到需要翻译的内容');
    return;
  }

  running = true;
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
          // SW 被回收、扩展刚更新过时 sendMessage 会抛（"Receiving end does not exist"）。
          // 一个批次炸掉不该让后面的批次跟着停：收敛成条目级失败继续跑。
          // `batch` 里的就是 `segments` 里那些对象本身，id 可直接用。
          const detail = raw instanceof Error ? raw.message : String(raw);
          for (const segment of batch) {
            failedIds.add(segment.id);
            renderer?.fail(segment.id, `无法连接后台：${detail}`);
          }
          return;
        }

        // 条目级失败（缺 API Key、限流、断网）走的是 ok: true + text: null 这条路，
        // 见 `sameCodeFailureMessage`：整批同码时只攒一句提示，且不挂重试按钮。
        if (!response.ok) {
          lastError = describeError(response);
          failBatch(batch, response.message);
          return;
        }
        const notice = applyResults(response.results);
        if (notice !== null) lastError = notice;
      }),
      settings.concurrency,
    );
  } finally {
    running = false;
  }

  // 整轮跑完才弹，且只弹一次：每批各弹一次的话，提示会被后一批顶掉重弹
  // （`toast()` 是"删旧节点 + 建新节点"），一个多批页面等于把同一件事播 N 遍。
  if (lastError !== null) toast(lastError);
}

async function retrySegment(segmentId: string): Promise<void> {
  const segment = segments.find((s) => s.id === segmentId);
  if (!segment) return;
  // 重试要按**当前**设置走：用户点了重试按钮，往往正是刚去设置页填完 API Key 回来。
  const settings = await loadSettings();

  failedIds.delete(segmentId);
  renderer?.mount(segment, 'pending');

  let response: TranslateTextsResponse;
  try {
    response = await sendToBackground({
      type: MSG.TRANSLATE_TEXTS,
      payload: { items: [{ id: segment.id, text: segment.text }], targetLang: settings.targetLang },
    });
  } catch (raw) {
    const detail = raw instanceof Error ? raw.message : String(raw);
    failedIds.add(segmentId);
    renderer?.fail(segment.id, `无法连接后台：${detail}`);
    return;
  }

  if (!response.ok) {
    failedIds.add(segmentId);
    renderer?.fail(segment.id, response.message);
    toast(describeError(response));
    return;
  }

  const [result] = response.results;
  if (result && result.text !== null) {
    finished.add(segment.id);
    renderer?.update(segment.id, result.text);
    return;
  }
  failedIds.add(segmentId);
  // 单条重试不再弹整批提示：用户就是看着这条错误点进来的，再弹一次是噪音。
  renderer?.fail(segment.id, result?.message ?? '翻译失败', isRetryable(result?.code));
}

function restorePage(): void {
  renderer?.restore();
  renderer = null;
  segments = [];
  finished.clear();
  failedIds.clear();
  lastError = null;
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
