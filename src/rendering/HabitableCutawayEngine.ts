/**
 * HabitableCutawayEngine — cutaway bake pipeline for earth-like worlds.
 *
 * Reference: `assets/mockups/habitable-diorama-target.png` (habitable, with
 * atmosphere) and `assets/mockups/ocean-cutaway-ref.jpg` (bare ocean slab).
 *
 * ── The geometry ──────────────────────────────────────────────────────────────
 * The living surface is a foreshortened pancake ellipse. A sheer wall drops
 * from the front rim, then a jagged keel of crust hangs beneath it — a torn-off
 * chunk, not a filled sphere. Air is a faint ozone half-dome over the pancake,
 * brightest as a limb against space, and it fades as the camera zooms in.
 *
 *        cyTop − rx               ─── top of the ozone half-dome
 *        cyTop − ry               ─── far rim of the tabletop
 *        cyTop                    ─── ellipse centre / dome centre
 *        cyTop + ry               ─── front of the ellipse rim
 *        cyTop + ry + wall        ─── bottom of the cake wall (water / cliff)
 *        wall + keel              ─── jagged hanging crust (varies per column)
 *
 * ── Why a separate file ───────────────────────────────────────────────────────
 * The legacy path in `IsoDioramaRenderer` renders a *floating disc* under a
 * glass dome: soft pulsing halo, specular sweep, jagged keel hanging in space.
 * That is a different object from the mockup, and the two looks cannot share a
 * bake without one of them being compromised. Every planet type now bakes here
 * as a pancake cutaway; gas giants keep latitude bands + rings instead of a sphere.
 *
 * ── Art direction ─────────────────────────────────────────────────────────────
 * Limited palettes, hard edges, no soft gradients on anything that is supposed
 * to be solid. Lighting is quantised into visible steps (`quantise`) so the
 * upscale shows deliberate bands rather than dither noise, and strata are keyed
 * to ABSOLUTE screen depth so the layers run horizontally across the whole mass
 * instead of following each column's own profile.
 */

import type { PlanetGrid, BiomeType } from '../simulation/PlanetGrid';
import { classifyBiome, isWater, SEA_LEVEL, GRID_SIZE, riverAt } from '../simulation/PlanetGrid';
import { genomeFromLegacy, ATMO_THICKNESS_MAX_PX, type AtmosphereChannel } from '../simulation/PlanetGenome';
import {
  planSurfaceDecals, stampDecals, PAINTER_SNOW_ELEVATION,
  type DecalAtlas, type DecalKind, type DecalSite,
} from './SurfaceDecals';
import { applyCamera, identityCamera, isIdentity, type Camera } from './ZoomCamera';
import type { ClimateSources } from './weather/WeatherClimate';
import { WeatherSim, WX_DT, WX_WARMUP } from './weather/WeatherSim';
import { WeatherPainter, buildWeatherLut, weatherLutSteps, WEATHER_PMAX } from './weather/WeatherPainter';
import { ELEV_LIGHT } from './sky/SunLight';
//
// COUPLED CONSTANT — `PAINTER_SNOW_ELEVATION` is this painter's own snow
// threshold (used at the reclassification site below), but it LIVES in
// `SurfaceDecals.ts` on purpose. This module value-imports that one; that one
// only TYPE-imports this (erased at compile), so the dependency runs one way
// at runtime. Declaring the constant here and importing it there would close
// that into a real runtime import cycle. `DECAL_SNOW_LINE` is derived from it
// so the decal planner can never stamp onto a cap this painter renders white.

// ─── Small colour + noise helpers ─────────────────────────────────────────────
//
// Duplicated from IsoDioramaRenderer rather than exported from it: this engine
// is meant to be replaceable without editing the 2700-line consumer, and these
// are four short pure functions.

export interface RGB { r: number; g: number; b: number }

const rgb = (r: number, g: number, b: number): RGB => ({ r, g, b });
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const css = (c: RGB, a = 1) => `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${a})`;
const shade = (c: RGB, f: number): RGB =>
  rgb(Math.min(255, c.r * f), Math.min(255, c.g * f), Math.min(255, c.b * f));

/** Integer hash → [0,1). */
function hash1(n: number, seed: number): number {
  let h = (n * 374761393 + seed * 2654435761) | 0;
  h = ((h ^ (h >>> 13)) * 1540483477) | 0;
  h = h ^ (h >>> 15);
  return ((h >>> 0) & 0xffff) / 0xffff;
}

/** 1-D smooth value noise. */
function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1(i, seed);
  const b = hash1(i + 1, seed);
  return a + (b - a) * u;
}

/** Layered 1-D noise, used for the rock profile and strata waves. */
function fbm1(x: number, seed: number, octaves = 4): number {
  let v = 0, amp = 0.5, freq = 1, max = 0;
  for (let i = 0; i < octaves; i++) {
    v += amp * noise1(x * freq, seed + i * 131);
    max += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return v / max;
}

/** Deterministic scatter stream. */
class Stream {
  private s: number;
  constructor(seed: number) { this.s = (seed >>> 0) || 1; }
  next(): number {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
  range(a: number, b: number): number { return a + this.next() * (b - a); }
  int(a: number, b: number): number { return Math.floor(this.range(a, b + 1)); }
  pick<T>(arr: T[]): T { return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))]; }
}

/**
 * Snap a lighting factor to visible steps.
 *
 * A continuous light ramp on a nearest-neighbour upscale turns into one-pixel
 * banding that reads as noise. Stepping it makes the bands intentional, which
 * is what the mockup's blocky shading actually is.
 */
const SHADE_STEP = 0.11;
/** Wet-bank width beside a river, in grid columns (≈1 px at the identity view). */
const RIVER_BANK = 0.24;
const quantise = (f: number, step = SHADE_STEP) => Math.round(f / step) * step;

// ─── Public geometry ──────────────────────────────────────────────────────────

export type HabitableType =
  | 'ocean' | 'rocky' | 'ice' | 'lava' | 'gas'
  | 'toxic' | 'crystal' | 'desert' | 'storm' | 'carbon';

/** Alias — every planet type uses the cutaway bake. */
export type CutawayPlanetType = HabitableType;

// ─── Pancake god-view geometry (source of truth for Task 7+ host) ─────────────

export const BOARD_SQUASH = 0.52;
export const BOARD_WIDTH = 0.91;
export const WALL_RATIO = 0.38;
export const ATMO_RATIO = 0.25;
export const ATMO_MIN_PX = 14;
export const CY_TOP_DROP = 0.67; // cyTop = cyBody - 0.67 * R

/** Clear space kept above the dome's air and below the keel, in px. */
export const FRAME_MARGIN_PX = 4;

/**
 * How far past the dome the ozone band can reach for a shell of `thicknessPx`:
 * the wobble swings it by up to ±55% (WOBBLE_AMP), plus 2px of feather.
 * paintAtmosphere and the layout both read this, so they cannot disagree.
 */
export function ozoneFadeMax(thicknessPx: number): number {
  return thicknessPx * 1.6 + 2;
}

/** Deepest the hanging keel can drop below the front wall. */
export function crustDepthOf(rx: number): number {
  return Math.max(8, Math.round(rx * 0.88));
}

/** Lowest pixel the crust can reach: rim front + wall + ridge (±2.5) + keel. */
export function keelBottomOf(g: Pick<HabitableGeom, 'cyTop' | 'rx' | 'ry' | 'wall'>): number {
  return g.cyTop + g.ry + g.wall + 3 + crustDepthOf(g.rx);
}

export interface HabitableGeom {
  cx: number;
  cyBody: number;
  cyTop: number;
  R: number;
  rx: number;
  ry: number;
  wall: number;
  T: number;
}

/** Whole-planet bounce. Disabled — the board stays planted. */
export function bobOf(_elapsed: number, _R: number): number {
  return 0;
}

/**
 * Lay the body out for one R. Pushes the whole body down if the dome's air
 * would leave the top of the canvas — there is empty space under the keel in
 * every normal view, so moving is cheaper than shrinking.
 */
function layoutAt(VW: number, VH: number, R: number): HabitableGeom {
  const T = Math.max(ATMO_MIN_PX, Math.round(R * ATMO_RATIO));
  const cx = Math.round(VW / 2);
  const rx = Math.max(8, Math.round(R * BOARD_WIDTH));
  const ry = Math.max(6, Math.round(rx * BOARD_SQUASH));
  const wall = Math.max(4, Math.round(rx * WALL_RATIO));
  let cyBody = Math.round(VH * 0.56);
  let cyTop = Math.round(cyBody - CY_TOP_DROP * R);
  const domeTop = cyTop - rx - Math.ceil(ozoneFadeMax(ATMO_THICKNESS_MAX_PX));
  if (domeTop < FRAME_MARGIN_PX) {
    const shift = FRAME_MARGIN_PX - domeTop;
    cyBody += shift;
    cyTop += shift;
  }
  return { cx, cyBody, cyTop, R, rx, ry, wall, T };
}

export function habitableGeom(VW: number, VH: number): HabitableGeom {
  let R = Math.round(Math.min(VW * 0.50, VH * 0.36));
  const T = Math.max(ATMO_MIN_PX, Math.round(R * ATMO_RATIO));
  // If the shell would clip, shrink R — never shrink T below ATMO_MIN_PX.
  const maxR = Math.floor(Math.min(VW, VH) / 2 - T - 4);
  if (R > maxR) R = Math.max(16, maxR);
  // The dome must fit above and the keel below. Moving the body down (in
  // layoutAt) spends the space under the keel; only when that runs out does
  // the body shrink. Each step down in R raises the dome top and the keel
  // bottom together, so this terminates well before the 16px floor in any
  // real view — the floor is only a guard for degenerate sizes.
  for (;;) {
    const g = layoutAt(VW, VH, R);
    if (R <= 16 || keelBottomOf(g) <= VH - FRAME_MARGIN_PX) return g;
    R -= 1;
  }
}

export interface CutawayGeom {
  /** Horizontal centre of the body, in virtual pixels. */
  cx: number;
  /** Centre of the top-face ellipse. */
  cyTop: number;
  /** Top-face x-radius. */
  rx: number;
  /** Top-face y-radius. */
  ry: number;
}

export interface CutawayBakeOpts extends CutawayGeom {
  /** Body-circle radius. Optional until the legacy host adopts habitableGeom. */
  R?: number;
  /** Height of the sheer front wall. Optional until the legacy host adopts it. */
  wall?: number;
  /** Vertical centre of the body circle. Optional for legacy host compatibility. */
  cyBody?: number;
  /** Size of the layer canvases, in virtual pixels. */
  w: number;
  h: number;
  seed: number;
  grid: PlanetGrid | null;
  planetType: HabitableType;
  /**
   * Young ground (a world still forming): land is bare rock and regolith
   * whatever its climate biome, and no flora decals are planned.
   */
  barren?: boolean;
  /** Draw no river channels (a world before its rains). */
  noRivers?: boolean;

  /** Inverse azimuthal projection: disc [-1,1]² → grid cell, null off-face. */
  discToGrid: (dx: number, dy: number) => { row: number; col: number } | null;
  /** Elevation penalty toward the rim, so land sits inside a ring of ocean. */
  rimFalloff: (r: number) => number;
  /** Screen-pixel lift for an elevation, already terraced. */
  liftOf: (elev: number) => number;
  /** Elevation averaged over a cell's neighbours, to avoid stipple cliffs. */
  smoothElevation: (grid: PlanetGrid, row: number, col: number) => number;
  /**
   * Sub-cell elevation: `smoothElevation` interpolated bilinearly at the disc
   * point's FRACTIONAL grid position, null off-face (the caller subtracts
   * rimFalloff). Used only by camera bakes (`cameraZoom > 1`): there the
   * land/water test, the coast outline, the relief lift and the weather's
   * ground lift follow it, so edges resolve between cells. The identity bake
   * ignores it and stays nearest-cell, byte-identical to the pre-zoom render
   * (Ruling 11). Biome colour, placement and picking always use the nearest cell.
   */
  elevationAt?: (dx: number, dy: number) => number | null;
  /**
   * `discToGrid` without the rounding: the FRACTIONAL grid position (row i's
   * centre at row i, column j's at col j + 0.5). Only a camera layer set's
   * weather lookup reads it, so cloud edges follow the pixel instead of
   * stair-stepping per planet cell (Ruling 3). The identity lookup stays
   * nearest-cell, as before zoom.
   */
  discToGridF?: (dx: number, dy: number) => { row: number; col: number } | null;
  /**
   * Zoom k of the camera this bake renders; undefined = 1 (identity). World-
   * class constants scale by k, per-px texture frequencies divide by it, 1-px
   * line thresholds divide by it (see the zoom-camera inventory). The engine's
   * camera bake sets it together with `camera`, the camera geometry, and a
   * `liftOf` / `maxLift` already multiplied by k.
   */
  cameraZoom?: number;
  /**
   * The camera that maps this bake's screen pixels to base-world pixels
   * (`screenToWorld`). Hashes and noise are keyed on world coordinates through
   * it, so panning does not shift them. Undefined = identity (screen = world).
   */
  camera?: Camera;
  /**
   * Decals to stamp, already in this bake's screen coordinates. When given, the
   * painter stamps these instead of planning — the camera bake passes the
   * IDENTITY plan mapped through the camera, so zooming never re-plans.
   */
  decalSites?: DecalSite[] | null;
  /**
   * Deepest the hanging keel may drop, in this bake's px. Omitted:
   * `crustDepthOf(base rx) * k`. The camera bake passes it explicitly, so the
   * keel depth is one world value scaled once.
   */
  crustDepthPx?: number;
  /** Volcano chimneys to paint, in this bake's screen coordinates; same rule as `decalSites`. */
  chimneySites?: VolcanoChimney[] | null;
  /** Tallest lift `liftOf` can return, so the bake can reserve rows above the rim. */
  maxLift: number;

  /** How lush the biosphere is, 0–1. Greens up vegetated land. */
  lush?: number;
  /** `planet.genomeSeed`. Decals are stable across saves and re-bakes. */
  decalSeed?: number;
  /**
   * Atlas-cell multiplier for one decal. Ordinary cover is well under 1 so
   * the ground stays visible; a gigantic flora lineage can return about 1.
   */
  decalScale?: (row: number, col: number, kind: DecalKind) => number;
  /** Loaded decal atlas, or null to use the procedural fallback. */
  decalAtlas?: DecalAtlas | null;
  /**
   * Written with `row * GRID_SIZE + col + 1` for every surface pixel painted,
   * so picking hits the cell that was actually DRAWN at a pixel rather than the
   * flat projection of it. Length must be `w * h`. Water cells still stamp pick
   * even though they leave the land canvas empty.
   */
  pick?: Int32Array | null;
  /** Length `w * h`, 1 = fluid on the ellipse. */
  occupancy?: Uint8Array | null;
  /** Precomputed gas latitude bands (seeded once by the engine). */
  gasBands?: RGB[] | null;
}

export interface CutawayBakeResult {
  /** Flat biome tabletop (the cut face). */
  surface: HTMLCanvasElement;
  /** Cutaway water column + rock strata + ember core. */
  crust: HTMLCanvasElement;
}

// ─── Palettes ─────────────────────────────────────────────────────────────────

interface CutawayPalette {
  /** Punchier, more saturated biome table than the shared map colours. */
  biome: Record<BiomeType, RGB>;
  /** Coastal and rim foam. */
  foam: RGB;
  /** Surface water bands (tabletop) — deep → mid → light → glint. */
  waterSurf: { deep: RGB; mid: RGB; light: RGB; glint: RGB };
  /** Cutaway water column, lip → floor. */
  waterLip: RGB;
  waterDeep: RGB;
  /** Highlight on the water cylinder's facet edges. */
  facet: RGB;
  /**
   * Crust bands. `strata[0]` is the sea-floor silt lip, which hugs the rock's
   * own profile; `strata[1..]` are true geological layers at fixed screen depth.
   */
  strata: RGB[];
  ember: RGB;
  emberHot: RGB;
}

const OCEAN_PALETTE: CutawayPalette = {
  biome: {
    deep_ocean: rgb(18, 48, 88),
    ocean:      rgb(35, 95, 160),
    shallow:    rgb(70, 150, 220),
    beach:      rgb(215, 200, 145),
    plains:     rgb(128, 168, 80),
    grassland:  rgb(52, 125, 60),
    forest:     rgb(40, 100, 48),
    jungle:     rgb(28, 88, 42),
    desert:     rgb(214, 186, 120),
    savanna:    rgb(176, 158, 90),
    tundra:     rgb(148, 164, 156),
    snow:       rgb(235, 242, 250),
    mountain:   rgb(112, 94, 80),
    volcanic:   rgb(96, 30, 12),
  },
  foam:      rgb(226, 244, 255),
  // Shore shelf stays mid; open ocean drops to a darker navy body.
  waterSurf: {
    deep:  rgb(12, 52, 118),
    mid:   rgb(42, 108, 178),
    light: rgb(90, 168, 220),
    glint: rgb(175, 220, 245),
  },
  waterLip:  rgb(42, 88, 142),
  waterDeep: rgb(22, 45, 80),
  facet:     rgb(155, 205, 240),
  strata: [
    rgb(40, 50, 66),
    rgb(92, 68, 52),
    rgb(138, 96, 62),
    rgb(104, 66, 44),
    rgb(60, 38, 32),
    rgb(32, 20, 18),
  ],
  ember:    rgb(206, 84, 26),
  emberHot: rgb(255, 184, 74),
};

const ROCKY_PALETTE: CutawayPalette = {
  biome: {
    deep_ocean: rgb(22, 54, 92),
    ocean:      rgb(40, 90, 140),
    shallow:    rgb(75, 145, 200),
    beach:      rgb(214, 192, 140),
    plains:     rgb(152, 166, 96),
    grassland:  rgb(118, 152, 78),
    forest:     rgb(66, 110, 60),
    jungle:     rgb(44, 92, 52),
    desert:     rgb(222, 190, 124),
    savanna:    rgb(190, 164, 96),
    tundra:     rgb(156, 162, 152),
    snow:       rgb(232, 242, 246),
    mountain:   rgb(126, 104, 84),
    volcanic:   rgb(100, 34, 14),
  },
  foam:      rgb(224, 240, 252),
  waterSurf: {
    deep:  rgb(22, 50, 90),
    mid:   rgb(45, 90, 150),
    light: rgb(90, 155, 215),
    glint: rgb(190, 230, 255),
  },
  waterLip:  rgb(45, 90, 150),
  waterDeep: rgb(25, 50, 90),
  facet:     rgb(160, 210, 245),
  strata: [
    rgb(58, 52, 52),
    rgb(116, 84, 60),
    rgb(154, 112, 74),
    rgb(112, 74, 50),
    rgb(68, 46, 38),
    rgb(34, 22, 20),
  ],
  ember:    rgb(198, 78, 24),
  emberHot: rgb(255, 176, 70),
};

const ICE_PALETTE: CutawayPalette = {
  biome: {
    deep_ocean: rgb(40, 90, 130),
    ocean:      rgb(70, 140, 185),
    shallow:    rgb(130, 190, 220),
    beach:      rgb(200, 220, 230),
    plains:     rgb(180, 210, 225),
    grassland:  rgb(150, 185, 200),
    forest:     rgb(120, 160, 180),
    jungle:     rgb(100, 145, 170),
    desert:     rgb(210, 225, 235),
    savanna:    rgb(190, 210, 225),
    tundra:     rgb(168, 200, 224),
    snow:       rgb(240, 248, 255),
    mountain:   rgb(140, 170, 195),
    volcanic:   rgb(90, 110, 140),
  },
  foam:      rgb(245, 252, 255),
  waterSurf: {
    deep:  rgb(50, 100, 145),
    mid:   rgb(90, 155, 195),
    light: rgb(150, 205, 235),
    glint: rgb(220, 245, 255),
  },
  waterLip:  rgb(70, 130, 175),
  waterDeep: rgb(40, 80, 120),
  facet:     rgb(200, 235, 255),
  strata: [
    rgb(214, 236, 248),
    rgb(168, 200, 224),
    rgb(126, 158, 190),
    rgb(90, 118, 152),
    rgb(62, 84, 116),
    rgb(38, 54, 80),
  ],
  ember:    rgb(160, 200, 230),
  emberHot: rgb(220, 240, 255),
};

