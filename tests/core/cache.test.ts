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
