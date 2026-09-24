// 基线读数：产品**现在**这句提示词，在真实模型上把标识符段保住了几条、散文有没有被误伤。
// 不改任何产品代码，只出数。
//
// 用法：node .qa/run-prompt-baseline.mjs [--runs=8] [--force]
// 前置：.qa/endpoint.json 里有真 Key（该目录不入库）；dist 已 build。
//
// 退出码只表达一件事：**读数可不可信**（量具有效性），不表达"提示词好不好"。
// 基线的保真度按预期就该是红的（那正是要不要加保留规则的依据），所以它不进退出码。
// 红的情形：夹具文本与 CASES 不符、某条 case 根本没被送出去、标记切分整体失败、
// DOM 与代理两路对不上。
//
// 台架纪律（docs/qa/2026-09-24-measurement-traps.md）在这里的落点：
//   坑 #3 每轮开带一次性 token 的 fixture URL，跑完关标签页
//   坑 #4 每轮之前把 local 与 session 两级的 jt: 键全清，否则 8 轮只有 1 轮真发请求
//   坑 #6 收尾不看 DOM，看代理侧「没有在飞 + 连续静默 8 秒」（> 最长退避 4 秒 + 单请求）
//   总则 #3 计数类指标三层守：① CASES 已知答案 ② 请求体与夹具文本体检 ③ DOM/代理两路对账
import { cpSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startChrome, loadUnpacked, kill, sleep, PROFILE_DIR } from './harness.mjs';
import { startProxy } from './prompt-proxy.mjs';
import { CASES, HARD_KINDS, aggregate, scoreRun } from './score-prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const args = process.argv.slice(2);
const RUNS = Number((args.find((a) => a.startsWith('--runs=')) ?? '--runs=8').split('=')[1]);
const FORCE = args.includes('--force');
/**
 * 不用假引擎那个 8787：`.qa/daemon.mjs` 起的 mock 是会留孤儿的（实测：它的 Chrome 已经退出了，
 * 8787 还被它占着）。换一个端口自立门户，两台架可以同时活着。
 */
const PORT = Number((args.find((a) => a.startsWith('--port=')) ?? `--port=${8789}`).split('=')[1]);
const ENGINE_BASE = `http://127.0.0.1:${PORT}/v1`;
const FIXTURE_BASE = `http://127.0.0.1:${PORT}/fixture`;
const ORIGIN = `http://127.0.0.1:${PORT}/*`;
const DIST_COPY = join(HERE, 'dist-prompt');
const QUIET_MS = 8_000;
const ROUND_CAP_MS = 240_000;

const fail = [];
const note = (msg) => fail.push(msg);

/* ---------- 前置：别测一个旧产物（改完 dist 不重载是最容易白跑一轮的坑） ---------- */
function walkFiles(dir, accept) {
  const out = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) out.push(...walkFiles(full, accept));
    else if (accept(item.name)) out.push(full);
  }
  return out;
}
const newestOf = (dir, accept) => walkFiles(dir, accept).reduce((best, p) => Math.max(best, statSync(p).mtimeMs), 0);

const srcNewest = newestOf(join(REPO, 'src'), (n) => /\.(ts|html|json|css)$/.test(n));
let distNewest = 0;
try {
  distNewest = newestOf(join(REPO, 'dist'), (n) => !n.startsWith('.'));
} catch {
  if (!FORCE) {
    console.error('没有 dist/：先 npm run build（确认要测不存在的产物可加 --force）');
    process.exit(1);
  }
}
if (!FORCE && distNewest < srcNewest) {
  const 在动 = walkFiles(join(REPO, 'src'), (n) => /\.(ts|html|json|css)$/.test(n))
    .filter((p) => statSync(p).mtimeMs > distNewest)
    .map((p) => `${p.slice(REPO.length + 1)} (${new Date(statSync(p).mtimeMs).toISOString()})`);
  console.error(`dist 比 src 旧，先 npm run build。\n晚于 dist 的文件：\n  ${在动.join('\n  ')}\n` +
    `确认这些与本次测量无关（或产物就是你要测的）再加 --force。`);
  process.exit(1);
}

const ep = JSON.parse(readFileSync(join(HERE, 'endpoint.json'), 'utf8'));
console.log(`上游 ${new URL(ep.baseUrl).host} 模型 ${ep.model}（Key 只在 Node 侧注入，不进浏览器）`);

