import { buildCacheKey, hashString } from '../core/hash';
import { joinPieces, splitBySentence } from '../core/segmenter';
import {
  EngineError,
  RETRYABLE_CODES,
  toEngineError,
  type EngineConfig,
  type Term,
  type Translator,
} from '../engines/types';
import type { TranslateItem, TranslateItemResult } from '../shared/messages';

/**
 * 批次用到的缓存子集。实现允许抛错也允许不抛错：`translateBatch` 两种都兜得住
 * （读失败当未命中、写失败当没缓存上），不把缓存异常抛给调用方。
 * 生产实现 `core/cache.ts` 不抛错，见那里的不变量 3。
 */
export interface CacheLike {
  getMany(keys: string[]): Promise<Map<string, string>>;
  putMany(items: Map<string, string>): Promise<void>;
}

export interface BatchDeps {
  engine: Translator;
  engineConfig: EngineConfig;
  sourceLang: string;
  targetLang: string;
  glossary?: Term[];
  systemPrompt?: string;
  cache: CacheLike;
  /**
   * 外部取消信号。调度器自己不设超时（超时归 content script，见 `callEngine`），
   * 但必须留一个能把取消注入引擎的入口：一旦它 abort，引擎收到的 signal 也跟着 abort。
   */
  signal?: AbortSignal;
  /** 测试可注入假定时器；默认真实等待 */
  sleep?: (ms: number) => Promise<void>;
}

/** 退避预算（规格 §8）：网络错误 / 超时退避 500ms → 1500ms 两次。 */
const BACKOFF_MS = [500, 1500];

/** 二次切分的阈值下限：切点只允许落在句子边界，见 `splitBySentence`。 */
const SPLIT_MIN_LEN = 200;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function callEngine(texts: string[], deps: BatchDeps): Promise<string[]> {
  // signal 是 TranslateRequest 的必填字段，两个引擎都真的用了它（fetch 的 signal、
  // 以及拿到响应后再查一次 aborted）。外部取消经 deps.signal 注入；调度器自身不设超时：
  // 设计规格把超时归给 content script（§8「content script 侧对请求加超时」），
  // 那个超时由 WU7 落地。这里给一个假超时反而会掐掉合法的大批次。
  const controller = new AbortController();
  if (deps.signal?.aborted) controller.abort();
  else deps.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  const translations = await deps.engine.translate(
    {
      texts,
      from: deps.sourceLang,
      to: deps.targetLang,
      glossary: deps.glossary,
      systemPrompt: deps.systemPrompt,
      signal: controller.signal,
    },
    deps.engineConfig,
  );
  if (!Array.isArray(translations) || translations.length !== texts.length) {
    throw new EngineError('BAD_RESPONSE', '引擎返回的条目数与请求不一致');
  }
  return translations;
}

/**
 * 一次引擎调用加它应得的退避重试（规格 §8：网络错误 / 超时退避 500ms → 1500ms 两次）。
 *
 * 边界：批量重试是最后手段，条目级的抖动由引擎内部吸收（见 `engines/google.ts` 的
 * `translateOneWithRetry`）。调度器只看得到「整批成功 / 整批失败」，一次调用摊成的
 * N 个请求里任意一个抖动都会让整批失败，所以引擎必须先按条目重试；否则 12 条批次里
 * 第 11 条抖一次就会实打实发出 24 条文本，免费接口的 429 还会把「抖动 → 整批重发 →
 * 限流 → 再整批重发」接成正反馈。
 *
 * 残留风险：某一条连续失败（超出引擎的条目重试预算）时，这里仍会把整批重发一次；
 * 已经成功的那几条也白翻一遍。彻底消除要等引擎能把「逐条成败」上报给调度器。
 *
 * 降级路径（切分、逐条）也必须走这里。它们把一次请求摊成 N 次，撞上瞬时抖动的概率
 * 本就比整批请求高；少了这层重试，第 11 次调用的一次抖动会让整批 12 条一起报错。
 *
 * 只重试瞬时错误（见 `RETRYABLE_CODES`）：`BAD_RESPONSE` 重试同一个输入没有意义，
 * 它是调用方决定降级还是上报的依据；`TOO_LONG` 该降到切分路径，重问一次必然还是过长。
 * 判据只有 `RETRYABLE_CODES` 一份（`engines/types`），调度器不再自带一套集合——
 * 两处各写一份时「`TOO_LONG` 算不算可重试」会随改动漂移。
 */
async function callEngineWithRetry(texts: string[], deps: BatchDeps): Promise<string[]> {
  const sleep = deps.sleep ?? defaultSleep;
  let last: EngineError | undefined;

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
    try {
      return await callEngine(texts, deps);
    } catch (raw) {
      const error = toEngineError(raw);
      last = error;

      if (!RETRYABLE_CODES.has(error.code)) throw error;

      if (attempt < BACKOFF_MS.length) await sleep(BACKOFF_MS[attempt]);
    }
  }
  throw last ?? new EngineError('UNKNOWN', '未知错误');
}

/**
 * 引擎报文本过长时，把每条按句子切开分别翻译，再拼回一段。
 *
 * 与 `translateOneByOne` 同形：逐条 try/catch，某条（或它切出的某一片）失败只把该条的
 * `EngineError` 放进对应位置。整批抛出会让 `translateBatch` 把所有 missing 条目标成
 * 同一个错误码——a 明明已经切分翻好了，却因为 b 的 AUTH 被连坐，连缓存都进不去。
 */
