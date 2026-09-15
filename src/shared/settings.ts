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

/**
 * 译文显示方式。
 *
 * - `translated-only`（默认）：**只显示译文**。原文并没有被删掉——它被包进一个
 *   `display:none` 的 `<span data-jy-originals>` 留在 DOM 里，还原就是把子节点搬回去
 *   （见 `content/renderer.ts`）。用户要的就是这个：双语对照会让译文和原文互相挤占版面。
 * - `bilingual`：原文照旧，译文插在它下面。
 *
 * 这里曾经还有第三种 `'replace'`（就地写 `textContent` 覆盖原文）。它已随
 * {@link mergeSettings} 的迁移改成 `translated-only`：旧实现遇到含行内标记的段落会
 * 静默退回双语，真实长文（维基百科几乎每段都有链接）实际表现就是"大部分段落仍是双语"，
 * 与「只显示译文」正好相反。
 */
export type DisplayMode = 'bilingual' | 'translated-only';

/**
 * 显示模式的界面选项（弹窗与设置页**共用这一份**）。
 *
 * 与 `core/lang.ts` 的 LANGUAGES 同一个道理：两处各写一份时，同一个设置在两个界面上会
 * 给出不同的说法（"仅译文" / "只要译文"），用户会以为它们不是同一个东西。
 * 数组顺序就是界面顺序：默认的「仅译文」在最前——它是用户最可能想改的一项。
 */
export const DISPLAY_MODES: ReadonlyArray<{ value: DisplayMode; label: string }> = [
  { value: 'translated-only', label: '仅译文' },
  { value: 'bilingual', label: '双语对照' },
];

export interface Settings {
  version: number;
  engineId: string;
  engineConfig: EngineConfigSettings;
  targetLang: string;
  sourceLang: string;
  displayMode: DisplayMode;
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
export const CURRENT_VERSION = 2;

export const DEFAULT_SETTINGS: Settings = {
  version: CURRENT_VERSION,
  engineId: 'google',
  engineConfig: { apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  targetLang: 'zh-Hans',
  sourceLang: 'auto',
  displayMode: 'translated-only',
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

/**
 * 认不出来的值回落到哪个模式。
 *
 * 单独拎成一个常量而不是直接写 `DEFAULT_SETTINGS.displayMode`，是为了让「兜底」与
 * 「`'replace'` 的迁移目标」成为两个可以分别演进的概念：默认值将来若改成双语，
 * `'replace'` 仍然应该映射成"只要译文"。
 *
 * **现状要如实说明**：今天两者恰好都是 `translated-only`，所以把 `pickDisplayMode` 里的
 * 迁移分支删掉，全部测试依然通过——兜底补上了同一个结果。也就是说那条迁移目前
 * **没有测试守得住**，它只在默认值改变之后才成为承重代码。变异测试证实过这一点
 * （删掉 `|| value === 'replace'`，426 个用例全绿）。不要以为有测试保护它。
 */
const FALLBACK_DISPLAY_MODE: DisplayMode = 'translated-only';

/**
 * 显示模式的读取与**迁移**。
 *
 * 存储里已有的 `'replace'`（v1 时代的"整页替换"）必须映射成 `translated-only`：
 * 老用户升级后不能被当成"值不认识"而回落——回落的结果是显示模式悄悄变回双语，
 * 而那正是用户当初特意改掉的默认行为。
 *
 * 迁移目标与兜底都写死成 `translated-only` 而不是"当前的默认值"：默认值以后再变一次时，
 * `'replace'` 的语义仍然是"只要译文"，不该跟着新默认值漂走。
 */
function pickDisplayMode(value: unknown): DisplayMode {
  if (value === 'bilingual') return 'bilingual';
  if (value === 'translated-only' || value === 'replace') return 'translated-only';
  return FALLBACK_DISPLAY_MODE;
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
    displayMode: pickDisplayMode(input.displayMode),
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
 * 这里也是**迁移入口**（规格 §7.3），具体步骤见 `migrate`。
 */
/**
 * 按**存储里的真实版本号**迁移老数据。新增一版就在这里加一步。
 *
 * **v1 → v2：`displayMode` 的 `'bilingual'` 迁到 `'translated-only'`。**
 * v1 时代设置页与弹窗都**没有**改显示模式的界面（那个开关是 v2 才加的），所以存储里的
 * `displayMode` 一定是当时的默认值被 `saveSettings` 整份覆盖时**冻结**下来的——用户只要
 * 配过一次引擎或改过目标语言，就会把它一起写进去——不可能是用户的选择。
 * 不迁的话，所有配过引擎的老用户升级后仍然看到双语，而他们从来没选过双语
 * （实测就是这么发生的：用户配完 DeepSeek 后升级，页面还是双语）。
 *
 * 只动 `'bilingual'`：`'replace'` 交给 `pickDisplayMode` 映射，其余脏值交给它兜底。
 * v2 及以后存储里的 `'bilingual'` 是用户真的在界面上选过的，**不能动**。
 */
function migrate(raw: unknown, storedVersion: number): unknown {
  if (storedVersion >= 2) return raw;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (record.displayMode !== 'bilingual') return raw;
  return { ...record, displayMode: 'translated-only' };
}

/**
 * 读出扩展设置。**这是迁移入口**（规格 §7.3）：版本号必须从存储里真实读出来，
 * 否则无从判断该按哪一版语义解释老数据。
 *
 * 读到**比本代码更新**的版本号说明用户装过新版扩展后又回退了，此时按旧语义解释新数据
 * 会得出错误结果，因此明确拒绝，而不是静默降级。
 */
export async function loadSettings(area?: StorageArea): Promise<Settings> {
  const target = resolveArea(area);
  const raw = await target.get([SETTINGS_KEY]);
  const stored = raw[SETTINGS_KEY];
  const storedVersion = readStoredVersion(stored);
  if (storedVersion > CURRENT_VERSION) {
    throw new Error(`设置版本 ${storedVersion} 高于当前支持的 ${CURRENT_VERSION}，请更新扩展`);
  }
  return mergeSettings(migrate(stored, storedVersion), CURRENT_VERSION);
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
