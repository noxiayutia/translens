// 错误处理与降级实测。每个用例前换一个 systemPrompt —— 提示词是缓存键的一部分，
// 这样才拿得到「真的重新发请求」的现场（顺带把「改提示词会让同一段重翻一次」这条也验了）。
import { boot, sleep } from './lib.mjs';

const results = [];
function check(name, pass, evidence) {
  results.push({ name, pass: Boolean(pass) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${evidence ? '  → ' + evidence : ''}`);
}

const api = await boot();
const page = await api.openFixture('article.html');

const probe = () =>
  api.cdp.eval(
    page.sessionId,
    `(() => {
      const hosts = [...document.querySelectorAll('jy-translation')];
      const body = (h) => (h.shadowRoot?.querySelector('.jy-body')?.textContent ?? '').trim();
      const originals = [...document.querySelectorAll('[data-jy-originals]')];
      return {
        hosts: hosts.length,
        texts: hosts.map(body),
        errish: hosts.filter(h => /失败|错误|重试|限流|无效|不是合法|期望|Model|过长/.test(body(h))).length,
        retry: hosts.filter(h => h.shadowRoot?.querySelector('.jy-retry')).length,
        originalsVisible: originals.filter(el => getComputedStyle(el).display !== 'none').length,
        toast: document.querySelector('#jy-toast')?.innerText.replace(/\\s+/g,' ').trim().slice(0, 120) ?? null,
      };
    })()`,
  );

async function runCase(mode, { waitMs = 9000 } = {}) {
  await api.engineCtl({ mode, reset: true });
  await api.sendToPage('jinyi:restore-page');
  await sleep(400);
  await api.extEval(
    `chrome.storage.local.get('jinyi:settings').then(o => chrome.storage.local.set({ 'jinyi:settings': ` +
      `{ ...o['jinyi:settings'], systemPrompt: 'QA-${mode}-${Date.now()}' } }))`,
  );
  const t0 = Date.now();
  await api.sendToPage('jinyi:translate-page');
  await sleep(waitMs);
  const st = await api.engineStats();
  const dom = await probe();
  console.log(`\n[${mode}] 请求=${st.requests} 段=${st.segments} 用时=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('  错误段:', dom.errish, '带重试按钮:', dom.retry, '原文可见:', dom.originalsVisible, 'toast:', JSON.stringify(dom.toast));
  console.log('  首条文本:', JSON.stringify((dom.texts[1] ?? '').slice(0, 90)));
  return { st, dom };
}

try {
  /* AUTH：401 —— 该说清是 Key 的问题，且不该挂 200 个没用的重试按钮 */
  const auth = await runCase('auth401');
  check('401 真的发出了请求（不是被本地闸门拦下）', auth.st.requests >= 1, `requests=${auth.st.requests}`);
  check('401 每段都显示可读错误而非静默', auth.dom.errish === auth.dom.hosts && auth.dom.hosts > 0, `${auth.dom.errish}/${auth.dom.hosts}`);
  check('401 不挂重试按钮（重试多少次都是同一个结果）', auth.dom.retry === 0, `retry=${auth.dom.retry}`);
  check('401 时原文重新可见', auth.dom.originalsVisible > 0, `visible=${auth.dom.originalsVisible}`);
  check('401 有页面级 toast 指路', Boolean(auth.dom.toast), JSON.stringify(auth.dom.toast));

  /* 429：退避重试后成功 */
  const rate = await runCase('rate429', { waitMs: 14000 });
  check('429 触发退避重试（请求数明显多于批次数）', rate.st.requests >= 4, `requests=${rate.st.requests}`);
  check('429 重试后译文正常落地', rate.dom.errish === 0 && rate.dom.hosts > 0, `errish=${rate.dom.errish}`);

  /* 编号缺失 → 降级逐条 */
  const bad = await runCase('badmarkers', { waitMs: 16000 });
  check('编号错乱时降级为逐条翻译（请求数 ≥ 段数）', bad.st.requests >= 13, `requests=${bad.st.requests}`);
  check('降级后仍然全部译出', bad.dom.errish === 0 && bad.dom.hosts === 14, `hosts=${bad.dom.hosts} errish=${bad.dom.errish}`);

  /* 返回不是 JSON */
  const badjson = await runCase('badjson', { waitMs: 16000 });
  check('非 JSON 响应被报成可读错误', badjson.dom.errish > 0, `errish=${badjson.dom.errish}`);
  check('非 JSON 响应允许重试', badjson.dom.retry > 0, `retry=${badjson.dom.retry}`);

  /* HTTP 500：要把响应体里的原因带出来 */
  const e500 = await runCase('http500');
  check(
    'HTTP 500 把服务商写在响应体里的原因透传给用户（"Model Not Exist"）',
    e500.dom.texts.some((t) => /Model Not Exist/.test(t)),
    JSON.stringify((e500.dom.texts[1] ?? '').slice(0, 80)),
  );

  /* 413：应走二次切分而不是直接失败 */
  const tooLong = await runCase('tooLong413', { waitMs: 16000 });
  check('413 走句子级二次切分（请求数 > 批次数）', tooLong.st.requests >= 3, `requests=${tooLong.st.requests}`);

  /* 缓存键是否真的把提示词算进去 */
  await api.engineCtl({ mode: 'ok', reset: true });
  await api.extEval(
    `chrome.storage.local.get('jinyi:settings').then(o => chrome.storage.local.set({ 'jinyi:settings': { ...o['jinyi:settings'], systemPrompt: 'PROMPT-A' } }))`,
  );
  await api.sendToPage('jinyi:restore-page');
  await sleep(300);
  await api.sendToPage('jinyi:translate-page');
  await sleep(4000);
  const withA = await api.engineStats();
  await api.extEval(
    `chrome.storage.local.get('jinyi:settings').then(o => chrome.storage.local.set({ 'jinyi:settings': { ...o['jinyi:settings'], systemPrompt: 'PROMPT-B' } }))`,
  );
  await api.sendToPage('jinyi:restore-page');
  await sleep(300);
  await api.sendToPage('jinyi:translate-page');
  await sleep(4000);
  const withB = await api.engineStats();
  check('改提示词会让同一段重翻一次（提示词进缓存键）', withB.requests > withA.requests, `${withA.requests} → ${withB.requests}`);

  /* 术语表 / 提示词 / 目标语言是否真的进了 prompt */
  await api.engineCtl({ reset: true });
  await api.extEval(
    `chrome.storage.local.get('jinyi:settings').then(o => chrome.storage.local.set({ 'jinyi:settings': { ...o['jinyi:settings'], systemPrompt: 'GLOSSARY-MARKER-XYZ', glossary: [{ from: 'callback', to: '回调' }] } }))`,
  );
  await api.sendToPage('jinyi:restore-page');
  await sleep(300);
  await api.sendToPage('jinyi:translate-page');
  await sleep(4000);
  const sys = (await api.engineLog()).log[0]?.system ?? '';
  check('术语表进了 system prompt', /Glossary \(must be used exactly\): callback => 回调/.test(sys), sys.slice(0, 60) + '…');
  check('自定义提示词进了 system prompt', /GLOSSARY-MARKER-XYZ/.test(sys), '');
  check('目标语言进了 system prompt', /Target language: zh-Hans/.test(sys), '');
  const firstUser = (await api.engineLog()).log[0]?.user ?? '';
  check('请求带编号标记且模型/温度按实现所写', /<<<1>>>/.test(firstUser), '');
  const logEntry = (await api.engineLog()).log[0];
  check('温度固定为 0、模型名取自档案', logEntry?.temperature === 0 && logEntry?.model === 'mock-mini', `temperature=${logEntry?.temperature} model=${logEntry?.model}`);

  await api.extEval(
    `chrome.storage.local.get('jinyi:settings').then(o => chrome.storage.local.set({ 'jinyi:settings': { ...o['jinyi:settings'], systemPrompt: '', glossary: [] } }))`,
  );
} finally {
  await api.close();
  console.log('\n===== 汇总 =====');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(`合计 ${results.filter((r) => r.pass).length}/${results.length} 通过`);
}
