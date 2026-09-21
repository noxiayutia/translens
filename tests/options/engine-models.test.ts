// tests/options/engine-models.test.ts
/**
 * @vitest-environment jsdom
 *
 * 档案行与编辑面板的版式（规格 §6）：折叠行的四个元素、`自定义`徽章、次级 meta 行，
 * 面板里的名字 / Key / 「自定义设置」/ 模型目录 / 底部三颗按钮，以及模型清单的三条写入规则
 * （空值与重复值不写入、添加即设为当前、删当前项自愈）。
 *
 * 另外钉住三条**承诺**：
 * - 「获取可用模型」只有点了才发请求（§5.4）——**正负两半写在同一条用例里**：正极不存在时，
 *   负向断言会因为"分支根本没执行"而永远绿（本仓七种假信号成因②）；
 * - 「取消」丢弃面板编辑、存储一个字节不动（§6.2 第 5 条）；
 * - **隐式收起保留未保存的输入**、而「取消」丢弃它（§9 第 19 条）——两条语义**各自一条用例**，
 *   它们将来一旦互相漂，红的就是彼此。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../src/shared/messages';
import {
  CUSTOM_BASE_URL,
  CUSTOM_ORIGIN_PATTERN,
  chromeStub,
  currentModel,
  editorOf,
  engineStatus,
  expand,
  fieldOf,
  loadOptions,
  pick,
  profileRows,
  profileSeed,
  resetOptionsPage,
  rowButton,
  rowOf,
  seedSettings,
  setModel,
  settle,
  storedProfiles,
  waitFor,
} from './harness';

beforeEach(() => {
  resetOptionsPage();
});

describe('折叠行：图二的四个元素 + 我们保留的次级 meta', () => {
  it('名字 / 使用中 / 状态点 / 编辑 + 删除齐备，且整行不再是按钮', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ id: 'p-a' }), profileSeed({ id: 'p-b', label: 'B 家' })],
    });
    await loadOptions();

    const row = rowOf('p-a');
    expect(row.querySelector('.name')?.textContent).toBe('我的 DeepSeek');
    expect(row.querySelector('.badge')?.textContent).toBe('使用中');
    expect(row.querySelector('.dot')?.getAttribute('data-state')).toBe('idle');
    expect(row.querySelector('.meta')?.textContent).toBe(`${CUSTOM_BASE_URL} · deepseek-chat`);
    expect(rowButton('p-a', 'toggle').textContent).toBe('编辑');
    expect(rowButton('p-a', 'delete-profile').textContent).toBe('删除');

    // 当前在用的那一行才有「使用中」；删除按钮两行都有。
    expect(rowOf('p-b').textContent).not.toContain('使用中');
    expect(() => rowButton('p-b', 'delete-profile')).not.toThrow();

    // 整行不是按钮：行里现在有「删除」，整行可点会把删除变成一次误触。
    expect(row.tagName).toBe('DIV');
    expect(rowButton('p-a', 'toggle').tagName).toBe('BUTTON');
    expect(row.querySelector('.profile-summary')).toBeNull();
  });

  it('「自定义」徽章只在地址对不上任何预设时出现——成对：命中预设地址的档案上没有它', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [
        profileSeed({ id: 'p-a', label: '自建代理', baseUrl: 'https://my-proxy.example/v1' }),
        profileSeed({ id: 'p-b', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' }),
        // 地址还是 DeepSeek 的，模型名却是自己的：判据是**地址**，所以也不该有徽章。
        profileSeed({ id: 'p-c', label: 'DeepSeek 改名', baseUrl: 'https://api.deepseek.com/v1', models: ['my-own'], activeModel: 'my-own' }),
      ],
    });
    await loadOptions();

    expect(rowOf('p-a').querySelector('[data-template="custom"]')).not.toBeNull();
    expect(rowOf('p-b').querySelector('[data-template="custom"]')).toBeNull();
    expect(rowOf('p-c').querySelector('[data-template="custom"]')).toBeNull();
  });

  it('次级 meta 的占位：地址与当前模型各自缺失时各写一句（不留空行）', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [{ id: 'p-a', label: '半成品', baseUrl: '', models: [], activeModel: '', apiKey: '' }],
    });
    await loadOptions();
    expect(rowOf('p-a').querySelector('.meta')?.textContent).toBe('未填接口地址 · 未选模型');

    // 新草稿那一行同形（它连档案都还没有）。
    pick<HTMLButtonElement>('add-profile').click();
    await settle();
    expect(rowOf('__new__').querySelector('.meta')?.textContent).toBe('未填接口地址 · 未选模型');
  });
});

describe('编辑面板：元素齐备 + 默认折叠规则 + Key 占位符', () => {
  it('名字 / Key / 自定义设置 / 模型目录 / 底部按钮齐备，且单模型输入框已彻底消失', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed()] });
    await loadOptions();
    const editor = expand('p-a');

    expect(fieldOf(editor, '.profile-label').value).toBe('我的 DeepSeek');
    expect(editor.querySelector('.profile-toggle-key')?.textContent).toBe('显示');
    expect(editor.querySelector('.profile-provider')).not.toBeNull();
    expect(fieldOf(editor, '.profile-base-url').value).toBe(CUSTOM_BASE_URL);
    expect(editor.querySelector('.models-field')).not.toBeNull();
    expect(editor.querySelector('.model-row[data-current]')?.getAttribute('data-model')).toBe('deepseek-chat');
    expect(editor.querySelector('[data-action="fetch-models"]')?.textContent).toContain('⟳');
    expect(editor.querySelector('[data-action="add-model"]')?.textContent).toBe('+ 添加模型');
    expect(editor.querySelector('[data-action="test-profile"]')?.textContent).toBe('测试连接');
    expect(editor.querySelector('[data-action="save-profile"]')?.textContent).toBe('保存');
    expect(editor.querySelector('[data-action="cancel-profile"]')?.textContent).toBe('取消');
    // C1 的过渡映射（有损）必须在这里彻底消失：留着它就是一条静默压扁清单的路。
    expect(editor.querySelector('.profile-model-name')).toBeNull();
  });

  it('「自定义设置」默认折叠；地址为空时展开（成对：地址非空 → 收起）', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed()] });
    await loadOptions();
    expect(expand('p-a').querySelector<HTMLDetailsElement>('.profile-advanced')?.open).toBe(false);

    pick<HTMLButtonElement>('add-profile').click();
    await settle();
    // 草稿的地址是空的 → 展开：面板首屏必须有一个能填地址的地方，否则用户以为没有这个入口。
    expect(editorOf('__new__').querySelector<HTMLDetailsElement>('.profile-advanced')?.open).toBe(true);
  });

  it('模板下拉是「自定义」**不**触发展开：已经有地址的档案不该白占一屏', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ baseUrl: 'https://my-proxy.example/v1' })],
    });
    await loadOptions();

    // 「自定义」徽章在（地址不是预设）——但它与折叠态无关：只看地址空不空。
    expect(rowOf('p-a').querySelector('[data-template="custom"]')).not.toBeNull();
    expect(expand('p-a').querySelector<HTMLDetailsElement>('.profile-advanced')?.open).toBe(false);
  });

  it('Key 占位符区分"已配置 / 没配置"，且值恒为空（不回填）', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [
        profileSeed({ id: 'p-a', apiKey: 'sk-secret' }),
        profileSeed({ id: 'p-b', label: 'B 家', apiKey: '' }),
      ],
    });
    await loadOptions();

    const configured = fieldOf(expand('p-a'), '.profile-api-key');
    expect(configured.value).toBe('');
    expect(configured.placeholder).toBe('已配置——输入新值可替换');
    // 密钥本体一个字符都不许进 DOM（列表渲染比单字段更容易把值带出去）。
    expect(document.documentElement.outerHTML).not.toContain('sk-secret');

    expect(fieldOf(expand('p-b'), '.profile-api-key').placeholder).toContain('还没配置');
  });

  it('选服务商模板：填地址 + 把它的模型并入清单并设为当前；下拉自己留在那个 preset 上（不算手改）', async () => {
    await seedSettings();
    await loadOptions();
    pick<HTMLButtonElement>('add-profile').click();
    await settle();
    const editor = editorOf('__new__');
    const provider = editor.querySelector<HTMLSelectElement>('.profile-provider') as HTMLSelectElement;

    provider.value = 'ollama';
    provider.dispatchEvent(new Event('change', { bubbles: true }));

    expect(fieldOf(editor, '.profile-base-url').value).toBe('http://localhost:11434/v1');
    expect(currentModel(editor)).toBe('llama3');
    expect(provider.value).toBe('ollama');
    // 预设不越界：API Key 一个字符都不碰（那是用户自己的凭据）。
    expect(fieldOf(editor, '.profile-api-key').value).toBe('');
  });
});

describe('模型目录：三条写入规则 + 自愈 + 空态说明', () => {
  it('手填添加：空值与重复值都不写入（各说一句），新值加进去**并设为当前**', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed()] });
    await loadOptions();
    const editor = expand('p-a');
    const names = () => Array.from(editor.querySelectorAll<HTMLElement>('.model-row')).map((row) => row.dataset.model);

    editor.querySelector<HTMLButtonElement>('[data-action="add-model"]')!.click();
    fieldOf(editor, '.profile-model-new').value = '   ';
    editor.querySelector<HTMLButtonElement>('[data-action="confirm-model"]')!.click();
    expect(engineStatus().dataset.kind).toBe('err');
    expect(engineStatus().textContent).toContain('不能为空');
    expect(names()).toEqual(['deepseek-chat']);

    fieldOf(editor, '.profile-model-new').value = 'deepseek-chat';
    editor.querySelector<HTMLButtonElement>('[data-action="confirm-model"]')!.click();
    expect(engineStatus().textContent).toContain('已经有');
    expect(names()).toEqual(['deepseek-chat']);

    setModel(editor, 'deepseek-reasoner');
    expect(names()).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(currentModel(editor)).toBe('deepseek-reasoner');
    expect(engineStatus().textContent).toContain('设为当前');
  });

  it('「设为当前」切换当前项；当前项自己的那颗按钮是禁用的（不做点了没反应的死控件）', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ models: ['a', 'b'], activeModel: 'a' })],
    });
    await loadOptions();
    const editor = expand('p-a');
    const useButton = (model: string) =>
      editor.querySelector<HTMLButtonElement>(`.model-row[data-model="${model}"] [data-action="use-model"]`)!;

    expect(currentModel(editor)).toBe('a');
    expect(useButton('a').disabled).toBe(true);
    expect(useButton('b').disabled).toBe(false);

    useButton('b').click();
    await settle();

    expect(currentModel(editor)).toBe('b');
    expect(useButton('b').disabled).toBe(true);
    expect(useButton('a').disabled).toBe(false);
  });

  it('删掉当前模型：自愈取剩下的最后一个；删空了置空并明说（落盘的一对也满足不变量）', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ models: ['a', 'b', 'c'], activeModel: 'b' })],
    });
    await loadOptions();
    const editor = expand('p-a');
    const remove = (model: string) =>
      editor.querySelector<HTMLButtonElement>(`.model-row[data-model="${model}"] [data-action="remove-model"]`)!.click();

    remove('b');
    await settle();
    expect(currentModel(editor)).toBe('c');
    expect(engineStatus().textContent).toContain('改成了「c」');

    // 删**非当前**项不许动当前项：上面删的正好是当前项，所以这一半是"自愈只该在必要时发生"
    // 唯一的读数（把 `draft.activeModel === name` 这个条件删掉，这里当场红）。
    remove('a');
    await settle();
    expect(currentModel(editor)).toBe('c');
    expect(Array.from(editor.querySelectorAll<HTMLElement>('.model-row')).map((row) => row.dataset.model)).toEqual(['c']);

    remove('c');
    await settle();
    expect(currentModel(editor)).toBe('');
    expect(editor.querySelectorAll('.model-row')).toHaveLength(0);
    expect(engineStatus().dataset.kind).toBe('err');
    expect(engineStatus().textContent).toContain('没有模型');

    // 落盘的那一对必须满足 `activeModel === '' || models.includes(activeModel)`。
    editor.querySelector<HTMLButtonElement>('[data-action="save-profile"]')!.click();
    await waitFor(async () => ((await storedProfiles())[0]?.models as unknown[] | undefined)?.length === 0);
    const stored = (await storedProfiles())[0];
    expect(stored.models).toEqual([]);
    expect(stored.activeModel).toBe('');
  });

  it('删**非当前**项时当前项一动不动——夹具必须让"当前项"不是"剩下的最后一项"', async () => {
    // 为什么单独一条：上面那条里"删非当前项"的那一步**抓不住**"永远取剩下的最后一个"这个实现
    // ——那时清单只剩一项、而那一项恰好就是当前项，两种口径读数完全相同（恒真式，本仓假信号
    // 成因⑦：夹具与被测逻辑同源）。这里把当前项放在**清单第一项**上，删掉中间那一项之后
    // 剩下的最后一项是 `c` 而不是当前项 `a`，改错了当场读得出。
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ models: ['a', 'b', 'c'], activeModel: 'a' })],
    });
    await loadOptions();
    const editor = expand('p-a');

    editor.querySelector<HTMLButtonElement>('.model-row[data-model="b"] [data-action="remove-model"]')!.click();
    await settle();

    expect(currentModel(editor)).toBe('a');
    expect(
      Array.from(editor.querySelectorAll<HTMLElement>('.model-row')).map((row) => row.dataset.model),
    ).toEqual(['a', 'c']);
  });

  it('清单为空时那句说明逐句可核，有了一项就收起', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ models: [], activeModel: '' })],
    });
    await loadOptions();
    const editor = expand('p-a');
    const empty = editor.querySelector<HTMLElement>('.models-empty')!;

    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toContain('清单为空时，弹窗里不显示模型下拉');
    expect(empty.textContent).toContain('清单只有一项时弹窗也不显示下拉');
    expect(empty.textContent).toContain('两项以上才会出现下拉');

    setModel(editor, 'm-1');
    expect(editor.querySelector<HTMLElement>('.models-empty')?.hidden).toBe(true);
  });
});

describe('取消：丢弃面板编辑，存储一个字节不动', () => {
  it('改名字 + 加模型后取消：面板收起、存储原样；再展开看到的是存储里的值（**不是**刚被取消的草稿）', async () => {
    // 这条同时是"**`取消` 清暂存**"的见证：如果 `handleCancelProfile` 忘了清，重新展开会命中
    // 暂存、把 `改过的名字` / `another-model` 填回来，下面那两条断言当场红。
    // （与"隐式收起保留输入"是**两条不同的用例**——那两条在下面那个 describe 里。两条语义将来
    // 一旦互相漂，红的就是彼此。）
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed({ label: '原名字' })] });
    await loadOptions();

    let editor = expand('p-a');
    fieldOf(editor, '.profile-label').value = '改过的名字';
    setModel(editor, 'another-model');
    editor.querySelector<HTMLButtonElement>('[data-action="cancel-profile"]')!.click();
    await settle();

    expect(rowOf('p-a').querySelector('.profile-editor')).toBeNull();
    expect((await storedProfiles())[0]?.label).toBe('原名字');
    expect((await storedProfiles())[0]?.models).toEqual(['deepseek-chat']);

    editor = expand('p-a');
    expect(fieldOf(editor, '.profile-label').value).toBe('原名字');
    expect(currentModel(editor)).toBe('deepseek-chat');
    expect(
      Array.from(editor.querySelectorAll<HTMLElement>('.model-row')).map((row) => row.dataset.model),
    ).toEqual(['deepseek-chat']);
  });

  it('取消草稿行：整行移除（草稿没有存储里对应的东西，收起它只会留个空壳）', async () => {
    await seedSettings();
    await loadOptions();
    pick<HTMLButtonElement>('add-profile').click();
    await settle();
    expect(profileRows().map((row) => row.dataset.profileId)).toEqual(['__new__']);

    editorOf('__new__').querySelector<HTMLButtonElement>('[data-action="cancel-profile"]')!.click();
    await settle();

    expect(profileRows()).toEqual([]);
    expect(await storedProfiles()).toEqual([]);
    expect(engineStatus().textContent).toContain('没有被保存过');
  });
});

describe('「获取可用模型」：零自动拉取 + 勾选并入', () => {
  it('打开设置页 / 展开档案 / 聚焦输入框都不发请求；点了按钮才发，且消息里只有 profileId', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed()] });
    await loadOptions();

    const editor = expand('p-a');
    fieldOf(editor, '.profile-api-key').focus();
    fieldOf(editor, '.profile-label').focus();
    fieldOf(editor, '.profile-model-new').focus();
    await settle();

    // 负向的两半：没有任何消息发出、也没有任何网络请求。
    expect(chromeStub.runtime.sentMessages).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();

    // 正向那一半（缺了它，上面两条会因为"根本没有调用方"而永远绿——成因②）。
    // 真机上 SW 被回收时就是"没有接收方"：sendMessage 直接拒绝。
    chromeStub.runtime.noReceiver = true;
    editor.querySelector<HTMLButtonElement>('[data-action="fetch-models"]')!.click();
    await waitFor(() => engineStatus().dataset.kind === 'err');

    expect(chromeStub.runtime.sentMessages).toEqual([{ type: MSG.FETCH_MODELS, payload: { profileId: 'p-a' } }]);
    expect(fetchSpy).not.toHaveBeenCalled(); // 网络请求在后台那一侧，设置页自己绝不发
  });

  it('拉取成功：勾选清单默认全不选；勾两个并入 → 追加去重，清单原本为空时第一项为当前', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ models: [], activeModel: '' })],
    });
    await loadOptions();
    // 扮演 service worker：只回话，不断言（断言在下面事后查）。
    chromeStub.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if ((message as { type?: string }).type === MSG.FETCH_MODELS) {
        sendResponse({ ok: true, models: ['m-1', 'm-2', 'm-3'] });
      }
      return undefined;
    });

    const editor = expand('p-a');
    editor.querySelector<HTMLButtonElement>('[data-action="fetch-models"]')!.click();
    await waitFor(() => (engineStatus().textContent ?? '').includes('拿到了 3 个模型名'));

    const picks = () => Array.from(editor.querySelectorAll<HTMLInputElement>('.profile-model-pick'));
    expect(picks().map((box) => [box.value, box.checked])).toEqual([
      ['m-1', false],
      ['m-2', false],
      ['m-3', false],
    ]);

    // 一个都不勾：明确说一句，清单不动。
    editor.querySelector<HTMLButtonElement>('[data-action="merge-models"]')!.click();
    expect(engineStatus().dataset.kind).toBe('err');
    expect(engineStatus().textContent).toContain('一个都没勾');
    expect(editor.querySelectorAll('.model-row')).toHaveLength(0);

    picks()[1].checked = true;
    picks()[2].checked = true;
    editor.querySelector<HTMLButtonElement>('[data-action="merge-models"]')!.click();

    expect(
      Array.from(editor.querySelectorAll<HTMLElement>('.model-row')).map((row) => row.dataset.model),
    ).toEqual(['m-2', 'm-3']);
    // 清单原本是空的 → 并入的第一项设为当前（否则档案仍停在"还没有模型"）。
    expect(currentModel(editor)).toBe('m-2');

    // 成对的另一半：清单**非空**时并入**不许**动用户已经选好的当前项
    // （把 `draft.activeModel.length > 0 ? … : picked[0]` 那个条件删掉，这里当场红）。
    setModel(editor, 'm-9');
    expect(currentModel(editor)).toBe('m-9');
    editor.querySelector<HTMLButtonElement>('[data-action="fetch-models"]')!.click();
    await waitFor(() => (engineStatus().textContent ?? '').includes('拿到了 3 个模型名'));
    picks()[0].checked = true;
    editor.querySelector<HTMLButtonElement>('[data-action="merge-models"]')!.click();

    expect(
      Array.from(editor.querySelectorAll<HTMLElement>('.model-row')).map((row) => row.dataset.model),
    ).toEqual(['m-2', 'm-3', 'm-9', 'm-1']);
    expect(currentModel(editor)).toBe('m-9');
  });

  it('拉取成功但一条都解析不出：引导手填（不是报错完事）；拉取失败：原样显示后台那句', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed()] });
    await loadOptions();
    let reply: unknown = { ok: true, models: [] };
    chromeStub.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if ((message as { type?: string }).type === MSG.FETCH_MODELS) sendResponse(reply);
      return undefined;
    });

    const editor = expand('p-a');
    const click = () => editor.querySelector<HTMLButtonElement>('[data-action="fetch-models"]')!.click();

    click();
    await waitFor(() => (engineStatus().textContent ?? '').includes('没有给出可用的模型清单'));
    expect(engineStatus().textContent).toContain('添加模型');

    reply = { ok: false, message: '这个地址没有 /models 这个端点（HTTP 404）。请用「添加模型」手填。' };
    click();
    await waitFor(() => (engineStatus().textContent ?? '').includes('HTTP 404'));
    // 勾选清单没有被画出来（失败路径不该留一个空盒子）。
    expect(editor.querySelector<HTMLElement>('.models-fetched')?.hidden).toBe(true);
  });
});

describe('测试连接：没有当前模型时零请求', () => {
  it('没有当前模型：说那句话、一个请求都不发（有当前模型那一半由既有的三条用例守着）', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    chromeStub.permissions.grantedOrigins.add(CUSTOM_ORIGIN_PATTERN);
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ models: [], activeModel: '', apiKey: 'sk-a' })],
    });
    await loadOptions();
    const editor = expand('p-a');

    editor.querySelector<HTMLButtonElement>('[data-action="test-profile"]')!.click();
    await waitFor(() => engineStatus().dataset.kind === 'err');

    expect(engineStatus().textContent).toContain('还没有模型');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('未保存输入的暂存：隐式收起保住它，取消丢弃它（规格 §9 第 19 条）', () => {
  it('切走再切回草稿行：行还在，未保存的输入被暂存保住', async () => {
    // 为什么存在：旧实现里草稿行会**整行消失**（用户以为「新增档案」被吞了）；C0 之后行不再消失，
    // 但值仍会被 `buildEditor` 重建丢掉；C4 起用每行的内存暂存把它保住。
    // 探针实测（C0 落地时）：`ids=["p-a","__new__"]`、`draftRowExists=true`、切回四个字段全空。
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed({ id: 'p-a' })] });
    await loadOptions();

    pick<HTMLButtonElement>('add-profile').click();
    await settle();
    fieldOf(editorOf('__new__'), '.profile-label').value = '临时档案';

    // 切走：点真档案的「编辑」。这一步在旧实现下会把草稿行整个抹掉。
    rowOf('p-a').querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    await settle();
    expect(profileRows().map((row) => row.dataset.profileId)).toEqual(['p-a', '__new__']);
    expect(rowOf('__new__').querySelector('.profile-editor')).toBeNull(); // 收起 = 编辑器不在 DOM

    // 切回：暂存生效（没有暂存的话，新建的编辑器四个字段都是空的）。
    rowOf('__new__').querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    await settle();
    expect(fieldOf(editorOf('__new__'), '.profile-label').value).toBe('临时档案');
  });

  it('切走再切回真档案行：四个字段与模型清单都保住；**存储里的** Key 仍然不进 DOM', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [profileSeed({ id: 'p-a', apiKey: 'sk-stored' }), profileSeed({ id: 'p-b', label: 'B 家' })],
    });
    await loadOptions();

    let editor = expand('p-a');
    fieldOf(editor, '.profile-label').value = '改了一半';
    fieldOf(editor, '.profile-base-url').value = 'https://half.example/v1';
    fieldOf(editor, '.profile-api-key').value = 'sk-typed-here';
    setModel(editor, 'second-model');

    expand('p-b'); // 切走（这一步收起 p-a → 写暂存）
    await settle();
    // 切过去的那一行**不会**看到别人正在编辑的内容：暂存是按**档案 id 各留一格**的。
    // 这条同时是"共用一格"那个变异的杀手（共用时 p-b 会读到 p-a 的草稿）。
    const other = expand('p-b');
    expect(fieldOf(other, '.profile-label').value).toBe('B 家');
    expect(fieldOf(other, '.profile-base-url').value).toBe(CUSTOM_BASE_URL);

    editor = expand('p-a'); // 切回（重建编辑器 → 先填暂存）

    expect(fieldOf(editor, '.profile-label').value).toBe('改了一半');
    expect(fieldOf(editor, '.profile-base-url').value).toBe('https://half.example/v1');
    expect(
      Array.from(editor.querySelectorAll<HTMLElement>('.model-row')).map((row) => row.dataset.model),
    ).toEqual(['deepseek-chat', 'second-model']);
    expect(currentModel(editor)).toBe('second-model');
    // Key 那一格搬的是**用户刚敲进去的**值（他自己的屏幕、他自己的输入），仍然是遮住的。
    // 这条**没有**改变隐私硬规矩：存储里那把 Key 照旧不回填、不进 DOM（下一句就是它的读数）。
    expect(fieldOf(editor, '.profile-api-key').value).toBe('sk-typed-here');
    expect(fieldOf(editor, '.profile-api-key').type).toBe('password');
    expect(document.documentElement.outerHTML).not.toContain('sk-stored');
    // 存储一个字节都没动：暂存是内存里的东西，不是自动保存。
    expect((await storedProfiles())[0]?.label).toBe('我的 DeepSeek');
  });

  it('草稿保存成功后清掉草稿暂存：再点「新增档案」是一张白纸，不是上一次那份草稿', async () => {
    // 为什么存在：草稿保存后 id 会从 `__new__` 变成一个**新生成的**档案 id。所以"保存后清暂存"
    // 这件事只在草稿这一支上**可观察**——残留的 `__new__` 那条会在下一次"新增档案"时把旧草稿
    // 预填回去。（同档案保存后的清理**不可观察**：保存后 `renderProfiles` 会按新快照重建那一行，
    // DOM 本来就不是旧草稿。别为不可观察的那半编一条断言。）
    await seedSettings();
    await loadOptions();

    pick<HTMLButtonElement>('add-profile').click();
    await settle();
    let editor = editorOf('__new__');
    fieldOf(editor, '.profile-label').value = '第一份草稿';
    fieldOf(editor, '.profile-base-url').value = CUSTOM_BASE_URL;
    fieldOf(editor, '.profile-api-key').value = 'sk-draft';
    // 先收起一次（写暂存），再展开（读暂存），然后保存。
    rowOf('__new__').querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    await settle();
    rowOf('__new__').querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    await settle();
    editor = editorOf('__new__');
    expect(fieldOf(editor, '.profile-label').value).toBe('第一份草稿');

    editor.querySelector<HTMLButtonElement>('[data-action="save-profile"]')!.click();
    await waitFor(async () => (await storedProfiles()).length === 1);
    expect((await storedProfiles())[0]?.label).toBe('第一份草稿');

    // 再开一个新草稿：四个字段都该是空的（残留的 `__new__` 暂存会把它们填回来）。
    pick<HTMLButtonElement>('add-profile').click();
    await settle();
    const fresh = editorOf('__new__');
    expect(fieldOf(fresh, '.profile-label').value).toBe('');
    expect(fieldOf(fresh, '.profile-base-url').value).toBe('');
    expect(fieldOf(fresh, '.profile-api-key').value).toBe('');
    expect(fresh.querySelectorAll('.model-row')).toHaveLength(0);
  });
});
