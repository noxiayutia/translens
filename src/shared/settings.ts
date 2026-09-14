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

/** 当前设置 schema 版本；改动字段语义时递增。 */
export const CURRENT_VERSION = 1;

export const DEFAULT_SETTINGS: Settings = {
  version: CURRENT_VERSION,
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

/** 允许 http 的本机主机名（用户的本地推理服务，如 Ollama）。 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * 接口地址是否合法：只接受 https（本机回环地址放行 http，Ollama 等本地服务默认就是 http）。
 *
 * 导出是给**设置页**用的：它必须在保存按钮里给出与这里**同一套判据**的提示，否则会出现
 * 「设置页说保存成功、存储层把地址悄悄退回默认值」这种用户永远查不出来的分歧。
 */
export function isAllowedBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
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
    baseUrl: pickBaseUrl(raw.baseUrl),
    model: pickString(raw.model, DEFAULT_SETTINGS.engineConfig.model),
  };
}

/**
 * BaseURL 决定 `Authorization: Bearer <apiKey>` 发往哪里，是这个凭据的唯一下游，
 * 所以它是反序列化边界上必须校验的字段而不是一个可自由填写的字符串：
 * 只接受 https（本机回环地址放行 http，Ollama 等本地服务默认就是 http）。
 * 非法值不抛错，退回默认值——这样错误输入永远不会变成"把 Key 发到别处"。
 */
function pickBaseUrl(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.engineConfig.baseUrl;
  const trimmed = value.trim();
  if (!isAllowedBaseUrl(trimmed)) return DEFAULT_SETTINGS.engineConfig.baseUrl;
  return trimmed;
}

/**
 * 把任意来源的对象合并成完整设置。
 * 逐字段校验而不是整体替换，这样新版字段可以在老数据上补齐，
 * 单个字段损坏也不会让整个设置页崩掉。
 *
 * `version` 是**声明值**而不是校验结果：调用方决定它是多少（见 `saveSettings` 的
 * 防降级与 `loadSettings` 的版本闸门），这里只负责拒绝非正整数。
 */
export function mergeSettings(raw: unknown, version: unknown = undefined): Settings {
  const input = (raw ?? {}) as Partial<Settings>;
  return {
    version: pickVersion(version ?? input.version),
    engineId: pickString(input.engineId, DEFAULT_SETTINGS.engineId),
    engineConfig: pickEngineConfig(input.engineConfig),
    targetLang: pickString(input.targetLang, DEFAULT_SETTINGS.targetLang),
    sourceLang: pickString(input.sourceLang, DEFAULT_SETTINGS.sourceLang),
    displayMode: input.displayMode === 'replace' ? 'replace' : DEFAULT_SETTINGS.displayMode,
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

/** 版本号必须能原样读回，否则无从判断来源版本；非正整数一律按当前版本处理。 */
function pickVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return CURRENT_VERSION;
  return value;
}

/** 读出存储里声明的版本号（缺失或非法即"当作当前版本"）。 */
function readStoredVersion(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return CURRENT_VERSION;
  return pickVersion((raw as Partial<Settings>).version);
}

let sharedArea: StorageArea | null = null;

function resolveArea(area?: StorageArea): StorageArea {
  if (area) return area;
  if (typeof chrome === 'undefined') {
    throw new Error('当前运行环境没有扩展存储，调用时必须显式传入 StorageArea');
  }
  if (!sharedArea) sharedArea = chromeArea(chrome.storage.local);
  return sharedArea;
}

/**
 * 读取完整设置（**含 API Key**）。
 *
 * 调用方是**扩展自身的受信页面与后台**：service worker、设置页、弹窗——三者同源
 * （`chrome-extension://`），谁也拿不到对方拿不到的东西，所以弹窗读完整设置不是越权。
 * 真正需要结构上隔离的是**内容脚本**：它跑在网页的进程里，一律用 `loadUiSettings()`，
 * 那个类型里根本没有 `apiKey` 字段。密钥不得进入日志、消息与导出的 JSON（规格 §7.3）。
 *
 * 这里也是**迁移入口**（规格 §7.3）：版本号必须从存储里真实读出来，否则将来
 * 无从判断该按哪一版语义解释老数据。当前只有 v1，所以 v1 数据只需逐字段补齐；
 * v0 之类的历史版本号今天不可能出现；读到**比本代码更新**的版本号说明用户装过
 * 新版扩展后又回退了，此时按 v1 语义解释 v2 数据会得出错误结果，因此明确拒绝，
 * 而不是静默降级。将来新增 v2 时，在这个分支里按 `storedVersion` 补迁移步骤。
 */
export async function loadSettings(area?: StorageArea): Promise<Settings> {
  const target = resolveArea(area);
  const raw = await target.get([SETTINGS_KEY]);
  const stored = raw[SETTINGS_KEY];
  const storedVersion = readStoredVersion(stored);
  if (storedVersion > CURRENT_VERSION) {
    throw new Error(`设置版本 ${storedVersion} 高于当前支持的 ${CURRENT_VERSION}，请更新扩展`);
  }
  return mergeSettings(stored, CURRENT_VERSION);
}

/** 不带 API Key 的设置投影，供**内容脚本**使用（它跑在网页进程里）。 */
export type UiEngineConfig = Omit<EngineConfigSettings, 'apiKey'>;

export type UiSettings = Omit<Settings, 'engineConfig'> & { engineConfig: UiEngineConfig };

export async function loadUiSettings(area?: StorageArea): Promise<UiSettings> {
  const { engineConfig, ...rest } = await loadSettings(area);
  return { ...rest, engineConfig: { baseUrl: engineConfig.baseUrl, model: engineConfig.model } };
}

/**
 * 保存前先归一化（`mergeSettings`），UI 不可能把脏数据写进存储。
 * 存储里的版本号高于本代码时拒绝写入：继续写就等于用旧 schema 覆盖新数据
 * （弹窗每次改动开关都会保存一次），会把新版字段悄悄丢掉。
 *
 * 注意这是**整份覆盖**：调用方必须持有完整设置（弹窗就是 `loadSettings` 读来的那一份，
 * 它只改 targetLang / engineId，其余字段原样写回）。因此设置页实装后**不能**和弹窗
 * 各持一份快照同时写——两边各自读一次、各改一个字段，后写的那次会把对方刚改的字段
 * 抹回自己的旧值。到那时这里要加一个存储侧的局部写入 API（只写指定字段），
 * 而不是让两个页面继续整份回写。今天设置页还是占位实现（src/options/options.ts），
 * 弹窗是唯一的写入方，所以这条约束尚未被触发。
 */
export async function saveSettings(settings: Settings, area?: StorageArea): Promise<void> {
  const target = resolveArea(area);
  const stored = await target.get([SETTINGS_KEY]);
  const storedVersion = readStoredVersion(stored[SETTINGS_KEY]);
  if (storedVersion > CURRENT_VERSION) {
    throw new Error(`存储中的设置版本 ${storedVersion} 高于当前支持的 ${CURRENT_VERSION}，已跳过保存`);
  }
  await target.set({ [SETTINGS_KEY]: mergeSettings(settings, CURRENT_VERSION) });
}
