# 删掉 Google 免费接口（单元 E）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「Google 免费接口」这条路径从**存储、注册表、界面、权限与文案**里整体抹掉，并把「没有可用引擎」立成**一等状态**：由 `resolveEngine` **一处**产出（`engine === null` + `NO_ENGINE_PROBLEM`）、由弹窗与设置页**如实显示**、由后台**在发请求之前**拦住，且**零网络请求**。

**Architecture:** 引擎层从「两个适配器 + 未知 id 静默兜底」收敛成「一个适配器 + `getEngine` 返回 `null` 且**不兜底**」；数据层 `CURRENT_VERSION` 4 → 5、`DEFAULT_SETTINGS.engineId` 变 `''`、v4 → v5 迁移把 `engineId: 'google'` 改指向**第一个有 `activeModel` 的档案**（一个都没有就置空）；界面层删掉设置页的免费引擎行 / `test-free` / `e:` 键空间，弹窗下拉只列档案并在一个档案都没有时隐藏整行；权限层清空 `host_permissions` 并把 `description` / `content/index.ts` 两条假话改掉。

**Tech Stack:** TypeScript（`tsc --noEmit`，`strict` + `noUnusedLocals`）+ Vitest（`tests/**/*.test.ts`，jsdom 与 node 两种环境）+ Vite 双构建（`npm run build` → `verify:dist` 14 项）+ `npm run zip`。

**规格：** `docs/superpowers/specs/2026-09-20-remove-free-engine-design.md`（`977cb89`，811 行，已逐行读完）。
**格式范本：** `docs/superpowers/plans/2026-09-20-apple-visual-style.md`（单元 D）。

---

## 已核实的前提（不要重新发明）

0. **执行前提**：实现者从「仓库 + 本 Task 的小节」出发。已有文件**直接读文件**（用 `read` 工具）。
   ⚠ **读中文文件一律用 `read` 工具，不要用 pwsh 的 `Get-Content`**——PowerShell 5.1 按 GBK 解 UTF-8，
   会把中文打乱甚至吞掉换行（本计划起草时亲眼复现：`src/core/hash.ts` 的注释读出来是
   `浠婂ぉ涓や釜寮曟搸…`）。`edit` 的锚点从 `read` 的输出里逐字复制。
   ⚠ **写文件只用 `edit` / `write`，绝不用 pwsh 重写**（单元 D 封账后真踩过：`Get-Content -Raw` +
   `Set-Content -Encoding utf8` 给 `popup.css` 加了 BOM、中文全变乱码）。
   **锚点纪律**：每次 `edit` 前确认 `old_string` 在该文件**恰好出现一次**；本计划给出的锚点已逐条
   在起草时核过（同一锚点在别的文件里也出现的，计划里写明了以哪个文件为准）。

1. **基线读数（起草时实测，全部 exit 0）**：

   | 读数 | 命令 | 起草时实测值 |
   | --- | --- | --- |
   | 测试 | `npx vitest run` | **55 files / 1061 passed**，exit 0 |
   | 类型 | `npm run typecheck` | exit 0 |
   | 构建 | `npm run build` | exit 0，尾部 `✓ 产物校验全部通过（14 项）`，产物清单 **16 个文件，共 167.66 KB** |
   | 打包 | `Get-ChildItem *.zip` + `Get-FileHash -Algorithm SHA256` | `jinyi-0.1.0.zip`，**65643 字节**，SHA256 `048567C7AA429E78E394727A5BC278EBD22E9F921764F3371D7299253AA015B2` |

   ⚠ **这些值必然变化**（删掉一个测试文件、改文案、改 manifest 都会动它们）。基线只用于"变化是
   预期的"这一条判断；收口时**以新读数入账**（见文末「落地读数表」），不许把它们当成要保持的目标。

2. **引用纪律（本仓硬规矩）**：写进仓库的注释与断言里引用代码位置，**一律用符号名 / 选择器 /
   断言措辞，不钉行号**（行号会漂，本仓已因此交过 N 次学费）。本计划正文里的行号只是起草时的
   导航快照，**不得抄进代码注释**。历史规格/计划**不追溯**（规格抬头已记账）。

3. **规格里已拍定、本计划不推翻的裁决**（§1.2 a–e）：`host_permissions` 清空而
   `optional_host_permissions` 不动；失效 id 的新语义 = 没有引擎 + 一句可行动的话 + 零请求，
   文案唯一出处是 `resolveEngine`；`supportsGlossary` 与后台那道门槛保留为**适配器契约**并如实
   记账"今日恒真、无判别力"，**不为它编断言**；`e:` 键空间随免费引擎消亡且 `e:free` 用例必须
   改写成仍成立的不变式；历史文档不追溯而 README 必须改。

4. **`engineId: 'google'` 在测试里恰好 22 处**（本计划起草时复跑 `grep` 逐文件核对，与规格 §7.2
   的分布逐字一致）：`tests/options/engine-health.test.ts` 5、`tests/popup/popup.test.ts` 6、
   `tests/shared/settings.test.ts` 4、`tests/options/options.test.ts` 3、
   `tests/options/engine-models.test.ts` 2、`tests/background/service-worker.test.ts` 1、
   `tests/core/hash.test.ts` 1。**控制器之前说的"约 40 处"是把 `DEFAULT_ENGINE_ID` /
   `getEngine(DEFAULT_ENGINE_ID)` / `FREE_ENGINE_HEALTH_KEY` 一类引用一起算进去了**；
   **22 是正确口径**，且**逐类处置、不许批量替换**。

5. **本单元会碰到的每个"必红"点都已定位**（起草时逐条读过源文件与测试）：

   | 落点 | 为什么必红 |
   | --- | --- |
   | `src/engines/registry.ts` 的 `getEngine(): Translator` | 返回类型改 `Translator \| null` 后，`settings.ts`、`options/sections/engine.ts`、`popup.ts`、`tests/engines/registry.test.ts` 全部编不过 |
   | `tests/options/engine-expansion.test.ts`「新增档案那一行也是就地追加」 | 用了三处 `[data-engine-free]`，删行后 `null === null` / `null !== null` 会**静默恒真通过** |
   | `tests/options/engine-health.test.ts`「存储里是垃圾也不崩」 | 末尾"钉住内置免费引擎那一行"是"页面照常渲染"的**唯一**证据，删掉等于让这条用例在"`mount` 里根本不渲染"的变异下重新变绿 |
   | `tests/options/engine-health.test.ts`「内置免费引擎那一行」四条 | 那一行没有了 |
   | `tests/options/engine-health.test.ts`「档案 id 直接取成引擎键本身（`e:free`）」 | 它守的"前缀不同 ⇒ 两类键永不相等"随 `e:` 一起失去对象 |
   | `tests/background/service-worker.test.ts` 四条**不调 `useSettings`** 的缓存用例 | 靠 `DEFAULT_SETTINGS.engineId === 'google'` 才跑得通（它们连设置都不写） |
   | `tests/background/service-worker.test.ts` 的 `stubGoogleFetch()` | 它造的是 Google 的嵌套数组响应，今天还有 `google.ts` 在解析；删掉之后**没有生产代码会读这个形状** |
   | `tests/content/index.test.ts`「全部条目网络失败时…」 | 逐字断言 toast 含「自定义 API」，而新文案里没有这个词 |
   | `tests/options/options.test.ts`「删除当前在用的档案…」 | 断言 `engineId` 落到 `DEFAULT_ENGINE_ID`、状态行含 `getEngine(DEFAULT_ENGINE_ID).name`、`.row-actions` 不含「使用中」 |
   | `tests/popup/popup.test.ts` 六处 + `tests/shared/settings.test.ts` 四处 | 见 T1 的逐处清单 |

6. **"改了也不会红"的三类（必须靠本计划点名，不许给它们编恒真断言）**：
   ① `describeError` 的 `RATE_LIMIT` 罐头文案（`src/content/index.ts`）**全仓无测试钉住**——
   起草时复跑：`免费接口限流` 只出现在 `src/content/index.ts` 与 `README.md`，测试里一处都没有；
   ② `manifest.json` 的 `description`**没有任何测试引用**；
   ③ 设置页 `#engine-hint` 的文案**今天也没有任何测试钉住**（`pick('engine-hint')` 在
   `tests/options/**` 里 0 次命中）——本计划用"把垃圾用例的承重读数换成它"来补上这一处（T1 S4）。

7. **本单元的一个结构性事实（本计划的核心约束）**：`getEngine` 的返回类型一改成
   `Translator | null`，`settings.ts` / `popup.ts` / `options/sections/engine.ts` /
   `service-worker.ts` **同时编不过**——它**不可能**拆成"引擎层先做完、数据层再做"的多个绿提交。
   本仓铁律是**提交时 typecheck 干净**（单元 C 的字段改名已有先例：中间态不可编译 → 裁决合并成
   一个提交）。因此本计划把规格 §10 的 E1/E2/E3 合并成 **T1 一个提交**，只把**互不相干的两层**
   （权限与文案 = T2、README 与收口 = T3）留在外面。

---

## 开工前检查（每个 Task 的第一件事，不许跳）

### 并发在途改动（另一个会话在做，**未提交**）

用户另一个会话正在同一个工作树里把扩展改名成 **TransLens**。起草时 `git status --porcelain -uall`
给出的是下面这一份（**比控制器交办时列的多 4 项**，逐项核对过 `git diff`）：

| 文件 | 内容 | 归谁 |
| --- | --- | --- |
| `src/manifest.json` | `name`/`default_title` 已改，`description` 还是旧的 | 改名会话 |
| `src/icons/16.png`、`32.png`、`48.png`、`128.png` | 新图标（薄荷青箭头） | 改名会话 |
| `scripts/make-icons.mjs` | 生成器改写 + 自检 | 改名会话 |
| `src/options/options.html` | `<title>`、导航品牌块、`sr-only` 标题 | 改名会话 |
| `src/options/options.css` | `.glyph` 的字号/字距（拉丁首字母 `T`） | 改名会话 |
| `src/popup/popup.html` | `<title>`、品牌名、箭头配色 | 改名会话 |
| `src/content/diagnose.ts` | `【浸译诊断】` → `【TransLens 诊断】` | 改名会话 |
| `tests/content/diagnose.test.ts`、`tests/content/diagnose-wiring.test.ts` | 同一处文案断言 | 改名会话 |
| `package.json` | `description`、`logo` 脚本 | 改名会话 |
| **`README.md`** | 标题、安装节、图标说明、命令表、目录结构（**`:7` 的「默认使用免费…」还没改**） | **改名会话（控制器清单里漏了）** |
| **`scripts/verify-dist.mjs`** | `checkChineseField(name)` → `checkUtf8Field(name)` + `checkChineseDescription(description)` | **改名会话（控制器清单里漏了；它是改名的前置：`name: "TransLens"` 不含 CJK，旧校验会 fail）** |
| **`docs/brand/translens-logo.png`**、**`scripts/make-brand-logo.mjs`**（未跟踪） | 品牌 logo 与生成脚本 | **改名会话（控制器清单里漏了）** |

⚠ **控制器交办时说「README.md:1/27/57 今天还是旧名」——这条已经过时了**：起草时工作树里
`README.md:1` 已经是 `# TransLens`、`:27`/`:63` 也已经是 TransLens（都是改名会话的未提交改动）。
T3 开工时**重新读一遍 README 再动手**，不要照抄交办时的行号或"还是旧名"这个判断。

### 三条硬规矩

1. **每个 Task 开工前与提交前都跑 `git status --porcelain -uall`**，并把输出贴进该 Task 的提交说明。
2. ⚠ **`git commit -- <路径>` 只保证"不带别的路径"，不保证"不卷走同路径上别人的未提交改动"。**
   所以提交前必须逐路径确认：**这几个文件上的改动只有我自己的**（`git diff -- <路径>` 与本 Task 的
   Files 清单逐条对齐；出现任何本 Task 没打算改的行，**停手**）。
3. **禁止整树 VCS 操作**（`git add -A`、`git stash`、`git checkout .`、`git commit -a`、任何历史改写）。
   提交一律：先 `git add -- <路径…>`，再 `git commit -m '<信息>' -- <路径…>`。
   ⚠ **提交信息里不许用英文双引号**（pwsh 会提前截断——控制器刚踩过），一律用「」。

### 等待条件（写死，不许绕过）

- **T1 可以在任何时候开工**：它要碰的 17 个文件里**没有一个是改名会话的在途文件**
  （`src/popup/popup.html` 与 `src/manifest.json` **不在** T1 的 Files 里）。
  ⚠ **T1 期间不得触碰**上面表格里的**全部 14 个路径**（含两个未跟踪文件）＋
  `src/options/options.html` / `src/options/options.css` / `scripts/verify-dist.mjs`。
- **T2 开工前**：`git status --porcelain -uall` 里**不再出现** `src/manifest.json`、`src/popup/popup.html`、
  `src/options/options.html`、`src/options/options.css` 这四条的 ` M`（或改名会话已明确把这些改动
  提交掉）。T2 要改 `src/manifest.json` 与 `src/options/options.html`——**同一个文件两边各有一份
  未提交改动时，后提交的一方会把对方整段覆盖掉**。
- **T3 开工前**：`README.md` 不再是 ` M`（改名会话已经提交），否则 T3 的 README 改动会和它的
  改名改动混在同一个文件里；**混了就停手**，等它提交完或与用户确认。

---

## 文件结构

| 文件 | 责任 | 动作 |
| --- | --- | --- |
| `src/engines/google.ts` | 免费接口适配器 | **T1 整份删除** |
| `src/engines/registry.ts` | 适配器注册表 + `getEngine` | T1：单成员、`Translator \| null`、**无兜底**、删 `DEFAULT_ENGINE_ID` |
| `src/shared/settings.ts` | 设置 schema / 迁移 / `resolveEngine` / 两句 problem 常量 | T1：版本 5、默认 `''`、`firstUsableProfileId`、`NO_ENGINE_PROBLEM`、`ResolvedEngine.engine: Translator \| null`、`dropFreeEngineSelection` |
| `src/options/engine-health.ts` | 状态点记录的键空间 | T1：删 `ENGINE_HEALTH_PREFIX` / `FREE_ENGINE_HEALTH_KEY`，只留 `p:` 一个键空间 |
| `src/options/sections/engine.ts` | 设置页档案区（行 / 编辑器 / 测试连接 / 删除） | T1：删免费行与 `test-free`、`rowForKey` 只认档案键、删除档案按 `firstUsableProfileId` 回落、`renderEngineHint` 两态 |
| `src/popup/popup.ts` | 弹窗 | T1：下拉只列档案、0 个档案隐藏整行、`renderEngineHint` 的空态 |
| `src/background/service-worker.ts` | 消息路由 + 无引擎闸 | T1：`engine === null \|\| problem !== undefined` 一处收口 + 注释改写；T2：两行 `supportsGlossary` 上方的注释定性 |
| `src/background/scheduler.ts` | 批次调度与退避 | T2：3 处过时注释（不是规格说的 1 处） |
| `src/core/hash.ts` | 缓存 key | T2：1 处过时注释（规格 §2 的范围清单里没有它） |
| `src/content/index.ts` | 内容脚本：两条假话文案 | T2 |
| `src/manifest.json` | 权限与描述 | T2：`host_permissions: []`、`description` 改写 |
| `src/options/options.html` | 设置页静态结构 | T2：隐私区块那句「免费引擎不需要额外授权」 |
| `README.md` | 用户文档 | T3（含**真的补一节「快速开始」**） |
| `tests/engines/google.test.ts` | 免费引擎的行为断言 | **T1 整份删除**（162 行） |
| `tests/engines/registry.test.ts` | 注册表守卫 | T1：整份替换 |
| `tests/shared/settings.test.ts` | 设置 / 迁移 / `resolveEngine` | T1：7 处改写 + 5 条新增 |
| `tests/options/harness.ts` | 设置页夹具 | T1：新增 `seedWithProfile` |
| `tests/options/engine-health.test.ts` | 状态点 + 免费行的四条 | T1：删 3 条、改 1 条、重写 1 条、换一条承重读数、删 `freeDot()` 与两个 import |
| `tests/options/engine-expansion.test.ts` | 就地追加 | T1：删三处 `[data-engine-free]` 读数，改钉"草稿行在最后" |
| `tests/options/engine-models.test.ts` | 模型目录 | T1：2 处夹具（规格点名点错了用例，见 T1 S5） |
| `tests/options/options.test.ts` | 设置页行为（31 条） | T1：3 处夹具 + 删除当前档案那条整体改写 + 2 条新增 + 权限那条保留换夹具 |
| `tests/popup/popup.test.ts` | 弹窗行为 | T1：6 处逐类处置 + 初始化那条 + 空态新增 + 两条重写 |
| `tests/core/hash.test.ts` | 缓存 key 纯度 | T1：2 个字面值 |
| `tests/background/service-worker.test.ts` | 后台端到端 | T1：stub 改名改写 + 四条缓存用例显式播种 + 1 条新增零请求守卫 |
| `tests/manifest.test.ts` | manifest 守卫 | T2：接口 + 正向 + **反向**两条 |
| `tests/content/index.test.ts` | 内容脚本编排 | T2：那条必红用例 + 网络文案夹具 |
| 本文件 | 计划与落地读数 | T3：回填「落地读数表」 |

---

## Task T1：核心移除（引擎层 + 数据层 + 界面层 + 后台闸，**一个提交**）

**Files（穷举，共 17 个路径，只碰这些）:**
- Delete: `src/engines/google.ts`、`tests/engines/google.test.ts`
- Modify: `src/engines/registry.ts`、`src/shared/settings.ts`、`src/options/engine-health.ts`、
  `src/options/sections/engine.ts`、`src/popup/popup.ts`、`src/background/service-worker.ts`
- Modify: `tests/engines/registry.test.ts`、`tests/shared/settings.test.ts`、`tests/options/harness.ts`、
  `tests/options/engine-health.test.ts`、`tests/options/engine-expansion.test.ts`、
  `tests/options/engine-models.test.ts`、`tests/options/options.test.ts`、`tests/popup/popup.test.ts`、
  `tests/core/hash.test.ts`、`tests/background/service-worker.test.ts`

**为什么这一个 Task 结束时一定绿**（这是本 Task 存在的理由）：删掉的符号、改掉的类型、改掉的默认值
与"所有引用它们的地方"**在同一个提交里**落地。中间态（S9 S10 之间）**故意是红的**——那是 typecheck
给出的"旧引用点清单"（规格 §10 说它是免费清单，这一点它说对了；错的是"E1 做完就是绿的"）。
**Task 结束判据 = `npx vitest run` 全绿 + `npm run typecheck` exit 0 + `npm run build` exit 0。**

**先改测试、后改实现**：S1–S8 把测试改到新语义（此时跑起来是红的，红形态逐条记录），S9–S14 改实现
（逐步转绿），S15 起收口。

### Step 0：开工前检查

```powershell
git status --porcelain -uall
```
Expected: 与本文「开工前检查」表格逐行一致（14 个路径）。**出现表格之外的新改动 → 停下问用户**，
不要把它卷进本 Task。

### Step 1：先立两个新符号（纯新增，惰性；跑全量确认它不改变任何行为）

在 `src/shared/settings.ts` 里，把 `NO_MODEL_PROBLEM` 那块**之后**追加（锚点是 `NO_MODEL_PROBLEM` 的
完整定义，该文件里唯一）：

```ts
export const NO_MODEL_PROBLEM = '这个档案还没有模型，点「添加模型」或「拉取可用模型」';

/**
 * 「没有可用引擎」那句话的**唯一来源**（与 {@link NO_MODEL_PROBLEM} 同级）。
 *
 * 弹窗、设置页、后台各写一份必然漂移（先例见 `isAllowedBaseUrl`）。首装时两处的措辞差异是
 * **刻意的**：设置页那句就是"去做这件事"，弹窗那句多一个"去哪做"（弹窗里没有「新增档案」
 * 按钮，只有右上角的齿轮）。**两处的核心句逐字相同**——都由本常量拼出来，不各写一份字面量。
 */
export const NO_ENGINE_PROBLEM = '还没有可用的翻译引擎，去设置页添加一个服务商档案';

/**
 * 第一个「有当前模型」的档案的 id；一个都没有时返回 `''`（= 没有可用引擎）。
 *
 * **两个调用方共用这一份判据**：v4 → v5 迁移（`dropFreeEngineSelection`）与设置页删除当前档案时
 * 的回落。两处各写一份必然漂移，先例就是 `resolveEngine` 里那条专门解释为什么用 `trim()` 的注释。
 *
 * 参数类型是 `Pick<EngineProfile, 'id' | 'activeModel'>` 而不是整个 `EngineProfile`：迁移那一侧
 * 拿到的是**存储里的生数据**（`mergeSettings` 还没跑，`profiles` 是 `unknown`），它只需要先证明
 * "`id` 是字符串、`activeModel` 是字符串"就能问这条判据——**判据本身仍然只有这一份**。
 *
 * `trim()` 口径与 {@link resolveEngine} 完全一致：只填了空格的 `activeModel` 算"没有当前模型"。
 * 顺序 = 数组顺序（`pickProfiles` 保证它是存储顺序），也就是用户在设置页看到的第一行。
 */
export function firstUsableProfileId(
  profiles: readonly Pick<EngineProfile, 'id' | 'activeModel'>[],
): string {
  return profiles.find((profile) => profile.activeModel.trim().length > 0)?.id ?? '';
}
```

