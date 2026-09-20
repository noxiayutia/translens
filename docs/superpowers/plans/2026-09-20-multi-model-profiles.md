# 一个档案接入多个模型并可切换 实现计划（单元 C）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一个服务商档案能装多个模型并可切换（数据模型 v4 + `/models` 拉取 + 设置页模型目录 UI + 弹窗模型下拉），同时把用户报的「点一行展开很慢」就地修掉。

**Architecture:** 三件事各自独立落地：①**展开就地更新**——`sections/engine.ts` 的展开/收起只改受影响的那一行（插入/摘除 `.profile-editor` + 同步 `aria-expanded`），`renderProfiles` 只留给"数据真的变了"的路径；②**数据模型 v4**——`EngineProfile.model: string` 变成 `models: string[]` + `activeModel: string`，`CURRENT_VERSION` 3→4，v1/v2/v3 三条迁移路径都收敛到同一形状；③**`/models` 拉取**——设置页只传 `profileId`，后台 service worker 自己从存储读 `baseUrl`/`apiKey` 并请求，容错解析三种响应形状、失败分类、10 秒独立超时。

**Tech Stack:** TypeScript + Vitest（jsdom / node 双环境）+ Vite（MV3）。测试命令 `npx vitest run <文件>`，收口 `npm test` / `npm run typecheck` / `npm run build`（含 `verify:dist`）/ `npm run zip`。

**规格：** `docs/superpowers/specs/2026-09-18-multi-model-profiles-design.md`（§3 数据模型、§4 缓存前提、§5 `/models` 拉取、§6 设置页版式、§7 弹窗、§9 验收、§10 限制）
**参考图：** 用户提供的界面截图（**无仓库内文件**）。版式映射与三处**有意偏离**的记账见下「参考图 → DOM 映射」。
**格式范本：** `docs/superpowers/plans/2026-09-18-options-page-redesign.md`（单元 B：任务自足、`- [ ] **Step N**` 切分、每步完整代码 + 精确命令 + 期望输出、变异表、投影与实测并列）。

---

## 已核实的前提（不要重新发明）

0. **执行前提：实现者从「仓库 + 本 Task 的小节」出发工作，不必重读整个计划。** 计划里出现的**已有**文件一律**直接读文件**；只有本 Task 要新建的文件才照代码块写。改动已有文件的步骤给的是"改动处 + 引足上下文"，能唯一定位到那几行。
1. **基线：开工前先自己跑一次** `npx vitest run`，把 `Tests N passed / M files` 记在本行（单元 B 收口时的读数是 **52 files / 983 passed**，**以命令输出为准**；本计划不把任何会漂的总数当读数用）。本计划的**投影**只在「验收对照表」里出现，且与实测并列。
2. **每一个符号都在仓库里核对过**（见下表）。计划里不许出现没核对过的名字——这是本仓的纪律，不是洁癖。

### 符号核对表（写计划时逐个 grep/read 过）

| 符号 | 出处 | 本计划里怎么用 |
| --- | --- | --- |
| `EngineProfile` | `src/shared/settings.ts:21` | C1 改形状（`model` → `models` + `activeModel`） |
| `CURRENT_VERSION` | `src/shared/settings.ts:135` | C1：3 → 4 |
| `LEGACY_PROFILE_ID` | `src/shared/settings.ts:141` | 不动；C1 的 v1/v2 迁移用例引用它 |
| `PROVIDER_PRESETS` | `src/shared/settings.ts:66` | C4：`自定义`徽章判据 + 模板预填 |
| `createProfileId` | `src/shared/settings.ts:33` | 不动 |
| `isAllowedBaseUrl` | `src/shared/settings.ts:218` | 不动（设置页与存储层共用同一判据） |
| `pickProfile` / `pickProfiles` | `src/shared/settings.ts:267` / `:287` | C1：读 `models` / `activeModel` |
| `mergeSettings` | `src/shared/settings.ts:308` | 不动（C1 只改它调用的 `pickProfiles`） |
| `resolveEngine` | `src/shared/settings.ts:343` | C1：`config.model` 取 `activeModel`；C2：加 `problem?` |
| `migrate` / `foldLegacyEngineConfig` | `src/shared/settings.ts:408` / `:437` | C1：加 `storedVersion < 4` 一步 |
| `loadSettings` / `loadUiSettings` / `saveSettings` | `src/shared/settings.ts:481` / `:510` / `:530` | 不动 |
| `DEFAULT_ENGINE_ID` / `OPENAI_COMPAT_ENGINE_ID` / `getEngine` | `src/engines/registry.ts:7` / `:14` / `:17` | 不动 |
| `MSG` / `isTranslateTextsMessage` | `src/shared/messages.ts:5` / `:69` | C3：加 `FETCH_MODELS` + `isFetchModelsMessage` |
| `EngineError` / `toEngineError` | `src/engines/types.ts:47` / `:59` | C3：错误归一化 |
| `extractErrorDetail` | `src/engines/api-error.ts:37` | C3：把响应正文挖出来（§5.3 点名复用） |
| `describeHttpError` / `statusToErrorCode` | `src/engines/api-error.ts:54` / `:73` | **不用**（`describeHttpError` 的措辞是翻译路径的；C3 自己分类） |
| `hasHostPermission` / `originPattern` / `requestHostPermission` | `src/shared/host-permission.ts:41` / `:32` / `:50` | **不改这个文件**；C3 的 `fetchModels` 按引擎的同一条纪律调用前两个（§5.5） |
| `setStatus` / `element` / `fillSelect` / `requireWithin` / `runSafely` / `describe` | `src/options/dom.ts:17` / `:26` / `:37` / `:52` / `:62` / `:22` | C4 全程用 |
| `SectionContext` / `Section` | `src/options/section.ts:28` / `:47` | 不动（`settings()` / `reload()` / `save()` 三个成员） |
| `NOT_LOADED` | `src/options/store.ts:46` | 不动（C4 的「新增档案」闸继续 import 它） |
| `EngineHealth` / `ENGINE_HEALTH_KEY` / `FREE_ENGINE_HEALTH_KEY` / `profileHealthKey` / `profileIdFromHealthKey` / `redactSecret` / `loadEngineHealth` / `saveEngineHealth` / `forgetEngineHealth` | `src/options/engine-health.ts:17` / `:25` / `:57` / `:60` / `:65` / 同文件后段 / 同文件后段 | 不动 |
| `engineSection` / `NEW_DRAFT_ID` / `TEST_TEXT` / `TEST_TIMEOUT_MS` | `src/options/sections/engine.ts:702` / `:68` / `:71` / `:77` | C0/C1/C4 改这个文件 |
| `rowById` / `readEditor` / `validateProfileForm` / `applyDot` / `buildFreeEngineRow` / `buildEditor` / `buildProfileRow` / `renderProfiles` / `renderEngineHint` / `runConnectionTest` / `recordHealth` / `rowForKey` / `healthDot` / `renderFromStorage` / `toggleKeyVisibility` / `applyProviderTemplate` | `src/options/sections/engine.ts:96` / `:104` / `:118` / `:165` / `:189` / `:211` / `:298` / `:343` / `:361` / `:445` / `:524` / `:495` / `:507` / `:661` / `:677` / `:694` | 同上 |
| `configHash` 里的 `model` | `src/background/scheduler.ts:188-190` | §4 的前提（**已经含 model**，不需要改） |
| `handleTranslateTexts` / `onMessage` 路由 | `src/background/service-worker.ts:86` / `:120` | C2 加前置闸、C3 加第二条消息 |
| `engineSelect` / `engineOptions` / `applySettings` / `renderEngineHint` / `saveSettingsOrReport` / `onEngineChange` | `src/popup/popup.ts:31` / `:68` / `:77` / `:230` / `:378` / `:480` | C2（提示）+ C5（下拉） |
| `profileSeed` / `pick` / `profileRows` / `rowOf` / `editorOf` / `fieldOf` / `actionButton` / `expand` / `bubble` / `seedSettings` / `storedSettings` / `storedProfiles` / `settle` / `waitFor` / `loadOptions` / `engineStatus` / `jsonResponse` / `chatResponse` | `tests/options/harness.ts:44` / `:48` / `:55` / `:59` / `:65` / `:71` / `:77` / `:84` / `:93` / `:98` / `:103` / `:108` / `:119` / `:124` / `:133` / `:139` / `:147` / `:152` | C1/C4 增改夹具 |
| `ChromeStub` / `runtime.dispatchMessage` / `runtime.sendMessage` / `runtime.sentMessages` / `runtime.noReceiver` / `ChromeStub.permissions`（成员本身在 `:277`，`:185` 是它引用的 `StubPermissions` 接口）/ `storage.session` | `tests/helpers/chrome-stub.ts:273` / `:270` / `:259` / `:263` / `:261` / `:277`（接口在 `:185`）/ `:274` | C3/C4/C5 断言用；**不改这个文件** |

### 契约属性清单（现状，逐条都要保住）

| 契约 | 现在在哪用 | 本单元怎么处理 |
| --- | --- | --- |
| `#profiles` | `profileRows()`（`harness.ts:56`） | 保留 |
| `#engine-status` | `engineStatus()`（`harness.ts:140`） | 保留（文案除新增外一字不改） |
| `#add-profile` | 新增档案 | 保留 |
| `.profile-row[data-profile-id]` | `profileRows()` / `rowOf()` | 保留（**行本身不再是按钮**） |
| `[data-action="toggle"]` | `harness.ts:88` 的 `expand()`、`engine-health.test.ts` **9 处**（`:172` `:203` `:218` `:263` `:291` `:313` `:409` `:442` 是"点它展开"；`:346` 是**负向**断言 `free!.querySelector('[data-action="toggle"]')` 必须为 null） | **保留这个值**，但按钮从"整行摘要"变成折叠行右侧的 `编辑`。`:346` **不需要迁移**（它断的是免费引擎行上没有这个按钮——与本单元无关），但**别把上面那串行号当完备清单**：它是"我逐个 grep 过"的记录，不是证明 |
| `[data-action="save-profile"]` / `test-profile` | `options.test.ts` 多处 / `engine-health.test.ts` 多处 | 保留（`save-profile` 的文案从「保存档案」改成「保存」；**状态行文案一字不改**） |
| `[data-action="delete-profile"]` | `options.test.ts:520/544/585/627`、`engine-health.test.ts:220` **都在编辑器里查** | **移到折叠行**；这 5 处改成从行上查（断言强度不变，见 C4 的迁移表） |
| `.profile-editor` | `editorOf()`（`harness.ts:66`）、`expand()` | 保留（仍在行**内部**、仍是 `.profile-row` 的子节点） |
| `.profile-label` `.profile-base-url` `.profile-api-key` `.profile-toggle-key` `.profile-provider` | `fieldOf()` / `options.test.ts:117/152/289` | 保留 |
| `.profile-model-name` | `options.test.ts` **14 行**、`engine-health.test.ts:239` | **移交给夹具**：C1 加 `setModel()`/`currentModel()` 两个 helper，这些调用点改成调它们；C4 改 helper 的实现并**删掉**这个控件。14 行逐个都在 C4 Step 6b 的迁移表里（`:150` `:260` `:299` `:304` `:305` `:307` `:329` `:384` `:395` `:414` `:444` `:466` `:483` `:657`） |
| `.dot[data-state]` | `engine-health.test.ts` 的 `dotOf()` | 保留（折叠行里还是 `.dot`） |
| `[data-engine-free]` | `engine-health.test.ts:71/122/345` | 保留（免费行不加 `data-profile-id`、不加 `toggle`/`delete-profile`） |
| `.badge` | 「使用中」/「内置」 | 保留；新增 `.badge-muted`（`自定义`） |

**新增契约一律用新名**：`data-template="custom"`（`自定义`徽章）、`data-action` 的 `cancel-profile` / `add-model` / `confirm-model` / `cancel-model` / `use-model` / `remove-model` / `fetch-models` / `merge-models` / `cancel-fetched`、`.models-field` / `.models-list` / `.model-row[data-model]` / `[data-current]` / `.model-actions` / `.model-new-row` / `.profile-model-new` / `.models-fetched` / `.profile-model-pick` / `.row-actions` / `.profile-advanced` / `#model-field` / `#model`（弹窗）。

---

## 需要评审先点头的 14 个决定（规格没说清或与现状冲突的地方）

> 每条都不改规格的**意图**，但必须由你确认口径。每条都给了"为什么不能照字面做"。

1. **C1 要带一层"过渡读取映射"，而且 C1 不许独立发布。** C1 只改数据模型与存储契约，档案编辑面板**仍是**"一个模型名输入框"（旧 UI 驱动新字段）；C4 才把它换成模型目录。为了让 C1 结束时全量测试**仍然全绿**，C1 在 `sections/engine.ts` 里加一层 `modelsFromSingleInput()`：输入框里那一个模型名 = 整个清单。**这层映射是有损的**（多模型清单会被压成一个），它存在的唯一理由就是"C1 与 C4 之间既有用例不许红"。→ **C1 落地后不许合进 release 分支**，C4 落地时把它连同输入框一起删掉（C4 有一条用例正面断言 `.profile-model-name` 不再存在）。
2. **`activeModel` 在读取边界上置 `''`，不替用户挑一个。** 规格 §3.1 的"取 `models` 最后一个"是**删除动作**的自愈（用户刚删掉当前模型，他显然还想用这个档案）。读取边界不同：存储说"没选"，读取层替他选一个，就等于"用户没选、插件选了，下一次翻译就用了它"——那正是 §3.3 要避免的形状。代价写进规格 §10.1 第 9 条。
3. **展开的触发从"整行"改成"「编辑」按钮"，但 `data-action` 仍然是 `toggle`。** 折叠行右侧现在有「删除」，整行可点会把删除变成误触；而 `toggle` 这个值被 `harness.ts:88` 与 8 处既有用例按契约引用，改名的收益是零、代价是 8 处迁移。
4. **`自定义`徽章的判据是"`baseUrl` 与某个预设逐字相同"。** 不看模型清单：徽章回答的是"这个档案接的是哪一家"，地址是那个问题的唯一答案（模型清单增减不改变"这是 DeepSeek 的地址"）。刻意不做尾斜杠归一化——判据越"聪明"，用户越难预测。（`custom` 预设没有 `baseUrl`，所以永远不参与匹配。）
5. **`自定义设置` 默认展开只看 `baseUrl` 是否为空**（不折叠的另一种情形："模板 = 自定义"**不**触发展开）。理由在规格 §6.2 第 3 条。
6. **手填 `+ 添加模型` 成功即设为当前；拉取并入只在清单原本为空时把并入的第一项设为当前。** 详规 §6.2 第 4 条（不这么定，"点『添加模型』"这句提示就解决不了 §3.3 那个错误）。
7. **参考图那句虚线说明必须改写**，因为它的两句对我们都不成立（§6.2 第 4 条的引文）。新句子逐句为真，并由一条用例钉住（C4）。
8. **两个折叠行元素是对参考图的偏离**：次级 meta 行（`接口地址 · 当前模型`）与可编辑的名字输入框。记账见「参考图 → DOM 映射」。
9. **`resolveEngine` 加 `problem?: string`，不抛错。** 弹窗在同步渲染函数里调它，抛错会把整个提示区变成异常路径。零请求由**两处**保证：引擎自己的空 `model` 闸（`openai-compat.ts:67`，已存在、构造性成立）+ 后台的前置闸（C2 新增，负责给出规格指定的那句话）。为什么不把这句话塞进引擎：引擎是通用的 OpenAI 兼容适配器，它不知道"档案""模型清单"这些词。
10. **`/models` 超时用独立常量 `MODELS_TIMEOUT_MS = 10_000`**，放 `src/background/models.ts`；**不复用** `src/content/index.ts:86` 的 `BACKGROUND_TIMEOUT_MS`（那是 60 秒的整页翻译预算，语义完全不同）。
11. **"零自动拉取"的成对断言只能落在 C4**，因为那里才有「获取可用模型」这个**正极**。C3 阶段不写这条：那时没有任何调用方，负向断言会因为"分支根本没执行"而永远绿（本仓总结的七种假信号成因②）。C3 只做后台侧与消息形状。
12. **换模型后的提示总是显示**（不管当前页面翻没翻译）。规格 §7 明确要求换完就给那句话；本文件其它下拉（目标语言、显示模式）用的是"页面已翻译时才说"，那是它们的口径（改动只在**下一次**翻译生效、页面没翻译时没什么可说的）。这里照 §7 走，并在注释里写明为什么与邻居不同。
13. **`删除` 从编辑面板移到折叠行**，`保存档案` 文案改成 `保存`。5 处既有用例改点击位置、0 处允许放宽断言（C4 有完整的迁移表）。
14. **不许新增图标依赖**：只用 `⟳`（搜索框已有 `⌕` 先例）。PUA 字形有已知限制。

---

## 参考图 → DOM 映射（含三处有意偏离的记账）

| 参考图里的东西 | 本计划的 DOM | 关系 |
| --- | --- | --- |
| 折叠行：名字 + 状态点 | `.profile-row > .grow > .line > .name` + `.dot[data-state]` | 一致 |
| 折叠行的 `[编辑]` | `<button data-action="toggle">编辑</button>`（在 `.row-actions` 里） | 一致 |
| 折叠行的 `[删除]` | `<button class="link-danger" data-action="delete-profile">删除</button>` | 一致（我们每个档案都有删除） |
| 「自定义」徽章 | `<span class="badge badge-muted" data-template="custom">自定义</span>` | 一致（判据见决定 4） |
| 展开面板首行：名字**文本** | `<input class="profile-label">` | **偏离二**（决定 8）：名字必须可编辑 |
| API 密钥 + `[显示]` + 「已配置——输入新值可替换」 | `.profile-api-key` + `.profile-toggle-key`（两者都已存在） | 一致 |
| 可折叠的「自定义设置」（模板下拉 + API 地址） | `<details class="profile-advanced">` + `.profile-provider` + `.profile-base-url` | 一致（默认展开规则见决定 5） |
| 模型目录：模型行 + 当前项 + `[设为当前][删除]` | `.model-row[data-model]` + `.badge` + `[data-action="use-model"|"remove-model"]` | 一致（当前项的 `设为当前` 是 `disabled`，不做死控件） |
| 虚线 `[ 添加模型 ]` | `<button class="add" data-action="add-model">+ 添加模型</button>` + 内联手填行 | 一致 |
| 右上角 `⟳ 获取可用模型` | `<button data-action="fetch-models">⟳ 获取可用模型</button>` | 一致（点它才发请求） |
| 虚线框说明「正在使用适配器默认模型」 | **不存在**：我们不引入默认模型表，`activeModel === ''` 仍是可读错误 + 零请求（§3.3） | **实质冲突 1，以我们的规格为准** |
| 虚线框说明「目录外 ID 仍可直接发送」 | **不存在**：不变量是 `activeModel === '' \|\| models.includes(activeModel)`，要换模型就加进清单 | **实质冲突 2，以我们的规格为准** |
| 底部 `[取消] [保存]` | `[data-action="cancel-profile"]` + `[data-action="save-profile"]` | 一致 + 我们多一个左侧 `测试连接`（§4.3 的状态点靠它） |
| （参考图没有）次级 meta 行 | `.meta`：`接口地址 · 当前模型` | **偏离一**（决定 8）：5 个档案时这是"一眼就该看见"的信息 |

---

## 硬规矩（每一步都要遵守）

1. **TDD**：先写失败测试 → 跑到红（**贴期望的失败形态**）→ 最小实现 → 跑到绿 → 变异验证 → 提交。C0 有一条用例在旧实现下**本来就是绿的**（见 C0 Step 2 的说明），别当成"红得不对"。
2. **每个守卫都要有变异读数**：说清"破坏它 → 恰好哪条用例红"。本仓的**七**种"杀不死 / 假信号"成因：① 断言查错侧；② 分支根本没执行；③ 成功路径被重绘/刷新掩盖；④ **断言跑在写入队列前面**（要 `await settle()` / `await waitFor(...)` 之后的稳态）；⑤ 被测层把断言要找的东西过滤掉了；⑥ 计划两半互相不满足（断言子串与代码产出对不上）；⑦ **测量工具复制了被测对象的错误口径**——探针/诊断读数里写下了与 bug 同源的假设，于是修好之后它仍然打出"没好"的假信号。
   - **⑦ 的实例（本单元真发生过）**：临时诊断探针（`src/options/perf-probe.ts`）里那一格 `action: target.dataset.action ?? '(none)'` 与当时被查的委托 bug **是同一个错口径**（都读 `event.target` 自己的 `data-action`）。修复落地后，真机上点行头文字（`span.meta`）**依然打印 `action="(none)"`**，而功能其实已经好了——**差点让用户复测出一个假阴性**。同一份探针里本来就对的判据是 `expandedBefore` / `expandedAfter`（它用 `closest('[data-profile-id]')`，与被修的逻辑不同源）。
   - **一句话教训：探针要独立于被测逻辑的假设——否则它会把"修好了"测成"没好"，比没有探针更坏。** 写诊断读数时先问一句："这一格读的东西，与被怀疑的那行代码读的是**同一个表达式**吗？"是，就换一个独立判据（状态、DOM 结构、副作用次数），别复用它。
   - **"换成恒真式后全绿"只证明没有别的用例依赖它，不证明它恒真。**
   - **变异形状要精确到对称/不对称**：同一个说法"去掉某判断"，对称还原与不对称还原的红条数不同。
3. **既有断言只许加强、不许放松。** 本单元有一批既有断言因契约改名必须迁移（C1：存储形状与档案字段字面量；C4：删除按钮的点击位置与模型交互），迁移表逐条给出"改动前 → 改动后"，每一处都**只增不减**（例如 `stored.model` → `stored.activeModel` **并且**补上 `stored.models`；`actionButton(editor, 'delete-profile')` → `rowButton(id, 'delete-profile')`，其余断言一个字不动）。测试名要说明它**为什么存在**。
4. **`noUnusedLocals: true`**（`tsconfig.json` 与 `tsconfig.node.json` 两处都开）；`noUnusedParameters` **故意关着**（想留参数就留，但别新增没用的）。
5. **`src/options/**` 不许出现 `innerHTML` / `outerHTML` / `insertAdjacentHTML`**（`tests/options/no-innerhtml.test.ts` 按**裸标识符**扫源码文本、**连注释一起扫**）。用户数据只走 `textContent` / `.value`。**写注释时也别写出这三个标识符**。
6. **CSS 颜色只用 `:root` 令牌**，不许硬编码（连 `#fff` 都不行）；次级文字不许用 `opacity`（`options-css.test.ts` 用真解析守着）。新增的颜色令牌必须同时出现在暗色块里（暗色块已经定义了 `--text-2` / `--surface-3`，所以新增规则直接用它们即可）。
7. **HTML 代码块里不许出现字面 `**`**（用 `<strong>`），否则会原样上屏。HTML/CSS 是"手工同步块"，`sync-plan-code.mjs` 不认它们。
8. **代码块的标记纪律**：**整文件**块的首行写 `// <仓库相对路径>`（会被 `sync-plan-code.mjs` 对齐成仓库内容）；**片段**块的首行写成 `// <仓库相对路径>（片段…）`——带后缀就不会被那个脚本的 `PATH_LABEL` 正则认出来，因而不会被整文件覆盖。违反这条的后果是"跑一次 sync 就把片段冲成整文件"。
9. **计划里不写会漂的数字**：行号、用例总数、行数一律写"以命令输出为准"，或写成"投影 vs 实测"两个数并列。
10. **任务之间不许有前向引用**（不写"见 Task N"）：每个任务自带它需要的全部代码与命令。
11. **pwsh 5.1 的 `Set-Content` / `Get-Content` 会破坏 UTF-8**：文件读写一律用编辑 / 写入工具；命令只用来跑 `npx vitest run` / `git` / `node scripts/*.mjs`。
12. **提交只用路径限定**：`git commit -m "…" -- <两个显式路径>`。**禁止整树 VCS 操作**：`git stash` / `git restore` / `git checkout -- .` / `git reset --hard` 一律不许用。**路径限定的 `git checkout <commit> -- <你自己已经提交的那几个文件>` 可以接受**，但必须同时满足两个前提：**只碰你自己的文件**、**你的改动已经提交**（否则你会把自己还没提交的工作覆盖掉）。取"改前读数"要优先用 `%TEMP%` 里的自建副本（单元 B 的做法），别在共享工作区里来回 checkout。
13. **在 jsdom / vitest 里证明"还是同一个节点"只能用 `toBe` / `===`**（`Set.has` / `Array.includes` 这类 SameValueZero 比较也算）。**`toEqual` / `toStrictEqual` 都不能当身份断言**——vitest 5.0.0 对 DOM 节点走的是**结构比较**：`node_modules/vitest/dist/chunks/index.OVGXnVRj.js:1289` 那一行是
    `if (isDomNode(a) && isDomNode(b)) return a.isEqualNode(b);`（判据函数 `isDomNode` 在同文件 `:1356`，只看 `nodeType` / `nodeName` / `isEqualNode` 在不在）。
    ⚠ 那个 chunk 文件名里的哈希是**装出来的**（版本一变就换名），所以引用时用**符号**（`isDomNode` / `isEqualNode`）定位，别只记路径。DOM 节点是**宿主对象**、没有可枚举的自有属性（`Object.keys(node)` 是 `[]`），所以结构比较**完全**由上面那个 DOM 分支实现；`toStrictEqual` 走同一条分支，一样失效（全仓 `tests/` 今天一处都没用它）。反过来也一样——要断言"结构/内容一样"就用 `toEqual`，别用 `toBe`。
14. **对未跟踪的新文件，路径限定 commit 必须先把路径 `git add` 一遍**：`git commit -m … -- <新文件>` 会报 `error: pathspec '<新文件>' did not match any file(s) known to git`（git 只认它已知的路径）。正确形态：**先 `git add -- <显式路径>`，再跑同一条路径限定 commit**。仍然**不许**整树 `git add -A` / `git add .`。C0 / C3 / C4 三个 Task 各新建了测试文件或源码文件，它们的提交步骤都已经按这条写好了。

### 附：DOM 身份断言盲区的清理账（`e9f7dd5`，写在这里防止后人夸大）

这条盲区在仓库里被清过一遍，账目如下，**引用这些数字时按下面的口径说**：

- `e9f7dd5` **只改 `tests/content/**` 六个文件**（+124/−23）：`observer.test.ts` 4 处、`index.test.ts` 4 处、`renderer.test.ts` 3 处、`extractor.test.ts` 2 处、`extractor-inline-carrier.test.ts` 1 处、`observer-rescan-guard.test.ts` 1 处——**14 处不在最初的清单里**（最初的清单只覆盖了本轮任务书点到的那几处，说明这个盲区是"扫一遍才看得全"的）。
- 共 **19 处**从 `toEqual` 改成 `toBe` / `===`。其中 **2 处是纯加法**：只加一条 `===` 的身份断言，**原结构匹配器逐字保留**（"结构一样"与"同一个对象"是两件事，两条都要）。
- **用例条数不变（478 → 478）**，改前改后同一批用例全绿——这正说明旧写法是**假通过**：它从来没红过，也就从来没守过身份。
- **读数怎么读才诚实（别夸大）**：那 19 组配对读数（旧写法在同构克隆体的世界里绿、新写法红）证明的是**断言的判别力**，**不是**某个具体业务缺陷的复现——把"期望侧"换成同构克隆体，与"被测代码送来一个同构副本"在断言处**不可区分**。所以**不许把它写成"修掉了 19 个 bug"**；正确的说法是"19 处身份断言原本没有判别力，现在有了"。

---

## 文件结构

| 文件 | 动作 | 责任 |
| --- | --- | --- |
| `src/options/sections/engine.ts` | 修改（C0/C1/C4） | 展开就地更新；过渡读取映射（C1，C4 删）；折叠行 + 编辑面板重排；模型目录 UI；拉取按钮的调用方 |
| `src/options/options.html` | 修改（C4） | 引擎区块的 `.hint` 文案（「模型名」→「模型清单」、`保存档案` → `保存`） |
| `src/options/options.css` | 修改（C4） | `.row-actions` / `.badge-muted` / 模型目录区；删掉 `.profile-summary` 两条死规则 |
| `src/shared/settings.ts` | 修改（C1/C2） | v4 数据模型、迁移、`pickProfile` 容错、`resolveEngine` 的 `problem` |
| `src/shared/messages.ts` | 修改（C3） | `MSG.FETCH_MODELS` + 请求/响应类型 + 运行时校验器 |
| `src/background/models.ts` | **新建**（C3） | `/models` 拉取：URL、鉴权、10 秒超时、三种形状的宽容解析、失败分类 |
| `src/background/service-worker.ts` | 修改（C2/C3） | 前置闸（无当前模型 → 零请求 + 可读错误）；第二条消息路由 |
| `src/popup/popup.ts` | 修改（C2/C5） | 提示区认 `problem`；模型下拉（仅 > 1 项）+ 换模型写 `activeModel` + 那句提示 |
| `src/popup/popup.html` | 修改（C5） | `#model-field` + `#model`（默认 `hidden`） |
| `src/popup/popup.css` | 修改（C5） | `.field[hidden] { display: none }`（`.field` 是 flex，会盖掉 UA 的 `[hidden]`——与已有的 `.hint[hidden]` 同一条道理） |
| `tests/options/harness.ts` | 修改（C1/C4） | `profileSeed` 换 v4 形状；新增 `setModel` / `currentModel` / `rowButton` |
| `tests/options/engine-expansion.test.ts` | **新建**（C0） | 展开的代价曲线 + "展开 A 再展开 B" |
| `tests/options/engine-models.test.ts` | **新建**（C4） | 折叠行结构、编辑面板、模型目录、取消、零自动拉取、拉取结果勾选 |
| `tests/shared/settings.test.ts` | 修改（C1/C2） | v4 迁移、`pickModels`/`activeModel` 边界、`resolveEngine` 的 `problem` |
| `tests/background/models.test.ts` | **新建**（C3） | 三种形状、失败分类、超时、URL/鉴权 |
| `tests/background/service-worker.test.ts` | 修改（C2/C3） | 前置闸的零请求（成对）、拉取的隐私断言（成对）、既有档案字面量迁移 |
| `tests/shared/messages.test.ts` | 修改（C3） | `isFetchModelsMessage` 的正反用例 |
| `tests/popup/popup.test.ts` | 修改（C2/C5） | 提示区认 `problem`；模型下拉三态、切档案记住、换模型的提示与回滚；既有档案字面量迁移 |
| `tests/options/options.test.ts` | 修改（C1/C4） | 既有契约迁移（全部只增不减） |
| `tests/options/engine-health.test.ts` | 修改（C4） | 2 处迁移（`setModel` / 行上的删除按钮） |
| `README.md` | 修改（C6） | 功能范围 + 已知限制 + 全量读数 |

**不动的文件**：`src/manifest.json`（`/models` 落在档案保存时已申请的 origin 范围内，**不需要新权限**）、`scripts/verify-dist.mjs`、`vite.config.ts`、任何 `src/core/**`（分层守卫不受影响）、`tests/helpers/chrome-stub.ts`（`runtime.sendMessage` / `dispatchMessage` / `sentMessages` / `noReceiver` 都已具备）。

---

## 任务概览（依赖顺序）

| # | 任务 | 依赖 | 主要产出 |
| --- | --- | --- | --- |
| C0 | 展开就地更新（修用户报的"点一下很慢"） | — | `sections/engine.ts` 的 `applyExpansion` / `insertDraftRow`、`engine-expansion.test.ts` |
| C1 | 数据模型 v4（`models` + `activeModel`）+ 迁移 + 容错 + 过渡映射 | C0 | `shared/settings.ts`、`sections/engine.ts`（映射）、`harness.ts`、既有夹具迁移 |
| C2 | `activeModel === ''` → 可读错误 + 零请求；`configHash` 前提 | C1 | `shared/settings.ts` 的 `problem`、`service-worker.ts` 前置闸、`popup.ts` 提示 |
| C3 | `/models` 后台拉取（消息 + 容忍解析 + 失败分类 + 隐私） | C1 | `shared/messages.ts`、`background/models.ts`、`service-worker.ts` 路由 |
| C4 | 设置页档案行 / 编辑面板重排 + 模型目录 + 取消 + 零自动拉取 | C1、C2、C3 | `sections/engine.ts` 大改、`options.html` / `options.css`、`engine-models.test.ts` |
| C5 | 弹窗模型下拉 + 记住上次用的模型 + 换模型提示 | C1、C2 | `popup.ts` / `popup.html` / `popup.css` |
| C6 | README 已知限制与收口（全量命令 + 读数） | C0–C5 | `README.md`、全量读数 |

---

## Task C0: 展开就地更新（修"点一下很慢"）

**Files:**
- Modify: `src/options/sections/engine.ts`
- Test: `tests/options/engine-expansion.test.ts`（新建）

