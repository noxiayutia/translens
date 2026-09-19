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
 * 上一次**确认写入成功**的那一档。回拨要用它——`change` 触发时控件已经被用户拨过了，
 * 手里必须有一份"改之前是什么"的记忆。`mount` 时按存储填，每次保存成功后更新。
 *
 * ⚠ **别把它读成"真正生效的那一档"**：设置从没读出来过时它是 null（`mount` 在那条路径上
 * 直接 return），此时的回拨值取 `false`（理由见 `bindSwitch` 里那句注释），而**内容脚本
 * 那一侧是按 `DEFAULT_SETTINGS` 挂的监听**（`hoverTranslate` / `selectionTranslate` 都是
 * `true`，见 `shared/settings.ts` 的 `DEFAULT_SETTINGS` 与 `content/index.ts` 的
 * `initFeatureSettings` 失败分支）。也就是说那条路径上**界面是 off、页面行为是 on**。
 * 本模块改不了这个不一致（它由内容脚本自己的读失败兜底决定）——这里只是不许把 `false`
 * 说成"生效值"。
 */
const applied: Record<FeatureField, boolean | null> = { hoverTranslate: null, selectionTranslate: null };

/**
 * 把新的开关状态发给所有标签，返回是否有**至少一个**页面确认收到。
 *
 * 逐个 `try/catch`：没有内容脚本的标签（`chrome://`、扩展商店、还没注入的页面）
 * 一定会拒绝，那是正常情况，不该让整条链断掉，也不该被当成"全部失败"。
 *
 * **路标：它现在住在本文件，别 import 它**——第二个需要广播的区块出现时才搬，搬到新模块或
 * `shared/`（**不是 `dom.ts`**：那里的职责是不碰存储与 `chrome` 的纯 DOM 工具）；搬之前先读这里。
 */
async function notifyAllTabs(payload: {
  hoverTranslate: boolean;
  selectionTranslate: boolean;
  targetLang: string;
}): Promise<boolean> {
  const tabs = await chrome.tabs.query({});
  // 叫 `confirmed` 而不是 `applied`：模块级那个 `applied` 是"上一次写入成功的值"（Record），
  // 同名会把这里误读成"在更新那个记忆"。**它只表示"至少有一个页面回了 ok"**，不是逐标签结论。
  let confirmed = false;
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      const reply = (await chrome.tabs.sendMessage(tab.id, { type: MSG.APPLY_SETTINGS, payload })) as
        | { ok?: unknown }
        | undefined;
      if (reply?.ok === true) confirmed = true;
    } catch {
      // 拒绝的原因在 sendMessage 兑现那一刻已经拿不到了（`raw` 被丢在这里），所以别指定单一原因：
      // 多半是这个标签没有接收方（chrome:// 页、没注入内容脚本），也可能是在飞期间端口关了。
      // 两种情况处理相同——继续下一个，不影响"至少一个确认"的判据。
    }
  }
  return confirmed;
}

function bindSwitch(ctx: SectionContext, input: HTMLInputElement, field: FeatureField, label: string): void {
  input.addEventListener('change', () => {
    void (async () => {
      const next = input.checked;
      const ok = await ctx.save(status, `保存${label}失败`, { [field]: next } as Partial<Settings>);
      if (!ok) {
        // 写失败就把开关拨回**上一次确认写入成功**的那一档：停在用户刚拨的值上等于界面撒谎。
        //
        // `applied` 还没填过（设置从没读出来过）时回落到 `false`——**注意它与内容脚本那一侧
        // 的兜底不一致**：`DEFAULT_SETTINGS` 两个字段都是 `true`，读失败的内容脚本照样按
        // `true` 挂监听，于是这里显示 off 而页面行为是 on。**仍然取 `false`**：`true` 会宣称
        // "恢复到了开启"，而这条路径上没有任何东西确认过开启；取显示侧的保守值，别替内容脚本许诺。
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
      // 确认分支只说"**收到通知的**页面"：判据是"至少一个确认"（被丢弃/休眠的标签可能永远不回应，
      // 所以不能要求全部确认，否则常见情况会退化成"重新加载后生效"）。混合结果下——一个正常页
      // 回 `ok`、一个旧内容脚本页什么都不回——"已打开的页面都即时生效"是超出证据的说法。
      setStatus(
        status,
        'ok',
        appliedToPages ? `${label}已更新，收到通知的页面即时生效。` : `${label}已保存；重新加载页面后生效。`,
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
