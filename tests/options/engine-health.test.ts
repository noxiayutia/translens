// tests/options/engine-health.test.ts
/**
 * @vitest-environment jsdom
 *
 * §4.3 状态点三态 + 它背后的记录（`chrome.storage.session` 的 `jinyi:engine-health`）。
 * 另一半：内置免费引擎那一行（§3.1 的"不可删"）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENGINE_ID, getEngine } from '../../src/engines/registry';
import {
  ENGINE_HEALTH_KEY,
  FREE_ENGINE_HEALTH_KEY,
  loadEngineHealth,
  profileHealthKey,
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

/** 内置免费引擎那一行的状态点。它没有 `data-profile-id`，只能按自己的标记找。 */
function freeDot(): HTMLElement {
  const dot = pick<HTMLElement>('profiles').querySelector<HTMLElement>('[data-engine-free] .dot');
  if (dot === null) throw new Error('内置免费引擎那一行没有状态点');
  return dot;
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
    // 只红 6 条，绿的正是本条与上面那条纯存储的）。下面钉住内置免费引擎那一行——它是
    // **每次重绘都会画出来**的那一行，有它在，"页面照常渲染"才是真的在断言渲染。
    expect(profileRows()).toHaveLength(0);
    expect(pick('profiles').querySelector('[data-engine-free]')).not.toBeNull();
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
    await seedSettings({ engineId: 'google', profiles: [profileSeed()] });
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

describe('内置免费引擎那一行', () => {
  it('在列表最后，带「内置」，没有删除也没有编辑（不可删）', async () => {
    await seedSettings({ engineId: 'google', profiles: [profileSeed()] });
    await loadOptions();

    const free = pick<HTMLElement>('profiles').querySelector<HTMLElement>('[data-engine-free]');
    expect(free).not.toBeNull();
    expect(free!.textContent).toContain(getEngine(DEFAULT_ENGINE_ID).name);
    expect(free!.textContent).toContain('内置');
    expect(free!.querySelector('[data-action="delete-profile"]')).toBeNull();
    expect(free!.querySelector('[data-action="toggle"]')).toBeNull();
    // 它排在真实档案之后；而且**不带** data-profile-id（既有用例只数真实档案）。
    expect(profileRows()).toHaveLength(1);
    expect(pick<HTMLElement>('profiles').lastElementChild).toBe(free);
  });

  it('点它的「测试连接」真的发一次请求，成功之后点变绿', async () => {
    // 夹具按**实际实现**给：免费引擎（`src/engines/google.ts` 的 `parseGoogleResponse`）读的是
    // `[[[译文, 原文, …], …], null, 源语言, …]` 这个嵌套数组，不是 OpenAI 兼容那份 `choices`。
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([[['你好', 'hello', null, null, 10]], null, 'en']));
    vi.stubGlobal('fetch', fetchMock);
    await seedSettings({ engineId: 'google', targetLang: 'zh-Hans' });
    await loadOptions();

    const free = pick<HTMLElement>('profiles').querySelector<HTMLElement>('[data-engine-free]')!;
    free.querySelector<HTMLButtonElement>('[data-action="test-free"]')!.click();

    await waitFor(() => status().dataset.kind === 'ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 免费引擎没有 Key，脱敏必须**原样放行**。这条断言昨天守的是"空串不能当要抹的 Key"
    // （那时有一支 `key.length === 0` 的分支），今天空串落在**长度门槛 8** 之外，所以它守的
    // 是门槛本身：把门槛删掉或降到 0，译文会变成 `你***好`，这条当场红（不是恒真）。
    expect(status().textContent).toContain('你好');
    await waitFor(() => pick<HTMLElement>('profiles').querySelector<HTMLElement>('[data-engine-free] .dot')!.dataset.state === 'ok');
  });

  it('档案 id 撞上 `google` 也不串台：免费行的记录落在引擎键上，档案行仍是从没测过', async () => {
    // 脏存储可达：`pickProfile` 对档案 id 只要求"非空字符串"，不做保留字检查（出厂 UI 造不出来，
    // `createProfileId()` 恒带 `p-` 前缀，但存档/外部写入能）。这是"两个键空间"改法之前的
    // 撞车形状：那时两类键共用一个字符串空间，两行共用一个槽——点免费行亮的是**档案行**，
    // 重绘后两行同时绿。
    //
    // 变异口径（两种"合回去"的形态都自己复现过，红的先后不一样，都是本条用例的杀手）：
    // - 只合**键空间**（裸 id + 引擎键 `google`）、保留"先认引擎键"的分派 → 2 红，本条最先红的是
    //   下面那条**键断言**（引擎的记录落在 `google` 这个档案键上）；
    // - 连 `rowForKey` 的分派也一起还原成 `rowById` 优先 → 也是 2 红，但本条最先红的是**点断言**
    //   （`freeDot()` 停在 idle：免费行的结果落到了 id 为 `google` 的档案行上），键断言是拿掉
    //   点断言之后的第二条杀手。
    // 另有一个只把**档案侧前缀**去掉、其余不动的形态：它不走本条，红在"测试连接成功 / 写不进去 /
    // `e:free` 用例"三条上（3 红）——`rowForKey` 再也解不出档案行，那几个点根本不会更新。
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([[['你好', 'hello', null, null, 10]], null, 'en']));
    vi.stubGlobal('fetch', fetchMock);
    await seedSettings({
      engineId: 'google',
      targetLang: 'zh-Hans',
      profiles: [profileSeed({ id: 'google', label: '恰好叫 google 的档案' })],
    });
    await loadOptions();

    expect(dotOf('google').dataset.state).toBe('idle');
    pick<HTMLElement>('profiles').querySelector<HTMLButtonElement>('[data-action="test-free"]')!.click();
    await waitFor(() => status().dataset.kind === 'ok');
    await waitFor(async () => Object.keys(await storedHealth()).length > 0);

    // 免费行的点亮了，档案行的点**没被它点亮**。
    expect(freeDot().dataset.state).toBe('ok');
    expect(dotOf('google').dataset.state).toBe('idle');

    // 记录落在引擎键上；档案那一格（`p:google`）里什么都没有——这一条钉死"把两个键空间合回去"。
    expect((await storedHealth())[profileHealthKey('google')]).toBeUndefined();
    expect((await storedHealth())[FREE_ENGINE_HEALTH_KEY]).toEqual({ state: 'ok', detail: '' });

    // 重绘（展开档案行会重画整个列表）之后两行各念自己那一份记录：共用槽时这里两行同时绿。
    rowOf('google').querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    expect(dotOf('google').dataset.state).toBe('idle');
    expect(freeDot().dataset.state).toBe('ok');
  });

  it('档案 id 直接取成引擎键本身（`e:free`）也不串台：两类键按构造不相等', async () => {
    // 最极端的脏值：档案 id 就是引擎键。判据是"前缀不同 ⇒ 永不相等"——档案键 `p:e:free`、
    // 引擎键 `e:free`，两个字符串在第一个字符上就分开了。
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([[['你好', 'hello', null, null, 10]], null, 'en'])) // 免费引擎那次
      .mockResolvedValueOnce(chatResponse('<<<1>>>\n你好')); // 档案那次（OpenAI 兼容）
    vi.stubGlobal('fetch', fetchMock);
    chromeStub.permissions.grantedOrigins.add(CUSTOM_ORIGIN_PATTERN);
    await seedSettings({
      engineId: 'google',
      targetLang: 'zh-Hans',
      profiles: [profileSeed({ id: FREE_ENGINE_HEALTH_KEY, label: 'id 就是引擎键的档案' })],
    });
    await loadOptions();

    expect(dotOf(FREE_ENGINE_HEALTH_KEY).dataset.state).toBe('idle');
    pick<HTMLElement>('profiles').querySelector<HTMLButtonElement>('[data-action="test-free"]')!.click();
    await waitFor(() => status().dataset.kind === 'ok');
    await waitFor(async () => (await storedHealth())[FREE_ENGINE_HEALTH_KEY] !== undefined);

    // ① 免费行按**引擎键**取到点；那一条 id 恰为引擎键的档案行没被点亮。
    expect(freeDot().dataset.state).toBe('ok');
    expect(dotOf(FREE_ENGINE_HEALTH_KEY).dataset.state).toBe('idle');
    // ② 档案那一格（`p:e:free`）此时还不存在——引擎的结果没有写进档案的键。
    expect((await storedHealth())[profileHealthKey(FREE_ENGINE_HEALTH_KEY)]).toBeUndefined();

    // 重绘一次，确认"各读各的那一格"在列表重画之后仍然成立。
    rowOf(FREE_ENGINE_HEALTH_KEY).querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    expect(dotOf(FREE_ENGINE_HEALTH_KEY).dataset.state).toBe('idle');
    expect(freeDot().dataset.state).toBe('ok');

    // 再把**这个档案**也测一次：两条记录各自落在自己的键上，两个点各自亮自己的。
    actionButton(editorOf(FREE_ENGINE_HEALTH_KEY), 'test-profile').click();
    await waitFor(() => status().dataset.kind === 'ok');
    await waitFor(
      async () => (await storedHealth())[profileHealthKey(FREE_ENGINE_HEALTH_KEY)] !== undefined,
    );

    expect(dotOf(FREE_ENGINE_HEALTH_KEY).dataset.state).toBe('ok');
    expect(freeDot().dataset.state).toBe('ok');
    expect(await storedHealth()).toEqual({
      [FREE_ENGINE_HEALTH_KEY]: { state: 'ok', detail: '' },
      [profileHealthKey(FREE_ENGINE_HEALTH_KEY)]: { state: 'ok', detail: '' },
    });
  });
});
