// src/shared/chrome-area.ts
import type { StorageArea } from '../core/cache';

/** 把 chrome.storage 的 StorageArea 适配成本项目可测试的 StorageArea。 */
export function chromeArea(area: chrome.storage.StorageArea): StorageArea {
  return {
    get: (keys) => area.get(keys) as Promise<Record<string, unknown>>,
    set: (items) => area.set(items) as Promise<void>,
    remove: (keys) => area.remove(keys) as Promise<void>,
  };
}
