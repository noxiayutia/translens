// src/options/perf-probe.ts
//
// **临时诊断探针，不是产品功能**：用户报「点开服务商很慢，有时点了没反应」，而开发机
// 没有浏览器，量不到真机数字——所以把测量点装进扩展，让真机把数字带回来。
// **诊断结束就删掉这个文件**（连同 `options.ts` 里那一行接线）。
//
// 开关：在设置页控制台执行一次 `localStorage.jyPerf = '1'`。默认关；不开时这
// 个模块只读一次 `localStorage` 就返回，对正常使用零影响（也零性能影响）。
//
// 它测什么、为什么这么测：
// 1. **点击落在哪**：`target`（tag + class）、`data-action`、命中哪一行。用来判「没反应」
//    是落在死区（卡片之间的空隙、编辑器内部）还是别的原因。
// 2. **点击前后的展开行数**：同一行短时间内出现两条日志 = **双击互抵**（先展开、后收起，
//    屏幕上看起来什么都没发生）——这是"慢导致用户多点一次"的直接证据。
// 3. **两个 rAF 的差值**：第一个 rAF ≈ 我们的同步 JS 走完、还在一帧之内；第二个 rAF ≈
//    跨过一帧（含样式重算/布局/绘制的调度）。两者都含 ~16ms 的帧节拍，看差值比看绝对值有意义。
// 4. **`layoutMs`**：`setTimeout(0)` 里强制读一次 `offsetHeight`，量的是**样式重算 + 布局**
//    的代价——它是"页面本身很重"与"我们的 JS 很慢"之间的分界线。
// 5. **`nodes` 与 `rows`**：页面节点数、`#profiles` 里的行数。行数为 0 说明设置还没读出来，
//    此时点行会被 `case 'toggle'` 的 `ctx.settings() === null` **静默忽略**（也是一种"没反应"）。
export function installPerfProbe(): void {
  if (localStorage.getItem('jyPerf') !== '1') return;
  const list = document.getElementById('profiles');
  if (list === null) return;

  console.log('[perf] 探针已装（localStorage.jyPerf = "1"；清掉它并重开页面即关闭）');

  list.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const at = performance.now();
      const row = target.closest('[data-profile-id]');
      const probe = {
        target: describeTarget(target),
        // ⚠ 这一格**不能**读 `target.dataset.action`：那正是被测代码当初那个错口径，
        // 探针照抄它就会在修复之后继续打印 `(none)`，把"修好了"读成"没修好"。
        // 验收要看的是 `expandedBefore`/`expandedAfter`（点行头文字后 0 → 1）。
        action: target.closest<HTMLElement>('[data-action]')?.dataset.action ?? '(none)',
        row: row instanceof HTMLElement ? row.dataset.profileId : '(none)',
        rows: document.querySelectorAll('#profiles .profile-row').length,
        expandedBefore: document.querySelectorAll('#profiles .profile-editor').length,
        nodes: document.querySelectorAll('*').length,
      };

      requestAnimationFrame(() => {
        const jsMs = performance.now() - at;
        requestAnimationFrame(() => {
          const frameMs = performance.now() - at;
          setTimeout(() => {
            const started = performance.now();
            void document.body.offsetHeight; // 强制样式重算 + 布局，量它的代价
            const layoutMs = performance.now() - started;
            console.log(
              `[perf] ${JSON.stringify({
                ...probe,
                expandedAfter: document.querySelectorAll('#profiles .profile-editor').length,
                jsMs: round(jsMs),
                frameMs: round(frameMs),
                layoutMs: round(layoutMs),
              })}`,
            );
          }, 0);
        });
      });
    },
    true, // 捕获阶段：抢在区块自己的处理器之前记下"点击那一刻"的状态
  );
}

/** `div.profile-summary.grow` 这种形态：tag 加 class 列表，够认出点在哪。 */
function describeTarget(target: HTMLElement): string {
  const tag = target.tagName.toLowerCase();
  if (target.className === '') return tag;
  return `${tag}.${target.className.split(/\s+/).join('.')}`;
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}
