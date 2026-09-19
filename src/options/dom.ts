// src/options/dom.ts
//
// 设置页各区块共用的最小 DOM 工具。**这里不碰存储**：写存储一律走 `store.ts`，
// 本文件只负责"造节点 / 填下拉 / 写状态行 / 兜住拒绝"。

export type StatusKind = 'ok' | 'err' | 'pending';

/**
 * 写入状态行的**唯一手段**：`data-kind` 与文案永远一起设（分开写就会出现"颜色是绿的、
 * 文案还是上一次那句"的中间态）。文案一律 `textContent`——用户数据不许走 HTML 解析（规格 §7）。
 *
 * ⚠ **本文件里不许写出那三个 HTML 注入面的标识符**（`tests/options/no-innerhtml.test.ts`
 * 顶部 `FORBIDDEN` 正则里那三个）：该守卫按**裸标识符**扫源码文本、**连注释一起扫**
 * （口径是有意的"往严格一侧失败"），所以想提这件事只能用描述性说法——**这段注释自己就是
 * 一次实例**：第一版把它写了出来，守卫当场红了。别"顺手补全"它。
 */
export function setStatus(element: HTMLElement, kind: StatusKind, message: string): void {
  element.dataset.kind = kind;
  element.textContent = message;
}

export function describe(raw: unknown): string {
  return raw instanceof Error ? raw.message : String(raw);
}

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function fillSelect(
  select: HTMLSelectElement,
  entries: ReadonlyArray<{ value: string; label: string }>,
  value: string,
): void {
  select.textContent = '';
  for (const entry of entries) {
    const option = document.createElement('option');
    option.value = entry.value;
    option.textContent = entry.label;
    option.selected = entry.value === value;
    select.append(option);
  }
}

export function requireWithin<T extends Element>(root: Element, selector: string): T {
  const found = root.querySelector(selector);
  if (found === null) throw new Error(`区块里缺控件：${selector}`);
  return found as T;
}

/**
 * 任何没被就地处理的拒绝都要变成用户看得见的一句话：没有它，一次失败的 `await`
 * 会留下一个未处理的拒绝，界面停在半初始化状态——控件看着能点、点下去没反应。
 */
export function runSafely(status: HTMLElement, prefix: string, run: () => Promise<void>): void {
  void run().catch((raw: unknown) => {
    setStatus(status, 'err', `${prefix}：${describe(raw)}`);
  });
}
