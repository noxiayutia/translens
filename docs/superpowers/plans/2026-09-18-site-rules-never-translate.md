# 站点规则「永不翻译」实现计划（单元 A）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `siteRules` 里 `action: 'never'` 的规则真正拦住整页翻译，并在弹窗给出可读状态与一键解除。

**Architecture:** 匹配逻辑是 `src/core` 的纯函数（无 DOM、无 chrome）；拦截点只有**一处**——内容脚本的 `translatePage()`，因为三个整页翻译入口（右键菜单、`Alt+T`、弹窗按钮）全部汇聚到它。弹窗只负责显示状态与解除，不参与拦截判定。

**Tech Stack:** TypeScript + Vitest（jsdom）+ Vite（MV3）；测试命令 `npm test`，收口 `npm run typecheck` / `npm run build` / `npm run zip`。

**规格：** `docs/superpowers/specs/2026-09-18-options-page-redesign-design.md` §5、§11

---

## 已核实的前提（不要重新发明）

1. **`siteRules` 已经在内容脚本手里。** `src/content/index.ts:381` 用的是 `loadUiSettings()`，而 `UiSettings = Omit<Settings, 'profiles'> & { profiles: UiEngineProfile[] }`——它是**类型级投影**（只剥 `apiKey`），`siteRules` 在里面。**不需要新增任何管道。**
2. **三个入口汇聚到一处。** `service-worker.ts:70`（`TOGGLE_PAGE`）、`:76`（`TRANSLATE_PAGE`）、`popup.ts:397`（`chrome.tabs.sendMessage`）全部打到 `content/index.ts:829` 的监听器，而 `TRANSLATE_PAGE` 与 `TOGGLE_PAGE` 的翻译分支都调用同一个 `runTranslate()` → `translatePage()`。
3. **`TOGGLE_PAGE` 在已翻译时走 `restorePage()`**，不经过 `translatePage()`。这是对的：撤掉翻译不需要规则许可，**不要**去拦还原。
4. **划词与悬停不受本规则约束**（规格 §11 已确认）。`TRANSLATE_SELECTION` 分支与 `hover.ts` / `selection.ts` **一律不动**。

## 文件结构

| 文件 | 动作 | 责任 |
| --- | --- | --- |
| `src/core/site-rules.ts` | 新建 | 主机名匹配与规则命中判定（纯函数） |
| `tests/core/site-rules.test.ts` | 新建 | 匹配语义的全部陷阱 |
| `src/content/index.ts` | 修改（`:383` 之后插入） | 唯一的拦截点 |
| `tests/content/index.test.ts` | 修改 | 拦住时零请求、DOM 不变、文案正确 |
| `src/popup/popup.html` | 修改（`:32` 之后插入） | 提示行 DOM |
| `src/popup/popup.ts` | 修改 | 显示提示行 + 解除 |
| `src/manifest.json` | 修改（加 `"activeTab"`） | 弹窗要读 `Tab.url` 才拿得到当前站点（见 Task 5） |
| `tests/manifest.test.ts` | 新建 | **源码约束**：`activeTab` 在、`tabs` 不在（改错也不会有别的测试变红，见 Task 5） |
| `tests/popup/popup.test.ts` | 修改 | 提示行只在命中时出现；解除写盘 |
| `README.md` | 修改 | 已知限制补四条 + 隐私一节补 `activeTab` |

---

## Task 1: 纯函数 `matchSiteRule`

**Files:**
- Create: `src/core/site-rules.ts`
- Test: `tests/core/site-rules.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/core/site-rules.test.ts`：

