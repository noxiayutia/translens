// 建档 + 授权的深挖：点完「保存」后保持浏览器开着，打印页面状态，
// 并留出时间用桌面自动化看清 Chrome 的原生授权弹框。
import { boot, seedProfileViaUi, sleep } from './lib.mjs';

const api = await boot();
try {
  const r = await seedProfileViaUi(api);
  const tab = r.tab;
  console.log('建档:', JSON.stringify({ granted: r.granted, status: r.status, models: r.models, error: r.error }));

  console.log(
    '页面反馈:',
    JSON.stringify(
      await api.cdp.eval(
        tab.sessionId,
        `({
          statuses: [...document.querySelectorAll('.status,[class*=status],[role=status]')].map(e => e.className + ' :: ' + e.textContent.trim().slice(0,90)).slice(0,6),
          editorStillOpen: Boolean(document.querySelector('.profile-editor')),
          rows: [...document.querySelectorAll('.profile-row')].length,
          hints: [...document.querySelectorAll('.field .hint, .form-error')].map(e => e.textContent.trim().slice(0,80)).slice(0,6),
        })`,
      ),
    ),
  );
  const png = await api.cdp.screenshot(tab.sessionId);
  const { writeFileSync } = await import('node:fs');
  writeFileSync('.qa/shots/s0-options-after-save.png', png);
  console.log('截图已存 .qa/shots/s0-options-after-save.png', png.length, '字节');

  console.log('targets:');
  for (const t of await api.cdp.targets()) console.log('  ', `${t.type}|${(t.title ?? '').slice(0, 34)}|${t.url.slice(0, 60)}`);

  console.log('等 20 秒给桌面自动化看弹框……');
  await sleep(20000);
  console.log(
    '20 秒后:',
    JSON.stringify(
      await api.cdp.eval(
        tab.sessionId,
        `({ statuses: [...document.querySelectorAll('.status,[class*=status]')].map(e => e.textContent.trim().slice(0,90)).slice(0,4) })`,
      ),
    ),
  );
  console.log(
    '存储:',
    await api.extEval(`chrome.storage.local.get(null).then(o => JSON.stringify(Object.keys(o)))`),
  );
} finally {
  await api.close();
}
