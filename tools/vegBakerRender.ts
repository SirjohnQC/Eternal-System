/**
 * Bake the procedural vegetation atlas to PNG previews for eyeballing.
 *
 *   npx esbuild tools/vegBakerRender.ts --bundle --platform=node --format=esm \
 *     --outfile=%TEMP%/vegBaker.mjs && node %TEMP%/vegBaker.mjs
 */
import { writeFileSync, mkdirSync } from 'fs';
import { deflateSync } from 'zlib';
import { join } from 'path';
import { bakeVegetationAtlasSet, bakeVegetationSprite } from '../src/rendering/VegetationBaker';
import type { DecalKind } from '../src/rendering/SurfaceDecals';
import { stampDecals, type DecalSite } from '../src/rendering/SurfaceDecals';

const OUT = join('renders', 'veg-baker-2026-10-01');

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function writePng(path: string, w: number, h: number, rgba: Uint8ClampedArray | Uint8Array): void {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4)
      .copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunk = (tag: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const type = Buffer.from(tag);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([len, type, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

function upscale(src: Uint8ClampedArray, sw: number, sh: number, n: number): { w: number; h: number; d: Uint8ClampedArray } {
  const w = sw * n, h = sh * n, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const so = (((y / n) | 0) * sw + ((x / n) | 0)) * 4, o = (y * w + x) * 4;
    d[o] = src[so]; d[o + 1] = src[so + 1]; d[o + 2] = src[so + 2]; d[o + 3] = src[so + 3];
  }
  return { w, h, d };
}

function onGrass(spr: Uint8ClampedArray, cell: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(cell * cell * 4);
  for (let i = 0; i < cell * cell; i++) {
    const o = i * 4;
    out[o] = 58; out[o + 1] = 118; out[o + 2] = 52; out[o + 3] = 255;
    if (spr[o + 3]) { out[o] = spr[o]; out[o + 1] = spr[o + 1]; out[o + 2] = spr[o + 2]; }
  }
  return out;
}

function sheetCompare(atlas: ReturnType<typeof bakeVegetationAtlasSet>): void {
  const cell = 16, scale = 6, pad = 8;
  const kinds: DecalKind[] = ['conifer', 'broadleaf', 'scrub', 'cactus', 'rock'];
  const W = pad * 2 + 3 * (cell * scale + 4);
  const H = pad * 2 + 5 * (cell * scale + 4);
  const img = new Uint8ClampedArray(W * H * 4);
  img.fill(18);
  for (let i = 3; i < img.length; i += 4) img[i] = 255;
  const blit = (sx: number, sy: number, spr: Uint8ClampedArray, c: number) => {
    const u = upscale(onGrass(spr, c), c, c, (cell * scale) / c);
    for (let y = 0; y < u.h; y++) for (let x = 0; x < u.w; x++) {
      const dx = sx + x, dy = sy + y;
      if (dx < 0 || dy < 0 || dx >= W || dy >= H) continue;
      const o = (dy * W + dx) * 4, so = (y * u.w + x) * 4;
      img[o] = u.d[so]; img[o + 1] = u.d[so + 1]; img[o + 2] = u.d[so + 2]; img[o + 3] = 255;
    }
  };
  kinds.forEach((kind, row) => {
    for (let v = 0; v < 3; v++) {
      const spr = bakeVegetationSprite(kind, v, 16);
      blit(pad + v * (cell * scale + 4), pad + row * (cell * scale + 4), spr, 16);
    }
  });
  writePng(join(OUT, 'baker_atlas_16_x6.png'), W, H, img);
  // LOD strip for broadleaf
  const lodW = pad * 4 + 16 * 5 + 32 * 4 + 48 * 3;
  const lodH = pad * 2 + 48 * 3;
  const lod = new Uint8ClampedArray(lodW * lodH * 4);
  for (let i = 0; i < lod.length; i += 4) { lod[i] = 12; lod[i + 1] = 10; lod[i + 2] = 16; lod[i + 3] = 255; }
  let x = pad;
  for (const cellN of [16, 32, 48] as const) {
    const spr = onGrass(bakeVegetationSprite('broadleaf', 1, cellN), cellN);
    const n = cellN === 16 ? 5 : cellN === 32 ? 4 : 3;
    const u = upscale(spr, cellN, cellN, n);
    for (let y = 0; y < u.h; y++) for (let xx = 0; xx < u.w; xx++) {
      const dx = x + xx, dy = (pad + ((48 * 3 - u.h) / 2 + y)) | 0;
      const o = (dy * lodW + dx) * 4, so = (y * u.w + xx) * 4;
      lod[o] = u.d[so]; lod[o + 1] = u.d[so + 1]; lod[o + 2] = u.d[so + 2]; lod[o + 3] = 255;
    }
    x += u.w + pad;
  }
  writePng(join(OUT, 'baker_lod_broadleaf.png'), lodW, lodH, lod);
  void atlas;
}

function groveStamp(atlas: ReturnType<typeof bakeVegetationAtlasSet>, scale: number, name: string): void {
  const W = 200, H = 120;
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    d[o] = 52; d[o + 1] = 108; d[o + 2] = 44; d[o + 3] = 255;
  }
  // dirt path — only at planet/grove zoom; at tree zoom it reads as a giant trunk
  if (scale < 4) {
    for (let y = 0; y < H; y++) {
      const cx = (W * 0.55 + (y / H - 0.5) * 8) | 0;
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= W) continue;
        const o = (y * W + x) * 4;
        d[o] = 96; d[o + 1] = 72; d[o + 2] = 42;
      }
    }
  }
  const plants: DecalSite[] = [
    { x: 40, y: 36, kind: 'conifer', scale: 1, row: 1, col: 2 },
    { x: 58, y: 40, kind: 'broadleaf', scale: 1, row: 2, col: 3 },
    { x: 78, y: 34, kind: 'conifer', scale: 1, row: 3, col: 1 },
    { x: 98, y: 42, kind: 'broadleaf', scale: 1, row: 4, col: 5 },
    { x: 120, y: 38, kind: 'conifer', scale: 1, row: 5, col: 2 },
    { x: 140, y: 44, kind: 'broadleaf', scale: 1, row: 1, col: 7 },
    { x: 30, y: 60, kind: 'scrub', scale: 1, row: 6, col: 2 },
    { x: 50, y: 68, kind: 'broadleaf', scale: 1, row: 2, col: 8 },
    { x: 70, y: 64, kind: 'scrub', scale: 1, row: 3, col: 4 },
    { x: 130, y: 62, kind: 'conifer', scale: 1, row: 4, col: 6 },
    { x: 155, y: 70, kind: 'scrub', scale: 1, row: 5, col: 1 },
    { x: 90, y: 88, kind: 'rock', scale: 1, row: 7, col: 3 },
    { x: 105, y: 92, kind: 'scrub', scale: 1, row: 8, col: 2 },
    { x: 45, y: 90, kind: 'rock', scale: 1, row: 9, col: 4 },
    { x: 160, y: 50, kind: 'cactus', scale: 1, row: 2, col: 9 },
  ];
  // For LOD preview at higher scale, spread positions so sprites don't pile.
  const spaced = plants.map(p => ({
    ...p,
    x: Math.round(p.x * (scale === 1 ? 1 : scale === 2 ? 1.1 : 1.15)),
    y: Math.round(p.y * (scale === 1 ? 1 : scale === 2 ? 1.1 : 1.15)),
  }));
  stampDecals(d, W, H, 0, 0, spaced, atlas, scale, true, false);
  const n = scale === 1 ? 4 : scale === 2 ? 3 : 2;
  const u = upscale(d, W, H, n);
  writePng(join(OUT, name), u.w, u.h, u.d);
}

