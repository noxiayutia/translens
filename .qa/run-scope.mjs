// 1) 量化「正文之外的骨架被翻译」的比例；2) 追 w3schools 上 </tr> <col> 这类标签名文本的来源。
import { boot, sleep } from './lib.mjs';
import { writeFileSync } from 'node:fs';

const SITES = [
  ['arxiv-论文页', 'https://arxiv.org/abs/2303.08774'],
  ['theverge-首页', 'https://www.theverge.com/'],
  ['w3schools-表格', 'https://www.w3schools.com/html/html_tables.asp'],
  ['mdn-css-grid', 'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout'],
  ['react.dev', 'https://react.dev/learn/your-first-component'],
];

const SCOPE = `(() => {
  const hosts = [...document.querySelectorAll('jy-translation')];
  const inMain = hosts.filter((h) => h.closest('main, article, [role="main"]')).length;
  const tagOf = (h) => { const p = h.closest('[data-jy-for]'); return p ? p.tagName.toLowerCase() : '?'; };
  const byTag = {};
  for (const h of hosts) { const t = tagOf(h); byTag[t] = (byTag[t] ?? 0) + 1; }
  const outside = hosts.filter((h) => !h.closest('main, article, [role="main"]'))
    .map((h) => (h.closest('[data-jy-for]')?.innerText ?? '').trim().slice(0, 40)).filter(Boolean);
  return { total: hosts.length, inMain, outsideSample: [...new Set(outside)].slice(0, 25), byTag };
})()`;

const api = await boot();
const report = [];
try {
  for (const [name, url] of SITES) {
    const t = await api.cdp.openTab(url);
    await api.activate(t.targetId);
    for (let i = 0; i < 40; i += 1) {
      const ready = await api.cdp.eval(t.sessionId, `({ rs: document.readyState, href: location.href })`).catch(() => null);
      if (ready && ready.rs === 'complete' && ready.href.startsWith('http')) break;
      await sleep(700);
    }
    await sleep(2000);
    await api.extEval(`(async () => { for (const area of [chrome.storage.local, chrome.storage.session]) {
      const all = await area.get(null); const keys = Object.keys(all).filter((k) => k.startsWith('jt:'));
      if (keys.length) await area.remove(keys); } })()`);
    await api.engineCtl({ mode: 'ok', reset: true });
    await api.extEval(`(async () => { const hit = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      return await chrome.tabs.sendMessage(hit.id, { type: 'jinyi:translate-page' }); })()`);
    await sleep(9000);
    const scope = await api.cdp.eval(t.sessionId, SCOPE);
    const eng = await api.engineStats();
    const sent = (await api.engineLog()).log.flatMap((e) => e.user.split(/<<<\d+>>>/g).slice(1).map((s) => s.trim()));
    const tagNames = sent.filter((s) => /^<\/?[a-zA-Z][^>\s]{0,14}\/?>$/.test(s));
    const provenance = tagNames.length
      ? await api.cdp.eval(
          t.sessionId,
          `(() => { const want = new Set(${JSON.stringify(tagNames.slice(0, 6))});
            const out = [];
            const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let n;
            while ((n = walk.nextNode()) && out.length < 8) {
              const v = n.nodeValue.trim();
              if (!want.has(v)) continue;
              const chain = []; let el = n.parentElement;
              for (let i = 0; i < 5 && el; i += 1) { chain.push(el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/)[0] : '')); el = el.parentElement; }
              out.push({ text: v, chain: chain.join(' < ') });
            }
            return out; })()`,
        )
      : [];
    report.push({ name, ...scope, requests: eng.requests, segments: eng.segments, tagNames, provenance });
    console.log(
      `${name}: 宿主 ${scope.inMain}/${scope.total} 在正文容器内（正文外 ${scope.total - scope.inMain}） 请求=${eng.requests} 段=${eng.segments} 标签名段=${JSON.stringify(tagNames)}`,
    );
    await api.closeTab(t.targetId);
  }
  writeFileSync('.qa/out-scope.json', JSON.stringify(report, null, 1));
  for (const r of report) {
    console.log('\n### ' + r.name + '  正文外样本:', JSON.stringify(r.outsideSample).slice(0, 500));
    if (r.provenance.length) console.log('    标签名来源:', JSON.stringify(r.provenance, null, 0).slice(0, 700));
  }
} finally {
  await api.close();
}
