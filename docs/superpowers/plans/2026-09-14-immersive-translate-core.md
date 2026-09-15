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
| `src/core/cache.ts` | 两级翻译缓存（session → local，写串行化 + 按最后命中时间淘汰 + prune 对账） |
| `src/engines/types.ts` | `Translator` 接口、`EngineError`、共享类型 |
| `src/engines/google.ts` | 免费 Google 网页接口 |
| `src/engines/openai-compat.ts` | OpenAI 兼容 `/chat/completions`，编号分段协议 |
| `src/engines/registry.ts` | 引擎注册表 |
| `src/shared/settings.ts` | 设置 schema、默认值、合并与读写 |
| `src/shared/messages.ts` | 类型化消息协议 |
| `src/shared/chrome-area.ts` | `chrome.storage.StorageArea` → 可测试接口的适配器 |
| `src/background/scheduler.ts` | 单批次：缓存命中、引擎调用、退避重试、降级 |
| `src/background/service-worker.ts` | 消息路由、快捷键、右键菜单（启动时 `cache.prune()` 对账索引） |
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
    configHash: 'cfg-openai-gpt-4o-mini',
    sourceLang: 'auto',
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
    expect(buildCacheKey({ ...base, configHash: 'cfg-openai-gpt-4o' })).not.toBe(key);
  });

  /**
   * 源语言是设置项、会一路传到 `TranslateRequest.from`，不参与 key 就会命中按另一种
   * 源语言语义翻出来的旧译文（今天两个引擎都还没读 `from`，所以这条是防御性的：
   * 等接上就用错语义，而且事后无法自愈）。
   */
  it('源语言变化会改变 key', () => {
    const key = buildCacheKey(base);
    expect(buildCacheKey({ ...base, sourceLang: 'en' })).not.toBe(key);
    expect(buildCacheKey({ ...base, sourceLang: 'ja' })).not.toBe(key);
    // 'auto' 与具体语言是两种语义，不能共用 key。
    expect(buildCacheKey({ ...base, sourceLang: 'zh-Hans' })).not.toBe(key);
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
  /**
   * 引擎配置指纹（接口地址 + 模型名）。
   * openai-compat 下用户可以随时改模型（gpt-4o-mini → gpt-4o）或接口地址，
   * 这两项不参与 key 就会命中上一个模型的旧译文。
   * **apiKey 不进这里**：换 key 不该让全部缓存失效；且哈希输入会落进 storage，
   * 密钥不该出现在缓存键的输入里。它只影响鉴权，不影响译文本身。
   */
  configHash: string;
  /**
   * 源语言。`sourceLang` 是设置项，会一路传到 `TranslateRequest.from`；它不参与 key 时，
   * 用户把「自动检测」改成某个具体源语言（或反过来）之后，同一个引擎、同一段文本、同一个
   * 目标语言会命中**按另一种源语言语义**翻出来的旧译文，而且事后无法自愈。
   * 今天两个引擎都还没真的读 `from`（Google 把 `sl=auto` 硬编码），所以这条还没有可观察
   * 的错误；等接上就用错语义——key 必须在那之前就带上它。
   */
  sourceLang: string;
  targetLang: string;
  glossaryHash: string;
  promptHash: string;
  text: string;
}

/** 用 \u0000 分隔，避免字段拼接产生歧义（如 ("ab","c") 与 ("a","bc")）。 */
export function buildCacheKey(parts: CacheKeyParts): string {
  return hashString(
    [
      parts.engineId,
      parts.configHash,
      parts.sourceLang,
      parts.targetLang,
      parts.glossaryHash,
      parts.promptHash,
      parts.text,
    ].join('\u0000'),
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
import { detectHanVariant, detectScript, isTranslatableText, normalizeText, shouldSkip } from '../../src/core/lang';

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

describe('detectHanVariant', () => {
  it('识别繁体特征字', () => {
    expect(detectHanVariant('這是繁體中文')).toBe('hant');
  });

  it('识别简体特征字', () => {
    expect(detectHanVariant('这是简体中文')).toBe('hans');
  });

  it('没有任何简繁特征字时判 unknown', () => {
    expect(detectHanVariant('你好世界')).toBe('unknown');
  });

  it('两类特征字数量相等时判 unknown', () => {
    expect(detectHanVariant('这這')).toBe('unknown');
  });

  it('数量多者胜', () => {
    expect(detectHanVariant('这个们来说 這是')).toBe('hans');
    expect(detectHanVariant('這是繁體中文 this 这')).toBe('hant');
  });

  it('非中文字符不参与计数', () => {
    expect(detectHanVariant('這是 Japanese です')).toBe('hant');
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

  it('目标繁體中文时只在文本已是繁体时跳过（简繁互转不走 no-op 快路径）', () => {
    expect(shouldSkip('这是简体中文', 'zh-Hant')).toBe(false);
    // 原断言把 '這是繁體中文' 也钉成 false（HANT_TARGET 一刀切），与「同变体才跳过」的新口径互斥；
    // 按新口径改为 true，异议与理由见留档 §8.1。
    expect(shouldSkip('這是繁體中文', 'zh-Hant')).toBe(true);
  });

  it('文本与目标简繁变体不同时不跳过（需要简繁转换）', () => {
    expect(shouldSkip('這是繁體中文段落', 'zh-Hans')).toBe(false);
    expect(shouldSkip('这是简体中文段落', 'zh-Hant')).toBe(false);
  });

  it('文本已是目标简繁变体时跳过', () => {
    expect(shouldSkip('这是简体中文段落', 'zh-Hans')).toBe(true);
    expect(shouldSkip('這是繁體中文段落', 'zh-Hant')).toBe(true);
  });

  it('没有任何简繁特征字的纯中文按字符集判定跳过', () => {
    expect(shouldSkip('没有简繁特征的纯中文', 'zh-Hans')).toBe(true);
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

export type HanVariant = 'hans' | 'hant' | 'unknown';

/**
 * 只在某一字体出现的高频字。两组**严格一一对应**：`HANS_ONLY[i]` 与 `HANT_ONLY[i]`
 * 是同一个字的两种写法，增删必须成对，否则计数会天然偏向更长的那一组。
 * 选的都是在两岸三地日常文本里高频出现的字，单段文本里出现一两个就足以定性。
 */
const HANS_ONLY =
  '这个们来说国会对时过开关学样么产业发经长问题实现应该东车马鸟风云电气万与专从见门体书买卖乐习义为广庆龙';
const HANT_ONLY =
  '這個們來說國會對時過開關學樣麼產業發經長問題實現應該東車馬鳥風雲電氣萬與專從見門體書買賣樂習義為廣慶龍';

/**
 * 靠「只在某一字体出现的高频字」分辨简繁：两边各计一次，多者胜。
 * 数量相等（含两边都是 0，即整段没有任何简繁特征字）返回 'unknown'——
 * 这一层没有更多信息，怎么判都可能错，交给调用方按保守方向处理（见 shouldSkip）。
 */
export function detectHanVariant(text: string): HanVariant {
  let hans = 0;
  let hant = 0;
  for (const char of text) {
    if (HANS_ONLY.includes(char)) hans += 1;
    else if (HANT_ONLY.includes(char)) hant += 1;
  }
  if (hans > hant) return 'hans';
  if (hant > hans) return 'hant';
  return 'unknown';
}

/**
 * 目标语言的简繁变体。只认显式变体（'zh-Hans*' / 'zh-Hant*'）：
 * 裸 'zh' 与 'zh-CN' / 'zh-TW' 这类只带地区的写法分辨不了简繁，返回 undefined，
 * 由 shouldSkip 走「不跳过」——变体判不出来时多翻一遍，好过静默漏翻。
 */
function targetHanVariant(code: string): HanVariant | undefined {
  if (/^zh-hant(?:-|$)/.test(code)) return 'hant';
  if (/^zh-hans(?:-|$)/.test(code)) return 'hans';
  return undefined;
}

/**
 * 段落已经是指定目标语言时无需翻译。
 * 非中文目标：只有目标字符集严格领先才跳过，与其它字符集同分时宁可翻译——
 * 跳过等于放弃翻译，错一边就是漏翻（'Hi 你好' 这类极短混排任何多数决都不可靠）。
 * 中文目标：`ScriptLang` 只到字符集一级（zh-Hant 与 zh-Hans 都是 'zh'），
 * 靠 detectHanVariant 分辨简繁——文本与目标**同变体**才跳过；异变体必须翻译，
 * 简繁互转正是在这一步发生的，一刀切跳过会让它变成静默 no-op。
 *
 * 已知限制：**纯汉字、不含假名的日文**会被判成中文。
 * `'東京都港区赤坂'` 这类只有汉字的日文，字符全部落在 `SCRIPT_RANGES` 的 CJK 区间里，
 * `detectScript` 只能给出 `'zh'`，于是目标为中文时这里把它当成「已是目标语言」：
 * `zh-Hant` 下必跳（東是繁体特征字），`zh-Hans` 下只要整段没有特征字也跳，
 * 这一整段就永远不翻。
 *
 * 这在**单段文本**层面不可判：汉字是简繁日共用的书写系统，不看上下文没有任何依据，
 * 加什么启发式都只是换一种错法。唯一可靠的办法是文档级上下文——整页出现过假名
 * 就把全页按日文处理，段落再继承这个判断。那要求 `shouldSkip` 拿到整页信息
 * （改签名或引入状态），属于内容脚本接线的设计。Plan 1 的 core 是纯函数层，
 * 只回答「这一段像不像目标语言」，不持有页面状态，所以不做；
 * 等它真正接到内容脚本上（目前尚无生产调用点）再在**调用方**补页面级判定，
 * 不要在这里塞启发式。
 */
export function shouldSkip(text: string, targetLang: string): boolean {
  const code = targetLang.toLowerCase();
  const expected = TARGET_SCRIPT[baseLang(code)];
  if (expected === undefined) return false;

  const pick = pickScript(text);
  if (expected !== 'zh') return pick.lang === expected && !pick.tied;

  // 目标 base 是 'zh'：先确认段落本身是中文，含假名的日文、英文段落照常翻译。
  if (pick.lang !== 'zh') return false;

  const variant = targetHanVariant(code);
  if (variant === undefined) return false;

  // 整段没有任何简繁特征字（'你好世界'）：变体层面无信息，退回字符集判定，同分仍不跳过。
  const textVariant = detectHanVariant(text);
  if (textVariant === 'unknown') return !pick.tied;
  return textVariant === variant;
}
```

> 实现备注（口径的由来、候选对比与被否掉的口径见 `docs/superpowers/plans/2026-09-14-wu2-plan-amendment.md` §5、§7、§8）：
> `detectScript` 按各字符集**字符总数**分档取最高者，档位是 `1 + floor(log2(字数))`，
> 不是按「连续片段」计分：拉丁文天然被空格切成多段、中文一句话通常只有 1 段，
> 按片段计分会让结论取决于标点怎么切。实测 `'这是一段很长的中文内容需要翻译成英文。Hello world'`
> （中文 18 字 / 拉丁 10 字母）被判成 `latin`，目标为英文时整段跳过，18 个汉字一个不翻。
> 同分时先出现者优先，不依赖 `SCRIPT_RANGES` 的表序。
> 因此 `'你好世界 Hello'`（中文 4 字与拉丁 5 字母同档同分）判为 `zh`，
> 而 `'aaaaa 你好'`（拉丁字数是中文的两倍以上，跨档）正确判为 `latin`。
> `shouldSkip` 在**非中文目标**下只在目标字符集**严格领先**时返回 `true`：与其它字符集同分的混排段落
> （`'Hi 你好'`、`'你好 Hi'`）按低置信度处理，宁可不跳过——跳过等于放弃翻译，错一边就是漏翻。
> **中文目标**下 `ScriptLang` 只到字符集一级（`zh-Hant` 与 `zh-Hans` 都是 `'zh'`），分辨不了简繁，
> 改由 `detectHanVariant` 判定：段落与目标**同变体**才跳过，异变体必须翻译（简繁互转正是在这一步发生）；
> 整段没有任何简繁特征字（`'你好世界'`）时退回字符集判定，同分仍不跳过。
> 目标为 `zh-Hant` 不再一刀切跳过：那只是把简转繁变成 no-op，繁转简同样漏。

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
import { EngineError, RETRYABLE_CODES, toEngineError } from '../../src/engines/types';

describe('EngineError', () => {
  it('网络错误与限流可重试', () => {
    expect(new EngineError('NETWORK', 'x').retryable).toBe(true);
    expect(new EngineError('RATE_LIMIT', 'x').retryable).toBe(true);
  });

  it('文本过长不可重试：超长要靠切分而不是原样重发', () => {
    // 文本过长是确定性失败，拿同一段文本重问一次必然还是过长，只白烧两次请求；
    // 它该走的是调度器的切分降级。判据与调度器共用 RETRYABLE_CODES，不能各写一份。
    expect(RETRYABLE_CODES.has('TOO_LONG')).toBe(false);
    expect(new EngineError('TOO_LONG', 'x').retryable).toBe(false);
  });

  it('鉴权失败与格式错误不可重试', () => {
    expect(new EngineError('AUTH', 'x').retryable).toBe(false);
    expect(new EngineError('BAD_RESPONSE', 'x').retryable).toBe(false);
  });

  it('retryable 只由导出的 RETRYABLE_CODES 决定', () => {
    expect([...RETRYABLE_CODES].sort()).toEqual(['NETWORK', 'RATE_LIMIT']);
    for (const code of ['NETWORK', 'RATE_LIMIT', 'AUTH', 'TOO_LONG', 'BAD_RESPONSE', 'ABORTED', 'UNKNOWN'] as const) {
      expect(new EngineError(code, 'x').retryable).toBe(RETRYABLE_CODES.has(code));
    }
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
  | 'BAD_REQUEST'
  | 'TOO_LONG'
  | 'BAD_RESPONSE'
  | 'ABORTED'
  | 'UNKNOWN';

/**
 * 可退避重试的错误码：网络抖动与限流重发还有机会成功。
 *
 * 有意不含这两个：
 * - `TOO_LONG`：文本过长是确定性失败，拿同一段文本原样重发必然还是过长，它该走切分降级。
 * - `BAD_REQUEST`：服务端明确说"你这个请求不对"（模型名写错、参数不合法…），重发多少次
 *   都是同一个 400。把它归进 `NETWORK` 会让调度器白重试三次、页面上再挂一排点了也没用的
 *   重试按钮——用户真正需要的是看到服务商给的原因，然后去设置页改。
 *
 * 这是全仓唯一一份判据，调度器与内容脚本直接复用它，避免几处集合各说各话。
 */
export const RETRYABLE_CODES: ReadonlySet<EngineErrorCode> = new Set<EngineErrorCode>([
  'NETWORK',
  'RATE_LIMIT',
]);

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly retryable: boolean;

  constructor(code: EngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EngineError';
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
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
  return [translations.map((t) => [t, 'source', null, null, 10]), null, 'en'];
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

  it('429 不做条目级重试，直接上抛交给调度器的批次退避', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 429));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      googleEngine.translate(
        { texts: ['A', 'B'], from: 'auto', to: 'zh-Hans', signal: new AbortController().signal },
        {},
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMIT' });

    // 每条只发一次。若把 429 也算进条目级重试，这里会变成 6 次——
    // 限流时每条文本各烧 3 次额度，只会把限额打得更狠。
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it('响应体不是合法 JSON 时抛 BAD_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>oops</html>', { status: 200 })));
    await expect(
      googleEngine.translate(
        { texts: ['A'], from: 'auto', to: 'zh-Hans', signal: new AbortController().signal },
        {},
      ),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('批内单条瞬时抖动只重发该条，不重发整批', async () => {
    // 12 条批次里第 11 条抖一次就不该实打实发出两倍的文本量：
    // 条目级重试必须发生在引擎内部，调度器那边只看得见"整批失败"。
    const texts = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
    const attempts = new Map<string, number>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const query = new URL(String(input)).searchParams.get('q') ?? '';
      const seen = (attempts.get(query) ?? 0) + 1;
      attempts.set(query, seen);
      // 第 3 条第一次调用抖一次，第二次成功；其余全部一次成功。
      if (query === 't3' && seen === 1) throw new TypeError('failed to fetch');
      return jsonResponse(googleBody([`译:${query}`]));
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await googleEngine.translate(
      { texts, from: 'auto', to: 'zh-Hans', signal: new AbortController().signal },
      {},
    );

    expect(out).toEqual(texts.map((text) => `译:${text}`));
    // 8 条文本 + 第 3 条的那一次重发 = 9；整批重发会是 16。
    expect(fetchMock).toHaveBeenCalledTimes(9);
    for (const text of texts) expect(attempts.get(text)).toBe(text === 't3' ? 2 : 1);
  });

  it('单个批次内部并发不超过 4', async () => {
    let inFlight = 0;
    let peak = 0;
    const waiting: Array<() => void> = [];

    // 让请求在「凑够 4 个同时在飞」之前不返回，从而真实观测到并发峰值。
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length >= 4) waiting.splice(0).forEach((release) => release());
      });
      inFlight -= 1;
      const query = new URL(String(input)).searchParams.get('q') ?? '';
      return jsonResponse(googleBody([`译:${query}`]));
    });
    vi.stubGlobal('fetch', fetchMock);

    const texts = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
    const out = await googleEngine.translate(
      { texts, from: 'auto', to: 'zh-Hans', signal: new AbortController().signal },
      {},
    );

    expect(peak).toBeLessThanOrEqual(4);
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(out).toEqual(texts.map((text) => `译:${text}`));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/engines/google.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/engines/google.ts
import { runPool } from '../core/pool';
import { describeHttpError, statusToErrorCode } from './api-error';
import { EngineError, toEngineError, type EngineConfig, type TranslateRequest, type Translator } from './types';

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

/**
 * 单个批次内部的并发上限。
 * 免费接口对突发请求很敏感：一个批次最多 12 段文本、内容脚本又有 3 路并发，
 * 无上限时最坏会同时打出 36 个请求，直接触发限流；429 又会让整批退避重试，反而打出更多请求。
 */
const MAX_CONCURRENCY = 4;

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
  if (!response.ok) {
    // 免费接口出错时也可能返回 HTML 或 JSON 正文；4xx 是"请求不对"，不该当成可重试的
    // 网络故障让调度器白退避三次。
    throw new EngineError(statusToErrorCode(response.status), await describeHttpError(response));
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (raw) {
    throw new EngineError('BAD_RESPONSE', `接口返回的不是合法 JSON：${toEngineError(raw).message}`);
  }

  return parseGoogleResponse(data);
}

/** 单条文本的瞬时失败重试次数与退避；批内一条抖动不该让整批重发。 */
const ITEM_RETRY_DELAYS_MS = [200, 600];

/**
 * 条目级的抖动吸收：一次 `translate()` 内部摊成了 N 个独立 fetch，
 * 谁来重试必须按条目算，否则调度器只看得见「整批失败」，把已经成功的 N-1 条一起重发。
 *
 * **只吸收网络抖动**。这不是把「瞬时错误」照抄一遍，而是有意收窄：
 * - 429 限流需要的是长退避，200ms/600ms 的快速重试救不回来，每条文本还各烧 3 次额度，
 *   反而把限额打得更狠。让它原样上抛，由调度器的批次级退避（500ms / 1500ms）统一处理。
 * - 鉴权失败、请求取消、文本过长重试多少次结果都一样；`TOO_LONG` 必须上抛给切分降级。
 */
const ITEM_RETRY_CODES: ReadonlySet<string> = new Set(['NETWORK']);

async function translateOneWithRetry(text: string, to: string, signal: AbortSignal): Promise<string> {
  let last: unknown;
  for (let attempt = 0; attempt <= ITEM_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await translateOne(text, to, signal);
    } catch (raw) {
      last = raw;
      const error = toEngineError(raw);
      if (!ITEM_RETRY_CODES.has(error.code)) throw error;
      if (attempt < ITEM_RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, ITEM_RETRY_DELAYS_MS[attempt]));
      }
    }
  }
  throw toEngineError(last);
}

export const googleEngine: Translator = {
  id: 'google',
  name: 'Google 免费接口',
  needsKey: false,
  supportsGlossary: false,
  async translate(request: TranslateRequest, _config: EngineConfig): Promise<string[]> {
    // 免费接口不支持一次请求多条文本，只能逐条发出；用并发池限制突发。
    const tasks = request.texts.map(
      (text) => () => translateOneWithRetry(text, request.to, request.signal),
    );
    return runPool(tasks, MAX_CONCURRENCY);
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
import { EngineError, RETRYABLE_CODES } from '../../src/engines/types';

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

  it('分段内容为空抛 BAD_RESPONSE', () => {
    let caught: unknown;
    try {
      parseNumberedResponse('<<<1>>><<<2>>>\n你好', 2);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).code).toBe('BAD_RESPONSE');
  });

  it('分段只有空白也抛 BAD_RESPONSE', () => {
    let caught: unknown;
    try {
      parseNumberedResponse('<<<1>>>\n   \n<<<2>>>\n你好', 2);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).code).toBe('BAD_RESPONSE');
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

  it('400 抛 BAD_REQUEST，并把服务商给的原因原样带到文案里', async () => {
    // 实测场景：模型名填成 `deepseek`（正确值是 `deepseek-chat`），DeepSeek 就是这么回应的。
    // 之前这里归成 NETWORK、且正文被丢掉，用户只看到「接口 HTTP 400」，完全查不出原因。
    //
    // 必须用 mockImplementation 而不是 mockResolvedValue：后者每次返回**同一个** Response
    // 对象，而响应体只能读一次，第二次调用会因为流已消费而拿不到正文。
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Model Not Exist', type: 'invalid_request_error' } }), {
            status: 400,
          }),
      ),
    );

    const error = await openAiCompatEngine.translate(request(['A']), CONFIG).catch((raw: unknown) => raw);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe('BAD_REQUEST');
    expect((error as EngineError).message).toContain('Model Not Exist');
  });

  it('400 不可重试：不该让调度器白退避三次，也不该给用户挂没用的重试按钮', () => {
    expect(RETRYABLE_CODES.has('BAD_REQUEST')).toBe(false);
  });

  it('500 仍归 NETWORK（可重试），但同样带上正文原因', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () => new Response(JSON.stringify({ error: { message: 'upstream busy' } }), { status: 503 }),
      ),
    );

    const error = await openAiCompatEngine.translate(request(['A']), CONFIG).catch((raw: unknown) => raw);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe('NETWORK');
    expect((error as EngineError).message).toContain('upstream busy');
    expect(RETRYABLE_CODES.has('NETWORK')).toBe(true);
  });

  it('响应缺少 content 抛 BAD_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 })));
    await expect(openAiCompatEngine.translate(request(['A']), CONFIG)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('响应体不是合法 JSON 时抛 BAD_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>oops</html>', { status: 200 })));
    await expect(openAiCompatEngine.translate(request(['A']), CONFIG)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('接口地址不是合法 URL 时抛 AUTH 并说明地址有问题', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      openAiCompatEngine.translate(request(['A']), { ...CONFIG, baseUrl: 'api.example.com/v1' }),
    ).rejects.toMatchObject({ code: 'AUTH', message: expect.stringContaining('不是合法的 URL') });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * manifest 只声明了 `optional_host_permissions`，而 Chrome 要求可选权限在用户手势里申请。
   * 没授权就发请求时浏览器会把它拦下，而我们拿到的只是一个失败的 fetch——错误会伪装成
   * `NETWORK`（"断网"），用户查不出原因也找不到该去哪儿点。所以发请求**之前**先查一次权限。
   */
  it('未授权该 origin 时抛 AUTH 并指路设置页，且一个请求都不发', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const contains = vi.fn().mockResolvedValue(false);
    vi.stubGlobal('chrome', { permissions: { contains } });

    await expect(openAiCompatEngine.translate(request(['A']), CONFIG)).rejects.toMatchObject({
      code: 'AUTH',
      message: expect.stringContaining('未授权访问该接口地址，请到设置页保存一次以授权'),
    });

    // 查的是这个端点自己的 origin 模式，不是别的什么串。
    expect(contains).toHaveBeenCalledWith({ origins: ['https://api.example.com/*'] });
    // 关键：拦在 fetch 之前——被浏览器拦下就只剩一个伪装成 NETWORK 的失败。
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('已授权该 origin 时照常发请求', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好'));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('chrome', { permissions: { contains: vi.fn().mockResolvedValue(true) } });

    await expect(openAiCompatEngine.translate(request(['A']), CONFIG)).resolves.toEqual(['你好']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('没有权限 API 的环境（纯 Node 单测）不做权限判断', async () => {
    // `vi.stubGlobal('chrome', …)` 一次都不调：`typeof chrome === 'undefined'` 这条路
    // 就是引擎能在纯 Node 里被单测的前提，上面所有既有用例其实都在走它。
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(openAiCompatEngine.translate(request(['A']), CONFIG)).resolves.toEqual(['你好']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/engines/openai-compat.test.ts`

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写实现**

```ts
// src/engines/openai-compat.ts
import { hasHostPermission, originPattern } from '../shared/host-permission';
import { describeHttpError, statusToErrorCode } from './api-error';
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

/** 按编号标记切回逐条译文；数量、顺序或分段内容为空一律抛 BAD_RESPONSE，由上层降级为逐条翻译。 */
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
    const text = content.slice(start, end).trim();
    if (text.length === 0) {
      throw new EngineError('BAD_RESPONSE', `模型返回的第 ${i + 1} 段为空`);
    }
    parts.push(text);
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

    /**
     * 发请求**之前**确认这个 origin 已经被用户授权。
     *
     * manifest 只声明了 `optional_host_permissions`，而 Chrome 要求可选权限在用户手势里
     * 申请（设置页的「保存」按钮做这件事）。没申请就发请求时浏览器会把它拦下，而我们拿到的
     * 只是一个失败的 fetch——错误会伪装成 `NETWORK`（"断网"），用户查不出真正的原因，
     * 也找不到该去哪儿点。
     *
     * 没有权限 API 的环境（纯 Node 单测）里 `hasHostPermission` 恒为 true：
     * 引擎必须保持可独立单测。
     */
    const pattern = originPattern(baseUrl);
    if (pattern === undefined) {
      throw new EngineError('AUTH', `接口地址不是合法的 URL：${baseUrl}，请在设置中修正`);
    }
    if (!(await hasHostPermission(pattern))) {
      throw new EngineError('AUTH', '未授权访问该接口地址，请到设置页保存一次以授权');
    }

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
    if (!response.ok) {
      // 服务商把真正的原因写在响应体里（DeepSeek 对写错的模型名会说 "Model Not Exist"），
      // 必须读出来给用户看，否则他只能对着一句"接口 HTTP 400"猜——这不是假想场景：
      // 实测就是模型名填成 `deepseek`（正确值是 `deepseek-chat`）卡住的，而界面上只有 400。
      throw new EngineError(statusToErrorCode(response.status), await describeHttpError(response));
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (raw) {
      throw new EngineError('BAD_RESPONSE', `接口返回的不是合法 JSON：${toEngineError(raw).message}`);
    }
    const payload = data as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload?.choices?.[0]?.message?.content;
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

/** 两种宿主配额的模拟开关，都按"`JSON.stringify` 后的 UTF-8 字节数"计量。 */
export interface MemoryStorageOptions {
  /**
   * 模拟宿主对**单个存储值**的上限（`QUOTA_BYTES_PER_ITEM`）：
   * 任一条值的字节数超过它，整批写入失败并抛错。
   */
  maxItemBytes?: number;
  /** 模拟存储区**总量**上限（`QUOTA_BYTES`）：写入后总量超过它，整批写入失败并抛错。 */
  maxTotalBytes?: number;
}

/** 与宿主一致的字节口径：值先 JSON 序列化，再按 UTF-8 计长。 */
function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
}

export class MemoryStorage implements StorageArea {
  private readonly data = new Map<string, unknown>();
  /** 每个 key 当前占用的字节数，用来在总量上限下即时算出写入后的占用。 */
  private readonly bytes = new Map<string, number>();
  /** 单条值上限；可随时调整 */
  maxItemBytes?: number;
  /** 总量上限；可随时调整——写满之后再调成当前占用，就能模拟"配额刚好用尽" */
  maxTotalBytes?: number;
  /** 记录写入**尝试**次数（含被配额拒绝的），用于断言缓存命中时没有多余写入 */
  setCalls = 0;
  /** 记录被配额拒绝的写入次数，用来断言"写失败"确实发生过 */
  rejectedWrites = 0;
  /** 历次成功写入里最大的单条值字节数，用来断言从没写出过大值 */
  maxItemBytesSeen = 0;

  constructor(options: MemoryStorageOptions = {}) {
    this.maxItemBytes = options.maxItemBytes;
    this.maxTotalBytes = options.maxTotalBytes;
  }

  async get(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (this.data.has(key)) out[key] = structuredClone(this.data.get(key));
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.setCalls += 1;
    const entries = Object.entries(items);

    // 先把"写完之后"的占用算出来，任何一条越界都整批不落盘（宿主也是整批失败）。
    const next = new Map(this.bytes);
    for (const [key, value] of entries) {
      const size = byteLength(value);
      if (this.maxItemBytes !== undefined && size > this.maxItemBytes) {
        this.rejectedWrites += 1;
        throw new Error(`单个存储值超出上限：${key} 需要 ${size} 字节`);
      }
      next.set(key, size);
    }
    if (this.maxTotalBytes !== undefined) {
      let total = 0;
      for (const size of next.values()) total += size;
      if (total > this.maxTotalBytes) {
        this.rejectedWrites += 1;
        throw new Error(`存储区总量超出上限：需要 ${total} 字节`);
      }
    }

    for (const [key, value] of entries) {
      const size = next.get(key) as number;
      this.maxItemBytesSeen = Math.max(this.maxItemBytesSeen, size);
      this.data.set(key, structuredClone(value));
      this.bytes.set(key, size);
    }
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.data.delete(key);
      this.bytes.delete(key);
    }
  }

  async keys(): Promise<string[]> {
    return [...this.data.keys()];
  }

  size(): number {
    return this.data.size;
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  /** 当前占用的总字节数 */
  bytesUsed(): number {
    let total = 0;
    for (const size of this.bytes.values()) total += size;
    return total;
  }
}
```

- [ ] **Step 2: 写失败的测试**

```ts
// tests/core/cache.test.ts
import { describe, expect, it } from 'vitest';
import { TieredCache, TranslationCache } from '../../src/core/cache';
import { MemoryStorage } from '../helpers/memory-storage';

/** 让指定序号的存储写失败，用来验证缓存写失败不会冒泡给调用方。 */
class FailingStorage extends MemoryStorage {
  writeAttempts = 0;

  constructor(private readonly failWrites: number[]) {
    super();
  }

  override async set(items: Record<string, unknown>): Promise<void> {
    const attempt = this.writeAttempts;
    this.writeAttempts += 1;
    if (this.failWrites.includes(attempt)) throw new Error('QUOTA_BYTES 超出配额');
    await super.set(items);
  }
}

/**
 * 可控时钟，用于验证"按最后命中时间淘汰"。
 *
 * 默认从**当前真实时间**起跳，而不是某个小常量：条目的时间戳来自模块级单调戳，
 * 同一个测试文件里前面的用例已经用真实 `Date.now()` 把它推到了 ~1.7e12。注入一个
 * 比它小的时钟会让条目的 `t` 恒大于 `now`，命中就不再触发刷新，LRU 断言会假失败。
 */
function fakeClock(start = Date.now()): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

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

  it('并发写入不丢条目，也不留下孤儿', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 100);
    const batches = Array.from({ length: 20 }, (_, i) => new Map([[`h${i}`, `${i}`]]));

    await Promise.all(batches.map((batch) => cache.putMany(batch)));

    expect(await cache.count()).toBe(20);
    expect(storage.size()).toBe(21); // 20 条 + jt:meta
    await cache.clear();
    expect(storage.size()).toBe(0);
  });

  it('并发写入跨不同缓存实例时仍然完整', async () => {
    // 真实接线里每条消息都会新建一次缓存实例，实例级锁挡不住这种并发。
    const storage = new MemoryStorage();
    const first = new TranslationCache(storage, 100);
    const second = new TranslationCache(storage, 100);

    await Promise.all([
      first.putMany(new Map([['a', '1']])),
      second.putMany(new Map([['b', '2']])),
      first.putMany(new Map([['c', '3']])),
    ]);

    expect(await first.count()).toBe(3);
    expect(storage.size()).toBe(4);
  });

  it('单批超过上限时保留刚写入的条目', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 2);
    await cache.putMany(new Map([['a', '1'], ['b', '2'], ['c', '3']]));

    const hit = await cache.getMany(['a', 'b', 'c']);
    expect(hit.has('a')).toBe(false);
    expect(hit.get('b')).toBe('2');
    expect(hit.get('c')).toBe('3');
    expect(await cache.count()).toBe(2);
  });

  it('读命中的条目在淘汰时被保留', async () => {
    const clock = fakeClock();
    const cache = new TranslationCache(new MemoryStorage(), 2, clock.now);
    await cache.putMany(new Map([['a', '1']]));
    clock.advance(60_000);
    await cache.putMany(new Map([['b', '2']]));

    expect((await cache.getMany(['a'])).get('a')).toBe('1');
    clock.advance(60_000);
    await cache.putMany(new Map([['c', '3']]));

    const hit = await cache.getMany(['a', 'b', 'c']);
    expect(hit.has('b')).toBe(false);
    expect(hit.get('a')).toBe('1');
    expect(hit.get('c')).toBe('3');
  });

  it('刷新间隔内重复命中不追加写入', async () => {
    const storage = new MemoryStorage();
    const clock = fakeClock();
    const cache = new TranslationCache(storage, 10, clock.now);
    await cache.putMany(new Map([['a', '1']]));
    const afterWrite = storage.setCalls;

    await cache.getMany(['a']);
    await cache.getMany(['a']);

    expect(storage.setCalls).toBe(afterWrite);
    expect((await cache.getMany(['a'])).get('a')).toBe('1');
  });

  it('读坏掉的条目时忽略它而不是抛错', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage);
    await cache.putMany(new Map([['good', '好']]));
    await storage.set({
      'jt:str': 'a plain string',
      'jt:num': 42,
      'jt:null': null,
      'jt:shape': { v: 123 },
      'jt:empty': {},
    });

    const hit = await cache.getMany(['good', 'str', 'num', 'null', 'shape', 'empty']);
    expect([...hit.keys()]).toEqual(['good']);
    expect(hit.get('good')).toBe('好');
  });

  it('单条存储值很小时缓存依然可用：20 条长译文全部写入且读回', async () => {
    // 宿主对单个存储值有上限（QUOTA_BYTES_PER_ITEM）。若把整个 LRU 索引塞进一个
    // 键里，20 条 32 位 hash 的索引就已经超过 1024 字节：写不进去，count() 归零。
    const storage = new MemoryStorage({ maxItemBytes: 1024 });
    const cache = new TranslationCache(storage, 20);
    const hashes = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(32, '0'));
    const translation = '这是一段足够长的译文，用来让条目本身也有几百字节。'.repeat(8);

    await cache.putMany(new Map(hashes.map((hash) => [hash, translation])));

    expect(storage.rejectedWrites).toBe(0);
    expect(storage.maxItemBytesSeen).toBeLessThanOrEqual(1024);
    expect(await cache.count()).toBe(20);
    const hit = await cache.getMany(hashes);
    expect(hit.size).toBe(20);
    for (const hash of hashes) expect(hit.get(hash)).toBe(translation);
  });

  it('单条上限很小时淘汰也不需要写出大值', async () => {
    const storage = new MemoryStorage({ maxItemBytes: 1024 });
    const cache = new TranslationCache(storage, 20);
    const translation = '另一段够长的译文，用来验证淘汰路径只写计数。'.repeat(8);
    const hashes = Array.from({ length: 25 }, (_, i) => (i + 100).toString(16).padStart(32, '0'));

    for (const hash of hashes) await cache.putMany(new Map([[hash, translation]]));

    expect(storage.rejectedWrites).toBe(0);
    expect(storage.maxItemBytesSeen).toBeLessThanOrEqual(1024);
    expect(await cache.count()).toBe(20);
    // 每写一条就裁掉最旧的，最后留下的是最后写入的 20 条。
    expect((await cache.getMany(hashes.slice(0, 5))).size).toBe(0);
    expect((await cache.getMany(hashes.slice(20))).size).toBe(5);
  });

  it('同一毫秒内的连续写入仍按写入顺序淘汰', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 2, () => 1_700_000_000_000);

    await cache.putMany(new Map([['a', '1']]));
    await cache.putMany(new Map([['b', '2']]));
    const first = (await storage.get(['jt:a']))['jt:a'] as { t: number };
    const second = (await storage.get(['jt:b']))['jt:b'] as { t: number };
    // 恒定时钟下两次写入拿到的 now 完全相同，时间戳必须仍然严格递增，
    // 否则淘汰顺序会退化成存储枚举 key 的顺序。
    expect(first.t).toBeLessThan(second.t);

    await cache.putMany(new Map([['c', '3']]));

    expect(storage.has('jt:a')).toBe(false); // 最早写入的那条先出局
    expect(storage.has('jt:b')).toBe(true);
    expect(storage.has('jt:c')).toBe(true);
    expect(await cache.count()).toBe(2);
  });

  it('读命中会刷新时间戳，淘汰的是最久未用而不是最早写入', async () => {
    const storage = new MemoryStorage();
    const clock = fakeClock();
    const cache = new TranslationCache(storage, 3, clock.now);

    await cache.putMany(new Map([['a', '1']]));
    clock.advance(60_000);
    await cache.putMany(new Map([['b', '2']]));
    clock.advance(60_000);
    await cache.putMany(new Map([['c', '3']]));
    clock.advance(60_000);
    expect((await cache.getMany(['a'])).get('a')).toBe('1'); // a 变成最近使用

    clock.advance(60_000);
    await cache.putMany(new Map([['d', '4']]));

    expect(storage.has('jt:b')).toBe(false); // 最久未用
    expect(storage.has('jt:a')).toBe(true);
    expect(storage.has('jt:c')).toBe(true);
    expect(storage.has('jt:d')).toBe(true);
    expect(await cache.count()).toBe(3);
  });

  it('旧版本残留的 jt:index 不影响读取与计数，prune 会清掉它', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 10);
    await cache.putMany(new Map([['a', '1']]));
    await storage.set({ 'jt:index': [{ hash: 'a', t: 1 }] });

    expect((await cache.getMany(['a'])).get('a')).toBe('1');
    expect(await cache.count()).toBe(1); // 读不出译文的残留键不是条目，不虚报

    await cache.prune();
    expect(storage.has('jt:index')).toBe(false);
    expect(await cache.count()).toBe(1);
  });

  it('形状坏掉的条目优先被淘汰，不牵连正常条目', async () => {
    const storage = new MemoryStorage();
    const clock = fakeClock();
    const cache = new TranslationCache(storage, 2, clock.now);
    await cache.putMany(new Map([['a', '1']]));
    clock.advance(60_000);
    await cache.putMany(new Map([['b', '2']]));
    await storage.set({ 'jt:bad': 42 });

    clock.advance(60_000);
    await cache.putMany(new Map([['c', '3']]));

    expect(storage.has('jt:bad')).toBe(false); // t 读不出来 → -Infinity → 第一个出局
    expect(storage.has('jt:a')).toBe(false); // 剩下的溢出按 t 淘汰最旧的
    expect(await cache.count()).toBe(2);
    const hit = await cache.getMany(['a', 'b', 'c']);
    expect([...hit.keys()].sort()).toEqual(['b', 'c']);
  });

  it('外部写入的条目立即参与计数与读取，不需要收编', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 10);
    await cache.putMany(new Map([['a', '1']]));
    await storage.set({ 'jt:orphan': { v: '孤儿', t: 1 } });

    // 条目本身就是唯一真源：外部写进来的记录立刻可见，没有"索引漏登记"这回事。
    expect(await cache.count()).toBe(2);
    const hit = await cache.getMany(['a', 'orphan']);
    expect(hit.get('a')).toBe('1');
    expect(hit.get('orphan')).toBe('孤儿');
  });

  it('prune 按上限淘汰最旧的条目', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 2);
    await cache.putMany(new Map([['a', '1']]));
    await storage.set({
      'jt:a': { v: '1', t: 1 },
      'jt:b': { v: '2', t: 2 },
      'jt:c': { v: '3', t: 3 },
    });

    await cache.prune();

    expect(await cache.count()).toBe(2);
    expect(storage.has('jt:a')).toBe(false); // t 最小
    expect(storage.has('jt:c')).toBe(true);
  });

  it('上限可以在运行时调整', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 10);
    await cache.putMany(new Map([['a', '1'], ['b', '2'], ['c', '3']]));

    cache.setMaxEntries(2);
    expect(await cache.count()).toBe(3);

    await cache.putMany(new Map([['d', '4']]));
    expect(await cache.count()).toBe(2);
    expect(storage.has('jt:a')).toBe(false);
    expect(storage.has('jt:d')).toBe(true);
  });

  it('存储写失败时不抛错，也不虚报条目数', async () => {
    const storage = new FailingStorage([0]);
    const cache = new TranslationCache(storage);

    await expect(cache.putMany(new Map([['a', '1']]))).resolves.toBeUndefined();
    expect((await cache.getMany(['a'])).size).toBe(0);
    expect(await cache.count()).toBe(0);
  });

  it('计数写失败后条目仍可读，prune 把计数校正回来', async () => {
    const storage = new FailingStorage([1]);
    const cache = new TranslationCache(storage, 2);

    // 第 0 次写是条目（成功），第 1 次写是计数（失败）：条目在，计数没记上。
    await expect(cache.putMany(new Map([['a', '1']]))).resolves.toBeUndefined();
    expect((await cache.getMany(['a'])).get('a')).toBe('1');
    expect(await cache.count()).toBe(1);

    await cache.prune();
    await cache.putMany(new Map([['b', '2'], ['c', '3']]));

    // 不校正的话计数从 0 起算、写两条也只到 2，不会触发淘汰，a 会一直留着。
    expect(storage.has('jt:a')).toBe(false);
    expect(await cache.count()).toBe(2);
  });

  it('配额写失败时不抛错，扫描腾出空间后可以重试写入', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 4, () => 1_700_000_000_000);
    const value = 'x'.repeat(60);

    await cache.putMany(new Map([['a', value]]));
    await cache.putMany(new Map([['b', value]]));
    await cache.putMany(new Map([['c', value]]));
    // 存储区此刻刚好装满：再多一条都放不下。
    storage.maxTotalBytes = storage.bytesUsed();
    // 上限调到 2；裁剪要等下一次写入，此刻是"超限未裁剪 + 配额已满"的状态。
    cache.setMaxEntries(2);

    await expect(cache.putMany(new Map([['d', value]]))).resolves.toBeUndefined();
    expect(storage.rejectedWrites).toBe(1); // 确实是被配额挡回来的
    expect(storage.has('jt:d')).toBe(false);
    expect(storage.has('jt:a')).toBe(false); // 写失败后的扫描把最旧的清掉了

    await cache.putMany(new Map([['d', value]])); // 腾出空间后重试成功
    expect((await cache.getMany(['d'])).get('d')).toBe(value);
    expect(await cache.count()).toBe(2);
    expect(storage.has('jt:b')).toBe(false);
    expect(storage.has('jt:c')).toBe(true);
  });

  it('存储写满但条目数还没到上限时，写失败仍要强制腾空间，否则缓存永久停摆', async () => {
    const storage = new MemoryStorage();
    // 上限 100 远大于实际条数：按上限算没有任何溢出，靠 overflow 一条也淘汰不掉。
    const cache = new TranslationCache(storage, 100, () => 1_700_000_000_000);
    const value = 'x'.repeat(60);

    for (const hash of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
      await cache.putMany(new Map([[hash, value]]));
    }
    expect(await cache.count()).toBe(10);

    // 存储区此刻刚好装满。
    storage.maxTotalBytes = storage.bytesUsed();

    await expect(cache.putMany(new Map([['k', value]]))).resolves.toBeUndefined();
    expect(storage.rejectedWrites).toBe(1); // 确实被配额挡回来过一次
    expect(storage.has('jt:a')).toBe(false); // 强制淘汰了最旧的，而不是一条不删

    await cache.putMany(new Map([['k', value]])); // 腾出空间后写入成功
    expect((await cache.getMany(['k'])).get('k')).toBe(value);
  });

  it('prune 清掉形状坏掉的条目并给出正确计数', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, 10);
    await cache.putMany(new Map([['a', '1']]));
    await storage.set({ 'jt:broken': 'not-an-entry' });

    expect((await cache.getMany(['a'])).get('a')).toBe('1');
    expect(await cache.count()).toBe(1); // 坏记录不是条目

    await cache.prune();

    expect(storage.has('jt:broken')).toBe(false);
    expect(storage.size()).toBe(2); // jt:a + jt:meta
    expect(await cache.count()).toBe(1);
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

  it('持久层命中时回填会话层（会话层计数随之增加）', async () => {
    const sessionStorage = new MemoryStorage();
    const session = new TranslationCache(sessionStorage);
    const local = new TranslationCache(new MemoryStorage());
    await local.putMany(new Map([['a', '1']]));

    const tiered = new TieredCache(session, local);
    const hit = await tiered.getMany(['a']);
    expect(hit.get('a')).toBe('1');
    expect((await session.getMany(['a'])).get('a')).toBe('1');
    // 只断言条目能读回是不够的：count() 走真实扫描，必须认它，否则设置页显示的
    // 条目数与淘汰的判断都会失真。
    expect(await session.count()).toBe(1);
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

/**
 * 扩展存储区的可测试子集（与宿主存储 API 的结构保持一致）。
 *
 * `keys()` 是缓存自愈的前提：只有能枚举出真实存在的 key，才能拿真实条目去校正近似
 * 的计数、清掉形状坏掉的残留（见 `TranslationCache.prune`），也才可能在外部把存储
 * 改坏之后恢复。
 */
export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  /** 列出本存储区里全部 key（宿主侧即"取全部再取键名"）。 */
  keys(): Promise<string[]>;
}

/** 条目键：`jt:<hash>` -> `{ v: 译文, t: 最后写入/命中时间 }`。 */
const ENTRY_PREFIX = 'jt:';
/** 唯一的元数据键：`{ n: 近似条目数 }`。值只有一个数字，不构成"单条超限"的风险。 */
const META_KEY = 'jt:meta';

/** 命中后按此间隔刷新一次条目的 `t`；间隔内的重复命中不再写存储。 */
const REFRESH_INTERVAL_MS = 5000;

/** 存储写失败（多半是配额满）时，按这个比例强制淘汰最旧的条目来腾空间。 */
const QUOTA_EVICT_RATIO = 0.1;

interface CacheEntry {
  v: string;
  t: number;
}

interface CacheMeta {
  n: number;
}

/**
 * 按存储区隔离的单调戳。`Date.now()` 在同一毫秒内的多次写入会拿到相同的 `t`，淘汰排序
 * 就不确定了（排序退化成存储的枚举顺序）；这里保证后写入/刷新的 `t` 一定大于先前的。
 *
 * 戳记挂在存储区上而不是模块上：模块级状态会让两个互不相干的存储区互相推高时钟，
 * 一个注入了"未来时间"的测试会永久污染后续所有按真实时钟写入的条目。
 */
const stamps = new WeakMap<StorageArea, number>();

function nextStamp(area: StorageArea, now: () => number): number {
  const previous = stamps.get(area) ?? 0;
  const t = now();
  const stamp = t > previous ? t : previous + 1;
  stamps.set(area, stamp);
  return stamp;
}

/** 只认能读出译文的记录；时间戳缺失或坏掉不丢译文，当作最旧的一条。 */
function readEntry(value: unknown): CacheEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { v, t } = value as Partial<CacheEntry>;
  if (typeof v !== 'string') return undefined;
  return { v, t: typeof t === 'number' && Number.isFinite(t) ? t : -Infinity };
}

/** 淘汰排序用的时间戳；读不出条目（被外部改坏）就用 `-Infinity`，让它优先出局。 */
function readStamp(value: unknown): number {
  return readEntry(value)?.t ?? -Infinity;
}

/**
 * 每条译文独立存一个 key：`jt:<hash>` -> `{ v, t }`，另有一个可选的元数据键
 * `jt:meta` -> `{ n }`。淘汰靠按需全量扫描，**没有单独的索引键**。
 *
 * 索引里存的东西（hash + t）与每个条目里的 `t` 完全重复，却把"写一条"放大成"重写
 * 整个索引"，还要求索引与条目双写一致——孤儿条目、幽灵条目、索引损坏后的自愈都由
 * 此而来。顺序信息现在就在条目自己身上，扫描时现算。
 *
 * 三条必须成立的前提（都影响正确性，不只是性能）：
 *
 * 1. **一个 `StorageArea` 只能有一个实例在用**。`maxEntries` 是实例属性，而条目是
 *    存储区级的；同一个存储区上挂了两个不同上限的实例，较小的那个会不断剪掉较大的
 *    那个刚写进去的条目。
 * 2. **缓存的读-改-写都串行执行**。计数与淘汰都是读-改-写，存储区本身不提供比较并
 *    交换，两个并发的 `putMany` 会互相覆盖计数、留下来不及淘汰的条目。这里用
 *    `queue`（按存储区对象共享）串行化，任何直接调用 `area.set`/`area.remove`
 *    绕过队列的写法都会重新引入该缺陷。
 * 3. **写缓存失败不得让调用方失败**。存储写是本模块的职责，不是调用方的：
 *    `putMany` 不抛错，写不进去只意味着这次没缓存上。反过来，调用方（翻译批次）
 *    也不该把缓存写失败当成翻译失败上报。计数因此允许漂移——它只决定"什么时候扫描
 *    淘汰"，`count()` 走真实扫描，`prune()` 负责把计数校正回来。
 */
export class TranslationCache {
  constructor(
    private readonly area: StorageArea,
    private maxEntries = 5000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private entryKey(hash: string): string {
    return ENTRY_PREFIX + hash;
  }

  /** 存储区里全部条目键（`jt:meta` 是元数据，不是条目）。 */
  private async entryKeys(): Promise<string[]> {
    return (await this.area.keys()).filter((key) => key.startsWith(ENTRY_PREFIX) && key !== META_KEY);
  }

  /** 上限随设置变化时调用；实际裁剪发生在下一次写入或 `prune()`。 */
  setMaxEntries(maxEntries: number): void {
    this.maxEntries = maxEntries;
  }

  async getMany(hashes: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (hashes.length === 0) return out;

    const entries = await this.readEntries(hashes);
    for (const [hash, entry] of entries) out.set(hash, entry.v);

    // 命中即刷新"最后命中时间"，否则淘汰退化成写入顺序（FIFO），热门段落会先于冷门
    // 段落被淘汰。刷新写是在写入队列里落盘的，所以刷新本身不会与 putMany / 淘汰并发。
    //
    // 已知窗口：读发生在进队列之前，"读到命中 → 该条目被并发淘汰 → 刷新把它写回"这条
    // 交错是可达的，表现为条目数短暂超过上限、刚淘汰的那条又活过来。影响有界：下一次
    // 写入触发扫描时就会收敛，且译文内容仍然正确（同一 hash 的译文是内容派生的）。
    // 把读也塞进队列能关掉这个窗口，代价是每次缓存读都要排在一次待写批次后面。
    if (entries.size > 0) await this.queue(() => this.refresh(entries));
    return out;
  }

  /**
   * 只重写命中的那几条里 `t` 已经旧了的，刷新它们的最后命中时间。
   *
   * 刚刷新过的条目 `t` 已经变新，这里自然不会再写——不需要额外的内存节流表。
   * 写回的是读到的整条条目（含 `v`），不像旧索引那样只写 `hash + t`：若一次并发的
   * `putMany` 正好插在读与刷新之间写了同一个 hash，这次刷新会把 `v` 覆盖回旧值。
   * 同一 hash 的译文是内容派生的、两次写入理应相同，换来的是命中热路径上少一次读取。
   */
  private async refresh(entries: Map<string, CacheEntry>): Promise<void> {
    const now = this.now();
    const batch: Record<string, unknown> = {};
    let touched = 0;
    for (const [hash, entry] of entries) {
      if (now - entry.t < REFRESH_INTERVAL_MS) continue;
      batch[this.entryKey(hash)] = { v: entry.v, t: nextStamp(this.area, this.now) } satisfies CacheEntry;
      touched += 1;
    }
    if (touched === 0) return;
    await this.area.set(batch);
  }

  async putMany(items: Map<string, string>): Promise<void> {
    if (items.size === 0) return;
    await this.queue(async () => {
      const batch: Record<string, unknown> = {};
      for (const [hash, value] of items) {
        batch[this.entryKey(hash)] = { v: value, t: nextStamp(this.area, this.now) } satisfies CacheEntry;
      }

      try {
        await this.area.set(batch);
      } catch {
        // 写不进去只意味着这次没缓存上，不抛给调用方；写失败最常见的成因是存储满了，
        // 顺手按比例淘汰腾地方——注意此时条目数往往还没到上限，靠 `overflow` 是腾不出
        // 任何空间的，新条目会永久写不进去。
        await this.scanAndEvict(QUOTA_EVICT_RATIO);
        return;
      }

      // 计数只增不减地记一个近似值；它写不进去也只影响扫描时机：`count()` 走真实
      // 扫描，`prune()` 会把计数校正回来，条目本身已经落盘、读得出来。
      const count = (await this.readMeta()) + items.size;
      await this.writeMeta(count);
      if (count > this.maxEntries) await this.scanAndEvict();
    });
  }

  /**
   * 全量对账：删掉形状坏掉的条目（连译文都读不出来的记录），把近似计数校正为真实
   * 条目数，再按上限裁剪。存储被外部改坏、或计数漂移之后，这是唯一的自愈入口
   * （service worker 启动时调用一次即可）。
   */
  async prune(): Promise<void> {
    await this.queue(async () => {
      const keys = await this.entryKeys();
      if (keys.length > 0) {
        const raw = await this.area.get(keys);
        const broken = keys.filter((key) => readEntry(raw[key]) === undefined);
        if (broken.length > 0) await this.area.remove(broken);
      }
      await this.scanAndEvict();
    });
  }

  /**
   * 真实扫描出的**精确**条目数（形状坏掉的记录不算条目，它们由 `prune()` 清掉）。
   * 只给设置页用、频率极低，所以可以真的把值读出来核一遍形状。
   */
  async count(): Promise<number> {
    const keys = await this.entryKeys();
    if (keys.length === 0) return 0;
    const raw = await this.area.get(keys);
    return keys.filter((key) => readEntry(raw[key]) !== undefined).length;
  }

  /** 删掉全部 `jt:` 前缀的键：条目、元数据，以及旧版本可能留下的别的 `jt:` 键。 */
  async clear(): Promise<void> {
    await this.queue(async () => {
      const keys = (await this.area.keys()).filter((key) => key.startsWith(ENTRY_PREFIX));
      if (keys.length > 0) await this.area.remove(keys);
    });
  }

  /**
   * 全量扫描 → 按 `t` 从小到大裁剪超限条目 → 把计数校正为真实值。
   *
   * `forceEvictRatio > 0` 用于"存储已经写满、但条目数还没到上限"的场景：此时按上限算
   * 没有任何溢出，一条都不删的话新条目永远写不进去，缓存会永久停摆。所以写失败时按比例
   * 多腾一些名额（至少一条），避免每写一条就再扫描一次。
   */
  private async scanAndEvict(forceEvictRatio = 0): Promise<void> {
    const keys = await this.entryKeys();
    if (keys.length === 0) {
      await this.writeMeta(0);
      return;
    }
    const raw = await this.area.get(keys);
    const sorted = keys
      .map((key) => ({ key, t: readStamp(raw[key]) }))
      .sort((a, b) => a.t - b.t);
    const overflow = sorted.length - this.maxEntries;
    const forced = forceEvictRatio > 0 ? Math.max(1, Math.floor(sorted.length * forceEvictRatio)) : 0;
    const target = Math.min(Math.max(overflow, forced), sorted.length);
    if (target > 0) await this.area.remove(sorted.slice(0, target).map((item) => item.key));
    await this.writeMeta(Math.min(sorted.length - target, Math.max(0, this.maxEntries)));
  }

  private async readEntries(hashes: string[]): Promise<Map<string, CacheEntry>> {
    const out = new Map<string, CacheEntry>();
    if (hashes.length === 0) return out;
    const keys = hashes.map((hash) => this.entryKey(hash));
    const raw = await this.area.get(keys);
    hashes.forEach((hash, index) => {
      // 存储里的内容可能被外部改坏，只认形状正确的条目。
      const entry = readEntry(raw[keys[index]]);
      if (entry) out.set(hash, entry);
    });
    return out;
  }

  /**
   * 近似条目数；计数键缺失或被改坏都当作 0——它只影响"什么时候扫描淘汰"，
   * 不影响任何正确性。
   */
  private async readMeta(): Promise<number> {
    const raw = await this.area.get([META_KEY]);
    const meta = raw[META_KEY] as Partial<CacheMeta> | undefined;
    if (!meta || typeof meta !== 'object') return 0;
    const n = meta.n;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  }

  private async writeMeta(n: number): Promise<void> {
    await this.area.set({ [META_KEY]: { n } satisfies CacheMeta });
  }

  /** 把任务挂到该存储区的串行队列上，返回它的结果；失败不打断队列、也不抛给调用方。 */
  private queue<T>(task: () => Promise<T>): Promise<T | undefined> {
    const tail = queues.get(this.area) ?? Promise.resolve();
    const next = tail.then(task).catch(() => undefined);
    queues.set(this.area, next);
    return next;
  }
}

/**
 * 按存储区对象共享的串行队列（WeakMap 不阻止存储区被回收）。
 * 放在模块作用域而不是实例上：`TieredCache` 的调用方通常每条消息新建一次缓存实例，
 * 实例级队列挡不住并发，只有同一存储区共享同一个队列才行。
 */
const queues = new WeakMap<StorageArea, Promise<unknown>>();

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
    // 两层各自尽力而为，互不阻塞：会话层写失败不该连带丢掉持久层的那份。
    await Promise.all([this.session.putMany(items), this.persistent.putMany(items)]);
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/core/cache.test.ts`

Expected: PASS，全部用例通过。

- [ ] **Step 6: 提交**

```bash
git add src/core/cache.ts tests/helpers/memory-storage.ts tests/core/cache.test.ts
git commit -m "feat(core): 两级翻译缓存、LRU 淘汰与索引对账"
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
import {
  CURRENT_VERSION,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  loadSettings,
  loadUiSettings,
  mergeSettings,
  saveSettings,
} from '../../src/shared/settings';
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

  it('对任意非对象输入都不抛错', () => {
    for (const raw of [null, undefined, 42, 'x', true, [], [1, 2], () => 1, Symbol('s')]) {
      expect(() => mergeSettings(raw)).not.toThrow();
      expect(mergeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('损坏的 engineConfig 退回默认值', () => {
    expect(mergeSettings({ engineConfig: null }).engineConfig).toEqual(DEFAULT_SETTINGS.engineConfig);
    expect(mergeSettings({ engineConfig: [] }).engineConfig).toEqual(DEFAULT_SETTINGS.engineConfig);
    expect(mergeSettings({ engineConfig: 'x' }).engineConfig).toEqual(DEFAULT_SETTINGS.engineConfig);
  });

  it('版本号必须能原样读回（迁移要靠它判断来源版本）', () => {
    expect(mergeSettings({ version: 99 }).version).toBe(99);
    expect(mergeSettings({ version: 'v2' }).version).toBe(CURRENT_VERSION);
    expect(mergeSettings({ version: 0 }).version).toBe(CURRENT_VERSION);
    expect(mergeSettings({ version: 1.5 }).version).toBe(CURRENT_VERSION);
    expect(mergeSettings({}).version).toBe(CURRENT_VERSION);
    expect(mergeSettings({ version: 2 }, 3).version).toBe(3);
  });

  it('不共享默认值里的可变对象', () => {
    expect(mergeSettings({}).siteRules).not.toBe(DEFAULT_SETTINGS.siteRules);
    expect(mergeSettings({}).glossary).not.toBe(DEFAULT_SETTINGS.glossary);
    expect(mergeSettings({}).engineConfig).not.toBe(DEFAULT_SETTINGS.engineConfig);
  });
});

describe('显示模式（默认值、迁移）', () => {
  it('默认是「仅译文」', () => {
    expect(DEFAULT_SETTINGS.displayMode).toBe('translated-only');
    expect(mergeSettings({}).displayMode).toBe('translated-only');
    expect(mergeSettings({ targetLang: 'ja' }).displayMode).toBe('translated-only');
  });

  it('保留用户明确选过的双语', () => {
    expect(mergeSettings({ displayMode: 'bilingual' }).displayMode).toBe('bilingual');
    expect(mergeSettings({ displayMode: 'translated-only' }).displayMode).toBe('translated-only');
  });

  it("把老数据里的 'replace' 迁移成 'translated-only'，而不是回落", () => {
    // 老用户的存储里就是 'replace'（v1 时代的"整页替换"）。当成未知值处理会退回**默认值**，
    // 于是默认值哪天再变一次，他们就会莫名其妙地被切回双语——那正是他们当年特意改掉的默认行为。
    // 所以映射写死成 'translated-only'，与当前的默认值是不是它无关（这条断言不引用
    // DEFAULT_SETTINGS，正是为了在默认值改变时仍然有意义）。
    expect(mergeSettings({ displayMode: 'replace' }).displayMode).toBe('translated-only');
    expect(mergeSettings({ displayMode: 'replace', version: 1 }).displayMode).toBe('translated-only');
  });

  it('不认识的显示模式退回默认值', () => {
    for (const raw of ['nope', '', null, 42, {}, []]) {
      expect(mergeSettings({ displayMode: raw }).displayMode).toBe(DEFAULT_SETTINGS.displayMode);
    }
  });

  it('loadSettings 读到老数据时就完成迁移（不需要用户再改一次设置）', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 1, displayMode: 'replace' } });
    expect((await loadSettings(area)).displayMode).toBe('translated-only');
  });

  describe('v1 → v2：冻结的 displayMode 要迁到新默认', () => {
    /**
     * 这一条是实测踩出来的：用户配完 DeepSeek（点过保存）之后升级到「仅译文」，
     * 页面上却还是双语。原因是 `saveSettings` 是**整份覆盖**——那次保存把当时的默认值
     * `bilingual` 一起冻结进了存储，而它是个合法值，程序没有理由覆盖它。
     *
     * v1 时代设置页与弹窗都没有改显示模式的界面，所以存储里的 `bilingual` 一定是冻结的
     * 默认值，不是用户的选择。因此按版本号迁移是安全的，也是唯一能让老用户拿到新默认的办法。
     */
    it('v1 存储里的 bilingual 迁成 translated-only', async () => {
      const area = new MemoryStorage();
      await area.set({ [SETTINGS_KEY]: { version: 1, displayMode: 'bilingual' } });
      expect((await loadSettings(area)).displayMode).toBe('translated-only');
    });

    it('v2 存储里的 bilingual 是用户真的选过的，不能动', async () => {
      const area = new MemoryStorage();
      await area.set({ [SETTINGS_KEY]: { version: 2, displayMode: 'bilingual' } });
      expect((await loadSettings(area)).displayMode).toBe('bilingual');
    });

    it('迁移只看版本号，v1 里已经是 translated-only 的保持不动', async () => {
      const area = new MemoryStorage();
      await area.set({ [SETTINGS_KEY]: { version: 1, displayMode: 'translated-only' } });
      expect((await loadSettings(area)).displayMode).toBe('translated-only');
    });

    it('读完之后版本号被标成当前版本，不会每次加载都再迁一遍', async () => {
      const area = new MemoryStorage();
      await area.set({ [SETTINGS_KEY]: { version: 1, displayMode: 'bilingual' } });
      const settings = await loadSettings(area);
      expect(settings.version).toBe(CURRENT_VERSION);
    });
  });
});

describe('BaseURL 校验（它决定 API Key 发往哪里）', () => {
  const baseUrlOf = (value: unknown): string =>
    mergeSettings({ engineConfig: { baseUrl: value } }).engineConfig.baseUrl;

  it('接受 https 地址并去掉首尾空白', () => {
    expect(baseUrlOf('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1');
    expect(baseUrlOf('  https://api.deepseek.com/v1  ')).toBe('https://api.deepseek.com/v1');
  });

  it('拒绝非 https 的远端地址', () => {
    expect(baseUrlOf('http://evil.example')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
    expect(baseUrlOf('//evil.example')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
    expect(baseUrlOf('file:///etc/passwd')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
    expect(baseUrlOf('javascript:alert(1)')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
  });

  it('放行本机回环地址的 http（本地推理服务）', () => {
    expect(baseUrlOf('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(baseUrlOf('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1');
  });

  it('拒绝连不上主机的地址与非字符串', () => {
    expect(baseUrlOf('not a url')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
    expect(baseUrlOf('')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
    expect(baseUrlOf('https://')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
    expect(baseUrlOf(42)).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
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

  it('缺失版本号的老数据按当前版本读出', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { targetLang: 'ja' } });
    const settings = await loadSettings(area);
    expect(settings.targetLang).toBe('ja');
    expect(settings.version).toBe(CURRENT_VERSION);
  });

  it('读取比本代码更新的设置时明确报错而不是静默降级', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 99, targetLang: 'ja' } });
    await expect(loadSettings(area)).rejects.toThrow(/99/);
  });

  it('不会用旧 schema 覆盖更新版本的设置', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 99, targetLang: 'ja' } });
    await expect(saveSettings({ ...DEFAULT_SETTINGS, targetLang: 'ko' }, area)).rejects.toThrow();
    expect((await area.get([SETTINGS_KEY]))[SETTINGS_KEY]).toEqual({ version: 99, targetLang: 'ja' });
  });

  it('写入时归一化，脏数据进不了存储', async () => {
    const area = new MemoryStorage();
    await saveSettings({ ...DEFAULT_SETTINGS, concurrency: 999, version: 0 }, area);
    const stored = (await area.get([SETTINGS_KEY]))[SETTINGS_KEY];
    expect(stored).toEqual({ ...DEFAULT_SETTINGS, concurrency: 8 });
  });
});

describe('loadUiSettings', () => {
  it('不带出 API Key，其余设置与完整读取一致', async () => {
    const area = new MemoryStorage();
    await saveSettings(
      { ...DEFAULT_SETTINGS, engineConfig: { apiKey: 'sk-secret', baseUrl: 'https://a.example/v1', model: 'm' } },
      area,
    );

    const ui = await loadUiSettings(area);
    expect(ui.engineConfig).not.toHaveProperty('apiKey');
    expect(ui.engineConfig).toEqual({ baseUrl: 'https://a.example/v1', model: 'm' });
    expect(ui.targetLang).toBe(DEFAULT_SETTINGS.targetLang);
    expect(JSON.stringify(ui)).not.toContain('sk-secret');
  });

  it('完整读取仍然拿得到 API Key（service worker 与设置页需要）', async () => {
    const area = new MemoryStorage();
    await saveSettings({ ...DEFAULT_SETTINGS, engineConfig: { apiKey: 'sk-secret', baseUrl: 'https://a.example/v1', model: 'm' } }, area);
    expect((await loadSettings(area)).engineConfig.apiKey).toBe('sk-secret');
  });
});

describe('无扩展环境下的默认存储', () => {
  it('没有显式传入存储区时给出可读的错误', async () => {
    await expect(loadSettings()).rejects.toThrow(/StorageArea/);
    await expect(saveSettings(DEFAULT_SETTINGS)).rejects.toThrow(/StorageArea/);
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

/**
 * 译文显示方式。
 *
 * - `translated-only`（默认）：**只显示译文**。原文并没有被删掉——它被包进一个
 *   `display:none` 的 `<span data-jy-originals>` 留在 DOM 里，还原就是把子节点搬回去
 *   （见 `content/renderer.ts`）。用户要的就是这个：双语对照会让译文和原文互相挤占版面。
 * - `bilingual`：原文照旧，译文插在它下面。
 *
 * 这里曾经还有第三种 `'replace'`（就地写 `textContent` 覆盖原文）。它已随
 * {@link mergeSettings} 的迁移改成 `translated-only`：旧实现遇到含行内标记的段落会
 * 静默退回双语，真实长文（维基百科几乎每段都有链接）实际表现就是"大部分段落仍是双语"，
 * 与「只显示译文」正好相反。
 */
export type DisplayMode = 'bilingual' | 'translated-only';

/**
 * 显示模式的界面选项（弹窗与设置页**共用这一份**）。
 *
 * 与 `core/lang.ts` 的 LANGUAGES 同一个道理：两处各写一份时，同一个设置在两个界面上会
 * 给出不同的说法（"仅译文" / "只要译文"），用户会以为它们不是同一个东西。
 * 数组顺序就是界面顺序：默认的「仅译文」在最前——它是用户最可能想改的一项。
 */
export const DISPLAY_MODES: ReadonlyArray<{ value: DisplayMode; label: string }> = [
  { value: 'translated-only', label: '仅译文' },
  { value: 'bilingual', label: '双语对照' },
];

export interface Settings {
  version: number;
  engineId: string;
  engineConfig: EngineConfigSettings;
  targetLang: string;
  sourceLang: string;
  displayMode: DisplayMode;
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

/** 当前设置 schema 版本；改动字段语义时递增。 */
export const CURRENT_VERSION = 2;

export const DEFAULT_SETTINGS: Settings = {
  version: CURRENT_VERSION,
  engineId: 'google',
  engineConfig: { apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  targetLang: 'zh-Hans',
  sourceLang: 'auto',
  displayMode: 'translated-only',
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

/**
 * 认不出来的值回落到哪个模式。
 *
 * 单独拎成一个常量而不是直接写 `DEFAULT_SETTINGS.displayMode`，是为了让「兜底」与
 * 「`'replace'` 的迁移目标」成为两个可以分别演进的概念：默认值将来若改成双语，
 * `'replace'` 仍然应该映射成"只要译文"。
 *
 * **现状要如实说明**：今天两者恰好都是 `translated-only`，所以把 `pickDisplayMode` 里的
 * 迁移分支删掉，全部测试依然通过——兜底补上了同一个结果。也就是说那条迁移目前
 * **没有测试守得住**，它只在默认值改变之后才成为承重代码。变异测试证实过这一点
 * （删掉 `|| value === 'replace'`，426 个用例全绿）。不要以为有测试保护它。
 */
const FALLBACK_DISPLAY_MODE: DisplayMode = 'translated-only';

/**
 * 显示模式的读取与**迁移**。
 *
 * 存储里已有的 `'replace'`（v1 时代的"整页替换"）必须映射成 `translated-only`：
 * 老用户升级后不能被当成"值不认识"而回落——回落的结果是显示模式悄悄变回双语，
 * 而那正是用户当初特意改掉的默认行为。
 *
 * 迁移目标与兜底都写死成 `translated-only` 而不是"当前的默认值"：默认值以后再变一次时，
 * `'replace'` 的语义仍然是"只要译文"，不该跟着新默认值漂走。
 */
function pickDisplayMode(value: unknown): DisplayMode {
  if (value === 'bilingual') return 'bilingual';
  if (value === 'translated-only' || value === 'replace') return 'translated-only';
  return FALLBACK_DISPLAY_MODE;
}

/** 允许 http 的本机主机名（用户的本地推理服务，如 Ollama）。 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * 接口地址是否合法：只接受 https（本机回环地址放行 http，Ollama 等本地服务默认就是 http）。
 *
 * 导出是给**设置页**用的：它必须在保存按钮里给出与这里**同一套判据**的提示，否则会出现
 * 「设置页说保存成功、存储层把地址悄悄退回默认值」这种用户永远查不出来的分歧。
 */
export function isAllowedBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
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
    baseUrl: pickBaseUrl(raw.baseUrl),
    model: pickString(raw.model, DEFAULT_SETTINGS.engineConfig.model),
  };
}

/**
 * BaseURL 决定 `Authorization: Bearer <apiKey>` 发往哪里，是这个凭据的唯一下游，
 * 所以它是反序列化边界上必须校验的字段而不是一个可自由填写的字符串：
 * 只接受 https（本机回环地址放行 http，Ollama 等本地服务默认就是 http）。
 * 非法值不抛错，退回默认值——这样错误输入永远不会变成"把 Key 发到别处"。
 */
function pickBaseUrl(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.engineConfig.baseUrl;
  const trimmed = value.trim();
  if (!isAllowedBaseUrl(trimmed)) return DEFAULT_SETTINGS.engineConfig.baseUrl;
  return trimmed;
}

/**
 * 把任意来源的对象合并成完整设置。
 * 逐字段校验而不是整体替换，这样新版字段可以在老数据上补齐，
 * 单个字段损坏也不会让整个设置页崩掉。
 *
 * `version` 是**声明值**而不是校验结果：调用方决定它是多少（见 `saveSettings` 的
 * 防降级与 `loadSettings` 的版本闸门），这里只负责拒绝非正整数。
 */
export function mergeSettings(raw: unknown, version: unknown = undefined): Settings {
  const input = (raw ?? {}) as Partial<Settings>;
  return {
    version: pickVersion(version ?? input.version),
    engineId: pickString(input.engineId, DEFAULT_SETTINGS.engineId),
    engineConfig: pickEngineConfig(input.engineConfig),
    targetLang: pickString(input.targetLang, DEFAULT_SETTINGS.targetLang),
    sourceLang: pickString(input.sourceLang, DEFAULT_SETTINGS.sourceLang),
    displayMode: pickDisplayMode(input.displayMode),
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

/** 版本号必须能原样读回，否则无从判断来源版本；非正整数一律按当前版本处理。 */
function pickVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return CURRENT_VERSION;
  return value;
}

/** 读出存储里声明的版本号（缺失或非法即"当作当前版本"）。 */
function readStoredVersion(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return CURRENT_VERSION;
  return pickVersion((raw as Partial<Settings>).version);
}

let sharedArea: StorageArea | null = null;

function resolveArea(area?: StorageArea): StorageArea {
  if (area) return area;
  if (typeof chrome === 'undefined') {
    throw new Error('当前运行环境没有扩展存储，调用时必须显式传入 StorageArea');
  }
  if (!sharedArea) sharedArea = chromeArea(chrome.storage.local);
  return sharedArea;
}

/**
 * 读取完整设置（**含 API Key**）。
 *
 * 调用方是**扩展自身的受信页面与后台**：service worker、设置页、弹窗——三者同源
 * （`chrome-extension://`），谁也拿不到对方拿不到的东西，所以弹窗读完整设置不是越权。
 * 真正需要结构上隔离的是**内容脚本**：它跑在网页的进程里，一律用 `loadUiSettings()`，
 * 那个类型里根本没有 `apiKey` 字段。密钥不得进入日志、消息与导出的 JSON（规格 §7.3）。
 *
 * 这里也是**迁移入口**（规格 §7.3），具体步骤见 `migrate`。
 */
/**
 * 按**存储里的真实版本号**迁移老数据。新增一版就在这里加一步。
 *
 * **v1 → v2：`displayMode` 的 `'bilingual'` 迁到 `'translated-only'`。**
 * v1 时代设置页与弹窗都**没有**改显示模式的界面（那个开关是 v2 才加的），所以存储里的
 * `displayMode` 一定是当时的默认值被 `saveSettings` 整份覆盖时**冻结**下来的——用户只要
 * 配过一次引擎或改过目标语言，就会把它一起写进去——不可能是用户的选择。
 * 不迁的话，所有配过引擎的老用户升级后仍然看到双语，而他们从来没选过双语
 * （实测就是这么发生的：用户配完 DeepSeek 后升级，页面还是双语）。
 *
 * 只动 `'bilingual'`：`'replace'` 交给 `pickDisplayMode` 映射，其余脏值交给它兜底。
 * v2 及以后存储里的 `'bilingual'` 是用户真的在界面上选过的，**不能动**。
 */
function migrate(raw: unknown, storedVersion: number): unknown {
  if (storedVersion >= 2) return raw;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (record.displayMode !== 'bilingual') return raw;
  return { ...record, displayMode: 'translated-only' };
}

/**
 * 读出扩展设置。**这是迁移入口**（规格 §7.3）：版本号必须从存储里真实读出来，
 * 否则无从判断该按哪一版语义解释老数据。
 *
 * 读到**比本代码更新**的版本号说明用户装过新版扩展后又回退了，此时按旧语义解释新数据
 * 会得出错误结果，因此明确拒绝，而不是静默降级。
 */
export async function loadSettings(area?: StorageArea): Promise<Settings> {
  const target = resolveArea(area);
  const raw = await target.get([SETTINGS_KEY]);
  const stored = raw[SETTINGS_KEY];
  const storedVersion = readStoredVersion(stored);
  if (storedVersion > CURRENT_VERSION) {
    throw new Error(`设置版本 ${storedVersion} 高于当前支持的 ${CURRENT_VERSION}，请更新扩展`);
  }
  return mergeSettings(migrate(stored, storedVersion), CURRENT_VERSION);
}

/** 不带 API Key 的设置投影，供**内容脚本**使用（它跑在网页进程里）。 */
export type UiEngineConfig = Omit<EngineConfigSettings, 'apiKey'>;

export type UiSettings = Omit<Settings, 'engineConfig'> & { engineConfig: UiEngineConfig };

export async function loadUiSettings(area?: StorageArea): Promise<UiSettings> {
  const { engineConfig, ...rest } = await loadSettings(area);
  return { ...rest, engineConfig: { baseUrl: engineConfig.baseUrl, model: engineConfig.model } };
}

/**
 * 保存前先归一化（`mergeSettings`），UI 不可能把脏数据写进存储。
 * 存储里的版本号高于本代码时拒绝写入：继续写就等于用旧 schema 覆盖新数据
 * （弹窗每次改动开关都会保存一次），会把新版字段悄悄丢掉。
 *
 * 注意这是**整份覆盖**：调用方必须持有完整设置（弹窗就是 `loadSettings` 读来的那一份，
 * 它只改 targetLang / engineId，其余字段原样写回）。因此设置页实装后**不能**和弹窗
 * 各持一份快照同时写——两边各自读一次、各改一个字段，后写的那次会把对方刚改的字段
 * 抹回自己的旧值。到那时这里要加一个存储侧的局部写入 API（只写指定字段），
 * 而不是让两个页面继续整份回写。今天设置页还是占位实现（src/options/options.ts），
 * 弹窗是唯一的写入方，所以这条约束尚未被触发。
 */
export async function saveSettings(settings: Settings, area?: StorageArea): Promise<void> {
  const target = resolveArea(area);
  const stored = await target.get([SETTINGS_KEY]);
  const storedVersion = readStoredVersion(stored[SETTINGS_KEY]);
  if (storedVersion > CURRENT_VERSION) {
    throw new Error(`存储中的设置版本 ${storedVersion} 高于当前支持的 ${CURRENT_VERSION}，已跳过保存`);
  }
  await target.set({ [SETTINGS_KEY]: mergeSettings(settings, CURRENT_VERSION) });
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
    keys: async () => Object.keys(await area.get(null)),
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

  it('允许空批次（形状合法，空只是发送方的约定）', () => {
    expect(isTranslateTextsMessage({ type: MSG.TRANSLATE_TEXTS, payload: { items: [] } })).toBe(true);
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

  it('拒绝 targetLang 类型不对的消息', () => {
    expect(
      isTranslateTextsMessage({
        type: MSG.TRANSLATE_TEXTS,
        payload: { items: [{ id: 'jy-1', text: 'Hello' }], targetLang: 123 },
      }),
    ).toBe(false);
  });

  it('允许省略 targetLang', () => {
    expect(
      isTranslateTextsMessage({ type: MSG.TRANSLATE_TEXTS, payload: { items: [{ id: 'jy-1', text: 'Hi' }] } }),
    ).toBe(true);
    expect(
      isTranslateTextsMessage({
        type: MSG.TRANSLATE_TEXTS,
        payload: { items: [{ id: 'jy-1', text: 'Hi' }], targetLang: 'ja' },
      }),
    ).toBe(true);
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
import type { DisplayMode } from './settings';

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
  /** 这一轮翻译用的是哪种显示方式（弹窗按它告诉用户当前页面处于什么状态）。 */
  mode: DisplayMode;
  total: number;
  done: number;
  failed: number;
}

/**
 * 跨进程边界的消息必须在运行时校验，不能只信 TypeScript 类型。
 *
 * 只校验**形状**：空批次是发送方自己的约定（下游对 `items: []` 返回空结果即可），
 * 不是安全属性。把空批次判为非法，只会让一个良性请求收不到任何响应、变成悬空的 RPC。
 */
export function isTranslateTextsMessage(value: unknown): value is TranslateTextsMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<TranslateTextsMessage>;
  if (message.type !== MSG.TRANSLATE_TEXTS) return false;
  if (!message.payload || typeof message.payload !== 'object') return false;
  const payload = message.payload as { items?: unknown; targetLang?: unknown };
  if (!Array.isArray(payload.items)) return false;
  if (payload.targetLang !== undefined && typeof payload.targetLang !== 'string') return false;
  return payload.items.every(
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
import { describe, expect, it } from 'vitest';
import { translateBatch, type BatchDeps, type CacheLike } from '../../src/background/scheduler';
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

  /**
   * 同一批里字面完全相同的文本只翻一次。真实网页的导航、「Read more」、表头、免责声明
   * 能占 20-40% 的段落数，而 Google 引擎不支持批量（一条文本一个请求），逐条发等于把
   * 免费额度白烧在重复段上，正文反而会因 429 失败（审查实测：60 个相同段落打出 36 次 fetch）。
   */
  it('同一批里字面相同的文本只送一次引擎，结果摊回每一条且都进缓存', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    const { engine, calls } = fakeEngine([['重复段译文', '独有段译文']]);
    const items = [
      { id: 'a', text: 'Read more' },
      { id: 'b', text: 'Unique sentence here' },
      { id: 'c', text: 'Read more' },
      { id: 'd', text: 'Read more' },
    ];

    const out = await translateBatch(items, deps(engine, { cache }));

    // 3 个相同 + 1 个不同 → 引擎只收到 2 条文本。
    expect(calls).toEqual([['Read more', 'Unique sentence here']]);
    // 4 条结果都正确：重复的那 3 条拿到同一份译文，顺序与输入一致。
    expect(out).toEqual([
      { id: 'a', text: '重复段译文' },
      { id: 'b', text: '独有段译文' },
      { id: 'c', text: '重复段译文' },
      { id: 'd', text: '重复段译文' },
    ]);
    // 都进缓存：缓存 key 由文本派生，重复的那 3 条共用同一个 key，所以真实条目数是 2。
    expect(await cache.count()).toBe(2);

    // 同一批再来一次：一条都不该再打给引擎（重复段命中的是同一个 key）。
    const again = await translateBatch(items, deps(engine, { cache }));
    expect(calls).toHaveLength(1);
    expect(again).toEqual(out);
  });

  it('命中的与未命中的一起折叠：只有未命中的唯一文本进引擎', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    const { engine, calls } = fakeEngine([['重复段译文'], ['独有段译文']]);
    const shared = deps(engine, { cache });

    // 先单独翻一次，让 'Read more' 进缓存。
    await translateBatch([{ id: 'seed', text: 'Read more' }], shared);
    expect(calls).toHaveLength(1);

    // 这一批里两条命中、两条未命中同一段文本（都未命中缓存的那条只该送一次）。
    const out = await translateBatch(
      [
        { id: 'a', text: 'Read more' },
        { id: 'b', text: 'Unique sentence here' },
        { id: 'c', text: 'Unique sentence here' },
        { id: 'd', text: 'Read more' },
      ],
      shared,
    );

    expect(calls).toEqual([['Read more'], ['Unique sentence here']]);
    expect(out).toEqual([
      { id: 'a', text: '重复段译文' },
      { id: 'b', text: '独有段译文' },
      { id: 'c', text: '独有段译文' },
      { id: 'd', text: '重复段译文' },
    ]);
  });

  it('源语言变化时缓存不命中：key 里带了 sourceLang', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    const { engine, calls } = fakeEngine([['自动检测的译文'], ['按英文源的译文']]);

    await translateBatch([{ id: 'a', text: 'Hello' }], deps(engine, { cache, sourceLang: 'auto' }));
    const second = await translateBatch([{ id: 'a', text: 'Hello' }], deps(engine, { cache, sourceLang: 'en' }));

    // 换了源语言语义就必须重新问引擎；共用 key 会命中按 auto 翻出来的那一份。
    expect(calls).toHaveLength(2);
    expect(second[0].text).toBe('按英文源的译文');
    // 反过来：同样的源语言仍然命中缓存。
    await translateBatch([{ id: 'a', text: 'Hello' }], deps(engine, { cache, sourceLang: 'en' }));
    expect(calls).toHaveLength(2);
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

  it('切分降级中某条失败时，另一条的译文照常返回并进缓存', async () => {
    // 切分路径也要逐条隔离：a 已经切分翻好了，不该因为 b 的 AUTH 被一起标成 AUTH、
    // 也不该把 a 的译文丢掉（translateOneByOne 早就这么做了，两条降级路径必须同形）。
    const cache = new TranslationCache(new MemoryStorage());
    const longA = '第一句。'.repeat(200);
    const longB = '第二句。'.repeat(200);
    const calls: string[][] = [];
    let cursor = 0;
    const engine: Translator = {
      id: 'fake',
      name: 'Fake',
      needsKey: false,
      supportsGlossary: false,
      async translate(request: TranslateRequest): Promise<string[]> {
        calls.push([...request.texts]);
        cursor += 1;
        // 1) 整批报过长，进入切分降级；2) a 的切片翻好；3) b 的切片报鉴权失败。
        if (cursor === 1) throw new EngineError('TOO_LONG', '过长');
        if (cursor === 2) return request.texts.map((text) => `译:${text}`);
        throw new EngineError('AUTH', 'Key 无效');
      },
    };

    const out = await translateBatch(
      [
        { id: 'a', text: longA },
        { id: 'b', text: longB },
      ],
      deps(engine, { cache }),
    );

    expect(calls).toHaveLength(3);
    expect(calls[1].length).toBeGreaterThan(1);
    expect(out[0].text).toBe(calls[1].map((text) => `译:${text}`).join(''));
    expect(out[1]).toMatchObject({ id: 'b', text: null, code: 'AUTH', message: 'Key 无效' });

    // a 的译文已经写进缓存：重试只需再翻 b，不会再请求引擎。
    await expect(cache.count()).resolves.toBe(1);
    const again = await translateBatch([{ id: 'a', text: longA }], deps(engine, { cache }));
    expect(again[0].text).toBe(out[0].text);
    expect(calls).toHaveLength(3);
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

  it('换模型后同一段文本不会命中旧模型的缓存', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    const plain = fakeEngine([['你好']]);
    const smart = fakeEngine([['您好']]);

    const first = await translateBatch(
      [{ id: 'a', text: 'Hello' }],
      deps(plain.engine, { cache, engineConfig: { model: 'plain' } }),
    );
    const second = await translateBatch(
      [{ id: 'a', text: 'Hello' }],
      deps(smart.engine, { cache, engineConfig: { model: 'smart' } }),
    );

    expect(first[0].text).toBe('你好');
    expect(smart.calls).toHaveLength(1);
    expect(second[0].text).toBe('您好');
  });

  it('单条请求返回条目数不符时不再降级，直接报错', async () => {
    // translateWithFallback 的逐条降级以 texts.length > 1 为条件：只有一条时可退的地方
    // 都没有，只能把 BAD_RESPONSE 上报，否则会拿 [text] 反复请求同一个引擎。
    const { engine, calls } = fakeEngine([['甲', '乙']]);
    const out = await translateBatch([{ id: 'a', text: 'A' }], deps(engine));

    expect(calls).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'a', text: null, code: 'BAD_RESPONSE' });
  });

  it('缓存写入失败不影响译文，也不向调用方抛错', async () => {
    // CacheLike 是鸭子类型接口，putMany 抛错不在类型系统里排除；
    // 写失败只该意味着"这次没缓存上"，不能把翻译成功的一批上报成失败。
    const cache: CacheLike = {
      getMany: async () => new Map(),
      putMany: async () => {
        throw new Error('storage exploded');
      },
    };
    const { engine } = fakeEngine([['你好']]);

    await expect(translateBatch([{ id: 'a', text: 'Hello' }], deps(engine, { cache }))).resolves.toEqual([
      { id: 'a', text: '你好' },
    ]);
  });

  it('缓存读取失败时退化为全部未命中，仍然照常翻译', async () => {
    const cache: CacheLike = {
      getMany: async () => {
        throw new Error('storage exploded');
      },
      putMany: async () => {},
    };
    const { engine, calls } = fakeEngine([['你好']]);

    const out = await translateBatch([{ id: 'a', text: 'Hello' }], deps(engine, { cache }));

    expect(calls).toHaveLength(1);
    expect(out).toEqual([{ id: 'a', text: '你好' }]);
  });

  it('逐条降级途中的网络错误照样退避重试', async () => {
    // 降级把一批摊成 N 次请求，撞上瞬时抖动的概率比整批请求更高，
    // 规格给的退避预算在这里同样要用上。
    const sleeps: number[] = [];
    const { engine, calls } = fakeEngine([['只有一条'], new EngineError('NETWORK', '断网'), ['甲'], ['乙']]);
    const out = await translateBatch(
      [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ],
      deps(engine, { sleep: async (ms) => void sleeps.push(ms) }),
    );

    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([500]);
    expect(out).toEqual([
      { id: 'a', text: '甲' },
      { id: 'b', text: '乙' },
    ]);
  });

  it('逐条降级中某条失败时，保留已成功的译文并只标记失败的那条', async () => {
    // 成功的那条不该被邻居的错误码连坐，也不该把已经发出去的请求白费掉。
    const cache = new TranslationCache(new MemoryStorage());
    const { engine, calls } = fakeEngine([
      ['只有一条'],
      ['甲'],
      new EngineError('AUTH', 'Key 无效'),
    ]);
    const out = await translateBatch(
      [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ],
      deps(engine, { cache }),
    );

    expect(calls).toHaveLength(3);
    expect(out).toEqual([
      { id: 'a', text: '甲' },
      { id: 'b', text: null, code: 'AUTH', message: 'Key 无效' },
    ]);
    // 成功的那条已经写进缓存：重试只需再翻 B。
    await expect(cache.count()).resolves.toBe(1);
  });

  it('外部 signal 已取消时，引擎收到的是已取消的 signal 且不重试', async () => {
    // 调度器自己不设超时，但取消必须能从 deps.signal 注入：否则后续单元做超时/取消
    // 时只能改 translate 的签名，波及所有调用点。
    const external = new AbortController();
    external.abort();
    const seen: boolean[] = [];
    let calls = 0;
    const engine: Translator = {
      id: 'fake',
      name: 'Fake',
      needsKey: false,
      supportsGlossary: false,
      async translate(request: TranslateRequest): Promise<string[]> {
        calls += 1;
        seen.push(request.signal.aborted);
        throw new EngineError('ABORTED', '请求已取消');
      },
    };

    const out = await translateBatch([{ id: 'a', text: 'A' }], deps(engine, { signal: external.signal }));

    expect(seen).toEqual([true]);
    // ABORTED 不在退避预算里：取消后再重发两次毫无意义。
    expect(calls).toBe(1);
    expect(out[0]).toMatchObject({ id: 'a', text: null, code: 'ABORTED' });
  });

  it('外部 signal 在调用途中取消时会转发给引擎', async () => {
    const external = new AbortController();
    let abortedDuringCall = false;
    const engine: Translator = {
      id: 'fake',
      name: 'Fake',
      needsKey: false,
      supportsGlossary: false,
      async translate(request: TranslateRequest): Promise<string[]> {
        return await new Promise<string[]>((_resolve, reject) => {
          if (request.signal.aborted) {
            abortedDuringCall = true;
            reject(new EngineError('ABORTED', '请求已取消'));
            return;
          }
          request.signal.addEventListener(
            'abort',
            () => {
              abortedDuringCall = true;
              reject(new EngineError('ABORTED', '请求已取消'));
            },
            { once: true },
          );
          // 请求已经在飞的时候外部才取消。
          external.abort();
        });
      },
    };

    const out = await translateBatch([{ id: 'a', text: 'A' }], deps(engine, { signal: external.signal }));

    expect(abortedDuringCall).toBe(true);
    expect(out[0]).toMatchObject({ id: 'a', text: null, code: 'ABORTED' });
  });

  it('纯空白条目原样返回，不被改写成空串', async () => {
    // 内容脚本会把结果写回节点：把 '  \n ' 改成 '' 会清空一个只含空白的节点，
    // 双语模式下的行内排版会跟着变。语义是"没什么可翻，原样保留"。
    const cache = new TranslationCache(new MemoryStorage());
    const { engine, calls } = fakeEngine([['你好']]);
    const out = await translateBatch(
      [
        { id: 'a', text: '  \n ' },
        { id: 'b', text: 'Hello' },
      ],
      deps(engine, { cache }),
    );

    expect(out).toEqual([
      { id: 'a', text: '  \n ' },
      { id: 'b', text: '你好' },
    ]);
    expect(calls).toEqual([['Hello']]);
    await expect(cache.count()).resolves.toBe(1);
  });

  it('空文本不进引擎也不写缓存', async () => {
    const cache = new TranslationCache(new MemoryStorage());
    const { engine, calls } = fakeEngine([['你好']]);
    const out = await translateBatch(
      [
        { id: 'a', text: '' },
        { id: 'b', text: 'Hello' },
      ],
      deps(engine, { cache }),
    );

    expect(calls).toEqual([['Hello']]);
    expect(out).toEqual([
      { id: 'a', text: '' },
      { id: 'b', text: '你好' },
    ]);
    await expect(cache.count()).resolves.toBe(1);
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
  RETRYABLE_CODES,
  toEngineError,
  type EngineConfig,
  type Term,
  type Translator,
} from '../engines/types';
import type { TranslateItem, TranslateItemResult } from '../shared/messages';

/**
 * 批次用到的缓存子集。实现允许抛错也允许不抛错：`translateBatch` 两种都兜得住
 * （读失败当未命中、写失败当没缓存上），不把缓存异常抛给调用方。
 * 生产实现 `core/cache.ts` 不抛错，见那里的不变量 3。
 */
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
  /**
   * 外部取消信号。调度器自己不设超时（超时归 content script，见 `callEngine`），
   * 但必须留一个能把取消注入引擎的入口：一旦它 abort，引擎收到的 signal 也跟着 abort。
   */
  signal?: AbortSignal;
  /** 测试可注入假定时器；默认真实等待 */
  sleep?: (ms: number) => Promise<void>;
}

/** 退避预算（规格 §8）：网络错误 / 超时退避 500ms → 1500ms 两次。 */
const BACKOFF_MS = [500, 1500];

/** 二次切分的阈值下限：切点只允许落在句子边界，见 `splitBySentence`。 */
const SPLIT_MIN_LEN = 200;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function callEngine(texts: string[], deps: BatchDeps): Promise<string[]> {
  // signal 是 TranslateRequest 的必填字段，两个引擎都真的用了它（fetch 的 signal、
  // 以及拿到响应后再查一次 aborted）。外部取消经 deps.signal 注入；调度器自身不设超时：
  // 设计规格把超时归给 content script（§8「content script 侧对请求加超时」），
  // 那个超时由 WU7 落地。这里给一个假超时反而会掐掉合法的大批次。
  const controller = new AbortController();
  if (deps.signal?.aborted) controller.abort();
  else deps.signal?.addEventListener('abort', () => controller.abort(), { once: true });
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

/**
 * 一次引擎调用加它应得的退避重试（规格 §8：网络错误 / 超时退避 500ms → 1500ms 两次）。
 *
 * 边界：批量重试是最后手段，条目级的抖动由引擎内部吸收（见 `engines/google.ts` 的
 * `translateOneWithRetry`）。调度器只看得到「整批成功 / 整批失败」，一次调用摊成的
 * N 个请求里任意一个抖动都会让整批失败，所以引擎必须先按条目重试；否则 12 条批次里
 * 第 11 条抖一次就会实打实发出 24 条文本，免费接口的 429 还会把「抖动 → 整批重发 →
 * 限流 → 再整批重发」接成正反馈。
 *
 * 残留风险：某一条连续失败（超出引擎的条目重试预算）时，这里仍会把整批重发一次；
 * 已经成功的那几条也白翻一遍。彻底消除要等引擎能把「逐条成败」上报给调度器。
 *
 * 降级路径（切分、逐条）也必须走这里。它们把一次请求摊成 N 次，撞上瞬时抖动的概率
 * 本就比整批请求高；少了这层重试，第 11 次调用的一次抖动会让整批 12 条一起报错。
 *
 * 只重试瞬时错误（见 `RETRYABLE_CODES`）：`BAD_RESPONSE` 重试同一个输入没有意义，
 * 它是调用方决定降级还是上报的依据；`TOO_LONG` 该降到切分路径，重问一次必然还是过长。
 * 判据只有 `RETRYABLE_CODES` 一份（`engines/types`），调度器不再自带一套集合——
 * 两处各写一份时「`TOO_LONG` 算不算可重试」会随改动漂移。
 */
async function callEngineWithRetry(texts: string[], deps: BatchDeps): Promise<string[]> {
  const sleep = deps.sleep ?? defaultSleep;
  let last: EngineError | undefined;

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
    try {
      return await callEngine(texts, deps);
    } catch (raw) {
      const error = toEngineError(raw);
      last = error;

      if (!RETRYABLE_CODES.has(error.code)) throw error;

      if (attempt < BACKOFF_MS.length) await sleep(BACKOFF_MS[attempt]);
    }
  }
  throw last ?? new EngineError('UNKNOWN', '未知错误');
}

/**
 * 引擎报文本过长时，把每条按句子切开分别翻译，再拼回一段。
 *
 * 与 `translateOneByOne` 同形：逐条 try/catch，某条（或它切出的某一片）失败只把该条的
 * `EngineError` 放进对应位置。整批抛出会让 `translateBatch` 把所有 missing 条目标成
 * 同一个错误码——a 明明已经切分翻好了，却因为 b 的 AUTH 被连坐，连缓存都进不去。
 */
async function translateSplit(
  texts: string[],
  deps: BatchDeps,
): Promise<Array<string | EngineError>> {
  const out: Array<string | EngineError> = [];
  for (const text of texts) {
    try {
      const pieces = splitBySentence(text, Math.max(SPLIT_MIN_LEN, Math.ceil(text.length / 2)));
      const translated = await callEngineWithRetry(pieces, deps);
      out.push(joinPieces(translated, deps.targetLang));
    } catch (raw) {
      out.push(toEngineError(raw));
    }
  }
  return out;
}

/**
 * 模型没按编号返回时，退回逐条翻译，牺牲速度换正确性。
 *
 * 返回与 texts 等长的结果数组，而不是只成功时返回：某一条失败不该把前面已经翻好的
 * 条目一起丢掉。调用方拿到成功项照常上报与写缓存，只把失败的下标标成错误。
 */
async function translateOneByOne(
  texts: string[],
  deps: BatchDeps,
): Promise<Array<string | EngineError>> {
  const out: Array<string | EngineError> = [];
  for (const text of texts) {
    try {
      const single = await callEngineWithRetry([text], deps);
      out.push(single[0]);
    } catch (raw) {
      out.push(toEngineError(raw));
    }
  }
  return out;
}

/** 正常结果与逐条降级的半成品都从这里出来，后者见 `translateOneByOne`。 */
async function translateWithFallback(
  texts: string[],
  deps: BatchDeps,
): Promise<Array<string | EngineError>> {
  try {
    return await callEngineWithRetry(texts, deps);
  } catch (raw) {
    const error = toEngineError(raw);

    if (error.code === 'TOO_LONG') return translateSplit(texts, deps);
    // 只有一条时没有可退的地方：再拿同一个 [text] 问一次 BAD_RESPONSE，只会无限打转。
    if (error.code === 'BAD_RESPONSE' && texts.length > 1) return translateOneByOne(texts, deps);

    throw error;
  }
}

/**
 * 处理一个批次：缓存命中直接返回，未命中的合并成一次引擎请求——其中**字面相同的文本
 * 只翻一次**（见下方 `uniqueTexts`），结果再按条目摊回。
 * 任何失败都转成携带错误码的结果项，绝不抛错——内容脚本据此渲染"重试"按钮。
 * 缓存读写失败不在此列：那不是"这次翻译失败"，降级即可（读当未命中、写当没缓存上）。
 */
export async function translateBatch(items: TranslateItem[], deps: BatchDeps): Promise<TranslateItemResult[]> {
  const results: TranslateItemResult[] = items.map((item) => ({ id: item.id, text: null }));
  if (items.length === 0) return results;

  const glossaryHash = hashString(JSON.stringify(deps.glossary ?? []));
  const promptHash = hashString(deps.systemPrompt ?? '');
  const configHash = hashString(
    JSON.stringify({ baseUrl: deps.engineConfig.baseUrl ?? '', model: deps.engineConfig.model ?? '' }),
  );
  const keys = items.map((item) =>
    buildCacheKey({
      engineId: deps.engine.id,
      configHash,
      // 源语言也进 key：`sourceLang` 是设置项、会一路传到 `TranslateRequest.from`，
      // 它不参与 key 时，改了源语言就会命中按另一种语义翻出来的旧译文（见 core/hash.ts）。
      sourceLang: deps.sourceLang,
      targetLang: deps.targetLang,
      glossaryHash,
      promptHash,
      text: item.text,
    }),
  );

  // CacheLike 是鸭子类型接口，读失败由实现自行决定抛不抛；这里自己兜住，
  // 最坏只是把命中的条目也当成未命中重翻一遍，好过把异常抛出 translateBatch。
  let cached: Map<string, string>;
  try {
    cached = await deps.cache.getMany(keys);
  } catch {
    cached = new Map();
  }
  const missing: number[] = [];
  items.forEach((item, index) => {
    // 空文本不进引擎也不进缓存：'' 写进缓存与"翻成了空"无法区分，发给引擎也只是
    // 白发一次请求。但空白条目要原样返回：把 '  \n ' 改写成 '' 会让内容脚本清空一个
    // 只含空白的节点，双语模式下的行内排版会跟着变，而这里本来"没什么可翻"。
    if (item.text.trim() === '') {
      results[index] = { id: item.id, text: item.text };
      return;
    }
    const hit = cached.get(keys[index]);
    if (hit === undefined) missing.push(index);
    else results[index] = { id: item.id, text: hit };
  });
  if (missing.length === 0) return results;

  /**
   * 同一批里**字面完全相同**的文本只翻一次。
   *
   * 真实网页里重复文本很常见：导航、「Read more」、表头、免责声明能占 20-40% 的段落数。
   * 而 Google 引擎不支持一次请求多条文本（一条文本一个请求），逐条发等于把免费额度
   * 白烧在重复段上——正文反而会因 429 失败。缓存 key 是按文本算的，所以重复文本只会
   * 一起命中或一起未命中，折叠不会改变任何一条的结果。
   */
  const uniqueTexts: string[] = [];
  const indexesByText = new Map<string, number[]>();
  for (const index of missing) {
    const group = indexesByText.get(items[index].text);
    if (group === undefined) {
      indexesByText.set(items[index].text, [index]);
      uniqueTexts.push(items[index].text);
    } else {
      group.push(index);
    }
  }

  // 待写缓存的条目：声明在 try 之外，因为写入发生在 try/catch 之后（见下方注释）。
  const toCache = new Map<string, string>();
  /**
   * 落一条结果，返回它是否算失败。
   *
   * 类型守卫写在这里，是因为 `translateOneByOne` 的半成品用 `string | EngineError`
   * 表达逐条成败；这个判断同时承担 TS 的类型收窄和"成功才进缓存"的语义。
   */
  const settle = (index: number, translation: string | EngineError): boolean => {
    if (translation instanceof EngineError) {
      results[index] = {
        id: items[index].id,
        text: null,
        code: translation.code,
        message: translation.message,
      };
      return true;
    }
    results[index] = { id: items[index].id, text: translation };
    toCache.set(keys[index], translation);
    return false;
  };

  try {
    const translations = await translateWithFallback(uniqueTexts, deps);
    // 逐条降级的半成品：逐条上报，别把已经翻好的条目一起丢掉，也别给它们安上
    // 邻居的错误码。成功的那几条照常进缓存，用户点重试时只需再翻失败的那几条。
    // 去重后的结果按**下标组**摊回每一条：同一文本的 N 个条目拿到同一份译文，
    // 各自的缓存 key 也各自写上（key 由文本派生，这里其实是同一个 key）。
    uniqueTexts.forEach((text, offset) => {
      const translation = translations[offset];
      for (const index of indexesByText.get(text) ?? []) settle(index, translation);
    });
  } catch (raw) {
    const error = toEngineError(raw);
    for (const index of missing) settle(index, error);
  }

  // 写缓存放在引擎 try 之外：缓存写失败只意味着这次没缓存上，
  // 放进同一个 try 会把"翻译成功但没缓存上"上报成整批失败，给用户一个错误的重试按钮。
  // 因此这里单独兜住异常——CacheLike 是鸭子类型接口，不能假定实现不抛错，
  // 而 translateBatch 的对外契约是绝不抛错。
  try {
    await deps.cache.putMany(toCache);
  } catch {
    // 没写进缓存，下次再翻一遍即可；本轮的译文结果依然有效。
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
import { DEFAULT_SETTINGS, loadSettings } from '../shared/settings';
import { translateBatch } from './scheduler';

const MENU_TRANSLATE_PAGE = 'jinyi-translate-page';
const MENU_TRANSLATE_SELECTION = 'jinyi-translate-selection';

const persistentArea: StorageArea = chromeArea(chrome.storage.local);
const sessionArea: StorageArea = chromeArea(chrome.storage.session);

// 模块级只建一次缓存：`maxEntries` 是实例属性，条目却挂在存储区上，同一存储区上并存两个
// 上限不同的实例会互相剪掉对方刚写进去的条目（见 `core/cache.ts` 的不变量 1）。
const persistentCache = new TranslationCache(persistentArea, DEFAULT_SETTINGS.cacheMaxEntries);
const sessionCache = new TranslationCache(sessionArea, DEFAULT_SETTINGS.cacheMaxEntries);

/**
 * 启动时的只读设置查询（**取缓存上限**）：设置页会显示缓存条目数，所以冷启动就必须按
 * 用户配置的上限来裁剪，而不是先按默认上限、等第一条翻译消息到达时才纠正。
 * 读不出来（存储坏了、版本高于本代码）就返回 undefined，调用方据此跳过整次对账，
 * 绝不因此让 SW 启动失败。
 */
const startupSettings = loadSettings(persistentArea).catch(() => undefined);

/**
 * 启动时全量对账一次：`putMany` 只累加一个近似计数，形状坏掉的条目也只有扫描才看得见，
 * 这里把两者一次收敛成真实值（并顺手按上限裁剪）。缓存没有索引键可对账，淘汰顺序现算。
 *
 * 两处刻意的安排：
 * - 先 await 设置再 prune：prune 会按 `maxEntries` 真删条目，拿默认上限当用户上限就会
 *   多删（用户配 500 却按 5000 裁）。**设置读不出来时直接跳过整次对账**——实例上是默认
 *   的 5000，而用户配的更小（最小 100），照默认值裁同样会多删，且这是真删用户数据。
 *   近似计数留到下次成功读取设置后再收敛，代价只是晚一轮，比删错安全得多。
 * - 放在 `queueMicrotask` 里、而不是模块体里直接调：监听器注册与 `onMessage` 的返回
 *   值必须是**同步**的，这个存储区上的串行队列（`core/cache.ts` 的 `queue`）不该在
 *   此之前就被一次全量扫描占住。延后一个微任务仍然早于任何 `chrome.*` 事件回调。
 *   （注册本身是同步的，所以两种写法行为等价；这里只是让启动路径不与注册抢队列。）
 *
 * 导出只是为了让测试能等到它跑完；生产代码里没有任何地方 await 它。
 */
export const cachesInitialized: Promise<void> = (async () => {
  const settings = await startupSettings;
  if (!settings) return;
  persistentCache.setMaxEntries(settings.cacheMaxEntries);
  sessionCache.setMaxEntries(settings.cacheMaxEntries);
  // 两次 prune 并行：两个存储区各有一条队列，互不相关，没有必要串起来等。
  await Promise.all([persistentCache.prune(), sessionCache.prune()]);
})();

queueMicrotask(() => void cachesInitialized);

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
    const settings = await loadSettings(persistentArea);
    const engine = getEngine(settings.engineId);
    const targetLang = payload.targetLang ?? settings.targetLang;

    // 上限随设置变化；上限是实例属性而条目挂在存储区上，所以每个存储区只能有这一个实例
    // （见 `core/cache.ts` 的不变量 1），这里改的正是那个唯一实例的上限。
    persistentCache.setMaxEntries(settings.cacheMaxEntries);
    sessionCache.setMaxEntries(settings.cacheMaxEntries);
    const cache = new TieredCache(sessionCache, persistentCache);

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
    })
    // `sendResponse` 自己会抛：内容脚本先关掉端口（自己的超时、页面跳走、SW 被回收）时
    // 第一个 `sendResponse` 就抛，上面的 catch 又调用它一次、那个异常背后再没有处理者，
    // 整条消息会变成一个未处理拒绝。消息已经没人收，静默丢弃即可。
    .catch(() => undefined);
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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectSegments, isBlockDisplay } from '../../src/content/extractor';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

/**
 * 参照实现：与被测代码无关，只按 WU7 的拼接规格重写一遍——
 * 「片段内部折叠空白、不 trim；拼接时只有两侧都是词字符、且都不在 CJK 区间才补一个空格」。
 * 不变量用例靠它独立算出期望值，避免拿被测函数去验证被测函数。
 */
const REF_SKIP_TAGS = new Set([
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
const REF_WORD = /[\p{L}\p{N}]/u;
const REF_CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

function refJoin(previous: string, next: string): string {
  if (previous === '' || next === '') return previous + next;
  const last = previous[previous.length - 1];
  const first = next[0];
  if (/\s/.test(last) || /\s/.test(first)) return previous + next;
  if (REF_CJK.test(last) || REF_CJK.test(first)) return previous + next;
  if (!REF_WORD.test(last) || !REF_WORD.test(first)) return previous + next;
  return `${previous} ${next}`;
}

/** 参照实现：把一个只含行内内容的元素的文本按规格拼出来。 */
function refTextOf(element: Element): string {
  let out = '';
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out = refJoin(out, (node.nodeValue ?? '').replace(/\s+/g, ' '));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (REF_SKIP_TAGS.has(child.tagName)) return;
    for (const grandChild of Array.from(child.childNodes)) walk(grandChild);
  };
  for (const child of Array.from(element.childNodes)) walk(child);
  return out.replace(/\s+/g, ' ').trim();
}

/** 参照实现里「块级」按标签名判定：与被测代码的 computed display 判定互相独立。 */
const REF_BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIALOG',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HGROUP',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

/**
 * 参照实现：容器里的松散文本运行——以块级子元素为界切分，
 * 每个运行给出「拼好的文本」与「这段文本之后的下一个兄弟节点」（容器末尾是 null）。
 */
function refLooseRuns(container: Element): Array<{ text: string; before: Node | null }> {
  const nodes = Array.from(container.childNodes);
  const runs: Array<{ text: string; before: Node | null }> = [];
  let current: { text: string; before: Node | null } | null = null;

  nodes.forEach((node, index) => {
    if (node.nodeType === Node.ELEMENT_NODE && REF_BLOCK_TAGS.has((node as Element).tagName)) {
      current = null;
      return;
    }
    if (current === null) {
      current = { text: '', before: null };
      runs.push(current);
    }
    if (node.nodeType === Node.TEXT_NODE) {
      current.text = refJoin(current.text, (node.nodeValue ?? '').replace(/\s+/g, ' '));
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      current.text = refJoin(current.text, refTextOf(node as Element));
    }
    current.before = nodes[index + 1] ?? null;
  });

  return runs
    .map((run) => ({ text: run.text.replace(/\s+/g, ' ').trim(), before: run.before }))
    .filter((run) => run.text !== '');
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

/**
 * 隐藏判定（display:none / visibility:hidden / hidden / aria-hidden）与行内文本拼装
 * 现在都只在 collectSegments 内部按元素缓存一次，所以这里不再单独断言那两个内部函数，
 * 改由下面 collectSegments 的用例端到端覆盖——那里才是它们真正影响结果的地方。
 */

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

  it('折叠空白', () => {
    const root = mount('<p>  Hello\n   world  </p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Hello world']);
  });

  it('有空白或标点做边界时不重复补分隔符', () => {
    const root = mount('<p>Hello <b>bold</b>, and <i>italic</i>.</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Hello bold, and italic.']);
  });

  it('抽出文本与页面上写的文本逐字一致：标点与符号旁的空格不能被删掉', () => {
    const cases: Array<[string, string]> = [
      ['<p>The plan — announced today — failed.</p>', 'The plan — announced today — failed.'],
      ['<p>It costs 5 $ per unit today.</p>', 'It costs 5 $ per unit today.'],
      ['<p>Sales rose 50 % in May.</p>', 'Sales rose 50 % in May.'],
      ['<p>Compute a + b first.</p>', 'Compute a + b first.'],
      ['<p>Well ... that happened.</p>', 'Well ... that happened.'],
    ];
    for (const [html, expected] of cases) {
      expect(collectSegments(mount(html), { targetLang: 'zh-Hans' }).map((s) => s.text)).toEqual([expected]);
    }
  });

  it('中文之间不插空格，中英之间也不插', () => {
    const root = mount('<p>東京<b>タワー</b>へ行く</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['東京タワーへ行く']);
  });

  it('透明包裹里有块级后代时下钻进去成段（inline-block）', () => {
    const root = mount(
      '<div><span style="display:inline-block"><h3>Heading here</h3><p>Body text here</p></span></div>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Heading here', 'Body text here']);
  });

  it('透明包裹里有块级后代时下钻进去成段（display:contents）', () => {
    const root = mount(
      '<div><section style="display:contents"><p>One two three</p><p>Four five six</p></section></div>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['One two three', 'Four five six']);
  });

  it('inline-block 里没有块级后代时不算边界，仍并入父段', () => {
    const root = mount('<p>Hello <span style="display:inline-block">world</span></p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Hello world']);
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

  it('混合内容里容器自己的直接文本也成段，且保持文档顺序', () => {
    const root = mount(
      '<div>Article intro sentence here<p>Body paragraph one is here</p>Article outro sentence here</div>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual([
      'Article intro sentence here',
      'Body paragraph one is here',
      'Article outro sentence here',
    ]);
  });

  it('混合内容的文本段锚在容器上，落点显式指向容器里的位置', () => {
    const root = mount('<div>Intro sentence here<p>Body paragraph text</p>Outro sentence here</div>');
    const div = document.querySelector('div') as HTMLElement;
    const paragraph = document.querySelector('p') as HTMLElement;
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });

    expect(segments[0].textRun).toBe(true);
    expect(segments[0].element).toBe(div);
    // 容器开头那段：译文插到紧随其后的块级子元素之前，仍留在容器内部。
    expect(segments[0].anchor).toEqual({ kind: 'before', node: paragraph });
    expect(segments[1].textRun).toBeUndefined();
    expect(segments[1].element).toBe(paragraph);
    expect(segments[1].anchor).toEqual({ kind: 'auto' });
    expect(segments[2].textRun).toBe(true);
    expect(segments[2].element).toBe(div);
    // 段尾那段：后面再没有兄弟节点，追加到容器末尾。
    // （旧实现恒取「容器里第一个块级子元素之前」，它的译文会跑到正文段落上面去。）
    expect(segments[2].anchor).toEqual({ kind: 'before', node: null });
  });

  it('列表项里「标签文本 + 嵌套列表」两段都不丢', () => {
    const root = mount('<ul><li>Item label text<ul><li>Nested item text</li></ul></li></ul>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Item label text', 'Nested item text']);
  });

  it('相邻行内元素之间补分隔符，不在同一个非词里粘连', () => {
    const root = mount('<nav><a><span>Home</span></a><a><span>Pricing</span></a><a><span>Docs</span></a></nav>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Home Pricing Docs']);
  });

  it('<br> 是硬边界，各行分别成段', () => {
    const root = mount('<address>1 Main St<br>Springfield<br>IL 62704</address>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['1 Main St', 'Springfield', 'IL 62704']);
  });

  it('段落中段的直接文本落点在容器里、它后面那个块级子元素之前', () => {
    const root = mount('<div><p>Block one text</p>stray inline text<p>Block two text</p></div>');
    const div = document.querySelector('div') as HTMLElement;
    const second = document.querySelectorAll('p')[1];
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Block one text', 'stray inline text', 'Block two text']);
    expect(segments[1].textRun).toBe(true);
    // 落点是容器（不再借用后一个块级子元素当锚点），位置显式指向那个兄弟节点。
    expect(segments[1].element).toBe(div);
    expect(segments[1].anchor).toEqual({ kind: 'before', node: second });
  });

  it('就地替换只留给「整块就是这一段文本」的元素', () => {
    const root = mount('<p>Hello <b>bold</b> world</p><p>Plain english text</p>');
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    // 带行内标记的段落不能被 textContent 盖掉，标记成 textRun 让渲染器改走双语注入。
    expect(segments[0].textRun).toBe(true);
    // 整元素段落一律走 auto 落点，由渲染器按布局规则决定插到哪。
    expect(segments[0].anchor).toEqual({ kind: 'auto' });
    expect(segments[1].textRun).toBeUndefined();
    expect(segments[1].anchor).toEqual({ kind: 'auto' });
  });

  it('跳过隐藏元素自身，也跳过整个隐藏子树', () => {
    const root = mount(
      '<div style="display:none"><p style="display:block">Hidden panel text</p></div>' +
        '<div aria-hidden="true"><p style="display:block">Aria hidden text</p></div>' +
        '<p hidden>Hidden attribute text</p>' +
        '<p style="visibility:hidden">Invisible text</p>' +
        '<p>Visible sentence here</p>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Visible sentence here']);
  });

  it('display:none 的容器：自己的直接文本与整棵子树都不产出', () => {
    const root = mount('<div style="display:none">Hidden intro text<p>Hidden body text</p></div>');
    expect(collectSegments(root, { targetLang: 'zh-Hans' })).toEqual([]);
  });

  it('aria-hidden="true" 的容器同样一个字符都不产出', () => {
    const root = mount('<div aria-hidden="true">Hidden intro text<p>Hidden body text</p></div>');
    expect(collectSegments(root, { targetLang: 'zh-Hans' })).toEqual([]);
  });

  it('hidden 属性的容器同样一个字符都不产出', () => {
    const root = mount('<div hidden>Hidden intro text<p>Hidden body text</p></div>');
    expect(collectSegments(root, { targetLang: 'zh-Hans' })).toEqual([]);
  });

  it('隐藏的行内子元素不并入父段', () => {
    const root = mount(
      '<p>Visible <span style="display:none">secret draft text</span> text here</p>' +
        '<p>Another <span aria-hidden="true">hidden fragment</span> sentence here</p>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Visible text here', 'Another sentence here']);
  });

  /**
   * 用户**正在写、还没保存**的内容（邮件草稿、笔记、评论框）属于隐私：它确实在网页里可见，
   * 但它是用户的半成品，不是网页的内容。README 的隐私一节承诺过它不会被翻译。
   */
  it('contenteditable 容器里的草稿不产出段落', () => {
    const root = mount(
      '<div contenteditable="true">My private unfinished English draft</div>' +
        '<p>Published paragraph text</p>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Published paragraph text']);
  });

  it('可编辑性会继承给后代：contenteditable 里的块级子元素同样不产出', () => {
    const root = mount(
      '<div contenteditable="true"><p>Draft inside a paragraph</p><p>Another draft line</p></div>' +
        '<p>Published paragraph text</p>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Published paragraph text']);
  });

  it('行内的 contenteditable 草稿不并入父段', () => {
    const root = mount(
      '<p>Visible <span contenteditable="true">private draft</span> text here</p>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Visible text here']);
  });

  it('contenteditable="false" 只是显式关掉可编辑：它的文本照常翻译', () => {
    // 所见即所得编辑器用 false 嵌只读片段，那不是"用户没写完的草稿"，不该被跳过。
    const root = mount(
      '<div contenteditable="false">Read only published text</div>' +
        '<div contenteditable="true"><span contenteditable="false">nested read only text</span></div>',
    );
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Read only published text']);
  });

  it('重扫时容器里新追加的内容会被采到，已处理的段落不重复产出', () => {
    const root = mount('<div id="feed"><p>First post text</p></div>');
    const feed = document.getElementById('feed') as HTMLElement;
    expect(collectSegments(root, { targetLang: 'zh-Hans' }).map((s) => s.text)).toEqual(['First post text']);

    const added = document.createElement('p');
    added.textContent = 'Second post text';
    feed.append(added);

    // 容器本身没被标记：整棵子树短路过一次，新内容就永远不翻了。
    expect(feed.hasAttribute('data-jy-translated')).toBe(false);
    expect(collectSegments(root, { targetLang: 'zh-Hans' }).map((s) => s.text)).toEqual(['Second post text']);
  });

  it('同一元素只解析一次样式：样式查询次数不超过元素总数', () => {
    const rows = Array.from(
      { length: 8 },
      (_, index) => `<div><h2>Heading number ${index}</h2><p>Body paragraph number ${index}.</p></div>`,
    ).join('');
    const root = mount(rows);

    let elementCount = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode() !== null) elementCount += 1;

    const view = document.defaultView as Window & typeof globalThis;
    const real = view.getComputedStyle.bind(view);
    let lookups = 0;
    const spy = vi.spyOn(view, 'getComputedStyle').mockImplementation((...args) => {
      lookups += 1;
      return real(...args);
    });

    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    spy.mockRestore();

    expect(segments).toHaveLength(16);
    // 采集前每个元素最多问一次；缓存失效会让这个数字掉到元素总数的两倍以上。
    expect(lookups).toBeLessThanOrEqual(elementCount);
    expect(lookups).toBeGreaterThan(0);
  });
});

describe('抽出文本的不变量', () => {
  /**
   * 混排结构的集合：破折号、货币、百分号、数学式、省略号、行内标记、标点边界、
   * 中日韩混排、实体、多余空白、符号紧贴字母。每一段都必须逐字等于参照实现的结果。
   */
  const MIXED_BLOCKS = [
    'The plan — announced today — failed.',
    'It costs 5 $ per unit today.',
    'Sales rose 50 % in May.',
    'Compute a + b first.',
    'Well ... that happened.',
    'Hello <b>bold</b>, and <i>italic</i>.',
    '東京<b>タワー</b>へ行く',
    'Home <a href="/pricing"><span>Pricing</span></a> page',
    'Mixed <em>mark</em>up &amp; entities  spaced   out',
    'Prefix<span>suffix</span>5 $<b>+</b>tax',
  ];

  it('每一段的 text 都等于把该段节点的内容按同一套规则独立重算的结果', () => {
    const root = mount(
      `<section class="page">${MIXED_BLOCKS.map((html) => `<p>${html}</p>`).join('\n')}</section>`,
    );
    const blocks = Array.from(document.querySelectorAll('section.page > p'));
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });

    // 每个文本块恰好一段、不多不少、顺序与文档一致，且整元素段落走 auto 落点。
    expect(segments).toHaveLength(blocks.length);
    segments.forEach((segment, index) => {
      expect(segment.element).toBe(blocks[index]);
      expect(segment.anchor.kind).toBe('auto');
      expect(segment.text).toBe(refTextOf(blocks[index]));
    });
  });

  it('每一段松散文本的 text 与落点都等于独立重算的结果', () => {
    const root = mount(
      '<div id="box">' +
        '<p>Block one text</p>' +
        'stray text here<span> tail text</span>' +
        '<p>Block two text</p>' +
        'last words here' +
        '</div>',
    );
    const box = document.getElementById('box') as HTMLElement;
    const segments = collectSegments(root, { targetLang: 'zh-Hans' });
    const loose = segments.filter((segment) => segment.anchor.kind === 'before');
    const expected = refLooseRuns(box);

    expect(loose.map((segment) => segment.text)).toEqual(expected.map((run) => run.text));
    // 落点必须正好是「这一段文本之后的下一个兄弟节点」，null = 容器末尾。
    expect(
      loose.map((segment) => (segment.anchor.kind === 'before' ? segment.anchor.node : undefined)),
    ).toEqual(expected.map((run) => run.before));
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

/** 译文宿主的落点。整元素段落交给渲染器按布局规则决定；松散文本段落必须显式给出位置。 */
export type SegmentAnchor =
  | { kind: 'auto' }
  | { kind: 'before'; node: Node | null }; // null = 追加到 element 末尾

export interface ExtractedSegment {
  id: string;
  text: string;
  order: number;
  /**
   * 段落锚点。整元素段落就是**承载整段文本的元素**；
   * 松散文本段落（见 `textRun`）则是**包裹这些直接文本节点的容器**——
   * 因为文本节点本身没有属性可挂，也没有插入点语义，落点改由 `anchor` 显式给出。
   */
  element: HTMLElement;
  /** 译文宿主的落点；松散文本段落一定是 `before`，见 {@link SegmentAnchor}。 */
  anchor: SegmentAnchor;
  /**
   * 该段只是锚点里的**一部分直接文本**，同容器里还有别的块级子元素（它们的文本各自成段）。
   * 渲染器必须把译文留在锚点**内部**，否则译文与对应原文会被块级子元素隔开。
   */
  textRun?: boolean;
  /**
   * 旧字段，采集端在 Fix 4（显式落点）之后**不再产出**：落点一律由 `anchor` 给出，
   * 这一项只是为了不动对外接口而保留声明（`resolveInsertion` 仍认识它）。
   */
  prepend?: boolean;
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

/**
 * 透明包裹：自身不生成块级盒（`contents` 连盒都不生成），但里面的块级后代仍然要按块处理。
 * 只看 BLOCK_DISPLAYS 会把这些包裹整体当成行内，于是整棵子树既不成段也不参与拼接，
 * 那片区域永远没有译文，父容器还会被标记成已翻译——静默漏翻。
 */
const TRANSPARENT_DISPLAYS = new Set(['inline-block', 'inline-flex', 'inline-grid', 'contents']);

/** 递归判定的深度上限。DOM 是树、不可能成环，但病态深树不该把调用栈吃掉。 */
const MAX_WRAPPER_DEPTH = 16;

interface ElementStyle {
  display: string;
  visibility: string;
}

/** `styleOf` 的读取口径。渲染器要复用 {@link inlineText}，所以这个形状是导出的。 */
export interface StyleLookup {
  (element: Element): ElementStyle;
}

/**
 * `getComputedStyle` 每次都强制样式解析，而一次采集会对同一元素问好几遍
 * （隐藏判定、块级判定、文本段扫描），10k 元素的页面就是 3 万次。
 * 一次采集内同一元素的结果不会变（这期间我们不插节点、不改样式），缓存起来即可。
 * 跨采集必须丢弃：页面可能在这之间改了样式。
 *
 * 渲染器也用同一条口径（见 {@link inlineText}）："这个元素为这一段贡献了哪些文字"
 * 只能有一份实现，两边各写一套必然随改动漂移。
 */
export function createStyleLookup(): StyleLookup {
  const cache = new WeakMap<Element, ElementStyle>();
  return (element) => {
    const cached = cache.get(element);
    if (cached !== undefined) return cached;
    // 不用宿主全局：元素属于哪个文档就问哪个文档的视图，同源 iframe 里也拿得到它自己的样式。
    const view = element.ownerDocument?.defaultView;
    const style = view?.getComputedStyle(element);
    const entry: ElementStyle = {
      display: style?.display ?? '',
      visibility: style?.visibility ?? '',
    };
    cache.set(element, entry);
    return entry;
  };
}

function isHidden(element: Element, styleOf: StyleLookup): boolean {
  if (element.hasAttribute('hidden')) return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;
  const style = styleOf(element);
  if (style.display === 'none') return true;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  return false;
}

/**
 * 这些元素既不贡献文本，也不下钻。文本段扫描与块级判定共用同一份口径，
 * 免得「这里跳过、那里不跳过」两处规则漂移。
 */
function isSkippedForText(element: Element): boolean {
  return SKIP_TAGS.has(element.tagName) || isEditable(element) || element.closest('[data-jy-root]') !== null;
}

/**
 * 可编辑区域（`contenteditable`）里的文本一律不采集。
 *
 * 用户**正在写、还没保存**的内容——邮件草稿、笔记、评论框——是隐私：它确实"在网页里可见"，
 * 但它是用户的半成品，不是网页的内容，不该被送去外部接口（README 的隐私承诺）。
 *
 * 两层判定：
 * 1. `element.isContentEditable` 是标准做法，浏览器把可编辑性**继承**给后代
 *    （`<div contenteditable="true"><p>草稿</p></div>` 里的 `p` 也是可编辑的）；
 * 2. 宿主没实现该属性时（老引擎、测试环境）退回按最近的 `[contenteditable]` 祖先判定，
 *    显式的 `contenteditable="false"` 会把它自己与子树重新变回不可编辑（所见即所得编辑器
 *    用它嵌只读片段），`inherit` 则继续往上找。
 */
function isEditable(element: Element): boolean {
  if ((element as HTMLElement).isContentEditable === true) return true;
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const value = node.getAttribute('contenteditable');
    if (value === null || value === 'inherit') continue;
    return value !== 'false';
  }
  return false;
}

/**
 * 一个子元素算不算**块级边界**（即：父元素的文本到此为止，这块自己成段）：
 * 1. 它的 computed display 在白名单里；或者
 * 2. 它是透明包裹（inline-block / inline-flex / inline-grid / contents）**并且**内部存在块级后代。
 *
 * 第 2 条是必须的：`<span style="display:inline-block"><h3>标题</h3><p>正文</p></span>`
 * 与 Tailwind 的 `contents` 工具类在真实站点里都很常见。少了它，包裹内部整棵子树
 * 既不成段也不参与拼接，那片区域永远没有译文。
 * 反过来，`<span style="display:inline-block">world</span>` 内部没有块级后代，
 * 就不算边界——它仍然是父段的一部分，`<p>Hello <span …>world</span></p>` 抽成一段。
 */
function isBlockBoundary(element: Element, styleOf: StyleLookup, depth: number): boolean {
  const display = styleOf(element).display;
  if (isBlockDisplay(display)) return true;
  if (!TRANSPARENT_DISPLAYS.has(display)) return false;
  return hasBlockDescendant(element, styleOf, depth);
}

function hasBlockDescendant(
  element: Element,
  styleOf: StyleLookup,
  depth: number,
): boolean {
  if (depth > MAX_WRAPPER_DEPTH) return false;
  for (const child of Array.from(element.children)) {
    if (isSkippedForText(child) || child.nodeName === 'BR') continue;
    if (isBlockBoundary(child, styleOf, depth + 1)) return true;
  }
  return false;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

/**
 * 只有两侧都是「词字符」且都不在 CJK 区间时才补一个空格，其余一律直接拼。
 *
 * 判定必须在**拼接处**做，不能做成对整段文本的全局后处理：全局后处理分不清
 * 「插件自己补的分隔符」与「原文本来就有、或者是唯一一个的空格」，
 * 会把 `5 $` / `50 %` / `a + b` / `Well ...` / `plan — announced` 里的空格一起删掉，
 * 抽出来的文本就不再是页面上写的文本，送翻译、算缓存 key、以后术语表匹配全都跟着偏。
 */
function needsSeparator(previous: string, next: string): boolean {
  if (previous.length === 0 || next.length === 0) return false;
  const last = previous[previous.length - 1];
  const first = next[0];
  if (/\s/.test(last) || /\s/.test(first)) return false;
  // 中日韩之间不加空格；中英之间也不加（宁可贴在一起，也不要凭空多出一个空格）。
  if (CJK_CHAR.test(last) || CJK_CHAR.test(first)) return false;
  // 标点、符号旁边不加空格：`Hello` + `, and italic.` 应该是 `Hello, and italic.`
  if (!WORD_CHAR.test(last) || !WORD_CHAR.test(first)) return false;
  return true;
}

/**
 * 文本片段内部折叠空白，但**不 trim**：片段首尾的空白正是原文的分隔信息，
 * 留给 needsSeparator 判断，段尾统一 normalizeText 时再去掉。
 */
function collapseSpaces(raw: string): string {
  return raw.replace(/\s+/g, ' ');
}

/**
 * 元素**自身和行内后代**的可见文本；块级后代各自成段，这里一概不碰，
 * `<br>` 是硬换行也是段边界，同样不跨。
 * 用文本节点而不是 `innerText`：行为确定、可测，且不依赖布局。
 *
 * 返回空串就是"这个元素没有为本段贡献任何文字"——被跳过的 `<code>` / 可编辑区域、
 * 隐藏元素、块级边界以及插件自己的宿主都是这样。渲染器的「仅译文」模式正是按这条判据
 * 决定哪些节点属于**这一段**（见 `content/renderer.ts` 的 `runNodes`）：多藏一个节点
 * 就可能把兄弟段落连它的译文一起藏掉，所以判据必须与采集端是同一份。
 */
export function inlineText(element: Element, styleOf: StyleLookup): string {
  let result = '';

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const piece = collapseSpaces(node.nodeValue ?? '');
      if (piece === '') return;
      if (needsSeparator(result, piece)) result += ' ';
      result += piece;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (isSkippedForText(child) || isHidden(child, styleOf) || child.nodeName === 'BR') return;
    if (isBlockBoundary(child, styleOf, 0)) return;
    for (const grandChild of Array.from(child.childNodes)) walk(grandChild);
  };

  for (const child of Array.from(element.childNodes)) walk(child);
  // 不 trim：首尾空白留给拼接处判断要不要补分隔符。
  return result;
}

function isSkippable(element: Element): boolean {
  if (SKIP_TAGS.has(element.tagName)) return true;
  // 可编辑区域整棵子树都不采：用户没写完的草稿不上传到外部翻译接口（见 isEditable）。
  if (isEditable(element)) return true;
  if (element.hasAttribute('data-jy-translated')) return true;
  // 插件自己注入的译文宿主，避免二次翻译。
  if (element.closest('[data-jy-root]')) return true;
  return false;
}

/** 同时支持传入 Element（通常是 document.body）与 Document。 */
function rootElements(root: ParentNode): Element[] {
  if (root instanceof Element) return Array.from(root.children);
  return Array.from(root.childNodes).filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE);
}

/**
 * 段落识别的核心规则：一个元素若含有块级边界（见 {@link isBlockBoundary}）就继续下钻，
 * 否则它就是最内层的文本块，整块作为一段。
 * 这样 <p>Hello <b>world</b></p> 是一段，而 <div><p>a</p><p>b</p></div> 是两段。
 *
 * 混合内容是常态而不是特例（CMS 正文、带标签的 <li>、卡片），所以容器自己的直接文本
 * 也必须成段，且按文档顺序与块级子元素交错：
 * `<div>Intro<p>Body</p>Outro</div>` → Intro / Body / Outro 三段。
 * 同一容器的多个直接文本段共享容器锚点（`textRun`），落点由 `anchor` 显式给出。
 *
 * **副作用（调用方必须知道）**：会给成段元素打上 `data-jy-id`，
 * 给**真正产出过段落的最内层文本块**打上 `data-jy-translated`。因此**每次调用都会让上一轮的全部 id 失效**，
 * 调用方不能拿旧 id 去索引新结果，也不能预期 id 跨调用稳定；
 * 这两类标记由渲染器的 `restore()` 统一清除。
 */
export function collectSegments(root: ParentNode, options: ExtractorOptions): ExtractedSegment[] {
  const segments: ExtractedSegment[] = [];
  const styleOf = createStyleLookup();
  const marked = new Set<Element>();

  const markTranslated = (element: Element): void => {
    if (marked.has(element)) return;
    element.setAttribute('data-jy-translated', '1');
    marked.add(element);
  };

  /** 返回是否真的产出了一段：调用方靠它决定要不要把元素标记成「已处理」。 */
  const push = (element: Element, text: string, anchor: SegmentAnchor, textRun: boolean): boolean => {
    if (!isTranslatableText(text)) return false;
    if (options.shouldSkipText?.(text)) return false;
    if (shouldSkip(text, options.targetLang)) return false;

    const id = `jy-${segments.length + 1}-${Math.random().toString(36).slice(2, 8)}`;
    element.setAttribute('data-jy-id', id);
    const segment: ExtractedSegment = {
      id,
      text,
      order: segments.length,
      element: element as HTMLElement,
      anchor,
    };
    if (textRun) segment.textRun = true;
    segments.push(segment);
    return true;
  };

  /**
   * 处理一个元素的直接内容：自己的文本段与块级子元素**按文档顺序交错**处理，
   * 这样 `<div>Intro<p>Body</p>Outro</div>` 出来就是 Intro / Body / Outro 三段。
   * 块级子元素递归交给 visitBlock。
   */
  const visitContent = (
    element: Element,
    hidden: boolean,
    wholeElementEligible: boolean,
    blockBoundaries: ReadonlySet<Element>,
  ): void => {
    interface TextRun {
      /** 这段文本之后的下一个兄弟节点在 `element.childNodes` 里的下标（即本运行的结束位置）。 */
      after: number;
      text: string;
    }
    const runs: TextRun[] = [];
    /** 当前这段文本：{@link appendText} 一次都没跑过时为 undefined。 */
    let run: TextRun | undefined;
    /** 强制下一个文本片段另起一段（`<br>` 这样的硬边界）。 */
    let breakRun = false;
    let hasLineBreak = false;

    /**
     * 这一段文本之后的下一个兄弟节点；走到容器末尾就是 null（追加到末尾）。
     * 跳过插件自己注入的 `[data-jy-root]`：译文宿主不该成为下一段译文的落点参照。
     */
    const anchorNodeAfter = (from: number): Node | null => {
      const nodes = element.childNodes;
      for (let cursor = from; cursor < nodes.length; cursor += 1) {
        const node = nodes[cursor];
        if (node === undefined) continue;
        if (node.nodeType === Node.ELEMENT_NODE && (node as Element).hasAttribute('data-jy-root')) continue;
        return node;
      }
      return null;
    };

    const appendText = (piece: string, after: number): void => {
      if (piece === '') return;
      if (run === undefined || breakRun) {
        // 同一落点的相邻块合成一段（`Hello <b>bold</b> world` 仍是一段）；
        // 落点不同（夹着块级边界）或遇到硬边界就另起一段。
        run = { after, text: '' };
        breakRun = false;
        runs.push(run);
      }
      run.after = after;
      // 分隔符只在拼接处补，而且只在两侧都是词字符时才补。
      run.text = needsSeparator(run.text, piece) ? `${run.text} ${piece}` : `${run.text}${piece}`;
    };

    const emit = (): void => {
      if (hidden) {
        // Fix 3：隐藏子树一个字符都不产出。这里必须兜住**所有** emit 路径，
        // 不能只管段尾那一处——块级边界处的那次 emit 一样会把隐藏容器的直接文本送出去。
        runs.length = 0;
        run = undefined;
        breakRun = false;
        return;
      }
      // 整元素段落：这个元素就是最内层的文本块，而且这一段覆盖了它的全部内容。
      const whole = wholeElementEligible && runs.length === 1 && !hasLineBreak;
      let pushed = false;
      for (const item of runs) {
        // 只折叠空白并去掉段首尾的空格：标记之间该不该有空格，拼接时已经判过了。
        const text = normalizeText(item.text);
        if (text === '') continue;
        if (whole) {
          // 只有「整个元素就是这一段文本」才可以就地替换：多一个块级子元素或 <br> 都不行。
          const replaceable = element.childElementCount === 0;
          pushed = push(element, text, { kind: 'auto' }, !replaceable) || pushed;
        } else {
          // 松散文本段：落点显式给出，否则渲染器只能猜（恒取第一个块级子元素之前），
          // `<div>Intro<p>Body</p>Outro</div>` 的 Outro 译文就会跑到 Body 原文上面去。
          pushed = push(element, text, { kind: 'before', node: anchorNodeAfter(item.after) }, true) || pushed;
        }
      }
      runs.length = 0;
      run = undefined;
      breakRun = false;
      /**
       * Fix 5：只在**真产出过段落**的最内层文本块上标记「已处理」。
       * 遍历过但没产出段落的容器一律不标——标了就会让它的块级子元素在重扫时被整棵短路，
       * 「往容器里追加的新内容」就永远不再翻译（X/Twitter 这类 SPA 的增量翻译会整片失效）。
       */
      if (pushed && wholeElementEligible) markTranslated(element);
    };

    let index = 0;
    for (const child of Array.from(element.childNodes)) {
      index += 1;
      if (child.nodeType === Node.TEXT_NODE) {
        // 折叠空白但不 trim：首尾空白是原文的分隔信息，交给 needsSeparator 判断。
        const text = collapseSpaces(child.nodeValue ?? '');
        if (text === '') continue;
        appendText(text, index);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const childElement = child as Element;
      if (isSkippedForText(childElement)) continue;
      if (childElement.nodeName === 'BR') {
        // 硬换行：不跨段，否则 "1 Main St<br>Springfield" 会被粘成一个非词。
        // `index` 已经越过它，所以上一段的落点就是它本身——译文留在本行末尾。
        hasLineBreak = true;
        breakRun = true;
        run = undefined;
        continue;
      }
      if (blockBoundaries.has(childElement)) {
        // 块级边界（含内部还有块级后代的透明包裹）：先把它前面的文本段落定下来，再递归，保证段序 = 文档序。
        emit();
        if (!hidden) visitBlock(childElement, false);
        run = undefined;
        continue;
      }
      // 隐藏的行内子元素既不并入文本、也不成段：display:none / aria-hidden 里的内容
      // （未发布草稿、折叠面板、A/B 变体）不该被送到用户自己付费的翻译 API。
      if (isHidden(childElement, styleOf)) continue;
      const text = inlineText(childElement, styleOf);
      if (text === '') continue;
      appendText(text, index);
    }

    emit();
  };

  const visitBlock = (element: Element, ancestorHidden: boolean): void => {
    if (isSkippable(element)) return;

    const hidden = ancestorHidden || isHidden(element, styleOf);
    const blocks = Array.from(element.children).filter(
      (child) => !isSkippedForText(child) && isBlockBoundary(child, styleOf, 0),
    );
    const boundaries = new Set(blocks);

    if (blocks.length === 0) {
      // 整块没有任何块级边界 → 这就是最内层的文本块，整块作为一段（块内含 <br> 时按 <br> 切分）。
      if (hidden) return;
      visitContent(element, false, true, boundaries);
      return;
    }

    // 有块级边界：自己的直接文本也要成段，然后逐块下钻。
    // 这个元素本身**不**标记已处理：它的直接文本是松散文本段，标记了会让新追加的子元素在重扫时被整棵短路。
    visitContent(element, hidden, false, boundaries);
  };

  for (const element of rootElements(root)) visitBlock(element, false);
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
import { collectSegments } from '../../src/content/extractor';
import type { ExtractedSegment } from '../../src/content/extractor';

function paragraph(text: string): ExtractedSegment {
  const element = document.createElement('p');
  element.textContent = text;
  document.body.append(element);
  return { id: 'jy-1', text, order: 0, element, anchor: { kind: 'auto' } };
}

function bodyTextOf(host: Element): string {
  return host.shadowRoot?.querySelector('.jy-body')?.textContent ?? '';
}

/**
 * 元素里**可见**的文本。
 *
 * `el.textContent` 分不出可见性——藏起来的原文也在里面（这正是「仅译文」模式的实现方式），
 * 所以自己走一遍：跳过 `display:none` 的子树，译文宿主读它 Shadow DOM 里的正文。
 */
function visibleText(element: Element): string {
  const pieces: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      pieces.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (child.tagName === 'JY-TRANSLATION') {
      pieces.push(bodyTextOf(child));
      return;
    }
    if (child.ownerDocument.defaultView?.getComputedStyle(child).display === 'none') return;
    for (const grandChild of Array.from(child.childNodes)) walk(grandChild);
  };
  for (const child of Array.from(element.childNodes)) walk(child);
  return pieces.join('');
}

/** 元素里那个装着原文的隐藏 span（仅译文模式）。 */
function originalsOf(element: Element): HTMLElement {
  const span = element.querySelector('[data-jy-originals]');
  if (!(span instanceof HTMLElement)) throw new Error('元素里没有藏着原文的 span');
  return span;
}

/** 插件留在页面上的全部标记；还原之后必须一个都不剩。 */
const JY_MARKERS = '[data-jy-id],[data-jy-translated],[data-jy-root],[data-jy-originals],[data-jy-for]';

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
    const segment: ExtractedSegment = {
      id: 'jy-1',
      text: 'Cell text',
      order: 0,
      element: cell,
      anchor: { kind: 'auto' },
    };
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    expect(cell.querySelector('jy-translation')).not.toBeNull();
  });

  it('弹性布局父容器下译文插到段落内部', () => {
    document.body.innerHTML =
      '<div style="display:flex"><p id="p" style="display:block">Flex child text</p></div>';
    const p = document.getElementById('p') as HTMLElement;
    const segment: ExtractedSegment = {
      id: 'jy-1',
      text: 'Flex child text',
      order: 0,
      element: p,
      anchor: { kind: 'auto' },
    };
    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');
    expect(p.querySelector('jy-translation')).not.toBeNull();
  });

  it('列表项的译文插进列表项内部', () => {
    document.body.innerHTML = '<ul><li id="li">Item text</li></ul>';
    const li = document.getElementById('li') as HTMLElement;
    const segment: ExtractedSegment = {
      id: 'jy-1',
      text: 'Item text',
      order: 0,
      element: li,
      anchor: { kind: 'auto' },
    };
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

describe('DomRenderer 仅译文模式', () => {
  it('宿主在元素内部，原文被藏进 display:none 的 span，可见文本只剩译文', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '你好，世界');

    const host = segment.element.querySelector('jy-translation') as Element;
    // 宿主在**元素内部**（双语模式是插在元素旁边的兄弟位置）。
    expect(host).not.toBeNull();
    expect(host.parentElement).toBe(segment.element);
    expect(bodyTextOf(host)).toBe('你好，世界');

    const span = originalsOf(segment.element);
    // display 为 none 且原文节点确实在里面（不是被删掉后重建的副本）。
    expect(span.style.display).toBe('none');
    expect(span.ownerDocument.defaultView?.getComputedStyle(span).display).toBe('none');
    expect(span.textContent).toBe('Hello world');
    expect(span.getAttribute('data-jy-root')).toBe('');

    // `textContent` 分不出可见性——藏起来的原文也在里面、译文反而在 Shadow DOM 里读不到，
    // 所以显式断言"可见的只剩译文"。
    expect(segment.element.textContent).toBe('Hello world');
    expect(visibleText(segment.element)).toBe('你好，世界');
  });

  it('span 在宿主之前，原文按原相对顺序留在里面', () => {
    document.body.innerHTML = '<p id="p">Click <a href="/x">here</a> now</p>';
    const p = document.getElementById('p') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });

    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'done', '点击这里');

    const order = Array.from(p.childNodes).map((node) =>
      node.nodeType === Node.TEXT_NODE ? '#text' : (node as Element).nodeName,
    );
    expect(order).toEqual(['SPAN', 'JY-TRANSLATION']);
    const span = originalsOf(p);
    expect(Array.from(span.childNodes).map((node) => node.nodeType)).toEqual([
      Node.TEXT_NODE,
      Node.ELEMENT_NODE,
      Node.TEXT_NODE,
    ]);
    expect(span.textContent).toBe('Click here now');
  });

  it('pending 也先藏起原文：正文位置不会先显示一段原文再被换成译文', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'pending');

    expect(originalsOf(segment.element).textContent).toBe('Hello world');
    expect(visibleText(segment.element)).toBe('翻译中…');
  });

  it('重复 mount 同一个 id 不会插入第二个宿主或第二个 span', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'pending');
    renderer.mount(segment, 'pending');
    renderer.update(segment.id, '你好，世界');
    expect(segment.element.querySelectorAll('jy-translation')).toHaveLength(1);
    expect(segment.element.querySelectorAll('[data-jy-originals]')).toHaveLength(1);
    expect(visibleText(segment.element)).toBe('你好，世界');
  });

  it('表格单元格 / 列表项 / 弹性布局子元素：宿主都在元素内部，原文都藏在同一个元素里', () => {
    const cases = [
      { html: '<table><tbody><tr><td id="target">Cell text</td></tr></tbody></table>', text: 'Cell text' },
      { html: '<ul><li id="target">Item text</li></ul>', text: 'Item text' },
      {
        html: '<div style="display:flex"><p id="target" style="display:block">Flex child text</p></div>',
        text: 'Flex child text',
      },
    ];

    for (const item of cases) {
      document.body.innerHTML = item.html;
      const element = document.getElementById('target') as HTMLElement;
      // 用真实采集结果：锚点/元素是管线给的，不是手抄的。
      const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
      expect(segment.element, item.html).toBe(element);

      const renderer = new DomRenderer(document, 'translated-only');
      renderer.mount(segment, 'done', '译文');

      const host = element.querySelector('jy-translation') as Element;
      expect(host, item.html).not.toBeNull();
      expect(host.parentElement, item.html).toBe(element);
      expect(originalsOf(element).textContent, item.html).toBe(item.text);
      expect(visibleText(element), item.html).toBe('译文');

      // 外层容器里没有多出任何插件节点：表格行不会混进非单元格节点、
      // 列表项与弹性子元素也不会被挤成"原文 / 译文"两个兄弟。
      const parent = element.parentElement as HTMLElement;
      expect(Array.from(parent.children).map((child) => child.tagName), item.html).toEqual([element.tagName]);
    }
  });

  it('含 <a href> 的段落：链接节点仍在 DOM 里、href 未变（虽然不可见）', () => {
    document.body.innerHTML = '<p id="p">Click <a href="/x">here</a> now</p>';
    const p = document.getElementById('p') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(segment.element).toBe(p);

    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'done', '点击这里');

    const link = p.querySelector('a');
    // 旧的就地替换实现在这里会把 <a> 永久销毁（所以它当年干脆退回双语）；
    // 包起来的做法不重建任何行内标记，链接还在，只是被藏进了 span。
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/x');
    expect(link?.textContent).toBe('here');
    expect(originalsOf(p).contains(link)).toBe(true);
    expect(visibleText(p)).toBe('点击这里');
  });

  it('松散文本段只藏自己那一串：兄弟段落与它们的译文都不受牵连', () => {
    document.body.innerHTML =
      '<div id="box">Intro sentence here<p id="body">Body paragraph text</p>Outro sentence here</div>';
    const box = document.getElementById('box') as HTMLElement;
    const body = document.getElementById('body') as HTMLElement;
    const before = document.body.outerHTML;
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual([
      'Intro sentence here',
      'Body paragraph text',
      'Outro sentence here',
    ]);

    const renderer = new DomRenderer(document, 'translated-only');
    for (const segment of segments) renderer.mount(segment, 'done', `【译】${segment.text}`);

    // 容器里的三处原文各自藏进自己的 span：整块搬走会把 <p> 连它的译文一起藏掉。
    // 直属于容器的只有两处（Body 的那处在 <p> 里面）。
    expect(box.querySelectorAll(':scope > [data-jy-originals]')).toHaveLength(2);
    expect(box.querySelectorAll('[data-jy-originals]')).toHaveLength(3);
    expect(originalsOf(box).textContent).toBe('Intro sentence here');
    expect(originalsOf(body).textContent).toBe('Body paragraph text');
    expect(originalsOf(box).contains(body)).toBe(false);
    expect(visibleText(box)).toBe(
      '【译】Intro sentence here【译】Body paragraph text【译】Outro sentence here',
    );

    renderer.restore();
    expect(document.body.outerHTML).toBe(before);
  });

  it('段落里带 <br> 时按行分段，行内标记与硬换行都不被搬走', () => {
    document.body.innerHTML = '<p id="p">Line one<br>Line two</p>';
    const p = document.getElementById('p') as HTMLElement;
    const before = document.body.outerHTML;
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(segments.map((s) => s.text)).toEqual(['Line one', 'Line two']);

    const renderer = new DomRenderer(document, 'translated-only');
    for (const segment of segments) renderer.mount(segment, 'done', `【译】${segment.text}`);

    const br = p.querySelector('br') as Element;
    // `<br>` 是硬边界，必须留在可见的那一层（被包进 span 就等于把两行并成一行）。
    expect(br.parentElement).toBe(p);
    expect(p.querySelectorAll('[data-jy-originals]')).toHaveLength(2);
    expect(visibleText(p)).toBe('【译】Line one【译】Line two');

    renderer.restore();
    expect(document.body.outerHTML).toBe(before);
  });
});