const LAVA_PALETTE: CutawayPalette = {
  biome: {
    deep_ocean: rgb(80, 20, 10),
    ocean:      rgb(140, 35, 12),
    shallow:    rgb(200, 60, 18),
    beach:      rgb(90, 40, 28),
    plains:     rgb(70, 32, 22),
    grassland:  rgb(60, 28, 18),
    forest:     rgb(50, 24, 16),
    jungle:     rgb(45, 22, 14),
    desert:     rgb(100, 45, 25),
    savanna:    rgb(85, 38, 20),
    tundra:     rgb(55, 30, 28),
    snow:       rgb(120, 70, 50),
    mountain:   rgb(48, 24, 18),
    volcanic:   rgb(36, 16, 12),
  },
  foam:      rgb(255, 160, 60),
  waterSurf: {
    deep:  rgb(120, 30, 8),
    mid:   rgb(190, 55, 14),
    light: rgb(255, 110, 30),
    glint: rgb(255, 200, 80),
  },
  waterLip:  rgb(180, 50, 14),
  waterDeep: rgb(90, 22, 8),
  facet:     rgb(255, 140, 50),
  strata: [
    rgb(96, 40, 26),
    rgb(140, 52, 22),
    rgb(72, 28, 20),
    rgb(48, 20, 16),
    rgb(30, 14, 12),
    rgb(18, 8, 8),
  ],
  ember:    rgb(255, 120, 30),
  emberHot: rgb(255, 210, 90),
};

const GAS_PALETTE: CutawayPalette = {
  biome: {
    deep_ocean: rgb(120, 90, 60),
    ocean:      rgb(180, 140, 90),
    shallow:    rgb(210, 170, 110),
    beach:      rgb(190, 155, 120),
    plains:     rgb(170, 130, 85),
    grassland:  rgb(150, 115, 75),
    forest:     rgb(130, 100, 70),
    jungle:     rgb(110, 85, 65),
    desert:     rgb(200, 160, 100),
    savanna:    rgb(175, 140, 95),
    tundra:     rgb(160, 140, 150),
    snow:       rgb(210, 200, 220),
    mountain:   rgb(100, 80, 90),
    volcanic:   rgb(90, 50, 40),
  },
  foam:      rgb(230, 210, 180),
  waterSurf: {
    deep:  rgb(100, 75, 55),
    mid:   rgb(160, 120, 80),
    light: rgb(200, 165, 110),
    glint: rgb(240, 220, 180),
  },
  waterLip:  rgb(140, 105, 75),
  waterDeep: rgb(80, 55, 40),
  facet:     rgb(220, 190, 150),
  strata: [
    rgb(168, 132, 84),
    rgb(120, 92, 62),
    rgb(96, 68, 108),
    rgb(70, 48, 84),
    rgb(46, 32, 60),
    rgb(28, 20, 40),
  ],
  ember:    rgb(200, 140, 80),
  emberHot: rgb(255, 200, 120),
};

const TOXIC_PALETTE: CutawayPalette = {
  biome: {
    deep_ocean: rgb(28, 72, 28),
    ocean:      rgb(48, 130, 40),
    shallow:    rgb(90, 180, 55),
    beach:      rgb(160, 175, 70),
    plains:     rgb(120, 150, 55),
    grassland:  rgb(70, 140, 45),
    forest:     rgb(45, 110, 38),
    jungle:     rgb(35, 95, 32),
    desert:     rgb(170, 165, 70),
    savanna:    rgb(140, 150, 55),
    tundra:     rgb(100, 130, 90),
    snow:       rgb(200, 220, 170),
    mountain:   rgb(80, 95, 55),
    volcanic:   rgb(70, 50, 20),
  },
  foam:      rgb(200, 255, 140),
  waterSurf: {
    deep:  rgb(28, 72, 28),
    mid:   rgb(48, 130, 40),
    light: rgb(90, 180, 55),
    glint: rgb(180, 255, 120),
  },
  waterLip:  rgb(55, 120, 45),
  waterDeep: rgb(25, 60, 25),
  facet:     rgb(160, 230, 100),
  strata: [
    rgb(50, 60, 40),
    rgb(90, 85, 45),
    rgb(120, 100, 50),
    rgb(80, 70, 40),
    rgb(45, 40, 28),
    rgb(25, 22, 16),
  ],
  ember:    rgb(180, 200, 40),
  emberHot: rgb(230, 255, 90),
};

const CRYSTAL_PALETTE: CutawayPalette = {
  biome: {
    deep_ocean: rgb(40, 20, 80),
    ocean:      rgb(70, 40, 130),
    shallow:    rgb(120, 70, 180),
    beach:      rgb(180, 140, 200),
    plains:     rgb(150, 80, 170),
    grassland:  rgb(130, 60, 160),
    forest:     rgb(100, 45, 140),
    jungle:     rgb(85, 35, 125),
    desert:     rgb(190, 120, 200),
    savanna:    rgb(160, 90, 175),
    tundra:     rgb(160, 140, 200),
    snow:       rgb(230, 210, 255),
    mountain:   rgb(110, 60, 150),
    volcanic:   rgb(80, 30, 90),
  },
  foam:      rgb(240, 200, 255),
  waterSurf: {
    deep:  rgb(40, 20, 80),
    mid:   rgb(70, 40, 130),
    light: rgb(130, 80, 200),
    glint: rgb(220, 180, 255),
  },
  waterLip:  rgb(90, 50, 150),
  waterDeep: rgb(35, 18, 70),
  facet:     rgb(210, 160, 255),
  strata: [
    rgb(60, 40, 80),
    rgb(100, 55, 120),
    rgb(140, 70, 160),
    rgb(90, 45, 110),
    rgb(50, 30, 70),
    rgb(28, 16, 40),
  ],
  ember:    rgb(200, 100, 255),
  emberHot: rgb(255, 180, 255),
};

const DESERT_PALETTE: CutawayPalette = {
  biome: {
    deep_ocean: rgb(50, 70, 90),
    ocean:      rgb(70, 100, 120),
    shallow:    rgb(110, 140, 150),
    beach:      rgb(220, 195, 140),
    plains:     rgb(210, 175, 110),
    grassland:  rgb(190, 160, 95),
    forest:     rgb(150, 125, 70),
    jungle:     rgb(130, 110, 60),
    desert:     rgb(230, 190, 120),
    savanna:    rgb(200, 165, 100),
    tundra:     rgb(180, 160, 130),
    snow:       rgb(230, 220, 200),
    mountain:   rgb(160, 130, 90),
    volcanic:   rgb(100, 60, 40),
  },
  foam:      rgb(245, 230, 190),
  waterSurf: {
    deep:  rgb(50, 70, 90),
    mid:   rgb(75, 105, 125),
    light: rgb(120, 150, 160),
    glint: rgb(200, 220, 220),
  },
  waterLip:  rgb(80, 110, 130),
  waterDeep: rgb(40, 55, 70),
  facet:     rgb(210, 200, 170),
  strata: [
    rgb(180, 140, 90),
    rgb(200, 160, 100),
    rgb(160, 120, 75),
    rgb(120, 90, 55),
    rgb(80, 55, 35),
    rgb(45, 30, 20),
  ],
  ember:    rgb(220, 140, 60),
  emberHot: rgb(255, 200, 100),
};

const STORM_PALETTE: CutawayPalette = {
  biome: {
    deep_ocean: rgb(18, 22, 40),
    ocean:      rgb(30, 38, 60),
    shallow:    rgb(50, 55, 80),
    beach:      rgb(70, 65, 75),
    plains:     rgb(55, 50, 60),
    grassland:  rgb(45, 55, 48),
    forest:     rgb(35, 45, 40),
    jungle:     rgb(28, 40, 35),
    desert:     rgb(80, 70, 65),
    savanna:    rgb(65, 58, 55),
    tundra:     rgb(70, 75, 90),
    snow:       rgb(140, 145, 160),
    mountain:   rgb(50, 48, 58),
    volcanic:   rgb(40, 30, 35),
  },
  foam:      rgb(160, 165, 185),
  waterSurf: {
    deep:  rgb(18, 22, 40),
    mid:   rgb(35, 42, 65),
    light: rgb(60, 68, 95),
    glint: rgb(130, 140, 170),
  },
  waterLip:  rgb(40, 48, 70),
  waterDeep: rgb(16, 18, 32),
  facet:     rgb(120, 130, 160),
  strata: [
    rgb(40, 38, 48),
    rgb(60, 50, 55),
    rgb(45, 42, 55),
    rgb(35, 30, 40),
    rgb(25, 22, 30),
    rgb(14, 12, 18),
  ],
  ember:    rgb(120, 80, 160),
  emberHot: rgb(180, 140, 220),
};

const CARBON_PALETTE: CutawayPalette = {
  biome: {
    deep_ocean: rgb(12, 18, 28),
    ocean:      rgb(20, 28, 40),
    shallow:    rgb(35, 45, 55),
    beach:      rgb(50, 50, 52),
    plains:     rgb(38, 38, 40),
    grassland:  rgb(32, 36, 34),
    forest:     rgb(26, 30, 28),
    jungle:     rgb(22, 26, 24),
    desert:     rgb(48, 46, 44),
    savanna:    rgb(42, 40, 38),
    tundra:     rgb(55, 58, 62),
    snow:       rgb(90, 95, 105),
    mountain:   rgb(28, 28, 30),
    volcanic:   rgb(20, 16, 16),
  },
  foam:      rgb(100, 110, 130),
  waterSurf: {
    deep:  rgb(12, 18, 28),
    mid:   rgb(25, 35, 50),
    light: rgb(45, 60, 80),
    glint: rgb(90, 120, 160),
  },
  waterLip:  rgb(30, 40, 55),
  waterDeep: rgb(10, 14, 22),
  facet:     rgb(80, 110, 150),
  strata: [
    rgb(30, 30, 32),
    rgb(45, 42, 40),
    rgb(35, 34, 36),
    rgb(25, 24, 26),
    rgb(16, 15, 16),
    rgb(8, 8, 9),
  ],
  ember:    rgb(60, 100, 160),
  emberHot: rgb(100, 160, 220),
};

const PALETTE_BY_TYPE: Record<HabitableType, CutawayPalette> = {
  ocean: OCEAN_PALETTE,
  rocky: ROCKY_PALETTE,
  ice: ICE_PALETTE,
  lava: LAVA_PALETTE,
  gas: GAS_PALETTE,
  toxic: TOXIC_PALETTE,
  crystal: CRYSTAL_PALETTE,
  desert: DESERT_PALETTE,
  storm: STORM_PALETTE,
  carbon: CARBON_PALETTE,
};

function paletteFor(type: HabitableType): CutawayPalette {
  return PALETTE_BY_TYPE[type] ?? ROCKY_PALETTE;
}

