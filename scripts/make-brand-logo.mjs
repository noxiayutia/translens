#!/usr/bin/env node
/**
 * 生成大尺寸的 **TransLens 品牌 logo**（`docs/brand/translens-logo.png`，默认 512×512）。
 *
 * 为什么单独一个脚本、而不是塞进 `make-icons.mjs`：这两个东西**不是同一张图的不同尺寸**。
 *
 * - `npm run icons` 产出的是**扩展图标**：蓝底 + 双向箭头，专为 16px 的工具栏设计，
 *   最多只承载"一个形状 + 一个方向"。
 * - 这里产出的是**品牌 logo**：蓝底 + 两个相交的薄荷青透镜圆（左＝原文语言、右＝译文语言），
 *   两圆交集里放一支白色箭头。它是给扩展详情页、官网、README 用的，尺寸够大，
 *   塞得下"两个圆 + 一个箭头"这三层。
 *
 * 几何常量与光栅化函数全部从 `make-icons.mjs` import，**不复制**：蓝底色、薄荷青、圆角半径
 * 这些只要有一处对不上，图标与 logo 就会是两个品牌。
 *
 * 用法：
 *   node scripts/make-brand-logo.mjs                     # → docs/brand/translens-logo.png (512)
 *   node scripts/make-brand-logo.mjs --size 1024         # 自定义尺寸
 *   node scripts/make-brand-logo.mjs --out <file.png>    # 自定义输出路径
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACCENT,
  MINT,
  LENS_CIRCLES,
  renderArtwork,
  encodePng,
  coverage,
  over,
} from './make-icons.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ *
 * 透镜环的几何（都在 0..1 的归一化坐标里，与输出尺寸无关）
 * ------------------------------------------------------------------ */

/**
 * 两圆的半径直接沿用图标那套（`LENS_CIRCLES.radius`），只把**环的笔画**单独定义。
 * 这个尺寸下环是真的空心——16px 下做不到的"空心"，正是 logo 存在的理由。
 */
const RING = {
  /** 环的笔画宽（直径方向的粗细）。0.05 在 512px 下约 26px。 */
  stroke: 0.05,
};

/**
 * 白箭头。坐标是**归一化画布坐标**（0..1，与 `renderArtwork` 传进来的 px/py 同一套），
 * 不是 `make-icons.mjs` 里那套以中心为原点的 ART 坐标——这里没有 `canvasToArt` 那层映射，
 * 写错坐标系会让整支箭头跑到画布外面去（曾经真的这样错过一次）。
 *
 * 位置是算出来的：两个透镜圆在 x = 0.5 处的交叠区间是 y ∈ [0.36, 0.64]，两圆的交点分别落在
 * y ≈ 0.36 与 y ≈ 0.64。箭头取 0.42→0.60，**两头各留出约 0.04 的余量**，既不碰到交点上，
 * 也不出交叠区；头宽 0.05 也有约束——再宽下去两翼会伸进左右两个环的笔画里。
 */
const ARROW = {
  shaftHalfWidth: 0.021,
  shaftTopY: 0.42,
  headBaseY: 0.5,
  headHalfWidth: 0.05,
  tipY: 0.6,
  /** 箭头的中心横坐标：两透镜圆交叠处的正中。 */
  centerX: 0.5,
};

/**
 * 单个圆的距离场。`center` 取 `LENS_CIRCLES.left/right`。
 */
function circleDistance(px, py, center) {
  return Math.hypot(px - center.x, py - center.y) - LENS_CIRCLES.radius;
}

/** 某个圆环（空心的圈）的距离场：到圆心距离取绝对值再减半个笔画宽，圆内圆外都是正的。 */
function ringDistanceAt(px, py, center) {
  return Math.abs(circleDistance(px, py, center)) - RING.stroke / 2;
}

/** 两实心圆的交集（交叠处）。 */
function overlapDistance(px, py) {
  return Math.max(circleDistance(px, py, LENS_CIRCLES.left), circleDistance(px, py, LENS_CIRCLES.right));
}

/** 白箭头的距离场（杆与三角头的并集）。 */
function arrowDistance(px, py) {
  const shaft = { ax: ARROW.centerX, ay: ARROW.shaftTopY, bx: ARROW.centerX, by: ARROW.headBaseY };
  const head = [
    [ARROW.centerX, ARROW.tipY],
    [ARROW.centerX - ARROW.headHalfWidth, ARROW.headBaseY],
    [ARROW.centerX + ARROW.headHalfWidth, ARROW.headBaseY],
  ];

  const dShaft = (() => {
    const dx = shaft.bx - shaft.ax;
    const dy = shaft.by - shaft.ay;
    const lengthSq = dx * dx + dy * dy;
    let t = lengthSq === 0 ? 0 : ((px - shaft.ax) * dx + (py - shaft.ay) * dy) / lengthSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (shaft.ax + t * dx), py - (shaft.ay + t * dy));
  })();

  const dHead = (() => {
    let inside = false;
    let nearest = Infinity;
    for (let i = 0, j = head.length - 1; i < head.length; j = i, i += 1) {
      const [xi, yi] = head[i];
      const [xj, yj] = head[j];
      const ex = xj - xi;
      const ey = yj - yi;
      const lengthSq = ex * ex + ey * ey;
      let t = lengthSq === 0 ? 0 : ((px - xi) * ex + (py - yi) * ey) / lengthSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      nearest = Math.min(nearest, Math.hypot(px - (xi + t * ex), py - (yi + t * ey)));
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside ? -nearest : nearest;
  })();

  return Math.min(dShaft, dHead) - ARROW.shaftHalfWidth;
}

