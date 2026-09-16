## Task 10: `core/cache.ts` — 两级翻译缓存

**Files:**
- Create: `src/core/cache.ts`
- Create: `tests/helpers/memory-storage.ts`
- Test: `tests/core/cache.test.ts`

- [ ] **Step 1: 写内存存储测试替身**

```ts
// tests/helpers/memory-storage.ts
import type { StorageArea } from '../../src/core/cache';

/** 两种宿主配额的模拟开关，都按"`JSON.stringify` 后的 UTF-8 字节数"计量。 */
export interface MemoryStorageOptions {
  /**
   * 模拟宿主对**单个存储值**的上限（`QUOTA_BYTES_PER_ITEM`）：
   * 任一条值的字节数超过它，整批写入失败并抛错。
   */
  maxItemBytes?: number;
  /** 模拟存储区**总量**上限（`QUOTA_BYTES`）：写入后总量超过它，整批写入失败并抛错。 */
  maxTotalBytes?: number;
}

/** 与宿主一致的字节口径：值先 JSON 序列化，再按 UTF-8 计长。 */
function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
}

export class MemoryStorage implements StorageArea {
  private readonly data = new Map<string, unknown>();
  /** 每个 key 当前占用的字节数，用来在总量上限下即时算出写入后的占用。 */
  private readonly bytes = new Map<string, number>();
  /** 单条值上限；可随时调整 */
  maxItemBytes?: number;
  /** 总量上限；可随时调整——写满之后再调成当前占用，就能模拟"配额刚好用尽" */
  maxTotalBytes?: number;
  /** 记录写入**尝试**次数（含被配额拒绝的），用于断言缓存命中时没有多余写入 */
  setCalls = 0;
  /** 记录被配额拒绝的写入次数，用来断言"写失败"确实发生过 */
  rejectedWrites = 0;
  /** 历次成功写入里最大的单条值字节数，用来断言从没写出过大值 */
  maxItemBytesSeen = 0;

  constructor(options: MemoryStorageOptions = {}) {
    this.maxItemBytes = options.maxItemBytes;
    this.maxTotalBytes = options.maxTotalBytes;
  }

  async get(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (this.data.has(key)) out[key] = structuredClone(this.data.get(key));
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.setCalls += 1;
    const entries = Object.entries(items);

    // 先把"写完之后"的占用算出来，任何一条越界都整批不落盘（宿主也是整批失败）。
    const next = new Map(this.bytes);
    for (const [key, value] of entries) {
      const size = byteLength(value);
      if (this.maxItemBytes !== undefined && size > this.maxItemBytes) {
        this.rejectedWrites += 1;
        throw new Error(`单个存储值超出上限：${key} 需要 ${size} 字节`);
      }
      next.set(key, size);
    }
    if (this.maxTotalBytes !== undefined) {
      let total = 0;
      for (const size of next.values()) total += size;
      if (total > this.maxTotalBytes) {
        this.rejectedWrites += 1;
        throw new Error(`存储区总量超出上限：需要 ${total} 字节`);
      }
    }

    for (const [key, value] of entries) {
      const size = next.get(key) as number;
      this.maxItemBytesSeen = Math.max(this.maxItemBytesSeen, size);
      this.data.set(key, structuredClone(value));
      this.bytes.set(key, size);
    }
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.data.delete(key);
      this.bytes.delete(key);
    }
  }

  async keys(): Promise<string[]> {
    return [...this.data.keys()];
  }

  size(): number {
    return this.data.size;
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  /** 当前占用的总字节数 */
  bytesUsed(): number {
    let total = 0;
    for (const size of this.bytes.values()) total += size;
    return total;
  }
}
```

- [ ] **Step 2: 写失败的测试**

