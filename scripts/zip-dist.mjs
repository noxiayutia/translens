#!/usr/bin/env node
/**
 * 把 `dist/` 打成可发布的 `translens-<version>.zip`（version 读自 `dist/manifest.json`）。
 *
 * 只用 Node 标准库（node:fs / node:zlib / node:path / node:os），不引入任何依赖。
 * 实现是一个**最小 ZIP writer**：本地文件头 + deflateRaw（压不动就退回 store）+
 * 中央目录 + EOCD。三处最容易出错的地方逐条对上要求：
 *
 * - **CRC-32**：每个条目按**未压缩内容**算 CRC 并写进本地头与中央目录——
 *   Chrome / Windows 资源管理器 / macOS 归档工具都按它验收，算错的包直接被判损坏。
 * - **中央目录**：每项带该条目本地头在包内的字节偏移，EOCD 记条目数、中央目录的
 *   起止与大小；解压端按中央目录走，这里错了就解不出文件。
 * - **路径分隔符一律 `/`**：Windows 上 `path.relative` 给的是 `\`，而 ZIP 规范
 *   （APPNOTE 4.4.17）规定条目名只认 `/`——写反斜杠会让 Chrome 加载失败。
 *   条目名同时置 general-purpose bit 11（UTF-8 文件名），非 ASCII 不会被按 CP437 解。
 *
 * **打完自己验证**（任务原话：打不出可用 zip 的打包脚本等于没有）：写完当场用本脚本
 * 自带的读取器把包解回**临时目录**，比对文件数与逐文件字节内容，并复查每个条目的 CRC
 * 与中央目录布局；任何不一致都非零退出、不留下一个坏包可拿。`--check <zip> --dist <dir>`
 * 把同一套验证单独暴露出来，让测试能证明它真的会拒绝坏包（见 tests/scripts/zip-dist.test.ts）。
 *
 * 用法：
 *   npm run zip                                  # 打仓库根的 dist → ./translens-<version>.zip
 *   node scripts/zip-dist.mjs --dist <dir>       # 打包指定目录
 *   node scripts/zip-dist.mjs --out <file.zip>   # 指定输出路径
 *   node scripts/zip-dist.mjs --check <zip> --dist <dir>   # 只做校验不打包
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ *
 * CRC-32（ZIP 用的那份多项式 0xEDB88320，反射表实现）
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** 按字节算 CRC-32（不是按 UTF-16 码元——内容错了整包作废，所以宁可逐字节）。 */
export function crc32(bytes) {
  let c = ~0;
  for (const b of bytes) c = (c >>> 8) ^ CRC_TABLE[(c ^ b) & 0xff];
  return (~c >>> 0);
}

/* ------------------------------------------------------------------ *
 * 文件收集与路径
 * ------------------------------------------------------------------ */

/** dist 内相对路径统一用 POSIX 分隔符（ZIP 只认 `/`；反斜杠会让 Chrome 加载失败）。 */
function toPosixRel(rootDir, absPath) {
  return relative(rootDir, absPath).split(sep).join('/');
}

