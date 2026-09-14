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
    expect(await cache.count()).toBe(20);
    // 每写一条就裁掉最旧的，最后留下的是最后写入的 20 条。
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
  SETTINGS_KEY,
  loadSettings,
  loadUiSettings,
  mergeSettings,
  saveSettings,
} from '../../src/shared/settings';
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

  it('对任意非对象输入都不抛错', () => {
    for (const raw of [null, undefined, 42, 'x', true, [], [1, 2], () => 1, Symbol('s')]) {
      expect(() => mergeSettings(raw)).not.toThrow();
      expect(mergeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('损坏的 engineConfig 退回默认值', () => {
    expect(mergeSettings({ engineConfig: null }).engineConfig).toEqual(DEFAULT_SETTINGS.engineConfig);
    expect(mergeSettings({ engineConfig: [] }).engineConfig).toEqual(DEFAULT_SETTINGS.engineConfig);
    expect(mergeSettings({ engineConfig: 'x' }).engineConfig).toEqual(DEFAULT_SETTINGS.engineConfig);
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
    expect(mergeSettings({}).engineConfig).not.toBe(DEFAULT_SETTINGS.engineConfig);
  });
});

describe('BaseURL 校验（它决定 API Key 发往哪里）', () => {
  const baseUrlOf = (value: unknown): string =>
    mergeSettings({ engineConfig: { baseUrl: value } }).engineConfig.baseUrl;

  it('接受 https 地址并去掉首尾空白', () => {
    expect(baseUrlOf('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1');
    expect(baseUrlOf('  https://api.deepseek.com/v1  ')).toBe('https://api.deepseek.com/v1');
  });

  it('拒绝非 https 的远端地址', () => {
    expect(baseUrlOf('http://evil.example')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
    expect(baseUrlOf('//evil.example')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
    expect(baseUrlOf('file:///etc/passwd')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
    expect(baseUrlOf('javascript:alert(1)')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
  });

  it('放行本机回环地址的 http（本地推理服务）', () => {
    expect(baseUrlOf('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(baseUrlOf('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1');
  });

  it('拒绝连不上主机的地址与非字符串', () => {
    expect(baseUrlOf('not a url')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
    expect(baseUrlOf('')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
    expect(baseUrlOf('https://')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
    expect(baseUrlOf(42)).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
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
    await saveSettings({ ...DEFAULT_SETTINGS, concurrency: 999, version: 0 }, area);
    const stored = (await area.get([SETTINGS_KEY]))[SETTINGS_KEY];
    expect(stored).toEqual({ ...DEFAULT_SETTINGS, concurrency: 8 });
  });
});

describe('loadUiSettings', () => {
  it('不带出 API Key，其余设置与完整读取一致', async () => {
    const area = new MemoryStorage();
    await saveSettings(
      { ...DEFAULT_SETTINGS, engineConfig: { apiKey: 'sk-secret', baseUrl: 'https://a.example/v1', model: 'm' } },
      area,
    );

    const ui = await loadUiSettings(area);
    expect(ui.engineConfig).not.toHaveProperty('apiKey');
    expect(ui.engineConfig).toEqual({ baseUrl: 'https://a.example/v1', model: 'm' });
    expect(ui.targetLang).toBe(DEFAULT_SETTINGS.targetLang);
    expect(JSON.stringify(ui)).not.toContain('sk-secret');
  });

  it('完整读取仍然拿得到 API Key（service worker 与设置页需要）', async () => {
    const area = new MemoryStorage();
    await saveSettings({ ...DEFAULT_SETTINGS, engineConfig: { apiKey: 'sk-secret', baseUrl: 'https://a.example/v1', model: 'm' } }, area);
    expect((await loadSettings(area)).engineConfig.apiKey).toBe('sk-secret');
  });
});

describe('无扩展环境下的默认存储', () => {
  it('没有显式传入存储区时给出可读的错误', async () => {
    await expect(loadSettings()).rejects.toThrow(/StorageArea/);
    await expect(saveSettings(DEFAULT_SETTINGS)).rejects.toThrow(/StorageArea/);
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

/** 当前设置 schema 版本；改动字段语义时递增。 */
export const CURRENT_VERSION = 1;

export const DEFAULT_SETTINGS: Settings = {
  version: CURRENT_VERSION,
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

/** 允许 http 的本机主机名（用户的本地推理服务，如 Ollama）。 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * 接口地址是否合法：只接受 https（本机回环地址放行 http，Ollama 等本地服务默认就是 http）。
 *
 * 导出是给**设置页**用的：它必须在保存按钮里给出与这里**同一套判据**的提示，否则会出现
 * 「设置页说保存成功、存储层把地址悄悄退回默认值」这种用户永远查不出来的分歧。
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

function pickEngineConfig(value: unknown): EngineConfigSettings {
  const raw = (value ?? {}) as Partial<EngineConfigSettings>;
  return {
    apiKey: pickString(raw.apiKey, DEFAULT_SETTINGS.engineConfig.apiKey),
    baseUrl: pickBaseUrl(raw.baseUrl),
    model: pickString(raw.model, DEFAULT_SETTINGS.engineConfig.model),
  };
}

/**
 * BaseURL 决定 `Authorization: Bearer <apiKey>` 发往哪里，是这个凭据的唯一下游，
 * 所以它是反序列化边界上必须校验的字段而不是一个可自由填写的字符串：
 * 只接受 https（本机回环地址放行 http，Ollama 等本地服务默认就是 http）。
 * 非法值不抛错，退回默认值——这样错误输入永远不会变成"把 Key 发到别处"。
 */
function pickBaseUrl(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.engineConfig.baseUrl;
  const trimmed = value.trim();
  if (!isAllowedBaseUrl(trimmed)) return DEFAULT_SETTINGS.engineConfig.baseUrl;
  return trimmed;
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
    engineConfig: pickEngineConfig(input.engineConfig),
    targetLang: pickString(input.targetLang, DEFAULT_SETTINGS.targetLang),
    sourceLang: pickString(input.sourceLang, DEFAULT_SETTINGS.sourceLang),
    displayMode: input.displayMode === 'replace' ? 'replace' : DEFAULT_SETTINGS.displayMode,
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
 * 读取完整设置（**含 API Key**）。
 *
 * 调用方是**扩展自身的受信页面与后台**：service worker、设置页、弹窗——三者同源
 * （`chrome-extension://`），谁也拿不到对方拿不到的东西，所以弹窗读完整设置不是越权。
 * 真正需要结构上隔离的是**内容脚本**：它跑在网页的进程里，一律用 `loadUiSettings()`，
 * 那个类型里根本没有 `apiKey` 字段。密钥不得进入日志、消息与导出的 JSON（规格 §7.3）。
 *
 * 这里也是**迁移入口**（规格 §7.3）：版本号必须从存储里真实读出来，否则将来
 * 无从判断该按哪一版语义解释老数据。当前只有 v1，所以 v1 数据只需逐字段补齐；
 * v0 之类的历史版本号今天不可能出现；读到**比本代码更新**的版本号说明用户装过
 * 新版扩展后又回退了，此时按 v1 语义解释 v2 数据会得出错误结果，因此明确拒绝，
 * 而不是静默降级。将来新增 v2 时，在这个分支里按 `storedVersion` 补迁移步骤。
 */
export async function loadSettings(area?: StorageArea): Promise<Settings> {
  const target = resolveArea(area);
  const raw = await target.get([SETTINGS_KEY]);
  const stored = raw[SETTINGS_KEY];
  const storedVersion = readStoredVersion(stored);
  if (storedVersion > CURRENT_VERSION) {
    throw new Error(`设置版本 ${storedVersion} 高于当前支持的 ${CURRENT_VERSION}，请更新扩展`);
  }
  return mergeSettings(stored, CURRENT_VERSION);
}

/** 不带 API Key 的设置投影，供**内容脚本**使用（它跑在网页进程里）。 */
export type UiEngineConfig = Omit<EngineConfigSettings, 'apiKey'>;

export type UiSettings = Omit<Settings, 'engineConfig'> & { engineConfig: UiEngineConfig };

export async function loadUiSettings(area?: StorageArea): Promise<UiSettings> {
  const { engineConfig, ...rest } = await loadSettings(area);
  return { ...rest, engineConfig: { baseUrl: engineConfig.baseUrl, model: engineConfig.model } };
}

/**
 * 保存前先归一化（`mergeSettings`），UI 不可能把脏数据写进存储。
 * 存储里的版本号高于本代码时拒绝写入：继续写就等于用旧 schema 覆盖新数据
 * （弹窗每次改动开关都会保存一次），会把新版字段悄悄丢掉。
 *
 * 注意这是**整份覆盖**：调用方必须持有完整设置（弹窗就是 `loadSettings` 读来的那一份，
 * 它只改 targetLang / engineId，其余字段原样写回）。因此设置页实装后**不能**和弹窗
 * 各持一份快照同时写——两边各自读一次、各改一个字段，后写的那次会把对方刚改的字段
 * 抹回自己的旧值。到那时这里要加一个存储侧的局部写入 API（只写指定字段），
 * 而不是让两个页面继续整份回写。今天设置页还是占位实现（src/options/options.ts），
 * 弹窗是唯一的写入方，所以这条约束尚未被触发。
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
