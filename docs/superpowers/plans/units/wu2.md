## Task 2: `core/hash.ts` — 稳定哈希与缓存 key

**Files:**
- Create: `src/core/hash.ts`
- Test: `tests/core/hash.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/core/hash.test.ts
import { describe, expect, it } from 'vitest';
import { buildCacheKey, hashString } from '../../src/core/hash';

describe('hashString', () => {
  it('同样的输入得到同样的输出', () => {
    expect(hashString('hello world')).toBe(hashString('hello world'));
  });

  it('不同输入得到不同输出', () => {
    expect(hashString('hello')).not.toBe(hashString('hellp'));
  });

  it('能处理空字符串', () => {
    expect(hashString('')).toMatch(/^0-[0-9a-z]+-[0-9a-z]+$/);
  });

  it('能处理中文与 emoji', () => {
    expect(hashString('你好🌏')).toBe(hashString('你好🌏'));
    expect(hashString('你好🌏')).not.toBe(hashString('你好🌍'));
  });
});

describe('buildCacheKey', () => {
  const base = {
    engineId: 'google',
    configHash: 'cfg-openai-gpt-4o-mini',
    sourceLang: 'auto',
    targetLang: 'zh-Hans',
    glossaryHash: '',
    promptHash: '',
    text: 'Hello world',
  };

  it('同样的字段得到同样的 key', () => {
    expect(buildCacheKey(base)).toBe(buildCacheKey({ ...base }));
  });

  it('任一字段变化都会改变 key', () => {
    const key = buildCacheKey(base);
    expect(buildCacheKey({ ...base, text: 'Hello world!' })).not.toBe(key);
    expect(buildCacheKey({ ...base, engineId: 'openai-compat' })).not.toBe(key);
    expect(buildCacheKey({ ...base, targetLang: 'ja' })).not.toBe(key);
    expect(buildCacheKey({ ...base, glossaryHash: 'abc' })).not.toBe(key);
    expect(buildCacheKey({ ...base, promptHash: 'abc' })).not.toBe(key);
    expect(buildCacheKey({ ...base, configHash: 'cfg-openai-gpt-4o' })).not.toBe(key);
  });

  /**
   * 源语言是设置项、会一路传到 `TranslateRequest.from`，不参与 key 就会命中按另一种
   * 源语言语义翻出来的旧译文（今天两个引擎都还没读 `from`，所以这条是防御性的：
   * 等接上就用错语义，而且事后无法自愈）。
   */
  it('源语言变化会改变 key', () => {
    const key = buildCacheKey(base);
    expect(buildCacheKey({ ...base, sourceLang: 'en' })).not.toBe(key);
    expect(buildCacheKey({ ...base, sourceLang: 'ja' })).not.toBe(key);
    // 'auto' 与具体语言是两种语义，不能共用 key。
    expect(buildCacheKey({ ...base, sourceLang: 'zh-Hans' })).not.toBe(key);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/hash.test.ts`

Expected: FAIL — 无法解析 `../../src/core/hash`。

- [ ] **Step 3: 写实现**

```ts
// src/core/hash.ts

/**
 * 32 位双通道哈希（FNV-1a + murmur 混合）。
 * 同步、无依赖，在 content script 与 service worker 中结果一致。
 */
export function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }
  return `${input.length.toString(36)}-${h1.toString(36)}-${h2.toString(36)}`;
}

export interface CacheKeyParts {
  engineId: string;
  /**
   * 引擎配置指纹（接口地址 + 模型名）。
   * openai-compat 下用户可以随时改模型（gpt-4o-mini → gpt-4o）或接口地址，
   * 这两项不参与 key 就会命中上一个模型的旧译文。
   * **apiKey 不进这里**：换 key 不该让全部缓存失效；且哈希输入会落进 storage，
   * 密钥不该出现在缓存键的输入里。它只影响鉴权，不影响译文本身。
   */
  configHash: string;
  /**
   * 源语言。`sourceLang` 是设置项，会一路传到 `TranslateRequest.from`；它不参与 key 时，
   * 用户把「自动检测」改成某个具体源语言（或反过来）之后，同一个引擎、同一段文本、同一个
   * 目标语言会命中**按另一种源语言语义**翻出来的旧译文，而且事后无法自愈。
   * 今天两个引擎都还没真的读 `from`（Google 把 `sl=auto` 硬编码），所以这条还没有可观察
   * 的错误；等接上就用错语义——key 必须在那之前就带上它。
   */
  sourceLang: string;
  targetLang: string;
  glossaryHash: string;
  promptHash: string;
  text: string;
}

/** 用 \u0000 分隔，避免字段拼接产生歧义（如 ("ab","c") 与 ("a","bc")）。 */
export function buildCacheKey(parts: CacheKeyParts): string {
  return hashString(
    [
      parts.engineId,
      parts.configHash,
      parts.sourceLang,
      parts.targetLang,
      parts.glossaryHash,
      parts.promptHash,
      parts.text,
    ].join('\u0000'),
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/hash.test.ts`

