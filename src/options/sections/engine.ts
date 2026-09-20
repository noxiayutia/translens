// src/options/sections/engine.ts
//
// §3.1 翻译引擎：档案列表、展开编辑、测试连接、删除、服务商模板、Key 显示切换。
//
// 本文件由 `options.ts` 原样搬来（2026-09-18 设置页改版）。搬家的规矩是**行为一行不改**：
// `tests/options/options.test.ts` 里那 20 条引擎用例是验收标准，一条都不许红。
// 唯一的结构性变化是"设置从哪来、状态写到哪去"：`settings` → `ctx.settings()`，
// `saveSettings(...)` → `ctx.save(...)`（后者自带"排队 + 写前重读 + 只覆盖本次给的字段"）。
//
// 隐私硬规矩（与搬家前逐字相同）：档案编辑框的 API Key 输入框**永远从空开始、不回填**，
// 留空保存 = 保留原 Key；密钥只进 `<input>.value` 属性的编辑会话，绝不写进行的任何文本，
// 也不进任何 `title` / 文本节点。
//
// ⚠ **三处跨函数的耦合，拆这个文件之前先读这里**（都是"各留一份就会静默漂移"的东西）：
// 1. `expandedId`（含 `NEW_DRAFT_ID` 这个草稿哨兵）是**列表渲染与编辑器共用**的状态：
//    `renderProfiles` / `buildProfileRow` 读它决定展开哪一行，`bind` 里的事件委托改它，
//    `handleSaveProfile` / `handleDeleteProfile` 也改它。要拆就把这个变量与 `NEW_DRAFT_ID`
//    一起搬走（或显式传参），**不要在两处各留一份**——两份 `expandedId` 的症状是"点了没反应/
//    展开的不是这一行"，而类型检查看不出来。
// 2. `buildEditor` 造出来的控件 class（`.profile-label` / `.profile-base-url` /
//    `.profile-model-name` / `.profile-api-key` / `.profile-provider` / `.profile-toggle-key`）
//    是**契约**：`readEditor` / `validateProfileForm` / `applyProviderTemplate` /
//    `toggleKeyVisibility` 与 `tests/options/options.test.ts` 的 `fieldOf(editor, …)` 全都按
//    这组名字找控件。改名要四处一起改（含测试），否则运行时才炸、且是在"保存档案"那一刻才炸。
// 3. 两个渲染函数的**数据来源不同，别混用**：`renderProfiles` 渲染的是**内存快照**
//    （`ctx.settings()`，可能与存储已经不一致）；`renderFromStorage` 是"先 `ctx.reload()`
//    重读存储、成功了再渲染"，并**返回是否真的刷新成功**。调用方只有在拿到 `true` 时才许宣称
//    "列表已刷新"——这条没写下来的后果就是一个真出现过的 bug：刷新失败时列表没换、提示却说换了。
import { getEngine, DEFAULT_ENGINE_ID } from '../../engines/registry';
import { toEngineError, type EngineConfig, type Translator } from '../../engines/types';
import {
  hasHostPermission,
  originPattern,
  requestHostPermission,
} from '../../shared/host-permission';
import {
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  createProfileId,
  isAllowedBaseUrl,
  loadSettings,
  resolveEngine,
  type EngineProfile,
  type Settings,
} from '../../shared/settings';
import { describe, element, fillSelect, requireWithin, runSafely, setStatus, type StatusKind } from '../dom';
// 状态点的记录（§4.3）：独立于 `store.ts` 的会话内记忆，见 `engine-health.ts` 顶部的说明。
import {
  FREE_ENGINE_HEALTH_ID,
  forgetEngineHealth,
  loadEngineHealth,
  redactSecret,
  saveEngineHealth,
  type EngineHealth,
} from '../engine-health';
// 这句话只有一个来源：`store.ts` 导出的 `NOT_LOADED`。
import { NOT_LOADED } from '../store';
import type { Section, SectionContext } from '../section';

const profilesList = document.getElementById('profiles') as HTMLElement;
const addProfileButton = document.getElementById('add-profile') as HTMLButtonElement;
const engineHint = document.getElementById('engine-hint') as HTMLElement;
const engineStatus = document.getElementById('engine-status') as HTMLElement;

/** 新增档案的草稿在 `expandedId` 里的哨兵值；它不是合法 id（生成函数带 `p-` 前缀），不会撞车。 */
const NEW_DRAFT_ID = '__new__';

/** 测试连接发出去的文本：够短（一次请求几乎不花额度），又能验证整条链路。 */
const TEST_TEXT = 'hello';

