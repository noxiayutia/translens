/**
 * `npm run zip`（scripts/zip-dist.mjs）的行为测试。
 *
 * 任务的硬要求是"打不出可用 zip 的打包脚本等于没有"，所以这里**不用脚本自己的读取器**
 * 验收——测试自带一份独立的 zip 解析器（EOCD → 中央目录 → 本地头 → inflate）与独立
 * CRC-32 实现：条目名分隔符、CRC、压缩/解压后的字节、文件数全部对着 fixture 源文件核。
 * 另外钉住脚本自检的**承重性**：把 zip 里某条目的数据字节翻掉一位，`--check` 必须非零退出
 * （自检如果只是个 print，这条会红）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'zip-dist.mjs');

function runScript(args: string[], cwd: string) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd });
}

/** 含嵌套目录、非 ASCII、随机二进制（deflate 只会变大，逼出 store 回退）与空文件。 */
function makeFixture(): { dir: string; files: Map<string, Uint8Array> } {
  const dir = mkdtempSync(join(tmpdir(), 'translens-zip-fixture-'));
  const encoder = new TextEncoder();
  const pseudoRandom = Uint8Array.from({ length: 512 }, (_unused, i) => (i * 167 + 13) % 256);
  const files = new Map<string, Uint8Array>([
    ['manifest.json', encoder.encode('{"manifest_version":3,"version":"9.8.7","name":"浸译 fixture"}')],
    ['content.js', encoder.encode('console.log("hi");')],
    ['chunks/lang.js', encoder.encode('export const x = "中文常量";')],
    ['assets/blob.bin', pseudoRandom],
    ['empty.txt', new Uint8Array(0)],
  ]);
  for (const [rel, bytes] of files) {
    const abs = join(dir, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
  return { dir, files };
}

/* ---------------- 独立 zip 读取器（刻意不与脚本共享实现） ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) c = (c >>> 8) ^ CRC_TABLE[(c ^ b) & 0xff];
  return ~c >>> 0;
}

interface ParsedEntry {
  name: string;
  method: number;
  crc: number;
  compSize: number;
  uncompSize: number;
  /** 解压后的内容 */
  data: Uint8Array;
  /** 存储字节（压缩后的原文切片）在整包里的起点 */
  dataStart: number;
}

function parseZip(buf: Buffer): { entries: ParsedEntry[]; centralEnd: number; centralSize: number } {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x0605_4b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('找不到 EOCD 签名：这不是一个 zip');
  const total = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  const entries: ParsedEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < total; index += 1) {
    if (buf.readUInt32LE(cursor) !== 0x0201_4b50) throw new Error(`中央目录第 ${index} 项签名不对`);
    const method = buf.readUInt16LE(cursor + 10);
    const crc = buf.readUInt32LE(cursor + 16);
    const compSize = buf.readUInt32LE(cursor + 20);
    const uncompSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLen);
    if (buf.readUInt32LE(localOffset) !== 0x0403_4b50) throw new Error(`${name} 的本地文件头签名不对`);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const stored = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? (new Uint8Array(inflateRawSync(stored)) as Uint8Array) : Uint8Array.from(stored);
    entries.push({ name, method, crc, compSize, uncompSize, data, dataStart });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, centralEnd: cursor, centralSize };
}

describe('scripts/zip-dist.mjs：dist 打包', () => {
  it('package.json 的 scripts.zip 指向本脚本', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.zip).toContain('scripts/zip-dist.mjs');
  });

  it('fixture 打包：退出码 0、逐文件字节一致、条目名用 / 分隔、CRC 与大小对得上', () => {
    const fixture = makeFixture();
    const outDir = mkdtempSync(join(tmpdir(), 'translens-zip-out-'));
    const zipPath = join(outDir, 'fixture.zip');

    const packed = runScript(['--dist', fixture.dir, '--out', zipPath], REPO_ROOT);
    expect(packed.status, `stdout=${packed.stdout}\nstderr=${packed.stderr}`).toBe(0);
    expect(existsSync(zipPath)).toBe(true);

    const parsed = parseZip(readFileSync(zipPath));
    // 中央目录不重叠、不悬空：条目区 + 中央目录 + 22 字节 EOCD 恰好等于整包长度。
    expect(parsed.centralEnd + 22).toBe(readFileSync(zipPath).length);
    expect(parsed.entries.map((entry) => entry.name).sort()).toEqual([...fixture.files.keys()].sort());
    expect(parsed.entries.length).toBe(fixture.files.size);
    for (const entry of parsed.entries) {
      expect(entry.name, `条目名必须用正斜杠：${entry.name}`).not.toContain('\\');
      expect(entry.name.startsWith('/'), '条目名不得是绝对路径').toBe(false);
      expect(crc32(entry.data)).toBe(entry.crc);
      expect(entry.data.length).toBe(entry.uncompSize);
      const source = fixture.files.get(entry.name) as Uint8Array;
      expect(Buffer.from(entry.data).equals(Buffer.from(source)), `内容不一致：${entry.name}`).toBe(true);
    }

    // 脚本自己的 `--check` 也必须判定同一份包是好的。
    const checked = runScript(['--check', zipPath, '--dist', fixture.dir], REPO_ROOT);
    expect(checked.status, `stdout=${checked.stdout}\nstderr=${checked.stderr}`).toBe(0);
  });

  it('自检是承重的：翻掉某条目数据的一个字节后，--check 必须非零退出', () => {
    const fixture = makeFixture();
    const outDir = mkdtempSync(join(tmpdir(), 'translens-zip-out-'));
    const zipPath = join(outDir, 'fixture.zip');
    expect(runScript(['--dist', fixture.dir, '--out', zipPath], REPO_ROOT).status).toBe(0);

    const bytes = readFileSync(zipPath);
    const parsed = parseZip(bytes);
    const victim = parsed.entries.find((entry) => entry.name === 'assets/blob.bin') as ParsedEntry;
    bytes[victim.dataStart + Math.floor(victim.compSize / 2)] ^= 0xff;
    const corruptedPath = join(outDir, 'corrupted.zip');
    writeFileSync(corruptedPath, bytes);

    const checked = runScript(['--check', corruptedPath, '--dist', fixture.dir], REPO_ROOT);
    expect(checked.status).not.toBe(0);
  });

  it('dist 不存在：非零退出并提示先运行 build，不落任何包', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'translens-zip-out-'));
    const zipPath = join(outDir, 'never.zip');

    const run = runScript(['--dist', join(outDir, 'nope-dist'), '--out', zipPath], REPO_ROOT);

    expect(run.status).not.toBe(0);
    expect(`${run.stderr}\n${run.stdout}`).toContain('build');
    expect(existsSync(zipPath)).toBe(false);
  });

  it('默认包名是 translens-<dist/manifest.json 的 version>.zip', () => {
    const fixture = makeFixture(); // manifest.version = 9.8.7
    const cwd = mkdtempSync(join(tmpdir(), 'translens-zip-cwd-'));

    const run = runScript(['--dist', fixture.dir], cwd);

    expect(run.status, `stdout=${run.stdout}\nstderr=${run.stderr}`).toBe(0);
    expect(existsSync(join(cwd, 'translens-9.8.7.zip'))).toBe(true);
  });
});
