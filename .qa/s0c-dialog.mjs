// 判断「点保存之后到底发生了什么」：原生授权弹框是否把页面挡住了？顺带用干净退出
// 把 Preferences 落盘，看清 Chrome 把 unpacked 扩展与已授权 host 记在哪。
import { boot, seedProfileViaUi, sleep } from './lib.mjs';
import { PROFILE_DIR } from './harness.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const api = await boot();
let tab;
try {
  const r = await seedProfileViaUi(api);
  tab = r.tab;
  console.log('保存点击后:', JSON.stringify({ granted: r.granted, status: r.status }));

  // 试着点「取消」：若原生弹框正挡着窗口，这一刀不会有反应（编辑器仍在）。
  const cancel = await api.cdp.eval(
    tab.sessionId,
    `(async () => {
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const ed = [...document.querySelectorAll('.profile-editor')].pop();
      const btn = ed?.querySelector('[data-action="cancel-profile"]');
      if (!btn) return '没有取消按钮';
      const rect = btn.getBoundingClientRect();
      return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    })()`,
  );
  const { x, y } = JSON.parse(cancel);
  await api.cdp.mouse(tab.sessionId, 'mousePressed', x, y);
  await api.cdp.mouse(tab.sessionId, 'mouseReleased', x, y);
  await sleep(800);
  console.log(
    '点取消后:',
    JSON.stringify(
      await api.cdp.eval(
        tab.sessionId,
        `({ editorOpen: Boolean(document.querySelector('.profile-editor')), rows: document.querySelectorAll('.profile-row').length })`,
      ),
    ),
  );
} finally {
  await api.cdp.send('Browser.close').catch(() => {});
  await sleep(2500);
  await api.child.kill().catch(() => {});
  await api.mock.kill().catch(() => {});
}

for (const name of ['Preferences', 'Secure Preferences']) {
  const p = join(PROFILE_DIR, 'Default', name);
  if (!existsSync(p)) {
    console.log(`${name}: 不存在`);
    continue;
  }
  const j = JSON.parse(readFileSync(p, 'utf8'));
  const settings = j.extensions?.settings ?? {};
  console.log(`${name}: 扩展条目 ${Object.keys(settings).length} 个`);
  for (const [id, e] of Object.entries(settings)) {
    console.log('  ', id, e.path, 'state=' + e.state, 'active=' + JSON.stringify(e.active_permissions));
    console.log('     want=' + JSON.stringify(e.want_permissions), 'grp=' + JSON.stringify(e.granted_permissions));
  }
  console.log('  permissions.request_settings=' + JSON.stringify(j.permissions?.request_settings ?? null).slice(0, 400));
}