/** HSV → RGB for seed-driven gas bands. */
function hsvToRGB(hDeg: number, s: number, v: number): RGB {
  const h = ((hDeg % 360) + 360) % 360 / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 1)      { r = c; g = x; }
  else if (h < 2) { r = x; g = c; }
  else if (h < 3) { g = c; b = x; }
  else if (h < 4) { g = x; b = c; }
  else if (h < 5) { r = x; b = c; }
  else            { r = c; b = x; }
  return rgb((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/** Seed a gas-giant latitude-band palette (shared by surface, rings, haze). */
export function makeGasBands(seed: number): RGB[] {
  const s = new Stream(seed ^ 0x6a09e667);
  const hueBase = s.range(0, 360);
  const bandCount = 8 + s.int(0, 4);
  const bands: RGB[] = [];
  for (let i = 0; i < bandCount; i++) {
    const warm = s.next() > 0.38;
    const hue = (hueBase + (warm ? s.range(-22, 22) : s.range(150, 220))) % 360;
    const sat = warm ? s.range(0.48, 0.78) : s.range(0.32, 0.58);
    const val = warm ? s.range(0.72, 0.96) : s.range(0.58, 0.82);
    bands.push(hsvToRGB(hue, sat, val));
  }
  return bands;
}

function averageBands(bands: RGB[]): RGB {
  let r = 0, g = 0, b = 0;
  for (const c of bands) { r += c.r; g += c.g; b += c.b; }
  const n = Math.max(1, bands.length);
  return rgb(Math.round(r / n), Math.round(g / n), Math.round(b / n));
}

/**
 * Horizontal component of the key light, −1 … 1.
 *
 * The mockup's rock is lit from the upper RIGHT: the right flank is warm tan,
 * the left flank drops to near-black brown. Surface and crust share this
 * constant so the whole body reads as one lit object.
 */
const KEY_X = 0.95;
const KEY_Y = -0.45;

// ─── Top face: the biome tabletop ─────────────────────────────────────────────

/** The sub-cell sampler a bake may use: only camera bakes zoomed in (Ruling 11). */
function subCellSampler(opts: Pick<CutawayBakeOpts, 'cameraZoom' | 'elevationAt'>): ((dx: number, dy: number) => number | null) | undefined {
  return opts.cameraZoom !== undefined && opts.cameraZoom > 1 ? opts.elevationAt : undefined;
}

/**
 * Screen -> base-world mapping of a bake (`screenToWorld` of its camera).
 * Identity (no camera) returns the pixel itself, so identity bakes key every
 * hash exactly as before.
 */
function worldMapOf(opts: Pick<CutawayBakeOpts, 'camera' | 'w' | 'h'>): {
  wx: (x: number) => number; wy: (y: number) => number;
} {
  const cam = opts.camera;
  if (!cam) return { wx: x => x, wy: y => y };
  const hw = opts.w / 2, hh = opts.h / 2, z = cam.zoom, fx = cam.fx, fy = cam.fy;
  return { wx: x => (x - hw) / z + fx, wy: y => (y - hh) / z + fy };
}

/** Test-only iteration counters (`globalThis.__zoomIters`), read by tools/zoomCheck.ts. */
function zoomIters(): Record<string, number> | undefined {
  return (globalThis as { __zoomIters?: Record<string, number> }).__zoomIters;
}

/**
 * A bake that can be time-sliced (spec 5b): a generator that yields between
 * small units of work (a column, a row, a decal) and returns its result. The
 * engine's camera re-bake runs one over several frames within a per-frame
 * budget; every synchronous caller (the identity bake included) `drain`s it,
 * which runs exactly the same code to completion.
 */
export type BakeSteps<T = void> = Generator<void, T, void>;

/** Run a sliced bake to completion and return its result. */
export function drain<T>(steps: BakeSteps<T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * Is the face pixel (px, py) water? The same land/water decision the surface
 * painter makes, for pixels OUTSIDE the canvas: the camera bake's shore
 * distance needs the coast a little beyond the view (see bakeShoreDistance).
 * Keep in step with the classification in paintCutawaySurface.
 */
export function faceWaterAt(opts: CutawayBakeOpts, px: number, py: number): boolean {
  const dx = (px - opts.cx) / opts.rx, dy = (py - opts.cyTop) / opts.ry;
  const r = Math.hypot(dx, dy);
  if (r > 1 || opts.planetType === 'gas') return false;
  const grid = opts.grid;
  if (!grid) return true;
  const gp = opts.discToGrid(dx, dy);
  if (!gp) return false;
  const cell = grid[gp.row]?.[gp.col];
  if (!cell) return false;
  const rim = opts.rimFalloff(r);
  let biome: BiomeType = classifyBiome(cell.elevation - rim, cell.moisture, cell.temperature, opts.planetType);
  const elevationAt = subCellSampler(opts);
  const smoothF = elevationAt ? elevationAt(dx, dy) : null;
  if (smoothF !== null) {
    const biomeF = classifyBiome(smoothF - rim, cell.moisture, cell.temperature, opts.planetType);
    if (isWater(biomeF)) biome = biomeF;
    else if (isWater(biome)) biome = biomeF;
  }
  return isWater(biome);
}

/**
 * Paint the cut face: an azimuthal projection of the grid as a flat living
 * board (diorama_test language) — tiered land with cliff faces. Water cells
 * leave the land canvas empty and stamp occupancy + pick for live fluids.
 * Gas giants fill the whole disc with latitude bands (no water holes).
 *
 * Camera bakes (`cameraZoom` k > 1): the loops cover the canvas plus the
 * relief margin only; relief comes pre-scaled from the engine's wrapped
 * `liftOf`; grain is keyed on world pixels; 1-px lines narrow by k.
 */
export function paintCutawaySurface(
  g: CanvasRenderingContext2D, opts: CutawayBakeOpts,
): void {
  drain(surfaceSteps(g, opts));
}

/** {@link paintCutawaySurface}, sliced: yields after every column, punch row and decal. */
export function* surfaceSteps(
  g: CanvasRenderingContext2D, opts: CutawayBakeOpts,
): BakeSteps {
  const { w: VW, h: VH, cx, cyTop, rx, ry, seed, grid } = opts;
  const elevationAt = subCellSampler(opts);
  const k = opts.cameraZoom ?? 1;
  const world = worldMapOf(opts);
  const pal = paletteFor(opts.planetType);
  g.clearRect(0, 0, VW, VH);

  // Bounded to the view: columns on the canvas; face rows from the canvas top
  // to the canvas bottom PLUS the relief margin (rows below the canvas whose
  // lifted ground rises into view). At identity the face lies inside the canvas
  // and every bound below equals the whole-face box it replaced.
  // Clear pick and occupancy FIRST: a camera bake reuses the previous
  // camera's buffers, and must not keep its cells when nothing is in view.
  const pick = opts.pick && opts.pick.length === VW * VH ? opts.pick : null;
  if (pick) pick.fill(0);
  const occ = opts.occupancy && opts.occupancy.length === VW * VH ? opts.occupancy : null;
  if (occ) occ.fill(0);

  // Horizontal pad so rim vegetation/decals can overhang the disc instead of
  // having their bodies clipped at x = cx±rx (atlas cell is typically 16).
  const decalPad = opts.planetType === 'gas' ? 0 : Math.ceil(10 * k);
  const x0 = Math.max(0, Math.ceil(cx - rx) - decalPad);
  const x1 = Math.min(VW - 1, Math.floor(cx + rx) + decalPad);
  const yFace0 = Math.ceil(cyTop - ry), yFace1 = Math.floor(cyTop + ry);
  const y1 = Math.min(VH - 1, yFace1);                          // last stored row
  const yScan1 = Math.min(VH - 1 + (opts.planetType === 'gas' ? 0 : opts.maxLift), yFace1);
  const yScan0 = Math.max(0, yFace0);                            // rows above the canvas draw above it
  // Raised ground draws ABOVE the point it belongs to, so peaks near the far rim
  // need rows reserved above the ellipse. A face whose far rim is below the
  // canvas still shows the peaks that rise into view (rows up to yScan1).
  const yTop = Math.max(0, yFace0 - opts.maxLift);
  const bw = x1 - x0 + 1, bh = y1 - yTop + 1;
  if (x1 < x0 || yScan1 < yScan0 || bh <= 0) return;   // nothing of the face can reach the view
  const img = g.createImageData(bw, bh);
  const d = img.data;
  let iters = 0;

  // ── Gas giant: flat banded tabletop, no water holes ─────────────────────────
  if (opts.planetType === 'gas') {
    const bands = (opts.gasBands && opts.gasBands.length > 0)
      ? opts.gasBands
      : makeGasBands(seed);
    const bandCount = bands.length;
    // The dark band-edge line is a 1-px stroke: its threshold narrows with zoom.
    const edgeLine = k === 1 ? 0.08 : 0.08 / k;
    for (let py = yScan0; py <= y1; py++) {
      const dy = (py - cyTop) / ry;
      for (let px = x0; px <= x1; px++) {
        iters++;
        const dx = (px - cx) / rx;
        const r = Math.hypot(dx, dy);
        if (r > 1) continue;

        const latN = dy; // −1 … 1 across the foreshortened disc
        const turb = fbm1(latN * 7.5 + dx * 1.6, seed + 3, 4) * 0.28
                   + fbm1(latN * 22 + dx * 4.0, seed + 91, 3) * 0.10;
        const bandF = (latN * 0.5 + 0.5) * bandCount + (turb - 0.38) * 0.55;
        const i0 = Math.max(0, Math.min(bandCount - 1, Math.floor(bandF)));
        const i1 = Math.max(0, Math.min(bandCount - 1, i0 + 1));
        const ft0 = bandF - Math.floor(bandF);
        const ft = ft0 < 0.16 ? 0 : ft0 > 0.84 ? 1 : 0.5;
        const c0 = bands[i0], c1 = bands[i1];
        const curl = 0.96 + fbm1(latN * 60 + dx * 9, seed + 707, 2) * 0.10;
        let cr = mix(c0.r, c1.r, ft) * curl;
        let cg = mix(c0.g, c1.g, ft) * curl;
        let cb = mix(c0.b, c1.b, ft) * curl;
        if (ft0 < edgeLine) { cr *= 0.72; cg *= 0.72; cb *= 0.72; }

        const key = quantise(0.88 + 0.22 * clamp01(dx * KEY_X + dy * KEY_Y + 0.5), 0.065);
        const ao = 1 - Math.pow(clamp01((r - 0.70) / 0.30), 2) * 0.22;
        const f = key * ao;
        cr *= f; cg *= f; cb *= f;

        let cellId = 0;
        if (grid) {
          const gp = opts.discToGrid(dx, dy);
          if (gp) cellId = gp.row * GRID_SIZE + gp.col + 1;
        }
        const o = ((py - yTop) * bw + (px - x0)) * 4;
        d[o]     = cr < 0 ? 0 : cr > 255 ? 255 : cr;
        d[o + 1] = cg < 0 ? 0 : cg > 255 ? 255 : cg;
        d[o + 2] = cb < 0 ? 0 : cb > 255 ? 255 : cb;
        d[o + 3] = 255;
        if (pick && cellId > 0) pick[py * VW + px] = cellId;
      }
      yield;
    }
    const it = zoomIters();
    if (it) it.surface = iters;
    g.putImageData(img, x0, yTop);
    return;
  }

  const lush = clamp01(opts.lush ?? 0.3);
  // Cliff face under extruded land — same role as diorama_test's terrain.cliff.
  const cliff = pal.strata[1];
  /** Paler stratum for the banding on cliff faces. */
  const cliffLit = pal.strata[2];
  // 1-px lines stay 1 px at any zoom: their thresholds narrow by k.
  const foamOuter = k === 1 ? 0.972 : 1 - 0.028 / k;
  const foamInner = k === 1 ? 0.988 : 1 - 0.012 / k;
  const coastLo = k === 1 ? SEA_LEVEL - 0.009 : SEA_LEVEL - 0.009 / k;
  const coastHi = k === 1 ? SEA_LEVEL + 0.014 : SEA_LEVEL + 0.014 / k;
  // Waterfall lip/foam rows scale with the camera; splash points (x, y pairs).
  const lipRows = Math.max(1, Math.round(k));
  const splash: number[] = [];

  // One column at a time, NEAR rows first. Ground drawn by a nearer face row
  // hides whatever a farther one would draw at the same pixel, so each pixel is
  // written once, by the first (nearest) face row that covers it: the rows a
  // face row covers are [py - lift, py], and everything from `minTop` down is
  // already owned by nearer rows. This is the painter's order of the old
  // far-to-near loop (last writer wins), without its O(lift) overdraw.
  // A farther WATER face pixel always stays empty (its pick is the water cell),
  // which is what the old per-put occupancy test produced.
  for (let px = x0; px <= x1; px++) {
    let minTop = Infinity;
    for (let py = yScan1; py >= yScan0; py--) {
      iters++;
      const dy = (py - cyTop) / ry;
      const dx = (px - cx) / rx;
      const r = Math.hypot(dx, dy);
      if (r > 1) continue;
      const inCanvas = py >= 0 && py < VH;
      const idx = py * VW + px;

      if (!grid) {
        // No grid yet: treat the disc as water so fluids can fill it in frame().
        if (occ && inCanvas) occ[idx] = 1;
        continue;
      }
      const gp = opts.discToGrid(dx, dy);
      if (!gp) continue;
      const cell = grid[gp.row]?.[gp.col];
      if (!cell) continue;

      const rim = opts.rimFalloff(r);
      const elev = cell.elevation - rim;
      let biome: BiomeType =
        classifyBiome(elev, cell.moisture, cell.temperature, opts.planetType);
      // Sub-cell elevation decides land vs water (and the coast outline and
      // lift below), so the coast is a curve between cells, not a cell stair.
      // Colour stays the nearest cell's biome — unless that cell is water and
      // the interpolated ground here is land, when the land biome the
      // interpolated elevation gives (the coast's own) is the only one to use.
      // faceWaterAt repeats this decision for pixels beyond the canvas.
      const smoothF = elevationAt ? elevationAt(dx, dy) : null;
      const elevF = smoothF === null ? elev : smoothF - rim;
      if (smoothF !== null) {
        const biomeF = classifyBiome(elevF, cell.moisture, cell.temperature, opts.planetType);
        if (isWater(biomeF)) biome = biomeF;
        else if (isWater(biome)) biome = biomeF;
      }

      // Snow caps: the mockup's peaks are white-tipped regardless of latitude,
      // which is what altitude actually does to a mountain — except molten worlds.
      // THIS is the reclassification the decal planner cannot see: it is local
      // to this loop and never written back to `cell.biome`, so a planner
      // reading `cell.biome` alone would happily stamp scrub across the white
      // cap. `DECAL_SNOW_LINE` is derived from `PAINTER_SNOW_ELEVATION` to
      // keep decals below this line; see SurfaceDecals.ts.
      if (opts.planetType !== 'lava'
          && biome === 'mountain' && cell.elevation > PAINTER_SNOW_ELEVATION) biome = 'snow';

      if (isWater(biome)) {
        if (inCanvas) {
          if (occ) occ[idx] = 1;
          if (pick) pick[idx] = gp.row * GRID_SIZE + gp.col + 1;
        }
        // A nearer row's cliff may already cover this pixel; water wins.
        if (py >= yTop && py <= y1) {
          const o = ((py - yTop) * bw + (px - x0)) * 4;
          d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 0;
        }
        continue;
      }

      const base = opts.barren ? barrenGround(biome, cell.elevation, cell.moisture) : pal.biome[biome];
      let br = base.r, bg = base.g, bb = base.b;

      if (!opts.barren && biome !== 'mountain' && biome !== 'snow' && biome !== 'tundra'
                 && biome !== 'volcanic' && biome !== 'beach') {
        // Vegetation responds to the living biosphere, gated on the cell's own
        // fertility so deserts and savanna still read as themselves.
        const veg = clamp01(cell.lifeDensity * 0.45 + lush * 0.30)
                  * clamp01(cell.fertility * 1.6) * 0.55;
        br = mix(br, br * 0.74, veg);
        bg = mix(bg, Math.min(255, bg * 1.12 + 8), veg);
        bb = mix(bb, bb * 0.76, veg);
      }
      // Rivers: an unbroken meandering line along each channel's flow path
      // (see `riverAt`), drawn in the planet's own sea colours with a 1-px
      // wet bank either side. 0 none, 1 bank, 2 water, 3 sunlit core.
      let river = 0;
      let fall = false;
      if (opts.planetType !== 'lava' && !opts.noRivers) {
        const fp = opts.discToGridF?.(dx, dy);
        if (fp) {
          const rs = riverAt(grid, fp.row, fp.col);
          if (rs.half > 0) {
            if (rs.dist <= rs.half) {
              river = rs.strength >= 1 && rs.dist <= rs.half * 0.3 ? 3 : 2;
              fall = rs.drops;
            } else if (rs.dist <= rs.half + RIVER_BANK) { river = 1; fall = rs.drops; }
          }
        }
      }
      if (river === 1) {
        // Wet ground: darker and a touch greener/bluer, not a drawn outline.
        br = br * 0.72; bg = bg * 0.80; bb = bb * 0.84 + 6;
      } else if (river >= 2) {
        const w = river === 3 ? pal.waterSurf.light : pal.waterSurf.mid;
        br = w.r; bg = w.g; bb = w.b;
      }

      // Relief from the elevation gradient, then STEPPED — the whole point of
      // the flat-tabletop read is that shading arrives in plates.
      const cE = grid[gp.row]?.[(gp.col + 2) % GRID_SIZE];
      const cN = grid[Math.max(0, gp.row - 2)]?.[gp.col];
      const slope = (cell.elevation - (cE?.elevation ?? cell.elevation)) * 0.7
                  + (cell.elevation - (cN?.elevation ?? cell.elevation)) * 0.5;
      const relief = quantise(1 + clamp01(slope * 6 + 0.5) * 0.34 - 0.17, 0.085);

      const key = quantise(0.86 + 0.26 * clamp01(dx * KEY_X + dy * KEY_Y + 0.5), 0.065);
      // Occlusion under the atmosphere shell at the rim.
      const ao = 1 - Math.pow(clamp01((r - 0.70) / 0.30), 2) * 0.30;
      // Grain keyed on the WORLD pixel (floored at base resolution), so it
      // stays put when the camera pans.
      const grain = 0.975 + hash1(Math.floor(world.wx(px)) * 911 + Math.floor(world.wy(py)) * 31, seed) * 0.05;

      const f = relief * key * ao * grain;
      let cr = br * f, cg = bg * f, cb = bb * f;

      // Foam ring at the rim, hard-edged: two steps, not a fade.
      if (r > foamOuter) {
        const t = r > foamInner ? 0.85 : 0.42;
        cr = mix(cr, pal.foam.r, t);
        cg = mix(cg, pal.foam.g, t);
        cb = mix(cb, pal.foam.b, t);
      }

      // Coastline: a hard bright outline wherever land meets water. This is
      // most of what makes the tabletop read as a MAP rather than a texture.
      // Done INLINE rather than as a second pass over the face — the second
      // pass had to re-run the azimuthal projection for every pixel, which is
      // the most expensive thing in the bake, and coasts are at sea level so
      // they are never displaced by the extrusion anyway.
      if (elevF > coastLo && elevF < coastHi) {
        cr = mix(cr, pal.foam.r, 0.55);
        cg = mix(cg, pal.foam.g, 0.55);
        cb = mix(cb, pal.foam.b, 0.55);
      }

      const lift = opts.liftOf((smoothF ?? opts.smoothElevation(grid, gp.row, gp.col)) - rim);
      const cellId = gp.row * GRID_SIZE + gp.col + 1;
      const top = py - lift;
      // Lit top plate — sunward side pops like the test.
      const sun = dx > 0.05 ? 1.12 : 1.0;
      const rEnd = Math.min(py, minTop - 1, y1);
      const rStart = Math.max(top, yTop);
      for (let row = rStart; row <= rEnd; row++) {
        let vr: number, vg: number, vb: number;
        if (row === top) {
          if (lift > 0) {
            vr = Math.min(255, cr * sun + 8);
            vg = Math.min(255, cg * sun + 8);
            vb = Math.min(255, cb * sun + 8);
          } else {
            vr = cr; vg = cg; vb = cb;
          }
        } else if (fall && river >= 1) {
          // Waterfall: the channel pours down the camera-facing cliff. A white
          // lip, vertical streaks keyed on the world column (so they hold
          // still under the camera), and a foam line where it lands.
          const kk = row - top;
          const ws = pal.waterSurf;
          let c: RGB;
          if (kk <= lipRows || row > rEnd - lipRows) c = ws.glint;
          else {
            const s = hash1(Math.floor(world.wx(px) / Math.max(1, Math.round(k))) * 131, seed + 77);
            const dash = ((Math.floor((row - top) / Math.max(1, Math.round(k))) + Math.floor(s * 5)) & 3) === 0;
            c = river === 1 ? (s > 0.5 ? ws.mid : ws.deep)
              : s > 0.62 ? (dash ? ws.glint : ws.light) : s < 0.22 ? ws.deep : ws.mid;
          }
          vr = c.r; vg = c.g; vb = c.b;
          if (river >= 2 && row === rEnd && rEnd >= top + 3 * lipRows) splash.push(px, rEnd + 1);
        } else {
          // Cliff face under the crest: still solid (height must read as real
          // ground), but drawn as rock rather than one flat brown band. A dark
          // lip of the plate's own ground overhangs the edge; below it, rock
          // strata tinted by the ground above (olive under grass, pale under
          // sand or snow), lit on the sunward side and darkening to the foot.
          const kk = row - top;
          if (kk <= lipRows) {
            vr = cr * 0.58; vg = cg * 0.58; vb = cb * 0.6;
          } else {
            const t = (kk - lipRows) / Math.max(1, lift - lipRows);
            const band = Math.floor(world.wy(row) / Math.max(1, Math.round(k)) + hash1(Math.floor(world.wx(px) / (6 * Math.max(1, Math.round(k)))), seed + 5) * 2) % 3;
            const rock = band === 0 ? cliffLit : cliff;
            const f2 = (sun > 1 ? 1.0 : 0.86) * (0.98 - 0.26 * t) * (band === 2 ? 0.9 : 1);
            vr = (rock.r * 0.7 + cr * 0.3) * f2;
            vg = (rock.g * 0.7 + cg * 0.3) * f2;
            vb = (rock.b * 0.7 + cb * 0.3) * f2;
          }
        }
        const o = ((row - yTop) * bw + (px - x0)) * 4;
        d[o]     = vr < 0 ? 0 : vr > 255 ? 255 : vr;
        d[o + 1] = vg < 0 ? 0 : vg > 255 ? 255 : vg;
        d[o + 2] = vb < 0 ? 0 : vb > 255 ? 255 : vb;
        d[o + 3] = 255;
        if (pick) pick[row * VW + px] = cellId;
      }
      if (top < minTop) minTop = top;
    }
    yield;
  }
  const it = zoomIters();
  if (it) it.surface = iters;

  // Plunge pools: a short foam bar where each fall lands — white at the
  // middle, pale water at the ends. One row tall at the identity view.
  if (splash.length) {
    const foam = pal.waterSurf.glint, lite = pal.waterSurf.light;
    const sk = Math.max(1, Math.round(k));
    for (let i = 0; i < splash.length; i += 2) {
      const sx = splash[i], sy = splash[i + 1];
      for (let oy = 0; oy < sk; oy++) {
        for (let ox = -sk; ox <= sk; ox++) {
          const x = sx + ox, y = sy + oy;
          if (x < x0 || x > x1 || y < yTop || y > y1) continue;
          const o = ((y - yTop) * bw + (x - x0)) * 4;
          if (d[o + 3] !== 255) continue;
          const c = ox === 0 ? foam : lite;
          d[o] = c.r; d[o + 1] = c.g; d[o + 2] = c.b;
        }
      }
    }
  }

  // Land cliffs can extrude onto a farther water cell's pixel. Punch those
  // back to alpha 0 so occupancy water stays empty for live fluids.
  if (occ) {
    for (let py = yTop; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        if (!occ[py * VW + px]) continue;
        d[((py - yTop) * bw + (px - x0)) * 4 + 3] = 0;
      }
      if ((py & 15) === 15) yield;
    }
  }

  // Decals last: they must stand on finished terrain, and the cliff-punch above
  // has already cleared water pixels back to alpha 0 so nothing lands in the sea.
  // Given sites are a stored plan: the identity bake stamps them 1:1 and
  // records each one's footing; a camera bake stamps them x round(k), clipped.
  // One site per call, in plan order (stamping is sequential either way), so
  // a sliced bake can yield between decals. A camera bake stamps every site on
  // its identity footing (`storedFoot`): the stamp is then a function of the
  // plan alone, not of which pixels this bake's window holds, so two camera
  // bakes of the same zoom agree on every overlap pixel (spec 5b re-centre).
  if (opts.decalSites) {
    const camera = opts.cameraZoom !== undefined, one: DecalSite[] = [];
    for (const site of opts.decalSites) {
      one[0] = site;
      stampDecals(d, bw, bh, x0, yTop, one, opts.decalAtlas ?? null, Math.round(k), !camera, camera, opts.planetType);
      if (camera) yield;
    }
  } else if (opts.decalSeed !== undefined) {
    // A barren (still-forming) world carries stone only.
    const sites = planSurfaceDecals(opts, clamp01(opts.lush ?? 0.3), opts.decalSeed, undefined, !!opts.barren);
    stampDecals(d, bw, bh, x0, yTop, sites, opts.decalAtlas ?? null, 1, false, false, opts.planetType);
  }

  g.putImageData(img, x0, yTop);

  if (opts.planetType === 'lava') {
    paintVolcanoChimneys(g, opts.chimneySites ?? planVolcanoChimneys(opts), VW, VH, k);
  }
}

export interface VolcanoChimney {
  /** Base centre in the painter's screen px (the planner's: at identity, base world px). */
  x: number;
  y: number;
  /** Cone height in BASE virtual pixels (world class: painted x k). */
  h: number;
  /** Base half-width, base px (world class). */
  w: number;
  /** The grid cell it stands on. */
  row?: number;
  col?: number;
  /** Base-world position, set by the engine when it stores its plan. */
  wx?: number;
  wy?: number;
}

/**
 * Peak sites for lava chimney props. High basalt only, sparse, deterministic.
 */
export function planVolcanoChimneys(opts: CutawayBakeOpts): VolcanoChimney[] {
  const { w: VW, h: VH, cx, cyTop, rx, ry, seed, grid } = opts;
  if (!grid || opts.planetType !== 'lava') return [];
  const sites: VolcanoChimney[] = [];
  const x0 = Math.max(0, cx - rx), x1 = Math.min(VW - 1, cx + rx);
  const yFace0 = cyTop - ry, yFace1 = Math.min(VH - 1, cyTop + ry);
  for (let py = yFace0; py <= yFace1; py += 2) {
    const dy = (py - cyTop) / ry;
    for (let px = x0; px <= x1; px += 2) {
      const dx = (px - cx) / rx;
      const r = Math.hypot(dx, dy);
      if (r > 0.88 || r < 0.12) continue;
      const gp = opts.discToGrid(dx, dy);
      if (!gp) continue;
      const cell = grid[gp.row]?.[gp.col];
      if (!cell) continue;
      const elev = cell.elevation - opts.rimFalloff(r);
      if (elev < 0.70) continue;
      if (hash1(px * 733 + py * 197 + seed, seed ^ 0x71) < 0.955) continue;
      // Keep chimneys from stacking on top of each other.
      if (sites.some(s => Math.hypot(s.x - px, s.y - py) < rx * 0.14)) continue;
      const lift = opts.liftOf(opts.smoothElevation(grid, gp.row, gp.col) - opts.rimFalloff(r));
      const h = Math.max(6, 5 + Math.floor(lift * 0.7) + Math.floor(hash1(px + py, seed) * 4));
      const w = 2 + Math.floor(hash1(px * 3 + py, seed + 9) * 2);
      sites.push({ x: px, y: py - lift, h, w, row: gp.row, col: gp.col });
      if (sites.length >= 10) return sites;
    }
  }
  return sites;
}

/**
 * Dark basalt cone + glowing crater mouth on the lava tabletop.
 *
 * `k` (a camera bake's zoom): the cone is world-sized — height and width x k,
 * one 1-px row per scaled row, the lit flank stays a 1-px stroke; the crater,
 * throat, core and plume stubs are a sprite, x round(k) about the tip.
 */
export function paintVolcanoChimneys(
  g: CanvasRenderingContext2D, sites: VolcanoChimney[],
  VW = Infinity, VH = Infinity, k = 1,
): void {
  const S = Math.max(1, Math.round(k)), half = S >> 1;
  for (const v of sites) {
    const hS = k === 1 ? v.h : Math.round(v.h * k), wS = v.w * k;
    const baseY = v.y;
    const tipY = v.y - hS;
    // Bounded to the view: a cone wholly off the canvas draws nothing.
    if (baseY < 0 || tipY - 8 * S >= VH || v.x + wS + 2 * S < 0 || v.x - wS - 2 * S >= VW) continue;
    // Cone body — dark basalt tapering upward.
    for (let kk = 0; kk <= hS; kk++) {
      const t = kk / Math.max(1, hS);
      const halfW = Math.max(1, Math.round(wS * (1 - t * 0.85)));
      const y = baseY - kk;
      g.fillStyle = `rgb(${28 + Math.round(t * 18)},${12 + Math.round(t * 8)},${10 + Math.round(t * 6)})`;
      g.fillRect(v.x - halfW, y, halfW * 2 + 1, 1);
      // Lit right flank.
      g.fillStyle = `rgba(90,40,25,${0.35 + t * 0.25})`;
      g.fillRect(v.x + halfW - 1, y, 1, 1);
    }
    // Crater rim + magma throat (sprite pixels, x S about the tip).
    const X = v.x - half, T = tipY;
    g.fillStyle = 'rgb(22,10,8)';
    g.fillRect(X - 2 * S, T - 1 * S, 5 * S, 2 * S);
    g.fillStyle = 'rgb(255,140,40)';
    g.fillRect(X - 1 * S, T - 2 * S, 3 * S, 2 * S);
    g.fillStyle = 'rgb(255,220,120)';
    g.fillRect(X, T - 3 * S, 1 * S, 2 * S);
    // Thin ash plume stub (static — live embers are host overlays).
    g.fillStyle = 'rgba(90,80,75,0.55)';
    g.fillRect(X, T - 6 * S, 1 * S, 3 * S);
    g.fillStyle = 'rgba(70,65,60,0.35)';
    g.fillRect(X + 1 * S, T - 8 * S, 1 * S, 2 * S);
  }
}

// ─── Underworld: spherical crust + sheer front wall ──────────────────────────

/**
 * Paint the crust beneath the living board: a sheer front wall, then a jagged
 * hanging keel. The tabletop ellipse stays transparent — surface and fluids
 * own it. Rock is a torn chunk, not a filled sphere.
 */
export function paintCutawayCrust(
  g: CanvasRenderingContext2D, opts: CutawayBakeOpts,
): void {
  drain(crustSteps(g, opts));
}

/** {@link paintCutawayCrust}, sliced: yields after every column. */
export function* crustSteps(
  g: CanvasRenderingContext2D, opts: CutawayBakeOpts,
): BakeSteps {
  const { w: VW, h: VH, cx, cyTop, rx, ry, seed } = opts;
  // The engine always passes `wall` (the camera's, on a camera bake); the
  // fallback is for legacy callers and is only correct at identity.
  const wall = opts.wall ?? habitableGeom(VW, VH).wall;
  const pal = paletteFor(opts.planetType);
  g.clearRect(0, 0, VW, VH);
  // Camera bakes: world-class sizes x k, per-px frequencies keyed on WORLD x
  // (screenToWorld), hashes floored at base resolution. Identity: k = 1 and the
  // world coordinate IS the pixel, so every expression reduces to the old one.
  const k = opts.cameraZoom ?? 1;
  const world = worldMapOf(opts);
  if (rx < 8 * k) return;
  const baseRx = k === 1 ? rx : Math.round(rx / k);
  const baseWall = k === 1 ? wall : Math.round(wall / k);
  // Column keys (cleft hash, ledge noise) count from the body's left rim in
  // WORLD columns, not from the first canvas column.
  const colKey0 = Math.max(0, Math.ceil(Math.round(world.wx(cx)) - baseRx));

  const E0 = Math.ceil(cx - rx), E1 = Math.floor(cx + rx);
  const rimX0 = Math.max(0, E0);
  const rimX1 = Math.min(VW - 1, E1);
  const cols = rimX1 - rimX0 + 1;
  if (cols <= 0) return;
  const wallBottom = new Float32Array(cols);
  const crustH = opts.crustDepthPx ?? (k === 1 ? crustDepthOf(rx) : crustDepthOf(baseRx) * k);
  const waterBand = k === 1 ? Math.max(6, Math.round(wall * 0.40)) : Math.max(6, Math.round(baseWall * 0.40)) * k;
  let iters = 0;

  // ── Sheer front wall ──────────────────────────────────────────────────────
  for (let x = rimX0; x <= rimX1; x++) {
    const i = x - rimX0;
    const wx = world.wx(x);
    const faceX = (x - cx) / rx;
    const frontY = cyTop + Math.sqrt(Math.max(0, 1 - faceX * faceX)) * ry;
    const ridge = (fbm1(wx * 0.075, seed + 77, 3) - 0.5) * 5 * k;
    const bottomY = frontY + wall + ridge;
    wallBottom[i] = bottomY;
    const rimY = Math.max(0, Math.min(VH - 1, Math.floor(frontY)));
    const hasOccupancy = opts.occupancy && opts.occupancy.length === VW * VH;
    const water = !hasOccupancy || opts.occupancy![rimY * VW + x] !== 0;
    // Facet stripe every 14 WORLD px, 1 screen px wide.
    const wk = Math.round(wx * k), period = 14 * k;
    const facetCol = ((wk % period) + period) % period < 1;

    const ys = Math.max(0, Math.ceil(frontY)), ye = Math.min(VH - 1, Math.floor(bottomY));
    for (let y = ys; y <= ye; y++) {
      iters++;
      const faceY = (y - cyTop) / ry;
      if (faceX * faceX + faceY * faceY <= 1) continue;
      const depth = y - frontY;
      const light = quantise(0.70 + 0.30 * clamp01(faceX * KEY_X + 0.42), 0.08);
      const fluidLayer = depth < waterBand || water;
      if (fluidLayer) {
        const t = clamp01(depth / Math.max(1, water ? (bottomY - frontY) : waterBand));
        const facet = facetCol ? 0.20 : 0;
        g.fillStyle = css(shade(rgb(
          mix(pal.waterLip.r, pal.waterDeep.r, t),
          mix(pal.waterLip.g, pal.waterDeep.g, t),
          mix(pal.waterLip.b, pal.waterDeep.b, t),
        ), light + facet));
      } else {
        const t = clamp01((depth - waterBand) / Math.max(1, bottomY - frontY - waterBand));
        const stripe = Math.min(pal.strata.length - 1, 1 + Math.floor(t * 3));
        g.fillStyle = css(shade(pal.strata[stripe], light));
      }
      g.fillRect(x, y, 1, 1);
    }
    yield;
  }

  // ── Jagged hanging keel ───────────────────────────────────────────────────
  // The profile is smoothed over neighbouring columns, so on a camera bake it
  // is computed a few kernel widths past the canvas edge (still inside the
  // body): a column at the edge of the view gets the same profile as it does
  // mid-view. Kernels (smoothing, median) reach round(k) columns — world
  // class (Ruling 6).
  const s = Math.max(1, Math.round(k));
  const margin = k === 1 ? 0 : 3 * s;
  const P0 = Math.max(E0, rimX0 - margin), P1 = Math.min(E1, rimX1 + margin);
  const pcols = P1 - P0 + 1;
  const raw = new Float32Array(pcols);
  for (let j = 0; j < pcols; j++) {
    const x = P0 + j;
    const dxn = (x - cx) / rx;
    const ox = (x - cx) / k;      // world px from the body centre
    // Flatter than a circle on purpose — a (1−x²)^0.78 bowl hugged the
    // atmospheric shell and the underside read as a sphere again.
    const keel = Math.pow(Math.max(0, 1 - dxn * dxn), 1.35);
    const jag  = fbm1(ox * 0.038, seed, 4) * 0.70
               + fbm1(ox * 0.14, seed + 77, 3) * 0.38
               + fbm1(ox * 0.48,  seed + 401, 2) * 0.22;
    const spur = Math.sin(fbm1(ox * 0.048, seed + 1234, 2) * Math.PI * 2.8) * 0.28;
    const cleft = hash1((Math.floor(world.wx(x)) - colKey0) * 17, seed + 5) > 0.82 ? -0.22 : 0;
    raw[j] = Math.min(
      crustH,
      crustH * Math.max(0, 0.06 + keel * 0.52 + (jag - 0.5) * 0.78 + spur + cleft),
    );
  }

  const prof = new Float32Array(pcols);
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? raw : prof.slice();
    for (let j = 0; j < pcols; j++) {
      const a = src[Math.max(0, j - s)], b = src[j], c = src[Math.min(pcols - 1, j + s)];
      prof[j] = (a + b * 2 + c) / 4;
    }
  }
  for (let j = 0; j < pcols; j++) {
    const ledge = (2 + Math.round(fbm1((world.wx(P0 + j) - colKey0) * 0.035, seed + 909, 2) * 3)) * k;
    prof[j] = Math.round(prof[j] / ledge) * ledge;
  }
  const terr = prof.slice();
  for (let j = s; j < pcols - s; j++) {
    const a = terr[j - s], b = terr[j], c = terr[j + s];
    prof[j] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }

  const bands = pal.strata.length;
  const strataSpan = ry + wall + crustH;
  const lipRows = 3 * k;
  const glowRows = k === 1 ? 2 : Math.max(2, Math.round(2 * k));
  for (let x = rimX0; x <= rimX1; x++) {
    const i = x - rimX0;
    const depth = prof[x - P0];
    if (depth < 2 * k) continue;
    const top = wallBottom[i];
    const dxn = (x - cx) / rx;
    const lit = 0.55 + 0.62 * clamp01(dxn * 0.9 + 0.45);
    const wx = world.wx(x);
    const fwx = Math.floor(wx);
    // Embers are 1-px dots: only the first screen column of their world column.
    const firstCol = k === 1 || Math.floor(world.wx(x - 1)) !== fwx;
    const wave = (fbm1(wx * 0.022, seed + 311, 3) - 0.5) * 0.55
               + (fbm1(wx * 0.075, seed + 733, 2) - 0.5) * 0.22;

    // Rows on the canvas only: absY = top + y in [0, VH).
    const y0 = Math.max(0, Math.ceil(-top));
    const yEnd = Math.min(depth, VH - top);
    for (let y = y0; y < yEnd; y++) {
      iters++;
      const absY = top + y;
      const faceX = dxn;
      const faceY = (absY - cyTop) / ry;
      if (faceX * faceX + faceY * faceY <= 1) continue;

      const t = y / depth;
      const bandPos = clamp01((absY - cyTop) / strataSpan) * bands + wave;
      const bi = Math.max(0, Math.min(bands - 1, Math.floor(bandPos)));
      const ao = 1 - t * 0.26 - (y < lipRows ? (lipRows - y) / lipRows : 0) * 0.28;
      const wy = y / k;                        // world rows below the wall
      const fwy = Math.floor(wy);
      const grain = 0.90 + hash1(fwx * 733 + fwy * 13, seed) * 0.20;
      const streak = 0.94 + fbm1(wx * 0.09 + wy * 1.7, seed + 55, 2) * 0.14;
      let f = lit * ao * grain * streak;
      const frac = bandPos - Math.floor(bandPos);
      if (frac < 0.07) f *= 0.68;
      else if (frac < 0.16) f *= 1.12;
      const ember = t > 0.78 && hash1(fwx * 179 + fwy * 991, seed + 19) > 0.986
        && (k === 1 || (firstCol && Math.floor((y - 1) / k) !== fwy));
      g.fillStyle = css(ember ? pal.emberHot : shade(pal.strata[bi], f));
      g.fillRect(x, Math.round(absY), 1, 1);
    }

    if (dxn > 0.1) {
      g.fillStyle = css(pal.ember, clamp01((dxn - 0.1) / 0.9) * 0.25);
      g.fillRect(x, Math.round(top + depth) - glowRows, 1, glowRows);
    }
    g.fillStyle = 'rgba(2,2,6,0.55)';
    g.fillRect(x, Math.round(top + depth) - 1, 1, 1);
    yield;
  }
  const it = zoomIters();
  if (it) it.crust = iters;
}

// ─── Atmosphere shell ─────────────────────────────────────────────────────────

/**
 * How much atmosphere shell to show at a given camera zoom.
 * Full haze at 1×, gone by ~2.5× so a close look reads bare terrain/limb.
 * Weather (clouds / precip) uses {@link weatherAmount} — it must not share
 * this fade, or rain and snow vanish at max zoom.
 */
export function atmoHazeAmount(viewZoom = 1): number {
  const t = Math.max(0, Math.min(1, (viewZoom - 1) / 1.5));
  return (1 - t) * (1 - t);
}

/**
 * Clouds, precipitation and storm ground-shadows stay readable through max
 * zoom (4×). Mild fade only — never drops to zero like the atmosphere veil.
 */
export function weatherAmount(viewZoom = 1): number {
  const t = Math.max(0, Math.min(1, (viewZoom - 1) / 3));
  return 0.55 + 0.45 * (1 - t) * (1 - t);
}

/**
 * Face² limit for a circle of radius `rx`: inside it, an overlay cannot reach
 * the feathered limb. (The weather layer is bounded by its own lookup instead.)
 */
export function cakeAirLimit(rx: number, ry: number): number {
  const inset = 1.25 / Math.max(1, Math.min(rx, ry));
  const r = Math.max(0.5, 1 - inset);
  return r * r;
}

/** True when (x,y) sits in the ozone half-dome (sky cap + thin tabletop air). */
/**
 * How much of the air band survives below the rim line, 1 on the line and 0 at
 * the front of the rim. The line of sight through the air shortens toward the
 * front, and the band must reach zero before the pancake-only cut below
 * (`y > cy + ry`) or that cut becomes a new shelf.
 */
function rimTaper(ddy: number, ry: number): number {
  // 1 - s², not (1 - s)²: flat at the rim line so the band leaves the dome at
  // full width (no shelf), zero at the front (no cut against the pancake line).
  const s = ddy / ry;
  return s >= 1 ? 0 : 1 - s * s;
}

function ozoneAt(
  x: number, y: number, geom: HabitableGeom, bob: number,
  extraPx = 0,
): { dome: number; face: number; dx: number; distPx: number } | null {
  const { cx, rx, ry } = geom;
  const cy = geom.cyTop + bob;
  const ddx = x - cx, ddy = y - cy;
  const dx = ddx / rx;
  // Math.hypot is precise about overflow/underflow we will never hit at these
  // pixel magnitudes; it cost ~20% of this function's time in profiling.
  const distPx = Math.sqrt(ddx * ddx + ddy * ddy);
  if (distPx > rx + extraPx) return null;
  // PANCAKE-ONLY. The body is a half-dome sitting on a disc, so there is no air
  // below the tabletop. This line is correct for that geometry and WRONG the
  // moment the body becomes a sphere — a sphere has a limb all the way round,
  // and this would shear its lower half off. Delete it with the pancake, not
  // before. (Called out in the 2026-09-08 genome plan's non-goals.)
  if (y > cy + ry) return null;
  const dyr = ddy / ry;
  const face = dx * dx + dyr * dyr;
  // Below the rim line, outside the face: not dome air. paintAtmosphere asks
  // rimBandAt for those pixels. Kept out of here on purpose — this function
  // runs for every pixel of the dome's box each frame, and growing it cost
  // ~10% of the frame (measured 2026-09-26) for a band of ~1% of the pixels.
  if (y > cy && face > 1) return null;
  return { dome: (distPx / rx) * (distPx / rx), face, dx, distPx };
}

/**
 * The limb band wrapping round the front of the rim, below the rim line and
 * outside the face. Measured from the rim ELLIPSE, not the dome circle — on the
 * rim line the two coincide (the ellipse's extreme x is rx), so the band
 * continues the dome's limb with no step. This used to be a hard cut, which
 * drew a horizontal shelf where the glow ended at rim height.
 * Returns the pixel distance outside the rim ellipse, or -1 if not in the band.
 */
function rimBandAt(
  x: number, y: number, geom: HabitableGeom, bob: number, extraPx: number,
): number {
  const { cx, rx, ry } = geom;
  const cy = geom.cyTop + bob;
  const ddx = x - cx, ddy = y - cy;
  if (ddy <= 0 || ddy > ry) return -1;           // pancake-only: none under the tabletop
  const dx = ddx / rx, dyr = ddy / ry;
  const face = dx * dx + dyr * dyr;
  if (face <= 1) return -1;
  const distPx = Math.sqrt(ddx * ddx + ddy * ddy);
  if (distPx > rx + extraPx) return -1;
  const rimPx = distPx * (1 - 1 / Math.sqrt(face));
  return rimPx < extraPx * rimTaper(ddy, ry) ? rimPx : -1;
}

/** HSL → RGB, h in degrees, s and l in 0–1. */
function hslRGB(h: number, s: number, l: number): RGB {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (hh < 60)       { r = c; g = x; }
  else if (hh < 120) { r = x; g = c; }
  else if (hh < 180) { g = c; b = x; }
  else if (hh < 240) { g = x; b = c; }
  else if (hh < 300) { r = x; b = c; }
  else               { r = c; b = x; }
  return rgb(
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  );
}

/**
 * Air scatters warmer where it is lit and cooler where it is not — but a fixed
 * hue ROTATION wraps warm-hued worlds into a foreign colour family (lava's 16deg
 * minus 26 lands on magenta). Blend toward these fixed anchors instead: the
 * planet keeps its own colour identity and nothing can wrap.
 */
const AIR_WARM: RGB = rgb(255, 236, 205);   // sunlit haze
const AIR_COOL: RGB = rgb( 40,  62, 130);   // shadowed haze

const mixRGB = (a: RGB, b: RGB, t: number): RGB => rgb(
  Math.round(a.r + (b.r - a.r) * t),
  Math.round(a.g + (b.g - a.g) * t),
  Math.round(a.b + (b.b - a.b) * t),
);

/**
 * Shell-thickness wobble around the limb, as two harmonics of the limb angle.
 *
 * The weights sum to 1, so the combined term is bounded to [-1, 1] by
 * construction and WOBBLE_AMP alone states the swing: the shell breathes ±55%
 * of its thickness. An earlier form spread that across three unlabelled
 * multipliers (0.5, 0.8 and 0.45), so its real swing — ±58% — was written down
 * nowhere and had been reached by walking the constants against a check
 * sampled at six angles.
 *
 * The amplitude is set by how the limb reads, not by that check: at ±55% it is
 * a gentle irregularity on ocean, lava and desert alike. tools/atmosphereCheck
 * only has to tell this apart from a constant-thickness annulus, and does so
 * with 4x margin.
 */
const WOBBLE_H2 = 0.6, WOBBLE_H3 = 0.4, WOBBLE_AMP = 0.55;

/**
 * Ozone half-dome sitting on the pancake — thin when looking down, a limb
 * against space that feathers out. `intensity` is usually {@link atmoHazeAmount}.
 */
export function paintAtmosphere(
  img: ImageData, geom: HabitableGeom, planetType: HabitableType, bob: number,
  sunAzimuth = 0,
  intensity = 1,
  tint?: RGB,
  air?: AtmosphereChannel,
  k = 1,
): void {
  if (intensity <= 0.01) return;
  const chan = air ?? genomeFromLegacy(planetType, 0).atmosphere;
  const airBase = hslRGB(chan.hue, chan.saturation, 0.58);
  const warm = mixRGB(airBase, AIR_WARM, 0.45);
  const cool = mixRGB(airBase, AIR_COOL, 0.40);
  const { cx, rx, ry } = geom;
  const cy = geom.cyTop + bob;
  const dens = chan.density;
  const d = img.data;
  const w = img.width, h = img.height;
  const sunX = Math.cos(sunAzimuth), sunUp = ELEV_LIGHT * Math.sin(sunAzimuth);
  // Zoom camera: the shell thickness is a world distance (x k); the wobble
  // seed below keeps the unscaled thickness so the limb shape is the same world.
  const fade = chan.thicknessPx * k;
  // A constant-thickness ring reads as a geometric annulus — an outline rather
  // than a volume. Perturb it slowly around the limb; see WOBBLE_AMP.
  // Angular wobble without transcendentals in the inner loop. (dx/d, dy/d) is
  // (cos t, sin t) already, so harmonics come from multiple-angle identities and
  // the phase terms are loop-invariant. atan2 + 2x sin per pixel over ~280k
  // pixels was a 2.66x per-frame regression.
  const wobbleSeed = (chan.hue * 7.13 + chan.thicknessPx * 31.7);
  const p1c = Math.cos(wobbleSeed),       p1s = Math.sin(wobbleSeed);
  const p2c = Math.cos(wobbleSeed * 1.7), p2s = Math.sin(wobbleSeed * 1.7);
  // ozoneFadeMax's +2 px feather is world-sized too: the whole bound x k.
  const fadeMax = k === 1 ? ozoneFadeMax(fade) : ozoneFadeMax(chan.thicknessPx) * k;
  const fadeFloor = 3 * k, bandRows = 6 * k;
  const aerialReach = rx * 0.35;
  const y0 = Math.max(0, Math.floor(cy - rx - fadeMax));
  const y1 = Math.min(h - 1, Math.ceil(cy + ry));
  const x0 = Math.max(0, Math.floor(cx - rx - fadeMax));
  const x1 = Math.min(w - 1, Math.ceil(cx + rx + fadeMax));
  const it = zoomIters();
  if (it) it.atmo = (it.atmo ?? 0) + Math.max(0, y1 - y0 + 1) * Math.max(0, x1 - x0 + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let hit = ozoneAt(x, y, geom, bob, fadeMax);
      let rimPx = 0;
      if (!hit) {
        if (y <= cy) continue;
        rimPx = rimBandAt(x, y, geom, bob, fadeMax);
        if (rimPx < 0) continue;
        const ddx = x - cx, ddy = y - cy;
        const dx = ddx / rx, dyr = ddy / ry;
        const distPx = Math.sqrt(ddx * ddx + ddy * ddy);
        hit = { dome: (distPx / rx) * (distPx / rx), face: dx * dx + dyr * dyr, dx, distPx };
      }
      const inv = hit.distPx > 0.0001 ? 1 / hit.distPx : 0;
      const ct = (x - cx) * inv, st = (y - cy) * inv;   // cos t, sin t
      const s2 = 2 * st * ct,    c2 = ct * ct - st * st;
      const s3 = st * (3 - 4 * st * st), c3 = ct * (4 * ct * ct - 3);
      const n = (s2 * p1c + c2 * p1s) * WOBBLE_H2 + (s3 * p2c + c3 * p2s) * WOBBLE_H3;
      const localFade = Math.max(fadeFloor, fade * (1 + n * WOBBLE_AMP));
      // Above the rim line the shell is measured from the dome circle; below
      // it, from the rim ellipse, thinning toward the front (see rimTaper).
      const below = rimPx > 0;
      const taper = below ? rimTaper(y - cy, ry) : 1;
      const beyond = below ? rimPx : hit.distPx - rx;
      const bandFade = below ? Math.max(0.001, localFade * taper) : localFade;
      const edge = beyond <= 0 ? 1 : Math.max(0, 1 - beyond / bandFade);
      if (edge < 0.02) continue;
      const inside = Math.max(0, rx - hit.distPx);
      const sigmaL = localFade * 1.15;
      const limb = Math.exp(-(inside * inside) / (2 * sigmaL * sigmaL)) * edge;
      const lit = 0.55 + 0.45 * Math.max(0, Math.min(1, 0.5 + hit.dx * sunX + sunUp));
      const domeGlow  = (0.07 + limb * 0.52) * lit * intensity * dens;
      const faceGlow  = (0.03 + limb * 0.10) * lit * intensity * dens;
      const blend     = Math.max(0, Math.min(1, (hit.face - 0.82) / 0.36));
      // Aerial perspective: air keeps veiling the surface well inside the rim,
      // falling off over ~35% of the radius rather than dying at the edge.
      // Zero past that band already, so skip the pow() there instead of
      // computing Math.max(0, …)**1.7 down to 0 on most of the interior face.
      // If frame budget ever gets tight, this pow is the next thing to go —
      // x*x or x*x*x is a close enough curve. paintAtmosphere runs per frame
      // and already costs ~1.4-1.6x what it did before the rebuild.
      const aerial    = inside < aerialReach
        ? Math.pow(1 - inside / aerialReach, 1.7) * 0.16 * lit * intensity * dens
        : 0;
      // The band's whole glow fades with `edge`, not just the limb term: the
      // unscaled base in domeGlow/faceGlow would otherwise end in a cut under
      // the rim. It also dims with the taper — a thinner band is fainter air —
      // or its fade gets steeper as it narrows toward the front. Blended in over
      // 6 rows so the band meets the dome with no step.
      // Target is 1 where the band touches the face (edge = 1), so it meets the
      // face with no seam, and falls with edge — faster where the band is thin.
      const bandGain  = below
        ? 1 + (edge * (taper + (1 - taper) * edge) - 1) * Math.min(1, (y - cy) / bandRows)
        : 1;
      const glow      = (faceGlow + (domeGlow - faceGlow) * blend + aerial) * bandGain;
      const a = Math.round(Math.min(255, glow * 255));
      if (a < 3) continue;
      const o = (y * w + x) * 4;
      const warmth = Math.max(0, Math.min(1, (lit - 0.55) / 0.45));
      const base = tint ?? null;
      d[o]     = base ? base.r : Math.round(cool.r + (warm.r - cool.r) * warmth);
      d[o + 1] = base ? base.g : Math.round(cool.g + (warm.g - cool.g) * warmth);
      d[o + 2] = base ? base.b : Math.round(cool.b + (warm.b - cool.b) * warmth);
      d[o + 3] = a;
    }
  }
}

