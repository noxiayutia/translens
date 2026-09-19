// tests/options/cache-section.test.ts
/**
 * @vitest-environment jsdom
 *
 * §3.7 缓存与请求：三个统计数字、缓存上限、高级折叠里的并发与批量。
 * 「清除」按钮本身的既有用例在 `options.test.ts`（文案与两层语义一字不改），这里补的是新增部分。
 *
 * 数字控件的保存时机是**提交（失焦 / 回车）**，不是每次敲键：`change` 原生只在提交时触发。
 * 计划里把这条写成"天然满足、不需要额外规则"，所以它没有对应的用例；下面单独补了一条
 * 「打字过程中存储一个字节都不变」，把这条纪律变成有读数的断言（原来只有人肉约定）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_VERSION, mergeSettings } from '../../src/shared/settings';
import {
  bubble,
  chromeStub,
  loadOptions,
  pick,
  resetOptionsPage,
  seedSettings,
  settle,
  storedSettings,
  waitFor,
} from './harness';

interface NumberFieldCase {
  id: string;
  field: 'cacheMaxEntries' | 'concurrency' | 'maxBatchChars' | 'maxSegmentsPerBatch';
  min: number;
  max: number;
}

const NUMBER_FIELDS: NumberFieldCase[] = [
  { id: 'cache-max-entries', field: 'cacheMaxEntries', min: 100, max: 50000 },
  { id: 'concurrency', field: 'concurrency', min: 1, max: 8 },
  { id: 'max-batch-chars', field: 'maxBatchChars', min: 200, max: 8000 },
  { id: 'max-segments-per-batch', field: 'maxSegmentsPerBatch', min: 1, max: 50 },
];

/** 四个数字控件都是 `<input type="number">`，统一按数字输入框取。 */
function inputOf(id: string): HTMLInputElement {
  return pick<HTMLInputElement>(id);
}

/** 「清除」按钮：同一页里还有别的 `<button>`，按 id 取更稳。 */
function buttonOf(id: string): HTMLButtonElement {
  return pick<HTMLButtonElement>(id);
}

function status(): HTMLElement {
  return pick<HTMLElement>('cache-status');
}

/** 填一个数字并"失焦"：值改掉 → 派发冒泡的 change。 */
function commitNumber(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(bubble('change'));
}

beforeEach(() => {
  resetOptionsPage();
});

