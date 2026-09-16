/**
 * 样式表断言用的最小 CSS 读取器（测试专用）。
 *
 * 为什么要有它——上一轮的"表面断言"有两处没牙的取值方式，被变异核验抓了出来：
 *
 * 1. **整张样式表里找子串**：`expect(css).toContain('max-height')`、`expect(css).toMatch(/overflow:\s*auto/)`。
 *    样式表的注释里恰好写着 `max-height:40vh` 与 `overflow:auto`，于是把 `.jy-bubble` 里
 *    那两条**真声明整条删掉**，断言照样成立——实测 44 条用例全绿。
 * 2. **字面量切片**：`text.indexOf(选择器)` 再切到**下一个** `}`。它靠"下一个右花括号"对齐，
 *    选择器是另一个选择器的前缀、块里出现嵌套、或者字面量换个位置，都会切到别人身上。
 *
 * 这里换成真解析：按**配对花括号**定位规则，选择器必须完整相等（空白归一化后比较），
 * 扫描时跳过字符串与注释。于是"删掉某条声明"＝声明表里查不到这一项＝断言当场红。
 */

/** 一条规则的声明表：属性 → 值（值里的空白已折叠）。 */
export type Declarations = Record<string, string>;

/** 扫过一段引号字面量（`"…"` / `'…'`，含转义），返回结束引号之后的下标。 */
function skipString(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  return text.length;
}

/**
 * 去掉 `/* … *\/` 注释（字符串里的 `/*` 不算注释）。
 * 注释里出现过的字面量绝不能算"有这条声明"——这正是上一轮假通过的来源。
 */
export function stripCssComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"' || ch === "'") {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 选择器归一化：折叠空白、去掉末尾的 `{`（调用方可以带也可以不带）。 */
function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, ' ').trim().replace(/\s*\{$/, '').trim();
}

interface Scanned {
  prelude: string;
  body: string;
  end: number;
}

/** 从 `start` 起扫一条规则：前导文本（选择器）+ 配对花括号内的声明块。 */
function scanRule(text: string, start: number): Scanned | null {
  let i = start;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"' || ch === "'") {
      i = skipString(text, i);
      continue;
    }
    if (ch === '{') break;
    i += 1;
  }
  if (i >= text.length) return null;

  let depth = 1;
  let j = i + 1;
  while (j < text.length && depth > 0) {
    const ch = text[j] as string;
    if (ch === '"' || ch === "'") {
      j = skipString(text, j);
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    j += 1;
  }
  return { prelude: text.slice(start, i), body: text.slice(i + 1, Math.max(i + 1, j - 1)), end: j };
}

/** 在**当前层级**找选择器完全相等的规则；@media / @keyframes 这类嵌套块整块跳过。 */
function findInScope(scope: string, selector: string): string | null {
  const wanted = normalizeSelector(selector);
  let i = 0;
  while (i < scope.length) {
    const rule = scanRule(scope, i);
    if (rule === null) return null;
    if (normalizeSelector(rule.prelude) === wanted) return rule.body;
    i = rule.end;
  }
  return null;
}

/** 扫过一段文本，按顶层分隔符切块（跳过字符串与嵌套花括号）。 */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let chunk = '';
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"' || ch === "'") {
      const end = skipString(text, i);
      chunk += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === separator && depth === 0) {
      parts.push(chunk);
      chunk = '';
      i += 1;
      continue;
    }
    chunk += ch;
    i += 1;
  }
  parts.push(chunk);
  return parts;
}

/** 取 `@media …` / `@keyframes …` 的花括号内部（嵌套层级用）。 */
export function atRuleBody(text: string, atRule: string): string {
  const clean = stripCssComments(text);
  const body = findInScope(clean, atRule);
  if (body === null) throw new Error(`样式表里没有 at-rule「${atRule}」`);
  return body;
}

/**
 * 取某条规则的声明块文本。`scope` 给定时先进入那个 at-rule（例如
 * `atRuleBody` 语义的 `@media (prefers-reduced-motion: reduce)`），用来区分
 * 同名的两条规则（顶层一条、媒体查询里一条）。找不到就抛错——选择器写错要当场炸，
 * 不能静默返回空串让断言变成"永远成立"。
 */
export function declarationBlock(text: string, selector: string, scope?: string): string {
  const region = scope === undefined ? stripCssComments(text) : atRuleBody(text, scope);
  const body = findInScope(region, selector);
  if (body === null) {
    throw new Error(`样式表里没有选择器「${selector}」的规则${scope === undefined ? '' : `（作用域 ${scope}）`}`);
  }
  return body;
}

/** 该规则在不在（`@keyframes` 这类没有普通声明的块用这个）。 */
export function hasRule(text: string, selector: string, scope?: string): boolean {
  try {
    declarationBlock(text, selector, scope);
    return true;
  } catch {
    return false;
  }
}

/** 把声明块切成 属性 → 值。后写的同名声明覆盖先写的（与级联一致）。 */
export function parseDeclarations(body: string): Declarations {
  const out: Declarations = {};
  for (const chunk of splitTopLevel(stripCssComments(body), ';')) {
    const at = chunk.indexOf(':');
    if (at < 0) continue;
    const property = chunk.slice(0, at).trim();
    const value = chunk.slice(at + 1).replace(/\s+/g, ' ').trim();
    if (property === '' || value === '') continue;
    out[property] = value;
  }
  return out;
}

/** 一步到位：取某条规则的声明表。 */
export function declarations(text: string, selector: string, scope?: string): Declarations {
  return parseDeclarations(declarationBlock(text, selector, scope));
}