/**
 * 测试连接的超时。这是用户按下去就盯着看的一次交互，不能像页面翻译那样给 60 秒；
 * 20 秒足够一次真实往返 + 调度器/引擎的一轮退避，再久用户只会以为按钮坏了。
 */
const TEST_TIMEOUT_MS = 20_000;

/** 当前展开编辑的档案 id（或 NEW_DRAFT_ID）；null = 全部收起。一次只展开一个。 */
let expandedId: string | null = null;

/**
 * 状态点的记录（§4.3）。三态里"从没测过"是**没有记录**，所以这里只存有结果的那些。
 * `mount` 时从 `chrome.storage.session` 读一次，之后每次测试连接就地更新。
 */
let health: Record<string, EngineHealth> = {};

/** 档案编辑表单的原始值。保存与测试连接共用它，保证两条路走的是同一份输入。 */
interface ProfileFormValues {
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

function rowById(id: string): HTMLElement | null {
  for (const child of Array.from(profilesList.children)) {
    if (child instanceof HTMLElement && child.dataset.profileId === id) return child;
  }
  return null;
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

/**
 * 校验一个档案的表单值。地址判据与 `shared/settings.ts` 的反序列化边界**完全同一份**
 * （`isAllowedBaseUrl`）：两边各写一套时，设置页会一边说"保存成功"、一边被存储层
 * 悄悄改写，用户永远查不出为什么没生效。
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
 * 确认一个档案的端点已被授权。**必须在用户手势的调用栈里调用**：Chrome 只在手势中弹授权框，
 * 而「保存档案」「测试连接」都是用户点下来的。已经授权过的不再弹框（先问 `contains`）。
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

/**
 * 三态：绿 = 最近一次测试连接通过；**灰 = 从没测过（不代表可用）**；红 = 最近一次失败。
 * 刻意**不**做"填了 Key 就点绿"——填了 Key 不代表能用（模型名写错就是 HTTP 400）。
 */
function applyDot(dot: HTMLElement, record: EngineHealth | undefined): void {
  if (record === undefined) {
    dot.dataset.state = 'idle';
    dot.title = '从没测过（不代表可用）';
    return;
  }
  if (record.state === 'ok') {
    dot.dataset.state = 'ok';
    dot.title = '最近一次测试连接通过';
    return;
  }
  dot.dataset.state = 'bad';
  dot.title = `最近一次测试连接失败：${record.detail}`;
}

/**
 * 内置免费引擎那一行：名字 + 内置徽章 + 状态点 + 测试连接。
 * **没有删除、没有编辑**（§3.1：内置免费引擎不可删，也没有可编辑的配置）。
 * 它不带 `data-profile-id`：既有用例的 `profileRows()` 只数真实档案。
 *
 * 状态点读的是**保留键** `FREE_ENGINE_HEALTH_ID`，不是 `DEFAULT_ENGINE_ID`（见那里的说明：
 * 档案 id 可能是 `google`，共用键时免费行与档案行会互相点亮）。这一行没有任何取自 `ctx`
 * 的东西（配置是零配置、状态点来自会话记录），所以不接区块上下文。
 */
function buildFreeEngineRow(): HTMLElement {
  const engine = getEngine(DEFAULT_ENGINE_ID);
  const row = element('div', 'item');
  row.dataset.engineFree = '';

  const line = element('span', 'line');
  line.append(element('span', 'name', engine.name), element('span', 'badge', '内置'));
  const dot = element('span', 'dot');
  applyDot(dot, health[FREE_ENGINE_HEALTH_ID]);
  line.append(dot);

  const grow = element('span', 'grow');
  grow.append(line, element('span', 'meta', '无需 API Key'));
  row.append(grow);

  const test = element('button', 'ghost tiny', '测试连接');
  test.type = 'button';
  test.dataset.action = 'test-free';
  row.append(test);
  return row;
}

function buildEditor(id: string, profile: EngineProfile | undefined): HTMLElement {
  const editor = element('div', 'profile-editor');

  const labelField = element('label', 'field');
  labelField.append(element('span', 'lab', '名字'), Object.assign(document.createElement('input'), {
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
  providerField.append(element('span', 'lab', '服务商模板'), providerSelect);
  editor.append(providerField);

  const baseUrlField = element('label', 'field');
  baseUrlField.append(element('span', 'lab', '接口地址'), Object.assign(document.createElement('input'), {
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
  modelField.append(element('span', 'lab', '模型名'), Object.assign(document.createElement('input'), {
    className: 'profile-model-name',
    type: 'text',
    value: profile?.model ?? '',
    placeholder: 'gpt-4o-mini',
    autocomplete: 'off',
    spellcheck: false,
  }));
  editor.append(modelField);

  const keyField = element('label', 'field');
  keyField.append(element('span', 'lab', 'API Key'));
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
      className: 'ghost tiny profile-toggle-key',
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
    const deleteButton = element('button', 'link-danger', '删除档案');
    deleteButton.type = 'button';
    deleteButton.dataset.action = 'delete-profile';
    actions.append(deleteButton);
  }
  editor.append(actions);
  return editor;
}

function buildProfileRow(ctx: SectionContext, id: string): HTMLElement {
  const snapshot = ctx.settings() as Settings;
  const isNew = id === NEW_DRAFT_ID;
  const profile = snapshot.profiles.find((item) => item.id === id);
  if (!isNew && profile === undefined) {
    // 展开目标已被别处删除时 renderProfiles 会先收起草稿之外的 id；这条是防御性兜底：
    // 没有可渲染对象的行就是空壳，不抛错。
    return element('div', 'profile-row');
  }

  const expanded = expandedId === id;
  const row = element('div', 'profile-row item');
  row.dataset.profileId = id;

  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'profile-summary';
  summary.dataset.action = 'toggle';
  summary.setAttribute('aria-expanded', String(expanded));
  const shownBaseUrl = profile !== undefined && profile.baseUrl.length > 0 ? profile.baseUrl : '未填接口地址';
  const shownModel = profile !== undefined && profile.model.length > 0 ? profile.model : '未填模型名';
  const line = element('span', 'line');
  line.append(element('span', 'name', isNew ? '新档案（未保存）' : profile?.label ?? ''));
  if (!isNew && snapshot.engineId === id) {
    line.append(element('span', 'badge', '使用中'));
  }
  if (!isNew) {
    // 草稿行没有 id，也就没有"最近一次测试"可言——不给它一个永远灰的点。
    const dot = element('span', 'dot');
    applyDot(dot, health[id]);
    line.append(dot);
  }
  const grow = element('span', 'grow');
  grow.append(
    line,
    element('span', 'meta', isNew ? '未填接口地址 · 未填模型名' : `${shownBaseUrl} · ${shownModel}`),
  );
  summary.append(grow);
  row.append(summary);
  if (expanded) {
    row.append(buildEditor(id, isNew ? undefined : profile));
  }
  return row;
}

function renderProfiles(ctx: SectionContext): void {
  if (ctx.settings() === null) return;
  // 展开目标已不存在（比如刚删掉它）：收起，别让下一次渲染挂在一个幽灵 id 上。
  if (expandedId !== null && expandedId !== NEW_DRAFT_ID && !ctx.settings()!.profiles.some((p) => p.id === expandedId)) {
    expandedId = null;
  }
  profilesList.textContent = '';
  for (const profile of ctx.settings()!.profiles) {
    profilesList.append(buildProfileRow(ctx, profile.id));
  }
  if (expandedId === NEW_DRAFT_ID) {
    profilesList.append(buildProfileRow(ctx, NEW_DRAFT_ID));
  }
  // 内置免费引擎永远排在最后（§3.1：它不可删），每次重绘都跟着列表一起画。
  profilesList.append(buildFreeEngineRow());
}

/** 档案区顶部的说明：当前在用哪一档（选择器的真相在弹窗，这里如实指路）。 */
function renderEngineHint(ctx: SectionContext): void {
  const snapshot = ctx.settings();
  if (snapshot === null) return;
  const { engine } = resolveEngine(snapshot);
  const selected = snapshot.profiles.find((profile) => profile.id === snapshot.engineId);
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
 * 写之前**重新读一次**存储：`saveSettings` 是整份覆盖，Key 留空 = 保留**存储里当前**的那份
 * （不是页面打开时的快照）。真正的写回走 `ctx.save`，只交 `profiles` 这一个字段——
 * engineId 因此天然保持不动（选择档案是弹窗的职责，本页从不偷改它）。
 */
async function handleSaveProfile(ctx: SectionContext, id: string): Promise<void> {
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
    // Key 留空 = 保留存储里当前的那份（不是页面打开时的快照——整份覆盖的老坑同一个）。
    const apiKey = values.apiKey.trim().length > 0 ? values.apiKey : existing?.apiKey ?? '';
    const nextProfile: EngineProfile = { id: savedId, label: values.label, baseUrl: values.baseUrl, model: values.model, apiKey };
    profiles = existing === undefined ? [...latest.profiles, nextProfile] : latest.profiles.map((p) => (p.id === id ? nextProfile : p));
  }

  const saved = await ctx.save(engineStatus, '设置未能保存', { profiles });
  if (!saved) return;

  expandedId = savedId;
  renderProfiles(ctx);
  renderEngineHint(ctx);

  if (permission.state === 'denied') {
    // Key 与地址都已经存下来了：用户可能只是暂时不想授权。
    setStatus(engineStatus, 'err', `已保存档案「${values.label}」。${deniedHint(permission)}`);
    return;
  }
  const where = `，并已授权访问 ${originPattern(values.baseUrl) ?? values.baseUrl}`;
  setStatus(engineStatus, 'ok', `已保存档案「${values.label}」${where}。在弹窗的「翻译引擎」里选它即可使用。`);
}

/**
 * 真发一次极短请求并上报结果——档案与内置免费引擎**走同一条路**。
 * 抽出来的理由不是"少写几行"：状态点的记录、超时、错误码展开这三件事必须两处一致，
 * 各写一份必然漂移。
 *
 * `healthId` 为 `null` = **这次测试不落记录**（只有草稿行走这条：见 `recordHealth`）；
 * 其余调用方交的是档案 id 或免费引擎的保留键。
 */
async function runConnectionTest(
  ctx: SectionContext,
  healthId: string | null,
  engine: Translator,
  config: EngineConfig,
  label: string,
): Promise<void> {
  setStatus(engineStatus, 'pending', `正在用${label}翻译一次「${TEST_TEXT}」…`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const [translation] = await engine.translate(
      {
        texts: [TEST_TEXT],
        from: 'auto',
        to: ctx.settings()?.targetLang ?? DEFAULT_SETTINGS.targetLang,
        signal: controller.signal,
      },
      config,
    );
    // 成功路径也过一遍脱敏：状态行与记录一样，都不该出现那把 Key（返回的"译文"由服务商决定）。
    setStatus(engineStatus, 'ok', `连接成功：${TEST_TEXT} → ${redactSecret(translation ?? '', config.apiKey)}`);
    await recordHealth(ctx, healthId, { state: 'ok', detail: '' }, 'ok');
  } catch (raw) {
    // 错误码要显示出来（AUTH / RATE_LIMIT / NETWORK……）：它是用户判断"该改 Key 还是
    // 该稍后重试"的唯一依据，只给一句自然语言会把这两件事混在一起。
    const error = toEngineError(raw);
    // 详情来自服务商正文时可能回显请求内容（含 Key）：**显示与持久化是两条路径，两条都要脱敏**，
    // 所以在这一处把消息抹干净，下面两句共用它（`redactSecret` 见 `engine-health.ts`）。
    const message = redactSecret(error.message, config.apiKey);
    setStatus(engineStatus, 'err', `连接失败（${error.code}）：${message}`);
    await recordHealth(ctx, healthId, { state: 'bad', detail: `${error.code}：${message}` }, 'err');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 找某一行的状态点。档案行走 `data-profile-id`；**内置免费引擎那一行刻意没有 id**
 * （见 `buildFreeEngineRow`），所以只能按它自己的标记找。少了这一支，免费引擎的
 * 测试连接能成功、点却永远停在灰：`rowById` 只认档案行。
 *
 * 保留键这一支**必须排在 `rowById` 前面**：免费行的记录键与档案 id 是两个键空间，若先问
 * `rowById`，一条 id 恰好等于保留键的档案（脏存储/外部写入，`pickProfile` 不查保留字）就会把
 * 免费行的结果接到自己那一行上（症状与完整说明见 `FREE_ENGINE_HEALTH_ID` 的注释）。
 */
function healthDot(id: string): HTMLElement | null {
  const row =
    id === FREE_ENGINE_HEALTH_ID
      ? profilesList.querySelector<HTMLElement>('[data-engine-free]')
      : rowById(id);
  return row?.querySelector<HTMLElement>('.dot') ?? null;
}

/**
 * 记下这次测试的结果，并**就地**更新那一行的点（不整表重绘：重绘会把用户正在编辑的表单丢掉）。
 * 记录写不进去时，把原因**追加**在刚才那句话后面——本次测试的结果是真的，不该被它改掉颜色。
 *
 * `id === null` = **这次测试不落记录**，只有草稿行走这条（调用方见 `handleTestProfile`）：
 * 草稿行刻意**没有状态点**（`buildProfileRow` 不给它画点），也**没有清理出口**——只有真档案
 * 被删除才会 `forgetEngineHealth`，而草稿永远删不掉。给它写一条 `__new__` 记录就是留下一条
 * 谁也认领不了、也没人清理的幽灵键（实测改前：草稿点一次「测试连接」，会话存储里就多一条
 * `{"__new__":…}`）。连接结果本身照常写在状态行上，那才是用户当场要看的东西。
 */
async function recordHealth(
  ctx: SectionContext,
  id: string | null,
  record: EngineHealth,
  kind: StatusKind,
): Promise<void> {
  if (id === null) return;
  health = { ...health, [id]: record };
  const dot = healthDot(id);
  if (dot !== null) applyDot(dot, record);
  try {
    await saveEngineHealth(id, record);
  } catch (raw) {
    setStatus(engineStatus, kind, `${engineStatus.textContent ?? ''}（测试结果没能记住：${describe(raw)}）`);
  }
}

/**
 * 测试连接：**真的发一次翻译请求**，走的是生产引擎代码本身。测的是**这一行正在编辑的
 * 档案**（表单当前值，未保存也算），不是全局某份配置——多个档案时代"测一下"必须说得清测的是谁。
 */
async function handleTestProfile(ctx: SectionContext, id: string): Promise<void> {
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

  const permission = await ensureHostPermission(values.baseUrl);
  if (permission.state === 'denied') {
    setStatus(engineStatus, 'err', deniedHint(permission));
    return;
  }

  // Key 输入框留空时测的是**存储里已存的**那份（和"保存"同一语义）；新草稿没存过就是空，
  // 引擎会给出可行动的 AUTH 提示。
  const storedKey = ctx.settings()?.profiles.find((profile) => profile.id === id)?.apiKey ?? '';
  const apiKey = values.apiKey.trim().length > 0 ? values.apiKey : storedKey;
  const { engine, config } = resolveEngine({
    engineId: id,
    profiles: [{ id, label: values.label, baseUrl: values.baseUrl, model: values.model, apiKey }],
  });

  // 草稿行不落记录（`__new__` 既没有点可更新、也没有清理出口）：把 `null` 交给同一条路。
  await runConnectionTest(
    ctx,
    id === NEW_DRAFT_ID ? null : id,
    engine,
    config,
    `档案「${values.label}」`,
  );
}

/** 内置免费引擎的测试连接：没有表单值可读，配置就是空的（免费接口零配置）。 */
async function handleTestFreeEngine(ctx: SectionContext): Promise<void> {
  const { engine, config } = resolveEngine({ engineId: DEFAULT_ENGINE_ID, profiles: [] });
  // 记录写在**保留键**上，不是 `DEFAULT_ENGINE_ID`（见 `FREE_ENGINE_HEALTH_ID`）：
  // 档案 id 可以是 `google`，共用键时免费行的结果会点到用户档案那一行上。
  await runConnectionTest(ctx, FREE_ENGINE_HEALTH_ID, engine, config, `免费引擎「${engine.name}」`);
}

/**
 * 删除一个档案。若删的正是**当前在用**的那个，`engineId` 明确回落到免费接口并说明——
 * 绝不能留下一个指向不存在档案的 id。（为什么回落免费引擎而不是"下一个档案"：下一个
 * 档案可能没填 Key、地址可能没授权，删一个档案不该让用户突然翻译失败。）
 */
async function handleDeleteProfile(ctx: SectionContext, id: string): Promise<void> {
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
    expandedId = null;
    // 刷新**可能失败**（存储版本高于本代码、读写失败）：只有真的刷新成功才许说"列表已刷新"，
    // 否则界面会一边留着旧快照渲染出来的那一行、一边声称自己已经刷新过了。
    const refreshed = await renderFromStorage(ctx);
    if (refreshed) {
      setStatus(engineStatus, 'err', '该档案已经不在了（可能在别处被删除），列表已刷新。');
    }
    return;
  }
  const wasCurrent = latest.engineId === id;
  const remaining = latest.profiles.filter((profile) => profile.id !== id);

  const saved = await ctx.save(
    engineStatus,
    '设置未能保存',
    { profiles: remaining, engineId: wasCurrent ? DEFAULT_ENGINE_ID : latest.engineId },
  );
  if (!saved) return;

  if (expandedId === id) expandedId = null;
  renderProfiles(ctx);
  renderEngineHint(ctx);
  setStatus(
    engineStatus,
    'ok',
    wasCurrent
      ? `已删除当前在用的档案「${target.label}」，引擎已回落到「${getEngine(DEFAULT_ENGINE_ID).name}」，请在弹窗里重新选择。`
      : `已删除档案「${target.label}」。`,
  );
  // 它的测试记录一并清掉。内存里的那份**立刻**扔掉（在 `try` 之前）：否则界面下一次重绘
  // 还可能画出它的点。存储里那份删不掉只影响下次打开设置页，如实说一句就够。
  delete health[id];
  try {
    await forgetEngineHealth(id);
  } catch (raw) {
    setStatus(
      engineStatus,
      'ok',
      `${engineStatus.textContent ?? ''}（它的测试记录没清掉：${describe(raw)}）`,
    );
  }
}

/**
 * 把界面刷成**存储里的真实样子**（别处已经删掉/改过这个档案时的并发窗口用）。
 *
 * 返回**是否真的刷新成功**：失败时只写状态行并返回 `false`，**绝不继续渲染**。
 * 为什么不继续渲染：`ctx.reload()` 失败时快照仍是上一份成功读到的（`store.ts` 里那条
 * 有意为之的降级），拿它渲染出来的列表**已经不等于存储**——调用方若因此宣称"列表已刷新"，
 * 界面就在撒谎；而且那一行"幽灵档案"会被重新画回页面上。
 *
 * **这条不变式就是曾经的一个真 bug**（删档案撞上并发窗口时列表没刷新、提示却说刷新了）。
 */
async function renderFromStorage(ctx: SectionContext): Promise<boolean> {
  // 读的入口只有存储层一处（`store.ts` 的 `reload`）：这里刻意不自己 `loadSettings()` 之后
  // 偷偷改快照——那是存储层的职责，两处各改一份就又多了一条漂移路径。
  try {
    await ctx.reload();
  } catch (raw) {
    // 失败**就地消化**：原因写进状态行，然后 `return false` 让调用方闭嘴（不许说"已刷新"）。
    setStatus(engineStatus, 'err', `列表刷新失败：${describe(raw)}`);
    return false;
  }
  renderProfiles(ctx);
  renderEngineHint(ctx);
  return true;
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

export const engineSection: Section = {
  id: 'engine',
  title: '翻译引擎',
  aliases: ['引擎', '服务商', '档案', '接口地址', 'baseUrl', '模型', 'API Key', '密钥', 'key', '测试连接'],

  bind(ctx: SectionContext): void {
    // 档案列表是动态渲染的，行内按钮一律走**容器上的事件委托**（data-action 派发），
    // 每次重渲染不用重新挂监听器。
    profilesList.addEventListener('click', (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.classList.contains('profile-toggle-key')) {
        toggleKeyVisibility(target);
        return;
      }
      // 免费引擎那一行不在 `[data-profile-id]` 里，必须在行判断之前处理。
      if (target.dataset.action === 'test-free') {
        runSafely(engineStatus, '测试连接失败', () => handleTestFreeEngine(ctx));
        return;
      }
      const row = target.closest('[data-profile-id]');
      if (!(row instanceof HTMLElement)) return;
      const id = row.dataset.profileId as string;
      switch (target.dataset.action) {
        case 'toggle':
          if (ctx.settings() === null) return;
          expandedId = expandedId === id ? null : id;
          renderProfiles(ctx);
          break;
        case 'save-profile':
          runSafely(engineStatus, '保存失败', () => handleSaveProfile(ctx, id));
          break;
        case 'test-profile':
          runSafely(engineStatus, '测试连接失败', () => handleTestProfile(ctx, id));
          break;
        case 'delete-profile':
          runSafely(engineStatus, '删除失败', () => handleDeleteProfile(ctx, id));
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
      if (ctx.settings() === null) {
        setStatus(engineStatus, 'err', NOT_LOADED);
        return;
      }
      if (expandedId !== NEW_DRAFT_ID) {
        expandedId = NEW_DRAFT_ID;
        renderProfiles(ctx);
      }
    });
  },

  async mount(ctx: SectionContext): Promise<void> {
    try {
      health = await loadEngineHealth();
    } catch (raw) {
      // 读不出来不是致命错误：所有点回到"从没测过"，但要如实说一句。
      health = {};
      setStatus(engineStatus, 'err', `读取上次的测试结果失败：${describe(raw)}`);
    }
    renderProfiles(ctx);
    renderEngineHint(ctx);
  },
};
