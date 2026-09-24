// 只用「最小对照扩展」跑一遍，判断：
//   1) Chrome 153 + --load-extension 到底能不能正常加载 unpacked 扩展；
//   2) 扩展页面（popup）能不能打开；
//   3) 内容脚本能不能注入。
// 对照能过而 dist 过不去，才说明是被测产物的问题。
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CTRL = join(tmpdir(), 'translens-qa-control');
rmSync(CTRL, { recursive: true, force: true });
mkdirSync(join(CTRL, 'popup'), { recursive: true });
writeFileSync(
  join(CTRL, 'manifest.json'),
  JSON.stringify({
    manifest_version: 3,
    name: 'QA Control',
    version: '1.0',
    permissions: ['storage'],
    background: { service_worker: 'bg.js', type: 'module' },
    action: { default_popup: 'popup/popup.html' },
    content_scripts: [{ matches: ['http://*/*'], js: ['cs.js'], run_at: 'document_idle' }],
  }),
);
writeFileSync(join(CTRL, 'bg.js'), 'globalThis.__CTRL_BG = 1;\n');
writeFileSync(join(CTRL, 'cs.js'), 'document.documentElement.setAttribute("data-qa-control", "1");\n');
writeFileSync(
  join(CTRL, 'popup', 'popup.html'),
  '<!doctype html><meta charset="utf-8"><title>CTRL POPUP</title><body><h1 id="h">CTRL-OK</h1></body>',
);

process.env.JY_QA_DIST = CTRL; // 只加载对照扩展，不加载被测 dist
const { startChrome, startMock, sleep, FIXTURE_BASE, kill, PROFILE_DIR } = await import('./harness.mjs');
const mock = await startMock();
console.log('对照扩展目录:', CTRL);
const { child, cdp } = await startChrome();
try {
  await sleep(3000);
  const prefsPath = join(PROFILE_DIR, 'Default', 'Preferences');
  if (existsSync(prefsPath)) {
    const prefs = JSON.parse(readFileSync(prefsPath, 'utf8'));
    const settings = prefs.extensions?.settings ?? {};
    console.log(
      'Preferences 里的扩展:',
      Object.entries(settings).map(([id, e]) => `${e.name}|path=${e.path}|state=${e.state}`),
    );
  } else {
    console.log('Preferences 还没落盘');
  }
  console.log('targets:', (await cdp.targets()).map((t) => `${t.type}|${t.url.slice(0, 70)}`));

  const page = await cdp.openTab(`${FIXTURE_BASE}/article.html`);
  await sleep(2500);
  console.log(
    '对照内容脚本注入:',
    await cdp.eval(page.sessionId, `document.documentElement.getAttribute('data-qa-control')`),
  );
} finally {
  await kill(child);
  await kill(mock);
}
