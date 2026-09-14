# wu2 任务书修正留档（Plan 1 · Task 2–6）

> 本文件是**留档**，不是任务书的一部分，也不参与实施。
> 它记录一件事：`docs/superpowers/plans/units/wu2.md` 及其母本在提交 `9fa7623` 里被改过，
> 以及为什么必须改、原文如何复原、验收基线有没有被放宽。任何关于 Task 2–6 的规格核对都应以本文件为入口。

| 项 | 值 |
| --- | --- |
| 被修正的需求源文件 | `docs/superpowers/plans/units/wu2.md`（子代理读物）<br>`docs/superpowers/plans/2026-09-14-immersive-translate-core.md`（母本，units 由 `scripts/split-plan.mjs` 生成） |
| 修正提交 | `9fa7623` — `fix(docs): 修正 wu2 任务书中与自带测试冲突的实现代码` |
| 受影响的实现 | Task 3 `src/core/lang.ts`、Task 4 `src/core/segmenter.ts` |
| 未受影响 | `src/**`、`tests/**`、`package.json`、构建配置——`git diff --name-only 9fa7623^ 9fa7623 -- src tests` 为空 |

复核结论：**原文这两处实现代码块过不了它自带的断言**（见下一节）。
测试是验收基线，所以改的是任务书里的实现代码块，不是测试期望；`src/` 与 `tests/` 一行未动。

---

## 1. 为什么必须改

### 1.1 `core/lang.ts` — `detectScript` 的口径

**修正前（原文）：**

```ts
/** 按各字符集出现次数取最多的那个；平局时按 SCRIPT_PATTERNS 的顺序优先。 */
export function detectScript(text: string): ScriptLang {
  let best: ScriptLang = 'unknown';
  let bestScore = 0;
  for (const [lang, re] of SCRIPT_PATTERNS) {
    const score = countMatches(text, re);
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  return best;
}
```

**自带断言（`tests/core/lang.test.ts:21-24`，原文与现状完全一致）：**

```ts
it('中英混合按多数决', () => {
  expect(detectScript('Hello world 世界')).toBe('latin');
  expect(detectScript('你好世界 Hello')).toBe('zh');
});
```

**矛盾：** 上面的 `countMatches` 是字符数口径，`'你好世界 Hello'` 是 4 个汉字 vs 5 个拉丁字母 → `'latin'`，
与断言要求的 `'zh'` 直接冲突。**在「计数字符」这一个口径下**，调 `SCRIPT_PATTERNS` 顺序、调权重都无法
同时满足同组里的两条断言，属无解。

> 口径更正（后续审查意见）：**「计数字符这一口径无解」不等于「只能改成纯片段数」**。
> 9fa7623 把前者当成了后者，实际还存在第三种口径同时满足全部 7 条断言且不丢段长，
> 见第 5 节。纯片段数口径本身带一个生产回归（`'aaaaa 你好'` 被判成 `zh`），第 6 节已修。

**修正后（现状，与 `src/core/lang.ts` 逐字节一致）：** 新增 `countRuns`，改按「连续片段数」取多数——
`'你好世界 Hello'` 是中文 1 段 / 拉丁 1 段（平局），按 `SCRIPT_PATTERNS` 顺序得 `zh`；
`'Hello world 世界'` 是拉丁 2 段 / 中文 1 段，得 `latin`。

### 1.2 `core/segmenter.ts` — 句末标点后的空白归属

**修正前（原文）：**

```ts
const SENTENCE_BOUNDARY = /[。！？；!?;]|\.(?=\s|$)/g;
```

**自带断言（`tests/core/segmenter.test.ts:63-65`，原文与现状完全一致）：**

```ts
it('英文按句末标点切分', () => {
  expect(splitBySentence('One. Two. Three.', 8)).toEqual(['One. ', 'Two. ', 'Three.']);
});
```

**矛盾：** 该正则下空白留给了后一片段，实得 `['One.', ' Two.', ' Three.']`，与断言的 `['One. ', 'Two. ', 'Three.']` 不符。

**修正后（现状，与 `src/core/segmenter.ts` 逐字节一致）：**

