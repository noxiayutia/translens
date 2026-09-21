// tests/options/harness.ts
/**
 * 设置页测试的共享夹具：`options.test.ts` 与各区块的测试文件共用一份。
 *
 * 用例顺序是固定的，不能改：装替身 → 写存储 → 装 DOM → `import` 设置页模块 → 等初始化。
 * 被测模块在 **import 时**就跑 `init()`：模块顶层按 id 取 DOM 元素（DOM 必须先就位），
 * `init()` 同步挂好监听器，然后才 `await loadSettings()`。`vi.resetModules()` 保证每个
 * 用例拿到一份新的模块实例（页面里持有当前设置快照）。
 *
 * DOM 用 `src/options/options.html` 的**真实内容**（`DOMParser` 解析后取 body），不手抄一份
 * 结构。动态渲染的行一律按 `data-*` 契约找、按 `data-action` 点——与实现共用的是**契约**
 * （这些属性名），不是查询细节。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { CURRENT_VERSION, SETTINGS_KEY } from '../../src/shared/settings';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';

/**
 * 用 `import.meta.dirname` 拼路径，而不是 `new URL('...', import.meta.url)`：后者会被
 * Vite 的资源转换改写成 http 地址（jsdom 环境下 `fileURLToPath` 直接拒绝它）。
 */
const OPTIONS_HTML_PATH = join(import.meta.dirname, '..', '..', 'src', 'options', 'options.html');

export const CUSTOM_BASE_URL = 'https://api.example.com/v1';
/** 与 shared/host-permission 的 originPattern 同形：申请授权的对象是整串匹配模式。 */
export const CUSTOM_ORIGIN_PATTERN = 'https://api.example.com/*';

/**
 * 当前用例的 chrome 替身，由 {@link resetOptionsPage} 在每个用例的 `beforeEach` 里重装。
 * 用 `export let`：ESM 的实时绑定保证用例读到的一定是**这一条**用例的那份替身。
 */
export let chromeStub: ChromeStub;

/** 每个用例的 `beforeEach` 里调用（顺序与本仓库既有的写法一致）。 */
export function resetOptionsPage(): void {
  document.body.innerHTML = '';
  vi.resetModules();
  chromeStub = installChromeStub();
}

/** 档案的种子形状（v4）；用例只覆盖自己在意的那几个字段。 */
export function profileSeed(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p-a',
    label: '我的 DeepSeek',
    baseUrl: CUSTOM_BASE_URL,
    models: ['deepseek-chat'],
    activeModel: 'deepseek-chat',
    apiKey: 'sk-a',
    ...over,
  };
}

/** 带一个指定模型的档案种子（绝大多数字段用例只关心"这个档案用哪个模型"）。 */
export function profileWithModel(model: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return profileSeed({ models: [model], activeModel: model, ...over });
}

/**
 * 把某一行的模型设成 `model`——**编辑面板里"改模型"这件事的唯一夹具入口**。
 *
 * C4 之后走的是**真实用户路径**：点「+ 添加模型」→ 往手填框里填名字 → 点「添加」。
 * 于是"空值与重复值不写入"的判据也被这些用例顺带走过（它们本来只关心"模型改了"）。
 */
export function setModel(editor: Element, model: string): void {
  editor.querySelector<HTMLButtonElement>('[data-action="add-model"]')!.click();
  fieldOf(editor, '.profile-model-new').value = model;
  editor.querySelector<HTMLButtonElement>('[data-action="confirm-model"]')!.click();
}

/** 读回"这一行现在的模型"：清单里带 `data-current` 的那一项（一项都没有就是空串）。 */
export function currentModel(editor: Element): string {
  const row = editor.querySelector<HTMLElement>('.model-row[data-current]');
  return row === null ? '' : (row.dataset.model as string);
}

/**
 * 折叠行右侧的行级按钮（`编辑` / `删除`）。它们**不在** `.profile-editor` 里，
 * 所以 `actionButton(editor, …)` 找不到它们。
 */
export function rowButton(id: string, action: string): HTMLButtonElement {
  const button = rowOf(id).querySelector<HTMLButtonElement>(`.row-actions [data-action="${action}"]`);
  if (button === null) throw new Error(`档案行 ${id} 缺按钮 ${action}`);
  return button;
}

export function pick<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`options.html 里没有 #${id}`);
  return found as T;
}

