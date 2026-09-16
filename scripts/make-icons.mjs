#!/usr/bin/env node
/**
 * 生成扩展图标 `src/icons/{16,32,48,128}.png`（`npm run icons`）。
 *
 * 只用 Node 标准库：`node:zlib` 做 deflate，CRC-32 自己实现（PNG 与 ZIP 用的是同一个
 * 反射多项式 0xEDB88320）。不引任何图形库——为四个尺寸的图标装一个依赖不划算，而且
 * 生成物**已经入库**，构建时根本不需要重新跑这个脚本（见下）。
 *
 * 图形：圆角方形底（主色 #2563eb）+ 白色双向箭头（左右各一个箭头、错开两行），
 * 四周留约 12% 边距。不画汉字——扩展里没有字体渲染器，硬画会很难看。
 *
 * 抗锯齿：每个像素对形状求**精确的有符号距离**再按覆盖面积取 alpha（白箭头同理）。
 * 这比"按 4×4 超采样再平均"更准，而且不会在 16px 下留下锯齿块。
 *
 * 自检（**不通过就非零退出**，不留下一堆坏图）：写完把每个文件重新读回来，逐项核对
 * PNG 签名、每个 chunk 的 CRC、IHDR 里的尺寸/位深/颜色类型、解压后的字节数、
 * 四角透明、上边中点是不透明的底色、中心附近确实有白色箭头像素。
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

/** 主色，与两份 CSS 的 `--accent` 一致（亮色主题那一档）。 */
const ACCENT = [0x25, 0x63, 0xeb];

/** 圆角方形底：四周 12% 边距 → 边长 0.76，圆角半径 0.15。 */
const TILE = { x0: 0.12, y0: 0.12, x1: 0.88, y1: 0.88, radius: 0.15 };

/**
 * 白色双向箭头：一个箭头 = 一条杆（矩形，用线段的有符号距离表示）+ 一个**实心三角**箭头。
 *
 * 箭头必须是实心三角形而不是"两笔描边"：描边在尖端会收成圆头，16px 下那两笔就只剩两个
 * 白点，看上去像"没画出来"。三角形用多边形距离场表示（内部为负、外部到最近边的距离），
 * 与杆做**并集**（取较小值），接头天然无缝。
 */
const ART = {
  /** 杆伸到画布左右各 0.42 处。 */
  shaftHalfLength: 0.42,
  /** 箭头的底边横坐标（三角形从 x = headBaseX 伸到尖端 0.5）。 */
  headBaseX: 0.14,
  /** 两条杆的中心线。 */
  shaftYRight: -0.21,
  shaftYLeft: 0.21,
  /** 三角形底边的半高（≈ 箭头张角的一半）。 */
  headHalfHeight: 0.3,
  /** 杆的粗细（ART 单位）。 */
  stroke: 0.115,
};

/** 箭头在**归一化画布**（0..1）里占的框：居中，四周留边。 */
const ARROW_BOX = { left: 0.2, right: 0.82, top: 0.19, bottom: 0.81 };

/** ART 里的长度 → 归一化画布长度（箭头是各向同性设计的，两个方向同一个缩放）。 */
const ART_SCALE = ARROW_BOX.right - ARROW_BOX.left;

/** 把归一化画布坐标映回 ART 坐标（缩放与平移，箭头因此始终居中且不越界）。 */
function canvasToArt(px, py) {
  return [
    (px - ARROW_BOX.left) / ART_SCALE - 0.5,
    (py - ARROW_BOX.top) / (ARROW_BOX.bottom - ARROW_BOX.top) - 0.5,
  ];
}

/** 右向箭头的形状（ART 坐标）：杆线段 + 实心三角箭头。 */
function rightArrowShape() {
  const y = ART.shaftYRight;
  return {
    shaft: { ax: -ART.shaftHalfLength, ay: y, bx: ART.headBaseX, by: y },
    head: [
      [0.5, y],
      [ART.headBaseX, y - ART.headHalfHeight],
      [ART.headBaseX, y + ART.headHalfHeight],
    ],
  };
}

