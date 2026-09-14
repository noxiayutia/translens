// src/popup/popup.ts
import { LANGUAGES } from '../core/lang';
import { ENGINES, getEngine } from '../engines/registry';
import { MSG, type PageState } from '../shared/messages';
import { loadSettings, saveSettings, type Settings } from '../shared/settings';

const toggleButton = document.getElementById('toggle') as HTMLButtonElement;
const statusText = document.getElementById('status') as HTMLParagraphElement;
const targetLangSelect = document.getElementById('target-lang') as HTMLSelectElement;
const engineSelect = document.getElementById('engine') as HTMLSelectElement;
const engineHint = document.getElementById('engine-hint') as HTMLParagraphElement;
const optionsButton = document.getElementById('open-options') as HTMLButtonElement;

let settings: Settings;

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

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function queryState(): Promise<PageState | null> {
  const tabId = await activeTabId();
  if (tabId === null) return null;
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: MSG.GET_PAGE_STATE })) as PageState;
  } catch {
    // chrome:// 等受限页面上没有内容脚本，属于正常情况。
    return null;
  }
}

function renderState(state: PageState | null): void {
  if (!state) {
    toggleButton.disabled = true;
    toggleButton.textContent = '此页面不可用';
    statusText.textContent = '当前页面不支持翻译（浏览器内置页面或扩展商店页面）。';
    return;
  }
  toggleButton.disabled = false;
  toggleButton.dataset.active = String(state.translated);
  toggleButton.textContent = state.translated ? '显示原文' : '翻译此页';
  statusText.textContent = state.translated
    ? `已翻译 ${state.done} / ${state.total} 段`
    : '按 Alt+T 也可以快速开关。';
}

function renderEngineHint(): void {
  const engine = getEngine(settings.engineId);
  const missingKey = engine.needsKey && settings.engineConfig.apiKey.trim().length === 0;
  if (missingKey) {
    engineHint.classList.add('warn');
    engineHint.textContent = '该引擎需要 API Key，请先在设置中填写。';
    return;
  }
  if (!engine.supportsGlossary && settings.glossary.length > 0) {
    engineHint.classList.remove('warn');
    engineHint.textContent = '当前引擎不支持术语表，术语表对其不生效。';
    return;
  }
  engineHint.classList.remove('warn');
  engineHint.textContent = engine.needsKey ? '使用你自己配置的接口。' : '零配置可用，无需 API Key。';
}

async function persist(): Promise<void> {
  await saveSettings(settings);
}

async function refreshState(): Promise<void> {
  renderState(await queryState());
}

async function init(): Promise<void> {
  settings = await loadSettings();
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
  await refreshState();

  toggleButton.addEventListener('click', async () => {
    const tabId = await activeTabId();
    if (tabId === null) return;
    // 用 TOGGLE_PAGE 而不是让弹窗自己判断方向：状态的唯一真相在内容脚本里，
    // 弹窗里的 dataset 只用于渲染，不能作为决策依据。
    toggleButton.disabled = true;
    try {
      const state = (await chrome.tabs.sendMessage(tabId, { type: MSG.TOGGLE_PAGE })) as PageState;
      renderState(state);
    } catch {
      renderState(null);
    }
    // 这里**没有** `finally { disabled = false }`：按钮可不可用由 `renderState` 的两个分支
    // 收尾（可用页面放开、受限页面保持置灰）。无条件放开会把刚判定的"此页面不可用"
    // 又变回可点。上面那句 `disabled = true` 只负责在飞的这一小段时间里防连点。
  });

  targetLangSelect.addEventListener('change', async () => {
    settings = { ...settings, targetLang: targetLangSelect.value };
    await persist();
  });

  engineSelect.addEventListener('change', async () => {
    settings = { ...settings, engineId: engineSelect.value };
    await persist();
    renderEngineHint();
  });

  optionsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

void init();
