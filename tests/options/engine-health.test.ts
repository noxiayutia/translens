// tests/options/engine-health.test.ts
/**
 * @vitest-environment jsdom
 *
 * §4.3 状态点三态 + 它背后的记录（`chrome.storage.session` 的 `jinyi:engine-health`）。
 * 另一半**曾是**「内置免费引擎那一行」（§3.1 的"不可删"）——那一行随单元 E 删掉免费接口一起
 * 消失了，现在这一半是**档案记录键的形状**（`p:` 前缀与档案 id 是两个概念，见下面那个 describe）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENGINE_HEALTH_KEY,
  loadEngineHealth,
  profileHealthKey,
  profileIdFromHealthKey,
  saveEngineHealth,
} from '../../src/options/engine-health';
import {
  CUSTOM_BASE_URL,
  actionButton,
  chatResponse,
  chromeStub,
  editorOf,
  fieldOf,
  jsonResponse,
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
  waitFor,
} from './harness';
import { NO_ENGINE_PROBLEM } from '../../src/shared/settings';

const CUSTOM_ORIGIN_PATTERN = 'https://api.example.com/*';

async function seedHealth(record: Record<string, unknown>): Promise<void> {
  await chromeStub.storage.session.set({ [ENGINE_HEALTH_KEY]: record });
}

/**
 * 按**档案键**写记录：键是 `p:<档案 id>`。用例里直接手写裸 id 会静默落到谁也读不到的地方
 * （那正是"两个键空间"要杜绝的形态），所以档案记录一律走 `profileHealthKey` 拼键。
 */
async function seedProfileHealth(records: Record<string, unknown>): Promise<void> {
  const keyed: Record<string, unknown> = {};
  for (const [id, record] of Object.entries(records)) keyed[profileHealthKey(id)] = record;
  await seedHealth(keyed);
}

async function storedHealth(): Promise<Record<string, unknown>> {
  const raw = await chromeStub.storage.session.get([ENGINE_HEALTH_KEY]);
  return (raw[ENGINE_HEALTH_KEY] ?? {}) as Record<string, unknown>;
}

function dotOf(id: string): HTMLElement {
  const row = profileRows().find((candidate) => candidate.dataset.profileId === id);
  if (row === undefined) throw new Error(`没有档案行 ${id}`);
  const dot = row.querySelector<HTMLElement>('.dot');
  if (dot === null) throw new Error(`档案行 ${id} 没有状态点`);
  return dot;
}

function status(): HTMLElement {
  return pick<HTMLElement>('engine-status');
}

/**
 * 带正文的失败响应：`describeHttpError` 读的是 `response.text()`，而 harness 的 `jsonResponse`
 * 只有 `json()` 那一支——用它拼不出"服务商在正文里回显请求内容"这个场景。
 */
function textResponse(body: string, statusCode: number): Response {
  return { status: statusCode, ok: false, text: async () => body } as unknown as Response;
}

beforeEach(() => {
  resetOptionsPage();
});

