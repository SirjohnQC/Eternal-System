/**
 * PlanetGrid — data-driven simulation layer for a single planet.
 *
 * The grid is the source of truth for all surface conditions.
 * Rendering reads from it; it never reads from rendering.
 *
 * Coordinate system: grid[row][col], row 0 = north pole, row GRID_SIZE-1 = south pole.
 * Columns wrap (cylindrical projection). GRID_SIZE × GRID_SIZE cells.
 *
 * The grid is runtime-only and regenerates deterministically from the planet seed.
 * It is NOT serialized to saves — regenerate on load with the same seed.
 */

import type { PlanetDNA } from './GameState';
import { elevationFor, structureFor, continentsElevation, discsElevation, canyonElevation, canyonTrough, type TerrainArchetype } from './TerrainArchetypes';

/** Convert PlanetDNA string enums to numeric values used by grid generation */
export function dnaToGridParams(dna: PlanetDNA): { oceanCoverage: number; tempBias: number } {
  const oceanMap: Record<string, number> = {
    barren: 0.2, mixed: 0.6, ocean_world: 0.88,
  };
  const climateMap: Record<string, number> = {
    frozen: -0.3, temperate: 0.0, desert: 0.3,
  };
  return {
    oceanCoverage: oceanMap[dna.oceans]  ?? 0.6,
    tempBias:      climateMap[dna.climate] ?? 0.0,
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const GRID_SIZE = 256;

// ─── Biome types (ordered by rendering priority) ──────────────────────────────

export type BiomeType =
  | 'deep_ocean' | 'ocean' | 'shallow' | 'beach'
  | 'plains'     | 'grassland' | 'forest' | 'jungle'
  | 'desert'     | 'savanna'   | 'tundra' | 'snow'
  | 'mountain'   | 'volcanic'
  /** Inland water above the sea, in a basin (#47); its surface is `GridCell.lake`. */
  | 'lake';

/** RGB color per biome for terrain rendering */
export const BIOME_COLORS: Record<BiomeType, [number, number, number]> = {
  deep_ocean: [12,  36,  88],
  ocean:      [20,  60, 125],
  shallow:    [35,  95, 155],
  beach:      [195, 180, 135],
  plains:     [135, 165, 85],
  grassland:  [90,  150, 65],
  forest:     [45,  105, 50],
  jungle:     [25,  85,  40],
  desert:     [205, 170, 95],
  savanna:    [170, 148, 75],
  tundra:     [155, 170, 175],
  snow:       [215, 228, 232],
  mountain:   [115, 105, 100],
  volcanic:   [95,  25,  8],
  lake:       [52,  118, 160],
};

/** Whether a biome is water (affects life spread, city placement) */
export function isWater(biome: BiomeType): boolean {
  return biome === 'deep_ocean' || biome === 'ocean' || biome === 'shallow' || biome === 'lake';
}

/**
 * A cell's biome after its ground changed (a divine edit, a rift): its lake
 * holds while the ground stays at or under the lake's surface (#47);
 * otherwise the usual classification.
 */
export function reclassify(cell: GridCell, planetType: string): BiomeType {
  if (cell.lake && cell.elevation <= cell.lake + 1e-6) return 'lake';
  return classifyBiome(cell.elevation, cell.moisture, cell.temperature, planetType);
}

/** Whether a biome is habitable land */
export function isHabitable(biome: BiomeType): boolean {
  return !isWater(biome) && biome !== 'mountain' && biome !== 'volcanic';
}

// ─── Grid cell ────────────────────────────────────────────────────────────────

export interface GridCell {
  /** Height above sea level, 0–1. Values ≤ SEA_LEVEL are water. */
  elevation:    number;
  /** Rainfall / humidity, 0–1 */
  moisture:     number;
  /** Surface temperature (0 = arctic, 1 = equatorial/hot), 0–1 */
  temperature:  number;
  /** Derived biome classification */
  biome:        BiomeType;
  /** How well life can grow here, 0–1 (0 in water/volcanic) */
  fertility:    number;
  /** Current life coverage, 0–1 (updated by EvolutionEngine) */
  lifeDensity:  number;
  /** ID of the dominant species on this cell, or null */
  dominantSpeciesId: string | null;
  /** ID of the civilization controlling this cell, or null */
  civId:        string | null;
  /** 0 on dry ground, ~0.65 a stream, 1 a river. A fall adds 1 (1.65 or 2). */
  river:        number;
  /**
   * Downhill step of a channel, 0–7 (N, NE, … NW in grid row/col). -1 when
   * this cell is not a channel. See `RIVER_STEP`.
   */
  riverDir:     number;
  /** Surface level of the lake this cell lies under (#47); 0/absent: none. */
  lake?:        number;
  /**
   * 0..1: a fire's scar (Wildfire.ts). Charred ground, life cut back, fields
   * bearing less; fades over a few generations. 0/absent: never burnt.
   */
  burn?:        number;
}

export type PlanetGrid = GridCell[][];

/**
 * Version of the terrain generator. Saved surface changes are stored against
 * the generated grid, so they only apply to a grid from the same generator:
 * bump this whenever generatePlanetGrid's output changes for the same inputs.
 */
export const GRID_GENERATOR = 3; // 2: continents no longer mirrored (#104); 3: lakes (#47)

/** Every field of a cell, saved where it differs from the generated world (#77). */
export const SAVED_GRID_FIELDS = [
  'elevation', 'moisture', 'temperature', 'biome', 'fertility', 'lifeDensity',
  'dominantSpeciesId', 'civId', 'river', 'riverDir', 'lake', 'burn',
] as const;

/**
 * What the simulation and the player changed on a grid, against the grid the
 * world was generated with: per field, runs of changed cells (`runs` is
 * [start, length, start, length, …] over row-major cell indices) and their
 * values in order. Exact values (no rounding), and small: a settled world
 * is a few KB once gzipped, because changed cells come in long runs.
 */
export type GridEdits = Partial<Record<(typeof SAVED_GRID_FIELDS)[number], { runs: number[]; vals: unknown[] }>>;

/** The changes that turn `base` into `grid` (same size). */
export function diffGrid(grid: PlanetGrid, base: PlanetGrid): GridEdits {
  const out: GridEdits = {};
  const rows = grid.length, cols = grid[0]?.length ?? 0, n = rows * cols;
  for (const k of SAVED_GRID_FIELDS) {
    const runs: number[] = [], vals: unknown[] = [];
    let i = 0;
    while (i < n) {
      const a = grid[(i / cols) | 0][i % cols], b = base[(i / cols) | 0][i % cols];
      if (a[k] === b[k]) { i++; continue; }
      const start = i;
      while (i < n) {
        const a2 = grid[(i / cols) | 0][i % cols], b2 = base[(i / cols) | 0][i % cols];
        if (a2[k] === b2[k]) break;
        vals.push(a2[k]);
        i++;
      }
      runs.push(start, i - start);
    }
    if (runs.length) out[k] = { runs, vals };
  }
  return out;
}

/** Apply `diffGrid` output to a freshly generated grid. Ignores anything malformed. */
export function applyGridEdits(grid: PlanetGrid, edits: GridEdits): void {
  const rows = grid.length, cols = grid[0]?.length ?? 0, n = rows * cols;
  for (const k of SAVED_GRID_FIELDS) {
    const e = edits[k];
    if (!e || !Array.isArray(e.runs) || !Array.isArray(e.vals)) continue;
    let v = 0;
    for (let r = 0; r + 1 < e.runs.length; r += 2) {
      const start = e.runs[r], len = e.runs[r + 1];
      for (let i = start; i < start + len && i < n && v < e.vals.length; i++, v++) {
        if (i < 0) continue;
        (grid[(i / cols) | 0][i % cols] as unknown as Record<string, unknown>)[k] = e.vals[v];
      }
    }
  }
}

// ─── Internal noise helpers ───────────────────────────────────────────────────

/** Fast integer hash for deterministic spatial noise */
function hash2(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 1057017 + seed * 2654435761) | 0;
  h = ((h ^ (h >>> 13)) * 1540483477) | 0;
  h = h ^ (h >>> 15);
  return ((h >>> 0) & 0xffff) / 0xffff;
}

/** Smoothstep for noise blending */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Bilinear value noise */
function noise2d(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix,        fy = y - iy;
  const ux = smooth(fx),    uy = smooth(fy);
  const a = hash2(ix,     iy,     seed);
  const b = hash2(ix + 1, iy,     seed);
  const c = hash2(ix,     iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Fractional Brownian Motion — 7 octaves of value noise */
function fbm(x: number, y: number, seed: number, octaves = 7): number {
  let v = 0, amp = 0.5, freq = 1.0, maxV = 0;
  for (let i = 0; i < octaves; i++) {
    v    += amp * noise2d(x * freq, y * freq, seed + i * 997);
    maxV += amp;
    amp  *= 0.5;
    freq *= 2.1;
  }
  return v / maxV;
}

/**
 * FBM that is periodic along x.
 *
 * The grid is a cylindrical projection, so column 0 and column GRID_SIZE−1 are
 * neighbours on the real planet. Plain FBM is not periodic, which left a hard
 * seam running pole-to-pole through every view of the world (surface map, baked
 * planet texture, and the home-world diorama, where it shows as a straight line
 * from the centre of the disc to the rim). Cross-fading the sample with the same
 * sample one period away makes the field wrap exactly.
 *
 * @param t  normalized longitude 0–1, the cross-fade weight
 */
function fbmWrapX(
  x: number, y: number, seed: number, period: number, t: number, octaves = 7,
): number {
  const a = fbm(x, y, seed, octaves);
  const b = fbm(x - period, y, seed, octaves);
  return a + (b - a) * t;
}

// ─── Biome classification ─────────────────────────────────────────────────────

export const SEA_LEVEL = 0.48;

/**
 * Worlds whose share of water is set directly, because the land shapes
 * (continents, archipelagos, canyons) and the uniform bias below put their
 * seas in the wrong place: ice and crystal worlds came out bone dry, toxic and
 * storm worlds nearly all sea. `level` is the elevation under which the type's
 * own classifyBiome draws water; `share` the wanted fraction at average DNA.
 */
const SEA_CALIBRATION: Record<string, { level: number; share: number; grid?: boolean }> = {
  ice:     { level: SEA_LEVEL - 0.12, share: 0.18 },
  crystal: { level: SEA_LEVEL - 0.14, share: 0.12 },
  // Rocky worlds take every land layout now (#100); their share of sea is
  // held here so an island or continent layout does not drown the land the
  // nations need, nor a cracked plateau leave it bone dry.
  // Counted on the grid itself (not the face, whose rim dips into sea anyway),
  // so the layout's own coasts carry the water.
  rocky:   { level: SEA_LEVEL,        share: 0.3, grid: true },
  toxic:   { level: SEA_LEVEL,        share: 0.55 },
  storm:   { level: SEA_LEVEL,        share: 0.55 },
};

/**
 * The planet view lowers the ground toward the disc's rim (its rim falloff,
 * up to 0.30 at the edge), so water there comes easily; the share above is
 * what the player SEES on the face. Sampled falloffs, weighted by area.
 */
const RIM_SAMPLES = Array.from({ length: 12 }, (_, k) => {
  const r = Math.sqrt((k + 0.5) / 12);
  const t = Math.max(0, Math.min(1, (r - 0.34) / 0.66));
  return t * t * 0.30;
});

/** Shift a world's elevations so its type's water covers about the wanted share of the face. */
function calibrateSeas(grid: PlanetGrid, planetType: string, oceanCoverage: number): void {
  const cal = SEA_CALIBRATION[planetType];
  if (!cal) return;
  // DNA still matters: a barren world keeps less, an ocean world more.
  const share = Math.max(0.02, Math.min(0.85, cal.share * Math.max(0.3, oceanCoverage) / 0.6 * (planetType === 'ice' || planetType === 'crystal' ? 0.6 / 0.28 : 1)));
  const elevs: number[] = [];
  for (const row of grid) for (const c of row) elevs.push(c.elevation);
  const samples = cal.grid ? [0] : RIM_SAMPLES;
  const wetAt = (shift: number): number => {
    let w = 0;
    for (const e of elevs) for (const f of samples) if (e + shift - f < cal.level) w++;
    return w / (elevs.length * samples.length);
  };
  let lo = -0.6, hi = 0.6;          // more shift = drier
  for (let it = 0; it < 24; it++) {
    const mid = (lo + hi) / 2;
    if (wetAt(mid) > share) lo = mid; else hi = mid;
  }
  const shift = (lo + hi) / 2;
  for (const row of grid) for (const c of row) c.elevation = Math.max(0, Math.min(1, c.elevation + shift));
}

/** Soft cap on oceanCoverage per planet type (grid elevation bias). */
const TYPE_OCEAN_COVERAGE: Record<string, number> = {
  ocean:   0.88,
  rocky:   0.55,
  ice:     0.28,
  lava:    0.42,
  gas:     0.0,
  desert:  0.12,
  carbon:  0.18,
  crystal: 0.22,
  storm:   0.50,
  toxic:   0.72,
};

export function classifyBiome(
  elev: number, moist: number, temp: number,
  planetType: string,
): BiomeType {
  // Planet-type overrides
  if (planetType === 'lava') {
    // Magma lakes in the low basins; basalt/peaks elsewhere.
    if (elev < SEA_LEVEL - 0.06) return 'ocean';
    if (elev < SEA_LEVEL)        return 'shallow';
    if (elev > 0.74) return 'mountain';
    return 'volcanic';
  }
  if (planetType === 'ice') {
    // Thin cold seas only in the deepest basins; ice sheet everywhere else.
    if (elev < SEA_LEVEL - 0.22) return 'deep_ocean';
    if (elev < SEA_LEVEL - 0.16) return 'ocean';
    if (elev < SEA_LEVEL - 0.12) return 'shallow';
    if (elev > 0.65) return 'snow';
    return 'tundra';
  }
  if (planetType === 'gas')  return 'ocean'; // gas giants: banded tabletop paints over this

  if (planetType === 'desert') {
    // Almost dry — only the deepest sinks become rare oases.
    if (elev < SEA_LEVEL - 0.26) return 'ocean';
    if (elev < SEA_LEVEL - 0.20) return moist > 0.78 ? 'shallow' : 'beach';
    if (elev > 0.82) return 'mountain';
    if (moist < 0.42) return 'desert';
    // Ground soaked far past what a desert world holds on its own (long rains,
    // a sign: #111) blooms into oasis green. Under 1% of a dry world's land
    // gets there unaided.
    if (moist > 0.72) return 'grassland';
    return 'savanna';
  }

  if (planetType === 'carbon') {
    if (elev < SEA_LEVEL - 0.28) return 'deep_ocean';
    if (elev < SEA_LEVEL - 0.22) return 'ocean';
    if (elev > 0.78) return 'mountain';
    return moist > 0.50 ? 'tundra' : 'desert';
  }

  if (planetType === 'mechanical') {
    // A machine world: coolant basins, plated plains, rust flats, tower ridges.
    if (elev < SEA_LEVEL - 0.20) return 'deep_ocean';
    if (elev < SEA_LEVEL - 0.12) return 'ocean';
    if (elev < SEA_LEVEL - 0.08) return 'shallow';
    if (elev > 0.74) return 'mountain';
    if (moist < 0.22) return 'desert';
    return moist < 0.55 ? 'plains' : 'grassland';
  }

  if (planetType === 'storm') {
    if (elev < SEA_LEVEL - 0.10) return 'deep_ocean';
    if (elev < SEA_LEVEL - 0.02) return 'ocean';
    if (elev < SEA_LEVEL)        return 'shallow';
    if (elev > 0.70) return temp < 0.3 ? 'snow' : 'mountain';
    if (moist < 0.30) return 'plains';
    if (moist < 0.55) return 'grassland';
    return 'forest';
  }

  if (planetType === 'toxic') {
    // Ocean-like hydrology; green seas come from the cutaway palette.
    if (elev < SEA_LEVEL - 0.12) return 'deep_ocean';
    if (elev < SEA_LEVEL - 0.04) return 'ocean';
    if (elev < SEA_LEVEL)        return 'shallow';
    if (elev < SEA_LEVEL + 0.02) return 'beach';
    if (elev > 0.85) return 'mountain';
    if (elev > 0.75) return 'mountain';
    if (moist < 0.25) return 'savanna';
    if (moist < 0.50) return 'grassland';
    return 'jungle';
  }

  if (planetType === 'crystal') {
    // Sparse highland lakes; purple land from the palette.
    if (elev < SEA_LEVEL - 0.24) return 'deep_ocean';
    if (elev < SEA_LEVEL - 0.18) return 'ocean';
    if (elev < SEA_LEVEL - 0.14) return 'shallow';
    if (elev > 0.80) return 'mountain';
    if (elev > 0.68) return 'mountain';
    if (moist < 0.28) return 'plains';
    if (moist < 0.55) return 'grassland';
    return 'forest';
  }

  // Water bodies
  if (elev < SEA_LEVEL - 0.12) return 'deep_ocean';
  if (elev < SEA_LEVEL - 0.04) return 'ocean';
  if (elev < SEA_LEVEL)        return 'shallow';
  if (elev < SEA_LEVEL + 0.02) return 'beach';

  // High elevation
  if (elev > 0.85) return temp < 0.3 ? 'snow' : 'mountain';
  if (elev > 0.75) return 'mountain';

  // Temperature bands (poles → equator)
  if (temp < 0.18) return moist > 0.35 ? 'snow'    : 'tundra';
  if (temp < 0.35) return moist > 0.5  ? 'tundra'  : 'tundra';

  // Hot & dry → desert / savanna
  if (temp > 0.72) {
    if (moist < 0.22) return 'desert';
    if (moist < 0.48) return 'savanna';
    return 'jungle';
  }

  // Temperate
  if (moist < 0.22) return 'desert';
  if (moist < 0.40) return 'plains';
  if (moist < 0.60) return 'grassland';
  return 'forest';
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Trades and polar easterlies blow west; the westerlies blow east. +1 is east. */
function prevailingDir(row: number): number {
  const lat = Math.abs(row / (GRID_SIZE - 1) - 0.5) * 180;
  return lat < 30 || lat >= 60 ? -1 : 1;
}

/** Shallow seas stay fertile: the microbial phase spreads only in water. */
function fertilityFor(biome: BiomeType, moist: number, temp: number): number {
  if (isWater(biome)) {
    const shelf = biome === 'shallow' ? 1.0 : biome === 'ocean' ? 0.7 : 0.4;
    return Math.max(0, shelf * (0.55 + (1 - Math.abs(temp - 0.5) * 2) * 0.45));
  }
  if (isHabitable(biome)) {
    return Math.max(0, moist * 0.55 + (1 - Math.abs(temp - 0.5) * 2) * 0.35 + 0.1);
  }
  return 0;
}

/**
 * The wind climbs a slope and drops its moisture, then stays dry on the way
 * down. One lap around each latitude settles the carried dryness; the second
 * writes it. Ocean recharges the air, so the next windward coast is wet again.
 */
function layRainShadow(grid: PlanetGrid, planetType: string): void {
  const wet = planetType === 'desert' || planetType === 'lava' || planetType === 'carbon' ? 0.4
    : planetType === 'storm' ? 1.35
    : planetType === 'ice' ? 0.55
    : 1;
  for (let row = 0; row < GRID_SIZE; row++) {
    const dir = prevailingDir(row);
    const line = grid[row];
    let carried = 0;
    for (let step = 0; step < GRID_SIZE * 2; step++) {
      const col = ((dir > 0 ? step : -step) % GRID_SIZE + GRID_SIZE) % GRID_SIZE;
      const up = (col - dir + GRID_SIZE) % GRID_SIZE;
      const cell = line[col];
      const slope = cell.elevation - line[up].elevation;
      const write = step >= GRID_SIZE;
      if (cell.elevation < SEA_LEVEL) {
        carried = 0;
        continue;
      }
      if (slope > 0.004) {
        const dump = Math.min(0.45, slope * 8) * wet;
        if (write) cell.moisture = clamp01(cell.moisture + dump * (0.35 + 0.65 * (1 - carried)));
        carried = Math.min(1, carried + slope * 6);
      } else {
        if (write) {
          cell.moisture = clamp01(
            cell.moisture * (1 - 0.65 * carried * Math.min(1, wet)) - Math.max(0, -slope) * 2 * wet,
          );
        }
        carried = Math.max(0, carried * 0.985 + Math.max(0, -slope) * 1.5);
      }
    }
  }
}

/** Lift shelf of an elevation. Matches the diorama's land steps. */
function elevTier(e: number): number {
  if (e <= SEA_LEVEL) return 0;
  if (e > 0.80) return 4;
  if (e > 0.70) return 3;
  if (e > 0.62) return 2;
  if (e > 0.54) return 1;
  return 0;
}

/** Tiny deterministic tilt so a flat slope wanders instead of running straight. */
function riverJitter(row: number, col: number, dr: number, dc: number): number {
  let h = (row * 374761393 + col * 668265263 + (dr + 2) * 1274126177 + (dc + 2) * 461845907) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h >>> 0) % 1000) / 1000;
}

/**
 * Water runs downhill to the sea. A cell becomes a stream once enough land
 * drains through it, and a river once a whole basin does. Dry ground only
 * carries a channel when the flow is already a river. A lip that drops a
 * whole terrace is a waterfall.
 */
/** Worlds whose basins hold no standing water: molten, gaseous, metal, parched or frozen. */
const NO_LAKES = new Set(['lava', 'gas', 'mechanical', 'desert', 'ice']);

/**
 * Lakes (#47): water standing in basins above the sea. A priority flood from
 * the sea (and the poles) finds, for every land cell, the level water would
 * have to rise to before it could flow out; where that is above the ground
 * the cell is in a basin. Basins of a lake's size (4-400 cells) in wet enough
 * country fill to their spill level: the ground is flattened to the surface,
 * the cell is a lake, and the shore around it is a little moister (greener).
 * At most ~3% of the land, the largest basins first. Rivers then flow into
 * the lakes as into the sea.
 */
function fillLakes(grid: PlanetGrid, planetType: string): void {
  if (NO_LAKES.has(planetType)) return;
  const n = GRID_SIZE, N = n * n;
  const filled = new Float32Array(N);
  const done = new Uint8Array(N);
  // Binary min-heap of cell indices keyed on `filled`.
  const heap: number[] = [];
  const push = (i: number) => {
    heap.push(i);
    let k = heap.length - 1;
    while (k > 0) { const p = (k - 1) >> 1; if (filled[heap[p]] <= filled[heap[k]]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
  };
  const pop = (): number => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < heap.length && filled[heap[l]] < filled[heap[m]]) m = l;
        if (r < heap.length && filled[heap[r]] < filled[heap[m]]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]]; k = m;
      }
    }
    return top;
  };
  for (let i = 0; i < N; i++) {
    const row = (i / n) | 0, c = grid[row][i % n];
    if (c.elevation < SEA_LEVEL || row === 0 || row === n - 1) { filled[i] = c.elevation; done[i] = 1; push(i); }
  }
  while (heap.length) {
    const i = pop(), row = (i / n) | 0, col = i % n;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = row + dr;
      if (r < 0 || r >= n) continue;
      const j = r * n + (col + dc + n) % n;
      if (done[j]) continue;
      done[j] = 1;
      filled[j] = Math.max(grid[r][(col + dc + n) % n].elevation, filled[i]);
      push(j);
    }
  }
  // Basins: connected cells whose ground lies under their spill level.
  const basin = new Int32Array(N).fill(-1);
  const basins: Array<{ cells: number[]; level: number; moist: number }> = [];
  for (let i = 0; i < N; i++) {
    const c = grid[(i / n) | 0][i % n];
    if (basin[i] >= 0 || c.elevation < SEA_LEVEL || filled[i] - c.elevation < 0.004) continue;
    const id = basins.length, cells: number[] = [], q = [i];
    basin[i] = id;
    let moist = 0;
    while (q.length) {
      const k = q.pop()!, row = (k / n) | 0, col = k % n;
      cells.push(k); moist += grid[row][col].moisture;
      if (cells.length > 400) continue;    // too big: an inland sea, not a lake; stop growing
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const r = row + dr;
        if (r < 0 || r >= n) continue;
        const j = r * n + (col + dc + n) % n;
        if (basin[j] >= 0) continue;
        const cj = grid[r][(col + dc + n) % n];
        if (cj.elevation < SEA_LEVEL || filled[j] - cj.elevation < 0.004) continue;
        basin[j] = id; q.push(j);
      }
    }
    basins.push({ cells, level: filled[i], moist: moist / cells.length });
  }
  let land = 0;
  for (let i = 0; i < N; i++) if (grid[(i / n) | 0][i % n].elevation >= SEA_LEVEL) land++;
  let budget = Math.floor(land * 0.03);
  const lakes = basins.filter(b => b.cells.length >= 4 && b.cells.length <= 400 && b.moist >= 0.42)
    .sort((a, b) => b.cells.length - a.cells.length);
  for (const b of lakes) {
    if (b.cells.length > budget) continue;
    budget -= b.cells.length;
    for (const k of b.cells) {
      const row = (k / n) | 0, col = k % n, c = grid[row][col];
      c.elevation = b.level;
      c.lake = b.level;
      c.biome = 'lake';
      c.fertility = 0;
      // A moister, greener shore around it.
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        const r = row + dr;
        if (r < 0 || r >= n) continue;
        const s2 = grid[r][(col + dc + n) % n];
        if (s2.biome === 'lake' || s2.elevation < SEA_LEVEL) continue;
        s2.moisture = Math.min(1, s2.moisture + 0.03);
        s2.biome = classifyBiome(s2.elevation, s2.moisture, s2.temperature, planetType);
        s2.fertility = fertilityFor(s2.biome, s2.moisture, s2.temperature);
      }
    }
  }
}

