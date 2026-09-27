import { LANGUAGES } from '../core/lang';
import { hasHostPermission, originPattern } from '../shared/host-permission';
import { describeHttpError, statusToErrorCode } from './api-error';
import { EngineError, toEngineError, type EngineConfig, type Term, type TranslateRequest, type Translator } from './types';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

const marker = (index: number): string => `<<<${index}>>>`;

/**
 * 编号协议只为**多段**存在：它的唯一作用是把 N 条译文拆回原顺序，而单段没有可拆的东西。
 * 实测 MiMo `mimo-v2.6-flash` 在单段时 0/8 会吞掉 `<<<1>>>`（`temperature:0`，同一输入
 * 八次给出 `1 你好` / `1. 你好` / `1>>>\n你好` / 整句英文回复各不相同），
 * 免标记请求则 15/15 直接给出干净译文。
 */
const MULTI_RULES = [
  'You are a professional translation engine.',
  'You will receive numbered segments. Translate every segment into the target language.',
  'Output ONLY the translations, using exactly the same numbered markers and the same number of segments.',
  'Never merge, split, reorder or omit segments. Never add explanations, notes or quotes.',
  // 缺这一句时 MiMo 会把标记改写成 `1.` / `1 ` / `1>>>`（3 段实测 3/8~7/8，两次测法本身就不一致）。
  // 补上"逐字符复制"后 3 段 12/12。换标记形状没用：`[[1]]` 3/8、`<1>` 6/8、`@@@1@@@` 1/8。
  'Each marker has the exact form <<<N>>>. Copy that marker verbatim, character by character, including every < and >, immediately before its translation.',
].join(' ');

const SINGLE_RULES = [
  'You are a professional translation engine.',
  'Translate the user message into the target language.',
  'Output ONLY the translation. Never add explanations, notes or quotes.',
].join(' ');

/** 裸标签模型未必认得：MiMo 对 `Target language: zh-Hans` 回过一次「请指定目标语言。」 */
function targetLanguageName(code: string): string {
  const label = LANGUAGES.find((option) => option.code === code)?.label;
  return label ? `${label} (${code})` : code;
}

export function buildMessages(texts: string[], to: string, glossary?: Term[], systemPrompt?: string): ChatMessage[] {
  const single = texts.length === 1;
  const systemParts = [`Target language: ${targetLanguageName(to)}`, single ? SINGLE_RULES : MULTI_RULES];
  if (glossary && glossary.length > 0) {
    systemParts.push(`Glossary (must be used exactly): ${glossary.map((t) => `${t.from} => ${t.to}`).join('; ')}`);
  }
  if (systemPrompt && systemPrompt.trim().length > 0) systemParts.push(systemPrompt.trim());

  const user = single ? texts[0] : texts.map((text, index) => `${marker(index + 1)}\n${text}`).join('\n');
  return [
    { role: 'system', content: systemParts.join('\n') },
    { role: 'user', content: user },
  ];
}

/** 按编号标记切回逐条译文；数量、顺序或分段内容为空一律抛 BAD_RESPONSE，由上层降级为逐条翻译。 */
export function parseNumberedResponse(content: string, count: number): string[] {
  const matches = [...content.matchAll(/<<<(\d+)>>>/g)];
  if (matches.length !== count) {
    throw new EngineError('BAD_RESPONSE', `模型返回 ${matches.length} 段，期望 ${count} 段`);
  }
  const parts: string[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    if (Number(matches[i][1]) !== i + 1) {
      throw new EngineError('BAD_RESPONSE', '模型返回的分段编号顺序错乱');
    }
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? content.length) : content.length;
    const text = content.slice(start, end).trim();
    if (text.length === 0) {
      throw new EngineError('BAD_RESPONSE', `模型返回的第 ${i + 1} 段为空`);
    }
    parts.push(text);
  }
  return parts;
}

