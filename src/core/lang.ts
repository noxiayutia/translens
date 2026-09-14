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

const SCRIPT_PATTERNS: Array<[ScriptLang, RegExp]> = [
  ['ja', /[\u3040-\u30ff]/g],
  ['ko', /[\uac00-\ud7af]/g],
  ['zh', /[\u4e00-\u9fff]/g],
  ['ru', /[\u0400-\u04ff]/g],
  ['ar', /[\u0600-\u06ff]/g],
  ['latin', /[A-Za-z]/g],
];

function countMatches(text: string, re: RegExp): number {
  const matched = text.match(re);
  return matched ? matched.length : 0;
}

/**
 * 统计某字符集在文本里出现的「连续片段」数，而非字符数。
 * 混排时一个汉字与一个英文单词的信息量相当，
 * 因此 '你好世界 Hello' 是 1 段中文 + 1 段拉丁（平局），而不是 4 个汉字 vs 5 个字母。
 */
function countRuns(text: string, re: RegExp): number {
  let runs = 0;
  let inRun = false;
  for (const char of text) {
    re.lastIndex = 0;
    const matched = re.test(char);
    if (matched && !inRun) runs += 1;
    inRun = matched;
  }
  return runs;
}

/** 按各字符集连续片段数取最多的那个；平局时按 SCRIPT_PATTERNS 的顺序优先。 */
export function detectScript(text: string): ScriptLang {
  let best: ScriptLang = 'unknown';
  let bestScore = 0;
  for (const [lang, re] of SCRIPT_PATTERNS) {
    const score = countRuns(text, re);
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  return best;
}

export function normalizeText(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

const LETTER = /\p{L}/gu;

/** 至少两个字母才算值得翻译的文本，挡掉价格、页码、纯标点这类噪声。 */
export function isTranslatableText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  return countMatches(trimmed, LETTER) >= 2;
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

/** 段落已经是指定目标语言时无需翻译。 */
export function shouldSkip(text: string, targetLang: string): boolean {
  const expected = TARGET_SCRIPT[baseLang(targetLang)];
  if (!expected) return false;
  return detectScript(text) === expected;
}
