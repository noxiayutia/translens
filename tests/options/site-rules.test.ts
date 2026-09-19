// tests/options/site-rules.test.ts
/**
 * @vitest-environment jsdom
 *
 * §3.5 站点规则的**写入侧**：增删规则、域名规范化、非法形状拒绝、动作恒为 `never`。
 * 匹配语义本身（精确 / `*.` 通配 / 首条命中）在 `tests/core/site-rules.test.ts`，这里不重复。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_VERSION } from '../../src/shared/settings';
import { bubble, chromeStub, loadOptions, pick, resetOptionsPage, seedSettings, settle, storedSettings, waitFor } from './harness';

interface StoredRule {
  pattern: string;
  action: string;
}

function rows(): HTMLElement[] {
  return Array.from(pick<HTMLElement>('site-rules-list').querySelectorAll<HTMLElement>('[data-rule-row]'));
}

function rowAt(index: number): HTMLElement {
  const row = rows().find((candidate) => candidate.dataset.index === String(index));
  if (row === undefined) throw new Error(`没有第 ${index} 条规则`);
  return row;
}

function patternOf(row: HTMLElement): HTMLInputElement {
  const input = row.querySelector<HTMLInputElement>('.rule-pattern');
  if (input === null) throw new Error('规则行缺 .rule-pattern');
  return input;
}

function status(): HTMLElement {
  return pick<HTMLElement>('site-rules-status');
}

async function storedRules(): Promise<StoredRule[]> {
  return ((await storedSettings()).siteRules ?? []) as StoredRule[];
}

/** 填一条并"失焦"：值改掉 → 派发冒泡的 change。 */
function commit(row: HTMLElement, value: string): void {
  const input = patternOf(row);
  input.value = value;
  input.dispatchEvent(bubble('change'));
}

beforeEach(() => {
  resetOptionsPage();
});

