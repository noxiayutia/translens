// tests/options/search.test.ts
/**
 * @vitest-environment jsdom
 *
 * §4.2 搜索（轻量版）+ 区块清单的结构守卫。
 *
 * 结构守卫那一段是这一轮"8 组信息架构"的机械保证：导航项、区块元素、搜索索引三者都由
 * `options.ts` 的 `SECTIONS` 驱动，一旦有人加了区块却忘了导航项（或反过来），这里当场红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { matchesTerms, parseQuery } from '../../src/options/search';
import { bubble, loadOptions, mountOptionsHtml, pick, resetOptionsPage, seedSettings, settle } from './harness';

/**
 * 设置页样式表的路径（只给上面那条"CSS 引用的 `#sec-*` 都得存在"的守卫用）。
 * 用 `import.meta.dirname` 拼，而不是 `new URL(..., import.meta.url)`——后者会被 Vite 的
 * 资源转换改写成 http 地址，jsdom 下 `fileURLToPath` 直接拒绝。
 */
const CSS_PATH = join(import.meta.dirname, '..', '..', 'src', 'options', 'options.css');

/** 当前**可见**（没有 `hidden`）的区块 id，按页面顺序。 */
function visibleSections(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-section]'))
    .filter((section) => !section.hidden)
    .map((section) => section.dataset.section as string);
}

function search(query: string): void {
  const input = pick<HTMLInputElement>('search');
  input.value = query;
  input.dispatchEvent(bubble('input'));
}

beforeEach(() => {
  resetOptionsPage();
});

describe('搜索：查询解析与匹配（纯函数）', () => {
  it('空查询不过滤；查询按空白切词、折小写', () => {
    expect(parseQuery('   ')).toEqual([]);
    expect(parseQuery('API  Key')).toEqual(['api', 'key']);
  });

  it('全部命中才算命中（AND，不是 OR）', () => {
    const haystack = ['翻译引擎', 'API Key', '密钥'];
    expect(matchesTerms(haystack, parseQuery('密钥'))).toBe(true);
    expect(matchesTerms(haystack, parseQuery('KEY'))).toBe(true);
    expect(matchesTerms(haystack, parseQuery('密钥 引擎'))).toBe(true);
    // 两个词分属不同区块时，不该因为"任一词命中"就显示出来。
    expect(matchesTerms(haystack, parseQuery('密钥 术语'))).toBe(false);
  });
});

