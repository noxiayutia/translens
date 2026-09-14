// tests/background/service-worker-startup.test.ts
/**
 * 启动对账：`void persistentCache.prune()` / `void sessionCache.prune()`
 * （`src/background/service-worker.ts:23-24`）是**模块级副作用**，只在 import 的
 * 那一瞬间跑一次——错过这个时机就再也补不上了。
 *
 * 所以它单独占一个测试文件，而不是并进 `service-worker.test.ts`：那边 `beforeEach`
 * 会 `reset()` 两块存储，坏数据在第一个用例开始前就被清掉，"启动时收敛"就永远测不到。
 * 模块注册表按文件隔离，这里可以让坏数据先于 import 就位。
 *
 * 反面证据（为什么不是"只断言 prune 存在"）：坏条目被真的删掉、近似计数被校正成真实
 * 条目数。把 `:23-24` 两行拿掉，本文件的断言全红。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { TranslationCache } from '../../src/core/cache';
import { chromeArea } from '../../src/shared/chrome-area';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';

const stub: ChromeStub = installChromeStub();

/** 形状坏掉的残留：连译文都读不出来（`readEntry` 不认），只有全量扫描才看得见。 */
const BROKEN = 'not-an-entry';

/** 让已经排队的微任务走完（prune 是 `void` 出去的，不 await 就没有落盘保证）。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  // 坏数据必须先于 import 就位：这两次 prune 只认 import 那一刻的存储内容。
  await stub.storage.local.set({
    'jt:good-local': { v: '本地译文', t: 1 },
    'jt:broken-local': BROKEN,
    'jt:meta': { n: 99 }, // `putMany` 只累加近似值，漂移成这样只有扫描能校正
  });
  await stub.storage.session.set({
    'jt:good-session': { v: '会话译文', t: 2 },
    'jt:broken-session': BROKEN,
    'jt:meta': { n: 77 },
  });

  await import('../../src/background/service-worker');
  await flush();
});

/** 存储区快照里的近似计数（`jt:meta` 的 `n`）。 */
function metaCount(area: 'local' | 'session'): unknown {
  return (stub.storage[area].snapshot()['jt:meta'] as { n?: unknown } | undefined)?.n;
}

/** 存储区快照里的全部缓存条目键。 */
function entryKeys(area: 'local' | 'session'): string[] {
  return Object.keys(stub.storage[area].snapshot()).filter((key) => key.startsWith('jt:') && key !== 'jt:meta');
}

describe('启动时的缓存对账', () => {
  it('local：清掉形状坏掉的条目，漂移的计数校正为真实条目数', async () => {
    expect(entryKeys('local')).toEqual(['jt:good-local']);
    // 坏条目不是条目：计数必须收敛到 1，而不是 99（漂移值）或 2（把坏记录也算上）。
    expect(metaCount('local')).toBe(1);
  });

  it('session：清掉形状坏掉的条目，漂移的计数校正为真实条目数', async () => {
    expect(entryKeys('session')).toEqual(['jt:good-session']);
    expect(metaCount('session')).toBe(1);
  });

  it('两块存储各自的真实条目数与计数一致（用真缓存反查形状）', async () => {
    for (const area of ['local', 'session'] as const) {
      // count() 走真实扫描、认条目形状；它与 prune 写下的计数必须一致。
      expect(await new TranslationCache(chromeArea(chrome.storage[area])).count()).toBe(metaCount(area));
    }
  });
});
