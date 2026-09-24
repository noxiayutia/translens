/**
 * 同一件事的两份独立实现：**这段时间里最多几个请求同时在飞**。
 *
 * 为什么要两份：`峰值在飞` 是宽窗口那一行验收判据的支点（它证明"阀没有永远摁在 1"），
 * 而它整个来源是假引擎日志里的 `[at, doneAt]` 区间。
 *
 * **但对账只防"两份实现算出不同的数"，防不了"日志本身记坏"** —— 实测过：把 `doneAt` 全记在
 * 最后一条日志上（读数陷阱第 7 条的形状），两份算法会**一致地**返回 1。数据坏了的时候
 * 一致没有意义。所以这一列的守法是三层，各管一段：
 *   1. `mock-selfcheck.mjs` 的**已知答案**用例：合成 4 路并发 ⇒ 必须读出 4（数据坏就红）；
 *   2. `run-429-scan.mjs` 每行的**日志体检**：没被拒的条目必须各自带 `doneAt`、区间不得短于
 *      设定延迟（坑 #7 的真实形状在这里红）；
 *   3. 这里的**两法对账**：算法分道扬镳时红（前两层都抓不到这一类）。
 *
 * 两份算法刻意不同形：扫描线（事件排序）对 覆盖中点（O(n²) 暴力）。
 */

/** 扫描线：起点 +1、终点 −1，同一时刻先处理 −1（区间端点相接不算重叠）。 */
export function peakBySweepLine(entries) {
  const points = [];
  for (const entry of entries) {
    const start = entry.at;
    const end = entry.doneAt ?? entry.at;
    points.push([start, 1], [end, -1]);
  }
  points.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  let now = 0;
  let peak = 0;
  for (const [, delta] of points) {
    now += delta;
    if (now > peak) peak = now;
  }
  return peak;
}

/** 暴力法：对每次请求，数有多少个区间盖住它的**中点**。 */
export function peakByMidpoints(entries) {
  let peak = 0;
  for (const a of entries) {
    const mid = a.at + ((a.doneAt ?? a.at) - a.at) / 2;
    let n = 0;
    for (const b of entries) if (b.at <= mid && (b.doneAt ?? b.at) >= mid) n += 1;
    if (n > peak) peak = n;
  }
  return peak;
}

/** 两法对账：相等就返回那个数，分道扬镳直接抛（读数一起带出来）。 */
export function peakInflight(entries) {
  const sweep = peakBySweepLine(entries);
  const midpoints = peakByMidpoints(entries);
  if (sweep !== midpoints) {
    throw new Error(
      `峰值在飞的两份实现分道扬镳：扫描线=${String(sweep)} 中点法=${String(midpoints)}（请求 ${String(entries.length)} 条）` +
        `——量具或日志坏了，这一轮的表全部作废，别抄读数`,
    );
  }
  return sweep;
}