function traceRivers(grid: PlanetGrid, planetType: string): void {
  if (planetType === 'lava' || planetType === 'gas') return;
  const n = GRID_SIZE;
  const at = (i: number) => grid[(i / n) | 0][i % n];
  const flow = new Int32Array(n * n).fill(-1);
  const dir = new Int8Array(n * n).fill(-1);
  const land: number[] = [];
  // (dr+1)*3+(dc+1) → RIVER_STEP index. Centre slot is unused.
  const dirIx = [7, 0, 1, 6, -1, 2, 5, 4, 3];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (grid[row][col].elevation < SEA_LEVEL || grid[row][col].biome === 'lake') continue;
      const i = row * n + col;
      land.push(i);
      let bestE = Infinity;
      let best = -1;
      let bestDir = -1;
      const here = grid[row][col].elevation;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = row + dr;
        if (rr < 0 || rr >= n) continue;
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const cc = (col + dc + n) % n;
          const trueE = grid[rr][cc].elevation;
          if (trueE >= here) continue;
          const e = trueE + (riverJitter(row, col, dr, dc) - 0.5) * 0.01;
          if (e < bestE) {
            bestE = e; best = rr * n + cc;
            bestDir = dirIx[(dr + 1) * 3 + (dc + 1)];
          }
        }
      }
      flow[i] = best;
      dir[i] = bestDir;
    }
  }
  // A shelf with no downhill step is a lake. Cut a short outlet to the
  // nearest lower ground so the water leaves — that outlet is where a
  // waterfall happens.
  const seen = new Int32Array(n * n);
  const parent = new Int32Array(n * n);
  let gen = 1;
  const pits = land.filter(i => flow[i] < 0).sort((a, b) => at(b).elevation - at(a).elevation);
  for (const pit of pits) {
    const pitE = at(pit).elevation;
    const pr = (pit / n) | 0;
    const pc = pit % n;
    gen++;
    seen[pit] = gen;
    parent[pit] = -1;
    const q = [pit];
    let found = -1;
    for (let qh = 0; qh < q.length && found < 0; qh++) {
      const cur = q[qh];
      const r = (cur / n) | 0;
      const c = cur % n;
      const cdr = Math.abs(r - pr);
      const cdc = Math.min(Math.abs(c - pc), n - Math.abs(c - pc));
      if (Math.max(cdr, cdc) >= 48) continue;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= n) continue;
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const cc = (c + dc + n) % n;
          const nb = rr * n + cc;
          if (seen[nb] === gen) continue;
          seen[nb] = gen;
          parent[nb] = cur;
          if (grid[rr][cc].elevation < pitE && grid[rr][cc].elevation >= SEA_LEVEL) {
            found = nb;
            break;
          }
          if (grid[rr][cc].elevation >= SEA_LEVEL) q.push(nb);
        }
        if (found >= 0) break;
      }
    }
    if (found < 0) continue;
    let child = found;
    let cur = parent[found];
    let guard = 0;
    while (cur >= 0 && guard++ < 96) {
      if (at(cur).elevation >= pitE) {
        let dr = ((child / n) | 0) - ((cur / n) | 0);
        let dc = (child % n) - (cur % n);
        if (dc > n / 2) dc -= n;
        if (dc < -n / 2) dc += n;
        dr = Math.sign(dr);
        dc = Math.sign(dc);
        flow[cur] = child;
        dir[cur] = dirIx[(dr + 1) * 3 + (dc + 1)];
      }
      child = cur;
      cur = parent[cur];
    }
  }
  const acc = new Float32Array(n * n);
  for (const i of land) acc[i] = 1;
  for (const i of land) {
    let f = flow[i];
    let guard = 0;
    const mark = i + 100000;
    while (f >= 0 && guard++ < 400) {
      if (seen[f] === mark) break;
      seen[f] = mark;
      if (at(f).elevation < SEA_LEVEL) break;
      acc[f] += 1;
      f = flow[f];
    }
  }
  // Only well-fed channels show: at 40 cells the board read as a crackle of
  // blue threads rather than a few rivers with their tributaries.
  const stream = planetType === 'desert' ? 160 : 90;
  const trunk = stream * 3;
  const moistGate = planetType === 'desert' ? 0.48 : 0.22;
  for (const i of land) {
    const a = acc[i];
    if (a < stream) continue;
    const cell = at(i);
    if (cell.moisture < moistGate && a < trunk) continue;
    cell.river = a >= trunk ? 1 : 0.65;
    cell.riverDir = dir[i];
  }
  // One waterfall per channel, on its biggest terrace drop. A stream that
  // never leaves a high shelf stays a stream.
  const fed = new Uint8Array(n * n);
  for (const i of land) {
    const f = flow[i];
    if (f >= 0 && at(i).river > 0) fed[f] = 1;
  }
  for (const head of land) {
    if (at(head).river <= 0 || fed[head]) continue;
    let cur = head;
    let best = -1;
    let bestDrop = 0;
    let trunk = false;
    for (let guard = 0; guard < 400 && cur >= 0 && at(cur).river > 0; guard++) {
      if (riverStrength(at(cur).river) >= 1) trunk = true;
      const down = flow[cur];
      if (down < 0) break;
      const from = elevTier(at(cur).elevation);
      const belowE = at(down).elevation;
      const to = belowE < SEA_LEVEL ? -1 : elevTier(belowE);
      const drop = from - to;
      if (from >= 1 && drop > bestDrop) {
        bestDrop = drop;
        best = cur;
      }
      if (at(down).river <= 0) break;
      cur = down;
    }
    // Not every river. The ones that do fall are spread across the land.
    if (trunk && best >= 0 && ((head * 3) >>> 0) % 4 === 0) at(best).river += 1;
  }
}

