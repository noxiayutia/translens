#!/usr/bin/env node
/**
 * 生成扩展图标 `src/icons/{16,32,48,128}.png`（`npm run icons`）。
 *
 * 只用 Node 标准库：`node:zlib` 做 deflate，CRC-32 自己实现（PNG 与 ZIP 用的是同一个
 * 反射多项式 0xEDB88320）。不引任何图形库——为四个尺寸的图标装一个依赖不划算，而且
 * 生成物**已经入库**，构建时根本不需要重新跑这个脚本（见下）。
 *
 * 图形（TransLens，与品牌 logo **同一个符号**）：象牙白圆角方形底 + 碳黑圆盘（透镜），
 * 盘内镂空一个**横笔带凸面弧的 T**——T 是 TransLens 的首字母，那道弧是透镜表面的曲率。
 * 四周留约 12% 边距。不依赖字体：T 用距离场画（月牙弧带 ∪ 矩形竖笔），扩展里没有字体渲染器。
 *
 * 图标是 logo 的"小尺寸方言"，不是它的缩放：同一套形状，但 16px 下把竖笔加宽、弧带加厚
 * （见 `T_STEM` / `T_BAR` 里按尺寸给的补偿值）。为什么必须修正，是早先踩过的坑——
 * 试过把上一版 logo 概念（"两个相交的圆 + 中间一个箭头"）原样塞进 16px，三种走法都不成立：
 *
 * 1. **圆环**：环要在 16px 下看得见，笔画至少要盖满约 1.2 个像素（0.075 画布宽），而环半径
 *    只有 0.30，于是 0.30 - 0.075/2 = 0.2625 几乎等于半径本身——"空心"被笔画自己填满了，
 *    画出来就是两块实心色斑。
 * 2. **左圆白、右圆青**：白色箭头压在白色左圆上**直接消失**，16px 下整张图只剩一团白。
 * 3. **两圆同色**：两个同色的实心圆叠在一起，并集就是一个圆角矩形色块——16px 和 32px 渲染
 *    出来都只是"一块色斑加一个箭头"，谁还看得出是两个圆？
 *
 * 共同的结论：**16px 只承载得下"一个形状 + 一个负空间元素"，而且笔画要按尺寸做光学修正**。
 * T-Lens 恰好只有一个形状（圆盘）+ 一个镂空（T），修正笔画后能在 16px 活下来；发丝级的
 * 细节（弧笔收尖的端头）在小尺寸自然磨平，不影响认读——这是 logo 设计里的常规操作。
 *
 * 抗锯齿：每个像素对形状求**精确的有符号距离**再按覆盖面积取 alpha。这比"按 4×4 超采样
 * 再平均"更准，而且不会在 16px 下留下锯齿块。
 *
 * 自检（**不通过就非零退出**，不留下一堆坏图）：写完把每个文件重新读回来，逐项核对
 * PNG 签名、每个 chunk 的 CRC、IHDR 里的尺寸/位深/颜色类型、解压后的字节数、四角透明、
 * 底是象牙白、圆盘是碳黑（顶部与底部两个采样点 + 占比下限）、T 在（竖笔、弧笔两翼左右
 * 各至少一个像素），外加一条与 4× 参考渲染的平均偏差。
 *
 * 用法：
 *   npm run icons                     # 生成到 <仓库根>/src/icons
 *   node scripts/make-icons.mjs --out <dir>
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ *
 * CRC-32（PNG 每个 chunk 都要）
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

/** 按字节算 CRC-32（PNG 规范要求的那个：先取反、最后再取反）。 */
function crc32(bytes) {
  let c = ~0;
  for (const b of bytes) c = (c >>> 8) ^ CRC_TABLE[(c ^ b) & 0xff];
  return ~c >>> 0;
}

/* ------------------------------------------------------------------ *
 * 颜色与几何（都在 0..1 的归一化坐标里定义，与尺寸无关）
 * ------------------------------------------------------------------ */

/** 象牙白：画布底与 T 的镂空色（对齐 logo 的实测色）。 */
const IVORY = [0xf2, 0xef, 0xe6];

/** 碳黑：透镜圆盘。 */
const CARBON = [0x0d, 0x0d, 0x10];

