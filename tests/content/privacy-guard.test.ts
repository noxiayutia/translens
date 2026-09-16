/**
 * 隐私守卫：`src/content/**` 一行 `loadSettings` 都不许有。
 *
 * 内容脚本跑在网页进程（isolated world）里，`shared/settings.ts` 的 `loadSettings()` 返回的
 * 完整设置含**每个服务商档案的 `apiKey`**——用它就等于让密钥以"可读字段"的形式流进网页侧的调用链。
 * 如实定性边界：这是**类型级**约束（投影版类型里没有 apiKey 字段，下游拿不到、也就写不进
 * 消息与日志），不是内存级隔离（`loadUiSettings` 内部同样会读出整份设置，密钥会瞬态经过本
 * world 的堆；isolated world 下页面脚本访问不到那个堆）。守卫防的是"内容脚本里出现能直接
 * 访问 apiKey 的代码"这条扩散路径，README 把"密钥不进内容脚本（投影）"写成了已兑现的承诺
 * （规格 §7.3）。
 *
 * 断言的是**源码文本本身**而不是某次 import 的行为（同 `tests/core/layering.test.ts`）：
 * 混进来的一行 import 在运行时不一定会被触发，但它已经是这条边界的破口。
 * `loadUiSettings` 里不含 `loadSettings` 这个字面子串（`loadUi` 把两段隔开了），
 * 所以按裸标识符 `\bloadSettings\b` 匹配不会误伤投影版本——守卫不会因为"改对了"而变红。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** 网页进程里跑的代码（内容脚本 + 它自己的模块）。 */
const GUARDED_DIR = 'src/content';

/** 含密钥的读取入口：内容脚本一律用 `loadUiSettings`（见文件头注释）。 */
const FORBIDDEN = /\bloadSettings\b/;

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

const sources = collect(GUARDED_DIR);

/** 命中位置直接给成 `路径:行号: 内容`，失败时不用再翻代码找。 */
function offenders(): string[] {
  const hits: string[] = [];
  for (const file of sources) {
    file.text.split('\n').forEach((line, index) => {
      if (FORBIDDEN.test(line)) hits.push(`${file.path}:${index + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

describe('隐私守卫：内容脚本不得读取含 API Key 的完整设置', () => {
  it('扫到的文件里确实有内容脚本本体（防止路径写错导致空扫描假通过）', () => {
    expect(sources.length).toBeGreaterThanOrEqual(3);
    expect(sources.map((file) => file.path)).toContain('src/content/index.ts');
  });

  it('src/content 下没有任何 loadSettings 调用', () => {
    expect(offenders()).toEqual([]);
  });

  it('守卫的匹配口径真的能抓到违规写法，且不误伤投影版本', () => {
    // 正向：真实的越界写法必须命中（含类型导入、命名空间导入、注释里提到）。
    for (const sample of [
      "import { loadSettings } from '../shared/settings';",
      "import type { Settings } from '../shared/settings';\nconst s = await loadSettings();",
      "import * as settings from '../shared/settings';\nsettings.loadSettings();",
      '// 这里曾经用过 loadSettings',
    ]) {
      expect(sample.split('\n').some((line) => FORBIDDEN.test(line)), sample).toBe(true);
    }
    // 反向：投影版本与它派生的名字都不能命中，否则守卫会在改对之后变红。
    for (const sample of [
      "import { loadUiSettings } from '../shared/settings';",
      'const a = await loadUiSettings();',
      'const loadUiSettingsLazy = loadUiSettings;',
    ]) {
      expect(FORBIDDEN.test(sample), sample).toBe(false);
    }
  });
});
