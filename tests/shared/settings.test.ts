import { describe, expect, it } from 'vitest';
import {
  CURRENT_VERSION,
  DEFAULT_SETTINGS,
  LEGACY_PROFILE_ID,
  PROVIDER_PRESETS,
  SETTINGS_KEY,
  createProfileId,
  isAllowedBaseUrl,
  loadSettings,
  loadUiSettings,
  mergeSettings,
  resolveEngine,
  saveSettings,
  type EngineProfile,
} from '../../src/shared/settings';
import { MemoryStorage } from '../helpers/memory-storage';

/** 构造一份形状完整合法的档案；`over` 覆盖单个字段，用例只写自己在意的那部分。 */
function profile(over: Partial<EngineProfile> = {}): EngineProfile {
  return {
    id: 'p1',
    label: '我的 DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat'],
    activeModel: 'deepseek-chat',
    apiKey: 'sk-keep',
    ...over,
  };
}

describe('mergeSettings', () => {
  it('空对象得到完整默认值', () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.engineId).toBe('google');
    expect(DEFAULT_SETTINGS.profiles).toEqual([]);
  });

  it('保留用户已设置的值', () => {
    const merged = mergeSettings({ targetLang: 'ja', engineId: 'openai-compat' });
    expect(merged.targetLang).toBe('ja');
    expect(merged.engineId).toBe('openai-compat');
  });

  it('补齐缺失字段', () => {
    const merged = mergeSettings({ targetLang: 'ja' });
    expect(merged.displayMode).toBe(DEFAULT_SETTINGS.displayMode);
    expect(merged.profiles).toEqual([]);
  });

  it('忽略类型不符的值', () => {
    const merged = mergeSettings({ concurrency: '很多' as unknown as number, siteRules: 'not-an-array' as unknown as [] });
    expect(merged.concurrency).toBe(DEFAULT_SETTINGS.concurrency);
    expect(merged.siteRules).toEqual([]);
  });

  it('过滤掉结构不完整的站点规则与术语', () => {
    const merged = mergeSettings({
      siteRules: [{ pattern: '*.a.com', action: 'never' }, { pattern: 'x' }, null],
      glossary: [{ from: 'DSH', to: 'DeepSeek Harness' }, { from: 'only' }],
    });
    expect(merged.siteRules).toEqual([{ pattern: '*.a.com', action: 'never' }]);
    expect(merged.glossary).toEqual([{ from: 'DSH', to: 'DeepSeek Harness' }]);
  });

  it('数字超出合理范围时夹紧', () => {
    expect(mergeSettings({ concurrency: 999 }).concurrency).toBe(8);
    expect(mergeSettings({ concurrency: 0 }).concurrency).toBe(1);
  });

  it('对任意非对象输入都不抛错', () => {
    for (const raw of [null, undefined, 42, 'x', true, [], [1, 2], () => 1, Symbol('s')]) {
      expect(() => mergeSettings(raw)).not.toThrow();
      expect(mergeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
  });

  describe('profiles 的反序列化边界（逐条归一化，脏条目丢掉而不是崩）', () => {
    it('非数组一律当没有档案', () => {
      for (const raw of [null, undefined, 'x', 42, {}]) {
        expect(mergeSettings({ profiles: raw as unknown as EngineProfile[] }).profiles).toEqual([]);
      }
    });

    it('缺 id / id 非字符串的条目被跳过：engineId 靠 id 引用，没有 id 的档案无法被指向', () => {
      const merged = mergeSettings({
        profiles: [
          { label: '没有 id', baseUrl: 'https://a.example/v1' },
          { id: 42, label: 'id 不是字符串' },
          { id: '   ' },
          profile({ id: 'good' }),
        ] as unknown as EngineProfile[],
      });
      expect(merged.profiles.map((item) => item.id)).toEqual(['good']);
    });

    it('重复 id 只留第一个：engineId 只能有一个指代对象', () => {
      const merged = mergeSettings({
        profiles: [profile({ id: 'dup', label: '第一个' }), profile({ id: 'dup', label: '第二个' })],
      });
      expect(merged.profiles).toHaveLength(1);
      expect(merged.profiles[0].label).toBe('第一个');
    });

    it('合法条目字段一字不差地保留；label 空白按「我的接口」处理', () => {
      const merged = mergeSettings({ profiles: [profile()] });
      expect(merged.profiles).toEqual([profile()]);
      expect(mergeSettings({ profiles: [profile({ label: '   ' })] }).profiles[0].label).toBe('我的接口');
      expect(mergeSettings({ profiles: [profile({ label: 42 as unknown as string })] }).profiles[0].label).toBe('我的接口');
    });

    it('apiKey 缺失或脏值补空串；旧 model 字段不再读，v4 的 models / activeModel 都补空', () => {
      const merged = mergeSettings({
        profiles: [{ id: 'p', apiKey: null, model: 7 }] as unknown as EngineProfile[],
      });
      expect(merged.profiles[0]).toEqual({ id: 'p', label: '我的接口', baseUrl: '', models: [], activeModel: '', apiKey: '' });
    });
  });

  it('只有一份真相：engineConfig / providerPreset 不再是设置字段，脏输入里出现也不会带出来', () => {
    const merged = mergeSettings({
      engineConfig: { apiKey: 'sk-x', baseUrl: 'https://a.example/v1', model: 'm' },
      providerPreset: 'deepseek',
    } as unknown as Record<string, unknown>);
    expect('engineConfig' in merged).toBe(false);
    expect('providerPreset' in merged).toBe(false);
  });

  it('v4 起 model 不再是档案字段：脏输入里出现也不会被带出来', () => {
    const merged = mergeSettings({
      profiles: [{ id: 'p', model: 'ghost', models: ['real'], activeModel: 'real' }],
    });
    expect(merged.profiles[0]).toEqual({
      id: 'p',
      label: '我的接口',
      baseUrl: '',
      models: ['real'],
      activeModel: 'real',
      apiKey: '',
    });
  });

  it('版本号必须能原样读回（迁移要靠它判断来源版本）', () => {
    expect(mergeSettings({ version: 99 }).version).toBe(99);
    expect(mergeSettings({ version: 'v2' }).version).toBe(CURRENT_VERSION);
    expect(mergeSettings({ version: 0 }).version).toBe(CURRENT_VERSION);
    expect(mergeSettings({ version: 1.5 }).version).toBe(CURRENT_VERSION);
    expect(mergeSettings({}).version).toBe(CURRENT_VERSION);
    expect(mergeSettings({ version: 2 }, 3).version).toBe(3);
  });

  it('不共享默认值里的可变对象', () => {
    expect(mergeSettings({}).siteRules).not.toBe(DEFAULT_SETTINGS.siteRules);
    expect(mergeSettings({}).glossary).not.toBe(DEFAULT_SETTINGS.glossary);
    expect(mergeSettings({}).profiles).not.toBe(DEFAULT_SETTINGS.profiles);
  });
});

