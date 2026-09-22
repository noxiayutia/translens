#!/usr/bin/env node
/**
 * 校验 dist/ 里的构建产物**真的能被 Chrome 加载**。
 *
 * 背景：`vite build` 退出码 0 只说明打包器没报错，不代表产物可用。manifest 指向一个
 * 不存在的文件、内容脚本里混进一条 ESM `import`、HTML 里引用了一个没发射出来的资源——
 * 这三种都能让构建"成功"而扩展在 `chrome://extensions` 上直接报错或静默失效。
 * 把「构建成功」定义为「构建 + 本脚本通过」，才能在自动化里发现它们。
 *
 * 只用 Node 标准库，不引入任何依赖；也不依赖 cwd，从脚本自身位置推出仓库根，
 * 因此 `npm run verify:dist` 在任何目录下调用都指向同一个 dist。
 *
 * 用法：
 *   node scripts/verify-dist.mjs                 # 校验 <repo>/dist
 *   node scripts/verify-dist.mjs --dist other    # 校验指定目录（相对 cwd 或绝对路径）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodeChildProcess from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 解析 `--dist <dir>`；缺省是仓库根的 dist。 */
function resolveDistDir(argv) {
  const flag = argv.indexOf('--dist');
  if (flag === -1) return { dir: join(REPO_ROOT, 'dist'), explicit: false };
  const value = argv[flag + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--dist 后面必须跟一个目录路径');
  }
  return { dir: isAbsolute(value) ? value : resolve(process.cwd(), value), explicit: true };
}

/* ------------------------------------------------------------------ *
 * 失败收集
 * ------------------------------------------------------------------ */

/** 每一条都是「谁不满足、期望什么、实际什么」，避免只报一句"校验失败"。 */
const failures = [];
/** 成功项也逐条记下来，最后连产物清单一起打印，让人看得见到底验了什么。 */
const passed = [];

function fail(check, detail) {
  failures.push({ check, detail });
  console.error(`  ✗ ${check}\n      ${detail}`);
}

function ok(check, detail) {
  passed.push({ check, detail });
  console.log(`  ✓ ${check}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ *
 * 文件与路径小工具
 * ------------------------------------------------------------------ */

/** dist 内的相对路径统一用 POSIX 分隔符表示，报错信息在任何平台都长得一样。 */
function toPosix(p) {
  return p.split('\\').join('/');
}

function fileSize(absPath) {
  return statSync(absPath).size;
}

function exists(absPath) {
  try {
    return statSync(absPath).isFile();
  } catch {
    return false;
  }
}

/**
 * 把 manifest / HTML 里的引用解析成磁盘绝对路径。
 *
 * 关键点：**以 `/` 开头的路径按 dist 根解析，不按引用文件所在目录解析**。
 * Vite 把 popup 的资源写成 `/popup.js` / `/assets/popup.css`（扩展根绝对路径），
 * 若按 `dist/popup/` 拼就会去找 `dist/popup/popup.js`，把好产物误判成坏产物。
 * 相对路径仍按浏览器语义以引用文件所在目录为基准（`./popup.css` 在源 HTML 里就是这样）。
 */
function resolveRef(ref, distDir, referrerRel) {
  const clean = ref.split('#')[0].split('?')[0];
  if (clean === '') return null;
  if (clean.startsWith('/')) return join(distDir, clean.slice(1));
  return resolve(distDir, dirname(referrerRel), clean);
}

/** 判断一个引用是不是外部的（http/https/协议相对/data/其他协议），外部引用不做存在性检查。 */
function isExternalRef(ref) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref);
}

function readText(absPath) {
  return readFileSync(absPath, 'utf8');
}

/* ------------------------------------------------------------------ *
 * 1. dist/manifest.json
 * ------------------------------------------------------------------ */

const MANIFEST_REL = 'manifest.json';

function loadManifest(distDir) {
  const abs = join(distDir, MANIFEST_REL);

  if (!exists(abs)) {
    fail('dist/manifest.json 存在', `找不到 ${abs}`);
    return null;
  }
  ok('dist/manifest.json 存在', `${fileSize(abs)} 字节`);

  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (error) {
    fail('dist/manifest.json 可读', String(error));
    return null;
  }

  // Chrome 只在文件开头容忍一个 BOM；这里显式剥掉，好让 JSON.parse 与字段检查都拿到干净文本。
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail('dist/manifest.json 是合法 JSON', `JSON.parse 失败：${error.message}`);
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('dist/manifest.json 是合法 JSON', `顶层必须是对象，实际是 ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
    return null;
  }
  ok('dist/manifest.json 是合法 JSON', 'JSON.parse 通过');

  if (parsed.manifest_version !== 3) {
    fail('manifest_version === 3', `实际是 ${JSON.stringify(parsed.manifest_version)}`);
  } else {
    ok('manifest_version === 3');
  }

  return parsed;
}