describe('DomRenderer 仅译文模式：失败态', () => {
  it('失败时显示错误文案与重试按钮，不是静默', () => {
    const segment = paragraph('Hello world');
    const onRetry = vi.fn();
    const renderer = new DomRenderer(document, 'translated-only', onRetry);
    renderer.mount(segment, 'pending');
    renderer.fail(segment.id, '网络错误');

    const host = segment.element.querySelector('jy-translation') as Element;
    expect(bodyTextOf(host)).toContain('网络错误');
    const button = host.shadowRoot?.querySelector('.jy-retry') as HTMLButtonElement;
    expect(button).not.toBeNull();
    // 失败时原文一个字符都没丢（只是藏起来了），点重试仍然有救。
    expect(originalsOf(segment.element).textContent).toBe('Hello world');
    expect(visibleText(segment.element)).toContain('网络错误');

    button.click();
    expect(onRetry).toHaveBeenCalledWith('jy-1');
  });

  it('失败时把原文放回来，重试时再藏起来', () => {
    // 这条守的是一个很容易被忽略的可用性后果：整页失败（没填 Key、断网、限流）时，
    // 如果原文还藏着，页面上就只剩一片红字——用户连想读的原文都看不见，得先按 Alt+T。
    // 那比"遮挡"更糟：遮挡只是多了一倍文字，这个是把内容整个拿走了。
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'pending');

    const span = originalsOf(segment.element);
    expect(span.style.display).toBe('none'); // 进行中：原文藏着，让位给"翻译中…"

    renderer.fail(segment.id, '网络错误');
    expect(span.style.display).not.toBe('none'); // 失败：原文必须看得见
    expect(visibleText(segment.element)).toContain('Hello world');
    expect(visibleText(segment.element)).toContain('网络错误');

    // 用户点重试 → 重新进入进行中，原文再藏起来。
    renderer.mount(segment, 'pending');
    expect(span.style.display).toBe('none');

    // 重试成功 → 保持藏着，显示译文。
    renderer.update(segment.id, '你好世界');
    expect(span.style.display).toBe('none');
    expect(visibleText(segment.element)).toBe('你好世界');
  });

  it('不可重试的失败只给原因，不挂按钮', () => {
    const segment = paragraph('Hello world');
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'pending');
    renderer.fail(segment.id, '缺少 API Key', false);

    const host = segment.element.querySelector('jy-translation') as Element;
    expect(bodyTextOf(host)).toContain('缺少 API Key');
    expect(host.shadowRoot?.querySelector('.jy-retry')).toBeNull();
  });

  it('失败之后还原：原文照原样回来', () => {
    document.body.innerHTML = '<p id="p">Click <a href="/x">here</a> now</p>';
    const before = document.body.outerHTML;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'pending');
    renderer.fail(segment.id, '网络错误');

    renderer.restore();
    expect(document.body.outerHTML).toBe(before);
  });
});

