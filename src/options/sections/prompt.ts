// src/options/sections/prompt.ts
//
// §3.6 自定义提示词。文本类 → 失焦才写（§4.1），落成原生 `change`：
// 对文本控件它的触发时机就是"失焦且值变了"，不写存储就不会有第二次写入。
//
// **留空即内置**：存储里存空串，消费者（`engines/openai-compat.ts` 的 buildMessages）
// 用 `systemPrompt.trim().length > 0` 判断要不要追加，所以用户清空之后行为自动回到内置。
//
// 但 `trim` **不是纯装饰**，也**不只管"要不要追加"**：`systemPrompt` 的**原文**还进缓存键
// （设置被原样交给 `background/scheduler.ts`，那里 `hashString(deps.systemPrompt ?? '')`
// 进 `buildCacheKey`）。于是 `'abc'` 与 `'  abc  '` 送给模型的提示**一模一样**、却是两个键：
// 只改了前后空白，同样的段落也会重翻一遍。这是"存原文（不 trim）"这个决定的**代价**——
// 多一个键、多翻一次；可接受（界面上也如实说了"提示词是缓存键的一部分，改过之后同样的段落
// 会重新翻译一次"），但必须写在这里，别让后来者以为 trim 只是显示层的事。
import type { Section, SectionContext } from '../section';

const promptArea = document.getElementById('system-prompt') as HTMLTextAreaElement;
const status = document.getElementById('prompt-status') as HTMLElement;

export const promptSection: Section = {
  id: 'prompt',
  title: '自定义提示词',
  aliases: ['提示词', 'prompt', '系统提示', '语气', '文体'],

  bind(ctx: SectionContext): void {
    promptArea.addEventListener('change', () => {
      // 存**原文**（不 trim）：消费者自己会 trim，界面里显示的与存储里的保持一字不差。
      // `ctx.save` 不抛（成功/失败都进状态行），所以这里不需要额外的兜底包装。
      void ctx.save(status, '保存提示词失败', { systemPrompt: promptArea.value });
    });
  },

  mount(ctx: SectionContext): void {
    const current = ctx.settings();
    if (current === null) return;
    promptArea.value = current.systemPrompt;
  },
};
