// src/options/sections/shortcuts.ts
//
// §3.3 快捷翻译：悬停与划词两个开关（change 即存），加一行只读的快捷键说明。
//
// 开关的消费者是**内容脚本**（它挂不挂 hover/selection 的监听器）。只写存储不够：
// 已经打开的页面不会因为存储变了而重挂，所以保存成功后必须发一条 `APPLY_SETTINGS`
// ——与弹窗的 `onFeatureToggleChange` 走同一条纪律（见 src/popup/popup.ts）。
//
// **广播给所有标签，不查"当前标签页"**：设置页自己就占着活动标签，`query({active:true,
// currentWindow:true})` 拿到的只会是它自己。`tabs.sendMessage` 不需要 `tabs` 权限，
// 广播的成本是每个标签一条本地消息，没有网络、没有新权限。
import { MSG } from '../../shared/messages';
import type { Settings } from '../../shared/settings';
import { describe, setStatus } from '../dom';
import type { Section, SectionContext } from '../section';

const hoverSwitch = document.getElementById('hover-translate') as HTMLInputElement;
const selectionSwitch = document.getElementById('selection-translate') as HTMLInputElement;
const openShortcutsButton = document.getElementById('open-shortcuts') as HTMLButtonElement;
const status = document.getElementById('shortcuts-status') as HTMLElement;

/** 浏览器自己的快捷键页：扩展无法代改快捷键（Chrome 要求用户手势），只能指路。 */
const SHORTCUTS_URL = 'chrome://extensions/shortcuts';

type FeatureField = 'hoverTranslate' | 'selectionTranslate';

/**
 * 上一次**确认生效**的取值。回滚要用它——`change` 触发时控件已经被用户拨过了，
 * 手里必须有一份"改之前是什么"的记忆。`mount` 时按存储填，每次保存成功后更新。
 */
const applied: Record<FeatureField, boolean | null> = { hoverTranslate: null, selectionTranslate: null };

/**
 * 把新的开关状态发给所有标签，返回是否有**至少一个**页面确认收到。
 *
 * 逐个 `try/catch`：没有内容脚本的标签（`chrome://`、扩展商店、还没注入的页面）
 * 一定会拒绝，那是正常情况，不该让整条链断掉，也不该被当成"全部失败"。
 */
async function notifyAllTabs(payload: {
  hoverTranslate: boolean;
  selectionTranslate: boolean;
  targetLang: string;
}): Promise<boolean> {
  const tabs = await chrome.tabs.query({});
  let applied = false;
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      const reply = (await chrome.tabs.sendMessage(tab.id, { type: MSG.APPLY_SETTINGS, payload })) as
        | { ok?: unknown }
        | undefined;
      if (reply?.ok === true) applied = true;
    } catch {
      // 这个标签没有接收方（chrome:// 页、没注入内容脚本的页面）。继续下一个。
    }
  }
  return applied;
}

function bindSwitch(ctx: SectionContext, input: HTMLInputElement, field: FeatureField, label: string): void {
  input.addEventListener('change', () => {
    void (async () => {
      const next = input.checked;
      const ok = await ctx.save(status, `保存${label}失败`, { [field]: next } as Partial<Settings>);
      if (!ok) {
        // 写失败就把开关拨回**真正生效**的那一档：停在用户刚拨的值上等于界面撒谎。
        // `applied` 还没填过（设置没读出来就拨）时回落到 false —— 那也是 HTML 里的初始值。
        input.checked = applied[field] ?? false;
        return;
      }
      applied[field] = next;
      const current = ctx.settings();
      if (current === null) return;
      let appliedToPages = false;
      try {
        appliedToPages = await notifyAllTabs({
          hoverTranslate: current.hoverTranslate,
          selectionTranslate: current.selectionTranslate,
          // 顺带报一次目标语言：内容脚本手里那份可能已经过期（朗读语种用）。
          targetLang: current.targetLang,
        });
      } catch (raw) {
        setStatus(status, 'err', `已保存，但通知已打开的页面失败：${describe(raw)}`);
        return;
      }
      setStatus(
        status,
        'ok',
        appliedToPages ? `${label}已更新，已打开的页面即时生效。` : `${label}已保存；重新加载页面后生效。`,
      );
    })();
  });
}

export const shortcutsSection: Section = {
  id: 'shortcuts',
  title: '快捷翻译',
  aliases: ['悬停', '划词', '快捷键', '右键菜单', 'Alt+T', 'Alt+Shift', '开关'],

  bind(ctx: SectionContext): void {
    bindSwitch(ctx, hoverSwitch, 'hoverTranslate', '悬停翻译');
    bindSwitch(ctx, selectionSwitch, 'selectionTranslate', '划词翻译');
    openShortcutsButton.addEventListener('click', () => {
      // tabs.create 不需要任何权限；失败也只是"没打开"，如实说一句。
      void chrome.tabs.create({ url: SHORTCUTS_URL }).catch((raw: unknown) => {
        setStatus(status, 'err', `打不开浏览器的快捷键页：${describe(raw)}`);
      });
    });
  },

  mount(ctx: SectionContext): void {
    const current = ctx.settings();
    if (current === null) return;
    hoverSwitch.checked = current.hoverTranslate;
    selectionSwitch.checked = current.selectionTranslate;
    applied.hoverTranslate = current.hoverTranslate;
    applied.selectionTranslate = current.selectionTranslate;
  },
};