describe('DomRenderer 仅译文模式：还原逐字节', () => {
  const RICH_HTML = [
    '<article>',
    '<h1>Hello world</h1>',
    '<p>Click <a href="/x">here</a> now</p>',
    '<p>An image <img src="a.png" alt="pic"> inside</p>',
    '<div id="box">Intro sentence<p id="body">Nested body text</p>Outro sentence</div>',
    '<table><tbody><tr><td>Cell text</td><td>Second cell</td></tr></tbody></table>',
    '<ul><li>Item text</li><li>Another item</li></ul>',
    '<div style="display:flex"><p style="display:block">Flex child text</p></div>',
    '<p>Line one<br>Line two</p>',
    '</article>',
  ].join('');

  it('还原后 body.outerHTML 与翻译前完全相同，且没有 data-jy-* 残留', () => {
    document.body.innerHTML = RICH_HTML;
    const before = document.body.outerHTML;

    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(segments.length).toBeGreaterThan(6);
    const renderer = new DomRenderer(document, 'translated-only');
    // 译文刻意不含原文，否则"看不见原文"这条断言会被译文里的原文自己骗过去。
    for (const segment of segments) renderer.mount(segment, 'done', `MOCK-${segment.order}`);

    // 翻译态下正文里不应该还有可见的英文原文（藏起来的不算）。
    expect(visibleText(document.body)).not.toContain('Hello world');
    expect(visibleText(document.body)).not.toContain('Cell text');
    expect(visibleText(document.body)).toContain('MOCK-0');
    expect(visibleText(document.body)).toContain(`MOCK-${segments.length - 1}`);

    renderer.restore();

    // 逐字节：行内标记、图片、嵌套结构、文本节点边界全部回到原样。
    expect(document.body.outerHTML).toBe(before);
    expect(document.querySelectorAll(JY_MARKERS)).toHaveLength(0);
  });

  it('还原之后重新采集得到同样的段落（标记不残留、原文没被销毁）', () => {
    document.body.innerHTML = RICH_HTML;
    const renderer = new DomRenderer(document, 'translated-only');

    const first = collectSegments(document.body, { targetLang: 'zh-Hans' });
    for (const segment of first) renderer.mount(segment, 'done', `【译】${segment.text}`);
    renderer.restore();

    const second = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(second.map((s) => s.text)).toEqual(first.map((s) => s.text));
    expect(document.querySelectorAll('jy-translation')).toHaveLength(0);
    expect(document.querySelectorAll('[data-jy-originals]')).toHaveLength(0);
  });
});