> **根因（已核实）**：`renderProfiles()` 开头是 `profilesList.textContent = ''`，然后重造**所有档案行 + 免费引擎行**；而 `bind` 里 `case 'toggle'` 每次都调它。于是每次展开/收起都把整张列表推倒重建，代价随档案数线性增长（N 个档案 = N+1 行重建）——这是用户报的「点一下反应很慢」的直接原因。
>
> **改法**：展开/收起只动受影响的那一两行（把编辑器插进 / 移出那一行、更新 `aria-expanded`；展开新的之前把上一个的编辑器移除）。`renderProfiles` 只留给"数据真的变了"的路径：挂载 / 保存后 / 删除后 / 重载。
>
> **验收到哪一步（必须写进交付说明）**：本机没有浏览器，所以只到 **jsdom 里的"代价不随档案数增长"读数**——单次展开的 DOM 变更量（`MutationObserver` 数增删节点）。**真机绝对耗时测不了**；用户复测若仍慢，下一步是加临时 `console` 计时探针定位。
>
> **落地实测（`35488b2`，本 Task 已实现并提交）**：三条用例与本节代码一致；实现者另加了一条**纯加强**的身份断言（`after.slice(0, 3).map((row, index) => row === before[index])` → `[true, true, true]`），并把本节原来那句"前三行还是原来那三个节点"的**期望红**纠正成真报文。**本节已按落地现实改过**（Step 1 的注释、Step 2 的期望红、Step 6 的两行变异机制），改的就是同一件事：**身份读数只能来自 `toBe` / `===`，`toEqual` 对 DOM 元素是结构比较**（已写进「硬规矩」）。下面「落地读数表」里 C0 那两行仍以命令输出为准。
>
> **后续落地（`7991539`，真机缺陷修复，也落在 `engine-expansion.test.ts`）**：用户真机复测报"点档案行头里的文字没反应"——行头是 `<button class="profile-summary">` 里包着 `span.name` / `span.meta` / `.dot`，点在文字上时 `event.target` 是那些 span，读 `target.dataset.action` 得到 `undefined`、`switch` 全部落空。修复把 click 委托的动作来源改成 `target.closest('[data-action]')`，并加了一道 `row.contains(actionEl)` 闸（防动作元素串到别的行）。该提交另加**两条用例**（点 `.meta` 就展开；连点 `.meta` 两次 = 展开再收起），变异读数：退回 `target.dataset.action` → **恰好这两条红**，其余展开用例仍绿。**所以这个测试文件现在不止三条用例**，而 **Task C4 的 click 委托片段必须沿用这个口径**（见 C4 Step 3m 的警告）——否则会把真机修好的 bug 改回去，而红的正是那两条新用例。
>
> **一处行为增量（C0 引入 → 契约已在 C4 定死）**：草稿行展开着时去点真档案的展开按钮——旧实现把草稿行**整行抹掉**，新实现**行留在列表里、只是收起**。
> **直接读数已经取到（探针跑完已删）**：新实现 `ids=["p-a","__new__"]`、`draftRowExists=true`，但**切回草稿行四个字段全空**；旧实现 `ids=["p-a"]`、`draftRowExists=false`。而且**真档案行一样丢**（收起再展开回落到存储值）——编辑器由 `buildEditor` 从快照重建，DOM 里敲的字没有任何人接，这是**既有行为**，不是 C0 引入的。
> **所以"不会丢数据"这个说法是错的**，正确说法是"C0 之后草稿行不再整行消失，但未保存的输入在任何收起路径下仍然丢失"。**裁决**：C4 引入每行的内存暂存，让**隐式收起**保留输入、**`取消`** 丢弃它（见 Task C4 开头的裁决块与规格 §9 第 19 条）；文案纪律同在那里。

- [ ] **Step 1: 写失败测试**

创建 `tests/options/engine-expansion.test.ts`：

```ts
// tests/options/engine-expansion.test.ts
/**
 * @vitest-environment jsdom
 *
 * 展开 / 收起是**就地更新**，不是整表重建。
 *
 * 为什么这条值得一个文件：改之前 `bind` 里 `case 'toggle'` 直接调 `renderProfiles`，而那个
 * 函数开头清空整张列表再重建所有行——用户点一次展开的代价随档案数线性增长（N 个档案 = N+1 行）。
 *
 * **读数不是耗时**：本机没有浏览器，jsdom 的毫秒数会飘，本仓已有先例（"为'有守卫'写一条量出来
 * 会飘的断言，不如不写"）。这里数的是**单次展开对 DOM 的改动量**：`MutationObserver` 的
 * `childList` 记录里增删的节点数。它与 N 无关，才是"就地"；旧实现是 2(N+1)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { loadOptions, pick, profileRows, profileSeed, resetOptionsPage, seedSettings, settle } from './harness';

/**
 * 造 N 个档案（id 依次 `p-0`…`p-N-1`）。
 * 刻意**只给 id 与 label**：这条用例关心的是列表规模，不是档案的字段形状
 * （C1 把 `model` 换成 `models` + `activeModel` 时，这里一行都不用改）。
 */
function seeds(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_unused, index) => profileSeed({ id: `p-${index}`, label: `档案 ${index}` }));
}

function rowOf(id: string): HTMLElement {
  const row = profileRows().find((candidate) => candidate.dataset.profileId === id);
  if (row === undefined) throw new Error(`没有档案行 ${id}`);
  return row;
}

function triggerOf(id: string): HTMLButtonElement {
  const trigger = rowOf(id).querySelector<HTMLButtonElement>('[data-action="toggle"]');
  if (trigger === null) throw new Error(`档案行 ${id} 没有展开按钮`);
  return trigger;
}

function editorOf(id: string): Element | null {
  return rowOf(id).querySelector('.profile-editor');
}

/**
 * 点某一行的展开按钮，并等 `MutationObserver` 把这次改动的记录交上来。
 *
 * **不能在 `settle()` 之后另起一个观察者读**：那样读到的是"点击前后两次 DOM 状态之差"，
 * 中间插进来的任何重绘都会被算进去。观察者回调本身就是一次微任务，等它比数宏任务轮次稳。
 */
async function toggleAndCount(id: string): Promise<{ added: number; removed: number }> {
  const trigger = triggerOf(id);
  const records = await new Promise<MutationRecord[]>((resolve) => {
    const observer = new MutationObserver((list) => {
      observer.disconnect();
      resolve(list);
    });
    observer.observe(pick<HTMLElement>('profiles'), { childList: true, subtree: true });
    trigger.click();
  });
  return {
    added: records.reduce((sum, record) => sum + record.addedNodes.length, 0),
    removed: records.reduce((sum, record) => sum + record.removedNodes.length, 0),
  };
}

beforeEach(() => {
  resetOptionsPage();
});

describe('展开就地更新：代价不随档案数增长', () => {
  it('单次展开的 DOM 改动量在 N=5/20/50 下都一样（展开=插 1 个节点，切换=插 1 删 1）', async () => {
    for (const count of [5, 20, 50]) {
      resetOptionsPage();
      await seedSettings({ engineId: 'p-0', profiles: seeds(count) });
      await loadOptions();
      expect(profileRows()).toHaveLength(count);

      // 第一次：从"全部收起"展开一行 → 只该插入这一个编辑器，一个节点都不该删。
      const first = await toggleAndCount('p-0');
      expect([count, first.added, first.removed]).toEqual([count, 1, 0]);

      // 第二次：展开另一行 → 插入新的 + 摘掉上一个，仍然与 N 无关。
      // 旧实现在这里是 added=N+1、removed=N+1（N=5→6/6、N=20→21/21、N=50→51/51）。
      const second = await toggleAndCount(`p-${count - 1}`);
      expect([count, second.added, second.removed]).toEqual([count, 1, 1]);
    }
  });

  it('展开 A 再展开 B：A 收起，A 的编辑器不在 DOM 里、aria-expanded 回到 false', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ id: 'p-a' }), profileSeed({ id: 'p-b', label: '另一家' })],
    });
    await loadOptions();

    // 这条在**旧实现下本来就是绿的**（整表重建也会把 A 的编辑器摘掉）。
    // 它守的不是"改前必红"，而是新实现的三个不变式：
    //   ① 展开新的之前必须摘掉旧的（删掉 `existing.remove()` → 这里红）；
    //   ② 触发按钮的 `aria-expanded` 必须跟着走（删掉那次 setAttribute → 这里红）；
    //   ③ 再点自己一次要收起（把 `expandedId = expandedId === id ? null : id` 写成 `= id` → 这里红）。
    triggerOf('p-a').click();
    await settle();
    expect(editorOf('p-a')).not.toBeNull();
    expect(triggerOf('p-a').getAttribute('aria-expanded')).toBe('true');
    expect(triggerOf('p-b').getAttribute('aria-expanded')).toBe('false');

    triggerOf('p-b').click();
    await settle();
    expect(editorOf('p-b')).not.toBeNull();
    expect(editorOf('p-a')).toBeNull();
    expect(triggerOf('p-a').getAttribute('aria-expanded')).toBe('false');
    expect(triggerOf('p-b').getAttribute('aria-expanded')).toBe('true');

    triggerOf('p-b').click();
    await settle();
    expect(editorOf('p-b')).toBeNull();
    expect(triggerOf('p-b').getAttribute('aria-expanded')).toBe('false');
  });

  it('新增档案那一行也是就地追加：不动已有的行', async () => {
    // 草稿行的插入走 `insertDraftRow`（只 append 一行，排在免费引擎行之前），不是 `renderProfiles`。
    // 断言的读数是"已有行的 **DOM 节点身份**没变"。
    //
    // ⚠ **身份只能用 `toBe` / `===` 证明**（硬规矩 13，含 vitest 源码级的机制出处）：`toEqual` 对
    // DOM 元素是**结构比较**（vitest 里走 `isDomNode` → `a.isEqualNode(b)`）——jsdom 里两个各造一次
    // 的 `<div class="profile-row item" data-profile-id="p-0">` 属性一样就算"相等"。
    // 拿 `toEqual` 当身份断言会**假绿**（实测：整表重建的旧实现下 `toEqual(before)` 照样通过）。
    await seedSettings({ engineId: 'p-0', profiles: seeds(3) });
    await loadOptions();
    const before = profileRows();
    const freeBefore = pick<HTMLElement>('profiles').querySelector('[data-engine-free]');

    pick<HTMLButtonElement>('add-profile').click();
    await settle();

    const after = profileRows();
    expect(after).toHaveLength(4);
    expect(after[3].dataset.profileId).toBe('__new__');
    // 前三行还是原来那三个节点（逐项 `===`：身份，不是结构）。
    expect(after.slice(0, 3).map((row, index) => row === before[index])).toEqual([true, true, true]);
    // 免费引擎那一行也还是原来那个节点（`toBe` 是身份比较），而且排在草稿行之后。
    expect(pick<HTMLElement>('profiles').querySelector('[data-engine-free]')).toBe(freeBefore);
    expect(after[3].nextElementSibling).toBe(freeBefore);
    // 草稿行展开着（新增档案的语义就是"当场开始填"）。
    expect(after[3].querySelector('.profile-editor')).not.toBeNull();
  });
});
```

- [ ] **Step 2: 跑到红（贴期望的失败形态）**

Run: `npx vitest run tests/options/engine-expansion.test.ts`

Expected:
- 第 1 条 **FAIL**：`expected [ 5, 6, 6 ] to deeply equal [ 5, 1, 0 ]`（旧实现整表重建：清空 N+1 个子节点 + 重造 N+1 个）。
- 第 3 条 **FAIL**：报文是 **`Object.is equality`**（`expected <div …> to be <div …>`），落在**那两条 `toBe` 身份断言**上——落地实测落在免费引擎行那条（`querySelector('[data-engine-free]')` 在整表重建之后是一个**新造**的节点）。
  ⚠ **`toEqual` 那一行在旧实现下是绿的**（结构比较），所以这条用例的身份读数**全部**由 `toBe` / `===` 提供。别把期望红写成"`toEqual` 不相等"——那是写计划时的错判，落地时被实测纠正过。
- 第 2 条 **PASS**——**它本来就绿**（见用例里的注释）。别把它当成"红得不对"，也别为了让它红去改断言。

- [ ] **Step 3: 最小实现**

在 `src/options/sections/engine.ts` 里改三处。

**3a. 在 `renderProfiles` 之前插入两个新函数**（把下面这段放在 `renderProfiles` 的上一行）：

```ts
// src/options/sections/engine.ts（片段：新增 applyExpansion / insertDraftRow，放在 renderProfiles 之前）
/**
 * 展开 / 收起只动受影响的那一两行。
 *
 * 为什么不是 `renderProfiles(ctx)`：那个函数开头清空整张列表再重建（档案行 + 免费引擎行），
 * 于是**每次点开一个档案都要重建 N+1 行**——代价随档案数线性增长，用户点一下要等。
 * 展开只改两件东西：这一行触发按钮的 `aria-expanded`，以及这一行里**有没有** `.profile-editor`。
 * 列表结构、行顺序、免费引擎行、其它行通通不动。
 *
 * `renderProfiles` 只留给"数据真的变了"的路径：挂载、保存后、删除后、重载。
 */
function applyExpansion(ctx: SectionContext): void {
  const snapshot = ctx.settings();
  if (snapshot === null) return;
  for (const row of Array.from(profilesList.querySelectorAll<HTMLElement>('.profile-row[data-profile-id]'))) {
    const id = row.dataset.profileId as string;
    const expanded = id === expandedId;
    const trigger = row.querySelector('[data-action="toggle"]');
    if (trigger !== null) trigger.setAttribute('aria-expanded', String(expanded));
    const existing = row.querySelector('.profile-editor');
    if (expanded && existing === null) {
      const profile = id === NEW_DRAFT_ID ? undefined : snapshot.profiles.find((item) => item.id === id);
      row.append(buildEditor(id, profile));
    } else if (!expanded && existing !== null) {
      // "一次只展开一个"的执行点就是这一句：上一个展开的行在这里被摘掉。
      existing.remove();
    }
  }
}

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

**3b. 事件委托里的 `case 'toggle'`**（改动处，前后各引一行上下文）：

```ts
// src/options/sections/engine.ts（片段：bind 的 click 委托）
        case 'toggle':
          if (ctx.settings() === null) return;
          // 一次只展开一个：把上一个的编辑器摘掉这件事由 applyExpansion 做（就地，不重建列表）。
          expandedId = expandedId === id ? null : id;
          applyExpansion(ctx);
          break;
```

**3c. 「新增档案」按钮**：

```ts
// src/options/sections/engine.ts（片段：bind 末尾的 addProfileButton）
    addProfileButton.addEventListener('click', () => {
      if (ctx.settings() === null) {
        setStatus(engineStatus, 'err', NOT_LOADED);
        return;
      }
      if (expandedId === NEW_DRAFT_ID) return;
      // 先把状态落定再插行：`buildProfileRow` 读 `expandedId` 决定要不要带编辑器。
      expandedId = NEW_DRAFT_ID;
      insertDraftRow(ctx);
      applyExpansion(ctx);
    });
```

- [ ] **Step 4: 跑到绿**

Run: `npx vitest run tests/options/engine-expansion.test.ts`

Expected: `Tests  3 passed (3)`。**同时**把受影响的既有文件跑一遍，确认一条都没红：

Run: `npx vitest run tests/options`

Expected: 全绿（`options.test.ts` / `engine-health.test.ts` 等一条都不许红——展开路径变了，但它们都是按 `[data-action="toggle"]` 点的）。

- [ ] **Step 5: 记录代价读数（投影 vs 实测）**

在 Step 4 的命令输出里把第 1 条用例的读数抄进交付说明，与本表的**投影**并列：

| 读法 | 旧实现（投影） | 新实现（投影） | 新实现（实测） |
| --- | --- | --- | --- |
| N=5 单次展开 `{added, removed}` | `{6, 6}` | `{1, 0}` | 以命令输出为准 |
| N=20 单次展开 | `{21, 21}` | `{1, 0}` | 同上 |
| N=50 单次展开 | `{51, 51}` | `{1, 0}` | 同上 |
| A→B 切换 `{added, removed}`（任意 N） | `{N+1, N+1}` | `{1, 1}` | 同上 |

> 旧实现那一列是**按代码推出来的投影**（`renderProfiles` 里 `textContent = ''` 一次删 N+1 个子节点，随后 N+1 次 append 各插 1 个），**不是实测**——执行时若想拿实测，把 Step 3 的改动临时还原即可。**不要**把这个数写进任何断言：断言只钉"与 N 无关"（形状），不钉具体节点数以外的量。

- [ ] **Step 6: 变异验证**

| 变异 | 期望红在哪一条 |
| --- | --- |
| `applyExpansion(ctx)` 换回 `renderProfiles(ctx)`（回到整表重建） | 「单次展开的 DOM 改动量…」——`first.added` 变成 6 / 21 / 51 |
| 删掉 `existing.remove()` 那一支（只加不减） | 「展开 A 再展开 B」——`editorOf('p-a')` 不为 null；同时代价用例的 `second.removed` 变成 0 |
| 删掉 `trigger.setAttribute('aria-expanded', …)` | 「展开 A 再展开 B」——A 的 `aria-expanded` 停在 `'true'`（重复点 B 时 B 的也停在 true） |
| `expandedId = expandedId === id ? null : id` 改成 `expandedId = id`（**不对称**：点两次不再收起） | 「展开 A 再展开 B」最后一段——`editorOf('p-b')` 不为 null |
| `const expanded = id === expandedId` 反写成 `id !== expandedId` | 三条全红（展开的那一行拿不到编辑器，收起的那一行反而拿到） |
| `insertDraftRow` 换回 `renderProfiles` | 「新增档案那一行也是就地追加」——**免费引擎行不再是同一个节点**（`Object.is equality` 红，落在 `querySelector('[data-engine-free]')` 那条 `toBe` 上）。⚠ 这个变异**只有 `toBe` / `===` 抓得住**：`after.slice(0,3).map(… === …)` 那半也红，但任何写成 `toEqual(before)` 的断言在它下面照样绿 |
| 删掉 `if (free === null) … else free.before(row)` 里的 `else` 分支（草稿行追加到末尾） | 「新增档案那一行也是就地追加」——`after[3].nextElementSibling` 不再是 `freeBefore`（`toBe` 红）；已有三行的身份不受影响（那一半仍绿），所以这条变异的读数**只**落在这两条 `toBe` 上 |

- [ ] **Step 7: 提交**

```bash
git add -- tests/options/engine-expansion.test.ts
git commit -m "perf(options): 展开/收起只动受影响的那一行，不再整表重建" -- src/options/sections/engine.ts tests/options/engine-expansion.test.ts
```

> 第一行是必须的：`engine-expansion.test.ts` 是**未跟踪的新文件**，直接跑路径限定 commit 会报 `error: pathspec 'tests/options/engine-expansion.test.ts' did not match any file(s) known to git`（硬规矩 14）。

---

## Task C1: 数据模型 v4（`models` + `activeModel`）

**Files:**
- Modify: `src/shared/settings.ts`（`EngineProfile` / `CURRENT_VERSION` / `pickProfile` / `migrate` / `resolveEngine`）
- Modify: `src/options/sections/engine.ts`（**过渡读取映射**，C4 删除；meta 行改读 `activeModel`）
- Modify: `tests/options/harness.ts`（`profileSeed` + 新增 `setModel` / `currentModel`）
- Modify: `tests/shared/settings.test.ts`、`tests/options/options.test.ts`、`tests/options/engine-health.test.ts`、`tests/popup/popup.test.ts`、`tests/background/service-worker.test.ts`（既有夹具与存储形状断言迁移）

> **这一件事为什么必须一次做完**：`EngineProfile` 是跨进程契约（存储 / 后台 / 弹窗 / 设置页 / 内容脚本投影）。分两次改字段，中间那一次全仓都编不过。所以 C1 的范围 = "类型 + 存储边界 + 迁移 + 把既有夹具迁到新形状 + 让既有面板继续工作（过渡映射）"。
>
> **过渡映射有损**（多模型清单会被压成一个），**C1 不许独立发布**——见「需要评审先点头的决定 1」。

- [ ] **Step 1: 写失败测试（存储边界与迁移）**

在 `tests/shared/settings.test.ts` 里**追加**两个 `describe`，并把顶部那个 `profile()` 夹具改成 v4 形状。

**1a. 顶部夹具**（改动处）：

```ts
// tests/shared/settings.test.ts（片段：顶部夹具）
/** 构造一份形状完整合法的档案；`over` 覆盖单个字段，用例只写自己在意的那部分。 */
function profile(over: Partial<EngineProfile> = {}): EngineProfile {
  return {
    id: 'p1',
    label: '我的 DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat'],
    activeModel: 'deepseek-chat',
    apiKey: 'sk-keep',
    ...over,
  };
}
```

**1b. 追加两个 describe**（放在 `describe('迁移 v2 → v3：单份 engineConfig 折成一个档案', …)` **之后**）：

```ts
// tests/shared/settings.test.ts（片段：追加在文件末尾）
describe('迁移 v3 → v4：单 model 抬起成 models + activeModel', () => {
  /**
   * 种一份 v3 形状的设置再按当前代码读出来。
   * 注意 `MemoryStorage` 的构造参数是**配额选项**，不是初始数据——种数据一律走 `area.set`。
   *
   * ⚠ **`model` 没有默认参数，而且 `undefined` 时根本不写这个键**（落地时抓到的计划缺陷）：
   * 写成 `loadV3(model: unknown = 'deepseek-chat')` 的话，默认参数会把 `loadV3(undefined)`
   * 悄悄换回 `'deepseek-chat'`——于是"整个键缺失"那一半**永远种不进去**，测的还是"有 model"。
   * 调用的三种形态必须分得开：`loadV3('deepseek-chat')` / `loadV3('')` / `loadV3(undefined)`。
   */
  async function loadV3(model: unknown) {
    const area = new MemoryStorage();
    const stored: Record<string, unknown> = { id: 'p1', label: '我的 DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-keep' };
    // `undefined` = **这个键不存在**（不是"值是 undefined"）：种的是真实存储里可能出现的形状。
    if (model !== undefined) stored.model = model;
    await area.set({ [SETTINGS_KEY]: { version: 3, engineId: 'p1', profiles: [stored] } });
    return { area, loaded: await loadSettings(area) };
  }

  it('model 有值 → models:[model] + activeModel:model，且 Key / 地址 / 名字一字不差', async () => {
    const { loaded } = await loadV3('deepseek-chat');

    expect(loaded.profiles[0]).toEqual({
      id: 'p1',
      label: '我的 DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat'],
      activeModel: 'deepseek-chat',
      apiKey: 'sk-keep',
    });
    // 读完被标成当前版本（迁移标记），但存储里那份**没被动过**：迁移只发生在读的那一刻。
    expect(loaded.version).toBe(CURRENT_VERSION);
  });

  it('model 是空串或整个缺失 → models:[] + activeModel:""（不是"没有这两个字段"）', async () => {
    // ⚠ **两轮分开写、不要合成一条循环里的两个断言**（落地教训）：这条计划里原本是
    // `for (const model of ['', undefined])` 一个循环，第一轮（`''`）先红就把第二轮的读数
    // **整个遮住**——Step 2 只看到 `expected [ Array(3) ] to deeply equal [ '', [], '' ]`，
    // 于是"缺失那一半到底种进去了没有"根本看不见（D 那个默认参数缺陷就是这么藏了一整轮）。
    // 取读数要**一轮一条**：红了先只修到这一轮绿，再看下一轮。
    for (const model of ['', undefined]) {
      const { loaded } = await loadV3(model);
      expect([model, loaded.profiles[0].models, loaded.profiles[0].activeModel]).toEqual([model, [], '']);
    }
  });

  it('model 首尾空白被 trim 掉再进清单（与 pickModels 同一判据）', async () => {
    const { loaded } = await loadV3('  deepseek-chat  ');
    expect(loaded.profiles[0].models).toEqual(['deepseek-chat']);
    expect(loaded.profiles[0].activeModel).toBe('deepseek-chat');
  });

  it('v1 数据一次走三步：displayMode 冻结值迁移 + 折叠 + 抬起（三条路径收敛到同一形状）', async () => {
    const area = new MemoryStorage();
    await area.set({
      [SETTINGS_KEY]: {
        version: 1,
        displayMode: 'bilingual',
        engineId: 'openai-compat',
        providerPreset: 'deepseek',
        engineConfig: { apiKey: 'sk-ds', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      },
    });
    const loaded = await loadSettings(area);

    expect(loaded.displayMode).toBe('translated-only');
    expect(loaded.engineId).toBe(LEGACY_PROFILE_ID);
    expect(loaded.profiles).toEqual([
      {
        id: LEGACY_PROFILE_ID,
        label: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat'],
        activeModel: 'deepseek-chat',
        apiKey: 'sk-ds',
      },
    ]);
  });

  it('幂等：v4 数据读回不再变，而且写回存储后**没有 model 字段**（旧字段不残留）', async () => {
    const area = new MemoryStorage();
    await area.set({
      [SETTINGS_KEY]: {
        version: CURRENT_VERSION,
        engineId: 'p1',
        // 脏输入里塞一个旧字段：`pickProfile` 不读它，`saveSettings` 也不该把它带回存储。
        profiles: [{ ...profile(), model: 'ghost' }],
      },
    });
    const loaded = await loadSettings(area);
    expect(loaded.profiles[0]).toEqual(profile());

    await saveSettings(loaded, area);
    const raw = (await area.get([SETTINGS_KEY]))[SETTINGS_KEY] as { profiles: Array<Record<string, unknown>> };
    expect(Object.keys(raw.profiles[0]).sort()).toEqual(['activeModel', 'apiKey', 'baseUrl', 'id', 'label', 'models']);
  });
});

describe('models / activeModel 的反序列化边界', () => {
  /** 种一份 v4 形状（`version` 就是当前版本，所以不触发任何迁移）。 */
  async function loadWith(value: Record<string, unknown>) {
    const area = new MemoryStorage();
    await area.set({
      [SETTINGS_KEY]: {
        version: CURRENT_VERSION,
        engineId: 'p1',
        profiles: [{ id: 'p1', label: 'x', baseUrl: 'https://a.example/v1', apiKey: 'sk', ...value }],
      },
    });
    return loadSettings(area);
  }

  it('models 非数组当空；条目里的非字符串 / 空串 / 重复项一律丢掉，首尾空白 trim', async () => {
    const loaded = await loadWith({ models: ['  a  ', 'a', '', 7, null, 'b', 'b', {}], activeModel: 'a' });
    expect(loaded.profiles[0].models).toEqual(['a', 'b']);
    // 非数组当空（同一判据的另一半）。
    expect((await loadWith({ models: 'a,b' })).profiles[0].models).toEqual([]);
  });

  it('activeModel 不是成员（含空串 / 缺失 / 非字符串）→ 置空，**不替用户挑一个**', async () => {
    for (const activeModel of ['c', '', undefined, 7]) {
      const loaded = await loadWith({ models: ['a', 'b'], activeModel });
      // 关键的一半：不许退化成 `models` 的最后一项——那是"用户没选、插件替他选了"。
      expect([activeModel, loaded.profiles[0].activeModel]).toEqual([activeModel, '']);
    }
  });

  it('activeModel 是成员时原样保留（正面半边）', async () => {
    const loaded = await loadWith({ models: ['a', 'b'], activeModel: 'b' });
    expect(loaded.profiles[0].activeModel).toBe('b');
  });
});
```

**1c. `resolveEngine` 那条 describe 里追加一条**（钉住"`config.model` 取的是 `activeModel`"）：

```ts
// tests/shared/settings.test.ts（片段：追加进 describe('档案解析：resolveEngine …')）
  it('config.model 取的是 activeModel，不是清单里的其它项', () => {
    const { config } = resolveEngine({
      engineId: 'p1',
      profiles: [profile({ models: ['a', 'b', 'c'], activeModel: 'b' })],
    });
    expect(config.model).toBe('b');
  });
```

- [ ] **Step 2: 跑到红**

Run: `npx vitest run tests/shared/settings.test.ts`

Expected: FAIL —— 新增用例报 `models` 为 `undefined` / `activeModel` 未定义（`expected undefined to deeply equal []` 一类）；顶部夹具改形状后，**所有**用 `profile()` 的既有用例一起红（`config.model` 读到 `undefined`）。这是"字段改名"的必然形态，不是断言写错。

⚠ **这一步的读数有一个已知盲区（落地实测）**：「model 是空串或整个缺失」那条里的两轮，**第一轮先红就把第二轮遮住**（Step 2 只看到 `expected [ Array(3) ] to deeply equal [ '', [], '' ]`），所以"缺失那一半有没有真的种进去"在这一步**看不见**——D 那个夹具默认参数缺陷正是这么藏过一整轮的。**取读数要一轮一条**：红了先只让这一轮绿，再看下一轮；**不许**因为"这条已经红了"就跳过剩下几轮。

- [ ] **Step 3: 实现（`src/shared/settings.ts`）**

**3a. `EngineProfile`**（改动处）：

```ts
// src/shared/settings.ts（片段：EngineProfile）
/**
 * 一份服务商档案 = 一个「OpenAI 兼容」接口的完整凭据（地址 + **模型清单** + Key）加一个用户自己起的名字。
 *
 * v4 起 `model: string` 变成 `models: string[]` + `activeModel: string`：同一家接口的两个模型
 * 过去只能复制成两份档案（用户现在的档案里就有这种重复）。
 *
 * `activeModel` 是**用户/界面明确选定**的那一个（不是"默认"）：它必须是 `models` 的成员或 `''`，
 * 见 {@link pickProfile} 的读取边界。`''` = 还没选——此时翻译要给可读错误、**零请求**，
 * 绝不允许读取层替用户挑一个（那等于"用户没选，插件选了，下一次翻译就用了它"）。
 */
export interface EngineProfile {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  activeModel: string;
  apiKey: string;
}
```

**3b. `CURRENT_VERSION`**（改动处）：

```ts
/** 当前设置 schema 版本；改动字段语义时递增。v4：`EngineProfile.model` → `models` + `activeModel`。 */
export const CURRENT_VERSION = 4;
```

**3c. `pickProfile` + 新增 `pickModels`**（整体替换 `pickProfile`，并在它上面插入 `pickModels`）：

```ts
// src/shared/settings.ts（片段：pickModels + pickProfile，替换原来的 pickProfile）
/**
 * 模型清单的读取：只收非空字符串、逐条 trim、按首次出现去重。
 *
 * **不截断**（没有条数上限）：有些网关的 `/models` 列几百个，截断等于替用户丢掉他的模型。
 * 代价是清单可能很长——那是界面的事（可滚动），不是存储边界的事。
 */
function pickModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (name.length === 0 || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/**
 * 单个档案的读取：逐字段校验，坏条目丢掉而不是让整页崩掉（`pickSiteRules` 的老规矩）。
 *
 * - 没有合法 `id` 的条目**必须**丢：`engineId` 按 id 引用档案，没有 id 的档案无法被指向，
 *   留在列表里只会成为一个永远选不中的幽灵条目。
 * - `baseUrl` 非法（脏存储、被绕过的 UI）归一化成**空串**而不是某个默认端点：
 *   档案的 apiKey 就存在同一条目里，"退回默认地址"等于把用户的 Key 发给另一家服务商。
 *   空地址让引擎在翻译时明确报「尚未填写接口地址」，不发任何请求。
 * - label 空白按缺失处理，界面上才不会出现一排选不出名字的条目。
 * - **`activeModel` 认不出来（不是 `models` 的成员 / 空 / 缺失 / 非字符串）时置 `''`**：
 *   §3.1 的"取 `models` 最后一个"是**删除动作**的自愈（用户刚删掉当前模型，他显然还想用这个
 *   档案）；读取边界不同——这里替用户挑一个，就是"他没选，插件选了"。这条不变量（
 *   `activeModel === '' || models.includes(activeModel)`）因此在任何数据形状下都成立。
 * - 旧字段 `model` **不再读**：真相只留一份（先例是 `engineConfig` / `providerPreset`）。
 */
function pickProfile(value: unknown): EngineProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<EngineProfile>;
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) return null;
  const label = pickString(raw.label, '');
  let baseUrl = '';
  if (typeof raw.baseUrl === 'string') {
    const trimmed = raw.baseUrl.trim();
    if (isAllowedBaseUrl(trimmed)) baseUrl = trimmed;
  }
  const models = pickModels(raw.models);
  const wanted = pickString(raw.activeModel, '').trim();
  return {
    id: raw.id,
    label: label.trim().length > 0 ? label : FALLBACK_PROFILE_LABEL,
    baseUrl,
    models,
    activeModel: models.includes(wanted) ? wanted : '',
    apiKey: pickString(raw.apiKey, ''),
  };
}
```

**3d. `migrate` 加一步 + 新增 `liftProfileModels`**（整体替换 `migrate`，并把它下面插入新函数）：

```ts
// src/shared/settings.ts（片段：migrate，替换原函数体；liftProfileModels 紧随其后）
function migrate(raw: unknown, storedVersion: number): unknown {
  if (storedVersion >= CURRENT_VERSION) return raw;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  let record = raw as Record<string, unknown>;
  if (storedVersion < 2 && record.displayMode === 'bilingual') {
    record = { ...record, displayMode: 'translated-only' };
  }
  if (storedVersion < 3) {
    record = foldLegacyEngineConfig(record);
  }
  if (storedVersion < 4) {
    record = liftProfileModels(record);
  }
  return record;
}

