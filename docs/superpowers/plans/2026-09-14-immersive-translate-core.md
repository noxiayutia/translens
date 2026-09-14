# 浸译 · 核心翻译链路 实施计划（Plan 1 / 2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可直接加载运行的 Chrome/Edge 扩展：在任意网页按 `Alt+T`，正文段落下方就地出现译文，支持免费引擎与自定义 OpenAI 兼容 API、两级缓存、并发批次翻译。

**Architecture:** MV3 扩展，原生 TypeScript + Vite。`core/` 为纯函数层（零 DOM、零 `chrome.*`，全部可单测）；`engines/` 是网络请求唯一出口；`background/` 无状态处理单批次（缓存→引擎→重试）；`content/` 持有页面级编排状态（抽取→分批→并发池→逐步渲染）。内容脚本不直接发网络请求，避免页面 CSP 干扰。

**Tech Stack:** TypeScript 5 · Vite 6 · Vitest（+ jsdom）· Chrome Manifest V3 · 无 UI 框架

**前置文档:** `docs/superpowers/specs/2026-09-14-immersive-translate-extension-design.md`

**本计划不包含（Plan 2）:** 整页替换模式、悬停段落翻译、划词气泡、MutationObserver 增量翻译、完整设置页、站点规则、术语表编辑界面、Bing 引擎、打包 zip。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `src/manifest.json` | MV3 清单，静态文件，构建时原样复制到 `dist/` |
| `tsconfig.json` / `tsconfig.node.json` | 分别约束 `src/`（浏览器环境）与构建脚本 + 测试（Node 环境），防止 Node 全局对象污染扩展代码 |
| `src/core/hash.ts` | 稳定字符串哈希与缓存 key 组装 |
| `src/core/lang.ts` | 语种脚本识别、是否需要跳过 |
| `src/core/segmenter.ts` | 相邻短段合并、超长段按句切分、切片拼接 |
| `src/core/pool.ts` | 并发池 |
| `src/core/cache.ts` | 两级翻译缓存（session → local，LRU 淘汰） |
| `src/engines/types.ts` | `Translator` 接口、`EngineError`、共享类型 |
| `src/engines/google.ts` | 免费 Google 网页接口 |
| `src/engines/openai-compat.ts` | OpenAI 兼容 `/chat/completions`，编号分段协议 |
| `src/engines/registry.ts` | 引擎注册表 |
| `src/shared/settings.ts` | 设置 schema、默认值、合并与读写 |
| `src/shared/messages.ts` | 类型化消息协议 |
| `src/shared/chrome-area.ts` | `chrome.storage.StorageArea` → 可测试接口的适配器 |
| `src/background/scheduler.ts` | 单批次：缓存命中、引擎调用、退避重试、降级 |
| `src/background/service-worker.ts` | 消息路由、快捷键、右键菜单 |
| `src/content/extractor.ts` | 段落识别 |
| `src/content/renderer.ts` | 译文注入 / 还原 |
| `src/content/styles.ts` | 译文样式常量（注入 Shadow DOM） |
| `src/content/toast.ts` | 页面内轻提示 |
| `src/content/index.ts` | 内容脚本入口：编排 |
| `src/popup/*` | 弹窗 UI |
| `src/options/*` | 设置页（Plan 1 仅占位） |
| `tests/**` | Vitest 单测 |

---

## Task 1: 项目脚手架与构建管线

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vite.content.config.ts`, `vitest.config.ts`, `.gitignore`
- Create: `src/manifest.json`
- Create: `src/background/service-worker.ts`（占位）
- Create: `src/content/index.ts`（占位）
- Create: `src/popup/popup.html`, `src/popup/popup.ts`（占位）
- Create: `src/options/options.html`, `src/options/options.ts`（占位）

- [ ] **Step 1: 创建 `package.json`**

```json
{
  "name": "jinyi",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "浸译 — 沉浸式网页翻译扩展",
  "scripts": {
    "build": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json && vite build && vite build --config vite.content.config.ts",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev:main": "vite build --watch",
    "dev:content": "vite build --config vite.content.config.ts --watch"
  }
}
```

- [ ] **Step 2: 安装依赖**

Run: `npm i -D vite typescript vitest jsdom @types/chrome @types/node`

Expected: 安装成功，`package.json` 的 `devDependencies` 出现这几项。

- [ ] **Step 3: 创建 `tsconfig.json`（只覆盖 `src/`，不含 Node 类型）**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["chrome", "vite/client"],
    "strict": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

**为什么这里必须排除 `"node"`：** 内容脚本与 MV3 service worker 运行在浏览器里，没有 `process`、`Buffer`、`__dirname`、`require`。一旦把 Node 类型放进 `src/` 的作用域，类型系统就会替这些运行时必崩的调用背书，而 `src/core/` 恰恰是最容易被写出 `process.env` 的地方。`src/` 与"构建脚本 / 测试"必须用两份不同的 tsconfig 隔开。

- [ ] **Step 3a: 创建 `tsconfig.node.json`（构建脚本与测试）**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["chrome", "vite/client", "node"],
    "strict": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["tests", "vite.config.ts", "vite.content.config.ts", "vitest.config.ts"]
}
```

测试里保留 `"chrome"` 是必需的：测试会 import `src/shared/settings.ts`，而它引用了 `chrome.storage` 类型。保留 `"DOM"` lib 也是必需的：jsdom 测试要用 `document`、`HTMLElement`。

- [ ] **Step 4: 创建 `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
```

- [ ] **Step 5: 创建 `vite.config.ts`（popup / options / background）**

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** 把静态 manifest.json 原样发射到 dist/ */
function copyManifest(): Plugin {
  return {
    name: 'copy-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: readFileSync(resolve(import.meta.dirname, 'src/manifest.json'), 'utf-8'),
      });
    },
  };
}

export default defineConfig({
  root: resolve(import.meta.dirname, 'src'),
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    rollupOptions: {
      input: {
        background: resolve(import.meta.dirname, 'src/background/service-worker.ts'),
        popup: resolve(import.meta.dirname, 'src/popup/popup.html'),
        options: resolve(import.meta.dirname, 'src/options/options.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  plugins: [copyManifest()],
});
```

- [ ] **Step 6: 创建 `vite.content.config.ts`（内容脚本，IIFE 单文件）**

内容脚本是经典脚本，不支持 ESM import，必须打成单文件 IIFE。

```ts
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome120',
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/index.ts'),
      formats: ['iife'],
      name: 'JinYiContent',
      fileName: () => 'content.js',
    },
  },
});
```

- [ ] **Step 7: 创建 `src/manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "浸译",
  "version": "0.1.0",
  "description": "沉浸式网页翻译：原文下方就地显示译文，支持免费引擎与自定义 OpenAI 兼容 API。",
  "permissions": ["storage", "activeTab", "scripting", "contextMenus"],
  "host_permissions": ["https://translate.googleapis.com/*"],
  "optional_host_permissions": ["http://*/*", "https://*/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup/popup.html", "default_title": "浸译" },
  "options_page": "options/options.html",
  "content_scripts": [
    {
      "matches": ["http://*/*", "https://*/*"],
      "js": ["content.js"],
      "run_at": "document_idle",
      "all_frames": false
    }
  ],
  "commands": {
    "toggle-translate": {
      "suggested_key": { "default": "Alt+T" },
      "description": "翻译/还原当前页面"
    }
  }
}
```

- [ ] **Step 8: 创建四个占位源文件**

`src/background/service-worker.ts`:
```ts
console.log('[浸译] service worker 已启动');
export {};
```

`src/content/index.ts`:
```ts
console.log('[浸译] content script 已注入');
export {};
```

`src/popup/popup.html`:
```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>浸译</title>
  </head>
  <body style="width: 320px; font-family: system-ui, sans-serif">
    <p>浸译 — 占位弹窗</p>
    <script type="module" src="./popup.ts"></script>
  </body>
</html>
```

`src/popup/popup.ts`:
```ts
console.log('[浸译] popup 已加载');
export {};
```

`src/options/options.html`:
```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>浸译 · 设置</title>
  </head>
  <body style="font-family: system-ui, sans-serif">
    <h1>浸译 设置</h1>
    <p>设置页将在 Plan 2 中实现。</p>
    <script type="module" src="./options.ts"></script>
  </body>
</html>
```

`src/options/options.ts`:
```ts
console.log('[浸译] options 已加载');
export {};
```

- [ ] **Step 9: 创建 `.gitignore`**

```
node_modules/
dist/
*.zip
.DS_Store
```

- [ ] **Step 10: 运行构建并核对产物**

Run: `npm run build`

Expected: 退出码 0；`dist/` 下存在 `manifest.json`、`background.js`、`content.js`、`popup/popup.html`、`options/options.html`。

Run: `Get-ChildItem -Recurse dist -File | Select-Object -ExpandProperty FullName`

若 `content.js` 缺失，说明第二个 Vite 配置未生效，检查 `vite.content.config.ts` 的 `lib.formats` 是否为 `['iife']`。

- [ ] **Step 11: 提交**

```bash
git add -A
git commit -m "chore: 搭建 MV3 扩展脚手架与双 Vite 构建管线"
```

---

## Task 2: `core/hash.ts` — 稳定哈希与缓存 key

**Files:**
- Create: `src/core/hash.ts`
- Test: `tests/core/hash.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/core/hash.test.ts
import { describe, expect, it } from 'vitest';
import { buildCacheKey, hashString } from '../../src/core/hash';

describe('hashString', () => {
  it('同样的输入得到同样的输出', () => {
    expect(hashString('hello world')).toBe(hashString('hello world'));
  });

  it('不同输入得到不同输出', () => {
    expect(hashString('hello')).not.toBe(hashString('hellp'));
  });

  it('能处理空字符串', () => {
    expect(hashString('')).toMatch(/^0-[0-9a-z]+-[0-9a-z]+$/);
  });

  it('能处理中文与 emoji', () => {
    expect(hashString('你好🌏')).toBe(hashString('你好🌏'));
    expect(hashString('你好🌏')).not.toBe(hashString('你好🌍'));
  });
});

