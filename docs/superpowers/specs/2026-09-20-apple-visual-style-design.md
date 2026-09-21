# Apple 视觉风格（单元 D）设计规格

日期：2026-09-20 · 状态：已与用户确认方向 · 关联：`2026-09-18-options-page-redesign-design.md`（单元 B 的版式基线）、样机 `docs/mockups/options-apple.html`

## 1. 需求与已拍定的决定

用户原话：**「最后把视觉风格调好看点」→「改成 apple 品牌风格」→「A 选 A」→「不打包」**。

| 决定点 | 结论 | 理由 |
| --- | --- | --- |
| 改动范围 | **A 档 = 表皮级**：只改 CSS（含必要的 class 与令牌），**不改 DOM 结构、不改任何行为** | 用户看过样机 A/B 两档后选 A |
| 字体 | **系统字体栈，不打包 Inter** | 界面主体是中文，Inter 不含中文字形 → 打包只改善英文与数字，代价是 zip 从 65 KB 涨到 170–260 KB（3–4 倍），收益是局部的 |
| 毛玻璃侧栏 | **不做** | A 档的左导航本来就没有底板；同时消掉 `backdrop-filter` 的绘制代价 |
| 分段控件（显示模式） | **不做**（保留 `<select>`，做成 Apple 风圆角下拉） | 换成分段控件要把 `<select>` 改成一组 radio，属 DOM 改动，超出 A 档 |

**一句话概括目标**：把 Apple 观感建立在**能整体迁移**的东西上——配色、间距节奏、圆角、发丝分隔线、药丸控件、字号与字重——而不是建立在字体上。

## 2. 范围与非目标

**范围内**：`src/options/options.css`、`src/popup/popup.css`（**必须在范围内**：`options-css.test.ts` 里那条**共用令牌逐字一致**的守卫用例——它遍历 `popup.css` 的 `:root` 每条声明、要求 `options.css` 同名同值——只改一边守卫当场红）、`tests/options/options-css.test.ts`（按新值**同步事实**，见 §7）。

**非目标（明确不做）**：不改 `options.html` / `popup.html` 的结构；不改 `src/options/sections/*.ts` 的任何行为；不重排弹窗布局（只同步令牌与同类控件外观）；不引入图标字体或第三方图标；不加 `backdrop-filter`；不打包字体；不动布局骨架（保持现有居中 `grid: 236px minmax(0,1fr) / max-width 1180 / margin auto`）。

## 3. 设计令牌

**命名纪律**：复用现有令牌名，**不新造同义词**。样机里的 `--separator` / `--page` 只是样机用词，落到真实代码分别对应**既有的** `--border` 与 `--surface-2`（页面底就是 `--surface-2`）。新增令牌只允许是"现有令牌表达不了的东西"。

### 3.1 亮色（`:root`）

| 令牌 | 现值 | 新值 | 说明 |
| --- | --- | --- | --- |
| `--surface` | `#ffffff` | `#ffffff` | 卡片 |
| `--surface-2` | `#f6f7f9` | **`#f5f5f7`** | 页面底（Apple 的设置页灰） |
| `--surface-3` | `#eceef2` | **`#ececee`** | 输入框/次级底：比页面底 `#f5f5f7` **略深一档**，这样它在白卡上仍读得出是"可输入区"（`--surface-3` 在 `options.css` 用 2 处、`popup.css` 用 4 处，改值会一起影响它们） |
| `--border` | `rgba(0,0,0,.1)` | **`rgba(0,0,0,.08)`** | 发丝线 |
| `--border-strong` | `rgba(0,0,0,.18)` | **`rgba(0,0,0,.14)`** | |
| `--text` | `#1a1d21` | **`#1d1d1f`** | Apple 主文 |
| `--text-2` | `#5b6470` | **`#6e6e73`** | 次文 |
| `--text-3` | `#8b93a0` | **`#86868b`** | 三级/占位 |
| `--accent` | `#2563eb` | **`#0071e3`** | Apple 按钮蓝 |
| `--accent-hover` | `#1d4ed8` | **`#0077ed`** | Apple 悬停是**变亮**不是变深 |
| `--accent-weak` | `rgba(37,99,235,.1)` | **`rgba(0,113,227,.12)`** | 选中底/焦点环底 |
| `--ok` | `#16794a` | **`#34c759`** | 开关与状态点（iOS 绿） |
| `--danger` | `#c0342b` | **`#ff3b30`** | 状态点/危险控件（iOS 红） |
| `--on-accent` | `#ffffff` | `#ffffff` | 不变 |
| `--shadow-card` | 双层 6% | **`0 1px 2px rgba(0,0,0,.04), 0 6px 20px rgba(0,0,0,.05)`** | Apple 的阴影很克制 |
| `--radius-sm` | `6px` | **`8px`** | |
| `--radius-md` | `10px` | **`12px`** | 控件/输入框 |
| `--radius-pill` | `999px` | `999px` | 已是全圆，不动（样机写 980px 只是 Apple 站内值，视觉无差别） |

