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
import { classifyBiome, isWater, SEA_LEVEL, GRID_SIZE } from '../simulation/PlanetGrid';
import { genomeFromLegacy, type AtmosphereChannel } from '../simulation/PlanetGenome';
import {
  planSurfaceDecals, stampDecals, PAINTER_SNOW_ELEVATION, type DecalAtlas,
} from './SurfaceDecals';
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

export function habitableGeom(VW: number, VH: number): HabitableGeom {
  let R = Math.round(Math.min(VW * 0.50, VH * 0.36));
  const T = Math.max(ATMO_MIN_PX, Math.round(R * ATMO_RATIO));
  // If the shell would clip, shrink R — never shrink T below ATMO_MIN_PX.
  const maxR = Math.floor(Math.min(VW, VH) / 2 - T - 4);
  if (R > maxR) R = Math.max(16, maxR);
  const T2 = Math.max(ATMO_MIN_PX, Math.round(R * ATMO_RATIO));
  const cx = Math.round(VW / 2);
  const cyBody = Math.round(VH * 0.56);
  const rx = Math.max(8, Math.round(R * BOARD_WIDTH));
  const ry = Math.max(6, Math.round(rx * BOARD_SQUASH));
  const cyTop = Math.round(cyBody - CY_TOP_DROP * R);
  const wall = Math.max(4, Math.round(rx * WALL_RATIO));
  return { cx, cyBody, cyTop, R, rx, ry, wall, T: T2 };
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

  /** Inverse azimuthal projection: disc [-1,1]² → grid cell, null off-face. */
  discToGrid: (dx: number, dy: number) => { row: number; col: number } | null;
  /** Elevation penalty toward the rim, so land sits inside a ring of ocean. */
  rimFalloff: (r: number) => number;
  /** Screen-pixel lift for an elevation, already terraced. */
  liftOf: (elev: number) => number;
  /** Elevation averaged over a cell's neighbours, to avoid stipple cliffs. */
  smoothElevation: (grid: PlanetGrid, row: number, col: number) => number;
  /** Tallest lift `liftOf` can return, so the bake can reserve rows above the rim. */
  maxLift: number;

  /** How lush the biosphere is, 0–1. Greens up vegetated land. */
  lush?: number;
  /** `planet.genomeSeed`. Decals are stable across saves and re-bakes. */
  decalSeed?: number;
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

/**
 * Paint the cut face: an azimuthal projection of the grid as a flat living
 * board (diorama_test language) — tiered land with cliff faces. Water cells
 * leave the land canvas empty and stamp occupancy + pick for live fluids.
 * Gas giants fill the whole disc with latitude bands (no water holes).
 */
export function paintCutawaySurface(
  g: CanvasRenderingContext2D, opts: CutawayBakeOpts,
): void {
  const { w: VW, h: VH, cx, cyTop, rx, ry, seed, grid } = opts;
  const pal = paletteFor(opts.planetType);
  g.clearRect(0, 0, VW, VH);

  const x0 = Math.max(0, cx - rx), x1 = Math.min(VW - 1, cx + rx);
  const yFace0 = cyTop - ry, yFace1 = cyTop + ry;
  const y1 = Math.min(VH - 1, yFace1);
  if (x1 <= x0 || y1 <= yFace0) return;

  // Raised ground draws ABOVE the point it belongs to, so peaks near the far rim
  // need rows reserved above the ellipse.
  const yTop = Math.max(0, yFace0 - opts.maxLift);
  const bw = x1 - x0 + 1, bh = y1 - yTop + 1;
  const img = g.createImageData(bw, bh);
  const d = img.data;

  const pick = opts.pick && opts.pick.length === VW * VH ? opts.pick : null;
  if (pick) pick.fill(0);
  if (opts.occupancy && opts.occupancy.length === VW * VH) opts.occupancy.fill(0);

  const put = (
    px: number, py: number, cr: number, cg: number, cb: number, cellId: number,
  ): void => {
    if (py < yTop || py > y1 || px < x0 || px > x1) return;
    // Occupied water already stamped pick; cliffs must not overwrite it.
    if (opts.occupancy && py >= 0 && py < VH && px >= 0 && px < VW
        && opts.occupancy[py * VW + px]) return;
    const o = ((py - yTop) * bw + (px - x0)) * 4;
    d[o]     = cr < 0 ? 0 : cr > 255 ? 255 : cr;
    d[o + 1] = cg < 0 ? 0 : cg > 255 ? 255 : cg;
    d[o + 2] = cb < 0 ? 0 : cb > 255 ? 255 : cb;
    d[o + 3] = 255;
    if (pick && cellId > 0 && py >= 0 && py < VH && px >= 0 && px < VW) {
      pick[py * VW + px] = cellId;
    }
  };

  // ── Gas giant: flat banded tabletop, no water holes ─────────────────────────
  if (opts.planetType === 'gas') {
    const bands = (opts.gasBands && opts.gasBands.length > 0)
      ? opts.gasBands
      : makeGasBands(seed);
    const bandCount = bands.length;
    for (let py = yFace0; py <= y1; py++) {
      const dy = (py - cyTop) / ry;
      for (let px = x0; px <= x1; px++) {
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
        if (ft0 < 0.08) { cr *= 0.72; cg *= 0.72; cb *= 0.72; }

        const key = quantise(0.88 + 0.22 * clamp01(dx * KEY_X + dy * KEY_Y + 0.5), 0.065);
        const ao = 1 - Math.pow(clamp01((r - 0.70) / 0.30), 2) * 0.22;
        const f = key * ao;
        cr *= f; cg *= f; cb *= f;

        let cellId = 0;
        if (grid) {
          const gp = opts.discToGrid(dx, dy);
          if (gp) cellId = gp.row * GRID_SIZE + gp.col + 1;
        }
        put(px, py, cr, cg, cb, cellId);
      }
    }
    g.putImageData(img, x0, yTop);
    return;
  }

  const lush = clamp01(opts.lush ?? 0.3);
  // Cliff face under extruded land — same role as diorama_test's terrain.cliff.
  const cliff = pal.strata[1];

  // Painter's order: far rows first, so nearer ground occludes what is behind it.
  for (let py = yFace0; py <= y1; py++) {
    const dy = (py - cyTop) / ry;
    for (let px = x0; px <= x1; px++) {
      const dx = (px - cx) / rx;
      const r = Math.hypot(dx, dy);
      if (r > 1) continue;

      let cr = 0, cg = 0, cb = 0, lift = 0, cellId = 0;

      if (!grid) {
        // No grid yet: treat the disc as water so fluids can fill it in frame().
        const idx = py * VW + px;
        if (opts.occupancy && idx >= 0 && idx < opts.occupancy.length) opts.occupancy[idx] = 1;
        continue;
      } else {
        const gp = opts.discToGrid(dx, dy);
        if (!gp) continue;
        const cell = grid[gp.row]?.[gp.col];
        if (!cell) continue;

        const elev = cell.elevation - opts.rimFalloff(r);
        let biome: BiomeType =
          classifyBiome(elev, cell.moisture, cell.temperature, opts.planetType);

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
          const idx = py * VW + px;
          if (opts.occupancy && idx >= 0 && idx < opts.occupancy.length) opts.occupancy[idx] = 1;
          if (pick) pick[idx] = gp.row * GRID_SIZE + gp.col + 1;
          continue; // do not call put()
        }

        let base = pal.biome[biome];
        let br = base.r, bg = base.g, bb = base.b;

        if (biome !== 'mountain' && biome !== 'snow' && biome !== 'tundra'
                   && biome !== 'volcanic' && biome !== 'beach') {
          // Vegetation responds to the living biosphere, gated on the cell's own
          // fertility so deserts and savanna still read as themselves.
          const veg = clamp01(cell.lifeDensity * 0.45 + lush * 0.30)
                    * clamp01(cell.fertility * 1.6) * 0.55;
          br = mix(br, br * 0.74, veg);
          bg = mix(bg, Math.min(255, bg * 1.12 + 8), veg);
          bb = mix(bb, bb * 0.76, veg);
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
        const grain = 0.975 + hash1(px * 911 + py * 31, seed) * 0.05;

        const f = relief * key * ao * grain;
        cr = br * f; cg = bg * f; cb = bb * f;

        // Foam ring at the rim, hard-edged: two steps, not a fade.
        if (r > 0.972) {
          const t = r > 0.988 ? 0.85 : 0.42;
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
        if (elev > SEA_LEVEL - 0.009 && elev < SEA_LEVEL + 0.014) {
          cr = mix(cr, pal.foam.r, 0.55);
          cg = mix(cg, pal.foam.g, 0.55);
          cb = mix(cb, pal.foam.b, 0.55);
        }

        lift = opts.liftOf(opts.smoothElevation(grid, gp.row, gp.col) - opts.rimFalloff(r));
        cellId = gp.row * GRID_SIZE + gp.col + 1;
      }

      const top = py - lift;
      if (lift > 0) {
        // Solid cliff column under the crest (diorama_test language) — not a
        // silt fade, so height reads as real ground you can put life on.
        for (let k = 1; k <= lift; k++) {
          const shadeK = 0.78 + 0.14 * (k / lift);
          put(px, top + k,
              cliff.r * shadeK,
              cliff.g * shadeK,
              cliff.b * shadeK,
              cellId);
        }
        // Lit top plate — sunward side pops like the test.
        const sun = dx > 0.05 ? 1.12 : 1.0;
        put(px, top,
            Math.min(255, cr * sun + 8),
            Math.min(255, cg * sun + 8),
            Math.min(255, cb * sun + 8),
            cellId);
      } else {
        put(px, top, cr, cg, cb, cellId);
      }
    }
  }

  // Land cliffs can extrude onto a farther water cell's pixel. Punch those
  // back to alpha 0 so occupancy water stays empty for live fluids.
  if (opts.occupancy) {
    for (let py = yTop; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const idx = py * VW + px;
        if (idx < 0 || idx >= opts.occupancy.length || !opts.occupancy[idx]) continue;
        d[((py - yTop) * bw + (px - x0)) * 4 + 3] = 0;
      }
    }
  }

  // Decals last: they must stand on finished terrain, and the cliff-punch above
  // has already cleared water pixels back to alpha 0 so nothing lands in the sea.
  if (opts.decalSeed !== undefined) {
    const sites = planSurfaceDecals(opts, clamp01(opts.lush ?? 0.3), opts.decalSeed);
    stampDecals(d, bw, bh, x0, yTop, sites, opts.decalAtlas ?? null);
  }

  g.putImageData(img, x0, yTop);

  if (opts.planetType === 'lava') {
    paintVolcanoChimneys(g, planVolcanoChimneys(opts));
  }
}

export interface VolcanoChimney {
  x: number;
  y: number;
  /** Cone height in virtual pixels. */
  h: number;
  /** Base half-width. */
  w: number;
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
      sites.push({ x: px, y: py - lift, h, w });
      if (sites.length >= 10) return sites;
    }
  }
  return sites;
}