/** 递归收集目录下的全部**文件**（不含目录条目——解压端自己按路径建目录）。 */
function collectFiles(rootDir, base = rootDir, out = []) {
  for (const entry of readdirSync(rootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(rootDir, entry.name);
    if (entry.isDirectory()) collectFiles(abs, base, out);
    else if (entry.isFile()) out.push(toPosixRel(base, abs));
  }
  return out;
}

/**
 * 固定时间戳（1980-01-01 00:00:00 的 DOS 表示）。
 * 取固定值而不是各文件的 mtime：同一个 dist 打两次得到**逐字节相同**的包，
 * 校验和、发布物比对都不必再考虑时间噪声。ZIP 的 DOS 时间域不记时区，
 * 这里按本地时间语义写死零值即可，解压端只是回显，不影响内容。
 */
const DOS_TIME = 0;
const DOS_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1;

/** general purpose bit flag：bit 11 = 条目名是 UTF-8。 */
const FLAG_UTF8 = 0x0800;

/* ------------------------------------------------------------------ *
 * ZIP writer
 * ------------------------------------------------------------------ */

/**
 * 把一组 (名字 → 内容) 打成一个 zip Buffer。
 * `entries` 的顺序就是包内顺序（也进了中央目录）；名字必须是 `/` 分隔的相对路径。
 */
export function buildZip(entries) {
  const chunks = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = data.length > 0 ? deflateRawSync(data, { level: 9 }) : Buffer.alloc(0);
    // 压不动（二进制资源、空文件）就 store——省得解压端拿到一份更大的。
    const useDeflate = data.length > 0 && deflated.length < data.length;
    const stored = useDeflate ? deflated : Buffer.from(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // "PK\3\4"
    local.writeUInt16LE(20, 4); // version needed: 2.0（deflate 的最低要求）
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8); // 8=deflate, 0=store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra 长度

    const localHeaderOffset = offset;
    chunks.push(local, nameBytes, stored);
    offset += local.length + nameBytes.length + stored.length;

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // "PK\1\2"
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(localHeaderOffset, 42); // 本地头偏移：解压端按它定位
    centralParts.push(central, nameBytes);
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // "PK\5\6"
  eocd.writeUInt16LE(0, 4); // 本盘号
  eocd.writeUInt16LE(0, 6); // 中央目录起始盘
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16); // 中央目录偏移 = 文件区总长
  eocd.writeUInt16LE(0, 20); // 包尾注释长度

  return Buffer.concat([...chunks, centralBuffer, eocd]);
}

/* ------------------------------------------------------------------ *
 * ZIP reader（自检用的那一份）
 * ------------------------------------------------------------------ */

/** 按中央目录把 zip 解成 Map<名字, Buffer>；布局不对就地抛错（不静默给出半成品）。 */
export function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('不是 zip：找不到 EOCD 签名');
  const total = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize !== eocd) {
    throw new Error(`中央目录布局不对：offset(${centralOffset}) + size(${centralSize}) ≠ EOCD 位置(${eocd})`);
  }

  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`中央目录第 ${index + 1} 项签名不对`);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compSize = buffer.readUInt32LE(cursor + 20);
    const uncompSize = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLen);
    if (name.includes('\\')) throw new Error(`条目名用了反斜杠（Chrome 会加载失败）：${name}`);
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new Error(`条目名不是相对路径：${name}`);
    if (entries.has(name)) throw new Error(`条目重复：${name}`);

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`${name}: 本地文件头签名不对`);
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc = buffer.readUInt32LE(localOffset + 14);
    const localCompSize = buffer.readUInt32LE(localOffset + 18);
    if (localMethod !== method || localCrc !== crc || localCompSize !== compSize) {
      throw new Error(`${name}: 本地头与中央目录不一致（method/CRC/压缩大小）`);
    }
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const stored = buffer.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 8) {
      data = inflateRawSync(stored);
    } else if (method === 0) {
      data = Buffer.from(stored);
    } else {
      throw new Error(`${name}: 不支持的压缩方法 ${method}`);
    }
    if (data.length !== uncompSize) throw new Error(`${name}: 解压后长度 ${data.length} ≠ 记录的 ${uncompSize}`);
    const actualCrc = crc32(data);
    if (actualCrc !== crc) {
      throw new Error(`${name}: CRC-32 不匹配（记录 ${crc.toString(16)}，实际 ${actualCrc.toString(16)}）——包已损坏`);
    }
    entries.set(name, data);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  if (cursor !== centralOffset + centralSize) throw new Error('中央目录条目总长与 EOCD 记录不一致');
  return entries;
}

/**
 * 把 zip 解回临时目录，与 dist 逐文件比对：文件数一致 + 每份内容逐字节一致。
 * 抛错即校验失败——调用方（打包流程与 `--check`）把它转成非零退出码。
 */