describe('设置页：站点规则（写入侧）', () => {
  it('按存储渲染，动作一律显示「永不翻译」，且**没有**可选的动作控件', async () => {
    await seedSettings({
      siteRules: [
        { pattern: '*.bilibili.com', action: 'never' },
        { pattern: 'docs.kernel.org', action: 'never' },
      ],
    });
    await loadOptions();

    expect(rows()).toHaveLength(2);
    expect(patternOf(rowAt(0)).value).toBe('*.bilibili.com');
    expect(rowAt(0).querySelector('[data-rule-action]')?.getAttribute('data-rule-action')).toBe('never');
    // 规格 §5：**不给**「总是翻译」入口，连一个只有一项的下拉都不做。
    expect(pick<HTMLElement>('site-rules-list').querySelectorAll('select')).toHaveLength(0);
  });

  it('加一条规则、填上域名即落盘，动作写的是 never', async () => {
    await seedSettings({ siteRules: [] });
    await loadOptions();

    pick<HTMLButtonElement>('add-rule').click();
    expect(rows()).toHaveLength(1);

    commit(rowAt(0), 'example.com');

    await waitFor(async () => (await storedRules()).length === 1);
    expect(await storedRules()).toEqual([{ pattern: 'example.com', action: 'never' }]);
    expect(status().dataset.kind).toBe('ok');
  });

  it('整条网址被规范化成主机名后再写进存储（存进去的一定是核心认得的形状）', async () => {
    await seedSettings({ siteRules: [] });
    await loadOptions();
    pick<HTMLButtonElement>('add-rule').click();

    commit(rowAt(0), 'https://WWW.Example.com/');

    await waitFor(async () => (await storedRules()).length === 1);
    expect((await storedRules())[0].pattern).toBe('www.example.com');
    // 输入框里显示的也是规范化后的值：用户看到的就是实际生效的那一条。
    expect(patternOf(rowAt(0)).value).toBe('www.example.com');
  });

  it('非法形状**不写存储**并说清为什么（核心那边是静默不命中，这一侧不许静默）', async () => {
    await seedSettings({ siteRules: [{ pattern: 'keep.me', action: 'never' }] });
    await loadOptions();
    pick<HTMLButtonElement>('add-rule').click();

    commit(rowAt(1), 'example.com:8080');

    await waitFor(() => status().dataset.kind === 'err');
    expect(status().textContent).toContain('端口');
    expect((await storedRules()).map((rule) => rule.pattern)).toEqual(['keep.me']);
  });

  it('打字过程中存储不变（失焦才写）', async () => {
    await seedSettings({ siteRules: [] });
    await loadOptions();
    pick<HTMLButtonElement>('add-rule').click();
    const input = patternOf(rowAt(0));

    input.value = 'exa';
    input.dispatchEvent(bubble('input'));
    // 先给写队列一次排空的机会再读数：写是"排队 + 好几次 await"才落盘的，不 flush 就等于在
    // 写落地之前抢跑——那样下面这句"存储没被动过"恒真，谁把这条路径改成会写它都照样绿。
    await settle();
    expect(await storedRules()).toEqual([]);
  });

  it('既有行的域名被清空：**不写存储**、给一句能读懂的话，要删得点行尾「删除」', async () => {
    // 与术语表同一条口径（**自己说清，别指向另一个文件**）：用户可能只是"清掉重打"，
    // 在失焦那一刻顺手删条目 + 重绘会让他正在编辑的一行当场消失，且没有撤销出口。
    // 所以这里只**如实说明**"没有保存、存储里仍是原来那条、要删请点行尾「删除」"。
    await seedSettings({
      siteRules: [
        { pattern: 'a.com', action: 'never' },
        { pattern: 'b.com', action: 'never' },
      ],
    });
    await loadOptions();

    patternOf(rowAt(0)).value = '';
    patternOf(rowAt(0)).dispatchEvent(bubble('change'));

    await waitFor(() => (status().textContent ?? '').includes('没有保存'));
    expect(status().dataset.kind).toBe('err');
    expect((await storedRules()).map((rule) => rule.pattern)).toEqual(['a.com', 'b.com']);
    expect(rows()).toHaveLength(2);

    // 明确的删除动作才真的删。
    rowAt(0).querySelector<HTMLButtonElement>('[data-action="delete-rule"]')!.click();
    await waitFor(async () => (await storedRules()).length === 1);
    expect((await storedRules()).map((rule) => rule.pattern)).toEqual(['b.com']);
  });

  it('行尾红字删除只删那一条，其余顺序原样；草稿行的删除不碰存储', async () => {
    await seedSettings({
      siteRules: [
        { pattern: 'a.com', action: 'never' },
        { pattern: 'b.com', action: 'never' },
      ],
    });
    await loadOptions();

    rowAt(0).querySelector<HTMLButtonElement>('[data-action="delete-rule"]')!.click();
    await waitFor(async () => (await storedRules()).length === 1);
    expect((await storedRules()).map((rule) => rule.pattern)).toEqual(['b.com']);

    pick<HTMLButtonElement>('add-rule').click();
    rowAt(1).querySelector<HTMLButtonElement>('[data-action="delete-rule"]')!.click();
    expect(rows()).toHaveLength(1);
    expect((await storedRules()).map((rule) => rule.pattern)).toEqual(['b.com']);
  });

  it('写入被拒时如实报错（注入一次存储写失败）', async () => {
    await seedSettings({ siteRules: [] });
    await loadOptions();
    pick<HTMLButtonElement>('add-rule').click();
    chromeStub.storage.local.set = async () => {
      throw new Error('存储写入失败');
    };

    commit(rowAt(0), 'example.com');

    await waitFor(() => status().dataset.kind === 'err');
    expect(status().textContent).toContain('保存规则失败');
    expect(await storedRules()).toEqual([]);
  });

  it('写入被版本门禁拒绝时：输入框里留下的是**规范化之后**的形式（写成功会重绘，这句只在失败路径上有读数）', async () => {
    // 与上一条「写入被拒」**同族但不同机制**：上一条注入 `set` 抛错、只看状态行与存储；
    // 这一条走**真实的版本门禁**（存储版本高于本代码 → `loadSettings` 当场拒绝），钉的是
    // `commitRow` 里那句 `input.value = normalized.pattern`。
    //
    // 为什么它非有不可：写成功时 `writeRules` 会 `renderRows` 整表重建，输入框里天然就是
    // 规范化后的值——那句赋值**在成功路径上不可观测**，删掉它全仓 933 条用例全绿
    // （Task 6 变异 5 的实测读数）。只有"写失败了、没有重绘"这条路径能读出它做了什么：
    // 输入框里留下的是**本来要存的那个规范化形式**（`www.example.com`），
    // 而不是用户原样输入的整条网址（`https://WWW.Example.COM/`）。
    await seedSettings({ siteRules: [{ pattern: 'keep.me', action: 'never' }] });
    await loadOptions();

    // 先正常保存一次：证明整条流程在版本被抬高之前是通的，后面那次失败才归因得清。
    pick<HTMLButtonElement>('add-rule').click();
    commit(rowAt(1), 'example.com');
    await waitFor(async () => (await storedRules()).length === 2);

    // 把存储里的设置换成"版本高于本代码"的一份：此后**读**与**写**都会被版本门禁拒绝。
    await seedSettings({
      siteRules: [
        { pattern: 'keep.me', action: 'never' },
        { pattern: 'example.com', action: 'never' },
      ],
      version: CURRENT_VERSION + 1,
    });
    const raised = await storedSettings();

    // 草稿行填一个**必须规范化**的值：整条网址 → 主机名（带路径的会在规范化阶段就被拒，
    // 读的是另一条分支，见上面「非法形状」那条用例）。
    pick<HTMLButtonElement>('add-rule').click();
    commit(rowAt(2), 'https://WWW.Example.COM/');

    await waitFor(() => status().dataset.kind === 'err');
    expect(status().textContent).toContain('保存规则失败');
    // 归因也要钉住：失败必须来自**版本门禁**（而不是碰巧撞上别的错），否则这条用例
    // 会在"版本门禁哪天不生效了、写失败另有其因"时静默变成另一回事。
    // 断言这句跨模块文案是**故意**的漂移探测器，与 `store.test.ts` 的 `toContain('高于当前支持')` 同款。
    expect(status().textContent).toContain('高于当前支持');
    // **本用例的重点**：写失败、界面没有重绘，输入框里仍是"规范化之后"的那一份。
    expect(patternOf(rowAt(2)).value).toBe('www.example.com');
    // 存储一个字节都没动（连"抬高版本"留下的那一份都原样）。
    expect(await storedSettings()).toEqual(raised);
    expect((await storedRules()).map((rule) => rule.pattern)).toEqual(['keep.me', 'example.com']);
  });

  it('区里写清两条边界：划词/悬停不受约束、已翻译页面不受回头管', async () => {
    await seedSettings();
    await loadOptions();
    const text = pick<HTMLElement>('sec-site-rules').textContent ?? '';
    expect(text).toContain('划词与悬停翻译不受约束');
    expect(text).toContain('已经翻译过的页面');
  });

  it('把既有规则改成一个新的合法值：**就地更新**——条数不变、只有那一行变、顺序不变', async () => {
    // 这条钉的是 `index < rules.length ? rules.map(…) : [...rules, next]` 的**真分支**。
    // 没有它，"编辑既有规则"完全可能被写成"追加一条"（条数变多、旧规则还在），而上面 9 条用例
    // 与原来的 7 行变异表**一条都杀不掉**——Task 5 的实测结论是：这一类分支在升级前全仓 907 条
    // 用例无人能杀（`index < rules.length` 的真分支从未被执行）。所以这条**不是**锦上添花。
    await seedSettings({
      siteRules: [
        { pattern: 'a.com', action: 'never' },
        { pattern: 'b.com', action: 'never' },
      ],
    });
    await loadOptions();

    commit(rowAt(0), 'edited.example.com');

    await waitFor(async () => (await storedRules())[0]?.pattern === 'edited.example.com');
    expect(await storedRules()).toEqual([
      { pattern: 'edited.example.com', action: 'never' },
      { pattern: 'b.com', action: 'never' },
    ]);
    // 条数与顺序都不变：追加式实现在这里会得到 3 条、且旧规则还在。
    expect(await storedRules()).toHaveLength(2);
    expect(rows()).toHaveLength(2);
    expect(patternOf(rowAt(0)).value).toBe('edited.example.com');
  });

  it('草稿行的域名为空时：**什么都不发生**——不写存储，连状态行都不许碰', async () => {
    // ⚠️ 只断言"状态行不含『已保存』"是**不够**的：既有行被清空时落下去的文案是「没有保存」，
    // 它本来也不含那个子串——那条断言抓不到"草稿行也顺手写了一句"这个缺陷。
    // 真正要钉的是草稿行那一支（`if (index >= rules.length) return;`）**根本不动状态行**。
    await seedSettings({ siteRules: [{ pattern: 'keep.me', action: 'never' }] });
    await loadOptions();

    // 先制造一个"已知状态"：把既有行保存一次 → 状态行变成「已保存（按 keep.me 匹配）」。
    commit(rowAt(0), 'keep.me');
    await waitFor(() => status().dataset.kind === 'ok');
    const textBefore = status().textContent;
    const kindBefore = status().dataset.kind;

    // 再加一个草稿行、派发一次 change（域名为空）——这一支必须静默。
    pick<HTMLButtonElement>('add-rule').click();
    commit(rowAt(1), '');

    // 先排空写队列再读数（状态行与存储两处都要）：这一支必须**完全静默**，而"什么都没发生"
    // 只有在队列排空之后才读得准——抢跑时读到的是"还没来得及写"，不是"没写"。
    await settle();

    expect(status().textContent).toBe(textBefore);
    expect(status().dataset.kind).toBe(kindBefore);
    expect(await storedRules()).toEqual([{ pattern: 'keep.me', action: 'never' }]);
    expect(rows()).toHaveLength(2);
  });
});