/* ------------------------------------------------------------------ *
 * 2. manifest 引用的文件都存在
 * ------------------------------------------------------------------ */

/**
 * 收集 manifest 里所有**指向包内文件**的路径。
 * 每项带 `where`，失败信息里能直接看出是 manifest 的哪一个字段坏了。
 */
function collectManifestRefs(manifest) {
  const refs = [];
  const push = (where, value) => {
    if (typeof value === 'string' && value.trim() !== '') refs.push({ where, ref: value });
  };

  push('background.service_worker', manifest.background?.service_worker);
  push('action.default_popup', manifest.action?.default_popup);
  push('options_page', manifest.options_page);
  push('options_ui.page', manifest.options_ui?.page);
  push('action.default_icon', manifest.action?.default_icon);
  push('icons', manifest.icons);

  const contentScripts = manifest.content_scripts;
  if (Array.isArray(contentScripts)) {
    contentScripts.forEach((entry, index) => {
      const js = entry?.js;
      if (Array.isArray(js)) js.forEach((file, jsIndex) => push(`content_scripts[${index}].js[${jsIndex}]`, file));
      const css = entry?.css;
      if (Array.isArray(css)) css.forEach((file, cssIndex) => push(`content_scripts[${index}].css[${cssIndex}]`, file));
    });
  }

  // 图标既可以是字符串，也可以是 { "16": "…", "48": "…" } 这种尺寸映射。
  const flattenIcon = (where, value) => {
    if (typeof value === 'string') push(where, value);
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [size, file] of Object.entries(value)) push(`${where}[${size}]`, file);
    }
  };
  if (manifest.icons && typeof manifest.icons === 'object') flattenIcon('icons', manifest.icons);
  if (manifest.action?.default_icon) flattenIcon('action.default_icon', manifest.action.default_icon);

  // 去重：icons 与 action.default_icon 常常指的是同一批文件，报两遍没有信息量。
  const seen = new Set();
  return refs.filter((entry) => {
    const key = `${entry.where}\u0000${entry.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function checkManifestRefs(manifest, distDir) {
  const refs = collectManifestRefs(manifest);
  if (refs.length === 0) {
    fail('manifest 引用文件存在', 'manifest 里没有任何指向包内文件的引用（background / action / options 都缺失）');
    return;
  }

  const missing = [];
  for (const { where, ref } of refs) {
    if (isExternalRef(ref)) continue;
    const abs = resolveRef(ref, distDir, MANIFEST_REL);
    if (abs === null || !exists(abs)) missing.push(`${where} → ${ref}`);
  }

  if (missing.length > 0) {
    fail(
      'manifest 引用的每个文件都存在',
      `以下引用在 dist 里找不到（按 dist 根解析）：\n      - ${missing.join('\n      - ')}`,
    );
    return;
  }

  ok('manifest 引用的每个文件都存在', `${refs.length} 条引用全部命中：${refs.map((r) => r.ref).join(', ')}`);
}

/* ------------------------------------------------------------------ *
 * 3. content.js：存在、非空、无 ESM 语法
 * ------------------------------------------------------------------ */

/**
 * 把字符串 / 模板字面量 / 正则字面量 / 注释里的内容挖成等长空格，只留下代码。
 *
 * 为什么需要它：直接在源码上搜 `import` 会在文案里误报——本仓库的译文提示、
 * 错误信息全是中文常量，而产物是压缩过的，很难靠"看上下文"排除。挖空后那些字面量
 * 变成空格，词法边界仍然完整（长度不变，行号也不变），判定只剩真正的语法 token。
 *
 * 只覆盖 `'` `"` 与反引号三种字面量：产物里不可能出现 JSX 之类的扩展语法。
 */
function codeOnly(source) {
  const out = source.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  while (i < source.length) {
    const ch = source[i];

    // 行注释
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    // 块注释
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    // 字符串与模板字面量（反引号里的 ${} 也一并挖掉：这不影响 import/export 判定）
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let k = i + 1;
      while (k < source.length) {
        if (source[k] === '\\') {
          k += 2;
          continue;
        }
        if (source[k] === quote) {
          k += 1;
          break;
        }
        k += 1;
      }
      blank(i, k);
      i = k;
      continue;
    }
    // 正则字面量：只在前一个有效字符不可能结束表达式时才当正则（避免把 `a / b / c` 当正则）
    if (ch === '/') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(source[j])) j -= 1;
      const prev = j >= 0 ? source[j] : '';
      const regexAllowed = prev === '' || /[([{=,:;!&|?+\-*%^~<>]/.test(prev) || /^(return|typeof|case|in|of|do|else|void|delete|new)$/.test(prev);
      if (regexAllowed) {
        let k = i + 1;
        let inClass = false;
        let closed = false;
        while (k < source.length) {
          const c = source[k];
          if (c === '\\') {
            k += 2;
            continue;
          }
          if (c === '\n') break;
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) {
            k += 1;
            closed = true;
            break;
          }
          k += 1;
        }
        if (closed) {
          // 吃掉标志位
          while (k < source.length && /[a-z]/i.test(source[k])) k += 1;
          blank(i, k);
          i = k;
          continue;
        }
      }
    }
    i += 1;
  }

  return out.join('');
}

/** content.js 里出现即说明这**不是**经典脚本，Chrome 加载时会直接抛语法错误。 */
function findEsmSyntax(code) {
  const hits = [];

  // 静态 import / export：必须在语句起始处（行首或 `;` `}` 之后）才算，
  // 这样 `obj.import` 或 `foo.export` 这类属性名不会被误判。
  const statementPattern = /(?:^|[;}])\s*(import|export)\b/g;
  for (const match of code.matchAll(statementPattern)) {
    const start = match.index + match[0].length - match[1].length;
    const line = code.slice(0, start).split('\n').length;
    hits.push(`第 ${line} 行出现顶层 \`${match[1]}\` 语句：${snippet(code, start)}`);
  }

  // 动态 import() 同样是模块专有语法，经典脚本里会 SyntaxError。
  const dynamicPattern = /(?:^|[^.\w$])import\s*\(/g;
  for (const match of code.matchAll(dynamicPattern)) {
    const start = match.index;
    const line = code.slice(0, start).split('\n').length;
    hits.push(`第 ${line} 行出现动态 \`import(\`：${snippet(code, start)}`);
  }

  // import.meta 同理。
  const metaPattern = /(?:^|[^.\w$])import\s*\.\s*meta\b/g;
  for (const match of code.matchAll(metaPattern)) {
    const start = match.index;
    const line = code.slice(0, start).split('\n').length;
    hits.push(`第 ${line} 行出现 \`import.meta\`：${snippet(code, start)}`);
  }

  return hits;
}

/** 截一小段上下文，产物是压缩过的单行文件，光给行号没法定位。 */
function snippet(source, index) {
  const from = Math.max(0, index - 40);
  const to = Math.min(source.length, index + 60);
  return `…${source.slice(from, to).replace(/\n/g, '\\n')}…`;
}

function checkContentScript(distDir) {
  const abs = join(distDir, 'content.js');
  if (!exists(abs)) {
    fail('dist/content.js 存在', `找不到 ${abs}（内容脚本是 manifest 声明的注入入口）`);
    return null;
  }
  const size = fileSize(abs);
  if (size === 0) {
    fail('dist/content.js 非空', '文件存在但是 0 字节');
    return null;
  }
  ok('dist/content.js 存在且非空', `${size} 字节`);

  const source = readText(abs);
  const hits = findEsmSyntax(codeOnly(source));
  if (hits.length > 0) {
    fail(
      'dist/content.js 不含 ESM 语法',
      `内容脚本以经典脚本注入，ESM 语法会在加载时直接报错：\n      - ${hits.join('\n      - ')}`,
    );
  } else {
    ok('dist/content.js 不含 ESM 语法', '未发现 import / export / import.meta');
  }
  return source;
}

/* ------------------------------------------------------------------ *
 * 4. background.js：存在、非空、能在语法层面被解析
 * ------------------------------------------------------------------ */

/**
 * 只做**语法**解析，不断言运行时行为。
 *
 * 经典脚本用 `new vm.Script` 解析（解析但**不执行**，`chrome.*` 不存在也不影响）。
 *
 * `manifest.background.type === "module"` 时 background.js 是 ESM，`new Function` / `vm.Script`
 * 都不适用——`import` 出现在函数体或经典脚本里本身就是语法错误，拿它判定会把**好产物**
 * 判成坏的。ESM 要 `vm.SourceTextModule`，而它需要 `--experimental-vm-modules`，本进程没有
 * 这个标志时构造器是 undefined，所以交给 `scripts/verify-dist-esm-parse.mjs` 在带标志的
 * 子进程里解析（那边为什么不写成 `node -e` 内联，见该文件的注释）。
 *
 * 拿不到真正的模块解析器时只做弱断言（确认文件里确实有 import/export，即它果然是模块形状），
 * 并如实说明"这一项没做完整解析"，而不是伪造一个结论，也不把好产物判成坏产物。
 */
function parseCheck(source, { asModule, absPath }) {
  if (!asModule) {
    try {
      new vm.Script(source, { filename: 'background.js' });
      return { ok: true, how: 'new vm.Script() 解析通过（经典脚本）' };
    } catch (error) {
      return { ok: false, detail: `语法解析失败：${error.message}` };
    }
  }

  const inProcess = vm.SourceTextModule;
  if (typeof inProcess === 'function') {
    try {
      new inProcess(source, { identifier: 'background.js' });
      return { ok: true, how: 'vm.SourceTextModule 解析通过（ESM）' };
    } catch (error) {
      return { ok: false, detail: `ESM 语法解析失败：${error.message}` };
    }
  }

  const child = runEsModuleParser(absPath);
  if (child !== null) return child;

  // 连子进程都给不出结论（助手文件缺失、spawn 被环境挡住、超时）：退到弱断言。
  // 判据是"这个文件是不是模块形状"——既没有 import 也没有 export，那它就不是 ES 模块。
  const code = codeOnly(source);
  const hasImport = /(?:^|[;}]\s*)import\b/.test(code) || /(?:^|[^.\w$])import\s*[.(]/.test(code);
  const hasExport = /(?:^|[;}]\s*)export\b/.test(code);
  if (!hasImport && !hasExport) {
    return {
      ok: false,
      detail: 'manifest 声明 background.type = "module"，但文件里既没有 import 也没有 export，不像是有效的 ES 模块',
    };
  }
  return {
    ok: true,
    how: 'weak: 已确认文件是模块形状（含 import/export）；本机拿不到 ESM 解析器，未做完整语法解析',
  };
}

