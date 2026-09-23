/**
 * 限流降并发阀。时钟注入，不靠假定时器——这里要钉的是"什么时候降、什么时候升、
 * 升多少"，与浏览器怎么调度无关。
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

describe('createThrottle', () => {
  it('开局就是用户设定值；没降级过时 succeeded 什么都不做', () => {
    const { throttle, current } = make(3);
    expect(current()).toBe(3);
    for (let i = 0; i < 20; i += 1) throttle.succeeded();
    expect(current()).toBe(3);
  });

  it('撞一次限流降到 1', () => {
    const { throttle, current } = make(3);
    throttle.penalize();
    expect(current()).toBe(1);
  });

  it('阶梯回升：连续 4 批成功涨一倍，且永远不超过设定值', () => {
    const { throttle, current } = make(5);
    throttle.penalize();
    for (let i = 0; i < 3; i += 1) throttle.succeeded();
    expect(current()).toBe(1);
    throttle.succeeded();
    expect(current()).toBe(2);
    for (let i = 0; i < 4; i += 1) throttle.succeeded();
    expect(current()).toBe(4);
    for (let i = 0; i < 8; i += 1) throttle.succeeded();
    expect(current()).toBe(5); // 4×2=8 但封顶在 max
  });

  it('回升到一半再撞限流：回到 1，并且重新数连续成功', () => {
    const { throttle, current } = make(8);
    throttle.penalize();
    for (let i = 0; i < 4; i += 1) throttle.succeeded();
    expect(current()).toBe(2); // 已经回升了一档

    throttle.penalize(); // 这次是在 2 上撞的，该真的降级并清零进度
    expect(current()).toBe(1);
    for (let i = 0; i < 3; i += 1) throttle.succeeded();
    expect(current()).toBe(1);
    throttle.succeeded();
    expect(current()).toBe(2);
  });

  /**
   * 一次限流风暴里，多个批次会各自回报 429，被挂起重发的那一批也算一次。
   * 重复降级只该算一次，否则恢复计数被一遍遍清零，用户被按在 1 路并发上出不来。
   */
  it('已经在 1 时重复降级不再重置恢复进度', () => {
    const { throttle, current } = make(3);
    throttle.penalize();
    for (let i = 0; i < 3; i += 1) throttle.succeeded();
    throttle.penalize(); // 风暴里的第二个 429：已经在 1，不该把进度抹掉
    expect(current()).toBe(1);
    throttle.succeeded();
    expect(current()).toBe(2);
  });

  /** 慢页面（每批要几十秒）攒不满 K 批成功时，时间这条兜底保证它能爬回去。 */
  it('不足 K 批成功但距降级已过 T 秒：照样回升一档', () => {
    const { throttle, current, advance } = make(8);
    throttle.penalize();
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
    advance(31_000);
    throttle.succeeded();
    expect(current()).toBe(2);
    throttle.succeeded();
    expect(current()).toBe(2); // 时间刚重置，得再等满 T 或攒够 K 批
    advance(31_000);
    throttle.succeeded();
    expect(current()).toBe(4);
  });
});
