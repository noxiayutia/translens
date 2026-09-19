// src/options/options.ts
//
// 设置页的装配层：读设置、把各区块挂起来、把全局的失败兜成一句话。**这里不写业务逻辑**——
// 每一组设置的行为都在 `sections/<name>.ts` 里，写存储一律走 `store.ts`。
//
// 结构上刻意保持"两个阶段"：
// 1. `init()`（同步）：先给每个区块 `bind(ctx)` 挂好监听器，**在第一个 await 之前**。
//    `loadSnapshot()` 有明确的拒绝路径（存储里是更高版本、存储读写失败），等读完再挂的话，
//    那些拒绝会让界面停在一个"看着能点、其实没有任何监听器"的死页面上，用户连重试都点不了。
// 2. `start()`（异步）：读设置 → 依次 `mount(ctx)` 渲染。
import { describe, runSafely, setStatus } from './dom';
import { engineSection } from './sections/engine';
import { languageSection } from './sections/language';
import { shortcutsSection } from './sections/shortcuts';
import { glossarySection } from './sections/glossary';
import { siteRulesSection } from './sections/site-rules';
import { cacheSection } from './sections/cache';
import { privacySection } from './sections/privacy';
import type { Section, SectionContext } from './section';
import { currentSettings, loadSnapshot, patchSettings } from './store';
import type { Settings } from '../shared/settings';

/**
 * 区块清单，**顺序就是页面顺序与导航顺序**（搜索索引、导航项、`[data-section]` 三者一一对应，
 * `tests/options/search.test.ts` 有一条结构守卫钉住这件事）。导出是给测试用的。
 *
 * **这里刻意不写死数量**：本轮（Task 3）先落地 4 个（引擎/语言/缓存/隐私），Task 4~8 各插一项，
 * 最终 8 个，顺序是 engine、language、shortcuts、glossary、site-rules、prompt、cache、privacy。
 */
export const SECTIONS: readonly Section[] = [
  engineSection,
  languageSection,
  shortcutsSection,
  glossarySection,
  siteRulesSection,
  cacheSection,
  privacySection,
];

/** 全局兜底用的状态行：设置读不出来时，这句话必须写在用户一眼能看到的地方。 */
const engineStatus = document.getElementById('engine-status') as HTMLElement;

/**
 * `SectionContext.save` 的实现：把 `patchSettings` 的成功/失败翻译成状态行里的一句话。
 * 成功默认写「已保存」；失败写 `${prefix}：${原因}` 并返回 false（调用方据此回拨控件）。
 */
async function save(
  status: HTMLElement,
  prefix: string,
  patch: Partial<Settings>,
  okMessage = '已保存',
): Promise<boolean> {
  try {
    await patchSettings(patch);
  } catch (raw) {
    setStatus(status, 'err', `${prefix}：${describe(raw)}`);
    return false;
  }
  setStatus(status, 'ok', okMessage);
  return true;
}

const context: SectionContext = {
  settings: currentSettings,
  reload: async () => {
    await loadSnapshot();
  },
  save,
};

async function start(): Promise<void> {
  await loadSnapshot();
  for (const section of SECTIONS) await section.mount(context);
}

function init(): void {
  for (const section of SECTIONS) section.bind(context);
  runSafely(engineStatus, '设置读取失败', start);
}

init();
