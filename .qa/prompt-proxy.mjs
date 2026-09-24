// 透明转发代理：让**真实**模型响应穿过**真实**的扩展链路，同时把逐字请求体留在本地。
//
// 为什么不是直接 fetch 真接口了事：那样测的是我在脚本里手抄的一份提示词。
// `measure-latency.mjs` 就是这么干的（它把 system 文本写死在脚本里），它的读数只够拟合斜率，
// 不够回答"产品现在这句提示词效果如何"。这里让浏览器里的 `buildMessages` 自己产出请求，
// 我只在中间过一道手。
//
// 为什么监听 8787：`.qa/make-hostperm-dist.mjs` 产出的 dist-perm 已把
// `http://127.0.0.1:8787/*` 挪进必选 host 权限，台架不需要真鼠标点授权。
//
// 真实 Key 只在 Node 侧注入：扩展档案里写的是 proxy-key，所以 Key 不进浏览器、
// 不进 chrome.storage、也不出现在任何抓包里。
//
// 用法（由 run-prompt-baseline.mjs import，不单独跑）。
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixture');

export function startProxy({ port = 8787, upstream, key }) {
  const entries = [];
  /** 每一个打到本代理的 HTTP 请求（含 OPTIONS 预检）。用来分清"Chrome 根本没放行"与"放行了但响应不对"。 */
  const hits = [];
  let inflight = 0;
  let rejected = 0;

  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, {
      'content-type': type,
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type,authorization',
      'access-control-allow-methods': 'POST,GET,OPTIONS',
    });
    res.end(body);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    hits.push(`${req.method} ${url.pathname}`);

    if (req.method === 'OPTIONS') return send(res, 204, '');

    if (req.method === 'GET' && url.pathname === '/__ctl') {
      return send(res, 200, JSON.stringify({ mode: 'proxy', upstream, requests: entries.length, inflight, rejected, hits }));
    }
    if (req.method === 'GET' && url.pathname === '/__log') {
      return send(res, 200, JSON.stringify({ log: entries }));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/fixture/')) {
      const name = url.pathname.slice('/fixture/'.length);
      const file = join(FIXTURE_DIR, name);
      // 只允许 fixture 目录里的文件：路径穿越会把仓库任意文件当页面送出去。
      if (!name.endsWith('.html') || !file.startsWith(FIXTURE_DIR) || !existsSync(file)) {
        return send(res, 404, 'not found', 'text/plain; charset=utf-8');
      }
      return send(res, 200, readFileSync(file), 'text/html; charset=utf-8');
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const raw = await new Promise((resolve) => {
        let acc = '';
        req.on('data', (c) => (acc += c));
        req.on('end', () => resolve(acc));
      });
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        rejected += 1;
        return send(res, 400, JSON.stringify({ error: 'proxy: body is not json' }));
      }
      const messages = body.messages ?? [];
      const entry = {
        t0: Date.now(),
        model: body.model,
        temperature: body.temperature,
        system: messages.find((m) => m.role === 'system')?.content ?? '',
        user: messages.find((m) => m.role === 'user')?.content ?? '',
        status: null,
        content: '',
        ms: null,
        usage: null,
      };
      entries.push(entry);
      inflight += 1;
      const started = performance.now();
      try {
        const upstreamRes = await fetch(`${upstream.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ ...body, model: body.model }),
        });
        const text = await upstreamRes.text();
        entry.status = upstreamRes.status;
        entry.ms = Math.round(performance.now() - started);
        try {
          const json = JSON.parse(text);
          entry.content = json?.choices?.[0]?.message?.content ?? '';
          entry.usage = json?.usage ?? null;
        } catch {
          entry.content = '';
          entry.usage = { note: '上游返回的不是 JSON' };
        }
        // 原样转回去：状态码与响应体都不改，扩展看到的就是服务商给的。
        send(res, upstreamRes.status, text);
      } catch (err) {
        entry.status = 0;
        entry.ms = Math.round(performance.now() - started);
        entry.content = '';
        entry.usage = { note: `转发失败：${err.message}` };
        rejected += 1;
        send(res, 502, JSON.stringify({ error: 'proxy upstream unreachable' }));
      } finally {
        inflight -= 1;
      }
      return undefined;
    }

    return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      resolve({
        entries,
        ctl: () => ({ requests: entries.length, inflight, rejected, hits: hits.slice() }),
        stop: () => new Promise((r) => server.close(r)),
      }));
  });
}