describe('DomRenderer 还原的边界', () => {
  it('元素被框架移出文档之后，restore 仍把原文搬回去', () => {
    document.body.innerHTML = '<div id="box"><p id="p">Original english text</p></div>';
    const p = document.getElementById('p') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'done', '替换后的译文');
    expect(visibleText(p)).toBe('替换后的译文');

    // 框架把节点摘下来（脱离文档，但引用还在手里）：缓存的 span 仍然是它的子节点。
    p.remove();
    expect(p.isConnected).toBe(false);

    renderer.restore();

    expect(p.textContent).toBe('Original english text');
    expect(p.hasAttribute('data-jy-translated')).toBe(false);
    expect(p.querySelectorAll(JY_MARKERS)).toHaveLength(0);
  });

  it('页面在翻译之后换掉节点，restore 把原文搬进活着的那个', () => {
    document.body.innerHTML = '<div id="box"><p id="p">Original english text</p></div>';
    const box = document.getElementById('box') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'translated-only');
    renderer.mount(segment, 'done', '替换后的译文');

    // 框架重渲染：新节点继承了旧节点上的插件标记，旧节点被丢掉。
    const replacement = document.createElement('p');
    replacement.setAttribute('data-jy-id', segment.id);
    replacement.setAttribute('data-jy-translated', '1');
    replacement.textContent = '框架重新渲染出来的文本';
    box.replaceChildren(replacement);

    renderer.restore();

    // 原文没有丢——它就在隐藏 span 里，整块搬进活着的那一个（与双语模式写回快照等价）。
    expect(replacement.textContent).toBe('Original english text');
    expect(replacement.hasAttribute('data-jy-translated')).toBe(false);
    expect(replacement.hasAttribute('data-jy-id')).toBe(false);
  });

  it('还原后重新采集仍是同样三段（标记不残留）', () => {
    document.body.innerHTML = '<div id="box">Intro sentence here<p>Body paragraph text</p>Outro sentence here</div>';
    const box = document.getElementById('box') as HTMLElement;
    const renderer = new DomRenderer(document, 'bilingual');

    const first = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(first.map((s) => s.text)).toEqual([
      'Intro sentence here',
      'Body paragraph text',
      'Outro sentence here',
    ]);
    for (const segment of first) renderer.mount(segment, 'pending');
    renderer.restore();

    const second = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(second.map((s) => s.text)).toEqual(first.map((s) => s.text));
    expect(box.querySelectorAll('jy-translation')).toHaveLength(0);
  });
});

