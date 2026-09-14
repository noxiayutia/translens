## Task 2: `core/hash.ts` — 稳定哈希与缓存 key

**Files:**
- Create: `src/core/hash.ts`
- Test: `tests/core/hash.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/core/hash.test.ts
import { describe, expect, it } from 'vitest';
import { buildCacheKey, hashString } from '../../src/core/hash';

describe('hashString', () => {
  it('同样的输入得到同样的输出', () => {
    expect(hashString('hello world')).toBe(hashString('hello world'));
  });

  it('不同输入得到不同输出', () => {
    expect(hashString('hello')).not.toBe(hashString('hellp'));
  });

  it('能处理空字符串', () => {
    expect(hashString('')).toMatch(/^0-[0-9a-z]+-[0-9a-z]+$/);
  });

  it('能处理中文与 emoji', () => {
    expect(hashString('你好🌏')).toBe(hashString('你好🌏'));
    expect(hashString('你好🌏')).not.toBe(hashString('你好🌍'));
  });
});

describe('buildCacheKey', () => {
  const base = {
    engineId: 'google',
    targetLang: 'zh-Hans',
    glossaryHash: '',
    promptHash: '',
    text: 'Hello world',
  };

  it('同样的字段得到同样的 key', () => {
    expect(buildCacheKey(base)).toBe(buildCacheKey({ ...base }));
  });

  it('任一字段变化都会改变 key', () => {
    const key = buildCacheKey(base);
    expect(buildCacheKey({ ...base, text: 'Hello world!' })).not.toBe(key);
    expect(buildCacheKey({ ...base, engineId: 'openai-compat' })).not.toBe(key);
    expect(buildCacheKey({ ...base, targetLang: 'ja' })).not.toBe(key);
    expect(buildCacheKey({ ...base, glossaryHash: 'abc' })).not.toBe(key);
    expect(buildCacheKey({ ...base, promptHash: 'abc' })).not.toBe(key);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/hash.test.ts`

Expected: FAIL — 无法解析 `../../src/core/hash`。

- [ ] **Step 3: 写实现**

```ts
// src/core/hash.ts

/**
 * 32 位双通道哈希（FNV-1a + murmur 混合）。
 * 同步、无依赖，在 content script 与 service worker 中结果一致。
 */
export function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }
  return `${input.length.toString(36)}-${h1.toString(36)}-${h2.toString(36)}`;
}

export interface CacheKeyParts {
  engineId: string;
  targetLang: string;
  glossaryHash: string;
  promptHash: string;
  text: string;
}

/** 用 \u0000 分隔，避免字段拼接产生歧义（如 ("ab","c") 与 ("a","bc")）。 */
export function buildCacheKey(parts: CacheKeyParts): string {
  return hashString(
    [parts.engineId, parts.targetLang, parts.glossaryHash, parts.promptHash, parts.text].join('\u0000'),
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/hash.test.ts`

Expected: PASS，6 个用例全绿。

- [ ] **Step 5: 提交**

```bash
git add src/core/hash.ts tests/core/hash.test.ts
git commit -m "feat(core): 稳定哈希与缓存 key 组装"
```

---

## Task 3: `core/lang.ts` — 语种识别与跳过判定

