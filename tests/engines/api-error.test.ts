// tests/engines/api-error.test.ts
/**
 * 失败响应体的解读。
 *
 * 这一层的价值在实测里被证明过：用户把模型名填成 `deepseek`（正确值是 `deepseek-chat`），
 * DeepSeek 返回 `400 {"error":{"message":"Model Not Exist"}}`，而界面上只显示了
 * 「接口 HTTP 400」——真正的原因被丢掉了，用户只能靠猜。所以这里既要把原因挖出来，
 * 也要保证挖的过程本身不会出问题（正文不是 JSON、为空、超长、带换行）。
 */
import { describe, expect, it } from 'vitest';
import { describeHttpError, extractErrorDetail, statusToErrorCode } from '../../src/engines/api-error';

function responseOf(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

describe('extractErrorDetail', () => {
  it('取出 OpenAI 风格的 error.message —— 这就是 DeepSeek 的真实返回形状', () => {
    expect(extractErrorDetail('{"error":{"message":"Model Not Exist","type":"invalid_request_error"}}')).toBe(
      'Model Not Exist',
    );
  });

  it('error 直接是字符串时也能取', () => {
    expect(extractErrorDetail('{"error":"invalid api key"}')).toBe('invalid api key');
  });

  it('只有顶层 message 时也能取', () => {
    expect(extractErrorDetail('{"message":"rate limited"}')).toBe('rate limited');
  });

  it('不是 JSON 时退回纯文本（网关的 HTML 错误页很常见）', () => {
    expect(extractErrorDetail('<html><body>502 Bad Gateway</body></html>')).toBe(
      '<html><body>502 Bad Gateway</body></html>',
    );
  });

  it('空正文返回空串，不编造内容', () => {
    expect(extractErrorDetail('')).toBe('');
    expect(extractErrorDetail('   \n  ')).toBe('');
  });

  it('JSON 里没有可读 message 时退回原文，而不是返回空', () => {
    expect(extractErrorDetail('{"code":400,"detail":"unrecognized"}')).toBe('{"code":400,"detail":"unrecognized"}');
  });

  it('折成一行并截断，避免把整页 HTML 灌进页面提示', () => {
    const detail = extractErrorDetail(`line one\n\nline   two`);
    expect(detail).toBe('line one line two');

    const long = extractErrorDetail('x'.repeat(500));
    expect(long).toHaveLength(201); // 200 + 省略号
    expect(long.endsWith('…')).toBe(true);
  });

  it('JSON 是数组或标量时不崩', () => {
    expect(extractErrorDetail('[1,2,3]')).toBe('[1,2,3]');
    expect(extractErrorDetail('"just a string"')).toBe('"just a string"');
    expect(extractErrorDetail('null')).toBe('null');
  });
});

describe('statusToErrorCode', () => {
  it('4xx 是「请求不对」，不该当成可重试的网络故障', () => {
    // 400 正是模型名写错时 DeepSeek 给的码。归成 NETWORK 会让调度器白退避重试三次，
    // 并给用户挂一排点了也没用的重试按钮。
    expect(statusToErrorCode(400)).toBe('BAD_REQUEST');
    expect(statusToErrorCode(404)).toBe('BAD_REQUEST');
    expect(statusToErrorCode(422)).toBe('BAD_REQUEST');
  });

  it('5xx 与 408 是服务端临时故障，值得重试', () => {
    expect(statusToErrorCode(500)).toBe('NETWORK');
    expect(statusToErrorCode(502)).toBe('NETWORK');
    expect(statusToErrorCode(503)).toBe('NETWORK');
    expect(statusToErrorCode(408)).toBe('NETWORK');
  });
});

describe('describeHttpError', () => {
  it('带上状态码与正文原因', async () => {
    await expect(describeHttpError(responseOf('{"error":{"message":"Model Not Exist"}}', 400))).resolves.toBe(
      '接口 HTTP 400：Model Not Exist',
    );
  });

  it('正文读不出原因时只留状态码，不编造', async () => {
    await expect(describeHttpError(responseOf('', 503))).resolves.toBe('接口 HTTP 503');
  });
});
