# Apple 视觉风格（单元 D · A 表皮级）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把设置页与弹窗的视觉基线换成 Apple 风格（A 档 = **只改两份 CSS 与守卫断言里的钉死值**）：令牌层换 Apple 色板（D1）、控件层换药丸按钮 / 蓝链接 / iOS 开关 / Apple 输入框与下拉 / CSS 画的 details chevron（D2）、版式层换 18px 卡片 + 发丝线 + 状态点光环 + 徽章 + 24px 统计数字 + 搜索框 + 排印节奏（D3），收口重记录 zip 并演示守卫仍在把关（D4）。

**Architecture:** 所有新颜色/新观感都走 D1 定义的令牌；`options.css` 与 `popup.css` 的共用令牌组**逐字一致**是仓库现有纪律（守卫强制），所以 D1 必须两份文件一起改。行为面零改动：`options.html` / `popup.html` 不动、`src/**/*.ts` 不动、现有 class 名一律保留（测试按 class 与 `data-action` 找元素）。外观的大部分没有断言兜着——本计划为最值得钉的少数几条加真断言（对比度纪律、开关形状、按钮体系、统计数字与光环），其余**如实声明靠肉眼**。

**Tech Stack:** 纯 CSS + Vitest（`tests/options/options-css.test.ts` 走 `tests/helpers/css.ts` 的真解析）；收口 `npx vitest run` / `npm run typecheck` / `npm run build`（含 `verify:dist`）/ `npm run zip`。

**规格：** `docs/superpowers/specs/2026-09-20-apple-visual-style-design.md`（§3 令牌表、§4 组件规格、§5 排印、§6 动效与可达性、§7 守卫影响面、§8 验收、§10 交付拆分）。
**视觉真相：** `docs/mockups/options-apple.html`——本计划所有色值、圆角、药丸、开关、发丝线、统计数字、搜索框、chevron 的 CSS 都**从它迁移而来**（映射与"故意不迁移清单"见下）。
**格式范本：** `docs/superpowers/plans/2026-09-20-multi-model-profiles.md`（单元 C）。

---

## 已核实的前提（不要重新发明）

0. **执行前提**：实现者从「仓库 + 本 Task 的小节」出发。已有文件**直接读文件**（用 `read` 工具）。⚠ **读中文文件一律用 `read` 工具，不要用 pwsh 的 `Get-Content`**——PowerShell 5.1 按 GBK 解 UTF-8，会把中文打乱甚至吞掉换行（控制器今天刚被它骗过一次）。`edit` 的锚点从 `read` 的输出里逐字复制。**锚点纪律**：每次 edit 前先确认 old_string 在该文件恰好出现一次；凡计划给了单行锚而实际有同名行的（本文件已逐个标注 ⚠ 的除外一律按整块锚处理），**用整条规则块（含块头行）作锚**，这是这类 CSS 文件里唯一可靠的定位方式。
1. **行号会漂，以仓库为准**：下文所有「位置：`文件:行号`」都按 HEAD `8979deb` 的当前内容标注，行号只作导航用；定位一律以锚点文本 + 选择器为准。
2. **基线（写本计划时实测/核过）**：
   - `npx vitest run` → `Test Files 55 passed (55)` / `Tests 1052 passed (1052)`，exit 0（起草者 2026-09-20 本机复跑确认）。
   - 现存 `jinyi-0.1.0.zip`：`64747` 字节，SHA256 `6D66C0FA2FBE3EB9413FA65BB7BD034A3EA3C7ACB477FA36BAE4695CEBE5BEE9`（起草者用 `Get-FileHash` 实测）。`.gitignore` 含 `*.zip` 与 `dist/`，所以 zip 与 dist 不进 `git status`。
   - `npm run typecheck` exit 0、`npm run build` exit 0 且 `verify:dist` 14 项——**这两条是控制器给的读数，起草者未复跑**；执行者在 D4 复跑并以输出为准。
   - ⚠ **改 CSS 之后 zip 的字节数与 SHA 必然变化**。不许把 64747 当成要保持的目标；D4 是「重新记录新值并验证两次一致」。
3. **本计划只碰 5 个文件**：`src/options/options.css`、`src/popup/popup.css`、`tests/options/options-css.test.ts`、`README.md`（D4 一句）、本计划文件（收口读数回填）。**其余一律不改**——尤其：行为测试 `options.test.ts`（31 条）、`engine-*`、`search.test.ts`、`cache-section.test.ts`、`popup.test.ts` 一条都不许动；若某条因 CSS 改动而红，说明改到了契约，**回退那处 CSS** 而不是改断言。

### 守卫钉死的七处（`tests/options/options-css.test.ts`，全部走 `tests/helpers/css.ts` 真解析）

| # | 位置 | 事实 | 本计划的应对 |
| --- | --- | --- | --- |
| 1 | `:20-29` | 遍历 `popup.css :root` 的**每一条声明**（含 `color-scheme`），要求 `options.css :root` 同名同值；options 可以有额外令牌；popup 令牌数 `>= 17` | **D1 两份 CSS 一起改**，且两边 `:root` 写成**逐字相同的 28 令牌块**（28 ≥ 17 ✓） |
| 2 | `:31-35` | 钉死暗色具体值 `--surface:#1c1f23`、`--text:#e8eaed`、`--danger:#f87171` | D1 Step 1 **同步成新值** `#1c1c1e` / `#f5f5f7` / `#ff453a`，**仍是精确相等断言**——不许改成 `toBeDefined()` 之类（那是放宽，D1 变异 M3 专门演示为什么） |
| 3 | `:36-63` | 暗色覆盖检查 + `NOT_A_COLOR` 例外清单（现有 5 项：`--radius-sm`、`--radius-md`、`--radius-pill`、`--shadow-card`、`--on-accent`）；检查集合是「**在 options.css 正文被 `var()` 引用** 且亮色有定义」的令牌 | 新增**非颜色/亮暗同值**令牌 `--radius-card`、`--ease`、`--dur`、`--knob` 进清单；新增**颜色**令牌 `--link`、`--ok-text`、`--danger-text`、`--track-off`、`--chip`、`--hover` 在 options 暗色块里**各有值**。方向沿用清单注释的口径：例外写不全→假红（安全），白名单写不全→假绿（危险） |
| 4 | `:77-82` | 正文（去掉两个 `:root` 块后）不许出现 `#hex` / `rgb(`/`rgba(`/`hsl(` 字面量 | 所有新颜色令牌化。`color-mix(in srgb, var(--x) N%, transparent)` **不含颜色字面量，合法**（光环、旋钮阴影、危险悬停底都靠它） |
| 5 | `:84-86` | options.css 全表不许出现 `opacity:`（正则带 `^|[;{\s]` 边界，**不查 popup.css**） | 新 CSS 零 `opacity`。样机 `.switch input { opacity: 0 }` 的写法**不迁移**（真实 `.switch` 就是 checkbox 本体，`appearance:none` 直接画皮，不需要藏自己） |
| 6 | `:90-94` | `*:focus-visible` 必须保留 **`outline: … var(--accent)` + `outline-offset`** | 样机用的是 `box-shadow` 发光、`outline:none` 的写法——**不许照搬**。焦点环规则 D2 **一字不改**；Apple 式光晕放在 `input:focus` 的 `box-shadow: 0 0 0 3px var(--accent-weak)`（现状已有，保留） |
| 7 | `:96-110` | `summary{cursor:pointer}`、窄窗口 `.wrap{display:block}`+`.nav{position:static}`、`[hidden]{display:none !important}` 必须原样存活（最后一条是搜索的地基） | 这三条规则本计划**不碰**（D2 给 summary 加的是 `::before` 与 display 行，`summary` 块里 `cursor: pointer;` 那行留在原地） |

### 解析器语义（`tests/helpers/css.ts`——写期望与断言前必须按这个来）

- **真解析**：按配对花括号定位规则、跳过字符串与注释。所以「把某条声明删掉」= 声明表里查不到该项 = 依赖它的断言当场红；注释里写着同名文字**不算数**。
- **选择器必须完整相等**（空白折叠后）：合并规则 `.primary,\n.ghost { … }` 的 prelude 归一化为 `.primary, .ghost`——查询时**必须写 `'.primary, .ghost'`**，写 `'.primary'` 会抛「样式表里没有选择器」。找不到规则抛错而不是返回空——这保证断言不会因选择器笔误变恒真。
- `parseDeclarations` 折叠值内空白、同名后写覆盖先写——断言里的期望串一律写**折叠后**的单空格形态（本计划已按此写好）。
- 本仓已抓到过多例「夹具与逻辑同源 ⇒ 断言恒真」。**为外观造断言只允许钉真声明**（读真实规则块的属性值），不许写 `expect(css).toContain('...')` 之类的子串恒真式，也不许为绿而绿。

### DOM 与现实差异（A 档不动 DOM，CSS 只能落在这些真实现状上；起草者逐个 read 核实）

