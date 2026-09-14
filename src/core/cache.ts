// src/core/cache.ts

/** 扩展存储区的可测试子集（与宿主存储 API 的结构保持一致）。 */
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