/** 圆角方形底：四周 12% 边距 → 边长 0.76，圆角半径 0.15。 */
const TILE = { x0: 0.12, y0: 0.12, x1: 0.88, y1: 0.88, radius: 0.15 };

/** 透镜圆盘：居中，半径 0.28（直径占画布 56%，与 logo 同比例）。 */
const DISC = { cx: 0.5, cy: 0.5, radius: 0.28 };

/**
 * T 的横笔：一条**向上鼓的弧带**（透镜表面的曲率），左右两端收成尖。
 *
 * 弧带 = "上弧圆之内 ∩ 下弧圆之外"的月牙：两个圆都过左右两个尖端；上弧过
 * (0.5, apexTopY)，下弧过 (0.5, apexTopY + thickness)。thickness 按输出尺寸
 * 补偿——16px 下 0.055 只有 0.9 个像素，抗锯齿会把它摊成一条灰影。
 */
const T_BAR = {
  /** 尖端横坐标 = 0.5 ± tipHalfSpan（在圆盘赤道附近，距盘缘约 0.07）。 */
  tipHalfSpan: 0.21,
  /** 两个尖端的纵坐标。 */
  tipY: 0.44,
  /** 上弧最高点。 */
  apexTopY: 0.355,
  /** 弧带中心厚度（画布宽占比），按尺寸给。 */
  thickness: { 16: 0.075, 32: 0.062, 48: 0.058, 128: 0.055 },
};

/** T 的竖笔：矩形，从横笔里（topY）伸到 bottomY。半宽按尺寸补偿，同理。 */
const T_STEM = {
  topY: 0.38,
  bottomY: 0.64,
  halfWidth: { 16: 0.052, 32: 0.043, 48: 0.04, 128: 0.0375 },
};

/**
 * 过 (0.5±a, tipY) 与 (0.5, apexY) 的圆（apexY < tipY，向上鼓）：
 * 弦半宽 a、矢高 s = tipY - apexY → 半径 R = (a² + s²) / (2s)，圆心 (0.5, apexY + R)。
 */
function arcCircle(a, tipY, apexY) {
  const s = tipY - apexY;
  const r = (a * a + s * s) / (2 * s);
  return { cy: apexY + r, r };
}

/** 圆角方形底在 (px,py) 处的有符号距离（<0 表示在底色内部）。 */
function tileDistance(px, py) {
  const halfWidth = (TILE.x1 - TILE.x0) / 2;
  const halfHeight = (TILE.y1 - TILE.y0) / 2;
  const cx = TILE.x0 + halfWidth;
  const cy = TILE.y0 + halfHeight;
  const qx = Math.abs(px - cx) - (halfWidth - TILE.radius);
  const qy = Math.abs(py - cy) - (halfHeight - TILE.radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - TILE.radius;
}

/** 圆盘在 (px,py) 处的有符号距离。 */
function discDistance(px, py) {
  return Math.hypot(px - DISC.cx, py - DISC.cy) - DISC.radius;
}

/**
 * T 在 (px,py) 处的有符号距离（<0 表示在 T 内部）。
 *
 * 横笔月牙用两个圆的距离场取 `max`（凸集交补集的近似 SDF——边界都是圆弧，误差在
 * 亚像素级，且主渲染与参考渲染用**同一个函数**，自检的对照意义不受影响）；
 * 竖笔是标准 box SDF。两者并集取 `min`。
 */
function tDistance(px, py, size) {
  const thickness = T_BAR.thickness[size] ?? 0.055;
  const halfWidth = T_STEM.halfWidth[size] ?? 0.0375;

  const top = arcCircle(T_BAR.tipHalfSpan, T_BAR.tipY, T_BAR.apexTopY);
  const bottom = arcCircle(T_BAR.tipHalfSpan, T_BAR.tipY, T_BAR.apexTopY + thickness);
  const dx = px - 0.5;
  const dTop = Math.hypot(dx, py - top.cy) - top.r;
  const dBottom = bottom.r - Math.hypot(dx, py - bottom.cy);
  const bar = Math.max(dTop, dBottom);

  const stemCy = (T_STEM.topY + T_STEM.bottomY) / 2;
  const stemHy = (T_STEM.bottomY - T_STEM.topY) / 2;
  const qx = Math.abs(dx) - halfWidth;
  const qy = Math.abs(py - stemCy) - stemHy;
  const stem = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);

  return Math.min(bar, stem);
}

