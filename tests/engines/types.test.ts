import { describe, expect, it } from 'vitest';
import { EngineError, RETRYABLE_CODES, toEngineError } from '../../src/engines/types';

describe('EngineError', () => {
  it('网络错误与限流可重试', () => {
    expect(new EngineError('NETWORK', 'x').retryable).toBe(true);
    expect(new EngineError('RATE_LIMIT', 'x').retryable).toBe(true);
  });

  it('文本过长不可重试：超长要靠切分而不是原样重发', () => {
    // 文本过长是确定性失败，拿同一段文本重问一次必然还是过长，只白烧两次请求；
    // 它该走的是调度器的切分降级。判据与调度器共用 RETRYABLE_CODES，不能各写一份。
    expect(RETRYABLE_CODES.has('TOO_LONG')).toBe(false);
    expect(new EngineError('TOO_LONG', 'x').retryable).toBe(false);
  });

  it('鉴权失败与格式错误不可重试', () => {
    expect(new EngineError('AUTH', 'x').retryable).toBe(false);
    expect(new EngineError('BAD_RESPONSE', 'x').retryable).toBe(false);
  });

  it('retryable 只由导出的 RETRYABLE_CODES 决定', () => {
    expect([...RETRYABLE_CODES].sort()).toEqual(['NETWORK', 'RATE_LIMIT']);
    for (const code of ['NETWORK', 'RATE_LIMIT', 'AUTH', 'TOO_LONG', 'BAD_RESPONSE', 'ABORTED', 'UNKNOWN'] as const) {
      expect(new EngineError(code, 'x').retryable).toBe(RETRYABLE_CODES.has(code));
    }
  });

  it('保留错误码与消息', () => {
    const err = new EngineError('AUTH', '缺少 API Key');
    expect(err.code).toBe('AUTH');
    expect(err.message).toBe('缺少 API Key');
    expect(err.name).toBe('EngineError');
  });
});

describe('toEngineError', () => {
  it('EngineError 原样返回', () => {
    const err = new EngineError('AUTH', 'x');
    expect(toEngineError(err)).toBe(err);
  });

  it('AbortError 转成 ABORTED', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(toEngineError(abort).code).toBe('ABORTED');
  });

  it('未知错误转成 UNKNOWN 并保留消息', () => {
    const err = toEngineError(new Error('boom'));
    expect(err.code).toBe('UNKNOWN');
    expect(err.message).toBe('boom');
  });

  it('保留原始错误为 cause', () => {
    const raw = new TypeError('boom');
    expect(toEngineError(raw).cause).toBe(raw);

    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(toEngineError(abort).cause).toBe(abort);
  });

  it('非 Error 值也能处理', () => {
    expect(toEngineError('oops').code).toBe('UNKNOWN');
    expect(toEngineError('oops').message).toBe('oops');
  });
});