/**
 * Night veil on the pancake. See sky/SunLight: noon lights the whole face,
 * midnight veils it, capped at NIGHT_MAX.
 *
 * Relief peaks paint ABOVE the face ellipse (`py - lift`). The veil must cover
 * that column too — otherwise snowcaps and far-rim ridges stay full-bright at
 * night (the elliptical mask ends at the unlifted rim).
 */
export function paintDayNight(
  img: ImageData, geom: HabitableGeom, sunAzimuth: number, layerBob: number,
  maxLift = 0,
): void {
  const { cx, rx, ry } = geom;
  const cy = geom.cyTop + layerBob;
  const sunX = Math.cos(sunAzimuth), sunUp = ELEV_LIGHT * Math.sin(sunAzimuth);
  const d = img.data;
  const w = img.width, h = img.height;
  const lift = maxLift > 0 ? maxLift : 0;
  const y0 = Math.max(0, Math.floor(cy - ry - lift));
  const y1 = Math.min(h - 1, Math.ceil(cy + ry));
  // ±1 px: land columns can round just outside the geometric rim.
  const x0 = Math.max(0, Math.floor(cx - rx) - 1);
  const x1 = Math.min(w - 1, Math.ceil(cx + rx) + 1);
  const it = zoomIters();
  if (it) it.dayNight = (it.dayNight ?? 0) + Math.max(0, y1 - y0 + 1) * Math.max(0, x1 - x0 + 1);
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = (px - cx) / rx;
      const dx2 = dx * dx;
      if (dx2 > 1.02) continue;
      const dy = (py - cy) / ry;
      if (dx2 + dy * dy > 1) {
        // Outside the flat disc: only the skyward lift column (peaks).
        if (dy >= 0 || lift <= 0) continue;
        const faceTop = cy - ry * Math.sqrt(1 - dx2);
        if (py < faceTop - lift) continue;
      }
      const day = clamp01(0.38 + 0.9 * (dx * sunX + sunUp));   // sky/SunLight.sunLit, inlined
      const night = 1 - day;
      if (night < 0.06) continue;
      const o = (py * w + px) * 4;
      d[o] = 6; d[o + 1] = 8; d[o + 2] = 22;
      d[o + 3] = Math.round(night * 0.58 * 255);
    }
  }
}