| 事实 | 出处 | 处理 |
| --- | --- | --- |
| 展开的档案行是**一个** div `.profile-row.item`：`display:flex` 的行里挂着 `.grow`、`.row-actions` 和 `.profile-editor` 三个子节点——编辑器现在是**同一行的第三列**，被 `overflow:hidden` 剪裁（这页从未真实渲染过，没人看见过；单元 B 的天花板） | `src/options/sections/engine.ts:475/513-514` | **D3 修**：`flex-wrap: wrap` + 编辑器 `flex: 1 0 100%` + 负 margin 出血到卡缘。纯 CSS，DOM 一字不动 |
| `.switch` 就是 `<input type="checkbox" class="switch">` 本体（36×21、`::after` 画钮、`margin-left` 位移）；样机是「span 包 input + `<i>` 轨道」另一套 DOM | `options.html:119/125`、`options.css:588-618` | 样机开关 CSS **改写到 checkbox 本体**上（appearance:none + `::after` + `translateX`）；`opacity:0` 那套不迁移 |
| popup 的开关是**隐藏 checkbox + 兄弟 `.toggle-track` span**（34×20、checked 底色 `--accent`、钮 `--surface`）——与 options 结构不同 | `popup.html:52-67`、`popup.css:311-379` | D2 把 `.toggle-track` 升到 44×26 iOS 规格、checked 改 `--ok`、钮 `--knob`；`input` 上现有的 `opacity: 0` **保留原样**（popup.css 的 opacity 不在守卫扫描范围，且这是 popup 的无障碍隐藏通道） |
| **options.css 今天没有任何 `transition:`、也没有 `prefers-reduced-motion` 块**——规格 §6 说「必须保留」对 options.css 实为「**新增**」 | 起草者 grep 全文件 0 命中 | D2 在加过渡的同一 Task 里新增 reduced-motion 块（popup.css 已有 scoped 版，其选择器不用改） |
| 规格 §4 说下拉 chevron「继续用**现有** `linear-gradient` 画法」——**options.css 里现在没有任何 chevron 画法**（select 是原生箭头）；linear-gradient 在样机里，popup 用的是 mask+data-URI 另一套 | `options.css:542-555` | D2 按样机的 `linear-gradient` 画法**引入** options.css（配 `appearance:none`）；popup 的 mask chevron 已走 `var(--text-3)`，不动 |
| `input[type="password"]`（`.profile-api-key`）**不在** options.css 的 input 选择器列表里——今天 Key 输入框是裸原生外观 | `engine.ts:352-353` vs `options.css:542-546` | D2 把 `input[type="password"]` 加进列表（CSS-only，不碰 DOM） |
| 样机 A 档对 `.group/.item/.profile-row/.stat` 有 `[data-layout="a"]` 覆盖（radius-md + 无阴影），与规格 §4 正文（radius-card + 发丝 + `--shadow-card`）**冲突**——那组覆盖是「复刻旧页面」用的 | `options-apple.html:279/313/495` | **规格 §4 优先**：D3 按 `--radius-card` + `var(--border)` + `var(--shadow-card)` 落地（记账在此，若肉眼验收觉得过了，改一行令牌名回 `--radius-md` 即可，但那要写明理由） |
| 样机的 `--page`/`--separator`/`--surface-2: #ffffff` 等命名与语义**不落到真实代码**：真实页面底 = `--surface-2`（新值 `#f5f5f7`）、发丝线 = `--border`、`--surface-3` 真实语义是「白卡上的可输入底」→ 新值比页面底**深一档**（`#ececee`），样机的 `#f5f5f7` 被规格 §3.1 改写 | 规格 §3 | D1 令牌表照规格 §3 落地，不照抄样机命名 |
| `search.test.ts:312-314` 断言「options.css 里出现过的 `#sec-*` id 必须都在 DOM 里」——只查存在性，CSS 里删引用安全 | 起草者核过 | D3 删导航 `::before` 高亮条不受影响 |
| `popup.css` 正文有**既存**的 `color: #fff`（`.primary`）；`options.css` 正文零硬编码。popup.css 不在守卫的 hex/opacity 扫描范围 | `popup.css:147` | D2 顺手把 `#fff` 改成 `var(--on-accent)`（兑现 popup 文件头自己写的纪律），行为零影响（popup.test.ts 不加载 CSS） |
| `.privacy` ul 今天没有 `padding: 0`（浏览器默认 40px 左缩进挂着） | `options.css:761-767` | D3 重排隐私卡时补上 |
| 样机统计数字是「三张独立小卡（`.stats > .stat`）」；真实 DOM 是**一个** `.stat` flex 行容器里三个 `div` | `options.html:200-204` | D3 不造 DOM：把唯一的 `.stat` 容器升成一张卡，三个 `div` 是卡内三栏 |

### 行为零改动清单（出现即回退，不许多改）

`tests/options/options.test.ts`、`tests/options/engine-*.test.ts`、`tests/options/search.test.ts`、`tests/options/cache-section.test.ts`、`tests/popup/popup.test.ts`、`tests/options/harness.ts`、全部 `src/**/*.ts`、`src/options/options.html`、`src/popup/popup.html`、规格与本计划之外的全部 `docs/**`。`tests/helpers/css.ts` **不改**（它是牙，不是被检查的糖）。

### 样机 → 真实文件的迁移映射（以及故意不迁移清单）

| 样机 | 落到真实 CSS | 说明 |
| --- | --- | --- |
| `:root`/暗色块的 Apple 色板、`--link`/`--ok-text`/`--danger-text`/`--track-off`/`--knob`/`--chip`/`--hover`/`--radius-card`/`--ease`/`--dur` | D1 两份 `:root` + 暗色块 | 值按规格 §3（与样机的差异处规格赢：`--surface-3`、`--radius-pill: 999px`） |
| `.primary` 药丸 / `.ghost`、`.link` 蓝链接 / `.link-danger` 危险链接 / `.add` / `button:active scale(.975)` | D2 按钮体系 | 样机 `.ghost` 的悬停药丸底 = 真实 `.ghost`（DOM 里次级按钮就是 `.ghost`）；`.link` 类在 options 里**不存在，不新造** |
| `.switch` iOS 规格（44×26/20/18px） | D2，改写到 checkbox 本体 | 见上表 DOM 差异 |
| `.field select` 的 `linear-gradient` chevron | D2 引入 options | popup 的 mask chevron 保留原画法 |
| `summary::before` CSS 画的 6px 旋转边 | D2 | 替换现成的 `"▸ "/"▾ "` 文字箭头；`summary{cursor:pointer}` 留守卫 |
| 发丝线、18px 卡、`--radius-card` | D3 卡片与分组 | 规格 §4 |
| `.dot` 的 `color-mix` 光环、`.badge`/`.badge-muted`、`.stat b` 24px/650/-0.03em/tabular、搜索框、`.nav-link` 悬停/高亮 | D3 | 状态点三态 `--ok/--text-3/--danger` 不动，只加光环 |
| **不迁移**：`*:focus-visible` 的 `box-shadow` 发光写法（`outline:none`） | — | 守卫钉 6（照搬必红）；光晕走 `input:focus` 的既有 box-shadow |
| **不迁移**：分段控件 `.segmented`、样机开关条 `.lab-bar/.seg`、`data-layout="b"` 侧栏满高、`backdrop-filter` 毛玻璃、Inter/Google Fonts、`--stack-inter`、`--shadow-pop`、`--nav-w: 240px`、`html[data-theme]` 手动主题块 | — | 规格 §1/§2 非目标；`--nav-w` 对应真实骨架 `236px` 不动；`[hidden]` 样式不许用 `opacity:0` 变体（守卫 5） |
| **不迁移**：`.glyph` 的 `linear-gradient(180deg, #4a9cff, …)`（含 hex 字面量）、`.switch input{opacity:0}`、`.switch i::after{background:#fff; box-shadow: rgba(0,0,0,.25)}`（hex/rgba 字面量→令牌化：`--knob` + `color-mix(… var(--text) 25% …)`） | — | 守卫 4/5 |
| **不迁移**：`summary { color: var(--text-2) }`（样机） | 保留真实 `var(--accent)` | 本页折叠头的既有语义，规格 §4 也没要求改颜色 |
| **不迁移**：A 档对 `.group/.item/.stat` 的 radius-md + `box-shadow:none` 覆盖 | 规格 §4 的 radius-card + shadow | 冲突记账见上表 |

---

## 文件结构

| 文件 | 责任 | 动作 |
| --- | --- | --- |
| `src/options/options.css` | 设置页全部视觉（852 行；`*.html` 唯一样式来源） | D1 令牌 + 3 处对比度迁移；D2 控件；D3 版式。**除这两个 Task 外不碰** |
| `src/popup/popup.css` | 弹窗视觉（452 行）。与 options 共用 `:root` 令牌组 | D1 同令牌块（逐字一致）+ `.hint.warn` 文字色；D2 同类控件升皮。**不重排信息层级、不动 body 宽度** |
| `tests/options/options-css.test.ts` | 样式纪律守卫 | D1 同步 3 个钉死值 + `NOT_A_COLOR` + 新增对比度纪律用例；D2 新增控件层 2 用例；D3 新增 1 用例。**只加牙，不磨牙** |
| `README.md` | 用户文档 | 仅 D4 在「已知限制 → 设置页」加一句视觉基线说明 |
| 本文件 | 计划与落地读数 | 执行者回填「落地读数表」 |

---

## Task D1：令牌层（两份 CSS + 守卫同步，含对比度迁移）

**Files:**
- Modify: `tests/options/options-css.test.ts`
- Modify: `src/options/options.css`（`:root` 块、暗色 `:root` 块、`.status[data-kind="ok"]`、`.status[data-kind="err"]`、`.link-danger`）
- Modify: `src/popup/popup.css`（`:root` 块、暗色 `:root` 块、`.hint.warn`）

**先改测试后改 CSS**：让守卫先红（钉死值 + 新纪律各一条），再按 D1→popup 的顺序被它逐条「咬」绿——每一步的期望红形态都写在步骤里。

