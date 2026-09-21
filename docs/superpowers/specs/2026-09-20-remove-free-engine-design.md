# 删掉 Google 免费接口（单元 E）设计规格

日期：2026-09-20 · 状态：已与用户确认方向 · 关联：`2026-09-18-multi-model-profiles-design.md`（档案列表与 `activeModel` 的来源）、`2026-09-18-options-page-redesign-design.md`（§9 单元 C，免费引擎行的落点）、`2026-09-14-immersive-translate-extension-design.md`（§3.1 引擎抽象与 §8 错误文案）

> **引用纪律**：本规格延续 `2026-09-20-apple-visual-style-design.md` §7 立下的规矩——定位代码
> 一律用**符号名、选择器或断言措辞**，**不钉行号**（行号会漂；控制器交办时给的行号已逐条复跑，
> 但它们只用于本轮核对，不进本文件的常驻引用）。**单元 A/B/C/D 的历史规格与计划不追溯**：
> 它们此刻仍如实记录着当时的世界，本单元只在下面这一行记账。

**记账**：免费接口已于本单元（E）移除。`docs/superpowers/specs/` 与 `docs/superpowers/plans/`
下所有把「Google 免费接口」当作现状的描述**保留原样**（那是历史，不是谎言）；面向用户的
`README.md` 必须改（见 §6.3）。

## 1. 需求与已拍定的决定

用户原话：**「你帮我把 google 免费接口直接删掉吧，我以后不会用」**。

这不是"把免费引擎藏起来"，而是**把这条路径从存储、注册表、界面、权限与文案里整体抹掉**：
删掉之后，一个没有配过任何服务商档案的用户，插件**没有任何可用引擎**——这不是需要被"兜底"
掉的尴尬状态，而是一个必须**如实、可行动、且零请求**地呈现给用户的状态。

### 1.1 已与用户拍定的两个决定

| 决定点 | 结论 |
| --- | --- |
| **迁移** | 存储里 `engineId === 'google'` 的 → **自动切到"第一个有当前模型（`activeModel` 非空）的档案"**；一个都没有就**置空** |
| **首装（没有任何档案）** | 弹窗给**空态引导**（大意「还没有配置翻译引擎 · 去设置页添加」，可点直达设置页）；**不预置任何档案骨架**——半填的档案绝不静默入库是本仓既有纪律（`pickProfile` 只收合法条目、`foldLegacyEngineConfig` 只折叠"当时真的在用"的那份配置，同一条纪律） |

### 1.2 控制器的裁决（写进本规格，不推翻）

| # | 裁决 | 本规格的落点 |
| --- | --- | --- |
| a | `src/manifest.json` 的 `host_permissions` **清空**；`optional_host_permissions` **不动**；并在 `tests/manifest.test.ts` 里把它钉住 | §4.4、§7.4 |
| b | 失效/未知 `engineId` 的新语义：**没有可用引擎 + 一句可行动的提示 + 零网络请求**；**不再有兜底到别的引擎**；文案的确切字面与**唯一出处**是 `resolveEngine` | §3.3、§5、§6.1 |
| c | `supportsGlossary` 与 service worker 那道门槛**保留为适配器契约**，如实记账"今日恒真、无判别力"，**不为它编断言** | §4.3 |
| d | `engine-health.ts` 的 `e:` 键空间随免费引擎一起消亡；`e:free` 那条用例**必须重写成一个仍然成立的不变式，不许退化成恒真式** | §4.5、§7.3 |
| e | 历史规格/计划**不追溯**，只记一句；README **必须改** | 本文件抬头、§6.3 |

### 1.3 一句话概括目标

**"没有可用引擎"必须是一个一等状态**：由 `resolveEngine` **一处**产出、由两个界面**如实显示**、
由后台**在发请求之前**拦住——而不是靠某个引擎继续兜底、把"用户没配"翻译成"照常发一次请求"。

## 2. 范围与非目标

**范围内（要改的实现）**：`src/engines/google.ts`、`src/engines/registry.ts`、
`src/shared/settings.ts`、`src/options/engine-health.ts`、`src/options/sections/engine.ts`、
`src/options/options.html`（只在需要时改说明文字）、`src/popup/popup.ts`、`src/popup/popup.html`、
`src/manifest.json`、`src/background/service-worker.ts`（注释 + 无引擎闸）、
`src/background/scheduler.ts`（仅一处注释）、`src/content/index.ts`（两条假话文案）。

**范围内的测试**：`tests/engines/registry.test.ts`、`tests/engines/google.test.ts`（删）、
`tests/shared/settings.test.ts`、`tests/options/*.test.ts`、`tests/popup/popup.test.ts`、
`tests/background/service-worker.test.ts`、`tests/core/hash.test.ts`、`tests/manifest.test.ts`、
`tests/options/harness.ts`（若夹具需要新入口）。

**非目标（明确不做）**：

- **不改 `optional_host_permissions`**（`["http://*/*", "https://*/*"]` 原样保留）：自定义端点
  仍按需在用户手势里申请，这条链路一个字都不动。
- **不动术语表机制本身**：`glossary` 字段、设置页术语表区块、`buildCacheKey` 里的 `glossaryHash`
  全部原样。删掉免费引擎后，术语表**从"对免费引擎不生效"变成"对唯一剩下的引擎生效"**——
  这是行为改善，不是改动项。
- **不改历史规格/计划**（连"过时提示"都不加）。
- **不预置档案骨架、不做首启写入**：首装时存储里就是 `profiles: []` + `engineId: ''`。
- **不做"自动挑一个档案"**：除迁移那一次（§3.2）与删除当前档案那一次（§5.3）之外，
  任何地方都不许替用户选档案（读取层替用户挑一个，就是"他没选，插件选了"）。
- **不引入新的错误码**：见 §3.3 的 `code` 选择。
- **不动 `Translator` 接口的形状**（`supportsGlossary` / `needsKey` 留着）；**不动缓存 key**。

## 3. 数据与迁移

### 3.1 版本与默认值

- `CURRENT_VERSION`：**4 → 5**。
- `DEFAULT_SETTINGS.engineId`：**`DEFAULT_ENGINE_ID`（今天的 `'google'`）→ `''`**。
  `''` 的语义从此是**"没有可用引擎"**，不再是"某个引擎的 id"。
  （`mergeSettings` 的 `engineId: pickString(input.engineId, DEFAULT_SETTINGS.engineId)` 因此
  在字段缺失时天然落到 `''`——缺字段与显式空串**同义**，这正是我们要的。）
- `Settings.engineId` 的文档注释必须重写：今天的注释明写「指向不存在的档案时解析回落免费引擎」，
  删掉引擎之后那就是假话（同 §4.2 里 `resolveEngine` 上方那段）。

### 3.2 v4 → v5 的确切规则

迁移**只做一件事**，加在 `migrate` 的既有分支链末尾（在 `liftProfileModels` 之后，
因为 `activeModel` 是它抬出来的）：

```
if (storedVersion < 5) record = dropFreeEngineSelection(record)

dropFreeEngineSelection(record):
  若 record.engineId !== 'google' → 原样返回
  否则 → { ...record, engineId: firstUsableProfileId(record.profiles) }
```

其中**新导出的一个纯函数**（`settings.ts`，与迁移、删除档案共用同一份判据）：

```ts
/** 第一个「有当前模型」的档案的 id；一个都没有时返回 ''（= 没有可用引擎）。 */
export function firstUsableProfileId(profiles: readonly EngineProfile[]): string {
  return profiles.find((profile) => profile.activeModel.trim().length > 0)?.id ?? '';
}
```

四条必须写下来的口径：

1. **只认 `'google'` 这个字面值**，不做"认不出来就重挑"的泛化：v5 迁移的输入是**声明的 v4
   数据**，那个版本里 `engineId` 的合法取值只有 `'google'` 与档案 id 两种形状，其他值（脏存储、
   手工改过）**不替用户猜**——它们在 §3.3 的新语义下表现为"没有可用引擎 + 一句可行动的提示"，
   这是安全的默认方向（不猜 = 不发请求）。
2. **`activeModel` 的判空口径与 `resolveEngine` 完全一致**：`trim()` 后为空即"没有当前模型"。
   两处各写一份口径必然漂移（先例就是 `resolveEngine` 里那条注释专门解释过为什么用 `trim()`）。
3. **顺序 = 数组顺序**（`pickProfiles` 已经保证它是存储顺序、且重复 id 只留第一个）。
   "第一个"就是用户在设置页看到的第一行，不是"最像默认的那个"。
4. **迁移产物里不留 `engineId: 'google'` 的任何痕迹**（与 `foldLegacyEngineConfig` 删
   `engineConfig` / `providerPreset`、`liftProfileModels` 删 `model` 同一条纪律）。

### 3.3 幂等性、失效 id 的新语义、以及"只读不写"

- **幂等（重复读不重复改）**：靠既有那道版本闸门——`migrate` 开头就是
  `if (storedVersion >= CURRENT_VERSION) return raw`。第一次读把存储里的 4 当成 4 处理，
  产物以 `CURRENT_VERSION`（5）交给 `mergeSettings`；`loadSettings` **不回写存储**，
  所以"读完再读"读到的是同一份 v4 原文，再次迁移得到同一结果（与 v1/v2/v3 三次迁移同一条口径；
  落盘要等用户下一次改动触发 `saveSettings` 的整份覆盖写）。
- **失效/未知 `engineId` 的新语义**（这是本单元最核心的一条语义变更）：

  > `engineId` 不指向任何现存档案 ⇒ **没有可用引擎**：没有引擎、没有配置、一句可行动的话、
  > **零网络请求**。**没有"兜底到某个别的引擎"这回事。**

  这条语义**只在 `resolveEngine` 一处实现**（它是全仓"engineId 怎么解释"的唯一出处，
  service worker / 弹窗 / 设置页都走它）。**不许**在弹窗或后台再写一个
  `if (settings.engineId === '')`——那就是第二个解析点，下次加引擎一定有一处漏掉。
