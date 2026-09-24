// 常驻实例：起 mock 引擎 + Chrome + 挂载扩展，把档案/授权/引擎选择准备好，然后**不退**。
// 各场景脚本用 JY_QA_ATTACH=1 连上来复用同一个实例（授权只在实例活着的时候有效）。
// 用法：JY_QA_KEEP=1 node .qa/daemon.mjs      （Ctrl-C 退出）
import { boot, seedProfileViaUi, sleep, PATTERN } from './lib.mjs';

const api = await boot();

const readProfiles = () =>
  api.extEval(`chrome.storage.local.get('jinyi:settings').then(o => JSON.stringify(o['jinyi:settings']?.profiles ?? []))`);

let profiles = JSON.parse(await readProfiles());
if (profiles.length === 0) {
  const r = await seedProfileViaUi(api);
  console.log('建档:', JSON.stringify({ status: r.status, error: r.error }));
  profiles = JSON.parse(await readProfiles());
}
console.log('档案:', profiles.map((p) => p.label + '@' + p.baseUrl).join(' / '));

if (!(await api.extEval(`chrome.permissions.contains({ origins: [${JSON.stringify(PATTERN)}] })`))) {
  const tab = await api.cdp.openTab(`chrome-extension://${api.id}/options/options.html`);
  await sleep(1200);
  const pos = JSON.parse(
    await api.cdp.eval(
      tab.sessionId,
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const trigger = document.querySelector('.profile-row [data-action="toggle"]');
        if (!trigger) return JSON.stringify({ error: '没有可展开的档案行' });
        trigger.click();
        await wait(400);
        const save = [...document.querySelectorAll('.profile-editor')].pop()?.querySelector('[data-action="save-profile"]');
        if (!save) return JSON.stringify({ error: '没有保存按钮' });
        const rect = save.getBoundingClientRect();
        return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
      })()`,
    ),
  );
  if (pos.error) throw new Error(pos.error);
  await api.cdp.mouse(tab.sessionId, 'mousePressed', pos.x, pos.y);
  await api.cdp.mouse(tab.sessionId, 'mouseReleased', pos.x, pos.y);
  console.log('>>> 已点「保存」：请在 Chrome 窗口点「允许」（最多 3 分钟）');
  for (let i = 0; i < 90; i += 1) {
    if (await api.extEval(`chrome.permissions.contains({ origins: [${JSON.stringify(PATTERN)}] })`)) break;
    await sleep(2000);
  }
  await api.closeTab(tab.targetId);
}

const granted = await api.extEval(`chrome.permissions.contains({ origins: [${JSON.stringify(PATTERN)}] })`);
const engineId = await api.extEval(`chrome.storage.local.get('jinyi:settings').then(o => o['jinyi:settings']?.engineId ?? '')`);
if (!engineId) {
  const popup = await api.cdp.openTab(`chrome-extension://${api.id}/popup/popup.html`);
  await sleep(1400);
  await api.cdp.eval(
    popup.sessionId,
    `(() => {
      const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => /QA Mock/.test(o.textContent)));
      const opt = [...sel.options].find(o => /QA Mock/.test(o.textContent));
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`,
  );
  await sleep(800);
  await api.closeTab(popup.targetId);
}

console.log(
  `READY id=${api.id} granted=${granted} engineId=${await api.extEval(
    `chrome.storage.local.get('jinyi:settings').then(o => o['jinyi:settings']?.engineId ?? '')`,
  )}`,
);

process.on('SIGINT', async () => {
  console.log('关闭常驻实例…');
  await api.close();
  process.exit(0);
});
setInterval(() => {}, 1 << 30);
