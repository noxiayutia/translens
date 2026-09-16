import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * 把 `src/` 下不进打包图的**静态资源**原样发射到 dist/：
 *
 * - `manifest.json` → `dist/manifest.json`；
 * - `icons/*.png` → `dist/icons/*.png`（manifest 的 `icons` 与 `action.default_icon`
 *   按 dist 根引用它们，形如 `icons/16.png`）。
 *
 * 图标是 `npm run icons`（`scripts/make-icons.mjs`）生成后**入库**的，构建不重新生成——
 * 构建只负责搬运，这样 dist 里的图标与仓库里提交的那四个字节完全一致。
 */
function copyStatic(): Plugin {
  return {
    name: 'copy-static',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: readFileSync(resolve(import.meta.dirname, 'src/manifest.json'), 'utf-8'),
      });

      const iconsDir = resolve(import.meta.dirname, 'src/icons');
      for (const name of readdirSync(iconsDir).sort()) {
        if (!name.endsWith('.png')) continue;
        this.emitFile({
          type: 'asset',
          fileName: `icons/${name}`,
          source: readFileSync(resolve(iconsDir, name)),
        });
      }
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
  plugins: [copyStatic()],
});
