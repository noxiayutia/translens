// 划词两段式（小气泡 + 悬停意图）的真机读数。
//
// 为什么必须真机：浮层是 shadow DOM，悬停意图挂在**宿主**上，靠的是浏览器把 shadow 内部
// 元素的 pointerenter 重定向到宿主。jsdom 里"派发一个 pointerenter"证明不了这件事。
//
// 手势的两条硬事实（都是这一轮实测出来的，写下来免得下次重新踩）：
// 1. **CDP 的 mousePressed + mouseMoved(buttons:1) + mouseReleased 拖不出选区**——
//    事件确实以 isTrusted=true 送到了页面，但 Blink 不因此扩展文本选区
//    （对照实验：加不加 buttons 掩码都是空选区）。真手势划词走**双击选词 + Shift+单击扩到句尾**，
//    两者都由 Input.dispatchMouseEvent 产生，isTrusted 同样是 true。
// 2. 每一次划词用**不同的段落**，且开头清两级缓存（local + session）：同一段文字第二次
//    命中缓存 ⇒ 引擎侧请求数恒为 0，那正是 `docs/qa/2026-09-24-measurement-traps.md`
//    第 4 条的假读数形状（这里还会反过来把"零请求"的负向读数蒙对）。
//
// 读数口径：`/__ctl` 的 requests 是**引擎侧**收到的请求数。台架不直接发任何翻译消息，
// 页面上的请求只能由真鼠标动作产生（⑥⑧ 两条各带一个"故意不等满延时"的对照，
// 用来证明那一次请求确实是指令性动作带来的，不是悬停顺手发的）。
//
// 用法（自己起一个 Chrome，加载预授权副本，profile 保留）：
//   JY_QA_KEEP=1 JY_QA_DIST=<绝对路径>/.qa/dist-perm node .qa/run-selection-chip.mjs
// 连已经起好的常驻实例：再加 JY_QA_ATTACH=1。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, seedProfileViaUi, sleep } from './lib.mjs';

const SHOT_DIR = join('.qa', 'shots', 'selection');
const DWELL_MS = 450; // 生产默认停留 150ms；停这么久必然过阈值

