export interface Term {
  from: string;
  to: string;
}

export interface TranslateRequest {
  texts: string[];
  from: string;
  to: string;
  glossary?: Term[];
  systemPrompt?: string;
  signal: AbortSignal;
}

export interface EngineConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export type EngineErrorCode =
  | 'NETWORK'
  | 'RATE_LIMIT'
  | 'AUTH'
  | 'BAD_REQUEST'
  | 'TOO_LONG'
  | 'BAD_RESPONSE'
  | 'ABORTED'
  | 'UNKNOWN';

/**
 * 可退避重试的错误码：网络抖动与限流重发还有机会成功。
 *
 * 有意不含这两个：
 * - `TOO_LONG`：文本过长是确定性失败，拿同一段文本原样重发必然还是过长，它该走切分降级。
 * - `BAD_REQUEST`：服务端明确说"你这个请求不对"（模型名写错、参数不合法…），重发多少次
 *   都是同一个 400。把它归进 `NETWORK` 会让调度器白重试三次、页面上再挂一排点了也没用的
 *   重试按钮——用户真正需要的是看到服务商给的原因，然后去设置页改。
 *
 * 这是全仓唯一一份判据，调度器与内容脚本直接复用它，避免几处集合各说各话。
 */
export const RETRYABLE_CODES: ReadonlySet<EngineErrorCode> = new Set<EngineErrorCode>([
  'NETWORK',
  'RATE_LIMIT',
]);

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly retryable: boolean;

  constructor(code: EngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EngineError';
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
  }
}

export function toEngineError(raw: unknown): EngineError {
  if (raw instanceof EngineError) return raw;
  if (raw instanceof Error) {
    // 保留原始错误：fetch 失败带的 cause、超时属性等要靠它才能追查。
    const options: ErrorOptions = { cause: raw };
    if (raw.name === 'AbortError') return new EngineError('ABORTED', '请求已取消', options);
    return new EngineError('UNKNOWN', raw.message, options);
  }
  return new EngineError('UNKNOWN', String(raw));
}

export interface Translator {
  id: string;
  name: string;
  /** 需要 API Key 的引擎为 true，弹窗据此显示红色状态点 */
  needsKey: boolean;
  /** 是否支持 system prompt；为 false 时术语表与自定义提示词不生效 */
  supportsGlossary: boolean;
  /**
   * 这个适配器是否需要"模型"这个概念。
   *
   * 它是契约的一部分（与 `needsKey` / `supportsGlossary` 同一类），承重处在两处：
   * `resolveEngine` 据此决定"档案没有当前模型"算不算错误（§4.2），`firstUsableProfileId`
   * 据此决定一个档案可不可用（§4.4）。为 `false` 的类型（传统翻译 API）档案不需要模型清单，
   * `config.model` 交出去的是 `undefined` 而不是空串。
   */
  needsModel: boolean;
  translate(request: TranslateRequest, config: EngineConfig): Promise<string[]>;
}