/**
 * 走真实设置页 UI 建一个指向本脚本代理的档案。
 * 逻辑与 `lib.mjs` 的 `seedProfileViaUi` 同源，差别只有 baseUrl 参数化（那份写死 8787）；
 * Key 填占位串——真 Key 由代理注入，所以它不进 chrome.storage、不进 DOM、也不经调试通道。
 */
async function seedProfile(cdp, id, { baseUrl, model }) {
  const tab = await cdp.openTab(`chrome-extension://${id}/options/options.html`);
  await sleep(1200);
  const prepared = await cdp.eval(
    tab.sessionId,
    `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      document.getElementById('add-profile').click();
      await wait(300);
      const ed = [...document.querySelectorAll('.profile-editor')].pop();
      if (!ed) return JSON.stringify({ error: '没有展开出编辑框' });
      const set = (sel, value) => {
        const el = ed.querySelector(sel);
        if (!el) return '缺控件 ' + sel;
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return null;
      };
      let err = set('.profile-label', 'QA Prompt Proxy') ?? set('.profile-base-url', ${JSON.stringify(baseUrl)})
        ?? set('.profile-api-key', 'proxy-injected-key');
      if (err) return JSON.stringify({ error: err });
      ed.querySelector('[data-action="add-model"]').click();
      await wait(200);
      err = set('.profile-model-new', ${JSON.stringify(model)});
      if (err) return JSON.stringify({ error: err });
      ed.querySelector('[data-action="confirm-model"]').click();
      await wait(300);
      const save = ed.querySelector('[data-action="save-profile"]');
      if (!save) return JSON.stringify({ error: '没有保存按钮' });
      const rect = save.getBoundingClientRect();
      return JSON.stringify({
        x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
        models: [...ed.querySelectorAll('.model-row')].map((r) => r.textContent.trim().slice(0, 40)),
      });
    })()`,
  );
  const info = JSON.parse(prepared);
  if (info.error) return { error: info.error };
  await cdp.mouse(tab.sessionId, 'mousePressed', info.x, info.y);
  await cdp.mouse(tab.sessionId, 'mouseReleased', info.x, info.y);
  await sleep(1200);
  const granted = await cdp.eval(tab.sessionId, `chrome.permissions.contains({ origins: [${JSON.stringify(ORIGIN)}] })`);
  return { granted, models: info.models, tab };
}

/* ---------- 代理 + 预授权副本 + Chrome ---------- */
const proxy = await startProxy({ port: PORT, upstream: ep.baseUrl, key: ep.key });
// 预授权副本：与 make-hostperm-dist.mjs 同一招——只把本脚本自己那个 origin 从
// optional_host_permissions 挪进 host_permissions（开发者加载的扩展必选 host 安装即生效），
// 产品 JS 一字节不动。
rmSync(DIST_COPY, { recursive: true, force: true });
cpSync(join(REPO, 'dist'), DIST_COPY, { recursive: true });
const manifestPath = join(DIST_COPY, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), ORIGIN])];
manifest.optional_host_permissions = (manifest.optional_host_permissions ?? []).filter((p) => p !== ORIGIN);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
// 让 Chrome 启动参数也指向这份副本：否则 startChrome 会按默认值再 --load-extension 一份
// **没打权限补丁**的 dist，同一次运行里并存两份扩展，谁的内容脚本在页面上跑就不确定了。
process.env.JY_QA_DIST = DIST_COPY;

