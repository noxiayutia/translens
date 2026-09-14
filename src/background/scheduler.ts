import { buildCacheKey, hashString } from '../core/hash';
import { joinPieces, splitBySentence } from '../core/segmenter';
import {
  EngineError,
  toEngineError,
  type EngineConfig,
  type Term,
  type Translator,
} from '../engines/types';
import type { TranslateItem, TranslateItemResult } from '../shared/messages';

/**
 * 批次用到的缓存子集。实现允许抛错：`translateBatch` 会自行降级
 * （读当未命中、写当没缓存上），不把缓存异常抛给调用方。
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
  /** 测试可注入假定时器；默认真实等待 */
  sleep?: (ms: number) => Promise<void>;
}

const BACKOFF_MS = [500, 1500];

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function callEngine(texts: string[], deps: BatchDeps): Promise<string[]> {
  const controller = new AbortController();
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

/** 引擎报文本过长时，把每条按句子切开分别翻译，再拼回一段。 */
async function translateSplit(texts: string[], deps: BatchDeps): Promise<string[]> {
  const out: string[] = [];
  for (const text of texts) {
    const pieces = splitBySentence(text, Math.max(200, Math.ceil(text.length / 2)));
    const translated = await callEngine(pieces, deps);
    out.push(joinPieces(translated, deps.targetLang));
  }
  return out;
}

/** 模型没按编号返回时，退回逐条翻译，牺牲速度换正确性。 */
async function translateOneByOne(texts: string[], deps: BatchDeps): Promise<string[]> {
  const out: string[] = [];
  for (const text of texts) {
    const single = await callEngine([text], deps);
    out.push(single[0]);
  }
  return out;
}

async function translateWithFallback(texts: string[], deps: BatchDeps): Promise<string[]> {
  const sleep = deps.sleep ?? defaultSleep;
  let last: EngineError | undefined;

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
    try {
      return await callEngine(texts, deps);
    } catch (raw) {
      const error = toEngineError(raw);
      last = error;

      if (error.code === 'TOO_LONG') return translateSplit(texts, deps);
      if (error.code === 'BAD_RESPONSE' && texts.length > 1) return translateOneByOne(texts, deps);
      if (!error.retryable) throw error;

      if (attempt < BACKOFF_MS.length) await sleep(BACKOFF_MS[attempt]);
    }
  }
  throw last ?? new EngineError('UNKNOWN', '未知错误');
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
  const configHash = hashString(JSON.stringify({ baseUrl: deps.engineConfig.baseUrl ?? '', model: deps.engineConfig.model ?? '' }));
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
    const hit = cached.get(keys[index]);
    if (hit === undefined) missing.push(index);
    else results[index] = { id: item.id, text: hit };
  });
  if (missing.length === 0) return results;

  // 待写缓存的条目：声明在 try 之外，因为写入发生在 try/catch 之后（见下方注释）。
  const toCache = new Map<string, string>();
  try {
    const translations = await translateWithFallback(
      missing.map((index) => items[index].text),
      deps,
    );
    translations.forEach((translation, offset) => {
      const index = missing[offset];
      results[index] = { id: items[index].id, text: translation };
      toCache.set(keys[index], translation);
    });
  } catch (raw) {
    const error = toEngineError(raw);
    for (const index of missing) {
      results[index] = { id: items[index].id, text: null, code: error.code, message: error.message };
    }
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
