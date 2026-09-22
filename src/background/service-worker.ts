// src/background/service-worker.ts
import { TieredCache, TranslationCache, type StorageArea } from '../core/cache';
import { EngineError, toEngineError } from '../engines/types';
import { chromeArea } from '../shared/chrome-area';
import { isFetchModelsMessage, isTranslateTextsMessage, MSG, type FetchModelsResponse, type TranslateTextsResponse } from '../shared/messages';
import { DEFAULT_SETTINGS, NO_ENGINE_PROBLEM, loadSettings, resolveEngine, type Settings } from '../shared/settings';
import { fetchModels } from './models';
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
 * 读不出来（存储坏了、版本高于本代码）就返回 undefined，调用方据此跳过整次对账，
 * 绝不因此让 SW 启动失败。
 */
const startupSettings = loadSettings(persistentArea).catch(() => undefined);

/**
 * 启动时全量对账一次：`putMany` 只累加一个近似计数，形状坏掉的条目也只有扫描才看得见，
 * 这里把两者一次收敛成真实值（并顺手按上限裁剪）。缓存没有索引键可对账，淘汰顺序现算。
 *
 * 两处刻意的安排：
 * - 先 await 设置再 prune：prune 会按 `maxEntries` 真删条目，拿默认上限当用户上限就会
 *   多删（用户配 500 却按 5000 裁）。**设置读不出来时直接跳过整次对账**——实例上是默认
 *   的 5000，而用户配的更小（最小 100），照默认值裁同样会多删，且这是真删用户数据。
 *   近似计数留到下次成功读取设置后再收敛，代价只是晚一轮，比删错安全得多。
 * - 放在 `queueMicrotask` 里、而不是模块体里直接调：监听器注册与 `onMessage` 的返回
 *   值必须是**同步**的，这个存储区上的串行队列（`core/cache.ts` 的 `queue`）不该在
 *   此之前就被一次全量扫描占住。延后一个微任务仍然早于任何 `chrome.*` 事件回调。
 *   （注册本身是同步的，所以两种写法行为等价；这里只是让启动路径不与注册抢队列。）
 *
 * 导出只是为了让测试能等到它跑完；生产代码里没有任何地方 await 它。
 */