describe('显示模式（默认值、迁移）', () => {
  it('默认是「仅译文」', () => {
    expect(DEFAULT_SETTINGS.displayMode).toBe('translated-only');
    expect(mergeSettings({}).displayMode).toBe('translated-only');
    expect(mergeSettings({ targetLang: 'ja' }).displayMode).toBe('translated-only');
  });

  it('保留用户明确选过的双语', () => {
    expect(mergeSettings({ displayMode: 'bilingual' }).displayMode).toBe('bilingual');
    expect(mergeSettings({ displayMode: 'translated-only' }).displayMode).toBe('translated-only');
  });

  it("把老数据里的 'replace' 迁移成 'translated-only'，而不是回落", () => {
    // 老用户的存储里就是 'replace'（v1 时代的"整页替换"）。当成未知值处理会退回**默认值**，
    // 于是默认值哪天再变一次，他们就会莫名其妙地被切回双语——那正是他们当年特意改掉的默认行为。
    // 所以映射写死成 'translated-only'，与当前的默认值是不是它无关（这条断言不引用
    // DEFAULT_SETTINGS，正是为了在默认值改变时仍然有意义）。
    expect(mergeSettings({ displayMode: 'replace' }).displayMode).toBe('translated-only');
    expect(mergeSettings({ displayMode: 'replace', version: 1 }).displayMode).toBe('translated-only');
  });

  it('不认识的显示模式退回默认值', () => {
    for (const raw of ['nope', '', null, 42, {}, []]) {
      expect(mergeSettings({ displayMode: raw }).displayMode).toBe(DEFAULT_SETTINGS.displayMode);
    }
  });

  it('loadSettings 读到老数据时就完成迁移（不需要用户再改一次设置）', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 1, displayMode: 'replace' } });
    expect((await loadSettings(area)).displayMode).toBe('translated-only');
  });

  describe('v1 → v2：冻结的 displayMode 要迁到新默认', () => {
    /**
     * 这一条是实测踩出来的：用户配完 DeepSeek（点过保存）之后升级到「仅译文」，
     * 页面上却还是双语。原因是 `saveSettings` 是**整份覆盖**——那次保存把当时的默认值
     * `bilingual` 一起冻结进了存储，而它是个合法值，程序没有理由覆盖它。
     *
     * v1 时代设置页与弹窗都没有改显示模式的界面，所以存储里的 `bilingual` 一定是冻结的
     * 默认值，不是用户的选择。因此按版本号迁移是安全的，也是唯一能让老用户拿到新默认的办法。
     */
    it('v1 存储里的 bilingual 迁成 translated-only', async () => {
      const area = new MemoryStorage();
      await area.set({ [SETTINGS_KEY]: { version: 1, displayMode: 'bilingual' } });
      expect((await loadSettings(area)).displayMode).toBe('translated-only');
    });

    it('v2 存储里的 bilingual 是用户真的选过的，不能动', async () => {
      const area = new MemoryStorage();
      await area.set({ [SETTINGS_KEY]: { version: 2, displayMode: 'bilingual' } });
      expect((await loadSettings(area)).displayMode).toBe('bilingual');
    });

    it('迁移只看版本号，v1 里已经是 translated-only 的保持不动', async () => {
      const area = new MemoryStorage();
      await area.set({ [SETTINGS_KEY]: { version: 1, displayMode: 'translated-only' } });
      expect((await loadSettings(area)).displayMode).toBe('translated-only');
    });

    it('读完之后版本号被标成当前版本，不会每次加载都再迁一遍', async () => {
      const area = new MemoryStorage();
      await area.set({ [SETTINGS_KEY]: { version: 1, displayMode: 'bilingual' } });
      const settings = await loadSettings(area);
      expect(settings.version).toBe(CURRENT_VERSION);
    });
  });
});