Run: `npx vitest run`
Expected: `Test Files 55 passed (55)` / `Tests 1061 passed (1061)`——**与 Step 0 的基线逐字相同**。
新增两个导出没有任何消费者，这一步是"证明新符号是惰性的"，不是"新功能已生效"。
若这一步就红了：说明锚点插错了位置（比如插进了另一个对象字面量里），**停下核对**。

### Step 2：`tests/engines/registry.test.ts` 整份替换

把整个文件替换为：

```ts
import { describe, expect, it } from 'vitest';
import { ENGINES, getEngine } from '../../src/engines/registry';

describe('getEngine', () => {
  it('按 id 取到引擎', () => {
    expect(getEngine('openai-compat')?.id).toBe('openai-compat');
  });

  /**
   * 这条钉的是本单元**推翻的那个设计判断**：旧实现「未知 id 一律回退到默认引擎」让设置里存了
   * 废弃 id 时插件**照样能翻**（安静地用免费接口）。新语义是「没有可用引擎」：交回 `null`，
   * 由 `resolveEngine` 翻成一句可行动的话 + 零请求。
   *
   * **牙在哪**：把 `getEngine` 改回任何形式的兜底（`?? openAiCompatEngine` / `ENGINES[0]`），
   * 这条当场红。而"能不能翻"是看不出来的——兜底恰恰让它"还能翻"。
   */
  it('未知 id 返回 null：不再回落到任何引擎', () => {
    expect(getEngine('不存在的引擎')).toBeNull();
    // 残留的免费引擎 id 也只是"一个不存在的 id"，没有任何特例（不写 `if (id === 'google')` 的补丁）。
    expect(getEngine('google')).toBeNull();
  });

  /**
   * 这条钉的是「引擎列表被删到一个」**这件事本身**：有人把 `google.ts` 加回来、或把 `ENGINES`
   * 写成多成员，它当场红。比旧用例的「恰好这两个」更硬——现在是「恰好唯一的那一个」。
   */
  it('注册表恰好只剩唯一一个适配器', () => {
    expect(ENGINES.map((e) => e.id)).toEqual(['openai-compat']);
  });

  it('唯一适配器需要 Key', () => {
    expect(getEngine('openai-compat')?.needsKey).toBe(true);
  });
});
```

### Step 3：`tests/shared/settings.test.ts`（7 处改写 + 5 条新增）

**3a. import 加两个新符号**（锚点是 import 块里的 `NO_MODEL_PROBLEM,`，该文件唯一）：

```ts
  NO_ENGINE_PROBLEM,
  NO_MODEL_PROBLEM,
```

**3b. 默认值断言**（锚点 `expect(DEFAULT_SETTINGS.engineId).toBe('google');` 唯一）：

```ts
    expect(DEFAULT_SETTINGS.engineId).toBe('');
    expect(DEFAULT_SETTINGS.profiles).toEqual([]);
```

**3c. 在「空对象得到完整默认值」那条用例里，紧接 3b 的两行之后续上一句常量字面钉**
（3b 改完那段就是它的锚点，直接接在 `expect(DEFAULT_SETTINGS.profiles).toEqual([]);` 之后）：

```ts
    // `CURRENT_VERSION` 是**字面**钉住的：迁移的版本闸门、`saveSettings` 的防降级、README 的
    // 升级说明都靠这个数字，改它必须是有意识的动作（不是"跟着某个常量一起漂"）。
    expect(CURRENT_VERSION).toBe(5);
```

**3d. 删掉「engineId 是 google → 免费引擎 + 空配置」整条**（锚点是这条 `it` 的完整文本，
`describe('档案解析：resolveEngine 是唯一一处…')` 内，该文件唯一）：

```ts
  it('engineId 是 google → 免费引擎 + 空配置，档案完全不参与', () => {
    const { engine, config } = resolveEngine({ engineId: 'google', profiles: [profile()] });
    expect(engine.id).toBe('google');
    expect(config).toEqual({});
  });
```
→ **整条删除，替换成**：

```ts
  /**
   * 「没有可用引擎」的**四种形状走同一条路**（这是本单元最核心的一条语义变更）：
   * `''`（首装）、残留的 `'google'`、`'openai-compat'` 这类**裸引擎 id**、被别处删掉的档案 id。
   * 一个特例都不许有——写「若 engineId === 'google' 则…」的补丁就是第二个解析点。
   */
  it('engineId 不指向任何现存档案 → 没有可用引擎 + 那句可行动的话，不抛错', () => {
    for (const engineId of ['', 'google', 'openai-compat', '已删掉的']) {
      const resolved = resolveEngine({ engineId, profiles: [profile()] });
      expect(resolved.engine).toBeNull();
      expect(resolved.config).toEqual({});
      expect(resolved.problem).toBe(NO_ENGINE_PROBLEM);
    }
  });

  /**
   * 上面那条断言的是"等于常量"，这条断言的是**常量自己的字面**。
   *
   * 为什么两条都要：所有界面断言都走常量（规格 §7.3 第 18 条的唯一来源纪律），那条纪律的另一面
   * 就是"常量被改坏了没人管"——把 `NO_ENGINE_PROBLEM` 改一个字符，界面那几条一起绿（两边同源）。
   * 这条是那个缺口的唯一守卫，同时也是验收 §8.13（"必须同时含「没有可用引擎」与「设置页」"）。
   */
  it('那句话本身：说清是什么事、说清去哪儿（改一个字就红）', () => {
    expect(NO_ENGINE_PROBLEM).toContain('没有可用引擎');
    expect(NO_ENGINE_PROBLEM).toContain('设置页');
    expect(NO_ENGINE_PROBLEM).toContain('服务商档案');
  });
```

**3e. 删掉「engineId 指向不存在的档案（并发删除留下的残值）」整条**（锚点唯一）：

```ts
  it('engineId 指向不存在的档案（并发删除留下的残值）→ 回落免费引擎，不抛错', () => {
    const { engine, config } = resolveEngine({ engineId: '已删掉的', profiles: [profile()] });
    expect(engine.id).toBe('google');
    expect(config).toEqual({});
  });
```
→ **整条删除**（它的语义已被 3d 的循环覆盖，且断言方向相反）。

**3f. 删掉「裸 openai-compat（没配任何档案）」整条**（锚点唯一）：

```ts
  it('裸 openai-compat（没配任何档案）→ 引擎自己给出可行动的 AUTH 提示，不是网络错误', async () => {
    const { engine, config } = resolveEngine({ engineId: 'openai-compat', profiles: [] });
    expect(engine.id).toBe('openai-compat');
    await expect(
      engine.translate({ texts: ['Hello'], from: 'auto', to: 'zh-Hans', signal: new AbortController().signal }, config),
    ).rejects.toThrow(/API Key/);
  });
```
→ **换成成对的零请求用例**（放在下面 `describe('零请求的构造性保证…')` 里，因为它需要那个
`afterEach(vi.unstubAllGlobals)`；**这里只删、不插**）：

然后在 `describe('零请求的构造性保证：空 model 的配置连一次 fetch 都到不了'` 的收尾 `});` **之前**
插入：

```ts
  /**
   * 「没有可用引擎 ⇒ 零请求」的**单元层**成对用例。
   *
   * 反面：`engineId: 'openai-compat'`（一个**裸引擎 id**，不是任何档案的 id）今天能命中
   * `getEngine` 并返回那个引擎——本单元之后它和 `''`、`'google'`、失效档案 id 走同一条路。
   * 正面：同一个 `resolveEngine`，`engineId` 换成有 `activeModel` 的档案 id，请求能真的发出去
   * （否则"整条链路根本不发请求"的实现也能让反面通过）。
   */
  it('没有可用引擎时不构造任何引擎、零请求（成对：换成真档案就恰好发一次）', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '<<<1>>> 你好' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const signal = new AbortController().signal;

    const none = resolveEngine({ engineId: 'openai-compat', profiles: [] });
    expect(none.engine).toBeNull();
    expect(none.problem).toBe(NO_ENGINE_PROBLEM);

    const usable = resolveEngine({ engineId: 'p1', profiles: [profile()] });
    expect(usable.engine).not.toBeNull();
    await usable.engine?.translate({ texts: ['Hello'], from: 'auto', to: 'zh-Hans', signal }, usable.config);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
```

**3g. 「能用的配置不背那句"还没有模型"」**：锚点唯一（`describe('档案解析…')` 内）：

```ts
  it('能用的配置不背那句"还没有模型"：有当前模型、免费引擎都不给 problem', () => {
    expect(resolveEngine({ engineId: 'p1', profiles: [profile()] }).problem).toBeUndefined();
    // 免费引擎没有"模型清单"这个概念，档案里的空 activeModel 与它无关（engineId 不指向任何档案）。
    expect(
      resolveEngine({ engineId: 'google', profiles: [profile({ models: [], activeModel: '' })] }).problem,
    ).toBeUndefined();
    expect(resolveEngine({ engineId: 'google', profiles: [] }).problem).toBeUndefined();
    // `openai-compat` **不是**档案 id：它照样走"没命中档案"那一支（引擎可由 `getEngine` 归一，
    // 与引擎有关的那条既有用例在下面「裸 openai-compat…」里守着）。
    expect(resolveEngine({ engineId: 'openai-compat', profiles: [] }).problem).toBeUndefined();
  });
```
→ **整条替换为**：

```ts
  it('能用的配置不背那句"没有可用引擎"：命中档案且模型齐全时一个 problem 都没有', () => {
    expect(resolveEngine({ engineId: 'p1', profiles: [profile()] }).problem).toBeUndefined();
    // 反例半边：同一个档案、只是没有当前模型——给的是**另一句**（NO_MODEL_PROBLEM），
    // 不是"没有可用引擎"（两句话的处置完全不同：一个去加模型，一个去加档案）。
    const noModel = resolveEngine({ engineId: 'p1', profiles: [profile({ models: [], activeModel: '' })] });
    expect(noModel.engine).not.toBeNull();
    expect(noModel.problem).toBe(NO_MODEL_PROBLEM);
    expect(noModel.problem).not.toBe(NO_ENGINE_PROBLEM);
  });
```

**3h. v2 数据那条**（锚点唯一，`describe('迁移 v2 → v3…')` 内）：

```ts
  it('engineId 是 google 时不产生档案，也不改 engineId（那份 engineConfig 多半是没选过的残留）', async () => {
```
→ 标题与断言改成：

```ts
  it('engineId 是 google 时不产生档案；v5 那一步再把它抹成空串（那份 engineConfig 多半是没选过的残留）', async () => {
```
并把这**条用例内部**的

```ts
    expect(settings.profiles).toEqual([]);
    expect(settings.engineId).toBe('google');
```
→
```ts
    expect(settings.profiles).toEqual([]);
    // v5 迁移把 `'google'` 抹掉了：没有档案可挑，于是落到 `''`（= 没有可用引擎）。
    expect(settings.engineId).toBe('');
```

**3i. 新增 v4 → v5 迁移的三条用例**：插在 `describe('迁移 v3 → v4：单 model 抬起成 models + activeModel'`
整个 describe 的收尾 `});` **之后**（锚点用下面给出的 `describe('models / activeModel 的反序列化边界'`
那行的上一行——即 v3→v4 describe 的收尾），插入：

```ts
/**
 * v4 → v5：删掉免费接口之后，存储里 `engineId: 'google'` 的老数据必须改指向一个真的存在的东西。
 *
 * 三条口径（与 `dropFreeEngineSelection` 的注释逐条对应）：
 * 1. **只认 `'google'` 这个字面值**，其余脏值不替用户猜（它们走"没有可用引擎"）；
 * 2. 挑的是**第一个有 `activeModel`** 的档案——夹具里**故意让第一个档案没有当前模型**，
 *    否则"取第一个"与"取第一个可用的"分不开（这是那个判据唯一的杀手）；
 * 3. 迁移**只在读的时候**发生，存储里那份原文一个字节都不动。
 */
describe('迁移 v4 → v5：免费引擎的选择要迁到第一个有当前模型的档案', () => {
  const usable = { id: 'p-usable', label: '配好的', baseUrl: 'https://b.example/v1', models: ['m'], activeModel: 'm', apiKey: 'sk-b' };
  const empty = { id: 'p-empty', label: '没选模型的', baseUrl: 'https://a.example/v1', models: [], activeModel: '', apiKey: 'sk-a' };

  it('engineId 是 google → 数组里第一个 activeModel 非空的档案（不是"第一个档案"）', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 4, engineId: 'google', profiles: [empty, usable] } });

    const settings = await loadSettings(area);
    // 牙：判据退化成"取第一个档案"（`profiles[0].id`）时，这里读到的是 `p-empty` → 红。
    expect(settings.engineId).toBe('p-usable');
    expect(settings.version).toBe(CURRENT_VERSION);
  });

  it('engineId 是 google 但一个能用的档案都没有 → 空串（三种形状都走这条路）', async () => {
    const cases: Array<Record<string, unknown>> = [
      // ① 有档案，但全都没有当前模型。
      { version: 4, engineId: 'google', profiles: [empty] },
      // ② 没有任何档案。
      { version: 4, engineId: 'google', profiles: [] },
      // ③ **连 `profiles` 键都没有**（v1/v2 里 `engineId: 'google'` 的老数据就长这样）。
      //    迁移层拿到的是**生数据**：把它直接交给 `firstUsableProfileId` 会在 `.find` 上抛 TypeError，
      //    整个 `loadSettings` 跟着挂——`dropFreeEngineSelection` 里的形状投影就是为这一格存在的。
      { version: 4, engineId: 'google' },
    ];

    for (const record of cases) {
      const area = new MemoryStorage();
      await area.set({ [SETTINGS_KEY]: record });
      expect((await loadSettings(area)).engineId).toBe('');
    }
  });

  it('幂等：连读两次结果相同，且存储里那份原文没被改写（迁移发生在读的那一刻）', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 4, engineId: 'google', profiles: [usable] } });

    const first = await loadSettings(area);
    const second = await loadSettings(area);
    expect(first.engineId).toBe('p-usable');
    expect(second.engineId).toBe(first.engineId);
    // 落盘要等用户下一次改动触发 `saveSettings` 的整份覆盖写；读不写存储
    // （与既有的「打开页面不写存储：迁移发生在读的那一刻」同一条口径）。
    const stored = (await area.get([SETTINGS_KEY]))[SETTINGS_KEY] as Record<string, unknown>;
    expect(stored.version).toBe(4);
    expect(stored.engineId).toBe('google');
  });

  it('只有 v4 那一次会挑：迁移产物再读一次不会被改回去（版本号已是 5）', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 4, engineId: 'google', profiles: [empty, usable] } });
    const migrated = await loadSettings(area);
    // 用户接着把那个档案的当前模型清空（合法操作：删掉最后一个模型会置空）。
    const cleared = {
      ...migrated,
      profiles: migrated.profiles.map((item) => ({ ...item, models: [], activeModel: '' })),
    };
    await saveSettings(cleared, area);

    // 再读：engineId 仍是迁移当时挑的那个（**没有**因为"它现在没有模型了"被重挑或置空）。
    expect((await loadSettings(area)).engineId).toBe('p-usable');
  });
});
```

### Step 4：`tests/options/engine-health.test.ts`

**4a. import 改两处**（该文件唯一）：

```ts
import { DEFAULT_ENGINE_ID, getEngine } from '../../src/engines/registry';
import {
  ENGINE_HEALTH_KEY,
  FREE_ENGINE_HEALTH_KEY,
  loadEngineHealth,
  profileHealthKey,
  saveEngineHealth,
} from '../../src/options/engine-health';
```
→
```ts
import {
  ENGINE_HEALTH_KEY,
  loadEngineHealth,
  profileHealthKey,
  saveEngineHealth,
} from '../../src/options/engine-health';
```
并在 `from './harness'` 那块 import 之后新增一行（`NO_ENGINE_PROBLEM` 从 settings 拿）：

```ts
import { NO_ENGINE_PROBLEM } from '../../src/shared/settings';
```

**4b. 删掉 `freeDot()` 辅助函数整块**（含它上方那行注释，锚点唯一）：

```ts
/** 内置免费引擎那一行的状态点。它没有 `data-profile-id`，只能按自己的标记找。 */
function freeDot(): HTMLElement {
  const dot = pick<HTMLElement>('profiles').querySelector<HTMLElement>('[data-engine-free] .dot');
  if (dot === null) throw new Error('内置免费引擎那一行没有状态点');
  return dot;
}
```
（不删就会被 `noUnusedLocals` 判红——`npm run typecheck` 会点出来。）

**4c. 「存储里是垃圾也不崩」的末尾三条断言换承重读数**（锚点唯一）：

```ts
    // 页面照常渲染，不因为一条脏记录整页白。
    //
    // 这一条**不能只断言"零个档案行"**：本用例一个档案都没 seed，`profileRows()` 恒为 0，
    // 于是它在"`mount` 里根本不渲染列表"的变异下照样是绿的（加这条断言之前实测：那个变异
    // 只红 6 条，绿的正是本条与上面那条纯存储的）。下面钉住内置免费引擎那一行——它是
    // **每次重绘都会画出来**的那一行，有它在，"页面照常渲染"才是真的在断言渲染。
    expect(profileRows()).toHaveLength(0);
    expect(pick('profiles').querySelector('[data-engine-free]')).not.toBeNull();
```
→
```ts
    // 页面照常渲染，不因为一条脏记录整页白。
    //
    // 这一条**不能只断言"零个档案行"**：本用例一个档案都没 seed，`profileRows()` 恒为 0，
    // 于是它在"`mount` 里根本不渲染列表"的变异下照样是绿的（加这条断言之前实测：那个变异
    // 只红 6 条，绿的正是本条与上面那条纯存储的）。原来这里钉的是"内置免费引擎那一行**每次重绘
    // 都会画出来**"——那一行随单元 E 删掉了，**承重的读数必须换一个，不许直接删**：
    // 本用例没 seed 任何设置，`engineId` 是默认的 `''`，于是 `mount` 一定会把
    // `#engine-hint` 写成那句"没有可用引擎"。它同样是"渲染真的发生了"的证据
    // （`mount` 里不调用 `renderEngineHint` → 这个节点还是 HTML 里的空串 → 红）。
    expect(profileRows()).toHaveLength(0);
    expect(pick<HTMLElement>('engine-hint').textContent).toBe(NO_ENGINE_PROBLEM);
