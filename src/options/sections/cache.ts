// src/options/sections/cache.ts
//
// §3.7 缓存与请求：三个统计数字、缓存上限、清除按钮，`<details>` 里放并发与批量三项。
//
// 两条纪律：
// 1. **清除要清两层**（持久层 + 会话层），报的数是两层合计——只清持久层的话，用户点完
//    "清除"立刻重译页面照样零请求命中（`TieredCache` 先查会话层），按钮看起来失灵。
// 2. **越界值要回填**：`mergeSettings` 的 clampInt 会把 999 夹成 8，输入框继续显示 999
//    就是界面撒谎。写回后一律把**生效值**读回来填进输入框。
import { TranslationCache } from '../../core/cache';
import { chromeArea } from '../../shared/chrome-area';
import type { Settings } from '../../shared/settings';
import { describe, runSafely, setStatus } from '../dom';
import type { Section, SectionContext } from '../section';
// 这句话只有一个来源：`store.ts` 导出的 `NOT_LOADED`。
import { NOT_LOADED } from '../store';

const statCached = document.getElementById('stat-cached') as HTMLElement;
const statMax = document.getElementById('stat-max') as HTMLElement;
const statConcurrency = document.getElementById('stat-concurrency') as HTMLElement;
const maxEntriesInput = document.getElementById('cache-max-entries') as HTMLInputElement;
const concurrencyInput = document.getElementById('concurrency') as HTMLInputElement;
const maxBatchCharsInput = document.getElementById('max-batch-chars') as HTMLInputElement;
const maxSegmentsInput = document.getElementById('max-segments-per-batch') as HTMLInputElement;
const clearCacheButton = document.getElementById('clear-cache') as HTMLButtonElement;
const cacheStatus = document.getElementById('cache-status') as HTMLElement;

type NumberField = 'cacheMaxEntries' | 'concurrency' | 'maxBatchChars' | 'maxSegmentsPerBatch';

/** 数字字段与它的控件、标题：遍历着绑定与回填，免得四处各写一遍。 */
const NUMBER_FIELDS: ReadonlyArray<{ input: HTMLInputElement; field: NumberField; label: string }> = [
  { input: maxEntriesInput, field: 'cacheMaxEntries', label: '缓存上限' },
  { input: concurrencyInput, field: 'concurrency', label: '并发请求数' },
  { input: maxBatchCharsInput, field: 'maxBatchChars', label: '单批字符上限' },
  { input: maxSegmentsInput, field: 'maxSegmentsPerBatch', label: '单批段数上限' },
];

/**
 * 显式逐个构造增量，而不是 `{ [field]: value }`：计算属性会退化成字符串索引签名
 * `{[x: string]: number}`，而 `Settings` 里还有字符串与数组字段——**那个类型在说谎**
 * （实测 `const patch = { [field]: value }` 之后 `patch.targetLang` 就是 `number`；
 * 把它当字符串用，`tsc` 当场报 TS2322）。
 *
 * ⚠ 退化类型**不是"编译不过"**（那句话曾经写在这里，是错的）：把它交给 `Partial<Settings>`，
 * 返回位置与 `ctx.save(…)` 的参数位置实测 `npx tsc --noEmit` 都不报错，`sections/shortcuts.ts:79`
 * 还有一个 `as Partial<Settings>` 的先例。逐个写出来，类型就是它字面的样子，也不必靠断言压住。
 */
function patchFor(field: NumberField, value: number): Partial<Settings> {
  if (field === 'cacheMaxEntries') return { cacheMaxEntries: value };
  if (field === 'concurrency') return { concurrency: value };
  if (field === 'maxBatchChars') return { maxBatchChars: value };
  return { maxSegmentsPerBatch: value };
}

/** 两层缓存的构造收在一处，免得两边的 maxEntries 参数漂移。 */
function caches(maxEntries: number | undefined): { persistent: TranslationCache; session: TranslationCache } {
  return {
    persistent: new TranslationCache(chromeArea(chrome.storage.local), maxEntries),
    session: new TranslationCache(chromeArea(chrome.storage.session), maxEntries),
  };
}

/** 已缓存段落数 = 两层各自真实条目数之和（与「清除」报的数是同一个口径）。 */
async function countCached(maxEntries: number | undefined): Promise<number> {
  const { persistent, session } = caches(maxEntries);
  const [persistentCount, sessionCount] = await Promise.all([persistent.count(), session.count()]);
  return persistentCount + sessionCount;
}

/** 把三个统计数字与四个输入框刷成当前设置的样子。 */
async function refreshStats(ctx: SectionContext): Promise<void> {
  const current = ctx.settings();
  if (current === null) return;
  statMax.textContent = String(current.cacheMaxEntries);
  statConcurrency.textContent = String(current.concurrency);
  for (const entry of NUMBER_FIELDS) entry.input.value = String(current[entry.field]);
  try {
    statCached.textContent = String(await countCached(current.cacheMaxEntries));
  } catch (raw) {
    // 数不出来不是致命错误，但**绝不能显示成 0**：那是在说"缓存是空的"。
    statCached.textContent = '—';
    setStatus(cacheStatus, 'err', `读取缓存条数失败：${describe(raw)}`);
  }
}