```ts
/** 句末标点连同其后的空白一起归属前一片段（'One. Two.' → 'One. ' + 'Two.'）。 */
const SENTENCE_BOUNDARY = /[。！？；!?;]\s*|\.(?=\s|$)\s*/g;
```

### 1.3 纯备注（未改代码）

`wu2.md` 里另加了一段 `shouldSkip` 混排行为备注：`9fa7623` 当时 `detectScript` 按连续片段数取多数后，
中文与拉丁各占一段的混排段落会被整段跳过（`shouldSkip('Hello 你好世界', 'zh-Hans') === true`）。

**其中「该行为已被本单元测试冻结」一句不成立**：`lang.test.ts` 的 `shouldSkip` 用例只覆盖纯中文、
纯英文、纯日文三种段落，没有任何混排断言；`detectScript` 那两条混排断言（`'Hello world 世界'`、
`'你好世界 Hello'`）与「跳过与否」也不是一回事。该行为已在第 6 节随口径一并改掉（同分不再跳过），
本小节只作历史记录。

---

## 2. 原文如何复原

`9fa7623` 与它的父提交 `9fa7623^` 之间，任务书只有三处差异：1.1 的 `detectScript`、1.2 的
`SENTENCE_BOUNDARY`、外加 1.3 那段新增备注——都已在上文逐条列出。因此不查 git 也能还原原文。
要拿逐字节原文：

```powershell
git show 9fa7623^:docs/superpowers/plans/units/wu2.md                                  # 子代理读物
git show 9fa7623^:docs/superpowers/plans/2026-09-14-immersive-translate-core.md        # 母本
git diff 9fa7623^ 9fa7623 -- docs                                                      # 完整差异
```

子代理读到的 `units/wu2.md` 由母本切片生成，两者始终同步：

```powershell
node scripts/split-plan.mjs docs/superpowers/plans/2026-09-14-immersive-translate-core.md <outDir>
```

本次核对：重新生成的 `wu1..wu10.md` 与已提交版本 **10/10 逐字节一致**。

---

## 3. 验收基线没有被放宽

> 本节的复核对象是 `de234b5`（本文件落地时的提交）。第 6 节之后 `src/`、`tests/` 与任务书代码块
> 都随口径修复重新同步过，那里的数字以第 6 节为准。

- **测试一行未动**：5 个测试文件在 `9fa7623^` 与 `de234b5` 的 blob 哈希完全相同。

  | 测试文件 | blob |
  | --- | --- |
  | `tests/core/hash.test.ts` | `6d437fd297ae34c78162620f75f9c07d1f0a41d0` |
  | `tests/core/lang.test.ts` | `fb07a414fbece402763d50df75ad8f5b26b292a5` |
  | `tests/core/segmenter.test.ts` | `08714d304a949b7248de4fd2ccfba3a50797c1d3` |
  | `tests/core/pool.test.ts` | `cd7920e00fc85fa5825e36d4529e4bcff6a134e2` |
  | `tests/engines/types.test.ts` | `5eac7e0e83798c752b04e86f84ac0fcc0b707423` |

- **实现一行未动**：`git diff bd78366..de234b5 -- src tests` 为空；`9fa7623` 只改了两个 `.md`。
- **代码块与磁盘一致**：把 `wu2.md` 里 10 个 TypeScript 代码块抽出来（首行 `// 路径` 注释是落盘路径），
  与仓库 `de234b5` 的同名文件 **10/10 逐字节一致**；修正前该口径下是 8/10
  （5 个测试块全部一致，2 个实现块不一致——即 1.1 / 1.2）。
- 本次修复只新增本文件：`src/**`、`tests/**` 与任务书（`wu2.md` 及母本）均未再改动。
  复核用的临时工程建在 `%TEMP%` 下，已删除。

### 3.1 两处事实更正（交接报告的误报，审查意见 #3）

