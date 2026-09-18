# 设置页改版实现计划（单元 B）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把设置页从「4 个区块、3 个可改设置项」改成规格 §3 的 8 组信息架构 + 即时保存 + 轻量搜索 + 三态状态点，并把 `options.ts` 拆成 `store.ts` + `sections/<name>.ts` + 只做装配的入口。

**Architecture:** 入口文件名不变（`src/options/options.html` / `options.ts`），拆分只发生在内部模块：`store.ts` 持有唯一一份内存快照与一条**串行的写队列**（每次写回前重读存储 → 只改一个字段 → 整份写回）；`section.ts` 定义区块契约（`bind` / `mount` 两段，监听器一律在第一个 `await` 之前挂好）；每个区块一个 `sections/<name>.ts`，自己解析自己的 DOM、自己写自己的状态行；`options.ts` 只做装配、全局错误兜底与搜索接线。区块的静态骨架（区块、字段、标签、按钮）住在 `options.html` 里——**测试用的就是这份真实 HTML**，搜索也从它里面读字段标签。

**Tech Stack:** TypeScript + Vitest（jsdom）+ Vite（MV3）；测试命令 `npx vitest run <文件>`，收口 `npm test` / `npm run typecheck` / `npm run build`（含 `verify:dist` 14 项）/ `npm run zip`。

**规格：** `docs/superpowers/specs/2026-09-18-options-page-redesign-design.md`（§3 信息架构、§4 交互契约、§5 站点规则范围、§6 文案修正、§7 工程约束、§10 验收标准、§11 已知限制）
**视觉原型：** `docs/mockups/options-ia-v2.html`
**格式范本：** `docs/superpowers/plans/2026-09-18-site-rules-never-translate.md`（单元 A）

---

## 已核实的前提（不要重新发明）

0. **执行前提：实现者从「仓库 + 本 Task 的小节」出发工作，不必重读整个计划。** 计划里的代码块已经落在磁盘上的（例如 Task 3 写完的 `src/options/sections/engine.ts`）应当**直接读文件**；只有**本 Task 要新建/新建后修改**的文件才需要照本 Task 的代码块写。Task 10 是唯一跨 Task 改文件的地方（`sections/engine.ts` 在 Task 3 就已存在），它给出的每一处改动都**引足了上下文**（能唯一定位到那几行），不靠"把某一段改掉"这种指代。
1. **基线：867 个测试 / 40 files 全绿**（`npm test` 实测，2026-09-18，分支 `feat/core-translation`，工作树干净）。单元 A 已落地：`src/core/site-rules.ts` 的 `matchSiteRule` / `isNeverTranslate`、内容脚本拦截、弹窗状态与一键解除，全都有测试。
2. **测试契约是契约属性名，不是查询细节**（逐条 grep 过 `tests/options/options.test.ts`，见下表）。`#save` 随即时保存移除，依赖它的 4 条用例改写（Task 3 Step 13）。
3. **`options.html` 是测试的真实输入**：`options.test.ts` 用 `DOMParser` 加载它，然后把 `parsed.body.innerHTML` 塞进 `document.body`。所以页面骨架必须留在 HTML 里，JS 只填内容与挂行为。
4. **被测模块在 import 时就跑 `init()`**：模块顶层按 id 取元素（DOM 必须先就位），`init()` 同步挂监听器，然后才 `await loadSettings()`。测试的顺序固定为「装替身 → 写存储 → 装 DOM → `await import(...)` → `settle()`」，且 `vi.resetModules()` 每个用例重置一次。
5. **`siteRules` 的消费侧已经在单元 A 落地**，本单元只做**写入侧**（增删规则）。核心匹配语义（精确、`*.` 前缀通配、自上而下首条命中）**已经有用例**（`tests/core/site-rules.test.ts`），本单元不重复实现、不重复测。
6. **`autoTranslateDelay` 零消费者**：不做 UI（规格 §1 / §8），只在 README 保留既有说明。
7. **本机没有浏览器 / Playwright**：任何"看起来对不对"的断言都只能是 CSS 文本断言（`tests/helpers/css.ts`）与 DOM 属性断言；布局挤压、窄窗口降级、暗色对比度**一律依赖用户肉眼验收**，计划里如实标注。
8. **pwsh 5.1 的 `Set-Content` / `Get-Content` 会破坏 UTF-8**：本计划里所有文件读写都用编辑/写入工具，命令只用来跑 `npx vitest run` / `git`。

### 契约属性清单（grep 出来的现状，逐条都要保住）

| 契约 | 现在在哪用 | 本单元怎么处理 |
| --- | --- | --- |
| `getElementById('profiles')` | `profileRows()`（`options.test.ts:52`） | 保留，仍是档案行的容器 |
| `getElementById('engine-status')` | `engineStatus()`（`:135`），多条用例的状态同步点 | 保留，仍是引擎区块的状态行 |
| `getElementById('target-lang')` | `:284` `:706` `:726` `:743` | 保留，改成 `change` 即存 |
| `getElementById('display-mode')` | `:285` `:707` | 保留，同上 |
| `getElementById('target-hint')` | `:295`（§6 那句错文案的断言） | 保留，文案改对 + 断言改强（Task 2） |
| `getElementById('add-profile')` | `:315` `:329` `:361` `:452` `:484` `:553` | 保留，区块头的小按钮 |
| `getElementById('clear-cache')` | `:775` `:797` `:808` | 保留 |
| `getElementById('cache-status')` | `:776` `:778` `:780` `:798` `:800` `:809` `:811` | 保留（文案一字不改：`已清除 N 条翻译缓存` / `缓存本来就是空的`） |
| `.profile-row[data-profile-id]` | `profileRows()`（`:52`）、`rowOf()`（`:56`）、`:606` | 保留 |
| `[data-action]` | `:74` `actionButton()`、`:84` `[data-action="toggle"]` | 保留（`toggle` / `save-profile` / `test-profile` / `delete-profile` 四个值一字不改） |
| `.profile-editor` | `editorOf()`（`:62`）、`expand()`（`:82`） | 保留（**行内按钮必须仍在编辑器里**：`actionButton(editor, …)` 是在编辑器内部查的） |
| `.profile-provider` | `:256` `:363` | 保留（服务商模板下拉） |
| `.profile-label` `.profile-base-url` `.profile-model-name` `.profile-api-key` `.profile-toggle-key` | `fieldOf()`（`:68`）、`:221` | 保留 |
| `#save` | `:318` `:708` `:727` `:744` | **移除**；4 条用例改成"改下拉 → 等存储写入完成"（Task 3 Step 13） |

**新增区块一律用新的契约属性**（规格 §7）：`data-section` / `data-nav` / `data-nav-group` / `data-glossary-row` / `data-rule-row` / `data-rule-action` / `data-state`，不复用旧名。

---

## 需要评审先点头的 9 个决定（规格没说清或与现状冲突的地方）

> 这几条都不改规格的**意图**，但必须由你确认口径。每条都给了"为什么不能照字面做"。

1. **§4.1 说"每次写回都基于当前内存快照"，但现有用例要求"写回前重读存储"。**
   `options.test.ts:570` 与 `:736`（「期间弹窗改过的其它字段不会被旧快照抹掉」）把 `concurrency: 3 → 7` 写进存储后，再让本页保存别的字段，断言 `concurrency` 仍是 `7`。只用内存快照整份回写会让这两条变红。
   → 计划落成：**排队 → 重读存储 → 只改一个字段 → 整份写回 → 换上新快照**。仍然是"单字段写回、整份覆盖"的语义，仍然保留"两个设置页并排打开会互相覆盖"这条已知代价（重读只是把窗口收窄，没有消除）。
2. **档案编辑区保留「保存档案」按钮**（文本类"blur 即存"不适用于档案）。
   理由三条：① `options.test.ts` 有 12 条用例驱动 `[data-action="save-profile"]`（含宿主权限申请、Key 留空的保留语义、非法地址拒绝）；② 保存档案要**在用户手势里**申请 `optional_host_permissions`（Chrome 要求手势），把这件事挂到 `blur` 上会让授权框在不该弹的时候弹；③ 一个填了一半的档案（地址填了、Key 没填）不该被静默写进存储。
   → 结果：档案仍是显式保存；**语言与显示、快捷翻译、术语表、站点规则、提示词、缓存与请求**这 6 组全部即时保存（§10.2 / §10.3 由它们满足）。
3. **「从当前页面填入」做不了，改成"接受粘贴整条网址并规范化成域名"。**
   设置页**自己就是当前窗口的活动标签**：`chrome.tabs.query({active:true,currentWindow:true})` 拿到的是 `chrome-extension://…/options.html`；而 `Tab.url` 只有在声明了 `tabs` 权限（会产生安装警告「读取您的浏览记录」）或持有该页面的宿主权限时才可读——`content_scripts.matches` 属于 scriptable hosts，**不提供**宿主权限（单元 A Task 5 已经查过文献并据此拒绝了 `tabs`）。
   → 计划落成：规则输入框接受 `example.com`、`*.example.com`、以及**整条网址**（`https://www.example.com/docs`）并在失焦时规范化成主机名；不做"从当前页面填入"按钮。
4. **站点规则的"动作"不做下拉，做静态文字「永不翻译」。**
   规格 §5 明确不给 `always/translate` 入口（本扩展没有自动翻译，那个动作今天不产生任何可观察行为）。既然只有一个合法取值，下拉就是假控件：一个只有一项的下拉会让人以为还有别的选项。
   → 每行渲染 `<span class="rule-action" data-rule-action="never">永不翻译</span>`，写入的 `action` 恒为 `'never'`。等自动翻译落地再把这里换成下拉。
5. **状态点记在 `chrome.storage.session`（本次浏览器会话内有效），不是纯内存。**
   规格 §4.3 / §10.6 要求"灰 = **从没测过**"。若只在内存里记，刷新一次设置页就全部回到灰，那句 `title` 立刻变成假话（你明明测过）。`chrome.storage.session` 是受信上下文可读的独立键（`jinyi:engine-health`，不进 `Settings`、不动 schema 版本），代价是浏览器重启后回到灰——那一条写进 README 已知限制。
6. **术语行/规则行的空值语义**：草稿行（`from` 或 `to` / 域名为空）**不写存储**（§10.4）；**已存在**的那条被清空时，**也不写存储**，只明说"没有保存、存储里仍是原来那条、要删请点行尾「删除」"。
   *这一条被审查改过一次*：上一版计划在这里选的是"顺手把既有条目删掉"，理由是"界面空了、存储还留着就是撒谎"。审查挡下的理由是对的——用户的真实动作可能是"清掉重打"，而在失焦那一刻删条目 + 重绘会让**正在编辑的一行当场消失**，这份界面又没有任何撤销出口；相比之下，"界面与存储暂时不一致"只要**明说**就是诚实的。两个区块（术语表、站点规则）用的是同一条口径。
7. **搜索的匹配口径**：只对"区块标题 + 别名表 + 区块说明 `.sec-desc` + 区块里每个字段标签 `.lab`"做匹配，查询串按空白切词、**全部命中**才算命中（AND，不是 OR）；零命中显示「没找到匹配的设置」；过滤只切 `hidden`，不动 DOM 结构。别名表与区块定义放在同一个模块里（`sections/<name>.ts` 的 `aliases`），「密钥 / API Key」归翻译引擎、「词库 / 专有名词」归术语表——两条都有专门的见证用例（`tests/options/search.test.ts`）。
   **索引边界是承重的**（审查专门查过这件事）：隐私区块的正文里到处是「API Key」「密钥」「档案」，所以 `.lab` / `.sec-desc` 之外的元素（含 `.hint`、`<li>`、`<details>`）**一律不进索引**；`tests/options/search.test.ts` 有一条用例专门钉住这个边界（还会断言隐私区块里确实有那些词，免得用例空转）。
8. **原生 `Esc` 取消不写盘：本轮不解决，写进 README。**
   文本控件上改动后按 `Esc` 再失焦，浏览器仍可能派发 `change`（`Esc` 不还原值也不阻止 `change`），于是那次改动照常落盘。改版前有保存按钮时可以反悔，现在没有出口。
   → 不实现"Esc 撤销"：本机没有任何浏览器可以验证 `Esc` 在各控件上的真实语义（规格 §11 的第一条限制），凭猜测写一个"半可用"的撤销比不写更糟。Task 11 在 README 已知限制里如实写上这条，并说明现成的出路（重新改回原值 / 列表行用行尾「删除」）。
9. **`dom.ts` 要有自己的测试**（审查要求）：它是每个区块都依赖的共享件，`runSafely` 的拒绝兜底与 `requireWithin` 的抛错路径必须先有直连用例（`tests/options/dom.test.ts`，4 条），否则它坏了会全线崩而没有任何一条用例指着它。

---

## 文件结构

| 文件 | 动作 | 责任 |
| --- | --- | --- |
| `src/options/store.ts` | 新建 | 内存快照 + 写队列 + 重读后单字段写回（`loadSnapshot` / `currentSettings` / `patchSettings`） |
| `src/options/dom.ts` | 新建 | 各区块共用的最小 DOM 工具：`setStatus` / `describe` / `element` / `fillSelect` / `requireWithin` / `runSafely` |
| `src/options/section.ts` | 新建 | 区块契约：`SectionId` / `Section` / `SectionContext`（`settings()` + `reload()` + `save()`）——**接口只在这一处定义** |
| `src/options/search.ts` | 新建 | 搜索索引与过滤（`parseQuery` / `matchesTerms` / `sectionHaystack` / `createSearch`） |
| `src/options/rule-pattern.ts` | 新建 | 站点规则域名的规范化与形状校验（纯函数，无 DOM） |
| `src/options/engine-health.ts` | 新建 | 状态点的三态记录（`chrome.storage.session`，独立键 `jinyi:engine-health`） |
| `src/options/sections/engine.ts` | 新建 | §3.1 翻译引擎（档案列表、测试连接、状态点、内置引擎不可删） |
| `src/options/sections/language.ts` | 新建 | §3.2 语言与显示（目标语言、**源语言**、显示模式，`change` 即存） |
| `src/options/sections/shortcuts.ts` | 新建 | §3.3 快捷翻译（悬停 / 划词开关 + 快捷键只读行） |
| `src/options/sections/glossary.ts` | 新建 | §3.4 术语表（一行一条、虚线添加、失焦保存、空行不写） |
| `src/options/sections/site-rules.ts` | 新建 | §3.5 站点规则写入侧（增删规则、只提供「永不翻译」） |
| `src/options/sections/prompt.ts` | 新建 | §3.6 自定义提示词（多行文本、留空即内置） |
| `src/options/sections/cache.ts` | 新建 | §3.7 缓存与请求（三个统计、上限、`<details>` 里的并发与批量） |
| `src/options/sections/privacy.ts` | 新建 | §3.8 隐私（**四条**一行式 + `<details>` 里的诚实说明，**不删**） |
| `src/options/options.ts` | 改写 | 只做装配：`SECTIONS` 清单、`SectionContext`、`start()`、全局错误兜底、搜索接线 |
| `src/options/options.html` | 改写 | 8 个区块的静态骨架 + 左导航 + 搜索框（**测试的真实输入**） |
| `src/options/options.css` | 改写 | 令牌、导航、一行一卡片、成组卡片、虚线添加、红字删除、状态行、窄窗口降级 |
| `src/popup/popup.css` | 修改 | `:root` 加一个 `--on-accent`（与 `options.css` 逐字一致的那组令牌必须继续保持一致） |
| `tests/options/harness.ts` | 新建 | 设置页测试的共享夹具（从 `options.test.ts` 原样搬出，断言一条不动） |
| `tests/options/options.test.ts` | 修改 | 4 条 `#save` 用例改成即时保存 + 夹具改为 import |
| `tests/options/store.test.ts` | 新建 | 串行写、重读、失败不卡队列 |
| `tests/options/dom.test.ts` | 新建 | `setStatus` / `runSafely` 的拒绝兜底 / `requireWithin` 抛错 / `fillSelect`（共享件的直连用例，审查要求） |
| `tests/options/options-css.test.ts` | 新建 | 令牌逐字一致、无硬编码颜色、无 `opacity`、焦点环、暗色块、窄窗口降级 |
| `tests/options/no-innerhtml.test.ts` | 新建 | 源码守卫：`src/options/**/*.ts` 里不得出现 `innerHTML` |
| `tests/options/shortcuts.test.ts` | 新建 | 两个开关的即时保存、失败回滚、通知已打开的页面 |
| `tests/options/glossary.test.ts` | 新建 | 增删改、空行不写、Tab 逐个填的两段式保存、清空不静默删、用户输入不进 HTML |
| `tests/options/rule-pattern.test.ts` | 新建 | 域名规范化的全部形状（纯函数） |
| `tests/options/site-rules.test.ts` | 新建 | 规则写入侧（增删、非法形状拒绝、只写 `never`） |
| `tests/options/prompt.test.ts` | 新建 | 提示词的失焦保存与回填 |
| `tests/options/cache-section.test.ts` | 新建 | 统计数字、上限夹取回填、高级折叠、`min`/`max` 与 `mergeSettings` 同源 |
| `tests/options/search.test.ts` | 新建 | 过滤、零命中、别名落点、区块清单与页面结构一一对应 |
| `tests/options/engine-health.test.ts` | 新建 | 三态记录与状态点的渲染、脏存储不崩 |
| `tests/helpers/chrome-stub.ts` | 修改 | `tabs.create`（「去浏览器设置」要用，纯记录） |
| `README.md` | 修改 | 功能范围改写 + 已知限制补 5 条（§11） |

**不动的文件**：`src/manifest.json`（`options_page` 不变）、`scripts/verify-dist.mjs`、`vite.config.ts`（options 入口名不变）、任何 `src/core/**`（分层守卫不受影响）。

### 原型 → DOM 映射（`docs/mockups/options-ia-v2.html` 的版式怎么落）

| 原型里的东西 | 计划里的 DOM | 备注 |
| --- | --- | --- |
| `.wrap` 两列网格 | `.wrap`（`grid-template-columns: 236px minmax(0,1fr)`） | 窄窗口降级见 Task 3 Step 6 |
| `.nav` + `.grp` + `a.on` | `.nav` + `.nav-grp[data-nav-group]` + `.grp` + `a.nav-link[data-nav]` | 活动项用 `:target` + `:has()`（无 JS 滚动联动，见 Task 3 Step 6 的 CSS 注释） |
| `.search input[placeholder="搜索设置"]` | `#search` + `#search-empty` | Task 9 |
| `.sec` / `.sec-head` / `.sec-desc` | 同名 class + `[data-section]` / `id="sec-<id>"` | 搜索与导航的锚点 |
| `.item`（一行一卡片） | `.item`（档案行是 `.item.profile-row`） | 档案行内是 `.profile-summary` 按钮 + `.profile-editor` |
| `.dot` / `.dot.idle` / `.dot.bad` | `.dot[data-state="ok"\|"idle"\|"bad"]` | 用 `data-state` 当契约（class 只负责样式） |
| `.badge` | `.badge` | 「使用中」/「内置」 |
| `.link-danger`（红字删除） | `.link-danger` | 档案、术语、规则三处的删除按钮 |
| `.add`（虚线大按钮） | `.add` | 术语、规则的添加按钮 |
| `.group` / `.grow2` / `.field` | 同名 class | 成组开关与表单行 |
| `.sw` 开关 | `input.switch[type=checkbox]` | **原生 checkbox** 做外观（`appearance:none`），键盘可达，不自造 widget |
| `.stat` | `.stat` + `#stat-cached` / `#stat-max` / `#stat-concurrency` | Task 8 |
| `details/summary` | 原生 `<details>` | 隐私的诚实说明、缓存高级项、状态点语义 |

---

## 任务概览（依赖顺序）

| # | 任务 | 依赖 | 主要产出 |
| --- | --- | --- | --- |
| 1 | `store.ts`：快照 + 写队列 + 重读后单字段写回 | — | `src/options/store.ts`、`tests/options/store.test.ts` |
| 2 | §6 文案修正（独立小刀） | — | `options.html` 的 `#target-hint`、`options.test.ts:295` 的断言改强 |
| 3 | 页面骨架：HTML + CSS + 区块契约 + 4 区块搬家（引擎 / 语言 / 缓存 / 隐私）+ 去掉 `#save` | 1、2 | `options.html` `options.css` `section.ts` `dom.ts` `sections/{engine,language,cache,privacy}.ts` `options.ts`、`harness.ts`、`dom.test.ts`、`options-css.test.ts`、`no-innerhtml.test.ts`、4 条用例改写 |
| 4 | 快捷翻译区块（§3.3） | 3 | `sections/shortcuts.ts`、`shortcuts.test.ts`、`chrome-stub` 加 `tabs.create` |
| 5 | 术语表区块（§3.4） | 3 | `sections/glossary.ts`、`glossary.test.ts` |
| 6 | 站点规则写入侧（§3.5 + §5） | 3 | `rule-pattern.ts`、`sections/site-rules.ts`、两个测试文件 |
| 7 | 自定义提示词区块（§3.6） | 3 | `sections/prompt.ts`、`prompt.test.ts` |
| 8 | 缓存与请求区块补齐（§3.7） | 3 | `sections/cache.ts` 扩展、`cache-section.test.ts` |
| 9 | 搜索（§4.2）+ 区块清单结构守卫 | 3–8 | `search.ts`、`search.test.ts`、`options.ts`/`options.html`/`options.css` 小改 |
| 10 | 状态点三态（§4.3） | 3 | `engine-health.ts`、`sections/engine.ts` 扩展、`engine-health.test.ts` |
| 11 | README 与收口（§11 + 全量命令） | 1–10 | `README.md`、全量 `npm test` / `typecheck` / `build` / `zip` 读数 |

---

## Task 1: `store.ts` —— 快照、写队列、重读后单字段写回

**Files:**
- Create: `src/options/store.ts`
- Test: `tests/options/store.test.ts`

> 这一条是整轮改版的地基：8 组 25 个字段都走它。**写队列不是"顺手加的优化"**，而是即时保存正确性的前提——两个 `change` 挨着发生（改目标语言、紧接着改显示模式）时，各自基于自己读到的基线整份回写，后写的那次会把先写的那次静默抹掉。

- [ ] **Step 1: 写失败测试**

创建 `tests/options/store.test.ts`：

```ts
// tests/options/store.test.ts
/**
 * 设置页存储层的单测。**不起 DOM**：这一层只跟存储打交道（`shared/settings` 是它的唯一依赖），
 * 用默认的 node 环境跑，出错时不必在 jsdom 的噪音里找线索。
 *
 * 每个用例重新 `import` 一次模块（`vi.resetModules()`）：`store.ts` 的快照与写队列都是
 * 模块级状态，跨用例共享会让"还没读出来就该拒绝"这类断言失去意义。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_VERSION, SETTINGS_KEY } from '../../src/shared/settings';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';

let chromeStub: ChromeStub;
let store: typeof import('../../src/options/store');

/** 往存储里写一份**故意不完整**的设置：`loadSettings` 是逐字段补齐的反序列化边界。 */
async function seed(patch: Record<string, unknown> = {}): Promise<void> {
  await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: CURRENT_VERSION, ...patch } });
}

/** 直读存储：验证"改动真的落盘了"，而不是只改了页面里的内存副本。 */
async function stored(): Promise<Record<string, unknown>> {
  const raw = await chromeStub.storage.local.get([SETTINGS_KEY]);
  return (raw[SETTINGS_KEY] ?? {}) as Record<string, unknown>;
}

beforeEach(async () => {
  vi.resetModules();
  chromeStub = installChromeStub();
  store = await import('../../src/options/store');
});

describe('设置页存储层：单字段写回', () => {
  it('改一个字段：整份写回，其余字段原样', async () => {
    await seed({ engineId: 'p-a', targetLang: 'zh-Hans', concurrency: 5 });
    await store.loadSnapshot();

    await store.patchSettings({ targetLang: 'en' });

    const saved = await stored();
    expect(saved.targetLang).toBe('en');
    expect(saved.engineId).toBe('p-a');
    expect(saved.concurrency).toBe(5);
    // 版本号由 saveSettings 统一写成当前版本，不被调用方摆布。
    expect(saved.version).toBe(CURRENT_VERSION);
  });

  it('连着改两个字段：两次都落盘，后一次不抹掉前一次（写队列的见证用例）', async () => {
    // 这就是"改完目标语言顺手改显示模式"的真实序列：两个 change 之间没有任何 await。
    await seed({ targetLang: 'zh-Hans', displayMode: 'translated-only' });
    await store.loadSnapshot();

    const first = store.patchSettings({ targetLang: 'en' });
    const second = store.patchSettings({ displayMode: 'bilingual' });
    await Promise.all([first, second]);

    const saved = await stored();
    expect(saved.targetLang).toBe('en');
    expect(saved.displayMode).toBe('bilingual');
  });

  it('写回前重读存储：期间在别处（弹窗）改过的字段不会被旧快照抹掉', async () => {
    await seed({ targetLang: 'zh-Hans', concurrency: 3 });
    await store.loadSnapshot();

    // 页面已经打开，用户在弹窗里改了并发数（本页快照里还是 3）。
    const current = await stored();
    await chromeStub.storage.local.set({ [SETTINGS_KEY]: { ...current, concurrency: 7 } });

    await store.patchSettings({ targetLang: 'ja' });

    const saved = await stored();
    expect(saved.targetLang).toBe('ja');
    expect(saved.concurrency).toBe(7);
  });

  it('设置还没读出来就写：拒绝并给出可读原因，存储一个字节都不动', async () => {
    await seed({ targetLang: 'zh-Hans' });

    await expect(store.patchSettings({ targetLang: 'en' })).rejects.toThrow('设置还没读出来');

    expect((await stored()).targetLang).toBe('zh-Hans');
    expect(store.currentSettings()).toBeNull();
  });

  it('一次写失败不阻塞下一次写：失败之后队列照样能往下走', async () => {
    await seed({ targetLang: 'zh-Hans' });
    await store.loadSnapshot();

    // 注入一次性失败：这是"存储满了 / 版本被拒绝"这类真实失败的最小替身。
    const realSet = chromeStub.storage.local.set.bind(chromeStub.storage.local);
    let failNext = true;
    chromeStub.storage.local.set = async (items: Record<string, unknown>) => {
      if (failNext) {
        failNext = false;
        throw new Error('存储写入失败');
      }
      await realSet(items);
    };

    await expect(store.patchSettings({ targetLang: 'en' })).rejects.toThrow('存储写入失败');

    // 队列没被那次失败卡死：下一次写必须真的写进去。
    await store.patchSettings({ targetLang: 'ja' });
    expect((await stored()).targetLang).toBe('ja');
  });

  it('快照只在写成功后更新：写失败时快照还是上一次那份', async () => {
    await seed({ targetLang: 'zh-Hans' });
    await store.loadSnapshot();
    expect(store.currentSettings()?.targetLang).toBe('zh-Hans');

    chromeStub.storage.local.set = async () => {
      throw new Error('存储写入失败');
    };
    await expect(store.patchSettings({ targetLang: 'en' })).rejects.toThrow('存储写入失败');

    expect(store.currentSettings()?.targetLang).toBe('zh-Hans');
  });
});
```

- [ ] **Step 2: 跑到红**

Run: `npx vitest run tests/options/store.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/options/store"`（文件还不存在）

- [ ] **Step 3: 写实现**

创建 `src/options/store.ts`：

```ts
// src/options/store.ts
//
// 设置页的存储层：**一份内存快照 + 一条串行的写队列**。
//
// 为什么要有这一层（而不是各处直接 loadSettings/saveSettings）：即时保存把"改设置"从
// 「点一次保存按钮」变成「每次 change / 失焦」——写回的频率上去了，而 `saveSettings` 是
// **整份覆盖**。三件事因此必须在同一处收口：
//
// 1. **排队**：两个 change 挨着发生时，两次写必须串行，否则后写的那次会拿自己那份旧基线
//    整份回写，把先写的那次静默抹掉（`tests/options/store.test.ts` 第二条用例钉住它）。
// 2. **写前重读**：弹窗、后台也在写同一份设置，基线必须是存储里最新的那一份。
// 3. **单字段**：调用方只交一个字段的增量，其余字段永远取自刚读到的存储。
//
// **已知代价（规格 §4.1 / §11，本轮不解决）**：两个设置页并排打开时，双方各自重读、各自
// 整份写回，后写的一方仍然会覆盖前一方——这与改版前"点保存即覆盖"是同一性质。
import { loadSettings, saveSettings, type Settings } from '../shared/settings';

/** 读到存储之前为 null：这期间任何写请求都必须被拒绝，而不是拿一份空设置去覆盖存储。 */
let snapshot: Settings | null = null;

/**
 * 写队列。**这是本模块存在的核心理由**（见文件头）。`patchSettings` 把每次写挂到它后面，
 * 于是第二次写的起点必然是第一次写完成之后的状态。
 */
let queue: Promise<void> = Promise.resolve();

/** 设置还没读出来时的拒绝文案：设置页的用例用「设置还没读出来」这半句做同步点。 */
export const NOT_LOADED = '设置还没读出来，请稍候重试';

/** 当前内存快照（`loadSnapshot()` 之前是 null）。只读用途：渲染、算下一次写回的基线。 */
export function currentSettings(): Settings | null {
  return snapshot;
}

/** 读一次存储，建立快照。失败时**不**留下半份状态：快照仍是 null，后续写一律被拒。 */
export async function loadSnapshot(): Promise<Settings> {
  const loaded = await loadSettings();
  snapshot = loaded;
  return loaded;
}

/**
 * 单字段写回：排队 → **重新读一次存储** → 只改这一个字段 → 整份写回 → 换上新快照。
 *
 * 失败（版本高于本代码、存储读写失败）原样抛给调用方：它是唯一知道该把这句话写到哪个
 * 状态行、要不要把控件拨回去的一方。**失败不写快照**——快照必须永远等于"存储里那一份"。
 */
export function patchSettings(patch: Partial<Settings>): Promise<void> {
  if (snapshot === null) return Promise.reject(new Error(NOT_LOADED));
  const run = queue.then(async () => {
    const latest = await loadSettings();
    const next: Settings = { ...latest, ...patch };
    await saveSettings(next);
    snapshot = next;
  });
  // 队列不能因为一次失败就永久卡死：把失败从链上摘掉（调用方拿到的仍是那份会拒绝的 `run`）。
  queue = run.catch(() => undefined);
  return run;
}
```

- [ ] **Step 4: 跑到绿**

Run: `npx vitest run tests/options/store.test.ts`
Expected: PASS —— **6 条用例**

- [ ] **Step 5: 变异验证（证明这几条测试真的承重）**

逐个把源码改坏，每次跑 `npx vitest run tests/options/store.test.ts`，**必须有用例变红**；全部还原后跑一次确认绿。

| 变异 | 期望红在哪一条 | 说明 |
| --- | --- | --- |
| `const run = queue.then(...)` 改成 `const run = (async () => {...})()`（不排队） | 「连着改两个字段」 | 两次写各拿一份基线，`targetLang` 被后一次覆盖掉——**这条用例是排队唯一的见证** |
| `{ ...latest, ...patch }` 改成 `{ ...snapshot, ...patch }` | 「写回前重读存储」 | 别处改过的 `concurrency: 7` 被旧快照的 3 抹掉 |
| `queue = run.catch(() => undefined)` 改成 `queue = run` | 「一次写失败不阻塞下一次写」 | 队列挂在一个已拒绝的 promise 上，之后的写永不执行，`targetLang` 仍是 `zh-Hans` |
| `snapshot = next` 挪到 `await saveSettings(next)` **之前** | 「快照只在写成功后更新」 | 写失败后快照已经变成 `en`，界面与存储对不上 |
| 删掉开头的 `if (snapshot === null) …` | 「设置还没读出来就写」 | 会拿一份默认设置整份覆盖存储 |

- [ ] **Step 6: 提交**

```bash
git add src/options/store.ts tests/options/store.test.ts
git commit -m "feat(options): 设置页存储层（快照 + 串行写队列 + 写前重读的单字段回写）"
```

---

## Task 2: §6 文案修正（`#target-hint` 里那句已经不成立的话）

**Files:**
- Modify: `src/options/options.html:41-44`
- Modify: `tests/options/options.test.ts:294-295`

> 现状：「仅译文」只显示译文（原文被隐藏，**段落里的链接点不了**，按 Alt+T 可还原）。
> 链接保留下划线/颜色/可点击**早已实现**（README 的「渲染」一节写的就是真实行为），所以这句是**错的**，而 `options.test.ts:295` 正断言它含「链接点不了」。这是**修正**，不是放宽：改后的断言多了一条"仍然存在的限制"，并且反向钉住那句假话不许回来。

- [ ] **Step 1: 写失败测试（先把断言改成新的事实）**

把 `tests/options/options.test.ts` 里那条用例的最后一句（`:294-295`）：

```ts
    // 设置页也要如实说明"仅译文"的代价：段落里的链接点不了。
    expect(pick<HTMLElement>('target-hint').textContent).toContain('链接点不了');
```

改成：

```ts
    // §6 文案修正：旧文案说"段落里的链接点不了"，那**早就不成立**了——链接保留下划线、
    // 颜色与可点击是已经实现的行为（README「渲染」一节写的就是这个）。这里的断言因此改成
    // 钉住**如实**的说法，而不是删掉一条断言：
    //   ① 整段几乎就是一个链接时，译文里的链接仍可点击；
    //   ② 多链接段落与文字占主的段落里，链接仍可能失去下划线与可点击（这是仍存在的限制）；
    //   ③ 反向钉住：那句不成立的旧说法不许回来。
    const hint = pick<HTMLElement>('target-hint').textContent ?? '';
    expect(hint).toContain('链接仍可点击');
    expect(hint).toContain('仍可能失去下划线与可点击');
    expect(hint).not.toContain('链接点不了');
    // ④ 结尾那句「改完点下面的『保存语言与显示』」本任务**故意保留**：此刻那个按钮还在
    //    （`#save` 到 Task 3 才随即时保存一起删掉），这句话在这个提交上是**真的**，
    //    现在删它反而会让文案与界面不符。它的收尾写在 Task 3 Step 13：那里删按钮，
    //    并把这条断言改成 `not.toContain('保存语言与显示')`——一句话只在一个地方改。
    expect(hint).toContain('保存语言与显示');
```

- [ ] **Step 2: 跑到红**

Run: `npx vitest run tests/options/options.test.ts -t 目标语言与显示模式`
Expected: FAIL —— `expected '「仅译文」只显示译文（原文被隐藏，段落里的链接点不了，按 Alt+T 可还原）…' to contain '链接仍可点击'`

- [ ] **Step 3: 改文案**

把 `src/options/options.html:41-44` 的 `#target-hint` 整段替换成：

```html
        <p id="target-hint" class="hint">
          「仅译文」只显示译文（原文被隐藏，按 Alt+T 可还原）；「双语对照」在每段原文下方插入译文。
          链接：整段几乎就是一个链接时（例如整行标题、作者署名行），译文里的链接<strong>链接仍可点击</strong>；
          含<strong>多个链接</strong>的段落与文字占主的正文段落里，链接<strong>仍可能失去下划线与可点击</strong>——
          要读原文请按 Alt+T 还原，或在弹窗里切「双语对照」后重新翻译。
          改完点下面的「保存语言与显示」；已经翻译过的页面要重新翻译才会换过来。
        </p>
```

> **这一块的边界要说清（上一版计划在这里含糊过）**：替换的范围是**整个 `<p>`（4 行，`:41-44`）**，但**只改链接那句**——末尾那句「改完点下面的「保存语言与显示」；已经翻译过的页面要重新翻译才会换过来。」**逐字保留**，因为**此刻那个按钮还在**（`#save` 是 Task 3 才删的），删了它这个提交就自相矛盾。
> **它的最终归宿在 Task 3 Step 13**：那里删掉 `#save`、把 `#target-hint` 重写成「改动即时保存；已经翻译过的页面要重新翻译才会换过来。」，并把本任务加的 `expect(hint).toContain('保存语言与显示')` **改成** `expect(hint).not.toContain('保存语言与显示')`。一句话只在一个提交里改一次，两个提交各自都是真话。

- [ ] **Step 4: 跑到绿**

Run: `npx vitest run tests/options/options.test.ts`
Expected: PASS —— **29 条用例**（本任务不改用例数量，只改一条断言的内容）

- [ ] **Step 5: 变异验证**

把 `#target-hint` 里的「仍可能失去下划线与可点击」改回「链接点不了」→ `npx vitest run tests/options/options.test.ts` 必须**恰好**让「目标语言与显示模式照旧按存储回填」那条红（`.not.toContain('链接点不了')` 与 `.toContain('仍可能失去下划线与可点击')` 各报一次）。还原后再跑一次确认绿。

- [ ] **Step 6: 提交（提交信息里必须写明理由）**

```bash
git add src/options/options.html tests/options/options.test.ts
git commit -m "fix(options): 改掉「段落里的链接点不了」这句错文案

仅译文模式下链接保留下划线/颜色/可点击早已实现（README「渲染」一节），
options.html 里那句话现在是错的，而 options.test.ts:295 正断言它含「链接点不了」。
断言改成钉住如实的三件事：整段几乎就是一个链接时仍可点击、多链接与文字占主段落里
仍可能失去下划线与可点击、旧说法不许回来——这是修正而非放宽，断言条数还多了一条。"
```

---

## Task 3: 页面骨架 —— HTML + CSS + 区块契约 + 4 区块搬家 + 去掉 `#save`

**Files:**
- Create: `src/options/dom.ts`
- Create: `src/options/section.ts`
- Create: `src/options/sections/engine.ts`
- Create: `src/options/sections/language.ts`
- Create: `src/options/sections/cache.ts`
- Create: `src/options/sections/privacy.ts`
- Create: `tests/options/harness.ts`
- Create: `tests/options/options-css.test.ts`
- Create: `tests/options/no-innerhtml.test.ts`
- Modify: `src/options/options.ts`（694 行 → 约 90 行的装配）
- Modify: `src/options/options.html`（89 行 → 8 组骨架里的前 4 组 + 导航）
- Modify: `src/options/options.css`（441 行 → 新体系的完整样式表）
- Modify: `src/popup/popup.css:28`（加 `--on-accent`）
- Modify: `tests/options/options.test.ts`（夹具改为 import；4 条 `#save` 用例改写）