**新增令牌**（每个都必须在暗色块里有值，或按 §7 进例外清单）：

| 新增 | 亮 | 暗 | 用途 |
| --- | --- | --- | --- |
| `--link` | `#0066cc` | `#419cff` | 文字按钮（Apple 的次级动作是蓝链接，不是灰边框按钮） |
| `--ok-text` | `#248a3d` | `#30d158` | 绿色**文字**（`--ok` 的 `#34c759` 做文字在浅底上对比不足） |
| `--danger-text` | `#d70015` | `#ff453a` | 红色文字（「删除」与错误状态行） |
| `--track-off` | `rgba(120,120,128,.32)` | `rgba(120,120,128,.42)` | iOS 开关的关态轨道 |
| `--knob` | `#ffffff` | `#ffffff` | 开关旋钮（亮暗同值 → 见 §7 的例外处理） |
| `--chip` | `rgba(120,120,128,.16)` | `rgba(120,120,128,.32)` | 徽章底、行内代码底 |
| `--hover` | `rgba(0,0,0,.035)` | `rgba(255,255,255,.05)` | 行/链接悬停底 |
| `--radius-card` | `18px` | `18px`（非颜色，不必在暗色重复） | 卡片圆角 |
| `--ease` / `--dur` | `cubic-bezier(.32,.72,0,1)` / `200ms` | 同 | Apple 缓动；非颜色 |

### 3.2 暗色（`@media (prefers-color-scheme: dark)`）

`--surface` **`#1c1c1e`**、`--surface-2` **`#000000`**、`--surface-3` **`#2c2c2e`**、`--border` `rgba(255,255,255,.12)`、`--border-strong` `rgba(255,255,255,.2)`、`--text` **`#f5f5f7`**、`--text-2` **`#a1a1a6`**、`--text-3` **`#8e8e93`**、`--accent` **`#0a84ff`**、`--accent-hover` **`#409cff`**、`--accent-weak` `rgba(10,132,255,.22)`、`--ok` **`#30d158`**、`--danger` **`#ff453a`**、`--shadow-card` 保持深色系双层。

> 这些是 Apple 公开设计体系里系统色/系统 UI 的近似值，不是逐字摘自某份规范文件；**观感最终由用户肉眼验收**（本机没有浏览器，见 §9）。

## 4. 组件规格

