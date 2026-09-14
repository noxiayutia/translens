// tests/helpers/chrome-stub.ts
/**
 * 最小可用的 `chrome` 命名空间替身。
 *
 * service worker 在 **import 时**就注册各种监听器（`onMessage` / `onInstalled` /
 * `onCommand` / `contextMenus.onClicked`），所以替身必须在 import 之前装好——见
 * `tests/background/service-worker.test.ts`：先 `installChromeStub()`，再动态 import。
 *
 * 只实现被测代码真正用到的部分：
 * - `storage.local` / `storage.session`：两块**互相独立**的内存存储（真机上 session 是
 *   另一块只在会话内保留的区域，service worker 属于受信上下文，可以直接用）；
 * - `runtime.onInstalled` / `runtime.onMessage`、`commands.onCommand`、
 *   `contextMenus.*`、`tabs.query` / `tabs.sendMessage`：可注册、可手动触发。
 *
 * 存储 API 只覆盖 `core/cache.ts` 与 `shared/settings.ts` 用到的取法
 * （`null` / 字符串 / 字符串数组）；真机还接受对象形式的默认值，这里**不支持**，
 * 传进来会直接抛错而不是静默返回错结果。
 */

/** 事件替身：按注册顺序触发，并把每个监听器的返回值原样交回调用方（`onMessage` 要看它）。 */
export interface StubEvent<L extends (...args: any[]) => any> {
  addListener(listener: L): void;
  removeListener(listener: L): void;
  hasListener(listener: L): boolean;
  /** 当前已注册的监听器，按注册顺序 */
  listeners(): L[];
  emit(...args: Parameters<L>): Array<ReturnType<L>>;
}

function createEvent<L extends (...args: any[]) => any>(): StubEvent<L> {
  const registered: L[] = [];
  return {
    addListener(listener) {
      registered.push(listener);
    },
    removeListener(listener) {
      const index = registered.indexOf(listener);
      if (index >= 0) registered.splice(index, 1);
    },
    hasListener: (listener) => registered.includes(listener),
    listeners: () => [...registered],
    emit: (...args) => registered.map((listener) => listener(...args)),
  };
}

/** 内存存储区：`chrome.storage.local` / `chrome.storage.session` 的可测试替身。 */
export interface StubStorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
  /**
   * 全部键名。真机的 `chrome.storage` 没有这个方法，是 `shared/chrome-area.ts` 用
   * `get(null)` 取键名实现的；这里两条路都留着，替身既能当 `chrome.storage.*` 用，
   * 也能直接当 `core/cache.ts` 的 `StorageArea` 用。
   */
  keys(): Promise<string[]>;
  /** 测试直读：当前全部键值的深拷贝快照 */
  snapshot(): Record<string, unknown>;
  size(): number;
}

function createStorageArea(): StubStorageArea {
  const data = new Map<string, unknown>();

  function snapshot(): Record<string, unknown> {
    return Object.fromEntries([...data.entries()].map(([key, value]) => [key, structuredClone(value)]));
  }

  return {
    async get(keys) {
      if (keys === null || keys === undefined) return snapshot();
      if (typeof keys !== 'string' && !Array.isArray(keys)) {
        throw new Error('chrome-stub 的 get 只支持 null / 字符串 / 字符串数组');
      }
      const out: Record<string, unknown> = {};
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        if (data.has(key)) out[key] = structuredClone(data.get(key));
      }
      return out;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
    async remove(keys) {
      for (const key of typeof keys === 'string' ? [keys] : keys) data.delete(key);
    },
    async clear() {
      data.clear();
    },
    async keys() {
      return [...data.keys()];
    },
    snapshot,
    size: () => data.size,
  };
}

/** 标签页替身；`id` 省略时按"没有可发送的接收方"处理。 */
export interface StubTab {
  id?: number;
  active?: boolean;
  currentWindow?: boolean;
  url?: string;
}

export interface SentTabMessage {
  tabId: number;
  message: unknown;
}

