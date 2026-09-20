// src/options/engine-health.ts
//
// 状态点（§4.3）背后的记录：每个引擎/档案"最近一次测试连接"的结果。
//
// 为什么存 `chrome.storage.session` 而不是内存里一个 Map：
// 灰点的语义是「**从没测过**（不代表可用）」。只在内存里记的话，用户刷新一次设置页就全变回灰，
// 那句 `title` 立刻成了假话——他明明刚测过。session 区域是受信上下文可读的独立键
// （设置页是 `chrome-extension://` 同源，本来就在读它清缓存），不进 `Settings`、不动 schema 版本。
//
// **代价如实说**：session 区域在浏览器关闭时清空，重启后所有点回到灰。
//
// 这里刻意不复用 `store.ts`：那份快照是"设置"，这是"UI 的临时记忆"，两者的失败语义也不同
// （设置写失败要拦住用户，测试记录写失败只该说一句）。
import type { StorageArea } from '../core/cache';
import { chromeArea } from '../shared/chrome-area';

export interface EngineHealth {
  /** `ok` = 最近一次通过；`bad` = 最近一次失败（`detail` 进 `title`）。 */
  state: 'ok' | 'bad';
  /** 失败原因（`错误码：消息`）。绿态是空串。 */
  detail: string;
}

/** 独立存储键。**不进 `Settings`**：它不是设置，也不该被 `saveSettings` 整份覆盖带走。 */
export const ENGINE_HEALTH_KEY = 'jinyi:engine-health';

/**
 * 内置免费引擎在健康记录里的**保留键**。
 *
 * 为什么不能直接用 `DEFAULT_ENGINE_ID`（= `google`）：这份记录是 `Record<id, EngineHealth>`，
 * 免费引擎与"某个档案"共用同一个键空间。档案 id 由 `createProfileId()` 生成（恒带 `p-` 前缀），
 * 但**存储层不做保留字检查**（`pickProfile` 只要求"非空字符串"），脏存储/外部写入可以造出一个
 * id 恰为 `google` 的档案。撞上时的症状是两行共用一个槽：点免费行亮的是**用户档案行**，
 * 重绘后两行同时绿，而重开设置页只有一条记录。
 *
 * 取值与 `sections/engine.ts` 的 `NEW_DRAFT_ID`（`__new__`）同款约定：合法档案 id 都带 `p-`
 * 前缀，`__…__` 形态的哨兵不可能由生成器产出。
 */
export const FREE_ENGINE_HEALTH_ID = '__free__';

/**
 * 默认区域的包裹**只做一次**（按底层存储区对象记住它）。
 *
 * 为什么不能每次现包一个 `chromeArea(chrome.storage.session)`：下面的写队列按存储区对象共享，
 * 而每次现包都是一个**新对象**——队列于是永远匹配不上，"看起来串行化了、其实每次写都排在自己
 * 那条空队列上"（`core/cache.ts` 没有这个坑：它的 `StorageArea` 是构造时注入一次、存下来复用的）。
 * 按底层对象记忆还顺带对了一层：测试里重装替身会拿到新的底层对象，包裹与队列跟着换新的，
 * 不会指向上一个用例那块已经作废的存储。
 *
 * 另一条不变式：模块 import 期不碰 `chrome`（单测里那是替身，还没装），所以这里是**调用时**解析。
 */
const wrappedAreas = new WeakMap<chrome.storage.StorageArea, StorageArea>();

function sessionArea(): StorageArea {
  const raw = chrome.storage.session;
  const cached = wrappedAreas.get(raw);
  if (cached !== undefined) return cached;
  const area = chromeArea(raw);
  wrappedAreas.set(raw, area);
  return area;
}

function pickHealth(raw: unknown): Record<string, EngineHealth> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, EngineHealth> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Partial<EngineHealth>;
    if (record.state !== 'ok' && record.state !== 'bad') continue;
    out[id] = { state: record.state, detail: typeof record.detail === 'string' ? record.detail : '' };
  }
  return out;
}

/**
 * 读出全部记录。**坏条目直接丢掉**（`pickSiteRules` 的老规矩）：一条形状不对的记录不该让
 * 整个设置页崩掉，也不该在界面上变成一个说不清来源的点。
 */