```ts
// tests/core/cache.test.ts
import { describe, expect, it } from 'vitest';
import { TieredCache, TranslationCache } from '../../src/core/cache';
import { MemoryStorage } from '../helpers/memory-storage';

/** 数 `keys()`（= 全量扫描的入口）被调了多少次。 */
class ScanningStorage extends MemoryStorage {
  keyScans = 0;

  override async keys(): Promise<string[]> {
    this.keyScans += 1;
    return super.keys();
  }
}

/** 让指定序号的存储写失败，用来验证缓存写失败不会冒泡给调用方。 */
class FailingStorage extends MemoryStorage {
  writeAttempts = 0;

  constructor(private readonly failWrites: number[]) {
    super();
  }

  override async set(items: Record<string, unknown>): Promise<void> {
    const attempt = this.writeAttempts;
    this.writeAttempts += 1;
    if (this.failWrites.includes(attempt)) throw new Error('QUOTA_BYTES 超出配额');
    await super.set(items);
  }
}

/**
 * 可控时钟，用于验证"按最后命中时间淘汰"。
 *
 * 默认从**当前真实时间**起跳，而不是某个小常量：条目的时间戳来自模块级单调戳，
 * 同一个测试文件里前面的用例已经用真实 `Date.now()` 把它推到了 ~1.7e12。注入一个
 * 比它小的时钟会让条目的 `t` 恒大于 `now`，命中就不再触发刷新，LRU 断言会假失败。
 */
function fakeClock(start = Date.now()): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

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

  /**
   * **性能悬崖回归**：打满之后，旧实现在**每一次** `putMany` 都触发 `scanAndEvict`
   * （`keys()` 全量反序列化 + 读全部条目 + 排序 + 删除），且全部排在同一个串行队列上。
   * 一个 3000 段的新页面 = 250 批，就是 250 次 × 5000 条的扫描，批次响应被越堵越长。
   *
   * 修复是给淘汰加**迟滞**：一次多删一些（删到低水位），之后要再攒满一截才触发下一次
   * 扫描。这里断言的是**扫描次数**而不是"删了多少条"——删条数两边都对，悬崖只在扫描。
   */
  it('打满之后扫描是摊还的：每 5 次越限写入摊不到 1 次全量扫描（迟滞窗口）', async () => {
    const storage = new ScanningStorage();
    const cache = new TranslationCache(storage, 100);
    // 先正常灌满。
    for (let i = 0; i < 100; i += 1) {
      await cache.putMany(new Map([[`h${i}`, `v${i}`]]));
    }
    const scansAtFull = storage.keyScans;

    // 再连续写 1000 条越限写入——若"每次超限都全量扫描"，这里会多出 ~1000 次扫描。
    for (let i = 100; i < 1100; i += 1) {
      await cache.putMany(new Map([[`h${i}`, `v${i}`]]));
    }
    const overflowWrites = 1000;
    const scans = storage.keyScans - scansAtFull;

    // 迟滞的界：窗口是上限的 10%（10 条），摊还后约每 11 次写入扫一次；1/5 是宽松界。
    // 旧实现约 1:1（~901 次）→ 这条断言现在就是红的。
    expect(scans).toBeLessThanOrEqual(overflowWrites / 5);
    // 内容仍然正确：读得回来、条数仍受上限约束。
    expect((await cache.getMany(['h1099'])).get('h1099')).toBe('v1099');
    expect(await cache.count()).toBeLessThanOrEqual(100);
  });

  it('迟滞只影响扫描时机，不影响正确性：淘汰仍按最旧、上限照旧执行', async () => {
    const storage = new MemoryStorage();
    const clock = fakeClock();
    const cache = new TranslationCache(storage, 50, clock.now);
    for (let i = 0; i < 50; i += 1) {
      clock.advance(10);
      await cache.putMany(new Map([[`h${i}`, `v${i}`]]));
    }
    // 超限写入：允许短暂留在上限附近，但最终必须被裁回上限之内，且删的是最旧的。
    for (let i = 50; i < 62; i += 1) {
      clock.advance(10);
      await cache.putMany(new Map([[`h${i}`, `v${i}`]]));
    }
    expect(await cache.count()).toBeLessThanOrEqual(50);
    expect((await cache.getMany(['h0'])).size).toBe(0); // 最旧的必须先出局
    expect((await cache.getMany(['h61'])).get('h61')).toBe('v61'); // 最新的必须在
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

  it('并发写入不丢条目，也不留下孤儿', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 100);
    const batches = Array.from({ length: 20 }, (_, i) => new Map([[`h${i}`, `${i}`]]));

    await Promise.all(batches.map((batch) => cache.putMany(batch)));

    expect(await cache.count()).toBe(20);
    expect(storage.size()).toBe(21); // 20 条 + jt:meta
    await cache.clear();
    expect(storage.size()).toBe(0);
  });

  it('并发写入跨不同缓存实例时仍然完整', async () => {
    // 真实接线里每条消息都会新建一次缓存实例，实例级锁挡不住这种并发。
    const storage = new MemoryStorage();
    const first = new TranslationCache(storage, 100);
    const second = new TranslationCache(storage, 100);

    await Promise.all([
      first.putMany(new Map([['a', '1']])),
      second.putMany(new Map([['b', '2']])),
      first.putMany(new Map([['c', '3']])),
    ]);

    expect(await first.count()).toBe(3);
    expect(storage.size()).toBe(4);
  });

  it('单批超过上限时保留刚写入的条目', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 2);
    await cache.putMany(new Map([['a', '1'], ['b', '2'], ['c', '3']]));

    const hit = await cache.getMany(['a', 'b', 'c']);
    expect(hit.has('a')).toBe(false);
    expect(hit.get('b')).toBe('2');
    expect(hit.get('c')).toBe('3');
    expect(await cache.count()).toBe(2);
  });

  it('读命中的条目在淘汰时被保留', async () => {
    const clock = fakeClock();
    const cache = new TranslationCache(new MemoryStorage(), 2, clock.now);
    await cache.putMany(new Map([['a', '1']]));
    clock.advance(60_000);
    await cache.putMany(new Map([['b', '2']]));

    expect((await cache.getMany(['a'])).get('a')).toBe('1');
    clock.advance(60_000);
    await cache.putMany(new Map([['c', '3']]));

    const hit = await cache.getMany(['a', 'b', 'c']);
    expect(hit.has('b')).toBe(false);
    expect(hit.get('a')).toBe('1');
    expect(hit.get('c')).toBe('3');
  });

  it('刷新间隔内重复命中不追加写入', async () => {
    const storage = new MemoryStorage();
    const clock = fakeClock();
    const cache = new TranslationCache(storage, 10, clock.now);
    await cache.putMany(new Map([['a', '1']]));
    const afterWrite = storage.setCalls;

    await cache.getMany(['a']);
    await cache.getMany(['a']);

    expect(storage.setCalls).toBe(afterWrite);
    expect((await cache.getMany(['a'])).get('a')).toBe('1');
  });

  it('读坏掉的条目时忽略它而不是抛错', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage);
    await cache.putMany(new Map([['good', '好']]));
    await storage.set({
      'jt:str': 'a plain string',
      'jt:num': 42,
      'jt:null': null,
      'jt:shape': { v: 123 },
      'jt:empty': {},
    });

    const hit = await cache.getMany(['good', 'str', 'num', 'null', 'shape', 'empty']);
    expect([...hit.keys()]).toEqual(['good']);
    expect(hit.get('good')).toBe('好');
  });

  it('单条存储值很小时缓存依然可用：20 条长译文全部写入且读回', async () => {
    // 宿主对单个存储值有上限（QUOTA_BYTES_PER_ITEM）。若把整个 LRU 索引塞进一个
    // 键里，20 条 32 位 hash 的索引就已经超过 1024 字节：写不进去，count() 归零。
    const storage = new MemoryStorage({ maxItemBytes: 1024 });
    const cache = new TranslationCache(storage, 20);
    const hashes = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(32, '0'));
    const translation = '这是一段足够长的译文，用来让条目本身也有几百字节。'.repeat(8);

    await cache.putMany(new Map(hashes.map((hash) => [hash, translation])));

    expect(storage.rejectedWrites).toBe(0);
    expect(storage.maxItemBytesSeen).toBeLessThanOrEqual(1024);
    expect(await cache.count()).toBe(20);
    const hit = await cache.getMany(hashes);
    expect(hit.size).toBe(20);
    for (const hash of hashes) expect(hit.get(hash)).toBe(translation);
  });

  it('单条上限很小时淘汰也不需要写出大值', async () => {
    const storage = new MemoryStorage({ maxItemBytes: 1024 });
    const cache = new TranslationCache(storage, 20);
    const translation = '另一段够长的译文，用来验证淘汰路径只写计数。'.repeat(8);
    const hashes = Array.from({ length: 25 }, (_, i) => (i + 100).toString(16).padStart(32, '0'));

    for (const hash of hashes) await cache.putMany(new Map([[hash, translation]]));

    expect(storage.rejectedWrites).toBe(0);
    expect(storage.maxItemBytesSeen).toBeLessThanOrEqual(1024);
    // 25 次写入、上限 20、迟滞窗口 2：最后一次扫描裁到低水位 18，随后又写入 1 条 → 19。
    // （旧值 20 是「每次超限都精确裁回上限」的节奏产物；淘汰正确性由上下两组 getMany
    // 断言继续钉住，本用例的重心——淘汰从不写出大值——不受影响。）
    expect(await cache.count()).toBe(19);
    // 每写一条就裁掉最旧的，最后留下的是最后写入的一截（最旧的 5 条已全部出局）。
    expect((await cache.getMany(hashes.slice(0, 5))).size).toBe(0);
    expect((await cache.getMany(hashes.slice(20))).size).toBe(5);
  });

  it('同一毫秒内的连续写入仍按写入顺序淘汰', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 2, () => 1_700_000_000_000);

    await cache.putMany(new Map([['a', '1']]));
    await cache.putMany(new Map([['b', '2']]));
    const first = (await storage.get(['jt:a']))['jt:a'] as { t: number };
    const second = (await storage.get(['jt:b']))['jt:b'] as { t: number };
    // 恒定时钟下两次写入拿到的 now 完全相同，时间戳必须仍然严格递增，
    // 否则淘汰顺序会退化成存储枚举 key 的顺序。
    expect(first.t).toBeLessThan(second.t);

    await cache.putMany(new Map([['c', '3']]));

    expect(storage.has('jt:a')).toBe(false); // 最早写入的那条先出局
    expect(storage.has('jt:b')).toBe(true);
    expect(storage.has('jt:c')).toBe(true);
    expect(await cache.count()).toBe(2);
  });

  it('读命中会刷新时间戳，淘汰的是最久未用而不是最早写入', async () => {
    const storage = new MemoryStorage();
    const clock = fakeClock();
    const cache = new TranslationCache(storage, 3, clock.now);

    await cache.putMany(new Map([['a', '1']]));
    clock.advance(60_000);
    await cache.putMany(new Map([['b', '2']]));
    clock.advance(60_000);
    await cache.putMany(new Map([['c', '3']]));
    clock.advance(60_000);
    expect((await cache.getMany(['a'])).get('a')).toBe('1'); // a 变成最近使用

    clock.advance(60_000);
    await cache.putMany(new Map([['d', '4']]));

    expect(storage.has('jt:b')).toBe(false); // 最久未用
    expect(storage.has('jt:a')).toBe(true);
    expect(storage.has('jt:c')).toBe(true);
    expect(storage.has('jt:d')).toBe(true);
    expect(await cache.count()).toBe(3);
  });

  it('旧版本残留的 jt:index 不影响读取与计数，prune 会清掉它', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 10);
    await cache.putMany(new Map([['a', '1']]));
    await storage.set({ 'jt:index': [{ hash: 'a', t: 1 }] });

    expect((await cache.getMany(['a'])).get('a')).toBe('1');
    expect(await cache.count()).toBe(1); // 读不出译文的残留键不是条目，不虚报

    await cache.prune();
    expect(storage.has('jt:index')).toBe(false);
    expect(await cache.count()).toBe(1);
  });

  it('形状坏掉的条目优先被淘汰，不牵连正常条目', async () => {
    const storage = new MemoryStorage();
    const clock = fakeClock();
    const cache = new TranslationCache(storage, 2, clock.now);
    await cache.putMany(new Map([['a', '1']]));
    clock.advance(60_000);
    await cache.putMany(new Map([['b', '2']]));
    await storage.set({ 'jt:bad': 42 });

    clock.advance(60_000);
    await cache.putMany(new Map([['c', '3']]));

    expect(storage.has('jt:bad')).toBe(false); // t 读不出来 → -Infinity → 第一个出局
    expect(storage.has('jt:a')).toBe(false); // 剩下的溢出按 t 淘汰最旧的
    expect(await cache.count()).toBe(2);
    const hit = await cache.getMany(['a', 'b', 'c']);
    expect([...hit.keys()].sort()).toEqual(['b', 'c']);
  });

  it('外部写入的条目立即参与计数与读取，不需要收编', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 10);
    await cache.putMany(new Map([['a', '1']]));
    await storage.set({ 'jt:orphan': { v: '孤儿', t: 1 } });

    // 条目本身就是唯一真源：外部写进来的记录立刻可见，没有"索引漏登记"这回事。
    expect(await cache.count()).toBe(2);
    const hit = await cache.getMany(['a', 'orphan']);
    expect(hit.get('a')).toBe('1');
    expect(hit.get('orphan')).toBe('孤儿');
  });

  it('prune 按上限淘汰最旧的条目', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 2);
    await cache.putMany(new Map([['a', '1']]));
    await storage.set({
      'jt:a': { v: '1', t: 1 },
      'jt:b': { v: '2', t: 2 },
      'jt:c': { v: '3', t: 3 },
    });

    await cache.prune();

    expect(await cache.count()).toBe(2);
    expect(storage.has('jt:a')).toBe(false); // t 最小
    expect(storage.has('jt:c')).toBe(true);
  });

  it('上限可以在运行时调整', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 10);
    await cache.putMany(new Map([['a', '1'], ['b', '2'], ['c', '3']]));

    cache.setMaxEntries(2);
    expect(await cache.count()).toBe(3);

    await cache.putMany(new Map([['d', '4']]));
    expect(await cache.count()).toBe(2);
    expect(storage.has('jt:a')).toBe(false);
    expect(storage.has('jt:d')).toBe(true);
  });

  it('存储写失败时不抛错，也不虚报条目数', async () => {
    const storage = new FailingStorage([0]);
    const cache = new TranslationCache(storage);

    await expect(cache.putMany(new Map([['a', '1']]))).resolves.toBeUndefined();
    expect((await cache.getMany(['a'])).size).toBe(0);
    expect(await cache.count()).toBe(0);
  });

  it('计数写失败后条目仍可读，prune 把计数校正回来', async () => {
    const storage = new FailingStorage([1]);
    const cache = new TranslationCache(storage, 2);

    // 第 0 次写是条目（成功），第 1 次写是计数（失败）：条目在，计数没记上。
    await expect(cache.putMany(new Map([['a', '1']]))).resolves.toBeUndefined();
    expect((await cache.getMany(['a'])).get('a')).toBe('1');
    expect(await cache.count()).toBe(1);

    await cache.prune();
    await cache.putMany(new Map([['b', '2'], ['c', '3']]));

    // 不校正的话计数从 0 起算、写两条也只到 2，不会触发淘汰，a 会一直留着。
    expect(storage.has('jt:a')).toBe(false);
    expect(await cache.count()).toBe(2);
  });

  it('配额写失败时不抛错，扫描腾出空间后可以重试写入', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 4, () => 1_700_000_000_000);
    const value = 'x'.repeat(60);

    await cache.putMany(new Map([['a', value]]));
    await cache.putMany(new Map([['b', value]]));
    await cache.putMany(new Map([['c', value]]));
    // 存储区此刻刚好装满：再多一条都放不下。
    storage.maxTotalBytes = storage.bytesUsed();
    // 上限调到 2；裁剪要等下一次写入，此刻是"超限未裁剪 + 配额已满"的状态。
    cache.setMaxEntries(2);

    await expect(cache.putMany(new Map([['d', value]]))).resolves.toBeUndefined();
    expect(storage.rejectedWrites).toBe(1); // 确实是被配额挡回来的
    expect(storage.has('jt:d')).toBe(false);
    expect(storage.has('jt:a')).toBe(false); // 写失败后的扫描把最旧的清掉了

    await cache.putMany(new Map([['d', value]])); // 腾出空间后重试成功
    expect((await cache.getMany(['d'])).get('d')).toBe(value);
    expect(await cache.count()).toBe(2);
    expect(storage.has('jt:b')).toBe(false);
    expect(storage.has('jt:c')).toBe(true);
  });

  it('存储写满但条目数还没到上限时，写失败仍要强制腾空间，否则缓存永久停摆', async () => {
    const storage = new MemoryStorage();
    // 上限 100 远大于实际条数：按上限算没有任何溢出，靠 overflow 一条也淘汰不掉。
    const cache = new TranslationCache(storage, 100, () => 1_700_000_000_000);
    const value = 'x'.repeat(60);

    for (const hash of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
      await cache.putMany(new Map([[hash, value]]));
    }
    expect(await cache.count()).toBe(10);

    // 存储区此刻刚好装满。
    storage.maxTotalBytes = storage.bytesUsed();

    await expect(cache.putMany(new Map([['k', value]]))).resolves.toBeUndefined();
    expect(storage.rejectedWrites).toBe(1); // 确实被配额挡回来过一次
    expect(storage.has('jt:a')).toBe(false); // 强制淘汰了最旧的，而不是一条不删

    await cache.putMany(new Map([['k', value]])); // 腾出空间后写入成功
    expect((await cache.getMany(['k'])).get('k')).toBe(value);
  });

  it('prune 清掉形状坏掉的条目并给出正确计数', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 10);
    await cache.putMany(new Map([['a', '1']]));
    await storage.set({ 'jt:broken': 'not-an-entry' });

    expect((await cache.getMany(['a'])).get('a')).toBe('1');
    expect(await cache.count()).toBe(1); // 坏记录不是条目

    await cache.prune();

    expect(storage.has('jt:broken')).toBe(false);
    expect(storage.size()).toBe(2); // jt:a + jt:meta
    expect(await cache.count()).toBe(1);
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

  it('持久层命中时回填会话层（会话层计数随之增加）', async () => {
    const sessionStorage = new MemoryStorage();
    const session = new TranslationCache(sessionStorage);
    const local = new TranslationCache(new MemoryStorage());
    await local.putMany(new Map([['a', '1']]));

    const tiered = new TieredCache(session, local);
    const hit = await tiered.getMany(['a']);
    expect(hit.get('a')).toBe('1');
    expect((await session.getMany(['a'])).get('a')).toBe('1');
    // 只断言条目能读回是不够的：count() 走真实扫描，必须认它，否则设置页显示的
    // 条目数与淘汰的判断都会失真。
    expect(await session.count()).toBe(1);
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

/**
 * 淘汰迟滞窗口：按上限的这个比例**一次多删一些**（超出时删到 `maxEntries * (1 - 0.1)`）。
 *
 * 没有它会有性能悬崖：`putMany` 里近似计数一超过上限就调 `scanAndEvict`，而若一次只裁掉
 * 溢出的那几条，计数立刻又贴回上限——之后**每一次**写入都触发一次全量扫描（`keys()` 是
 * 整区反序列化，还要读全部条目 + 排序 + 删除）。打满 5000 条后翻一个 3000 段的新页面
 * （250 批）就是 250 次全量扫描，而且全部串在同一个写入队列上，把批次响应越堵越长。
 *
 * 有了 10% 的窗口，一次扫描腾出的余量要再写满 `maxEntries * 0.1` 条才会触发下一次：
 * 扫描频率从"每次写入一次"降到摊还每 ~11 条一次（默认上限 5000 ≈ 每 500 条）。
 * 窗口按比例取整：上限小于 10 时窗口为 0，行为退回"裁到上限"——小上限多出现在测试里，
 * 那里精确淘汰语义比摊还更重要（见 cache.test.ts 的上限 2/3 用例）。
 */
const EVICT_HYSTERESIS_RATIO = 0.1;

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
      // 迟滞（见 `EVICT_HYSTERESIS_RATIO`）：这条路径上的扫描要一次删到低水位，否则
      // 打满之后每一次 putMany 都全量扫一遍，几百批一起排在串行队列上堵死响应。
      if (count > this.maxEntries) await this.scanAndEvict(0, true);
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
   *
   * `withHysteresis` 只给 `putMany` 的超限路径用（见 `EVICT_HYSTERESIS_RATIO` 的理由）。
   * `prune()` 不带迟滞是刻意的：对账的语义是"收敛到真实值并按上限裁齐"，一次多删
   * 一成用户缓存需要"写入压力"这样的触发理由，冷启动对账给不出这个理由。
   */
  private async scanAndEvict(forceEvictRatio = 0, withHysteresis = false): Promise<void> {
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
    const hysteresis = withHysteresis && overflow > 0 ? Math.floor(this.maxEntries * EVICT_HYSTERESIS_RATIO) : 0;
    const target = Math.min(Math.max(overflow + hysteresis, forced), sorted.length);
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
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/core/cache.test.ts`