Expected: PASS，6 个用例全绿。

- [ ] **Step 5: 提交**

```bash
git add src/core/hash.ts tests/core/hash.test.ts
git commit -m "feat(core): 稳定哈希与缓存 key 组装"
```

---

## Task 3: `core/lang.ts` — 语种识别与跳过判定

**Files:**
- Create: `src/core/lang.ts`
- Test: `tests/core/lang.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/core/lang.test.ts
import { describe, expect, it } from 'vitest';
import {
  containsKana,
  detectHanVariant,
  detectScript,
  isTranslatableText,
  normalizeText,
  shouldSkip,
} from '../../src/core/lang';

describe('detectScript', () => {
  it('识别纯中文', () => {
    expect(detectScript('这是一段中文')).toBe('zh');
  });

  it('含假名时判为日文（即使有汉字）', () => {
    expect(detectScript('日本語のテキストです')).toBe('ja');
  });

  it('识别韩文', () => {
    expect(detectScript('한국어 텍스트')).toBe('ko');
  });

  it('识别拉丁文', () => {
    expect(detectScript('Hello world')).toBe('latin');
  });

  it('中英混合按多数决', () => {
    expect(detectScript('Hello world 世界')).toBe('latin');
    expect(detectScript('你好世界 Hello')).toBe('zh');
  });

  it('短汉字段不敌长拉丁段', () => {
    expect(detectScript('aaaaa 你好')).toBe('latin');
    expect(detectScript('中文 abcde')).toBe('latin');
  });

  it('片段分同档时按先出现者判定', () => {
    expect(detectScript('Hi 你好')).toBe('latin');
    expect(detectScript('你好 Hi')).toBe('zh');
  });

  it('中文占多数时不因标点切碎而判成拉丁', () => {
    expect(detectScript('这是一段很长的中文内容需要翻译成英文。Hello world')).toBe('zh');
  });

  it('同一句里用句号还是空格分隔，不改变判定', () => {
    expect(detectScript('这是一段很长的中文内容需要翻译成英文 Hello world')).toBe(
      detectScript('这是一段很长的中文内容需要翻译成英文。Hello world'),
    );
    expect(detectScript('这是一段很长的中文内容需要翻译成英文 Hello world')).toBe('zh');
  });

  it('多段中文与多段拉丁总字数同档时按先出现者判定', () => {
    expect(detectScript('第一段中文。第二段中文。third party tools')).toBe('zh');
    expect(detectScript('first party tools 第一段中文。第二段中文。')).toBe('latin');
  });

  it('拉丁字母明显多于中文时仍判 latin（计数口径的边界）', () => {
    // 冻结断言 'Hello world 世界' → latin、'中文 abcde' → latin 已经钉死了这个方向：
    // 「出现中文就算中文」的规则会把它们打回原样。理由见留档 amendment §7。
    expect(detectScript('中文。English words here')).toBe('latin');
  });

  it('没有字母时返回 unknown', () => {
    expect(detectScript('123 --- !!!')).toBe('unknown');
  });
});

describe('detectHanVariant', () => {
  it('识别繁体特征字', () => {
    expect(detectHanVariant('這是繁體中文')).toBe('hant');
  });

  it('识别简体特征字', () => {
    expect(detectHanVariant('这是简体中文')).toBe('hans');
  });

  it('没有任何简繁特征字时判 unknown', () => {
    expect(detectHanVariant('你好世界')).toBe('unknown');
  });

  it('两类特征字数量相等时判 unknown', () => {
    expect(detectHanVariant('这這')).toBe('unknown');
  });

  it('数量多者胜', () => {
    expect(detectHanVariant('这个们来说 這是')).toBe('hans');
    expect(detectHanVariant('這是繁體中文 this 这')).toBe('hant');
  });

  it('非中文字符不参与计数', () => {
    expect(detectHanVariant('這是 Japanese です')).toBe('hant');
  });
});

describe('normalizeText', () => {
  it('折叠空白并去首尾', () => {
    expect(normalizeText('  a\n\n  b\t c ')).toBe('a b c');
  });

  it('null 与 undefined 返回空串', () => {
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(undefined)).toBe('');
  });
});

describe('isTranslatableText', () => {
  it('正常句子可翻译', () => {
    expect(isTranslatableText('Hello world')).toBe(true);
  });

  it('单字符不可翻译', () => {
    expect(isTranslatableText('a')).toBe(false);
  });

  it('纯数字与纯标点不可翻译', () => {
    expect(isTranslatableText('12345')).toBe(false);
    expect(isTranslatableText('—— …… ！！！')).toBe(false);
  });

  it('少于两个字母不可翻译', () => {
    expect(isTranslatableText('3 个')).toBe(false);
  });
});

describe('shouldSkip', () => {
  it('目标中文时跳过中文段落', () => {
    expect(shouldSkip('这是一段中文', 'zh-Hans')).toBe(true);
  });

  it('目标中文时不跳过英文段落', () => {
    expect(shouldSkip('This is English', 'zh-Hans')).toBe(false);
  });

  it('目标中文时不跳过日文段落（含汉字但以假名为主）', () => {
    expect(shouldSkip('これはテストです', 'zh-Hans')).toBe(false);
  });

  it('目标英文时跳过英文段落', () => {
    expect(shouldSkip('This is English', 'en')).toBe(true);
  });

  it('目标日文时跳过日文段落', () => {
    expect(shouldSkip('これはテストです', 'ja')).toBe(true);
  });

  it('混排段落与目标语言同分时不跳过（低置信度偏保守）', () => {
    expect(shouldSkip('Hi 你好', 'zh-Hans')).toBe(false);
    expect(shouldSkip('你好 Hi', 'zh-Hans')).toBe(false);
    expect(shouldSkip('你好世界 Hello', 'zh-Hans')).toBe(false);
  });

  it('短汉字段不敌长拉丁段时不跳过', () => {
    expect(shouldSkip('aaaaa 你好', 'zh-Hans')).toBe(false);
  });

  it('中文段明显占优时仍然跳过', () => {
    expect(shouldSkip('这是一段较长的中文内容，Hello', 'zh-Hans')).toBe(true);
  });

  it('中文占多数被标点切碎的段落，目标为英文时不跳过', () => {
    expect(shouldSkip('这是一段很长的中文内容需要翻译成英文。Hello world', 'en')).toBe(false);
  });

  it('多段中文与多段拉丁总字数同档时不跳过', () => {
    expect(shouldSkip('第一段中文。第二段中文。third party tools', 'zh-Hans')).toBe(false);
    expect(shouldSkip('first party tools 第一段中文。第二段中文。', 'en')).toBe(false);
  });

  it('目标繁體中文时只在文本已是繁体时跳过（简繁互转不走 no-op 快路径）', () => {
    expect(shouldSkip('这是简体中文', 'zh-Hant')).toBe(false);
    // 原断言把 '這是繁體中文' 也钉成 false（HANT_TARGET 一刀切），与「同变体才跳过」的新口径互斥；
    // 按新口径改为 true，异议与理由见留档 §8.1。
    expect(shouldSkip('這是繁體中文', 'zh-Hant')).toBe(true);
  });

  it('文本与目标简繁变体不同时不跳过（需要简繁转换）', () => {
    expect(shouldSkip('這是繁體中文段落', 'zh-Hans')).toBe(false);
    expect(shouldSkip('这是简体中文段落', 'zh-Hant')).toBe(false);
  });

  it('文本已是目标简繁变体时跳过', () => {
    expect(shouldSkip('这是简体中文段落', 'zh-Hans')).toBe(true);
    expect(shouldSkip('這是繁體中文段落', 'zh-Hant')).toBe(true);
  });

  it('没有任何简繁特征字的纯中文按字符集判定跳过', () => {
    expect(shouldSkip('没有简繁特征的纯中文', 'zh-Hans')).toBe(true);
  });
});

/**
 * `allowSameScriptSkip` 是页面级上下文的入口（修「纯汉字日文被静默跳过」那条已知限制）：
 * 内容脚本扫一遍整页发现假名时传 false——本页的"像中文"不再等于"是中文"，
 * 那些很可能只是不用假名的日文。方向上只会**多翻**，不会少翻。
 */
describe('shouldSkip 的 allowSameScriptSkip 选项', () => {
  it('关掉后：目标中文的纯汉字段落不再因"看起来已是中文"而跳过', () => {
    // '日本橋三丁目' 整段没有任何简繁特征字（detectHanVariant 判 unknown），
    // 默认路径会按字符集判定跳过——这正是日文页面上被吞掉的那类段落。
    expect(shouldSkip('日本橋三丁目', 'zh-Hans')).toBe(true);
    expect(shouldSkip('日本橋三丁目', 'zh-Hans', { allowSameScriptSkip: false })).toBe(false);
    // zh-Hant 下「東」是繁体特征字、同样必跳的段落也一样放行。
    expect(shouldSkip('東京都港区', 'zh-Hant')).toBe(true);
    expect(shouldSkip('東京都港区', 'zh-Hant', { allowSameScriptSkip: false })).toBe(false);
  });

  it('非中文目标的"已是目标语言"跳过同样受该开关约束（同一条规则，不留分支）', () => {
    expect(shouldSkip('This is English', 'en')).toBe(true);
    expect(shouldSkip('This is English', 'en', { allowSameScriptSkip: false })).toBe(false);
  });

  it('默认（不传）与显式 true 的行为逐字不变', () => {
    expect(shouldSkip('日本橋三丁目', 'zh-Hans', { allowSameScriptSkip: true })).toBe(true);
    expect(shouldSkip('这是一段中文', 'zh-Hans', {})).toBe(true);
    expect(shouldSkip('This is English', 'zh-Hans', { allowSameScriptSkip: false })).toBe(false);
    // 关掉开关只会让"跳过"变少，永远不会让它变多。
    expect(shouldSkip('Hello world 世界', 'zh-Hans', { allowSameScriptSkip: false })).toBe(false);
  });
});

describe('containsKana（页面级假名判据）', () => {
  it('平假名、片假名都算', () => {
    expect(containsKana('本日はお日柄もよく')).toBe(true);
    expect(containsKana('東京タワー')).toBe(true);
    expect(containsKana('ｵﾗｵﾗ')).toBe(true); // 半角片假名（老站点与缩写里都见过）
  });

  it('纯汉字、假名之外的字符不算', () => {
    expect(containsKana('東京都港区赤坂')).toBe(false);
    expect(containsKana('Hello 世界 123！？')).toBe(false);
    expect(containsKana('')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/lang.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/core/lang.ts
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
```

