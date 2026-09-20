// tests/options/engine-expansion.test.ts
/**
 * @vitest-environment jsdom
 *
 * 展开 / 收起是**就地更新**，不是整表重建。
 *
 * 为什么这条值得一个文件：改之前 `bind` 里 `case 'toggle'` 直接调 `renderProfiles`，而那个
 * 函数开头清空整张列表再重建所有行——用户点一次展开的代价随档案数线性增长（N 个档案 = N+1 行）。
 *
 * **读数不是耗时**：本机没有浏览器，jsdom 的毫秒数会飘，本仓已有先例（"为'有守卫'写一条量出来
 * 会飘的断言，不如不写"）。这里数的是**单次展开对 DOM 的改动量**：`MutationObserver` 的
 * `childList` 记录里增删的节点数。它与 N 无关，才是"就地"；旧实现是 2(N+1)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { loadOptions, pick, profileRows, profileSeed, resetOptionsPage, seedSettings, settle } from './harness';

/**
 * 造 N 个档案（id 依次 `p-0`…`p-N-1`）。
 * 刻意**只给 id 与 label**：这条用例关心的是列表规模，不是档案的字段形状
 * （C1 把 `model` 换成 `models` + `activeModel` 时，这里一行都不用改）。
 */
function seeds(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_unused, index) => profileSeed({ id: `p-${index}`, label: `档案 ${index}` }));
}

function rowOf(id: string): HTMLElement {
  const row = profileRows().find((candidate) => candidate.dataset.profileId === id);
  if (row === undefined) throw new Error(`没有档案行 ${id}`);
  return row;
}

function triggerOf(id: string): HTMLButtonElement {
  const trigger = rowOf(id).querySelector<HTMLButtonElement>('[data-action="toggle"]');
  if (trigger === null) throw new Error(`档案行 ${id} 没有展开按钮`);
  return trigger;
}

function editorOf(id: string): Element | null {
  return rowOf(id).querySelector('.profile-editor');
}

/**
 * 点某一行的展开按钮，并等 `MutationObserver` 把这次改动的记录交上来。
 *
 * **不能在 `settle()` 之后另起一个观察者读**：那样读到的是"点击前后两次 DOM 状态之差"，
 * 中间插进来的任何重绘都会被算进去。观察者回调本身就是一次微任务，等它比数宏任务轮次稳。
 */
async function toggleAndCount(id: string): Promise<{ added: number; removed: number }> {
  const trigger = triggerOf(id);
  const records = await new Promise<MutationRecord[]>((resolve) => {
    const observer = new MutationObserver((list) => {
      observer.disconnect();
      resolve(list);
    });
    observer.observe(pick<HTMLElement>('profiles'), { childList: true, subtree: true });
    trigger.click();
  });
  return {
    added: records.reduce((sum, record) => sum + record.addedNodes.length, 0),
    removed: records.reduce((sum, record) => sum + record.removedNodes.length, 0),
  };
}

beforeEach(() => {
  resetOptionsPage();
});