function trunkCloseup(): void {
  const kinds: DecalKind[] = ['conifer', 'broadleaf'];
  const cell = 48, scale = 4, pad = 10;
  const W = pad * 2 + kinds.length * 3 * (cell * scale + 8);
  const H = pad * 2 + cell * scale + 20;
  const img = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < img.length; i += 4) { img[i] = 12; img[i + 1] = 10; img[i + 2] = 16; img[i + 3] = 255; }
  let x = pad;
  for (const kind of kinds) {
    for (let v = 0; v < 3; v++) {
      const spr = onGrass(bakeVegetationSprite(kind, v, 48), 48);
      const u = upscale(spr, 48, 48, scale);
      for (let y = 0; y < u.h; y++) for (let xx = 0; xx < u.w; xx++) {
        const dx = x + xx, dy = pad + y;
        const o = (dy * W + dx) * 4, so = (y * u.w + xx) * 4;
        img[o] = u.d[so]; img[o + 1] = u.d[so + 1]; img[o + 2] = u.d[so + 2]; img[o + 3] = 255;
      }
      x += u.w + 8;
    }
  }
  writePng(join(OUT, 'trunk_closeup_z4_x4.png'), W, H, img);
}

mkdirSync(OUT, { recursive: true });
const atlas = bakeVegetationAtlasSet();
writePng(join(OUT, 'atlas_16_color.png'), atlas.width, atlas.height, atlas.data);
if (atlas.lod32) writePng(join(OUT, 'atlas_32_color.png'), atlas.lod32.width, atlas.lod32.height, atlas.lod32.data);
if (atlas.lod48) writePng(join(OUT, 'atlas_48_color.png'), atlas.lod48.width, atlas.lod48.height, atlas.lod48.data);
sheetCompare(atlas);
trunkCloseup();
groveStamp(atlas, 1, 'grove_z1_x4.png');
groveStamp(atlas, 2, 'grove_z2_x3.png');
groveStamp(atlas, 4, 'grove_z4_x2.png');
console.log(`wrote ${OUT}`);
