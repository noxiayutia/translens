import { describe, expect, it } from 'vitest';
import { joinPieces, planBatches, splitBySentence, type TextSegment } from '../../src/core/segmenter';

function seg(id: string, text: string, order = 0): TextSegment {
  return { id, text, order };
}

const OPTIONS = { maxBatchChars: 100, maxSegmentsPerBatch: 3 };

describe('planBatches', () => {
  it('空输入返回空批次', () => {
    expect(planBatches([], OPTIONS)).toEqual([]);
  });

  it('相邻短段合并为一批', () => {
    const batches = planBatches([seg('a', 'x'.repeat(10)), seg('b', 'x'.repeat(10))], OPTIONS);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('超过字符上限时切批', () => {
    const batches = planBatches(
      [seg('a', 'x'.repeat(60)), seg('b', 'x'.repeat(60))],
      OPTIONS,
    );
    expect(batches.map((b) => b.map((s) => s.id))).toEqual([['a'], ['b']]);
  });

  it('预算计入每段的编号包装开销', () => {
    const batches = planBatches(
      [seg('a', 'x'.repeat(45)), seg('b', 'x'.repeat(45))],
      OPTIONS,
    );
    expect(batches.map((b) => b.map((s) => s.id))).toEqual([['a'], ['b']]);
  });

  it('超过段数上限时切批', () => {
    const batches = planBatches(
      [seg('a', 'x'), seg('b', 'x'), seg('c', 'x'), seg('d', 'x')],
      OPTIONS,
    );
    expect(batches.map((b) => b.map((s) => s.id))).toEqual([['a', 'b', 'c'], ['d']]);
  });

  it('超长段独占一批，不与前后合并', () => {
    const batches = planBatches(
      [seg('a', 'x'.repeat(10)), seg('long', 'x'.repeat(200)), seg('b', 'x'.repeat(10))],
      OPTIONS,
    );
    expect(batches.map((b) => b.map((s) => s.id))).toEqual([['a'], ['long'], ['b']]);
  });

  it('保持原始顺序', () => {
    const batches = planBatches(
      [seg('a', 'x'.repeat(60)), seg('b', 'x'.repeat(10)), seg('c', 'x'.repeat(60))],
      OPTIONS,
    );
    expect(batches.flat().map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('splitBySentence', () => {
  it('短文本不切分', () => {
    expect(splitBySentence('Hello world.', 100)).toEqual(['Hello world.']);
  });

  it('中文按句号切分', () => {
    expect(splitBySentence('第一句。第二句。第三句。', 6)).toEqual(['第一句。', '第二句。', '第三句。']);
  });

  it('英文按句末标点切分', () => {
    expect(splitBySentence('One. Two. Three.', 8)).toEqual(['One. ', 'Two. ', 'Three.']);
  });

  it('没有句子边界时硬切', () => {
    const pieces = splitBySentence('x'.repeat(25), 10);
    expect(pieces).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('切分后不丢字符', () => {
    const text = '第一句。第二句。第三句。第四句。';
    expect(splitBySentence(text, 5).join('')).toBe(text);
  });

  it('maxLen 非法时报错而不是死循环', () => {
    expect(() => splitBySentence('abc', 0)).toThrow(RangeError);
    expect(() => splitBySentence('abc', -1)).toThrow(RangeError);
    expect(() => splitBySentence('abc', Number.NaN)).toThrow(RangeError);
    expect(() => splitBySentence('abc', Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('joinPieces', () => {
  it('中文目标语言直接拼接', () => {
    expect(joinPieces(['第一句。', '第二句。'], 'zh-Hans')).toBe('第一句。第二句。');
  });

  it('英文目标语言用空格拼接', () => {
    expect(joinPieces(['One.', 'Two.'], 'en')).toBe('One. Two.');
  });

  it('忽略空白片段', () => {
    expect(joinPieces(['One.', '   ', ''], 'en')).toBe('One.');
  });
});