> 这是本轮最大的一刀，但性质是**搬家**：引擎区块的实现（`buildEditor` / `handleSaveProfile` / `handleTestProfile` / `handleDeleteProfile` / 服务商模板 / Key 显示切换 / 权限申请）逐行照搬进 `sections/engine.ts`，只把 `settings` 换成 `ctx.settings()`、把 `setStatus(engineStatus, …)` 换成 `ctx.save(…)` / `setStatus(status, …)`。**引擎区块的 20 条既有用例一条都不改、一条都不许红**——它们是这次搬家的验收标准。
>
> 搬迁过程中**唯一**允许的行为变化是：档案保存/删除改走 `ctx.save(...)`，于是它天然获得了"写前重读存储、只覆盖档案列表"的性质（原来手写的 `loadSettings` 那一段还在，负责 Key 留空的合并语义）。

- [ ] **Step 1: 先把测试夹具搬出去（不改任何断言）**

创建 `tests/options/harness.ts`：

```ts
// tests/options/harness.ts
/**
 * 设置页测试的共享夹具：`options.test.ts` 与各区块的测试文件共用一份。
 *
 * 用例顺序是固定的，不能改：装替身 → 写存储 → 装 DOM → `import` 设置页模块 → 等初始化。
 * 被测模块在 **import 时**就跑 `init()`：模块顶层按 id 取 DOM 元素（DOM 必须先就位），
 * `init()` 同步挂好监听器，然后才 `await loadSettings()`。`vi.resetModules()` 保证每个
 * 用例拿到一份新的模块实例（页面里持有当前设置快照）。
 *
 * DOM 用 `src/options/options.html` 的**真实内容**（`DOMParser` 解析后取 body），不手抄一份
 * 结构。动态渲染的行一律按 `data-*` 契约找、按 `data-action` 点——与实现共用的是**契约**
 * （这些属性名），不是查询细节。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { CURRENT_VERSION, SETTINGS_KEY } from '../../src/shared/settings';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';

/**
 * 用 `import.meta.dirname` 拼路径，而不是 `new URL('...', import.meta.url)`：后者会被
 * Vite 的资源转换改写成 http 地址（jsdom 环境下 `fileURLToPath` 直接拒绝它）。
 */
const OPTIONS_HTML_PATH = join(import.meta.dirname, '..', '..', 'src', 'options', 'options.html');

export const CUSTOM_BASE_URL = 'https://api.example.com/v1';
/** 与 shared/host-permission 的 originPattern 同形：申请授权的对象是整串匹配模式。 */
export const CUSTOM_ORIGIN_PATTERN = 'https://api.example.com/*';

/**
 * 当前用例的 chrome 替身，由 {@link resetOptionsPage} 在每个用例的 `beforeEach` 里重装。
 * 用 `export let`：ESM 的实时绑定保证用例读到的一定是**这一条**用例的那份替身。
 */
export let chromeStub: ChromeStub;

/** 每个用例的 `beforeEach` 里调用（顺序与本仓库既有的写法一致）。 */
export function resetOptionsPage(): void {
  document.body.innerHTML = '';
  vi.resetModules();
  chromeStub = installChromeStub();
}

/** 档案的种子形状；用例只覆盖自己在意的那几个字段。 */
export function profileSeed(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'p-a', label: '我的 DeepSeek', baseUrl: CUSTOM_BASE_URL, model: 'deepseek-chat', apiKey: 'sk-a', ...over };
}

export function pick<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`options.html 里没有 #${id}`);
  return found as T;
}

/** 全部档案行（含"新增"草稿行），按渲染顺序。 */
export function profileRows(): HTMLElement[] {
  return Array.from(pick<HTMLElement>('profiles').querySelectorAll<HTMLElement>('.profile-row[data-profile-id]'));
}

export function rowOf(id: string): HTMLElement {
  const row = profileRows().find((candidate) => candidate.dataset.profileId === id);
  if (row === undefined) throw new Error(`档案行不存在：${id}`);
  return row;
}

export function editorOf(id: string): Element {
  const editor = rowOf(id).querySelector('.profile-editor');
  if (editor === null) throw new Error(`档案 ${id} 没有展开编辑区`);
  return editor;
}

export function fieldOf(editor: Element, selector: string): HTMLInputElement {
  const input = editor.querySelector<HTMLInputElement>(selector);
  if (input === null) throw new Error(`编辑区缺控件 ${selector}`);
  return input;
}

export function actionButton(editor: Element, action: string): HTMLButtonElement {
  const button = editor.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  if (button === null) throw new Error(`编辑区缺按钮 ${action}`);
  return button;
}

/** 展开某个档案的编辑区（点它自己那一行的摘要按钮；已经展开就原样返回，点了不重复收起）。 */
export function expand(id: string): Element {
  const row = rowOf(id);
  const existing = row.querySelector('.profile-editor');
  if (existing !== null) return existing;
  row.querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
  return editorOf(id);
}

/** jsdom 的 `new Event(...)` 默认不冒泡；区块里的监听是事件委托，必须带 bubbles。 */
export function bubble(type: string): Event {
  return new Event(type, { bubbles: true });
}

/** 往存储里写一份**故意不完整**的设置：`loadSettings` 是逐字段补齐的反序列化边界。 */
export async function seedSettings(patch: Record<string, unknown> = {}): Promise<void> {
  await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: CURRENT_VERSION, ...patch } });
}

/** 直读存储：验证「改动真的落盘了」，而不是只改了页面里的内存副本。 */
export async function storedSettings(): Promise<Record<string, unknown>> {
  const raw = await chromeStub.storage.local.get([SETTINGS_KEY]);
  return (raw[SETTINGS_KEY] ?? {}) as Record<string, unknown>;
}

export async function storedProfiles(): Promise<Array<Record<string, unknown>>> {
  return ((await storedSettings()).profiles ?? []) as Array<Record<string, unknown>>;
}

export function mountOptionsHtml(): void {
  const html = readFileSync(OPTIONS_HTML_PATH, 'utf-8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
}

/** 让已经排队的微任务跑完（替身里的存储与权限调用都是立即兑现的 promise）。 */
export async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 轮询直到条件成立（点击后的收尾是异步的）。 */
export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('waitFor 超时：条件始终不成立');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 装 DOM、import 设置页模块，并等 `start()` 那串 await（loadSettings → 各区块 mount）跑完。 */
export async function loadOptions(): Promise<void> {
  mountOptionsHtml();
  await import('../../src/options/options');
  await settle();
}

export function engineStatus(): HTMLElement {
  return pick<HTMLElement>('engine-status');
}

/**
 * 引擎只读 `status` / `ok` / `json()`，所以不必真的构造 `Response`——jsdom 环境里
 * 全局 `Response` 是 Node 那份，用它只会把用例和运行时实现绑在一起。
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => data } as unknown as Response;
}

/** OpenAI 兼容接口的编号响应。 */
export function chatResponse(content: string): Response {
  return jsonResponse({ choices: [{ message: { role: 'assistant', content } }] });
}
```

- [ ] **Step 2: 让 `options.test.ts` 用上夹具（断言一条不动）**

`tests/options/options.test.ts` 的改动**只有两类**，逐条列出（不要顺手改别的）：

1. 删掉文件里这些**本地定义**（它们现在住在 `harness.ts`）：`OPTIONS_HTML_PATH`、`CUSTOM_BASE_URL`、`CUSTOM_ORIGIN_PATTERN`、`let chromeStub: ChromeStub;`、`profileSeed`、`pick`、`profileRows`、`rowOf`、`editorOf`、`fieldOf`、`actionButton`、`expand`、`bubble`、`seedSettings`、`storedSettings`、`storedProfiles`、`mountOptionsHtml`、`settle`、`waitFor`、`loadOptions`、`engineStatus`、`jsonResponse`、`chatResponse`。
2. **同时删掉会变成死引用的 import**（`tsconfig` 没开 `noUnusedLocals`，`typecheck` **不会**帮你发现，留着就是悬空引用）：`import { readFileSync } from 'node:fs';`（`:19`）、`import { join } from 'node:path';`（`:20`）、`installChromeStub` 与 `type ChromeStub`（`:25` 那个 import 整行删掉——替身现在由 harness 装）。
   **要留的**：`afterEach, beforeEach, describe, expect, it, vi`（`vi` 还在 `:632/:633/:664/:679` 一带用着，`vi.unstubAllGlobals()` 在 `afterEach` 里）；`LANGUAGES`、`DEFAULT_ENGINE_ID`/`getEngine`、`CURRENT_VERSION`/`DISPLAY_MODES`/`PROVIDER_PRESETS`/`SETTINGS_KEY` 也全部保留（它们仍被断言直接引用）。
3. import 区改成：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANGUAGES } from '../../src/core/lang';
import { DEFAULT_ENGINE_ID, getEngine } from '../../src/engines/registry';
import { CURRENT_VERSION, DISPLAY_MODES, PROVIDER_PRESETS, SETTINGS_KEY } from '../../src/shared/settings';
import {
  CUSTOM_BASE_URL,
  CUSTOM_ORIGIN_PATTERN,
  actionButton,
  bubble,
  chatResponse,
  chromeStub,
  editorOf,
  engineStatus,
  expand,
  fieldOf,
  jsonResponse,
  loadOptions,
  pick,
  profileRows,
  profileSeed,
  resetOptionsPage,
  rowOf,
  seedSettings,
  storedProfiles,
  storedSettings,
  waitFor,
} from './harness';
```

`beforeEach` 改成：

```ts
beforeEach(() => {
  resetOptionsPage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});
```

文件顶部那段说明性注释保留（它讲的是"为什么是这个顺序"，仍然成立），只把 `src/options/options.ts` 那几句里出现的 `options.ts` 行为描述保持不变。

- [ ] **Step 3: 跑到绿（搬家不改变行为）**

Run: `npx vitest run tests/options/options.test.ts`
Expected: PASS —— **29 条用例，一条不少、断言一字未改**

- [ ] **Step 4: 写样式纪律测试（先红）**

创建 `tests/options/options-css.test.ts`：

```ts
// tests/options/options-css.test.ts
/**
 * 设置页样式的纪律断言（规格 §7）。全部走 `tests/helpers/css.ts` 的**真解析**：
 * 按配对花括号定位规则、选择器完整相等、扫描时跳过字符串与注释——所以"把某条声明删掉"
 * 等于"声明表里查不到这一项"，断言当场红，不会像子串匹配那样被注释里的同名文字骗过去。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { declarationBlock, declarations, stripCssComments } from '../helpers/css';

const ROOT = join(import.meta.dirname, '..', '..', 'src');
const optionsCss = readFileSync(join(ROOT, 'options', 'options.css'), 'utf-8');
const popupCss = readFileSync(join(ROOT, 'popup', 'popup.css'), 'utf-8');

const DARK = '@media (prefers-color-scheme: dark)';
const NARROW = '@media (max-width: 900px)';

describe('设置页样式：令牌', () => {
  it('与 popup.css 共用的那一组令牌逐字一致（亮色）', () => {
    const popup = declarations(popupCss, ':root');
    const options = declarations(optionsCss, ':root');
    // 逐条比 popup 的每一个令牌：options 可以有自己额外的令牌，但共用的那些不许漂。
    for (const [name, value] of Object.entries(popup)) {
      expect(`${name}: ${options[name]}`).toBe(`${name}: ${value}`);
    }
    // popup 的令牌一个都没漏比（防止上面那个循环因为某天 popup 被清空而空转）。
    expect(Object.keys(popup).length).toBeGreaterThanOrEqual(17);
  });

  it('暗色只定义一次，且覆盖正文用到的每一个颜色令牌', () => {
    const dark = declarations(optionsCss, ':root', DARK);
    expect(dark['--surface']).toBe('#1c1f23');
    expect(dark['--text']).toBe('#e8eaed');
    expect(dark['--danger']).toBe('#f87171');
    // 暗色块不许把亮色令牌漏一半：正文里出现的颜色令牌必须都在暗色块里有值。
    const body = stripCssComments(optionsCss);
    const used = new Set([...body.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1] as string));
    const light = declarations(optionsCss, ':root');
    const missing = [...used].filter((token) => light[token] === undefined);
    expect(missing).toEqual([]);
  });
});

describe('设置页样式：正文不许硬编码颜色、不许用 opacity', () => {
  /** 去掉两个 `:root` 块之后的样式表正文。 */
  function bodyWithoutTokens(): string {
    const light = declarationBlock(optionsCss, ':root');
    const dark = declarationBlock(optionsCss, ':root', DARK);
    return stripCssComments(optionsCss)
      .replace(`{${light}}`, '{}')
      .replace(`{${dark}}`, '{}');
  }

  it('颜色只从令牌来：正文里不出现十六进制 / rgb / hsl 字面量', () => {
    const rest = bodyWithoutTokens();
    // `%23` 那种转义（自绘 chevron 的 mask）不算颜色字面量：它没有裸 `#`。
    expect(rest.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(rest.match(/\b(?:rgba?|hsla?)\(/g) ?? []).toEqual([]);
  });

  it('不许用 opacity 充当次级文字（暗色下对比度不可控）', () => {
    expect(stripCssComments(optionsCss).match(/(?:^|[;{\s])opacity\s*:/g) ?? []).toEqual([]);
  });
});

describe('设置页样式：键盘与窄窗口', () => {
  it('保留统一焦点环，并且用的是强调色令牌', () => {
    const ring = declarations(optionsCss, '*:focus-visible');
    expect(ring['outline']).toContain('var(--accent)');
    expect(ring['outline-offset']).toBeDefined();
  });

  it('导航与折叠区用原生控件，不需要自造 widget 的样式（details/summary 有样式）', () => {
    expect(declarations(optionsCss, 'summary')['cursor']).toBe('pointer');
  });

  it('窄窗口有明确的降级策略：导航不再吸顶、改成一行可横滚的链接（规格 §11：未经真机渲染验证）', () => {
    const wrap = declarations(optionsCss, '.wrap', NARROW);
    const nav = declarations(optionsCss, '.nav', NARROW);
    expect(wrap['display']).toBe('block');
    expect(nav['position']).toBe('static');
  });
});
```

- [ ] **Step 5: 跑到红**

Run: `npx vitest run tests/options/options-css.test.ts`
Expected: FAIL —— 至少这两条红：①「颜色只从令牌来」报 `[ '#fff' ]`（旧 `.primary` 里那句 `color: #fff`）；②「窄窗口有明确的降级策略」抛 `样式表里没有选择器「.wrap」的规则（作用域 @media (max-width: 900px)）`。

- [ ] **Step 6: 重写样式表（跑到绿）**

用下面的内容**整体替换** `src/options/options.css`：

```css
/* src/options/options.css */
/*
 * 设置页样式。版式取自 docs/mockups/options-ia-v2.html：左锚点导航 + 单列长滚动，
 * 列表用「一行一卡片 + 红字删除 + 虚线添加」的语言，成组设置（语言/显示/悬停/划词/隐私）
 * 用一整块卡片 + 行间细分割线，不做成一堆独立小卡片。
 *
 * 纪律（规格 §7，`tests/options/options-css.test.ts` 逐条守着）：
 * - 所有颜色走下面的令牌，亮/暗两套只在 `:root` 与 `prefers-color-scheme: dark` 里各定义一次；
 *   正文里**不允许再出现硬编码颜色**；
 * - 次级文字一律 `var(--text-2)` / `var(--text-3)`，不许用 `opacity`（暗色下对比度不可控）；
 * - 与 `src/popup/popup.css` 共用的那一组令牌逐字一致；
 * - `*:focus-visible` 焦点环保留，导航与折叠区一律原生控件（`a` / `button` / `details`）。
 *
 * **本机没有浏览器，任何布局都没被真实渲染验证过**（规格 §11）。窄窗口那一段是"明确的
 * 降级策略"，不是"验证过的效果"：请用户肉眼验收。
 */

:root {
  color-scheme: light dark;

  /* 下面这一组与 src/popup/popup.css 的 `:root` 必须逐字一致（两份 CSS 各写一份，
     不引第三个文件：扩展页面只加载自己那一份，共用文件会凭空多一个构建期依赖）。 */
  --surface: #ffffff;
  --surface-2: #f6f7f9;
  --surface-3: #eceef2;
  --border: rgba(0, 0, 0, 0.1);
  --border-strong: rgba(0, 0, 0, 0.18);
  --text: #1a1d21;
  --text-2: #5b6470;
  --text-3: #8b93a0;
  --accent: #2563eb;
  --accent-hover: #1d4ed8;
  --accent-weak: rgba(37, 99, 235, 0.1);
  --ok: #16794a;
  --danger: #c0342b;
  --on-accent: #ffffff;
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.06), 0 8px 24px rgba(0, 0, 0, 0.06);
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-pill: 999px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --surface: #1c1f23;
    --surface-2: #262a2f;
    --surface-3: #30353b;
    --border: rgba(255, 255, 255, 0.12);
    --border-strong: rgba(255, 255, 255, 0.2);
    --text: #e8eaed;
    --text-2: #a8b0bb;
    --text-3: #7d858f;
    --accent: #4d8df6;
    --accent-hover: #6ba1ff;
    --accent-weak: rgba(77, 141, 246, 0.16);
    --ok: #4ade80;
    --danger: #f87171;
    --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.5), 0 8px 24px rgba(0, 0, 0, 0.36);
  }
}

body {
  margin: 0;
  padding: 0;
  font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--text);
  background: var(--surface-2);
}

/* 键盘导航的统一焦点环。 */
*:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 4px;
}

/* 只在屏幕阅读器里出声的文本（页面标题）。 */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* ------------------------------------------------------------------ 版式：左导航 + 主列 */

.wrap {
  display: grid;
  grid-template-columns: 236px minmax(0, 1fr);
  gap: 36px;
  align-items: start;
  max-width: 1180px;
  margin: 0 auto;
  padding: 28px 28px 90px;
}

.main {
  min-width: 0;
}

/* ------------------------------------------------------------------ 左导航 */

.nav {
  position: sticky;
  top: 28px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 0 18px;
  padding: 0 10px;
  font-size: 16px;
  letter-spacing: -0.01em;
}

.glyph {
  display: grid;
  place-items: center;
  flex: none;
  width: 24px;
  height: 24px;
  font-size: 12px;
  font-weight: 700;
  color: var(--on-accent);
  background: var(--accent);
  border-radius: var(--radius-sm);
}

.nav-grp {
  margin-bottom: 2px;
}

.grp {
  margin: 18px 0 5px 12px;
  font-size: 11px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-3);
}

.nav-link {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  font-size: 13.5px;
  color: var(--text-2);
  text-decoration: none;
  border-radius: 8px;
}

.nav-link:hover {
  color: var(--text);
  background: var(--surface);
}

.nav-link .i {
  flex: none;
  width: 16px;
  font-size: 13px;
  text-align: center;
  color: var(--text-3);
}

/* 活动项：跟着**最近点过的导航项**（`:target`）走。刻意不做滚动联动——那要
   `IntersectionObserver` 或 scroll 监听，而本机没有任何真实渲染验证手段，宁可不做一个
   测不了的假联动。键盘可达性来自 `<a href="#…">` 本身（原生锚点，不自造 widget）。 */
body:has(#sec-engine:target) [data-nav="engine"],
body:has(#sec-language:target) [data-nav="language"],
body:has(#sec-shortcuts:target) [data-nav="shortcuts"],
body:has(#sec-glossary:target) [data-nav="glossary"],
body:has(#sec-site-rules:target) [data-nav="site-rules"],
body:has(#sec-prompt:target) [data-nav="prompt"],
body:has(#sec-cache:target) [data-nav="cache"],
body:has(#sec-privacy:target) [data-nav="privacy"] {
  font-weight: 600;
  color: var(--text);
  background: var(--surface);
}

body:has(#sec-engine:target) [data-nav="engine"]::before,
body:has(#sec-language:target) [data-nav="language"]::before,
body:has(#sec-shortcuts:target) [data-nav="shortcuts"]::before,
body:has(#sec-glossary:target) [data-nav="glossary"]::before,
body:has(#sec-site-rules:target) [data-nav="site-rules"]::before,
body:has(#sec-prompt:target) [data-nav="prompt"]::before,
body:has(#sec-cache:target) [data-nav="cache"]::before,
body:has(#sec-privacy:target) [data-nav="privacy"]::before {
  content: "";
  position: absolute;
  left: -1px;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 2px;
  background: var(--accent);
}

.foot {
  margin: 24px 4px 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-3);
}

/* ------------------------------------------------------------------ 区块 */

.sec {
  margin-bottom: 30px;
  scroll-margin-top: 24px;
}

.sec-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 0 0 4px;
}

.sec-head h2 {
  margin: 0;
  font-size: 15px;
  letter-spacing: -0.005em;
}

.sec-head .act {
  margin-left: auto;
}

.sec-desc {
  margin: 0 0 14px;
  font-size: 12.5px;
  color: var(--text-2);
}

/* ------------------------------------------------------------------ 一行一卡片 */

.item,
.profile-row {
  margin-bottom: 9px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
}

.item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 16px;
}

.profile-row {
  overflow: hidden;
}

.profile-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 13px 16px;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: none;
}

.profile-summary:hover {
  background: var(--surface-2);
}

.grow {
  flex: 1;
  min-width: 0;
}

.line {
  display: flex;
  align-items: center;
  gap: 6px;
}

.name {
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.meta {
  display: block;
  margin-top: 2px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11.5px;
  color: var(--text-3);
  overflow-wrap: anywhere;
}

.badge {
  flex: none;
  padding: 1px 9px;
  font-size: 11px;
  font-weight: 500;
  color: var(--accent);
  background: var(--accent-weak);
  border-radius: var(--radius-pill);
  white-space: nowrap;
}

.profile-editor {
  padding: 12px;
  background: var(--surface-2);
  border-top: 1px solid var(--border);
}

/* ------------------------------------------------------------------ 成组设置（一块卡片 + 行间细线） */

.group {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.grow2,
.field {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 16px;
  border-top: 1px solid var(--border);
}

.grow2:first-child,
.field:first-child {
  border-top: none;
}

.grow2:hover {
  background: var(--surface-2);
}

.lab {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  color: var(--text);
}

.grow2 .lab {
  font-weight: 500;
}

.lab small,
.grow2 .lab span {
  display: block;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-3);
}

/* ------------------------------------------------------------------ 表单控件 */

input[type="text"],
input[type="search"],
input[type="number"],
select,
textarea {
  min-width: 0;
  padding: 5px 8px;
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
}

input:hover,
select:hover,
textarea:hover {
  border-color: var(--text-3);
}

input:focus,
select:focus,
textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
  outline: none;
}

textarea {
  width: 100%;
  resize: vertical;
}

.key-row {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.key-row input {
  flex: 1 1 auto;
}

/* 开关：原生 checkbox 做外观（键盘可达、空格键可切），不自造 widget。 */
.switch {
  flex: none;
  width: 36px;
  height: 21px;
  padding: 0;
  appearance: none;
  -webkit-appearance: none;
  cursor: pointer;
  background: var(--border-strong);
  border: none;
  border-radius: var(--radius-pill);
}

.switch:checked {
  background: var(--accent);
}

.switch::after {
  content: "";
  display: block;
  width: 17px;
  height: 17px;
  margin-left: 2px;
  background: var(--on-accent);
  border-radius: 50%;
}

.switch:checked::after {
  margin-left: 17px;
}

/* ------------------------------------------------------------------ 按钮体系 */

button {
  font: inherit;
  font-size: 13px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.primary,
.ghost {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 34px;
  padding: 0 16px;
  font-weight: 500;
  white-space: nowrap;
  border: 1px solid transparent;
}

.primary {
  color: var(--on-accent);
  background: var(--accent);
}

.primary:hover {
  background: var(--accent-hover);
}

.ghost {
  color: var(--text);
  background: transparent;
  border-color: var(--border-strong);
}

.ghost:hover {
  background: var(--surface-3);
}

.tiny {
  height: 28px;
  padding: 0 11px;
  font-size: 12.5px;
  font-weight: 400;
}

/* 删除类操作：**红色文字按钮**，不要描边（危险动作不该是页面上最抢眼的东西，也不该
   看起来像个普通按钮）。 */
.link-danger {
  padding: 4px 8px;
  font-size: 13px;
  color: var(--danger);
  background: none;
  border: none;
}

.link-danger:hover {
  text-decoration: underline;
}

.actions {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}

/* ------------------------------------------------------------------ 提示、状态、折叠 */

.hint {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}

.status {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-height: 1.4em;
  margin: 10px 0 0;
  font-size: 12.5px;
  color: var(--text-3);
  white-space: pre-wrap;
}

.status::before {
  content: "";
  flex: 0 0 auto;
  width: 5px;
  height: 5px;
  margin-top: 7px;
  background: currentColor;
  border-radius: 50%;
}

.status[data-kind="ok"] {
  color: var(--ok);
}

.status[data-kind="err"] {
  color: var(--danger);
}

.status[data-kind="pending"] {
  color: var(--text-2);
}

details {
  margin-top: 10px;
}

summary {
  font-size: 12.5px;
  color: var(--accent);
  cursor: pointer;
  list-style: none;
}

summary::-webkit-details-marker {
  display: none;
}

summary::before {
  content: "▸ ";
}

details[open] summary::before {
  content: "▾ ";
}

details p {
  margin: 8px 0 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-2);
}

/* ------------------------------------------------------------------ 隐私清单 */

.privacy {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--text-2);
  list-style: none;
}

.privacy li {
  padding: 13px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
}

.privacy li + li {
  margin-top: 9px;
}

.privacy code {
  padding: 1px 5px;
  font-size: 12px;
  color: var(--text);
  background: var(--surface-2);
  border-radius: 4px;
}

/* ------------------------------------------------------------------ 窄窗口降级（规格 §11，未经真机渲染验证） */

@media (max-width: 900px) {
  .wrap {
    display: block;
    padding: 16px 16px 64px;
  }

  /* 左导航退化成顶部一行可横滚的胶囊链接：不再吸顶（窄窗口吸顶会吃掉半屏正文），
     品牌与分组标题让位给链接本身。 */
  .nav {
    position: static;
    margin-bottom: 18px;
  }

  .nav .brand,
  .nav .grp,
  .nav .foot {
    display: none;
  }

  .nav-grp {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
  }

  .nav-link {
    background: var(--surface);
    border: 1px solid var(--border);
  }
}
```

同一时刻，给 `src/popup/popup.css` 的 `:root`（`:28` 的 `--accent-weak` 之后）加一行同名令牌——**两份 CSS 共用的那组必须逐字一致**，而新样式表里 `.primary` 与开关滑块需要"强调色上的文字色"：

```css
  --on-accent: #ffffff;
```

- [ ] **Step 7: 跑到绿（样式纪律）**

Run: `npx vitest run tests/options/options-css.test.ts`
Expected: PASS —— **7 条用例**（令牌 2 条、正文颜色与 opacity 2 条、键盘与窄窗口 3 条）

- [ ] **Step 8: 写「不许用 `innerHTML`」的源码守卫**

创建 `tests/options/no-innerhtml.test.ts`：

```ts
// tests/options/no-innerhtml.test.ts
/**
 * 源码守卫：`src/options/**` 里不许出现 `innerHTML` / `outerHTML` / `insertAdjacentHTML`
 * （规格 §7）。术语、档案名、规则域名都是**用户输入**，一旦走 HTML 解析就是注入面。
 *
 * 与 `tests/core/layering.test.ts` 同一个形状：断言**源码文本本身**，因为这条约束
 * 运行时看不出来（今天所有调用点都恰好没拿用户输入去拼 HTML，改天就不一定）。
 * 口径也是同款"往严格一侧失败"：按裸标识符扫，**含注释**——想提这件事就用描述性说法。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface SourceFile {
  path: string;
  text: string;
}

function collect(dir: string): SourceFile[] {
  const files: SourceFile[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...collect(child));
    else if (entry.name.endsWith('.ts')) files.push({ path: child, text: readFileSync(join(ROOT, child), 'utf8') });
  }
  return files;
}

const sources = collect('src/options');

const FORBIDDEN = /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/;

describe('设置页源码守卫：用户数据一律走 textContent', () => {
  it('至少扫到 8 个文件（防止路径写错导致空扫描假通过）', () => {
    // 8 = 本任务落地后 `src/options` 下的模块数（options/store/dom/section + 4 个区块）。
    // 后面每个任务还会往 `sections/` 里加文件，这个下界不会再动。
    expect(sources.length).toBeGreaterThanOrEqual(8);
  });

  it('不出现 innerHTML / outerHTML / insertAdjacentHTML', () => {
    const hits: string[] = [];
    for (const file of sources) {
      file.text.split('\n').forEach((line, index) => {
        if (FORBIDDEN.test(line)) hits.push(`${file.path}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
```

- [ ] **Step 9: 跑到红（清点断言此刻必然红，Step 11 之后转绿）**

Run: `npx vitest run tests/options/no-innerhtml.test.ts`
Expected: PASS —— **2 条用例**（此时 `src/options` 下只有 `options.ts` 一个文件 → 第 1 条会红！）

> **注意**：此刻 `src/options` 下只有 `options.ts` 一个文件，所以第 1 条「至少扫到 8 个文件」
> **现在必然红**（`expected 1 to be greater than or equal to 8`）。它是**清点守卫**：等 Step 11
> 落地 8 个模块（`store.ts` / `dom.ts` / `section.ts` + 4 个区块）后自然变绿——**这是预期的红**，
> 继续往下做，Step 11 之后回到这一步重跑。

- [ ] **Step 10: 重写 `options.html`（导航 + 前 4 组骨架）**

用下面的内容**整体替换** `src/options/options.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="./options.css" />
    <title>浸译 · 设置</title>
  </head>
  <body>
    <div class="wrap">
      <!-- 左导航：原生锚点（键盘可达，不自造 widget）。活动项的高亮由 CSS 的
           `:target` + `:has()` 给，跟着最近点过的那一项走。 -->
      <nav class="nav" aria-label="设置导航">
        <p class="brand"><span class="glyph" aria-hidden="true">浸</span>浸译</p>

        <div class="nav-grp" data-nav-group>
          <p class="grp">翻译</p>
          <a class="nav-link" href="#sec-engine" data-nav="engine"><span class="i" aria-hidden="true">⚙</span>翻译引擎</a>
          <a class="nav-link" href="#sec-language" data-nav="language"><span class="i" aria-hidden="true">文</span>语言与显示</a>
        </div>

        <div class="nav-grp" data-nav-group>
          <p class="grp">数据</p>
          <a class="nav-link" href="#sec-cache" data-nav="cache"><span class="i" aria-hidden="true">⛁</span>缓存与请求</a>
          <a class="nav-link" href="#sec-privacy" data-nav="privacy"><span class="i" aria-hidden="true">🛈</span>隐私</a>
        </div>

        <p class="foot">v0.1.0 · 设置改动即时保存<br />无需点「保存」</p>
      </nav>

      <main class="main">
        <h1 class="sr-only">浸译 设置</h1>

        <!-- 翻译引擎 -->
        <section class="sec" id="sec-engine" data-section="engine" aria-labelledby="sec-engine-title">
          <div class="sec-head">
            <h2 id="sec-engine-title">翻译引擎</h2>
            <div class="act"><button id="add-profile" class="ghost tiny" type="button">+ 新增档案</button></div>
          </div>
          <p id="engine-hint" class="sec-desc"></p>
          <!-- 档案列表由 sections/engine.ts 渲染：一行一张卡片，点行展开编辑。
               展开编辑框里 API Key **永远从空开始**（留空保存 = 保留原 Key）——
               密钥不回填、不渲染进 DOM。 -->
          <div id="profiles"></div>
          <p class="hint">
            一个档案 = 一份接口地址 + 模型名 + API Key（走 OpenAI 兼容协议，可接 OpenAI、DeepSeek、
            硅基流动、Ollama 等）。配好几个后，在<strong>弹窗</strong>的「翻译引擎」下拉里按名字直接切换。
            每个档案的访问授权在点「保存档案」时按它自己的地址申请（Chrome 要求用户手势）。
          </p>
          <p id="engine-status" class="status" role="status" aria-live="polite"></p>
        </section>

        <!-- 语言与显示 -->
        <section class="sec" id="sec-language" data-section="language" aria-labelledby="sec-language-title">
          <div class="sec-head"><h2 id="sec-language-title">语言与显示</h2></div>
          <div class="group">
            <div class="field">
              <label class="lab" for="target-lang">目标语言<small>译文使用的语言</small></label>
              <select id="target-lang"></select>
            </div>
            <div class="field">
              <label class="lab" for="source-lang">源语言<small>「自动检测」按页面文字判断</small></label>
              <select id="source-lang"></select>
            </div>
            <div class="field">
              <label class="lab" for="display-mode">显示模式<small>仅译文会隐藏原文</small></label>
              <select id="display-mode"></select>
            </div>
          </div>
          <p id="target-hint" class="hint">
            「仅译文」只显示译文（原文被隐藏，按 Alt+T 可还原）；「双语对照」在每段原文下方插入译文。
            链接：整段几乎就是一个链接时（例如整行标题、作者署名行），译文里的链接<strong>仍可点击</strong>；
            含<strong>多个链接</strong>的段落与文字占主的正文段落里，链接<strong>仍可能失去下划线与可点击</strong>——
            要读原文请按 Alt+T 还原，或在弹窗里切「双语对照」后重新翻译。
            改动即时保存；已经翻译过的页面要重新翻译才会换过来。
          </p>
          <p id="language-status" class="status" role="status" aria-live="polite"></p>
        </section>

        <!-- 缓存与请求 -->
        <section class="sec" id="sec-cache" data-section="cache" aria-labelledby="sec-cache-title">
          <div class="sec-head"><h2 id="sec-cache-title">缓存与请求</h2></div>
          <div class="group">
            <div class="grow2">
              <div class="lab">清除翻译缓存<span>同时清掉会话层与持久层，之后所有页面都要重翻一次</span></div>
              <button id="clear-cache" class="ghost tiny" type="button">清除</button>
            </div>
          </div>
          <p class="hint">
            缓存里存的是原文与译文，不含 API Key。「清除」会<strong>同时清掉会话层与持久层</strong>两层缓存，
            清完后所有页面都要重新翻译一次（报出的条数是两层合计）。
          </p>
          <p id="cache-status" class="status" role="status" aria-live="polite"></p>
        </section>

        <!-- 隐私 -->
        <section class="sec" id="sec-privacy" data-section="privacy" aria-labelledby="sec-privacy-title">
          <div class="sec-head"><h2 id="sec-privacy-title">隐私</h2></div>
          <p class="sec-desc">逐条写清边界：本地存储、零网络请求、只采集可见文本、授权按需申请。</p>
          <ul class="privacy">
            <li>
              <strong>API Key 只存在本机</strong>（<code>chrome.storage.local</code>）：
              <strong>不上传、不同步</strong>、不写入日志。档案编辑框的 Key 输入框<strong>永远从空开始</strong>
              （留空保存即保留原 Key），密钥不会渲染进本页 DOM。发给内容脚本的设置是<strong>类型级投影</strong>——
              投影结果里每个档案都没有这个字段，下游代码拿不到它；内容脚本又运行在浏览器的 isolated world，
              页面脚本读不到它的内存。
            </li>
            <li>
              <strong>除翻译请求本身外，不发起任何网络请求</strong>：不采集浏览数据，不做任何统计上报。
            </li>
            <li>
              只有网页里<strong>可见</strong>的文本才会被送去翻译；不可见区域与
              <code>contenteditable</code> 可编辑区域（你正在写、还没保存的草稿）一律不采集。
            </li>
            <li>
              每个档案接口地址的访问权限<strong>只在你点该档案的「保存档案」时</strong>按需申请，
              授权范围限定为那个地址的域名；免费引擎不需要额外授权。
            </li>
          </ul>
          <details>
            <summary>密钥隔离做到哪一步（如实说明）</summary>
            <p>
              这是"字段隔离 + isolated world"，<strong>不是内存级隔离</strong>——读取设置的瞬间，
              密钥仍会随整份设置经过扩展自己的 isolated world 堆。彻底的结构性隔离要把密钥拆成
              独立存储键，属后续工作。
            </p>
          </details>
        </section>
      </main>
    </div>

    <script type="module" src="./options.ts"></script>
  </body>
</html>
```

> **注意**：Task 2 改好的 `#target-hint` 那句话在这里**逐字保留**，并且本任务 Step 13 追加一条断言：新文案里**不许**再出现「保存语言与显示」（那个按钮在同一个提交里被删掉了，留着这句就是在指一个不存在的东西）。
> **隐私那几条**里，既有用例按子串断言的字面量**必须保留**：`API Key 只存在本机`、`不上传、不同步`、`永远从空开始`、`除翻译请求本身外，不发起任何网络请求`、`contenteditable`。
>
> **隐私区块为什么是四条 `<li>` 而不是规格 §3.8 写的"三条"**：`src/options/options.html` 今天有四条承诺，**逐条实测行号**是——
> `:63-71` 第 1 条「API Key 只存在本机」、`:72-74` 第 2 条「除翻译请求本身外，不发起任何网络请求」、
> **`:75-78` 第 3 条「每个档案接口地址的访问权限只在你点该档案的「保存档案」时按需申请…」**、
> `:79-82` 第 4 条「只有网页里可见的文本才会被送去翻译」（`:83` 是 `</ul>`）。
> 上一版计划把这一条写成 `:79-83` 且叫它"第四条"——**行号与序数都错**（`:79-82` 是"只送可见文本"那条），现在按实测值写。
> **它在新版里的位置**：四条按「1 API Key → 2 零网络请求 → 3 只送可见文本 → 4 授权按需申请」重排，所以那句承诺在**新版里是第 4 条**——注意它**不是"新加的第 4 条"**，而是从现状的**第 3 条**原样搬过来的。
> **为什么要保留它**：它是一条**已经发布、用户可见的诚实承诺**，而 `options.test.ts:298-306` 的五个字面量断言**测不出它的消失**。规格 §3.8 的"三条一行式"说的是**版式**（一行一条），不是"删掉一条"。所以本轮**保留全部四条**，只把版式改成一行式；`.sec-desc` 也不再声称"三条"。若将来确实要砍，必须单独确认，不许在改版里顺手删。

- [ ] **Step 11: 建共用工具、区块契约，并把 4 个区块拆出来**

**先写 `dom.ts` 自己的测试**（它是每个区块都依赖的共享件：状态行、拒绝兜底、控件查找。没有直连用例时，它的两条错误路径只能靠调用方间接覆盖，坏了会全线崩）。创建 `tests/options/dom.test.ts`：

```ts
// tests/options/dom.test.ts
/**
 * @vitest-environment jsdom
 *
 * `dom.ts` 是**每个区块都依赖**的共享件。这里给它的错误路径直连用例：
 * - `runSafely` 的拒绝必须变成状态行里的一句话（否则就是一次未处理拒绝）；
 * - `requireWithin` 找不到控件时必须当场抛错（选择器写错要立刻炸，不能静默返回空）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { element, fillSelect, requireWithin, runSafely, setStatus } from '../../src/options/dom';

/** 造一条状态行挂进 body（`setStatus` / `runSafely` 都只认这个元素）。 */
function statusLine(): HTMLElement {
  const line = document.createElement('p');
  document.body.append(line);
  return line;
}

