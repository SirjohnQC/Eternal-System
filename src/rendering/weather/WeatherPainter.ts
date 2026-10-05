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
import { VX, type Vortex, type WeatherEvents } from './WeatherEvents';

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
  214, 218, 228, 52, 56, 74,              // STORM: sunlit cumulonimbus top, dark base
  230, 244, 252, 160, 196, 224,           // ICE
  110, 100, 96, 42, 36, 36,               // ASH
  168, 146, 112, 86, 72, 56,              // SMOG
  214, 220, 230, 132, 146, 168,           // STRATUS
  248, 250, 255, 196, 210, 228,           // CIRRUS
  255, 255, 250, 176, 198, 224,           // CAP
];
const ACID = [206, 224, 120, 120, 140, 48];
/**
 * Volume clouds: how tall a fully dense cloud of each kind towers above its
 * base, in base px (x the painter's zoom). Cumulus heaps, storms build tall
 * (and flatten into an anvil at the top), a cap hugs the peak. 0: flat layer.
 */
const TOWER = [0, 9, 20, 0, 0, 0, 0, 0, 5];
/**
 * Spiral storm tones, crest / mid / trough rgb, per VSTYLE (plain, acid,
 * soot, prism, hyper) and then the blizzard (SPIRAL_SNOW).
 */
const SPIRAL_TONES = [
  250, 252, 255, 222, 232, 244, 168, 186, 210,      // plain
  226, 240, 168, 196, 214, 132, 140, 158, 90,       // acid (toxic)
  168, 164, 158, 132, 128, 124, 92, 88, 86,         // soot (carbon)
  246, 234, 255, 220, 206, 248, 172, 160, 216,      // prism (crystal)
  226, 230, 240, 160, 166, 184, 92, 96, 118,        // hyper (storm world): darker, heavier
  240, 246, 255, 188, 204, 228, 128, 148, 182,      // blizzard: blue-grey, to read over ice
];
const SPIRAL_SNOW = 5;
/**
 * Funnels, one row per style (FUNNEL_STRIDE numbers): wallCloud(1/0),
 * height (base px), top half-width, foot half-width, alpha, lit rgb,
 * shade rgb, core rgb (fire), debris spread, debris rgb.
 */
