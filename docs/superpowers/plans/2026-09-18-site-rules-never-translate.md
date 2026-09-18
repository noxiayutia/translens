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
| `tests/popup/popup.test.ts` | 修改 | 提示行只在命中时出现；解除写盘 |
| `README.md` | 修改 | 已知限制补一条 |

---

## Task 1: 纯函数 `matchSiteRule`

**Files:**
- Create: `src/core/site-rules.ts`
- Test: `tests/core/site-rules.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/core/site-rules.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { hostMatchesPattern, isNeverTranslate, matchSiteRule } from '../../src/core/site-rules';

/** 只关心 pattern/action 两个字段，用最小形状构造，避免与设置层耦合。 */
function rule(pattern: string, action: 'translate' | 'never') {
  return { pattern, action } as const;
}

describe('hostMatchesPattern', () => {
  it('精确匹配只认裸域本身，不带上子域', () => {
    expect(hostMatchesPattern('example.com', 'example.com')).toBe(true);
    expect(hostMatchesPattern('www.example.com', 'example.com')).toBe(false);
  });

  it('*. 前缀通配同时匹配裸域与任意层子域', () => {
    expect(hostMatchesPattern('example.com', '*.example.com')).toBe(true);
    expect(hostMatchesPattern('www.example.com', '*.example.com')).toBe(true);
    expect(hostMatchesPattern('a.b.example.com', '*.example.com')).toBe(true);
  });

  it('后缀相似不算命中（这是最容易写错的一类）', () => {
    expect(hostMatchesPattern('notexample.com', '*.example.com')).toBe(false);
    expect(hostMatchesPattern('example.com.evil.io', '*.example.com')).toBe(false);
    expect(hostMatchesPattern('example.com.evil.io', 'example.com')).toBe(false);
  });

  it('大小写与首尾空白不参与判定', () => {
    expect(hostMatchesPattern('WWW.Example.COM', ' *.example.com ')).toBe(true);
  });

  it('空主机名 / 空模式 / 光杆 *. 一律不匹配', () => {
    expect(hostMatchesPattern('', 'example.com')).toBe(false);
    expect(hostMatchesPattern('example.com', '')).toBe(false);
    expect(hostMatchesPattern('example.com', '*.')).toBe(false);
    expect(hostMatchesPattern('', '')).toBe(false);
  });
});

describe('matchSiteRule', () => {
  it('自上而下首条命中即生效，顺序就是优先级', () => {
    const rules = [rule('example.com', 'never'), rule('example.com', 'translate')];
    expect(matchSiteRule(rules, 'example.com')).toBe(rules[0]);
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
 * （注意：这条守卫按**源码文本**扫描、连注释一起扫，所以注释里也不要写出那些标识符本身。）
 *
 * 只支持两种形状，**刻意不做更花哨的通配**——规则越少越可预测：
 *
 * - 精确：`example.com` 只匹配 `example.com`，**不**匹配 `www.example.com`；
 * - 前缀通配：`*.example.com` 匹配裸域本身与任意层子域。
 *   这个语义与 Chrome 的 match pattern 一致，用户从别的翻译扩展迁移过来不会踩意外。
 *
 * 用 `import type` 而不是普通 import：`shared/settings` 会 import `engines/registry`，
 * 运行时依赖一旦成立就是 `core → shared → engines` 的反向层依赖。`import type` 在编译期
 * 被完全擦除，既复用了同一份 `SiteRule` 定义（不复制类型），又不引入任何运行期边。
 */
import type { SiteRule } from '../shared/settings';

export function hostMatchesPattern(hostname: string, pattern: string): boolean {
  const host = hostname.trim().toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (host === '' || p === '') return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    // `*.` 这种光杆写法不算规则，免得写成 `*.` 之后全站被它拦住。
    if (suffix === '') return false;
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === p;
}

/** 自上而下，首条命中即生效。返回命中规则本身（调用方要拿它做"解除"）。 */
export function matchSiteRule(rules: readonly SiteRule[], hostname: string): SiteRule | null {
  for (const rule of rules) {
    if (hostMatchesPattern(hostname, rule.pattern)) return rule;
  }
  return null;
}

/**
 * 本站是否禁止整页翻译。
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
Expected: PASS（8 个 `it`：`hostMatchesPattern` 5 + `matchSiteRule` 2 + `isNeverTranslate` 1）

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
    await seedSettings({ siteRules: [{ pattern: '*.example.com', action: 'never' }] });
    // 先让页面处于已翻译状态（沿用文件里既有的"翻译完成"前置），再发 TOGGLE_PAGE。
    await translateOnce();
    await send({ type: MSG.TOGGLE_PAGE });
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
    await seedStorage({ siteRules: [{ pattern: '*.example.com', action: 'never' }] });
    await mountPopup();
    const hint = document.getElementById('site-rule-hint') as HTMLElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('永不翻译');
    expect(document.getElementById('site-rule-unblock')).not.toBeNull();
  });

  it('未命中时提示行整行隐藏（不用空文案占位）', async () => {
    stubActiveTabUrl('https://ok.example.com/');
    await seedStorage({ siteRules: [{ pattern: 'blocked.example.com', action: 'never' }] });
    await mountPopup();
    expect((document.getElementById('site-rule-hint') as HTMLElement).hidden).toBe(true);
  });

  it('点解除：只删掉命中的那一条，其余规则原样留在存储里', async () => {
    stubActiveTabUrl('https://blocked.example.com/');
    await seedStorage({
      siteRules: [
        { pattern: '*.example.com', action: 'never' },
        { pattern: 'keep.me', action: 'never' },
      ],
    });
    await mountPopup();
    (document.getElementById('site-rule-unblock') as HTMLButtonElement).click();
    await waitFor(() => readStoredSiteRules().length === 1);
    expect(readStoredSiteRules()[0].pattern).toBe('keep.me');
  });

  it('受限页面拿不到 url 时不报错、提示行隐藏', async () => {
    stubActiveTabUrl(undefined); // chrome:// 页面，tab.url 不可得
    await seedStorage({ siteRules: [{ pattern: '*.example.com', action: 'never' }] });
    await mountPopup();
    expect((document.getElementById('site-rule-hint') as HTMLElement).hidden).toBe(true);
  });
```

