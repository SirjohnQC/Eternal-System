/**
 * Renders GalaxyArt bakes (haze + stars, composited over space) for every
 * morphology into one PNG sheet, for visual review.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/galaxyArtRender.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/galart.mjs --log-level=error && node /tmp/galart.mjs <out.png> [cellPx=520]
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { bakeGalaxyHaze, bakeGalaxyStars, type GalaxyShape, type Raster } from '../src/rendering/GalaxyArt';

const out = process.argv[2] ?? 'renders/galaxy-art.png';
const CELL = Number(process.argv[3] ?? 520);

function png(w: number, h: number, rgba: Uint8ClampedArray): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Sample a raster at unit coords (u,v in 0..1): bilinear (haze) or nearest (stars). */
function sample(r: Raster, u: number, v: number, linear: boolean): [number, number, number, number] {
  const n = r.size;
  if (!linear) {
    const x = Math.min(n - 1, Math.floor(u * n)), y = Math.min(n - 1, Math.floor(v * n)), o = (y * n + x) * 4;
    return [r.data[o], r.data[o + 1], r.data[o + 2], r.data[o + 3]];
  }
  const fx = u * n - 0.5, fy = v * n - 0.5, x0 = Math.max(0, Math.floor(fx)), y0 = Math.max(0, Math.floor(fy));
  const x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
  const g = (x: number, y: number, c: number) => r.data[(y * n + x) * 4 + c];
  const res: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) res[c] = (g(x0, y0, c) * (1 - tx) + g(x1, y0, c) * tx) * (1 - ty) + (g(x0, y1, c) * (1 - tx) + g(x1, y1, c) * tx) * ty;
  return res;
}

const shapes: GalaxyShape[] = [
  { id: 1, morph: 'spiral', armCount: 2, armPitch: 0.24, barLength: 0, color: '#9fb4ff' },
  { id: 2, morph: 'barred', armCount: 3, armPitch: 0.27, barLength: 0.46, color: '#b8f0d0' },
  { id: 3, morph: 'spiral', armCount: 4, armPitch: 0.32, barLength: 0, color: '#e0a0ff' },
  { id: 4, morph: 'barred', armCount: 2, armPitch: 0.19, barLength: 0.4, color: '#ffc890' },
  { id: 5, morph: 'elliptical', armCount: 0, armPitch: 0.2, barLength: 0, color: '#ffd8a0' },
  { id: 6, morph: 'lenticular', armCount: 0, armPitch: 0.2, barLength: 0, color: '#f0e0c0' },
  { id: 7, morph: 'irregular', armCount: 0, armPitch: 0.2, barLength: 0, color: '#a0d8ff' },
];
const COLS = 4, ROWS = Math.ceil(shapes.length / COLS), W = CELL * COLS, H = CELL * ROWS;
const img = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) { img[i * 4] = 4; img[i * 4 + 1] = 3; img[i * 4 + 2] = 12; img[i * 4 + 3] = 255; }
const t0 = Date.now();
shapes.forEach((s, k) => {
  const haze = bakeGalaxyHaze(s), stars = bakeGalaxyStars(s);
  const ox = (k % COLS) * CELL, oy = Math.floor(k / COLS) * CELL;
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    const u = (x + 0.5) / CELL, v = (y + 0.5) / CELL;
    const h = sample(haze, u, v, true), st = sample(stars, u, v, CELL < stars.size);
    const o = ((oy + y) * W + ox + x) * 4;
    // Haze: normal alpha (0.85); stars: additive.
    const ha = h[3] / 255 * 0.85;
    for (let c = 0; c < 3; c++) img[o + c] = Math.min(255, img[o + c] * (1 - ha) + h[c] * ha + st[c] * (st[3] / 255));
  }
});
writeFileSync(out, png(W, H, img));
console.log(`wrote ${out} (${shapes.length} galaxies, bakes ${(Date.now() - t0)}ms total incl. compositing)`);