/** 让 `scripts/verify-dist-esm-parse.mjs` 在带 `--experimental-vm-modules` 的子进程里解析该文件。 */
function runEsModuleParser(absPath) {
  const helper = join(dirname(fileURLToPath(import.meta.url)), 'verify-dist-esm-parse.mjs');
  if (!exists(helper)) return null;

  const result = nodeChildProcess.spawnSync(process.execPath, [helper, absPath], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    // 标志必须由父进程显式带上：它只作用于子进程，不影响本次校验本身。
    env: { ...process.env, NODE_OPTIONS: '--experimental-vm-modules' },
  });

  if (result.error || typeof result.stdout !== 'string') return null;
  if (result.status === 0 && result.stdout.trim() === 'OK') {
    return { ok: true, how: '子进程 vm.SourceTextModule 解析通过（ESM）' };
  }
  if (result.status === 2) {
    const detail = result.stdout.trim().startsWith('FAIL:')
      ? result.stdout.trim().slice('FAIL:'.length)
      : result.stdout.trim();
    return { ok: false, detail: `ESM 语法解析失败：${detail}` };
  }
  // 退出码 3 = 子进程里也没有解析器；其余非零退出（被信号杀死等）同样交给弱断言。
  return null;
}

function checkBackground(manifest, distDir) {
  const abs = join(distDir, 'background.js');
  if (!exists(abs)) {
    fail('dist/background.js 存在', `找不到 ${abs}（manifest.background.service_worker 指向它）`);
    return;
  }
  const size = fileSize(abs);
  if (size === 0) {
    fail('dist/background.js 非空', '文件存在但是 0 字节');
    return;
  }
  ok('dist/background.js 存在且非空', `${size} 字节`);

  // 只有 manifest 明确写了 type: "module" 才按 ESM 解析；没写就是经典脚本。
  const asModule = manifest.background?.type === 'module';
  const result = parseCheck(readText(abs), { asModule, absPath: abs });
  if (!result.ok) fail('dist/background.js 能在语法层面被解析', result.detail);
  else ok('dist/background.js 能在语法层面被解析', `${result.how}${asModule ? '［manifest 声明 type=module］' : ''}`);
}

