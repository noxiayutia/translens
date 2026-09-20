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
// 2. `buildEditor` 造出来的控件 class（`.profile-label` / `.profile-api-key` /
//    `.profile-provider` / `.profile-base-url` / `.profile-toggle-key` / `.models-field` /
//    `.model-row` / `.profile-model-new`）是**契约**：`readEditor` / `validateProfileForm` /
//    `applyProviderTemplate` / `readModels` / `renderModels` / `toggleKeyVisibility` 与
//    `tests/options` 的 `fieldOf(editor, …)` 全都按这组名字找控件。改名要一起改（含测试），
//    否则运行时才炸、且是在点「保存」那一刻才炸。
// 3. 两个渲染函数的**数据来源不同，别混用**：`renderProfiles` 渲染的是**内存快照**
//    （`ctx.settings()`，可能与存储已经不一致）；`renderFromStorage` 是"先 `ctx.reload()`
//    重读存储、成功了再渲染"，并**返回是否真的刷新成功**。调用方只有在拿到 `true` 时才许宣称
//    "列表已刷新"——这条没写下来的后果就是一个真出现过的 bug：刷新失败时列表没换、提示却说换了。
//
// 本单元（C4）起档案行的版式是图二那一套：折叠行（名字 + 徽章 + 状态点 + 编辑/删除）+
// 展开面板（名字 / API Key / 可折叠的「自定义设置」/ 模型目录 / 测试连接·取消·保存）。
// **模型清单的编辑态住在 DOM 上**（与表单其它字段同一条口径）：`.model-row` 的顺序就是数组顺序，
// 带 `data-current` 的那一行就是当前模型。`readModels` 从 DOM 读回这一对，
// 不变量（`activeModel === '' || models.includes(activeModel)`）因此**按构造**成立。
// 有一处对参考图的**有意偏离**要记着：折叠行保留了次级 meta（地址 · 当前模型）——
// 5 个档案时"哪个档案打哪个地址、用哪个模型"是一眼就该看见的信息（规格 §6.1）。
import { getEngine, DEFAULT_ENGINE_ID } from '../../engines/registry';
import { toEngineError, type EngineConfig, type Translator } from '../../engines/types';
import {
  hasHostPermission,
  originPattern,
  requestHostPermission,
} from '../../shared/host-permission';
import { MSG, type FetchModelsResponse } from '../../shared/messages';
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
  FREE_ENGINE_HEALTH_KEY,
  forgetEngineHealth,
  loadEngineHealth,
  profileHealthKey,
  profileIdFromHealthKey,
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
  models: string[];
  activeModel: string;
  apiKey: string;
}

function rowById(id: string): HTMLElement | null {
  for (const child of Array.from(profilesList.children)) {
    if (child instanceof HTMLElement && child.dataset.profileId === id) return child;
  }
  return null;
}

