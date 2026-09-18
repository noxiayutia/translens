// src/core/site-rules.ts

/**
 * 站点规则的主机名匹配。纯函数：不碰 DOM、不碰扩展宿主 API（`tests/core/layering.test.ts` 守着这条）。
 *
 * 只支持两种写法，**刻意不做更花哨的通配**——规则越少越可预测：
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
