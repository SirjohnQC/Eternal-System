/**
 * HabitableCutawayEngine — cutaway bake pipeline for earth-like worlds.
 *
 * Reference: `assets/mockups/habitable-diorama-target.png` (habitable, with
 * atmosphere) and `assets/mockups/ocean-cutaway-ref.jpg` (bare ocean slab).
 *
 * ── The geometry ──────────────────────────────────────────────────────────────
 * The body silhouette is a full CIRCLE of radius `rx` — a whole planet, not a
 * torn-off chunk. The living surface is a foreshortened ellipse seated INTO that
 * circle (not flush with the crest), with a thick sheer wall under the front rim
 * — the `diorama_test.html` 3/4 "god over the world" read:
 *
 *        cyBody − rx              ─── top of the sphere (rock / sky behind)
 *        cyTop − ry               ─── far rim of the tabletop
 *        cyTop                    ─── ellipse centre
 *        cyTop + ry               ─── front of the ellipse rim
 *        cyTop + ry + wallDepth   ─── bottom of the cake wall (water / cliff)
 *        cyBody + rx              ─── bottom of the circle
 *
 * with `cyBody = cyTop + (rx − ry) − rx·CUTAWAY_FACE_DROP`. Under the board:
 * thin soil lip → deep water (cage lines) → rock crescent at the floor only.
 * Air above the board stays empty aside from the soft dome wash.
 *
 * Past |dx| > ~0.94·rx the ellipse rim would sit OUTSIDE the circle. Both passes
 * clamp to the circle, which blunts the last few percent of the tabletop's tips
 * and leaves bare rock at the limb — the reference's shoulder.
 *
 * ── Why a separate file ───────────────────────────────────────────────────────
 * The legacy path in `IsoDioramaRenderer` renders a *floating disc* under a
 * glass dome: soft pulsing halo, specular sweep, jagged keel hanging in space.
 * That is a different object from the mockup, and the two looks cannot share a
 * bake without one of them being compromised. Ocean and rocky worlds bake here;
 * lava / ice / gas stay on the legacy path (Phase 2).
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

export type HabitableType = 'ocean' | 'rocky';

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

export function bobOf(elapsed: number, R: number): number {
  const amp = Math.max(1, Math.round(R / 48));
  return Math.sin(elapsed * 0.7) * amp;
}

export function habitableGeom(VW: number, VH: number): HabitableGeom {
  let R = Math.round(Math.min(VW * 0.40, VH * 0.28));
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

// ─── Legacy cutaway geometry (IsoDioramaRenderer until Task 7) ──────────────
// Task 7 will switch the host to `habitableGeom`; keep these formulas unchanged.

/**
 * How squashed the cut face is. `diorama_test` uses ry/rx ≈ 30/58 ≈ 0.52 —
 * a flat living board, not a thin slit on a globe. Match that.
 */
export const CUTAWAY_FACE_SQUASH = 0.50;

/**
 * How far below the sphere crest the tabletop sits, as a fraction of `rx`.
 * Keep this small — a large drop opens an empty crescent that either reads as a
 * hollow bowl or tempts a rock fill that dirties the atmosphere.
 */
export const CUTAWAY_FACE_DROP = 0.04;

/** Vertical centre of the body circle, given the top face's ellipse. */
export function cutawayBodyCy(cyTop: number, rx: number, ry: number): number {
  return cyTop + (rx - ry) - Math.round(rx * CUTAWAY_FACE_DROP);
}

/** Top-face ellipse centre, given the body circle (inverse of `cutawayBodyCy`). */
export function cutawayFaceCy(cyBody: number, rx: number, ry: number): number {
  return cyBody - (rx - ry) + Math.round(rx * CUTAWAY_FACE_DROP);
}

export interface CutawayGeom {
  /** Horizontal centre of the body, in virtual pixels. */
  cx: number;
  /** Centre of the top-face ellipse. */
  cyTop: number;
  /** Top-face x-radius — also the body sphere's radius. */
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
  /**
   * Written with `row * GRID_SIZE + col + 1` for every surface pixel painted,
   * so picking hits the cell that was actually DRAWN at a pixel rather than the
   * flat projection of it. Length must be `w * h`. Water cells still stamp pick
   * even though they leave the land canvas empty.
   */
  pick?: Int32Array | null;
  /** Length `w * h`, 1 = fluid on the ellipse. */
  occupancy?: Uint8Array | null;
}