/** Surface water bands for the animated fluid overlay (habitable path). */
export function cutawayWaterSurf(type: HabitableType): {
  deep: RGB; mid: RGB; light: RGB; glint: RGB;
} {
  return paletteFor(type).waterSurf;
}

/**
 * Distance from each water pixel to the nearest land on the pancake.
 * Land seeds occupancy===0 inside the ellipse; BFS walks only water.
 * Water that never meets land stays 0 (paintFluids falls back).
 *
 * Camera bakes pass `margin` (FOAM_REACH * k): the field is baked on the
 * canvas plus that many pixels on every side, classifying the extra pixels
 * with `waterAt`, then cropped — so water at the edge of the view measures to
 * a coast just beyond it rather than to nothing. `blurStride` (round(k)) keeps
 * the wavefront smoothing a world-sized kernel (Ruling 6).
 */
export function bakeShoreDistance(
  occupancy: Uint8Array, geom: HabitableGeom, w: number, h: number,
  margin = 0, waterAt?: (x: number, y: number) => boolean, blurStride = 1,
): Float32Array {
  return drain(shoreSteps(occupancy, geom, w, h, margin, waterAt, blurStride));
}

/** {@link bakeShoreDistance}, sliced: yields between rows and BFS batches. */
export function* shoreSteps(
  occupancy: Uint8Array, geom: HabitableGeom, w: number, h: number,
  margin = 0, waterAt?: (x: number, y: number) => boolean, blurStride = 1,
): BakeSteps<Float32Array> {
  if (margin <= 0) return yield* shoreDistanceCore(occupancy, geom, w, h, blurStride);
  const m = Math.ceil(margin), W = w + 2 * m, H = h + 2 * m;
  const occ = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = y - m;
    for (let x = 0; x < W; x++) {
      const sx = x - m;
      occ[y * W + x] = (sx >= 0 && sy >= 0 && sx < w && sy < h)
        ? occupancy[sy * w + sx]
        : (waterAt && waterAt(sx, sy) ? 1 : 0);
    }
    yield;
  }
  const ext = yield* shoreDistanceCore(occ, { ...geom, cx: geom.cx + m, cyTop: geom.cyTop + m }, W, H, blurStride);
  const dist = new Float32Array(w * h);
  for (let y = 0; y < h; y++) dist.set(ext.subarray((y + m) * W + m, (y + m) * W + m + w), y * w);
  return dist;
}

function* shoreDistanceCore(
  occupancy: Uint8Array, geom: Pick<HabitableGeom, 'cx' | 'cyTop' | 'rx' | 'ry'>, w: number, h: number,
  blurStride: number,
): BakeSteps<Float32Array> {
  let scan = 0, bfs = 0, blurMax = 0;   // visits per pass, for the bounded-work check
  const dist = new Float32Array(w * h);
  const seen = new Uint8Array(w * h);
  const q = new Int32Array(w * h);
  let head = 0, tail = 0;
  const { cx, cyTop, rx, ry } = geom;
  for (let y = 0; y < h; y++) {
    const dy = (y - cyTop) / ry;
    for (let x = 0; x < w; x++) {
      scan++;
      const i = y * w + x;
      if (occupancy[i] !== 0) continue;
      const dx = (x - cx) / rx;
      if (dx * dx + dy * dy > 1) continue;
      seen[i] = 1;
      q[tail++] = i;
    }
    if ((y & 7) === 7) yield;
  }
  while (head < tail) {
    if ((++bfs & 16383) === 0) yield;
    const i = q[head++];
    const x = i % w, y = (i / w) | 0;
    for (let oy = -1; oy <= 1; oy++) {
      const ny = y + oy;
      if (ny < 0 || ny >= h) continue;
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue;
        const nx = x + ox;
        if (nx < 0 || nx >= w) continue;
        const ni = ny * w + nx;
        if (occupancy[ni] !== 1 || seen[ni]) continue;
        seen[ni] = 1;
        dist[ni] = dist[i] + (ox !== 0 && oy !== 0 ? 1.414 : 1);
        q[tail++] = ni;
      }
    }
  }
  // Two blur passes so wavefronts follow the coast instead of octagon rings.
  const s = Math.max(1, Math.round(blurStride)), sw = s * w;
  const tmp = new Float32Array(dist);
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? dist : tmp;
    const dst = pass === 0 ? tmp : dist;
    let blur = 0;
    for (let y = s; y < h - s; y++) {
      for (let x = s; x < w - s; x++) {
        blur++;
        const i = y * w + x;
        if (occupancy[i] !== 1) continue;
        dst[i] = (
          src[i] * 2
          + src[i - s] + src[i + s] + src[i - sw] + src[i + sw]
        ) / 6;
      }
      if ((y & 7) === 7) yield;
    }
    if (blur > blurMax) blurMax = blur;
  }
  const it = zoomIters();
  if (it) { it.shoreScan = scan; it.shoreBfs = bfs; it.shoreBlur = blurMax; it.shore = Math.max(scan, bfs, blurMax); }
  return dist;
}

/** 2-D smooth value noise → [0,1). */
function noise2(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const n = (ix: number, iy: number) => hash1(ix * 374761 + iy * 668265, seed);
  const a = n(x0, y0), b = n(x0 + 1, y0);
  const c = n(x0, y0 + 1), d = n(x0 + 1, y0 + 1);
  return mix(mix(a, b, ux), mix(c, d, ux), uy);
}

/**
 * Cheap Worley edge field — bright on cell boundaries, dark in pocket centres.
 * Returns √F2 − √F1 style ridge strength in roughly [0, ~0.7].
 */
function cellRidge(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 9, f2 = 9;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const jx = ix + ox, jy = iy + oy;
      const px = jx + hash1(jx + jy * 113, seed);
      const py = jy + hash1(jx * 57 + jy, seed + 19);
      const ddx = x - px, ddy = y - py;
      const d = ddx * ddx + ddy * ddy;
      if (d < f1) { f2 = f1; f1 = d; }
      else if (d < f2) f2 = d;
    }
  }
  return Math.sqrt(f2) - Math.sqrt(f1);
}

/** Surface-wave tuning for the caustic (non-magma) fluid path. */
const SWELL_K = 0.30;        // radians per px of shore distance → wavelength ≈ 21 px
const SWELL_W = 1.6;         // radians per second at speed 1
const FOAM_REACH = 5.0;      // px of shore distance that gets the crash/foam band
/**
 * Bare young ground for a world still forming: no soil, no cover. Lowlands are
 * dark basalt regolith, uplands paler weathered rock; beaches and ice stay as
 * they are. Two moisture steps keep the old climate zones faintly readable.
 */
function barrenGround(biome: BiomeType, elevation: number, moisture: number): RGB {
  if (biome === 'beach' || biome === 'snow') return paletteFor('rocky').biome[biome];
  const up = clamp01((elevation - SEA_LEVEL) / 0.35);
  const damp = moisture > 0.5 ? 1 : 0;
  return rgb(
    92 + up * 46 - damp * 10,
    80 + up * 40 - damp * 6,
    72 + up * 34 - damp * 2,
  );
}

/** Formation crust over cooling magma (see paintFluids `heat`). */
const CRUST_DARK: RGB = { r: 38, g: 26, b: 24 };
const CRUST_WARM: RGB = { r: 78, g: 34, b: 22 };
/**
 * Caustic web tuning (see paintFluids). Scale is cells per world px; warp is
 * how far, in cells, the scrolling noise bends the web; move its scroll speed.
 * FADE_CUT hides the web wherever the slow fade noise is below it (most of
 * the sea); LINE is the ridge width of a line; SPECULAR the glint threshold.
 */
const CAUSTIC_SCALE = 0.075;
const CAUSTIC_WARP = 0.9;
const CAUSTIC_MOVE = 0.08;
const CAUSTIC_FADE_CUT = 0.36;
const CAUSTIC_LINE = 0.068;
const CAUSTIC_SPECULAR = 0.48;
/** World rows between glint strokes. */
const GLINT_ROW = 3;
/** 4x4 ordered dither, 0..1 — pixel-art band transitions, keyed on world px. */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);

/**
 * Live water on occupancy pixels.
 *
 * Habitable oceans use cellular caustics — a sparse bright web with soft
 * cyan halos over a mid-blue body. Open water stays mostly calm; detail and
 * foam concentrate near coasts as the shore-bound swell crashes in.
 *
 * Motion is NOT a global drift: a swell travels along the baked shore-distance
 * field toward smaller distance, so crests advance onto every coast from open
 * water. Each crest displaces the web along the local landward normal (bounded
 * travelling compression), and near land collapses into a foam band.
 *
 * Magma keeps its hotter travelling churn; ice/desert run the same caustic
 * slower.
 *
 * Decal canopies stamp onto land *after* the cliff-punch clears water cells
 * for fluids, so a shore tree can overhang into occupancy===1. Pass
 * `landCover` (land bake RGBA, same space as occupancy) so opaque foliage
 * wins and water does not paint over it.
 */
