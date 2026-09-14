/**
 * 分层守卫：`src/core` 与 `src/engines` 必须能在**没有 DOM、没有扩展 API、没有 Node 运行时**的
 * 环境里被直接 import 并测试——它们是纯函数层，混进任何宿主全局都会把单测拖进 jsdom 或
 * service worker 的模拟里。`tsconfig.json` 只挡住了 Node 全局（`types` 里没有 `node`），
 * 而 DOM 全局在 `src/` 下是**允许**的（内容脚本本来就要用），所以这条约束只能靠机器守。
 *
 * 它一定会随着后续单元接线被逐渐侵蚀（「反正就一行 document.querySelector」），
 * 所以断言的是**源码文本本身**，而不是某次 import 的副作用。
 *
 * 匹配口径：按源码字面量匹配（**含注释**）。代价是偶发误报（改写一句注释即可），
 * 换来的是不漏报任何一处真实越界——注释里也就别写这些标识符了。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** 纯函数层的根目录（相对仓库根）。 */
const LAYER_DIRS = ['src/core', 'src/engines'] as const;

interface SourceFile {
  /** 相对仓库根的路径，失败信息里直接可读 */
  path: string;
  text: string;
}

function collect(dir: string): SourceFile[] {
  const files: SourceFile[] = [];
  const entries = readdirSync(join(ROOT, dir), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...collect(child));
    else if (entry.name.endsWith('.ts')) files.push({ path: child, text: readFileSync(join(ROOT, child), 'utf8') });
  }
  return files;
}

const sources = LAYER_DIRS.flatMap((dir) => collect(dir));

/** 命中位置直接给成 `路径:行号: 内容`，失败时不用再翻代码找。 */
function offenders(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of sources) {
    file.text.split('\n').forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${file.path}:${index + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

/** 宿主全局：DOM、扩展 API、Node 运行时。`\b` 保证 `ArrayBuffer` 这类名字不会被误伤。 */
const FORBIDDEN_GLOBALS: ReadonlyArray<readonly [string, RegExp]> = [
  ['document.', /\bdocument\s*\./],
  ['window.', /\bwindow\s*\./],
  ['chrome.', /\bchrome\s*\./],
  ['process.', /\bprocess\s*\./],
  ['Buffer', /\bBuffer\b/],
  ['__dirname', /__dirname/],
  ['navigator.', /\bnavigator\s*\./],
];

/** 纯函数层不得反向依赖任何宿主层。 */
const FORBIDDEN_IMPORTS = ['../content/', '../background/', '../popup/', '../options/'];

/** 覆盖 `import x from 'y'` / `import 'y'` / `import('y')` / `export … from 'y'`。 */
function importSpecifiers(text: string): string[] {
  return [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

describe('分层守卫：src/core 与 src/engines 不得依赖宿主环境', () => {
  it('至少扫到 5 个文件，且两个目录都扫到了（防止路径写错导致空扫描假通过）', () => {
    expect(sources.length).toBeGreaterThanOrEqual(5);
    for (const dir of LAYER_DIRS) {
      expect(sources.some((file) => file.path.startsWith(`${dir}/`))).toBe(true);
    }
  });

  for (const [label, pattern] of FORBIDDEN_GLOBALS) {
    it(`不出现宿主全局 ${label}`, () => {
      expect(offenders(pattern)).toEqual([]);
    });
  }

  it('import 不得指向 content / background / popup / options 层', () => {
    const hits: string[] = [];
    for (const file of sources) {
      for (const specifier of importSpecifiers(file.text)) {
        if (FORBIDDEN_IMPORTS.some((bad) => specifier.includes(bad))) {
          hits.push(`${file.path}: ${specifier}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('import 提取器本身可用（否则上面那条断言等于空转）', () => {
    expect(importSpecifiers("import { x } from '../content/extractor';")).toEqual(['../content/extractor']);
    expect(importSpecifiers("import type { A } from './a';\nconst b = await import('../background/x');")).toEqual([
      './a',
      '../background/x',
    ]);
  });
});