describe('buildCacheKey', () => {
  const base = {
    engineId: 'google',
    targetLang: 'zh-Hans',
    glossaryHash: '',
    promptHash: '',
    text: 'Hello world',
  };

  it('同样的字段得到同样的 key', () => {
    expect(buildCacheKey(base)).toBe(buildCacheKey({ ...base }));
  });

  it('任一字段变化都会改变 key', () => {
    const key = buildCacheKey(base);
    expect(buildCacheKey({ ...base, text: 'Hello world!' })).not.toBe(key);
    expect(buildCacheKey({ ...base, engineId: 'openai-compat' })).not.toBe(key);
    expect(buildCacheKey({ ...base, targetLang: 'ja' })).not.toBe(key);
    expect(buildCacheKey({ ...base, glossaryHash: 'abc' })).not.toBe(key);
    expect(buildCacheKey({ ...base, promptHash: 'abc' })).not.toBe(key);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/hash.test.ts`

Expected: FAIL — 无法解析 `../../src/core/hash`。

- [ ] **Step 3: 写实现**

```ts
// src/core/hash.ts

/**
 * 32 位双通道哈希（FNV-1a + murmur 混合）。
 * 同步、无依赖，在 content script 与 service worker 中结果一致。
 */
export function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }
  return `${input.length.toString(36)}-${h1.toString(36)}-${h2.toString(36)}`;
}

export interface CacheKeyParts {
  engineId: string;
  targetLang: string;
  glossaryHash: string;
  promptHash: string;
  text: string;
}

/** 用 \u0000 分隔，避免字段拼接产生歧义（如 ("ab","c") 与 ("a","bc")）。 */
export function buildCacheKey(parts: CacheKeyParts): string {
  return hashString(
    [parts.engineId, parts.targetLang, parts.glossaryHash, parts.promptHash, parts.text].join('\u0000'),
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/hash.test.ts`

Expected: PASS，6 个用例全绿。

- [ ] **Step 5: 提交**

```bash
git add src/core/hash.ts tests/core/hash.test.ts
git commit -m "feat(core): 稳定哈希与缓存 key 组装"
```

---

## Task 3: `core/lang.ts` — 语种识别与跳过判定

**Files:**
- Create: `src/core/lang.ts`
- Test: `tests/core/lang.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/core/lang.test.ts
import { describe, expect, it } from 'vitest';
import { detectScript, isTranslatableText, normalizeText, shouldSkip } from '../../src/core/lang';

describe('detectScript', () => {
  it('识别纯中文', () => {
    expect(detectScript('这是一段中文')).toBe('zh');
  });

  it('含假名时判为日文（即使有汉字）', () => {
    expect(detectScript('日本語のテキストです')).toBe('ja');
  });

  it('识别韩文', () => {
    expect(detectScript('한국어 텍스트')).toBe('ko');
  });

  it('识别拉丁文', () => {
    expect(detectScript('Hello world')).toBe('latin');
  });

  it('中英混合按多数决', () => {
    expect(detectScript('Hello world 世界')).toBe('latin');
    expect(detectScript('你好世界 Hello')).toBe('zh');
  });

  it('短汉字段不敌长拉丁段', () => {
    expect(detectScript('aaaaa 你好')).toBe('latin');
    expect(detectScript('中文 abcde')).toBe('latin');
  });

  it('片段分同档时按先出现者判定', () => {
    expect(detectScript('Hi 你好')).toBe('latin');
    expect(detectScript('你好 Hi')).toBe('zh');
  });

  it('中文占多数时不因标点切碎而判成拉丁', () => {
    expect(detectScript('这是一段很长的中文内容需要翻译成英文。Hello world')).toBe('zh');
  });

  it('同一句里用句号还是空格分隔，不改变判定', () => {
    expect(detectScript('这是一段很长的中文内容需要翻译成英文 Hello world')).toBe(
      detectScript('这是一段很长的中文内容需要翻译成英文。Hello world'),
    );
    expect(detectScript('这是一段很长的中文内容需要翻译成英文 Hello world')).toBe('zh');
  });

  it('多段中文与多段拉丁总字数同档时按先出现者判定', () => {
    expect(detectScript('第一段中文。第二段中文。third party tools')).toBe('zh');
    expect(detectScript('first party tools 第一段中文。第二段中文。')).toBe('latin');
  });

  it('拉丁字母明显多于中文时仍判 latin（计数口径的边界）', () => {
    // 冻结断言 'Hello world 世界' → latin、'中文 abcde' → latin 已经钉死了这个方向：
    // 「出现中文就算中文」的规则会把它们打回原样。理由见留档 amendment §7。
    expect(detectScript('中文。English words here')).toBe('latin');
  });

  it('没有字母时返回 unknown', () => {
    expect(detectScript('123 --- !!!')).toBe('unknown');
  });
});

describe('normalizeText', () => {
  it('折叠空白并去首尾', () => {
    expect(normalizeText('  a\n\n  b\t c ')).toBe('a b c');
  });

  it('null 与 undefined 返回空串', () => {
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(undefined)).toBe('');
  });
});

describe('isTranslatableText', () => {
  it('正常句子可翻译', () => {
    expect(isTranslatableText('Hello world')).toBe(true);
  });

  it('单字符不可翻译', () => {
    expect(isTranslatableText('a')).toBe(false);
  });

  it('纯数字与纯标点不可翻译', () => {
    expect(isTranslatableText('12345')).toBe(false);
    expect(isTranslatableText('—— …… ！！！')).toBe(false);
  });

  it('少于两个字母不可翻译', () => {
    expect(isTranslatableText('3 个')).toBe(false);
  });
});

describe('shouldSkip', () => {
  it('目标中文时跳过中文段落', () => {
    expect(shouldSkip('这是一段中文', 'zh-Hans')).toBe(true);
  });

  it('目标中文时不跳过英文段落', () => {
    expect(shouldSkip('This is English', 'zh-Hans')).toBe(false);
  });

  it('目标中文时不跳过日文段落（含汉字但以假名为主）', () => {
    expect(shouldSkip('これはテストです', 'zh-Hans')).toBe(false);
  });

  it('目标英文时跳过英文段落', () => {
    expect(shouldSkip('This is English', 'en')).toBe(true);
  });

  it('目标日文时跳过日文段落', () => {
    expect(shouldSkip('これはテストです', 'ja')).toBe(true);
  });

  it('混排段落与目标语言同分时不跳过（低置信度偏保守）', () => {
    expect(shouldSkip('Hi 你好', 'zh-Hans')).toBe(false);
    expect(shouldSkip('你好 Hi', 'zh-Hans')).toBe(false);
    expect(shouldSkip('你好世界 Hello', 'zh-Hans')).toBe(false);
  });

  it('短汉字段不敌长拉丁段时不跳过', () => {
    expect(shouldSkip('aaaaa 你好', 'zh-Hans')).toBe(false);
  });

  it('中文段明显占优时仍然跳过', () => {
    expect(shouldSkip('这是一段较长的中文内容，Hello', 'zh-Hans')).toBe(true);
  });

  it('中文占多数被标点切碎的段落，目标为英文时不跳过', () => {
    expect(shouldSkip('这是一段很长的中文内容需要翻译成英文。Hello world', 'en')).toBe(false);
  });

  it('多段中文与多段拉丁总字数同档时不跳过', () => {
    expect(shouldSkip('第一段中文。第二段中文。third party tools', 'zh-Hans')).toBe(false);
    expect(shouldSkip('first party tools 第一段中文。第二段中文。', 'en')).toBe(false);
  });

  it('目标繁體中文时不跳过中文字段（简繁互转不走跳过快路径）', () => {
    expect(shouldSkip('这是简体中文', 'zh-Hant')).toBe(false);
    expect(shouldSkip('這是繁體中文', 'zh-Hant')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/lang.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/core/lang.ts
export interface LanguageOption {
  code: string;
  label: string;
}

export const LANGUAGES: LanguageOption[] = [
  { code: 'zh-Hans', label: '简体中文' },
  { code: 'zh-Hant', label: '繁體中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'ru', label: 'Русский' },
];

export type ScriptLang = 'zh' | 'ja' | 'ko' | 'ru' | 'ar' | 'latin' | 'unknown';

/**
 * 各字符集的码点区间。表内顺序只在「得分与首次出现位置都相同」时兜底，
 * 而一个字符只属于一个字符集，实际到不了这一步。
 */
const SCRIPT_RANGES: Array<[ScriptLang, ReadonlyArray<readonly [number, number]>]> = [
  ['ja', [[0x3040, 0x30ff]]],
  ['ko', [[0xac00, 0xd7af]]],
  ['zh', [[0x4e00, 0x9fff]]],
  ['ru', [[0x0400, 0x04ff]]],
  ['ar', [[0x0600, 0x06ff]]],
  ['latin', [[0x41, 0x5a], [0x61, 0x7a]]],
];

function scriptOf(codePoint: number): ScriptLang | undefined {
  for (const [lang, ranges] of SCRIPT_RANGES) {
    for (const [from, to] of ranges) {
      if (codePoint >= from && codePoint <= to) return lang;
    }
  }
  return undefined;
}

interface ScriptStat {
  /** 该字符集的字符总数 */
  chars: number;
  /** 该字符集第一个字符的下标 */
  firstAt: number;
}

/**
 * 单遍扫描文本，统计每个字符集的**字符总数**，而不是「连续片段」的得分。
 * 按片段计分会让结论取决于标点与空格怎么切：拉丁文天然被空格切成多段
 * （'Hello world' 就是 2 段），中文一句话通常只有 1 段，于是同一段文本里
 * 中文按 1 段拿分、拉丁按好几段拿分。实测
 * '这是一段很长的中文内容需要翻译成英文。Hello world'（中文 18 字 / 拉丁 10 字母）
 * 被判成 latin，目标为英文时整段跳过，18 个汉字永远不翻。
 * 改成按字符总数分档后，标点切不切碎片段不再影响分数，只影响同档时的先出现者判定。
 */
function scoreScripts(text: string): Map<ScriptLang, ScriptStat> {
  const stats = new Map<ScriptLang, ScriptStat>();
  let offset = 0;

  for (const char of text) {
    const lang = scriptOf(char.codePointAt(0) ?? 0);
    if (lang !== undefined) {
      const stat = stats.get(lang);
      if (stat === undefined) stats.set(lang, { chars: 1, firstAt: offset });
      else stat.chars += 1;
    }
    offset += char.length;
  }

  return stats;
}

/**
 * 字符数分档：每翻一倍才多一分（不取精确 log2）。
 * 分档是为了让 4 与 5 个字符同档，保住 '你好世界 Hello'
 * （中文 4 字 / 拉丁 5 字母）判为 zh 的既有断言。
 */
function bandOf(chars: number): number {
  return 1 + Math.floor(Math.log2(chars));
}

interface ScriptPick {
  lang: ScriptLang;
  /** 是否有其它字符集与最高分持平（低置信度） */
  tied: boolean;
}

/** 取分最高的字符集；同分时先出现者优先，不依赖 SCRIPT_RANGES 的表序。 */
function pickScript(text: string): ScriptPick {
  const stats = scoreScripts(text);
  let lang: ScriptLang = 'unknown';
  let score = 0;
  let firstAt = Number.POSITIVE_INFINITY;
  let tied = false;

  for (const [candidate] of SCRIPT_RANGES) {
    const stat = stats.get(candidate);
    if (stat === undefined) continue;
    const candidateScore = bandOf(stat.chars);
    if (candidateScore > score || (candidateScore === score && stat.firstAt < firstAt)) {
      // 换人时若分数相同，被换下的那个仍然与新的最高分持平。
      tied = candidateScore === score;
      lang = candidate;
      score = candidateScore;
      firstAt = stat.firstAt;
    } else if (candidateScore === score) {
      tied = true;
    }
  }

  return { lang, tied };
}

export function detectScript(text: string): ScriptLang {
  return pickScript(text).lang;
}

export function normalizeText(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

const LETTER = /\p{L}/gu;

/** 至少两个字母才算值得翻译的文本，挡掉价格、页码、纯标点这类噪声。 */
export function isTranslatableText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  return (trimmed.match(LETTER)?.length ?? 0) >= 2;
}

function baseLang(code: string): string {
  return code.split('-')[0].toLowerCase();
}

const TARGET_SCRIPT: Record<string, ScriptLang> = {
  zh: 'zh',
  ja: 'ja',
  ko: 'ko',
  ru: 'ru',
  ar: 'ar',
  en: 'latin',
  fr: 'latin',
  de: 'latin',
  es: 'latin',
};

/**
 * 显式指定繁体（Hant）脚本的目标语言。
 * ScriptLang 只到字符集一级（zh-Hant 与 zh-Hans 都是 'zh'），分辨不了简繁：
 * 选繁體中文时简体段落会被判成「已是目标语言」而整段跳过，简繁互转直接变成 no-op。
 * 这类目标一律不做跳过判定——跳过等于放弃翻译，宁可多翻一遍交给引擎转换。
 */
const HANT_TARGET = /^zh-hant(?:-|$)/;

/**
 * 段落已经是指定目标语言时无需翻译。
 * 只有目标字符集严格领先才跳过：与其它字符集同分时宁可翻译——
 * 跳过等于放弃翻译，错一边就是漏翻（'Hi 你好' 这类极短混排任何多数决都不可靠）。
 */
export function shouldSkip(text: string, targetLang: string): boolean {
  const code = targetLang.toLowerCase();
  if (HANT_TARGET.test(code)) return false;
  const expected = TARGET_SCRIPT[baseLang(code)];
  if (!expected) return false;
  const pick = pickScript(text);
  return pick.lang === expected && !pick.tied;
}
```

> 实现备注（口径的由来、候选对比与被否掉的口径见 `docs/superpowers/plans/2026-09-14-wu2-plan-amendment.md` §5、§7）：
> `detectScript` 按各字符集**字符总数**分档取最高者，档位是 `1 + floor(log2(字数))`，
> 不是按「连续片段」计分：拉丁文天然被空格切成多段、中文一句话通常只有 1 段，
> 按片段计分会让结论取决于标点怎么切。实测 `'这是一段很长的中文内容需要翻译成英文。Hello world'`
> （中文 18 字 / 拉丁 10 字母）被判成 `latin`，目标为英文时整段跳过，18 个汉字一个不翻。
> 同分时先出现者优先，不依赖 `SCRIPT_RANGES` 的表序。
> 因此 `'你好世界 Hello'`（中文 4 字与拉丁 5 字母同档同分）判为 `zh`，
> 而 `'aaaaa 你好'`（拉丁字数是中文的两倍以上，跨档）正确判为 `latin`。
> `shouldSkip` 只在目标字符集**严格领先**时返回 `true`：与其它字符集同分的混排段落
> （`'Hi 你好'`、`'你好 Hi'`）按低置信度处理，宁可不跳过——跳过等于放弃翻译，错一边就是漏翻。
> 目标为 `zh-Hant` 时一律不跳过：`ScriptLang` 只到字符集一级、分辨不了简繁，
> 否则简体段落会被判成「已是目标语言」，简繁互转静默失效。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/lang.test.ts`

Expected: PASS，全部用例通过。

- [ ] **Step 5: 提交**

```bash
git add src/core/lang.ts tests/core/lang.test.ts
git commit -m "feat(core): 语种脚本识别与跳过判定"
```

---

## Task 4: `core/segmenter.ts` — 批次合并与句子切分

**Files:**
- Create: `src/core/segmenter.ts`
- Test: `tests/core/segmenter.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/core/segmenter.test.ts
import { describe, expect, it } from 'vitest';
import { joinPieces, planBatches, splitBySentence, type TextSegment } from '../../src/core/segmenter';

function seg(id: string, text: string, order = 0): TextSegment {
  return { id, text, order };
}

const OPTIONS = { maxBatchChars: 100, maxSegmentsPerBatch: 3 };

describe('planBatches', () => {
  it('空输入返回空批次', () => {
    expect(planBatches([], OPTIONS)).toEqual([]);
  });

  it('相邻短段合并为一批', () => {
    const batches = planBatches([seg('a', 'x'.repeat(10)), seg('b', 'x'.repeat(10))], OPTIONS);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('超过字符上限时切批', () => {
    const batches = planBatches(
      [seg('a', 'x'.repeat(60)), seg('b', 'x'.repeat(60))],
      OPTIONS,
    );
    expect(batches.map((b) => b.map((s) => s.id))).toEqual([['a'], ['b']]);
  });

  it('预算计入每段的编号包装开销', () => {
    const batches = planBatches(
      [seg('a', 'x'.repeat(45)), seg('b', 'x'.repeat(45))],
      OPTIONS,
    );
    expect(batches.map((b) => b.map((s) => s.id))).toEqual([['a'], ['b']]);
  });

  it('超过段数上限时切批', () => {
    const batches = planBatches(
      [seg('a', 'x'), seg('b', 'x'), seg('c', 'x'), seg('d', 'x')],
      OPTIONS,
    );
    expect(batches.map((b) => b.map((s) => s.id))).toEqual([['a', 'b', 'c'], ['d']]);
  });

  it('超长段独占一批，不与前后合并', () => {
    const batches = planBatches(
      [seg('a', 'x'.repeat(10)), seg('long', 'x'.repeat(200)), seg('b', 'x'.repeat(10))],
      OPTIONS,
    );
    expect(batches.map((b) => b.map((s) => s.id))).toEqual([['a'], ['long'], ['b']]);
  });

  it('保持原始顺序', () => {
    const batches = planBatches(
      [seg('a', 'x'.repeat(60)), seg('b', 'x'.repeat(10)), seg('c', 'x'.repeat(60))],
      OPTIONS,
    );
    expect(batches.flat().map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('splitBySentence', () => {
  it('短文本不切分', () => {
    expect(splitBySentence('Hello world.', 100)).toEqual(['Hello world.']);
  });

  it('中文按句号切分', () => {
    expect(splitBySentence('第一句。第二句。第三句。', 6)).toEqual(['第一句。', '第二句。', '第三句。']);
  });

  it('英文按句末标点切分', () => {
    expect(splitBySentence('One. Two. Three.', 8)).toEqual(['One. ', 'Two. ', 'Three.']);
  });

  it('没有句子边界时硬切', () => {
    const pieces = splitBySentence('x'.repeat(25), 10);
    expect(pieces).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('切分后不丢字符', () => {
    const text = '第一句。第二句。第三句。第四句。';
    expect(splitBySentence(text, 5).join('')).toBe(text);
  });

  it('maxLen 非法时报错而不是死循环', () => {
    expect(() => splitBySentence('abc', 0)).toThrow(RangeError);
    expect(() => splitBySentence('abc', -1)).toThrow(RangeError);
    expect(() => splitBySentence('abc', Number.NaN)).toThrow(RangeError);
    expect(() => splitBySentence('abc', Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('joinPieces', () => {
  it('中文目标语言直接拼接', () => {
    expect(joinPieces(['第一句。', '第二句。'], 'zh-Hans')).toBe('第一句。第二句。');
  });

  it('英文目标语言用空格拼接', () => {
    expect(joinPieces(['One.', 'Two.'], 'en')).toBe('One. Two.');
  });

  it('忽略空白片段', () => {
    expect(joinPieces(['One.', '   ', ''], 'en')).toBe('One.');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/segmenter.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/core/segmenter.ts
export interface TextSegment {
  id: string;
  text: string;
  order: number;
}

export interface BatchOptions {
  /** 一批内所有段落的总字符上限（含每段的编号包装开销） */
  maxBatchChars: number;
  /** 一批内最多几段，避免一次塞进几十个碎句 */
  maxSegmentsPerBatch: number;
}

/**
 * 每段在真实载荷里除正文外还要多出编号包装（`<<<n>>>` 与数组分隔符）的固定开销，
 * 预算按「正文 + 开销」计，避免贴边的批次真实长度越过上限。
 */
const PER_SEGMENT_OVERHEAD = 8;

/**
 * 按 DOM 顺序把相邻段落合并成批次。
 * 单段自身超过 maxBatchChars 时独占一批——正常路径不做段内切分，
 * 段内切分只发生在引擎报"文本过长"的降级路径
 * （见 units/wu3，待建的 src/background/scheduler.ts）。
 */
export function planBatches(segments: TextSegment[], options: BatchOptions): TextSegment[][] {
  const batches: TextSegment[][] = [];
  let current: TextSegment[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
  };

  for (const segment of segments) {
    const cost = segment.text.length + PER_SEGMENT_OVERHEAD;
    if (cost > options.maxBatchChars) {
      flush();
      batches.push([segment]);
      continue;
    }
    const wouldExceedChars = currentChars + cost > options.maxBatchChars;
    const wouldExceedCount = current.length >= options.maxSegmentsPerBatch;
    if (current.length > 0 && (wouldExceedChars || wouldExceedCount)) flush();
    current.push(segment);
    currentChars += cost;
  }
  flush();
  return batches;
}

/**
 * 句末标点连同其后的空白一起归属前一片段（'One. Two.' → 'One. ' + 'Two.'）。
 * 每次现取一个新实例：带 g 的正则自带可变 lastIndex，
 * 模块级共享会让「切分结果」取决于调用点有没有记得重置它。
 */
function sentenceBoundary(): RegExp {
  return /[。！？；!?;]\s*|\.(?=\s|$)\s*/g;
}

/**
 * 把超长文本按句子边界切成不超过 maxLen 的片段。
 * 单句本身超过 maxLen 时硬切，保证输出片段一定不超限。
 * maxLen 必须是不小于 1 的有限数，否则窗口无法推进（死循环 + 无限切片）。
 */
export function splitBySentence(text: string, maxLen: number): string[] {
  if (!Number.isFinite(maxLen) || maxLen < 1) {
    throw new RangeError(`splitBySentence 的 maxLen 必须是不小于 1 的有限数，收到 ${String(maxLen)}`);
  }
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    const chunk = rest.slice(0, maxLen);
    const boundary = sentenceBoundary();
    let cut = -1;
    let match = boundary.exec(chunk);
    while (match !== null) {
      cut = match.index + match[0].length;
      match = boundary.exec(chunk);
    }
    if (cut <= 0) cut = maxLen;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

const CJK_TARGET = /^(zh|ja|ko)/;

/** 把降级切分后分别翻译的片段拼回一段。中文不加空格，英文加。 */
export function joinPieces(pieces: string[], targetLang: string): string {
  const separator = CJK_TARGET.test(targetLang) ? '' : ' ';
  return pieces
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .join(separator);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/segmenter.test.ts`

Expected: PASS，全部用例通过。

- [ ] **Step 5: 提交**

```bash
git add src/core/segmenter.ts tests/core/segmenter.test.ts
git commit -m "feat(core): 批次合并与超长文本按句切分"
```

---

## Task 5: `core/pool.ts` — 并发池

**Files:**
- Create: `src/core/pool.ts`
- Test: `tests/core/pool.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/core/pool.test.ts
import { describe, expect, it } from 'vitest';
import { runPool } from '../../src/core/pool';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('runPool', () => {
  it('空任务返回空数组', async () => {
    expect(await runPool([], 3)).toEqual([]);
  });

  it('结果顺序与任务顺序一致', async () => {
    const tasks = [
      async () => 'a',
      async () => 'b',
      async () => 'c',
    ];
    expect(await runPool(tasks, 1)).toEqual(['a', 'b', 'c']);
  });

  it('并发数不超过上限', async () => {
    let running = 0;
    let peak = 0;
    const gate = deferred<void>();
    const tasks = Array.from({ length: 6 }, () => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
      return 'ok';
    });
    const pending = runPool(tasks, 2);
    await Promise.resolve();
    expect(peak).toBeLessThanOrEqual(2);
    gate.resolve();
    expect(await pending).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  });

  it('并发上限大于任务数时也能跑完', async () => {
    const tasks = [async () => 1, async () => 2];
    expect(await runPool(tasks, 10)).toEqual([1, 2]);
  });

  it('limit 不是不小于 1 的有限数时报错而不是返回空洞结果', async () => {
    const tasks = [async () => 'a'];
    await expect(runPool(tasks, Number.NaN)).rejects.toThrow(RangeError);
    await expect(runPool(tasks, 0)).rejects.toThrow(RangeError);
    await expect(runPool(tasks, -1)).rejects.toThrow(RangeError);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/pool.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/core/pool.ts
/**
 * 以最多 limit 个并发执行任务，返回结果数组，顺序与 tasks 一致。
 * 任务自身的异常会向上抛出（调用方负责在任务内部捕获）。
 * limit 必须是「不小于 1 的有限数」：NaN 会算出 0 个 worker，
 * 静默返回一个全是 undefined 的数组，所以入口直接报错。
 */
export async function runPool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  if (!Number.isFinite(limit) || limit < 1) {
    throw new RangeError(`runPool 的 limit 必须是不小于 1 的有限数，收到 ${String(limit)}`);
  }

  const results: T[] = new Array(tasks.length);
  if (tasks.length === 0) return results;

  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/pool.test.ts`

Expected: PASS，4 个用例通过。

- [ ] **Step 5: 提交**

```bash
git add src/core/pool.ts tests/core/pool.test.ts
git commit -m "feat(core): 并发池"
```

---

## Task 6: `engines/types.ts` — 引擎接口与错误类型

**Files:**
- Create: `src/engines/types.ts`
- Test: `tests/engines/types.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/engines/types.test.ts
import { describe, expect, it } from 'vitest';
import { EngineError, toEngineError } from '../../src/engines/types';

describe('EngineError', () => {
  it('网络错误与限流可重试', () => {
    expect(new EngineError('NETWORK', 'x').retryable).toBe(true);
    expect(new EngineError('RATE_LIMIT', 'x').retryable).toBe(true);
  });

  it('鉴权失败与格式错误不可重试', () => {
    expect(new EngineError('AUTH', 'x').retryable).toBe(false);
    expect(new EngineError('BAD_RESPONSE', 'x').retryable).toBe(false);
  });

  it('保留错误码与消息', () => {
    const err = new EngineError('AUTH', '缺少 API Key');
    expect(err.code).toBe('AUTH');
    expect(err.message).toBe('缺少 API Key');
    expect(err.name).toBe('EngineError');
  });
});

describe('toEngineError', () => {
  it('EngineError 原样返回', () => {
    const err = new EngineError('AUTH', 'x');
    expect(toEngineError(err)).toBe(err);
  });

  it('AbortError 转成 ABORTED', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(toEngineError(abort).code).toBe('ABORTED');
  });

  it('未知错误转成 UNKNOWN 并保留消息', () => {
    const err = toEngineError(new Error('boom'));
    expect(err.code).toBe('UNKNOWN');
    expect(err.message).toBe('boom');
  });

  it('保留原始错误为 cause', () => {
    const raw = new TypeError('boom');
    expect(toEngineError(raw).cause).toBe(raw);

    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(toEngineError(abort).cause).toBe(abort);
  });

  it('非 Error 值也能处理', () => {
    expect(toEngineError('oops').code).toBe('UNKNOWN');
    expect(toEngineError('oops').message).toBe('oops');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/engines/types.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/engines/types.ts

export interface Term {
  from: string;
  to: string;
}

export interface TranslateRequest {
  texts: string[];
  from: string;
  to: string;
  glossary?: Term[];
  systemPrompt?: string;
  signal: AbortSignal;
}

export interface EngineConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export type EngineErrorCode =
  | 'NETWORK'
  | 'RATE_LIMIT'
  | 'AUTH'
  | 'TOO_LONG'
  | 'BAD_RESPONSE'
  | 'ABORTED'
  | 'UNKNOWN';

const RETRYABLE: ReadonlySet<EngineErrorCode> = new Set<EngineErrorCode>([
  'NETWORK',
  'RATE_LIMIT',
  'TOO_LONG',
]);

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly retryable: boolean;

  constructor(code: EngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EngineError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
  }
}

export function toEngineError(raw: unknown): EngineError {
  if (raw instanceof EngineError) return raw;
  if (raw instanceof Error) {
    // 保留原始错误：fetch 失败带的 cause、超时属性等要靠它才能追查。
    const options: ErrorOptions = { cause: raw };
    if (raw.name === 'AbortError') return new EngineError('ABORTED', '请求已取消', options);
    return new EngineError('UNKNOWN', raw.message, options);
  }
  return new EngineError('UNKNOWN', String(raw));
}

export interface Translator {
  id: string;
  name: string;
  /** 需要 API Key 的引擎为 true，弹窗据此显示红色状态点 */
  needsKey: boolean;
  /** 是否支持 system prompt；为 false 时术语表与自定义提示词不生效 */
  supportsGlossary: boolean;
  translate(request: TranslateRequest, config: EngineConfig): Promise<string[]>;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/engines/types.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/engines/types.ts tests/engines/types.test.ts
git commit -m "feat(engines): 引擎接口与错误类型"
```

---

## Task 7: `engines/google.ts` — 免费 Google 接口

**Files:**
- Create: `src/engines/google.ts`
- Test: `tests/engines/google.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/engines/google.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { googleEngine, parseGoogleResponse, toGoogleLang } from '../../src/engines/google';
import { EngineError } from '../../src/engines/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Google 免费接口的真实返回结构：[[[译文, 原文, ...], ...], null, "en", ...] */
function googleBody(translations: string[]): unknown {
  return [[translations.map((t) => [t, 'source', null, null, 10]), null, 'en']];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toGoogleLang', () => {
  it('把 zh-Hans 映射为 zh-CN', () => {
    expect(toGoogleLang('zh-Hans')).toBe('zh-CN');
  });

  it('把 zh-Hant 映射为 zh-TW', () => {
    expect(toGoogleLang('zh-Hant')).toBe('zh-TW');
  });

  it('其它语言原样透传', () => {
    expect(toGoogleLang('ja')).toBe('ja');
  });
});

describe('parseGoogleResponse', () => {
  it('拼接多个分句', () => {
    expect(parseGoogleResponse(googleBody(['你好', '世界']))).toBe('你好世界');
  });

  it('结构异常时抛 BAD_RESPONSE', () => {
    expect(() => parseGoogleResponse({})).toThrow(EngineError);
    try {
      parseGoogleResponse({});
    } catch (err) {
      expect((err as EngineError).code).toBe('BAD_RESPONSE');
    }
  });

  it('译文为空时抛 BAD_RESPONSE', () => {
    try {
      parseGoogleResponse([[], null, 'en']);
      throw new Error('本应抛错');
    } catch (err) {
      expect((err as EngineError).code).toBe('BAD_RESPONSE');
    }
  });
});

describe('googleEngine.translate', () => {
  it('逐条请求并保持顺序', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(googleBody(['甲'])))
      .mockResolvedValueOnce(jsonResponse(googleBody(['乙'])));
    vi.stubGlobal('fetch', fetchMock);

    const out = await googleEngine.translate(
      { texts: ['A', 'B'], from: 'auto', to: 'zh-Hans', signal: new AbortController().signal },
      {},
    );

    expect(out).toEqual(['甲', '乙']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('tl=zh-CN');
  });

  it('429 抛 RATE_LIMIT', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 429)));
    await expect(
      googleEngine.translate(
        { texts: ['A'], from: 'auto', to: 'zh-Hans', signal: new AbortController().signal },
        {},
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMIT' });
  });

  it('403 抛 AUTH', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 403)));
    await expect(
      googleEngine.translate(
        { texts: ['A'], from: 'auto', to: 'zh-Hans', signal: new AbortController().signal },
        {},
      ),
    ).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('网络异常抛 NETWORK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')));
    await expect(
      googleEngine.translate(
        { texts: ['A'], from: 'auto', to: 'zh-Hans', signal: new AbortController().signal },
        {},
      ),
    ).rejects.toMatchObject({ code: 'NETWORK' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/engines/google.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/engines/google.ts
import { EngineError, toEngineError, type EngineConfig, type TranslateRequest, type Translator } from './types';

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

/** Google 用 zh-CN / zh-TW，其余语言代码与 BCP-47 主标签一致。 */
export function toGoogleLang(code: string): string {
  if (code === 'zh-Hans') return 'zh-CN';
  if (code === 'zh-Hant') return 'zh-TW';
  return code;
}

/**
 * 免费接口返回 [[[译文片段, 原文片段, ...], ...], null, 源语言, ...]。
 * 所有片段首尾相接才是完整译文。
 */
export function parseGoogleResponse(data: unknown): string {
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new EngineError('BAD_RESPONSE', '免费接口返回格式异常');
  }
  const parts: string[] = [];
  for (const chunk of data[0] as unknown[]) {
    if (Array.isArray(chunk) && typeof chunk[0] === 'string') parts.push(chunk[0]);
  }
  const text = parts.join('');
  if (text.length === 0) throw new EngineError('BAD_RESPONSE', '免费接口返回空译文');
  return text;
}

export async function translateOne(text: string, to: string, signal: AbortSignal): Promise<string> {
  const url =
    `${ENDPOINT}?client=gtx&sl=auto&dt=t` +
    `&tl=${encodeURIComponent(toGoogleLang(to))}` +
    `&q=${encodeURIComponent(text)}`;

  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (raw) {
    if (signal.aborted) throw new EngineError('ABORTED', '请求已取消');
    const err = toEngineError(raw);
    throw new EngineError('NETWORK', `免费接口请求失败：${err.message}`);
  }

  if (response.status === 429) throw new EngineError('RATE_LIMIT', '免费接口触发限流，请稍后重试或切换到自定义 API');
  if (response.status === 401 || response.status === 403) throw new EngineError('AUTH', '免费接口拒绝访问，请切换到自定义 API');
  if (response.status === 413) throw new EngineError('TOO_LONG', '文本过长');
  if (!response.ok) throw new EngineError('NETWORK', `免费接口 HTTP ${response.status}`);

  return parseGoogleResponse(await response.json());
}

export const googleEngine: Translator = {
  id: 'google',
  name: 'Google 免费接口',
  needsKey: false,
  supportsGlossary: false,
  async translate(request: TranslateRequest, _config: EngineConfig): Promise<string[]> {
    // 免费接口不支持一次请求多条文本，逐条并发发出。
    return Promise.all(request.texts.map((text) => translateOne(text, request.to, request.signal)));
  },
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/engines/google.test.ts`

Expected: PASS，全部用例通过。

- [ ] **Step 5: 提交**

```bash
git add src/engines/google.ts tests/engines/google.test.ts
git commit -m "feat(engines): 免费 Google 翻译接口"
```

---

## Task 8: `engines/openai-compat.ts` — OpenAI 兼容接口

**Files:**
- Create: `src/engines/openai-compat.ts`
- Test: `tests/engines/openai-compat.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/engines/openai-compat.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMessages, openAiCompatEngine, parseNumberedResponse } from '../../src/engines/openai-compat';
import { EngineError } from '../../src/engines/types';

function chatResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const CONFIG = { apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', model: 'test-model' };

function request(texts: string[]) {
  return { texts, from: 'auto', to: 'zh-Hans', signal: new AbortController().signal };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildMessages', () => {
  it('生成 system 与 user 两条消息', () => {
    const messages = buildMessages(['Hello', 'World'], 'zh-Hans');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('user 消息带编号标记', () => {
    const messages = buildMessages(['Hello', 'World'], 'zh-Hans');
    expect(messages[1].content).toContain('<<<1>>>');
    expect(messages[1].content).toContain('<<<2>>>');
  });

  it('术语表写进 system 消息', () => {
    const messages = buildMessages(['Hello'], 'zh-Hans', [{ from: 'DSH', to: 'DeepSeek Harness' }]);
    expect(messages[0].content).toContain('DSH => DeepSeek Harness');
  });

  it('自定义提示词写进 system 消息', () => {
    const messages = buildMessages(['Hello'], 'zh-Hans', undefined, '保持技术术语不译');
    expect(messages[0].content).toContain('保持技术术语不译');
  });
});

describe('parseNumberedResponse', () => {
  it('按编号切回多条译文', () => {
    const content = '<<<1>>>\n你好\n<<<2>>>\n世界';
    expect(parseNumberedResponse(content, 2)).toEqual(['你好', '世界']);
  });

  it('编号数量不符抛 BAD_RESPONSE', () => {
    expect(() => parseNumberedResponse('<<<1>>>\n你好', 2)).toThrow(EngineError);
  });

  it('编号顺序错乱抛 BAD_RESPONSE', () => {
    expect(() => parseNumberedResponse('<<<2>>>\n乙\n<<<1>>>\n甲', 2)).toThrow(EngineError);
  });

  it('单条时也能解析', () => {
    expect(parseNumberedResponse('<<<1>>>\n你好', 1)).toEqual(['你好']);
  });
});

describe('openAiCompatEngine.translate', () => {
  it('缺少配置时抛 AUTH', async () => {
    await expect(
      openAiCompatEngine.translate(request(['A']), { apiKey: '', baseUrl: '', model: '' }),
    ).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('成功解析编号响应', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好\n<<<2>>>\n世界'));
    vi.stubGlobal('fetch', fetchMock);
    const out = await openAiCompatEngine.translate(request(['Hello', 'World']), CONFIG);
    expect(out).toEqual(['你好', '世界']);
  });

  it('请求体使用配置的模型且 temperature 为 0', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好'));
    vi.stubGlobal('fetch', fetchMock);
    await openAiCompatEngine.translate(request(['Hello']), CONFIG);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.model).toBe('test-model');
    expect(body.temperature).toBe(0);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.example.com/v1/chat/completions');
  });

  it('baseUrl 末尾斜杠不会产生双斜杠', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好'));
    vi.stubGlobal('fetch', fetchMock);
    await openAiCompatEngine.translate(request(['Hello']), { ...CONFIG, baseUrl: 'https://api.example.com/v1/' });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.example.com/v1/chat/completions');
  });

  it('401 抛 AUTH', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse('', 401)));
    await expect(openAiCompatEngine.translate(request(['A']), CONFIG)).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('429 抛 RATE_LIMIT', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse('', 429)));
    await expect(openAiCompatEngine.translate(request(['A']), CONFIG)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
  });

  it('响应缺少 content 抛 BAD_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 })));
    await expect(openAiCompatEngine.translate(request(['A']), CONFIG)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/engines/openai-compat.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/engines/openai-compat.ts
import { EngineError, toEngineError, type EngineConfig, type Term, type TranslateRequest, type Translator } from './types';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

const marker = (index: number): string => `<<<${index}>>>`;

const SYSTEM_RULES = [
  'You are a professional translation engine.',
  'You will receive numbered segments. Translate every segment into the target language.',
  'Output ONLY the translations, using exactly the same numbered markers and the same number of segments.',
  'Never merge, split, reorder or omit segments. Never add explanations, notes or quotes.',
].join(' ');

export function buildMessages(texts: string[], to: string, glossary?: Term[], systemPrompt?: string): ChatMessage[] {
  const systemParts = [`Target language: ${to}`, SYSTEM_RULES];
  if (glossary && glossary.length > 0) {
    systemParts.push(`Glossary (must be used exactly): ${glossary.map((t) => `${t.from} => ${t.to}`).join('; ')}`);
  }
  if (systemPrompt && systemPrompt.trim().length > 0) systemParts.push(systemPrompt.trim());

  const user = texts.map((text, index) => `${marker(index + 1)}\n${text}`).join('\n');
  return [
    { role: 'system', content: systemParts.join('\n') },
    { role: 'user', content: user },
  ];
}

/** 按编号标记切回逐条译文；数量或顺序不符一律抛 BAD_RESPONSE，由上层降级为逐条翻译。 */
export function parseNumberedResponse(content: string, count: number): string[] {
  const matches = [...content.matchAll(/<<<(\d+)>>>/g)];
  if (matches.length !== count) {
    throw new EngineError('BAD_RESPONSE', `模型返回 ${matches.length} 段，期望 ${count} 段`);
  }
  const parts: string[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    if (Number(matches[i][1]) !== i + 1) {
      throw new EngineError('BAD_RESPONSE', '模型返回的分段编号顺序错乱');
    }
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? content.length) : content.length;
    parts.push(content.slice(start, end).trim());
  }
  return parts;
}

export const openAiCompatEngine: Translator = {
  id: 'openai-compat',
  name: 'OpenAI 兼容 API',
  needsKey: true,
  supportsGlossary: true,

  async translate(request: TranslateRequest, config: EngineConfig): Promise<string[]> {
    const apiKey = (config.apiKey ?? '').trim();
    const baseUrl = (config.baseUrl ?? '').trim();
    const model = (config.model ?? '').trim();
    if (!apiKey) throw new EngineError('AUTH', '尚未填写 API Key，请在设置中配置');
    if (!baseUrl) throw new EngineError('AUTH', '尚未填写接口地址，请在设置中配置');
    if (!model) throw new EngineError('AUTH', '尚未填写模型名，请在设置中配置');

    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body = {
      model,
      temperature: 0,
      messages: buildMessages(request.texts, request.to, request.glossary, request.systemPrompt),
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (raw) {
      if (request.signal.aborted) throw new EngineError('ABORTED', '请求已取消');
      throw new EngineError('NETWORK', `接口请求失败：${toEngineError(raw).message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new EngineError('AUTH', 'API Key 无效或权限不足，请检查设置');
    }
    if (response.status === 429) throw new EngineError('RATE_LIMIT', '接口限流，请稍后重试');
    if (response.status === 413) throw new EngineError('TOO_LONG', '文本过长');
    if (!response.ok) throw new EngineError('NETWORK', `接口 HTTP ${response.status}`);

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new EngineError('BAD_RESPONSE', '接口返回内容为空');
    }
    return parseNumberedResponse(content, request.texts.length);
  },
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/engines/openai-compat.test.ts`

Expected: PASS，全部用例通过。

- [ ] **Step 5: 提交**

```bash
git add src/engines/openai-compat.ts tests/engines/openai-compat.test.ts
git commit -m "feat(engines): OpenAI 兼容接口与编号分段协议"
```

---

## Task 9: `engines/registry.ts` — 引擎注册表

**Files:**
- Create: `src/engines/registry.ts`
- Test: `tests/engines/registry.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/engines/registry.test.ts
import { describe, expect, it } from 'vitest';
import { ENGINES, getEngine } from '../../src/engines/registry';

describe('getEngine', () => {
  it('按 id 取到引擎', () => {
    expect(getEngine('openai-compat').id).toBe('openai-compat');
  });

  it('未知 id 回退到默认免费引擎', () => {
    expect(getEngine('不存在的引擎').id).toBe('google');
  });

  it('注册表包含免费引擎与自定义引擎', () => {
    expect(ENGINES.map((e) => e.id).sort()).toEqual(['google', 'openai-compat']);
  });

  it('免费引擎不需要 Key，自定义引擎需要', () => {
    expect(getEngine('google').needsKey).toBe(false);
    expect(getEngine('openai-compat').needsKey).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/engines/registry.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/engines/registry.ts
import { googleEngine } from './google';
import { openAiCompatEngine } from './openai-compat';
import type { Translator } from './types';

export const ENGINES: readonly Translator[] = [googleEngine, openAiCompatEngine];

export const DEFAULT_ENGINE_ID = googleEngine.id;

/** 未知 id 一律回退到默认引擎，避免设置里存了废弃 id 时整个插件不可用。 */
export function getEngine(id: string): Translator {
  return ENGINES.find((engine) => engine.id === id) ?? googleEngine;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/engines/registry.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/engines/registry.ts tests/engines/registry.test.ts
git commit -m "feat(engines): 引擎注册表"
```

---

## Task 10: `core/cache.ts` — 两级翻译缓存

**Files:**
- Create: `src/core/cache.ts`
- Create: `tests/helpers/memory-storage.ts`
- Test: `tests/core/cache.test.ts`

- [ ] **Step 1: 写内存存储测试替身**

```ts
// tests/helpers/memory-storage.ts
import type { StorageArea } from '../../src/core/cache';

export class MemoryStorage implements StorageArea {
  private readonly data = new Map<string, unknown>();
  /** 记录写入次数，用于断言缓存命中时没有多余写入 */
  setCalls = 0;

  async get(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (this.data.has(key)) out[key] = structuredClone(this.data.get(key));
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.setCalls += 1;
    for (const [key, value] of Object.entries(items)) {
      this.data.set(key, structuredClone(value));
    }
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) this.data.delete(key);
  }

  size(): number {
    return this.data.size;
  }

  has(key: string): boolean {
    return this.data.has(key);
  }
}
```

- [ ] **Step 2: 写失败的测试**

```ts
// tests/core/cache.test.ts
import { describe, expect, it } from 'vitest';
import { TieredCache, TranslationCache } from '../../src/core/cache';
import { MemoryStorage } from '../helpers/memory-storage';

describe('TranslationCache', () => {
  it('写入后能读回', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    await cache.putMany(new Map([['h1', '你好']]));
    const hit = await cache.getMany(['h1']);
    expect(hit.get('h1')).toBe('你好');
  });

  it('未命中的 key 不出现在结果里', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    const hit = await cache.getMany(['missing']);
    expect(hit.size).toBe(0);
  });

  it('空输入不产生写入', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage);
    await cache.getMany([]);
    await cache.putMany(new Map());
    expect(storage.setCalls).toBe(0);
  });

  it('超过上限时淘汰最旧的条目', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 2);
    await cache.putMany(new Map([['a', '1']]));
    await cache.putMany(new Map([['b', '2']]));
    await cache.putMany(new Map([['c', '3']]));

    const hit = await cache.getMany(['a', 'b', 'c']);
    expect(hit.has('a')).toBe(false);
    expect(hit.get('b')).toBe('2');
    expect(hit.get('c')).toBe('3');
    expect(await cache.count()).toBe(2);
  });

  it('重复写入同一 key 不重复占位', async () => {
    const cache = new TranslationCache(new MemoryStorage(), 10);
    await cache.putMany(new Map([['a', '1']]));
    await cache.putMany(new Map([['a', '2']]));
    expect(await cache.count()).toBe(1);
    expect((await cache.getMany(['a'])).get('a')).toBe('2');
  });

  it('clear 清空所有条目', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage);
    await cache.putMany(new Map([['a', '1'], ['b', '2']]));
    await cache.clear();
    expect(await cache.count()).toBe(0);
    expect(storage.size()).toBe(0);
  });
});

describe('TieredCache', () => {
  it('会话层命中时不查持久层', async () => {
    const sessionStorage = new MemoryStorage();
    const localStorageArea = new MemoryStorage();
    const session = new TranslationCache(sessionStorage);
    const local = new TranslationCache(localStorageArea);
    await session.putMany(new Map([['a', '1']]));

    const tiered = new TieredCache(session, local);
    const hit = await tiered.getMany(['a']);
    expect(hit.get('a')).toBe('1');
    expect(localStorageArea.setCalls).toBe(0);
  });

  it('持久层命中时回填会话层', async () => {
    const sessionStorage = new MemoryStorage();
    const session = new TranslationCache(sessionStorage);
    const local = new TranslationCache(new MemoryStorage());
    await local.putMany(new Map([['a', '1']]));

    const tiered = new TieredCache(session, local);
    const hit = await tiered.getMany(['a']);
    expect(hit.get('a')).toBe('1');
    expect((await session.getMany(['a'])).get('a')).toBe('1');
  });

  it('写入时两层都写', async () => {
    const session = new TranslationCache(new MemoryStorage());
    const local = new TranslationCache(new MemoryStorage());
    const tiered = new TieredCache(session, local);
    await tiered.putMany(new Map([['a', '1']]));
    expect((await session.getMany(['a'])).get('a')).toBe('1');
    expect((await local.getMany(['a'])).get('a')).toBe('1');
  });

  it('两层都没有时返回空', async () => {
    const tiered = new TieredCache(
      new TranslationCache(new MemoryStorage()),
      new TranslationCache(new MemoryStorage()),
    );
    expect((await tiered.getMany(['x'])).size).toBe(0);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/core/cache.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 4: 写实现**

```ts
// src/core/cache.ts

/** chrome.storage.StorageArea 的可测试子集。 */
export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

const ENTRY_PREFIX = 'jt:';
const INDEX_KEY = 'jt:index';

interface CacheEntry {
  v: string;
  t: number;
}

/**
 * 每条译文独立存一个 key，另用一个索引 key 维护 LRU 顺序。
 * 这样淘汰时只需 remove 指定 key，不必整块重写。
 */
export class TranslationCache {
  constructor(
    private readonly area: StorageArea,
    private readonly maxEntries = 5000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private entryKey(hash: string): string {
    return ENTRY_PREFIX + hash;
  }

  async getMany(hashes: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (hashes.length === 0) return out;

    const keys = hashes.map((hash) => this.entryKey(hash));
    const raw = await this.area.get(keys);
    hashes.forEach((hash, index) => {
      const entry = raw[keys[index]] as CacheEntry | undefined;
      if (entry && typeof entry.v === 'string') out.set(hash, entry.v);
    });
    return out;
  }

  async putMany(items: Map<string, string>): Promise<void> {
    if (items.size === 0) return;

    const batch: Record<string, unknown> = {};
    const hashes: string[] = [];
    for (const [hash, value] of items) {
      batch[this.entryKey(hash)] = { v: value, t: this.now() } satisfies CacheEntry;
      hashes.push(hash);
    }
    await this.area.set(batch);
    await this.touch(hashes);
  }

  private async touch(hashes: string[]): Promise<void> {
    const raw = await this.area.get([INDEX_KEY]);
    const stored = raw[INDEX_KEY];
    const index = Array.isArray(stored) ? (stored as string[]) : [];
    const incoming = new Set(hashes);
    const merged = [...index.filter((hash) => !incoming.has(hash)), ...hashes];

    const overflow = merged.length - this.maxEntries;
    if (overflow > 0) {
      const evicted = merged.splice(0, overflow);
      await this.area.remove(evicted.map((hash) => this.entryKey(hash)));
    }
    await this.area.set({ [INDEX_KEY]: merged });
  }

  async count(): Promise<number> {
    const raw = await this.area.get([INDEX_KEY]);
    const stored = raw[INDEX_KEY];
    return Array.isArray(stored) ? stored.length : 0;
  }

  async clear(): Promise<void> {
    const raw = await this.area.get([INDEX_KEY]);
    const stored = raw[INDEX_KEY];
    const index = Array.isArray(stored) ? (stored as string[]) : [];
    await this.area.remove([...index.map((hash) => this.entryKey(hash)), INDEX_KEY]);
  }
}

/** 会话层（快，随浏览器会话消失）→ 持久层（慢，跨会话保留）。 */
export class TieredCache {
  constructor(
    private readonly session: TranslationCache,
    private readonly persistent: TranslationCache,
  ) {}

  async getMany(hashes: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (hashes.length === 0) return out;

    const fromSession = await this.session.getMany(hashes);
    for (const [hash, value] of fromSession) out.set(hash, value);

    const missing = hashes.filter((hash) => !out.has(hash));
    if (missing.length > 0) {
      const fromPersistent = await this.persistent.getMany(missing);
      if (fromPersistent.size > 0) {
        await this.session.putMany(fromPersistent);
        for (const [hash, value] of fromPersistent) out.set(hash, value);
      }
    }
    return out;
  }

  async putMany(items: Map<string, string>): Promise<void> {
    if (items.size === 0) return;
    await this.session.putMany(items);
    await this.persistent.putMany(items);
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/core/cache.test.ts`

Expected: PASS，全部用例通过。

- [ ] **Step 6: 提交**

```bash
git add src/core/cache.ts tests/helpers/memory-storage.ts tests/core/cache.test.ts
git commit -m "feat(core): 两级翻译缓存与 LRU 淘汰"
```

---

## Task 11: `shared/settings.ts` — 设置 schema 与读写

**Files:**
- Create: `src/shared/settings.ts`
- Create: `src/shared/chrome-area.ts`
- Test: `tests/shared/settings.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/shared/settings.test.ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, mergeSettings, saveSettings } from '../../src/shared/settings';
import { MemoryStorage } from '../helpers/memory-storage';

describe('mergeSettings', () => {
  it('空对象得到完整默认值', () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('保留用户已设置的值', () => {
    const merged = mergeSettings({ targetLang: 'ja', engineId: 'openai-compat' });
    expect(merged.targetLang).toBe('ja');
    expect(merged.engineId).toBe('openai-compat');
  });

  it('补齐缺失字段', () => {
    const merged = mergeSettings({ targetLang: 'ja' });
    expect(merged.displayMode).toBe(DEFAULT_SETTINGS.displayMode);
    expect(merged.engineConfig).toEqual(DEFAULT_SETTINGS.engineConfig);
  });

  it('忽略类型不符的值', () => {
    const merged = mergeSettings({ concurrency: '很多' as unknown as number, siteRules: 'not-an-array' as unknown as [] });
    expect(merged.concurrency).toBe(DEFAULT_SETTINGS.concurrency);
    expect(merged.siteRules).toEqual([]);
  });

  it('过滤掉结构不完整的站点规则与术语', () => {
    const merged = mergeSettings({
      siteRules: [{ pattern: '*.a.com', action: 'never' }, { pattern: 'x' }, null],
      glossary: [{ from: 'DSH', to: 'DeepSeek Harness' }, { from: 'only' }],
    });
    expect(merged.siteRules).toEqual([{ pattern: '*.a.com', action: 'never' }]);
    expect(merged.glossary).toEqual([{ from: 'DSH', to: 'DeepSeek Harness' }]);
  });

  it('数字超出合理范围时夹紧', () => {
    expect(mergeSettings({ concurrency: 999 }).concurrency).toBe(8);
    expect(mergeSettings({ concurrency: 0 }).concurrency).toBe(1);
  });
});

describe('loadSettings / saveSettings', () => {
  it('未存储过时返回默认值', async () => {
    expect(await loadSettings(new MemoryStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it('保存后能读回', async () => {
    const area = new MemoryStorage();
    await saveSettings({ ...DEFAULT_SETTINGS, targetLang: 'ko' }, area);
    expect((await loadSettings(area)).targetLang).toBe('ko');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/shared/settings.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现 `src/shared/settings.ts`**

```ts
// src/shared/settings.ts
import type { StorageArea } from '../core/cache';
import type { Term } from '../engines/types';
import { chromeArea } from './chrome-area';

export interface SiteRule {
  pattern: string;
  action: 'translate' | 'never';
}

export interface EngineConfigSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface Settings {
  version: number;
  engineId: string;
  engineConfig: EngineConfigSettings;
  targetLang: string;
  sourceLang: string;
  displayMode: 'bilingual' | 'replace';
  hoverTranslate: boolean;
  selectionTranslate: boolean;
  autoTranslateDelay: number;
  concurrency: number;
  maxBatchChars: number;
  maxSegmentsPerBatch: number;
  cacheMaxEntries: number;
  siteRules: SiteRule[];
  glossary: Term[];
  systemPrompt: string;
}

export const SETTINGS_KEY = 'jinyi:settings';

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  engineId: 'google',
  engineConfig: { apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  targetLang: 'zh-Hans',
  sourceLang: 'auto',
  displayMode: 'bilingual',
  hoverTranslate: true,
  selectionTranslate: true,
  autoTranslateDelay: 0,
  concurrency: 3,
  maxBatchChars: 1000,
  maxSegmentsPerBatch: 12,
  cacheMaxEntries: 5000,
  siteRules: [],
  glossary: [],
  systemPrompt: '',
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickSiteRules(value: unknown): SiteRule[] {
  if (!Array.isArray(value)) return [];
  const out: SiteRule[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const rule = raw as Partial<SiteRule>;
    if (typeof rule.pattern !== 'string' || rule.pattern.length === 0) continue;
    if (rule.action !== 'translate' && rule.action !== 'never') continue;
    out.push({ pattern: rule.pattern, action: rule.action });
  }
  return out;
}

function pickGlossary(value: unknown): Term[] {
  if (!Array.isArray(value)) return [];
  const out: Term[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const term = raw as Partial<Term>;
    if (typeof term.from !== 'string' || typeof term.to !== 'string') continue;
    if (term.from.length === 0) continue;
    out.push({ from: term.from, to: term.to });
  }
  return out;
}

function pickEngineConfig(value: unknown): EngineConfigSettings {
  const raw = (value ?? {}) as Partial<EngineConfigSettings>;
  return {
    apiKey: pickString(raw.apiKey, DEFAULT_SETTINGS.engineConfig.apiKey),
    baseUrl: pickString(raw.baseUrl, DEFAULT_SETTINGS.engineConfig.baseUrl),
    model: pickString(raw.model, DEFAULT_SETTINGS.engineConfig.model),
  };
}

/**
 * 把任意来源的对象合并成完整设置。
 * 逐字段校验而不是整体替换，这样新版字段可以在老数据上补齐，
 * 单个字段损坏也不会让整个设置页崩掉。
 */
export function mergeSettings(raw: unknown): Settings {
  const input = (raw ?? {}) as Partial<Settings>;
  return {
    version: DEFAULT_SETTINGS.version,
    engineId: pickString(input.engineId, DEFAULT_SETTINGS.engineId),
    engineConfig: pickEngineConfig(input.engineConfig),
    targetLang: pickString(input.targetLang, DEFAULT_SETTINGS.targetLang),
    sourceLang: pickString(input.sourceLang, DEFAULT_SETTINGS.sourceLang),
    displayMode: input.displayMode === 'replace' ? 'replace' : 'bilingual',
    hoverTranslate: pickBoolean(input.hoverTranslate, DEFAULT_SETTINGS.hoverTranslate),
    selectionTranslate: pickBoolean(input.selectionTranslate, DEFAULT_SETTINGS.selectionTranslate),
    autoTranslateDelay: clampInt(input.autoTranslateDelay, DEFAULT_SETTINGS.autoTranslateDelay, 0, 60),
    concurrency: clampInt(input.concurrency, DEFAULT_SETTINGS.concurrency, 1, 8),
    maxBatchChars: clampInt(input.maxBatchChars, DEFAULT_SETTINGS.maxBatchChars, 200, 8000),
    maxSegmentsPerBatch: clampInt(input.maxSegmentsPerBatch, DEFAULT_SETTINGS.maxSegmentsPerBatch, 1, 50),
    cacheMaxEntries: clampInt(input.cacheMaxEntries, DEFAULT_SETTINGS.cacheMaxEntries, 100, 50000),
    siteRules: pickSiteRules(input.siteRules),
    glossary: pickGlossary(input.glossary),
    systemPrompt: pickString(input.systemPrompt, DEFAULT_SETTINGS.systemPrompt),
  };
}

let sharedArea: StorageArea | null = null;

function resolveArea(area?: StorageArea): StorageArea {
  if (area) return area;
  if (!sharedArea) sharedArea = chromeArea(chrome.storage.local);
  return sharedArea;
}

export async function loadSettings(area?: StorageArea): Promise<Settings> {
  const target = resolveArea(area);
  const raw = await target.get([SETTINGS_KEY]);
  return mergeSettings(raw[SETTINGS_KEY]);
}

export async function saveSettings(settings: Settings, area?: StorageArea): Promise<void> {
  const target = resolveArea(area);
  await target.set({ [SETTINGS_KEY]: mergeSettings(settings) });
}
```

- [ ] **Step 4: 写实现 `src/shared/chrome-area.ts`**

```ts
// src/shared/chrome-area.ts
import type { StorageArea } from '../core/cache';

/** 把 chrome.storage 的 StorageArea 适配成本项目可测试的 StorageArea。 */
export function chromeArea(area: chrome.storage.StorageArea): StorageArea {
  return {
    get: (keys) => area.get(keys) as Promise<Record<string, unknown>>,
    set: (items) => area.set(items) as Promise<void>,
    remove: (keys) => area.remove(keys) as Promise<void>,
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/shared/settings.test.ts`

Expected: PASS，全部用例通过。

- [ ] **Step 6: 运行类型检查**

Run: `npm run typecheck`

Expected: 退出码 0。若报 `chrome` 未定义，确认 `tsconfig.json` 的 `types` 含 `"chrome"` 且已安装 `@types/chrome`。

- [ ] **Step 7: 提交**

```bash
git add src/shared/settings.ts src/shared/chrome-area.ts tests/shared/settings.test.ts
git commit -m "feat(shared): 设置 schema、默认值合并与读写"
```

---

## Task 12: `shared/messages.ts` — 消息协议

**Files:**
- Create: `src/shared/messages.ts`
- Test: `tests/shared/messages.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/shared/messages.test.ts
import { describe, expect, it } from 'vitest';
import { MSG, isTranslateTextsMessage, type TranslateTextsMessage } from '../../src/shared/messages';

describe('MSG', () => {
  it('消息类型常量取值唯一', () => {
    const values = Object.values(MSG);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('isTranslateTextsMessage', () => {
  it('识别合法的翻译请求', () => {
    const message: TranslateTextsMessage = {
      type: MSG.TRANSLATE_TEXTS,
      payload: { items: [{ id: 'jy-1', text: 'Hello' }] },
    };
    expect(isTranslateTextsMessage(message)).toBe(true);
  });

  it('拒绝 payload 缺失的消息', () => {
    expect(isTranslateTextsMessage({ type: MSG.TRANSLATE_TEXTS })).toBe(false);
  });

  it('拒绝 items 不是数组的消息', () => {
    expect(isTranslateTextsMessage({ type: MSG.TRANSLATE_TEXTS, payload: { items: 'x' } })).toBe(false);
  });

  it('拒绝元素结构不对的消息', () => {
    expect(
      isTranslateTextsMessage({ type: MSG.TRANSLATE_TEXTS, payload: { items: [{ id: 1, text: 2 }] } }),
    ).toBe(false);
  });

  it('拒绝其它类型的消息', () => {
    expect(isTranslateTextsMessage({ type: MSG.GET_PAGE_STATE })).toBe(false);
    expect(isTranslateTextsMessage(null)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/shared/messages.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/shared/messages.ts
import type { EngineErrorCode } from '../engines/types';

export const MSG = {
  /** 内容脚本 → SW：请求翻译一批文本 */
  TRANSLATE_TEXTS: 'jinyi:translate-texts',
  /** 弹窗/快捷键 → 内容脚本：翻译或还原（由内容脚本按当前状态决定） */
  TOGGLE_PAGE: 'jinyi:toggle-page',
  /** 弹窗 → 内容脚本：明确要求翻译 */
  TRANSLATE_PAGE: 'jinyi:translate-page',
  /** 弹窗 → 内容脚本：明确要求还原 */
  RESTORE_PAGE: 'jinyi:restore-page',
  /** 弹窗 → 内容脚本：查询当前页面翻译状态 */
  GET_PAGE_STATE: 'jinyi:get-page-state',
  /** 右键菜单 → 内容脚本：翻译选中文本 */
  TRANSLATE_SELECTION: 'jinyi:translate-selection',
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

export interface TranslateItem {
  id: string;
  text: string;
}

export interface TranslateItemResult {
  id: string;
  text: string | null;
  code?: EngineErrorCode;
  message?: string;
}

export interface TranslateTextsMessage {
  type: typeof MSG.TRANSLATE_TEXTS;
  payload: {
    items: TranslateItem[];
    targetLang?: string;
  };
}

export type TranslateTextsResponse =
  | { ok: true; results: TranslateItemResult[] }
  | { ok: false; code: EngineErrorCode; message: string };

export interface PageState {
  translated: boolean;
  mode: 'bilingual' | 'replace';
  total: number;
  done: number;
  failed: number;
}

/** 跨进程边界的消息必须在运行时校验，不能只信 TypeScript 类型。 */
export function isTranslateTextsMessage(value: unknown): value is TranslateTextsMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<TranslateTextsMessage>;
  if (message.type !== MSG.TRANSLATE_TEXTS) return false;
  if (!message.payload || typeof message.payload !== 'object') return false;
  const items = (message.payload as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.every(
    (item) =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as TranslateItem).id === 'string' &&
      typeof (item as TranslateItem).text === 'string',
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/shared/messages.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/shared/messages.ts tests/shared/messages.test.ts
git commit -m "feat(shared): 类型化消息协议与运行时校验"
```

---

## Task 13: `background/scheduler.ts` — 单批次缓存/引擎/重试

**Files:**
- Create: `src/background/scheduler.ts`
- Test: `tests/background/scheduler.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/background/scheduler.test.ts
import { describe, expect, it, vi } from 'vitest';
import { translateBatch, type BatchDeps } from '../../src/background/scheduler';
import { EngineError, type TranslateRequest, type Translator } from '../../src/engines/types';
import { TranslationCache } from '../../src/core/cache';
import { MemoryStorage } from '../helpers/memory-storage';

/** 可编排的假引擎：按脚本依次返回结果或抛错。 */
function fakeEngine(script: Array<string[] | Error>): { engine: Translator; calls: string[][] } {
  const calls: string[][] = [];
  let cursor = 0;
  const engine: Translator = {
    id: 'fake',
    name: 'Fake',
    needsKey: false,
    supportsGlossary: false,
    async translate(request: TranslateRequest): Promise<string[]> {
      calls.push([...request.texts]);
      const step = script[Math.min(cursor, script.length - 1)];
      cursor += 1;
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return { engine, calls };
}

function deps(engine: Translator, overrides: Partial<BatchDeps> = {}): BatchDeps {
  return {
    engine,
    engineConfig: {},
    sourceLang: 'auto',
    targetLang: 'zh-Hans',
    cache: new TranslationCache(new MemoryStorage()),
    sleep: async () => {},
    ...overrides,
  };
}

describe('translateBatch', () => {
  it('缓存命中时不调用引擎', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    const { engine, calls } = fakeEngine([['你好']]);
    const shared = deps(engine, { cache });

    await translateBatch([{ id: 'a', text: 'Hello' }], shared);
    const second = await translateBatch([{ id: 'a', text: 'Hello' }], shared);

    expect(calls).toHaveLength(1);
    expect(second[0]).toEqual({ id: 'a', text: '你好' });
  });

  it('未命中的条目翻译后写入缓存', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    const { engine } = fakeEngine([['你好']]);
    await translateBatch([{ id: 'a', text: 'Hello' }], deps(engine, { cache }));

    const key = await translateBatch([{ id: 'a', text: 'Hello' }], deps(engine, { cache }));
    expect(key[0].text).toBe('你好');
    expect(await cache.count()).toBe(1);
  });

  it('返回结果与输入顺序一致', async () => {
    const { engine } = fakeEngine([['甲', '乙']]);
    const out = await translateBatch(
      [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ],
      deps(engine),
    );
    expect(out).toEqual([
      { id: 'a', text: '甲' },
      { id: 'b', text: '乙' },
    ]);
  });

  it('鉴权失败不重试', async () => {
    const { engine, calls } = fakeEngine([new EngineError('AUTH', 'Key 无效')]);
    const out = await translateBatch([{ id: 'a', text: 'A' }], deps(engine));
    expect(calls).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'a', text: null, code: 'AUTH' });
  });

  it('网络错误退避重试后成功', async () => {
    const sleeps: number[] = [];
    const { engine, calls } = fakeEngine([new EngineError('NETWORK', '断网'), ['你好']]);
    const out = await translateBatch(
      [{ id: 'a', text: 'A' }],
      deps(engine, { sleep: async (ms) => void sleeps.push(ms) }),
    );
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([500]);
    expect(out[0].text).toBe('你好');
  });

  it('重试耗尽后返回失败结果而不是抛错', async () => {
    const { engine, calls } = fakeEngine([new EngineError('NETWORK', '一直断网')]);
    const out = await translateBatch([{ id: 'a', text: 'A' }], deps(engine));
    expect(calls).toHaveLength(3);
    expect(out[0]).toMatchObject({ text: null, code: 'NETWORK' });
  });

  it('文本过长时按句切分重试并拼接结果', async () => {
    // 必须用真正超长的文本：切分阈值是 max(200, 文本长度的一半)，短文本不会触发切分。
    const long = '第一句。'.repeat(200);
    const { engine, calls } = fakeEngine([
      new EngineError('TOO_LONG', '过长'),
      ['切分一。', '切分二。'],
    ]);
    const out = await translateBatch([{ id: 'a', text: long }], deps(engine));

    expect(calls[0]).toEqual([long]);
    expect(calls[1].length).toBeGreaterThan(1);
    // 切分不能丢字符
    expect(calls[1].join('')).toBe(long);
    expect(out[0].text).toBe('切分一。切分二。');
  });

  it('返回条目数不符时降级为逐条翻译', async () => {
    const { engine, calls } = fakeEngine([['只有一条'], ['甲'], ['乙']]);
    const out = await translateBatch(
      [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ],
      deps(engine),
    );
    expect(calls).toHaveLength(3);
    expect(out).toEqual([
      { id: 'a', text: '甲' },
      { id: 'b', text: '乙' },
    ]);
  });

  it('SDK 抛出的非 EngineError 也会被归类', async () => {
    const { engine } = fakeEngine([new TypeError('failed to fetch')]);
    const out = await translateBatch([{ id: 'a', text: 'A' }], deps(engine));
    expect(out[0]).toMatchObject({ text: null, code: 'UNKNOWN' });
  });

  it('空输入返回空数组', async () => {
    const { engine, calls } = fakeEngine([[]]);
    expect(await translateBatch([], deps(engine))).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('只有部分命中时只请求未命中的部分', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    const { engine, calls } = fakeEngine([['你好'], ['世界']]);
    await translateBatch([{ id: 'a', text: 'Hello' }], deps(engine, { cache }));

    const out = await translateBatch(
      [
        { id: 'a', text: 'Hello' },
        { id: 'b', text: 'World' },
      ],
      deps(engine, { cache }),
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(['World']);
    expect(out).toEqual([
      { id: 'a', text: '你好' },
      { id: 'b', text: '世界' },
    ]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/background/scheduler.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/background/scheduler.ts
import { buildCacheKey, hashString } from '../core/hash';
import { joinPieces, splitBySentence } from '../core/segmenter';
import {
  EngineError,
  toEngineError,
  type EngineConfig,
  type Term,
  type Translator,
} from '../engines/types';
import type { TranslateItem, TranslateItemResult } from '../shared/messages';

export interface CacheLike {
  getMany(keys: string[]): Promise<Map<string, string>>;
  putMany(items: Map<string, string>): Promise<void>;
}

export interface BatchDeps {
  engine: Translator;
  engineConfig: EngineConfig;
  sourceLang: string;
  targetLang: string;
  glossary?: Term[];
  systemPrompt?: string;
  cache: CacheLike;
  /** 测试可注入假定时器；默认真实等待 */
  sleep?: (ms: number) => Promise<void>;
}

const BACKOFF_MS = [500, 1500];

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function callEngine(texts: string[], deps: BatchDeps): Promise<string[]> {
  const controller = new AbortController();
  const translations = await deps.engine.translate(
    {
      texts,
      from: deps.sourceLang,
      to: deps.targetLang,
      glossary: deps.glossary,
      systemPrompt: deps.systemPrompt,
      signal: controller.signal,
    },
    deps.engineConfig,
  );
  if (!Array.isArray(translations) || translations.length !== texts.length) {
    throw new EngineError('BAD_RESPONSE', '引擎返回的条目数与请求不一致');
  }
  return translations;
}

/** 引擎报文本过长时，把每条按句子切开分别翻译，再拼回一段。 */
async function translateSplit(texts: string[], deps: BatchDeps): Promise<string[]> {
  const out: string[] = [];
  for (const text of texts) {
    const pieces = splitBySentence(text, Math.max(200, Math.ceil(text.length / 2)));
    const translated = await callEngine(pieces, deps);
    out.push(joinPieces(translated, deps.targetLang));
  }
  return out;
}

/** 模型没按编号返回时，退回逐条翻译，牺牲速度换正确性。 */
async function translateOneByOne(texts: string[], deps: BatchDeps): Promise<string[]> {
  const out: string[] = [];
  for (const text of texts) {
    const single = await callEngine([text], deps);
    out.push(single[0]);
  }
  return out;
}

async function translateWithFallback(texts: string[], deps: BatchDeps): Promise<string[]> {
  const sleep = deps.sleep ?? defaultSleep;
  let last: EngineError | undefined;

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
    try {
      return await callEngine(texts, deps);
    } catch (raw) {
      const error = toEngineError(raw);
      last = error;

      if (error.code === 'TOO_LONG') return translateSplit(texts, deps);
      if (error.code === 'BAD_RESPONSE' && texts.length > 1) return translateOneByOne(texts, deps);
      if (!error.retryable) throw error;

      if (attempt < BACKOFF_MS.length) await sleep(BACKOFF_MS[attempt]);
    }
  }
  throw last ?? new EngineError('UNKNOWN', '未知错误');
}

/**
 * 处理一个批次：缓存命中直接返回，未命中的合并成一次引擎请求。
 * 任何失败都转成携带错误码的结果项，绝不抛错——内容脚本据此渲染"重试"按钮。
 */
export async function translateBatch(items: TranslateItem[], deps: BatchDeps): Promise<TranslateItemResult[]> {
  const results: TranslateItemResult[] = items.map((item) => ({ id: item.id, text: null }));
  if (items.length === 0) return results;

  const glossaryHash = hashString(JSON.stringify(deps.glossary ?? []));
  const promptHash = hashString(deps.systemPrompt ?? '');
  const keys = items.map((item) =>
    buildCacheKey({
      engineId: deps.engine.id,
      targetLang: deps.targetLang,
      glossaryHash,
      promptHash,
      text: item.text,
    }),
  );

  const cached = await deps.cache.getMany(keys);
  const missing: number[] = [];
  items.forEach((item, index) => {
    const hit = cached.get(keys[index]);
    if (hit === undefined) missing.push(index);
    else results[index] = { id: item.id, text: hit };
  });
  if (missing.length === 0) return results;

  try {
    const translations = await translateWithFallback(
      missing.map((index) => items[index].text),
      deps,
    );
    const toCache = new Map<string, string>();
    translations.forEach((translation, offset) => {
      const index = missing[offset];
      results[index] = { id: items[index].id, text: translation };
      toCache.set(keys[index], translation);
    });
    await deps.cache.putMany(toCache);
  } catch (raw) {
    const error = toEngineError(raw);
    for (const index of missing) {
      results[index] = { id: items[index].id, text: null, code: error.code, message: error.message };
    }
  }

  return results;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/background/scheduler.test.ts`

Expected: PASS，11 个用例全绿。

- [ ] **Step 5: 提交**

```bash
git add src/background/scheduler.ts tests/background/scheduler.test.ts
git commit -m "feat(background): 单批次缓存、引擎调用与重试降级"
```

---

## Task 14: `background/service-worker.ts` — 消息路由、快捷键、右键菜单

**Files:**
- Modify: `src/background/service-worker.ts`（替换占位内容）

- [ ] **Step 1: 写实现**

```ts
// src/background/service-worker.ts
import { TieredCache, TranslationCache, type StorageArea } from '../core/cache';
import { getEngine } from '../engines/registry';
import { EngineError, toEngineError } from '../engines/types';
import { chromeArea } from '../shared/chrome-area';
import { isTranslateTextsMessage, MSG, type TranslateTextsResponse } from '../shared/messages';
import { loadSettings } from '../shared/settings';
import { translateBatch } from './scheduler';

const MENU_TRANSLATE_PAGE = 'jinyi-translate-page';
const MENU_TRANSLATE_SELECTION = 'jinyi-translate-selection';

const localArea: StorageArea = chromeArea(chrome.storage.local);
const sessionArea: StorageArea = chromeArea(chrome.storage.session);

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_TRANSLATE_PAGE, title: '翻译此页', contexts: ['page'] });
    chrome.contextMenus.create({ id: MENU_TRANSLATE_SELECTION, title: '翻译选中文本', contexts: ['selection'] });
  });
});

async function sendToActiveTab(message: unknown): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  // 在 chrome:// 等受限页面上没有接收方，静默忽略。
  await chrome.tabs.sendMessage(tab.id, message).catch(() => undefined);
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-translate') void sendToActiveTab({ type: MSG.TOGGLE_PAGE });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === MENU_TRANSLATE_PAGE) {
    void chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_PAGE }).catch(() => undefined);
    return;
  }
  if (info.menuItemId === MENU_TRANSLATE_SELECTION && info.selectionText) {
    void chrome.tabs
      .sendMessage(tab.id, { type: MSG.TRANSLATE_SELECTION, payload: { text: info.selectionText } })
      .catch(() => undefined);
  }
});

async function handleTranslateTexts(
  payload: { items: Array<{ id: string; text: string }>; targetLang?: string },
): Promise<TranslateTextsResponse> {
  try {
    const settings = await loadSettings(localArea);
    const engine = getEngine(settings.engineId);
    const targetLang = payload.targetLang ?? settings.targetLang;

    const cache = new TieredCache(
      new TranslationCache(sessionArea, settings.cacheMaxEntries),
      new TranslationCache(localArea, settings.cacheMaxEntries),
    );

    const results = await translateBatch(payload.items, {
      engine,
      engineConfig: settings.engineConfig,
      sourceLang: settings.sourceLang,
      targetLang,
      // 不支持 system prompt 的引擎传了也没用，反而会污染缓存 key。
      glossary: engine.supportsGlossary ? settings.glossary : undefined,
      systemPrompt: engine.supportsGlossary ? settings.systemPrompt : undefined,
      cache,
    });

    return { ok: true, results };
  } catch (raw) {
    const error = toEngineError(raw);
    return { ok: false, code: error.code, message: error.message };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isTranslateTextsMessage(message)) return false;
  handleTranslateTexts(message.payload)
    .then(sendResponse)
    .catch((raw: unknown) => {
      const error: EngineError = toEngineError(raw);
      sendResponse({ ok: false, code: error.code, message: error.message } satisfies TranslateTextsResponse);
    });
  // 返回 true 保持消息通道打开，等待异步响应。
  return true;
});
```

- [ ] **Step 2: 运行类型检查**

Run: `npm run typecheck`

Expected: 退出码 0。

- [ ] **Step 3: 构建并确认 background 产物体积合理**

Run: `npm run build`

Expected: 退出码 0，`dist/background.js` 存在。

- [ ] **Step 4: 提交**

```bash
git add src/background/service-worker.ts
git commit -m "feat(background): 消息路由、快捷键与右键菜单"
```

---

## Task 15: `content/extractor.ts` — 段落识别

**Files:**
- Create: `src/content/extractor.ts`
- Test: `tests/content/extractor.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/content/extractor.test.ts
/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { collectSegments, isBlockDisplay, isHidden, resolveText } from '../../src/content/extractor';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('isBlockDisplay', () => {
  it('识别块级 display', () => {
    expect(isBlockDisplay('block')).toBe(true);
    expect(isBlockDisplay('list-item')).toBe(true);
    expect(isBlockDisplay('table-cell')).toBe(true);
    expect(isBlockDisplay('flex')).toBe(true);
    expect(isBlockDisplay('grid')).toBe(true);
  });

  it('行内与空值不算块级', () => {
    expect(isBlockDisplay('inline')).toBe(false);
    expect(isBlockDisplay('inline-block')).toBe(false);
    expect(isBlockDisplay('')).toBe(false);
    expect(isBlockDisplay(undefined)).toBe(false);
  });
});

describe('isHidden', () => {
  it('display:none 视为隐藏', () => {
    const root = mount('<p id="t" style="display:none">Hello world</p>');
    expect(isHidden(root.querySelector('#t') as Element)).toBe(true);
  });

  it('visibility:hidden 视为隐藏', () => {
    const root = mount('<p id="t" style="visibility:hidden">Hello world</p>');
    expect(isHidden(root.querySelector('#t') as Element)).toBe(true);
  });

  it('hidden 属性视为隐藏', () => {
    const root = mount('<p id="t" hidden>Hello world</p>');
    expect(isHidden(root.querySelector('#t') as Element)).toBe(true);
  });

  it('正常段落不算隐藏', () => {
    const root = mount('<p id="t">Hello world</p>');
    expect(isHidden(root.querySelector('#t') as Element)).toBe(false);
  });
});

describe('resolveText', () => {
  it('折叠空白', () => {
    const root = mount('<p id="t">  Hello\n   world  </p>');
    expect(resolveText(root.querySelector('#t') as Element)).toBe('Hello world');
  });
});

describe('collectSegments', () => {
  it('把每个段落收成一段', () => {
    const root = mount('<p>Hello world</p><p>Goodbye world</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Hello world', 'Goodbye world']);
  });

  it('行内子元素不单独成段', () => {
    const root = mount('<p>Hello <b>bold</b> world</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('Hello bold world');
  });

  it('嵌套块级结构只取最内层文本块', () => {
    const root = mount('<div><p>One two</p><p>Three four</p></div>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['One two', 'Three four']);
  });

  it('跳过 script / style / code', () => {
    const root = mount(
      '<script>var a = 1;</script><style>p{color:red}</style><pre>const a = 1</pre><p>Real content here</p>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Real content here']);
  });

  it('跳过隐藏元素', () => {
    const root = mount('<p style="display:none">Hidden text</p><p>Visible text</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Visible text']);
  });

  it('跳过纯数字与纯标点', () => {
    const root = mount('<p>12345</p><p>—— ……</p><p>Real content</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Real content']);
  });

  it('目标中文时跳过中文段落', () => {
    const root = mount('<p>这是中文段落</p><p>This is English</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['This is English']);
  });

  it('不重复采集已翻译过的节点', () => {
    const root = mount('<p data-jy-translated="1">Already done</p><p>Fresh content</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Fresh content']);
  });

  it('跳过插件自己注入的节点', () => {
    const root = mount('<p>Original text</p><jy-translation data-jy-root=""><span>译文</span></jy-translation>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Original text']);
  });

  it('给每段分配唯一 id 与递增 order', () => {
    const root = mount('<p>One two</p><p>Three four</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments[0].id).not.toBe(segments[1].id);
    expect(segments.map((s) => s.order)).toEqual([0, 1]);
    expect(segments[0].element.getAttribute('data-jy-id')).toBe(segments[0].id);
  });

  it('表格单元格各自成段', () => {
    const root = mount('<table><tbody><tr><td>First cell</td><td>Second cell</td></tr></tbody></table>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['First cell', 'Second cell']);
  });

  it('列表项各自成段且不重复', () => {
    const root = mount('<ul><li>First item</li><li>Second item</li></ul>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['First item', 'Second item']);
  });

  it('空页面返回空数组', () => {
    expect(collectSegments(mount(''), { targetLang: 'zh-Hans' })).toEqual([]);
  });

  it('支持自定义跳过谓词', () => {
    const root = mount('<p>Skip me</p><p>Keep me</p>');
    const segments = collectSegments(root, {
      targetLang: 'zh-Hans',
      shouldSkipText: (text) => text.startsWith('Skip'),
    });
    expect(segments.map((s) => s.text)).toEqual(['Keep me']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/content/extractor.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/content/extractor.ts
import { isTranslatableText, normalizeText, shouldSkip } from '../core/lang';

export interface ExtractedSegment {
  id: string;
  text: string;
  order: number;
  element: HTMLElement;
}

export interface ExtractorOptions {
  targetLang: string;
  shouldSkipText?: (text: string) => boolean;
}

/** 这些标签里的内容一律不翻译：代码、表单控件、多媒体与元数据。 */
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'CODE',
  'PRE',
  'KBD',
  'SAMP',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'SVG',
  'CANVAS',
  'IFRAME',
  'VIDEO',
  'AUDIO',
  'HEAD',
  'TITLE',
  'META',
  'LINK',
  'BUTTON',
]);

const BLOCK_DISPLAYS = new Set([
  'block',
  'flow-root',
  'list-item',
  'table',
  'table-row',
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'table-cell',
  'table-caption',
  'flex',
  'grid',
  '-webkit-box',
]);

/** 未知或空 display 一律按行内处理，让最近的块级祖先成为段落边界。 */
export function isBlockDisplay(display: string | undefined): boolean {
  return display !== undefined && BLOCK_DISPLAYS.has(display);
}

export function isHidden(element: Element): boolean {
  if (element.hasAttribute('hidden')) return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;
  const style = getComputedStyle(element);
  if (style.display === 'none') return true;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  return false;
}

/** 用 textContent 而不是 innerText：行为确定、可测，且不依赖布局。 */
export function resolveText(element: Element): string {
  return normalizeText(element.textContent);
}

function isSkippable(element: Element): boolean {
  if (SKIP_TAGS.has(element.tagName)) return true;
  if (element.hasAttribute('data-jy-translated')) return true;
  // 插件自己注入的译文宿主，避免二次翻译。
  if (element.closest('[data-jy-root]')) return true;
  return false;
}

function blockChildrenOf(element: Element): Element[] {
  return Array.from(element.children).filter(
    (child) => !SKIP_TAGS.has(child.tagName) && isBlockDisplay(getComputedStyle(child).display) && !isHidden(child),
  );
}

/**
 * 段落识别的核心规则：一个元素若含有块级子元素就继续下钻，
 * 否则它就是最内层的文本块，整块作为一段。
 * 这样 <p>Hello <b>world</b></p> 是一段，而 <div><p>a</p><p>b</p></div> 是两段。
 */
export function collectSegments(root: ParentNode, options: ExtractorOptions): ExtractedSegment[] {
  const segments: ExtractedSegment[] = [];

  const visit = (element: Element): void => {
    if (isSkippable(element) || isHidden(element)) return;

    const blocks = blockChildrenOf(element);
    if (blocks.length > 0) {
      for (const block of blocks) visit(block);
      return;
    }

    const text = resolveText(element);
    if (!isTranslatableText(text)) return;
    if (options.shouldSkipText?.(text)) return;
    if (shouldSkip(text, options.targetLang)) return;

    const id = `jy-${segments.length + 1}-${Math.random().toString(36).slice(2, 8)}`;
    element.setAttribute('data-jy-id', id);
    segments.push({ id, text, order: segments.length, element: element as HTMLElement });
  };

  const roots = rootElements(root);
  for (const element of roots) visit(element);
  return segments;
}
```

- [ ] **Step 4: 在 `collectSegments` 上方补上 `rootElements` 辅助函数**

```ts
/** 同时支持传入 Element（通常是 document.body）与 Document。 */
function rootElements(root: ParentNode): Element[] {
  if (root instanceof Element) return Array.from(root.children);
  return Array.from(root.childNodes).filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE);
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/content/extractor.test.ts`

Expected: PASS。

若某个用例因 jsdom 对 `display` 返回空串而失败（表现为段落被合并成父容器一段），在该元素的标签上通过 `style="display:block"` 显式声明后再断言。

- [ ] **Step 6: 提交**

```bash
git add src/content/extractor.ts tests/content/extractor.test.ts
git commit -m "feat(content): 段落识别与可翻译性过滤"
```

---

## Task 16: `content/renderer.ts` — 译文注入与还原

**Files:**
- Create: `src/content/styles.ts`
- Create: `src/content/renderer.ts`
- Test: `tests/content/renderer.test.ts`

- [ ] **Step 1: 写样式常量**

```ts
// src/content/styles.ts

/**
 * 注入译文宿主的 Shadow DOM。
 * 页面 CSS 进不来，译文样式也出不去，双向隔离。
 */
export const TRANSLATION_CSS = `
  :host { display: block; }
  .jy-body {
    display: block;
    margin: 0.35em 0 0.15em;
    line-height: 1.6;
    font-size: 0.97em;
    color: #2b6cb0;
    border-left: 2px solid rgba(43, 108, 176, 0.35);
    padding-left: 0.6em;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .jy-body.jy-pending { color: #9aa5b1; border-left-color: rgba(154, 165, 177, 0.35); }
  .jy-body.jy-error { color: #b3261e; border-left-color: rgba(179, 38, 30, 0.35); }
  .jy-retry {
    margin-left: 0.5em;
    padding: 0 0.5em;
    font: inherit;
    font-size: 0.85em;
    color: inherit;
    background: transparent;
    border: 1px solid currentColor;
    border-radius: 4px;
    cursor: pointer;
  }
`;
```

- [ ] **Step 2: 写失败的测试**

```ts
// tests/content/renderer.test.ts
/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomRenderer } from '../../src/content/renderer';
import type { ExtractedSegment } from '../../src/content/extractor';

function paragraph(text: string): ExtractedSegment {
  const element = document.createElement('p');
  element.textContent = text;
  document.body.append(element);
  return { id: 'jy-1', text, order: 0, element };
}

function bodyTextOf(host: Element): string {
  return host.shadowRoot?.querySelector('.jy-body')?.textContent ?? '';
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('DomRenderer 双语模式', () => {
  it('把译文宿主插到原段落之后', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '你好，世界');

    const host = document.querySelector('jy-translation');
    expect(host).not.toBeNull();
    expect(segment.element.nextElementSibling).toBe(host);
    expect(bodyTextOf(host as Element)).toBe('你好，世界');
  });

  it('原文保持不变', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '你好，世界');
    expect(segment.element.textContent).toBe('Hello world');
  });

  it('重复 mount 同一个 id 不会插入两个宿主', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    renderer.mount(segment, 'pending');
    expect(document.querySelectorAll('jy-translation')).toHaveLength(1);
  });

  it('宿主带 data-jy-root 标记，避免被再次采集', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    const host = document.querySelector('jy-translation') as Element;
    expect(host.hasAttribute('data-jy-root')).toBe(true);
    expect(host.getAttribute('data-jy-for')).toBe('jy-1');
  });

  it('表格单元格的译文插进单元格内部而不是行之间', () => {
    document.body.innerHTML = '<table><tbody><tr><td id="cell">Cell text</td></tr></tbody></table>';
    const cell = document.getElementById('cell') as HTMLElement;
    const segment: ExtractedSegment = { id: 'jy-1', text: 'Cell text', order: 0, element: cell };
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    expect(cell.querySelector('jy-translation')).not.toBeNull();
  });

  it('弹性布局父容器下译文插到段落内部', () => {
    document.body.innerHTML =
      '<div style="display:flex"><p id="p" style="display:block">Flex child text</p></div>';
    const p = document.getElementById('p') as HTMLElement;
    const segment: ExtractedSegment = { id: 'jy-1', text: 'Flex child text', order: 0, element: p };
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    expect(p.querySelector('jy-translation')).not.toBeNull();
  });

  it('列表项的译文插进列表项内部', () => {
    document.body.innerHTML = '<ul><li id="li">Item text</li></ul>';
    const li = document.getElementById('li') as HTMLElement;
    const segment: ExtractedSegment = { id: 'jy-1', text: 'Item text', order: 0, element: li };
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    expect(li.querySelector('jy-translation')).not.toBeNull();
  });
});

describe('DomRenderer 状态与还原', () => {
  it('pending 状态显示占位文案', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    expect(bodyTextOf(document.querySelector('jy-translation') as Element)).toBe('翻译中…');
  });

  it('fail 状态显示错误文案与重试按钮', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    renderer.fail(segment.id, '网络错误');

    const host = document.querySelector('jy-translation') as Element;
    expect(bodyTextOf(host)).toContain('网络错误');
    expect(host.shadowRoot?.querySelector('.jy-retry')).not.toBeNull();
  });

  it('点击重试按钮触发回调', () => {
    const segment = paragraph('Hello world');
    const onRetry = vi.fn();
    const renderer = new DomRenderer(document, 'bilingual', onRetry);
    renderer.mount(segment, 'pending');
    renderer.fail(segment.id, '网络错误');

    const host = document.querySelector('jy-translation') as Element;
    const button = host.shadowRoot?.querySelector('.jy-retry') as HTMLButtonElement;
    button.click();
    expect(onRetry).toHaveBeenCalledWith('jy-1');
  });

  it('restore 移除全部译文宿主并清掉标记', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '你好，世界');
    renderer.restore();

    expect(document.querySelector('jy-translation')).toBeNull();
    expect(segment.element.hasAttribute('data-jy-id')).toBe(false);
    expect(segment.element.getAttribute('data-jy-translated')).toBeNull();
  });
});

describe('DomRenderer 替换模式', () => {
  it('把原文替换成译文', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'replace');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '你好，世界');
    expect(segment.element.textContent).toBe('你好，世界');
  });

  it('不插入额外宿主', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'replace');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '你好，世界');
    expect(document.querySelector('jy-translation')).toBeNull();
  });

  it('restore 还原原文', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'replace');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '你好，世界');
    renderer.restore();
    expect(segment.element.textContent).toBe('Hello world');
  });

  it('失败时不破坏原文', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'replace');
    renderer.mount(segment, 'pending');
    renderer.fail(segment.id, '网络错误');
    expect(segment.element.textContent).toBe('Hello world');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/content/renderer.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 4: 写实现**