```ts
// tests/core/site-rules.test.ts
import { describe, expect, it } from 'vitest';
import { isNeverTranslate, matchSiteRule } from '../../src/core/site-rules';

/** 只关心 pattern/action 两个字段，用最小形状构造，避免与设置层耦合。 */
function rule(pattern: string, action: 'translate' | 'never') {
  return { pattern, action };
}

/**
 * 匹配内核 `hostMatchesPattern` 是模块私有的：它的一切行为只能经 `matchSiteRule` 观察。
 * 下面各组保留原计划给它的**全部**输入与判定（逐条对应，布尔断言换成 `not.toBeNull()` /
 * `toBeNull()`，一条不减、不放宽）。
 *
 * 走公开入口的结构性红利：凡是"模式与主机名长得不一样"的用例（通配、子域、尾点……），
 * 内部实参一旦对调，host 与 pattern 会立刻互相解释错误、当场变红——
 * 若直测私有函数，精确匹配那组里两实参恒等，对调变异根本打不到。
 */
describe('matchSiteRule：主机名匹配语义', () => {
  it('精确匹配只认裸域本身，不带上子域', () => {
    expect(matchSiteRule([rule('example.com', 'never')], 'example.com')).not.toBeNull();
    expect(matchSiteRule([rule('example.com', 'never')], 'www.example.com')).toBeNull();
  });

  it('*. 前缀通配同时匹配裸域与任意层子域', () => {
    expect(matchSiteRule([rule('*.example.com', 'never')], 'example.com')).not.toBeNull();
    expect(matchSiteRule([rule('*.example.com', 'never')], 'www.example.com')).not.toBeNull();
    expect(matchSiteRule([rule('*.example.com', 'never')], 'a.b.example.com')).not.toBeNull();
  });

  it('后缀相似不算命中（这是最容易写错的一类）', () => {
    expect(matchSiteRule([rule('*.example.com', 'never')], 'notexample.com')).toBeNull();
    expect(matchSiteRule([rule('*.example.com', 'never')], 'example.com.evil.io')).toBeNull();
    expect(matchSiteRule([rule('example.com', 'never')], 'example.com.evil.io')).toBeNull();
  });

  it('大小写与首尾空白不参与判定（主机名侧大写 + 模式侧空白）', () => {
    expect(matchSiteRule([rule(' *.example.com ', 'never')], 'WWW.Example.COM')).not.toBeNull();
  });

  it('另一半同样要防：模式侧大写 + 主机名侧空白（pickSiteRules 对 pattern 原样入库）', () => {
    expect(matchSiteRule([rule('*.EXAMPLE.COM', 'never')], 'www.example.com')).not.toBeNull();
    expect(matchSiteRule([rule('*.example.com', 'never')], ' www.example.com ')).not.toBeNull();
  });

  it('空主机名 / 空白模式 / 光杆 *. 一律不匹配', () => {
    // 主机名为空是**真实可达**的：about:blank、data: 页的 location.hostname 就是 ''。
    expect(matchSiteRule([rule('example.com', 'never')], '')).toBeNull();
    // 模式侧的输入形态要对着现实写：`pattern.length === 0` 进不来这里（`pickSiteRules`
    // 在 src/shared/settings.ts 里就把空串条目丢掉了），能活下来的脏数据是**空白 pattern**。
    expect(matchSiteRule([rule('   ', 'never')], 'example.com')).toBeNull();
    expect(matchSiteRule([rule('*.', 'never')], 'example.com')).toBeNull();
    // 两者都归一化成空的那一组才是 `host === '' || p === ''` 那句判空的见证：
    // 删掉它，trim 之后的 `'' === ''` 会命中——于是一条空白规则就能盖住 about:blank / data: 页。
    expect(matchSiteRule([rule('   ', 'never')], '')).toBeNull();
  });

  it('光杆 *. 的杀伤面是尾点 FQDN——「example.com.」也不许命中（删守卫的见证用例）', () => {
    // **顺序是这条用例的一部分**：断言失败会中止整个 `it`，把见证那条放在最前面时，
    // 删守卫的变异体只会留下 red=1，下面两个对照读数根本不执行——而"对照仍然绿"恰恰是
    // 复核「杀伤面不是全站」这件事需要的证据。所以对照在前、见证在后。
    // 对照组：去掉守卫后 `*.` 能命中的也只有尾点那一种输入，**不是**旧注释误称的"全站"；
    // 子域在有无守卫时都不命中（host.endsWith('.') 为假），这里钉住现状。
    expect(matchSiteRule([rule('*.', 'never')], 'www.example.com')).toBeNull();
    expect(matchSiteRule([rule('*.', 'never')], 'example.com')).toBeNull();
    // 上一条里 `rule('*.') × 'example.com'` 无论有没有 `suffix === ''` 守卫都返回不命中，
    // 它钉得住"光杆写法不匹配常规主机名"这个语义，但**杀不死删守卫的变异体**。
    // 真正能见证守卫存在的输入只有以点结尾的主机名（`new URL` 会保留尾点，是真实形态）。
    expect(matchSiteRule([rule('*.', 'never')], 'example.com.')).toBeNull();
  });

  it('自上而下首条命中即生效，顺序就是优先级', () => {
    const rules = [rule('example.com', 'never'), rule('example.com', 'translate')];
    expect(matchSiteRule(rules, 'example.com')).toBe(rules[0]);
  });

  it('命中的是第二条就返回第二条：通配 × 非首位 × 主机名≠模式（Task 3 按对象身份解除的前提）', () => {
    const rules = [rule('other.com', 'never'), rule('*.example.com', 'translate')];
    expect(matchSiteRule(rules, 'www.example.com')).toBe(rules[1]);
  });

  it('没有任何规则命中时返回 null', () => {
    expect(matchSiteRule([rule('other.com', 'never')], 'example.com')).toBeNull();
    expect(matchSiteRule([], 'example.com')).toBeNull();
  });
});

describe('isNeverTranslate', () => {
  it('只有命中且动作是 never 才为真', () => {
    expect(isNeverTranslate([rule('example.com', 'never')], 'example.com')).toBe(true);
    expect(isNeverTranslate([rule('example.com', 'translate')], 'example.com')).toBe(false);
    expect(isNeverTranslate([], 'example.com')).toBe(false);
  });

  it('同域多条规则按首条命中定性，不是 any-never', () => {
    // pickSiteRules 不去重、不排序，`[translate, never]` 同 pattern 今天就能出现在脏存储里。
    // 整条换成 `rules.some(...)` 必须在第一条变红——两种语义在这里结果相反。
    expect(
      isNeverTranslate([rule('example.com', 'translate'), rule('example.com', 'never')], 'example.com'),
    ).toBe(false);
    expect(
      isNeverTranslate([rule('*.example.com', 'translate'), rule('www.example.com', 'never')], 'www.example.com'),
    ).toBe(false);
    expect(
      isNeverTranslate([rule('*.example.com', 'never'), rule('other.com', 'translate')], 'www.example.com'),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: 跑到红**

Run: `npx vitest run tests/core/site-rules.test.ts`
Expected: FAIL —— `Cannot find module '../../src/core/site-rules'`

- [ ] **Step 3: 写实现**

创建 `src/core/site-rules.ts`：

```ts
// src/core/site-rules.ts

/**
 * 站点规则的主机名匹配。纯函数：不碰 DOM、不碰扩展宿主 API（`tests/core/layering.test.ts` 守着这条）。
 *
 * 纪律（写给下一个想"就在这儿提一句那个全局"的人）：那条守卫按**源码文本**扫描，
 * **连注释一起扫**，且按大小写敏感的裸标识符匹配。想提被禁的宿主全局，只能用描述性说法
 * （就像这句）——写出字面量会当场把守卫跑红。这是刻意"往严格一侧失败"：被红时改这里的
 * 措辞，不是放宽守卫。本注释必须住在源码里，因为 `scripts/sync-plan-code.mjs` 的同步方向
 * 是仓库 → 计划——只写在计划里的版本，会在下一次同步时被这里的旧文本抹掉。
 *
 * 用 `import type` 而不是普通 import：`shared/settings` 会 import `engines/registry`，
 * 运行时依赖一旦成立就是 `core → shared → engines` 的反向层依赖。`import type` 在编译期
 * 被完全擦除，既复用了同一份 `SiteRule` 定义（不复制类型），又不引入任何运行期边。
 */
import type { SiteRule } from '../shared/settings';