/* ------------------------------------------------------------------ *
 * 绘制
 * ------------------------------------------------------------------ */

/**
 * 品牌 logo 的上层：两个透镜环 + 交叠处高光 + 白箭头。
 *
 * 绘制顺序（后画的压住先画的）：环 → 交叠处高光 → 白箭头。
 *
 * 只画三层。早先试过"把并集向外鼓一块、填成浅蓝"来造镜片的体积感，结果是**圆角底上又叠了
 * 一个圆角底的轮廓**，两圆的交叠区还多出一条同心弧，整张图像有摩尔纹。这里直接用环本身的
 * 空心来讲"两个镜片"——够用的语义，不需要额外的形状。
 */
function drawLayers(px, py, size, pixelWidth) {
  const ringLeft = coverage(ringDistanceAt(px, py, LENS_CIRCLES.left), pixelWidth);
  const ringRight = coverage(ringDistanceAt(px, py, LENS_CIRCLES.right), pixelWidth);
  const ring = Math.max(ringLeft, ringRight);
  const lens = coverage(overlapDistance(px, py), pixelWidth);
  const arrow = coverage(arrowDistance(px, py), pixelWidth);
  if (ring <= 0 && lens <= 0 && arrow <= 0) return [0, 0, 0, 0];

  let color = ACCENT;
  // 1) 交叠处先垫一层淡薄荷青，让"两个镜片重叠"看得出来。
  color = over(color, MINT, lens * 0.35);
  // 2) 两个环。
  color = over(color, MINT, ring);
  // 3) 白箭头。
  color = over(color, [255, 255, 255], arrow);

  return [color[0], color[1], color[2], Math.max(Math.max(ring, lens), arrow)];
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const sizeFlag = argv.indexOf('--size');
  const outFlag = argv.indexOf('--out');

  let size = 512;
  if (sizeFlag !== -1) {
    const raw = argv[sizeFlag + 1];
    size = Number(raw);
    if (!Number.isInteger(size) || size < 64 || size > 4096) {
      throw new Error(`--size 必须是 64..4096 之间的整数，实际是 ${raw}`);
    }
  }

  let out = join(REPO_ROOT, 'docs', 'brand', 'translens-logo.png');
  if (outFlag !== -1) {
    const raw = argv[outFlag + 1];
    if (raw === undefined || raw.startsWith('--')) throw new Error('--out 后面必须跟一个文件路径');
    out = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  }

  return { size, out };
}

function main() {
  const { size, out } = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(out), { recursive: true });

  const pixels = renderArtwork(size, 'tile', drawLayers);
  writeFileSync(out, encodePng(pixels, size));

  // 两处最该有的东西各抽一个像素核对：环上（薄荷青）与交叠处（更亮的薄荷青）。
  const at = (fx, fy) => {
    const x = Math.round(fx * size);
    const y = Math.round(fy * size);
    const offset = (y * size + x) * 4;
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
  };
  const ringPixel = at(LENS_CIRCLES.left.x, LENS_CIRCLES.left.y - LENS_CIRCLES.radius);
  const lensPixel = at(LENS_CIRCLES.left.x + 0.15, LENS_CIRCLES.left.y);
  const cornerPixel = at(0, 0);

  if (cornerPixel[3] !== 0) throw new Error(`自检失败：左上角应透明，实际 alpha=${cornerPixel[3]}`);
  if (ringPixel[3] < 200 || ringPixel[1] - ringPixel[0] < 60) {
    throw new Error(`自检失败：左环上沿应是薄荷青，实际 rgba(${ringPixel.join(',')})`);
  }
  if (lensPixel[3] < 200) throw new Error(`自检失败：交叠处应不透明，实际 alpha=${lensPixel[3]}`);

  // 透明像素占比：整张图应当是"圆角方形 + 四角透明"，透明太少说明底色画漏了、太多说明圆没画上。
  let opaque = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 200) opaque += 1;
  const opaqueRatio = opaque / (size * size);
  if (opaqueRatio < 0.4 || opaqueRatio > 0.8) {
    throw new Error(`自检失败：不透明像素占比 ${(opaqueRatio * 100).toFixed(1)}% 不在 40%~80% 之间`);
  }

  console.log(`✓ 品牌 logo 生成并自检通过 → ${out}`);
  console.log(`  ${size}×${size}，不透明像素 ${(opaqueRatio * 100).toFixed(1)}%`);
  console.log(`  环上沿 rgba(${ringPixel.join(',')})、交叠处 rgb(${lensPixel.slice(0, 3).join(',')})、四角透明`);
  console.log('  扩展图标（16/32/48/128）不在这里，见 scripts/make-icons.mjs。');
}

try {
  main();
} catch (error) {
  console.error(`✗ 生成品牌 logo 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