```ts
// src/content/renderer.ts
import type { ExtractedSegment } from './extractor';
import { TRANSLATION_CSS } from './styles';

export type DisplayMode = 'bilingual' | 'replace';
export type RenderState = 'pending' | 'done' | 'error';

const HOST_TAG = 'jy-translation';
const PENDING_TEXT = '翻译中…';

interface InsertionTarget {
  parent: HTMLElement;
  inside: boolean;
}

/**
 * 决定译文宿主插到哪里。
 * 表格单元格、列表项、以及弹性/网格布局的子元素都必须插到内部——
 * 否则会在 <tr> 里插入非单元格节点破坏表格，或在 flex 行里被挤成一行。
 */
export function resolveInsertion(element: HTMLElement): InsertionTarget {
  if (element.tagName === 'TD' || element.tagName === 'TH' || element.tagName === 'LI') {
    return { parent: element, inside: true };
  }
  const parent = element.parentElement;
  if (!parent) return { parent: element, inside: true };
  const display = getComputedStyle(parent).display;
  if (display === 'flex' || display === 'inline-flex' || display === 'grid' || display === 'inline-grid') {
    return { parent: element, inside: true };
  }
  return { parent, inside: false };
}

export class DomRenderer {
  private readonly hosts = new Map<string, HTMLElement>();
  private readonly originals = new Map<string, { element: HTMLElement; text: string }>();

  constructor(
    private readonly document: Document,
    private readonly mode: DisplayMode,
    private readonly onRetry?: (segmentId: string) => void,
  ) {}

  mount(segment: ExtractedSegment, state: RenderState, text?: string): void {
    if (this.mode === 'replace') {
      if (!this.originals.has(segment.id)) {
        this.originals.set(segment.id, { element: segment.element, text: segment.element.textContent ?? '' });
      }
      if (state === 'done' && text !== undefined) segment.element.textContent = text;
      return;
    }
    this.setContent(this.ensureHost(segment), state, text);
  }

  update(segmentId: string, text: string): void {
    const host = this.hosts.get(segmentId);
    if (host) {
      this.setContent(host, 'done', text);
      return;
    }
    const original = this.originals.get(segmentId);
    if (original) {
      original.element.textContent = text;
      original.element.setAttribute('data-jy-translated', '1');
    }
  }

  fail(segmentId: string, message: string): void {
    const host = this.hosts.get(segmentId);
    // 替换模式下失败必须保持原文，否则用户会看到一片空白。
    if (!host) return;
    this.setContent(host, 'error', message);
  }

  private ensureHost(segment: ExtractedSegment): HTMLElement {
    const existing = this.hosts.get(segment.id);
    if (existing) return existing;

    const host = this.document.createElement(HOST_TAG);
    host.setAttribute('data-jy-root', '');
    host.setAttribute('data-jy-for', segment.id);

    const shadow = host.attachShadow({ mode: 'open' });
    const style = this.document.createElement('style');
    style.textContent = TRANSLATION_CSS;
    const body = this.document.createElement('span');
    body.className = 'jy-body';
    shadow.append(style, body);

    const target = resolveInsertion(segment.element);
    if (target.inside) target.parent.append(host);
    else target.parent.insertBefore(host, segment.element.nextSibling);

    // 标记原文已翻译：即使后续被重复采集，extractor 也会跳过它。
    segment.element.setAttribute('data-jy-translated', '1');
    this.hosts.set(segment.id, host);
    return host;
  }

  /** 一律用 textContent 写入，杜绝引擎返回内容被当成 HTML 执行。 */
  private setContent(host: HTMLElement, state: RenderState, text?: string): void {
    const body = host.shadowRoot?.querySelector('.jy-body');
    if (!body) return;

    body.textContent = '';
    body.className = 'jy-body';
    if (state === 'pending') {
      body.classList.add('jy-pending');
      body.textContent = PENDING_TEXT;
      return;
    }
    if (state === 'error') {
      body.classList.add('jy-error');
      body.textContent = text ?? '翻译失败';
      const button = this.document.createElement('button');
      button.className = 'jy-retry';
      button.type = 'button';
      button.textContent = '重试';
      const segmentId = host.getAttribute('data-jy-for');
      button.addEventListener('click', () => {
        if (segmentId) this.onRetry?.(segmentId);
      });
      body.append(button);
      return;
    }
    body.textContent = text ?? '';
  }

  restore(): void {
    for (const host of this.hosts.values()) host.remove();
    this.hosts.clear();

    for (const { element, text } of this.originals.values()) {
      element.textContent = text;
      element.removeAttribute('data-jy-translated');
    }
    this.originals.clear();

    for (const element of Array.from(this.document.querySelectorAll('[data-jy-id], [data-jy-translated]'))) {
      element.removeAttribute('data-jy-id');
      element.removeAttribute('data-jy-translated');
    }
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/content/renderer.test.ts`

