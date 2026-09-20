// src/background/models.ts
//
// `{baseUrl}/models` 的拉取：谁去发（后台，§5.1）、形状多宽容（§5.2）、失败怎么分类（§5.3）、
// 超时多长（§5.3：10 秒，**独立于**内容脚本的 `BACKGROUND_TIMEOUT_MS`——那是 60 秒的整页
// 翻译预算，语义完全不同）。
//
// 为什么不放进 `src/engines/**`：分层守卫（`tests/core/layering.test.ts`）规定 `src/core` 与
// `src/engines` 里不许出现宿主全局标识符（连注释都不许），而"读设置、理解档案"是宿主层的事。
// 这个模块只依赖纯函数与一个**类型**，因此能在纯 node 里单测。
import { extractErrorDetail } from '../engines/api-error';
import { toEngineError } from '../engines/types';
import { hasHostPermission, originPattern } from '../shared/host-permission';
import type { EngineProfile } from '../shared/settings';

/**
 * §5.3：10 秒。这是用户点一下按钮就在等的一次请求（比整页翻译短得多），
 * 刻意不复用 `src/content/index.ts` 的 `BACKGROUND_TIMEOUT_MS`（60 秒）。
 */
export const MODELS_TIMEOUT_MS = 10_000;

/** 拉取结果。`ok: true` 但清单为空 = "这个地址没给出模型列表"，不是失败。 */
export type ModelsFetchResult = { ok: true; models: string[] } | { ok: false; message: string };

/**
 * 把 `/models` 的响应体解析成模型名清单（§5.2 的三种形状）：
 *
 * ```
 * { data: [{ id: 'gpt-4o' }, …] }      // OpenAI / 多数兼容网关
 * { models: [{ name: 'qwen2.5:14b' }] } // 部分实现
 * [ { id: '…' }, … ]                    // 直接给数组
 * ```
 *
 * 三条宽容：条目取 `id ?? name`；**非字符串一律丢弃**；整体解析不出任何一条时返回 `[]`
 * （调用方按"该服务商不提供模型列表"处理，引导手填——不是报错完事）。
 */
export function parseModelsPayload(data: unknown): string[] {
  const entries: unknown[] = Array.isArray(data)
    ? data
    : data !== null && typeof data === 'object'
      ? pickEntries(data as Record<string, unknown>)
      : [];
  const out: string[] = [];
  for (const entry of entries) {
    const name = modelNameOf(entry);
    if (name === null || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

function pickEntries(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.models)) return payload.models;
  return [];
}

/** 条目取 `id ?? name`：`id` 是字符串就用它，否则看 `name`；都不是字符串就丢掉这一条。 */
function modelNameOf(entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const raw = typeof record.id === 'string' ? record.id : record.name;
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name.length > 0 ? name : null;
}

/**
 * 失败分类（§5.3）：四类各自一句能读懂的话，**每一句都保留手填路径**（手填是永远可达的出路）。
 *
 * 纯函数，单独导出便于直连单测：五句互不相同这件事，只有把五句放在一起才能断言。
 */
export function describeModelsStatus(status: number, detail: string): string {
  const tail = detail.length > 0 ? `：${detail}` : '';
  if (status === 401 || status === 403) {
    return `接口拒绝了这次请求（HTTP ${status}）${tail}。请检查这个档案的 API Key；也可以只用「添加模型」手填。`;
  }
  if (status === 404) {
    return `这个地址没有 /models 这个端点（HTTP 404）${tail}。不是所有服务商都提供模型列表——请用「添加模型」手填。`;
  }
  if (status >= 500) {
    return `服务商那边出错了（HTTP ${status}）${tail}。可以稍后重试，或直接用「添加模型」手填。`;
  }
  return `这个地址不接受这次请求（HTTP ${status}）${tail}。请核对接口地址；也可以直接用「添加模型」手填。`;
}

/** 正文读不出来（流被中断等）不算错误：状态码本身仍然有信息量。 */
async function readDetail(response: Response): Promise<string> {
  try {
    return extractErrorDetail(await response.text());
  } catch {
    return '';
  }
}

/**
 * 真的去拉一次。**只由设置页点「获取可用模型」触发**（§5.4：打开设置页不拉、切档案不拉、
 * 聚焦输入框不拉）。
 *
 * 拿到的是**存储里**那份档案（调用方负责从存储读出来）：面板里还没保存的地址 / Key 改动不参与。
 */
export async function fetchModels(profile: EngineProfile): Promise<ModelsFetchResult> {
  const baseUrl = profile.baseUrl.trim();
  const apiKey = profile.apiKey.trim();
  if (baseUrl.length === 0) {
    return { ok: false, message: '这个档案还没填接口地址，先在「自定义设置」里填上再拉取。' };
  }
  if (apiKey.length === 0) {
    return { ok: false, message: '这个档案还没填 API Key，模型列表接口需要它；也可以直接用「添加模型」手填。' };
  }

  // §5.5：`{baseUrl}/models` 落在档案保存时已申请的 origin 范围内（**不需要新权限**），
  // 但用户当时可能拒了授权。与引擎同一条纪律：发请求前先问一句——不问的话，浏览器的拦截会
  // 伪装成"网络不可达"，用户完全不知道该去哪儿点（`host-permission.ts` 的文件头写着这件事）。
  const pattern = originPattern(baseUrl);
  if (pattern === undefined) {
    return { ok: false, message: `接口地址不是合法的 URL：${baseUrl}。请先在「自定义设置」里修正。` };
  }
  if (!(await hasHostPermission(pattern))) {
    return {
      ok: false,
      message: `还没授权访问 ${pattern}，这个请求会被浏览器拦下。请回设置页重新保存一次这个档案（授权只能在点击时申请）。`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
  } catch (raw) {
    // 中止与"网络不可达"要分开说：前者是"再等等也许就行"，后者是"先看看地址与网络"。
    return {
      ok: false,
      message: controller.signal.aborted
        ? `拉取模型清单超时（${MODELS_TIMEOUT_MS / 1000} 秒没有响应）。可以稍后重试，或直接用「添加模型」手填。`
        : `拉取模型清单失败：${toEngineError(raw).message}。可以检查接口地址与网络，或直接用「添加模型」手填。`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) return { ok: false, message: describeModelsStatus(response.status, await readDetail(response)) };

  let data: unknown;
  try {
    data = await response.json();
  } catch (raw) {
    return {
      ok: false,
      message: `接口返回的不是合法 JSON：${toEngineError(raw).message}。不是所有服务商都提供模型列表——请用「添加模型」手填。`,
    };
  }
  // 解析不出任何一条**不是失败**：调用方按 §5.2 引导手填。
  return { ok: true, models: parseModelsPayload(data) };
}