- [ ] **Step 1：同步守卫里被钉死的三个暗色值 + 扩 `NOT_A_COLOR` + 加对比度纪律用例**

四处编辑（全部先 `read` 该测试文件确认锚点唯一）：

1a. 把
```ts
    expect(dark['--surface']).toBe('#1c1f23');
    expect(dark['--text']).toBe('#e8eaed');
    expect(dark['--danger']).toBe('#f87171');
```
改为
```ts
    expect(dark['--surface']).toBe('#1c1c1e');
    expect(dark['--text']).toBe('#f5f5f7');
    expect(dark['--danger']).toBe('#ff453a');
```

1b. 把 `NOT_A_COLOR` 数组
```ts
    const NOT_A_COLOR = new Set([
      '--radius-sm',
      '--radius-md',
      '--radius-pill',
      '--shadow-card',
      // 强调色上的文字色，亮/暗都是 `#ffffff`：暗色下强调色仍是深蓝，白字照样可读。
      // 这是设计上有据可查的例外，不是漏定义。
      '--on-accent',
    ]);
```
改为
```ts
    const NOT_A_COLOR = new Set([
      '--radius-sm',
      '--radius-md',
      '--radius-card',
      '--radius-pill',
      '--ease',
      '--dur',
      '--shadow-card',
      // 强调色上的文字色，亮/暗都是 `#ffffff`：暗色下强调色仍是深蓝，白字照样可读。
      // 这是设计上有据可查的例外，不是漏定义。
      '--on-accent',
      // 开关旋钮与它同理：亮/暗都是 `#ffffff`（规格 §3.1）。iOS 的白钮在暗色下依然对——
      // 底下是 `--track-off`/`--ok`，不是深色文字底。
      '--knob',
    ]);
```
（新增颜色令牌 `--link`/`--ok-text`/`--danger-text`/`--track-off`/`--chip`/`--hover` **不进**清单——它们在暗色块各有值，会被正常检查。）

1c. 在「暗色只定义一次」用例的收尾之后、`describe('设置页样式：令牌')` 的收尾 `});` 之前插入新用例。锚点（文件里唯一）：
```ts
    expect(darkMissing).toEqual([]);
  });
