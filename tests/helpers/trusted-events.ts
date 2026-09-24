// tests/helpers/trusted-events.ts
/**
 * jsdom 里的「真实用户手势」模拟器。
 *
 * 划词（mouseup）与悬停（mouseover/keydown）的入口只认 `event.isTrusted`——那是
 * 安全闸门：页面脚本 `dispatchEvent` 出来的合成事件不得驱动扩展去烧用户自己付费的
 * 翻译额度。而 jsdom 的 `dispatchEvent` 在入口无条件把实现层的 `isTrusted` 写成
 * false（见 jsdom `EventTarget-impl.js`），且 wrapper 上的 `isTrusted` 访问器属性是
 * **不可配置**的——`Object.defineProperty(event, 'isTrusted', …)` 会直接抛
 * `TypeError: Cannot redefine property`。唯一写得动的地方是实现对象（`Symbol(impl)`
 * 背后）那个普通数据字段。
 *
 * 办法：本模块在 **import 时**（测试文件必须在任何 `controller.enable()` 之前 import）
 * 给 window 挂上最早的捕获监听；当一次派发被「上膛」时，在生产监听器看到事件之前把
 * 它的 `isTrusted` 翻回 true。`dispatchEvent` 是同步跑完的，所以膛只罩住这一次派发。
 *
 * **成对纪律**：正向用 {@link dispatchTrusted}，负向用 {@link dispatchSynthetic}——
 * 同一块派发代码路径，唯一区别就是可信标志。只测负向会掩盖「永远拒绝」的假通过。
 */

let armed = false;

function implOf(event: Event): { isTrusted: boolean } | null {
  const holder = event as unknown as Record<symbol, unknown>;
  for (const symbol of Object.getOwnPropertySymbols(event)) {
    if (symbol.description !== 'impl') continue;
    const impl = holder[symbol];
    if (typeof impl === 'object' && impl !== null) return impl as { isTrusted: boolean };
  }
  return null;
}

/** 需要伪可信的事件类型。捕获阶段挂 window：事件派发路径以 window 为最上游，
 *  这里排在任何 document/window 上的生产监听器之前（本模块的 import 早于 enable()）。 */
const FLIPPED_TYPES = [
  'mouseup',
  'mousedown',
  'pointerdown',
  'mouseover',
  // 划词小气泡的悬停意图同样只认真实指针（tooltip.ts 的 hoverIntent：起算在 pointermove）。
  'pointerenter',
  'pointerleave',
  'pointermove',
  'keydown',
  'keyup',
  // 诊断模式（Alt+Shift+点击）也走同一个 isTrusted 闸门，见 content/diagnose.ts。
  'click',
] as const;

for (const type of FLIPPED_TYPES) {
  window.addEventListener(
    type,
    (event) => {
      if (!armed) return;
      const impl = implOf(event as Event);
      if (impl !== null) impl.isTrusted = true;
    },
    true,
  );
}

/** 以真实用户手势派发（生产代码看到的 `isTrusted === true`）。 */
export function dispatchTrusted(target: EventTarget, event: Event): void {
  armed = true;
  try {
    target.dispatchEvent(event);
  } finally {
    armed = false;
  }
}

/** 以页面脚本合成事件派发（`isTrusted === false`，与真实页面上的恶意派发同形）。 */
export function dispatchSynthetic(target: EventTarget, event: Event): void {
  target.dispatchEvent(event);
}
