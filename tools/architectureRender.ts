/**
 * Architecture genome contact sheet: a sample town for many species / world
 * pairs, so the variety (and the surprises) can be judged at a glance.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/architectureRender.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/ar.mjs" --log-level=error && node "$TEMP/ar.mjs" <out.png> [era]
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { archGenome } from '../src/rendering/Architecture';
import { planSettlements, SQUASH } from '../src/rendering/SettlementPlan';
import { paintBuilding, townStyle } from '../src/rendering/SettlementForge';

const out = process.argv[2] ?? 'renders/architecture.png';
const ERA = Number(process.argv[3] ?? 2);
const S = 3;
const CIVS: Array<[string, string, string, string, string, number, string]> = [
  // body, environment, locomotion, metabolism, size, social, world
  ['vertebrate', 'land', 'walking', 'heterotrophic', 'medium', 5, 'rocky'],
  ['exoskeletal', 'land', 'walking', 'heterotrophic', 'small', 8, 'desert'],
  ['shelled', 'coastal', 'crawling', 'heterotrophic', 'small', 5, 'ocean'],
  ['gelatinous', 'ocean', 'swimming', 'heterotrophic', 'medium', 6, 'ocean'],
  ['filamentous', 'land', 'stationary', 'photosynthetic', 'large', 4, 'rocky'],
  ['vertebrate', 'land', 'walking', 'heterotrophic', 'large', 3, 'lava'],
  ['radial', 'land', 'crawling', 'heterotrophic', 'medium', 6, 'ice'],
  ['cartilaginous', 'aerial', 'flying', 'heterotrophic', 'medium', 5, 'storm'],
  ['colonial', 'land', 'stationary', 'chemosynthetic', 'tiny', 9, 'toxic'],
  ['segmented', 'land', 'crawling', 'heterotrophic', 'small', 2, 'carbon'],
  ['vertebrate', 'land', 'walking', 'heterotrophic', 'massive', 4, 'crystal'],
  ['single-celled', 'ocean', 'swimming', 'chemosynthetic', 'microscopic', 7, 'toxic'],
];
const CW = 150, CH = 90, COLS = 4, ROWS = Math.ceil(CIVS.length / COLS), SCALE = 3;
const W = CW * COLS, H = CH * ROWS;
const img = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) { img[i * 4] = 70; img[i * 4 + 1] = 96; img[i * 4 + 2] = 58; img[i * 4 + 3] = 255; }
CIVS.forEach(([body, env, loco, meta, size, social, world], k) => {
  const arch = archGenome({ bodyStructure: body, environment: env, locomotion: loco, metabolism: meta, social, size, planetType: world, seed: 1000 + k * 7919 });
  console.log(`${k}: ${body}/${world} -> ${arch.shape} ${arch.layout} [${arch.quirks.join(',')}] — ${arch.summary}`);
  const plan = planSettlements({
    sites: [{ x: 40, y: 22 }], civLevel: ERA, seed: 99 + k, rx: 93,
    isLand: () => true, fertileAt: () => 0, aquatic: false, aggression: 3, arch,
  });
  const st = townStyle(plan.era, body, arch);
  const ox = (k % COLS) * CW, oy = Math.floor(k / COLS) * CH;
  // scale the face into the cell (S px per world px), towns centred
  for (const b of plan.buildings) {
    const f = paintBuilding(b, S, st);
    const ax = ox + CW / 2 + (b.x - 40) * S, ay = oy + CH * 0.62 + (b.y - 22) * S;
    for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
      const s = (y * f.width + x) * 4; if (!f.data[s + 3]) continue;
      const X = Math.round(ax + x - f.footX), Y = Math.round(ay + y - f.footY);
      if (X < ox || Y < oy || X >= ox + CW || Y >= oy + CH) continue;
      const o = (Y * W + X) * 4; img[o] = f.data[s]; img[o + 1] = f.data[s + 1]; img[o + 2] = f.data[s + 2];
    }
  }
  void SQUASH;
});
const SW = W * SCALE, SH = H * SCALE, up = new Uint8ClampedArray(SW * SH * 4);
for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
  const s = (((y / SCALE) | 0) * W + ((x / SCALE) | 0)) * 4, o = (y * SW + x) * 4;
  up[o] = img[s]; up[o + 1] = img[s + 1]; up[o + 2] = img[s + 2]; up[o + 3] = 255;
}
function png(w: number, h: number, rgba: Uint8ClampedArray): Buffer {
  const t = Array.from({ length: 256 }, (_, n) => { let c = n; for (let q = 0; q < 8; q++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (ty: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(ty), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
writeFileSync(out, png(SW, SH, up));