describe('BaseURL 校验（它决定 API Key 发往哪里，逐档案生效）', () => {
  const baseUrlOf = (value: unknown): string =>
    mergeSettings({ profiles: [{ id: 'p', baseUrl: value } as unknown as EngineProfile] }).profiles[0].baseUrl;

  it('接受 https 地址并去掉首尾空白', () => {
    expect(baseUrlOf('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1');
    expect(baseUrlOf('  https://api.deepseek.com/v1  ')).toBe('https://api.deepseek.com/v1');
  });

  it('拒绝非 https 的远端地址：归一化成空串，绝不悄悄换成另一个真实端点', () => {
    // 档案的 apiKey 就存进同一条目里——非法地址若"退回默认值"，等于把用户的 Key
    // 发给另一个服务商。空串让引擎在翻译时明确报「尚未填写接口地址」，不发任何请求。
    for (const raw of ['http://evil.example', '//evil.example', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(baseUrlOf(raw)).toBe('');
    }
    expect(baseUrlOf('http://evil.example')).not.toContain('openai');
  });

  it('放行本机回环地址的 http（本地推理服务）', () => {
    expect(baseUrlOf('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(baseUrlOf('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1');
  });

  it('拒绝连不上主机的地址与非字符串', () => {
    for (const raw of ['not a url', '', 'https://', 42, null]) {
      expect(baseUrlOf(raw)).toBe('');
    }
  });
});

describe('档案解析：resolveEngine 是唯一一处「engineId → 引擎 + 配置」', () => {
  it('engineId 命中某个档案 → OpenAI 兼容引擎 + 那份档案的配置（逐字段）', () => {
    const { engine, config } = resolveEngine({ engineId: 'p1', profiles: [profile()] });
    expect(engine.id).toBe('openai-compat');
    expect(config).toEqual({
      apiKey: 'sk-keep',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    });
  });

  it('多档案时各解析各的：命中的那份胜出，不混字段', () => {
    const { engine, config } = resolveEngine({
      engineId: 'p2',
      profiles: [profile(), profile({ id: 'p2', apiKey: 'sk-b', baseUrl: 'https://b.example/v1', models: ['m2'], activeModel: 'm2' })],
    });
    expect(engine.id).toBe('openai-compat');
    expect(config).toEqual({ apiKey: 'sk-b', baseUrl: 'https://b.example/v1', model: 'm2' });
  });

  it('engineId 是 google → 免费引擎 + 空配置，档案完全不参与', () => {
    const { engine, config } = resolveEngine({ engineId: 'google', profiles: [profile()] });
    expect(engine.id).toBe('google');
    expect(config).toEqual({});
  });

  it('engineId 指向不存在的档案（并发删除留下的残值）→ 回落免费引擎，不抛错', () => {
    const { engine, config } = resolveEngine({ engineId: '已删掉的', profiles: [profile()] });
    expect(engine.id).toBe('google');
    expect(config).toEqual({});
  });

  it('裸 openai-compat（没配任何档案）→ 引擎自己给出可行动的 AUTH 提示，不是网络错误', async () => {
    const { engine, config } = resolveEngine({ engineId: 'openai-compat', profiles: [] });
    expect(engine.id).toBe('openai-compat');
    await expect(
      engine.translate({ texts: ['Hello'], from: 'auto', to: 'zh-Hans', signal: new AbortController().signal }, config),
    ).rejects.toThrow(/API Key/);
  });

  it('config.model 取的是 activeModel，不是清单里的其它项', () => {
    const { config } = resolveEngine({
      engineId: 'p1',
      profiles: [profile({ models: ['a', 'b', 'c'], activeModel: 'b' })],
    });
    expect(config.model).toBe('b');
  });
});

describe('createProfileId：新建档案的稳定唯一 id', () => {
  it('非空、互不相同，且不拿 label 当 id', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) ids.add(createProfileId());
    for (const id of ids) expect(id.trim().length).toBeGreaterThan(0);
    expect(ids.size).toBe(50);
    expect(ids.has('我的 DeepSeek')).toBe(false);
  });
});

describe('迁移 v2 → v3：单份 engineConfig 折成一个档案', () => {
  const v2Config = {
    engineId: 'openai-compat',
    engineConfig: { apiKey: 'sk-ds', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  };

  it('openai-compat + DeepSeek 预设 → 一个档案，字段一字不差，engineId 变成档案 id', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 2, ...v2Config, providerPreset: 'deepseek' } });
    const settings = await loadSettings(area);
    expect(settings.profiles).toEqual([
      {
        id: LEGACY_PROFILE_ID,
        label: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat'],
        activeModel: 'deepseek-chat',
        apiKey: 'sk-ds',
      },
    ]);
    expect(settings.engineId).toBe(LEGACY_PROFILE_ID);
    expect(settings.version).toBe(CURRENT_VERSION);
  });

  it('label 取迁移当时 providerPreset 对应的服务商名；custom / 缺失 / 脏值用「我的接口」', async () => {
    const cases: Array<[unknown, string]> = [
      ['openai', 'OpenAI'],
      ['deepseek', 'DeepSeek'],
      ['ollama', 'Ollama（本机）'],
      ['custom', '我的接口'],
      [undefined, '我的接口'],
      ['claude', '我的接口'],
    ];
    for (const [preset, label] of cases) {
      const area = new MemoryStorage();
      await area.set({ [SETTINGS_KEY]: { version: 2, ...v2Config, providerPreset: preset } });
      const settings = await loadSettings(area);
      expect(settings.profiles.map((item) => item.label)).toEqual([label]);
    }
  });

  it('engineId 是 google 时不产生档案，也不改 engineId（那份 engineConfig 多半是没选过的残留）', async () => {
    const area = new MemoryStorage();
    await area.set({
      [SETTINGS_KEY]: {
        version: 2,
        engineId: 'google',
        providerPreset: 'deepseek',
        engineConfig: { apiKey: 'sk-ds', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      },
    });
    const settings = await loadSettings(area);
    expect(settings.profiles).toEqual([]);
    expect(settings.engineId).toBe('google');
  });

  it('engineConfig 坏掉也得到一个空档案而不是崩：字段全按默认补齐', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 2, engineId: 'openai-compat', engineConfig: null } });
    const settings = await loadSettings(area);
    expect(settings.profiles).toEqual([
      { id: LEGACY_PROFILE_ID, label: '我的接口', baseUrl: '', models: [], activeModel: '', apiKey: '' },
    ]);
    expect(settings.engineId).toBe(LEGACY_PROFILE_ID);
  });

  it('v1 数据按序走两步：displayMode 冻结值迁移 + 档案折叠', async () => {
    const area = new MemoryStorage();
    await area.set({
      [SETTINGS_KEY]: {
        version: 1,
        displayMode: 'bilingual',
        engineId: 'openai-compat',
        providerPreset: 'openai',
        engineConfig: { apiKey: 'sk-oai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
      },
    });
    const settings = await loadSettings(area);
    expect(settings.displayMode).toBe('translated-only');
    expect(settings.profiles).toEqual([
      {
        id: LEGACY_PROFILE_ID,
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        models: ['gpt-4o-mini'],
        activeModel: 'gpt-4o-mini',
        apiKey: 'sk-oai',
      },
    ]);
    expect(settings.engineId).toBe(LEGACY_PROFILE_ID);
  });

  it('迁移过一次再存回存储（v3）：重复加载不会折出第二个档案，也不动 engineId', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 2, ...v2Config, providerPreset: 'deepseek' } });
    const first = await loadSettings(area);
    await saveSettings(first, area);
    // 存储里落定的是 v3 形状：engineConfig / providerPreset 不再存在。
    const raw = (await area.get([SETTINGS_KEY]))[SETTINGS_KEY] as Record<string, unknown>;
    expect(raw.version).toBe(CURRENT_VERSION);
    expect('engineConfig' in raw).toBe(false);
    expect('providerPreset' in raw).toBe(false);
    const second = await loadSettings(area);
    expect(second).toEqual(first);
    expect(second.profiles).toHaveLength(1);
  });

  it('已有 profiles 的 v3 数据即使残留 engineConfig 也不再迁移（幂等）', async () => {
    const area = new MemoryStorage();
    await area.set({
      [SETTINGS_KEY]: {
        version: 3,
        engineId: 'p-a',
        // ⚠ 这里**必须**是 v3 字面量（单 `model`），不能用顶部那个 v4 形状的 `profile()` 夹具。
        // `profile()` 产出的是带 `models` / `activeModel`、**没有** `model` 的档案；拿它种一份
        // `version: 3` 的数据等于伪造一份"v3 里不可能存在"的形状——`liftProfileModels` 会照实
        // 读成"这个档案没有模型"，于是这条用例仍会绿，但它想钉住的"残留 engineConfig 不再折叠"
        // 已经被 v3 → v4 的抬起改写成另一件事了（旧写法实测读数：`activeModel: ''` / `models: []`）。
        profiles: [
          { id: 'p-a', label: '手工档案', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-a' },
        ],
        engineConfig: { apiKey: 'sk-ghost', baseUrl: 'https://ghost.example/v1', model: 'ghost' },
        providerPreset: 'ollama',
      },
    });
    const settings = await loadSettings(area);
    // v3 的档案读出来就是 v4 形状：单 model 抬成清单 + 当前模型，Key / 地址 / 名字一字不差。
    // 幽灵 engineConfig 若被折叠，这里会变成一份 label 为「Ollama（本机）」、Key 为 `sk-ghost`
    // 的 legacy 档案——那才是这条用例真正守着的东西。
    expect(settings.profiles).toEqual([
      {
        id: 'p-a',
        label: '手工档案',
        baseUrl: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat'],
        activeModel: 'deepseek-chat',
        apiKey: 'sk-a',
      },
    ]);
    expect(settings.engineId).toBe('p-a');
  });

  it('v2 的其它字段原样保留（迁移只动 engineConfig / providerPreset / engineId 三处）', async () => {
    const area = new MemoryStorage();
    await area.set({
      [SETTINGS_KEY]: {
        version: 2,
        ...v2Config,
        targetLang: 'ja',
        displayMode: 'bilingual',
        concurrency: 5,
        glossary: [{ from: 'DSH', to: 'DeepSeek Harness' }],
      },
    });
    const settings = await loadSettings(area);
    expect(settings.targetLang).toBe('ja');
    // v2 存储里的 bilingual 是用户选过的，v3 迁移不许顺手改掉。
    expect(settings.displayMode).toBe('bilingual');
    expect(settings.concurrency).toBe(5);
    expect(settings.glossary).toEqual([{ from: 'DSH', to: 'DeepSeek Harness' }]);
  });
});