/**
 * v3 → v4 的抬起：每个档案的单 `model` 变成 `models: [model]` + `activeModel: model`；
 * 空 / 缺失 → `models: []` + `activeModel: ''`。
 *
 * 两条刻意的做法：
 * 1. **旧字段 `model` 从产物里删掉**（与 `foldLegacyEngineConfig` 删 `engineConfig` /
 *    `providerPreset` 同一条纪律）：`mergeSettings` 本来也不读它，但存储里留着会让"下次迁移"
 *    的判据变含糊，而 `saveSettings` 是整份覆盖写——残留字段会被一直带着走。
 * 2. **v2 数据也走这里**：`foldLegacyEngineConfig` 产出的档案带的是 `model`，所以 v1/v2/v3 三条
 *    路径都在这一步收敛到同一形状（v1/v2 先折叠、再抬起，顺序由 `migrate` 保证）。
 */
function liftProfileModels(record: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(record.profiles)) return record;
  return {
    ...record,
    profiles: record.profiles.map((raw) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
      const lifted = { ...(raw as Record<string, unknown>) };
      const model = typeof lifted.model === 'string' ? lifted.model.trim() : '';
      delete lifted.model;
      return { ...lifted, models: model.length > 0 ? [model] : [], activeModel: model };
    }),
  };
}
```

**3e. `resolveEngine`**（只改返回的 `config`）：

```ts
// src/shared/settings.ts（片段：resolveEngine 的档案分支）
  return {
    engine: getEngine(OPENAI_COMPAT_ENGINE_ID),
    // 送给引擎的仍然是 `EngineConfig.model`（引擎层不必知道"清单"这件事）；
    // 它取的是**用户选定的那一个**。空串时引擎自己会在发请求前抛出可行动的 AUTH。
    config: { apiKey: profile.apiKey, baseUrl: profile.baseUrl, model: profile.activeModel },
  };
```

- [ ] **Step 4: 过渡读取映射（`src/options/sections/engine.ts`）**

面板 C1 阶段**不动**（还是"一个模型名输入框"），只把它接到新字段上。加一个函数并改三处调用。

**4a. 新增 `modelsFromSingleInput`**（放在 `validateProfileForm` 之后）：

```ts
// src/options/sections/engine.ts（片段：过渡读取映射，C4 会连同输入框一起删掉）
/**
 * **过渡读取映射**：单模型输入框里的那个模型名 = 整个清单。
 *
 * 存在的唯一理由：C1（数据模型 v4）与 C4（模型目录 UI）之间，既有的 14 行 `.profile-model-name`
 * 调用点（清单见「契约属性清单」）仍然按它驱动面板。C4 把面板换成模型目录时，这个函数与那个
 * 输入框一起删掉。
 *
 * ⚠ **它是有损的**：档案里如果已经有多个模型，任何一次保存都会把它压成"输入框里那一个"。
 * 所以 C1 **不许独立发布**（C4 落地前不许合进 release 分支）。
 */
function modelsFromSingleInput(value: string, existing: EngineProfile | undefined): { models: string[]; activeModel: string } {
  const model = value.trim();
  if (model.length === 0) return { models: [], activeModel: '' };
  return { models: [model], activeModel: model };
}
```

**4b. `buildEditor` 的模型输入框回填**（改动处）：

```ts
// src/options/sections/engine.ts（片段：buildEditor 的模型输入框，C4 会整块替换）
    value: profile?.activeModel ?? '',
```

**4c. `buildProfileRow` 的 meta 行**（改动处）：

```ts
// src/options/sections/engine.ts（片段：buildProfileRow 的 meta 文案）
  const shownModel = profile !== undefined && profile.activeModel.length > 0 ? profile.activeModel : '未选模型';
```

**4d. `handleSaveProfile` 的两条分支**（整体替换这一段）：

```ts
// src/options/sections/engine.ts（片段：handleSaveProfile 的 profiles 构造，替换原 isNew 分支）
  const isNew = id === NEW_DRAFT_ID;
  let savedId: string;
  let profiles: EngineProfile[];
  if (isNew) {
    savedId = createProfileId();
    const lifted = modelsFromSingleInput(values.model, undefined);
    profiles = [
      ...latest.profiles,
      { id: savedId, label: values.label, baseUrl: values.baseUrl, ...lifted, apiKey: values.apiKey },
    ];
  } else {
    savedId = id;
    const existing = latest.profiles.find((profile) => profile.id === id);
    // Key 留空 = 保留存储里当前的那份（不是页面打开时的快照——整份覆盖的老坑同一个）。
    const apiKey = values.apiKey.trim().length > 0 ? values.apiKey : existing?.apiKey ?? '';
    const lifted = modelsFromSingleInput(values.model, existing);
    const nextProfile: EngineProfile = {
      id: savedId,
      label: values.label,
      baseUrl: values.baseUrl,
      ...lifted,
      apiKey,
    };
    profiles = existing === undefined ? [...latest.profiles, nextProfile] : latest.profiles.map((p) => (p.id === id ? nextProfile : p));
  }
```

**4e. `handleTestProfile` 的合成档案**（改动处）：

```ts
// src/options/sections/engine.ts（片段：handleTestProfile 里构造的临时档案）
  const { engine, config } = resolveEngine({
    engineId: id,
    profiles: [
      {
        id,
        label: values.label,
        baseUrl: values.baseUrl,
        ...modelsFromSingleInput(values.model, storedProfile),
        apiKey,
      },
    ],
  });
```

并把上面那两行取存储里那份档案的语句改成拿到**整个档案**（`storedKey` 换成 `storedProfile`）：

```ts
// src/options/sections/engine.ts（片段：handleTestProfile 取存储里那份档案）
  // Key 输入框留空时测的是**存储里已存的**那份（和"保存"同一语义）；新草稿没存过就是空，
  // 引擎会给出可行动的 AUTH 提示。取整个档案是因为清单也要从它推（见过渡映射）。
  const storedProfile = ctx.settings()?.profiles.find((profile) => profile.id === id);
  const apiKey = values.apiKey.trim().length > 0 ? values.apiKey : storedProfile?.apiKey ?? '';
```

- [ ] **Step 5: 迁移既有夹具与存储形状断言（26 处里的 6 处）**

**5a. `tests/options/harness.ts` 的 `profileSeed` + 两个新 helper**：

```ts
// tests/options/harness.ts（片段：profileSeed 换成 v4 形状 + 两个模型 helper）
/** 档案的种子形状（v4）；用例只覆盖自己在意的那几个字段。 */
export function profileSeed(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p-a',
    label: '我的 DeepSeek',
    baseUrl: CUSTOM_BASE_URL,
    models: ['deepseek-chat'],
    activeModel: 'deepseek-chat',
    apiKey: 'sk-a',
    ...over,
  };
}

/** 带一个指定模型的档案种子（绝大多数字段用例只关心"这个档案用哪个模型"）。 */
export function profileWithModel(model: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return profileSeed({ models: [model], activeModel: model, ...over });
}

/**
 * 把某一行的模型设成 `model`——**编辑面板里"改模型"这件事的唯一夹具入口**。
 *
 * 为什么要有这层：模型 UI 在单元 C 里换过一次形状（C1 还是"一个模型名输入框"，C4 换成模型目录
 * 清单），而十几条既有用例要表达的是同一件事——"把这一行的模型改成 X"。形状写在十几处，
 * 形状一换就是十几处一起改、而且很容易顺手改弱断言；写在一处，C4 只改这一个函数的实现。
 */
export function setModel(editor: Element, model: string): void {
  const input = fieldOf(editor, '.profile-model-name');
  input.value = model;
  input.dispatchEvent(bubble('input'));
}

