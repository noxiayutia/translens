## Task 14: `background/service-worker.ts` — 消息路由、快捷键、右键菜单

**Files:**
- Modify: `src/background/service-worker.ts`（替换占位内容）

- [ ] **Step 1: 写实现**

```ts
// src/background/service-worker.ts
import { TieredCache, TranslationCache, type StorageArea } from '../core/cache';
import { getEngine } from '../engines/registry';
import { EngineError, toEngineError } from '../engines/types';
import { chromeArea } from '../shared/chrome-area';
import { isTranslateTextsMessage, MSG, type TranslateTextsResponse } from '../shared/messages';
import { DEFAULT_SETTINGS, loadSettings } from '../shared/settings';
import { translateBatch } from './scheduler';

const MENU_TRANSLATE_PAGE = 'jinyi-translate-page';
const MENU_TRANSLATE_SELECTION = 'jinyi-translate-selection';

const localArea: StorageArea = chromeArea(chrome.storage.local);
const sessionArea: StorageArea = chromeArea(chrome.storage.session);

// 模块级只建一次缓存：每条消息新建实例时存储区对象也跟着换，实例级串行化就失效了。
const persistentCache = new TranslationCache(localArea, DEFAULT_SETTINGS.cacheMaxEntries);
const sessionCache = new TranslationCache(sessionArea, DEFAULT_SETTINGS.cacheMaxEntries);

// 启动时按真实 key 对账一次索引：上次没走完的写入、被外部改坏的索引都在这时收敛。
void persistentCache.prune();
void sessionCache.prune();

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_TRANSLATE_PAGE, title: '翻译此页', contexts: ['page'] });
    chrome.contextMenus.create({ id: MENU_TRANSLATE_SELECTION, title: '翻译选中文本', contexts: ['selection'] });
  });
});

async function sendToActiveTab(message: unknown): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  // 在 chrome:// 等受限页面上没有接收方，静默忽略。
  await chrome.tabs.sendMessage(tab.id, message).catch(() => undefined);
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-translate') void sendToActiveTab({ type: MSG.TOGGLE_PAGE });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === MENU_TRANSLATE_PAGE) {
    void chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_PAGE }).catch(() => undefined);
    return;
  }
  if (info.menuItemId === MENU_TRANSLATE_SELECTION && info.selectionText) {
    void chrome.tabs
      .sendMessage(tab.id, { type: MSG.TRANSLATE_SELECTION, payload: { text: info.selectionText } })
      .catch(() => undefined);
  }
});

async function handleTranslateTexts(
  payload: { items: Array<{ id: string; text: string }>; targetLang?: string },
): Promise<TranslateTextsResponse> {
  try {
    const settings = await loadSettings(localArea);
    const engine = getEngine(settings.engineId);
    const targetLang = payload.targetLang ?? settings.targetLang;

    // 上限随设置变化；索引是存储区级的，所以缓存实例必须全局只有一个。
    persistentCache.setMaxEntries(settings.cacheMaxEntries);
    sessionCache.setMaxEntries(settings.cacheMaxEntries);
    const cache = new TieredCache(sessionCache, persistentCache);

    const results = await translateBatch(payload.items, {
      engine,
      engineConfig: settings.engineConfig,
      sourceLang: settings.sourceLang,
      targetLang,
      // 不支持 system prompt 的引擎传了也没用，反而会污染缓存 key。
      glossary: engine.supportsGlossary ? settings.glossary : undefined,
      systemPrompt: engine.supportsGlossary ? settings.systemPrompt : undefined,
      cache,
    });

    return { ok: true, results };
  } catch (raw) {
    const error = toEngineError(raw);
    return { ok: false, code: error.code, message: error.message };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isTranslateTextsMessage(message)) return false;
  handleTranslateTexts(message.payload)
    .then(sendResponse)
    .catch((raw: unknown) => {
      const error: EngineError = toEngineError(raw);
      sendResponse({ ok: false, code: error.code, message: error.message } satisfies TranslateTextsResponse);
    });
  // 返回 true 保持消息通道打开，等待异步响应。
  return true;
});
```

- [ ] **Step 2: 运行类型检查**

Run: `npm run typecheck`

Expected: 退出码 0。

- [ ] **Step 3: 构建并确认 background 产物体积合理**

Run: `npm run build`

Expected: 退出码 0，`dist/background.js` 存在。

- [ ] **Step 4: 提交**

```bash
git add src/background/service-worker.ts
git commit -m "feat(background): 消息路由、快捷键与右键菜单"
```

---