- **「5 个测试文件不在 `tsconfig.json` 的 `include` 范围内，因此 `npm run typecheck` 不检查测试代码」
  是错的。** `tsconfig.json` 只覆盖 `src/`，但 `npm run typecheck` 跑的是两份配置；`tsconfig.node.json`
  的 `"include"` 里就有 `"tests"`，而且它自 base `e6248fa` 起从未被改动
  （`git diff e6248fa..de234b5 -- tsconfig.json tsconfig.node.json` 为空）。实测：

  ```
  npx tsc --noEmit -p tsconfig.node.json --listFiles | Select-String 'tests[\\/].*\.test\.ts'
  D:/翻译-插件/tests/core/hash.test.ts
  D:/翻译-插件/tests/core/lang.test.ts
  D:/翻译-插件/tests/core/pool.test.ts
  D:/翻译-插件/tests/core/segmenter.test.ts
  D:/翻译-插件/tests/engines/types.test.ts

  # 在 tests/ 下故意写入 const boom: number = "not a number";
  npx tsc --noEmit -p tsconfig.node.json
  tests/_typecheck_probe.test.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.
  [exit=1]
  ```

  所以测试代码的类型**是**被检查的，`typecheck` 退出码 0 已经覆盖测试；后续单元不必、也不该
  因为「测试类型无人把关」而放松纪律。
- **5 个测试文件与实现是同批新增的，不构成独立回归网。** `git ls-tree e6248fa tests/` 为空——
  base 提交里根本没有 `tests/`。因此「测试一行未动」只说明 `9fa7623` 前后基线一致，
  不能说明这套测试独立于实现存在；审查据此指出的混排回归确实没有网可拦，已在第 6 节补成显式用例。

---

## 4. 修正前后的实测失败清单

复现方式：把任务书里的 10 个 TypeScript 代码块按首行 `// 路径` 注释铺成临时工程（`src/**` + `tests/**`），
用仓库自带的 vitest 跑任务书自带的测试：

```js
// 抽取代码块：md 中每个 ```ts 块的首行注释即目标路径
const blocks = [];
for (let i = 0; i < lines.length; i += 1) {
  if (lines[i].trim() !== '```ts') continue;
  const start = i + 1;
  let end = start;
  while (end < lines.length && lines[end].trim() !== '```') end += 1;
  blocks.push({ path: /^\/\/\s*(\S+\.ts)\s*$/.exec(lines[start])[1], body: lines.slice(start + 1, end) });
  i = end;
}
```

**修正前（`git show 9fa7623^` 的代码块）：**

```
 Test Files  2 failed | 3 passed (5)
      Tests  2 failed | 46 passed (48)

 FAIL  tests/core/lang.test.ts > detectScript > 中英混合按多数决
AssertionError: expected 'latin' to be 'zh' // Object.is equality

 FAIL  tests/core/segmenter.test.ts > splitBySentence > 英文按句末标点切分
AssertionError: expected [ 'One.', ' Two.', ' Three.' ] to deeply equal [ 'One. ', 'Two. ', 'Three.' ]
```

**修正后（当前 `wu2.md` 的代码块）：**

```
 Test Files  5 passed (5)
      Tests  48 passed (48)
