import { describe, expect, it } from 'vitest';
import {
  MSG,
  isFetchModelsMessage,
  isTranslateTextsMessage,
  type FetchModelsMessage,
  type TranslateTextsMessage,
} from '../../src/shared/messages';

describe('MSG', () => {
  it('消息类型常量取值唯一', () => {
    const values = Object.values(MSG);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('isTranslateTextsMessage', () => {
  it('识别合法的翻译请求', () => {
    const message: TranslateTextsMessage = {
      type: MSG.TRANSLATE_TEXTS,
      payload: { items: [{ id: 'jy-1', text: 'Hello' }] },
    };
    expect(isTranslateTextsMessage(message)).toBe(true);
  });

  it('允许空批次（形状合法，空只是发送方的约定）', () => {
    expect(isTranslateTextsMessage({ type: MSG.TRANSLATE_TEXTS, payload: { items: [] } })).toBe(true);
  });

  it('拒绝 payload 缺失的消息', () => {
    expect(isTranslateTextsMessage({ type: MSG.TRANSLATE_TEXTS })).toBe(false);
  });

  it('拒绝 items 不是数组的消息', () => {
    expect(isTranslateTextsMessage({ type: MSG.TRANSLATE_TEXTS, payload: { items: 'x' } })).toBe(false);
  });

  it('拒绝元素结构不对的消息', () => {
    expect(
      isTranslateTextsMessage({ type: MSG.TRANSLATE_TEXTS, payload: { items: [{ id: 1, text: 2 }] } }),
    ).toBe(false);
  });

  it('拒绝 targetLang 类型不对的消息', () => {
    expect(
      isTranslateTextsMessage({
        type: MSG.TRANSLATE_TEXTS,
        payload: { items: [{ id: 'jy-1', text: 'Hello' }], targetLang: 123 },
      }),
    ).toBe(false);
  });

  it('允许省略 targetLang', () => {
    expect(
      isTranslateTextsMessage({ type: MSG.TRANSLATE_TEXTS, payload: { items: [{ id: 'jy-1', text: 'Hi' }] } }),
    ).toBe(true);
    expect(
      isTranslateTextsMessage({
        type: MSG.TRANSLATE_TEXTS,
        payload: { items: [{ id: 'jy-1', text: 'Hi' }], targetLang: 'ja' },
      }),
    ).toBe(true);
  });

  it('拒绝其它类型的消息', () => {
    expect(isTranslateTextsMessage({ type: MSG.GET_PAGE_STATE })).toBe(false);
    expect(isTranslateTextsMessage(null)).toBe(false);
  });
});

describe('isFetchModelsMessage', () => {
  it('识别合法的拉取请求', () => {
    const message: FetchModelsMessage = { type: MSG.FETCH_MODELS, payload: { profileId: 'p-a' } };
    expect(isFetchModelsMessage(message)).toBe(true);
  });

  it('拒绝缺 payload / profileId 不是非空字符串的消息（跨进程边界不能只信类型）', () => {
    const cases: unknown[] = [
      { type: MSG.FETCH_MODELS },
      { type: MSG.FETCH_MODELS, payload: {} },
      { type: MSG.FETCH_MODELS, payload: { profileId: '' } },
      { type: MSG.FETCH_MODELS, payload: { profileId: 7 } },
      { type: MSG.FETCH_MODELS, payload: 'p-a' },
      null,
    ];
    for (const message of cases) expect([message, isFetchModelsMessage(message)]).toEqual([message, false]);
  });

  it('两个校验器互不认领：翻译消息不是拉取消息，反之亦然', () => {
    expect(isFetchModelsMessage({ type: MSG.TRANSLATE_TEXTS, payload: { items: [] } })).toBe(false);
    expect(isTranslateTextsMessage({ type: MSG.FETCH_MODELS, payload: { profileId: 'p-a' } })).toBe(false);
  });
});