describe('展开就地更新：代价不随档案数增长', () => {
  it('单次展开的 DOM 改动量在 N=5/20/50 下都一样（展开=插 1 个节点，切换=插 1 删 1）', async () => {
    for (const count of [5, 20, 50]) {
      resetOptionsPage();
      await seedSettings({ engineId: 'p-0', profiles: seeds(count) });
      await loadOptions();
      expect(profileRows()).toHaveLength(count);

      // 第一次：从"全部收起"展开一行 → 只该插入这一个编辑器，一个节点都不该删。
      const first = await toggleAndCount('p-0');
      expect([count, first.added, first.removed]).toEqual([count, 1, 0]);

      // 第二次：展开另一行 → 插入新的 + 摘掉上一个，仍然与 N 无关。
      // 旧实现在这里是 added=N+1、removed=N+1（N=5→6/6、N=20→21/21、N=50→51/51）。
      const second = await toggleAndCount(`p-${count - 1}`);
      expect([count, second.added, second.removed]).toEqual([count, 1, 1]);
    }
  });

  it('展开 A 再展开 B：A 收起，A 的编辑器不在 DOM 里、aria-expanded 回到 false', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ id: 'p-a' }), profileSeed({ id: 'p-b', label: '另一家' })],
    });
    await loadOptions();

    // 这条在**旧实现下本来就是绿的**（整表重建也会把 A 的编辑器摘掉）。
    // 它守的不是"改前必红"，而是新实现的三个不变式：
    //   ① 展开新的之前必须摘掉旧的（删掉 `existing.remove()` → 这里红）；
    //   ② 触发按钮的 `aria-expanded` 必须跟着走（删掉那次 setAttribute → 这里红）；
    //   ③ 再点自己一次要收起（把 `expandedId = expandedId === id ? null : id` 写成 `= id` → 这里红）。
    triggerOf('p-a').click();
    await settle();
    expect(editorOf('p-a')).not.toBeNull();
    expect(triggerOf('p-a').getAttribute('aria-expanded')).toBe('true');
    expect(triggerOf('p-b').getAttribute('aria-expanded')).toBe('false');

    triggerOf('p-b').click();
    await settle();
    expect(editorOf('p-b')).not.toBeNull();
    expect(editorOf('p-a')).toBeNull();
    expect(triggerOf('p-a').getAttribute('aria-expanded')).toBe('false');
    expect(triggerOf('p-b').getAttribute('aria-expanded')).toBe('true');

    triggerOf('p-b').click();
    await settle();
    expect(editorOf('p-b')).toBeNull();
    expect(triggerOf('p-b').getAttribute('aria-expanded')).toBe('false');
  });

  it('新增档案那一行也是就地追加：不动已有的行', async () => {
    // 草稿行的插入走 `insertDraftRow`（只 append 一行，排在免费引擎行之前），
    // 不是 `renderProfiles`。断言的读数是"已有行的 DOM 节点身份没变"——
    // 整表重建时这些引用会全部失效（`isConnected` 变 false）。
    await seedSettings({ engineId: 'p-0', profiles: seeds(3) });
    await loadOptions();
    const before = profileRows();
    const freeBefore = pick<HTMLElement>('profiles').querySelector('[data-engine-free]');

    pick<HTMLButtonElement>('add-profile').click();
    await settle();

    const after = profileRows();
    expect(after).toHaveLength(4);
    expect(after[3].dataset.profileId).toBe('__new__');
    // 前三行还是原来那三个节点（同一个对象）。
    expect(after.slice(0, 3)).toEqual(before);
    // 上面那句 `toEqual` **证明不了"同一个对象"**：vitest 对 DOM 元素做的是**结构**比较。
    // 实测（jsdom 元素探针）：两个 class/文本都不同的 div → NOT-EQUAL；两个 class/文本相同的
    // **不同对象** → EQUAL；游离的旧节点 vs 已挂上的新节点（结构相同）→ EQUAL。
    // 于是"只追加、不动已有的行"这个读数必须逐行钉**身份**——`insertDraftRow` 哪天换回
    // `renderProfiles`（整表重建），节点身份全变，这一行当场红（读数是 `[false, false, false]`）。
    expect(after.slice(0, 3).map((row, index) => row === before[index])).toEqual([true, true, true]);
    // 免费引擎那一行也还是原来那个节点，而且排在草稿行之后。
    expect(pick<HTMLElement>('profiles').querySelector('[data-engine-free]')).toBe(freeBefore);
    expect(after[3].nextElementSibling).toBe(freeBefore);
    // 草稿行展开着（新增档案的语义就是"当场开始填"）。
    expect(after[3].querySelector('.profile-editor')).not.toBeNull();
  });
});

/**
 * 真机缺陷（`7991539` 修的）：行头当时是 `<button class="profile-summary">` **里面包着**
 * `<span class="name">` / `<span class="meta">` / `<span class="dot">`。用户点是点在**文字**上的，
 * 于是 `event.target` 是那些 span、不是按钮自己——动作必须从**最近的带 `data-action` 的祖先**上取。
 *
 * 真机读数（用户贴回来的临时探针，5 次点击）：
 * ```
 * target="span.meta"  action="(none)"  row="p-0a90…"  expandedBefore=1 expandedAfter=1 jsMs=0.3 frameMs=4.3
 * target="span.grow"  action="(none)"  row="p-49e2…"  expandedBefore=1 expandedAfter=1 jsMs=0.3 frameMs=3.2
 * target="span.meta"  action="(none)"  row="p-ccca…"  expandedBefore=1 expandedAfter=1 jsMs=0.4 frameMs=4.4
 * target="span.meta"  action="(none)"  row="p-0a90…"  expandedBefore=1 expandedAfter=1 jsMs=0.3 frameMs=6.7
 * target="button.profile-summary" action="toggle" row="p-ccca…" …nodes=294 layoutMs=0
 * ```
 * 5 次点击里 4 次 `action="(none)"`，页面只有 294 个节点、点一次 3~7ms——所以"很慢 / 有时候
 * 没反应"**不是性能问题**：读 `target.dataset.action` 得到 `undefined`，`switch` 全部落空，
 * 只有恰好点在按钮自己的空白边距（padding）上才生效。
 *
 * ⚠ **C4 版式下这条口径的落点变了，读法必须跟着改（这是那一刀里唯一的测试契约变更）**：
 * 折叠行不再是"一个按钮包着行头"，而是 `.grow`（名字 / 徽章 / 状态点 / meta）与
 * `.row-actions`（`编辑` / `删除`）**并排**——行头文字不再挂在任何 `[data-action]` 上。于是：
 * - 点行头文字**不再展开**（那是"整行不再是按钮"的直接后果，第一条用例钉住它，并钉住
 *   展开开关现在是右侧那颗「编辑」）；
 * - 口径本身在新版式里**没有现成的落点**：每个 `[data-action]` 控件都是叶子按钮，两种口径
 *   （`target.dataset.action` 与 `closest('[data-action]')`）读数完全相同。所以后两条用例
 *   **自己造出那个形状**——把按钮的文字包进一个子元素再点它（这正是旧版式的形状，也是将来
 *   给按钮加图标 / 文案子元素时的形状）。少了这两条，真机缺陷会**静默**回来：本地全绿，
 *   只有真机上"点在按钮里的文字上"没反应。
 */