```

### 复核记录：失败清单是 2 条，不是 3 条

规格符合性审查曾把 `splitBySentence > 中文按句号切分`
（`expect(splitBySentence('第一句。第二句。第三句。', 6)).toEqual(['第一句。', '第二句。', '第三句。'])`，
`tests/core/segmenter.test.ts:59-61`）记为第 3 条失败。实测不成立：该条在**修正前后两种正则下都通过**——
修正前那次运行的逐条输出里它是 `✓ 中文按句号切分 0ms`（同一文件里只有英文那条是 `×`），
修正后 `segmenter.test.ts` 整文件 14 passed（vitest 对全通过的文件不逐条打印）。
再用两种正则直接跑该断言，结论一致：

```
--- OLD [。！？；!?;]|\.(?=\s|$) ---
中文按句号切分: PASS got=["第一句。","第二句。","第三句。"]
英文按句末标点切分: FAIL got=["One."," Two."," Three."]
--- NEW [。！？；!?;]\s*|\.(?=\s|$)\s* ---
中文按句号切分: PASS got=["第一句。","第二句。","第三句。"]
英文按句末标点切分: PASS got=["One. ","Two. ","Three."]
```

原因：`maxLen = 6`，每个窗口（如 `'第一句。第二'`）里最后一个句界是窗口内第 4 个字符 `。`，
两种正则都得到 `cut = 4`（新正则的 `\s*` 在 `。` 后面没有空白可吃，长度不变），切分结果自然相同。
留档在此，避免以后再按「3 条失败」复述。

---

## 5. 候选口径对比（审查意见 #2：修复方向的论证不完整）

1.1 节把「计数字符这一口径无解」直接推成了「只能改成纯片段数」，没有把第三种口径列入比较。
补齐如下。判定基准是任务书自带的冻结断言：`detectScript` 的 7 条
（`'这是一段中文'`、`'日本語のテキストです'`、`'한국어 텍스트'`、`'Hello world'`、
`'Hello world 世界'`、`'你好世界 Hello'`、`'123 --- !!!'`）加 `shouldSkip` 的 5 条纯语种断言，
外加审查指出的混排回归 `shouldSkip('aaaaa 你好', 'zh-Hans')` 必须为 `false`。

| 口径 | `'你好世界 Hello'` | `'aaaaa 你好'` | 7 条冻结断言 | 结论 |
| --- | --- | --- | --- | --- |
| ① 计数字符（修正前原文） | `latin` ✗ | `latin` | 不通过 | 与断言冲突，淘汰 |
| ② 只数连续片段（`9fa7623` 采用） | `zh` ✓ | `zh` ✗ | 通过 | 丢掉段长，混排段落静默漏翻，淘汰 |
| ③ 片段分 `1 + floor(log2(段长))`（本轮采用） | `zh` ✓ | `latin` ✓ | 通过 | 段数与段长同时参与，采用 |

实测矩阵（探针跑在仓库自带的 vitest 上，首列是三种口径各自的结果；探针文件已删除）：

```
case                          | ①字符数 | ②片段数 | ③1+floor(log2) | 实现(含同分规则)
"Hello world 世界"             | latin   | latin   | latin          | latin
"你好世界 Hello"               | latin   | zh      | zh             | zh      ← 冻结断言要求 zh
"aaaaa 你好"                   | latin   | zh      | latin          | latin   ← 回归用例要求 latin
"中文 abcde"                   | latin   | zh      | latin          | latin
"Hi 你好"                      | zh      | zh      | zh             | latin
"你好 Hi"                      | zh      | zh      | zh             | zh
"这是一段较长的中文内容，Hello"   | zh      | zh      | zh             | zh
```

两条必须写清楚的实施细节：

- **不能直接用精确的 `1 + log2(段长)`。** 审查建议里举的就是这个写法，并称
  `'你好世界 Hello'` 仍是 `zh`；实测不成立——中文 1 段 4 字得 `1 + log2 4 = 3` 分，
  拉丁 1 段 5 字母得 `1 + log2 5 ≈ 3.32` 分，结果仍是 `latin`，会把 ① 的失败原样打回来。
  必须先把段长**分档**（`floor(log2)`，4 与 5 个字符同档）再计分，`'你好世界 Hello'` 才回到平局。
- **同分不能交给 `SCRIPT_PATTERNS` 的表序。** 表序是一条隐式产品契约：谁重排数组，
  谁就静默改了「这段话翻不翻」。实现里把平局规则显式化：得分与首次出现位置都比不出来时，
  由表序兜底（一个字符只属于一个字符集，实际到不了这一步）；而 `shouldSkip` 只要发现
  有其它字符集与目标字符集**同分**，就按低置信度返回 `false`（宁可不跳过：跳过等于放弃翻译，
  错一边就是漏翻）。`'Hi 你好'`、`'你好 Hi'`、`'你好世界 Hello'` 都落在这一档。

## 6. 本轮修复（审查意见 #1、#4–#9）

对应提交：`fix: 修复 wu2 核心层的语种判定回归与若干健壮性问题`（`git log --oneline` 可见）。

| 意见 | 文件 | 改法 |
| --- | --- | --- |
| #1 语种判定丢段长 | `src/core/lang.ts` | 计分改为「每个连续片段计 `1 + floor(log2(段长))`，各段求和」；同分先出现者优先；`shouldSkip` 加同分不跳过的保守偏置 |
| #1 回归网 | `tests/core/lang.test.ts` | 新增 5 条用例：`'aaaaa 你好'`/`'中文 abcde'` 判 `latin`、`'Hi 你好'`/`'你好 Hi'` 的先出现者规则、`shouldSkip` 同分不跳过、短汉字段不敌长拉丁段不跳过、长中文段落仍然跳过 |
| #9 逐字符重置 `lastIndex` | `src/core/lang.ts` | 删掉按通用 `RegExp` 建模的 `countRuns`，改为单遍扫描码点区间；`SCRIPT_PATTERNS` → `SCRIPT_RANGES` |
| #4 `maxLen ≤ 0` 死循环 | `src/core/segmenter.ts` | 入口 `RangeError`（`!Number.isFinite(maxLen) \|\| maxLen < 1`），覆盖 `0`/负数/`NaN`/`Infinity`/`0.5` |
| #5 局部变量遮蔽 `window` | `src/core/segmenter.ts` | `window` → `chunk` |
| #6 模块级 `g` 正则共享 `lastIndex` | `src/core/segmenter.ts` | 改为 `sentenceBoundary()` 每次现取新实例，删掉调用点手工重置 |
| #7 批次预算不含编号开销 | `src/core/segmenter.ts` | 新增 `PER_SEGMENT_OVERHEAD = 8`，单段成本按「正文 + 开销」计（超预算判定与累计预算都用它） |
| #8 `toEngineError` 丢 `cause` | `src/engines/types.ts` | `EngineError` 构造函数接受 `ErrorOptions`；`Error` 分支（含 `AbortError` 分支）传 `{ cause: raw }` |
| #4/#7/#8 的行为 | `tests/core/segmenter.test.ts`、`tests/engines/types.test.ts` | 新增 3 条：`maxLen` 非法抛 `RangeError`、45 字两段因开销拆批、`cause` 指向原始错误 |

本轮同步与复核（真实输出）：

```
npm test            → Test Files 5 passed (5) / Tests 56 passed (56)     # 修复前 48
npm run typecheck   → exit 0
npm run build       → exit 0，两个 vite 产物均生成
```

任务书同步：把母本 `2026-09-14-immersive-translate-core.md` 里 6 个代码块
（`src/core/lang.ts`、`tests/core/lang.test.ts`、`src/core/segmenter.ts`、`tests/core/segmenter.test.ts`、
`src/engines/types.ts`、`tests/engines/types.test.ts`）重新对齐磁盘，再用 `scripts/split-plan.mjs`
重新切片——`wu1`、`wu3`–`wu10` 逐字节未变，只有 `wu2.md` 变化。
复核方式：按「首行 `// 路径` 注释即落盘路径」抽出 `wu2` 的 10 个代码块与磁盘逐字节比对，
**10/10 一致**（`hash.ts`、`pool.ts` 及其测试 4 块未动，其余 6 块已同步）。
1.3 节那段「混排段落会被整段跳过」的任务书备注也随口径改写成新语义，避免后续 WU 照旧写法实现。

