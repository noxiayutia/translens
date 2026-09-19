// tests/options/glossary.test.ts
/**
 * @vitest-environment jsdom
 *
 * §3.4 术语表：一行一条、虚线添加、失焦保存、空行不写存储、用户输入不进 HTML。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { bubble, chromeStub, loadOptions, pick, resetOptionsPage, seedSettings, settle, storedSettings, waitFor } from './harness';

interface StoredTerm {
  from: string;
  to: string;
}

function rows(): HTMLElement[] {
  return Array.from(pick<HTMLElement>('glossary-list').querySelectorAll<HTMLElement>('[data-glossary-row]'));
}

function rowAt(index: number): HTMLElement {
  const row = rows().find((candidate) => candidate.dataset.index === String(index));
  if (row === undefined) throw new Error(`没有第 ${index} 行术语`);
  return row;
}

function inputOf(row: HTMLElement, selector: string): HTMLInputElement {
  const input = row.querySelector<HTMLInputElement>(selector);
  if (input === null) throw new Error(`术语行缺控件 ${selector}`);
  return input;
}

/** 填一行并"失焦"：值改掉 → 派发冒泡的 change。 */
function fill(row: HTMLElement, from: string, to: string): void {
  inputOf(row, '.glossary-from').value = from;
  inputOf(row, '.glossary-to').value = to;
  inputOf(row, '.glossary-to').dispatchEvent(bubble('change'));
}

async function storedGlossary(): Promise<StoredTerm[]> {
  return ((await storedSettings()).glossary ?? []) as StoredTerm[];
}

function status(): HTMLElement {
  return pick<HTMLElement>('glossary-status');
}

beforeEach(() => {
  resetOptionsPage();
});

