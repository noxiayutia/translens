import { EngineError, toEngineError, type EngineConfig, type Term, type TranslateRequest, type Translator } from './types';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

const marker = (index: number): string => `<<<${index}>>>`;

const SYSTEM_RULES = [
  'You are a professional translation engine.',
  'You will receive numbered segments. Translate every segment into the target language.',
  'Output ONLY the translations, using exactly the same numbered markers and the same number of segments.',
  'Never merge, split, reorder or omit segments. Never add explanations, notes or quotes.',
].join(' ');

export function buildMessages(texts: string[], to: string, glossary?: Term[], systemPrompt?: string): ChatMessage[] {
  const systemParts = [`Target language: ${to}`, SYSTEM_RULES];
  if (glossary && glossary.length > 0) {
    systemParts.push(`Glossary (must be used exactly): ${glossary.map((t) => `${t.from} => ${t.to}`).join('; ')}`);
  }
  if (systemPrompt && systemPrompt.trim().length > 0) systemParts.push(systemPrompt.trim());

  const user = texts.map((text, index) => `${marker(index + 1)}\n${text}`).join('\n');
  return [
    { role: 'system', content: systemParts.join('\n') },
    { role: 'user', content: user },
  ];
}

/** 按编号标记切回逐条译文；数量或顺序不符一律抛 BAD_RESPONSE，由上层降级为逐条翻译。 */
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
    parts.push(content.slice(start, end).trim());
  }
  return parts;
}

export const openAiCompatEngine: Translator = {
  id: 'openai-compat',
  name: 'OpenAI 兼容 API',
  needsKey: true,
  supportsGlossary: true,

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
    if (!response.ok) throw new EngineError('NETWORK', `接口 HTTP ${response.status}`);

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new EngineError('BAD_RESPONSE', '接口返回内容为空');
    }
    return parseNumberedResponse(content, request.texts.length);
  },
};
