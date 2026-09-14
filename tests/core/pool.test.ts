import { describe, expect, it } from 'vitest';
import { runPool } from '../../src/core/pool';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('runPool', () => {
  it('空任务返回空数组', async () => {
    expect(await runPool([], 3)).toEqual([]);
  });

  it('结果顺序与任务顺序一致', async () => {
    const tasks = [
      async () => 'a',
      async () => 'b',
      async () => 'c',
    ];
    expect(await runPool(tasks, 1)).toEqual(['a', 'b', 'c']);
  });

  it('并发数不超过上限', async () => {
    let running = 0;
    let peak = 0;
    const gate = deferred<void>();
    const tasks = Array.from({ length: 6 }, () => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
      return 'ok';
    });
    const pending = runPool(tasks, 2);
    await Promise.resolve();
    expect(peak).toBeLessThanOrEqual(2);
    gate.resolve();
    expect(await pending).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  });

  it('并发上限大于任务数时也能跑完', async () => {
    const tasks = [async () => 1, async () => 2];
    expect(await runPool(tasks, 10)).toEqual([1, 2]);
  });
});
