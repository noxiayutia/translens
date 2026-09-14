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