/** 左向箭头：镜像。 */
function leftArrowShape() {
  const y = ART.shaftYLeft;
  return {
    shaft: { ax: ART.shaftHalfLength, ay: y, bx: -ART.headBaseX, by: y },
    head: [
      [-0.5, y],
      [-ART.headBaseX, y - ART.headHalfHeight],
      [-ART.headBaseX, y + ART.headHalfHeight],
    ],
  };
}

/** 点到线段的距离。 */
function distanceToSegment(px, py, seg) {
  const dx = seg.bx - seg.ax;
  const dy = seg.by - seg.ay;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((px - seg.ax) * dx + (py - seg.ay) * dy) / lengthSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (seg.ax + t * dx), py - (seg.ay + t * dy));
}

/**
 * 点到**凸多边形**的有符号距离（内部为负）——标准的"外部最近边距离 / 内部负距离"实现。
 * 箭头是三角形，凸性满足。
 */
function distanceToPolygon(px, py, points) {
  let inside = false;
  let nearest = Infinity;

  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    nearest = Math.min(nearest, distanceToSegment(px, py, { ax: xj, ay: yj, bx: xi, by: yi }));
    // 射线法（PVector 的 Winding number 简化版：这里只需奇偶性）。
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }

  return inside ? -nearest : nearest;
}

/**
 * 小尺寸要把笔画**加粗**：16px 下 0.115 的杆只有约 1.6 个像素，解析式抗锯齿会把杆摊成
 * 半透明的灰蓝，看起来就是"箭头没画出来"。所以按输出尺寸给一个补偿，让杆宽在任何尺寸下
 * 都**至少盖满一个像素**（最坏情况下仍留一行覆盖率 ≥0.9 的实心白）。
 *
 * 这是图标栅格化的常规补偿，不是几何本身的一部分，所以单独放在这里、只按输出尺寸决定。
 */
const STROKE_BOOST = { 16: 1.8, 32: 1.3, 48: 1.25, 128: 1 };

function strokeFor(size) {
  const boost = STROKE_BOOST[size] ?? 1;
  return ART.stroke * ART_SCALE * boost;
}

/**
 * 箭头在 (px,py) 处的有符号距离（<0 表示在箭头内部）。
 * 两个箭头（各含杆与三角头）取**并集**：四个形状的最近距离再减去半个杆宽。
 */
