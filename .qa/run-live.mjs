// 增量翻译与观察者行为实测。
import { boot, sleep } from './lib.mjs';

const results = [];
const check = (name, pass, evidence) => {
  results.push({ name, pass: Boolean(pass) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${evidence ? '  → ' + evidence : ''}`);
};

const api = await boot();
try {
  await api.engineCtl({ mode: 'ok', reset: true });

  /* ---------- 1. 页面级 toast：整批同码错误要弹提示，且要说人话 ---------- */
  const page = await api.openFixture('article.html');
  await api.engineCtl({ mode: 'auth401' });
  await api.extEval(
    `chrome.storage.local.get('jinyi:settings').then(o => chrome.storage.local.set({ 'jinyi:settings': { ...o['jinyi:settings'], systemPrompt: 'TOAST-${Date.now()}' } }))`,
  );
  await api.sendToPage('jinyi:translate-page');
  let toast = null;
  for (let i = 0; i < 40; i += 1) {
    toast = await api.cdp.eval(page.sessionId, `document.querySelector('#jy-toast')?.innerText.replace(/\\s+/g,' ').trim() ?? null`);
    if (toast) break;
    await sleep(250);
  }
  check('整批 AUTH 失败会弹页面级 toast', Boolean(toast), JSON.stringify(toast));
  check('toast 文案指路到设置页填 Key', /扩展设置里填好 API Key/.test(toast ?? ''), '');
  await api.engineCtl({ mode: 'ok', reset: true });
  await api.sendToPage('jinyi:restore-page');
  await sleep(400);

  /* ---------- 2. 未翻译时改动 DOM：一个请求都不该发 ---------- */
  const idle0 = await api.engineStats();
  await api.cdp.eval(page.sessionId, `window.__appendCard(4)`);
  await sleep(2500);
  const idle1 = await api.engineStats();
  const idleHosts = await api.cdp.eval(page.sessionId, `document.querySelectorAll('.injected jy-translation').length`);
  check('未翻译状态下新增内容零请求', idle1.requests === idle0.requests, `${idle0.requests} → ${idle1.requests}`);
  check('未翻译状态下新增内容不自动出译文', idleHosts === 0, `hosts=${idleHosts}`);

  /* ---------- 3. 整页翻译后，新滚出来的内容也会被翻 ---------- */
  await api.sendToPage('jinyi:translate-page');
  await sleep(4000);
  const base = await api.engineStats();
  const beforeHosts = await api.cdp.eval(page.sessionId, `document.querySelectorAll('jy-translation').length`);
  await api.cdp.eval(page.sessionId, `window.__appendCard(3)`);
  await sleep(3000);
  const after = await api.engineStats();
  const inc = await api.cdp.eval(
    page.sessionId,
    `(() => {
      const cards = [...document.querySelectorAll('.injected')];
      const body = (h) => (h.shadowRoot?.querySelector('.jy-body')?.textContent ?? '').trim();
      return {
        cards: cards.length,
        translated: cards.filter(c => c.querySelector('jy-translation')).length,
        samples: cards.slice(0, 2).map(c => body(c.querySelector('jy-translation'))),
      };
    })()`,
  );
  check('增量：新注入的 3 张卡片都出了译文', inc.translated >= 3, JSON.stringify(inc));
  check('增量：确实重新发了请求', after.requests > base.requests, `${base.requests} → ${after.requests}`);
  const reSent = after.segments - base.segments;
  check('增量：只翻新增的段落，没把整页重发一遍', reSent <= 5, `新增段数=${reSent}`);

  /* ---------- 4. 已译好的段落被追加文字：不重译、也不多出第二个宿主 ---------- */
  const before4 = await api.engineStats();
  await api.cdp.eval(page.sessionId, `document.getElementById('p2').append(' newly appended tail text')`);
  await sleep(2500);
  const after4 = await api.engineStats();
  const p2hosts = await api.cdp.eval(page.sessionId, `document.querySelectorAll('#p2 jy-translation').length`);
  check('改动已译段落不会重译（按范围约定交给还原重译）', after4.requests === before4.requests, `${before4.requests} → ${after4.requests}`);
  check('改动已译段落不会冒出第二个译文宿主', p2hosts === 1, `hosts=${p2hosts}`);

  /* ---------- 5. 本来就在 DOM 里、靠切 class 展开的菜单 ---------- */
  const before5 = await api.engineStats();
  await api.cdp.eval(page.sessionId, `window.__revealHidden()`);
  await sleep(2500);
  const after5 = await api.engineStats();
  const menu = await api.cdp.eval(
    page.sessionId,
    `(() => { const h = document.querySelector('#menu jy-translation'); return { has: Boolean(h), text: h ? (h.shadowRoot?.querySelector('.jy-body')?.textContent ?? '').trim() : null }; })()`,
  );
  check('隐藏节点变可见后会被补译', menu.has, JSON.stringify(menu));
  console.log('   （展开菜单带来的请求增量：', `${before5.requests} → ${after5.requests}）`);

  /* ---------- 6. 还原之后观察者断开：再滚新内容不再翻译 ---------- */
  await api.sendToPage('jinyi:restore-page');
  await sleep(600);
  const before6 = await api.engineStats();
  await api.cdp.eval(page.sessionId, `window.__appendCard(2)`);
  await sleep(2500);
  const after6 = await api.engineStats();
  const postRestore = await api.cdp.eval(page.sessionId, `document.querySelectorAll('.injected jy-translation').length`);
  check('还原后新增内容零请求（观察者已断开）', after6.requests === before6.requests, `${before6.requests} → ${after6.requests}`);
  check('还原后新增内容不再自动出译文', postRestore === 0, `hosts=${postRestore}`);

  /* ---------- 7. 无限滚动的请求线性性（README 的验收点） ---------- */
  await api.sendToPage('jinyi:translate-page');
  await sleep(3500);
  const lin0 = await api.engineStats();
  for (let round = 0; round < 5; round += 1) {
    await api.cdp.eval(page.sessionId, `window.__appendCard(2)`);
    await sleep(1400);
  }
  const lin1 = await api.engineStats();
  check('连滚 5 轮 × 2 段：请求数与新增段落数成线性（不是每滚一次重扫整页）', lin1.requests - lin0.requests <= 8, `Δrequests=${lin1.requests - lin0.requests}, Δsegments=${lin1.segments - lin0.segments}`);
} finally {
  await api.close();
  console.log('\n===== 汇总 =====');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(`合计 ${results.filter((r) => r.pass).length}/${results.length} 通过`);
}
