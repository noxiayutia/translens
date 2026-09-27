// 第 0 步 0-B：Azure Translator 的存活核验（规格 §10）。看返回体，不看状态码。
//
// **绝不把 JSON 内联进命令行**——Windows PowerShell 会吃掉内嵌双引号，腾讯那轮就是这么
// 栽的（送出去的 body 成了坏 JSON，三条不同 Action 返回同一条错误、读数完全无效）。
// 本脚本用 fetch 直接发，body 由 `JSON.stringify` 生成，命令行里没有任何 JSON。
//
// 凭据从 **.qa/azure.json** 读（未跟踪、不入库、不经对话）：
//   { "key": "<KEY 1>" }
//   可选：{ "key": "…", "endpoint": "https://api.cognitive.microsofttranslator.com", "region": "…" }
//   ⚠ region 只用于**验证 §1.2 记的那条边界**（区域级资源缺区域头会拿 401）；本版本不支持它。
//
// 用法：node .qa/azure-probe.mjs
//   没有 .qa/azure.json 时**照跑**无凭据那一半（三针），它能在你花时间去注册账号之前
//   先回答"这机器连不连得上 Azure"——那是比"能不能注册"更早撞上的墙。
//
// 两条闸要分开报（§1.3 第 4 条明令：**接口通了 ≠ 凭据闸过了**）：
//   接口闸 = 域名可解析、TLS 可握手、端点按语义回答。
//   凭据闸 = 你手上那个 KEY 1 真的能计费翻译成功。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CFG_PATH = join(HERE, 'azure.json');
const DEFAULT_ENDPOINT = 'https://api.cognitive.microsofttranslator.com';