Expected: PASS，全部用例通过。

- [ ] **Step 6: 提交**

```bash
git add src/content/styles.ts src/content/renderer.ts tests/content/renderer.test.ts
git commit -m "feat(content): 译文注入渲染器与还原"
```

---

## Task 17: `content/toast.ts` 与 `content/index.ts` — 内容脚本编排

**Files:**
- Create: `src/content/toast.ts`
- Modify: `src/content/index.ts`（替换占位内容）

- [ ] **Step 1: 写页面内轻提示**

```ts
// src/content/toast.ts

const TOAST_ID = 'jy-toast';
const VISIBLE_MS = 3200;

/** 页面内轻提示。固定挂在 documentElement 上，不受页面布局影响。 */
export function toast(message: string): void {
  const existing = document.getElementById(TOAST_ID);
  if (existing) existing.remove();

  const host = document.createElement('div');
  host.id = TOAST_ID;
  host.setAttribute('data-jy-root', '');
  host.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'left:50%',
    'bottom:32px',
    'transform:translateX(-50%)',
    'padding:10px 16px',
    'border-radius:8px',
    'background:rgba(17,24,39,0.92)',
    'color:#fff',
    'font:14px/1.5 system-ui,sans-serif',
    'box-shadow:0 4px 16px rgba(0,0,0,0.24)',
    'pointer-events:none',
  ].join(';');

  const shadow = host.attachShadow({ mode: 'open' });
  const span = document.createElement('span');
  span.textContent = message;
  shadow.append(span);

  document.documentElement.append(host);
  setTimeout(() => host.remove(), VISIBLE_MS);
}
```

