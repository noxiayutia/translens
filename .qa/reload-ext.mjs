// 常驻实例里的扩展是从 .qa/dist-perm 加载的一份**副本**：改了代码必须重刷副本并重载，
// 否则测的还是旧产物（这个坑真踩过——改完跑扫描读数和单测对不上）。
// 用法：node .qa/reload-ext.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp } from './cdp.mjs';
import { loadUnpacked, PORT } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const stateFile = join(here, 'state.json');
execFileSync(process.execPath, [join(here, 'make-hostperm-dist.mjs')], { stdio: 'inherit' });

const cdp = await Cdp.connect(PORT.cdp);
try {
  const id = await loadUnpacked(cdp, join(here, 'dist-perm'));
  const before = JSON.parse(readFileSync(stateFile, 'utf8'));
  writeFileSync(stateFile, JSON.stringify({ id, cdp: PORT.cdp }, null, 1));
  console.log(`重载完成 id=${id}${before.id === id ? '' : `（原来是 ${before.id}）`}`);
} finally {
  cdp.ws.close();
}
