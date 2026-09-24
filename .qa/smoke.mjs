// 冒烟：用 CDP Extensions.loadUnpacked 挂载 dist，验证真 Chrome 里扩展能加载、
// 内容脚本能注入、扩展页面能打开。
import { startMock, startChrome, loadUnpacked, sleep, FIXTURE_BASE, kill, loadDir } from './harness.mjs';

const mock = await startMock();
const { child, cdp } = await startChrome();
try {
  const dir = loadDir();
  const id = await loadUnpacked(cdp, dir);
  console.log('挂载成功，扩展 id:', id, '来自', dir);

  const extTargets = (await cdp.targets()).filter((t) => t.url.includes(id));
  console.log('扩展相关 target:', extTargets.map((t) => `${t.type}|${t.url}`));

  const page = await cdp.openTab(`${FIXTURE_BASE}/article.html`);
  await sleep(2500);
  console.log('页面上下文:', cdp.contexts(page.sessionId).map((c) => `${c.name || 'main'}#${c.id}`));
  console.log(
    '页面探针:',
    await cdp.eval(page.sessionId, `({
      jyHosts: document.querySelectorAll('jy-translation').length,
      attrs: [...document.documentElement.attributes].map(a => a.name).slice(0, 10),
    })`),
  );

  for (const [label, path] of [
    ['popup', 'popup/popup.html'],
    ['options', 'options/options.html'],
  ]) {
    const t = await cdp.openTab(`chrome-extension://${id}/${path}`);
    await sleep(1400);
    console.log(
      `${label}:`,
      await cdp.eval(t.sessionId, `({
        title: document.title,
        text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200),
      })`),
    );
  }
  console.log('页面异常:', cdp.consoleErrors().slice(0, 6));
} finally {
  await kill(child);
  await kill(mock);
}
