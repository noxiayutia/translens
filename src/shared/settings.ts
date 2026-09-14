// src/shared/settings.ts
import type { StorageArea } from '../core/cache';
import type { Term } from '../engines/types';
import { chromeArea } from './chrome-area';

export interface SiteRule {
  pattern: string;
  action: 'translate' | 'never';
}

export interface EngineConfigSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface Settings {
  version: number;
  engineId: string;
  engineConfig: EngineConfigSettings;
  targetLang: string;
  sourceLang: string;
  displayMode: 'bilingual' | 'replace';
  hoverTranslate: boolean;
  selectionTranslate: boolean;
  autoTranslateDelay: number;
  concurrency: number;
  maxBatchChars: number;
  maxSegmentsPerBatch: number;
  cacheMaxEntries: number;
  siteRules: SiteRule[];
  glossary: Term[];
  systemPrompt: string;
}

export const SETTINGS_KEY = 'jinyi:settings';

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  engineId: 'google',
  engineConfig: { apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  targetLang: 'zh-Hans',
  sourceLang: 'auto',
  displayMode: 'bilingual',
  hoverTranslate: true,
  selectionTranslate: true,
  autoTranslateDelay: 0,
  concurrency: 3,
  maxBatchChars: 1000,
  maxSegmentsPerBatch: 12,
  cacheMaxEntries: 5000,
  siteRules: [],
  glossary: [],
  systemPrompt: '',
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickSiteRules(value: unknown): SiteRule[] {
  if (!Array.isArray(value)) return [];
  const out: SiteRule[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const rule = raw as Partial<SiteRule>;
    if (typeof rule.pattern !== 'string' || rule.pattern.length === 0) continue;
    if (rule.action !== 'translate' && rule.action !== 'never') continue;
    out.push({ pattern: rule.pattern, action: rule.action });
  }
  return out;
}

function pickGlossary(value: unknown): Term[] {
  if (!Array.isArray(value)) return [];
  const out: Term[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const term = raw as Partial<Term>;
    if (typeof term.from !== 'string' || typeof term.to !== 'string') continue;
    if (term.from.length === 0) continue;
    out.push({ from: term.from, to: term.to });
  }
  return out;
}

function pickEngineConfig(value: unknown): EngineConfigSettings {
  const raw = (value ?? {}) as Partial<EngineConfigSettings>;
  return {
    apiKey: pickString(raw.apiKey, DEFAULT_SETTINGS.engineConfig.apiKey),
    baseUrl: pickString(raw.baseUrl, DEFAULT_SETTINGS.engineConfig.baseUrl),
    model: pickString(raw.model, DEFAULT_SETTINGS.engineConfig.model),
  };
}

/**
 * 把任意来源的对象合并成完整设置。
 * 逐字段校验而不是整体替换，这样新版字段可以在老数据上补齐，
 * 单个字段损坏也不会让整个设置页崩掉。
 */
export function mergeSettings(raw: unknown): Settings {
  const input = (raw ?? {}) as Partial<Settings>;
  return {
    version: DEFAULT_SETTINGS.version,
    engineId: pickString(input.engineId, DEFAULT_SETTINGS.engineId),
    engineConfig: pickEngineConfig(input.engineConfig),
    targetLang: pickString(input.targetLang, DEFAULT_SETTINGS.targetLang),
    sourceLang: pickString(input.sourceLang, DEFAULT_SETTINGS.sourceLang),
    displayMode: input.displayMode === 'replace' ? 'replace' : 'bilingual',
    hoverTranslate: pickBoolean(input.hoverTranslate, DEFAULT_SETTINGS.hoverTranslate),
    selectionTranslate: pickBoolean(input.selectionTranslate, DEFAULT_SETTINGS.selectionTranslate),
    autoTranslateDelay: clampInt(input.autoTranslateDelay, DEFAULT_SETTINGS.autoTranslateDelay, 0, 60),
    concurrency: clampInt(input.concurrency, DEFAULT_SETTINGS.concurrency, 1, 8),
    maxBatchChars: clampInt(input.maxBatchChars, DEFAULT_SETTINGS.maxBatchChars, 200, 8000),
    maxSegmentsPerBatch: clampInt(input.maxSegmentsPerBatch, DEFAULT_SETTINGS.maxSegmentsPerBatch, 1, 50),
    cacheMaxEntries: clampInt(input.cacheMaxEntries, DEFAULT_SETTINGS.cacheMaxEntries, 100, 50000),
    siteRules: pickSiteRules(input.siteRules),
    glossary: pickGlossary(input.glossary),
    systemPrompt: pickString(input.systemPrompt, DEFAULT_SETTINGS.systemPrompt),
  };
}

let sharedArea: StorageArea | null = null;

function resolveArea(area?: StorageArea): StorageArea {
  if (area) return area;
  if (!sharedArea) sharedArea = chromeArea(chrome.storage.local);
  return sharedArea;
}

export async function loadSettings(area?: StorageArea): Promise<Settings> {
  const target = resolveArea(area);
  const raw = await target.get([SETTINGS_KEY]);
  return mergeSettings(raw[SETTINGS_KEY]);
}

export async function saveSettings(settings: Settings, area?: StorageArea): Promise<void> {
  const target = resolveArea(area);
  await target.set({ [SETTINGS_KEY]: mergeSettings(settings) });
}
