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

const persistentArea: StorageArea = chromeArea(chrome.storage.local);
const sessionArea: StorageArea = chromeArea(chrome.storage.session);

// 模块级只建一次缓存：`maxEntries` 是实例属性，条目却挂在存储区上，同一存储区上并存两个
// 上限不同的实例会互相剪掉对方刚写进去的条目（见 `core/cache.ts` 的不变量 1）。
const persistentCache = new TranslationCache(persistentArea, DEFAULT_SETTINGS.cacheMaxEntries);
const sessionCache = new TranslationCache(sessionArea, DEFAULT_SETTINGS.cacheMaxEntries);

/**
 * 启动时的只读设置查询（**取缓存上限**）：设置页会显示缓存条目数，所以冷启动就必须按
 * 用户配置的上限来裁剪，而不是先按默认上限、等第一条翻译消息到达时才纠正。
 * 读不出来（存储坏了、版本高于本代码）就按实例上的默认上限走，绝不因此让 SW 启动失败。
 */
const startupSettings = loadSettings(persistentArea).catch(() => undefined);

/**
 * 启动时全量对账一次：`putMany` 只累加一个近似计数，形状坏掉的条目也只有扫描才看得见，
 * 这里把两者一次收敛成真实值（并顺手按上限裁剪）。缓存没有索引键可对账，淘汰顺序现算。
 *
 * 两处刻意的安排：
 * - 先 await 设置再 prune：prune 会按 `maxEntries` 真删条目，拿默认上限当用户上限就会
 *   多删（用户配 500 却按 5000 裁）。
 * - 放在 `queueMicrotask` 里、而不是模块体里直接调：监听器注册与 `onMessage` 的返回
 *   值必须是**同步**的，这个存储区上的串行队列（`core/cache.ts` 的 `queue`）不该在
 *   此之前就被一次全量扫描占住。延后一个微任务仍然早于任何 `chrome.*` 事件回调。
 *
 * 导出只是为了让测试能等到它跑完；生产代码里没有任何地方 await 它。
 */
export const cachesInitialized: Promise<void> = (async () => {
  const settings = await startupSettings;
  if (settings) {
    persistentCache.setMaxEntries(settings.cacheMaxEntries);
    sessionCache.setMaxEntries(settings.cacheMaxEntries);
  }
  // 两次 prune 并行：两个存储区各有一条队列，互不相关，没有必要串起来等。
  await Promise.all([persistentCache.prune(), sessionCache.prune()]);
})();

queueMicrotask(() => void cachesInitialized);

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
    const settings = await loadSettings(persistentArea);
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
    })
    // `sendResponse` 自己会抛：端口已关闭（内容脚本超时、页面跳走、SW 被回收）时上面的
    // catch 又调用它一次、那个异常背后再没有处理者，整条消息会变成一个未处理拒绝。
    .catch(() => undefined);
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
