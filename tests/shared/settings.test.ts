import { describe, expect, it } from 'vitest';
import {
  CURRENT_VERSION,
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  SETTINGS_KEY,
  isAllowedBaseUrl,
  loadSettings,
  loadUiSettings,
  mergeSettings,
  saveSettings,
} from '../../src/shared/settings';
import { MemoryStorage } from '../helpers/memory-storage';

describe('mergeSettings', () => {
  it('空对象得到完整默认值', () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('保留用户已设置的值', () => {
    const merged = mergeSettings({ targetLang: 'ja', engineId: 'openai-compat' });
    expect(merged.targetLang).toBe('ja');
    expect(merged.engineId).toBe('openai-compat');
  });

  it('补齐缺失字段', () => {
    const merged = mergeSettings({ targetLang: 'ja' });
    expect(merged.displayMode).toBe(DEFAULT_SETTINGS.displayMode);
    expect(merged.engineConfig).toEqual(DEFAULT_SETTINGS.engineConfig);
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

  it('损坏的 engineConfig 退回默认值', () => {
    expect(mergeSettings({ engineConfig: null }).engineConfig).toEqual(DEFAULT_SETTINGS.engineConfig);
    expect(mergeSettings({ engineConfig: [] }).engineConfig).toEqual(DEFAULT_SETTINGS.engineConfig);
    expect(mergeSettings({ engineConfig: 'x' }).engineConfig).toEqual(DEFAULT_SETTINGS.engineConfig);
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
    expect(mergeSettings({}).engineConfig).not.toBe(DEFAULT_SETTINGS.engineConfig);
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

describe('BaseURL 校验（它决定 API Key 发往哪里）', () => {
  const baseUrlOf = (value: unknown): string =>
    mergeSettings({ engineConfig: { baseUrl: value } }).engineConfig.baseUrl;

  it('接受 https 地址并去掉首尾空白', () => {
    expect(baseUrlOf('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1');
    expect(baseUrlOf('  https://api.deepseek.com/v1  ')).toBe('https://api.deepseek.com/v1');
  });

  it('拒绝非 https 的远端地址', () => {
    expect(baseUrlOf('http://evil.example')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
    expect(baseUrlOf('//evil.example')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
    expect(baseUrlOf('file:///etc/passwd')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
    expect(baseUrlOf('javascript:alert(1)')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
  });

  it('放行本机回环地址的 http（本地推理服务）', () => {
    expect(baseUrlOf('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(baseUrlOf('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1');
  });

  it('拒绝连不上主机的地址与非字符串', () => {
    expect(baseUrlOf('not a url')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
    expect(baseUrlOf('')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
    expect(baseUrlOf('https://')).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
    expect(baseUrlOf(42)).toBe(DEFAULT_SETTINGS.engineConfig.baseUrl);
  });
});

describe('loadSettings / saveSettings', () => {
  it('未存储过时返回默认值', async () => {
    expect(await loadSettings(new MemoryStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it('保存后能读回', async () => {
    const area = new MemoryStorage();
    await saveSettings({ ...DEFAULT_SETTINGS, targetLang: 'ko' }, area);
    expect((await loadSettings(area)).targetLang).toBe('ko');
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
    await saveSettings({ ...DEFAULT_SETTINGS, concurrency: 999, version: 0 }, area);
    const stored = (await area.get([SETTINGS_KEY]))[SETTINGS_KEY];
    expect(stored).toEqual({ ...DEFAULT_SETTINGS, concurrency: 8 });
  });
});

describe('loadUiSettings', () => {
  it('不带出 API Key，其余设置与完整读取一致', async () => {
    const area = new MemoryStorage();
    await saveSettings(
      { ...DEFAULT_SETTINGS, engineConfig: { apiKey: 'sk-secret', baseUrl: 'https://a.example/v1', model: 'm' } },
      area,
    );

    const ui = await loadUiSettings(area);
    expect(ui.engineConfig).not.toHaveProperty('apiKey');
    expect(ui.engineConfig).toEqual({ baseUrl: 'https://a.example/v1', model: 'm' });
    expect(ui.targetLang).toBe(DEFAULT_SETTINGS.targetLang);
    expect(JSON.stringify(ui)).not.toContain('sk-secret');
  });

  it('完整读取仍然拿得到 API Key（service worker 与设置页需要）', async () => {
    const area = new MemoryStorage();
    await saveSettings({ ...DEFAULT_SETTINGS, engineConfig: { apiKey: 'sk-secret', baseUrl: 'https://a.example/v1', model: 'm' } }, area);
    expect((await loadSettings(area)).engineConfig.apiKey).toBe('sk-secret');
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
 * 存储字段 `providerPreset` 默认 `custom`：**老数据没有这个字段，加载不报错、
 * 已有用户的存储值一个都不动**（mergeSettings 逐字段补齐的老规矩）。
 */
describe('服务商预设（providerPreset）', () => {
  it('默认与老数据（缺字段）都是 custom，不报错也不改别人的值', () => {
    expect(DEFAULT_SETTINGS.providerPreset).toBe('custom');
    const legacy = mergeSettings({ targetLang: 'ja', engineConfig: { baseUrl: 'https://a.example/v1', model: '我的模型' } });
    expect(legacy.providerPreset).toBe('custom');
    // 补齐预设字段不能顺手改写已有字段。
    expect(legacy.targetLang).toBe('ja');
    expect(legacy.engineConfig).toEqual({ apiKey: '', baseUrl: 'https://a.example/v1', model: '我的模型' });
  });

  it('合法值原样保留；未知/脏值回落 custom（而不是崩或写进脏值）', () => {
    for (const id of ['custom', 'openai', 'deepseek', 'ollama']) {
      expect(mergeSettings({ providerPreset: id }).providerPreset).toBe(id);
    }
    expect(mergeSettings({ providerPreset: 'claude' }).providerPreset).toBe('custom');
    expect(mergeSettings({ providerPreset: 42 }).providerPreset).toBe('custom');
    expect(mergeSettings({ providerPreset: null }).providerPreset).toBe('custom');
  });

  it('loadSettings 读老存储（没有该字段）后能原样往返保存', async () => {
    const area = new MemoryStorage();
    await area.set({ [SETTINGS_KEY]: { version: 2, targetLang: 'ja' } });
    const loaded = await loadSettings(area);
    expect(loaded.providerPreset).toBe('custom');
    await saveSettings(loaded, area);
    expect((await loadSettings(area)).providerPreset).toBe('custom');
  });

  it('预填值逐字钉住：OpenAI / DeepSeek / Ollama 的地址与模型名（不确定的服务商不放）', () => {
    const byId = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));
    expect([...byId.keys()]).toEqual(['custom', 'openai', 'deepseek', 'ollama']);
    expect(byId.get('openai')).toMatchObject({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
    expect(byId.get('deepseek')).toMatchObject({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
    expect(byId.get('ollama')).toMatchObject({ baseUrl: 'http://localhost:11434/v1', model: 'llama3' });
    // 自定义：不预填，保持现状。
    expect(byId.get('custom')?.baseUrl).toBeUndefined();
    expect(byId.get('custom')?.model).toBeUndefined();
  });

  it('每个预填地址都能通过存储层的 BaseURL 校验（填进去不会反被归一化吞掉）', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.baseUrl !== undefined) expect(isAllowedBaseUrl(preset.baseUrl)).toBe(true);
    }
  });
});