Expected: PASS，全部用例通过。

- [ ] **Step 6: 提交**

```bash
git add src/core/cache.ts tests/helpers/memory-storage.ts tests/core/cache.test.ts
git commit -m "feat(core): 两级翻译缓存、LRU 淘汰与索引对账"
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
import {
  CURRENT_VERSION,
  DEFAULT_SETTINGS,
  LEGACY_PROFILE_ID,
  PROVIDER_PRESETS,
  SETTINGS_KEY,
  createProfileId,
  isAllowedBaseUrl,
  loadSettings,
  loadUiSettings,
  mergeSettings,
  resolveEngine,
  saveSettings,
  type EngineProfile,
} from '../../src/shared/settings';
import { MemoryStorage } from '../helpers/memory-storage';

/** 构造一份形状完整合法的档案；`over` 覆盖单个字段，用例只写自己在意的那部分。 */
function profile(over: Partial<EngineProfile> = {}): EngineProfile {
  return {
    id: 'p1',
    label: '我的 DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: 'sk-keep',
    ...over,
  };
}

describe('mergeSettings', () => {
  it('空对象得到完整默认值', () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.engineId).toBe('google');
    expect(DEFAULT_SETTINGS.profiles).toEqual([]);
  });

  it('保留用户已设置的值', () => {
    const merged = mergeSettings({ targetLang: 'ja', engineId: 'openai-compat' });
    expect(merged.targetLang).toBe('ja');
    expect(merged.engineId).toBe('openai-compat');
  });

  it('补齐缺失字段', () => {
    const merged = mergeSettings({ targetLang: 'ja' });
    expect(merged.displayMode).toBe(DEFAULT_SETTINGS.displayMode);
    expect(merged.profiles).toEqual([]);
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

  it('对任意非对象输入都不抛错', () => {
    for (const raw of [null, undefined, 42, 'x', true, [], [1, 2], () => 1, Symbol('s')]) {
      expect(() => mergeSettings(raw)).not.toThrow();
      expect(mergeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
  });

  describe('profiles 的反序列化边界（逐条归一化，脏条目丢掉而不是崩）', () => {
    it('非数组一律当没有档案', () => {
      for (const raw of [null, undefined, 'x', 42, {}]) {
        expect(mergeSettings({ profiles: raw as unknown as EngineProfile[] }).profiles).toEqual([]);
      }
    });

    it('缺 id / id 非字符串的条目被跳过：engineId 靠 id 引用，没有 id 的档案无法被指向', () => {
      const merged = mergeSettings({
        profiles: [
          { label: '没有 id', baseUrl: 'https://a.example/v1' },
          { id: 42, label: 'id 不是字符串' },
          { id: '   ' },
          profile({ id: 'good' }),
        ] as unknown as EngineProfile[],
      });
      expect(merged.profiles.map((item) => item.id)).toEqual(['good']);
    });

    it('重复 id 只留第一个：engineId 只能有一个指代对象', () => {
      const merged = mergeSettings({
        profiles: [profile({ id: 'dup', label: '第一个' }), profile({ id: 'dup', label: '第二个' })],
      });
      expect(merged.profiles).toHaveLength(1);
      expect(merged.profiles[0].label).toBe('第一个');
    });

    it('合法条目字段一字不差地保留；label 空白按「我的接口」处理', () => {
      const merged = mergeSettings({ profiles: [profile()] });
      expect(merged.profiles).toEqual([profile()]);
      expect(mergeSettings({ profiles: [profile({ label: '   ' })] }).profiles[0].label).toBe('我的接口');
      expect(mergeSettings({ profiles: [profile({ label: 42 as unknown as string })] }).profiles[0].label).toBe('我的接口');
    });

    it('apiKey / model 缺失或脏值补空串，不会凭空长出一个 Key', () => {
      const merged = mergeSettings({
        profiles: [{ id: 'p', apiKey: null, model: 7 }] as unknown as EngineProfile[],
      });
      expect(merged.profiles[0]).toEqual({ id: 'p', label: '我的接口', baseUrl: '', model: '', apiKey: '' });
    });
  });

  it('只有一份真相：engineConfig / providerPreset 不再是设置字段，脏输入里出现也不会带出来', () => {
    const merged = mergeSettings({
      engineConfig: { apiKey: 'sk-x', baseUrl: 'https://a.example/v1', model: 'm' },
      providerPreset: 'deepseek',
    } as unknown as Record<string, unknown>);
    expect('engineConfig' in merged).toBe(false);
    expect('providerPreset' in merged).toBe(false);
  });

  it('版本号必须能原样读回（迁移要靠它判断来源版本）', () => {
    expect(mergeSettings({ version: 99 }).version).toBe(99);
    expect(mergeSettings({ version: 'v2' }).version).toBe(CURRENT_VERSION);
    expect(mergeSettings({ version: 0 }).version).toBe(CURRENT_VERSION);
    expect(mergeSettings({ version: 1.5 }).version).toBe(CURRENT_VERSION);
    expect(mergeSettings({}).version).toBe(CURRENT_VERSION);
    expect(mergeSettings({ version: 2 }, 3).version).toBe(3);
  });

  it('不共享默认值里的可变对象', () => {
    expect(mergeSettings({}).siteRules).not.toBe(DEFAULT_SETTINGS.siteRules);
    expect(mergeSettings({}).glossary).not.toBe(DEFAULT_SETTINGS.glossary);
    expect(mergeSettings({}).profiles).not.toBe(DEFAULT_SETTINGS.profiles);
  });
});

describe('显示模式（默认值、迁移）', () => {
  it('默认是「仅译文」', () => {
    expect(DEFAULT_SETTINGS.displayMode).toBe('translated-only');
    expect(mergeSettings({}).displayMode).toBe('translated-only');
    expect(mergeSettings({ targetLang: 'ja' }).displayMode).toBe('translated-only');
  });

  it('保留用户明确选过的双语', () => {
    expect(mergeSettings({ displayMode: 'bilingual' }).displayMode).toBe('bilingual');
    expect(mergeSettings({ displayMode: 'translated-only' }).displayMode).toBe('translated-only');
  });

  it("把老数据里的 'replace' 迁移成 'translated-only'，而不是回落", () => {
    // 老用户的存储里就是 'replace'（v1 时代的"整页替换"）。当成未知值处理会退回**默认值**，
    // 于是默认值哪天再变一次，他们就会莫名其妙地被切回双语——那正是他们当年特意改掉的默认行为。
    // 所以映射写死成 'translated-only'，与当前的默认值是不是它无关（这条断言不引用
    // DEFAULT_SETTINGS，正是为了在默认值改变时仍然有意义）。
    expect(mergeSettings({ displayMode: 'replace' }).displayMode).toBe('translated-only');
    expect(mergeSettings({ displayMode: 'replace', version: 1 }).displayMode).toBe('translated-only');
  });

  it('不认识的显示模式退回默认值', () => {
    for (const raw of ['nope', '', null, 42, {}, []]) {
      expect(mergeSettings({ displayMode: raw }).displayMode).toBe(DEFAULT_SETTINGS.displayMode);
    }
  });

  it('loadSettings 读到老数据时就完成迁移（不需要用户再改一次设置）', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 1, displayMode: 'replace' } });
    expect((await loadSettings(area)).displayMode).toBe('translated-only');
  });

  describe('v1 → v2：冻结的 displayMode 要迁到新默认', () => {
    /**
     * 这一条是实测踩出来的：用户配完 DeepSeek（点过保存）之后升级到「仅译文」，
     * 页面上却还是双语。原因是 `saveSettings` 是**整份覆盖**——那次保存把当时的默认值
     * `bilingual` 一起冻结进了存储，而它是个合法值，程序没有理由覆盖它。
     *
     * v1 时代设置页与弹窗都没有改显示模式的界面，所以存储里的 `bilingual` 一定是冻结的
     * 默认值，不是用户的选择。因此按版本号迁移是安全的，也是唯一能让老用户拿到新默认的办法。
     */
    it('v1 存储里的 bilingual 迁成 translated-only', async () => {
      const area = new MemoryStorage();
      await area.set({ [SETTINGS_KEY]: { version: 1, displayMode: 'bilingual' } });
      expect((await loadSettings(area)).displayMode).toBe('translated-only');
    });

    it('v2 存储里的 bilingual 是用户真的选过的，不能动', async () => {
      const area = new MemoryStorage();
      await area.set({ [SETTINGS_KEY]: { version: 2, displayMode: 'bilingual' } });
      expect((await loadSettings(area)).displayMode).toBe('bilingual');
    });

    it('迁移只看版本号，v1 里已经是 translated-only 的保持不动', async () => {
      const area = new MemoryStorage();
      await area.set({ [SETTINGS_KEY]: { version: 1, displayMode: 'translated-only' } });
      expect((await loadSettings(area)).displayMode).toBe('translated-only');
    });

    it('读完之后版本号被标成当前版本，不会每次加载都再迁一遍', async () => {
      const area = new MemoryStorage();
      await area.set({ [SETTINGS_KEY]: { version: 1, displayMode: 'bilingual' } });
      const settings = await loadSettings(area);
      expect(settings.version).toBe(CURRENT_VERSION);
    });
  });
});

describe('BaseURL 校验（它决定 API Key 发往哪里，逐档案生效）', () => {
  const baseUrlOf = (value: unknown): string =>
    mergeSettings({ profiles: [{ id: 'p', baseUrl: value } as unknown as EngineProfile] }).profiles[0].baseUrl;

  it('接受 https 地址并去掉首尾空白', () => {
    expect(baseUrlOf('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1');
    expect(baseUrlOf('  https://api.deepseek.com/v1  ')).toBe('https://api.deepseek.com/v1');
  });

  it('拒绝非 https 的远端地址：归一化成空串，绝不悄悄换成另一个真实端点', () => {
    // 档案的 apiKey 就存进同一条目里——非法地址若"退回默认值"，等于把用户的 Key
    // 发给另一个服务商。空串让引擎在翻译时明确报「尚未填写接口地址」，不发任何请求。
    for (const raw of ['http://evil.example', '//evil.example', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(baseUrlOf(raw)).toBe('');
    }
    expect(baseUrlOf('http://evil.example')).not.toContain('openai');
  });

  it('放行本机回环地址的 http（本地推理服务）', () => {
    expect(baseUrlOf('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(baseUrlOf('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1');
  });

  it('拒绝连不上主机的地址与非字符串', () => {
    for (const raw of ['not a url', '', 'https://', 42, null]) {
      expect(baseUrlOf(raw)).toBe('');
    }
  });
});

describe('档案解析：resolveEngine 是唯一一处「engineId → 引擎 + 配置」', () => {
  it('engineId 命中某个档案 → OpenAI 兼容引擎 + 那份档案的配置（逐字段）', () => {
    const { engine, config } = resolveEngine({ engineId: 'p1', profiles: [profile()] });
    expect(engine.id).toBe('openai-compat');
    expect(config).toEqual({
      apiKey: 'sk-keep',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    });
  });

  it('多档案时各解析各的：命中的那份胜出，不混字段', () => {
    const { engine, config } = resolveEngine({
      engineId: 'p2',
      profiles: [profile(), profile({ id: 'p2', apiKey: 'sk-b', baseUrl: 'https://b.example/v1', model: 'm2' })],
    });
    expect(engine.id).toBe('openai-compat');
    expect(config).toEqual({ apiKey: 'sk-b', baseUrl: 'https://b.example/v1', model: 'm2' });
  });

  it('engineId 是 google → 免费引擎 + 空配置，档案完全不参与', () => {
    const { engine, config } = resolveEngine({ engineId: 'google', profiles: [profile()] });
    expect(engine.id).toBe('google');
    expect(config).toEqual({});
  });

  it('engineId 指向不存在的档案（并发删除留下的残值）→ 回落免费引擎，不抛错', () => {
    const { engine, config } = resolveEngine({ engineId: '已删掉的', profiles: [profile()] });
    expect(engine.id).toBe('google');
    expect(config).toEqual({});
  });

  it('裸 openai-compat（没配任何档案）→ 引擎自己给出可行动的 AUTH 提示，不是网络错误', async () => {
    const { engine, config } = resolveEngine({ engineId: 'openai-compat', profiles: [] });
    expect(engine.id).toBe('openai-compat');
    await expect(
      engine.translate({ texts: ['Hello'], from: 'auto', to: 'zh-Hans', signal: new AbortController().signal }, config),
    ).rejects.toThrow(/API Key/);
  });
});

describe('createProfileId：新建档案的稳定唯一 id', () => {
  it('非空、互不相同，且不拿 label 当 id', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) ids.add(createProfileId());
    for (const id of ids) expect(id.trim().length).toBeGreaterThan(0);
    expect(ids.size).toBe(50);
    expect(ids.has('我的 DeepSeek')).toBe(false);
  });
});

describe('迁移 v2 → v3：单份 engineConfig 折成一个档案', () => {
  const v2Config = {
    engineId: 'openai-compat',
    engineConfig: { apiKey: 'sk-ds', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  };

  it('openai-compat + DeepSeek 预设 → 一个档案，字段一字不差，engineId 变成档案 id', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 2, ...v2Config, providerPreset: 'deepseek' } });
    const settings = await loadSettings(area);
    expect(settings.profiles).toEqual([
      {
        id: LEGACY_PROFILE_ID,
        label: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKey: 'sk-ds',
      },
    ]);
    expect(settings.engineId).toBe(LEGACY_PROFILE_ID);
    expect(settings.version).toBe(CURRENT_VERSION);
  });

  it('label 取迁移当时 providerPreset 对应的服务商名；custom / 缺失 / 脏值用「我的接口」', async () => {
    const cases: Array<[unknown, string]> = [
      ['openai', 'OpenAI'],
      ['deepseek', 'DeepSeek'],
      ['ollama', 'Ollama（本机）'],
      ['custom', '我的接口'],
      [undefined, '我的接口'],
      ['claude', '我的接口'],
    ];
    for (const [preset, label] of cases) {
      const area = new MemoryStorage();
      await area.set({ [SETTINGS_KEY]: { version: 2, ...v2Config, providerPreset: preset } });
      const settings = await loadSettings(area);
      expect(settings.profiles.map((item) => item.label)).toEqual([label]);
    }
  });

  it('engineId 是 google 时不产生档案，也不改 engineId（那份 engineConfig 多半是没选过的残留）', async () => {
    const area = new MemoryStorage();
    await area.set({
      [SETTINGS_KEY]: {
        version: 2,
        engineId: 'google',
        providerPreset: 'deepseek',
        engineConfig: { apiKey: 'sk-ds', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      },
    });
    const settings = await loadSettings(area);
    expect(settings.profiles).toEqual([]);
    expect(settings.engineId).toBe('google');
  });

  it('engineConfig 坏掉也得到一个空档案而不是崩：字段全按默认补齐', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 2, engineId: 'openai-compat', engineConfig: null } });
    const settings = await loadSettings(area);
    expect(settings.profiles).toEqual([
      { id: LEGACY_PROFILE_ID, label: '我的接口', baseUrl: '', model: '', apiKey: '' },
    ]);
    expect(settings.engineId).toBe(LEGACY_PROFILE_ID);
  });

  it('v1 数据按序走两步：displayMode 冻结值迁移 + 档案折叠', async () => {
    const area = new MemoryStorage();
    await area.set({
      [SETTINGS_KEY]: {
        version: 1,
        displayMode: 'bilingual',
        engineId: 'openai-compat',
        providerPreset: 'openai',
        engineConfig: { apiKey: 'sk-oai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
      },
    });
    const settings = await loadSettings(area);
    expect(settings.displayMode).toBe('translated-only');
    expect(settings.profiles).toEqual([
      {
        id: LEGACY_PROFILE_ID,
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        apiKey: 'sk-oai',
      },
    ]);
    expect(settings.engineId).toBe(LEGACY_PROFILE_ID);
  });

  it('迁移过一次再存回存储（v3）：重复加载不会折出第二个档案，也不动 engineId', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 2, ...v2Config, providerPreset: 'deepseek' } });
    const first = await loadSettings(area);
    await saveSettings(first, area);
    // 存储里落定的是 v3 形状：engineConfig / providerPreset 不再存在。
    const raw = (await area.get([SETTINGS_KEY]))[SETTINGS_KEY] as Record<string, unknown>;
    expect(raw.version).toBe(CURRENT_VERSION);
    expect('engineConfig' in raw).toBe(false);
    expect('providerPreset' in raw).toBe(false);
    const second = await loadSettings(area);
    expect(second).toEqual(first);
    expect(second.profiles).toHaveLength(1);
  });

  it('已有 profiles 的 v3 数据即使残留 engineConfig 也不再迁移（幂等）', async () => {
    const area = new MemoryStorage();
    await area.set({
      [SETTINGS_KEY]: {
        version: 3,
        engineId: 'p-a',
        profiles: [profile({ id: 'p-a', label: '手工档案', apiKey: 'sk-a' })],
        engineConfig: { apiKey: 'sk-ghost', baseUrl: 'https://ghost.example/v1', model: 'ghost' },
        providerPreset: 'ollama',
      },
    });
    const settings = await loadSettings(area);
    expect(settings.profiles).toEqual([profile({ id: 'p-a', label: '手工档案', apiKey: 'sk-a' })]);
    expect(settings.engineId).toBe('p-a');
  });

  it('v2 的其它字段原样保留（迁移只动 engineConfig / providerPreset / engineId 三处）', async () => {
    const area = new MemoryStorage();
    await area.set({
      [SETTINGS_KEY]: {
        version: 2,
        ...v2Config,
        targetLang: 'ja',
        displayMode: 'bilingual',
        concurrency: 5,
        glossary: [{ from: 'DSH', to: 'DeepSeek Harness' }],
      },
    });
    const settings = await loadSettings(area);
    expect(settings.targetLang).toBe('ja');
    // v2 存储里的 bilingual 是用户选过的，v3 迁移不许顺手改掉。
    expect(settings.displayMode).toBe('bilingual');
    expect(settings.concurrency).toBe(5);
    expect(settings.glossary).toEqual([{ from: 'DSH', to: 'DeepSeek Harness' }]);
  });
});

describe('loadSettings / saveSettings', () => {
  it('未存储过时返回默认值', async () => {
    expect(await loadSettings(new MemoryStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it('档案列表保存后能原样读回（含 apiKey：完整读取是给受信页面用的）', async () => {
    const area = new MemoryStorage();
    await saveSettings({ ...DEFAULT_SETTINGS, profiles: [profile()], engineId: 'p1' }, area);
    const settings = await loadSettings(area);
    expect(settings.profiles).toEqual([profile()]);
    expect(settings.engineId).toBe('p1');
  });

  it('缺失版本号的老数据按当前版本读出', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { targetLang: 'ja' } });
    const settings = await loadSettings(area);
    expect(settings.targetLang).toBe('ja');
    expect(settings.version).toBe(CURRENT_VERSION);
  });

  it('读取比本代码更新的设置时明确报错而不是静默降级', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 99, targetLang: 'ja' } });
    await expect(loadSettings(area)).rejects.toThrow(/99/);
  });

  it('不会用旧 schema 覆盖更新版本的设置', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 99, targetLang: 'ja' } });
    await expect(saveSettings({ ...DEFAULT_SETTINGS, targetLang: 'ko' }, area)).rejects.toThrow();
    expect((await area.get([SETTINGS_KEY]))[SETTINGS_KEY]).toEqual({ version: 99, targetLang: 'ja' });
  });

  it('写入时归一化，脏数据进不了存储', async () => {
    const area = new MemoryStorage();
    await saveSettings(
      { ...DEFAULT_SETTINGS, concurrency: 999, version: 0, profiles: '脏' as unknown as EngineProfile[] },
      area,
    );
    const stored = (await area.get([SETTINGS_KEY]))[SETTINGS_KEY];
    expect(stored).toEqual({ ...DEFAULT_SETTINGS, concurrency: 8 });
  });
});

describe('loadUiSettings（内容脚本的投影）', () => {
  it('剥掉**每个**档案的 apiKey；列表渲染比单字段更容易带出值，逐项钉死', async () => {
    const area = new MemoryStorage();
    await saveSettings(
      {
        ...DEFAULT_SETTINGS,
        engineId: 'p2',
        profiles: [
          profile({ id: 'p1', apiKey: 'sk-alpha' }),
          profile({ id: 'p2', apiKey: 'sk-beta' }),
          profile({ id: 'p3', apiKey: 'sk-gamma' }),
        ],
      },
      area,
    );

    const ui = await loadUiSettings(area);
    expect(ui.profiles).toHaveLength(3);
    for (const item of ui.profiles) {
      expect(item).not.toHaveProperty('apiKey');
    }
    // 其余字段照常带出（弹窗/内容脚本要看 label、id、地址、模型）。
    expect(ui.profiles[1]).toEqual({ id: 'p2', label: '我的 DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
    expect(ui.engineId).toBe('p2');
    expect(ui.targetLang).toBe(DEFAULT_SETTINGS.targetLang);
    const json = JSON.stringify(ui);
    for (const secret of ['sk-alpha', 'sk-beta', 'sk-gamma']) expect(json).not.toContain(secret);
  });

  it('完整读取仍然拿得到每个 Key（service worker 与设置页需要）', async () => {
    const area = new MemoryStorage();
    await saveSettings(
      {
        ...DEFAULT_SETTINGS,
        profiles: [
          profile({ id: 'p1', apiKey: 'sk-alpha' }),
          profile({ id: 'p2', apiKey: 'sk-beta' }),
        ],
      },
      area,
    );
    const settings = await loadSettings(area);
    expect(settings.profiles.map((item) => item.apiKey)).toEqual(['sk-alpha', 'sk-beta']);
  });
});

describe('无扩展环境下的默认存储', () => {
  it('没有显式传入存储区时给出可读的错误', async () => {
    await expect(loadSettings()).rejects.toThrow(/StorageArea/);
    await expect(saveSettings(DEFAULT_SETTINGS)).rejects.toThrow(/StorageArea/);
  });
});

/**
 * 服务商预设（用户实测把模型名填成 `deepseek`（正确值 `deepseek-chat`）拿到
 * 一个界面上看不出原因的 HTTP 400 —— 这类错误用一个下拉就能防住）。
 * v3 起它**只是档案编辑表单的填写捷径**，不再是一个持久化字段；
 * 唯一还读它的地方是 v2 → v3 迁移（用它推导老档案的中文 label）。
 */
describe('服务商预设（PROVIDER_PRESETS，只作为档案模板）', () => {
  it('预填值逐字钉住：OpenAI / DeepSeek / Ollama 的地址与模型名（不确定的服务商不放）', () => {
    const byId = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));
    expect([...byId.keys()]).toEqual(['custom', 'openai', 'deepseek', 'ollama']);
    expect(byId.get('openai')).toMatchObject({ label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
    expect(byId.get('deepseek')).toMatchObject({ label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
    expect(byId.get('ollama')).toMatchObject({ label: 'Ollama（本机）', baseUrl: 'http://localhost:11434/v1', model: 'llama3' });
    // 自定义：不预填，保持现状。
    expect(byId.get('custom')?.baseUrl).toBeUndefined();
    expect(byId.get('custom')?.model).toBeUndefined();
  });

  it('每个预填地址都能通过存储层的 BaseURL 校验（填进档案不会反被归一化吞掉）', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.baseUrl !== undefined) expect(isAllowedBaseUrl(preset.baseUrl)).toBe(true);
    }
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
import { DEFAULT_ENGINE_ID, getEngine, OPENAI_COMPAT_ENGINE_ID } from '../engines/registry';
import type { EngineConfig, Term, Translator } from '../engines/types';
import { chromeArea } from './chrome-area';

export interface SiteRule {
  pattern: string;
  action: 'translate' | 'never';
}

/**
 * 一份服务商档案 = 一个「OpenAI 兼容」接口的完整凭据（地址 + 模型 + Key）加一个用户自己起的名字。
 *
 * 动机：设置里今天只有一份 `{apiKey, baseUrl, model}`，想同时用 DeepSeek、OpenAI、硅基流动、
 * Ollama 的人只能在三个框里来回改。改成档案列表后，弹窗的「翻译引擎」下拉直接按名字切换。
 *
 * `id` 是档案的**唯一引用键**（`engineId` 存的就是它）：新建时生成（{@link createProfileId}），
 * 之后不变。**不要拿 label 当 id**——名字是随便改的，改了名字不该把正在用的选择弄丢。
 */
export interface EngineProfile {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/**
 * 新建档案的 id：稳定、唯一、与 label 无关。
 * 优先用平台的 UUID；拿不到（非安全上下文等）时退到「时间戳 + 随机串」——仍然不需要 label 参与。
 */
export function createProfileId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (typeof randomUuid === 'string') return `p-${randomUuid}`;
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 服务商预设的 id。`custom` = 不预填，用户自己填什么是什么。 */
export type ProviderPresetId = 'custom' | 'openai' | 'deepseek' | 'ollama';

/**
 * 服务商预设：档案编辑表单里「从服务商模板创建」的选项——选中即**预填**接口地址与模型名。
 *
 * 动机是真实踩过的坑：用户在模型名里填 `deepseek`（正确值是 `deepseek-chat`），
 * 拿到一个界面上看不出原因的 HTTP 400。这类错误完全可以用一次下拉选择消除。
 * 只放**确定无疑**的三家（OpenAI / DeepSeek / Ollama 本机默认端口）——
 * 拿不准的服务商宁可不放，也不预填一个错的模型名。
 *
 * 预设只是**填写捷径**，不是锁定：选完之后接口地址与模型名照常手改，
 * 改完即视为自定义（编辑表单负责把下拉翻回 `custom`，预设永远不许覆盖用户敲进去的值）。
 *
 * **v3 起它不再是一个设置字段**：曾经每份设置只有一个 `providerPreset`，而现在每个档案
 * 各自编辑，记一个全局的"上次选了哪家"既没有消费者、又必然与档案内容漂移。
 * 今天唯一还读它的地方是 v2 → v3 迁移（用它推导老档案的中文名）。
 */
export interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  /** 预填的接口地址；`custom` 没有（undefined = 不动任何字段）。 */
  baseUrl?: string;
  /** 预填的模型名；`custom` 没有。 */
  model?: string;
}

export const PROVIDER_PRESETS: ReadonlyArray<ProviderPreset> = [
  { id: 'custom', label: '自定义' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'ollama', label: 'Ollama（本机）', baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
];

/**
 * 译文显示方式。
 *
 * - `translated-only`（默认）：**只显示译文**。原文并没有被删掉——它被包进一个
 *   `display:none` 的 `<span data-jy-originals>` 留在 DOM 里，还原就是把子节点搬回去
 *   （见 `content/renderer.ts`）。用户要的就是这个：双语对照会让译文和原文互相挤占版面。
 * - `bilingual`：原文照旧，译文插在它下面。
 *
 * 这里曾经还有第三种 `'replace'`（就地写 `textContent` 覆盖原文）。它已随
 * {@link mergeSettings} 的迁移改成 `translated-only`：旧实现遇到含行内标记的段落会
 * 静默退回双语，真实长文（维基百科几乎每段都有链接）实际表现就是"大部分段落仍是双语"，
 * 与「只显示译文」正好相反。
 */
export type DisplayMode = 'bilingual' | 'translated-only';

/**
 * 显示模式的界面选项（弹窗与设置页**共用这一份**）。
 *
 * 与 `core/lang.ts` 的 LANGUAGES 同一个道理：两处各写一份时，同一个设置在两个界面上会
 * 给出不同的说法（"仅译文" / "只要译文"），用户会以为它们不是同一个东西。
 * 数组顺序就是界面顺序：默认的「仅译文」在最前——它是用户最可能想改的一项。
 */
export const DISPLAY_MODES: ReadonlyArray<{ value: DisplayMode; label: string }> = [
  { value: 'translated-only', label: '仅译文' },
  { value: 'bilingual', label: '双语对照' },
];

export interface Settings {
  version: number;
  /**
   * 当前用的引擎：**`google`（免费接口）或某个档案的 `id`**。
   * 「档案 → 用哪个引擎 + 哪份配置」的解析只有一处：{@link resolveEngine}。
   * 调用方（service worker、弹窗、设置页）一律走它，不许各自写一份 if。
   * 指向不存在的档案时解析回落免费引擎；设置页删除档案时会把这里落到一个**存在**的目标。
   */
  engineId: string;
  /** 服务商档案列表。曾经这里是一份匿名的 `engineConfig`，v2 → v3 迁移见 `migrate`。 */
  profiles: EngineProfile[];
  targetLang: string;
  sourceLang: string;
  displayMode: DisplayMode;
  hoverTranslate: boolean;
  selectionTranslate: boolean;
  /**
   * ⚠ **这个字段目前没有任何消费者**：只有类型声明、默认值与 `mergeSettings` 的夹取，
   * 全仓没有任何代码读它来触发自动翻译——自动翻译功能本身尚未实现（属下一阶段）。
   * 在存储里把它设成多少都**不会有任何效果**，别以为改这里就能调延时。
   * 接功能时记得同时补界面（README 已按"无界面、无行为"如实描述）。
   */
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

/** 当前设置 schema 版本；改动字段语义时递增。 */
export const CURRENT_VERSION = 3;

/**
 * v2 → v3 迁移产物固定用这个 id（老 `engineId === 'openai-compat'` 也迁到它）。
 * 常量导出：测试与「删除档案后 engineId 回落」之类的判断都引用它，不各写字面量。
 */
export const LEGACY_PROFILE_ID = 'legacy';

/** 没有名字的档案在界面上叫什么。迁移与反序列化共用，避免两处各写一份漂移。 */
const FALLBACK_PROFILE_LABEL = '我的接口';

export const DEFAULT_SETTINGS: Settings = {
  version: CURRENT_VERSION,
  engineId: DEFAULT_ENGINE_ID,
  profiles: [],
  targetLang: 'zh-Hans',
  sourceLang: 'auto',
  displayMode: 'translated-only',
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

/**
 * 认不出来的值回落到哪个模式。
 *
 * 单独拎成一个常量而不是直接写 `DEFAULT_SETTINGS.displayMode`，是为了让「兜底」与
 * 「`'replace'` 的迁移目标」成为两个可以分别演进的概念：默认值将来若改成双语，
 * `'replace'` 仍然应该映射成"只要译文"。
 *
 * **现状要如实说明**：今天两者恰好都是 `translated-only`，所以把 `pickDisplayMode` 里的
 * 迁移分支删掉，全部测试依然通过——兜底补上了同一个结果。也就是说那条迁移目前
 * **没有测试守得住**，它只在默认值改变之后才成为承重代码。变异测试证实过这一点
 * （删掉 `|| value === 'replace'`，426 个用例全绿）。不要以为有测试保护它。
 */
const FALLBACK_DISPLAY_MODE: DisplayMode = 'translated-only';

/**
 * 显示模式的读取与**迁移**。
 *
 * 存储里已有的 `'replace'`（v1 时代的"整页替换"）必须映射成 `translated-only`：
 * 老用户升级后不能被当成"值不认识"而回落——回落的结果是显示模式悄悄变回双语，
 * 而那正是用户当初特意改掉的默认行为。
 *
 * 迁移目标与兜底都写死成 `translated-only` 而不是"当前的默认值"：默认值以后再变一次时，
 * `'replace'` 的语义仍然是"只要译文"，不该跟着新默认值漂走。
 */
function pickDisplayMode(value: unknown): DisplayMode {
  if (value === 'bilingual') return 'bilingual';
  if (value === 'translated-only' || value === 'replace') return 'translated-only';
  return FALLBACK_DISPLAY_MODE;
}

/** 允许 http 的本机主机名（用户的本地推理服务，如 Ollama）。 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * 接口地址是否合法：只接受 https（本机回环地址放行 http，Ollama 等本地服务默认就是 http）。
 *
 * 导出是给**设置页**用的：它必须在保存按钮里给出与这里**同一套判据**的提示，否则会出现
 * 「设置页说保存成功、存储层把地址悄悄退回默认值」这种用户永远查不出来的分歧。
 * 档案列表的每个 `baseUrl` 也逐条走这同一个判据，不再写第二份。
 */
export function isAllowedBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
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

/**
 * 单个档案的读取：逐字段校验，坏条目丢掉而不是让整页崩掉（`pickSiteRules` 的老规矩）。
 *
 * - 没有合法 `id` 的条目**必须**丢：`engineId` 按 id 引用档案，没有 id 的档案无法被指向，
 *   留在列表里只会成为一个永远选不中的幽灵条目。
 * - `baseUrl` 非法（脏存储、被绕过的 UI）归一化成**空串**而不是某个默认端点：
 *   档案的 apiKey 就存在同一条目里，"退回默认地址"等于把用户的 Key 发给另一家服务商。
 *   空地址让引擎在翻译时明确报「尚未填写接口地址」，不发任何请求。
 *   （v2 时代单份配置的"非法退回默认值"策略在档案列表下不再成立：那时地址与 Key 的
 *   对应关系只有一份，现在每份 Key 都属于它自己那条地址。）
 * - label 空白按缺失处理，界面上才不会出现一排选不出名字的条目。
 */
function pickProfile(value: unknown): EngineProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<EngineProfile>;
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) return null;
  const label = pickString(raw.label, '');
  let baseUrl = '';
  if (typeof raw.baseUrl === 'string') {
    const trimmed = raw.baseUrl.trim();
    if (isAllowedBaseUrl(trimmed)) baseUrl = trimmed;
  }
  return {
    id: raw.id,
    label: label.trim().length > 0 ? label : FALLBACK_PROFILE_LABEL,
    baseUrl,
    model: pickString(raw.model, ''),
    apiKey: pickString(raw.apiKey, ''),
  };
}

/** 档案列表的读取：非数组当没有；重复 id 只留第一个（engineId 只能有一个指代对象）。 */
function pickProfiles(value: unknown): EngineProfile[] {
  if (!Array.isArray(value)) return [];
  const out: EngineProfile[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const profile = pickProfile(raw);
    if (profile === null || seen.has(profile.id)) continue;
    seen.add(profile.id);
    out.push(profile);
  }
  return out;
}

/**
 * 把任意来源的对象合并成完整设置。
 * 逐字段校验而不是整体替换，这样新版字段可以在老数据上补齐，
 * 单个字段损坏也不会让整个设置页崩掉。
 *
 * `version` 是**声明值**而不是校验结果：调用方决定它是多少（见 `saveSettings` 的
 * 防降级与 `loadSettings` 的版本闸门），这里只负责拒绝非正整数。
 */
export function mergeSettings(raw: unknown, version: unknown = undefined): Settings {
  const input = (raw ?? {}) as Partial<Settings>;
  return {
    version: pickVersion(version ?? input.version),
    engineId: pickString(input.engineId, DEFAULT_SETTINGS.engineId),
    profiles: pickProfiles(input.profiles),
    targetLang: pickString(input.targetLang, DEFAULT_SETTINGS.targetLang),
    sourceLang: pickString(input.sourceLang, DEFAULT_SETTINGS.sourceLang),
    displayMode: pickDisplayMode(input.displayMode),
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

/**
 * 「engineId → 用哪个引擎 + 用哪份配置」的**唯一一处**解析。
 *
 * service worker、弹窗、设置页全走它。写第二份 if 的代价是现成的：某天加一种引擎，
 * 漏掉的那个调用点就会拿档案 id 去 `getEngine` 里查不到、静默回落到免费引擎——
 * 用户以为在用 DeepSeek，实际在烧 Google 额度。
 *
 * 解析规则（`engineId` 只有两种取值形态）：
 * - 命中某个档案 → OpenAI 兼容引擎 + **那份**档案的 `{apiKey, baseUrl, model}`；
 * - 没命中 → `getEngine` 的既有语义（'google' 即免费引擎；未知 id 回落免费引擎）。
 *   档案被别处删掉后留下的失效 engineId 因此照常可用，只是安静地用免费接口——
 *   设置页删除当前档案时承诺过把 engineId 落到存在的目标，这里是最后一道防线。
 */
export function resolveEngine(settings: Pick<Settings, 'engineId' | 'profiles'>): {
  engine: Translator;
  config: EngineConfig;
} {
  const profile = settings.profiles.find((item) => item.id === settings.engineId);
  if (profile === undefined) return { engine: getEngine(settings.engineId), config: {} };
  return {
    engine: getEngine(OPENAI_COMPAT_ENGINE_ID),
    config: { apiKey: profile.apiKey, baseUrl: profile.baseUrl, model: profile.model },
  };
}

/** 版本号必须能原样读回，否则无从判断来源版本；非正整数一律按当前版本处理。 */
function pickVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return CURRENT_VERSION;
  return value;
}

/** 读出存储里声明的版本号（缺失或非法即"当作当前版本"）。 */
function readStoredVersion(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return CURRENT_VERSION;
  return pickVersion((raw as Partial<Settings>).version);
}

let sharedArea: StorageArea | null = null;

function resolveArea(area?: StorageArea): StorageArea {
  if (area) return area;
  if (typeof chrome === 'undefined') {
    throw new Error('当前运行环境没有扩展存储，调用时必须显式传入 StorageArea');
  }
  if (!sharedArea) sharedArea = chromeArea(chrome.storage.local);
  return sharedArea;
}

/**
 * 读出完整设置（**含每个档案的 API Key**）。
 *
 * 调用方是**扩展自身的受信页面与后台**：service worker、设置页、弹窗——三者同源
 * （`chrome-extension://`），谁也拿不到对方拿不到的东西，所以弹窗读完整设置不是越权。
 * 真正需要把密钥隔离开的是**内容脚本**：它跑在网页的进程里，一律用 `loadUiSettings()`，
 * 那个类型里档案列表**每一项**都没有 `apiKey` 字段——注意这是**类型级**投影（下游拿不到
 * 字段），不是内存级隔离（实现上仍经由本函数读出整份设置，见 `loadUiSettings` 的注释）。
 * 密钥不得进入日志、消息与导出的 JSON（规格 §7.3）。
 *
 * 这里也是**迁移入口**（规格 §7.3），具体步骤见 `migrate`。
 */
