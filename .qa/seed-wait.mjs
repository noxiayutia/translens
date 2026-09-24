// 一次性准备：建档 + 授权（可能需要真人点一次「允许」）+ 在弹窗里选中引擎。
// 跑完会**干净退出** Chrome，这样授权与设置才会落进临时 profile，之后每轮全自动。
import { boot, seedProfileViaUi, sleep } from './lib.mjs';

const PATTERN = 'http://127.0.0.1:8787/*';
const api = await boot();
try {
  const readProfiles = () =>
    api.extEval(`chrome.storage.local.get('jinyi:settings').then(o => JSON.stringify(o['jinyi:settings']?.profiles ?? []))`);
  let profiles = JSON.parse(await readProfiles());
  console.log(
    '现有档案:',
    profiles.map((p) => `${p.label}|${p.baseUrl}|models=${p.models.join(',')}|key=${(p.apiKey ?? '').length}`).join(' / ') || '（无）',
  );
  if (profiles.length === 0) {
    const r = await seedProfileViaUi(api);
    console.log('建档:', JSON.stringify({ status: r.status, error: r.error }));
    profiles = JSON.parse(await readProfiles());
  }

  if (!(await api.extEval(`chrome.permissions.contains({ origins: [${JSON.stringify(PATTERN)}] })`))) {
    const tab = await api.cdp.openTab(`chrome-extension://${api.id}/options/options.html`);
    await sleep(1200);
    const pos = await api.cdp.eval(
      tab.sessionId,
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const trigger = document.querySelector('.profile-row [data-action="toggle"]');
        if (!trigger) return JSON.stringify({ error: '没有可展开的档案行' });
        trigger.click();
        await wait(400);
        const ed = [...document.querySelectorAll('.profile-editor')].pop();
        const save = ed?.querySelector('[data-action="save-profile"]');
        if (!save) return JSON.stringify({ error: '没有保存按钮' });
        const rect = save.getBoundingClientRect();
        return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
      })()`,
    );
    const p = JSON.parse(pos);
    if (p.error) throw new Error(p.error);
    await api.cdp.mouse(tab.sessionId, 'mousePressed', p.x, p.y);
    await api.cdp.mouse(tab.sessionId, 'mouseReleased', p.x, p.y);
    console.log('>>> 已点「保存」，请在 Chrome 窗口里点「允许」（最多等 3 分钟）');
    for (let i = 0; i < 90; i += 1) {
      if (await api.extEval(`chrome.permissions.contains({ origins: [${JSON.stringify(PATTERN)}] })`)) {
        console.log(`第 ${i} 次轮询：授权已生效`);
        break;
      }
      await sleep(2000);
    }
  }
  console.log('授权:', await api.extEval(`chrome.permissions.contains({ origins: [${JSON.stringify(PATTERN)}] })`));

  const popup = await api.cdp.openTab(`chrome-extension://${api.id}/popup/popup.html`);
  await sleep(1400);
  const before = await api.extEval(`chrome.storage.local.get('jinyi:settings').then(o => o['jinyi:settings']?.engineId ?? '')`);
  const popupInfo = await api.cdp.eval(
    popup.sessionId,
    `(() => {
      const sels = [...document.querySelectorAll('select')];
      const sel = sels.find(s => [...s.options].some(o => /QA Mock/.test(o.textContent)));
      if (!sel) return JSON.stringify({ error: '弹窗里找不到引擎下拉', selects: sels.length, text: document.body.innerText.replace(/\\s+/g,' ').slice(0,160) });
      const opt = [...sel.options].find(o => /QA Mock/.test(o.textContent));
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return JSON.stringify({ optionText: opt.textContent.trim(), optionValue: opt.value, allOptions: [...sel.options].map(o => o.textContent.trim()) });
    })()`,
  );
  console.log('弹窗选择:', popupInfo);
  await sleep(900);
  const after = await api.extEval(`chrome.storage.local.get('jinyi:settings').then(o => o['jinyi:settings']?.engineId ?? '')`);
  console.log(`engineId: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  console.log('准备完毕，正在干净退出 Chrome 以落盘授权…');
} finally {
  await api.close();
}