describe('DomRenderer 文本段（混合内容里的直接文本）', () => {
  it('锚点是容器时插进容器内部、在下一个块级子元素之前', () => {
    document.body.innerHTML = '<div id="box">Intro sentence here<p id="body">Body paragraph text</p></div>';
    const box = document.getElementById('box') as HTMLElement;
    // 用真实抽取结果：锚点是容器本身，落点显式指向紧随其后的块级子元素。
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(segment.textRun).toBe(true);
    expect(segment.element).toBe(box);
    expect(segment.anchor).toEqual({ kind: 'before', node: document.getElementById('body') });

    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');

    const host = document.querySelector('jy-translation') as Element;
    expect(host.parentElement).toBe(box);
    expect(host.nextElementSibling).toBe(document.getElementById('body'));
  });

  it('段落中段的松散文本插到它后面那个兄弟节点之前', () => {
    document.body.innerHTML =
      '<div id="box"><p id="first">Block one text</p>stray text here<p id="second">Block two text</p></div>';
    const box = document.getElementById('box') as HTMLElement;
    const second = document.getElementById('second') as HTMLElement;
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const stray = segments.find((item) => item.text.includes('stray'));
    expect(stray?.textRun).toBe(true);
    // 落点在容器上，位置由 anchor 显式给出（旧实现把后一个块级子元素本身当锚点）。
    expect(stray?.element).toBe(box);
    expect(stray?.anchor).toEqual({ kind: 'before', node: second });

    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(stray as ExtractedSegment, 'pending');

    const host = document.querySelector('jy-translation') as Element;
    expect(host.parentElement).toBe(box);
    expect(host.nextElementSibling).toBe(second);
    expect(host.previousElementSibling).toBe(document.getElementById('first'));
  });

  it('容器里的文本段插在容器内部，不跑到容器外面去', () => {
    document.body.innerHTML = '<div id="outer"><div id="box">Intro sentence here<p id="body">Body paragraph text</p></div></div>';
    const outer = document.getElementById('outer') as HTMLElement;
    const box = document.getElementById('box') as HTMLElement;
    const [segment] = collectSegments(document.body, { targetLang: 'zh-Hans' });

    const renderer = new DomRenderer(document, 'bilingual');
    renderer.mount(segment, 'pending');

    const host = document.querySelector('jy-translation') as Element;
    expect(host.parentElement).toBe(box);
    expect(outer.querySelectorAll(':scope > jy-translation')).toHaveLength(0);
  });

  it('松散文本段的译文宿主按原文顺序与节点交替出现', () => {
    document.body.innerHTML =
      '<div id="box">Intro sentence here<p id="body">Body paragraph text</p>Outro sentence here</div>';
    const box = document.getElementById('box') as HTMLElement;
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'bilingual');
    for (const segment of segments) renderer.mount(segment, 'done', `【译】${segment.text}`);

    const order = Array.from(box.childNodes).map((node) => {
      if (node.nodeType === Node.TEXT_NODE) return `原文:${(node.nodeValue ?? '').trim()}`;
      const element = node as Element;
      if (element.tagName === 'JY-TRANSLATION') {
        return `译文:${element.shadowRoot?.querySelector('.jy-body')?.textContent ?? ''}`;
      }
      return `块:${element.nodeName}#${element.id}`;
    });

    // 旧实现的顺序是「Intro 原文 / Intro 译 / Outro 译 / Body 原文 / Body 译 / Outro 原文」，
    // 用户会把 Outro 的译文当成 Body 的译文。
    expect(order).toEqual([
      '原文:Intro sentence here',
      '译文:【译】Intro sentence here',
      '块:P#body',
      '译文:【译】Body paragraph text',
      '原文:Outro sentence here',
      '译文:【译】Outro sentence here',
    ]);
  });

  it('重扫：已翻译的整元素段落不重复产出，松散文本段会被再次采集', () => {
    document.body.innerHTML = '<div id="box">Intro sentence here<p id="body">Body paragraph text</p></div>';
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'bilingual');
    for (const segment of segments) renderer.mount(segment, 'pending');

    expect(document.querySelectorAll('jy-translation')).toHaveLength(2);

    // 松散文本段**有意**不标记它所在的容器（标了会让容器里新追加的子元素在重扫时被整棵短路），
    // 所以它会被再次采集：这一段防重由调用方（编排层）负责，代价比「新内容永远不翻」小得多。
    const again = collectSegments(document.body, { targetLang: 'zh-Hans' });
    expect(again.map((s) => s.text)).toEqual(['Intro sentence here']);
    // 落点跳过插件自己注入的 [data-jy-root]：参照的是它后面那个块级子元素。
    expect(again[0].anchor).toEqual({ kind: 'before', node: document.getElementById('body') });
    // 已经翻译过的段落不会再被产出。
    expect(again.some((s) => s.text === 'Body paragraph text')).toBe(false);
  });

  it('restore 后原文一字不差，标记清空', () => {
    document.body.innerHTML = '<div id="box">Intro sentence here<p id="body">Body paragraph text</p></div>';
    const before = document.body.innerHTML;
    const segments = collectSegments(document.body, { targetLang: 'zh-Hans' });
    const renderer = new DomRenderer(document, 'bilingual');
    for (const segment of segments) renderer.mount(segment, 'pending');
    renderer.restore();

    expect(document.body.innerHTML).toBe(before);
    expect(document.querySelector('[data-jy-id]')).toBeNull();
    expect(document.querySelector('[data-jy-translated]')).toBeNull();
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
import { createStyleLookup, inlineText, isBlockDisplay } from './extractor';
import type { DisplayMode } from '../shared/settings';
import { TRANSLATION_CSS } from './styles';

export type { DisplayMode };

export type RenderState = 'pending' | 'done' | 'error';

const HOST_TAG = 'jy-translation';
const PENDING_TEXT = '翻译中…';

/**
 * 仅译文模式下装原文的容器。
 *
 * `style="display:none"` 是**内联**样式：页面 CSS 里一条 `.jy-originals { display:block }`
 * 就能把「只显示译文」破掉，内联样式不依赖页面上有没有我们的样式表，也不给别人改写的机会。
 * `data-jy-root` 让采集端把整棵子树当成插件自己的节点跳过。
 */
const ORIGINALS_TAG = 'span';
const ORIGINALS_ATTR = 'data-jy-originals';

interface InsertionTarget {
  parent: HTMLElement;
  /** 插到 parent 内部（末尾，或 before 指定的子节点之前）；否则插到 parent 里 before 那个位置。 */
  inside: boolean;
  before: Node | null;
}

/** 仅译文模式下被藏起来的一段原文：节点都还在，只是被移进了这个 span。 */
interface HiddenOriginals {
  element: HTMLElement;
  span: HTMLElement;
  /**
   * 整元素段落（`anchor.kind === 'auto'`）：元素里装的就是这一段，全部子节点都在 span 里。
   * 元素被框架整体换掉时可以把原文搬进新元素（松散文本段不行——它的父元素是容器，
   * 里面还有别的段落，整块替换会把兄弟段落删掉）。
   */
  wholeElement: boolean;
}

/** 容器里第一个块级后代（`display:contents` 这类不算块级，继续往里找）。 */
function firstBlockInside(element: Element, styleOf: (element: Element) => string): Element | undefined {
  for (const child of Array.from(element.children)) {
    if (isBlockDisplay(styleOf(child))) return child;
    const nested = firstBlockInside(child, styleOf);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * 决定译文宿主插到哪里。只用于**双语模式** `anchor.kind === 'auto'` 的段落——
 * 松散文本段落带显式落点，由 ensureHost 直接按 `anchor.node` 插入，不走这里。
 *
 * 表格单元格、列表项、以及弹性/网格布局的子元素都必须插到内部——
 * 否则会在 <tr> 里插入非单元格节点破坏表格，或在 flex 行里被挤成一行。
 *
 * `textRun` 的段落必须留在锚点内部：它的锚点是「装着好几块内容的容器」，
 * 插到容器外面会让译文和它对应的那段原文被别的块级子元素隔开。
 * 例外是锚点本身就是紧随其后的那个块级子元素（`prepend`）；采集端在 Fix 4 之后
 * 不再产出 `prepend`（落点由 `anchor` 显式给出），这个分支只为兼容旧调用方保留。
 */
export function resolveInsertion(element: HTMLElement, segment?: ExtractedSegment): InsertionTarget {
  const parent = element.parentElement;
  if (segment?.textRun === true) {
    const isCell = element.tagName === 'TD' || element.tagName === 'TH' || element.tagName === 'LI';
    if (segment.prepend === true && parent !== null && !isCell) {
      return { parent, inside: false, before: element };
    }
    // 锚点是容器本身：留在容器内部，插到下一个块级子元素之前（没有就补在末尾），保证与原文同序。
    const view = element.ownerDocument.defaultView;
    const styleOf = (target: Element): string => view?.getComputedStyle(target).display ?? '';
    const anchor = firstBlockInside(element, styleOf);
    return { parent: element, inside: true, before: anchor?.parentElement === element ? anchor : null };
  }
  if (element.tagName === 'TD' || element.tagName === 'TH' || element.tagName === 'LI') {
    return { parent: element, inside: true, before: null };
  }
  if (parent === null) return { parent: element, inside: true, before: null };
  const view = element.ownerDocument.defaultView;
  const display = view?.getComputedStyle(parent).display;
  if (display === 'flex' || display === 'inline-flex' || display === 'grid' || display === 'inline-grid') {
    return { parent: element, inside: true, before: null };
  }
  return { parent, inside: false, before: element.nextSibling };
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class DomRenderer {
  private readonly hosts = new Map<string, HTMLElement>();
  /**
   * 仅译文模式下被藏起来的原文 → 装载它的 span。
   *
   * 用 `Map` 而不是 `WeakMap`：`restore()` 必须能**遍历**全部条目（双语模式不需要它——
   * 那边的原文一直可见，压根没有要还原的东西）。
   */
  private readonly hiddenOriginals = new Map<string, HiddenOriginals>();

  constructor(
    private readonly document: Document,
    private readonly mode: DisplayMode,
    private readonly onRetry?: (segmentId: string) => void,
  ) {}

  mount(segment: ExtractedSegment, state: RenderState, text?: string): void {
    if (this.mode === 'translated-only') {
      this.mountTranslatedOnly(segment, state, text);
      return;
    }
    this.setContent(this.ensureHost(segment), state, text);
  }

  update(segmentId: string, text: string): void {
    const host = this.hosts.get(segmentId);
    if (!host) return;
    // 重试成功：原文重新藏起来，让位给译文（失败时曾被放回来，见 fail）。
    this.setOriginalsHidden(segmentId, true);
    this.setContent(host, 'done', text);
  }

  /**
   * `canRetry === false` 用于**重试多少次都是同一个结果**的错误（缺 API Key、Key 无效）：
   * 只标注原因、不挂重试按钮。一个 200 段的页面否则会变成 200 个点了也没用的按钮，
   * 而用户真正该做的是去设置页填 Key（规格 §8：不重试，改为页面 toast + 弹窗红点）。
   *
   * 两种模式的失败都落在宿主上，所以**失败一定看得见**：仅译文模式下原文已经藏进
   * `display:none` 的 span，宿主就是这一页上唯一还能写字的地方（旧的就地替换实现在这里
   * 直接 `return`，用户既看不到原文、也看不到失败，还不能重试）。
   */
  fail(segmentId: string, message: string, canRetry = true): void {
    const host = this.hosts.get(segmentId);
    if (!host) return;
    // **失败时把原文放回来。** 仅译文模式下原文本来是藏着的，一旦整页失败（没填 Key、
    // 断网、限流），页面上就只剩一片红字——用户连想读的原文都看不见，得先按 Alt+T 才能读。
    // 那比"遮挡"更糟：遮挡只是多了一倍文字，这个是把内容整个拿走了。
    // 重试成功时 update() 会重新藏起来。
    this.setOriginalsHidden(segmentId, false);
    this.setContent(host, 'error', message, canRetry);
  }

  /** 仅译文模式下原文的显隐。双语模式没有这条记录，调用是空操作。 */
  private setOriginalsHidden(segmentId: string, hidden: boolean): void {
    const record = this.hiddenOriginals.get(segmentId);
    if (record === undefined) return;
    record.span.style.display = hidden ? 'none' : '';
  }

  /**
   * 仅译文模式：把原文**包起来藏掉**，而不是删掉它。
   *
   * 三步（见 `hideOriginals`）：
   * 1. 新建 `<span data-jy-originals data-jy-root style="display:none">`；
   * 2. 把这一段的原文节点**按原相对顺序**搬进去（是搬移不是克隆：还原就是把它们搬回去）；
   * 3. 把 span 与 `<jy-translation>` 译文宿主放进元素内部，宿主在 span 之后。
   *
   * 于是元素里**可见的只有译文**，而原文节点一个都没销毁。为什么是包起来而不是替换掉：
   * - 行内标记（链接、图片、加粗）全留在 DOM 里，还原时不需要重建任何东西；
   * - 对任何元素都成立——表格单元格、列表项、弹性/网格布局的子元素都只需要往元素**内部**
   *   追加，不必像双语模式那样分情况判断该插到兄弟位置还是内部；
   * - 原文一个字符都没丢，所以失败态、还原、切回双语这三种回退都还有东西可用。
   */
  private mountTranslatedOnly(segment: ExtractedSegment, state: RenderState, text?: string): void {
    const existing = this.hosts.get(segment.id);
    if (existing !== undefined) {
      // 重新进入"进行中"（用户点了重试）时把原文重新藏起来。
      this.setOriginalsHidden(segment.id, true);
      this.setContent(existing, state, text);
      return;
    }

    const host = this.createHost(segment.id);
    this.hideOriginals(segment, host);

    // 标记原文已翻译：即使后续被重复采集，extractor 也会跳过它（与双语模式同一条规则）。
    // 松散文本段（`textRun`）的 element 是**容器**，绝不能标记：
    // 整棵子树被短路之后，容器里新追加的内容就再也不会被采集了（见 extractor 的 Fix 5 取舍）。
    if (segment.textRun !== true) segment.element.setAttribute('data-jy-translated', '1');
    this.hosts.set(segment.id, host);
    this.setContent(host, state, text);
  }

  /**
   * 把这一段的原文节点搬进隐藏 span，并把 span 与宿主放进元素里。
   *
   * 两种段落形态的搬法不同，区别在于**这个元素是不是这一段的专属容器**：
   * - 整元素段落（`anchor.kind === 'auto'`）：元素里装的就是这一段，全部子节点都搬走，
   *   span 落在原来第一个子节点的位置（子节点全搬空后就是"元素末尾"）；
   * - 松散文本段（`anchor.kind === 'before'`）：元素是**容器**，里面还有别的块级子元素各自成段
   *   （`<div>Intro<p>Body</p>Outro</div>`），整块搬走会把兄弟段落连同它们自己的译文一起藏掉。
   *   只搬本段真正贡献了文字的那一串节点（见 `runNodes`），span 留在本段原来的位置。
   *
   * 宿主两种形态都放在 span 之后：整元素段落是追加到元素末尾（规格就是这三步），
   * 松散文本段则仍按 `anchor` 给出的落点插入——那正是"紧跟这段原文"的位置。
   */
  private hideOriginals(segment: ExtractedSegment, host: HTMLElement): void {
    const element = segment.element;
    const anchor = segment.anchor;
    const wholeElement = anchor.kind === 'auto';
    const nodes: Node[] = wholeElement ? Array.from(element.childNodes) : this.runNodes(element, anchor.node);

    if (nodes.length > 0) {
      const span = this.createOriginals();
      const first = nodes[0];
      // span 站在第一个原文节点原来的位置上，还原时把子节点搬回"span 之前"就回到原位。
      if (first !== undefined && first.parentNode === element) element.insertBefore(span, first);
      else element.append(span);
      span.append(...nodes);
      this.hiddenOriginals.set(segment.id, { element, span, wholeElement });
    }

    if (wholeElement) element.append(host);
    else this.insertHostAtAnchor(segment, host);
  }

  /**
   * 松散文本段（`anchor.kind === 'before'`）自己那一串原文节点。
   *
   * 从锚点（本段之后的下一个节点）往前收，**只收采集端算进这一段的节点**：判据直接复用
   * 采集端的 `inlineText` —— 它对这个子元素返回空串就说明这个子元素没有为本段贡献任何文字
   * （被跳过的 `<code>` / 可编辑区域、隐藏元素、块级边界都是这样），到它就停。
   *
   * 这条判据同时挡住了最危险的一种错误：**把兄弟段落连它的译文一起藏掉**。凡是成段的元素
   * 都是块级边界（或内部含块级后代的透明包裹），`inlineText` 对它恒为空串。
   * 停早了只是这一小段仍显示原文（还能忍），停晚了就是整块内容凭空消失。
   */
  private runNodes(element: HTMLElement, anchorNode: Node | null): Node[] {
    const nodes: Node[] = Array.from(element.childNodes);
    const end =
      anchorNode !== null && anchorNode.parentNode === element ? nodes.indexOf(anchorNode) : nodes.length;
    if (end <= 0) return [];

    const styleOf = createStyleLookup();
    let start = end;
    while (start > 0) {
      const node = nodes[start - 1];
      if (node === undefined) break;
      if (node.nodeType === Node.TEXT_NODE) {
        start -= 1;
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) break;
      const child = node as Element;
      // `<br>` 是硬换行也是段边界；插件自己的 span/宿主一律不碰。
      if (child.nodeName === 'BR' || child.hasAttribute('data-jy-root')) break;
      if (inlineText(child, styleOf) === '') break;
      start -= 1;
    }
    return nodes.slice(start, end);
  }

  /**
   * 松散文本段的宿主落点：容器内部、`anchor.node` 之前；node 为 null（或已不在容器里）
   * 就追加到末尾。与双语模式 `ensureHost` 里那一段同一条规则。
   */
  private insertHostAtAnchor(segment: ExtractedSegment, host: HTMLElement): void {
    const element = segment.element;
    const node = segment.anchor.kind === 'before' ? segment.anchor.node : null;
    if (node !== null && node.parentNode === element) element.insertBefore(host, node);
    else element.append(host);
  }

  /** 装原文的 span：内联 `display:none`，见 {@link ORIGINALS_ATTR} 的注释。 */
  private createOriginals(): HTMLElement {
    const span = this.document.createElement(ORIGINALS_TAG);
    span.setAttribute(ORIGINALS_ATTR, '');
    span.setAttribute('data-jy-root', '');
    span.style.display = 'none';
    return span;
  }

  private ensureHost(segment: ExtractedSegment): HTMLElement {
    const existing = this.hosts.get(segment.id);
    if (existing) return existing;

    const host = this.createHost(segment.id);
    if (segment.anchor.kind === 'before') {
      // 松散文本段落：落点由采集端显式给出——容器内部、anchor.node 之前；node 为 null 就追加到末尾。
      // 容器里可能同时有好几段松散文本，只有显式落点才能保证译文与原文同序。
      const parent = segment.element;
      const before =
        segment.anchor.node !== null && segment.anchor.node.parentNode === parent ? segment.anchor.node : null;
      if (before !== null) parent.insertBefore(host, before);
      else parent.append(host);
    } else {
      // 整元素段落：按布局规则决定插到元素之后还是元素内部。
      const target = resolveInsertion(segment.element, segment);
      // 锚点必须真的还在算出来的父节点里，否则退回追加，别把节点插丢。
      const anchor = target.before !== null && target.before.parentNode === target.parent ? target.before : null;
      if (anchor !== null) target.parent.insertBefore(host, anchor);
      else target.parent.append(host);
    }

    // 标记原文已翻译：即使后续被重复采集，extractor 也会跳过它。
    // 松散文本段（`textRun`）的 element 是**容器**，绝不能标记：
    // 整棵子树被短路之后，容器里新追加的内容就再也不会被采集了（见 extractor 的 Fix 5 取舍）。
    if (segment.textRun !== true) segment.element.setAttribute('data-jy-translated', '1');
    this.hosts.set(segment.id, host);
    return host;
  }

  private createHost(segmentId: string): HTMLElement {
    const host = this.document.createElement(HOST_TAG);
    host.setAttribute('data-jy-root', '');
    host.setAttribute('data-jy-for', segmentId);

    const shadow = host.attachShadow({ mode: 'open' });
    const style = this.document.createElement('style');
    style.textContent = TRANSLATION_CSS;
    const body = this.document.createElement('span');
    body.className = 'jy-body';
    shadow.append(style, body);
    return host;
  }

  /** 一律用 textContent 写入，杜绝引擎返回内容被当成 HTML 执行。 */
  private setContent(host: HTMLElement, state: RenderState, text?: string, canRetry = true): void {
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
      if (!canRetry) return;
      const button = this.document.createElement('button');
      button.className = 'jy-retry';
      button.type = 'button';
      button.textContent = '重试';
      button.addEventListener('click', () => {
        // 回调当场从宿主属性读 id，而不是捕获创建时的闭包变量：
        // 同一个宿主反复失败时，「重试的是哪一段」永远以当前 DOM 为准。
        const current = host.getAttribute('data-jy-for');
        if (current) this.onRetry?.(current);
      });
      body.append(button);
      return;
    }
    body.textContent = text ?? '';
  }

  /**
   * 还原：**逐字节**回到翻译前的样子。
   *
   * 双语模式只要把宿主摘掉就算完；仅译文模式还要把藏起来的原文搬回原位——
   * 搬回去的是**同一批节点**（不是重建的副本），所以行内标记、属性、文本节点边界
   * 全都原样回来，`outerHTML` 与翻译前逐字节相同。
   */
  restore(): void {
    for (const host of this.hosts.values()) host.remove();
    this.hosts.clear();

    for (const { element, span, wholeElement } of this.hiddenOriginals.values()) {
      // 页面在翻译之后重建过节点时，缓存的引用指向的是脱离文档的孤儿：
      // 往孤儿里写原文等于什么也没还原，活着的节点会一直显示译文。
      const live = this.resolveLive(element) ?? element;
      // span 还挂在这个元素里（含"元素被整体移出文档"——那时它的父节点仍然是它）
      // 就直接拆；元素被框架**换掉**时按兜底那一条处理。
      const target = span.parentNode === live ? span : live.querySelector(`[${ORIGINALS_ATTR}]`);
      if (target instanceof HTMLElement) {
        this.unwrapOriginals(target);
      } else if (wholeElement && live !== element && span.childNodes.length > 0) {
        // 元素被框架整体换掉了：原文并没有丢——它就在 span 里。整元素段落的 span 装的就是
        // 这个元素的全部内容，所以可以整块搬进活着的那一个（与双语模式把快照写回活节点等价）。
        // 松散文本段不能这么干：它的父元素是容器，整块替换会把兄弟段落删掉。那种情况下
        // 只能清掉标记（原文留在已脱离文档的 span 里，不再可恢复）。
        live.replaceChildren(...Array.from(span.childNodes));
        span.remove();
      }
      element.removeAttribute('data-jy-translated');
      if (live !== element) live.removeAttribute('data-jy-translated');
    }
    this.hiddenOriginals.clear();

    // 剩下的标记全部清掉：插件没留下的痕迹才算还原干净。
    // 这一步也负责把「框架重建过、带着旧标记的新节点」解锁，否则那些节点会被永久跳过。
    for (const element of Array.from(this.document.querySelectorAll('[data-jy-id], [data-jy-translated]'))) {
      element.removeAttribute('data-jy-id');
      element.removeAttribute('data-jy-translated');
    }
  }

  /** 把隐藏 span 的子节点按原顺序搬回它原来的位置（span 之前），然后删掉 span。 */
  private unwrapOriginals(span: HTMLElement): void {
    const parent = span.parentNode;
    if (parent === null) return;
    for (const node of Array.from(span.childNodes)) parent.insertBefore(node, span);
    span.remove();
  }

  /**
   * 页面在翻译之后重建过节点时，缓存的引用指向的是脱离文档的孤儿：
   * 往孤儿里写原文等于什么也没还原，活着的节点会一直显示译文。
   * 所以先确认节点还在文档里，不在就按 data-jy-id / data-jy-for 重新找。
   */
  private resolveLive(element: HTMLElement): HTMLElement | undefined {
    if (element.isConnected) return element;
    for (const attribute of ['data-jy-id', 'data-jy-for']) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      const found = this.document.querySelector(`[${attribute}="${escapeAttributeValue(value)}"]`);
      if (found instanceof HTMLElement) return found;
    }
    return undefined;
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
  // 一律用 textContent：错误信息里可能带引擎返回的原文片段，绝不能被当成 HTML 解析。
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
import { RETRYABLE_CODES } from '../engines/types';
import { MSG, type PageState, type TranslateItemResult, type TranslateTextsResponse } from '../shared/messages';
import { DEFAULT_SETTINGS, loadUiSettings, type DisplayMode, type UiSettings } from '../shared/settings';
import { collectSegments, type ExtractedSegment } from './extractor';
import { DomRenderer } from './renderer';
import { toast } from './toast';

/**
 * 每一轮翻译的世代号：`translatePage` 认领一次就自增，`restorePage` 也自增。
 *
 * 它给"一轮"一个身份，解决两件靠 `running` 一个布尔量表达不了的事：
 *
 * - **还原必须立刻放行下一次翻译**。还原把 renderer 置空了，但上一轮可能还在飞；
 *   如果 running 一直卡到那一轮跑完，用户"还原 → 再翻译"（Alt+T 连按两下就是这条路径）
 *   期间的所有请求都会被入口守卫悄悄吞掉——监听器照常回响应，页面什么都不做。
 * - **旧的一轮不能回来干扰新的一轮**。被接管的那一轮在 await 返回后要安静退出：
 *   不写状态（renderer / lastError 属于新的一轮）、也不能在 finally 里把新的一轮的
 *   running 守卫清掉（否则新的一轮在飞时又放进来第三个 renderer）。
 */
let generation = 0;
let renderer: DomRenderer | null = null;
let segments: ExtractedSegment[] = [];
let running = false;
/** 本轮翻译攒下的页面级提示：整轮跑完只弹一次，见 `translatePage` 末尾。 */
let lastError: string | null = null;
let displayMode: DisplayMode = DEFAULT_SETTINGS.displayMode;
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

/**
 * 内容脚本 → 后台单次请求的超时。
 *
 * MV3 的 service worker 空闲约 30 秒就会被浏览器回收。翻译中途被回收时
 * `chrome.runtime.sendMessage` 的 promise **可能永不兑现**：端口既不关闭也不报错，
 * 于是这一批永远停在「翻译中…」——`runPool` 永不 settle、`running` 永不释放，
 * 页面卡死且连重试按钮都出不来（规格 §8：绝不静默失败）。
 *
 * 取 60 秒：默认批次（12 段 / 1000 字符）正常几秒内就回来；这个上限要容得下调度器
 * 一次退避重试（500ms + 1500ms）与慢接口的往返，又不至于让用户对着一个死页面干等。
 * 超时归这一层——调度器自身不设超时（见 `background/scheduler.ts` 的 `callEngine`）。
 */
const BACKGROUND_TIMEOUT_MS = 60_000;

/**
 * 后台在超时预算内一次都没响应。文案自带完整语义，所以不再套「无法连接后台」的壳：
 * 用户看到的应该是「后台没响应」，而不是一句会被理解成"网络不通"的通用错误。
 */
class BackgroundTimeoutError extends Error {
  constructor() {
    super(
      `后台 ${Math.round(BACKGROUND_TIMEOUT_MS / 1000)} 秒没有响应（翻译服务可能已被浏览器回收），请重试`,
    );
    this.name = 'BackgroundTimeoutError';
  }
}

/**
 * 发一条消息给后台，**最多等 `BACKGROUND_TIMEOUT_MS`**。
 *
 * 超时与消息本身的成败都收敛成同一个 promise 的两种结局，调用方（批任务 / 单条重试）
 * 原有的 try/catch 照旧兜住——失败走已有的 `failBatch` 路径进失败态并可重试，
 * 不会让整个 `runPool` 挂起。
 *
 * 定时器在两种收尾里都会清掉：内容脚本活在页面进程里，一个永不清除的定时器会被页面
 * 一直持有（页面上有几百个批次时就是几百个悬挂的定时器）。
 */
function sendToBackground(message: unknown): Promise<TranslateTextsResponse> {
  return new Promise<TranslateTextsResponse>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BackgroundTimeoutError()), BACKGROUND_TIMEOUT_MS);
    const settle = (run: () => void): void => {
      clearTimeout(timer);
      run();
    };
    try {
      (chrome.runtime.sendMessage(message) as Promise<TranslateTextsResponse>).then(
        (response) => settle(() => resolve(response)),
        (error: unknown) => settle(() => reject(error)),
      );
    } catch (raw) {
      // `sendMessage` 自己抛（极端情况下扩展上下文已失效）：与异步失败同一条路。
      settle(() => reject(raw));
    }
  });
}

/** 传输层失败的条目文案：超时自带完整语义，其余套「无法连接后台」的壳。 */
function describeTransportError(raw: unknown): string {
  if (raw instanceof BackgroundTimeoutError) return raw.message;
  return `无法连接后台：${raw instanceof Error ? raw.message : String(raw)}`;
}

/** 页面级失败的文案（`ok: false`：设置读不出来这类"连请求都没发出去"的错）。 */
function describeError(response: { code: string; message: string }): string {
  if (response.code === 'AUTH') return response.message;
  if (response.code === 'RATE_LIMIT') return '免费接口限流，请稍后重试或改用自定义 API';
  return `翻译失败：${response.message}`;
}

/**
 * 条目级失败要不要挂重试按钮，判据是 `engines/types.ts` 的 `RETRYABLE_CODES` 那一份，
 * 本层不再自带一套集合——两处各写一份时「哪个码算可重试」会随改动漂移。
 *
 * - 可重试：`NETWORK`（抖动）、`RATE_LIMIT`（限流），重发还有机会成功。
 * - 不可重试：`AUTH` 重试多少次都是同一个结果（规格 §8：不重试，改为页面 toast）；
 *   `TOO_LONG` 该走切分降级、`BAD_RESPONSE` 重试同一个输入没有意义——给它们挂上按钮，
 *   用户只会对着注定失败的段落反复点（一个 200 段的页面就是 200 个没用的按钮）。
 * - `code === undefined` 仍算可重试：没有错误码的失败（响应形状不符、后台漏了这条）
 *   是「这次没拿到结果」，不是「这段翻不了」。
 */
function isRetryable(code: TranslateItemResult['code']): boolean {
  return code === undefined || RETRYABLE_CODES.has(code);
}

/**
 * 整批失败且**错误码相同**时的兜底提示。
 *
 * 后台的 `translateBatch` 是逐条上报失败的（见 `background/scheduler.ts`），所以缺 API Key /
 * Key 无效这类问题表现为 `{ ok: true, results: [{ text: null, code: 'AUTH', … }, …] }`，
 * 而不是 `{ ok: false }`——`describeError` 那条路收不到它。没有这一层，用户只会看到满屏
 * 一模一样的错误标签，完全不知道发生了什么（规格 §8 要求的是「不重试；页面 toast + 弹窗红点」）。
 *
 * 只对"这一批**每一条**都失败且错误码相同"生效：部分失败是正常的，逐个标注即可。
 * 返回 null 表示不该弹 toast。
 *
 * `batchSize` 必须显式传本批的条目数，不能拿 `failures.length === results.length` 代替：
 * 调用方传进来的可能只有失败的那些条目（`applyResults` 就是这么调的），那样比较恒为真，
 * 一条失败混在成功里也会弹出"整批失败"的提示。
 */
function sameCodeFailureMessage(results: TranslateItemResult[], batchSize: number): string | null {
  const failures = results.filter((result) => result.text === null);
  if (failures.length === 0 || failures.length !== batchSize) return null;

  const [first] = failures;
  if (first?.code === undefined) return null;
  if (failures.some((failure) => failure.code !== first.code)) return null;

  const message = first.message ?? describeError({ code: first.code, message: '翻译失败' });
  if (first.code === 'AUTH') {
    return `${message}（在扩展设置里填好 API Key 后重新翻译此页）`;
  }
  if (first.code === 'NETWORK') {
    // 整批网络失败几乎从不是"抖了一下"，而是这个接口根本到不了：默认的免费 Google 接口
    // 在很多网络下被完全阻断（连超时都不返回）。只说"翻译失败"会让用户以为插件坏了，
    // 而真正该做的是去设置页换一个自己能访问的接口。规格 §8「免费接口失效」要求的
    // 就是这条提示。
    return `${message}。如果反复出现，说明当前网络到不了这个翻译接口——默认的免费 Google 接口在很多网络下无法访问，请在扩展设置里改用你能访问的自定义 API。`;
  }
  return message;
}

/**
 * 响应里的一个条目在**运行时**是不是 `TranslateItemResult`。
 *
 * 只校验身份字段 `id`：`text` 是不是 null 由后面按条目判断（null 是正常的条目级失败），
 * 但 id 缺失/不是字符串时这条结果根本对不上任何一段，只能当它不存在。
 */
function isResultItem(value: unknown): value is TranslateItemResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id.length > 0
  );
}

