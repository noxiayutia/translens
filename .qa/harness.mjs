// QA 台架：拉起本地假引擎 + 一个**独立临时 profile** 的 Chrome（不碰用户日常配置），
// 用 CDP 驱动它。所有产物都在系统临时目录，跑完即弃。

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, sleep } from './cdp.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = { engine: 8787, cdp: 9333 };
export const PROFILE_DIR = join(tmpdir(), 'translens-qa-profile');
export const FIXTURE_BASE = `http://127.0.0.1:${PORT.engine}/fixture`;

const CHROME =
  process.env.JY_QA_BROWSER ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/**
 * 加载目录：在**调用时**读环境变量，这样脚本可以先设值再启动。
 * JY_QA_DIST=<路径> 指定要加载的目录；JY_QA_DIST=none 表示什么都不加载（纯浏览器对照）。
 */
export function loadDir() {
  const v = process.env.JY_QA_DIST;
  if (v === 'none') return null;
  return v ?? join(REPO, 'dist');
}

function run(cmd, args) {
  return spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
}

export async function startMock() {
  const child = run(process.execPath, [join(REPO, '.qa', 'mock-engine.mjs'), String(PORT.engine)]);
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[mock] ${d}`));
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT.engine}/__ctl`);
      if (res.ok) return child;
    } catch {}
    await sleep(120);
  }
  throw new Error('假引擎起不来');
}

export async function startChrome(extraLoadDirs = []) {
  // JY_QA_KEEP=1 时保留临时 profile：里面存着一次性人工点出来的宿主授权与已配好的档案，
  // 保住它 = 之后每轮全自动。
  if (process.env.JY_QA_KEEP !== '1') await rm(PROFILE_DIR, { recursive: true, force: true }).catch(() => {});
  const loadArg = [loadDir(), ...extraLoadDirs].filter(Boolean).join(',');
  if (!loadArg) throw new Error('没有指定要加载的扩展目录');
  console.log('[harness] --load-extension =', loadArg);
  const child = run(CHROME, [
    `--user-data-dir=${PROFILE_DIR}`,
    `--load-extension=${loadArg}`,
    `--remote-debugging-port=${PORT.cdp}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1400,980',
    '--window-position=40,40',
    'about:blank',
  ]);
  child.stderr.on('data', (d) => process.stderr.write(`[chrome] ${d}`));
  const cdp = await Cdp.connect(PORT.cdp);
  return { child, cdp };
}

/**
 * Chrome 137 起品牌版（stable / Edge）忽略 `--load-extension`，只能用 CDP 的
 * `Extensions.loadUnpacked` 在运行时挂载。返回扩展 id。
 * 只对**本进程用 --remote-debugging-port 起的这个 Chrome** 生效，profile 删掉即无痕。
 */
export async function loadUnpacked(cdp, dir) {
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: dir });
  return id;
}

/** MV3 的 service worker 目标 URL 形如 chrome-extension://<id>/service_worker.js */
export async function extensionId(cdp) {
  for (let i = 0; i < 60; i += 1) {
    const targets = await cdp.targets();
    const sw = targets.find((t) => t.type === 'service_worker' && /chrome-extension:\/\//.test(t.url));
    if (sw) return new URL(sw.url).host;
    await sleep(250);
  }
  return null;
}

export async function kill(child) {
  if (!child || child.killed) return;
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    killer.on('exit', resolve);
    setTimeout(() => {
      child.kill();
      resolve();
    }, 4000);
  });
}

export { Cdp, sleep, REPO };
