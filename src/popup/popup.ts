// src/popup/popup.ts
import { LANGUAGES } from '../core/lang';
import { ENGINES, getEngine } from '../engines/registry';
import { MSG, type PageState } from '../shared/messages';
import { loadSettings, saveSettings, type Settings } from '../shared/settings';

/**
 * 按钮的三种态：不知道页面状态（`pageState === null`，初始与失败后）、
 * 知道状态但在飞（`inFlight`）、已知状态且空闲。分成两个变量而不是共用一个
 * `disabled`，因为它们的**收尾方式完全不同**：页面不可用要一直置灰到重开弹窗，
 * 在飞只是这一小段时间防连点，拿到响应就该放开。`inFlight` 开局为 true——
 * 设置还没读出来之前，按钮不该是可点的。
 */
const toggleButton = document.getElementById('toggle') as HTMLButtonElement;
const statusText = document.getElementById('status') as HTMLParagraphElement;
const targetLangSelect = document.getElementById('target-lang') as HTMLSelectElement;
const engineSelect = document.getElementById('engine') as HTMLSelectElement;
const engineHint = document.getElementById('engine-hint') as HTMLParagraphElement;
const optionsButton = document.getElementById('open-options') as HTMLButtonElement;

/** 发消息的兜底超时：内容脚本**可能永远不回**（见 `requestPageState` 的注释）。 */
const TOGGLE_TIMEOUT_MS = 30_000;

let settings: Settings;
let pageState: PageState | null = null;
let inFlight = true;

function errorText(prefix: string, raw: unknown): string {
  return `${prefix}：${raw instanceof Error ? raw.message : String(raw)}`;
}

function fillSelect(select: HTMLSelectElement, entries: Array<{ value: string; label: string }>, value: string): void {
  select.textContent = '';
  for (const entry of entries) {
    const option = document.createElement('option');
    option.value = entry.value;
    option.textContent = entry.label;
    option.selected = entry.value === value;
    select.append(option);
  }
}

