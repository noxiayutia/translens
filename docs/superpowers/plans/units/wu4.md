## Task 10: `core/cache.ts` — 两级翻译缓存

**Files:**
- Create: `src/core/cache.ts`
- Create: `tests/helpers/memory-storage.ts`
- Test: `tests/core/cache.test.ts`

- [ ] **Step 1: 写内存存储测试替身**

```ts
// tests/helpers/memory-storage.ts
import type { StorageArea } from '../../src/core/cache';

export class MemoryStorage implements StorageArea {
  private readonly data = new Map<string, unknown>();
  /** 记录写入次数，用于断言缓存命中时没有多余写入 */
  setCalls = 0;

  async get(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (this.data.has(key)) out[key] = structuredClone(this.data.get(key));
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.setCalls += 1;
    for (const [key, value] of Object.entries(items)) {
      this.data.set(key, structuredClone(value));
    }
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) this.data.delete(key);
  }

  size(): number {
    return this.data.size;
  }

  has(key: string): boolean {
    return this.data.has(key);
  }
}
```

- [ ] **Step 2: 写失败的测试**

```ts
// tests/core/cache.test.ts
import { describe, expect, it } from 'vitest';
import { TieredCache, TranslationCache } from '../../src/core/cache';
import { MemoryStorage } from '../helpers/memory-storage';

describe('TranslationCache', () => {
  it('写入后能读回', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    await cache.putMany(new Map([['h1', '你好']]));
    const hit = await cache.getMany(['h1']);
    expect(hit.get('h1')).toBe('你好');
  });

  it('未命中的 key 不出现在结果里', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    const hit = await cache.getMany(['missing']);
    expect(hit.size).toBe(0);
  });

  it('空输入不产生写入', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage);
    await cache.getMany([]);
    await cache.putMany(new Map());
    expect(storage.setCalls).toBe(0);
  });

  it('超过上限时淘汰最旧的条目', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 2);
    await cache.putMany(new Map([['a', '1']]));
    await cache.putMany(new Map([['b', '2']]));
    await cache.putMany(new Map([['c', '3']]));

    const hit = await cache.getMany(['a', 'b', 'c']);
    expect(hit.has('a')).toBe(false);
    expect(hit.get('b')).toBe('2');
    expect(hit.get('c')).toBe('3');
    expect(await cache.count()).toBe(2);
  });

  it('重复写入同一 key 不重复占位', async () => {
    const cache = new TranslationCache(new MemoryStorage(), 10);
    await cache.putMany(new Map([['a', '1']]));
    await cache.putMany(new Map([['a', '2']]));
    expect(await cache.count()).toBe(1);
    expect((await cache.getMany(['a'])).get('a')).toBe('2');
  });

  it('clear 清空所有条目', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage);
    await cache.putMany(new Map([['a', '1'], ['b', '2']]));
    await cache.clear();
    expect(await cache.count()).toBe(0);
    expect(storage.size()).toBe(0);
  });
});

describe('TieredCache', () => {
  it('会话层命中时不查持久层', async () => {
    const sessionStorage = new MemoryStorage();
    const localStorageArea = new MemoryStorage();
    const session = new TranslationCache(sessionStorage);
    const local = new TranslationCache(localStorageArea);
    await session.putMany(new Map([['a', '1']]));

    const tiered = new TieredCache(session, local);
    const hit = await tiered.getMany(['a']);
    expect(hit.get('a')).toBe('1');
    expect(localStorageArea.setCalls).toBe(0);
  });

  it('持久层命中时回填会话层', async () => {
    const sessionStorage = new MemoryStorage();
    const session = new TranslationCache(sessionStorage);
    const local = new TranslationCache(new MemoryStorage());
    await local.putMany(new Map([['a', '1']]));

    const tiered = new TieredCache(session, local);
    const hit = await tiered.getMany(['a']);
    expect(hit.get('a')).toBe('1');
    expect((await session.getMany(['a'])).get('a')).toBe('1');
  });

  it('写入时两层都写', async () => {
    const session = new TranslationCache(new MemoryStorage());
    const local = new TranslationCache(new MemoryStorage());
    const tiered = new TieredCache(session, local);
    await tiered.putMany(new Map([['a', '1']]));
    expect((await session.getMany(['a'])).get('a')).toBe('1');
    expect((await local.getMany(['a'])).get('a')).toBe('1');
  });

  it('两层都没有时返回空', async () => {
    const tiered = new TieredCache(
      new TranslationCache(new MemoryStorage()),
      new TranslationCache(new MemoryStorage()),
    );
    expect((await tiered.getMany(['x'])).size).toBe(0);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/core/cache.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 4: 写实现**

```ts
// src/core/cache.ts