/** 读回"这一行现在的模型"（C1：输入框的值；C4：清单里带 `data-current` 的那一项）。 */
export function currentModel(editor: Element): string {
  return fieldOf(editor, '.profile-model-name').value;
}
```

**5b. 既有用例的迁移表（逐条；改动前 → 改动后）**

| 文件 | 改动前 | 改动后 |
| --- | --- | --- |
| `tests/options/options.test.ts:64` | `profileSeed({ id: 'p-b', label: 'Ollama 本机', baseUrl: 'http://localhost:11434/v1', model: 'llama3' })` | `profileWithModel('llama3', { id: 'p-b', label: 'Ollama 本机', baseUrl: 'http://localhost:11434/v1' })` |
| `:143`（「展开已存在的档案不重放服务商模板」的种子） | `profileSeed({ label: '我的 DeepSeek', baseUrl: 'https://my-proxy.example/v1', model: 'deepseek-chat-selfhost' })` | **不许用 `profileWithModel(...)`（单模型，对齐）**——那会让这条守卫**恒真**（见右格）。改成**清单两项、当前项不是第一项**：`profileSeed({ label: '我的 DeepSeek', baseUrl: 'https://my-proxy.example/v1', models: ['deepseek-chat', 'deepseek-chat-selfhost'], activeModel: 'deepseek-chat-selfhost' })`。**读数（落地实测）**：夹具只有一项（或两项恰好同序）时，`buildEditor` 的 `profile?.activeModel ?? ''` 换成 `profile?.models[0] ?? ''` → **31 条全绿**（看不见，恒真式）；换成这个两项且当前项在后的夹具 → **恰好这一条红**（`expected 'deepseek-chat' to be 'deepseek-chat-selfhost'`）。用例名也应跟着说清："表单回填的是存过的地址与**当前选中的那个**模型名" |
| `:150` | `expect(fieldOf(editor, '.profile-model-name').value).toBe('deepseek-chat-selfhost')` | `expect(currentModel(editor)).toBe('deepseek-chat-selfhost')`（**期望值不变**：它就是"当前项"那个读数） |
| `:260` | `fieldOf(editor, '.profile-model-name').value = 'gpt-4o'` | `setModel(editor, 'gpt-4o')` |
| `:270` | `model: 'gpt-4o',` | `models: ['gpt-4o'],` + `activeModel: 'gpt-4o',`（**从 1 个断言字段变成 2 个，只增不减**） |
| `:299` | `expect(fieldOf(editor, '.profile-model-name').value).toBe('deepseek-chat')` | `expect(currentModel(editor)).toBe('deepseek-chat')` |
| `:304-307` | `fieldOf(editor, '.profile-model-name').value = 'deepseek-chat-v2'` + `dispatchEvent(bubble('input'))` + `expect(…).toBe('deepseek-chat-v2')` | `setModel(editor, 'deepseek-chat-v2')` + `expect(currentModel(editor)).toBe('deepseek-chat-v2')`（`provider.value === 'custom'` 那条**原样保留**） |
| `:316` | `model: 'deepseek-chat-v2',` | `models: ['deepseek-chat', 'deepseek-chat-v2'],` + `activeModel: 'deepseek-chat-v2',`（C1 的过渡映射是**有损的**，所以这里是 `['deepseek-chat-v2']`——**以实测为准**：C1 阶段写 `models: ['deepseek-chat-v2']`，C4 换成 `['deepseek-chat','deepseek-chat-v2']` 并在此处留一行注释说明形状变化） |
| `:329` | `fieldOf(editor, '.profile-model-name').value = 'deepseek-reasoner'` | `setModel(editor, 'deepseek-reasoner')` |
| `:333` | `expect(stored.model).toBe('deepseek-reasoner')` | `expect(stored.activeModel).toBe('deepseek-reasoner')` + `expect(stored.models).toContain('deepseek-reasoner')` |
| `:384` `:395` `:414` `:483` | `fieldOf(editor, '.profile-model-name').value = '…'` | `setModel(editor, '…')` |
| `:401` | `expect(stored.model).toBe('qwen2.5')` | `expect(stored.activeModel).toBe('qwen2.5')` + `expect(stored.models).toEqual(['qwen2.5'])` |
| `:437-438` `:459-460` | `profileSeed({ …, model: 'model-a' … })` | `profileWithModel('model-a', { … })` |
| `:444` `:466` | `fieldOf(editor, '.profile-model-name').value = 'model-…-edited'` | `setModel(editor, 'model-…-edited')` |
| `:446` `:468` | `waitFor(async () => ((await storedProfiles())[i]?.model === 'model-…-edited'))` | `waitFor(async () => ((await storedProfiles())[i]?.activeModel === 'model-…-edited'))` |
| `:650` | `profileSeed({ apiKey: 'sk-stored', model: 'old-model' })` | `profileWithModel('old-model', { apiKey: 'sk-stored' })` |
| `:657` | `fieldOf(editor, '.profile-model-name').value = 'new-model'` | `setModel(editor, 'new-model')` |
| `tests/options/engine-health.test.ts:239` | `fieldOf(editor, '.profile-model-name').value = 'm'` | `setModel(editor, 'm')` |
| `tests/popup/popup.test.ts:229` | `{ id: 'p-deep', label: '我的 DeepSeek', baseUrl: '…', model: 'deepseek-chat', apiKey: 'sk-test' }` | `{ …, models: ['deepseek-chat'], activeModel: 'deepseek-chat', apiKey: 'sk-test' }` |
| `tests/popup/popup.test.ts:474` | `model: 'm',` | `models: ['m'], activeModel: 'm',` |
| `tests/popup/popup.test.ts:591-592` | `model: 'ma'` / `model: 'mb'` | `models: ['ma'], activeModel: 'ma'` / `models: ['mb'], activeModel: 'mb'` |
| `tests/background/service-worker.test.ts:167` | `{ id: 'p-open', …, model: 'gpt-4o-mini', apiKey }` | `{ …, models: ['gpt-4o-mini'], activeModel: 'gpt-4o-mini', apiKey }` |
| `tests/background/service-worker.test.ts:197-203` | `const same = (id, model, apiKey) => ({ id, label: id, baseUrl: …, model, apiKey })` | `const same = (id, model, apiKey) => ({ id, label: id, baseUrl: 'https://api.example.com/v1', models: [model], activeModel: model, apiKey })`（调用点不动：`same('p-a', 'm-1', 'sk-a')` 照样可读） |
| `tests/background/service-worker.test.ts:245` | `model: 'm'` | `models: ['m'], activeModel: 'm'` |
| `tests/background/service-worker.test.ts:270` | `model: 'gpt-4o-mini', apiKey: ''` | `models: ['gpt-4o-mini'], activeModel: 'gpt-4o-mini', apiKey: ''` |
| `tests/shared/settings.test.ts:113-115` | `profiles: [{ id: 'p', apiKey: null, model: 7 }]` → `{ id:'p', label:'我的接口', baseUrl:'', model:'', apiKey:'' }` | 期望值改成 `{ id:'p', label:'我的接口', baseUrl:'', models: [], activeModel: '', apiKey:'' }` |
| `tests/shared/settings.test.ts:257` | `profile({ id: 'p2', …, model: 'm2' })` | `profile({ id: 'p2', …, models: ['m2'], activeModel: 'm2' })`（`:260` 的 `config` 期望**不动**：`{ apiKey, baseUrl, model: 'm2' }`） |
| `tests/shared/settings.test.ts:309` `:354` `:377` | 迁移用例里的期望档案 `model: '…'` | 加 `models: ['…']` + `activeModel: '…'`（`:354` 的 `model: ''` → `models: [], activeModel: ''`） |
| `tests/shared/settings.test.ts:399-413`（「已有 profiles 的 v3 数据即使残留 engineConfig 也不再迁移（幂等）」） | `profiles: [profile({ id: 'p-a', label: '手工档案', apiKey: 'sk-a' })]` **种在 `version: 3` 上** | **种数据改用 v3 字面量**：`profiles: [{ id: 'p-a', label: '手工档案', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-a' }]`，期望值**仍用 v4 的 `profile()` 夹具**（即 `models: ['deepseek-chat']` + `activeModel: 'deepseek-chat'`）。**⚠ 不许把期望值放宽成 `models: []` / `activeModel: ''`**——那是把 v3 数据被清空当成了正确行为。**这条会红的原因**：`1a` 把共享夹具升级成 v4 之后，`version: 3` + v4 字段的记录里**没有 `model`**，`liftProfileModels` 于是把清单清成 `[]`、当前项清成 `''`（核查者在纯净树里按 5b 表全改完仍 `1 failed`，diff 就是 `- activeModel:"deepseek-chat" / + ""`、`- models:["deepseek-chat"] / + []`）。**判据**：任何"种在旧版本号上"的数据都必须是**那个版本的真实形状**；拿当前夹具去种老版本，等于在测一个真实存储里不存在的输入 |
| `tests/shared/settings.test.ts:503` | `expect(ui.profiles[1]).toEqual({ …, model: 'deepseek-chat' })` | 期望值换成 `models: ['deepseek-chat'], activeModel: 'deepseek-chat'`（投影仍不许带 `apiKey`） |

**5c. 「只有一份真相」补一条**（追加进 `mergeSettings` 那条既有用例之后）：

```ts
// tests/shared/settings.test.ts（片段：追加进 mergeSettings 的 describe）
  it('v4 起 model 不再是档案字段：脏输入里出现也不会被带出来', () => {
    const merged = mergeSettings({
      profiles: [{ id: 'p', model: 'ghost', models: ['real'], activeModel: 'real' }],
    });
    expect(merged.profiles[0]).toEqual({
      id: 'p',
      label: '我的接口',
      baseUrl: '',
      models: ['real'],
      activeModel: 'real',
      apiKey: '',
    });
  });
```

- [ ] **Step 6: 跑到绿（含 typecheck）**

Run: `npx vitest run tests/shared/settings.test.ts tests/options tests/popup tests/background tests/engines tests/content tests/core`

Expected: 全绿。若有红，先分辨是"迁移漏了一处字面量"（`model:` 还在某处 seed 里）还是"断言写弱了"——**后者不许用放宽断言解决**。

Run: `npm run typecheck`

Expected: exit 0。`EngineProfile` 的字段改名会让所有还在写 `model:` 的**带类型**位置当场炸（这是好事：编译器替你找出漏改的调用点）。

- [ ] **Step 7: 变异验证**

| 变异 | 期望红在哪一条 |
| --- | --- |
| `activeModel: models.includes(wanted) ? wanted : ''` 改成 `models[models.length - 1] ?? ''`（自动挑一个） | 「activeModel 不是成员…置空，**不替用户挑一个**」——`'c'` 那条会读出 `'b'` |
| 删掉 `liftProfileModels` 那一步（不迁移） | 「model 有值 → models:[model] + activeModel:model」以及 v1 三步那条一起红 |
| `liftProfileModels` 里不写 `delete lifted.model` | **经公共边界不可观测（防御性）——落地实测全绿（`63 passed`）**。机理：`pickProfile` 逐字段**重建**档案、`mergeSettings` 过滤未知键，所以旧 `model` 键根本漏不到公共边界；而计划原本点名的「幂等」那条种的是 `version: CURRENT_VERSION`，`migrate` 在版本闸门**直接短路**，`liftProfileModels` 那行 `delete` 永远走不到。**它的价值是"防止 `pickProfile` 将来改成透传/浅拷贝时旧键漏出去"**——**杀它要改 `pickProfile`，不是改迁移**（实现者读数：把 `pickProfile` 的返回改成含旧 `model` 键 → 「幂等」那条按 `Object.keys` 当场红，证明那条断言不是死的）。**别留一个"计划说会红、实际全绿"的行**——这一轮已经有人为它白跑一遍 |
| `pickModels` 里删掉 `|| out.includes(name)`（不去重） | 「非字符串 / 空串 / 重复项一律丢掉」——`['a','a','b','b']` 那条红 |
| `pickModels` 里删掉 `raw.trim()` | 同一条红（`'  a  '` 与 `'a'` 不再相等） |
| `pickProfile` 里 `pickString(raw.activeModel, '').trim()` 改回 `pickString(raw.model, '')`（读旧字段） | 「activeModel 是成员时原样保留」红（读出来是空串） |
| `if (storedVersion < 4)` 写成 `< 3`（v3 数据不抬、v2 照抬） | **实测红 3 条**（落地读数）：① 「model 有值 → models:[model] + activeModel:model」② 「model 首尾空白被 trim 掉再进清单」③ F1 那条 v3 字面量的「幂等…不再迁移」用例（F1 修好之后它才成为第三个杀手）。**`foldLegacyEngineConfig` 的 v2 用例不会红**——`2 < 3` 照样抬起 v2 数据（计划原来这句预测是错的，按实测改掉）。**「model 是空串或整个缺失」也不会红**，这条值得记住：空/缺失时"抬起"与"不抬起"的结果**恰好一样**（都是 `models: []` + `activeModel: ''`），所以那条判据在空值上**本来就不可观测**（它守的是夹具形状，不是版本闸门）。**v1 三步那条同样不红**（`1 < 3`） |
| `resolveEngine` 的 `config.model` 写成 `profile.models[0] ?? ''` | 「config.model 取的是 activeModel」红（`models:['a','b','c'], activeModel:'b'` 读出 `'a'`） |

- [ ] **Step 8: 记录"过渡窗口"（写进交付说明）**

一句话必须写在报告里：**C1 落地后到 C4 落地前不许合进 release 分支**（`modelsFromSingleInput` 有损）。并在 `sections/engine.ts` 文件头把这条约束补进去：

```ts
// src/options/sections/engine.ts（片段：文件头补一条临时约束）
// ⚠ **临时状态（Task C1 引入、Task C4 清除）**：面板此刻仍是"一个模型名输入框"，由
// `modelsFromSingleInput` 把它映射到 v4 的 `models` / `activeModel`。那层映射**有损**
// （多模型清单会被压成一个），所以 C1 与 C4 之间**不许把本分支合进 release**。
// C4 会把这个函数与那个输入框一起删掉，并有用例正面断言 `.profile-model-name` 不存在。
```

- [ ] **Step 9: 提交**

```bash
git commit -m "feat(settings): 档案支持多个模型（CURRENT_VERSION 3→4，model → models + activeModel）" -- src/shared/settings.ts src/options/sections/engine.ts tests/options/harness.ts tests/shared/settings.test.ts tests/options/options.test.ts tests/options/engine-health.test.ts tests/popup/popup.test.ts tests/background/service-worker.test.ts
```

## Task C2: `activeModel === ''` → 可读错误 + 零请求；`configHash` 前提

**Files:**
- Modify: `src/shared/settings.ts`（`resolveEngine` 加 `problem`）
- Modify: `src/background/service-worker.ts`（发请求前的前置闸）
- Modify: `src/popup/popup.ts`（提示区认 `problem`）
- Modify: `tests/shared/settings.test.ts`、`tests/background/service-worker.test.ts`、`tests/popup/popup.test.ts`

> **零请求是构造性的，可读错误是新增的**。`openai-compat.ts` 的 `translate()` 在 `fetch` **之前**就有 `if (!model) throw new EngineError('AUTH', '尚未填写模型名，请在设置中配置')`——所以"带着空 model 打接口"这条路今天就走不通。规格 §3.3 要的是一个**指定的、可行动的**说法（告诉用户去点「添加模型」），而不是引擎那句通用的「尚未填写模型名」。
>
> **为什么不把这句写进引擎**：引擎是通用的 OpenAI 兼容适配器，它不知道"档案""模型清单"这些词。这句话的唯一来源是 `resolveEngine` 的 `problem`，消费者只有两个：service worker（发请求前拦下）与弹窗（提示区）。
>
> **§4 的前提已经成立**（`scheduler.ts:188-190` 的 `configHash` 里已经含 `model`），但端到端那一半要补：`tests/background/service-worker.test.ts:187` 那条「两个档案同 baseUrl 同 model → 命中同一份缓存；换 model 不串」是**单元级**的网，C2 补一条"同一个档案换 `activeModel`"的**端到端**读数。

- [ ] **Step 1: 写失败测试**

**1a. `tests/shared/settings.test.ts`**：在 `resolveEngine` 那条 describe 里追加，并把 `NO_MODEL_PROBLEM` 加进顶部 import：

```ts
// tests/shared/settings.test.ts（片段：追加进 describe('档案解析：resolveEngine …')）
  it('档案没有当前模型：给出规格 §3.3 那句可读原因（成对：有模型 / 免费引擎都不背它）', () => {
    const empty = resolveEngine({ engineId: 'p1', profiles: [profile({ models: [], activeModel: '' })] });
    expect(empty.config.model).toBe('');
    expect(empty.problem).toBe(NO_MODEL_PROBLEM);
    expect(empty.problem).toContain('还没有模型');
    expect(empty.problem).toContain('添加模型');

    // 成对的两半：这句话不许粘到"有模型"和"免费引擎"身上——否则它会变成一条恒真的噪声文案。
    expect(resolveEngine({ engineId: 'p1', profiles: [profile()] }).problem).toBeUndefined();
    expect(resolveEngine({ engineId: 'google', profiles: [] }).problem).toBeUndefined();
  });
```

**1b. `tests/background/service-worker.test.ts`**：追加两条（第一条是 §3.3 的端到端，第二条是 §4 的前提）。

```ts
// tests/background/service-worker.test.ts（片段：追加进 runtime.onMessage 消息路由 的 describe）
  it('档案没有当前模型：可读错误 + 一个请求都不发（成对：把 activeModel 填上就真的发）', async () => {
    const calls: Array<{ model: string }> = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ model: (JSON.parse(String(init?.body)) as { model: string }).model });
      return new Response(JSON.stringify({ choices: [{ message: { content: '<<<1>>> 你好' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    stub.permissions.grantedOrigins.add('https://api.example.com/*');
    const noModel = {
      id: 'p-a',
      label: 'A 家',
      baseUrl: 'https://api.example.com/v1',
      models: ['m-1'],
      activeModel: '',
      apiKey: 'sk-a',
    };
    await useSettings({ engineId: 'p-a', profiles: [noModel] });

    await expect(translateTexts({ items: [{ id: 'i1', text: 'Hello' }] }).response()).resolves.toEqual({
      ok: false,
      code: 'AUTH',
      message: '这个档案还没有模型，点「添加模型」或「拉取可用模型」',
    });
    // 零请求的读数有两半，缺一条都会被"走到别的分支去了"骗过去：
    // ① 一次 fetch 都没有；② 两层缓存里也没留下任何条目。
    expect(calls).toEqual([]);
    expect(cacheEntries('local')).toHaveLength(0);
    expect(cacheEntries('session')).toHaveLength(0);

    // 成对的另一半：同一份设置，只把 activeModel 填上，就该真的发一次请求并成功。
    // 没有这一半，上面那条在"整条链路都坏了 / 永远返回 AUTH"的实现下照样是绿的。
    await useSettings({ engineId: 'p-a', profiles: [{ ...noModel, activeModel: 'm-1' }] });
    await expect(translateTexts({ items: [{ id: 'i2', text: 'Hello' }] }).response()).resolves.toEqual({
      ok: true,
      results: [{ id: 'i2', text: '你好' }],
    });
    expect(calls).toEqual([{ model: 'm-1' }]);
  });

  it('同一个档案换 activeModel：不命中上一个模型的缓存（§4 的前提，端到端钉住）', async () => {
    // `scheduler.test.ts` 已有一条单元级的网（`engineConfig.model` 变 → key 变）；这一条补的是
    // **链路上游**：`resolveEngine` 到底把 `activeModel` 映射进了 `config.model`。
    // 少了它，"映射写错字段（比如取 models[0]）"只会在真机上表现为"换模型没生效"。
    const bodies: Array<{ model: string; messages: unknown }> = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { model: string; messages: unknown });
      return new Response(JSON.stringify({ choices: [{ message: { content: '<<<1>>> 你好' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    stub.permissions.grantedOrigins.add('https://api.example.com/*');
    const both = {
      id: 'p-a',
      label: 'A 家',
      baseUrl: 'https://api.example.com/v1',
      models: ['m-1', 'm-2'],
      activeModel: 'm-1',
      apiKey: 'sk-a',
    };

    await useSettings({ engineId: 'p-a', profiles: [both] });
    await translateTexts({ items: [{ id: 'i1', text: 'Hello' }] }).response();
    expect(bodies).toHaveLength(1);

    // 同一个档案、同一段文本、只把 activeModel 换成 m-2：必须再请求一次（缓存不许串味）。
    await useSettings({ engineId: 'p-a', profiles: [{ ...both, activeModel: 'm-2' }] });
    await translateTexts({ items: [{ id: 'i2', text: 'Hello' }] }).response();

    expect(bodies.map((body) => body.model)).toEqual(['m-1', 'm-2']);
  });
```

**1c. `tests/popup/popup.test.ts`**：追加一条（放在「引擎提示区」那条 describe 里）。

```ts
// tests/popup/popup.test.ts（片段：追加进 describe('引擎提示区…')）
  it('当前档案还没选模型：提示区说出那句可读的话（不静默，也不冒充"缺 Key"）', async () => {
    await seedSettings({
      engineId: 'p-empty',
      profiles: [
        {
          id: 'p-empty',
          label: '空档案',
          baseUrl: 'https://api.example.com/v1',
          models: [],
          activeModel: '',
          apiKey: 'sk-a',
        },
      ],
    });
    await loadPopup();

    const hint = ui().hint;
    expect(hint.textContent).toContain('还没有模型');
    expect(hint.classList.contains('warn')).toBe(true);
    // 两件事的处置完全不同（这里该去加模型，不是去填 Key），所以不许串成一句。
    expect(hint.textContent).not.toContain('需要 API Key');
  });
```

- [ ] **Step 2: 跑到红**

Run: `npx vitest run tests/shared/settings.test.ts tests/background/service-worker.test.ts tests/popup/popup.test.ts`

Expected:
- `settings.test.ts` 新条红：`problem` 是 `undefined`（`expected undefined to be '这个档案还没有模型…'`）。
- `service-worker.test.ts` 第一条红：收到的是**条目级**的 `{ ok: true, results: [{ code: 'AUTH', message: '尚未填写模型名，请在设置中配置' }] }`，而不是整条失败的 `{ ok: false, code: 'AUTH', … }`。第二条**已经绿**（`configHash` 本来就含 model——它是**前提**，不是回归）。
- `popup.test.ts` 新条红：提示区是「已配置你自己的 API Key.」那句（缺 Key 判据不成立，而 `problem` 还不存在）。

- [ ] **Step 3: 实现**

**3a. `src/shared/settings.ts`：`resolveEngine` 的返回类型 + 那句话的唯一来源。**

```ts
// src/shared/settings.ts（片段：ResolvedEngine + NO_MODEL_PROBLEM + resolveEngine，替换原函数）
export interface ResolvedEngine {
  engine: Translator;
  config: EngineConfig;
  /**
   * 这个档案**今天不能用来翻译**时的一句可读原因；能用时为 `undefined`。
   *
   * 为什么是返回值而不是抛错：弹窗在**同步渲染函数**里调它（`renderEngineHint`），抛错会把
   * 提示区变成异常路径。消费者只有两个：service worker（发请求前拦下）与弹窗（提示区）。
   *
   * **零请求不由这里保证**：`openai-compat` 的空 model 闸在 `fetch` 之前就已经拦住了
   * （构造性成立）。这里负责给出规格 §3.3 那句**可行动**的话——引擎给不出它，因为引擎是
   * 通用的 OpenAI 兼容适配器，它不知道"档案""模型清单"这些词。
   */
  problem?: string;
}

/**
 * §3.3 那句话的**唯一来源**：后台与弹窗都读它（两处各写一份必然漂移，先例见 `isAllowedBaseUrl`）。
 * 规格里它是「这个档案还没有模型，点『添加模型』或『拉取可用模型』」——外层引号属于规格的排版，
 * 落到代码里内层标签统一用本仓的「」（界面文案引用标签一律如此）。
 */
export const NO_MODEL_PROBLEM = '这个档案还没有模型，点「添加模型」或「拉取可用模型」';

export function resolveEngine(settings: Pick<Settings, 'engineId' | 'profiles'>): ResolvedEngine {
  const profile = settings.profiles.find((item) => item.id === settings.engineId);
  if (profile === undefined) return { engine: getEngine(settings.engineId), config: {} };
  const engine = getEngine(OPENAI_COMPAT_ENGINE_ID);
  const config: EngineConfig = { apiKey: profile.apiKey, baseUrl: profile.baseUrl, model: profile.activeModel };
  if (profile.activeModel.length === 0) return { engine, config, problem: NO_MODEL_PROBLEM };
  return { engine, config };
}
```

**3b. `src/background/service-worker.ts`：前置闸**（改动处，前后各引一行上下文）。

```ts
// src/background/service-worker.ts（片段：handleTranslateTexts 开头）
    const settings = await loadSettings(persistentArea);
    // 「用哪个引擎 + 用哪份配置」只有一处解析（shared/settings 的 resolveEngine）：
    // engineId 现在是 `google` 或某个档案的 id，别处各写一份 if 迟早和这里漂移。
    const { engine, config, problem } = resolveEngine(settings);
    // 档案没有当前模型：**在这里就返回**，一个请求都不发（§3.3）。规格要的是一句可行动的话，
    // 而不是带着空 model 去打接口换回一句 HTTP 400（上次 `deepseek` 那次事故的形状）。
    // 整条请求失败（不是条目级失败）：这件事对这批里的每一条都成立，没有"逐条重试"的意义。
    if (problem !== undefined) return { ok: false, code: 'AUTH', message: problem };
    const targetLang = payload.targetLang ?? settings.targetLang;
```

**3c. `src/popup/popup.ts`：提示区认 `problem`**（改动处，插在 `missingKey` 那一段之后）。

```ts
// src/popup/popup.ts（片段：renderEngineHint 开头）
function renderEngineHint(): void {
  const revision = (hintRevision += 1);
  const { engine, config, problem } = resolveEngine(settings);
  // 判空口径与引擎实现一致：只有空白字符也算**没填**（见 openai-compat 的构造）。
  const missingKey = engine.needsKey && (config.apiKey ?? '').trim().length === 0;
  if (missingKey) {
    engineHint.classList.add('warn');
    engineHint.textContent = '该引擎需要 API Key，请先在设置中填写。';
    return;
  }
  // 排在"缺 Key"之后：没有 Key 时"去加个模型"不是用户当下该做的事（先得有凭据才能翻译）。
  // 这句话本身来自 `resolveEngine`（唯一来源），这里只负责显示。
  if (problem !== undefined) {
    engineHint.classList.add('warn');
    engineHint.textContent = problem;
    return;
  }
```

- [ ] **Step 4: 跑到绿**

Run: `npx vitest run tests/shared/settings.test.ts tests/background/service-worker.test.ts tests/popup/popup.test.ts tests/options`

Expected: 全绿。`options.test.ts` 里「测试连接」的三条既有用例**必须一条都不红**——C2 只给 `resolveEngine` 加了一个返回值，`handleTestProfile` 拿到的 `config` 形状没变。

- [ ] **Step 5: 变异验证**

| 变异 | 期望红在哪一条 |
| --- | --- |
| 删掉 `if (problem !== undefined) return {…}` 那行（前置闸） | 「档案没有当前模型：可读错误 + 一个请求都不发」——响应退回条目级 `ok: true` + 「尚未填写模型名」 |
| 把 `code: 'AUTH'` 改成 `'BAD_REQUEST'` | 同一条（`code` 是精确相等断言） |
| `resolveEngine` 里 `problem` 恒为 `undefined`（删掉那一支） | `settings.test.ts` 那条 + service-worker 那条 + popup 那条三处一起红 |
| `resolveEngine` 里无条件返回 `problem`（恒真式） | 「成对的两半」两句红（有模型 / 免费引擎也开始背这句话） |
| 把 `problem` 分支挪到 `missingKey` **之前** | popup 那条「切到**未授权**的档案…」不受影响，但既有「需要 API Key 但没填时给出警告」那条**不**红——**说明两处判据互不覆盖**：要真正杀死"顺序错"，得造一份"既缺 Key 又缺模型"的设置（本条变异**不设**：规格没规定这时该说哪一句，两种顺序都说得通。写在这里是为了让后来者知道"查过、且这是有意的"） |
| `config.model` 改成 `profile.models[0] ?? ''` | 「同一个档案换 activeModel：不命中上一个模型的缓存」——`bodies` 两半都是 `m-1` |
| `configHash` 里去掉 `model`（`scheduler.ts:189`） | 「同一个档案换 activeModel…」红（第二次命中缓存、`bodies` 只有一条）。**这条是 §4 的守卫本身**，它今天活着，但值得每次收口都确认它还在 |

- [ ] **Step 6: 提交**

```bash
git commit -m "feat(engine): 没有当前模型时给出可读错误并零请求（§3.3）" -- src/shared/settings.ts src/background/service-worker.ts src/popup/popup.ts tests/shared/settings.test.ts tests/background/service-worker.test.ts tests/popup/popup.test.ts
```

---

## Task C3: `/models` 后台拉取（消息 + 宽容解析 + 失败分类 + 隐私）

**Files:**
- Modify: `src/shared/messages.ts`
- Create: `src/background/models.ts`
- Modify: `src/background/service-worker.ts`
- Create: `tests/background/models.test.ts`
- Modify: `tests/shared/messages.test.ts`、`tests/background/service-worker.test.ts`

> **谁去发这个请求**：后台 service worker，不是设置页。设置页**只传 `profileId`**，后台自己从存储读那份档案的 `baseUrl` 与 `apiKey`（§5.1）。理由：设置页持有全量设置（含 Key），让它把 Key 塞进消息回传后台，等于把密钥又搬过一条通道，与现有「Key 不进内容脚本、不渲染进设置页 DOM」的隔离口径自相矛盾。
>
> **"零自动拉取"这一条不在本任务**（§5.4）：C3 阶段**没有任何调用方**，负向断言会因为"分支根本没执行"而永远绿（本仓七种假信号成因②）。它落在 C4——那里才有「获取可用模型」这个正极，正负两半写在同一条用例里。
>
> **超时 10 秒，独立常量**：`src/content/index.ts:86` 的 `BACKGROUND_TIMEOUT_MS` 是 60 秒的整页翻译预算，语义完全不同，**不复用**。

- [ ] **Step 1: 写失败测试**

**1a. 新建 `tests/background/models.test.ts`**（纯 node 环境，不碰 `chrome`）：

```ts
// tests/background/models.test.ts
/**
 * `/models` 拉取的后台侧：URL、鉴权、10 秒超时、三种响应形状的宽容解析、失败分类、权限闸。
 *
 * **node 环境**：被测模块只依赖 `engines/api-error`、`shared/host-permission` 与一个
 * `EngineProfile` 的**类型**，不碰 DOM。权限那一支要装 chrome 替身（`hasHostPermission` 在
 * 没有权限 API 的环境里恒为 true，而本文件要**正面**钉住"未授权时不发请求"）。
 * "后台自己从存储读 Key"这件事在 `service-worker.test.ts` 里端到端钉住——那是"谁去读"的问题。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODELS_TIMEOUT_MS, describeModelsStatus, fetchModels, parseModelsPayload } from '../../src/background/models';
import type { EngineProfile } from '../../src/shared/settings';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';

let chromeStub: ChromeStub;

function profile(over: Partial<EngineProfile> = {}): EngineProfile {
  return {
    id: 'p-a',
    label: 'A 家',
    baseUrl: 'https://api.example.com/v1',
    models: [],
    activeModel: '',
    apiKey: 'sk-secret',
    ...over,
  };
}

/** 假 `fetch`：记下每次请求的 URL 与鉴权头，按队列给响应（用完了复用最后一个）。 */
function stubFetch(responses: Array<() => Promise<Response>>): Array<{ url: string; auth: string | null }> {
  const calls: Array<{ url: string; auth: string | null }> = [];
  let index = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
    const next = responses[Math.min(index, responses.length - 1)] as () => Promise<Response>;
    index += 1;
    return next();
  });
  return calls;
}

/** 一个 JSON 响应工厂（`status` 默认 200）。 */
const json = (data: unknown, status = 200) => async () =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** 一句失败文案的读数（`ok: false` 那一支才读得到 `message`）。 */
function messageOf(result: Awaited<ReturnType<typeof fetchModels>>): string {
  if (result.ok) throw new Error('这次拉取是成功的，用例想读的是失败文案');
  return result.message;
}

beforeEach(() => {
  // 每个用例默认"这个 origin 已经授权过"（真机上就是用户保存档案时点过允许）。
  // 只有 §5.5 那条用例自己把它撤销——它是"未授权时不发请求"唯一的读数。
  chromeStub = installChromeStub();
  chromeStub.permissions.grantedOrigins.add('https://api.example.com/*');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('parseModelsPayload：三种形状 + 宽容', () => {
  it('认三种形状：data[].id / models[].name / 顶层数组', () => {
    expect(parseModelsPayload({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] })).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(parseModelsPayload({ models: [{ name: 'qwen2.5:14b' }] })).toEqual(['qwen2.5:14b']);
    expect(parseModelsPayload([{ id: 'a' }, { name: 'b' }])).toEqual(['a', 'b']);
  });

  it('条目取 id ?? name；非字符串 / 空名 / 重复项丢掉；首尾空白 trim', () => {
    expect(
      parseModelsPayload({ data: [{ id: 'a' }, { id: 7 }, { name: 'b' }, { id: '' }, { id: '  c  ' }, { id: 'a' }] }),
    ).toEqual(['a', 'b', 'c']);
  });

  it('整体解析不出任何一条时返回空数组（调用方按"该服务商不提供模型列表"处理，不是报错）', () => {
    for (const payload of [{}, { data: 'nope' }, { models: null }, [], 'plain', null, 7]) {
      expect([payload, parseModelsPayload(payload)]).toEqual([payload, []]);
    }
  });
});

describe('describeModelsStatus：五句各不相同，每一句都留着"手填"这条路', () => {
  it('401 / 403 → 指向 Key；404 → 指向"这个地址没有 /models"；5xx → 服务商侧；其余 4xx → 请求不对', () => {
    const auth = describeModelsStatus(401, 'invalid key');
    const forbidden = describeModelsStatus(403, '');
    const missing = describeModelsStatus(404, 'not found');
    const boom = describeModelsStatus(500, 'bad gateway');
    const bad = describeModelsStatus(400, 'bad params');

    expect(auth).toContain('HTTP 401');
    expect(auth).toContain('API Key');
    expect(auth).toContain('invalid key'); // 正文不丢（§5.3 点名复用 extractErrorDetail）
    expect(forbidden).toContain('HTTP 403');
    expect(missing).toContain('HTTP 404');
    expect(missing).toContain('/models');
    expect(boom).toContain('HTTP 500');
    expect(bad).toContain('HTTP 400');

    // 五句互不相同：任何"把分类拍平成一句"的改动都会在这里红。
    expect(new Set([auth, forbidden, missing, boom, bad]).size).toBe(5);
    // 每一句都要留着那条**永远可达**的出路。
    for (const text of [auth, forbidden, missing, boom, bad]) expect(text).toContain('添加模型');
  });
});

describe('fetchModels：URL、鉴权、四种失败、超时', () => {
  it('请求 {baseUrl}/models（尾斜杠先去掉）并带上 Bearer Key', async () => {
    const calls = stubFetch([json({ data: [{ id: 'm-1' }] })]);

    const result = await fetchModels(profile({ baseUrl: 'https://api.example.com/v1/' }));

    expect(result).toEqual({ ok: true, models: ['m-1'] });
    expect(calls).toEqual([{ url: 'https://api.example.com/v1/models', auth: 'Bearer sk-secret' }]);
  });

  it('缺地址 / 缺 Key：一个请求都不发，各说一句能读懂的话', async () => {
    const calls = stubFetch([json({})]);

    const noUrl = await fetchModels(profile({ baseUrl: '   ' }));
    const noKey = await fetchModels(profile({ apiKey: '' }));

    expect(calls).toEqual([]);
    expect(messageOf(noUrl)).toContain('接口地址');
    expect(messageOf(noKey)).toContain('API Key');
    expect(messageOf(noKey)).toContain('添加模型');
  });

  it('未授权访问这个地址：一个请求都不发，并指向"回设置页重新保存一次该档案以授权"（§5.5）', async () => {
    chromeStub.permissions.grantedOrigins.clear();
    const calls = stubFetch([json({ data: [{ id: 'm-1' }] })]);

    const text = messageOf(await fetchModels(profile()));

    expect(calls).toEqual([]);
    expect(text).toContain('还没授权访问 https://api.example.com/*');
    expect(text).toContain('重新保存一次这个档案');
  });

  it('地址不是合法 URL：也不发请求，指向"先修正接口地址"', async () => {
    const calls = stubFetch([json({ data: [] })]);

    const text = messageOf(await fetchModels(profile({ baseUrl: 'api.example.com/v1' })));

    expect(calls).toEqual([]);
    expect(text).toContain('不是合法的 URL');
  });

  it('401 / 404 / 非 JSON / 网络不可达：四句各不相同，且都指向手填', async () => {
    stubFetch([json({ error: { message: 'invalid key' } }, 401)]);
    const auth = messageOf(await fetchModels(profile()));

    stubFetch([json({}, 404)]);
    const missing = messageOf(await fetchModels(profile()));

    stubFetch([async () => new Response('<html>nope</html>', { status: 200 })]);
    const notJson = messageOf(await fetchModels(profile()));

    stubFetch([
      async () => {
        throw new Error('fetch failed');
      },
    ]);
    const offline = messageOf(await fetchModels(profile()));

    expect(auth).toContain('API Key');
    expect(missing).toContain('/models');
    expect(notJson).toContain('不是合法 JSON');
    expect(offline).toContain('拉取模型清单失败');
    expect(new Set([auth, missing, notJson, offline]).size).toBe(4);
    for (const text of [auth, missing, notJson, offline]) expect(text).toContain('添加模型');
  });

  it('超时：10 秒没有响应就中止（§5.3 的独立超时），文案说清"可以稍后重试或手填"', async () => {
    vi.useFakeTimers();
    // fetch 挂住，直到 signal 中止才拒绝——真机上 abort 就是这个形状（与 openai-compat 同源）。
    vi.stubGlobal(
      'fetch',
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );

    const pending = fetchModels(profile());
    await vi.advanceTimersByTimeAsync(MODELS_TIMEOUT_MS);
    const text = messageOf(await pending);

    // 秒数是用户看得见的行为（文案里就写着它），所以钉住常量本身。
    expect(MODELS_TIMEOUT_MS).toBe(10_000);
    expect(text).toContain('超时');
    expect(text).toContain('添加模型');
  });
});
```

**1b. `tests/shared/messages.test.ts`**：改顶部 import 并追加一个 describe。

```ts
// tests/shared/messages.test.ts（片段：顶部 import 换成这一行）
import {
  MSG,
  isFetchModelsMessage,
  isTranslateTextsMessage,
  type FetchModelsMessage,
  type TranslateTextsMessage,
} from '../../src/shared/messages';
```

```ts
// tests/shared/messages.test.ts（片段：追加在文件末尾）
describe('isFetchModelsMessage', () => {
  it('识别合法的拉取请求', () => {
    const message: FetchModelsMessage = { type: MSG.FETCH_MODELS, payload: { profileId: 'p-a' } };
    expect(isFetchModelsMessage(message)).toBe(true);
  });

  it('拒绝缺 payload / profileId 不是非空字符串的消息（跨进程边界不能只信类型）', () => {
    const cases: unknown[] = [
      { type: MSG.FETCH_MODELS },
      { type: MSG.FETCH_MODELS, payload: {} },
      { type: MSG.FETCH_MODELS, payload: { profileId: '' } },
      { type: MSG.FETCH_MODELS, payload: { profileId: 7 } },
      { type: MSG.FETCH_MODELS, payload: 'p-a' },
      null,
    ];
    for (const message of cases) expect([message, isFetchModelsMessage(message)]).toEqual([message, false]);
  });

  it('两个校验器互不认领：翻译消息不是拉取消息，反之亦然', () => {
    expect(isFetchModelsMessage({ type: MSG.TRANSLATE_TEXTS, payload: { items: [] } })).toBe(false);
    expect(isTranslateTextsMessage({ type: MSG.FETCH_MODELS, payload: { profileId: 'p-a' } })).toBe(false);
  });
});
```

**1c. `tests/background/service-worker.test.ts`**：追加一条成对的隐私断言 + 两条失败路由（放在 `runtime.onMessage 消息路由` 那条 describe 里）。

```ts
// tests/background/service-worker.test.ts（片段：追加进 runtime.onMessage 消息路由 的 describe）
  it('拉取模型清单：后台自己从存储读 baseUrl 与 Key 并请求 /models（设置页只交 profileId）', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({ data: [{ id: 'm-1' }, { id: 'm-2' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    // `fetchModels` 会先查一次宿主权限（§5.5）——与引擎同一条纪律，所以这里要"已授权"。
    stub.permissions.grantedOrigins.add('https://api.example.com/*');
    await useSettings({
      engineId: 'p-a',
      profiles: [
        {
          id: 'p-a',
          label: 'A 家',
          baseUrl: 'https://api.example.com/v1',
          models: ['m-1'],
          activeModel: 'm-1',
          apiKey: 'sk-secret',
        },
      ],
    });

    const message = { type: MSG.FETCH_MODELS, payload: { profileId: 'p-a' } };

    const dispatch = stub.runtime.dispatchMessage(message);
    expect(dispatch.returns).toEqual([true]);
    expect(dispatch.responded).toBe(false); // 响应必须异步：同步返回就会丢消息
    await expect(dispatch.response()).resolves.toEqual({ ok: true, models: ['m-1', 'm-2'] });

    // 后台**确实**拿到了 Key（否则"消息里没有 Key"只是因为整条链路压根没读 Key）。
    expect(calls).toEqual([{ url: 'https://api.example.com/v1/models', auth: 'Bearer sk-secret' }]);
    // ⚠ **"消息体里不含 apiKey"这半边的读数不在这里**：本条用例手里的 `message` 是自己两行前
    // 造的字面量，对它断言"不含 sk-secret"是**恒真式**（测的是用例自己），不是守卫。
    // 那半边的真正读数在 Task C4——那里消息是由**设置页真的发出去**的
    // （`chromeStub.runtime.sentMessages` 精确相等），payload 多一个字段就红。
  });

  it('拉取的失败与"档案不在"都走 { ok: false, message }：不抛错、不留未处理的拒绝', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
    stub.permissions.grantedOrigins.add('https://api.example.com/*');
    await useSettings({
      engineId: 'p-a',
      profiles: [
        { id: 'p-a', label: 'A 家', baseUrl: 'https://api.example.com/v1', models: [], activeModel: '', apiKey: 'sk-a' },
      ],
    });

    const missing = stub.runtime.dispatchMessage({ type: MSG.FETCH_MODELS, payload: { profileId: 'gone' } });
    await expect(missing.response()).resolves.toEqual({
      ok: false,
      message: '这个档案已经不在了，请重新打开设置页再试。',
    });

    const failed = stub.runtime.dispatchMessage({ type: MSG.FETCH_MODELS, payload: { profileId: 'p-a' } });
    const response = (await failed.response()) as { ok: boolean; message: string };
    expect(response.ok).toBe(false);
    expect(response.message).toContain('HTTP 404');
  });
```

- [ ] **Step 2: 跑到红**

Run: `npx vitest run tests/background/models.test.ts tests/shared/messages.test.ts`

Expected: `models.test.ts` **整个文件 import 就失败**（`Failed to resolve import "../../src/background/models"`），`messages.test.ts` 报 `isFetchModelsMessage is not a function` / `MSG.FETCH_MODELS` 为 `undefined`。这是"新模块尚不存在"的正常红。

- [ ] **Step 3: 实现（`src/shared/messages.ts`）**

```ts
// src/shared/messages.ts（片段：MSG 里加一项 + 类型 + 校验器）
  /** 弹窗 → 内容脚本：「悬停翻译 / 划词翻译」开关改了。 */
  APPLY_SETTINGS: 'jinyi:apply-settings',
  /**
   * 设置页 → service worker：拉取某个档案可用模型清单（`{接口地址}/models`）。
   *
   * 设置页**只传 `profileId`**（§5.1）：它持有全量设置（含 Key），把 Key 塞进消息等于把密钥
   * 又搬过一条通道，与现有「Key 不进内容脚本、不渲染进设置页 DOM」的隔离口径相矛盾。
   * 后台按这个 id 自己从存储读 `baseUrl` 与 `apiKey`。
   */
  FETCH_MODELS: 'jinyi:fetch-models',
} as const;
```

```ts
// src/shared/messages.ts（片段：加在 isTranslateTextsMessage 之前）
export interface FetchModelsMessage {
  type: typeof MSG.FETCH_MODELS;
  payload: { profileId: string };
}

/**
 * `ok: true` 但 `models: []` = 「这个地址没有给出可用的模型清单」——**不是失败**
 * （§5.2：引导手填，而不是报错完事）。失败一律走 `ok: false` + 一句能读懂的话。
 */
export type FetchModelsResponse = { ok: true; models: string[] } | { ok: false; message: string };

/** 与 `isTranslateTextsMessage` 同一条纪律：只校验**形状**，空 profileId 是形状问题（它无法指代任何档案）。 */
export function isFetchModelsMessage(value: unknown): value is FetchModelsMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<FetchModelsMessage>;
  if (message.type !== MSG.FETCH_MODELS) return false;
  if (!message.payload || typeof message.payload !== 'object') return false;
  const payload = message.payload as { profileId?: unknown };
  return typeof payload.profileId === 'string' && payload.profileId.length > 0;
}
```

- [ ] **Step 4: 实现（新建 `src/background/models.ts`）**

```ts
// src/background/models.ts
//
// `{baseUrl}/models` 的拉取：谁去发（后台，§5.1）、形状多宽容（§5.2）、失败怎么分类（§5.3）、
// 超时多长（§5.3：10 秒，**独立于**内容脚本的 `BACKGROUND_TIMEOUT_MS`——那是 60 秒的整页
// 翻译预算，语义完全不同）。
//
// 为什么不放进 `src/engines/**`：分层守卫（`tests/core/layering.test.ts`）规定 `src/core` 与
// `src/engines` 里不许出现宿主全局标识符（连注释都不许），而"读设置、理解档案"是宿主层的事。
// 这个模块只依赖纯函数与一个**类型**，因此能在纯 node 里单测。
import { extractErrorDetail } from '../engines/api-error';
import { toEngineError } from '../engines/types';
import { hasHostPermission, originPattern } from '../shared/host-permission';
import type { EngineProfile } from '../shared/settings';

/**
 * §5.3：10 秒。这是用户点一下按钮就在等的一次请求（比整页翻译短得多），
 * 刻意不复用 `src/content/index.ts` 的 `BACKGROUND_TIMEOUT_MS`（60 秒）。
 */
export const MODELS_TIMEOUT_MS = 10_000;

/** 拉取结果。`ok: true` 但清单为空 = "这个地址没给出模型列表"，不是失败。 */
export type ModelsFetchResult = { ok: true; models: string[] } | { ok: false; message: string };

/**
 * 把 `/models` 的响应体解析成模型名清单（§5.2 的三种形状）：
 *
 * ```
 * { data: [{ id: 'gpt-4o' }, …] }      // OpenAI / 多数兼容网关
 * { models: [{ name: 'qwen2.5:14b' }] } // 部分实现
 * [ { id: '…' }, … ]                    // 直接给数组
 * ```
 *
 * 三条宽容：条目取 `id ?? name`；**非字符串一律丢弃**；整体解析不出任何一条时返回 `[]`
 * （调用方按"该服务商不提供模型列表"处理，引导手填——不是报错完事）。
 */
export function parseModelsPayload(data: unknown): string[] {
  const entries: unknown[] = Array.isArray(data)
    ? data
    : data !== null && typeof data === 'object'
      ? pickEntries(data as Record<string, unknown>)
      : [];
  const out: string[] = [];
  for (const entry of entries) {
    const name = modelNameOf(entry);
    if (name === null || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

function pickEntries(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.models)) return payload.models;
  return [];
}

/** 条目取 `id ?? name`：`id` 是字符串就用它，否则看 `name`；都不是字符串就丢掉这一条。 */
function modelNameOf(entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const raw = typeof record.id === 'string' ? record.id : record.name;
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name.length > 0 ? name : null;
}

/**
 * 失败分类（§5.3）：四类各自一句能读懂的话，**每一句都保留手填路径**（手填是永远可达的出路）。
 *
 * 纯函数，单独导出便于直连单测：五句互不相同这件事，只有把五句放在一起才能断言。
 */
export function describeModelsStatus(status: number, detail: string): string {
  const tail = detail.length > 0 ? `：${detail}` : '';
  if (status === 401 || status === 403) {
    return `接口拒绝了这次请求（HTTP ${status}）${tail}。请检查这个档案的 API Key；也可以只用「添加模型」手填。`;
  }
  if (status === 404) {
    return `这个地址没有 /models 这个端点（HTTP 404）${tail}。不是所有服务商都提供模型列表——请用「添加模型」手填。`;
  }
  if (status >= 500) {
    return `服务商那边出错了（HTTP ${status}）${tail}。可以稍后重试，或直接用「添加模型」手填。`;
  }
  return `这个地址不接受这次请求（HTTP ${status}）${tail}。请核对接口地址；也可以直接用「添加模型」手填。`;
}

/** 正文读不出来（流被中断等）不算错误：状态码本身仍然有信息量。 */
async function readDetail(response: Response): Promise<string> {
  try {
    return extractErrorDetail(await response.text());
  } catch {
    return '';
  }
}

/**
 * 真的去拉一次。**只由设置页点「获取可用模型」触发**（§5.4：打开设置页不拉、切档案不拉、
 * 聚焦输入框不拉）。
 *
 * 拿到的是**存储里**那份档案（调用方负责从存储读出来）：面板里还没保存的地址 / Key 改动不参与。
 */
export async function fetchModels(profile: EngineProfile): Promise<ModelsFetchResult> {
  const baseUrl = profile.baseUrl.trim();
  const apiKey = profile.apiKey.trim();
  if (baseUrl.length === 0) {
    return { ok: false, message: '这个档案还没填接口地址，先在「自定义设置」里填上再拉取。' };
  }
  if (apiKey.length === 0) {
    return { ok: false, message: '这个档案还没填 API Key，模型列表接口需要它；也可以直接用「添加模型」手填。' };
  }

  // §5.5：`{baseUrl}/models` 落在档案保存时已申请的 origin 范围内（**不需要新权限**），
  // 但用户当时可能拒了授权。与引擎同一条纪律：发请求前先问一句——不问的话，浏览器的拦截会
  // 伪装成"网络不可达"，用户完全不知道该去哪儿点（`host-permission.ts` 的文件头写着这件事）。
  const pattern = originPattern(baseUrl);
  if (pattern === undefined) {
    return { ok: false, message: `接口地址不是合法的 URL：${baseUrl}。请先在「自定义设置」里修正。` };
  }
  if (!(await hasHostPermission(pattern))) {
    return {
      ok: false,
      message: `还没授权访问 ${pattern}，这个请求会被浏览器拦下。请回设置页重新保存一次这个档案（授权只能在点击时申请）。`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
  } catch (raw) {
    // 中止与"网络不可达"要分开说：前者是"再等等也许就行"，后者是"先看看地址与网络"。
    return {
      ok: false,
      message: controller.signal.aborted
        ? `拉取模型清单超时（${MODELS_TIMEOUT_MS / 1000} 秒没有响应）。可以稍后重试，或直接用「添加模型」手填。`
        : `拉取模型清单失败：${toEngineError(raw).message}。可以检查接口地址与网络，或直接用「添加模型」手填。`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) return { ok: false, message: describeModelsStatus(response.status, await readDetail(response)) };

  let data: unknown;
  try {
    data = await response.json();
  } catch (raw) {
    return {
      ok: false,
      message: `接口返回的不是合法 JSON：${toEngineError(raw).message}。不是所有服务商都提供模型列表——请用「添加模型」手填。`,
    };
  }
  // 解析不出任何一条**不是失败**：调用方按 §5.2 引导手填。
  return { ok: true, models: parseModelsPayload(data) };
}
```

- [ ] **Step 5: 接线（`src/background/service-worker.ts`）**

**5a. import**（改动处）：

```ts
// src/background/service-worker.ts（片段：顶部 import 增加三处）
import { isFetchModelsMessage, isTranslateTextsMessage, MSG, type FetchModelsResponse, type TranslateTextsResponse } from '../shared/messages';
import { DEFAULT_SETTINGS, loadSettings, resolveEngine, type Settings } from '../shared/settings';
import { fetchModels } from './models';
```

**5b. 处理器**（加在 `handleTranslateTexts` 之后）：

```ts
// src/background/service-worker.ts（片段：新增 handleFetchModels）
/**
 * 设置页点「获取可用模型」→ 后台**自己**从存储读那份档案的 baseUrl / apiKey 再请求（§5.1）。
 * 失败一律收成 `{ ok: false, message }`：这个函数不抛，路由那一层只是兜底。
 */
async function handleFetchModels(payload: { profileId: string }): Promise<FetchModelsResponse> {
  let settings: Settings;
  try {
    settings = await loadSettings(persistentArea);
  } catch (raw) {
    return { ok: false, message: `设置读不出来：${toEngineError(raw).message}` };
  }
  const profile = settings.profiles.find((item) => item.id === payload.profileId);
  if (profile === undefined) return { ok: false, message: '这个档案已经不在了，请重新打开设置页再试。' };
  return fetchModels(profile);
}
```

**5c. 路由**（把 `onMessage` 的开头改成两条分支；拉取分支必须**排在**翻译分支之前）：

```ts
// src/background/service-worker.ts（片段：onMessage 路由开头）
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isFetchModelsMessage(message)) {
    handleFetchModels(message.payload)
      .then(sendResponse)
      .catch((raw: unknown) => {
        // 这个处理器自己不抛（失败都收成 `{ ok: false, message }`），这一层是纯兜底：
        // 抛出去会变成一次未处理的拒绝 + 一个永远等不到响应的调用方。
        sendResponse({ ok: false, message: `拉取模型清单失败：${toEngineError(raw).message}` } satisfies FetchModelsResponse);
      })
      // `sendResponse` 自己会抛（端口已关）：与翻译那条同一条口径，静默丢弃。
      .catch(() => undefined);
    return true;
  }
  if (!isTranslateTextsMessage(message)) return false;
```

- [ ] **Step 6: 跑到绿**

Run: `npx vitest run tests/background tests/shared/messages.test.ts`

Expected: 全绿。**既有的两条路由用例一条都不许红**：「不是本插件的消息返回 false」（`returns` 仍是 `[false]`）与「形状不对的翻译消息也返回 false」——拉取分支只认自己的 `type`，不认领别的消息。

Run: `npm run typecheck`

Expected: exit 0。

- [ ] **Step 7: 变异验证**

| 变异 | 期望红在哪一条 |
| --- | --- |
| `modelNameOf` 里 `typeof record.id === 'string' ? record.id : record.name` 改成只看 `record.name` | 「认三种形状…」——`data[].id` 那条变成 `[]` |
| `pickEntries` 里删掉 `models` 那一支 | 同一条的第二句红（`models[].name` 形状） |
| `parseModelsPayload` 里把"解析不出"改成抛错 | 「整体解析不出任何一条时返回空数组」红 |
| `describeModelsStatus` 里删掉 404 那一支（并入默认句） | 「五句各不相同」——`new Set(...).size` 变成 4，且 `missing` 不再含 `/models` |
| 删掉 `if (!(await hasHostPermission(pattern)))` 那一支（不查权限直接发） | 「未授权访问这个地址：一个请求都不发…」——`calls` 不为空（fetch 真的发出去了），文案也不再指向"重新保存一次" |
| `originPattern` 那一支删掉（非法地址直接拼 URL） | 「地址不是合法 URL：也不发请求…」红 |
| 超时那一句去掉「添加模型」 | 「超时：…」——循环断言 `toContain('添加模型')` 红 |
| `MODELS_TIMEOUT_MS` 改成 60_000 | 「超时：…」红（`advanceTimersByTimeAsync(10_000)` 之后 promise 仍未兑现 → 用例超时失败）。**注意**：这条用例读的是常量本身（`toBe(10_000)`），所以改常量会在断言处直接红，比等超时更早 |
| `fetchModels` 里 `if (!response.ok)` 那一行删掉（把 401 当成功去 parse） | 「401 / 404 / 非 JSON / 网络不可达」——`401` 那条从"含 API Key"变成 `ok: true`（`messageOf` 抛「这次拉取是成功的」） |
| 路由里把拉取分支挪到 `isTranslateTextsMessage` **之后** | service-worker 的两条拉取用例红（翻译校验器不认领拉取消息 → 返回 `false`、通道不开） |
| 拉取分支 `return true` 改成 `return false` | 同上（`dispatch.keepChannelOpen` 为 false，`response()` 直到超时才拒绝） |
| `handleFetchModels` 里 `payload.profileId` 改成读 `payload` 里别的字段 | 「拉取的失败与"档案不在"…」第一条红（拿不到档案 → 消息不同） |

- [ ] **Step 8: 提交**

```bash
git add -- src/background/models.ts tests/background/models.test.ts
git commit -m "feat(background): /models 拉取（只传 profileId，容忍三种形状，10 秒独立超时）" -- src/shared/messages.ts src/background/models.ts src/background/service-worker.ts tests/background/models.test.ts tests/shared/messages.test.ts tests/background/service-worker.test.ts
```

> 第一行处理两个**未跟踪的新文件**（硬规矩 14）。

## Task C4: 设置页档案行 / 编辑面板重排（图二布局 + 模型目录 + 取消 + 零自动拉取）

**Files:**
- Modify: `src/options/sections/engine.ts`（大改；**删掉 C1 的过渡映射与 `.profile-model-name`**）
- Modify: `src/options/options.html`、`src/options/options.css`
- Modify: `tests/options/harness.ts`（`setModel` / `currentModel` 换实现 + 新增 `rowButton`）
- Create: `tests/options/engine-models.test.ts`
- Modify: `tests/options/options.test.ts`、`tests/options/engine-health.test.ts`（20 处契约迁移）

> 这是本单元最大的一刀：折叠行从「整行是一个 `<button>`」变成「`.grow` + `.row-actions` 两个小按钮」，编辑面板从「四个 `.field`」变成「名字 / Key / `<details>` 自定义设置 / 模型目录 / 底部三颗按钮」，`删除` 从面板里挪到折叠行，`保存档案` 文案改成 `保存`。
>
> **既有断言的迁移**（全部只增不减）见 Step 6 的表。迁移的判据只有一条：**断言的强度不许降**——`stored.model` → `stored.activeModel` **并且**补 `stored.models`；`actionButton(editor, 'delete-profile')` → `rowButton(id, 'delete-profile')`（点击位置变了，断言的其余部分一个字不动）。
>
> ## 未保存输入的暂存契约（**本节作者的裁决**，落成规格 §9 第 19 条）
>
> **先看实测读数**（C0 落地时用探针 `tests/options/zz-draft-value-probe.test.ts` 取的，探针跑完已删；新旧两版都跑过）：
>
> | 场景 | 新实现（`35488b2`） | 旧实现（把 `case 'toggle'` 换回 `renderProfiles`） |
> | --- | --- | --- |
> | 真档案行手改 label 后收起再展开 | `label="存过的名字"` ← **回落到存储值，改动丢了** | 同左（**旧实现也一样丢**） |
> | 草稿填四个字段后点真档案的展开按钮 | `ids=["p-a","__new__"]`、`draftRowExists=true`，切回草稿行四个字段**全空** | `ids=["p-a"]`、`draftRowExists=false` ← **整行消失** |
> | 草稿行点自己收起再展开 | 四个字段全空 | 整行消失（再展开已不可能） |
>
> 两条结论必须记住：① **"C0 之后不再丢数据"是错的**——C0 只改变了"草稿行会不会整行消失"，未保存的输入在**任何**收起路径下都仍然丢失；② 真档案行丢改动是**既有行为**（编辑器由 `buildEditor` 从快照重建，没人接住 DOM 里敲的字），不是 C0 引入的。
>
> **裁决**：C4 里编辑器有了显式的 `取消` / `保存`，就必须把**隐式收起**的语义一起定死，不能让"顺手点一下别的行"变成静默丢数据。
>
> - **`保存`**：写存储 → 清掉这一行的暂存。
> - **`取消`**：**丢弃**这一行的编辑 → 清掉它的暂存 → 收起（这是它的定义，显式）。
> - **隐式收起**（点另一个档案的 `编辑`、点本行收起、切到草稿行）：**保留**未保存的输入——**每行一份内存暂存**（`Map<string, ProfileFormValues>`），收起时存下当前 DOM 的值，重新展开时先填暂存、没有暂存才用快照。这样"手滑点走一下"不丢东西，而且不需要确认弹窗、更不需要自动保存（**半填的档案绝不被静默写进存储**——B 轮定的纪律）。
> - 草稿行（`NEW_DRAFT_ID`）走**同一套**暂存；`保存` 成功、`取消`、行被删除时清掉它对应的那一格。
> - **文案纪律**：`取消` 的 `title` 可以写「丢弃这次编辑」；而"切走再切回会丢"这类说法**只在真有这个行为时才写**——裁决落地后就不该写（README 的已知限制按**最终实现**写，见 Task C6）。
>
> 落点：**Step 1** 的三条用例（隐式收起 / 真档案行四字段+模型清单+Key 边界 / 草稿保存后暂存清空）+ 既有那条 `取消` 用例（改成"取消清暂存"的见证）+ **Step 3g/3q** 的实现 + **Step 8** 的六行变异。

- [ ] **Step 1: 写失败测试（新建 `tests/options/engine-models.test.ts`）**

```ts
// tests/options/engine-models.test.ts
/**
 * @vitest-environment jsdom
 *
 * 档案行与编辑面板的版式（规格 §6）：折叠行的四个元素、`自定义`徽章、次级 meta 行，
 * 面板里的名字 / Key / 「自定义设置」/ 模型目录 / 底部三颗按钮，以及模型清单的三条写入规则
 * （空值与重复值不写入、添加即设为当前、删当前项自愈）。
 *
 * 另外钉住三条**承诺**：
 * - 「获取可用模型」只有点了才发请求（§5.4）——**正负两半写在同一条用例里**：正极不存在时，
 *   负向断言会因为"分支根本没执行"而永远绿（本仓七种假信号成因②）；
 * - 「取消」丢弃面板编辑、存储一个字节不动（§6.2 第 5 条）；
 * - **隐式收起保留未保存的输入**、而「取消」丢弃它（§9 第 19 条）——两条语义**各自一条用例**，
 *   它们将来一旦互相漂，红的就是彼此。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../src/shared/messages';
import {
  CUSTOM_BASE_URL,
  CUSTOM_ORIGIN_PATTERN,
  chromeStub,
  currentModel,
  editorOf,
  engineStatus,
  expand,
  fieldOf,
  loadOptions,
  pick,
  profileRows,
  profileSeed,
  resetOptionsPage,
  rowButton,
  rowOf,
  seedSettings,
  setModel,
  settle,
  storedProfiles,
  waitFor,
} from './harness';

beforeEach(() => {
  resetOptionsPage();
});

describe('折叠行：图二的四个元素 + 我们保留的次级 meta', () => {
  it('名字 / 使用中 / 状态点 / 编辑 + 删除齐备，且整行不再是按钮', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ id: 'p-a' }), profileSeed({ id: 'p-b', label: 'B 家' })],
    });
    await loadOptions();

    const row = rowOf('p-a');
    expect(row.querySelector('.name')?.textContent).toBe('我的 DeepSeek');
    expect(row.querySelector('.badge')?.textContent).toBe('使用中');
    expect(row.querySelector('.dot')?.getAttribute('data-state')).toBe('idle');
    expect(row.querySelector('.meta')?.textContent).toBe(`${CUSTOM_BASE_URL} · deepseek-chat`);
    expect(rowButton('p-a', 'toggle').textContent).toBe('编辑');
    expect(rowButton('p-a', 'delete-profile').textContent).toBe('删除');

    // 当前在用的那一行才有「使用中」；删除按钮两行都有。
    expect(rowOf('p-b').textContent).not.toContain('使用中');
    expect(() => rowButton('p-b', 'delete-profile')).not.toThrow();

    // 整行不是按钮：行里现在有「删除」，整行可点会把删除变成一次误触。
    expect(row.tagName).toBe('DIV');
    expect(rowButton('p-a', 'toggle').tagName).toBe('BUTTON');
    expect(row.querySelector('.profile-summary')).toBeNull();
  });

  it('「自定义」徽章只在地址对不上任何预设时出现——成对：命中预设地址的档案上没有它', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [
        profileSeed({ id: 'p-a', label: '自建代理', baseUrl: 'https://my-proxy.example/v1' }),
        profileSeed({ id: 'p-b', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' }),
        // 地址还是 DeepSeek 的，模型名却是自己的：判据是**地址**，所以也不该有徽章。
        profileSeed({ id: 'p-c', label: 'DeepSeek 改名', baseUrl: 'https://api.deepseek.com/v1', models: ['my-own'], activeModel: 'my-own' }),
      ],
    });
    await loadOptions();

    expect(rowOf('p-a').querySelector('[data-template="custom"]')).not.toBeNull();
    expect(rowOf('p-b').querySelector('[data-template="custom"]')).toBeNull();
    expect(rowOf('p-c').querySelector('[data-template="custom"]')).toBeNull();
  });

  it('次级 meta 的占位：地址与当前模型各自缺失时各写一句（不留空行）', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [{ id: 'p-a', label: '半成品', baseUrl: '', models: [], activeModel: '', apiKey: '' }],
    });
    await loadOptions();
    expect(rowOf('p-a').querySelector('.meta')?.textContent).toBe('未填接口地址 · 未选模型');

    // 新草稿那一行同形（它连档案都还没有）。
    pick<HTMLButtonElement>('add-profile').click();
    await settle();
    expect(rowOf('__new__').querySelector('.meta')?.textContent).toBe('未填接口地址 · 未选模型');
  });
});

describe('编辑面板：元素齐备 + 默认折叠规则 + Key 占位符', () => {
  it('名字 / Key / 自定义设置 / 模型目录 / 底部按钮齐备，且单模型输入框已彻底消失', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed()] });
    await loadOptions();
    const editor = expand('p-a');

    expect(fieldOf(editor, '.profile-label').value).toBe('我的 DeepSeek');
    expect(editor.querySelector('.profile-toggle-key')?.textContent).toBe('显示');
    expect(editor.querySelector('.profile-provider')).not.toBeNull();
    expect(fieldOf(editor, '.profile-base-url').value).toBe(CUSTOM_BASE_URL);
    expect(editor.querySelector('.models-field')).not.toBeNull();
    expect(editor.querySelector('.model-row[data-current]')?.getAttribute('data-model')).toBe('deepseek-chat');
    expect(editor.querySelector('[data-action="fetch-models"]')?.textContent).toContain('⟳');
    expect(editor.querySelector('[data-action="add-model"]')?.textContent).toBe('+ 添加模型');
    expect(editor.querySelector('[data-action="test-profile"]')?.textContent).toBe('测试连接');
    expect(editor.querySelector('[data-action="save-profile"]')?.textContent).toBe('保存');
    expect(editor.querySelector('[data-action="cancel-profile"]')?.textContent).toBe('取消');
    // C1 的过渡映射（有损）必须在这里彻底消失：留着它就是一条静默压扁清单的路。
    expect(editor.querySelector('.profile-model-name')).toBeNull();
  });

  it('「自定义设置」默认折叠；地址为空时展开（成对：地址非空 → 收起）', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed()] });
    await loadOptions();
    expect(expand('p-a').querySelector<HTMLDetailsElement>('.profile-advanced')?.open).toBe(false);

    pick<HTMLButtonElement>('add-profile').click();
    await settle();
    // 草稿的地址是空的 → 展开：面板首屏必须有一个能填地址的地方，否则用户以为没有这个入口。
    expect(editorOf('__new__').querySelector<HTMLDetailsElement>('.profile-advanced')?.open).toBe(true);
  });

  it('模板下拉是「自定义」**不**触发展开：已经有地址的档案不该白占一屏', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ baseUrl: 'https://my-proxy.example/v1' })],
    });
    await loadOptions();

    // 「自定义」徽章在（地址不是预设）——但它与折叠态无关：只看地址空不空。
    expect(rowOf('p-a').querySelector('[data-template="custom"]')).not.toBeNull();
    expect(expand('p-a').querySelector<HTMLDetailsElement>('.profile-advanced')?.open).toBe(false);
  });

  it('Key 占位符区分"已配置 / 没配置"，且值恒为空（不回填）', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [
        profileSeed({ id: 'p-a', apiKey: 'sk-secret' }),
        profileSeed({ id: 'p-b', label: 'B 家', apiKey: '' }),
      ],
    });
    await loadOptions();

    const configured = fieldOf(expand('p-a'), '.profile-api-key');
    expect(configured.value).toBe('');
    expect(configured.placeholder).toBe('已配置——输入新值可替换');
    // 密钥本体一个字符都不许进 DOM（列表渲染比单字段更容易把值带出去）。
    expect(document.documentElement.outerHTML).not.toContain('sk-secret');

    expect(fieldOf(expand('p-b'), '.profile-api-key').placeholder).toContain('还没配置');
  });

  it('选服务商模板：填地址 + 把它的模型并入清单并设为当前；下拉自己留在那个 preset 上（不算手改）', async () => {
    await seedSettings();
    await loadOptions();
    pick<HTMLButtonElement>('add-profile').click();
    await settle();
    const editor = editorOf('__new__');
    const provider = editor.querySelector<HTMLSelectElement>('.profile-provider') as HTMLSelectElement;

    provider.value = 'ollama';
    provider.dispatchEvent(new Event('change', { bubbles: true }));

    expect(fieldOf(editor, '.profile-base-url').value).toBe('http://localhost:11434/v1');
    expect(currentModel(editor)).toBe('llama3');
    expect(provider.value).toBe('ollama');
    // 预设不越界：API Key 一个字符都不碰（那是用户自己的凭据）。
    expect(fieldOf(editor, '.profile-api-key').value).toBe('');
  });
});

describe('模型目录：三条写入规则 + 自愈 + 空态说明', () => {
  it('手填添加：空值与重复值都不写入（各说一句），新值加进去**并设为当前**', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed()] });
    await loadOptions();
    const editor = expand('p-a');
    const names = () => Array.from(editor.querySelectorAll<HTMLElement>('.model-row')).map((row) => row.dataset.model);

    editor.querySelector<HTMLButtonElement>('[data-action="add-model"]')!.click();
    fieldOf(editor, '.profile-model-new').value = '   ';
    editor.querySelector<HTMLButtonElement>('[data-action="confirm-model"]')!.click();
    expect(engineStatus().dataset.kind).toBe('err');
    expect(engineStatus().textContent).toContain('不能为空');
    expect(names()).toEqual(['deepseek-chat']);

    fieldOf(editor, '.profile-model-new').value = 'deepseek-chat';
    editor.querySelector<HTMLButtonElement>('[data-action="confirm-model"]')!.click();
    expect(engineStatus().textContent).toContain('已经有');
    expect(names()).toEqual(['deepseek-chat']);

    setModel(editor, 'deepseek-reasoner');
    expect(names()).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(currentModel(editor)).toBe('deepseek-reasoner');
    expect(engineStatus().textContent).toContain('设为当前');
  });

  it('「设为当前」切换当前项；当前项自己的那颗按钮是禁用的（不做点了没反应的死控件）', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ models: ['a', 'b'], activeModel: 'a' })],
    });
    await loadOptions();
    const editor = expand('p-a');
    const useButton = (model: string) =>
      editor.querySelector<HTMLButtonElement>(`.model-row[data-model="${model}"] [data-action="use-model"]`)!;

    expect(currentModel(editor)).toBe('a');
    expect(useButton('a').disabled).toBe(true);
    expect(useButton('b').disabled).toBe(false);

    useButton('b').click();
    await settle();

    expect(currentModel(editor)).toBe('b');
    expect(useButton('b').disabled).toBe(true);
    expect(useButton('a').disabled).toBe(false);
  });

  it('删掉当前模型：自愈取剩下的最后一个；删空了置空并明说（落盘的一对也满足不变量）', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ models: ['a', 'b', 'c'], activeModel: 'b' })],
    });
    await loadOptions();
    const editor = expand('p-a');
    const remove = (model: string) =>
      editor.querySelector<HTMLButtonElement>(`.model-row[data-model="${model}"] [data-action="remove-model"]`)!.click();

    remove('b');
    await settle();
    expect(currentModel(editor)).toBe('c');
    expect(engineStatus().textContent).toContain('改成了「c」');

    // 删**非当前**项不许动当前项：上面删的正好是当前项，所以这一半是"自愈只该在必要时发生"
    // 唯一的读数（把 `draft.activeModel === name` 这个条件删掉，这里当场红）。
    remove('a');
    await settle();
    expect(currentModel(editor)).toBe('c');
    expect(Array.from(editor.querySelectorAll<HTMLElement>('.model-row')).map((row) => row.dataset.model)).toEqual(['c']);

    remove('c');
    await settle();
    expect(currentModel(editor)).toBe('');
    expect(editor.querySelectorAll('.model-row')).toHaveLength(0);
    expect(engineStatus().dataset.kind).toBe('err');
    expect(engineStatus().textContent).toContain('没有模型');

    // 落盘的那一对必须满足 `activeModel === '' || models.includes(activeModel)`。
    editor.querySelector<HTMLButtonElement>('[data-action="save-profile"]')!.click();
    await waitFor(async () => ((await storedProfiles())[0]?.models as unknown[] | undefined)?.length === 0);
    const stored = (await storedProfiles())[0];
    expect(stored.models).toEqual([]);
    expect(stored.activeModel).toBe('');
  });

  it('清单为空时那句说明逐句可核，有了一项就收起', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ models: [], activeModel: '' })],
    });
    await loadOptions();
    const editor = expand('p-a');
    const empty = editor.querySelector<HTMLElement>('.models-empty')!;

    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toContain('清单为空时，弹窗里不显示模型下拉');
    expect(empty.textContent).toContain('清单只有一项时弹窗也不显示下拉');
    expect(empty.textContent).toContain('两项以上才会出现下拉');

    setModel(editor, 'm-1');
    expect(editor.querySelector<HTMLElement>('.models-empty')?.hidden).toBe(true);
  });
});

describe('取消：丢弃面板编辑，存储一个字节不动', () => {
  it('改名字 + 加模型后取消：面板收起、存储原样；再展开看到的是存储里的值（**不是**刚被取消的草稿）', async () => {
    // 这条同时是"**`取消` 清暂存**"的见证：如果 `handleCancelProfile` 忘了清，重新展开会命中
    // 暂存、把 `改过的名字` / `another-model` 填回来，下面那两条断言当场红。
    // （与"隐式收起保留输入"是**两条不同的用例**——那两条在下面那个 describe 里。两条语义将来
    // 一旦互相漂，红的就是彼此。）
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed({ label: '原名字' })] });
    await loadOptions();

    let editor = expand('p-a');
    fieldOf(editor, '.profile-label').value = '改过的名字';
    setModel(editor, 'another-model');
    editor.querySelector<HTMLButtonElement>('[data-action="cancel-profile"]')!.click();
    await settle();

    expect(rowOf('p-a').querySelector('.profile-editor')).toBeNull();
    expect((await storedProfiles())[0]?.label).toBe('原名字');
    expect((await storedProfiles())[0]?.models).toEqual(['deepseek-chat']);

    editor = expand('p-a');
    expect(fieldOf(editor, '.profile-label').value).toBe('原名字');
    expect(currentModel(editor)).toBe('deepseek-chat');
    expect(
      Array.from(editor.querySelectorAll<HTMLElement>('.model-row')).map((row) => row.dataset.model),
    ).toEqual(['deepseek-chat']);
  });

  it('取消草稿行：整行移除（草稿没有存储里对应的东西，收起它只会留个空壳）', async () => {
    await seedSettings({ engineId: 'google' });
    await loadOptions();
    pick<HTMLButtonElement>('add-profile').click();
    await settle();
    expect(profileRows().map((row) => row.dataset.profileId)).toEqual(['__new__']);

    editorOf('__new__').querySelector<HTMLButtonElement>('[data-action="cancel-profile"]')!.click();
    await settle();

    expect(profileRows()).toEqual([]);
    expect(await storedProfiles()).toEqual([]);
    expect(engineStatus().textContent).toContain('没有被保存过');
  });
});

describe('「获取可用模型」：零自动拉取 + 勾选并入', () => {
  it('打开设置页 / 展开档案 / 聚焦输入框都不发请求；点了按钮才发，且消息里只有 profileId', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed()] });
    await loadOptions();

    const editor = expand('p-a');
    fieldOf(editor, '.profile-api-key').focus();
    fieldOf(editor, '.profile-label').focus();
    fieldOf(editor, '.profile-model-new').focus();
    await settle();

    // 负向的两半：没有任何消息发出、也没有任何网络请求。
    expect(chromeStub.runtime.sentMessages).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();

    // 正向那一半（缺了它，上面两条会因为"根本没有调用方"而永远绿——成因②）。
    // 真机上 SW 被回收时就是"没有接收方"：sendMessage 直接拒绝。
    chromeStub.runtime.noReceiver = true;
    editor.querySelector<HTMLButtonElement>('[data-action="fetch-models"]')!.click();
    await waitFor(() => engineStatus().dataset.kind === 'err');

    expect(chromeStub.runtime.sentMessages).toEqual([{ type: MSG.FETCH_MODELS, payload: { profileId: 'p-a' } }]);
    expect(fetchSpy).not.toHaveBeenCalled(); // 网络请求在后台那一侧，设置页自己绝不发
  });

  it('拉取成功：勾选清单默认全不选；勾两个并入 → 追加去重，清单原本为空时第一项为当前', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ models: [], activeModel: '' })],
    });
    await loadOptions();
    // 扮演 service worker：只回话，不断言（断言在下面事后查）。
    chromeStub.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if ((message as { type?: string }).type === MSG.FETCH_MODELS) {
        sendResponse({ ok: true, models: ['m-1', 'm-2', 'm-3'] });
      }
      return undefined;
    });

    const editor = expand('p-a');
    editor.querySelector<HTMLButtonElement>('[data-action="fetch-models"]')!.click();
    await waitFor(() => (engineStatus().textContent ?? '').includes('拿到了 3 个模型名'));

    const picks = () => Array.from(editor.querySelectorAll<HTMLInputElement>('.profile-model-pick'));
    expect(picks().map((box) => [box.value, box.checked])).toEqual([
      ['m-1', false],
      ['m-2', false],
      ['m-3', false],
    ]);

    // 一个都不勾：明确说一句，清单不动。
    editor.querySelector<HTMLButtonElement>('[data-action="merge-models"]')!.click();
    expect(engineStatus().dataset.kind).toBe('err');
    expect(engineStatus().textContent).toContain('一个都没勾');
    expect(editor.querySelectorAll('.model-row')).toHaveLength(0);

    picks()[1].checked = true;
    picks()[2].checked = true;
    editor.querySelector<HTMLButtonElement>('[data-action="merge-models"]')!.click();

    expect(
      Array.from(editor.querySelectorAll<HTMLElement>('.model-row')).map((row) => row.dataset.model),
    ).toEqual(['m-2', 'm-3']);
    // 清单原本是空的 → 并入的第一项设为当前（否则档案仍停在"还没有模型"）。
    expect(currentModel(editor)).toBe('m-2');

    // 成对的另一半：清单**非空**时并入**不许**动用户已经选好的当前项
    // （把 `draft.activeModel.length > 0 ? … : picked[0]` 那个条件删掉，这里当场红）。
    setModel(editor, 'm-9');
    expect(currentModel(editor)).toBe('m-9');
    editor.querySelector<HTMLButtonElement>('[data-action="fetch-models"]')!.click();
    await waitFor(() => (engineStatus().textContent ?? '').includes('拿到了 3 个模型名'));
    picks()[0].checked = true;
    editor.querySelector<HTMLButtonElement>('[data-action="merge-models"]')!.click();

    expect(
      Array.from(editor.querySelectorAll<HTMLElement>('.model-row')).map((row) => row.dataset.model),
    ).toEqual(['m-2', 'm-3', 'm-9', 'm-1']);
    expect(currentModel(editor)).toBe('m-9');
  });

  it('拉取成功但一条都解析不出：引导手填（不是报错完事）；拉取失败：原样显示后台那句', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed()] });
    await loadOptions();
    let reply: unknown = { ok: true, models: [] };
    chromeStub.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if ((message as { type?: string }).type === MSG.FETCH_MODELS) sendResponse(reply);
      return undefined;
    });

    const editor = expand('p-a');
    const click = () => editor.querySelector<HTMLButtonElement>('[data-action="fetch-models"]')!.click();

    click();
    await waitFor(() => (engineStatus().textContent ?? '').includes('没有给出可用的模型清单'));
    expect(engineStatus().textContent).toContain('添加模型');

    reply = { ok: false, message: '这个地址没有 /models 这个端点（HTTP 404）。请用「添加模型」手填。' };
    click();
    await waitFor(() => (engineStatus().textContent ?? '').includes('HTTP 404'));
    // 勾选清单没有被画出来（失败路径不该留一个空盒子）。
    expect(editor.querySelector<HTMLElement>('.models-fetched')?.hidden).toBe(true);
  });
});

describe('测试连接：没有当前模型时零请求', () => {
  it('没有当前模型：说那句话、一个请求都不发（有当前模型那一半由既有的三条用例守着）', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    chromeStub.permissions.grantedOrigins.add(CUSTOM_ORIGIN_PATTERN);
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ models: [], activeModel: '', apiKey: 'sk-a' })],
    });
    await loadOptions();
    const editor = expand('p-a');

    editor.querySelector<HTMLButtonElement>('[data-action="test-profile"]')!.click();
    await waitFor(() => engineStatus().dataset.kind === 'err');

    expect(engineStatus().textContent).toContain('还没有模型');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('未保存输入的暂存：隐式收起保住它，取消丢弃它（规格 §9 第 19 条）', () => {
  it('切走再切回草稿行：行还在，未保存的输入被暂存保住', async () => {
    // 为什么存在：旧实现里草稿行会**整行消失**（用户以为「新增档案」被吞了）；C0 之后行不再消失，
    // 但值仍会被 `buildEditor` 重建丢掉；C4 起用每行的内存暂存把它保住。
    // 探针实测（C0 落地时）：`ids=["p-a","__new__"]`、`draftRowExists=true`、切回四个字段全空。
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed({ id: 'p-a' })] });
    await loadOptions();

    pick<HTMLButtonElement>('add-profile').click();
    await settle();
    fieldOf(editorOf('__new__'), '.profile-label').value = '临时档案';

    // 切走：点真档案的「编辑」。这一步在旧实现下会把草稿行整个抹掉。
    rowOf('p-a').querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    await settle();
    expect(profileRows().map((row) => row.dataset.profileId)).toEqual(['p-a', '__new__']);
    expect(rowOf('__new__').querySelector('.profile-editor')).toBeNull(); // 收起 = 编辑器不在 DOM

    // 切回：暂存生效（没有暂存的话，新建的编辑器四个字段都是空的）。
    rowOf('__new__').querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    await settle();
    expect(fieldOf(editorOf('__new__'), '.profile-label').value).toBe('临时档案');
  });

  it('切走再切回真档案行：四个字段与模型清单都保住；**存储里的** Key 仍然不进 DOM', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ id: 'p-a', apiKey: 'sk-stored' }), profileSeed({ id: 'p-b', label: 'B 家' })],
    });
    await loadOptions();

    let editor = expand('p-a');
    fieldOf(editor, '.profile-label').value = '改了一半';
    fieldOf(editor, '.profile-base-url').value = 'https://half.example/v1';
    fieldOf(editor, '.profile-api-key').value = 'sk-typed-here';
    setModel(editor, 'second-model');

    expand('p-b'); // 切走（这一步收起 p-a → 写暂存）
    await settle();
    // 切过去的那一行**不会**看到别人正在编辑的内容：暂存是按**档案 id 各留一格**的。
    // 这条同时是"共用一格"那个变异的杀手（共用时 p-b 会读到 p-a 的草稿）。
    const other = expand('p-b');
    expect(fieldOf(other, '.profile-label').value).toBe('B 家');
    expect(fieldOf(other, '.profile-base-url').value).toBe(CUSTOM_BASE_URL);

    editor = expand('p-a'); // 切回（重建编辑器 → 先填暂存）

    expect(fieldOf(editor, '.profile-label').value).toBe('改了一半');
    expect(fieldOf(editor, '.profile-base-url').value).toBe('https://half.example/v1');
    expect(
      Array.from(editor.querySelectorAll<HTMLElement>('.model-row')).map((row) => row.dataset.model),
    ).toEqual(['deepseek-chat', 'second-model']);
    expect(currentModel(editor)).toBe('second-model');
    // Key 那一格搬的是**用户刚敲进去的**值（他自己的屏幕、他自己的输入），仍然是遮住的。
    // 这条**没有**改变隐私硬规矩：存储里那把 Key 照旧不回填、不进 DOM（下一句就是它的读数）。
    expect(fieldOf(editor, '.profile-api-key').value).toBe('sk-typed-here');
    expect(fieldOf(editor, '.profile-api-key').type).toBe('password');
    expect(document.documentElement.outerHTML).not.toContain('sk-stored');
    // 存储一个字节都没动：暂存是内存里的东西，不是自动保存。
    expect((await storedProfiles())[0]?.label).toBe('我的 DeepSeek');
  });

  it('草稿保存成功后清掉草稿暂存：再点「新增档案」是一张白纸，不是上一次那份草稿', async () => {
    // 为什么存在：草稿保存后 id 会从 `__new__` 变成一个**新生成的**档案 id。所以"保存后清暂存"
    // 这件事只在草稿这一支上**可观察**——残留的 `__new__` 那条会在下一次"新增档案"时把旧草稿
    // 预填回去。（同档案保存后的清理**不可观察**：保存后 `renderProfiles` 会按新快照重建那一行，
    // DOM 本来就不是旧草稿。别为不可观察的那半编一条断言。）
    await seedSettings({ engineId: 'google' });
    await loadOptions();

    pick<HTMLButtonElement>('add-profile').click();
    await settle();
    let editor = editorOf('__new__');
    fieldOf(editor, '.profile-label').value = '第一份草稿';
    fieldOf(editor, '.profile-base-url').value = CUSTOM_BASE_URL;
    fieldOf(editor, '.profile-api-key').value = 'sk-draft';
    // 先收起一次（写暂存），再展开（读暂存），然后保存。
    rowOf('__new__').querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    await settle();
    rowOf('__new__').querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    await settle();
    editor = editorOf('__new__');
    expect(fieldOf(editor, '.profile-label').value).toBe('第一份草稿');

    editor.querySelector<HTMLButtonElement>('[data-action="save-profile"]')!.click();
    await waitFor(async () => (await storedProfiles()).length === 1);
    expect((await storedProfiles())[0]?.label).toBe('第一份草稿');

    // 再开一个新草稿：四个字段都该是空的（残留的 `__new__` 暂存会把它们填回来）。
    pick<HTMLButtonElement>('add-profile').click();
    await settle();
    const fresh = editorOf('__new__');
    expect(fieldOf(fresh, '.profile-label').value).toBe('');
    expect(fieldOf(fresh, '.profile-base-url').value).toBe('');
    expect(fieldOf(fresh, '.profile-api-key').value).toBe('');
    expect(fresh.querySelectorAll('.model-row')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑到红**

Run: `npx vitest run tests/options/engine-models.test.ts`

Expected: 大面积红，且红的形态正是"新版式还不存在"：`编辑` 按钮的文案还是空串（点击后整行内容被 `applyTriggerState` 换掉之前，`rowButton('p-a','toggle')` 找不到 → 抛 `档案行 p-a 缺按钮 toggle`）、`.row-actions` 不存在、`.profile-model-name` 还在、`.models-field` 为 null。
**暂存那三条也会红，但红的形态要看清**：此刻既没有 `.model-row`（`setModel` 里的 `[data-action="add-model"]` 取不到 → 抛错），也没有 `editorDrafts`，"切回"读到的是快照值/空串。**它们真正的作用是守住 Step 3g/3p 落地后的行为**——所以 Step 2 不必逐条对报文，Step 7 之后它们必须是绿的，Step 8 用变异逐行验。
**别改断言去迎合现状**——这些红是这一步的目的。

- [ ] **Step 3: 实现（`src/options/sections/engine.ts`）**

**3a. 文件头补一段，并把 `ProfileFormValues` + `readEditor` 换掉；删掉 C1 的 `modelsFromSingleInput`。**

```ts
// src/options/sections/engine.ts（片段：文件头，替换 C1 加的那条临时约束）
// 本单元（C4）起档案行的版式是图二那一套：折叠行（名字 + 徽章 + 状态点 + 编辑/删除）+
// 展开面板（名字 / API Key / 可折叠的「自定义设置」/ 模型目录 / 测试连接·取消·保存）。
// **模型清单的编辑态住在 DOM 上**（与表单其它字段同一条口径）：`.model-row` 的顺序就是数组顺序，
// 带 `data-current` 的那一行就是当前模型。`readModels` 从 DOM 读回这一对，
// 不变量（`activeModel === '' || models.includes(activeModel)`）因此**按构造**成立。
// 有一处对参考图的**有意偏离**要记着：折叠行保留了次级 meta（地址 · 当前模型）——
// 5 个档案时"哪个档案打哪个地址、用哪个模型"是一眼就该看见的信息（规格 §6.1）。
```

```ts
// src/options/sections/engine.ts（片段：ProfileFormValues + readEditor，替换旧版）
/** 档案编辑表单的原始值。保存与测试连接共用它，保证两条路走的是同一份输入。 */
interface ProfileFormValues {
  label: string;
  baseUrl: string;
  models: string[];
  activeModel: string;
  apiKey: string;
}

/** 读展开区里的表单值。名字/地址去首尾空白；模型清单从 DOM 行读；Key 原样（判"填没填"时才 trim）。 */
function readEditor(editor: Element): ProfileFormValues {
  const { models, activeModel } = readModels(requireWithin<HTMLElement>(editor, '.models-field'));
  return {
    label: requireWithin<HTMLInputElement>(editor, '.profile-label').value.trim(),
    baseUrl: requireWithin<HTMLInputElement>(editor, '.profile-base-url').value.trim(),
    models,
    activeModel,
    apiKey: requireWithin<HTMLInputElement>(editor, '.profile-api-key').value,
  };
}
```

**3b. 徽章判据 + meta 文案**（加在 `buildFreeEngineRow` 之后）：

```ts
// src/options/sections/engine.ts（片段：isPresetProfile + metaTextOf）
/**
 * 这个档案接的是不是内置模板里那几家？判据是 **`baseUrl` 与某个预设逐字相同**。
 *
 * 为什么不看模型清单：徽章回答的是"这个档案接的是哪一家"，地址是那个问题的唯一答案——
 * 用户把模型名改掉之后，地址仍然明明白白写着 DeepSeek。也不做尾斜杠 / 大小写归一化：
 * 判据越"聪明"，用户越难预测它什么时候亮。`custom` 预设没有 `baseUrl`，按构造不参与匹配。
 */
function isPresetProfile(profile: EngineProfile): boolean {
  return PROVIDER_PRESETS.some((preset) => preset.baseUrl !== undefined && preset.baseUrl === profile.baseUrl);
}

/** 折叠行的次级 meta：`接口地址 · 当前模型`。未填时各写一个占位——空着会被读成"没这回事"。 */
function metaTextOf(profile: EngineProfile | undefined): string {
  if (profile === undefined) return '未填接口地址 · 未选模型';
  const baseUrl = profile.baseUrl.length > 0 ? profile.baseUrl : '未填接口地址';
  const model = profile.activeModel.length > 0 ? profile.activeModel : '未选模型';
  return `${baseUrl} · ${model}`;
}
```

**3c. 模型目录的读写与重绘**（加在 `buildEditor` 之前）：

```ts
// src/options/sections/engine.ts（片段：模型目录的 DOM 读写）
/** 模型清单的编辑态：行的顺序 = 数组顺序，带 `data-current` 的那一行 = 当前模型。 */
interface ModelsDraft {
  models: string[];
  activeModel: string;
}

/** 从 DOM 读回这一对。一行都没有时 `activeModel` 是空串——不变量按构造成立。 */
function readModels(field: Element): ModelsDraft {
  const models: string[] = [];
  let activeModel = '';
  for (const row of Array.from(field.querySelectorAll<HTMLElement>('.model-row'))) {
    const name = row.dataset.model as string;
    models.push(name);
    if (row.dataset.current !== undefined) activeModel = name;
  }
  return { models, activeModel };
}

/** 重绘清单区。**只重绘这一小块**（几行而已），外层的档案列表一行都不动。 */
function renderModels(field: Element, draft: ModelsDraft): void {
  const list = requireWithin<HTMLElement>(field, '.models-list');
  list.textContent = '';
  for (const name of draft.models) {
    const row = element('div', 'model-row');
    row.dataset.model = name;
    const current = name === draft.activeModel;
    if (current) row.dataset.current = '';
    row.append(element('span', 'model-name', name));
    if (current) row.append(element('span', 'badge', '当前'));

    const actions = element('span', 'model-actions');
    const use = element('button', 'ghost tiny', '设为当前');
    use.type = 'button';
    use.dataset.action = 'use-model';
    // 已经是当前项的那一行：按钮**存在但禁用**。禁用是诚实的（"这一项就是当前"），
    // 一个点了没反应的按钮不是。
    if (current) {
      use.disabled = true;
      use.title = '这一项已经是当前模型';
    }
    const remove = element('button', 'link-danger', '删除');
    remove.type = 'button';
    remove.dataset.action = 'remove-model';
    actions.append(use, remove);
    row.append(actions);
    list.append(row);
  }
  requireWithin<HTMLElement>(field, '.models-empty').hidden = draft.models.length > 0;
  // 每次重绘都收起手填行：加完就收，不留一个空输入框在页面上。
  requireWithin<HTMLElement>(field, '.model-new-row').hidden = true;
}

/** 展开区里的模型目录容器；编辑器不在页面上时返回 null（调用方各自决定说什么）。 */
function modelsFieldOf(id: string): HTMLElement | null {
  const editor = rowById(id)?.querySelector('.profile-editor');
  if (editor === null || editor === undefined) return null;
  return editor.querySelector<HTMLElement>('.models-field');
}

/** 手改过模型清单 → 这一行的模板下拉翻回「自定义」（与"手打地址"同一条口径）。 */
function markCustomTemplate(id: string): void {
  const editor = rowById(id)?.querySelector('.profile-editor');
  if (editor === null || editor === undefined) return;
  const provider = editor.querySelector<HTMLSelectElement>('.profile-provider');
  if (provider !== null) provider.value = 'custom';
}

/** 「+ 添加模型」：把清单区里那行手填输入框亮出来（输入框常驻 DOM、默认 hidden）。 */
function openModelInput(field: Element): void {
  requireWithin<HTMLElement>(field, '.model-new-row').hidden = false;
  requireWithin<HTMLInputElement>(field, '.profile-model-new').focus();
}
```

**3d. `buildEditor`（整体替换）**：

```ts
// src/options/sections/engine.ts（片段：buildEditor，整体替换）
function buildEditor(id: string, profile: EngineProfile | undefined): HTMLElement {
  const editor = element('div', 'profile-editor');

  const labelField = element('label', 'field');
  labelField.append(element('span', 'lab', '名字'), Object.assign(document.createElement('input'), {
    className: 'profile-label',
    type: 'text',
    value: profile?.label ?? '',
    placeholder: '例如：我的 DeepSeek',
    autocomplete: 'off',
  }));
  editor.append(labelField);

  const keyField = element('label', 'field');
  keyField.append(element('span', 'lab', 'API Key'));
  const keyRow = element('span', 'key-row');
  keyRow.append(
    Object.assign(document.createElement('input'), {
      className: 'profile-api-key',
      type: 'password',
      // 隐私硬规矩：value 恒为空。存储里的 Key 不回填、不进 DOM；留空保存 = 保留原 Key。
      value: '',
      // 占位符只说"有没有"，不透露任何一位；已配置时告诉用户"填新的会替换掉旧的"。
      placeholder: (profile?.apiKey ?? '').length > 0 ? '已配置——输入新值可替换' : '还没配置，粘贴你的 API Key',
      autocomplete: 'off',
      spellcheck: false,
    }),
    Object.assign(document.createElement('button'), {
      className: 'ghost tiny profile-toggle-key',
      type: 'button',
      textContent: '显示',
    }),
  );
  keyField.append(keyRow);
  editor.append(keyField);

  // 「自定义设置」：默认折叠；**地址为空时展开**（规格 §6.2 第 3 条：地址与模板是唯二能把这个
  // 档案接上端点的控件，折叠起来会让首屏没有任何能填地址的地方）。模板是不是自定义**不**参与判断。
  const advanced = document.createElement('details');
  advanced.className = 'profile-advanced';
  advanced.open = (profile?.baseUrl ?? '').length === 0;
  advanced.append(element('summary', '', '自定义设置'));

  const providerField = element('label', 'field');
  const providerSelect = document.createElement('select');
  providerSelect.className = 'profile-provider';
  fillSelect(
    providerSelect,
    PROVIDER_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
    'custom',
  );
  providerField.append(element('span', 'lab', '服务商模板'), providerSelect);

  const baseUrlField = element('label', 'field');
  baseUrlField.append(element('span', 'lab', '接口地址'), Object.assign(document.createElement('input'), {
    className: 'profile-base-url',
    type: 'text',
    // 档案存过什么就回填什么（地址不是凭据）；新草稿留空。
    value: profile?.baseUrl ?? '',
    placeholder: 'https://api.openai.com/v1',
    autocomplete: 'off',
    spellcheck: false,
  }));
  advanced.append(providerField, baseUrlField);
  editor.append(advanced);

  // 模型目录：右上角是"点它才请求"的拉取按钮，中间是清单，下面是虚线的添加按钮。
  const modelsField = element('div', 'field models-field');
  const modelsHead = element('span', 'models-head');
  modelsHead.append(element('span', 'lab', '模型目录'));
  const fetchButton = element('button', 'ghost tiny', '⟳ 获取可用模型');
  fetchButton.type = 'button';
  fetchButton.dataset.action = 'fetch-models';
  modelsHead.append(fetchButton);
  modelsField.append(modelsHead, element('div', 'models-list'));

  const newRow = element('span', 'model-new-row');
  newRow.hidden = true;
  const newInput = Object.assign(document.createElement('input'), {
    className: 'profile-model-new',
    type: 'text',
    value: '',
    placeholder: '手填模型名，例如 gpt-4o-mini',
    autocomplete: 'off',
    spellcheck: false,
  });
  const confirmButton = element('button', 'ghost tiny', '添加');
  confirmButton.type = 'button';
  confirmButton.dataset.action = 'confirm-model';
  const cancelModelButton = element('button', 'link-danger', '取消');
  cancelModelButton.type = 'button';
  cancelModelButton.dataset.action = 'cancel-model';
  newRow.append(newInput, confirmButton, cancelModelButton);

  const addButton = element('button', 'add', '+ 添加模型');
  addButton.type = 'button';
  addButton.dataset.action = 'add-model';
  modelsField.append(addButton, newRow);

  // 清单为空时才显示的那句说明：**每一句都为真**（规格 §6.2 第 4 条）。
  const empty = element('p', 'hint models-empty');
  empty.textContent =
    '清单为空时，弹窗里不显示模型下拉——点「添加模型」手填一个即可；拉取到的清单会先让你勾选，再并入这里。' +
    '清单只有一项时弹窗也不显示下拉，直接用那一项；两项以上才会出现下拉。';
  modelsField.append(empty);

  // 拉取结果的勾选清单（默认不显示、默认全不选）。
  const fetched = element('div', 'models-fetched');
  fetched.hidden = true;
  modelsField.append(fetched);

  editor.append(modelsField);
  renderModels(modelsField, { models: profile?.models ?? [], activeModel: profile?.activeModel ?? '' });

  const actions = element('div', 'actions');
  const testButton = element('button', 'ghost', '测试连接');
  testButton.type = 'button';
  testButton.dataset.action = 'test-profile';
  const cancelButton = element('button', 'ghost', '取消');
  cancelButton.type = 'button';
  cancelButton.dataset.action = 'cancel-profile';
  const saveButton = element('button', 'primary', '保存');
  saveButton.type = 'button';
  saveButton.dataset.action = 'save-profile';
  // 左「测试连接」、右「取消 / 保存」（图二的底部按钮行 + 我们保留的测试连接）。
  actions.append(testButton, element('span', 'grow'), cancelButton, saveButton);
  editor.append(actions);
  return editor;
}
```

**3e. 触发按钮的文案与 `aria-expanded`**（加在 `buildEditor` 之前；`buildProfileRow` 与 `applyExpansion` 共用）：

```ts
// src/options/sections/engine.ts（片段：applyTriggerState）
/**
 * 触发按钮的两种状态：文案与 `aria-expanded` **一起**设（分开写就会出现"文案说编辑、
 * 屏幕阅读器说已展开"这种自相矛盾）。`buildProfileRow` 与 `applyExpansion` 都走它。
 */
function applyTriggerState(trigger: Element, expanded: boolean): void {
  trigger.setAttribute('aria-expanded', String(expanded));
  trigger.textContent = expanded ? '收起' : '编辑';
}
```

**3f. `buildProfileRow`（整体替换）**：

```ts
// src/options/sections/engine.ts（片段：buildProfileRow，整体替换）
function buildProfileRow(ctx: SectionContext, id: string): HTMLElement {
  const snapshot = ctx.settings() as Settings;
  const isNew = id === NEW_DRAFT_ID;
  const profile = snapshot.profiles.find((item) => item.id === id);
  if (!isNew && profile === undefined) {
    // 展开目标已被别处删除时 renderProfiles 会先收起草稿之外的 id；这条是防御性兜底：
    // 没有可渲染对象的行就是空壳，不抛错。
    return element('div', 'profile-row');
  }

  const expanded = expandedId === id;
  const row = element('div', 'profile-row item');
  row.dataset.profileId = id;

  const line = element('span', 'line');
  line.append(element('span', 'name', isNew ? '新档案（未保存）' : profile?.label ?? ''));
  if (!isNew && snapshot.engineId === id) {
    line.append(element('span', 'badge', '使用中'));
  }
  if (!isNew && profile !== undefined && !isPresetProfile(profile)) {
    // 「自定义」= 这个档案接的不是内置模板里那几家（判据是地址，见 isPresetProfile）。
    const custom = element('span', 'badge badge-muted', '自定义');
    custom.dataset.template = 'custom';
    line.append(custom);
  }
  if (!isNew) {
    // 草稿行没有 id，也就没有"最近一次测试"可言——不给它一个永远灰的点。
    const dot = element('span', 'dot');
    applyDot(dot, health[profileHealthKey(id)]);
    line.append(dot);
  }
  const grow = element('span', 'grow');
  grow.append(line, element('span', 'meta', isNew ? '未填接口地址 · 未选模型' : metaTextOf(profile)));

  // 行级按钮：整行**不再是按钮**（行里现在有「删除」，整行可点会把删除变成一次误触）。
  const rowActions = element('span', 'row-actions');
  const edit = element('button', 'ghost tiny', '编辑');
  edit.type = 'button';
  edit.dataset.action = 'toggle';
  applyTriggerState(edit, expanded);
  rowActions.append(edit);
  if (!isNew) {
    const remove = element('button', 'link-danger', '删除');
    remove.type = 'button';
    remove.dataset.action = 'delete-profile';
    remove.title = '删除这个档案';
    rowActions.append(remove);
  }

  row.append(grow, rowActions);
  if (expanded) row.append(buildEditor(id, isNew ? undefined : profile));
  return row;
}
```

**3g. 未保存输入的暂存 + `applyExpansion` 整体替换**（这一段同时换用 `applyTriggerState`，并接上
「隐式收起保留未保存输入」的裁决——见本节开头的裁决块与规格 §9 第 19 条）：

```ts
// src/options/sections/engine.ts（片段：暂存 + applyExpansion，整体替换 C0 那一版）
/**
 * 每行的**未保存编辑暂存**（内存，key = 档案 id 或 `NEW_DRAFT_ID`）。
 *
 * 为什么需要它：收起编辑器 = 把 `.profile-editor` 从 DOM 里摘掉，而输入值只住在那些节点上。
 * 用户去点另一个档案的「编辑」看一眼、再点回来，刚敲的东西就没了——**这是旧实现就有的行为**
 * （实测：真档案行一样丢），C0 之后又多了一种形态（草稿行不再整行消失，但值照样丢）。
 *
 * 语义（规格 §9 第 19 条，三支互不覆盖）：
 * - **隐式收起**（点别的行 / 点本行收起 / 切到草稿行）：存下当前 DOM 的值，重新展开时先填暂存；
 * - **`取消`**：删掉这一行的暂存（那是它的定义："丢弃这次编辑"）；
 * - **`保存` 成功** / **行被删除**：删掉这一行（草稿保存后 id 会变，两个键都清）。
 *
 * ⚠ **这不是自动保存**：暂存只在内存里，关掉设置页就没了，也永远不会被静默写进存储
 *   （半填的档案绝不入库）。
 *
 * ⚠ **它搬 Key，而且是唯一一处**：暂存里那一格是"用户刚在这个输入框里敲的值"，不是存储里那份
 *   ——隐私硬规矩（存储里的 Key 不回填、不进 DOM）一字未改，只是用户自己敲进去的字不该因为
 *   他点了一下别的行就蒸掉。`restoreEditor` 把它写回 `.value` 时输入框仍然是 `password`。
 *
 * **刻意不做**：这里没有"扫一遍删掉孤儿暂存"的清理。那种清理**写不出读数**（谁也说不出少了它
 * 会怎样），而三个显式清点各有用例。孤儿条目只是内存里几十字节，且 id 带随机段、不会复用。
 */
const editorDrafts = new Map<string, ProfileFormValues>();

/** 收起**之前**把这一行 DOM 里的值存下来。读不出来（控件缺失）就什么都不存：宁可不暂存，也不留个坏值。 */
function stashEditor(id: string, editor: Element): void {
  try {
    editorDrafts.set(id, readEditor(editor));
  } catch {
    editorDrafts.delete(id);
  }
}

/** 展开时把暂存填回新造的编辑器；没有暂存就什么都不做（表单保持快照的值）。 */
function restoreEditor(id: string, editor: Element): void {
  const draft = editorDrafts.get(id);
  if (draft === undefined) return;
  requireWithin<HTMLInputElement>(editor, '.profile-label').value = draft.label;
  requireWithin<HTMLInputElement>(editor, '.profile-base-url').value = draft.baseUrl;
  requireWithin<HTMLInputElement>(editor, '.profile-api-key').value = draft.apiKey;
  // 模型清单住在 DOM 行上，所以"恢复清单"就是把清单区按暂存重画一遍。
  renderModels(requireWithin<HTMLElement>(editor, '.models-field'), {
    models: draft.models,
    activeModel: draft.activeModel,
  });
}

/**
 * 展开 / 收起只动受影响的那一两行。
 *
 * 为什么不是 `renderProfiles(ctx)`：那个函数开头清空整张列表再重建（档案行 + 免费引擎行），
 * 于是**每次点开一个档案都要重建 N+1 行**——代价随档案数线性增长，用户点一下要等。
 * 展开只改三件东西：这一行触发按钮的 `aria-expanded` 与文案、这一行里**有没有**
 * `.profile-editor`、以及摘/插编辑器前后各一次暂存的读与写。列表结构、行顺序、免费引擎行、
 * 其它行通通不动。
 *
 * `renderProfiles` 只留给"数据真的变了"的路径：挂载、保存后、删除后、重载。
 */
function applyExpansion(ctx: SectionContext): void {
  const snapshot = ctx.settings();
  if (snapshot === null) return;
  for (const row of Array.from(profilesList.querySelectorAll<HTMLElement>('.profile-row[data-profile-id]'))) {
    const id = row.dataset.profileId as string;
    const expanded = id === expandedId;
    const trigger = row.querySelector('[data-action="toggle"]');
    if (trigger !== null) applyTriggerState(trigger, expanded);
    const existing = row.querySelector('.profile-editor');
    if (expanded && existing === null) {
      const profile = id === NEW_DRAFT_ID ? undefined : snapshot.profiles.find((item) => item.id === id);
      const editor = buildEditor(id, profile);
      // **先恢复暂存、再插进 DOM**：用户看到的第一帧就是他离开时的样子，不会闪一下空表单。
      restoreEditor(id, editor);
      row.append(editor);
    } else if (!expanded && existing !== null) {
      // 收起 = 把编辑器摘掉。**摘之前先把值存进暂存**，否则用户敲的东西随节点一起没了
      // （"一次只展开一个"的执行点就是这一句）。
      stashEditor(id, existing);
      existing.remove();
    }
  }
}
```

**3h. `applyProviderTemplate`（整体替换）**：

```ts
// src/options/sections/engine.ts（片段：applyProviderTemplate，整体替换）
/**
 * 服务商模板 = 编辑表单的**填写捷径**：选中即把接口地址填进**这一行**，把该模板的模型名
 * 并入模型清单并设为当前。用户还没点保存，改回来零成本。不碰 API Key（那是用户自己的凭据）。
 * 只挂在下拉自己的 change 上——展开既有档案时**永远不重放**预设（否则会把用户存过的
 * 地址/模型悄悄改回模板值）。
 */
function applyProviderTemplate(editor: Element): void {
  const select = requireWithin<HTMLSelectElement>(editor, '.profile-provider');
  const preset = PROVIDER_PRESETS.find((entry) => entry.id === select.value);
  if (preset === undefined || preset.baseUrl === undefined || preset.model === undefined) return;
  requireWithin<HTMLInputElement>(editor, '.profile-base-url').value = preset.baseUrl;
  const field = editor.querySelector<HTMLElement>('.models-field');
  if (field === null) return;
  const draft = readModels(field);
  const models = draft.models.includes(preset.model) ? draft.models : [...draft.models, preset.model];
  renderModels(field, { models, activeModel: preset.model });
}
```

**3i. 四个新处理器 + 取消**（加在 `handleDeleteProfile` 之后）：

```ts
// src/options/sections/engine.ts（片段：手填/设为当前/删除模型/取消）
/**
 * 手填一个模型并加进清单。两条判据：**空值与重复值不写入**。
 * 添加成功的那一项**即设为当前**：用户加一个模型几乎总是为了用它；不设当前的话，档案会停在
 * "还没有模型"（§3.3），他还要再点一次「设为当前」。
 */
function handleAddModel(id: string): void {
  const field = modelsFieldOf(id);
  if (field === null) {
    setStatus(engineStatus, 'err', '档案编辑区不在页面上，请重新展开该档案');
    return;
  }
  const input = requireWithin<HTMLInputElement>(field, '.profile-model-new');
  const name = input.value.trim();
  if (name.length === 0) {
    setStatus(engineStatus, 'err', '模型名不能为空——填一个服务商认得的名字再加。');
    return;
  }
  const draft = readModels(field);
  if (draft.models.includes(name)) {
    setStatus(engineStatus, 'err', `清单里已经有「${name}」了，没有重复添加。`);
    return;
  }
  input.value = '';
  renderModels(field, { models: [...draft.models, name], activeModel: name });
  markCustomTemplate(id);
  setStatus(engineStatus, 'ok', `已加入「${name}」并设为当前模型。记得点「保存」。`);
}

/** 「设为当前」：只换当前项，清单本身不动。 */
function handleUseModel(id: string, name: string): void {
  const field = modelsFieldOf(id);
  if (field === null) return;
  renderModels(field, { models: readModels(field).models, activeModel: name });
  setStatus(engineStatus, 'ok', `当前模型改成了「${name}」。记得点「保存」。`);
}

/**
 * 从清单里删掉一个模型。**删的正是当前模型时自愈**（§3.1）：取剩下的最后一个；清单空了就置 ''。
 * 不变量因此永远成立——读取边界（`pickProfile`）是同一套规则的第二道。
 */
function handleRemoveModel(id: string, name: string): void {
  const field = modelsFieldOf(id);
  if (field === null) return;
  const draft = readModels(field);
  const models = draft.models.filter((item) => item !== name);
  const last = models.length > 0 ? (models[models.length - 1] as string) : '';
  const activeModel = draft.activeModel === name ? last : draft.activeModel;
  renderModels(field, { models, activeModel });
  markCustomTemplate(id);

  if (draft.activeModel !== name) {
    setStatus(engineStatus, 'ok', `已从清单里移除「${name}」。记得点「保存」。`);
    return;
  }
  if (activeModel.length > 0) {
    setStatus(engineStatus, 'ok', `已移除当前模型「${name}」，当前模型改成了「${activeModel}」。记得点「保存」。`);
    return;
  }
  setStatus(
    engineStatus,
    'err',
    `已移除最后一个模型「${name}」——这个档案现在没有模型，翻译会给一句可读的错误（不会发请求）。记得点「保存」。`,
  );
}

/**
 * 「取消」= **显式丢弃**这一行的编辑。
 *
 * 为什么不需要撤销栈：编辑值只住在 DOM 与那一格内存暂存里（保存才写存储），所以"丢弃"
 * 就是两件事——**删掉这一行的暂存**，再把编辑器从行里摘掉（`applyExpansion` 做后者）。
 * 少了"删暂存"那一句，收起时写的暂存会在下次展开时把刚被取消的草稿填回来（用例当场红）。
 *
 * 它也不可能顺手把别的行、别的字段一起丢掉。
 * 草稿行没有存储里对应的东西：取消它就把整行移除（否则会留下一个收起的空壳），并清掉它的暂存。
 */
function handleCancelProfile(ctx: SectionContext, id: string): void {
  // 这一句是"取消"与"隐式收起"的分界：隐式收起**保留**暂存，取消**清掉**它。
  editorDrafts.delete(id);
  if (id === NEW_DRAFT_ID) {
    expandedId = null;
    rowById(NEW_DRAFT_ID)?.remove();
    setStatus(engineStatus, 'ok', '已取消这个新档案，它没有被保存过。');
    return;
  }
  if (expandedId === id) expandedId = null;
  applyExpansion(ctx);
  setStatus(engineStatus, 'ok', '已取消这次编辑，存储里的内容一个字节都没动。');
}
```

**3j. 拉取与并入**（同上，加在 3i 之后）：

```ts
// src/options/sections/engine.ts（片段：拉取与并入）
/**
 * 「⟳ 获取可用模型」：**点它才请求**（§5.4）。消息里只有一个 `profileId`——
 * 后台按它自己从存储读 baseUrl / apiKey（§5.1），**面板里还没保存的改动不参与**。
 */
async function handleFetchModels(ctx: SectionContext, id: string): Promise<void> {
  const editor = rowById(id)?.querySelector('.profile-editor');
  if (editor === null || editor === undefined) {
    setStatus(engineStatus, 'err', '档案编辑区不在页面上，请重新展开该档案');
    return;
  }
  const profile = ctx.settings()?.profiles.find((item) => item.id === id);
  if (profile === undefined) {
    setStatus(engineStatus, 'err', '新档案还没保存过：先把名字、接口地址与 Key 填好，点一次「保存」，再来拉取。');
    return;
  }
  setStatus(engineStatus, 'pending', `正在向 ${profile.baseUrl} 请求模型清单…`);

  let response: FetchModelsResponse | undefined;
  try {
    response = (await chrome.runtime.sendMessage({
      type: MSG.FETCH_MODELS,
      payload: { profileId: id },
    })) as FetchModelsResponse | undefined;
  } catch (raw) {
    // 没有接收方（SW 刚被回收 / 扩展刚更新过）与"后台内部报错"在这里是同一种形状，如实说。
    setStatus(engineStatus, 'err', `拉取模型清单失败：${describe(raw)}。仍然可以用「添加模型」手填。`);
    return;
  }
  if (response === undefined) {
    setStatus(engineStatus, 'err', '拉取模型清单失败：后台没有响应。仍然可以用「添加模型」手填。');
    return;
  }
  if (!response.ok) {
    // 后台那句已经是"发生了什么 + 你能做什么"，原样显示（两处各写一句必然漂移）。
    setStatus(engineStatus, 'err', response.message);
    return;
  }
  if (response.models.length === 0) {
    setStatus(engineStatus, 'err', '这个地址没有给出可用的模型清单——不是所有服务商都实现了它。请用「添加模型」手填。');
    return;
  }
  renderFetchedModels(editor, response.models);
  setStatus(engineStatus, 'ok', `拿到了 ${response.models.length} 个模型名，勾选后点「并入清单」。`);
}

/** 拉取结果的勾选清单（默认**全不选**）：勾完点「并入清单」才会动上面的模型清单。 */
function renderFetchedModels(editor: Element, names: string[]): void {
  const box = requireWithin<HTMLElement>(editor, '.models-fetched');
  box.textContent = '';
  for (const name of names) {
    const label = element('label', 'fetched-row');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'profile-model-pick';
    checkbox.value = name;
    checkbox.checked = false;
    // 用户数据一律 textContent，不进 HTML 解析（规格 §7）。
    label.append(checkbox, element('span', 'fetched-name', name));
    box.append(label);
  }
  const merge = element('button', 'ghost tiny', '并入清单');
  merge.type = 'button';
  merge.dataset.action = 'merge-models';
  const cancel = element('button', 'link-danger', '取消');
  cancel.type = 'button';
  cancel.dataset.action = 'cancel-fetched';
  box.append(merge, cancel);
  box.hidden = false;
}

/**
 * 把勾上的模型名并入清单（去重）。
 * **只有当清单原本为空时**才把并入的第一项设为当前：清单非空时不动用户已经选好的那一个。
 */
function handleMergeModels(id: string): void {
  const editor = rowById(id)?.querySelector('.profile-editor');
  if (editor === null || editor === undefined) return;
  const field = requireWithin<HTMLElement>(editor, '.models-field');
  const box = requireWithin<HTMLElement>(editor, '.models-fetched');
  const picked = Array.from(box.querySelectorAll<HTMLInputElement>('.profile-model-pick'))
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.value);
  if (picked.length === 0) {
    setStatus(engineStatus, 'err', '一个都没勾：先勾上要加进来的模型，再点「并入清单」。');
    return;
  }
  const draft = readModels(field);
  const models = [...draft.models];
  for (const name of picked) if (!models.includes(name)) models.push(name);
  const activeModel = draft.activeModel.length > 0 ? draft.activeModel : (picked[0] as string);
  renderModels(field, { models, activeModel });
  markCustomTemplate(id);
  box.hidden = true;
  box.textContent = '';
  setStatus(engineStatus, 'ok', `已并入 ${picked.length} 个模型名（重复的不再追加）。记得点「保存」。`);
}

/** 收起拉取结果（不动清单）。 */
function handleCancelFetched(id: string): void {
  const editor = rowById(id)?.querySelector('.profile-editor');
  if (editor === null || editor === undefined) return;
  const box = editor.querySelector<HTMLElement>('.models-fetched');
  if (box === null) return;
  box.hidden = true;
  box.textContent = '';
}
```

**3k. `handleSaveProfile` 改用 `values.models` / `values.activeModel`**（替换 C1 的映射）：

```ts
// src/options/sections/engine.ts（片段：handleSaveProfile 的 profiles 构造）
  const isNew = id === NEW_DRAFT_ID;
  let savedId: string;
  let profiles: EngineProfile[];
  if (isNew) {
    savedId = createProfileId();
    profiles = [
      ...latest.profiles,
      {
        id: savedId,
        label: values.label,
        baseUrl: values.baseUrl,
        models: values.models,
        activeModel: values.activeModel,
        apiKey: values.apiKey,
      },
    ];
  } else {
    savedId = id;
    const existing = latest.profiles.find((profile) => profile.id === id);
    // Key 留空 = 保留存储里当前的那份（不是页面打开时的快照——整份覆盖的老坑同一个）。
    const apiKey = values.apiKey.trim().length > 0 ? values.apiKey : existing?.apiKey ?? '';
    const nextProfile: EngineProfile = {
      id: savedId,
      label: values.label,
      baseUrl: values.baseUrl,
      models: values.models,
      activeModel: values.activeModel,
      apiKey,
    };
    profiles = existing === undefined ? [...latest.profiles, nextProfile] : latest.profiles.map((p) => (p.id === id ? nextProfile : p));
  }
```

**3l. `handleTestProfile` 用表单里的清单 + 没有当前模型时不发请求**（替换 C1 的合成档案那一段）：

```ts
// src/options/sections/engine.ts（片段：handleTestProfile 的合成档案 + 零请求闸）
  const storedProfile = ctx.settings()?.profiles.find((profile) => profile.id === id);
  // Key 输入框留空时测的是**存储里已存的**那份（和"保存"同一语义）；新草稿没存过就是空，
  // 引擎会给出可行动的 AUTH 提示。
  const apiKey = values.apiKey.trim().length > 0 ? values.apiKey : storedProfile?.apiKey ?? '';
  const { engine, config, problem } = resolveEngine({
    engineId: id,
    profiles: [
      {
        id,
        label: values.label,
        baseUrl: values.baseUrl,
        models: values.models,
        activeModel: values.activeModel,
        apiKey,
      },
    ],
  });
  // 没有当前模型：**不发请求**，把规格 §3.3 那句话显示出来（与翻译路径同一条口径）。
  if (problem !== undefined) {
    setStatus(engineStatus, 'err', problem);
    return;
  }
```

**3m. `bind`：click 委托 + input 委托**（整体替换这两段）：

> ⚠ **口径必须与 `7991539` 落地的那一版一致**（这一节原来是照 C0 时的旧口径写的）：动作要从**最近的 `[data-action]` 祖先**取，不是读 `event.target.dataset.action`。旧口径在真机上表现为"点档案行头里的文字没反应、只有点在按钮自己的空白边距上才有反应"（行头是 `<button class="profile-summary">` 里包着 `<span class="name">` / `<span class="meta">` / `.dot`，点在文字上时 `target` 是那些 span）。**照旧口径整体替换 = 把真机上刚修好的 bug 改回去**，而 `engine-expansion.test.ts` 里那两条新用例（点 `.meta` 就展开、连点两次展开再收起）会红——那两条就是它的守卫。`row.contains(actionEl)` 那道闸今天**没有任何用例杀得死**（`[data-action]` 只出现在行内），如实记在「复盘记录 › 有行为、无读数」里，**不许**为它编一条恒真用例。

```ts
// src/options/sections/engine.ts（片段：bind 的 click 委托，整体替换；口径与 7991539 一致）
    profilesList.addEventListener('click', (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      // ⚠ 动作要取**最近的 `[data-action]` 祖先**，不能读 `event.target.dataset.action`：
      // 行头是 `<button class="profile-summary">` 里包着 `span.name` / `span.meta` / `.dot`，
      // 点在文字上时 target 是那些 span —— 读 target 会得到 undefined，于是"点名字没反应、
      // 只有点在按钮空白处才有反应"。真机读数（临时探针，5 次点击）：4 次 `action="(none)"`，
      // target 分别是 `span.meta` / `span.grow`；页面只有 294 个节点、点一次 3~7ms，
      // 所以那不是性能问题。
      //
      // Key 显示/隐藏必须**先判**（它自己不带 `data-action`，但它整条支路都在这一个按钮上）：
      // 交给 `toggleKeyVisibility` 的必须是那个按钮本身，不是它未来的子元素——文案与
      // `aria-pressed` 写在按钮上，写到子元素上等于把按钮文字抹掉。
      const keyToggle = target.closest<HTMLElement>('.profile-toggle-key');
      if (keyToggle !== null) {
        toggleKeyVisibility(keyToggle);
        return;
      }
      const actionEl = target.closest<HTMLElement>('[data-action]');
      const action = actionEl?.dataset.action ?? null;
      // 免费引擎那一行不在 `[data-profile-id]` 里，必须在行判断之前处理。
      if (action === 'test-free') {
        runSafely(engineStatus, '测试连接失败', () => handleTestFreeEngine(ctx));
        return;
      }
      const row = target.closest('[data-profile-id]');
      if (!(row instanceof HTMLElement)) return;
      // 动作元素必须落在这一行里，别让嵌套/无关的 `[data-action]` 串到别的行上。
      if (actionEl === null || !row.contains(actionEl)) return;
      const id = row.dataset.profileId as string;
      // 模型行内那两个动作要带上"哪一项"：模型名住在最近的那个 `.model-row` 的 dataset 上。
      const modelRow = actionEl.closest('.model-row');
      const model = modelRow instanceof HTMLElement ? (modelRow.dataset.model as string) : '';
      switch (action) {
        case 'toggle':
          if (ctx.settings() === null) return;
          // 一次只展开一个：把上一个的编辑器摘掉这件事由 applyExpansion 做（就地，不重建列表）。
          expandedId = expandedId === id ? null : id;
          applyExpansion(ctx);
          break;
        case 'cancel-profile':
          handleCancelProfile(ctx, id);
          break;
        case 'save-profile':
          runSafely(engineStatus, '保存失败', () => handleSaveProfile(ctx, id));
          break;
        case 'test-profile':
          runSafely(engineStatus, '测试连接失败', () => handleTestProfile(ctx, id));
          break;
        case 'delete-profile':
          runSafely(engineStatus, '删除失败', () => handleDeleteProfile(ctx, id));
          break;
        case 'add-model': {
          const field = modelsFieldOf(id);
          if (field !== null) openModelInput(field);
          break;
        }
        case 'cancel-model': {
          const field = modelsFieldOf(id);
          if (field !== null) requireWithin<HTMLElement>(field, '.model-new-row').hidden = true;
          break;
        }
        case 'confirm-model':
          handleAddModel(id);
          break;
        case 'use-model':
          handleUseModel(id, model);
          break;
        case 'remove-model':
          handleRemoveModel(id, model);
          break;
        case 'merge-models':
          handleMergeModels(id);
          break;
        case 'cancel-fetched':
          handleCancelFetched(id);
          break;
        case 'fetch-models':
          runSafely(engineStatus, '拉取模型清单失败', () => handleFetchModels(ctx, id));
          break;
      }
    });
```

```ts
// src/options/sections/engine.ts（片段：bind 的 input 委托，整体替换）
    profilesList.addEventListener('input', (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      // 地址被手打 → 这一行按"自定义"算：模板下拉翻回 custom，而不是留着个已经说谎的
      // 「DeepSeek」。预设永远不许反过来覆盖用户敲进去的值。
      // （模型清单那一侧的同一件事在 `markCustomTemplate`：加/删模型同样算手改。）
      if (target.classList.contains('profile-base-url')) {
        const editor = target.closest('.profile-editor');
        if (editor !== null) requireWithin<HTMLSelectElement>(editor, '.profile-provider').value = 'custom';
      }
    });
```

**3n. `renderEngineHint` 的文案**（改动处：不再说"点档案行展开"）：

```ts
// src/options/sections/engine.ts（片段：renderEngineHint 的那两句）
  if (engine.needsKey && selected !== undefined) {
    engineHint.textContent = `当前在用档案「${selected.label}」。点这一行右侧的「编辑」展开；在弹窗的「翻译引擎」里按名字切换。`;
    return;
  }
  engineHint.textContent = '当前在用免费接口（零配置）。档案配好后，在弹窗的「翻译引擎」下拉里按名字选中才会生效。';
```

**3o. `import` 增加两处**（`MSG` 与 `FetchModelsResponse`）：

```ts
// src/options/sections/engine.ts（片段：顶部 import 增加两行）
import { MSG, type FetchModelsResponse } from '../../shared/messages';
```

**3p. 暂存的生命周期：保存成功与删除档案各清一格**（两处改动）。

```ts
// src/options/sections/engine.ts（片段：handleSaveProfile 成功之后）
  const saved = await ctx.save(engineStatus, '设置未能保存', { profiles });
  if (!saved) return;

  // 保存成功 = 这次编辑会话结束：清掉这一行的暂存。
  // ⚠ `NEW_DRAFT_ID` 那一格也必须清：草稿保存后 id 从 `__new__` 变成新生成的档案 id，
  // 留着它，下一次点「新增档案」就会把刚保存的那份草稿预填回去（`engine-models.test.ts`
  // 里「草稿保存成功后清掉草稿暂存」那条用例专门守它）。
  // 而同档案那一格**没有独立读数**（保存后 `renderProfiles` 会按新快照重建这一行，DOM 本来就
  // 不是旧草稿）——它留在这里的理由是"一条暂存不该活得比它对应的编辑会话更久"。
  editorDrafts.delete(savedId);
  editorDrafts.delete(NEW_DRAFT_ID);

  expandedId = savedId;
  renderProfiles(ctx);
  renderEngineHint(ctx);
```

```ts
// src/options/sections/engine.ts（片段：handleDeleteProfile 的两处清理）
  const target = latest.profiles.find((profile) => profile.id === id);
  if (target === undefined) {
    // 别处已经删过（并发窗口）：如实说，并刷新到存储的真实列表，不静默"删除成功"。
    expandedId = null;
    // 它的暂存也跟着走：档案都不在了，留着这一格只会在同一个 id 被重新造出来时把旧草稿带回来。
    editorDrafts.delete(id);
    const refreshed = await renderFromStorage(ctx);
```

```ts
// src/options/sections/engine.ts（片段：handleDeleteProfile 成功删除之后）
  const saved = await ctx.save(
    engineStatus,
    '设置未能保存',
    { profiles: remaining, engineId: wasCurrent ? DEFAULT_ENGINE_ID : latest.engineId },
  );
  if (!saved) return;

  // 档案没了，它的暂存也不该留（同一个 id 不会复用，但"删了还留着"本身就是没道理的）。
  editorDrafts.delete(id);
  if (expandedId === id) expandedId = null;
  renderProfiles(ctx);
  renderEngineHint(ctx);
```

- [ ] **Step 4: 实现（`src/options/options.html` 的引擎区块文案）**

```html
<!-- src/options/options.html（片段：替换引擎区块里那个 <p class="hint">） -->
          <p class="hint">
            一个档案 = 一份接口地址 + 一份模型清单 + API Key（走 OpenAI 兼容协议，可接 OpenAI、DeepSeek、
            硅基流动、Ollama 等）。点某一行右侧的「编辑」展开：在那里把模型加进清单（手填，或点
            「⟳ 获取可用模型」从接口拉一份回来勾选），并把其中一个设为「当前」。配好几个档案后，在
            <strong>弹窗</strong>的「翻译引擎」下拉里按名字直接切换；某个档案有 2 个以上模型时，
            弹窗里会多出一个模型下拉。每个档案的访问授权在点该档案的「保存」时按它自己的地址申请
            （Chrome 要求用户手势）。
          </p>
```

- [ ] **Step 5: 实现（`src/options/options.css`）**

**5a. 删掉两条死规则**（`.profile-summary` 与 `.profile-summary:hover` 整块删掉——折行不再是按钮，`.profile-row` 的 `.item` 已经给了 flex 与内边距）。

**5b. 在 `.lab small, .grow2 .lab span { … }` 之后追加一整块**（位置很重要：必须在 `.field` 与 `.badge` **之后**，否则 `.models-field` 的 `display: block` 会被 `.field` 的 `display: flex` 盖掉、`.badge-muted` 会被 `.badge` 盖掉——同特异度只看源码顺序）：

```css
/* src/options/options.css（片段：追加在 .lab small / .grow2 .lab span 之后） */

/* ------------------------------------------------------------------ 档案行右侧的行级按钮 */

/*
 * 折叠行右侧的 `编辑` / `删除`。整行**不再是按钮**：行里现在有「删除」，整行可点会把删除
 * 变成一次误触（改版规格里"点整行展开"因此改成"点「编辑」"）。
 */
.row-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
}

/* 「自定义」徽章 = 次级配色版（与强调色版的「使用中」区分开）。不许用 opacity（§7）。 */
.badge-muted {
  color: var(--text-2);
  background: var(--surface-3);
}

/* ------------------------------------------------------------------ 模型目录（规格 §6.2 第 4 条） */

/* 这一块是"标题 + 清单 + 按钮"的竖排，不是 `.field` 那种"左标签右控件"的一行。 */
.models-field {
  display: block;
}

.models-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.models-head .lab {
  flex: 1;
}

/* 清单长了就自己滚：有些网关列几百个（§10），本轮只做可滚动 + 勾选，不做搜索框。 */
.models-list {
  max-height: 220px;
  overflow-y: auto;
}

.model-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
}

.model-name {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12.5px;
  color: var(--text);
  overflow-wrap: anywhere;
}

.model-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
}

.model-new-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.model-new-row input {
  flex: 1 1 auto;
  min-width: 0;
}

.models-empty {
  margin: 8px 0 0;
}

.fetched-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 12.5px;
  color: var(--text-2);
}
```

- [ ] **Step 6: 迁移 20 处既有断言（只增不减）**

**6a. `tests/options/harness.ts`：**把 C1 加的两个 helper 的实现换成 C4 的，并新增 `rowButton`。

```ts
// tests/options/harness.ts（片段：setModel / currentModel 换实现 + 新增 rowButton）
/**
 * 把某一行的模型设成 `model`——**编辑面板里"改模型"这件事的唯一夹具入口**。
 *
 * C4 之后走的是**真实用户路径**：点「+ 添加模型」→ 往手填框里填名字 → 点「添加」。
 * 于是"空值与重复值不写入"的判据也被这些用例顺带走过（它们本来只关心"模型改了"）。
 */
