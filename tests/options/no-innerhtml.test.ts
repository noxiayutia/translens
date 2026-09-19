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
 * 今天（Task 3 落地后）`src/options` 下**必须**被扫到的模块。断言"集合**包含**这几个"，
 * 而不是"恰好 N 个"或"至少 N 个"：
 *
 * - 写成 `toBe(8)` 会在 Task 4~8 每加一个 `sections/*.ts` 时变红（那是正常增长，不是回归）；
 * - 写成 `toBeGreaterThanOrEqual(8)` 在**今天**等价于 `>= 1`：它只在"扫到 0 个"时才红，
 *   而"遍历器坏掉、只扫到顶层"（`sections/` 那 4 个文件被漏掉）这种最可能的坏法它抓不住
 *   ——实测把下界改成 `>= 0` 仍然全绿。
 *
 * 列路径是"对增长稳健、又抓得住遍历器坏掉"的形态：下面每一条钉住一个具体模块，
 * 少扫到任何一个就红；将来新增文件不影响它。
 */
const REQUIRED_PATHS = [
  'src/options/options.ts',
  'src/options/store.ts',
  'src/options/dom.ts',
  'src/options/section.ts',
];

/**
 * 递归那一层（`sections/`）今天**必须**被扫到的模块。四个区块一个都不能少：它们全是渲染
 * 用户输入的代码（档案名、语言标签、缓存计数），漏扫任何一个都等于守卫在那一块上是瞎的。
 * 与上面同一条口径——只说"必须有哪些"，**不说"总共几个"**，所以 Task 4~8 往这里加文件不会红。
 */
const REQUIRED_SECTION_PATHS = [
  'src/options/sections/engine.ts',
  'src/options/sections/language.ts',
  'src/options/sections/cache.ts',
  'src/options/sections/privacy.ts',
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
