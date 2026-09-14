// tests/background/service-worker-startup-settings-broken.test.ts
/**
 * 设置读不出来时，启动对账必须**整次跳过**。
 *
 * 缓存实例上的 `maxEntries` 默认是 5000，而 `mergeSettings` 把用户配置夹在 100..50000。
 * 如果设置读失败还照默认的 5000 去 prune，一位把上限设成 100 的用户在冷启动时就会被
 * 静默删掉几千条缓存——那是真删用户数据。触发场景不需要人为构造：用户回退到旧版本时，
 * 存储里的 `version` 会高于本代码，`loadSettings` 正是据此抛错。
 * 跳过的代价只是近似计数晚一轮收敛，比删错安全得多。
 *
 * 反面证据：把 `if (!settings) return;` 拿掉，本文件的断言全红。
 *
 * 与 `service-worker-startup.test.ts` 一样单独占一个文件：这里的坏设置必须在 import
 * 之前就位，而那边 `beforeEach` 会清存储。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SETTINGS_KEY } from '../../src/shared/settings';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';

const stub: ChromeStub = installChromeStub();

/** 比当前代码支持的版本高：`loadSettings` 据此抛错，`startupSettings` 因此是 undefined。 */
const FUTURE_VERSION = 9999;

const ENTRY_COUNT = 120;
const BROKEN_KEY = 'jt:broken-local';
const DRIFTED_META = 7;

function entries(count: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    out[`jt:local-${index}`] = { v: `译文 ${index}`, t: index };
  }
  return out;
}

/** 让已经排队的微任务走完（启动对账在 `queueMicrotask` 之后链出去）。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  await stub.storage.local.set({
    [SETTINGS_KEY]: { version: FUTURE_VERSION, cacheMaxEntries: 100 },
    ...entries(ENTRY_COUNT),
    [BROKEN_KEY]: 'not-an-entry',
    'jt:meta': { n: DRIFTED_META },
  });

  const worker = await import('../../src/background/service-worker');
  await worker.cachesInitialized;
  await flush();
});

describe('设置读不出来时的启动对账', () => {
  it('整次对账被跳过：条目一条不删，近似计数也不改写', () => {
    const snapshot = stub.storage.local.snapshot();
    const entryKeys = Object.keys(snapshot).filter(
      (key) => key.startsWith('jt:') && key !== 'jt:meta',
    );

    // 120 条正常条目 + 1 条形状坏掉的，全部原样留着：既没按默认上限 5000 裁（本来也不会裁），
    // 也没清坏条目。
    expect(entryKeys).toHaveLength(ENTRY_COUNT + 1);
    expect(entryKeys).toContain(BROKEN_KEY);
    // 计数保持漂移值。prune 一旦跑过就会把它写成真实条目数，这条是"根本没跑"的直接证据。
    expect((snapshot['jt:meta'] as { n?: unknown }).n).toBe(DRIFTED_META);
  });
});
