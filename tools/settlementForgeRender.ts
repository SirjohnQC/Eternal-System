/**
 * Renders SettlementForge buildings to a PNG contact sheet: one row per era
 * (its houses and landmark), at camera scales 1..4, upscaled to judge pixels.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/settlementForgeRender.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/sf.mjs" --log-level=error && node "$TEMP/sf.mjs" <out.png> [S]
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { paintBuilding, townStyle } from '../src/rendering/SettlementForge';
import type { Building, BuildingKind, Era } from '../src/rendering/SettlementPlan';

const out = process.argv[2] ?? 'renders/settlements.png';
const S = Number(process.argv[3] ?? 4);
const ROWS: Array<[Era, Array<[BuildingKind, number, number, number]>]> = [
  [0, [['hut', 1.6, 1.6, 0.7], ['hut', 1.9, 1.9, 0.8], ['hut', 2.6, 2.6, 0.9]]],
  [1, [['adobe', 2, 1.6, 1.2], ['house', 1.8, 1.6, 1.2], ['adobe', 2.3, 1.8, 1.3], ['ziggurat', 4, 4, 2.9]]],
  [2, [['house', 1.8, 1.8, 1.4], ['gable', 2.1, 1.8, 1.5], ['house', 2.2, 2, 1.6], ['church', 2.6, 2.2, 3.4], ['keep', 2.5, 2.3, 3.5]]],
  [3, [['row', 2.4, 1.8, 2], ['row', 2.8, 2, 2.3], ['house', 2, 1.8, 1.8], ['mill', 3.3, 2.2, 1.8]]],
  [4, [['block', 2.2, 1.8, 2.5], ['block', 2.4, 2, 3], ['tower', 2.2, 2, 4.5], ['tower', 2.4, 2.2, 6]]],
  [5, [['block', 2, 1.8, 2.8], ['tower', 2, 1.8, 5.5], ['tower', 2.2, 2, 7], ['spire', 2, 2, 8]]],
  [6, [['dome', 2, 2, 0.8], ['spire', 1.9, 1.9, 6], ['dome', 2.3, 2.3, 0.9], ['spire', 2.1, 2.1, 8]]],
];
const CELL_W = Math.round(5 * S) + 10, CELL_H = Math.round(13 * S) + 10, COLS = 5, SCALE = S >= 4 ? 3 : 5;
const W = CELL_W * COLS, H = CELL_H * ROWS.length;
const img = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) { const y = (i / W) | 0, g = (y % CELL_H) > CELL_H - 6; img[i * 4] = g ? 96 : 22; img[i * 4 + 1] = g ? 128 : 26; img[i * 4 + 2] = g ? 70 : 34; img[i * 4 + 3] = 255; }
ROWS.forEach(([era, items], ri) => {
  const st = townStyle(era);
  items.forEach(([kind, w, d, h], ci) => {
    const b: Building = { x: 0, y: 0, w, d, h, kind, seed: ri * 31 + ci * 7 + 1, town: 0 };
    const f = paintBuilding(b, S, st);
    const ax = ci * CELL_W + (CELL_W >> 1), ay = (ri + 1) * CELL_H - 6;
    for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
      const s = (y * f.width + x) * 4; if (!f.data[s + 3]) continue;
      const X = ax + x - f.footX, Y = ay + y - f.footY;
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const o = (Y * W + X) * 4; img[o] = f.data[s]; img[o + 1] = f.data[s + 1]; img[o + 2] = f.data[s + 2];
    }
  });
});
const SW = W * SCALE, SH = H * SCALE, up = new Uint8ClampedArray(SW * SH * 4);
for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
  const s = (((y / SCALE) | 0) * W + ((x / SCALE) | 0)) * 4, o = (y * SW + x) * 4;
  up[o] = img[s]; up[o + 1] = img[s + 1]; up[o + 2] = img[s + 2]; up[o + 3] = 255;
}
function png(w: number, h: number, rgba: Uint8ClampedArray): Buffer {
  const t = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (ty: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(ty), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
writeFileSync(out, png(SW, SH, up));
console.log(`${W}x${H} at S=${S}`);