export interface CutawayBakeResult {
  /** Flat biome tabletop (the cut face). */
  surface: HTMLCanvasElement;
  /** Cutaway water column + rock strata + ember core. */
  crust: HTMLCanvasElement;
  /** Thin atmosphere shell: rim stroke, inner haze, tight outer bloom. */
  atmosphere: HTMLCanvasElement;
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
  /** Atmosphere shell colour. */
  atmo: RGB;
  /** Outer shell thickness in body-radius fractions (test harness ~16px on R≈200). */
  atmoThickness: number;
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
  waterSurf: {
    deep:  rgb(18, 48, 88),
    mid:   rgb(35, 95, 160),
    light: rgb(70, 150, 220),
    glint: rgb(170, 220, 255),
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
  atmo:     rgb(65, 165, 255),
  atmoThickness: 0.045,
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
  atmo:     rgb(100, 170, 230),
  atmoThickness: 0.04,
};

function paletteFor(type: HabitableType): CutawayPalette {
  return type === 'ocean' ? OCEAN_PALETTE : ROCKY_PALETTE;
}

/** Atmosphere tint, exported so the consumer can match its own overlays to it. */
export function cutawayAtmoColour(type: HabitableType): RGB {
  return paletteFor(type).atmo;
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
        // which is what altitude actually does to a mountain.
        if (biome === 'mountain' && cell.elevation > 0.82) biome = 'snow';

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

  g.putImageData(img, x0, yTop);
}

// ─── Underworld: spherical crust + sheer front wall ──────────────────────────

/**
 * Paint the spherical crust beneath the living board.
 *
 * The tabletop ellipse stays transparent: surface and fluids own it. A short
 * front wall carries either ocean facets or land cliffs, while all remaining
 * body pixels are screen-depth-aligned geological strata.
 */
export function paintCutawayCrust(
  g: CanvasRenderingContext2D, opts: CutawayBakeOpts,
): void {
  const { w: VW, h: VH, cx, cyTop, rx, ry, seed } = opts;
  const fallback = habitableGeom(VW, VH);
  const R = opts.R ?? fallback.R;
  const wall = opts.wall ?? fallback.wall;
  const cyBody = opts.cyBody ?? fallback.cyBody;
  const pal = paletteFor(opts.planetType);
  g.clearRect(0, 0, VW, VH);
  if (R < 8) return;

  const x0 = Math.max(0, Math.floor(cx - R));
  const x1 = Math.min(VW - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cyBody - R));
  const y1 = Math.min(VH - 1, Math.ceil(cyBody + R));

  for (let y = y0; y <= y1; y++) {
    const dyBody = y - cyBody;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dyBody * dyBody > R * R) continue;
      const faceX = dx / rx;
      const faceY = (y - cyTop) / ry;
      if (faceX * faceX + faceY * faceY <= 1) continue;
      if (y < cyTop + ry * 0.28 && Math.abs(dx) <= rx) continue;