```
在其后（`  });` 与 `});` 之间）插入：
```ts
  it('对比度纪律：--ok/--danger 只出现在非文字属性上，绿/红文字一律走 --ok-text/--danger-text（规格 §7.8）', () => {
    const body = stripCssComments(optionsCss);
    // 正文里任何 `color:` 拿 `--ok`/`--danger` 都是不可读的亮绿/亮红文字（#34c759 白底约 2.2:1）。
    // 背景（状态点、开关轨道）不受此限——它们本来就该用 iOS 亮色。
    // 正则带 `^|[;{\s]` 边界：`background-color:` 之类不会被误伤，注释已由 stripCssComments 排除。
    expect(body.match(/(?:^|[;{\s])color:\s*var\(--ok\)/g) ?? []).toEqual([]);
    expect(body.match(/(?:^|[;{\s])color:\s*var\(--danger\)/g) ?? []).toEqual([]);
    // 四处已核实的文字用法必须指向文字令牌（popup.css 的 `.hint.warn` 是第四处）。
    expect(declarations(optionsCss, '.status[data-kind="ok"]')['color']).toBe('var(--ok-text)');
    expect(declarations(optionsCss, '.status[data-kind="err"]')['color']).toBe('var(--danger-text)');
    expect(declarations(optionsCss, '.link-danger')['color']).toBe('var(--danger-text)');
    expect(declarations(popupCss, '.hint.warn')['color']).toBe('var(--danger-text)');
    // 硬币的另一半：点与开关的背景仍用 --ok/--danger——迁移它们就是把 2.2:1 换成 4.5:1 再换回去。
    expect(declarations(optionsCss, '.dot[data-state="ok"]')['background']).toBe('var(--ok)');
    expect(declarations(optionsCss, '.dot[data-state="bad"]')['background']).toBe('var(--danger)');
  });
```

- [ ] **Step 2：跑守卫，确认「红得对」**

Run: `npx vitest run tests/options/options-css.test.ts`
Expected: `Tests 2 failed | 7 passed (9)`——
「暗色只定义一次…」红在 `AssertionError: expected '#1c1f23' to be '#1c1c1e' // Object.is equality`；
「对比度纪律」红在第一条正则（命中现存 `color: var(--ok)` / `color: var(--danger)` 的字面串）。
若红的是别的用例或数目不对，**停下**：说明锚点/环境与本计划假设不符，不是继续的理由。

- [ ] **Step 3：把 options.css 的 `:root` 换成新令牌块**

把现有整个 `:root { … }`（从 `:root {` 到 `--radius-pill: 999px;\n}`，含内部注释）替换为：

```css
:root {
  color-scheme: light dark;

  /* 下面这一组与 src/popup/popup.css 的 `:root` 必须逐字一致（两份 CSS 各写一份，
     不引第三个文件：扩展页面只加载自己那一份，共用文件会凭空多一个构建期依赖）。 */
  --surface: #ffffff;
  --surface-2: #f5f5f7;
  --surface-3: #ececee;
  --border: rgba(0, 0, 0, 0.08);
  --border-strong: rgba(0, 0, 0, 0.14);
  --text: #1d1d1f;
  --text-2: #6e6e73;
  --text-3: #86868b;
  --accent: #0071e3;
  --accent-hover: #0077ed;
  --accent-weak: rgba(0, 113, 227, 0.12);
  --ok: #34c759;
  --danger: #ff3b30;
  --on-accent: #ffffff;
  /* 单元 D 新增（规格 §3.1）。每个都要么在暗色块里有值，要么进守卫的 NOT_A_COLOR 例外清单。 */
  --link: #0066cc; /* Apple 链接蓝：文字按钮专用，与按钮蓝 --accent 分职 */
  --ok-text: #248a3d; /* 绿色文字专用：--ok 的 #34c759 在浅底上约 2.2:1，读不清 */
  --danger-text: #d70015; /* 红色文字专用（「删除」与错误状态行） */
  --track-off: rgba(120, 120, 128, 0.32); /* iOS 开关关态轨道 */
  --knob: #ffffff; /* 开关旋钮：亮暗同值，走 NOT_A_COLOR 例外（同 --on-accent 的道理） */
  --chip: rgba(120, 120, 128, 0.16); /* 徽章底、行内代码底 */
  --hover: rgba(0, 0, 0, 0.035); /* 行/链接悬停底 */
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.04), 0 6px 20px rgba(0, 0, 0, 0.05);
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-card: 18px;
  --radius-pill: 999px;
  --ease: cubic-bezier(0.32, 0.72, 0, 1); /* Apple 缓动（非颜色，例外清单） */
  --dur: 200ms;
}
```

- [ ] **Step 4：把 options.css 的暗色块换成新值（含新颜色令牌）**

把现有整个 `@media (prefers-color-scheme: dark) { … }` 替换为：

```css
@media (prefers-color-scheme: dark) {
  :root {
    --surface: #1c1c1e;
    --surface-2: #000000;
    --surface-3: #2c2c2e;
    --border: rgba(255, 255, 255, 0.12);
    --border-strong: rgba(255, 255, 255, 0.2);
    --text: #f5f5f7;
    --text-2: #a1a1a6;
    --text-3: #8e8e93;
    --accent: #0a84ff;
    --accent-hover: #409cff;
    --accent-weak: rgba(10, 132, 255, 0.22);
    --ok: #30d158;
    --danger: #ff453a;
    --link: #419cff;
    --ok-text: #30d158;
    --danger-text: #ff453a;
    --track-off: rgba(120, 120, 128, 0.42);
    --chip: rgba(120, 120, 128, 0.32);
    --hover: rgba(255, 255, 255, 0.05);
    --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.5), 0 6px 20px rgba(0, 0, 0, 0.4);
  }
}
```

（**刻意不含** `--knob`/`--radius-card`/`--ease`/`--dur`：亮暗同值或非颜色——它们已被 Step 1b 的例外清单豁免；`--ok-text` 与 `--ok`、`--danger-text` 与 `--danger` 在暗色下同值，这是 Apple 暗色的读法，也是规格 §3.1 的暗色列。）

- [ ] **Step 5：迁移四处文字色（options 三处 + popup 一处；popup 那处必须在这里做，否则 Step 6 的红形态对不上）**

3a. options.css 三处（同一文件，锚点各自唯一）：
```css
.status[data-kind="ok"] {
  color: var(--ok);
}
```
→ `  color: var(--ok-text);`（只改这一行，块其余不动）

```css
.status[data-kind="err"] {
  color: var(--danger);
}
```
→ `  color: var(--danger-text);`

```css
.link-danger {
  padding: 4px 8px;
  font-size: 13px;
  color: var(--danger);
```
→ 同块内这一行 `  color: var(--danger-text);`

3b. `src/popup/popup.css`——把
```css
.hint.warn {
  color: var(--danger);
}
```
改为
```css
.hint.warn {
  color: var(--danger-text);
}
```
（Step 1 新增的对比度用例断言了 popup 这一处，所以它必须与 options 三处同批迁移。）

- [ ] **Step 6：跑守卫——此时它应当咬在「逐字一致」上（这正是要看的红）**

Run: `npx vitest run tests/options/options-css.test.ts`
Expected: `Tests 1 failed | 8 passed (9)`，唯一红项是「与 popup.css 共用的那一组令牌逐字一致（亮色）」，diff 形如
`AssertionError: expected '--surface-2: #f5f5f7' to be '--surface-2: #f6f7f9' // Object.is equality`。
这条红就是守卫 ① 在强制「D1 必须两份 CSS 一起改」——看到它才算走对了路。

- [ ] **Step 7：把 popup.css 的 `:root` 与暗色块换成逐字相同的两块**

7a. `:root`：**把 Step 3 写入 options.css 的那个完整 `:root { … }` 块逐字复制**，替换 popup.css 现有的 `:root` 块（两文件该块的注释头本来就相同，直接整体替换）。
7b. 暗色块：**把 Step 4 的整个 `@media (prefers-color-scheme: dark) { … }` 逐字复制**，替换 popup.css 现有块。
（`.hint.warn` 的文字色已在 Step 5 的 3b 迁掉。）

- [ ] **Step 8：跑守卫全绿，再跑全量**

Run: `npx vitest run tests/options/options-css.test.ts` → Expected: `Tests 9 passed (9)`。
Run: `npx vitest run` → Expected: `Test Files 55 passed (55)` / `Tests 1053 passed (1053)`（基线 1052 + 1 条新用例；数字对不上就是有人在别处动了用例，停下核对）。

- [ ] **Step 9：D1 变异核验（做完必须当场 revert，`git diff --stat` 确认干净）**

| # | 变异 | 期望红 |
| --- | --- | --- |
| M1 | （Step 6 已天然演示）只改 options 不改 popup | 「逐字一致」红在第一个漂的令牌上 |
| M2 | 从 **options.css 暗色块**删掉整行 `--ok-text: #30d158;` | 红 `AssertionError: expected [ '--ok-text' ] to deeply equal []`——覆盖断言**点名**缺哪个（跑 `Tests 1 failed | 8 passed (9)`）。**为什么用 `--ok-text` 而不是 `--link`**：覆盖断言只查「被正文 `var()` 引用」的令牌——D1 结束时正文刚引用 `--ok-text`/`--danger-text`，而 `--link`/`--track-off`/`--chip`/`--hover` 要到 D2/D3 才进正文；拿它们做这个变异此刻**不会红**。D4 汇总表补 `--link` 版 |
| M3 | 把 `expect(dark['--text']).toBe('#f5f5f7')` 改成 `expect(dark['--text']).toBeDefined()`，**再把暗色块 `--text` 临时改回 `#e8eaed`** | **全绿（9/9）**。这就证明了 `toBeDefined()` 不再把关：旧暗色值漂回来它也不响。规格 §7.2 要的是「同步事实」，`toBe(新值)` 同时钉住「值对」与「键在」，`toBeDefined()` 只钉后者——那是放宽。**跑完把两处都改回去，重跑 9/9 绿** |
| M4 | 把 `.status[data-kind="ok"]` 的 color 改回 `var(--ok)` | 「对比度纪律」红（正则命中 + `expected 'var(--ok)' to be 'var(--ok-text)'` 双保险） |

- [ ] **Step 10：Commit**

```powershell
git add -- src/options/options.css src/popup/popup.css tests/options/options-css.test.ts
git commit -m "style(options): 单元 D1——Apple 令牌层（两套配色 + --link/--ok-text/--danger-text/--track-off/--knob/--chip/--hover/--radius-card/--ease/--dur），守卫钉死值同步事实并加对比度纪律断言" -- src/options/options.css src/popup/popup.css tests/options/options-css.test.ts
```

---

## Task D2：控件层（按钮 / iOS 开关 / 输入与下拉 / details chevron / 动效与 reduced-motion）

**Files:**
- Modify: `tests/options/options-css.test.ts`（追加两个用例）
- Modify: `src/options/options.css`（按钮体系、表单控件、开关、summary chevron、焦点环**不动**、文件尾加 reduced-motion）
- Modify: `src/popup/popup.css`（同类控件升皮：主按钮药丸、开关轨道、下拉、图标按钮、内联链接、body 字体栈）

断言先红后绿的顺序与本 Task 的 CSS 一次给全。**外观改动里没有断言的部分（悬停底、scale、间距微差）靠肉眼**——不为其造恒真式。

- [ ] **Step 1：先加两条「有牙」的守卫用例**

在 `tests/options/options-css.test.ts` **文件末尾**（最后一个 `});` 之后）追加：

```ts
describe('设置页样式：D2 控件层', () => {
  it('按钮体系：主按钮药丸+--accent、次级是蓝链接 --link、危险链接悬停用 color-mix（样机映射）', () => {
    // 合并规则按解析器语义整体点名（选择器必须完整相等），这正是它比子串匹配强的地方。
    const shell = declarations(optionsCss, '.primary, .ghost');
    expect(shell['border-radius']).toBe('var(--radius-pill)');
    expect(shell['height']).toBeUndefined(); // 高度回到内容盒（样机 padding 撑高），旧 34px 必须已删
    const primary = declarations(optionsCss, '.primary');
    expect(primary['background']).toBe('var(--accent)');
    expect(primary['color']).toBe('var(--on-accent)');
    expect(primary['padding']).toBe('7px 17px');
    expect(declarations(optionsCss, '.primary:hover')['background']).toBe('var(--accent-hover)');
    const ghost = declarations(optionsCss, '.ghost');
    expect(ghost['color']).toBe('var(--link)');
    expect(ghost['background']).toBe('transparent');
    expect(declarations(optionsCss, '.ghost:hover')['background']).toBe('var(--accent-weak)');
    expect(declarations(optionsCss, '.link-danger')['background']).toBe('transparent');
    expect(declarations(optionsCss, '.link-danger:hover')['background']).toBe(
      'color-mix(in srgb, var(--danger) 12%, transparent)',
    );
  });

  it('iOS 开关直接画在原生 checkbox 上（--track-off 关态 / --ok 开态 / --knob 旋钮 / translateX 滑动）', () => {
    const sw = declarations(optionsCss, '.switch');
    expect(sw['appearance']).toBe('none');
    expect(sw['background']).toBe('var(--track-off)');
    expect(sw['width']).toBe('44px');
    expect(sw['height']).toBe('26px');
    expect(declarations(optionsCss, '.switch:checked')['background']).toBe('var(--ok)');
    const knob = declarations(optionsCss, '.switch::after');
    expect(knob['background']).toBe('var(--knob)');
    expect(knob['position']).toBe('absolute');
    expect(declarations(optionsCss, '.switch:checked::after')['transform']).toBe('translateX(18px)');
  });
});
```

Run: `npx vitest run tests/options/options-css.test.ts`
Expected: `Tests 2 failed | 9 passed (11)`——「按钮体系」红在第一条就查不到的项：`expected undefined to be 'var(--radius-pill)'`（现合并壳没有 border-radius）；「iOS 开关」红在 `expected 'var(--border-strong)' to be 'var(--track-off)'`（现 `.switch` 已有 appearance:none，前一条断言此刻反而过——失败点落在 background）。

- [ ] **Step 2：options.css——按钮体系（整段替换）**

把 `button { … }` 起，经 `.primary, .ghost`、`.primary`、`.primary:hover`、`.ghost`、`.ghost:hover`、`.tiny`（到 `.tiny` 块的收尾 `}` 为止；**不含** `.link-danger` 那段的注释与规则）整段替换为：

```css
button {
  font: inherit;
  font-size: 13px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease),
    border-color var(--dur) var(--ease), transform var(--dur) var(--ease);
}

/* Apple 的按压反馈：轻微收缩，不动尺寸只动 transform（规格 §6：只动 transform 一类）。 */
button:active {
  transform: scale(0.975);
}

/* 主按钮 = 药丸（样机 .primary）；次级 = 蓝链接药丸（样机 .ghost/.link）——
   真实 DOM 没有 .link 类，样机的蓝链接语言落到既有契约类 .ghost 上，class 名不改。 */
.primary,
.ghost {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 500;
  white-space: nowrap;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
}

.primary {
  padding: 7px 17px;
  color: var(--on-accent);
  background: var(--accent);
  border-color: var(--accent);
}

.primary:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

.ghost {
  padding: 6px 12px;
  color: var(--link);
  background: transparent;
}

.ghost:hover {
  background: var(--accent-weak);
}

.tiny {
  padding: 5px 11px;
  font-size: 12.5px;
  font-weight: 400;
}
```

（对比度迁移已在 D1 做完：`--link` 是**新**的蓝链接令牌，不是 `--accent` 的别名——样机里按钮蓝 `#0071e3` 与链接蓝 `#0066cc` 是两个值、两个职。）

紧接着把 `.link-danger` 两段替换为（保留它上方那条「红色文字按钮，不要描边」的注释）：

```css
.link-danger {
  padding: 6px 12px;
  font-size: 13px;
  color: var(--danger-text);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
}

.link-danger:hover {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}
```

- [ ] **Step 3：options.css——添加按钮 `.add`（样机是「虚线 + --link 文字」）**

把
```css
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
替换为
```css
.add {
  width: 100%;
  padding: 9px 14px;
  font-size: 13.5px;
  color: var(--link);
  text-align: left;
  background: transparent;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
}

.add:hover {
  background: var(--accent-weak);
  border-color: var(--accent);
}
```
（`.add:disabled` 块**原样保留**——它治的「禁用看着可点」是真缺陷，`7991539` 修的。）

- [ ] **Step 4：options.css——输入框 / 下拉（chevron 用样机的 linear-gradient 画法）**

把「表单控件」小节开头的三段（`input[type="text"], … textarea { … }`、`input:hover, … { … }`、`input:focus, … { … }`）替换为：

```css
input[type="text"],
input[type="password"],
input[type="search"],
input[type="number"],
select,
textarea {
  min-width: 0;
  padding: 7px 10px;
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background-color: var(--surface-3);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  transition: background-color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}

/* 样机 .field select 的画法：两条 linear-gradient 拼一个 5px 的 chevron，颜色走 --text-3，
   零外部资源、零图标字体（规格 §4）。悬停/聚焦只换 border-color 与背景色，
   背景一律写 background-color，防止 shorthand 把 chevron 图层抹掉。 */
select {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 26px;
  background-image: linear-gradient(45deg, transparent 50%, var(--text-3) 50%),
    linear-gradient(135deg, var(--text-3) 50%, transparent 50%);
  background-position: calc(100% - 15px) 52%, calc(100% - 10px) 52%;
  background-size: 5px 5px;
  background-repeat: no-repeat;
}

input:hover,
select:hover,
textarea:hover {
  background-color: var(--surface);
  border-color: var(--border);
}

input:focus,
select:focus,
textarea:focus {
  background-color: var(--surface);
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
  outline: none;
}
```

（焦点环守卫钉的是 `*:focus-visible` 块——那一条**一个字不改**；这里的 `input:focus` 光晕是现状就有的写法，保留。样机 `*:focus-visible` 的 `box-shadow` 发光**故意不照搬**。）

- [ ] **Step 5：options.css——iOS 开关（整段替换四块）**

把
```css
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
```
替换为
```css
.switch {
  position: relative;
  flex: none;
  width: 44px;
  height: 26px;
  padding: 0;
  appearance: none;
  -webkit-appearance: none;
  cursor: pointer;
  background: var(--track-off);
  border: none;
  border-radius: var(--radius-pill);
  transition: background var(--dur) var(--ease);
}

.switch:checked {
  background: var(--ok);
}

.switch::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  background: var(--knob);
  border-radius: 50%;
  box-shadow: 0 1px 3px color-mix(in srgb, var(--text) 25%, transparent);
  transition: transform var(--dur) var(--ease);
}

.switch:checked::after {
  transform: translateX(18px);
}
```
（位移从 `margin-left` 改成 `translateX`：动 transform 不动布局，是规格 §6 的口径。样机旋钮的 `#fff` 与 `rgba(0,0,0,.25)` 两个字面量都令牌化了。）

- [ ] **Step 6：options.css——details chevron（CSS 画的旋转边）**

6a. 把
```css
summary {
  font-size: 12.5px;
  color: var(--accent);
  cursor: pointer;
  list-style: none;
}
```
替换为（`cursor: pointer;` 原行保留——守卫 7 钉它）
```css
summary {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--accent);
  cursor: pointer;
  list-style: none;
}
```

6b. 把
```css
summary::before {
  content: "▸ ";
}

details[open] summary::before {
  content: "▾ ";
}
```
替换为（样机 `details.profile-advanced > summary::before` 的画法，落在真实的全局 `summary` 上；颜色 --text-3 走令牌）
```css
summary::before {
  content: "";
  flex: none;
  width: 6px;
  height: 6px;
  border-right: 1.8px solid var(--text-3);
  border-bottom: 1.8px solid var(--text-3);
  transform: rotate(-45deg);
  transition: transform var(--dur) var(--ease);
}

details[open] summary::before {
  transform: rotate(45deg);
}
```

- [ ] **Step 7：options.css——reduced-motion 收尾（本文件第一处 transition 的保险丝）**

在文件**末尾**（`.search-empty` 块之后）追加。规格 §6 说「必须保留」，但 options.css 现状**没有**这个块（见「DOM 与现实差异」表）——这是**新增**，不是保留：

```css
/* ------------------------------------------------------------------ 动效保险丝 */

/* D2 起本页有过渡了：reduced-motion 下全部关掉（样机同一写法）。 */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition: none !important;
    animation: none !important;
  }
}
```

- [ ] **Step 8：popup.css——同类控件升皮（无断言兜着，逐条肉眼，但都是现成结构的值替换）**

8a. 主按钮：`.primary` 块里 `  color: #fff;` 改为 `  color: var(--on-accent);`。⚠ 改 `  border-radius: var(--radius-sm);` → `var(--radius-pill)` 时注意 `.icon-button` 块里有同名行——锚点带上 `.primary` 独有的相邻两行 `  background: var(--accent);\n  border: none;`。再给 `.primary` 块补一行 `  transition: background var(--dur) var(--ease), transform var(--dur) var(--ease);`。
把
```css
.primary:active {
  background: var(--accent-hover);
  filter: brightness(0.94);
}
```
改为
```css
.primary:active {
  background: var(--accent-hover);
  filter: brightness(0.94);
  transform: scale(0.975);
}
```
（`filter` 留着：禁用态靠 `filter: none` 复位，三条 disabled 规则不动。⚠ 本弹窗的 reduced-motion 块现状只关 `.toggle-track` 两处——`.primary` 加了过渡后它不再够用，由 8g 统一升级。）

8b. 开关轨道（样机 iOS 规格落在这份文件自己的 DOM 上——隐藏 checkbox + `.toggle-track`）：把 `.toggle-track { … }`、`.toggle-track::after { … }`、`:checked + .toggle-track { … }`、`:checked + .toggle-track::after { … }` 四块替换为：

```css
.toggle-track {
  position: relative;
  flex: 0 0 auto;
  width: 44px;
  height: 26px;
  background: var(--track-off);
  border: none;
  border-radius: var(--radius-pill);
  transition: background var(--dur) var(--ease);
}

.toggle-track::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  background: var(--knob);
  border-radius: 50%;
  box-shadow: 0 1px 3px color-mix(in srgb, var(--text) 25%, transparent);
  transition: transform var(--dur) var(--ease);
}

.field-toggle > input[type="checkbox"]:checked + .toggle-track {
  background: var(--ok);
}

.field-toggle > input[type="checkbox"]:checked + .toggle-track::after {
  transform: translateX(18px);
}
```
（开态从 `--accent` 换成 `--ok`：与 options 的开关同一语义，样机口径。`:focus-visible + .toggle-track` 的 outline 规则不动。）

8c. 下拉：把 `.field > select` 块里的
`  background-color: var(--surface-2);\n  border: 1px solid var(--border);\n  border-radius: var(--radius-sm);`
三行替换为
`  background-color: var(--surface-3);\n  border: 1px solid transparent;\n  border-radius: var(--radius-md);`，
把 hover 块
```css
.field > select:hover {
  border-color: var(--border-strong);
}
```
改为
```css
.field > select:hover {
  border-color: var(--border);
  background-color: var(--surface);
}
```
（`:focus-visible` 块保持原样——accent 边框 + 光晕已经是守卫 6 旁边「可以并存」的写法。mask chevron 与 `--chevron` data-URI **不动**，它已走 `--text-3`。）

8d. 图标按钮悬停：整块替换（⚠ `  background: var(--surface-3);` 单行在 popup.css 里另有三处——`.primary:disabled` 两条 + 下拉的 background-**color**；必须带块头）：
```css
.icon-button:hover {
  color: var(--text);
  background: var(--surface-3);
}
```
→ 只把其中 `  background: var(--surface-3);` 改为 `  background: var(--hover);`（块内三行组合全文件唯一）。
8e. 内联链接：`.link` 块里 `  color: var(--accent);` → `  color: var(--link);`（hover 的 `--accent-hover` 不动）。⚠ `.brand-mark` 块有同名行——锚点带上 `.link` 独有的上一行 `  font: inherit;`。
8f. 字体栈：把
`  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;`
替换为
```css
  font: 400 14px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC",
    "Microsoft YaHei", sans-serif;
```
（行高 1.5 保留：弹窗 320px 宽、不重排是规格 §2 的纪律；options 的 1.47 不硬灌进来。）

8g. 弹窗的动效保险丝升级——把文件末尾现有**只关两处轨道**的块：
```css
@media (prefers-reduced-motion: reduce) {
  .toggle-track,
  .toggle-track::after {
    transition: none;
  }
}
```
替换为与 options 同一写法的整表关断（8a 之后 `.primary` 也有了过渡，旧块不再够用；`.toggle-track` 两行被 `*` 吸收，不残留）：
```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition: none !important;
    animation: none !important;
  }
}
```

- [ ] **Step 9：跑测试**

Run: `npx vitest run tests/options/options-css.test.ts` → Expected: `Tests 11 passed (11)`。
Run: `npx vitest run` → Expected: `Test Files 55 passed (55)` / `Tests 1055 passed (1055)`。

- [ ] **Step 10：D2 变异核验（当场 revert，跑完 `git diff --stat` 干净）**

| # | 变异 | 期望 |
| --- | --- | --- |
| M1 | 删 `.switch` 的 `appearance: none;` 行 | 「iOS 开关」用例红：`expected undefined to be 'none'`（这条断言真实读的是规则块里的声明，删了就是查不到） |
| M2 | 把 `.ghost` 的 color 改回 `var(--accent)` | 「按钮体系」红：`expected 'var(--accent)' to be 'var(--link)'`。**区别说明**：样机里按钮蓝 `#0071e3` 与链接蓝 `#0066cc` 是两个令牌两个职——断言钉「用的是 `--link`」这个**身份**；`--link` 的**值**由两份 CSS 的 `:root` 逐字一致 + 暗色覆盖兜着，值本身没有单独的 toBe（现状只有 :31-35 钉的三个暗色值有） |
| M3 | 把 `.primary,\n.ghost` 合并壳里的 `border-radius: var(--radius-pill);` 删掉 | 「按钮体系」红两处：`expected undefined to be 'var(--radius-pill)'`；再把壳里 `height` 若被加回 `34px`，`toBeUndefined()` 断言红——两条一起证明「药丸无固定高」是契约 |
| M4 | 给 `.ghost` 加一行 `opacity: .8` | 既有守卫「不许用 opacity」当场红——**不需要新断言**，现状就有牙（跑完确认 revert） |

- [ ] **Step 11：Commit**

```powershell
git add -- src/options/options.css src/popup/popup.css tests/options/options-css.test.ts
git commit -m "style(options): 单元 D2——药丸主按钮/蓝链接次级/危险链接、iOS 开关、输入与下拉 chevron、details 旋转边、reduced-motion 保险丝；popup 同类控件同皮" -- src/options/options.css src/popup/popup.css tests/options/options-css.test.ts
```

---

## Task D3：版式层（卡片与分组 / 发丝线 / 状态点光环 / 徽章 / 统计数字 / 搜索框 / 排印节奏 + 编辑器换行修复）

**Files:**
- Modify: `tests/options/options-css.test.ts`（追加 1 个用例）
- Modify: `src/options/options.css`（下列 Step 2-10 共 30 来处小改；窄窗口与 `[hidden]` 两块**不碰**）

**如实声明**：D3 的外观改动里，被断言钉住的只有统计数字与状态点光环（Step 1 的一条用例）；其余（发丝线、圆角、编辑器换行、排印）没有断言兜着，靠 D4 的肉眼验收。不为其造恒真式。

- [ ] **Step 1：先加一条有牙的用例**

在 `tests/options/options-css.test.ts` **文件末尾**追加：

```ts
describe('设置页样式：D3 版式层（只钉两条，其余肉眼验收——不造恒真式）', () => {
  it('统计数字 24px/650/-0.03em 且 tabular-nums（刷新时数字不跳位）；状态点带 color-mix 光环', () => {
    const stat = declarations(optionsCss, '.stat b');
    expect(stat['font-size']).toBe('24px');
    expect(stat['font-weight']).toBe('650');
    expect(stat['letter-spacing']).toBe('-0.03em');
    expect(stat['font-variant-numeric']).toBe('tabular-nums');
    expect(declarations(optionsCss, '.dot[data-state="ok"]')['box-shadow']).toBe(
      '0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent)',
    );
    expect(declarations(optionsCss, '.dot[data-state="bad"]')['box-shadow']).toBe(
      '0 0 0 3px color-mix(in srgb, var(--danger) 22%, transparent)',
    );
  });
});
```

Run: `npx vitest run tests/options/options-css.test.ts` → Expected: `Tests 1 failed | 11 passed (12)`（红在统计数字第一条：`AssertionError: expected '20px' to be '24px'`——现状 `.stat b` 是 20px）。

- [ ] **Step 2：排印节奏（规格 §5）——body 与标题**

2a. 把
```css
body {
  margin: 0;
  padding: 0;
  font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--text);
  background: var(--surface-2);
}
```
替换为
```css
body {
  margin: 0;
  padding: 0;
  /* 系统栈不打包（规格 §1 第三决定）：Windows 实际落到 Segoe UI/微软雅黑——已知并接受的代价。 */
  font: 400 14px/1.47 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC",
    "Microsoft YaHei", sans-serif;
  letter-spacing: -0.01em;
  color: var(--text);
  background: var(--surface-2);
  -webkit-font-smoothing: antialiased;
}
```

2b. 把
```css
.sec-head h2 {
  margin: 0;
  font-size: 15px;
  letter-spacing: -0.005em;
}
```
替换为（样机 sec-head 17px/650）
```css
.sec-head h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.02em;
}
```

2c. 把 `.sec-head` 块的 `  margin: 0 0 4px;` 改为（A 档区块标题下发丝线，样机 `[data-layout="a"] .sec-head`）
```css
  margin: 0 0 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
```

2d. 整块替换 `.sec-desc`（⚠ 单行 `  font-size: 12.5px;` 多处同名，必须带块头）：
```css
.sec-desc {
  margin: 0 0 14px;
  font-size: 12.5px;
  color: var(--text-2);
}
```
→
```css
.sec-desc {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
}
```
2e. 整块替换 `.hint`（popup.css 里也有 `.hint`，但 edit 按文件定位，此处是 options.css）：
```css
.hint {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
```
→
```css
.hint {
  margin: 0 0 12px;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--text-2);
}
```
2f. `.name` 块里补一行（样机 .name）：`  letter-spacing: -0.014em;`（放在 `font-weight: 600;` 之后）。
2g. 整块替换 `.status`（⚠ `  color: var(--text-3);` 单行多处同名）：
```css
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
```
→ 同块内改 `  color: var(--text-2);` 并在 `white-space` 前补 `  font-variant-numeric: tabular-nums;`；再把
```css
.status[data-kind="pending"] {
  color: var(--text-2);
}
```
替换为（样机：进行中的状态行是链接蓝）
```css
.status[data-kind="pending"] {
  color: var(--link);
}
```

- [ ] **Step 3：卡片与分组（`--radius-card` + 发丝线 + 行高节奏）**

3a. 把
```css
.item,
.profile-row {
  margin-bottom: 9px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
}
```
替换为
```css
.item,
.profile-row {
  margin-bottom: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
}
```

3b. 整块替换 `.group`（⚠ `  border-radius: var(--radius-md);` 此刻在文件里有三处同名行——`.add`、`.privacy li` 与它）：
```css
.group {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}
```
→ 保持五行结构不变，仅把第三行改为 `  border-radius: var(--radius-card);`（块内五行组合唯一）。
3c. 把
```css
.grow2,
.field {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 16px;
  border-top: 1px solid var(--border);
}
```
替换为（行最小高 46、左右 16——规格 §4「行」条）
```css
.grow2,
.field {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  min-height: 46px;
  border-top: 1px solid var(--border);
}
```
3d. 整块替换 `.grow2:hover`（⚠ `  background: var(--surface-2);` 单行同名还有 `.profile-editor` 与 `.privacy code` 两处，必须带块头）：
```css
.grow2:hover {
  background: var(--surface-2);
}
```
→
```css
.grow2:hover {
  background: var(--hover);
}
```
3e. 整块替换 `.item { display:flex; align-items:center; gap:12px; padding:13px 16px; }` 为同形但 `padding: 12px 16px;`（⚠ `.privacy li` 也有 `  padding: 13px 16px;` 同名行——必须带 `.item {` 块头整块锚；且此步在 3c 之后，那时 `.grow2, .field` 块已改成 12px，组合不再撞车）。

- [ ] **Step 4：徽章、状态点光环、规则动作、meta**

4a. 把
```css
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
```
替换为
```css
.badge {
  flex: none;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--accent);
  background: var(--accent-weak);
  border-radius: var(--radius-pill);
  white-space: nowrap;
}
```
4b. 把 `.badge-muted` 块（`  color: var(--text-2);\n  background: var(--surface-3);\n}` 三行组合，含块头一起作锚）里的 background 改为 `var(--chip)`（注释「不许用 opacity」原样留）。⚠ 单独一行 `  background: var(--surface-3);` 在 D2 之前的 `.ghost:hover` 里也有同名行——锚点必须带 `.badge-muted` 块头。
4c. 状态点三块（光环走 `color-mix`，规格 §4；三态色不动）：
```css
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
替换为
```css
.dot {
  display: inline-block;
  flex: none;
  width: 8px;
  height: 8px;
  margin-left: 2px;
  border-radius: 50%;
  background: var(--text-3);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--text-3) 18%, transparent);
}

