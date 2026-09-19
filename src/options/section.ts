// src/options/section.ts
//
// 设置页的区块契约。每个区块一个模块，`options.ts` 只负责把它们装配起来。
// （本轮 Task 3 先落地 4 个区块；`SectionId` 里那八个值就是全集，Task 4~8 逐个补齐。）
//
// `bind` 与 `mount` 必须分成两段：**监听器要在第一个 `await` 之前挂好**。`loadSnapshot()`
// 有明确的拒绝路径（存储里是更高版本、存储读写失败），等读完再挂的话，那些拒绝会让界面变成
// 一个"看着能点、其实没有任何监听器"的死页面，连重试都点不了（`options.ts` 里那条注释
// 与 `tests/options/options.test.ts` 的版本闸门用例都是这件事的见证）。
//
// ⚠ **`SectionContext` 接口全文只在本文件里定义这一处**（`settings()` / `reload()` / `save()`
// 三个成员，一个都不能少）。**不要在任何地方再抄第二份**：一份带 `reload`、一份不带的重复
// 定义迟早会让某个调用点拿到错的那份，而 `npm run typecheck` 只会在下游炸
// （`Property 'reload' does not exist`），排查成本远高于删掉几行。`options.ts` 里那个
// `const context: SectionContext` 因此必须把三个成员都实现。
import type { Settings } from '../shared/settings';

export type SectionId =
  | 'engine'
  | 'language'
  | 'shortcuts'
  | 'glossary'
  | 'site-rules'
  | 'prompt'
  | 'cache'
  | 'privacy';

export interface SectionContext {
  /** 当前内存快照；`start()` 读出设置之前是 null。 */
  settings(): Settings | null;
  /**
   * 重读存储并把快照对齐。**并发窗口下刷新界面用**（例如删除档案时发现它已经被别处删掉，
   * 界面必须刷成存储的真实样子）。读的入口只有存储层一处，区块不许自己 `loadSettings()`
   * 之后偷偷改快照——两处各改一份就多了一条漂移路径。
   */
  reload(): Promise<void>;
  /**
   * 单字段即时保存（规格 §4.1）。**不抛**：成功/失败都写进这一区块的状态行
   * （`.status` + `data-kind` 契约），返回是否成功。
   *
   * 调用方拿这个布尔值去决定"要不要把控件拨回真正生效的那一档"——写失败时把用户刚选的
   * 值留在界面上，等于界面撒谎。
   */
  save(status: HTMLElement, prefix: string, patch: Partial<Settings>, okMessage?: string): Promise<boolean>;
}

export interface Section {
  /** 与 `options.html` 里 `[data-section="<id>"]`、`[data-nav="<id>"]` 一一对应。 */
  readonly id: SectionId;
  /** 区块标题，与页面里的 `<h2>` 逐字一致（搜索会用它）。 */
  readonly title: string;
  /**
   * 搜索别名（规格 §4.2）。与区块定义**放在一起**，避免两处漂移。
   *
   * 别名必须指向**真正含该字段**的区块：「密钥 / API Key」归翻译引擎（Key 在那里），
   * 「词库 / 专有名词」归术语表——搜「密钥」跳出术语表比搜不到更糟。
   */
  readonly aliases: readonly string[];
  /** 挂监听器 + 填静态选项。**必须在第一个 await 之前跑完**。 */
  bind(context: SectionContext): void;
  /** 读设置之后的渲染（填当前值、渲染动态列表）。失败由 `options.ts` 兜住。 */
  mount(context: SectionContext): void | Promise<void>;
}
