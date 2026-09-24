// 一次性量具体检：按下圆点（划词的 icon-only 按钮）到抬起之间，这个按钮有没有被我们自己换掉。
// 假设：mouseup 落在浮层里 → onMouseup 仍然读到"上一次页面选区" → showChip 重渲染 →
//       按钮节点被 replaceChildren 掉 → Blink 不再合成 click（按下与抬起的目标已断开）。
// 若成立，同一个机制也会咬掉译文气泡里的「复制」按钮——那是既有产品行为，一起验。
// 用法：JY_QA_KEEP=1 JY_QA_DIST=<绝对路径>/.qa/dist-perm node .qa/probe-click3.mjs
import { boot, sleep } from './lib.mjs';

const api = await boot();
const page = await api.openFixture('article.html');
const S = page.sessionId;

const wordPoint = (id, index) =>
  api.cdp.eval(
    S,
    `(() => { const el = document.getElementById(${JSON.stringify(id)});
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const out = [];
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const re = /\\S+/g; let m;
        while ((m = re.exec(n.nodeValue))) {
          const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
          const b = r.getBoundingClientRect();
          if (b.width > 0) out.push({ word: m[0], x: b.x + b.width / 2, y: b.y + b.height / 2 });
        }
      }
      return JSON.stringify(out[${JSON.stringify(index)}] ?? null); })()`,
  ).then((s) => JSON.parse(s));

const tip = () =>
  api.cdp.eval(
    S,
    `(() => { const host = document.querySelector('#jy-tooltip'); if (!host) return null;
      const root = host.shadowRoot; const b = root.querySelector('button');
      const r = b?.getBoundingClientRect();
      return JSON.stringify({ variant: root.querySelector('.jy-bubble')?.getAttribute('data-variant'),
        state: root.querySelector('.jy-bubble')?.getAttribute('data-state'),
        text: (root.querySelector('.jy-text')?.textContent ?? '').trim().slice(0, 26),
        btn: r ? { x: r.x + r.width / 2, y: r.y + r.height / 2, label: b.textContent.trim() } : null }); })()`,
  ).then((s) => (s === null ? null : JSON.parse(s)));

async function makeChip() {
  for (let i = 0; i < 5; i += 1) {
    await api.cdp.key(S, { key: 'Escape', code: 'Escape', keyCode: 27 });
    await sleep(120);
    await api.activate(page.targetId);
    await api.cdp.eval(S, 'getSelection()?.removeAllRanges()');
    const w = await wordPoint('p1', 0);
    await api.cdp.mouse(S, 'mouseMoved', w.x, w.y - 40);
    await api.cdp.mouse(S, 'mousePressed', w.x, w.y, { clickCount: 1 });
    await api.cdp.mouse(S, 'mouseReleased', w.x, w.y, { clickCount: 1 });
    await sleep(60);
    await api.cdp.mouse(S, 'mousePressed', w.x, w.y, { clickCount: 2 });
    await api.cdp.mouse(S, 'mouseReleased', w.x, w.y, { clickCount: 2 });
    await sleep(200);
    const t = await tip();
    if (t?.btn) return t;
  }
  return null;
}

/** 抓住当前按钮节点，抬起之后立刻看它还在不在树上。 */
const pin = () =>
  api.cdp.eval(
    S,
    `(() => { const host = document.querySelector('#jy-tooltip');
      globalThis.__btn = host.shadowRoot.querySelector('button');
      globalThis.__up = [];
      document.addEventListener('mouseup', (e) => globalThis.__up.push({
        inOverlay: e.composedPath().includes(host), sel: String(getSelection()).trim().slice(0, 30),
        connectedBefore: globalThis.__btn?.isConnected ?? null,
      }), true);
      return 'ok'; })()`,
  );

const check = () =>
  api.cdp.eval(
    S,
    `JSON.stringify({ 抬起时在树上: globalThis.__up.map((u) => u), 抬起后在树上: globalThis.__btn?.isConnected ?? null,
      事件: globalThis.__up.length })`,
  );

async function clickAt(p) {
  await api.cdp.mouse(S, 'mouseMoved', p.x, p.y - 60); // 先离开浮层，避免顺带触发悬停意图
  await api.cdp.mouse(S, 'mouseMoved', p.x, p.y);
  await api.cdp.mouse(S, 'mousePressed', p.x, p.y, { buttons: 1 });
  await api.cdp.mouse(S, 'mouseReleased', p.x, p.y, { buttons: 0 });
  await sleep(300);
}

try {
  await api.engineCtl({ mode: 'ok', reset: true });

  // A. chip 的圆点按钮
  const chip = await makeChip();
  console.log('A chip:', JSON.stringify(chip));
  await pin();
  await clickAt(chip.btn);
  console.log('A 抬起前后:', await check());
  console.log('A 结果:', JSON.stringify(await tip()), '请求:', (await api.engineStats()).requests);

  // B. 悬停出来的译文气泡里的「复制」按钮（同一个机制的既有受害者）
  await api.cdp.key(S, { key: 'Escape', code: 'Escape', keyCode: 27 });
  await sleep(150);
  const chip2 = await makeChip();
  await api.activate(page.targetId);
  await api.cdp.mouse(S, 'mouseMoved', chip2.btn.x, chip2.btn.y);
  await sleep(500); // 让悬停意图把译文带出来
  const done = await tip();
  console.log('B 译文气泡:', JSON.stringify(done));
  if (done?.btn?.label === '复制') {
    await pin();
    // 剪贴板在真机上会弹权限/被拒，这里只关心 click 有没有到按钮
    await clickAt(done.btn);
    console.log('B 抬起前后:', await check());
    console.log('B 结果:', JSON.stringify(await tip()));
  }
} finally {
  await api.close();
}
