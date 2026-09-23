/**
 * 动态上限：`current()` 在**每次取任务之前**被重读，`max` 决定开几个 worker。
 * 给"飞行中改并发"用（撞限流时压到 1、恢复后阶梯涨回），见 `content/throttle.ts`。
 */
export interface DynamicLimit {
  current(): number;
  readonly max: number;
}

export type PoolLimit = number | DynamicLimit;

/**
 * 以最多 limit 个并发执行任务，返回结果数组，顺序与 tasks 一致。
 * 任务自身的异常会向上抛出（调用方负责在任务内部捕获）。
 *
 * limit 传数字时上限开局定死；传 {@link DynamicLimit} 时每个 worker 取任务前重读
 * `current()`，所以可以在飞行中压低或涨回。两种形态下 `current()` 都被夹在 `[1, max]`：
 * 返回 0 或 NaN 会把池锁死（一个任务都不再被取走），越过 max 则违背用户设定的上限。
 *
 * 数字形态同样要求「不小于 1 的有限数」：NaN 会算出 0 个 worker，
 * 静默返回一个全是 undefined 的数组，所以入口直接报错。
 */
export async function runPool<T>(tasks: Array<() => Promise<T>>, limit: PoolLimit): Promise<T[]> {
  const dynamic = typeof limit === 'object';
  const ceiling = dynamic ? limit.max : limit;
  if (!Number.isFinite(ceiling) || ceiling < 1) {
    throw new RangeError(`runPool 的 limit 必须是不小于 1 的有限数，收到 ${String(ceiling)}`);
  }
  const maxSlots = Math.max(1, Math.floor(ceiling));
  const slots = (): number => {
    if (!dynamic) return maxSlots;
    const raw = limit.current();
    const wanted = Number.isFinite(raw) ? Math.floor(raw) : 1;
    return Math.min(Math.max(wanted, 1), maxSlots);
  };

  const results: T[] = new Array(tasks.length);
  if (tasks.length === 0) return results;

  const workerCount = Math.max(1, Math.min(maxSlots, tasks.length));
  let cursor = 0;
  let active = 0;
  const waiters: Array<() => void> = [];

  const worker = async (): Promise<void> => {
    for (;;) {
      // 等到有空位再认领任务：先认领再等会把"已经排队的任务"也算进并发。
      for (;;) {
        if (cursor >= tasks.length) return;
        if (active < slots()) break;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      const index = cursor;
      cursor += 1;
      active += 1;
      try {
        results[index] = await tasks[index]();
      } finally {
        active -= 1;
        // **叫醒所有等待者**，不是只叫一个：等待者醒来后会自己再判一次"有没有位子"，
        // 没位子的继续睡（良性惊群）。只叫一个的话，`current()` 回升时没人通知它们，
        // 池会永远停在旧的低并发上——实测就是这么卡的。worker 数量以 max 为界，
        // 每次完成最多唤醒这么多个，代价可忽略。
        for (const wake of waiters.splice(0)) wake();
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
