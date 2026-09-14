# wu3 任务书修正留档（Plan 1 · Task 7–9）

## 当前口径（截至本次修复）

1. `src/engines/google.ts` **与 `docs/superpowers/plans/units/wu3.md` 的 Step 3 代码块逐字节一致**（去掉块内 `// src/engines/google.ts` 标签行）；`parseGoogleResponse` 按 `data[0]` 取句子数组，不做信封结构下钻。
2. Google 免费接口的真实返回形状是 `[[[译文, 原文, ...], ...], null, "en", ...]`——**顶级就是 4 层嵌套**，句子数组在 `data[0]`。测试 fixture 的 `googleBody` 已修正为该形状。
3. `src/engines` / `tests/engines` 下 6 个 ts 代码块（Task 7–9 各一实现一测试）现在全部与任务书逐字节一致；本轮**没有放宽任何断言、没有删改任何用例**。

> 本文件是**留档**，不是任务书的一部分，也不参与实施。
> 它记录一件事：`docs/superpowers/plans/units/wu3.md` 及其母本在本轮被改过（只改了一行 fixture），
> 以及为什么必须改、原文如何复原、验收基线有没有被放宽。任何关于 Task 7–9 的规格核对都应以本文件为入口。

| 项 | 值 |
| --- | --- |
| 被修正的需求源文件 | `docs/superpowers/plans/units/wu3.md`（子代理读物）<br>`docs/superpowers/plans/2026-09-14-immersive-translate-core.md`（母本，units 由 `scripts/split-plan.mjs` 生成） |
| 受影响的实现 | Task 7 `src/engines/google.ts`（回退为任务书字面实现） |
| 未受影响 | `src/**` 其余文件、`tests/**` 其余文件、`package.json`、构建配置——`git diff --name-only -- src tests` 只有 `src/engines/google.ts` 与 `tests/engines/google.test.ts` |

复核结论：**原文 fixture 自相矛盾**——它比同一段代码上方自己的注释多包了整整一层数组，
导致任务书 Step 3 的实现代码过不了 Step 1 自带的第一条 `parseGoogleResponse` 断言（见第 1 节）。
测试是验收基线，所以改的是任务书里的 fixture，不是断言、也不是测试期望；
改 fixture 之后任务书 Step 3 的实现**原样**通过全部 10 条断言，于是实现也回退成逐字一致（见第 2 节）。

---

## 1. 为什么必须改

### 1.1 任务书的 fixture 与自己的注释不一致

**修正前（原文，`wu3.md:22-25` = 母本 `:1468-1471`）：**

```ts
/** Google 免费接口的真实返回结构：[[[译文, 原文, ...], ...], null, "en", ...] */
function googleBody(translations: string[]): unknown {
  return [[translations.map((t) => [t, 'source', null, null, 10]), null, 'en']];
}
```

**自带断言（`wu3.md:36-38`，原文与现状完全一致）：**

```ts
it('拼接多个分句', () => {
  expect(parseGoogleResponse(googleBody(['你好', '世界']))).toBe('你好世界');
});
```

**矛盾：** 注释写的是 `[[[译文, 原文, ...], ...], null, "en", ...]`——顶级 4 层嵌套，句子数组在 `data[0]`；
而 fixture 实际造出来的是 `[[[译文, 原文, ...], ...], null, "en"]`**再包一层**，也就是顶级 5 层、句子数组落在 `data[0][0]`。
把这份 fixture 交给 Step 3 的实现（`for (const chunk of data[0] as unknown[])`，`wu3.md:149`）走一遍：
`data[0]` 是 `[句子数组, null, "en"]`，第一个元素**是数组但不是「首项为字符串」的句子块**，
没有任何片段进 `parts` → `text.length === 0` → 抛 `BAD_RESPONSE: 免费接口返回空译文`，断言要的 `'你好世界'` 拿不到。

沿用仓库既定判据（同 wu2 留档）：**断言是验收基线，是 fixture 而不是断言写错了。**
fixture 的作用是模拟真实返回，而真实 `translate_a/single`（只带 `dt=t`）返回的就是注释描述的形状，
`data[0]` 即句子数组——**fixture 是错的那一方**。

### 1.2 同一缺陷来自母本，不是 units 转抄失误

母本 `2026-09-14-immersive-translate-core.md:1468-1471` 的 fixture 与 `:1590-1601` 的实现代码块完全相同，
即这是**创作期的原始缺陷**：母本自己的实现与自己的 fixture 冲突。
`units/wu3.md` 由 `scripts/split-plan.mjs` 从母本切出，两处必须同时改，否则下一轮重新切分会把缺陷带回来。

---

## 2. 改了哪一行、以及为什么实现要跟着回退

**修正后（现状，与 `wu3.md:24`、母本 `:1470`、`tests/engines/google.test.ts:14` 逐字节一致）：**

```ts
/** Google 免费接口的真实返回结构：[[[译文, 原文, ...], ...], null, "en", ...] */
function googleBody(translations: string[]): unknown {
  return [translations.map((t) => [t, 'source', null, null, 10]), null, 'en'];
}
```

去掉了最外层那对 `[ ]`。改动只有这一行（两个文档各一行）+ 测试文件同一行，
注释不用动——修正之后它描述的就是 fixture 本身。