/**
 * 按**存储里的真实版本号**迁移老数据。新增一版就在这里加一步。
 *
 * **v1 → v2：`displayMode` 的 `'bilingual'` 迁到 `'translated-only'`。**
 * v1 时代设置页与弹窗都**没有**改显示模式的界面（那个开关是 v2 才加的），所以存储里的
 * `displayMode` 一定是当时的默认值被 `saveSettings` 整份覆盖时**冻结**下来的——用户只要
 * 配过一次引擎或改过目标语言，就会把它一起写进去——不可能是用户的选择。
 * 不迁的话，所有配过引擎的老用户升级后仍然看到双语，而他们从来没选过双语
 * （实测就是这么发生的：用户配完 DeepSeek 后升级，页面还是双语）。
 * 只动 `'bilingual'`：`'replace'` 交给 `pickDisplayMode` 映射，其余脏值交给它兜底。
 * v2 及以后存储里的 `'bilingual'` 是用户真的在界面上选过的，**不能动**。
 *
 * **v2 → v3：单份 `engineConfig` 折成一个档案。**见 `foldLegacyEngineConfig`。
 *
 * 迁移按 `storedVersion` 分支、**只在 `loadSettings` 里发生**：v3 数据从版本闸门
 * （`storedVersion >= CURRENT_VERSION`）直接原样返回，不会被重复折叠——幂等性靠的就是
 * 这一道闸门加上"折叠只在 v2 形状上发生"。
 */