/** 用存储里的设置填两个下拉，并把 hint 算对；保存失败回滚时也走这里。 */
function applySettings(next: Settings): void {
  settings = next;
  fillSelect(
    targetLangSelect,
    LANGUAGES.map((lang) => ({ value: lang.code, label: lang.label })),
    settings.targetLang,
  );
  fillSelect(
    engineSelect,
    ENGINES.map((engine) => ({ value: engine.id, label: engine.name })),
    settings.engineId,
  );
  renderEngineHint();
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

/**
 * 取当前页面的翻译状态；**拿不到就返回 null**，`undefined` 永远不往渲染层传——
 * 内容脚本对不认识的 `TOGGLE_PAGE` 是不响应的（返回 false，端口随即关闭），
 * 而 `translating` 期间它又可能一直不回应。两种情况都不是"页面不可用"。
 */
async function requestPageState(tabId: number, message: { type: string }): Promise<PageState | null> {
  const state = (await chrome.tabs.sendMessage(tabId, message)) as PageState | undefined;
  return state ?? null;
}

/**
 * 整块界面的唯一渲染出口。
 *
 * - `state === null`：不知道页面状态。按钮置灰并清掉 `dataset.active`——否则上一次
 *   渲染留下的"已翻译"深灰配色会挂在一句错误文案上，两个信号自相矛盾。
 * - `retryable`：这次失败只是这一条消息没走通（端口关闭、内容脚本报错、等待超时），
 *   再点一次有意义，所以按钮保持可点；页面不可用则要一直置灰到重开弹窗。
 */
function renderToggle(state: PageState | null, reason?: string, retryable = false): void {
  if (state === null) {
    toggleButton.disabled = !retryable;
    delete toggleButton.dataset.active;
    toggleButton.textContent = '此页面不可用';
    statusText.textContent = reason ?? '当前页面不支持翻译（浏览器内置页面或扩展商店页面）。';
    return;
  }
  // 在飞期间保持置灰：连点会开出两份译文宿主。
  toggleButton.disabled = inFlight;
  toggleButton.dataset.active = String(state.translated);
  toggleButton.textContent = state.translated ? '显示原文' : '翻译此页';
  statusText.textContent = state.translated
    ? `已翻译 ${state.done} / ${state.total} 段`
    : '按 Alt+T 也可以快速开关。';
}

/**
 * 在飞标记。`inFlight` 只影响**在飞期间**的渲染，所以置回 false 时故意不重新渲染：
 * 收尾那次渲染必须由拿到结果的那一段显式做，否则它会用一个过期的 `pageState`
 * 把超时/失败文案盖掉。
 */
function setInFlight(value: boolean): void {
  inFlight = value;
  if (value) renderToggle(pageState);
}

function renderEngineHint(): void {
  const engine = getEngine(settings.engineId);
  // 判空口径与引擎实现一致：只有空白字符也算**没填**（见 openai-compat 的构造）。
  const missingKey = engine.needsKey && settings.engineConfig.apiKey.trim().length === 0;
  if (missingKey) {
    engineHint.classList.add('warn');
    engineHint.textContent = '该引擎需要 API Key，请先在设置中填写。';
    return;
  }
  // 前瞻分支：现存两个引擎的 supportsGlossary 都是 true，今天恒不成立。留着是接口预留
  // （见 engines/types.ts 的 Translator），不是死代码。
  if (!engine.supportsGlossary && settings.glossary.length > 0) {
    engineHint.classList.remove('warn');
    engineHint.textContent = '当前引擎不支持术语表，术语表对其不生效。';
    return;
  }
  engineHint.classList.remove('warn');
  engineHint.textContent = engine.needsKey ? '已配置你自己的 API Key。' : '零配置可用，无需 API Key。';
}

/**
 * 初始化与点击共用的兜底：**任何**没被就地处理的拒绝都要变成用户看得见的一句话。
 * 没有它，`void init()` 与 `void onClick()` 会各自留下一次未处理的拒绝，界面停在
 * 半初始化状态上——按钮看着能点、点下去没反应，比直接报错更难排查。
 */
function runSafely(prefix: string, run: () => Promise<void>): void {
  void run().catch((raw: unknown) => {
    pageState = null;
    setInFlight(false);
    // retryable：按钮别锁死。设置读不出来时页面本身没坏，用户按一下会得到一次
    // 如实的通信失败提示，而不是"看着能点、点了没反应"。
    renderToggle(null, errorText(prefix, raw), true);
  });
}

/** 拉一次页面状态并渲染。发送失败时返回 null，而不是把异常当"页面不可用"处理。 */
async function refreshPageState(): Promise<void> {
  const tabId = await activeTabId();
  if (tabId === null) {
    pageState = null;
    renderToggle(null, '当前窗口没有可翻译的标签页。');
    return;
  }
  try {
    pageState = await requestPageState(tabId, { type: MSG.GET_PAGE_STATE });
  } catch {
    // chrome:// 等受限页面上没有内容脚本，属于正常情况。
    pageState = null;
  }
  renderToggle(pageState);
}

/**
 * 点主按钮：只发 TOGGLE_PAGE，不自己判断方向——状态的唯一真相在内容脚本里，
 * 弹窗里的 dataset 只用于渲染，不能作为决策依据。
 */
async function handleToggleClick(): Promise<void> {
  const tabId = await activeTabId();
  if (tabId === null) {
    pageState = null;
    renderToggle(null, '当前窗口没有可翻译的标签页。');
    return;
  }

  setInFlight(true);
  // 超时自己收尾：内容脚本在"整页翻译跑完"之前不会响应 TOGGLE_PAGE；这一轮被
  // `running` 拦下时（见 content/index.ts 里 translatePage 的早返回）更是永远不会
  // 响应。等端口自己关闭可能要几分钟，用户看到的是一个没有理由的置灰按钮。
  // 同一个定时器既渲染又拒绝：两个独立定时器会各渲染一次，后跑的那个把先跑的
  // 文案盖掉。
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      pageState = null;
      renderToggle(
        null,
        `页面超过 ${Math.round(TOGGLE_TIMEOUT_MS / 1000)} 秒没有响应，请重新加载页面后重试。`,
        true,
      );
      reject(new Error('等待页面响应超时'));
    }, TOGGLE_TIMEOUT_MS);
  });

  try {
    // Promise.race 而不是只等 sendMessage：超时那一支必须自己渲染，而 sendMessage
    // 的 promise 可能永远不兑现，界面就会一直停在置灰的"此页面不可用"上。
    const state = await Promise.race([requestPageState(tabId, { type: MSG.TOGGLE_PAGE }), timeout]);
    pageState = state;
    inFlight = false;
    renderToggle(pageState);
  } catch (raw) {
    pageState = null;
    // 发送失败≠页面不可翻译：端口提前关闭、内容脚本内部报错、等待超时都长这样。
    // 如实说明并让用户重试（`retryable`），而不是把可翻译的页面说成"此页面不可用"。
    // 超时那句已经在上面渲染好了，这里不要再盖一次。
    // 在飞标记要在渲染**之前**落定：渲染之后没人再碰它，就不会出现
    // "按钮已放开、文案和 disabled 却还是上一次渲染留下的"这种自相矛盾的状态。
    inFlight = false;
    if (!timedOut) renderToggle(null, `${errorText('无法与页面通信', raw)}。请重新加载页面后重试。`, true);
  } finally {
    clearTimeout(timeoutId);
  }
}

