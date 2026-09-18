// src/options/store.ts
//
// 设置页的存储层：**一份内存快照 + 一条串行的写队列**。
//
// 为什么要有这一层（而不是各处直接 loadSettings/saveSettings）：即时保存把"改设置"从
// 「点一次保存按钮」变成「每次 change / 失焦」——写回的频率上去了，而 `saveSettings` 是
// **整份覆盖**。三件事因此必须在同一处收口：
//
// 1. **排队**：两个 change 挨着发生时，两次写必须串行，否则后写的那次会拿自己那份旧基线
//    整份回写，把先写的那次静默抹掉（`tests/options/store.test.ts` 第二条用例钉住它）。
// 2. **写前重读**：弹窗、后台也在写同一份设置，基线必须是存储里最新的那一份。
// 3. **单字段**：调用方只交一个字段的增量，其余字段永远取自刚读到的存储。
//
// 第 1 条与第 2 条**并列，不是主次**（别把这里读成"队列才是关键、重读只是顺手"）：
// 少了 1 会丢"本页自己刚写的那一笔"，少了 2 会丢"别处（弹窗）写的那一笔"，
// 两者各有一条用例守着，**缺任何一个都会红在不同的一条上**。
//
// **已知代价（规格 §4.1 / §11，本轮不解决）**：两个设置页并排打开时，双方各自重读、各自
// 整份写回，后写的一方仍然会覆盖前一方——这与改版前"点保存即覆盖"是同一性质。
import { loadSettings, saveSettings, type Settings } from '../shared/settings';

/** 读到存储之前为 null：这期间任何写请求都必须被拒绝，而不是拿一份空设置去覆盖存储。 */
let snapshot: Settings | null = null;

/**
 * 写队列：**与「写前重读」并列的必要条件之一**（见文件头第 1、2 条及其下的说明）。
 * `patchSettings` 把每次写挂到它后面，于是第二次写的起点必然是第一次写完成之后的状态。
 */
let queue: Promise<void> = Promise.resolve();

/**
 * 设置还没读出来时的拒绝文案。
 *
 * **它与设置页 5 处硬编的同一句话必须逐字一致**（`options.ts` 的兜底状态行，以及
 * engine / shortcuts / glossary / cache 四个区块的 `setStatus`）：这几处分散在不同模块里，
 * 谁也不可能 import 谁的状态行；文案一旦漂移，用户在同一个故障上会看到两种说法，
 * 而这种分歧**没有任何测试能发现**（没有人跨模块比对字符串）。导出这个常量是为了让
 * "应该长什么样"有一个唯一的书面来源，同仓库先例见 `shared/settings.ts:212-216` 的
 * `isAllowedBaseUrl`。
 *
 * **测试用的是 `'设置还没读出来'` 这个子串，并没有 import 本常量**（`store.test.ts`）：
 * 所以改动这里的文案不会让任何用例变红，别误以为它被测试钉住了。
 */
export const NOT_LOADED = '设置还没读出来，请稍候重试';

/**
 * 当前内存快照（`loadSnapshot()` 之前是 null）。用途：渲染、以及给 `reload()` 之后
 * 重新读一遍页面的调用方。
 *
 * ⚠ **返回的是内部对象本体，不是副本**（`currentSettings() === currentSettings()`），
 * 而 `Settings` 里的 `profiles` / `siteRules` / `glossary` 都是可变数组。调用方**不得**
 * 原地修改它：`patchSettings` 写回前会重读存储，于是这种修改**既不会进存储、也不会报错**，
 * 只会在下一次写回后被新快照覆盖——是静默丢失，不是失败。要改设置只有一条路：
 * `patchSettings`。
 *
 * 若将来要收紧这一点，可考虑把返回类型改成 `Readonly<Settings>` 或在这里 `Object.freeze`
 * ——本轮**刻意都不做**：前者会级联到区块模块已定稿的 `settings()` 契约，后者会给尚未
 * 写完的区块引入运行期风险。（**注意"快照不是写回的基线"**：写回的基线是 `patchSettings`
 * 里刚读到的 `latest`，快照只是写入成功之后的**结果记录**。）
 */
export function currentSettings(): Settings | null {
  return snapshot;
}

/**
 * 读一次存储，建立快照。**失败时快照的处置分两种情况，代码里只有一句 `snapshot = loaded`
 * （赋值只在 `await` 成功之后执行），但两种情况的后果完全不同，都是有意的**：
 *
 * - **首次加载就失败**（`snapshot` 仍是 null）：快照保持 null，后续写一律被 `NOT_LOADED` 拒。
 *   这是必须的——拿一份空设置去整份覆盖存储，会把用户已有的配置抹掉。
 * - **已经成功加载过之后再失败**（`snapshot` 非 null）：**保留上一次成功的那一份快照**，
 *   不清空。理由是降级方式的选择：存储版本高于本代码、或读存储本身失败时，让界面拿着
 *   上一份可用数据继续工作，比把页面清空、所有区块一起报错要好。真实原因由**调用方**的
 *   `catch` 写进它自己的状态行（见 `sections/engine.ts` 的 `renderFromStorage` 调用点），
 *   `store.ts` 不替它决定文案。
 *   代价要如实说：这一份快照**不等于存储里的内容**（存储可能已经变了），所以它是"最后一次
 *   成功读到的值"，不是"当前的值"。此时 `patchSettings` 的重读仍然会撞上同一个版本错误而
 *   失败——这也正是对的：写不进去比写坏好。
 */
export async function loadSnapshot(): Promise<Settings> {
  const loaded = await loadSettings();
  snapshot = loaded;
  return loaded;
}

/**
 * 单字段写回：排队 → **重新读一次存储** → 只改这一个字段 → 整份写回 → 换上新快照。
 *
 * 失败（版本高于本代码、存储读写失败）原样抛给调用方：它是唯一知道该把这句话写到哪个
 * 状态行、要不要把控件拨回去的一方。**失败不写快照**——快照代表"最后一次成功写入的结果"，
 * 不能因为一次没落盘的改动就跑掉。（**别说成"快照永远等于存储里那一份"**：`loadSettings()`
 * 与 `saveSettings()` 之间是一个真实的窗口，另一个上下文（弹窗、另一个设置页）可以在那里
 * 落盘，此时本次写回会把那笔改动覆盖掉——这就是文件头第 14-15 行承认的已知代价，
 * 重读只是把窗口收窄，没有消除它。）
 *
 * **空 patch（`{}`）是被允许的，而且照样走完整个读-写往返**：控件值没变也可能触发 `change`
 * （`<select>` 重新选回原来那项、`blur` 落在没改过的输入框上），所以这条路径可达。
 * 不在这里早返回，是因为"对象没有键"这个判据会**顺手跳过** `saveSettings` 里的版本门禁：
 * 存储版本高于本代码时，`{}` 会静默成功而不是报错，调用方于是以为"写进去了"。
 * 代价是那次多余的写（值与原值相同），比绕开门禁划算。
 */
export function patchSettings(patch: Partial<Settings>): Promise<void> {
  if (snapshot === null) return Promise.reject(new Error(NOT_LOADED));
  const run = queue.then(async () => {
    const latest = await loadSettings();
    const next: Settings = { ...latest, ...patch };
    await saveSettings(next);
    snapshot = next;
  });
  // 队列不能因为一次失败就永久卡死：把失败从链上摘掉（调用方拿到的仍是那份会拒绝的 `run`）。
  queue = run.catch(() => undefined);
  return run;
}