**Files:**
- Create: `src/core/lang.ts`
- Test: `tests/core/lang.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/core/lang.test.ts
import { describe, expect, it } from 'vitest';
import { detectScript, isTranslatableText, normalizeText, shouldSkip } from '../../src/core/lang';

describe('detectScript', () => {
  it('识别纯中文', () => {
    expect(detectScript('这是一段中文')).toBe('zh');
  });

  it('含假名时判为日文（即使有汉字）', () => {
    expect(detectScript('日本語のテキストです')).toBe('ja');
  });

  it('识别韩文', () => {
    expect(detectScript('한국어 텍스트')).toBe('ko');
  });

  it('识别拉丁文', () => {
    expect(detectScript('Hello world')).toBe('latin');
  });

  it('中英混合按多数决', () => {
    expect(detectScript('Hello world 世界')).toBe('latin');
    expect(detectScript('你好世界 Hello')).toBe('zh');
  });

  it('没有字母时返回 unknown', () => {
    expect(detectScript('123 --- !!!')).toBe('unknown');
  });
});

describe('normalizeText', () => {
  it('折叠空白并去首尾', () => {
    expect(normalizeText('  a\n\n  b\t c ')).toBe('a b c');
  });

  it('null 与 undefined 返回空串', () => {
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(undefined)).toBe('');
  });
});

describe('isTranslatableText', () => {
  it('正常句子可翻译', () => {
    expect(isTranslatableText('Hello world')).toBe(true);
  });

  it('单字符不可翻译', () => {
    expect(isTranslatableText('a')).toBe(false);
  });

  it('纯数字与纯标点不可翻译', () => {
    expect(isTranslatableText('12345')).toBe(false);
    expect(isTranslatableText('—— …… ！！！')).toBe(false);
  });

  it('少于两个字母不可翻译', () => {
    expect(isTranslatableText('3 个')).toBe(false);
  });
});

describe('shouldSkip', () => {
  it('目标中文时跳过中文段落', () => {
    expect(shouldSkip('这是一段中文', 'zh-Hans')).toBe(true);
  });

  it('目标中文时不跳过英文段落', () => {
    expect(shouldSkip('This is English', 'zh-Hans')).toBe(false);
  });

  it('目标中文时不跳过日文段落（含汉字但以假名为主）', () => {
    expect(shouldSkip('これはテストです', 'zh-Hans')).toBe(false);
  });

  it('目标英文时跳过英文段落', () => {
    expect(shouldSkip('This is English', 'en')).toBe(true);
  });

  it('目标日文时跳过日文段落', () => {
    expect(shouldSkip('これはテストです', 'ja')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/lang.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/core/lang.ts

export interface LanguageOption {
  code: string;
  label: string;
}

export const LANGUAGES: LanguageOption[] = [
  { code: 'zh-Hans', label: '简体中文' },
  { code: 'zh-Hant', label: '繁體中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'ru', label: 'Русский' },
];

export type ScriptLang = 'zh' | 'ja' | 'ko' | 'ru' | 'ar' | 'latin' | 'unknown';

const SCRIPT_PATTERNS: Array<[ScriptLang, RegExp]> = [
  ['ja', /[\u3040-\u30ff]/g],
  ['ko', /[\uac00-\ud7af]/g],
  ['zh', /[\u4e00-\u9fff]/g],
  ['ru', /[\u0400-\u04ff]/g],
  ['ar', /[\u0600-\u06ff]/g],
  ['latin', /[A-Za-z]/g],
];

function countMatches(text: string, re: RegExp): number {
  const matched = text.match(re);
  return matched ? matched.length : 0;
}

/**
 * 统计某字符集在文本里出现的「连续片段」数，而非字符数。
 * 混排时一个汉字与一个英文单词的信息量相当，
 * 因此 '你好世界 Hello' 是 1 段中文 + 1 段拉丁（平局），而不是 4 个汉字 vs 5 个字母。
 */
function countRuns(text: string, re: RegExp): number {
  let runs = 0;
  let inRun = false;
  for (const char of text) {
    re.lastIndex = 0;
    const matched = re.test(char);
    if (matched && !inRun) runs += 1;
    inRun = matched;
  }
  return runs;
}

/** 按各字符集连续片段数取最多的那个；平局时按 SCRIPT_PATTERNS 的顺序优先。 */
export function detectScript(text: string): ScriptLang {
  let best: ScriptLang = 'unknown';
  let bestScore = 0;
  for (const [lang, re] of SCRIPT_PATTERNS) {
    const score = countRuns(text, re);
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  return best;
}

export function normalizeText(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

const LETTER = /\p{L}/gu;

/** 至少两个字母才算值得翻译的文本，挡掉价格、页码、纯标点这类噪声。 */
export function isTranslatableText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  return countMatches(trimmed, LETTER) >= 2;
}

function baseLang(code: string): string {
  return code.split('-')[0].toLowerCase();
}

const TARGET_SCRIPT: Record<string, ScriptLang> = {
  zh: 'zh',
  ja: 'ja',
  ko: 'ko',
  ru: 'ru',
  ar: 'ar',
  en: 'latin',
  fr: 'latin',
  de: 'latin',
  es: 'latin',
};

/** 段落已经是指定目标语言时无需翻译。 */
export function shouldSkip(text: string, targetLang: string): boolean {
  const expected = TARGET_SCRIPT[baseLang(targetLang)];
  if (!expected) return false;
  return detectScript(text) === expected;
}
```