/** 有符号距离 → 覆盖率（0..1）。除以像素宽度，边界恰好落在一个像素的宽度上。 */
function coverage(distance, pixelWidth) {
  const value = 0.5 - distance / pixelWidth;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/* ------------------------------------------------------------------ *
 * 光栅化
 * ------------------------------------------------------------------ */

/**
 * 一个采样点的颜色：象牙底 → 碳黑圆盘压上来 → T 的镂空再"挖"回象牙。
 *
 * 镂空不是透明：T 的色就是底色，盘在 T 处被"还原"成象牙——和 logo 的负空间做法一致。
 *
 * `pixelWidth` 是这个采样点代表的面积边长：主渲染传目标像素的边长（1/size），覆盖率因此
 * 就是**解析式的精确面积**；参考渲染（超采样）传子样本的边长（1/(size*factor)），于是每个
 * 子样本只做"在形状内 / 不在形状内"的判定，抗锯齿完全由子样本平均给出——两层都保留
 * SDF 的软过渡会把边缘抹成两倍宽，那正是这套自检要抓的错误。
 *
 * `size` 只用来取 T 的笔画补偿宽度（小尺寸要加粗，见 T_BAR / T_STEM）。
 */
function sampleColor(px, py, size, pixelWidth) {
  const tile = coverage(tileDistance(px, py), pixelWidth);
  if (tile <= 0) return [0, 0, 0, 0];
  const disc = coverage(discDistance(px, py), pixelWidth);
  const t = coverage(tDistance(px, py, size), pixelWidth);
  const color = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    const onDisc = IVORY[i] + (CARBON[i] - IVORY[i]) * disc;
    color[i] = onDisc + (IVORY[i] - onDisc) * t;
  }
  return [color[0], color[1], color[2], tile * 255];
}

/**
 * 画一张 `size × size` 的 RGBA 图。
 *
 * 逐像素解析式求覆盖（每像素只采一次中心点，边界由 SDF 的覆盖率还原）——这比"每像素
 * 打 N 个样本再平均"更准也更便宜，16px 下不会留下锯齿块。
 */
function renderArtwork(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const pixelWidth = 1 / size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cx = (x + 0.5) / size;
      const cy = (y + 0.5) / size;

      const [red, green, blue, alpha] = sampleColor(cx, cy, size, pixelWidth);
      if (alpha <= 0) continue;

      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(red);
      pixels[offset + 1] = Math.round(green);
      pixels[offset + 2] = Math.round(blue);
      pixels[offset + 3] = Math.round(alpha);
    }
  }

  return pixels;
}

/** 扩展图标：象牙底 + 碳黑透镜盘 + 镂空 T。 */
function renderIcon(size) {
  return renderArtwork(size);
}

/**
 * 把 `size` 放大 `factor` 倍后的**参考渲染**：每个目标像素取 `factor × factor` 个子样本求平均。
 *
 * 用途是**自检的对照组**，不是生成物本身：解析式覆盖是逐像素单点采样，如果它在某个像素上
 * 算错了（或者几何被裁掉、形状叠加顺序反了），跟这张高倍参考图一比就会出现大偏差。
 * 这比"钉死某个像素的颜色"稳得多——后者一改几何常量就假报错。
 */
function renderReference(size, factor) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = factor * factor;
  const subPixelWidth = 1 / (size * factor);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const [r, g, b, a] = sampleColor(
            (x + (sx + 0.5) / factor) / size,
            (y + (sy + 0.5) / factor) / size,
            size,
            subPixelWidth,
          );
          red += r;
          green += g;
          blue += b;
          alpha += a;
        }
      }
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(red / samples);
      pixels[offset + 1] = Math.round(green / samples);
      pixels[offset + 2] = Math.round(blue / samples);
      pixels[offset + 3] = Math.round(alpha / samples);
    }
  }

  return pixels;
}