async function translateSplit(
  texts: string[],
  deps: BatchDeps,
): Promise<Array<string | EngineError>> {
  const out: Array<string | EngineError> = [];
  for (const text of texts) {
    try {
      const pieces = splitBySentence(text, Math.max(SPLIT_MIN_LEN, Math.ceil(text.length / 2)));
      const translated = await callEngineWithRetry(pieces, deps);
      out.push(joinPieces(translated, deps.targetLang));
    } catch (raw) {
      out.push(toEngineError(raw));
    }
  }
  return out;
}

/**
 * 模型没按编号返回时，退回逐条翻译，牺牲速度换正确性。
 *
 * 返回与 texts 等长的结果数组，而不是只成功时返回：某一条失败不该把前面已经翻好的
 * 条目一起丢掉。调用方拿到成功项照常上报与写缓存，只把失败的下标标成错误。
 */
async function translateOneByOne(
  texts: string[],
  deps: BatchDeps,
): Promise<Array<string | EngineError>> {
  const out: Array<string | EngineError> = [];
  for (const text of texts) {
    try {
      const single = await callEngineWithRetry([text], deps);
      out.push(single[0]);
    } catch (raw) {
      out.push(toEngineError(raw));
    }
  }
  return out;
}

/** 正常结果与逐条降级的半成品都从这里出来，后者见 `translateOneByOne`。 */
async function translateWithFallback(
  texts: string[],
  deps: BatchDeps,
): Promise<Array<string | EngineError>> {
  try {
    return await callEngineWithRetry(texts, deps);
  } catch (raw) {
    const error = toEngineError(raw);

    if (error.code === 'TOO_LONG') return translateSplit(texts, deps);
    // 只有一条时没有可退的地方：再拿同一个 [text] 问一次 BAD_RESPONSE，只会无限打转。
    if (error.code === 'BAD_RESPONSE' && texts.length > 1) return translateOneByOne(texts, deps);

    throw error;
  }
}

/**
 * 处理一个批次：缓存命中直接返回，未命中的合并成一次引擎请求。
 * 任何失败都转成携带错误码的结果项，绝不抛错——内容脚本据此渲染"重试"按钮。
 * 缓存读写失败不在此列：那不是"这次翻译失败"，降级即可（读当未命中、写当没缓存上）。
 */
export async function translateBatch(items: TranslateItem[], deps: BatchDeps): Promise<TranslateItemResult[]> {
  const results: TranslateItemResult[] = items.map((item) => ({ id: item.id, text: null }));
  if (items.length === 0) return results;

  const glossaryHash = hashString(JSON.stringify(deps.glossary ?? []));
  const promptHash = hashString(deps.systemPrompt ?? '');
  const configHash = hashString(
    JSON.stringify({ baseUrl: deps.engineConfig.baseUrl ?? '', model: deps.engineConfig.model ?? '' }),
  );
  const keys = items.map((item) =>
    buildCacheKey({
      engineId: deps.engine.id,
      configHash,
      targetLang: deps.targetLang,
      glossaryHash,
      promptHash,
      text: item.text,
    }),
  );

  // CacheLike 是鸭子类型接口，读失败由实现自行决定抛不抛；这里自己兜住，
  // 最坏只是把命中的条目也当成未命中重翻一遍，好过把异常抛出 translateBatch。
  let cached: Map<string, string>;
  try {
    cached = await deps.cache.getMany(keys);
  } catch {
    cached = new Map();
  }
  const missing: number[] = [];
  items.forEach((item, index) => {
    // 空文本不进引擎也不进缓存：'' 写进缓存与"翻成了空"无法区分，发给引擎也只是
    // 白发一次请求。但空白条目要原样返回：把 '  \n ' 改写成 '' 会让内容脚本清空一个
    // 只含空白的节点，双语模式下的行内排版会跟着变，而这里本来"没什么可翻"。
    if (item.text.trim() === '') {
      results[index] = { id: item.id, text: item.text };
      return;
    }
    const hit = cached.get(keys[index]);
    if (hit === undefined) missing.push(index);
    else results[index] = { id: item.id, text: hit };
  });
  if (missing.length === 0) return results;

  // 待写缓存的条目：声明在 try 之外，因为写入发生在 try/catch 之后（见下方注释）。
  const toCache = new Map<string, string>();
  /**
   * 落一条结果，返回它是否算失败。
   *
   * 类型守卫写在这里，是因为 `translateOneByOne` 的半成品用 `string | EngineError`
   * 表达逐条成败；这个判断同时承担 TS 的类型收窄和"成功才进缓存"的语义。
   */
  const settle = (index: number, translation: string | EngineError): boolean => {
    if (translation instanceof EngineError) {
      results[index] = {
        id: items[index].id,
        text: null,
        code: translation.code,
        message: translation.message,
      };
      return true;
    }
    results[index] = { id: items[index].id, text: translation };
    toCache.set(keys[index], translation);
    return false;
  };

  try {
    const translations = await translateWithFallback(
      missing.map((index) => items[index].text),
      deps,
    );
    // 逐条降级的半成品：逐条上报，别把已经翻好的条目一起丢掉，也别给它们安上
    // 邻居的错误码。成功的那几条照常进缓存，用户点重试时只需再翻失败的那几条。
    missing.forEach((index, offset) => void settle(index, translations[offset]));
  } catch (raw) {
    const error = toEngineError(raw);
    for (const index of missing) settle(index, error);
  }

  // 写缓存放在引擎 try 之外：缓存写失败只意味着这次没缓存上，
  // 放进同一个 try 会把"翻译成功但没缓存上"上报成整批失败，给用户一个错误的重试按钮。
  // 因此这里单独兜住异常——CacheLike 是鸭子类型接口，不能假定实现不抛错，
  // 而 translateBatch 的对外契约是绝不抛错。
  try {
    await deps.cache.putMany(toCache);
  } catch {
    // 没写进缓存，下次再翻一遍即可；本轮的译文结果依然有效。
  }

  return results;
}