describe('迁移 v3 → v4：单 model 抬起成 models + activeModel', () => {
  /**
   * 种一份 v3 形状的设置再按当前代码读出来。
   * 注意 `MemoryStorage` 的构造参数是**配额选项**，不是初始数据——种数据一律走 `area.set`。
   *
   * ⚠ **这里不能给 `model` 写默认参数**（计划原文是 `model: unknown = 'deepseek-chat'`，逐字跑
   * 实测红）：默认参数会把 `loadV3(undefined)` 悄悄换回 `'deepseek-chat'`，于是"整个缺失"那
   * 一半永远种不进去——它测的还是"有 model"，只是看起来像在测缺失。缺省值由调用方显式传。
   *
   * `undefined` = **不写 `model` 键**（标题里的"整个缺失"），不是"写一个 undefined 进去"。
   */
  async function loadV3(model: unknown) {
    const stored: Record<string, unknown> = {
      id: 'p1',
      label: '我的 DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-keep',
    };
    if (model !== undefined) stored.model = model;
    const area = new MemoryStorage();
    await area.set({
      [SETTINGS_KEY]: {
        version: 3,
        engineId: 'p1',
        profiles: [stored],
      },
    });
    return { area, loaded: await loadSettings(area) };
  }

  it('model 有值 → models:[model] + activeModel:model，且 Key / 地址 / 名字一字不差', async () => {
    const { loaded } = await loadV3('deepseek-chat');

    expect(loaded.profiles[0]).toEqual({
      id: 'p1',
      label: '我的 DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat'],
      activeModel: 'deepseek-chat',
      apiKey: 'sk-keep',
    });
    // 读完被标成当前版本（迁移标记），但存储里那份**没被动过**：迁移只发生在读的那一刻。
    expect(loaded.version).toBe(CURRENT_VERSION);
  });

  it('model 是空串或整个缺失 → models:[] + activeModel:""（不是"没有这两个字段"）', async () => {
    for (const model of ['', undefined]) {
      const { loaded } = await loadV3(model);
      expect([model, loaded.profiles[0].models, loaded.profiles[0].activeModel]).toEqual([model, [], '']);
    }
  });

  it('model 首尾空白被 trim 掉再进清单（与 pickModels 同一判据）', async () => {
    const { loaded } = await loadV3('  deepseek-chat  ');
    expect(loaded.profiles[0].models).toEqual(['deepseek-chat']);
    expect(loaded.profiles[0].activeModel).toBe('deepseek-chat');
  });

  it('v1 数据一次走三步：displayMode 冻结值迁移 + 折叠 + 抬起（三条路径收敛到同一形状）', async () => {
    const area = new MemoryStorage();
    await area.set({
      [SETTINGS_KEY]: {
        version: 1,
        displayMode: 'bilingual',
        engineId: 'openai-compat',
        providerPreset: 'deepseek',
        engineConfig: { apiKey: 'sk-ds', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      },
    });
    const loaded = await loadSettings(area);

    expect(loaded.displayMode).toBe('translated-only');
    expect(loaded.engineId).toBe(LEGACY_PROFILE_ID);
    expect(loaded.profiles).toEqual([
      {
        id: LEGACY_PROFILE_ID,
        label: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat'],
        activeModel: 'deepseek-chat',
        apiKey: 'sk-ds',
      },
    ]);
  });

  it('幂等：v4 数据读回不再变，而且写回存储后**没有 model 字段**（旧字段不残留）', async () => {
    const area = new MemoryStorage();
    await area.set({
      [SETTINGS_KEY]: {
        version: CURRENT_VERSION,
        engineId: 'p1',
        // 脏输入里塞一个旧字段：`pickProfile` 不读它，`saveSettings` 也不该把它带回存储。
        profiles: [{ ...profile(), model: 'ghost' }],
      },
    });
    const loaded = await loadSettings(area);
    expect(loaded.profiles[0]).toEqual(profile());

    await saveSettings(loaded, area);
    const raw = (await area.get([SETTINGS_KEY]))[SETTINGS_KEY] as { profiles: Array<Record<string, unknown>> };
    expect(Object.keys(raw.profiles[0]).sort()).toEqual(['activeModel', 'apiKey', 'baseUrl', 'id', 'label', 'models']);
  });
});