/* ------------------------------------------------------------------ *
 * 5. 两个扩展页面：存在 + 引用的本地 js/css 都存在
 * ------------------------------------------------------------------ */

/** 只挑真正会被浏览器当作本地资源去加载的属性，`<a href>` 之类的不算。 */
function collectHtmlRefs(html) {
  const refs = [];
  const tagPattern = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;

  for (const match of html.matchAll(tagPattern)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const attrValue = (name) => {
      const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
      const found = attrs.match(re);
      if (!found) return undefined;
      return found[1] ?? found[2] ?? found[3];
    };
    const rel = (attrValue('rel') ?? '').toLowerCase();

    if (tag === 'script') {
      const src = attrValue('src');
      if (src) refs.push({ tag: `<script src>`, ref: src });
      continue;
    }
    if (tag === 'link') {
      // stylesheet / modulepreload / preload(as=style|script) / icon 会真的去取文件；
      // canonical、alternate 之类指向的是外部 URL，不该按包内文件校验。
      const loadsLocal = ['stylesheet', 'modulepreload', 'icon', 'shortcut icon', 'apple-touch-icon'].some((r) =>
        rel.split(/\s+/).includes(r.split(' ').pop()),
      ) || rel === 'preload';
      if (!loadsLocal) continue;
      const href = attrValue('href');
      if (href) refs.push({ tag: `<link rel="${rel}">`, ref: href });
      continue;
    }
    if (tag === 'source' || tag === 'img' || tag === 'iframe') {
      const src = attrValue('src');
      if (src) refs.push({ tag: `<${tag} src>`, ref: src });
    }
  }

  return refs;
}