      const depth = (y - (cyBody - R)) / (2 * R);
      const wave = (fbm1(x * 0.022, seed + 311, 3) - 0.5) * 0.60;
      const band = Math.max(0, Math.min(
        pal.strata.length - 1, Math.floor(depth * pal.strata.length + wave),
      ));
      const light = quantise(
        0.34 + 0.78 * clamp01((dx / R) * KEY_X + (dyBody / R) * KEY_Y + 0.60),
        0.10,
      );
      const grain = 0.92 + hash1(x * 733 + y * 13, seed) * 0.14;
      const ember = depth > 0.78 && hash1(x * 179 + y * 991, seed + 19) > 0.986;
      g.fillStyle = css(ember ? pal.emberHot : shade(pal.strata[band], light * grain));
      g.fillRect(x, y, 1, 1);
    }
  }

  // The front rim is a thin vertical cut, not a lower-hemisphere water bowl.
  const rimX0 = Math.max(0, Math.ceil(cx - rx));
  const rimX1 = Math.min(VW - 1, Math.floor(cx + rx));
  for (let x = rimX0; x <= rimX1; x++) {
    const faceX = (x - cx) / rx;
    const frontY = cyTop + Math.sqrt(Math.max(0, 1 - faceX * faceX)) * ry;
    const ridge = (fbm1(x * 0.075, seed + 77, 3) - 0.5) * 5;
    const bottomY = frontY + wall + ridge;
    const rimY = Math.max(0, Math.min(VH - 1, Math.floor(frontY) - 1));
    const hasOccupancy = opts.occupancy && opts.occupancy.length === VW * VH;
    const water = !hasOccupancy || opts.occupancy![rimY * VW + x] !== 0;

    for (let y = Math.ceil(frontY); y <= Math.floor(bottomY); y++) {
      if (y < 0 || y >= VH || (x - cx) ** 2 + (y - cyBody) ** 2 > R * R) continue;
      const faceY = (y - cyTop) / ry;
      if (faceX * faceX + faceY * faceY <= 1) continue;
      const t = clamp01((y - frontY) / Math.max(1, bottomY - frontY));
      const light = quantise(0.70 + 0.30 * clamp01(faceX * KEY_X + 0.42), 0.08);
      if (water) {
        const facet = x % 14 === 0 ? 0.20 : 0;
        g.fillStyle = css(shade(rgb(
          mix(pal.waterLip.r, pal.waterDeep.r, t),
          mix(pal.waterLip.g, pal.waterDeep.g, t),
          mix(pal.waterLip.b, pal.waterDeep.b, t),
        ), light + facet));
      } else {
        const stripe = Math.min(pal.strata.length - 1, 1 + Math.floor(t * 3));
        g.fillStyle = css(shade(pal.strata[stripe], light));
      }
      g.fillRect(x, y, 1, 1);
    }
  }
}

// ─── Atmosphere shell ─────────────────────────────────────────────────────────

/**
 * Live thick atmosphere: ring `R < dist <= R+T` with ^1.6 falloff, sun-side
 * 0.85 / shadow 0.28, plus a limb wrap on the last `max(5, round(0.08*R))`
 * of the sphere at alpha 0.22. Colour from `paletteFor(type).atmo`.
 *
 * Writes RGBA into an existing ImageData. Thickness is `geom.T`, never
 * `pal.atmoThickness`. `bakeCutawayAtmosphere` is the old thin shell and is
 * not the habitable look (Task 7/8 delete it).
 */
export function paintAtmosphere(
  img: ImageData, geom: HabitableGeom, planetType: HabitableType, bob: number,
): void {
  const { cx, R, T } = geom;
  const cy = geom.cyBody + bob;
  const atmo = paletteFor(planetType).atmo;
  const atmoR = R + T;
  const d = img.data;
  const w = img.width, h = img.height;
  const limb = Math.max(5, Math.round(R * 0.08));
  const y0 = Math.max(0, Math.floor(cy - atmoR));
  const y1 = Math.min(h - 1, Math.ceil(cy + atmoR));
  const x0 = Math.max(0, Math.floor(cx - atmoR));
  const x1 = Math.min(w - 1, Math.ceil(cx + atmoR));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const o = (y * w + x) * 4;
      if (dist > R && dist <= atmoR) {
        const falloff = Math.pow(1 - (dist - R) / T, 1.6);
        const glow = falloff * (dx / atmoR > -0.1 ? 0.85 : 0.28);
        d[o] = atmo.r; d[o + 1] = atmo.g; d[o + 2] = atmo.b;
        d[o + 3] = Math.round(glow * 255);
      } else if (dist <= R && dist > R - limb) {
        d[o] = atmo.r; d[o + 1] = atmo.g; d[o + 2] = atmo.b;
        d[o + 3] = Math.round(0.22 * 255);
      }
    }
  }
}

/**
 * Bake the snow-globe atmosphere: thin outer rim + soft translucent wash in the
 * UPPER half only (above the living board). No filled lower-globe haze.
 *
 * @deprecated Habitable look is `paintAtmosphere` + `geom.T`. Task 7/8 delete this.
 */