/** 让已经排队的微任务跑完。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('dom：状态行、拒绝兜底、控件查找', () => {
  it('setStatus 写 data-kind 与文本，且一律走 textContent（尖括号只是字符）', () => {
    const line = statusLine();
    setStatus(line, 'err', '<b>不是 HTML</b>');
    expect(line.dataset.kind).toBe('err');
    expect(line.textContent).toBe('<b>不是 HTML</b>');
    expect(line.children).toHaveLength(0);
  });

  it('runSafely 把拒绝格式化成「前缀：原因」，兑现的 promise 一个字节都不写', async () => {
    const line = statusLine();
    runSafely(line, '保存失败', async () => {
      throw new Error('存储写入失败');
    });
    await settle();
    expect(line.dataset.kind).toBe('err');
    expect(line.textContent).toBe('保存失败：存储写入失败');

    // 成功路径不该碰状态行：先自己写一句，跑一个成功的 runSafely，那句必须原样留着。
    setStatus(line, 'ok', '已保存');
    runSafely(line, '保存失败', async () => undefined);
    await settle();
    expect(line.textContent).toBe('已保存');
    expect(line.dataset.kind).toBe('ok');
  });

  it('requireWithin 找不到元素时抛错，并把选择器写进消息', () => {
    const root = element('div', 'profile-editor');
    root.append(element('span', 'profile-label', '名字'));
    expect(requireWithin(root, '.profile-label').textContent).toBe('名字');
    expect(() => requireWithin(root, '.missing')).toThrow('.missing');
  });

  it('fillSelect 重建选项并选中匹配的那一项（选项清单不手抄）', () => {
    const select = document.createElement('select');
    select.append(new Option('旧的', 'old'));
    fillSelect(select, [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }], 'b');
    expect(Array.from(select.options).map((option) => [option.value, option.textContent])).toEqual([
      ['a', '甲'],
      ['b', '乙'],
    ]);
    expect(select.value).toBe('b');
  });
});
```

Run: `npx vitest run tests/options/dom.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/options/dom"`

然后创建 `src/options/dom.ts`：

```ts
// src/options/dom.ts
//
// 设置页各区块共用的最小 DOM 工具。**这里不碰存储**：写存储一律走 `store.ts`，
// 本文件只负责"造节点 / 填下拉 / 写状态行 / 兜住拒绝"。

export type StatusKind = 'ok' | 'err' | 'pending';

/** 状态行的唯一出口：`data-kind` 决定颜色，文案一律 `textContent`（规格 §7：不许 innerHTML）。 */
export function setStatus(element: HTMLElement, kind: StatusKind, message: string): void {
  element.dataset.kind = kind;
  element.textContent = message;
}

export function describe(raw: unknown): string {
  return raw instanceof Error ? raw.message : String(raw);
}

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function fillSelect(
  select: HTMLSelectElement,
  entries: ReadonlyArray<{ value: string; label: string }>,
  value: string,
): void {
  select.textContent = '';
  for (const entry of entries) {
    const option = document.createElement('option');
    option.value = entry.value;
    option.textContent = entry.label;
    option.selected = entry.value === value;
    select.append(option);
  }
}

export function requireWithin<T extends Element>(root: Element, selector: string): T {
  const found = root.querySelector(selector);
  if (found === null) throw new Error(`区块里缺控件：${selector}`);
  return found as T;
}

/**
 * 任何没被就地处理的拒绝都要变成用户看得见的一句话：没有它，一次失败的 `await`
 * 会留下一个未处理的拒绝，界面停在半初始化状态——控件看着能点、点下去没反应。
 */
export function runSafely(status: HTMLElement, prefix: string, run: () => Promise<void>): void {
  void run().catch((raw: unknown) => {
    setStatus(status, 'err', `${prefix}：${describe(raw)}`);
  });
}
```

Run: `npx vitest run tests/options/dom.test.ts`
Expected: PASS —— **4 条用例**

创建 `src/options/section.ts`：

```ts
// src/options/section.ts
//
// 设置页的区块契约。八个区块各一个模块，`options.ts` 只负责把它们装配起来。
//
// `bind` 与 `mount` 必须分成两段：**监听器要在第一个 `await` 之前挂好**。`loadSnapshot()`
// 有明确的拒绝路径（存储里是更高版本、存储读写失败），等读完再挂的话，那些拒绝会让界面变成
// 一个"看着能点、其实没有任何监听器"的死页面，连重试都点不了（`options.ts` 里那条注释
// 与 `tests/options/options.test.ts` 的版本闸门用例都是这件事的见证）。
import type { Settings } from '../shared/settings';

export type SectionId =
  | 'engine'
  | 'language'
  | 'shortcuts'
  | 'glossary'
  | 'site-rules'
  | 'prompt'
  | 'cache'
  | 'privacy';

export interface SectionContext {
  /** 当前内存快照；`start()` 读出设置之前是 null。 */
  settings(): Settings | null;
  /**
   * 重读存储并把快照对齐。**并发窗口下刷新界面用**（例如删除档案时发现它已经被别处删掉，
   * 界面必须刷成存储的真实样子）。读的入口只有存储层一处，区块不许自己 `loadSettings()`
   * 之后偷偷改快照——两处各改一份就多了一条漂移路径。
   */
  reload(): Promise<void>;
  /**
   * 单字段即时保存（规格 §4.1）。**不抛**：成功/失败都写进这一区块的状态行
   * （`.status` + `data-kind` 契约），返回是否成功。
   *
   * 调用方拿这个布尔值去决定"要不要把控件拨回真正生效的那一档"——写失败时把用户刚选的
   * 值留在界面上，等于界面撒谎。
   */
  save(status: HTMLElement, prefix: string, patch: Partial<Settings>, okMessage?: string): Promise<boolean>;
}

export interface Section {
  /** 与 `options.html` 里 `[data-section="<id>"]`、`[data-nav="<id>"]` 一一对应。 */
  readonly id: SectionId;
  /** 区块标题，与页面里的 `<h2>` 逐字一致（搜索会用它）。 */
  readonly title: string;
  /**
   * 搜索别名（规格 §4.2）。与区块定义**放在一起**，避免两处漂移。
   *
   * 别名必须指向**真正含该字段**的区块：「密钥 / API Key」归翻译引擎（Key 在那里），
   * 「词库 / 专有名词」归术语表——搜「密钥」跳出术语表比搜不到更糟。
   */
  readonly aliases: readonly string[];
  /** 挂监听器 + 填静态选项。**必须在第一个 await 之前跑完**。 */
  bind(context: SectionContext): void;
  /** 读设置之后的渲染（填当前值、渲染动态列表）。失败由 `options.ts` 兜住。 */
  mount(context: SectionContext): void | Promise<void>;
}
```

创建 `src/options/sections/engine.ts`（**搬家**：行为一行不改，只换上下文来源）：

```ts
// src/options/sections/engine.ts
//
// §3.1 翻译引擎：档案列表、展开编辑、测试连接、删除、服务商模板、Key 显示切换。
//
// 本文件由 `options.ts` 原样搬来（2026-09-18 设置页改版）。搬家的规矩是**行为一行不改**：
// `tests/options/options.test.ts` 里那 20 条引擎用例是验收标准，一条都不许红。
// 唯一的结构性变化是"设置从哪来、状态写到哪去"：`settings` → `ctx.settings()`，
// `saveSettings(...)` → `ctx.save(...)`（后者自带"排队 + 写前重读 + 只覆盖本次给的字段"）。
//
// 隐私硬规矩（与搬家前逐字相同）：档案编辑框的 API Key 输入框**永远从空开始、不回填**，
// 留空保存 = 保留原 Key；密钥只进 `<input>.value` 属性的编辑会话，绝不写进行的任何文本，
// 也不进任何 `title` / 文本节点。
import { getEngine, DEFAULT_ENGINE_ID } from '../../engines/registry';
import { toEngineError } from '../../engines/types';
import {
  hasHostPermission,
  originPattern,
  requestHostPermission,
} from '../../shared/host-permission';
import {
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  createProfileId,
  isAllowedBaseUrl,
  loadSettings,
  resolveEngine,
  type EngineProfile,
  type Settings,
} from '../../shared/settings';
import { describe, element, fillSelect, requireWithin, runSafely, setStatus } from '../dom';
import type { Section, SectionContext } from '../section';

const profilesList = document.getElementById('profiles') as HTMLElement;
const addProfileButton = document.getElementById('add-profile') as HTMLButtonElement;
const engineHint = document.getElementById('engine-hint') as HTMLElement;
const engineStatus = document.getElementById('engine-status') as HTMLElement;

/** 新增档案的草稿在 `expandedId` 里的哨兵值；它不是合法 id（生成函数带 `p-` 前缀），不会撞车。 */
const NEW_DRAFT_ID = '__new__';

/** 测试连接发出去的文本：够短（一次请求几乎不花额度），又能验证整条链路。 */
const TEST_TEXT = 'hello';

/**
 * 测试连接的超时。这是用户按下去就盯着看的一次交互，不能像页面翻译那样给 60 秒；
 * 20 秒足够一次真实往返 + 调度器/引擎的一轮退避，再久用户只会以为按钮坏了。
 */
const TEST_TIMEOUT_MS = 20_000;

/** 当前展开编辑的档案 id（或 NEW_DRAFT_ID）；null = 全部收起。一次只展开一个。 */
let expandedId: string | null = null;

/** 档案编辑表单的原始值。保存与测试连接共用它，保证两条路走的是同一份输入。 */
interface ProfileFormValues {
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

function rowById(id: string): HTMLElement | null {
  for (const child of Array.from(profilesList.children)) {
    if (child instanceof HTMLElement && child.dataset.profileId === id) return child;
  }
  return null;
}

/** 读展开区里的表单值。地址/模型名/名字去掉首尾空白；Key 原样（判"填没填"时才 trim）。 */
function readEditor(editor: Element): ProfileFormValues {
  return {
    label: (requireWithin<HTMLInputElement>(editor, '.profile-label')).value.trim(),
    baseUrl: (requireWithin<HTMLInputElement>(editor, '.profile-base-url')).value.trim(),
    model: (requireWithin<HTMLInputElement>(editor, '.profile-model-name')).value.trim(),
    apiKey: requireWithin<HTMLInputElement>(editor, '.profile-api-key').value,
  };
}

/**
 * 校验一个档案的表单值。地址判据与 `shared/settings.ts` 的反序列化边界**完全同一份**
 * （`isAllowedBaseUrl`）：两边各写一套时，设置页会一边说"保存成功"、一边被存储层
 * 悄悄改写，用户永远查不出为什么没生效。
 */
function validateProfileForm(values: ProfileFormValues): string | null {
  if (values.label.length === 0) return '请填写档案名字';
  if (values.baseUrl.length === 0) return '请填写接口地址（Base URL）';
  if (originPattern(values.baseUrl) === undefined) {
    return `接口地址不是合法的 URL：${values.baseUrl}（示例：https://api.openai.com/v1）`;
  }
  if (!isAllowedBaseUrl(values.baseUrl)) {
    return '接口地址必须用 https://；只有本机回环地址（localhost / 127.0.0.1 / ::1）可以用 http://';
  }
  return null;
}

interface HostPermissionResult {
  state: 'granted' | 'denied';
  /** 权限 API 自己抛错时的原因（不是手势、manifest 没声明该模式……），如实带给用户。 */
  detail?: string;
}

/**
 * 确认一个档案的端点已被授权。**必须在用户手势的调用栈里调用**：Chrome 只在手势中弹授权框，
 * 而「保存档案」「测试连接」都是用户点下来的。已经授权过的不再弹框（先问 `contains`）。
 */
async function ensureHostPermission(baseUrl: string): Promise<HostPermissionResult> {
  const pattern = originPattern(baseUrl);
  if (pattern === undefined) return { state: 'denied', detail: `接口地址不是合法的 URL：${baseUrl}` };
  try {
    if (await hasHostPermission(pattern)) return { state: 'granted' };
    const granted = await requestHostPermission(pattern);
    return granted ? { state: 'granted' } : { state: 'denied' };
  } catch (raw) {
    // 不能当成"已授权"（那会让用户拿到一个必然被浏览器拦下的请求），也不能静默。
    return { state: 'denied', detail: describe(raw) };
  }
}

/** 未授权时给用户看的后果说明：说清"会怎样"和"怎么办"。 */
function deniedHint(result: HostPermissionResult): string {
  const reason = result.detail === undefined ? '' : `（${result.detail}）`;
  return `未授权访问该地址，翻译请求会被浏览器拦下${reason}。需要授权时再点一次「保存档案」并在弹窗里选「允许」。`;
}

/* ------------------------------------------------------------------ 渲染 */

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

  const providerField = element('label', 'field');
  const providerSelect = document.createElement('select');
  providerSelect.className = 'profile-provider';
  fillSelect(
    providerSelect,
    PROVIDER_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
    'custom',
  );
  providerField.append(element('span', 'lab', '服务商模板'), providerSelect);
  editor.append(providerField);

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
  editor.append(baseUrlField);

  const modelField = element('label', 'field');
  modelField.append(element('span', 'lab', '模型名'), Object.assign(document.createElement('input'), {
    className: 'profile-model-name',
    type: 'text',
    value: profile?.model ?? '',
    placeholder: 'gpt-4o-mini',
    autocomplete: 'off',
    spellcheck: false,
  }));
  editor.append(modelField);