```

**4d. 删掉 `describe('内置免费引擎那一行')` 的前三条用例**（锚点逐个唯一）：
① 「在列表最后，带「内置」，没有删除也没有编辑（不可删）」
② 「点它的「测试连接」真的发一次请求，成功之后点变绿」
③ 「档案 id 撞上 `google` 也不串台：免费行的记录落在引擎键上，档案行仍是从没测过」

**②的删除是有前提的，起草时已核实**：它顺带守的那半条（"空 Key 落在脱敏门槛之外"）由同文件
「短 Key（<8 字符）不做脱敏：正常译文与被回显的失败文案都必须原样」覆盖（那条用
`apiKey: shortKey`，不依赖免费引擎，断言 `not.toContain('***')`）——所以**不需要**把那半条搬过去。

**4e. 把④「档案 id 直接取成引擎键本身（`e:free`）也不串台」整条替换**为下面这条
（锚点是整条 `it(...)`，从 `  it('档案 id 直接取成引擎键本身（\`e:free\`）也不串台` 到该 describe 的收尾 `});`
之前的那一个 `  });`）：

```ts
  /**
   * **键空间的唯一一条守卫**（`e:` 键空间随免费引擎一起消亡之后，这条用例守的东西换了）。
   *
   * 标题：档案 id 可以长得像任何东西（含 `p:` 前缀本身）：记录键由前缀**加**出来，
   * 点从记录键**解**回来，账不串。
   *
   * 夹具取 `'p:dup'`：它**今天已经没有特殊含义、但长得最像键**（`p:` + `dup` 恰好是另一个
   * 档案的记录键形状）。这条同时覆盖了"永远不要从存储里的老 `p:` 键认领记录"那半条说明——
   * 因为档案 id 恰好等于"另一个档案的键"。
   *
   * 三条行为层的牙（逐条写在这里，别只看"这条用例红了"）：
   * - **牙①（写侧）**：`handleTestProfile` 若不把 `profileHealthKey(id)` 交出去、而是交**裸 id**，
   *   存储里落的键是 `'p:dup'`，而下面按 `profileHealthKey('p:dup')` = `'p:p:dup'` 取值 → 红。
   * - **牙②（就地更新）**：`rowForKey` 若不再从记录键**解**出 id（拿键当 id 用），
   *   键 `'p:p:dup'` 找不到任何行，点停在 `idle` → 红。
   * - **牙③（整表重绘）**：`buildProfileRow` 若按**裸 id** 读 `health[id]`，就地更新那一次仍然绿
   *   （`recordHealth` 自己会更新点），只有走一次**真的重绘**才露馅——所以这里点一次「保存」
   *   触发 `renderProfiles`，再读点。
   *
   * **如实记账**：`PROFILE_HEALTH_PREFIX` 从 `'p:'` 改成 `''`（或别的）在**行为上不可观察**
   * （读写两侧共用同一个函数，键只是换了个形状），所以它**不是上面三条牙的杀手**——那正是
   * `engine-health.ts` 里说"退回裸 id 是一次没有收益的改动"的意思。它由下面第四条断言钉住。
   */
  it('档案 id 可以长得像任何东西（含 `p:` 前缀本身）：记录键由前缀加出来，点从记录键解回来，账不串', async () => {
    const dirtyId = 'p:dup';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好')));
    chromeStub.permissions.grantedOrigins.add(CUSTOM_ORIGIN_PATTERN);
    await seedSettings({
      engineId: dirtyId,
      targetLang: 'zh-Hans',
      profiles: [profileSeed({ id: dirtyId, label: '长得像记录键的档案' })],
    });
    await loadOptions();

    rowOf(dirtyId).querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    actionButton(editorOf(dirtyId), 'test-profile').click();
    await waitFor(() => status().dataset.kind === 'ok');
    await waitFor(async () => (await storedHealth())[profileHealthKey(dirtyId)] !== undefined);

    // 牙①：写侧用的必须是 `profileHealthKey(id)`（= `p:p:dup`），不是裸 id。
    expect((await storedHealth())[profileHealthKey(dirtyId)]).toEqual({ state: 'ok', detail: '' });
    // 牙②：`rowForKey` 必须从记录键解回 id 才能找到这一行的点。
    expect(dotOf(dirtyId).dataset.state).toBe('ok');

    // 牙③：整表重绘（点一次「保存」→ `renderProfiles` → 重新 `applyDot`）之后仍然各念各的那一格。
    actionButton(editorOf(dirtyId), 'save-profile').click();
    await waitFor(() => (status().textContent ?? '').includes('已保存档案'));
    expect(dotOf(dirtyId).dataset.state).toBe('ok');
    expect((await storedHealth())[profileHealthKey(dirtyId)]).toEqual({ state: 'ok', detail: '' });

    // 牙④（**形状守卫，不是行为守卫**）：键的形状本身是刻意的选择——`p:` 前缀就是
    // "记录键"与"档案 id"两个概念的分界（见 `engine-health.ts` 顶部）。行为上删掉它不可观察，
    // 所以只有这一条会在"有人把前缀删了"时响。别把它读成"串台又回来了"。
    expect(profileHealthKey('dup')).toBe('p:dup');
    expect(profileIdFromHealthKey('p:dup')).toBe('dup');
  });
```
（这也要求 import 里保留 `profileIdFromHealthKey`——它已在该文件的 import 块里。）

### Step 5：`tests/options/engine-expansion.test.ts`、`engine-models.test.ts`、`options.test.ts`、`tests/core/hash.test.ts`、`harness.ts`

**5a. `tests/options/engine-expansion.test.ts`**：锚点是「新增档案那一行也是就地追加」整条 `it`，
替换为：

```ts
  it('新增档案那一行也是就地追加：不动已有的行', async () => {
    // 草稿行的插入走 `insertDraftRow`（只 append 一行），不是 `renderProfiles`。
    // 断言的读数是"已有行的 DOM 节点身份没变"——整表重建时这些引用会全部失效。
    await seedSettings({ engineId: 'p-0', profiles: seeds(3) });
    await loadOptions();
    const before = profileRows();

    pick<HTMLButtonElement>('add-profile').click();
    await settle();

    const after = profileRows();
    expect(after).toHaveLength(4);
    expect(after[3].dataset.profileId).toBe('__new__');
    // 前三行还是原来那三个节点（同一个对象）。
    expect(after.slice(0, 3)).toEqual(before);
    // 上面那句 `toEqual` **证明不了"同一个对象"**：vitest 对 DOM 元素做的是**结构**比较。
    // 实测（jsdom 元素探针）：两个 class/文本都不同的 div → NOT-EQUAL；两个 class/文本相同的
    // **不同对象** → EQUAL；游离的旧节点 vs 已挂上的新节点（结构相同）→ EQUAL。
    // 于是"只追加、不动已有的行"这个读数必须逐行钉**身份**——`insertDraftRow` 哪天换回
    // `renderProfiles`（整表重建），节点身份全变，这一行当场红（读数是 `[false, false, false]`）。
    expect(after.slice(0, 3).map((row, index) => row === before[index])).toEqual([true, true, true]);
    // 草稿行**就地追加在最后**：它后面没有任何行了（内置免费引擎那一行随单元 E 删掉）。
    // ⚠ 这两条断言是**替换**掉原来的 `[data-engine-free]` 三处读数的：那三处在删行之后会变成
    // `null === null` 的恒真式（静默通过），而"草稿行排在最后"仍然是承重的——
    // 插入位置改成 `prepend` / 插到中间，这两条当场红。
    expect(after[3].nextElementSibling).toBeNull();
    expect(pick<HTMLElement>('profiles').lastElementChild).toBe(after[3]);
    // 草稿行展开着（新增档案的语义就是"当场开始填"）。
    expect(after[3].querySelector('.profile-editor')).not.toBeNull();
  });
```

**5b. `tests/options/engine-models.test.ts` 两处夹具**（⚠ **规格 §7.2 的 ④ 类把这条点错了用例**：
它点的是「打开设置页 / 展开档案 / 聚焦输入框都不发请求」，而那条**已经是** `engineId: 'p-a'` +
档案；真正的两处是下面这两条，都没有档案，所以**直接删掉 `engineId` 字段**让它走默认 `''`）：

1. 「取消草稿行：整行移除」里的 `await seedSettings({ engineId: 'google' });` → `await seedSettings();`
2. 「草稿保存成功后清掉草稿暂存…」里的同一行 → `await seedSettings();`

**5c. `tests/core/hash.test.ts`**：
- `base` 夹具里的 `engineId: 'google',` → `engineId: 'p-a',`
- 「任一字段变化都会改变 key」里的 `engineId: 'openai-compat'` → `engineId: 'p-b'`

（`buildCacheKey` 的 `engineId` 是**缓存 key 的字段**：`scheduler.ts` 传的是 `deps.engine.id`，
而引擎删到一个之后它恒为 `'openai-compat'`——档案之间的区分靠 `configHash`（`baseUrl + model`）。
这两个字面值只是"让 key 变一下"，语义上现在只可能是档案 id，所以换档案 id 是最自解释的值。
**两处都要改**：只改 `base` 不改 `'openai-compat'` 的话，`{ ...base, engineId: 'openai-compat' }`
会与 `base` 的 `'p-a'` 不同 → 那条断言依然绿，但它守的"任一字段变化"里少了一个真实取值。）

**5d. `tests/options/harness.ts`**：在 `seedSettings` 之后追加：

```ts
/**
 * 「这条用例需要一个**能用的**引擎」的显式夹具入口。
 *
 * 默认设置是 `engineId: ''` + `profiles: []` = **没有可用引擎**（v5 起 `''` 就是这个意思）。
 * 凡是没有显式声明引擎的用例都会落到那个状态——这不是回归，而是把一条一直存在的隐性前提
 * **显式化**：需要引擎的用例从此在夹具名上就看得出来。**不许**靠"把默认值改回某个 id"
 * 让它们继续绿。
 */
export async function seedWithProfile(patch: Record<string, unknown> = {}): Promise<void> {
  await seedSettings({ engineId: 'p-a', profiles: [profileSeed()], ...patch });
}
```

**5e. `tests/options/options.test.ts`**：

1. **import 行** `import { DEFAULT_ENGINE_ID, getEngine } from '../../src/engines/registry';`
   → **整行删除**（改完下面两处后它没有消费者，`noUnusedLocals` 会红）。
2. **「新增档案…不偷改 engineId」**（锚点是 `it('新增档案：落盘的字段一字不差，id 稳定且不拿 label 当 id；不偷改 engineId', …)`
   整条）。⚠ 规格只说"改成先 `seedSettings({ engineId: 'p-a', profiles: [profileSeed()] })`"，
   **漏了这条用例里的 `length === 1`**——播种一个档案之后新档案是第 2 个。完整替换：

```ts
  it('新增档案：落盘的字段一字不差，id 稳定且不拿 label 当 id；不偷改 engineId', async () => {
    // 夹具里**真有一个档案**，`engineId` 指向它：这样"保存档案不碰选择"这句才有判别力
    // ——播种 `''` 再断言 `''`，一个"把 engineId 重置成空"的 bug 照样能过。
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed()] });
    await loadOptions();

    pick<HTMLButtonElement>('add-profile').click();
    const editor = editorOf('__new__');
    expect(rowOf('__new__').textContent).toContain('新档案（未保存）');
    fieldOf(editor, '.profile-label').value = '我的接口';
    fieldOf(editor, '.profile-base-url').value = CUSTOM_BASE_URL;
    setModel(editor, 'gpt-4o');
    fieldOf(editor, '.profile-api-key').value = 'sk-typed';
    actionButton(editor, 'save-profile').click();

    await waitFor(async () => (await storedProfiles()).length === 2);
    const [seeded, saved] = await storedProfiles();
    expect(seeded.id).toBe('p-a');
    expect(saved).toEqual({
      id: expect.any(String),
      label: '我的接口',
      baseUrl: CUSTOM_BASE_URL,
      models: ['gpt-4o'],
      activeModel: 'gpt-4o',
      apiKey: 'sk-typed',
    });
    expect(typeof saved.id).toBe('string');
    expect((saved.id as string).trim().length).toBeGreaterThan(0);
    // id 不是 label（label 随便改，引用不能跟着漂）。
    expect(saved.id).not.toBe('我的接口');
    // 保存档案不碰选择：engineId 仍是 `p-a`（选择档案是弹窗的职责），提示区如实指路弹窗。
    expect((await storedSettings()).engineId).toBe('p-a');
    expect(engineStatus().dataset.kind).toBe('ok');
    expect(engineStatus().textContent).toContain('弹窗');
  });
```
3. **「本机回环 http…」** 的 `await seedSettings({ engineId: 'google' });` → `await seedSettings({ engineId: 'p-a' });`
   （这条需要一个"能用的引擎"但不需要档案：`allowedOrigins` 之类的断言与它无关，见 §7.2 ② 类。
   断言 `expect(await storedProfiles()).toEqual([])` 与 `chromeStub.permissions.requests` 都不受影响。）
4. **「删除当前在用的档案…」整条替换**（锚点唯一）：

```ts
  it('删除当前在用的档案：engineId 切到剩下的第一个有当前模型的档案，并给出提示', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed(), profileSeed({ id: 'p-b', label: '另一家', baseUrl: 'https://b.example/v1' })],
    });
    await loadOptions();

    expand('p-a'); // 删除前的展开状态是用户真实路径（保留）
    rowButton('p-a', 'delete-profile').click();

    await waitFor(async () => (await storedProfiles()).length === 1);
    const stored = await storedSettings();
    expect((stored.profiles as Array<Record<string, unknown>>).map((profile) => profile.id)).toEqual(['p-b']);
    // 回落到剩下的档案里**第一个有当前模型的**：与 v5 迁移同一个函数、同一份判据。
    // （旧实现回落到免费接口，理由"下一个档案可能没填 Key / 没授权"随免费引擎一起作废：
    //  v4 起每个档案都有 activeModel 这个明确信号，挑的就是用户真的配好过的那一个。）
    expect(stored.engineId).toBe('p-b');
    expect(engineStatus().dataset.kind).toBe('ok');
    expect(engineStatus().textContent).toContain('已删除当前在用的档案「我的 DeepSeek」');
    expect(engineStatus().textContent).toContain('引擎已切换到「另一家」');
    expect(engineStatus().textContent).toContain('弹窗');
    // 界面上那行也跟着消失了，**「使用中」搬到了新的当前档案上**（旧断言是"不含使用中"，
    // 那是因为旧实现回落到免费接口、没有任何档案是当前——语义变了，读数必须跟着变）。
    expect(profileRows().map((row) => row.dataset.profileId)).toEqual(['p-b']);
    expect(rowOf('p-b').textContent).toContain('使用中');
  });
```
5. **新增两条**（插在 4 之后）：

```ts
  it('删除当前在用的档案且已无可用引擎：engineId 置空，并说出那句可行动的话', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed()] });
    await loadOptions();

    rowButton('p-a', 'delete-profile').click();

    await waitFor(async () => (await storedProfiles()).length === 0);
    expect((await storedSettings()).engineId).toBe('');
    expect(engineStatus().dataset.kind).toBe('ok');
    expect(engineStatus().textContent).toContain('已删除当前在用的档案「我的 DeepSeek」');
    // 那句话以常量为核（唯一来源）——**断言常量**，不把整句抄进测试。
    expect(engineStatus().textContent).toContain(NO_ENGINE_PROBLEM);
    expect(profileRows()).toEqual([]);
    // 顶部说明也跟着走了（`renderEngineHint` 的 `engine === null` 那一支）。
    expect(pick<HTMLElement>('engine-hint').textContent).toBe(NO_ENGINE_PROBLEM);
  });

  it('删除当前档案时跳过没有当前模型的档案：回落到剩下的第一个**可用**档案', async () => {
    // 牙：回落判据退化成"取剩下的第一个"（不看 `activeModel`）时，这里读到的是 `p-empty` → 红。
    await seedSettings({
      engineId: 'p-a',
      profiles: [
        profileSeed(),
        profileSeed({ id: 'p-empty', label: '没配模型的', models: [], activeModel: '' }),
        profileSeed({ id: 'p-b', label: '配好的', baseUrl: 'https://b.example/v1' }),
      ],
    });
    await loadOptions();

    rowButton('p-a', 'delete-profile').click();

    await waitFor(async () => (await storedProfiles()).length === 2);
    expect((await storedSettings()).engineId).toBe('p-b');
    expect(engineStatus().textContent).toContain('引擎已切换到「配好的」');
  });
```
6. **新增设置页空态一条**（规格 §7.3 第 17 条前半）：

```ts
  it('没有可用引擎时的设置页空态：顶部说出那句话、一行档案都没有、也不再有任何内置项', async () => {
    await seedSettings({ engineId: '', profiles: [] });
    await loadOptions();

    expect(pick<HTMLElement>('engine-hint').textContent).toBe(NO_ENGINE_PROBLEM);
    expect(profileRows()).toHaveLength(0);
    // "整行消失"必须有**显式**守卫：不写这一条，谁把 `buildFreeEngineRow` 加回来都不会红。
    expect(pick<HTMLElement>('profiles').querySelector('[data-engine-free]')).toBeNull();
    expect(pick<HTMLElement>('profiles').querySelector('[data-action="test-free"]')).toBeNull();
  });
```
7. **`import { NO_ENGINE_PROBLEM }`**：在 `from '../../src/shared/settings'` 那块 import 里加进去
   （该文件已有 `CURRENT_VERSION, SETTINGS_KEY` 等从那来的 import）。
8. **「免费引擎下改设置：一个宿主权限申请都不发」——保留、换夹具、改标题与注释**（锚点唯一）。
   ⚠ **这里本计划与规格 §7.3 第 5 条的口径不同，理由写在下一条注释里**：

```ts
  it('改一个与权限无关的设置（目标语言）：一次宿主权限申请都不发', async () => {
    // 这条口径的来历：档案化之后"不申请权限"这条断言从保存路径上消失了。旧版用
    // `engineId: 'google'`（免费引擎没有 origin 可申请）来钉它——引擎删掉之后那句话没有对象了，
    // 但**这条用例并不因此变成恒真式**：夹具换成"当前档案有自己的 origin"之后它反而**更硬**。
    // 实测（起草时推演的最小变异）：把 `handleTargetLangChange` 改成顺手为当前档案的 origin 申请权限，
    // - 旧夹具（engineId: 'google'）→ 当前档案不存在，**照旧全绿**（拿不到 origin 可申请）；
    // - 新夹具（engineId: 'p-a'）→ `requests` 变成 `[[CUSTOM_ORIGIN_PATTERN]]` → **当场红**。
    // 所以这里不删也不改写成"保存已授权的档案不再弹框"——那一条 `options.test.ts` 里已经有一份
    // 完整的成对用例（「保存档案按**该档案自己的 origin** 申请宿主权限；已授权过就不再弹框」），
    // 再写一遍就是重复，而不是覆盖。
    await seedWithProfile({ targetLang: 'zh-Hans' });
    await loadOptions();

    pick<HTMLSelectElement>('target-lang').value = 'ja';
    pick<HTMLSelectElement>('target-lang').dispatchEvent(bubble('change'));
    await waitFor(async () => (await storedSettings()).targetLang === 'ja');

    expect(chromeStub.permissions.requests).toEqual([]);
    // 也不许有任何"顺手授予"：一次授权都不该发生。
    expect([...chromeStub.permissions.grantedOrigins]).toEqual([]);
    // 被选的档案确实有一个会被误申请的 origin（否则上面那条又变成恒真式）。
    expect(profileSeed().baseUrl).toBe(CUSTOM_BASE_URL);
  });
```
   并在该文件的 harness import 里加上 `seedWithProfile`。

### Step 6：`tests/popup/popup.test.ts`（6 处逐类处置 + 3 条改/增）

**6a. import 行** `import { DEFAULT_ENGINE_ID, getEngine } from '../../src/engines/registry';`
→ **整行删除**（两处消费者在下面被改掉）。
**6b. `import { NO_ENGINE_PROBLEM } from '../../src/shared/settings';`** 合进已有的
`from '../../src/shared/settings'` 那块 import。
**6c. 在 `seedSettings` 之后新增一个文件级夹具**：

```ts
/**
 * ⑤ 类用例（"整份回写不抹掉别的字段"）要一个**真的存在**的 `engineId`：
 * 夹具必须显式声明"这条用例需要一个可用引擎"，不能靠默认值——v5 起默认是 `''` = 没有可用引擎。
 */
async function seedWithProfile(patch: Record<string, unknown> = {}): Promise<void> {
  await seedSettings({
    engineId: 'p-a',
    profiles: [
      { id: 'p-a', label: '我的接口', baseUrl: 'https://api.test.example/v1', models: ['m'], activeModel: 'm', apiKey: 'sk-a' },
    ],
    ...patch,
  });
}
```
**6d. 「按存储里的设置选中目标语言与档案；下拉 = 免费接口 + 每个档案按名字」**：
标题改成「按存储里的设置选中目标语言与档案；下拉**只列档案**」；把

```ts
    const free = getEngine(DEFAULT_ENGINE_ID);
    expect(Array.from(engine.options).map((option) => [option.value, option.textContent])).toEqual([
      [free.id, free.name],
      ['p-deep', '我的 DeepSeek'],
    ]);
```
→
```ts
    // 下拉里**没有内置项**了（免费接口已删）：选项就是档案，一个不多一个不少。
    expect(Array.from(engine.options).map((option) => [option.value, option.textContent])).toEqual([
      ['p-deep', '我的 DeepSeek'],
    ]);
```
**6e. 「零配置引擎不警告，并说明无需 Key」整条重写为空态**（锚点唯一）。
⚠ 这条是**本文件第一次**用 `vi.stubGlobal`，所以先把收尾那道保险丝加上——把文件里现有的

```ts
afterEach(() => {
  vi.resetModules();
});
```
改成

```ts
afterEach(() => {
  vi.resetModules();
  // 6e 起本文件会 stub 全局 `fetch`（"零请求"那条断言要数它）：用例中途失败时
  // 那句手工的 `vi.unstubAllGlobals()` 跑不到，下一个用例就会带着一个假 fetch 开跑。
  vi.unstubAllGlobals();
});
```

然后把这条用例整条替换为：

```ts
  it('没有可用引擎：下拉那一行隐藏、提示区说出那句话并加 warn、零请求', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await seedSettings({ engineId: '', profiles: [] });
    await loadPopup();

    const { engine, hint } = ui();
    // 「翻译引擎」那一整行隐藏：一个空下拉是"点了没得选"的死控件，该由提示区说那句话。
    // ⚠ 这一行**没有自己的 id**（`popup.html` 不加新 id，理由见 `popup.ts` 里 `engineField` 的注释）：
    // 按结构取"`#engine` 的唯一 `.field` 祖先"，与 `#model-field` 走同一套 `.field[hidden]` 机制。
    expect(engine.closest('.field')?.hidden).toBe(true);
    expect(engine.options).toHaveLength(0);
    expect(hint.classList.contains('warn')).toBe(true);
    // 弹窗里没有「新增档案」按钮，只有右上角的齿轮，所以这句比设置页那句多一个"去哪做"。
    // **核心句逐字来自常量**（唯一来源），不在测试里抄一遍整句。
    expect(hint.textContent).toBe(`${NO_ENGINE_PROBLEM}。点右上角齿轮打开设置页。`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('有档案时那一行照常显示（上面那条的反面：不写它，「永远隐藏」也能过）', async () => {
    await seedWithProfile();
    await loadPopup();

    const { engine } = ui();
    expect(engine.closest('.field')?.hidden).toBe(false);
    expect(Array.from(engine.options).map((option) => option.value)).toEqual(['p-a']);
  });
```

**6f. 「切换引擎后提示区跟着重算（免费 ↔ 没填 Key 的档案）」整条重写为档案 ↔ 档案**：

```ts
  it('切换引擎后提示区跟着重算（档案 ↔ 档案：缺 Key ↔ 已配置）', async () => {
    chromeStub.permissions.grantedOrigins.add('https://api.test.example/*');
    await seedSettings({
      engineId: 'p-1',
      profiles: [
        profileOf({ id: 'p-1', label: '没填 Key 的', apiKey: '' }),
        profileOf({ id: 'p-2', label: '填了 Key 的', apiKey: 'sk-test' }),
      ],
    });
    await loadPopup();

    const { engine, hint } = ui();
    // 起点：当前档案没有 Key → 警告。
    expect(hint.classList.contains('warn')).toBe(true);
    expect(hint.textContent).toBe('该引擎需要 API Key，请先在设置中填写。');

    engine.value = 'p-2';
    engine.dispatchEvent(new Event('change'));
    await waitFor(() => !hint.classList.contains('warn'));
    expect(hint.textContent).toBe('已配置你自己的 API Key。');

    // 再切回去：警告回来（两个方向都钉，免得"只在挂载时算一次"的实现蒙过去）。
    engine.value = 'p-1';
    engine.dispatchEvent(new Event('change'));
    await waitFor(() => hint.classList.contains('warn'));
    expect(hint.textContent).toBe('该引擎需要 API Key，请先在设置中填写。');
  });
```
**6g. 三条 ⑤ 类持久化用例换夹具**：
- 「切换目标语言写进存储，其它字段原样保留」：`await seedSettings({ targetLang: 'zh-Hans', engineId: 'google' });`
  → `await seedWithProfile({ targetLang: 'zh-Hans' });`，并把 `expect(stored.engineId).toBe('google');`
  → `expect(stored.engineId).toBe('p-a');`
- 「选中档案即落盘档案 id，且整份回写不会抹掉任何档案已填的 Key」：把夹具里的
  `engineId: 'google',` → `engineId: 'p-a',`（它本身测的是"切到 `p-b`"，与引擎无关）。
- 「保存被拒绝时说明原因并回滚下拉」：`await seedSettings({ targetLang: 'zh-Hans', engineId: 'google' });`
  → `await seedWithProfile({ targetLang: 'zh-Hans' });`
- 「切换显示模式写进存储，其它字段原样保留」：
  `await seedSettings({ displayMode: 'translated-only', targetLang: 'ja', engineId: 'google' });`
  → `await seedWithProfile({ displayMode: 'translated-only', targetLang: 'ja' });`，并把
  `expect(stored.engineId).toBe('google');` → `expect(stored.engineId).toBe('p-a');`
**6h. 「隐私：三个档案各塞不同密钥…」** 里的下拉清单断言：

```ts
    expect(Array.from(engine.options).map((option) => option.textContent)).toEqual([
      getEngine(DEFAULT_ENGINE_ID).name,
      'DeepSeek 直连',
      '硅基流动',
      'Ollama 本机',
    ]);
```
→
```ts
    expect(Array.from(engine.options).map((option) => option.textContent)).toEqual([
      'DeepSeek 直连',
      '硅基流动',
      'Ollama 本机',
    ]);
```

### Step 7：`tests/background/service-worker.test.ts`

**7a. `stubGoogleFetch` 整块替换**（锚点唯一）：

```ts
/** 免费接口的假响应：把 `q` 参数回显成 `【q】`，同时记下每个请求的 URL。 */
function stubGoogleFetch(): URL[] {
  const calls: URL[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const text = url.searchParams.get('q') ?? '';
    return new Response(JSON.stringify([[[`【${text}】`, text]]]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}
```
→
```ts
interface StubCall {
  url: URL;
  body: { model: string; messages: Array<{ role: string; content: string }> };
}

/**
 * 唯一剩下那个适配器（OpenAI 兼容）的假响应：把请求体里每个编号标记后面的文本回显成 `【…】`，
 * 并记下每个请求的 URL 与请求体。
 *
 * 名字与形状都换了：旧版是 `stubGoogleFetch`，造的是免费接口那份**嵌套数组**
 * （`[[[译文, 原文, …], …], null, 源语言, …]`）。那个形状随 `src/engines/google.ts`
 * 一起删掉了——**今天没有任何生产代码会解析它**，留着一个"看起来还在"的假响应只会误导下一个人。
 */
function stubEngineFetch(): StubCall[] {
  const calls: StubCall[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as StubCall['body'];
    calls.push({ url, body });
    const user = body.messages.find((message) => message.role === 'user')?.content ?? '';
    const texts = [...user.matchAll(/<<<\d+>>>\n([^\n]*)/g)].map((match) => match[1] as string);
    const content = texts.map((text, index) => `<<<${index + 1}>>>\n【${text}】`).join('\n');
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

/** 「能真的发出请求」的档案：baseUrl 固定，Key 非空，模型是当前项。 */
const ENGINE_BASE_URL = 'https://api.example.com/v1';
const ENGINE_ORIGIN_PATTERN = 'https://api.example.com/*';

function usableProfile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p-a',
    label: '我的接口',
    baseUrl: ENGINE_BASE_URL,
    models: ['m'],
    activeModel: 'm',
    apiKey: 'sk-a',
    ...over,
  };
}

/**
 * 显式播种"有可用引擎"的设置，并把这个 origin 标成**已授权**。
 *
 * ⚠ 授权这一步不能省：`beforeEach` 的 `stub.reset()` 会清空 `grantedOrigins`，而
 * `openai-compat` 在 `fetch` 之前会先查宿主权限（没授权就抛 AUTH，一个请求都不发）。
 * 旧版这四条用例之所以"什么都不用写"，是因为它们靠 `DEFAULT_SETTINGS.engineId === 'google'`
 * 走通了免费接口那条**不需要授权**的路——v5 起默认是 `''`，那条路没有了。
 */
async function useUsableEngine(over: Record<string, unknown> = {}): Promise<void> {
  stub.permissions.grantedOrigins.add(ENGINE_ORIGIN_PATTERN);
  await useSettings({ engineId: 'p-a', profiles: [usableProfile()], ...over });
}
```
**7b. 四条不写设置的缓存用例**（第 99、296、494、513 行的四条）**各自显式播种**：
- 「合法消息返回 true，异步响应 { ok: true, results } 且结果已写进两层存储」：
  `const calls = stubGoogleFetch();` → `const calls = stubEngineFetch();` + 紧跟一行 `await useUsableEngine();`；
  并把 `expect(calls.map((url) => url.searchParams.get('q'))).toEqual(['Hello', 'World']);` → 
```ts
    // 唯一适配器一次请求带多条文本（免费接口是"一条文本一个请求"，那个形状随它一起删了）。
    expect(calls).toHaveLength(1);
    expect(calls[0].url.toString()).toBe('https://api.example.com/v1/chat/completions');
    const user = calls[0].body.messages.find((message) => message.role === 'user')?.content ?? '';
    expect(user).toContain('<<<1>>>\nHello');
    expect(user).toContain('<<<2>>>\nWorld');
```
  （`【Hello】` / `【World】` 的期望响应与落盘断言**都不用改**——假响应仍然回显成 `【…】`。）
- 「端口已关闭（sendResponse 抛错）时静默丢弃…」：`stubGoogleFetch();` → `stubEngineFetch();` +
  `await useUsableEngine();`
- 「两层都有同一个 key 时读会话层…」与「会话层没有时从持久层命中并回填会话层…」：同样的两行改动。

**7c. 「payload.targetLang 优先于设置里的 targetLang」**（§7.2 ② 类 + 断言换形状）：

```ts
  it('payload.targetLang 优先于设置里的 targetLang', async () => {
    const calls = stubEngineFetch();
    await useUsableEngine({ targetLang: 'ja' });

    await translateTexts({ items: [{ id: 'item-1', text: 'Hello' }], targetLang: 'en' }).response();
    const systemOf = (call: StubCall): string =>
      call.body.messages.find((message) => message.role === 'system')?.content ?? '';
    expect(systemOf(calls[0])).toContain('Target language: en');

    // 没带就按设置走（同一个 payload 形状，只有这一处差异）。
    await translateTexts({ items: [{ id: 'item-2', text: 'World' }] }).response();
    expect(systemOf(calls[1])).toContain('Target language: ja');
  });
```
**7d. 新增零请求端到端守卫**（插在「引擎报错（缺 API Key）…」之后）：

```ts
  /**
   * **「没有可用引擎 ⇒ 零请求」的端到端守卫**，也是本单元行为的**直接对立面**：
   * 起草规格时实测过，**改之前**同样的设置会真的发出一次 `translate.googleapis.com` 请求、
   * 返回 `{ ok: true, results: [{ text: '【Hello】' }] }`（免费接口静默兜底）。所以这条断言
   * 不是恒真式——它今天红、改完才绿。
   *
   * 牙在哪（两条各管一半，逐条记清楚，别只看"这条用例红了"）：
   * - `toEqual` 那条钉**响应形状**：`engine === null` 的提前返回被删掉时，`translateBatch`
   *   拿到 `null` 会抛成 `{ ok: false, code: 'UNKNOWN' }`（**不是** `AUTH` + 那句话）→ 红。
   *   注意：此时 `calls` **仍然是 0**——没有引擎就没有任何地方会去构造请求（这正是规格 §8.12
   *   说的"按构造"）。所以"删掉提前返回"**不会**让后台"真发请求"，规格 §10 变异表第 3 条的
   *   说法在这一点上不准确（见本计划 T1 的 M6/M6b）。
   * - `toHaveLength(0)` 那条钉**未来**：谁要是给 `resolveEngine` 加回一个**配置可用**的兜底
   *   引擎（M6b 演示的那种），请求立刻发出去，这条红。
   */
  it('没有可用引擎：整条返回 AUTH + 那句话，一个请求都不发', async () => {
    const calls = stubEngineFetch();
    await useSettings({ engineId: '', profiles: [] });

    await expect(translateTexts({ items: [{ id: 'item-1', text: 'Hello' }] }).response()).resolves.toEqual({
      ok: false,
      code: 'AUTH',
      message: NO_ENGINE_PROBLEM,
    });
    expect(calls).toHaveLength(0);
  });
```
并在该文件的 settings import 里加上 `NO_ENGINE_PROBLEM`（现在是
`import { CURRENT_VERSION, SETTINGS_KEY } from '../../src/shared/settings';`）。

### Step 8：跑一次全量，记录**真实的红形态**（这一步就是"先拿到红"）

Run: `npx vitest run`
Expected（起草时按改动面推演，实际以运行结果为准并**原样贴进提交说明**）：
- `tests/engines/google.test.ts` 仍在、`src/engines/google.ts` 仍在 → 那 15 条**还绿着**
  （它们还没被删）；红的是"新语义"那批（新迁移用例、零请求用例、空态用例、e:free 改写、四条缓存用例…）。
- 同时会看到**模块级加载失败**：`engine-health.test.ts` 引用了已删的 `FREE_ENGINE_HEALTH_KEY`？
  **不会**——那一步在 S4 已经改掉了；这一步的红全部来自"断言与旧实现不符"，是干净的红。
- 若出现"本计划没提到的用例红了"：**停下**，先解释清楚它为什么红，再继续。

### Step 9：删引擎 + 改注册表，然后**读 typecheck 给出的"旧引用点清单"**

```powershell
Remove-Item src\engines\google.ts, tests\engines\google.test.ts
npm run typecheck
```
Expected: **非零退出**，一份"旧引用点清单"（这就是规格 §10 说的免费清单，它说对了）。
清单上应当恰好覆盖：`src/shared/settings.ts`（`DEFAULT_ENGINE_ID` / `getEngine` 的返回类型）、
`src/options/sections/engine.ts`（同上 + `FREE_ENGINE_HEALTH_KEY`）、`src/popup/popup.ts`、
`src/background/service-worker.ts`、`tests/engines/registry.test.ts`。

`src/engines/registry.ts` **整份替换**为：

```ts
// src/engines/registry.ts
import { openAiCompatEngine } from './openai-compat';
import type { Translator } from './types';

/**
 * 已注册的适配器。**单元 E 之后只剩一个成员**（Google 免费接口已整体删除）。
 *
 * 保留这个数组与 {@link getEngine} 是"注册表"的形状：将来加第二种适配器时不用重新发明。
 * 有人把 `google.ts` 加回来、或把这里写成多成员，`tests/engines/registry.test.ts`
 * 的 `ENGINES.map((e) => e.id)` 断言当场红。
 */
export const ENGINES: readonly Translator[] = [openAiCompatEngine];

/**
 * 自定义接口引擎的 id。它**不再出现在任何选择器里**：v3 起用户选的是「某个服务商档案」
 * （`shared/settings.ts` 的 `resolveEngine` 负责把档案映射到本引擎），这个常量只是那
 * 一处解析与迁移折叠的引用点，避免 `'openai-compat'` 字面量在多处各写一份。
 */
export const OPENAI_COMPAT_ENGINE_ID = openAiCompatEngine.id;

/**
 * 按适配器 id 取引擎；没有这个 id 时返回 `null`（**不再回落到任何引擎**）。
 *
 * **这条兜底是被本单元推翻的设计判断**：旧注释写的是「未知 id 一律回退到默认引擎，避免设置里
 * 存了废弃 id 时整个插件不可用」。废弃 id 的正确答案不是"照样能翻"，而是"说清没有可用引擎，
 * 且一个请求都不发"——`resolveEngine` 因此把 `null` 翻成 `NO_ENGINE_PROBLEM`。
 *
 * 返回 `null` 而不是抛错：唯一的调用点是 `resolveEngine`，而它的契约是**返回值**而不是抛错
 * （弹窗在同步渲染函数里调它，抛错会把提示区变成异常路径）。让这里抛错等于把那条取舍反过来。
 */
export function getEngine(id: string): Translator | null {
  return ENGINES.find((engine) => engine.id === id) ?? null;
}
```

### Step 10：`src/shared/settings.ts`（Step 1 已加的两个符号之外的全部改动）

**10a. import 行**：

```ts
import { DEFAULT_ENGINE_ID, getEngine, OPENAI_COMPAT_ENGINE_ID } from '../engines/registry';
```
→
```ts
import { getEngine, OPENAI_COMPAT_ENGINE_ID } from '../engines/registry';
```
**10b. `Settings.engineId` 的文档注释整段替换**（锚点是从 `当前用的引擎：` 到 `engineId: string;`）：

```ts
  /**
   * 当前用的引擎：**某个档案的 `id`**，或 `''`（= **没有可用引擎**）。
   *
   * 「档案 → 用哪个引擎 + 哪份配置」的解析只有一处：{@link resolveEngine}。
   * 调用方（service worker、弹窗、设置页）一律走它，不许各自写一份 if。
   *
   * v5 起 `'google'` 不再是合法取值（免费接口已整体删除）：任何不指向现存档案的值
   * ——残留的 `'google'`、`'openai-compat'` 这类裸引擎 id、被别处删掉的档案 id——
   * 都表现为「没有可用引擎 + 一句可行动的话 + 零网络请求」，**不再回落到任何引擎**。
   */
  engineId: string;
```
**10c. `CURRENT_VERSION`**：

```ts
/** 当前设置 schema 版本；改动字段语义时递增。v4：`EngineProfile.model` → `models` + `activeModel`。 */
export const CURRENT_VERSION = 4;
```
→
```ts
/**
 * 当前设置 schema 版本；改动字段语义时递增。
 *
 * v4：`EngineProfile.model` → `models` + `activeModel`。
 * v5：删掉 Google 免费接口——`engineId: 'google'` 迁到第一个有 `activeModel` 的档案
 *     （一个都没有就置 `''`，见 {@link dropFreeEngineSelection}）。
 */
export const CURRENT_VERSION = 5;
```
**10d. `DEFAULT_SETTINGS.engineId`**：

```ts
  version: CURRENT_VERSION,
  engineId: DEFAULT_ENGINE_ID,
```
→
```ts
  version: CURRENT_VERSION,
  // `''` 的语义是**没有可用引擎**，不再是"某个引擎的 id"。首装因此就是
  // `profiles: []` + `engineId: ''`：弹窗与设置页各自显示那句可行动的话（§6.1）。
  // `mergeSettings` 的 `pickString(input.engineId, DEFAULT_SETTINGS.engineId)` 因此在
  // 字段缺失时天然落到 `''`——缺字段与显式空串**同义**，这正是我们要的。
  engineId: '',
```
**10e. `ResolvedEngine.engine`**：

```ts
export interface ResolvedEngine {
  engine: Translator;
```
→
```ts
export interface ResolvedEngine {
  /** `null` = 没有可用引擎（`engineId` 不指向任何现存档案）。此时 `problem` 必定有值。 */
  engine: Translator | null;
```
**10f. `resolveEngine` 上方那整段长注释 + 函数体**（锚点从 `/**\n * 「engineId → 用哪个引擎 + 用哪份配置」的**唯一一处**解析。`
到该函数的收尾 `}`）整段替换：

```ts
/**
 * 「engineId → 用哪个引擎 + 用哪份配置」的**唯一一处**解析。
 *
 * service worker、弹窗、设置页全走它。**不许**在别处再写一个 `if (settings.engineId === '')`
 * ——那就是第二个解析点，下次加引擎一定有一处漏掉。
 *
 * 解析规则只有三条：
 * 1. `engineId` 命中某个档案 → OpenAI 兼容引擎 + **那份**档案的 `{apiKey, baseUrl, model}`；
 *    `activeModel` 是空串（或只有空白）时**额外**给出 `problem`（{@link NO_MODEL_PROBLEM}）。
 *    空模型这件事只有这里能说清：引擎是通用适配器，它不知道"档案""模型清单"这些词，
 *    只会说一句用户照着找不到去哪儿的「尚未填写模型名」。
 * 2. `engineId` **不命中任何档案** → `{ engine: null, config: {}, problem: NO_ENGINE_PROBLEM }`。
 *    **这是「没有可用引擎」的唯一产出点。** `''`、残留的 `'google'`、`'openai-compat'` 这类
 *    裸引擎 id、被别处删掉的档案 id，走的都是这一条——**没有"兜底到某个别的引擎"这回事**，
 *    也不写「若 engineId === 'google' 则…」的补丁（它只是"一个不存在的 id"）。
 * 3. 其余（命中档案且模型齐全）→ 无 `problem`。
 *
 * 命中档案那一支交出来的 `engine` **类型上仍可能是 `null`**（`getEngine` 的返回类型如此）：
 * 三个调用点因此都要显式收口。这不是噪音，它是"没有可用引擎成为一等状态"之后必须付的账
 * ——`service-worker.ts` 用 `engine === null || problem !== undefined` 一次收住两件事。
 */
export function resolveEngine(settings: Pick<Settings, 'engineId' | 'profiles'>): ResolvedEngine {
  const profile = settings.profiles.find((item) => item.id === settings.engineId);
  if (profile === undefined) return { engine: null, config: {}, problem: NO_ENGINE_PROBLEM };
  const engine = getEngine(OPENAI_COMPAT_ENGINE_ID);
  const config: EngineConfig = { apiKey: profile.apiKey, baseUrl: profile.baseUrl, model: profile.activeModel };
  // 判空口径与引擎实现**一致**：只有空白字符也算"没填"（`openai-compat` 取 `config.model` 时
  // 先 `.trim()`）。写成 `activeModel.length === 0` 会漏过"只填了空格"这一格——档案被判成能用，
  // 用户却在发请求时拿到引擎那句通用的「尚未填写模型名」，白跑一趟。
  if (profile.activeModel.trim().length === 0) return { engine, config, problem: NO_MODEL_PROBLEM };
  return { engine, config };
}
```
**10g. `migrate` 的文档注释末尾加一段 + 分支链末尾加一步**：

```ts
 * 迁移按 `storedVersion` 分支、**只在 `loadSettings` 里发生**：v4 数据从版本闸门
```
→
```ts
 * **v4 → v5：`engineId: 'google'` 改指向第一个有 `activeModel` 的档案。**见 `dropFreeEngineSelection`。
 *
 * 迁移按 `storedVersion` 分支、**只在 `loadSettings` 里发生**：v5 数据从版本闸门
```
并在：
```ts
  if (storedVersion < 4) {
    record = liftProfileModels(record);
  }
  return record;
```
→
```ts
  if (storedVersion < 4) {
    record = liftProfileModels(record);
  }
  // 排在 `liftProfileModels` **之后**：`activeModel` 是它抬出来的（v1/v2/v3 的数据在这一步
  // 之前还没有这个字段）。
  if (storedVersion < 5) {
    record = dropFreeEngineSelection(record);
  }
  return record;
```
**10h. 新增 `dropFreeEngineSelection`**：插在 `liftProfileModels` 函数**之后**、`foldLegacyEngineConfig`
的文档注释**之前**：

```ts
/**
 * v4 → v5 的迁移：**只做一件事**——`engineId === 'google'`（那个已删除的免费接口）改指向
 * 「第一个有当前模型的档案」，一个都没有就置 `''`（= 没有可用引擎）。
 *
 * 四条刻意的口径：
 * 1. **只认 `'google'` 这个字面值**，不做"认不出来就重挑"的泛化：v5 迁移的输入是**声明的 v4
 *    数据**，那个版本里 `engineId` 的合法取值只有 `'google'` 与档案 id 两种形状；其他值
 *    （脏存储、手工改过）**不替用户猜**——它们在新语义下表现为"没有可用引擎 + 一句可行动的话"，
 *    不猜 = 不发请求，是安全的默认方向。
 * 2. **判据只有 `firstUsableProfileId` 一份**（`trim()` 后为空即"没有当前模型"），与
 *    `resolveEngine`、与设置页删除档案那条回落**完全同源**。
 * 3. **参数是存储里的生数据**：`mergeSettings` 还没跑，`record.profiles` 可能是 `undefined`
 *    / 非数组 / 装着非对象，所以这里先做一次**形状投影**再问判据。直接
 *    `firstUsableProfileId(record.profiles as EngineProfile[])` 会在 `profiles` 缺失时抛
 *    TypeError（`tests/shared/settings.test.ts` 的「engineId 是 google 时不产生档案」就喂了
 *    这种数据：v2 + `engineId: 'google'` + 没有 `profiles` 键），整个 `loadSettings` 会跟着挂。
 * 4. **产物里不留 `engineId: 'google'` 的任何痕迹**（与 `foldLegacyEngineConfig` 删
 *    `engineConfig` / `providerPreset`、`liftProfileModels` 删 `model` 同一条纪律）。
 *
 * 幂等靠 `migrate` 开头那道版本闸门（`storedVersion >= CURRENT_VERSION` 直接原样返回），
 * 本函数因此只需要处理"第一次读到 v4"那一次。
 */
function dropFreeEngineSelection(record: Record<string, unknown>): Record<string, unknown> {
  if (record.engineId !== 'google') return record;
  const raw = Array.isArray(record.profiles) ? record.profiles : [];
  const candidates: Array<Pick<EngineProfile, 'id' | 'activeModel'>> = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as { id?: unknown; activeModel?: unknown };
    if (typeof entry.id === 'string' && typeof entry.activeModel === 'string') {
      candidates.push({ id: entry.id, activeModel: entry.activeModel });
    }
  }
  return { ...record, engineId: firstUsableProfileId(candidates) };
}
```

### Step 11：`src/options/engine-health.ts`（`e:` 键空间消亡）

**11a. 模块抬头第 3 行**：

```ts
// 状态点（§4.3）背后的记录：每个引擎/档案"最近一次测试连接"的结果。
```
→
```ts
// 状态点（§4.3）背后的记录：每个**档案**"最近一次测试连接"的结果。
```
（"引擎"这个主语今天只剩档案一种。这不是文案洁癖：这句话是下面那套键空间**存在理由**的陈述，
留着"引擎"会让人以为还有引擎记录要处理。）

**11b. 两个键空间那段长注释 + 两个键常量**（锚点从 `/**\n * 记录键的**两个键空间**：`
到 `const ENGINE_HEALTH_PREFIX = 'e:';`）整段替换为：

```ts
/**
 * 记录键只有**一个键空间**：档案记录是 `p:<档案 id>`。
 *
 * 这里曾经有第二个键空间 `e:<引擎名>`（内置免费引擎那一格，`e:free`）。免费接口随单元 E
 * 整体删除，那个键空间**随之消亡**——没有"引擎记录"这种东西了。但 `p:` 前缀**留着**：
 *
 * - `profileIdFromHealthKey` 的往返、"记录键"与"档案 id"是两个概念这件事、以及
 *   "将来可能又有第二类记录"都靠它把两者分开；
 * - 退回裸 id 是**一次没有收益的改动**：它唯一的收益（两类键按构造不相等）今天已经不需要了，
 *   代价却是把"键"与"id"重新合成一个概念，下一类记录出现时又要拆一次。
 *
 * **读侧仍然键无关**（`pickHealth` 不解释前缀）：一是"形状不对的记录丢掉"那条规矩与键空间
 * 是两件事，混在一处会让前者的读数（`tests/options/engine-health.test.ts`「存储里是垃圾也不崩」
 * 用 `good` / `badState` 这类任意键）说不清是被谁丢的；二是过滤解决不了任何问题——没有一行会去
 * 读裸键。
 *
 * 迁移：本分支的中间版本用**裸 id**（`google` / `p-a`）写过记录。那是 session 区域、从未发布、
 * 浏览器一关就没了，所以这里**刻意不写迁移代码**。**不能把它们一概说成"读不到"**：
 * **不以前缀 `p:` 开头**的裸键（`google`、`p-a`…）今天读不到任何一行——没有一行会去读它们；
 * 而 `p:` 形状的老键（只可能来自手改存储，正常 id 不会长这样）会被 **id 恰好等于后半段**
 * 的档案行认领（`profileIdFromHealthKey('p:x')` → `'x'`）。也就是说这个形状例外是
 * "读取按 `p:<id>` 取值"这条规矩本身的镜像，不是漏掉的一支；留着它比在读侧加一层
 * "只认本轮写的键"的过滤便宜——那种过滤既没解决任何问题，又会把键空间的知识复制到第二处。
 */
const PROFILE_HEALTH_PREFIX = 'p:';
```
（`FREE_ENGINE_HEALTH_KEY` 整行删除。**导出面缩小**——提交信息里要记一句：这是模块的公开契约变化。）

**11c. `profileIdFromHealthKey` 的注释**：

```ts
/** 档案记录键 → 档案 id；不是档案键（引擎键、老构建的裸键…）时返回 `null`。 */
```
→
```ts
/** 档案记录键 → 档案 id；不是档案键（老构建写下的裸键…）时返回 `null`。 */
```
**11d. `pickHealth` 的注释**：

```ts
/** 逐条校形。键在这里是**记录键**（`p:<id>` / `e:<引擎名>`），本函数不解释它的前缀。 */
```
→
```ts
/** 逐条校形。键在这里是**记录键**（`p:<档案 id>`），本函数不解释它的前缀。 */
```
**11e. `saveEngineHealth` 的注释**：

```ts
 * **第一个参数是记录键**（`profileHealthKey(id)` 或 `FREE_ENGINE_HEALTH_KEY`），**不是档案 id**：
```
→
```ts
 * **第一个参数是记录键**（`profileHealthKey(id)`），**不是档案 id**：
```
**11f. `redactSecret` 的注释**：

```ts
 * （真凭据都够长，各家至少 `sk-` + 一串）。空 Key（免费引擎、没填 Key 的路径）因此天然落在
```
→
```ts
 * （真凭据都够长，各家至少 `sk-` + 一串）。空 Key（没填 Key 的路径）因此天然落在
```

### Step 12：`src/options/sections/engine.ts`

**12a. 两处 import**：

```ts
import { getEngine, DEFAULT_ENGINE_ID } from '../../engines/registry';
```
→ **整行删除**。

```ts
import {
  FREE_ENGINE_HEALTH_KEY,
  forgetEngineHealth,
```
→
```ts
import {
  forgetEngineHealth,
```
并把 `NO_ENGINE_PROBLEM` 与 `firstUsableProfileId` 加进
`from '../../shared/settings'` 那块 import（该块已有 `DEFAULT_SETTINGS, PROVIDER_PRESETS, …`）。

**12b. 删掉 `buildFreeEngineRow`**：整块（含它上面的文档注释，锚点从
`/**\n * 内置免费引擎那一行：名字 + 内置徽章 + 状态点 + 测试连接。` 到该函数的收尾 `}`）**整段删除**。

**12c. `insertDraftRow`**：

```ts
/**
 * 只追加「新档案（未保存）」那一行，不动其余行。
 * 草稿行永远排在免费引擎行**之前**（与 `renderProfiles` 的追加顺序一致）。
 */
function insertDraftRow(ctx: SectionContext): void {
  if (rowById(NEW_DRAFT_ID) !== null) return;
  const row = buildProfileRow(ctx, NEW_DRAFT_ID);
  const free = profilesList.querySelector('[data-engine-free]');
  if (free === null) profilesList.append(row);
  else free.before(row);
}
```
→
```ts
/**
 * 只追加「新档案（未保存）」那一行，不动其余行。
 * 追加在**最后**：草稿行与真实档案行同序（`renderProfiles` 也是这个顺序）。
 */
function insertDraftRow(ctx: SectionContext): void {
  if (rowById(NEW_DRAFT_ID) !== null) return;
  profilesList.append(buildProfileRow(ctx, NEW_DRAFT_ID));
}
```
**12d. `renderProfiles` 的收尾**：

```ts
  if (expandedId === NEW_DRAFT_ID) {
    profilesList.append(buildProfileRow(ctx, NEW_DRAFT_ID));
  }
  // 内置免费引擎永远排在最后（§3.1：它不可删），每次重绘都跟着列表一起画。
  profilesList.append(buildFreeEngineRow());
}
```
→
```ts
  if (expandedId === NEW_DRAFT_ID) {
    profilesList.append(buildProfileRow(ctx, NEW_DRAFT_ID));
  }
}
```
**12e. `renderEngineHint` 整块替换**（锚点从 `/** 档案区顶部的说明：当前在用哪一档` 到该函数的收尾 `}`）：

```ts
/**
 * 档案区顶部的说明（选择器的真相在弹窗，这里如实指路）。两种情形，判据都是 `resolveEngine`：
 * - `engine === null`（含首装、含失效 engineId）→ **`NO_ENGINE_PROBLEM` 原样**。这句话由
 *   `resolveEngine` 产出（唯一来源），这里只负责显示。设置页的空态就是"这句话 + 页面上现成的
 *   「+ 新增档案」按钮"——**不新增空态 DOM、不预置草稿行**（预置草稿行 = 预置了半个档案骨架）。
 * - 命中档案 → 那句"当前在用档案「X」…"（原样保留）。
 *
 * 旧实现在失效 `engineId` 下显示的是「当前在用免费接口（零配置）…」——那句在删掉引擎之后
 * 彻底不成立，而且它今天就在误导（用户以为自己没配任何东西却"在用免费接口"）。
 */
function renderEngineHint(ctx: SectionContext): void {
  const snapshot = ctx.settings();
  if (snapshot === null) return;
  const { engine, problem } = resolveEngine(snapshot);
  if (engine === null) {
    // `engine === null` ⇒ `problem` 必定有值（`resolveEngine` 的第 2 条规则）；类型系统看不出
    // 这层因果，所以退到同一个常量，而不是写非空断言（`!`）——断言会在将来某次改动后静默变成谎言。
    engineHint.textContent = problem ?? NO_ENGINE_PROBLEM;
    return;
  }
  const selected = snapshot.profiles.find((profile) => profile.id === snapshot.engineId);
  if (selected !== undefined) {
    engineHint.textContent = `当前在用档案「${selected.label}」。点这一行右侧的「编辑」展开；在弹窗的「翻译引擎」里按名字切换。`;
    return;
  }
  // 命中档案的一支不可能走到这里（`engine !== null` ⇒ `engineId` 命中了某个档案）。
  // 留着它是**防御性**的：真走到这里，说"没有可用引擎"比说一句关于档案的话更诚实。
  engineHint.textContent = NO_ENGINE_PROBLEM;
}
```
**12f. `runConnectionTest` 的注释**：

```ts
 * 真发一次极短请求并上报结果——档案与内置免费引擎**走同一条路**。
```
→
```ts
 * 真发一次极短请求并上报结果。今天只有档案走这条路。
```
```ts
 * 其余调用方交的是 `profileHealthKey(id)` 或免费引擎的 `FREE_ENGINE_HEALTH_KEY`。
```
→
```ts
 * 唯一的真实调用方交的是 `profileHealthKey(id)`。
```
**12g. `rowForKey` 整块替换**（含它上方那段长注释，锚点从 `/**\n * 记录键 → 该去哪一行找点。`
到该函数收尾 `}`）：

```ts
/**
 * 记录键 → 该去哪一行找点。**这层映射只有这一处**：`p:<档案 id>` → 按 `data-profile-id`
 * 找 `<id>` 那一行。
 *
 * 这里曾经还有一支「引擎键 → 内置免费引擎那一行」（`key === FREE_ENGINE_HEALTH_KEY`），
 * 随免费接口一起删掉了：**引擎键这个键空间已经不存在**，函数只剩一条路。
 *
 * 不认识的键返回 `null` 是防御性的一支（本函数只接调用方刚拼出来的键）；老构建写下的裸 id
 * 也根本到不了这里——所有读取处一律按 `p:<id>` 取，这正是"不写迁移"的口径。唯一会被老键
 * 命中的形状是 `p:<id>` 那种（只能来自手改存储）：读取处按 `p:<id>` 取值，id 对上的档案行
 * 就会认领它；例外与取舍的完整说明在 `engine-health.ts` 的迁移那一段。
 */
function rowForKey(key: string): HTMLElement | null {
  const id = profileIdFromHealthKey(key);
  return id === null ? null : rowById(id);
}
```
**12h. `healthDot` 的注释**：

```ts
/**
 * 找某一行的状态点。档案行走 `data-profile-id`；**内置免费引擎那一行刻意没有 id**
 * （见 `buildFreeEngineRow`），所以只能按它自己的标记找（`rowForKey` 分派）。
 */
```
→
```ts
/** 找某一行的状态点：键 → 行（`rowForKey`）→ 那一行的 `.dot`。 */
```
**12i. `recordHealth` 的注释**：

```ts
 * 交进来的 `key` 是**已经分好键空间**的记录键（`profileHealthKey` / `FREE_ENGINE_HEALTH_KEY`），
```
→
```ts
 * 交进来的 `key` 是**记录键**（`profileHealthKey`），
```
**12j. `handleTestProfile` 里 `resolveEngine` 之后加收口**（锚点是 `if (problem !== undefined) {` 那一支的收尾）：

```ts
  if (problem !== undefined) {
    setStatus(engineStatus, 'err', problem);
    return;
  }
```
→
```ts
  if (problem !== undefined) {
    setStatus(engineStatus, 'err', problem);
    return;
  }
  // 到这里 `engine` 一定非 null（`engineId` 就是上面这个档案的 id，`resolveEngine` 的第 1 条
  // 规则必然命中）——类型系统看不出这层因果，所以显式收一句，不写非空断言 `!`。
  if (engine === null) {
    setStatus(engineStatus, 'err', NO_ENGINE_PROBLEM);
    return;
  }
```
**12k. 删掉 `handleTestFreeEngine`** 整块（含它上面的注释，锚点唯一）。

**12l. `handleDeleteProfile` 的回落与状态行**：

```ts
  const wasCurrent = latest.engineId === id;
  const remaining = latest.profiles.filter((profile) => profile.id !== id);

  const saved = await ctx.save(
    engineStatus,
    '设置未能保存',
    { profiles: remaining, engineId: wasCurrent ? DEFAULT_ENGINE_ID : latest.engineId },
  );
  if (!saved) return;
```
→
```ts
  const wasCurrent = latest.engineId === id;
  const remaining = latest.profiles.filter((profile) => profile.id !== id);
  // 回落判据与 v5 迁移**同一个函数、同一份判据**：落到剩下的档案里第一个有当前模型的，
  // 一个都没有就置 `''`（= 没有可用引擎）。
  // 旧理由（"下一个档案可能没填 Key、地址可能没授权，删一个档案不该让用户突然翻译失败"）
  // **不再成立、也不再需要**：v4 起每个档案都有 `activeModel` 这个明确信号，
  // `firstUsableProfileId` 挑的正是用户真的配好过的那一个；而"没配好"的档案不再是
  // "会静默失败"，而是 `NO_ENGINE_PROBLEM` 那句可行动的话。
  const fallback = wasCurrent ? firstUsableProfileId(remaining) : latest.engineId;

  const saved = await ctx.save(
    engineStatus,
    '设置未能保存',
    { profiles: remaining, engineId: fallback },
  );
  if (!saved) return;
```
以及状态行：
```ts
  setStatus(
    engineStatus,
    'ok',
    wasCurrent
      ? `已删除当前在用的档案「${target.label}」，引擎已回落到「${getEngine(DEFAULT_ENGINE_ID).name}」，请在弹窗里重新选择。`
      : `已删除档案「${target.label}」。`,
  );
```
→
```ts
  // 「没有可用引擎」那一支的尾句**以常量为核**（唯一来源），不各写一份字面量：
  // 于是这里读到的是「已删除当前在用的档案「X」，还没有可用的翻译引擎，去设置页添加一个服务商档案。」
  // ⚠ 规格 §5.3 给的字面是「…，**现在**没有可用的翻译引擎，…」，而 §6.1 给的是
  // 「**还没有**可用的翻译引擎，…」——两者只能取一个。取常量那一支：§5.3 自己写着
  // "实现时以常量拼接，不各写一份字面量"，而 §6.1 也写着"两处的核心句必须逐字相同（都由常量拼接）"。
  const fallbackLabel = remaining.find((profile) => profile.id === fallback)?.label;
  setStatus(
    engineStatus,
    'ok',
    wasCurrent
      ? fallbackLabel === undefined
        ? `已删除当前在用的档案「${target.label}」，${NO_ENGINE_PROBLEM}。`
        : `已删除当前在用的档案「${target.label}」，引擎已切换到「${fallbackLabel}」，请在弹窗里重新选择。`
      : `已删除档案「${target.label}」。`,
  );
```
并把该函数上方那段注释里的旧理由换掉：
```ts
 * 删除一个档案。若删的正是**当前在用**的那个，`engineId` 明确回落到免费接口并说明——
 * 绝不能留下一个指向不存在档案的 id。（为什么回落免费引擎而不是"下一个档案"：下一个
 * 档案可能没填 Key、地址可能没授权，删一个档案不该让用户突然翻译失败。）
```
→
```ts
 * 删除一个档案。若删的正是**当前在用**的那个，`engineId` 明确切到剩下的档案里第一个
 * **配好模型**的（`firstUsableProfileId`，与 v5 迁移同一份判据），一个都没有就置 `''`
 * ——绝不能留下一个指向不存在档案的 id，也绝不留下一个"悬空但看起来还在用"的选择。
```
**12m. 事件委托里的 `test-free` 分支**：

```ts
      // 免费引擎那一行不在 `[data-profile-id]` 里，必须在行判断之前处理。
      if (action === 'test-free') {
        runSafely(engineStatus, '测试连接失败', () => handleTestFreeEngine(ctx));
        return;
      }
      const row = target.closest('[data-profile-id]');
```
→
```ts
      const row = target.closest('[data-profile-id]');
```
**12n. `applyExpansion` 的注释**里那两句提到免费引擎行的：

```ts
 * 为什么不是 `renderProfiles(ctx)`：那个函数开头清空整张列表再重建（档案行 + 免费引擎行），
```
→
```ts
 * 为什么不是 `renderProfiles(ctx)`：那个函数开头清空整张列表再重建（每个档案一行），
```
```ts
 * `.profile-editor`、以及摘/插编辑器前后各一次暂存的读与写。列表结构、行顺序、免费引擎行、
 * 其它行通通不动。
```
→
```ts
 * `.profile-editor`、以及摘/插编辑器前后各一次暂存的读与写。列表结构、行顺序、其它行通通不动。
```

### Step 13：`src/popup/popup.ts`

**13a. import**：

```ts
import { DEFAULT_ENGINE_ID, getEngine } from '../engines/registry';
```
→ **整行删除**；并在 `from '../shared/settings'` 那块 import 里加 `NO_ENGINE_PROBLEM`。

**13b. 新增 `engineField` 引用**：紧跟 `const engineSelect = document.getElementById('engine') as HTMLSelectElement;`
之后插入：

```ts
/**
 * 「翻译引擎」那一整行的容器（0 个档案时整行隐藏）。
 *
 * ⚠ **这一行没有自己的 id**，按结构取：`#engine` 的唯一 `.field` 祖先。
 * 为什么不为它加一个 `id="engine-field"`：`popup.html` 是**另一个在途会话**正在改的文件
 * （品牌改名，未提交），本单元刻意不在那里加东西；而且加一个 id 会连带改
 * `tests/popup/popup.test.ts` 里"`popup.html` 里 id 的数量"那条守卫（今天恰好 13），
 * 那条守卫管的是 HTML 的表面，与本单元无关。复用既有的 `.field[hidden] { display: none }`，
 * 与 `#model-field` 同一套机制，**不新增 CSS**。
 */
const engineField = engineSelect.closest('.field') as HTMLLabelElement;
```
**13c. `engineOptions`**：

```ts
/**
 * 「翻译引擎」下拉的选项：免费接口 + **每个档案按自己的名字**。
```
→
```ts
/**
 * 「翻译引擎」下拉的选项：**每个档案按自己的名字**（引擎不再有内置项）。
```
并把函数体：
```ts
function engineOptions(next: Settings): Array<{ value: string; label: string }> {
  const free = getEngine(DEFAULT_ENGINE_ID);
  return [
    { value: free.id, label: free.name },
    ...next.profiles.map((profile) => ({ value: profile.id, label: profile.label })),
  ];
}
```
→
```ts
function engineOptions(next: Settings): Array<{ value: string; label: string }> {
  return next.profiles.map((profile) => ({ value: profile.id, label: profile.label }));
}
```
**13d. `applySettings`**：

```ts
  fillSelect(engineSelect, engineOptions(settings), settings.engineId);
  renderModelSelect();
```
→
```ts
  fillSelect(engineSelect, engineOptions(settings), settings.engineId);
  // 一个档案都没有时整行隐藏：一个空下拉是"点了没得选"的死控件，那件事该由提示区说
  // （`renderEngineHint` 的 `engine === null` 那一支）。≥1 个档案时显示。
  engineField.hidden = settings.profiles.length === 0;
  renderModelSelect();
```
**13e. `renderEngineHint`**：

```ts
  const { engine, config, problem } = resolveEngine(settings);
  // 判空口径与引擎实现一致：只有空白字符也算**没填**（见 openai-compat 的构造）。
  const missingKey = engine.needsKey && (config.apiKey ?? '').trim().length === 0;
```
→
```ts
  const { engine, config, problem } = resolveEngine(settings);
  // 「没有可用引擎」是**一等状态**：`resolveEngine` 产出那句话（唯一来源），这里只负责显示。
  // 弹窗里没有「新增档案」按钮，只有右上角的齿轮，所以这句比设置页那句多一个"去哪做"
  // ——两处的**核心句逐字相同**（都由 `NO_ENGINE_PROBLEM` 拼出来）。
  if (engine === null) {
    engineHint.classList.add('warn');
    engineHint.textContent = `${problem ?? NO_ENGINE_PROBLEM}。点右上角齿轮打开设置页。`;
    return;
  }
  // 判空口径与引擎实现一致：只有空白字符也算**没填**（见 openai-compat 的构造）。
  const missingKey = engine.needsKey && (config.apiKey ?? '').trim().length === 0;
```
以及结尾那段：
```ts
  // 前瞻分支：现存两个引擎的 supportsGlossary 都是 true，今天恒不成立。留着是接口预留
  // （见 engines/types.ts 的 Translator），不是死代码。
  if (!engine.supportsGlossary && settings.glossary.length > 0) {
    engineHint.classList.remove('warn');
    engineHint.textContent = '当前引擎不支持术语表，术语表对其不生效。';
    return;
  }
  const okText = engine.needsKey ? '已配置你自己的 API Key。' : '零配置可用，无需 API Key。';
  engineHint.classList.remove('warn');
  engineHint.textContent = okText;
```
→
```ts
  // **如实记账**：删掉免费接口之后唯一的适配器恒为 `true`，这一支**今天没有判别力**
  // （弹窗里同一条分录与 `if (!engine.supportsGlossary …)` 分支同样恒不成立）。它们留着是
  // **适配器契约**（第三种适配器可能不支持术语表/提示词，见 engines/types.ts 的 Translator），
  // 不是死代码。**不为它编断言**（本仓既有纪律：不为读不到的东西编断言）。
  if (!engine.supportsGlossary && settings.glossary.length > 0) {
    engineHint.classList.remove('warn');
    engineHint.textContent = '当前引擎不支持术语表，术语表对其不生效。';
    return;
  }
  // 唯一适配器恒 `needsKey === true`，所以这里只有这一句。旧实现的另一支
  // 「零配置可用，无需 API Key。」是**免费接口的说法**：它随免费接口一起删掉，
  // **不为读不到的 `needsKey === false` 分支另编一句新文案**（那会是一条没有守卫的假承诺；
  // 将来真接入不需要 Key 的适配器时，这一支要说的话必须重新裁决）。
  engineHint.classList.remove('warn');
  engineHint.textContent = '已配置你自己的 API Key。';
```

### Step 14：`src/background/service-worker.ts`

**14a. import**：`import { DEFAULT_SETTINGS, loadSettings, resolveEngine, type Settings } from '../shared/settings';`
→ `import { DEFAULT_SETTINGS, NO_ENGINE_PROBLEM, loadSettings, resolveEngine, type Settings } from '../shared/settings';`

**14b. 解析与闸门整段替换**。锚点是从下面第 5 行（`    // 「用哪个引擎 + 用哪份配置」只有一处解析`）
**直到** `    if (problem !== undefined) return { ok: false, code: 'AUTH', message: problem };` 那一行
（含它在内的**整段**，中间那些"⚠ 这道闸不负责零请求 / ⚠ 接线完成前不许合进 release"的注释一并换掉，
它们的结论已经并入新注释）：

```ts
    const settings = await loadSettings(persistentArea);
    // 「用哪个引擎 + 用哪份配置」只有一处解析（shared/settings 的 resolveEngine）：
    // engineId 现在是 `google` 或某个档案的 id，别处各写一份 if 迟早和这里漂移。
    const { engine, config, problem } = resolveEngine(settings);
    // 档案没有当前模型：**在这里就返回**（§3.3）。规格要的是一句可行动的话，而不是带着空 model
    // 去打接口换回一句 HTTP 400（上次 `deepseek` 那次事故的形状）。
    // 整条请求失败（不是条目级失败）：这件事对这批里的每一条都成立，没有"逐条重试"的意义。
    //
    // ⚠ **这道闸不负责"零请求"**：零请求由 `src/engines/openai-compat.ts:64-67` 的空 model 闸
    // **构造性**保证（它在 `fetch` 之前就抛 AUTH）。这道闸改变的是**失败粒度与文案**：
    // 没有它 → 条目级 `{ ok: true, results: [{ code: 'AUTH', message: '尚未填写模型名…' }] }`；
    // 有它 → 整条 `{ ok: false, code: 'AUTH', message: problem }`。别把它记成"少发一次请求的守卫"。
    //
    // ⚠ **接线完成前不许合进 release**（与 C1 的过渡映射同一条纪律）：`problem` 在类型上是可选的，
    // 漏接一处不会编译失败，只会在真机上表现为"用户拿到一句通用的、指不到去哪儿的话"。
    if (problem !== undefined) return { ok: false, code: 'AUTH', message: problem };
```
→ **整段替换为**：

```ts
    const settings = await loadSettings(persistentArea);
    // 「用哪个引擎 + 用哪份配置」只有一处解析（shared/settings 的 resolveEngine）：
    // `engineId` 现在是**某个档案的 id**，或 `''`（= 没有可用引擎）。没有第二个解析点——
    // **不许**在这里再写一个 `if (settings.engineId === '')`。
    const { engine, config, problem } = resolveEngine(settings);
    /**
     * 两道收口在这一行合并——对用户是同一件事：带一句可行动的话整条返回，**一个请求都不发**。
     *
     * - `engine === null`：`engineId` 不指向任何现存档案（含残留的 `'google'`、`'openai-compat'`
     *   这类裸引擎 id）。这里也是**类型上必须**收住的地方：`translateBatch` 要一个真的 `Translator`。
     * - `problem !== undefined`：档案没有当前模型（`NO_MODEL_PROBLEM`）。
     *
     * 两句都由 `resolveEngine` 产出（唯一来源），这里只负责转达与选错误码。
     *
     * 为什么 `code` 用 `'AUTH'` 而不是新造一个码：内容脚本的 `describeError` 对 AUTH **原样透传**
     * message（不走罐头文案），`sameCodeFailureMessage` 对 AUTH 只追加一句"在扩展设置里…"
     * （方向正确），而 AUTH **不在** `RETRYABLE_CODES` 里——不会给用户挂一排点了必然失败的重试按钮。
     *
     * ⚠ **这道闸不是"零请求"的守卫**（本单元更正了旧注释的这半句）：没有可用引擎时零请求是
     * **按构造**成立的——`resolveEngine` 交出来的 `engine` 是 `null`，没有任何地方会去构造一个
     * 引擎对象，"忘了拦一处就发出去"这条路径**按构造**不存在。这道闸改变的是**失败粒度与文案**：
     * 没有它 → `translateBatch` 拿到 `null` 会抛成 `{ ok: false, code: 'UNKNOWN' }`（一句用户看不懂
     * 的话）；有它 → 整条 `{ ok: false, code: 'AUTH', message: problem }`。
     * 有读数的那条端到端守卫在 `tests/background/service-worker.test.ts`：
     * 「没有可用引擎：整条返回 AUTH + 那句话，一个请求都不发」。
     */
    if (engine === null || problem !== undefined) {
      return { ok: false, code: 'AUTH', message: problem ?? NO_ENGINE_PROBLEM };
    }
```

### Step 15：跑全量（此时应当全绿）

Run: `npx vitest run`
Expected: **全绿**，文件数 = 基线 55 − 1（`tests/engines/google.test.ts` 删除）= **54**；
用例数按真实读数入账（**不预设数字**：本仓纪律是落地读数入账，规格 §7.1 也是这么写的）。
若还有红：逐条按"它是本计划哪一处漏掉的引用点"定位，**不许**为了绿而放宽断言。

Run: `npm run typecheck`
Expected: exit 0。

### Step 16：构建

Run: `npm run build`
Expected: exit 0，尾部 `✓ 产物校验全部通过（14 项）`。
⚠ 产物里 **`dist/manifest.json` 的 `host_permissions` 此刻还是旧的**（`src/manifest.json` 属 T2）——
这是预期的，T2 才清它。

### Step 17：变异验证（逐个当场 revert；每做完一个跑 `git diff --stat` 确认干净）

| # | 变异 | 期望红（点名的用例） |
| --- | --- | --- |
| **M1** | 把 `dropFreeEngineSelection` 改成空操作（`return record;` 直接返回），或把 `CURRENT_VERSION` 改回 `4` | `tests/shared/settings.test.ts`「迁移 v4 → v5」四条里至少前两条红（`engineId` 仍是 `'google'`）。**保持默认值不动**是这条变异的关键：只改默认值不改迁移，`engineId` 会落到 `'google'` 而不是 `''`，同样是红 |
| **M2** | `getEngine` 退回静默兜底：`return ENGINES.find((engine) => engine.id === id) ?? openAiCompatEngine;` | `tests/engines/registry.test.ts`「未知 id 返回 null」红（`expected 'openai-compat' to be null`）；`tests/shared/settings.test.ts`「engineId 不指向任何现存档案…」红 |
| **M3** | `firstUsableProfileId` 的判据退化成"取第一个档案"：`return profiles[0]?.id ?? '';`（**不看 `activeModel`**） | 点名的两条：`tests/shared/settings.test.ts`「engineId 是 google → 数组里第一个 activeModel 非空的档案（不是…）」→ `expected 'p-empty' to be 'p-usable'`；`tests/options/options.test.ts`「删除当前档案时跳过没有当前模型的档案」→ `expected 'p-empty' to be 'p-b'` |
| **M4** | 文案常量改一个字符：`NO_ENGINE_PROBLEM` 里「翻译引擎」→「翻译引挚」 | `tests/shared/settings.test.ts`「那句话本身…」红（`toContain('没有可用引擎')` 不含"引擎"两字连写时红得最清楚；若只改一个字如「服务商档案」→「服务商挡案」，则 `toContain('服务商档案')` 红）。⚠ **必须知道**：只改常量时，所有**走常量**的界面断言（弹窗/设置页/后台）会**一起绿**——两边同源，这正是那条字面断言存在的理由 |
| **M4b** | 数字常量改一个字符：`CURRENT_VERSION` 5 → 6 | `tests/shared/settings.test.ts` 的 `expect(CURRENT_VERSION).toBe(5)` 红（且 `loadSettings` 的版本闸门会把 v5 数据当老数据处理，一批迁移用例跟着红） |
| **M5** | `profileHealthKey` 的前缀改掉（`const PROFILE_HEALTH_PREFIX = '';`） | `tests/options/engine-health.test.ts` 改写后的那条 → **牙④**红（`expected 'dup' to be 'p:dup'`）。⚠ **如实记账**：牙①②③**不会**红——读写两侧共用同一个函数，前缀换了键只是换个形状，行为上不可观察（这正是 `engine-health.ts` 说"退回裸 id 是一次没有收益的改动"的意思）。要演示牙①②③各自的杀手，用 M5b/M5c/M5d |
| **M5b** | `handleTestProfile` 交裸 id 而不是 `profileHealthKey(id)` 给 `runConnectionTest` | 同一条用例 **牙①**红（`storedHealth()[profileHealthKey('p:dup')]` 是 `undefined`） |
| **M5c** | `rowForKey` 拿键当 id 用：`return rowById(key);` | 同一条用例 **牙②**红（`dotOf` 抛"档案行没有状态点"，或点停在 `idle`） |
| **M5d** | `buildProfileRow` 按裸 id 读记录：`applyDot(dot, health[id])` | 同一条用例 **牙③**红（就地更新那一次仍绿，走完「保存」触发的整表重绘之后点回到 `idle`） |
| **M6** | **删掉后台的提前返回**（`if (engine === null \|\| problem !== undefined)` 整句删掉） | `tests/background/service-worker.test.ts` 新守卫红，**但红的形态与本计划起草时的预期不同、必须如实记下**：`engine` 是 `null` → `translateBatch` 抛 TypeError → catch 收成 `{ ok: false, code: 'UNKNOWN', message: … }`，于是 `toEqual` 的 `code` 那一格红（`expected 'UNKNOWN' to be 'AUTH'`）；**`calls` 仍然是 0**（没有引擎就没有任何地方会构造请求——这正是 §8.12 说的"按构造"）。**所以"删掉提前返回 → 后台真发请求"这个说法在删掉免费引擎之后不再成立**（规格 §10 变异表第 3 条在这一点上不准确） |
| **M6b** | 让 `resolveEngine` 的第 2 条规则**回落一个配置可用的引擎**：`return { engine: getEngine(OPENAI_COMPAT_ENGINE_ID), config: { apiKey: 'sk-x', baseUrl: 'https://api.example.com/v1', model: 'm' } };` | 同一条守卫**两条断言一起红**：`calls` 变成 1（`expected [ … ] to have a length of 0`）+ 响应形状不再是 `{ok:false,…}`。**这一条才是"零请求"那条断言的杀手**，M6 只杀掉形状那半 |
| **M7** | 迁移里把 `record.profiles` 直接交给 `firstUsableProfileId`（去掉形状投影） | `tests/shared/settings.test.ts`「engineId 是 google 但一个能用的档案都没有 → 空串」的**第三种形状**（没有 `profiles` 键）红成 `TypeError: Cannot read properties of undefined (reading 'find')` |
| **M8** | `insertDraftRow` 改回 `profilesList.prepend(row)` | `tests/options/engine-expansion.test.ts`「新增档案那一行也是就地追加」红（`expected <div…> to be null`） |

M1–M8 每次都要：改一处 → 跑**点名的那个测试文件** → 记录红形态 → **立刻 revert** → 复跑确认绿。
把每次的读数（含 M6 那处"预期与现实不一致"）写进提交说明。

### Step 18：Commit

```powershell
git status --porcelain -uall
git add -- src/engines/registry.ts src/shared/settings.ts src/options/engine-health.ts src/options/sections/engine.ts src/popup/popup.ts src/background/service-worker.ts tests/engines/registry.test.ts tests/shared/settings.test.ts tests/options/harness.ts tests/options/engine-health.test.ts tests/options/engine-expansion.test.ts tests/options/engine-models.test.ts tests/options/options.test.ts tests/popup/popup.test.ts tests/core/hash.test.ts tests/background/service-worker.test.ts
git add -- src/engines/google.ts tests/engines/google.test.ts
git commit -m 'feat(engines): 单元 E1——删掉 Google 免费接口：注册表只剩唯一适配器且 getEngine 返回 null 不再兜底（导出面缩小：engine-health 的 e: 键空间与 FREE_ENGINE_HEALTH_KEY / ENGINE_HEALTH_PREFIX 一并删除）、设置版本 4→5 且 engineId 默认空串、迁移落到第一个有 activeModel 的档案（firstUsableProfileId 一处判据、形状投影防生数据 TypeError）、resolveEngine 产出 NO_ENGINE_PROBLEM 且 engine 可为 null、设置页免费行与 test-free 与 e: 键空间消亡、弹窗下拉只列档案且空态隐藏整行、后台 engine===null 与 problem 合并收口；22 处 engineId 逐类处置、四条靠默认值跑通的缓存用例显式播种、新增无引擎零请求端到端守卫' -- src/engines/registry.ts src/shared/settings.ts src/options/engine-health.ts src/options/sections/engine.ts src/popup/popup.ts src/background/service-worker.ts src/engines/google.ts tests/engines/registry.test.ts tests/shared/settings.test.ts tests/options/harness.ts tests/options/engine-health.test.ts tests/options/engine-expansion.test.ts tests/options/engine-models.test.ts tests/options/options.test.ts tests/popup/popup.test.ts tests/core/hash.test.ts tests/background/service-worker.test.ts tests/engines/google.test.ts
git show --stat HEAD
```
提交前**逐路径**确认 `git diff -- <路径>` 里的改动都属于本 Task（尤其 `src/popup/popup.ts`：
`popup.html` 的改名改动**不在**这份 diff 里，因为它不在暂存路径上——**再核一次**）。

---

## Task T2：权限与文案（manifest / 内容脚本两条假话 / 注释定性）

**Files:**
- Modify: `src/manifest.json`（`host_permissions`、`description`）
- Modify: `tests/manifest.test.ts`（接口 + 正向 + **反向**两条守卫）
- Modify: `src/content/index.ts`（`describeError` 的 RATE_LIMIT 支、`sameCodeFailureMessage` 的 NETWORK 支）
- Modify: `tests/content/index.test.ts`（那条必红用例 + 网络文案夹具）
- Modify: `src/background/scheduler.ts`（**3 处**注释）
- Modify: `src/background/service-worker.ts`（**只**那两行 `supportsGlossary` 上方的注释定性）
- Modify: `src/core/hash.ts`（1 处注释——规格 §2 的范围清单里没有它，见下）
- Modify: `src/options/options.html`（隐私区块那句「免费引擎不需要额外授权」——规格 §6 没点名，见下）

**先决条件（不许跳过）**：本文「等待条件」里 T2 那条。`src/manifest.json` 与
`src/options/options.html` 都在另一个会话的在途清单里。

**为什么结束时一定绿**：`manifest.json` 与它的守卫**同一个提交**落地；`content/index.ts` 的两处文案
与那条断言**同一个提交**落地；其余四处**只改注释与一句静态文案**（`options.html` 那个 `<li>` 不参与
搜索索引——`tests/options/search.test.ts` 明写"隐私区块那一大段正文**不进索引**"，它只钉
`0 个 .lab` / `恰好 1 个 .sec-desc` / 含「API Key」与「档案」，这三条都不受影响）。

### Step 0：等待条件 + 开工检查

```powershell
git status --porcelain -uall
```
Expected: `src/manifest.json`、`src/popup/popup.html`、`src/options/options.html`、`src/options/options.css`
四行**都不再出现**（或已由改名会话提交）。出现 → **停手**，等。

### Step 1：`tests/manifest.test.ts`——先加守卫（先红）

**1a. 接口扩两格**：

```ts
interface Manifest {
  permissions?: unknown;
  action?: { default_popup?: unknown };
}
```
→
```ts
interface Manifest {
  permissions?: unknown;
  /** 默认主机权限：单元 E 起是**显式空数组**（`[]`），不是"这个键没了"。 */
  host_permissions?: unknown;
  /** 可选主机权限：自定义端点按需申请用，**一个字都不许动**。 */
  optional_host_permissions?: unknown;
  action?: { default_popup?: unknown };
}
```
**1b. 在该 describe 的收尾 `});` 之前追加两条**：

```ts
  /**
   * **安装/更新不请求任何站点访问权**这句用户可见承诺的**唯一**机器守卫。
   *
   * 牙在哪：谁把 `https://translate.googleapis.com/*`（或别的域名）加回默认主机权限，这条当场红。
   * 为什么断言 `[]` 而不是"键不存在"：显式空数组表达"我们查过这件事、结论是零权限"，
   * `toEqual([])` 同时把"不小心把键删了"钉在"这是一次遗漏"而不是"这是一次决定"上
   * （两者行为等价，但 diff 里看得见区别）。
   */
  it('默认不声明任何主机权限：安装与更新都不请求站点访问权', () => {
    expect(manifest().host_permissions).toEqual([]);
  });

  /**
   * 这条是**反向**约束（与上面「不许有 `tabs`」那条同一性质，理由也同一性质：
   * **改了也不会红**）。
   *
   * 清空 `host_permissions` 的人很容易顺手把 `optional_host_permissions` 也"一起清理干净"
   * ——那样自定义端点会**永远申请不到授权**（`shared/host-permission.ts` 申请的 origin
   * 不在可选清单里，Chrome 直接拒绝），而所有测试都是替身、**一条都不会红**：
   * 弹窗与设置页的授权断言在 `tests/helpers/chrome-stub.ts` 的 `grantedOrigins` 上，
   * 那个替身**不看 manifest**。真机上用户会看到设置页说"已授权访问"，而请求被浏览器拦下。
   */
  it('可选主机权限原样保留：自定义端点的授权链路一个字都不许动', () => {
    expect(manifest().optional_host_permissions).toEqual(['http://*/*', 'https://*/*']);
  });
```
Run: `npx vitest run tests/manifest.test.ts`
Expected: `Tests 1 failed | 4 passed (5)`——红的是新加的第一条
（`AssertionError: expected [ 'https://translate.googleapis.com/*' ] to deeply equal []`）。
**第二条此时是绿的**（它守的是一个还没被破坏的现状，这正是"反向约束"的常态）。

### Step 2：`src/manifest.json`

```json
  "description": "沉浸式网页翻译：默认只显示译文（可切换双语对照），支持免费引擎与自定义 OpenAI 兼容 API。",
  "permissions": ["storage", "contextMenus", "activeTab"],
  "host_permissions": ["https://translate.googleapis.com/*"],
  "optional_host_permissions": ["http://*/*", "https://*/*"],
```
→
```json
  "description": "沉浸式网页翻译：默认只显示译文（可切换双语对照），支持自建 OpenAI 兼容 API（DeepSeek / OpenAI / Ollama 等）。",
  "permissions": ["storage", "contextMenus", "activeTab"],
  "host_permissions": [],
  "optional_host_permissions": ["http://*/*", "https://*/*"],
```
（`host_permissions` 是**显式空数组**，不是删掉整个键：理由写在上面的守卫注释里。
`optional_host_permissions` **原样不动**——自定义端点仍按需在用户手势里按 origin 申请。
⚠ `name` / `default_title` 是改名会话改的，**不要碰**。）

Run: `npx vitest run tests/manifest.test.ts`
Expected: `Tests 5 passed (5)`。

### Step 3：`tests/content/index.test.ts`——先改断言（先红）

**3a. 那条必红用例**（锚点唯一）：

```ts
  it('全部条目网络失败时，toast 要指出「接口到不了」并指向设置页', async () => {
    // 这不是假想场景：默认的免费 Google 接口在很多网络下被完全阻断，
    // 表现就是整批 NETWORK 失败。只说"翻译失败"会让用户以为插件坏了，
    // 而真正该做的是去设置页换成自己能访问的接口（规格 §8「免费接口失效」）。
    mount('<p>First text</p><p>Second text</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(engineErrorReply('NETWORK', '免费接口请求失败：The operation was aborted'));

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(state.failed).toBe(2);
    const toastText = document.getElementById('jy-toast')?.shadowRoot?.textContent ?? '';
    expect(toastText).toContain('免费接口请求失败');
    // 必须给出可执行的下一步，而不是让用户对着"翻译失败"发呆。
    expect(toastText).toContain('到不了');
    expect(toastText).toContain('扩展设置');
    expect(toastText).toContain('自定义 API');
    // 网络错误是瞬时错误（RETRYABLE_CODES），逐段重试按钮要保留。
    for (const host of hosts()) expect(hasRetryButton(host)).toBe(true);
  });
```
→
```ts
  it('全部条目网络失败时，toast 要指出「接口到不了」并指向设置页', async () => {
    // 这不是假想场景：用户自己填的那个接口在某张网络下到不了，表现就是整批 NETWORK 失败。
    // 只说"翻译失败"会让用户以为插件坏了，而真正该做的两句是"说清原因 + 指路设置页"。
    // ⚠ 旧断言里那三个词换了：原文案的主语是"默认的免费 Google 接口"与"改用自定义 API"，
    // 那两件事随免费引擎一起删掉了（今天用户配的**就是**他自己的接口）。**不许**把它们
    // 换成"自定义接口"之类"看起来还在"的同义词——那句话描述的行为已经不是本插件的使用路径。
    mount('<p>First text</p><p>Second text</p>');
    const { worker, contentListener } = await loadContentScript();
    worker.mockImplementation(engineErrorReply('NETWORK', '接口请求失败：The operation was aborted'));

    const state = await dispatch(contentListener, MSG.TRANSLATE_PAGE);

    expect(state.failed).toBe(2);
    const toastText = document.getElementById('jy-toast')?.shadowRoot?.textContent ?? '';
    // 引擎给的那半句原样带出来（它是这轮最有信息量的部分）。
    expect(toastText).toContain('接口请求失败');
    // 承重的两个词：说清原因（到不了）+ 指路（扩展设置）。这两件事缺一个，用户就只能干瞪眼。
    expect(toastText).toContain('到不了');
    expect(toastText).toContain('扩展设置');
    // 反向：旧的"改用自定义 API"这条出路不再存在（它就是被删掉的那条路径）。
    expect(toastText).not.toContain('自定义 API');
    // 网络错误是瞬时错误（RETRYABLE_CODES），逐段重试按钮要保留。
    for (const host of hosts()) expect(hasRetryButton(host)).toBe(true);
  });
```
**3b. 优先级夹具的文案**（锚点唯一）：

```ts
  const NETWORK_MESSAGE = '免费接口请求失败：socket hang up';
```
→
```ts
  // ⚠ **只改前缀，必须留着 `socket hang up`**：下面三条用例用 `not.toContain('socket hang up')`
  // 证明"这条 toast 没被后到的 NETWORK 顶掉"。把整句换掉会让那三条**静默变成恒真式**。
  const NETWORK_MESSAGE = '接口请求失败：socket hang up';
```
Run: `npx vitest run tests/content/index.test.ts`
Expected: `Tests 1 failed | N passed`——红的是 3a 那条（`expected '…自定义 API。' not to contain '自定义 API'`，
因为实现还没改）。**若红的不是它，停下**：说明锚点或文案假设不对。

### Step 4：`src/content/index.ts` 两条假话

**4a. `describeError` 的 `RATE_LIMIT` 支**（锚点唯一）：

```ts
/** 页面级失败的文案（`ok: false`：设置读不出来这类"连请求都没发出去"的错）。 */
function describeError(response: { code: string; message: string }): string {
  if (response.code === 'AUTH') return response.message;
  if (response.code === 'RATE_LIMIT') return '免费接口限流，请稍后重试或改用自定义 API';
  return `翻译失败：${response.message}`;
}
```
→
```ts
/**
 * 页面级失败的文案（`ok: false`：设置读不出来这类"连请求都没发出去"的错）。
 *
 * `RATE_LIMIT` 曾经有一句罐头文案（「免费接口限流，请稍后重试或改用自定义 API」）：它**只为
 * 免费引擎写**，而删掉引擎之后剩下的**唯一**来源是 `openai-compat`（它给的是「接口限流，请稍后重试」），
 * 所以那句话 100% 是假的；更糟的是它**顶掉**了引擎自己更有信息量的那句——`response.message`
 * 本来就是引擎给的话。现在原样透传。
 *
 * **如实记账**：这一支今天**没有任何测试钉住**（全仓只有这里与 `README.md` 出现过那句话），
 * 改动不会有测试红。**不许**为此补一条"读起来像是守住了"的恒真断言——正确的守卫是
 * "没有可用引擎 ⇒ 零请求"与空态那几条，它们测的是行为，不是这句话。
 *
 * ⚠ `noticePriority`（哪种错更该先弹）**一个字都不动**：那条判的是优先级，与文案里提不提
 * 免费接口无关。
 */
function describeError(response: { code: string; message: string }): string {
  if (response.code === 'AUTH') return response.message;
  if (response.code === 'RATE_LIMIT') return response.message;
  return `翻译失败：${response.message}`;
}
```
**4b. `sameCodeFailureMessage` 的 `NETWORK` 支**（锚点唯一）：

```ts
  if (first.code === 'NETWORK') {
    // 整批网络失败几乎从不是"抖了一下"，而是这个接口根本到不了：默认的免费 Google 接口
    // 在很多网络下被完全阻断（连超时都不返回）。只说"翻译失败"会让用户以为插件坏了，
    // 而真正该做的是去设置页换一个自己能访问的接口。规格 §8「免费接口失效」要求的
    // 就是这条提示。
    return {
      code: first.code,
      message: `${message}。如果反复出现，说明当前网络到不了这个翻译接口——默认的免费 Google 接口在很多网络下无法访问，请在扩展设置里改用你能访问的自定义 API。`,
    };
  }
```
→
```ts
  if (first.code === 'NETWORK') {
    // 整批网络失败几乎从不是"抖了一下"，而是这个接口根本到不了（连超时都不返回）。
    // 只说"翻译失败"会让用户以为插件坏了。保留前半句的因果链，把"换一个接口"换成
    // "核对你自己填的地址"——今天用户配的**就是**他自己的接口，"默认的免费接口"这个主语
    // 已经不存在了。
    return {
      code: first.code,
      message: `${message}。如果反复出现，说明当前网络到不了这个翻译接口——请检查该档案的接口地址是否可达（在扩展设置里核对地址与网络）。`,
    };
  }
```
Run: `npx vitest run tests/content/index.test.ts`
Expected: 全绿（3a 那条转绿；`socket hang up` 的三条仍绿——它们与文案无关）。

### Step 5：四处注释 / 静态文案

**5a. `src/background/scheduler.ts` 三处**（⚠ 规格 §2 说"仅一处注释"，实际**三处**）：

1. `// signal 是 TranslateRequest 的必填字段，两个引擎都真的用了它（fetch 的 signal、`
   → `// signal 是 TranslateRequest 的必填字段，唯一的适配器真的用了它（fetch 的 signal、`
2. ` * 第 11 条抖一次就会实打实发出 24 条文本，免费接口的 429 还会把「抖动 → 整批重发 →`
   → ` * 第 11 条抖一次就会实打实发出 24 条文本，服务商的 429 还会把「抖动 → 整批重发 →`
3. `   * 而 Google 引擎不支持一次请求多条文本（一条文本一个请求），逐条发等于把免费额度`
   → 完整替换该段（锚点是这一段的三行）：

```ts
  /**
   * 同一批里**字面完全相同**的文本只翻一次。
   *
   * 真实网页里重复文本很常见：导航、「Read more」、表头、免责声明能占 20-40% 的段落数。
   * 而 Google 引擎不支持一次请求多条文本（一条文本一个请求），逐条发等于把免费额度
   * 白烧在重复段上——正文反而会因 429 失败。缓存 key 是按文本算的，所以重复文本只会
   * 一起命中或一起未命中，折叠不会改变任何一条的结果。
   */
```
→
```ts
  /**
   * 同一批里**字面完全相同**的文本只翻一次。
   *
   * 真实网页里重复文本很常见：导航、「Read more」、表头、免责声明能占 20-40% 的段落数。
   * 把它们折叠成一次请求，省的是服务商的额度与 token（同一个文本重复出现时，逐条发出去
   * 只会让账单变长，正文反而更容易撞上 429）。缓存 key 是按文本算的，所以重复文本只会
   * 一起命中或一起未命中，折叠不会改变任何一条的结果。
   */
```
**5b. `src/background/service-worker.ts` 那两行 `supportsGlossary` 上方的注释**（锚点唯一）：

```ts
      // 不支持 system prompt 的引擎传了也没用，反而会污染缓存 key。
      glossary: engine.supportsGlossary ? settings.glossary : undefined,
      systemPrompt: engine.supportsGlossary ? settings.systemPrompt : undefined,
```
→
```ts
      // 不支持 system prompt 的引擎传了也没用，反而会污染缓存 key。
      //
      // **如实记账**：删掉免费接口之后唯一的适配器恒 `supportsGlossary === true`，这两行
      // 今天**没有判别力**（弹窗里同一条分录与 `if (!engine.supportsGlossary …)` 分支同样
      // 恒不成立）。留着它们是**适配器契约**（第三种适配器可能不支持术语表/提示词，见
      // engines/types.ts 的 Translator），不是死代码。**不为它编断言**。
      glossary: engine.supportsGlossary ? settings.glossary : undefined,
      systemPrompt: engine.supportsGlossary ? settings.systemPrompt : undefined,
```
**5c. `src/core/hash.ts`**（规格 §2 的范围清单里**没有**这个文件——这是本计划新发现的落点）：

```ts
   * 今天两个引擎都还没真的读 `from`（Google 把 `sl=auto` 硬编码），所以这条还没有可观察
   * 的错；等接上就用错语义——key 必须在那之前就带上它。
```
→
```ts
   * 今天唯一的适配器还没真的读 `from`（`openai-compat` 从没用过 `request.from`），所以这条
   * 还没有可观察的错；等接上就用错语义——key 必须在那之前就带上它。
```
**5d. `src/options/options.html` 隐私区块**（规格 §6 的文案表里**没有**点名这一行——也是新发现）：

```html
              授权范围限定为那个地址的域名；免费引擎不需要额外授权。
```
→
```html
              授权范围限定为那个地址的域名；扩展本身不声明任何默认主机权限，安装与更新都不会
              请求站点访问权。
```
⚠ 三条约束：① 这一段**不进搜索索引**（`tests/options/search.test.ts` 明写），所以新增文字不会
影响搜索断言；② 不许给这个 `<li>` 加 `.lab` 类、也不许新增 `.sec-desc`（那两条是 search.test 的
形状护栏）；③ 保留「API Key」「档案」两个词在隐私区块里出现（同一文件别处有，不要顺手删）。

### Step 6：跑全量

Run: `npx vitest run` → Expected: 全绿（文件/用例按真实读数入账）。
Run: `npm run typecheck` → Expected: exit 0。

### Step 7：构建 + 产物核对

Run: `npm run build`
Expected: exit 0 + `✓ 产物校验全部通过（14 项）`；其中 `manifest.description` 那一行应当打印出新描述
（`verify-dist.mjs` 会检查它是合法 UTF-8 且含中文——新描述含中文，通过）。

再核对**产物**里的 `host_permissions`（规格 §8.4 要求"源与产物都要看"）：

```powershell
node -e "const m=require('./dist/manifest.json');console.log(JSON.stringify({host:m.host_permissions,optional:m.optional_host_permissions}))"
```
Expected: `{"host":[],"optional":["http://*/*","https://*/*"]}`。

### Step 8：变异验证（逐个 revert）

| # | 变异 | 期望红 |
| --- | --- | --- |
| **M1** | 把 `host_permissions` 改回 `["https://translate.googleapis.com/*"]` | `tests/manifest.test.ts`「默认不声明任何主机权限」红 |
| **M2** | 把 `optional_host_permissions` 整行删掉 | 同文件「可选主机权限原样保留」红（这就是那条**反向**守卫存在的全部理由：不写它，这个变异**一条测试都不会红**） |
| **M3** | 把 `description` 换成纯英文（如 `Immersive web page translator.`） | `npm run build` 非零退出：`verify-dist.mjs` 的 `manifest.description 含中文` 那条 fail（这条是**脚本**守卫，不是 vitest） |
| **M4** | 把 `describeError` 的 `RATE_LIMIT` 支改回罐头文案「免费接口限流…」 | **全绿**——如实记账：这一支今天没有任何测试钉住（规格 §6.2 已明写）。**不许**为它补恒真断言 |

### Step 9：Commit

```powershell
git status --porcelain -uall
git add -- src/manifest.json tests/manifest.test.ts src/content/index.ts tests/content/index.test.ts src/background/scheduler.ts src/background/service-worker.ts src/core/hash.ts src/options/options.html
git commit -m 'feat(manifest): 单元 E2——清空 host_permissions（安装与更新不再请求任何站点访问权）并改写 description，manifest 守卫补正反两条（默认零权限 + optional_host_permissions 一字不动）；内容脚本两条假话改掉（RATE_LIMIT 罐头文案整条删除改为透传引擎原话、NETWORK 的「改用自定义 API」改成核对自己的接口地址）；scheduler/hash/service-worker 三处过时注释定性、设置页隐私那句「免费引擎不需要额外授权」改写' -- src/manifest.json tests/manifest.test.ts src/content/index.ts tests/content/index.test.ts src/background/scheduler.ts src/background/service-worker.ts src/core/hash.ts src/options/options.html
```
⚠ 确认 `src/manifest.json` 的 diff 里**只有你自己那两行**（`description` 与 `host_permissions`）——
若 `name` / `default_title` 也出现在 diff 里，说明改名会话的改动还没提交，**停手**（等待条件未满足）。

---

## Task T3：README 与收口

**Files:**
- Modify: `README.md`
- Modify: 本文件（回填「落地读数表」）

**先决条件**：`README.md` 不再是 ` M`（改名会话已提交）；否则它的改名改动会与本 Task 混在同一个文件里。

**为什么结束时一定绿**：`README.md` 的内容**没有任何测试读取**（起草时复跑：`tests/**` 里 7 处
`README` 都是注释里的引用，没有一处 `readFileSync('README.md')`）；本 Task 的其余动作全是**只读
命令 + 回填本文件的读数表**。

### Step 1：README 逐行改写（文本锚点，不钉行号）

1. **首屏那条承诺（`:7` 附近）**：

```markdown
- 默认使用免费的 Google 翻译接口，装好即用，零配置。
```
→
```markdown
- **装完先配一个翻译引擎**：扩展**不预置任何引擎**，也没有内置接口——配一个自己的 OpenAI 兼容接口
  （DeepSeek / OpenAI / 本机 Ollama 都行），见「安装」后的**「快速开始」**。
  （早先那版自带"免费的 Google 翻译接口、装好即用"，**这个功能已经删掉了**：它不稳定、可能被限流，
  而且为了让扩展能访问它，安装时还得索要一个站点访问权限。）
```
2. **使用表的引擎那一格**：

```markdown
切换**翻译引擎**（免费接口或某个服务商档案，按名字直接切）
```
→
```markdown
切换**翻译引擎**（按档案名字直接切；还没配过档案时这一行不显示，提示区会指路设置页）
```
3. **引擎表第一行**（整行删除）：

```markdown
| **Google 免费接口**（默认） | 否 | 走 `translate.googleapis.com`，零配置可用 |
```
（表头 `| 引擎 | 需要 Key | 说明 |` 保留，表里只剩「**服务商档案**（OpenAI 兼容 API）｜是｜…」这一行。）
4. **下拉说明那一句**：

```markdown
「Google 免费接口 + 每个档案的名字」，选中即写入本机存储、立即生效。
```
→
```markdown
**每个档案的名字**（引擎不再有内置项），选中即写入本机存储、立即生效。
```
5. **「当前版本的真实限制」里那条整条删掉、并搬走与引擎无关的半条**：

```markdown
- **免费接口不稳定、可能被限流。** 它是非官方接口，没有 SLA；触发限流时页面会提示
  「免费接口限流，请稍后重试或改用自定义 API」，并给出重试按钮。免费接口也**不支持术语表**
  （`supportsGlossary: false`）。
- **限流时只退避、不降并发。** 设计文档 §8 原本还要求"429 时临时把该引擎并发降到 1"，
  **这一条没有实现**：现在的行为是每个批次各自按 500ms / 1500ms 退避重试，而整页翻译的
  3 路批次并发保持不变。所以一个大页面撞上限流时，后续批次仍会以 3 路继续送，直到各自失败。
  没有实现的原因是要在飞行中改并发池的上限，得动那个被大量测试钉住的并发契约，收益（少打
  几次请求）与风险不成比例。真撞上就先用弹窗切到自定义引擎，或分几次翻译长页面。
```
→
```markdown
- **撞上限流时只退避、不降并发。** 设计文档 §8 原本还要求"429 时临时把该引擎并发降到 1"，
  **这一条没有实现**：现在的行为是每个批次各自按 500ms / 1500ms 退避重试，而整页翻译的
  3 路批次并发保持不变。所以一个大页面撞上限流时，后续批次仍会以 3 路继续送，直到各自失败。
  没有实现的原因是要在飞行中改并发池的上限，得动那个被大量测试钉住的并发契约，收益（少打
  几次请求）与风险不成比例。真撞上就把页面分几次翻译，或换一个额度更宽的档案。
```
6. **升级说明那句**：

```markdown
  自定义接口的，名字取自当时选过的服务商；用免费接口的不会凭空长出档案。设置版本升到 v4。
```
→
```markdown
  自定义接口的，名字取自当时选过的服务商；用免费接口的老数据不会凭空长出档案。
  设置版本升到 **v5**：v4 里选着免费接口的，升级后自动切到**第一个配好模型的档案**；
  一个都没有就是"没有可用引擎"（弹窗与设置页都会说出那句话，并指路设置页）。
```
7. **删除当前档案那条**：

```markdown
  档案时，`engineId` 明确回落到免费接口并给出提示——不会留下一个指向不存在档案的悬空选择。
```
→
```markdown
  档案时，`engineId` 明确切到**剩下的档案里第一个配好模型的**；一个都没有就置空，并在设置页
  说清"现在没有可用的翻译引擎"——不会留下一个指向不存在档案的悬空选择。
```
8. **网络那一节的标题与首句**：

```markdown
### 翻译一直失败？先确认你的网络能不能到达接口

**默认的免费 Google 接口在很多网络下（例如中国大陆）被完全阻断**，表现为请求既不返回也不
报错、直到超时。这时插件不是坏了，而是那个接口根本到不了——页面会提示「如果反复出现，说明
当前网络到不了这个翻译接口」，并告诉你去设置页换一个。
```
→
```markdown
### 翻译一直失败？先确认你的网络能不能到达你填的那个接口

**你填的那个接口可能在某些网络下到不了**（例如需要代理才能访问的境外服务），表现为请求既不
返回也不报错、直到超时。这时插件不是坏了，而是那个地址根本到不了——页面会提示「如果反复出现，
说明当前网络到不了这个翻译接口」，并让你在设置页核对那个档案的接口地址。
```
（紧跟其后的 `curl.exe` 自查命令与"可用替代"清单**原样保留**——那一段今天就是指向自定义接口的。）
9. **目录结构那行**：

```markdown
  engines/               翻译引擎适配器（Google 免费接口 / OpenAI 兼容）
```
→
```markdown
  engines/               翻译引擎适配器（OpenAI 兼容；适配器接口 `Translator` 支持多种）
```
10. **隐私节那条权限说明**：

```markdown
- 页面权限按最小化申请：默认只声明免费引擎域名（`https://translate.googleapis.com/*`）；
  自定义端点走 `optional_host_permissions`，并且**只在你点设置页「保存」时**按你填的那个
  origin 申请（已经授权过就不再弹框）。没授权时翻译会明确告诉你「未授权访问该接口地址」，
  而不是把浏览器的拦截伪装成断网。
```
→
```markdown
- 页面权限按最小化申请：**不声明任何默认主机权限**（`host_permissions` 为空）——安装与更新
  都不会请求任何站点访问权（`chrome://extensions` 里这个扩展的「网站访问权限」是零项）。
  自定义端点走 `optional_host_permissions`，并且**只在你点设置页「保存」时**按你填的那个
  origin 申请（已经授权过就不再弹框）。没授权时翻译会明确告诉你「未授权访问该接口地址」，
  而不是把浏览器的拦截伪装成断网。
```
11. **隐私节的测试记录那条**：

```markdown
  留一条引擎测试记录（键 `jinyi:engine-health`：哪个档案/引擎、通没通、失败原因）。
```
→
```markdown
  留一条档案测试记录（键 `jinyi:engine-health`：哪个档案、通没通、失败原因）。
```
12. **「已知限制」里的状态点那条**（⚠ 规格 §6.3 没点名这一处，是本计划新发现的第二处「引擎 id」）：

```markdown
- **状态点只在本次浏览器会话内有效**：绿/灰/红记在 `chrome.storage.session`（键 `jinyi:engine-health`，
  内容只有引擎 id 与成败原因，不含 Key、不含页面内容）。浏览器关闭后记录清空，所有点回到灰
```
→
```markdown
- **状态点只在本次浏览器会话内有效**：绿/灰/红记在 `chrome.storage.session`（键 `jinyi:engine-health`，
  内容只有档案 id 与成败原因，不含 Key、不含页面内容）。浏览器关闭后记录清空，所有点回到灰
```
13. **「设置版本只向前」那一段**（⚠ 规格 §6.3 也没点名，是第三处把版本号当事实陈述的地方）：

```markdown
- **设置版本只向前（v3 → v4），降级不做**：v3 数据里每个档案的单个 `model` 在**读取时**被抬起成
  `models: [model]` + `activeModel: model`（空 / 缺失 → 空清单 + 空当前项），落盘发生在下一次写入
  （写回时版本号写成 4）。**降级方向没有兼容**：装了新版再回退到 v3 扩展时，旧代码的版本闸门会
  直接报错「设置版本 4 高于当前支持的 3，请更新扩展」——旧版是**明确读不出来**，而不是把模型
  显示成空。
```
→
```markdown
- **设置版本只向前（v3 → v4 → v5），降级不做**：
  - v3 → v4：每个档案的单个 `model` 在**读取时**被抬起成 `models: [model]` + `activeModel: model`
    （空 / 缺失 → 空清单 + 空当前项）；
  - v4 → v5：`engineId` 是免费接口的，改指向**第一个有当前模型的档案**（一个都没有就置空）；
  - 两者都发生在**读取时**，落盘要等用户下一次改动（写回时版本号写成当前版本）。
  **降级方向没有兼容**：装了新版再回退到旧版扩展时，旧代码的版本闸门会直接报错
  「设置版本 N 高于当前支持的 M，请更新扩展」——旧版是**明确读不出来**，而不是把模型显示成空。
```
14. **手动验收清单开头补一句**（清单标题是 `### 手动验收清单（需要真人在 Chrome 里操作）`，
    它的 `> 说明：…` 引文块之后）：

```markdown
> **先按上面的「快速开始」配好一个档案**（装完的初始状态是"没有可用引擎"，
> 不配档案的话第 1 条就会停在提示区那句话上）。
```

### Step 2：真的补一节「快速开始」（不许只留一个指向不存在章节的链接）

插在 `## 安装` 那一节**之后**、`## 使用` 之前（锚点用 `---\n\n## 使用\n` 之前的位置）：

```markdown
### 快速开始（装完先做这一步）

装上之后**插件没有任何可用引擎**——它不会替你选一个，也不会偷偷用一个内置接口。
第一次翻译之前先配一个自己的服务商档案（四步）：

1. **打开设置页**：点工具栏图标打开弹窗 → 点右上角的**齿轮**（也可以在 `chrome://extensions`
   里点这个扩展的「扩展程序选项」）。
2. **新增一个档案**：在「翻译引擎」区块点 **「+ 新增档案」**，填一个**名字**；在展开的面板里
   选一个「服务商模板」（DeepSeek / OpenAI / Ollama 本机），接口地址与模型名会自动填好
   ——也可以全部手填。
3. **填 Key、选定模型**：填 **API Key**（Ollama 这类本机服务不需要 Key）。「模型目录」里
   **至少要有一项是「当前」模型**：点「⟳ 获取可用模型」勾选后并入，或点「+ 添加模型」手填一个，
   再点「设为当前」。可以顺手点「测试连接」确认这条链路真的通。
4. **点「保存」并允许授权**：这一步会弹一次"允许访问 api.xxx.com"的授权框——**必须允许**，
   否则发往该地址的请求会被浏览器拦下（拒绝也不影响保存，之后再点一次「保存」即可补授权）。

回到弹窗，在「翻译引擎」下拉里**按名字选中**刚配好的那个档案，然后按 `Alt+T` 或点「翻译此页」。

> 一个档案都没配时，弹窗里**不会显示「翻译引擎」这一行**，提示区会说
> 「还没有可用的翻译引擎，去设置页添加一个服务商档案」——这就是首装的状态，不是坏了。
> 设置页顶部会显示同一句话，右侧就是「+ 新增档案」按钮。
```

### Step 3：五条命令全跑 + 取收口读数

```powershell
npx vitest run
npm run typecheck
npm run build
npm run verify:dist
npm run zip
Get-ChildItem *.zip | ForEach-Object { "$($_.Name) $($_.Length) $((Get-FileHash $_.FullName -Algorithm SHA256).Hash)" }
git grep -n -e "googleapis" -e "googleEngine" -e "DEFAULT_ENGINE_ID" -e "FREE_ENGINE_HEALTH_KEY" -e "ENGINE_HEALTH_PREFIX" -e "test-free" -e "data-engine-free" -- src tests
```
Expected:
- 三条命令 exit 0；`verify:dist` 全项通过；`zip` 成功；
- zip 的新字节数与 SHA256（**必然与基线 65643 / `048567C7…` 不同**）；
- `git grep` 在 `src/` + `tests/` 里**一处都不命中**（命中即为漏改；
  `git grep` 只查已跟踪文件，历史文档在 `docs/` 下，本条限定 `-- src tests` 正是为了排除它们）。

⚠ 收口的 zip/产物读数是在"工作树已含改名会话成果（或已提交）"之上取的——**在读数表里注明这一点**。

### Step 4：回填本文件的「落地读数表」

把 Step 3 的真实输出逐格填进文末那张表（**每格注明取数命令**），并把 T1/T2 各 Step 里记录到的
真实红形态与变异读数补进对应的变异表（**不许**把"计划里预写的期望值"当成实测值填进去）。

### Step 5：Commit

```powershell
git status --porcelain -uall
git add -- README.md docs/superpowers/plans/2026-09-20-remove-free-engine.md
git commit -m 'docs(readme): 单元 E3——README 全部相关行改写（收回「装好即用 / 零配置」承诺、删掉免费引擎那一行、升级与删除档案的回落口径、权限节改成零默认主机权限、引擎测试记录改主语、设置版本补 v5、状态点那处「引擎 id」改正），真的补一节「快速开始」，并回填本计划的落地读数表' -- README.md docs/superpowers/plans/2026-09-20-remove-free-engine.md
git show --stat HEAD
```

---

## 验收对照表（规格 §8 → 落点）

| 规格 §8 | 判据 | 落点 |
| --- | --- | --- |
| 1 | `npx vitest run` 全绿，文件/用例按真实读数入账 | T1 S15、T2 S6、T3 S3 |
| 2 | `npm run typecheck` exit 0 | T1 S15、T2 S6、T3 S3 |
| 3 | `npm run build` exit 0 + `verify:dist` 全项 + `npm run zip` 成功 | T1 S16、T2 S7、T3 S3 |
| 4 | `dist/manifest.json` 的 `host_permissions` 是 `[]`（源 + 产物） | 源：T2 S2 + S1 守卫；产物：T2 S7 |
| 5 | `CURRENT_VERSION === 5`；`DEFAULT_SETTINGS.engineId === ''` | T1 S3b/S3c（**字面**断言） |
| 6 | `ENGINES.map((e) => e.id)` 恰好 `['openai-compat']` | T1 S2 |
| 7 | `google.ts` / `google.test.ts` 不存在；七类符号全仓不再出现 | T1 S9（删除）+ T1 S15；收口：T3 S3 的 `git grep` |
| 8 | v4 用户（`engineId: 'google'`，第一个有 `activeModel` 的是 X）→ 读到 X；清空 X 的模型后再读 → 仍是 X | T1 S3i 的第 1、4 条 |
| 9 | v4 用户（全都没 `activeModel` / 没有档案）→ `''`，两处界面显示那句话 | T1 S3i 第 2 条 + T1 S5e-6（设置页）+ T1 S6e（弹窗）+ T1 S12e/S13e（实现） |
| 10 | 首装：`engineId === ''`、`profiles === []`、弹窗引擎那一行隐藏、提示区指路、**不写任何档案骨架** | T1 S3b（默认值）+ S6e（弹窗空态）+ S5e-6（设置页空态）；"读一次设置不产生写入"由 T3 S3 的 vitest 全绿与 S3i 幂等用例共同覆盖 |
| 11 | 无可用引擎：`{ ok: false, code: 'AUTH', message: NO_ENGINE_PROBLEM }` 且 `fetch` 0 次 | T1 S7d（端到端守卫）+ T1 S3f（单元层成对用例） |
| 12 | 翻译路径上没有别处构造引擎（`getEngine` 返回 `null`，`resolveEngine` 原样交出去） | T1 S9（`registry.ts`）+ T1 S10f（`resolveEngine`）+ T1 S14b（后台收口） |
| 13 | 那句话同时含「没有可用引擎」与「设置页」，两处界面逐字相同 | T1 S3d（常量**字面**断言）+ S6e（弹窗，走常量）+ S5e-6（设置页，走常量） |
| 14 | 删除当前档案后：有可用档案 → 切到它并说清；没有 → `''` + 那句话 | T1 S5e-4、S5e-5、S5e-6 |

---

## 非目标（明确不做）

- **不为 `#engine-field` 加新 id、不改 `src/popup/popup.html`**：弹窗那一行按结构取
  （`engineSelect.closest('.field')`）。理由见 `popup.ts` 里 `engineField` 的注释：那个文件
  是另一个在途会话正在改的，而且加 id 会连带改 `popup.test.ts` 的"HTML 里 id 的数量"守卫（13）。
  **若将来要加，必须把那个计数一起改，并在注释里说明。**
- **不改 `optional_host_permissions`**（`["http://*/*", "https://*/*"]` 原样保留）。
- **不动术语表机制**（`glossary` 字段、设置页区块、`buildCacheKey` 的 `glossaryHash`）。
- **不改历史规格 / 计划**（连"过时提示"都不加）。
- **不预置档案骨架、不做首启写入**；**不做"自动挑一个档案"**（除迁移那一次与删除当前档案那一次）。
- **不引入新的错误码**（`code: 'AUTH'` + 原文案）。
- **不动 `Translator` 接口的形状**（`supportsGlossary` / `needsKey` 都留着）、**不动缓存 key**。
- **不为 `supportsGlossary` 的恒真分支编断言**；**不为 `RATE_LIMIT` 罐头文案补恒真断言**。
- **不给 `needsKey === false` 另编一句新文案**（现存的唯一适配器恒 `true`，那一支读不到）。
- **不改 `scripts/verify-dist.mjs` / `scripts/zip-dist.mjs` / `tests/helpers/chrome-stub.ts` /
  `tests/helpers/css.ts`**（前两个是在途文件，后两个是"牙"不是"糖"）。
- **不碰**改名会话的 14 个在途路径（清单见「开工前检查」）。

---

## 落地读数表（**每格注明取数命令**；执行者回填）

| 读数 | 取数命令 | 起草时基线 | T1 后 | T2 后 | T3 收口后 |
| --- | --- | --- | --- | --- | --- |
| 测试文件数 / 用例数 | `npx vitest run` | 55 / 1061 | 待填 | 待填 | 待填 |
| 类型检查 | `npm run typecheck` | exit 0 | 待填 | 待填 | 待填 |
| 构建 + 产物校验 | `npm run build` | exit 0，`✓ 产物校验全部通过（14 项）` | 待填 | 待填 | 待填 |
| 产物清单 | `npm run build` 尾部清单 | 16 个文件，167.66 KB | 待填 | 待填 | 待填 |
| zip 字节 / SHA256 | `Get-ChildItem *.zip` + `Get-FileHash -Algorithm SHA256` | 65643 / `048567C7AA429E78E394727A5BC278EBD22E9F921764F3371D7299253AA015B2` | 待填 | 待填 | 待填 |
| 产物 `host_permissions` | `node -e "console.log(JSON.stringify(require('./dist/manifest.json').host_permissions))"` | `["https://translate.googleapis.com/*"]` | 待填 | 待填 | 待填 |
| 七类符号残留（`src` + `tests`） | `git grep -n -e googleapis -e googleEngine -e DEFAULT_ENGINE_ID -e FREE_ENGINE_HEALTH_KEY -e ENGINE_HEALTH_PREFIX -e test-free -e data-engine-free -- src tests` | 命中（多处） | 待填 | 待填 | 待填 |
| 22 处 `engineId: 'google'` | `git grep -n "engineId: 'google'" -- tests` | 22 处 | 0 | 0 | 0 |
| 变异汇总 | 见各 Task 的变异表 | — | 待填（含 M6 与预期不一致那处） | 待填 | 待填 |

⚠ 收口那一列的读数是在"工作树已含改名会话成果（或已提交）"之上取的，记录时注明。

---

## 自审记录

### A. 占位符扫描

`TBD` / `TODO` / `适当` / `类似 T1` / `等等` 一类含糊措辞在本计划的**实现要求**里一处都没有：
每个 Step 都给了可整段替换的完整片段（测试与实现的每一处改动都有 old → new 的完整文本）、
每条新断言都写了"牙在哪"与点名的杀手变异。**唯一保留的可选形状**有两处，都写明了"可以换、
判据不许换"：① T1 S4e 里脏 id 取 `'p:dup'`（可以换成别的"长得像键"的 id，但**三条行为牙与
一条形状牙必须都在**）；② T1 S5d / S6c 的夹具函数名 `seedWithProfile`（可换名）。

### B. 章节一致性核对

- 「已核实的前提 7」（类型变化不可拆）→ T1 是**一个**提交 → 验收表第 1/2/3 条的落点都是
  "每个 Task 结束跑全量" → 三者一致。
- 「开工前检查」的等待条件 → T2 Step 0、T3 先决条件 → 一致。
- T1 的 Files（17 个路径）与「文件结构」表逐行对应；T1 的**非目标**（不碰 `popup.html` /
  `manifest.json` / `options.html`）与 T2 的 Files 无交集 → 一致（并行不冲突）。
- 规格 §1.2 的五条裁决逐条落在：a → T2；b → T1 S3/S10f/S12e/S13e/S14b；c → T1 S13e + T2 S5b；
  d → T1 S4/Step 11；e → T1（不动 docs）+ T3（改 README）。
- 「不为 `supportsGlossary` 编断言」与全文没有任何一条为它新增断言 → 一致。

### C. 实测 vs 推断（逐条标注）

**实测（起草时跑过命令 / 读过文件，可复现）**：

1. `npx vitest run` → 55 files / 1061 passed，exit 0。
2. `npm run build` → exit 0，`✓ 产物校验全部通过（14 项）`，16 个文件 167.66 KB。
3. `jinyi-0.1.0.zip` → 65643 字节，SHA256 `048567C7…015B2`（`Get-FileHash`）。
4. `engineId: 'google'` 在 `tests/` 里恰好 22 处，逐文件分布与规格 §7.2 一致（grep 逐条列出）。
5. `src/manifest.json` 的 `host_permissions` 是 `["https://translate.googleapis.com/*"]`、
   `optional_host_permissions` 是 `["http://*/*","https://*/*"]`、`description` 里含「支持免费引擎」
   且**没有任何测试引用它**（grep）。
6. `tests/manifest.test.ts` 今天只钉 `permissions`（含"不含 `tabs`"）与 `action.default_popup`，
   **没有任何 host 权限断言**。
7. `tests/popup/popup.html` 里 `id` 的**数量是 13**，且 `tests/popup/popup.test.ts` 有一条
   `expect(parsed.querySelectorAll('[id]').length).toBe(13)`——**这是本计划"不加 `#engine-field`"
   那条裁决的实测依据**；同时确认 `src/popup/popup.html` 里**没有** `id="engine-field"`。
8. `src/popup/popup.css` 里 `.field[hidden] { display: none }` 存在（弹窗整行隐藏不需要新 CSS）。
9. `tests/options/options.test.ts:430–464`「保存档案按**该档案自己的 origin** 申请宿主权限；
   已授权过就不再弹框」**已经**是完整成对用例 → 规格 §7.3 第 5 条建议的替代写法会与之重复。
10. 全仓 grep：`免费接口限流` 只出现在 `src/content/index.ts` 与 `README.md`；`两个引擎`/`免费引擎`/
    `免费接口` 在 `src/` 的落点已逐条列出（含规格没点名的 `scheduler.ts:49/79/232`、
    `core/hash.ts:32`、`options.html:261`）。
11. `tests/options/engine-health.test.ts` 的「点它的「测试连接」…」里那半条"空 Key 落在脱敏门槛外"
    已由同文件「短 Key（<8 字符）不做脱敏」（用 `apiKey: shortKey`）覆盖 → 删除是安全的。
12. `tests/options/search.test.ts:94–126` 明写隐私区块正文**不进索引**，只钉 `0 个 .lab` /
    `恰好 1 个 .sec-desc` / 含「API Key」「档案」→ `options.html` 那处改写不受影响。
13. `tests/helpers/chrome-stub.ts` 的 `reset()` 会 `grantedOrigins.clear()` → 四条缓存用例光播种
    档案还不够，**必须同时授权 origin**（规格 §7.3 第 12 条没提这一点）。
14. `tsconfig.json` 与 `tsconfig.node.json` 都是 `noUnusedLocals: true` → 删掉消费者之后
    **必须一起删 import**（否则 typecheck 红）。导入 `@engines/registry` 的测试文件恰好 4 个，已逐个列出。
15. `tests/options/options.test.ts:548–570` 的现有断言包含 `not.toContain('使用中')`——新语义下
    必须反转（回落到的那个档案**就是**当前档案）。
16. `src/engines/google.ts` 的 `googleEngine.supportsGlossary === false`（所以今天弹窗那条分支
    是可达的，删掉引擎之后才恒不成立）。
17. `tests/options/engine-expansion.test.ts:118–146` 的三处 `[data-engine-free]` 读数删行后
    会变成 `null === null` / `toBe(null)` 的恒真式（逐行读过）。

**推断（未实测，落地时必须先取读数再动手）**：

18. **每一条"期望红形态"**（T1 S8、S15、T2 S1/S3、各变异表的红法）——都是按代码推演写下的，
    **必须由执行者复跑确认**，并把真实读数（含与预期不符之处）写进提交说明与读数表。
19. 「四条缓存用例在默认值改成 `''` 之后会一起红」：结论来自"它们不写设置 + 默认值是 `''` ⇒
   没有可用引擎 ⇒ 后台整条返回"，**没有真的把默认值改掉跑一遍**（那属于实现）。
20. 弹窗空态隐藏整行之后的**观感**（间距、提示区位置）纯推断——本机没有浏览器，
   这一条与规格 §9 第一条限制同源，只能靠用户肉眼验收。
21. 「`describeError` 的 `RATE_LIMIT` 改成 `return response.message` 之后内容脚本用例仍全绿」：
    已复核"没有任何测试钉住那句罐头文案"，但**没有跑过**——T2 S4 之后必须复跑确认。
22. 规格 §7.3 第 6 条那三条"牙"的杀手：本计划改成"写侧 / 就地更新 / 整表重绘"三条，
    并另加一条**形状**断言。这是推演 + 对 `applyExpansion`（它**不**重画列表）的代码核对结论，
    **M5b/M5c/M5d 三次独立运行是必须做的实证**（别只看"这条用例红了"）。
23. 规格 §7.2 第 ④ 类点名的用例与本计划实际改的两处不一致（规格点的是「打开设置页/展开档案/
    聚焦输入框都不发请求」，而那条**已经是** `'p-a'`；真正含字面量的两条是「取消草稿行」与
    「草稿保存成功后清掉草稿暂存」）——按 `grep` 结果入账，但**执行者应再核一次**。
