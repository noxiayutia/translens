// src/core/cache.ts

/**
 * 扩展存储区的可测试子集（与宿主存储 API 的结构保持一致）。
 *
 * `keys()` 是缓存自愈的前提：只有能枚举出真实存在的 key，才能拿真实条目去校正近似
 * 的计数、清掉形状坏掉的残留（见 `TranslationCache.prune`），也才可能在外部把存储
 * 改坏之后恢复。
 */
export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  /** 列出本存储区里全部 key（宿主侧即"取全部再取键名"）。 */
  keys(): Promise<string[]>;
}

/** 条目键：`jt:<hash>` -> `{ v: 译文, t: 最后写入/命中时间 }`。 */
const ENTRY_PREFIX = 'jt:';
/** 唯一的元数据键：`{ n: 近似条目数 }`。值只有一个数字，不构成"单条超限"的风险。 */
const META_KEY = 'jt:meta';

/** 命中后按此间隔刷新一次条目的 `t`；间隔内的重复命中不再写存储。 */
const REFRESH_INTERVAL_MS = 5000;

/** 存储写失败（多半是配额满）时，按这个比例强制淘汰最旧的条目来腾空间。 */
const QUOTA_EVICT_RATIO = 0.1;

interface CacheEntry {
  v: string;
  t: number;
}

interface CacheMeta {
  n: number;
}

/**
 * 按存储区隔离的单调戳。`Date.now()` 在同一毫秒内的多次写入会拿到相同的 `t`，淘汰排序
 * 就不确定了（排序退化成存储的枚举顺序）；这里保证后写入/刷新的 `t` 一定大于先前的。
 *
 * 戳记挂在存储区上而不是模块上：模块级状态会让两个互不相干的存储区互相推高时钟，
 * 一个注入了"未来时间"的测试会永久污染后续所有按真实时钟写入的条目。
 */
const stamps = new WeakMap<StorageArea, number>();

function nextStamp(area: StorageArea, now: () => number): number {
  const previous = stamps.get(area) ?? 0;
  const t = now();
  const stamp = t > previous ? t : previous + 1;
  stamps.set(area, stamp);
  return stamp;
}

/** 只认能读出译文的记录；时间戳缺失或坏掉不丢译文，当作最旧的一条。 */
function readEntry(value: unknown): CacheEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { v, t } = value as Partial<CacheEntry>;
  if (typeof v !== 'string') return undefined;
  return { v, t: typeof t === 'number' && Number.isFinite(t) ? t : -Infinity };
}

/** 淘汰排序用的时间戳；读不出条目（被外部改坏）就用 `-Infinity`，让它优先出局。 */
function readStamp(value: unknown): number {
  return readEntry(value)?.t ?? -Infinity;
}

