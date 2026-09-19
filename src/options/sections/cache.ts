// src/options/sections/cache.ts
//
// §3.7 缓存与请求。本任务先落地「清除」这一半（行为与搬家前逐字相同：两层一起清、计数报两层合计），
// 三个统计数字、缓存上限与「高级：批量与并发」折叠区在 Task 8 补齐。
import { TranslationCache } from '../../core/cache';
import { chromeArea } from '../../shared/chrome-area';
import { runSafely, setStatus } from '../dom';
import type { Section, SectionContext } from '../section';

const clearCacheButton = document.getElementById('clear-cache') as HTMLButtonElement;
const cacheStatus = document.getElementById('cache-status') as HTMLElement;

/**
 * 清除翻译缓存：删掉**两层**（持久层 + 会话层）全部 `jt:` 前缀的键。
 *
 * 用 `TranslationCache` 而不是自己拼 `jt:` 前缀：缓存的键名、元数据键、形状坏掉的残留
 * 都归它管（`clear()` 就是为这件事写的）。**会话层必须一起清**：翻译读取走 `TieredCache`
 * （先查会话层），只清持久层的话，用户点完"清除"立刻重译页面照样零请求命中——按钮看起来
 * 失灵，报出的条数也系统性少报。
 */
async function handleClearCache(ctx: SectionContext): Promise<void> {
  const maxEntries = ctx.settings()?.cacheMaxEntries;
  const persistent = new TranslationCache(chromeArea(chrome.storage.local), maxEntries);
  const session = new TranslationCache(chromeArea(chrome.storage.session), maxEntries);
  const [persistentBefore, sessionBefore] = await Promise.all([persistent.count(), session.count()]);
  await Promise.all([persistent.clear(), session.clear()]);
  const cleared = persistentBefore + sessionBefore;
  setStatus(cacheStatus, 'ok', cleared === 0 ? '缓存本来就是空的' : `已清除 ${cleared} 条翻译缓存`);
}

export const cacheSection: Section = {
  id: 'cache',
  title: '缓存与请求',
  aliases: ['缓存', '清除缓存', '上限', '并发', '批量'],

  bind(ctx: SectionContext): void {
    clearCacheButton.addEventListener('click', () => runSafely(cacheStatus, '清除缓存失败', () => handleClearCache(ctx)));
  },

  mount(): void {
    // Task 8 在这里渲染三个统计数字与高级项。
  },
};