function migrate(raw: unknown, storedVersion: number): unknown {
  if (storedVersion >= CURRENT_VERSION) return raw;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  let record = raw as Record<string, unknown>;
  if (storedVersion < 2 && record.displayMode === 'bilingual') {
    record = { ...record, displayMode: 'translated-only' };
  }
  if (storedVersion < 3) {
    record = foldLegacyEngineConfig(record);
  }
  return record;
}

/**
 * v2 → v3 的折叠：把老的那份 `{apiKey, baseUrl, model}` 变成一个档案（id 固定
 * `LEGACY_PROFILE_ID`），并把 `engineId === 'openai-compat'` 改指向它。
 *
 * 三个刻意的决定：
 *
 * 1. **只有当时真的在用自定义接口（`engineId === 'openai-compat'`）才折叠。**
 *    用 google 的老用户存储里那份 engineConfig 是设置页默认值或被放弃的填写——凭空造一个
 *    档案会让弹窗下拉冒出一个用户没要过的条目。（代价如实说：那种用户填过的 Key/地址会随
 *    v3 丢弃，需要重新建一次档案；他当时既然选择不用它，这比一个来路不明的档案更可预期。）
 * 2. **label 优先取当时存的 `providerPreset` 对应的服务商名**——那个字段记录的就是
 *    "这份配置是从哪家填出来的"，迁移后它就是档案名，老用户不用猜"我的接口"是哪个。
 *    `custom`/缺失/脏值用「我的接口」。
 * 3. 字段值**原样搬运**，归一化（地址判据、空白 label 等）交给 `mergeSettings` 的
 *    反序列化边界，两处不各写一份校验。
 */
