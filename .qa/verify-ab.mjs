// A/B 两步改动的真机复验（jsdom 证不了的那两半）。
// A：零面积盒判据在真布局下只杀 sr-only、不误杀真的绝对定位元素。
// B：缩放后的超时秒数（不是 60）真的出现在页面文案里。
import { boot, sleep } from './lib.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('.qa/shots', { recursive: true });
const api = await boot();
const fail = [];
try {
  /* ---------------- A ---------------- */
  await api.engineCtl({ mode: 'ok', reset: true });
  await api.extEval(`(async () => { for (const area of [chrome.storage.local, chrome.storage.session]) {
    const all = await area.get(null); const keys = Object.keys(all).filter((k) => k.startsWith('jt:'));
    if (keys.length) await area.remove(keys); } })()`);
  const page = await api.openFixture('sr-only.html');
  await api.fireToPage('jinyi:translate-page');
  await sleep(4000);
  const ids = ['skip-classic', 'skip-modern', 'legacy-indent', 'zero-font', 'visible-badge', 'half-clipped', 'control'];
  const per = await api.cdp.eval(
    page.sessionId,
    `(${JSON.stringify(ids)}.map((id) => ({ id, host: Boolean(document.getElementById(id).querySelector('jy-translation')) })))`,
  );
  const rects = await api.cdp.eval(
    page.sessionId,
    `(${JSON.stringify(ids)}.map((id) => { const r = document.getElementById(id).getBoundingClientRect();
      return { id, w: Math.round(r.width), h: Math.round(r.height) }; }))`,
  );
  const sent = (await api.engineLog()).log.flatMap((e) => e.user.split(/<<<\d+>>>/g).slice(1).map((s) => s.trim()));
  console.log('真机盒尺寸:', JSON.stringify(rects));
  console.log('插了宿主的元素:', JSON.stringify(per.filter((x) => x.host).map((x) => x.id)));
  console.log('实际送出的文本:', JSON.stringify(sent));
  for (const id of ['skip-classic', 'skip-modern', 'legacy-indent', 'zero-font']) {
    if (per.find((x) => x.id === id).host) fail.push(`A: ${id} 仍被翻译（该被挡掉）`);
  }
  for (const id of ['visible-badge', 'half-clipped', 'control']) {
    if (!per.find((x) => x.id === id).host) fail.push(`A: ${id} 被误杀（应当采集）`);
  }
  if (sent.some((s) => /Skip to main content|Screen reader only|image replacement|Zero font size/.test(s))) {
    fail.push('A: sr-only 文本仍出现在请求体里');
  }
  writeFileSync('.qa/shots/verify-A.png', await api.cdp.screenshot(page.sessionId));

  /* ---------------- B ---------------- */
  // 这一页只有 3 段、合计 116 字符 ⇒ 预算 = 60s + 116×100ms = 71.6s ⇒ 文案应写「72 秒」，
  // 而不是旧的固定「60 秒」。挂起模式下请求永不返回，只能由内容脚本的超时收敛。
  await api.engineCtl({ mode: 'slow', reset: true });
  await api.fireToPage('jinyi:restore-page');
  await sleep(600);
  await api.extEval(`(async () => { for (const area of [chrome.storage.local, chrome.storage.session]) {
    const all = await area.get(null); const keys = Object.keys(all).filter((k) => k.startsWith('jt:'));
    if (keys.length) await area.remove(keys); } })()`);
  await api.fireToPage('jinyi:translate-page');
  await sleep(63000);
  const atSixty = await api.cdp.eval(page.sessionId, `[...document.querySelectorAll('jy-translation')].map(h => (h.shadowRoot?.querySelector('.jy-body')?.textContent ?? '').trim()).slice(0,2)`);
  await sleep(14000);
  const after = await api.cdp.eval(page.sessionId, `[...document.querySelectorAll('jy-translation')].map(h => (h.shadowRoot?.querySelector('.jy-body')?.textContent ?? '').trim()).slice(0,2)`);
  console.log('63 秒时文案:', JSON.stringify(atSixty));
  console.log('77 秒时文案:', JSON.stringify(after));
  const text = after.join(' ');
  if (!/72 秒没有响应/.test(text)) fail.push(`B: 文案没出现「72 秒没有响应」，实际是「${text.slice(0, 60)}」`);
  if (/60 秒没有响应/.test(text)) fail.push('B: 文案里还是写死的 60 秒');
  writeFileSync('.qa/shots/verify-B.png', await api.cdp.screenshot(page.sessionId));
  await api.engineCtl({ mode: 'ok', reset: true });
} finally {
  await api.close();
  console.log(fail.length ? 'FAIL\n' + fail.join('\n') : 'PASS  A/B 真机复验全部符合预期');
}