/** 形状不符的响应：整批收敛成失败态时给用户看的文案。 */
const MALFORMED_RESPONSE = '翻译响应格式不正确，请重试';

/**
 * 落地一批条目级结果。
 *
 * 失败条目一律标注错误文案，重试按钮按 `isRetryable` 决定——只有 `RETRYABLE_CODES`
 * 里那两类（网络抖动、限流）才挂按钮，其余错误挂上去也只是让用户白点。
 * 整个响应**全部失败且错误码相同**时，逐条标注之外再加一句整批提示，由调用方选时机弹。
 * 返回该提示（不需要时返回 null）。
 *
 * `results` 来自消息边界，类型断言拦不住它：`TranslateTextsResponse` 只是编译期声明，
 * 后台版本不匹配、引擎适配器出错都可能回一个 `results: undefined` 或元素形状不对的响应
 * （`Array.isArray` 收窄之后这里的参数其实已经是 `unknown`）。**形状不符按本批全部失败处理**
 * （逐段失败态 + 重试），不抛异常：抛出去会逃出并发池、reject 掉整轮，把页面永久留在
 * "翻译中…"——宿主停在 pending、renderer 守卫又让后续翻译变成空操作，用户既看不到失败
 * 也重试不了（规格 §8：绝不静默失败）。
 *
 * 逐条对应而不是按下标对齐：坏的条目丢掉之后下标会错位，`id` 才是唯一的身份。
 */
