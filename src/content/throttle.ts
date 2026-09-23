/**
 * 限流降并发阀（设计文档 §8 里"429 时临时把并发降到 1"那一半，此前一直没实现）。
 *
 * 作用域是**一轮翻译的池**：单元 E 之后只剩一个适配器但有多个档案，429 是按服务商/
 * 档案计的，而一轮翻译只用一个档案，所以"这一轮的池"就是正确的粒度。
 * **跨标签页、跨轮次都不共享降级状态**（故意的）：另一个标签页的限流风暴罕见且自限，
 * 为它把状态搬到后台共享不值——换来的是"一个页面被限流拖慢另一个页面"这种新的怪事。
 *
 * 恢复是**阶梯式**的，不是一步跳回满并发：连续 K 批成功、或距上次降级满 T 秒没有
 * 新的 429，才翻倍一档，且永远不超过用户设定的 `max`。一步跳回去等于对着还没
 * 平息的限流窗口再砸一次同样的并发。
 */
const RECOVER_AFTER_SUCCESSES = 4;
const RECOVER_AFTER_MS = 30_000;

export interface Throttle {
  /** 当前允许的并发，给 `runPool` 的 `DynamicLimit` 用。 */
  current(): number;
  /** 用户设定值，永远不被超过。 */
  readonly max: number;
  /** 撞了一次限流。 */
  penalize(): void;
  /** 一批干净地落地了（没有 429）。 */
  succeeded(): void;
}

export function createThrottle(
  max: number,
  opts: { recoverAfterSuccesses?: number; recoverAfterMs?: number; now?: () => number } = {},
): Throttle {
  const ceiling = Math.max(1, Math.floor(max));
  const needSuccesses = opts.recoverAfterSuccesses ?? RECOVER_AFTER_SUCCESSES;
  const afterMs = opts.recoverAfterMs ?? RECOVER_AFTER_MS;
  const now = opts.now ?? (() => Date.now());

  let allowed = ceiling;
  let cleanSuccesses = 0;
  let penalizedAt = 0;

  return {
    max: ceiling,
    current: () => allowed,
    penalize(): void {
      /**
       * 已经在最低档时**不重复计**：一次限流风暴里多个批次会各自回报 429，
       * 被挂起重发的那一批也算一次（重发不是新的请求风暴）。重复降级只会把
       * 恢复计数一遍遍清零，把用户按在 1 路并发上出不来。
       */
      if (allowed === 1) return;
      allowed = 1;
      cleanSuccesses = 0;
      penalizedAt = now();
    },
    succeeded(): void {
      if (allowed >= ceiling) return;
      cleanSuccesses += 1;
      const heldOffLongEnough = now() - penalizedAt >= afterMs;
      if (cleanSuccesses < needSuccesses && !heldOffLongEnough) return;
      allowed = Math.min(ceiling, allowed * 2);
      cleanSuccesses = 0;
      // 每一档重新起表：回升到 max 需要同样多的连续成功，而不是一次 429 之后
      // 攒够 K 批就一路直接顶满。
      penalizedAt = now();
    },
  };
}
