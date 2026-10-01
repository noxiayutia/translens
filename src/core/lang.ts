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
  /** 该字符集的字符总数 */
  chars: number;
  /** 该字符集第一个字符的下标 */
  firstAt: number;
}

/**
 * 单遍扫描文本，统计每个字符集的**字符总数**，而不是「连续片段」的得分。
 * 按片段计分会让结论取决于标点与空格怎么切：拉丁文天然被空格切成多段
 * （'Hello world' 就是 2 段），中文一句话通常只有 1 段，于是同一段文本里
 * 中文按 1 段拿分、拉丁按好几段拿分。实测
 * '这是一段很长的中文内容需要翻译成英文。Hello world'（中文 18 字 / 拉丁 10 字母）
 * 被判成 latin，目标为英文时整段跳过，18 个汉字永远不翻。
 * 改成按字符总数分档后，标点切不切碎片段不再影响分数，只影响同档时的先出现者判定。
 */
function scoreScripts(text: string): Map<ScriptLang, ScriptStat> {
  const stats = new Map<ScriptLang, ScriptStat>();
  let offset = 0;

  for (const char of text) {
    const lang = scriptOf(char.codePointAt(0) ?? 0);
    if (lang !== undefined) {
      const stat = stats.get(lang);
      if (stat === undefined) stats.set(lang, { chars: 1, firstAt: offset });
      else stat.chars += 1;
    }
    offset += char.length;
  }

  return stats;
}

/**
 * 字符数分档：每翻一倍才多一分（不取精确 log2）。
 * 分档是为了让 4 与 5 个字符同档，保住 '你好世界 Hello'
 * （中文 4 字 / 拉丁 5 字母）判为 zh 的既有断言。
 */
