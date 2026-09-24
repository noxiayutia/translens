// 一次性真机验证：在真实设置页上点「测试连接」打真实 MiMo，连点 N 次取通过率。
// 用完即删，不入库。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startChrome, loadUnpacked, Cdp, sleep, REPO } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ep = JSON.parse(readFileSync(join(here, 'endpoint.json'), 'utf8'));
const MIMO_ORIGIN = 'https://api.xiaomimimo.com/*';

execFileSync(process.execPath, [join(here, 'make-hostperm-dist.mjs')], { stdio: 'inherit' });

// 把 MiMo 的 origin 也挪进必选 host_permissions：可选权限要用户手势申请，台架里点不掉原生弹框。
const mpath = join(here, 'dist-perm', 'manifest.json');
const man = JSON.parse(readFileSync(mpath, 'utf8'));
man.host_permissions = [...new Set([...(man.host_permissions ?? []), MIMO_ORIGIN])];
man.optional_host_permissions = (man.optional_host_permissions ?? []).filter((p) => p !== MIMO_ORIGIN);
writeFileSync(mpath, JSON.stringify(man, null, 2) + '\n', 'utf8');

const { child, cdp } = await startChrome();
let exitCode = 0;
try {
  const id = await loadUnpacked(cdp, join(here, 'dist-perm'));
  const tab = await cdp.openTab(`chrome-extension://${id}/options/options.html`);
  await sleep(1500);

  const fill = await cdp.eval(
    tab.sessionId,
    `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      document.getElementById('add-profile').click();
      await wait(400);
      const ed = [...document.querySelectorAll('.profile-editor')].pop();
      if (!ed) return JSON.stringify({ error: '没有展开出编辑框' });
      const set = (sel, value) => {
        const el = ed.querySelector(sel);
        if (!el) return '缺控件 ' + sel;
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return null;
      };
      let err = set('.profile-label', 'QA MiMo') ?? set('.profile-base-url', ${JSON.stringify(ep.baseUrl)})
        ?? set('.profile-api-key', ${JSON.stringify(ep.key)});
      if (err) return JSON.stringify({ error: err });
      ed.querySelector('[data-action="add-model"]').click();
      await wait(250);
      err = set('.profile-model-new', ${JSON.stringify(ep.model)});
      if (err) return JSON.stringify({ error: err });
      ed.querySelector('[data-action="confirm-model"]').click();
      await wait(300);
      const save = ed.querySelector('[data-action="save-profile"]');
      const r = save.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`,
  );
  const info = JSON.parse(fill);
  if (info.error) throw new Error(info.error);
  await cdp.mouse(tab.sessionId, 'mousePressed', info.x, info.y);
  await cdp.mouse(tab.sessionId, 'mouseReleased', info.x, info.y);
  await sleep(1500);

  const perm = await cdp.eval(tab.sessionId, `chrome.permissions.contains({ origins: [${JSON.stringify(MIMO_ORIGIN)}] })`);
  console.log(`host 权限 ${MIMO_ORIGIN} = ${perm}`);

  let ok = 0;
  const lines = [];
  for (let i = 1; i <= 8; i += 1) {
    const pos = await cdp.eval(
      tab.sessionId,
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        let btn = document.querySelector('.profile-row .profile-editor [data-action="test-profile"]');
        if (!btn) {
          document.querySelector('.profile-row [data-action="toggle"]').click();
          await wait(400);
          btn = document.querySelector('.profile-row .profile-editor [data-action="test-profile"]');
        }
        if (!btn) return JSON.stringify({ error: '找不到测试连接按钮' });
        btn.scrollIntoView({ block: 'center' });
        await wait(120);
        const r = btn.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`,
    );
    const p = JSON.parse(pos);
    if (p.error) throw new Error(p.error);
    await cdp.mouse(tab.sessionId, 'mousePressed', p.x, p.y);
    await cdp.mouse(tab.sessionId, 'mouseReleased', p.x, p.y);

    for (let t = 0; t < 60; t += 1) {
      await sleep(500);
      const s = await cdp.eval(tab.sessionId, `document.getElementById('engine-status')?.textContent ?? ''`);
      if (/连接成功|连接失败/.test(s)) {
        lines.push(`  #${i} ${s.slice(0, 110)}`);
        if (s.startsWith('连接成功')) ok += 1;
        break;
      }
    }
  }
  console.log(`\n真机「测试连接」打真实 MiMo：${ok}/8 通过`);
  console.log(lines.join('\n'));
  if (ok < 8) exitCode = 1;
} finally {
  cdp.ws.close();
  await new Promise((r) => setTimeout(r, 300));
  child.kill();
  process.exit(exitCode);
}
