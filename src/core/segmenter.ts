export interface TextSegment {
  id: string;
  text: string;
  order: number;
}

export interface BatchOptions {
  /** 一批内所有段落的总字符上限（含每段的编号包装开销） */
  maxBatchChars: number;
  /** 一批内最多几段，避免一次塞进几十个碎句 */
  maxSegmentsPerBatch: number;
}

/**
 * 每段在真实载荷里除正文外还要多出编号包装（`<<<n>>>` 与数组分隔符）的固定开销，
 * 预算按「正文 + 开销」计，避免贴边的批次真实长度越过上限。
 */
const PER_SEGMENT_OVERHEAD = 8;

/**
 * 按 DOM 顺序把相邻段落合并成批次。
 * 单段自身超过 maxBatchChars 时独占一批——正常路径不做段内切分，
 * 段内切分只发生在引擎报"文本过长"的降级路径
 * （见 units/wu3，待建的 src/background/scheduler.ts）。
 */
export function planBatches(segments: TextSegment[], options: BatchOptions): TextSegment[][] {
  const batches: TextSegment[][] = [];
  let current: TextSegment[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
  };

  for (const segment of segments) {
    const cost = segment.text.length + PER_SEGMENT_OVERHEAD;
    if (cost > options.maxBatchChars) {
      flush();
      batches.push([segment]);
      continue;
    }
    const wouldExceedChars = currentChars + cost > options.maxBatchChars;
    const wouldExceedCount = current.length >= options.maxSegmentsPerBatch;
    if (current.length > 0 && (wouldExceedChars || wouldExceedCount)) flush();
    current.push(segment);
    currentChars += cost;
  }
  flush();
  return batches;
}

/**
 * 句末标点连同其后的空白一起归属前一片段（'One. Two.' → 'One. ' + 'Two.'）。
 * 每次现取一个新实例：带 g 的正则自带可变 lastIndex，
 * 模块级共享会让「切分结果」取决于调用点有没有记得重置它。
 */
function sentenceBoundary(): RegExp {
  return /[。！？；!?;]\s*|\.(?=\s|$)\s*/g;
}

/**
 * 把超长文本按句子边界切成不超过 maxLen 的片段。
 * 单句本身超过 maxLen 时硬切，保证输出片段一定不超限。
 * maxLen 必须是不小于 1 的有限数，否则窗口无法推进（死循环 + 无限切片）。
 */
export function splitBySentence(text: string, maxLen: number): string[] {
  if (!Number.isFinite(maxLen) || maxLen < 1) {
    throw new RangeError(`splitBySentence 的 maxLen 必须是不小于 1 的有限数，收到 ${String(maxLen)}`);
  }
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    const chunk = rest.slice(0, maxLen);
    const boundary = sentenceBoundary();
    let cut = -1;
    let match = boundary.exec(chunk);
    while (match !== null) {
      cut = match.index + match[0].length;
      match = boundary.exec(chunk);
    }
    if (cut <= 0) cut = maxLen;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

const CJK_TARGET = /^(zh|ja|ko)/;

/** 把降级切分后分别翻译的片段拼回一段。中文不加空格，英文加。 */
export function joinPieces(pieces: string[], targetLang: string): string {
  const separator = CJK_TARGET.test(targetLang) ? '' : ' ';
  return pieces
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .join(separator);
}