const FUNNEL_STRIDE = 18;
const FUNNELS = [
  // tornado
  1, 16, 6, 1.2, 0.95, 128, 120, 116, 84, 80, 82, 0, 0, 0, 1, 158, 134, 104,
  // dust devil
  0, 18, 4.5, 0.8, 0.85, 176, 136, 90, 134, 98, 64, 0, 0, 0, 0.8, 150, 112, 72,
  // fire whirl
  0, 22, 4.5, 1.4, 0.95, 70, 52, 46, 40, 30, 30, 255, 150, 50, 0.9, 255, 120, 40,
  // supercell's funnel (darker, wider)
  1, 18, 7.5, 1.6, 0.95, 110, 106, 108, 66, 64, 70, 0, 0, 0, 1.3, 150, 128, 100,
];
/** VX kind -> FUNNELS row. */
const FUNNEL_OF = [0, 0, 1, 0, 0, 3, 2];
/** Tallest tower (base px): the cloud band reaches this far above the deck. */
export const CLOUD_TOWER_MAX = Math.max(...TOWER);
/** A storm's tower flattens into an anvil above this share of its height. */
const ANVIL = 0.78;
/** Precipitation kinds: rain, acid rain, snow, ash — the legacy PRECIP_STYLE. */
const P_SPEED = [48, 42, 14, 20];
const P_LEN = [4, 4, 1, 1];
const P_RGBA = [170, 206, 240, 0.7, 190, 222, 105, 0.6, 240, 250, 255, 0.8, 64, 56, 54, 0.75];
const PMAX = 320, FMAX = 8;
/** Seconds a rain drop shows as a splash after it lands (two 1-px frames). */
const SPLASH_T = 0.14;
/** Steepest rain slant (x per y), reached in the windiest band. */
const SLANT_MAX = 0.5;
/** Wind gusts: live cap (identity view), lifetime (s), and speed (base px/s) at the windiest band. */
const GMAX = 28, GUST_LIFE = 1.3, GUST_SPEED = 46;
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
  /** Rain slant of each drop (x per y), and its splash time left (> 0: landed). */
  private pSlant: Float32Array;
  /** Wind gusts: thin streaks skimming the ground with the band wind. */
  private gCount = 0;
  private readonly gmax: number;
  private readonly gX: Float32Array; private readonly gY: Float32Array;
  private readonly gVx: Float32Array; private readonly gLife: Float32Array; private readonly gLen: Float32Array;
  /** The face's x span on each gust's row: a gust is clipped to it, never drawn over space. */
  private readonly gX0: Float32Array; private readonly gX1: Float32Array;
  private readonly gustScale: number;
  private pSplash: Float32Array;
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
  /** Rain falling from each cell (precip in the drifting rain mask; 0 for snow). */
  private rainF = new Float32Array(WX_N);
  /** Painter clock (s), advanced by prepare: the rain curtains scroll on it. */
  private clock = 0;
  /**
   * Field -> lookup map for tornadoes and typhoons: each field cell's mean
   * lookup x, face y, cloud-deck y, ground y and disc x (NaN: not on this
   * face). Built once; a vortex at field (x, y) is placed by bilinear blend.
   */
  private readonly cellPX = new Float32Array(WX_N);
  private readonly cellPY = new Float32Array(WX_N);
  private readonly cellSky = new Float32Array(WX_N);
  private readonly cellG = new Float32Array(WX_N);
  private readonly cellDX = new Float32Array(WX_N);
  /** mapField output: x, face y, sky y, ground y, px per cell (x, y), disc x. */
  private readonly mo = new Float64Array(7);
  private events: WeatherEvents | null = null;
  /** The live typhoon (field x, y, radius in cells, power); r = 0: none. Ordinary cloud is cleared under it. */
  private tyX = 0; private tyY = 0; private tyR = 0; private tyP = 0;
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
  /** Cauliflower domes (overlapping spherical puffs), same lattice as `detail`. */
  private puff = new Float32Array(DT_W * DT_H);
  /** TOWER x the painter's zoom (lookup px). */
  private readonly tower = new Float32Array(TOWER.length);
  private towerMax = 0;
  /** Nearest field cell of each lookup pixel. Fixed, so computed once. */
  private cell: Int32Array;
  /** Band wind per row, cached per (sim, climate): baseWindU returns a double. */
  private bandU = new Float32Array(WX_NY);
  /** Rain slant per band (x per y), from the band wind. */
  private slant = new Float32Array(WX_NY);
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
    this.pSlant = new Float32Array(pmax); this.pSplash = new Float32Array(pmax);
    const gmax = this.gmax = Math.max(GMAX, Math.ceil(GMAX * Math.max(1, opts.area ?? 1)));
    this.gX = new Float32Array(gmax); this.gY = new Float32Array(gmax); this.gVx = new Float32Array(gmax);
    this.gLife = new Float32Array(gmax); this.gLen = new Float32Array(gmax);
    this.gX0 = new Float32Array(gmax); this.gX1 = new Float32Array(gmax);
    this.gustScale = k;
    const area = Math.max(1, opts.area ?? 1);
    const fmax = this.fmax = Math.max(FMAX, Math.ceil(FMAX * area));
    this.boltsPerStep = Math.max(1, Math.round(area));
    this.fX = new Float32Array(fmax); this.fY = new Float32Array(fmax);
    this.fGround = new Float32Array(fmax); this.fLife = new Float32Array(fmax);
    this.fSeed = new Uint32Array(fmax);
    for (let i = 0; i < 4; i++) this.pLen[i] = Math.max(1, Math.round(P_LEN[i] * (opts.streakScale ?? 1)));
    for (let i = 0; i < 4; i++) this.pSpeed[i] = P_SPEED[i] * k;
    this.tune[0] = 1.5 * k; this.tune[1] = 2 * k;
    for (let i = 0; i < TOWER.length; i++) this.tower[i] = TOWER[i] * k;
    this.towerMax = Math.ceil(CLOUD_TOWER_MAX * k);
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
    // One cloud deck for the whole world, above its tallest ground. Floating
    // each column a clearance over ITS OWN terrain made the deck step with
    // every terrace, so clouds over land were cut into vertical slabs that
    // showed worst when zoomed (play report: "clouds get chopped").
    let top = 0;
    for (let n = 0; n < lut.count; n++) { const l = lut.py[n] - lut.ground[n]; if (l > top) top = l; }
    const deck = top + clearance;
    for (let n = 0; n < lut.count; n++) {
      // dy +1 = near/front, -1 = far/back. Rise into the dome only toward the back.
      const dy = dys ? dys[n] : 0;
      const perspective = this.cloudLift * 0.5 * (1 - dy);
      const lift = perspective > deck ? perspective : deck;
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
    {
      const cnt = new Float32Array(WX_N);
      const PX = this.cellPX, PY = this.cellPY, SK = this.cellSky, G = this.cellG, DX = this.cellDX;
      for (let n = 0; n < lut.count; n++) {
        const k = this.cell[n];
        cnt[k]++; PX[k] += lut.px[n]; PY[k] += lut.py[n]; SK[k] += this.skyY[n]; G[k] += lut.ground[n]; DX[k] += lut.dx[n];
      }
      for (let k = 0; k < WX_N; k++) {
        if (cnt[k] === 0) { PX[k] = PY[k] = SK[k] = G[k] = DX[k] = NaN; continue; }
        PX[k] /= cnt[k]; PY[k] /= cnt[k]; SK[k] /= cnt[k]; G[k] /= cnt[k]; DX[k] /= cnt[k];
      }
    }
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
      this.pSlant[q] = from.pSlant[q]; this.pSplash[q] = from.pSplash[q];
    }
    this.pCount = n;
    this.gCount = 0;
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
    // Puffs: a few hundred spheres stamped on the wrapped lattice, the max
    // kept. Their heights are what makes a cumulus top heap into domes.
    const puff = this.puff;
    puff.fill(0);
    let h = (seed | 0) ^ 0x5bd1e995;
    const rnd = () => { h = (Math.imul(h, 1664525) + 1013904223) | 0; return (h >>> 0) / 4294967296; };
    for (let i = 0; i < 520; i++) {
      const cx = rnd() * DT_W, cy = rnd() * DT_H, r = 1.6 + rnd() * 2.6, top = 0.55 + rnd() * 0.45;
      const R = Math.ceil(r);
      for (let oy = -R; oy <= R; oy++) for (let ox = -R; ox <= R; ox++) {
        const x = Math.floor(cx) + ox, y = Math.floor(cy) + oy;
        const ddx = x + 0.5 - cx, ddy = (y + 0.5 - cy) * 1.4;
        const q = 1 - (ddx * ddx + ddy * ddy) / (r * r);
        if (q <= 0) continue;
        const v = top * Math.sqrt(q);
        const o = (((y % DT_H) + DT_H) % DT_H) * DT_W + (((x % DT_W) + DT_W) % DT_W);
        if (v > puff[o]) puff[o] = v;
      }
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
    // Rain leans with its band's wind; snow and ash sway instead.
    const fy = this.lut.fy[n], jr = fy < 0 ? 0 : fy > WX_NY - 1 ? WX_NY - 1 : Math.round(fy);
    this.pSlant[q] = kind <= 1 ? this.slant[jr] : 0;
    this.pSplash[q] = 0;
    // A particle already at or below its ground dies on the next prepare().
  }

  /**
   * Place field point (fx, fy) on this lookup: writes `mo` = [x, face y, sky y,
   * ground y, px per cell x, px per cell y, disc x]. False when it is not on
   * this face. Bilinear over the four cells around it; nearest valid cell
   * when one of them is off the face.
   */
  private mapField(fx: number, fy: number): boolean {
    const gx = fx - 0.5, gy = fy - 0.5;
    const i0 = Math.floor(gx), j0 = Math.floor(gy), tx = gx - i0, ty = gy - j0;
    const a = ((i0 % WX_NX) + WX_NX) % WX_NX, b = (a + 1) % WX_NX;
    const ja = j0 < 0 ? 0 : j0 > WX_NY - 1 ? WX_NY - 1 : j0, jb = ja + 1 > WX_NY - 1 ? WX_NY - 1 : ja + 1;
    const k00 = ja * WX_NX + a, k01 = ja * WX_NX + b, k10 = jb * WX_NX + a, k11 = jb * WX_NX + b;
    const PX = this.cellPX, PY = this.cellPY, SK = this.cellSky, G = this.cellG, mo = this.mo;
    if (PX[k00] === PX[k00] && PX[k01] === PX[k01] && PX[k10] === PX[k10] && PX[k11] === PX[k11]) {
      const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty), w10 = (1 - tx) * ty, w11 = tx * ty;
      mo[0] = PX[k00] * w00 + PX[k01] * w01 + PX[k10] * w10 + PX[k11] * w11;
      mo[1] = PY[k00] * w00 + PY[k01] * w01 + PY[k10] * w10 + PY[k11] * w11;
      mo[2] = SK[k00] * w00 + SK[k01] * w01 + SK[k10] * w10 + SK[k11] * w11;
      mo[3] = G[k00] * w00 + G[k01] * w01 + G[k10] * w10 + G[k11] * w11;
      mo[6] = this.cellDX[k00] * w00 + this.cellDX[k01] * w01 + this.cellDX[k10] * w10 + this.cellDX[k11] * w11;
      mo[4] = Math.abs(PX[k01] - PX[k00]) * (1 - ty) + Math.abs(PX[k11] - PX[k10]) * ty;
      mo[5] = Math.abs(this.cellPY[k10] - this.cellPY[k00]) * (1 - tx) + Math.abs(this.cellPY[k11] - this.cellPY[k01]) * tx;
      return true;
    }
    const kn = (ty < 0.5 ? ja : jb) * WX_NX + (tx < 0.5 ? a : b);
    if (PX[kn] !== PX[kn]) return false;
    mo[0] = PX[kn]; mo[1] = PY[kn]; mo[2] = SK[kn]; mo[3] = G[kn];
    mo[6] = this.cellDX[kn];
    // No neighbour pair to measure: the face's mean cell size.
    mo[4] = this.lut.count > 0 ? 300 / (WX_NX / 2) * this.gustScale : 9;
    mo[5] = mo[4] * 0.5;
    return true;
  }

  /** The face's x span on lookup row y: writes spanLo/spanHi; false if the row is off the face. */
  private faceSpan(y: number): boolean {
    const a = this.rowFirst(y), b = this.rowFirst(y + 1);
    if (a >= b) return false;
    this.spanLo = this.lut.px[a]; this.spanHi = this.lut.px[b - 1];
    return true;
  }
  private spanLo = 0;
  private spanHi = 0;

  /** Distance from field point (fx, fy) to vortex v, in cells (x wraps). */
  private static fieldDist(v: Vortex, fx: number, fy: number): number {
    let dx = fx - v.x;
    if (dx > WX_NX / 2) dx -= WX_NX; else if (dx < -WX_NX / 2) dx += WX_NX;
    const dy = fy - v.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * A spiral storm seen from above — typhoon, hypercane or blizzard: two
   * logarithmic arms wound round a dense core and eyewall, a clear eye,
   * turning slowly. Drawn on the cloud deck in lookup px (blocks of vr on
   * screen, like the clouds), clipped to the face. A blizzard's arms are
   * looser and full of driving snow.
   */
  private paintSpiral(d: Uint8ClampedArray, w: number, h: number, yLo: number, v: Vortex,
    sunX: number, sunUp: number, intensity: number): void {
    const mo = this.mo, vr = this.vr, vdx = this.vdx, vdy = this.vdy, k = this.gustScale;
    const cx = mo[0], cy = mo[2], lift = mo[1] - mo[2];
    const Rx = v.r * mo[4], Ry = v.r * (mo[5] > 0.5 ? mo[5] : mo[4] * 0.5);
    if (Rx < 2 || Ry < 1) return;
    const rawLit = 0.5 + mo[6] * sunX + sunUp;
    const lit = 0.4 + 0.6 * (rawLit < 0 ? 0 : rawLit > 1 ? 1 : rawLit);
    const t = this.clock, spin = v.spin, pw = v.power;
    const snow = v.kind === VX.BLIZZARD;
    const tone = (snow ? SPIRAL_SNOW : v.style) * 9;
    const xa = Math.floor(cx - Rx), xb = Math.ceil(cx + Rx), ya = Math.floor(cy - Ry), yb = Math.ceil(cy + Ry);
    const ai = (this.levelAlpha[3] * intensity * A_ONE) | 0;
    for (let yl = ya; yl <= yb; yl++) {
      // Clip to the face: this deck row floats `lift` above face row yl + lift.
      if (!this.faceSpan(Math.round(yl + lift))) continue;
      // A small margin: the deck's lift varies across a big spiral, so its
      // edge rows are matched to the face only approximately.
      const lo = this.spanLo + 3, hi = this.spanHi - 3;
      const Y0 = Math.floor(yl * vr + vdy), Y1 = Math.floor((yl + 1) * vr + vdy);
      if (Y1 <= yLo || Y0 >= h) continue;
      const vv = (yl + 0.5 - cy) / Ry;
      for (let xl = xa < lo ? lo : xa; xl <= xb && xl <= hi; xl++) {
        const u = (xl + 0.5 - cx) / Rx;
        const r2 = u * u + vv * vv;
        if (r2 >= 1) continue;
        const rho = Math.sqrt(r2);
        // Arms: phase winds outward (log spiral) and turns with time.
        const phase = spin * Math.atan2(vv, u) * 2 + Math.log(rho + 0.04) * (snow ? 2.4 : 3.4) - spin * t * 0.5;
        const arm = 0.5 + 0.5 * Math.cos(phase);
        const ew = (rho - 0.2) / 0.075, wall = snow ? 0 : Math.exp(-ew * ew);
        // Bands with sea between them, wound out of a dense central overcast
        // round the eyewall, thinning outward. A blizzard is a looser mass.
        let dens = snow
          ? (0.3 + 0.7 * arm) * (1 - rho * rho) * 1.25 + (rho < 0.3 ? (0.3 - rho) * 1.5 : 0)
          : (0.12 + arm * arm) * (1 - rho * rho) * 1.45 + wall * 1.3 + (rho < 0.42 ? (0.42 - rho) * 2.2 : 0);
        if (!snow && rho < 0.1) dens = wall * 1.3 * (rho / 0.1);   // the eye
        dens *= pw;
        const bay = BAYER4[((yl + this.ditherY) & 3) * 4 + ((xl + this.ditherX) & 3)];
        if (dens < 0.32 + bay * 0.14) continue;
        // Tones: crests catch the light, troughs shade (per world: SPIRAL_TONES).
        const o = tone + (dens > 0.85 ? 0 : dens > 0.6 ? 3 : 6);
        let r = SPIRAL_TONES[o], g = SPIRAL_TONES[o + 1], b = SPIRAL_TONES[o + 2];
        // The eye's inner wall falls into shadow on the side away from the sun.
        if (!snow && rho < 0.24 && u * sunX < 0) { r *= 0.72; g *= 0.74; b *= 0.8; }
        r *= lit; g *= lit; b *= lit;
        const X0 = Math.floor(xl * vr + vdx), X1 = Math.floor((xl + 1) * vr + vdx);
        for (let Y = Y0 < yLo ? yLo : Y0; Y < Y1 && Y < h; Y++) {
          for (let X = X0 < 0 ? 0 : X0; X < X1 && X < w; X++) over(d, (Y * w + X) * 4, r | 0, g | 0, b | 0, ai);
        }
      }
    }
    if (!snow) return;
    // Driving snow: short streaks swept round the low, faster near its heart.
    const sa = (0.85 * pw * intensity * A_ONE) | 0;
    for (let i = 0; i < 70; i++) {
      const f = (i * 0.618034) % 1, rr = 0.12 + 0.85 * f;
      const a = i * 2.39996 + spin * t * (1.6 - rr);
      const px = cx + Math.cos(a) * rr * Rx, py = cy + Math.sin(a) * rr * Ry;
      if (!this.faceSpan(Math.round(py + lift))) continue;
      // Tangent: along the swirl.
      const tx = -Math.sin(a) * spin, ty = Math.cos(a) * spin * (Ry / Rx);
      const len = 3 * k;
      for (let s = 0; s < len; s++) this.block(d, w, h, yLo, Math.round(px + tx * s), Math.round(py + ty * s), 246, 250, 255, sa);
    }
  }

  /**
   * A funnel: tornado, dust devil or fire whirl (FUNNELS[kind] sets size and
   * colour). A tornado hangs from a dark wall cloud and lowers as it forms;
   * a dust devil rises off hot ground; a fire whirl is a column of flame and
   * smoke. Banded so it reads as turning; debris whirls round its foot.
   */
  private paintFunnel(d: Uint8ClampedArray, w: number, h: number, yLo: number, v: Vortex,
    sunX: number, intensity: number): void {
    const mo = this.mo, k = this.gustScale;
    const F = FUNNEL_OF[v.kind] * FUNNEL_STRIDE, fn = FUNNELS;
    const cx = mo[0], ground = mo[3];
    // Height: a tornado reaches the deck (at least FUN_H); the others stand FUN_H tall.
    const top = fn[F] > 0 ? Math.min(mo[2], ground - fn[F + 1] * k) : ground - fn[F + 1] * k;
    if (!this.faceSpan(Math.round(ground))) return;
    const t = this.clock, pw = v.power, H = ground - top;
    if (H < 3) return;
    const solid = (fn[F + 4] * intensity * A_ONE) | 0;
    if (fn[F] > 0) {
      // Wall cloud: a low dark lens on the deck.
      const wr = (8 + 4 * pw) * k, wh = 3 * k;
      for (let yl = Math.floor(top - wh); yl <= top + wh; yl++) {
        const vv = (yl - top) / wh;
        const half = wr * Math.sqrt(Math.max(0, 1 - vv * vv));
        for (let xl = Math.floor(cx - half); xl <= cx + half; xl++) {
          const shade = vv < -0.3 ? 92 : 58;
          this.block(d, w, h, yLo, xl, yl, shade, shade + 4, shade + 14, solid);
        }
      }
    }
    // A tornado lowers from its cloud while forming; the others rise from the ground.
    const fromTop = fn[F] > 0;
    const reach = pw;
    let gx = cx;
    for (let yl = Math.floor(top); yl < ground; yl++) {
      const f = (yl - top) / H;
      if (fromTop ? f > reach : f < 1 - reach) continue;
      const half = (fn[F + 2] * Math.pow(1 - f, 1.5) + fn[F + 3]) * k * (0.5 + 0.5 * pw);
      const xc = cx + Math.sin(f * 4 + t * 1.8 + v.seed) * 1.6 * k * f;
      gx = xc;
      for (let xl = Math.floor(xc - half); xl <= xc + half; xl++) {
        const sx = (xl + 0.5 - xc) / half;
        const band = Math.floor(sx * 2 + t * 6 * v.spin + f * 7) & 1;
        const sunSide = sx * sunX > 0;
        // Colour: lit / shaded side, a darker band; a fire whirl burns hot at its core.
        let o = F + (sunSide ? 5 : 8);
        if (v.kind === VX.FIRE_WHIRL && (sx > -0.45 && sx < 0.45)) o = F + 11;
        let r = fn[o], g = fn[o + 1], b = fn[o + 2];
        if (band) { r *= 0.8; g *= 0.8; b *= 0.8; }
        const edge = sx < -0.85 || sx > 0.85;
        this.block(d, w, h, yLo, xl, yl, r | 0, g | 0, b | 0, edge ? (solid * 0.6) | 0 : solid);
      }
    }
    if (v.kind === VX.FIRE_WHIRL) {
      // Smoke boils off the top; embers rise.
      for (let i = 0; i < 16; i++) {
        const a = i * 2.4 + t * 2 * v.spin, rr = (2 + (i % 4)) * k;
        const rise = ((t * 9 + i * 7) % (H * 0.9));
        this.block(d, w, h, yLo, Math.round(gx + Math.cos(a) * rr), Math.round(ground - rise),
          255, 170 + (i % 3) * 30, 60, (0.9 * pw * intensity * A_ONE) | 0);
        this.block(d, w, h, yLo, Math.round(cx + Math.cos(a) * rr * 1.6), Math.round(top - (i % 5) * k),
          46, 40, 40, (0.7 * pw * intensity * A_ONE) | 0);
      }
    }
    // Touchdown: debris whirling round the foot.
    if (reach >= 0.98 || !fromTop) {
      const n = 22;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + t * 3.2 * v.spin;
        const rr = (3.5 + 2.5 * Math.sin(t * 2.3 + i * 1.7)) * k * fn[F + 14];
        const xl = Math.round(gx + Math.cos(a) * rr), yl = Math.round(ground - 1 + Math.sin(a) * rr * 0.4 - (i & 1) * k);
        this.block(d, w, h, yLo, xl, yl, fn[F + 15] | 0, fn[F + 16] | 0, fn[F + 17] | 0, (0.75 * pw * intensity * A_ONE) | 0);
      }
    }
  }

  /**
   * A supercell (storm worlds): a rotating tower of storm cloud with an anvil
   * spreading off its top, banded sides that turn, a dark base — and a
   * funnel under it once it is mature.
   */
  private paintSupercell(d: Uint8ClampedArray, w: number, h: number, yLo: number, v: Vortex,
    sunX: number, intensity: number): void {
    const mo = this.mo, k = this.gustScale;
    const cx = mo[0], cy = mo[2], lift = mo[1] - mo[2];
    const R = v.r * mo[4], Ry = v.r * (mo[5] > 0.5 ? mo[5] : mo[4] * 0.5);
    if (R < 2) return;
    const pw = v.power, t = this.clock;
    const T = 26 * k * pw, anvil = 1.55, slab = 4 * k;
    const ai = (this.levelAlpha[3] * intensity * A_ONE) | 0;
    // Funnel first; the tower's base sits over its top.
    if (pw > 0.6) this.paintFunnel(d, w, h, yLo, v, sunX, intensity);
    const RA = R * anvil, RyA = Ry * anvil;
    for (let yl = Math.floor(cy - RyA); yl <= cy + RyA; yl++) {
      if (!this.faceSpan(Math.round(yl + lift))) continue;
      const vv = (yl + 0.5 - cy) / Ry;
      for (let xl = Math.floor(cx - RA - R * 0.4); xl <= cx + RA + R * 0.4; xl++) {
        const u = (xl + 0.5 - cx) / R;
        const rho = Math.sqrt(u * u + vv * vv);
        // The anvil spreads downwind of the tower (centre shifted along dir).
        const ua = u - 0.4 * v.dir, rhoA = Math.sqrt(ua * ua + vv * vv);
        if (rho >= 1.2 && rhoA >= anvil) continue;
        // Puffs (the clouds' own dome field) lump the tower's outline, dome its
        // top and fray the anvil's edge.
        const px0 = ((((xl * 0.22 + v.seed) | 0) % DT_W) + DT_W) % DT_W, py0 = ((((yl * 0.3) | 0) % DT_H) + DT_H) % DT_H;
        const pf = this.puff[py0 * DT_W + px0];
        const theta = Math.atan2(vv, u);
        const core = rho < 0.72 + 0.32 * pf;
        if (!core && rhoA > anvil - 0.35 * pf - 0.1 * (0.5 + 0.5 * Math.sin(theta * 5 + v.seed))) continue;
        const dome = core ? 1 - 0.35 * rho * rho * rho * rho : 1;
        const topY = yl - T * dome - pf * 4 * k, botY = core ? yl : topY + slab;
        for (let y = Math.floor(topY); y <= botY; y++) {
          const fromTop = y - topY;
          let r: number, g: number, b: number;
          if (fromTop < 2 * k) {
            // Anvil top: bright, lit toward the sun, the puffs shading it.
            const sunny = u * sunX > -0.2, f = sunny ? 0.92 + 0.08 * pf : 0.78 + 0.1 * pf;
            r = 250 * f; g = 252 * f; b = 255 * f;
          } else if (!core || y < topY + slab) {
            r = 150; g = 156; b = 174;                     // anvil underside
          } else {
            // Tower side: striations rise round it as it turns.
            const hgt = (yl - y) / (T + 1);
            const stripe = Math.sin(hgt * 11 + theta * 2 * v.spin - t * 1.4 * v.spin) > 0.45;
            const sunny = u * sunX > 0;
            // Level bands like the heaps': bright up the tower, dark at its base.
            const base = hgt > 0.6 ? 1 : hgt > 0.3 ? 0.84 : hgt > 0.1 ? 0.66 : 0.46;
            r = (sunny ? 214 : 150) * base; g = (sunny ? 218 : 156) * base; b = (sunny ? 230 : 178) * base;
            if (stripe) { r *= 0.9; g *= 0.9; b *= 0.92; }
          }
          this.block(d, w, h, yLo, xl, y, r | 0, g | 0, b | 0, ai);
        }
      }
    }
  }

  /**
   * A haboob (desert worlds): a long wall of dust running across the face,
   * rolling north or south. Tallest and most billowed at its front, its body
   * thinning behind; it stands on the ground, not on the cloud deck.
   */
  private paintHaboob(d: Uint8ClampedArray, w: number, h: number, yLo: number, v: Vortex,
    sunX: number, intensity: number): void {
    const mo = this.mo, k = this.gustScale;
    const cx = mo[0], gy = mo[3];
    const Rx = v.r * mo[4], Ry = v.r * (mo[5] > 0.5 ? mo[5] : mo[4] * 0.5);
    if (Rx < 2) return;
    const pw = v.power, t = this.clock, dir = v.dir;
    const ai = (0.95 * intensity * A_ONE) | 0;
    // Rows back to front (ascending y), so the wall's face covers its body.
    const depth = Ry * 0.9, yA = Math.floor(gy - Ry), yB = Math.ceil(gy + Ry);
    for (let yl = yA; yl <= yB; yl++) {
      if (!this.faceSpan(yl)) continue;
      for (let xl = Math.floor(cx - Rx); xl <= cx + Rx; xl++) {
        const q = (xl + 0.5 - cx) / Rx, span = 1 - q * q;
        if (span <= 0) continue;
        // The front bulges forward in the middle; the body trails behind it.
        const front = gy + dir * Ry * 0.35 * span;
        const s = (front - yl) * dir;                 // rows behind the front
        const dep = depth * Math.sqrt(span);
        if (s < 0 || s > dep) continue;
        const back = s / (dep + 1);
        // Billows: broad rolling domes along the front, drifting with time;
        // a billow's flank toward the sun is lit.
        const ph1 = xl / k * 0.2 + t * 1.6 * dir + v.seed, ph2 = xl / k * 0.47 - t * 1.1;
        const roll = 0.62 + 0.24 * Math.sin(ph1) + 0.14 * Math.sin(ph2);
        const slope = 0.24 * 0.2 * Math.cos(ph1) + 0.14 * 0.47 * Math.cos(ph2);
        const T = 20 * k * pw * Math.sqrt(span) * roll * (1 - 0.75 * back);
        const sunny = slope * sunX < 0 || (slope * sunX === 0 && q * sunX > 0);
        for (let y = Math.floor(yl - T); y <= yl; y++) {
          const fromTop = y - (yl - T);
          let r: number, g: number, b: number;
          // Face shading by height above the ground (level bands), not by
          // distance from each column's own top (that zigzagged).
          const up = (yl - y) / (20 * k);
          if (fromTop < 2 * k) { r = sunny ? 226 : 204; g = sunny ? 188 : 166; b = sunny ? 136 : 116; }
          else if (up < 0.1) { r = 112; g = 82; b = 56; }
          else if (up < 0.35) { r = 150; g = 114; b = 78; }
          else { r = sunny ? 188 : 166; g = sunny ? 148 : 128; b = sunny ? 100 : 88; }
          this.block(d, w, h, yLo, xl, y, r | 0, g | 0, b | 0, back > 0.6 ? (ai * 0.6) | 0 : ai);
        }
      }
    }
  }

  /**
   * A field point on the near face, close to its middle, where `ok(cell)`
   * holds (dev: force a storm where it can be seen). Null if none.
   */
  faceSpot(ok: (k: number) => boolean, rnd: () => number): { x: number; y: number } | null {
    const lut = this.lut;
    for (let tries = 0; tries < 4000 && lut.count > 0; tries++) {
      const n = Math.floor(rnd() * lut.count);
      if (Math.abs(lut.dx[n]) > 0.55 || Math.abs(lut.dy[n]) > 0.45) continue;
      if (ok(this.cell[n])) return { x: lut.fx[n], y: lut.fy[n] };
    }
    return null;
  }

  /** One lookup pixel's screen block, inside the face span faceSpan last found. */
  private block(d: Uint8ClampedArray, w: number, h: number, yLo: number,
    xl: number, yl: number, r: number, g: number, b: number, ai: number): void {
    if (xl < this.spanLo || xl > this.spanHi) return;
    const vr = this.vr, vdx = this.vdx, vdy = this.vdy;
    const X0 = Math.floor(xl * vr + vdx), X1 = Math.max(X0 + 1, Math.floor((xl + 1) * vr + vdx));
    const Y0 = Math.floor(yl * vr + vdy), Y1 = Math.max(Y0 + 1, Math.floor((yl + 1) * vr + vdy));
    for (let Y = Y0 < yLo ? yLo : Y0; Y < Y1 && Y < h; Y++) {
      for (let X = X0 < 0 ? 0 : X0; X < X1 && X < w; X++) over(d, (Y * w + X) * 4, r | 0, g | 0, b | 0, ai);
    }
  }

  /** Free drop slot `q` (swap with the last live drop). */
  private removeDrop(q: number): void {
    const last = --this.pCount;
    this.pX[q] = this.pX[last]; this.pY[q] = this.pY[last]; this.pGround[q] = this.pGround[last];
    this.pSpawn[q] = this.pSpawn[last]; this.pVel[q] = this.pVel[last];
    this.pPhase[q] = this.pPhase[last]; this.pKind[q] = this.pKind[last];
    this.pSlant[q] = this.pSlant[last]; this.pSplash[q] = this.pSplash[last];
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
      // Typhoons rain hard under their arms and flash in the eyewall.
      const evl = sim.events.list;
      for (let e = 0; e < evl.length; e++) {
        const v = evl[e];
        if (v.kind !== VX.TYPHOON && v.kind !== VX.BLIZZARD) continue;
        const dist = WeatherPainter.fieldDist(v, lut.fx[n], lut.fy[n]) / v.r;
        if (dist >= 0.9) continue;
        this.roll();
        if (this.pCount < this.pmax && (rs[0] >>> 0) * INV32 < 0.6 * v.power) this.spawn(n, v.kind === VX.BLIZZARD ? 2 : 0);
        if (v.kind === VX.TYPHOON && dist > 0.12 && dist < 0.3 && flashes < boltCap && this.fCount < fmax) {
          this.roll();
          if ((rs[0] >>> 0) * INV32 < 0.05 * v.power) {
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
    // Gusts: a few per step where the band wind is strong, more the windier.
    for (let i = 0; i < 3 && this.gCount < this.gmax; i++) {
      this.roll();
      const m = (rs[0] >>> 0) % nLut;
      const fy = lut.fy[m], jr = fy < 0 ? 0 : fy > WX_NY - 1 ? WX_NY - 1 : Math.round(fy);
      const u = this.slant[jr] / SLANT_MAX, au = u < 0 ? -u : u;
      this.roll();
      if (au < 0.3 || (rs[0] >>> 0) * INV32 > au * 0.8) continue;
      const g = this.gCount++, k = this.gustScale;
      this.roll();
      const r = (rs[0] >>> 0) * INV32;
      this.gX[g] = lut.px[m]; this.gY[g] = lut.ground[m] - (2 + r * 4) * k;
      this.gVx[g] = (u < 0 ? -1 : 1) * GUST_SPEED * (0.6 + 0.4 * au) * k;
      this.gLife[g] = GUST_LIFE; this.gLen[g] = (5 + r * 7) * k;
      // The face's span on this row (entries are row-major, x ascending).
      const row = lut.py[m];
      this.gX0[g] = lut.px[this.rowFirst(row)]; this.gX1[g] = lut.px[this.rowFirst(row + 1) - 1];
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
    this.events = sim.events;
    this.tyR = 0;
    for (let e = 0; e < sim.events.list.length; e++) {
      const v = sim.events.list[e];
      if (v.kind === VX.TYPHOON || v.kind === VX.BLIZZARD) { this.tyX = v.x; this.tyY = v.y; this.tyR = v.r; this.tyP = v.power; }
    }
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
      this.rainF[k] = sim.snow[k] ? 0 : sim.precip[k] * sim.seedMask(k % WX_NX, (k / WX_NX) | 0, true);
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
      let maxU = 0;
      for (let j = 0; j < WX_NY; j++) {
        this.bandU[j] = sim.baseWindU(j);
        const u = this.bandU[j] < 0 ? -this.bandU[j] : this.bandU[j];
        if (u > maxU) maxU = u;
      }
      for (let j = 0; j < WX_NY; j++) this.slant[j] = maxU > 0 ? (this.bandU[j] / maxU) * SLANT_MAX : 0;
      this.bandSim = sim; this.bandClimate = sim.climate;
    }
    for (let j = 0; j < WX_NY; j++) this.shift[j] = this.bandU[j] * simTime;
    this.clock += dt;
    for (let q = this.pCount - 1; q >= 0; q--) {
      if (this.pSplash[q] > 0) {
        // Landed: the splash shows its frames, then the slot frees.
        this.pSplash[q] -= dt;
        if (this.pSplash[q] <= 0) this.removeDrop(q);
        continue;
      }
      const fall = this.pVel[q] * dt;
      this.pY[q] += fall;
      this.pX[q] += fall * this.pSlant[q];
      this.pPhase[q] += dt * 2.2;
      if (this.pY[q] >= this.pGround[q]) {
        // Rain splashes where it lands, unless the wind carried it past the
        // edge of the face (then it simply falls away).
        const gr = Math.round(this.pGround[q]), xq = this.pX[q];
        if (this.pKind[q] <= 1 && this.faceSpan(gr) && xq >= this.spanLo + 2 && xq <= this.spanHi - 2) {
          this.pY[q] = this.pGround[q];
          this.pSplash[q] = SPLASH_T;
        } else {
          this.removeDrop(q);
        }
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
    for (let g = this.gCount - 1; g >= 0; g--) {
      this.gX[g] += this.gVx[g] * dt;
      this.gLife[g] -= dt;
      if (this.gLife[g] <= 0) {
        const last = --this.gCount;
        this.gX[g] = this.gX[last]; this.gY[g] = this.gY[last]; this.gVx[g] = this.gVx[last];
        this.gLife[g] = this.gLife[last]; this.gLen[g] = this.gLen[last];
        this.gX0[g] = this.gX0[last]; this.gX1[g] = this.gX1[last];
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
  paintClouds(img: ImageDataLike, sunAzimuth: number, intensity: number, yLo = 0, yHi = img.height): void {
    // [yLo, yHi): the band of screen rows this call paints (all by default).
    // The host may repaint the clouds a band per frame; every write is
    // clipped to the band, so bands tile the image exactly.
    const lut = this.lut, d = img.data, w = img.width, h = yHi;
    const sunX = Math.cos(sunAzimuth), sunUp = ELEV_LIGHT * Math.sin(sunAzimuth);
    this.stats.drawn = 0; this.stats.midOrDense = 0;
    const vr = this.vr, vdx = this.vdx, vdy = this.vdy, one = vr === 1;
    const dX = this.ditherX, dY = this.ditherY;

    // Gusts: 1-px streaks fading in and out, brightest at the head, a tail behind.
    for (let g = 0; g < this.gCount; g++) {
      const life = this.gLife[g] / GUST_LIFE, fade = life > 0.5 ? (1 - life) * 2 : life * 2;
      const a0 = 0.38 * fade * intensity * A_ONE;
      const dir = this.gVx[g] < 0 ? 1 : -1;            // the tail trails behind the head
      const yb = Math.round(this.gY[g]), Y = one ? yb + vdy : Math.floor(yb * vr + vdy);
      if (Y < yLo || Y >= h) continue;
      const len = this.gLen[g] * (one ? 1 : vr);
      const hx = one ? Math.round(this.gX[g]) + vdx : Math.floor(this.gX[g] * vr + vdx);
      const lo = one ? this.gX0[g] + vdx : Math.floor(this.gX0[g] * vr + vdx);
      const hi = one ? this.gX1[g] + vdx : Math.floor((this.gX1[g] + 1) * vr + vdx) - 1;
      for (let i = 0; i < len; i++) {
        const X = hx + dir * i;
        if (X < 0 || X >= w || X < lo || X > hi) continue;
        over(d, (Y * w + X) * 4, 236, 244, 255, (a0 * (1 - i / len)) | 0);
      }
    }

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
      const sp = this.pSplash[q];
      if (sp > 0) {
        // Splash: a crown (two dots up and out), then a wider ring at the ground.
        const ring = sp < SPLASH_T * 0.5;
        const ox = ring ? 2 : 1, oy = ring ? 0 : -1;
        for (let e = -1; e <= 1; e += 2) {
          const X = x + e * ox, Y = ys + oy;
          if (X >= 0 && Y >= yLo && X < w && Y < h) over(d, (Y * w + X) * 4, 220, 236, 255, (ai * 0.9) | 0);
        }
        continue;
      }
      // A streak leaning with the wind: each row steps across by the slant.
      const sl = this.pSlant[q];
      for (let l = 0; l < len; l++) {
        const y = ys + l, X = x + Math.round((l - len + 1) * sl);
        if (X < 0 || y < yLo || X >= w || y >= h || y0 + l > this.pGround[q]) continue;
        over(d, (y * w + X) * 4, P_RGBA[o4], P_RGBA[o4 + 1], P_RGBA[o4 + 2], ai);
      }
    }

    const acid = this.climate.acid, neb = this.climate.nebula;
    const den = this.dens, tex = this.detail, shift = this.shift;
    const off = this.climate.personality.detailOffset;
    const sky = this.skyY, skyH = this.skyH;
    // View-bounded (spec 5b): lookup rows whose cloud (skyY, ≥ py - cloudLift)
    // can land in the view. cloudLift is still the max lift (far rim).
    const cl = this.cloudLift;
    // Volume clouds rise up to towerMax above their base: rows that far below
    // the band can still reach into it.
    // A band below the top also takes the rows whose rain curtains hang down
    // into it from clouds above it (up to cloudLift).
    const rA = Math.floor((yLo - vdy) / vr) + (yLo > 0 ? -1 : cl - 1), rB = Math.ceil((h - vdy) / vr) + cl + 1 + this.towerMax;
    const xA = Math.floor(-vdx / vr) - 1, xB = Math.ceil((w - vdx) / vr) + 1;
    const puffT = this.puff, tower = this.tower;
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
      // Unclipped base footprint; a volume cloud rises above it, so the band
      // clip comes after its height is known.
      if (one) {
        X0 = xl + vdx; Y0 = yl + vdy; Y1 = Y0 + yh; X1 = X0 + 1;
        if (X0 < 0 || X0 >= w || Y1 <= yLo || Y0 - this.towerMax >= h) continue;
      } else {
        X0 = Math.floor(xl * vr + vdx); X1 = Math.floor((xl + 1) * vr + vdx);
        Y0 = Math.floor(yl * vr + vdy); Y1 = Math.floor((yl + yh) * vr + vdy);
        if (X0 < 0) X0 = 0; if (X1 > w) X1 = w;
        if (X1 <= X0 || Y1 <= yLo || Y0 - this.towerMax * vr >= h) continue;
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
      // Puff domes on the same lattice: the heap's outline and its height.
      const pf = puffT[dr0 + da] * (1 - dfx) * (1 - dfy) + puffT[dr0 + db] * dfx * (1 - dfy)
               + puffT[dr1 + da] * (1 - dfx) * dfy + puffT[dr1 + db] * dfx * dfy;

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
      // This pixel's four cells and weights (a, b, r0, r1, tx, ty are reused
      // for the sunward sample below).
      const c00 = r0 + a, c01 = r0 + b, c10 = r1 + a, c11 = r1 + b, wtx = tx, wty = ty;
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
      } else if (kind === WK.CUMULUS || kind === WK.STORM) {
        // Heaps: the outline bulges with the puff domes, not the field cells.
        dd = dens * (0.12 + 1.15 * pf + 0.45 * det * det);
      } else {
        dd = dens * (0.2 + 1.6 * det * det);
      }
      if (this.tyR > 0) {
        // A typhoon owns its sky: ordinary cloud thins out under it, so the
        // spiral reads instead of drowning in the general cover.
        let ex = fx - this.tyX;
        if (ex > WX_NX / 2) ex -= WX_NX; else if (ex < -WX_NX / 2) ex += WX_NX;
        const ey = fy - this.tyY, q = Math.sqrt(ex * ex + ey * ey) / this.tyR;
        if (q < 1.15) dd *= 1 - this.tyP * (q < 0.85 ? 1 : (1.15 - q) / 0.3);
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
      // Rain curtain: under a raining cloud, faint streaks from its base to the
      // ground, every third world column, scrolling down. They read as the
      // grey shafts hanging under a shower; the drops still fall through them.
      if (((xl + dX) % 3 + 3) % 3 === 0) {
        const rf = this.rainF;
        const rain = rf[c00] * (1 - wtx) * (1 - wty) + rf[c01] * wtx * (1 - wty) + rf[c10] * (1 - wtx) * wty + rf[c11] * wtx * wty;
        if (rain > 0.01) {
          const ra = ((rain > 0.12 ? 0.3 : rain * 2.5) * intensity * A_ONE) | 0;
          const gy = one ? lut.ground[n] + vdy : Math.floor(lut.ground[n] * vr + vdy);
          const roll = (this.clock * 34 * vr) | 0;
          for (let Y = Y1 < yLo ? yLo : Y1, Ye = gy < h ? gy : h; Y < Ye; Y++) {
            // Dashes 3 on / 2 off, moving down.
            if ((((Y - roll) % 5) + 5) % 5 > 2) continue;
            for (let X = X0; X < X1; X++) over(d, (Y * w + X) * 4, 150, 170, 196, ra);
          }
        }
      }
      // Tower height blended over the four cells' kinds (bilinear), never the
      // dithered kind: a storm/cumulus dither made a comb of tall/short columns.
      const kc = this.kind;
      const tw = tower[kind] === 0 ? 0
        : tower[kc[c00]] * (1 - wtx) * (1 - wty) + tower[kc[c01]] * wtx * (1 - wty)
        + tower[kc[c10]] * (1 - wtx) * wty + tower[kc[c11]] * wtx * wty;
      if (tw <= 0.5) {
        // Flat layers, and the thin fringe of a heap: one sheet at the base.
        const ya = Y0 < yLo ? yLo : Y0, yb = Y1 > h ? h : Y1;
        for (let Y = ya; Y < yb; Y++) for (let X = X0; X < X1; X++) over(d, (Y * w + X) * 4, r | 0, g | 0, bl | 0, ai);
        continue;
      }
      // Volume: a column from the cloud's top down to its base. The top is
      // the puff field (cauliflower domes) over the density; nearer columns
      // (later rows) cover the sides of farther ones, so only a heap's front
      // and its top read. Four tones: lit dome, body, shaded side, base.
      // Sunward neighbour on the puff field: a dome facet facing the sun.
      const qx = dtx + sunX * 0.7, qy = dty - 0.45;
      const qi = Math.floor(qx), qj = Math.floor(qy), qfx = qx - qi, qfy = qy - qj;
      const qa = ((qi % DT_W) + DT_W) % DT_W, qb = (qa + 1) % DT_W;
      const qr0 = (((qj % DT_H) + DT_H) % DT_H) * DT_W, qr1 = (((qj + 1) % DT_H + DT_H) % DT_H) * DT_W;
      const pq = puffT[qr0 + qa] * (1 - qfx) * (1 - qfy) + puffT[qr0 + qb] * qfx * (1 - qfy)
               + puffT[qr1 + qa] * (1 - qfx) * qfy + puffT[qr1 + qb] * qfx * qfy;
      // Height eases from 0 at the fringe, so the edge never dithers between
      // a flat sheet and a column.
      // Height saturates just inside the edge (smoothstep over 0.34..0.56): a
      // linear ramp to the centre made every heap a cone. The body is level and
      // the puffs dome it; the fringe is a short wall, not a slope.
      let core = dd >= 0.56 ? 1 : dd <= 0.34 ? 0 : (dd - 0.34) / 0.22;
      core = core * core * (3 - 2 * core);
      let T = tw * (0.15 + 0.85 * core) * (0.45 + 0.55 * pf);
      if (kind === WK.STORM && T > tw * ANVIL) T = tw * ANVIL;
      const Ts = Math.round(T * vr);
      const topRows = Math.max(1, Math.round(2 * vr));
      // Tones from the kind's palette (body = sunlit, under = shade), lit by
      // the disc light; the dome facet facing the sun lifts toward white.
      const ob = kind * 6;
      let bR = PAL[ob], bG = PAL[ob + 1], bB = PAL[ob + 2];
      let uR = PAL[ob + 3], uG = PAL[ob + 4], uB = PAL[ob + 5];
      if (acid > 0) {
        // Acid skies tint the heaps too (body and base), as they do the flat cover.
        bR += (ACID[0] - bR) * acid; bG += (ACID[1] - bG) * acid; bB += (ACID[2] - bB) * acid;
        uR += (ACID[3] - uR) * acid; uG += (ACID[4] - uG) * acid; uB += (ACID[5] - uB) * acid;
      }
      // Low sun (near the terminator) warms the sunlit faces: gold at dawn and dusk.
      const wd = rawLit - 0.42, wrm = facing && rawLit > 0.18 ? (wd < 0 ? -wd : wd) < 0.2 ? 1 - (wd < 0 ? -wd : wd) / 0.2 : 0 : 0;
      bR = (bR + 46 * wrm) * lit; bG = (bG + 10 * wrm) * lit; bB = (bB - 30 * wrm) * lit;
      uR *= lit; uG *= lit; uB *= lit;
      // Dome facets: toward the sun (the puff falls off sunward) lit, away
      // from it in shade — the cauliflower read. Three steps.
      const slope = pf - pq;
      const sh = slope > 0.03 ? 0 : slope > -0.03 ? (facing ? 0.12 : 0.3) : 0.5;
      const lift = slope > 0.03 ? 0.3 : 0;
      let tR = bR + (255 - bR) * lift + (uR - bR) * sh;
      let tG = bG + (255 - bG) * lift + (uG - bG) * sh;
      let tB = bB + (255 - bB) * lift + (uB - bB) * sh;
      // Silver lining: an edge facing the sun (clear air sunward) catches a
      // bright rim along its top and upper side.
      const rim = facing && sunward < 0.3;
      if (rim) { tR += (255 - tR) * 0.45; tG += (255 - tG) * 0.45; tB += (255 - tB) * 0.4; }
      const top = Y0 - Ts;
      const ya = top < yLo ? yLo : top, yb = Y1 > h ? h : Y1;
      for (let Y = ya; Y < yb; Y++) {
        let cr: number, cg: number, cb: number;
        const fromTop = Y - top;
        if (fromTop < topRows) { cr = tR; cg = tG; cb = tB; }
        else {
          // The side darkens toward the base, keyed on the height above the
          // base (not this column's own span), so the steps run as level
          // bands across the whole heap instead of stripes down each column.
          const above = (Y1 - Y) / (tw * vr + 1);
          const s2 = above > 0.6 ? (rim ? 0 : 0.15) : above > 0.3 ? 0.42 : above > 0.1 ? 0.7 : 1;
          cr = bR + (uR - bR) * s2; cg = bG + (uG - bG) * s2; cb = bB + (uB - bB) * s2;
        }
        for (let X = X0; X < X1; X++) over(d, (Y * w + X) * 4, cr | 0, cg | 0, cb | 0, ai);
      }
      }
    }
    this.visited.clouds = visited;
    const it = (globalThis as { __zoomIters?: Record<string, number> }).__zoomIters;
    if (it) it.clouds = (it.clouds ?? 0) + visited;

    const ev = this.events;
    if (ev) {
      for (let e = 0; e < ev.list.length; e++) {
        const v = ev.list[e];
        if (!this.mapField(v.x, v.y)) continue;
        switch (v.kind) {
          case VX.TYPHOON: case VX.BLIZZARD: this.paintSpiral(d, w, h, yLo, v, sunX, sunUp, intensity); break;
          case VX.SUPERCELL: this.paintSupercell(d, w, h, yLo, v, sunX, intensity); break;
          case VX.HABOOB: this.paintHaboob(d, w, h, yLo, v, sunX, intensity); break;
          default: this.paintFunnel(d, w, h, yLo, v, sunX, intensity);
        }
      }
    }

    const HR = this.haloR, WA = this.wander;
    for (let f = 0; f < this.fCount; f++) {
      let s = this.fSeed[f], bx = this.fX[f];
      const x0 = this.fX[f];
      const bolt = (0.95 * intensity * A_ONE) | 0, halo = 0.35 * intensity * A_ONE;
      let forks = 0;
      const yTop = Math.round(this.fY[f]), yEnd = this.fGround[f];
      for (let y = yTop; y < yEnd; y++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const r = s * INV32;
        if (r < 0.15) bx--; else if (r > 0.85) bx++;
        if (bx < x0 - WA) bx = x0 - WA; else if (bx > x0 + WA) bx = x0 + WA;
        // A 1-px stroke at its mapped spot.
        const X = one ? bx + vdx : Math.floor(bx * vr + vdx), Y = one ? y + vdy : Math.floor(y * vr + vdy);
        if (X >= 0 && Y >= yLo && X < w && Y < h) over(d, (Y * w + X) * 4, 255, 255, 230, bolt);
        // Forks: up to two short dimmer branches splitting off sideways and down.
        if (forks < 2 && y > yTop + 2 && r > 0.47 && r < 0.53) {
          forks++;
          const dir = r < 0.5 ? -1 : 1, flen = 3 + (s & 3);
          let fx = X, fy = Y;
          for (let i = 0; i < flen; i++) {
            fx += dir; if (i & 1) fy++;
            if (fx >= 0 && fy >= yLo && fx < w && fy < h) over(d, (fy * w + fx) * 4, 220, 228, 255, (bolt * 0.6) | 0);
          }
        }
      }
      // The strike: a small bright burst where the bolt meets the ground.
      {
        const X = one ? bx + vdx : Math.floor(bx * vr + vdx);
        const Y = one ? Math.round(yEnd) - 1 + vdy : Math.floor((yEnd - 1) * vr + vdy);
        for (let e = -1; e <= 1; e++) {
          const xx = X + e;
          if (xx >= 0 && Y >= yLo && xx < w && Y < h) over(d, (Y * w + xx) * 4, 255, 250, 220, e === 0 ? bolt : (bolt * 0.5) | 0);
        }
      }
      const fy0 = Math.round(this.fY[f]);
      const cxs = one ? x0 + vdx : Math.floor(x0 * vr + vdx), fy = one ? fy0 + vdy : Math.floor(fy0 * vr + vdy);
      for (let oy = -HR; oy <= HR; oy++) for (let ox = -HR; ox <= HR; ox++) {
        const x = cxs + ox, y = fy + oy;
        const fall = 1 - Math.sqrt(ox * ox + oy * oy) / HR;
        if (fall <= 0 || x < 0 || y < yLo || x >= w || y >= h) continue;
        over(d, (y * w + x) * 4, 230, 235, 255, (halo * fall) | 0);
      }
    }
  }
}
