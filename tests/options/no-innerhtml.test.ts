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