未采纳的审查建议：#5「在 CI 里断言 `src/core/**` 出现 `import` 即失败」——仓库当前没有 CI 配置，
这属于新增防线而不是本轮缺陷，按「只修审查指出的问题」留待单开一个单元时再加。

---

## 7. 第二轮修复（本轮审查意见 #1–#5）

对应提交：`fix: 修复语种计分的碎片化漏翻与 zh-Hant 跳过判定等审查意见`（`git log --oneline` 可见）。
代码改动：`src/core/lang.ts`、`src/core/pool.ts`、`src/core/segmenter.ts`（仅注释）、
`tests/core/lang.test.ts`、`tests/core/pool.test.ts`；同步母本计划与本留档。

### 7.1 意见 #1：按「连续片段」计分确实会漏翻，但审查给的验收断言自相矛盾

**成立的部分（已改）：** 按片段计分让结论取决于标点怎么切——拉丁文天然被空格切成多段，
中文一句话通常只有 1 段，于是同一段文本里中文按 1 段拿分、拉丁按好几段拿分。修复前实测：

```
detect=latin   skip(zh-Hans)=false skip(en)=true  skip(zh-Hant)=false zh=18 lat=10  这是一段很长的中文内容需要翻译成英文。Hello world
```

18 个汉字 vs 10 个字母却判成 `latin`；目标为英文时 `shouldSkip` 返回 `true`，整段跳过、汉字一个不翻。
改成**按各字符集字符总数分档**（`1 + floor(log2(字数))`，同分先出现者优先）后：