- [ ] **Step 2: 写内容脚本入口**

```ts
// src/content/index.ts
import { runPool } from '../core/pool';
import { planBatches, type TextSegment } from '../core/segmenter';
import { MSG, type PageState, type TranslateTextsResponse } from '../shared/messages';
import { loadSettings, type Settings } from '../shared/settings';
import { collectSegments, type ExtractedSegment } from './extractor';
import { DomRenderer } from './renderer';
import { toast } from './toast';

let renderer: DomRenderer | null = null;
let segments: ExtractedSegment[] = [];
let running = false;
let lastError: string | null = null;
let displayMode: 'bilingual' | 'replace' = 'bilingual';
const finished = new Set<string>();
const failedIds = new Set<string>();

function currentState(): PageState {
  return {
    translated: renderer !== null,
    mode: displayMode,
    total: segments.length,
    done: finished.size,
    failed: failedIds.size,
  };
}

function sendToBackground(message: unknown): Promise<TranslateTextsResponse> {
  return chrome.runtime.sendMessage(message) as Promise<TranslateTextsResponse>;
}

function describeError(response: Extract<TranslateTextsResponse, { ok: false }>): string {
  if (response.code === 'AUTH') return response.message;
  if (response.code === 'RATE_LIMIT') return '免费接口限流，请稍后重试或改用自定义 API';
  return `翻译失败：${response.message}`;
}

async function translatePage(): Promise<void> {
  if (running) return;
  // 已经翻译过就不重复翻译；要重来请先还原（避免插入两份译文）。
  if (renderer) return;

  const settings: Settings = await loadSettings();
  const collected = collectSegments(document.body, { targetLang: settings.targetLang });
  if (collected.length === 0) {
    toast('没有找到需要翻译的内容');
    return;
  }

  running = true;
  lastError = null;
  displayMode = settings.displayMode;
  finished.clear();
  failedIds.clear();
  segments = collected;
  renderer = new DomRenderer(document, settings.displayMode, (segmentId) => void retrySegment(segmentId, settings));

  for (const segment of segments) renderer.mount(segment, 'pending');

  const textSegments: TextSegment[] = segments.map((s) => ({ id: s.id, text: s.text, order: s.order }));
  const batches = planBatches(textSegments, {
    maxBatchChars: settings.maxBatchChars,
    maxSegmentsPerBatch: settings.maxSegmentsPerBatch,
  });

  try {
    await runPool(
      batches.map((batch) => async () => {
        const response = await sendToBackground({
          type: MSG.TRANSLATE_TEXTS,
          payload: {
            items: batch.map((segment) => ({ id: segment.id, text: segment.text })),
            targetLang: settings.targetLang,
          },
        });

        if (!response.ok) {
          lastError = describeError(response);
          for (const segment of batch) {
            failedIds.add(segment.id);
            renderer?.fail(segment.id, response.message);
          }
          return;
        }
        for (const result of response.results) {
          if (result.text === null) {
            failedIds.add(result.id);
            renderer?.fail(result.id, result.message ?? '翻译失败');
          } else {
            finished.add(result.id);
            renderer?.update(result.id, result.text);
          }
        }
      }),
      settings.concurrency,
    );
  } finally {
    running = false;
  }

  if (lastError) toast(lastError);
}

async function retrySegment(segmentId: string, settings: Settings): Promise<void> {
  const segment = segments.find((s) => s.id === segmentId);
  if (!segment) return;
  failedIds.delete(segmentId);
  renderer?.mount(segment, 'pending');

  const response = await sendToBackground({
    type: MSG.TRANSLATE_TEXTS,
    payload: { items: [{ id: segment.id, text: segment.text }], targetLang: settings.targetLang },
  });

  if (!response.ok) {
    failedIds.add(segmentId);
    renderer?.fail(segment.id, response.message);
    toast(describeError(response));
    return;
  }
  const [result] = response.results;
  if (result && result.text !== null) {
    finished.add(segment.id);
    renderer?.update(segment.id, result.text);
  } else {
    failedIds.add(segmentId);
    renderer?.fail(segment.id, result?.message ?? '翻译失败');
  }
}

function restorePage(): void {
  renderer?.restore();
  renderer = null;
  segments = [];
  finished.clear();
  failedIds.clear();
  lastError = null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = (message as { type?: string } | null)?.type;

  if (type === MSG.TRANSLATE_PAGE) {
    void translatePage().then(() => sendResponse(currentState()));
    return true;
  }
  if (type === MSG.RESTORE_PAGE) {
    restorePage();
    sendResponse(currentState());
    return false;
  }
  if (type === MSG.TOGGLE_PAGE) {
    if (renderer) {
      restorePage();
      sendResponse(currentState());
      return false;
    }
    void translatePage().then(() => sendResponse(currentState()));
    return true;
  }
  if (type === MSG.GET_PAGE_STATE) {
    sendResponse(currentState());
    return false;
  }
  return false;
});
```