export function bakeCutawayAtmosphere(
  w: number, h: number, geom: CutawayGeom, planetType: HabitableType,
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  const g = c.getContext('2d');
  if (!g) return c;

  const { cx, cyTop, rx, ry } = geom;
  const R = rx;
  const cyBody = cutawayBodyCy(cyTop, rx, ry);
  const pal = paletteFor(planetType);
  const atmo = pal.atmo;
  if (R < 8) return c;

  const thick = Math.max(2, Math.round(R * pal.atmoThickness));
  const atmoR = R + thick;
  const faceFront = cyTop + ry;

  // Soft blue dome fill — upper hemisphere only, above the tabletop.
  g.save();
  g.beginPath();
  g.arc(cx, cyBody, R - 1, 0, Math.PI * 2);
  g.clip();
  const dome = g.createRadialGradient(cx, cyBody - R * 0.35, R * 0.05, cx, cyBody, R);
  dome.addColorStop(0, css(atmo, 0.10));
  dome.addColorStop(0.55, css(atmo, 0.05));
  dome.addColorStop(1, css(atmo, 0));
  g.fillStyle = dome;
  g.fillRect(cx - R, cyBody - R, R * 2, Math.max(1, faceFront - (cyBody - R) + 4));
  // Carve out below the board so water/rock stay un-hazed.
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = 'rgba(0,0,0,1)';
  g.fillRect(0, Math.round(faceFront), c.width, c.height);
  g.globalCompositeOperation = 'source-over';
  g.restore();

  // Thin outer annulus.
  const img = g.createImageData(c.width, c.height);
  const d = img.data;
  const y0 = Math.max(0, Math.floor(cyBody - atmoR));
  const y1 = Math.min(c.height - 1, Math.ceil(cyBody + atmoR));
  const x0 = Math.max(0, Math.floor(cx - atmoR));
  const x1 = Math.min(c.width - 1, Math.ceil(cx + atmoR));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cyBody;
      const dist = Math.hypot(dx, dy);
      if (dist <= R || dist > atmoR) continue;
      const falloff = Math.pow(1 - (dist - R) / thick, 1.8);
      const sunFacing = dx / atmoR;
      const glow = falloff * (sunFacing > -0.1 ? 0.55 : 0.16);
      if (glow < 0.03) continue;
      const o = (y * c.width + x) * 4;
      d[o] = atmo.r;
      d[o + 1] = atmo.g;
      d[o + 2] = atmo.b;
      d[o + 3] = Math.min(255, Math.round(glow * 130));
    }
  }
  // Composite annulus over existing dome.
  const tmp = document.createElement('canvas');
  tmp.width = c.width; tmp.height = c.height;
  const tg = tmp.getContext('2d')!;
  tg.putImageData(img, 0, 0);
  g.drawImage(tmp, 0, 0);

  g.lineWidth = 1;
  g.strokeStyle = css(rgb(
    Math.min(255, atmo.r + 70), Math.min(255, atmo.g + 50), Math.min(255, atmo.b + 25),
  ), 0.40);
  g.beginPath();
  g.arc(cx, cyBody, R - 0.5, 0, Math.PI * 2);
  g.stroke();

  // Night-side fade.
  g.globalCompositeOperation = 'destination-out';
  const fade = g.createLinearGradient(
    cx + R * 0.9, cyBody - R, cx - R * 0.5, cyBody + R,
  );
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(0.45, 'rgba(0,0,0,0.10)');
  fade.addColorStop(1, 'rgba(0,0,0,0.65)');
  g.fillStyle = fade;
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'source-over';

  return c;
}

/** Surface water bands for the animated fluid overlay (habitable path). */
export function cutawayWaterSurf(type: HabitableType): {
  deep: RGB; mid: RGB; light: RGB; glint: RGB;
} {
  return paletteFor(type).waterSurf;
}

/**
 * Live glitter water on occupancy pixels. Wave from diorama_test, sped up.
 * Only occupancy===1 inside the pancake at `cyTop + bob`. Opaque RGB, alpha 255.
 */
