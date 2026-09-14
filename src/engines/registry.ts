import { googleEngine } from './google';
import { openAiCompatEngine } from './openai-compat';
import type { Translator } from './types';

export const ENGINES: readonly Translator[] = [googleEngine, openAiCompatEngine];

export const DEFAULT_ENGINE_ID = googleEngine.id;

/** 未知 id 一律回退到默认引擎，避免设置里存了废弃 id 时整个插件不可用。 */
export function getEngine(id: string): Translator {
  return ENGINES.find((engine) => engine.id === id) ?? googleEngine;
}
