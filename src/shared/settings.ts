// src/shared/settings.ts
import type { StorageArea } from '../core/cache';
import { getEngine, OPENAI_COMPAT_ENGINE_ID } from '../engines/registry';
import type { EngineConfig, Term, Translator } from '../engines/types';
import { chromeArea } from './chrome-area';

export interface SiteRule {
  pattern: string;
  action: 'translate' | 'never';
}

/**
 * 一份服务商档案 = 一个「OpenAI 兼容」接口的完整凭据（地址 + **模型清单** + Key）加一个用户自己起的名字。
 *
 * 动机：设置里今天只有一份 `{apiKey, baseUrl, model}`，想同时用 DeepSeek、OpenAI、硅基流动、
 * Ollama 的人只能在三个框里来回改。改成档案列表后，弹窗的「翻译引擎」下拉直接按名字切换。
 *
 * v4 起 `model: string` 变成 `models: string[]` + `activeModel: string`：同一家接口的两个模型
 * 过去只能复制成两份档案（用户现在的档案里就有这种重复）。
 *
 * `id` 是档案的**唯一引用键**（`engineId` 存的就是它）：新建时生成（{@link createProfileId}），
 * 之后不变。**不要拿 label 当 id**——名字是随便改的，改了名字不该把正在用的选择弄丢。
 *
 * `activeModel` 是**用户/界面明确选定**的那一个（不是"默认"）：它必须是 `models` 的成员或 `''`，
 * 见 {@link pickProfile} 的读取边界。`''` = 还没选——此时翻译要给可读错误、**零请求**，
 * 绝不允许读取层替用户挑一个（那等于"用户没选，插件选了，下一次翻译就用了它"）。
 */
export interface EngineProfile {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  activeModel: string;
  apiKey: string;
}

/**
 * 新建档案的 id：稳定、唯一、与 label 无关。
 * 优先用平台的 UUID；拿不到（非安全上下文等）时退到「时间戳 + 随机串」——仍然不需要 label 参与。
 */
export function createProfileId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (typeof randomUuid === 'string') return `p-${randomUuid}`;
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 服务商预设的 id。`custom` = 不预填，用户自己填什么是什么。 */
export type ProviderPresetId = 'custom' | 'openai' | 'deepseek' | 'ollama';

/**
 * 服务商预设：档案编辑表单里「从服务商模板创建」的选项——选中即**预填**接口地址与模型名。
 *
 * 动机是真实踩过的坑：用户在模型名里填 `deepseek`（正确值是 `deepseek-chat`），
 * 拿到一个界面上看不出原因的 HTTP 400。这类错误完全可以用一次下拉选择消除。
 * 只放**确定无疑**的三家（OpenAI / DeepSeek / Ollama 本机默认端口）——
 * 拿不准的服务商宁可不放，也不预填一个错的模型名。
 *
 * 预设只是**填写捷径**，不是锁定：选完之后接口地址与模型名照常手改，
 * 改完即视为自定义（编辑表单负责把下拉翻回 `custom`，预设永远不许覆盖用户敲进去的值）。
 *
 * **v3 起它不再是一个设置字段**：曾经每份设置只有一个 `providerPreset`，而现在每个档案
 * 各自编辑，记一个全局的"上次选了哪家"既没有消费者、又必然与档案内容漂移。
 * 今天唯一还读它的地方是 v2 → v3 迁移（用它推导老档案的中文名）。
 */
export interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  /** 预填的接口地址；`custom` 没有（undefined = 不动任何字段）。 */
  baseUrl?: string;
  /** 预填的模型名；`custom` 没有。 */
  model?: string;
}