/** Grid step for `riverDir` 0–7: [dRow, dCol], N then clockwise. */
export const RIVER_STEP: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1],
];

/** Channel strength with the waterfall flag removed. 0, ~0.65, or 1. */
export function riverStrength(amount: number): number {
  if (amount <= 0) return 0;
  return amount > 1.25 ? amount - 1 : amount;
}

/** True on the lip where a channel drops a terrace. */
export function riverIsFall(amount: number): boolean {
  return amount > 1.25;
}

/**
 * Whether a pixel inside a cell sits on the water thread.
 * `fracRow` / `fracCol` are 0–1 within the cell. A trunk is wider than a stream.
 * Unknown direction paints the cell, so a map that has no sub-pixel still shows it.
 */
export function inRiverChannel(
  fracRow: number, fracCol: number, dir: number, trunk: boolean,
): boolean {
  const step = RIVER_STEP[dir];
  if (!step) return true;
  const dr = step[0], dc = step[1];
  const len = Math.hypot(dr, dc) || 1;
  const pr = fracRow - 0.5, pc = fracCol - 0.5;
  const cross = Math.abs(pr * dc - pc * dr) / len;
  return cross <= (trunk ? 0.55 : 0.40);
}

/** Seamless (column-wrapping) value noise for river meanders. [0,1). */
const MEANDER_CELLS = 64;                     // lattice cells around the planet
const MEANDER_F = MEANDER_CELLS / GRID_SIZE;  // lattice cells per grid column
function meanderNoise(row: number, col: number, salt: number): number {
  const x = col * MEANDER_F, y = row * MEANDER_F;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const h = (ix: number, iy: number) => {
    const wx = ((ix % MEANDER_CELLS) + MEANDER_CELLS) % MEANDER_CELLS;
    let v = (wx * 374761393 + iy * 668265263 + salt * 1442695041) | 0;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };
  const a = h(x0, y0), b = h(x0 + 1, y0), c = h(x0, y0 + 1), d = h(x0 + 1, y0 + 1);
  const top = a + (b - a) * ux, bot = c + (d - c) * ux;
  return top + (bot - top) * uy;
}

