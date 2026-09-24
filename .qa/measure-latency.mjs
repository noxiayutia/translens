// 量真实接口的 L₁ / L₁₂ / usage.completion_tokens —— 这三个数决定默认参数，不猜。
//
// 凭据从 **.qa/endpoint.json** 读（这个目录未跟踪、不入库、不经对话）：
//   { "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat", "key": "sk-..." }
// 用法：node .qa/measure-latency.mjs
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('./endpoint.json', import.meta.url), 'utf8'));
const URL_BASE = cfg.baseUrl.replace(/\/+$/, '');

// 与台架实测的批次结构对齐：MDN 一页平均每批 11.9 段 / 449 字符。
const ONE = 'The quick brown fox jumps over the lazy dog while the layout shifts settle.';
const TWELVE = Array.from(
  { length: 12 },
  (_, i) => `Segment ${i + 1}: engineers often underestimate how much reading time a nested callback chain consumes.`,
);

async function ask(texts) {
  const body = {
    model: cfg.model,
    temperature: 0,
    messages: [
      { role: 'system', content: 'Target language: zh-Hans\nYou are a professional translation engine. Output ONLY the translations, using exactly the same numbered markers and the same number of segments.' },
      { role: 'user', content: texts.map((t, i) => `<<<${i + 1}>>>\n${t}`).join('\n') },
    ],
  };
  const t0 = performance.now();
  const res = await fetch(`${URL_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  const ms = Math.round(performance.now() - t0);
  return {
    段数: texts.length,
    请求字符: body.messages[1].content.length,
    状态: res.status,
    耗时ms: ms,
    completion_tokens: json?.usage?.completion_tokens ?? '响应里没有 usage',
    prompt_tokens: json?.usage?.prompt_tokens ?? null,
    输出字符: (json?.choices?.[0]?.message?.content ?? '').length,
    输出开头: (json?.choices?.[0]?.message?.content ?? JSON.stringify(json)).slice(0, 60),
  };
}

const one = await ask([ONE]);
const twelve = await ask(TWELVE);
console.log('L₁  ', JSON.stringify(one));
console.log('L₁₂ ', JSON.stringify(twelve));
console.log('\n判读：');
console.log(`  L₁₂ / L₁ = ${(twelve.耗时ms / one.耗时ms).toFixed(2)}  ` +
  `⇒ ${twelve.耗时ms / one.耗时ms > 3 ? '线性 ⇒ 出词吞吐受限（换非推理模型 / 缩批次）' : '几乎不变 ⇒ 固定排队开销（提并发、缩批次）'}`);
const 期望token = Math.round((twelve.输出字符 / 2) * 1.4);
console.log(`  completion_tokens=${twelve.completion_tokens}，中文译文大致该在 ${期望token} 上下 ` +
  `⇒ 远超此数即思考链在烧时间`);