- **`'google'` 作为残留字面值**：v5 之后正常情况下存储里不该再有它（迁移已改写），但脏存储、
  另一个上下文写的旧值仍可达。它**不是特例**：它只是"不指向任何档案的 id"的一个取值，
  和 `'已删掉的'` 走同一条路（没有可用引擎）。**不写"若 engineId === 'google' 则…"的补丁**。
- **`'openai-compat'` 这条老路也必须失效**：今天 `resolveEngine({engineId: 'openai-compat',
  profiles: []})` 会命中 `getEngine('openai-compat')` 并返回那个引擎（`tests/shared/settings.test.ts`
  有一条用例钉着它："裸 openai-compat（没配任何档案）→ 引擎自己给出可行动的 AUTH 提示"）。
  v5 之后**不再可能**：`engineId` 只认档案 id，裸引擎 id 一律走"没有可用引擎"。
  那条用例要按新语义改写（见 §7.2）。

## 4. 引擎注册表与解析的新形状

### 4.1 删掉的东西

- **`src/engines/google.ts` 整份删除**（`googleEngine`、`parseGoogleResponse`、`toGoogleLang`、
  `ENDPOINT`、条目级重试与它的 `MAX_CONCURRENCY`）。这三个导出**没有别处的消费者**
  （复跑核实：`src/` 里只有 `registry.ts` 引用 `./google`；`toGoogleLang` / `parseGoogleResponse`
  只出现在 `tests/engines/google.test.ts` 与历史计划文档里）。
- **`tests/engines/google.test.ts` 整份删除**（162 行）。它守的是
  `[[[译文, 原文, …], …], null, 源语言, …]` 这个响应形状、`zh-Hans → zh-CN` 的映射、
  429/AUTH/413 的分支、条目级重试只吸收 `NETWORK` 这几件事——**这些行为随文件一起消失**，
  断言没有"改成别的"的余地。
- **`DEFAULT_ENGINE_ID` 整个常量删除**（不是改值）。它今天在
  `src/options/sections/engine.ts`、`src/popup/popup.ts`、`src/shared/settings.ts` 与六个测试文件里
  共 20 余处被引用；**逐处处置**，不做批量替换（§7.2 给了逐类口径与理由）。
  留着它（哪怕指向 `'openai-compat'`）就是留了一个"默认引擎"的概念，而本单元要建立的恰恰是
  **"没有默认引擎"**。
- **`ENGINES` 变成只含一个成员**：`[openAiCompatEngine]`。**保留这个数组与 `getEngine`**——
  它们仍是"注册表"的形状，将来加第二种适配器时不用重新发明。
- `src/engines/types.ts` **一个字都不改**（`needsKey` 与 `supportsGlossary` 都留着，见 §4.3）。

### 4.2 `getEngine` 的新签名与语义：**不许有静默兜底**

```ts
/** 按适配器 id 取引擎；没有这个 id 时返回 null（**不再回落到任何引擎**）。 */
export function getEngine(id: string): Translator | null {
  return ENGINES.find((engine) => engine.id === id) ?? null;
}
```

- **返回 `null` 而不是抛错**：调用点只有 `resolveEngine` 一处（核实的全部引用），而
  `resolveEngine` 的契约是"**返回值**而不是抛错"（它今天就已经为"不能用来翻译"这件事返回
  `problem` 而不是抛——弹窗在**同步渲染函数**里调它，抛错会把提示区变成异常路径）。
  让 `getEngine` 抛错等于把那条已经想清楚的取舍反过来。
- **今天的兜底注释必须一起改**：`registry.ts` 里那句
  「未知 id 一律回退到默认引擎，避免设置里存了废弃 id 时整个插件不可用」是本单元要**推翻**的
  设计判断——废弃 id 的正确答案不是"照样能翻"，而是"说清没有可用引擎，且一个请求都不发"。
  注释要如实改写成新理由，别留一句与代码相反的话。
- **`OPENAI_COMPAT_ENGINE_ID` 保留**：它仍是"v2 → v3 折叠判据"与 `resolveEngine` 的引用点
  （避免 `'openai-compat'` 字面量多处各写一份）。
- **`resolveEngine` 的新形状**：`ResolvedEngine.engine` 变成 `Translator | null`，
  并新增一个与 `NO_MODEL_PROBLEM` 同级的常量（**唯一来源**，见 §6.1）：

```ts
export interface ResolvedEngine {
  /** `null` = 没有可用引擎（`engineId` 不指向任何现存档案）。此时 `problem` 必定有值。 */
  engine: Translator | null;
  config: EngineConfig;
  problem?: string;
}
```

解析规则收敛成三条（`resolveEngine` 上方的长注释整段重写，今天那段明写
「'google' 即免费引擎；未知 id 回落免费引擎」「失效 engineId 因此照常可用，只是安静地用免费接口」
——删掉之后**整段都是假话**）：

1. `engineId` 命中某个档案 → `{ engine: getEngine(OPENAI_COMPAT_ENGINE_ID), config: {
   apiKey, baseUrl, model: activeModel } }`；`activeModel` 空白时**额外**给
   `problem = NO_MODEL_PROBLEM`（今天的第 1 条规则，原样保留）。
2. `engineId` 不命中任何档案 → `{ engine: null, config: {}, problem: NO_ENGINE_PROBLEM }`。
   **这是"没有可用引擎"的唯一产出点。**
3. 其余（命中档案且模型齐全）→ 无 `problem`。

### 4.3 `supportsGlossary` 与后台那道门槛：保留契约，如实记账

- `Translator.supportsGlossary` **保留**；`service-worker.ts` 里
  `glossary: engine.supportsGlossary ? settings.glossary : undefined` 与
  `systemPrompt: engine.supportsGlossary ? ... : undefined` 两行**保留**。
- **如实记账（写进注释，不写成"以后会用到"的空头承诺）**：删掉免费引擎后**唯一的适配器恒为
  `true`**，这两行今天**没有判别力**；弹窗里同一条分录（"当前引擎不支持术语表"）与
  `if (!engine.supportsGlossary && settings.glossary.length > 0)` 分支同样**恒不成立**。
  它们留着是**适配器契约**（第三种适配器可能不支持术语表/提示词），不是死代码。
- **不为它编断言**：不给"恒真分支"写一条"测了等于没测"的用例（本仓既有纪律：不为读不到的
  东西编断言，先例见 `engine.ts` 里 `editorDrafts.delete` 那两行的说明）。
- 顺带把两处注释里"现存两个引擎的 supportsGlossary 都是 true"改成如实的"现存唯一适配器恒为
  true，无判别力"——**只改注释的定性，不改代码**。

### 4.4 `manifest.json`

| 字段 | 今天 | 新值 | 理由 |
| --- | --- | --- | --- |
| `host_permissions` | `["https://translate.googleapis.com/*"]` | **`[]`** | 这条声明**只为免费接口存在**（复跑核实：`translate.googleapis.com` 在 `src/` 里只出现在 `google.ts` 的 `ENDPOINT` 与这条 manifest 里）。清空之后**安装/更新不再请求任何主机权限**——这本身就是一条面向用户的隐私改善，值得写进 README（§6.3） |
| `optional_host_permissions` | `["http://*/*", "https://*/*"]` | **原样不动** | 自定义端点仍按需在用户手势里按 origin 申请（`shared/host-permission.ts` 那条链路一个字都不改） |
| `description` | 「…支持免费引擎与自定义 OpenAI 兼容 API。」 | 「沉浸式网页翻译：默认只显示译文（可切换双语对照），支持自建 OpenAI 兼容 API（DeepSeek / OpenAI / Ollama 等）。」 | 旧描述里"支持免费引擎"随本单元变成假话；这条字符串**没有任何测试守着**（复跑核实），所以必须靠本规格点名改，否则会静默留着 |

**`[]` 而不是删掉整个键**：显式空数组表达"我们查过这件事、结论是零权限"，而且
`tests/manifest.test.ts` 的新断言可以直接钉 `toEqual([])`（键缺失时读到 `undefined`，
`toEqual([])` 会把"不小心把键删了"和"清空了"混为一谈——虽然两者行为等价，但显式空数组让
"这是决定"与"这是遗漏"在 diff 里看得见）。

### 4.5 `engine-health.ts`：`e:` 键空间随免费引擎一起消亡

删掉的东西（**导出面缩小**，属模块公开契约的变化，提交信息里要记一句）：

- `ENGINE_HEALTH_PREFIX`（`'e:'`）常量；
- `FREE_ENGINE_HEALTH_KEY`（= `` `${ENGINE_HEALTH_PREFIX}free` ``）常量——它**按构造**不再有对象；
- `sections/engine.ts` 的 `rowForKey` 里"`key === FREE_ENGINE_HEALTH_KEY` → 免费引擎那一行"
  那个分支（连同它引用的 `[data-engine-free]` 选择器）。

**不动的**：`PROFILE_HEALTH_PREFIX` / `profileHealthKey` / `profileIdFromHealthKey` /
`loadEngineHealth` / `saveEngineHealth` / `forgetEngineHealth` / `redactSecret` / `pickHealth`
（读侧**仍然键无关**，这是它自己的规矩，与键空间是两件事）。

**模块顶部那段长注释要重写而不是删掉**，因为它今天论证的是"**两个**键空间为什么必须分开"
（`档案 id 由存储层从任意非空字符串读回，谁都能造出一个恰好等于引擎键的 id`）。
删掉引擎键之后，那半条威胁**自动消失**（只剩一个键空间，没有"另一个键"可撞），
但注释里**仍然成立**的三件事必须留住：

1. 为什么 `p:` 前缀**留着**（而不是退回裸 id）：`e:` 没了不等于"前缀没用"了——
   `profileIdFromHealthKey` 的往返、老键的认领口径（见下）、以及"将来可能又有第二类记录"
   都靠它把"记录键"与"档案 id"两个概念分开。**退回裸 id 是一次没有收益的改动**。
2. 老键的口径照旧：`p:` 形状的老键会被 **id 恰好等于后半段** 的档案行认领，
   `p:` 之外的老裸键（`google`、`p-a`…）**读不到任何一行**——**不写迁移代码**这个决定
   今天仍然成立（session 区域、浏览器一关就没了）。
