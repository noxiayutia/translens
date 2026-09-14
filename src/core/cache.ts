// src/core/cache.ts

/**
 * 扩展存储区的可测试子集（与宿主存储 API 的结构保持一致）。
 *
 * `keys()` 是缓存自愈的前提：只有能枚举出真实存在的 key，才能把派生索引
 * 与真实数据对账（见 `TranslationCache.prune`），也才可能在索引损坏后恢复。
 */
export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  /** 列出本存储区里全部 key（宿主侧即"取全部再取键名"）。 */
  keys(): Promise<string[]>;
}

const ENTRY_PREFIX = 'jt:';
const INDEX_KEY = 'jt:index';

/** 同一存储区上所有队列按此间隔刷新一次命中时间，避免每次命中都写索引。 */
const REFRESH_INTERVAL_MS = 5000;

interface CacheEntry {
  v: string;
  t: number;
}

interface IndexEntry {
  hash: string;
  /** 最后命中时间（读命中或写入），淘汰按它从小到大进行。 */
  t: number;
}

/**
 * 每条译文独立存一个 key，另用一个索引 key 维护 LRU 顺序。
 * 这样淘汰时只需 remove 指定 key，不必整块重写。
 *
 * 三条必须成立的前提（都影响正确性，不只是性能）：
 *
 * 1. **一个 `StorageArea` 只能有一个实例在用**。`maxEntries` 是实例属性，而索引是
 *    存储区级的；同一个存储区上挂了两个不同上限的实例，较小的那个会不断剪掉较大的
 *    那个刚写进去的条目。
 * 2. **索引的所有改动都串行执行**。索引是读-改-写，存储区本身不提供比较并交换，
 *    两个并发的 `putMany` 会互相覆盖索引、留下永远淘汰不掉的孤儿条目。这里用
 *    `queue`（按存储区对象共享）串行化，任何直接调用 `area.set`/`area.remove`
 *    绕过队列的写法都会重新引入该缺陷。
 * 3. **写缓存失败不得让调用方失败**。存储写是本模块的职责，不是调用方的：
 *    `putMany` 不抛错，写不进去只意味着这次没缓存上。反过来，调用方（翻译批次）
 *    也不该把缓存写失败当成翻译失败上报。写失败只会留下"有条目、没索引"的孤儿，
 *    读时命中但 `count()` 暂时少算，`prune()` 会把它收编回索引。
 */