describe('models / activeModel 的反序列化边界', () => {
  /** 种一份 v4 形状（`version` 就是当前版本，所以不触发任何迁移）。 */
  async function loadWith(value: Record<string, unknown>) {
    const area = new MemoryStorage();
    await area.set({
      [SETTINGS_KEY]: {
        version: CURRENT_VERSION,
        engineId: 'p1',
        profiles: [{ id: 'p1', label: 'x', baseUrl: 'https://a.example/v1', apiKey: 'sk', ...value }],
      },
    });
    return loadSettings(area);
  }

  it('models 非数组当空；条目里的非字符串 / 空串 / 重复项一律丢掉，首尾空白 trim', async () => {
    const loaded = await loadWith({ models: ['  a  ', 'a', '', 7, null, 'b', 'b', {}], activeModel: 'a' });
    expect(loaded.profiles[0].models).toEqual(['a', 'b']);
    // 非数组当空（同一判据的另一半）。
    expect((await loadWith({ models: 'a,b' })).profiles[0].models).toEqual([]);
  });

  it('activeModel 不是成员（含空串 / 缺失 / 非字符串）→ 置空，**不替用户挑一个**', async () => {
    for (const activeModel of ['c', '', undefined, 7]) {
      const loaded = await loadWith({ models: ['a', 'b'], activeModel });
      // 关键的一半：不许退化成 `models` 的最后一项——那是"用户没选、插件替他选了"。
      expect([activeModel, loaded.profiles[0].activeModel]).toEqual([activeModel, '']);
    }
  });

  it('activeModel 是成员时原样保留（正面半边）', async () => {
    const loaded = await loadWith({ models: ['a', 'b'], activeModel: 'b' });
    expect(loaded.profiles[0].activeModel).toBe('b');
  });
});