/** Result of {@link riverAt}. Reused between calls — copy what you keep. */
export interface RiverSample {
  /** Distance to the nearest channel centreline, in grid columns (rows squashed). */
  dist: number;
  /** Half-width of that channel, same units. 0 when no channel is near. */
  half: number;
  /** Strength of that channel: ~0.65 stream, 1 river. */
  strength: number;
  /**
   * The channel steps down a terrace on this segment or the next one — where
   * it meets a cliff that faces the camera, it falls instead of stopping.
   */
  drops: boolean;
}
const _river: RiverSample = { dist: Infinity, half: 0, strength: 0, drops: false };

/** Half-width of a channel in grid columns. Streams ~1 px at the identity view. */
export const RIVER_HALF_STREAM = 0.2;
export const RIVER_HALF_TRUNK = 0.34;

/**
 * Nearest river centreline to a FRACTIONAL grid position (cell i's centre at
 * row i, cell j's centre at col j + 0.5 — the `discToGridF` convention).
 *
 * Each channel cell owns the segment from its centre to its downstream
 * neighbour's centre, so consecutive cells join into one unbroken line no
 * matter how the pixels sample it. The position is gently warped first so
 * the 8-way flow directions meander instead of running ruler-straight.
 * `rowScale` squashes row distances to match the board's foreshortening.
 */