/** 全部档案行（含"新增"草稿行），按渲染顺序。 */
export function profileRows(): HTMLElement[] {
  return Array.from(pick<HTMLElement>('profiles').querySelectorAll<HTMLElement>('.profile-row[data-profile-id]'));
}

export function rowOf(id: string): HTMLElement {
  const row = profileRows().find((candidate) => candidate.dataset.profileId === id);
  if (row === undefined) throw new Error(`档案行不存在：${id}`);
  return row;
}

export function editorOf(id: string): Element {
  const editor = rowOf(id).querySelector('.profile-editor');
  if (editor === null) throw new Error(`档案 ${id} 没有展开编辑区`);
  return editor;
}

export function fieldOf(editor: Element, selector: string): HTMLInputElement {
  const input = editor.querySelector<HTMLInputElement>(selector);
  if (input === null) throw new Error(`编辑区缺控件 ${selector}`);
  return input;
}

export function actionButton(editor: Element, action: string): HTMLButtonElement {
  const button = editor.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  if (button === null) throw new Error(`编辑区缺按钮 ${action}`);
  return button;
}

/** 展开某个档案的编辑区（点它自己那一行右侧的「编辑」；已经展开就原样返回，点了不重复收起）。 */
export function expand(id: string): Element {
  const row = rowOf(id);
  const existing = row.querySelector('.profile-editor');
  if (existing !== null) return existing;
  row.querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
  return editorOf(id);
}

/** jsdom 的 `new Event(...)` 默认不冒泡；区块里的监听是事件委托，必须带 bubbles。 */
export function bubble(type: string): Event {
  return new Event(type, { bubbles: true });
}

/** 往存储里写一份**故意不完整**的设置：`loadSettings` 是逐字段补齐的反序列化边界。 */
export async function seedSettings(patch: Record<string, unknown> = {}): Promise<void> {
  await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: CURRENT_VERSION, ...patch } });
}

/**
 * 「这条用例需要一个**能用的**引擎」的显式夹具入口。
 *
 * 默认设置是 `engineId: ''` + `profiles: []` = **没有可用引擎**（v5 起 `''` 就是这个意思）。
 * 凡是没有显式声明引擎的用例都会落到那个状态——这不是回归，而是把一条一直存在的隐性前提
 * **显式化**：需要引擎的用例从此在夹具名上就看得出来。**不许**靠"把默认值改回某个 id"
 * 让它们继续绿。
 */
export async function seedWithProfile(patch: Record<string, unknown> = {}): Promise<void> {
  await seedSettings({ engineId: 'p-a', profiles: [profileSeed()], ...patch });
}

/** 直读存储：验证「改动真的落盘了」，而不是只改了页面里的内存副本。 */
export async function storedSettings(): Promise<Record<string, unknown>> {
  const raw = await chromeStub.storage.local.get([SETTINGS_KEY]);
  return (raw[SETTINGS_KEY] ?? {}) as Record<string, unknown>;
}

export async function storedProfiles(): Promise<Array<Record<string, unknown>>> {
  return ((await storedSettings()).profiles ?? []) as Array<Record<string, unknown>>;
}

export function mountOptionsHtml(): void {
  const html = readFileSync(OPTIONS_HTML_PATH, 'utf-8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
}

/** 让已经排队的微任务跑完（替身里的存储与权限调用都是立即兑现的 promise）。 */
export async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 轮询直到条件成立（点击后的收尾是异步的）。 */
export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('waitFor 超时：条件始终不成立');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 装 DOM、import 设置页模块，并等 `start()` 那串 await（loadSettings → 各区块 mount）跑完。 */
export async function loadOptions(): Promise<void> {
  mountOptionsHtml();
  await import('../../src/options/options');
  await settle();
}

export function engineStatus(): HTMLElement {
  return pick<HTMLElement>('engine-status');
}

/**
 * 引擎只读 `status` / `ok` / `json()`，所以不必真的构造 `Response`——jsdom 环境里
 * 全局 `Response` 是 Node 那份，用它只会把用例和运行时实现绑在一起。
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => data } as unknown as Response;
}

/** OpenAI 兼容接口的编号响应。 */
export function chatResponse(content: string): Response {
  return jsonResponse({ choices: [{ message: { role: 'assistant', content } }] });
}
