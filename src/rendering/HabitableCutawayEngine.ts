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

/**
 * Minimum bottom-rock band height as a fraction of the lower wall.
 * Target snow-globe: most of the underworld is WATER; rock is only a jagged
 * crescent at the base (with magma), not a dirt fill of the lower hemisphere.
 */
export const CUTAWAY_BOTTOM_ROCK = 0.26;

/**
 * Thin soil lip under the flat board (screen pixels, scaled lightly with rx).
 */
export const CUTAWAY_BOARD_LIP = 0.045;

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
   * flat projection of it. Length must be `w * h`.
   */
  pick?: Int32Array | null;
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
 * board (diorama_test language) — tiered land with cliff faces, ocean flush.
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

  const put = (
    px: number, py: number, cr: number, cg: number, cb: number, cellId: number,
  ): void => {
    if (py < yTop || py > y1 || px < x0 || px > x1) return;
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
  const cyBody = cutawayBodyCy(cyTop, rx, ry);

  // Painter's order: far rows first, so nearer ground occludes what is behind it.
  for (let py = yFace0; py <= y1; py++) {
    const dy = (py - cyTop) / ry;
    for (let px = x0; px <= x1; px++) {
      const dx = (px - cx) / rx;
      const r = Math.hypot(dx, dy);
      if (r > 1) continue;
      // Trim the tabletop to the body silhouette — see the file header. Without
      // this the disc's tips hang a few pixels outside the atmosphere shell.
      if (py < cyBody - rx * Math.sqrt(Math.max(0, 1 - dx * dx))) continue;

      let cr = 0, cg = 0, cb = 0, lift = 0, cellId = 0;

      if (!grid) {
        // No grid yet (first bake before data arrives): a plausible bare ocean,
        // so the body is never a hole in space.
        const band = r > 0.78 ? pal.biome.ocean : pal.biome.deep_ocean;
        cr = band.r; cg = band.g; cb = band.b;
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

        let base = pal.biome[biome];
        let br = base.r, bg = base.g, bb = base.b;

        if (isWater(biome)) {
          // Depth plate first, then a static swell pattern so the baked face
          // already looks wet before the animated overlay runs.
          const depth = clamp01((SEA_LEVEL - elev) / 0.18);
          const ws = pal.waterSurf;
          let band = depth < 0.22 ? ws.light : depth < 0.55 ? ws.mid : ws.deep;
          const swell = Math.sin(r * 11.5 + dx * 2.1)
                      + Math.cos(dx * 7.2 + dy * 5.8 + seed * 0.01) * 0.45
                      + (fbm1(px * 0.07 + py * 0.05, seed + 91, 3) - 0.5) * 1.1;
          if (swell > 0.72) band = ws.glint;
          else if (swell > 0.28) band = ws.light;
          else if (swell < -0.55) band = ws.deep;
          br = band.r; bg = band.g; bb = band.b;
          // Brighten the extreme rim so the ocean catches the atmosphere.
          if (r > 0.94) { br = Math.min(255, br + 40); bg = Math.min(255, bg + 40); bb = Math.min(255, bb + 50); }
        } else if (biome !== 'mountain' && biome !== 'snow' && biome !== 'tundra'
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

  g.putImageData(img, x0, yTop);
}

// ─── Underworld: soil lip, deep water, bottom rock ───────────────────────────

/**
 * Paint the underworld of the snow-globe diorama.
 *
 * Target layout (flat board in a glass sphere):
 *   1. thin brown soil lip hugging the underside of the tabletop
 *   2. deep water volume filling most of the lower circle (with cage lines)
 *   3. jagged rock crescent only at the bottom, with ember veins
 *
 * Upper air stays empty — the atmosphere shell owns that. Do not paint strata
 * into the sky.
 */
export function paintCutawayCrust(
  g: CanvasRenderingContext2D, opts: CutawayBakeOpts,
): void {
  const { w: VW, h: VH, cx, cyTop, rx, ry, seed } = opts;
  const pal = paletteFor(opts.planetType);
  const cyBody = cutawayBodyCy(cyTop, rx, ry);
  const R = rx;
  g.clearRect(0, 0, VW, VH);
  if (R < 8) return;

  const s = new Stream(seed ^ 0x51ed2701);
  const left = cx - R;
  const cols = R * 2 + 1;

  const faceBottom = new Float32Array(cols);
  const bodyBottom = new Float32Array(cols);
  const lipBottom  = new Float32Array(cols);
  const rockTop    = new Float32Array(cols);

  const lipH = Math.max(3, Math.round(R * CUTAWAY_BOARD_LIP));
  const silt = pal.strata[0];
  const cliff = pal.strata[1];
  const sub = pal.strata.slice(1);

  for (let i = 0; i < cols; i++) {
    const dxn = (left + i - cx) / R;
    const e = Math.sqrt(Math.max(0, 1 - dxn * dxn));
    const fb = Math.max(cyTop + ry * e, cyBody - R * e);
    const bb = cyBody + R * e;
    faceBottom[i] = fb;
    bodyBottom[i] = bb;

    const wallH = Math.max(1, bb - fb);
    const lb = Math.min(fb + lipH, bb - 2);
    lipBottom[i] = lb;

    const jag = fbm1(dxn * 4.2, seed, 4) * 0.55
              + fbm1(dxn * 13.0, seed + 77, 3) * 0.30
              + fbm1(dxn * 29.0, seed + 401, 2) * 0.15;
    const rockBand = wallH * CUTAWAY_BOTTOM_ROCK * (0.72 + jag * 0.55);
    let rt = bb - Math.max(6, rockBand);
    rt = Math.round(rt / 2) * 2;
    rt = Math.max(lb + 2, Math.min(rt, bb - 4));
    rockTop[i] = rt;
  }

  // Thin soil lip under the board.
  for (let i = 0; i < cols; i++) {
    const x = left + i;
    if (x < 0 || x >= VW) continue;
    const fb = faceBottom[i], lb = lipBottom[i];
    const h = lb - fb;
    if (h < 1) continue;
    const dxn = (x - cx) / R;
    const lit = 0.70 + 0.35 * clamp01(dxn * KEY_X + 0.4);
    for (let y = 0; y < h; y++) {
      const t = y / Math.max(1, h - 1);
      const base = t < 0.45 ? cliff : silt;
      const f = lit * (1 - t * 0.22) * (0.94 + hash1(x * 91 + y * 7, seed) * 0.1);
      g.fillStyle = css(shade(base, f));
      g.fillRect(x, Math.round(fb + y), 1, 1);
    }
  }

  // Deep water volume — most of the lower hemisphere.
  for (let i = 0; i < cols; i++) {
    const x = left + i;
    if (x < 0 || x >= VW) continue;
    const dxn = (x - cx) / R;
    const top = lipBottom[i], bot = rockTop[i];
    const h = bot - top;
    if (h < 1) continue;
    const lit = 0.72 + 0.32 * clamp01(dxn * KEY_X + 0.42);
    for (let y = 0; y < h; y++) {
      const depthRatio = y / h;
      g.fillStyle = css(rgb(
        Math.floor((pal.waterDeep.r + depthRatio * 18) * lit),
        Math.floor((pal.waterDeep.g + depthRatio * 26) * lit),
        Math.floor((pal.waterDeep.b + depthRatio * 42) * lit),
      ));
      g.fillRect(x, Math.round(top + y), 1, 1);
    }
  }

  g.fillStyle = css(pal.foam, 0.40);
  for (let i = 0; i < cols; i++) {
    const x = left + i;
    if (x < 0 || x >= VW) continue;
    if (rockTop[i] - lipBottom[i] < 2) continue;
    g.fillRect(x, Math.round(lipBottom[i]), 1, 1);
  }

  // Cage lines through the water.
  for (let i = 0; i < cols; i += 10) {
    const x = left + i;
    if (x < 0 || x >= VW) continue;
    const top = Math.round(lipBottom[i]) + 1;
    const bot = Math.round(rockTop[i]) - 1;
    if (bot <= top) continue;
    g.fillStyle = css(pal.facet, 0.14);
    for (let y = top; y < bot; y++) g.fillRect(x, y, 1, 1);
  }

  // Bottom rock crescent only.
  for (let i = 0; i < cols; i++) {
    const x = left + i;
    if (x < 0 || x >= VW) continue;
    const dxn = (x - cx) / R;
    const rt = rockTop[i], bb = bodyBottom[i];
    const depth = bb - rt;
    if (depth < 1) continue;
    const lit = quantise(0.30 + 0.78 * clamp01(dxn * KEY_X + 0.44), 0.10);
    const flank = 1 - Math.pow(clamp01((Math.abs(dxn) - 0.52) / 0.48), 2) * 0.40;
    const wave = (fbm1(x * 0.022, seed + 311, 3) - 0.5) * 0.65
               + (fbm1(x * 0.08, seed + 733, 2) - 0.5) * 0.25;
    for (let y = 0; y < depth; y++) {
      const absY = rt + y;
      const depthF = y / Math.max(1, depth);
      let f = lit * flank * (1 - depthF * 0.28);
      const bandPos = depthF * sub.length + wave * 0.35;
      const bi = Math.max(0, Math.min(sub.length - 1, Math.floor(bandPos)));
      let base = y < 2 ? silt : sub[bi];
      const frac = bandPos - Math.floor(bandPos);
      if (frac < 0.08) f *= 0.66;
      else if (frac < 0.18) f *= 1.12;
      f *= 0.92 + hash1(x * 733 + y * 13, seed) * 0.14;
      g.fillStyle = css(shade(base, f));
      g.fillRect(x, Math.round(absY), 1, 1);
    }
    g.fillStyle = 'rgba(6,5,12,0.55)';
    g.fillRect(x, Math.round(bb) - 1, 1, 1);
  }

  // Ember glow + veins in bottom rock.
  g.save();
  g.beginPath();
  g.arc(cx, cyBody, R - 1, 0, Math.PI * 2);
  g.clip();
  g.globalCompositeOperation = 'lighter';
  const glowY = cyBody + R * 0.78;
  const glow = g.createRadialGradient(cx, glowY, 0, cx, glowY, R * 0.38);
  glow.addColorStop(0, css(pal.ember, 0.14));
  glow.addColorStop(0.5, css(pal.ember, 0.04));
  glow.addColorStop(1, css(pal.ember, 0));
  g.fillStyle = glow;
  g.fillRect(cx - R, glowY - R, R * 2, R * 2);
  g.globalCompositeOperation = 'source-over';
  g.restore();

  const veins = 4 + (seed % 3);
  for (let k = 0; k < veins; k++) {
    let x = cx + s.range(-R * 0.70, R * 0.70);
    const i0 = Math.round(x) - left;
    if (i0 < 0 || i0 >= cols) continue;
    const lo = rockTop[i0] + 2;
    const hi = bodyBottom[i0] - 3;
    if (hi <= lo) continue;
    let y = s.range(lo, hi);
    const len = s.range(3, 12);
    const drift = s.range(-0.7, 0.7);
    for (let step = 0; step < len; step++) {
      const i = Math.round(x) - left;
      if (i < 0 || i >= cols) break;
      if (y < rockTop[i] + 1 || y > bodyBottom[i] - 2) break;
      const hot = step === 0 || s.next() > 0.62;
      g.fillStyle = css(hot ? pal.emberHot : pal.ember, hot ? 0.9 : 0.65);
      g.fillRect(Math.round(x), Math.round(y), 1, 1);
      x += drift;
      y += s.range(0.4, 1.1);
    }
  }
}

// ─── Atmosphere shell ─────────────────────────────────────────────────────────

/**
 * Bake the snow-globe atmosphere: thin outer rim + soft translucent wash in the
 * UPPER half only (above the living board). No filled lower-globe haze.
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
