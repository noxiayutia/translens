// tests/options/shortcuts.test.ts
/**
 * @vitest-environment jsdom
 *
 * §3.3 快捷翻译：两个开关 change 即存（§4.1），保存成功后**通知所有标签**让页面当场重挂
 * 监听器（与弹窗同一条纪律）；保存失败把开关拨回真正生效的那一档并说出原因。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MSG } from '../../src/shared/messages';
import { SETTINGS_KEY } from '../../src/shared/settings';
import { bubble, chromeStub, loadOptions, pick, resetOptionsPage, seedSettings, storedSettings, waitFor } from './harness';

const SHORTCUTS_URL = 'chrome://extensions/shortcuts';

function hoverSwitch(): HTMLInputElement {
  return pick<HTMLInputElement>('hover-translate');
}

function selectionSwitch(): HTMLInputElement {
  return pick<HTMLInputElement>('selection-translate');
}

function status(): HTMLElement {
  return pick<HTMLElement>('shortcuts-status');
}

/** 拨开关：`checked` 先改掉再派发 change（真机上 change 是在值已经变了之后才发的）。 */
function flip(input: HTMLInputElement, next: boolean): void {
  input.checked = next;
  input.dispatchEvent(bubble('change'));
}

beforeEach(() => {
  resetOptionsPage();
});

describe('设置页：快捷翻译', () => {
  it('按存储回填两个开关（默认都是开）', async () => {
    await seedSettings({ hoverTranslate: false, selectionTranslate: true });
    await loadOptions();

    expect(hoverSwitch().checked).toBe(false);
    expect(selectionSwitch().checked).toBe(true);
  });

  it('拨开关即落盘，并广播 APPLY_SETTINGS 给**所有**标签（不是只给活动标签）', async () => {
    await seedSettings({ hoverTranslate: true });
    await loadOptions();
    // 三个标签：设置页自己也可能在里面，广播的意义就是"谁也不靠猜"。
    chromeStub.tabs.activeTabs = [{ id: 7 }, { id: 8 }, { id: 9 }];
    chromeStub.tabs.responder = () => ({ ok: true });

    flip(hoverSwitch(), false);

    await waitFor(async () => (await storedSettings()).hoverTranslate === false);
    await waitFor(() => chromeStub.tabs.sent.length === 3);
    // 查询条件必须是"全部标签"：写 {active:true,currentWindow:true} 拿到的是设置页自己。
    expect(chromeStub.tabs.queries).toEqual([{}]);
    for (const entry of chromeStub.tabs.sent) {
      const message = entry.message as { type?: unknown; payload?: { hoverTranslate?: unknown } };
      expect(message.type).toBe(MSG.APPLY_SETTINGS);
      expect(message.payload?.hoverTranslate).toBe(false);
    }
    await waitFor(() => (status().textContent ?? '').includes('即时生效'));
    expect(status().dataset.kind).toBe('ok');
  });

  it('一个标签都没确认时如实说"重新加载页面后生效"，但存储照常落盘', async () => {
    await seedSettings({ selectionTranslate: true });
    await loadOptions();
    chromeStub.tabs.activeTabs = [{ id: 7 }];
    chromeStub.tabs.rejectSendMessage = true;

    flip(selectionSwitch(), false);

    await waitFor(async () => (await storedSettings()).selectionTranslate === false);
    await waitFor(() => (status().textContent ?? '').includes('重新加载页面后生效'));
    // 通知失败**不回滚**：设置是真的存下去了，回滚会变成另一种撒谎。
    expect(selectionSwitch().checked).toBe(false);
  });

  it('存储拒绝写入（版本高于本代码）：开关拨回真正生效的那一档，并说出原因', async () => {
    await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: 99 } });
    await loadOptions();

    flip(hoverSwitch(), true);

    await waitFor(() => (status().textContent ?? '').includes('设置还没读出来'));
    expect(status().dataset.kind).toBe('err');
    // 界面不许停在一个没生效的值上。
    expect(hoverSwitch().checked).toBe(false);
    expect(chromeStub.tabs.sent).toEqual([]);
  });

  it('消息送达但页面没确认（旧内容脚本、没回 ok）时同样不谎称"即时生效"', async () => {
    await seedSettings({ hoverTranslate: true });
    await loadOptions();
    chromeStub.tabs.activeTabs = [{ id: 7 }];
    // **刻意不用 `rejectSendMessage`**：那条路走的是"没有接收方 → sendMessage 抛错"，
    // 于是 `notifyAllTabs` 里那句 `reply?.ok === true` 根本不会被求值。把 `responder`
    // 留成 null 时 sendMessage **兑现 undefined**——消息送达了、但没有任何页面确认，
    // 这正是那句守卫唯一被真正判定的分支（把它改成无条件 `applied = true` 会恰好红在这里）。
    expect(chromeStub.tabs.responder).toBe(null);

    flip(hoverSwitch(), false);

    await waitFor(async () => (await storedSettings()).hoverTranslate === false);
    await waitFor(() => (status().textContent ?? '').includes('重新加载页面后生效'));
    // "一个字都没回"**不算确认**：这里若说「即时生效」就是替页面许下一个它没做的承诺。
    expect(status().textContent ?? '').not.toContain('即时生效');
    expect(status().dataset.kind).toBe('ok');
    expect(chromeStub.tabs.sent.length).toBe(1);
  });

  it('「去浏览器设置」开的是 chrome://extensions/shortcuts（快捷键不能由扩展代改）', async () => {
    await seedSettings();
    await loadOptions();

    pick<HTMLButtonElement>('open-shortcuts').click();

    await waitFor(() => chromeStub.tabs.created.length === 1);
    expect(chromeStub.tabs.created).toEqual([{ url: SHORTCUTS_URL }]);
  });
});