function applyResults(batch: TextSegment[], results: unknown): string | null {
  if (!Array.isArray(results)) {
    failBatch(batch, MALFORMED_RESPONSE);
    return MALFORMED_RESPONSE;
  }

  // 按 id 建立索引再逐条对应：坏形状的条目被丢掉之后下标会错位，`id` 才是唯一的身份。
  const byId = new Map<string, TranslateItemResult>();
  for (const result of results) if (isResultItem(result)) byId.set(result.id, result);

  const failures = new Map<string, TranslateItemResult>();
  // 有没有哪一段**根本没拿到结果**（形状不符被丢掉，或后台漏了这一条）。
  // 这与"部分条目翻译失败"是两回事：后者是正常的（`{ id, text: null, code }`），
  // 前者说明这个响应的形状跟本批对不上，要额外给整批提示。
  let missingResult = false;
  for (const item of batch) {
    const result = byId.get(item.id);
    if (result !== undefined && result.text !== null) {
      finished.add(item.id);
      renderer?.update(item.id, result.text);
      continue;
    }
    if (result === undefined) missingResult = true;
    const marked = result ?? { id: item.id, text: null as null, message: MALFORMED_RESPONSE };
    failures.set(item.id, marked);
    // 单条渲染失败不拖垮这一批：`failSegment` 自己兜住异常（并且已经记进 failedIds），
    // 循环必须把**剩下的每一条**都标完，否则没轮到的那些会永远停在"翻译中…"。
    failSegment(item.id, marked.message ?? '翻译失败', isRetryable(marked.code));
  }

  // 整批同码提示只按**真的回来了的**那些条目算：没回来的条目没有 code 可比，
  // 它们的提示由 MALFORMED_RESPONSE 负责。
  if (missingResult) return MALFORMED_RESPONSE;
  return sameCodeFailureMessage([...failures.values()], batch.length);
}

