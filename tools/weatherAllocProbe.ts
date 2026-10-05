/**
 * Fast per-frame allocation probe for the weather painter (the slice of
 * tools/weatherCheck's "no per-frame allocation" checks, in seconds instead
 * of the full suite's half hour). Same harness geometry as weatherCheck.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/weatherAllocProbe.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/wap.mjs" --log-level=error && node --expose-gc "$TEMP/wap.mjs" [type] [seed] [zoom]
 */
import { generatePlanetGrid, GRID_SIZE, SEA_LEVEL } from '../src/simulation/PlanetGrid';
import { buildClimate } from '../src/rendering/weather/WeatherClimate';
import { WeatherSim, WX_DT, WX_WARMUP } from '../src/rendering/weather/WeatherSim';
import { WeatherPainter, buildWeatherLut, CLOUD_TOWER_MAX } from '../src/rendering/weather/WeatherPainter';
import { VX_NAMES } from '../src/rendering/weather/WeatherEvents';

const type = process.argv[2] ?? 'ocean', seed = Number(process.argv[3] ?? 7), zoom = Number(process.argv[4] ?? 1);
const PW = 480, PH = 260;
const pgeom = { cx: 240, cyTop: 140, rx: 150, ry: 78 };
const project = (dx: number, dy: number) => {
  const r = Math.hypot(dx, dy);
  if (r > 1) return null;
  const c = r * (Math.PI / 2), sinC = Math.sin(c), cosC = Math.cos(c);
  const lat = r < 1e-6 ? 0 : Math.asin(Math.max(-1, Math.min(1, (-dy * sinC) / r)));
  const lon = Math.atan2(dx * sinC, r * cosC);
  const v = 0.5 - lat / Math.PI, u = ((lon / (Math.PI * 2)) % 1 + 1) % 1;
  return { row: Math.max(0, Math.min(GRID_SIZE - 1, Math.round(v * (GRID_SIZE - 1)))),
           col: Math.min(GRID_SIZE - 1, Math.floor(u * GRID_SIZE)) };
};
const grid = generatePlanetGrid(type, seed * 7777, null, null);
const lift = (row: number, col: number) => grid[row][col].elevation >= SEA_LEVEL ? Math.round((grid[row][col].elevation - SEA_LEVEL) * 30 * zoom) : 0;
const g = zoom === 1 ? pgeom : { cx: PW / 2 + (pgeom.cx - PW / 2) * zoom, cyTop: PH / 2 + (pgeom.cyTop - PH / 2) * zoom, rx: pgeom.rx * zoom, ry: pgeom.ry * zoom };
const cloudLift = Math.round(24 * zoom);
const lut = buildWeatherLut(g, project, (row, col) => lift(row, col), zoom === 1 ? {} : { bounds: { w: PW, h: PH, below: cloudLift } });
const c = buildClimate({ grid, planetType: type, seed, lush: 0.5, extinctionPressure: 0.1, oxygenLevel: 0.6, civLevel: 0, inNebula: false });
const sim = new WeatherSim(c); sim.warmUp(WX_WARMUP);
const painter = zoom === 1 ? new WeatherPainter(lut, c, 24, seed)
  : new WeatherPainter(lut, c, cloudLift, seed, { scale: zoom, pmax: 320 * zoom * zoom, area: zoom * zoom });
const img = { width: PW, height: PH, data: new Uint8ClampedArray(PW * PH * 4) };
const shadow = { width: PW, height: PH, data: new Uint8ClampedArray(PW * PH * 4) };
/** PAINT_ONLY=1: the sim is frozen, so only the painter's allocation shows. */
const PAINT_ONLY = !!process.env.PAINT_ONLY;
let acc = 0;
const frame = (dt = 1 / 60) => {
  keepStorm();
  acc += dt;
  while (acc >= WX_DT) { acc -= WX_DT; if (!PAINT_ONLY) sim.step(WX_DT); painter.onStep(sim); }
  painter.prepare(sim, acc / WX_DT, dt);
  img.data.fill(0); shadow.data.fill(0);
  painter.paintShadows(shadow, 0.6, 1);
  painter.paintClouds(img, 0.6, 1);
};
// WX_FORCE=<VX name>: keep one of that storm on the face (stray / alloc with it up).
const forceKind = (VX_NAMES as readonly string[]).indexOf(process.env.WX_FORCE ?? '');
const keepStorm = () => {
  if (forceKind < 0 || sim.events.count(forceKind) > 0) return;
  let hh = 12345;
  const rnd = () => { hh = (Math.imul(hh, 1664525) + 1013904223) | 0; return (hh >>> 0) / 4294967296; };
  const spot = painter.faceSpot(() => true, rnd);
  if (spot) { const v = sim.events.force(sim, forceKind, spot.x, spot.y); if (v) v.age = 10; }
};
if (process.env.STRAY) {
  // weatherCheck's "painter stays on the face + cloud band", for this type/seed.
  const allowed = new Uint8Array(PW * PH);
  for (let n = 0; n < lut.count; n++) {
    const x = lut.px[n];
    const yTop = lut.py[n] - 24 - 4 - CLOUD_TOWER_MAX, yBot = Math.max(lut.py[n], lut.ground[n]) + 1;
    for (let xx = x - 3; xx <= x + 3; xx++) for (let y = yTop; y <= yBot; y++) {
      if (xx >= 0 && y >= 0 && xx < PW && y < PH) allowed[y * PW + xx] = 1;
    }
  }
  let stray = 0;
  for (let f = 0; f < 600; f++) {
    frame();
    for (let k = 0; k < PW * PH; k++) if ((img.data[k * 4 + 3] || shadow.data[k * 4 + 3]) && !allowed[k]) {
      stray++;
      if (process.env.STRAY_LOG && stray <= 12) console.log(`    stray at ${k % PW},${(k / PW) | 0} frame ${f} rgba ${img.data.slice(k * 4, k * 4 + 4).join(',')} shadow ${shadow.data[k * 4 + 3]}`);
    }
  }
  console.log(`  stray pixels: ${stray}`);
  process.exit(0);
}
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc');
for (let f = 0; f < 1000; f++) frame();
let best = Infinity;
for (let w = 0; w < 3; w++) {
  gc(); const h0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  for (let f = 0; f < 1000; f++) frame();
  const ms = (performance.now() - t0) / 1000;
  best = Math.min(best, process.memoryUsage().heapUsed - h0);
  if (w === 2) console.log(`  ${type} seed ${seed} zoom ${zoom}: ${ms.toFixed(2)} ms/frame`);
}
console.log(`  heap +${(best / 1024).toFixed(1)} KB per 1000 frames (limit 64)`);