function bandOf(chars: number): number {
  return 1 + Math.floor(Math.log2(chars));
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
    const candidateScore = bandOf(stat.chars);
    if (candidateScore > score || (candidateScore === score && stat.firstAt < firstAt)) {
      // 换人时若分数相同，被换下的那个仍然与新的最高分持平。
      tied = candidateScore === score;
      lang = candidate;
      score = candidateScore;
      firstAt = stat.firstAt;
    } else if (candidateScore === score) {
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

/**
 * 整段就是一个**结构记号**时，它不是自然语言，翻出来一定是废的。
 *
 * 与 {@link isTranslatableText} 的分工：那条挡"太短、没有字母"（页码、纯标点），
 * 这一条挡"形状完整但不是散文"——`<caption>`、`https://doi.org/…`、`someone@example.com`、
 * `overscroll-behavior`。它们的来源查过了：这些都是**页面上真实可见的文字**
 * （w3schools 把标签名做成 `<a><table></a>` 链接、MDN 侧栏整列是 CSS 属性名），
 * 不是 `<code>` 漏了跳过——`inlineText` 对 `<code>` 后代本来就不取文字。
 *
 * **判据收成"整段恰好一个 token 且不含空白"**：句子与标题里出现标识符是常态，那种段必须照翻
 * （实测模型对句内标识符 8/8 原样保留，见 `docs/qa/2026-09-24-prompt-verbatim-baseline.md` 的 `m-*`）。
 * "宁可多翻、不可漏翻"这条偏置体现在三处：含空白的段一律放行；kebab 只认小写起头
 * （`State-of-the-Art` 是标题不是属性名）；`NASA ADS` 一类全大写专名不设规则。
 */
const TAG_TOKEN = /^<\/?[a-z][a-z0-9]*(-[a-z0-9]+)*>$/i;
const URL_TOKEN = /^(https?|ftp):\/\/\S+$/i;
const EMAIL_TOKEN = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/;
const KEBAB_TOKEN = /^(-[a-z0-9]+)?[a-z][a-z0-9]*(-[a-z0-9*]+)+$/;

export function isStructureToken(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // 含任何空白 ⇒ 是一个短语或句子，不是单个记号。放最前面，四条规则共用这条前提。
  if (/\s/.test(trimmed)) return false;
  return TAG_TOKEN.test(trimmed) || URL_TOKEN.test(trimmed) || EMAIL_TOKEN.test(trimmed) || KEBAB_TOKEN.test(trimmed);
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

export type HanVariant = 'hans' | 'hant' | 'unknown';

/**
 * 平假名 / 片假名（含半角片假名）的码点区间。
 * 与 `SCRIPT_RANGES` 里 'ja' 的判定同源再加半角段：半角片假名在老站点与一些
 * 站內缩写（`ｵﾗ`、`ｱﾃ`）里仍频繁出现，只认全角会漏。
 */
const KANA = /[\u3040-\u30ff\uff66-\uff9d]/;

/**
 * 文本里是否出现过假名。**页面级**判据的构件：调用方在采集前对整页文本扫一遍，
 * 把结果作为本轮上下文传回来（见 `shouldSkip` 的 `allowSameScriptSkip`）。
 * 单遍正则、命中即停，拿得起重复调用——但它每次看的都是"一整页"的量，
 * 所以每个调用点都该自己做缓存，不许逐段跑。
 */
export function containsKana(text: string): boolean {
  return KANA.test(text);
}

/**
 * 只在某一字体出现的高频字。两组**严格一一对应**：`HANS_ONLY[i]` 与 `HANT_ONLY[i]`
 * 是同一个字的两种写法，增删必须成对，否则计数会天然偏向更长的那一组。
 * 选的都是在两岸三地日常文本里高频出现的字，单段文本里出现一两个就足以定性。
 */
const HANS_ONLY =
  '这个们来说国会对时过开关学样么产业发经长问题实现应该东车马鸟风云电气万与专从见门体书买卖乐习义为广庆龙';
const HANT_ONLY =
  '這個們來說國會對時過開關學樣麼產業發經長問題實現應該東車馬鳥風雲電氣萬與專從見門體書買賣樂習義為廣慶龍';

/**
 * 靠「只在某一字体出现的高频字」分辨简繁：两边各计一次，多者胜。
 * 数量相等（含两边都是 0，即整段没有任何简繁特征字）返回 'unknown'——
 * 这一层没有更多信息，怎么判都可能错，交给调用方按保守方向处理（见 shouldSkip）。
 */
export function detectHanVariant(text: string): HanVariant {
  let hans = 0;
  let hant = 0;
  for (const char of text) {
    if (HANS_ONLY.includes(char)) hans += 1;
    else if (HANT_ONLY.includes(char)) hant += 1;
  }
  if (hans > hant) return 'hans';
  if (hant > hans) return 'hant';
  return 'unknown';
}

/**
 * 目标语言的简繁变体。只认显式变体（'zh-Hans*' / 'zh-Hant*'）：
 * 裸 'zh' 与 'zh-CN' / 'zh-TW' 这类只带地区的写法分辨不了简繁，返回 undefined，
 * 由 shouldSkip 走「不跳过」——变体判不出来时多翻一遍，好过静默漏翻。
 */
function targetHanVariant(code: string): HanVariant | undefined {
  if (/^zh-hant(?:-|$)/.test(code)) return 'hant';
  if (/^zh-hans(?:-|$)/.test(code)) return 'hans';
  return undefined;
}

/** `shouldSkip` 的本轮上下文选项。 */
export interface ShouldSkipOptions {
  /**
   * 是否允许因「看起来已经是目标语言」而跳过本段。默认 `true`（历史行为）。
   *
   * 传 `false` 的正当性来自**页面级**信息：整页出现过假名时，纯汉字段落很可能是
   * 「只用汉字书写的日文」，而单段层面的 `zh` 检出不再等于"它已经是中文"——
   * 这一轮就不因字符集/简繁变体的相似而跳过（宁可多翻不可漏翻：这个开关只会
   * **增加**翻译，永远不会减少）。页面级判定的采集在内容脚本层（那是宿主层的职责），
   * 本函数保持纯函数：判定结果由调用方算好传进来。
   */
  allowSameScriptSkip?: boolean;
}

/**
 * 段落已经是指定目标语言时无需翻译。
 * 非中文目标：只有目标字符集严格领先才跳过，与其它字符集同分时宁可翻译——
 * 跳过等于放弃翻译，错一边就是漏翻（'Hi 你好' 这类极短混排任何多数决都不可靠）。
 * 中文目标：`ScriptLang` 只到字符集一级（zh-Hant 与 zh-Hans 都是 'zh'），
 * 靠 detectHanVariant 分辨简繁——文本与目标**同变体**才跳过；异变体必须翻译，
 * 简繁互转正是在这一步发生的，一刀切跳过会让它变成静默 no-op。
 *
 * 「**纯汉字、无假名的日文**会被判成中文」曾是单段层面的已知限制（'東京都港区赤坂'
 * 这类段落在中文目标下整段跳过，那片区域永远没有译文）：汉字是简繁日共用的书写系统，
 * 不看页面上下文没有任何可靠依据，加启发式只是换一种错法。
 * 现在它由调用方带页面级上下文解决：内容脚本采集前扫一遍整页假名（{@link containsKana}），
 * 页面含假名时本轮传 `allowSameScriptSkip: false`。本函数仍然只回答「这一段像不像目标
 * 语言」，不持有任何宿主状态。
 */
export function shouldSkip(text: string, targetLang: string, options: ShouldSkipOptions = {}): boolean {
  // 本轮的页面级上下文判定"相似不再等于同语言"：所有跳过分支一并关闭（见选项注释）。
  if (options.allowSameScriptSkip === false) return false;

  const code = targetLang.toLowerCase();
  const expected = TARGET_SCRIPT[baseLang(code)];
  if (expected === undefined) return false;

  const pick = pickScript(text);
  if (expected !== 'zh') return pick.lang === expected && !pick.tied;

  // 目标 base 是 'zh'：先确认段落本身是中文，含假名的日文、英文段落照常翻译。
  if (pick.lang !== 'zh') return false;

  const variant = targetHanVariant(code);
  if (variant === undefined) return false;

  // 整段没有任何简繁特征字（'你好世界'）：变体层面无信息，退回字符集判定，同分仍不跳过。
  const textVariant = detectHanVariant(text);
  if (textVariant === 'unknown') return !pick.tied;
  return textVariant === variant;
}