export function setModel(editor: Element, model: string): void {
  editor.querySelector<HTMLButtonElement>('[data-action="add-model"]')!.click();
  fieldOf(editor, '.profile-model-new').value = model;
  editor.querySelector<HTMLButtonElement>('[data-action="confirm-model"]')!.click();
}

/** 读回"这一行现在的模型"：清单里带 `data-current` 的那一项（一项都没有就是空串）。 */
export function currentModel(editor: Element): string {
  const row = editor.querySelector<HTMLElement>('.model-row[data-current]');
  return row === null ? '' : (row.dataset.model as string);
}

/**
 * 折叠行右侧的行级按钮（`编辑` / `删除`）。它们**不在** `.profile-editor` 里，
 * 所以 `actionButton(editor, …)` 找不到它们。
 */
export function rowButton(id: string, action: string): HTMLButtonElement {
  const button = rowOf(id).querySelector<HTMLButtonElement>(`.row-actions [data-action="${action}"]`);
  if (button === null) throw new Error(`档案行 ${id} 缺按钮 ${action}`);
  return button;
}
```

**6b. 迁移表（逐条；改动前 → 改动后）**

| 文件:行 | 改动前 | 改动后 |
| --- | --- | --- |
| `options.test.ts:311` 一带 | `models: ['deepseek-chat-v2']`（C1 写的**有损**期望） | `models: ['deepseek-chat', 'deepseek-chat-v2']` + `activeModel: 'deepseek-chat-v2'`（C4 之后"加一个模型"是**追加**，不是替换；这条期望因此比 C1 更强） |
| `options.test.ts:520` | `const editor = expand('p-a'); actionButton(editor, 'delete-profile').click();` | `expand('p-a');`（保留：删除前的展开状态是用户真实路径）+ `rowButton('p-a', 'delete-profile').click();` |
| `options.test.ts:544` | `const editor = expand('p-b'); actionButton(editor, 'delete-profile').click();` | `expand('p-b');` + `rowButton('p-b', 'delete-profile').click();` |
| `options.test.ts:585` | `actionButton(editorOf('p-a'), 'delete-profile').click();` | `rowButton('p-a', 'delete-profile').click();` |
| `options.test.ts:627` | `actionButton(editorOf('p-a'), 'delete-profile').click();` | `rowButton('p-a', 'delete-profile').click();` |
| `engine-health.test.ts:220` | `editor.querySelector<HTMLButtonElement>('[data-action="delete-profile"]')!.click();` | `rowButton('p-a', 'delete-profile').click();`（该用例的 `profileRows()[0]` 就是 `p-a`） |
| `options.test.ts` 顶部 import | 从 `./harness` 导入的清单 | 加 `rowButton`（`setModel` / `currentModel` 在 C1 已经加过） |
| `engine-health.test.ts` 顶部 import | 同上 | 加 `rowButton` |

**6c. 收口检查（`options.test.ts` 里这三条必须仍然绿，且语义更强）**

| 用例 | 为什么它仍然有效 |
| --- | --- |
| `:59` 每个档案一行：名字 + 地址 + 模型名 + 「使用中」 | 折叠行仍同时含这四样（meta 行留着，正是**偏离一**的收益） |
| `:156` v2 老数据打开设置页就能用 | 迁移链路不变；该行现在还会多一个「自定义」徽章（地址是 DeepSeek 的 → 其实**不会**有，因为命中预设） |
| `:406/:430/:453` 三个权限申请用例 | 保存路径没变（`handleSaveProfile` 只换了字段来源），`actionButton(editor,'save-profile')` 仍指向同一颗按钮 |

- [ ] **Step 7: 跑到绿**

Run: `npx vitest run tests/options`

Expected: `engine-models.test.ts` 全绿（含**暂存那三条**：切走再切回草稿行 / 切走再切回真档案行 / 草稿保存后暂存清空）；`options.test.ts` / `engine-health.test.ts` 在迁移之后一条都不红。**若有红，先分辨**：是"迁移漏了一处点击位置"，还是"断言被改弱了"——后者不许用放宽断言解决。

Run: `npx vitest run tests/options/options.test.ts tests/options/engine-health.test.ts`

Expected: 全绿——特别是既有的隐私用例（「三个档案各塞不同密钥——收起与展开后，DOM 里一个都不许出现」）：暂存只搬**用户刚敲进去的**值，存储里的 Key 一个都不进暂存，所以那条用例与它引用的每个密钥都照旧。

Run: `npx vitest run tests/options/options-css.test.ts tests/options/no-innerhtml.test.ts tests/options/search.test.ts`

Expected: 全绿。三条分别管着：CSS 令牌纪律（新规则只用 `--text-2` / `--surface-3` / `--text`，都在暗色块里有值）、源码里不出现 HTML 注入面的那三个标识符（新代码里也没有——用户数据走 `textContent` 与 `dataset`）、以及**别名互斥矩阵**（新增的 `.lab` 只有「模型目录」，它不含任何别的区块的别名；`#engine-hint` 的新句子也只含引擎自己的词）。

