/**
 * Paints the weather sim onto the diorama face.
 *
 * Zero allocation per frame: every buffer is created at construction or when
 * the lookup changes. The prototype allocated ~100k small arrays per frame and
 * the frame rate hitched (2026-09-26). tools/weatherCheck measures the heap.
 */
import { CELL_COLS, CELL_ROWS, WX_NX, WX_NY, WX_N, type ClimateSources } from './WeatherClimate';
import { WeatherSim, WX_DT, WK, kindAt, fieldIndex, latOf } from './WeatherSim';

export interface ImageDataLike { width: number; height: number; data: Uint8ClampedArray }

/** Per face pixel: where it is, where its ground is, where it sits in the field. */
export interface WeatherLut {
  count: number;
  px: Int16Array; py: Int16Array;
  /** Terrain-top y on screen: py - lift. */
  ground: Int16Array;
  /** Continuous field coordinates. */
  fx: Float32Array; fy: Float32Array;
  /** Disc x, -1..1, for lighting. */
  dx: Float32Array;
}

export function buildWeatherLut(
  geom: { cx: number; cyTop: number; rx: number; ry: number },
  project: (dx: number, dy: number) => { row: number; col: number } | null,
  groundLift: (row: number, col: number, r: number) => number,
): WeatherLut {
  const px: number[] = [], py: number[] = [], ground: number[] = [];
  const fx: number[] = [], fy: number[] = [], ddx: number[] = [];
  const { cx, cyTop, rx, ry } = geom;
  for (let y = Math.floor(cyTop - ry); y <= Math.ceil(cyTop + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx, dy = (y - cyTop) / ry;
      const r = Math.hypot(dx, dy);
      if (r > 1) continue;
      const gp = project(dx, dy);
      if (!gp) continue;
      px.push(x); py.push(y);
      ground.push(y - groundLift(gp.row, gp.col, r));
      fx.push((gp.col + 0.5) / CELL_COLS - 0.5);
      fy.push((gp.row + 0.5) / CELL_ROWS - 0.5);
      ddx.push(dx);
    }
  }
  return {
    count: px.length,
    px: Int16Array.from(px), py: Int16Array.from(py), ground: Int16Array.from(ground),
    fx: Float32Array.from(fx), fy: Float32Array.from(fy), dx: Float32Array.from(ddx),
  };
}

const LEVEL_ALPHA = [0, 0.5, 0.75, 0.95];
const CLOUD_GAIN = 1.9;
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);
/** body rgb, under rgb — per WK kind. Carried over from the legacy CLOUD_PROFILES. */
const PAL = [
  0, 0, 0, 0, 0, 0,                       // CLEAR (unused)
  252, 252, 255, 150, 176, 212,           // CUMULUS
  128, 134, 150, 48, 54, 70,              // STORM
  230, 244, 252, 160, 196, 224,           // ICE
  110, 100, 96, 42, 36, 36,               // ASH
  168, 146, 112, 86, 72, 56,              // SMOG
];
const ACID = [206, 224, 120, 120, 140, 48];
/** Precipitation kinds: rain, acid rain, snow, ash — the legacy PRECIP_STYLE. */
const P_SPEED = [62, 54, 14, 20];
const P_LEN = [3, 3, 1, 1];
const P_RGBA = [150, 190, 232, 0.55, 190, 222, 105, 0.6, 240, 250, 255, 0.8, 64, 56, 54, 0.75];
const PMAX = 320, FMAX = 8;
/** Steps of fall simulated when a painter first comes up (snow takes ~8). */
const PRIME_STEPS = 8;
/**
 * R4c: was 1.0. The weakest storm seed (99) had a steady-state minimum of 3-27
 * live drops at 1-3. At 8 its minimum is 58 and at 6 it is 43. Stronger storm
 * seeds sit at the PMAX cap (accepted by the ruling). The spawn saturates at one
 * drop per sampled pixel per step.
 */
const RAIN_SPAWN = 8;
/**
 * Per sampled storm pixel per step, and at most one new bolt per onStep.
 * Flashes spawn only in onStep (4 Hz) and live 0.09 s, so flicker is <= 4 Hz;
 * without the cap, 0.02 put several simultaneous bolts up each step (35-146
 * flash spawns per 5 s over 8 storm seeds). With the cap: 3.8-19.9 per 5 s
 * over storm seeds 1/7/42/99/123/256.
 */
