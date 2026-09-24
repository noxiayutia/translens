// 页面级提示（toast）实测：文案、混合错误码择一优先级、不解析来自接口的 HTML、自动消失。
// 注意 toast 的文字在它的 shadow root 里，innerText 取不到——必须读 shadowRoot.textContent。
import { boot, sleep } from './lib.mjs';

const results = [];
const check = (name, pass, evidence) => {
  results.push({ name, pass: Boolean(pass) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${evidence ? '  → ' + evidence : ''}`);
};

const api = await boot();
const page = await api.openFixture('article.html');

const readToast = () =>
  api.cdp.eval(
    page.sessionId,
    `(() => { const t = document.querySelector('#jy-toast'); if (!t) return null;
      return { text: (t.shadowRoot?.textContent ?? t.textContent ?? '').trim(), hasImg: Boolean(t.querySelector?.('img')), htmlChildren: t.childElementCount }; })()`,
  );

async function freshTranslate({ mode, sequence } = {}) {
  await api.engineCtl({ reset: true, ...(mode ? { mode } : {}), ...(sequence ? { sequence } : {}) });
  await api.sendToPage('jinyi:restore-page');
  await sleep(500);
  await api.extEval(
    `chrome.storage.local.get('jinyi:settings').then(o => chrome.storage.local.set({ 'jinyi:settings': { ...o['jinyi:settings'], systemPrompt: 'T${Date.now()}${Math.random()}' } }))`,
  );
  await api.sendToPage('jinyi:translate-page');
  let seen = null;
  for (let i = 0; i < 45; i += 1) {
    const t = await readToast();
    if (t && t.text) {
      seen = t;
      break;
    }
    await sleep(200);
  }
  return seen;
}

try {
  const auth = await freshTranslate({ mode: 'auth401' });
  check('整批 AUTH 失败会弹页面级 toast', Boolean(auth), JSON.stringify(auth)?.slice(0, 120));
  check('AUTH toast 指路到设置页填 Key', /扩展设置里填好 API Key 后重新翻译此页/.test(auth?.text ?? ''), JSON.stringify(auth?.text ?? '').slice(0, 120));

  const gone = await (async () => {
    await sleep(4200);
    return readToast();
  })();
  check('toast 约 3.2 秒后自动消失', gone === null, JSON.stringify(gone));

  const limited = await freshTranslate({ sequence: [429, 429, 429, 429, 429, 429] });
  check('整批限流弹「接口限流」提示', /限流/.test(limited?.text ?? ''), JSON.stringify(limited?.text ?? '').slice(0, 120));

  const mixed = await freshTranslate({ sequence: [401, 500, 500, 500, 500, 500] });
  check(
    '一批缺 Key + 后续网络错误时，按优先级只弹 AUTH 那条',
    /API Key/.test(mixed?.text ?? '') && !/网络到不了|Model|HTTP 500/.test(mixed?.text ?? ''),
    JSON.stringify(mixed?.text ?? '').slice(0, 160),
  );

  const htmlish = await freshTranslate({ mode: 'htmlerror' });
  const seg = await api.cdp.eval(
    page.sessionId,
    `(() => { const h = document.querySelector('jy-translation'); const b = h?.shadowRoot?.querySelector('.jy-body');
      return { text: (b?.textContent ?? '').trim().slice(0, 120), imgInside: Boolean(b?.querySelector('img')) }; })()`,
  );
  check('服务商响应体里的 HTML 不会被解析成元素', seg.imgInside === false && /<img src=x/.test(seg.text), JSON.stringify(seg).slice(0, 180));
  check('这段原文也会出现在页面提示里（不静默）', Boolean(htmlish), JSON.stringify(htmlish?.text ?? '').slice(0, 120));

  await api.engineCtl({ mode: 'ok', reset: true });
  await api.sendToPage('jinyi:restore-page');
} finally {
  await api.close();
  console.log('\n===== 汇总 =====');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(`合计 ${results.filter((r) => r.pass).length}/${results.length} 通过`);
}