function arrowDistance(px, py, size) {
  const [ax, ay] = canvasToArt(px, py);
  const half = strokeFor(size) / 2;

  let best = Infinity;
  for (const shape of [rightArrowShape(), leftArrowShape()]) {
    best = Math.min(best, distanceToSegment(ax, ay, shape.shaft));
    best = Math.min(best, distanceToPolygon(ax, ay, shape.head));
  }
  return best - half;
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

/** 有符号距离 → 覆盖率（0..1）。除以像素宽度，边界恰好落在一个像素的宽度上。 */
function coverage(distance, pixelWidth) {
  const value = 0.5 - distance / pixelWidth;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/* ------------------------------------------------------------------ *
 * 光栅化
 * ------------------------------------------------------------------ */

/**
 * 一个采样点的颜色：底色先铺主色、白色箭头再按自己的覆盖**叠上去**（alpha 混合）。
 *
 * `pixelWidth` 是这个采样点代表的面积边长：主渲染传目标像素的边长（1/size），覆盖率因此
 * 就是**解析式的精确面积**；参考渲染（超采样）传子样本的边长（1/(size*factor)），于是每个
 * 子样本只做"在形状内 / 不在形状内"的判定，抗锯齿完全由子样本平均给出——两层都保留
 * SDF 的软过渡会把边缘抹成两倍宽，那正是这套自检要抓的错误。
 *
 * `size` 只用来取笔画宽度（小尺寸要补偿，见 STROKE_BOOST）。
 */
function sampleColor(px, py, size, pixelWidth) {
  const tile = coverage(tileDistance(px, py), pixelWidth);
  if (tile <= 0) return [0, 0, 0, 0];
  const arrow = coverage(arrowDistance(px, py, size), pixelWidth);
  return [
    ACCENT[0] + (255 - ACCENT[0]) * arrow,
    ACCENT[1] + (255 - ACCENT[1]) * arrow,
    ACCENT[2] + (255 - ACCENT[2]) * arrow,
    tile * 255,
  ];
}

/**
 * 画一张 `size × size` 的 RGBA 图。
 *
 * 逐像素解析式求覆盖（每像素只采一次中心点，边界由 SDF 的覆盖率还原）——这比"每像素
 * 打 N 个样本再平均"更准也更便宜，16px 下不会留下锯齿块。
 */
function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const pixelWidth = 1 / size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [red, green, blue, alpha] = sampleColor((x + 0.5) / size, (y + 0.5) / size, size, pixelWidth);
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
 * 像素断言刻意写得**形状相关**而不是"中心像素等于某个值"：中心落在两个箭头之间的
 * 底色缝隙里，钉死一个值等于把几何常量抄进测试，改一点箭头位置就假报错。
 * 这里验的是"该有的东西在不在"：四角透明、上边中点是不透明主色、左右两侧各有白色箭头。
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

  /*
   * 底色。取两个**落在箭头空档**里的点：画布正中（两个箭头之间的缝）与上方中间
   * （右箭头上翼之上、圆角底之内）。二者在所有四个尺寸上都是纯主色。
   *
   * 不钉"上边中点"：那正是右箭头上翼伸过去的地方，会取到白色。
   * 缝隙很窄（16px 下不足一个像素），所以这两处必须**恰好**是主色才说明几何没错。
   */
  for (const [fx, fy, where] of [
    [0.5, 0.5, '两个箭头之间的缝'],
    [0.5, 0.14, '右箭头上翼上方的空档'],
  ]) {
    const x = Math.min(size - 1, Math.round(fx * size));
    const y = Math.min(size - 1, Math.round(fy * size));
    const [r, g, b, a] = pixelAt(rgba, size, x, y);
    assert(a === 255, `${label}: ${where} (${x},${y}) 应是实心底色，实际 alpha=${a}`);
    const distance = Math.abs(r - ACCENT[0]) + Math.abs(g - ACCENT[1]) + Math.abs(b - ACCENT[2]);
    assert(distance <= 12, `${label}: ${where} (${x},${y}) 应是主色 #2563eb，实际 rgb(${r},${g},${b})`);
  }

  // 两个箭头之间的缝隙：必须是纯底色，说明两条杆没有糊成一条。
  const between = pixelAt(rgba, size, Math.floor(size / 2), Math.floor(size / 2));
  assert(between[3] > 200, `${label}: 两箭头之间应是底色，实际 alpha=${between[3]}`);
  assert(
    Math.abs(between[0] - ACCENT[0]) + Math.abs(between[1] - ACCENT[1]) + Math.abs(between[2] - ACCENT[2]) <= 12,
    `${label}: 两箭头之间应是纯底色，实际 rgb(${between[0]},${between[1]},${between[2]})`,
  );

  /*
   * 双向箭头。断言写成**形状相关**而不是钉死某一行：解析式抗锯齿下笔画落在哪一行、
   * 那一行拿到多少覆盖，取决于像素格点，钉死行号等于把几何常量抄进测试。
   *
   * 判据：上/下两个半区各有一行横跨大半个画布的白（两个箭头都在）、两行不挨着（没糊成一条）；
   * 另外再接一个与 4× 参考渲染的平均偏差检查（见下）。
   *
   * 白度看红通道：底色红是 37、白箭头红是 255，混了多少白一目了然。（不能用蓝通道：底色蓝是
   * 235，而边缘上"白 + 半透明底色"会把它顶到 235 以上。）
   */
  const whiteCoverage = (x, y) => {
    const [r, , , a] = pixelAt(rgba, size, x, y);
    if (a < 120) return 0;
    const value = (r - ACCENT[0]) / (255 - ACCENT[0]);
    return value < 0 ? 0 : value > 1 ? 1 : value;
  };
  const isWhite = (x, y) => whiteCoverage(x, y) >= 0.35;
  const shaftWidth = (y) => {
    let count = 0;
    for (let x = 0; x < size; x += 1) if (isWhite(x, y)) count += 1;
    return count;
  };
  const minShaft = Math.max(3, Math.round(size * 0.3));
  const half = Math.floor(size / 2);
  const upperRows = Array.from({ length: half }, (_unused, i) => i);
  const lowerRows = Array.from({ length: size - half }, (_unused, i) => half + i);
  const bestRow = (rows) => rows.reduce((best, y) => (shaftWidth(y) > shaftWidth(best) ? y : best), rows[0] ?? 0);
  const rightRow = bestRow(upperRows);
  const leftRow = bestRow(lowerRows);

  assert(
    shaftWidth(rightRow) >= minShaft,
    `${label}: 上半侧没有找到右向箭头（第 ${rightRow} 行只有 ${shaftWidth(rightRow)} 个白像素，至少要 ${minShaft}）`,
  );
  assert(
    shaftWidth(leftRow) >= minShaft,
    `${label}: 下半侧没有找到左向箭头（第 ${leftRow} 行只有 ${shaftWidth(leftRow)} 个白像素，至少要 ${minShaft}）`,
  );
  assert(leftRow - rightRow >= 2, `${label}: 两个箭头挨得太近（第 ${rightRow} 行与第 ${leftRow} 行），可能糊成了一条`);

  // 与参考渲染对比。判据用**平均偏差**而不是逐像素上限：解析式覆盖算的是精确面积，而参考
  // 渲染是超采样近似——在箭尖那种亚像素尖角上，单个像素两者本来就能差两百个灰阶（那儿的
  // "真实覆盖率"介于两种近似之间，谁也说不清哪个更"对"）。逐像素上限会因此长期假报错。
  // 平均偏差对结构性错误极其敏感：少画一个箭头、几何被裁、形状叠加顺序反了，均值会从个位数
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


  // 至少 2% 的像素是不透明的白（两个箭头本身）。白度看红通道（底色红 37、白 255）：
  // 不能用"三通道都 > 235"——底色蓝本来就是 235，边缘上"白 + 半透明底色"还会把它顶到 235 以上。
  let whitePixels = 0;
  let opaquePixels = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, , , a] = pixelAt(rgba, size, x, y);
      if (a > 200) {
        opaquePixels += 1;
        if (r > 215) whitePixels += 1;
      }
    }
  }
  assert(opaquePixels > size * size * 0.4, `${label}: 不透明像素太少（${opaquePixels}/${size * size}），底色可能没画上`);
  assert(
    whitePixels >= size * size * 0.02,
    `${label}: 白色箭头像素太少（${whitePixels}/${size * size}），箭头可能没画上`,
  );

  // 左右两半各要有白色像素 → 两个方向相反的箭头都在，而不是只剩一个。
  let whiteLeft = 0;
  let whiteRight = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, , , a] = pixelAt(rgba, size, x, y);
      if (a > 200 && r > 215) {
        if (x < size / 2) whiteLeft += 1;
        else whiteRight += 1;
      }
    }
  }
  assert(whiteLeft > 0 && whiteRight > 0, `${label}: 双向箭头缺失（左半白像素 ${whiteLeft}，右半 ${whiteRight}）`);

  return { size, bytes: bytes.length, whitePixels, opaquePixels };
}

/* ------------------------------------------------------------------ *
 * main
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
      `  ✓ ${size}.png  ${report.bytes} 字节  不透明像素 ${report.opaquePixels}/${size * size}  白色箭头像素 ${report.whitePixels}`,
    );
  }

  console.log('');
  console.log(`✓ ${summary.length} 张图标生成并自检通过（PNG 签名 / 各 chunk CRC / IHDR 尺寸 / 四角透明 / 底色 / 双向箭头）`);
  console.log('  manifest.json 通过 icons 与 action.default_icon 引用 icons/<尺寸>.png（相对 dist 根）。');
}

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
