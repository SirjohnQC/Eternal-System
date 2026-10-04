/**
 * Renders the procedural pixel-art sun (src/rendering/SunArt) to PNG: every
 * spectral band at the system-view and sky sizes, a few animation phases each,
 * upscaled so the pixels can be judged.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/sunRender.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/sun.mjs" --log-level=error && node "$TEMP/sun.mjs" <out.png>
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { paintSunBody, paintSunCorona, SUN_PALETTES, type SunBand } from '../src/rendering/SunArt';

const out = process.argv[2] ?? 'renders/sun.png';
const BANDS: SunBand[] = ['blue', 'white', 'yellow', 'orange', 'red'];
const CELL = 64, PHASES = 4, SCALE = 4;
const W = CELL * PHASES * 2, H = CELL * BANDS.length;
const img = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) { img[i * 4] = 8; img[i * 4 + 1] = 8; img[i * 4 + 2] = 20; img[i * 4 + 3] = 255; }
const tile = new Uint8ClampedArray(CELL * CELL * 4);
BANDS.forEach((band, bi) => {
  for (let col = 0; col < PHASES * 2; col++) {
    const big = col < PHASES, phase = (col % PHASES) / PHASES;
    const R = big ? 15 : 6;
    tile.fill(0);
    const c = CELL / 2;
    paintSunCorona(tile, CELL, CELL, c, c, R, SUN_PALETTES[band], { seed: 3 + bi, phase, spin: phase * 0.6, reach: big ? 0.9 : 1.1, prominences: R >= 6 });
    paintSunBody(tile, CELL, CELL, c, c, R, SUN_PALETTES[band], { seed: 3 + bi, phase });
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const s = (y * CELL + x) * 4, a = tile[s + 3] / 255, o = (((bi * CELL + y) * W) + col * CELL + x) * 4;
      for (let k = 0; k < 3; k++) img[o + k] = img[o + k] * (1 - a) + tile[s + k] * a;
    }
  }
});
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
