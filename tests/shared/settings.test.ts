import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, mergeSettings, saveSettings } from '../../src/shared/settings';
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
});