```
detect=zh      skip(zh-Hans)=true  skip(en)=false skip(zh-Hant)=false zh=18 lat=10  这是一段很长的中文内容需要翻译成英文。Hello world
detect=zh      skip(zh-Hans)=true  skip(en)=false skip(zh-Hant)=false zh=18 lat=10  这是一段很长的中文内容需要翻译成英文 Hello world
```

顺带消掉了「同一句用句号还是空格分隔」这层碎片化差异（上面两行结论一致），
并补上缺的那一格测试：多段中文 + 多段拉丁 + 标点（`tests/core/lang.test.ts`）。

**不成立、没有照做的部分（理由可复核）：**

1. **审查指定的验收断言与它要求冻结的断言互斥。** 审查要求
   `detectScript('中文。English words here') === 'zh'`、`detectScript('这是中文。Hello world foo bar baz qux.') === 'zh'`，
   同时要求 `detectScript('中文 abcde') === 'latin'`、`detectScript('Hello world 世界') === 'latin'` 保持不变。
   前两条与后两条不可能同时成立：`'中文 abcde'`（中文 2 字在下标 0、拉丁 5 字母在下标 4）
   与 `'中文。English words here'`（中文 2 字在下标 0、拉丁 16 字母 3 段在下标 3）
   在「谁先出现」上同型，后者对拉丁的证据只强不弱（字数 16 > 5、段数 3 > 1、中文占比 2/16 < 2/5）。
   任何对「拉丁证据更多」单调的规则（计数、分档、占比、片段数都算），都不可能在前者判 `latin`、
   在后者判 `zh`。所以本轮把这两条举例**按新口径固定为 `latin`**，写成带注释的边界用例，
   而不是改实现去迁就（否则会打回 `'中文 abcde'` 与 `'Hello world 世界'` 两条冻结断言）。
2. **审查给的两条修法都到不了它自己的目标。** 「按总字符数加权」在 `'中文。English words here'`
   上是中文 2 字 vs 拉丁 16 字母，仍判 `latin`；「最短优势」（领先不足则不跳过）要同时满足
   「保留 `shouldSkip('これはテストです', 'ja') === true`」（日文 7 字 vs 汉字 3 字：分档领先 1 档、
   字数比 2.33）与「拦掉 latin 16 vs 中文 2」（分档领先 3 档、字数比 8）——
   按档取阈值 ≤1 会放过后者、≥2 会打回前者；按比取阈值 ≤2.33 会放过后者、>8 才拦得住，同样无解。
   本轮因此只采纳「消除碎片化」这一半，门限除既有的 `tied` 外不再加。
3. **一处事实更正。** 审查自己的探针打印的就是 `skip(zh-Hans)=false`，即这类段落在中文目标下
   **不会**被跳过；静默漏翻只发生在**拉丁目标**下（`skip(en)=true`）。方向仍是漏翻，
   但不是审查正文写的「中文主导的段落被整段跳过」。

**残留边界（记录在案，本轮不修）：** 中文占比很小的段落（如 `'中文。English words here'`，
中文 2 字 / 拉丁 16 字母）仍判 `latin`，目标为英文时会被跳过、那 2 个汉字不翻。
拦它只能靠「目标为拉丁字符集时，段落里出现中文段就不跳过」这类**调用方产品规则**，
不属于检测口径；等 wu3/wu6 接线时按实际语义决定（`shouldSkip` 目前尚无生产调用点）。

### 7.2 意见 #2：`zh-Hant` 目标不做跳过判定