describe('点击委托：动作取自最近的 [data-action] 祖先，不是 event.target 自己', () => {
  /** 行头里那块文字（`span.meta`）——旧版式里真机上用户点的就是它。 */
  function headTextOf(id: string): HTMLElement {
    const text = rowOf(id).querySelector<HTMLElement>('.meta');
    if (text === null) throw new Error(`档案行 ${id} 没有 .meta`);
    return text;
  }

  /**
   * 把触发按钮的文字包进一个子元素并返回它：点它就是"点在按钮**里面的**文字上"。
   * 每次都现造一个（展开 / 收起时按钮文案会变，旧的那个子元素已经不在 DOM 里了）。
   */
  function nestedTextOf(button: HTMLButtonElement): HTMLElement {
    const inner = document.createElement('span');
    inner.className = 'probe-inner';
    inner.textContent = button.textContent ?? '';
    button.textContent = '';
    button.append(inner);
    return inner;
  }

  it('点行头里的文字（span.meta）**不再**展开——整行不是按钮，展开开关是右侧的「编辑」', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed({ id: 'p-a' })] });
    await loadOptions();

    const head = headTextOf('p-a');
    // 先钉住"这确实是一次打在**子元素**上的点击"：它自己身上没有任何动作可读。
    expect(head.dataset.action).toBeUndefined();
    // 版式读数：行头文字**不在**触发按钮里（旧版式里它在）——所以它够不到任何动作。
    // 这一句就是"整行不再是按钮"在委托这一层的读数（`row` 本身也不再是按钮）。
    expect(triggerOf('p-a').contains(head)).toBe(false);

    head.click();
    await settle();
    expect(editorOf('p-a')).toBeNull();
    expect(triggerOf('p-a').getAttribute('aria-expanded')).toBe('false');

    // 新契约的另一半：展开开关是那颗按钮，点它照常展开（点不动的东西才是回归）。
    triggerOf('p-a').click();
    await settle();
    expect(editorOf('p-a')).not.toBeNull();
    expect(triggerOf('p-a').getAttribute('aria-expanded')).toBe('true');
  });

  it('点按钮**里面的**文字就展开——不是只有点在按钮空白处才有反应', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed({ id: 'p-a' })] });
    await loadOptions();

    const inner = nestedTextOf(triggerOf('p-a'));
    // 这条点击打的是**子元素**：它自己身上没有任何动作可读，只有祖先（那个按钮）有。
    // 少了这两句，这条用例在退回 `target.dataset.action` 的实现下也可能因为"点到了别处"而变绿。
    expect(inner.dataset.action).toBeUndefined();
    expect(triggerOf('p-a').contains(inner)).toBe(true);

    inner.click();
    await settle();

    expect(editorOf('p-a')).not.toBeNull();
    expect(triggerOf('p-a').getAttribute('aria-expanded')).toBe('true');
  });

  it('连点那块文字两次 = 展开再收起（取值口径改了，toggle 语义不许跟着变）', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed({ id: 'p-a' })] });
    await loadOptions();

    nestedTextOf(triggerOf('p-a')).click();
    await settle();
    expect(editorOf('p-a')).not.toBeNull();
    expect(triggerOf('p-a').getAttribute('aria-expanded')).toBe('true');

    // 第二次点的是**新造的那个**子元素：按钮的文案在展开时已经换成「收起」，取法不该跟着变。
    nestedTextOf(triggerOf('p-a')).click();
    await settle();
    expect(editorOf('p-a')).toBeNull();
    expect(triggerOf('p-a').getAttribute('aria-expanded')).toBe('false');
  });
});