/** 读展开区里的表单值。名字/地址去首尾空白；模型清单从 DOM 行读；Key 原样（判"填没填"时才 trim）。 */
function readEditor(editor: Element): ProfileFormValues {
  const { models, activeModel } = readModels(requireWithin<HTMLElement>(editor, '.models-field'));
  return {
    label: requireWithin<HTMLInputElement>(editor, '.profile-label').value.trim(),
    baseUrl: requireWithin<HTMLInputElement>(editor, '.profile-base-url').value.trim(),
    models,
    activeModel,
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
 * 而「保存」「测试连接」都是用户点下来的。已经授权过的不再弹框（先问 `contains`）。
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
  return `未授权访问该地址，翻译请求会被浏览器拦下${reason}。需要授权时再点一次「保存」并在弹窗里选「允许」。`;
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
 * 状态点读的是引擎键 `FREE_ENGINE_HEALTH_KEY`。它与档案键（`p:<id>`）按构造不可能相等，
 * 所以免费行与档案行**不会互相点亮**（见 `engine-health.ts` 里那两个键空间）。这一行也没有
 * 任何取自 `ctx` 的东西（配置是零配置、状态点来自会话记录），所以不接区块上下文。
 */
function buildFreeEngineRow(): HTMLElement {
  const engine = getEngine(DEFAULT_ENGINE_ID);
  const row = element('div', 'item');
  row.dataset.engineFree = '';

  const line = element('span', 'line');
  line.append(element('span', 'name', engine.name), element('span', 'badge', '内置'));
  const dot = element('span', 'dot');
  applyDot(dot, health[FREE_ENGINE_HEALTH_KEY]);
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

/**
 * 这个档案接的是不是内置模板里那几家？判据是 **`baseUrl` 与某个预设逐字相同**。
 *
 * 为什么不看模型清单：徽章回答的是"这个档案接的是哪一家"，地址是那个问题的唯一答案——
 * 用户把模型名改掉之后，地址仍然明明白白写着 DeepSeek。也不做尾斜杠 / 大小写归一化：
 * 判据越"聪明"，用户越难预测它什么时候亮。`custom` 预设没有 `baseUrl`，按构造不参与匹配。
 */
function isPresetProfile(profile: EngineProfile): boolean {
  return PROVIDER_PRESETS.some((preset) => preset.baseUrl !== undefined && preset.baseUrl === profile.baseUrl);
}

/** 折叠行的次级 meta：`接口地址 · 当前模型`。未填时各写一个占位——空着会被读成"没这回事"。 */
function metaTextOf(profile: EngineProfile | undefined): string {
  if (profile === undefined) return '未填接口地址 · 未选模型';
  const baseUrl = profile.baseUrl.length > 0 ? profile.baseUrl : '未填接口地址';
  const model = profile.activeModel.length > 0 ? profile.activeModel : '未选模型';
  return `${baseUrl} · ${model}`;
}

/** 模型清单的编辑态：行的顺序 = 数组顺序，带 `data-current` 的那一行 = 当前模型。 */
interface ModelsDraft {
  models: string[];
  activeModel: string;
}

/** 从 DOM 读回这一对。一行都没有时 `activeModel` 是空串——不变量按构造成立。 */
function readModels(field: Element): ModelsDraft {
  const models: string[] = [];
  let activeModel = '';
  for (const row of Array.from(field.querySelectorAll<HTMLElement>('.model-row'))) {
    const name = row.dataset.model as string;
    models.push(name);
    if (row.dataset.current !== undefined) activeModel = name;
  }
  return { models, activeModel };
}

/** 重绘清单区。**只重绘这一小块**（几行而已），外层的档案列表一行都不动。 */
function renderModels(field: Element, draft: ModelsDraft): void {
  const list = requireWithin<HTMLElement>(field, '.models-list');
  list.textContent = '';
  for (const name of draft.models) {
    const row = element('div', 'model-row');
    row.dataset.model = name;
    const current = name === draft.activeModel;
    if (current) row.dataset.current = '';
    row.append(element('span', 'model-name', name));
    if (current) row.append(element('span', 'badge', '当前'));

    const actions = element('span', 'model-actions');
    const use = element('button', 'ghost tiny', '设为当前');
    use.type = 'button';
    use.dataset.action = 'use-model';
    // 已经是当前项的那一行：按钮**存在但禁用**。禁用是诚实的（"这一项就是当前"），
    // 一个点了没反应的按钮不是。
    if (current) {
      use.disabled = true;
      use.title = '这一项已经是当前模型';
    }
    const remove = element('button', 'link-danger', '删除');
    remove.type = 'button';
    remove.dataset.action = 'remove-model';
    actions.append(use, remove);
    row.append(actions);
    list.append(row);
  }
  requireWithin<HTMLElement>(field, '.models-empty').hidden = draft.models.length > 0;
  // 每次重绘都收起手填行：加完就收，不留一个空输入框在页面上。
  requireWithin<HTMLElement>(field, '.model-new-row').hidden = true;
}

/** 展开区里的模型目录容器；编辑器不在页面上时返回 null（调用方各自决定说什么）。 */
function modelsFieldOf(id: string): HTMLElement | null {
  const editor = rowById(id)?.querySelector('.profile-editor');
  if (editor === null || editor === undefined) return null;
  return editor.querySelector<HTMLElement>('.models-field');
}

/** 手改过模型清单 → 这一行的模板下拉翻回「自定义」（与"手打地址"同一条口径）。 */
function markCustomTemplate(id: string): void {
  const editor = rowById(id)?.querySelector('.profile-editor');
  if (editor === null || editor === undefined) return;
  const provider = editor.querySelector<HTMLSelectElement>('.profile-provider');
  if (provider !== null) provider.value = 'custom';
}

/** 「+ 添加模型」：把清单区里那行手填输入框亮出来（输入框常驻 DOM、默认 hidden）。 */
function openModelInput(field: Element): void {
  requireWithin<HTMLElement>(field, '.model-new-row').hidden = false;
  requireWithin<HTMLInputElement>(field, '.profile-model-new').focus();
}

/**
 * 触发按钮的两种状态：文案与 `aria-expanded` **一起**设（分开写就会出现"文案说编辑、
 * 屏幕阅读器说已展开"这种自相矛盾）。`buildProfileRow` 与 `applyExpansion` 都走它。
 *
 * ⚠ 文案**就地改已有文本节点**，不重写 `textContent`：后者会把旧文本节点摘掉、再插一个新的，
 * 而 `applyExpansion` 对**每一行**都调本函数，于是"一次展开对 DOM 的 childList 改动量"变成
 * 1 + 2N——`engine-expansion.test.ts` 那条「单次展开的 DOM 改动量在 N=5/20/50 下都一样」实测
 * 读到 `[5, 6, 5]`（期望 `[5, 1, 0]`），正是它守着的"代价不随档案数增长"。
 * 就地改文本节点的内容不产生 childList 记录，读数回到 1/0。
 */
function applyTriggerState(trigger: Element, expanded: boolean): void {
  trigger.setAttribute('aria-expanded', String(expanded));
  const label = expanded ? '收起' : '编辑';
  const text = trigger.firstChild;
  if (text !== null && text.nodeType === Node.TEXT_NODE) text.nodeValue = label;
  else trigger.textContent = label;
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

  const keyField = element('label', 'field');
  keyField.append(element('span', 'lab', 'API Key'));
  const keyRow = element('span', 'key-row');
  keyRow.append(
    Object.assign(document.createElement('input'), {
      className: 'profile-api-key',
      type: 'password',
      // 隐私硬规矩：value 恒为空。存储里的 Key 不回填、不进 DOM；留空保存 = 保留原 Key。
      value: '',
      // 占位符只说"有没有"，不透露任何一位；已配置时告诉用户"填新的会替换掉旧的"。
      placeholder: (profile?.apiKey ?? '').length > 0 ? '已配置——输入新值可替换' : '还没配置，粘贴你的 API Key',
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

  // 「自定义设置」：默认折叠；**地址为空时展开**（规格 §6.2 第 3 条：地址与模板是唯二能把这个
  // 档案接上端点的控件，折叠起来会让首屏没有任何能填地址的地方）。模板是不是自定义**不**参与判断。
  const advanced = document.createElement('details');
  advanced.className = 'profile-advanced';
  advanced.open = (profile?.baseUrl ?? '').length === 0;
  advanced.append(element('summary', '', '自定义设置'));

  const providerField = element('label', 'field');
  const providerSelect = document.createElement('select');
  providerSelect.className = 'profile-provider';
  fillSelect(
    providerSelect,
    PROVIDER_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
    'custom',
  );
  providerField.append(element('span', 'lab', '服务商模板'), providerSelect);

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
  advanced.append(providerField, baseUrlField);
  editor.append(advanced);

  // 模型目录：右上角是"点它才请求"的拉取按钮，中间是清单，下面是虚线的添加按钮。
  const modelsField = element('div', 'field models-field');
  const modelsHead = element('span', 'models-head');
  modelsHead.append(element('span', 'lab', '模型目录'));
  const fetchButton = element('button', 'ghost tiny', '⟳ 获取可用模型');
  fetchButton.type = 'button';
  fetchButton.dataset.action = 'fetch-models';
  modelsHead.append(fetchButton);
  modelsField.append(modelsHead, element('div', 'models-list'));

  const newRow = element('span', 'model-new-row');
  newRow.hidden = true;
  const newInput = Object.assign(document.createElement('input'), {
    className: 'profile-model-new',
    type: 'text',
    value: '',
    placeholder: '手填模型名，例如 gpt-4o-mini',
    autocomplete: 'off',
    spellcheck: false,
  });
  const confirmButton = element('button', 'ghost tiny', '添加');
  confirmButton.type = 'button';
  confirmButton.dataset.action = 'confirm-model';
  const cancelModelButton = element('button', 'link-danger', '取消');
  cancelModelButton.type = 'button';
  cancelModelButton.dataset.action = 'cancel-model';
  newRow.append(newInput, confirmButton, cancelModelButton);

  const addButton = element('button', 'add', '+ 添加模型');
  addButton.type = 'button';
  addButton.dataset.action = 'add-model';
  modelsField.append(addButton, newRow);

  // 清单为空时才显示的那句说明：**每一句都为真**（规格 §6.2 第 4 条）。
  const empty = element('p', 'hint models-empty');
  empty.textContent =
    '清单为空时，弹窗里不显示模型下拉——点「添加模型」手填一个即可；拉取到的清单会先让你勾选，再并入这里。' +
    '清单只有一项时弹窗也不显示下拉，直接用那一项；两项以上才会出现下拉。';
  modelsField.append(empty);

  // 拉取结果的勾选清单（默认不显示、默认全不选）。
  const fetched = element('div', 'models-fetched');
  fetched.hidden = true;
  modelsField.append(fetched);

  editor.append(modelsField);
  renderModels(modelsField, { models: profile?.models ?? [], activeModel: profile?.activeModel ?? '' });

  const actions = element('div', 'actions');
  const testButton = element('button', 'ghost', '测试连接');
  testButton.type = 'button';
  testButton.dataset.action = 'test-profile';
  const cancelButton = element('button', 'ghost', '取消');
  cancelButton.type = 'button';
  cancelButton.dataset.action = 'cancel-profile';
  const saveButton = element('button', 'primary', '保存');
  saveButton.type = 'button';
  saveButton.dataset.action = 'save-profile';
  // 左「测试连接」、右「取消 / 保存」（图二的底部按钮行 + 我们保留的测试连接）。
  actions.append(testButton, element('span', 'grow'), cancelButton, saveButton);
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

  const line = element('span', 'line');
  line.append(element('span', 'name', isNew ? '新档案（未保存）' : profile?.label ?? ''));
  if (!isNew && snapshot.engineId === id) {
    line.append(element('span', 'badge', '使用中'));
  }
  if (!isNew && profile !== undefined && !isPresetProfile(profile)) {
    // 「自定义」= 这个档案接的不是内置模板里那几家（判据是地址，见 isPresetProfile）。
    const custom = element('span', 'badge badge-muted', '自定义');
    custom.dataset.template = 'custom';
    line.append(custom);
  }
  if (!isNew) {
    // 草稿行没有 id，也就没有"最近一次测试"可言——不给它一个永远灰的点。
    const dot = element('span', 'dot');
    applyDot(dot, health[profileHealthKey(id)]);
    line.append(dot);
  }
  const grow = element('span', 'grow');
  grow.append(line, element('span', 'meta', isNew ? '未填接口地址 · 未选模型' : metaTextOf(profile)));

  // 行级按钮：整行**不再是按钮**（行里现在有「删除」，整行可点会把删除变成一次误触）。
  const rowActions = element('span', 'row-actions');
  const edit = element('button', 'ghost tiny', '编辑');
  edit.type = 'button';
  edit.dataset.action = 'toggle';
  applyTriggerState(edit, expanded);
  rowActions.append(edit);
  if (!isNew) {
    const remove = element('button', 'link-danger', '删除');
    remove.type = 'button';
    remove.dataset.action = 'delete-profile';
    remove.title = '删除这个档案';
    rowActions.append(remove);
  }

  row.append(grow, rowActions);
  if (expanded) row.append(buildEditor(id, isNew ? undefined : profile));
  return row;
}

/**
 * 每行的**未保存编辑暂存**（内存，key = 档案 id 或 `NEW_DRAFT_ID`）。
 *
 * 为什么需要它：收起编辑器 = 把 `.profile-editor` 从 DOM 里摘掉，而输入值只住在那些节点上。
 * 用户去点另一个档案的「编辑」看一眼、再点回来，刚敲的东西就没了——**这是旧实现就有的行为**
 * （实测：真档案行一样丢），C0 之后又多了一种形态（草稿行不再整行消失，但值照样丢）。
 *
 * 语义（规格 §9 第 19 条，三支互不覆盖）：
 * - **隐式收起**（点别的行 / 点本行收起 / 切到草稿行）：存下当前 DOM 的值，重新展开时先填暂存；
 * - **`取消`**：删掉这一行的暂存（那是它的定义："丢弃这次编辑"）；
 * - **`保存` 成功** / **行被删除**：删掉这一行（草稿保存后 id 会变，两个键都清）。
 *
 * ⚠ **这不是自动保存**：暂存只在内存里，关掉设置页就没了，也永远不会被静默写进存储
 *   （半填的档案绝不入库）。
 *
 * ⚠ **它搬 Key，而且是唯一一处**：暂存里那一格是"用户刚在这个输入框里敲的值"，不是存储里那份
 *   ——隐私硬规矩（存储里的 Key 不回填、不进 DOM）一字未改，只是用户自己敲进去的字不该因为
 *   他点了一下别的行就蒸掉。`restoreEditor` 把它写回 `.value` 时输入框仍然是 `password`。
 *
 * **刻意不做**：这里没有"扫一遍删掉孤儿暂存"的清理。那种清理**写不出读数**（谁也说不出少了它
 * 会怎样），而三个显式清点各有用例。孤儿条目只是内存里几十字节，且 id 带随机段、不会复用。
 */
const editorDrafts = new Map<string, ProfileFormValues>();

/** 收起**之前**把这一行 DOM 里的值存下来。读不出来（控件缺失）就什么都不存：宁可不暂存，也不留个坏值。 */
function stashEditor(id: string, editor: Element): void {
  try {
    editorDrafts.set(id, readEditor(editor));
  } catch {
    editorDrafts.delete(id);
  }
}

/** 展开时把暂存填回新造的编辑器；没有暂存就什么都不做（表单保持快照的值）。 */
function restoreEditor(id: string, editor: Element): void {
  const draft = editorDrafts.get(id);
  if (draft === undefined) return;
  requireWithin<HTMLInputElement>(editor, '.profile-label').value = draft.label;
  requireWithin<HTMLInputElement>(editor, '.profile-base-url').value = draft.baseUrl;
  requireWithin<HTMLInputElement>(editor, '.profile-api-key').value = draft.apiKey;
  // 模型清单住在 DOM 行上，所以"恢复清单"就是把清单区按暂存重画一遍。
  renderModels(requireWithin<HTMLElement>(editor, '.models-field'), {
    models: draft.models,
    activeModel: draft.activeModel,
  });
}

/**
 * 展开 / 收起只动受影响的那一两行。
 *
 * 为什么不是 `renderProfiles(ctx)`：那个函数开头清空整张列表再重建（档案行 + 免费引擎行），
 * 于是**每次点开一个档案都要重建 N+1 行**——代价随档案数线性增长，用户点一下要等。
 * 展开只改三件东西：这一行触发按钮的 `aria-expanded` 与文案、这一行里**有没有**
 * `.profile-editor`、以及摘/插编辑器前后各一次暂存的读与写。列表结构、行顺序、免费引擎行、
 * 其它行通通不动。
 *
 * `renderProfiles` 只留给"数据真的变了"的路径：挂载、保存后、删除后、重载。
 */
function applyExpansion(ctx: SectionContext): void {
  const snapshot = ctx.settings();
  if (snapshot === null) return;
  for (const row of Array.from(profilesList.querySelectorAll<HTMLElement>('.profile-row[data-profile-id]'))) {
    const id = row.dataset.profileId as string;
    const expanded = id === expandedId;
    const trigger = row.querySelector('[data-action="toggle"]');
    if (trigger !== null) applyTriggerState(trigger, expanded);
    const existing = row.querySelector('.profile-editor');
    if (expanded && existing === null) {
      const profile = id === NEW_DRAFT_ID ? undefined : snapshot.profiles.find((item) => item.id === id);
      const editor = buildEditor(id, profile);
      // **先恢复暂存、再插进 DOM**：用户看到的第一帧就是他离开时的样子，不会闪一下空表单。
      restoreEditor(id, editor);
      row.append(editor);
    } else if (!expanded && existing !== null) {
      // 收起 = 把编辑器摘掉。**摘之前先把值存进暂存**，否则用户敲的东西随节点一起没了
      // （"一次只展开一个"的执行点就是这一句）。
      stashEditor(id, existing);
      existing.remove();
    }
  }
}

/**
 * 只追加「新档案（未保存）」那一行，不动其余行。
 * 草稿行永远排在免费引擎行**之前**（与 `renderProfiles` 的追加顺序一致）。
 */
function insertDraftRow(ctx: SectionContext): void {
  if (rowById(NEW_DRAFT_ID) !== null) return;
  const row = buildProfileRow(ctx, NEW_DRAFT_ID);
  const free = profilesList.querySelector('[data-engine-free]');
  if (free === null) profilesList.append(row);
  else free.before(row);
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
    engineHint.textContent = `当前在用档案「${selected.label}」。点这一行右侧的「编辑」展开；在弹窗的「翻译引擎」里按名字切换。`;
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
    profiles = [
      ...latest.profiles,
      {
        id: savedId,
        label: values.label,
        baseUrl: values.baseUrl,
        models: values.models,
        activeModel: values.activeModel,
        apiKey: values.apiKey,
      },
    ];
  } else {
    savedId = id;
    const existing = latest.profiles.find((profile) => profile.id === id);
    // Key 留空 = 保留存储里当前的那份（不是页面打开时的快照——整份覆盖的老坑同一个）。
    const apiKey = values.apiKey.trim().length > 0 ? values.apiKey : existing?.apiKey ?? '';
    const nextProfile: EngineProfile = {
      id: savedId,
      label: values.label,
      baseUrl: values.baseUrl,
      models: values.models,
      activeModel: values.activeModel,
      apiKey,
    };
    profiles = existing === undefined ? [...latest.profiles, nextProfile] : latest.profiles.map((p) => (p.id === id ? nextProfile : p));
  }

  const saved = await ctx.save(engineStatus, '设置未能保存', { profiles });
  if (!saved) return;

  // 保存成功 = 这次编辑会话结束：清掉这一行的暂存。
  // ⚠ **这两行都杀不死任何用例**（实测：整份删掉任一格 → 全量 55 files / 1043 passed 仍全绿）：
  // - `savedId` 那一格：保存成功后 `renderProfiles` 按新快照重建这一行，而 `applyExpansion`
  //   不会对已展开的行调 `restoreEditor`——残留的那一格没有读取路径。
  // - `NEW_DRAFT_ID` 那一格：**看着**该由「草稿保存成功后清掉草稿暂存」那条用例守住，其实不然——
  //   下一次点「新增档案」时 `bind` 先把 `expandedId` 落成 `NEW_DRAFT_ID`，`buildProfileRow`
  //   于是**直接在行里造好编辑器**；`applyExpansion` 见 `existing !== null` 就不再走
  //   `restoreEditor`，残留的那一格因此从来没被读过（用例读到的是"新造的编辑器本来就是空的"）。
  // 留着它们的理由只剩"一条暂存不该活得比它对应的编辑会话更久"这条**状态卫生**，
  // 不是"有用例守着"——别为它编一条读不到的断言（与 `delete(savedId)` 同一个桶）。
  editorDrafts.delete(savedId);
  editorDrafts.delete(NEW_DRAFT_ID);

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
 * `healthKey` 为 `null` = **这次测试不落记录**（只有草稿行走这条：见 `recordHealth`）；
 * 其余调用方交的是 `profileHealthKey(id)` 或免费引擎的 `FREE_ENGINE_HEALTH_KEY`。
 */
async function runConnectionTest(
  ctx: SectionContext,
  healthKey: string | null,
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
    await recordHealth(healthKey, { state: 'ok', detail: '' }, 'ok');
  } catch (raw) {
    // 错误码要显示出来（AUTH / RATE_LIMIT / NETWORK……）：它是用户判断"该改 Key 还是
    // 该稍后重试"的唯一依据，只给一句自然语言会把这两件事混在一起。
    const error = toEngineError(raw);
    // 详情来自服务商正文时可能回显请求内容（含 Key）：**显示与持久化是两条路径，两条都要脱敏**，
    // 所以在这一处把消息抹干净，下面两句共用它（`redactSecret` 见 `engine-health.ts`）。
    const message = redactSecret(error.message, config.apiKey);
    setStatus(engineStatus, 'err', `连接失败（${error.code}）：${message}`);
    await recordHealth(healthKey, { state: 'bad', detail: `${error.code}：${message}` }, 'err');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 记录键 → 该去哪一行找点。**两个键空间的划分只有这一处**：引擎键 → 免费引擎那一行；
 * 档案键（`p:<id>`）→ 按 `data-profile-id` 找 `<id>` 那一行。
 *
 * 为什么这里不需要"键序"：键自带前缀，前缀决定去哪一行，**按构造**不存在"一个字符串既可能
 * 是档案 id、又可能是引擎键"的形状。旧写法（先 `rowById(id)`、找不到再回落免费行）正是被
 * 档案 id 抢先的那条路：一条 id 恰好等于引擎键的档案会把免费行的结果接到自己那一行上。
 * 不认识的键返回 `null` 是防御性的一支（本函数只接调用方刚拼出来的键）；老构建写下的裸 id
 * 也根本到不了这里——所有读取处一律按新键取，这正是"不写迁移"的口径。唯一会被老键命中的形状
 * 是 `p:<id>` 那种（只能来自手改存储）：读取处按 `p:<id>` 取值，id 对上的档案行就会认领它；
 * 例外与取舍的完整说明在 `engine-health.ts` 的迁移那一段。
 */
function rowForKey(key: string): HTMLElement | null {
  if (key === FREE_ENGINE_HEALTH_KEY) {
    return profilesList.querySelector<HTMLElement>('[data-engine-free]');
  }
  const id = profileIdFromHealthKey(key);
  return id === null ? null : rowById(id);
}

/**
 * 找某一行的状态点。档案行走 `data-profile-id`；**内置免费引擎那一行刻意没有 id**
 * （见 `buildFreeEngineRow`），所以只能按它自己的标记找（`rowForKey` 分派）。
 */
function healthDot(key: string): HTMLElement | null {
  return rowForKey(key)?.querySelector<HTMLElement>('.dot') ?? null;
}

/**
 * 记下这次测试的结果，并**就地**更新那一行的点（不整表重绘：重绘会把用户正在编辑的表单丢掉）。
 * 记录写不进去时，把原因**追加**在刚才那句话后面——本次测试的结果是真的，不该被它改掉颜色。
 *
 * `key === null` = **这次测试不落记录**，只有草稿行走这条（调用方见 `handleTestProfile`）：
 * 草稿行刻意**没有状态点**（`buildProfileRow` 不给它画点），也**没有清理出口**——只有真档案
 * 被删除才会 `forgetEngineHealth`，而草稿永远删不掉。给它写一条记录就是留下一条谁也认领不了、
 * 也没人清理的幽灵键（实测改前：草稿点一次「测试连接」，会话存储里就多一条 `{"__new__":…}`）。
 * 连接结果本身照常写在状态行上，那才是用户当场要看的东西。
 *
 * 交进来的 `key` 是**已经分好键空间**的记录键（`profileHealthKey` / `FREE_ENGINE_HEALTH_KEY`），
 * 不再兼作 DOM 上的档案 id：行由 `rowForKey` 从键推出来（键 → 行只有一处判断）。
 */
async function recordHealth(
  key: string | null,
  record: EngineHealth,
  kind: StatusKind,
): Promise<void> {
  if (key === null) return;
  health = { ...health, [key]: record };
  const dot = healthDot(key);
  if (dot !== null) applyDot(dot, record);
  try {
    await saveEngineHealth(key, record);
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

  const storedProfile = ctx.settings()?.profiles.find((profile) => profile.id === id);
  // Key 输入框留空时测的是**存储里已存的**那份（和"保存"同一语义）；新草稿没存过就是空，
  // 引擎会给出可行动的 AUTH 提示。
  const apiKey = values.apiKey.trim().length > 0 ? values.apiKey : storedProfile?.apiKey ?? '';
  const { engine, config, problem } = resolveEngine({
    engineId: id,
    profiles: [
      {
        id,
        label: values.label,
        baseUrl: values.baseUrl,
        models: values.models,
        activeModel: values.activeModel,
        apiKey,
      },
    ],
  });
  // 没有当前模型：把规格 §3.3 那句话**就地**显示出来（与翻译路径同一条口径）。这一支改的是
  // **文案与粒度**：用户看到的是"还没有模型，点「添加模型」"，而不是引擎那句通用 AUTH。
  // ⚠ **零请求不是这道闸保证的**：`src/engines/openai-compat.ts` 里的 `if (!model) throw` 按构造
  // 就挡在 `fetch` 之前。实测（删掉这一支）：用例里 `fetchSpy` 仍然 0 次调用，红的只有文案断言
  // `expected '连接失败（AUTH）：尚未填写模型名，请在设置中配置' to contain '还没有模型'`——
  // 所以那条用例的杀手是 `toContain('还没有模型')`，别把它读成"少发一次请求的守卫"。
  if (problem !== undefined) {
    setStatus(engineStatus, 'err', problem);
    return;
  }

  // 草稿行不落记录（`__new__` 既没有点可更新、也没有清理出口）：把 `null` 交给同一条路。
  // 其余情况交的是**档案键**（不是裸 id）——键空间的分法只有 `engine-health.ts` 一处。
  await runConnectionTest(
    ctx,
    id === NEW_DRAFT_ID ? null : profileHealthKey(id),
    engine,
    config,
    `档案「${values.label}」`,
  );
}

/** 内置免费引擎的测试连接：没有表单值可读，配置就是空的（免费接口零配置）。 */
async function handleTestFreeEngine(ctx: SectionContext): Promise<void> {
  const { engine, config } = resolveEngine({ engineId: DEFAULT_ENGINE_ID, profiles: [] });
  // 记录写在**引擎键**上，不是档案那一格（见 `engine-health.ts` 的两个键空间）：
  // 就算某个档案的 id 恰好等于这个键，它的记录键也是 `p:` 开头的另一个字符串。
  await runConnectionTest(ctx, FREE_ENGINE_HEALTH_KEY, engine, config, `免费引擎「${engine.name}」`);
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
    // 它的暂存也跟着走：档案都不在了，留着这一格只会在同一个 id 被重新造出来时把旧草稿带回来。
    editorDrafts.delete(id);
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

  // 档案没了，它的暂存也不该留（同一个 id 不会复用，但"删了还留着"本身就是没道理的）。
  editorDrafts.delete(id);
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
  // 删的必须是它的**档案键**（`p:<id>`）：留空或删裸 id 都会让它下次重绘时又亮起来。
  delete health[profileHealthKey(id)];
  try {
    await forgetEngineHealth(profileHealthKey(id));
  } catch (raw) {
    setStatus(
      engineStatus,
      'ok',
      `${engineStatus.textContent ?? ''}（它的测试记录没清掉：${describe(raw)}）`,
    );
  }
}

/**
 * 手填一个模型并加进清单。两条判据：**空值与重复值不写入**。
 * 添加成功的那一项**即设为当前**：用户加一个模型几乎总是为了用它；不设当前的话，档案会停在
 * "还没有模型"（§3.3），他还要再点一次「设为当前」。
 */
function handleAddModel(id: string): void {
  const field = modelsFieldOf(id);
  if (field === null) {
    setStatus(engineStatus, 'err', '档案编辑区不在页面上，请重新展开该档案');
    return;
  }
  const input = requireWithin<HTMLInputElement>(field, '.profile-model-new');
  const name = input.value.trim();
  if (name.length === 0) {
    setStatus(engineStatus, 'err', '模型名不能为空——填一个服务商认得的名字再加。');
    return;
  }
  const draft = readModels(field);
  if (draft.models.includes(name)) {
    setStatus(engineStatus, 'err', `清单里已经有「${name}」了，没有重复添加。`);
    return;
  }
  input.value = '';
  renderModels(field, { models: [...draft.models, name], activeModel: name });
  markCustomTemplate(id);
  setStatus(engineStatus, 'ok', `已加入「${name}」并设为当前模型。记得点「保存」。`);
}

/** 「设为当前」：只换当前项，清单本身不动。 */
function handleUseModel(id: string, name: string): void {
  const field = modelsFieldOf(id);
  if (field === null) return;
  renderModels(field, { models: readModels(field).models, activeModel: name });
  setStatus(engineStatus, 'ok', `当前模型改成了「${name}」。记得点「保存」。`);
}

/**
 * 从清单里删掉一个模型。**删的正是当前模型时自愈**（§3.1）：取剩下的最后一个；清单空了就置 ''。
 * 不变量因此永远成立——读取边界（`pickProfile`）是同一套规则的第二道。
 */
function handleRemoveModel(id: string, name: string): void {
  const field = modelsFieldOf(id);
  if (field === null) return;
  const draft = readModels(field);
  const models = draft.models.filter((item) => item !== name);
  const last = models.length > 0 ? (models[models.length - 1] as string) : '';
  const activeModel = draft.activeModel === name ? last : draft.activeModel;
  renderModels(field, { models, activeModel });
  markCustomTemplate(id);

  if (draft.activeModel !== name) {
    setStatus(engineStatus, 'ok', `已从清单里移除「${name}」。记得点「保存」。`);
    return;
  }
  if (activeModel.length > 0) {
    setStatus(engineStatus, 'ok', `已移除当前模型「${name}」，当前模型改成了「${activeModel}」。记得点「保存」。`);
    return;
  }
  setStatus(
    engineStatus,
    'err',
    `已移除最后一个模型「${name}」——这个档案现在没有模型，翻译会给一句可读的错误（不会发请求）。记得点「保存」。`,
  );
}

/**
 * 「取消」= **显式丢弃**这一行的编辑。
 *
 * 为什么不需要撤销栈：编辑值只住在 DOM 与那一格内存暂存里（保存才写存储），所以"丢弃"
 * 就是两件事——**删掉这一行的暂存**，再把编辑器从行里摘掉（`applyExpansion` 做后者）。
 * 少了"删暂存"那一句，收起时写的暂存会在下次展开时把刚被取消的草稿填回来（用例当场红）。
 *
 * 它也不可能顺手把别的行、别的字段一起丢掉。
 * 草稿行没有存储里对应的东西：取消它就把整行移除（否则会留下一个收起的空壳），并清掉它的暂存。
 */
function handleCancelProfile(ctx: SectionContext, id: string): void {
  if (id === NEW_DRAFT_ID) {
    // 草稿行没有存储里对应的东西：取消它就把整行移除（否则会留下一个收起的空壳），并清掉它的暂存。
    editorDrafts.delete(id);
    expandedId = null;
    rowById(NEW_DRAFT_ID)?.remove();
    setStatus(engineStatus, 'ok', '已取消这个新档案，它没有被保存过。');
    return;
  }
  if (expandedId === id) expandedId = null;
  applyExpansion(ctx);
  // 这一句是"取消"与"隐式收起"的分界：隐式收起**保留**暂存，取消**清掉**它。
  // ⚠ 它必须排在 `applyExpansion` **之后**：收起那一刻会先写一次暂存（那是隐式收起的语义），
  // 而"取消"的定义是**丢弃**——清暂存因此是这条路径的最后一句话。写在前面会被那次
  // `stashEditor` 立刻填回来（实测：清在前时用例读到 `改过的名字`，而存储里是 `原名字`）。
  editorDrafts.delete(id);
  setStatus(engineStatus, 'ok', '已取消这次编辑，存储里的内容一个字节都没动。');
}

/**
 * 「⟳ 获取可用模型」：**点它才请求**（§5.4）。消息里只有一个 `profileId`——
 * 后台按它自己从存储读 baseUrl / apiKey（§5.1），**面板里还没保存的改动不参与**。
 */
async function handleFetchModels(ctx: SectionContext, id: string): Promise<void> {
  const editor = rowById(id)?.querySelector('.profile-editor');
  if (editor === null || editor === undefined) {
    setStatus(engineStatus, 'err', '档案编辑区不在页面上，请重新展开该档案');
    return;
  }
  const profile = ctx.settings()?.profiles.find((item) => item.id === id);
  if (profile === undefined) {
    setStatus(engineStatus, 'err', '新档案还没保存过：先把名字、接口地址与 Key 填好，点一次「保存」，再来拉取。');
    return;
  }
  setStatus(engineStatus, 'pending', `正在向 ${profile.baseUrl} 请求模型清单…`);

  let response: FetchModelsResponse | undefined;
  try {
    response = (await chrome.runtime.sendMessage({
      type: MSG.FETCH_MODELS,
      payload: { profileId: id },
    })) as FetchModelsResponse | undefined;
  } catch (raw) {
    // 没有接收方（SW 刚被回收 / 扩展刚更新过）与"后台内部报错"在这里是同一种形状，如实说。
    setStatus(engineStatus, 'err', `拉取模型清单失败：${describe(raw)}。仍然可以用「添加模型」手填。`);
    return;
  }
  if (response === undefined) {
    setStatus(engineStatus, 'err', '拉取模型清单失败：后台没有响应。仍然可以用「添加模型」手填。');
    return;
  }
  if (!response.ok) {
    // 后台那句已经是"发生了什么 + 你能做什么"，原样显示（两处各写一句必然漂移）。
    setStatus(engineStatus, 'err', response.message);
    return;
  }
  if (response.models.length === 0) {
    setStatus(engineStatus, 'err', '这个地址没有给出可用的模型清单——不是所有服务商都实现了它。请用「添加模型」手填。');
    return;
  }
  renderFetchedModels(editor, response.models);
  setStatus(engineStatus, 'ok', `拿到了 ${response.models.length} 个模型名，勾选后点「并入清单」。`);
}

/** 拉取结果的勾选清单（默认**全不选**）：勾完点「并入清单」才会动上面的模型清单。 */
function renderFetchedModels(editor: Element, names: string[]): void {
  const box = requireWithin<HTMLElement>(editor, '.models-fetched');
  box.textContent = '';
  for (const name of names) {
    const label = element('label', 'fetched-row');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'profile-model-pick';
    checkbox.value = name;
    checkbox.checked = false;
    // 用户数据一律 textContent，不进 HTML 解析（规格 §7）。
    label.append(checkbox, element('span', 'fetched-name', name));
    box.append(label);
  }
  const merge = element('button', 'ghost tiny', '并入清单');
  merge.type = 'button';
  merge.dataset.action = 'merge-models';
  const cancel = element('button', 'link-danger', '取消');
  cancel.type = 'button';
  cancel.dataset.action = 'cancel-fetched';
  box.append(merge, cancel);
  box.hidden = false;
}

/**
 * 把勾上的模型名并入清单（去重）。
 * **只有当清单原本为空时**才把并入的第一项设为当前：清单非空时不动用户已经选好的那一个。
 */
function handleMergeModels(id: string): void {
  const editor = rowById(id)?.querySelector('.profile-editor');
  if (editor === null || editor === undefined) return;
  const field = requireWithin<HTMLElement>(editor, '.models-field');
  const box = requireWithin<HTMLElement>(editor, '.models-fetched');
  const picked = Array.from(box.querySelectorAll<HTMLInputElement>('.profile-model-pick'))
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.value);
  if (picked.length === 0) {
    setStatus(engineStatus, 'err', '一个都没勾：先勾上要加进来的模型，再点「并入清单」。');
    return;
  }
  const draft = readModels(field);
  const models = [...draft.models];
  for (const name of picked) if (!models.includes(name)) models.push(name);
  const activeModel = draft.activeModel.length > 0 ? draft.activeModel : (picked[0] as string);
  renderModels(field, { models, activeModel });
  markCustomTemplate(id);
  box.hidden = true;
  box.textContent = '';
  setStatus(engineStatus, 'ok', `已并入 ${picked.length} 个模型名（重复的不再追加）。记得点「保存」。`);
}

/** 收起拉取结果（不动清单）。 */
function handleCancelFetched(id: string): void {
  const editor = rowById(id)?.querySelector('.profile-editor');
  if (editor === null || editor === undefined) return;
  const box = editor.querySelector<HTMLElement>('.models-fetched');
  if (box === null) return;
  box.hidden = true;
  box.textContent = '';
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
 * 服务商模板 = 编辑表单的**填写捷径**：选中即把接口地址填进**这一行**，把该模板的模型名
 * 并入模型清单并设为当前。用户还没点保存，改回来零成本。不碰 API Key（那是用户自己的凭据）。
 * 只挂在下拉自己的 change 上——展开既有档案时**永远不重放**预设（否则会把用户存过的
 * 地址/模型悄悄改回模板值）。
 */
function applyProviderTemplate(editor: Element): void {
  const select = requireWithin<HTMLSelectElement>(editor, '.profile-provider');
  const preset = PROVIDER_PRESETS.find((entry) => entry.id === select.value);
  if (preset === undefined || preset.baseUrl === undefined || preset.model === undefined) return;
  requireWithin<HTMLInputElement>(editor, '.profile-base-url').value = preset.baseUrl;
  const field = editor.querySelector<HTMLElement>('.models-field');
  if (field === null) return;
  const draft = readModels(field);
  const models = draft.models.includes(preset.model) ? draft.models : [...draft.models, preset.model];
  renderModels(field, { models, activeModel: preset.model });
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
      // ⚠ 动作要取**最近的 `[data-action]` 祖先**，不能读 `event.target.dataset.action`。
      // 真机缺陷（`7991539` 修的）：行头当时是 `<button class="profile-summary">` **里面包着**
      // `<span class="name">` / `<span class="meta">`，点在文字上时 target 是那些 span ——
      // 读 target 会得到 undefined，于是"点名字没反应、只有点在按钮空白处才有反应"。
      // 真机读数（临时探针，5 次点击）：4 次 `action="(none)"`，target 分别是
      // `span.meta`/`span.grow`；页面只有 294 个节点、点一次 3~7ms，所以那不是性能问题。
      //
      // C4 之后行级控件都是**叶子按钮**（行头不再是按钮，只有 `.grow` + `.row-actions`），
      // 这条口径照旧留着：控件里将来加图标 / 文案子元素时，取的仍然该是那个控件本身。
      //
      // Key 显示/隐藏必须**先判**（它自己不带 `data-action`，但它整条支路都在这一个按钮上）：
      // 交给 `toggleKeyVisibility` 的必须是那个按钮本身，不是它未来的子元素——文案与
      // `aria-pressed` 写在按钮上，写到子元素上等于把按钮文字抹掉。
      const keyToggle = target.closest<HTMLElement>('.profile-toggle-key');
      if (keyToggle !== null) {
        toggleKeyVisibility(keyToggle);
        return;
      }
      const actionEl = target.closest<HTMLElement>('[data-action]');
      const action = actionEl?.dataset.action ?? null;
      // 免费引擎那一行不在 `[data-profile-id]` 里，必须在行判断之前处理。
      if (action === 'test-free') {
        runSafely(engineStatus, '测试连接失败', () => handleTestFreeEngine(ctx));
        return;
      }
      const row = target.closest('[data-profile-id]');
      if (!(row instanceof HTMLElement)) return;
      // 动作元素必须落在这一行里，别让嵌套/无关的 `[data-action]` 串到别的行上。
      if (actionEl === null || !row.contains(actionEl)) return;
      const id = row.dataset.profileId as string;
      // 模型行内那两个动作要带上"哪一项"：模型名住在最近的那个 `.model-row` 的 dataset 上。
      const modelRow = actionEl.closest('.model-row');
      const model = modelRow instanceof HTMLElement ? (modelRow.dataset.model as string) : '';
      switch (action) {
        case 'toggle':
          if (ctx.settings() === null) return;
          // 一次只展开一个：把上一个的编辑器摘掉这件事由 applyExpansion 做（就地，不重建列表）。
          expandedId = expandedId === id ? null : id;
          applyExpansion(ctx);
          break;
        case 'cancel-profile':
          handleCancelProfile(ctx, id);
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
        case 'add-model': {
          const field = modelsFieldOf(id);
          if (field !== null) openModelInput(field);
          break;
        }
        case 'cancel-model': {
          const field = modelsFieldOf(id);
          if (field !== null) requireWithin<HTMLElement>(field, '.model-new-row').hidden = true;
          break;
        }
        case 'confirm-model':
          handleAddModel(id);
          break;
        case 'use-model':
          handleUseModel(id, model);
          break;
        case 'remove-model':
          handleRemoveModel(id, model);
          break;
        case 'merge-models':
          handleMergeModels(id);
          break;
        case 'cancel-fetched':
          handleCancelFetched(id);
          break;
        case 'fetch-models':
          runSafely(engineStatus, '拉取模型清单失败', () => handleFetchModels(ctx, id));
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
      // 地址被手打 → 这一行按"自定义"算：模板下拉翻回 custom，而不是留着个已经说谎的
      // 「DeepSeek」。预设永远不许反过来覆盖用户敲进去的值。
      // （模型清单那一侧的同一件事在 `markCustomTemplate`：加/删模型同样算手改。）
      if (target.classList.contains('profile-base-url')) {
        const editor = target.closest('.profile-editor');
        if (editor !== null) requireWithin<HTMLSelectElement>(editor, '.profile-provider').value = 'custom';
      }
    });

    addProfileButton.addEventListener('click', () => {
      if (ctx.settings() === null) {
        setStatus(engineStatus, 'err', NOT_LOADED);
        return;
      }
      if (expandedId === NEW_DRAFT_ID) return;
      // 先把状态落定再插行：`buildProfileRow` 读 `expandedId` 决定要不要带编辑器。
      expandedId = NEW_DRAFT_ID;
      insertDraftRow(ctx);
      applyExpansion(ctx);
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
