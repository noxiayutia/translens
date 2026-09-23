/**
 * 看门狗的独立单测。用**注入的时钟**而不是假定时器：这里要钉的是"缺口怎么算、什么时候
 * 该叫醒谁"，让 `now` 由用例自己拨比模拟 Chrome 冻结更直白（冻结的端到端复现在
 * `index.test.ts` 的「页面曾被冻结」那条——那里必须用 `setSystemTime` 才能造出
 * "墙上时间跳、回调不跑"的形态，`advanceTimersByTime` 会让两者同步、永远测不出来）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createFreezeWatchdog } from '../../src/content/freeze-watchdog';

function harness(start = 1_000_000) {
  let clock = start;
  const fired: number[] = [];
  const watchdog = createFreezeWatchdog(() => clock);
  const add = (label: number) => watchdog.add(() => fired.push(label));
  return { watchdog, fired, add, advance: (ms: number) => (clock += ms) };
}

describe('createFreezeWatchdog', () => {
  it('正常心跳（每次只隔一个 tick）不算冻结，谁都不该被叫醒', () => {
    const { watchdog, fired, add, advance } = harness();
    add(1);
    for (let i = 0; i < 20; i += 1) {
      advance(5_000);
      watchdog.tick();
    }
    expect(fired).toEqual([]);
  });

  /**
   * 真机读数：隐藏页的定时器被节流到每分钟一次，所以 60 秒缺口是**正常节奏**。
   * 把它当冻结会让每一批都被重发一遍、请求数翻倍——这条是防止阈值退回 30 秒的守卫。
   */
  it('60 秒缺口不报（那是隐藏页被节流后的正常心跳节奏）', () => {
    const { watchdog, fired, add, advance } = harness();
    add(1);
    for (let i = 0; i < 5; i += 1) {
      advance(60_000);
      watchdog.tick();
    }
    expect(fired).toEqual([]);
  });

  it('缺口达到阈值才报，且每个在飞的批次各报一次', () => {
    const { watchdog, fired, add, advance } = harness();
    add(1);
    add(2);
    advance(5_000);
    watchdog.tick();
    // 124 秒：只比「120 秒 + 一个 tick」少 1 秒，仍不该动手。
    advance(124_000);
    watchdog.tick();
    expect(fired).toEqual([]);
    advance(130_000);
    watchdog.tick();
    expect(fired.sort()).toEqual([1, 2]);
  });

  /** 一轮刚开始就立刻报冻结是假话：那只是上一批收尾到这一批开始之间的正常空闲。 */
  it('刚登记的批次不会被当成冻结', () => {
    const { watchdog, fired, add, advance } = harness();
    add(1);
    advance(90_000);
    add(2);
    advance(5_000);
    watchdog.tick();
    expect(fired).toEqual([]);
  });

  it('没有在飞的批次时不报（页面已经翻完了，冻不冻都无所谓）', () => {
    const { watchdog, fired, add, advance } = harness();
    const ticket = add(1);
    watchdog.remove(ticket);
    advance(120_000);
    watchdog.tick();
    expect(fired).toEqual([]);
  });

  it('全部批次注销后定时器被清掉：不给每个 http 页面留一个常驻心跳', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    const watchdog = createFreezeWatchdog(() => Date.now());
    const a = watchdog.add(() => {});
    const b = watchdog.add(() => {});
    expect(spy).toHaveBeenCalledTimes(1);
    watchdog.remove(a);
    expect(vi.getTimerCount()).toBe(1); // 还有 b 在飞，心跳不能停
    watchdog.remove(b);
    expect(vi.getTimerCount()).toBe(0);
    spy.mockRestore();
    vi.useRealTimers();
  });
});