/**
 * 匹配内核，**模块私有**：Task 2 的消费者是 `isNeverTranslate`、Task 3 的是
 * `matchSiteRule`，没有人直接消费本函数——本仓库不给零消费者的公共表面留位置。
 * 测试一律走公开入口。这份红利**有范围，别说过头**：在"模式与主机名长得不一样"的那些
 * 用例里（通配、子域、尾点、大小写与空白……）实参一旦对调，两个值会互相解释错误、当场
 * 变红；而精确匹配那组两个实参本来就恒等、空值那几组又先被"空即不匹配"拦下，对调变异在
 * 它们身上没有读数。所以它是"多数用例顺手多得的一道保护"，不是"测试里 hostname 与 pattern
 * 不可能长得一样"——那种绝对说法不成立。完整表述见测试文件顶部注释。
 *
 * 只支持两种写法，**刻意不做更花哨的通配**——规则越少越可预测：
 *
 * - 精确：`example.com` 只匹配 `example.com`，**不**匹配 `www.example.com`；
 * - 前缀通配：`*.example.com` 匹配裸域本身与任意层子域。
 *   这个语义与 Chrome 的 match pattern 一致，用户从别的翻译扩展迁移过来不会踩意外。
 *
 * 其余写法（`*example.com`、`https://example.com`、`example.com:8080`、`**.example.com`）
 * 既不报错也不会命中，静默地永不生效——这里**没有**形状校验，那是单元 B 设置页（输入侧）的职责。
 *
 * 主机名按 ASCII/punycode 形态比对：`new URL('https://中文.com/').hostname` 是
 * `xn--fiq228c.com`，所以往 pattern 里填中文域名会**静默永不生效**（本任务不做归一化，
 * 面向用户的提示记在单元 B / README）。
 */
function hostMatchesPattern(hostname: string, pattern: string): boolean {
  const host = hostname.trim().toLowerCase();
  // pattern 由 `pickSiteRules` 原样入库（不折大小写），容错只能发生在这里。
  const p = pattern.trim().toLowerCase();
  if (host === '' || p === '') return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    // 光杆 `*.` 不算规则。少这行守卫拦不住"全站"（旧注释说过头了）：它只会命中
    // **以点结尾**的主机名——尾点 FQDN 是真实形态，
    // `new URL('https://example.com./x').hostname === 'example.com.'`。
    if (suffix === '') return false;
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === p;
}

/**
 * 自上而下，首条命中即生效，返回**命中的那一条本身**（Task 3 的"一键解除"按对象身份
 * 删除规则；返回 rules[0] 或布尔都会让它删错）。同 pattern 多条时顺序就是优先级——测试钉住。
 */
export function matchSiteRule(rules: readonly SiteRule[], hostname: string): SiteRule | null {
  for (const rule of rules) {
    if (hostMatchesPattern(hostname, rule.pattern)) return rule;
  }
  return null;
}

/**
 * 本站是否禁止整页翻译。**首条命中定性**，不是 any-never：`pickSiteRules` 不去重、不排序，
 * `[translate, never]` 同 pattern 在脏存储里今天就能出现，两种语义结果相反（测试钉住前者）。
 *
 * `action: 'translate'`（总是翻译）今天**不产生任何可观察行为**——本扩展没有自动翻译，
 * 所以设置页本轮也不提供这个动作（规格 §5）。这里只认 never。
 */
