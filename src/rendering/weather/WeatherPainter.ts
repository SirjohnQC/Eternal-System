/**
 * Paints the weather sim onto the diorama face.
 *
 * Zero allocation per frame: every buffer is created at construction or when
 * the lookup changes. The prototype allocated ~100k small arrays per frame and
 * the frame rate hitched (2026-09-26). tools/weatherCheck measures the heap.
 */
import { CELL_COLS, CELL_ROWS, WX_NX, WX_NY, WX_N, type ClimateSources } from './WeatherClimate';
import { WeatherSim, WX_DT, WK, kindAt, fieldIndex, latOf } from './WeatherSim';
import { ELEV_LIGHT } from '../sky/SunLight';

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
  /** Disc y, -1..1 (screen-down / near-front is +1). Used for perspective cloud lift. */
  dy: Float32Array;
  /** Nearest field cell of each entry (`fieldIndex(fx, fy)`); computed by the builder. */
  cell?: Int32Array;
}

/**
 * Options for a camera layer set's lookup (zoom camera). The identity lookup
 * passes none and is built exactly as before zoom.
 */
export interface WeatherLutOpts {
  /**
   * Clamp to the view: x in [0, w - 1], y in [0, h - 1 + below]. `below` is the
   * cloud lift: a face row under the canvas still puts its cloud (lifted by
   * that much) into view. Everything else is invisible, so the lookup holds at
   * most w * (h + below) entries whatever the zoom.
   */
  bounds?: { w: number; h: number; below: number };
  /**
   * Fractional grid position (discToGridF): field coordinates follow the pixel
   * continuously instead of snapping to the nearest planet cell's centre, so
   * cloud edges do not stair-step per planet cell at zoom (Ruling 3).
   */
  projectF?: (dx: number, dy: number) => { row: number; col: number } | null;
}

export function buildWeatherLut(
  geom: { cx: number; cyTop: number; rx: number; ry: number },
  project: (dx: number, dy: number) => { row: number; col: number } | null,
  groundLift: (row: number, col: number, r: number, dx: number, dy: number) => number,
  opts: WeatherLutOpts = {},
): WeatherLut {
  const steps = weatherLutSteps(geom, project, groundLift, opts);
  for (;;) { const r = steps.next(); if (r.done) return r.value; }
}

/**
 * {@link buildWeatherLut}, sliced (spec 5b): yields after every row. A cheap
 * first pass counts the face pixels, so the entries go straight into typed
 * arrays of that size (no per-bake scratch the size of the scanned box); rows
 * ascend and x ascends within a row (the painters index rows by that).
 */
export function* weatherLutSteps(
  geom: { cx: number; cyTop: number; rx: number; ry: number },
  project: (dx: number, dy: number) => { row: number; col: number } | null,
  groundLift: (row: number, col: number, r: number, dx: number, dy: number) => number,
  opts: WeatherLutOpts = {},
): Generator<void, WeatherLut, void> {
  const { cx, cyTop, rx, ry } = geom;
  let yA = Math.floor(cyTop - ry), yB = Math.ceil(cyTop + ry);
  let xA = Math.floor(cx - rx), xB = Math.ceil(cx + rx);
  const bd = opts.bounds;
  if (bd) {
    yA = Math.max(yA, 0); yB = Math.min(yB, bd.h - 1 + Math.ceil(bd.below));
    xA = Math.max(xA, 0); xB = Math.min(xB, bd.w - 1);
  }
  // Pass 1: the face pixels in the box (the same test as below; `project`
  // can only drop more, which the trim at the end handles).
  let cap = 0;
  for (let y = yA; y <= yB; y++) {
    const dy = (y - cyTop) / ry;
    for (let x = xA; x <= xB; x++) if (Math.hypot((x - cx) / rx, dy) <= 1) cap++;
    if ((y & 15) === 15) yield;
  }
  const px = new Int16Array(cap), py = new Int16Array(cap), ground = new Int16Array(cap);
  const fx = new Float32Array(cap), fy = new Float32Array(cap);
  const ddx = new Float32Array(cap), ddy = new Float32Array(cap);
  const cell = new Int32Array(cap);
  let n = 0;
  const projectF = opts.projectF;
  for (let y = yA; y <= yB; y++) {
    for (let x = xA; x <= xB; x++) {
      const dx = (x - cx) / rx, dy = (y - cyTop) / ry;
      const r = Math.hypot(dx, dy);
      if (r > 1) continue;
      const gp = project(dx, dy);
      if (!gp) continue;
      const gf = projectF ? projectF(dx, dy) : null;
      px[n] = x; py[n] = y;
      ground[n] = y - groundLift(gp.row, gp.col, r, dx, dy);
      if (gf) {
        // Cell j's centre is at col j + 0.5 and cell i's at row i (discToGridF),
        // so at a cell centre this equals the snapped value below.
        fx[n] = gf.col / CELL_COLS - 0.5;
        fy[n] = (gf.row + 0.5) / CELL_ROWS - 0.5;
      } else {
        fx[n] = (gp.col + 0.5) / CELL_COLS - 0.5;
        fy[n] = (gp.row + 0.5) / CELL_ROWS - 0.5;
      }
      ddx[n] = dx; ddy[n] = dy;
      cell[n] = fieldIndex(fx[n], fy[n]);
      n++;
    }
    yield;
  }
  if (n === cap) return { count: n, px, py, ground, fx, fy, dx: ddx, dy: ddy, cell };
  return {
    count: n,
    px: px.slice(0, n), py: py.slice(0, n), ground: ground.slice(0, n),
    fx: fx.slice(0, n), fy: fy.slice(0, n), dx: ddx.slice(0, n), dy: ddy.slice(0, n),
    cell: cell.slice(0, n),
  };
}

