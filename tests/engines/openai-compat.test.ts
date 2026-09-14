import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMessages, openAiCompatEngine, parseNumberedResponse } from '../../src/engines/openai-compat';
import { EngineError } from '../../src/engines/types';

function chatResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const CONFIG = { apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', model: 'test-model' };

function request(texts: string[]) {
  return { texts, from: 'auto', to: 'zh-Hans', signal: new AbortController().signal };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildMessages', () => {
  it('生成 system 与 user 两条消息', () => {
    const messages = buildMessages(['Hello', 'World'], 'zh-Hans');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('user 消息带编号标记', () => {
    const messages = buildMessages(['Hello', 'World'], 'zh-Hans');
    expect(messages[1].content).toContain('<<<1>>>');
    expect(messages[1].content).toContain('<<<2>>>');
  });

  it('术语表写进 system 消息', () => {
    const messages = buildMessages(['Hello'], 'zh-Hans', [{ from: 'DSH', to: 'DeepSeek Harness' }]);
    expect(messages[0].content).toContain('DSH => DeepSeek Harness');
  });

  it('自定义提示词写进 system 消息', () => {
    const messages = buildMessages(['Hello'], 'zh-Hans', undefined, '保持技术术语不译');
    expect(messages[0].content).toContain('保持技术术语不译');
  });
});

describe('parseNumberedResponse', () => {
  it('按编号切回多条译文', () => {
    const content = '<<<1>>>\n你好\n<<<2>>>\n世界';
    expect(parseNumberedResponse(content, 2)).toEqual(['你好', '世界']);
  });

  it('编号数量不符抛 BAD_RESPONSE', () => {
    expect(() => parseNumberedResponse('<<<1>>>\n你好', 2)).toThrow(EngineError);
  });

  it('编号顺序错乱抛 BAD_RESPONSE', () => {
    expect(() => parseNumberedResponse('<<<2>>>\n乙\n<<<1>>>\n甲', 2)).toThrow(EngineError);
  });

  it('单条时也能解析', () => {
    expect(parseNumberedResponse('<<<1>>>\n你好', 1)).toEqual(['你好']);
  });
});

describe('openAiCompatEngine.translate', () => {
  it('缺少配置时抛 AUTH', async () => {
    await expect(
      openAiCompatEngine.translate(request(['A']), { apiKey: '', baseUrl: '', model: '' }),
    ).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('成功解析编号响应', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好\n<<<2>>>\n世界'));
    vi.stubGlobal('fetch', fetchMock);
    const out = await openAiCompatEngine.translate(request(['Hello', 'World']), CONFIG);
    expect(out).toEqual(['你好', '世界']);
  });

  it('请求体使用配置的模型且 temperature 为 0', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好'));
    vi.stubGlobal('fetch', fetchMock);
    await openAiCompatEngine.translate(request(['Hello']), CONFIG);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.model).toBe('test-model');
    expect(body.temperature).toBe(0);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.example.com/v1/chat/completions');
  });

  it('baseUrl 末尾斜杠不会产生双斜杠', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好'));
    vi.stubGlobal('fetch', fetchMock);
    await openAiCompatEngine.translate(request(['Hello']), { ...CONFIG, baseUrl: 'https://api.example.com/v1/' });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.example.com/v1/chat/completions');
  });

  it('401 抛 AUTH', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse('', 401)));
    await expect(openAiCompatEngine.translate(request(['A']), CONFIG)).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('429 抛 RATE_LIMIT', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse('', 429)));
    await expect(openAiCompatEngine.translate(request(['A']), CONFIG)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
  });

  it('响应缺少 content 抛 BAD_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 })));
    await expect(openAiCompatEngine.translate(request(['A']), CONFIG)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});
