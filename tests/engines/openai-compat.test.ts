import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMessages, openAiCompatEngine, parseNumberedResponse, parseResponse } from '../../src/engines/openai-compat';
import { EngineError, RETRYABLE_CODES } from '../../src/engines/types';

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

  /**
   * 单段**不发**编号标记。这不是风格选择，是实测出来的：MiMo `mimo-v2.6-flash` 在
   * 单段时 0/8 会吞掉 `<<<1>>>`（同一输入回 `1 你好` / `1. 你好` / `1>>>\n你好`），
   * 免标记则 15/15 给出干净译文。而单段本来就是「测试连接」和降级逐条的形状。
   */
  it('单段请求不带编号标记，user 消息就是原文', () => {
    const messages = buildMessages(['Hello'], 'zh-Hans');
    expect(messages[1].content).toBe('Hello');
    expect(messages[1].content).not.toContain('<<<');
  });

  it('单段用单段规则，不提编号也不提标记', () => {
    const system = buildMessages(['Hello'], 'zh-Hans')[0].content;
    expect(system).toContain('Translate the user message');
    expect(system).not.toContain('numbered segments');
    expect(system).not.toContain('<<<N>>>');
  });

  it('多段要求逐字符复制标记', () => {
    const system = buildMessages(['Hello', 'World'], 'zh-Hans')[0].content;
    expect(system).toContain('Copy that marker verbatim');
  });

  /** `Target language: zh-Hans` 实测被 MiMo 回过一次「请指定目标语言。」 */
  it('目标语言写成模型认得的名字，而不是裸标签', () => {
    expect(buildMessages(['Hello', 'World'], 'zh-Hans')[0].content).toContain('简体中文 (zh-Hans)');
    // 表里没有的语言不能把文案写成 `undefined (xx)`：退回裸标签。
    expect(buildMessages(['Hello', 'World'], 'xx')[0].content).toContain('Target language: xx');
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

  it('分段内容为空抛 BAD_RESPONSE', () => {
    let caught: unknown;
    try {
      parseNumberedResponse('<<<1>>><<<2>>>\n你好', 2);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).code).toBe('BAD_RESPONSE');
  });

  it('分段只有空白也抛 BAD_RESPONSE', () => {
    let caught: unknown;
    try {
      parseNumberedResponse('<<<1>>>\n   \n<<<2>>>\n你好', 2);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).code).toBe('BAD_RESPONSE');
  });
});

