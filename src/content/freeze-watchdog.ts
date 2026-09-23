/**
 * 挂起缺口看门狗：发现"这个页面刚刚被浏览器长时间挂起过"。
 *
 * 为什么需要它（真机读数，`.qa/p0-probe.mjs`）：标签页切到后台约 90 秒后，Chrome 153
 * 把渲染进程的定时器节流到**每分钟一次**——18 批 / 并发 3 的一轮，前台理论值 270 秒，
 * 隐藏后实测拉到 360 秒，而这期间页面始终显示「翻译中…」。更长的挂起（系统休眠、
 * 标签页被丢弃）里连这条超时都不会按时触发，因为**超时本身就是一条页面定时器**。
 *
 * 它是**保险，不是主治**：只在页面连续漏跳两次以上（≥120 秒，见下面 GAP_MS 的实测依据）
 * 时才动手，把那批标成"曾被挂起、已重发"并重发一次。真正的解药是把批次编排挪出会被
 * 节流的页面——那是另一个量级的改动，而且设计文档 §3 把编排放在内容脚本里正是为了
 * 躲 SW 被回收，两害相权要单独论证。
 *
 * 只在有一轮翻译在飞时挂着（`add`/`remove`）——内容脚本跑在每一个 http 页面上，
 * 一个常驻的 5 秒定时器等于给全站用户加背景功耗。
 */
const TICK_MS = 5_000;
/**
 * 判定"被冻过"的缺口下限。
 *
 * **这个数是被真机读数逼出来的，不是拍的**（`.qa/p0-probe.mjs`）：标签页切到后台约
 * 90 秒后，Chrome 153 把渲染进程的定时器节流到**每分钟一次**——探针实测的 tick 间隔
 * 序列是 `…998, 24003, 60000, 59994, 60001, 60008, 59995`。也就是说
 * **60 秒的缺口是隐藏页的正常节奏**，把它当冻结会让每一批都被重发一遍，请求数直接翻倍
 * （代价从"等得久"变成"烧双倍额度"，更糟）。
 *
 * 所以这里取 120 秒：容忍两次以上的连续漏跳，只有真正长时间没醒（系统休眠、标签页被
 * 挂起后又被切回来）才判定为冻结。
 */
const GAP_MS = 120_000;

export interface FreezeWatchdog {
  /** 登记一个在飞批次，返回用于注销的票据号；发现冻结时它的 `onFrozen` 会被调用。 */
  add(onFrozen: () => void): number;
  remove(ticket: number): void;
  /** 只给测试用：手动跑一次心跳（真机上由定时器驱动）。 */
  tick(): void;
}

/**
 * @param now 时钟（默认 `Date.now`，测试可注入）
 */
export function createFreezeWatchdog(now: () => number = () => Date.now()): FreezeWatchdog {
  const live = new Map<number, () => void>();
  let nextTicket = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastTickAt = now();

  const tick = (): void => {
    const at = now();
    const gap = at - lastTickAt;
    lastTickAt = at;
    // 容忍一次心跳本身的抖动：真正的冻结远大于 TICK_MS。
    // 没有在飞的批次时什么都不做——页面已经翻完了，冻不冻都无所谓。
    if (gap < GAP_MS + TICK_MS || live.size === 0) return;
    for (const onFrozen of [...live.values()]) onFrozen();
  };

  return {
    add(onFrozen: () => void): number {
      const ticket = nextTicket;
      nextTicket += 1;
      live.set(ticket, onFrozen);
      // 新一批开始就把心跳基准重置成"现在"：上一批收尾与这一批开始之间的正常空闲
      // 不该被算成冻结。
      lastTickAt = now();
      if (timer === null) timer = setInterval(tick, TICK_MS);
      return ticket;
    },
    remove(ticket: number): void {
      live.delete(ticket);
      if (live.size === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick,
  };
}
