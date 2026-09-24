// 送出底稿的离线分拣：把 2026-09-23 那轮多站点扫描**实际送出去**的每一段按机械判据归类，
// 量出"不该送出去的段"到底占多少段数、多少字符。
//
// 零额度、零网络、不开 Chrome：原料是 `.qa/sent/*.txt`（该目录不入库，是本机产物）。
// 之所以先量这个再谈改提取：报告里"token 消耗可能是沉浸式翻译的 20~50 倍"那句是估的，
// 而这里能给出可核对的数。
//
// 用法：node .qa/analyze-sent.mjs [--examples=4] [--dir=sent]
// `--dir=sent-baseline` 读改前的底稿（`run-pages.mjs` 会把 `.qa/sent` 覆盖成改后的），
// 两份对比才是"闸真的生效了吗"的证据——只看一份都是在信自己的分类器。
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argOf = (name, dflt) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${dflt}`).split('=')[1];
const DIR = argOf('dir', 'sent');
const SENT = join(HERE, DIR);
const OUT = join(HERE, `out-analyze-${DIR}.txt`);
const EXAMPLES = Number(argOf('examples', '4'));

if (!existsSync(SENT)) {
  console.error(`没有底稿目录 ${SENT}（它是本机产物、不入库；先跑 node .qa/run-pages.mjs）`);
  process.exit(1);
}

/**
 * 报告 `docs/qa/2026-09-23-multi-site-report.md:21-37` 的「送出段」列（逐行照抄，不凭记忆）。
 * 那一份数来自另一条测量链路（真机页面上的宿主与请求日志），这里拿它做**外部对账**：
 * 底稿解析出的记录数必须与它一致，否则要么底稿漏行、要么解析错位。
 * 底稿文件名与报告行名不是一套（`cnn-lite.txt` 装的是报告里 `lite.cnn` 那一行，
 * 而 `lite.cnn.txt` 是 0 字节的空底稿），映射按内容对。
 */
const REPORTED = {
  'cnn-lite': 105,
  'theverge-长文': 38,
  'theverge-首页': 258,
  'mathsisfun-二次方程': 145,
  'rust-book': 115,
  'apple-docs': 132,
  'lobsters': 72,
  'mdn-css-grid': 477,
  'stackoverflow': 723,
  'overreacted': 7,
  'react.dev': 110,
  'w3schools-表格': 265,
  'paulgraham': 236,
  'arxiv-论文页': 72,
  '日文夹具': 4,
  '中文维基镜像·gnu': 7,
  '人民网': 3,
};

/**
 * 判据只允许用**机械可核对**的形状事实（整段是不是一个标签、一个 URL、有没有空格…）。
 * 语义判断（"这是导航标签"）一律标成"候选"，不当结论用。
 * 顺序即优先级：每条段恰好落进一类，最后兜底 prose。
 */
const RULES = [
  ['empty', '整段空白', (t) => t.length === 0],
  ['symbol', '纯符号（无字母无数字）', (t) => !/[\p{L}\p{N}]/u.test(t)],
  ['short2', '≤2 字符', (t) => t.length <= 2],
  ['tag', '整段是一个 HTML/XML 标签', (t) => /^<\/?[a-zA-Z][\w-]*\s*\/?>$/.test(t)],
  ['url', '整段是一个 URL', (t) => /^(https?|ftp|mailto):\/\/\S+$/i.test(t)],
  ['email', '整段是一个邮箱地址', (t) => /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(t)],
  ['cssprop', '整段是 kebab 形式的属性名（含 `*-` 前缀）', (t) => /^(-ms-|-webkit-)?[a-z][a-z0-9]*(-[a-z0-9*]+)+\*?$/.test(t) && !/\s/.test(t)],
  ['timestamp', '整段是时间戳/日期行', (t) => /\b\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b[A-Z][a-z]{2},\s+\d{1,2}\s+[A-Z][a-z]{2}/.test(t) && t.length < 120],
  ['code', '整段含代码形状（括号调用、双下划线、大驼峰、命名空间）', (t) => /\w+\(|__|::|<\/|[a-z][A-Z][a-z]+/.test(t)],
  ['allcaps', '整段只有大写字母/数字（导航条、缩写串）', (t) => /^[A-Z0-9][A-Z0-9+#./&-]*([\s]+[A-Z0-9][A-Z0-9+#./&-]*)*$/.test(t) && !/[a-z]/.test(t)],
  ['navlabel', '候选：≤3 词且无句末标点（多为控件/导航标签，需人工确认）', (t) => t.split(/\s+/).length <= 3 && !/[.!?。！？,;:]/.test(t) && /[a-zA-Z\p{Script=Han}]/u.test(t)],
  ['prose', '正文（兜底类）', () => true],
];

const sites = [];
const problems = [];

for (const name of readdirSync(SENT).filter((f) => f.endsWith('.txt')).sort()) {
  const site = name.replace(/\.txt$/, '');
  const raw = readFileSync(join(SENT, name), 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const recs = [];
  lines.forEach((line, i) => {
    const m = /^(\d+)\t(\d+)\t([\s\S]*)$/.exec(line);
    if (!m) {
      problems.push(`${site} 第 ${i + 1} 行不合「序号⇥字符数⇥文本」格式：${JSON.stringify(line.slice(0, 60))}`);
      return;
    }
    const [, ord, lenStr, text] = m;
    const len = Number(lenStr);
    recs.push({ ord: Number(ord), len, text, 截断: len > text.length });
  });
  // 输入体检：序号必须连续递增，否则中间掉过行；字符数不小于文本长度，否则是解析错位而不是截断。
  recs.forEach((r, i) => {
    if (r.ord !== i + 1) problems.push(`${site} 第 ${i + 1} 条的序号是 ${r.ord}（序号不连续 ⇒ 底稿掉行或解析错位）`);
    if (r.len < r.text.length) problems.push(`${site} 第 ${r.ord} 条字符数 ${r.len} < 文本长度 ${r.text.length}（这不是截断，是解析错位）`);
  });
  const buckets = new Map(RULES.map(([k]) => [k, []]));
  for (const r of recs) {
    const trimmed = r.text.trim();
    const rule = RULES.find(([, , test]) => test(trimmed));
    buckets.get(rule[0]).push({ ...r, kind: rule[0] });
  }
  const totalChars = recs.reduce((a, r) => a + r.len, 0);
  const counted = [...buckets.values()].reduce((a, b) => a + b.length, 0);
  if (counted !== recs.length) problems.push(`${site} 分类器没有全覆盖：${counted} ≠ ${recs.length}`);
  sites.push({ site, recs, buckets, totalChars });
}

/* ---------- 外部对账：解析出的记录数 vs 报告里另一条链路的数 ----------
 * 只对**改前**那份底稿成立：报告表里的段数是加闸之前测的，改后的底稿本来就该少。
 */
let 对账红 = 0;
const 可比对账 = DIR === 'sent-baseline';
for (const s of sites) {
  if (!可比对账) break;
  const want = REPORTED[s.site];
  if (want === undefined) continue;
  if (want !== s.recs.length) {
    对账红 += 1;
    problems.push(`对账：${s.site} 底稿解析出 ${s.recs.length} 条，报告写 ${want} 条（差 ${s.recs.length - want}）`);
  }
}
const 空底稿 = sites.filter((s) => s.recs.length === 0).map((s) => s.site);

/* ---------- 汇总 ---------- */
const NOISE = new Set(['symbol', 'short2', 'tag', 'url', 'email', 'cssprop', 'timestamp', 'code', 'allcaps']);
const lines = [];
lines.push('送出底稿分拣明细（每类样本供人工推翻；判据见 .qa/analyze-sent.mjs 的 RULES）');
lines.push('');
const 全局 = new Map(RULES.map(([k]) => [k, { n: 0, chars: 0 }]));
for (const s of sites) {
  if (s.recs.length === 0) continue;
  lines.push(`### ${s.site}　${s.recs.length} 段 / ${s.totalChars} 字符`);
  for (const [key, label] of RULES) {
    const list = s.buckets.get(key);
    if (!list.length) continue;
    const chars = list.reduce((a, r) => a + r.len, 0);
    全局.get(key).n += list.length;
    全局.get(key).chars += chars;
    lines.push(`  ${String(list.length).padStart(4)} 段 ${String(chars).padStart(6)} 字 (${((chars / s.totalChars) * 100).toFixed(1)}%)  ${label}`);
    // 每一类都留样本，**包括兜底的 prose** —— 兜底类里混进了什么，正是这套判据最该被看见的地方。
    for (const r of list.slice(0, EXAMPLES)) {
      lines.push(`        ${r.len}字 ${JSON.stringify(r.text.slice(0, 90))}${r.截断 ? ' [底稿已截断]' : ''}`);
    }
  }
  lines.push('');
}
const 总段 = sites.reduce((a, s) => a + s.recs.length, 0);
const 总字 = sites.reduce((a, s) => a + s.totalChars, 0);
const 噪声段 = sites.reduce((a, s) => a + [...s.buckets].filter(([k]) => NOISE.has(k)).reduce((b, [, v]) => b + v.length, 0), 0);
const 噪声字 = sites.reduce((a, s) => a + [...s.buckets].filter(([k]) => NOISE.has(k)).reduce((b, [, v]) => b + v.reduce((c, r) => c + r.len, 0), 0), 0);
const 候选段 = sites.reduce((a, s) => a + s.buckets.get('navlabel').length, 0);
const 候选字 = sites.reduce((a, s) => a + s.buckets.get('navlabel').reduce((b, r) => b + r.len, 0), 0);
const 截断数 = sites.reduce((a, s) => a + s.recs.filter((r) => r.截断).length, 0);

