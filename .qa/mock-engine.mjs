// 本地 OpenAI 兼容「假引擎」：让整条翻译链路在真浏览器里跑通，而完全不碰任何真实 Key / 额度。
// 只监听 127.0.0.1，进程退出即消失。
//
// 用法：node .qa/mock-engine.mjs [port]
//   POST /v1/chat/completions  → 按请求形状回译文（译文 = 「译·」+ 原文，便于逐条核对顺序与错位）
//     · 多段请求带 <<<n>>> 编号 → 按编号回
//     · 单段请求不带编号（见 src/engines/openai-compat.ts 的 SINGLE_RULES）→ 直接回一条
//   GET  /v1/models            → 两个模型，供设置页「获取可用模型」
//   GET  /__ctl                → 当前模式与累计统计
//   POST /__ctl {"mode":...}   → 切模式；{"reset":true} 清零统计
//
// 模式：ok / auth401 / rate429(前 2 次 429 后恢复) / tooLong413 / http500 / badjson /
//       badmarkers(少一段，只对带编号的请求生效) / empty(返回空内容) / slow(挂 60s)
//
// 改这个文件之前先读 `docs/qa/2026-09-24-measurement-traps.md`：这里的每一个计数器都踩过"闸放在被测行为之后
// ⇒ 读数恒为 0"这类坑（共六个），它们骗掉的是一整轮验收结论。

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixture');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const PORT = Number(process.argv[2] ?? 8787);
const state = {
  mode: 'ok',
  requests: 0,
  segments: 0,
  chars: 0,
  log: [],
  rate429Remaining: 0,
  /** 逐次覆盖响应码：第 n 次请求用 sequence[n-1]（401/429/500/413…），用完回到 mode。 */
  sequence: [],
  /** 每次 /chat/completions 固定挂起多少毫秒，用来模拟真实模型的单请求延迟 L。 */
  delayMs: 0,
  /** 按真机测得的接口画像延迟（≈950ms + 3.45ms/字符），而不是固定值。 */
  profile: false,
  /** 同时最多允许几路在飞；超出的请求直接回 429（模拟服务商的真实限流窗口）。 */
  allowConcurrent: 0,
  inflight: 0,
  rejected429: 0,
  backoffs: 0,
};

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-methods': 'POST,GET,OPTIONS',
  });
  res.end(text);
};

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'OPTIONS') return json(res, 204, {});

  if (url.pathname === '/__ctl') {
    if (req.method === 'GET') return json(res, 200, { mode: state.mode, delayMs: state.delayMs, allowConcurrent: state.allowConcurrent, requests: state.requests, rejected429: state.rejected429, inflight: state.inflight, segments: state.segments, chars: state.chars });
    const body = JSON.parse((await readBody(req)) || '{}');
    if (body.reset) {
      state.requests = 0;
      state.segments = 0;
      state.chars = 0;
      state.log = [];
      state.rate429Remaining = 0;
      state.sequence = [];
      state.rejected429 = 0;
    }
    if (Array.isArray(body.sequence)) state.sequence = [...body.sequence];
    if (typeof body.delayMs === 'number') state.delayMs = body.delayMs;
    if (typeof body.profile === 'boolean') state.profile = body.profile;
    if (typeof body.allowConcurrent === 'number') state.allowConcurrent = body.allowConcurrent;
    if (body.mode) {
      state.mode = body.mode;
      state.rate429Remaining = body.mode === 'rate429' ? 2 : 0;
    }
    return json(res, 200, { ok: true, mode: state.mode });
  }

  if (url.pathname === '/__log') return json(res, 200, { requests: state.requests, log: state.log });

  if (url.pathname === '/v1/models') {
    return json(res, 200, { data: [{ id: 'mock-mini' }, { id: 'mock-plus' }] });
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    state.requests += 1;
    const raw = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: { message: 'mock: body 不是 JSON' } });
    }
    const user = payload?.messages?.find((m) => m.role === 'user')?.content ?? '';
    const system = payload?.messages?.find((m) => m.role === 'system')?.content ?? '';
    // 两种请求形状：多段带 `<<<N>>>` 编号，单段**不带**（`src/engines/openai-compat.ts`
    // 的 `MULTI_RULES` / `SINGLE_RULES`：单段没有需要拆回来的东西）。
    // 只认标记的话，单段请求会被数成 0 段 —— `segments` 静默少算，正是
    // `docs/qa/2026-09-24-measurement-traps.md` 总则 3 那一类失效。
    const numbered = /<<<\d+>>>/.test(user);
    const parts = numbered
      ? [...user.split(/<<<\d+>>>/g).slice(1)].map((s) => s.trim())
      : user.trim() === ''
        ? []
        : [user.trim()];
    state.segments += parts.length;
    state.chars += user.length;
    const entry = {
      n: state.requests,
      at: Date.now(),
      model: payload?.model,
      temperature: payload?.temperature,
      numbered,
      segs: parts.length,
      chars: user.length,
      hasKey: Boolean(req.headers.authorization),
      system: system.slice(0, 900),
      user: user.slice(0, 6000),
    };
    state.log.push(entry);
    // 限流窗口：**必须在睡之前判**。放在延迟之后的话，每个请求都在计数窗口外面睡完
    // 再进来，闸永远不触发（第一版扫描就是这么跑出"被拒 429 次 = 0"的假读数的）。
    if (state.allowConcurrent > 0 && state.inflight >= state.allowConcurrent) {
      state.rejected429 += 1;
      entry.rejected = true;
      entry.doneAt = Date.now();
      return json(res, 429, { error: { message: 'mock: concurrency limit' } });
    }
    state.inflight += 1;
    res.on('close', () => {
      state.inflight -= 1;
    });

    if (state.delayMs > 0) await new Promise((r) => setTimeout(r, state.delayMs));
    else if (state.profile) {
      // 真机测得的接口画像（.qa/measure-latency.mjs 的读数）：
      //   L₁=1489ms/37 tok，L₁₂=5236ms/296 tok ⇒ 拟合 固定 ≈950ms + ≈14.5ms/token。
      //   中文输出 token ≈ 0.238 × 请求字符数（1265 字符 → 实测 296 tok）。
      // ⇒ 延迟 ≈ 950 + 3.45 × 字符数 毫秒。
      await new Promise((r) => setTimeout(r, Math.round(950 + 3.45 * user.length)));
    }
    // 记在**这一次请求自己的**日志条目上。旧写法是 `state.log[length-1].doneAt = ...`：
    // 并发时最后一条日志根本不是刚睡完那一个，于是所有区间都被记成"不重叠"，
    // "峰值在飞"恒为 1（详见 `docs/qa/2026-09-24-measurement-traps.md` 第 7 条）。
    entry.doneAt = Date.now();

    const mode = state.mode;
    const forced = state.sequence.shift();
    if (forced !== undefined) {
      return json(
        res,
        forced,
        forced === 500
          ? { error: { message: '<img src=x onerror=alert(1)>boom from gateway' } }
          : { error: { message: `mock: forced ${forced}` } },
      );
    }
    if (mode === 'htmlerror') {
      return json(res, 500, { error: { message: '<img src=x onerror=alert(1)>boom' } });
    }
    if (mode === 'auth401') return json(res, 401, { error: { message: 'bad key' } });
    if (mode === 'rate429') {
      if (state.rate429Remaining > 0) {
        state.rate429Remaining -= 1;
        return json(res, 429, { error: { message: 'mock: rate limited' } });
      }
    }
    if (mode === 'tooLong413') return json(res, 413, { error: { message: 'mock: too long' } });
    if (mode === 'http500') return json(res, 500, { error: { message: 'Model Not Exist' } });
    if (mode === 'badjson') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end('<html>not json</html>');
    }
    if (mode === 'slow') {
      // 挂到超过缩放后最长的预算（300 秒封顶），这样"超时文案"只可能由内容脚本那侧产生。
      await new Promise((r) => setTimeout(r, 400000));
      return json(res, 200, {});
    }
    if (mode === 'badmarkers' && numbered) {
      // 只破坏**带编号**的请求：单段请求本来就没有编号可错。
      // 若在这里无条件回 `<<<1>>>` 形状，降级后的逐条请求（全是单段）会把
      // `<<<1>>>只有一段` 当成译文收下 —— `run-errors.mjs` 的
      // 「降级后仍然全部译出」会绿，而 14 个格子填的其实是同一句标记文本。
      return json(res, 200, { choices: [{ message: { content: '<<<1>>>\n只有一段' } }] });
    }
    if (mode === 'empty') {
      return json(res, 200, {
        choices: [{ message: { content: numbered ? '<<<1>>>\n' + '<<<2>>>'.repeat(parts.length) : '' } }],
      });
    }

    const content = numbered
      ? parts.map((text, i) => `<<<${i + 1}>>>\n译·${text}`).join('\n')
      : `译·${parts[0] ?? ''}`;
    return json(res, 200, { choices: [{ message: { content } }] });
  }

  // 测试页面夹具走 http:// 同源：内容脚本的 matches 只有 http/https，file:// 注入不进去。
  if (url.pathname.startsWith('/fixture/')) {
    const name = url.pathname.slice('/fixture/'.length).replace(/[?#].*$/, '');
    const file = join(FIXTURE_DIR, name);
    if (!file.startsWith(FIXTURE_DIR) || !existsSync(file)) {
      return json(res, 404, { error: { message: `no fixture ${name}` } });
    }
    const ext = name.slice(name.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'text/plain; charset=utf-8' });
    return res.end(readFileSync(file));
  }

  json(res, 404, { error: { message: `mock: 未知路径 ${url.pathname}` } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock engine on http://127.0.0.1:${PORT}/v1`);
});
