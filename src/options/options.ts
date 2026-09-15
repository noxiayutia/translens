// src/options/options.ts
//
// 设置页：界面是原生 DOM（不引框架），逻辑只有四件事——引擎配置、目标语言、显示模式、清缓存。
//
// 关于密钥：设置页是**扩展自身的受信页面**（`chrome-extension://` 同源），所以这里用
// `loadSettings()` 读完整设置是正当的（要显示用户自己填的 API Key）；内容脚本那条路才必须
// 走 `loadUiSettings()` 投影，由 `tests/content/privacy-guard.test.ts` 守着。
import { TranslationCache } from '../core/cache';
import { LANGUAGES } from '../core/lang';
import { ENGINES, getEngine } from '../engines/registry';
import { toEngineError, type EngineConfig } from '../engines/types';
import { chromeArea } from '../shared/chrome-area';
import {
  canQueryHostPermission,
  hasHostPermission,
  originPattern,
  requestHostPermission,
} from '../shared/host-permission';
import {
  DISPLAY_MODES,
  PROVIDER_PRESETS,
  isAllowedBaseUrl,
  loadSettings,
  saveSettings,
  type DisplayMode,
  type ProviderPresetId,
  type Settings,
} from '../shared/settings';

const engineSelect = document.getElementById('engine') as HTMLSelectElement;
const engineHint = document.getElementById('engine-hint') as HTMLParagraphElement;
const providerSelect = document.getElementById('provider') as HTMLSelectElement;
const baseUrlInput = document.getElementById('base-url') as HTMLInputElement;
const apiKeyInput = document.getElementById('api-key') as HTMLInputElement;
const toggleKeyButton = document.getElementById('toggle-key') as HTMLButtonElement;
const modelInput = document.getElementById('model') as HTMLInputElement;
const saveButton = document.getElementById('save') as HTMLButtonElement;
const testButton = document.getElementById('test-connection') as HTMLButtonElement;
const engineStatus = document.getElementById('engine-status') as HTMLParagraphElement;

const targetLangSelect = document.getElementById('target-lang') as HTMLSelectElement;
const displayModeSelect = document.getElementById('display-mode') as HTMLSelectElement;

const clearCacheButton = document.getElementById('clear-cache') as HTMLButtonElement;
const cacheStatus = document.getElementById('cache-status') as HTMLParagraphElement;

/** 测试连接发出去的文本：够短（一次请求几乎不花额度），又能验证整条链路。 */
const TEST_TEXT = 'hello';

/**
 * 测试连接的超时。这是用户按下去就盯着看的一次交互，不能像页面翻译那样给 60 秒；
 * 20 秒足够一次真实往返 + 调度器/引擎的一轮退避，再久用户只会以为按钮坏了。
 */
const TEST_TIMEOUT_MS = 20_000;

/** 读到存储里的设置之前为 null：这期间任何按钮都不该按一份空设置去写存储。 */
let settings: Settings | null = null;

type StatusKind = 'ok' | 'err' | 'pending';

/** 状态行的唯一出口：`data-kind` 决定颜色（成功绿 / 失败红），文案一律用 textContent。 */
function setStatus(element: HTMLElement, kind: StatusKind, message: string): void {
  element.dataset.kind = kind;
  element.textContent = message;
}

function describe(raw: unknown): string {
  return raw instanceof Error ? raw.message : String(raw);
}

function fillSelect(
  select: HTMLSelectElement,
  entries: ReadonlyArray<{ value: string; label: string }>,
  value: string,
): void {
  select.textContent = '';
  for (const entry of entries) {
    const option = document.createElement('option');
    option.value = entry.value;
    option.textContent = entry.label;
    option.selected = entry.value === value;
    select.append(option);
  }
}

interface EngineFormValues {
  engineId: string;
  providerPreset: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  targetLang: string;
  displayMode: DisplayMode;
}

/** 表单当前的原始值。保存与测试连接共用它，保证两条路走的是同一份输入。 */
function readForm(): EngineFormValues {
  return {
    engineId: engineSelect.value,
    providerPreset: providerSelect.value,
    baseUrl: baseUrlInput.value.trim(),
    apiKey: apiKeyInput.value,
    model: modelInput.value.trim(),
    targetLang: targetLangSelect.value,
    displayMode: displayModeSelect.value as DisplayMode,
  };
}