function foldLegacyEngineConfig(record: Record<string, unknown>): Record<string, unknown> {
  if (record.engineId !== OPENAI_COMPAT_ENGINE_ID) return record;
  const storedConfig: unknown = record.engineConfig;
  const config = (
    storedConfig !== null && typeof storedConfig === 'object' && !Array.isArray(storedConfig)
      ? storedConfig
      : {}
  ) as Partial<{ apiKey: string; baseUrl: string; model: string }>;
  const next: Record<string, unknown> = {
    ...record,
    profiles: [
      {
        id: LEGACY_PROFILE_ID,
        label: legacyLabelForPreset(record.providerPreset),
        baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
        model: typeof config.model === 'string' ? config.model : '',
        apiKey: typeof config.apiKey === 'string' ? config.apiKey : '',
      },
    ],
    engineId: LEGACY_PROFILE_ID,
  };
  // 真相只留一份：老字段在迁移产物里不残留（mergeSettings 本来也不读它们，但存储里
  // 留着会让"下次迁移"的判据变得含糊）。
  delete next.engineConfig;
  delete next.providerPreset;
  return next;
}

/** 老 `providerPreset` → 新档案的名字。认不出来的一切值（含 custom 与缺失）都叫「我的接口」。 */
function legacyLabelForPreset(value: unknown): string {
  if (typeof value === 'string' && value !== 'custom') {
    const preset = PROVIDER_PRESETS.find((item) => item.id === value);
    if (preset !== undefined) return preset.label;
  }
  return FALLBACK_PROFILE_LABEL;
}

