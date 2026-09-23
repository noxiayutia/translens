/**
 * 限流降并发阀（设计文档 §8 里"429 时临时降并发"那一半）。
 *
 * 作用域是**一轮翻译的池**：单元 E 之后只剩一个适配器但有多个档案，429 是按服务商/
 * 档案计的，而一轮翻译只用一个档案，所以"这一轮的池"就是正确的粒度。
 * **跨标签页、跨轮次都不共享降级状态**（故意的）：别的标签页的限流风暴罕见且自限，
 * 为它把状态搬到后台共享，换来的会是"一个页面被限流拖慢另一个页面"这种新的怪事。
 *
 * **slow start**：开局从 `min(max, 2)` 起步，不是满宽。第一次 429 之前没人知道服务商
 * 的窗口有多大，而真机扫描证明满宽的代价是具体的——并发 8 撞 1 格窗口时有 7 路同时
 * 撞墙，它们的退避预算（那时尚且只有 500ms/1500ms）撑不到窗口空出来，于是 96 段永久变红。
 * 之后按下面的"恢复是阶梯"那一档一档往上爬，封顶在用户设定值。
 *
 * **降档而不是砸到底**：一次 429 只降一档；连续两次才砸到 1（一次多半是偶发抖动，
 * 连着两次说明窗口确实比当前档窄）。已经在 1 时重复降级是空操作——一次风暴里多个
 * 批次各自回报 429、加上被挂起重发的那一批，全算成一次，否则恢复计数被一遍遍清零，
 * 页面永远出不来。
 *
 * **恢复是阶梯**：连续 K 批干净落地、或距上次降级满 T 秒（这一轮从没被降级过时从轮次
 * 开始算）才翻倍一档；每一档重新起表。回升的拦路虎是**新的降级**：还在 1 以上时一次
 * 429 就把连续计数清零，回升重新起表；已经在最低档 1 时后续 429 按上一段的规定只算
 * 一次风暴、不清零——那正是"持续限流"的形状，清零会让这一轮永远爬不回来。
 */
const START_TIERS = 2;
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

  let allowed = Math.min(ceiling, START_TIERS);
  let cleanSuccesses = 0;
  let consecutivePenalties = 0;
  /**
   * 时间兜底的起点。**从这一轮开始算**，不是 0：0 配上 `Date.now()` 会让"距上次降级满
   * T 秒"在第一个干净批次上就成立，slow start 当场被跳过（真机用例就是这么暴露的）。
   */
  let penalizedAt = now();

  return {
    max: ceiling,
    current: () => allowed,
    penalize(): void {
      // 已经在最低档：一次风暴里的后续 429（含被挂起重发的那一批）只算一次。
      if (allowed === 1) return;
      consecutivePenalties += 1;
      allowed =
        consecutivePenalties >= 2 ? 1 : Math.max(1, Math.floor(allowed / 2));
      cleanSuccesses = 0;
      penalizedAt = now();
    },
    succeeded(): void {
      // 干净落地就把"连续 429"这条链断掉：下一次 429 该重新从"降一档"开始算。
      consecutivePenalties = 0;
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