- [ ] **Step 8: 变异验证**

| 变异 | 期望红在哪一条 |
| --- | --- |
| 折叠行保留 `.profile-summary`（整行仍是按钮） | 「折叠行：…整行不再是按钮」——`row.querySelector('.profile-summary')` 不为 null |
| **click 委托退回旧口径 `target.dataset.action`**（即把 `7991539` 的真机修复改回去） | `tests/options/engine-expansion.test.ts` 里那**两条**新用例红（「点行头里的 `.meta` 就展开」「连点 `.meta` 两次 = 展开再收起」——`expected null not to be null`）。⚠ 这条**不在 C4 自己的测试文件里**：步 3m 是整体替换那段委托，所以替换时必须照抄 `closest('[data-action]')` 的口径；照旧口径写就是"本地全绿、真机复发" |
| `isPresetProfile` 改成 `profile.models.length > 0`（判据换成清单） | 「「自定义」徽章…」——`p-b`（DeepSeek 地址 + 预设模型）**也**长出徽章 |
| `isPresetProfile` 恒返回 false（人人都是自定义） | 同一条——`p-b` / `p-c` 上冒徽章 |
| `metaTextOf` 的占位写成 `''` | 「次级 meta 的占位」红（读到 `' · '`） |
| `advanced.open = (profile?.baseUrl ?? '').length === 0` 改成恒 `false` | 「「自定义设置」默认折叠…」——草稿那半红 |
| 同一行改成恒 `true` | 同一条——已有地址那半红 |
| `handleAddModel` 里删掉重复判据 | 「手填添加：空值与重复值都不写入」——第三次添加后 `names()` 多一项 |
| 添加成功改成**不**设当前（`activeModel: draft.activeModel`） | 同一条——`currentModel` 还是 `deepseek-chat` |
| `handleRemoveModel` 里 `draft.activeModel === name ? last : …` 的条件删掉（永远取 last） | 「删掉当前模型…」——删掉**非当前**项时当前模型也会被改（这里第一次删的正好是当前项，所以**额外**需要一个断言：删非当前项 `a` 之后 `currentModel` 仍是 `c`。**加进那条用例**） |
| `handleRemoveModel` 里 `last` 写成 `models[0] ?? ''` | 同一条——第一次删 `b` 后当前项变成 `a` 而不是 `c` |
| 「当前项」那颗 `use.disabled = true` 删掉 | 「「设为当前」切换当前项…」——`useButton('a').disabled` 为 false |
| `handleCancelProfile` 里删掉 `applyExpansion(ctx)` | 「取消：…」——`rowOf('p-a').querySelector('.profile-editor')` 不为 null |
| 取消草稿那一支改成 `applyExpansion`（只收起不移除） | 「取消草稿行」——`profileRows()` 仍是 `['__new__']` |
| **暂存六行（规格 §9 第 19 条，逐行都有读数）** | |
| `stashEditor(id, existing)` 那一行删掉（收起时不存） | 「切走再切回草稿行…」读到空串；「切走再切回真档案行…」同样红 |
| `restoreEditor(id, editor)` 那一行删掉（展开时不读暂存） | 同上两条红（暂存写了也没人读） |
| `restoreEditor` 里恢复 `.profile-api-key` 那一行删掉 | 「切走再切回真档案行…」——`value` 是 `''` 而不是 `sk-typed-here` |
| `stashEditor` / `restoreEditor` 的 key 从 `id` 改成处处用 `NEW_DRAFT_ID`（**对称性破坏**：所有行共用一格） | **两条用例各红一处**：「切走再切回真档案行…」——切到 p-b 时它读到 p-a 的草稿（`fieldOf(other, '.profile-label')` 是 `改了一半` 而不是 `B 家`）；「切走再切回草稿行…」——切回草稿行读到 p-a 的值（`我的 DeepSeek` 而不是 `临时档案`）。⚠ 机理：`applyExpansion` 按 **DOM 顺序**遍历，上一次调用留下的那一格会被下一行读走——所以**必须**有"切过去那一行看不到别人的草稿"这条断言，只比较"切回自己那一行"抓不住它 |
| `handleCancelProfile` 开头那行 `editorDrafts.delete(id)` 删掉 | 「取消：改名字 + 加模型后取消…」——再展开读到 `改过的名字` 与 `another-model`（**这条用例现在还守着"取消清暂存"**） |
| `handleSaveProfile` 里 `editorDrafts.delete(NEW_DRAFT_ID)` 删掉 | 「草稿保存成功后清掉草稿暂存：再点「新增档案」是一张白纸…」——新草稿被上一次的值预填 |
| `handleSaveProfile` 里 `editorDrafts.delete(savedId)` 删掉 | **不设此变异（已核实不可观察）**：保存成功后 `renderProfiles` 会按新快照重建那一行并保持展开，`applyExpansion` 不会对已展开的行调 `restoreEditor`，所以残留的那一格在正常流程里读不到。留着这一行是"暂存不活得比编辑会话更久"的对称性，不是守卫。写在这里是记录"查过、没有读数"，不是待办 |
| 零自动拉取：在 `buildEditor` 里直接发一次拉取消息（模拟"展开就拉"） | 「打开设置页 / 展开档案 / 聚焦输入框都不发请求…」——`sentMessages` 不为空 |
| `handleFetchModels` 的消息体加上 `apiKey: profile.apiKey` | 「打开设置页 / 展开档案 / 聚焦输入框都不发请求…」——`sentMessages` 精确相等当场红。**这一行是验收项 5（"消息体不含 apiKey"）唯一的守卫**：C3 侧那条同类断言已删（它手里的是自己的字面量，恒真） |
| `renderFetchedModels` 里 `checkbox.checked = true` | 「拉取成功：勾选清单默认全不选…」红 |
| `handleMergeModels` 里 `activeModel` 无条件用 `picked[0]` | 「拉取成功…」那半仍绿（清单原本为空）→ **补一条**：清单非空时并入**不许**改当前项（**加进那条用例**：先 `setModel`，再并入 `m-9`，`currentModel` 仍是刚设的那个） |
| `handleTestProfile` 里删掉 `if (problem !== undefined)` 那一支 | 「测试连接：没有当前模型时零请求」——`fetchSpy` 被调用（引擎会抛 AUTH，但请求已经发出去了？**不会**：引擎的空 model 闸在 `fetch` 之前）→ **这条变异的读数是"状态行文案变成引擎那句通用 AUTH"**，不是 fetch 次数。用例里的 `toContain('还没有模型')` 因此是它的杀手 |

