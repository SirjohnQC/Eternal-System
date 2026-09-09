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

  for (let row = 0; row < GRID_SIZE; row++) {
    grid[row] = [];
    const ny = row / (GRID_SIZE - 1); // 0 = north, 1 = south

    // Latitude temperature: peaks at equator (ny=0.5), cold at poles
    const latTemp = 1 - Math.abs(ny * 2 - 1);  // 0 → 1 → 0

    for (let col = 0; col < GRID_SIZE; col++) {
      const nx = col / GRID_SIZE;               // wraps (0 == 1)

      // Elevation: FBM + ocean bias shifts effective sea level
      let elev = fbmWrapX(nx * 4, ny * 4, elevSeed, 4, nx);
      // Coastal fade at poles (makes ice caps at very high latitudes)
      const poleFade = Math.pow(1 - latTemp, 3) * 0.3;
      elev = Math.max(0, Math.min(1, elev - oceanBias * 0.3 + poleFade));

      // Moisture: FBM at slightly different frequency
      const moist = Math.max(0, Math.min(1,
        fbmWrapX(nx * 3 + 10, ny * 3.5, moistSeed, 3, nx)));

      // Temperature: latitude + noise + DNA bias
      const noiseTemp = fbmWrapX(nx * 2 + 20, ny * 2, tempSeed, 2, nx) * 0.25;
      const temp = Math.max(0, Math.min(1,
        latTemp * 0.65 + noiseTemp + tempBias * 0.35,
      ));

      const biome     = classifyBiome(elev, moist, temp, planetType);
      // Fertility is how well life grows here.
      //
      // Water used to be given 0, because `isHabitable` excludes it — but the
      // microbial phase spreads ONLY in water, multiplying by that fertility.
      // The result was that life could never leave 0 during the entire first
      // phase, and in practice `lifeDensity` stayed near zero for a whole game:
      // no vegetation response, no settlements, nothing to render or inspect.
      // Shallow seas are in reality the most productive water there is.
      let fertility: number;
      if (isWater(biome)) {
        const shelf = biome === 'shallow' ? 1.0 : biome === 'ocean' ? 0.7 : 0.4;
        fertility = Math.max(0, shelf * (0.55 + (1 - Math.abs(temp - 0.5) * 2) * 0.45));
      } else if (isHabitable(biome)) {
        fertility = Math.max(0, moist * 0.55 + (1 - Math.abs(temp - 0.5) * 2) * 0.35 + 0.1);
      } else {
        fertility = 0;   // bare mountain and volcanic rock
      }

      grid[row][col] = {
        elevation:         elev,
        moisture:          moist,
        temperature:       temp,
        biome,
        fertility,
        lifeDensity:       0,
        dominantSpeciesId: null,
        civId:             null,
      };
    }
  }

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
