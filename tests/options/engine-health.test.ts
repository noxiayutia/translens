// tests/options/engine-health.test.ts
/**
 * @vitest-environment jsdom
 *
 * §4.3 状态点三态 + 它背后的记录（`chrome.storage.session` 的 `jinyi:engine-health`）。
 * 另一半：内置免费引擎那一行（§3.1 的"不可删"）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENGINE_ID, getEngine } from '../../src/engines/registry';
import { ENGINE_HEALTH_KEY, loadEngineHealth } from '../../src/options/engine-health';
import {
  chatResponse,
  chromeStub,
  jsonResponse,
  loadOptions,
  pick,
  profileRows,
  profileSeed,
  resetOptionsPage,
  seedSettings,
  waitFor,
} from './harness';

const CUSTOM_ORIGIN_PATTERN = 'https://api.example.com/*';

async function seedHealth(record: Record<string, unknown>): Promise<void> {
  await chromeStub.storage.session.set({ [ENGINE_HEALTH_KEY]: record });
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

beforeEach(() => {
  resetOptionsPage();
});

describe('状态点的记录：读取与脏数据', () => {
  it('读得出来；没记录的档案不在结果里', async () => {
    await seedHealth({ 'p-a': { state: 'ok', detail: '' }, 'p-b': { state: 'bad', detail: 'NETWORK：超时' } });
    await loadOptions();

    const health = await loadEngineHealth();
    expect(health['p-a']).toEqual({ state: 'ok', detail: '' });
    expect(health['p-b']?.state).toBe('bad');
    expect(health['p-c']).toBeUndefined();
  });

  it('存储里是垃圾也不崩：认不出来的条目直接丢掉，能救的救回来（缺 detail 补空串）', async () => {
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
    expect(profileRows()).toHaveLength(0);
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
    await seedHealth({
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
    await waitFor(async () => (await storedHealth())['p-a'] !== undefined);
    expect((await storedHealth())['p-a']).toEqual({ state: 'ok', detail: '' });

    // 再测一次，这次让接口返回 401。
    fetchMock.mockResolvedValue(jsonResponse({ error: 'bad key' }, 401));
    editor.querySelector<HTMLButtonElement>('[data-action="test-profile"]')!.click();
    await waitFor(() => status().dataset.kind === 'err');

    expect(dotOf('p-a').dataset.state).toBe('bad');
    expect(dotOf('p-a').title).toContain('AUTH');
    await waitFor(async () => ((await storedHealth())['p-a'] as { state?: string } | undefined)?.state === 'bad');
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
    await seedHealth({ 'p-a': { state: 'ok', detail: '' }, 'keep': { state: 'bad', detail: 'x' } });
    await loadOptions();

    profileRows()[0].querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
    const editor = profileRows()[0].querySelector('.profile-editor') as Element;
    editor.querySelector<HTMLButtonElement>('[data-action="delete-profile"]')!.click();

    await waitFor(async () => (await storedHealth())['p-a'] === undefined);
    expect(Object.keys(await storedHealth())).toEqual(['keep']);
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
    await waitFor(() => pick<HTMLElement>('profiles').querySelector<HTMLElement>('[data-engine-free] .dot')!.dataset.state === 'ok');
  });
});
