import type { StorageArea } from '../../src/core/cache';

/** 两种宿主配额的模拟开关，都按"`JSON.stringify` 后的 UTF-8 字节数"计量。 */
export interface MemoryStorageOptions {
  /**
   * 模拟宿主对**单个存储值**的上限（`QUOTA_BYTES_PER_ITEM`）：
   * 任一条值的字节数超过它，整批写入失败并抛错。
   */
  maxItemBytes?: number;
  /** 模拟存储区**总量**上限（`QUOTA_BYTES`）：写入后总量超过它，整批写入失败并抛错。 */
  maxTotalBytes?: number;
}

/** 与宿主一致的字节口径：值先 JSON 序列化，再按 UTF-8 计长。 */
function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
}

export class MemoryStorage implements StorageArea {
  private readonly data = new Map<string, unknown>();
  /** 每个 key 当前占用的字节数，用来在总量上限下即时算出写入后的占用。 */
  private readonly bytes = new Map<string, number>();
  /** 单条值上限；可随时调整 */
  maxItemBytes?: number;
  /** 总量上限；可随时调整——写满之后再调成当前占用，就能模拟"配额刚好用尽" */
  maxTotalBytes?: number;
  /** 记录写入**尝试**次数（含被配额拒绝的），用于断言缓存命中时没有多余写入 */
  setCalls = 0;
  /** 记录被配额拒绝的写入次数，用来断言"写失败"确实发生过 */
  rejectedWrites = 0;
  /** 历次成功写入里最大的单条值字节数，用来断言从没写出过大值 */
  maxItemBytesSeen = 0;

  constructor(options: MemoryStorageOptions = {}) {
    this.maxItemBytes = options.maxItemBytes;
    this.maxTotalBytes = options.maxTotalBytes;
  }

  async get(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (this.data.has(key)) out[key] = structuredClone(this.data.get(key));
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.setCalls += 1;
    const entries = Object.entries(items);

    // 先把"写完之后"的占用算出来，任何一条越界都整批不落盘（宿主也是整批失败）。
    const next = new Map(this.bytes);
    for (const [key, value] of entries) {
      const size = byteLength(value);
      if (this.maxItemBytes !== undefined && size > this.maxItemBytes) {
        this.rejectedWrites += 1;
        throw new Error(`单个存储值超出上限：${key} 需要 ${size} 字节`);
      }
      next.set(key, size);
    }
    if (this.maxTotalBytes !== undefined) {
      let total = 0;
      for (const size of next.values()) total += size;
      if (total > this.maxTotalBytes) {
        this.rejectedWrites += 1;
        throw new Error(`存储区总量超出上限：需要 ${total} 字节`);
      }
    }

    for (const [key, value] of entries) {
      const size = next.get(key) as number;
      this.maxItemBytesSeen = Math.max(this.maxItemBytesSeen, size);
      this.data.set(key, structuredClone(value));
      this.bytes.set(key, size);
    }
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.data.delete(key);
      this.bytes.delete(key);
    }
  }

  async keys(): Promise<string[]> {
    return [...this.data.keys()];
  }

  size(): number {
    return this.data.size;
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  /** 当前占用的总字节数 */
  bytesUsed(): number {
    let total = 0;
    for (const size of this.bytes.values()) total += size;
    return total;
  }
}
