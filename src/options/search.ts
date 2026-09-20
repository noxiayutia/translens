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