describe('loadSettings / saveSettings', () => {
  it('未存储过时返回默认值', async () => {
    expect(await loadSettings(new MemoryStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it('档案列表保存后能原样读回（含 apiKey：完整读取是给受信页面用的）', async () => {
    const area = new MemoryStorage();
    await saveSettings({ ...DEFAULT_SETTINGS, profiles: [profile()], engineId: 'p1' }, area);
    const settings = await loadSettings(area);
    expect(settings.profiles).toEqual([profile()]);
    expect(settings.engineId).toBe('p1');
  });

  it('缺失版本号的老数据按当前版本读出', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { targetLang: 'ja' } });
    const settings = await loadSettings(area);
    expect(settings.targetLang).toBe('ja');
    expect(settings.version).toBe(CURRENT_VERSION);
  });

  it('读取比本代码更新的设置时明确报错而不是静默降级', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 99, targetLang: 'ja' } });
    await expect(loadSettings(area)).rejects.toThrow(/99/);
  });

  it('不会用旧 schema 覆盖更新版本的设置', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 99, targetLang: 'ja' } });
    await expect(saveSettings({ ...DEFAULT_SETTINGS, targetLang: 'ko' }, area)).rejects.toThrow();
    expect((await area.get([SETTINGS_KEY]))[SETTINGS_KEY]).toEqual({ version: 99, targetLang: 'ja' });
  });

  it('写入时归一化，脏数据进不了存储', async () => {
    const area = new MemoryStorage();
    await saveSettings(
      { ...DEFAULT_SETTINGS, concurrency: 999, version: 0, profiles: '脏' as unknown as EngineProfile[] },
      area,
    );
    const stored = (await area.get([SETTINGS_KEY]))[SETTINGS_KEY];
    expect(stored).toEqual({ ...DEFAULT_SETTINGS, concurrency: 8 });
  });
});