/**
 * 清除翻译缓存：删掉**两层**（持久层 + 会话层）全部 `jt:` 前缀的键。
 *
 * 用 `TranslationCache` 而不是自己拼 `jt:` 前缀：缓存的键名、元数据键、形状坏掉的残留
 * 都归它管（`clear()` 就是为这件事写的）。设置页是扩展自身的受信页面（`chrome-extension://`
 * 同源），可以直接访问 `chrome.storage.session`，不需要绕道后台消息。
 */
async function handleClearCache(ctx: SectionContext): Promise<void> {
  const { persistent, session } = caches(ctx.settings()?.cacheMaxEntries);
  const [persistentBefore, sessionBefore] = await Promise.all([persistent.count(), session.count()]);
  await Promise.all([persistent.clear(), session.clear()]);
  const cleared = persistentBefore + sessionBefore;
  // 统计跟着走：清完还显示旧条数，用户会以为按钮没生效。
  // 顺序是"先刷数字、再写结果"：`refreshStats` 只在数不出来时写状态行，而按钮的结果是
  // 用户这一下的直接反馈，必须留在最上面（数不出来时统计本身就显示成 `—`，看得出来）。
  await refreshStats(ctx);
  setStatus(cacheStatus, 'ok', cleared === 0 ? '缓存本来就是空的' : `已清除 ${cleared} 条翻译缓存`);
}

/** 数字控件的提交：非法拨回、合法写回、越界回填生效值。 */
function commitNumber(ctx: SectionContext, input: HTMLInputElement, field: NumberField, label: string): void {
  void (async () => {
    const current = ctx.settings();
    if (current === null) {
      setStatus(cacheStatus, 'err', NOT_LOADED);
      return;
    }
    const parsed = Number(input.value);
    // ⚠ 下面 `!Number.isFinite(parsed)` 这一半今天**不可达、也没有读数**，别再把它当成一条活路径：
    // `<input type="number">` 的取值净化只留下"语法上是有效浮点数、**且换算结果有限**"的字符串，
    // 其余一律清成 `''`。实测（jsdom 30.0.1，本仓库的测试环境）：`'abc'` / `'1e999'` / `'Infinity'`
    // / `'0x10'` / `' 5 '` / `'5x'` / `'NaN'` / 400 位整数，用 `value` setter、`setAttribute('value', …)`、
    // `defaultValue` 三条路写进去，读 **`.value`** 都是 `''`。注意 **`.defaultValue` 不净化**：它反射
    // 内容属性，后两条路写进去时读回来还是原文（`commitNumber` 只读 `.value`，因此不受影响）；
    // `valueAsNumber = Infinity` 则直接抛 TypeError。
    // 于是能走到这里的非空值必定是有限数——`Number.isFinite` 这一半今天永远不会为假。
    // 留着的唯一理由：控件哪天换成文本控件（`type="text"`）——那时 `Number('1e999')` = Infinity
    // 会被 clampInt 悄悄夹成上限，只有这一半拦得住。浏览器一侧本仓库没有读数，别写成既成事实。
    if (input.value.trim().length === 0 || !Number.isFinite(parsed)) {
      input.value = String(current[field]);
      setStatus(cacheStatus, 'err', `${label}要填一个数字`);
      return;
    }
    const ok = await ctx.save(cacheStatus, `保存${label}失败`, patchFor(field, parsed));
    const after = ctx.settings();
    if (after === null) return;
    if (!ok) {
      // 写失败：拨回存储里真正生效的值，别让输入框停在一个没生效的数字上。
      input.value = String(current[field]);
      return;
    }
    const effective = after[field];
    if (effective !== parsed) {
      setStatus(cacheStatus, 'ok', `已保存（实际生效 ${effective}，允许范围 ${input.min}–${input.max}）`);
    }
    input.value = String(effective);
    statMax.textContent = String(after.cacheMaxEntries);
    statConcurrency.textContent = String(after.concurrency);
  })();
}

export const cacheSection: Section = {
  id: 'cache',
  title: '缓存与请求',
  aliases: ['缓存', '清除缓存', '上限', '并发', '批量'],

  bind(ctx: SectionContext): void {
    clearCacheButton.addEventListener('click', () => runSafely(cacheStatus, '清除缓存失败', () => handleClearCache(ctx)));
    for (const entry of NUMBER_FIELDS) {
      entry.input.addEventListener('change', () => commitNumber(ctx, entry.input, entry.field, entry.label));
    }
  },

  mount(ctx: SectionContext): Promise<void> {
    return refreshStats(ctx);
  },
};
