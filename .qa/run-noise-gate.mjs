// 形状闸的真链路验收：走真实扩展（内容脚本采集 → 后台调度 → 引擎请求），数"到底送出去了什么"。
// 假引擎，零额度、零真 Key。
//
// 为什么单测不够：`tests/core/lang.test.ts` 钉住了判据本体，但它证明不了
// "整页采集真的把这些段挡在批次之外"（锚点、块级边界、行内链接文字都在中间）。
// 而 2026-09-23 那轮的噪声段恰恰长在 `<a><table></a>` 这种链接文字上。
//
// 两头都断言：n* 一个都不许送（否则漏挡），c* 一个都不许少（否则过挡）。
// 只测 n* 的话，"把所有段都挡掉"的退化实现也能全绿。
//
// 用法：node .qa/run-noise-gate.mjs
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, sleep, seedProfileViaUi, selectFirstUsableProfile } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOISE = ['n1', 'n2', 'n3', 'n4', 'n5'];
const CONTROL = ['c1', 'c2', 'c3', 'c4'];

// 加载预授权副本（8787 的 origin 已在 manifest 里），否则扩展发不出请求。
execFileSync(process.execPath, [join(HERE, 'make-hostperm-dist.mjs')], { stdio: 'ignore' });
process.env.JY_QA_DIST = join(HERE, 'dist-perm');

const api = await boot();
const fail = [];
try {
  await api.engineCtl({ mode: 'ok', reset: true });
  const seeded = await seedProfileViaUi(api);
  if (seeded.error) throw new Error(`建档失败：${seeded.error}`);
  if (!seeded.granted) throw new Error('没拿到 8787 的 host 授权，请求发不出去');
  const chosen = await selectFirstUsableProfile(api);
  console.log(`建档+选档：${chosen.baseUrl} 模型 ${chosen.model}（engineId ${chosen.本来就对 ? '本来就对' : '已写入'}）`);

  const page = await api.openFixture('noise-gate.html');
  // 期望文本从页面上读，不在脚本里重抄一遍夹具——抄一份就会有"改了夹具没改脚本"的假绿。
  const atoms = await api.cdp.eval(
    page.sessionId,
    `(${JSON.stringify([...NOISE, ...CONTROL])}.map((id) => {
      const el = document.getElementById(id);
      const list = [...el.querySelectorAll('li')];
      const parts = (list.length ? list : [el]).map((x) => x.textContent.replace(/\\s+/g, ' ').trim());
      return { id, parts };
    }))`,
  );
  const byId = new Map(atoms.map((a) => [a.id, a.parts]));
  for (const id of [...NOISE, ...CONTROL]) {
    if (!byId.has(id)) throw new Error(`夹具里找不到 #${id}`);
  }

  await api.fireToPage('jinyi:translate-page');
  // 收尾：假引擎侧有请求到达、没有在飞、且连续静默 ≥3 秒（增量轮与轮末补译都在里面）。
  let quiet = 0;
  for (let i = 0; i < 80; i += 1) {
    await sleep(500);
    const ctl = await api.engineStats();
    if (ctl.requests > 0 && ctl.inflight === 0) quiet += 1;
    if (quiet >= 6) break;
  }
  const log = await api.engineLog();
  const sent = new Set(
    log.log
      .flatMap((e) => e.user.split(/<<<\d+>>>/g))
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 0),
  );
  const ctl = await api.engineStats();
  if (ctl.requests === 0) throw new Error('假引擎一条请求都没收到：链路没通，下面的断言全部无效');
  console.log(`送出 ${sent.size} 段 / ${ctl.requests} 请求 / ${ctl.segments} 段次`);

  for (const id of NOISE) {
    for (const part of byId.get(id)) {
      if (sent.has(part)) fail.push(`#${id} 仍被送出：${JSON.stringify(part)}`);
    }
    const hosts = await api.cdp.eval(
      page.sessionId,
      `document.getElementById(${JSON.stringify(id)}).querySelectorAll('jy-translation').length`,
    );
    if (hosts > 0) fail.push(`#${id} 页面上插了 ${hosts} 个译文宿主（应当一个都不插）`);
  }
  for (const id of CONTROL) {
    for (const part of byId.get(id)) {
      if (!sent.has(part)) fail.push(`#${id} 没送出（过挡）：${JSON.stringify(part)}`);
    }
  }

  const states = await api.cdp.eval(
    page.sessionId,
    `(${JSON.stringify([...NOISE, ...CONTROL])}.map((id) => {
      const host = document.getElementById(id).querySelector('jy-translation');
      const body = host?.shadowRoot?.querySelector('.jy-body');
      return { id, 有宿主: Boolean(host), 态: body?.className ?? '-' };
    }))`,
  );
  console.log('页面现场（译文在 shadow 里，读宿主的 textContent 永远是空 ⇒ 坑 #10）：');
  for (const s of states) console.log(`  ${s.id}  宿主=${s.有宿主 ? '有' : '无'}  ${s.态}`);
  console.log(`送出的段：${JSON.stringify([...sent], null, 0)}`);
} finally {
  await api.close();
}

if (fail.length) {
  console.log('\n不达标：');
  for (const f of fail) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\n达标：${NOISE.length} 个噪声段零送出，${CONTROL.length} 条含同款形状的散文零漏送。`);