describe('设置页：术语表', () => {
  it('按存储渲染成一行一条，原样回填', async () => {
    await seedSettings({
      glossary: [
        { from: 'serverless', to: '无服务器' },
        { from: 'droplet', to: '云主机' },
      ],
    });
    await loadOptions();

    expect(rows()).toHaveLength(2);
    expect(inputOf(rowAt(0), '.glossary-from').value).toBe('serverless');
    expect(inputOf(rowAt(0), '.glossary-to').value).toBe('无服务器');
    expect(inputOf(rowAt(1), '.glossary-from').value).toBe('droplet');
    // 没有草稿行的时候，页面上就是存储里的条数。
    expect(rows()).toHaveLength((await storedGlossary()).length);
  });

  it('虚线按钮加一条空行；连点两次不会叠出第二行（一个草稿位就够）', async () => {
    await seedSettings({ glossary: [{ from: 'a', to: 'b' }] });
    await loadOptions();

    pick<HTMLButtonElement>('add-term').click();
    expect(rows()).toHaveLength(2);
    expect(inputOf(rowAt(1), '.glossary-from').value).toBe('');

    pick<HTMLButtonElement>('add-term').click();
    expect(rows()).toHaveLength(2);
    // 存储没有被这次点击碰过。
    expect(await storedGlossary()).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('把一行填满就落盘（不点任何保存按钮），状态的类型是成功', async () => {
    await seedSettings({ glossary: [] });
    await loadOptions();
    pick<HTMLButtonElement>('add-term').click();

    fill(rowAt(0), 'serverless', '无服务器');

    await waitFor(async () => (await storedGlossary()).length === 1);
    expect(await storedGlossary()).toEqual([{ from: 'serverless', to: '无服务器' }]);
    expect(status().dataset.kind).toBe('ok');
  });

  it('落盘后草稿行收起来、`+ 添加术语` 重新可用（少了重绘就会卡在这里）', async () => {
    // 这条单独成例，是为了让"保存成功后必须重绘"这件事有自己的读数：
    // 删掉 `writeTerms` 里的 `if (ok) renderRows(ctx)` → 存储照样对、状态照样是 ok，
    // 但**草稿行留在屏幕上、按钮停在 disabled**（只有 `renderRows` 那一行会复位它），
    // 用户得刷新页面才能加第二条。把它挂在别处会让这一条变异连坐好几例、看不出是谁守的。
    await seedSettings({ glossary: [] });
    await loadOptions();

    pick<HTMLButtonElement>('add-term').click();
    // 草稿行开着时按钮就该是禁用的（此时页面上已经有一行空行，再点没有意义）。
    expect(pick<HTMLButtonElement>('add-term').disabled).toBe(true);

    fill(rowAt(0), 'serverless', '无服务器');

    await waitFor(async () => (await storedGlossary()).length === 1);
    expect(rows()).toHaveLength(1);
    // 落盘的那一行**不是**草稿行，而且按钮回来了。
    expect(rows()[0]?.dataset.draft).toBeUndefined();
    expect(pick<HTMLButtonElement>('add-term').disabled).toBe(false);
  });

  it('打字过程中存储一个字节都不变，失焦（change）之后才写', async () => {
    await seedSettings({ glossary: [] });
    await loadOptions();
    pick<HTMLButtonElement>('add-term').click();
    const input = inputOf(rowAt(0), '.glossary-from');

    input.value = 'half';
    input.dispatchEvent(bubble('input'));
    input.dispatchEvent(bubble('keyup'));
    // 先给写队列一次排空的机会再读数：写是"排队 + 好几次 await"才落盘的，不 flush 就等于在
    // 写落地之前抢跑——那样下面这句"存储没被动过"恒真，谁把这条路径改成会写它都照样绿。
    await settle();
    // §10.3：边打字边写存储既吵又没必要。
    expect(await storedGlossary()).toEqual([]);

    input.value = 'serverless';
    inputOf(rowAt(0), '.glossary-to').value = '无服务器';
    input.dispatchEvent(bubble('change'));
    await waitFor(async () => (await storedGlossary()).length === 1);
  });

  it('只填一半的行**不写存储**，也不凭空长出第二行（§10.4）', async () => {
    await seedSettings({ glossary: [{ from: 'keep', to: '留着' }] });
    await loadOptions();
    pick<HTMLButtonElement>('add-term').click();

    inputOf(rowAt(1), '.glossary-from').value = 'half';
    inputOf(rowAt(1), '.glossary-from').dispatchEvent(bubble('change'));

    expect(await storedGlossary()).toEqual([{ from: 'keep', to: '留着' }]);
    expect(rows()).toHaveLength(2);
    // 半个词不是术语，也不该被当成"用户想删点什么"。
    expect(status().textContent ?? '').not.toContain('已保存');
  });

  it('改既有行是**就地更新**：条数不变，且只有这一行变', async () => {
    // 变异验证逼出来的补充：计划那条「两边都填 → 就地更新（按下标）」的写路径，
    // 原本**没有任何用例走到**——把 `index < terms.length ? 就地改 : 追加` 改成永远追加，
    // 全仓 907 条用例全绿（连同 `npm run typecheck`）。下面两条断言把它钉住：
    // 条数不许长（追加会变 3 条）、且**只有被改的那一行**变。
    await seedSettings({
      glossary: [
        { from: 'one', to: '一' },
        { from: 'two', to: '二' },
      ],
    });
    await loadOptions();

    fill(rowAt(1), 'TWO', '贰');

    await waitFor(async () => (await storedGlossary())[1]?.from === 'TWO');
    expect(await storedGlossary()).toEqual([
      { from: 'one', to: '一' },
      { from: 'TWO', to: '贰' },
    ]);
    expect(rows()).toHaveLength(2);
  });

  it('草稿行只填一半时**连状态行都不碰**：上一条状态逐字留着，既不报错也不说"已保存"', async () => {
    // 规格与 `commitRow` 的注释写的是"什么都不做"。只断言"不说已保存"是不够的——
    // 变异成"落到下面那条既有行的报错分支"（即删掉 `if (index >= terms.length) return;`）
    // 照样全绿，可用户每按一次 Tab 就会看到一句红字，等于在自己还没填完时被指责。
    //
    // 钉的是"**上一条状态不被抹掉**"而不是"状态行初始为空"：后者钉的是 HTML 的初始标记，
    // 将来给状态行加个默认 `kind` 就会因为**与本病无关的原因**变红，报错还会指向这里。
    // 所以先制造一条**真实的、用户看得见的**状态，再证明它逐字留着——顺带把"只清文案"
    // 那种变异也一起杀掉。
    //
    // 这条真实状态**故意用「删除」造、不用「保存」造**：保存那条路径要把按钮重新启用
    // （`writeTerms` 成功后的 `renderRows`），于是"保存成功后不重绘"那个变体会连坐到这里，
    // 让两条用例争同一个读数。删除这条路径不改按钮状态，两个变异各红各的。
    await seedSettings({
      glossary: [
        { from: 'keep', to: '留着' },
        { from: 'gone', to: '删掉' },
      ],
    });
    await loadOptions();
    pick<HTMLButtonElement>('add-term').click();
    rowAt(1).querySelector<HTMLButtonElement>('[data-action="delete-term"]')!.click();
    await waitFor(() => status().dataset.kind === 'ok');
    const kind = status().dataset.kind;
    const message = status().textContent;
    // 前提自检：确实拿到了一条非空状态，否则下面两条断言会退化成"空 == 空"的恒真。
    expect(message).not.toBe('');

    // 草稿行现在排在已有术语后面，在里面只填原文就失焦 —— 等于用户按 Tab 跳到译文。
    // 这里**按 `data-draft` 找那一行、并且只断言与"状态行"有关的事**：不用行数之类的
    // 前置条件，免得"别的路径没重绘"这种无关故障也把它带红（那样报错会指错地方）。
    const draft = rows().at(-1);
    expect(draft?.dataset.draft).toBe('');
    inputOf(draft as HTMLElement, '.glossary-from').value = 'half';
    inputOf(draft as HTMLElement, '.glossary-from').dispatchEvent(bubble('change'));

    expect(await storedGlossary()).toEqual([{ from: 'keep', to: '留着' }]);
    expect(inputOf(draft as HTMLElement, '.glossary-from').value).toBe('half');
    expect(status().dataset.kind).toBe(kind);
    expect(status().textContent).toBe(message);
  });

  it('真实用户路径：先填 from、Tab 到 to（两次 change），第二次才落盘——中途不许写坏存储', async () => {
    // 这是**最常见的输入顺序**，也是上一版计划里唯一没被测到的路径：点添加 → 在 from 里打字 →
    // 按 Tab 移到 to（from 失焦 → change 立刻触发，此刻 to 还是空的）。
    // 若实现把"一框为空"当成"忽略整行"，这一行会在用户还没填完时就被丢掉——所以这里钉住：
    // 第一次 change 什么都不做（存储不变、行还在、输入框的值不动），第二次 change 才写入。
    await seedSettings({ glossary: [] });
    await loadOptions();
    pick<HTMLButtonElement>('add-term').click();

    const from = inputOf(rowAt(0), '.glossary-from');
    const to = inputOf(rowAt(0), '.glossary-to');

    from.value = 'serverless';
    from.dispatchEvent(bubble('change')); // = 用户按 Tab 离开 from
    // 同上：先让写队列排空再读数。这一支**不该写**，而"不该写"只有排空之后读到的才算数——
    // 抢跑读到旧值，会让"半行被写进存储"这个缺陷在这条断言上隐形。
    await settle();
    expect(await storedGlossary()).toEqual([]);
    expect(rows()).toHaveLength(1);
    expect(inputOf(rowAt(0), '.glossary-from').value).toBe('serverless');
    // 中途不许说"已保存"（那会让人以为半个词也生效了）。
    expect(status().textContent ?? '').not.toContain('已保存');

    to.value = '无服务器';
    to.dispatchEvent(bubble('change')); // = 用户离开 to
    await waitFor(async () => (await storedGlossary()).length === 1);
    expect(await storedGlossary()).toEqual([{ from: 'serverless', to: '无服务器' }]);
  });

  it('把既有行清空：**不写存储**、给一句能读懂的话，要删得点行尾「删除」', async () => {
    // **已决**（上一版计划在这里选错了）：既有行被清空时**不**顺手删掉那条术语。
    // 用户的真实动作可能是"清掉重打"——若在失焦那一刻就把条目删了并重绘，用户正在编辑的一行
    // 会当场消失，而且没有任何撤销出口。所以这里只**如实说明**存储里还是原来那条、要删请点删除，
    // 让"界面与存储不一致"变成一句明说的状态，而不是一次静默的破坏。
    await seedSettings({
      glossary: [
        { from: 'one', to: '一' },
        { from: 'two', to: '二' },
      ],
    });
    await loadOptions();

    inputOf(rowAt(0), '.glossary-to').value = '';
    inputOf(rowAt(0), '.glossary-to').dispatchEvent(bubble('change'));

    await waitFor(() => (status().textContent ?? '').includes('没有保存'));
    expect(status().dataset.kind).toBe('err');
    // 存储一个字节都没动，两条都还在。
    expect(await storedGlossary()).toEqual([
      { from: 'one', to: '一' },
      { from: 'two', to: '二' },
    ]);
    // 行也没消失（用户还能接着把它填回去）。
    expect(rows()).toHaveLength(2);

    // 真的要删，走行尾那个红字按钮：那是一次明确的用户动作。
    rowAt(0).querySelector<HTMLButtonElement>('[data-action="delete-term"]')!.click();
    await waitFor(async () => (await storedGlossary()).length === 1);
    expect(await storedGlossary()).toEqual([{ from: 'two', to: '二' }]);
  });

  it('行尾红字删除只删那一条，其余顺序原样', async () => {
    await seedSettings({
      glossary: [
        { from: 'one', to: '一' },
        { from: 'two', to: '二' },
        { from: 'three', to: '三' },
      ],
    });
    await loadOptions();

    rowAt(1).querySelector<HTMLButtonElement>('[data-action="delete-term"]')!.click();

    await waitFor(async () => (await storedGlossary()).length === 2);
    expect((await storedGlossary()).map((term) => term.from)).toEqual(['one', 'three']);
  });

  it('行尾红字删除后**那一行真的从 DOM 里消失**（不只是存储里没了）', async () => {
    // 与上一条分开成例、并且**只断言 DOM 这一件事**：
    // - 上一条看的是**存储**（存的确实是另外两条）；
    // - 这一条看的是**界面**——少了 `deleteRow` 里的 `renderRows`，存储照样对、状态照样是
    //   「已删除」，但被删的那一行**留在屏幕上**，用户看着它还在、以为没删掉。
    // 两件事混在一条里，变异读数就会指向错的那条（上一轮"前置条件抢读数"的教训）。
    await seedSettings({
      glossary: [
        { from: 'one', to: '一' },
        { from: 'two', to: '二' },
        { from: 'three', to: '三' },
      ],
    });
    await loadOptions();
    expect(rows()).toHaveLength(3);

    rowAt(1).querySelector<HTMLButtonElement>('[data-action="delete-term"]')!.click();

    await waitFor(() => rows().length === 2);
    // 删掉的那条也不许留在行里（顺便钉住"剩下的确实是另外两条"，不是随便少了一行）。
    expect(rows().map((row) => inputOf(row, '.glossary-from').value)).toEqual(['one', 'three']);
  });

  it('草稿行上的删除只是收起那一行，存储一个字节不动', async () => {
    await seedSettings({ glossary: [{ from: 'one', to: '一' }] });
    await loadOptions();
    pick<HTMLButtonElement>('add-term').click();

    rowAt(1).querySelector<HTMLButtonElement>('[data-action="delete-term"]')!.click();

    expect(rows()).toHaveLength(1);
    expect(await storedGlossary()).toEqual([{ from: 'one', to: '一' }]);
  });

  it('用户输入走 textContent：`<img onerror>` 原样进存储，页面上不出现元素', async () => {
    await seedSettings({ glossary: [] });
    await loadOptions();
    pick<HTMLButtonElement>('add-term').click();

    const payload = '<img src=x onerror=alert(1)>';
    fill(rowAt(0), payload, payload);

    await waitFor(async () => (await storedGlossary()).length === 1);
    expect((await storedGlossary())[0]).toEqual({ from: payload, to: payload });
    expect(pick<HTMLElement>('glossary-list').querySelectorAll('img')).toHaveLength(0);
  });

  it('写入被拒时如实报错，界面不假装成功（注入一次存储写失败）', async () => {
    await seedSettings({ glossary: [] });
    await loadOptions();
    pick<HTMLButtonElement>('add-term').click();
    chromeStub.storage.local.set = async () => {
      throw new Error('存储写入失败');
    };

    fill(rowAt(0), 'serverless', '无服务器');

    await waitFor(() => status().dataset.kind === 'err');
    expect(status().textContent).toContain('保存术语失败');
    // 存储里没有半条术语；界面上那行还在（用户填的东西不该被吞掉）。
    expect(await storedGlossary()).toEqual([]);
    expect(inputOf(rowAt(0), '.glossary-from').value).toBe('serverless');
  });
});