/**
 * 读出扩展设置。**这是迁移入口**（规格 §7.3）：版本号必须从存储里真实读出来，
 * 否则无从判断该按哪一版语义解释老数据。
 *
 * 读到**比本代码更新**的版本号说明用户装过新版扩展后又回退了，此时按旧语义解释新数据
 * 会得出错误结果，因此明确拒绝，而不是静默降级。
 */
export async function loadSettings(area?: StorageArea): Promise<Settings> {
  const target = resolveArea(area);
  const raw = await target.get([SETTINGS_KEY]);
  const stored = raw[SETTINGS_KEY];
  const storedVersion = readStoredVersion(stored);
  if (storedVersion > CURRENT_VERSION) {
    throw new Error(`设置版本 ${storedVersion} 高于当前支持的 ${CURRENT_VERSION}，请更新扩展`);
  }
  return mergeSettings(migrate(stored, storedVersion), CURRENT_VERSION);
}

/** 不带 API Key 的档案投影，见 {@link loadUiSettings} 的如实定性。 */
export type UiEngineProfile = Omit<EngineProfile, 'apiKey'>;

export type UiSettings = Omit<Settings, 'profiles'> & { profiles: UiEngineProfile[] };

/**
 * 读出**投影版**设置，供内容脚本一类不该碰凭据的调用方使用。
 *
 * 如实定性——这是**类型级**隔离，不是内存级隔离：`UiEngineProfile` 里没有 `apiKey` 字段，
 * 下游代码拿不到它；而实现上本函数仍调用 `loadSettings` 读出整份设置再丢掉字段，密钥会
 * **瞬态**出现在调用方所在 world 的堆里。内容脚本处于 isolated world，页面脚本本来就
 * 访问不到那个堆，实际风险接近 0——但别把投影读成"密钥从不经过网页进程内存"。
 * 要做到结构性隔离，得把 apiKey 拆成独立存储键、投影版根本不读它（后续工作，尚未做）。
 *
 * 档案列表时代新增的义务：**每一项都要剥**，不是剥一个顶层字段。列表渲染天然比单字段
 * 更容易把值带出去，所以这里用逐项解构、并由测试用三个不同密钥逐条断言（settings.test、
 * popup.test、options.test 三处），漏剥任何一项都会红。
 */
