// src/content/inline-types.ts

/**
 * 悬停/划词共用的翻译入口类型。
 *
 * 它是一个**契约**而不是消息协议：index.ts 负责把它接到 `MSG.TRANSLATE_TEXTS` +
 * `sendToBackground`（缓存、重试、超时都在后台那一侧），hover/selection 只消费这个形状，
 * 于是两个模块都能在没有 chrome 替身的环境里单测。
 */
export type InlineTranslation = { ok: true; text: string } | { ok: false; message: string };

export type InlineTranslator = (text: string) => Promise<InlineTranslation>;

/** 请求在飞时气泡里的占位文案。两个模块共用，措辞与整页翻译的 pending 态一致。 */
export const PENDING_TEXT = '翻译中…';
