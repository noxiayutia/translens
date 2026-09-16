// src/options/options.ts
//
// 设置页：界面是原生 DOM（不引框架），逻辑是四件事——服务商档案管理、目标语言与显示模式、
// 清缓存、隐私说明。
//
// 档案管理的形状（v3）：设置里存 `profiles: EngineProfile[]`，`engineId` 是 `google` 或某个
// 档案的 id；「档案 → 引擎 + 配置」的解析只有一处（`shared/settings.ts` 的 `resolveEngine`），
// 本页的测试连接也走它——表单里的未保存值合成一份临时档案喂给同一个函数，不再各处各写 if。
//
// 关于密钥：设置页是**扩展自身的受信页面**（`chrome-extension://` 同源），用 `loadSettings()`
// 读完整设置是正当的（要保留用户填的 Key）。但**列表渲染天然比单字段更容易把值带出去**，
// 所以这里有一条硬规矩：档案编辑框的 API Key 输入框**永远从空开始、不回填**，
// 留空保存 = 保留原 Key；密钥只进 `<input>.value` 属性的编辑会话，绝不写进行的任何文本。
// 内容脚本那条路才必须走 `loadUiSettings()` 投影（逐项剥 Key），由
// `tests/content/privacy-guard.test.ts` 与列表投影断言共同守着。
import { TranslationCache } from '../core/cache';
import { LANGUAGES } from '../core/lang';
import { DEFAULT_ENGINE_ID, getEngine } from '../engines/registry';
import { toEngineError } from '../engines/types';
import { chromeArea } from '../shared/chrome-area';
import {
  hasHostPermission,
  originPattern,
  requestHostPermission,
} from '../shared/host-permission';
import {
  DISPLAY_MODES,
  PROVIDER_PRESETS,
  createProfileId,
  isAllowedBaseUrl,
  loadSettings,
  resolveEngine,
  saveSettings,
  type DisplayMode,
  type EngineProfile,
  type Settings,
} from '../shared/settings';

const profilesList = document.getElementById('profiles') as HTMLElement;
const addProfileButton = document.getElementById('add-profile') as HTMLButtonElement;
const engineHint = document.getElementById('engine-hint') as HTMLParagraphElement;
const engineStatus = document.getElementById('engine-status') as HTMLParagraphElement;

const targetLangSelect = document.getElementById('target-lang') as HTMLSelectElement;
const displayModeSelect = document.getElementById('display-mode') as HTMLSelectElement;
const saveDisplayButton = document.getElementById('save') as HTMLButtonElement;

const clearCacheButton = document.getElementById('clear-cache') as HTMLButtonElement;
const cacheStatus = document.getElementById('cache-status') as HTMLParagraphElement;

/** 新增档案的草稿在 `expandedId` 里的哨兵值；它不是合法 id（生成函数带 `p-` 前缀），不会撞车。 */
const NEW_DRAFT_ID = '__new__';

/** 测试连接发出去的文本：够短（一次请求几乎不花额度），又能验证整条链路。 */
const TEST_TEXT = 'hello';

/**
 * 测试连接的超时。这是用户按下去就盯着看的一次交互，不能像页面翻译那样给 60 秒；
 * 20 秒足够一次真实往返 + 调度器/引擎的一轮退避，再久用户只会以为按钮坏了。
 */
const TEST_TIMEOUT_MS = 20_000;

/** 读到存储里的设置之前为 null：这期间任何按钮都不该按一份空设置去写存储。 */
let settings: Settings | null = null;