辅助函数名（`stubActiveTabUrl` / `seedStorage` / `mountPopup` / `waitFor` / `readStoredSiteRules`）按该文件已有的对应物替换；**没有的就在文件顶部补**，其中 `stubActiveTabUrl` 就是给 `chrome.tabs.query` 的桩返回 `[{ url }]`。

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

`src/popup/popup.ts` import 区加：

```ts
import { isNeverTranslate, matchSiteRule } from '../core/site-rules';
```

元素引用区（与 `status`/`toggle` 同一批）加：

```ts
const siteRuleHint = document.getElementById('site-rule-hint') as HTMLParagraphElement;
const siteRuleUnblock = document.getElementById('site-rule-unblock') as HTMLButtonElement;
```

模块作用域加两个函数（`settings` 是文件里已有的模块级当前设置，由 `applySettings()` 赋值）：

```ts
/**
 * 当前标签页的主机名。受限页面（chrome://、扩展商店、部分 about:）拿不到 `tab.url`，
 * 返回 null —— 此时**不显示**提示行，而不是猜一个"没被拦"。
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

/** 命中 never 才显示提示行。设置变化后必须重算（解除、切标签页）。 */
async function refreshSiteRuleHint(): Promise<void> {
  const host = await activeHostname();
  siteRuleHint.hidden = !(host !== null && isNeverTranslate(settings.siteRules, host));
}
```

在 `applySettings(next)` 末尾（`renderEngineHint()` 之后）加一行：

```ts
  void refreshSiteRuleHint();
```

事件绑定处加（与其余 `addEventListener` 同一批，**在第一个 `await` 之前**挂好——沿用本文件 `:433` 那条注释的纪律）：