3. 那条"记忆化依赖同一个 `chrome.storage.session` 对象"的**未实测假设**与跨上下文的队列边界
   一字不动（它们与键空间无关）。

**`engine-health.ts` 顶部那句"每个引擎/档案'最近一次测试连接'的结果"也要改**：
"引擎"这个主语今天只剩档案一种，写成"每个档案"即可（**这不是文案洁癖**：这句话是这套键空间
存在理由的陈述，留着"引擎"会让人以为还有引擎记录要处理）。

**那条 `e:free` 用例的处置**（控制器点名）：它守的"前缀不同 ⇒ 两类键永不相等"随
`e:` 一起失去对象，**必须改写成一个仍然成立的不变式**（"记录键由前缀加出来、点由记录键解回来"），
**绝不许**让它退化成恒真式。完整口径见 §7.3 第 6 条（那里逐条写了三条断言的"牙在哪"）。

## 5. UI 行为

### 5.1 设置页：免费引擎那一行整行消失

- `buildFreeEngineRow` 整函数删除；`renderProfiles` 不再追加它；
  `insertDraftRow` 里"草稿行排在免费引擎行之前"的逻辑退化成普通追加（`free.before(row)` 那一支删掉）。
- `rowForKey` 的引擎分支（`if (key === FREE_ENGINE_HEALTH_KEY)`）删除，函数只剩
  "`profileIdFromHealthKey` 解出 id → `rowById`"一条路（详见 §4.5）。
- `test-free` 动作的三处（按钮上的 `dataset.action`、事件委托里的分支、`handleTestFreeEngine`）
  一并删除——**不是改写成"测某个档案"**：那个动作的语义就是"测内置引擎"，
  档案的测试连接已经有 `test-profile` 这条完整的路。
- **状态行（`#engine-status`）与顶部说明（`#engine-hint`）都要跟着新语义走**：

  - `renderEngineHint` 今天只有两支（"当前在用档案 X" / "当前在用免费接口（零配置）"），
    第二支**必须消失**。新形状：

    | 情形 | `#engine-hint` |
    | --- | --- |
    | `resolveEngine` 命中档案 | 「当前在用档案「X」。点这一行右侧的「编辑」展开；在弹窗的「翻译引擎」里按名字切换。」（原样保留） |
    | `engine === null`（含首装） | **`NO_ENGINE_PROBLEM`**（§6.1 的唯一来源那句话，原样显示） |

  - `#engine-status` 只在**删除当前档案且无处可回**时多一句可行动的提示（§5.3）。
- **空态引导**：`#engine-hint` 的那句话 + 页面上现成的「+ 新增档案」按钮就是设置页的空态。
  **不新增空态 DOM、不预置草稿行**（预置草稿行 = 预置了半个档案骨架，`§2 非目标`里明令禁止）。

### 5.2 弹窗：空态引导与提示区

复跑实测的**现状**（这是新空态要接的地方，务必按实测而不是按想象）：

- 没有任何档案时，`engineOptions()` 仍会额外产出 `{ value: 'google', label: 'Google 免费接口' }`，
  所以今天下拉里**恰好有一项**、并且被选中（`fillSelect(..., settings.engineId)` 的 value 是
  `'google'`）——也就是**"下拉看起来正常、点开只有一项、那一项马上要被删掉"**。
- 提示区今天说「**零配置可用，无需 API Key。**」。
- 后台在 `engineId: ''` + 无档案时**真的发了一次 Google 请求**（复跑实测，见 §3.3/§8.2）：
  当前"没有档案"这条路是**静默可用的**，这正是本单元要拆掉的东西。

新行为：

| 元素 | 新行为 |
| --- | --- |
| `#engine`（下拉） | `engineOptions` **只列档案**（`profiles.map(...)`），不再有内置项 |
| `#engine-field`（那一整行） | 档案数为 0 时 **`hidden = true`**（复用既有的 `.field[hidden] { display: none }`，与 `#model-field` 同一套机制，**不新增 CSS**）；≥1 时显示 |
| `#engine-hint` | `resolveEngine` 命中 → 保留今天那几支（缺 Key / `problem` / 未授权 / 「已配置你自己的 API Key。」）；**`engine === null` 时显示 §6.1 的弹窗那句话**，并加 `warn` 类 |
| `#model-field` / `#model` | 不动（`renderModelSelect` 本来就在找不到档案时隐藏整行，档案数为 0 与它无关） |
| 主按钮 | **不动**：没有引擎时按钮照常可点，按下去得到那句可行动的错误（不把"没配引擎"变成"按钮不可点"——用户会以为插件坏了；这与 `FALLBACK_TEXT` 里三种"页面不可用"的语义是两件事） |

**弹窗的"可点直达设置页"**：不需要新 DOM——弹窗右上角的齿轮（`#open-options`）已经是
"打开设置页"的入口，提示区那句里直呼「设置页」即可（今天的未授权提示就是这么做的）。

### 5.3 删除当前在用的档案：新的回落逻辑

今天的回落是"落到免费接口"（`{ profiles: remaining, engineId: wasCurrent ? DEFAULT_ENGINE_ID : latest.engineId }`），
注释里还给了理由。删掉引擎之后，回落规则换成：

```
wasCurrent ? firstUsableProfileId(remaining) : latest.engineId
```

也就是**与迁移同一条判据、同一个函数**（§3.2 的 `firstUsableProfileId`）：
**落到"剩下的档案里第一个有当前模型的"，一个都没有就落到 `''`。**

- 旧理由（"下一个档案可能没填 Key、地址可能没授权，删一个档案不该让用户突然翻译失败"）
  **不再成立、也不再需要**：v4 之后每个档案都有"当前模型"这个明确信号，
  `firstUsableProfileId` 挑的就是**用户真的配好过的那一个**；而"没配好"的档案不再是
  "会静默失败"，而是 §3.3 那句可行动的话。
  → 这条裁决**站得住**（挑的是有 `activeModel` 的档案，不是"数组里下一个"）。
- 状态行两句话（新增第二句，第一句原样保留）：

  | 情形 | `#engine-status` |
  | --- | --- |
  | 删的是当前档案，且回落到了某个档案 | 「已删除当前在用的档案「X」，引擎已切换到「Y」，请在弹窗里重新选择。」 |
  | 删的是当前档案，且已无可用引擎 | 「已删除当前在用的档案「X」，现在没有可用的翻译引擎」+「，去设置页添加一个服务商档案。」 |
  | 删的不是当前档案 | 「已删除档案「X」。」（原样） |

  （两张表里的两句都以 `NO_ENGINE_PROBLEM` 的措辞为准，见 §6.1；实现时以常量拼接，不各写一份字面量。）

### 5.4 弹窗与设置页的失效 id：用户看得见的那一面

今天（复跑实测）：`engineId` 指向一个不存在的档案时，设置页顶部写
**「当前在用免费接口（零配置）…」**——一句在删掉引擎之后**彻底不成立**的话，
而且它今天就在**误导**（用户以为自己没配任何东西却"在用免费接口"）。
新语义下这条分支由 §5.1 的 `engine === null` 那一行接管。

## 6. 用户可见文案

### 6.1 "没有可用引擎"那句话：唯一来源 `resolveEngine`

```ts
/**
 * 「没有可用引擎」那句话的**唯一来源**（与 NO_MODEL_PROBLEM 同级）。
 * 弹窗、设置页、后台各写一份必然漂移（先例见 isAllowedBaseUrl）。
 */
export const NO_ENGINE_PROBLEM = '还没有可用的翻译引擎，去设置页添加一个服务商档案';
```

| 位置 | 由谁产生 | 确切字面 |
| --- | --- | --- |
| **弹窗提示区**（`#engine-hint`） | `resolveEngine` 的 `problem`（`popup.ts` 只负责显示） | `NO_ENGINE_PROBLEM` + 「。点右上角齿轮打开设置页。」→ 合起来：**「还没有可用的翻译引擎，去设置页添加一个服务商档案。点右上角齿轮打开设置页。」** |
| **设置页顶部说明**（`#engine-hint`） | 同上（`engine.ts` 只负责显示） | `NO_ENGINE_PROBLEM` 原样 → **「还没有可用的翻译引擎，去设置页添加一个服务商档案」** |
| **设置页状态行**（`#engine-status`，删除当前档案那一支） | §5.3 | **「已删除当前在用的档案「X」，现在没有可用的翻译引擎，去设置页添加一个服务商档案。」** |
| **后台返回给内容脚本**（`ok: false`） | `resolveEngine` 的 `problem` 原样当 `message`；`code` 用 `'AUTH'` | `NO_ENGINE_PROBLEM` 原样 |

> ⚠ **表里那一串字是"契约字面"，不是"若干关键词的集合"**：任何断言都不许写成"必须含某个我脑子里
> 概括出来的短语"——例如「没有可用引擎」**不在这个字面里**（`没有可用` 与 `翻译引擎` 之间隔着「的」，
> 实测该子串不存在）。分工是：**字面**由 `settings.test.ts` 的**独立一条 `toBe`** 钉住；
> **界面**断言比对常量；**词级**断言只取确实存在的四条词（`没有可用` / `翻译引擎` / `设置页` /
> `服务商档案`）——详见 §7.3 第 18 条。

**为什么 `code` 用 `'AUTH'` 而不是新造一个码**：内容脚本的 `describeError` 对 `AUTH` 是
**原样透传 message**（不走任何罐头文案），`sameCodeFailureMessage` 对 `AUTH` 只追加一句
「（在扩展设置里填好 API Key 后重新翻译此页）」——即"去设置页"的同义补充，方向正确；
而 `AUTH` **不在 `RETRYABLE_CODES` 里**，所以**不会**给用户挂一排点了必然失败的重试按钮。
新造一个错误码要同时改 `EngineErrorCode`、内容脚本的优先级表、重试判据与三处测试，
收益（一句更精确的分类）与代价不成比例。