- **按钮**：主按钮 = 药丸（`--radius-pill`）+ `--accent` 底 + `--on-accent` 字，`padding: 7px 17px`，悬停 `--accent-hover`，`:active` 轻微 `scale(.975)`。次级动作（`编辑`/`取消`/`测试连接`/`+ 添加`）= **蓝链接**（`--link`，透明底，悬停 `--accent-weak` 药丸底）。危险动作（`删除`）= `--danger-text` 链接，悬停 `color-mix(in srgb, var(--danger) 12%, transparent)`。
- **iOS 开关**：`<input type="checkbox">` + `appearance: none`，轨道 44×26（`--track-off`），选中 `--ok`，旋钮 20px `--knob` + 阴影，`translateX(18px)`，过渡用 `--dur var(--ease)`。**不新增 DOM**（现有 checkbox 直接套样式）。
- **输入框 / 下拉 / 文本域**：底 `--surface-3`、边框透明、圆角 `--radius-md`；悬停显出 `--border` 边框并把底提到 `--surface`；聚焦边框 `--accent` + 底 `--surface`。下拉的 chevron 用 `linear-gradient` 自绘（**这是新引入的画法**——`options.css` 现状是**原生箭头**，全文没有一处 `linear-gradient`；`popup.css` 用的是另一套 `mask` + data-URI，不动它）。**不许**引入图标字体或外链资源，颜色走 `--text-3`。
- **卡片与分组**：`.group` / `.item` / `.profile-row` / `.stat` 用 `--radius-card` + `--border` 发丝 + `--shadow-card`；行与行之间用**发丝分隔线**（`border-top: 1px solid var(--border)`）而不是各自一个盒子；行最小高 44–46px，左右内边距 16px。
- **状态点 `.dot`**：8px 圆 + `box-shadow: 0 0 0 3px color-mix(in srgb, var(--X) 22%, transparent)` 的光环；三态分别 `--ok` / `--text-3` / `--danger`。
- **徽章**：药丸 + `--chip` 底 + `--text-2` 字（`.badge-muted`）；「使用中」「当前」用 `--accent-weak` 底 + `--accent` 字。
- **统计数字 `.stat b`**：24px / `font-weight: 650` / `letter-spacing: -0.03em` / `font-variant-numeric: tabular-nums`（数字必须等宽，否则刷新时数字会跳位）。
- **搜索框**：底 `--surface-3`、圆角 10px、无边框；悬停显边框、聚焦提亮为 `--surface` + `--accent` 边框。
- **`details` / `summary`**：`summary { cursor: pointer }` 必须保留（守卫钉着）；chevron 用 CSS 画的 6px 旋转边（`::before` + `rotate`），展开时 `rotate(45deg)`，过渡 `--dur var(--ease)`。

## 5. 排印与间距节奏

- `body`: `font: 400 14px/1.47 <系统栈>`，栈顺序 `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`（**Windows 上实际落到 Segoe UI / 微软雅黑**，这是 §1 已知并接受的代价）。
- 标题 `letter-spacing: -0.02em ~ -0.03em`（大字号收紧是 Apple 排印的标志之一）；正文 `line-height` 从 1.6 收到 **1.47**，行内说明 1.6–1.7。
- 数字一律 `tabular-nums`（缓存统计、档案计数、状态行里的条数）。
- 间距走 8pt 节奏：区块间距 30px、卡片内边距 16px、行高 44–46px、控件间 8/12px。

## 6. 动效与可达性

- 过渡一律 `var(--dur) var(--ease)`，只动 `background` / `color` / `border-color` / `transform`；**不动 `width`/`height`/`box-shadow` 大跨度**（绘制代价）。
- **`@media (prefers-reduced-motion: reduce)` 对设置页是「新增」而不是「保留」**：`options.css` 现状**没有任何 `transition`、也没有这个块**（grep 核实），所以引入过渡的同时必须新建整表关断（`*, *::before, *::after`——样机里只写了裸 `*`，而裸 `*` **不命中伪元素**，本页 chevron 与开关旋钮的过渡恰好都挂在伪元素上）。`popup.css` 现状有一个 scoped 版（只关 `.toggle-track`）；D2 给它的 `.primary` 加过渡之后，**必须**一并升级为整表关断。
- **焦点环保留且必须保持守卫要求的写法**：`*:focus-visible { outline: … var(--accent); outline-offset: … }`——样机里用 `box-shadow` 发光的那种写法**不能照搬**，会让 `options-css.test.ts` 里那条**焦点环守卫用例**红（它要求该规则的 `outline` 含 `var(--accent)` 且写有 `outline-offset`）。可以在它旁边补 `box-shadow` 做 Apple 式光晕，但 `outline` 那两行必须原样在。
- 对比度：`--ok` 的 `#34c759` 只用于**非文字**元素（开关、状态点）；绿色文字一律 `--ok-text`。同理红色文字用 `--danger-text`。这是"好看"与"看得清"之间必须站住的一侧。

