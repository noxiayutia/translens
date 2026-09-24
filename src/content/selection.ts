// src/content/selection.ts
import { normalizeText } from '../core/lang';
import { isEditable } from './extractor';
import { hideTooltip, isEventInTooltip, isTooltipVisible, setActionLabel, showTooltip, type TooltipRect } from './tooltip';
import { PENDING_TEXT, type InlineTranslation, type InlineTranslator } from './inline-types';

/**
 * 划词翻译气泡。
 *
 * 与悬停共用 {@link tooltip} 的 fixed 浮层：挂在 `document.documentElement` 上、
 * `data-jy-root` 标记、所有文字 `textContent` 写入——对页面内容零插入、零样式注入。
 * 鼠标划词（mouseup）与右键菜单（`MSG.TRANSLATE_SELECTION`）共用同一份选区读取与渲染，
 * 但**触发是两段式的、只管鼠标那一条**：左键划词只弹一个紧凑小气泡（chip，零请求），
 * 指针在上面动一下并停满延时、或点这颗圆点，才发第一次请求。中间这一步不是装饰——
 * 一划中就翻，等于把拖选时带上的半句、错行、整段照发；多出来的那一次停留，
 * 就是"这段真是你要翻的吗"。右键菜单仍**立刻翻**（那是用户逐次明确的动作）。
 */

/** 设计文档 §4.2：长度 1~2000 字符才触发。上限防的是把整页正文一次性送去接口。 */
const MAX_CHARS = 2000;

/**
 * 指针在小气泡上停多久之后才发请求：快速划过时一次都不该发。
 * 与悬停翻译的 `DEFAULT_DELAY_MS` 同一套理由，取值更短——这次指针是**故意**移到气泡上的。
 */
const DEFAULT_HOVER_DELAY_MS = 150;

/** 圆点的无障碍名：屏幕上它一个字都没有，读屏与键盘用户只有这一个名字。 */
const CHIP_BUTTON_LABEL = '翻译选中的文字';

export interface SelectionDeps {
  translate: InlineTranslator;
  /** 测试可以缩短停留时长；生产用默认值（仿 hover.ts 的 delayMs 体例）。 */
  hoverDelayMs?: number;
}

export interface SelectionController {
  /** 挂/摘 mouseup 监听（`selectionTranslate` 开关）。 */
  enable(): void;
  disable(): void;
  /**
   * 右键菜单入口：自己读选区与定位；读不到选区时用菜单带来的文本兜底、视口中央定位。
   * **不受 mouseup 开关管辖**——菜单项是用户逐次明确点击的动作。
   */
  translateFromMenu(fallbackText?: unknown): void;
  /** 页面还原时：作废在飞结果（不摘监听）。 */
  reset(): void;
}