- [ ] **Step 3: 运行类型检查**

Run: `npm run typecheck`

Expected: 退出码 0。

- [ ] **Step 4: 构建**

Run: `npm run build`

Expected: 退出码 0，`dist/content.js` 存在且是单文件（不含 `import` 语句）。

Run: `Select-String -Path dist/content.js -Pattern '^import ' -Quiet`

Expected: 无输出（即 `$false`）。若为 `$true`，说明内容脚本被打成了 ESM，检查 `vite.content.config.ts` 的 `lib.formats`。

- [ ] **Step 5: 提交**

```bash
git add src/content/toast.ts src/content/index.ts
git commit -m "feat(content): 内容脚本编排、并发批次与页面提示"
```

---

## Task 18: 弹窗 UI

> 本任务是设计文档 §7.1 弹窗规格的**子集**。规格中的「显示模式分段控件」「悬停/划词快捷开关」「站点规则命中提示」依赖 Plan 2 的能力，此处不做——不要为了对齐规格而提前实现它们。

**Files:**
- Modify: `src/popup/popup.html`
- Create: `src/popup/popup.css`
- Modify: `src/popup/popup.ts`

- [ ] **Step 1: 写弹窗结构**

```html
<!-- src/popup/popup.html -->
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="./popup.css" />
    <title>浸译</title>
  </head>
  <body>
    <header class="header">
      <span class="brand">浸译</span>
      <button id="open-options" class="icon-button" type="button" title="设置">⚙</button>
    </header>

    <button id="toggle" class="primary" type="button">翻译此页</button>
    <p id="status" class="status"></p>

    <label class="field">
      <span>目标语言</span>
      <select id="target-lang"></select>
    </label>

    <label class="field">
      <span>翻译引擎</span>
      <select id="engine"></select>
    </label>

    <p id="engine-hint" class="hint"></p>

    <script type="module" src="./popup.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: 写弹窗样式**

```css
/* src/popup/popup.css */
:root {
  color-scheme: light dark;
}