## 7. 守卫与测试的影响面（实现时最容易踩红的一组）

> **引用纪律（本单元新立）**：本节与全文引用代码位置**一律用选择器、符号名或断言措辞，不钉行号**——行号会漂（同一条 `opacity: 0` 在本单元里已经漂过两次：起草快照 → D2 → D3）。定位一律以仓库为准。**旧文档不追溯**：单元 B/C 的规格与计划里成批的「文件:行号」写法保留原样（它们此刻仍然有效），这条规矩**从本单元起**生效；写进仓库的注释与断言里引用代码位置，**永远**不许用行号。

1. **共用令牌逐字一致**（守卫用例：遍历 `popup.css` 的 `:root` 每条声明、要求 `options.css` 同名同值；popup 令牌数下限 `>= 17`）→ `popup.css` 的 `:root` 与暗色块必须同步改，且**弹窗独有的组件**（按钮、开关、下拉）要跟着换外观，否则同一个令牌在两边表现不一致。
2. **暗色三个具体值被钉死**（`--surface` / `--text` / `--danger` 各一条精确相等断言）→ 这三条断言要**按新值同步**。这是"同步事实"，**不是放宽**：仍然必须是精确相等，**不许**改成 `toBeDefined()` 之类。
3. **暗色覆盖检查 + `NOT_A_COLOR` 例外清单**（现有 5 项：`--radius-sm`、`--radius-md`、`--radius-pill`、`--shadow-card`、`--on-accent`；检查集合是「**在 options.css 正文被 `var()` 引用** 且亮色有定义」的令牌）→ 新增的颜色令牌（`--link`、`--ok-text`、`--danger-text`、`--track-off`、`--chip`、`--hover`）必须在暗色块里各有值；`--knob`（亮暗同 `#fff`）与 `--radius-card`、`--ease`、`--dur` 属"非颜色/亮暗同值"，要进 `NOT_A_COLOR`。该注释已解释过为什么选"列例外"而不是"列白名单"（白名单写不全→假绿，例外写不全→假红，只有假红是安全方向）——**沿用同一方向**。
4. **正文不许有颜色字面量**（守卫用例：`bodyWithoutTokens()` 去掉两个 `:root` 块后，两个正则扫 `#hex` 与 `rgb(`/`rgba(`/`hsl(`）→ 所有新色（含开关旋钮白、轨道灰、悬停底、光晕）一律走令牌；`color-mix(in srgb, var(--x) N%, transparent)` 不含颜色字面量，可用。
   ⚠ **但这两条纪律（连同第 5 条的 `opacity` 禁令）只扫 `options.css`**——那两个正则与 `bodyWithoutTokens()` 传的都是 `optionsCss`，**`popup.css` 不在扫描范围内**。实测：守卫全绿时 `popup.css` 里 `.primary` 的 `color: #fff`（D2 已令牌化为 `var(--on-accent)`）与 `.field-toggle > input[type="checkbox"]` 上的 `opacity: 0` 都安然无恙。所以**弹窗侧的令牌化是我们自愿遵守的纪律，不是机器把关**：执行者不要以为"popup 里写字面量会红"，也不要反过来把 popup 既存的 `opacity: 0`（无障碍隐藏通道）当成违规去删。新增到 popup 的颜色仍应走令牌。