/**
 * 选中服务商预设 → 把接口地址与模型名**填进表单**（用户还没点保存，改回来零成本）。
 *
 * 只做两件事，刻意不多做：
 * - 不碰 API Key（那是用户自己的凭据，跟"哪家接口"无关）；
 * - `custom` 不预填任何东西（保持现状——老用户存了什么就还是什么）。
 */
function applyProviderPreset(): void {
  const preset = PROVIDER_PRESETS.find((entry) => entry.id === providerSelect.value);
  if (preset === undefined || preset.baseUrl === undefined || preset.model === undefined) return;
  baseUrlInput.value = preset.baseUrl;
  modelInput.value = preset.model;
}

/**
 * 用户手改接口地址/模型名 → 这一轮就按"自定义"算：下拉翻回 custom，
 * 而不是留着一个已经说谎的「OpenAI」。预设逻辑只挂在**下拉自己的 change** 上，
 * 永远不会反过来覆盖用户敲进去的值。
 */
function markProviderCustom(): void {
  providerSelect.value = 'custom';
}

/**
 * 校验接口地址。判据与 `shared/settings.ts` 的反序列化边界**完全同一份**
 * （`isAllowedBaseUrl`）：两边各写一套时，设置页会一边说"保存成功"、一边被存储层
 * 悄悄退回默认地址，用户永远查不出为什么没生效。
 *
 * 免费引擎不看这两个字段，所以它填什么都不拦（用户可能刚切过去，值还是别人的）。
 */
function validateBaseUrl(values: EngineFormValues): string | null {
  if (!getEngine(values.engineId).needsKey) return null;
  if (values.baseUrl.length === 0) return '请填写接口地址（Base URL）';
  if (originPattern(values.baseUrl) === undefined) {
    return `接口地址不是合法的 URL：${values.baseUrl}（示例：https://api.openai.com/v1）`;
  }
  if (!isAllowedBaseUrl(values.baseUrl)) {
    return '接口地址必须用 https://；只有本机回环地址（localhost / 127.0.0.1 / ::1）可以用 http://';
  }
  return null;
}

type PermissionState = 'granted' | 'denied' | 'not-needed';

interface HostPermissionResult {
  state: PermissionState;
  /** 权限 API 自己抛错时的原因（不是手势、manifest 没声明该模式……），如实带给用户。 */
  detail?: string;
}

/**
 * 确认用户填的自定义端点已被授权。
 *
 * **必须在用户手势的调用栈里调用**：Chrome 只在手势中弹授权框，而「保存」与「测试连接」
 * 都是用户点下来的。已经授权过的不再弹框（先问 `contains`）。
 *
 * 授权失败不是"保存失败"：用户可能只是这次不想授权，那种情况下 Key 与地址照常保存，
 * 由调用方如实告诉他后果（见 `handleSave`）。
 */
async function ensureHostPermission(values: EngineFormValues): Promise<HostPermissionResult> {
  if (!getEngine(values.engineId).needsKey) return { state: 'not-needed' };

  const pattern = originPattern(values.baseUrl);
  if (pattern === undefined) return { state: 'denied', detail: `接口地址不是合法的 URL：${values.baseUrl}` };

  try {
    if (await hasHostPermission(pattern)) return { state: 'granted' };
    if (!canQueryHostPermission()) {
      return { state: 'denied', detail: '当前环境没有权限 API，无法申请访问授权' };
    }
    const granted = await requestHostPermission(pattern);
    return granted ? { state: 'granted' } : { state: 'denied' };
  } catch (raw) {
    // 不能当成"已授权"（那会让用户拿到一个必然被浏览器拦下的请求），也不能静默。
    return { state: 'denied', detail: describe(raw) };
  }
}

/** 未授权时给用户看的后果说明：说清"会怎样"和"怎么办"。 */
function deniedHint(result: HostPermissionResult): string {
  const reason = result.detail === undefined ? '' : `（${result.detail}）`;
  return `未授权访问该地址，翻译请求会被浏览器拦下${reason}。需要授权时再点一次「保存」并在弹窗里选「允许」。`;
}

