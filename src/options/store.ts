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
// **已知代价（规格 §4.1 / §11，本轮不解决）**：两个设置页并排打开时，双方各自重读、各自
// 整份写回，后写的一方仍然会覆盖前一方——这与改版前"点保存即覆盖"是同一性质。
import { loadSettings, saveSettings, type Settings } from '../shared/settings';

/** 读到存储之前为 null：这期间任何写请求都必须被拒绝，而不是拿一份空设置去覆盖存储。 */
let snapshot: Settings | null = null;

/**
 * 写队列。**这是本模块存在的核心理由**（见文件头）。`patchSettings` 把每次写挂到它后面，
 * 于是第二次写的起点必然是第一次写完成之后的状态。
 */
let queue: Promise<void> = Promise.resolve();

/** 设置还没读出来时的拒绝文案：设置页的用例用「设置还没读出来」这半句做同步点。 */
export const NOT_LOADED = '设置还没读出来，请稍候重试';

/** 当前内存快照（`loadSnapshot()` 之前是 null）。只读用途：渲染、算下一次写回的基线。 */
export function currentSettings(): Settings | null {
  return snapshot;
}

/** 读一次存储，建立快照。失败时**不**留下半份状态：快照仍是 null，后续写一律被拒。 */
export async function loadSnapshot(): Promise<Settings> {
  const loaded = await loadSettings();
  snapshot = loaded;
  return loaded;
}

/**
 * 单字段写回：排队 → **重新读一次存储** → 只改这一个字段 → 整份写回 → 换上新快照。
 *
 * 失败（版本高于本代码、存储读写失败）原样抛给调用方：它是唯一知道该把这句话写到哪个
 * 状态行、要不要把控件拨回去的一方。**失败不写快照**——快照必须永远等于"存储里那一份"。
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