  const keyField = element('label', 'field');
  keyField.append(element('span', 'lab', 'API Key'));
  const keyRow = element('span', 'key-row');
  keyRow.append(
    Object.assign(document.createElement('input'), {
      className: 'profile-api-key',
      type: 'password',
      // 隐私硬规矩：value 恒为空。存储里的 Key 不回填、不进 DOM；留空保存 = 保留原 Key。
      value: '',
      placeholder: profile === undefined ? 'sk-…' : '不修改则保留当前 Key',
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

  const actions = element('div', 'actions');
  const saveButton = element('button', 'primary', '保存档案');
  saveButton.type = 'button';
  saveButton.dataset.action = 'save-profile';
  const testButton = element('button', 'ghost', '测试连接');
  testButton.type = 'button';
  testButton.dataset.action = 'test-profile';
  actions.append(saveButton, testButton);
  if (profile !== undefined) {
    const deleteButton = element('button', 'link-danger', '删除档案');
    deleteButton.type = 'button';
    deleteButton.dataset.action = 'delete-profile';
    actions.append(deleteButton);
  }
  editor.append(actions);
  return editor;
}

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

  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'profile-summary';
  summary.dataset.action = 'toggle';
  summary.setAttribute('aria-expanded', String(expanded));
  const shownBaseUrl = profile !== undefined && profile.baseUrl.length > 0 ? profile.baseUrl : '未填接口地址';
  const shownModel = profile !== undefined && profile.model.length > 0 ? profile.model : '未填模型名';
  const line = element('span', 'line');
  line.append(element('span', 'name', isNew ? '新档案（未保存）' : profile?.label ?? ''));
  if (!isNew && snapshot.engineId === id) {
    line.append(element('span', 'badge', '使用中'));
  }
  const grow = element('span', 'grow');
  grow.append(
    line,
    element('span', 'meta', isNew ? '未填接口地址 · 未填模型名' : `${shownBaseUrl} · ${shownModel}`),
  );
  summary.append(grow);
  row.append(summary);
  if (expanded) {
    row.append(buildEditor(id, isNew ? undefined : profile));
  }
  return row;
}

function renderProfiles(ctx: SectionContext): void {
  if (ctx.settings() === null) return;
  // 展开目标已不存在（比如刚删掉它）：收起，别让下一次渲染挂在一个幽灵 id 上。
  if (expandedId !== null && expandedId !== NEW_DRAFT_ID && !ctx.settings()!.profiles.some((p) => p.id === expandedId)) {
    expandedId = null;
  }
  profilesList.textContent = '';
  for (const profile of ctx.settings()!.profiles) {
    profilesList.append(buildProfileRow(ctx, profile.id));
  }
  if (expandedId === NEW_DRAFT_ID) {
    profilesList.append(buildProfileRow(ctx, NEW_DRAFT_ID));
  }
}

/** 档案区顶部的说明：当前在用哪一档（选择器的真相在弹窗，这里如实指路）。 */
function renderEngineHint(ctx: SectionContext): void {
  const snapshot = ctx.settings();
  if (snapshot === null) return;
  const { engine } = resolveEngine(snapshot);
  const selected = snapshot.profiles.find((profile) => profile.id === snapshot.engineId);
  if (engine.needsKey && selected !== undefined) {
    engineHint.textContent = `当前在用档案「${selected.label}」。点下面的档案行展开编辑；在弹窗的「翻译引擎」里按名字切换。`;
    return;
  }
  engineHint.textContent = '当前在用免费接口（零配置）。档案配好后，在弹窗的「翻译引擎」下拉里按名字选中才会生效。';
}

/* ------------------------------------------------------------------ 行为 */

/**
 * 保存（或新建）一个档案。
 *
 * 写之前**重新读一次**存储：`saveSettings` 是整份覆盖，Key 留空 = 保留**存储里当前**的那份
 * （不是页面打开时的快照）。真正的写回走 `ctx.save`，只交 `profiles` 这一个字段——
 * engineId 因此天然保持不动（选择档案是弹窗的职责，本页从不偷改它）。
 */
async function handleSaveProfile(ctx: SectionContext, id: string): Promise<void> {
  const editor = rowById(id)?.querySelector('.profile-editor');
  if (editor === null || editor === undefined) {
    setStatus(engineStatus, 'err', '档案编辑区不在页面上，请重新展开该档案');
    return;
  }
  const values = readEditor(editor);
  const invalid = validateProfileForm(values);
  if (invalid !== null) {
    setStatus(engineStatus, 'err', invalid);
    return;
  }

  // 用户手势里申请这个档案自己的 origin（Chrome 要求手势，见 host-permission）。
  const permission = await ensureHostPermission(values.baseUrl);

  let latest: Settings;
  try {
    latest = await loadSettings();
  } catch (raw) {
    setStatus(engineStatus, 'err', `保存前读取设置失败：${describe(raw)}`);
    return;
  }

  const isNew = id === NEW_DRAFT_ID;
  let savedId: string;
  let profiles: EngineProfile[];
  if (isNew) {
    savedId = createProfileId();
    profiles = [...latest.profiles, { id: savedId, ...values }];
  } else {
    savedId = id;
    const existing = latest.profiles.find((profile) => profile.id === id);
    // Key 留空 = 保留存储里当前的那份（不是页面打开时的快照——整份覆盖的老坑同一个）。
    const apiKey = values.apiKey.trim().length > 0 ? values.apiKey : existing?.apiKey ?? '';
    const nextProfile: EngineProfile = { id: savedId, label: values.label, baseUrl: values.baseUrl, model: values.model, apiKey };
    profiles = existing === undefined ? [...latest.profiles, nextProfile] : latest.profiles.map((p) => (p.id === id ? nextProfile : p));
  }

  const saved = await ctx.save(engineStatus, '设置未能保存', { profiles });
  if (!saved) return;

  expandedId = savedId;
  renderProfiles(ctx);
  renderEngineHint(ctx);

  if (permission.state === 'denied') {
    // Key 与地址都已经存下来了：用户可能只是暂时不想授权。
    setStatus(engineStatus, 'err', `已保存档案「${values.label}」。${deniedHint(permission)}`);
    return;
  }
  const where = `，并已授权访问 ${originPattern(values.baseUrl) ?? values.baseUrl}`;
  setStatus(engineStatus, 'ok', `已保存档案「${values.label}」${where}。在弹窗的「翻译引擎」里选它即可使用。`);
}

/**
 * 测试连接：**真的发一次翻译请求**，走的是生产引擎代码本身。测的是**这一行正在编辑的
 * 档案**（表单当前值，未保存也算），不是全局某份配置——多个档案时代"测一下"必须说得清测的是谁。
 */
async function handleTestProfile(ctx: SectionContext, id: string): Promise<void> {
  const editor = rowById(id)?.querySelector('.profile-editor');
  if (editor === null || editor === undefined) {
    setStatus(engineStatus, 'err', '档案编辑区不在页面上，请重新展开该档案');
    return;
  }
  const values = readEditor(editor);
  const invalid = validateProfileForm(values);
  if (invalid !== null) {
    setStatus(engineStatus, 'err', invalid);
    return;
  }

  const permission = await ensureHostPermission(values.baseUrl);
  if (permission.state === 'denied') {
    setStatus(engineStatus, 'err', deniedHint(permission));
    return;
  }

  // Key 输入框留空时测的是**存储里已存的**那份（和"保存"同一语义）；新草稿没存过就是空，
  // 引擎会给出可行动的 AUTH 提示。
  const storedKey = ctx.settings()?.profiles.find((profile) => profile.id === id)?.apiKey ?? '';
  const apiKey = values.apiKey.trim().length > 0 ? values.apiKey : storedKey;
  const { engine, config } = resolveEngine({
    engineId: id,
    profiles: [{ id, label: values.label, baseUrl: values.baseUrl, model: values.model, apiKey }],
  });

  setStatus(engineStatus, 'pending', `正在用档案「${values.label}」翻译一次「${TEST_TEXT}」…`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const [translation] = await engine.translate(
      {
        texts: [TEST_TEXT],
        from: 'auto',
        // 目标语言取当前快照（即时保存之后，下拉里选的就是存储里的那一份）。
        to: ctx.settings()?.targetLang ?? DEFAULT_SETTINGS.targetLang,
        signal: controller.signal,
      },
      config,
    );
    setStatus(engineStatus, 'ok', `连接成功：${TEST_TEXT} → ${translation ?? ''}`);
  } catch (raw) {
    // 错误码要显示出来（AUTH / RATE_LIMIT / NETWORK……）：它是用户判断"该改 Key 还是
    // 该稍后重试"的唯一依据，只给一句自然语言会把这两件事混在一起。
    const error = toEngineError(raw);
    setStatus(engineStatus, 'err', `连接失败（${error.code}）：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 删除一个档案。若删的正是**当前在用**的那个，`engineId` 明确回落到免费接口并说明——
 * 绝不能留下一个指向不存在档案的 id。（为什么回落免费引擎而不是"下一个档案"：下一个
 * 档案可能没填 Key、地址可能没授权，删一个档案不该让用户突然翻译失败。）
 */
async function handleDeleteProfile(ctx: SectionContext, id: string): Promise<void> {
  let latest: Settings;
  try {
    latest = await loadSettings();
  } catch (raw) {
    setStatus(engineStatus, 'err', `删除前读取设置失败：${describe(raw)}`);
    return;
  }
  const target = latest.profiles.find((profile) => profile.id === id);
  if (target === undefined) {
    // 别处已经删过（并发窗口）：如实说，并刷新到存储的真实列表，不静默"删除成功"。
    expandedId = null;
    await renderFromStorage(ctx);
    setStatus(engineStatus, 'err', '该档案已经不在了（可能在别处被删除），列表已刷新。');
    return;
  }
  const wasCurrent = latest.engineId === id;
  const remaining = latest.profiles.filter((profile) => profile.id !== id);

  const saved = await ctx.save(
    engineStatus,
    '设置未能保存',
    { profiles: remaining, engineId: wasCurrent ? DEFAULT_ENGINE_ID : latest.engineId },
  );
  if (!saved) return;

  if (expandedId === id) expandedId = null;
  renderProfiles(ctx);
  renderEngineHint(ctx);
  setStatus(
    engineStatus,
    'ok',
    wasCurrent
      ? `已删除当前在用的档案「${target.label}」，引擎已回落到「${getEngine(DEFAULT_ENGINE_ID).name}」，请在弹窗里重新选择。`
      : `已删除档案「${target.label}」。`,
  );
}

/** 把界面刷成**存储里的真实样子**（别处已经删掉/改过这个档案时的并发窗口用）。 */
async function renderFromStorage(ctx: SectionContext): Promise<void> {
  // 读的入口只有存储层一处（`store.ts` 的 `reload`）：这里刻意不自己 `loadSettings()` 之后
  // 偷偷改快照——那是存储层的职责，两处各改一份就又多了一条漂移路径。
  try {
    await ctx.reload();
  } catch (raw) {
    setStatus(engineStatus, 'err', `列表刷新失败：${describe(raw)}`);
    return;
  }
  renderProfiles(ctx);
  renderEngineHint(ctx);
}

/** 显示 / 隐藏某个档案编辑区的 API Key。只改该行的 `type` 与按钮文案，值不动（更不会复制到别处）。 */
function toggleKeyVisibility(button: HTMLElement): void {
  const editor = button.closest('.profile-editor');
  if (editor === null) return;
  const input = requireWithin<HTMLInputElement>(editor, '.profile-api-key');
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  button.textContent = hidden ? '隐藏' : '显示';
  button.setAttribute('aria-pressed', String(hidden));
  button.title = hidden ? '隐藏 API Key' : '显示 API Key';
}

/**
 * 服务商模板 = 编辑表单的**填写捷径**：选中即把接口地址与模型名填进**这一行**，
 * 用户还没点保存，改回来零成本。不碰 API Key（那是用户自己的凭据）。
 * 只挂在下拉自己的 change 上——展开既有档案时**永远不重放**预设（否则会把用户存过
 * 的地址/模型悄悄改回模板值）。
 */
function applyProviderTemplate(editor: Element): void {
  const select = requireWithin<HTMLSelectElement>(editor, '.profile-provider');
  const preset = PROVIDER_PRESETS.find((entry) => entry.id === select.value);
  if (preset === undefined || preset.baseUrl === undefined || preset.model === undefined) return;
  requireWithin<HTMLInputElement>(editor, '.profile-base-url').value = preset.baseUrl;
  requireWithin<HTMLInputElement>(editor, '.profile-model-name').value = preset.model;
}

export const engineSection: Section = {
  id: 'engine',
  title: '翻译引擎',
  aliases: ['引擎', '服务商', '档案', '接口地址', 'baseUrl', '模型', 'API Key', '密钥', 'key', '测试连接'],

  bind(ctx: SectionContext): void {
    // 档案列表是动态渲染的，行内按钮一律走**容器上的事件委托**（data-action 派发），
    // 每次重渲染不用重新挂监听器。
    profilesList.addEventListener('click', (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.classList.contains('profile-toggle-key')) {
        toggleKeyVisibility(target);
        return;
      }
      const row = target.closest('[data-profile-id]');
      if (!(row instanceof HTMLElement)) return;
      const id = row.dataset.profileId as string;
      switch (target.dataset.action) {
        case 'toggle':
          if (ctx.settings() === null) return;
          expandedId = expandedId === id ? null : id;
          renderProfiles(ctx);
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
      }
    });
    profilesList.addEventListener('change', (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.classList.contains('profile-provider')) {
        const editor = target.closest('.profile-editor');
        if (editor !== null) applyProviderTemplate(editor);
      }
    });
    profilesList.addEventListener('input', (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      // 地址/模型名被手打 → 这一行按"自定义"算：模板下拉翻回 custom，而不是留着个
      // 已经说谎的「DeepSeek」。预设永远不许反过来覆盖用户敲进去的值。
      if (target.classList.contains('profile-base-url') || target.classList.contains('profile-model-name')) {
        const editor = target.closest('.profile-editor');
        if (editor !== null) requireWithin<HTMLSelectElement>(editor, '.profile-provider').value = 'custom';
      }
    });

    addProfileButton.addEventListener('click', () => {
      if (ctx.settings() === null) {
        setStatus(engineStatus, 'err', '设置还没读出来，请稍候重试');
        return;
      }
      if (expandedId !== NEW_DRAFT_ID) {
        expandedId = NEW_DRAFT_ID;
        renderProfiles(ctx);
      }
    });
  },

  mount(ctx: SectionContext): void {
    renderProfiles(ctx);
    renderEngineHint(ctx);
  },
};
```

> **三处必须与上面逐字一致的地方，实现时别"顺手改进"**：
> ① `row` 的 class 是 `profile-row item`（两个类都要：`profile-row` 是测试契约选择器，`item` 给卡片样式）；
> ② 编辑器的行内按钮 class 从 `ghost profile-delete` 改成 `link-danger`（规格 §2：删除是红色文字按钮）——测试按 `[data-action="delete-profile"]` 找它，不看 class；
> ③ `renderFromStorage` 走 `ctx.reload()`，**不是** `loadSettings()` + 自己改快照：读的入口只有存储层一处，两处各改一份就多一条漂移路径。

> **`SectionContext` 的定义只出现一次**，就在上面 `section.ts` 那一块里（含 `settings()` / `reload()` / `save()` 三个成员）。**不要在这份计划或代码里再抄第二份**——审查发现过一份重复定义（一份带 `reload`、一份不带），那种重复迟早会让某个调用点拿到没有 `reload` 的那一份，而 `npm run typecheck` 只会在下游炸（`Property 'reload' does not exist`），排查成本远高于删掉几行。`options.ts` 里的 `const context: SectionContext` **必须**把三个成员都实现（见 Task 3 Step 11 的 `options.ts` 全文，`reload: async () => { await loadSnapshot(); }` 就在里面）。

创建 `src/options/sections/language.ts`：

```ts
// src/options/sections/language.ts
//
// §3.2 语言与显示：目标语言、源语言（新）、显示模式。三个都是**选择类 → change 即存**（§4.1），
// 「保存语言与显示」按钮随本轮改版一起消失。
import { LANGUAGES } from '../../core/lang';
import { DISPLAY_MODES, type DisplayMode, type Settings } from '../../shared/settings';
import { fillSelect, setStatus } from '../dom';
import type { Section, SectionContext } from '../section';

const targetLangSelect = document.getElementById('target-lang') as HTMLSelectElement;
const sourceLangSelect = document.getElementById('source-lang') as HTMLSelectElement;
const displayModeSelect = document.getElementById('display-mode') as HTMLSelectElement;
const status = document.getElementById('language-status') as HTMLElement;

type FieldName = 'targetLang' | 'sourceLang' | 'displayMode';

/** 显式逐个构造增量：`{ [field]: value }` 这种计算属性在 TS 里会被放宽成 `{[x: string]: string}`。 */
function patchFor(field: FieldName, value: string): Partial<Settings> {
  if (field === 'targetLang') return { targetLang: value };
  if (field === 'sourceLang') return { sourceLang: value };
  return { displayMode: value as DisplayMode };
}

function bindSelect(ctx: SectionContext, select: HTMLSelectElement, field: FieldName, label: string): void {
  select.addEventListener('change', () => {
    void (async () => {
      const ok = await ctx.save(status, `保存${label}失败`, patchFor(field, select.value));
      if (ok) return;
      // 写失败（存储里是更高版本、读写失败）时把控件拨回**真正生效**的那一档：
      // 留在用户刚选的值上等于界面撒谎。
      const current = ctx.settings();
      if (current !== null) select.value = current[field];
    })();
  });
}

export const languageSection: Section = {
  id: 'language',
  title: '语言与显示',
  aliases: ['目标语言', '源语言', '显示模式', '仅译文', '双语对照', '翻译成', '语言'],

  bind(ctx: SectionContext): void {
    bindSelect(ctx, targetLangSelect, 'targetLang', '目标语言');
    bindSelect(ctx, sourceLangSelect, 'sourceLang', '源语言');
    bindSelect(ctx, displayModeSelect, 'displayMode', '显示模式');
  },

  mount(ctx: SectionContext): void {
    const current = ctx.settings();
    if (current === null) return;
    fillSelect(
      targetLangSelect,
      LANGUAGES.map((lang) => ({ value: lang.code, label: lang.label })),
      current.targetLang,
    );
    // 「自动检测」是默认值，也是唯一不需要用户懂语言的选项，排在最前。
    fillSelect(
      sourceLangSelect,
      [{ value: 'auto', label: '自动检测' }, ...LANGUAGES.map((lang) => ({ value: lang.code, label: lang.label }))],
      current.sourceLang,
    );
    fillSelect(displayModeSelect, DISPLAY_MODES, current.displayMode);
  },
};
```

创建 `src/options/sections/cache.ts`：

> **这一块的首行标记故意不带 `// src/options/sections/cache.ts`**：它是这个文件的**中间态**，
> 最终版在 Task 8（那里有一份**带标记**的完整版）。`scripts/sync-plan-code.mjs` 只会把带标记的
> 块刷成仓库当前内容——两个块都带标记时，它会把**两块都**刷成同一份最终文件，计划里就多出一份
> 重复的 cache.ts。中间态这一块与 `options.html` / `options.css` 一样**手工维护**。

```ts
// src/options/sections/cache.ts（中间态：Task 8 换成完整版）
//
// §3.7 缓存与请求。本任务先落地「清除」这一半（行为与搬家前逐字相同：两层一起清、计数报两层合计），
// 三个统计数字、缓存上限与「高级：批量与并发」折叠区在 Task 8 补齐。
import { TranslationCache } from '../../core/cache';
import { chromeArea } from '../../shared/chrome-area';
import { runSafely, setStatus } from '../dom';
import type { Section, SectionContext } from '../section';

const clearCacheButton = document.getElementById('clear-cache') as HTMLButtonElement;
const cacheStatus = document.getElementById('cache-status') as HTMLElement;

/**
 * 清除翻译缓存：删掉**两层**（持久层 + 会话层）全部 `jt:` 前缀的键。
 *
 * 用 `TranslationCache` 而不是自己拼 `jt:` 前缀：缓存的键名、元数据键、形状坏掉的残留
 * 都归它管（`clear()` 就是为这件事写的）。**会话层必须一起清**：翻译读取走 `TieredCache`
 * （先查会话层），只清持久层的话，用户点完"清除"立刻重译页面照样零请求命中——按钮看起来
 * 失灵，报出的条数也系统性少报。
 */
async function handleClearCache(ctx: SectionContext): Promise<void> {
  const maxEntries = ctx.settings()?.cacheMaxEntries;
  const persistent = new TranslationCache(chromeArea(chrome.storage.local), maxEntries);
  const session = new TranslationCache(chromeArea(chrome.storage.session), maxEntries);
  const [persistentBefore, sessionBefore] = await Promise.all([persistent.count(), session.count()]);
  await Promise.all([persistent.clear(), session.clear()]);
  const cleared = persistentBefore + sessionBefore;
  setStatus(cacheStatus, 'ok', cleared === 0 ? '缓存本来就是空的' : `已清除 ${cleared} 条翻译缓存`);
}

export const cacheSection: Section = {
  id: 'cache',
  title: '缓存与请求',
  aliases: ['缓存', '清除缓存', '上限', '并发', '批量'],

  bind(ctx: SectionContext): void {
    clearCacheButton.addEventListener('click', () => runSafely(cacheStatus, '清除缓存失败', () => handleClearCache(ctx)));
  },

  mount(): void {
    // Task 8 在这里渲染三个统计数字与高级项。
  },
};
```

创建 `src/options/sections/privacy.ts`：

```ts
// src/options/sections/privacy.ts
//
// §3.8 隐私。**纯静态区块**：四条一行式的承诺住在 options.html 里，那段「字段隔离 ≠ 内存级
// 隔离」的诚实说明收进 `<details>`，一个字都不删（规格 §3.8、§7）。
//
// 这里保留一个空实现而不是"不注册这个区块"：导航、搜索索引与区块清单一律由 SECTIONS 驱动，
// 少一个就会让"8 组"这个信息架构少一格。`bind` / `mount` 故意什么都不做——它没有可改的字段，
// 也就**不该有**任何控件（规格 §1：不给没有行为的字段做控件）。
import type { Section } from '../section';

export const privacySection: Section = {
  id: 'privacy',
  title: '隐私',
  aliases: ['隐私', '数据', '遥测', '网络请求', '可见文本'],

  bind(): void {
    // 没有可操作的字段。
  },

  mount(): void {
    // 内容全在 options.html 里，静态渲染。
  },
};
```

创建 `src/options/options.ts`（**整体替换** 694 行的那份，只留装配）：

> **注意**：Task 4~8 会各往 `SECTIONS` 里插一项（`shortcuts` 插在 `language` 之后，`glossary`/`site-rules`/`prompt` 插在 `privacy` 之前的对应位置），最终顺序是：engine、language、shortcuts、glossary、site-rules、prompt、cache、privacy。
> **下面这一块是整份文件**（从第一行到最后一行，一次写完；不要再拆成两块——`scripts/sync-plan-code.mjs` 只认带 `// <路径>` 首行标记的那一块，拆成两块时它只会把**第一块**刷成整个文件，第二块就成了重复内容）。

```ts
// src/options/options.ts
//
// 设置页的装配层：读设置、把八个区块挂起来、把全局的失败兜成一句话。**这里不写业务逻辑**——
// 每一组设置的行为都在 `sections/<name>.ts` 里，写存储一律走 `store.ts`。
//
// 结构上刻意保持"两个阶段"：
// 1. `init()`（同步）：先给每个区块 `bind(ctx)` 挂好监听器，**在第一个 await 之前**。
//    `loadSnapshot()` 有明确的拒绝路径（存储里是更高版本、存储读写失败），等读完再挂的话，
//    那些拒绝会让界面停在一个"看着能点、其实没有任何监听器"的死页面上，用户连重试都点不了。
// 2. `start()`（异步）：读设置 → 依次 `mount(ctx)` 渲染。
import { describe, runSafely, setStatus } from './dom';
import { engineSection } from './sections/engine';
import { languageSection } from './sections/language';
import { cacheSection } from './sections/cache';
import { privacySection } from './sections/privacy';
import type { Section, SectionContext } from './section';
import { currentSettings, loadSnapshot, patchSettings } from './store';
import type { Settings } from '../shared/settings';

/**
 * 八个区块，**顺序就是页面顺序与导航顺序**（搜索索引、导航项、`[data-section]` 三者一一对应，
 * `tests/options/search.test.ts` 有一条结构守卫钉住这件事）。导出是给测试用的。
 */
export const SECTIONS: readonly Section[] = [
  engineSection,
  languageSection,
  cacheSection,
  privacySection,
];

/** 全局兜底用的状态行：设置读不出来时，这句话必须写在用户一眼能看到的地方。 */
const engineStatus = document.getElementById('engine-status') as HTMLElement;

/**
 * `SectionContext.save` 的实现：把 `patchSettings` 的成功/失败翻译成状态行里的一句话。
 * 成功默认写「已保存」；失败写 `${prefix}：${原因}` 并返回 false（调用方据此回拨控件）。
 */
async function save(
  status: HTMLElement,
  prefix: string,
  patch: Partial<Settings>,
  okMessage = '已保存',
): Promise<boolean> {
  try {
    await patchSettings(patch);
  } catch (raw) {
    setStatus(status, 'err', `${prefix}：${describe(raw)}`);
    return false;
  }
  setStatus(status, 'ok', okMessage);
  return true;
}

const context: SectionContext = {
  settings: currentSettings,
  reload: async () => {
    await loadSnapshot();
  },
  save,
};

async function start(): Promise<void> {
  await loadSnapshot();
  for (const section of SECTIONS) await section.mount(context);
}

function init(): void {
  for (const section of SECTIONS) section.bind(context);
  runSafely(engineStatus, '设置读取失败', start);
}

init();
```

- [ ] **Step 12: 跑到绿（搬家完成的读数）**

Run: `npx vitest run tests/options/options.test.ts`
Expected: PASS —— **25 条**（29 条里的 4 条 `#save` 用例在 Step 13 之前会红）

> 若此时红的**不是**那 4 条，停下来：说明搬家改变了行为（最常见的是把行内按钮的
> `data-action` 写错、或把 `.profile-editor` 塞到了行外）。逐条对照 Step 2 的契约清单修，
> **不要**改断言。

- [ ] **Step 13: 改 4 条 `#save` 用例（改成等存储写入完成，断言只强不弱）**

`tests/options/options.test.ts:308-321`（「存储版本高于本代码」那条）的后半段改成：

```ts
    pick<HTMLButtonElement>('add-profile').click();
    expect(engineStatus().textContent).toContain('设置还没读出来');

    // 即时保存之后没有「保存」按钮了，改用**改一个下拉**去撞同一个闸：写入口在设置读出来
    // 之前一律不放行，而且存储里那份「版本高于本代码」的设置一个字节都不许被动过。
    const targetLang = pick<HTMLSelectElement>('target-lang');
    targetLang.value = 'en';
    targetLang.dispatchEvent(bubble('change'));
    await waitFor(() => (pick<HTMLElement>('language-status').textContent ?? '').includes('设置还没读出来'));
    expect(pick<HTMLElement>('language-status').dataset.kind).toBe('err');
    expect((await storedSettings()).version).toBe(CURRENT_VERSION + 1);
    expect((await storedSettings()).targetLang).toBeUndefined();
```

`tests/options/options.test.ts` 的「设置页：语言与显示（独立于档案的保存）」整段（`:696-751`）替换成：

```ts
describe('设置页：语言与显示（change 即存，没有保存按钮）', () => {
  it('改这两个下拉即落盘：连改两次不会互相覆盖，档案、Key 与 engineId 一律原样', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ apiKey: 'sk-keep' })],
      targetLang: 'zh-Hans',
      displayMode: 'translated-only',
    });
    await loadOptions();

    // 两次 change **中间不 await**：这就是"改完目标语言顺手改显示模式"的真实序列，
    // 也是写队列存在与否的分水岭——不排队时后一次写会拿旧基线把前一次抹掉。
    const targetLang = pick<HTMLSelectElement>('target-lang');
    targetLang.value = 'en';
    targetLang.dispatchEvent(bubble('change'));
    const displayMode = pick<HTMLSelectElement>('display-mode');
    displayMode.value = 'bilingual';
    displayMode.dispatchEvent(bubble('change'));

    await waitFor(async () => (await storedSettings()).targetLang === 'en');
    await waitFor(async () => (await storedSettings()).displayMode === 'bilingual');
    const stored = await storedSettings();
    expect(stored.engineId).toBe('p-a');
    expect((stored.profiles as Array<Record<string, unknown>>)[0].apiKey).toBe('sk-keep');
    expect(pick<HTMLElement>('language-status').dataset.kind).toBe('ok');
    // Task 2 那条「文案里还有『保存语言与显示』」的断言在**这里反过来**：按钮已经随即时保存
    // 删掉了，文案里不许再指着一个不存在的东西。Task 2 的 `toContain` 请**整条替换**成这一条
    // （不要两处都留，也不要只删不换）。
    expect(pick<HTMLElement>('target-hint').textContent ?? '').not.toContain('保存语言与显示');
  });

  it('免费引擎下改设置：一个宿主权限申请都不发（google 的地址已在 host_permissions 里）', async () => {
    // 档案化之后，"不申请权限"这条断言从保存路径上消失了：没有它，
    // "无条件给当前档案地址申请权限"这类回归不会被任何人发现——免费引擎明明
    // 不需要授权，却每次都弹一个用户看不懂的框。这里钉住：engineId=google 时
    // 改语言，permissions.request 一次都不许被调用。
    await seedSettings({ engineId: 'google', profiles: [profileSeed()] });
    await loadOptions();

    pick<HTMLSelectElement>('target-lang').value = 'ja';
    pick<HTMLSelectElement>('target-lang').dispatchEvent(bubble('change'));
    await waitFor(async () => (await storedSettings()).targetLang === 'ja');

    expect(chromeStub.permissions.requests).toEqual([]);
    // 也不许有任何"顺手授予"：一次授权都不该发生。
    expect([...chromeStub.permissions.grantedOrigins]).toEqual([]);
  });

  it('期间弹窗改过的其它字段不会被旧快照抹掉', async () => {
    await seedSettings({ concurrency: 3 });
    await loadOptions();

    const current = await storedSettings();
    await chromeStub.storage.local.set({ [SETTINGS_KEY]: { ...current, concurrency: 7 } });

    pick<HTMLSelectElement>('target-lang').value = 'ja';
    pick<HTMLSelectElement>('target-lang').dispatchEvent(bubble('change'));
    await waitFor(async () => (await storedSettings()).targetLang === 'ja');

    expect((await storedSettings()).concurrency).toBe(7);
  });
});
```

- [ ] **Step 14: 跑到绿（两种测试一起）**

Run: `npx vitest run tests/options/`
Expected: PASS —— `options.test.ts` **29 条** + `options-css.test.ts` **7 条** + `no-innerhtml.test.ts` **2 条** + `store.test.ts` **6 条** + `dom.test.ts` **4 条**

- [ ] **Step 15: 变异验证**

| 变异 | 期望红在哪一条 |
| --- | --- |
| `options.css` 的 `.primary` 里加回 `color: #fff` | `options-css.test.ts`「颜色只从令牌来」 |
| `options.css` 的 `:root` 把 `--danger` 改成 `#c0342c`（与 popup 差一个字符） | `options-css.test.ts`「共用令牌逐字一致」 |
| 删掉 `@media (max-width: 900px)` 里的 `.nav { position: static }` | `options-css.test.ts`「窄窗口有明确的降级策略」 |
| `.lab small` 加一句 `opacity: 0.7` | `options-css.test.ts`「不许用 opacity」 |
| `sections/engine.ts` 里把 `engineStatus.textContent = …` 改成 `engineStatus.innerHTML = …` | `no-innerhtml.test.ts` |
| `sections/language.ts` 的 `change` 监听换成 `input` | 「改这两个下拉即落盘」（change 事件不再触发任何写入） |
| 把 `options.ts` 的 `for (const section of SECTIONS) section.bind(context)` 删掉 | 版本闸门那条（`#language-status` 永远不出现「设置还没读出来」） |

还原后跑一次 `npx vitest run tests/options/` 确认全绿。

- [ ] **Step 16: 提交**

```bash
git add src/options/options.html src/options/options.css src/options/options.ts \
  src/options/dom.ts src/options/section.ts src/options/sections/ \
  src/popup/popup.css tests/options/harness.ts tests/options/options-css.test.ts \
  tests/options/no-innerhtml.test.ts tests/options/options.test.ts
git commit -m "refactor(options): 设置页骨架（左导航 + 区块契约 + 引擎/语言/缓存/隐私四区块搬家）

- options.ts 694 行拆成 store.ts + dom.ts + section.ts + sections/<name>.ts，入口只做装配
- 语言与显示改为 change 即存，「保存语言与显示」按钮与 #save 一并移除
- 4 条依赖 #save 的用例改成等存储写入完成（含"连改两次不互相覆盖"这条更强的断言）
- 新增样式纪律测试（令牌逐字一致 / 无硬编码颜色 / 无 opacity / 焦点环 / 窄窗口降级）
- 新增源码守卫：设置页不得出现 innerHTML"
```

---

## Task 4: 快捷翻译区块（§3.3）

**Files:**
- Create: `src/options/sections/shortcuts.ts`
- Create: `tests/options/shortcuts.test.ts`
- Modify: `src/options/options.html`（在 `<a class="nav-link" href="#sec-language" …>语言与显示</a>` 之后加导航项；在 `<!-- 缓存与请求 -->` 那个 section 之前插入区块）
- Modify: `src/options/options.ts`（import + `SECTIONS` 插到 `languageSection` 之后）
- Modify: `tests/helpers/chrome-stub.ts`（给 `StubTabs` 加 `created` 与 `create`）

> **这个区块的开关必须真的生效**：`hoverTranslate` / `selectionTranslate` 的消费者是**内容脚本**（`content/index.ts` 的 `applyFeatures`），只写存储不会改变已经打开的页面上挂没挂监听器。弹窗的 `onFeatureToggleChange`（`src/popup/popup.ts:436`）保存后会发一条 `APPLY_SETTINGS` 让页面当场重挂；设置页**必须做同一件事**，否则这里的开关就是"改完没反应"的假控件。
>
> 但设置页**拿不到"当前页面"**：它自己就占着活动标签。所以这里**广播给所有标签**（`chrome.tabs.query({})` + 逐个 `sendMessage`，不需要任何新权限；`tabs.sendMessage` 本来就不需要 `tabs` 权限）。一条都没送达时如实说"重新加载页面后生效"，不静默。

- [ ] **Step 1: 给 chrome 替身加 `tabs.create`（纯记录，「去浏览器设置」要用）**

`tests/helpers/chrome-stub.ts` 的 `StubTabs` 接口里，在 `responder` 之后加：

```ts
  /**
   * 每次 `create` 的参数，按调用顺序。设置页的「去浏览器设置」用它打开
   * `chrome://extensions/shortcuts`——真机上 `tabs.create` 不需要任何权限，
   * 替身同样只记录、不真开页面。
   */
  created: Array<{ url?: string }>;
  create(props: { url?: string }): Promise<StubTab>;
```

`createTabs()` 里的对象加：

```ts
    created: [],
    async create(props) {
      tabs.created.push({ ...props });
      return { id: 99 };
    },
```

`reset()` 里加一行 `tabs.created = [];`（与 `tabs.queries = []` 同一批）。

- [ ] **Step 2: 跑到绿（替身改动是加法，不该影响任何既有用例）**

Run: `npx vitest run tests/popup/ tests/options/`
Expected: PASS —— 与改动前**同样的条数**（`tests/popup/popup.test.ts` **44 条** + `tests/options/` **48 条**）。
> 这两个数是**实测**的：popup 那 44 条由 `npx vitest run tests/popup/popup.test.ts` 报出（本任务只给替身加 `create`，不改任何既有用例，所以条数必须一模一样）；options 的 48 条 = 上一任务留下的 29（`options.test.ts`）+ 7（`options-css.test.ts`）+ 2（`no-innerhtml.test.ts`）+ 6（`store.test.ts`）+ 4（`dom.test.ts`）——**注意这里必须把 `dom.test.ts` 的 4 条算进去**，否则执行者会拿一个对不上的数字去查半天。

- [ ] **Step 3: 写失败测试**

创建 `tests/options/shortcuts.test.ts`：

```ts
// tests/options/shortcuts.test.ts
/**
 * @vitest-environment jsdom
 *
 * §3.3 快捷翻译：两个开关 change 即存（§4.1），保存成功后**通知所有标签**让页面当场重挂
 * 监听器（与弹窗同一条纪律）；保存失败把开关拨回真正生效的那一档并说出原因。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MSG } from '../../src/shared/messages';
import { SETTINGS_KEY } from '../../src/shared/settings';
import { bubble, chromeStub, loadOptions, pick, resetOptionsPage, seedSettings, storedSettings, waitFor } from './harness';

const SHORTCUTS_URL = 'chrome://extensions/shortcuts';

function hoverSwitch(): HTMLInputElement {
  return pick<HTMLInputElement>('hover-translate');
}

function selectionSwitch(): HTMLInputElement {
  return pick<HTMLInputElement>('selection-translate');
}

function status(): HTMLElement {
  return pick<HTMLElement>('shortcuts-status');
}

/** 拨开关：`checked` 先改掉再派发 change（真机上 change 是在值已经变了之后才发的）。 */
function flip(input: HTMLInputElement, next: boolean): void {
  input.checked = next;
  input.dispatchEvent(bubble('change'));
}

beforeEach(() => {
  resetOptionsPage();
});

describe('设置页：快捷翻译', () => {
  it('按存储回填两个开关（默认都是开）', async () => {
    await seedSettings({ hoverTranslate: false, selectionTranslate: true });
    await loadOptions();

    expect(hoverSwitch().checked).toBe(false);
    expect(selectionSwitch().checked).toBe(true);
  });

  it('拨开关即落盘，并广播 APPLY_SETTINGS 给**所有**标签（不是只给活动标签）', async () => {
    await seedSettings({ hoverTranslate: true });
    await loadOptions();
    // 三个标签：设置页自己也可能在里面，广播的意义就是"谁也不靠猜"。
    chromeStub.tabs.activeTabs = [{ id: 7 }, { id: 8 }, { id: 9 }];
    chromeStub.tabs.responder = () => ({ ok: true });

    flip(hoverSwitch(), false);

    await waitFor(async () => (await storedSettings()).hoverTranslate === false);
    await waitFor(() => chromeStub.tabs.sent.length === 3);
    // 查询条件必须是"全部标签"：写 {active:true,currentWindow:true} 拿到的是设置页自己。
    expect(chromeStub.tabs.queries).toEqual([{}]);
    for (const entry of chromeStub.tabs.sent) {
      const message = entry.message as { type?: unknown; payload?: { hoverTranslate?: unknown } };
      expect(message.type).toBe(MSG.APPLY_SETTINGS);
      expect(message.payload?.hoverTranslate).toBe(false);
    }
    await waitFor(() => (status().textContent ?? '').includes('即时生效'));
    expect(status().dataset.kind).toBe('ok');
  });

  it('一个标签都没确认时如实说"重新加载页面后生效"，但存储照常落盘', async () => {
    await seedSettings({ selectionTranslate: true });
    await loadOptions();
    chromeStub.tabs.activeTabs = [{ id: 7 }];
    chromeStub.tabs.rejectSendMessage = true;

    flip(selectionSwitch(), false);

    await waitFor(async () => (await storedSettings()).selectionTranslate === false);
    await waitFor(() => (status().textContent ?? '').includes('重新加载页面后生效'));
    // 通知失败**不回滚**：设置是真的存下去了，回滚会变成另一种撒谎。
    expect(selectionSwitch().checked).toBe(false);
  });

  it('存储拒绝写入（版本高于本代码）：开关拨回真正生效的那一档，并说出原因', async () => {
    await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: 99 } });
    await loadOptions();

    flip(hoverSwitch(), true);

    await waitFor(() => (status().textContent ?? '').includes('设置还没读出来'));
    expect(status().dataset.kind).toBe('err');
    // 界面不许停在一个没生效的值上。
    expect(hoverSwitch().checked).toBe(false);
    expect(chromeStub.tabs.sent).toEqual([]);
  });

  it('「去浏览器设置」开的是 chrome://extensions/shortcuts（快捷键不能由扩展代改）', async () => {
    await seedSettings();
    await loadOptions();

    pick<HTMLButtonElement>('open-shortcuts').click();

    await waitFor(() => chromeStub.tabs.created.length === 1);
    expect(chromeStub.tabs.created).toEqual([{ url: SHORTCUTS_URL }]);
  });
});
```

- [ ] **Step 4: 跑到红**

Run: `npx vitest run tests/options/shortcuts.test.ts`
Expected: FAIL —— `options.html 里没有 #hover-translate`（区块还没进页面）

- [ ] **Step 5: 加区块与导航项**

`src/options/options.html`：

① 导航的「翻译」组里，在 `语言与显示` 那一行之后插入：

```html
          <a class="nav-link" href="#sec-shortcuts" data-nav="shortcuts"><span class="i" aria-hidden="true">⌥</span>快捷翻译</a>
```

② 在 `<!-- 缓存与请求 -->` 那一行**之前**插入：

```html
        <!-- 快捷翻译 -->
        <section class="sec" id="sec-shortcuts" data-section="shortcuts" aria-labelledby="sec-shortcuts-title">
          <div class="sec-head"><h2 id="sec-shortcuts-title">快捷翻译</h2></div>
          <div class="group">
            <div class="grow2">
              <label class="lab" for="hover-translate">悬停翻译
                <span>按住 Shift 指向段落，约 180ms 后浮层显示译文；按住 Alt 时暂停</span>
              </label>
              <input id="hover-translate" class="switch" type="checkbox" />
            </div>
            <div class="grow2">
              <label class="lab" for="selection-translate">划词翻译
                <span>选中 1~2000 字符后在选区下方弹气泡，可复制 / 朗读</span>
              </label>
              <input id="selection-translate" class="switch" type="checkbox" />
            </div>
            <div class="grow2">
              <div class="lab">快捷键与右键菜单
                <span>Alt+T 翻译整页 · Alt+Shift+点击 诊断这块为什么没翻</span>
              </div>
              <button id="open-shortcuts" class="ghost tiny" type="button">去浏览器设置</button>
            </div>
          </div>
          <p class="hint">
            快捷键由浏览器管理，扩展改不了它——「去浏览器设置」打开的是 Chrome 自己的快捷键页。
            两个开关改动即时保存；已经打开的页面会当场重挂监听器，页面没回应时重新加载一次即可。
          </p>
          <p id="shortcuts-status" class="status" role="status" aria-live="polite"></p>
        </section>

```

- [ ] **Step 6: 写实现**

创建 `src/options/sections/shortcuts.ts`：

```ts
// src/options/sections/shortcuts.ts
//
// §3.3 快捷翻译：悬停与划词两个开关（change 即存），加一行只读的快捷键说明。
//
// 开关的消费者是**内容脚本**（它挂不挂 hover/selection 的监听器）。只写存储不够：
// 已经打开的页面不会因为存储变了而重挂，所以保存成功后必须发一条 `APPLY_SETTINGS`
// ——与弹窗的 `onFeatureToggleChange` 走同一条纪律（见 src/popup/popup.ts）。
//
// **广播给所有标签，不查"当前标签页"**：设置页自己就占着活动标签，`query({active:true,
// currentWindow:true})` 拿到的只会是它自己。`tabs.sendMessage` 不需要 `tabs` 权限，
// 广播的成本是每个标签一条本地消息，没有网络、没有新权限。
import { MSG } from '../../shared/messages';
import type { Settings } from '../../shared/settings';
import { describe, setStatus } from '../dom';
import type { Section, SectionContext } from '../section';

const hoverSwitch = document.getElementById('hover-translate') as HTMLInputElement;
const selectionSwitch = document.getElementById('selection-translate') as HTMLInputElement;
const openShortcutsButton = document.getElementById('open-shortcuts') as HTMLButtonElement;
const status = document.getElementById('shortcuts-status') as HTMLElement;

/** 浏览器自己的快捷键页：扩展无法代改快捷键（Chrome 要求用户手势），只能指路。 */
const SHORTCUTS_URL = 'chrome://extensions/shortcuts';

type FeatureField = 'hoverTranslate' | 'selectionTranslate';

/**
 * 上一次**确认生效**的取值。回滚要用它——`change` 触发时控件已经被用户拨过了，
 * 手里必须有一份"改之前是什么"的记忆。`mount` 时按存储填，每次保存成功后更新。
 */
const applied: Record<FeatureField, boolean | null> = { hoverTranslate: null, selectionTranslate: null };

/**
 * 把新的开关状态发给所有标签，返回是否有**至少一个**页面确认收到。
 *
 * 逐个 `try/catch`：没有内容脚本的标签（`chrome://`、扩展商店、还没注入的页面）
 * 一定会拒绝，那是正常情况，不该让整条链断掉，也不该被当成"全部失败"。
 */
async function notifyAllTabs(payload: {
  hoverTranslate: boolean;
  selectionTranslate: boolean;
  targetLang: string;
}): Promise<boolean> {
  const tabs = await chrome.tabs.query({});
  let applied = false;
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      const reply = (await chrome.tabs.sendMessage(tab.id, { type: MSG.APPLY_SETTINGS, payload })) as
        | { ok?: unknown }
        | undefined;
      if (reply?.ok === true) applied = true;
    } catch {
      // 这个标签没有接收方（chrome:// 页、没注入内容脚本的页面）。继续下一个。
    }
  }
  return applied;
}

function bindSwitch(ctx: SectionContext, input: HTMLInputElement, field: FeatureField, label: string): void {
  input.addEventListener('change', () => {
    void (async () => {
      const next = input.checked;
      const ok = await ctx.save(status, `保存${label}失败`, { [field]: next } as Partial<Settings>);
      if (!ok) {
        // 写失败就把开关拨回**真正生效**的那一档：停在用户刚拨的值上等于界面撒谎。
        // `applied` 还没填过（设置没读出来就拨）时回落到 false —— 那也是 HTML 里的初始值。
        input.checked = applied[field] ?? false;
        return;
      }
      applied[field] = next;
      const current = ctx.settings();
      if (current === null) return;
      let appliedToPages = false;
      try {
        appliedToPages = await notifyAllTabs({
          hoverTranslate: current.hoverTranslate,
          selectionTranslate: current.selectionTranslate,
          // 顺带报一次目标语言：内容脚本手里那份可能已经过期（朗读语种用）。
          targetLang: current.targetLang,
        });
      } catch (raw) {
        setStatus(status, 'err', `已保存，但通知已打开的页面失败：${describe(raw)}`);
        return;
      }
      setStatus(
        status,
        'ok',
        appliedToPages ? `${label}已更新，已打开的页面即时生效。` : `${label}已保存；已打开的页面需要重新加载后生效。`,
      );
    })();
  });
}

export const shortcutsSection: Section = {
  id: 'shortcuts',
  title: '快捷翻译',
  aliases: ['悬停', '划词', '快捷键', '右键菜单', 'Alt+T', 'Alt+Shift', '开关'],

  bind(ctx: SectionContext): void {
    bindSwitch(ctx, hoverSwitch, 'hoverTranslate', '悬停翻译');
    bindSwitch(ctx, selectionSwitch, 'selectionTranslate', '划词翻译');
    openShortcutsButton.addEventListener('click', () => {
      // tabs.create 不需要任何权限；失败也只是"没打开"，如实说一句。
      void chrome.tabs.create({ url: SHORTCUTS_URL }).catch((raw: unknown) => {
        setStatus(status, 'err', `打不开浏览器的快捷键页：${describe(raw)}`);
      });
    });
  },

  mount(ctx: SectionContext): void {
    const current = ctx.settings();
    if (current === null) return;
    hoverSwitch.checked = current.hoverTranslate;
    selectionSwitch.checked = current.selectionTranslate;
    applied.hoverTranslate = current.hoverTranslate;
    applied.selectionTranslate = current.selectionTranslate;
  },
};
```

> **上面那处 `{ [field]: next } as Partial<Settings>` 是刻意的**：`field` 是两个字段的联合类型，
> 计算属性会被 TS 放宽成 `{[x: string]: boolean}`，与 `Partial<Settings>` 不兼容。用一次
> 断言换掉一段 if/else 是划算的——**但断言必须收敛在这一行**，别往别处复制。
> 若审查更偏好零断言，把它换成与 `sections/language.ts` 的 `patchFor` 同形的显式构造即可，
> 语义一字不变。

`src/options/options.ts` 的 import 区与 `SECTIONS` 里各加一处：

```ts
import { shortcutsSection } from './sections/shortcuts';
```

```ts
export const SECTIONS: readonly Section[] = [
  engineSection,
  languageSection,
  shortcutsSection,
  cacheSection,
  privacySection,
];
```

- [ ] **Step 7: 跑到绿**

Run: `npx vitest run tests/options/shortcuts.test.ts`
Expected: PASS —— **5 条用例**

- [ ] **Step 8: 变异验证**

| 变异 | 期望红在哪一条 |
| --- | --- |
| `chrome.tabs.query({})` 改成 `chrome.tabs.query({ active: true, currentWindow: true })` | 「拨开关即落盘，并广播…」——`queries` 那一条断言 |
| 删掉 `if (!ok) { … input.checked = applied[field] ?? false; return; }` 那一整块 | 「存储拒绝写入…开关拨回真正生效的那一档」 |
| `input.addEventListener('change', …)` 改成 `'click'` | 「拨开关即落盘」——存储永远不写 |
| `notifyAllTabs` 里 `if (reply?.ok === true) applied = true;` 改成无条件 `applied = true` | 「一个标签都没确认时如实说…」 |
| `chrome.tabs.create({ url: SHORTCUTS_URL })` 改成 `url: 'chrome://extensions'` | 「去浏览器设置开的是 chrome://extensions/shortcuts」 |

- [ ] **Step 9: 提交**

```bash
git add src/options/sections/shortcuts.ts src/options/options.html src/options/options.ts \
  tests/helpers/chrome-stub.ts tests/options/shortcuts.test.ts
git commit -m "feat(options): 快捷翻译区块（悬停/划词开关即时保存 + 广播 APPLY_SETTINGS + 快捷键指路）"
```

---

## Task 5: 术语表区块（§3.4）

**Files:**
- Create: `src/options/sections/glossary.ts`
- Create: `tests/options/glossary.test.ts`
- Modify: `src/options/options.html`（新建「内容控制」导航组 + 区块）
- Modify: `src/options/options.ts`（import + `SECTIONS` 插到 `shortcutsSection` 之后）
- Modify: `src/options/options.css`（加 `.add` 与 `.arrow`）

> 一行一条 `from → to`；**文本类 → 失焦才存**（§4.1）。这里的"失焦"落成原生 `change`
> 事件：对文本控件，`change` 的触发时机就是「失焦**且值变了**」，而它**冒泡**，能配合
> 动态行的委托监听（`blur` 不冒泡，用它就得给每一行单独挂）。它比 `blur` 更严格：
> 没改动就不写存储。§10.3 的"打字过程中存储不变"因此天然成立。
>
> 空行语义（§10.4 + 一条自己的补充）：草稿行（`from` 或 `to` 为空）**不写存储**；
> **已存在**的那条被清空时从存储里删掉——否则输入框是空的、存储里还留着它，翻译仍被
> 那条术语强制替换，界面与存储对不上。

- [ ] **Step 1: 写失败测试**

创建 `tests/options/glossary.test.ts`：

```ts
// tests/options/glossary.test.ts
/**
 * @vitest-environment jsdom
 *
 * §3.4 术语表：一行一条、虚线添加、失焦保存、空行不写存储、用户输入不进 HTML。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { bubble, chromeStub, loadOptions, pick, resetOptionsPage, seedSettings, storedSettings, waitFor } from './harness';

interface StoredTerm {
  from: string;
  to: string;
}

function rows(): HTMLElement[] {
  return Array.from(pick<HTMLElement>('glossary-list').querySelectorAll<HTMLElement>('[data-glossary-row]'));
}

function rowAt(index: number): HTMLElement {
  const row = rows().find((candidate) => candidate.dataset.index === String(index));
  if (row === undefined) throw new Error(`没有第 ${index} 行术语`);
  return row;
}

function inputOf(row: HTMLElement, selector: string): HTMLInputElement {
  const input = row.querySelector<HTMLInputElement>(selector);
  if (input === null) throw new Error(`术语行缺控件 ${selector}`);
  return input;
}

/** 填一行并"失焦"：值改掉 → 派发冒泡的 change。 */
function fill(row: HTMLElement, from: string, to: string): void {
  inputOf(row, '.glossary-from').value = from;
  inputOf(row, '.glossary-to').value = to;
  inputOf(row, '.glossary-to').dispatchEvent(bubble('change'));
}

async function storedGlossary(): Promise<StoredTerm[]> {
  return ((await storedSettings()).glossary ?? []) as StoredTerm[];
}

function status(): HTMLElement {
  return pick<HTMLElement>('glossary-status');
}

beforeEach(() => {
  resetOptionsPage();
});

describe('设置页：术语表', () => {
  it('按存储渲染成一行一条，原样回填', async () => {
    await seedSettings({
      glossary: [
        { from: 'serverless', to: '无服务器' },
        { from: 'droplet', to: '云主机' },
      ],
    });
    await loadOptions();

    expect(rows()).toHaveLength(2);
    expect(inputOf(rowAt(0), '.glossary-from').value).toBe('serverless');
    expect(inputOf(rowAt(0), '.glossary-to').value).toBe('无服务器');
    expect(inputOf(rowAt(1), '.glossary-from').value).toBe('droplet');
    // 没有草稿行的时候，页面上就是存储里的条数。
    expect(rows()).toHaveLength((await storedGlossary()).length);
  });

  it('虚线按钮加一条空行；连点两次不会叠出第二行（一个草稿位就够）', async () => {
    await seedSettings({ glossary: [{ from: 'a', to: 'b' }] });
    await loadOptions();

    pick<HTMLButtonElement>('add-term').click();
    expect(rows()).toHaveLength(2);
    expect(inputOf(rowAt(1), '.glossary-from').value).toBe('');

    pick<HTMLButtonElement>('add-term').click();
    expect(rows()).toHaveLength(2);
    // 存储没有被这次点击碰过。
    expect(await storedGlossary()).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('把一行填满就落盘（不点任何保存按钮），状态的类型是成功', async () => {
    await seedSettings({ glossary: [] });
    await loadOptions();
    pick<HTMLButtonElement>('add-term').click();

    fill(rowAt(0), 'serverless', '无服务器');

    await waitFor(async () => (await storedGlossary()).length === 1);
    expect(await storedGlossary()).toEqual([{ from: 'serverless', to: '无服务器' }]);
    expect(status().dataset.kind).toBe('ok');
  });

  it('打字过程中存储一个字节都不变，失焦（change）之后才写', async () => {
    await seedSettings({ glossary: [] });
    await loadOptions();
    pick<HTMLButtonElement>('add-term').click();
    const input = inputOf(rowAt(0), '.glossary-from');

    input.value = 'half';
    input.dispatchEvent(bubble('input'));
    input.dispatchEvent(bubble('keyup'));
    // §10.3：边打字边写存储既吵又没必要。
    expect(await storedGlossary()).toEqual([]);

    input.value = 'serverless';
    inputOf(rowAt(0), '.glossary-to').value = '无服务器';
    input.dispatchEvent(bubble('change'));
    await waitFor(async () => (await storedGlossary()).length === 1);
  });

  it('只填一半的行**不写存储**，也不凭空长出第二行（§10.4）', async () => {
    await seedSettings({ glossary: [{ from: 'keep', to: '留着' }] });
    await loadOptions();
    pick<HTMLButtonElement>('add-term').click();

    inputOf(rowAt(1), '.glossary-from').value = 'half';
    inputOf(rowAt(1), '.glossary-from').dispatchEvent(bubble('change'));

    expect(await storedGlossary()).toEqual([{ from: 'keep', to: '留着' }]);
    expect(rows()).toHaveLength(2);
    // 半个词不是术语，也不该被当成"用户想删点什么"。
    expect(status().textContent ?? '').not.toContain('已保存');
  });

  it('真实用户路径：先填 from、Tab 到 to（两次 change），第二次才落盘——中途不许写坏存储', async () => {
    // 这是**最常见的输入顺序**，也是上一版计划里唯一没被测到的路径：点添加 → 在 from 里打字 →
    // 按 Tab 移到 to（from 失焦 → change 立刻触发，此刻 to 还是空的）。
    // 若实现把"一框为空"当成"忽略整行"，这一行会在用户还没填完时就被丢掉——所以这里钉住：
    // 第一次 change 什么都不做（存储不变、行还在、输入框的值不动），第二次 change 才写入。
    await seedSettings({ glossary: [] });
    await loadOptions();
    pick<HTMLButtonElement>('add-term').click();

    const from = inputOf(rowAt(0), '.glossary-from');
    const to = inputOf(rowAt(0), '.glossary-to');

    from.value = 'serverless';
    from.dispatchEvent(bubble('change')); // = 用户按 Tab 离开 from
    expect(await storedGlossary()).toEqual([]);
    expect(rows()).toHaveLength(1);
    expect(inputOf(rowAt(0), '.glossary-from').value).toBe('serverless');
    // 中途不许说"已保存"（那会让人以为半个词也生效了）。
    expect(status().textContent ?? '').not.toContain('已保存');

    to.value = '无服务器';
    to.dispatchEvent(bubble('change')); // = 用户离开 to
    await waitFor(async () => (await storedGlossary()).length === 1);
    expect(await storedGlossary()).toEqual([{ from: 'serverless', to: '无服务器' }]);
  });

  it('把既有行清空：**不写存储**、给一句能读懂的话，要删得点行尾「删除」', async () => {
    // **已决**（上一版计划在这里选错了）：既有行被清空时**不**顺手删掉那条术语。
    // 用户的真实动作可能是"清掉重打"——若在失焦那一刻就把条目删了并重绘，用户正在编辑的一行
    // 会当场消失，而且没有任何撤销出口。所以这里只**如实说明**存储里还是原来那条、要删请点删除，
    // 让"界面与存储不一致"变成一句明说的状态，而不是一次静默的破坏。
    await seedSettings({
      glossary: [
        { from: 'one', to: '一' },
        { from: 'two', to: '二' },
      ],
    });
    await loadOptions();

    inputOf(rowAt(0), '.glossary-to').value = '';
    inputOf(rowAt(0), '.glossary-to').dispatchEvent(bubble('change'));

    await waitFor(() => (status().textContent ?? '').includes('没有保存'));
    expect(status().dataset.kind).toBe('err');
    // 存储一个字节都没动，两条都还在。
    expect(await storedGlossary()).toEqual([
      { from: 'one', to: '一' },
      { from: 'two', to: '二' },
    ]);
    // 行也没消失（用户还能接着把它填回去）。
    expect(rows()).toHaveLength(2);

    // 真的要删，走行尾那个红字按钮：那是一次明确的用户动作。
    rowAt(0).querySelector<HTMLButtonElement>('[data-action="delete-term"]')!.click();
    await waitFor(async () => (await storedGlossary()).length === 1);
    expect(await storedGlossary()).toEqual([{ from: 'two', to: '二' }]);
  });

  it('行尾红字删除只删那一条，其余顺序原样', async () => {
    await seedSettings({
      glossary: [
        { from: 'one', to: '一' },
        { from: 'two', to: '二' },
        { from: 'three', to: '三' },
      ],
    });
    await loadOptions();

    rowAt(1).querySelector<HTMLButtonElement>('[data-action="delete-term"]')!.click();

    await waitFor(async () => (await storedGlossary()).length === 2);
    expect((await storedGlossary()).map((term) => term.from)).toEqual(['one', 'three']);
  });

  it('草稿行上的删除只是收起那一行，存储一个字节不动', async () => {
    await seedSettings({ glossary: [{ from: 'one', to: '一' }] });
    await loadOptions();
    pick<HTMLButtonElement>('add-term').click();

    rowAt(1).querySelector<HTMLButtonElement>('[data-action="delete-term"]')!.click();

    expect(rows()).toHaveLength(1);
    expect(await storedGlossary()).toEqual([{ from: 'one', to: '一' }]);
  });

  it('用户输入走 textContent：`<img onerror>` 原样进存储，页面上不出现元素', async () => {
    await seedSettings({ glossary: [] });
    await loadOptions();
    pick<HTMLButtonElement>('add-term').click();

    const payload = '<img src=x onerror=alert(1)>';
    fill(rowAt(0), payload, payload);

    await waitFor(async () => (await storedGlossary()).length === 1);
    expect((await storedGlossary())[0]).toEqual({ from: payload, to: payload });
    expect(pick<HTMLElement>('glossary-list').querySelectorAll('img')).toHaveLength(0);
  });

  it('写入被拒时如实报错，界面不假装成功（注入一次存储写失败）', async () => {
    await seedSettings({ glossary: [] });
    await loadOptions();
    pick<HTMLButtonElement>('add-term').click();
    chromeStub.storage.local.set = async () => {
      throw new Error('存储写入失败');
    };

    fill(rowAt(0), 'serverless', '无服务器');

    await waitFor(() => status().dataset.kind === 'err');
    expect(status().textContent).toContain('保存术语失败');
    // 存储里没有半条术语；界面上那行还在（用户填的东西不该被吞掉）。
    expect(await storedGlossary()).toEqual([]);
    expect(inputOf(rowAt(0), '.glossary-from').value).toBe('serverless');
  });
});
```

> 版本闸门（存储里 `version` 高于本代码）那一路在术语表这里**构造不出"能填的行"**：
> `start()` 会在 `loadSnapshot()` 上失败，`mount` 不跑，页面上没有任何输入框。
> 它由 `options.test.ts` 的版本闸门用例（改下拉 → `#language-status` 报「设置还没读出来」）
> 与 `shortcuts.test.ts` 的回滚用例覆盖，不在这里重复。

- [ ] **Step 2: 跑到红**

Run: `npx vitest run tests/options/glossary.test.ts`
Expected: FAIL —— `options.html 里没有 #glossary-list`

- [ ] **Step 3: 加导航组、区块与两条样式**

`src/options/options.html`：

① 导航里，在「翻译」组结束（`</div>`，即 `语言与显示` / `快捷翻译` 那两行所在容器）与「数据」组开始之间插入一个新的组：

```html
        <div class="nav-grp" data-nav-group>
          <p class="grp">内容控制</p>
          <a class="nav-link" href="#sec-glossary" data-nav="glossary"><span class="i" aria-hidden="true">Aa</span>术语表</a>
        </div>

```

② 在 `<!-- 缓存与请求 -->` 之前插入：

```html
        <!-- 术语表 -->
        <section class="sec" id="sec-glossary" data-section="glossary" aria-labelledby="sec-glossary-title">
          <div class="sec-head"><h2 id="sec-glossary-title">术语表</h2></div>
          <p class="sec-desc">强制按你指定的译法翻译，优先于自动判断。一行一条：左边原文、右边译文；改完即生效。</p>
          <div id="glossary-list"></div>
          <button id="add-term" class="add" type="button">+ 添加术语</button>
          <p class="hint">只填一半的行不会保存——一行里原文与译文都填上，它才会写进存储。</p>
          <p id="glossary-status" class="status" role="status" aria-live="polite"></p>
        </section>

```

③ `src/options/options.css` 的「一行一卡片」一节末尾（`.profile-editor` 那条规则之后）加：

```css
/* 列表分隔符（术语行的 `→`）。 */
.arrow {
  flex: none;
  color: var(--text-3);
}

/* 添加：**虚线大按钮**（规格 §2）。它永远出现在列表末尾，一眼能看出"这里还能加"。 */
.add {
  width: 100%;
  padding: 11px;
  font-size: 13.5px;
  color: var(--text-2);
  background: transparent;
  border: 1.5px dashed var(--border-strong);
  border-radius: var(--radius-md);
}

.add:hover {
  color: var(--accent);
  background: var(--accent-weak);
  border-color: var(--accent);
}
```

- [ ] **Step 4: 写实现**

创建 `src/options/sections/glossary.ts`：

```ts
// src/options/sections/glossary.ts
//
// §3.4 术语表：`from → to` 一行一卡片，虚线按钮加一行，失焦（原生 change）即存。
//
// 两条语义在文件头写清楚，免得后来者"顺手优化"掉：
// 1. **草稿行不写存储**（§10.4）：`from` 或 `to` 为空的行不是术语，写进去会让翻译按半个词
//    强制替换。草稿仍然是**真实存在的一行**（有删除按钮），只是它没有存储对应物。
// 2. **草稿位只有一个**：点一次「+ 添加术语」出现一行，再点只是把焦点放回那一行——
//    空白行叠出好几条除了让人困惑没有任何作用。
import type { Term } from '../../engines/types';
import { element, setStatus } from '../dom';
import type { Section, SectionContext } from '../section';

const list = document.getElementById('glossary-list') as HTMLElement;
const addButton = document.getElementById('add-term') as HTMLButtonElement;
const status = document.getElementById('glossary-status') as HTMLElement;

/** 草稿行在不在页面上（它没有存储对应物，所以这份状态只能由界面自己记着）。 */
let draftOpen = false;

function rowsOf(): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>('[data-glossary-row]'));
}

function inputWithin(row: HTMLElement, className: string): HTMLInputElement {
  const input = row.querySelector<HTMLInputElement>(`.${className}`);
  if (input === null) throw new Error(`术语行缺控件 .${className}`);
  return input;
}

/**
 * 造一行。`term === null` 时是草稿：两个输入都空，**没有**存储对应物。
 *
 * 用户输入只走 `.value`（`textContent` 家族的兄弟——都不是 HTML 解析），
 * 所以 `<img onerror>` 这类内容原样进存储、在页面上也只是一串字符。
 */
function buildRow(index: number, term: Term | null): HTMLElement {
  const row = element('div', 'item');
  row.dataset.glossaryRow = '';
  row.dataset.index = String(index);
  if (term === null) row.dataset.draft = '';

  const from = document.createElement('input');
  from.type = 'text';
  from.className = 'glossary-from';
  from.setAttribute('aria-label', '原文');
  from.autocomplete = 'off';
  from.value = term?.from ?? '';

  const to = document.createElement('input');
  to.type = 'text';
  to.className = 'glossary-to';
  to.setAttribute('aria-label', '译文');
  to.autocomplete = 'off';
  to.value = term?.to ?? '';

  row.append(from, element('span', 'arrow', '→'), to);
  // 草稿行的删除是**界面动作**（收起这一行），既有行的删除是**存储动作**；两者都真实，
  // 所以两种行都有这个按钮。
  const remove = element('button', 'link-danger', '删除');
  remove.type = 'button';
  remove.dataset.action = 'delete-term';
  row.append(remove);
  return row;
}

function renderRows(ctx: SectionContext): void {
  const terms = ctx.settings()?.glossary ?? [];
  list.textContent = '';
  terms.forEach((term, index) => list.append(buildRow(index, term)));
  if (draftOpen) list.append(buildRow(terms.length, null));
  addButton.disabled = draftOpen;
}

/** 把存储里的术语换成新的一份：这是所有写路径的唯一出口。 */
async function writeTerms(ctx: SectionContext, terms: Term[], prefix: string, okMessage: string): Promise<boolean> {
  const ok = await ctx.save(status, prefix, { glossary: terms }, okMessage);
  if (ok) renderRows(ctx);
  return ok;
}

/**
 * 一行的 `change`（＝失焦且值变了）。三种结局，逐条写清楚，因为它们是**决策**不是实现细节：
 *
 * 1. **两边都填了**：既有行就地更新（按下标），草稿行追加成新条目，然后把草稿位收起来。
 * 2. **只填了一半、且是草稿行**：什么都不做（§10.4）。这条路径是**真实用户路径**：用户点「添加
 *    术语」→ 在 from 里打字 → **按 Tab 移到 to**（from 失焦 → change 立刻触发，此刻 to 还是空）。
 *    这里绝不能"当作整行作废"，否则用户敲进去的半行就白填了；等 to 也失焦时第二次 change 才写入。
 * 3. **只填了一半、且是既有行**：**不写存储**，只给一句能读懂的话（存储里仍是原来那条，要删请点
 *    行尾「删除」）。上一版计划在这里选的是"顺手删掉那一条"，被审查挡下了，理由是对的：用户的
 *    真实动作可能是"清掉重打"，在失焦那一刻删条目 + 重绘会让**正在编辑的一行当场消失**，而这份
 *    界面没有任何撤销出口。相比之下，"界面与存储暂时不一致"只要**明说**就是诚实的。
 */
async function commitRow(ctx: SectionContext, row: HTMLElement): Promise<void> {
  const current = ctx.settings();
  if (current === null) return;
  const index = Number(row.dataset.index);
  const from = inputWithin(row, 'glossary-from').value.trim();
  const to = inputWithin(row, 'glossary-to').value.trim();
  const terms = current.glossary;

  if (from.length > 0 && to.length > 0) {
    const next: Term[] = index < terms.length
      ? terms.map((term, at) => (at === index ? { from, to } : term))
      : [...terms, { from, to }];
    draftOpen = false;
    await writeTerms(ctx, next, '保存术语失败', '已保存');
    return;
  }

  if (index >= terms.length) return; // 草稿行半填：等另一个框（见上面第 2 条）

  // 既有行被清空：不写存储，也不假装成功；把"存储里还是原来那条"如实说出来。
  setStatus(status, 'err', '这一行没有填完，没有保存；存储里仍是原来那条术语（要删掉请点行尾「删除」）');
}

function deleteRow(ctx: SectionContext, row: HTMLElement): void {
  const current = ctx.settings();
  if (current === null) return;
  const index = Number(row.dataset.index);
  if (index >= current.glossary.length) {
    // 草稿行：只是把这一行收起来，存储无关。
    draftOpen = false;
    renderRows(ctx);
    setStatus(status, 'ok', '');
    return;
  }
  void writeTerms(ctx, current.glossary.filter((_, at) => at !== index), '删除术语失败', '已删除');
}

export const glossarySection: Section = {
  id: 'glossary',
  title: '术语表',
  aliases: ['词库', '专有名词', '术语', '术语库', '词典', 'glossary'],

  bind(ctx: SectionContext): void {
    addButton.addEventListener('click', () => {
      if (ctx.settings() === null) {
        setStatus(status, 'err', '设置还没读出来，请稍候重试');
        return;
      }
      draftOpen = true;
      renderRows(ctx);
      // 点完就把光标放进新行：这是用户点这个按钮唯一想干的事。
      rowsOf().at(-1)?.querySelector<HTMLInputElement>('.glossary-from')?.focus();
    });

    // 行是动态渲染的 → 用容器上的委托。`change` 冒泡（`blur` 不冒泡），
    // 所以"失焦即存"这条语义在委托下也成立。
    list.addEventListener('change', (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest<HTMLElement>('[data-glossary-row]');
      if (row === null) return;
      void commitRow(ctx, row);
    });

    list.addEventListener('click', (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.dataset.action !== 'delete-term') return;
      const row = target.closest<HTMLElement>('[data-glossary-row]');
      if (row === null) return;
      deleteRow(ctx, row);
    });
  },

  mount(ctx: SectionContext): void {
    renderRows(ctx);
  },
};
```

`src/options/options.ts` 加 import 与清单项：

```ts
import { glossarySection } from './sections/glossary';
```

```ts
export const SECTIONS: readonly Section[] = [
  engineSection,
  languageSection,
  shortcutsSection,
  glossarySection,
  cacheSection,
  privacySection,
];
```

- [ ] **Step 5: 跑到绿**

Run: `npx vitest run tests/options/glossary.test.ts`
Expected: PASS —— **11 条用例**

- [ ] **Step 6: 变异验证**

| 变异 | 期望红在哪一条 |
| --- | --- |
| `commitRow` 的两边都填那一支里，`index < terms.length ? … : […terms, {from,to}]` 改成永远 `[…terms, {from,to}]` | 「把一行填满就落盘…」（既有行更新会变成追加，条数与内容都变） |
| 既有行清空那一支的 `setStatus(status,'err', …没有填完…)` 改成 `await writeTerms(… filter …)`（＝上一版计划的"顺手删掉"） | 「把既有行清空：**不写存储**、给一句能读懂的话」 |
| 草稿行半填那一支的 `if (index >= terms.length) return;` 删掉 | 「只填一半的行不写存储」与「真实用户路径：先填 from、Tab 到 to」（第一次 change 就会写进一条空的 `to`） |
| `draftOpen` 那两行（渲染草稿 + `addButton.disabled`）删掉 | 「虚线按钮加一条空行…」 |
| `list.addEventListener('change', …)` 改成 `'input'` | 「打字过程中存储一个字节都不变」（改成 input 后打字即写） |
| `from.value = term?.from ?? ''` 改成 `from.setAttribute('value', …)` | **不设此变异（已核实杀不死）**：回填断言的读数是 `.value`，而 `setAttribute('value', …)` 在 jsdom 里**也会**反映到 `.value`（属性反射），两种写法行为一致。真正的守卫是「`<img onerror>` 原样进存储」那条（走 `textContent` 家族而非 HTML 解析）。这一行留在这里是记录"查过、杀不死"，不是待办。 |

- [ ] **Step 7: 提交**

```bash
git add src/options/sections/glossary.ts src/options/options.html src/options/options.css \
  src/options/options.ts tests/options/glossary.test.ts
git commit -m "feat(options): 术语表区块（一行一条 + 虚线添加 + 失焦保存 + 空行不写存储）"
```

---

## Task 6: 站点规则写入侧（§3.5 + §5）

**Files:**
- Create: `src/options/rule-pattern.ts`
- Create: `src/options/sections/site-rules.ts`
- Create: `tests/options/rule-pattern.test.ts`
- Create: `tests/options/site-rules.test.ts`
- Modify: `src/options/options.html`（内容控制组里加导航项 + 区块）
- Modify: `src/options/options.ts`（import + `SECTIONS` 插到 `glossarySection` 之后）
- Modify: `src/options/options.css`（加 `.rule-action`）

> **只做「永不翻译」**（规格 §5）：本扩展没有自动翻译，`action: 'translate'` 今天不产生任何
> 可观察行为，所以**不给它入口，也不留占位**——每行的动作是一段静态文字
> （`data-rule-action="never"`），不是一个只有一项的下拉。
>
> **形状校验是设置页的职责**（`src/core/site-rules.ts` 的注释点名了这件事）：核心匹配器对
> `*example.com`、`https://example.com`、`example.com:8080` 这类写法**不报错、只会永不命中**。
> 设置页这一侧要做的是：能规范化的规范化（整条网址 → 主机名、中文域名 → punycode），
> 规范不了的**明确拒绝并说清为什么**，而不是让它静默失效。
>
> 区块里还要写两句如实的话（§11）：① **划词与悬停翻译不受规则约束**；② 页面**已经翻译之后**
> 再加规则，闸不会回头管已经翻好的内容与之后新出现的内容（那道闸只装在整页翻译的入口上，
> 单元 A 的规格 §5 已经写明这条缝）。

- [ ] **Step 1: 写纯函数的失败测试**

创建 `tests/options/rule-pattern.test.ts`：

```ts
// tests/options/rule-pattern.test.ts
/**
 * 站点规则的域名规范化与形状校验（纯函数，无 DOM）。
 *
 * 判据对着**真实的核心匹配语义**写（`src/core/site-rules.ts` 的注释就是规格）：只支持
 * `example.com`（精确）与 `*.example.com`（含裸域与任意层子域）。其余写法核心既不报错
 * 也不会命中——设置页这一侧的责任就是**在写入前**把它们挡住或者规范化掉。
 */
import { describe, expect, it } from 'vitest';
import { normalizeRulePattern } from '../../src/options/rule-pattern';

describe('normalizeRulePattern：能接受的写法', () => {
  it('裸域原样通过（大小写归一化成小写）', () => {
    expect(normalizeRulePattern('example.com')).toEqual({ ok: true, pattern: 'example.com' });
    expect(normalizeRulePattern('  EXAMPLE.COM  ')).toEqual({ ok: true, pattern: 'example.com' });
  });

  it('*. 前缀通配原样通过', () => {
    expect(normalizeRulePattern('*.example.com')).toEqual({ ok: true, pattern: '*.example.com' });
    expect(normalizeRulePattern('*.Example.COM')).toEqual({ ok: true, pattern: '*.example.com' });
  });

  it('整条网址规范化成主机名（路径只有 / 或没有时）', () => {
    expect(normalizeRulePattern('https://example.com')).toEqual({ ok: true, pattern: 'example.com' });
    expect(normalizeRulePattern('https://www.example.com/')).toEqual({ ok: true, pattern: 'www.example.com' });
    expect(normalizeRulePattern('http://localhost:11434/')).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('单标签主机名照收（localhost / 内网短名）：核心按精确匹配，它本来就是有效规则', () => {
    // **已决**：不因为"没有点"就拒绝。核心的 `hostMatchesPattern` 对任何非空 pattern 都做
    // 精确匹配，UI 凭空加这条限制只会让人配不了内网页面；真正该拒的是下面的端口/路径/垃圾输入。
    expect(normalizeRulePattern('localhost')).toEqual({ ok: true, pattern: 'localhost' });
    expect(normalizeRulePattern('*.wiki')).toEqual({ ok: true, pattern: '*.wiki' });
  });

  it('中文域名按 punycode 落地（核心按 ASCII 比对，填中文会静默失效——这里把它接住）', () => {
    expect(normalizeRulePattern('中文.com')).toEqual({ ok: true, pattern: 'xn--fiq228c.com' });
  });
});

describe('normalizeRulePattern：必须拒绝的写法', () => {
  it('空串与纯空白', () => {
    expect(normalizeRulePattern('')).toEqual({ ok: false, reason: '请填写域名' });
    expect(normalizeRulePattern('   ')).toEqual({ ok: false, reason: '请填写域名' });
  });

  it('光杆 * 与 *.（核心匹配器里它们是空模式）', () => {
    expect(normalizeRulePattern('*').ok).toBe(false);
    expect(normalizeRulePattern('*.').ok).toBe(false);
    expect(normalizeRulePattern('*example.com').ok).toBe(false);
  });

  it('带端口的写法：核心按 `example.com:8080` 匹配永远不命中，这里明说', () => {
    const result = normalizeRulePattern('example.com:8080');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('不该通过');
    expect(result.reason).toContain('端口');
  });

  it('带路径的网址：规则是**整个域名**，带路径会让人以为只对那个路径生效', () => {
    const result = normalizeRulePattern('https://example.com/docs/page');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('不该通过');
    expect(result.reason).toContain('路径');
  });

  it('不是域名的东西：空格、纯符号、scheme 后面什么都没有', () => {
    expect(normalizeRulePattern('not a domain').ok).toBe(false);
    expect(normalizeRulePattern('https://').ok).toBe(false);
    expect(normalizeRulePattern('???').ok).toBe(false);
  });

  it('带用户名/密码的网址：那不是"这个站"，是凭据', () => {
    expect(normalizeRulePattern('https://user:pass@example.com/').ok).toBe(false);
  });
});
```

- [ ] **Step 2: 跑到红**

Run: `npx vitest run tests/options/rule-pattern.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/options/rule-pattern"`

- [ ] **Step 3: 写实现**

创建 `src/options/rule-pattern.ts`：

```ts
// src/options/rule-pattern.ts
//
// 站点规则的**输入侧**校验与规范化。纯函数，不碰 DOM、不碰存储。
//
// 为什么要有它：核心匹配器（`src/core/site-rules.ts`）刻意不做形状校验——只认
// `example.com` 与 `*.example.com`，其余写法**既不报错也不会命中**，静默地永不生效。
// 那份注释把"输入侧"的责任点给了设置页，这里就是那一侧：
//
// - 能救的救回来：整条网址 → 主机名；中文域名 → punycode（核心按 ASCII 比对）；
// - 救不回来的**明确拒绝**并说清为什么，绝不让用户填一个"存下去了但永远不生效"的规则。
import type { SiteRule } from '../shared/settings';

export type RulePatternResult = { ok: true; pattern: string } | { ok: false; reason: string };

/**
 * 主机名的形状：点分标签，每段由字母数字与连字符组成、不以连字符开头或结尾。
 *
 * **允许单标签**（`localhost`、`wiki` 这种内网短名）——**已决**：核心匹配器
 * （`src/core/site-rules.ts` 的 `hostMatchesPattern`）对任何非空 pattern 都做精确匹配，
 * `localhost` 在那边是**有效规则**；UI 这一侧凭"看起来不像域名"把它拒掉，就是凭空发明一条
 * 核心没有的限制（而且内网页面确实有人想加规则）。真正该拒的是 URL 解析都过不去的输入
 * （`???`、带空格的串）与带端口/路径/凭据的写法，那几类下面各有一条。
 */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/** 把一串"可能带 scheme、可能带路径"的输入解析成主机名；解析不出来返回 null。 */
function hostFrom(input: string): { host: string; hadPath: boolean; hadPort: boolean; hadUserInfo: boolean } | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  return {
    host: url.hostname,
    hadPath: url.pathname !== '' && url.pathname !== '/',
    hadPort: url.port !== '',
    hadUserInfo: url.username !== '' || url.password !== '',
  };
}

/**
 * 规范化一条规则域名。返回 `{ok:true, pattern}` 时 `pattern` 就可以原样写进存储；
 * 返回 `{ok:false, reason}` 时调用方**不要写存储**，把 `reason` 说给用户听。
 */
export function normalizeRulePattern(raw: string): RulePatternResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: '请填写域名' };

  if (trimmed.startsWith('*.')) {
    const rest = trimmed.slice(2).trim();
    if (rest.length === 0) return { ok: false, reason: '通配要写成 *.example.com（星号后面必须有域名）' };
    const parsed = hostFrom(rest);
    if (parsed === null || parsed.hadPath || parsed.hadPort || parsed.hadUserInfo) {
      return { ok: false, reason: '通配要写成 *.example.com，星号后面只跟域名' };
    }
    if (!HOSTNAME.test(parsed.host)) return { ok: false, reason: `这看起来不是域名：${rest}` };
    return { ok: true, pattern: `*.${parsed.host}` };
  }

  if (trimmed.startsWith('*')) {
    return { ok: false, reason: '通配只能写成 *.example.com 这种形式（星号后面要紧跟一个点）' };
  }

  const parsed = hostFrom(trimmed);
  if (parsed === null) return { ok: false, reason: `这看起来不是域名：${trimmed}` };
  if (parsed.hadUserInfo) return { ok: false, reason: '网址里不要带用户名与密码——规则只认域名' };
  if (parsed.hadPort) return { ok: false, reason: '规则只按域名匹配，不要带端口（端口会被忽略，写了也不生效）' };
  if (parsed.hadPath) {
    return { ok: false, reason: `规则只按整个域名匹配，不能带路径；要限制这个站就填 ${parsed.host}` };
  }
  if (!HOSTNAME.test(parsed.host)) return { ok: false, reason: `这看起来不是域名：${trimmed}` };
  return { ok: true, pattern: parsed.host };
}

/** 存储里那条规则的形状（本单元只写 `never`，理由见 sections/site-rules.ts）。 */
export type StoredRule = SiteRule;
```

- [ ] **Step 4: 跑到绿（纯函数）**

Run: `npx vitest run tests/options/rule-pattern.test.ts`
Expected: PASS —— **11 条用例**

- [ ] **Step 5: 写页面测试（第二个失败测试）**

创建 `tests/options/site-rules.test.ts`：

```ts
// tests/options/site-rules.test.ts
/**
 * @vitest-environment jsdom
 *
 * §3.5 站点规则的**写入侧**：增删规则、域名规范化、非法形状拒绝、动作恒为 `never`。
 * 匹配语义本身（精确 / `*.` 通配 / 首条命中）在 `tests/core/site-rules.test.ts`，这里不重复。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { bubble, chromeStub, loadOptions, pick, resetOptionsPage, seedSettings, storedSettings, waitFor } from './harness';

interface StoredRule {
  pattern: string;
  action: string;
}

function rows(): HTMLElement[] {
  return Array.from(pick<HTMLElement>('site-rules-list').querySelectorAll<HTMLElement>('[data-rule-row]'));
}

function rowAt(index: number): HTMLElement {
  const row = rows().find((candidate) => candidate.dataset.index === String(index));
  if (row === undefined) throw new Error(`没有第 ${index} 条规则`);
  return row;
}

function patternOf(row: HTMLElement): HTMLInputElement {
  const input = row.querySelector<HTMLInputElement>('.rule-pattern');
  if (input === null) throw new Error('规则行缺 .rule-pattern');
  return input;
}

function status(): HTMLElement {
  return pick<HTMLElement>('site-rules-status');
}

async function storedRules(): Promise<StoredRule[]> {
  return ((await storedSettings()).siteRules ?? []) as StoredRule[];
}

/** 填一条并"失焦"：值改掉 → 派发冒泡的 change。 */
function commit(row: HTMLElement, value: string): void {
  const input = patternOf(row);
  input.value = value;
  input.dispatchEvent(bubble('change'));
}

beforeEach(() => {
  resetOptionsPage();
});

describe('设置页：站点规则（写入侧）', () => {
  it('按存储渲染，动作一律显示「永不翻译」，且**没有**可选的动作控件', async () => {
    await seedSettings({
      siteRules: [
        { pattern: '*.bilibili.com', action: 'never' },
        { pattern: 'docs.kernel.org', action: 'never' },
      ],
    });
    await loadOptions();

    expect(rows()).toHaveLength(2);
    expect(patternOf(rowAt(0)).value).toBe('*.bilibili.com');
    expect(rowAt(0).querySelector('[data-rule-action]')?.getAttribute('data-rule-action')).toBe('never');
    // 规格 §5：**不给**「总是翻译」入口，连一个只有一项的下拉都不做。
    expect(pick<HTMLElement>('site-rules-list').querySelectorAll('select')).toHaveLength(0);
  });

  it('加一条规则、填上域名即落盘，动作写的是 never', async () => {
    await seedSettings({ siteRules: [] });
    await loadOptions();

    pick<HTMLButtonElement>('add-rule').click();
    expect(rows()).toHaveLength(1);

    commit(rowAt(0), 'example.com');

    await waitFor(async () => (await storedRules()).length === 1);
    expect(await storedRules()).toEqual([{ pattern: 'example.com', action: 'never' }]);
    expect(status().dataset.kind).toBe('ok');
  });

  it('整条网址被规范化成主机名后再写进存储（存进去的一定是核心认得的形状）', async () => {
    await seedSettings({ siteRules: [] });
    await loadOptions();
    pick<HTMLButtonElement>('add-rule').click();

    commit(rowAt(0), 'https://WWW.Example.com/');

    await waitFor(async () => (await storedRules()).length === 1);
    expect((await storedRules())[0].pattern).toBe('www.example.com');
    // 输入框里显示的也是规范化后的值：用户看到的就是实际生效的那一条。
    expect(patternOf(rowAt(0)).value).toBe('www.example.com');
  });

  it('非法形状**不写存储**并说清为什么（核心那边是静默不命中，这一侧不许静默）', async () => {
    await seedSettings({ siteRules: [{ pattern: 'keep.me', action: 'never' }] });
    await loadOptions();
    pick<HTMLButtonElement>('add-rule').click();

    commit(rowAt(1), 'example.com:8080');

    await waitFor(() => status().dataset.kind === 'err');
    expect(status().textContent).toContain('端口');
    expect((await storedRules()).map((rule) => rule.pattern)).toEqual(['keep.me']);
  });

  it('打字过程中存储不变（失焦才写）', async () => {
    await seedSettings({ siteRules: [] });
    await loadOptions();
    pick<HTMLButtonElement>('add-rule').click();
    const input = patternOf(rowAt(0));

    input.value = 'exa';
    input.dispatchEvent(bubble('input'));
    expect(await storedRules()).toEqual([]);
  });

  it('既有行的域名被清空：**不写存储**、给一句能读懂的话，要删得点行尾「删除」', async () => {
    // 与术语表同一条口径（见 `sections/glossary.ts` 的注释）：用户可能只是"清掉重打"，
    // 在失焦那一刻顺手删条目 + 重绘会让他正在编辑的一行当场消失，且没有撤销出口。
    await seedSettings({
      siteRules: [
        { pattern: 'a.com', action: 'never' },
        { pattern: 'b.com', action: 'never' },
      ],
    });
    await loadOptions();

    patternOf(rowAt(0)).value = '';
    patternOf(rowAt(0)).dispatchEvent(bubble('change'));

    await waitFor(() => (status().textContent ?? '').includes('没有保存'));
    expect(status().dataset.kind).toBe('err');
    expect((await storedRules()).map((rule) => rule.pattern)).toEqual(['a.com', 'b.com']);
    expect(rows()).toHaveLength(2);

    // 明确的删除动作才真的删。
    rowAt(0).querySelector<HTMLButtonElement>('[data-action="delete-rule"]')!.click();
    await waitFor(async () => (await storedRules()).length === 1);
    expect((await storedRules()).map((rule) => rule.pattern)).toEqual(['b.com']);
  });

  it('行尾红字删除只删那一条，其余顺序原样；草稿行的删除不碰存储', async () => {
    await seedSettings({
      siteRules: [
        { pattern: 'a.com', action: 'never' },
        { pattern: 'b.com', action: 'never' },
      ],
    });
    await loadOptions();

    rowAt(0).querySelector<HTMLButtonElement>('[data-action="delete-rule"]')!.click();
    await waitFor(async () => (await storedRules()).length === 1);
    expect((await storedRules()).map((rule) => rule.pattern)).toEqual(['b.com']);

    pick<HTMLButtonElement>('add-rule').click();
    rowAt(1).querySelector<HTMLButtonElement>('[data-action="delete-rule"]')!.click();
    expect(rows()).toHaveLength(1);
    expect((await storedRules()).map((rule) => rule.pattern)).toEqual(['b.com']);
  });

  it('写入被拒时如实报错（注入一次存储写失败）', async () => {
    await seedSettings({ siteRules: [] });
    await loadOptions();
    pick<HTMLButtonElement>('add-rule').click();
    chromeStub.storage.local.set = async () => {
      throw new Error('存储写入失败');
    };

    commit(rowAt(0), 'example.com');

    await waitFor(() => status().dataset.kind === 'err');
    expect(status().textContent).toContain('保存规则失败');
    expect(await storedRules()).toEqual([]);
  });

  it('区里写清两条边界：划词/悬停不受约束、已翻译页面不受回头管', async () => {
    await seedSettings();
    await loadOptions();
    const text = pick<HTMLElement>('sec-site-rules').textContent ?? '';
    expect(text).toContain('划词与悬停翻译不受约束');
    expect(text).toContain('已经翻译过的页面');
  });
});
```

- [ ] **Step 6: 跑到红**

Run: `npx vitest run tests/options/site-rules.test.ts`
Expected: FAIL —— `options.html 里没有 #site-rules-list`

- [ ] **Step 7: 加导航项、区块与样式**

`src/options/options.html`：

① 「内容控制」组里，在 `术语表` 那一行之后插入：

```html
          <a class="nav-link" href="#sec-site-rules" data-nav="site-rules"><span class="i" aria-hidden="true">@</span>站点规则</a>
```

② 在 `<!-- 缓存与请求 -->` 之前插入：

```html
        <!-- 站点规则 -->
        <section class="sec" id="sec-site-rules" data-section="site-rules" aria-labelledby="sec-site-rules-title">
          <div class="sec-head">
            <h2 id="sec-site-rules-title">站点规则</h2>
            <div class="act"><button id="add-rule" class="ghost tiny" type="button">+ 添加规则</button></div>
          </div>
          <p class="sec-desc">按域名决定整页翻不翻，自上而下匹配，<strong>第一条命中即生效</strong>。</p>
          <div id="site-rules-list"></div>
          <p class="hint">
            规则只认两种写法：<code>example.com</code>（精确，不含子域）与 <code>*.example.com</code>
            （含裸域与任意层子域）。填整条网址也行——失焦时会规范化成域名；带端口、带路径、光杆
            <code>*</code> 这类写法会被当场拒绝并说明原因，不会静默失效。
          </p>
          <details>
            <summary>这个区块的边界（如实说明）</summary>
            <p>
              只提供「永不翻译」这一个动作：本扩展还没有自动翻译，「总是翻译」今天不产生任何可观察行为，
              所以不给它入口，等自动翻译落地再补。
            </p>
            <p>
              <strong>划词与悬停翻译不受约束</strong>——那是你主动发起的单段翻译，与"这个站整页不该翻"是两件事。
            </p>
            <p>
              还有一处缝：规则的闸只装在**整页翻译的入口**上，所以<strong>已经翻译过的页面</strong>
              再加规则时，已经翻好的内容与之后新出现的内容都不会被撤掉——要立刻生效请先按 Alt+T 还原再重新翻译。
            </p>
          </details>
          <p id="site-rules-status" class="status" role="status" aria-live="polite"></p>
        </section>

```

③ `src/options/options.css` 的 `.arrow` 规则之后加：

```css
/* 规则的动作展示：**静态文字**，不是下拉（本扩展只有「永不翻译」一个动作，见规格 §5）。 */
.rule-action {
  flex: none;
  padding: 1px 9px;
  font-size: 11.5px;
  color: var(--text-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  white-space: nowrap;
}
```

- [ ] **Step 8: 写实现**

创建 `src/options/sections/site-rules.ts`：

```ts
// src/options/sections/site-rules.ts
//
// §3.5 站点规则的**写入侧**（消费侧在单元 A 已经落地：`src/core/site-rules.ts` 的匹配、
// 内容脚本的拦截、弹窗的一键解除）。
//
// 三个刻意的决定：
// 1. **只写 `never`**。本扩展没有自动翻译，`action: 'translate'` 今天不产生任何可观察行为
//    （规格 §5），所以这一行给的是**静态文字**而不是下拉——一个只有一项的下拉是假控件。
// 2. **域名在失焦时规范化 + 校验**（`../rule-pattern.ts`）：核心匹配器对不认识的写法
//    静默不命中，这一侧的责任就是在写入前挡住或者救回来。
// 3. **草稿行不写存储**（同术语表）：空白规则在核心那边是"什么都不匹配"，
//    但让它进存储只会让列表里多一条看着像规则的空行。
import { element, setStatus } from '../dom';
import { normalizeRulePattern } from '../rule-pattern';
import type { SiteRule } from '../../shared/settings';
import type { Section, SectionContext } from '../section';

const list = document.getElementById('site-rules-list') as HTMLElement;
const addButton = document.getElementById('add-rule') as HTMLButtonElement;
const status = document.getElementById('site-rules-status') as HTMLElement;

/** 草稿行在不在页面上（它没有存储对应物）。与术语表同一套模型。 */
let draftOpen = false;

function rowsOf(): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>('[data-rule-row]'));
}

function inputWithin(row: HTMLElement): HTMLInputElement {
  const input = row.querySelector<HTMLInputElement>('.rule-pattern');
  if (input === null) throw new Error('规则行缺控件 .rule-pattern');
  return input;
}

/** 造一行。域名走 `.value`（不是 HTML 解析），动作是静态文字。 */
function buildRow(index: number, rule: SiteRule | null): HTMLElement {
  const row = element('div', 'item');
  row.dataset.ruleRow = '';
  row.dataset.index = String(index);
  if (rule === null) row.dataset.draft = '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rule-pattern';
  input.setAttribute('aria-label', '域名');
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'example.com 或 *.example.com';
  input.value = rule?.pattern ?? '';

  const action = element('span', 'rule-action', '永不翻译');
  // 动作也要是**契约属性**：将来补「总是翻译」时，这个属性就是扩成下拉的落点。
  action.dataset.ruleAction = 'never';

  const remove = element('button', 'link-danger', '删除');
  remove.type = 'button';
  remove.dataset.action = 'delete-rule';

  row.append(input, action, remove);
  return row;
}

function renderRows(ctx: SectionContext): void {
  const rules = ctx.settings()?.siteRules ?? [];
  list.textContent = '';
  rules.forEach((rule, index) => list.append(buildRow(index, rule)));
  if (draftOpen) list.append(buildRow(rules.length, null));
  addButton.disabled = draftOpen;
}

async function writeRules(ctx: SectionContext, rules: SiteRule[], prefix: string, okMessage: string): Promise<boolean> {
  const ok = await ctx.save(status, prefix, { siteRules: rules }, okMessage);
  if (ok) renderRows(ctx);
  return ok;
}

/**
 * 一行的 `change`（＝失焦且值变了）：
 * - 规范化成功：既有行就地更新，草稿行追加成新条目，并把**规范化后的值写回输入框**；
 * - 规范化失败：**不写存储**，把原因说给用户听（输入框保留原文，让他能改）；
 * - 空：草稿行 → 什么都不做（等用户接着填）；**既有行 → 不写存储**，只说明"存储里仍是原来
 *   那条，要删请点行尾「删除」"。与术语表同一条口径（见 `sections/glossary.ts` 的注释）：
 *   在失焦那一刻顺手删条目 + 重绘，会让**用户正在编辑的一行当场消失**，而这份界面没有撤销出口。
 */
async function commitRow(ctx: SectionContext, row: HTMLElement): Promise<void> {
  const current = ctx.settings();
  if (current === null) return;
  const index = Number(row.dataset.index);
  const input = inputWithin(row);
  const raw = input.value.trim();
  const rules = current.siteRules;

  if (raw.length === 0) {
    if (index >= rules.length) return; // 草稿行空着：等他填，不写存储
    setStatus(status, 'err', '这一条规则没有域名，没有保存；存储里仍是原来那条（要删掉请点行尾「删除」）');
    return;
  }

  const normalized = normalizeRulePattern(raw);
  if (!normalized.ok) {
    // 不写存储，也不假装成功：核心那边这条规则只会静默永不命中。
    setStatus(status, 'err', normalized.reason);
    return;
  }
  input.value = normalized.pattern;
  const next: SiteRule = { pattern: normalized.pattern, action: 'never' };
  const merged = index < rules.length ? rules.map((rule, at) => (at === index ? next : rule)) : [...rules, next];
  draftOpen = false;
  await writeRules(ctx, merged, '保存规则失败', `已保存（按 ${normalized.pattern} 匹配）`);
}

function deleteRow(ctx: SectionContext, row: HTMLElement): void {
  const current = ctx.settings();
  if (current === null) return;
  const index = Number(row.dataset.index);
  if (index >= current.siteRules.length) {
    draftOpen = false;
    renderRows(ctx);
    setStatus(status, 'ok', '');
    return;
  }
  void writeRules(ctx, current.siteRules.filter((_, at) => at !== index), '删除规则失败', '已删除');
}

export const siteRulesSection: Section = {
  id: 'site-rules',
  title: '站点规则',
  aliases: ['域名', '站点', '网站', '规则', '永不翻译', '黑名单'],

  bind(ctx: SectionContext): void {
    addButton.addEventListener('click', () => {
      if (ctx.settings() === null) {
        setStatus(status, 'err', '设置还没读出来，请稍候重试');
        return;
      }
      draftOpen = true;
      renderRows(ctx);
      rowsOf().at(-1)?.querySelector<HTMLInputElement>('.rule-pattern')?.focus();
    });

    list.addEventListener('change', (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest<HTMLElement>('[data-rule-row]');
      if (row === null) return;
      void commitRow(ctx, row);
    });

    list.addEventListener('click', (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.dataset.action !== 'delete-rule') return;
      const row = target.closest<HTMLElement>('[data-rule-row]');
      if (row === null) return;
      deleteRow(ctx, row);
    });
  },

  mount(ctx: SectionContext): void {
    renderRows(ctx);
  },
};
```

`src/options/options.ts` 加 import 与清单项：

```ts
import { siteRulesSection } from './sections/site-rules';
```

```ts
export const SECTIONS: readonly Section[] = [
  engineSection,
  languageSection,
  shortcutsSection,
  glossarySection,
  siteRulesSection,
  cacheSection,
  privacySection,
];
```

- [ ] **Step 9: 跑到绿**

Run: `npx vitest run tests/options/site-rules.test.ts tests/options/rule-pattern.test.ts`
Expected: PASS —— **9 条 + 11 条**

- [ ] **Step 10: 变异验证**

| 变异 | 期望红在哪一条 |
| --- | --- |
| `if (!normalized.ok) { setStatus(...); return; }` 删掉（非法也写） | 「非法形状不写存储并说清为什么」 |
| 空域名那一支的 `setStatus(status,'err', …)` 改成 `await writeRules(… filter …)`（＝上一版计划的"顺手删掉"） | 「既有行的域名被清空：**不写存储**、给一句能读懂的话」 |
| `input.value = normalized.pattern` 删掉 | 「整条网址被规范化成主机名」的第二个断言 |
| `{ pattern: normalized.pattern, action: 'never' }` 改成 `action: 'translate'` | 「加一条规则…动作写的是 never」 |
| `rule-pattern.ts` 里 `hadPort` 那条判断删掉（`example.com:8080` 会走 `https://example.com:8080` → hostname 是 `example.com`） | 「带端口的写法」与页面上的「端口」用例 |
| `HOSTNAME` 的 `(?:\.…)*` 改回 `(?:\.…)+`（要求至少一个点） | 「单标签主机名照收（localhost / 内网短名）」——**已决**：单标签是合法的核心规则，不拒 |
| `hadPath` 那条判断删掉（`https://example.com/docs` 会被静默截成 `example.com`） | 「带路径的网址」 |

- [ ] **Step 11: 提交**

```bash
git add src/options/rule-pattern.ts src/options/sections/site-rules.ts src/options/options.html \
  src/options/options.css src/options/options.ts tests/options/rule-pattern.test.ts \
  tests/options/site-rules.test.ts
git commit -m "feat(options): 站点规则写入侧（增删规则 + 域名规范化 + 只提供永不翻译）"
```

---

## Task 7: 自定义提示词区块（§3.6）

**Files:**
- Create: `src/options/sections/prompt.ts`
- Create: `tests/options/prompt.test.ts`
- Modify: `src/options/options.html`（内容控制组里加导航项 + 区块）
- Modify: `src/options/options.ts`（import + `SECTIONS` 插到 `siteRulesSection` 之后）

> 多行文本，**留空即使用内置提示词**（`openai-compat.ts` 的 `buildMessages` 里
> `systemPrompt.trim().length > 0` 才追加）。文本类 → 失焦（`change`）才写。

- [ ] **Step 1: 写失败测试**

创建 `tests/options/prompt.test.ts`：

```ts
// tests/options/prompt.test.ts
/**
 * @vitest-environment jsdom
 *
 * §3.6 自定义提示词：多行文本、失焦才写、留空即内置。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { bubble, chromeStub, loadOptions, pick, resetOptionsPage, seedSettings, storedSettings, waitFor } from './harness';

function textarea(): HTMLTextAreaElement {
  return pick<HTMLTextAreaElement>('system-prompt');
}

function status(): HTMLElement {
  return pick<HTMLElement>('prompt-status');
}

beforeEach(() => {
  resetOptionsPage();
});

describe('设置页：自定义提示词', () => {
  it('按存储回填（多行原样）', async () => {
    await seedSettings({ systemPrompt: 'IT 术语保留英文原文。\n数字与单位不改动。' });
    await loadOptions();

    expect(textarea().value).toBe('IT 术语保留英文原文。\n数字与单位不改动。');
  });

  it('打字过程中存储不变，失焦（change）之后才写', async () => {
    await seedSettings({ systemPrompt: '' });
    await loadOptions();

    textarea().value = '语气正式一点';
    textarea().dispatchEvent(bubble('input'));
    expect((await storedSettings()).systemPrompt).toBe('');

    textarea().dispatchEvent(bubble('change'));
    await waitFor(async () => (await storedSettings()).systemPrompt === '语气正式一点');
    expect(status().dataset.kind).toBe('ok');
  });

  it('清空即回到内置提示词：存储里是空串，不是空白串', async () => {
    await seedSettings({ systemPrompt: '先前的提示词' });
    await loadOptions();

    textarea().value = '';
    textarea().dispatchEvent(bubble('change'));

    await waitFor(async () => (await storedSettings()).systemPrompt === '');
    expect((await storedSettings()).systemPrompt).toBe('');
  });

  it('前后空白原样存进去（存的是用户敲的那一份，判断"空不空"是消费者的事）', async () => {
    // 这条是**决策**不是装饰：存 `value` 还是存 `value.trim()` 只能选一个。
    // 选"原样"的理由：消费者（`openai-compat.ts` 的 buildMessages）本来就 `trim()` 之后再判断
    // 追加与否，所以两边都 trim 只会让"界面里看到的"与"存储里的"不一致；而界面上显示的
    // 永远是 textarea 里的原文。这条用例把选择钉住——谁把实现改成 `.trim()`，这里当场红。
    await seedSettings({ systemPrompt: '' });
    await loadOptions();

    textarea().value = '  语气正式一点  ';
    textarea().dispatchEvent(bubble('change'));

    await waitFor(async () => (await storedSettings()).systemPrompt === '  语气正式一点  ');
    expect((await storedSettings()).systemPrompt).toBe('  语气正式一点  ');
  });

  it('写入被拒时如实报错，界面不假装成功', async () => {
    await seedSettings({ systemPrompt: '' });
    await loadOptions();
    chromeStub.storage.local.set = async () => {
      throw new Error('存储写入失败');
    };

    textarea().value = '写不进去';
    textarea().dispatchEvent(bubble('change'));

    await waitFor(() => status().dataset.kind === 'err');
    expect(status().textContent).toContain('保存提示词失败');
    expect((await storedSettings()).systemPrompt).toBe('');
  });
});
```

- [ ] **Step 2: 跑到红**

Run: `npx vitest run tests/options/prompt.test.ts`
Expected: FAIL —— `options.html 里没有 #system-prompt`

- [ ] **Step 3: 加导航项与区块**

`src/options/options.html`：

① 「内容控制」组里，在 `站点规则` 那一行之后插入：

```html
          <a class="nav-link" href="#sec-prompt" data-nav="prompt"><span class="i" aria-hidden="true">✎</span>提示词</a>
```

② 在 `<!-- 缓存与请求 -->` 之前插入：

```html
        <!-- 自定义提示词 -->
        <section class="sec" id="sec-prompt" data-section="prompt" aria-labelledby="sec-prompt-title">
          <div class="sec-head"><h2 id="sec-prompt-title">自定义提示词</h2></div>
          <p class="sec-desc">追加到系统提示，用来固定语气与文体。<strong>留空即使用内置提示词。</strong></p>
          <div class="group">
            <div class="field">
              <label class="lab" for="system-prompt">系统提示词<small>只会追加在内置提示之后，不会覆盖它</small></label>
            </div>
            <div class="field">
              <textarea id="system-prompt" rows="4" placeholder="例如：IT 术语保留英文原文，不强行翻译；数字与单位不改动。"></textarea>
            </div>
          </div>
          <p class="hint">改动在失焦时保存；下一次翻译生效（提示词是缓存键的一部分，改过之后同样的段落会重新翻译一次）。</p>
          <p id="prompt-status" class="status" role="status" aria-live="polite"></p>
        </section>

```

- [ ] **Step 4: 写实现**

创建 `src/options/sections/prompt.ts`：

```ts
// src/options/sections/prompt.ts
//
// §3.6 自定义提示词。文本类 → 失焦才写（§4.1），落成原生 `change`：
// 对文本控件它的触发时机就是"失焦且值变了"，不写存储就不会有第二次写入。
//
// **留空即内置**：存储里存空串，消费者（`engines/openai-compat.ts` 的 buildMessages）
// 用 `systemPrompt.trim().length > 0` 判断要不要追加，所以用户清空之后行为自动回到内置。
import type { Section, SectionContext } from '../section';

const promptArea = document.getElementById('system-prompt') as HTMLTextAreaElement;
const status = document.getElementById('prompt-status') as HTMLElement;

export const promptSection: Section = {
  id: 'prompt',
  title: '自定义提示词',
  aliases: ['提示词', 'prompt', '系统提示', '语气', '文体'],

  bind(ctx: SectionContext): void {
    promptArea.addEventListener('change', () => {
      // 存**原文**（不 trim）：消费者自己会 trim，界面里显示的与存储里的保持一字不差。
      // `ctx.save` 不抛（成功/失败都进状态行），所以这里不需要额外的兜底包装。
      void ctx.save(status, '保存提示词失败', { systemPrompt: promptArea.value });
    });
  },

  mount(ctx: SectionContext): void {
    const current = ctx.settings();
    if (current === null) return;
    promptArea.value = current.systemPrompt;
  },
};
```

`src/options/options.ts` 加 import 与清单项：

```ts
import { promptSection } from './sections/prompt';
```

```ts
export const SECTIONS: readonly Section[] = [
  engineSection,
  languageSection,
  shortcutsSection,
  glossarySection,
  siteRulesSection,
  promptSection,
  cacheSection,
  privacySection,
];
```

- [ ] **Step 5: 跑到绿**

Run: `npx vitest run tests/options/prompt.test.ts`
Expected: PASS —— **5 条用例**

- [ ] **Step 6: 变异验证**

| 变异 | 期望红在哪一条 |
| --- | --- |
| `'change'` 改成 `'input'` | 「打字过程中存储不变…」 |
| `{ systemPrompt: promptArea.value }` 改成 `{ systemPrompt: promptArea.value.trim() }` | 「前后空白原样存进去」——**已决**：存原样（消费者自己 trim），这条用例就是那个决定的见证 |
| `mount` 里的 `promptArea.value = current.systemPrompt` 删掉 | 「按存储回填（多行原样）」 |

- [ ] **Step 7: 提交**

```bash
git add src/options/sections/prompt.ts src/options/options.html src/options/options.ts \
  tests/options/prompt.test.ts
git commit -m "feat(options): 自定义提示词区块（失焦保存、留空即内置）"
```

---

## Task 8: 缓存与请求区块补齐（§3.7）

**Files:**
- Modify: `src/options/sections/cache.ts`（**整体替换**成完整版）
- Modify: `src/options/options.html`（缓存区块整段替换）
- Modify: `src/options/options.css`（加 `.stat`）
- Create: `tests/options/cache-section.test.ts`

> 三个统计数字（已缓存 / 上限 / 并发）、缓存上限、清除按钮，`<details>` 里放并发与批量三项。
> **数字控件的保存时机**也是 `change`：数字输入框的 `change` 原生就在提交时（失焦或回车）触发，
> 所以它天然满足"别边打字边写存储"，不需要额外规则。
>
> **越界必须回填**：存储层（`mergeSettings` 的 `clampInt`）会把 `999` 夹成 `8`。输入框里留着
> `999` 就是界面撒谎，所以写回后**读回生效值并回填**，并在被夹取时说清"实际生效 8，允许范围 1–8"。
> `min` / `max` 与 `mergeSettings` 的夹取范围**同源**这件事由测试钉住（那四个数字在两处各写了一份，
> 是真正的漂移风险）。

- [ ] **Step 1: 写失败测试**

创建 `tests/options/cache-section.test.ts`：

```ts
// tests/options/cache-section.test.ts
/**
 * @vitest-environment jsdom
 *
 * §3.7 缓存与请求：三个统计数字、缓存上限、高级折叠里的并发与批量。
 * 「清除」按钮本身的既有用例在 `options.test.ts`（文案与两层语义一字不改），这里补的是新增部分。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_VERSION, mergeSettings } from '../../src/shared/settings';
import { bubble, chromeStub, loadOptions, pick, resetOptionsPage, seedSettings, storedSettings, waitFor } from './harness';

interface NumberFieldCase {
  id: string;
  field: 'cacheMaxEntries' | 'concurrency' | 'maxBatchChars' | 'maxSegmentsPerBatch';
  min: number;
  max: number;
}

const NUMBER_FIELDS: NumberFieldCase[] = [
  { id: 'cache-max-entries', field: 'cacheMaxEntries', min: 100, max: 50000 },
  { id: 'concurrency', field: 'concurrency', min: 1, max: 8 },
  { id: 'max-batch-chars', field: 'maxBatchChars', min: 200, max: 8000 },
  { id: 'max-segments-per-batch', field: 'maxSegmentsPerBatch', min: 1, max: 50 },
];

function inputOf(id: string): HTMLInputElement {
  return pick<HTMLInputElement>(id);
}

function status(): HTMLElement {
  return pick<HTMLElement>('cache-status');
}

/** 填一个数字并"失焦"：值改掉 → 派发冒泡的 change。 */
function commitNumber(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(bubble('change'));
}

beforeEach(() => {
  resetOptionsPage();
});

describe('设置页：缓存与请求', () => {
  it('三个统计数字：已缓存是两层合计，上限与并发跟着设置走', async () => {
    await seedSettings({ cacheMaxEntries: 5000, concurrency: 3 });
    await chromeStub.storage.local.set({
      'jt:a': { v: '一', t: 1 },
      'jt:b': { v: '二', t: 2 },
    });
    await chromeStub.storage.session.set({ 'jt:s': { v: '会话层', t: 3 } });
    await loadOptions();

    await waitFor(() => pick<HTMLElement>('stat-cached').textContent === '3');
    expect(pick<HTMLElement>('stat-max').textContent).toBe('5000');
    expect(pick<HTMLElement>('stat-concurrency').textContent).toBe('3');
  });

  it('清除之后统计归零（按钮的既有文案一字不改）', async () => {
    await seedSettings();
    await chromeStub.storage.local.set({ 'jt:a': { v: '一', t: 1 } });
    await loadOptions();
    await waitFor(() => pick<HTMLElement>('stat-cached').textContent === '1');

    pick<HTMLButtonElement>('clear-cache').click();

    await waitFor(() => (status().textContent ?? '').includes('已清除 1 条翻译缓存'));
    await waitFor(() => pick<HTMLElement>('stat-cached').textContent === '0');
  });

  it('缓存上限改动即落盘，统计里的「上限」跟着变', async () => {
    await seedSettings({ cacheMaxEntries: 5000 });
    await loadOptions();

    commitNumber(inputOf('cache-max-entries'), '9000');

    await waitFor(async () => (await storedSettings()).cacheMaxEntries === 9000);
    expect(pick<HTMLElement>('stat-max').textContent).toBe('9000');
    expect(inputOf('cache-max-entries').value).toBe('9000');
  });

  it('越界的数字被夹到允许范围：存储里是生效值，输入框回填生效值，并说清实际生效多少', async () => {
    await seedSettings({ concurrency: 3 });
    await loadOptions();

    commitNumber(inputOf('concurrency'), '999');

    await waitFor(async () => (await storedSettings()).concurrency === 8);
    // 界面不许继续显示 999：那是个没生效的数字。
    expect(inputOf('concurrency').value).toBe('8');
    expect(status().textContent).toContain('实际生效 8');
    expect(pick<HTMLElement>('stat-concurrency').textContent).toBe('8');
  });

  it('清空或乱填：拨回存储里真正生效的值并报错，不写存储', async () => {
    await seedSettings({ maxBatchChars: 1000 });
    await loadOptions();

    commitNumber(inputOf('max-batch-chars'), '');

    await waitFor(() => status().dataset.kind === 'err');
    expect(inputOf('max-batch-chars').value).toBe('1000');
    expect((await storedSettings()).maxBatchChars).toBe(1000);

    commitNumber(inputOf('max-batch-chars'), 'abc');
    await waitFor(() => (status().textContent ?? '').includes('要填一个数字'));
    expect(inputOf('max-batch-chars').value).toBe('1000');
  });

  it('四个数字的 min/max 与存储层的夹取范围同源（两处各写了一份，这是防漂移的那条断言）', () => {
    for (const entry of NUMBER_FIELDS) {
      const input = inputOf(entry.id);
      expect(`${entry.id} min=${input.min}`).toBe(`${entry.id} min=${entry.min}`);
      expect(`${entry.id} max=${input.max}`).toBe(`${entry.id} max=${entry.max}`);
      // 夹取边界必须与 mergeSettings 的实际行为一致：低一档被抬到 min，高一档被压到 max。
      const low = mergeSettings({ [entry.field]: entry.min - 1 }, CURRENT_VERSION)[entry.field];
      const high = mergeSettings({ [entry.field]: entry.max + 1 }, CURRENT_VERSION)[entry.field];
      expect(`${entry.field} low=${low}`).toBe(`${entry.field} low=${entry.min}`);
      expect(`${entry.field} high=${high}`).toBe(`${entry.field} high=${entry.max}`);
    }
  });

  it('高级项默认收在 details 里，三项都在；改动即落盘', async () => {
    await seedSettings();
    await loadOptions();

    expect(pick<HTMLDetailsElement>('cache-advanced').open).toBe(false);
    expect(inputOf('concurrency').value).toBe('3');
    expect(inputOf('max-batch-chars').value).toBe('1000');
    expect(inputOf('max-segments-per-batch').value).toBe('12');

    commitNumber(inputOf('max-segments-per-batch'), '20');
    await waitFor(async () => (await storedSettings()).maxSegmentsPerBatch === 20);
  });

  it('写入被拒时把输入框拨回真正生效的值并报错', async () => {
    await seedSettings({ concurrency: 3 });
    await loadOptions();
    chromeStub.storage.local.set = async () => {
      throw new Error('存储写入失败');
    };

    commitNumber(inputOf('concurrency'), '5');

    await waitFor(() => status().dataset.kind === 'err');
    expect(status().textContent).toContain('保存并发请求数失败');
    expect(inputOf('concurrency').value).toBe('3');
  });
});
```

- [ ] **Step 2: 跑到红**

Run: `npx vitest run tests/options/cache-section.test.ts`
Expected: FAIL —— `options.html 里没有 #stat-cached`

- [ ] **Step 3: 替换缓存区块的 HTML**

`src/options/options.html` 里，把 Task 3 那一段 `<!-- 缓存与请求 -->` 的整个 `<section …>` 换成：

```html
        <!-- 缓存与请求 -->
        <section class="sec" id="sec-cache" data-section="cache" aria-labelledby="sec-cache-title">
          <div class="sec-head"><h2 id="sec-cache-title">缓存与请求</h2></div>
          <div class="stat">
            <div><b id="stat-cached">—</b>已缓存段落</div>
            <div><b id="stat-max">—</b>缓存上限</div>
            <div><b id="stat-concurrency">—</b>并发请求</div>
          </div>
          <div class="group">
            <div class="field">
              <label class="lab" for="cache-max-entries">缓存上限<small>条，超出后按最久未用淘汰</small></label>
              <input id="cache-max-entries" type="number" min="100" max="50000" step="100" />
            </div>
            <div class="grow2">
              <div class="lab">清除翻译缓存<span>同时清掉会话层与持久层，之后所有页面都要重翻一次</span></div>
              <button id="clear-cache" class="ghost tiny" type="button">清除</button>
            </div>
          </div>
          <p class="hint">
            缓存里存的是原文与译文，不含 API Key。「清除」会<strong>同时清掉会话层与持久层</strong>两层缓存，
            清完后所有页面都要重新翻译一次（报出的条数是两层合计）。
          </p>
          <details id="cache-advanced">
            <summary>高级：批量与并发</summary>
            <div class="group">
              <div class="field">
                <label class="lab" for="concurrency">并发请求数<small>1–8，接口限流严就调低</small></label>
                <input id="concurrency" type="number" min="1" max="8" step="1" />
              </div>
              <div class="field">
                <label class="lab" for="max-batch-chars">单批字符上限<small>200–8000</small></label>
                <input id="max-batch-chars" type="number" min="200" max="8000" step="100" />
              </div>
              <div class="field">
                <label class="lab" for="max-segments-per-batch">单批段数上限<small>1–50</small></label>
                <input id="max-segments-per-batch" type="number" min="1" max="50" step="1" />
              </div>
            </div>
            <p>这三项默认不用动。放在折叠里而不是删掉，是因为设置里已经有这些字段，藏起来比砍掉便宜。</p>
          </details>
          <p id="cache-status" class="status" role="status" aria-live="polite"></p>
        </section>
```

`src/options/options.css` 的 `.add` 规则之后加 `.stat`：

```css
/* 统计数字：一行三个，数字大、单位小（数字是重点，说明只是注脚）。 */
.stat {
  display: flex;
  flex-wrap: wrap;
  gap: 26px;
  margin-bottom: 14px;
}

.stat div {
  font-size: 11.5px;
  color: var(--text-3);
}

.stat b {
  display: block;
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: var(--text);
}
```

- [ ] **Step 4: 把 `sections/cache.ts` 换成完整版**

用下面的内容**整体替换** `src/options/sections/cache.ts`：

```ts
// src/options/sections/cache.ts
//
// §3.7 缓存与请求：三个统计数字、缓存上限、清除按钮，`<details>` 里放并发与批量三项。
//
// 两条纪律：
// 1. **清除要清两层**（持久层 + 会话层），报的数是两层合计——只清持久层的话，用户点完
//    "清除"立刻重译页面照样零请求命中（`TieredCache` 先查会话层），按钮看起来失灵。
// 2. **越界值要回填**：`mergeSettings` 的 clampInt 会把 999 夹成 8，输入框继续显示 999
//    就是界面撒谎。写回后一律把**生效值**读回来填进输入框。
import { TranslationCache } from '../../core/cache';
import { chromeArea } from '../../shared/chrome-area';
import type { Settings } from '../../shared/settings';
import { describe, runSafely, setStatus } from '../dom';
import type { Section, SectionContext } from '../section';

const statCached = document.getElementById('stat-cached') as HTMLElement;
const statMax = document.getElementById('stat-max') as HTMLElement;
const statConcurrency = document.getElementById('stat-concurrency') as HTMLElement;
const maxEntriesInput = document.getElementById('cache-max-entries') as HTMLInputElement;
const concurrencyInput = document.getElementById('concurrency') as HTMLInputElement;
const maxBatchCharsInput = document.getElementById('max-batch-chars') as HTMLInputElement;
const maxSegmentsInput = document.getElementById('max-segments-per-batch') as HTMLInputElement;
const clearCacheButton = document.getElementById('clear-cache') as HTMLButtonElement;
const cacheStatus = document.getElementById('cache-status') as HTMLElement;

type NumberField = 'cacheMaxEntries' | 'concurrency' | 'maxBatchChars' | 'maxSegmentsPerBatch';

/** 数字字段与它的控件、标题：遍历着绑定与回填，免得四处各写一遍。 */
const NUMBER_FIELDS: ReadonlyArray<{ input: HTMLInputElement; field: NumberField; label: string }> = [
  { input: maxEntriesInput, field: 'cacheMaxEntries', label: '缓存上限' },
  { input: concurrencyInput, field: 'concurrency', label: '并发请求数' },
  { input: maxBatchCharsInput, field: 'maxBatchChars', label: '单批字符上限' },
  { input: maxSegmentsInput, field: 'maxSegmentsPerBatch', label: '单批段数上限' },
];

/** 显式逐个构造增量：计算属性 `{ [field]: value }` 会被 TS 放宽成 `{[x: string]: number}`。 */
function patchFor(field: NumberField, value: number): Partial<Settings> {
  if (field === 'cacheMaxEntries') return { cacheMaxEntries: value };
  if (field === 'concurrency') return { concurrency: value };
  if (field === 'maxBatchChars') return { maxBatchChars: value };
  return { maxSegmentsPerBatch: value };
}

/** 两层缓存的构造收在一处，免得两边的 maxEntries 参数漂移。 */
function caches(maxEntries: number | undefined): { persistent: TranslationCache; session: TranslationCache } {
  return {
    persistent: new TranslationCache(chromeArea(chrome.storage.local), maxEntries),
    session: new TranslationCache(chromeArea(chrome.storage.session), maxEntries),
  };
}

/** 已缓存段落数 = 两层各自真实条目数之和（与「清除」报的数是同一个口径）。 */
async function countCached(maxEntries: number | undefined): Promise<number> {
  const { persistent, session } = caches(maxEntries);
  const [persistentCount, sessionCount] = await Promise.all([persistent.count(), session.count()]);
  return persistentCount + sessionCount;
}

/** 把三个统计数字与四个输入框刷成当前设置的样子。 */
async function refreshStats(ctx: SectionContext): Promise<void> {
  const current = ctx.settings();
  if (current === null) return;
  statMax.textContent = String(current.cacheMaxEntries);
  statConcurrency.textContent = String(current.concurrency);
  for (const entry of NUMBER_FIELDS) entry.input.value = String(current[entry.field]);
  try {
    statCached.textContent = String(await countCached(current.cacheMaxEntries));
  } catch (raw) {
    // 数不出来不是致命错误，但**绝不能显示成 0**：那是在说"缓存是空的"。
    statCached.textContent = '—';
    setStatus(cacheStatus, 'err', `读取缓存条数失败：${describe(raw)}`);
  }
}

/**
 * 清除翻译缓存：删掉**两层**（持久层 + 会话层）全部 `jt:` 前缀的键。
 *
 * 用 `TranslationCache` 而不是自己拼 `jt:` 前缀：缓存的键名、元数据键、形状坏掉的残留
 * 都归它管（`clear()` 就是为这件事写的）。设置页是扩展自身的受信页面（`chrome-extension://`
 * 同源），可以直接访问 `chrome.storage.session`，不需要绕道后台消息。
 */
async function handleClearCache(ctx: SectionContext): Promise<void> {
  const { persistent, session } = caches(ctx.settings()?.cacheMaxEntries);
  const [persistentBefore, sessionBefore] = await Promise.all([persistent.count(), session.count()]);
  await Promise.all([persistent.clear(), session.clear()]);
  const cleared = persistentBefore + sessionBefore;
  // 统计跟着走：清完还显示旧条数，用户会以为按钮没生效。
  // 顺序是"先刷数字、再写结果"：`refreshStats` 只在数不出来时写状态行，而按钮的结果是
  // 用户这一下的直接反馈，必须留在最上面（数不出来时统计本身就显示成 `—`，看得出来）。
  await refreshStats(ctx);
  setStatus(cacheStatus, 'ok', cleared === 0 ? '缓存本来就是空的' : `已清除 ${cleared} 条翻译缓存`);
}

/** 数字控件的提交：非法拨回、合法写回、越界回填生效值。 */
function commitNumber(ctx: SectionContext, input: HTMLInputElement, field: NumberField, label: string): void {
  void (async () => {
    const current = ctx.settings();
    if (current === null) {
      setStatus(cacheStatus, 'err', '设置还没读出来，请稍候重试');
      return;
    }
    const parsed = Number(input.value);
    if (input.value.trim().length === 0 || !Number.isFinite(parsed)) {
      input.value = String(current[field]);
      setStatus(cacheStatus, 'err', `${label}要填一个数字`);
      return;
    }
    const ok = await ctx.save(cacheStatus, `保存${label}失败`, patchFor(field, parsed));
    const after = ctx.settings();
    if (after === null) return;
    if (!ok) {
      // 写失败：拨回存储里真正生效的值，别让输入框停在一个没生效的数字上。
      input.value = String(current[field]);
      return;
    }
    const effective = after[field];
    if (effective !== parsed) {
      setStatus(cacheStatus, 'ok', `已保存（实际生效 ${effective}，允许范围 ${input.min}–${input.max}）`);
    }
    input.value = String(effective);
    statMax.textContent = String(after.cacheMaxEntries);
    statConcurrency.textContent = String(after.concurrency);
  })();
}

export const cacheSection: Section = {
  id: 'cache',
  title: '缓存与请求',
  aliases: ['缓存', '清除缓存', '上限', '并发', '批量'],

  bind(ctx: SectionContext): void {
    clearCacheButton.addEventListener('click', () => runSafely(cacheStatus, '清除缓存失败', () => handleClearCache(ctx)));
    for (const entry of NUMBER_FIELDS) {
      entry.input.addEventListener('change', () => commitNumber(ctx, entry.input, entry.field, entry.label));
    }
  },

  mount(ctx: SectionContext): Promise<void> {
    return refreshStats(ctx);
  },
};
```

- [ ] **Step 5: 跑到绿**

Run: `npx vitest run tests/options/cache-section.test.ts tests/options/options.test.ts`
Expected: PASS —— **8 条 + 29 条**（既有的三条清除缓存用例一条都不许红）

- [ ] **Step 6: 变异验证**

| 变异 | 期望红在哪一条 |
| --- | --- |
| `input.value = String(effective)` 删掉 | 「越界的数字被夹到允许范围」 |
| `if (!ok) { input.value = String(current[field]); return; }` 整块删掉 | 「写入被拒时把输入框拨回真正生效的值」 |
| HTML 的 `min="1" max="8"` 改成 `min="1" max="7"` | 「四个数字的 min/max 与存储层的夹取范围同源」 |
| `handleClearCache` 里 `await refreshStats(ctx)` 删掉 | 「清除之后统计归零」 |
| `countCached` 只数持久层（删掉 session 那一半） | 「三个统计数字」（3 会变成 2） |
| `mount` 不再调 `refreshStats` | 「高级项默认收在 details 里…」里的三个回填断言 |

- [ ] **Step 7: 提交**

```bash
git add src/options/sections/cache.ts src/options/options.html src/options/options.css \
  tests/options/cache-section.test.ts
git commit -m "feat(options): 缓存与请求区块补齐（三个统计 + 上限 + 高级折叠，越界值回填生效值）"
```

---

## Task 9: 搜索（§4.2）+ 区块清单结构守卫

**Files:**
- Create: `src/options/search.ts`
- Create: `tests/options/search.test.ts`
- Modify: `src/options/options.html`（搜索框 + 「没找到」那一行）
- Modify: `src/options/options.css`（`.search` / `.mag` / `.search-empty` / `[hidden]`）
- Modify: `src/options/options.ts`（`createSearch` 接线）

> 轻量版：**只过滤区块与字段标签**，靠与区块定义放在一起的别名表；零命中显示「没找到」而不是
> 留白；占位符写「搜索设置」，**不写**「搜索所有设置」。过滤只切 `hidden`，**不动 DOM 结构**
> （规格 §4.2 明确点出这是为了不与测试契约打架）。

- [ ] **Step 1: 写失败测试**

创建 `tests/options/search.test.ts`：

```ts
// tests/options/search.test.ts
/**
 * @vitest-environment jsdom
 *
 * §4.2 搜索（轻量版）+ 区块清单的结构守卫。
 *
 * 结构守卫那一段是这一轮"8 组信息架构"的机械保证：导航项、区块元素、搜索索引三者都由
 * `options.ts` 的 `SECTIONS` 驱动，一旦有人加了区块却忘了导航项（或反过来），这里当场红。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { matchesTerms, parseQuery } from '../../src/options/search';
import { bubble, loadOptions, pick, resetOptionsPage, seedSettings } from './harness';

/** 当前**可见**（没有 `hidden`）的区块 id，按页面顺序。 */
function visibleSections(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-section]'))
    .filter((section) => !section.hidden)
    .map((section) => section.dataset.section as string);
}

function search(query: string): void {
  const input = pick<HTMLInputElement>('search');
  input.value = query;
  input.dispatchEvent(bubble('input'));
}

beforeEach(() => {
  resetOptionsPage();
});

describe('搜索：查询解析与匹配（纯函数）', () => {
  it('空查询不过滤；查询按空白切词、折小写', () => {
    expect(parseQuery('   ')).toEqual([]);
    expect(parseQuery('API  Key')).toEqual(['api', 'key']);
  });

  it('全部命中才算命中（AND，不是 OR）', () => {
    const haystack = ['翻译引擎', 'API Key', '密钥'];
    expect(matchesTerms(haystack, parseQuery('密钥'))).toBe(true);
    expect(matchesTerms(haystack, parseQuery('KEY'))).toBe(true);
    expect(matchesTerms(haystack, parseQuery('密钥 引擎'))).toBe(true);
    // 两个词分属不同区块时，不该因为"任一词命中"就显示出来。
    expect(matchesTerms(haystack, parseQuery('密钥 术语'))).toBe(false);
  });
});

describe('搜索：过滤的是区块，不是 DOM 结构', () => {
  it('占位符写「搜索设置」，不承诺搜不到的一切', async () => {
    await seedSettings();
    await loadOptions();

    expect(pick<HTMLInputElement>('search').placeholder).toBe('搜索设置');
    expect(pick<HTMLInputElement>('search').placeholder).not.toContain('所有');
  });

  it('命中「密钥」只留下翻译引擎：别名指向**真正含该字段**的区块', async () => {
    await seedSettings();
    await loadOptions();

    search('密钥');

    expect(visibleSections()).toEqual(['engine']);
    // 导航项跟着一起藏：点一个能跳到被藏起来的区块的链接没有意义。
    expect(document.querySelector<HTMLElement>('[data-nav="glossary"]')?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-nav="engine"]')?.hidden).toBe(false);
    expect(pick<HTMLElement>('search-empty').hidden).toBe(true);
    // 结构不动：区块元素还在，只是 hidden。
    expect(document.querySelectorAll('[data-section]')).toHaveLength(8);
  });

  it('命中「词库」「专有名词」只留下术语表（与「密钥」成对，防两处漂移）', async () => {
    await seedSettings();
    await loadOptions();

    search('词库');
    expect(visibleSections()).toEqual(['glossary']);

    search('专有名词');
    expect(visibleSections()).toEqual(['glossary']);

    search('API Key');
    expect(visibleSections()).toEqual(['engine']);
  });

  it('隐私区块那一大段正文**不进索引**：搜「密钥」「API Key」「档案」都不点亮隐私', async () => {
    // 这条钉住的是**索引边界本身**，不是某个别名：隐私区块的 `<li>` 与 `<details>` 里到处是
    // 「API Key」「密钥」「档案」这些词（`API Key 只存在本机`、`每个档案都没有这个字段`……）。
    // 一旦有人把 `sectionHaystack` 的选择器放宽（比如顺手加上 `, li` 或整段 `textContent`），
    // 搜「密钥」就会同时点亮隐私与翻译引擎——规格 §4.2 点名要防的正是这个（"搜『密钥』跳出
    // 术语表比搜不到更糟"，跳出隐私同样糟），而**别名互斥守卫抓不到它**（碰撞发生在非别名文本里）。
    await seedSettings();
    await loadOptions();

    const privacy = document.querySelector<HTMLElement>('[data-section="privacy"]')!;
    for (const query of ['密钥', 'API Key', '档案', 'key']) {
      search(query);
      expect([query, visibleSections()]).toEqual([query, ['engine']]);
    }
    // 索引只读这两类元素：隐私区块里既没有 `.lab`，`.sec-desc` 也只有那一句别名无关的话。
    // **这两条是"防空洞"的护栏**：它们断言的是**文案的形状**（隐私里没有 `.lab`、只有 1 个
    // `.sec-desc`、正文里确实有那些词），不是搜索逻辑本身。将来谁改了隐私文案（加一个 `.lab`、
    // 或者把那句承诺挪进 `.sec-desc`），红的是这里——那时该改的是**文案或索引边界**，不是搜索。
    expect(privacy.querySelectorAll('.lab')).toHaveLength(0);
    expect(privacy.querySelectorAll('.sec-desc')).toHaveLength(1);
    // 而正文里确实有那些词（否则这条用例就是空转）。
    expect(privacy.textContent ?? '').toContain('API Key');
    expect(privacy.textContent ?? '').toContain('档案');
  });

  it('命中的区块，它的导航项必须可见（看得见结果却点不到它，是比搜不到更糟的失败）', async () => {
    await seedSettings();
    await loadOptions();

    for (const [query, id] of [['密钥', 'engine'], ['并发', 'cache'], ['词库', 'glossary']] as const) {
      search(query);
      expect([query, visibleSections()]).toEqual([query, [id]]);
      // `navLink.hidden = !hit`：命中时必须是 false——写反成 `= hit` 就会把结果本身藏掉，
      // 而只断言"区块可见"的用例发现不了（它们不看导航项）。
      expect([query, document.querySelector<HTMLElement>(`[data-nav="${id}"]`)?.hidden]).toEqual([query, false]);
    }
  });

  it('按字段标签找区块：搜「源语言」找到语言与显示，搜「并发」找到缓存与请求', async () => {
    await seedSettings();
    await loadOptions();

    search('源语言');
    expect(visibleSections()).toEqual(['language']);

    search('并发');
    expect(visibleSections()).toEqual(['cache']);
    // 导航分组标题跟着藏：只剩一个「翻译」而底下一个链接都没有，比留白更像坏了。
    expect(document.querySelector<HTMLElement>('[data-nav-group]')?.hidden).toBe(true);
  });

  it('零命中：所有区块与导航项都藏起来，「没找到」出现，页面不留白', async () => {
    await seedSettings();
    await loadOptions();

    search('zzzz');

    expect(visibleSections()).toEqual([]);
    expect(pick<HTMLElement>('search-empty').hidden).toBe(false);
    expect(pick<HTMLElement>('search-empty').textContent).toContain('没找到');
  });

  it('清空查询：全部回来，「没找到」收起', async () => {
    await seedSettings();
    await loadOptions();

    search('密钥');
    search('');

    expect(visibleSections()).toHaveLength(8);
    expect(pick<HTMLElement>('search-empty').hidden).toBe(true);
  });
});

describe('区块清单与页面结构一一对应', () => {
  it('八个区块：顺序一致、每个都有区块元素与导航项、每个都有别名表', async () => {
    await seedSettings();
    await loadOptions();
    const { SECTIONS } = await import('../../src/options/options');

    expect(SECTIONS.map((section) => section.id)).toEqual([
      'engine',
      'language',
      'shortcuts',
      'glossary',
      'site-rules',
      'prompt',
      'cache',
      'privacy',
    ]);
    expect(document.querySelectorAll('[data-section]')).toHaveLength(SECTIONS.length);
    for (const section of SECTIONS) {
      // 断言里带上区块 id：失败信息直接告诉你是哪一个区块缺东西。
      expect([section.id, document.querySelector(`[data-section="${section.id}"]`) !== null]).toEqual([section.id, true]);
      expect([section.id, document.querySelector(`[data-nav="${section.id}"]`) !== null]).toEqual([section.id, true]);
      expect(section.aliases.length).toBeGreaterThan(0);
      // 标题与页面里的 <h2> 逐字一致（搜索的显示名与页面上的名字不能是两套说法）。
      expect(document.querySelector(`[data-section="${section.id}"] h2`)?.textContent).toBe(section.title);
    }
  });

  it('每个别名只命中它自己那个区块（别名落点的机械守卫）', async () => {
    await seedSettings();
    await loadOptions();
    const { SECTIONS } = await import('../../src/options/options');

    for (const section of SECTIONS) {
      for (const alias of section.aliases) {
        search(alias);
        // 失败信息要能直接看懂：要么改这个别名，要么改另一处提到它的文案。
        expect([section.id, alias, visibleSections()]).toEqual([section.id, alias, [section.id]]);
      }
    }
    search('');
  });

  it('导航分组归属与三段信息架构一致（插错组要当场红）', async () => {
    // 只断言"导航项存在"是不够的：Task 5/6/7 每加一个区块都要往「内容控制」组里插一行，
    // 插到「翻译」或「数据」组里不会让任何用例变红，却会让导航的分段语义悄悄错位。
    // 这里把规格 §3 的三段结构（翻译 / 内容控制 / 数据）钉死在分组标题上。
    await seedSettings();
    await loadOptions();
    const expected: Record<string, string> = {
      engine: '翻译',
      language: '翻译',
      shortcuts: '翻译',
      glossary: '内容控制',
      'site-rules': '内容控制',
      prompt: '内容控制',
      cache: '数据',
      privacy: '数据',
    };

    for (const [id, group] of Object.entries(expected)) {
      const link = document.querySelector<HTMLElement>(`[data-nav="${id}"]`);
      expect([id, link?.closest('[data-nav-group]')?.querySelector('.grp')?.textContent]).toEqual([id, group]);
    }
    // 页面顺序、导航顺序、分组顺序三者一致：`<main>` 里的区块顺序就是上面 SECTIONS 的顺序。
    expect(Array.from(document.querySelectorAll('[data-section]')).map((node) => (node as HTMLElement).dataset.section)).toEqual(
      Object.keys(expected),
    );
    expect(Array.from(document.querySelectorAll('[data-nav-group] .grp')).map((node) => node.textContent)).toEqual([
      '翻译',
      '内容控制',
      '数据',
    ]);
  });
});
```

- [ ] **Step 2: 跑到红**

Run: `npx vitest run tests/options/search.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/options/search"`

- [ ] **Step 3: 写实现与接线**

创建 `src/options/search.ts`：

```ts
// src/options/search.ts
//
// §4.2 搜索（轻量版）：**只做区块与字段标签的过滤**，不做全文检索、不索引用户数据。
//
// 三个刻意的边界：
// 1. **索引内容**＝区块标题 + 区块自己的别名表 + `.sec-desc` + 每个字段标签 `.lab`。
//    别名与区块定义住在一起（`sections/<name>.ts` 的 `aliases`），不会两处漂移；
//    而 `.hint`（大段解释文字）**故意不进索引**——它一进来，"API Key"这种词会把隐私、
//    缓存一起点亮，"搜什么出什么"就没人信了。
// 2. **过滤只切 `hidden`**，不动 DOM 结构：区块与导航项都只是被藏起来，清空查询就全回来
//    （规格 §4.2 点名了这一条：结构一动就与 `options.test.ts` 的契约打架）。
// 3. 查询按空白切词、**全部命中**才算命中（AND）：搜「密钥 引擎」是"两个词都得在同一个区块里"，
//    不是"命中任意一个就显示"——后者会把搜索变成噪声制造机。
import type { Section } from './section';

/** 查询串按空白切词并折成小写；全空白 → 空数组（＝不过滤）。 */
export function parseQuery(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

/** 全部词都出现在这份文本里才算命中。 */
export function matchesTerms(haystack: readonly string[], terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const text = haystack.join('\n').toLowerCase();
  return terms.every((term) => text.includes(term));
}

/**
 * 一个区块参与搜索的全部文本：**区块标题 + 别名表 + `.sec-desc` + 每个字段标签 `.lab`**。
 *
 * **这个边界是承重的，别放宽它**：隐私区块的正文（`<li>` 与 `<details>` 里）到处是
 * 「API Key」「密钥」「档案」——那正是翻译引擎的别名。选择器一旦多收一类元素（比如顺手加上
 * `li`，或者干脆用整段的文本），搜「密钥」就会同时点亮隐私与翻译引擎，而规格 §4.2 点名要防的
 * 就是这件事（"搜『密钥』跳出术语表比搜不到更糟"，跳出隐私同样糟）。
 * `tests/options/search.test.ts` 有一条专门的用例钉住这个边界（搜「密钥」「API Key」「档案」
 * 都只能剩翻译引擎，并且断言隐私区块里确实有这些词——否则那条用例就是空转）。
 *
 * 另一条同源的纪律：`.hint`（大段解释文字）**故意不进索引**。引擎区块与缓存区块的说明里
 * 都写着「API Key」，收进来就会把这两块一起点亮。
 */
export function sectionHaystack(root: ParentNode, section: Section): string[] {
  const node = root.querySelector(`[data-section="${section.id}"]`);
  const labels =
    node === null
      ? []
      : Array.from(node.querySelectorAll('.lab, .sec-desc')).map((el) => el.textContent ?? '');
  return [section.title, ...section.aliases, ...labels];
}

export interface SearchController {
  /** 过滤一次，返回命中的区块数。 */
  apply(query: string): number;
}

/** 造一个搜索控制器（区块清单从 `options.ts` 传进来，避免模块循环依赖）。 */
export function createSearch(sections: readonly Section[]): SearchController {
  return {
    apply(query: string): number {
      const terms = parseQuery(query);
      let hits = 0;
      for (const section of sections) {
        const hit = matchesTerms(sectionHaystack(document, section), terms);
        if (hit) hits += 1;
        const sectionEl = document.querySelector<HTMLElement>(`[data-section="${section.id}"]`);
        if (sectionEl !== null) sectionEl.hidden = !hit;
        const navLink = document.querySelector<HTMLElement>(`[data-nav="${section.id}"]`);
        if (navLink !== null) navLink.hidden = !hit;
      }
      for (const group of Array.from(document.querySelectorAll<HTMLElement>('[data-nav-group]'))) {
        const links = Array.from(group.querySelectorAll<HTMLElement>('[data-nav]'));
        // 一个链接都不剩的分组标题也藏起来：光剩「翻译」两个字比留白更像页面坏了。
        group.hidden = links.length > 0 && links.every((link) => link.hidden);
      }
      const empty = document.getElementById('search-empty');
      if (empty !== null) empty.hidden = hits > 0;
      return hits;
    },
  };
}
```

`src/options/options.html`，在 `<h1 class="sr-only">浸译 设置</h1>` 之后插入：

```html
        <!-- 搜索：只过滤区块与字段标签（规格 §4.2 的轻量版）。占位符刻意写「搜索设置」，
             不写「搜索所有设置」——不承诺"搜不到的一切"。 -->
        <div class="search">
          <span class="mag" aria-hidden="true">⌕</span>
          <input id="search" type="search" placeholder="搜索设置" autocomplete="off" aria-label="搜索设置" />
        </div>
        <p id="search-empty" class="search-empty" hidden>没找到匹配的设置。</p>

```

`src/options/options.css`：

① 令牌块之后（`*:focus-visible` 之前）加：

```css
/*
 * `hidden` 必须真的有效：导航项与导航分组都带了 display（flex），浏览器默认的
 * `[hidden] { display: none }` 会被它们盖掉，而搜索全靠这个属性切显隐（规格 §4.2）。
 */
[hidden] {
  display: none !important;
}
```

② 文件末尾加：

```css
/* ------------------------------------------------------------------ 搜索 */

.search {
  position: relative;
  margin-bottom: 26px;
}

.search input {
  width: 100%;
  padding: 10px 12px 10px 36px;
  font-size: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-card);
}

.search .mag {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 14px;
  color: var(--text-3);
}

.search-empty {
  margin: 0 0 26px;
  font-size: 13px;
  color: var(--text-2);
}
```

`src/options/options.ts`：import 区加 `import { createSearch } from './search';`，并在 `init()` 里接线（**仍在第一个 `await` 之前**）：

```ts
/** 搜索框：只过滤区块与字段标签，不改 DOM 结构（规格 §4.2）。 */
function bindSearch(): void {
  const input = document.getElementById('search') as HTMLInputElement;
  const search = createSearch(SECTIONS);
  input.addEventListener('input', () => {
    search.apply(input.value);
  });
}

function init(): void {
  for (const section of SECTIONS) section.bind(context);
  bindSearch();
  runSafely(engineStatus, '设置读取失败', start);
}
```

- [ ] **Step 4: 跑到绿**

Run: `npx vitest run tests/options/search.test.ts`
Expected: PASS —— **13 条用例**：`describe('搜索：查询解析与匹配（纯函数）')` **2 条**（`:5126`、`:5131`）
+ `describe('搜索：过滤的是区块，不是 DOM 结构')` **8 条**（占位符、密钥、词库、隐私正文不进索引、导航项可见、字段标签、零命中、清空）
+ `describe('区块清单与页面结构一一对应')` **3 条**（八个区块、别名互斥、导航分组归属）。
（行号是这三个 `describe` 在**本计划文件里**的位置，用来对账；**总数 13 才是承重的数**。）

- [ ] **Step 5: 补一条样式断言（`[hidden]` 是搜索的地基）**

在 `tests/options/options-css.test.ts` 的「键盘与窄窗口」describe 里追加：

```ts
  it('`hidden` 有强制规则兜底：导航项是 flex，没有它就藏不住（搜索全靠这个属性）', () => {
    // jsdom 没有布局，`element.hidden = true` 在测试里永远"看起来生效"——真正的显隐
    // 靠这条 CSS。删掉它，搜索结果在真机上会「全都显示、只是变了颜色」。
    expect(declarations(optionsCss, '[hidden]')['display']).toBe('none !important');
  });
```

Run: `npx vitest run tests/options/options-css.test.ts`
Expected: PASS —— **8 条用例**（新增的 `[hidden]` 那条是第 8 条）

- [ ] **Step 6: 变异验证**

| 变异 | 期望红在哪一条 |
| --- | --- |
| `search.ts` 的 `matchesTerms` 改成 `terms.some(...)`（OR） | 「全部命中才算命中」与「每个别名只命中它自己那个区块」 |
| `createSearch` 里 `group.hidden = …` 那一段删掉 | 「按字段标签找区块…」里的分组断言 |
| `empty.hidden = hits > 0` 改成 `empty.hidden = true` | 「零命中…」 |
| `parseQuery` 里不 `.toLowerCase()` | 「全部命中才算命中」的 `'KEY'` |
| 把 `sections/glossary.ts` 的别名里加一个 `'密钥'` | 「命中「密钥」只留下翻译引擎」（同时也会红在别名互斥守卫上） |
| **`sectionHaystack` 的选择器放宽成 `'.lab, .sec-desc, li'`**（或整段 `textContent`） | 「隐私区块那一大段正文**不进索引**」——这是那条用例存在的唯一理由 |
| `sectionHaystack` 把 `.hint` 也收进索引 | 「每个别名只命中它自己那个区块」（`API Key` 会同时点亮 cache 与 engine） |
| **`navLink.hidden = !hit` 改成 `= hit`**（命中的反而藏掉） | 「命中的区块，它的导航项必须可见」——只断言区块可见的用例抓不到这个反写 |
| `options.html` 的 `data-nav="privacy"` 删掉 | 「八个区块：顺序一致、每个都有区块元素与导航项」 |
| **把 `data-nav="prompt"` 那一行挪进「数据」组** | 「导航分组归属与三段信息架构一致」 |

- [ ] **Step 7: 提交**

```bash
git add src/options/search.ts src/options/options.html src/options/options.css src/options/options.ts \
  tests/options/search.test.ts tests/options/options-css.test.ts
git commit -m "feat(options): 轻量搜索（区块与字段标签过滤 + 零命中提示 + 别名互斥守卫）"
```

---

## Task 10: 状态点三态（§4.3）+ 内置免费引擎那一行

**Files:**
- Create: `src/options/engine-health.ts`
- Create: `tests/options/engine-health.test.ts`
- Modify: `src/options/sections/engine.ts`（状态点、健康记录、内置免费引擎那一行、测试连接重构）
- Modify: `src/options/options.html`（引擎区块里加 `<details>` 说明状态点语义）
- Modify: `src/options/options.css`（加 `.dot`）

> 三态（规格 §4.3）：**绿** = 最近一次测试连接通过；**灰** = 从没测过（不代表可用）；
> **红** = 最近一次测试失败，`title` 给原因。**不照抄**参考图那种"填了 Key 就点绿"——
> 填了 Key 不代表能用（`deepseek` 那个 HTTP 400 就是活例）。
>
> 记录存 `chrome.storage.session` 的 `jinyi:engine-health`（独立键，不进 `Settings`、不动 schema
> 版本）。它**不是纯内存**是有意的：只在内存里记的话，刷新一次设置页就全变回灰，而灰的
> `title` 明说"从没测过"——那会是一句假话。代价（浏览器重启后回到灰）写进 README。
>
> §3.1 还点名了「**内置免费引擎不可删**（不渲染删除）」：免费引擎因此要有自己的一行
> （名字 + 内置徽章 + 状态点 + 测试连接，**没有**删除、没有编辑）。这一行**不带**
> `data-profile-id`，所以 `tests/options/options.test.ts` 的 `profileRows()` 依旧只数真实档案，
> 既有 29 条一条都不受影响。

- [ ] **Step 1: 写失败测试**

创建 `tests/options/engine-health.test.ts`：

```ts
// tests/options/engine-health.test.ts
/**
 * @vitest-environment jsdom
 *
 * §4.3 状态点三态 + 它背后的记录（`chrome.storage.session` 的 `jinyi:engine-health`）。
 * 另一半：内置免费引擎那一行（§3.1 的"不可删"）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENGINE_ID, getEngine } from '../../src/engines/registry';
import { ENGINE_HEALTH_KEY, loadEngineHealth } from '../../src/options/engine-health';
import {
  chatResponse,
  chromeStub,
  jsonResponse,
  loadOptions,
  pick,
  profileRows,
  profileSeed,
  resetOptionsPage,
  seedSettings,
  waitFor,
} from './harness';

const CUSTOM_ORIGIN_PATTERN = 'https://api.example.com/*';

async function seedHealth(record: Record<string, unknown>): Promise<void> {
  await chromeStub.storage.session.set({ [ENGINE_HEALTH_KEY]: record });
}

async function storedHealth(): Promise<Record<string, unknown>> {
  const raw = await chromeStub.storage.session.get([ENGINE_HEALTH_KEY]);
  return (raw[ENGINE_HEALTH_KEY] ?? {}) as Record<string, unknown>;
}

function dotOf(id: string): HTMLElement {
  const row = profileRows().find((candidate) => candidate.dataset.profileId === id);
  if (row === undefined) throw new Error(`没有档案行 ${id}`);
  const dot = row.querySelector<HTMLElement>('.dot');
  if (dot === null) throw new Error(`档案行 ${id} 没有状态点`);
  return dot;
}

function status(): HTMLElement {
  return pick<HTMLElement>('engine-status');
}

beforeEach(() => {
  resetOptionsPage();
});

describe('状态点的记录：读取与脏数据', () => {
  it('读得出来；没记录的档案不在结果里', async () => {
    await seedHealth({ 'p-a': { state: 'ok', detail: '' }, 'p-b': { state: 'bad', detail: 'NETWORK：超时' } });
    await loadOptions();

    const health = await loadEngineHealth();
    expect(health['p-a']).toEqual({ state: 'ok', detail: '' });
    expect(health['p-b']?.state).toBe('bad');
    expect(health['p-c']).toBeUndefined();
  });

  it('存储里是垃圾也不崩：认不出来的条目直接丢掉，能救的救回来（缺 detail 补空串）', async () => {
    await seedHealth({
      good: { state: 'ok', detail: '' },
      notAnObject: 'nonsense',
      badState: { state: 'maybe', detail: '' },
      missingDetail: { state: 'bad' },
    });
    await loadOptions();

    const health = await loadEngineHealth();
    // `notAnObject` 与 `badState` 丢掉；`missingDetail` 的 state 合法，只把 detail 补成空串
    // ——一条记录缺个字段不该让整页崩，但也不能凭空变成一个说不清来源的点。
    expect(Object.keys(health).sort()).toEqual(['good', 'missingDetail']);
    expect(health['missingDetail']).toEqual({ state: 'bad', detail: '' });
    // 页面照常渲染，不因为一条脏记录整页白。
    expect(profileRows()).toHaveLength(0);
  });
});

describe('状态点三态', () => {
  it('绿 / 灰 / 红各自可达，`title` 说清是哪一种（灰态明说"从没测过"）', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [
        profileSeed({ id: 'p-a', label: '通了的' }),
        profileSeed({ id: 'p-b', label: '没测过的' }),
        profileSeed({ id: 'p-c', label: '失败过的' }),
      ],
    });
    await seedHealth({
      'p-a': { state: 'ok', detail: '' },
      'p-c': { state: 'bad', detail: 'AUTH：API Key 无效或权限不足' },
    });
    await loadOptions();

    expect(dotOf('p-a').dataset.state).toBe('ok');
    expect(dotOf('p-a').title).toContain('最近一次测试连接通过');
    expect(dotOf('p-b').dataset.state).toBe('idle');
    expect(dotOf('p-b').title).toContain('从没测过');
    expect(dotOf('p-c').dataset.state).toBe('bad');
    expect(dotOf('p-c').title).toContain('AUTH：API Key 无效或权限不足');
  });

  it('测试连接成功：那一行变绿并记进本次会话；失败：变红且 title 带错误码', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好'));
    vi.stubGlobal('fetch', fetchMock);
    chromeStub.permissions.grantedOrigins.add(CUSTOM_ORIGIN_PATTERN);
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed({ apiKey: 'sk-a' })] });
    await loadOptions();

    profileRows()[0].querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    const editor = profileRows()[0].querySelector('.profile-editor') as Element;
    editor.querySelector<HTMLButtonElement>('[data-action="test-profile"]')!.click();
    await waitFor(() => status().dataset.kind === 'ok');

    expect(dotOf('p-a').dataset.state).toBe('ok');
    await waitFor(async () => (await storedHealth())['p-a'] !== undefined);
    expect((await storedHealth())['p-a']).toEqual({ state: 'ok', detail: '' });

    // 再测一次，这次让接口返回 401。
    fetchMock.mockResolvedValue(jsonResponse({ error: 'bad key' }, 401));
    editor.querySelector<HTMLButtonElement>('[data-action="test-profile"]')!.click();
    await waitFor(() => status().dataset.kind === 'err');

    expect(dotOf('p-a').dataset.state).toBe('bad');
    expect(dotOf('p-a').title).toContain('AUTH');
    await waitFor(async () => ((await storedHealth())['p-a'] as { state?: string } | undefined)?.state === 'bad');
  });

  it('测试记录写不进去时如实说一句，但不改这次测试的结果', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好')));
    chromeStub.permissions.grantedOrigins.add(CUSTOM_ORIGIN_PATTERN);
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed({ apiKey: 'sk-a' })] });
    await loadOptions();
    chromeStub.storage.session.set = async () => {
      throw new Error('会话存储满了');
    };

    profileRows()[0].querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    const editor = profileRows()[0].querySelector('.profile-editor') as Element;
    editor.querySelector<HTMLButtonElement>('[data-action="test-profile"]')!.click();
    await waitFor(() => (status().textContent ?? '').includes('测试结果没能记住'));

    // 连接本身是成功的，界面上的点也是绿的。
    expect(status().textContent).toContain('连接成功');
    expect(dotOf('p-a').dataset.state).toBe('ok');
  });

  it('删除档案时把它的记录一并清掉（别给下次迁移回来的同一个 id 留一个假状态）', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed()] });
    await seedHealth({ 'p-a': { state: 'ok', detail: '' }, 'keep': { state: 'bad', detail: 'x' } });
    await loadOptions();

    profileRows()[0].querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    const editor = profileRows()[0].querySelector('.profile-editor') as Element;
    editor.querySelector<HTMLButtonElement>('[data-action="delete-profile"]')!.click();

    await waitFor(async () => (await storedHealth())['p-a'] === undefined);
    expect(Object.keys(await storedHealth())).toEqual(['keep']);
  });
});

describe('内置免费引擎那一行', () => {
  it('在列表最后，带「内置」，没有删除也没有编辑（不可删）', async () => {
    await seedSettings({ engineId: 'google', profiles: [profileSeed()] });
    await loadOptions();

    const free = pick<HTMLElement>('profiles').querySelector<HTMLElement>('[data-engine-free]');
    expect(free).not.toBeNull();
    expect(free!.textContent).toContain(getEngine(DEFAULT_ENGINE_ID).name);
    expect(free!.textContent).toContain('内置');
    expect(free!.querySelector('[data-action="delete-profile"]')).toBeNull();
    expect(free!.querySelector('[data-action="toggle"]')).toBeNull();
    // 它排在真实档案之后；而且**不带** data-profile-id（既有用例只数真实档案）。
    expect(profileRows()).toHaveLength(1);
    expect(pick<HTMLElement>('profiles').lastElementChild).toBe(free);
  });

  it('点它的「测试连接」真的发一次请求，成功之后点变绿', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ sentences: [{ trans: '你好' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await seedSettings({ engineId: 'google', targetLang: 'zh-Hans' });
    await loadOptions();

    const free = pick<HTMLElement>('profiles').querySelector<HTMLElement>('[data-engine-free]')!;
    free.querySelector<HTMLButtonElement>('[data-action="test-free"]')!.click();

    await waitFor(() => status().dataset.kind === 'ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => pick<HTMLElement>('profiles').querySelector<HTMLElement>('[data-engine-free] .dot')!.dataset.state === 'ok');
  });
});
```

> `jsonResponse({ sentences: [{ trans: '你好' }] })` 是免费引擎（google）的响应形状；
> 若 `src/engines/google.ts` 读的字段名不同，**按实际实现改夹具**（不要改断言语义：
> 这里要的是"真的发出去一次请求，并且成功之后点变绿"）。

- [ ] **Step 2: 跑到红**

Run: `npx vitest run tests/options/engine-health.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/options/engine-health"`

- [ ] **Step 3: 写记录模块**

创建 `src/options/engine-health.ts`：

```ts
// src/options/engine-health.ts
//
// 状态点（§4.3）背后的记录：每个引擎/档案"最近一次测试连接"的结果。
//
// 为什么存 `chrome.storage.session` 而不是内存里一个 Map：
// 灰点的语义是「**从没测过**（不代表可用）」。只在内存里记的话，用户刷新一次设置页就全变回灰，
// 那句 `title` 立刻成了假话——他明明刚测过。session 区域是受信上下文可读的独立键
// （设置页是 `chrome-extension://` 同源，本来就在读它清缓存），不进 `Settings`、不动 schema 版本。
//
// **代价如实说**（README 已记）：session 区域在浏览器关闭时清空，重启后所有点回到灰。
//
// 这里刻意不复用 `store.ts`：那份快照是"设置"，这是"UI 的临时记忆"，两者的失败语义也不同
// （设置写失败要拦住用户，测试记录写失败只该说一句）。
import type { StorageArea } from '../core/cache';
import { chromeArea } from '../shared/chrome-area';

export interface EngineHealth {
  /** `ok` = 最近一次通过；`bad` = 最近一次失败（`detail` 进 `title`）。 */
  state: 'ok' | 'bad';
  /** 失败原因（`错误码：消息`）。绿态是空串。 */
  detail: string;
}

/** 独立存储键。**不进 `Settings`**：它不是设置，也不该被 `saveSettings` 整份覆盖带走。 */
export const ENGINE_HEALTH_KEY = 'jinyi:engine-health';

/** 默认区域在**调用时**才解析：模块 import 期不该碰 `chrome`（单测里那是替身，还没装）。 */
function sessionArea(): StorageArea {
  return chromeArea(chrome.storage.session);
}

function pickHealth(raw: unknown): Record<string, EngineHealth> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, EngineHealth> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Partial<EngineHealth>;
    if (record.state !== 'ok' && record.state !== 'bad') continue;
    out[id] = { state: record.state, detail: typeof record.detail === 'string' ? record.detail : '' };
  }
  return out;
}

/**
 * 读出全部记录。**坏条目直接丢掉**（`pickSiteRules` 的老规矩）：一条形状不对的记录不该让
 * 整个设置页崩掉，也不该在界面上变成一个说不清来源的点。
 */
export async function loadEngineHealth(area: StorageArea = sessionArea()): Promise<Record<string, EngineHealth>> {
  const raw = await area.get([ENGINE_HEALTH_KEY]);
  return pickHealth(raw[ENGINE_HEALTH_KEY]);
}

/** 记录一个引擎/档案的结果（读-改-写：只动它自己的那一条）。 */
export async function saveEngineHealth(
  id: string,
  health: EngineHealth,
  area: StorageArea = sessionArea(),
): Promise<void> {
  const current = await loadEngineHealth(area);
  await area.set({ [ENGINE_HEALTH_KEY]: { ...current, [id]: health } });
}

/** 档案被删掉时把它的记录一并清掉。 */
export async function forgetEngineHealth(id: string, area: StorageArea = sessionArea()): Promise<void> {
  const current = await loadEngineHealth(area);
  if (!(id in current)) return;
  const next = { ...current };
  delete next[id];
  await area.set({ [ENGINE_HEALTH_KEY]: next });
}
```

- [ ] **Step 4: 改 `sections/engine.ts`（状态点 + 免费引擎那一行 + 测试连接重构）**

按下面逐处改（**其余部分一字不动**）。每一处都给足了定位上下文；`src/options/sections/engine.ts` 这个文件此刻已经在磁盘上（Task 3 写的），直接开文件改，不要重打整份：

① **import 区一次改完**（三件事：加 `../engine-health` 一条、把 `Translator`/`EngineConfig` 合并进已有的 `../../engines/types` 那一行、把 `StatusKind` 合并进已有的 `../dom` 那一行）。改完这三行应当**恰好**长这样，别再多出第四条 import：

```ts
import { forgetEngineHealth, loadEngineHealth, saveEngineHealth, type EngineHealth } from '../engine-health';
import { toEngineError, type EngineConfig, type Translator } from '../../engines/types';
import { describe, element, fillSelect, requireWithin, runSafely, setStatus, type StatusKind } from '../dom';
```

（`StatusKind` 只在这里 import 一次，⑥ 的 `recordHealth` 直接用；`../../shared/settings`、`../../shared/host-permission`、`../../engines/registry` 那几行一字不动。）

② 模块状态区（`let expandedId` 之后）加：

```ts
/**
 * 状态点的记录（§4.3）。三态里"从没测过"是**没有记录**，所以这里只存有结果的那些。
 * `mount` 时从 `chrome.storage.session` 读一次，之后每次测试连接就地更新。
 */
let health: Record<string, EngineHealth> = {};
```

③ 渲染区加两个纯函数：**紧跟 `/* ------------------------------------------------------------------ 渲染 */` 这一行分隔注释之后、`function buildEditor(` 之前**插入（这两个函数与 `buildEditor` 同属渲染区，`rowById` 之类还够不到它们，所以顺序上只能在这儿）：

```ts
/**
 * 三态：绿 = 最近一次测试连接通过；**灰 = 从没测过（不代表可用）**；红 = 最近一次失败。
 * 刻意**不**做"填了 Key 就点绿"——填了 Key 不代表能用（模型名写错就是 HTTP 400）。
 */
function applyDot(dot: HTMLElement, record: EngineHealth | undefined): void {
  if (record === undefined) {
    dot.dataset.state = 'idle';
    dot.title = '从没测过（不代表可用）';
    return;
  }
  if (record.state === 'ok') {
    dot.dataset.state = 'ok';
    dot.title = '最近一次测试连接通过';
    return;
  }
  dot.dataset.state = 'bad';
  dot.title = `最近一次测试连接失败：${record.detail}`;
}

/**
 * 内置免费引擎那一行：名字 + 内置徽章 + 状态点 + 测试连接。
 * **没有删除、没有编辑**（§3.1：内置免费引擎不可删，也没有可编辑的配置）。
 * 它不带 `data-profile-id`：既有用例的 `profileRows()` 只数真实档案。
 */
function buildFreeEngineRow(ctx: SectionContext): HTMLElement {
  const engine = getEngine(DEFAULT_ENGINE_ID);
  const row = element('div', 'item');
  row.dataset.engineFree = '';

  const line = element('span', 'line');
  line.append(element('span', 'name', engine.name), element('span', 'badge', '内置'));
  const dot = element('span', 'dot');
  applyDot(dot, health[DEFAULT_ENGINE_ID]);
  line.append(dot);

  const grow = element('span', 'grow');
  grow.append(line, element('span', 'meta', '无需 API Key'));
  row.append(grow);

  const test = element('button', 'ghost tiny', '测试连接');
  test.type = 'button';
  test.dataset.action = 'test-free';
  row.append(test);
  return row;
}
```

④ `buildProfileRow` 里，把**这 6 行**（Task 3 写完时的样子）整段替换成右边那 11 行：

```ts
// 替换前
  const line = element('span', 'line');
  line.append(element('span', 'name', isNew ? '新档案（未保存）' : profile?.label ?? ''));
  if (!isNew && snapshot.engineId === id) {
    line.append(element('span', 'badge', '使用中'));
  }
  const grow = element('span', 'grow');

// 替换后
  const line = element('span', 'line');
  line.append(element('span', 'name', isNew ? '新档案（未保存）' : profile?.label ?? ''));
  if (!isNew && snapshot.engineId === id) {
    line.append(element('span', 'badge', '使用中'));
  }
  if (!isNew) {
    // 草稿行没有 id，也就没有"最近一次测试"可言——不给它一个永远灰的点。
    const dot = element('span', 'dot');
    applyDot(dot, health[id]);
    line.append(dot);
  }
  const grow = element('span', 'grow');
```

（`const grow = …` 那一行是**保留**的锚点，替换的只有它前面那几行；别把 `grow` 也一起换掉。）

⑤ `renderProfiles` 的末尾加一行：**在 `if (expandedId === NEW_DRAFT_ID) { profilesList.append(buildProfileRow(ctx, NEW_DRAFT_ID)); }` 这个 `if` 块之后、函数收尾的 `}` 之前**。免费引擎那一行永远排在最后，且每次重绘都跟着列表一起画：

```ts
  profilesList.append(buildFreeEngineRow(ctx));
```

⑥ 测试连接那一段抽成共用函数：**插在 `handleTestProfile` 那一整段（含它的文档注释）之前**，也就是紧跟在 `renderEngineHint` 之后、`/* ---…--- 行为 */` 分隔注释之后的位置：

```ts
/**
 * 真发一次极短请求并上报结果——档案与内置免费引擎**走同一条路**。
 * 抽出来的理由不是"少写几行"：状态点的记录、超时、错误码展开这三件事必须两处一致，
 * 各写一份必然漂移。
 */
async function runConnectionTest(
  ctx: SectionContext,
  healthId: string,
  engine: Translator,
  config: EngineConfig,
  label: string,
): Promise<void> {
  setStatus(engineStatus, 'pending', `正在用${label}翻译一次「${TEST_TEXT}」…`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const [translation] = await engine.translate(
      {
        texts: [TEST_TEXT],
        from: 'auto',
        to: ctx.settings()?.targetLang ?? DEFAULT_SETTINGS.targetLang,
        signal: controller.signal,
      },
      config,
    );
    setStatus(engineStatus, 'ok', `连接成功：${TEST_TEXT} → ${translation ?? ''}`);
    await recordHealth(ctx, healthId, { state: 'ok', detail: '' }, 'ok');
  } catch (raw) {
    // 错误码要显示出来（AUTH / RATE_LIMIT / NETWORK……）：它是用户判断"该改 Key 还是
    // 该稍后重试"的唯一依据，只给一句自然语言会把这两件事混在一起。
    const error = toEngineError(raw);
    setStatus(engineStatus, 'err', `连接失败（${error.code}）：${error.message}`);
    await recordHealth(ctx, healthId, { state: 'bad', detail: `${error.code}：${error.message}` }, 'err');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 记下这次测试的结果，并**就地**更新那一行的点（不整表重绘：重绘会把用户正在编辑的表单丢掉）。
 * 记录写不进去时，把原因**追加**在刚才那句话后面——本次测试的结果是真的，不该被它改掉颜色。
 */
async function recordHealth(
  ctx: SectionContext,
  id: string,
  record: EngineHealth,
  kind: StatusKind,
): Promise<void> {
  health = { ...health, [id]: record };
  const dot = rowById(id)?.querySelector<HTMLElement>('.dot');
  if (dot !== null && dot !== undefined) applyDot(dot, record);
  try {
    await saveEngineHealth(id, record);
  } catch (raw) {
    setStatus(engineStatus, kind, `${engineStatus.textContent ?? ''}（测试结果没能记住：${describe(raw)}）`);
  }
}
```

（`StatusKind` 的 import 已在 ① 里一次改好，这里直接用；不要再加一条 `../dom` 的 import。）

⑦ `handleTestProfile` 里，把**从 `setStatus(engineStatus, 'pending', …)` 那一行到 `} finally { clearTimeout(timer); }` 那一行**（含 `const controller` / `const timer` / `try` / `catch` / `finally` 整块，共 6 个语句块）整段替换成一句调用。替换前那一块长这样，替换后只有一行：

```ts
// 替换前（Task 3 写完时的样子）
  setStatus(engineStatus, 'pending', `正在用档案「${values.label}」翻译一次「${TEST_TEXT}」…`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const [translation] = await engine.translate(…);
    setStatus(engineStatus, 'ok', `连接成功：${TEST_TEXT} → ${translation ?? ''}`);
  } catch (raw) {
    const error = toEngineError(raw);
    setStatus(engineStatus, 'err', `连接失败（${error.code}）：${error.message}`);
  } finally {
    clearTimeout(timer);
  }

// 替换后（整块就这一行）
  await runConnectionTest(ctx, id, engine, config, `档案「${values.label}」`);
```

（上面"替换前"里的 `engine.translate(…)` 是省略写法——照原文照搬那一整块即可，`from` / `to` / `signal` 三个字段都不要漏；它们现在归 `runConnectionTest` 管。）

⑧ **紧接 `handleTestProfile` 之后、`handleDeleteProfile` 的文档注释之前**插入免费引擎的入口（两个函数挨着放，读的人一眼能看到"两条入口走同一条 `runConnectionTest`"）：

```ts
/** 内置免费引擎的测试连接：没有表单值可读，配置就是空的（免费接口零配置）。 */
async function handleTestFreeEngine(ctx: SectionContext): Promise<void> {
  const { engine, config } = resolveEngine({ engineId: DEFAULT_ENGINE_ID, profiles: [] });
  await runConnectionTest(ctx, DEFAULT_ENGINE_ID, engine, config, `免费引擎「${engine.name}」`);
}
```

⑨ `bind` 的 click 委托里，在 `.profile-toggle-key` 那一段**之后、`closest('[data-profile-id]')` 之前**加：

```ts
      // 免费引擎那一行不在 `[data-profile-id]` 里，必须在行判断之前处理。
      if (target.dataset.action === 'test-free') {
        runSafely(engineStatus, '测试连接失败', () => handleTestFreeEngine(ctx));
        return;
      }
```

⑩ `handleDeleteProfile` 的成功分支：**整段替换**下面这 11 行（Task 3 写完时的样子，从 `if (expandedId === id)` 到函数结束的 `}`），改动只有末尾追加的那一段。`setStatus(engineStatus, 'ok', …)` 是**函数最后一条语句**，所以"插在它之后"就是"插在函数的收尾大括号之前"——下面把整段贴出来，避免插错层级：

```ts
  if (expandedId === id) expandedId = null;
  renderProfiles(ctx);
  renderEngineHint(ctx);
  setStatus(
    engineStatus,
    'ok',
    wasCurrent
      ? `已删除当前在用的档案「${target.label}」，引擎已回落到「${getEngine(DEFAULT_ENGINE_ID).name}」，请在弹窗里重新选择。`
      : `已删除档案「${target.label}」。`,
  );
  // ↓↓↓ 本任务新增（仍然在函数体内，收尾大括号之前）↓↓↓
  delete health[id];
  try {
    await forgetEngineHealth(id);
  } catch (raw) {
    setStatus(
      engineStatus,
      'ok',
      `${engineStatus.textContent ?? ''}（它的测试记录没清掉：${describe(raw)}）`,
    );
  }
}
```

（`delete health[id]` 放在 `try` **之前**：内存里的那份必须立刻扔掉，否则界面下一次重绘还可能画出它的点；存储里那份删不掉只影响下次打开设置页，如实说一句就够。）

⑪ `mount` 整段替换（Task 3 写完时它是同步的两行渲染，现在要先读记录）。替换前 / 替换后：

```ts
// 替换前
  mount(ctx: SectionContext): void {
    renderProfiles(ctx);
    renderEngineHint(ctx);
  },