export function paintFluids(
  img: ImageData, geom: HabitableGeom, occupancy: Uint8Array,
  planetType: HabitableType, elapsed: number, layerBob: number,
  shoreDist?: Float32Array | null,
  k = 1,
  /**
   * Scale of the web's 1-px line thresholds; always `k` in the game. A
   * separate argument only so tools/zoomCheck's control can render the
   * camera set with the glint width left unscaled.
   */
  lineK = k,
  /**
   * Where `occupancy` / `shoreDist` live when they are not this image's own
   * pixels (spec 5b): an overscanned camera set drawn through the live camera,
   * or the identity set under it. Omitted: the image's own pixels (identity,
   * and a camera set at its own camera with no overscan) — the exact pre-5b path.
   */
  map?: FluidMap | null,
  /** Land bake RGBA in occupancy-buffer space; alpha > 0 blocks fluid paint. */
  landCover?: Uint8ClampedArray | null,
  /**
   * Magma only: 1 = an open magma sea; lower = a world cooling through its
   * formation (Formation.formationHeat), where dark crust plates skin over the
   * melt and only the cracks between them still glow.
   */
  heat = 1,
): void {
  const { cx, rx, ry } = geom;
  const cy = geom.cyTop + layerBob;
  const t = elapsed;
  const pal = cutawayWaterSurf(planetType);
  // Zoom camera (k = camera zoom; 1 = identity, byte-identical to before zoom).
  // The water texture is anchored in the world: noise coordinates and shore
  // distances are converted to base-world px (x 1/k), so every per-px
  // frequency and px distance below (SWELL_K, FOAM_REACH, CAUSTIC_FADE, the
  // depth ramp, cellScale, grain/blob, magma drift) keeps its world size. The
  // web's line thresholds (glint, halo, whisper) are 1-px strokes: the ridge
  // distance is scaled by k so a line stays one screen px wide.
  const invK = 1 / k, invL = 1 / lineK;
  const rimCut = k === 1 ? 0.94 : (1 - (1 - Math.sqrt(0.94)) / k) ** 2;
  const d = img.data;
  const w = img.width, h = img.height;
  let y0 = Math.max(0, Math.floor(cy - ry));
  let y1 = Math.min(h - 1, Math.ceil(cy + ry));
  let x0 = Math.max(0, Math.floor(cx - rx));
  let x1 = Math.min(w - 1, Math.ceil(cx + rx));
  // Buffer space: the image's own pixels, or `map` (screen -> buffer, nearest).
  const bw = map ? map.bw : w, bh = map ? map.bh : h;
  const mInv = map ? map.inv : 1, mOx = map ? map.ox : 0, mOy = map ? map.oy : 0;
  // Shore distances are in the buffer's px: world px = shore / its zoom.
  const invS = map ? 1 / map.shoreK : 1 / k;
  if (map) {
    x0 = Math.max(x0, map.x0); x1 = Math.min(x1, map.x1);
    y0 = Math.max(y0, map.y0); y1 = Math.min(y1, map.y1);
  }
  const hasShore = !!(shoreDist && shoreDist.length === bw * bh);
  const hasCover = !!(landCover && landCover.length === bw * bh * 4);
  let iters = 0;
  // Magma churns hotter/faster; ice melt is sluggish; desert oases barely breathe.
  const speed =
    planetType === 'lava' ? 2.35
    : planetType === 'ice' ? 0.55
    : planetType === 'desert' ? 0.35
    : 1.0;
  const useCaustic = planetType !== 'lava';
  const seed = 0xca07 + (planetType.length * 97);
  const omega = SWELL_W * speed;
  // The shelf band sits between the body and the light crest colour.
  const shelf: RGB = rgb((pal.mid.r + pal.light.r) >> 1, (pal.mid.g + pal.light.g) >> 1, (pal.mid.b + pal.light.b) >> 1);
  // Translucent caustic tints: the line colour over each band, quantised to
  // one step each so the sea keeps a small palette.
  const tint = (a: RGB, k: number): RGB => rgb(
    Math.round(a.r + (pal.light.r - a.r) * k), Math.round(a.g + (pal.light.g - a.g) * k), Math.round(a.b + (pal.light.b - a.b) * k));
  const causticMid = tint(pal.mid, 0.42), causticDeep = tint(pal.deep, 0.3);

  for (let py = y0; py <= y1; py++) {
    const sourceY = py - layerBob;
    const bufY = map ? Math.floor((sourceY + 0.5) * mInv + mOy) : sourceY;
    for (let px = x0; px <= x1; px++) {
      iters++;
      const idx = py * w + px;
      // Offset keeps the noise domain positive, as in SurfaceDecals.
      const lx = (px - cx) * invK + 4096, ly = (sourceY - geom.cyTop) * invK + 4096;
      const bufX = map ? Math.floor((px + 0.5) * mInv + mOx) : px;
      if (bufY < 0 || bufY >= bh || bufX < 0 || bufX >= bw || occupancy[bufY * bw + bufX] !== 1) continue;
      // Foliage overhanging the sea lives in the land bake on water occupancy.
      if (hasCover && landCover![(bufY * bw + bufX) * 4 + 3] > 0) continue;
      const dx = (px - cx) / rx;
      const dy = (py - cy) / ry;
      const r2 = dx * dx + dy * dy;
      if (r2 > 1) continue;
      const src = bufY * bw + bufX;
      const shore = hasShore ? shoreDist![src] : 0;
      const shoreW = shore * invS;   // world px

      let c = pal.mid;
      if (useCaustic) {
        // Pixel-art sea: flat dithered depth bands, twinkling wave dashes in
        // open water, and surf lines that roll in onto every coast.
        const wx = Math.floor(lx), wy = Math.floor(ly);
        const bayer = BAYER4[((wy & 3) << 2) | (wx & 3)];
        const grain = noise2(lx * 0.23, ly * 0.23, seed + 11);

        // Depth tone 0 (shelf) … 1 (open ocean), with slow patches so the
        // bands wander instead of tracing the coast exactly.
        const patch = noise2(lx * 0.045, ly * 0.08, seed + 23) - 0.5;
        const tone = hasShore && shore > 0
          ? clamp01((shoreW - 1.5) / 9 + patch * 0.35)
          : clamp01(0.72 + Math.sqrt(r2) * 0.3 + patch * 0.2);
        const band = tone * 2.6 + (bayer - 0.5) * 0.9;
        c = band < 0.7 ? shelf : band < 1.75 ? pal.mid : pal.deep;

        // Caustic web (after jess-hammer's 2d pixel water shader): a Voronoi
        // edge field, seen flat (rows stretched by the board squash), whose
        // domain is warped by slowly scrolling noise so the web wobbles like
        // refracted light. A second, very slow noise fades whole patches in
        // and out so it never covers the sea. Lines are 1 screen px and drawn
        // as a translucent tint of the band they cross, not as bright paint;
        // only where two moving noises line up does a line catch a glint.
        const offShore = !hasShore || shore <= 0 || shoreW > FOAM_REACH * 2.2;
        if (offShore) {
          const fade = noise2(lx * 0.018 + t * 0.03 * speed, ly * 0.03, seed + 61);
          if (fade > CAUSTIC_FADE_CUT) {
            const wx2 = lx * CAUSTIC_SCALE, wy2 = ly * CAUSTIC_SCALE / BOARD_SQUASH;
            const wob = t * CAUSTIC_MOVE * speed;
            const qx = wx2 + (noise2(wx2 * 0.7 + wob, wy2 * 0.7, seed + 3) - 0.5) * CAUSTIC_WARP;
            const qy = wy2 + (noise2(wx2 * 0.7, wy2 * 0.7 - wob, seed + 5) - 0.5) * CAUSTIC_WARP;
            const ridge = cellRidge(qx, qy, seed) * lineK;
            // Patches fade in from their edge: thinner lines near the cut.
            const strength = clamp01((fade - CAUSTIC_FADE_CUT) / 0.18);
            if (ridge < CAUSTIC_LINE * (0.45 + 0.55 * strength)) {
              c = strength > 0.65 ? pal.light : c === pal.deep ? causticDeep : causticMid;
            }
          }
          // Specular glints, a separate layer as in the reference: two slowly
          // moving noises multiplied and thresholded. Drawn only on every
          // third world row, one screen px tall, so a glint is a short bright
          // stroke at any zoom rather than a blob.
          const row = ((ly % GLINT_ROW) + GLINT_ROW) % GLINT_ROW;
          if (row * lineK < 1) {
            const spec = noise2(lx * 0.32 + t * 0.12 * speed, ly * 0.15, seed + 71)
                       * noise2(lx * 0.06 - t * 0.1 * speed, ly * 0.12 + 9.1, seed + 73);
            if (spec > CAUSTIC_SPECULAR) c = pal.glint;
          }
        }

        if (hasShore && shore > 0) {
          // Surf: crests travel to SMALLER shore distance (constant phase) and
          // break up toward the beach. 1 px lines, broken by grain.
          const ph = shoreW * SWELL_K + t * omega;
          const crest = Math.sin(ph);
          const reach = clamp01(1 - shoreW / (FOAM_REACH * 2.2));
          const line = crest - (1 - reach * 0.22) + (grain - 0.5) * 0.12;
          if (reach > 0 && line > 0) c = shoreW < FOAM_REACH && line > 0.06 ? pal.glint : pal.light;
          // Wet edge: the water's first pixel against the land is always foam.
          if (shoreW < 1.2 * invK * lineK + 0.6) c = pal.glint;
        }
      } else {
        // Magma: keep travelling swell + hot glint.
        const toward = shore > 0 ? shore * invS : Math.sqrt(r2) * rx * invK;
        const drift = Math.sin(lx * 0.055 - ly * 0.04) * 2.4;
        const wave = Math.sin((toward + drift) * 0.22 + t * 1.15 * speed)
                   + Math.cos((toward + drift) * 0.09 + t * 0.42 * speed) * 0.35;
        if (wave > 0.48) c = pal.glint;
        else if (wave > 0.22) c = pal.light;
        else if (wave < -0.55) c = pal.deep;
        if (heat < 1) {
          // Crust plates: a slow-drifting cell field. Cooler = more plate, and
          // plates darken toward basalt; the seams between them stay molten.
          const cr0 = noise2(lx * 0.09 + t * 0.02, ly * 0.16, seed + 41)
                    + 0.5 * noise2(lx * 0.21, ly * 0.37 - t * 0.015, seed + 43);
          const plate = cr0 / 1.5;                       // 0..1
          const cut = 0.62 - (1 - heat) * 0.55;          // heat .55 → .37, .28 → .22
          if (plate > cut + 0.035) {
            const k2 = clamp01((plate - cut) * 4);
            c = k2 > 0.5 || heat < 0.4 ? CRUST_DARK : CRUST_WARM;
          } else if (plate > cut) c = pal.light;          // glowing seam
        }
      }

      let cr = c.r, cg = c.g, cb = c.b;
      if (r2 > rimCut) {
        cr = Math.min(255, cr + 45);
        cg = Math.min(255, cg + 45);
        cb = Math.min(255, cb + 55);
      }
      const o = idx * 4;
      d[o] = cr;
      d[o + 1] = cg;
      d[o + 2] = cb;
      d[o + 3] = 255;
    }
  }
  const it = zoomIters();
  if (it) it.fluids = (it.fluids ?? 0) + iters;
}

/**
 * Screen pixel -> buffer pixel for {@link paintFluids} (spec 5b), nearest:
 * buffer x = floor((px + 0.5) * inv + ox), y likewise from the un-bobbed row.
 * At zoom ratio 1 with whole offsets this is exactly px + ox. `shoreK` is the
 * buffer's own zoom (its shore distances are in its px); `x0..y1` clip the
 * painted screen rect (a strip of the view).
 */
export interface FluidMap {
  inv: number; ox: number; oy: number; bw: number; bh: number; shoreK: number;
  x0: number; y0: number; x1: number; y1: number;
}

export interface HabitableFrameInput {
  g: CanvasRenderingContext2D;
  dt: number;
  elapsed: number;
  /** Space behind everything; the host slides a panorama with the year. */
  drawBackdrop: (g: CanvasRenderingContext2D) => void;
  drawFarSpace: (g: CanvasRenderingContext2D) => void;
  /** Drawn on the ground, under the weather: city lights, inhabitants. */
  drawSurfaceOverlays: (g: CanvasRenderingContext2D) => void;
  /** Drawn over everything but moons: tile markers, divine effects. Never under weather. */
  drawUiOverlays: (g: CanvasRenderingContext2D) => void;
  drawNearMoons: (g: CanvasRenderingContext2D) => void;
  /** Local day angle in radians; 0 lights the +x limb. */
  sunAzimuth?: number;
  /** Subsolar latitude, radians (seasons). Omitted: 0. */
  sunLat?: number;
  /** CSS camera zoom; atmosphere dissolves as this rises. */
  viewZoom?: number;
  /** This world's air. Omitted: the shipped per-type air. */
  air?: AtmosphereChannel;
}

/**
 * The layers baked for one non-identity camera (see `setCamera`). The identity
 * set is the engine's own fields, baked by `bake()` exactly as before zoom.
 *
 * Overscan (spec 5b): the set covers the view plus `mx` / `my` px on every
 * side (`overscan` x the view), so a pan at this zoom slides the baked layers
 * instead of re-baking them. Every buffer and canvas is W x H, in the set's
 * own pixels: set px (X, Y) shows the world point
 * `screenToWorld(camera, W, H, X, Y)`.
 */
interface CameraLayerSet {
  camera: Camera;
  /** `applyCamera(base geometry, camera, W, H)`: the geometry in the set's own pixels. */
  geom: HabitableGeom;
  /** The identity bake options with this geometry and size, `cameraZoom`, `camera` and a k-scaled `liftOf` / `maxLift`. */
  opts: CutawayBakeOpts;
  /** Overscanned size: the view plus `mx` / `my` on each side. */
  W: number;
  H: number;
  mx: number;
  my: number;
  crust: HTMLCanvasElement;
  land: HTMLCanvasElement;
  occupancy: Uint8Array;
  shoreDist: Float32Array;
  pick: Int32Array;
  /**
   * Land bake RGBA (same space as occupancy). Used so live fluids skip pixels
   * where decals overhang the sea. Refreshed whenever the surface is painted.
   */
  landCover: Uint8ClampedArray | null;
  /**
   * This set's weather painter: its own lookup (camera geometry, clamped to the
   * set plus the cloud lift below it, fractional field coordinates, ground lift
   * x k) and cloud lift x k. Null when the world has no weather. Built by the
   * bake, never per frame.
   */
  painter: WeatherPainter | null;
  /** Which of the engine's two layer slots holds crust, land, occupancy and pick. */
  slot: number;
}

/** Canvases and buffers a camera set is baked into; two, so one bakes while the other is shown. */
interface LayerSlot {
  crust: HTMLCanvasElement;
  land: HTMLCanvasElement;
  occupancy: Uint8Array;
  pick: Int32Array;
}

/**
 * A camera re-bake in progress (spec 5b): `full` bakes every layer for `cam`;
 * `surface` repaints the surface, pick and shore distance of the current
 * camera (the 4 s throttled rebake) and keeps its crust and painter.
 */
interface BakeJob {
  /** The camera object the host requested (returned by `stepBake`, matched by the controller). */
  cam: Camera;
  kind: 'full' | 'surface';
  set: CameraLayerSet;
  steps: BakeSteps;
  /** `surfaceEpoch` when the job started: a surface rebake during it leaves its land stale. */
  epoch: number;
}

/**
 * A copy of `o` whose number fields V8 stores as doubles from the start: each
 * is first written as a fraction, then the real value. These objects are
 * rewritten every frame of a pan (spec 5b); a field left at its integer
 * (Smi) representation is generalised on the first fractional write, and the
 * measured result was ~125 bytes of boxed numbers per frame.
 */
function doubleFields<T extends object>(o: T): T {
  const r: Record<string, number> = {};
  for (const k of Object.keys(o)) r[k] = 0.5;
  for (const k of Object.keys(o)) r[k] = (o as Record<string, number>)[k];
  return r as T;
}

/** What the host passes to `bake` / `resize`: the geometry is the engine's own. */
export type EngineBakeOpts = Omit<CutawayBakeOpts, 'cx' | 'cyTop' | 'rx' | 'ry'> & {
  w: number; h: number; weather?: ClimateSources | null; sunLat?: number;
};

/**
 * Owns static layers and composites moving habitable-world effects.
 * `drawGeom` includes bob for host-owned overlay placement.
 */
export class HabitableCutawayEngine {
  /**
   * Magma heat for the live fluid layer: 1 = open magma sea, lower while a
   * forming world's crust cools (Formation.formationHeat). Lava worlds only.
   */
  magmaHeat = 1;
  /** BASE (identity) geometry. The shown geometry is `activeGeom` / `drawGeom`. */
  geom: HabitableGeom = habitableGeom(1, 1);
  /** The camera the camera layer set was baked for; identity when there is none. */
  camera: Camera = identityCamera(1, 1);
  /**
   * Set by the host: draw (and pick, and expose geometry for) the camera layer
   * set instead of the identity set. Ignored while there is no camera set.
   *
   * The identity weather painter is frozen while the camera set is shown; on
   * the way back to the identity set (zoom back to 1, resize) it re-primes
   * from the running sim, or its frozen drops would show for ~0.3 s over a
   * sky that has moved on.
   */
  get showCamera(): boolean { return this.camShown; }
  set showCamera(v: boolean) {
    const was = this.shown !== null;
    this.camShown = v;
    if (was && this.shown === null) this.reprimeIdentityPainter();
    this.syncView();
  }
  private camShown = false;
  /**
   * Test hook (tools/zoomCheck): when set, atmosphere AND weather use this
   * intensity instead of `atmoHazeAmount` / `weatherAmount`. Never set in-game.
   */
  hazeOverride: number | null = null;
  /**
   * Overscan of a camera set, as a fraction of the view added on EACH side
   * (spec 5b). 0 (the default) bakes exactly the view, as before 5b; the
   * renderer sets 0.5 (see IsoDioramaRenderer for the measured choice).
   */
  overscan = 0;
  /**
   * Draw the identity layers, scaled by the zoom, where a pan has outrun the
   * shown set (spec 5b: a soft strip, never a blank one). Test hook: the
   * zoomCheck control turns it off; always on in the game.
   */
  underlay = true;
  /**
   * Shown set -> screen (spec 5b): set px (X, Y) is drawn at
   * (X * r + dx, Y * r + dy). r = live zoom / baked zoom; at r = 1 the offsets
   * are whole px (a pan). Identity (1, 0, 0) when no set is shown.
   */
  readonly viewMap = doubleFields({ r: 1, dx: 0, dy: 0 });

  private idOccupancy = new Uint8Array(1);
  private idShoreDist: Float32Array = new Float32Array(1);
  private idPick = new Int32Array(1);
  private camSet: CameraLayerSet | null = null;
  /** `identityCamera(w, h)`, kept so `activeCamera` never allocates per frame. */
  private idCamera: Camera = identityCamera(1, 1);
  /** The live camera the host draws the shown set through (`setView`), when set. */
  private viewCam: Camera = doubleFields(identityCamera(1, 1));
  private viewSet = false;
  /** The camera and geometry the shown set is drawn through this frame (mutable, never reallocated). */
  private liveCam: Camera = doubleFields(identityCamera(1, 1));
  private liveGeom: HabitableGeom = doubleFields(habitableGeom(1, 1));
  /** Two layer slots: the shown set's and the one a bake job fills. */
  private slots: LayerSlot[] = [];
  private job: BakeJob | null = null;
  /** A re-centre requested while a same-zoom bake was running: started when it lands. */
  private nextCam: Camera | null = null;
  /** The camera set's surface must be repainted (a throttled rebake, or one during a bake). */
  private surfaceStale = false;
  private surfaceEpoch = 0;
  /** Uncovered strips of the view (spec 5b outrun), [x0, y0, x1, y1) x up to 4; see `computeStrips`. */
  private strips = new Float64Array(16);
  private stripCount = 0;
  /** Reused per frame: the shown set's and a strip's buffer maps for paintFluids. */
  private setMap: FluidMap = { inv: 1, ox: 0, oy: 0, bw: 1, bh: 1, shoreK: 1, x0: 0, y0: 0, x1: 0, y1: 0 };
  private stripMap: FluidMap = { inv: 1, ox: 0, oy: 0, bw: 1, bh: 1, shoreK: 1, x0: 0, y0: 0, x1: 0, y1: 0 };
  /**
   * Stable placement (spec 3): the decal and chimney plans, made ONCE per
   * identity bake (`bake`, `rebakeSurface`) from the identity options and
   * stored in base-world px (`wx, wy`, plus the cell). Every layer set stamps
   * them — the identity set 1:1, a camera set through its camera — and a
   * camera change never re-plans, so nothing appears, vanishes or moves on zoom.
   */
  private planDecals: DecalSite[] | null = null;
  private planChimneys: VolcanoChimney[] = [];

  private crust = document.createElement('canvas');
  private land = document.createElement('canvas');
  /** Identity land bake RGBA — fluids skip opaque pixels (decal overhang). */
  private idLandCover: Uint8ClampedArray | null = null;
  private atmoScratch = document.createElement('canvas');
  private fluidScratch = document.createElement('canvas');
  private weatherScratch = document.createElement('canvas');
  private atmoG: CanvasRenderingContext2D | null = null;
  private weatherG: CanvasRenderingContext2D | null = null;
  private weatherImage: ImageData | null = null;
  private weatherSim: WeatherSim | null = null;
  private weatherPainter: WeatherPainter | null = null;
  /** Climate the painters were last given (a camera painter is built from it). */
  private weatherClimate: ClimateSources | null = null;
  /** Entries in the identity weather lookup: a camera painter's particle cap scales from it. */
  private idLutCount = 1;
  private weatherAcc = 0;
  /** Grid longitude at the disc centre, and +1 when screen +x is east. */
  private weatherFocusLon = 0;
  private weatherEast = 1;
  private atmoImage: ImageData | null = null;
  private fluidImage: ImageData | null = null;
  private surfaceBakeOpts: CutawayBakeOpts | null = null;
  private w = 1;
  private h = 1;
  private planetType: HabitableType = 'ocean';
  private seed = 1;
  private gasBands: RGB[] = [];
  private hasRing = false;
  private elapsed = 0;

  constructor() {
    this.resizeLayers(1, 1);
  }

  /** The camera set when the host shows it, else null (identity). */
  private get shown(): CameraLayerSet | null {
    return this.camShown ? this.camSet : null;
  }

  private reprimeIdentityPainter(): void {
    if (this.weatherPainter && this.weatherSim) this.weatherPainter.reprime(this.weatherSim, this.weatherAcc / WX_DT);
  }

