// tests/background/service-worker-startup.test.ts
/**
 * 启动对账：`export const cachesInitialized`（`src/background/service-worker.ts`）里的
 * 两次 `prune()` 是**模块级副作用**，只在 import 的那一瞬间跑一次——错过这个时机就再也
 * 补不上了。
 *
 * 所以它单独占一个测试文件，而不是并进 `service-worker.test.ts`：那边 `beforeEach`
 * 会 `reset()` 两块存储，坏数据在第一个用例开始前就被清掉，"启动时收敛"就永远测不到。
 * 模块注册表按文件隔离，这里可以让坏数据先于 import 就位。
 *
 * 反面证据（为什么不是"只断言 prune 存在"）：坏条目被真的删掉、近似计数被校正成真实
 * 条目数、而且裁剪用的是**设置里的**上限——把启动那两行 prune 拿掉，本文件的断言全红。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { TranslationCache } from '../../src/core/cache';
import { chromeArea } from '../../src/shared/chrome-area';
import { CURRENT_VERSION, SETTINGS_KEY } from '../../src/shared/settings';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';

const stub: ChromeStub = installChromeStub();

/** 形状坏掉的残留：连译文都读不出来（`readEntry` 不认），只有全量扫描才看得见。 */
const BROKEN = 'not-an-entry';

/**
 * 启动时按设置里的上限裁剪，而不是按 `DEFAULT_SETTINGS.cacheMaxEntries`（5000）。
 * `mergeSettings` 会把上限夹在 100..50000，所以这里取夹取后的下界，能放的最少条目数最小。
 */
const CONFIGURED_MAX_ENTRIES = 100;

/** 条目总数比上限多一条：裁剪是否生效只差在"最旧的那条还在不在"。 */
const TOTAL_ENTRIES = CONFIGURED_MAX_ENTRIES + 1;

/** 最旧的那条（`t` 为 0），超限裁剪按 `t` 从小到大删，它必须先出局。 */
const OLDEST_KEY = { local: 'jt:oldest-local', session: 'jt:oldest-session' };

/** 与新条目一起落盘的近似计数：只有全量扫描才能把它校正回真实值。 */
const DRIFTED_META = TOTAL_ENTRIES + 97;

/** `n` 条形状正确的条目，`t` 从 0 递增（0 号即最旧的那条）。 */
function validEntries(prefix: string, count: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    const key = index === 0 ? OLDEST_KEY[prefix as 'local' | 'session'] : `jt:${prefix}-${index}`;
    out[key] = { v: `${prefix} 译文 ${index}`, t: index };
  }
  return out;
}

/** 让已经排队的微任务走完（启动对账在 `queueMicrotask` 之后链出去）。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  // 坏数据 + 设置必须先于 import 就位：启动那两行只认 import 那一刻的存储内容。
  await stub.storage.local.set({
    [SETTINGS_KEY]: { version: CURRENT_VERSION, cacheMaxEntries: CONFIGURED_MAX_ENTRIES },
    ...validEntries('local', TOTAL_ENTRIES),
    'jt:broken-local': BROKEN,
    'jt:meta': { n: DRIFTED_META },
  });
  // 设置只存一份（`loadSettings` 读的是 local）：两块存储区共用同一个上限。
  await stub.storage.session.set({
    ...validEntries('session', TOTAL_ENTRIES),
    'jt:broken-session': BROKEN,
    'jt:meta': { n: DRIFTED_META },
  });

  const worker = await import('../../src/background/service-worker');
  await worker.cachesInitialized;
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
  it('local：清掉形状坏掉的条目，按设置里的上限裁剪，计数校正为真实条目数', async () => {
    expect(entryKeys('local')).toHaveLength(CONFIGURED_MAX_ENTRIES);
    // 坏条目出局、最旧的一条被上限裁掉，这两条都不该还留在存储里。
    expect(entryKeys('local')).not.toContain('jt:broken-local');
    expect(entryKeys('local')).not.toContain(OLDEST_KEY.local);
    // 计数必须收敛到真实条目数：漂移值 198 与"上限被当成 5000、一条都没裁"的 101 都不对。
    expect(metaCount('local')).toBe(CONFIGURED_MAX_ENTRIES);
  });

  it('session：清掉形状坏掉的条目，按设置里的上限裁剪，计数校正为真实条目数', async () => {
    expect(entryKeys('session')).toHaveLength(CONFIGURED_MAX_ENTRIES);
    expect(entryKeys('session')).not.toContain('jt:broken-session');
    expect(entryKeys('session')).not.toContain(OLDEST_KEY.session);
    expect(metaCount('session')).toBe(CONFIGURED_MAX_ENTRIES);
  });

  it('两块存储各自的真实条目数与计数一致（用真缓存反查形状）', async () => {
    for (const area of ['local', 'session'] as const) {
      // count() 走真实扫描、认条目形状；它与 prune 写下的计数必须一致。
      expect(await new TranslationCache(chromeArea(chrome.storage[area])).count()).toBe(metaCount(area));
    }
  });
});
