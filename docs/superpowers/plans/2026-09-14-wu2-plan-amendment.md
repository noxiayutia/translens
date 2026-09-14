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
与断言要求的 `'zh'` 直接冲突。调 `SCRIPT_PATTERNS` 顺序、调权重都无法同时满足同组里的两条断言，属无解。

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

`wu2.md` 里另加了一段 `shouldSkip` 混排行为备注：`detectScript` 按连续片段数取多数后，
中文与拉丁各占一段的混排段落会被整段跳过（`shouldSkip('Hello 你好世界', 'zh-Hans') === true`）。
该行为已被本单元测试冻结；若产品上要求这类段落参与翻译，要改的是 `lang.test.ts` 的期望与那段说明，
而不是只改实现。

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

- **测试一行未动**：5 个测试文件在 `9fa7623^` 与 `HEAD` 的 blob 哈希完全相同。

  | 测试文件 | blob |
  | --- | --- |
  | `tests/core/hash.test.ts` | `6d437fd297ae34c78162620f75f9c07d1f0a41d0` |
  | `tests/core/lang.test.ts` | `fb07a414fbece402763d50df75ad8f5b26b292a5` |
  | `tests/core/segmenter.test.ts` | `08714d304a949b7248de4fd2ccfba3a50797c1d3` |
  | `tests/core/pool.test.ts` | `cd7920e00fc85fa5825e36d4529e4bcff6a134e2` |
  | `tests/engines/types.test.ts` | `5eac7e0e83798c752b04e86f84ac0fcc0b707423` |

- **实现一行未动**：`git diff bd78366..HEAD -- src tests` 为空；`9fa7623` 只改了两个 `.md`。
- **代码块与磁盘一致**：把当前 `wu2.md` 里 10 个 TypeScript 代码块抽出来（首行 `// 路径` 注释是落盘路径），
  去掉标记行后与仓库 `HEAD` 的同名文件 **10/10 逐字节一致**；修正前该口径下是 8/10
  （5 个测试块全部一致，2 个实现块不一致——即 1.1 / 1.2）。
- 本次修复只新增本文件：`src/**`、`tests/**` 与任务书（`wu2.md` 及母本）均未再改动。
  复核用的临时工程建在 `%TEMP%` 下，已删除。

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