  /** Land/water of the ACTIVE layer set, 1 = fluid (a camera set's: W x H, its own px). */
  get occupancy(): Uint8Array { return this.shown?.occupancy ?? this.idOccupancy; }
  /** Shore distance of the ACTIVE layer set, in its px. */
  get shoreDist(): Float32Array { return this.shown?.shoreDist ?? this.idShoreDist; }
  /** Pick buffer of the ACTIVE layer set (a camera set's: W x H; `hitTest` maps screen px into it). */
  get pick(): Int32Array { return this.shown?.pick ?? this.idPick; }
  /** Geometry on screen: the live camera's while a camera set is shown, else the base geometry. */
  get activeGeom(): HabitableGeom { return this.shown ? this.liveGeom : this.geom; }
  /** The camera the screen shows: the live one while a camera set is shown, else identity. Never allocates. */
  get activeCamera(): Camera { return this.shown ? this.liveCam : this.idCamera; }
  /** A time-sliced camera bake is running or queued (see `stepBake`). */
  get bakePending(): boolean { return !!this.job || !!this.nextCam || (this.surfaceStale && !!this.camSet); }

  get bob(): number {
    return bobOf(this.elapsed, this.geom.R);
  }

  get drawGeom(): HabitableGeom & { bob: number } {
    return { ...this.activeGeom, bob: this.bob };
  }

  /**
   * The live camera to draw the shown camera set through (spec 5b), once per
   * frame by the host; null pins it to the set's own camera. A pan at the set's
   * zoom slides the baked layers by whole px; another zoom (a wheel in
   * progress) scales them, nearest-neighbour. Allocation-free.
   */
  setView(cam: Camera | null): void {
    if (cam) {
      this.viewCam.zoom = cam.zoom; this.viewCam.fx = cam.fx; this.viewCam.fy = cam.fy;
      this.viewSet = true;
    } else {
      this.viewSet = false;
    }
    this.syncView();
  }

  /** Recompute `viewMap`, the live camera and the live geometry for the shown set. Allocation-free. */
  private syncView(): void {
    const cs = this.shown, m = this.viewMap, L = this.liveGeom, g = this.geom;
    const v = cs ? (this.viewSet ? this.viewCam : cs.camera) : this.idCamera;
    const c = this.liveCam;
    c.zoom = v.zoom; c.fx = v.fx; c.fy = v.fy;
    if (!cs || isIdentity(v, this.w, this.h)) {
      L.cx = g.cx; L.cyBody = g.cyBody; L.cyTop = g.cyTop; L.R = g.R; L.rx = g.rx; L.ry = g.ry; L.wall = g.wall; L.T = g.T;
    } else {
      // applyCamera(g, v, w, h), written in place (same arithmetic).
      const z = v.zoom, hw = this.w / 2, hh = this.h / 2;
      L.cx = (g.cx - v.fx) * z + hw; L.cyBody = (g.cyBody - v.fy) * z + hh; L.cyTop = (g.cyTop - v.fy) * z + hh;
      L.R = g.R * z; L.rx = g.rx * z; L.ry = g.ry * z; L.wall = g.wall * z; L.T = g.T * z;
    }
    if (!cs) { m.r = 1; m.dx = 0; m.dy = 0; return; }
    const b = cs.camera, r = v.zoom / b.zoom;
    let dx = this.w / 2 - (cs.W / 2) * r + (b.fx - v.fx) * v.zoom;
    let dy = this.h / 2 - (cs.H / 2) * r + (b.fy - v.fy) * v.zoom;
    // Same zoom: both foci are snapped to whole px, so the slide is whole px.
    if (r === 1) { dx = Math.round(dx); dy = Math.round(dy); }
    m.r = r; m.dx = dx; m.dy = dy;
  }

  /** A new planet: identity layers, the identity view and a fresh weather sim. */
  bake(opts: EngineBakeOpts): void {
    this.bakeIdentity(opts, false);
  }

  /**
   * A new SIZE for the same planet (spec 5, Resize): the base geometry and the
   * identity layers are recomputed, the camera set is dropped (the host
   * re-bakes it for the re-clamped camera at the new size), and the weather
   * sim, its fields, clock and `elapsed` are KEPT — the planet has not changed.
   * The identity painter is rebuilt for the new lookup and primed from the
   * running sim. Without a sim to keep (none yet, or a gas giant) it is `bake`.
   */
  resize(opts: EngineBakeOpts): void {
    this.bakeIdentity(opts, true);
  }

  private bakeIdentity(opts: EngineBakeOpts, keepSim: boolean): void {
    const sim = keepSim && opts.weather && opts.grid && opts.planetType !== 'gas' ? this.weatherSim : null;
    this.w = Math.max(1, Math.round(opts.w));
    this.h = Math.max(1, Math.round(opts.h));
    this.geom = habitableGeom(this.w, this.h);
    // A new bake is a new planet (or a new size): back to the identity view.
    this.camera = identityCamera(this.w, this.h);
    this.idCamera = identityCamera(this.w, this.h);
    this.camSet = null;
    this.camShown = false;
    this.job = null;
    this.nextCam = null;
    this.surfaceStale = false;
    this.planetType = opts.planetType;
    this.seed = opts.seed;
    if (!sim) this.elapsed = 0;
    this.idOccupancy = new Uint8Array(this.w * this.h);
    this.idShoreDist = new Float32Array(this.w * this.h);
    this.idPick = new Int32Array(this.w * this.h);
    if (opts.planetType === 'gas') {
      this.gasBands = makeGasBands(opts.seed);
      this.hasRing = ((opts.seed >>> 5) & 3) !== 0; // ~75%
    } else {
      this.gasBands = [];
      this.hasRing = false;
    }
    this.resizeLayers(this.w, this.h);
    const bakeOpts: CutawayBakeOpts = {
      ...opts, ...this.geom, w: this.w, h: this.h,
      occupancy: this.idOccupancy, pick: this.idPick,
      gasBands: this.gasBands.length ? this.gasBands : null,
    };
    this.surfaceBakeOpts = bakeOpts;
    this.planIdentity();
    const crustG = this.crust.getContext('2d');
    const landG = this.land.getContext('2d');
    if (crustG) paintCutawayCrust(crustG, bakeOpts);
    if (landG) paintCutawaySurface(landG, this.identityPaintOpts());
    this.idLandCover = this.snapshotLandCover(this.land);
    this.idShoreDist = bakeShoreDistance(this.idOccupancy, this.geom, this.w, this.h);
    // Weather: a fresh sim per bake — a new planet must never inherit the last
    // one's sky (the repo's recurring state-leak pattern). A resize keeps it.
    const keptClimate = this.weatherClimate;
    this.weatherSim = null;
    this.weatherPainter = null;
    this.weatherClimate = null;
    if (!sim) this.weatherAcc = 0;
    const grid = opts.grid;
    if (sim && grid && keptClimate) {
      const elevAt = subCellSampler(opts);
      const lut = buildWeatherLut(this.geom, opts.discToGrid,
        (row, col, r, dx, dy) => opts.liftOf(
          (elevAt?.(dx, dy) ?? opts.smoothElevation(grid, row, col)) - opts.rimFalloff(r)));
      this.weatherSim = sim;
      this.weatherPainter = new WeatherPainter(lut, keptClimate, (opts.maxLift ?? 18) + 6, opts.seed);
      this.weatherPainter.prepare(sim, this.weatherAcc / WX_DT, 0);   // primes over the running sky
      this.weatherClimate = keptClimate;
      this.idLutCount = Math.max(1, lut.count);
    } else if (opts.weather && grid && opts.planetType !== 'gas') {
      // Ground lift follows the sub-cell elevation like the surface does; the
      // lookup's field coordinates (fx/fy) stay per cell.
      const elevAt = subCellSampler(opts);
      const lut = buildWeatherLut(this.geom, opts.discToGrid,
        (row, col, r, dx, dy) => opts.liftOf(
          (elevAt?.(dx, dy) ?? opts.smoothElevation(grid, row, col)) - opts.rimFalloff(r)));
      // Orientation for the sun: which grid longitude faces the viewer, and
      // which way east runs on screen, read off the same projection.
      const lonOf = (col: number) => (col + 0.5) / GRID_SIZE * Math.PI * 2;
      const c0 = opts.discToGrid(0, 0), cE = opts.discToGrid(0.2, 0);
      this.weatherFocusLon = c0 ? lonOf(c0.col) : 0;
      if (c0 && cE) {
        const d = ((cE.col - c0.col) % GRID_SIZE + GRID_SIZE * 1.5) % GRID_SIZE - GRID_SIZE / 2;
        this.weatherEast = d < 0 ? -1 : 1;
      } else {
        this.weatherEast = 1;
      }
      this.weatherSim = new WeatherSim(opts.weather);
      this.weatherSim.sunLat = opts.sunLat ?? 0;   // before warm-up, or the first frames jump
      this.weatherSim.warmUp(WX_WARMUP);
      this.weatherPainter = new WeatherPainter(lut, opts.weather, (opts.maxLift ?? 18) + 6, opts.seed);
      this.weatherClimate = opts.weather;
      this.idLutCount = Math.max(1, lut.count);
    }
    this.syncView();
  }

  /**
   * Bake the camera layer set for `cam` NOW (distinct from `bake()`: same
   * planet, new view) and make it the camera set. Identity drops the camera
   * set. The time-sliced form is `requestCamera` + `stepBake`; this runs the
   * same steps to completion (tools, resize, the renderer's direct hook).
   * Keeps the weather sim and its fields, `elapsed`, the day angle and every
   * other animation state — only the static layers are re-baked, in `bake()`'s
   * order: zero occupancy, crust, surface, shore distance (with pick written by
   * the surface). Decals and chimneys are the stored IDENTITY plans (base-world
   * px) mapped through the camera and stamped x round(k) / x k, never re-planned.
   *
   * Weather: the set gets its own painter (see `cameraPainterSteps`) over the
   * SAME sim; while the set is shown only its painter spawns and moves
   * particles. The identity painter is frozen meanwhile and re-primes when the
   * identity set is shown again (see `showCamera`).
   *
   * Allocation per bake (once per settle, never per frame): the two layer
   * slots' canvases and occupancy / pick buffers are reused; the shore
   * distance, the weather lookup and the painter (pmax up to ~3.3k at zoom 4
   * without overscan) are rebuilt, and the previous ones become garbage at
   * once — tools/zoomCheck measures that 50 settles retain less heap than a
   * single camera set.
   */
  setCamera(cam: Camera): void {
    this.job = null;
    this.nextCam = null;
    if (isIdentity(cam, this.w, this.h) || !this.surfaceBakeOpts) {
      this.camera = { zoom: cam.zoom, fx: cam.fx, fy: cam.fy };
      this.dropCameraSet();
      return;
    }
    const job = this.startJob(cam, 'full');
    drain(job.steps);
    this.job = null;
    this.swapIn(job);
  }

  /** Back to the identity view: drop the camera layer set (zoom back to 1). */
  clearCamera(): void {
    this.setCamera(this.idCamera);
  }

  private dropCameraSet(): void {
    const was = this.shown !== null;
    this.camSet = null;
    this.job = null;
    this.nextCam = null;
    this.surfaceStale = false;
    if (was) this.reprimeIdentityPainter();
    this.syncView();
  }

  /**
   * Ask for the camera set of `cam`, baked time-sliced by `stepBake` while the
   * current set (or the identity view) keeps being drawn (spec 5b). A running
   * bake of another zoom is dropped; one of the same zoom (a re-centre) is
   * finished first and `cam` follows it. Identity drops the camera set.
   * Returns false when nothing needs baking (the set already shows `cam`).
   */
  requestCamera(cam: Camera): boolean {
    if (isIdentity(cam, this.w, this.h) || !this.surfaceBakeOpts) {
      this.camera = { zoom: cam.zoom, fx: cam.fx, fy: cam.fy };
      this.dropCameraSet();
      return false;
    }
    const job = this.job;
    if (job && job.kind === 'full' && job.cam.zoom === cam.zoom && job.set.W === this.setSize().W && job.set.H === this.setSize().H) {
      if (job.cam.fx === cam.fx && job.cam.fy === cam.fy) { this.nextCam = null; return true; }
      this.nextCam = cam;
      return true;
    }
    this.job = null;
    this.nextCam = null;
    const cur = this.camSet;
    if (cur && !this.surfaceStale && cur.camera.zoom === cam.zoom && cur.camera.fx === cam.fx && cur.camera.fy === cam.fy
        && cur.W === this.setSize().W && cur.H === this.setSize().H) return false;
    this.startJob(cam, 'full');
    return true;
  }

  /**
   * Run the pending camera bake for at most `budgetMs` (Infinity: to
   * completion). When it completes, its set replaces the current one at once
   * and the requested camera is returned (a surface-only rebake returns null);
   * otherwise null. Whatever is drawn meanwhile is the current set, untouched.
   */
  stepBake(budgetMs: number): Camera | null {
    if (!this.job) {
      if (this.nextCam) { const c = this.nextCam; this.nextCam = null; this.startJob(c, 'full'); }
      else if (this.surfaceStale && this.camSet) this.startJob(this.camSet.camera, 'surface');
      else return null;
    }
    const job = this.job!;
    const deadline = budgetMs === Infinity ? Infinity : performance.now() + budgetMs;
    for (;;) {
      if (job.steps.next().done) break;
      if (deadline !== Infinity && performance.now() >= deadline) return null;
    }
    this.job = null;
    this.swapIn(job);
    return job.kind === 'full' ? job.cam : null;
  }

  /** The overscanned set size for this view. */
  private setSize(): { W: number; H: number; mx: number; my: number } {
    const mx = Math.round(this.w * this.overscan), my = Math.round(this.h * this.overscan);
    return { W: this.w + 2 * mx, H: this.h + 2 * my, mx, my };
  }

  /** Slot `i` sized W x H (canvases and buffers kept when the size matches). */
  private slotOf(i: number, W: number, H: number): LayerSlot {
    let s = this.slots[i];
    if (!s) {
      s = { crust: document.createElement('canvas'), land: document.createElement('canvas'), occupancy: new Uint8Array(0), pick: new Int32Array(0) };
      this.slots[i] = s;
    }
    if (s.crust.width !== W || s.crust.height !== H) {
      s.crust.width = W; s.crust.height = H;
      s.land.width = W; s.land.height = H;
    }
    if (s.occupancy.length !== W * H) s.occupancy = new Uint8Array(W * H);
    if (s.pick.length !== W * H) s.pick = new Int32Array(W * H);
    return s;
  }

  /** Begin a bake job into the slot the current set does not use. */
  private startJob(cam: Camera, kind: 'full' | 'surface'): BakeJob {
    const base = this.surfaceBakeOpts!;
    const { W, H, mx, my } = this.setSize();
    const cur = this.camSet;
    const slot = cur && cur.slot === 0 ? 1 : 0;
    const res = this.slotOf(slot, W, H);
    const camera: Camera = { zoom: cam.zoom, fx: cam.fx, fy: cam.fy };
    const set: CameraLayerSet = {
      camera, geom: applyCamera(this.geom, camera, W, H), opts: base, W, H, mx, my,
      crust: res.crust, land: res.land, occupancy: res.occupancy, pick: res.pick,
      shoreDist: new Float32Array(0), landCover: null, painter: null, slot,
    };
    set.opts = this.cameraOpts(base, set);
    let steps: BakeSteps;
    if (kind === 'surface' && cur && cur.W === W && cur.H === H) {
      set.painter = cur.painter;
      steps = this.surfaceJobSteps(set, cur);
    } else {
      kind = 'full';
      steps = this.fullSteps(set, base);
    }
    // A full bake paints the surface from the current plans.
    this.surfaceStale = false;
    this.job = { cam, kind, set, steps, epoch: this.surfaceEpoch };
    return this.job;
  }

  /** Every layer of a camera set, in `bake()`'s order. */
  private *fullSteps(set: CameraLayerSet, base: CutawayBakeOpts): BakeSteps {
    set.occupancy.fill(0);
    yield;
    const crustG = set.crust.getContext('2d');
    if (crustG) yield* crustSteps(crustG, set.opts);
    yield* this.paintCameraSurface(set);
    set.painter = yield* this.cameraPainterSteps(set, base);
  }

  /** The 4 s surface rebake of a camera set: its crust copied (unchanged), surface and shore repainted. */
  private *surfaceJobSteps(set: CameraLayerSet, from: CameraLayerSet): BakeSteps {
    const g = set.crust.getContext('2d');
    if (g) { g.clearRect(0, 0, set.W, set.H); g.drawImage(from.crust, 0, 0); }
    yield;
    yield* this.paintCameraSurface(set);
  }

  /**
   * Make a finished job's set the camera set. A re-centre at the same zoom
   * hands the shown set's live drops and bolts to the new painter (shifted to
   * its pixels), so the weather keeps falling across the swap.
   */
  private swapIn(job: BakeJob): void {
    const old = this.camSet, set = job.set;
    if (job.kind === 'full' && old && old.painter && set.painter && this.camShown
        && old.camera.zoom === set.camera.zoom) {
      const k = set.camera.zoom;
      const dx = Math.round((old.camera.fx - set.camera.fx) * k + (set.W - old.W) / 2);
      const dy = Math.round((old.camera.fy - set.camera.fy) * k + (set.H - old.H) / 2);
      set.painter.adopt(old.painter, dx, dy);
    }
    this.camSet = set;
    this.camera = set.camera;
    if (job.epoch !== this.surfaceEpoch) this.surfaceStale = true;
    this.syncView();
  }

  /**
   * A camera set's weather painter (spec 5: a NEW painter per camera set; the
   * sim, its fields and clock are kept). Lookup on the set geometry, clamped
   * to the set plus the cloud lift below it, with fractional field
   * coordinates (Ruling 3) and the k-scaled sub-cell ground lift; cloud lift,
   * fall speeds and other world sizes x k; spawn density per screen px as
   * before (Ruling 4). Dithered on world-anchored px (spec 5b), so two sets of
   * the same zoom agree. Primed from the running sim on its first frame, or
   * handed the previous set's drops at a same-zoom swap.
   */
  private *cameraPainterSteps(set: CameraLayerSet, base: CutawayBakeOpts): BakeSteps<WeatherPainter | null> {
    const sim = this.weatherSim, climate = this.weatherClimate, o = set.opts, grid = o.grid;
    if (!sim || !climate || !grid || o.planetType === 'gas') return null;
    const k = set.camera.zoom;
    const cloudLift = Math.round((base.maxLift + 6) * k);
    const elevAt = subCellSampler(o);
    const lut = yield* weatherLutSteps(set.geom, o.discToGrid,
      (row, col, r, dx, dy) => o.liftOf(
        (elevAt?.(dx, dy) ?? o.smoothElevation(grid, row, col)) - o.rimFalloff(r)),
      { bounds: { w: set.W, h: set.H, below: cloudLift }, projectF: o.discToGridF });
    yield;
    // Set px X shows world x = (X - W/2) / k + fx: X + round(fx * k - W/2) is
    // the same for one world point in every set of this zoom.
    const painter = new WeatherPainter(lut, climate, cloudLift, base.seed, {
      scale: k, pmax: WEATHER_PMAX * Math.max(1, lut.count / this.idLutCount),
      area: lut.count / this.idLutCount,
      ditherX: Math.round(set.camera.fx * k - set.W / 2), ditherY: Math.round(set.camera.fy * k - set.H / 2),
    });
    return painter;
  }

  /** The identity options re-targeted at a camera set: its size and geometry, world-class values x k. */
  private cameraOpts(base: CutawayBakeOpts, set: CameraLayerSet): CutawayBakeOpts {
    const k = set.camera.zoom, g = set.geom, liftOf = base.liftOf;
    return {
      ...base,
      w: set.W, h: set.H,
      cx: g.cx, cyTop: g.cyTop, rx: g.rx, ry: g.ry, R: g.R, wall: g.wall, cyBody: g.cyBody,
      cameraZoom: k, camera: set.camera,
      liftOf: (elev: number) => Math.round(liftOf(elev) * k),
      maxLift: Math.ceil(base.maxLift * k),
      crustDepthPx: crustDepthOf(this.geom.rx) * k,
      occupancy: set.occupancy, pick: set.pick,
      decalSites: null, chimneySites: null,
    };
  }