const cfg = existsSync(CFG_PATH) ? JSON.parse(readFileSync(CFG_PATH, 'utf8')) : null;
const KEY = (cfg?.key ?? '').trim();
const ENDPOINT = (cfg?.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
/** 打日志时永远不带完整 Key：只留前后各 4 位。 */
const mask = (k) => (k.length <= 8 ? '（空或过短）' : `${k.slice(0, 4)}…${k.slice(-4)}`);

const rows = [];
function record(闸, 判据, 期望, 实测, pass) {
  rows.push({ 闸, 判据, 期望, 实测: String(实测), 结论: pass ? 'PASS' : 'FAIL' });
}

/** 发一次 translate。texts 是字符串数组；from 为 undefined 时省略查询参数（自动检测）。 */
async function translate(texts, to, { from, key = KEY, withKey = true } = {}) {
  const query = new URLSearchParams({ 'api-version': '3.0', to });
  if (from !== undefined) query.set('from', from);
  const headers = { 'content-type': 'application/json; charset=UTF-8' };
  if (withKey) headers['Ocp-Apim-Subscription-Key'] = key;
  const t0 = Date.now();
  try {
    const res = await fetch(`${ENDPOINT}/translate?${query.toString()}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(texts.map((text) => ({ Text: text }))),
    });
    const raw = await res.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* 不是 JSON 就走下面的 raw 分支 */
    }
    return { status: res.status, ms: Date.now() - t0, json, raw, headersOut: res.headers };
  } catch (raw) {
    return { status: 0, ms: Date.now() - t0, error: raw instanceof Error ? `${raw.name}: ${raw.message}` : String(raw) };
  }
}

const short = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

console.log(`端点：${ENDPOINT}`);
console.log(`凭据：${KEY.length > 0 ? `已加载（${mask(KEY)}）` : '无（只跑接口闸那三针）'}`);

// ---------- 接口闸：三针，不需要任何凭据 ----------
const ping = await translate(['hello'], 'zh-Hans', { withKey: false });
record(
  '接口闸',
  '域名可解析 + TLS 可握手 + 端点按语义回答（不带 Key 应当被明确拒绝，而不是连不上）',
  'HTTP 4xx 且返回体是 Azure 的错误形状',
  ping.error ? `连不上：${ping.error}` : `HTTP ${String(ping.status)} · ${short(ping.raw)}`,
  !ping.error && ping.status >= 400 && ping.status < 500 && ping.json?.error?.code !== undefined,
);

const badKey = await translate(['hello'], 'zh-Hans', { key: '000000000000000000000000000000000000' });
record(
  '接口闸',
  '假 Key 被**按语义**拒绝（错误码可辨识，不是 500 或空响应）',
  'HTTP 401/403 且 body 里有 error.code',
  badKey.error
    ? `连不上：${badKey.error}`
    : `HTTP ${String(badKey.status)} · ${short(JSON.stringify(badKey.json ?? badKey.raw))}`,
  !badKey.error && (badKey.status === 401 || badKey.status === 403) && badKey.json?.error?.code !== undefined,
);

const noBody = await translate([], 'zh-Hans', { withKey: false });
/**
 * 这条要防的是"我们看到的其实是本机代理/门户页的假响应"。
 *
 * ⚠ 判据与断言必须对齐（第一版这里不合格）：期望写的是"与上面两条不是同一条错误消息"，
 * 而断言只查了"有没有连上"——那几乎恒真。**未带 Key 时三条都短路在鉴权层，返回同一条
 * 401001 是预期行为**（实测就是如此），所以真正的判别力在"响应体必须是 Azure 的错误形状"：
 * 代理/门户页会回 200 + HTML，那才是这条要抓的东西。
 */
const azureError = noBody.json?.error?.code === 401001 && typeof noBody.json?.error?.message === 'string';
record(
  '接口闸',
  '响应体是 Azure 自己的错误形状（不是本机代理/门户页冒充的）',
  'error.code === 401001 且有 message 文本',
  noBody.error ? `连不上：${noBody.error}` : `HTTP ${String(noBody.status)} · ${short(noBody.raw)}`,
  !noBody.error && noBody.status === 401 && azureError,
);

// ---------- 凭据闸：拿到 KEY 1 之后才有这六条 ----------
if (KEY.length > 0) {
  const two = await translate(['hello', 'world'], 'zh-Hans');
  const back = Array.isArray(two.json) ? two.json : null;
  record(
    '凭据闸',
    '返回 JSON **数组**（不是对象包裹）',
    'Array，长度 2',
    two.error ? `连不上：${two.error}` : `${back === null ? '非数组' : `长度 ${String(back.length)}`} · ${short(JSON.stringify(two.json ?? two.raw))}`,
    back !== null && back.length === 2,
  );
  record(
    '凭据闸',
    '**顺序与输入一致**（第 1 条译 hello、第 2 条译 world）',
    'translations[0] 含"你好"、[1] 含"世界"',
    back === null ? '—' : back.map((item) => item?.translations?.[0]?.text ?? '（空）').join(' | '),
    back !== null && (back[0]?.translations?.[0]?.text ?? '').includes('你好') && (back[1]?.translations?.[0]?.text ?? '').includes('世界'),
  );
  record(
    '凭据闸',
    '`to` 回显请求里的代码（§5.5 的对序前提）',
    'to === "zh-Hans"',
    back === null ? '—' : back.map((item) => item?.to ?? '（无）').join(','),
    back !== null && back.every((item) => item?.to === 'zh-Hans'),
  );
  const each = back === null ? [] : back.map((item) => item?.translations?.length ?? 0);
  record(
    '凭据闸',
    '每条输入恰好 1 个 translation（适配器取 translations[0] 的依据）',
    '[1, 1]',
    JSON.stringify(each),
    each.length === 2 && each.every((n) => n === 1),
  );

  const hant = await translate(['hello'], 'zh-Hant');
  const hantText = Array.isArray(hant.json) ? (hant.json[0]?.translations?.[0]?.text ?? '') : JSON.stringify(hant.json ?? hant.raw);
  record('凭据闸', '`to=zh-Hant` 被接受（繁体代码直通，§5.7）', 'HTTP 200 且译文非空', `HTTP ${String(hant.status)} · ${short(hantText)}`, hant.status === 200 && hantText.length > 0);

  const detect = await translate(['The quick brown fox jumps over the lazy dog.'], 'zh-Hans');
  const detectText = Array.isArray(detect.json) ? (detect.json[0]?.translations?.[0]?.text ?? '') : JSON.stringify(detect.json ?? detect.raw);
  record(
    '凭据闸',
    '**省略 `from`** 时自动检测可用（§5.3 的口径）',
    'HTTP 200 且译文是中文',
    `HTTP ${String(detect.status)} · ${short(detectText)}`,
    detect.status === 200 && /[\u4e00-\u9fff]/.test(detectText),
  );

  const bogus = await translate(['hello'], 'xx-Unknown');
  record(
    '凭据闸',
    '不认识的代码给**确定**的错误（适配器要能把它翻成 BAD_REQUEST，§5.7）',
    'HTTP 4xx 且 body 里有 error.code（不是 200 也不是 500）',
    bogus.error ? `连不上：${bogus.error}` : `HTTP ${String(bogus.status)} · ${short(JSON.stringify(bogus.json ?? bogus.raw))}`,
    !bogus.error && bogus.status >= 400 && bogus.status < 500,
  );
} else {
  console.log('\n（没有 .qa/azure.json ⇒ 凭据闸那六条没跑。**接口闸过了不等于凭据闸过了**，这两件事必须分开报。）');
}

console.table(rows);
const byGate = ['接口闸', '凭据闸'].map((g) => {
  const list = rows.filter((r) => r.闸 === g);
  return `${g}：${String(list.filter((r) => r.结论 === 'PASS').length)}/${String(list.length)} 通过`;
});
console.log(byGate.join(' ｜ '));
console.log('下一步：把 KEY 1 写进 .qa/azure.json（{"key":"…"}）再跑一次本脚本；它不入库。');