lines.push('=== 总计 ===');
for (const [key, label] of RULES) {
  const g = 全局.get(key);
  if (!g.n) continue;
  lines.push(`${String(g.n).padStart(5)} 段 ${String(g.chars).padStart(8)} 字　${label}`);
}
lines.push('');
lines.push(`17 站合计 ${总段} 段 / ${总字} 字符`);
lines.push(`机械可判定的噪声（不含 navlabel 候选）：${噪声段} 段 = ${((噪声段 / 总段) * 100).toFixed(1)}% 段数，${噪声字} 字 = ${((噪声字 / 总字) * 100).toFixed(1)}% 字符`);
lines.push(`navlabel 候选（需人工确认，未计入上面）：${候选段} 段 / ${候选字} 字`);
lines.push(`底稿文本被截断的记录：${截断数} 条（成本按「字符数」那一列算，不按截断后的长度）`);
lines.push(空底稿.length ? `空底稿（本轮没抓到送出内容）：${空底稿.join(', ')}` : '空底稿：无');
lines.push(`外部对账（底稿解析数 vs 报告另一条链路）：${可比对账 ? (对账红 === 0 ? '逐站一致' : `${对账红} 站不一致`) : '不适用（改后底稿本来就该少）'}`);

/* ---------- 批次模拟：无关段省下来的到底是字符还是"批数" ----------
 * 成本不是按字符线性走的：一页的耗时 ≈ ⌈批数 ÷ 并发⌉ × 单批延迟（`docs/qa/2026-09-23-p0-throttle-readings.md`
 * 六组实测的公式），而一批最多 12 段（`maxSegmentsPerBatch`）。碎片型站点是**被段数上限**卡住的，
 * 所以砍掉一批短碎片省下的字符很少、省下的批数却很多。只看字符占比会把这条杠杆整个看漏。
 *
 * 三档口径要分开报，因为产品只 ship 了其中一档：
 *   shipped —— `src/core/lang.ts` 的 `isStructureToken` 真正实现的四条（整段是标签 / URL / 邮箱 / kebab 属性名）
 *   宽松噪声 —— 上面四条 + 纯符号 + ≤2 字符 + 时间戳 + 全大写串 + "含代码形状"。
 *               后几条**没有 ship**：`code` 那条的 `[a-z][A-Z][a-z]+` 会连 `iPhone` 一起挡，
 *               `allcaps` 会挡掉 `NASA ADS` 这种专名。第一版估算引用的 7.9% 来自这一档，
 *               它不是产品能拿到的数，留着只作对照。
 *   候选标签 —— ≤3 词且无句末标点。收益最大（30% 批数），但砍的是产品语义，归人裁决。
 */
