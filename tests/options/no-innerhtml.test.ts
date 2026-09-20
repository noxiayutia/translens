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

/**
 * 顶层（`src/options/*.ts`）里必须被扫到的模块。断言"集合**包含**这几个"，
 * 而不是"恰好几个"或"至少几个"：
 *
 * - 写成 `toBe(REQUIRED_PATHS.length)` 会在每加一个模块时变红（那是正常增长，不是回归）；
 * - 写成 `toBeGreaterThanOrEqual(REQUIRED_PATHS.length)`（今天 4）今天什么也抓不住：
 *   实测递归口径扫到 15 个（顶层 7 + `sections/` 8），**只扫顶层也有 7 个**，两种口径都 ≥ 4；
 *   而下界只会说"总数够不够"，**说不出缺的是哪一个模块**。
 *
 * 列路径是"对增长稳健、又抓得住遍历器坏掉"的形态：下面每一条钉住一个具体模块，
 * 少扫到任何一个就红；将来新增文件不影响它——**所以这份清单是下限、不是穷举**，
 * 与下面 `REQUIRED_SECTION_PATHS` 同一条口径。
 */
const REQUIRED_PATHS = [
  'src/options/options.ts',
  'src/options/store.ts',
  'src/options/dom.ts',
  'src/options/section.ts',
];

/**
 * 递归那一层（`sections/`）里**今天存在的每一个区块模块都必须在清单上**。它们全是渲染
 * 用户输入的代码（档案名、语言标签、缓存计数），漏扫任何一个都等于守卫在那一块上是瞎的。
 *
 * **这份清单是下限，不是穷举**：断言只说"必须包含这些"，将来新增文件不影响它；反过来说，
 * `npm run build` 不会因为这里漏列一个新文件而变红——所以它靠的是**新增文件时顺手加一行**
 * 这条纪律（写在这里，就是为了让纪律有个落点）。
 *
 * 为什么仍然逐个列路径，而不是只写一句"`sections/` 至少扫到一个"：
 * - 写成 `toBe(REQUIRED_SECTION_PATHS.length)` 会在每加一个区块时变红（那是正常增长，不是回归）；
 * - 写成 `toBeGreaterThanOrEqual(REQUIRED_SECTION_PATHS.length)`（今天 8）确实抓得住"`sections/`
 *   整个目录被漏掉"这一种——实测把 `collect` 的递归那一行去掉后只剩顶层 7 个，`>= 8` 为 false、
 *   当场红——但它**说不出缺的是哪一个模块**：今天区块正好 8 个，少扫到一个会跌破下界；将来涨到
 *   9 个之后再少扫到一个（总数仍 ≥ 8）它就看不见了。
 *
 * 逐个列路径是"对增长稳健、又抓得住遍历器坏掉"的形态：下面每一条钉住一个具体模块，
 * 少扫到任何一个就红。（这四个是 Task 4~7 新建的区块：`shortcuts.ts` `5160200`、`glossary.ts`
 * `b85513e`、`site-rules.ts` `7cc8080`、`prompt.ts` `ca90981`；清单自 Task 3 之后一直没跟着补，
 * 直到 `7f7a2dd` 一次补齐。别再写成"`shortcuts.ts` 在 Task 3 时就存在"——那句话与 `git log` 不符。）
 */
const REQUIRED_SECTION_PATHS = [
  'src/options/sections/engine.ts',
  'src/options/sections/language.ts',
  'src/options/sections/shortcuts.ts',
  'src/options/sections/glossary.ts',
  'src/options/sections/site-rules.ts',
  'src/options/sections/prompt.ts',
  'src/options/sections/privacy.ts',
  'src/options/sections/cache.ts',
];

describe('设置页源码守卫：用户数据一律走 textContent', () => {
  it('扫到的文件里必须含这些已知模块（防止遍历器坏掉/路径写错导致空扫描假通过）', () => {
    const paths = sources.map((file) => file.path);
    expect(paths).toEqual(expect.arrayContaining([...REQUIRED_PATHS, ...REQUIRED_SECTION_PATHS]));
    // 只扫顶层时上面每一条都会红；这一条是"递归那一层确实被走到"的最短见证。
    expect(paths.some((path) => path.startsWith('src/options/sections/'))).toBe(true);
  });

  it('这些文件里不出现 HTML 注入面的那三个标识符（清单见 FORBIDDEN 正则）', () => {
    const hits: string[] = [];
    for (const file of sources) {
      file.text.split('\n').forEach((line, index) => {
        if (FORBIDDEN.test(line)) hits.push(`${file.path}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