export function isNeverTranslate(rules: readonly SiteRule[], hostname: string): boolean {
  return matchSiteRule(rules, hostname)?.action === 'never';
}
```

- [ ] **Step 4: 跑到绿**

Run: `npx vitest run tests/core/site-rules.test.ts`
Expected: PASS（12 个 `it`：`hostMatchesPattern` 6 + `matchSiteRule` 3 + `isNeverTranslate` 3。
实现途中补了两条计划里没有的用例——尾点 FQDN `example.com.`、以及精确匹配不许退化成后缀匹配的
`example.com.evil.io` 反例——它们分别是「光杆 `*.` 守卫」与「精确匹配」这两个变异体的见证，
见 Step 6 变异表）

- [ ] **Step 5: 分层守卫仍然成立**

Run: `npx vitest run tests/core/layering.test.ts`
Expected: PASS —— 若它报 `core` 里出现 `chrome`/`document` 等，说明 Step 3 的代码被改花了，回到上面重来。

- [ ] **Step 6: 变异验证（证明这些测试真的承重）**

逐个把源码改坏，每次跑 `npx vitest run tests/core/site-rules.test.ts`，**必须有用例变红**；
全部还原后再跑一次全量确认绿。至少要覆盖这五个变异体（质量审查实测过它们的行为）：

| 变异 | 必须被杀，否则说明 |
| --- | --- |
| `hostMatchesPattern(rule.pattern, hostname)`（实参对调） | 通配路径从没被集成测过 → Task 2 拦不住任何站点 |
| `return rules[0]`（命中了却返回第一条） | Task 3 的"一键解除"会删掉错误的规则 |
| `isNeverTranslate` 改成 `rules.some(...)`（忽略首条命中） | 优先级语义没测；脏存储里 `[translate, never]` 同 pattern 今天就能出现 |
| 删掉 `if (suffix === '') return false;` | 光杆 `*.` 的守卫没有见证者（注意：只有**尾点 FQDN** 主机名 `example.com.` 才能区分，用 `example.com` 测永远杀不死） |
| `p` 不 `toLowerCase()` | 模式侧大小写没人管，而 `pickSiteRules` 原样存 pattern、不折大小写 |

**这一步是本单元的硬门槛**：上一轮就是因为计划没排它，I1/I2 两个缺口才一路混到审查阶段。

- [ ] **Step 7: 提交**

```bash
git add src/core/site-rules.ts tests/core/site-rules.test.ts
git commit -m "feat(core): 站点规则主机名匹配（精确 + *. 前缀通配，首条命中即生效）"
```

---

## Task 2: 内容脚本拦截（唯一一处）

**Files:**
- Modify: `src/content/index.ts`（`:383` 之后、`:387` 的假名扫描之前）
- Test: `tests/content/index.test.ts`

- [ ] **Step 1: 先读测试文件的既有夹具**

打开 `tests/content/index.test.ts`，找到它**已有的**三样东西并沿用，不要另造一套：
① 往 `chrome.storage.local` 写设置的前置；② 派发 `TRANSLATE_PAGE` 消息的辅助；③ 断言"零翻译请求"用的引擎/后台桩计数。
下面的测试体按这些断言写；如果函数名不同，**改调用名而不是改断言内容**。

- [ ] **Step 2: 写失败测试**

追加到 `tests/content/index.test.ts` 的 `describe` 内：

```ts
  it('站点规则命中 never：不采集、零请求、给一句能读懂的话', async () => {
    // 主机名要可控：内容脚本读的是 location.hostname。
    vi.stubGlobal('location', { hostname: 'blocked.example.com' });
    await seedSettings({
      siteRules: [{ pattern: '*.example.com', action: 'never' }],
    });
    const before = document.body.innerHTML;

    await send({ type: MSG.TRANSLATE_PAGE });

    expect(translateCalls()).toBe(0);            // 沿用文件里的"零请求"计数夹具
    expect(document.body.innerHTML).toBe(before); // 一个字节都不许多
    expect(toastText()).toContain('永不翻译');     // 沿用文件里读 toast 的辅助
    vi.unstubAllGlobals();
  });

  it('站点规则是 translate 动作时不拦（今天它没有可观察行为）', async () => {
    vi.stubGlobal('location', { hostname: 'other.example.com' });
    await seedSettings({ siteRules: [{ pattern: 'other.example.com', action: 'translate' }] });
    await send({ type: MSG.TRANSLATE_PAGE });
    expect(translateCalls()).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it('还原不受规则约束：已翻译的页面命中 never 也要能撤掉', async () => {
    vi.stubGlobal('location', { hostname: 'blocked.example.com' });
    // **先正常翻译，再把 never 规则写进存储**——计划原来写的是"先让页面处于已翻译状态，
    // 再发 TOGGLE_PAGE"，落不了地：规则一开始就在存储里的话，页面**根本进不了已翻译态**
    // （第一轮翻译就会被本站的闸拦下），后面的 TOGGLE_PAGE 走的是"未翻译 → 翻译"方向，
    // 要么被拦、要么测的根本不是还原。顺序反过来才是真实场景：用户翻完这站才决定拉黑它。
    await seedSettings({ siteRules: [] });
    await send({ type: MSG.TRANSLATE_PAGE });   // ① 正常翻译：此刻存储里还没有规则
    expect(document.querySelector('[data-jy-root]')).not.toBeNull();
    await seedSettings({ siteRules: [{ pattern: '*.example.com', action: 'never' }] }); // ② 规则落地
    await send({ type: MSG.TOGGLE_PAGE });      // ③ 已翻译态 → 走 restorePage()，规则不该拦还原
    expect(document.querySelector('[data-jy-root]')).toBeNull();
    vi.unstubAllGlobals();
  });
```

**若 `vi.stubGlobal('location', ...)` 在本仓库的 jsdom 下不可替换**（报 `Cannot assign to read only property`），改用等价写法，语义不变：

```ts
Object.defineProperty(globalThis, 'location', { value: { hostname: 'blocked.example.com' }, configurable: true });
```

- [ ] **Step 3: 跑到红**

Run: `npx vitest run tests/content/index.test.ts -t 永不翻译`
Expected: FAIL —— 页面被正常翻译了（`translateCalls()` > 0），因为拦截还不存在。

- [ ] **Step 4: 写实现**

`src/content/index.ts` 顶部 import 区加：

```ts
import { isNeverTranslate } from '../core/site-rules';
```

在 `translatePage()` 内，**紧跟** `:383` 的世代守卫之后、`:387` 的假名扫描之前插入：

```ts
  // 站点规则：命中「永不翻译」时不采集、不发任何请求（规格 2026-09-18 §5）。
  // 只拦这一处就够——右键菜单、Alt+T、弹窗按钮三个入口都汇到 translatePage()。
  // 划词与悬停**故意不受约束**：那是用户主动发起的单段翻译，与"这站整页不该翻"是两件事。
  // 位置必须在采集之前：采集有副作用（写 data-jy-id / data-jy-translated），
  // 拦晚了会把一个"不该翻"的页面永久标成已处理。
  if (isNeverTranslate(settings.siteRules, location.hostname)) {
    running = false;
    toast('此站已设为「永不翻译」，可在设置 › 站点规则里解除');
    return;
  }
```

- [ ] **Step 5: 跑到绿**

Run: `npx vitest run tests/content/index.test.ts`
Expected: PASS（含既有用例，一条不许少）

- [ ] **Step 6: 变异验证（证明这条闸真的承重）**

把 Step 4 那个 `if` 整块注释掉 → `npx vitest run tests/content/index.test.ts` 必须**恰好**让新用例红。
还原后 `git diff src/content/index.ts` 确认无残留。

- [ ] **Step 7: 提交**

```bash
git add src/content/index.ts tests/content/index.test.ts
git commit -m "feat(content): 站点规则命中 never 时拦住整页翻译（零请求、零副作用）"
```

---

## Task 3: 弹窗状态与一键解除

**Files:**
- Modify: `src/popup/popup.html:32` 之后
- Modify: `src/popup/popup.ts`
- Test: `tests/popup/popup.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `tests/popup/popup.test.ts`（沿用该文件已有的"装 DOM → import 模块 → 等初始化"顺序与 `chrome.tabs.query` 桩）：

```ts
  it('当前站点命中 never：提示行出现，并带一个解除按钮', async () => {
    stubActiveTabUrl('https://blocked.example.com/path');
    await seedSettings({ siteRules: [{ pattern: '*.example.com', action: 'never' }] });
    await loadPopup();
    const hint = document.getElementById('site-rule-hint') as HTMLElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('永不翻译');
    expect(document.getElementById('site-rule-unblock')).not.toBeNull();
  });

  it('未命中时提示行整行隐藏（不用空文案占位）', async () => {
    stubActiveTabUrl('https://ok.example.com/');
    await seedSettings({ siteRules: [{ pattern: 'blocked.example.com', action: 'never' }] });
    await loadPopup();
    expect((document.getElementById('site-rule-hint') as HTMLElement).hidden).toBe(true);
  });

  it('点解除：只删掉命中的那一条，其余规则原样留在存储里', async () => {
    stubActiveTabUrl('https://blocked.example.com/');
    await seedSettings({
      siteRules: [
        { pattern: '*.example.com', action: 'never' },
        { pattern: 'keep.me', action: 'never' },
      ],
    });
    await loadPopup();
    (document.getElementById('site-rule-unblock') as HTMLButtonElement).click();
    await waitFor(async () => (await storedSiteRules()).length === 1);
    expect((await storedSiteRules())[0].pattern).toBe('keep.me');
    // 解除成功的**界面**结果也要钉住：删掉成功分支里那句 `refreshSiteRuleHint()` 或那句
    // 状态文案，只有这里会红（在这之前，"点完解除界面上发生了什么"是零读数）。
    const hint = document.getElementById('site-rule-hint') as HTMLElement;
    await waitFor(() => hint.hidden === true);   // 见下方"测试清单"第 6 条
    expect(ui().status.textContent).toBe('已解除，点「翻译此页」开始');
    // 测试替身里那个 `ui()` 返回的对象字段名恰好也叫 `status`——与源码里的 `statusText`
    // 不是同一个东西（源码侧见 Step 4 末尾那条变量名说明）。
  });

  it('受限页面拿不到 url 时不报错、提示行隐藏', async () => {
    stubActiveTabUrl(undefined); // chrome:// 页面，tab.url 不可得
    await seedSettings({ siteRules: [{ pattern: '*.example.com', action: 'never' }] });
    const rejections = await unhandledRejections(loadPopup);   // 见下方"测试清单"第 8 条
    expect(rejections).toEqual([]);
    expect((document.getElementById('site-rule-hint') as HTMLElement).hidden).toBe(true);
  });
```

**测试清单（实现者照此落地，逐条都要有；标「计划外」的是实现途中实测补上的）**：

> 上面代码块里的**项目符号是空心的**，所以真正的语义落在下面这张清单上——代码块与清单冲突时
> **以清单为准**（代码块是按清单重写过的，个别辅助名以清单末尾那条为准）。

1. 当前站点命中 never：提示行出现，并带一个解除按钮。
2. 未命中时提示行整行隐藏（不用空文案占位）。
3. 点解除：只删掉命中的那一条，其余规则原样留在存储里——**并且**解除后提示行隐藏、
   状态行是"已解除，点「翻译此页」开始"。少了后半句，"点完解除界面上到底发生了什么"是零读数。
4. 受限页面拿不到 url 时不报错、提示行隐藏（`stubActiveTabUrl(undefined)`）。
5. **【计划外但必需】同 pattern 有多条时只撤掉生效的那一条**：夹具是
   `[{pattern:'*.example.com', action:'never'}, {pattern:'*.example.com', action:'never'},
   {pattern:'keep.me', action:'never'}]`（同 pattern 两条 + 一条无关）。上面第 3 条里两条 pattern
   各不相同，**按 pattern 过滤与按对象身份过滤给出同一个结果**，杀不掉"按 pattern 一锅端"这个
   变异；只有这条能分辨两种删法。同 pattern 多条是真实可达的脏数据（`pickSiteRules` 不去重、
   不排序）。
6. **【计划外但必需】写盘失败不静默**：把存储里的 `version` 改成 `CURRENT_VERSION + 1`
   （`saveSettings` 的明确拒绝路径，真实可达：用户装过新版又回退），再点解除 →
   状态行含"解除失败"与 `已跳过保存`、**不含**"已解除"，提示行仍亮着、存储里规则还在。
7. **【计划外但必需】规则是 `action: 'translate'` 时不显示**：判据必须是 `isNeverTranslate`
   （只看首条命中的 action），不是"命中了任意一条规则"。把判据写成 `matchSiteRule(...) !== null`
   会在 `{pattern, action: 'translate'}` 这个合法夹具上亮起一行彻头彻尾的假话，而其余用例
   （action 全是 never）一条都不会红。
8. **【计划外但必需】两条拒绝路径**（`runSafely` 那条纪律：任何没被就地处理的拒绝都要变成
   用户看得见的一句话）：① 初始化时第 2 次 `tabs.query` 失败 → 状态行含"拿不到当前标签页"、
   主按钮仍按页面状态渲染（不是"重新试一次"）、无未处理拒绝；② 点解除时 `tabs.query` 失败 →
   说出原因、规则原样留在存储里、提示行还在、主按钮一个字节不变。两条都用
   `unhandledRejections(...)` 包住——删掉就地处理的 catch，未处理拒绝本身不会让断言变红，
   红的是 `expect(rejections).toEqual([])`。
9. **【计划外但必需】url 是字符串但解析不了时不许拿原串当主机名**：夹具的 url 原文与规则
   pattern 是同一个串（`'MUTANT'`），`catch { return tab.url }` 那种写法会让它命中、提示行
   亮起来；要钉的是提示行隐藏且不抛错。

辅助函数名：**按实际落地时的文件为准**，计划初稿里的名字与最终代码不同——
`seedStorage` → `seedSettings`、`mountPopup` → `loadPopup`、`readStoredSiteRules` →
`storedSiteRules`（异步、直读存储）；等待用文件里已有的 `waitFor`，未处理拒绝用
`unhandledRejections`。上面代码块已经按这套名字改过一遍，落笔时仍以 `tests/popup/popup.test.ts`
的实际定义为准。`stubActiveTabUrl` 就是给 `chrome.tabs.query` 的替身
（`chromeStub.tabs.activeTabs`）装上 `url`；**替身默认的活动标签没有 url**（与真机
`chrome://` 页面同形），所以每条用例都得显式装一次。

- [ ] **Step 2: 跑到红**

Run: `npx vitest run tests/popup/popup.test.ts -t 永不翻译`
Expected: FAIL —— `document.getElementById('site-rule-hint')` 为 `null`。

- [ ] **Step 3: 加 DOM**

`src/popup/popup.html`，在 `<p id="status" class="status"></p>`（`:32`）之后插入：

```html
    <!-- 站点规则状态行：只在命中「永不翻译」时出现，否则整行 hidden。
         不用空文案占位——那会在主按钮下面撑出一段无意义留白。 -->
    <p id="site-rule-hint" class="hint" hidden>
      此站已设为「永不翻译」。
      <button id="site-rule-unblock" class="link" type="button">解除</button>
    </p>
```

- [ ] **Step 4: 加逻辑**

> 本任务里 `popup.ts` 的代码块**不带 `// src/popup/popup.ts` 首行标记**，所以
> `scripts/sync-plan-code.mjs` 不会同步它们（那个脚本只认带路径标记的块，而带标记的块会被
> 整文件覆盖——这里给的是片段）。代价是**下面这些片段要手工与源码保持一致**：改 `popup.ts`
> 时连这里的片段一起改，别让计划里的版本漂在源码前面。

`src/popup/popup.ts` import 区加：

```ts
import { isNeverTranslate, matchSiteRule } from '../core/site-rules';
```

元素引用区（与 `statusText`/`toggle` 同一批）加：

```ts
const siteRuleHint = document.getElementById('site-rule-hint') as HTMLParagraphElement;
const siteRuleUnblock = document.getElementById('site-rule-unblock') as HTMLButtonElement;
```

模块作用域加**三个**函数（`settings` 是文件里已有的模块级当前设置，由 `applySettings()` 赋值）。
计划初稿只写了两个，`reportSiteRuleFailure` 是实现时补上的第三个——**只写状态行、不碰主按钮**：

```ts
/**
 * 当前标签页的主机名。受限页面（chrome://、扩展商店、部分 about/）拿不到 `tab.url`，
 * 返回 null —— 此时**不显示**提示行，而不是猜一个"没被拦"：猜错的两个方向都难看
 * （凭空说"这站永不翻译"、或给出一个点了会写坏存储的解除按钮）。
 */
async function activeHostname(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (typeof tab?.url !== 'string') return null;
  try {
    return new URL(tab.url).hostname;
  } catch {
    return null; // 畸形 url：与"拿不到"同等处理
  }
}

/**
 * 站点规则那条链上的失败，一律变成状态行里的一句话——`runSafely` 那条纪律的同款要求
 * （"**任何**没被就地处理的拒绝都要变成用户看得见的一句话"）。
 *
 * **只写状态行**，不碰主按钮：这里失败的是"读当前标签页 / 解除规则"，与"这个页面能不能
 * 翻译"是两件事。走 `renderToggle` 那套兜底会把主按钮重绘成"重新试一次"，那是错的形状。
 */
function reportSiteRuleFailure(raw: unknown): void {
  statusText.textContent = errorText('拿不到当前标签页的地址', raw);
}

/**
 * 命中 never 才显示提示行。判据的两个输入是"当前标签页的主机名"与"手里这份 `siteRules`"，
 * 任何一个变了都得重算——今天有两个调用点：`start()`（初始化）与解除按钮（改完规则）。
 *
 * **拒绝就地处理**（`reportSiteRuleFailure` 那条纪律）：本函数由 `start()` 直接 await，
 * 不在 `runSafely` 的保护里，漏掉这一层就是一次未处理的拒绝——界面上什么都不会发生。
 * 拿不到主机名时按"不显示"处理（与受限页面同一档），并把原因说出来。
 */
async function refreshSiteRuleHint(): Promise<void> {
  let host: string | null;
  try {
    host = await activeHostname();
  } catch (raw) {
    siteRuleHint.hidden = true;
    reportSiteRuleFailure(raw);
    return;
  }
  siteRuleHint.hidden = !(host !== null && isNeverTranslate(settings.siteRules, host));
}
```

**落点：`start()` 的末尾、`await` 调用一次**——不是计划初稿写的"在 `applySettings(next)` 末尾加
`void refreshSiteRuleHint();`"。**别再挪回 `applySettings`**，那样会当场踩同一个坑：
`init()` 里 `start()` 的顺序是 `applySettings()` → `refreshPageState()` → `renderToggle()`
→ `refreshSiteRuleHint()`，而 `renderToggle()` 写的也是同一个 `#status` 节点；
fire-and-forget 的那句失败提示会被**紧接着**的 `renderToggle` 用"当前页面不支持翻译…"
覆盖掉，用户什么也看不到。实测红的样子就是
`expected '当前页面不支持翻译（浏览器内置页面或扩展商店页面）。' to contain '拿不到当前标签页'`。

```ts
async function start(): Promise<void> {
  applySettings(await loadSettings());
  await refreshPageState();
  inFlight = false;
  renderToggle(pageState);
  // 站点规则提示行**最后**算，而且要 await：它失败时写进 `#status` 的那句话必须是最后
  // 一句——上面那次 `renderToggle` 写的是同一个节点，fire-and-forget 的失败句会被它盖掉。
  // 这也是本文件唯一一处在 `runSafely` 之外直接 await 的链。
  await refreshSiteRuleHint();
}
```

事件绑定处加（与其余 `addEventListener` 同一批，**在第一个 `await` 之前**挂好——沿用本文件
那条"监听器不能变成有条件注册"的纪律）：

```ts
siteRuleUnblock.addEventListener('click', () => {
  void (async () => {
    let host: string | null;
    try {
      host = await activeHostname();
    } catch (raw) {
      // 与初始化同一条口径（`reportSiteRuleFailure`）：读不到标签页就说原因，不静默。
      reportSiteRuleFailure(raw);
      return;
    }
    if (host === null) return;
    const rule = matchSiteRule(settings.siteRules, host);
    if (rule === null) return;
    // 按对象身份删，不按 pattern 删：同一个 pattern 可能被写了多条规则，
    // 用户点一次解除只该撤掉生效的那一条（首条命中的那条）。
    const next: Settings = { ...settings, siteRules: settings.siteRules.filter((item) => item !== rule) };
    try {
      await saveSettings(next);
    } catch (raw) {
      // 写盘失败不能静默：不报告就变成"点了没反应"，用户会反复点。
      // 这里不用 `saveSettingsOrReport`：那个辅助的契约是"回滚一个下拉控件"，硬套要么改
      // 它的签名（牵动三个既有调用点），要么传一个假控件进去。
      statusText.textContent = `${errorText('解除失败', raw)}，再试一次`;
      return;
    }
    settings = next;
    await refreshSiteRuleHint();
    statusText.textContent = '已解除，点「翻译此页」开始';
  })();
});
```

**变量名：文件里叫 `statusText`，不叫 `status`**——计划初稿通篇写的是 `status`，落地时全仓
`#status` 的引用名是 `statusText`（`const statusText = document.getElementById('status') …`）。
按文件里已有的引用来，**不要**新造第二个指向同一节点的变量。

- [ ] **Step 5: 跑到绿**

Run: `npx vitest run tests/popup/popup.test.ts`
Expected: PASS（含既有用例）

- [ ] **Step 6: 变异验证**

计划初稿的①写的是"把 `!` 判断改成恒 `false`（永远隐藏）"——**这句话自相矛盾**：`hidden` 赋值里
`!` 去掉、表达式恒 `false`，得到的是"提示行**永远隐藏**"，不是"恒 false"（`hidden = false`
恰恰是永远显示）。改成说得通的那一个：

① **让提示行永远隐藏**——把 `siteRuleHint.hidden = !(host !== null && isNeverTranslate(...))`
改成 `siteRuleHint.hidden = true;` → 「当前站点命中 never：提示行出现」那条必须红。
（这才是真正要防的变异：恒隐藏会让功能整体失灵，而"命中时隐藏"只在没有正向用例时才会漏过。
注意别只跑「未命中时隐藏」那条——它在恒隐藏下**照样是绿的**，这正是这个变异危险的地方。）

② 把 `filter((item) => item !== rule)` 改成按 `pattern` 过滤 → 「只删命中的那一条」必须红；
若同时补上了测试清单第 5 条（同 pattern 多条），那条也会红。

另外四个是**实际跑过**的变异体（审查与实现阶段实测，逐个都杀掉了对应用例）：

③ **成功分支删掉 `await refreshSiteRuleHint();`** → 「点解除」那条用例的
`await waitFor(() => hint.hidden === true)` 必须红（提示行不会灭）。
④ **成功分支删掉最后那句 `statusText.textContent = '已解除…'`** → 同一条用例的状态行断言必须红。
⑤ **`isNeverTranslate(...)` 换成 `matchSiteRule(...) !== null`**（命中任意规则就显示）→
「规则是『总是翻译』时不显示」必须红；其余用例 action 全是 never，一条都不会红。
⑥ **`activeHostname` 里那个 `catch` 改成 `return 'MUTANT'`**（拿 url 原文当主机名）→
「url 解析不了时不拿原串当主机名」必须红（夹具的 url 与 pattern 故意是同一个串 `MUTANT`）。

还原后跑全量确认绿。

- [ ] **Step 7: 提交**

```bash
git add src/popup/popup.html src/popup/popup.ts src/manifest.json tests/popup/popup.test.ts tests/manifest.test.ts
git commit -m "feat(popup): 命中站点规则时显示状态并提供一键解除"
```

> 落地时这一笔之后还有两个后续提交：`bd1759d`（提示行与一键解除）与 `852287b`
> （**补 `activeTab` 权限**，见 Task 5）。`activeTab` 与 `tests/manifest.test.ts` 是本 Task
> 落地时才发现的必需项，计划初稿的 File 列表里没有它们。

---

## Task 4: 文档与收口

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/`（脚本重切）

- [ ] **Step 1: README 补四条已知限制 + 功能表一行 + 隐私一节的权限**

在功能表里加一行说明站点规则，并在**已知限制**里新开一节「站点规则」，逐字加上**四条**
（前三条来自计划初稿，第四条是**本轮实测发现的诚实记录**——`activeTab` 那条链只有文献依据）：

```markdown
- **站点规则只拦整页翻译**（右键菜单 / `Alt+T` / 弹窗按钮）。**划词与悬停翻译不受约束**——
  那是你主动发起的单段翻译，与"这个站整页不该翻"是两件事。
- 规则只认两种写法：`example.com`（精确，不含子域）与 `*.example.com`（含裸域与任意层子域）。
  自上而下首条命中即生效。**其余写法（`*example.com`、`https://example.com`、`example.com:8080`）
  不报错、只会永不命中**；规则按 punycode/ASCII 匹配，填中文域名会静默失效。
- `action: 'translate'`（总是翻译）目前**没有可观察行为**，因为本扩展还没有自动翻译功能；
  设置页暂不提供这个动作，等自动翻译落地再补。
- 弹窗里的「此站已设为永不翻译 · 解除」依赖 `activeTab` 权限读取当前标签页地址。
  **这条链路目前只有文档依据、未在真机验证过**（本机没有浏览器）。若你在弹窗里看不到那行，
  请先确认扩展已重新加载。
```

同一节里顺手改掉一句**已经过时**的话：`### 功能范围` 原本写着「以下均尚未实现…站点规则」
与「`siteRules` / `glossary` 等字段…没有对应界面，也没接到内容脚本上」——`siteRules` 的
**消费侧**（拦截 + 弹窗解除）本轮已经落地，留在那儿会让读者以为整条都没做。
**但别把话说满**：规则仍然**没有写入侧界面**（设置页还不能增删规则，只能到存储里改）。

`## 隐私` 一节**原来没有列举权限**（只写了"页面权限按最小化申请"与 optional host
permissions 那条申请纪律，`permissions` 数组本身从没列过）。本轮给 manifest 加了
`"activeTab"`，所以要**新增一条**把它列出来，并说明：只在**你点击扩展图标打开弹窗**时
授予当前标签页的临时访问权、**不产生安装警告**（对比 `tabs` 会产生"读取您的浏览记录"）。

- [ ] **Step 2: 全量收口**

```bash
npm test && npm run typecheck && npm run build && npm run zip
```
Expected: 全绿；测试总数 **867 / 40 files**（本任务只改文档与一处注释，**一个数都不该变**）；
`build` 末尾 `verify:dist` 报「产物校验全部通过（14 项）」；把测试总数、`dist/content.js`、
`dist/popup.js`、`dist/manifest.json` 的字节数与 zip 的文件数/字节数记进提交信息。

- [ ] **Step 3: 同步任务书**

```bash
node scripts/sync-plan-code.mjs docs/superpowers/plans/2026-09-18-site-rules-never-translate.md src/ tests/
```

Expected: 第二次运行报「**已同步 0 个代码块**」（幂等）。方向是**仓库 → 计划**：它把计划里
**带 `// <仓库相对路径>` 首行标记**的代码块刷成仓库当前内容，所以散文部分要手改、代码块不用。
只认带标记的块——本计划里只有 `src/core/site-rules.ts` 与（本轮补上标记的）
`tests/core/site-rules.test.ts` 两个块会被它覆盖，`popup.ts` / 内容脚本那些**片段**没有标记，
脚本不碰，改源码时要手工同步（Task 3 Step 4 开头有提醒）。

> **`scripts/split-plan.mjs` 对本计划不适用，不要跑。** 它的 `units` 映射是**写死**给
> `2026-09-14-immersive-translate-core.md`（Task 1~19 / `wu1`~`wu10`）的：本计划只有
> Task 1~5，脚本会先写掉 `units/wu1.md` 再在找 `Task 5 不存在于计划中` 时抛错退出（`wu1`
> 被覆写成**另一个计划**的 Task 1，必须 `git checkout -- docs/superpowers/plans/units/wu1.md`
> 还原）。`units/` 下那批切片是 2026-09-14 那份计划的产物，与本计划无关。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "docs: 站点规则的边界（只拦整页、匹配语义、translate 动作暂无行为）"
```

---

## Task 5: `manifest` 的 `activeTab` 与它的源码约束测试（事后补记）

> **计划里原本完全没有这一条。** 它是 Task 3 落地时才暴露出来的**前置条件**：没有它，
> Task 3 的全部功能在真机上静默失效，而**全套测试照样全绿**。本 Task 是事后补记
> ——记录"为什么必须有、为什么选它、测试为什么放那个文件"——**不改源码、不改测试**
> （`src/manifest.json` 与 `tests/manifest.test.ts` 的实际内容已经是落地后的样子）。

**Files（已落地的现状，不是待办）：**
- `src/manifest.json`：`permissions` = `["storage", "contextMenus", "activeTab"]`（新增了第三项）
- `tests/manifest.test.ts`：3 条用例，钉住 `activeTab` 在、`tabs` 不在、`action.default_popup` 在
- 相关：`src/popup/popup.ts` 的 `activeHostname()`（Task 3 Step 4）

- [ ] **Step 1: 为什么必须有 `activeTab`（不是可选优化）**

链条是断在**权限模型**上的，不是断在代码上：

1. 弹窗要判定"当前站点是否命中永不翻译"，输入是**活动标签页的主机名**；
2. 主机名来自 `Tab.url`，而 Chrome **只在两种情况下**才填这个字段：声明了 `tabs` 权限，
   **或**扩展对该页面持有宿主权限；
3. `content_scripts.matches` 里那两条 `["http://*/*", "https://*/*"]` **不提供**宿主权限——
   Chromium 的权限设计文档把这一类叫 **scriptable hosts**，原话是
   "These only control which sites an extension can use content scripts on, and **do not affect
   any other API**"（[Chromium permissions.md](https://chromium.googlesource.com/chromium/src/+/main/extensions/docs/permissions.md)）；
4. `optional_host_permissions`（本扩展的 `http://*/*`、`https://*/*`）在用户授权前不生效，
   而且我们**只在用户保存自定义引擎地址时**才去申请它——普通网站从来不在其中。

于是没有 `activeTab` 时：`activeHostname()` **恒返回 `null`** → 提示行恒 `hidden` →
「解除」按钮永远不出现——功能整体静默失效，而界面上没有任何错误可看。这正是
**"改了也不会红"的典型**：测试里的 `chrome.tabs.query` 是替身、jsdom 也不模拟权限，
删掉它全套 867 条照样绿。

- [ ] **Step 2: 为什么选 `activeTab` 而不是 `tabs`**

两者都能让 `Tab.url` 可读，代价却不同：

- `tabs` 会产生安装警告 **"读取您的浏览记录"**（Read your browsing history，
  见 [Chrome 权限清单](https://developer.chrome.com/docs/extensions/reference/permissions-list)）——
  为一个弹窗提示行付这个代价不值得，它会把"这扩展要看我的浏览记录"直接摆在用户面前；
- `activeTab` **不产生任何安装警告**，而且**点击扩展图标打开弹窗本身就是 user invocation**，
  Chrome 据此自动授予当前标签页的访问权——正好是本扩展的场景，语义上也最诚实
  （只有你点开弹窗时，扩展才看得到那个标签页的地址）。
- 剩下那条路是让内容脚本回报 `location.hostname`：多一条消息通道，在内容脚本没注入的页面上
  同样拿不到，收益更小。

- [ ] **Step 3: 为什么那条测试放在 `tests/manifest.test.ts`**

- 它约束的是**源码**（`src/manifest.json`），与有没有跑过 `npm run build` 无关；
  放进 `npm test` 必须**恒定可判**，不依赖任何构建产物；
- 因此**不**放进 `tests/scripts/zip-dist.test.ts`：那个文件测的是**打包脚本**对
  **tmp fixture** 的行为（打包、解回、CRC、条目名），它**根本不读源 manifest**——
  放进去等于用一件不相干的工具去守这条约束；
- 也不该只靠"读 `dist/manifest.json`"：那要求先构建，而 `npm test` 不构建。

- [ ] **Step 4: 回头看这条约束值多少**

`tests/manifest.test.ts` 的 3 条：① `permissions` 含 `activeTab`（先钉 `Array.isArray` 形状，
免得类型一变就以更难读的方式失败）；② **反向**约束：`permissions` **不含** `tabs`
（将来真需要 `tabs` 时，请连注释一起改掉这条断言，别在没意识到代价的情况下把安装警告加回来）；
③ `action.default_popup === 'popup/popup.html'`——`activeTab` 的授予正来自这次 user invocation，
少了 `default_popup`，①就只是一句没有来路的声明。

**如实说明置信度**：本 Task 的全部依据是**文献级**的（Chromium 权限文档 + Chrome 权限清单），
**没有在真机上验证过**——本机没有浏览器。`activeTab` 那条链（点图标 → 授予 → `Tab.url` 可读）
在真机上的实际表现仍列在 README 的「已知限制」里，写成"未在真机验证"。

---

## 验收对照（规格 §9 / §10）

| 规格条目 | 哪一步覆盖 |
| --- | --- |
| `never` 命中时三个入口都不翻译 | Task 2 Step 4（单一拦截点即覆盖三者）+ Step 6 变异 |
| `*.x.com` 通配与精确匹配各有用例 | Task 1 Step 1（含 `notexample.com`、`example.com.evil.io` 两个陷阱用例） |
| 自上而下首条命中生效 | Task 1 Step 1 `matchSiteRule` 用例 |
| 划词/悬停不受约束 | Task 2 Step 2 第四条「还原不受规则约束」（**先翻译、后写规则**，见该条说明）+ README 明示 |
| 零网络请求、零 DOM 副作用 | Task 2 Step 2（`innerHTML` 逐字节比对 + 请求计数） |
| 弹窗状态与解除 | Task 3 全部（测试清单 1~9，其中 5~9 为实现阶段补的必需用例） |
| 不给没有行为的字段做控件 | Task 1 Step 3 注释 + README 第三条 |
| 弹窗那条链在真机上真的拿得到当前站点 | Task 5（`activeTab`）+ README 第四条**如实写成"未在真机验证"** |
