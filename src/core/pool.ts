/**
 * 以最多 limit 个并发执行任务，返回结果数组，顺序与 tasks 一致。
 * 任务自身的异常会向上抛出（调用方负责在任务内部捕获）。
 */
export async function runPool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  if (tasks.length === 0) return results;

  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
