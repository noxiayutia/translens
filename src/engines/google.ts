import { runPool } from '../core/pool';
import { EngineError, toEngineError, type EngineConfig, type TranslateRequest, type Translator } from './types';

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

/**
 * 单个批次内部的并发上限。
 * 免费接口对突发请求很敏感：一个批次最多 12 段文本、内容脚本又有 3 路并发，
 * 无上限时最坏会同时打出 36 个请求，直接触发限流；429 又会让整批退避重试，反而打出更多请求。
 */
const MAX_CONCURRENCY = 4;

/** Google 用 zh-CN / zh-TW，其余语言代码与 BCP-47 主标签一致。 */
export function toGoogleLang(code: string): string {
  if (code === 'zh-Hans') return 'zh-CN';
  if (code === 'zh-Hant') return 'zh-TW';
  return code;
}

/**
 * 免费接口返回 [[[译文片段, 原文片段, ...], ...], null, 源语言, ...]。
 * 所有片段首尾相接才是完整译文。
 */
export function parseGoogleResponse(data: unknown): string {
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new EngineError('BAD_RESPONSE', '免费接口返回格式异常');
  }
  const parts: string[] = [];
  for (const chunk of data[0] as unknown[]) {
    if (Array.isArray(chunk) && typeof chunk[0] === 'string') parts.push(chunk[0]);
  }
  const text = parts.join('');
  if (text.length === 0) throw new EngineError('BAD_RESPONSE', '免费接口返回空译文');
  return text;
}

export async function translateOne(text: string, to: string, signal: AbortSignal): Promise<string> {
  const url =
    `${ENDPOINT}?client=gtx&sl=auto&dt=t` +
    `&tl=${encodeURIComponent(toGoogleLang(to))}` +
    `&q=${encodeURIComponent(text)}`;

  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (raw) {
    if (signal.aborted) throw new EngineError('ABORTED', '请求已取消');
    const err = toEngineError(raw);
    throw new EngineError('NETWORK', `免费接口请求失败：${err.message}`);
  }

  if (response.status === 429) throw new EngineError('RATE_LIMIT', '免费接口触发限流，请稍后重试或切换到自定义 API');
  if (response.status === 401 || response.status === 403) throw new EngineError('AUTH', '免费接口拒绝访问，请切换到自定义 API');
  if (response.status === 413) throw new EngineError('TOO_LONG', '文本过长');
  if (!response.ok) throw new EngineError('NETWORK', `免费接口 HTTP ${response.status}`);

  let data: unknown;
  try {
    data = await response.json();
  } catch (raw) {
    throw new EngineError('BAD_RESPONSE', `接口返回的不是合法 JSON：${toEngineError(raw).message}`);
  }

  return parseGoogleResponse(data);
}

export const googleEngine: Translator = {
  id: 'google',
  name: 'Google 免费接口',
  needsKey: false,
  supportsGlossary: false,
  async translate(request: TranslateRequest, _config: EngineConfig): Promise<string[]> {
    // 免费接口不支持一次请求多条文本，只能逐条发出；用并发池限制突发。
    const tasks = request.texts.map((text) => () => translateOne(text, request.to, request.signal));
    return runPool(tasks, MAX_CONCURRENCY);
  },
};
