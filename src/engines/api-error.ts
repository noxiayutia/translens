// src/engines/api-error.ts

/**
 * 从**失败响应**的正文里挖出服务商自己给出的原因。
 *
 * 为什么必须做：各家接口都把真正的失败原因写在响应体里，而 HTTP 状态码只说明"哪一类"。
 * DeepSeek 对写错的模型名返回 `400 {"error":{"message":"Model Not Exist"}}`——
 * 只看状态码的话，用户拿到的是一句"接口 HTTP 400"，完全不知道该去改模型名。
 * 实测就是这么卡住的：用户填了 `deepseek`（正确值是 `deepseek-chat`），
 * 界面上只显示 400，看不出任何线索。
 *
 * 读正文要防御三件事：正文可能不是 JSON（网关返回 HTML）、可能是空、
 * 可能超长（把整页 HTML 塞进错误提示里）。
 */

/** 正文里最多取多少字符进错误提示。够说清原因，又不会把提示撑爆。 */
const MAX_DETAIL_LENGTH = 200;

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_DETAIL_LENGTH ? `${oneLine.slice(0, MAX_DETAIL_LENGTH)}…` : oneLine;
}

/** OpenAI 风格是 `{error:{message}}`；也有服务商直接给 `{message}` 或 `{error:"…"}`。 */
function pickMessage(payload: Record<string, unknown>): string | undefined {
  const { error } = payload;
  if (typeof error === 'string') return error;
  if (error !== null && typeof error === 'object') {
    const inner = (error as Record<string, unknown>).message;
    if (typeof inner === 'string') return inner;
  }
  if (typeof payload.message === 'string') return payload.message;
  return undefined;
}

/** 纯函数，单独导出便于单测。读不出东西时返回空串。 */
export function extractErrorDetail(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) return '';
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const message = pickMessage(parsed as Record<string, unknown>);
      if (message !== undefined && message.trim().length > 0) return truncate(message);
      // JSON 里没有可读的 message，就把原文整段折成一行。
    }
  } catch {
    // 不是 JSON（网关的 HTML 错误页很常见），当纯文本处理。
  }
  return truncate(text);
}

/** 把一次失败响应转成一句能指导用户下一步的错误文案。 */
export async function describeHttpError(response: Response): Promise<string> {
  let detail = '';
  try {
    detail = extractErrorDetail(await response.text());
  } catch {
    // 正文读不出来（流被中断等）不算错误：状态码本身仍然有信息量。
  }
  return detail.length > 0
    ? `接口 HTTP ${response.status}：${detail}`
    : `接口 HTTP ${response.status}`;
}

/**
 * 非 2xx 响应该归到哪一类错误。
 *
 * 4xx 是"你这个请求不对"（模型名写错、参数不合法、地址不对），重发多少次都是同一个结果，
 * 归成可重试的 `NETWORK` 只会让调度器白退避重试、并给用户挂一排没用的重试按钮。
 * 5xx 与 408 才是服务端临时故障，值得重试。
 */
export function statusToErrorCode(status: number): 'NETWORK' | 'BAD_REQUEST' {
  return status >= 500 || status === 408 ? 'NETWORK' : 'BAD_REQUEST';
}