/** Dark basalt cone + glowing crater mouth on the lava tabletop. */
export function paintVolcanoChimneys(
  g: CanvasRenderingContext2D, sites: VolcanoChimney[],
): void {
  for (const v of sites) {
    const baseY = v.y;
    const tipY = v.y - v.h;
    // Cone body — dark basalt tapering upward.
    for (let k = 0; k <= v.h; k++) {
      const t = k / Math.max(1, v.h);
      const half = Math.max(1, Math.round(v.w * (1 - t * 0.85)));
      const y = baseY - k;
      g.fillStyle = `rgb(${28 + Math.round(t * 18)},${12 + Math.round(t * 8)},${10 + Math.round(t * 6)})`;
      g.fillRect(v.x - half, y, half * 2 + 1, 1);
      // Lit right flank.
      g.fillStyle = `rgba(90,40,25,${0.35 + t * 0.25})`;
      g.fillRect(v.x + half - 1, y, 1, 1);
    }
    // Crater rim + magma throat.
    g.fillStyle = 'rgb(22,10,8)';
    g.fillRect(v.x - 2, tipY - 1, 5, 2);
    g.fillStyle = 'rgb(255,140,40)';
    g.fillRect(v.x - 1, tipY - 2, 3, 2);
    g.fillStyle = 'rgb(255,220,120)';
    g.fillRect(v.x, tipY - 3, 1, 2);
    // Thin ash plume stub (static — live embers are host overlays).
    g.fillStyle = 'rgba(90,80,75,0.55)';
    g.fillRect(v.x, tipY - 6, 1, 3);
    g.fillStyle = 'rgba(70,65,60,0.35)';
    g.fillRect(v.x + 1, tipY - 8, 1, 2);
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
  const { w: VW, h: VH, cx, cyTop, rx, ry, seed } = opts;
  const fallback = habitableGeom(VW, VH);
  const wall = opts.wall ?? fallback.wall;
  const pal = paletteFor(opts.planetType);
  g.clearRect(0, 0, VW, VH);
  if (rx < 8) return;

  const rimX0 = Math.max(0, Math.ceil(cx - rx));
  const rimX1 = Math.min(VW - 1, Math.floor(cx + rx));
  const cols = rimX1 - rimX0 + 1;
  const wallBottom = new Float32Array(cols);
  const crustH = Math.max(8, Math.round(rx * 0.88));

  // ── Sheer front wall ──────────────────────────────────────────────────────
  for (let x = rimX0; x <= rimX1; x++) {
    const i = x - rimX0;
    const faceX = (x - cx) / rx;
    const frontY = cyTop + Math.sqrt(Math.max(0, 1 - faceX * faceX)) * ry;
    const ridge = (fbm1(x * 0.075, seed + 77, 3) - 0.5) * 5;
    const bottomY = frontY + wall + ridge;
    const waterBand = Math.max(6, Math.round(wall * 0.40));
    wallBottom[i] = bottomY;
    const rimY = Math.max(0, Math.min(VH - 1, Math.floor(frontY)));
    const hasOccupancy = opts.occupancy && opts.occupancy.length === VW * VH;
    const water = !hasOccupancy || opts.occupancy![rimY * VW + x] !== 0;

    for (let y = Math.ceil(frontY); y <= Math.floor(bottomY); y++) {
      if (y < 0 || y >= VH) continue;
      const faceY = (y - cyTop) / ry;
      if (faceX * faceX + faceY * faceY <= 1) continue;
      const depth = y - frontY;
      const light = quantise(0.70 + 0.30 * clamp01(faceX * KEY_X + 0.42), 0.08);
      const fluidLayer = depth < waterBand || water;
      if (fluidLayer) {
        const t = clamp01(depth / Math.max(1, water ? (bottomY - frontY) : waterBand));
        const facet = x % 14 === 0 ? 0.20 : 0;
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
  }

  // ── Jagged hanging keel ───────────────────────────────────────────────────
  const raw = new Float32Array(cols);
  for (let i = 0; i < cols; i++) {
    const x = rimX0 + i;
    const dxn = (x - cx) / rx;
    // Flatter than a circle on purpose — a (1−x²)^0.78 bowl hugged the
    // atmospheric shell and the underside read as a sphere again.
    const keel = Math.pow(Math.max(0, 1 - dxn * dxn), 1.35);
    const jag  = fbm1((x - cx) * 0.038, seed, 4) * 0.70
               + fbm1((x - cx) * 0.14, seed + 77, 3) * 0.38
               + fbm1((x - cx) * 0.48,  seed + 401, 2) * 0.22;
    const spur = Math.sin(fbm1((x - cx) * 0.048, seed + 1234, 2) * Math.PI * 2.8) * 0.28;
    const cleft = hash1(i * 17, seed + 5) > 0.82 ? -0.22 : 0;
    raw[i] = Math.min(
      crustH,
      crustH * Math.max(0, 0.06 + keel * 0.52 + (jag - 0.5) * 0.78 + spur + cleft),
    );
  }

  const prof = new Float32Array(cols);
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? raw : prof.slice();
    for (let i = 0; i < cols; i++) {
      const a = src[Math.max(0, i - 1)], b = src[i], c = src[Math.min(cols - 1, i + 1)];
      prof[i] = (a + b * 2 + c) / 4;
    }
  }
  for (let i = 0; i < cols; i++) {
    const ledge = 2 + Math.round(fbm1(i * 0.035, seed + 909, 2) * 3);
    prof[i] = Math.round(prof[i] / ledge) * ledge;
  }
  const terr = prof.slice();
  for (let i = 1; i < cols - 1; i++) {
    const a = terr[i - 1], b = terr[i], c = terr[i + 1];
    prof[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }

  const bands = pal.strata.length;
  const strataSpan = ry + wall + crustH;
  for (let i = 0; i < cols; i++) {
    const x = rimX0 + i;
    const depth = prof[i];
    if (depth < 2) continue;
    const top = wallBottom[i];
    const dxn = (x - cx) / rx;
    const lit = 0.55 + 0.62 * clamp01(dxn * 0.9 + 0.45);

    for (let y = 0; y < depth; y++) {
      const absY = top + y;
      if (absY < 0 || absY >= VH) continue;
      const faceX = dxn;
      const faceY = (absY - cyTop) / ry;
      if (faceX * faceX + faceY * faceY <= 1) continue;

      const t = y / depth;
      const wave = (fbm1(x * 0.022, seed + 311, 3) - 0.5) * 0.55
                 + (fbm1(x * 0.075, seed + 733, 2) - 0.5) * 0.22;
      const bandPos = clamp01((absY - cyTop) / strataSpan) * bands + wave;
      const bi = Math.max(0, Math.min(bands - 1, Math.floor(bandPos)));
      const ao = 1 - t * 0.26 - (y < 3 ? (3 - y) / 3 : 0) * 0.28;
      const grain = 0.90 + hash1(x * 733 + y * 13, seed) * 0.20;
      const streak = 0.94 + fbm1(x * 0.09 + y * 1.7, seed + 55, 2) * 0.14;
      let f = lit * ao * grain * streak;
      const frac = bandPos - Math.floor(bandPos);
      if (frac < 0.07) f *= 0.68;
      else if (frac < 0.16) f *= 1.12;
      const ember = t > 0.78 && hash1(x * 179 + y * 991, seed + 19) > 0.986;
      g.fillStyle = css(ember ? pal.emberHot : shade(pal.strata[bi], f));
      g.fillRect(x, Math.round(absY), 1, 1);
    }

    if (dxn > 0.1) {
      g.fillStyle = css(pal.ember, clamp01((dxn - 0.1) / 0.9) * 0.25);
      g.fillRect(x, Math.round(top + depth) - 2, 1, 2);
    }
    g.fillStyle = 'rgba(2,2,6,0.55)';
    g.fillRect(x, Math.round(top + depth) - 1, 1, 1);
  }
}

// ─── Atmosphere shell ─────────────────────────────────────────────────────────

/**
 * How much atmosphere to show at a given camera zoom.
 * Full haze at 1×, gone by ~2.5× so a close look is just terrain.
 */
export function atmoHazeAmount(viewZoom = 1): number {
  const t = Math.max(0, Math.min(1, (viewZoom - 1) / 1.5));
  return (1 - t) * (1 - t);
}

/**
 * Face² limit for a circle of radius `rx`. Wisps stay inside this so they
 * cannot drift into the feathered limb.
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
  const sunX = Math.cos(sunAzimuth);
  const fade = chan.thicknessPx;
  // A constant-thickness ring reads as a geometric annulus — an outline rather
  // than a volume. Perturb it slowly around the limb; see WOBBLE_AMP.
  // Angular wobble without transcendentals in the inner loop. (dx/d, dy/d) is
  // (cos t, sin t) already, so harmonics come from multiple-angle identities and
  // the phase terms are loop-invariant. atan2 + 2x sin per pixel over ~280k
  // pixels was a 2.66x per-frame regression.
  const wobbleSeed = (chan.hue * 7.13 + chan.thicknessPx * 31.7);
  const p1c = Math.cos(wobbleSeed),       p1s = Math.sin(wobbleSeed);
  const p2c = Math.cos(wobbleSeed * 1.7), p2s = Math.sin(wobbleSeed * 1.7);
  const fadeMax = fade * 1.6 + 2;
  const aerialReach = rx * 0.35;
  const y0 = Math.max(0, Math.floor(cy - rx - fadeMax));
  const y1 = Math.min(h - 1, Math.ceil(cy + ry));
  const x0 = Math.max(0, Math.floor(cx - rx - fadeMax));
  const x1 = Math.min(w - 1, Math.ceil(cx + rx + fadeMax));
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
      const localFade = Math.max(3, fade * (1 + n * WOBBLE_AMP));
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
      const lit = 0.55 + 0.45 * Math.max(0, Math.min(1, 0.5 + hit.dx * sunX));
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
        ? 1 + (edge * (taper + (1 - taper) * edge) - 1) * Math.min(1, (y - cy) / 6)
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
 * Night veil on the pancake. `sunAzimuth` 0 lights the +x side; π flips it.
 */
export function paintDayNight(
  img: ImageData, geom: HabitableGeom, sunAzimuth: number, layerBob: number,
): void {
  const { cx, rx, ry } = geom;
  const cy = geom.cyTop + layerBob;
  const sunX = Math.cos(sunAzimuth);
  const d = img.data;
  const w = img.width, h = img.height;
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(h - 1, Math.ceil(cy + ry));
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(w - 1, Math.ceil(cx + rx));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = (px - cx) / rx;
      const dy = (py - cy) / ry;
      if (dx * dx + dy * dy > 1) continue;
      const day = clamp01(0.38 + dx * sunX * 0.90);
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
 */
export function bakeShoreDistance(
  occupancy: Uint8Array, geom: HabitableGeom, w: number, h: number,
): Float32Array {
  const dist = new Float32Array(w * h);
  const seen = new Uint8Array(w * h);
  const q = new Int32Array(w * h);
  let head = 0, tail = 0;
  const { cx, cyTop, rx, ry } = geom;
  for (let y = 0; y < h; y++) {
    const dy = (y - cyTop) / ry;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (occupancy[i] !== 0) continue;
      const dx = (x - cx) / rx;
      if (dx * dx + dy * dy > 1) continue;
      seen[i] = 1;
      q[tail++] = i;
    }
  }
  while (head < tail) {
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
  const tmp = new Float32Array(dist);
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? dist : tmp;
    const dst = pass === 0 ? tmp : dist;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (occupancy[i] !== 1) continue;
        dst[i] = (
          src[i] * 2
          + src[i - 1] + src[i + 1] + src[i - w] + src[i + w]
        ) / 6;
      }
    }
  }
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
const SWELL_DISP_PX = 1.4;   // open-water texture displacement along the landward normal
const SWELL_DISP_SHORE_PX = 2.8; // same, right at the coast (waves steepen as they shoal)
const SWELL_BRIGHT_OPEN = 0.018;  // web-threshold swing per crest in open water
const SWELL_BRIGHT_SHORE = 0.12;  // same at the coast
const FOAM_REACH = 5.0;      // px of shore distance that gets the crash/foam band
/** Beyond this shore distance, caustics fade toward a calm mid-blue body. */
const CAUSTIC_FADE = 14;
const WEB_GLINT = 0.028;     // √F2−√F1 below this → glint (thin line)
const WEB_HALO = 0.055;      // base halo width; kept narrow so open water isn't busy

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
 */
export function paintFluids(
  img: ImageData, geom: HabitableGeom, occupancy: Uint8Array,
  planetType: HabitableType, elapsed: number, layerBob: number,
  shoreDist?: Float32Array | null,
): void {
  const { cx, rx, ry } = geom;
  const cy = geom.cyTop + layerBob;
  const t = elapsed;
  const pal = cutawayWaterSurf(planetType);
  const d = img.data;
  const w = img.width, h = img.height;
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(h - 1, Math.ceil(cy + ry));
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(w - 1, Math.ceil(cx + rx));
  const hasShore = !!(shoreDist && shoreDist.length === w * h);
  // Magma churns hotter/faster; ice melt is sluggish; desert oases barely breathe.
  const speed =
    planetType === 'lava' ? 2.35
    : planetType === 'ice' ? 0.55
    : planetType === 'desert' ? 0.35
    : 1.0;
  const useCaustic = planetType !== 'lava';
  // Larger cells ⇒ sparser web (was ~0.078; smaller scale = bigger cells).
  const cellScale = planetType === 'ice' ? 0.042 : planetType === 'desert' ? 0.055 : 0.048;
  const seed = 0xca07 + (planetType.length * 97);
  const omega = SWELL_W * speed;
  // Slow bounded wobble of the web itself (refracted light shimmer). The warp
  // fields orbit a fixed point instead of sliding, so nothing drifts globally:
  // the only directed motion is the shore-bound swell below.
  const wobT = t * 0.22 * speed;
  const wobX = Math.sin(wobT) * 0.7, wobY = Math.cos(wobT * 0.77) * 0.7;
  const wob2X = Math.cos(wobT * 0.61 + 1.3) * 0.5, wob2Y = Math.sin(wobT * 0.89) * 0.5;
  const blobY = Math.sin(wobT * 0.5) * 0.9;
  const invRx = 1 / rx, invRy = 1 / ry;

  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const idx = py * w + px;
      const sourceY = py - layerBob;
      if (sourceY < 0 || sourceY >= h || occupancy[sourceY * w + px] !== 1) continue;
      const dx = (px - cx) / rx;
      const dy = (py - cy) / ry;
      const r2 = dx * dx + dy * dy;
      if (r2 > 1) continue;
      const src = sourceY * w + px;
      const shore = hasShore ? shoreDist![src] : 0;

      let c = pal.mid;
      if (useCaustic) {
        // Landward unit normal = −∇shoreDist. Neighbours outside the pancake
        // carry no distance, so they fall back to our own value (one-sided
        // difference) instead of dragging the normal toward the rim.
        let nx = 0, ny = 0, toward = shore;
        if (shore > 0) {
          const sdy = (sourceY - geom.cyTop) * invRy;
          const sE = px + 1 < w && (occupancy[src + 1] === 1 || (px + 1 - cx) * invRx * ((px + 1 - cx) * invRx) + sdy * sdy <= 1)
            ? shoreDist![src + 1] : shore;
          const sW = px - 1 >= 0 && (occupancy[src - 1] === 1 || (px - 1 - cx) * invRx * ((px - 1 - cx) * invRx) + sdy * sdy <= 1)
            ? shoreDist![src - 1] : shore;
          const sdyS = (sourceY + 1 - geom.cyTop) * invRy;
          const sdyN = (sourceY - 1 - geom.cyTop) * invRy;
          const sS = sourceY + 1 < h && (occupancy[src + w] === 1 || dx * dx + sdyS * sdyS <= 1)
            ? shoreDist![src + w] : shore;
          const sN = sourceY - 1 >= 0 && (occupancy[src - w] === 1 || dx * dx + sdyN * sdyN <= 1)
            ? shoreDist![src - w] : shore;
          const gx = sE - sW, gy = sS - sN;
          const gl = Math.sqrt(gx * gx + gy * gy);
          if (gl > 1e-4) { nx = -gx / gl; ny = -gy / gl; }
        }
        if (nx === 0 && ny === 0) {
          // No coast information (or on the equidistant ridge between two
          // coasts): run the swell toward the pancake centre instead.
          const rl = Math.sqrt(r2) || 1;
          nx = -dx / rl; ny = -dy / rl;
          if (shore <= 0) toward = rl * rx;
        }

        // How loud the caustic is: 1 at the beach, ~0 in open water.
        const detail = hasShore && shore > 0
          ? clamp01(1 - Math.max(0, shore - FOAM_REACH * 0.35) / CAUSTIC_FADE)
          : 0.35;
        const detail2 = detail * detail;

        // Travelling swell: constant phase moves to SMALLER shore distance.
        const ph = toward * SWELL_K + t * omega;
        const sw = Math.sin(ph);
        const nearShore = hasShore && shore > 0 ? clamp01(1 - shore / FOAM_REACH) : 0;
        const shoal = nearShore * nearShore;
        const dispPx = (SWELL_DISP_PX + (SWELL_DISP_SHORE_PX - SWELL_DISP_PX) * shoal) * (0.45 + 0.55 * detail);
        const disp = Math.cos(ph) * dispPx * cellScale;

        // Web domain: pixel → cell space, pushed along the landward normal by
        // the passing crest, then softly warped so walls curve like refracted light.
        const bx = px * cellScale + nx * disp;
        const by = py * cellScale + ny * disp;
        const warp = noise2(bx * 0.45 + wobX, by * 0.45 + wobY, seed + 3);
        const qx = bx + (warp - 0.5) * 1.5;
        const qy = by + (warp - 0.5) * 1.5;
        // Same cell lattice sampled through a second, differently-warped lens:
        // the two walls coincide in most places and braid apart elsewhere.
        const warp2 = noise2(bx * 0.9 + wob2X + 7.7, by * 0.9 + wob2Y, seed + 5);
        const b1 = cellRidge(qx, qy, seed);
        const b2 = cellRidge(qx + (warp2 - 0.5) * 0.8, qy + (0.5 - warp2) * 0.55, seed) + 0.02;
        let b = b1 < b2 ? b1 : b2;
        const grain = noise2(px * 0.23, py * 0.23, seed + 11);
        b += (grain - 0.5) * 0.035;
        const swell = sw * (SWELL_BRIGHT_OPEN + (SWELL_BRIGHT_SHORE - SWELL_BRIGHT_OPEN) * shoal);
        // Narrow halo; open water barely gets the pale patch treatment.
        const blob = noise2(px * 0.07 + 3.1, py * 0.07 + blobY, seed + 23);
        const halo = (WEB_HALO + Math.max(0, blob - 0.72) * 0.22 + swell * 0.9)
                   * (0.35 + 0.65 * detail);

        // Stricter glint in open water so the web thins out away from land.
        const glintCut = WEB_GLINT + swell * 0.25 + (1 - detail) * 0.045;
        if (b < glintCut && detail2 > 0.12) c = pal.glint;
        else if (b < halo && detail > 0.25) c = pal.light;
        else {
          // Depth ramp: shelf stays mid-blue; far from land → deep navy.
          const depth = hasShore && shore > 0
            ? clamp01((shore - 2.5) / 16)
            : clamp01(Math.sqrt(r2) * 1.15);
          if (depth > 0.72) c = pal.deep;
          else if (depth > 0.38) c = (grain * 0.55 + depth) > 0.72 ? pal.deep : pal.mid;
          else c = pal.mid;

          // Whisper web on deep water: rare pale crests only (never bright glint).
          // Keeps the navy readable while still showing faint wave lines.
          if (depth > 0.35 && b < WEB_GLINT + 0.012 + swell * 0.15) {
            c = pal.light;
          }
        }

        // Shore crash: the crest piles up on the coast as a dithered foam band.
        if (nearShore > 0) {
          const foam = sw * (0.35 + nearShore * 0.85) + nearShore * 1.05 - 0.9 + (grain - 0.5) * 0.55;
          if (foam > 0.28) c = pal.glint;
          else if (foam > -0.05 && c !== pal.glint) c = pal.light;
        }
      } else {
        // Magma: keep travelling swell + hot glint.
        const toward = shore > 0 ? shore : Math.sqrt(r2) * rx;
        const drift = Math.sin(px * 0.055 - py * 0.04) * 2.4;
        const wave = Math.sin((toward + drift) * 0.22 + t * 1.15 * speed)
                   + Math.cos((toward + drift) * 0.09 + t * 0.42 * speed) * 0.35;
        if (wave > 0.48) c = pal.glint;
        else if (wave > 0.22) c = pal.light;
        else if (wave < -0.55) c = pal.deep;
      }

      let cr = c.r, cg = c.g, cb = c.b;
      if (r2 > 0.94) {
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
}

// ─── Wispy clouds ─────────────────────────────────────────────────────────────

/**
 * A thin, stretched cloud streak for the habitable shell.
 *
 * `makeCloudSprite` in the legacy renderer builds a puffy cumulus blob, which
 * is right for a sky seen from inside a dome and wrong for a planet seen from
 * space: from out here, cloud reads as long, flat, torn bands. Same tint inputs
 * so a storm, an ash plume or smog still arrives visibly different.
 */
export function makeWispSprite(
  w: number, h: number, seed: number, body: RGB, under: RGB,
): HTMLCanvasElement {
  w = Math.max(8, Math.round(w));
  h = Math.max(3, Math.round(h));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (!g) return c;
  const s = new Stream(seed);

  // Overlapping lenses along the streak, each much wider than tall. Their
  // heights VARY a lot on purpose: equal-height lobes packed edge to edge fill
  // the canvas and the streak draws as a solid grey bar, which at this scale
  // looks like a rendering fault rather than weather.
  const lobes = 4 + Math.floor(s.next() * 4);
  for (let i = 0; i < lobes; i++) {
    const t = (i + s.range(0.15, 0.85)) / lobes;
    const px = w * t;
    // Thickest in the middle of the streak, tapering to nothing at the ends.
    const taper = Math.sin(Math.PI * clamp01(t));
    const lw = w * s.range(0.10, 0.24);
    const lh = Math.max(0.6, h * 0.5 * s.range(0.35, 1.0) * taper);
    const py = h * 0.5 + (s.next() - 0.5) * (h * 0.5 - lh) * 0.8;
    g.fillStyle = css(body, s.range(0.45, 0.85) * taper);
    g.beginPath();
    g.ellipse(px, py, lw, lh, 0, 0, Math.PI * 2);
    g.fill();
  }

  // Shaded underside, clipped to what was drawn — turns the streak from a smear
  // into something with a top and a bottom.
  g.globalCompositeOperation = 'source-atop';
  const grad = g.createLinearGradient(0, h * 0.45, 0, h);
  grad.addColorStop(0, css(under, 0));
  grad.addColorStop(1, css(under, 0.50));
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  // Fade both ends, so a streak drifts in and out of view instead of ending on
  // a vertical edge.
  g.globalCompositeOperation = 'destination-out';
  const ends = g.createLinearGradient(0, 0, w, 0);
  ends.addColorStop(0, 'rgba(0,0,0,0.95)');
  ends.addColorStop(0.22, 'rgba(0,0,0,0)');
  ends.addColorStop(0.78, 'rgba(0,0,0,0)');
  ends.addColorStop(1, 'rgba(0,0,0,0.95)');
  g.fillStyle = ends;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'source-over';

  return c;
}

export interface HabitableFrameInput {
  g: CanvasRenderingContext2D;
  dt: number;
  elapsed: number;
  bg: HTMLCanvasElement;
  drawFarSpace: (g: CanvasRenderingContext2D) => void;
  drawOverlays: (g: CanvasRenderingContext2D) => void;
  drawNearMoons: (g: CanvasRenderingContext2D) => void;
  weatherMix: Array<{ kind: string; weight: number }>;
  /** Local day angle in radians; 0 lights the +x limb. */
  sunAzimuth?: number;
  /** CSS camera zoom; atmosphere dissolves as this rises. */
  viewZoom?: number;
}

interface Wisp {
  x: number;
  y: number;
  speed: number;
  alpha: number;
  sprite: HTMLCanvasElement;
}

const WISP_COLOURS: Record<string, { body: RGB; under: RGB }> = {
  cumulus: { body: rgb(244, 250, 255), under: rgb(142, 174, 204) },
  storm: { body: rgb(132, 150, 178), under: rgb(55, 66, 88) },
  ash: { body: rgb(168, 150, 140), under: rgb(78, 62, 58) },
  smog: { body: rgb(174, 156, 118), under: rgb(90, 76, 54) },
  pollution: { body: rgb(174, 156, 118), under: rgb(90, 76, 54) },
  acid: { body: rgb(190, 210, 80), under: rgb(90, 110, 40) },
  nebula: { body: rgb(180, 140, 220), under: rgb(90, 50, 140) },
  ice_haze: { body: rgb(225, 244, 255), under: rgb(138, 180, 208) },
};

/**
 * Owns static layers and composites moving habitable-world effects.
 * `drawGeom` includes bob for host-owned overlay placement.
 */
export class HabitableCutawayEngine {
  geom: HabitableGeom = habitableGeom(1, 1);
  occupancy = new Uint8Array(1);
  shoreDist = new Float32Array(1);
  pick = new Int32Array(1);

  private crust = document.createElement('canvas');
  private land = document.createElement('canvas');
  private atmoScratch = document.createElement('canvas');
  private fluidScratch = document.createElement('canvas');
  private wispScratch = document.createElement('canvas');
  private airMask = document.createElement('canvas');
  private atmoG: CanvasRenderingContext2D | null = null;
  private wispG: CanvasRenderingContext2D | null = null;
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
  private wisps: Wisp[] = [];
  private lastWispSig = '';

  constructor() {
    this.resizeLayers(1, 1);
  }

  get bob(): number {
    return bobOf(this.elapsed, this.geom.R);
  }

  get drawGeom(): HabitableGeom & { bob: number } {
    return { ...this.geom, bob: this.bob };
  }

  bake(opts: Omit<CutawayBakeOpts, 'cx' | 'cyTop' | 'rx' | 'ry'> & {
    w: number; h: number; weatherMix?: Array<{ kind: string; weight: number }>;
  }): void {
    this.w = Math.max(1, Math.round(opts.w));
    this.h = Math.max(1, Math.round(opts.h));
    this.geom = habitableGeom(this.w, this.h);
    this.planetType = opts.planetType;
    this.seed = opts.seed;
    this.elapsed = 0;
    this.occupancy = new Uint8Array(this.w * this.h);
    this.shoreDist = new Float32Array(this.w * this.h);
    this.pick = new Int32Array(this.w * this.h);
    this.wisps = [];
    this.lastWispSig = '\0';
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
      occupancy: this.occupancy, pick: this.pick,
      gasBands: this.gasBands.length ? this.gasBands : null,
    };
    this.surfaceBakeOpts = bakeOpts;
    const crustG = this.crust.getContext('2d');
    const landG = this.land.getContext('2d');
    if (crustG) paintCutawayCrust(crustG, bakeOpts);
    if (landG) paintCutawaySurface(landG, bakeOpts);
    this.shoreDist = bakeShoreDistance(this.occupancy, this.geom, this.w, this.h);
    this.rebuildWisps(opts.weatherMix ?? []);
  }

  /** Repaint the mutable top-face data without resetting animation or crust. */
  rebakeSurface(): void {
    const landG = this.land.getContext('2d');
    if (landG && this.surfaceBakeOpts) paintCutawaySurface(landG, this.surfaceBakeOpts);
    this.shoreDist = bakeShoreDistance(this.occupancy, this.geom, this.w, this.h);
  }

  /**
   * Merge live values into the stored bake options.
   *
   * `rebakeSurface` repaints from `surfaceBakeOpts`, a snapshot taken at the
   * last full `bake()`. Anything that changes between full bakes — lushness as
   * the biosphere advances, the decal atlas once it finishes loading — has to
   * be merged in here first, or the repaint faithfully reproduces the old
   * world and nothing the player did appears to matter.
   */
  updateSurfaceOpts(patch: Partial<CutawayBakeOpts>): void {
    if (!this.surfaceBakeOpts) return;
    this.surfaceBakeOpts = { ...this.surfaceBakeOpts, ...patch };
  }

  frame(input: HabitableFrameInput): void {
    const { g, elapsed } = input;
    this.elapsed = elapsed;
    this.rebuildWisps(input.weatherMix);
    const bob = this.bob;
    const layerBob = Math.round(bob);

    g.drawImage(input.bg, 0, 0);
    input.drawFarSpace(g);
    const sunAzimuth = input.sunAzimuth ?? 0;
    if (this.planetType === 'gas') this.drawGasRings(g, true, bob);
    g.drawImage(this.crust, 0, layerBob);
    g.drawImage(this.land, 0, layerBob);
    const fluids = this.fluidImage;
    if (fluids) {
      fluids.data.fill(0);
      paintFluids(fluids, this.geom, this.occupancy, this.planetType, elapsed, layerBob, this.shoreDist);
      const fluidG = this.fluidScratch.getContext('2d');
      if (fluidG) {
        fluidG.putImageData(fluids, 0, 0);
        g.drawImage(this.fluidScratch, 0, 0);
        fluids.data.fill(0);
        paintDayNight(fluids, this.geom, sunAzimuth, layerBob);
        fluidG.putImageData(fluids, 0, 0);
        g.drawImage(this.fluidScratch, 0, 0);
      }
    }
    input.drawOverlays(g);
    const haze = atmoHazeAmount(input.viewZoom ?? 1);
    const atmo = this.atmoImage;
    const atmoG = this.atmoG;
    if (atmo && atmoG && haze > 0.01) {
      // putImageData-only on this canvas — mixing drawImage here forces a
      // software rasterizer and the preview drops to ~1 fps.
      atmo.data.fill(0);
      const gasTint = this.planetType === 'gas' && this.gasBands.length
        ? averageBands(this.gasBands)
        : undefined;
      paintAtmosphere(atmo, this.geom, this.planetType, bob, sunAzimuth, haze, gasTint);
      atmoG.putImageData(atmo, 0, 0);
      g.drawImage(this.atmoScratch, 0, 0);
    }
    const wispG = this.wispG;
    if (wispG && haze > 0.01 && this.wisps.length > 0) {
      wispG.clearRect(0, 0, this.w, this.h);
      this.drawWisps(wispG, elapsed, bob, sunAzimuth, haze);
      wispG.globalCompositeOperation = 'destination-in';
      wispG.drawImage(this.airMask, 0, 0);
      wispG.globalCompositeOperation = 'source-over';
      g.drawImage(this.wispScratch, 0, 0);
    }
    if (this.planetType === 'gas') this.drawGasRings(g, false, bob);
    input.drawNearMoons(g);

    const vig = g.createRadialGradient(
      this.geom.cx, this.geom.cyBody + bob, this.geom.rx * 0.7,
      this.geom.cx, this.geom.cyBody + bob, Math.max(this.w, this.h) * 0.75,
    );
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = vig;
    g.fillRect(0, 0, this.w, this.h);
  }

  /**
   * Saturn-style rings around the pancake: back half behind the body, front
   * half after atmosphere (same ellipse-clip logic as legacy bakeGasGiant).
   */
  private drawGasRings(g: CanvasRenderingContext2D, back: boolean, bob: number): void {
    if (!this.hasRing || this.gasBands.length === 0) return;
    const { cx, rx } = this.geom;
    const cy = this.geom.cyTop + bob;
    const VW = this.w, VH = this.h;
    const ringInner = rx * 1.28, ringOuter = rx * 1.92, ringRy = 0.20;
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
      g.strokeStyle = css(shade(c, 1.25), a);
      g.lineWidth = 1;
      g.beginPath();
      g.ellipse(cx, cy, rr, rr * ringRy, -0.12, 0, Math.PI * 2);
      g.stroke();
    }
    g.restore();
  }

  hitTest(px: number, py: number): { row: number; col: number } | null {
    const y = py - Math.round(this.bob);
    if (px < 0 || px >= this.w || y < 0 || y >= this.h) return null;
    const id = this.pick[y * this.w + px];
    if (!id || id <= 0) return null;
    return { row: Math.floor((id - 1) / GRID_SIZE), col: (id - 1) % GRID_SIZE };
  }

  private resizeLayers(w: number, h: number): void {
    this.crust.width = w; this.crust.height = h;
    this.land.width = w; this.land.height = h;
    this.atmoScratch.width = w; this.atmoScratch.height = h;
    this.fluidScratch.width = w; this.fluidScratch.height = h;
    this.wispScratch.width = w; this.wispScratch.height = h;
    this.airMask.width = w; this.airMask.height = h;
    this.atmoG = this.atmoScratch.getContext('2d');
    this.wispG = this.wispScratch.getContext('2d');
    const fluidG = this.fluidScratch.getContext('2d');
    this.atmoImage = this.atmoG?.createImageData(w, h) ?? null;
    this.fluidImage = fluidG?.createImageData(w, h) ?? null;
    this.bakeAirMask();
  }

  /** Hard pixel half-dome used to stamp wisps without a GPU readback. */
  private bakeAirMask(): void {
    const g = this.airMask.getContext('2d');
    if (!g) return;
    const img = g.createImageData(this.w, this.h);
    const d = img.data;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (!ozoneAt(x, y, this.geom, 0)) continue;
        const o = (y * this.w + x) * 4;
        d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }

  private rebuildWisps(weatherMix: Array<{ kind: string; weight: number }>): void {
    const sig = weatherMix.map(m => `${m.kind}:${m.weight}`).join('|');
    if (sig === this.lastWispSig) return;
    this.lastWispSig = sig;
    const stream = new Stream((this.geom.cx * 8191 + this.geom.R * 131 + sig.length) >>> 0);
    const positive = weatherMix.filter(m => m.weight > 0);
    const total = positive.reduce((sum, m) => sum + m.weight, 0);
    const count = positive.length === 0 ? 1 : 5 + stream.int(0, 3);
    const pickKind = (): string => {
      if (total <= 0) return 'cumulus';
      let roll = stream.next() * total;
      for (const mix of positive) {
        roll -= mix.weight;
        if (roll <= 0) return mix.kind;
      }
      return positive[positive.length - 1].kind;
    };
    this.wisps = Array.from({ length: count }, () => {
      const kind = pickKind();
      const colour = WISP_COLOURS[kind] ?? WISP_COLOURS.cumulus;
      const width = stream.range(this.geom.rx * 0.22, this.geom.rx * 0.62);
      const height = width * stream.range(0.09, 0.17);
      return {
        x: this.geom.cx + stream.range(-this.geom.rx * 0.72, this.geom.rx * 0.72),
        y: this.geom.cyTop + stream.range(-this.geom.rx * 0.78, this.geom.ry * 0.35),
        speed: stream.range(2.5, 7),
        alpha: stream.range(0.25, 0.58),
        sprite: makeWispSprite(width, height, stream.int(1, 1 << 20), colour.body, colour.under),
      };
    });
  }

  private drawWisps(
    g: CanvasRenderingContext2D, elapsed: number, bob: number, sunAzimuth: number, intensity = 1,
  ): void {
    const { cx, rx } = this.geom;
    for (const wisp of this.wisps) {
      const span = rx * 2;
      const drift = elapsed * wisp.speed + sunAzimuth * rx * 0.35;
      const x = ((wisp.x + drift - (cx - rx)) % span + span) % span + cx - rx;
      g.globalAlpha = wisp.alpha * intensity;
      g.drawImage(wisp.sprite, Math.round(x - wisp.sprite.width / 2), Math.round(wisp.y + bob - wisp.sprite.height / 2));
    }
    g.globalAlpha = 1;
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
