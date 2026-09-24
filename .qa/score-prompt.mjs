// 提示词标识符保真度的判据（纯函数，不碰网络、不开 Chrome）。
//
// 存在的理由：要判断"给提示词加一句保留规则有没有用"，得先有一把**量得出好坏**的尺子。
// 光量"标识符有没有被原样返回"是不够的——一句"什么都别译，全部原样吐回来"就能拿满分，
// 而那样的提示词等于把翻译功能关掉。所以每条 已知答案 段都配着 控制散文 段：
// 后者要求"必须被译成中文且不等于输入"，专门挡这个退化实现。
//
// 三类段的分工（缺任何一类，剩下的读数都不成立）：
//   verbatim —— 整段就是一个标识符/URL/邮箱，判据是**逐字节相等**（硬）
//   prose    —— 真散文，判据是"含汉字且与输入不同"（硬，反退化）
//   semi     —— 半结构（时间戳行），只报数不判：产品上它到底该不该原样，还没定

export const CASES = [
  { id: 'v-table', kind: 'verbatim', text: '<table>' },
  { id: 'v-prop', kind: 'verbatim', text: 'overscroll-behavior' },
  { id: 'v-doi', kind: 'verbatim', text: 'https://doi.org/10.48550/arXiv.2303.08774' },
  { id: 'v-mail', kind: 'verbatim', text: 'monnand@gmail.com' },
  { id: 's-stamp', kind: 'semi', text: '[v1] Wed, 15 Mar 2023 17:15:04 UTC (3,853 KB)' },
  { id: 'p-one', kind: 'prose', text: 'Engineers often underestimate how much reading time a nested callback chain consumes.' },
  { id: 'p-two', kind: 'prose', text: 'The quick brown fox jumps over the lazy dog while the layout shifts settle.' },
  { id: 'p-three', kind: 'prose', text: 'This section describes how the extension reuses cached results across page reloads.' },
  // 整段就是标识符那一类在 MiMo 上 8/8 原样返回（基线实测），真正没测过的是这种：
  // 标识符夹在散文里，句子该译、标识符该留。
  { id: 'm-prop', kind: 'embedded', token: 'overscroll-behavior', text: 'Set overscroll-behavior to contain to stop scroll chaining.' },
  { id: 'm-tag', kind: 'embedded', token: '<caption>', text: 'The <caption> element labels the columns of a data table.' },
  { id: 'm-hook', kind: 'embedded', token: 'useEffect', text: 'Call useEffect only when the component mounts for the first time.' },
];

/** 硬判据那几类（semi 不计入通过线）。 */
export const HARD_KINDS = ['verbatim', 'prose', 'embedded'];

/** 目标语言是 zh-Hans，所以只认汉字区间；日文假名/谚文不算"已译出"。 */
const HAN = /[一-鿿]/;
const MARKER_LINE = /^<<<(\d+)>>>$/gm;

/** 抹掉单段路径里模型自作加的开头标记——与 `src/engines/openai-compat.ts` 的 parseResponse 同口径。 */
const stripLead = (content) => content.replace(/^\s*<<<1>>>\s*/, '').trim();

/**
 * 把一个请求认成"多段编号形状"还是"单段形状"。
 * 判据只看 user 侧的标记行数，不看段数常量：这样产品端改了批次大小不需要同步这里。
 */
export function classifyRequest(user) {
  const hits = [...user.matchAll(MARKER_LINE)];
  if (hits.length === 0) return { shape: 'single', count: 1, order: [1] };
  return { shape: 'numbered', count: hits.length, order: hits.map((m) => Number(m[1])) };
}

/**
 * 按标记切回逐条译文；形状不合（段数、顺序、空段）返回 null，由调用方记成"这一轮降级了"。
 *
 * 这里的标记正则**必须与产品 `parseNumberedResponse` 一致**：不限定行首、全局匹配。
 * 模型把译文写在标记同一行（`<<<1>>> 你好`）是实测的常见输出，锚定行首会把这种好答案
 * 误判成"少一段"——尺子一旦比产品严，读数就在测尺子而不是测提示词。
 * 每次现取一个新实例：带 g 的正则自带可变 lastIndex（同仓库 `segmenter.ts` 的教训）。
 */
export function splitNumbered(content, count) {
  const hits = [...content.matchAll(/<<<(\d+)>>>/g)];
  if (hits.length !== count) return null;
  if (hits.some((m, i) => Number(m[1]) !== i + 1)) return null;
  const parts = [];
  for (let i = 0; i < hits.length; i += 1) {
    const start = (hits[i].index ?? 0) + hits[i][0].length;
    const end = i + 1 < hits.length ? (hits[i + 1].index ?? content.length) : content.length;
    const text = content.slice(start, end).trim();
    if (text.length === 0) return null;
    parts.push(text);
  }
  return parts;
}