function checkHtmlPage(distDir, relPath, label) {
  const abs = join(distDir, relPath);
  if (!exists(abs)) {
    fail(`${label} 存在`, `找不到 ${abs}`);
    return;
  }
  ok(`${label} 存在`, `${fileSize(abs)} 字节`);

  const html = readText(abs);
  const refs = collectHtmlRefs(html);
  const local = refs.filter((entry) => !isExternalRef(entry.ref));
  const missing = [];
  const resolvedNotes = [];

  for (const entry of local) {
    const target = resolveRef(entry.ref, distDir, relPath);
    if (target === null) continue;
    const shown = toPosix(relative(distDir, target));
    resolvedNotes.push(`${entry.ref} → dist/${shown}`);
    if (!exists(target)) missing.push(`${entry.tag} ${entry.ref} → 期望 dist/${shown}`);
  }

  if (missing.length > 0) {
    fail(
      `${label} 引用的本地资源都存在`,
      `以 \`/\` 开头的路径按 dist 根解析，其余按 ${posix.dirname(relPath)}/ 解析：\n      - ${missing.join('\n      - ')}`,
    );
    return;
  }
  ok(`${label} 引用的本地资源都存在`, `${local.length} 条：${resolvedNotes.join('；') || '（无本地资源）'}`);
}

/* ------------------------------------------------------------------ *
 * 6. manifest 的 name / description 是合法 UTF-8（description 还要求是中文）
 * ------------------------------------------------------------------ */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const REPLACEMENT = '\ufffd';

