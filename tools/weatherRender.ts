/**
 * Renders the weather painter over plain biome terrain to PNG, one tile per
 * planet type, so the painter can be looked at before it is wired into the
 * engine. Same geometry and projection as tools/weatherCheck's PAINTER section.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/weatherRender.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/wr.mjs" --log-level=error && node "$TEMP/wr.mjs" <outDir> [seed] [frames]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { generatePlanetGrid, GRID_SIZE, SEA_LEVEL, BIOME_COLORS } from '../src/simulation/PlanetGrid';
import { buildClimate, type ClimateInput } from '../src/rendering/weather/WeatherClimate';
import { WeatherSim, WX_DT, WX_WARMUP } from '../src/rendering/weather/WeatherSim';
import { WeatherPainter, buildWeatherLut } from '../src/rendering/weather/WeatherPainter';

const outDir = process.argv[2] ?? 'renders/weather';
const SEED = Number(process.argv[3] ?? 7);
const FRAMES = Number(process.argv[4] ?? 300);
const SCALE = 2;
const TYPES = ['ocean', 'rocky', 'ice', 'lava', 'desert', 'storm', 'toxic', 'carbon', 'crystal'];

const PW = 480, PH = 260;
const pgeom = { cx: 240, cyTop: 140, rx: 150, ry: 78 };
const project = (dx: number, dy: number) => {
  const r = Math.hypot(dx, dy);
  if (r > 1) return null;
  const c = r * (Math.PI / 2), sinC = Math.sin(c), cosC = Math.cos(c);
  const ny = -dy;
  const lat = r < 1e-6 ? 0 : Math.asin(Math.max(-1, Math.min(1, (ny * sinC) / r)));
  const lon = Math.atan2(dx * sinC, r * cosC);
  const v = 0.5 - lat / Math.PI, u = ((lon / (Math.PI * 2)) % 1 + 1) % 1;
  return { row: Math.max(0, Math.min(GRID_SIZE - 1, Math.round(v * (GRID_SIZE - 1)))),
           col: Math.min(GRID_SIZE - 1, Math.floor(u * GRID_SIZE)) };
};

function renderType(type: string, seed: number, frames: number): Uint8ClampedArray {
  const grid = generatePlanetGrid(type, seed * 7777, null, null);
  const lift = (row: number, col: number) =>
    grid[row][col].elevation >= SEA_LEVEL ? Math.round((grid[row][col].elevation - SEA_LEVEL) * 30) : 0;
  const lut = buildWeatherLut(pgeom, project, lift);
  const input: ClimateInput = {
    grid, planetType: type, seed, lush: 0.5, extinctionPressure: 0.1, oxygenLevel: 0.6,
    civLevel: 0, inNebula: false,
  };
  const c = buildClimate(input);
  const sim = new WeatherSim(c); sim.warmUp(WX_WARMUP);
  const painter = new WeatherPainter(lut, c, 24, seed);
  const img = { width: PW, height: PH, data: new Uint8ClampedArray(PW * PH * 4) };
  const shadow = { width: PW, height: PH, data: new Uint8ClampedArray(PW * PH * 4) };
  let acc = 0;
  for (let f = 0; f < frames; f++) {
    const dt = 1 / 60;
    acc += dt;
    while (acc >= WX_DT) { acc -= WX_DT; sim.step(WX_DT); painter.onStep(sim); }
    painter.prepare(sim, acc / WX_DT, dt);
    img.data.fill(0); shadow.data.fill(0);
    painter.paintShadows(shadow, 0.6, 1);
    painter.paintClouds(img, 0.6, 1);
  }

  // Backdrop: space, then the face in flat biome colour with simple limb light.
  const out = new Uint8ClampedArray(PW * PH * 4);
  for (let i = 0; i < PW * PH; i++) { out[i * 4] = 8; out[i * 4 + 1] = 9; out[i * 4 + 2] = 18; out[i * 4 + 3] = 255; }
  for (let i = 0; i < lut.count; i++) {
    const x = lut.px[i], y = lut.py[i];
    const dx = (x - pgeom.cx) / pgeom.rx, dy = (y - pgeom.cyTop) / pgeom.ry;
    const gp = project(dx, dy)!;
    const [r, g, b] = BIOME_COLORS[grid[gp.row][gp.col].biome];
    const light = 0.55 + 0.45 * Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy)) - 0.15 * dx;
    const o = (y * PW + x) * 4;
    out[o] = r * light; out[o + 1] = g * light; out[o + 2] = b * light;
  }
  // Composite shadow then cloud layer, straight alpha over.
  for (const layer of [shadow.data, img.data]) {
    for (let o = 0; o < out.length; o += 4) {
      const a = layer[o + 3] / 255;
      if (a === 0) continue;
      out[o] = out[o] * (1 - a) + layer[o] * a;
      out[o + 1] = out[o + 1] * (1 - a) + layer[o + 1] * a;
      out[o + 2] = out[o + 2] * (1 - a) + layer[o + 2] * a;
    }
  }
  return out;
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

// 3x3 contact sheet, nearest-neighbour upscaled.
const COLS = 3, ROWS = Math.ceil(TYPES.length / COLS);
const SW = PW * COLS * SCALE, SH = PH * ROWS * SCALE;
const sheet = new Uint8ClampedArray(SW * SH * 4);
mkdirSync(outDir, { recursive: true });
TYPES.forEach((t, k) => {
  const tile = renderType(t, SEED, FRAMES);
  writeFileSync(`${outDir}/${t}.png`, png(PW, PH, tile));
  const ox = (k % COLS) * PW * SCALE, oy = Math.floor(k / COLS) * PH * SCALE;
  for (let y = 0; y < PH * SCALE; y++) for (let x = 0; x < PW * SCALE; x++) {
    const s = ((y / SCALE | 0) * PW + (x / SCALE | 0)) * 4, d = ((oy + y) * SW + ox + x) * 4;
    sheet[d] = tile[s]; sheet[d + 1] = tile[s + 1]; sheet[d + 2] = tile[s + 2]; sheet[d + 3] = 255;
  }
  console.log(`  rendered ${t}`);
});
writeFileSync(`${outDir}/sheet.png`, png(SW, SH, sheet));
console.log(`  wrote ${outDir}/sheet.png (${TYPES.join(', ')}; seed ${SEED}, frame ${FRAMES})`);
