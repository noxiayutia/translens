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

// 模块级只建一次缓存：`maxEntries` 是实例属性，条目却挂在存储区上，同一存储区上并存两个
// 上限不同的实例会互相剪掉对方刚写进去的条目（见 `core/cache.ts` 的不变量 1）。
const persistentCache = new TranslationCache(localArea, DEFAULT_SETTINGS.cacheMaxEntries);
const sessionCache = new TranslationCache(sessionArea, DEFAULT_SETTINGS.cacheMaxEntries);

// 启动时全量对账一次：`putMany` 只累加一个近似计数，形状坏掉的条目也只有扫描才看得见，
// 这里把两者一次收敛成真实值（并顺手按上限裁剪）。缓存没有索引键可对账，淘汰顺序现算。
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

    // 上限随设置变化；上限是实例属性而条目挂在存储区上，所以每个存储区只能有这一个实例
    // （见 `core/cache.ts` 的不变量 1），这里改的正是那个唯一实例的上限。
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