export interface StubTabs {
  /** 下一次 `query` 返回的标签页；默认是一个 `id: 7` 的活动标签 */
  activeTabs: StubTab[];
  /** `query` 收到的查询条件，按调用顺序 */
  queries: unknown[];
  /** 每次 `sendMessage` 的尝试（含下面被拒的那些），按调用顺序 */
  sent: SentTabMessage[];
  /** 置为 true 时 `sendMessage` 拒绝，模拟 chrome:// 等没有接收方的受限页面 */
  rejectSendMessage: boolean;
  query(queryInfo: unknown): Promise<StubTab[]>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

export interface StubMenuCreateProps {
  id?: string;
  title?: string;
  contexts?: string[];
}

export interface StubMenuClickInfo {
  menuItemId: string;
  selectionText?: string;
}

export interface StubContextMenus {
  onClicked: StubEvent<(info: StubMenuClickInfo, tab?: StubTab) => void>;
  /** 当前已创建的菜单项；`removeAll` 会清空它 */
  created: StubMenuCreateProps[];
  /** `removeAll` 被调用的次数 */
  removeAllCalls: number;
  removeAll(callback?: () => void): void;
  create(props: StubMenuCreateProps): string;
  /** 手动触发一次菜单点击 */
  click(info: StubMenuClickInfo, tab?: StubTab): void;
}

/** `onMessage` 的监听器签名（与 `@types/chrome` 一致）。 */
export type StubMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

export interface MessageDispatch {
  /** 各监听器的返回值，按注册顺序（本插件只有一个） */
  returns: unknown[];
  /** 是否有监听器返回 true：消息通道保持打开，响应稍后到达 */
  keepChannelOpen: boolean;
  /** `sendResponse` 是否已被调用 */
  responded: boolean;
  /** 已收到的响应值（未响应时为 undefined） */
  value: unknown;
  /** 等到 `sendResponse` 被调用；超时抛错，避免测试静默挂起 */
  response(timeoutMs?: number): Promise<unknown>;
}

export interface StubRuntime {
  onInstalled: StubEvent<() => void>;
  onMessage: StubEvent<StubMessageListener>;
  /** 触发 `onInstalled`（模拟安装 / 更新） */
  install(): void;
  /** 派发一条消息给全部 `onMessage` 监听器 */
  dispatchMessage(message: unknown, sender?: unknown): MessageDispatch;
}

export interface ChromeStub {
  storage: { local: StubStorageArea; session: StubStorageArea };
  runtime: StubRuntime;
  commands: {
    onCommand: StubEvent<(command: string, tab?: StubTab) => void>;
    /** 触发一次快捷键 */
    run(command: string): void;
  };
  contextMenus: StubContextMenus;
  tabs: StubTabs;
  /**
   * 清空两块存储与全部调用记录，**保留监听器**（监听器只在 import service worker 时
   * 注册一次，重新注册会让同一个消息被处理两遍）。
   */
  reset(): Promise<void>;
}

export const DEFAULT_ACTIVE_TAB: StubTab = { id: 7, active: true, currentWindow: true };

function createRuntime(): StubRuntime {
  const onInstalled = createEvent<() => void>();
  const onMessage = createEvent<StubMessageListener>();

  return {
    onInstalled,
    onMessage,
    install: () => void onInstalled.emit(),
    dispatchMessage(message, sender = {}) {
      let responded = false;
      let value: unknown;
      let settle: ((response: unknown) => void) | undefined;
      const respondedPromise = new Promise<unknown>((resolve) => {
        settle = resolve;
      });
      const sendResponse = (response?: unknown): void => {
        // 真机上第二个 sendResponse 是空操作，这里也忽略后到的那个。
        if (responded) return;
        responded = true;
        value = response;
        settle?.(response);
      };

      const returns = onMessage.emit(message, sender, sendResponse);
      return {
        returns,
        keepChannelOpen: returns.some((result) => result === true),
        get responded() {
          return responded;
        },
        get value() {
          return value;
        },
        response(timeoutMs = 1000) {
          if (responded) return Promise.resolve(value);
          return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`sendResponse 在 ${timeoutMs}ms 内没有被调用`)),
              timeoutMs,
            );
            void respondedPromise.then((response) => {
              clearTimeout(timer);
              resolve(response);
            });
          });
        },
      };
    },
  };
}

function createContextMenus(): StubContextMenus {
  const onClicked = createEvent<(info: StubMenuClickInfo, tab?: StubTab) => void>();
  const menus: StubContextMenus = {
    onClicked,
    created: [],
    removeAllCalls: 0,
    removeAll(callback) {
      menus.removeAllCalls += 1;
      menus.created = [];
      callback?.();
    },
    create(props) {
      menus.created.push(props);
      return props.id ?? '';
    },
    click(info, tab) {
      void onClicked.emit(info, tab);
    },
  };
  return menus;
}

function createTabs(): StubTabs {
  const tabs: StubTabs = {
    activeTabs: [{ ...DEFAULT_ACTIVE_TAB }],
    queries: [],
    sent: [],
    rejectSendMessage: false,
    async query(queryInfo) {
      tabs.queries.push(queryInfo);
      return tabs.activeTabs.map((tab) => ({ ...tab }));
    },
    async sendMessage(tabId, message) {
      tabs.sent.push({ tabId, message });
      if (tabs.rejectSendMessage) {
        // 真机在没有接收方（chrome://、未注入内容脚本的页面）时就是这个拒绝。
        throw new Error(`Could not establish connection. Receiving end does not exist.（tab ${tabId}）`);
      }
      return undefined;
    },
  };
  return tabs;
}

export function createChromeStub(): ChromeStub {
  const local = createStorageArea();
  const session = createStorageArea();
  const tabs = createTabs();
  const contextMenus = createContextMenus();

  const stub: ChromeStub = {
    storage: { local, session },
    runtime: createRuntime(),
    commands: {
      onCommand: createEvent<(command: string, tab?: StubTab) => void>(),
      run(command) {
        void stub.commands.onCommand.emit(command);
      },
    },
    contextMenus,
    tabs,
    async reset() {
      await Promise.all([local.clear(), session.clear()]);
      contextMenus.created = [];
      contextMenus.removeAllCalls = 0;
      tabs.activeTabs = [{ ...DEFAULT_ACTIVE_TAB }];
      tabs.queries = [];
      tabs.sent = [];
      tabs.rejectSendMessage = false;
    },
  };
  return stub;
}

/** 装好替身并返回它；必须在 import 任何用到 `chrome` 的模块**之前**调用。 */
export function installChromeStub(): ChromeStub {
  const stub = createChromeStub();
  (globalThis as unknown as { chrome: ChromeStub }).chrome = stub;
  return stub;
}