现状 `src/engines/google.ts` 已回退为 `wu3.md:127-190` 的**字面实现**：删掉 `isSentenceList` /
`MAX_ENVELOPE_DEPTH` / `locateSentenceList` 三个原文没有的内部符号，`parseGoogleResponse` 恢复
`if (!Array.isArray(data) || !Array.isArray(data[0]))` + `for (const chunk of data[0] as unknown[])`。
导出面、错误码、错误文案与任务书完全一致，`src/engines/google.ts` 由 77 行回到 61 行。

回退的安全性是实测的，不是推断的（第 3 节第 2 条）：**两种实现对真实返回形状（单句、多句）行为完全一致**，
差别只在「信封比真实形状更深」时——而那不是真实形状。

---

## 3. 实测证据

1. **机械比对**：从 `wu3.md` 用脚本提取全部 6 个 ` ```ts ` 围栏块，去掉首行 `// <路径>` 标签行后与仓库文件
   逐行逐字符（区分大小写）比对 → `6 个代码块，不一致 0 个`，其中 `src/engines/google.ts` 61/61 行、
   `tests/engines/google.test.ts` 106/106 行。修正问题 A（偏离）与问题 B（标签行）之后，偏离项归零。
2. **两种实现逐例对照**（临时探针，跑完即删；`字面实现（现行）` vs `下钻实现（改动前）`）：

   | 输入 | 字面实现（现行） | 下钻实现（改动前） |
   | --- | --- | --- |
   | 真实形状 单句 | `OK "你好"` | `OK "你好"` |
   | 真实形状 多句 | `OK "你好世界"` | `OK "你好世界"` |
   | 修正后 fixture（= 真实形状） | `OK "你好世界"` | `OK "你好世界"` |
   | 改动前 fixture（多包一层） | `THROW BAD_RESPONSE: 免费接口返回空译文` | `OK "你好世界"` |
   | `{}` | `THROW BAD_RESPONSE: 免费接口返回格式异常` | 同左 |
   | `[[], null, "en"]` | `THROW BAD_RESPONSE: 免费接口返回空译文` | `THROW …格式异常` |
   | `[[[], null, "en"]]` | `THROW BAD_RESPONSE: 免费接口返回空译文` | `THROW …格式异常` |
   | `[["你好"], null, "en"]`（无原文位） | `THROW BAD_RESPONSE: 免费接口返回空译文` | `OK "你好"` |
   | `[[""]]` | `THROW BAD_RESPONSE: 免费接口返回空译文` | 同左 |
   | `"str"` / `[null, null, "en"]` | `THROW BAD_RESPONSE: 免费接口返回格式异常` | 同左 |
   | `[[[["你好"]]]]`（三层信封） | `THROW BAD_RESPONSE: 免费接口返回空译文` | `OK "你好"` |

   结论：回退**不碰真实返回形状**；差异只出现在「信封比真实形状更深」的畸形输入上。
   另一个方向的收益：`[[], null, 'en']` 这条自带断言（`译文为空时抛 BAD_RESPONSE`）现在走的是
   实现里**它就是为之而写**的「空译文」分支，而不是被下钻逻辑提前判成「格式异常」；
   `wu3.md:59-66` 只断言 `code`，所以两种实现都通过，但字面实现与用例名的语义才是对齐的。
3. **自带断言**：`npx vitest run tests/engines/google.test.ts` → `Tests 10 passed (10)`，exit 0。
   这是「修正后的 fixture + 任务书字面实现」这一组合的直接证据。
4. **未放宽基线**：`npm test` → `Test Files 9 passed (9)` / `Tests 112 passed (112)`，exit 0；
   `npm run typecheck` → exit 0。断言逐条未动，用例数仍是 112（83 个既有 + 29 个新增）。

---

## 4. 原文如何复原

本轮与上一轮（`01568c3`）之间任务书只有两处差异，都是第 2 节那一行 fixture（units 与母本各一处）。
不查 git 也能还原：把那行改回 `return [[translations.map(...), null, 'en']];` 即可。要拿逐字节原文：

```powershell
git show 01568c3:docs/superpowers/plans/units/wu3.md                            # 子代理读物
git show 01568c3:docs/superpowers/plans/2026-09-14-immersive-translate-core.md  # 母本
git diff 01568c3 HEAD -- docs                                                   # 完整差异
```

---

## 5. 本轮明确未做的事（避免下一轮误判为遗漏）

- **没有**放宽或改写任何断言，**没有**删改任何用例，**没有**给 fixture 保留「两种嵌套都收」的宽容解析：
  按第 1 节的判据，修的是需求源里的 fixture，实现按规格回到字面，双形状解析一并删除。
- **没有**为了让测试通过而把实现改成 `data[0][0]`——那会真的搞坏真实 API（多分句时把 `"你"` 当译文拼进去）。
- **没有**新增导出、没有动 `src/engines` 其它文件、没有动 `package.json` / `vitest.config.ts` / tsconfig。
- `tests/engines/google.test.ts` 的 fixture 行**必须**跟着改：它是 Step 1 交付物，不改就与修正后的任务书不再逐字节一致，
  而它原先那份 fixture 模拟的是一个真实接口不会返回的形状。