5. **不许 `opacity`**（守卫用例：正则带 `^|[;{\s]` 边界、同样只扫 `options.css`）→ 次级文字继续用 `--text-2/-3`。
6. **窄窗口降级**（守卫用例：`.wrap { display: block }` + `.nav { position: static }` 在 `@media (max-width: 900px)` 内）与 **`[hidden] { display: none !important }`**（守卫用例：该规则的 `display` 精确等于 `none !important`）→ 必须原样保留（后者是搜索功能的地基）。
7. 行为面**零改动**：`options.test.ts`（31 条）、`engine-*`、`search.test.ts`、`cache-section.test.ts` 等一律不许动；若某条因外观改动而红，说明改到了 DOM/契约，**回退那处改动**而不是改断言。
8. ✅ **`--ok` / `--danger` 身兼两职的问题已由 D1 落地解决**（`1167511`）：新值把它们换成了 iOS 亮绿 `#34c759` / 亮红 `#ff3b30`，**当文字用会掉到不可读**（`#34c759` 在白底上约 2.2:1），所以四处**文字**用法已改指 `--ok-text` / `--danger-text`——按选择器认，就是：`.status[data-kind="ok"]` 与 `.status[data-kind="err"]` 的 `color`（options）、`.link-danger` 的 `color`（options）、`.hint.warn` 的 `color`（popup）；而 `.dot[data-state="ok"]` / `.dot[data-state="bad"]` 的 **`background`** 与 `.switch:checked` 的 `background` **保持**用 `--ok` / `--danger`（非文字）。
   **这条守卫抓不到**（CSS 断言只查"颜色是否来自令牌"，不查对比度），所以它仍是 §9 里点名的**肉眼验收项**：改完必须有人看状态行的绿字/红字是否还读得清。

## 8. 验收标准

1. `npx vitest run` 全绿（**起草时基线 55 files / 1052 passed**；各轮落地后的计数链见计划的「落地读数表」：D1 1053 → D2 1057 → D3 1058/1059 → **D4 1060**，一律按提交号读）；`options.test.ts` 等**行为断言一条未改**（`git diff` 里它们应当不出现，出现即需说明理由）。
2. `npm run typecheck` exit 0；`npm run build` exit 0 且 `verify:dist` 14 项；`npm run zip` 成功且**逐字节可复现**（连跑两次 SHA256 一致）。
3. `options-css.test.ts` 全绿，且其中"共用令牌一致"与"暗色覆盖"两条**仍然在真实地把关**（要求做一次变异：删掉暗色块里某个新令牌 → 必须红）。
4. 明暗两套由**用户肉眼验收**；本轮不做任何"已验证观感"的声称。
5. 无新增 `backdrop-filter`、无新增外部资源引用（字体/图标/CDN）——`verify:dist` 的资源检查与"零遥测"承诺共同守着这条。

## 9. 已知限制

- **本机没有浏览器**：所有布局、间距、对比度、圆角观感**都没有被真实渲染验证过**（与单元 B/C 同一天花板）。交付读数只到"测试全绿 + 令牌纪律成立"这一层。
- **SF Pro / 苹方在 Windows 上不存在**，且已决定不打包字体 → 实际渲染落到 Segoe UI / 微软雅黑。若用户看完觉得"不够 Apple"，最可能的原因就是字体，届时可另开一次"打包 Inter 子集"的小改动（单文件、可逆）。
- A 档不做分段控件、不做毛玻璃：样机里那两处只是 B 档的演示。
- 弹窗只同步令牌与同类控件外观，**不重排**它的信息层级。
- **本轮最需要肉眼确认的一处**：状态行的绿字/红字（§7.8）。它没有任何测试能兜住——测试只查"颜色有没有走令牌"，不查"走的是不是文字专用令牌"。

## 10. 交付拆分

- **D1 令牌层**：`options.css` + `popup.css` 的 `:root` 与暗色块换成 §3 的值；同步 `options-css.test.ts` 里被钉死的具体值与 `NOT_A_COLOR`。产出：两套配色生效、守卫全绿。
- **D2 控件层**：按钮（药丸/链接/危险链接）、iOS 开关、输入框与下拉、`details` chevron、焦点环。
- **D3 版式层**：卡片与分组（圆角 + 发丝线 + 克制的阴影）、状态点光环、徽章、统计数字、搜索框、排印与间距节奏。
- **D4 收口**：全量命令 + zip 可复现性 + 变异验证（守卫仍在把关）+ README 若需要补一句"视觉基线换成 Apple 风格、字体用系统栈"。
