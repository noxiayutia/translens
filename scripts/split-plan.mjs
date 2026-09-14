// 把实施计划按工作单元切片，供子代理只读自己那一段。
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