describe('搜索：过滤的是区块，不是 DOM 结构', () => {
  it('占位符写「搜索设置」，不承诺搜不到的一切', async () => {
    await seedSettings();
    await loadOptions();

    expect(pick<HTMLInputElement>('search').placeholder).toBe('搜索设置');
    expect(pick<HTMLInputElement>('search').placeholder).not.toContain('所有');
  });

  it('命中「密钥」只留下翻译引擎：别名指向**真正含该字段**的区块', async () => {
    await seedSettings();
    await loadOptions();

    search('密钥');

    expect(visibleSections()).toEqual(['engine']);
    // 导航项跟着一起藏：点一个能跳到被藏起来的区块的链接没有意义。
    expect(document.querySelector<HTMLElement>('[data-nav="glossary"]')?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-nav="engine"]')?.hidden).toBe(false);
    expect(pick<HTMLElement>('search-empty').hidden).toBe(true);
    // 结构不动：区块元素还在，只是 hidden。
    expect(document.querySelectorAll('[data-section]')).toHaveLength(8);
  });

  it('命中「词库」「专有名词」只留下术语表（与「密钥」成对，防两处漂移）', async () => {
    await seedSettings();
    await loadOptions();

    search('词库');
    expect(visibleSections()).toEqual(['glossary']);

    search('专有名词');
    expect(visibleSections()).toEqual(['glossary']);

    search('API Key');
    expect(visibleSections()).toEqual(['engine']);
  });

  it('隐私区块那一大段正文**不进索引**：搜「密钥」「API Key」「档案」都不点亮隐私', async () => {
    // 这条钉住的是**索引边界本身**，不是某个别名：隐私区块的 `<li>` 与 `<details>` 里到处是
    // 「API Key」「密钥」「档案」这些词（`API Key 只存在本机`、`每个档案都没有这个字段`……）。
    // 一旦有人把 `sectionHaystack` 的选择器放宽（比如顺手加上 `, li` 或整段 `textContent`），
    // 搜「密钥」就会同时点亮隐私与翻译引擎——规格 §4.2 点名要防的正是这个（"搜『密钥』跳出
    // 术语表比搜不到更糟"，跳出隐私同样糟），而**别名互斥守卫抓不到它**（碰撞发生在非别名文本里）。
    await seedSettings();
    await loadOptions();

    const privacy = document.querySelector<HTMLElement>('[data-section="privacy"]')!;
    for (const query of ['密钥', 'API Key', '档案', 'key']) {
      search(query);
      expect([query, visibleSections()]).toEqual([query, ['engine']]);
    }
    // 索引只读这两类元素：隐私区块里没有 `.lab`，`.sec-desc` 也只有一个。
    // **这两条是"防空洞"的护栏**：它们断言的是**文案的形状**（隐私里没有 `.lab`、只有 1 个
    // `.sec-desc`、正文里确实有那些词），不是搜索逻辑本身。将来谁改了隐私文案（加一个 `.lab`、
    // 或者再挂一句 `.sec-desc`），红的是这里——那时该改的是**文案或索引边界**，不是搜索。
    // 这两句注释都按实测改过口，别再退回笼统说法：
    // ① `.lab` 计数这条**不是恒真式**，只是会被上面那圈循环**遮蔽**。往隐私区块插一个 `.lab`：
    //    若那个词正好是某个区块的别名（实测用「密钥」），搜「密钥」先让隐私一起点亮，红在上面
    //    的 `visibleSections()`（收到 `['engine','privacy']`），这条根本轮不到执行；只有当那个
    //    词**不是任何别名**时（实测用「边界说明」），才由这条当场红（`to have a length of +0
    //    but got 1`）。它守的是"隐私区块不长出 `.lab`"，代价是插进来的词不许是别名。
    // ② 上面那句 `.sec-desc` **不是"别名无关的话"**（原文这么写，实测是假话）：它含隐私**自己**
    //    的两个别名——`网络请求`、`可见文本`（`sections/privacy.ts` 的别名表）。但它不含**别的
    //    区块**的别名：全量"别名 × 各区块干草堆"碰撞矩阵实测**跨区块碰撞总数 = 0**，所以别名
    //    互斥与索引边界都不受影响（自己的别名落在自己的干草堆里本来也无害）。
    expect(privacy.querySelectorAll('.lab')).toHaveLength(0);
    expect(privacy.querySelectorAll('.sec-desc')).toHaveLength(1);
    // 而正文里确实有那些词（否则这条用例就是空转）。
    expect(privacy.textContent ?? '').toContain('API Key');
    expect(privacy.textContent ?? '').toContain('档案');
  });

  it('命中的区块，它的导航项必须可见（看得见结果却点不到它，是比搜不到更糟的失败）', async () => {
    await seedSettings();
    await loadOptions();

    for (const [query, id] of [['密钥', 'engine'], ['并发', 'cache'], ['词库', 'glossary']] as const) {
      search(query);
      expect([query, visibleSections()]).toEqual([query, [id]]);
      // `navLink.hidden = !hit`：命中时必须是 false——写反成 `= hit` 就会把结果本身藏掉，
      // 而只断言"区块可见"的用例发现不了（它们不看导航项）。
      expect([query, document.querySelector<HTMLElement>(`[data-nav="${id}"]`)?.hidden]).toEqual([query, false]);
    }
  });

  it('按字段标签找区块：搜「源语言」找到语言与显示，搜「并发」找到缓存与请求', async () => {
    await seedSettings();
    await loadOptions();

    search('源语言');
    expect(visibleSections()).toEqual(['language']);
    // 反向也要守：组里**还有可见链接**时不能把这个分组一起藏掉。把 `every` 写成 `some` 就会——
    // `some` 只要"组里有**任何一个**链接被藏"就为真，于是**过度隐藏**：搜「源语言」时「翻译」
    // 这一组 3 个链接里藏了 2 个（实测 `[["engine",true],["language",false],["shortcuts",true]]`），
    // 组被一起藏掉，**还该可见的「语言与显示」跟着它所在的分组一起消失**。变的是**祖先**的
    // `hidden`，链接自己的 `hidden` 仍是 false，所以只查"命中的区块可见"（那条只看
    // `[data-section]`）或只看 `[data-nav]` 自己 `hidden` 的断言都看不见它——实测：`every` → `some`
    // 之后把下面这一条注释掉，全量用例仍然全绿，放回来才当场红（`expected true to be false`）。
    // 这个选择器只取**第 1 个** `[data-nav-group]`（页面共 3 个：翻译 / 内容控制 / 数据），也就是
    // 「语言与显示」所在的那个分组；分组那段逻辑本身对**每个** `[data-nav-group]` 跑同一套代码。
    expect(document.querySelector<HTMLElement>('[data-nav-group]')?.hidden).toBe(false);

    search('并发');
    expect(visibleSections()).toEqual(['cache']);
    // 导航分组标题跟着藏：只剩一个「翻译」而底下一个链接都没有，比留白更像坏了。
    expect(document.querySelector<HTMLElement>('[data-nav-group]')?.hidden).toBe(true);
  });

  it('零命中：所有区块与导航项都藏起来，「没找到」出现，页面不留白', async () => {
    await seedSettings();
    await loadOptions();

    search('zzzz');

    expect(visibleSections()).toEqual([]);
    expect(pick<HTMLElement>('search-empty').hidden).toBe(false);
    expect(pick<HTMLElement>('search-empty').textContent).toContain('没找到');
  });

  it('清空查询：全部回来，「没找到」收起', async () => {
    await seedSettings();
    await loadOptions();

    search('密钥');
    search('');

    expect(visibleSections()).toHaveLength(8);
    expect(pick<HTMLElement>('search-empty').hidden).toBe(true);
  });

  it('页面里没有 #search：接线不抛，其余区块的监听器照常挂上（少了搜索框 ≠ 整页死掉）', async () => {
    // `bindSearch()` 跑在 `runSafely` **之外**（`init()` 里它在前、兜底在后），所以它一抛，
    // `init()` 当场中断——后面所有区块的监听器都挂不上，页面停在文件顶部注释点名要防的
    // "看着能点、点下去没反应"。这条把那个分界钉住：先摘掉搜索框再加载设置页。
    // 摘掉之前是**承重**的：修复前 `await import(...)` 直接以
    // "Cannot read properties of null (reading 'addEventListener')" 拒绝，这条当场红。
    await seedSettings();
    mountOptionsHtml();
    pick<HTMLElement>('search').remove();
    await import('../../src/options/options');
    await settle();

    // 别的区块照常工作：悬停翻译开关仍然存得下去（它证明 `bind` 那一圈真的跑到了）。
    // 只断言"存成功"这件事，不复述 shortcuts 区块的整句文案（那是它的措辞，不是这条的分界）。
    const toggle = pick<HTMLInputElement>('hover-translate');
    toggle.checked = false;
    toggle.dispatchEvent(bubble('change'));
    await settle();
    const status = pick<HTMLElement>('shortcuts-status');
    expect([status.dataset.kind, status.textContent?.includes('已保存')]).toEqual(['ok', true]);
  });
});