describe('loadUiSettings（内容脚本的投影）', () => {
  it('剥掉**每个**档案的 apiKey；列表渲染比单字段更容易带出值，逐项钉死', async () => {
    const area = new MemoryStorage();
    await saveSettings(
      {
        ...DEFAULT_SETTINGS,
        engineId: 'p2',
        profiles: [
          profile({ id: 'p1', apiKey: 'sk-alpha' }),
          profile({ id: 'p2', apiKey: 'sk-beta' }),
          profile({ id: 'p3', apiKey: 'sk-gamma' }),
        ],
      },
      area,
    );

    const ui = await loadUiSettings(area);
    expect(ui.profiles).toHaveLength(3);
    for (const item of ui.profiles) {
      expect(item).not.toHaveProperty('apiKey');
    }
    // 其余字段照常带出（弹窗/内容脚本要看 label、id、地址、模型）。
    expect(ui.profiles[1]).toEqual({ id: 'p2', label: '我的 DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat'], activeModel: 'deepseek-chat' });
    expect(ui.engineId).toBe('p2');
    expect(ui.targetLang).toBe(DEFAULT_SETTINGS.targetLang);
    const json = JSON.stringify(ui);
    for (const secret of ['sk-alpha', 'sk-beta', 'sk-gamma']) expect(json).not.toContain(secret);
  });

  it('完整读取仍然拿得到每个 Key（service worker 与设置页需要）', async () => {
    const area = new MemoryStorage();
    await saveSettings(
      {
        ...DEFAULT_SETTINGS,
        profiles: [
          profile({ id: 'p1', apiKey: 'sk-alpha' }),
          profile({ id: 'p2', apiKey: 'sk-beta' }),
        ],
      },
      area,
    );
    const settings = await loadSettings(area);
    expect(settings.profiles.map((item) => item.apiKey)).toEqual(['sk-alpha', 'sk-beta']);
  });
});