export function paintFluids(
  img: ImageData, geom: HabitableGeom, occupancy: Uint8Array,
  planetType: HabitableType, elapsed: number, bob: number,
): void {
  const { cx, rx, ry } = geom;
  const cy = geom.cyTop + bob;
  const t = elapsed;
  const pal = cutawayWaterSurf(planetType);
  const d = img.data;
  const w = img.width, h = img.height;
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(h - 1, Math.ceil(cy + ry));
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(w - 1, Math.ceil(cx + rx));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const idx = py * w + px;
      if (occupancy[idx] !== 1) continue;
      const dx = (px - cx) / rx;
      const dy = (py - cy) / ry;
      const r2 = dx * dx + dy * dy;
      if (r2 > 1) continue;
      const wave = Math.sin(r2 * 12 - t * 3.2) + Math.cos(px * 0.12 + py * 0.1 + t * 1.4) * 0.4;
      let c = pal.mid;
      if (wave > 0.48) c = pal.glint;
      else if (wave > 0.12) c = pal.light;
      else if (wave < -0.55) c = pal.deep;
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
  ice_haze: { body: rgb(225, 244, 255), under: rgb(138, 180, 208) },
};

/**
 * Owns static layers and composites moving habitable-world effects.
 * `drawGeom` includes bob for host-owned overlay placement.
 */
export class HabitableCutawayEngine {
  geom: HabitableGeom = habitableGeom(1, 1);
  occupancy = new Uint8Array(1);
  pick = new Int32Array(1);

  private crust = document.createElement('canvas');
  private land = document.createElement('canvas');
  private w = 1;
  private h = 1;
  private planetType: HabitableType = 'ocean';
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
    this.elapsed = 0;
    this.occupancy = new Uint8Array(this.w * this.h);
    this.pick = new Int32Array(this.w * this.h);
    this.wisps = [];
    this.lastWispSig = '\0';
    this.resizeLayers(this.w, this.h);
    const bakeOpts: CutawayBakeOpts = {
      ...opts, ...this.geom, w: this.w, h: this.h,
      occupancy: this.occupancy, pick: this.pick,
    };
    const crustG = this.crust.getContext('2d');
    const landG = this.land.getContext('2d');
    if (crustG) paintCutawayCrust(crustG, bakeOpts);
    if (landG) paintCutawaySurface(landG, bakeOpts);
    this.rebuildWisps(opts.weatherMix ?? []);
  }

  frame(input: HabitableFrameInput): void {
    const { g, elapsed } = input;
    this.elapsed = elapsed;
    this.rebuildWisps(input.weatherMix);
    const bob = this.bob;
    const layerBob = Math.round(bob);

    g.drawImage(input.bg, 0, 0);
    input.drawFarSpace(g);
    const atmo = g.createImageData(this.w, this.h);
    paintAtmosphere(atmo, this.geom, this.planetType, bob);
    g.putImageData(atmo, 0, 0);
    g.drawImage(this.crust, 0, layerBob);
    g.drawImage(this.land, 0, layerBob);
    const fluids = g.createImageData(this.w, this.h);
    paintFluids(fluids, this.geom, this.occupancy, this.planetType, elapsed, bob);
    g.putImageData(fluids, 0, 0);
    input.drawOverlays(g);
    this.drawWisps(g, elapsed, bob);
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
        x: this.geom.cx + stream.range(-this.geom.R, this.geom.R),
        y: this.geom.cyTop + stream.range(-this.geom.ry * 0.3, this.geom.R * 0.7),
        speed: stream.range(2.5, 7),
        alpha: stream.range(0.25, 0.58),
        sprite: makeWispSprite(width, height, stream.int(1, 1 << 20), colour.body, colour.under),
      };
    });
  }

  private drawWisps(g: CanvasRenderingContext2D, elapsed: number, bob: number): void {
    const { cx, cyBody, R, T } = this.geom;
    const radius = R + T;
    g.save();
    g.beginPath();
    g.arc(cx, cyBody + bob, radius, 0, Math.PI * 2);
    g.clip();
    for (const wisp of this.wisps) {
      const span = radius * 2;
      const x = ((wisp.x + elapsed * wisp.speed - (cx - radius)) % span + span) % span + cx - radius;
      g.globalAlpha = wisp.alpha;
      g.drawImage(wisp.sprite, Math.round(x - wisp.sprite.width / 2), Math.round(wisp.y + bob - wisp.sprite.height / 2));
    }
    g.globalAlpha = 1;
    g.restore();
  }
}

// ─── Convenience / smoke entry point ──────────────────────────────────────────

/**
 * Bake all three habitable layers into fresh canvases.
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
    atmosphere: bakeCutawayAtmosphere(opts.w, opts.h, opts, opts.planetType),
  };
}
