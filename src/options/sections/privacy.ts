// src/options/sections/privacy.ts
//
// §3.8 隐私。**纯静态区块**：四条一行式的承诺住在 options.html 里，那段「字段隔离 ≠ 内存级
// 隔离」的诚实说明收进 `<details>`，一个字都不删（规格 §3.8、§7）。
//
// 这里保留一个空实现而不是"不注册这个区块"：导航、搜索索引与区块清单一律由 SECTIONS 驱动，
// 少一个就会让"8 组"这个信息架构少一格。`bind` / `mount` 故意什么都不做——它没有可改的字段，
// 也就**不该有**任何控件（规格 §1：不给没有行为的字段做控件）。
import type { Section } from '../section';

export const privacySection: Section = {
  id: 'privacy',
  title: '隐私',
  aliases: ['隐私', '数据', '遥测', '网络请求', '可见文本'],

  bind(): void {
    // 没有可操作的字段。
  },

  mount(): void {
    // 内容全在 options.html 里，静态渲染。
  },
};
