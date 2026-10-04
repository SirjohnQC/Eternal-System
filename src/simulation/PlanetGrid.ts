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
  | 'mountain'   | 'volcanic';

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
};

/** Whether a biome is water (affects life spread, city placement) */
export function isWater(biome: BiomeType): boolean {
  return biome === 'deep_ocean' || biome === 'ocean' || biome === 'shallow';
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
}

export type PlanetGrid = GridCell[][];

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
    return 'savanna';
  }

  if (planetType === 'carbon') {
    if (elev < SEA_LEVEL - 0.28) return 'deep_ocean';
    if (elev < SEA_LEVEL - 0.22) return 'ocean';
    if (elev > 0.78) return 'mountain';
    return moist > 0.50 ? 'tundra' : 'desert';
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
      if (grid[row][col].elevation < SEA_LEVEL) continue;
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
  const stream = planetType === 'desert' ? 120 : 40;
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

      let elev: number;
      if (archetype) elev = elevationFor(archetype, nx, ny, elevSeed);
      else if (shape === 'continents') elev = continentsElevation(nx, ny, elevSeed);
      else if (shape === 'discs') elev = discsElevation(nx, ny, elevSeed);
      else if (shape === 'archipelago') elev = elevationFor('archipelago', nx, ny, elevSeed);
      else if (shape === 'canyon') elev = canyonElevation(nx, ny, elevSeed);
      else elev = fbmWrapX(nx * 4, ny * 4, elevSeed, 4, nx);
      // Coastal fade at poles (makes ice caps at very high latitudes)
      const poleFade = Math.pow(1 - latTemp, 3) * 0.3;
      elev = Math.max(0, Math.min(1, elev - oceanBias * 0.3 + poleFade));
      if (shape === 'canyon' && elev > SEA_LEVEL + 0.12) {
        const slot = canyonTrough(nx, ny, elevSeed);
        const cut = Math.max(SEA_LEVEL + 0.06, elev - slot * 0.2);
        elev = cut;
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
      };
    }
  }

  layRainShadow(grid, planetType);
  for (const row of grid) {
    for (const cell of row) {
      cell.biome = classifyBiome(cell.elevation, cell.moisture, cell.temperature, planetType);
      cell.fertility = fertilityFor(cell.biome, cell.moisture, cell.temperature);
    }
  }
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
