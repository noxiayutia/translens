// 多站点实测矩阵：每个站点走同一套流程（采集 → 翻译 → 读回 → 还原 → 比对），
// 并把假引擎收到的每一段原文都拿回来做「不该翻的东西」检测。
import { boot, sleep } from './lib.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('.qa/shots/pages', { recursive: true });
mkdirSync('.qa/sent', { recursive: true });

const SITES = [
  { name: 'cnn-lite', url: 'https://lite.cnn.com/', kind: '纯文本列表' },
  { name: 'theverge-长文', url: 'https://www.theverge.com/report/746123/', kind: '新闻长文+图注（404 则退回首页）' },
  { name: 'theverge-首页', url: 'https://www.theverge.com/', kind: '首页卡片流' },
  { name: 'mathsisfun-二次方程', url: 'https://www.mathsisfun.com/algebra/quadratic-equation.html', kind: '数学公式+例题' },
  { name: 'rust-book', url: 'https://doc.rust-lang.org/book/ch01-00-getting-started.html', kind: '文档+大量代码块' },
  { name: 'apple-docs', url: 'https://developer.apple.com/documentation/javascriptcore', kind: 'API 文档+符号列表' },
  { name: 'projecteuclid', url: 'https://projecteuclid.org/journals', kind: '数学论文目录' },
  { name: 'lobsters', url: 'https://lobste.rs/', kind: '链接密集+短条目' },
  { name: 'mdn-css-grid', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout', kind: '文档+大量代码' },
  { name: 'stackoverflow', url: 'https://stackoverflow.com/questions/11227809/convert-a-string-to-an-integer-in-java', kind: '问答+代码+投票按钮' },
  { name: 'overreacted', url: 'https://overreacted.io/how-are-function-definitions-different/', kind: '博客+行内代码' },
  { name: 'react.dev', url: 'https://react.dev/learn/your-first-component', kind: 'SPA 文档+侧栏' },
  { name: 'w3schools-表格', url: 'https://www.w3schools.com/html/html_tables.asp', kind: '表格+可运行示例' },
  { name: 'paulgraham', url: 'https://www.paulgraham.com/greatwork.html', kind: '古老布局、无语义标签' },
  { name: 'arxiv-论文页', url: 'https://arxiv.org/abs/2303.08774', kind: '摘要+作者+大量元数据' },
  { name: '日文夹具', url: 'http://127.0.0.1:8787/fixture/japanese.html', kind: '假名判定（目标中文）' },
  { name: '中文维基镜像·gnu', url: 'https://www.gnu.org/philosophy/free-sw.zh-cn.html', kind: '中文页，应零请求' },
  { name: '人民网', url: 'http://www.people.com.cn/', kind: '中文门户，应零请求' },
];

const looksLikeCode = (t) => /(=>|function |const |let |return |\bdef \w|import .* from|<\/?\w+>)/.test(t) && /[{}();]/.test(t);
const looksLikeUrl = (t) => /(https?:\/\/|www\.)\S{6,}/.test(t);
const looksLikePureNumber = (t) => /^[\d\s.,:%$€£-]{1,24}$/.test(t.trim());
const looksLikeEmail = (t) => /[\w.+-]+@[\w-]+\.[\w.]{2,}/.test(t);

const api = await boot();
const rows = [];

const statsProbe = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const body = (h) => (h.shadowRoot?.querySelector('.jy-body')?.textContent ?? '').trim();
  const snap = () => ({
    hosts: document.querySelectorAll('jy-translation').length,
    pending: [...document.querySelectorAll('jy-translation')].filter(h => h.shadowRoot?.querySelector('.jy-pending')).length,
    errored: [...document.querySelectorAll('jy-translation')].filter(h => h.shadowRoot?.querySelector('.jy-error')).length,
    originals: document.querySelectorAll('[data-jy-originals]').length,
    marks: document.querySelectorAll('[data-jy-translated],[data-jy-root]').length,
    visibleParagraphs: [...document.querySelectorAll('p,li,h1,h2,h3,h4,td,th,figcaption,button')].filter(e => {
      const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return r.width > 2 && r.height > 2 && cs.display !== 'none' && cs.visibility !== 'hidden' && (e.innerText ?? '').trim().length > 2;
    }).length,
    textHash: (document.body.innerText ?? '').replace(/\\s+/g,' ').length,
  });
  return snap();
})()`;

for (const site of SITES) {
  const row = { site: site.name, kind: site.kind };
  try {
    const t = await api.cdp.openTab(site.url);
    await api.activate(t.targetId);
    // 等到文档真的换成目标地址且加载完毕——否则第一次求值会打在 about:blank 上，
    // 内容脚本还没注入，sendMessage 直接 "Receiving end does not exist"。
    for (let i = 0; i < 40; i += 1) {
      const ready = await api.cdp
        .eval(t.sessionId, `({ rs: document.readyState, href: location.href })`)
        .catch(() => null);
      if (ready && ready.rs === 'complete' && ready.href.startsWith('http')) break;
      await sleep(700);
    }
    await sleep(2500);
    row.title = String(await api.cdp.eval(t.sessionId, 'document.title').catch(() => '?')).slice(0, 60);

    const before = await api.cdp.eval(t.sessionId, statsProbe);
    row.visibleBefore = before.visibleParagraphs;
    const bodyBefore = await api.cdp.eval(t.sessionId, 'document.body.innerText.replace(/\\s+/g," ").length');

    // 每个站点前清一次翻译缓存（**两级都要清**：local 与 session，session 只在浏览器
    // 实例存活期间存在——常驻台架里它会把上一轮的结果全部兜住，请求数就永远是 0）。
    await api.extEval(`(async () => { const cleared = [];
      for (const area of [chrome.storage.local, chrome.storage.session]) {
        const all = await area.get(null);
        const keys = Object.keys(all).filter((k) => k.startsWith('jt:'));
        if (keys.length) await area.remove(keys);
        cleared.push(keys.length);
      }
      return cleared.join('/'); })()`);
    await api.engineCtl({ mode: 'ok', reset: true });
    await api.extEval(`(async () => { const hit = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]; return await chrome.tabs.sendMessage(hit.id, { type: 'jinyi:translate-page' }); })()`);

    let settled = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(1000);
      const s = await api.cdp.eval(t.sessionId, statsProbe);
      if (s.hosts > 0 && s.pending === 0 && s.errored === 0) { settled = { ...s, seconds: i + 1 }; break; }
      // 中文页这类"没有可译内容"的站点根本不会有宿主，别白等 40 秒
      if (i >= 6 && s.hosts === 0) { settled = { ...s, seconds: i + 1 }; break; }
      settled = { ...s, seconds: i + 1 };
    }
    const eng = await api.engineStats();
    const log = await api.engineLog();
    const sent = log.log.flatMap((e) => e.user.split(/<<<\d+>>>/g).slice(1).map((s) => s.trim()).filter(Boolean));

    row.hosts = settled.hosts;
    row.pendingAtEnd = settled.pending;
    row.erroredAtEnd = settled.errored;
    row.seconds = settled.seconds;
    row.requests = eng.requests;
    row.segmentsSent = eng.segments;
    row.charsSent = eng.chars;
    row.uniqueSent = new Set(sent).size;
    row.dupAcrossRequests = sent.length - new Set(sent).size;
    row.codeish = sent.filter(looksLikeCode).slice(0, 3);
    row.urls = sent.filter(looksLikeUrl).slice(0, 3);
    row.pureNumbers = sent.filter(looksLikePureNumber).slice(0, 5);
    row.emails = sent.filter(looksLikeEmail).slice(0, 3);
    row.longest = (sent.sort((a, b) => b.length - a.length)[0] ?? '').slice(0, 70);
    writeFileSync(`.qa/sent/${site.name}.txt`, sent.map((s, i) => `${i + 1}\t${s.length}\t${s.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n'));

    await api.cdp.screenshot(t.sessionId).then(async (png) => writeFileSync(`.qa/shots/pages/${site.name}.png`, png)).catch(() => {});

    await api.extEval(`(async () => { const hit = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]; return await chrome.tabs.sendMessage(hit.id, { type: 'jinyi:restore-page' }); })()`);
    await sleep(1500);
    const after = await api.cdp.eval(t.sessionId, statsProbe);
    row.leftoverMarks = after.marks;
    const bodyAfter = await api.cdp.eval(t.sessionId, 'document.body.innerText.replace(/\\s+/g," ").length');
    row.textRestored = Math.abs(bodyAfter - bodyBefore) <= 2;
    row.consoleErrors = api.cdp.consoleErrors().filter((e) => e.url && !/wikipedia|mdn|github/.test(e.url)).slice(0, 2).map((e) => e.text.slice(0, 80));
    await api.closeTab(t.targetId);
  } catch (e) {
    row.error = String(e.message).slice(0, 120);
  }
  rows.push(row);
  console.log(JSON.stringify(row));
}

writeFileSync('.qa/out-pages.json', JSON.stringify(rows, null, 1));
console.table(
  rows.map((r) => ({
    站点: r.site,
    可见段: r.visibleBefore,
    宿主: r.hosts,
    送出段: r.segmentsSent,
    去重后: r.uniqueSent,
    跨批重复: r.dupAcrossRequests,
    请求: r.requests,
    秒: r.seconds,
    残留: r.leftoverMarks,
    还原: r.textRestored === undefined ? '-' : r.textRestored ? 'ok' : 'DIFF',
    错误: r.error ?? (r.erroredAtEnd ? `${r.erroredAtEnd} 段失败` : ''),
  })),
);
