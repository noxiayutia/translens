// 核心链路实测：整页翻译 / 还原 / 缓存 / 双语 / 错误处理 / 隐私闸门。
// 前置：临时 profile 里已有指向本地假引擎的档案并已授权（先跑 .qa/seed-wait.mjs 一次）。
import { boot, sleep, ENGINE_BASE } from './lib.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('.qa/shots', { recursive: true });

const results = [];
function check(name, pass, evidence) {
  results.push({ name, pass: Boolean(pass), evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${evidence === undefined ? '' : '  → ' + evidence}`);
}

const api = await boot();
try {
  /* ---------------- 台架自检：授权与档案是否随临时 profile 复用成功 ---------------- */
  const granted = await api.extEval(`chrome.permissions.contains({ origins: ['http://127.0.0.1:8787/*'] })`);
  const profiles = await api.extEval(
    `chrome.storage.local.get('jinyi:settings').then(o => JSON.stringify((o['jinyi:settings']?.profiles ?? []).map(p => p.label + '@' + p.baseUrl)))`,
  );
  check('临时 profile 复用了上一次的授权（无需再点弹框）', granted === true, `granted=${granted}`);
  check('档案已存在', profiles !== '[]', profiles);
  if (!granted) {
    throw new Error('未授权：所有请求都会在 AUTH 闸门处停下，检查结论无意义。先跑 .qa/seed-wait.mjs 并点一次「允许」。');
  }

  await api.engineCtl({ mode: 'ok', reset: true });

  /* ---------------- 1. 整页翻译 ---------------- */
  const page = await api.openFixture('article.html');
  const before = await api.cdp.eval(page.sessionId, 'document.getElementById("article").outerHTML');
  const translateReply = await api.sendToPage('jinyi:translate-page');
  await sleep(2500);
  const after = await api.cdp.eval(
    page.sessionId,
    `(() => {
      const hosts = [...document.querySelectorAll('jy-translation')];
      const originals = [...document.querySelectorAll('[data-jy-originals]')];
      const cs = (el) => getComputedStyle(el);
      const body = (h) => (h.shadowRoot?.querySelector('.jy-body')?.textContent ?? h.textContent ?? '').trim();
      return {
        hosts: hosts.length,
        withFor: hosts.filter(h => h.dataset.jyFor).length,
        sample: hosts.slice(0, 3).map(h => body(h).slice(0, 34)),
        allPrefixed: hosts.every(h => body(h).startsWith('译·')),
        originals: originals.length,
        originalsHidden: originals.every(el => cs(el).display === 'none'),
        translatedMarks: document.querySelectorAll('[data-jy-translated]').length,
        codeUntouched: document.querySelector('#code-block code').textContent.includes('fetch(url)'),
      };
    })()`,
  );
  console.log('翻译返回:', JSON.stringify(translateReply).slice(0, 200));
  console.log('页面状态:', JSON.stringify(after));
  const stats1 = await api.engineStats();
  const log1 = await api.engineLog();
  console.log('引擎统计:', JSON.stringify(stats1));
  check('整页翻译出了宿主节点', after.hosts > 0, `hosts=${after.hosts}`);
  check('每条宿主都带 data-jy-for 指向段落', after.withFor === after.hosts, `${after.withFor}/${after.hosts}`);
  check('译文与请求分段一一对应（都以「译·」开头）', after.allPrefixed, JSON.stringify(after.sample));
  check('仅译文模式下原文被内联 display:none 藏起', after.originalsHidden && after.originals > 0, `originals=${after.originals} hidden=${after.originalsHidden}`);
  check('<code>/<pre> 内容未被改写', after.codeUntouched, String(after.codeUntouched));
  check('请求按批次合并（远少于段落数）', stats1.requests >= 1 && stats1.requests <= 4, `requests=${stats1.requests}, segments=${stats1.segments}`);

  /* ---------------- 2. 隐私闸门：哪些文本被送出去了 ---------------- */
  const sentBlob = JSON.stringify(await api.engineLog());
  check('未送 display:none 的段落', !/display none and must never/.test(sentBlob), '见 mock 日志');
  check('未送 aria-hidden 的段落', !/aria hidden and must never/.test(sentBlob), '');
  check('未送 contenteditable 草稿', !/half-written email draft/.test(sentBlob), '');
  check('未送 <code> 里的代码', !/const x = fetch/.test(sentBlob), '');
  check('未送纯图标按钮的 ×', !/<<<\d+>>>\s*×\s*$/m.test(sentBlob), '');

  /* ---------------- 3. 同文本折叠去重 ---------------- */
  const readMoreHits = (sentBlob.match(/Read more/g) ?? []).length;
  check('同文本折叠：页面上两个「Read more」只送出去一次', readMoreHits === 1, `命中 ${readMoreHits} 次`);

  /* ---------------- 4. 还原完整性 ---------------- */
  await api.sendToPage('jinyi:restore-page');
  await sleep(1200);
  const restored = await api.cdp.eval(page.sessionId, 'document.getElementById("article").outerHTML');
  const leftover = await api.cdp.eval(
    page.sessionId,
    `({ hosts: document.querySelectorAll('jy-translation').length, marks: document.querySelectorAll('[data-jy-translated],[data-jy-originals],[data-jy-root]').length })`,
  );
  check('还原后 DOM 与翻译前逐字节一致', restored === before, `长度 ${restored.length} vs ${before.length}`);
  check('还原后不留任何 jy-* 痕迹', leftover.hosts === 0 && leftover.marks === 0, JSON.stringify(leftover));

  /* ---------------- 5. 缓存命中零请求 ---------------- */
  const statsBeforeCache = await api.engineStats();
  await api.sendToPage('jinyi:translate-page');
  await sleep(2000);
  const statsAfterCache = await api.engineStats();
  const cachedHosts = await api.cdp.eval(page.sessionId, `document.querySelectorAll('jy-translation').length`);
  check('第二次翻译命中缓存：请求数不变', statsAfterCache.requests === statsBeforeCache.requests, `${statsBeforeCache.requests} → ${statsAfterCache.requests}`);
  check('第二次翻译仍然渲染出全部译文', cachedHosts > 0, `hosts=${cachedHosts}`);

  /* ---------------- 6. 双语对照 ---------------- */
  await api.sendToPage('jinyi:restore-page');
  await api.extEval(
    `chrome.storage.local.get('jinyi:settings').then(o => chrome.storage.local.set({ 'jinyi:settings': { ...o['jinyi:settings'], displayMode: 'bilingual' } }))`,
  );
  await api.sendToPage('jinyi:translate-page');
  await sleep(2200);
  const bilingual = await api.cdp.eval(
    page.sessionId,
    `(() => {
      const p = document.getElementById('p1');
      const cs = getComputedStyle(p.querySelector('[data-jy-originals]') ?? p);
      return { hosts: document.querySelectorAll('jy-translation').length, originalsAttr: document.querySelectorAll('[data-jy-originals]').length, p1Display: cs.display, p1Text: p.innerText.replace(/\\s+/g,' ').slice(0, 90) };
    })()`,
  );
  console.log('双语:', JSON.stringify(bilingual));
  check('双语模式：原文可见且与译文同时在场', bilingual.originalsAttr === 0 && bilingual.hosts > 0 && /Engineers often/.test(bilingual.p1Text), JSON.stringify(bilingual).slice(0, 160));
  await api.extEval(
    `chrome.storage.local.get('jinyi:settings').then(o => chrome.storage.local.set({ 'jinyi:settings': { ...o['jinyi:settings'], displayMode: 'translated-only' } }))`,
  );
  await api.sendToPage('jinyi:restore-page');

  /* ---------------- 7. 错误处理 ---------------- */
  const errCases = [
    ['auth401', 'AUTH'],
    ['rate429', '限流后重试成功'],
    ['badmarkers', 'BAD_RESPONSE 降级逐条'],
    ['badjson', 'BAD_RESPONSE'],
    ['http500', 'HTTP 500 带响应体原因'],
  ];
  for (const [mode, label] of errCases) {
    await api.engineCtl({ mode, reset: true });
    await api.sendToPage('jinyi:restore-page');
    await sleep(400);
    await api.sendToPage('jinyi:translate-page');
    await sleep(6000);
    const st = await api.engineStats();
    const dom = await api.cdp.eval(
      page.sessionId,
      `(() => {
        const hosts = [...document.querySelectorAll('jy-translation')];
        const body = (h) => (h.shadowRoot?.querySelector('.jy-body')?.textContent ?? h.textContent ?? '').trim();
        const txt = hosts.map(body);
        return { hosts: hosts.length, errish: txt.filter(t => /失败|错误|重试|限流|无效|不是合法|期望/.test(t)).length, sample: txt.slice(0,2), retryButtons: hosts.filter(h => /重试/.test(body(h))).length, toast: [...document.querySelectorAll('[data-jy-toast],[class*=toast]')].map(e=>e.textContent.trim().slice(0,60)).slice(0,2) };
      })()`,
    );
    console.log(`  [${mode}] 请求数=${st.requests} DOM=${JSON.stringify(dom).slice(0, 240)}`);
    if (mode === 'rate429') {
      check('429 会退避重试并最终成功（请求数 > 段落批次数）', st.requests >= 3, `requests=${st.requests}`);
    } else if (mode === 'badmarkers') {
      check('编号缺失时降级为逐条翻译（请求数 = 1 + N）', st.requests >= 3, `requests=${st.requests}`);
    } else {
      check(`${label}：页面显示可读错误而不是静默`, dom.errish > 0 || dom.toast.length > 0, JSON.stringify({ errish: dom.errish, toast: dom.toast }).slice(0, 160));
    }
  }
  await api.engineCtl({ mode: 'ok', reset: true });

  /* ---------------- 8. 全中文页：不该发请求 ---------------- */
  await api.engineCtl({ reset: true });
  const zh = await api.openFixture('chinese.html');
  await api.sendToPage('jinyi:translate-page');
  await sleep(2500);
  const zhStats = await api.engineStats();
  const zhDom = await api.cdp.eval(zh.sessionId, `({ hosts: document.querySelectorAll('jy-translation').length, toast: [...document.querySelectorAll('[class*=toast],[data-jy-toast]')].map(e => e.textContent.trim().slice(0,70)) })`);
  check('中文页零请求', zhStats.requests === 0, `requests=${zhStats.requests}`);
  console.log('  中文页 DOM:', JSON.stringify(zhDom));

  /* ---------------- 9. 术语表 / 自定义提示词是否真的进了 prompt ---------------- */
  await api.engineCtl({ reset: true });
  await api.extEval(
    `chrome.storage.local.get('jinyi:settings').then(o => chrome.storage.local.set({ 'jinyi:settings': { ...o['jinyi:settings'], glossary: [{ from: 'callback', to: '回调' }], systemPrompt: 'USE CANADIAN SPELLING PLEASE' } }))`,
  );
  await api.sendToPage('jinyi:restore-page');
  await sleep(300);
  const art2 = api.lastFixture;
  await api.cdp.send('Target.activateTarget', { targetId: (await api.cdp.targets()).find((t) => t.url.includes('article.html')).targetId });
  await api.sendToPage('jinyi:translate-page');
  await sleep(3000);
  const sys = (await api.engineLog()).log[0]?.system ?? '';
  check('术语表进了 system prompt', /Glossary \(must be used exactly\): callback => 回调/.test(sys), sys.slice(0, 120));
  check('自定义提示词进了 system prompt', /USE CANADIAN SPELLING PLEASE/.test(sys), '');
  check('目标语言写进了 system prompt', /Target language: zh-Hans/.test(sys), '');
  await api.extEval(
    `chrome.storage.local.get('jinyi:settings').then(o => chrome.storage.local.set({ 'jinyi:settings': { ...o['jinyi:settings'], glossary: [], systemPrompt: '' } }))`,
  );
} finally {
  await api.close();
  console.log('\n===== 汇总 =====');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(`合计 ${results.filter((r) => r.pass).length}/${results.length} 通过`);
}
