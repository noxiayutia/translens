// 把计划里的代码块同步为仓库文件的当前内容，保证「母本 → 切片 → 仓库」三方一致。
//
// 计划里的代码块用首行 `// <仓库相对路径>` 标记它对应哪个文件。
// 只同步「标记指向的文件真实存在」的块；尚未实现的文件会被跳过并列出。
//
// 用法：node scripts/sync-plan-code.mjs <计划文件> [限定路径前缀...]
//   不带前缀参数时同步全部已实现的块；带前缀时只同步匹配的块。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , planPath, ...prefixes] = process.argv;
if (!planPath) {
  console.error('用法: node scripts/sync-plan-code.mjs <计划文件> [路径前缀...]');
  process.exit(1);
}

const repoRoot = process.cwd();
const raw = readFileSync(planPath, 'utf8');
const newline = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.replace(/\r\n/g, '\n').split('\n');

const PATH_LABEL = /^\/\/\s*(\S+\.(?:ts|json|css|html|mjs))\s*$/;

const output = [];
let synced = 0;
const skipped = new Set();

for (let i = 0; i < lines.length; i += 1) {
  const fence = /^```(\w*)\s*$/.exec(lines[i]);
  if (!fence) {
    output.push(lines[i]);
    continue;
  }

  // 找到这个围栏块的结束行
  let end = i + 1;
  while (end < lines.length && !/^```\s*$/.test(lines[end])) end += 1;
  if (end >= lines.length) {
    output.push(...lines.slice(i));
    break;
  }

  const body = lines.slice(i + 1, end);
  const label = body.length > 0 ? PATH_LABEL.exec(body[0].trim()) : null;

  if (!label) {
    output.push(...lines.slice(i, end + 1));
    i = end;
    continue;
  }

  const relPath = label[1];
  const wanted = prefixes.length === 0 || prefixes.some((p) => relPath.startsWith(p));
  const absPath = join(repoRoot, relPath);

  if (!wanted || !existsSync(absPath)) {
    if (wanted && !existsSync(absPath)) skipped.add(relPath);
    output.push(...lines.slice(i, end + 1));
    i = end;
    continue;
  }

  const bodyLines = readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '').split('\n');
  // 仓库文件自己就带 `// <路径>` 首行标记时，那一行同时就是围栏块的标记，
  // 不能既当标记又当成被丢弃的"块首行"，也不能在块里重复写两遍。
  const hasInlineMarker = bodyLines[0] === body[0].trim();
  const before = (hasInlineMarker ? body.slice(0) : body.slice(1))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
  const fileText = bodyLines.join('\n');
  if (before !== fileText) {
    synced += 1;
    console.log(`同步 ${relPath}（${before.split('\n').length} 行 -> ${fileText.split('\n').length} 行）`);
  }
  const labels = hasInlineMarker ? [] : (body[1] ?? '') === '' ? [body[0], ''] : [body[0]];
  output.push(lines[i], ...labels, ...bodyLines, lines[end]);
  i = end;
}

writeFileSync(planPath, output.join(newline), 'utf8');
console.log(`\n已同步 ${synced} 个代码块 -> ${planPath}`);
if (skipped.size > 0) {
  console.log(`跳过（文件尚不存在，属未实施单元）：${[...skipped].sort().join(', ')}`);
}
