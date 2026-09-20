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
  /**
   * 弹窗 → 内容脚本：「悬停翻译 / 划词翻译」开关改了。
   *
   * 这两个开关控制的是**监听器挂没挂**，只写进设置不会让当前页面已经挂上/缺席的监听
   * 自己出现或消失——弹窗必须把改动推给内容脚本，让它当场重新挂/摘，
   * 否则用户拨了开关、页面却纹丝不动（规格 §7.1 要求"改动即时生效"）。
   */
  APPLY_SETTINGS: 'jinyi:apply-settings',
  /**
   * 设置页 → service worker：拉取某个档案可用模型清单（`{接口地址}/models`）。
   *
   * 设置页**只传 `profileId`**（§5.1）：它持有全量设置（含 Key），把 Key 塞进消息等于把密钥
   * 又搬过一条通道，与现有「Key 不进内容脚本、不渲染进设置页 DOM」的隔离口径相矛盾。
   * 后台按这个 id 自己从存储读 `baseUrl` 与 `apiKey`。
   */
  FETCH_MODELS: 'jinyi:fetch-models',
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

export interface FetchModelsMessage {
  type: typeof MSG.FETCH_MODELS;
  payload: { profileId: string };
}

/**
 * `ok: true` 但 `models: []` = 「这个地址没有给出可用的模型清单」——**不是失败**
 * （§5.2：引导手填，而不是报错完事）。失败一律走 `ok: false` + 一句能读懂的话。
 */
export type FetchModelsResponse = { ok: true; models: string[] } | { ok: false; message: string };

/** 与 `isTranslateTextsMessage` 同一条纪律：只校验**形状**，空 profileId 是形状问题（它无法指代任何档案）。 */
export function isFetchModelsMessage(value: unknown): value is FetchModelsMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<FetchModelsMessage>;
  if (message.type !== MSG.FETCH_MODELS) return false;
  if (!message.payload || typeof message.payload !== 'object') return false;
  const payload = message.payload as { profileId?: unknown };
  return typeof payload.profileId === 'string' && payload.profileId.length > 0;
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
