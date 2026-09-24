import { describe, expect, it } from 'vitest';
import {
  containsKana,
  detectHanVariant,
  detectScript,
  isStructureToken,
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

/**
 * 形状闸：整段**就是一个**结构记号（标签名 / URL / 邮箱 / kebab 属性名）时不采集。
 *
 * 判据必须是"整段恰好是这个 token"，不能是"文本里含有"——`docs/qa/2026-09-23-multi-site-report.md:62-78`
 * 那批噪声段（w3schools 的 12 条 HTML 标签名、MDN 侧栏的 `overscroll-*`）都是整段就是记号，
 * 而真散文里的标识符要留在译文里（实测 `m-*` 三类 8/8 保留，见
 * `docs/qa/2026-09-24-prompt-verbatim-baseline.md`）。下面「不许挡」那一组就是这条边界的钉子。
 */
describe('isStructureToken', () => {
  it('整段是 HTML/XML 标签名', () => {
    for (const text of ['<table>', '</tr>', '<th>', '<caption>', '<colgroup>', '<p>', '<my-widget-2>', '<TABLE>']) {
      expect(isStructureToken(text)).toBe(true);
    }
  });

  it('整段是一个 URL（无空格）', () => {
    expect(isStructureToken('https://doi.org/10.48550/arXiv.2303.08774')).toBe(true);
    expect(isStructureToken('http://example.com/a?b=c#d')).toBe(true);
  });

  it('整段是一个邮箱地址', () => {
    expect(isStructureToken('monnand@gmail.com')).toBe(true);
  });

  it('整段是 kebab 形式的属性名（含厂商前缀与通配）', () => {
    for (const text of ['overscroll-behavior', 'background-*', '-webkit-box-flex', 'scroll-margin-top', 'grid-area']) {
      expect(isStructureToken(text)).toBe(true);
    }
  });

  it('首尾空白不影响判定', () => {
    expect(isStructureToken('  <table>  ')).toBe(true);
  });

  it('句子（或标题）里有这些形状时**不许**挡', () => {
    for (const text of [
      'Set overscroll-behavior to contain to stop scroll chaining.',
      'The <caption> element labels the columns of a data table.',
      'See https://example.com for details.',
      'Email me at a@b.com please.',
      'Scroll behavior options',
      'overscroll-behavior: contain',
    ]) {
      expect(isStructureToken(text)).toBe(false);
    }
  });

  it('品牌名、专名与带大写的连字符词不许挡（宁可多翻，不可漏翻）', () => {
    for (const text of ['iPhone 15 Pro', 'NASA ADS', 'State-of-the-Art', 'A/B test', 'T Cell', 'e-commerce is growing']) {
      expect(isStructureToken(text)).toBe(false);
    }
  });

  it('自然语言与中文正文一律放行', () => {
    expect(isStructureToken('This section describes the cache.')).toBe(false);
    expect(isStructureToken('这是一段正文')).toBe(false);
  });

  it('空串与纯符号交给上游噪声闸，本函数不越权', () => {
    expect(isStructureToken('')).toBe(false);
    expect(isStructureToken('…')).toBe(false);
    expect(isStructureToken('<3')).toBe(false);
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