export const PROVIDER_PRESETS: ReadonlyArray<ProviderPreset> = [
  { id: 'custom', label: '自定义' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'ollama', label: 'Ollama（本机）', baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
];

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
  /**
   * 当前用的引擎：**某个档案的 `id`**，或 `''`（= **没有可用引擎**）。
   *
   * 「档案 → 用哪个引擎 + 哪份配置」的解析只有一处：{@link resolveEngine}。
   * 调用方（service worker、弹窗、设置页）一律走它，不许各自写一份 if。
   *
   * v5 起 `'google'` 不再是合法取值（免费接口已整体删除）：任何不指向现存档案的值
   * ——残留的 `'google'`、`'openai-compat'` 这类裸引擎 id、被别处删掉的档案 id——
   * 都表现为「没有可用引擎 + 一句可行动的话 + 零网络请求」，**不再回落到任何引擎**。
   */
  engineId: string;
  /** 服务商档案列表。曾经这里是一份匿名的 `engineConfig`，v2 → v3 迁移见 `migrate`。 */
  profiles: EngineProfile[];
  targetLang: string;
  sourceLang: string;
  displayMode: DisplayMode;
  hoverTranslate: boolean;
  selectionTranslate: boolean;
  /**
   * ⚠ **这个字段目前没有任何消费者**：只有类型声明、默认值与 `mergeSettings` 的夹取，
   * 全仓没有任何代码读它来触发自动翻译——自动翻译功能本身尚未实现（属下一阶段）。
   * 在存储里把它设成多少都**不会有任何效果**，别以为改这里就能调延时。
   * 接功能时记得同时补界面（README 已按"无界面、无行为"如实描述）。
   */
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

/**
 * 当前设置 schema 版本；改动字段语义时递增。
 *
 * v4：`EngineProfile.model` → `models` + `activeModel`。
 * v5：删掉 Google 免费接口——`engineId: 'google'` 迁到第一个有 `activeModel` 的档案
 *     （一个都没有就置 `''`，见 {@link dropFreeEngineSelection}）。
 */
export const CURRENT_VERSION = 5;

/**
 * v2 → v3 迁移产物固定用这个 id（老 `engineId === 'openai-compat'` 也迁到它）。
 * 常量导出：测试与「删除档案后 engineId 回落」之类的判断都引用它，不各写字面量。
 */
export const LEGACY_PROFILE_ID = 'legacy';

/** 没有名字的档案在界面上叫什么。迁移与反序列化共用，避免两处各写一份漂移。 */
const FALLBACK_PROFILE_LABEL = '我的接口';

export const DEFAULT_SETTINGS: Settings = {
  version: CURRENT_VERSION,
  // `''` 的语义是**没有可用引擎**，不再是"某个引擎的 id"。首装因此就是
  // `profiles: []` + `engineId: ''`：弹窗与设置页各自显示那句可行动的话（§6.1）。
  // `mergeSettings` 的 `pickString(input.engineId, DEFAULT_SETTINGS.engineId)` 因此在
  // 字段缺失时天然落到 `''`——缺字段与显式空串**同义**，这正是我们要的。
  engineId: '',
  profiles: [],
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
 * 档案列表的每个 `baseUrl` 也逐条走这同一个判据，不再写第二份。
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

/**
 * 模型清单的读取：只收非空字符串、逐条 trim、按首次出现去重。
 *
 * **不截断**（没有条数上限）：有些网关的 `/models` 列几百个，截断等于替用户丢掉他的模型。
 * 代价是清单可能很长——那是界面的事（可滚动），不是存储边界的事。
 */
function pickModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (name.length === 0 || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/**
 * 单个档案的读取：逐字段校验，坏条目丢掉而不是让整页崩掉（`pickSiteRules` 的老规矩）。
 *
 * - 没有合法 `id` 的条目**必须**丢：`engineId` 按 id 引用档案，没有 id 的档案无法被指向，
 *   留在列表里只会成为一个永远选不中的幽灵条目。
 * - `baseUrl` 非法（脏存储、被绕过的 UI）归一化成**空串**而不是某个默认端点：
 *   档案的 apiKey 就存在同一条目里，"退回默认地址"等于把用户的 Key 发给另一家服务商。
 *   空地址让引擎在翻译时明确报「尚未填写接口地址」，不发任何请求。
 *   （v2 时代单份配置的"非法退回默认值"策略在档案列表下不再成立：那时地址与 Key 的
 *   对应关系只有一份，现在每份 Key 都属于它自己那条地址。）
 * - label 空白按缺失处理，界面上才不会出现一排选不出名字的条目。
 * - **`activeModel` 认不出来（不是 `models` 的成员 / 空 / 缺失 / 非字符串）时置 `''`**：
 *   §3.1 的"取 `models` 最后一个"是**删除动作**的自愈（用户刚删掉当前模型，他显然还想用这个
 *   档案）；读取边界不同——这里替用户挑一个，就是"他没选，插件选了"。这条不变量（
 *   `activeModel === '' || models.includes(activeModel)`）因此在任何数据形状下都成立。
 * - 旧字段 `model` **不再读**：真相只留一份（先例是 `engineConfig` / `providerPreset`）。
 */
function pickProfile(value: unknown): EngineProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<EngineProfile>;
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) return null;
  const label = pickString(raw.label, '');
  let baseUrl = '';
  if (typeof raw.baseUrl === 'string') {
    const trimmed = raw.baseUrl.trim();
    if (isAllowedBaseUrl(trimmed)) baseUrl = trimmed;
  }
  const models = pickModels(raw.models);
  const wanted = pickString(raw.activeModel, '').trim();
  return {
    id: raw.id,
    label: label.trim().length > 0 ? label : FALLBACK_PROFILE_LABEL,
    baseUrl,
    models,
    activeModel: models.includes(wanted) ? wanted : '',
    apiKey: pickString(raw.apiKey, ''),
  };
}

/** 档案列表的读取：非数组当没有；重复 id 只留第一个（engineId 只能有一个指代对象）。 */
function pickProfiles(value: unknown): EngineProfile[] {
  if (!Array.isArray(value)) return [];
  const out: EngineProfile[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const profile = pickProfile(raw);
    if (profile === null || seen.has(profile.id)) continue;
    seen.add(profile.id);
    out.push(profile);
  }
  return out;
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
    profiles: pickProfiles(input.profiles),
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

/**
 * {@link resolveEngine} 的解析结果：引擎 + 送给它的那份配置 + **能不能用**的一句原因。
 */
export interface ResolvedEngine {
  /** `null` = 没有可用引擎（`engineId` 不指向任何现存档案）。此时 `problem` 必定有值。 */
  engine: Translator | null;
  config: EngineConfig;
  /**
   * 这个档案**今天不能用来翻译**时的一句可读原因；能用时为 `undefined`。
   *
   * 为什么是返回值而不是抛错：弹窗在**同步渲染函数**里调它（`renderEngineHint`），抛错会把
   * 提示区变成异常路径。消费者只有两个：service worker（发请求前拦下）与弹窗（提示区）。
   *
   * **零请求不由这里保证**：`openai-compat` 的空 model 闸在 `fetch` 之前就已经拦住了
   * （构造性成立）。这里负责给出规格 §3.3 那句**可行动**的话——引擎给不出它，因为引擎是
   * 通用的 OpenAI 兼容适配器，它不知道"档案""模型清单"这些词。
   */
  problem?: string;
}

/**
 * §3.3 那句话的**唯一来源**：后台与弹窗都读它（两处各写一份必然漂移，先例见 `isAllowedBaseUrl`）。
 * 规格里它是「这个档案还没有模型，点『添加模型』或『拉取可用模型』」——外层引号属于规格的排版，
 * 落到代码里内层标签统一用本仓的「」（界面文案引用标签一律如此）。
 */
export const NO_MODEL_PROBLEM = '这个档案还没有模型，点「添加模型」或「拉取可用模型」';

/**
 * 「没有可用引擎」那句话的**唯一来源**（与 {@link NO_MODEL_PROBLEM} 同级）。
 *
 * 弹窗、设置页、后台各写一份必然漂移（先例见 `isAllowedBaseUrl`）。首装时两处的措辞差异是
 * **刻意的**：设置页那句就是"去做这件事"，弹窗那句多一个"去哪做"（弹窗里没有「新增档案」
 * 按钮，只有右上角的齿轮）。**两处的核心句逐字相同**——都由本常量拼出来，不各写一份字面量。
 */
export const NO_ENGINE_PROBLEM = '还没有可用的翻译引擎，去设置页添加一个服务商档案';

/**
 * 第一个「有当前模型」的档案的 id；一个都没有时返回 `''`（= 没有可用引擎）。
 *
 * **两个调用方共用这一份判据**：v4 → v5 迁移（`dropFreeEngineSelection`）与设置页删除当前档案时
 * 的回落。两处各写一份必然漂移，先例就是 `resolveEngine` 里那条专门解释为什么用 `trim()` 的注释。
 *
 * 参数类型是 `Pick<EngineProfile, 'id' | 'activeModel'>` 而不是整个 `EngineProfile`：迁移那一侧
 * 拿到的是**存储里的生数据**（`mergeSettings` 还没跑，`profiles` 是 `unknown`），它只需要先证明
 * "`id` 是字符串、`activeModel` 是字符串"就能问这条判据——**判据本身仍然只有这一份**。
 *
 * `trim()` 口径与 {@link resolveEngine} 完全一致：只填了空格的 `activeModel` 算"没有当前模型"。
 * 顺序 = 数组顺序（`pickProfiles` 保证它是存储顺序），也就是用户在设置页看到的第一行。
 */
export function firstUsableProfileId(
  profiles: readonly Pick<EngineProfile, 'id' | 'activeModel'>[],
): string {
  return profiles.find((profile) => profile.activeModel.trim().length > 0)?.id ?? '';
}

/**
 * 「engineId → 用哪个引擎 + 用哪份配置」的**唯一一处**解析。
 *
 * service worker、弹窗、设置页全走它。**不许**在别处再写一个 `if (settings.engineId === '')`
 * ——那就是第二个解析点，下次加引擎一定有一处漏掉。
 *
 * 解析规则只有三条：
 * 1. `engineId` 命中某个档案 → OpenAI 兼容引擎 + **那份**档案的 `{apiKey, baseUrl, model}`；
 *    `activeModel` 是空串（或只有空白）时**额外**给出 `problem`（{@link NO_MODEL_PROBLEM}）。
 *    空模型这件事只有这里能说清：引擎是通用适配器，它不知道"档案""模型清单"这些词，
 *    只会说一句用户照着找不到去哪儿的「尚未填写模型名」。
 * 2. `engineId` **不命中任何档案** → `{ engine: null, config: {}, problem: NO_ENGINE_PROBLEM }`。
 *    **这是「没有可用引擎」的唯一产出点。** `''`、残留的 `'google'`、`'openai-compat'` 这类
 *    裸引擎 id、被别处删掉的档案 id，走的都是这一条——**没有"兜底到某个别的引擎"这回事**，
 *    也不写「若 engineId === 'google' 则…」的补丁（它只是"一个不存在的 id"）。
 * 3. 其余（命中档案且模型齐全）→ 无 `problem`。
 *
 * 命中档案那一支交出来的 `engine` **类型上仍可能是 `null`**（`getEngine` 的返回类型如此）：
 * 三个调用点因此都要显式收口。这不是噪音，它是"没有可用引擎成为一等状态"之后必须付的账
 * ——`service-worker.ts` 用 `engine === null || problem !== undefined` 一次收住两件事。
 */
export function resolveEngine(settings: Pick<Settings, 'engineId' | 'profiles'>): ResolvedEngine {
  const profile = settings.profiles.find((item) => item.id === settings.engineId);
  if (profile === undefined) return { engine: null, config: {}, problem: NO_ENGINE_PROBLEM };
  const engine = getEngine(OPENAI_COMPAT_ENGINE_ID);
  const config: EngineConfig = { apiKey: profile.apiKey, baseUrl: profile.baseUrl, model: profile.activeModel };
  // 判空口径与引擎实现**一致**：只有空白字符也算"没填"（`openai-compat` 取 `config.model` 时
  // 先 `.trim()`）。写成 `activeModel.length === 0` 会漏过"只填了空格"这一格——档案被判成能用，
  // 用户却在发请求时拿到引擎那句通用的「尚未填写模型名」，白跑一趟。
  if (profile.activeModel.trim().length === 0) return { engine, config, problem: NO_MODEL_PROBLEM };
  return { engine, config };
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
 * 读出完整设置（**含每个档案的 API Key**）。
 *
 * 调用方是**扩展自身的受信页面与后台**：service worker、设置页、弹窗——三者同源
 * （`chrome-extension://`），谁也拿不到对方拿不到的东西，所以弹窗读完整设置不是越权。
 * 真正需要把密钥隔离开的是**内容脚本**：它跑在网页的进程里，一律用 `loadUiSettings()`，
 * 那个类型里档案列表**每一项**都没有 `apiKey` 字段——注意这是**类型级**投影（下游拿不到
 * 字段），不是内存级隔离（实现上仍经由本函数读出整份设置，见 `loadUiSettings` 的注释）。
 * 密钥不得进入日志、消息与导出的 JSON（规格 §7.3）。
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
 * 只动 `'bilingual'`：`'replace'` 交给 `pickDisplayMode` 映射，其余脏值交给它兜底。
 * v2 及以后存储里的 `'bilingual'` 是用户真的在界面上选过的，**不能动**。
 *
 * **v2 → v3：单份 `engineConfig` 折成一个档案。**见 `foldLegacyEngineConfig`。
 *
 * **v3 → v4：每个档案的单 `model` 抬起成 `models` + `activeModel`。**见 `liftProfileModels`。
 *
 * **v4 → v5：`engineId: 'google'` 改指向第一个有 `activeModel` 的档案。**见 `dropFreeEngineSelection`。
 *
 * 迁移按 `storedVersion` 分支、**只在 `loadSettings` 里发生**：v5 数据从版本闸门
 * （`storedVersion >= CURRENT_VERSION`）直接原样返回，不会被重复抬起——幂等性靠的就是
 * 这一道闸门加上"每一步只在它自己那一版及更老的形状上发生"。
 */
function migrate(raw: unknown, storedVersion: number): unknown {
  if (storedVersion >= CURRENT_VERSION) return raw;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  let record = raw as Record<string, unknown>;
  if (storedVersion < 2 && record.displayMode === 'bilingual') {
    record = { ...record, displayMode: 'translated-only' };
  }
  if (storedVersion < 3) {
    record = foldLegacyEngineConfig(record);
  }
  if (storedVersion < 4) {
    record = liftProfileModels(record);
  }
  // 排在 `liftProfileModels` **之后**：`activeModel` 是它抬出来的（v1/v2/v3 的数据在这一步
  // 之前还没有这个字段）。
  if (storedVersion < 5) {
    record = dropFreeEngineSelection(record);
  }
  return record;
}

/**
 * v3 → v4 的抬起：每个档案的单 `model` 变成 `models: [model]` + `activeModel: model`；
 * 空 / 缺失 → `models: []` + `activeModel: ''`。
 *
 * 两条刻意的做法：
 * 1. **旧字段 `model` 从产物里删掉**（与 `foldLegacyEngineConfig` 删 `engineConfig` /
 *    `providerPreset` 同一条纪律）：`mergeSettings` 本来也不读它，但存储里留着会让"下次迁移"
 *    的判据变含糊，而 `saveSettings` 是整份覆盖写——残留字段会被一直带着走。
 * 2. **v2 数据也走这里**：`foldLegacyEngineConfig` 产出的档案带的是 `model`，所以 v1/v2/v3 三条
 *    路径都在这一步收敛到同一形状（v1/v2 先折叠、再抬起，顺序由 `migrate` 保证）。
 */
function liftProfileModels(record: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(record.profiles)) return record;
  return {
    ...record,
    profiles: record.profiles.map((raw) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
      const lifted = { ...(raw as Record<string, unknown>) };
      const model = typeof lifted.model === 'string' ? lifted.model.trim() : '';
      delete lifted.model;
      return { ...lifted, models: model.length > 0 ? [model] : [], activeModel: model };
    }),
  };
}

/**
 * v4 → v5 的迁移：**只做一件事**——`engineId === 'google'`（那个已删除的免费接口）改指向
 * 「第一个有当前模型的档案」，一个都没有就置 `''`（= 没有可用引擎）。
 *
 * 四条刻意的口径：
 * 1. **只认 `'google'` 这个字面值**，不做"认不出来就重挑"的泛化：v5 迁移的输入是**声明的 v4
 *    数据**，那个版本里 `engineId` 的合法取值只有 `'google'` 与档案 id 两种形状；其他值
 *    （脏存储、手工改过）**不替用户猜**——它们在新语义下表现为"没有可用引擎 + 一句可行动的话"，
 *    不猜 = 不发请求，是安全的默认方向。
 * 2. **判据只有 `firstUsableProfileId` 一份**（`trim()` 后为空即"没有当前模型"），与
 *    `resolveEngine`、与设置页删除档案那条回落**完全同源**。
 * 3. **参数是存储里的生数据**：`mergeSettings` 还没跑，`record.profiles` 可能是 `undefined`
 *    / 非数组 / 装着非对象，所以这里先做一次**形状投影**再问判据。直接
 *    `firstUsableProfileId(record.profiles as EngineProfile[])` 会在 `profiles` 缺失时抛
 *    TypeError（`tests/shared/settings.test.ts` 的「engineId 是 google 时不产生档案」就喂了
 *    这种数据：v2 + `engineId: 'google'` + 没有 `profiles` 键），整个 `loadSettings` 会跟着挂。
 * 4. **产物里不留 `engineId: 'google'` 的任何痕迹**（与 `foldLegacyEngineConfig` 删
 *    `engineConfig` / `providerPreset`、`liftProfileModels` 删 `model` 同一条纪律）。
 *
 * 幂等靠 `migrate` 开头那道版本闸门（`storedVersion >= CURRENT_VERSION` 直接原样返回），
 * 本函数因此只需要处理"第一次读到 v4"那一次。
 */
function dropFreeEngineSelection(record: Record<string, unknown>): Record<string, unknown> {
  if (record.engineId !== 'google') return record;
  const raw = Array.isArray(record.profiles) ? record.profiles : [];
  const candidates: Array<Pick<EngineProfile, 'id' | 'activeModel'>> = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as { id?: unknown; activeModel?: unknown };
    if (typeof entry.id === 'string' && typeof entry.activeModel === 'string') {
      candidates.push({ id: entry.id, activeModel: entry.activeModel });
    }
  }
  return { ...record, engineId: firstUsableProfileId(candidates) };
}