describe('parseResponse', () => {
  it('单段直接取整条内容（请求里本来就没有标记）', () => {
    expect(parseResponse('你好', 1)).toEqual(['你好']);
    expect(parseResponse('  你好\n', 1)).toEqual(['你好']);
  });

  it('单段只有空白也抛 BAD_RESPONSE', () => {
    let caught: unknown;
    try {
      parseResponse('   \n ', 1);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).code).toBe('BAD_RESPONSE');
  });

  /**
   * 单段不再要求标记，但有些模型养成了一律回显的习惯 —— 不抹就会把
   * `<<<1>>>` 原样贴到用户页面上。这条钉住那个漏洞已经补上。
   */
  it('单段会抹掉模型自作主张加的开头标记', () => {
    expect(parseResponse('<<<1>>>\n你好', 1)).toEqual(['你好']);
    expect(parseResponse('<<<1>>>你好', 1)).toEqual(['你好']);
    // 只有开头那一个被抹；中间的属于正文。
    expect(parseResponse('甲 <<<1>>> 乙', 1)).toEqual(['甲 <<<1>>> 乙']);
    // 只剩标记没有内容，仍然要抛，不能贴一个空格子上去。
    expect(() => parseResponse('<<<1>>>', 1)).toThrow(EngineError);
  });

  /**
   * 这条钉的是"别把单段的宽容推广到多段"：多段仍必须数得到标记，
   * 否则顺序错位会被静默吞掉。
   */
  it('多段仍走编号协议，不因单段分支而放松', () => {
    expect(() => parseResponse('你好\n世界', 2)).toThrow(EngineError);
    expect(parseResponse('<<<1>>>\n你好\n<<<2>>>\n世界', 2)).toEqual(['你好', '世界']);
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

  /** 端到端钉住单段这一条路：发出去不带标记，回来的裸文本就是译文。 */
  it('单段：请求体无标记，响应无标记也能成功', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('你好'));
    vi.stubGlobal('fetch', fetchMock);
    const out = await openAiCompatEngine.translate(request(['Hello']), CONFIG);
    expect(out).toEqual(['你好']);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.messages[1].content).toBe('Hello');
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

  it('400 抛 BAD_REQUEST，并把服务商给的原因原样带到文案里', async () => {
    // 实测场景：模型名填成 `deepseek`（正确值是 `deepseek-chat`），DeepSeek 就是这么回应的。
    // 之前这里归成 NETWORK、且正文被丢掉，用户只看到「接口 HTTP 400」，完全查不出原因。
    //
    // 必须用 mockImplementation 而不是 mockResolvedValue：后者每次返回**同一个** Response
    // 对象，而响应体只能读一次，第二次调用会因为流已消费而拿不到正文。
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Model Not Exist', type: 'invalid_request_error' } }), {
            status: 400,
          }),
      ),
    );

    const error = await openAiCompatEngine.translate(request(['A']), CONFIG).catch((raw: unknown) => raw);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe('BAD_REQUEST');
    expect((error as EngineError).message).toContain('Model Not Exist');
  });

  it('400 不可重试：不该让调度器白退避三次，也不该给用户挂没用的重试按钮', () => {
    expect(RETRYABLE_CODES.has('BAD_REQUEST')).toBe(false);
  });

  it('500 仍归 NETWORK（可重试），但同样带上正文原因', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () => new Response(JSON.stringify({ error: { message: 'upstream busy' } }), { status: 503 }),
      ),
    );

    const error = await openAiCompatEngine.translate(request(['A']), CONFIG).catch((raw: unknown) => raw);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe('NETWORK');
    expect((error as EngineError).message).toContain('upstream busy');
    expect(RETRYABLE_CODES.has('NETWORK')).toBe(true);
  });

  it('响应缺少 content 抛 BAD_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 })));
    await expect(openAiCompatEngine.translate(request(['A']), CONFIG)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('响应体不是合法 JSON 时抛 BAD_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>oops</html>', { status: 200 })));
    await expect(openAiCompatEngine.translate(request(['A']), CONFIG)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('接口地址不是合法 URL 时抛 AUTH 并说明地址有问题', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      openAiCompatEngine.translate(request(['A']), { ...CONFIG, baseUrl: 'api.example.com/v1' }),
    ).rejects.toMatchObject({ code: 'AUTH', message: expect.stringContaining('不是合法的 URL') });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * manifest 只声明了 `optional_host_permissions`，而 Chrome 要求可选权限在用户手势里申请。
   * 没授权就发请求时浏览器会把它拦下，而我们拿到的只是一个失败的 fetch——错误会伪装成
   * `NETWORK`（"断网"），用户查不出原因也找不到该去哪儿点。所以发请求**之前**先查一次权限。
   */
  it('未授权该 origin 时抛 AUTH 并指路设置页，且一个请求都不发', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const contains = vi.fn().mockResolvedValue(false);
    vi.stubGlobal('chrome', { permissions: { contains } });

    await expect(openAiCompatEngine.translate(request(['A']), CONFIG)).rejects.toMatchObject({
      code: 'AUTH',
      message: expect.stringContaining('未授权访问该接口地址，请到设置页保存一次以授权'),
    });

    // 查的是这个端点自己的 origin 模式，不是别的什么串。
    expect(contains).toHaveBeenCalledWith({ origins: ['https://api.example.com/*'] });
    // 关键：拦在 fetch 之前——被浏览器拦下就只剩一个伪装成 NETWORK 的失败。
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('已授权该 origin 时照常发请求', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好'));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('chrome', { permissions: { contains: vi.fn().mockResolvedValue(true) } });

    await expect(openAiCompatEngine.translate(request(['A']), CONFIG)).resolves.toEqual(['你好']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('没有权限 API 的环境（纯 Node 单测）不做权限判断', async () => {
    // `vi.stubGlobal('chrome', …)` 一次都不调：`typeof chrome === 'undefined'` 这条路
    // 就是引擎能在纯 Node 里被单测的前提，上面所有既有用例其实都在走它。
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('<<<1>>>\n你好'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(openAiCompatEngine.translate(request(['A']), CONFIG)).resolves.toEqual(['你好']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