/** Minimum float above local terrain when perspective lift is small (near rim). */
const CLOUD_CLEARANCE = 6;

/** Sheer table: the close-up, where the ground under a cloud should still read. */
const LEVEL_ALPHA = [0, 0.5, 0.75, 0.95];
/** Planet view and every zoom short of the last. Clouds read as a cover, not a haze. */
const LEVEL_ALPHA_FAR = [0, 0.86, 0.95, 1];
/** Matches ZoomController's max. The sheer table eases in over the last of the zoom. */
const ZOOM_FULL = 4;

function cloudLevelAlpha(zoom: number): Float32Array {
  const out = new Float32Array(4);
  const span = zoom <= 1 ? 0 : zoom >= ZOOM_FULL ? 1 : (zoom - 1) / (ZOOM_FULL - 1);
  const fade = span < 0.82 ? 0 : (span - 0.82) / 0.18;
  for (let i = 0; i < 4; i++) {
    out[i] = LEVEL_ALPHA_FAR[i] * (1 - fade) + LEVEL_ALPHA[i] * fade;
  }
  return out;
}
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
  214, 220, 230, 132, 146, 168,           // STRATUS
  248, 250, 255, 196, 210, 228,           // CIRRUS
  255, 255, 250, 176, 198, 224,           // CAP
];
const ACID = [206, 224, 120, 120, 140, 48];
/** Precipitation kinds: rain, acid rain, snow, ash — the legacy PRECIP_STYLE. */
const P_SPEED = [48, 42, 14, 20];
const P_LEN = [4, 4, 1, 1];
const P_RGBA = [150, 190, 232, 0.55, 190, 222, 105, 0.6, 240, 250, 255, 0.8, 64, 56, 54, 0.75];
const PMAX = 320, FMAX = 8;
/**
 * Minimum cloud→ground travel for rain/acid (base px, × scale). Perspective
 * lift parks the near-rim cloud only ~6 px above the face — drops lived
 * ~2–4 frames and read as blink. Far-rim already clears this.
 */
const MIN_RAIN_FALL = 22;
/** Live-particle cap of an identity painter; a camera painter scales it with its lookup. */
export const WEATHER_PMAX = PMAX;

/**
 * Zoom camera (k = camera zoom). World-class sizes of a camera layer set's
 * painter: fall speeds, snow/ash sway, the spawn drop below the cloud base,
 * the flash halo radius and the bolt's wander are world distances (x k). Rain
 * streak length and every 1-px stroke stay (P_LEN, bolt width). Spawn and
 * flash chances stay per sampled SCREEN pixel, so a zoomed storm keeps its
 * on-screen density (Ruling 4); `pmax` lets the particle cap grow with the
 * lookup so that density is not clipped by the identity cap.
 */
export interface WeatherPainterOpts {
  scale?: number;
  pmax?: number;
  /**
   * Visible screen area of this painter's lookup relative to the identity
   * lookup (camera painter: camera lookup count / identity count). The
   * one-new-bolt-per-step flicker cap and the live-bolt cap FMAX scale with it,
   * so lightning keeps its density per screen area (Ruling 4); the identity
   * cap would otherwise make a zoomed storm ~area-times sparser. Default 1.
   */
  area?: number;
  /**
   * TEST HOOK (tools/zoomCheck control only): multiplies the streak length
   * P_LEN. Rain streaks are a 1-px stroke class and never scale in the game.
   */
  streakScale?: number;
  /**
   * Added to a lookup pixel's x / y before the ordered-dither lookup (spec 5b).
   * A camera set passes its bake origin in world-anchored screen px, so two
   * sets of the same zoom dither a cloud at a world point identically and a
   * re-centre swap shows no dither change. Default 0 (identity).
   */
  ditherX?: number;
  ditherY?: number;
}
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
 * SMOG, STRATUS, CIRRUS, CAP). R4a: ICE and ASH were 1 and read blank. Thin polar haze and soot never
 * reached the first step (median drawn: ice 1.2%, carbon 1.1%).
 */