/** chrome.storage.StorageArea 的可测试子集。 */
export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

const ENTRY_PREFIX = 'jt:';
const INDEX_KEY = 'jt:index';

interface CacheEntry {
  v: string;
  t: number;
}

/**
 * 每条译文独立存一个 key，另用一个索引 key 维护 LRU 顺序。
 * 这样淘汰时只需 remove 指定 key，不必整块重写。
 */
export class TranslationCache {
  constructor(
    private readonly area: StorageArea,
    private readonly maxEntries = 5000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private entryKey(hash: string): string {
    return ENTRY_PREFIX + hash;
  }

  async getMany(hashes: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (hashes.length === 0) return out;

    const keys = hashes.map((hash) => this.entryKey(hash));
    const raw = await this.area.get(keys);
    hashes.forEach((hash, index) => {
      const entry = raw[keys[index]] as CacheEntry | undefined;
      if (entry && typeof entry.v === 'string') out.set(hash, entry.v);
    });
    return out;
  }

  async putMany(items: Map<string, string>): Promise<void> {
    if (items.size === 0) return;

    const batch: Record<string, unknown> = {};
    const hashes: string[] = [];
    for (const [hash, value] of items) {
      batch[this.entryKey(hash)] = { v: value, t: this.now() } satisfies CacheEntry;
      hashes.push(hash);
    }
    await this.area.set(batch);
    await this.touch(hashes);
  }

  private async touch(hashes: string[]): Promise<void> {
    const raw = await this.area.get([INDEX_KEY]);
    const stored = raw[INDEX_KEY];
    const index = Array.isArray(stored) ? (stored as string[]) : [];
    const incoming = new Set(hashes);
    const merged = [...index.filter((hash) => !incoming.has(hash)), ...hashes];

    const overflow = merged.length - this.maxEntries;
    if (overflow > 0) {
      const evicted = merged.splice(0, overflow);
      await this.area.remove(evicted.map((hash) => this.entryKey(hash)));
    }
    await this.area.set({ [INDEX_KEY]: merged });
  }

  async count(): Promise<number> {
    const raw = await this.area.get([INDEX_KEY]);
    const stored = raw[INDEX_KEY];
    return Array.isArray(stored) ? stored.length : 0;
  }

  async clear(): Promise<void> {
    const raw = await this.area.get([INDEX_KEY]);
    const stored = raw[INDEX_KEY];
    const index = Array.isArray(stored) ? (stored as string[]) : [];
    await this.area.remove([...index.map((hash) => this.entryKey(hash)), INDEX_KEY]);
  }
}

/** 会话层（快，随浏览器会话消失）→ 持久层（慢，跨会话保留）。 */
export class TieredCache {
  constructor(
    private readonly session: TranslationCache,
    private readonly persistent: TranslationCache,
  ) {}

  async getMany(hashes: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (hashes.length === 0) return out;

    const fromSession = await this.session.getMany(hashes);
    for (const [hash, value] of fromSession) out.set(hash, value);

    const missing = hashes.filter((hash) => !out.has(hash));
    if (missing.length > 0) {
      const fromPersistent = await this.persistent.getMany(missing);
      if (fromPersistent.size > 0) {
        await this.session.putMany(fromPersistent);
        for (const [hash, value] of fromPersistent) out.set(hash, value);
      }
    }
    return out;
  }