export function riverAt(
  grid: PlanetGrid, row: number, col: number, rowScale = 0.52,
): RiverSample {
  const n = GRID_SIZE;
  _river.dist = Infinity; _river.half = 0; _river.strength = 0; _river.drops = false;
  let ownR = -1, ownC = 0;
  const wr = row + (meanderNoise(row, col, 3) - 0.5) * 0.7;
  const wc = col + (meanderNoise(row, col, 11) - 0.5) * 0.7;
  const r0 = Math.round(wr), c0 = Math.floor(wc);
  for (let dr = -1; dr <= 1; dr++) {
    const rr = r0 + dr;
    if (rr < 0 || rr >= n) continue;
    const gRow = grid[rr];
    for (let dc = -1; dc <= 1; dc++) {
      const cu = c0 + dc;
      const cell = gRow[((cu % n) + n) % n];
      if (cell.river <= 0 || cell.riverDir < 0) continue;
      const step = RIVER_STEP[cell.riverDir];
      // Segment A→B in (col, row·rowScale) space, A at this cell's centre.
      const ax = cu + 0.5, ay = rr * rowScale;
      const ex = step[1], ey = step[0] * rowScale;
      const px = wc - ax, py = wr * rowScale - ay;
      const len2 = ex * ex + ey * ey;
      let t = (px * ex + py * ey) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = px - ex * t, qy = py - ey * t;
      const dist = Math.sqrt(qx * qx + qy * qy);
      const s = riverStrength(cell.river);
      const half = s >= 1 ? RIVER_HALF_TRUNK : RIVER_HALF_STREAM;
      // Nearest by edge, not centre: a trunk passing beside a stream wins
      // the pixels it actually covers.
      if (dist - half < _river.dist - _river.half) {
        _river.dist = dist; _river.half = half; _river.strength = s;
        ownR = rr; ownC = ((cu % n) + n) % n;
      }
    }
  }
  if (ownR >= 0) {
    // Walk two segments downstream looking for a terrace step.
    let r = ownR, c = ownC;
    for (let k = 0; k < 2 && !_river.drops; k++) {
      const a = grid[r][c];
      if (a.riverDir < 0) break;
      const st = RIVER_STEP[a.riverDir];
      const br = r + st[0];
      if (br < 0 || br >= n) break;
      const bc = (c + st[1] + n) % n;
      const b = grid[br][bc];
      if (b.elevation < SEA_LEVEL || elevTier(a.elevation) > elevTier(b.elevation)) _river.drops = true;
      r = br; c = bc;
      if (b.river <= 0) break;
    }
  }
  return _river;
}