const results = [];
const check = (name, pass, evidence) => {
  results.push({ name, pass: Boolean(pass) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${evidence ? '  → ' + evidence : ''}`);
};

const api = await boot();
const page = await api.openFixture('article.html');
const S = page.sessionId;

const stats = async () => api.engineStats();
const requests = async () => (await stats()).requests;
const readLog = async () => api.engineLog();

/** 浮层的可读状态（含宿主与第一个按钮的视口中心——真鼠标的落点全靠它们）。 */
const readTip = () =>
  api.cdp.eval(
    S,
    `(() => { const host = document.querySelector('#jy-tooltip'); if (!host) return null;
      const r = host.getBoundingClientRect(); const root = host.shadowRoot;
      const b = root.querySelector('.jy-bubble'); const btn = root.querySelector('button');
      const br = btn?.getBoundingClientRect();
      return JSON.stringify({ variant: b?.getAttribute('data-variant'), state: b?.getAttribute('data-state'),
        text: (root.querySelector('.jy-text')?.textContent ?? '').trim(),
        buttons: [...root.querySelectorAll('button')].map((x) => x.textContent.trim()),
        x: r.x, y: r.y, w: r.width, h: r.height,
        btn: br ? { x: br.x + br.width / 2, y: br.y + br.height / 2 } : null }); })()`,
  ).then((s) => (s === null ? null : JSON.parse(s)));

/** 元素内每一"词"的中心点（Range 逐词量）：双击与 Shift+点击都要落在词上。 */
const wordPoints = (id) =>
  api.cdp.eval(
    S,
    `(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const out = [];
      let node;
      while ((node = walker.nextNode())) {
        const text = node.nodeValue;
        const re = /\\S+/g;
        let m;
        while ((m = re.exec(text))) {
          const r = document.createRange();
          r.setStart(node, m.index);
          r.setEnd(node, m.index + m[0].length);
          const b = r.getBoundingClientRect();
          if (b.width > 0) out.push({ word: m[0], x: b.x + b.width / 2, y: b.y + b.height / 2 });
        }
      }
      return JSON.stringify(out);
    })()`,
  ).then((s) => JSON.parse(s));

const selectionText = () => api.cdp.eval(S, 'String(getSelection()).trim()');

/**
 * 真手势划词：双击第一个词选词，再 Shift+单击第 `words` 个词把选区扩过去。
 * 返回选区文本与此刻的浮层状态（应当是待触发的小气泡）。
 */
async function selectWords(id, words) {
  await api.activate(page.targetId);
  await api.cdp.eval(S, 'getSelection()?.removeAllRanges()');
  const points = await wordPoints(id);
  const first = points[0];
  const last = points[Math.min(words, points.length) - 1];
  await api.cdp.mouse(S, 'mousePressed', first.x, first.y, { clickCount: 1 });
  await api.cdp.mouse(S, 'mouseReleased', first.x, first.y, { clickCount: 1 });
  await sleep(70);
  await api.cdp.mouse(S, 'mousePressed', first.x, first.y, { clickCount: 2 });
  await api.cdp.mouse(S, 'mouseReleased', first.x, first.y, { clickCount: 2 });
  await sleep(120);
  if (last !== first) {
    await api.cdp.mouse(S, 'mousePressed', last.x, last.y, { modifiers: 8, clickCount: 1 });
    await api.cdp.mouse(S, 'mouseReleased', last.x, last.y, { modifiers: 8, clickCount: 1 });
  }
  await sleep(180); // 等最后一次 mouseup 之后的浮层落地
  return { text: await selectionText(), tip: await readTip(), words: points.length };
}

/**
 * 指针移动。**不在中间 activate**：`activate()` 自带 300ms 睡眠，放在"进入气泡"与"离开气泡"
 * 之间会让停留变成 360ms —— 那已经超过 150ms 阈值，③⑤ 两条负向读数就废了。
 * 所以每次序列开头 activate 一次，中间的移动一律裸派发（本地回环，一次 1~3ms）。
 */
async function moveTo(x, y) {
  await api.cdp.mouse(S, 'mouseMoved', x, y);
}

/** 把指针停到浮层正中（真实 pointerenter 落到宿主上）。 */
async function dwell(tip) {
  await moveTo(tip.x + tip.w / 2, tip.y + tip.h / 2);
}

async function moveAway(tip) {
  await moveTo(tip.x + tip.w + 120, tip.y + tip.h / 2);
}

/**
 * 等这一次翻译真的落到浮层上：回到 bubble 档且不再 pending。
 * 不能只等 `state === 'done'` —— 待触发的 chip 也是 done，那会让"译文出来没有"这件事读成假阳性。
 */
async function settleTranslated() {
  for (let i = 0; i < 25; i += 1) {
    const tip = await readTip();
    if (tip === null || (tip.variant === 'bubble' && tip.state !== 'pending')) return tip;
    await sleep(120);
  }
  return readTip();
}

async function escapeKey() {
  await api.cdp.key(S, { key: 'Escape', code: 'Escape', keyCode: 27 });
  await sleep(150);
}

async function pressEscape() {
  await api.activate(page.targetId);
  await escapeKey();
}

async function shot(name) {
  const png = await api.cdp.screenshot(S);
  mkdirSync(SHOT_DIR, { recursive: true });
  const file = join(SHOT_DIR, `${name}.png`);
  writeFileSync(file, png);
  return file;
}

const brief = (tip) =>
  tip === null
    ? '无浮层'
    : `variant=${tip.variant} state=${tip.state} buttons=${JSON.stringify(tip.buttons)} text=${JSON.stringify(tip.text.slice(0, 34))}`;

const clearCaches = () =>
  api.extEval(`(async () => { for (const area of [chrome.storage.local, chrome.storage.session]) {
    const all = await area.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('jt:'));
    if (keys.length) await area.remove(keys);
  } })()`);

try {
  // ---------- 前置读数（缺什么一眼看得见，不拿空数据当"通过"） ----------
  const pre = JSON.parse(
    await api.extEval(`(async () => JSON.stringify({
      id: chrome.runtime.id,
      granted: await chrome.permissions.contains({ origins: ['http://127.0.0.1:8787/*'] }),
      settings: (await chrome.storage.local.get('jinyi:settings'))['jinyi:settings'],
    }))()`),
  );
  const settings = pre.settings ?? {};
  console.log(
    '前置:',
    JSON.stringify({
      id: pre.id,
      granted: pre.granted,
      profiles: (settings.profiles ?? []).length,
      engineId: settings.engineId ?? null,
      hoverTranslate: settings.hoverTranslate,
      selectionTranslate: settings.selectionTranslate,
    }),
  );
  if (pre.granted !== true) throw new Error('宿主权限没给：读数会全是 0。用 make-hostperm-dist 的副本起实例');
  if (settings.selectionTranslate === false) throw new Error('「划词翻译」是 off，本场景什么都不会发生');

  // 档案与当前引擎：缺失就用真设置页 UI 建一个指向假引擎的档案（副本的 host 权限是必选的，
  // 所以全程无人值守，不会再弹「允许」）。
  const hasMockProfile = (settings.profiles ?? []).some((p) => /QA Mock/.test(p.label ?? ''));
  if (!hasMockProfile) {
    const seeded = await seedProfileViaUi(api);
    if (seeded.error) throw new Error(`建档失败：${seeded.error}`);
    await api.closeTab(seeded.tab.targetId);
  }
  const engineOk = await api.extEval(`(async () => {
    const s = (await chrome.storage.local.get('jinyi:settings'))['jinyi:settings'];
    return (s?.profiles ?? []).some((p) => p.id === s.engineId) ? 'ok' : 'no-engine';
  })()`);
  if (engineOk !== 'ok') {
    const popup = await api.cdp.openTab(`chrome-extension://${api.id}/popup/popup.html`);
    await sleep(1400);
    await api.cdp.eval(
      popup.sessionId,
      `(() => {
        const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => /QA Mock/.test(o.textContent)));
        const opt = [...(sel?.options ?? [])].find((o) => /QA Mock/.test(o.textContent));
        if (!sel || !opt) return 'no-mock-option';
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      })()`,
    );
    await sleep(900);
    await api.closeTab(popup.targetId);
  }

  await clearCaches();
  await api.engineCtl({ mode: 'ok', reset: true, delayMs: 0 });

  // ---------- ① 划词之后：小气泡可见、引擎侧零请求 ----------
  const s1 = await selectWords('p1', 12);
  const r1 = await requests();
  check(
    '① 划词后：小气泡可见（chip + 「翻译」）且引擎侧零请求',
    s1.tip !== null && s1.tip.variant === 'chip' && JSON.stringify(s1.tip.buttons) === '["翻译"]' && r1 === 0,
    `选区 ${s1.text.length} 字 · 请求数 ${r1} · ${brief(s1.tip)}`,
  );
  const shot1 = await shot('01-chip');

  // ---------- ④ 手停在选区上不动、从不进入气泡：不增 ----------
  await sleep(800);
  const r4 = await requests();
  const tip4 = await readTip();
  check(
    '④ 指针停在选区上不动（没碰气泡）：800ms 后仍然零请求、仍是小气泡',
    r4 === 0 && tip4?.variant === 'chip',
    `请求数 ${r4} · ${brief(tip4)}`,
  );

  // ---------- ② 移到气泡上停 450ms：恰好 +1，且送出的就是选区原文 ----------
  await dwell(tip4 ?? s1.tip);
  await sleep(DWELL_MS);
  const tip2 = await settleTranslated();
  const r2 = await requests();
  const sent2 = (await readLog()).log.at(-1)?.user ?? '';
  check(
    '② 真指针停在小气泡上 450ms：请求数恰好 +1（从 0 到 1）',
    r2 === 1,
    `请求数 ${r2}`,
  );
  check(
    '② 送出的就是选区原文，气泡转成译文 + 单个「复制」',
    sent2.includes(s1.text) && tip2?.variant === 'bubble' && tip2?.state === 'done' &&
      tip2?.text.startsWith('译·') && JSON.stringify(tip2?.buttons) === '["复制"]',
    `送出 ${sent2.length} 字 · ${brief(tip2)}`,
  );
  const shot2 = await shot('02-translated');

  // ---------- ⑦ 译文出来之后指针再移开、再停回来：不再补发第二次 ----------
  await moveAway(tip2);
  await sleep(120);
  await dwell(tip2);
  await sleep(DWELL_MS);
  const r7 = await requests();
  check('⑦ 译文之后指针移开再停回来：不再发第二次请求', r7 === 1, `请求数 ${r7}`);

  // ---------- ③ 只划过不增 ----------
  await pressEscape();
  const before3 = await requests();
  const s3 = await selectWords('p2', 12);
  // 先把指针放到远端（证明"进入气泡"这件事只发生在下面这一串里），再一次性穿过去：
  // 左 → 中 → 右三步之间不睡觉、不 activate，整串耗时打印出来当证据。
  await moveTo(20, 20);
  const sweepStart = Date.now();
  await moveTo(s3.tip.x - 30, s3.tip.y + s3.tip.h / 2);
  await dwell(s3.tip);
  await moveTo(s3.tip.x + s3.tip.w + 120, s3.tip.y + s3.tip.h / 2);
  const sweepMs = Date.now() - sweepStart;
  await sleep(800);
  const r3 = await requests();
  const tip3 = await readTip();
  check(
    `③ 快速划过小气泡（穿越只花 ${sweepMs}ms，远小于 150ms 阈值）：零请求，且小气泡还在原地`,
    r3 === before3 && tip3?.variant === 'chip',
    `选区 ${s3.text.length} 字 · 穿越 ${sweepMs}ms · 请求增量 ${r3 - before3} · ${brief(tip3)}`,
  );

  // ---------- ⑤ 停了一半就关掉气泡：到点也不补发 ----------
  await pressEscape();
  const before5 = await requests();
  const s5 = await selectWords('mixed', 9);
  await dwell(s5.tip);
  await sleep(40); // 没到 150ms
  await escapeKey(); // 不 activate：那 300ms 睡眠会让停留过阈值，这条读数就没意义了
  const closed5 = await readTip();
  await sleep(800);
  const r5 = await requests();
  check(
    '⑤ 停留 40ms 就按 Esc 关闭：之后到点也不补发（计时器随气泡一起作废）',
    closed5 === null && r5 === before5,
    `浮层 ${closed5 === null ? '已关' : '还在'} · 请求增量 ${r5 - before5}`,
  );

  // ---------- ⑥ 真鼠标点「翻译」按钮：+1（故意不等满悬停延时） ----------
  // 用**只双击选一个词**的现场：气泡不会盖住后面的词（p3 那种"By <a>Jane Doe</a>"里，
  // Shift+点击的落点会被气泡吃掉，选区扩不动，上一轮就是这么读出 0 增量的）。
  await pressEscape();
  const before6 = await requests();
  const s6 = await selectWords('code-block', 1);
  await moveTo(s6.tip.btn.x, s6.tip.btn.y);
  await api.cdp.mouse(S, 'mousePressed', s6.tip.btn.x, s6.tip.btn.y, { buttons: 1 });
  await api.cdp.mouse(S, 'mouseReleased', s6.tip.btn.x, s6.tip.btn.y, { buttons: 0 });
  await sleep(100); // < 150ms：这一次请求只可能是"点上来"的
  const tip6 = await settleTranslated();
  const r6 = await requests();
  const sent6 = (await readLog()).log.at(-1)?.user ?? '';
  check(
    '⑥ 真鼠标点小气泡上的「翻译」（100ms 内）：+1 且送出的就是选区',
    r6 === before6 + 1 && sent6.includes(s6.text) && tip6?.state === 'done' && tip6?.text.startsWith('译·'),
    `选区 ${JSON.stringify(s6.text)} · 请求增量 ${r6 - before6} · ${brief(tip6)}`,
  );
  await shot('06-via-button');

  // ---------- ⑩ 真鼠标点译文里的「复制」：回调真的跑起来了（既有 bug 的同一条修复） ----------
  // 这一条是那个"点了没反应"的 bug 在真机上的判据：按钮文案只有在 onClick 回调里才会变，
  // 而回调要跑，Chrome 必须先为这一下按下/抬起合成 click。
  const beforeCopy = (await requests());
  const t10 = await readTip();
  const labelBefore = JSON.stringify(t10?.buttons ?? null);
  await moveTo(t10.btn.x, t10.btn.y);
  await api.cdp.mouse(S, 'mousePressed', t10.btn.x, t10.btn.y, { buttons: 1 });
  await api.cdp.mouse(S, 'mouseReleased', t10.btn.x, t10.btn.y, { buttons: 0 });
  await sleep(300);
  const t10b = await readTip();
  const labelAfter = JSON.stringify(t10b?.buttons ?? null);
  check(
    '⑩ 真鼠标点「复制」：按钮就地改写文案（click 真的合成并派发到了按钮）',
    labelBefore === '["复制"]' && /已复制|复制失败|复制不可用/.test(labelAfter ?? '') && (await requests()) === beforeCopy,
    `${labelBefore} → ${labelAfter} · 请求增量 ${(await requests()) - beforeCopy}`,
  );

  // ---------- ⑧ 右键菜单那条路仍立刻翻（不等悬停） ----------
  await pressEscape();
  const before8 = await requests();
  const s8 = await selectWords('p4', 2);
  await api.sendToPage('jinyi:translate-selection', { text: s8.text });
  await sleep(250);
  const tip8 = await settleTranslated();
  const r8 = await requests();
  check(
    '⑧ 菜单消息（用户逐次明确的动作）不经过小气泡：当场 +1',
    r8 === before8 + 1 && tip8?.variant === 'bubble' && tip8?.text.startsWith('译·'),
    `选区 ${JSON.stringify(s8.text)} · 请求增量 ${r8 - before8} · ${brief(tip8)}`,
  );

  // ---------- ⑨ 隐私闸门在两段式之后仍然合着（真机回归） ----------
  await pressEscape();
  const before9 = await requests();
  const s9 = await selectWords('draft', 6); // contenteditable 草稿
  await sleep(300);
  const r9a = await requests();
  if (s9.tip !== null) {
    await dwell(s9.tip);
    await sleep(DWELL_MS);
  }
  const r9 = await requests();
  check(
    '⑨ 在 contenteditable 草稿里划词：不出小气泡、停上去也不发请求（隐私闸门未被两段式改动削弱）',
    s9.tip === null && r9a === before9 && r9 === before9,
    `草稿选区 ${JSON.stringify(s9.text)} · 浮层 ${s9.tip === null ? '无' : brief(s9.tip)} · 请求增量 ${r9 - before9}`,
  );

  // ---------- ⑫ 静止的指针不起算：计时器只认 pointerenter ----------
  // 想复现的是"chip 恰好出现在指针底下、指针原地不动"。第一次尝试（P 取 chip 底边之下 12px，
  // 再 Shift+点击把选区扩下去）读数证明**这个几何在单次划词下不可达**：chip 的顶边 =
  // 选区块底 + GAP(8)，而任何仍然命中该行文本的落点都在块底之上 ⇒ chip 永远压在指针下面，
  // 盖不到指针。真正会压上的只有"拖选越过最后一行的行底"那一种，而 CDP 拖不出选区
  // （本文件开头第 1 条）。所以这里量的是可达的那半条：**指针没有 enter 进 chip，就不起算**。
  await pressEscape();
  const before12 = await requests();
  const w12 = (await wordPoints('p2'))[1]; // "single"：多字母词，双击可靠
  await api.activate(page.targetId);
  await api.cdp.eval(S, 'getSelection()?.removeAllRanges()');
  await moveTo(w12.x, w12.y);
  await api.cdp.mouse(S, 'mousePressed', w12.x, w12.y, { clickCount: 1 });
  await api.cdp.mouse(S, 'mouseReleased', w12.x, w12.y, { clickCount: 1 });
  await sleep(70);
  await api.cdp.mouse(S, 'mousePressed', w12.x, w12.y, { clickCount: 2 });
  await api.cdp.mouse(S, 'mouseReleased', w12.x, w12.y, { clickCount: 2 });
  await sleep(150);
  const chipA = await readTip();
  const P = { x: w12.x, y: chipA.y + chipA.h + 12 }; // chip 底边之下 12px：明确在盒外
  await moveTo(P.x, P.y);
  await api.cdp.mouse(S, 'mousePressed', P.x, P.y, { modifiers: 8 });
  await api.cdp.mouse(S, 'mouseReleased', P.x, P.y, { modifiers: 8 });
  await sleep(200);
  const tip12 = await readTip();
  const inside =
    tip12 !== null && P.x >= tip12.x && P.x <= tip12.x + tip12.w && P.y >= tip12.y && P.y <= tip12.y + tip12.h;
  await sleep(800); // 指针停在盒外一动不动
  const still12 = await readTip();
  const r12a = await requests();
  check(
    '⑫a 指针停在 chip 之外、原地不动 800ms：零请求，仍是待触发那一屏',
    !inside && r12a === before12 && still12?.variant === 'chip',
    `P=${P.x.toFixed(0)},${P.y.toFixed(0)} 在盒内=${inside}（几何不可达即为结论）· 盒 ${tip12?.x?.toFixed(0)},${tip12?.y?.toFixed(0)},${tip12?.w}×${tip12?.h} · 请求增量 ${r12a - before12}`,
  );
  await moveTo(tip12.x + tip12.w / 2, tip12.y + tip12.h / 2); // 真把指针移进气泡
  await sleep(DWELL_MS);
  const tip12b = await settleTranslated();
  const r12b = await requests();
  check(
    '⑫b 之后把指针移进气泡（第一次 enter）：起算并 +1',
    r12b === before12 + 1 && tip12b?.variant === 'bubble' && tip12b?.text.startsWith('译·'),
    `请求增量 ${r12b - before12} · ${brief(tip12b)}`,
  );
  await shot('12-stationary-pointer');

  await pressEscape();
  await api.cdp.eval(S, 'getSelection()?.removeAllRanges()');
  await api.engineCtl({ mode: 'ok', reset: true, delayMs: 0 });
  console.log('\n截图:', shot1, shot2);
} finally {
  await api.close();
  console.log('\n===== 汇总 =====');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(`合计 ${results.filter((r) => r.pass).length}/${results.length} 通过`);
}