- [ ] **Step 9: 提交**

```bash
git add -- tests/options/engine-models.test.ts
git commit -m "feat(options): 档案行与编辑面板改成图二布局（模型目录 + 暂存 + 取消 + 零自动拉取）" -- src/options/sections/engine.ts src/options/options.html src/options/options.css tests/options/harness.ts tests/options/engine-models.test.ts tests/options/options.test.ts tests/options/engine-health.test.ts
```

> 第一行处理**未跟踪的新测试文件**（硬规矩 14）。

## Task C5: 弹窗模型下拉（仅 > 1 项）+ 记住上次用的模型 + 换模型提示

**Files:**
- Modify: `src/popup/popup.html`、`src/popup/popup.css`、`src/popup/popup.ts`
- Modify: `tests/popup/popup.test.ts`

> 三件事合起来就是规格 §7：**档案下拉之后追加模型下拉（仅当该档案的模型数 > 1）**、**切回档案时记住它上次用的模型**、**换完给一句"要重新翻译才生效"**。
>
> 「记住上次用的模型」不需要任何新机制：`activeModel` 本来就持久化在档案里，下拉只是把它读出来——**切档案本身不改任何 `activeModel`**（那是用户的选择，不是切换的副作用），这条要有一条专门的断言。

- [ ] **Step 1: 写失败测试**

**1a. 扩展 `PopupUi` 与 `ui()`**（改动处）：

```ts
// tests/popup/popup.test.ts（片段：PopupUi + ui()）
interface PopupUi {
  toggle: HTMLButtonElement;
  status: HTMLParagraphElement;
  displayMode: HTMLSelectElement;
  hoverToggle: HTMLInputElement;
  selectionToggle: HTMLInputElement;
  targetLang: HTMLSelectElement;
  engine: HTMLSelectElement;
  /** 模型那一整行（`hidden` 是"这个档案只有 ≤ 1 个模型"的读数）；它自己也是判据之一。 */
  modelField: HTMLLabelElement;
  model: HTMLSelectElement;
  hint: HTMLParagraphElement;
  optionsButton: HTMLButtonElement;
}

/** `popup.html` 里的十一个控件；按 id 取，取不到直接失败。 */
function ui(): PopupUi {
  const pick = <T extends HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`popup.html 里没有 #${id}`);
    return found as T;
  };
  return {
    toggle: pick<HTMLButtonElement>('toggle'),
    status: pick<HTMLParagraphElement>('status'),
    displayMode: pick<HTMLSelectElement>('display-mode'),
    hoverToggle: pick<HTMLInputElement>('hover-translate'),
    selectionToggle: pick<HTMLInputElement>('selection-translate'),
    targetLang: pick<HTMLSelectElement>('target-lang'),
    engine: pick<HTMLSelectElement>('engine'),
    modelField: pick<HTMLLabelElement>('model-field'),
    model: pick<HTMLSelectElement>('model'),
    hint: pick<HTMLParagraphElement>('engine-hint'),
    optionsButton: pick<HTMLButtonElement>('open-options'),
  };
}
```

**1b. 追加一个 helper 与五条用例**：

```ts
// tests/popup/popup.test.ts（片段：helper，放在 storedSettings 之后）
/** 某个档案在存储里的 `activeModel`（直读存储：验证"真的落盘了"）。 */
async function storedActiveModel(id: string): Promise<unknown> {
  const profiles = ((await storedSettings()).profiles ?? []) as Array<Record<string, unknown>>;
  return profiles.find((profile) => profile.id === id)?.activeModel;
}
```

```ts
// tests/popup/popup.test.ts（片段：新增一个 describe，放在 describe('语言与引擎选择的持久化') 之后）
describe('模型下拉（规格 §7：只有 > 1 个模型时才出现）', () => {
  /** 一份多模型档案；`models.length` 决定下拉出不出来。 */
  const profile = (models: string[], activeModel: string) => ({
    id: 'p-a',
    label: 'A 家',
    baseUrl: 'https://a.example/v1',
    models,
    activeModel,
    apiKey: 'sk-a',
  });

  it('0 个模型：整行不显示（该说的是"去设置页加模型"，那不是下拉的事）', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profile([], '')] });
    await loadPopup();

    const { modelField, model } = ui();
    expect(modelField.hidden).toBe(true);
    expect(model.options).toHaveLength(0);
  });

  it('1 个模型：也不显示（一个只有一项的下拉是噪声）', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profile(['only'], 'only')] });
    await loadPopup();

    const { modelField, model } = ui();
    expect(modelField.hidden).toBe(true);
    expect(model.options).toHaveLength(0);
  });

  it('2 个模型：下拉出现，选项就是清单、选中 activeModel', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profile(['a1', 'a2'], 'a2')] });
    await loadPopup();

    const { modelField, model } = ui();
    expect(modelField.hidden).toBe(false);
    expect(Array.from(model.options).map((option) => [option.value, option.textContent])).toEqual([
      ['a1', 'a1'],
      ['a2', 'a2'],
    ]);
    expect(model.value).toBe('a2');
  });

  it('切档案：模型下拉换成那个档案的清单与它上次用的模型，**存储里的 activeModel 一个都不动**', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [
        profile(['a1', 'a2'], 'a2'),
        { id: 'p-b', label: 'B 家', baseUrl: 'https://b.example/v1', models: ['b1', 'b2'], activeModel: 'b1', apiKey: 'sk-b' },
      ],
    });
    await loadPopup();
    const { engine, model, modelField } = ui();
    expect(model.value).toBe('a2');

    engine.value = 'p-b';
    engine.dispatchEvent(new Event('change'));
    await waitFor(() => model.value === 'b1');
    expect(modelField.hidden).toBe(false);

    // 切回 A 家：还是它上次用的 a2（"记住上次用的模型"就是 activeModel 本身）。
    engine.value = 'p-a';
    engine.dispatchEvent(new Event('change'));
    await waitFor(() => model.value === 'a2');

    // 切换档案**不是**用户改模型：两个档案的 activeModel 都不该被动过。
    expect(await storedActiveModel('p-a')).toBe('a2');
    expect(await storedActiveModel('p-b')).toBe('b1');
  });

  it('换模型：只写那一个档案的 activeModel，其它档案与字段原样（存储里的 Key 一个都没丢）', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [
        profile(['a1', 'a2'], 'a1'),
        { id: 'p-b', label: 'B 家', baseUrl: 'https://b.example/v1', models: ['b1', 'b2'], activeModel: 'b2', apiKey: 'sk-keep-b' },
      ],
      targetLang: 'ja',
    });
    await loadPopup();

    const { model, status } = ui();
    model.value = 'a2';
    model.dispatchEvent(new Event('change'));
    await waitFor(async () => (await storedActiveModel('p-a')) === 'a2');

    expect(await storedActiveModel('p-b')).toBe('b2');
    expect((await storedSettings()).targetLang).toBe('ja');
    // 整份回写不许把别的档案的 Key 抹成空（弹窗手里拿的是完整设置）。
    const profiles = (await storedSettings()).profiles as Array<Record<string, unknown>>;
    expect(profiles.map((entry) => entry.apiKey)).toEqual(['sk-a', 'sk-keep-b']);
    expect(status.textContent).toContain('重新翻译');
  });

  it('换模型后不自动重翻，并给"要重新翻译才生效"那句提示——页面没翻译时**也给**（§7 明确要求）', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profile(['a1', 'a2'], 'a1')] });
    respondWithState(() => pageState({ translated: false }));
    await loadPopup();

    const { model, status } = ui();
    model.value = 'a2';
    model.dispatchEvent(new Event('change'));

    await waitFor(() => status.textContent.includes('重新翻译'));
    expect(status.textContent).toContain('Alt+T');
    expect(status.textContent).toContain('a2');
    expect(await storedActiveModel('p-a')).toBe('a2');
    // 不自动重翻：一个 TOGGLE_PAGE 都不许发。
    expect(sentTypes()).not.toContain(MSG.TOGGLE_PAGE);
  });

  it('页面已翻译时换模型：同样那句提示（与本文件其它下拉的"不打扰"口径不同，理由见 popup.ts 注释）', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profile(['a1', 'a2'], 'a1')] });
    respondWithState(() => pageState({ translated: true, total: 2, done: 2 }));
    await loadPopup();

    const { model, status } = ui();
    expect(status.textContent).toBe('已翻译 2 / 2 段');

    model.value = 'a2';
    model.dispatchEvent(new Event('change'));

    await waitFor(() => status.textContent.includes('重新翻译'));
    expect(sentTypes()).not.toContain(MSG.TOGGLE_PAGE);
  });

  it('换模型保存被拒：下拉拨回这个档案真正生效的模型，并说明原因', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profile(['a1', 'a2'], 'a1')] });
    await loadPopup();

    const { model, status } = ui();
    // 真实可达：存储里的版本高于本代码时 saveSettings 明确拒绝（用户回退过版本）。
    await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: CURRENT_VERSION + 1 } });

    model.value = 'a2';
    model.dispatchEvent(new Event('change'));

    await waitFor(() => status.textContent.includes('设置未能保存'));
    expect(model.value).toBe('a1');
    expect(status.textContent).toContain('已跳过保存');
  });
});
```

- [ ] **Step 2: 跑到红**

Run: `npx vitest run tests/popup/popup.test.ts`

Expected: `ui()` 直接抛 `popup.html 里没有 #model-field`（八个新用例全红，既有用例也一起红——`ui()` 是所有用例共用的）。这是"控件还没写进 HTML"的正常红。

- [ ] **Step 3: 实现（`src/popup/popup.html`）**

```html
<!-- src/popup/popup.html（片段：在「翻译引擎」那个 .field 之后插入） -->
      <!-- 模型下拉：<strong>只在该档案有 2 个以上模型时</strong>出现（规格 §7）。只有一个模型时不给下拉——
           一个只有一项的下拉是噪声；一个模型都没有时该说的是"去设置页加模型"，走下面的提示区。 -->
      <label class="field" id="model-field" hidden>
        <span>模型</span>
        <select id="model"></select>
      </label>
```

- [ ] **Step 4: 实现（`src/popup/popup.css`）**

```css
/* src/popup/popup.css（片段：紧接 .hint[hidden] 那条规则之后） */
/*
 * 模型那一整行靠 `hidden` 开关，而 `.field` 是 flex 容器——`display: flex` 会盖掉 UA 样式表里的
 * `[hidden] { display: none }`（作者样式永远赢 UA 样式，同特异度下只看源码顺序）。
 * 少了这条，"隐藏"只是属性为真：屏幕上照样占着一行、还挂着一个空下拉的箭头。
 * 与上面 `.hint[hidden]` 是同一条道理、同一个坑。
 */
.field[hidden] {
  display: none;
}
```

- [ ] **Step 5: 实现（`src/popup/popup.ts`）**

**5a. 两个元素引用**（改动处）：

```ts
// src/popup/popup.ts（片段：元素引用）
const engineSelect = document.getElementById('engine') as HTMLSelectElement;
const modelField = document.getElementById('model-field') as HTMLLabelElement;
const modelSelect = document.getElementById('model') as HTMLSelectElement;
```

**5b. `applySettings` 里加一行**（改动处）：

```ts
// src/popup/popup.ts（片段：applySettings 末尾）
  fillSelect(engineSelect, engineOptions(settings), settings.engineId);
  renderModelSelect();
  renderEngineHint();
```

**5c. 三个新函数**（加在 `renderEngineHint` 之前）：