```ts
siteRuleUnblock.addEventListener('click', () => {
  void (async () => {
    const host = await activeHostname();
    if (host === null) return;
    const rule = matchSiteRule(settings.siteRules, host);
    if (rule === null) return;
    // 按对象身份删，不按 pattern 删：同一个 pattern 可能被写了多条规则，
    // 用户点一次解除只该撤掉生效的那一条（首条命中的那条）。
    const next: Settings = { ...settings, siteRules: settings.siteRules.filter((item) => item !== rule) };
    try {
      await saveSettings(next);
    } catch {
      // 写盘失败不能静默：不报告就变成"点了没反应"，用户会反复点。
      status.textContent = '解除失败：设置没能写入，再试一次';
      return;
    }
    settings = next;
    await refreshSiteRuleHint();
    status.textContent = '已解除，点「翻译此页」开始';
  })();
});
```

`status` 若在本文件里不叫这个名字，用文件里已有的 `#status` 引用；**不要**新造第二个指向同一节点的变量。

- [ ] **Step 5: 跑到绿**

Run: `npx vitest run tests/popup/popup.test.ts`
Expected: PASS（含既有用例）

- [ ] **Step 6: 变异验证**

① 把 `refreshSiteRuleHint` 里的 `!` 判断改成恒 `false` → 「未命中时隐藏」那条必须红（防"永远隐藏"混过测试）。
② 把 `filter((item) => item !== rule)` 改成按 `pattern` 过滤 → 「只删命中的那一条」必须红。
还原后跑全量确认绿。

- [ ] **Step 7: 提交**

```bash
git add src/popup/popup.html src/popup/popup.ts tests/popup/popup.test.ts
git commit -m "feat(popup): 命中站点规则时显示状态并提供一键解除"
```

---

## Task 4: 文档与收口

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/`（脚本重切）

- [ ] **Step 1: README 补两条**

在功能表里加一行说明站点规则，并在**已知限制**里逐字加上：

```markdown
- **站点规则只拦整页翻译**（右键菜单 / `Alt+T` / 弹窗按钮）。**划词与悬停翻译不受约束**——
  那是你主动发起的单段翻译，与"这个站整页不该翻"是两件事。
- 规则只认两种写法：`example.com`（精确，不含子域）与 `*.example.com`（含裸域与任意层子域）。
  自上而下首条命中即生效。
- `action: 'translate'`（总是翻译）目前**没有可观察行为**，因为本扩展还没有自动翻译功能；
  设置页暂不提供这个动作，等自动翻译落地再补。
```

- [ ] **Step 2: 全量收口**

```bash
npm test && npm run typecheck && npm run build && npm run zip
```
Expected: 全绿；`build` 末尾 `verify:dist` 报「产物校验全部通过（14 项）」；把测试总数与 `dist/content.js` 字节数记进提交信息。

- [ ] **Step 3: 同步任务书**

```bash
node scripts/sync-plan-code.mjs docs/superpowers/plans/2026-09-18-site-rules-never-translate.md src/ tests/
node scripts/split-plan.mjs docs/superpowers/plans/2026-09-18-site-rules-never-translate.md docs/superpowers/plans/units
```
Expected: 第二次运行报「已同步 0 个代码块」（幂等）。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "docs: 站点规则的边界（只拦整页、匹配语义、translate 动作暂无行为）"
```

---

## 验收对照（规格 §9 / §10）

| 规格条目 | 哪一步覆盖 |
| --- | --- |
| `never` 命中时三个入口都不翻译 | Task 2 Step 4（单一拦截点即覆盖三者）+ Step 6 变异 |
| `*.x.com` 通配与精确匹配各有用例 | Task 1 Step 1（含 `notexample.com`、`example.com.evil.io` 两个陷阱用例） |
| 自上而下首条命中生效 | Task 1 Step 1 `matchSiteRule` 用例 |
| 划词/悬停不受约束 | Task 2 Step 2 第三条（还原也不受约束）+ README 明示 |
| 零网络请求、零 DOM 副作用 | Task 2 Step 2（`innerHTML` 逐字节比对 + 请求计数） |
| 弹窗状态与解除 | Task 3 全部 |
| 不给没有行为的字段做控件 | Task 1 Step 3 注释 + README 第三条 |