.dot[data-state="ok"] {
  background: var(--ok);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent);
}

.dot[data-state="bad"] {
  background: var(--danger);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 22%, transparent);
}
```
4d. 把 `.rule-action` 块（带边框徽章版）替换为样机的静态文字版（`data-rule-action` 契约属性在 DOM 上，与本规则无关）：
```css
.rule-action {
  flex: none;
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
}
```
4e. `.meta` 块里补一行 `  font-variant-numeric: tabular-nums;`（等宽数字也照顾「N 个模型」这类条数）。⚠ 锚点不要单用 `  color: var(--text-3);`（多处同名）——用 `.meta` 独有的三行组合定位并在其后插行：
```css
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11.5px;
  color: var(--text-3);
```
（`.model-name` 也有 ui-monospace 行，但它的字号是 12.5px——三行组合唯一。）

- [ ] **Step 5：统计数字卡（真实 DOM 是一张容器三栏，不造样机的 `.stats`）**

把
```css
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
替换为
```css
.stat {
  display: flex;
  flex-wrap: wrap;
  gap: 26px;
  margin-bottom: 14px;
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
}

.stat div {
  flex: 1 1 auto;
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.stat b {
  display: block;
  font-size: 24px;
  font-weight: 650;
  letter-spacing: -0.03em;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 6：搜索框（样机形态：灰底、无边、悬停显边、聚焦提亮）**

把
```css
.search input {
  width: 100%;
  padding: 10px 12px 10px 36px;
  font-size: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-card);
}
```
替换为
```css
.search input {
  width: 100%;
  padding: 9px 13px 9px 34px;
  font-size: 14px;
  background-color: var(--surface-3);
  border: 1px solid transparent;
  border-radius: 10px;
}