export async function loadUiSettings(area?: StorageArea): Promise<UiSettings> {
  const { profiles, ...rest } = await loadSettings(area);
  return { ...rest, profiles: profiles.map(stripProfileApiKey) };
}

function stripProfileApiKey({ apiKey: _apiKey, ...visible }: EngineProfile): UiEngineProfile {
  return visible;
}

/**
 * 保存前先归一化（`mergeSettings`），UI 不可能把脏数据写进存储。
 * 存储里的版本号高于本代码时拒绝写入：继续写就等于用旧 schema 覆盖新数据
 * （弹窗每次改动开关都会保存一次），会把新版字段悄悄丢掉。
 *
 * 注意这是**整份覆盖**：调用方必须持有完整设置（弹窗就是 `loadSettings` 读来的那一份，
 * 它只改 targetLang / engineId，其余字段——**包括每个档案里的 Key**——原样写回）。
 * 设置页因此坚持"写之前重新读一次存储、只覆盖本页管的字段"（见 `options.ts`），
 * 两边各持一份快照同时整份回写时，后写的会把对方的改动抹掉——这个约束在档案列表下
 * 更容易踩中（档案的 Key 也在那份快照里）。
 */
export async function saveSettings(settings: Settings, area?: StorageArea): Promise<void> {
  const target = resolveArea(area);
  const stored = await target.get([SETTINGS_KEY]);
  const storedVersion = readStoredVersion(stored[SETTINGS_KEY]);
  if (storedVersion > CURRENT_VERSION) {
    throw new Error(`存储中的设置版本 ${storedVersion} 高于当前支持的 ${CURRENT_VERSION}，已跳过保存`);
  }
  await target.set({ [SETTINGS_KEY]: mergeSettings(settings, CURRENT_VERSION) });
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
    keys: async () => Object.keys(await area.get(null)),
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

  it('允许空批次（形状合法，空只是发送方的约定）', () => {
    expect(isTranslateTextsMessage({ type: MSG.TRANSLATE_TEXTS, payload: { items: [] } })).toBe(true);
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

  it('拒绝 targetLang 类型不对的消息', () => {
    expect(
      isTranslateTextsMessage({
        type: MSG.TRANSLATE_TEXTS,
        payload: { items: [{ id: 'jy-1', text: 'Hello' }], targetLang: 123 },
      }),
    ).toBe(false);
  });

  it('允许省略 targetLang', () => {
    expect(
      isTranslateTextsMessage({ type: MSG.TRANSLATE_TEXTS, payload: { items: [{ id: 'jy-1', text: 'Hi' }] } }),
    ).toBe(true);
    expect(
      isTranslateTextsMessage({
        type: MSG.TRANSLATE_TEXTS,
        payload: { items: [{ id: 'jy-1', text: 'Hi' }], targetLang: 'ja' },
      }),
    ).toBe(true);
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
import type { DisplayMode } from './settings';

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
  /**
   * 弹窗 → 内容脚本：「悬停翻译 / 划词翻译」开关改了。
   *
   * 这两个开关控制的是**监听器挂没挂**，只写进设置不会让当前页面已经挂上/缺席的监听
   * 自己出现或消失——弹窗必须把改动推给内容脚本，让它当场重新挂/摘，
   * 否则用户拨了开关、页面却纹丝不动（规格 §7.1 要求"改动即时生效"）。
   */
  APPLY_SETTINGS: 'jinyi:apply-settings',
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
  /** 这一轮翻译用的是哪种显示方式（弹窗按它告诉用户当前页面处于什么状态）。 */
  mode: DisplayMode;
  total: number;
  done: number;
  failed: number;
}

/**
 * 跨进程边界的消息必须在运行时校验，不能只信 TypeScript 类型。
 *
 * 只校验**形状**：空批次是发送方自己的约定（下游对 `items: []` 返回空结果即可），
 * 不是安全属性。把空批次判为非法，只会让一个良性请求收不到任何响应、变成悬空的 RPC。
 */
export function isTranslateTextsMessage(value: unknown): value is TranslateTextsMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<TranslateTextsMessage>;
  if (message.type !== MSG.TRANSLATE_TEXTS) return false;
  if (!message.payload || typeof message.payload !== 'object') return false;
  const payload = message.payload as { items?: unknown; targetLang?: unknown };
  if (!Array.isArray(payload.items)) return false;
  if (payload.targetLang !== undefined && typeof payload.targetLang !== 'string') return false;
  return payload.items.every(
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