**如实记账一处不完美**：`AUTH` 这条路上内容脚本会追加的那半句说的是"填好 **API Key**"，
而"没有可用引擎"要用户做的是"**添加一个档案**"（其中才包含填 Key）。两句拼起来读得通
（都要去设置页），但第一个动作名字对不上。**本轮不改内容脚本那条 AUTH 追加逻辑**——
它在唯一剩下的引擎上仍然是准确的（缺 Key 就是 AUTH 的第一大来源），
为它加一条"看 message 里有没有某个词"的分支属于拿文案互相嗅探，比不完美更糟。

**首装时两个地方的措辞差异是刻意的**：设置页那句话就是"去做这件事"，弹窗那句多一个"去哪做"，
因为弹窗里没有"新增档案"按钮，只有齿轮。**两处的核心句必须逐字相同**（都由常量拼接），
否则就是两句话了。

### 6.2 `src/content/index.ts` 的两条假话

| 位置 | 今天 | 问题 | 新文案 |
| --- | --- | --- | --- |
| `describeError` 的 `RATE_LIMIT` 支 | 「免费接口限流，请稍后重试或改用自定义 API」 | 这句话**只为免费引擎写**，但 `RATE_LIMIT` 今天也由 `openai-compat` 抛出（它的文案是「接口限流，请稍后重试」）。删掉引擎后剩下的**唯一**来源是 `openai-compat`，所以这句话 100% 是假的；而且它**顶掉**了引擎自己更有信息量的那句（`describeError` 拿到的 `response.message` 本来就是引擎给的话） | **这一支整条删掉**。`describeError` 剩下的 `return 翻译失败：${response.message}` 会让 RATE_LIMIT 显示成「翻译失败：接口限流，请稍后重试」——**但那多出的"翻译失败："前缀会吞掉可行动项的语气**，所以取更好的一支：**该支改成 `return response.message`**（其余分支不动）。于是用户看到的就是引擎给的那句「接口限流，请稍后重试」 |
| `sameCodeFailureMessage` 的 `NETWORK` 支 | 「……如果反复出现，说明当前网络到不了这个翻译接口——**默认的免费 Google 接口在很多网络下无法访问**，请在扩展设置里改用你能访问的自定义 API。」 | 后半句是**只对免费引擎成立的因果解释**；删掉引擎后用户配的**就是他自己的**接口，"默认的免费接口"这个主语不存在了 | 「……如果反复出现，说明当前网络到不了这个翻译接口——请检查该档案的接口地址是否可达（在扩展设置里核对地址与网络）。」（保留前半句的因果链，把"换引擎"换成"核对你自己填的地址"） |

**注意 `RATE_LIMIT` 的优先级表（`noticePriority`）不动**：那条判的是"哪种错更该先弹"，
与文案里提不提免费接口无关。

**这两条文案的既有测试（复跑核实，都是"必改"而不是"随便改"）**：

- `tests/content/index.test.ts` 有一条「全部条目网络失败时，toast 要指出「接口到不了」并指向设置页」，
  它**逐条断言**了那句 toast 含「到不了」「扩展设置」**「自定义 API」**，并在注释里点名
  "默认的免费 Google 接口在很多网络下被完全阻断"。§6.2 的新文案里**没有**「自定义 API」这个词，
  **这条断言必然红**——不是意外，正是"旧文案在测试里被钉住"的证据。处置：把断言换成新文案里
  真正承重的两个词（「到不了」+「扩展设置」，即"说清原因 + 指路"这两件事），
  并**连同注释与那条用例里 `engineErrorReply('NETWORK', '免费接口请求失败：…')` 的夹具文本**
  一起改（夹具那句话现在是引擎在免费接口下的口吻，删掉引擎后没有生产代码会产生它）。
  **不许**把「自定义 API」换成「自定义接口」之类"看起来还在"的同义词来让这条继续绿——
  那句话描述的行为（改用自定义 API）已经不是这个插件的使用路径了。
- 反过来，**`describeError` 的 `RATE_LIMIT` 罐头文案在测试里一处都没有被钉住**
  （复跑：全仓只有 `src/content/index.ts` 与 `README.md` 出现「免费接口限流」），
  所以 §6.2 那一支的改动**不会有任何测试红**——这是"改了也不会红"的一类，
  必须靠 §6.2 本规格点名，**不许**给它补一条"读起来像是守住了"的恒真断言
  （正确的守卫在 §7.3 第 17/18 条的"无引擎零请求"与空态那几条，它们测的是行为不是这句话）。

### 6.3 README 的全部相关行（逐条给出改成什么）

| 行（今天的内容摘要） | 处置 |
| --- | --- |
| `:7` 「默认使用免费的 Google 翻译接口，装好即用，零配置。」 | **改成**：「装上之后需要先配一个翻译引擎（自己的 OpenAI 兼容接口，例如 DeepSeek / OpenAI / 本机 Ollama）——见「安装」后的「快速开始」。」并在同一段把"零配置"这个承诺**明确收回**（这是本单元**唯一**让用户"少了一个功能"的地方，必须写在最显眼的位置） |
| `:44` （使用表）「切换**翻译引擎**（免费接口或某个服务商档案，按名字直接切）」 | **改成**：「切换**翻译引擎**（按档案名字直接切；还没配过档案时这一行不显示，提示区会指路设置页）」 |
| `:45` （设置页那行的功能罗列） | 无需改（没有提免费引擎）——**但实现时复读一遍**，若 E 里改动了引擎区块的 DOM/交互再同步 |
| `:192` （引擎表第一行）「**Google 免费接口**（默认）｜否｜走 `translate.googleapis.com`，零配置可用」 | **删掉这一行**；表头「引擎 / 需要 Key / 说明」保留，表里只剩「**服务商档案**（OpenAI 兼容 API）｜是｜…」这一行 |
| `:200` 「下拉列出的就是「Google 免费接口 + 每个档案的名字」」 | **改成**：「下拉列出的就是**每个档案的名字**（引擎不再有内置项）」 |
| `:206-211` 「**免费接口不稳定、可能被限流。**…免费接口也**不支持术语表**（`supportsGlossary: false`）。」 | **整条删掉**（它描述的是已删除的引擎）。其中"限流只退避、不降并发"那半条（`:209-211`）描述的是**调度器**的行为、与引擎无关，**移到相邻的档案说明处保留**，但要改主语：「撞上限流时只退避、不降并发」 |
| `:220` 「…用免费接口的不会凭空长出档案。设置版本升到 v4。」 | **后半句改成**「用免费接口的老数据不会凭空长出档案。设置版本升到 **v5**：v4 里选着免费接口的，升级后自动切到第一个配好模型的档案；一个都没有就是"没有可用引擎"。」 |
| `:246` 「删除**正在使用中**的档案时，`engineId` 明确回落到免费接口并给出提示」 | **改成**：「删除**正在使用中**的档案时，`engineId` 明确切到剩下的档案里第一个配好模型的；一个都没有就置空，并在设置页说清"现在没有可用的翻译引擎"」 |
| `:250` 「**默认的免费 Google 接口在很多网络下（例如中国大陆）被完全阻断**…」以及整节「### 翻译一直失败？先确认你的网络能不能到达接口」 | **保留这一节、改主语**：把"默认的免费 Google 接口被阻断"改成"你填的那个接口可能到不了"，自查命令（`:257` 的 `curl` 例子）与"可用替代"清单（`:263-265`）原样保留——那一段今天是**指向自定义接口的**，删掉免费引擎后整节反而更贴题 |
| `:397` （目录结构）「engines/ 翻译引擎适配器（Google 免费接口 / OpenAI 兼容）」 | **改成**：「engines/ 翻译引擎适配器（OpenAI 兼容；适配器接口 `Translator` 支持多种）」。**这是唯一提到"以后还能加引擎"的地方，如实写** |
| `:423` 「页面权限按最小化申请：默认只声明免费引擎域名（`https://translate.googleapis.com/*`）；…」 | **改成**：「页面权限按最小化申请：**不声明任何默认主机权限**（`host_permissions` 为空）——安装与更新都不会请求任何站点访问权；自定义端点走 `optional_host_permissions`，并且**只在你点设置页「保存」时**按你填的那个 origin 申请（已授权过就不再弹框）。」**前半句是本单元给用户的一项净收益，值得写清楚** |
| `:419` （隐私节）「…留一条引擎测试记录（键 `jinyi:engine-health`：哪个档案/引擎、通没通、失败原因）。」 | **改成**「…留一条档案测试记录（键 `jinyi:engine-health`：哪个档案、通没通、失败原因）」——`e:` 键空间消亡后，"引擎"这个说法不再有对象 |
| `:5` 的 manifest `description`（README 未引，但 `src/manifest.json` 里同源同假） | 见 §4.4 |

**README 里没被点名、但复跑扫到的两条**（控制器清单里没有，属新发现）：

- README 里凡是"装好即用 / 零配置可用"的**承诺性措辞**（`:7`、`:192`）**必须一起收回**，
  否则新用户装完按 README 的预期去翻译，只会得到一句"还没有可用的翻译引擎"。
  这不是文案洁癖：本单元把"开箱可用"变成了"必须先配一次"。
- **README 现在没有「快速开始」这一节**（复跑：全文没有这个标题）。`:7` 那条改法里既然让用户
  "见「快速开始」"，E4 就必须**真的补一节**（装完 → 打开设置页 → 新增一个档案 → 填地址/Key/
  模型 → 点保存授权 → 回弹窗选它），**不许只留一个指向不存在章节的链接**。
  这是本单元给新用户的**唯一入口文档**——旧版"装好即用"的路径没有了。
- README 的**手动验收清单**（「需要真人在 Chrome 里操作」那一节）里若有"装完直接按 Alt+T"
  这类步骤，要按新的首次配置流程补一步。**复核结论：该清单当前依赖"设置页填 Key / 模型"这条
  路径，本身已经假定用户配过档案**，因此只需在清单开头补一句"先按「快速开始」配一个档案"。
  （**部分复核**：只读了该节开头 10 行，见自审 C-19。）

## 7. 测试与守卫

### 7.1 基线读数（起草时实测）

- `npx vitest run` → **55 files / 1061 passed**，exit 0（命令：`npx vitest run`；
  本机读数、含 `tests/content/extractor-scale.test.ts` 的 18s 规模基准）。