// 替换后
  async mount(ctx: SectionContext): Promise<void> {
    try {
      health = await loadEngineHealth();
    } catch (raw) {
      // 读不出来不是致命错误：所有点回到"从没测过"，但要如实说一句。
      health = {};
      setStatus(engineStatus, 'err', `读取上次的测试结果失败：${describe(raw)}`);
    }
    renderProfiles(ctx);
    renderEngineHint(ctx);
  },
```

（`Section.mount` 的签名是 `void | Promise<void>`，这里返回 Promise 是允许的——`options.ts` 的 `start()` 用 `await section.mount(context)` 等着它。）

⑫ `src/options/options.html` 的引擎区块里，**在 `<div id="profiles"></div>` 之后、`<p class="hint">`（那段"一个档案 = 一份接口地址 + 模型名 + API Key…"）之前**插入下面这一段。放在这里是因为它解释的正是上面那个列表里的点；插在 `#engine-status` 前面会夹在说明段落与状态行之间，读起来是断的：

```html
          <details>
            <summary>状态点的语义（三态，不粉饰）</summary>
            <p>
              <strong>绿</strong> = 最近一次「测试连接」通过；<strong>灰</strong> = 从没测过
              （不代表可用，也不代表不可用）；<strong>红</strong> = 最近一次测试失败，悬停显示失败原因。
              填了 API Key <strong>不等于</strong>能用，所以这里不按"填没填"点灯。
            </p>
            <p>
              记录保存在 <code>chrome.storage.session</code> 里（只有引擎名与成败原因，不含 Key），
              浏览器关闭就没了——重启后所有点回到灰，重新测一次即可。
            </p>
          </details>
```

