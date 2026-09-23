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

  it('limit 不是不小于 1 的有限数时报错而不是返回空洞结果', async () => {
    const tasks = [async () => 'a'];
    await expect(runPool(tasks, Number.NaN)).rejects.toThrow(RangeError);
    await expect(runPool(tasks, 0)).rejects.toThrow(RangeError);
    await expect(runPool(tasks, -1)).rejects.toThrow(RangeError);
  });

  /**
   * 动态上限：撞限流时把在飞的并发压下来，恢复后再涨回去。
   * 今天 `runPool` 的上限是开局定死的——"飞行中改并发"正是设计文档 §8 那一半没实现的根因。
   * `max` 决定开几个 worker，`current()` 决定同一时刻允许几个在跑。
   */
  describe('limit 是 { current, max }（每次取任务前重读 current）', () => {
    function tracked(count: number) {
      let active = 0;
      let peak = 0;
      const releases: Array<() => void> = [];
      const tasks = Array.from({ length: count }, () => async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) =>
          releases.push(() => {
            active -= 1;
            resolve();
          }),
        );
        return 'ok';
      });
      return {
        tasks,
        active: () => active,
        peak: () => peak,
        // 每放行一个都要先冲刷一次微任务：不然下一个任务还没被认领，
        // `releases` 是空的，shift 出来就是 undefined，测试会自己挂住。
        release: async (n = 1) => {
          for (let i = 0; i < n; i += 1) {
            releases.shift()?.();
            for (let k = 0; k < 10; k += 1) await Promise.resolve();
          }
        },
      };
    }

    it('current 降到 1 之后，在跑的只剩一个，且不会再涨回去', async () => {
      const pool = tracked(6);
      let limit = 3;
      const running = runPool(pool.tasks, { current: () => limit, max: 3 });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      expect(pool.active()).toBe(3);

      limit = 1;
      await pool.release(2);
      expect(pool.active()).toBe(1);
      expect(pool.peak()).toBe(3);

      await pool.release(1);
      expect(pool.active()).toBe(1);
      await pool.release(3);
      expect(await running).toEqual(Array.from({ length: 6 }, () => 'ok'));
    });

    it('current 回升后并发跟着回升，不需要重建池', async () => {
      const pool = tracked(6);
      let limit = 1;
      const running = runPool(pool.tasks, { current: () => limit, max: 3 });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      expect(pool.active()).toBe(1);

      limit = 3;
      await pool.release(1);
      expect(pool.active()).toBe(3);

      await pool.release(5);
      expect(await running).toHaveLength(6);
    });

    /** 回调写坏（0 / NaN / 超过 max）不能把池锁死，也不能越过用户设定值。 */
    it('current 返回非法值时按 [1, max] 夹紧', async () => {
      const pool = tracked(4);
      let limit = Number.NaN;
      const running = runPool(pool.tasks, { current: () => limit, max: 2 });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      expect(pool.active()).toBe(1); // NaN → 至少 1，不死锁

      limit = 99;
      await pool.release(1);
      expect(pool.active()).toBe(2); // 越界 → 顶到 max，不会开第三个

      await pool.release(3);
      expect(await running).toHaveLength(4);
    });
  });
});