const FLASH_CHANCE = 0.02;
/**
 * Density gain per sky kind (indexed by WK: CLEAR, CUMULUS, STORM, ICE, ASH,
 * SMOG). R4a: ICE and ASH were 1 and read blank. Thin polar haze and soot never
 * reached the first step (median drawn: ice 1.2%, carbon 1.1%).
 */
const KIND_GAIN = [1, 1, 1, 2, 2, 1];
/**
 * Extra density gain per unit of climate.nebula, which is 0.35 on crystal worlds
 * and 1 inside a nebula. Nebula is capped at NEBULA_GAIN_CAP first, so a
 * nebula world gets crystal's lift rather than four times the cloud.
 */
const NEBULA_GAIN = 3, NEBULA_GAIN_CAP = 0.35;
const DT_W = 128, DT_H = 64, DT_PER_CELL = 2;

/** Alpha is passed to over() in 1/A_ONE units, as an integer. */
const A_ONE = 4096;
const INV32 = 1 / 4294967296;

/**
 * Source-over one pixel. Every argument is a small integer: a double argument
 * to a call V8 does not inline is boxed, one heap number per call.
 */
function over(d: Uint8ClampedArray, o: number, r: number, g: number, b: number, ai: number): void {
  if (ai <= 0) return;
  const a = ai / A_ONE;
  const ea = d[o + 3] / 255, oa = a + ea * (1 - a);
  d[o] = (r * a + d[o] * ea * (1 - a)) / oa;
  d[o + 1] = (g * a + d[o + 1] * ea * (1 - a)) / oa;
  d[o + 2] = (b * a + d[o + 2] * ea * (1 - a)) / oa;
  d[o + 3] = oa * 255;
}

/**
 * The hot loops inline sampleField, fieldIndex and the detail lookup by hand,
 * and clamp with ternaries: V8's mid tier (Maglev) boxes Math.min/max results,
 * so a frame that runs before TurboFan code is (re)installed made garbage.
 * A helper that takes or returns a double, when V8 declines to inline it (the
 * inlining budget of these long loops runs out), boxes a heap number per call:
 * measured at 7 MB per 1,000 frames for one out-of-line sampleField.
 */
export class WeatherPainter {
  pCount = 0;
  readonly pX = new Float32Array(PMAX);
  readonly pY = new Float32Array(PMAX);
  readonly pGround = new Float32Array(PMAX);
  readonly pSpawn = new Int32Array(PMAX);
  private pPhase = new Float32Array(PMAX);
  private pKind = new Uint8Array(PMAX);
  private fCount = 0;
  private fX = new Float32Array(FMAX);
  private fY = new Float32Array(FMAX);
  private fGround = new Float32Array(FMAX);
  private fLife = new Float32Array(FMAX);
  private fSeed = new Uint32Array(FMAX);
  flashesTotal = 0;
  readonly stats = { drawn: 0, midOrDense: 0 };

  private dens = new Float32Array(WX_N);
  private kind = new Uint8Array(WX_N);
  private shift = new Float32Array(WX_NY);
  /**
   * Polar blend per row, 0 below 55 degrees, 1 from 80. Longitude columns meet
   * at the pole, so any cloud difference between them drew as radial spokes (a
   * pinwheel on every world once the warm-up reached steady state). Density
   * blends toward the row mean and the detail texture toward its mean.
   */
  private poleW = new Float32Array(WX_NY);
  private detMean = 0.5;
  private detail = new Float32Array(DT_W * DT_H);
  /** Nearest field cell of each lookup pixel. Fixed, so computed once. */
  private cell: Int32Array;
  /** Band wind per row, cached per (sim, climate): baseWindU returns a double. */
  private bandU = new Float32Array(WX_NY);
  private bandSim: WeatherSim | null = null;
  private bandClimate: ClimateSources | null = null;
  /** False until the first onStep: a fresh painter over a warm sim primes itself. */
  private primed = false;
  /** LCG state, as int32 in a typed slot so advancing it never leaves int32 or boxes. */
  private rs = new Int32Array(1);

  constructor(
    private lut: WeatherLut, private climate: ClimateSources,
    readonly cloudLift: number, seed: number,
  ) {
    this.rs[0] = (seed | 0) || 1;
    this.cell = new Int32Array(lut.count);
    for (let n = 0; n < lut.count; n++) this.cell[n] = fieldIndex(lut.fx[n], lut.fy[n]);
    this.bakeDetail(seed);
    for (let j = 0; j < WX_NY; j++) {
      const w = (Math.abs(latOf(j)) * 180 / Math.PI - 55) / 25;
      this.poleW[j] = w < 0 ? 0 : w > 1 ? 1 : w;
    }
  }