  /**
   * Plan decals and chimneys at the identity view, from the identity options,
   * and store them in base-world px. The identity bake's screen px ARE base
   * world px, so `wx, wy` are the planner's own `x, y`.
   */
  private planIdentity(): void {
    const base = this.surfaceBakeOpts;
    if (!base) { this.planDecals = null; this.planChimneys = []; return; }
    // A barren (still-forming) world plans stone only: crags, ore, crystal.
    this.planDecals = base.decalSeed !== undefined
      ? planSurfaceDecals(base, clamp01(base.lush ?? 0.3), base.decalSeed, undefined, !!base.barren)
        .map(d => ({ ...d, wx: d.x, wy: d.y }))
      : null;
    this.planChimneys = base.planetType === 'lava'
      ? planVolcanoChimneys(base).map(c => ({ ...c, wx: c.x, wy: c.y }))
      : [];
  }

  /** The identity options with the stored plans to stamp (1:1; the stamp records footing). */
  private identityPaintOpts(): CutawayBakeOpts {
    const base = this.surfaceBakeOpts!;
    return {
      ...base,
      decalSites: this.planDecals ?? (base.decalSeed !== undefined ? [] : null),
      chimneySites: this.planChimneys,
    };
  }

  /** Surface + shore distance of a camera set, from its own stored options (sliced). */
  private *paintCameraSurface(set: CameraLayerSet): BakeSteps {
    const { W, H } = set, cam = set.camera, k = cam.zoom;
    // The stored world plans through this camera: positions mapped, sizes
    // left in base px (the painters scale them by k / round(k)).
    const at = (x: number, y: number) => ({ x: (x - cam.fx) * k + W / 2, y: (y - cam.fy) * k + H / 2 });
    const opts: CutawayBakeOpts = {
      ...set.opts,
      decalSites: this.planDecals ? this.planDecals.map(s => ({ ...s, ...at(s.wx ?? s.x, s.wy ?? s.y) })) : [],
      chimneySites: this.planChimneys.map(c => {
        const p = at(c.wx ?? c.x, c.wy ?? c.y);
        return { ...c, x: Math.round(p.x), y: Math.round(p.y) };
      }),
    };
    const landG = set.land.getContext('2d');
    if (landG) yield* surfaceSteps(landG, opts);
    set.landCover = this.snapshotLandCover(set.land);
    set.shoreDist = yield* shoreSteps(set.occupancy, set.geom, W, H,
      Math.ceil(FOAM_REACH * k), (x, y) => faceWaterAt(opts, x, y), Math.round(k));
  }

  /**
   * Repaint the mutable top-face data of BOTH layer sets without resetting
   * animation or crust. The identity set is repainted at once; the camera
   * set's repaint is a time-sliced surface bake (`stepBake`), swapped in when
   * done. `includeCamera: false` skips it: the host passes that when a settle
   * re-bakes the camera set in the same frame (spec 5: the two merge into one
   * re-bake), so the camera set is painted once, from the fresh plans.
   */
  rebakeSurface(includeCamera = true): void {
    const landG = this.land.getContext('2d');
    this.planIdentity();
    if (landG && this.surfaceBakeOpts) paintCutawaySurface(landG, this.identityPaintOpts());
    this.idLandCover = this.snapshotLandCover(this.land);
    this.idShoreDist = bakeShoreDistance(this.idOccupancy, this.geom, this.w, this.h);
    this.surfaceEpoch++;
    if (includeCamera && this.camSet) this.surfaceStale = true;
  }

  /**
   * Merge live values into the stored bake options — of both layer sets.
   *
   * `rebakeSurface` repaints from `surfaceBakeOpts`, a snapshot taken at the
   * last full `bake()`. Anything that changes between full bakes — lushness as
   * the biosphere advances, the decal atlas once it finishes loading — has to
   * be merged in here first, or the repaint faithfully reproduces the old
   * world and nothing the player did appears to matter. The camera set's
   * options are re-derived from the merged identity options, so its geometry
   * and k-scaled relief cannot go stale.
   */
  updateSurfaceOpts(patch: Partial<CutawayBakeOpts>): void {
    if (!this.surfaceBakeOpts) return;
    this.surfaceBakeOpts = { ...this.surfaceBakeOpts, ...patch };
    if (this.camSet) this.camSet.opts = this.cameraOpts(this.surfaceBakeOpts, this.camSet);
  }

  /** New climate sources (lushness, civ level, stress). Keeps the current sky. */
  setWeatherClimate(c: ClimateSources | null): void {
    if (!c || !this.weatherSim || !this.weatherPainter) return;
    this.weatherSim.setClimate(c);
    this.weatherPainter.setClimate(c);
    this.camSet?.painter?.setClimate(c);
    this.job?.set.painter?.setClimate(c);
    this.weatherClimate = c;
  }

  /**
   * The parts of the view the shown set does not cover (a pan that outran the
   * overscan, or a wheel zooming out): up to 4 rects [x0, y0, x1, y1) in
   * un-bobbed screen px, in `strips`. Allocation-free.
   */
  private computeStrips(cs: CameraLayerSet): number {
    const m = this.viewMap, w = this.w, h = this.h, s = this.strips;
    const cx0 = m.dx, cx1 = m.dx + cs.W * m.r, cy0 = m.dy, cy1 = m.dy + cs.H * m.r;
    let n = 0;
    if (!(cx0 <= 0 && cy0 <= 0 && cx1 >= w && cy1 >= h)) {
      const clampY = (v: number) => (v < 0 ? 0 : v > h ? h : v), clampX = (v: number) => (v < 0 ? 0 : v > w ? w : v);
      const T = clampY(Math.ceil(cy0)), B = clampY(Math.floor(cy1));
      const put = (x0: number, y0: number, x1: number, y1: number) => {
        if (x1 <= x0 || y1 <= y0) return;
        s[n * 4] = x0; s[n * 4 + 1] = y0; s[n * 4 + 2] = x1; s[n * 4 + 3] = y1; n++;
      };
      put(0, 0, w, T);
      put(0, Math.max(T, B), w, h);
      if (B > T) {
        put(0, T, clampX(Math.ceil(cx0)), B);
        put(clampX(Math.floor(cx1)), T, w, B);
      }
    }
    this.stripCount = n;
    return n;
  }

  /** Snapshot land RGBA for fluid overhang tests (same buffer space as occupancy). */
  private snapshotLandCover(canvas: HTMLCanvasElement): Uint8ClampedArray | null {
    const g = canvas.getContext('2d');
    if (!g || canvas.width < 1 || canvas.height < 1) return null;
    return g.getImageData(0, 0, canvas.width, canvas.height).data;
  }

  /**
   * Static layers: the identity set, or the shown camera set through
   * `viewMap` (whole-px slide during a pan, nearest-neighbour scale during a
   * wheel) over the identity layers scaled by the live zoom wherever the set
   * does not reach (spec 5b). Public for tools/zoomCheck.
   */
  drawStatic(g: CanvasRenderingContext2D, layerBob: number): void {
    const cs = this.shown;
    if (!cs) {
      g.drawImage(this.crust, 0, layerBob);
      g.drawImage(this.land, 0, layerBob);
      return;
    }
    const m = this.viewMap;
    const n = this.computeStrips(cs);
    if (n > 0 && this.underlay) {
      const c = this.liveCam, z = c.zoom, hw = this.w / 2, hh = this.h / 2, s = this.strips;
      for (const layer of [this.crust, this.land]) {
        for (let i = 0; i < n; i++) {
          const x0 = s[i * 4], y0 = s[i * 4 + 1], x1 = s[i * 4 + 2], y1 = s[i * 4 + 3];
          g.drawImage(layer, (x0 - hw) / z + c.fx, (y0 - hh) / z + c.fy, (x1 - x0) / z, (y1 - y0) / z,
            x0, y0 + layerBob, x1 - x0, y1 - y0);
        }
      }
    }
    if (m.r === 1) {
      g.drawImage(cs.crust, m.dx, m.dy + layerBob);
      g.drawImage(cs.land, m.dx, m.dy + layerBob);
    } else {
      const W = cs.W * m.r, H = cs.H * m.r;
      g.drawImage(cs.crust, m.dx, m.dy + layerBob, W, H);
      g.drawImage(cs.land, m.dx, m.dy + layerBob, W, H);
    }
  }

  /** The shown set's buffer map for paintFluids, or null at its own camera with no overscan (the pre-5b path). */
  private fluidMapOf(cs: CameraLayerSet): FluidMap | null {
    const m = this.viewMap;
    if (m.r === 1 && m.dx === 0 && m.dy === 0 && cs.W === this.w && cs.H === this.h) return null;
    const f = this.setMap;
    f.inv = 1 / m.r; f.ox = -m.dx / m.r; f.oy = -m.dy / m.r; f.bw = cs.W; f.bh = cs.H; f.shoreK = cs.camera.zoom;
    f.x0 = 0; f.y0 = 0; f.x1 = this.w - 1; f.y1 = this.h - 1;
    return f;
  }

  frame(input: HabitableFrameInput): void {
    const { g, elapsed } = input;
    this.elapsed = elapsed;
    const bob = this.bob;
    const layerBob = Math.round(bob);
    // The active layer set: the camera set while the host shows it, drawn
    // through the live camera. Per-frame painters take the live geometry and
    // its zoom k (world sizes x k, strokes 1 px), bounded to the view.
    const cs = this.shown;
    const geom = cs ? this.liveGeom : this.geom;
    const k = cs ? this.liveCam.zoom : 1;
    // Atmosphere haze and weather intensity both follow the RENDERED zoom
    // (live camera when shown; CSS zoom during an identity gesture) — but they
    // fade on different curves so precip survives max zoom.
    const renderZ = cs ? k : (input.viewZoom ?? 1);
    const haze = this.hazeOverride ?? atmoHazeAmount(renderZ);
    const wx = this.hazeOverride ?? weatherAmount(renderZ);
    const painter = cs ? cs.painter : this.weatherPainter;
    if (cs && painter) { const m = this.viewMap; painter.setView(m.r, m.dx, m.dy); }

    input.drawBackdrop(g);
    input.drawFarSpace(g);
    const sunAzimuth = input.sunAzimuth ?? 0;
    if (this.planetType === 'gas') this.drawGasRings(g, true, bob, geom, k);
    this.drawStatic(g, layerBob);
    const fluids = this.fluidImage;
    if (fluids) {
      fluids.data.fill(0);
      if (!cs) {
        paintFluids(fluids, geom, this.idOccupancy, this.planetType, elapsed, layerBob, this.idShoreDist, 1, 1, null, this.idLandCover, this.magmaHeat);
      } else {
        paintFluids(fluids, geom, cs.occupancy, this.planetType, elapsed, layerBob, cs.shoreDist, k, k, this.fluidMapOf(cs), cs.landCover, this.magmaHeat);
        // Outrun strips: water from the identity buffers through the live camera.
        if (this.underlay) {
          const s = this.strips, f = this.stripMap, c = this.liveCam;
          for (let i = 0; i < this.stripCount; i++) {
            f.inv = 1 / c.zoom; f.ox = c.fx - (this.w / 2) / c.zoom; f.oy = c.fy - (this.h / 2) / c.zoom;
            f.bw = this.w; f.bh = this.h; f.shoreK = 1;
            f.x0 = s[i * 4]; f.y0 = s[i * 4 + 1] + layerBob; f.x1 = s[i * 4 + 2] - 1; f.y1 = s[i * 4 + 3] - 1 + layerBob;
            paintFluids(fluids, geom, this.idOccupancy, this.planetType, elapsed, layerBob, this.idShoreDist, k, k, f, this.idLandCover, this.magmaHeat);
          }
        }
      }
      const fluidG = this.fluidScratch.getContext('2d');
      if (fluidG) {
        fluidG.putImageData(fluids, 0, 0);
        g.drawImage(this.fluidScratch, 0, 0);
        fluids.data.fill(0);
        // maxLift: peaks rise above the face; veil must cover that column too.
        const veilLift = cs ? cs.opts.maxLift : (this.surfaceBakeOpts?.maxLift ?? 18);
        paintDayNight(fluids, geom, sunAzimuth, layerBob, veilLift);
        if (this.weatherSim) {
          // At most 4 steps per frame: a refocused tab hands us seconds of dt.
          // The sim's sun is the sun on screen: azimuth 0 lights the +x limb, so
          // the subsolar point is a quarter turn from the centre toward +x, and
          // it moves toward -x as the day turns.
          this.weatherSim.sunLon = this.weatherFocusLon + this.weatherEast * (Math.PI / 2 - sunAzimuth);
          this.weatherSim.sunLat = input.sunLat ?? 0;
          this.weatherAcc = Math.min(this.weatherAcc + input.dt, WX_DT * 4);
          while (this.weatherAcc >= WX_DT) {
            this.weatherAcc -= WX_DT;
            this.weatherSim.step(WX_DT);
            // Only the shown set's painter spawns and moves particles; the
            // other one is frozen until it is shown again.
            painter?.onStep(this.weatherSim);
          }
          if (painter) {
            painter.prepare(this.weatherSim, this.weatherAcc / WX_DT, input.dt);
            if (wx > 0.01) painter.paintShadows(fluids, sunAzimuth, wx);
          }
        }
        fluidG.putImageData(fluids, 0, 0);
        g.drawImage(this.fluidScratch, 0, 0);
      }
    }
    input.drawSurfaceOverlays(g);
    const weatherG = this.weatherG, weatherImage = this.weatherImage;
    if (painter && weatherImage && weatherG && wx > 0.01) {
      // putImageData-only, like the atmosphere canvas.
      weatherImage.data.fill(0);
      painter.paintClouds(weatherImage, sunAzimuth, wx);
      weatherG.putImageData(weatherImage, 0, 0);
      g.drawImage(this.weatherScratch, 0, 0);
    }
    const atmo = this.atmoImage;
    const atmoG = this.atmoG;
    if (atmo && atmoG && haze > 0.01) {
      // putImageData-only on this canvas — mixing drawImage here forces a
      // software rasterizer and the preview drops to ~1 fps.
      atmo.data.fill(0);
      const gasTint = this.planetType === 'gas' && this.gasBands.length
        ? averageBands(this.gasBands)
        : undefined;
      paintAtmosphere(atmo, geom, this.planetType, bob, sunAzimuth, haze, gasTint, input.air, k);
      atmoG.putImageData(atmo, 0, 0);
      g.drawImage(this.atmoScratch, 0, 0);
    }
    input.drawUiOverlays(g);
    if (this.planetType === 'gas') this.drawGasRings(g, false, bob, geom, k);
    input.drawNearMoons(g);
    this.drawVignette(g, this.geom, bob);
  }

  /**
   * Screen-space vignette: fixed to the canvas, so it is computed from the
   * BASE geometry whatever the camera. From a camera geometry its clear inner
   * radius (rx * 0.7) grows with the zoom and its centre follows the body off
   * screen, so the view would darken where it should not.
   */
  private drawVignette(g: CanvasRenderingContext2D, geom: HabitableGeom, bob: number): void {
    const vig = g.createRadialGradient(
      geom.cx, geom.cyBody + bob, geom.rx * 0.7,
      geom.cx, geom.cyBody + bob, Math.max(this.w, this.h) * 0.75,
    );
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = vig;
    g.fillRect(0, 0, this.w, this.h);
  }

  /**
   * Saturn-style rings around the pancake: back half behind the body, front
   * half after atmosphere (same ellipse-clip logic as legacy bakeGasGiant).
   *
   * `geom` is the ACTIVE geometry and `k` its zoom. Rings are iterated in BASE
   * space (radius rx/k * 1.28..1.92, one ring per base px) and drawn at x k:
   * ring spacing scales, the count does not, and each stroke stays 1 px.
   */
  private drawGasRings(
    g: CanvasRenderingContext2D, back: boolean, bob: number,
    geom: HabitableGeom = this.geom, k = 1,
  ): void {
    if (!this.hasRing || this.gasBands.length === 0) return;
    const { cx } = geom;
    const rxB = geom.rx / k;
    const cy = geom.cyTop + bob;
    const VW = this.w, VH = this.h;
    const ringInner = rxB * 1.28, ringOuter = rxB * 1.92, ringRy = 0.20;
    const bands = this.gasBands;
    const seed = this.seed;
    g.save();
    g.beginPath();
    g.rect(0, back ? 0 : cy, VW, back ? cy : VH - cy);
    g.clip();
    for (let rr = ringInner; rr < ringOuter; rr += 1) {
      const t = (rr - ringInner) / (ringOuter - ringInner);
      const gap = fbm1(t * 9, seed + 21, 3);
      const a = (0.14 + gap * 0.42) * (1 - Math.abs(t - 0.45) * 0.85);
      if (a <= 0.01) continue;
      const c = bands[Math.floor(t * bands.length) % bands.length];
      const rk = rr * k;
      g.strokeStyle = css(shade(c, 1.25), a);
      g.lineWidth = 1;
      g.beginPath();
      g.ellipse(cx, cy, rk, rk * ringRy, -0.12, 0, Math.PI * 2);
      g.stroke();
    }
    g.restore();
  }

  /**
   * The grid cell drawn at screen px (px, py): the shown camera set's pick
   * through `viewMap` (the live camera), the identity pick through the live
   * camera where the set does not reach, or the identity pick at identity.
   */
  hitTest(px: number, py: number): { row: number; col: number } | null {
    const y = py - Math.round(this.bob);
    if (px < 0 || px >= this.w || y < 0 || y >= this.h) return null;
    const cs = this.shown;
    let id = 0;
    if (cs) {
      const m = this.viewMap;
      const bx = m.r === 1 ? px - m.dx : Math.floor((px + 0.5 - m.dx) / m.r);
      const by = m.r === 1 ? y - m.dy : Math.floor((y + 0.5 - m.dy) / m.r);
      if (bx >= 0 && by >= 0 && bx < cs.W && by < cs.H) {
        id = cs.pick[by * cs.W + bx];
      } else {
        const c = this.liveCam;
        const ix = Math.floor((px + 0.5 - this.w / 2) / c.zoom + c.fx), iy = Math.floor((y + 0.5 - this.h / 2) / c.zoom + c.fy);
        if (ix >= 0 && iy >= 0 && ix < this.w && iy < this.h) id = this.idPick[iy * this.w + ix];
      }
    } else {
      id = this.idPick[y * this.w + px];
    }
    if (!id || id <= 0) return null;
    return { row: Math.floor((id - 1) / GRID_SIZE), col: (id - 1) % GRID_SIZE };
  }
  private resizeLayers(w: number, h: number): void {
    this.crust.width = w; this.crust.height = h;
    this.land.width = w; this.land.height = h;
    this.atmoScratch.width = w; this.atmoScratch.height = h;
    this.fluidScratch.width = w; this.fluidScratch.height = h;
    this.weatherScratch.width = w; this.weatherScratch.height = h;
    this.atmoG = this.atmoScratch.getContext('2d');
    this.weatherG = this.weatherScratch.getContext('2d');
    const fluidG = this.fluidScratch.getContext('2d');
    this.atmoImage = this.atmoG?.createImageData(w, h) ?? null;
    this.fluidImage = fluidG?.createImageData(w, h) ?? null;
    this.weatherImage = this.weatherG?.createImageData(w, h) ?? null;
  }
}

// ─── Convenience / smoke entry point ──────────────────────────────────────────

/**
 * Bake the static habitable layers into fresh canvases.
 *
 * `IsoDioramaRenderer` calls the individual paint functions so it can rebake the
 * surface on its own throttle without touching the crust. This wrapper exists
 * for the smoke check and for anything that just wants the finished layers.
 */
export function bakeHabitableCutaway(opts: CutawayBakeOpts): CutawayBakeResult {
  const make = (): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, opts.w);
    c.height = Math.max(1, opts.h);
    return c;
  };

  const surface = make();
  const crust = make();
  const sg = surface.getContext('2d');
  const cg = crust.getContext('2d');
  if (sg) paintCutawaySurface(sg, opts);
  if (cg) paintCutawayCrust(cg, opts);

  return {
    surface,
    crust,
  };
}