const { child, cdp } = await startChrome();
let exitCode = 1;
let page = null;
try {
  const id = await loadUnpacked(cdp, DIST_COPY);
  const ext = await cdp.openTab(`chrome-extension://${id}/options/options.html`);
  await sleep(1500);
  const extEval = (expr) => cdp.eval(ext.sessionId, expr);

  // qaFindTab 每次补装：常驻页面可能被 Chrome discard，全局会随页面一起没。
  const installFindTab = () => extEval(`globalThis.qaFindTab = async (name) => {
    const tabs = await chrome.tabs.query({});
    const byUrl = tabs.find((t) => (t.url ?? '').includes(name));
    if (byUrl) return byUrl.id;
    const active = await chrome.tabs.query({ active: true, currentWindow: true });
    return active[0]?.id ?? -1;
  }; 'ok'`);
  await installFindTab();

  const seeded = await seedProfile(cdp, id, { baseUrl: ENGINE_BASE, model: ep.model });
  if (seeded.error) throw new Error(`建档失败：${seeded.error}`);
  console.log(`建档：授权 ${ORIGIN} = ${seeded.granted}，模型 ${JSON.stringify(seeded.models)}`);
  if (!seeded.granted) throw new Error('预授权副本没拿到 host 权限，测不到真接口');

  const clearCaches = () => extEval(`(async () => {
    for (const area of [chrome.storage.local, chrome.storage.session]) {
      const all = await area.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith('jt:'));
      if (keys.length) await area.remove(keys);
    }
    return 'cleared';
  })()`);

  /**
   * 把新档案选成"使用中"。
   *
   * 设置页**从不**写 `engineId`（`src/options/sections/engine.ts` 的注释：选择档案是弹窗的职责），
   * 所以只建档不选档时 `resolveEngine` 给出 NO_ENGINE_PROBLEM，页面上每一格都是
   * "还没有可用的翻译引擎"，而请求一条都发不出去（实测就是这么红的）。
   * 真用户是在弹窗里点的；台架这里直接改存储，因为被测对象是提示词而不是选档链路，
   * 且"有没有真的选上"由后续请求到不到代理自证——选不上就整轮红，不会静默测到别的东西。
   */
  const selectProfile = async () => {
    const result = await extEval(`(async () => {
      const key = 'jinyi:settings';
      const stored = await chrome.storage.local.get(key);
      const s = stored[key];
      if (!s?.profiles?.length) return JSON.stringify({ error: '存储里没有档案' });
      const usable = s.profiles.find((p) => (p.activeModel ?? '').trim().length > 0);
      if (!usable) return JSON.stringify({ error: '没有带当前模型的档案' });
      if (s.engineId === usable.id) return JSON.stringify({ 改了: false, engineId: s.engineId });
      await chrome.storage.local.set({ [key]: { ...s, engineId: usable.id } });
      return JSON.stringify({ 改了: true, engineId: usable.id, baseUrl: usable.baseUrl, model: usable.activeModel });
    })()`);
    const parsed = JSON.parse(result);
    if (parsed.error) throw new Error(`选档失败：${parsed.error}`);
    console.log(`选档：engineId=${parsed.engineId ?? parsed.档案?.id}${parsed.改了 ? '（已写入）' : '（本来就对）'}`);
    return parsed;
  };
  await selectProfile();

  /** 链路没通时把现场倒出来：toast 里带的是引擎侧真实错误码，档案与健康记录带的是配置真相。 */
  const dumpDiagnostics = async (提示 = new Set()) => {
    const onPage = await cdp.eval(page.sessionId, `(() => ({
      toast: document.getElementById('jy-toast')?.innerText ?? null,
      宿主数: document.querySelectorAll('jy-translation').length,
      宿主状态: [...document.querySelectorAll('jy-translation')].map((el) => {
        const body = el.shadowRoot?.querySelector('.jy-body');
        // 错误原因写在 shadow 里的 .jy-body（renderer.ts 的 textContent），
        // 读宿主自己的 textContent 拿不到 shadow ⇒ 之前那串空文本是量具的错，不是产品的。
        return { 态: body?.className ?? '无 shadow', 文: (body?.textContent ?? '').trim().slice(0, 60) };
      }),
      首个宿主内部: document.querySelector('jy-translation')?.shadowRoot?.innerHTML?.slice(0, 220) ?? null,
    }))()`).catch((err) => `读页面失败：${err.message}`);
    const state = await extEval(`(async () => { const t = await qaFindTab(${JSON.stringify(page.token ?? '')});
      try { return JSON.stringify(await chrome.tabs.sendMessage(t, { type: 'jinyi:get-page-state' })); }
      catch (e) { return '问页面状态失败：' + e.message; } })()`).catch((err) => `问页面状态异常：${err.message}`);
    console.log('诊断 页面:', typeof onPage === 'string' ? onPage : JSON.stringify(onPage));
    console.log('诊断 页面状态:', state);
    const store = await extEval(`(async () => {
      const all = await chrome.storage.local.get(null);
      const s = all['jinyi:settings'];
      return JSON.stringify({
        档案: (s?.profiles ?? []).map((p) => ({ baseUrl: p.baseUrl, activeModel: p.activeModel })),
        健康: Object.entries(all).filter(([k]) => k.startsWith('p:')).map(([k, v]) => ({ k, v })),
      });
    })()`).catch((err) => `读存储失败：${err.message}`);
    console.log('诊断 页面:', typeof onPage === 'string' ? onPage : JSON.stringify(onPage));
    console.log('诊断 存储:', store);
    console.log('诊断 代理命中:', JSON.stringify(proxy.ctl().hits.slice(-8)));
    console.log('诊断 等待期间看到的提示:', [...提示].join(' ｜ ') || '（一条都没有）');
  };

  const readDom = () => cdp.eval(page.sessionId, `(${JSON.stringify(CASES.map((c) => c.id))}
    .map((cid) => { const host = document.getElementById(cid).querySelector('jy-translation');
      return { cid, 原文: document.getElementById(cid).textContent.replace(/\\s+/g, ' ').trim(),
        // 译文在 shadow 里，读宿主的 textContent 永远是空 —— 那会把对账做成永远不一致。
        译文: host?.shadowRoot?.querySelector('.jy-body')?.textContent?.trim() ?? null }; }))`);

  /* ---------- 输入体检：夹具文本必须与 CASES 一字不差 ---------- */
  const token0 = `qa${Date.now()}`;
  const probe = await cdp.openTab(`${FIXTURE_BASE}/verbatim.html?token=${token0}`);
  await sleep(900);
  const drift = await cdp.eval(probe.sessionId, `(${JSON.stringify(CASES)}
    .filter((c) => document.getElementById(c.id).textContent.replace(/\\s+/g, ' ').trim() !== c.text)
    .map((c) => c.id))`);
  await cdp.send('Target.closeTarget', { targetId: probe.targetId }).catch(() => {});
  if (drift.length) throw new Error(`夹具与 CASES 文本不符：${drift.join(',')}（改了一处没改另一处，读数会整体错位）`);
  console.log('夹具文本与 CASES 一致 ✓');

  /* ---------- 逐轮 ---------- */
  const runs = [];
  for (let round = 1; round <= RUNS; round += 1) {
    await clearCaches();
    const token = `qa${Date.now()}${round}`;
    page = await cdp.openTab(`${FIXTURE_BASE}/verbatim.html?token=${token}`);
    page.token = token;
    await cdp.send('Target.activateTarget', { targetId: page.targetId });
    await sleep(1200);
    await installFindTab();
    const tabId = await extEval(`qaFindTab(${JSON.stringify(token)})`);

    const from = proxy.entries.length;
    const t0 = Date.now();
    await extEval(`(async () => { const t = await qaFindTab(${JSON.stringify(token)});
      chrome.tabs.sendMessage(t, { type: 'jinyi:translate-page' }).catch(() => {}); return 'sent'; })()`);

    // 收尾：至少一条新请求 + 代理侧没有在飞 + 距最后一次请求到达 ≥ QUIET_MS
    let last = 0;
    let waited = 0;
    // toast 只活 3.2 秒，等收尾再读必然什么都读不到 ⇒ 整轮失败原因看不见。
    // 所以等待期间每 500ms 采样一次，把见过的提示都留下。
    const 提示 = new Set();
    while (waited < ROUND_CAP_MS) {
      await sleep(500);
      waited += 500;
      const seen = await cdp.eval(page.sessionId, `document.getElementById('jy-toast')?.innerText?.trim() ?? ''`)
        .catch(() => '');
      if (seen) 提示.add(seen.slice(0, 160));
      const ctl = proxy.ctl();
      const fresh = proxy.entries.slice(from);
      last = fresh.length ? fresh[fresh.length - 1].t0 : 0;
      const quiet = fresh.length ? Date.now() - last : 0;
      if (fresh.length > 0 && ctl.inflight === 0 && quiet >= QUIET_MS) break;
      // 只有"什么都没到代理"且"代理手里也没有在飞的请求"才算链路没通：
      // MiMo 单请求实测 ~10 秒（见 docs/qa 里那条 reasoning_tokens 读数），
      // 光按等待时间判会把正常的慢响应误判成断链。
      if (round === 1 && fresh.length === 0 && ctl.inflight === 0 && waited > 25_000) {
        await dumpDiagnostics(提示);
        throw new Error('25 秒内一条请求都没到代理、代理侧也无在飞，链路没通（上面是现场）');
      }
    }
    const fresh = proxy.entries.slice(from);
    if (fresh.length === 0) {
      await dumpDiagnostics(提示);
      throw new Error(`第 ${round} 轮等满 ${ROUND_CAP_MS / 1000}s 仍没有请求到达代理`);
    }
    const scored = scoreRun({ entries: fresh });
    const dom = await readDom();
    // 两路对账：代理解析出的分段译文，与页面上那一格实际显示的，必须一致。
    const 对账 = [];
    for (const row of dom) {
      const c = CASES.find((x) => x.id === row.cid);
      const got = scored.逐条.find((x) => x.id === row.cid);
      if (!got?.找到) continue;
      if (row.译文 === null) { 对账.push(`${row.cid} 页面没有译文宿主`); continue; }
      if (row.译文 !== got.输出) 对账.push(`${row.cid} 页面「${row.译文}」≠ 代理「${got.输出}」`);
    }
    if (scored.缺失.length) note(`第 ${round} 轮有 case 没被送出：${scored.缺失.join(',')}`);
    if (对账.length) note(`第 ${round} 轮两路对账不一致：${对账.join(' / ')}`);
    runs.push({ round, 秒: ((Date.now() - t0) / 1000).toFixed(1), scored, 对账: 对账.length });
    console.log(`第 ${round} 轮　${runs[runs.length - 1].秒}s　请求 ${scored.请求数}　段数 ${scored.每请求段数.join('/')}　标记完整 ${scored.标记完整请求}　对账不一致 ${对账.length}`);
    if (scored.形状问题.length) console.log(`　形状问题：${scored.形状问题.map((s) => `#${s.第几个请求} ${s.原因}`).join(' / ')}`);
    if (对账.length) console.log(`　对账：${对账.join(' / ')}`);
    await cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
  }

  /* ---------- 汇总 ---------- */
  console.log(`\n=== 基线读数（${RUNS} 轮，上游 ${new URL(ep.baseUrl).host} / ${ep.model}）===`);
  const 标记 = runs.filter((r) => r.scored.形状问题.length === 0 && r.scored.缺失.length === 0).length;
  console.log(`整轮标记协议完好：${标记}/${RUNS}　两路对账不一致：${runs.reduce((a, r) => a + r.对账, 0)} 处`);
  for (const row of aggregate(runs.map((r) => r.scored))) {
    const kind = { verbatim: '标识符整段(硬)', prose: '纯散文(硬·反退化)', embedded: '标识符在句内(硬)', semi: '半结构(不判)' }[row.kind];
    console.log(`${String(row.计数).padEnd(12)} ${kind.padEnd(20)} ${row.id}　样本 ${JSON.stringify(row.样本[0] ?? '')}`);
  }
  // 每一轮都拿同一个 proxy.entries 全表算的话，n 会被乘出 RUNS 倍（实测把 8 次算成 64 次）。
  const 耗时 = proxy.entries.filter((e) => e.ms !== null);
  if (耗时.length) {
    const ms = 耗时.map((e) => e.ms).sort((a, b) => a - b);
    const pt = 耗时.map((e) => e.usage?.prompt_tokens ?? 0);
    const ct = 耗时.map((e) => e.usage?.completion_tokens ?? 0);
    console.log(`\n单请求耗时 中位 ${ms[Math.floor(ms.length / 2)]}ms（min ${ms[0]} / max ${ms[ms.length - 1]}，n=${ms.length}）`);
    console.log(`token 用量 prompt 均 ${Math.round(pt.reduce((a, b) => a + b, 0) / pt.length)}，completion 均 ${Math.round(ct.reduce((a, b) => a + b, 0) / ct.length)}　⇒ 提示词瘦身能动的是 prompt 那侧，而延迟拟合的斜率在 completion 上`);
  }
  console.log(`\n硬判据共 ${runs[0].scored.硬判据条数} 条/轮（${HARD_KINDS.join(' + ')}），上面每一行都要 ${RUNS}/${RUNS} 才算"这条稳定"。`);

  if (fail.length) {
    console.log('\n量具/链路问题（读数不可信）：');
    for (const f of fail) console.log(`  ✗ ${f}`);
    exitCode = 1;
  } else {
    console.log('量具有效：三层守卫（已知答案 / 输入体检 / 两路对账）本轮都没红。');
    exitCode = 0;
  }
} finally {
  await cdp.send('Browser.close').catch(() => {});
  await sleep(1500);
  await kill(child);
  await proxy.stop();
  if (!args.includes('--keep')) rmSync(PROFILE_DIR, { recursive: true, force: true });
}
process.exit(exitCode);
