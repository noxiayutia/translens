// src/shared/messages.ts
import type { EngineErrorCode } from '../engines/types';
import type { DisplayMode } from './settings';

export const MSG = {
  /** 内容脚本 → SW：请求翻译一批文本 */
  TRANSLATE_TEXTS: 'jinyi:translate-texts',
  /** 弹窗/快捷键 → 内容脚本：翻译或还原（由内容脚本按当前状态决定） */
  TOGGLE_PAGE: 'jinyi:toggle-page',
  /** 弹窗 → 内容脚本：明确要求翻译 */
  TRANSLATE_PAGE: 'jinyi:translate-page',
  /** 弹窗 → 内容脚本：明确要求还原 */
  RESTORE_PAGE: 'jinyi:restore-page',
  /** 弹窗 → 内容脚本：查询当前页面翻译状态 */
  GET_PAGE_STATE: 'jinyi:get-page-state',
  /** 右键菜单 → 内容脚本：翻译选中文本 */
  TRANSLATE_SELECTION: 'jinyi:translate-selection',
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

export interface TranslateItem {
  id: string;
  text: string;
}

export interface TranslateItemResult {
  id: string;
  text: string | null;
  code?: EngineErrorCode;
  message?: string;
}

export interface TranslateTextsMessage {
  type: typeof MSG.TRANSLATE_TEXTS;
  payload: {
    items: TranslateItem[];
    targetLang?: string;
  };
}

export type TranslateTextsResponse =
  | { ok: true; results: TranslateItemResult[] }
  | { ok: false; code: EngineErrorCode; message: string };

export interface PageState {
  translated: boolean;
  /** 这一轮翻译用的是哪种显示方式（弹窗按它告诉用户当前页面处于什么状态）。 */
  mode: DisplayMode;
  total: number;
  done: number;
  failed: number;
}

/**
 * 跨进程边界的消息必须在运行时校验，不能只信 TypeScript 类型。
 *
 * 只校验**形状**：空批次是发送方自己的约定（下游对 `items: []` 返回空结果即可），
 * 不是安全属性。把空批次判为非法，只会让一个良性请求收不到任何响应、变成悬空的 RPC。
 */
export function isTranslateTextsMessage(value: unknown): value is TranslateTextsMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<TranslateTextsMessage>;
  if (message.type !== MSG.TRANSLATE_TEXTS) return false;
  if (!message.payload || typeof message.payload !== 'object') return false;
  const payload = message.payload as { items?: unknown; targetLang?: unknown };
  if (!Array.isArray(payload.items)) return false;
  if (payload.targetLang !== undefined && typeof payload.targetLang !== 'string') return false;
  return payload.items.every(
    (item) =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as TranslateItem).id === 'string' &&
      typeof (item as TranslateItem).text === 'string',
  );
}
