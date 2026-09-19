// src/options/dom.ts
//
// 设置页各区块共用的最小 DOM 工具。**这里不碰存储**：写存储一律走 `store.ts`，
// 本文件只负责"造节点 / 填下拉 / 写状态行 / 兜住拒绝"。

export type StatusKind = 'ok' | 'err' | 'pending';

/** 状态行的唯一出口：`data-kind` 决定颜色，文案一律 `textContent`（规格 §7：用户数据不许走 HTML 解析）。 */
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
