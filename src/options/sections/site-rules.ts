// src/options/sections/site-rules.ts
//
// §3.5 站点规则的**写入侧**（消费侧在单元 A 已经落地：`src/core/site-rules.ts` 的匹配、
// 内容脚本的拦截、弹窗的一键解除）。
//
// 三个刻意的决定：
// 1. **只写 `never`**。本扩展没有自动翻译，`action: 'translate'` 今天不产生任何可观察行为
//    （规格 §5），所以这一行给的是**静态文字**而不是下拉——一个只有一项的下拉是假控件。
// 2. **域名在失焦时规范化 + 校验**（`../rule-pattern.ts`）：核心匹配器对不认识的写法
//    静默不命中，这一侧的责任就是在写入前挡住或者救回来。
// 3. **草稿行不写存储**（同术语表）：空白规则在核心那边是"什么都不匹配"，
//    但让它进存储只会让列表里多一条看着像规则的空行。
import { element, requireWithin, setStatus } from '../dom';
import { normalizeRulePattern } from '../rule-pattern';
import type { SiteRule } from '../../shared/settings';
import type { Section, SectionContext } from '../section';
// 这句话只有一个来源：`store.ts` 导出的 `NOT_LOADED`。
import { NOT_LOADED } from '../store';

const list = document.getElementById('site-rules-list') as HTMLElement;
const addButton = document.getElementById('add-rule') as HTMLButtonElement;
const status = document.getElementById('site-rules-status') as HTMLElement;

/** 草稿行在不在页面上（它没有存储对应物）。与术语表同一套模型。 */
let draftOpen = false;

function rowsOf(): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>('[data-rule-row]'));
}

// **不自己写 inputWithin**：Task 5 落地时把那份近拷贝删掉了，改用 `dom.ts` 的共享
// `requireWithin(root, selector)`——两个近名函数（`inputWithin(row)` 与
// `requireWithin(root, selector)`）的调用约定**正好相反**，摆在一起迟早有人传错参数。
// 它就在上面 import 进来的 `../dom` 里。

/** 造一行。域名走 `.value`（不是 HTML 解析），动作是静态文字。 */
function buildRow(index: number, rule: SiteRule | null): HTMLElement {
  const row = element('div', 'item');
  row.dataset.ruleRow = '';
  row.dataset.index = String(index);
  if (rule === null) row.dataset.draft = '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rule-pattern';
  input.setAttribute('aria-label', '域名');
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'example.com 或 *.example.com';
  input.value = rule?.pattern ?? '';

  const action = element('span', 'rule-action', '永不翻译');
  // 动作也要是**契约属性**：将来补「总是翻译」时，这个属性就是扩成下拉的落点。
  action.dataset.ruleAction = 'never';

  const remove = element('button', 'link-danger', '删除');
  remove.type = 'button';
  remove.dataset.action = 'delete-rule';

  row.append(input, action, remove);
  return row;
}

function renderRows(ctx: SectionContext): void {
  const rules = ctx.settings()?.siteRules ?? [];
  list.textContent = '';
  rules.forEach((rule, index) => list.append(buildRow(index, rule)));
  if (draftOpen) list.append(buildRow(rules.length, null));
  addButton.disabled = draftOpen;
}

async function writeRules(ctx: SectionContext, rules: SiteRule[], prefix: string, okMessage: string): Promise<boolean> {
  const ok = await ctx.save(status, prefix, { siteRules: rules }, okMessage);
  if (ok) renderRows(ctx);
  return ok;
}

/**
 * 一行的 `change`（＝失焦且值变了）：
 * - 规范化成功：既有行就地更新，草稿行追加成新条目，并把**规范化后的值写回输入框**；
 * - 规范化失败：**不写存储**，把原因说给用户听（输入框保留原文，让他能改）；
 * - 空：草稿行 → 什么都不做（等用户接着填）；**既有行 → 不写存储**，只说明"存储里仍是原来
 *   那条，要删请点行尾「删除」"。**为什么不一并删掉**（自己说清，别指向另一个文件）：用户的真实
 *   动作可能是"清掉重打"，而在失焦那一刻删条目 + 重绘会让**正在编辑的一行当场消失**，这份界面
 *   没有撤销出口；相比之下"界面与存储暂时不一致"只要**明说**就是诚实的（术语表同一口径）。
 */
async function commitRow(ctx: SectionContext, row: HTMLElement): Promise<void> {
  const current = ctx.settings();
  if (current === null) return;
  const index = Number(row.dataset.index);
  const input = requireWithin<HTMLInputElement>(row, '.rule-pattern');
  const raw = input.value.trim();
  const rules = current.siteRules;

  if (raw.length === 0) {
    if (index >= rules.length) return; // 草稿行空着：等他填——**连状态行都不许碰**（Step 5 有专门用例）
    setStatus(status, 'err', '这一条规则没有域名，没有保存；存储里仍是原来那条（要删掉请点行尾「删除」）');
    return;
  }

  const normalized = normalizeRulePattern(raw);
  if (!normalized.ok) {
    // 不写存储，也不假装成功：核心那边这条规则只会静默永不命中。
    setStatus(status, 'err', normalized.reason);
    return;
  }
  input.value = normalized.pattern;
  const next: SiteRule = { pattern: normalized.pattern, action: 'never' };
  const merged = index < rules.length ? rules.map((rule, at) => (at === index ? next : rule)) : [...rules, next];
  draftOpen = false;
  await writeRules(ctx, merged, '保存规则失败', `已保存（按 ${normalized.pattern} 匹配）`);
}

function deleteRow(ctx: SectionContext, row: HTMLElement): void {
  const current = ctx.settings();
  if (current === null) return;
  const index = Number(row.dataset.index);
  if (index >= current.siteRules.length) {
    draftOpen = false;
    renderRows(ctx);
    setStatus(status, 'ok', '');
    return;
  }
  void writeRules(ctx, current.siteRules.filter((_, at) => at !== index), '删除规则失败', '已删除');
}

export const siteRulesSection: Section = {
  id: 'site-rules',
  title: '站点规则',
  aliases: ['域名', '站点', '网站', '规则', '永不翻译', '黑名单'],

  bind(ctx: SectionContext): void {
    addButton.addEventListener('click', () => {
      if (ctx.settings() === null) {
        setStatus(status, 'err', NOT_LOADED);
        return;
      }
      draftOpen = true;
      renderRows(ctx);
      rowsOf().at(-1)?.querySelector<HTMLInputElement>('.rule-pattern')?.focus();
    });

    list.addEventListener('change', (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest<HTMLElement>('[data-rule-row]');
      if (row === null) return;
      void commitRow(ctx, row);
    });

    list.addEventListener('click', (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.dataset.action !== 'delete-rule') return;
      const row = target.closest<HTMLElement>('[data-rule-row]');
      if (row === null) return;
      deleteRow(ctx, row);
    });
  },

  mount(ctx: SectionContext): void {
    renderRows(ctx);
  },
};