/**
 * 每条译文独立存一个 key：`jt:<hash>` -> `{ v, t }`，另有一个可选的元数据键
 * `jt:meta` -> `{ n }`。淘汰靠按需全量扫描，**没有单独的索引键**。
 *
 * 索引里存的东西（hash + t）与每个条目里的 `t` 完全重复，却把"写一条"放大成"重写
 * 整个索引"，还要求索引与条目双写一致——孤儿条目、幽灵条目、索引损坏后的自愈都由
 * 此而来。顺序信息现在就在条目自己身上，扫描时现算。
 *
 * 三条必须成立的前提（都影响正确性，不只是性能）：
 *
 * 1. **一个 `StorageArea` 只能有一个实例在用**。`maxEntries` 是实例属性，而条目是
 *    存储区级的；同一个存储区上挂了两个不同上限的实例，较小的那个会不断剪掉较大的
 *    那个刚写进去的条目。
 * 2. **缓存的读-改-写都串行执行**。计数与淘汰都是读-改-写，存储区本身不提供比较并
 *    交换，两个并发的 `putMany` 会互相覆盖计数、留下来不及淘汰的条目。这里用
 *    `queue`（按存储区对象共享）串行化，任何直接调用 `area.set`/`area.remove`
 *    绕过队列的写法都会重新引入该缺陷。
 * 3. **写缓存失败不得让调用方失败**。存储写是本模块的职责，不是调用方的：
 *    `putMany` 不抛错，写不进去只意味着这次没缓存上。反过来，调用方（翻译批次）
 *    也不该把缓存写失败当成翻译失败上报。计数因此允许漂移——它只决定"什么时候扫描
 *    淘汰"，`count()` 走真实扫描，`prune()` 负责把计数校正回来。
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

  /** 存储区里全部条目键（`jt:meta` 是元数据，不是条目）。 */
  private async entryKeys(): Promise<string[]> {
    return (await this.area.keys()).filter((key) => key.startsWith(ENTRY_PREFIX) && key !== META_KEY);
  }

  /** 上限随设置变化时调用；实际裁剪发生在下一次写入或 `prune()`。 */
  setMaxEntries(maxEntries: number): void {
    this.maxEntries = maxEntries;
  }

  async getMany(hashes: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (hashes.length === 0) return out;

    const entries = await this.readEntries(hashes);
    for (const [hash, entry] of entries) out.set(hash, entry.v);

    // 命中即刷新"最后命中时间"，否则淘汰退化成写入顺序（FIFO），热门段落会先于冷门
    // 段落被淘汰。刷新写是在写入队列里落盘的，所以刷新本身不会与 putMany / 淘汰并发。
    //
    // 已知窗口：读发生在进队列之前，"读到命中 → 该条目被并发淘汰 → 刷新把它写回"这条
    // 交错是可达的，表现为条目数短暂超过上限、刚淘汰的那条又活过来。影响有界：下一次
    // 写入触发扫描时就会收敛，且译文内容仍然正确（同一 hash 的译文是内容派生的）。
    // 把读也塞进队列能关掉这个窗口，代价是每次缓存读都要排在一次待写批次后面。
    if (entries.size > 0) await this.queue(() => this.refresh(entries));
    return out;
  }

  /**
   * 只重写命中的那几条里 `t` 已经旧了的，刷新它们的最后命中时间。
   *
   * 刚刷新过的条目 `t` 已经变新，这里自然不会再写——不需要额外的内存节流表。
   * 写回的是读到的整条条目（含 `v`），不像旧索引那样只写 `hash + t`：若一次并发的
   * `putMany` 正好插在读与刷新之间写了同一个 hash，这次刷新会把 `v` 覆盖回旧值。
   * 同一 hash 的译文是内容派生的、两次写入理应相同，换来的是命中热路径上少一次读取。
   */
  private async refresh(entries: Map<string, CacheEntry>): Promise<void> {
    const now = this.now();
    const batch: Record<string, unknown> = {};
    let touched = 0;
    for (const [hash, entry] of entries) {
      if (now - entry.t < REFRESH_INTERVAL_MS) continue;
      batch[this.entryKey(hash)] = { v: entry.v, t: nextStamp(this.area, this.now) } satisfies CacheEntry;
      touched += 1;
    }
    if (touched === 0) return;
    await this.area.set(batch);
  }

  async putMany(items: Map<string, string>): Promise<void> {
    if (items.size === 0) return;
    await this.queue(async () => {
      const batch: Record<string, unknown> = {};
      for (const [hash, value] of items) {
        batch[this.entryKey(hash)] = { v: value, t: nextStamp(this.area, this.now) } satisfies CacheEntry;
      }

      try {
        await this.area.set(batch);
      } catch {
        // 写不进去只意味着这次没缓存上，不抛给调用方；写失败最常见的成因是存储满了，
        // 顺手按比例淘汰腾地方——注意此时条目数往往还没到上限，靠 `overflow` 是腾不出
        // 任何空间的，新条目会永久写不进去。
        await this.scanAndEvict(QUOTA_EVICT_RATIO);
        return;
      }

      // 计数只增不减地记一个近似值；它写不进去也只影响扫描时机：`count()` 走真实
      // 扫描，`prune()` 会把计数校正回来，条目本身已经落盘、读得出来。
      const count = (await this.readMeta()) + items.size;
      await this.writeMeta(count);
      if (count > this.maxEntries) await this.scanAndEvict();
    });
  }

  /**
   * 全量对账：删掉形状坏掉的条目（连译文都读不出来的记录），把近似计数校正为真实
   * 条目数，再按上限裁剪。存储被外部改坏、或计数漂移之后，这是唯一的自愈入口
   * （service worker 启动时调用一次即可）。
   */
  async prune(): Promise<void> {
    await this.queue(async () => {
      const keys = await this.entryKeys();
      if (keys.length > 0) {
        const raw = await this.area.get(keys);
        const broken = keys.filter((key) => readEntry(raw[key]) === undefined);
        if (broken.length > 0) await this.area.remove(broken);
      }
      await this.scanAndEvict();
    });
  }

  /**
   * 真实扫描出的**精确**条目数（形状坏掉的记录不算条目，它们由 `prune()` 清掉）。
   * 只给设置页用、频率极低，所以可以真的把值读出来核一遍形状。
   */
  async count(): Promise<number> {
    const keys = await this.entryKeys();
    if (keys.length === 0) return 0;
    const raw = await this.area.get(keys);
    return keys.filter((key) => readEntry(raw[key]) !== undefined).length;
  }

  /** 删掉全部 `jt:` 前缀的键：条目、元数据，以及旧版本可能留下的别的 `jt:` 键。 */
  async clear(): Promise<void> {
    await this.queue(async () => {
      const keys = (await this.area.keys()).filter((key) => key.startsWith(ENTRY_PREFIX));
      if (keys.length > 0) await this.area.remove(keys);
    });
  }

  /**
   * 全量扫描 → 按 `t` 从小到大裁剪超限条目 → 把计数校正为真实值。
   *
   * `forceEvictRatio > 0` 用于"存储已经写满、但条目数还没到上限"的场景：此时按上限算
   * 没有任何溢出，一条都不删的话新条目永远写不进去，缓存会永久停摆。所以写失败时按比例
   * 多腾一些名额（至少一条），避免每写一条就再扫描一次。
   */
  private async scanAndEvict(forceEvictRatio = 0): Promise<void> {
    const keys = await this.entryKeys();
    if (keys.length === 0) {
      await this.writeMeta(0);
      return;
    }
    const raw = await this.area.get(keys);
    const sorted = keys
      .map((key) => ({ key, t: readStamp(raw[key]) }))
      .sort((a, b) => a.t - b.t);
    const overflow = sorted.length - this.maxEntries;
    const forced = forceEvictRatio > 0 ? Math.max(1, Math.floor(sorted.length * forceEvictRatio)) : 0;
    const target = Math.min(Math.max(overflow, forced), sorted.length);
    if (target > 0) await this.area.remove(sorted.slice(0, target).map((item) => item.key));
    await this.writeMeta(Math.min(sorted.length - target, Math.max(0, this.maxEntries)));
  }

  private async readEntries(hashes: string[]): Promise<Map<string, CacheEntry>> {
    const out = new Map<string, CacheEntry>();
    if (hashes.length === 0) return out;
    const keys = hashes.map((hash) => this.entryKey(hash));
    const raw = await this.area.get(keys);
    hashes.forEach((hash, index) => {
      // 存储里的内容可能被外部改坏，只认形状正确的条目。
      const entry = readEntry(raw[keys[index]]);
      if (entry) out.set(hash, entry);
    });
    return out;
  }

  /**
   * 近似条目数；计数键缺失或被改坏都当作 0——它只影响"什么时候扫描淘汰"，
   * 不影响任何正确性。
   */
  private async readMeta(): Promise<number> {
    const raw = await this.area.get([META_KEY]);
    const meta = raw[META_KEY] as Partial<CacheMeta> | undefined;
    if (!meta || typeof meta !== 'object') return 0;
    const n = meta.n;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  }

  private async writeMeta(n: number): Promise<void> {
    await this.area.set({ [META_KEY]: { n } satisfies CacheMeta });
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
