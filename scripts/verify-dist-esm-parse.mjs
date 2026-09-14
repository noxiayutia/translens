#!/usr/bin/env node
/**
 * `scripts/verify-dist.mjs` 的专用助手：用 `vm.SourceTextModule` **解析**（不执行）一个入口文件。
 *
 * 为什么必须是独立文件、而非 `node -e` 内联：ESM 的解析器 `vm.SourceTextModule` 需要
 * `--experimental-vm-modules`。带 `-e` 的进程若其源码里出现 `import`，Node 会把它整个当成
 * 模块入口去**加载并解析依赖**，于是 `D:\翻译-插件\chunks\settings.js` 这种按 dist 根写的
 * 扩展路径会被当成 Node 包路径去找，报 ERR_MODULE_NOT_FOUND——文件明明是对的，却解析失败。
 * 独立文件用 `NODE_OPTIONS` 带上标志、把待解析源码通过 argv 传进来，就没有这个问题。
 *
 * 用法：NODE_OPTIONS=--experimental-vm-modules node scripts/verify-dist-esm-parse.mjs <file>
 * 退出码：0 = 解析通过；2 = 语法错误（stderr 打印原因）；3 = 环境不支持（没有解析器）
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ModuleCtor = vm.SourceTextModule;
if (typeof ModuleCtor !== 'function') {
  console.error('vm.SourceTextModule 不可用：需要 --experimental-vm-modules');
  process.exitCode = 3;
} else {
  const target = process.argv[2];
  if (target === undefined || target === '') {
    console.error('用法：node scripts/verify-dist-esm-parse.mjs <file>');
    process.exitCode = 2;
  } else {
    try {
      const source = readFileSync(target, 'utf8');
      // 构造即完成词法/语法解析；不 link、不 evaluate，所以 dist 里那些扩展相对路径
      // （`./chunks/settings.js`）在这里不会被解析，不会产生误报。
      new ModuleCtor(source, { identifier: target });
      process.stdout.write('OK\n');
    } catch (error) {
      process.stdout.write(`FAIL:${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
  }
}
