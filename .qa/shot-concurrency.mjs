// 看一眼设置页「并发请求数」那一行的真实渲染：新提示比旧那句长得多，
// 得确认它在 label 里换行好看、没有把输入框挤走。
// 用法：JY_QA_ATTACH=1 node .qa/shot-concurrency.mjs
import { writeFileSync } from 'node:fs';
import { boot, sleep } from './lib.mjs';

const api = await boot();
try {
  const t = await api.cdp.openTab(`chrome-extension://${api.id}/options/options.html#sec-cache`);
  await sleep(1500);
  const box = await api.cdp.eval(
    t.sessionId,
    `(() => {
      const d = document.getElementById('cache-advanced');
      if (!d) return JSON.stringify({ error: '没有 details' });
      d.open = true;
      const label = document.querySelector('label[for="concurrency"]');
      label.scrollIntoView({ block: 'center' });
      const r = label.getBoundingClientRect();
      const input = document.getElementById('concurrency').getBoundingClientRect();
      return JSON.stringify({
        提示: label.querySelector('small').textContent,
        输入框值: document.getElementById('concurrency').value,
        标签: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        输入框: { x: Math.round(input.x), y: Math.round(input.y), w: Math.round(input.width) },
        视口宽: innerWidth,
      });
    })()`,
  );
  console.log(box);
  await sleep(400);
  writeFileSync('.qa/shots/p3-并发提示.png', await api.cdp.screenshot(t.sessionId));
  await api.closeTab(t.targetId);
  console.log('截图 → .qa/shots/p3-并发提示.png');
} finally {
  await api.close();
}