/* ------------------------------------------------------------------ *
 * PNG 编码（签名 + IHDR + IDAT + IEND，RGBA / 8 位）
 * ------------------------------------------------------------------ */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 一个 PNG chunk：长度 + 类型 + 数据 + CRC（CRC 覆盖类型与数据）。 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/** RGBA 像素 → 合法 PNG 字节。每行前缀一个 0（filter type: None）。 */
function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：RGBA
  ihdr[10] = 0; // 压缩方法：deflate
  ihdr[11] = 0; // 过滤方法：标准
  ihdr[12] = 0; // 非隔行

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * 自检：把写出来的文件重新读回来逐项核对
 * ------------------------------------------------------------------ */

class CheckFailure extends Error {}

function assert(condition, message) {
  if (!condition) throw new CheckFailure(message);
}

function pixelAt(pixels, size, x, y) {
  const offset = (y * size + x) * 4;
  return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
}

/** 解析 PNG：校验签名与每个 chunk 的 CRC，返回 IHDR 字段与解压后的像素。 */
function decodePng(bytes, label) {
  assert(bytes.length > PNG_SIGNATURE.length, `${label}: 文件比 PNG 签名还短`);
  assert(PNG_SIGNATURE.equals(bytes.subarray(0, 8)), `${label}: PNG 签名不对（应为 89 50 4E 47 …）`);

  let offset = 8;
  let header = null;
  let pixels = null;

  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert(dataEnd + 4 <= bytes.length, `${label}: chunk ${type} 越界`);

    const data = bytes.subarray(dataStart, dataEnd);
    const expected = bytes.readUInt32BE(dataEnd);
    const actual = crc32(bytes.subarray(offset + 4, dataEnd));
    assert(
      expected === actual,
      `${label}: chunk ${type} 的 CRC 不对（文件里是 ${expected.toString(16)}，算出来是 ${actual.toString(16)}）`,
    );

    if (type === 'IHDR') {
      assert(length === 13, `${label}: IHDR 长度应为 13，实际 ${length}`);
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      pixels = pixels === null ? inflateSync(data) : Buffer.concat([pixels, inflateSync(data)]);
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4;
  }

  assert(header !== null, `${label}: 没有 IHDR`);
  assert(pixels !== null, `${label}: 没有 IDAT`);
  return { header, pixels };
}

/**
 * 逐项核对一个生成物。任何一条不满足都抛错——脚本的约定是"自检不过就非零退出"。
 *
 * 像素断言刻意写得**形状相关**而不是"某处像素等于某个值"：解析式抗锯齿下笔画落在哪一行、
 * 那一行拿到多少覆盖，取决于像素格点；钉死行号或钉死颜色等于把几何常量抄进测试，改一点
 * 位置就假报错。这里验的是"该有的东西在不在"：
 *
 * - 四角透明（12% 边距 + 圆角）；
 * - 底是象牙白（盘外两个空档采样点）；
 * - 圆盘是碳黑（盘顶与盘底两个采样点 + 全图占比下限）；
 * - T 在：竖笔（盘下半的中轴条带）与弧笔两翼（左右对称的翼区）各有亮像素。
 *
 * 几何本身画错（弧带方向反了、盘被裁、叠加顺序错了）由最后那条"与 4× 参考渲染的平均偏差"兜住。
 */