export function assertZipMatchesDir(zipPath, distDir) {
  const buffer = readFileSync(zipPath);
  const entries = readZip(buffer);
  const expected = collectFiles(distDir);

  const problems = [];
  if (entries.size !== expected.length) {
    problems.push(`文件数不一致：包里 ${entries.size} 个条目，${distDir} 里 ${expected.length} 个文件`);
  }
  const tempDir = mkdtempSync(join(tmpdir(), 'translens-zip-verify-'));
  try {
    for (const rel of expected) {
      const packed = entries.get(rel);
      const source = readFileSync(join(distDir, ...rel.split('/')));
      if (packed === undefined) {
        problems.push(`包里没有这个文件：${rel}`);
        continue;
      }
      if (Buffer.compare(Buffer.from(packed), source) !== 0) {
        problems.push(`内容不一致：${rel}`);
        continue;
      }
      // 真解到磁盘再读回来：顺带钉住"解压端按路径建目录"这条也成立。
      const dest = join(tempDir, ...rel.split('/'));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, packed);
      if (Buffer.compare(readFileSync(dest), source) !== 0) problems.push(`解到磁盘后内容不一致：${rel}`);
    }
    for (const name of entries.keys()) {
      if (!expected.includes(name)) problems.push(`包里有 dist 之外的文件：${name}`);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  if (problems.length > 0) {
    throw new Error(`zip 自检失败：\n  - ${problems.join('\n  - ')}`);
  }
  return { count: entries.size, bytes: buffer.length };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { dist: join(REPO_ROOT, 'dist'), out: null, check: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--out' || flag === '--dist' || flag === '--check') {
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 后面必须跟一个路径`);
      out[flag.slice(2)] = isAbsolute(value) ? value : resolve(process.cwd(), value);
      i += 1;
    } else {
      throw new Error(`未知参数：${flag}`);
    }
  }
  return out;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (raw) {
    console.error(`✗ ${raw instanceof Error ? raw.message : String(raw)}`);
    process.exitCode = 1;
    return;
  }

  if (args.check !== null) {
    try {
      const { count, bytes } = assertZipMatchesDir(args.check, args.dist);
      console.log(`✓ 校验通过：${args.check}（${count} 个文件，${bytes} 字节）与 ${args.dist} 逐字节一致`);
    } catch (raw) {
      console.error(`✗ ${raw instanceof Error ? raw.message : String(raw)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (!isDirectory(args.dist)) {
    console.error(`✗ dist 目录不存在：${args.dist}`);
    console.error('  先运行 npm run build，再来 npm run zip。');
    process.exitCode = 1;
    return;
  }
  const manifestPath = join(args.dist, 'manifest.json');
  let version;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    version = typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch (raw) {
    console.error(`✗ 读不了 ${manifestPath}：${raw instanceof Error ? raw.message : String(raw)}`);
    console.error('  dist 不完整？先运行 npm run build。');
    process.exitCode = 1;
    return;
  }
  if (version === undefined || version === '') {
    console.error(`✗ ${manifestPath} 里没有 version 字段，无法确定包名`);
    process.exitCode = 1;
    return;
  }

  const relFiles = collectFiles(args.dist);
  if (relFiles.length === 0) {
    console.error(`✗ ${args.dist} 是空的——不产出空包。先运行 npm run build。`);
    process.exitCode = 1;
    return;
  }
  if (!relFiles.includes('manifest.json')) {
    console.error(`✗ ${args.dist} 里没有 manifest.json——不像构建产物，不打包。先运行 npm run build。`);
    process.exitCode = 1;
    return;
  }

  const outPath = args.out ?? join(process.cwd(), `translens-${version}.zip`);
  const buffer = buildZip(relFiles.map((rel) => ({ name: rel, data: readFileSync(join(args.dist, ...rel.split('/'))) })));
  writeFileSync(outPath, buffer);

  try {
    const { count } = assertZipMatchesDir(outPath, args.dist);
    console.log(
      `✓ ${outPath}：${count} 个文件，${buffer.length} 字节——已解回临时目录逐字节比对通过`,
    );
  } catch (raw) {
    // 自检不过就删掉产物：宁可没有包，也不留一个"看起来打成功了"的坏包。
    console.error(`✗ 打包后自检失败，产物已删除：${raw instanceof Error ? raw.message : String(raw)}`);
    try {
      rmSync(outPath, { force: true });
    } catch {
      // 删不掉也只是留个垃圾文件，错误结论已经如实报出。
    }
    process.exitCode = 1;
  }
}

// 被 vitest import（tests/scripts/zip-dist.test.ts 走 `--check` 子进程）时不自动打包。
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
