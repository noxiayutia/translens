// src/options/sections/glossary.ts
//
// §3.4 术语表：`from → to` 一行一卡片，虚线按钮加一行，失焦（原生 change）即存。
//
// 两条语义在文件头写清楚，免得后来者"顺手优化"掉：
// 1. **草稿行不写存储**（§10.4）：`from` 或 `to` 为空的行不是术语，写进去会让翻译按半个词
//    强制替换。草稿仍然是**真实存在的一行**（有删除按钮），只是它没有存储对应物。
// 2. **草稿位只有一个**：点一次「+ 添加术语」出现一行，再点只是把焦点放回那一行——
//    空白行叠出好几条除了让人困惑没有任何作用。
import type { Term } from '../../engines/types';
import { element, requireWithin, setStatus } from '../dom';
import type { Section, SectionContext } from '../section';
// **这句话只有一个来源**：`store.ts` 导出的 `NOT_LOADED`。四个区块都要在"设置还没读出来"时
// 说同一句话，各写一份字面量迟早会漂成四种说法——`shared/settings.ts` 的 `isAllowedBaseUrl`
// 注释里那条纪律就是这个意思（两处各写一套判据，用户会看到永远查不出来的分歧）。
import { NOT_LOADED } from '../store';

const list = document.getElementById('glossary-list') as HTMLElement;
const addButton = document.getElementById('add-term') as HTMLButtonElement;
const status = document.getElementById('glossary-status') as HTMLElement;

/** 草稿行在不在页面上（它没有存储对应物，所以这份状态只能由界面自己记着）。 */
let draftOpen = false;

function rowsOf(): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>('[data-glossary-row]'));
}

/**
 * 造一行。`term === null` 时是草稿：两个输入都空，**没有**存储对应物。
 *
 * 用户输入只走 `.value`（`textContent` 家族的兄弟——都不是 HTML 解析），
 * 所以 `<img onerror>` 这类内容原样进存储、在页面上也只是一串字符。
 */
function buildRow(index: number, term: Term | null): HTMLElement {
  const row = element('div', 'item');
  row.dataset.glossaryRow = '';
  row.dataset.index = String(index);
  if (term === null) row.dataset.draft = '';

  const from = document.createElement('input');
  from.type = 'text';
  from.className = 'glossary-from';
  from.setAttribute('aria-label', '原文');
  from.autocomplete = 'off';
  from.value = term?.from ?? '';

  const to = document.createElement('input');
  to.type = 'text';
  to.className = 'glossary-to';
  to.setAttribute('aria-label', '译文');
  to.autocomplete = 'off';
  to.value = term?.to ?? '';

  row.append(from, element('span', 'arrow', '→'), to);
  // 草稿行的删除是**界面动作**（收起这一行），既有行的删除是**存储动作**；两者都真实，
  // 所以两种行都有这个按钮。
  const remove = element('button', 'link-danger', '删除');
  remove.type = 'button';
  remove.dataset.action = 'delete-term';
  row.append(remove);
  return row;
}

function renderRows(ctx: SectionContext): void {
  const terms = ctx.settings()?.glossary ?? [];
  list.textContent = '';
  terms.forEach((term, index) => list.append(buildRow(index, term)));
  if (draftOpen) list.append(buildRow(terms.length, null));
  addButton.disabled = draftOpen;
}

/** 把存储里的术语换成新的一份：这是所有写路径的唯一出口。 */
async function writeTerms(ctx: SectionContext, terms: Term[], prefix: string, okMessage: string): Promise<boolean> {
  const ok = await ctx.save(status, prefix, { glossary: terms }, okMessage);
  if (ok) renderRows(ctx);
  return ok;
}

/**
 * 一行的 `change`（＝失焦且值变了）。三种结局，逐条写清楚，因为它们是**决策**不是实现细节：
 *
 * 1. **两边都填了**：既有行就地更新（按下标），草稿行追加成新条目，然后把草稿位收起来。
 * 2. **只填了一半、且是草稿行**：什么都不做（§10.4）。这条路径是**真实用户路径**：用户点「添加
 *    术语」→ 在 from 里打字 → **按 Tab 移到 to**（from 失焦 → change 立刻触发，此刻 to 还是空）。
 *    这里绝不能"当作整行作废"，否则用户敲进去的半行就白填了；等 to 也失焦时第二次 change 才写入。
 * 3. **只填了一半、且是既有行**：**不写存储**，只给一句能读懂的话（存储里仍是原来那条，要删请点
 *    行尾「删除」）。上一版计划在这里选的是"顺手删掉那一条"，被审查挡下了，理由是对的：用户的
 *    真实动作可能是"清掉重打"，在失焦那一刻删条目 + 重绘会让**正在编辑的一行当场消失**，而这份
 *    界面没有任何撤销出口。相比之下，"界面与存储暂时不一致"只要**明说**就是诚实的。
 */
async function commitRow(ctx: SectionContext, row: HTMLElement): Promise<void> {
  const current = ctx.settings();
  if (current === null) return;
  const index = Number(row.dataset.index);
  const from = requireWithin<HTMLInputElement>(row, '.glossary-from').value.trim();
  const to = requireWithin<HTMLInputElement>(row, '.glossary-to').value.trim();
  const terms = current.glossary;

  if (from.length > 0 && to.length > 0) {
    const next: Term[] = index < terms.length
      ? terms.map((term, at) => (at === index ? { from, to } : term))
      : [...terms, { from, to }];
    draftOpen = false;
    await writeTerms(ctx, next, '保存术语失败', '已保存');
    return;
  }

  if (index >= terms.length) return; // 草稿行半填：等另一个框（见上面第 2 条）

  // 既有行被清空：不写存储，也不假装成功；把"存储里还是原来那条"如实说出来。
  setStatus(status, 'err', '这一行没有填完，没有保存；存储里仍是原来那条术语（要删掉请点行尾「删除」）');
}

function deleteRow(ctx: SectionContext, row: HTMLElement): void {
  const current = ctx.settings();
  if (current === null) return;
  const index = Number(row.dataset.index);
  if (index >= current.glossary.length) {
    // 草稿行：只是把这一行收起来，存储无关。
    draftOpen = false;
    renderRows(ctx);
    setStatus(status, 'ok', '');
    return;
  }
  void writeTerms(ctx, current.glossary.filter((_, at) => at !== index), '删除术语失败', '已删除');
}

export const glossarySection: Section = {
  id: 'glossary',
  title: '术语表',
  aliases: ['词库', '专有名词', '术语', '术语库', '词典', 'glossary'],

  bind(ctx: SectionContext): void {
    addButton.addEventListener('click', () => {
      if (ctx.settings() === null) {
        setStatus(status, 'err', NOT_LOADED);
        return;
      }
      draftOpen = true;
      renderRows(ctx);
      // 点完就把光标放进新行：这是用户点这个按钮唯一想干的事。
      rowsOf().at(-1)?.querySelector<HTMLInputElement>('.glossary-from')?.focus();
    });

    // 行是动态渲染的 → 用容器上的委托。`change` 冒泡（`blur` 不冒泡），
    // 所以"失焦即存"这条语义在委托下也成立。
    list.addEventListener('change', (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest<HTMLElement>('[data-glossary-row]');
      if (row === null) return;
      void commitRow(ctx, row);
    });

    list.addEventListener('click', (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.dataset.action !== 'delete-term') return;
      const row = target.closest<HTMLElement>('[data-glossary-row]');
      if (row === null) return;
      deleteRow(ctx, row);
    });
  },

  mount(ctx: SectionContext): void {
    renderRows(ctx);
  },
};
