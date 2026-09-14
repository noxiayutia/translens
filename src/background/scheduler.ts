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

  const cached = await deps.cache.getMany(keys);
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

  // 写缓存放在引擎 try 之外：缓存写失败只意味着这次没缓存上（cache.putMany 本身也不抛错），
  // 放进同一个 try 会把"翻译成功但没缓存上"上报成整批失败，给用户一个错误的重试按钮。
  await deps.cache.putMany(toCache);

  return results;
}