（**HTML 里不许出现 Markdown 的 `**`**：上面那处"不等于"用的是 `<strong>`。上一版计划在这里写了字面星号，浏览器会把它们原样画出来。）

⑬ `src/options/options.css` 的 `.badge` 规则之后加：

```css
/* 状态点（§4.3）：三态各自一个令牌，`data-state` 是契约、class 只管样式。 */
.dot {
  display: inline-block;
  flex: none;
  width: 8px;
  height: 8px;
  margin-left: 2px;
  border-radius: 50%;
  background: var(--text-3);
}

.dot[data-state="ok"] {
  background: var(--ok);
}

.dot[data-state="bad"] {
  background: var(--danger);
}
```

- [ ] **Step 5: 跑到绿**

Run: `npx vitest run tests/options/engine-health.test.ts tests/options/options.test.ts`
Expected: PASS —— **8 条 + 29 条**

- [ ] **Step 6: 变异验证**

| 变异 | 期望红在哪一条 |
| --- | --- |
| `applyDot` 里 `record === undefined` 那一支改成 `dot.dataset.state = 'ok'`（"填了就算好"） | 「绿 / 灰 / 红各自可达」 |
| 灰态 `title` 改成 `'未测试'` | 同上（断言的是"从没测过"这几个字，规格 §10.6） |
| `pickHealth` 里 `if (record.state !== 'ok' && record.state !== 'bad') continue;` 删掉 | 「存储里是垃圾也不崩」 |
| `buildFreeEngineRow` 里加一个 `delete-profile` 按钮 | 「在列表最后，带「内置」，没有删除也没有编辑」 |
| `renderProfiles` 里 `profilesList.append(buildFreeEngineRow(ctx))` 删掉 | 同上两条 |
| `recordHealth` 里 `saveEngineHealth` 的 `try/catch` 改成不 catch | 「测试记录写不进去时如实说一句」（未处理拒绝不会让断言红，红的是那句文案断言） |
| `handleDeleteProfile` 里 `forgetEngineHealth` 那一段删掉 | 「删除档案时把它的记录一并清掉」 |