describe('设置页：缓存与请求', () => {
  it('三个统计数字：已缓存是两层合计，上限与并发跟着设置走', async () => {
    await seedSettings({ cacheMaxEntries: 5000, concurrency: 3 });
    await chromeStub.storage.local.set({
      'jt:a': { v: '一', t: 1 },
      'jt:b': { v: '二', t: 2 },
    });
    await chromeStub.storage.session.set({ 'jt:s': { v: '会话层', t: 3 } });
    await loadOptions();

    await waitFor(() => pick<HTMLElement>('stat-cached').textContent === '3');
    expect(pick<HTMLElement>('stat-max').textContent).toBe('5000');
    expect(pick<HTMLElement>('stat-concurrency').textContent).toBe('3');
  });

  it('清除之后统计归零（按钮的既有文案一字不改）', async () => {
    await seedSettings();
    await chromeStub.storage.local.set({ 'jt:a': { v: '一', t: 1 } });
    await loadOptions();
    await waitFor(() => pick<HTMLElement>('stat-cached').textContent === '1');

    buttonOf('clear-cache').click();

    await waitFor(() => (status().textContent ?? '').includes('已清除 1 条翻译缓存'));
    await waitFor(() => pick<HTMLElement>('stat-cached').textContent === '0');
  });

  it('缓存上限改动即落盘，统计里的「上限」跟着变', async () => {
    await seedSettings({ cacheMaxEntries: 5000 });
    await loadOptions();

    commitNumber(inputOf('cache-max-entries'), '9000');

    await waitFor(async () => (await storedSettings()).cacheMaxEntries === 9000);
    // `waitFor` 是"存储已经写进去了"，而界面回填发生在**那次 await 之后**的同一个续跑里；
    // 这里再让排队的微任务跑完，读的才是界面稳态（不是"等它，等不到就绿"）。
    await settle();
    expect(pick<HTMLElement>('stat-max').textContent).toBe('9000');
    expect(inputOf('cache-max-entries').value).toBe('9000');
  });

  it('打字过程中存储一个字节都不变；只有提交（change）才落盘', async () => {
    await seedSettings({ concurrency: 3 });
    await loadOptions();
    const before = await storedSettings();

    // 逐字敲入的过程：只派发 `input`，不派发 `change`（真实打字就是这样）。
    const input = inputOf('concurrency');
    for (const typed of ['5', '50', '500']) {
      input.value = typed;
      input.dispatchEvent(bubble('input'));
      // 让排队的微任务跑完：若监听挂在 `input` 上，这里已经足够它写进存储。
      await settle();
      expect((await storedSettings()).concurrency).toBe(3);
    }
    // 逐字段比整份存储：任何一次写入都会同时动 version 或 value，两个维度都盖上。
    expect(await storedSettings()).toEqual(before);

    // 提交那一下才写，并且写的是提交时输入框里的值。
    commitNumber(input, '5');
    await waitFor(async () => (await storedSettings()).concurrency === 5);
  });

  it('越界的数字被夹到允许范围：存储里是生效值，输入框回填生效值，并说清实际生效多少', async () => {
    await seedSettings({ concurrency: 3 });
    await loadOptions();

    commitNumber(inputOf('concurrency'), '999');

    await waitFor(async () => (await storedSettings()).concurrency === 8);
    await settle();
    // 界面不许继续显示 999：那是个没生效的数字。
    expect(inputOf('concurrency').value).toBe('8');
    expect(status().textContent).toContain('实际生效 8');
    expect(pick<HTMLElement>('stat-concurrency').textContent).toBe('8');
  });

  it('清空或乱填：拨回存储里真正生效的值并报错，不写存储', async () => {
    await seedSettings({ maxBatchChars: 1000 });
    await loadOptions();

    commitNumber(inputOf('max-batch-chars'), '');

    await waitFor(() => status().dataset.kind === 'err');
    await settle();
    expect(inputOf('max-batch-chars').value).toBe('1000');
    expect((await storedSettings()).maxBatchChars).toBe(1000);

    commitNumber(inputOf('max-batch-chars'), 'abc');
    await waitFor(() => (status().textContent ?? '').includes('要填一个数字'));
    await settle();
    expect(inputOf('max-batch-chars').value).toBe('1000');
  });

  it('四个数字的 min/max 与存储层的夹取范围同源（两处各写了一份，这是防漂移的那条断言）', async () => {
    // 夹具的顺序是"装 DOM → import → 等初始化"：这条断言查的是**静态属性**，不依赖
    // 设置读没读出来，但元素本身得先在 DOM 里（这一步不写存储、只挂 DOM 与监听器）。
    await loadOptions();

    for (const entry of NUMBER_FIELDS) {
      const input = inputOf(entry.id);
      expect(`${entry.id} min=${input.min}`).toBe(`${entry.id} min=${entry.min}`);
      expect(`${entry.id} max=${input.max}`).toBe(`${entry.id} max=${entry.max}`);
      // 夹取边界必须与 mergeSettings 的实际行为一致：低一档被抬到 min，高一档被压到 max。
      const low = mergeSettings({ [entry.field]: entry.min - 1 }, CURRENT_VERSION)[entry.field];
      const high = mergeSettings({ [entry.field]: entry.max + 1 }, CURRENT_VERSION)[entry.field];
      expect(`${entry.field} low=${low}`).toBe(`${entry.field} low=${entry.min}`);
      expect(`${entry.field} high=${high}`).toBe(`${entry.field} high=${entry.max}`);
    }
  });

  it('高级项默认收在 details 里，三项都在；改动即落盘', async () => {
    await seedSettings();
    await loadOptions();

    expect(pick<HTMLDetailsElement>('cache-advanced').open).toBe(false);
    expect(inputOf('concurrency').value).toBe('3');
    expect(inputOf('max-batch-chars').value).toBe('1000');
    expect(inputOf('max-segments-per-batch').value).toBe('12');

    commitNumber(inputOf('max-segments-per-batch'), '20');
    await waitFor(async () => (await storedSettings()).maxSegmentsPerBatch === 20);
  });

  it('写入被拒时把输入框拨回真正生效的值并报错', async () => {
    await seedSettings({ concurrency: 3 });
    await loadOptions();
    chromeStub.storage.local.set = async () => {
      throw new Error('存储写入失败');
    };

    commitNumber(inputOf('concurrency'), '5');

    await waitFor(() => status().dataset.kind === 'err');
    await settle();
    expect(status().textContent).toContain('保存并发请求数失败');
    expect(inputOf('concurrency').value).toBe('3');
  });
});