function verifyIcon(bytes, size, label) {
  const { header, pixels } = decodePng(bytes, label);

  assert(header.width === size, `${label}: IHDR 宽度应为 ${size}，实际 ${header.width}`);
  assert(header.height === size, `${label}: IHDR 高度应为 ${size}，实际 ${header.height}`);
  assert(header.bitDepth === 8, `${label}: 位深应为 8，实际 ${header.bitDepth}`);
  assert(header.colorType === 6, `${label}: 颜色类型应为 6（RGBA），实际 ${header.colorType}`);
  assert(header.compression === 0 && header.filter === 0 && header.interlace === 0, `${label}: IHDR 压缩/过滤/隔行字段应为 0`);
  assert(
    pixels.length === (size * 4 + 1) * size,
    `${label}: 解压后应为 ${(size * 4 + 1) * size} 字节（每行含 1 字节 filter），实际 ${pixels.length}`,
  );

  const stride = size * 4 + 1;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    assert(pixels[y * stride] === 0, `${label}: 第 ${y} 行的 filter 字节不是 0（本脚本只写 None）`);
    pixels.copy(rgba, y * size * 4, y * stride + 1, y * stride + 1 + size * 4);
  }

  // 四角：12% 边距 + 圆角 → 必须是全透明的。
  for (const [x, y] of [
    [0, 0],
    [size - 1, 0],
    [0, size - 1],
    [size - 1, size - 1],
  ]) {
    const [r, g, b, a] = pixelAt(rgba, size, x, y);
    assert(a === 0, `${label}: 角 (${x},${y}) 应完全透明，实际 rgba(${r},${g},${b},${a})`);
  }

  // 底色：两处**在圆角底上、在圆盘外**的空档（盘顶上方、盘左一侧），必须是实心象牙白。
  for (const [fx, fy, where] of [
    [0.5, 0.15, '圆盘上方的空档'],
    [0.15, 0.5, '圆盘左侧的空档'],
  ]) {
    const x = Math.min(size - 1, Math.round(fx * size));
    const y = Math.min(size - 1, Math.round(fy * size));
    const [r, g, b, a] = pixelAt(rgba, size, x, y);
    assert(a === 255, `${label}: ${where} (${x},${y}) 应是实心底色，实际 alpha=${a}`);
    const distance = Math.abs(r - IVORY[0]) + Math.abs(g - IVORY[1]) + Math.abs(b - IVORY[2]);
    assert(distance <= 12, `${label}: ${where} (${x},${y}) 应是象牙白 #f2efe6，实际 rgb(${r},${g},${b})`);
  }

  // 圆盘：盘顶（弧笔上方，盘缘 0.22 与弧顶 0.355 之间）与盘底（竖笔末端 0.64 与
  // 盘缘 0.78 之间）两个采样点必须是碳黑。取 0.28/0.70 而不是边界值：16px 的格点
  // 会把 0.72 舍到 0.78125——正好踩在盘缘的抗锯齿带上。
  for (const [fx, fy, where] of [
    [0.5, 0.28, '圆盘顶部'],
    [0.5, 0.7, '圆盘底部'],
  ]) {
    const x = Math.min(size - 1, Math.round(fx * size));
    const y = Math.min(size - 1, Math.round(fy * size));
    const [r, g, b, a] = pixelAt(rgba, size, x, y);
    assert(a === 255, `${label}: ${where} (${x},${y}) 应在盘内（不透明），实际 alpha=${a}`);
    const distance = Math.abs(r - CARBON[0]) + Math.abs(g - CARBON[1]) + Math.abs(b - CARBON[2]);
    assert(distance <= 12, `${label}: ${where} (${x},${y}) 应是碳黑 #0d0d10，实际 rgb(${r},${g},${b})`);
  }

  // T 的构成：竖笔（盘下半中轴条带）与弧笔两翼（左右对称）都要有"象牙亮"像素。
  // 判据用红通道（碳黑 13、象牙 242，抗锯齿混合值介于两者之间）；阈值 120 取中间偏暗，
  // 保证 16px 下只有一两个像素覆盖的弧翼也能被认出来。
  const isIvory = (x, y) => pixelAt(rgba, size, x, y)[0] > 120;
  const countIn = (fx0, fx1, fy0, fy1) => {
    let count = 0;
    for (let y = Math.floor(fy0 * size); y < Math.ceil(fy1 * size); y += 1) {
      for (let x = Math.floor(fx0 * size); x < Math.ceil(fx1 * size); x += 1) {
        if (x >= 0 && x < size && y >= 0 && y < size && isIvory(x, y)) count += 1;
      }
    }
    return count;
  };
  const stemPixels = countIn(0.44, 0.56, 0.55, 0.63);
  const leftWing = countIn(0.28, 0.44, 0.3, 0.46);
  const rightWing = countIn(0.56, 0.72, 0.3, 0.46);
  assert(stemPixels >= 1, `${label}: 盘下半的中轴条带里没有竖笔像素，T 的竖笔可能没画上`);
  assert(leftWing >= 1, `${label}: 左侧翼区没有亮像素，弧笔可能只画了半边或方向反了`);
  assert(rightWing >= 1, `${label}: 右侧翼区没有亮像素，弧笔可能只画了半边或方向反了`);

  // 与参考渲染对比。判据用**平均偏差**而不是逐像素上限：解析式覆盖算的是精确面积，而参考
  // 渲染是超采样近似——在弧笔收尖那种亚像素尖角上，单个像素两者本来就能差两百个灰阶（那儿的
  // "真实覆盖率"介于两种近似之间，谁也说不清哪个更"对"）。逐像素上限会因此长期假报错。
  // 平均偏差对结构性错误极其敏感：少画一笔、几何被裁、形状叠加顺序反了，均值会从个位数
  // 直接跳到几十上百。
  const reference = renderReference(size, 4);
  let total = 0;
  let count = 0;
  for (let i = 0; i < rgba.length; i += 1) {
    total += Math.abs(rgba[i] - reference[i]);
    count += 1;
  }
  const meanDelta = total / count;
  assert(meanDelta <= 22, `${label}: 与 4× 参考渲染的平均偏差过大（${meanDelta.toFixed(2)}），几何或抗锯齿有问题`);

  // 全图占比：碳黑盘（挖掉 T 后）至少 13% 的画布；盘内的 T 镂空至少 1.2%。
  let carbonPixels = 0;
  let tPixels = 0;
  let opaquePixels = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, , , a] = pixelAt(rgba, size, x, y);
      if (a <= 200) continue;
      opaquePixels += 1;
      if (r < 70) {
        carbonPixels += 1;
      } else if (r > 150) {
        const fx = (x + 0.5) / size;
        const fy = (y + 0.5) / size;
        if (Math.hypot(fx - DISC.cx, fy - DISC.cy) < DISC.radius - 0.02) tPixels += 1;
      }
    }
  }
  assert(opaquePixels > size * size * 0.4, `${label}: 不透明像素太少（${opaquePixels}/${size * size}），底色可能没画上`);
  assert(carbonPixels >= size * size * 0.13, `${label}: 碳黑像素太少（${carbonPixels}/${size * size}），圆盘可能没画上`);
  assert(tPixels >= size * size * 0.012, `${label}: 盘内镂空像素太少（${tPixels}/${size * size}），T 可能没画上`);

  return { bytes: bytes.length, carbonPixels, tPixels };
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