export async function loadEngineHealth(area: StorageArea = sessionArea()): Promise<Record<string, EngineHealth>> {
  const raw = await area.get([ENGINE_HEALTH_KEY]);
  return pickHealth(raw[ENGINE_HEALTH_KEY]);
}

/**
 * 写队列：**按存储区对象共享**（与 `core/cache.ts` 的 `queues` 同一条口径：WeakMap 不阻止
 * 存储区被回收；队列挂在模块作用域而不是某次调用上，同一存储区的并发写才真的排到一条线上）。
 *
 * 为什么必须排队：这份记录是"一份对象、多条条目"，每次写都是**整份读-改-写**。不排队时两个
 * 并发写各读同一份旧基线、各整份回写，后落盘的那次把先写的那次静默抹掉——实测
 * `Promise.all([saveEngineHealth('p-a'…), saveEngineHealth('p-b'…)])` 之后存储里只剩 `p-b`；
 * UI 可达的版本（两个档案各点一次「测试连接」）同样是存储里只剩一条，而**页面上两个点都是绿的**
 * （内存里两份都在），重开设置页才有一个回到灰。
 *
 * 只在**改写**路径上排队，`loadEngineHealth` 不进队列：读写之间本来就没有原子性可谈
 * （调用方要么在写之前读、要么在写之后读），而"读到旧值"与"读到半份写入"是两回事——
 * 后者不会发生，`area.set` 对单键是原子的。
 *
 * 队列的键是**调用方交进来的那个存储区对象**：默认路径靠上面的 `sessionArea()` 复用同一个包裹
 * 才排得进同一条队列；显式传 `area` 的调用方若要并发写互相排队，也得传同一个对象。
 */
const queues = new WeakMap<StorageArea, Promise<unknown>>();

/** 把任务挂到该存储区的串行队列上。队列本身不因一次失败卡死，但失败**原样抛给这次调用方**。 */
function queueWrite<T>(area: StorageArea, task: () => Promise<T>): Promise<T> {
  const tail = queues.get(area) ?? Promise.resolve();
  const run = tail.then(task);
  queues.set(area, run.catch(() => undefined));
  return run;
}

/** 记录一个引擎/档案的结果（在这个存储区的队列里做整份读-改-写，只动它自己的那一条）。 */
export async function saveEngineHealth(
  id: string,
  health: EngineHealth,
  area: StorageArea = sessionArea(),
): Promise<void> {
  await queueWrite(area, async () => {
    const current = await loadEngineHealth(area);
    await area.set({ [ENGINE_HEALTH_KEY]: { ...current, [id]: health } });
  });
}

/** 档案被删掉时把它的记录一并清掉（同样排队：与并发的那次写之间保持调用顺序）。 */
export async function forgetEngineHealth(id: string, area: StorageArea = sessionArea()): Promise<void> {
  await queueWrite(area, async () => {
    const current = await loadEngineHealth(area);
    if (!(id in current)) return;
    const next = { ...current };
    delete next[id];
    await area.set({ [ENGINE_HEALTH_KEY]: next });
  });
}

/**
 * 把**这次请求真正用过的那把 Key**从"要显示 / 要落存储"的文本里抹掉。
 *
 * 为什么需要：失败详情来自服务商的响应正文（`engines/api-error.ts` 的 `describeHttpError`），
 * 而正文里回显请求内容是可发生的——实测让桩回 400 + `{"error":{"message":"invalid key sk-…"}}`，
 * 状态行、`title` 与会话记录里都出现了那把 Key（401/AUTH 分支给的是罐头文案，不含正文，
 * 所以这条路只有非 401 的失败会走到）。设置页那句承诺（"只有引擎名与成败原因，不含 Key"）
 * 不能靠"服务商不会回显"来兜。
 *
 * 只做**精确子串替换**，不做正则或形状猜测：我们确切知道的只有 `config.apiKey` 这一把，
 * 猜别的形状既会把正常文案改花，又可能漏掉真正的那把。空 Key（免费引擎、没填 Key 的路径）
 * 不做替换——空串会被当成"每个位置都命中"。
 */
export function redactSecret(text: string, secret: string | undefined): string {
  const key = (secret ?? '').trim();
  if (key.length === 0) return text;
  return text.split(key).join('***');
}