> 实现备注（口径的由来、候选对比与被否掉的口径见 `docs/superpowers/plans/2026-09-14-wu2-plan-amendment.md` §5、§7、§8）：
> `detectScript` 按各字符集**字符总数**分档取最高者，档位是 `1 + floor(log2(字数))`，
> 不是按「连续片段」计分：拉丁文天然被空格切成多段、中文一句话通常只有 1 段，
> 按片段计分会让结论取决于标点怎么切。实测 `'这是一段很长的中文内容需要翻译成英文。Hello world'`
> （中文 18 字 / 拉丁 10 字母）被判成 `latin`，目标为英文时整段跳过，18 个汉字一个不翻。
> 同分时先出现者优先，不依赖 `SCRIPT_RANGES` 的表序。
> 因此 `'你好世界 Hello'`（中文 4 字与拉丁 5 字母同档同分）判为 `zh`，
> 而 `'aaaaa 你好'`（拉丁字数是中文的两倍以上，跨档）正确判为 `latin`。
> `shouldSkip` 在**非中文目标**下只在目标字符集**严格领先**时返回 `true`：与其它字符集同分的混排段落
> （`'Hi 你好'`、`'你好 Hi'`）按低置信度处理，宁可不跳过——跳过等于放弃翻译，错一边就是漏翻。
> **中文目标**下 `ScriptLang` 只到字符集一级（`zh-Hant` 与 `zh-Hans` 都是 `'zh'`），分辨不了简繁，
> 改由 `detectHanVariant` 判定：段落与目标**同变体**才跳过，异变体必须翻译（简繁互转正是在这一步发生）；
> 整段没有任何简繁特征字（`'你好世界'`）时退回字符集判定，同分仍不跳过。
> 目标为 `zh-Hant` 不再一刀切跳过：那只是把简转繁变成 no-op，繁转简同样漏。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/lang.test.ts`

Expected: PASS，全部用例通过。

- [ ] **Step 5: 提交**

```bash
git add src/core/lang.ts tests/core/lang.test.ts
git commit -m "feat(core): 语种脚本识别与跳过判定"
```

---

## Task 4: `core/segmenter.ts` — 批次合并与句子切分

**Files:**
- Create: `src/core/segmenter.ts`
- Test: `tests/core/segmenter.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/core/segmenter.test.ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/segmenter.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/core/segmenter.ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/segmenter.test.ts`

Expected: PASS，全部用例通过。

- [ ] **Step 5: 提交**

```bash
git add src/core/segmenter.ts tests/core/segmenter.test.ts
git commit -m "feat(core): 批次合并与超长文本按句切分"
```

---

## Task 5: `core/pool.ts` — 并发池

**Files:**
- Create: `src/core/pool.ts`
- Test: `tests/core/pool.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/core/pool.test.ts
import { describe, expect, it } from 'vitest';
import { runPool } from '../../src/core/pool';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('runPool', () => {
  it('空任务返回空数组', async () => {
    expect(await runPool([], 3)).toEqual([]);
  });

  it('结果顺序与任务顺序一致', async () => {
    const tasks = [
      async () => 'a',
      async () => 'b',
      async () => 'c',
    ];
    expect(await runPool(tasks, 1)).toEqual(['a', 'b', 'c']);
  });

  it('并发数不超过上限', async () => {
    let running = 0;
    let peak = 0;
    const gate = deferred<void>();
    const tasks = Array.from({ length: 6 }, () => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
      return 'ok';
    });
    const pending = runPool(tasks, 2);
    await Promise.resolve();
    expect(peak).toBeLessThanOrEqual(2);
    gate.resolve();
    expect(await pending).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  });

  it('并发上限大于任务数时也能跑完', async () => {
    const tasks = [async () => 1, async () => 2];
    expect(await runPool(tasks, 10)).toEqual([1, 2]);
  });

  it('limit 不是不小于 1 的有限数时报错而不是返回空洞结果', async () => {
    const tasks = [async () => 'a'];
    await expect(runPool(tasks, Number.NaN)).rejects.toThrow(RangeError);
    await expect(runPool(tasks, 0)).rejects.toThrow(RangeError);
    await expect(runPool(tasks, -1)).rejects.toThrow(RangeError);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/pool.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/core/pool.ts
/**
 * 以最多 limit 个并发执行任务，返回结果数组，顺序与 tasks 一致。
 * 任务自身的异常会向上抛出（调用方负责在任务内部捕获）。
 * limit 必须是「不小于 1 的有限数」：NaN 会算出 0 个 worker，
 * 静默返回一个全是 undefined 的数组，所以入口直接报错。
 */
export async function runPool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  if (!Number.isFinite(limit) || limit < 1) {
    throw new RangeError(`runPool 的 limit 必须是不小于 1 的有限数，收到 ${String(limit)}`);
  }

  const results: T[] = new Array(tasks.length);
  if (tasks.length === 0) return results;

  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/pool.test.ts`

Expected: PASS，4 个用例通过。

- [ ] **Step 5: 提交**

```bash
git add src/core/pool.ts tests/core/pool.test.ts
git commit -m "feat(core): 并发池"
```

---

## Task 6: `engines/types.ts` — 引擎接口与错误类型

**Files:**
- Create: `src/engines/types.ts`
- Test: `tests/engines/types.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/engines/types.test.ts
import { describe, expect, it } from 'vitest';
import { EngineError, RETRYABLE_CODES, toEngineError } from '../../src/engines/types';

describe('EngineError', () => {
  it('网络错误与限流可重试', () => {
    expect(new EngineError('NETWORK', 'x').retryable).toBe(true);
    expect(new EngineError('RATE_LIMIT', 'x').retryable).toBe(true);
  });

  it('文本过长不可重试：超长要靠切分而不是原样重发', () => {
    // 文本过长是确定性失败，拿同一段文本重问一次必然还是过长，只白烧两次请求；
    // 它该走的是调度器的切分降级。判据与调度器共用 RETRYABLE_CODES，不能各写一份。
    expect(RETRYABLE_CODES.has('TOO_LONG')).toBe(false);
    expect(new EngineError('TOO_LONG', 'x').retryable).toBe(false);
  });

  it('鉴权失败与格式错误不可重试', () => {
    expect(new EngineError('AUTH', 'x').retryable).toBe(false);
    expect(new EngineError('BAD_RESPONSE', 'x').retryable).toBe(false);
  });

  it('retryable 只由导出的 RETRYABLE_CODES 决定', () => {
    expect([...RETRYABLE_CODES].sort()).toEqual(['NETWORK', 'RATE_LIMIT']);
    for (const code of ['NETWORK', 'RATE_LIMIT', 'AUTH', 'TOO_LONG', 'BAD_RESPONSE', 'ABORTED', 'UNKNOWN'] as const) {
      expect(new EngineError(code, 'x').retryable).toBe(RETRYABLE_CODES.has(code));
    }
  });

  it('保留错误码与消息', () => {
    const err = new EngineError('AUTH', '缺少 API Key');
    expect(err.code).toBe('AUTH');
    expect(err.message).toBe('缺少 API Key');
    expect(err.name).toBe('EngineError');
  });
});

describe('toEngineError', () => {
  it('EngineError 原样返回', () => {
    const err = new EngineError('AUTH', 'x');
    expect(toEngineError(err)).toBe(err);
  });

  it('AbortError 转成 ABORTED', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(toEngineError(abort).code).toBe('ABORTED');
  });

  it('未知错误转成 UNKNOWN 并保留消息', () => {
    const err = toEngineError(new Error('boom'));
    expect(err.code).toBe('UNKNOWN');
    expect(err.message).toBe('boom');
  });

  it('保留原始错误为 cause', () => {
    const raw = new TypeError('boom');
    expect(toEngineError(raw).cause).toBe(raw);

    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(toEngineError(abort).cause).toBe(abort);
  });

  it('非 Error 值也能处理', () => {
    expect(toEngineError('oops').code).toBe('UNKNOWN');
    expect(toEngineError('oops').message).toBe('oops');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/engines/types.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/engines/types.ts
export interface Term {
  from: string;
  to: string;
}

export interface TranslateRequest {
  texts: string[];
  from: string;
  to: string;
  glossary?: Term[];
  systemPrompt?: string;
  signal: AbortSignal;
}

export interface EngineConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export type EngineErrorCode =
  | 'NETWORK'
  | 'RATE_LIMIT'
  | 'AUTH'
  | 'BAD_REQUEST'
  | 'TOO_LONG'
  | 'BAD_RESPONSE'
  | 'ABORTED'
  | 'UNKNOWN';

/**
 * 可退避重试的错误码：网络抖动与限流重发还有机会成功。
 *
 * 有意不含这两个：
 * - `TOO_LONG`：文本过长是确定性失败，拿同一段文本原样重发必然还是过长，它该走切分降级。
 * - `BAD_REQUEST`：服务端明确说"你这个请求不对"（模型名写错、参数不合法…），重发多少次
 *   都是同一个 400。把它归进 `NETWORK` 会让调度器白重试三次、页面上再挂一排点了也没用的
 *   重试按钮——用户真正需要的是看到服务商给的原因，然后去设置页改。
 *
 * 这是全仓唯一一份判据，调度器与内容脚本直接复用它，避免几处集合各说各话。
 */
export const RETRYABLE_CODES: ReadonlySet<EngineErrorCode> = new Set<EngineErrorCode>([
  'NETWORK',
  'RATE_LIMIT',
]);

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly retryable: boolean;

  constructor(code: EngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EngineError';
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
  }
}

export function toEngineError(raw: unknown): EngineError {
  if (raw instanceof EngineError) return raw;
  if (raw instanceof Error) {
    // 保留原始错误：fetch 失败带的 cause、超时属性等要靠它才能追查。
    const options: ErrorOptions = { cause: raw };
    if (raw.name === 'AbortError') return new EngineError('ABORTED', '请求已取消', options);
    return new EngineError('UNKNOWN', raw.message, options);
  }
  return new EngineError('UNKNOWN', String(raw));
}

export interface Translator {
  id: string;
  name: string;
  /** 需要 API Key 的引擎为 true，弹窗据此显示红色状态点 */
  needsKey: boolean;
  /** 是否支持 system prompt；为 false 时术语表与自定义提示词不生效 */
  supportsGlossary: boolean;
  translate(request: TranslateRequest, config: EngineConfig): Promise<string[]>;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/engines/types.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/engines/types.ts tests/engines/types.test.ts
git commit -m "feat(engines): 引擎接口与错误类型"
```

---