const SIZES = [16, 32, 48, 128];

/** 解析 `--out <dir>`；缺省是仓库根的 `src/icons`。 */
function resolveOutDir(argv) {
  const flag = argv.indexOf('--out');
  if (flag === -1) return join(REPO_ROOT, 'src', 'icons');
  const value = argv[flag + 1];
  if (value === undefined || value.startsWith('--')) throw new Error('--out 后面必须跟一个目录路径');
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function main() {
  const outDir = resolveOutDir(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });
  console.log(`生成扩展图标 → ${outDir}`);

  const summary = [];
  for (const size of SIZES) {
    const file = join(outDir, `${size}.png`);
    writeFileSync(file, encodePng(renderIcon(size), size));

    // 自检读的是**磁盘上的文件**，不是内存里那份 buffer。
    const report = verifyIcon(readFileSync(file), size, `${size}.png`);
    summary.push(report);
    console.log(
      `  ✓ ${size}.png  ${report.bytes} 字节  碳黑像素 ${report.carbonPixels}/${size * size}  镂空 T 像素 ${report.tPixels}`,
    );
  }

  console.log('');
  console.log(`✓ ${summary.length} 张图标生成并自检通过（PNG 签名 / 各 chunk CRC / IHDR 尺寸 / 四角透明 / 象牙底 / 碳黑盘 / 镂空 T）`);
  console.log('  manifest.json 通过 icons 与 action.default_icon 引用 icons/<尺寸>.png（相对 dist 根）。');
  console.log('  品牌 logo 是人工选定的静态资产（docs/brand/translens-logo.png），与本图标同一符号、不同尺寸方言。');
}

/*
 * 只有**直接执行**时才生成图标；被 import（比如测试）时什么都不做。
 */
const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    main();
  } catch (error) {
    if (error instanceof CheckFailure) {
      console.error(`✗ 图标自检失败：${error.message}`);
    } else {
      console.error(`✗ 生成图标失败：${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  }
}
