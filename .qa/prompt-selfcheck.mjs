// 判据自检：纯 Node、零网络、不开 Chrome，也不花一分钱额度。
// 测的是 `.qa/score-prompt.mjs` **这把尺子自己**会不会放过坏答案。
//
// 为什么先有这一支再谈实跑：docs/qa/2026-09-24-measurement-traps.md 总则 3 写着
// "每一层守卫都要证过红——没被变异打红过的守卫，等于不知道自己守的是什么"。
// 这里喂的是合成响应，每条都指定"必须红"或"必须绿"，红绿反了当场退出码非 0。
//
// 用法：node .qa/prompt-selfcheck.mjs
import { CASES, HARD_KINDS, aggregate, scoreRun, segmentTexts, splitNumbered } from './score-prompt.mjs';

let failed = 0;
const check = (name, pass, detail = '') => {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? `　${detail}` : ''}`);
  if (!pass) failed += 1;
};

const numberedUser = (cases) => cases.map((c, i) => `<<<${i + 1}>>>\n${c.text}`).join('\n');
/** 中文译文样本：给散文段用，含汉字且不等于输入。 */
const zh = (text) => `这段内容已译为中文（${text.slice(0, 6)}…）`;
const entry = (user, content) => ({ user, content });
/** 每类 case 各自的"满分答案"。embedded 必须同时含汉字与标识符，缺一个都不算过。 */
const ideal = (c) => {
  if (c.kind === 'prose') return zh(c.text);
  if (c.kind === 'embedded') return `这里把 ${c.token} 按原样保留，其余部分译为中文。`;
  return c.text;
};
const HARD_N = CASES.filter((c) => HARD_KINDS.includes(c.kind)).length;

/* ---------- ① 已知答案：全对的响应必须全绿 ---------- */
const good = CASES.map((c, i) => `<<<${i + 1}>>> ${ideal(c)}`).join('\n');
const r1 = scoreRun({ entries: [entry(numberedUser(CASES), good)] });
check(`全对响应 ⇒ 硬判据 ${HARD_N}/${HARD_N} 通过`, r1.通过 === HARD_N && r1.缺失.length === 0 && r1.形状问题.length === 0,
  `通过 ${r1.通过}/${r1.硬判据条数}，段数 ${r1.每请求段数.join(',')}`);
check('全对响应 ⇒ 标记完整请求 1/1', r1.标记完整请求 === '1/1', r1.标记完整请求);

/* ---------- ② 现状形状：标识符被译 ⇒ verbatim 全红、prose 全绿 ---------- */
const translatedAll = CASES.map((c, i) => `<<<${i + 1}>>> ${zh(c.text)}`).join('\n');
const r2 = scoreRun({ entries: [entry(numberedUser(CASES), translatedAll)] });
const v2 = r2.逐条.filter((x) => x.kind === 'verbatim');
check('标识符被译 ⇒ 4 条 verbatim 全部判红', v2.every((x) => x.pass === false),
  `红 ${v2.filter((x) => !x.pass).length}/${v2.length}`);
check('标识符被译 ⇒ prose 仍判绿（不误伤）', r2.逐条.filter((x) => x.kind === 'prose').every((x) => x.pass === true));
const e2 = r2.逐条.filter((x) => x.kind === 'embedded');
check('标识符被译走 ⇒ embedded 判红（半边一：token 没了）',
  e2.every((x) => x.pass === false && x.标识符保留 === false), `${e2.length} 条全红`);

/* ---------- ③ 退化实现：什么都不译、整段原样吐回 ⇒ 必须被 prose 那半边抓住 ---------- */
const echoAll = CASES.map((c, i) => `<<<${i + 1}>>> ${c.text}`).join('\n');
const r3 = scoreRun({ entries: [entry(numberedUser(CASES), echoAll)] });
const p3 = r3.逐条.filter((x) => x.kind === 'prose');
check('退化实现（全原样）⇒ 3 条 prose 全部判红', p3.every((x) => x.pass === false),
  `红 ${p3.filter((x) => !x.pass).length}/${p3.length}`);
check('退化实现 ⇒ 判据没有整轮放行', r3.通过 < r3.硬判据条数, `通过 ${r3.通过}/${r3.硬判据条数}`);
const e3 = r3.逐条.filter((x) => x.kind === 'embedded');
check('原样回显（token 在但整句没译）⇒ embedded 判红（半边二）',
  e3.every((x) => x.pass === false && x.标识符保留 === true), `${e3.length} 条`);

/* ---------- ④ 标记形状破坏：少一段 / 乱序 / 空段，一律判成"这一轮降级" ---------- */
const missing = CASES.slice(0, -1).map((c, i) => `<<<${i + 1}>>> ${zh(c.text)}`).join('\n');
const r4 = scoreRun({ entries: [entry(numberedUser(CASES), missing)] });
check('少一段标记 ⇒ 记为形状问题且硬判据归零', r4.形状问题.length === 1 && r4.通过 === 0,
  `形状问题 ${r4.形状问题.length}，通过 ${r4.通过}`);

const swapped = CASES.map((c, i) => `<<<${CASES.length - i}>>> ${zh(c.text)}`).join('\n');
check('编号乱序 ⇒ splitNumbered 判不合法', splitNumbered(swapped, CASES.length) === null);

const blank = CASES.map((c, i) => `<<<${i + 1}>>>${i === 2 ? '' : ' ' + zh(c.text)}`).join('\n');
check('有一段为空 ⇒ splitNumbered 判不合法', splitNumbered(blank, CASES.length) === null);

/* ---------- ⑤ 单段形状（降级路径的形状）：无标记、且要抹掉模型自作加的开头标记 ---------- */
const singleProse = CASES.find((c) => c.kind === 'prose');
const r5 = scoreRun({ entries: [entry(singleProse.text, zh(singleProse.text))] });
check('单段响应无标记 ⇒ 能定位并判绿', r5.通过 === 1 && r5.缺失.length === CASES.length - 1,
  `通过 ${r5.通过}，缺失 ${r5.缺失.length} 条（其余 case 本来就不在这条请求里）`);
check('单段请求的段数按 1 计', r5.每请求段数.join(',') === '1', r5.每请求段数.join(','));

const singleVerbatim = CASES.find((c) => c.kind === 'verbatim');
const r6 = scoreRun({ entries: [entry(singleVerbatim.text, `<<<1>>> ${singleVerbatim.text}`)] });
check('单段且模型自作加开头标记 ⇒ 抹掉后判逐字相等',
  r6.逐条.find((x) => x.id === singleVerbatim.id)?.pass === true,
  JSON.stringify(r6.逐条.find((x) => x.id === singleVerbatim.id)?.输出));

const r7 = scoreRun({ entries: [entry(singleVerbatim.text, `表 ${singleVerbatim.text}`)] });
check('单段输出多出一个字 ⇒ 逐字判据判红（没被"包含"糊过去）',
  r7.逐条.find((x) => x.id === singleVerbatim.id)?.pass === false);

/* ---------- ⑥ 输入体检：一条 case 没出现在任何请求里，必须记成缺失而不是通过 ---------- */
const r8 = scoreRun({ entries: [entry(numberedUser(CASES.slice(0, 3)), CASES.slice(0, 3).map((c, i) => `<<<${i + 1}>>> ${zh(c.text)}`).join('\n'))] });
check('未送出的 case ⇒ 记为缺失', r8.缺失.length === CASES.length - 3 && r8.通过 === 0,
  `缺失 ${r8.缺失.length} 条：${r8.缺失.join(',')}`);

/* ---------- ⑦ user 侧正文还原：产品发的形状必须能按行切回逐段 ---------- */
const back = segmentTexts(numberedUser(CASES), CASES.length);
check('user 文本按行切回逐段 ⇒ 与 CASES 一字不差',
  back.length === CASES.length && back.every((t, i) => t === CASES[i].text));
check('段数不符时 segmentTexts 返回空（不静默错位）',
  segmentTexts(numberedUser(CASES), CASES.length + 1).length === 0);

/* ---------- ⑧ 跨轮汇总的算术 ---------- */
const agg = aggregate([r2, r3, r1]);
// v-table 在 r2（被译）红、r3（全原样）绿、r1（全对）绿 ⇒ 2/3。
// 这条不要读成"退化实现也能过 verbatim"：退化实现过的正是那一半边，被抓住的是 prose 半边。
const tableAgg = agg.find((a) => a.id === 'v-table');
check('汇总：verbatim 三轮里对 2 次 ⇒ 计数 2/3', tableAgg.计数 === '2/3', tableAgg.计数);
const proseAgg = agg.find((a) => a.id === 'p-one');
check('汇总：prose 三条里对 2 次 ⇒ 计数 2/3', proseAgg.计数 === '2/3', proseAgg.计数);
const mixedAgg = agg.find((a) => a.id === 'm-prop');
check('汇总：embedded 三轮里只对 1 次 ⇒ 计数 1/3', mixedAgg.计数 === '1/3', mixedAgg.计数);
check('汇总：半结构段不参与硬判据', HARD_KINDS.includes('semi') === false &&
  agg.find((a) => a.kind === 'semi').计数.startsWith('（不判）'));

console.log(`\n${failed === 0 ? '判据可用' : '判据有问题'}：${failed} 项未达预期`);
process.exit(failed === 0 ? 0 : 1);