- [ ] **Step 7: 提交**

```bash
git add src/options/engine-health.ts src/options/sections/engine.ts src/options/options.html \
  src/options/options.css tests/options/engine-health.test.ts
git commit -m "feat(options): 状态点三态（会话内记录）+ 内置免费引擎那一行（不可删）"
```

---

## Task 11: README 与收口（§11 + 全量命令）

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-09-18-options-page-redesign.md`（本任务书自身：把实现阶段暴露的偏差改成事实）

- [ ] **Step 1: 改写「功能范围」一节**

`README.md` 的 `### 功能范围`（`:438`）一节，按下面的内容替换（保留 `autoTranslateDelay` 那一条**一字不动**）：

```markdown
### 功能范围

- **显示模式、悬停翻译、划词翻译都已接到内容脚本**：`displayMode` 默认「仅译文」；
  `hoverTranslate` / `selectionTranslate` 有弹窗与设置页两处开关并即时生效。**增量翻译已实现**
  （见上文「增量翻译」：仅新增内容，防抖 500ms，单轮上限 60 段；另有"用户交互后整页重扫"
  这条兜底，防抖 400ms、节流 1 秒、元素数超过 15000 时跳过）。
- **设置页有 8 个区块**（左导航分「翻译 / 内容控制 / 数据」三段）：翻译引擎、语言与显示、
  快捷翻译、术语表、站点规则、自定义提示词、缓存与请求、隐私。其中**源语言、术语表、站点规则的写入侧、
  自定义提示词、并发与批量**是 2026-09 这一轮新露出的界面——它们背后的字段本来就有真实消费者
  （`sourceLang` 进请求与缓存 key；`glossary` / `systemPrompt` 进 `buildMessages` 与缓存 key；
  `concurrency` / `maxBatchChars` / `maxSegmentsPerBatch` 被内容脚本与 `core/segmenter` 读；
  `siteRules` 的匹配与拦截见下文「已知限制 › 站点规则」）。
- **设置改动即时保存**：选择类与开关类 `change` 即存，文本类（术语、规则域名、提示词）失焦才存，
  数字类在提交时存。**档案仍用「保存档案」按钮**——保存档案要在用户手势里申请该地址的宿主权限
  （Chrome 要求手势），而且填了一半的档案不该被静默写进存储。
- 保留：`autoTranslateDelay`（自动翻译延时）既没有界面，也没有任何行为……
```