/** Blue thread drawn over a land biome. `amount` is 0, ~0.65, or 1. */
export function tintRiver(
  r: number, g: number, b: number, amount: number,
): [number, number, number] {
  if (amount <= 0) return [r, g, b];
  const t = 0.5 + 0.35 * (amount > 1 ? 1 : amount);
  return [
    r + (58 - r) * t,
    g + (132 - g) * t,
    b + (198 - b) * t,
  ];
}

// ─── Grid generation ─────────────────────────────────────────────────────────

/**
 * Generate a full planet grid from a deterministic seed.
 * Safe to call multiple times with the same arguments — always returns
 * the identical grid.
 *
 * @param planetType  'rocky' | 'ocean' | 'gas' | 'ice' | 'lava' | wild types
 * @param seed        Numeric seed derived from starId + planetIndex
 * @param dna         Planet DNA (ocean coverage, temperature, etc.)
 */
export function generatePlanetGrid(
  planetType: string,
  seed: number,
  dna?: PlanetDNA | null,
  /** Structural recipe for the elevation field. Absent = the legacy generator. */
  archetype?: TerrainArchetype | null,
): PlanetGrid {
  // Seeds for each noise layer (all derived, never conflict)
  const elevSeed  = (seed * 1.4142135) | 0;
  const moistSeed = (seed * 2.7182818 + 9999) | 0;
  const tempSeed  = (seed * 3.1415926 + 7777) | 0;

  // DNA modifiers — convert string enums to numeric offsets
  const params = dna ? dnaToGridParams(dna) : { oceanCoverage: 0.6, tempBias: 0.0 };
  // Planet type clamps how wet the elevation field is, so desert stays dry even
  // when DNA is missing / mixed, and lava still gets magma basins.
  const typeOcean = TYPE_OCEAN_COVERAGE[planetType];
  if (typeOcean !== undefined) {
    params.oceanCoverage = Math.min(params.oceanCoverage, typeOcean);
  }
  const oceanBias = params.oceanCoverage - 0.6; // offset from default (±0.3)
  const tempBias  = params.tempBias;            // raw offset (-0.3 … +0.3)

  const grid: PlanetGrid = [];
  const shape = archetype === undefined ? structureFor(planetType, seed) : null;

  for (let row = 0; row < GRID_SIZE; row++) {
    grid[row] = [];
    const ny = row / (GRID_SIZE - 1); // 0 = north, 1 = south

    // Latitude temperature: peaks at equator (ny=0.5), cold at poles
    const latTemp = 1 - Math.abs(ny * 2 - 1);  // 0 → 1 → 0

    for (let col = 0; col < GRID_SIZE; col++) {
      const nx = col / GRID_SIZE;               // wraps (0 == 1)

      // Domain warp (playtest Oct 19: continents, mountains and isles read as
      // rounded blobs). Every layout is sampled at bent coordinates — a broad
      // swirl plus a finer one — so coasts run ragged into peninsulas and
      // bays. The bend itself wraps in x (fbmWrapX on nx), so no seam.
      const wxo = (fbmWrapX(nx * 2, ny * 2, elevSeed ^ 0x3a7, 2, nx, 4) - 0.5) * 0.32
                + (fbmWrapX(nx * 6, ny * 6, elevSeed ^ 0x5c1, 6, nx, 3) - 0.5) * 0.12
                + (fbmWrapX(nx * 16, ny * 16, elevSeed ^ 0x4e5, 16, nx, 2) - 0.5) * 0.035;
      const wyo = (fbmWrapX(nx * 2 + 7, ny * 2, elevSeed ^ 0x1f3, 2, nx, 4) - 0.5) * 0.24
                + (fbmWrapX(nx * 6 + 3, ny * 6, elevSeed ^ 0x6d9, 6, nx, 3) - 0.5) * 0.09
                + (fbmWrapX(nx * 16 + 5, ny * 16, elevSeed ^ 0x2a1, 16, nx, 2) - 0.5) * 0.03;
      const ux = (((nx + wxo) % 1) + 1) % 1;
      const uy = Math.max(0, Math.min(1, ny + wyo));

      let elev: number;
      if (archetype) elev = elevationFor(archetype, ux, uy, elevSeed);
      else if (shape === 'continents') elev = continentsElevation(ux, uy, elevSeed);
      else if (shape === 'discs') elev = discsElevation(ux, uy, elevSeed);
      else if (shape === 'archipelago' || shape === 'supercontinent' || shape === 'hemispheric') elev = elevationFor(shape, ux, uy, elevSeed);
      else if (shape === 'canyon') elev = canyonElevation(ux, uy, elevSeed);
      else elev = fbmWrapX(ux * 4, uy * 4, elevSeed, 4, ux);
      // A fine fractal fringe where land meets sea: capes, coves, skerries.
      const coast = 1 - Math.min(1, Math.abs(elev - SEA_LEVEL) / 0.06);
      if (coast > 0) elev += (fbmWrapX(nx * 24, ny * 24, elevSeed ^ 0x71d, 24, nx, 3) - 0.5) * 0.07 * coast;
      // Ridges: high ground rises in crests and chains (ridged noise) rather
      // than smooth domes; lowlands and coasts are left alone.
      const high = Math.max(0, Math.min(1, (elev - SEA_LEVEL - 0.08) / 0.14));
      if (high > 0) {
        const r = 1 - Math.abs(2 * fbmWrapX(nx * 7, ny * 7, elevSeed ^ 0x2b9, 7, nx, 4) - 1);
        elev += (r * r - 0.4) * 0.14 * high;
      }
      // Coastal fade at poles (makes ice caps at very high latitudes)
      const poleFade = Math.pow(1 - latTemp, 3) * 0.3;
      elev = Math.max(0, Math.min(1, elev - oceanBias * 0.3 + poleFade));
      if (shape === 'canyon' && elev > SEA_LEVEL + 0.12) {
        // A cracked highland. Where the world has water to give (ocean
        // coverage past ~30%: a wet rocky world, not a desert or an ice
        // world), the cracks run deeper and their floors flood into long
        // canyon seas; a barren world keeps them dry. Uniform ocean bias
        // cannot do this — the plateau sits far above the sea.
        const slot = canyonTrough(nx, ny, elevSeed);
        const wet = Math.max(0, params.oceanCoverage - 0.3);
        elev = Math.max(SEA_LEVEL + 0.06, elev - slot * 0.2);
        // Only the deepest part of a crack (its core) drops below the sea.
        const core = clamp01((slot - 0.4) / 0.6);
        if (wet > 0 && core > 0) elev = Math.min(elev, SEA_LEVEL + 0.06 - core * wet * 0.7);
      }

      // Moisture: FBM at slightly different frequency
      const moist = Math.max(0, Math.min(1,
        fbmWrapX(nx * 3 + 10, ny * 3.5, moistSeed, 3, nx)));

      // Temperature: latitude + noise + DNA bias
      const noiseTemp = fbmWrapX(nx * 2 + 20, ny * 2, tempSeed, 2, nx) * 0.25;
      const temp = Math.max(0, Math.min(1,
        latTemp * 0.65 + noiseTemp + tempBias * 0.35,
      ));

      const biome     = classifyBiome(elev, moist, temp, planetType);
      const fertility = fertilityFor(biome, moist, temp);

      grid[row][col] = {
        elevation:         elev,
        moisture:          moist,
        temperature:       temp,
        biome,
        fertility,
        lifeDensity:       0,
        dominantSpeciesId: null,
        civId:             null,
        river:             0,
        riverDir:          -1,
        burn:              0,
      };
    }
  }

  calibrateSeas(grid, planetType, params.oceanCoverage);
  layRainShadow(grid, planetType);
  for (const row of grid) {
    for (const cell of row) {
      cell.biome = classifyBiome(cell.elevation, cell.moisture, cell.temperature, planetType);
      cell.fertility = fertilityFor(cell.biome, cell.moisture, cell.temperature);
    }
  }
  fillLakes(grid, planetType);
  traceRivers(grid, planetType);

  return grid;
}