describe('状态点的记录：读取与脏数据', () => {
  it('读得出来；没记录的档案不在结果里', async () => {
    await seedProfileHealth({ 'p-a': { state: 'ok', detail: '' }, 'p-b': { state: 'bad', detail: 'NETWORK：超时' } });
    await loadOptions();

    const health = await loadEngineHealth();
    expect(health[profileHealthKey('p-a')]).toEqual({ state: 'ok', detail: '' });
    expect(health[profileHealthKey('p-b')]?.state).toBe('bad');
    expect(health[profileHealthKey('p-c')]).toBeUndefined();
  });

  it('存储里是垃圾也不崩：认不出来的条目直接丢掉，能救的救回来（缺 detail 补空串）', async () => {
    // 键刻意是任意字符串：`pickHealth` 是**键无关**的（两个键空间的分法在 `engine-health.ts` 的
    // 键常量里，不在读取器的形状校验里），这一条才看得清"形状不对就丢"是自己那条规矩。
    await seedHealth({
      good: { state: 'ok', detail: '' },
      notAnObject: 'nonsense',
      badState: { state: 'maybe', detail: '' },
      missingDetail: { state: 'bad' },
    });
    await loadOptions();

    const health = await loadEngineHealth();
    // `notAnObject` 与 `badState` 丢掉；`missingDetail` 的 state 合法，只把 detail 补成空串
    // ——一条记录缺个字段不该让整页崩，但也不能凭空变成一个说不清来源的点。
    expect(Object.keys(health).sort()).toEqual(['good', 'missingDetail']);
    expect(health['missingDetail']).toEqual({ state: 'bad', detail: '' });
    // 页面照常渲染，不因为一条脏记录整页白。
    //
    // 这一条**不能只断言"零个档案行"**：本用例一个档案都没 seed，`profileRows()` 恒为 0，
    // 于是它在"`mount` 里根本不渲染列表"的变异下照样是绿的（加这条断言之前实测：那个变异
    // 只红 6 条，绿的正是本条与上面那条纯存储的）。原来这里钉的是"内置免费引擎那一行**每次重绘
    // 都会画出来**"——那一行随单元 E 删掉了，**承重的读数必须换一个，不许直接删**：
    // 本用例没 seed 任何设置，`engineId` 是默认的 `''`，于是 `mount` 一定会把
    // `#engine-hint` 写成那句"没有可用引擎"。它同样是"渲染真的发生了"的证据
    // （`mount` 里不调用 `renderEngineHint` → 这个节点还是 HTML 里的空串 → 红）。
    expect(profileRows()).toHaveLength(0);
    expect(pick<HTMLElement>('engine-hint').textContent).toBe(NO_ENGINE_PROBLEM);
  });

  it('两次并发写不互相吞：读-改-写按存储区串行（`Promise.all` 形态）', async () => {
    // 记录是"一份对象、多条条目"，每次写都是整份读-改-写。不排队时后写的那次拿自己那份
    // 旧基线整份回写，把先写的那次静默抹掉——实测改前这里只剩后写的那一条（当时键还是裸 id，
    // 读数是 `{'p-b': …}`），而界面上两个点都是绿的（内存里两份都在），重开设置页才有一个回到灰。
    await Promise.all([
      saveEngineHealth(profileHealthKey('p-a'), { state: 'ok', detail: '' }),
      saveEngineHealth(profileHealthKey('p-b'), { state: 'bad', detail: 'NETWORK：超时' }),
    ]);

    expect(await storedHealth()).toEqual({
      [profileHealthKey('p-a')]: { state: 'ok', detail: '' },
      [profileHealthKey('p-b')]: { state: 'bad', detail: 'NETWORK：超时' },
    });
  });
});