- `tests/engines/google.test.ts` 删除后预计 **55 → 54 files**；用例数按 §7.2 的增删逐项结算
  （**不预设一个数字**：落地时以真实读数入账，与本仓既有的"落地读数表"同一条纪律）。

### 7.2 `engineId: 'google'` 的逐类处置（**不许批量替换**）

复跑精确统计：字面量 `engineId: 'google'` 在测试里共 **22 处**，分布是
`tests/options/engine-health.test.ts` 5、`tests/popup/popup.test.ts` 6、`tests/shared/settings.test.ts` 4、
`tests/options/options.test.ts` 3、`tests/options/engine-models.test.ts` 2、
`tests/background/service-worker.test.ts` 1、`tests/core/hash.test.ts` 1。
（控制器说"约 40 处"是把 `DEFAULT_ENGINE_ID` / `getEngine(DEFAULT_ENGINE_ID)` / `FREE_ENGINE_HEALTH_KEY`
一类引用一起算进去的；**精确口径见上**，下面按**意图**分五类。）

> **为什么绝不能批量替换**：这 22 处里的 `'google'` 今天承载着**至少四种不同的意图**——
> ①"我在用免费引擎"、②"我需要一个能用的引擎"（真实意图是"随便哪个能用的"）、
> ③"我在用一个已失效的 id"、④"这个字段的值与我这条断言无关"。删掉引擎之后，
> ① 变成"没有可用引擎"、② 必须换成**某个具体档案 id**（换成 `''` 就把用例的前提抽掉了）、
> ③ 恰好**变成新语义本身**（要连断言语义一起改）、④ 应该换成能自解释的值。
> 一次 sed 会把 ②③④ 一起按 ① 处理，结果是**一片绿色的假测试**：`resolveEngine` 恒返回
> `{engine: null}` 时，所有断言 `engine.id` 的用例都红，而所有只断言"别的字段没被动过"的用例
> 会安然通过——它们从此什么都没测。

| 类 | 意图 | 处置 | 落点（复跑定位，按用例名而不是行号） |
| --- | --- | --- | --- |
| **① 真在测免费引擎** | 免费引擎的行为/呈现 | **整条删除或按新语义重写** | `tests/engines/google.test.ts`（整份删）；`tests/engines/registry.test.ts`「注册表包含免费引擎与自定义引擎」、`getEngine('google').needsKey` 那条；`tests/options/engine-health.test.ts` 的 `describe('内置免费引擎那一行')` 三条；`tests/options/engine-expansion.test.ts` 里 `[data-engine-free]` 的三处读数；`tests/options/engine-health.test.ts`「存储里是垃圾也不崩」里"用免费引擎行钉渲染真的发生了"那条 |
| **② 只是需要一个"能用的引擎"** | 夹具前提是"有一个可用引擎"，测的是别的事 | **换成具体档案 id**（`'p-a'`，与该文件的 `profileSeed()` 一致），**不换 `''`** | `tests/background/service-worker.test.ts`「payload.targetLang 优先于设置里的 targetLang」；`tests/options/options.test.ts`「本机回环 http 在设置页可保存」；`tests/options/engine-models.test.ts`「取消草稿行：整行移除」；`tests/popup/popup.test.ts`「切换引擎后提示区跟着重算」（它的上下游都要按"档案 ↔ 档案"重写，见下） |
| **③ 意图就是"失效 id"** | 已经/将要失效的引用 | **改成 `''`（语义变成"没有可用引擎"）并改写断言** | `tests/shared/settings.test.ts`「engineId 指向不存在的档案（并发删除留下的残值）→ 回落免费引擎，不抛错」（改成"→ **没有可用引擎** + 那句可行动的话，不抛错"）；同文件「能用的配置不背那句"还没有模型"」里的 `engineId: 'google', profiles: []`（改成 `''`）；同文件「engineId 是 google 时不产生档案」（迁到 v5 迁移用例组，见 §7.3） |
| **④ 值与本用例的断言无关** | 只为让一份设置"有 engineId 这个字段" | **换成能自解释的值**：要么 `'p-a'`（当夹具里真有档案时），要么删掉这个字段（让它走默认） | `tests/core/hash.test.ts` 的 `base` 夹具；`tests/options/engine-models.test.ts`「打开设置页/展开档案/聚焦输入框都不发请求」；`tests/options/options.test.ts`「新增档案…不偷改 engineId」（改成先 `seedSettings({ engineId: 'p-a', profiles: [profileSeed()] })`，断言"仍是 `p-a`"）；`tests/options/engine-health.test.ts`「草稿行点测试连接不落记录」 |
| **⑤ 纯持久化用例** | 断言"这次改动没抹掉其它字段/其它 Key/没改 engineId" | **换成真实档案 id**，让断言继续有判别力 | `tests/popup/popup.test.ts`「切换显示模式写进存储，其它字段原样保留」、「保存被拒绝时说明原因并回滚下拉」（后者其实不需要引擎，去掉 `engineId` 或换 `'p-a'` 都行——**选换 `'p-a'`**，保留"整份回写不抹字段"这层含义） |

### 7.3 逐文件的增删改明细

**删除**

1. `tests/engines/google.test.ts`（整份，162 行）。
2. `tests/engines/registry.test.ts` 里三条与免费引擎绑定的用例
   （「未知 id 回退到默认免费引擎」、「注册表包含免费引擎与自定义引擎」、「免费引擎不需要 Key…」）。
   **替换成一条新的核心守卫**：
   `expect(ENGINES.map((e) => e.id)).toEqual(['openai-compat'])` ——
   它钉的是"**引擎列表被删到一个**"这件事本身（有人把 `google.ts` 加回来、或把 `ENGINES` 又写成
   多成员，这条当场红）。**这条比原来的名单断言更硬**：原来的名单是"恰好这两个"，
   新的是"恰好唯一的那一个"。
3. `tests/options/engine-health.test.ts` 里 `describe('内置免费引擎那一行')` 的三条用例：
   - 「在列表最后，带「内置」，没有删除也没有编辑（不可删）」→ **删**（没有这一行了）。
   - 「点它的「测试连接」真的发一次请求，成功之后点变绿」→ **删**。它顺带守的"空 Key 落在
     脱敏门槛之外"已由同文件的「短 Key（<8 字符）不做脱敏」覆盖（那条用的是 `apiKey: shortKey`，
     不依赖免费引擎）——**删之前先确认这一点，确认不了就把那半条断言搬过去**。
   - 「档案 id 撞上 `google` 也不串台」→ **删**（它的整条推理链建立在"免费行的记录落在引擎键上"
     这个前提上，而引擎键没有了）。
4. `tests/options/engine-health.test.ts` 的 `freeDot()` 辅助函数与 `FREE_ENGINE_HEALTH_KEY` 的 import。
5. `tests/options/options.test.ts` 的「免费引擎下改设置：一个宿主权限申请都不发」→
   **不删，重写**：夹具换成 `engineId: 'p-a'` + 一个档案，但**不改语言**（改语言不会碰权限，
   这条会退化成恒真）——改成"**保存一个已经授权过的档案时不再弹框**"，
   或用成对写法："未授权 → 点保存会申请；已授权 → 点保存一次都不申请"。
   （**今天这条在 `engineId: 'google'` 下表达的是"免费引擎不需要授权所以不申请"；
   引擎删掉后这句话没有对象了，必须换成一个仍然承重的判据。**）

**改写（§4.5 / §7.2 的 ③④⑤ 类）**

6. `tests/options/engine-health.test.ts`「档案 id 直接取成引擎键本身（`e:free`）也不串台」
   → **重写成一个仍然成立的不变式**（**绝不许**退化成恒真式，见 §4.5）。新用例的口径：

   > **标题**：「档案 id 可以长得像任何东西（含 `p:` 前缀本身）：记录键由前缀**加**出来，
   > 点从记录键**解**回来，账不串」
   >
   > 夹具：一个档案，id 取**今天已经没有特殊含义、但长得最像键的**那类脏值——
   > 建议 `'p:dup'`（**注意：这条同时覆盖了"永远不要从存储里老 `p:` 键认领记录"这半条说明**，
   > 因为档案 id 恰好等于"另一个档案的键"）。
   >
   > 三条断言（逐条说明"牙在哪"，写进用例注释里）：
   > 1. 展开该档案 → 点一次「测试连接」→ 等待记录落盘；
   >    `expect((await storedHealth())[profileHealthKey(id)]).toEqual({ state: 'ok', detail: '' })`
   >    —— **牙**：`profileHealthKey` 若不加上 `p:` 前缀（写成裸 id），这条红。
   > 2. `expect(dotOf(id).dataset.state).toBe('ok')`
   >    —— **牙**：`rowForKey` 若不再从记录键**解**出 id（返回 null 或拿键当 id），
   >    点更新不到，`dotOf` 会抛"档案行没有状态点"或读到 `idle`。
   > 3. 重绘（展开/收起）之后再读一次上面两条
   >    —— **牙**：重绘会走 `renderProfiles` → `applyDot(dot, health[profileHealthKey(id)])`，
   >    读取侧与写入侧一旦用了不同的键形状，重绘后点回到 `idle`。
   >
   > **不许写成** `expect(storedHealth()[key]).toBeUndefined()` 这类"断言某样东西不存在"的形态：
   > 引擎键消失之后，"不存在的键"恒不存在，那种断言就是恒真式。

7. `tests/options/engine-expansion.test.ts`「新增档案那一行也是就地追加：不动已有的行」：
   `[data-engine-free]` 的三处读数（插入前的引用、追加后的引用、"排在草稿行之后"）
   **全部删除**；改为断言**草稿行跟在最后一个档案行之后**（`after[3].previousElementSibling`
   是 `before[2]`，或 `after.at(-1)` 是 `__new__`），并保留"已有三行节点身份不变"的
   `[true, true, true]` 读数（那才是这条用例的承重部分）。
8. `tests/options/engine-health.test.ts`「存储里是垃圾也不崩」：
   末尾那句"钉住内置免费引擎那一行，证明页面照常渲染"**必须换成另一个同样承重的读数**——
   建议改成"钉住 `#engine-hint` 写出了那句话"（空态下 `engine === null`，
   提示一定有内容），**不许直接删掉**：删掉之后这条用例在"`mount` 里根本不渲染"的变异下会
   重新变绿（这正是它当初加那两行的原因）。
