/**
 * 32 位双通道哈希（FNV-1a + murmur 混合）。
 * 同步、无依赖，在 content script 与 service worker 中结果一致。
 */
export function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }
  return `${input.length.toString(36)}-${h1.toString(36)}-${h2.toString(36)}`;
}

export interface CacheKeyParts {
  engineId: string;
  /**
   * 引擎配置指纹（接口地址 + 模型名）。
   * openai-compat 下用户可以随时改模型（gpt-4o-mini → gpt-4o）或接口地址，
   * 这两项不参与 key 就会命中上一个模型的旧译文。
   * **apiKey 不进这里**：换 key 不该让全部缓存失效；且哈希输入会落进 storage，
   * 密钥不该出现在缓存键的输入里。它只影响鉴权，不影响译文本身。
   */
  configHash: string;
  /**
   * 源语言。`sourceLang` 是设置项，会一路传到 `TranslateRequest.from`；它不参与 key 时，
   * 用户把「自动检测」改成某个具体源语言（或反过来）之后，同一个引擎、同一段文本、同一个
   * 目标语言会命中**按另一种源语言语义**翻出来的旧译文，而且事后无法自愈。
   * 今天两个引擎都还没真的读 `from`（Google 把 `sl=auto` 硬编码），所以这条还没有可观察
   * 的错误；等接上就用错语义——key 必须在那之前就带上它。
   */
  sourceLang: string;
  targetLang: string;
  glossaryHash: string;
  promptHash: string;
  text: string;
}

/** 用 \u0000 分隔，避免字段拼接产生歧义（如 ("ab","c") 与 ("a","bc")）。 */
export function buildCacheKey(parts: CacheKeyParts): string {
  return hashString(
    [
      parts.engineId,
      parts.configHash,
      parts.sourceLang,
      parts.targetLang,
      parts.glossaryHash,
      parts.promptHash,
      parts.text,
    ].join('\u0000'),
  );
}