describe('区块清单与页面结构一一对应', () => {
  it('八个区块：顺序一致、每个都有区块元素与导航项、每个都有别名表', async () => {
    await seedSettings();
    await loadOptions();
    const { SECTIONS } = await import('../../src/options/options');

    expect(SECTIONS.map((section) => section.id)).toEqual([
      'engine',
      'language',
      'shortcuts',
      'glossary',
      'site-rules',
      'prompt',
      'cache',
      'privacy',
    ]);
    expect(document.querySelectorAll('[data-section]')).toHaveLength(SECTIONS.length);
    for (const section of SECTIONS) {
      // 断言里带上区块 id：失败信息直接告诉你是哪一个区块缺东西。
      expect([section.id, document.querySelector(`[data-section="${section.id}"]`) !== null]).toEqual([section.id, true]);
      expect([section.id, document.querySelector(`[data-nav="${section.id}"]`) !== null]).toEqual([section.id, true]);
      expect(section.aliases.length).toBeGreaterThan(0);
      // 标题与页面里的 <h2> 逐字一致（搜索的显示名与页面上的名字不能是两套说法）。
      expect(document.querySelector(`[data-section="${section.id}"] h2`)?.textContent).toBe(section.title);
    }
  });

  it('每个别名只命中它自己那个区块（别名落点的机械守卫）', async () => {
    await seedSettings();
    await loadOptions();
    const { SECTIONS } = await import('../../src/options/options');

    for (const section of SECTIONS) {
      for (const alias of section.aliases) {
        search(alias);
        // 失败信息要能直接看懂：要么改这个别名，要么改另一处提到它的文案。
        expect([section.id, alias, visibleSections()]).toEqual([section.id, alias, [section.id]]);
      }
    }
    search('');
  });

  it('导航分组归属与三段信息架构一致（插错组要当场红）', async () => {
    // 只断言"导航项存在"是不够的：Task 5/6/7 每加一个区块都要往「内容控制」组里插一行，
    // 插到「翻译」或「数据」组里不会让任何用例变红，却会让导航的分段语义悄悄错位。
    // 这里把规格 §3 的三段结构（翻译 / 内容控制 / 数据）钉死在分组标题上。
    await seedSettings();
    await loadOptions();
    const expected: Record<string, string> = {
      engine: '翻译',
      language: '翻译',
      shortcuts: '翻译',
      glossary: '内容控制',
      'site-rules': '内容控制',
      prompt: '内容控制',
      cache: '数据',
      privacy: '数据',
    };

    for (const [id, group] of Object.entries(expected)) {
      const link = document.querySelector<HTMLElement>(`[data-nav="${id}"]`);
      expect([id, link?.closest('[data-nav-group]')?.querySelector('.grp')?.textContent]).toEqual([id, group]);
    }
    // 页面顺序、导航顺序、分组顺序三者一致：`<main>` 里的区块顺序就是上面 SECTIONS 的顺序。
    expect(Array.from(document.querySelectorAll('[data-section]')).map((node) => (node as HTMLElement).dataset.section)).toEqual(
      Object.keys(expected),
    );
    expect(Array.from(document.querySelectorAll('[data-nav-group] .grp')).map((node) => node.textContent)).toEqual([
      '翻译',
      '内容控制',
      '数据',
    ]);
  });

  it('**每个 `aria-labelledby` 都指向文档里真实存在的 id**（否则标题关联静默失效）', async () => {
    // 这条是**可选加固里最便宜的一个**，补上它是因为同一类问题已经踩到两次：
    // ① 四个 `:target` 选择器引用的 `#sec-*` 当时在 DOM 里还不存在（CSS 里的死引用）；
    // ② 下面这条要防的：`<section aria-labelledby="sec-x-title">` 与 `<h2 id="sec-x-title">`
    //    拼写对不上——屏幕阅读器读不出这个区块的标题，而**没有任何用例会红**。
    await seedSettings();
    await loadOptions();
    const { SECTIONS } = await import('../../src/options/options');

    // 只数 `[data-section][aria-labelledby]`，并与区块清单逐项对齐。这里刻意**不**写
    // "文档里带该属性的元素总数 >= 8"：那是个会漂的数——页面别处新增一个带 `aria-labelledby`
    // 的元素，就能在某个区块丢掉标题关联时把这条顶住（总数还是 8），守卫静默失效。
    const labelled = Array.from(document.querySelectorAll<HTMLElement>('[data-section][aria-labelledby]'));
    expect(labelled.map((node) => node.dataset.section)).toEqual(SECTIONS.map((section) => section.id));
    const missing = labelled
      .map((node) => [node.dataset.section as string, node.getAttribute('aria-labelledby') as string] as const)
      .filter(([, id]) => document.getElementById(id) === null);
    expect(missing).toEqual([]);
    // 上面那条**只覆盖区块元素**（`[data-section]`），所以引用完整性要单独查一遍：收紧之前这里
    // 遍历的是**全部**带该属性的元素（配一个"总数 >= 8"的判据），收紧之后非区块元素上的悬挂引用
    // 就没人管了——实测：给 `#search` 加一个指向不存在 id 的 `aria-labelledby`，全文件 15 条一度
    // 全绿。分工因此是：**逐项对齐**钉住区块清单（会漂的全称数不用），**全文档检查**钉住引用完整性
    // （只查"指得到吗"，不数个数，所以页面将来多几个引用也不会变脆）。
    const dangling = Array.from(document.querySelectorAll<HTMLElement>('[aria-labelledby]'))
      .map((node) => [node.dataset.section ?? node.id, node.getAttribute('aria-labelledby') as string] as const)
      .filter(([, id]) => document.getElementById(id) === null);
    expect(dangling).toEqual([]);
    // 反向也查一遍：CSS 里引用的每个 `#sec-*` 都得在页面里存在（就是那四个死选择器的守卫）。
    const cssIds = new Set([...readFileSync(CSS_PATH, 'utf-8').matchAll(/#(sec-[a-z-]+)/g)].map((match) => match[1] as string));
    const cssMissing = [...cssIds].filter((id) => document.getElementById(id) === null);
    expect(cssMissing).toEqual([]);
  });
});