9. `tests/shared/settings.test.ts`：
   - 「engineId 是 google → 免费引擎 + 空配置，档案完全不参与」→ **删**（没有免费引擎）。
   - 「engineId 指向不存在的档案 → 回落免费引擎」→ **改成**「→ 没有可用引擎 + 那句可行动的话」：
     `expect(r.engine).toBeNull()`、`expect(r.config).toEqual({})`、
     `expect(r.problem).toBe(NO_ENGINE_PROBLEM)`。
   - 「裸 openai-compat（没配任何档案）→ 引擎自己给出可行动的 AUTH 提示」→ **改写**：
     裸引擎 id 不再是入口。这条改成"**没有可用引擎时零请求**"的成对用例：
     `resolveEngine({ engineId: 'openai-compat', profiles: [] })` → `engine === null`，
     且 `expect(fetchSpy).not.toHaveBeenCalled()`（成对的正例：同一个 `resolveEngine`，
     把 `engineId` 换成有 `activeModel` 的档案 id → `engine !== null`，请求能发出去）。
   - `DEFAULT_SETTINGS.engineId` 的断言 → `toBe('')`。
   - v2 数据那条「engineId 是 google 时不产生档案」→ **保留用例、改断言**：
     迁移后 `engineId` 是 `''`（v5 那一步把它抹掉了）。
10. `tests/core/hash.test.ts` 的 `base.engineId: 'google'` → `'p-a'`
    （顺带把「任一字段变化都会改变 key」里那个 `engineId: 'openai-compat'` 换成另一个档案 id——
    那是**缓存 key 的字段**，语义上现在只可能是档案 id；`scheduler.ts` 传的是
    `deps.engine.id`，两件事别混）。
11. `tests/popup/popup.test.ts`：
    - 「下拉列出…免费接口 + 两个档案」→ 改成"只列档案的名字"（去掉 `getEngine(DEFAULT_ENGINE_ID).name` 那一项）。
    - 「零配置引擎不警告，并说明无需 Key」→ **重写**为"没有可用引擎：下拉那一行隐藏、提示区说出那句话、零请求"。
    - 「切换引擎后提示区跟着重算（免费 ↔ 没填 Key 的档案）」→ 改成"**档案 ↔ 档案**：切到一个没填 Key 的档案 → 缺 Key 提示；切回填了 Key 的 → 换成未授权/已配置提示"。
    - 三条"别的字段原样保留"的持久化用例（目标语言 / 显示模式 / 保存被拒）→ 按 §7.2 的 ⑤ 换成档案 id。
    - 「选中档案即落盘档案 id，且整份回写不会抹掉任何档案已填的 Key」→ 去掉 `engineId: 'google'`（改成 `'p-a'`），它本身测的是"切换到 p-b"，与引擎无关。
12. `tests/background/service-worker.test.ts`：那条 `useSettings({ engineId: 'google', ... })` →
    `'p-a'` + 一个 `profiles: [ ... ]`（它叫 `stubGoogleFetch()` 的辅助函数**一并改名**
    ——`stubFreeApiFetch()` 之类，它的响应形状是 Google 的嵌套数组，删掉引擎后这个形状
    **不再有任何生产代码会解析**，辅助函数要么删掉、要么必须改成 OpenAI 兼容的响应）；
    **更要紧的是**：同文件**四条根本没有设置**的缓存用例（"合法消息返回 true…"、
    "端口已关闭…"、"两层都有同一个 key…"、"会话层没有时从持久层命中…"）**依赖
    `DEFAULT_SETTINGS.engineId === 'google'` 才能跑通**（复跑实测：它们不 `useSettings`，
    走默认设置）。默认值改成 `''` 后这四条会一起红——**它们的真实需要是"一个能用的引擎"**，
    因此每条都要显式 `useSettings({ engineId: 'p-a', profiles: [...] })`，
    并把手写的 Google 响应体换成 `chatResponse` 形状。**这是控制器清单里没有的一类落点**。
13. `tests/options/harness.ts`：`seedSettings` 的默认行为**不用改**（它本来就不写 `engineId`），
    但要**新增一个夹具入口**让"有可用引擎"成为显式声明——建议
    `export function seedWithProfile(patch = {})`（= `seedSettings({ engineId: 'p-a',
    profiles: [profileSeed()], ...patch })`），把 §7.2 的 ②⑤ 类用例统一改成调它，
    这样"这条用例需要一个可用引擎"在夹具名上就看得见。

**新增（守卫必须有牙）**

14. **`tests/manifest.test.ts`（控制器点名）**：`Manifest` 接口加上
    `host_permissions?: unknown` 与 `optional_host_permissions?: unknown`，并加两条：
    - `expect(manifest().host_permissions).toEqual([])` ——
      **牙在哪**：谁把 `https://translate.googleapis.com/*`（或别的域名）加回默认主机权限，
      这条红。这是"安装时不请求任何站点访问权"这句用户可见承诺的**唯一**机器守卫。
    - `expect(manifest().optional_host_permissions).toEqual(['http://*/*', 'https://*/*'])` ——
      **牙在哪**：这条是**反向**约束（与既有"不许有 `tabs`"那条同一性质）。清空
      `host_permissions` 的人很容易顺手把 `optional_host_permissions` 也"一起清理干净"——
      那样自定义端点会**永远申请不到授权**，而所有测试都是替身、**一条都不会红**。
      这条断言的存在理由要写进注释（这是"改了也不会红"的那一类缺口，与文件头讲 `activeTab`
      的理由完全同构）。
15. **"没有可用引擎 ⇒ 零请求"的端到端守卫**（`tests/background/service-worker.test.ts`）：
    `useSettings({ engineId: '', profiles: [] })` → `translateTexts(...)` 返回
    `{ ok: false, code: 'AUTH', message: NO_ENGINE_PROBLEM }`，且 `fetchSpy` **0 次调用**。
    **牙在哪**：复跑实测过**今天这条是反的**——同样的设置会真的发出一次
    `translate.googleapis.com` 请求并返回 `{ ok: true, results: [{ text: '【Hello】' }] }`。
    所以这条断言不是恒真式，它是本单元行为的**直接对立面**。
16. **迁移的三条**（`tests/shared/settings.test.ts`）：
    - v4 + `engineId: 'google'` + 若干档案（其中一个 `activeModel` 非空）→ 读回后
      `engineId` 是**那个档案的 id**；并且**断言它恰好是数组里第一个有 `activeModel` 的那个**
      （夹具里放一个 `activeModel: ''` 的档案排在前面，否则"取第一个"与"取第一个可用的"分不开）。
    - v4 + `engineId: 'google'` + 档案全都 `activeModel: ''`（以及 `profiles: []`）→ `''`。
    - **幂等**：同一份 v4 数据连读两次，两次结果相同；且**存储里那份原文没被改写**
      （`expect((await area.get([SETTINGS_KEY]))[SETTINGS_KEY].version).toBe(4)`）——
      与既有的「打开页面不写存储：迁移发生在读的那一刻」同一条口径。
17. **无引擎下的设置页与弹窗空态**（各一条）：
    - 设置页：`seedSettings({ engineId: '', profiles: [] })` → `#engine-hint` 文本**等于
      `NO_ENGINE_PROBLEM` 常量**（比抄字面更硬，见第 18 条）、`profileRows()` 长度为 0、
      **`#profiles` 里没有任何 `[data-engine-free]` 节点**（这条要显式写，否则"整行消失"没有守卫）。
    - 弹窗：同一份设置 → `#engine-field` 的 `hidden === true`、
      `#engine` 的 `options.length === 0`、提示区以 `NO_ENGINE_PROBLEM` 开头且带 `warn`。
18. **文案的唯一来源 + 常量自己的守卫（两条独立用例）**：
    - 所有**界面**断言一律比对 `NO_ENGINE_PROBLEM` 常量（`toBe` / `toContain`），**不把整句抄进界面用例**——
      抄一遍就等于有两个来源，这正是 `NO_MODEL_PROBLEM` 那条既有纪律的做法。
    - **但"不抄整句"这条纪律不能推到底**：常量被改坏时，所有走常量的界面断言会**一起绿**（两边同源），
      于是常量自己的字面必须有**一条独立的守卫用例**。落地形态是**两条独立 `it`**：
      ① `expect(NO_ENGINE_PROBLEM).toBe('还没有可用的翻译引擎，去设置页添加一个服务商档案')`
      ——整句字面，**必须单独成条**（否则它失败时会挡在词级断言前面，让下面四条词永远拿不到读数）；
      ② 四条词级 `toContain`：`'没有可用'` / `'翻译引擎'` / `'设置页'` / `'服务商档案'`。
      四条词各有**单字符杀法**（可→能 / 擎→挚 / 页→项 / 档→挡），**分四次独立运行**。
      ⚠ **读数口径（落地实测）**：上面两条 `it` **同在一个文件**，而整句 `toBe` 对**任何**单字符改动都敏感——
      所以**不过滤用例名**跑这个文件时，一次改动会看到 **2 红**（整句 + 对应那条词）；实施报告里
      "每条词各 1 红"是**只点名词级那条**的读数。**两种口径的差别在"跑了哪些用例"，不在"谁没牙"。**
19. **`e:` 键空间消亡的守卫**：`tests/options/engine-health.test.ts` 不再 import
    `FREE_ENGINE_HEALTH_KEY`（它已被删除），**并且**没有别的测试文件引用它——
    这条不需要新断言（删掉的符号被引用就是编译错），但**落地时要在提交信息里记一句**
    "`engine-health.ts` 的导出面缩小了"，因为它是模块的公开契约变化。

### 7.4 夹具里的隐性"默认就用 google"前提（控制器点名要查的）

复跑结论：

- **`tests/helpers/chrome-stub.ts` 没有**任何关于引擎/设置的默认值（它只提供存储、权限、
  消息与标签页替身）。