describe('状态点三态', () => {
  it('绿 / 灰 / 红各自可达，`title` 说清是哪一种（灰态明说"从没测过"）', async () => {
    await seedSettings({
      engineId: 'p-a',
      profiles: [
        profileSeed({ id: 'p-a', label: '通了的' }),
        profileSeed({ id: 'p-b', label: '没测过的' }),
        profileSeed({ id: 'p-c', label: '失败过的' }),
      ],
    });
    await seedProfileHealth({
      'p-a': { state: 'ok', detail: '' },
      'p-c': { state: 'bad', detail: 'AUTH：API Key 无效或权限不足' },
    });
    await loadOptions();

    expect(dotOf('p-a').dataset.state).toBe('ok');
    expect(dotOf('p-a').title).toContain('最近一次测试连接通过');
    expect(dotOf('p-b').dataset.state).toBe('idle');
    expect(dotOf('p-b').title).toContain('从没测过');
    expect(dotOf('p-c').dataset.state).toBe('bad');
    expect(dotOf('p-c').title).toContain('AUTH：API Key 无效或权限不足');
  });

  it('测试连接成功：那一行变绿并记进本次会话；失败：变红且 title 带错误码', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好'));
    vi.stubGlobal('fetch', fetchMock);
    chromeStub.permissions.grantedOrigins.add(CUSTOM_ORIGIN_PATTERN);
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed({ apiKey: 'sk-a' })] });
    await loadOptions();

    profileRows()[0].querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    const editor = profileRows()[0].querySelector('.profile-editor') as Element;
    editor.querySelector<HTMLButtonElement>('[data-action="test-profile"]')!.click();
    await waitFor(() => status().dataset.kind === 'ok');

    expect(dotOf('p-a').dataset.state).toBe('ok');
    await waitFor(async () => (await storedHealth())[profileHealthKey('p-a')] !== undefined);
    expect((await storedHealth())[profileHealthKey('p-a')]).toEqual({ state: 'ok', detail: '' });

    // 再测一次，这次让接口返回 401。
    fetchMock.mockResolvedValue(jsonResponse({ error: 'bad key' }, 401));
    editor.querySelector<HTMLButtonElement>('[data-action="test-profile"]')!.click();
    await waitFor(() => status().dataset.kind === 'err');

    expect(dotOf('p-a').dataset.state).toBe('bad');
    expect(dotOf('p-a').title).toContain('AUTH');
    await waitFor(
      async () =>
        ((await storedHealth())[profileHealthKey('p-a')] as { state?: string } | undefined)?.state === 'bad',
    );
  });

  it('测试记录写不进去时如实说一句，但不改这次测试的结果', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好')));
    chromeStub.permissions.grantedOrigins.add(CUSTOM_ORIGIN_PATTERN);
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed({ apiKey: 'sk-a' })] });
    await loadOptions();
    chromeStub.storage.session.set = async () => {
      throw new Error('会话存储满了');
    };

    profileRows()[0].querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    const editor = profileRows()[0].querySelector('.profile-editor') as Element;
    editor.querySelector<HTMLButtonElement>('[data-action="test-profile"]')!.click();
    await waitFor(() => (status().textContent ?? '').includes('测试结果没能记住'));

    // 连接本身是成功的，界面上的点也是绿的。
    expect(status().textContent).toContain('连接成功');
    expect(dotOf('p-a').dataset.state).toBe('ok');
  });

  it('删除档案时把它的记录一并清掉（别给下次迁移回来的同一个 id 留一个假状态）', async () => {
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed()] });
    await seedProfileHealth({ 'p-a': { state: 'ok', detail: '' }, 'keep': { state: 'bad', detail: 'x' } });
    await loadOptions();

    profileRows()[0].querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    // 删除按钮在折叠行的 `.row-actions` 里（不在 `.profile-editor` 内）；该用例的 `profileRows()[0]` 就是 `p-a`。
    rowButton('p-a', 'delete-profile').click();

    await waitFor(async () => (await storedHealth())[profileHealthKey('p-a')] === undefined);
    // 删的是**它的档案键**：邻居那条（`p:keep`）原样留着。
    expect(Object.keys(await storedHealth())).toEqual([profileHealthKey('keep')]);
  });

  it('草稿行点测试连接不落记录：`__new__` 没有点可更新，也没有清理出口', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好'));
    vi.stubGlobal('fetch', fetchMock);
    chromeStub.permissions.grantedOrigins.add(CUSTOM_ORIGIN_PATTERN);
    // ⚠ 夹具取 `p-a` 而不是 `'google'`：**实测（变异轮 M9）证明这条夹具并不承重**——
    // `handleTestProfile` 用的是**内联的草稿档案**（`resolveEngine({ engineId: id, profiles: [草稿] })`），
    // 根本不读存储里的 `engineId`，所以把它改回 `'google'` 这条用例照样全绿（12 passed）。
    // 改它只是为了不给"当前引擎是 google"留一个 v5 之后已经不成立的假前提；
    // **别把它读成"这里有一个必红的守卫"**。
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed()] });
    await loadOptions();

    // `__new__` 是草稿哨兵（与 `options.test.ts` 同一个字面量：它不导出，按契约写死）。
    pick<HTMLButtonElement>('add-profile').click();
    const editor = editorOf('__new__');
    fieldOf(editor, '.profile-label').value = '临时档案';
    fieldOf(editor, '.profile-base-url').value = CUSTOM_BASE_URL;
    setModel(editor, 'm');
    fieldOf(editor, '.profile-api-key').value = 'sk-draft';
    actionButton(editor, 'test-profile').click();
    // ⚠ 等「连接成功」而不是 `kind === 'ok'`：`setModel` 走的是真实用户路径，它自己就会把状态行
    // 写成 ok（「已加入…」），于是 `waitFor(kind === 'ok')` 会当场兑现、下面那条请求次数断言
    // 跑在请求之前（实测读到 0 次）。这是本仓七种假信号里的成因④。
    await waitFor(() => (status().textContent ?? '').includes('连接成功'));

    // 请求真的发出去了、状态行照常报结果；草稿行刻意**没有**状态点，删档案也删不到它，
    // 所以它不该在会话存储里留下一条谁也认领不了、也没人清理的幽灵记录。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await settle();
    expect(await storedHealth()).toEqual({});
  });

  it('失败详情里的 Key 一律脱敏：状态行、`title` 与会话记录都不含它', async () => {
    const secret = 'sk-PROBE-SECRET-123';
    // 非 401 的失败走 `describeHttpError`，`detail` 就是**服务商响应正文**：正文里回显请求内容
    // 是可达的（实测改前存储里与 `title` 里都出现了这把 Key）。401/AUTH 分支给的是罐头文案。
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(textResponse(`{"error":{"message":"invalid key ${secret}"}}`, 400)),
    );
    chromeStub.permissions.grantedOrigins.add(CUSTOM_ORIGIN_PATTERN);
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed({ apiKey: secret })] });
    await loadOptions();

    rowOf('p-a').querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    const editor = editorOf('p-a');
    actionButton(editor, 'test-profile').click();
    await waitFor(() => status().dataset.kind === 'err');
    await waitFor(
      async () =>
        ((await storedHealth())[profileHealthKey('p-a')] as { state?: string } | undefined)?.state === 'bad',
    );

    // ① 记录（持久化那条路径）② `title`（悬停能看见）③ 状态行（当场显示）。
    const detail = ((await storedHealth())[profileHealthKey('p-a')] as { detail: string }).detail;
    expect(detail).not.toContain(secret);
    expect(detail).toContain('***');
    expect(dotOf('p-a').title).not.toContain(secret);
    expect(status().textContent ?? '').not.toContain(secret);
    // 脱敏不是把整句删掉：服务商给的原因（除了 Key 那一段）照常显示。
    expect(status().textContent).toContain('invalid key');
  });

  it('脱敏不看分支：成功路径显示出来的「译文」也一样过一遍', async () => {
    const secret = 'sk-PROBE-SECRET-123';
    // 这不是在断言服务商会把 Key 回显成译文（那是服务商的事），而是说**这条显示路径同样不该漏**：
    // 成功分支的文案也进状态行，凭据一旦出现在里面就是同一个泄漏。删掉那一处脱敏，本条会红。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse(`<<<1>>>\n${secret}`)));
    chromeStub.permissions.grantedOrigins.add(CUSTOM_ORIGIN_PATTERN);
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed({ apiKey: secret })] });
    await loadOptions();

    rowOf('p-a').querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    actionButton(editorOf('p-a'), 'test-profile').click();
    await waitFor(() => status().dataset.kind === 'ok');

    expect(status().textContent).toContain('***');
    expect(status().textContent).not.toContain(secret);
  });

  it('短 Key（<8 字符）不做脱敏：正常译文与被回显的失败文案都必须原样', async () => {
    // 精确子串替换在短串上必然误伤：`apiKey='hello'` + 译文 `你好，hello world` 会被抹成
    // `你好，*** world`，`apiKey='你好'` + 译文 `你好` 会被整句抹成 `***`。短串本来也无法在
    // 文本里可靠识别成凭据（真凭据都够长），所以门槛设在 8——这里把门槛两侧都钉住。
    const shortKey = 'hello';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatResponse(`<<<1>>>\n你好，${shortKey} world`))
      .mockResolvedValueOnce(textResponse(`{"error":{"message":"bad ${shortKey} request"}}`, 400));
    vi.stubGlobal('fetch', fetchMock);
    chromeStub.permissions.grantedOrigins.add(CUSTOM_ORIGIN_PATTERN);
    await seedSettings({ engineId: 'p-a', profiles: [profileSeed({ apiKey: shortKey })] });
    await loadOptions();

    rowOf('p-a').querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    const editor = editorOf('p-a');

    // ① 成功分支：译文里的 `hello` 原样显示（`hello` 同时也是请求文本，所以钉的是整句译文）。
    actionButton(editor, 'test-profile').click();
    await waitFor(() => status().dataset.kind === 'ok');
    expect(status().textContent).toContain(`你好，${shortKey} world`);
    expect(status().textContent).not.toContain('***');

    // ② 失败分支：服务商正文里的同一个词也原样进记录与状态行。
    actionButton(editor, 'test-profile').click();
    await waitFor(() => status().dataset.kind === 'err');
    await waitFor(
      async () =>
        ((await storedHealth())[profileHealthKey('p-a')] as { state?: string } | undefined)?.state === 'bad',
    );
    const detail = ((await storedHealth())[profileHealthKey('p-a')] as { detail: string }).detail;
    expect(detail).toContain(`bad ${shortKey} request`);
    expect(detail).not.toContain('***');
    expect(status().textContent).toContain(`bad ${shortKey} request`);
  });
});