  setClimate(c: ClimateSources): void { this.climate = c; }

  /** Advance the LCG; the draw is then (this.rs[0] >>> 0) * INV32. */
  private roll(): void {
    this.rs[0] = (Math.imul(this.rs[0], 1664525) + 1013904223) | 0;
  }

  /** Tileable two-octave value noise, isotropic in field space. Construction only. */
  private bakeDetail(seed: number): void {
    const lattice = (x: number, y: number, period: number) => {
      const xi = ((x % period) + period) % period, yi = ((y % period) + period) % period;
      let h = (Math.imul(xi, 374761393) + Math.imul(yi, 668265263) + Math.imul(seed | 0, 97)) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    const octave = (x: number, y: number, cell: number) => {
      const gx = x / cell, gy = y / cell, i = Math.floor(gx), j = Math.floor(gy);
      const tx = gx - i, ty = gy - j, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const pw = DT_W / cell;
      const a = lattice(i, j, pw), b = lattice(i + 1, j, pw), c = lattice(i, j + 1, pw), d = lattice(i + 1, j + 1, pw);
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    };
    let sq = 0;
    for (let y = 0; y < DT_H; y++) for (let x = 0; x < DT_W; x++) {
      const v = 0.65 * octave(x, y, 8) + 0.35 * octave(x, y, 4);
      this.detail[y * DT_W + x] = v;
      sq += v * v;
    }
    // RMS, so dens * (0.2 + 1.6 det^2) keeps its mean where detail is faded out.
    this.detMean = Math.sqrt(sq / (DT_W * DT_H));
  }

  private spawn(n: number, kind: number): void {
    const q = this.pCount++;
    this.pX[q] = this.lut.px[n];
    this.pY[q] = this.lut.py[n] - this.cloudLift + 2;
    this.pGround[q] = this.lut.ground[n];
    this.pSpawn[q] = n;
    this.roll();
    this.pPhase[q] = (this.rs[0] >>> 0) * INV32 * 6.28;
    this.pKind[q] = kind;
    // A particle already at or below its ground dies on the next prepare().
  }

  /** Once per sim step: spawn precipitation and lightning from the new state. */
  onStep(sim: WeatherSim): void {
    this.primed = true;
    const lut = this.lut, cell = this.cell, rs = this.rs;
    const stride = 29;
    // At most one new bolt per step: several at once read as a strobe.
    let flashed = false;
    this.roll();
    for (let n = Math.floor((rs[0] >>> 0) * INV32 * stride); n < lut.count; n += stride) {
      const k = cell[n];
      const p = sim.precip[k];
      if (p > 0.004 && this.pCount < PMAX) {
        this.roll();
        if ((rs[0] >>> 0) * INV32 < p * RAIN_SPAWN * stride / 4) {
          this.spawn(n, sim.snow[k] ? 2 : this.climate.acid > 0.5 ? 1 : 0);
        }
      }
      if (sim.ash[k] > 0.35 && this.pCount < PMAX) {
        this.roll();
        if ((rs[0] >>> 0) * INV32 < 0.05) this.spawn(n, 3);
      }
      if (!flashed && this.fCount < FMAX && (kindAt(sim, k) === WK.STORM || sim.ash[k] > 0.7)) {
        this.roll();
        if ((rs[0] >>> 0) * INV32 < FLASH_CHANCE) {
          const f = this.fCount++;
          this.fX[f] = lut.px[n]; this.fY[f] = lut.py[n] - this.cloudLift;
          this.fGround[f] = lut.ground[n]; this.fLife[f] = 0.09;
          this.roll();
          this.fSeed[f] = rs[0] >>> 0;
          this.flashesTotal++;
          flashed = true;
        }
      }
    }
  }

  /** Once per frame, before painting: interpolate the field, move particles. */
  prepare(sim: WeatherSim, t: number, dt: number): void {
    const neb = this.climate.nebula, nebGain = 1 + NEBULA_GAIN * (neb < NEBULA_GAIN_CAP ? neb : NEBULA_GAIN_CAP);
    if (!this.primed) {
      // The painter came up over a sky that is already raining (a new world
      // view, a warm sim): spawn PRIME_STEPS steps' worth, each batch aged by
      // its step, so the first frame shows the steady fall rather than an empty
      // sky. Particles aged past their ground die in the loop below. Bolts from
      // the prime are dropped: eight at once on frame 0 would be a flashbulb.
      const f0 = this.fCount, ft0 = this.flashesTotal;
      for (let b = 0; b < PRIME_STEPS; b++) {
        const first = this.pCount;
        this.onStep(sim);
        for (let q = first; q < this.pCount; q++) {
          this.roll();
          this.pY[q] += P_SPEED[this.pKind[q]] * WX_DT * (b + (this.rs[0] >>> 0) * INV32);
        }
      }
      this.fCount = f0; this.flashesTotal = ft0;
    }
    const simTime = sim.time - (1 - t) * WX_DT;
    for (let k = 0; k < WX_N; k++) {
      const c = sim.prevCloud[k] + (sim.cloud[k] - sim.prevCloud[k]) * t;
      const a = sim.prevAsh[k] + (sim.ash[k] - sim.prevAsh[k]) * t;
      const s = sim.prevSmog[k] + (sim.smog[k] - sim.prevSmog[k]) * t;
      const kind = kindAt(sim, k);
      this.kind[k] = kind;
      // Cloud gain 1.9 (was 1.5): the shower cycle rains more water out, so the
      // mean cloud field is thinner and ocean skies fell under the readability floor.
      this.dens[k] = (c * CLOUD_GAIN + a * 0.9 + s * 0.8) * KIND_GAIN[kind] * nebGain;
    }
    for (let j = 0; j < WX_NY; j++) {
      const w = this.poleW[j];
      if (w === 0) continue;
      let m = 0;
      for (let i = 0; i < WX_NX; i++) m += this.dens[j * WX_NX + i];
      m /= WX_NX;
      for (let i = 0; i < WX_NX; i++) { const k = j * WX_NX + i; this.dens[k] += (m - this.dens[k]) * w; }
    }
    if (sim !== this.bandSim || sim.climate !== this.bandClimate) {
      for (let j = 0; j < WX_NY; j++) this.bandU[j] = sim.baseWindU(j);
      this.bandSim = sim; this.bandClimate = sim.climate;
    }
    for (let j = 0; j < WX_NY; j++) this.shift[j] = this.bandU[j] * simTime;
    for (let q = this.pCount - 1; q >= 0; q--) {
      const kind = this.pKind[q];
      this.pY[q] += P_SPEED[kind] * dt;
      this.pPhase[q] += dt * 2.2;
      if (this.pY[q] >= this.pGround[q]) {
        const last = --this.pCount;
        this.pX[q] = this.pX[last]; this.pY[q] = this.pY[last]; this.pGround[q] = this.pGround[last];
        this.pSpawn[q] = this.pSpawn[last]; this.pPhase[q] = this.pPhase[last]; this.pKind[q] = this.pKind[last];
      }
    }
    for (let f = this.fCount - 1; f >= 0; f--) {
      this.fLife[f] -= dt;
      if (this.fLife[f] <= 0) {
        const last = --this.fCount;
        this.fX[f] = this.fX[last]; this.fY[f] = this.fY[last]; this.fGround[f] = this.fGround[last];
        this.fLife[f] = this.fLife[last]; this.fSeed[f] = this.fSeed[last];
      }
    }
  }

  /** Cloud shadows on the terrain, into the day/night image. Day side only. */
  paintShadows(img: ImageDataLike, sunAzimuth: number, intensity: number): void {
    const lut = this.lut, d = img.data, w = img.width, h = img.height, den = this.dens;
    const sunX = Math.cos(sunAzimuth);
    for (let n = 0; n < lut.count; n++) {
      const rawLit = 0.5 + lut.dx[n] * sunX;
      const lit = rawLit < 0 ? 0 : rawLit > 1 ? 1 : rawLit;
      if (lit <= 0.3) continue;
      // sampleField(dens, fx - sunX * 0.9, fy), inlined.
      const sx = lut.fx[n] - sunX * 0.9, sy = lut.fy[n];
      const i0 = Math.floor(sx), j0 = Math.floor(sy), tx = sx - i0, ty = sy - j0;
      const a = ((i0 % WX_NX) + WX_NX) % WX_NX, b = (a + 1) % WX_NX;
      const r0 = (j0 < 0 ? 0 : j0 > WX_NY - 1 ? WX_NY - 1 : j0) * WX_NX;
      const r1 = (j0 + 1 < 0 ? 0 : j0 + 1 > WX_NY - 1 ? WX_NY - 1 : j0 + 1) * WX_NX;
      const dd = (den[r0 + a] * (1 - tx) * (1 - ty) + den[r0 + b] * tx * (1 - ty)
                + den[r1 + a] * (1 - tx) * ty + den[r1 + b] * tx * ty) * 0.8;
      if (dd <= 0.3) continue;
      const x = lut.px[n], y = lut.ground[n];
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      over(d, (y * w + x) * 4, 10, 14, 30, (0.22 * (dd < 1 ? dd : 1) * lit * intensity * A_ONE) | 0);
    }
  }

  /** Precipitation, then cloud, then lightning. */
  paintClouds(img: ImageDataLike, sunAzimuth: number, intensity: number): void {
    const lut = this.lut, d = img.data, w = img.width, h = img.height;
    const sunX = Math.cos(sunAzimuth);
    this.stats.drawn = 0; this.stats.midOrDense = 0;

    for (let q = 0; q < this.pCount; q++) {
      const kind = this.pKind[q];
      const drift = kind >= 2 ? Math.sin(this.pPhase[q]) * 1.5 : 0;
      const x = Math.round(this.pX[q] + drift), y0 = Math.round(this.pY[q]);
      const o4 = kind * 4;
      const ai = (P_RGBA[o4 + 3] * intensity * A_ONE) | 0;
      for (let l = 0; l < P_LEN[kind]; l++) {
        const y = y0 + l;
        if (x < 0 || y < 0 || x >= w || y >= h || y > this.pGround[q]) continue;
        over(d, (y * w + x) * 4, P_RGBA[o4], P_RGBA[o4 + 1], P_RGBA[o4 + 2], ai);
      }
    }

    const acid = this.climate.acid, neb = this.climate.nebula;
    const den = this.dens, tex = this.detail, shift = this.shift;
    const off = this.climate.personality.detailOffset;
    for (let n = 0; n < lut.count; n++) {
      const x = lut.px[n], y = lut.py[n] - this.cloudLift;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const fx = lut.fx[n], fy = lut.fy[n];

      // Detail texture, sheared per row by the band wind so it rides with the weather.
      const jr = fy < 0 ? 0 : fy > WX_NY - 1 ? WX_NY - 1 : Math.round(fy);
      const dtx = (fx - shift[jr] + off) * DT_PER_CELL, dty = fy * DT_PER_CELL;
      const di0 = Math.floor(dtx), dj0 = Math.floor(dty), dfx = dtx - di0, dfy = dty - dj0;
      const da = ((di0 % DT_W) + DT_W) % DT_W, db = (da + 1) % DT_W;
      const dr0 = (((dj0 % DT_H) + DT_H) % DT_H) * DT_W, dr1 = (((dj0 + 1) % DT_H + DT_H) % DT_H) * DT_W;
      const det = tex[dr0 + da] * (1 - dfx) * (1 - dfy) + tex[dr0 + db] * dfx * (1 - dfy)
                + tex[dr1 + da] * (1 - dfx) * dfy + tex[dr1 + db] * dfx * dfy;

      // sampleField(dens, fx, fy), inlined.
      let i0 = Math.floor(fx), j0 = Math.floor(fy), tx = fx - i0, ty = fy - j0;
      let a = ((i0 % WX_NX) + WX_NX) % WX_NX, b = (a + 1) % WX_NX;
      let r0 = (j0 < 0 ? 0 : j0 > WX_NY - 1 ? WX_NY - 1 : j0) * WX_NX;
      let r1 = (j0 + 1 < 0 ? 0 : j0 + 1 > WX_NY - 1 ? WX_NY - 1 : j0 + 1) * WX_NX;
      const dens = den[r0 + a] * (1 - tx) * (1 - ty) + den[r0 + b] * tx * (1 - ty)
                 + den[r1 + a] * (1 - tx) * ty + den[r1 + b] * tx * ty;
      const pw = this.poleW[jr], dEff = det + (this.detMean - det) * pw;
      const dd = dens * (0.2 + 1.6 * dEff * dEff);
      if (dd < 0.34) continue;
      const bay = BAYER4[(y & 3) * 4 + (x & 3)];
      const lv = (dd > 0.39 ? 1 : (dd - 0.34) / 0.05 > bay ? 1 : 0)
               + (dd > 0.54 ? 1 : dd > 0.5 && (dd - 0.5) / 0.04 > bay ? 1 : 0)
               + (dd > 0.74 ? 1 : dd > 0.7 && (dd - 0.7) / 0.04 > bay ? 1 : 0);
      if (lv === 0) continue;
      this.stats.drawn++;
      if (lv >= 2) this.stats.midOrDense++;
      // R5: the kind (and so the palette) is picked from the four surrounding
      // cells by ordered dither on the bilinear weights. The nearest cell's kind
      // switched cumulus/storm colour along cell edges, in rectangles.
      const kind = this.kind[(ty > BAYER4[(x & 3) * 4 + (y & 3)] ? r1 : r0) + (tx > bay ? b : a)];

      // sampleField(dens, fx + sunX * 0.35, fy - 0.15), inlined: a thinner
      // sunward neighbour makes this pixel a lit cloud top. R5: compared against
      // this pixel's own smoothed density, not the nearest cell's raw cloud —
      // that flipped shading at every cell edge (rectangles) and, over a lone
      // ash plume with no cloud, never lit anything.
      const sx = fx + sunX * 0.35, sy = fy - 0.15;
      i0 = Math.floor(sx); j0 = Math.floor(sy); tx = sx - i0; ty = sy - j0;
      a = ((i0 % WX_NX) + WX_NX) % WX_NX; b = (a + 1) % WX_NX;
      r0 = (j0 < 0 ? 0 : j0 > WX_NY - 1 ? WX_NY - 1 : j0) * WX_NX;
      r1 = (j0 + 1 < 0 ? 0 : j0 + 1 > WX_NY - 1 ? WX_NY - 1 : j0 + 1) * WX_NX;
      const sunward = den[r0 + a] * (1 - tx) * (1 - ty) + den[r0 + b] * tx * (1 - ty)
                    + den[r1 + a] * (1 - tx) * ty + den[r1 + b] * tx * ty;
      const facing = sunward < dens;

      let o = kind * 6 + (facing ? 0 : 3);
      let r = PAL[o], g = PAL[o + 1], bl = PAL[o + 2];
      if (acid > 0 && (kind === WK.CUMULUS || kind === WK.STORM)) {
        o = facing ? 0 : 3;
        r += (ACID[o] - r) * acid; g += (ACID[o + 1] - g) * acid; bl += (ACID[o + 2] - bl) * acid;
      }
      const rawLit = 0.5 + lut.dx[n] * sunX;
      const lit = 0.35 + 0.65 * (rawLit < 0 ? 0 : rawLit > 1 ? 1 : rawLit);
      r *= lit; g *= lit; bl *= lit;
      if (neb > 0 && facing && kind === WK.CUMULUS) { r += 40 * neb; g += 10 * neb; bl += 60 * neb; }
      over(d, (y * w + x) * 4, r | 0, g | 0, bl | 0, (LEVEL_ALPHA[lv] * intensity * A_ONE) | 0);
    }

    for (let f = 0; f < this.fCount; f++) {
      let s = this.fSeed[f], bx = this.fX[f];
      const x0 = this.fX[f];
      const bolt = (0.95 * intensity * A_ONE) | 0, halo = 0.35 * intensity * A_ONE;
      for (let y = Math.round(this.fY[f]); y < this.fGround[f]; y++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const r = s * INV32;
        if (r < 0.15) bx--; else if (r > 0.85) bx++;
        if (bx < x0 - 3) bx = x0 - 3; else if (bx > x0 + 3) bx = x0 + 3;
        if (bx >= 0 && y >= 0 && bx < w && y < h) over(d, (y * w + bx) * 4, 255, 255, 230, bolt);
      }
      const fy = Math.round(this.fY[f]);
      for (let oy = -3; oy <= 3; oy++) for (let ox = -3; ox <= 3; ox++) {
        const x = x0 + ox, y = fy + oy;
        const fall = 1 - Math.sqrt(ox * ox + oy * oy) / 3;
        if (fall <= 0 || x < 0 || y < 0 || x >= w || y >= h) continue;
        over(d, (y * w + x) * 4, 230, 235, 255, (halo * fall) | 0);
      }
    }
  }
}