/** 当前展开编辑的档案 id（或 NEW_DRAFT_ID）；null = 全部收起。一次只展开一个。 */
let expandedId: string | null = null;

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

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 档案编辑表单的原始值。保存与测试连接共用它，保证两条路走的是同一份输入。 */
interface ProfileFormValues {
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

function requireWithin<T extends Element>(root: Element, selector: string): T {
  const found = root.querySelector(selector);
  if (found === null) throw new Error(`档案编辑区缺控件：${selector}`);
  return found as T;
}

/** 读展开区里的表单值。地址/模型名/名字去掉首尾空白；Key 原样（判"填没填"时才 trim）。 */
function readEditor(editor: Element): ProfileFormValues {
  return {
    label: (requireWithin<HTMLInputElement>(editor, '.profile-label')).value.trim(),
    baseUrl: (requireWithin<HTMLInputElement>(editor, '.profile-base-url')).value.trim(),
    model: (requireWithin<HTMLInputElement>(editor, '.profile-model-name')).value.trim(),
    apiKey: requireWithin<HTMLInputElement>(editor, '.profile-api-key').value,
  };
}

function rowById(id: string): HTMLElement | null {
  for (const child of Array.from(profilesList.children)) {
    if (child instanceof HTMLElement && child.dataset.profileId === id) return child;
  }
  return null;
}

/**
 * 校验一个档案的表单值。地址判据与 `shared/settings.ts` 的反序列化边界**完全同一份**
 * （`isAllowedBaseUrl`）：两边各写一套时，设置页会一边说"保存成功"、一边被存储层
 * 悄悄改写，用户永远查不出为什么没生效。
 *
 * 档案不存在"免费引擎不看这两个字段"的豁免——档案的意义就是自定义接口，
 * 地址与名字是必填项。
 */
function validateProfileForm(values: ProfileFormValues): string | null {
  if (values.label.length === 0) return '请填写档案名字';
  if (values.baseUrl.length === 0) return '请填写接口地址（Base URL）';
  if (originPattern(values.baseUrl) === undefined) {
    return `接口地址不是合法的 URL：${values.baseUrl}（示例：https://api.openai.com/v1）`;
  }
  if (!isAllowedBaseUrl(values.baseUrl)) {
    return '接口地址必须用 https://；只有本机回环地址（localhost / 127.0.0.1 / ::1）可以用 http://';
  }
  return null;
}

interface HostPermissionResult {
  state: 'granted' | 'denied';
  /** 权限 API 自己抛错时的原因（不是手势、manifest 没声明该模式……），如实带给用户。 */
  detail?: string;
}

/**
 * 确认一个档案的端点已被授权。
 *
 * **必须在用户手势的调用栈里调用**：Chrome 只在手势中弹授权框，而「保存档案」「测试连接」
 * 都是用户点下来的。已经授权过的不再弹框（先问 `contains`）。
 *
 * 授权失败不是"保存失败"：用户可能只是这次不想授权，那种情况下 Key 与地址照常保存，
 * 由调用方如实告诉他后果（见 `handleSaveProfile`）。
 */
async function ensureHostPermission(baseUrl: string): Promise<HostPermissionResult> {
  const pattern = originPattern(baseUrl);
  if (pattern === undefined) return { state: 'denied', detail: `接口地址不是合法的 URL：${baseUrl}` };

  try {
    if (await hasHostPermission(pattern)) return { state: 'granted' };
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
  return `未授权访问该地址，翻译请求会被浏览器拦下${reason}。需要授权时再点一次「保存档案」并在弹窗里选「允许」。`;
}

/* ------------------------------------------------------------------ 渲染 */

function buildEditor(id: string, profile: EngineProfile | undefined): HTMLElement {
  const editor = element('div', 'profile-editor');

  const labelField = element('label', 'field');
  labelField.append(element('span', '', '名字'), Object.assign(document.createElement('input'), {
    className: 'profile-label',
    type: 'text',
    value: profile?.label ?? '',
    placeholder: '例如：我的 DeepSeek',
    autocomplete: 'off',
  }));
  editor.append(labelField);

  const providerField = element('label', 'field');
  const providerSelect = document.createElement('select');
  providerSelect.className = 'profile-provider';
  fillSelect(
    providerSelect,
    PROVIDER_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
    'custom',
  );
  providerField.append(element('span', '', '服务商模板'), providerSelect);
  editor.append(providerField);

  const baseUrlField = element('label', 'field');
  baseUrlField.append(element('span', '', '接口地址'), Object.assign(document.createElement('input'), {
    className: 'profile-base-url',
    type: 'text',
    // 档案存过什么就回填什么（地址不是凭据）；新草稿留空。
    value: profile?.baseUrl ?? '',
    placeholder: 'https://api.openai.com/v1',
    autocomplete: 'off',
    spellcheck: false,
  }));
  editor.append(baseUrlField);

  const modelField = element('label', 'field');
  modelField.append(element('span', '', '模型名'), Object.assign(document.createElement('input'), {
    className: 'profile-model-name',
    type: 'text',
    value: profile?.model ?? '',
    placeholder: 'gpt-4o-mini',
    autocomplete: 'off',
    spellcheck: false,
  }));
  editor.append(modelField);

  const keyField = element('label', 'field');
  keyField.append(element('span', '', 'API Key'));
  const keyRow = element('span', 'key-row');
  keyRow.append(
    Object.assign(document.createElement('input'), {
      className: 'profile-api-key',
      type: 'password',
      // 隐私硬规矩：value 恒为空。存储里的 Key 不回填、不进 DOM；留空保存 = 保留原 Key。
      value: '',
      placeholder: profile === undefined ? 'sk-…' : '不修改则保留当前 Key',
      autocomplete: 'off',
      spellcheck: false,
    }),
    Object.assign(document.createElement('button'), {
      className: 'ghost profile-toggle-key',
      type: 'button',
      textContent: '显示',
    }),
  );
  keyField.append(keyRow);
  editor.append(keyField);

  const actions = element('div', 'actions');
  const saveButton = element('button', 'primary', '保存档案');
  saveButton.type = 'button';
  saveButton.dataset.action = 'save-profile';
  const testButton = element('button', 'ghost', '测试连接');
  testButton.type = 'button';
  testButton.dataset.action = 'test-profile';
  actions.append(saveButton, testButton);
  if (profile !== undefined) {
    const deleteButton = element('button', 'ghost profile-delete', '删除档案');
    deleteButton.type = 'button';
    deleteButton.dataset.action = 'delete-profile';
    actions.append(deleteButton);
  }
  editor.append(actions);
  return editor;
}

function buildProfileRow(id: string): HTMLElement {
  const snapshot = settings as Settings;
  const isNew = id === NEW_DRAFT_ID;
  const profile = snapshot.profiles.find((item) => item.id === id);
  if (!isNew && profile === undefined) {
    // 展开目标已被别处删除时 renderProfiles 会先收起草稿之外的 id；这条是防御性兜底：
    // 没有可渲染对象的行就是空壳，不抛错。
    return element('div', 'profile-row');
  }

  const expanded = expandedId === id;
  const row = element('div', 'profile-row');
  row.dataset.profileId = id;

  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'profile-summary';
  summary.dataset.action = 'toggle';
  summary.setAttribute('aria-expanded', String(expanded));
  const shownBaseUrl = profile !== null && profile !== undefined && profile.baseUrl.length > 0 ? profile.baseUrl : '未填接口地址';
  const shownModel = profile !== null && profile !== undefined && profile.model.length > 0 ? profile.model : '未填模型名';
  summary.append(
    element('span', 'profile-name', isNew ? '新档案（未保存）' : profile?.label ?? ''),
    element('span', 'profile-base', isNew ? '未填接口地址' : shownBaseUrl),
    element('span', 'profile-model', isNew ? '未填模型名' : shownModel),
  );
  if (!isNew && snapshot.engineId === id) {
    summary.append(element('span', 'profile-badge', '使用中'));
  }
  row.append(summary);
  if (expanded) {
    row.append(buildEditor(id, isNew ? undefined : profile));
  }
  return row;
}

function renderProfiles(): void {
  if (settings === null) return;
  // 展开目标已不存在（比如刚删掉它）：收起，别让下一次渲染挂在一个幽灵 id 上。
  if (expandedId !== null && expandedId !== NEW_DRAFT_ID && !settings.profiles.some((p) => p.id === expandedId)) {
    expandedId = null;
  }
  profilesList.textContent = '';
  for (const profile of settings.profiles) {
    profilesList.append(buildProfileRow(profile.id));
  }
  if (expandedId === NEW_DRAFT_ID) {
    profilesList.append(buildProfileRow(NEW_DRAFT_ID));
  }
}

/** 档案区顶部的说明：当前在用哪一档（选择器的真相在弹窗，这里如实指路）。 */
function renderEngineHint(): void {
  if (settings === null) return;
  const { engine } = resolveEngine(settings);
  const selected = settings.profiles.find((profile) => profile.id === settings?.engineId);
  if (engine.needsKey && selected !== undefined) {
    engineHint.textContent = `当前在用档案「${selected.label}」。点下面的档案行展开编辑；在弹窗的「翻译引擎」里按名字切换。`;
    return;
  }
  engineHint.textContent = '当前在用免费接口（零配置）。档案配好后，在弹窗的「翻译引擎」下拉里按名字选中才会生效。';
}

/* ------------------------------------------------------------------ 行为 */

/**
 * 保存（或新建）一个档案。
 *
 * 写之前**重新读一次**存储，只覆盖档案列表这一个关注点：`saveSettings` 是整份覆盖，
 * 弹窗也可能在别的窗口改目标语言/引擎，拿页面快照整份回写会把那些改动静默抹掉
 * （`shared/settings.ts` 的 `saveSettings` 注释点名的坑，档案列表下更容易踩中）。
 */
async function handleSaveProfile(id: string): Promise<void> {
  const editor = rowById(id)?.querySelector('.profile-editor');
  if (editor === null || editor === undefined) {
    setStatus(engineStatus, 'err', '档案编辑区不在页面上，请重新展开该档案');
    return;
  }
  const values = readEditor(editor);
  const invalid = validateProfileForm(values);
  if (invalid !== null) {
    setStatus(engineStatus, 'err', invalid);
    return;
  }

  // 用户手势里申请这个档案自己的 origin（Chrome 要求手势，见 host-permission）。
  const permission = await ensureHostPermission(values.baseUrl);

  let latest: Settings;
  try {
    latest = await loadSettings();
  } catch (raw) {
    setStatus(engineStatus, 'err', `保存前读取设置失败：${describe(raw)}`);
    return;
  }

  const isNew = id === NEW_DRAFT_ID;
  let savedId: string;
  let profiles: EngineProfile[];
  if (isNew) {
    savedId = createProfileId();
    profiles = [...latest.profiles, { id: savedId, ...values }];
  } else {
    savedId = id;
    const existing = latest.profiles.find((profile) => profile.id === id);
    // Key 留空 = 保留**存储里当前**的那份（不是页面打开时的快照——整份覆盖的老坑同一个）。
    const apiKey = values.apiKey.trim().length > 0 ? values.apiKey : existing?.apiKey ?? '';
    const nextProfile: EngineProfile = { id: savedId, label: values.label, baseUrl: values.baseUrl, model: values.model, apiKey };
    profiles = existing === undefined ? [...latest.profiles, nextProfile] : latest.profiles.map((p) => (p.id === id ? nextProfile : p));
  }
  // engineId 原样保留（来自 latest）：**选择档案是弹窗的职责**，本页保存档案从不偷改它——
  // 只有删除当前档案时才被迫回落（见 handleDeleteProfile），并如实说。
  const next: Settings = { ...latest, profiles };

  try {
    await saveSettings(next);
  } catch (raw) {
    setStatus(engineStatus, 'err', `设置未能保存：${describe(raw)}`);
    return;
  }

  settings = next;
  expandedId = savedId;
  renderProfiles();
  renderEngineHint();

  if (permission.state === 'denied') {
    // Key 与地址都已经存下来了：用户可能只是暂时不想授权。
    setStatus(engineStatus, 'err', `已保存档案「${values.label}」。${deniedHint(permission)}`);
    return;
  }
  const where = `，并已授权访问 ${originPattern(values.baseUrl) ?? values.baseUrl}`;
  setStatus(engineStatus, 'ok', `已保存档案「${values.label}」${where}。在弹窗的「翻译引擎」里选它即可使用。`);
}

/**
 * 测试连接：**真的发一次翻译请求**，走的是生产引擎代码本身。测的是**这一行正在编辑的
 * 档案**（表单当前值，未保存也算），不是全局某份配置——多个档案时代"测一下"必须
 * 说得清测的是谁。
 *
 * 「表单值 → 引擎 + 配置」仍然只经 `resolveEngine` 一处：把编辑值合成一份临时档案喂给
 * 它，本页不再维护第二套"档案用哪个引擎"的判断。
 */
async function handleTestProfile(id: string): Promise<void> {
  const editor = rowById(id)?.querySelector('.profile-editor');
  if (editor === null || editor === undefined) {
    setStatus(engineStatus, 'err', '档案编辑区不在页面上，请重新展开该档案');
    return;
  }
  const values = readEditor(editor);
  const invalid = validateProfileForm(values);
  if (invalid !== null) {
    setStatus(engineStatus, 'err', invalid);
    return;
  }

  // 先要授权：没授权时引擎会直接抛「未授权」（那是它的正确行为），但用户此刻正在填地址，
  // 顺手把授权框弹出来才是他期待的。
  const permission = await ensureHostPermission(values.baseUrl);
  if (permission.state === 'denied') {
    setStatus(engineStatus, 'err', deniedHint(permission));
    return;
  }

  // Key 输入框留空时测的是**存储里已存的**那份（和"保存"同一语义）；新草稿没存过就是空，
  // 引擎会给出可行动的 AUTH 提示。
  const storedKey = settings?.profiles.find((profile) => profile.id === id)?.apiKey ?? '';
  const apiKey = values.apiKey.trim().length > 0 ? values.apiKey : storedKey;
  const { engine, config } = resolveEngine({
    engineId: id,
    profiles: [{ id, label: values.label, baseUrl: values.baseUrl, model: values.model, apiKey }],
  });

  setStatus(engineStatus, 'pending', `正在用档案「${values.label}」翻译一次「${TEST_TEXT}」…`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const [translation] = await engine.translate(
      { texts: [TEST_TEXT], from: 'auto', to: targetLangSelect.value, signal: controller.signal },
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
 * 删除一个档案。若删的正是**当前在用**的那个，`engineId` 明确回落到免费接口并说明——
 * 绝不能留下一个指向不存在档案的 id。（为什么回落 google 而不是"下一个档案"：下一个
 * 档案可能没填 Key、地址可能没授权，删一个档案不该让用户突然翻译失败。）
 */
async function handleDeleteProfile(id: string): Promise<void> {
  let latest: Settings;
  try {
    latest = await loadSettings();
  } catch (raw) {
    setStatus(engineStatus, 'err', `删除前读取设置失败：${describe(raw)}`);
    return;
  }
  const target = latest.profiles.find((profile) => profile.id === id);
  if (target === undefined) {
    // 别处已经删过（并发窗口）：如实说，并刷新到存储的真实列表，不静默"删除成功"。
    settings = latest;
    expandedId = null;
    renderProfiles();
    renderEngineHint();
    setStatus(engineStatus, 'err', '该档案已经不在了（可能在别处被删除），列表已刷新。');
    return;
  }
  const wasCurrent = latest.engineId === id;
  const remaining = latest.profiles.filter((profile) => profile.id !== id);
  const next: Settings = {
    ...latest,
    profiles: remaining,
    engineId: wasCurrent ? DEFAULT_ENGINE_ID : latest.engineId,
  };
  try {
    await saveSettings(next);
  } catch (raw) {
    setStatus(engineStatus, 'err', `设置未能保存：${describe(raw)}`);
    return;
  }
  settings = next;
  if (expandedId === id) expandedId = null;
  renderProfiles();
  renderEngineHint();
  setStatus(
    engineStatus,
    'ok',
    wasCurrent
      ? `已删除当前在用的档案「${target.label}」，引擎已回落到「${getEngine(DEFAULT_ENGINE_ID).name}」，请在弹窗里重新选择。`
      : `已删除档案「${target.label}」。`,
  );
}

/** 语言与显示模式的保存（本页的另一个关注点；不碰档案、也不碰 engineId）。 */
async function handleSaveDisplay(): Promise<void> {
  if (settings === null) {
    setStatus(engineStatus, 'err', '设置还没读出来，请稍候重试');
    return;
  }
  let latest: Settings;
  try {
    latest = await loadSettings();
  } catch (raw) {
    setStatus(engineStatus, 'err', `保存前读取设置失败：${describe(raw)}`);
    return;
  }
  const next: Settings = {
    ...latest,
    targetLang: targetLangSelect.value,
    displayMode: displayModeSelect.value as DisplayMode,
  };
  try {
    await saveSettings(next);
  } catch (raw) {
    setStatus(engineStatus, 'err', `设置未能保存：${describe(raw)}`);
    return;
  }
  settings = next;
  setStatus(engineStatus, 'ok', '已保存。');
}

/**
 * 清除翻译缓存：删掉**两层**（持久层 + 会话层）全部 `jt:` 前缀的键。
 *
 * 用 `TranslationCache` 而不是自己拼 `jt:` 前缀：缓存的键名、元数据键、形状坏掉的残留
 * 都归它管（`clear()` 就是为这件事写的），设置页不该再维护一份关于缓存内部结构的假设。
 *
 * **会话层必须一起清**：翻译读取走 `TieredCache`（先查会话层）。只清持久层的话，
 * 用户点完"清除"立刻重译页面照样零请求命中——按钮看起来失灵，报出的条数也系统性少报。
 * 设置页是扩展自身的受信页面（`chrome-extension://` 同源），可以直接访问
 * `chrome.storage.session`（其默认可见级别正是 TRUSTED_CONTEXTS），不需要绕道后台消息。
 *
 * 报出来的条数是**两层各自真实条目数之和**（`count()` 走全量扫描，不含计数元数据与
 * 形状坏掉的残留）。
 */
async function handleClearCache(): Promise<void> {
  const maxEntries = settings?.cacheMaxEntries;
  const persistent = new TranslationCache(chromeArea(chrome.storage.local), maxEntries);
  const session = new TranslationCache(chromeArea(chrome.storage.session), maxEntries);
  const [persistentBefore, sessionBefore] = await Promise.all([persistent.count(), session.count()]);
  await Promise.all([persistent.clear(), session.clear()]);
  const cleared = persistentBefore + sessionBefore;
  setStatus(cacheStatus, 'ok', cleared === 0 ? '缓存本来就是空的' : `已清除 ${cleared} 条翻译缓存`);
}

/** 显示 / 隐藏某个档案编辑区的 API Key。只改该行的 `type` 与按钮文案，值不动（更不会复制到别处）。 */
function toggleKeyVisibility(button: HTMLElement): void {
  const editor = button.closest('.profile-editor');
  if (editor === null) return;
  const input = requireWithin<HTMLInputElement>(editor, '.profile-api-key');
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  button.textContent = hidden ? '隐藏' : '显示';
  button.setAttribute('aria-pressed', String(hidden));
  button.title = hidden ? '隐藏 API Key' : '显示 API Key';
}

/**
 * 服务商模板 = 编辑表单的**填写捷径**：选中即把接口地址与模型名填进**这一行**，
 * 用户还没点保存，改回来零成本。不碰 API Key（那是用户自己的凭据）。
 * 只挂在下拉自己的 change 上——展开既有档案时**永远不重放**预设（否则会把用户存过
 * 的地址/模型悄悄改回模板值）。
 */
function applyProviderTemplate(editor: Element): void {
  const select = requireWithin<HTMLSelectElement>(editor, '.profile-provider');
  const preset = PROVIDER_PRESETS.find((entry) => entry.id === select.value);
  if (preset === undefined || preset.baseUrl === undefined || preset.model === undefined) return;
  requireWithin<HTMLInputElement>(editor, '.profile-base-url').value = preset.baseUrl;
  requireWithin<HTMLInputElement>(editor, '.profile-model-name').value = preset.model;
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
    targetLangSelect,
    LANGUAGES.map((lang) => ({ value: lang.code, label: lang.label })),
    loaded.targetLang,
  );
  fillSelect(displayModeSelect, DISPLAY_MODES, loaded.displayMode);
  renderProfiles();
  renderEngineHint();
}

function init(): void {
  // 监听器在第一个 await 之前挂好：`loadSettings` 有明确的拒绝路径（存储里是更高版本、
  // 存储读写失败）。等读完再挂的话，那些拒绝会让界面停在一个"看着能点、其实没有任何
  // 监听器"的死页面上，用户连重试都点不了。
  //
  // 档案列表是动态渲染的，行内按钮一律走**容器上的事件委托**（data-action 派发），
  // 每次重渲染不用重新挂监听器。
  profilesList.addEventListener('click', (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.classList.contains('profile-toggle-key')) {
      toggleKeyVisibility(target);
      return;
    }
    const row = target.closest('[data-profile-id]');
    if (!(row instanceof HTMLElement)) return;
    const id = row.dataset.profileId as string;
    switch (target.dataset.action) {
      case 'toggle':
        if (settings === null) return;
        expandedId = expandedId === id ? null : id;
        renderProfiles();
        break;
      case 'save-profile':
        runSafely(engineStatus, '保存失败', () => handleSaveProfile(id));
        break;
      case 'test-profile':
        runSafely(engineStatus, '测试连接失败', () => handleTestProfile(id));
        break;
      case 'delete-profile':
        runSafely(engineStatus, '删除失败', () => handleDeleteProfile(id));
        break;
    }
  });
  profilesList.addEventListener('change', (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.classList.contains('profile-provider')) {
      const editor = target.closest('.profile-editor');
      if (editor !== null) applyProviderTemplate(editor);
    }
  });
  profilesList.addEventListener('input', (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    // 地址/模型名被手打 → 这一行按"自定义"算：模板下拉翻回 custom，而不是留着个
    // 已经说谎的「DeepSeek」。预设永远不许反过来覆盖用户敲进去的值。
    if (target.classList.contains('profile-base-url') || target.classList.contains('profile-model-name')) {
      const editor = target.closest('.profile-editor');
      if (editor !== null) requireWithin<HTMLSelectElement>(editor, '.profile-provider').value = 'custom';
    }
  });

  addProfileButton.addEventListener('click', () => {
    if (settings === null) {
      setStatus(engineStatus, 'err', '设置还没读出来，请稍候重试');
      return;
    }
    if (expandedId !== NEW_DRAFT_ID) {
      expandedId = NEW_DRAFT_ID;
      renderProfiles();
    }
  });
  saveDisplayButton.addEventListener('click', () => runSafely(engineStatus, '保存失败', handleSaveDisplay));
  clearCacheButton.addEventListener('click', () => runSafely(cacheStatus, '清除缓存失败', handleClearCache));

  runSafely(engineStatus, '设置读取失败', start);
}

init();