> 实现备注（该行为已被本单元测试冻结）：`detectScript` 按各字符集的**连续片段数**而非字符数取多数，
> 平局时按 `SCRIPT_PATTERNS` 顺序优先。因此 `'你好世界 Hello'`（中文 1 段 / 拉丁 1 段）判为 `zh`，
> 于是 `shouldSkip('Hello 你好世界', 'zh-Hans') === true`——中文与拉丁各占一段的混排段落会被整段跳过。
> 若产品上要求这类混排段落参与翻译，需同时调整 `lang.test.ts` 的期望与本段说明，而不是只改实现。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/lang.test.ts`

Expected: PASS，全部用例通过。

- [ ] **Step 5: 提交**

```bash
git add src/core/lang.ts tests/core/lang.test.ts
git commit -m "feat(core): 语种脚本识别与跳过判定"
```

---

## Task 4: `core/segmenter.ts` — 批次合并与句子切分

**Files:**
- Create: `src/core/segmenter.ts`
- Test: `tests/core/segmenter.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/core/segmenter.test.ts
import { describe, expect, it } from 'vitest';
import { joinPieces, planBatches, splitBySentence, type TextSegment } from '../../src/core/segmenter';

function seg(id: string, text: string, order = 0): TextSegment {
  return { id, text, order };
}

const OPTIONS = { maxBatchChars: 100, maxSegmentsPerBatch: 3 };