async function handleSave(): Promise<void> {
  if (settings === null) {
    setStatus(engineStatus, 'err', '设置还没读出来，请稍候重试');
    return;
  }
  const values = readForm();
  const invalid = validateBaseUrl(values);
  if (invalid !== null) {
    setStatus(engineStatus, 'err', invalid);
    return;
  }

  // 用户手势里申请自定义端点的访问权限（见 ensureHostPermission）。
  const permission = await ensureHostPermission(values);

  /**
   * 写之前**重新读一次**存储，只覆盖本页管的字段。
   *
   * `saveSettings` 是整份覆盖，而弹窗也能改目标语言与引擎：设置页开着的时候用户在弹窗里
   * 改了语言，这里再拿页面打开时的旧快照整份回写，就会把那次改动静默抹掉
   * （`shared/settings.ts` 的 `saveSettings` 注释里点名的就是这个坑）。
   */
  let latest: Settings;
  try {
    latest = await loadSettings();
  } catch (raw) {
    setStatus(engineStatus, 'err', `保存前读取设置失败：${describe(raw)}`);
    return;
  }

  const next: Settings = {
    ...latest,
    engineId: values.engineId,
    engineConfig: { apiKey: values.apiKey, baseUrl: values.baseUrl, model: values.model },
    // 认不出的值（含被绕过 UI 塞进来的脏字符串）由 `mergeSettings` 在落盘前回落成 custom。
    providerPreset: values.providerPreset as ProviderPresetId,
    targetLang: values.targetLang,
    displayMode: values.displayMode,
  };

  try {
    await saveSettings(next);
    settings = next;
  } catch (raw) {
    setStatus(engineStatus, 'err', `设置未能保存：${describe(raw)}`);
    return;
  }

  renderEngineHint();
  if (permission.state === 'denied') {
    // Key 与地址都已经存下来了：用户可能只是暂时不想授权。
    setStatus(engineStatus, 'err', `已保存。${deniedHint(permission)}`);
    return;
  }
  const engine = getEngine(values.engineId);
  const where = engine.needsKey ? `，并已授权访问 ${originPattern(values.baseUrl) ?? values.baseUrl}` : '';
  setStatus(engineStatus, 'ok', `已保存${where}。`);
}

/**
 * 测试连接：**真的发一次翻译请求**，走的是生产引擎代码本身
 * （`getEngine(...).translate`），不另写一套请求逻辑——那样测的就不是用户实际会走的那条路了。
 */
