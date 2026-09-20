// src/options/engine-health.ts
//
// 状态点（§4.3）背后的记录：每个引擎/档案"最近一次测试连接"的结果。
//
// 为什么存 `chrome.storage.session` 而不是内存里一个 Map：
// 灰点的语义是「**从没测过**（不代表可用）」。只在内存里记的话，用户刷新一次设置页就全变回灰，
// 那句 `title` 立刻成了假话——他明明刚测过。session 区域是受信上下文可读的独立键
// （设置页是 `chrome-extension://` 同源，本来就在读它清缓存），不进 `Settings`、不动 schema 版本。
//
// **代价如实说**（README 已记）：session 区域在浏览器关闭时清空，重启后所有点回到灰。
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

/** 默认区域在**调用时**才解析：模块 import 期不该碰 `chrome`（单测里那是替身，还没装）。 */
function sessionArea(): StorageArea {
  return chromeArea(chrome.storage.session);
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

/** 记录一个引擎/档案的结果（读-改-写：只动它自己的那一条）。 */
export async function saveEngineHealth(
  id: string,
  health: EngineHealth,
  area: StorageArea = sessionArea(),
): Promise<void> {
  const current = await loadEngineHealth(area);
  await area.set({ [ENGINE_HEALTH_KEY]: { ...current, [id]: health } });
}

/** 档案被删掉时把它的记录一并清掉。 */
export async function forgetEngineHealth(id: string, area: StorageArea = sessionArea()): Promise<void> {
  const current = await loadEngineHealth(area);
  if (!(id in current)) return;
  const next = { ...current };
  delete next[id];
  await area.set({ [ENGINE_HEALTH_KEY]: next });
}