`ScriptLang` 只到字符集一级（`zh-Hant` 与 `zh-Hans` 都是 `'zh'`），分辨不了简繁：
选繁體中文时简体段落被判成「已是目标语言」而整段跳过，简繁互转直接变成 no-op。
`shouldSkip` 入口加 `/^zh-hant(?:-|$)/` 显式豁免（先小写化再匹配），这类目标一律不跳过。
没有按审查的另一条建议从 `LANGUAGES` 里删掉 `zh-Hant`：`wu3.md` 的
`toGoogleLang('zh-Hant') === 'zh-TW'` 已把它当正式选项，删它会连带改 wu3。
`zh-Hans` 的快路径未动（`shouldSkip('这是一段中文', 'zh-Hans') === true` 仍是冻结断言）。

### 7.3 意见 #3：`runPool` 的 `limit` 守卫

`limit = NaN` 时 `Math.max(1, Math.min(NaN, n))` → `NaN` → `Array.from({length: NaN})` → 0 个 worker
→ `Promise.all([])` 立即 resolve，返回一个**全是 `undefined`** 的数组且不报错。
入口加 `if (!Number.isFinite(limit) || limit < 1) throw new RangeError(...)`，与 `splitBySentence` 同款。
注意 `runPool` 是 `async`，抛出变成 **rejection**，所以测试用 `rejects.toThrow(RangeError)`。

### 7.4 意见 #4：测试计数与分解式

逐文件 `it()` 复核（`git show <rev>:<file>` 后按 `^\s*it\(` 计数）：

```
a549698^   6 + 17 + 4 + 14 + 7 = 48
a549698    6 + 22 + 4 + 16 + 8 = 56     # 新增 8 条 = lang +5、segmenter +2、types +1
本轮        6 + 29 + 5 + 16 + 8 = 64     # 新增 8 条 = lang +7、pool +1
```

文件顺序：`tests/core/hash.test.ts`、`tests/core/lang.test.ts`、`tests/core/pool.test.ts`、
`tests/core/segmenter.test.ts`、`tests/engines/types.test.ts`。
交接报告里的分解式 `17+14+7+6+4` 求和是 39，与该报告自己的总数 48 不符；
第 6 节只写了总数 48→56（正确），上文是可用命令复核的分解式。

### 7.5 意见 #5：`segmenter.ts` 的前向引用

注释里的 `见 background/scheduler.ts` 改成 `见 units/wu3，待建的 src/background/scheduler.ts`，
避免读成「文件丢了」。

### 7.6 本轮未照做的意见

- **意见 #6（`SCRIPT_RANGES` 只覆盖 BMP 常用块，CJK 扩展 B 与 `U+3000-303F` 落空）**：
  审查自己写明「不建议现在动」，本轮不动；`unknown` 在 `shouldSkip` 一侧是不跳过（安全方向）。
- **本轮审查的建议 #4（CI 断言 `src/core/**` 不得出现 `import`）与建议 #5（`pool.ts` 补写失败语义注释）**：
  是「建议」不是「问题」，本轮范围限定为修审查列出的问题，未做。建议 #4 成本很低
  （一个 vitest 断言文件即可），要加时单独提。
  （注意与第 6 节末的「未采纳建议 #5」区分：那是**上一轮**审查的建议编号。）

### 7.7 本轮同步与复核（真实输出）

```
npm test            → Test Files 5 passed (5) / Tests 64 passed (64)
npm run typecheck   → exit 0
npm run build       → exit 0（dist/background.js、dist/content.js、dist/manifest.json 等均生成）
```

任务书同步：把母本里 5 个代码块（`src/core/lang.ts`、`tests/core/lang.test.ts`、
`src/core/segmenter.ts`、`src/core/pool.ts`、`tests/core/pool.test.ts`）重新对齐磁盘，
再跑 `scripts/split-plan.mjs`——`wu1`、`wu3`–`wu10` 逐字节未变，只有 `wu2.md` 变化；
Task 3 的「实现备注」也随口径改写（原文描述的正是被否掉的按片段计分）。
复核 wu2 的 10 个代码块：**本轮改过的 5 块与磁盘逐字节一致**；
`src/core/hash.ts`、`src/engines/types.ts` 两块围栏内首行多一个空行（本轮未动这两个块，属既有格式差异）。