/** 初始化要用的那串 await；注册监听器**不能**放在它之后（见 `init`）。 */
async function start(): Promise<void> {
  applySettings(await loadSettings());
  await refreshPageState();
  // 按钮开局的置灰是"设置还没读出来"的在飞态，这里才是它真正的收尾。
  // 不能放进 `applySettings`：保存失败回滚也会走那里，而回滚不该动在飞标记。
  inFlight = false;
  renderToggle(pageState);
}

/**
 * @param next 存储里的设置
 * @param previous 失败时用来回滚的**上一份**完整设置
 * @param field 这次改的是哪个字段（回滚只动这一个）
 */
async function saveSettingsOrReport(
  next: Settings,
  previous: Settings,
  control: HTMLSelectElement,
  field: 'targetLang' | 'engineId',
): Promise<void> {
  try {
    await saveSettings(next);
    settings = next;
  } catch (raw) {
    // `saveSettings` 在存储版本高于本代码时明确拒绝。不报告就等于"改了没生效"，
    // 用户看到的是设置自己弹回去；这里如实说，并把下拉回滚到真正生效的那一项。
    settings = previous;
    control.value = previous[field];
    renderEngineHint();
    statusText.textContent = errorText('设置未能保存', raw);
  }
}

function onTargetLangChange(): void {
  const previous = settings;
  const next: Settings = { ...settings, targetLang: targetLangSelect.value };
  void saveSettingsOrReport(next, previous, targetLangSelect, 'targetLang').then(() => {
    // 语言改动只落盘，不会重译当前页面（规范 §7.1）。页面已经译完时不说一声，
    // 用户会以为下拉没生效。保存失败时上面已经写了错误文案，不覆盖它。
    if (settings !== next) return;
    if (pageState?.translated) {
      statusText.textContent = '目标语言已更新，重新翻译此页生效。';
    }
  });
}

function onEngineChange(): void {
  const previous = settings;
  const next: Settings = { ...settings, engineId: engineSelect.value };
  void saveSettingsOrReport(next, previous, engineSelect, 'engineId').then(() => {
    // 存储里没变就说明刚才拒绝过，提示区别再按没生效的引擎重算一遍。
    if (settings !== next) return;
    renderEngineHint();
  });
}

function init(): void {
  // 设置读出来之前按钮先置灰：这会儿 `pageState` 还是 null、监听器也刚挂上，让它可点
  // 只会是"点了没反应"的那个窗口期。HTML 里没有 `disabled` 属性，所以这句是必须的
  // 同步渲染——`start()` 要等一整个存储往返才轮到它渲染。
  toggleButton.disabled = true;

  // 监听器在第一个 await **之前**挂好：`loadSettings` 有明确的拒绝路径（存储里是
  // 更高版本、存储读写失败）。若等读完再挂，这些拒绝会让界面变成一个"看着能点、
  // 其实没有任何监听器"的死弹窗，连齿轮都打不开。
  toggleButton.addEventListener('click', () => {
    runSafely('操作失败', handleToggleClick);
  });
  targetLangSelect.addEventListener('change', onTargetLangChange);
  engineSelect.addEventListener('change', onEngineChange);
  optionsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());

  runSafely('设置读取失败', start);
}

init();