export const cachesInitialized: Promise<void> = (async () => {
  const settings = await startupSettings;
  if (!settings) return;
  persistentCache.setMaxEntries(settings.cacheMaxEntries);
  sessionCache.setMaxEntries(settings.cacheMaxEntries);
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
    // 「用哪个引擎 + 用哪份配置」只有一处解析（shared/settings 的 resolveEngine）：
    // `engineId` 现在是**某个档案的 id**，或 `''`（= 没有可用引擎）。没有第二个解析点——
    // **不许**在这里再写一个 `if (settings.engineId === '')`。
    const { engine, config, problem } = resolveEngine(settings);
    /**
     * 两道收口在这一行合并——对用户是同一件事：带一句可行动的话整条返回，**一个请求都不发**。
     *
     * - `engine === null`：`engineId` 不指向任何现存档案（含残留的 `'google'`、`'openai-compat'`
     *   这类裸引擎 id）。这里也是**类型上必须**收住的地方：`translateBatch` 要一个真的 `Translator`。
     * - `problem !== undefined`：档案没有当前模型（`NO_MODEL_PROBLEM`）。
     *
     * 两句都由 `resolveEngine` 产出（唯一来源），这里只负责转达与选错误码。
     *
     * 为什么 `code` 用 `'AUTH'` 而不是新造一个码：内容脚本的 `describeError` 对 AUTH **原样透传**
     * message（不走罐头文案），`sameCodeFailureMessage` 对 AUTH 只追加一句"在扩展设置里…"
     * （方向正确），而 AUTH **不在** `RETRYABLE_CODES` 里——不会给用户挂一排点了必然失败的重试按钮。
     *
     * ⚠ **这道闸不是"零请求"的守卫**（本单元更正了旧注释的这半句）：没有可用引擎时零请求是
     * **按构造**成立的——`resolveEngine` 交出来的 `engine` 是 `null`，没有任何地方会去构造一个
     * 引擎对象，"忘了拦一处就发出去"这条路径**按构造**不存在。这道闸改变的是**失败粒度与文案**：
     * 没有它 → `translateBatch` 拿到 `null` 会抛成 `{ ok: false, code: 'UNKNOWN' }`（一句用户看不懂
     * 的话）；有它 → 整条 `{ ok: false, code: 'AUTH', message: problem }`。
     * 有读数的那条端到端守卫在 `tests/background/service-worker.test.ts`：
     * 「没有可用引擎：整条返回 AUTH + 那句话，一个请求都不发」。
     */
    if (engine === null || problem !== undefined) {
      return { ok: false, code: 'AUTH', message: problem ?? NO_ENGINE_PROBLEM };
    }
    const targetLang = payload.targetLang ?? settings.targetLang;

    // 上限随设置变化；上限是实例属性而条目挂在存储区上，所以每个存储区只能有这一个实例
    // （见 `core/cache.ts` 的不变量 1），这里改的正是那个唯一实例的上限。
    persistentCache.setMaxEntries(settings.cacheMaxEntries);
    sessionCache.setMaxEntries(settings.cacheMaxEntries);
    const cache = new TieredCache(sessionCache, persistentCache);

    const results = await translateBatch(payload.items, {
      engine,
      engineConfig: config,
      sourceLang: settings.sourceLang,
      targetLang,
      // 不支持 system prompt 的引擎传了也没用，反而会污染缓存 key。
      //
      // **如实记账**：删掉免费接口之后唯一的适配器恒 `supportsGlossary === true`，这两行
      // 今天**没有判别力**（弹窗里同一条分录与 `if (!engine.supportsGlossary …)` 分支同样
      // 恒不成立）。留着它们是**适配器契约**（第三种适配器可能不支持术语表/提示词，见
      // engines/types.ts 的 Translator），不是死代码。**不为它编断言**。
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

/**
 * 设置页点「获取可用模型」→ 后台**自己**从存储读那份档案的 baseUrl / apiKey 再请求（§5.1）。
 * 失败一律收成 `{ ok: false, message }`：这个函数不抛，路由那一层只是兜底。
 */
async function handleFetchModels(payload: { profileId: string }): Promise<FetchModelsResponse> {
  let settings: Settings;
  try {
    settings = await loadSettings(persistentArea);
  } catch (raw) {
    return { ok: false, message: `设置读不出来：${toEngineError(raw).message}` };
  }
  const profile = settings.profiles.find((item) => item.id === payload.profileId);
  if (profile === undefined) return { ok: false, message: '这个档案已经不在了，请重新打开设置页再试。' };
  return fetchModels(profile);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isFetchModelsMessage(message)) {
    handleFetchModels(message.payload)
      .then(sendResponse)
      .catch((raw: unknown) => {
        // 这个处理器自己不抛（失败都收成 `{ ok: false, message }`），这一层是纯兜底：
        // 抛出去会变成一次未处理的拒绝 + 一个永远等不到响应的调用方。
        sendResponse({ ok: false, message: `拉取模型清单失败：${toEngineError(raw).message}` } satisfies FetchModelsResponse);
      })
      // `sendResponse` 自己会抛（端口已关）：与翻译那条同一条口径，静默丢弃。
      .catch(() => undefined);
    return true;
  }
  if (!isTranslateTextsMessage(message)) return false;
  handleTranslateTexts(message.payload)
    .then(sendResponse)
    .catch((raw: unknown) => {
      const error: EngineError = toEngineError(raw);
      sendResponse({ ok: false, code: error.code, message: error.message } satisfies TranslateTextsResponse);
    })
    // `sendResponse` 自己会抛：内容脚本先关掉端口（自己的超时、页面跳走、SW 被回收）时
    // 第一个 `sendResponse` 就抛，上面的 catch 又调用它一次、那个异常背后再没有处理者，
    // 整条消息会变成一个未处理拒绝。消息已经没人收，静默丢弃即可。
    .catch(() => undefined);
  // 返回 true 保持消息通道打开，等待异步响应。
  return true;
});
