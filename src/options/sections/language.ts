// src/options/sections/language.ts
//
// §3.2 语言与显示：目标语言、源语言（新）、显示模式。三个都是**选择类 → change 即存**（§4.1），
// 「保存语言与显示」按钮随本轮改版一起消失。
import { LANGUAGES } from '../../core/lang';
import { DISPLAY_MODES, type DisplayMode, type Settings } from '../../shared/settings';
import { fillSelect } from '../dom';
import type { Section, SectionContext } from '../section';

const targetLangSelect = document.getElementById('target-lang') as HTMLSelectElement;
const sourceLangSelect = document.getElementById('source-lang') as HTMLSelectElement;
const displayModeSelect = document.getElementById('display-mode') as HTMLSelectElement;
const status = document.getElementById('language-status') as HTMLElement;

type FieldName = 'targetLang' | 'sourceLang' | 'displayMode';

/** 显式逐个构造增量：`{ [field]: value }` 这种计算属性在 TS 里会被放宽成 `{[x: string]: string}`。 */
function patchFor(field: FieldName, value: string): Partial<Settings> {
  if (field === 'targetLang') return { targetLang: value };
  if (field === 'sourceLang') return { sourceLang: value };
  return { displayMode: value as DisplayMode };
}

function bindSelect(ctx: SectionContext, select: HTMLSelectElement, field: FieldName, label: string): void {
  select.addEventListener('change', () => {
    void (async () => {
      const ok = await ctx.save(status, `保存${label}失败`, patchFor(field, select.value));
      if (ok) return;
      // 写失败（存储里是更高版本、读写失败）时把控件拨回**真正生效**的那一档：
      // 留在用户刚选的值上等于界面撒谎。
      const current = ctx.settings();
      if (current !== null) select.value = current[field];
    })();
  });
}

export const languageSection: Section = {
  id: 'language',
  title: '语言与显示',
  aliases: ['目标语言', '源语言', '显示模式', '仅译文', '双语对照', '翻译成', '语言'],

  bind(ctx: SectionContext): void {
    bindSelect(ctx, targetLangSelect, 'targetLang', '目标语言');
    bindSelect(ctx, sourceLangSelect, 'sourceLang', '源语言');
    bindSelect(ctx, displayModeSelect, 'displayMode', '显示模式');
  },

  mount(ctx: SectionContext): void {
    const current = ctx.settings();
    if (current === null) return;
    fillSelect(
      targetLangSelect,
      LANGUAGES.map((lang) => ({ value: lang.code, label: lang.label })),
      current.targetLang,
    );
    // 「自动检测」是默认值，也是唯一不需要用户懂语言的选项，排在最前。
    fillSelect(
      sourceLangSelect,
      [{ value: 'auto', label: '自动检测' }, ...LANGUAGES.map((lang) => ({ value: lang.code, label: lang.label }))],
      current.sourceLang,
    );
    fillSelect(displayModeSelect, DISPLAY_MODES, current.displayMode);
  },
};