body {
  width: 320px;
  margin: 0;
  padding: 12px 14px 16px;
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.brand {
  font-weight: 600;
  letter-spacing: 0.04em;
}

.icon-button {
  border: none;
  background: transparent;
  font-size: 16px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}

.icon-button:hover {
  background: rgba(127, 127, 127, 0.16);
}

.primary {
  width: 100%;
  padding: 9px 12px;
  font: inherit;
  font-weight: 500;
  color: #fff;
  background: #2b6cb0;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.primary:hover {
  background: #24598f;
}

.primary[data-active="true"] {
  background: #4a5568;
}

.status {
  min-height: 1.4em;
  margin: 8px 2px 12px;
  font-size: 12px;
  opacity: 0.72;
}

.field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.field > span {
  flex: 0 0 auto;
  font-size: 13px;
  opacity: 0.86;
}

.field > select {
  flex: 1 1 auto;
  min-width: 0;
  padding: 5px 6px;
  font: inherit;
  font-size: 13px;
  border-radius: 6px;
  border: 1px solid rgba(127, 127, 127, 0.4);
  background: transparent;
}

.hint {
  margin: 4px 2px 0;
  font-size: 12px;
  line-height: 1.5;
  opacity: 0.7;
}

.hint.warn {
  color: #b3261e;
  opacity: 1;
}
```

- [ ] **Step 3: 写弹窗逻辑**

```ts
// src/popup/popup.ts
import { LANGUAGES } from '../core/lang';
import { ENGINES, getEngine } from '../engines/registry';
import { MSG, type PageState } from '../shared/messages';
import { loadSettings, saveSettings, type Settings } from '../shared/settings';

const toggleButton = document.getElementById('toggle') as HTMLButtonElement;
const statusText = document.getElementById('status') as HTMLParagraphElement;
const targetLangSelect = document.getElementById('target-lang') as HTMLSelectElement;
const engineSelect = document.getElementById('engine') as HTMLSelectElement;
const engineHint = document.getElementById('engine-hint') as HTMLParagraphElement;
const optionsButton = document.getElementById('open-options') as HTMLButtonElement;

let settings: Settings;

function fillSelect(select: HTMLSelectElement, entries: Array<{ value: string; label: string }>, value: string): void {
  select.textContent = '';
  for (const entry of entries) {
    const option = document.createElement('option');
    option.value = entry.value;
    option.textContent = entry.label;
    option.selected = entry.value === value;
    select.append(option);
  }
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function queryState(): Promise<PageState | null> {
  const tabId = await activeTabId();
  if (tabId === null) return null;
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: MSG.GET_PAGE_STATE })) as PageState;
  } catch {
    // chrome:// 等受限页面上没有内容脚本，属于正常情况。
    return null;
  }
}