（最后一条按原文照抄 `:453-456`，别改写它。）

- [ ] **Step 2: 「已知限制 › 站点规则」补上单元 B 打开的那条缝 + 新增「设置页」一节**

在 `### 站点规则`（`:425`）那一节的末尾追加：

```markdown
- **规则的闸只装在整页翻译的入口上**（内容脚本的 `translatePage()`）。这意味着：页面**已经翻译之后**
  再加规则，**已经翻好的内容与之后新出现的内容都不会被撤掉**——增量链路（`MutationObserver`）
  不受站点规则约束。单元 A 落地时这条缝实际不可达（当时只能删规则），**设置页有了写入侧之后它就真的可读了**。
  要立刻生效：先按 `Alt+T` 还原，再重新翻译。设置页的站点规则区块里也写着这一条。
```

在 `### 功能范围` **之前**新增一节：

```markdown
### 设置页

- **即时保存的语义**：改一个字段 → 重读一次存储 → 只改这一个字段 → 整份写回。写失败（存储里是
  更高版本、读写失败）会把控件拨回真正生效的那一档，并在该区块的状态行里说明原因。
- **代价（如实）**：同一个扩展同时打开两个设置页时，后写的一方会覆盖前一方。这与改版前"点保存即覆盖"
  是同一性质，本轮不解决。另外写入频率从"每次点按钮"提高到"每次改动"，量级很小（设置页不是高频界面），
  但没有实测。
- **状态点只在本次浏览器会话内有效**：绿/灰/红记在 `chrome.storage.session`（键 `jinyi:engine-health`，
  内容只有引擎 id 与成败原因，不含 Key、不含页面内容）。浏览器关闭后记录清空，所有点回到灰
  （"从没测过"）——重新测一次即可。
- **窄窗口（< 900px）下左导航降级为顶部一行可横滚的胶囊链接**（不再吸顶，分组标题隐藏）。
  **这条降级策略没有在任何真实渲染里验证过**（本机没有浏览器），布局挤压与暗色对比度同样依赖肉眼验收。
- 术语表的空行（原文或译文为空）不会写进存储；**把已经有的一行清空也不会静默删掉它**——界面会明说
  「没有保存，存储里仍是原来那条」，要删请点行尾的「删除」。站点规则的域名同理。
  （理由：清空多半是"清掉重打"，在失焦那一刻删条目会让正在编辑的一行当场消失，而这份界面没有撤销出口。）
- **在文本类控件里按 `Esc` 不会撤销这次改动**：多数浏览器在改动后仍然会派发 `change`，于是那次改动
  照常落盘。改版前有「保存」按钮时可以反悔，现在没有这个出口——要改回去就再改一次，列表行则用行尾
  「删除」。本轮不实现"Esc 撤销"：本机没有浏览器可以验证 `Esc` 在各控件上的真实语义，凭猜测写一个
  半可用的撤销比不写更糟。
```

- [ ] **Step 3: 「隐私」一节补一句存储**

`## 隐私`（`:383`）里，「API Key 只存在本机」那一条之后追加一条：

```markdown
- **设置页的即时保存会多写一点本地存储**：每次改动重读 + 整份写回设置；另外在
  `chrome.storage.session` 里留一条引擎测试记录（键 `jinyi:engine-health`：哪个档案/引擎、通没通、
  失败原因）。它不含 API Key，也不含任何页面内容，浏览器关闭即清空。
```

- [ ] **Step 4: 全量收口（读数写进提交信息）**

```bash
npm test
```

Expected: 全绿；测试总数 = **867 + 本轮新增**。本轮新增用例的逐文件计数（**写完最后一个 Task 后按实际输出核对**）：
`store.test.ts` 6、`dom.test.ts` 4、`options-css.test.ts` 8（Task 3 的 7 条 + Task 9 补的 `[hidden]` 那条）、`no-innerhtml.test.ts` 2、`shortcuts.test.ts` 5、`glossary.test.ts` 11、`rule-pattern.test.ts` 11、`site-rules.test.ts` 9、`prompt.test.ts` 5、`cache-section.test.ts` 8、`search.test.ts` 13、`engine-health.test.ts` 8 = **90 条**，因此预期 **957 个测试 / 52 files**（40 + 12 个新测试文件；`tests/options/harness.ts` 不是测试文件，不计）。`options.test.ts` 仍是 **29 条**。
实际数字以命令输出为准；**与预期不符先查原因，别改断言凑数**。

```bash
npm run typecheck
```

Expected: 两个 tsconfig 都无输出（无错误）。

```bash
npm run build
```

Expected: 末尾 `verify:dist` 报「产物校验全部通过（14 项）」；`dist/options/options.html` 的本地引用（`./options.css`、`./options.js`）都能解析到。

```bash
npm run zip
```

Expected: 打出 zip 包并报文件数与字节数。

- [ ] **Step 5: 同步任务书的代码块**

```bash
node scripts/sync-plan-code.mjs docs/superpowers/plans/2026-09-18-options-page-redesign.md src/ tests/
```

Expected: 第一次跑会同步一批带 `// <路径>` 首行标记的块（`src/options/store.ts`、`src/options/dom.ts`、`src/options/section.ts`、`src/options/search.ts`、`src/options/rule-pattern.ts`、`src/options/engine-health.ts`、`src/options/sections/*.ts`、`tests/options/harness.ts` 等——**条件是那时它们已经写出来了**）；**再跑一次必须报「已同步 0 个代码块」**（幂等）。
方向是**仓库 → 计划**：它只认带路径首行标记的块，所以 `options.html` / `options.css` 那两块（HTML/CSS 里没有 `//` 注释）不会被它碰到——那两处要**手工**与仓库保持一致。

> ⚠️ **这条命令绝对不能在实现之前跑。** 计划里 **28 个**带标记的块中，**只有 `// src/options/options.ts` 一个指向已经存在的文件**——而它现在是**旧版**（694 行）。实现之前跑同步，脚本会认为"计划落后于仓库"，把这个块**整块刷成旧文件**，Task 3 的装配层设计就没了。
> 已核对过这件事（在计划的**副本**上跑，没碰真文件）：不带前缀跑报 `同步 src/options/options.ts（72 行 -> 694 行）` + 「已同步 1 个代码块」，另外 **27 个**文件全部列进"跳过（文件尚不存在）"；只跑 `tests/` 前缀时是「已同步 0 个代码块」。
> **所以顺序是：Task 1~10 全落地 → 跑 `npm test/typecheck/build/zip` → 再跑同步。** 那时 `src/options/options.ts` 已经是新版装配层，同步才会正确地"0 个块"或只补上实现期的偏差。
> （另外两条同源的坑，已经在本计划里避开：`options.ts` 是**一整块**、不是"前半块带标记 + 后半块不带"；`sections/cache.ts` 的**中间态那一块没有标记**，只有 Task 8 的最终版带标记——两块都带标记时同步会刷出两份同样的文件。）

- [ ] **Step 6: 提交**

```bash
git add README.md docs/superpowers/plans/2026-09-18-options-page-redesign.md
git commit -m "docs: 设置页改版的已知限制（即时保存的代价、状态点的生命周期、站点规则那道缝、窄窗口降级未验证）"
```

---

## 验收对照表（规格 §10 十条 → Task/Step）

| # | 规格 §10 的验收标准 | 由谁覆盖 | 具体证据 |
| --- | --- | --- | --- |
| 1 | 8 个区块全部可操作，每个能改的字段都有真实消费者，无占位控件 | Task 3（engine/language/cache/privacy）+ Task 4（shortcuts）+ Task 5（glossary）+ Task 6（site-rules）+ Task 7（prompt）+ Task 8（cache 统计与高级） | 每个区块的用例都在真实 HTML 上操作并直读存储；`privacySection` 是**空实现**（没有可改字段，因此没有任何控件）；`autoTranslateDelay` 全程不出现（§1 表 + §8） |
| 2 | 即时保存：改字段后重新读取存储确认落盘，不点任何保存按钮 | Task 3 Step 13（语言/显示）、Task 4 Step 3（开关）、Task 5 Step 1（术语）、Task 6 Step 5（规则）、Task 7 Step 1（提示词）、Task 8 Step 1（四个数字） | 所有新用例走 `waitFor(async () => (await storedSettings())… )` 直读存储；唯一保留的显式保存按钮是档案的「保存档案」，理由见「需要评审先点头的 9 个决定」第 2 条 |
| 3 | 文本字段 `blur` 才写存储：打字过程中存储不变 | Task 5（术语）、Task 6（规则）、Task 7（提示词）各自的「打字过程中存储不变」用例 | 落成原生 `change`（= 失焦且值变了，且**冒泡**，能配合动态行的委托监听）；`input` 事件一律不写 |
| 4 | 术语表空行（`from` 或 `to` 为空）不写入存储 | Task 5 Step 1「只填一半的行不写存储，也不凭空长出第二行」（§10.4） | 另有「清空既有行 = 删掉那一条」，防止界面与存储对不上 |
| 5 | 搜索：命中时只显示匹配区块；零命中出现「没找到」 | Task 9 全部用例 | `visibleSections()` 断言"只剩哪一个"；零命中时所有区块与导航项 hidden 且 `#search-empty` 不 hidden |
| 6 | 状态点三态各自可达且互不混淆；灰态 `title` 明说"从没测过" | Task 10 Step 1「绿 / 灰 / 红各自可达」+ 脏数据用例 | `data-state` 三值 + `title` 逐条断言；灰态文案含「从没测过」 |
| 7 | 站点规则：`never` 命中时三个入口都不翻译；`*.x.com` 通配与精确匹配各有用例；首条命中生效 | **单元 A 已交付**（`tests/core/site-rules.test.ts` 12 条、`tests/content/index.test.ts` 的拦截用例、`tests/popup/popup.test.ts` 的解除用例）；本单元 Task 6 补**写入侧**（界面里能增删的规则就是那三条语义的输入） | 本单元不重复实现、不重复测匹配语义；Task 6 的规则行只写 `action: 'never'` |
| 8 | §6 的文案已改对，且断言更新在提交信息里写明理由 | Task 2 全部（含提交信息模板） | 改后的断言多了一条"仍存在的限制"，并反向钉住旧说法不许回来；Task 3 Step 10 的 HTML 里逐字保留该句 |
| 9 | 亮/暗两套下无硬编码颜色（用 `tests/helpers/css.ts` 的解析器断言声明块） | Task 3 Step 4（`options-css.test.ts` 7 条）+ Task 9 Step 5（`[hidden]` 那条，第 8 条） | 令牌逐字一致、正文无 `#`/`rgb()`/`hsl()` 字面量、无 `opacity`；`--on-accent` 同时加进 `popup.css` 以保持共用组一致 |
| 10 | 全量 `npm test` / `typecheck` / `build`（`verify:dist` 14 项）/ `zip` 全绿 | Task 11 Step 4 | 逐个命令 + 期望输出；测试总数预期 **957 / 52 files**（867 + 本轮 90 条） |

## 覆盖对照表（规格其余条目）

| 规格条目 | 落在哪 |
| --- | --- |
| §2 视觉语言（左导航 + 一行一卡片 + 红字删除 + 虚线添加 + 成组开关；不抄"搜索次数最多"） | Task 3 Step 6 的 CSS（`.nav` / `.item` / `.link-danger` / `.add` / `.group` / `.switch`）+ 本计划开头的「原型 → DOM 映射」表；"搜索次数最多"不在任何任务里（§8 非目标） |
| §2 左导航：图标 + 圆角高亮 + 活动项左侧 3px 强调条 + 分组留白 | Task 3 Step 6（`:target` + `:has()` 的高亮与强调条；**不做滚动联动**，理由写在 CSS 注释里） |
| §3.1 翻译引擎（档案一行一卡片、使用中徽章、状态点、`baseUrl · model`、测试连接/编辑/删除、内置免费引擎不可删） | Task 3（行与编辑器搬家）+ Task 10（状态点、内置免费引擎那一行**没有**删除与编辑） |
| §3.2 语言与显示（目标语言、**源语言**、显示模式） | Task 3 Step 11 的 `sections/language.ts` + Step 10 的 HTML（`#source-lang`） |
| §3.3 快捷翻译（悬停、划词、Alt 暂停说明、快捷键只读展示 + 去浏览器设置） | Task 4 全部 |
| §3.4 术语表 | Task 5 全部 |
| §3.5 站点规则（域名 + 动作） | Task 6 全部（动作是静态「永不翻译」，见决定 #4） |
| §3.6 自定义提示词 | Task 7 全部 |
| §3.7 缓存与请求（三个统计、上限、清除、`<details>` 三项高级） | Task 3（清除按钮搬家）+ Task 8（统计、上限、高级折叠） |
| §3.8 隐私（**四条一行式** + `<details>` 里的诚实说明，**不删**） | Task 3 Step 10 的 HTML（那段 `<details>` 一字不删；四条承诺里保留既有用例断言的五个字面量；第 4 条宿主权限承诺是**从现状原样搬过来的**，见该步的注记） |
| §4.1 即时保存（change/blur 语义、单字段整份写回、失败可见、已知代价） | Task 1（内核）+ Task 3~8（每个区块的写路径）+ Task 11 Step 2（README 写明代价） |
| §4.2 搜索（轻量、别名随区块定义、别名落点、占位符、只切 hidden） | Task 9 全部（别名互斥守卫 + 零命中 + 占位符断言） |
| §4.3 状态点三态 | Task 10 全部 |
| §5 站点规则本轮范围（只 never、不给 always 入口、匹配语义复用单元 A、增量链路的缝要写明） | Task 6（只写 `never`；区块 `<details>` 写明"划词与悬停不受约束"与那道缝）+ Task 11 Step 2（README 里把缝写成事实） |
| §6 文案修正 | Task 2（+ Task 3 Step 10 逐字保留） |
| §7 入口文件名不变 | Task 3（`options.html` / `options.ts` 同名、`options_page` 不动）+ Task 11 Step 4 的 `verify:dist` |
| §7 `options.ts` 必须拆 | Task 3（`store.ts` + `dom.ts` + `section.ts` + `sections/<name>.ts` + 只做装配的 `options.ts`） |
| §7 测试契约不得破坏 | Task 3 Step 2（夹具抽取，断言不动）+ Step 13（`#save` 四条改写）+ 各任务的契约属性（`data-*` 新名不复用旧名） |
| §7 CSS 纪律 | Task 3 Step 4~6（令牌、无硬编码、无 opacity、focus-visible）+ Task 9 Step 3/5（`[hidden]`） |
| §7 键盘可达（原生按钮 / `<details>`） | Task 3 Step 10（导航是原生 `<a>`、折叠是原生 `<details>`）+ Task 4 Step 5（开关是原生 checkbox，`appearance:none` 只改外观） |
| §7 不得用 `innerHTML` | Task 3 Step 8 的源码守卫 + Task 5 的 `<img onerror>` 用例 |
| §7 分层守卫（`src/core` 不碰 DOM/chrome） | 本单元**不改 `src/core/**`**；Task 11 Step 4 的 `npm test` 会跑 `tests/core/layering.test.ts` |
| §9 交付拆分（B 排在 A 之后、C 排在 B 之后） | 本计划即单元 B；Task 11 之后 `sections/engine.ts` 就是单元 C 要改的那一处（§9 说的 `sections/翻译引擎.ts`） |
| §11 无浏览器 / 窄窗口 / 写频率 / 两页覆盖 / 划词悬停不受约束 | Task 3（窄窗口降级策略 + CSS 顶部的"未渲染验证"声明）、Task 6（划词悬停）、Task 11 Step 2/3（README 逐条写明） |

## 刻意不做的（非目标，来自规格 §8）

| 不做的事 | 为什么 |
| --- | --- |
| 自动翻译与 `autoTranslateDelay` 的界面 | 零消费者，做了就是假控件（§1 表、§8） |
| 站点规则的「总是翻译」动作 | 没有自动翻译，它今天不产生任何可观察行为（§5）；区块 `<details>` 里写明了这件事 |
| 把 API Key 拆成独立存储键 | 结构性隔离是独立单元（§8、README 已知限制） |
| 术语表导入/导出、批量粘贴解析 | §8 非目标 |
| 多设置页并发写入的冲突解决 | §8 非目标；本轮只把代价写清楚（决定 #1、Task 11） |
| 快捷键自定义 | Chrome 要求用户手势、扩展页无法代改；只给「去浏览器设置」指路（Task 4） |
| 「搜索次数最多」快捷区 | 要记录使用行为，与"零遥测"冲突（§2） |
| 「从当前页面填入」按钮 | **技术上做不到**（决定 #3）：设置页自己就是活动标签，`Tab.url` 需要 `tabs` 权限（安装警告）或该页面的宿主权限，而单元 A 已经明确拒绝 `tabs`。替代方案：输入框接受整条网址并规范化成域名 |
| `autoTranslateDelay`、`systemPrompt` 之外的"顺手加"的字段 | 一律不加：没有消费者的控件比空着更糟 |

## 自审记录（写计划时逐条做过的检查）

**① 规格覆盖。** §3 的 8 组、§4 的三条契约、§5、§6、§7 的 8 条约束、§10 的 10 条标准、§11 的 5 条限制、§2 的视觉语言、§9 的单元边界——逐条都能指到任务（见上面两张对照表）。**唯一没有独立任务的是 §8 非目标**，它们的"不出现"由 Task 9 的结构守卫（8 个区块、别名互斥）与 Task 11 的 README 结果来保证。

**② 占位符扫描。** 写完后对本文档做了这几种模式的检查：`TBD` / `TODO` / `待补` / `类似 Task` / `为上述写测试` / `适当处理` / `等等`。
结果：**0 处**。所有代码步骤都给的是完整代码；唯一"不给完整代码"的地方是 Task 3 Step 11 的 `sections/engine.ts`——它是**搬家**，全文都在那里逐字给出（含原有注释），`options.ts` 的装配、`dom.ts`、`section.ts`、四个区块模块、`harness.ts`、CSS、HTML 也全都是全文。
**另有两处是"改写指引"而不是全文**，都给了精确的定位与替换内容：Task 3 Step 2（`options.test.ts` 删本地夹具 + 换成 import）、Task 10 Step 4（`sections/engine.ts` 的 ⑬ 处逐处改，每处都引足了上下文）。
**补充（审查后）**：第一版里有三处写成"二选一，别留着不管"的**决策点**（提示词要不要 `trim()`、单标签主机名收不收、术语行回填的那条变异杀不杀得死）——那不算占位符，但也不算已决项。现在三处都定下来了（分别见 Task 7 的「前后空白原样存进去」用例、`rule-pattern.ts` 的 `HOSTNAME` 注释 + 「单标签主机名照收」用例、Task 5 变异表里标注「不设此变异（已核实杀不死）」的那一行），**文档里不再有任何"你选一个"的句子**。

**③ 类型与命名一致性。** 逐对过了一遍（前面的定义 ↔ 后面引用）：

| 名字 | 定义在哪 | 谁在用 |
| --- | --- | --- |
| `loadSnapshot` / `currentSettings` / `patchSettings` / `NOT_LOADED` | Task 1 `store.ts` | Task 3 `options.ts`（`context.settings` / `context.reload` / `save` 的底层） |
| `Section` / `SectionContext` / `SectionId` / `bind` / `mount` / `settings()` / `reload()` / `save(status, prefix, patch, okMessage?)` | Task 3 `section.ts` | 全部区块模块 + `options.ts` + Task 9 的 `search.ts`（只读 `Section` 的 id/title/aliases） |
| `setStatus` / `describe` / `element` / `fillSelect` / `requireWithin` / `runSafely` / `StatusKind` | Task 3 `dom.ts` | engine / language / cache / glossary / site-rules / shortcuts / prompt；`StatusKind` 另被 Task 10 的 `recordHealth` 用 |
| `EngineHealth` / `ENGINE_HEALTH_KEY` / `loadEngineHealth` / `saveEngineHealth` / `forgetEngineHealth` | Task 10 `engine-health.ts` | Task 10 的 `sections/engine.ts` 与测试 |
| `normalizeRulePattern` / `RulePatternResult` | Task 6 `rule-pattern.ts` | Task 6 的 `sections/site-rules.ts` |
| `parseQuery` / `matchesTerms` / `sectionHaystack` / `createSearch` / `SearchController` | Task 9 `search.ts` | Task 9 的 `options.ts` 接线与测试 |
| `SECTIONS` | Task 3 `options.ts`（导出） | Task 9 的结构守卫与别名守卫（`await import('../../src/options/options')`） |
| `patchFor(field, value)` | `sections/language.ts`（Task 3）与 `sections/cache.ts`（Task 8）**各一份同名私有函数**，参数类型不同（`string` / `number`） | 各自的区块；同名是有意的（同一件事的两个类型版本） |
| `runConnectionTest` / `recordHealth` / `applyDot` / `buildFreeEngineRow` / `handleTestFreeEngine` | Task 10 `sections/engine.ts` | 同文件 |
| `renderRows` / `writeTerms` / `commitRow` / `deleteRow` / `draftOpen` / `rowsOf` / `inputWithin` / `buildRow` | `sections/glossary.ts`（Task 5）与 `sections/site-rules.ts`（Task 6）**各一份私有实现** | 各自的区块。**这是刻意的取舍**：两处的行结构、字段、提交规则都不同（术语是 `from→to` 两框，规则是域名一框 + 静态动作 + 规范化失败的第三种结局），硬抽一个共用抽象会把两种语义拧在一起。共用的部分（`element` / `setStatus` / `runSafely` 家族）已经在 `dom.ts` 里 |

**④ DOM 契约核对（grep 出来的，不凭记忆）。** 计划里出现的每一个 id / class / `data-*` 都对着 `tests/options/options.test.ts` 的实际用法核过：
- 保留的 id：`profiles`（`:52`）、`engine-status`（`:135`）、`target-lang`（`:284`）、`display-mode`（`:285`）、`target-hint`（`:295`）、`add-profile`（`:315`）、`clear-cache`（`:775`）、`cache-status`（`:776`）——全部仍在 Task 3 的 HTML 里，且仍是原来的元素类型（`select` / `button` / `.status` 行）。
- 保留的 class / 属性：`.profile-row[data-profile-id]`、`.profile-editor`、`.profile-provider`、`.profile-label`、`.profile-base-url`、`.profile-model-name`、`.profile-api-key`、`.profile-toggle-key`、`[data-action]` 的四个值（`toggle` / `save-profile` / `test-profile` / `delete-profile`）——Task 3 Step 11 的 `engine.ts` 全文里逐个可见；`actionButton(editor, …)` 要求三个动作按钮仍在 `.profile-editor` **内部**，搬家时位置未动。
- 移除的：`#save`（只在 `:318` / `:708` / `:727` / `:744` 出现，Task 3 Step 13 四条全部改写，且断言更强）。
- 新增的契约一律是新名：`data-section` / `data-nav` / `data-nav-group` / `data-glossary-row` / `data-rule-row` / `data-rule-action` / `data-state` / `data-draft`（§7"不复用旧名"）。
- 隐私区块的五个字面量（`API Key 只存在本机` / `不上传、不同步` / `永远从空开始` / `除翻译请求本身外，不发起任何网络请求` / `contenteditable`）在 Task 3 Step 10 的 HTML 里逐个可见（`:298-305` 的断言继续有效）。
- 缓存状态行的三句文案（`已清除 N 条翻译缓存` / `缓存本来就是空的`）在 Task 8 的 `handleClearCache` 里逐字保留（`:780` / `:800` / `:812`）。

**⑤ 执行注意（写进这里防止踩坑）。**
- 每个 Task 结束时跑一次 `npx vitest run tests/options/`，**再提交**；全量 `npm test` 只在 Task 11 跑一次（它要 18 秒，且 `extractor-scale` 那条基准测试吃 CPU）。
- 本机是 pwsh 5.1：**不要**用 `Set-Content` / `Get-Content -Raw` 之类的命令改这些文件（会破坏 UTF-8 中文），一律用编辑/写入工具。跑 `npm test` 时不要用 `Select-Object -First N` 截断管道。
- Task 3 之后的每个 Task 都只**新增**一个区块：HTML 里的插入点统一是 `<!-- 缓存与请求 -->` 那一行**之前**（保证页面顺序与导航顺序一致），导航项的插入点在各自 group 内——Task 9 的结构守卫会在顺序错位时当场红。

---

## 审查复核记录（第二版与终版各改了什么、以及四条被撤回的指控）

第二版由一次独立核查驱动；终版由那次核查的**对账**驱动（它撤回了 B2/B3/S3/S4 四条，并把 B1 更正为"位置对、因果错"）。逐条处置如下（**每条都改在计划里，不是只写在报告里**）：

| 核查项 | 结论 | 改在哪 |
| --- | --- | --- |
| **B1** `SectionContext` 定义出现两份（一份带 `reload`、一份不带），下游会 `Property 'reload' does not exist` | **部分成立（核查者已更正为"位置对、因果错"）**：真正的问题是**重复定义**本身；`section.ts` 的接口与 `options.ts` 的 `const context` **两处都已有 `reload`**（复核过行号：接口在 `settings()` 之后、`context` 里是 `reload: async () => { await loadSnapshot(); }`），所以照原文落地**不会** typecheck 红。仍然按建议删掉了那份重复的定义块，并补了一条"接口只在这一处定义"的硬话 | Task 3 Step 11（`section.ts` 之后的那段注记）、文件结构表 |
| **B2** 隐私区块会让 `search('密钥')` 返回 `['engine','privacy']` | **撤回（没有复现）**：核查者自己复刻时**给隐私区块伪造了 `.lab` 条目**。实测：`sectionHaystack` 用的是 `node.querySelectorAll('.lab, .sec-desc')`（**在区块内**查），隐私区块既没有 `.lab`，它唯一的 `.sec-desc` 也是"本地存储、零网络请求、只采集可见文本、授权按需申请"这类别名无关的话；正文全在 `<ul>` / `<details>` 里。我把计划里的 HTML + `search.ts` 逻辑**原样复刻跑了一遍**（jsdom + 8 个区块的真实标签）：`密钥 → ['engine']`、`API Key → ['engine']`、`档案 → ['engine']`、`词库/专有名词 → ['glossary']`，**别名互斥矩阵 51 个别名全部基线绿**。核查者事后也用放宽后的选择器独立复跑，确认这条加固用例**不是空转**（红在 `:5191`） | 仍然**接受了它背后的担忧**并保留加固：一条专门的用例钉住"隐私正文不进索引"（断言隐私里**确实**有「API Key」「档案」、`.lab` 为 0 条、`.sec-desc` 为 1 条——免得用例空转）+ `sectionHaystack` 的文档注释写明这个边界是承重的 + 变异表新增"把选择器放宽成 `li`"这一行。Task 9 |
| **B3** 命中的区块，其导航项被 `navLink.hidden = !hit` 藏掉了 | **撤回（极性读反了）**：`hit` 为真时 `!hit` 为假，`hidden=false`，导航项是**可见**的；`search('密钥')` 推演结果就是 `engine: 区块可见/nav可见` | 仍然保留更硬的守卫：一条"命中的区块其导航项必须可见"的用例（覆盖 engine/cache/glossary 三个），变异表新增"`= !hit` 反写成 `= hit`"这一行。Task 9 |
| **B4** 隐私区块的一条承诺被静默删掉 | **成立**（真问题；但**行号与序数**在第二版里写错了，终版更正）：实测 `src/options/options.html` 的隐私 `<li>` 是 `:63-71` / `:72-74` / **`:75-78`** / `:79-82`——被压掉的那条是**第 3 条**（授权按需申请，`:75-78`），不是"`:79-83` 的第 4 条" | 那条 `<li>` **原样恢复**；新版按 1/2/3/4 重排后它落在**第 4 条**；`.sec-desc` 不再声称"三条"；行号与序数已按实测更正（Task 3 Step 10 的注记 + 文件结构表 + 本表）。Task 3 Step 10 |
| **S1** Task 2 把过时句"改完点下面的「保存语言与显示」"搬进了新文案，且没交代归宿 | **成立**：那句话在 Task 2 的提交上**是真的**（按钮还在），但在 Task 3 之后就不再成立，而两个 Task 都没交代它 | Task 2：明确"范围是整个 `<p>`、只改链接那句、末尾句逐字保留"并写明归宿；Task 2 的断言新增 `toContain('保存语言与显示')`（当下为真）；Task 3 Step 13 **整条替换**成 `not.toContain('保存语言与显示')`；Task 3 Step 10 的注记同步更新 |
| **S2** Task 3 的删除清单漏了会变死引用的 import | **成立**：`readFileSync` / `join` / `installChromeStub`+`ChromeStub` 会悬空（`noUnusedLocals` 没开，typecheck 不会报）；`vi` 要留、`afterEach` 要留 | Task 3 Step 2 新增第 2 条"同时删掉会变成死引用的 import"，并列出**要留的**标识符 |
| **S3** 测试总数算错（说 `search.test.ts` 是 9 条而不是 10 条） | **撤回（算错了）**：第一版是 **9** 个 `it`（`2 + 5 + 2`），第二版是 **13** 个（`2 + 8 + 3`）——无论如何都**不影响任何结论**，因为总数已经全量重算（见 Task 11 Step 4）。这个括注不驱动任何判断，**终版把它删了** | Task 11 Step 4 的逐文件计数（以命令输出为准） |
| **S4** Task 2 的替换范围写成 4 行、实际 5 行 | **撤回（算错了）**：复核 `src/options/options.html`，`<p id="target-hint">` 是 **`:41-44` 四行**（第 45 行是 `<div class="actions">`）。范围保持 `:41-44` | 同时按 S1 把这一块的边界与归宿写清楚了。Task 2 Step 3 |
| **S5** Task 10 的 import 指令前后矛盾（`StatusKind` 两处各说一遍） | **成立** | Task 10 ① 改成"import 区**一次改完**（三件事）"并给出改完后**恰好**的三行；⑥ 的括注改成"已在 ① 里改好，不要再加一条" |
| **S6** Task 10 的 `<details>` 插入点不对，且 HTML 里有 Markdown 星号 | **成立**（两处都对） | 插入点改成"`<div id="profiles"></div>` 之后、`<p class="hint">` 之前"；`**不等于**` 改成 `<strong>不等于</strong>`，并加了一条"HTML 里不许出现 Markdown 的 `**`"的提醒 |
| **S7** 三处变异写着"杀不死/二选一"却没做决定 | **成立**（这确实是决策点，不是已决项） | ① 提示词：**决定存原样**（消费者自己 trim），新增用例「前后空白原样存进去」把它钉住；② 单标签主机名：**决定照收**（核心按精确匹配，`localhost` 本来就是有效规则），`HOSTNAME` 放宽 + 新增用例「单标签主机名照收」；③ 术语行回填那条变异：标注**「不设此变异（已核实杀不死）」**，并说明真正的守卫是哪条用例 |
| **S8** 导航分组归属没有守卫 | **成立**：Task 5/6/7 往「内容控制」组插行，插错组不会红 | Task 9 新增用例「导航分组归属与三段信息架构一致」（8 个 id → 分组标题的映射 + 区块顺序 + 分组顺序三者一起断言），变异表新增"把 `data-nav="prompt"` 挪进「数据」组" |
| **P3** Task 10 ⑩ 的插入点上下文不够（`setStatus` 就是函数最后一句） | **成立** | ⑩ 改成"整段替换"，把成功分支**到函数收尾 `}`** 的 11 行全文贴出来，用 `// ↓↓↓ 本任务新增` 标出插入位置 |
| **D-1** 术语行 `commitRow` 在 `from` 失焦时读两个框，会把没填完的一行"白填" | **部分成立，已按更稳的一版落地**：`from` 失焦→change 时 `to` 还空，代码走"草稿行半填→什么都不做"，**不是**丢掉整行——等 `to` 也失焦时第二次 change 才写入，所以数据不会白填。但上一版**测不到这条真实路径**（测试是先写好两个值、只派发一次 change），而且"既有行被清空"那一支选错了：顺手删条目 + 重绘会让**正在编辑的一行当场消失** | 新增用例「真实用户路径：先填 from、Tab 到 to（两次 change）」，并把三个分支逐条写进 `commitRow` 的注释；术语表**与站点规则**的"既有行被清空"改成**不写存储 + 明说"没有保存，存储里仍是原来那条，要删请点行尾「删除」"**（决定 #6 重写、两处测试与变异表同步） |
| **D-2** `Esc` 取消编辑仍会写盘 | **成立**（真实缺口） | 不实现"Esc 撤销"（本机无法验证 `Esc` 在各控件上的真实语义，凭猜测写半可用的撤销更糟）——写进 README 已知限制并说明现成出路（决定 #8、Task 11 Step 2） |
| **D2** `dom.ts` 没有自己的测试 | **成立**（共享件坏了会全线崩） | 新增 `tests/options/dom.test.ts`（4 条：`setStatus` 走 textContent、`runSafely` 两条路径、`requireWithin` 抛错带选择器、`fillSelect` 重建选项），放在 Task 3 Step 11 的**最前面**（先红后绿） |
| **Task 10 自足性** 13 处改动是相对定位，要求执行者看到另一个 Task 的全文 | **成立** | 开头新增「执行前提」（第 0 条）：实现者从仓库 + 本 Task 小节出发；并把 Task 10 的每一处锚点引足上下文（②③④⑤⑥⑦⑧⑨⑩⑪ 逐处给出"替换前/替换后"或"插在哪两行之间"） |

### 终版（第三轮）清掉的读数

第二轮之后又做了一次对账，它撤回了上面四条（B2/B3/S3/S4），并给出六条低危但会让执行者**停下来对账**的读数问题。逐条处置：

| 项 | 结论 | 终版怎么写的 |
| --- | --- | --- |
| **N1** 隐私那条第 3 条的**行号与序数**都写错了（写着 `:79-83`、叫"第四条"） | **成立**：实测 `:63-71` 第 1 条、`:72-74` 第 2 条、**`:75-78` 第 3 条**（授权按需申请）、`:79-82` 第 4 条（只送可见文本，`:83` 是 `</ul>`） | 已按实测改写，并且把话说清楚：**现状里它是第 3 条**，新版按 1/2/3/4 重排后落在**第 4 条**——"我们保住了那条被压掉的承诺"这个结论**不再建立在一个错的序数上**。Task 3 Step 10 的注记 + 文件结构表 + 本表 |
| **N2** Task 4 的 Expected 没随 `dom.test.ts` 重算（写 popup 33 + options 42） | **成立**（两个数都旧了） | 实测：`tests/popup/popup.test.ts` = **44 条**、`tests/options/` = **48 条**（29 + 7 + 2 + 6 + **4**）。Task 4 Step 2 已改成这两个数并写明"必须把 `dom.test.ts` 的 4 条算进去" |
| **N3** Task 9 的 Expected 组内拆分 | **总数 13 对，拆分按实测更正**：`describe` 三段是 `:5125` **2 条** + `:5141` **8 条** + `:5250` **3 条**（每一段的 `it` 行号都在计划里数过；对账方给的是 7/4，与实测不一致——**总数 13 不变**，且总数才是承重的数） | Task 9 Step 4 写成 2 / 8 / 3 并附三条 describe 的行号，末尾注明"总数 13 才是承重的数" |
| **N4** 复盘表里"`search.test.ts` 实际有 10 个 `it`（2+6+2）"是错的 | **成立**（那个括注不驱动任何结论） | **直接删掉**该括注，S3 那一行改成"撤回（算错了）+ 不影响任何结论 + 总数已全量重算" |
| **N5** 隐私加固用例里那两条"文案耦合"断言 | **不用改**（防空洞的必要代价，对账方也认这笔账划算） | 原位加了半句说明："这两条是**防空洞的护栏**，断言的是文案的形状不是搜索逻辑；将来改隐私文案红的是这里——那时该改的是**文案或索引边界**，不是搜索" |
| **N6** 文件结构表里 `sections/privacy.ts` 还写着"三条一行式" | **成立** | 文件表那一行 + `privacy.ts` 模块注释里的"三条一行式"都改成**四条** |

**顺带修掉两处只有跑一次同步才看得见的坑**（核查要求跑 `sync-plan-code.mjs` 验证幂等；我在计划**副本**上跑的，没碰真文件）：

1. `src/options/options.ts` 原来被写成**两块**（前半块带路径标记、后半块不带）。同步脚本只认带标记的那一块，会把**前半块**刷成整个文件（实测：`同步 src/options/options.ts（72 行 -> 694 行）`——因为仓库里现在是 694 行的旧版），后半块就变成重复内容。→ 已合并成**一整块**。
2. `src/options/sections/cache.ts` 原来有**两个**带标记的块（Task 3 的中间态 + Task 8 的最终版）→ 同步会把两块都刷成同一份最终文件。→ 中间态那一块的标记已去掉并写明理由（手工维护，和 `options.html` / `options.css` 一样）。
