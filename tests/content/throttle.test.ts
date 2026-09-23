/**
 * 限流降并发阀。时钟注入，不靠假定时器——这里要钉的是"从哪一档起步、什么时候降、
 * 什么时候升、升多少"，与浏览器怎么调度无关。
 *
 * 端到端那一条（429 之后腾出的位子不被下一批占走）在 `index.test.ts`：
 * 只测阀自己不算数，`runPool` 读的是 `current()`，接线断了单元全绿页面照样满并发。
 */
import { describe, expect, it } from 'vitest';
import { createThrottle } from '../../src/content/throttle';

function make(max: number, start = 1_000_000) {
  let clock = start;
  const throttle = createThrottle(max, { now: () => clock });
  return {
    throttle,
    current: () => throttle.current(),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('createThrottle：slow start', () => {
  /**
   * 第一次 429 之前没人知道服务商的窗口有多大。开局满宽（并发 8）意味着 7 路一定撞墙，
   * 而那 7 路各自的退避预算撑不到窗口空出来——真机扫描就是这么丢掉 96 段的。
   */
  it('开局从 min(max, 2) 起步，不是满宽', () => {
    expect(make(8).current()).toBe(2);
    expect(make(3).current()).toBe(2);
    expect(make(1).current()).toBe(1); // 用户只允许 1 路时不能被"起步 2"抬高
  });

  it('没有 429 时按档往上爬，爬到用户设定值封顶', () => {
    const { throttle, current } = make(8);
    expect(current()).toBe(2);
    for (let i = 0; i < 4; i += 1) throttle.succeeded();
    expect(current()).toBe(4);
    for (let i = 0; i < 4; i += 1) throttle.succeeded();
    expect(current()).toBe(8);
    for (let i = 0; i < 12; i += 1) throttle.succeeded();
    expect(current()).toBe(8);
  });

  /**
   * 一轮刚开始时**谁都没被降级过**，那句"距上次降级满 T 秒"就是空话：兜底时钟必须从
   * 这一轮开始算，否则时间这条腿会让 slow start 在第一批干净落地时就顶到用户设定值，
   * 开局满宽的后果（7 路一起撞墙）又回来了。
   *
   * 注入的时钟故意离 0 很远（`make` 的默认起点）：真实运行时是 `Date.now()`，
   * 初始值取 0 就等于"兜底早就满足了"，而上面那几条用例在这种实现下也是绿的——
   * 只有把起点推远才能把这条差异照出来。
   */
  it('开局没有降级过：时间兜底要等满 T 秒，第一批成功不翻倍', () => {
    const { throttle, current, advance } = make(8);
    throttle.succeeded();
    expect(current()).toBe(2);
    advance(29_000);
    throttle.succeeded();
    expect(current()).toBe(2);
    advance(2_000);
    throttle.succeeded();
    expect(current()).toBe(4);
  });
});

describe('createThrottle：降档', () => {
  it('撞一次限流只降一档（不是直接砸到 1），并重新数连续成功', () => {
    const { throttle, current } = make(8);
    for (let i = 0; i < 4; i += 1) throttle.succeeded();
    expect(current()).toBe(4);
    throttle.penalize();
    expect(current()).toBe(2);
    for (let i = 0; i < 3; i += 1) throttle.succeeded();
    expect(current()).toBe(2);
    throttle.succeeded();
    expect(current()).toBe(4);
  });

  it('连续两次 429 才砸到 1', () => {
    const { throttle, current } = make(8);
    throttle.penalize();
    expect(current()).toBe(1); // 起步就是 2，降一档到底
    throttle.succeeded();
    throttle.succeeded();
    throttle.succeeded();
    throttle.succeeded();
    expect(current()).toBe(2);
    throttle.penalize();
    throttle.penalize();
    expect(current()).toBe(1);
  });

  it('从高档连撞两次：8 → 4 → 1', () => {
    const { throttle, current } = make(8);
    for (let i = 0; i < 12; i += 1) throttle.succeeded();
    expect(current()).toBe(8);
    throttle.penalize();
    expect(current()).toBe(4);
    throttle.penalize();
    expect(current()).toBe(1);
  });
});

describe('createThrottle：回升', () => {
  it('阶梯回升：连续 4 批成功涨一倍，且永远不超过设定值', () => {
    const { throttle, current } = make(5);
    throttle.penalize();
    throttle.penalize();
    expect(current()).toBe(1);
    for (let i = 0; i < 3; i += 1) throttle.succeeded();
    expect(current()).toBe(1);
    throttle.succeeded();
    expect(current()).toBe(2);
    for (let i = 0; i < 4; i += 1) throttle.succeeded();
    expect(current()).toBe(4);
    for (let i = 0; i < 8; i += 1) throttle.succeeded();
    expect(current()).toBe(5); // 4×2=8 但封顶在 max
  });

  /** 只要还有批次以 429 收尾，回升就不该发生（清零连续计数就是这条规则的落地）。 */
  it('回升到一半再撞限流：降一档，并且重新数连续成功', () => {
    const { throttle, current } = make(8);
    for (let i = 0; i < 4; i += 1) throttle.succeeded();
    expect(current()).toBe(4);
    throttle.penalize();
    expect(current()).toBe(2);
    for (let i = 0; i < 3; i += 1) throttle.succeeded();
    expect(current()).toBe(2);
    throttle.succeeded();
    expect(current()).toBe(4);
  });

  /**
   * 一次限流风暴里多个批次会各自回报 429，被挂起重发的那一批也算一次。
   * 已经在最低档时重复降级只该算一次，否则恢复计数被一遍遍清零，页面永远出不来。
   */
  it('已经在 1 时重复降级不再重置恢复进度', () => {
    const { throttle, current } = make(3);
    throttle.penalize();
    throttle.penalize();
    expect(current()).toBe(1);
    for (let i = 0; i < 3; i += 1) throttle.succeeded();
    throttle.penalize();
    expect(current()).toBe(1);
    throttle.succeeded();
    expect(current()).toBe(2);
  });

  /** 慢页面（每批要几十秒）攒不满 K 批成功时，时间这条兜底保证它能爬回去。 */
  it('不足 K 批成功但距降级已过 T 秒：照样回升一档', () => {
    const { throttle, current, advance } = make(8);
    throttle.penalize();
    throttle.penalize();
    expect(current()).toBe(1);
    advance(29_000);
    throttle.succeeded();
    expect(current()).toBe(1);
    advance(2_000);
    throttle.succeeded();
    expect(current()).toBe(2);
  });

  /** 每档重新起表：时间兜底不该让并发一次从 1 顶到 max。 */
  it('回升的每一档都重新起表，不会一次顶满', () => {
    const { throttle, current, advance } = make(8);
    throttle.penalize();
    throttle.penalize();
    advance(31_000);
    throttle.succeeded();
    expect(current()).toBe(2);
    throttle.succeeded();
    expect(current()).toBe(2);
    advance(31_000);
    throttle.succeeded();
    expect(current()).toBe(4);
  });
});