.search input:hover {
  background-color: var(--surface-3);
  border-color: var(--border);
}

.search input:focus {
  background-color: var(--surface);
  border-color: var(--accent);
}
```
（`.search input:focus` 的 `box-shadow` 光晕由 D2 的通用 `input:focus` 规则继续给；悬停那两条**覆写背景**是因为页面底与卡底不同语境——搜索框悬停不「提白」，只显边框，避免与聚焦态撞色。）

- [ ] **Step 7：左导航（悬停 --hover、高亮 accent-weak 药丸；删 3px 高亮条）**

7a. `.nav-link` 块：`  font-size: 13.5px;` → `  font-size: 13px;`，块尾补一行
`  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);`。
⚠ `font-size: 13.5px` 在 `.add` 与 `.lab` 里各有一处同名行——edit 锚点带上 `.nav-link` 块内的相邻行：它上一行是 `  padding: 8px 12px;`，下一行是 `  color: var(--text-2);`（两行合起来全文件唯一）。
7b. 整块替换 `.nav-link:hover`（⚠ 单行 `  background: var(--surface);` 在活动项规则块里还有一处，必须带块头——块内「color: var(--text) + background: var(--surface)」两行组合配块头才唯一）：
```css
.nav-link:hover {
  color: var(--text);
  background: var(--surface);
}
```
→
```css
.nav-link:hover {
  color: var(--text);
  background: var(--hover);
}
```
7c. 把 8 选择器的活动项规则里
```css
  font-weight: 600;
  color: var(--text);
  background: var(--surface);
}
```
替换为（样机 .nav-link:target = accent-weak 药丸 + accent 文字）
```css
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-weak);
}
```
7d. 删掉紧随其后的整个「左侧 3px 高亮条」规则（`body:has(#sec-engine:target) [data-nav="engine"]::before,` 起、到该规则块 `background: var(--accent);\n}` 止的**一整段**）——accent-weak 药丸已承担高亮，双标记在 A 档导航上过重（`search.test.ts` 对 `#sec-` 只查存在性，CSS 侧删引用安全）。

- [ ] **Step 8：编辑器换行修复 + 编辑面板内卡（样机 profile-editor 语言）**

8a. 把
```css
.profile-row {
  overflow: hidden;
}
```
替换为
```css
.profile-row {
  overflow: hidden;
}

/* 展开行 = .profile-row.item（display:flex）：不 wrap 的话 `.profile-editor` 会作为第三列
   和名字/按钮挤在同一行、被 overflow 剪裁——样机里「编辑器横贯卡下缘」的形态需要这一行。
   纯 CSS 修复，DOM（engine.ts 的 append 顺序）一字不动。row-gap 归零让发丝线紧贴操作行。 */
.profile-row.item {
  flex-wrap: wrap;
  row-gap: 0;
}
```

8b. 把
```css
.profile-editor {
  padding: 12px;
  background: var(--surface-2);
  border-top: 1px solid var(--border);
}
```
替换为
```css
.profile-editor {
  flex: 1 0 100%;
  /* 负 margin 抵消 .item 的内边距，让灰底与发丝线出血到卡缘（样机同一形态）。 */
  margin: 0 -16px -12px;
  padding: 12px 16px 16px;
  background: var(--surface-3);
  border-top: 1px solid var(--border);
}

.profile-editor .field {
  padding: 12px 0;
}
```

8c. 模型清单加卡（编辑器是灰底，清单在白卡上——样机 .models-list/.fetched-list）：
把
```css
.models-list {
  max-height: 220px;
  overflow-y: auto;
}
```
替换为
```css
.models-list {
  max-height: 220px;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
```
把
```css
.model-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
}
```
替换为
```css
.model-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  padding: 9px 12px;
}

.model-row + .model-row {
  border-top: 1px solid var(--border);
}
```
把 `.fetched-row` 块替换为（并在其后新增行间发丝与容器——`.models-fetched` 今天没有自己的规则）：
```css
/* 拉取结果容器：engine.ts 造的 .models-fetched（默认 hidden，[hidden] 兜底管显隐）。 */
.models-fetched {
  margin-top: 8px;
  padding: 4px 12px 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.fetched-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  font-size: 12.5px;
  color: var(--text-2);
}

.fetched-row + .fetched-row {
  border-top: 1px solid var(--border);
}
```

- [ ] **Step 9：隐私清单改「一张卡 + 行间发丝」（§4：不发一堆独立小盒子）**

把
```css
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
```
替换为
```css
.privacy {
  margin: 0;
  /* 现状缺 padding:0（浏览器默认 40px 左缩进挂着）——重排成卡时一并补上。 */
  padding: 0;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--text-2);
  list-style: none;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.privacy li {
  padding: 13px 16px;
}

.privacy li + li {
  border-top: 1px solid var(--border);
}

.privacy code {
  padding: 1px 5px;
  font-size: 12px;
  color: var(--text);
  background: var(--chip);
  border-radius: 5px;
}
```

- [ ] **Step 10：品牌行与收尾（样机 brand）**

整块替换 `.brand`（⚠ `  letter-spacing: -0.01em;` 在 Step 2a 后与 body 块同名，单行锚不再唯一；`  font-size: 16px;` 单行本身全文件唯一，用它带块头即可）：
```css
.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 0 18px;
  padding: 0 10px;
  font-size: 16px;
  letter-spacing: -0.01em;
}
```
→
```css
.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 0 18px;
  padding: 0 10px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
```
`.actions` 块（`display: flex;\n  gap: 10px;\n  margin-top: 14px;` 组合唯一）里 `  gap: 10px;` → `  gap: 8px;`（8pt 节奏）。

- [ ] **Step 11：跑测试**

Run: `npx vitest run tests/options/options-css.test.ts` → Expected: `Tests 12 passed (12)`。
Run: `npx vitest run` → Expected: `Test Files 55 passed (55)` / `Tests 1056 passed (1056)`。

- [ ] **Step 12：D3 变异核验（当场 revert）**

| # | 变异 | 期望 |
| --- | --- | --- |
| M1 | 删 `.stat b` 的 `font-variant-numeric: tabular-nums;` 行 | D3 用例红：`expected undefined to be 'tabular-nums'` |
| M2 | 把 `.dot[data-state="ok"]` 的 box-shadow 那行删掉 | 同用例红（第一条断言先炸：`expected undefined to be '0 0 0 3px color-mix(…'`） |
| M3 | 把 `[hidden] { display: none !important; }` 整块删掉 | 既有守卫红 + `search.test.ts` 相关用例**不**红（它断的是 CSS 文本，靠的是 :107-110 那条断言）——证明守卫 7 是这条契约的唯一牙。跑完 revert |

- [ ] **Step 13：Commit**

```powershell
git add -- src/options/options.css tests/options/options-css.test.ts
git commit -m "style(options): 单元 D3——18px 卡片+发丝线、状态点 color-mix 光环、徽章/统计数字/搜索框/排印节奏；profile-editor 换行修复与隐私清单并入一卡" -- src/options/options.css tests/options/options-css.test.ts
```

---

## Task D4：收口（全量读数、zip 重记录、变异汇总、README、肉眼验收）

**Files:**
- 读：全部；跑：五条命令；改：`README.md` 一句 + 本计划「落地读数表」。

- [ ] **Step 1：全量自动化五条（期望值都来自本计划「已核实的前提」与 D1-D3 的投影；任何一条偏离，回查而不是改期望）**

```powershell
npx vitest run          # 期望 Test Files 55 passed (55) / Tests 1056 passed (1056)
npm run typecheck       # 期望 exit 0，零输出
npm run build           # 期望 exit 0，且 verify:dist 尾行「✓ 产物校验全部通过（14 项）」
npm run zip             # 期望「✓ …：16 个文件，N 字节——已解回临时目录逐字节比对通过」（N 是新值，不是 64747！）
npm run zip; (Get-FileHash -Algorithm SHA256 .\jinyi-0.1.0.zip).Hash   # 与上一条之间包已重写；再跑一次下面这对
npm run zip; (Get-FileHash -Algorithm SHA256 .\jinyi-0.1.0.zip).Hash   # 期望两次 Get-FileHash 输出逐字相同（可复现）
```

⚠ 改 CSS 后 zip 的**字节数与 SHA256 必然变化**——把新值如实填进「落地读数表」，不许试图「调回」64747，也不许保留旧值。
读 zip 用 `Get-Item` / `Get-FileHash`（二进制，不经编码）；**读中文文本文件一律用 `read` 工具**（Get-Content 的 GBK 坑见「已核实的前提」第 0 条）。

- [ ] **Step 2：非目标复查（grep 工具，零命中即过）**

- `src/options/options.css` 里搜 `backdrop-filter`、`@import`、`url(` → 三处都期望 0 命中；
- `src/popup/popup.css` 里搜 `backdrop-filter`、`@import` → 期望 0；搜 `url(` → **只允许**既存的 `--chevron` data-URI 一处（`%23000` 转义，无裸 `#`，D 轮不新增第二条）；
- options.css 搜 `opacity` → 期望 0（守卫同款口径；popup 的两处 `opacity: 0` 是既存的无障碍隐藏通道，**保持原样**）；
- 两文件搜 `#[0-9a-fA-F]{3,8}\b` 于 `:root` 块之外 → options 期望 0，popup 也应为 0（D2 已把 `#fff` 清掉）。

- [ ] **Step 3：变异验证汇总（规格 §8.3——「守卫仍在把关」要一次点齐；每条当场 revert 并复跑全绿）**

| # | Task | 变异 | 期望红（要点） | 结果（执行者填：红/绿/已 revert） |
| --- | --- | --- | --- | --- |
| M1 | D1 | 只改 options 不改 popup | 「逐字一致」红在首个漂移令牌 | |
| M2 | D1 | options 暗色块删 `--ok-text` | 覆盖断言红并**点名** `['--ok-text']` | |
| M2b | D1 | options 暗色块删 `--link`（此时正文已引用它，D2 起） | 覆盖断言红并**点名** `['--link']` | |
| M3 | D1 | 钉死值改 `toBeDefined()` + 暗色回漂 | **全绿** ⇒ 证明那是放宽，规格 §7.2 禁止 | |
| M4 | D1 | 状态行文字色改回 `var(--ok)` | 对比度纪律红（正则 + 值断言双保险） | |
| M5 | D2 | 删 `.switch` 的 `appearance: none` | 开关用例红 | |
| M6 | D2 | `.ghost` 用回 `var(--accent)` | 按钮用例红；附两蓝分职说明 | |
| M7 | D2 | 任意处加 `opacity:` | 既有守卫 5 直接红 | |
| M8 | D3 | 删 `.stat b` 的 tabular 行 | D3 用例红 | |
| M9 | D3 | 删 `[hidden]` 块 | 守卫 7 红（行为测试不红——它才是牙） | |
| M10 | 焦点环 | 把 `*:focus-visible` 的 `outline: 2px solid var(--accent);` 行删掉 | 守卫 6 红：`expected undefined toContain 'var(--accent)'` | |

- [ ] **Step 4：README 一句话（D4 唯一允许的文档改动）**

`edit` `README.md`，把
```markdown
### 设置页

- **即时保存的语义**
```
改为
```markdown
### 设置页

- **视觉基线是 Apple 风格表皮（单元 D）**：配色/圆角/控件语言取自 `docs/mockups/options-apple.html`，
  字体用系统栈、**不打包**（Windows 实际落到 Segoe UI/微软雅黑）；不做毛玻璃、不改 DOM 结构。
  观感与明暗两版同样**未经真实渲染验证**（本机没有浏览器），由用户肉眼验收。
- **即时保存的语义**
```

- [ ] **Step 5：肉眼验收（规格 §8.4/§9——本轮唯一能到「好看」这一层的读数；交回用户，不许代答"已验证观感"）**

1. `chrome://extensions` → 「加载已解压的扩展程序」→ 选 `dist/` → 打开设置页与弹窗；系统切明/暗各看一遍。
2. **头号验收项（§7.8）**：状态行绿字/红字是否读得清（保存一次设置出绿字、删一个不存在的东西/断网测连接出红字）。
3. 清单：档案行「编辑/取消/测试连接/+ 添加」是不是蓝链接药丸、「删除」是不是红字药丸、保存是药丸主按钮；开关是不是 iOS 绿轨白钮；输入框灰底、悬停显边、聚焦蓝边；下拉 chevron 在位；折叠区 `▾` 是 CSS 画的旋转边、展开动画在 reduced-motion 下关闭；统计数字刷新不跳位；搜索框行为（输入/清空/`hidden` 兜底）与改前一致；窄窗口（拖窄到 <900px）导航退顶部一行、`.wrap` 不成 grid；**展开档案行时编辑器横贯整行**（D3 修复项：改前它会被挤成第三列）。

- [ ] **Step 6：回填本计划「落地读数表」+ 全绿复跑 + Commit**

```powershell
npx vitest run   # 最后一次，期望 1056
git add -- README.md docs/superpowers/plans/2026-09-20-apple-visual-style.md
git commit -m "docs: 单元 D4 收口——README 视觉基线一句 + 落地读数回填（zip 新值、变异汇总、肉眼验收交用户）" -- README.md docs/superpowers/plans/2026-09-20-apple-visual-style.md
git status --porcelain -uall   # 期望空（zip 与 dist 被 .gitignore 的 *.zip / dist/ 盖住）
```

---

## 验收对照表（规格 §8 的 5 条 → 哪个 Step）

| 规格 §8 | 落点 |
| --- | --- |
| 1. 全绿（基线 55/1052 → 计划投影 55/1056）；行为断言一条未改 | D1 Step 8 / D2 Step 9 / D3 Step 11 / D4 Step 6 + `git show` 复查 diff 只含 5 个文件（「文件结构」表） |
| 2. typecheck 0 / build 0 且 verify:dist 14 项 / zip 可复现（连跑两次一致） | D4 Step 1（重记录新字节与新 SHA） |
| 3. options-css 全绿，且「逐字一致」「暗色覆盖」**仍在真实把关** | D1 Step 9 的 M2 + D4 Step 3 汇总表（M1-M2 必做） |
| 4. 明暗两套用户肉眼验收，不声称"已验证观感" | D4 Step 5（头号项 = §7.8 绿字/红字） |
| 5. 零 `backdrop-filter`、零外链资源 | D4 Step 2 grep + build 内 verify:dist 的资源检查 |

## 非目标（重申，越线即回退）

不做毛玻璃 / 分段控件 / 打包字体（Inter 子集是另一次「单文件、可逆」的小改动，本轮不开）；不改 `options.html`/`popup.html` 结构；不改任何 `src/**/*.ts` 行为；不重排弹窗信息层级（只同步令牌与同类控件外观，弹窗 body 的 `width: 320px`、行高 1.5 保持）；不动布局骨架（`236px minmax(0,1fr)` / `max-width 1180` / `margin auto`）；不引入图标字体；不新增 `opacity`；不新建类（`.link` 类在 options 不存在就**不造**）；`tests/helpers/css.ts` 与全部行为测试一字不动。

## 落地读数表（执行者填。每格都写了"填什么命令的输出"，不许空话）

| 读数 | 来源命令 | 记录值 |
| --- | --- | --- |
| 全量 vitest（终态） | `npx vitest run` 的 `Test Files` 与 `Tests` 两行原文 | |
| typecheck | `npm run typecheck` 的 exit code | |
| build + verify | `npm run build` 尾行 `✓ 产物校验全部通过（N 项）` 的 N | |
| zip 文件数与字节（新值） | `npm run zip` 输出的「… 个文件，… 字节」原文 | |
| zip SHA256 第 1 次 | `npm run zip; (Get-FileHash -Algorithm SHA256 .\jinyi-0.1.0.zip).Hash` | |
| zip SHA256 第 2 次（同上重跑） | 同左，重跑 | （两次必须逐字相同；不同则排查 zip-dist 固定时间戳前提） |
| D4 Step 3 变异汇总 | 每行「结果」列 | |
| 肉眼验收（明 / 暗 / 状态行绿红字 / 开关与下拉与搜索 / 窄窗口 / 展开编辑器） | Chrome 加载 `dist/`，D4 Step 5 清单 | （每条填「可读/不对味+哪一处」；不对味回 Task，不改行为测试） |

## 自审记录（起草者完稿后按 writing-plans 三查）

**1. 规格逐节覆盖**：§1 四决定 → 头部 Architecture + D2 Step 8f/D3 Step 2a 不打包字体、D4 Step 2 零毛玻璃外链、非目标重申分段控件。§2 范围内三文件 → D1-D3 的 Files；弹窗「同步令牌与同类控件外观、不重排」→ D2 Step 8。§3.1/3.2 令牌表 → D1 Step 3/4/7（逐行对照过：含 `--surface-3` 取 #ececee、`--radius-pill` 保留 999、`--ease`/`--dur`/`--knob` 例外方向）。§4 组件 → 按钮/开关/输入下拉/chevron = D2；卡片分组/状态点/徽章/统计/搜索 = D3；`summary{cursor:pointer}` 保留 = D2 Step 6a。§5 排印 → D3 Step 2/5（含 tabular 三处）；8pt 节奏 → Step 3a/3c/10。§6 动效 → D2 Step 2/5/7（transform-only + reduced-motion 新增）。§7.1-7.8 → 守卫七处表 + M1-M4 + Step 5/7c 的四处文字色。§8 → 验收对照表。§9 → D4 Step 5 + 落地表末行（不声称已验证观感）。§10 D1-D4 → 四个 Task 一一对应。
**2. 占位符扫描**：全文无「适当/酌情/类似 D1/TODO/留空」；所有「执行者填」都出现在落地读数表且每格标明来源命令原文；zip 的 N/新值处都同时给了取值命令。初稿曾写「同 D1 变异表」一处，已展开成独立行。
**3. 命名一致性**：`--link`/`--ok-text`/`--danger-text`/`--track-off`/`--knob`/`--chip`/`--hover`/`--radius-card`/`--ease`/`--dur` 十个名字在 D1 定义（:root 与暗色块逐字），D2/D3 使用的拼写逐一比对过（含 `NOT_A_COLOR` 增补四项、断言里的 `'var(--ok-text)'` 等）；无 `--page`/`--separator` 等样机命名泄漏进真实 CSS。
**4. 起草期发现并回写进本计划的仓库事实**（超出控制器简报的部分）：options.css 无 transition/无 reduced-motion（§6 的"保留"实为新增）、options 的 select 没有"现有 linear-gradient"（画法从样机引入）、`input[type="password"]` 不在样式列表内、展开行的编辑器是 flex 第三列（D3 Step 8 修）、`.privacy` 缺 `padding: 0`、`popup.css` 正文 `color:#fff` 既存（顺手令牌化）、样机 A 档覆盖与规格 §4 的圆角冲突按规格落地并记账。