  async putMany(items: Map<string, string>): Promise<void> {
    if (items.size === 0) return;
    await this.session.putMany(items);
    await this.persistent.putMany(items);
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/core/cache.test.ts`

Expected: PASS，全部用例通过。

- [ ] **Step 6: 提交**

```bash
git add src/core/cache.ts tests/helpers/memory-storage.ts tests/core/cache.test.ts
git commit -m "feat(core): 两级翻译缓存与 LRU 淘汰"
```

---

## Task 11: `shared/settings.ts` — 设置 schema 与读写

**Files:**
- Create: `src/shared/settings.ts`
- Create: `src/shared/chrome-area.ts`
- Test: `tests/shared/settings.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/shared/settings.test.ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, mergeSettings, saveSettings } from '../../src/shared/settings';
import { MemoryStorage } from '../helpers/memory-storage';

describe('mergeSettings', () => {
  it('空对象得到完整默认值', () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('保留用户已设置的值', () => {
    const merged = mergeSettings({ targetLang: 'ja', engineId: 'openai-compat' });
    expect(merged.targetLang).toBe('ja');
    expect(merged.engineId).toBe('openai-compat');
  });

  it('补齐缺失字段', () => {
    const merged = mergeSettings({ targetLang: 'ja' });
    expect(merged.displayMode).toBe(DEFAULT_SETTINGS.displayMode);
    expect(merged.engineConfig).toEqual(DEFAULT_SETTINGS.engineConfig);
  });

  it('忽略类型不符的值', () => {
    const merged = mergeSettings({ concurrency: '很多' as unknown as number, siteRules: 'not-an-array' as unknown as [] });
    expect(merged.concurrency).toBe(DEFAULT_SETTINGS.concurrency);
    expect(merged.siteRules).toEqual([]);
  });

  it('过滤掉结构不完整的站点规则与术语', () => {
    const merged = mergeSettings({
      siteRules: [{ pattern: '*.a.com', action: 'never' }, { pattern: 'x' }, null],
      glossary: [{ from: 'DSH', to: 'DeepSeek Harness' }, { from: 'only' }],
    });
    expect(merged.siteRules).toEqual([{ pattern: '*.a.com', action: 'never' }]);
    expect(merged.glossary).toEqual([{ from: 'DSH', to: 'DeepSeek Harness' }]);
  });

  it('数字超出合理范围时夹紧', () => {
    expect(mergeSettings({ concurrency: 999 }).concurrency).toBe(8);
    expect(mergeSettings({ concurrency: 0 }).concurrency).toBe(1);
  });
});

describe('loadSettings / saveSettings', () => {
  it('未存储过时返回默认值', async () => {
    expect(await loadSettings(new MemoryStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it('保存后能读回', async () => {
    const area = new MemoryStorage();
    await saveSettings({ ...DEFAULT_SETTINGS, targetLang: 'ko' }, area);
    expect((await loadSettings(area)).targetLang).toBe('ko');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/shared/settings.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现 `src/shared/settings.ts`**

```ts
// src/shared/settings.ts
import type { StorageArea } from '../core/cache';
import type { Term } from '../engines/types';
import { chromeArea } from './chrome-area';

export interface SiteRule {
  pattern: string;
  action: 'translate' | 'never';
}

export interface EngineConfigSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface Settings {
  version: number;
  engineId: string;
  engineConfig: EngineConfigSettings;
  targetLang: string;
  sourceLang: string;
  displayMode: 'bilingual' | 'replace';
  hoverTranslate: boolean;
  selectionTranslate: boolean;
  autoTranslateDelay: number;
  concurrency: number;
  maxBatchChars: number;
  maxSegmentsPerBatch: number;
  cacheMaxEntries: number;
  siteRules: SiteRule[];
  glossary: Term[];
  systemPrompt: string;
}

export const SETTINGS_KEY = 'jinyi:settings';

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  engineId: 'google',
  engineConfig: { apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  targetLang: 'zh-Hans',
  sourceLang: 'auto',
  displayMode: 'bilingual',
  hoverTranslate: true,
  selectionTranslate: true,
  autoTranslateDelay: 0,
  concurrency: 3,
  maxBatchChars: 1000,
  maxSegmentsPerBatch: 12,
  cacheMaxEntries: 5000,
  siteRules: [],
  glossary: [],
  systemPrompt: '',
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickSiteRules(value: unknown): SiteRule[] {
  if (!Array.isArray(value)) return [];
  const out: SiteRule[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const rule = raw as Partial<SiteRule>;
    if (typeof rule.pattern !== 'string' || rule.pattern.length === 0) continue;
    if (rule.action !== 'translate' && rule.action !== 'never') continue;
    out.push({ pattern: rule.pattern, action: rule.action });
  }
  return out;
}

function pickGlossary(value: unknown): Term[] {
  if (!Array.isArray(value)) return [];
  const out: Term[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const term = raw as Partial<Term>;
    if (typeof term.from !== 'string' || typeof term.to !== 'string') continue;
    if (term.from.length === 0) continue;
    out.push({ from: term.from, to: term.to });
  }
  return out;
}

function pickEngineConfig(value: unknown): EngineConfigSettings {
  const raw = (value ?? {}) as Partial<EngineConfigSettings>;
  return {
    apiKey: pickString(raw.apiKey, DEFAULT_SETTINGS.engineConfig.apiKey),
    baseUrl: pickString(raw.baseUrl, DEFAULT_SETTINGS.engineConfig.baseUrl),
    model: pickString(raw.model, DEFAULT_SETTINGS.engineConfig.model),
  };
}

/**
 * 把任意来源的对象合并成完整设置。
 * 逐字段校验而不是整体替换，这样新版字段可以在老数据上补齐，
 * 单个字段损坏也不会让整个设置页崩掉。
 */
export function mergeSettings(raw: unknown): Settings {
  const input = (raw ?? {}) as Partial<Settings>;
  return {
    version: DEFAULT_SETTINGS.version,
    engineId: pickString(input.engineId, DEFAULT_SETTINGS.engineId),
    engineConfig: pickEngineConfig(input.engineConfig),
    targetLang: pickString(input.targetLang, DEFAULT_SETTINGS.targetLang),
    sourceLang: pickString(input.sourceLang, DEFAULT_SETTINGS.sourceLang),
    displayMode: input.displayMode === 'replace' ? 'replace' : 'bilingual',
    hoverTranslate: pickBoolean(input.hoverTranslate, DEFAULT_SETTINGS.hoverTranslate),
    selectionTranslate: pickBoolean(input.selectionTranslate, DEFAULT_SETTINGS.selectionTranslate),
    autoTranslateDelay: clampInt(input.autoTranslateDelay, DEFAULT_SETTINGS.autoTranslateDelay, 0, 60),
    concurrency: clampInt(input.concurrency, DEFAULT_SETTINGS.concurrency, 1, 8),
    maxBatchChars: clampInt(input.maxBatchChars, DEFAULT_SETTINGS.maxBatchChars, 200, 8000),
    maxSegmentsPerBatch: clampInt(input.maxSegmentsPerBatch, DEFAULT_SETTINGS.maxSegmentsPerBatch, 1, 50),
    cacheMaxEntries: clampInt(input.cacheMaxEntries, DEFAULT_SETTINGS.cacheMaxEntries, 100, 50000),
    siteRules: pickSiteRules(input.siteRules),
    glossary: pickGlossary(input.glossary),
    systemPrompt: pickString(input.systemPrompt, DEFAULT_SETTINGS.systemPrompt),
  };
}

let sharedArea: StorageArea | null = null;

function resolveArea(area?: StorageArea): StorageArea {
  if (area) return area;
  if (!sharedArea) sharedArea = chromeArea(chrome.storage.local);
  return sharedArea;
}

export async function loadSettings(area?: StorageArea): Promise<Settings> {
  const target = resolveArea(area);
  const raw = await target.get([SETTINGS_KEY]);
  return mergeSettings(raw[SETTINGS_KEY]);
}

export async function saveSettings(settings: Settings, area?: StorageArea): Promise<void> {
  const target = resolveArea(area);
  await target.set({ [SETTINGS_KEY]: mergeSettings(settings) });
}
```

- [ ] **Step 4: 写实现 `src/shared/chrome-area.ts`**

```ts
// src/shared/chrome-area.ts
import type { StorageArea } from '../core/cache';

/** 把 chrome.storage 的 StorageArea 适配成本项目可测试的 StorageArea。 */
export function chromeArea(area: chrome.storage.StorageArea): StorageArea {
  return {
    get: (keys) => area.get(keys) as Promise<Record<string, unknown>>,
    set: (items) => area.set(items) as Promise<void>,
    remove: (keys) => area.remove(keys) as Promise<void>,
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/shared/settings.test.ts`

Expected: PASS，全部用例通过。

- [ ] **Step 6: 运行类型检查**

Run: `npm run typecheck`

Expected: 退出码 0。若报 `chrome` 未定义，确认 `tsconfig.json` 的 `types` 含 `"chrome"` 且已安装 `@types/chrome`。

- [ ] **Step 7: 提交**

```bash
git add src/shared/settings.ts src/shared/chrome-area.ts tests/shared/settings.test.ts
git commit -m "feat(shared): 设置 schema、默认值合并与读写"
```

---

## Task 12: `shared/messages.ts` — 消息协议

**Files:**
- Create: `src/shared/messages.ts`
- Test: `tests/shared/messages.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/shared/messages.test.ts
import { describe, expect, it } from 'vitest';
import { MSG, isTranslateTextsMessage, type TranslateTextsMessage } from '../../src/shared/messages';

describe('MSG', () => {
  it('消息类型常量取值唯一', () => {
    const values = Object.values(MSG);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('isTranslateTextsMessage', () => {
  it('识别合法的翻译请求', () => {
    const message: TranslateTextsMessage = {
      type: MSG.TRANSLATE_TEXTS,
      payload: { items: [{ id: 'jy-1', text: 'Hello' }] },
    };
    expect(isTranslateTextsMessage(message)).toBe(true);
  });

  it('拒绝 payload 缺失的消息', () => {
    expect(isTranslateTextsMessage({ type: MSG.TRANSLATE_TEXTS })).toBe(false);
  });

  it('拒绝 items 不是数组的消息', () => {
    expect(isTranslateTextsMessage({ type: MSG.TRANSLATE_TEXTS, payload: { items: 'x' } })).toBe(false);
  });

  it('拒绝元素结构不对的消息', () => {
    expect(
      isTranslateTextsMessage({ type: MSG.TRANSLATE_TEXTS, payload: { items: [{ id: 1, text: 2 }] } }),
    ).toBe(false);
  });

  it('拒绝其它类型的消息', () => {
    expect(isTranslateTextsMessage({ type: MSG.GET_PAGE_STATE })).toBe(false);
    expect(isTranslateTextsMessage(null)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/shared/messages.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/shared/messages.ts
import type { EngineErrorCode } from '../engines/types';

export const MSG = {
  /** 内容脚本 → SW：请求翻译一批文本 */
  TRANSLATE_TEXTS: 'jinyi:translate-texts',
  /** 弹窗/快捷键 → 内容脚本：翻译或还原（由内容脚本按当前状态决定） */
  TOGGLE_PAGE: 'jinyi:toggle-page',
  /** 弹窗 → 内容脚本：明确要求翻译 */
  TRANSLATE_PAGE: 'jinyi:translate-page',
  /** 弹窗 → 内容脚本：明确要求还原 */
  RESTORE_PAGE: 'jinyi:restore-page',
  /** 弹窗 → 内容脚本：查询当前页面翻译状态 */
  GET_PAGE_STATE: 'jinyi:get-page-state',
  /** 右键菜单 → 内容脚本：翻译选中文本 */
  TRANSLATE_SELECTION: 'jinyi:translate-selection',
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

export interface TranslateItem {
  id: string;
  text: string;
}

export interface TranslateItemResult {
  id: string;
  text: string | null;
  code?: EngineErrorCode;
  message?: string;
}

export interface TranslateTextsMessage {
  type: typeof MSG.TRANSLATE_TEXTS;
  payload: {
    items: TranslateItem[];
    targetLang?: string;
  };
}

export type TranslateTextsResponse =
  | { ok: true; results: TranslateItemResult[] }
  | { ok: false; code: EngineErrorCode; message: string };

export interface PageState {
  translated: boolean;
  mode: 'bilingual' | 'replace';
  total: number;
  done: number;
  failed: number;
}

/** 跨进程边界的消息必须在运行时校验，不能只信 TypeScript 类型。 */
export function isTranslateTextsMessage(value: unknown): value is TranslateTextsMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<TranslateTextsMessage>;
  if (message.type !== MSG.TRANSLATE_TEXTS) return false;
  if (!message.payload || typeof message.payload !== 'object') return false;
  const items = (message.payload as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.every(
    (item) =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as TranslateItem).id === 'string' &&
      typeof (item as TranslateItem).text === 'string',
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/shared/messages.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/shared/messages.ts tests/shared/messages.test.ts
git commit -m "feat(shared): 类型化消息协议与运行时校验"
```

---
