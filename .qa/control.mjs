// 对照实验：同一个 Chrome 实例里同时加载「一个最小手写扩展」和「被测 dist」。
// 对照扩展也不行 ⇒ 问题在我的启动方式/环境；对照正常而 dist 不正常 ⇒ 产物真有问题。
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startChrome, startMock, extensionId, sleep, FIXTURE_BASE, kill } from './harness.mjs';

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
writeFileSync(join(CTRL, 'bg.js'), 'chrome.runtime.onInstalled.addListener(() => console.log("control installed"));\n');
writeFileSync(join(CTRL, 'cs.js'), 'document.documentElement.setAttribute("data-qa-control", "1");\n');
writeFileSync(
  join(CTRL, 'popup', 'popup.html'),
  '<!doctype html><meta charset="utf-8"><title>CTRL POPUP</title><body><h1 id="h">CTRL-OK</h1></body>',
);

console.log('加载目录: dist + 对照扩展', CTRL);
const mock = await startMock();
const { child, cdp } = await startChrome([CTRL]);
try {
  const id = await extensionId(cdp);
  const targets = await cdp.targets();
  console.log('全部 target:', targets.map((t) => `${t.type}|${t.url.slice(0, 72)}`));
  console.log('被测扩展 id:', id);

  const ctrlId = targets
    .map((t) => t.url)
    .find((u) => u.includes('chrome-extension://') && !u.includes(id))
    ?.match(/chrome-extension:\/\/([a-p]{32})/)?.[1];
  console.log('对照扩展 id:', ctrlId);

  const page = await cdp.openTab(`${FIXTURE_BASE}/article.html`);
  await sleep(2500);
  console.log('页面上下文:', cdp.contexts(page.sessionId).map((c) => `${c.name || 'main'}#${c.id}`));
  console.log(
    '内容脚本痕迹:',
    await cdp.eval(page.sessionId, `({
      controlAttr: document.documentElement.getAttribute('data-qa-control'),
      jyHosts: document.querySelectorAll('jy-translation').length,
    })`),
  );

  for (const [label, url] of [
    ['对照 popup', `chrome-extension://${ctrlId}/popup/popup.html`],
    ['被测 popup', `chrome-extension://${id}/popup/popup.html`],
    ['被测 options', `chrome-extension://${id}/options/options.html`],
    ['被测 content.js 原文', `chrome-extension://${id}/content.js`],
    ['被测 manifest 原文', `chrome-extension://${id}/manifest.json`],
  ]) {
    const t = await cdp.openTab(url);
    await sleep(900);
    const text = await cdp.eval(t.sessionId, `(document.body?.innerText ?? '').slice(0, 90)`).catch((e) => String(e));
    console.log(`${label}: ${text.replace(/\n/g, ' ')}`);
  }
  console.log('页面异常:', cdp.consoleErrors().slice(0, 5));
} finally {
  await kill(child);
  await kill(mock);
}