describe('档案记录键的形状（`p:` 前缀与档案 id 是两个概念）', () => {
  /**
   * **键空间的唯一一条守卫**（`e:` 键空间随免费引擎一起消亡之后，这条用例守的东西换了）。
   *
   * 标题：档案 id 可以长得像任何东西（含 `p:` 前缀本身）：记录键由前缀**加**出来，
   * 点从记录键**解**回来，账不串。
   *
   * 夹具取 `'p:dup'`：它**今天已经没有特殊含义、但长得最像键**（`p:` + `dup` 恰好是另一个
   * 档案的记录键形状）。这条同时覆盖了"永远不要从存储里的老 `p:` 键认领记录"那半条说明——
   * 因为档案 id 恰好等于"另一个档案的键"。
   *
   * 三条行为层的牙（逐条写在这里，别只看"这条用例红了"）：
   * - **牙①（写侧）**：`handleTestProfile` 若不把 `profileHealthKey(id)` 交出去、而是交**裸 id**，
   *   存储里落的键是 `'p:dup'`，而下面按 `profileHealthKey('p:dup')` = `'p:p:dup'` 取值 → 红。
   * - **牙②（就地更新）**：`rowForKey` 若不再从记录键**解**出 id（拿键当 id 用），
   *   键 `'p:p:dup'` 找不到任何行，点停在 `idle` → 红。
   * - **牙③（整表重绘）**：`buildProfileRow` 若按**裸 id** 读 `health[id]`，就地更新那一次仍然绿
   *   （`recordHealth` 自己会更新点），只有走一次**真的重绘**才露馅——所以这里点一次「保存」
   *   触发 `renderProfiles`，再读点。
   *
   * **如实记账**：`PROFILE_HEALTH_PREFIX` 从 `'p:'` 改成 `''`（或别的）在**行为上不可观察**
   * （读写两侧共用同一个函数，键只是换了个形状），所以它**不是上面三条牙的杀手**——那正是
   * `engine-health.ts` 里说"退回裸 id 是一次没有收益的改动"的意思。它由下面第四条断言钉住。
   */
  it('档案 id 可以长得像任何东西（含 `p:` 前缀本身）：记录键由前缀加出来，点从记录键解回来，账不串', async () => {
    const dirtyId = 'p:dup';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好')));
    chromeStub.permissions.grantedOrigins.add(CUSTOM_ORIGIN_PATTERN);
    await seedSettings({
      engineId: dirtyId,
      targetLang: 'zh-Hans',
      profiles: [profileSeed({ id: dirtyId, label: '长得像记录键的档案' })],
    });
    await loadOptions();

    rowOf(dirtyId).querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    actionButton(editorOf(dirtyId), 'test-profile').click();
    await waitFor(() => status().dataset.kind === 'ok');
    await waitFor(async () => (await storedHealth())[profileHealthKey(dirtyId)] !== undefined);

    // 牙①：写侧用的必须是 `profileHealthKey(id)`（= `p:p:dup`），不是裸 id。
    expect((await storedHealth())[profileHealthKey(dirtyId)]).toEqual({ state: 'ok', detail: '' });
    // 牙②：`rowForKey` 必须从记录键解回 id 才能找到这一行的点。
    expect(dotOf(dirtyId).dataset.state).toBe('ok');

    // 牙③：整表重绘（点一次「保存」→ `renderProfiles` → 重新 `applyDot`）之后仍然各念各的那一格。
    actionButton(editorOf(dirtyId), 'save-profile').click();
    await waitFor(() => (status().textContent ?? '').includes('已保存档案'));
    expect(dotOf(dirtyId).dataset.state).toBe('ok');
    expect((await storedHealth())[profileHealthKey(dirtyId)]).toEqual({ state: 'ok', detail: '' });

    // 牙④（**形状守卫，不是行为守卫**）：键的形状本身是刻意的选择——`p:` 前缀就是
    // "记录键"与"档案 id"两个概念的分界（见 `engine-health.ts` 顶部）。行为上删掉它不可观察，
    // 所以只有这一条会在"有人把前缀删了"时响。别把它读成"串台又回来了"。
    expect(profileHealthKey('dup')).toBe('p:dup');
    expect(profileIdFromHealthKey('p:dup')).toBe('dup');
  });
});