```ts
// src/popup/popup.ts（片段：renderModelSelect / onModelChange）
/**
 * 模型下拉：**只在该档案的模型数 > 1 时渲染**（§7）。
 * 0 项也不显示——那件事该由提示区说（`resolveEngine` 的 `problem`），不是一个空下拉：
 * 一个只有一项的下拉是噪声，一个空的下拉是"点了没得选"的死控件。
 */
function renderModelSelect(): void {
  const profile = settings.profiles.find((item) => item.id === settings.engineId);
  const models = profile?.models ?? [];
  modelField.hidden = models.length <= 1;
  if (modelField.hidden) {
    modelSelect.textContent = '';
    return;
  }
  fillSelect(modelSelect, models.map((name) => ({ value: name, label: name })), profile?.activeModel ?? '');
}

/**
 * 换模型：**只写设置，当场不重翻**（§7）。缓存 key 含 model，所以重翻不会命中旧模型的译文。
 *
 * 不用 `saveSettingsOrReport`：那个辅助的契约是"回滚三个下拉之一"（`field` 只收
 * `targetLang` / `engineId` / `displayMode`），而这里回滚的是**下拉里那一项**（`activeModel`）。
 * 与 `siteRuleUnblock` 当初拒绝硬套那个辅助是同一条理由（见 init 里那段注释）。
 */
function onModelChange(): void {
  const previous = settings;
  const chosen = modelSelect.value;
  const next: Settings = {
    ...settings,
    profiles: settings.profiles.map((profile) =>
      profile.id === previous.engineId ? { ...profile, activeModel: chosen } : profile,
    ),
  };
  void (async () => {
    try {
      await saveSettings(next);
    } catch (raw) {
      // 保存被拒（存储版本高于本代码）：把下拉拨回这个档案**真正生效**的那个模型。
      const active = previous.profiles.find((profile) => profile.id === previous.engineId)?.activeModel ?? '';
      modelSelect.value = active;
      statusText.textContent = errorText('设置未能保存', raw);
      return;
    }
    settings = next;
    renderEngineHint();
    // §7 明确要求换完就给这句话——**不管当前页面翻没翻译**。与目标语言/显示模式那两处的
    // "页面已翻译时才说"不同：那两处改的是已经译好的页面怎么显示（没译文时没什么可说），
    // 这里改的是"下一次请求用哪个模型"，页面没翻译时这句话同样是用户要知道的。
    statusText.textContent = `当前模型已切换为「${chosen}」。换模型后需重新翻译（Alt+T）才会用新模型。`;
  })();
}
```

**5d. `onEngineChange` 里补一句**（改动处）：

```ts
// src/popup/popup.ts（片段：onEngineChange）
function onEngineChange(): void {
  const previous = settings;
  const next: Settings = { ...settings, engineId: engineSelect.value };
  void saveSettingsOrReport(next, previous, engineSelect, 'engineId').then(() => {
    // 存储里没变就说明刚才拒绝过，提示区别再按没生效的引擎重算一遍。
    if (settings !== next) return;
    renderModelSelect();
    renderEngineHint();
  });
}
```

**5e. `init()` 里挂监听器**（改动处；必须与其它监听器一样在第一个 `await` 之前）：

```ts
// src/popup/popup.ts（片段：init 里 engineSelect 之后）
  engineSelect.addEventListener('change', onEngineChange);
  modelSelect.addEventListener('change', onModelChange);
```

- [ ] **Step 6: 跑到绿**

Run: `npx vitest run tests/popup`

Expected: 全绿——八个新用例 + 既有 50 余条一条都不红。特别确认这三条仍在：`引擎提示区` 那一组（`renderEngineHint` 只多了一个分支）、`切换引擎后提示区跟着重算`（`onEngineChange` 里多了一句 `renderModelSelect`，不改文案）、`保存被拒绝时说明原因并回滚下拉`（那个辅助没动）。

- [ ] **Step 7: 变异验证**

| 变异 | 期望红在哪一条 |
| --- | --- |
| `modelField.hidden = models.length <= 1` 改成 `< 1`（1 项也显示） | 「1 个模型：也不显示」红 |
| 改成 `models.length > 0`（0 项也显示） | 「0 个模型：整行不显示」红 |
| 恒 `false`（永远显示） | 前两条都红 |
| `fillSelect(..., profile?.activeModel ?? '')` 改成 `models[0]` | 「2 个模型：…选中 activeModel」——读到 `a1` |
| `onEngineChange` 里删掉 `renderModelSelect()` | 「切档案：模型下拉换成那个档案的清单…」红（切到 p-b 后下拉还是 a1/a2） |
| `onModelChange` 里 `profile.id === previous.engineId ? … : profile` 的条件删掉（改所有档案） | 「换模型：只写那一个档案的 activeModel…」——`storedActiveModel('p-b')` 变成 `a2` |
| 回滚那句 `modelSelect.value = active` 删掉 | 「换模型保存被拒…」——`model.value` 停在 `a2` |
| 状态行那句删掉 | 「换模型后不自动重翻…」与「页面已翻译时换模型…」两条都红 |
| 顺手在成功路径里发一次 `TOGGLE_PAGE` | 两条都红（`sentTypes()` 含 TOGGLE_PAGE） |
| `.field[hidden]` 那条 CSS 删掉 | **jsdom 里看不出来**（没有布局）→ 这条**不设变异**：它由 `options-css.test.ts` 的同款先例（`.hint[hidden]`）与本条注释守着，真机靠肉眼验收（规格 §10）。写在这里是为了让后来者知道"查过、且它测不了" |

- [ ] **Step 8: 提交**

```bash
git commit -m "feat(popup): 档案有多个模型时多一个模型下拉，换模型后提示要重新翻译（§7）" -- src/popup/popup.html src/popup/popup.css src/popup/popup.ts tests/popup/popup.test.ts
```

---

## Task C6: README 已知限制与收口

**Files:**
- Modify: `README.md`
- 无代码改动

- [ ] **Step 1: README「翻译引擎」一节（改动处：`一个档案 = …` 那一段）**

```markdown
<!-- README.md（片段：替换「设置页可以配多个服务商档案」那一段） -->
设置页可以配**多个服务商档案**：一个档案 = 名字 + 接口地址 + **模型清单** + API Key（`id` 稳定唯一，
名字随便改不会弄丢引用）。每个档案可以装**多个模型**，其中一个是「当前」——同一家接口的两个模型
不必再复制成两份档案。清单两种加法：点「+ 添加模型」**手填**（空值与重复值不写入），或点
「⟳ 获取可用模型」从 `{接口地址}/models` **拉一份回来勾选**（默认全不选；只有你点那一下才会发请求）。
配好几个档案之后，在**弹窗**的「翻译引擎」下拉里**按名字直接切换**——下拉列出的就是
「Google 免费接口 + 每个档案的名字」，选中即写入本机存储、立即生效。某个档案有 2 个以上模型时，
弹窗里会**多出一个模型下拉**（只有一个模型时不显示：一个只有一项的下拉是噪声）；切回某个档案时
它会记住那个档案上次用的模型。
```

- [ ] **Step 2: README「当前版本的真实限制」里那条档案说明（改动处）**

```markdown
<!-- README.md（片段：替换「档案的接口地址、API Key、模型名在设置页里管理…」那一条） -->
- 档案的接口地址、API Key、**模型清单**在**设置页**里管理（弹窗右上角的齿轮按钮）。点某一行右侧的
  「编辑」展开面板：那里可以改名字与 Key、改接口地址、加删模型并把其中一个设为「当前」，底部是
  「测试连接 / 取消 / 保存」。**「取消」丢弃这次编辑，存储一个字节都不动**。「测试连接」会用该档案
  当前编辑的内容真的翻一次 `hello`（测的就是正在编辑的那一个，不是全局），成功显示译文、失败显示
  错误码。**没有「当前」模型时点「测试连接」或去翻译，都只会得到一句可读的错误，一个请求都不发**。
  老数据（v2 的单份配置）升级后自动折成一个档案、它的单个模型名抬起成"清单里只有这一项"：当时在用
  自定义接口的，名字取自当时选过的服务商；用免费接口的不会凭空长出档案。设置版本升到 v4。
- **拉取模型清单读的是存储里那份档案**：面板里改了地址或 Key 但**没点保存**就点「获取可用模型」，
  拉的还是存储里那份（后台按档案 id 自己读，设置页从不把 Key 送进消息）。拉取失败按原因分别说明
  （连不上 / 401 / 404 / 不是 JSON / 10 秒超时），**手填这条路永远在**。
```

- [ ] **Step 3: README「已知限制 › 设置页」补五条（追加在那一段末尾）**

```markdown
<!-- README.md（片段：追加进「### 设置页」那个列表的末尾） -->
- **面板里没保存的改动会被记住**（只要你还在这张设置页上）：点另一个档案的「编辑」看一眼再点回来、
  或把本行收起再展开，名字 / 接口地址 / Key / 模型清单都还是你刚填的样子——每个档案在内存里各留一格
  暂存。**「取消」才是丢弃**（它会把那格一起清掉）。这不是自动保存：**关掉设置页暂存就没了**，
  也永远不会把半填的档案悄悄写进存储——要落盘只能点「保存」。
- **展开档案行变快，只有 jsdom 这一层的读数**：改前每点一次展开都会把整张档案列表推倒重建
  （代价随档案数线性增长），改后只动受影响的那一两行——测试钉住的是"单次展开对 DOM 的改动量与
  档案数无关"（N=5/20/50 同值），**不是真机耗时**（本机没有浏览器，绝对耗时测不了）。若你复测仍慢，
  下一步是加一个临时的 `console` 计时探针定位到底是哪一段慢。
- **模型清单没有条数上限，也没有搜索框**：有些网关的 `/models` 列几百个，勾选清单只做"可滚动 +
  勾选"；手填只校验"非空 + 不重复"，**不校验服务商认不认识这个名字**——填错会在翻译时拿到服务商
  自己的 400（错误码 `BAD_REQUEST`，正文原因会展开显示）。
- **「自定义」徽章的判据是"接口地址与某个内置模板逐字相同"**：地址是自己搭的代理、或者多打了一个
  斜杠，徽章就会出现（这是有意的：判据越"聪明"，你越难预测它什么时候亮）。
- **折叠行比参考图多一行小字**（`接口地址 · 当前模型`）：这是有意的——5 个档案时"哪个档案打哪个
  地址、用哪个模型"是一眼就该看见的信息。窄窗口下这一行可能被挤窄，**未经真机渲染验证**。
```

- [ ] **Step 4: README「已知限制 › 功能范围」里那条档案保存（改动处）**

```markdown
<!-- README.md（片段：替换「**档案仍用「保存档案」按钮**…」那半句） -->
- **设置改动即时保存**：选择类与开关类 `change` 即存，文本类（术语、规则域名、提示词）失焦才存，
  数字类在提交时存。**档案仍用面板底部的「保存」按钮**——保存档案要在用户手势里申请该地址的宿主权限
  （Chrome 要求手势），而且填了一半的档案不该被静默写进存储。同一个面板上的「取消」丢弃这次编辑、
  不动存储（收起 / 切走**不会**丢弃——见上面「面板里没保存的改动会被记住」那条）。
```

- [ ] **Step 5: 全量命令（收口）**

按顺序跑，把每一步的**实际输出**抄进交付说明：

```bash
npm test
npm run typecheck
npm run build
npm run zip
node scripts/sync-plan-code.mjs docs/superpowers/plans/2026-09-20-multi-model-profiles.md
```

Expected（**投影 vs 实测并列**，交付时必须两列都在）：

| 命令 | 投影 | 实测 |
| --- | --- | --- |
| `npm test` | 比开工基线多出 C0/C3/C4/C5 的新文件与新用例；**以命令输出为准** | 待填 |
| `npm run typecheck` | exit 0（`EngineProfile` 改名后任何漏改的**带类型**位置都会在这里炸） | 待填 |
| `npm run build` | exit 0，且 `verify:dist` 14 项全过（没有新增资源、没有动 manifest） | 待填 |
| `npm run zip` | exit 0，产物文件数与字节数**与上一次收口一致**（本单元没有新增打包文件） | 待填 |
| `node scripts/sync-plan-code.mjs …` | `已同步 0 个代码块` | 待填 |

> `sync-plan-code` 那条的读法：本计划的**整文件**块（`src/background/models.ts`、`src/background/models.test.ts`、`src/options/engine-expansion.test.ts`、`src/options/engine-models.test.ts`）首行是 `// <路径>`，会被对齐；**片段**块的首行带后缀，脚本不认。所以 `已同步 0 个代码块` = 已实现的那几个整文件块与仓库逐字一致。**若报出同步了某个文件**，那就说明实现阶段有意改过它——去读那次改动的提交信息，把"计划与实现哪里不同、为什么"写进交付说明（这是**允许**的，不许做的是"不同却不说"）。

- [ ] **Step 6: 交付说明里必须写明的三件事（本机测不了的东西）**

1. **真机渲染未验证**：折叠行的窄窗口挤压、`自定义设置` 的折叠观感、模型目录按钮排布、弹窗新增一行下拉的排版——本机没有浏览器，全部依赖用户肉眼验收（规格 §10.1 第 5 条）。
2. **真机耗时未测**：C0 的读数是 jsdom 的 DOM 变更计数，不是耗时（规格 §10.1 第 6 条）。用户复测若仍慢 → 临时 `console` 计时探针。
3. **`/models` 的真实返回形状只按规格的三种实现**：其它形状（例如 `{result: [...]}`）会走"没有给出可用的模型清单 → 引导手填"那条路（规格 §5.2 / §10 第 2–3 条）。

- [ ] **Step 7: 提交**

```bash
git commit -m "docs(readme): 多模型档案、拉取模型清单与四条已知限制" -- README.md
```

---

## 验收对照表（规格 §9 十八条 → Task/Step）

| # | 验收项 | 在哪落地 |
| --- | --- | --- |
| 1 | v3 单 `model` → `models:[model]` + `activeModel:model`，Key/地址不丢 | C1 Step 1/3 |
| 2 | 删当前模型自愈且不变量成立；清空列表为 `''` | C1（读取边界，Step 1/3）+ C4（UI 自愈，Step 1/8） |
| 3 | `activeModel === ''` → 可读错误 + **零网络请求** | C2 Step 1/3（成对用例） |
| 4 | 三种响应形状各解析正确；解析不出时文案指向手填 | C3 Step 1/3 |
| 5 | 拉取消息体**不含 `apiKey`**（成对：后台确实拿到了 Key） | **两半分别在两处**：「消息里真的没有 Key」= **C4 Step 1 的零自动拉取用例**（`chromeStub.runtime.sentMessages` 对**设置页真的发出去的那条消息**做精确相等断言；payload 多一个字段就红）；「后台确实拿到了 Key」= C3 Step 1c 的 `Bearer sk-secret` 断言。⚠ **C3 侧不再放"消息里没有 Key"的断言**——那里手里的 `message` 是它自己造的字面量，那种断言是恒真式（测的是用例自己），不是守卫 |
| 6 | 打开设置页 / 切换档案 / 聚焦输入框都不触发拉取 | C4 Step 1（零自动拉取用例，正负两半同条） |
| 7 | 弹窗下拉 1 项无、2 项有；切回档案记住上次用的模型 | C5 Step 1/5（三态 + 往返用例） |
| 8 | 换模型后 `configHash` 变化 | C2 Step 1b（端到端）+ `tests/background/scheduler.test.ts:290` 既有单元网 |
| 9 | 全量 `npm test` / `typecheck` / `build` / `zip` 全绿 | C6 Step 5 |
| 10 | 折叠行：名字 + `自定义`徽章（仅非预设）+ 三态点 + 编辑/删除 + 「使用中」 | C4 Step 1/3f |
| 11 | 折叠行次级 meta（`接口地址 · 当前模型`，未填写占位） | C4 Step 1/3b（**偏离一**） |
| 12 | 面板：名字 / Key（显示切换 + 两种占位）/ `自定义设置` 默认折叠规则 / 模型目录 / `⟳` / `添加模型` / 测试连接·取消·保存 | C4 Step 1/3d |
| 13 | 「取消」丢弃编辑、存储不动；再展开看到存储里的值 | C4 Step 1/3i |
| 14 | 展开只动一两行（N=5/20/50 同值）；展开 B 时 A 的编辑器不在 DOM、`aria-expanded` 回 false | C0 Step 1/3/5 |
| 15 | 清单 0/1 项不渲染弹窗下拉，2 项及以上才渲染并选中 `activeModel` | C5 Step 1/5 |
| 16 | 手填空值与重复值不写入；添加即当前；拉取并入只在原本为空时设当前 | C4 Step 1/3i/3j |
| 17 | 没有当前模型时点「测试连接」→ 那句话 + 零请求 | C4 Step 1/3l |
| 18 | `activeModel` 认不出来 → 置 `''`，不替用户挑 | C1 Step 1/3c |
| **19** | **隐式收起保留未保存的输入**（每行内存暂存），而 `保存` / `取消` / 行被删除各自清掉它 | **C4**：裁决块（Task C4 开头）+ Step 1 的三条用例（草稿往返 / 真档案行四字段与 Key 边界 / 草稿保存后暂存清空）+ 既有那条 `取消` 用例（改写成"取消清暂存"的见证）+ Step 3g/3p 的实现 + Step 8 的六行变异 |

## 覆盖对照表（规格其余条目）

| 规格条目 | 在哪落地 |
| --- | --- |
| §1 一个服务商多个模型（不再复制档案） | C1（数据模型）+ C4（清单 UI）+ C5（切换入口） |
| §2 手填 + 一键拉取（必须有手填兜底） | C4（`+ 添加模型`）+ C3（拉取）；失败文案每一句都留着手填 |
| §2 弹窗「仅 > 1 时显示、记住上次」 | C5 |
| §3 类型定义（`models` / `activeModel`） | C1 Step 3a |
| §3.1 不变量 + 删除自愈 | C1（读取边界）+ C4（`handleRemoveModel`） |
| §3.2 迁移 v1/v2/v3 → v4 收敛 | C1 Step 3d（`liftProfileModels` 在折叠之后跑，三条路径同一形状） |
| §3.3 没有模型时报错、不发请求 | C2（`problem` + 后台前置闸 + 弹窗提示） |
| §4 缓存正确性（`configHash` 已含 model） | 不改 `scheduler.ts`；C2 补端到端前提用例 |
| §5.1 后台发、设置页只传 `profileId` | C3 Step 3/4/5（消息 + 处理器 + 路由） |
| §5.2 三种形状的宽容解析 | C3 Step 4（`parseModelsPayload`）+ Step 1 的表格用例 |
| §5.3 失败分类 + 10 秒独立超时 + 复用 `extractErrorDetail` | C3 Step 4（`describeModelsStatus` / `MODELS_TIMEOUT_MS` / `readDetail`） |
| §5.4 零自动拉取 | C4 Step 1（负向 + 正向同条） |
| §5.5 权限（不需要新权限；失败指向重新保存授权） | C3 Step 4（`hasHostPermission` 闸 + 那句提示）；C6 说明不需要新权限 |
| §6.1/§6.2/§6.3 版式与字符图标 | C4（`⟳` 只用字符；无图标字体/emoji 依赖） |
| §7 弹窗 UI | C5 |
| §8 非目标 | 见下「刻意不做的」——没有为任何一条新增代码 |
| §10 已知限制（四条） | ① 未真机验证 → C6 README 第 1 条；② `/models` 可能极长只做可滚动 → C4 的 `.models-list { max-height; overflow-y }` + C6 README 第 2 条；③ 有些服务商返回全部模型、勾选清单必须允许手填修正 → C4 的手填路径（`+ 添加模型`，与拉取并存）；④ "迁移只向前、旧版本读 v4 会显示成没有模型" → **本单元不实现**（那是旧版代码读新数据的表现，我们不改旧版本）；C1 的 `pickProfile` 保证的是**本版本**读任意脏形状都不崩 |
| §11 交付顺序（排在 B 之后） | 本计划全部 Task 都在单元 B 的产物上做（`sections/engine.ts` 已存在） |

## 刻意不做的（非目标，来自规格 §8）

- 每个模型单独的 temperature / max tokens：只有 `model` 这一个维度可变。
- 模型能力探测（上下文长度、函数调用支持）：不做任何探测请求。
- 自动翻译与站点规则：属另两个单元，本单元一行都不碰。
- 档案内多 Key：一个档案仍然只有一把 Key。
- `/models` 结果的搜索框：清单只做可滚动 + 勾选（规格 §10 第 2 条：若实测难用再加，不预先造）。
- 参考图的「适配器默认模型」：**不引入**默认模型表（实质冲突 1，以我们的规格为准）。
- 「目录外 ID 仍可直接发送」：**不放松**不变量（实质冲突 2）。
- `Esc` 撤销、两个设置页并排打开的互相覆盖：单元 B 已如实写进 README 的已知代价，本单元不碰。

## 自审记录（写计划时逐条做过的检查）

**1. 规格逐节对照（§1~§11 每一条都能指到某个任务）**：见上面两张对照表。**写第一版时发现的两个缺口**：
- **§5.5 的权限路径原本没有落点**——第一版把"拉取失败"整块交给网络那类文案，用户拿到的会是"检查地址与网络"，而 §5.5 要求指向「重新保存该档案以授权」。**已补**：`fetchModels` 在请求前查 `hasHostPermission`，未授权时**不发请求**并给出那句指路（C3 Step 4 + 变异表）。
- **§9 第 6 条（零自动请求）原本挂在 C3**——而 C3 阶段还没有任何调用方，负向断言会因为"分支根本没执行"而永远绿（成因②）。**已挪到 C4**，并要求正负两半写在同一条用例里。
- 另有一处**有意的措辞差异**（不是缺口）：规格 §3.3 那句在规格里写成「…点『添加模型』或『拉取可用模型』」（外层引号属于规格排版），代码里内层标签统一用本仓的「」（`NO_MODEL_PROBLEM`），并有注释说明。

**2. 占位符扫描**：全文没有 `TBD` / `TODO` / "类似 Task N" / "加适当的错误处理" 这类空话。每个改动都给了**能唯一定位的改动前文本**或完整函数；每步都有命令与期望输出形态；三处"决策点"都已定下来（`自定义`徽章判据、`自定义设置` 默认展开规则、添加/拉取谁设为当前），文档里没有"你选一个"的句子。唯一留给执行者填的是**实测读数表**（C0 Step 5 与 C6 Step 5），那是读数、不是决策。

**3. 类型一致性**：后面 Task 用到的每个字段名/函数名/消息名都与前面定义的一致——
`models` / `activeModel`（C1 定义；C3/C4/C5 使用）、`modelsFromSingleInput`（C1 定义、C4 删除）、`NO_MODEL_PROBLEM` / `problem`（C2 定义；C4 的 `handleTestProfile`、C5 的提示区使用）、`ResolvedEngine`（C2）、`MSG.FETCH_MODELS` / `FetchModelsMessage` / `FetchModelsResponse` / `isFetchModelsMessage`（C3 定义；C4 的用例按这几个名字用）、`MODELS_TIMEOUT_MS` / `ModelsFetchResult` / `parseModelsPayload` / `describeModelsStatus` / `fetchModels`（C3）、`applyExpansion` / `insertDraftRow` / `applyTriggerState` / `readModels` / `renderModels` / `modelsFieldOf` / `markCustomTemplate` / `openModelInput` / `isPresetProfile` / `metaTextOf` / `renderFetchedModels` / `handleAddModel` / `handleUseModel` / `handleRemoveModel` / `handleCancelProfile` / `handleFetchModels` / `handleMergeModels` / `handleCancelFetched`（C0/C4）、`setModel` / `currentModel` / `rowButton` / `profileSeed` / `profileWithModel`（C1/C4 的夹具，被 C0/C4 的用例使用）、`#model-field` / `#model` / `renderModelSelect` / `onModelChange`（C5）。
**核对方式**：把上面这张名单与每个 Task 的代码块逐个对照过一遍；`handleFetchModels` 这个名字在 **C3（后台）与 C4（设置页）各有一个**——它们**故意同名**（一个是 `src/background/service-worker.ts` 里的处理器、一个是 `src/options/sections/engine.ts` 里的处理器），互不引用、各自私有，不导出。若担心混淆，读的时候先看文件路径。

## 复盘记录（计划说错的读数、恒真断言、有行为无读数——逐条记账）

> 这一节记的都是"**计划写下了读数、落地把读数推翻**"这一类。它比"代码写错"更值得留档：代码错会红，读数错会让人**白跑一遍**、甚至把修好的东西当成没修。
> 落地提交：C0 = `35488b2`；C0 的真机委托修复 + C1 = `7991539`（两件事同一批，无法拆成两个都绿的提交——`EngineProfile` 改名让中间态全仓编不过）。

### 1. 计划说错 / 说不全的变异读数

| 变异 | 计划原本怎么说 | 实测与机理（**以实测为准**） |
| --- | --- | --- |
| M3：`liftProfileModels` 里不写 `delete lifted.model` | 「幂等：…`Object.keys` 精确相等」那条红（多一个 `model` 键） | **全绿（`63 passed`）——经公共边界不可观测（防御性）**。`pickProfile` 逐字段重建档案、`mergeSettings` 过滤未知键，旧键漏不到公共边界；而计划点名的那条用例种的是 `version: CURRENT_VERSION`，`migrate` 在版本闸门直接短路、`liftProfileModels` 根本不跑。**它的价值**是"防止 `pickProfile` 将来改成透传/浅拷贝时旧键漏出去"——**杀它要改 `pickProfile`，不是改迁移**（实现者读数：让 `pickProfile` 的返回值带上旧 `model` 键 → 「幂等」那条按 `Object.keys` 当场红，证明断言本身不是死的） |
| M7：`if (storedVersion < 4)` 写成 `< 3` | 「v3 → v4 两条红；同时 `foldLegacyEngineConfig` 的 v2 用例也红」 | **红 3 条**：① 「model 有值 → …」② 「model 首尾空白被 trim 掉再进清单」③ F1 那条 v3 字面量的「幂等…不再迁移」（F1 修好之后它才成为第三个杀手）。**v2 折叠用例不红**（`2 < 3` 照样抬 v2 数据）、**v1 三步那条也不红**（`1 < 3`）——计划那句"v2 也会红"是错的。**「model 是空串或整个缺失」也不红**，这条最值得记：空/缺失时"抬起"与"不抬起"的结果**恰好一样**（都是 `[]` / `''`），所以那条判据在空值上**本来就不可观测**——它守的是夹具形状，不是版本闸门 |

### 2. 恒真断言清单（本单元第四例在 C1）

判据一句话：**夹具与被测逻辑同源时，断言会退化成恒真式**——两边读的是同一个表达式，改坏了也看不出来。加强的办法是让夹具里出现"两种口径读起来不一样"的数据。

| # | 出处 | 恒真的原因 | 加强办法 |
| --- | --- | --- | --- |
| ① | 单元 B Task 8 的 `'abc'` 净化用例 | 断言只查了"被过滤掉的那一侧" | 补另一侧（该保留的要保留） |
| ② | 单元 B Task 9 的 `.lab` 遮蔽 | 索引边界用例被别名循环**遮蔽**（撞别名时先红在别处） | 用一个**不是任何别名**的词，并断言"隐私里确实有那些词"防空转 |
| ③ | 本单元 C3 的 `expect(JSON.stringify(message)).not.toContain('sk-secret')` | 断言的是**用例自己两行前造的字面量**（永远不可能含 Key） | 改断言**真的发出去的那条消息**（C4 的 `runtime.sentMessages` 精确相等）；C3 侧删掉（已改） |
| ④ | 本单元 C1 的「展开已存在的档案不重放服务商模板」 | 夹具是"单模型对齐"的，`buildEditor` 的 `profile?.activeModel ?? ''` **恒等于夹具值**——"读 `activeModel`"与"读 `models[0]`"读数完全一样 | 夹具改成**清单两项、当前项不是第一项**。读数：对齐夹具下把回填换成 `models[0]` → **31 条全绿**（看不见）；改后 → **恰好那一条红**（`expected 'deepseek-chat' to be 'deepseek-chat-selfhost'`） |

### 3. 测量侧的三个缺陷型（"怎么取读数"）

1. **夹具默认参数吞掉 `undefined`**：计划写的 `loadV3(model: unknown = 'deepseek-chat')` 会把 `loadV3(undefined)` 悄悄换回 `'deepseek-chat'`——于是"**整个键缺失**"那一半**永远种不进去**，测的还是"有 model"。修法：去掉默认参数、`model !== undefined` 才写键、调用方显式传值（用例体 `['', undefined]` 一字不动）。
2. **一条用例里前面的失败会遮住后面的读数**：同一条用例的 `['', undefined]` 两轮，第一轮（`''`）先红，Step 2 只看到 `expected [ Array(3) ] to deeply equal [ '', [], '' ]`，第二轮的真实读数（`expected [ Array(3) ] to deeply equal [ undefined, [], '' ]`）**根本看不见**——上面那个默认参数缺陷就是这么藏了一整轮。**规则：取读数要一轮一条**，红了先只让这一轮绿、再看下一轮；不许因为"这条已经红了"就跳过剩下几轮。
3. **探针复制了被测对象的错误口径**（见硬规矩 2 的 ⑦）：`perf-probe.ts` 里 `action: target.dataset.action ?? '(none)'` 与被查的委托 bug 同源 ⇒ 修复落地后真机上仍打印 `action="(none)"`，**把"修好了"测成"没好"**。教训：**探针要独立于被测逻辑的假设，否则比没有探针更坏**。

### 4. 有行为、无读数（**不许**为它们编一条恒真用例）

本仓口径：这类代码如实记账、**保留**（它们有防御价值或对称性价值），但**不许**为了让变异表好看而给它编一条同源的恒真用例。今天这三处都没有任何用例杀得死：

| 代码 | 为什么今天杀不死 | 谁能杀它 / 留着它的理由 |
| --- | --- | --- |
| `if (actionEl === null || !row.contains(actionEl)) return;`（C4 Step 3m，`7991539` 引入） | `[data-action]` 今天只出现在行内，构造不出"动作元素在别的行里"的 DOM | 只有"把 `[data-action]` 挪进行内的嵌套结构、或让两行互相包含"的形状才杀得死——那种形状在真机上不存在。留着是**防御**（嵌套/无关元素串行） |
| `editorDrafts.delete(savedId)`（C4 Step 3p） | 保存成功后 `renderProfiles` 按新快照重建那一行并保持展开，`applyExpansion` 不会对已展开的行调 `restoreEditor` | 草稿那一格（`NEW_DRAFT_ID`）**有**读数（「草稿保存成功后清掉草稿暂存」那条）；这一格留着是**对称性**（"暂存不活得比编辑会话更久"） |
| `liftProfileModels` 里的 `delete lifted.model` | 见上表 M3：`pickProfile` 重建 + 版本闸门短路 | 改 `pickProfile`（让它透传旧键）才杀得死。留着是**防御**（防止将来 `pickProfile` 不再重建时旧键漏进存储） |

### 5. 契约迁移里落地偏离计划的三处（正文已改，此处只索引）

| 偏离 | 计划原来 | 落地改成 | 正文位置 |
| --- | --- | --- | --- |
| F1 | 用升级后的 v4 夹具去种 `version: 3` 的数据（伪造了"v3 里不可能存在"的形状） | 用 **v3 字面量**种数据，期望仍用 v4 夹具 | C1 Step 5b 的 `:399-413` 行 |
| D | `loadV3` 带默认参数 | 去掉默认参数 + `!== undefined` 才写键 | C1 Step 1 的夹具 + Step 2 的盲区提示 |
| C | 模板用例用"单模型对齐"夹具（恒真） | 清单两项、当前项不是第一项 | C1 Step 5b 的 `:143` 行 |

## 落地读数表（执行者填，交付时与投影并列）

| 读数 | 投影 | 实测 |
| --- | --- | --- |
| 开工基线 `npm test` | 单元 B 收口时 52 files / 983 passed（**以命令输出为准**） | |
| C0 单次展开的 DOM 变更量（N=5/20/50） | `{1,0}` / `{1,0}` / `{1,0}`；旧实现 `{6,6}` / `{21,21}` / `{51,51}` | |
| C0 A→B 切换的变更量 | `{1,1}`（任意 N） | |
| **C0 落地时的"未保存输入"探针**（`zz-draft-value-probe.test.ts`，跑完已删） | —— | **已取到**：新实现 真档案行收起再展开 → 回落到存储值；草稿被切走 → `ids=["p-a","__new__"]`、`draftRowExists=true`、切回四字段**全空**；草稿点自己收起 → 四字段全空。旧实现：草稿被切走 → `ids=["p-a"]`、`draftRowExists=false`；点自己收起 → 整行消失 |
| **C4 落地后的同一条探针**（预期改变） | 切回草稿行 → `label="临时档案"`（暂存生效）；`取消` 后 → 空 | |
| **C1 变异 M3**（`liftProfileModels` 不写 `delete lifted.model`） | 计划原测："幂等"那条红 | **实测全绿（`63 passed`）**——经公共边界不可观测，已改标"防御性"（见「复盘记录 › 1」） |
| **C1 变异 M7**（`if (storedVersion < 4)` → `< 3`） | 计划原测：v3→v4 两条 + v2 折叠用例 | **实测红 3 条**（`有值` / `trim` / F1 那条）；**v2 与 v1 用例不红**，`空串或缺失` 那条也不红（空值上判据不可观测） |
| **C1 模板用例的夹具加强**（第 4 例恒真断言） | —— | **已取到**：对齐夹具下把回填换成 `models[0]` → **31 条全绿**（看不见）；夹具改成"清单两项、当前项在后" → **恰好那一条红** |
| 收口 `npm test` | 以命令输出为准 | |
| 收口 `npm run typecheck` / `build` / `zip` | exit 0 / exit 0 + `verify:dist` 14 项 / exit 0 | |
| `sync-plan-code.mjs` | `已同步 0 个代码块` | |


