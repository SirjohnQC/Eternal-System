/**
 * Renders FloraForge (src/rendering/FloraForge.ts) to a PNG contact sheet:
 * rows of kinds, columns of variants, a few planet types, upscaled so the
 * pixels can be judged.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/floraForgeRender.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/flora.mjs" --log-level=error && node "$TEMP/flora.mjs" <out.png> [px] [types]
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { forgeFlora, type FloraKind } from '../src/rendering/FloraForge';

const out = process.argv[2] ?? 'renders/flora.png';
const PX = Number(process.argv[3] ?? 32);
const TYPES = (process.argv[4] ?? 'ocean,desert,toxic,crystal').split(',');
const KINDS: FloraKind[] = process.argv[5] ? process.argv[5].split(',') as FloraKind[] : ['conifer', 'broadleaf', 'palm', 'bush', 'grass', 'cactus', 'mushroom', 'fern', 'bulb', 'spire', 'pylon', 'boulder', 'ore', 'crystal'];
const GROUND: Record<string, [number, number, number]> = {
  ocean: [92, 128, 70], rocky: [120, 110, 92], desert: [196, 160, 104], toxic: [110, 120, 60],
  crystal: [120, 130, 160], ice: [190, 205, 215], carbon: [70, 56, 50], lava: [80, 50, 40], mechanical: [118, 124, 132],
};
const VARS = 4, COLS = KINDS.length * 1, CELL = PX + 6, SCALE = 4;
const W = COLS * VARS * CELL, H = TYPES.length * CELL;
const img = new Uint8ClampedArray(W * H * 4);
const t0 = Date.now();
TYPES.forEach((type, ti) => {
  const g = GROUND[type] ?? [120, 110, 92];
  for (let y = ti * CELL; y < (ti + 1) * CELL; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4, ground = y - ti * CELL > CELL - 5;
    const c = ground ? g : [24, 30, 36];
    img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; img[o + 3] = 255;
  }
  KINDS.forEach((kind, ki) => {
    for (let v = 0; v < VARS; v++) {
      const f = forgeFlora(kind, v, PX, type, g);
      const ax = (ki * VARS + v) * CELL + (CELL >> 1), ay = (ti + 1) * CELL - 5;
      for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
        const s = (y * f.width + x) * 4, a = f.data[s + 3] / 255;
        const X = ax + x - f.footX, Y = ay + y - f.footY;
        if (a === 0 || X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const o = (Y * W + X) * 4;
        for (let c = 0; c < 3; c++) img[o + c] = img[o + c] * (1 - a) + f.data[s + c] * a;
      }
    }
  });
});
console.log(`${TYPES.length * KINDS.length * VARS} sprites in ${Date.now() - t0} ms`);
const SW = W * SCALE, SH = H * SCALE, up = new Uint8ClampedArray(SW * SH * 4);
for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
  const s = (((y / SCALE) | 0) * W + ((x / SCALE) | 0)) * 4, o = (y * SW + x) * 4;
  up[o] = img[s]; up[o + 1] = img[s + 1]; up[o + 2] = img[s + 2]; up[o + 3] = 255;
}
function png(w: number, h: number, rgba: Uint8ClampedArray): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
  });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
writeFileSync(out, png(SW, SH, up));
