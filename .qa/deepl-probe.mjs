// 第 0 步：DeepL 存活核验（规格 §1.2 / §10）。看返回体，不看状态码。
//
// 凭据从 **.qa/deepl.json** 读（未跟踪、不入库、不经对话）：
//   { "freeKey": "xxxxxxxx:fx" }            // 免费 Key（后缀 :fx）
//   { "freeKey": "...", "paidKey": "..." }  // 有付费 Key 再加
// 用法：node .qa/deepl-probe.mjs          只打免费端点
//       node .qa/deepl-probe.mjs --paid   额外用免费 Key 打付费端点（验 §5.6 那句 403）
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('./deepl.json', import.meta.url), 'utf8'));
const FREE = 'https://api-free.deepl.com';
const PAID = 'https://api.deepl.com';
const KEY = (cfg.freeKey ?? '').trim();
if (KEY.length === 0) {
  console.error('.qa/deepl.json 里 freeKey 是空的');
  process.exit(2);
}

const results = [];
const queue = []; // 打印推迟到跑完之后，失败时也拿得到整份读数

function check(label, pass, note) {
  results.push({ label, pass, note });
  if (!pass) queue.push(`❌ ${label} ← ${note}`);
}

async function translate(base, form, label) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) {
    for (const item of Array.isArray(v) ? v : [v]) body.append(k, item);
  }
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/v2/translate`, {
      method: 'POST',
      headers: { authorization: `DeepL-Auth-Key ${KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON 也要看到原文 */
    }
    queue.push(
      `### ${label}\n  HTTP ${res.status} · ${Math.round(performance.now() - t0)}ms\n  ${
        text.length > 500 ? text.slice(0, 500) + `…（共 ${text.length} 字）` : text
      }`,
    );
    return { status: res.status, json };
  } catch (raw) {
    queue.push(`### ${label}\n  fetch 抛错：${String(raw)}`);
    return { status: 0, json: null };
  }
}

/** 一次目标语言核验：条数、每条非空、顺序指纹。 */
async function targetLangProbe(label, target, texts, orderMarkers, source) {
  const out = await translate(FREE, { text: texts, target_lang: target, ...(source ? { source_lang: source } : {}) }, label);
  const tr = out.json?.translations;
  check(`${label}｜200 + 返回 translations`, out.status === 200 && Array.isArray(tr), `HTTP ${out.status}`);
  if (!Array.isArray(tr)) return;
  check(`${label}｜条数 = ${texts.length}`, tr.length === texts.length, `实得 ${tr.length}`);
  check(
    `${label}｜每条是非空字符串`,
    tr.every((item) => typeof item?.text === 'string' && item.text.trim().length > 0),
    JSON.stringify(tr.map((i) => i?.text)),
  );
  if (orderMarkers === undefined) return;
  const got = tr.map((i) => i.text).join(' / ');
  queue.push(`  译文：${got}`);
  check(
    `${label}｜顺序与输入一致（逐条含 ${orderMarkers.join('/')}）`,
    orderMarkers.every((marker, i) => tr[i]?.text?.includes(marker)) === true,
    `实得 ${got}（若只是措辞差异，人工确认后把这条判据改掉）`,
  );
}

async function usageProbe() {
  const res = await fetch(`${FREE}/v2/usage`, { headers: { authorization: `DeepL-Auth-Key ${KEY}` } });
  const text = await res.text();
  queue.push(`### /v2/usage（额度）\n  HTTP ${res.status}\n  ${text}`);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 落到下面的判据 */
  }
  check(
    `/v2/usage｜免费层 50 万字符（规格 §11.3 那一格）`,
    json?.character_limit === 500000,
    `实测 character_limit=${json?.character_limit} → 要改规格 §1.3/§1.4/§5.6/§6.2 里的"50 万"`,
  );
  queue.push(`  已用 ${json?.character_count} / ${json?.character_limit}`);
}

async function batchCeilingProbe(size) {
  const texts = Array.from({ length: size }, (_, i) => `Sample sentence number ${i + 1} for the ceiling probe.`);
  const out = await translate(FREE, { text: texts, target_lang: 'ZH', source_lang: 'EN' }, `${size} 条一批（§5.4 上限）`);
  const tr = out.json?.translations;
  return { status: out.status, len: Array.isArray(tr) ? tr.length : undefined };
}

async function main() {
  // §10 第 0 步的三条主判据
  await targetLangProbe('ZH-HANS 两条', 'ZH-HANS', ['hello', 'world'], ['你', '世']);
  // §5.8 的回退档与繁体档
  await targetLangProbe('ZH 回退', 'ZH', ['hello', 'world'], ['你', '世']);
  await targetLangProbe('ZH-HANT 繁体', 'ZH-HANT', ['good morning', 'thank you'], ['早', '謝']);
  // §5.3：不给 source_lang = 自动检测
  await targetLangProbe('无 source_lang 自动检测', 'EN', ['早上好', '谢谢'], ['Good morning', 'Thank you']);
  // ⚠ 规格 §5.8 的表只写了 target_lang；源语言侧要不要简繁变体，这两条给读数
  await targetLangProbe('source_lang=ZH-HANS', 'EN', ['早上好'], ['Good morning'], 'ZH-HANS');
  await targetLangProbe('source_lang=ZH 对照', 'EN', ['早上好'], ['Good morning'], 'ZH');

  await usageProbe();

  const ok50 = await batchCeilingProbe(50);
  check('50 条一批被接受（§5.4：夹取上限 50 == DeepL 上限 50）', ok50.status === 200 && ok50.len === 50, `HTTP ${ok50.status} · ${ok50.len} 条`);
  const bad51 = await batchCeilingProbe(51);
  queue.push(`  51 条一批：HTTP ${bad51.status} · 返回 ${bad51.len} 条（§5.4 的"分块路径不可达"依赖这一格）`);

  if (process.argv.includes('--paid')) {
    const out = await translate(PAID, { text: ['hello'], target_lang: 'ZH-HANS' }, '免费 Key 打 api.deepl.com');
    check('免费 Key 打付费端点 → 403（§5.6 那句文案的第二支）', out.status === 403, `实得 HTTP ${out.status}`);
  }
}

main()
  .catch((raw) => queue.push(`脚本自身抛错：${String(raw)}`))
  .finally(() => {
    console.log(queue.join('\n\n'));
    console.log('\n================ 判据汇总 ================');
    for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.pass ? '' : '  |  ' + r.note}`);
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} 条通过`);
    if (failed > 0) console.log('⚠ 按 §10：把读数写回规格那一格，不要悄悄改代码。');
    process.exit(failed > 0 ? 1 : 0);
  });