// ─── Grid utilities ───────────────────────────────────────────────────────────

/** Sample grid at normalized coordinates (u,v in 0–1, wraps horizontally) */
export function sampleGrid(grid: PlanetGrid, u: number, v: number): GridCell {
  const col = Math.round(((u % 1 + 1) % 1) * (GRID_SIZE - 1));
  const row = Math.max(0, Math.min(GRID_SIZE - 1, Math.round(v * (GRID_SIZE - 1))));
  return grid[row][col];
}

/** Count cells matching a biome type */
export function countBiome(grid: PlanetGrid, biome: BiomeType): number {
  let n = 0;
  for (const row of grid) for (const cell of row) if (cell.biome === biome) n++;
  return n;
}

/** Land fraction (0–1) */
export function landFraction(grid: PlanetGrid): number {
  let land = 0;
  for (const row of grid) for (const cell of row) if (!isWater(cell.biome)) land++;
  return land / (GRID_SIZE * GRID_SIZE);
}

/** Average fertility of land cells */
export function avgFertility(grid: PlanetGrid): number {
  let total = 0, count = 0;
  for (const row of grid) {
    for (const cell of row) {
      if (!isWater(cell.biome)) { total += cell.fertility; count++; }
    }
  }
  return count > 0 ? total / count : 0;
}

/**
 * Spread life density from high-fertility cells outward.
 * Called by EvolutionEngine each bio tick.
 * Modifies the grid in place.
 */