/**
 * v2 → v3 的折叠：把老的那份 `{apiKey, baseUrl, model}` 变成一个档案（id 固定
 * `LEGACY_PROFILE_ID`），并把 `engineId === 'openai-compat'` 改指向它。
 *
 * 三个刻意的决定：
 *
 * 1. **只有当时真的在用自定义接口（`engineId === 'openai-compat'`）才折叠。**
 *    用 google 的老用户存储里那份 engineConfig 是设置页默认值或被放弃的填写——凭空造一个
 *    档案会让弹窗下拉冒出一个用户没要过的条目。（代价如实说：那种用户填过的 Key/地址会随
 *    v3 丢弃，需要重新建一次档案；他当时既然选择不用它，这比一个来路不明的档案更可预期。）
 * 2. **label 优先取当时存的 `providerPreset` 对应的服务商名**——那个字段记录的就是
 *    "这份配置是从哪家填出来的"，迁移后它就是档案名，老用户不用猜"我的接口"是哪个。
 *    `custom`/缺失/脏值用「我的接口」。
 * 3. 字段值**原样搬运**，归一化（地址判据、空白 label 等）交给 `mergeSettings` 的
 *    反序列化边界，两处不各写一份校验。
 */
function foldLegacyEngineConfig(record: Record<string, unknown>): Record<string, unknown> {
  if (record.engineId !== OPENAI_COMPAT_ENGINE_ID) return record;
  const storedConfig: unknown = record.engineConfig;
  const config = (
    storedConfig !== null && typeof storedConfig === 'object' && !Array.isArray(storedConfig)
      ? storedConfig
      : {}
  ) as Partial<{ apiKey: string; baseUrl: string; model: string }>;
  const next: Record<string, unknown> = {
    ...record,
    profiles: [
      {
        id: LEGACY_PROFILE_ID,
        label: legacyLabelForPreset(record.providerPreset),
        baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
        model: typeof config.model === 'string' ? config.model : '',
        apiKey: typeof config.apiKey === 'string' ? config.apiKey : '',
      },
    ],
    engineId: LEGACY_PROFILE_ID,
  };
  // 真相只留一份：老字段在迁移产物里不残留（mergeSettings 本来也不读它们，但存储里
  // 留着会让"下次迁移"的判据变得含糊）。
  delete next.engineConfig;
  delete next.providerPreset;
  return next;
}