const KIND_GAIN = [1, 1, 1, 2, 2, 1, 1, 0.85, 1.15];
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
  readonly pX: Float32Array;
  readonly pY: Float32Array;
  readonly pGround: Float32Array;
  readonly pSpawn: Int32Array;
  /** Per-drop fall speed (kind base × jitter). Public so zoom checks can pin a base speed. */
  readonly pVel: Float32Array;
  private pPhase: Float32Array;
  private pKind: Uint8Array;
  /** Particle cap: WEATHER_PMAX, or the camera painter's scaled cap. */
  readonly pmax: number;
  /** P_SPEED x scale, per kind (no per-drop jitter). */
  readonly pSpeed = new Float64Array(4);
  /** World-class sizes x scale: [snow/ash sway, spawn drop below the cloud base]. */
  private tune = new Float64Array(2);
  /** Min rain/acid fall distance (MIN_RAIN_FALL × scale). */
  private minRainFall = MIN_RAIN_FALL;
  /** Flash halo radius and bolt wander clamp, px (3 x scale, whole px). */
  private haloR = 3;
  private wander = 3;
  private fCount = 0;
  private fX: Float32Array;
  private fY: Float32Array;
  private fGround: Float32Array;
  private fLife: Float32Array;
  private fSeed: Uint32Array;
  /** Live-bolt cap (FMAX x area) and new bolts per step (1 x area, whole). */
  readonly fmax: number;
  readonly boltsPerStep: number;
  /** Streak length per kind (P_LEN; x streakScale in the test control only). */
  private pLen = new Int32Array(4);
  flashesTotal = 0;
  readonly stats = { drawn: 0, midOrDense: 0 };

  private dens = new Float32Array(WX_N);
  private kind = new Uint8Array(WX_N);
  private shift = new Float32Array(WX_NY);
  /**
   * Polar weight per row, 0 below 55°, 1 from 80°. Longitude columns meet at
   * the pole, so cell-scale cloud differences drew as radial spokes (a
   * pinwheel). Density is longitudinally box-blurred by this weight — enough
   * to kill spokes while leaving traveling masses that still rotate through
   * the disc's N/S tips (the diorama's front and back rim). Detail texture is
   * NOT faded: its wind shear is what keeps polar cloud reading as in motion.
   */
  private poleW = new Float32Array(WX_NY);
  /** Scratch for one weather row during the polar longitudinal blur. */
  private poleScratch = new Float32Array(WX_NX);
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
  /**
   * Lookup px -> screen (spec 5b): screen = lookup * vr + (vdx, vdy). Identity
   * (1, 0, 0) unless the host draws an overscanned camera set through a live
   * camera (`setView`). Whole offsets at ratio 1.
   */
  private vr = 1;
  private vdx = 0;
  private vdy = 0;
  private readonly ditherX: number;
  private readonly ditherY: number;
  /** First lookup row and the entry index each row starts at (rows ascend), for view-bounded loops. */
  private readonly rowY0: number;
  private readonly rowStart: Int32Array;
  /**
   * Screen y of the cloud base per lookup entry. Perspective lift: full
   * `cloudLift` at the far/back rim (dy → -1, into the dome), only local
   * terrain clearance at the near/front rim (dy → +1). Uniform `py - cloudLift`
   * left a cloudLift-tall empty strip at the front of the disc.
   */
  readonly skyY: Int16Array;
  /**
   * Vertical coverage in lookup px: how many screen rows this sample stamps,
   * from skyY down toward the next face row's skyY at the same x. Perspective
   * stretch makes d(skyY)/d(py) > 1 toward the far rim; without this fill those
   * skipped rows read as horizontal scanlines.
   */
  readonly skyH: Int16Array;
  /** Entries visited by the last paintClouds / paintShadows (bounded-work checks). */
  readonly visited = { clouds: 0, shadows: 0 };
  /** Per density step. Far views use the solid table; full zoom eases back to sheer. */
  private readonly levelAlpha: Float32Array;

  constructor(
    private lut: WeatherLut, private climate: ClimateSources,
    readonly cloudLift: number, seed: number,
    opts: WeatherPainterOpts = {},
  ) {
    const k = opts.scale ?? 1;
    this.levelAlpha = cloudLevelAlpha(k);
    const pmax = this.pmax = Math.max(PMAX, Math.ceil(opts.pmax ?? PMAX));
    this.pX = new Float32Array(pmax); this.pY = new Float32Array(pmax);
    this.pGround = new Float32Array(pmax); this.pSpawn = new Int32Array(pmax);
    this.pVel = new Float32Array(pmax);
    this.pPhase = new Float32Array(pmax); this.pKind = new Uint8Array(pmax);
    const area = Math.max(1, opts.area ?? 1);
    const fmax = this.fmax = Math.max(FMAX, Math.ceil(FMAX * area));
    this.boltsPerStep = Math.max(1, Math.round(area));
    this.fX = new Float32Array(fmax); this.fY = new Float32Array(fmax);
    this.fGround = new Float32Array(fmax); this.fLife = new Float32Array(fmax);
    this.fSeed = new Uint32Array(fmax);
    for (let i = 0; i < 4; i++) this.pLen[i] = Math.max(1, Math.round(P_LEN[i] * (opts.streakScale ?? 1)));
    for (let i = 0; i < 4; i++) this.pSpeed[i] = P_SPEED[i] * k;
    this.tune[0] = 1.5 * k; this.tune[1] = 2 * k;
    this.minRainFall = Math.max(1, Math.round(MIN_RAIN_FALL * k));
    this.haloR = Math.max(1, Math.round(3 * k));
    this.wander = Math.max(1, Math.round(3 * k));
    this.rs[0] = (seed | 0) || 1;
    this.ditherX = opts.ditherX ?? 0;
    this.ditherY = opts.ditherY ?? 0;
    if (lut.cell && lut.cell.length === lut.count) {
      this.cell = lut.cell;
    } else {
      this.cell = new Int32Array(lut.count);
      for (let n = 0; n < lut.count; n++) this.cell[n] = fieldIndex(lut.fx[n], lut.fy[n]);
    }
    // Row index: entries are row-major with ascending rows (buildWeatherLut).
    const y0 = lut.count ? lut.py[0] : 0, y1 = lut.count ? lut.py[lut.count - 1] : -1;
    this.rowY0 = y0;
    this.rowStart = new Int32Array(Math.max(0, y1 - y0 + 1) + 1);
    for (let n = 0, row = 0; row <= y1 - y0 + 1; row++) {
      while (n < lut.count && lut.py[n] < y0 + row) n++;
      this.rowStart[row] = n;
    }
    // Bake perspective cloud altitude once (lut + cloudLift are fixed here).
    const clearance = Math.max(1, Math.round(CLOUD_CLEARANCE * k));
    this.skyY = new Int16Array(lut.count);
    this.skyH = new Int16Array(lut.count);
    const dys = lut.dy;
    for (let n = 0; n < lut.count; n++) {
      // dy +1 = near/front, -1 = far/back. Rise into the dome only toward the back.
      const dy = dys ? dys[n] : 0;
      const perspective = this.cloudLift * 0.5 * (1 - dy);
      const local = (lut.py[n] - lut.ground[n]) + clearance;
      const lift = perspective > local ? perspective : local;
      this.skyY[n] = Math.round(lut.py[n] - (lift < 1 ? 1 : lift));
    }
    // Vertical fill to the next face row at the same x (row-major, ascending py).
    // Perspective makes skyY advance faster than py toward the far rim; stamping
    // only skyY left empty screen rows (venetian blinds). Cap the run so a
    // missing neighbour cannot paint a tall spike.
    const sky = this.skyY, skyH = this.skyH, lpx = lut.px, lpy = lut.py;
    const row0 = this.rowY0, rows = this.rowStart, nRows = rows.length - 1;
    const maxH = Math.max(1, Math.ceil(this.cloudLift / 4) + 2);
    for (let n = 0; n < lut.count; n++) {
      const x = lpx[n], faceY = lpy[n];
      const ri = faceY + 1 - row0;
      let h = 1;
      if (ri >= 0 && ri < nRows) {
        let a = rows[ri], b = rows[ri + 1];
        while (a < b) { const m = (a + b) >> 1; if (lpx[m] < x) a = m + 1; else b = m; }
        if (a < rows[ri + 1] && lpx[a] === x) {
          const gap = sky[a] - sky[n];
          if (gap > 1) h = gap < maxH ? gap : maxH;
        }
      }
      skyH[n] = h;
    }
    this.bakeDetail(seed);
    for (let j = 0; j < WX_NY; j++) {
      const w = (Math.abs(latOf(j)) * 180 / Math.PI - 55) / 25;
      this.poleW[j] = w < 0 ? 0 : w > 1 ? 1 : w;
    }
  }

  setClimate(c: ClimateSources): void { this.climate = c; }

  /**
   * Draw through a view (spec 5b): lookup px (x, y) lands on screen at
   * (x * r + dx, y * r + dy). At r = 1 pass whole offsets (a pan); r != 1 is a
   * wheel in progress, drawn nearest-neighbour. Allocation-free.
   */
  setView(r: number, dx: number, dy: number): void {
    this.vr = r; this.vdx = dx; this.vdy = dy;
  }

  /**
   * Take over another painter's live drops and bolts (a re-centre swap at the
   * same zoom, spec 5b): positions shift by (dx, dy) lookup px, the new
   * lookup's frame. The sky keeps falling across the swap instead of
   * re-priming. Construction-time sized arrays; nothing allocates.
   */
  adopt(from: WeatherPainter, dx: number, dy: number): void {
    const n = Math.min(from.pCount, this.pmax);
    for (let q = 0; q < n; q++) {
      this.pX[q] = from.pX[q] + dx; this.pY[q] = from.pY[q] + dy; this.pGround[q] = from.pGround[q] + dy;
      this.pSpawn[q] = 0; this.pVel[q] = from.pVel[q];
      this.pPhase[q] = from.pPhase[q]; this.pKind[q] = from.pKind[q];
    }
    this.pCount = n;
    const f = Math.min(from.fCount, this.fmax);
    for (let i = 0; i < f; i++) {
      this.fX[i] = from.fX[i] + dx; this.fY[i] = from.fY[i] + dy; this.fGround[i] = from.fGround[i] + dy;
      this.fLife[i] = from.fLife[i]; this.fSeed[i] = from.fSeed[i];
    }
    this.fCount = f;
    this.primed = from.primed;
    this.rs[0] = from.rs[0];
    this.flashesTotal = from.flashesTotal;
  }

  /** Index range [first, end) of the lookup rows y0..y1 (clamped). */
  private rowFirst(y: number): number {
    const rows = this.rowStart.length - 1;
    const i = y - this.rowY0;
    return this.rowStart[i < 0 ? 0 : i > rows ? rows : i];
  }

  /** First entry in [a, b) of one row whose px >= x (binary search). */
  private firstX(a: number, b: number, x: number): number {
    const px = this.lut.px;
    while (a < b) { const m = (a + b) >> 1; if (px[m] < x) a = m + 1; else b = m; }
    return a;
  }

  /**
   * Drop every live drop and bolt and prime again from `sim` at once, as a
   * fresh painter would. For a painter that was frozen while another one was
   * shown (the zoom camera's identity painter): its particles belong to a sky
   * that has since moved on, and would show as stale drops for ~0.3 s.
   */
  reprime(sim: WeatherSim, t: number): void {
    this.pCount = 0;
    this.fCount = 0;
    this.primed = false;
    this.prepare(sim, t, 0);
  }

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
    for (let y = 0; y < DT_H; y++) for (let x = 0; x < DT_W; x++) {
      this.detail[y * DT_W + x] = 0.65 * octave(x, y, 8) + 0.35 * octave(x, y, 4);
    }
  }

  private spawn(n: number, kind: number): void {
    const q = this.pCount++;
    const rs = this.rs;
    // Break the LUT pixel lattice: integer px/py + identical kind speeds read as
    // marching curtains. Sub-pixel x jitter + per-drop speed (static — no
    // per-frame x sway on rain, which strobed 1-px columns).
    this.roll();
    const jx = ((rs[0] >>> 0) * INV32 - 0.5) * 2.4;
    this.roll();
    const jy = ((rs[0] >>> 0) * INV32) * 1.8;
    this.roll();
    const jv = 0.88 + (rs[0] >>> 0) * INV32 * 0.24; // ~0.88–1.12× (milder than before)
    const ground = this.lut.ground[n];
    let y = this.skyY[n] + this.tune[1] + jy;
    // Rain/acid: guarantee a readable fall even under near-rim perspective lift.
    if (kind <= 1) {
      const minTop = ground - this.minRainFall;
      if (y > minTop) y = minTop;
    }
    this.pX[q] = this.lut.px[n] + jx;
    this.pY[q] = y;
    this.pGround[q] = ground;
    this.pSpawn[q] = n;
    this.pVel[q] = this.pSpeed[kind] * jv;
    this.roll();
    this.pPhase[q] = (rs[0] >>> 0) * INV32 * 6.28;
    this.pKind[q] = kind;
    // A particle already at or below its ground dies on the next prepare().
  }

  /** Once per sim step: spawn precipitation and lightning from the new state. */
  onStep(sim: WeatherSim): void {
    this.primed = true;
    const lut = this.lut, cell = this.cell, rs = this.rs;
    const stride = 29;
    // At most one new bolt per step per identity-view area: several at once in
    // the same area read as a strobe. A zoomed view shows `area` times the
    // screen area of that sky, so it gets that many (Ruling 4).
    let flashes = 0;
    const boltCap = this.boltsPerStep, fmax = this.fmax;
    // Scramble sample order: a fixed row-major +stride lattice made drops march
    // in diagonals. Same sample count, hashed indices across the disc.
    this.roll();
    const nLut = lut.count;
    if (nLut <= 0) return;
    const samples = Math.ceil(nLut / stride);
    let n = (rs[0] >>> 0) % nLut;
    const step = 63691 % nLut || 1; // odd-ish walk; ≠0 mod nLut
    for (let i = 0; i < samples; i++, n = (n + step) % nLut) {
      const k = cell[n];
      const p = sim.precip[k];
      const inRain = sim.seedMask(k % WX_NX, (k / WX_NX) | 0, true) > 0.08;
      if (p > 0.004 && inRain && this.pCount < this.pmax) {
        this.roll();
        if ((rs[0] >>> 0) * INV32 < p * RAIN_SPAWN * stride / 4) {
          this.spawn(n, sim.snow[k] ? 2 : this.climate.acid > 0.5 ? 1 : 0);
        }
      }
      if (sim.ash[k] > 0.35 && this.pCount < this.pmax) {
        this.roll();
        if ((rs[0] >>> 0) * INV32 < 0.05) this.spawn(n, 3);
      }
      if (flashes < boltCap && this.fCount < fmax && (sim.ash[k] > 0.7 || (inRain && kindAt(sim, k) === WK.STORM))) {
        this.roll();
        if ((rs[0] >>> 0) * INV32 < FLASH_CHANCE) {
          const f = this.fCount++;
          this.fX[f] = lut.px[n]; this.fY[f] = this.skyY[n];
          this.fGround[f] = lut.ground[n]; this.fLife[f] = 0.09;
          this.roll();
          this.fSeed[f] = rs[0] >>> 0;
          this.flashesTotal++;
          flashes++;
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
          this.pY[q] += this.pVel[q] * WX_DT * (b + (this.rs[0] >>> 0) * INV32);
        }
      }
      this.fCount = f0; this.flashesTotal = ft0;
    }
    const simTime = sim.time - (1 - t) * WX_DT;
    for (let k = 0; k < WX_N; k++) {
      const c = sim.prevCloud[k] + (sim.cloud[k] - sim.prevCloud[k]) * t;
      const a = sim.prevAsh[k] + (sim.ash[k] - sim.prevAsh[k]) * t;
      const s = sim.prevSmog[k] + (sim.smog[k] - sim.prevSmog[k]) * t;
      const base = kindAt(sim, k);
      const kind = base === WK.ASH || base === WK.SMOG ? base : sim.form[k];
      this.kind[k] = kind;
      // Cloud gain 1.9 (was 1.5): the shower cycle rains more water out, so the
      // mean cloud field is thinner and ocean skies fell under the readability floor.
      // Water cloud is masked to the drifting seeds, thinned on the lee, with a
      // cap on the windward slope. Ash and smog stay on their vents and cities.
      const mask = sim.seedMask(k % WX_NX, (k / WX_NX) | 0, false);
      // Seeds carry the weather. The windward slope keeps a cap, and a mass
      // thins once it has crossed onto the lee.
      const hi = sim.highCloud[k];
      const water = Math.min(1, c * mask * (1 - 0.72 * sim.leeCloud[k]) + hi * 0.55);
      this.dens[k] = (water * CLOUD_GAIN + a * 0.9 + s * 0.8) * KIND_GAIN[kind] * nebGain;
    }
    // Polar anti-spoke: longitudinal box blur (not a flat row mean). A mean
    // erased every lon difference, so the disc's N/S tips — which project to
    // high latitudes — looked frozen while the sides kept drifting. Blur kills
    // cell-scale spokes; masses wider than the kernel still advect through.
    const scratch = this.poleScratch;
    for (let j = 0; j < WX_NY; j++) {
      const w = this.poleW[j];
      if (w === 0) continue;
      const radius = Math.max(1, Math.round(w * 8));
      const span = radius * 2 + 1;
      const row = j * WX_NX;
      const den = this.dens;
      for (let i = 0; i < WX_NX; i++) {
        let s = 0;
        for (let d = -radius; d <= radius; d++) {
          s += den[row + (((i + d) % WX_NX) + WX_NX) % WX_NX];
        }
        scratch[i] = s / span;
      }
      for (let i = 0; i < WX_NX; i++) {
        const k = row + i;
        den[k] += (scratch[i] - den[k]) * w;
      }
    }
    if (sim !== this.bandSim || sim.climate !== this.bandClimate) {
      for (let j = 0; j < WX_NY; j++) this.bandU[j] = sim.baseWindU(j);
      this.bandSim = sim; this.bandClimate = sim.climate;
    }
    for (let j = 0; j < WX_NY; j++) this.shift[j] = this.bandU[j] * simTime;
    for (let q = this.pCount - 1; q >= 0; q--) {
      this.pY[q] += this.pVel[q] * dt;
      this.pPhase[q] += dt * 2.2;
      if (this.pY[q] >= this.pGround[q]) {
        const last = --this.pCount;
        this.pX[q] = this.pX[last]; this.pY[q] = this.pY[last]; this.pGround[q] = this.pGround[last];
        this.pSpawn[q] = this.pSpawn[last]; this.pVel[q] = this.pVel[last];
        this.pPhase[q] = this.pPhase[last]; this.pKind[q] = this.pKind[last];
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
    const sunX = Math.cos(sunAzimuth), sunUp = ELEV_LIGHT * Math.sin(sunAzimuth);
    const vr = this.vr, vdx = this.vdx, vdy = this.vdy, one = vr === 1;
    // View-bounded (spec 5b): lookup rows whose ground (py - lift, lift <=
    // cloudLift) can land in the view, and in each row the x span on screen.
    const rA = Math.floor(-vdy / vr) - 1, rB = Math.ceil((h - vdy) / vr) + this.cloudLift + 1;
    const xA = Math.floor(-vdx / vr) - 1, xB = Math.ceil((w - vdx) / vr) + 1;
    let visited = 0;
    for (let row = rA; row <= rB; row++) {
      const end = this.rowFirst(row + 1);
      for (let n = this.firstX(this.rowFirst(row), end, xA); n < end; n++) {
      if (lut.px[n] > xB) break;
      visited++;
      const rawLit = 0.5 + lut.dx[n] * sunX + sunUp;
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
      const ai = (0.22 * (dd < 1 ? dd : 1) * lit * intensity * A_ONE) | 0;
      if (one) {
        const x = lut.px[n] + vdx, y = lut.ground[n] + vdy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        over(d, (y * w + x) * 4, 10, 14, 30, ai);
      } else {
        // Nearest-neighbour block of this lookup pixel's scaled footprint.
        const xb = lut.px[n], yb = lut.ground[n];
        const X0 = Math.floor(xb * vr + vdx), X1 = Math.floor((xb + 1) * vr + vdx);
        const Y0 = Math.floor(yb * vr + vdy), Y1 = Math.floor((yb + 1) * vr + vdy);
        for (let y = Y0 < 0 ? 0 : Y0; y < Y1 && y < h; y++) {
          for (let x = X0 < 0 ? 0 : X0; x < X1 && x < w; x++) over(d, (y * w + x) * 4, 10, 14, 30, ai);
        }
      }
      }
    }
    this.visited.shadows = visited;
    const it = (globalThis as { __zoomIters?: Record<string, number> }).__zoomIters;
    if (it) it.shadows = (it.shadows ?? 0) + visited;
  }

  /** Precipitation, then cloud, then lightning. */
  paintClouds(img: ImageDataLike, sunAzimuth: number, intensity: number): void {
    const lut = this.lut, d = img.data, w = img.width, h = img.height;
    const sunX = Math.cos(sunAzimuth), sunUp = ELEV_LIGHT * Math.sin(sunAzimuth);
    this.stats.drawn = 0; this.stats.midOrDense = 0;
    const vr = this.vr, vdx = this.vdx, vdy = this.vdy, one = vr === 1;
    const dX = this.ditherX, dY = this.ditherY;

    // Drops: 1-px strokes at their mapped spot (a stroke, so never scaled).
    // Snow/ash sway; rain stays on its spawn x — phase drift strobed 1-px columns.
    for (let q = 0; q < this.pCount; q++) {
      const kind = this.pKind[q];
      const drift = kind >= 2 ? Math.sin(this.pPhase[q]) * this.tune[0] : 0;
      const xb = Math.round(this.pX[q] + drift), y0 = Math.round(this.pY[q]);
      const x = one ? xb + vdx : Math.floor(xb * vr + vdx);
      const o4 = kind * 4;
      const ai = (P_RGBA[o4 + 3] * intensity * A_ONE) | 0;
      const len = this.pLen[kind];
      const ys = one ? y0 + vdy : Math.floor(y0 * vr + vdy);
      for (let l = 0; l < len; l++) {
        const y = ys + l;
        if (x < 0 || y < 0 || x >= w || y >= h || y0 + l > this.pGround[q]) continue;
        over(d, (y * w + x) * 4, P_RGBA[o4], P_RGBA[o4 + 1], P_RGBA[o4 + 2], ai);
      }
    }

    const acid = this.climate.acid, neb = this.climate.nebula;
    const den = this.dens, tex = this.detail, shift = this.shift;
    const off = this.climate.personality.detailOffset;
    const sky = this.skyY, skyH = this.skyH;
    // View-bounded (spec 5b): lookup rows whose cloud (skyY, ≥ py - cloudLift)
    // can land in the view. cloudLift is still the max lift (far rim).
    const cl = this.cloudLift;
    const rA = Math.floor(-vdy / vr) + cl - 1, rB = Math.ceil((h - vdy) / vr) + cl + 1;
    const xA = Math.floor(-vdx / vr) - 1, xB = Math.ceil((w - vdx) / vr) + 1;
    let visited = 0;
    for (let row = rA; row <= rB; row++) {
      const end = this.rowFirst(row + 1);
      for (let n = this.firstX(this.rowFirst(row), end, xA); n < end; n++) {
      const xl = lut.px[n];
      if (xl > xB) break;
      visited++;
      // x, y: dither keys (world-anchored). Y span covers skyY..skyY+skyH so
      // perspective stretch does not leave empty scanlines between face rows.
      const yl = sky[n], yh = skyH[n];
      const x = xl + dX, y = yl + dY;
      let X0: number, X1: number, Y0: number, Y1: number;
      if (one) {
        X0 = xl + vdx; Y0 = yl + vdy; Y1 = Y0 + yh; X1 = X0 + 1;
        if (X0 < 0 || X0 >= w || Y1 <= 0 || Y0 >= h) continue;
        if (Y0 < 0) Y0 = 0; if (Y1 > h) Y1 = h;
        if (Y1 <= Y0) continue;
      } else {
        X0 = Math.floor(xl * vr + vdx); X1 = Math.floor((xl + 1) * vr + vdx);
        Y0 = Math.floor(yl * vr + vdy); Y1 = Math.floor((yl + yh) * vr + vdy);
        if (X0 < 0) X0 = 0; if (Y0 < 0) Y0 = 0; if (X1 > w) X1 = w; if (Y1 > h) Y1 = h;
        if (X1 <= X0 || Y1 <= Y0) continue;
      }
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
      const bay = BAYER4[(y & 3) * 4 + (x & 3)];
      // R5: the kind (and so the palette) is picked from the four surrounding
      // cells by ordered dither on the bilinear weights. The nearest cell's kind
      // switched cumulus/storm colour along cell edges, in rectangles.
      const kind = this.kind[(ty > BAYER4[(x & 3) * 4 + (y & 3)] ? r1 : r0) + (tx > bay ? b : a)];
      // Cumulus stays puffy. Stratus is a flat layer, a cap hugs the slope,
      // and cirrus is filaments running with the zonal wind.
      let dd: number;
      if (kind === WK.CIRRUS) {
        const phase = fy * 2.2 + (fx - shift[jr]) * 0.25;
        const wrapped = phase - Math.floor(phase);
        const filament = wrapped < 0.5 ? wrapped * 2 : (1 - wrapped) * 2;
        dd = dens * (0.2 + 1.2 * filament);
      } else if (kind === WK.STRATUS) {
        dd = dens * (0.58 + 0.32 * det);
      } else if (kind === WK.CAP) {
        dd = dens * (0.72 + 0.22 * det);
      } else {
        dd = dens * (0.2 + 1.6 * det * det);
      }
      if (dd < (kind === WK.CIRRUS ? 0.46 : 0.34)) continue;
      let lv = (dd > 0.39 ? 1 : (dd - 0.34) / 0.05 > bay ? 1 : 0)
             + (dd > 0.54 ? 1 : dd > 0.5 && (dd - 0.5) / 0.04 > bay ? 1 : 0)
             + (dd > 0.74 ? 1 : dd > 0.7 && (dd - 0.7) / 0.04 > bay ? 1 : 0);
      if (kind === WK.CIRRUS && lv > 1) lv = 1;
      if (lv === 0) continue;
      this.stats.drawn++;
      if (lv >= 2) this.stats.midOrDense++;

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
      if (acid > 0 && (kind === WK.CUMULUS || kind === WK.STORM || kind === WK.STRATUS || kind === WK.CAP)) {
        o = facing ? 0 : 3;
        r += (ACID[o] - r) * acid; g += (ACID[o + 1] - g) * acid; bl += (ACID[o + 2] - bl) * acid;
      }
      const rawLit = 0.5 + lut.dx[n] * sunX + sunUp;
      const lit = 0.35 + 0.65 * (rawLit < 0 ? 0 : rawLit > 1 ? 1 : rawLit);
      r *= lit; g *= lit; bl *= lit;
      if (neb > 0 && facing && (kind === WK.CUMULUS || kind === WK.CAP || kind === WK.STRATUS)) { r += 40 * neb; g += 10 * neb; bl += 60 * neb; }
      const ai = (this.levelAlpha[lv] * intensity * A_ONE) | 0;
      for (let Y = Y0; Y < Y1; Y++) for (let X = X0; X < X1; X++) over(d, (Y * w + X) * 4, r | 0, g | 0, bl | 0, ai);
      }
    }
    this.visited.clouds = visited;
    const it = (globalThis as { __zoomIters?: Record<string, number> }).__zoomIters;
    if (it) it.clouds = (it.clouds ?? 0) + visited;

    const HR = this.haloR, WA = this.wander;
    for (let f = 0; f < this.fCount; f++) {
      let s = this.fSeed[f], bx = this.fX[f];
      const x0 = this.fX[f];
      const bolt = (0.95 * intensity * A_ONE) | 0, halo = 0.35 * intensity * A_ONE;
      for (let y = Math.round(this.fY[f]); y < this.fGround[f]; y++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const r = s * INV32;
        if (r < 0.15) bx--; else if (r > 0.85) bx++;
        if (bx < x0 - WA) bx = x0 - WA; else if (bx > x0 + WA) bx = x0 + WA;
        // A 1-px stroke at its mapped spot.
        const X = one ? bx + vdx : Math.floor(bx * vr + vdx), Y = one ? y + vdy : Math.floor(y * vr + vdy);
        if (X >= 0 && Y >= 0 && X < w && Y < h) over(d, (Y * w + X) * 4, 255, 255, 230, bolt);
      }
      const fy0 = Math.round(this.fY[f]);
      const cxs = one ? x0 + vdx : Math.floor(x0 * vr + vdx), fy = one ? fy0 + vdy : Math.floor(fy0 * vr + vdy);
      for (let oy = -HR; oy <= HR; oy++) for (let ox = -HR; ox <= HR; ox++) {
        const x = cxs + ox, y = fy + oy;
        const fall = 1 - Math.sqrt(ox * ox + oy * oy) / HR;
        if (fall <= 0 || x < 0 || y < 0 || x >= w || y >= h) continue;
        over(d, (y * w + x) * 4, 230, 235, 255, (halo * fall) | 0);
      }
    }
  }
}