const MAX_CHARS = 1000;
const MAX_SEGS = 12;
const OVERHEAD = 8;
function countBatches(lens) {
  let batches = 0, cur = 0, curChars = 0;
  for (const len of lens) {
    const cost = len + OVERHEAD;
    if (cost > MAX_CHARS) { if (cur) batches += 1; batches += 1; cur = 0; curChars = 0; continue; }
    if (cur > 0 && (curChars + cost > MAX_CHARS || cur >= MAX_SEGS)) { batches += 1; cur = 0; curChars = 0; }
    cur += 1; curChars += cost;
  }
  if (cur) batches += 1;
  return batches;
}
const SHIPPED = new Set(['tag', 'url', 'email', 'cssprop']);
const 批数 = { 全送: 0, 只去shipped: 0, 去机械噪声: 0, 再去候选标签: 0 };
const 字 = { 全送: 0, 只去shipped: 0, 去机械噪声: 0, 再去候选标签: 0 };
const 段 = { 全送: 0, 只去shipped: 0, 去机械噪声: 0, 再去候选标签: 0 };
for (const s of sites) {
  if (!s.recs.length) continue;
  const shippedIds = new Set([...SHIPPED].flatMap((k) => s.buckets.get(k).map((r) => r.ord)));
  const noiseIds = new Set([...NOISE].flatMap((k) => s.buckets.get(k).map((r) => r.ord)));
  const navIds = new Set(s.buckets.get('navlabel').map((r) => r.ord));
  const variants = {
    全送: s.recs,
    只去shipped: s.recs.filter((r) => !shippedIds.has(r.ord)),
    去机械噪声: s.recs.filter((r) => !noiseIds.has(r.ord)),
    再去候选标签: s.recs.filter((r) => !noiseIds.has(r.ord) && !navIds.has(r.ord)),
  };
  for (const [key, list] of Object.entries(variants)) {
    批数[key] += countBatches(list.map((r) => r.len));
    字[key] += list.reduce((a, r) => a + r.len, 0);
    段[key] += list.length;
  }
}