async function handleTest(): Promise<void> {
  const values = readForm();
  const invalid = validateBaseUrl(values);
  if (invalid !== null) {
    setStatus(engineStatus, 'err', invalid);
    return;
  }

  const engine = getEngine(values.engineId);
  // 先要授权：没授权时引擎会直接抛「未授权」（那是它的正确行为），但用户此刻正在填地址，
  // 顺手把授权框弹出来才是他期待的。
  const permission = await ensureHostPermission(values);
  if (permission.state === 'denied') {
    setStatus(engineStatus, 'err', deniedHint(permission));
    return;
  }

  setStatus(engineStatus, 'pending', `正在用「${engine.name}」翻译一次「${TEST_TEXT}」…`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  const config: EngineConfig = { apiKey: values.apiKey, baseUrl: values.baseUrl, model: values.model };
  try {
    const [translation] = await engine.translate(
      { texts: [TEST_TEXT], from: 'auto', to: values.targetLang, signal: controller.signal },
      config,
    );
    setStatus(engineStatus, 'ok', `连接成功：${TEST_TEXT} → ${translation ?? ''}`);
  } catch (raw) {
    // 错误码要显示出来（AUTH / RATE_LIMIT / NETWORK……）：它是用户判断"该改 Key 还是
    // 该稍后重试"的唯一依据，只给一句自然语言会把这两件事混在一起。
    const error = toEngineError(raw);
    setStatus(engineStatus, 'err', `连接失败（${error.code}）：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 清除翻译缓存：删掉存储里全部 `jt:` 前缀的键。
 *
 * 用 `TranslationCache` 而不是自己拼 `jt:` 前缀：缓存的键名、元数据键、形状坏掉的残留
 * 都归它管（`clear()` 就是为这件事写的），设置页不该再维护一份关于缓存内部结构的假设。
 * 报出来的条数是**真实条目数**（`count()` 走全量扫描，不含计数元数据与坏记录）。
 */
async function handleClearCache(): Promise<void> {
  const area = chromeArea(chrome.storage.local);
  const cache = new TranslationCache(area, settings?.cacheMaxEntries);
  const before = await cache.count();
  await cache.clear();
  setStatus(cacheStatus, 'ok', before === 0 ? '缓存本来就是空的' : `已清除 ${before} 条翻译缓存`);
}

/** 显示 / 隐藏 API Key。只改 `type` 与按钮文案，值不动（更不会复制到别处）。 */
function toggleKeyVisibility(): void {
  const hidden = apiKeyInput.type === 'password';
  apiKeyInput.type = hidden ? 'text' : 'password';
  toggleKeyButton.textContent = hidden ? '隐藏' : '显示';
  toggleKeyButton.setAttribute('aria-pressed', String(hidden));
  toggleKeyButton.title = hidden ? '隐藏 API Key' : '显示 API Key';
}

function renderEngineHint(): void {
  const engine = getEngine(engineSelect.value);
  if (engine.needsKey) {
    engineHint.textContent = '需要自己填接口地址、API Key 与模型名；点「保存」时会向浏览器申请访问该地址的权限。';
    return;
  }
  engineHint.textContent = '免费接口零配置可用，下面的接口地址与 API Key 不会用到（切回自定义引擎时仍然保留）。';
}

/**
 * 任何没被就地处理的拒绝都要变成用户看得见的一句话：没有它，一次失败的 `await`
 * 会留下一个未处理的拒绝，界面停在半初始化状态——按钮看着能点、点下去没反应。
 */
function runSafely(target: HTMLElement, prefix: string, run: () => Promise<void>): void {
  void run().catch((raw: unknown) => {
    setStatus(target, 'err', `${prefix}：${describe(raw)}`);
  });
}

/** 初始化要用的那串 await；监听器在它**之前**挂好（见 `init`）。 */
async function start(): Promise<void> {
  const loaded = await loadSettings();
  settings = loaded;
  fillSelect(
    engineSelect,
    ENGINES.map((engine) => ({ value: engine.id, label: engine.name })),
    loaded.engineId,
  );
  fillSelect(
    targetLangSelect,
    LANGUAGES.map((lang) => ({ value: lang.code, label: lang.label })),
    loaded.targetLang,
  );
  fillSelect(displayModeSelect, DISPLAY_MODES, loaded.displayMode);
  // 服务商下拉：选项与预填值同源（shared/settings 的那一份），不在这儿手抄。
  // 只把**上次存过的选择**显示出来——不触发 applyProviderPreset，
  // 用户存过的接口地址/模型名一个字符都不动（预设只在"选它"那一刻填表）。
  fillSelect(
    providerSelect,
    PROVIDER_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
    loaded.providerPreset,
  );
  baseUrlInput.value = loaded.engineConfig.baseUrl;
  apiKeyInput.value = loaded.engineConfig.apiKey;
  modelInput.value = loaded.engineConfig.model;
  renderEngineHint();
}

function init(): void {
  // 监听器在第一个 await 之前挂好：`loadSettings` 有明确的拒绝路径（存储里是更高版本、
  // 存储读写失败）。等读完再挂的话，那些拒绝会让界面停在一个"看着能点、其实没有任何
  // 监听器"的死页面上，用户连重试都点不了。
  saveButton.addEventListener('click', () => runSafely(engineStatus, '保存失败', handleSave));
  testButton.addEventListener('click', () => runSafely(engineStatus, '测试连接失败', handleTest));
  clearCacheButton.addEventListener('click', () => runSafely(cacheStatus, '清除缓存失败', handleClearCache));
  toggleKeyButton.addEventListener('click', toggleKeyVisibility);
  engineSelect.addEventListener('change', renderEngineHint);
  // 服务商：下拉 change 才预填；接口地址/模型名一被手打就翻回 custom（见上面两个函数）。
  providerSelect.addEventListener('change', applyProviderPreset);
  baseUrlInput.addEventListener('input', markProviderCustom);
  modelInput.addEventListener('input', markProviderCustom);

  runSafely(engineStatus, '设置读取失败', start);
}

init();
