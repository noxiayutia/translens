// tests/options/dom.test.ts
/**
 * @vitest-environment jsdom
 *
 * `dom.ts` 是**每个区块都依赖**的共享件。这里给它的错误路径直连用例：
 * - `runSafely` 的拒绝必须变成状态行里的一句话（否则就是一次未处理拒绝）；
 * - `requireWithin` 找不到控件时必须当场抛错（选择器写错要立刻炸，不能静默返回空）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { element, fillSelect, requireWithin, runSafely, setStatus } from '../../src/options/dom';

/** 造一条状态行挂进 body（`setStatus` / `runSafely` 都只认这个元素）。 */
function statusLine(): HTMLElement {
  const line = document.createElement('p');
  document.body.append(line);
  return line;
}

/** 让已经排队的微任务跑完。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('dom：状态行、拒绝兜底、控件查找', () => {
  it('setStatus 写 data-kind 与文本，且一律走 textContent（尖括号只是字符）', () => {
    const line = statusLine();
    setStatus(line, 'err', '<b>不是 HTML</b>');
    expect(line.dataset.kind).toBe('err');
    expect(line.textContent).toBe('<b>不是 HTML</b>');
    expect(line.children).toHaveLength(0);
  });

  it('runSafely 把拒绝格式化成「前缀：原因」，兑现的 promise 一个字节都不写', async () => {
    const line = statusLine();
    runSafely(line, '保存失败', async () => {
      throw new Error('存储写入失败');
    });
    await settle();
    expect(line.dataset.kind).toBe('err');
    expect(line.textContent).toBe('保存失败：存储写入失败');

    // 成功路径不该碰状态行：先自己写一句，跑一个成功的 runSafely，那句必须原样留着。
    setStatus(line, 'ok', '已保存');
    runSafely(line, '保存失败', async () => undefined);
    await settle();
    expect(line.textContent).toBe('已保存');
    expect(line.dataset.kind).toBe('ok');
  });

  it('requireWithin 找不到元素时抛错，并把选择器写进消息', () => {
    const root = element('div', 'profile-editor');
    root.append(element('span', 'profile-label', '名字'));
    expect(requireWithin(root, '.profile-label').textContent).toBe('名字');
    expect(() => requireWithin(root, '.missing')).toThrow('.missing');
  });

  it('fillSelect 重建选项并选中匹配的那一项（选项清单不手抄）', () => {
    const select = document.createElement('select');
    select.append(new Option('旧的', 'old'));
    fillSelect(select, [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }], 'b');
    expect(Array.from(select.options).map((option) => [option.value, option.textContent])).toEqual([
      ['a', '甲'],
      ['b', '乙'],
    ]);
    expect(select.value).toBe('b');
  });
});