/** 老 `providerPreset` → 新档案的名字。认不出来的一切值（含 custom 与缺失）都叫「我的接口」。 */
function legacyLabelForPreset(value: unknown): string {
  if (typeof value === 'string' && value !== 'custom') {
    const preset = PROVIDER_PRESETS.find((item) => item.id === value);
    if (preset !== undefined) return preset.label;
  }
  return FALLBACK_PROFILE_LABEL;
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

/** 不带 API Key 的档案投影，见 {@link loadUiSettings} 的如实定性。 */
export type UiEngineProfile = Omit<EngineProfile, 'apiKey'>;

export type UiSettings = Omit<Settings, 'profiles'> & { profiles: UiEngineProfile[] };

/**
 * 读出**投影版**设置，供内容脚本一类不该碰凭据的调用方使用。
 *
 * 如实定性——这是**类型级**隔离，不是内存级隔离：`UiEngineProfile` 里没有 `apiKey` 字段，
 * 下游代码拿不到它；而实现上本函数仍调用 `loadSettings` 读出整份设置再丢掉字段，密钥会
 * **瞬态**出现在调用方所在 world 的堆里。内容脚本处于 isolated world，页面脚本本来就
 * 访问不到那个堆，实际风险接近 0——但别把投影读成"密钥从不经过网页进程内存"。
 * 要做到结构性隔离，得把 apiKey 拆成独立存储键、投影版根本不读它（后续工作，尚未做）。
 *
 * 档案列表时代新增的义务：**每一项都要剥**，不是剥一个顶层字段。列表渲染天然比单字段
 * 更容易把值带出去，所以这里用逐项解构、并由测试用三个不同密钥逐条断言（settings.test、
 * popup.test、options.test 三处），漏剥任何一项都会红。
 */
export async function loadUiSettings(area?: StorageArea): Promise<UiSettings> {
  const { profiles, ...rest } = await loadSettings(area);
  return { ...rest, profiles: profiles.map(stripProfileApiKey) };
}

function stripProfileApiKey({ apiKey: _apiKey, ...visible }: EngineProfile): UiEngineProfile {
  return visible;
}

/**
 * 保存前先归一化（`mergeSettings`），UI 不可能把脏数据写进存储。
 * 存储里的版本号高于本代码时拒绝写入：继续写就等于用旧 schema 覆盖新数据
 * （弹窗每次改动开关都会保存一次），会把新版字段悄悄丢掉。
 *
 * 注意这是**整份覆盖**：调用方必须持有完整设置（弹窗就是 `loadSettings` 读来的那一份，
 * 它只改 targetLang / engineId，其余字段——**包括每个档案里的 Key**——原样写回）。
 * 设置页因此坚持"写之前重新读一次存储、只覆盖本页管的字段"（见 `options.ts`），
 * 两边各持一份快照同时整份回写时，后写的会把对方的改动抹掉——这个约束在档案列表下
 * 更容易踩中（档案的 Key 也在那份快照里）。
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