- **隐性前提在两处**，都必须显式化：
  1. `tests/background/service-worker.test.ts` 那四条不写设置的缓存用例（见 §7.3 第 12 条）
     ——它们靠 `DEFAULT_SETTINGS.engineId` 走通。
  2. `tests/options/harness.ts` 的 `seedSettings()` 与 `tests/popup/popup.test.ts` 的
     `seedSettings()`：**今天这两份夹具在多数用例里连 `engineId` 都不写**，于是"用哪个引擎"
     这件事在夹具层面是**隐式**的。默认值改成 `''` 之后，凡是没有显式声明引擎的用例都会
     落到"没有可用引擎"——**这不是回归，而是把一条一直存在的隐性前提显式化了**。
     处置：给"需要可用引擎"的用例一个**名字里能看出来的**夹具入口（§7.3 第 13 条），
     **不许**靠"把默认值改回某个 id"来让它们继续绿。

## 8. 验收标准

**全量命令（全部 exit 0）**

1. `npx vitest run` 全绿；文件数与用例数**按落地时的真实读数入账**（起草基线：
   55 files / 1061 passed；删掉 `google.test.ts` 后预计 54 files）。
2. `npm run typecheck` exit 0（`DEFAULT_ENGINE_ID` / `getEngine(): Translator` 的旧签名
   若还有一处没改，这一步就是第一道红）。
3. `npm run build` exit 0 且 `verify:dist` 全项通过；`npm run zip` 成功。
4. **`dist/manifest.json` 里 `host_permissions` 是 `[]`**（源与产物都要看：源被
   `manifest.test.ts` 钉住，产物由 `verify:dist` 确认 manifest 本身合法）。

**数值/结构面**

5. `CURRENT_VERSION === 5`；`DEFAULT_SETTINGS.engineId === ''`。
6. `ENGINES.map((e) => e.id)` **恰好等于 `['openai-compat']`**。
7. `src/engines/google.ts` 与 `tests/engines/google.test.ts` 都不存在；
   `grep` 全仓（`src/` + `tests/`）里作为**行为 / 实现**残留的 `googleapis`、`googleEngine`、
   `DEFAULT_ENGINE_ID`、`FREE_ENGINE_HEALTH_KEY`、`ENGINE_HEALTH_PREFIX`、`test-free`、
   `data-engine-free` **一处都没有**。
   ⚠ **口径（T1 落地 + 独立验证实测）**：原文写"不再出现"是**不可能满足的**写法——它与
   §7.3 第 17 条"必须**显式写** `[data-engine-free]` 的空态断言"直接互斥（一条要求字面量消失，
   一条要求它出现）。正确的判据是**分母口径**：
   - **唯一允许的 `googleapis` 残留在 `manifest.json` 的 `host_permissions`**，而那是 T2 的活；
   - **显式空态守卫**（`…querySelector('[data-engine-free]')` 与 `[data-action="test-free"]`
     的 `toBeNull()`）**必须留着**：留的是**断言**，不是行为，而且它们是"那一行真的没了"的守卫；
   - **注释里的历史说明**（"那个形状随 `src/engines/google.ts` 一起删了"这类）不算残留。
   独立验证者的逐符号读数：`googleEngine` / `DEFAULT_ENGINE_ID` / `ENGINE_HEALTH_PREFIX` = **0**；
   `FREE_ENGINE_HEALTH_KEY` = 1（注释）；`test-free` = 1（显式 `toBeNull` 断言）；
   `data-engine-free` = 2（1 注释 + 1 显式 `toBeNull` 断言）；`googleapis` = 2（`manifest.json` + 1 测试注释）。
   且那两条空态断言**不是恒真式**（独立验证实测）：往列表里追加一个 `<div data-engine-free>` →
   1 红（`expected <div data-engine-free></div> to be null`）；追加一个 `<div data-action="test-free">`
   同理，各 1 红。两条都在 **`tests/options/options.test.ts`** 里（分别是
   `querySelector('[data-engine-free]')` 与 `querySelector('[data-action="test-free"]')` 的 `toBeNull()`）。

**行为面（升级路径）**

8. v4 用户（`engineId: 'google'`，档案里第一个有 `activeModel` 的是 X）→ 读一次设置之后
   `engineId === X`；把 X 的 `activeModel` 清空再读 → 仍是 X（**只有 v4 那一次会挑**，
   之后不再替用户改）。
9. v4 用户（`engineId: 'google'`，所有档案都没 `activeModel`，或没有任何档案）→ `engineId === ''`，
   设置页与弹窗都显示 §6.1 那句话，**一装完就能看见要做的事**。
10. 首装（无存储）：`engineId === ''`、`profiles === []`、弹窗引擎那一行隐藏、提示区指路设置页、
    **存储里没有被写入任何档案骨架**（读一次设置不产生任何写入）。

**行为面（零请求）**

11. 无可用引擎时：`translateTexts` 返回 `{ ok: false, code: 'AUTH', message: NO_ENGINE_PROBLEM }`，
    **`fetch` 0 次**（端到端守卫，见 §7.3 第 15 条）。
12. 无可用引擎时：翻译路径上**没有任何地方**去构造一个引擎对象（`getEngine` 返回 `null`，
    `resolveEngine` 原样交出去），所以"忘了拦一处就发出去"这条路径**按构造**不存在。

**行为面（可读性）**

13. **那句提示要让人读明白两件事（场景描述，不是在要求某个连续子串）**：读完那句话应当知道
    ①**现在没有可用引擎**（是什么事）与 ②**去设置页添加一个服务商档案**（去哪儿做）。
    判定方式不是"必须含「没有可用引擎」这个四字子串"——**那个子串在契约字面里根本不存在**：
    常量是「还没有可用的翻译引擎，去设置页添加一个服务商档案」，`没有可用` 与 `翻译引擎`
    之间隔着「的」（这正是本轮实测推翻的一处预期，见 §7.3 第 18 条与计划的 T1 复盘）。
    落地的判定 = **两条独立用例**：整句 `toBe` 常量字面（钉住契约本身）+ 四条词级 `toContain`
    （`没有可用` / `翻译引擎` / `设置页` / `服务商档案`，各自有单字符杀法）。
    另：两处界面**逐字相同**（`NO_ENGINE_PROBLEM` 是唯一来源），弹窗额外追加一句指路齿轮。
14. 删除当前档案后：有可用档案 → 切到它并在状态行说清；没有 → `engineId === ''` + 那句提示。

## 9. 已知限制

- **本机没有浏览器**：弹窗的空态**观感**（下拉那一行隐藏后，提示区与上下的间距是否还像话）
  与设置页空态（只有一句话 + 一个「+ 新增档案」按钮）**都没有被真实渲染验证过**。
  交付读数只到"DOM 断言 + 类名/`hidden` 属性"这一层。**这是本单元唯一需要用户肉眼验收的地方。**
- **Google 端点在本机不可达**，所以"免费引擎被删掉"这件事**无法用真机对比验证**：
  既不能证明"删之前它是可用的"，也不能证明"删之后真机上不再有任何请求发往那个域名"。
  后者能给的**最强**证据是两条机器读数：`manifest.json` 里 `host_permissions` 为空
  （浏览器层面根本不会授予该域名的访问权）+ 全仓不再出现 `translate.googleapis.com`。
  真机验收时请用户在 `chrome://extensions` 打开开发者模式、看该扩展的
  「网站访问权限」是**零项**——这是本单元最值得让他亲眼确认的一条。
- **迁移只在读的时候发生**：v4 数据在用户主动改动任何设置之前，存储里仍然是
  `engineId: 'google'`（版本号也还是 4）。这一点与既有三次迁移完全一致，
  但**用户可见的后果**要写清楚：如果他回退到旧版扩展，看到的是**旧世界**（还能用免费接口）。
- **旧文档不追溯**：`docs/superpowers/specs|plans` 下所有提到免费引擎的描述保留原样，
  只在 §1 抬头记了一句。**读那些文档的人可能在读到本单元之前先读到它们。**
- **`supportsGlossary` 无判别力**（§4.3）：今天的"术语表对当前引擎生效"这条分支**没有任何
  测试能守住**（唯一适配器恒 `true`），它是一处**已知的、如实的**守卫缺口。
- **"没有可用引擎"与"档案没有当前模型"是两句不同的话**（`NO_ENGINE_PROBLEM` /
  `NO_MODEL_PROBLEM`），都从 `resolveEngine` 出来。**优先级**：没有引擎时只说前者
  （后者对新装用户毫无意义）。这条由 §4.2 的三条规则**按构造**保证（没有档案就没有第二句），
  但没有专门的断言——**如实记账**。

## 10. 交付拆分（E1..E5）

| 单元 | 一句话产出 | 依赖 |
| --- | --- | --- |
| **E1 引擎层** | 删掉 `src/engines/google.ts` 与它的测试；`registry.ts` 变成"一个引擎 + `getEngine` 返回 `null`、没有兜底"；删掉 `DEFAULT_ENGINE_ID` | — |
| **E2 数据层** | `CURRENT_VERSION` 4 → 5、`DEFAULT_SETTINGS.engineId` 变 `''`、v4 → v5 迁移与 `firstUsableProfileId`；`resolveEngine` 返回 `Translator \| null` 并给出 `NO_ENGINE_PROBLEM`；`getEngine` 的 `null` 在这一层被接住 | E1 |
| **E3 界面层** | 设置页免费引擎那一行/`test-free`/`rowForKey` 引擎分支/`e:` 键空间一起消失，`renderEngineHint` 的空态；弹窗只列档案 + 空态引导 + 提示区 | E2 |
| **E4 权限与文案层** | `manifest.json` 的 `host_permissions` 清空与 `description` 改写；`content/index.ts` 两条假话；后台的无引擎闸 + 注释；`scheduler.ts` 的注释；README 全部相关行 | E2 |
| **E5 收口** | 全量命令 + `manifest.test.ts` 两条新守卫 + "零请求"端到端守卫 + 迁移三条 + 空态两条 + `engineId: 'google'` 的 22 处逐类处置（§7.2）+ 变异验证（见下） | E1–E4 |

**为什么这么切**：