describe('无扩展环境下的默认存储', () => {
  it('没有显式传入存储区时给出可读的错误', async () => {
    await expect(loadSettings()).rejects.toThrow(/StorageArea/);
    await expect(saveSettings(DEFAULT_SETTINGS)).rejects.toThrow(/StorageArea/);
  });
});

/**
 * 服务商预设（用户实测把模型名填成 `deepseek`（正确值 `deepseek-chat`）拿到
 * 一个界面上看不出原因的 HTTP 400 —— 这类错误用一个下拉就能防住）。
 * v3 起它**只是档案编辑表单的填写捷径**，不再是一个持久化字段；
 * 唯一还读它的地方是 v2 → v3 迁移（用它推导老档案的中文 label）。
 */
describe('服务商预设（PROVIDER_PRESETS，只作为档案模板）', () => {
  it('预填值逐字钉住：OpenAI / DeepSeek / Ollama 的地址与模型名（不确定的服务商不放）', () => {
    const byId = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));
    expect([...byId.keys()]).toEqual(['custom', 'openai', 'deepseek', 'ollama']);
    expect(byId.get('openai')).toMatchObject({ label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
    expect(byId.get('deepseek')).toMatchObject({ label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
    expect(byId.get('ollama')).toMatchObject({ label: 'Ollama（本机）', baseUrl: 'http://localhost:11434/v1', model: 'llama3' });
    // 自定义：不预填，保持现状。
    expect(byId.get('custom')?.baseUrl).toBeUndefined();
    expect(byId.get('custom')?.model).toBeUndefined();
  });

  it('每个预填地址都能通过存储层的 BaseURL 校验（填进档案不会反被归一化吞掉）', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.baseUrl !== undefined) expect(isAllowedBaseUrl(preset.baseUrl)).toBe(true);
    }
  });
});