describe('planBatches', () => {
  it('空输入返回空批次', () => {
    expect(planBatches([], OPTIONS)).toEqual([]);
  });

  it('相邻短段合并为一批', () => {
    const batches = planBatches([seg('a', 'x'.repeat(10)), seg('b', 'x'.repeat(10))], OPTIONS);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('超过字符上限时切批', () => {
    const batches = planBatches(
      [seg('a', 'x'.repeat(60)), seg('b', 'x'.repeat(60))],
      OPTIONS,
    );
    expect(batches.map((b) => b.map((s) => s.id))).toEqual([['a'], ['b']]);
  });

  it('超过段数上限时切批', () => {
    const batches = planBatches(
      [seg('a', 'x'), seg('b', 'x'), seg('c', 'x'), seg('d', 'x')],
      OPTIONS,
    );
    expect(batches.map((b) => b.map((s) => s.id))).toEqual([['a', 'b', 'c'], ['d']]);
  });

  it('超长段独占一批，不与前后合并', () => {
    const batches = planBatches(
      [seg('a', 'x'.repeat(10)), seg('long', 'x'.repeat(200)), seg('b', 'x'.repeat(10))],
      OPTIONS,
    );
    expect(batches.map((b) => b.map((s) => s.id))).toEqual([['a'], ['long'], ['b']]);
  });

  it('保持原始顺序', () => {
    const batches = planBatches(
      [seg('a', 'x'.repeat(60)), seg('b', 'x'.repeat(10)), seg('c', 'x'.repeat(60))],
      OPTIONS,
    );
    expect(batches.flat().map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('splitBySentence', () => {
  it('短文本不切分', () => {
    expect(splitBySentence('Hello world.', 100)).toEqual(['Hello world.']);
  });

  it('中文按句号切分', () => {
    expect(splitBySentence('第一句。第二句。第三句。', 6)).toEqual(['第一句。', '第二句。', '第三句。']);
  });

  it('英文按句末标点切分', () => {
    expect(splitBySentence('One. Two. Three.', 8)).toEqual(['One. ', 'Two. ', 'Three.']);
  });

  it('没有句子边界时硬切', () => {
    const pieces = splitBySentence('x'.repeat(25), 10);
    expect(pieces).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('切分后不丢字符', () => {
    const text = '第一句。第二句。第三句。第四句。';
    expect(splitBySentence(text, 5).join('')).toBe(text);
  });
});

describe('joinPieces', () => {
  it('中文目标语言直接拼接', () => {
    expect(joinPieces(['第一句。', '第二句。'], 'zh-Hans')).toBe('第一句。第二句。');
  });

  it('英文目标语言用空格拼接', () => {
    expect(joinPieces(['One.', 'Two.'], 'en')).toBe('One. Two.');
  });

  it('忽略空白片段', () => {
    expect(joinPieces(['One.', '   ', ''], 'en')).toBe('One.');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/segmenter.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/core/segmenter.ts

export interface TextSegment {
  id: string;
  text: string;
  order: number;
}

export interface BatchOptions {
  /** 一批内所有段落的总字符上限 */
  maxBatchChars: number;
  /** 一批内最多几段，避免一次塞进几十个碎句 */
  maxSegmentsPerBatch: number;
}

/**
 * 按 DOM 顺序把相邻段落合并成批次。
 * 单段自身超过 maxBatchChars 时独占一批——正常路径不做段内切分，
 * 段内切分只发生在引擎报"文本过长"的降级路径（见 background/scheduler.ts）。
 */
export function planBatches(segments: TextSegment[], options: BatchOptions): TextSegment[][] {
  const batches: TextSegment[][] = [];
  let current: TextSegment[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
  };

  for (const segment of segments) {
    const length = segment.text.length;
    if (length >= options.maxBatchChars) {
      flush();
      batches.push([segment]);
      continue;
    }
    const wouldExceedChars = currentChars + length > options.maxBatchChars;
    const wouldExceedCount = current.length >= options.maxSegmentsPerBatch;
    if (current.length > 0 && (wouldExceedChars || wouldExceedCount)) flush();
    current.push(segment);
    currentChars += length;
  }
  flush();
  return batches;
}

/** 句末标点连同其后的空白一起归属前一片段（'One. Two.' → 'One. ' + 'Two.'）。 */
const SENTENCE_BOUNDARY = /[。！？；!?;]\s*|\.(?=\s|$)\s*/g;

/**
 * 把超长文本按句子边界切成不超过 maxLen 的片段。
 * 单句本身超过 maxLen 时硬切，保证输出片段一定不超限。
 */
export function splitBySentence(text: string, maxLen: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen);
    SENTENCE_BOUNDARY.lastIndex = 0;
    let cut = -1;
    let match = SENTENCE_BOUNDARY.exec(window);
    while (match !== null) {
      cut = match.index + match[0].length;
      match = SENTENCE_BOUNDARY.exec(window);
    }
    if (cut <= 0) cut = maxLen;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

const CJK_TARGET = /^(zh|ja|ko)/;

/** 把降级切分后分别翻译的片段拼回一段。中文不加空格，英文加。 */
export function joinPieces(pieces: string[], targetLang: string): string {
  const separator = CJK_TARGET.test(targetLang) ? '' : ' ';
  return pieces
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .join(separator);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/segmenter.test.ts`

Expected: PASS，全部用例通过。

- [ ] **Step 5: 提交**

```bash
git add src/core/segmenter.ts tests/core/segmenter.test.ts
git commit -m "feat(core): 批次合并与超长文本按句切分"
```

---

## Task 5: `core/pool.ts` — 并发池

**Files:**
- Create: `src/core/pool.ts`
- Test: `tests/core/pool.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/core/pool.test.ts
import { describe, expect, it } from 'vitest';
import { runPool } from '../../src/core/pool';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('runPool', () => {
  it('空任务返回空数组', async () => {
    expect(await runPool([], 3)).toEqual([]);
  });

  it('结果顺序与任务顺序一致', async () => {
    const tasks = [
      async () => 'a',
      async () => 'b',
      async () => 'c',
    ];
    expect(await runPool(tasks, 1)).toEqual(['a', 'b', 'c']);
  });

  it('并发数不超过上限', async () => {
    let running = 0;
    let peak = 0;
    const gate = deferred<void>();
    const tasks = Array.from({ length: 6 }, () => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
      return 'ok';
    });
    const pending = runPool(tasks, 2);
    await Promise.resolve();
    expect(peak).toBeLessThanOrEqual(2);
    gate.resolve();
    expect(await pending).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  });

  it('并发上限大于任务数时也能跑完', async () => {
    const tasks = [async () => 1, async () => 2];
    expect(await runPool(tasks, 10)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/pool.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/core/pool.ts

/**
 * 以最多 limit 个并发执行任务，返回结果数组，顺序与 tasks 一致。
 * 任务自身的异常会向上抛出（调用方负责在任务内部捕获）。
 */
export async function runPool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  if (tasks.length === 0) return results;

  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/pool.test.ts`

Expected: PASS，4 个用例通过。

- [ ] **Step 5: 提交**

```bash
git add src/core/pool.ts tests/core/pool.test.ts
git commit -m "feat(core): 并发池"
```

---

## Task 6: `engines/types.ts` — 引擎接口与错误类型

**Files:**
- Create: `src/engines/types.ts`
- Test: `tests/engines/types.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/engines/types.test.ts
import { describe, expect, it } from 'vitest';
import { EngineError, toEngineError } from '../../src/engines/types';

describe('EngineError', () => {
  it('网络错误与限流可重试', () => {
    expect(new EngineError('NETWORK', 'x').retryable).toBe(true);
    expect(new EngineError('RATE_LIMIT', 'x').retryable).toBe(true);
  });

  it('鉴权失败与格式错误不可重试', () => {
    expect(new EngineError('AUTH', 'x').retryable).toBe(false);
    expect(new EngineError('BAD_RESPONSE', 'x').retryable).toBe(false);
  });

  it('保留错误码与消息', () => {
    const err = new EngineError('AUTH', '缺少 API Key');
    expect(err.code).toBe('AUTH');
    expect(err.message).toBe('缺少 API Key');
    expect(err.name).toBe('EngineError');
  });
});

describe('toEngineError', () => {
  it('EngineError 原样返回', () => {
    const err = new EngineError('AUTH', 'x');
    expect(toEngineError(err)).toBe(err);
  });

  it('AbortError 转成 ABORTED', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(toEngineError(abort).code).toBe('ABORTED');
  });

  it('未知错误转成 UNKNOWN 并保留消息', () => {
    const err = toEngineError(new Error('boom'));
    expect(err.code).toBe('UNKNOWN');
    expect(err.message).toBe('boom');
  });

  it('非 Error 值也能处理', () => {
    expect(toEngineError('oops').code).toBe('UNKNOWN');
    expect(toEngineError('oops').message).toBe('oops');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/engines/types.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/engines/types.ts

export interface Term {
  from: string;
  to: string;
}

export interface TranslateRequest {
  texts: string[];
  from: string;
  to: string;
  glossary?: Term[];
  systemPrompt?: string;
  signal: AbortSignal;
}

export interface EngineConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export type EngineErrorCode =
  | 'NETWORK'
  | 'RATE_LIMIT'
  | 'AUTH'
  | 'TOO_LONG'
  | 'BAD_RESPONSE'
  | 'ABORTED'
  | 'UNKNOWN';

const RETRYABLE: ReadonlySet<EngineErrorCode> = new Set<EngineErrorCode>([
  'NETWORK',
  'RATE_LIMIT',
  'TOO_LONG',
]);

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly retryable: boolean;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
  }
}

export function toEngineError(raw: unknown): EngineError {
  if (raw instanceof EngineError) return raw;
  if (raw instanceof Error) {
    if (raw.name === 'AbortError') return new EngineError('ABORTED', '请求已取消');
    return new EngineError('UNKNOWN', raw.message);
  }
  return new EngineError('UNKNOWN', String(raw));
}

export interface Translator {
  id: string;
  name: string;
  /** 需要 API Key 的引擎为 true，弹窗据此显示红色状态点 */
  needsKey: boolean;
  /** 是否支持 system prompt；为 false 时术语表与自定义提示词不生效 */
  supportsGlossary: boolean;
  translate(request: TranslateRequest, config: EngineConfig): Promise<string[]>;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/engines/types.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/engines/types.ts tests/engines/types.test.ts
git commit -m "feat(engines): 引擎接口与错误类型"
```

---