/**
 * 响应级失败（`ok: false`）：连引擎都没问到，标注**本批**条目。
 *
 * 只标本批：一个响应只代表它自己那一批的对错。标整页会把别的批次已经翻译好的片段
 * 一起算成失败——`applyResults` 从不回删被误标的 id，`done + failed` 会超过 `total`，
 * 状态面板上就出现"一段既译好了又算失败"。提示不在这里弹，攒进 `lastError` 由调用方
 * 在整轮跑完后弹一次。
 */
function failBatch(batch: TextSegment[], message: string): void {
  for (const segment of batch) failSegment(segment.id, message);
}

/**
 * 把一段标成失败态（记进 `failedIds` + 渲染）。**这一步自己绝不抛异常**：
 * 它跑在并发池的任务里，`core/pool.ts` 的契约是"调用方负责在任务内部捕获"——
 * 一个异常逃出去就会 reject 掉整轮，剩下的条目会永远停在"翻译中…"，
 * 而 `if (lastError !== null) toast(...)` 那一行也永远到不了（页面静默卡死）。
 *
 * 第一次渲染失败就退回一句纯文本：连错误标签都挂不上去的宿主，也别再让它
 * 以一个未捕获的异常收场。
 */
function failSegment(segmentId: string, message: string, canRetry = true): void {
  failedIds.add(segmentId);
  try {
    renderer?.fail(segmentId, message, canRetry);
  } catch {
    try {
      renderer?.fail(segmentId, '翻译失败');
    } catch {
      // 这一段的宿主已经彻底不可用：失败已经记进 failedIds（状态面板仍然对得上），
      // 不再往上抛——整轮的其余条目还得继续。
    }
  }
}

async function translatePage(): Promise<void> {
  if (running) return;
  // 已经翻译过就不重复翻译；要重来请先还原（避免插入两份译文）。
  if (renderer) return;

  // 认领这一轮的身份，并**同步**占住 running：下一个触发（同一轮宏任务里的连按）
  // 会在这里被拦住。generation 只被 restorePage 与下一轮推进，所以是"我这一轮"的凭据。
  const mine = ++generation;
  running = true;

  // **用投影**（`loadUiSettings`），不是完整设置：内容脚本跑在网页进程里，读完整设置会把
  // API Key 反序列化进网页进程的堆内存（规格 §7.3）。`UiSettings` 里根本没有 `apiKey`
  // 字段，本文件用到的 targetLang / displayMode / concurrency / maxBatchChars /
  // maxSegmentsPerBatch 全在投影里——这一层由 `tests/content/privacy-guard.test.ts` 守着。
  const settings: UiSettings = await loadUiSettings();
  // 等待设置读取期间可能已经被还原/被接管：安静退出，不碰任何状态。
  if (mine !== generation) return;

  const collected = collectSegments(document.body, { targetLang: settings.targetLang });
  if (collected.length === 0) {
    // 这里到认领之间没有 await，所以自己一定还是当前世代（generation 只能被下一轮
    // 翻译或还原推进，而两者都跑不到这里），守卫直接收回即可。
    running = false;
    toast('没有找到需要翻译的内容');
    return;
  }

  lastError = null;
  displayMode = settings.displayMode;
  finished.clear();
  failedIds.clear();
  segments = collected;
  renderer = new DomRenderer(document, settings.displayMode, (segmentId) => void retrySegment(segmentId));

  for (const segment of segments) renderer.mount(segment, 'pending');

  const textSegments: TextSegment[] = segments.map((s) => ({ id: s.id, text: s.text, order: s.order }));
  const batches = planBatches(textSegments, {
    maxBatchChars: settings.maxBatchChars,
    maxSegmentsPerBatch: settings.maxSegmentsPerBatch,
  });

  try {
    await runPool(
      batches.map((batch) => async () => {
        // 被接管的那一轮不再动页面：此时 renderer / finished / failedIds 都已经属于
        // 下一代，落笔只会把新的一轮搅乱（比如把新宿主标成失败）。
        if (mine !== generation) return;

        // 整个任务体都在 try/catch 里（不只是 sendMessage）：`core/pool.ts` 的契约是
        // "调用方负责在任务内部捕获"——任何意外异常逃出去都会 reject 掉 runPool，
        // 于是 applyResults 之后那一行 `if (lastError !== null) toast(...)` 被跳过、
        // running 也在 finally 里被收走，页面就永久留在"翻译中…"（renderer 守卫还在，
        // 用户连重试都点不动）。这里统一收敛成**本批**的失败态。
        try {
          let response: TranslateTextsResponse;
          try {
            response = await sendToBackground({
              type: MSG.TRANSLATE_TEXTS,
              payload: {
                items: batch.map((segment) => ({ id: segment.id, text: segment.text })),
                targetLang: settings.targetLang,
              },
            });
          } catch (raw) {
            // SW 被回收、扩展刚更新过时 sendMessage 会抛（"Receiving end does not exist"）；
            // SW 中途被回收时更常见的是**永不兑现**，由 `sendToBackground` 的超时收敛。
            // 一个批次炸掉不该让后面的批次跟着停：收敛成条目级失败继续跑。
            // `batch` 里的就是 `segments` 里那些对象本身，id 可直接用。
            if (mine !== generation) return;
            failBatch(batch, describeTransportError(raw));
            return;
          }

          // 响应回来后这一轮可能已经被还原/被接管：这一批的结论属于上一代，丢掉。
          if (mine !== generation) return;

          // 条目级失败（缺 API Key、限流、断网）走的是 ok: true + text: null 这条路，
          // 见 `sameCodeFailureMessage`：整批同码时只攒一句提示，且不挂重试按钮。
          if (!response.ok) {
            lastError = describeError(response);
            failBatch(batch, response.message);
            return;
          }
          // `applyResults` 自己校验响应形状：形状不符时整批进失败态，不抛异常。
          const notice = applyResults(batch, response.results);
          if (notice !== null) lastError = notice;
        } catch (raw) {
          // 兜底：整批进失败态（可重试）——绝不静默失败。逐条挂的是"本批没法处理"这句
          // 稳定文案（异常原文可能很长/含内部细节），原始原因只进页面级提示。
          const detail = raw instanceof Error ? raw.message : String(raw);
          if (mine !== generation) return;
          lastError = `翻译失败：${detail}`;
          failBatch(batch, MALFORMED_RESPONSE);
        }
      }),
      settings.concurrency,
    );
  } finally {
    // 只有自己仍是当前世代时才收回守卫：被接管的那一轮在飞完时不能把**新的一轮**
    // 的 running 清掉——那会让新的一轮在飞时又放进来第三个触发（多挂一份宿主）。
    if (mine === generation) running = false;
  }

  // 一轮的收尾同样只能由当前世代做：还原已经把页面清干净了，就别再弹上一代的错误。
  if (mine !== generation) return;

  // 整轮跑完才弹，且只弹一次：每批各弹一次的话，提示会被后一批顶掉重弹
  // （`toast()` 是"删旧节点 + 建新节点"），一个多批页面等于把同一件事播 N 遍。
  if (lastError !== null) toast(lastError);
}

async function retrySegment(segmentId: string): Promise<void> {
  const segment = segments.find((s) => s.id === segmentId);
  if (!segment) return;
  // 重试要按**当前**设置走：用户点了重试按钮，往往正是刚去设置页填完 API Key 回来。
  // 同样是投影（见 translatePage）：重试路径也不该把密钥读进网页进程。
  const settings = await loadUiSettings();

  failedIds.delete(segmentId);
  renderer?.mount(segment, 'pending');

  let response: TranslateTextsResponse;
  try {
    response = await sendToBackground({
      type: MSG.TRANSLATE_TEXTS,
      payload: { items: [{ id: segment.id, text: segment.text }], targetLang: settings.targetLang },
    });
  } catch (raw) {
    failedIds.add(segmentId);
    // 超时可能发生在用户点击重试之后：同样如实说明，而不是把页面吊在「翻译中…」。
    renderer?.fail(segment.id, describeTransportError(raw));
    return;
  }

  if (!response.ok) {
    failedIds.add(segmentId);
    renderer?.fail(segment.id, response.message);
    toast(describeError(response));
    return;
  }

  // 同 `applyResults`：`results` 来自消息边界，形状是运行时才成立的假设。
  const [result] = Array.isArray(response.results) ? response.results.filter(isResultItem) : [];
  if (result && result.text !== null) {
    finished.add(segment.id);
    renderer?.update(segment.id, result.text);
    return;
  }
  failedIds.add(segmentId);
  // 单条重试不再弹整批提示：用户就是看着这条错误点进来的，再弹一次是噪音。
  if (result === undefined) {
    // 响应里没有这一条（形状不符/后台漏了它）：按可重试的失败态标注，别停在"翻译中…"。
    // 注意 `result === undefined` 而不是 `result.text === null`：后者是正常的条目级失败，
    // 走下面那行按原样标注。
    renderer?.fail(segment.id, MALFORMED_RESPONSE);
    return;
  }
  renderer?.fail(segment.id, result.message ?? '翻译失败', isRetryable(result.code));
}

function restorePage(): void {
  renderer?.restore();
  renderer = null;
  segments = [];
  finished.clear();
  failedIds.clear();
  lastError = null;
  // 世代 +1 接管在飞的那一轮（它随后在每个 await 后安静退出），并**当场释放守卫**：
  // 还原之后紧接着的一次翻译（Alt+T 连按两下、或还原后点右键菜单）必须真的跑起来，
  // 不能被一个还在飞的上一轮挡住；上一轮跑完时也不会再动这一轮的状态。
  generation += 1;
  running = false;
}

/**
 * 响应弹窗/快捷键/右键菜单的入口。
 *
 * `TRANSLATE_SELECTION`（右键菜单的"翻译选中文本"）在 Plan 1 没有对应的划词气泡，
 * **有意不处理**：这里返回 false 表示"内容脚本不管这条消息"，后台那边的
 * `tabs.sendMessage(...).catch(...)` 照常收尾，不会变成未处理的拒绝。
 * 它是 Plan 2 划词翻译的接口预留（气泡与 `selectionTranslate` 开关一起做）。
 *
 * 带响应的两条分支都要兜住异常：`translatePage` 失败（设置版本高于本代码、存储坏了）
 * 时如果不响应，弹窗就会一直等到消息端口超时——用户看到的是一个没反应的按钮而不是原因。
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = (message as { type?: string } | null)?.type;

  const runTranslate = (): void => {
    translatePage()
      .catch((raw: unknown) => {
        const detail = raw instanceof Error ? raw.message : String(raw);
        toast(`翻译失败：${detail}`);
      })
      .then(() => sendResponse(currentState()));
  };

  if (type === MSG.TRANSLATE_PAGE) {
    runTranslate();
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
    runTranslate();
    return true;
  }
  if (type === MSG.GET_PAGE_STATE) {
    sendResponse(currentState());
    return false;
  }
  return false;
});
```

> **条目级 `AUTH` 与页面 toast 的口径（Task 14 审查遗留的决定，必须照此实现）**：后台的
> `translateBatch` 是**逐条**上报失败的，所以缺 API Key / Key 无效这类鉴权失败会表现为
> `{ ok: true, results: [{ text: null, code: 'AUTH', … }, …] }`，而不是 `{ ok: false }`。
> 上面 `if (!response.ok)` 那个分支因此**收不到鉴权失败**，`describeError` 的 `AUTH` /
> `RATE_LIMIT` 两条也就永远不会被走到；一个 200 段的页面会变成 200 个"尚未填写 API Key"
> 标签，而规格 §8 要求的是「不重试；页面 toast + 弹窗红点」。
>
> 采用条目级的响应形状作为契约（它更精确，Task 13 的 22 条调度器用例也钉在它上面），缺口
> 在展示侧补：**整批结果 `results.every((r) => r.code === 'AUTH')` 时，只 toast 一次
> `results[0].message`，并且不给这些片段挂重试按钮**（重试多少次都是同一个结果）。
> 其余错误码维持现状：条目级标注 + 重试按钮。

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
      <button id="open-options" class="icon-button" type="button" title="设置" aria-label="设置">⚙</button>
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
import {
  DISPLAY_MODES,
  loadSettings,
  saveSettings,
  type DisplayMode,
  type Settings,
} from '../shared/settings';

/**
 * 按钮的三种态：不知道页面状态（`pageState === null`，初始与失败后）、
 * 知道状态但在飞（`inFlight`）、已知状态且空闲。分成两个变量而不是共用一个
 * `disabled`，因为它们的**收尾方式完全不同**：页面不可用要一直置灰到重开弹窗，
 * 在飞只是这一小段时间防连点，拿到响应就该放开。`inFlight` 开局为 true——
 * 设置还没读出来之前，按钮不该是可点的。
 */
const toggleButton = document.getElementById('toggle') as HTMLButtonElement;
const statusText = document.getElementById('status') as HTMLParagraphElement;
const displayModeSelect = document.getElementById('display-mode') as HTMLSelectElement;
const targetLangSelect = document.getElementById('target-lang') as HTMLSelectElement;
const engineSelect = document.getElementById('engine') as HTMLSelectElement;
const engineHint = document.getElementById('engine-hint') as HTMLParagraphElement;
const optionsButton = document.getElementById('open-options') as HTMLButtonElement;

/** 发消息的兜底超时：内容脚本**可能永远不回**（见 `requestPageState` 的注释）。 */
const TOGGLE_TIMEOUT_MS = 30_000;

let settings: Settings;
let pageState: PageState | null = null;
let inFlight = true;

function errorText(prefix: string, raw: unknown): string {
  return `${prefix}：${raw instanceof Error ? raw.message : String(raw)}`;
}

function fillSelect(
  select: HTMLSelectElement,
  entries: ReadonlyArray<{ value: string; label: string }>,
  value: string,
): void {
  select.textContent = '';
  for (const entry of entries) {
    const option = document.createElement('option');
    option.value = entry.value;
    option.textContent = entry.label;
    option.selected = entry.value === value;
    select.append(option);
  }
}

/** 用存储里的设置填三个下拉，并把 hint 算对；保存失败回滚时也走这里。 */
function applySettings(next: Settings): void {
  settings = next;
  fillSelect(displayModeSelect, DISPLAY_MODES, settings.displayMode);
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
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

/**
 * 取当前页面的翻译状态；**拿不到就返回 null**，`undefined` 永远不往渲染层传——
 * 内容脚本对不认识的 `TOGGLE_PAGE` 是不响应的（返回 false，端口随即关闭），
 * 而 `translating` 期间它又可能一直不回应。两种情况都不是"页面不可用"。
 */
async function requestPageState(tabId: number, message: { type: string }): Promise<PageState | null> {
  const state = (await chrome.tabs.sendMessage(tabId, message)) as PageState | undefined;
  return state ?? null;
}

/**
 * 整块界面的唯一渲染出口。`fallback` 描述「不知道页面状态」时该怎么办，三种语义要分清：
 *
 * - `unavailable`：页面确实不能翻译（浏览器内置页、扩展商店页）。一直置灰。
 * - `busy`：这一条消息没回来，但页面**正在翻译**。必须置灰——弹窗主按钮是幂等开关，
 *   内容脚本看到 `renderer` 非空就执行还原，放开按钮等于给用户一个"点一下就把在跑的
 *   翻译静默撤掉"的陷阱。几百段的页面本来就会超过兜底时限，这条路径在真机上很常见。
 * - `retryable`：只是这一条消息没走通，页面状态未知。按钮保持可点，文案说"重新试一次"，
 *   而不是冒充"此页面不可用"。
 *
 * 三种都清掉 `dataset.active`：否则上一次渲染留下的"已翻译"深灰配色会挂在一句错误
 * 文案上，两个信号自相矛盾。
 */
type ToggleFallback = 'unavailable' | 'busy' | 'retryable';

const FALLBACK_TEXT: Record<ToggleFallback, { button: string; status: string; disabled: boolean }> = {
  unavailable: {
    button: '此页面不可用',
    status: '当前页面不支持翻译（浏览器内置页面或扩展商店页面）。',
    disabled: true,
  },
  busy: {
    button: '翻译进行中',
    status: '页面还在翻译，重新打开弹窗即可看到最新进度。',
    disabled: true,
  },
  retryable: {
    button: '重新试一次',
    status: '没能拿到页面状态，重新打开弹窗或再试一次。',
    disabled: false,
  },
};

function renderToggle(state: PageState | null, reason?: string, fallback?: ToggleFallback): void {
  if (state === null) {
    const preset = FALLBACK_TEXT[fallback ?? 'unavailable'];
    toggleButton.disabled = preset.disabled;
    delete toggleButton.dataset.active;
    toggleButton.textContent = preset.button;
    statusText.textContent = reason ?? preset.status;
    return;
  }
  // 在飞期间保持置灰：连点会开出两份译文宿主。
  toggleButton.disabled = inFlight;
  toggleButton.dataset.active = String(state.translated);
  toggleButton.textContent = state.translated ? '显示原文' : '翻译此页';
  statusText.textContent = state.translated
    ? `已翻译 ${state.done} / ${state.total} 段`
    : '按 Alt+T 也可以快速开关。';
}

/**
 * 在飞标记。`inFlight` 只影响**在飞期间**的渲染，所以置回 false 时故意不重新渲染：
 * 收尾那次渲染必须由拿到结果的那一段显式做，否则它会用一个过期的 `pageState`
 * 把超时/失败文案盖掉。
 */
function setInFlight(value: boolean): void {
  inFlight = value;
  if (value) renderToggle(pageState);
}

function renderEngineHint(): void {
  const engine = getEngine(settings.engineId);
  // 判空口径与引擎实现一致：只有空白字符也算**没填**（见 openai-compat 的构造）。
  const missingKey = engine.needsKey && settings.engineConfig.apiKey.trim().length === 0;
  if (missingKey) {
    engineHint.classList.add('warn');
    engineHint.textContent = '该引擎需要 API Key，请先在设置中填写。';
    return;
  }
  // 前瞻分支：现存两个引擎的 supportsGlossary 都是 true，今天恒不成立。留着是接口预留
  // （见 engines/types.ts 的 Translator），不是死代码。
  if (!engine.supportsGlossary && settings.glossary.length > 0) {
    engineHint.classList.remove('warn');
    engineHint.textContent = '当前引擎不支持术语表，术语表对其不生效。';
    return;
  }
  engineHint.classList.remove('warn');
  engineHint.textContent = engine.needsKey ? '已配置你自己的 API Key。' : '零配置可用，无需 API Key。';
}

/**
 * 初始化与点击共用的兜底：**任何**没被就地处理的拒绝都要变成用户看得见的一句话。
 * 没有它，`void init()` 与 `void onClick()` 会各自留下一次未处理的拒绝，界面停在
 * 半初始化状态上——按钮看着能点、点下去没反应，比直接报错更难排查。
 */
function runSafely(prefix: string, run: () => Promise<void>): void {
  void run().catch((raw: unknown) => {
    pageState = null;
    setInFlight(false);
    // retryable：按钮别锁死。设置读不出来时页面本身没坏，用户按一下会得到一次
    // 如实的通信失败提示，而不是"看着能点、点了没反应"。
    renderToggle(null, errorText(prefix, raw), 'retryable');
  });
}

/** 拉一次页面状态并渲染。发送失败时返回 null，而不是把异常当"页面不可用"处理。 */
async function refreshPageState(): Promise<void> {
  const tabId = await activeTabId();
  if (tabId === null) {
    pageState = null;
    renderToggle(null, '当前窗口没有可翻译的标签页。');
    return;
  }
  try {
    pageState = await requestPageState(tabId, { type: MSG.GET_PAGE_STATE });
  } catch {
    // chrome:// 等受限页面上没有内容脚本，属于正常情况。
    pageState = null;
  }
  renderToggle(pageState);
}

/**
 * 点主按钮：只发 TOGGLE_PAGE，不自己判断方向——状态的唯一真相在内容脚本里，
 * 弹窗里的 dataset 只用于渲染，不能作为决策依据。
 */
async function handleToggleClick(): Promise<void> {
  const tabId = await activeTabId();
  if (tabId === null) {
    pageState = null;
    renderToggle(null, '当前窗口没有可翻译的标签页。');
    return;
  }

  setInFlight(true);
  // 超时自己收尾：内容脚本要等**整页翻译跑完**才响应 TOGGLE_PAGE，几百段的页面必然
  // 超过这个时限，而那时翻译其实正在正常进行。等端口自己关闭可能要几分钟，用户看到的
  // 是一个没有理由的置灰按钮。
  // 同一个定时器既渲染又拒绝：两个独立定时器会各渲染一次，后跑的那个把先跑的
  // 文案盖掉。
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      pageState = null;
      renderToggle(
        null,
        `页面已翻译超过 ${Math.round(TOGGLE_TIMEOUT_MS / 1000)} 秒仍在进行，这里先不打扰它——重新打开弹窗即可看到最新进度。`,
        'busy',
      );
      reject(new Error('等待页面响应超时'));
    }, TOGGLE_TIMEOUT_MS);
  });

  try {
    // Promise.race 而不是只等 sendMessage：超时那一支必须自己渲染，而 sendMessage
    // 的 promise 可能永远不兑现，界面就会一直停在置灰的按钮上。
    const state = await Promise.race([requestPageState(tabId, { type: MSG.TOGGLE_PAGE }), timeout]);
    pageState = state;
    inFlight = false;
    // 消息回来了但没带状态（内容脚本先卸载、端口半关）与"页面不能翻译"是两回事：
    // 前者该让用户再试一次，不能冒充"此页面不可用"。
    renderToggle(pageState, undefined, state === null ? 'retryable' : undefined);
  } catch (raw) {
    pageState = null;
    // 发送失败≠页面不可翻译：端口提前关闭、内容脚本内部报错、等待超时都长这样。
    // 如实说明而不是把可翻译的页面说成"此页面不可用"。
    // 也不要建议"重新加载页面"——在翻译正在进行时，那是唯一会把已完成部分全丢掉的
    // 操作；用户真正该做的是重开弹窗看最新进度。
    // 超时那句已经在上面渲染好了，这里不要再盖一次。
    // 在飞标记要在渲染**之前**落定：渲染之后没人再碰它，就不会出现
    // "按钮已放开、文案和 disabled 却还是上一次渲染留下的"这种自相矛盾的状态。
    inFlight = false;
    if (!timedOut) renderToggle(null, `${errorText('无法与页面通信', raw)}。请重新打开弹窗重试。`, 'retryable');
  } finally {
    clearTimeout(timeoutId);
  }
}

/** 初始化要用的那串 await；注册监听器**不能**放在它之后（见 `init`）。 */
async function start(): Promise<void> {
  applySettings(await loadSettings());
  await refreshPageState();
  // 按钮开局的置灰是"设置还没读出来"的在飞态，这里才是它真正的收尾。
  // 不能放进 `applySettings`：保存失败回滚也会走那里，而回滚不该动在飞标记。
  inFlight = false;
  renderToggle(pageState);
}

/**
 * @param next 存储里的设置
 * @param previous 失败时用来回滚的**上一份**完整设置
 * @param field 这次改的是哪个字段（回滚只动这一个）
 */
async function saveSettingsOrReport(
  next: Settings,
  previous: Settings,
  control: HTMLSelectElement,
  field: 'targetLang' | 'engineId' | 'displayMode',
): Promise<void> {
  try {
    await saveSettings(next);
    settings = next;
  } catch (raw) {
    // `saveSettings` 在存储版本高于本代码时明确拒绝。不报告就等于"改了没生效"，
    // 用户看到的是设置自己弹回去；这里如实说，并把下拉回滚到真正生效的那一项。
    settings = previous;
    control.value = previous[field];
    renderEngineHint();
    statusText.textContent = errorText('设置未能保存', raw);
  }
}

function onTargetLangChange(): void {
  const previous = settings;
  const next: Settings = { ...settings, targetLang: targetLangSelect.value };
  void saveSettingsOrReport(next, previous, targetLangSelect, 'targetLang').then(() => {
    // 语言改动只落盘，不会重译当前页面（规范 §7.1）。页面已经译完时不说一声，
    // 用户会以为下拉没生效。保存失败时上面已经写了错误文案，不覆盖它。
    if (settings !== next) return;
    if (pageState?.translated) {
      statusText.textContent = '目标语言已更新，重新翻译此页生效。';
    }
  });
}

/**
 * 切换显示模式：**只写设置，当场不重译**。
 *
 * 显示模式是渲染时读的（内容脚本 `translatePage` 从设置里取一次），改完不会回头重画
 * 已经译好的页面。这里如实告诉用户"要重新翻译才生效"，而不是假装立即生效——
 * 页面纹丝不动而弹窗说"已生效"，用户只会以为功能坏了。
 */
function onDisplayModeChange(): void {
  const previous = settings;
  const next: Settings = { ...settings, displayMode: displayModeSelect.value as DisplayMode };
  void saveSettingsOrReport(next, previous, displayModeSelect, 'displayMode').then(() => {
    if (settings !== next) return;
    if (pageState?.translated) {
      statusText.textContent = '显示模式已更新，重新翻译此页生效。';
    }
  });
}

function onEngineChange(): void {
  const previous = settings;
  const next: Settings = { ...settings, engineId: engineSelect.value };
  void saveSettingsOrReport(next, previous, engineSelect, 'engineId').then(() => {
    // 存储里没变就说明刚才拒绝过，提示区别再按没生效的引擎重算一遍。
    if (settings !== next) return;
    renderEngineHint();
  });
}

function init(): void {
  // 设置读出来之前按钮先置灰：这会儿 `pageState` 还是 null、监听器也刚挂上，让它可点
  // 只会是"点了没反应"的那个窗口期。HTML 里没有 `disabled` 属性，所以这句是必须的
  // 同步渲染——`start()` 要等一整个存储往返才轮到它渲染。
  toggleButton.disabled = true;

  // 监听器在第一个 await **之前**挂好：`loadSettings` 有明确的拒绝路径（存储里是
  // 更高版本、存储读写失败）。若等读完再挂，这些拒绝会让界面变成一个"看着能点、
  // 其实没有任何监听器"的死弹窗，连齿轮都打不开。
  toggleButton.addEventListener('click', () => {
    runSafely('操作失败', handleToggleClick);
  });
  targetLangSelect.addEventListener('change', onTargetLangChange);
  displayModeSelect.addEventListener('change', onDisplayModeChange);
  engineSelect.addEventListener('change', onEngineChange);
  optionsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());

  runSafely('设置读取失败', start);
}

init();
```

- [ ] **Step 4: 运行类型检查与构建**

Run: `npm run typecheck`

Expected: 退出码 0。

Run: `npm run build`

Expected: 退出码 0，`dist/popup/popup.html`、`dist/popup.js` 存在（入口按 `entryFileNames: '[name].js'` 落在 dist 根，`popup.html` 里的 `<script type="module" crossorigin src="/popup.js">` 指的就是它）。

- [ ] **Step 5: 提交**

```bash
git add src/popup tests/popup tests/helpers/chrome-stub.ts
git commit -m "feat(popup): 翻译开关、语言与引擎选择"
```

> `tests/popup` 与 `tests/helpers/chrome-stub.ts`（`responder` 扩展）属于本任务的附加测试，
> 必须与实现进同一个提交——只 `git add src/popup` 会留下一个测试与实现不同步的中间提交。

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