const pct = (from, to) => `${((1 - to / from) * 100).toFixed(1)}%`;
lines.push('');
lines.push('批次模拟（默认并发 6，公式 T ≈ ⌈批数÷并发⌉ × 单批延迟）：');
lines.push('口径                    段数        字符         批数');
for (const [key, label] of [
  ['全送', '全送（基线）'],
  ['只去shipped', '只去已 ship 四条'],
  ['去机械噪声', '去宽松噪声(未ship)'],
  ['再去候选标签', '再去 navlabel 候选'],
]) {
  lines.push(
    `  ${label.padEnd(22)}${String(段[key]).padStart(5)}${String(字[key]).padStart(11)}` +
      `${String(批数[key]).padStart(9)}　批数省 ${pct(批数.全送, 批数[key])}`,
  );
}
lines.push('  ⇒ 批数省得比字符多，是因为碎片站的批次被 12 段上限卡住、而不是被 1000 字符上限卡住。');
lines.push('  ⇒ 产品实际只 ship 了「只去已 ship 四条」那一行，其余两行是对照，用来说明为什么没做。');

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log(lines.slice(-14).join('\n'));
console.log(`\n明细已写到 ${OUT}`);
if (problems.length) {
  console.log(`\n量具/原料问题（读数不可信）：`);
  for (const p of problems.slice(0, 25)) console.log(`  ✗ ${p}`);
  if (problems.length > 25) console.log(`  …另有 ${problems.length - 25} 条`);
  process.exit(1);
}
console.log('输入体检与对账都没红：分类全覆盖、序号连续、逐站段数与报告一致。');