/**
 * How much life density one call adds, at fertility 1.
 *
 * The old coefficients (0.02 / 0.015 / 0.01) were sized as if this ran every
 * tick. It actually runs once per `EVOLUTION_TICK_RATE` (2000 ticks), so a whole
 * biology phase is only about a dozen calls — life crept up by ~0.002 per phase
 * and never became visible. Sized so a phase's worth of calls can saturate a
 * fertile cell.
 */
const SPREAD_PER_STEP = 0.38;

/**
 * A people lands on this world (BigBangEngine.relocateHome): settle `want`
 * habitable cells, starting at the most fertile one and spreading outward
 * over land (x wraps); when a landmass is full the next landing goes to the
 * most fertile cell left. Settled cells get `civId` and enough life to count
 * as settled for the life-spread pass. Returns how many cells were settled
 * (fewer than `want` on a world with little habitable land).
 */
export function seedLanding(grid: PlanetGrid, want: number, civId: string): number {
  const N = GRID_SIZE * GRID_SIZE;
  const cellOf = (i: number) => grid[(i / GRID_SIZE) | 0][i % GRID_SIZE];
  const land: number[] = [];
  for (let i = 0; i < N; i++) if (isHabitable(cellOf(i).biome)) land.push(i);
  land.sort((a, b) => cellOf(b).fertility - cellOf(a).fertility || a - b);
  const seen = new Uint8Array(N);
  let n = 0, next = 0;
  while (n < want) {
    while (next < land.length && seen[land[next]]) next++;
    if (next >= land.length) break;
    const queue = [land[next]];
    seen[land[next]] = 1;
    for (let q = 0; q < queue.length && n < want; q++) {
      const i = queue[q], cell = cellOf(i);
      cell.civId = civId;
      cell.lifeDensity = Math.max(cell.lifeDensity, 0.6);
      n++;
      const r = (i / GRID_SIZE) | 0, c = i % GRID_SIZE;
      const around = [
        r > 0 ? i - GRID_SIZE : -1,
        r < GRID_SIZE - 1 ? i + GRID_SIZE : -1,
        r * GRID_SIZE + (c + 1) % GRID_SIZE,
        r * GRID_SIZE + (c + GRID_SIZE - 1) % GRID_SIZE,
      ];
      for (const j of around) {
        if (j < 0 || seen[j] || !isHabitable(cellOf(j).biome)) continue;
        seen[j] = 1;
        queue.push(j);
      }
    }
  }
  return n;
}

export function stepLifeSpread(
  grid: PlanetGrid,
  bioPhase: string,
  spreadRate: number,   // 0–1, controlled by DNA adaptability
  activeCivId?: string | null,  // stamp on settled habitable cells when provided
): void {
  // spreadRate is a modifier, not the whole rate: at DNA adaptation 0 it is 0.1,
  // which would otherwise stall colonisation entirely.
  const rate = (0.55 + spreadRate * 0.45) * SPREAD_PER_STEP;
  if (bioPhase === 'microbial') {
    // Microbes spread only in water cells
    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        const cell = grid[row][col];
        if (isWater(cell.biome)) {
          cell.lifeDensity = Math.min(1, cell.lifeDensity + cell.fertility * rate);
        }
      }
    }
  } else if (bioPhase === 'multicellular' || bioPhase === 'complex') {
    // Coastal spread: water + adjacent land
    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        const cell = grid[row][col];
        if (cell.biome === 'shallow' || cell.biome === 'beach') {
          cell.lifeDensity = Math.min(1, cell.lifeDensity + cell.fertility * rate * 0.85);
        }
      }
    }
  } else {
    // Land colonisation — habitable cells gain density proportional to fertility
    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        const cell = grid[row][col];
        if (isHabitable(cell.biome)) {
          cell.lifeDensity = Math.min(1, cell.lifeDensity + cell.fertility * rate * 0.7);
        }
      }
    }
  }

  // Stamp civId on settled habitable cells when a civ is active
  if (activeCivId != null) {
    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        const cell = grid[row][col];
        if (isHabitable(cell.biome) && cell.lifeDensity > 0.3) {
          cell.civId = activeCivId;
        }
      }
    }
  }
}

/**
 * The face of a world: the side the planet view shows (the diorama is one
 * hemisphere, centred here) — the land cell with the most land around it,
 * kept off the poles. Pure over the grid, so the simulation can ask it too:
 * divine works fall where the god is looking (DivineWorks, #111).
 */
export function faceOf(grid: PlanetGrid): { row: number; col: number } {
  // Fixed for the life of a grid: worked out the first time it is asked for,
  // so later changes to the land (rains, life spreading) never turn the
  // world, and the view and the simulation always agree on it.
  const known = FACES.get(grid);
  if (known) return known;
  const face = computeFace(grid);
  FACES.set(grid, face);
  return face;
}
const FACES = new WeakMap<PlanetGrid, { row: number; col: number }>();

function computeFace(grid: PlanetGrid): { row: number; col: number } {
  const STRIDE = 8;
  const R = 3; // neighbourhood radius, in strided samples
  let bestScore = -1, bestRow = GRID_SIZE >> 1, bestCol = 0;
  for (let row = STRIDE * R; row < GRID_SIZE - STRIDE * R; row += STRIDE) {
    // Weight toward mid-latitudes so the face isn't centred on a polar ice cap.
    const ny = row / (GRID_SIZE - 1);
    const latWeight = 1 - Math.abs(ny - 0.5) * 1.4;
    if (latWeight <= 0) continue;
    for (let col = 0; col < GRID_SIZE; col += STRIDE) {
      let score = 0;
      for (let dr = -R; dr <= R; dr++) {
        for (let dc = -R; dc <= R; dc++) {
          const r2 = row + dr * STRIDE;
          const c2 = (col + dc * STRIDE + GRID_SIZE) % GRID_SIZE;
          const cell = grid[r2]?.[c2];
          if (!cell) continue;
          if (!isWater(cell.biome)) score += 1 + cell.fertility;
        }
      }
      score *= latWeight;
      if (score > bestScore) { bestScore = score; bestRow = row; bestCol = col; }
    }
  }
  return { row: bestRow, col: bestCol };
}

/** Great-circle angle (radians) between two cells of the world. */
export function cellAngle(a: { row: number; col: number }, b: { row: number; col: number }): number {
  const lat = (r: number) => (0.5 - r / (GRID_SIZE - 1)) * Math.PI;
  const lon = (c: number) => (c / GRID_SIZE) * Math.PI * 2;
  const p1 = lat(a.row), p2 = lat(b.row);
  const cos = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(lon(a.col) - lon(b.col));
  return Math.acos(Math.max(-1, Math.min(1, cos)));
}

/** Within this angle of the face a place shows well on the planet view (its rim is at 90 degrees). */
export const FACE_VIEW = (65 * Math.PI) / 180;