function rectFromRange(range: Range): TooltipRect {
  // jsdom 下 getBoundingClientRect 返回全 0 —— 定位数学对此照常成立（贴到左上边距），测试容忍。
  const rect = range.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function viewportCenter(): TooltipRect {
  return { top: window.innerHeight / 2, left: window.innerWidth / 2, width: 0, height: 0 };
}

/** 选区端点（anchor/focus）所在（或紧邻）的元素；拿不到就返回 null（不判、不误伤）。 */
function selectionEndpointElement(node: Node | null | undefined): Element | null {
  if (node === null || node === undefined) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/**
 * 选区端点是不是落在插件自己的浮层里（气泡里的译文被顺手划中）。
 *
 * 两种形状都得认：① 浏览器把 shadow 里的选区**重定位**到宿主上（Chrome 的做法），
 * 那时端点上带着 `data-jy-root`，`closest()` 一下就命中；② 端点仍指向 shadow 内部的节点——
 * `closest()` **不跨 shadow 边界**，这时它一个 `data-jy-root` 也找不到，必须顺着
 * `getRootNode()` 摸到宿主再判。
 *
 * 漏掉 ② 的后果是真的：译文现在可以被框选去复制（.jy-text 的 user-select:text），
 * 一旦划中就把译文再发去翻译——自翻译循环，还要白烧用户自己付费的额度。
 */
function isOwnOverlay(element: Element | null): boolean {
  if (element === null) return false;
  if (element.closest('[data-jy-root]') !== null) return true;
  const root = element.getRootNode();
  return root instanceof ShadowRoot && root.host.closest('[data-jy-root]') !== null;
}

/** 从 window.getSelection() 读出一份可翻译的划词；不合法返回 null。 */
function readSelection(): { text: string; rect: TooltipRect } | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const text = normalizeText(selection.toString());
  if (text === '' || text.length > MAX_CHARS) return null;
  // 选区起点落在插件自己的浮层里：那不是页面内容，不翻。
  const anchorElement = selectionEndpointElement(selection.anchorNode);
  if (isOwnOverlay(anchorElement)) return null;
  /**
   * 可编辑区域（contenteditable 子树）里的文本是用户**正在写、还没保存**的草稿——隐私，
   * 不是页面内容。整页采集早就不采它（extractor 的 isSkippedForText），划词必须同一口径，
   * 否则恶意页面（或一次不经意的划选）就能把 Gmail/Notion 的正文草稿送进用户自己付费的接口。
   * anchor 与 focus **两端各判一次**（isEditable 内部会向上走祖先，继承与
   * `contenteditable="false"` 的回落语义都复用 extractor 那一份实现，不另写一套）。
   */
  const focusElement = selectionEndpointElement(selection.focusNode);
  if (anchorElement !== null && isEditable(anchorElement)) return null;
  if (focusElement !== null && isOwnOverlay(focusElement)) return null;
  if (focusElement !== null && isEditable(focusElement)) return null;
  const range = selection.getRangeAt(0);
  return { text, rect: rectFromRange(range) };
}

/**
 * 复制译文。分层守卫不管 src/content，这里用 `navigator` 是正当的：
 * 剪贴板是用户点「复制」这一动作的直接后果，没有别的通道可走。
 * 非安全上下文里 `navigator.clipboard` 根本不存在——如实降级成一条提示，不静默。
 *
 * 文案一律走 `setActionLabel`：按钮里还有图标，直接写 `button.textContent` 会把图标抹掉。
 */
function copyTranslation(text: string, button: HTMLButtonElement): void {
  const clipboard = navigator.clipboard;
  if (clipboard === undefined) {
    setActionLabel(button, '复制不可用');
    return;
  }
  clipboard.writeText(text).then(
    () => {
      setActionLabel(button, '已复制');
    },
    () => {
      setActionLabel(button, '复制失败');
    },
  );
}

export function createSelectionTranslator(deps: SelectionDeps): SelectionController {
  const delayMs = deps.hoverDelayMs ?? DEFAULT_HOVER_DELAY_MS;
  let enabled = false;
  let generation = 0;

  /** 第三屏：译文 + 唯一的实心主按钮「复制」。失败态只有错误文案，不挂按钮（没东西可复制）。 */
  function showTranslation(rect: TooltipRect, translation: InlineTranslation): void {
    if (translation.ok) {
      showTooltip(rect, {
        text: translation.text,
        buttons: [
          {
            label: '复制',
            variant: 'primary',
            icon: 'copy',
            onClick: (button) => copyTranslation(translation.text, button),
          },
        ],
      });
      return;
    }
    // 后台/网络失败：气泡里显示错误文案，不静默（失败态没有可复制的东西，不挂按钮）。
    showTooltip(rect, { text: translation.message, state: 'error' });
  }

  /**
   * 第二段：发出那一次请求。
   *
   * `generation` 由调用方决定：小气泡那一条沿用**弹出它的那一代**（停留与请求属于同一次划词），
   * 右键菜单那一条自己先推进一代（见 {@link translateNow}）。
   */
  function sendRequest(text: string, rect: TooltipRect): void {
    const mine = generation;
    showTooltip(rect, { text: PENDING_TEXT, state: 'pending' });
    const present = (result: InlineTranslation): void => {
      // 更新的划词/还原已经发生，或用户已把气泡关掉（点外部/Escape/滚动）：结论丢弃。
      if (mine !== generation || !isTooltipVisible()) return;
      showTranslation(rect, result);
    };
    void deps.translate(text).then(
      present,
      (raw: unknown) => {
        present({
          ok: false,
          message: `翻译失败：${raw instanceof Error ? raw.message : String(raw)}`,
        });
      },
    );
  }

  /**
   * 第一段：只弹小气泡，零请求。进第二段有两条路——指针停在上面满延时（`hoverIntent`，
   * 机制住在浮层里），或点这颗圆点本身（纯悬停对键盘用户是死路，这是确定入口）。
   */
  function showChip(text: string, rect: TooltipRect): void {
    const mine = ++generation;
    /**
     * 世代不等 ⇒ 这一次停留属于**已经被换掉的那个小气泡**（换选区、页面还原 `reset()` 都算——
     * 后者故意不关气泡，只推进世代）。浮层那一侧另有一层一次性保护：触发过就把意图摘掉，
     * 指针再进再出也不会补发第二次。
     */
    const fire = (): void => {
      if (mine !== generation) return;
      sendRequest(text, rect);
    };
    showTooltip(rect, {
      // 圆点上没有任何文字：.jy-text 留空（它仍是常驻活区，节点不换；空活区不播报）。
      text: '',
      variant: 'chip',
      // 整个圆点就是这一个按钮（primary：它是这一屏唯一的实心强调色），iconOnly 让 label
      // 只当无障碍名、不上屏。
      buttons: [{ label: CHIP_BUTTON_LABEL, variant: 'primary', icon: 'translate', iconOnly: true, onClick: fire }],
      hoverIntent: { delayMs, onTrigger: fire },
    });
  }

  /** 立刻翻译：不经过小气泡。右键菜单的每一项都是用户逐次明确的动作，不该再问第二次。 */
  function translateNow(text: string, rect: TooltipRect): void {
    generation += 1;
    sendRequest(text, rect);
  }

  function onMouseup(event: MouseEvent): void {
    /**
     * **只响应真实用户手势。** 页面脚本可以 `window.getSelection().addRange(...)` 把任意
     * DOM 文本（甚至用户正在写的草稿）选起来，再派发一个合成的 mouseup——没有这道闸门，
     * 扩展就成了任意页面的"翻译代理 + 翻译 oracle"：合成事件驱动 → 带用户的 API Key 打
     * 用户自己付费的引擎 → 译文写进页面 JS 读得到的 open Shadow DOM，额度还能被烧穿。
     * `isTrusted` 只有浏览器引擎自己能置 true，页面脚本伪造不了（这正是它存在的全部意义）。
     */
    if (!event.isTrusted) return;
    // 只认主键：右键的 mouseup 属于上下文菜单，走菜单消息那条路径，不该在这里抢跑。
    if (event.button !== 0) return;
    /**
     * 落点在插件自己的浮层里 ⇒ 这是"按了浮层上的按钮"，不是"又划了一次词"。
     *
     * 少了这道判断，真机上两个按钮都是死的：按下圆点 /「复制」时页面上的选区还在，
     * `readSelection` 一律放行 → 这里重开一个小气泡 → `renderBubble` 把**刚被按下的那个节点**
     * 从文档里换掉 → Chrome 不再为这一对按下/抬起合成 click（按下与抬起的目标已断开）。
     * 实测形状：mousedown/mouseup 都带正确的 composedPath 到了按钮，click 永远不来。
     * jsdom 会把手发的 click 打进已脱离的节点，所以这条只在真机暴露——单测里钉的是
     * "被按下的按钮还在文档里"（selection.test.ts 同名那组）。
     */
    if (isEventInTooltip(event)) return;
    const selection = readSelection();
    if (selection === null) return;
    showChip(selection.text, selection.rect);
  }

  function resetState(): void {
    generation += 1;
  }

  return {
    enable() {
      if (enabled) return;
      enabled = true;
      document.addEventListener('mouseup', onMouseup, true);
    },
    disable() {
      if (!enabled) return;
      enabled = false;
      document.removeEventListener('mouseup', onMouseup, true);
      resetState();
      hideTooltip();
    },
    translateFromMenu(fallbackText: unknown) {
      // **这里不需要（也拿不到）isTrusted 检查**：这条路径的触发源是 Chrome 自己的
      // `contextMenus.onClicked`——用户在浏览器 UI 里真的点了菜单项，页面脚本既派发不了
      // 也伪造不了这次点击（它连菜单什么时候弹、用户点没点都无从干预）。文本来源同样在
      // 浏览器一侧：优先读真实选区（readSelection 带着可编辑区域闸门），兜底用菜单消息
      // 带过来的 `info.selectionText`——那是浏览器引擎报告的选择状态，不是页面投递的参数。
      const selection = readSelection();
      if (selection !== null) {
        translateNow(selection.text, selection.rect);
        return;
      }
      const text = typeof fallbackText === 'string' ? normalizeText(fallbackText) : '';
      if (text === '' || text.length > MAX_CHARS) return;
      translateNow(text, viewportCenter());
    },
    reset() {
      resetState();
    },
  };
}
