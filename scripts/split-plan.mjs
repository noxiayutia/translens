// 把实施计划按工作单元切片，供子代理只读自己那一段。
//
// ⚠️ 下面的 `units` 映射是**写死**给 `docs/superpowers/plans/2026-09-14-immersive-translate-core.md`
// 的（那份计划有 Task 1~19）。拿别的计划来跑它，过去会**先把 `units/wu1.md` 覆写成另一个计划的
// Task 1、再在找不存在的 Task 时抛错退出**——破坏发生在抛错之前，最坏的一种故障形状。
// 所以下面有一道**写文件之前的预检**：Task 数不等于这张表所对应的数量时，只打印说明并 exit 1，
// 一个文件都不碰。万一工作树已经被旧版弄脏：`git checkout -- docs/superpowers/plans/units/wu1.md`。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const planPath = process.argv[2];
const outDir = process.argv[3];
const raw = readFileSync(planPath, 'utf8').replace(/\r\n/g, '\n');
const lines = raw.split('\n');

const taskStart = new Map();
let tailStart = lines.length;
lines.forEach((line, i) => {
  const task = /^## Task (\d+):/.exec(line);
  if (task) taskStart.set(Number(task[1]), i);
  if (/^## (完成标准|Plan 2 待办)/.test(line) && tailStart === lines.length) tailStart = i;
});

if (taskStart.size === 0) {
  console.error('没有找到任何 "## Task N:" 标题，检查文件编码或路径');
  process.exit(1);
}

const starts = [...taskStart.keys()].sort((a, b) => a - b);
const boundaryAfter = (taskNo) => {
  const next = starts.find((n) => n > taskNo);
  return next === undefined ? tailStart : taskStart.get(next);
};

const units = {
  wu1: [1],
  wu2: [2, 3, 4, 5, 6],
  wu3: [7, 8, 9],
  wu4: [10, 11, 12],
  wu5: [13],
  wu6: [14],
  wu7: [15, 16],
  wu8: [17],
  wu9: [18],
  wu10: [19],
};

// 预检：这张表覆盖的任务号必须**恰好**是计划里 Task 的数量。
// 放在 `mkdirSync` 与写文件之前是本函数的全部意义——旧版是先覆写 `units/wu1.md` 再抛错，
// 破坏是静默的、报错是迟到的。这里宁可拒绝执行，也不动任何被跟踪的文件。
const coveredTasks = Object.values(units).flat();
const expectedCount = Math.max(...coveredTasks);
if (taskStart.size !== expectedCount) {
  console.error(
    `拒绝执行：本脚本的 units 映射写死给 2026-09-14-immersive-translate-core.md（${expectedCount} 个 Task），\n` +
      `当前计划 ${planPath} 有 ${taskStart.size} 个 Task——映射对不上。\n` +
      '若这份计划需要切片，请先按它改写上面那张表；在预检之前本脚本会先覆写 units/wu1.md 再抛错。',
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
for (const [name, tasks] of Object.entries(units)) {
  const chunks = tasks.map((t) => {
    const from = taskStart.get(t);
    if (from === undefined) throw new Error(`Task ${t} 不存在于计划中`);
    return lines.slice(from, boundaryAfter(t));
  });
  const body = chunks.flat().join('\n');
  const path = join(outDir, `${name}.md`);
  writeFileSync(path, body, 'utf8');
  console.log(`${name}: Task ${tasks.join(',')} -> ${body.split('\n').length} 行`);
}
console.log(`共 ${taskStart.size} 个 Task，tail 起始行 ${tailStart}`);
