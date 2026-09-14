## Task 18: 弹窗 UI

> 本任务是设计文档 §7.1 弹窗规格的**子集**。规格中的「显示模式分段控件」「悬停/划词快捷开关」「站点规则命中提示」依赖 Plan 2 的能力，此处不做——不要为了对齐规格而提前实现它们。

**Files:**
- Modify: `src/popup/popup.html`
- Create: `src/popup/popup.css`
- Modify: `src/popup/popup.ts`

- [ ] **Step 1: 写弹窗结构**

```html
<!-- src/popup/popup.html -->
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="./popup.css" />
    <title>浸译</title>
  </head>
  <body>
    <header class="header">
      <span class="brand">浸译</span>
      <button id="open-options" class="icon-button" type="button" title="设置">⚙</button>
    </header>

    <button id="toggle" class="primary" type="button">翻译此页</button>
    <p id="status" class="status"></p>

    <label class="field">
      <span>目标语言</span>
      <select id="target-lang"></select>
    </label>

    <label class="field">
      <span>翻译引擎</span>
      <select id="engine"></select>
    </label>

    <p id="engine-hint" class="hint"></p>

    <script type="module" src="./popup.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: 写弹窗样式**

```css
/* src/popup/popup.css */
:root {
  color-scheme: light dark;
}

body {
  width: 320px;
  margin: 0;
  padding: 12px 14px 16px;
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.brand {
  font-weight: 600;
  letter-spacing: 0.04em;
}

.icon-button {
  border: none;
  background: transparent;
  font-size: 16px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}

.icon-button:hover {
  background: rgba(127, 127, 127, 0.16);
}

.primary {
  width: 100%;
  padding: 9px 12px;
  font: inherit;
  font-weight: 500;
  color: #fff;
  background: #2b6cb0;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.primary:hover {
  background: #24598f;
}

.primary[data-active="true"] {
  background: #4a5568;
}

.status {
  min-height: 1.4em;
  margin: 8px 2px 12px;
  font-size: 12px;
  opacity: 0.72;
}

.field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.field > span {
  flex: 0 0 auto;
  font-size: 13px;
  opacity: 0.86;
}

.field > select {
  flex: 1 1 auto;
  min-width: 0;
  padding: 5px 6px;
  font: inherit;
  font-size: 13px;
  border-radius: 6px;
  border: 1px solid rgba(127, 127, 127, 0.4);
  background: transparent;
}

.hint {
  margin: 4px 2px 0;
  font-size: 12px;
  line-height: 1.5;
  opacity: 0.7;
}

.hint.warn {
  color: #b3261e;
  opacity: 1;
}
```

- [ ] **Step 3: 写弹窗逻辑**

```ts
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
    } finally {
      toggleButton.disabled = false;
    }
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
```

- [ ] **Step 4: 运行类型检查与构建**

Run: `npm run typecheck`

Expected: 退出码 0。

Run: `npm run build`

Expected: 退出码 0，`dist/popup/popup.html`、`dist/popup/popup.js` 存在。

- [ ] **Step 5: 提交**

```bash
git add src/popup
git commit -m "feat(popup): 翻译开关、语言与引擎选择"
```

---