/**
 * 从字节层面确认文本是合法 UTF-8。
 * Node 的 `toString('utf8')` 会把非法字节替换成 U+FFFD 而不抛错，所以必须显式检查
 * 替换字符——否则一份被 PowerShell 5.1 的 `Set-Content` 写成 GBK 的 manifest
 * 会"读得出来"却全是乱码，而扩展在 Chrome 里显示的名字同样是乱码。
 *
 * 这里**只**管编码与空值，不管语种：`name` 是品牌名（TransLens 这类拉丁字是正常的），
 * 语种要求只对 `description` 提，见 `checkChineseDescription`。
 */
function checkUtf8Field(manifest, field) {
  const value = manifest[field];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`manifest.${field} 是非空字符串`, `实际是 ${JSON.stringify(value)}`);
    return false;
  }
  if (value.includes(REPLACEMENT)) {
    fail(
      `manifest.${field} 是合法 UTF-8`,
      `含 U+FFFD 替换字符，文件很可能不是 UTF-8 编码：${JSON.stringify(value)}`,
    );
    return false;
  }
  ok(`manifest.${field} 是合法 UTF-8`, `"${value}"`);
  return true;
}

/**
 * `description` 额外要求是中文：扩展详情页上给中文用户看的简介。
 * `name` 不提这条——品牌名就该是品牌名，硬要求中文等于逼着改品牌。
 */
function checkChineseDescription(manifest, field) {
  if (!checkUtf8Field(manifest, field)) return;
  if (!CJK.test(manifest[field])) {
    fail(
      `manifest.${field} 含中文`,
      `未发现 CJK 字符（详情页简介面向中文用户，应写中文）：${JSON.stringify(manifest[field])}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * 产物清单
 * ------------------------------------------------------------------ */

function listFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(abs, base, out);
    else out.push({ rel: toPosix(relative(base, abs)), size: statSync(abs).size });
  }
  return out;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(2)} KB`;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

function main() {
  let distDir;
  let explicitDist = false;
  try {
    const resolvedDist = resolveDistDir(process.argv.slice(2));
    distDir = resolvedDist.dir;
    explicitDist = resolvedDist.explicit;
  } catch (error) {
    console.error(`✗ 参数错误：${error.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`校验构建产物：${distDir}`);
  console.log(explicitDist ? '（--dist 指定，非默认路径）' : '');
  console.log('');

  let distIsDirectory = false;
  try {
    distIsDirectory = statSync(distDir).isDirectory();
  } catch {
    distIsDirectory = false;
  }
  if (!distIsDirectory) {
    console.error(`✗ dist 目录不存在：${distDir}`);
    console.error('  先运行 npm run build（它会在末尾自动调用本脚本）。');
    process.exitCode = 1;
    return;
  }

  const manifest = loadManifest(distDir);
  if (manifest !== null) {
    checkManifestRefs(manifest, distDir);
    checkBackground(manifest, distDir);
    checkUtf8Field(manifest, 'name');
    checkChineseDescription(manifest, 'description');
  }

  checkContentScript(distDir);
  checkHtmlPage(distDir, posix.join('popup', 'popup.html'), 'dist/popup/popup.html');
  checkHtmlPage(distDir, posix.join('options', 'options.html'), 'dist/options/options.html');

  console.log('');
  if (failures.length > 0) {
    console.error(`✗ 产物校验失败：${failures.length} 项不满足（通过 ${passed.length} 项）`);
    failures.forEach((entry, index) => {
      console.error(`  ${index + 1}. ${entry.check}`);
      console.error(`     ${entry.detail}`);
    });
    console.error('');
    console.error('  产物不可加载。修好构建（或 manifest 引用）后重新运行 npm run build。');
    process.exitCode = 1;
    return;
  }

  const files = listFiles(distDir).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const total = files.reduce((sum, file) => sum + file.size, 0);

  console.log(`✓ 产物校验全部通过（${passed.length} 项）`);
  console.log('');
  console.log(`产物清单（${files.length} 个文件，共 ${formatBytes(total)}）：`);
  const width = Math.max(...files.map((file) => file.rel.length), 10);
  for (const file of files) {
    console.log(`  ${file.rel.padEnd(width)}  ${formatBytes(file.size).padStart(9)}`);
  }
}

main();