export class TranslationCache {
  constructor(
    private readonly area: StorageArea,
    private maxEntries = 5000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private entryKey(hash: string): string {
    return ENTRY_PREFIX + hash;
  }

  /** 上限随设置变化时调用；实际裁剪发生在下一次写入或 `prune()`。 */
  setMaxEntries(maxEntries: number): void {
    this.maxEntries = maxEntries;
  }

  async getMany(hashes: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (hashes.length === 0) return out;

    const entries = await this.readEntries(hashes);
    for (const [hash, value] of entries) out.set(hash, value);

    // 命中即刷新"最后命中时间"，否则淘汰退化成写入顺序（FIFO），热门段落会先于冷门
    // 段落被淘汰。刷新与写入共用同一个队列并且**在返回前落盘**：否则"读到命中"和
    // "被淘汰"之间会插进一次并发写入，刚命中的条目照样可能被删掉。
    if (entries.size > 0) await this.queue(() => this.refresh(entries));
    return out;
  }

  /** 刷新命中条目的"最后命中时间"并移到末尾；间隔内的重复命中只算一次。 */
  private async refresh(entries: Map<string, string>): Promise<void> {
    const index = await this.readIndex();
    const now = this.now();
    const stale = new Set<string>();
    for (const item of index) {
      if (entries.has(item.hash) && (item.t > now || now - item.t >= REFRESH_INTERVAL_MS)) stale.add(item.hash);
    }
    if (stale.size === 0) return;

    const kept = index.filter((item) => !stale.has(item.hash));
    const touched = index.filter((item) => stale.has(item.hash)).map((item) => ({ hash: item.hash, t: now }));
    await this.writeIndex([...kept, ...touched]);
  }

  async putMany(items: Map<string, string>): Promise<void> {
    if (items.size === 0) return;
    await this.queue(async () => {
      const batch: Record<string, unknown> = {};
      const hashes: string[] = [];
      for (const [hash, value] of items) {
        batch[this.entryKey(hash)] = { v: value, t: this.now() } satisfies CacheEntry;
        hashes.push(hash);
      }

      try {
        await this.area.set(batch);
      } catch {
        // 条目没写进去就不动索引：索引是真实内容的投影，不能替不存在的条目占位。
        return;
      }
      await this.evict(this.mergeIndex(await this.readIndex(), hashes));
    });
  }

  /**
   * 按存储区里真实存在的条目重建索引：清掉空指针、把漏登记的孤儿收编进来，再按上限裁剪。
   * 索引损坏或并发写失败之后，这是唯一的自愈入口（service worker 启动时调用一次即可）。
   */
  async prune(): Promise<void> {
    await this.queue(async () => {
      const keys = await this.area.keys();
      const actual = new Set<string>();
      for (const key of keys) {
        if (key.startsWith(ENTRY_PREFIX) && key !== INDEX_KEY) actual.add(key.slice(ENTRY_PREFIX.length));
      }
      const index = await this.readIndex();
      // 先按真实条目过滤（去掉空指针、保住原有顺序与命中时间），再收编孤儿。
      const kept = index.filter((item) => actual.has(item.hash));
      await this.evict(this.mergeIndex(kept, actual));
    });
  }

  async count(): Promise<number> {
    return (await this.readIndex()).length;
  }

  /** 索引是实际内容的投影，清空时按索引删除即可；`prune()` 负责兜住索引过期的残留。 */
  async clear(): Promise<void> {
    await this.queue(async () => {
      const keys = await this.area.keys();
      const entryKeys = keys.filter((key) => key.startsWith(ENTRY_PREFIX) && key !== INDEX_KEY);
      if (entryKeys.length > 0) await this.area.remove(entryKeys);
      await this.area.remove([INDEX_KEY]);
    });
  }

  private async readEntries(hashes: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (hashes.length === 0) return out;
    const keys = hashes.map((hash) => this.entryKey(hash));
    const raw = await this.area.get(keys);
    hashes.forEach((hash, index) => {
      const entry = raw[keys[index]] as CacheEntry | undefined;
      // 存储里的内容可能被外部改坏，只认形状正确的条目。
      if (entry && typeof entry === 'object' && typeof entry.v === 'string') out.set(hash, entry.v);
    });
    return out;
  }

  /** 索引本身也可能被改坏，任何非数组/非对象元素一律丢弃而不是整体失效。 */
  private async readIndex(): Promise<IndexEntry[]> {
    const raw = await this.area.get([INDEX_KEY]);
    const stored = raw[INDEX_KEY];
    if (!Array.isArray(stored)) return [];
    const out: IndexEntry[] = [];
    for (const item of stored) {
      if (!item || typeof item !== 'object') continue;
      const { hash, t } = item as Partial<IndexEntry>;
      if (typeof hash !== 'string' || typeof t !== 'number' || !Number.isFinite(t)) continue;
      out.push({ hash, t });
    }
    return out;
  }

  private async writeIndex(index: IndexEntry[]): Promise<void> {
    await this.area.set({ [INDEX_KEY]: index });
  }

  /** 合并"已有顺序 + 新出现的 hash"：重写不重复占位，新条目追加到最热一端。 */
  private mergeIndex(existing: IndexEntry[], hashes: Iterable<string>): IndexEntry[] {
    const now = this.now();
    const fresh = new Set(hashes);
    const merged: IndexEntry[] = [];
    for (const item of existing) {
      if (!fresh.has(item.hash)) merged.push(item);
      else merged.push({ hash: item.hash, t: now });
    }
    const known = new Set(merged.map((item) => item.hash));
    for (const hash of fresh) if (!known.has(hash)) merged.push({ hash, t: now });
    return merged;
  }

  /** 从最旧一端裁剪并删除超出上限的条目；整批超过上限时保留最新写入的那几条。 */
  private async evict(index: IndexEntry[]): Promise<void> {
    const overflow = index.length - this.maxEntries;
    const kept = overflow > 0 ? index.slice(overflow) : index;
    const removed = overflow > 0 ? index.slice(0, overflow) : [];
    for (const item of removed) await this.area.remove([this.entryKey(item.hash)]);
    await this.writeIndex(kept);
  }

  /** 把任务挂到该存储区的串行队列上，返回它的结果；失败不打断队列、也不抛给调用方。 */
  private queue<T>(task: () => Promise<T>): Promise<T | undefined> {
    const tail = queues.get(this.area) ?? Promise.resolve();
    const next = tail.then(task).catch(() => undefined);
    queues.set(this.area, next);
    return next;
  }
}

/**
 * 按存储区对象共享的串行队列（WeakMap 不阻止存储区被回收）。
 * 放在模块作用域而不是实例上：`TieredCache` 的调用方通常每条消息新建一次缓存实例，
 * 实例级队列挡不住并发，只有同一存储区共享同一个队列才行。
 */
const queues = new WeakMap<StorageArea, Promise<unknown>>();

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
    // 两层各自尽力而为，互不阻塞：会话层写失败不该连带丢掉持久层的那份。
    await Promise.all([this.session.putMany(items), this.persistent.putMany(items)]);
  }
}