/** 一条段的判定。返回 pass=false 而不是抛，因为一个 case 失败不该中断整轮读数。 */
export function judge(c, output) {
  const out = output ?? '';
  if (c.kind === 'verbatim') return { pass: out === c.text, 输出: out, 逐字: out === c.text };
  if (c.kind === 'prose') {
    return { pass: out !== c.text && HAN.test(out), 输出: out, 含汉字: HAN.test(out), 未原样: out !== c.text };
  }
  // 夹在句子里的标识符：两个方向都会错——整句不译（prose 那半边已经挡过）与把标识符译掉。
  // 所以判据是"含汉字 且 token 原样出现在输出里"，两个条件缺一个都算红。
  if (c.kind === 'embedded') {
    const 保留 = out.includes(c.token);
    return { pass: HAN.test(out) && out !== c.text && 保留, 输出: out, 标识符保留: 保留, 已译出: HAN.test(out) };
  }
  return { pass: null, 输出: out, 逐字: out === c.text };
}

/**
 * 一轮读数的对账入口：entries 是代理抓到的**真发出去的**请求与模型原始响应，
 * 顺序即发出顺序。cases 传进来是为了让自检能喂假 case 表；实跑用导出的 CASES。
 *
 * 这里刻意不算"平均分"，只逐条报 n/m：MiMo 在 temperature:0 下同一输入八次结果不同，
 * 均值会把"某条稳定失败"和"每条偶发失败"糊成同一个数。
 */
export function scoreRun({ entries, cases = CASES }) {
  const located = new Map();
  const shapeIssues = [];
  let markerOkEntries = 0;

  entries.forEach((entry, entryIndex) => {
    const req = classifyRequest(entry.user);
    let outputs;
    if (req.shape === 'numbered') {
      outputs = splitNumbered(entry.content, req.count);
      if (outputs === null) {
        shapeIssues.push({ 第几个请求: entryIndex, 原因: `响应里标记数/顺序/空段不符（user 侧 ${req.count} 段）` });
        return;
      }
      markerOkEntries += 1;
    } else {
      outputs = [stripLead(entry.content)];
      markerOkEntries += 1;
    }
    const sent = req.shape === 'numbered' ? segmentTexts(entry.user, req.count) : [entry.user.trim()];
    if (sent.length === 0) {
      shapeIssues.push({ 第几个请求: entryIndex, 原因: `user 侧按行切不出 ${req.count} 段正文，无法定位到段` });
      return;
    }
    sent.forEach((text, i) => {
      if (!located.has(text)) located.set(text, { 输出: outputs[i], entryIndex, 段序: i });
    });
  });

  const 逐条 = cases.map((c) => {
    const hit = located.get(c.text);
    const verdict = judge(c, hit?.输出);
    return {
      id: c.id,
      kind: c.kind,
      输入: c.text,
      找到: Boolean(hit),
      在请求: hit?.entryIndex ?? null,
      ...verdict,
    };
  });

  const 硬 = 逐条.filter((r) => HARD_KINDS.includes(r.kind));
  return {
    请求数: entries.length,
    每请求段数: entries.map((e) => classifyRequest(e.user).count),
    标记完整请求: `${markerOkEntries}/${entries.length}`,
    形状问题: shapeIssues,
    逐条,
    通过: 硬.filter((r) => r.pass && r.找到).length,
    硬判据条数: 硬.length,
    缺失: 逐条.filter((r) => !r.找到).map((r) => r.id),
  };
}

/** 多段请求的 user 文本 → 逐段正文（标记独占一行，所以按行切即可与产品形状对齐）。 */
export function segmentTexts(user, count) {
  const parts = [];
  const lines = user.split('\n');
  let current = null;
  for (const line of lines) {
    const m = /^<<<(\d+)>>>$/.exec(line);
    if (m) {
      if (current !== null) parts.push(current.join('\n').trim());
      current = [];
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) parts.push(current.join('\n').trim());
  return parts.length === count ? parts : [];
}

/** 跨轮汇总：每个 case 的 n/m 通过数。 */
export function aggregate(runs, cases = CASES) {
  return cases.map((c) => {
    const seen = runs.map((r) => r.逐条.find((x) => x.id === c.id)).filter(Boolean);
    const 硬 = HARD_KINDS.includes(c.kind);
    return {
      id: c.id,
      kind: c.kind,
      计数: 硬 ? `${seen.filter((s) => s.pass && s.找到).length}/${runs.length}` : `（不判）${seen.filter((s) => s.逐字).length}/${runs.length} 逐字`,
      样本: seen.map((s) => s.输出).slice(0, 3),
    };
  });
}