/**
 * 单段直接取整条 `content`（请求里根本没有标记，见 `MULTI_RULES` 的说明）；
 * 多段仍按编号切回。
 *
 * 这里要顺手抹掉**开头多余的** `<<<1>>>`：有些模型养成了一律回显标记的习惯，
 * 而单段路径不再要求它，不抹就会把 `<<<1>>>` 原样贴到用户的页面上。
 * 只认开头那一个 —— 出现在中间的 `<<<1>>>` 是正文的一部分，不该被动。
 */
export function parseResponse(content: string, count: number): string[] {
  if (count !== 1) return parseNumberedResponse(content, count);
  const text = content.replace(/^\s*<<<1>>>\s*/, '').trim();
  if (text.length === 0) {
    throw new EngineError('BAD_RESPONSE', '模型返回的内容只有空白');
  }
  return [text];
}

export const openAiCompatEngine: Translator = {
  id: 'openai-compat',
  name: 'OpenAI 兼容 API',
  needsKey: true,
  supportsGlossary: true,
  // 这条协议的请求体里 `model` 是必填字段（缺它服务商直接 400），所以"没有模型"必须算错误。
  needsModel: true,

  async translate(request: TranslateRequest, config: EngineConfig): Promise<string[]> {
    const apiKey = (config.apiKey ?? '').trim();
    const baseUrl = (config.baseUrl ?? '').trim();
    const model = (config.model ?? '').trim();
    if (!apiKey) throw new EngineError('AUTH', '尚未填写 API Key，请在设置中配置');
    if (!baseUrl) throw new EngineError('AUTH', '尚未填写接口地址，请在设置中配置');
    if (!model) throw new EngineError('AUTH', '尚未填写模型名，请在设置中配置');

    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body = {
      model,
      temperature: 0,
      messages: buildMessages(request.texts, request.to, request.glossary, request.systemPrompt),
    };

    /**
     * 发请求**之前**确认这个 origin 已经被用户授权。
     *
     * manifest 只声明了 `optional_host_permissions`，而 Chrome 要求可选权限在用户手势里
     * 申请（设置页的「保存」按钮做这件事）。没申请就发请求时浏览器会把它拦下，而我们拿到的
     * 只是一个失败的 fetch——错误会伪装成 `NETWORK`（"断网"），用户查不出真正的原因，
     * 也找不到该去哪儿点。
     *
     * 没有权限 API 的环境（纯 Node 单测）里 `hasHostPermission` 恒为 true：
     * 引擎必须保持可独立单测。
     */
    const pattern = originPattern(baseUrl);
    if (pattern === undefined) {
      throw new EngineError('AUTH', `接口地址不是合法的 URL：${baseUrl}，请在设置中修正`);
    }
    if (!(await hasHostPermission(pattern))) {
      throw new EngineError('AUTH', '未授权访问该接口地址，请到设置页保存一次以授权');
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (raw) {
      if (request.signal.aborted) throw new EngineError('ABORTED', '请求已取消');
      throw new EngineError('NETWORK', `接口请求失败：${toEngineError(raw).message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new EngineError('AUTH', 'API Key 无效或权限不足，请检查设置');
    }
    if (response.status === 429) throw new EngineError('RATE_LIMIT', '接口限流，请稍后重试');
    if (response.status === 413) throw new EngineError('TOO_LONG', '文本过长');
    if (!response.ok) {
      // 服务商把真正的原因写在响应体里（DeepSeek 对写错的模型名会说 "Model Not Exist"），
      // 必须读出来给用户看，否则他只能对着一句"接口 HTTP 400"猜——这不是假想场景：
      // 实测就是模型名填成 `deepseek`（正确值是 `deepseek-chat`）卡住的，而界面上只有 400。
      throw new EngineError(statusToErrorCode(response.status), await describeHttpError(response));
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (raw) {
      throw new EngineError('BAD_RESPONSE', `接口返回的不是合法 JSON：${toEngineError(raw).message}`);
    }
    const payload = data as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new EngineError('BAD_RESPONSE', '接口返回内容为空');
    }
    return parseResponse(content, request.texts.length);
  },
};