- E1 与 E2 分开，是因为"删引擎"与"改语义"是两件独立的可验证事：E1 之后
  `npm run typecheck` 会把所有 `DEFAULT_ENGINE_ID` 的引用一次点出来（**这是一份免费的清单**），
  E2 才有完整的信息去逐处裁决。
- E3 必须在 E2 之后：空态文案的唯一来源在 E2（`NO_ENGINE_PROBLEM`），先做界面就会出现
  "界面里先写一句字面量、后面再搬走"的漂移。
- E4 与 E3 并行不冲突（不同文件），但都依赖 E2。
- E5 的**变异验证**（必须有读数才许宣称守卫还在把关）：
  1. 把 `host_permissions` 改回 `["https://translate.googleapis.com/*"]` → `manifest.test.ts` 必须红。
  2. 把 `optional_host_permissions` 删掉 → 必须红。
  3. 把 `resolveEngine` 的第 2 条规则改成"回落 `getEngine(OPENAI_COMPAT_ENGINE_ID)`" → 
     "零请求"端到端守卫与空态两条必须红。
     ⚠ **落地实测（E1）更正这一条的读数口径**：空态那两条确实红，但"零请求"那条守卫**只红响应形状那半**——
     `calls` 仍是 0：回落的 `openai-compat` 需要宿主权限，而权限闸在**发请求之前**就先抛 `AUTH`。
     要真的让"零请求"断言（`toHaveLength(0)`）红，得用一个**今天可达**的反例：在权限闸里先 `await` 一次
     真 `fetch`（计划 T1 的 M6c，实测恰好两条零请求断言红）。**别把"这条变异没红到它"读成"这条断言是恒真式"。**
  4. 把 v5 迁移那一步删掉 → 迁移三条必须红。
  5. 把 `profileHealthKey` 的 `p:` 前缀去掉 → §7.3 第 6 条那三条必须红（**逐条确认 1/2/3 各自的杀手**，
     别只看"这条用例红了"）。
     ⚠ **落地实测（E1）更正**：把前缀整个去掉（`PROFILE_HEALTH_PREFIX = ''`）**只红第 6 条的第 4 条
     形状断言**（`expected 'dup' to be 'p:dup'`），**三条行为牙都不红**——读写两侧共用同一个函数，
     键只是换了个形状，行为上不可观察。**"逐条确认各自的杀手"这句才是对的**：第 6 条里"把前缀
     写成裸 id 就红"的措辞要按**单侧变异**读（写侧交裸 id / `rowForKey` 拿键当 id / 读侧按裸 id 读记录，
     即计划 T1 的 M5b/M5c/M5d，三次独立运行各自点名一条牙）。

---

## 自审

### A. 占位符扫描

`TBD` / `TODO` / `适当` / `类似` / `等等` 一类的含糊措辞在实现要求里**一处都没有**：
所有新增文案给了确切字面（§6.1、§6.2、§6.3），所有新增判据给了函数签名与分支（§3.2、§4.2），
所有新增断言给了"牙在哪"（§7.3）。**唯一保留的"建议/例如"是**：
§7.3 第 6 条的脏 id 取值（`'p:dup'`）与第 13 条的夹具函数名（`seedWithProfile`）——
这两处是**实现细节的可选形状**，不影响任何验收判据，落地时可以换名字/换值，
但**判据（那三条断言/那层含义）不许换**。

### B. 内部一致性核对

- §1.2(b) 说"零请求"由 `resolveEngine` 一处产生 → §4.2 把它落成 `engine === null` →
  §8.11 用端到端守卫钉住 → 三者一致（`resolveEngine` 是**产出点**，后台的 `problem` 闸是
  **拦下点**，两件事，没有第二个"解析点"）。
- §5.1 说设置页不新增空态 DOM → §5.3 又说状态行要多说一句：两者不冲突
  （一个讲**静态结构**，一个讲**动作后的反馈**）。
- §6.1 的三句话都以 `NO_ENGINE_PROBLEM` 为核 → §7.3 第 18 条要求断言走常量 → 一致。
- `manifest.json` 的 `host_permissions` 清空（§4.4）与"自定义端点仍按需申请"（§2 非目标）
  与 `optional_host_permissions` 的第二条守卫（§7.3 第 14 条）**三者互不矛盾**：
  默认零权限，自定义端点走可选权限，两条权限数组各有各的守卫。
- §4.3 说"不为 `supportsGlossary` 编断言"与 §7 里没有任何一条为它新增断言 → 一致。
- §9 的"优先级没有专门断言"与 §7.3 第 18 条（只断言关键词）→ 一致：**如实记缺口，不假装有守卫**。

### C. 哪些话是推断而非实测（逐条标注）

**实测（本轮跑过命令/读过文件，可复现）**：

1. `npx vitest run` → 55 files / 1061 passed（本机，2026-09-20 起草会话）。
2. `resolveEngine({ engineId: '已删掉的', profiles: [p-a] })` 与 `resolveEngine({ engineId: '',
   profiles: [] })` 都返回 `engine.id === 'google'`（探针用例实测）。
3. **设置页在失效 `engineId` 下确实显示**「当前在用免费接口（零配置）。…」，
   且 `#engine-status` 为空、不抛错（探针用例实测；这条**推翻了"会抛错"的猜测**）。
4. **后台在 `engineId: ''` + 无档案时真的发了一次请求并被假响应接住**：
   返回 `{ ok: true, results: [{ id: 'i1', text: '【Hello】' }] }`，`fetch` 1 次（探针用例实测）。
5. `engineId: 'google'` 字面量在 `tests/` 里**恰好 22 处**，逐文件分布见 §7.2（脚本统计）。
6. `tests/engines/google.test.ts` 是 162 行；`src/engines/google.ts` 的导出只被
   `registry.ts` 与那份测试引用（全仓 `Select-String`）。
7. `translate.googleapis.com` 在 `src/` 里只出现在 `google.ts` 的 `ENDPOINT` 与
   `manifest.json` 的 `host_permissions`（全仓 `Select-String`）。
8. `tests/helpers/chrome-stub.ts` 里没有引擎/设置默认值；四条缓存用例不写设置
   （读文件 + 逐条 `useSettings` 出现位置）。
8b. `tests/content/index.test.ts` 的「全部条目网络失败时…」逐字断言了 toast 含
   「自定义 API」（读文件）→ §6.2 的新文案会让它红（已写进处置）。
9. `CURRENT_VERSION` 是 4、`DEFAULT_SETTINGS.engineId` 是 `'google'`（读文件 + 探针输出）。
10. `manifest.test.ts` 今天只钉 `permissions`（`activeTab` / 不含 `tabs`）与 `action.default_popup`，
    **没有任何 host 权限断言**（读文件）。
11. `verify-dist.mjs` 不检查 `host_permissions`（全文件 `Select-String`）。
12. 工作树在起草开始时干净（`git status --porcelain -uall` 空）。
    ⚠ **起草过程中工作树被另一个并发会话改动了**（同一分钟内的三个读数）：
    `scripts/make-icons.mjs` + 四个 `src/icons/*.png` 被改、`scripts/_probe.mjs` 与
    `scripts/_preview-icons.mjs` 两个未跟踪脚本出现。**本规格没有动它们**，也建议 E1 开工前
    先确认那些改动是别人的在途工作还是该还原——**别把它们卷进本单元的提交**（提交一律路径限定）。

**推断（未实测，落地时必须先取读数再动手）**：

13. 「删掉 `google.test.ts` / 拆掉三条 registry 用例之后文件数与用例数的**确切**变化」——
    只给了推测（54 files），**没有逐个结算用例数**。§7.1 明确要求落地时以真实读数入账。
14. 「`tests/background/service-worker.test.ts` 那四条缓存用例在默认值改成 `''` 之后**会一起红**」
    ——这是**读代码 + 实测过的现状**推出来的结论（它们今天确实不写设置却要求请求真的发出去），
    但**没有真的把默认值改掉跑一遍**（那属于实现，超出本规格的边界）。
15. 「弹窗空态隐藏 `#engine-field` 之后**观感**没问题」——纯推断，见 §9 第一条限制。
16. 「把 `RATE_LIMIT` 改成 `return response.message` 之后既有的内容脚本用例仍然全绿」——
    **已补查**：全仓只有 `src/content/index.ts` 与 `README.md` 出现「免费接口限流」，
    **没有任何测试钉住那句罐头文案**，所以那一支改动不会有测试红（§6.2 已按此改口径）。
    但**同一条用例的 NETWORK 那半句是被钉住的**（`toContain('自定义 API')`），
    也在同一节写明了处置。
    ⚠ **T2a 落地时已把这条从推断升级成实测（第十轮）**：执行者按计划做了反向变异
    （把 `describeError` 的 `RATE_LIMIT` 支改回罐头文案），在**干净检出**上跑全量 →
    **`54 files / 1054 passed` 全绿**，实测证实"这一支今天没有任何测试钉住"。
    **仍然不许为它补恒真断言**；反向证据见计划 T2 Step 8 的 **M4**。
    另：NETWORK 那半句的守卫**不是三条而是四条 `it`（共六处 `not.toContain('socket hang up')` 断言）**
    ——计划起草时把这条计数写低报过，且执行者照字面落地成了测试文件里的一句假话，已由控制器就地改正；
    教训见计划「T1 落地复盘」第 5 条。
17. 「`manifest.json` 的 `description` 改动不会红任何测试」——复跑确认**没有测试引用
    description**，但 `scripts/zip-dist.test.ts` 用自带的 fixture manifest，
    与真实 manifest 无关（已读），故结论可靠度较高；仍标注为"低风险推断"。
18. 「DEFAULT_ENGINE_ID 的全部引用点」清单来自一次 grep（含文档），
    **`src/` 内的三处（settings / options-engine / popup）+ 六个测试文件**已逐处读过；
    但**没有把每一处都标注"改成什么"**（§7.2 只给了**逐类**口径与关键落点，
    剩余零散处按类归口），逐处清单留给 E1 的 typecheck 输出当"免费清单"。
19. README 的**手动验收清单**（「需要真人在 Chrome 里操作」那一节）我只读了开头 10 行，
    结论"它已假定用户配过档案"是**局部的**；E4 落地时要整节读完再补那一句。
