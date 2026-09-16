import { googleEngine } from './google';
import { openAiCompatEngine } from './openai-compat';
import type { Translator } from './types';

export const ENGINES: readonly Translator[] = [googleEngine, openAiCompatEngine];

export const DEFAULT_ENGINE_ID = googleEngine.id;

/**
 * 自定义接口引擎的 id。它**不再出现在任何选择器里**：v3 起用户选的是「某个服务商档案」
 * （`shared/settings.ts` 的 `resolveEngine` 负责把档案映射到本引擎），这个常量只是那
 * 一处解析与迁移折叠的引用点，避免 `'openai-compat'` 字面量在多处各写一份。
 */
export const OPENAI_COMPAT_ENGINE_ID = openAiCompatEngine.id;

/** 未知 id 一律回退到默认引擎，避免设置里存了废弃 id 时整个插件不可用。 */
export function getEngine(id: string): Translator {
  return ENGINES.find((engine) => engine.id === id) ?? googleEngine;
}
