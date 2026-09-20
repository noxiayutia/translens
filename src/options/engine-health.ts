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
 * 记录键的**两个键空间**：档案记录是 `p:<档案 id>`，引擎记录是 `e:<引擎名>`。
 *
 * 为什么不是"档案用裸 id、引擎用一个保留值"：那样两类键仍然共用一个字符串空间，撞车只是被
 * 缩小、没有被消除——档案 id 由存储层从任意非空字符串读回（`pickProfile` 只要求"非空字符串"，
 * 不做保留字检查），谁都能造出一个恰好等于引擎键的 id。撞上时的症状是两行共用一个槽：
 * 点免费行亮的是**用户档案行**，重绘后两行同时绿，而重开设置页只剩一条记录。
 *
 * **前缀不同 ⇒ 两类键按构造不可能相等**（档案键恒以 `p:` 开头、引擎键恒以 `e:` 开头）：
 * 任何档案 id（`google`、`e:free`、`__new__`、脏存储里别的什么怪值）都撞不到引擎那一格。
 * 这是**消除**撞车，不是把撞车的范围缩小一格。
 *
 * 读侧**不按前缀过滤**（`pickHealth` 仍然键无关）：一是"形状不对的记录丢掉"那条规矩与键空间
 * 是两件事，混在一处会让前者的读数（`tests/options/engine-health.test.ts`「存储里是垃圾也不崩」
 * 用 `good` / `badState` 这类任意键）说不清是被谁丢的；二是过滤解决不了任何问题——没有一行会去
 * 读裸键。
 *
 * 迁移：本分支的中间版本用**裸 id**（`google` / `p-a`）写过记录。那是 session 区域、从未发布、
 * 浏览器一关就没了，所以这里**刻意不写迁移代码**：裸键今天读不到任何一行，留着只是多几条
 * 没人认领的条目。
 */
const PROFILE_HEALTH_PREFIX = 'p:';
const ENGINE_HEALTH_PREFIX = 'e:';

/** 内置免费引擎那一格的键。它按构造不可能等于任何档案键（见上面两个键空间）。 */
export const FREE_ENGINE_HEALTH_KEY = `${ENGINE_HEALTH_PREFIX}free`;

/** 一个档案的记录键：`p:<档案 id>`。读写都必须走它，别在别处拼字面量。 */
export function profileHealthKey(id: string): string {
  return `${PROFILE_HEALTH_PREFIX}${id}`;
}

/** 档案记录键 → 档案 id；不是档案键（引擎键、老构建的裸键…）时返回 `null`。 */
export function profileIdFromHealthKey(key: string): string | null {
  return key.startsWith(PROFILE_HEALTH_PREFIX) ? key.slice(PROFILE_HEALTH_PREFIX.length) : null;
}

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
 * 审查者的 UI 读数（两个档案各点一次「测试连接」）同样是存储里只剩一条，而**页面上两个点
 * 都是绿的**（内存里两份都在），重开设置页才有一个回到灰。
 *
 * 只在**改写**路径上排队，`loadEngineHealth` 不进队列：读写之间本来就没有原子性可谈
 * （调用方要么在写之前读、要么在写之后读），而"读到旧值"与"读到半份写入"是两回事——
 * 后者不会发生，`area.set` 对单键是原子的。
 *
 * 队列的键是**调用方交进来的那个存储区对象**：默认路径靠上面的 `sessionArea()` 复用同一个包裹
 * 才排得进同一条队列；显式传 `area` 的调用方若要并发写互相排队，也得传同一个对象。
 *
 * ⚠ **这条队列的作用域边界（做不到的事，如实写在这里）**：队列是**模块实例级**的，而模块实例与
 * `chrome.storage.session` 都是**每个 JS 上下文各一份**（设置页与扩展的 service worker 是两个
 * 上下文，两个设置页标签也是）。所以**同时打开两个设置页**时，两个上下文各排各的队，最后落盘的
 * 那次仍会把前一条吃掉——症状与排队之前一模一样。这**不是本模块能修的**：`chrome.storage` 没有
 * 比较并交换，跨上下文的串行化在这一层做不到。它与 `store.ts` 文件头承认的那条已知代价
 * （规格 §4.1：两个设置页并排打开时，后写的一方覆盖前一方）**是同一性质**，只是这里丢的是
 * "最近一次测试结果"而不是设置。
 *
 * ⚠ **一处未在真机上取过读数的假设**：记忆化（`wrappedAreas`）依赖"同一个上下文里
 * `chrome.storage.session` 每次读都是同一个对象"。这是按 `@types/chrome` 的 API 形态推断的
 * （`storage.session` 是 `StorageArea` 属性，不是 getter 工厂），**没有实测**。若它不成立，
 * 每次调用都会拿到新包裹、队列静默退化成"看起来串行化了、其实没有"（正是 F3 修前的症状）。
 * 为什么不改成模块级的单例队列（那样就零假设了）：代价是把互不相干的存储区排到同一条线上
 * （单测里注入自己的 `area` 时会排到会话区后面），而它**并不改善**上面那条跨上下文的边界——
 * 单例同样是每个上下文一份。所以这里保留按存储区共享（与 `core/cache.ts` 同一范式）。
 * 若将来真机读数证明该假设不成立，换成模块级 `let queue` 是 5 行的事。
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
 * 猜别的形状既会把正常文案改花，又可能漏掉真正的那把。
 *
 * **长度门槛 8**：更短的"Key"（`hello`、`你好`、空串）一律原样放行。理由是精确子串替换在短串上
 * 必然误伤——实测 `apiKey='hello'` + 译文 `你好，hello world` 会被抹成 `你好，*** world`，
 * `apiKey='你好'` + 译文 `你好` 会被整句抹成 `***`；而短串本来也无法在文本里可靠地识别成凭据
 * （真凭据都够长，各家至少 `sk-` + 一串）。空 Key（免费引擎、没填 Key 的路径）因此天然落在
 * 门槛之外，不需要单独一支。
 *
 * **残留（如实说）**：≥8 字符的 Key 若**逐字**出现在正常译文里，一样会被抹掉——这是拿
 * "偶尔改花一句译文"换"凭据不进状态行/`title`/会话记录"，方向是有意选的。
 */
const MIN_REDACT_LENGTH = 8;

export function redactSecret(text: string, secret: string | undefined): string {
  const key = (secret ?? '').trim();
  if (key.length < MIN_REDACT_LENGTH) return text;
  return text.split(key).join('***');
}
