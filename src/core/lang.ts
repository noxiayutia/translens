export interface LanguageOption {
  code: string;
  label: string;
}

export const LANGUAGES: LanguageOption[] = [
  { code: 'zh-Hans', label: '简体中文' },
  { code: 'zh-Hant', label: '繁體中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'ru', label: 'Русский' },
];

export type ScriptLang = 'zh' | 'ja' | 'ko' | 'ru' | 'ar' | 'latin' | 'unknown';

/**
 * 各字符集的码点区间。表内顺序只在「得分与首次出现位置都相同」时兜底，
 * 而一个字符只属于一个字符集，实际到不了这一步。
 */
const SCRIPT_RANGES: Array<[ScriptLang, ReadonlyArray<readonly [number, number]>]> = [
  ['ja', [[0x3040, 0x30ff]]],
  ['ko', [[0xac00, 0xd7af]]],
  ['zh', [[0x4e00, 0x9fff]]],
  ['ru', [[0x0400, 0x04ff]]],
  ['ar', [[0x0600, 0x06ff]]],
  ['latin', [[0x41, 0x5a], [0x61, 0x7a]]],
];

function scriptOf(codePoint: number): ScriptLang | undefined {
  for (const [lang, ranges] of SCRIPT_RANGES) {
    for (const [from, to] of ranges) {
      if (codePoint >= from && codePoint <= to) return lang;
    }
  }
  return undefined;
}

interface ScriptStat {
  /** 该字符集全部连续片段的得分之和 */
  score: number;
  /** 该字符集第一个片段的起始下标 */
  firstAt: number;
}

/**
 * 单遍扫描文本，统计每个字符集的连续片段及其得分。
 * 每个片段计 `1 + floor(log2(段长))`——段长每翻一倍多算一分，段数与段长同时参与。
 * 只数片段会丢掉长度信息：'aaaaa 你好' 是两个各 1 段的字符集，按段数打平后
 * 会误判成 zh（中文段落被整段跳过、5 个字母永远不翻）；加权后拉丁段跨两档，正确判为 latin。
 * 分档取 floor 而不是精确值，是为了让 4 与 5 个字符同分，保住
 * '你好世界 Hello'（中文 1 段 4 字 / 拉丁 1 段 5 字母）判为 zh 的既有断言。
 */
function scoreScripts(text: string): Map<ScriptLang, ScriptStat> {
  const stats = new Map<ScriptLang, ScriptStat>();
  let current: ScriptLang | undefined;
  let runLength = 0;
  let runStart = 0;
  let offset = 0;

  const closeRun = () => {
    if (current === undefined || runLength === 0) return;
    const stat = stats.get(current) ?? { score: 0, firstAt: runStart };
    stat.score += 1 + Math.floor(Math.log2(runLength));
    stats.set(current, stat);
  };

  for (const char of text) {
    const lang = scriptOf(char.codePointAt(0) ?? 0);
    if (lang !== current) {
      closeRun();
      current = lang;
      runLength = 0;
      runStart = offset;
    }
    if (lang !== undefined) runLength += 1;
    offset += char.length;
  }
  closeRun();

  return stats;
}

interface ScriptPick {
  lang: ScriptLang;
  /** 是否有其它字符集与最高分持平（低置信度） */
  tied: boolean;
}

/** 取分最高的字符集；同分时先出现者优先，不依赖 SCRIPT_RANGES 的表序。 */
function pickScript(text: string): ScriptPick {
  const stats = scoreScripts(text);
  let lang: ScriptLang = 'unknown';
  let score = 0;
  let firstAt = Number.POSITIVE_INFINITY;
  let tied = false;

  for (const [candidate] of SCRIPT_RANGES) {
    const stat = stats.get(candidate);
    if (stat === undefined) continue;
    if (stat.score > score || (stat.score === score && stat.firstAt < firstAt)) {
      // 换人时若分数相同，被换下的那个仍然与新的最高分持平。
      tied = stat.score === score;
      lang = candidate;
      score = stat.score;
      firstAt = stat.firstAt;
    } else if (stat.score === score) {
      tied = true;
    }
  }

  return { lang, tied };
}

export function detectScript(text: string): ScriptLang {
  return pickScript(text).lang;
}

export function normalizeText(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

const LETTER = /\p{L}/gu;

/** 至少两个字母才算值得翻译的文本，挡掉价格、页码、纯标点这类噪声。 */
export function isTranslatableText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  return (trimmed.match(LETTER)?.length ?? 0) >= 2;
}

function baseLang(code: string): string {
  return code.split('-')[0].toLowerCase();
}

const TARGET_SCRIPT: Record<string, ScriptLang> = {
  zh: 'zh',
  ja: 'ja',
  ko: 'ko',
  ru: 'ru',
  ar: 'ar',
  en: 'latin',
  fr: 'latin',
  de: 'latin',
  es: 'latin',
};

/**
 * 段落已经是指定目标语言时无需翻译。
 * 只有目标字符集严格领先才跳过：与其它字符集同分时宁可翻译——
 * 跳过等于放弃翻译，错一边就是漏翻（'Hi 你好' 这类极短混排任何多数决都不可靠）。
 */
export function shouldSkip(text: string, targetLang: string): boolean {
  const expected = TARGET_SCRIPT[baseLang(targetLang)];
  if (!expected) return false;
  const pick = pickScript(text);
  return pick.lang === expected && !pick.tied;
}
