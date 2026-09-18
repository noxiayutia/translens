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
