import { EngineError, toEngineError, type EngineConfig, type TranslateRequest, type Translator } from './types';

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

/** Google 用 zh-CN / zh-TW，其余语言代码与 BCP-47 主标签一致。 */
export function toGoogleLang(code: string): string {
  if (code === 'zh-Hans') return 'zh-CN';
  if (code === 'zh-Hant') return 'zh-TW';
  return code;
}

/** 句子数组形如 [[译文片段, 原文片段, ...], ...]：元素是数组，且每条的首项就是译文。 */
function isSentenceList(value: unknown): value is unknown[] {
  return Array.isArray(value) && Array.isArray(value[0]) && typeof (value[0] as unknown[])[0] === 'string';
}

/** 外层信封最多下钻几层，避免畸形（甚至自引用）返回把解析拖成死循环。 */
const MAX_ENVELOPE_DEPTH = 4;

/**
 * 免费接口返回 [[[译文片段, 原文片段, ...], ...], null, 源语言, ...]，句子数组就在 data[0]。
 * 但部分网关会把整包再包一层，所以按下标逐层下钻找**结构上**的句子数组，
 * 而不是写死 data[0]：两种形状都能解析，写死会在多包一层时静默返回空译文。
 */
function locateSentenceList(data: unknown): unknown[] {
  let node: unknown = data;
  for (let depth = 0; depth <= MAX_ENVELOPE_DEPTH && Array.isArray(node); depth += 1) {
    if (isSentenceList(node)) return node;
    node = node[0];
  }
  throw new EngineError('BAD_RESPONSE', '免费接口返回格式异常');
}

/** 所有片段首尾相接才是完整译文。 */
export function parseGoogleResponse(data: unknown): string {
  const parts: string[] = [];
  for (const chunk of locateSentenceList(data)) {
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

  return parseGoogleResponse(await response.json());
}

export const googleEngine: Translator = {
  id: 'google',
  name: 'Google 免费接口',
  needsKey: false,
  supportsGlossary: false,
  async translate(request: TranslateRequest, _config: EngineConfig): Promise<string[]> {
    // 免费接口不支持一次请求多条文本，逐条并发发出。
    return Promise.all(request.texts.map((text) => translateOne(text, request.to, request.signal)));
  },
};
