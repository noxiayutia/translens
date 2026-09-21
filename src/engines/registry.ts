// src/engines/registry.ts
import { openAiCompatEngine } from './openai-compat';
import type { Translator } from './types';

/**
 * 已注册的适配器。**单元 E 之后只剩一个成员**（Google 免费接口已整体删除）。
 *
 * 保留这个数组与 {@link getEngine} 是"注册表"的形状：将来加第二种适配器时不用重新发明。
 * 有人把 `google.ts` 加回来、或把这里写成多成员，`tests/engines/registry.test.ts`
 * 的 `ENGINES.map((e) => e.id)` 断言当场红。
 */
export const ENGINES: readonly Translator[] = [openAiCompatEngine];

/**
 * 自定义接口引擎的 id。它**不再出现在任何选择器里**：v3 起用户选的是「某个服务商档案」
 * （`shared/settings.ts` 的 `resolveEngine` 负责把档案映射到本引擎），这个常量只是那
 * 一处解析与迁移折叠的引用点，避免 `'openai-compat'` 字面量在多处各写一份。
 */
export const OPENAI_COMPAT_ENGINE_ID = openAiCompatEngine.id;

/**
 * 按适配器 id 取引擎；没有这个 id 时返回 `null`（**不再回落到任何引擎**）。
 *
 * **这条兜底是被本单元推翻的设计判断**：旧注释写的是「未知 id 一律回退到默认引擎，避免设置里
 * 存了废弃 id 时整个插件不可用」。废弃 id 的正确答案不是"照样能翻"，而是"说清没有可用引擎，
 * 且一个请求都不发"——`resolveEngine` 因此把 `null` 翻成 `NO_ENGINE_PROBLEM`。
 *
 * 返回 `null` 而不是抛错：唯一的调用点是 `resolveEngine`，而它的契约是**返回值**而不是抛错
 * （弹窗在同步渲染函数里调它，抛错会把提示区变成异常路径）。让这里抛错等于把那条取舍反过来。
 */
export function getEngine(id: string): Translator | null {
  return ENGINES.find((engine) => engine.id === id) ?? null;
}