function renderState(state: PageState | null): void {
  if (!state) {
    toggleButton.disabled = true;
    toggleButton.textContent = '此页面不可用';
    statusText.textContent = '当前页面不支持翻译（浏览器内置页面或扩展商店页面）。';
    return;
  }
  toggleButton.disabled = false;
  toggleButton.dataset.active = String(state.translated);
  toggleButton.textContent = state.translated ? '显示原文' : '翻译此页';
  statusText.textContent = state.translated
    ? `已翻译 ${state.done} / ${state.total} 段`
    : '按 Alt+T 也可以快速开关。';
}

function renderEngineHint(): void {
  const engine = getEngine(settings.engineId);
  const missingKey = engine.needsKey && settings.engineConfig.apiKey.trim().length === 0;
  if (missingKey) {
    engineHint.classList.add('warn');
    engineHint.textContent = '该引擎需要 API Key，请先在设置中填写。';
    return;
  }
  if (!engine.supportsGlossary && settings.glossary.length > 0) {
    engineHint.classList.remove('warn');
    engineHint.textContent = '当前引擎不支持术语表，术语表对其不生效。';
    return;
  }
  engineHint.classList.remove('warn');
  engineHint.textContent = engine.needsKey ? '使用你自己配置的接口。' : '零配置可用，无需 API Key。';
}

async function persist(): Promise<void> {
  await saveSettings(settings);
}

async function refreshState(): Promise<void> {
  renderState(await queryState());
}

async function init(): Promise<void> {
  settings = await loadSettings();
  fillSelect(
    targetLangSelect,
    LANGUAGES.map((lang) => ({ value: lang.code, label: lang.label })),
    settings.targetLang,
  );
  fillSelect(
    engineSelect,
    ENGINES.map((engine) => ({ value: engine.id, label: engine.name })),
    settings.engineId,
  );
  renderEngineHint();
  await refreshState();

  toggleButton.addEventListener('click', async () => {
    const tabId = await activeTabId();
    if (tabId === null) return;
    // 用 TOGGLE_PAGE 而不是让弹窗自己判断方向：状态的唯一真相在内容脚本里，
    // 弹窗里的 dataset 只用于渲染，不能作为决策依据。
    toggleButton.disabled = true;
    try {
      const state = (await chrome.tabs.sendMessage(tabId, { type: MSG.TOGGLE_PAGE })) as PageState;
      renderState(state);
    } catch {
      renderState(null);
    } finally {
      toggleButton.disabled = false;
    }
  });

  targetLangSelect.addEventListener('change', async () => {
    settings = { ...settings, targetLang: targetLangSelect.value };
    await persist();
  });

  engineSelect.addEventListener('change', async () => {
    settings = { ...settings, engineId: engineSelect.value };
    await persist();
    renderEngineHint();
  });

  optionsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

void init();
```

- [ ] **Step 4: 运行类型检查与构建**

Run: `npm run typecheck`

Expected: 退出码 0。

Run: `npm run build`

Expected: 退出码 0，`dist/popup/popup.html`、`dist/popup/popup.js` 存在。

- [ ] **Step 5: 提交**

```bash
git add src/popup
git commit -m "feat(popup): 翻译开关、语言与引擎选择"
```

---

## Task 19: 端到端手动验收与 README

**Files:**
- Create: `README.md`

- [ ] **Step 1: 跑全量单测**

Run: `npm test`

Expected: 全部测试文件通过，0 失败。把实际用例数记录到提交信息里。

- [ ] **Step 2: 构建并加载扩展**

Run: `npm run build`

然后在 Chrome 打开 `chrome://extensions` → 打开右上角"开发者模式" → 点"加载已解压的扩展程序" → 选择 `D:\翻译-插件\dist`。

Expected: 扩展出现在列表中且无错误徽章；工具栏出现"浸译"图标。

- [ ] **Step 3: 逐项手动验收（每项都要真实操作并记录结果）**

1. 打开一篇维基百科英文长条目 → 按 `Alt+T` → 正文各段落下方出现蓝色译文；再按 `Alt+T` → 页面完全还原。
2. 打开 Medium 上任意一篇长文（弹性布局为主）→ 翻译 → 译文**换行显示在原文下方**，没有被挤到同一行，也没有撑破容器宽度。
3. 打开 `https://developer.mozilla.org/` 任一含表格的文档页 → 翻译 → 表格单元格译文**留在单元格内**，表格结构未错位。
4. 打开 X/Twitter 或任一 SPA 站点 → 翻译 → 页面不卡死、不报错（增量翻译属 Plan 2，此处只需确认不崩）。
5. 断网 → 翻译一个页面 → 译文位置显示红色"翻译失败"和"重试"按钮；恢复网络后点"重试" → 该段出现译文。
6. 在设置页把引擎切到 openai-compat 但不填 Key → 弹窗显示红色提示 → 翻译页面 → 提示"尚未填写 API Key"。
7. 填入可用的 OpenAI 兼容 Key 与模型 → 翻译同一页面 → 译文正确、段落数与原文一致。
8. 再次按 `Alt+T` 还原后重新翻译同一页面 → **DevTools Network 面板中除页面自身请求外，不应出现新的翻译请求**（全部命中缓存）。
9. 打开一个中文页面 → 翻译 → 提示"没有找到需要翻译的内容"或直接跳过，不发翻译请求。
10. 右键菜单：页面空白处右键 → "翻译此页" 生效；选中一段文字右键 → "翻译选中文本" 不报错（气泡 UI 属 Plan 2）。

任何一项不符合预期，就回到对应 Task 修复后重新执行本步骤。

- [ ] **Step 4: 写 `README.md`**

````markdown
# 浸译

沉浸式网页翻译浏览器扩展：保留原文，在每段下方就地插入译文。

## 安装

1. `npm install`
2. `npm run build`
3. Chrome/Edge 打开 `chrome://extensions`，开启「开发者模式」
4. 点「加载已解压的扩展程序」，选择本仓库的 `dist` 目录

## 使用

- `Alt+T`：翻译当前页面 / 显示原文
- 点击工具栏图标：翻译此页、切换目标语言与引擎
- 右键菜单：翻译此页、翻译选中文本

## 翻译引擎

| 引擎 | 是否需要 Key | 说明 |
| --- | --- | --- |
| Google 免费接口 | 否 | 默认引擎，装好即用 |
| OpenAI 兼容 API | 是 | 设置页填接口地址、API Key、模型名；兼容 OpenAI / DeepSeek / 硅基流动 / Ollama 等 |

免费接口不稳定时，建议在设置页切换到自己的接口。

## 开发

```bash
npm run dev:main      # 监听 popup / options / background
npm run dev:content   # 监听内容脚本（另开一个终端）
npm test              # 单元测试
npm run typecheck     # 类型检查
```

## 隐私

- API Key 只存在本机 `chrome.storage.local`，不上传、不同步。
- 除翻译请求本身外，不发起任何网络请求，不采集任何浏览数据。
- 译文一律以纯文本写入页面，不执行任何来自接口的 HTML 或脚本。
````

- [ ] **Step 5: 提交**

```bash
git add README.md
git commit -m "docs: 安装、使用与开发说明"
```

---

## 完成标准

全部满足才算 Plan 1 完成：

- [ ] `npm test` 全绿，`npm run typecheck` 无错误
- [ ] `npm run build` 产出的 `dist/` 能直接加载，`content.js` 为单文件 IIFE
- [ ] Task 19 的 10 项手动验收全部通过，尤其第 8 项（缓存命中零请求）
- [ ] git 历史中每个 Task 至少一次提交

## Plan 2 待办（不在本计划范围）

整页替换模式接入弹窗、悬停段落翻译、划词翻译气泡、MutationObserver 增量翻译、
完整设置页（引擎配置 / 站点规则 / 术语表编辑 / 提示词 / 高级 / 关于）、
`glossary.ts` 独立模块与术语表提示词注入、Bing 备用引擎、`npm run zip` 打包脚本。
