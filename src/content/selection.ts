// src/content/selection.ts
import { normalizeText } from '../core/lang';
import { hideTooltip, isTooltipVisible, showTooltip, type TooltipRect } from './tooltip';
import { PENDING_TEXT, type InlineTranslation, type InlineTranslator } from './inline-types';

/**
 * 划词翻译气泡。
 *
 * 与悬停共用 {@link tooltip} 的 fixed 浮层：挂在 `document.documentElement` 上、
 * `data-jy-root` 标记、所有文字 `textContent` 写入——对页面内容零插入、零样式注入。
 * 鼠标划词（mouseup）与右键菜单（`MSG.TRANSLATE_SELECTION`）走**同一条路径**。
 */

/** 设计文档 §4.2：长度 1~2000 字符才触发。上限防的是把整页正文一次性送去接口。 */
const MAX_CHARS = 2000;

export interface SelectionDeps {
  translate: InlineTranslator;
  /** 朗读用的语言：当前目标语言。取函数是因为设置可能中途被改。 */
  targetLang: () => string;
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

/** 从 window.getSelection() 读出一份可翻译的划词；不合法返回 null。 */
function readSelection(): { text: string; rect: TooltipRect } | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const text = normalizeText(selection.toString());
  if (text === '' || text.length > MAX_CHARS) return null;
  // 选区起点落在插件自己的浮层里（气泡文本被顺手划中）：那不是页面内容，不翻。
  const anchorNode = selection.anchorNode;
  const anchorElement = anchorNode?.nodeType === Node.ELEMENT_NODE ? (anchorNode as Element) : anchorNode?.parentElement;
  if (anchorElement?.closest('[data-jy-root]')) return null;
  const range = selection.getRangeAt(0);
  return { text, rect: rectFromRange(range) };
}

function speak(text: string, lang: string): void {
  const synthesis = window.speechSynthesis;
  // 老引擎/测试环境可能整段缺席：没有语音通道就什么都不做（按钮不做 Promise 状态可观察，
  // 这条路径没有可靠的失败信号可显示，静默是这里唯一不撒谎的选择——朗读本身是锦上添花）。
  if (synthesis === undefined || typeof SpeechSynthesisUtterance !== 'function') return;
  // 重新划词/换段时先停下上一段：两段语音叠着念不是"朗读"。
  synthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  // 设计文档 §4.2：用当前目标语言念，而不是让引擎按原文语种猜。
  utterance.lang = lang;
  synthesis.speak(utterance);
}

/**
 * 复制译文。分层守卫不管 src/content，这里用 `navigator` 是正当的：
 * 剪贴板是用户点「复制」这一动作的直接后果，没有别的通道可走。
 * 非安全上下文里 `navigator.clipboard` 根本不存在——如实降级成一条提示，不静默。
 */
function copyTranslation(text: string, button: HTMLButtonElement): void {
  const clipboard = navigator.clipboard;
  if (clipboard === undefined) {
    button.textContent = '复制不可用';
    return;
  }
  clipboard.writeText(text).then(
    () => {
      button.textContent = '已复制';
    },
    () => {
      button.textContent = '复制失败';
    },
  );
}

export function createSelectionTranslator(deps: SelectionDeps): SelectionController {
  let enabled = false;
  let generation = 0;

  function bubble(rect: TooltipRect, translation: InlineTranslation): void {
    if (translation.ok) {
      showTooltip(rect, {
        text: translation.text,
        buttons: [
          { label: '复制', onClick: (button) => copyTranslation(translation.text, button) },
          { label: '朗读', onClick: () => speak(translation.text, deps.targetLang()) },
        ],
      });
      return;
    }
    // 后台/网络失败：气泡里显示错误文案，不静默（失败态没有可复制/朗读的东西，不挂按钮）。
    showTooltip(rect, { text: translation.message });
  }

  function run(text: string, rect: TooltipRect): void {
    const mine = ++generation;
    showTooltip(rect, { text: PENDING_TEXT });
    const present = (result: InlineTranslation): void => {
      // 更新的划词/还原已经发生，或用户已把气泡关掉（点外部/Escape/滚动）：结论丢弃。
      if (mine !== generation || !isTooltipVisible()) return;
      bubble(rect, result);
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

  function onMouseup(event: MouseEvent): void {
    // 只认主键：右键的 mouseup 属于上下文菜单，走菜单消息那条路径，不该在这里抢跑。
    if (event.button !== 0) return;
    const selection = readSelection();
    if (selection === null) return;
    run(selection.text, selection.rect);
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
      const selection = readSelection();
      if (selection !== null) {
        run(selection.text, selection.rect);
        return;
      }
      const text = typeof fallbackText === 'string' ? normalizeText(fallbackText) : '';
      if (text === '' || text.length > MAX_CHARS) return;
      run(text, viewportCenter());
    },
    reset() {
      resetState();
    },
  };
}
