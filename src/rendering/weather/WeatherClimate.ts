/**
 * Climate sources for the weather sim: the 256x256 planet grid collapsed onto
 * the 64x32 weather field, plus the per-world weather personality.
 *
 * Pure — no DOM. Planet type enters HERE, through TYPE_CLIMATE: the grid's
 * temperature and moisture maps do not depend on type (measured 2026-09-26:
 * identical means on ocean, ice, lava and desert for one seed).
 */
import { GRID_SIZE, isWater, SEA_LEVEL, type PlanetGrid } from '../../simulation/PlanetGrid';

export const WX_NX = 64;
export const WX_NY = 32;
export const WX_N = WX_NX * WX_NY;
/** Grid columns / rows per weather cell. */
export const CELL_COLS = GRID_SIZE / WX_NX;
export const CELL_ROWS = GRID_SIZE / WX_NY;

export interface WeatherPersonality {
  /** Multipliers on the trades, westerlies and polar easterlies. */
  bandGain: [number, number, number];
  /** Per-row phase of the band meander. */
  rowPhase: Float32Array;
  /** Mid-latitude waves around the planet, 4-7. */
  waveNumber: number;
  /** Offset into the detail-noise texture, in field cells. */
  detailOffset: number;
  /** Seed of the anomaly schedule. */
  anomalySeed: number;
}

export interface ClimateSources {
  /** Fraction of the cell that is evaporating water, 0-1. */
  water: Float32Array;
  /** Effective temperature after TYPE_CLIMATE, 0-1. */
  temp: Float32Array;
  /** Mean ground height, water counted at sea level. */
  elev: Float32Array;
  /** Land moisture x land fraction x lushness — the land's evaporation. */
  landMoist: Float32Array;
  ashEmit: Float32Array;
  smogEmit: Float32Array;
  /** 0-1. Scales convection. */
  stormPressure: number;
  /** 0-1 acid tint of cloud and rain. */
  acid: number;
  /** 0-1 emissive glow on cloud tops. */
  nebula: number;
  /**
   * How readily this world rains. 0 never (a desert). Around 1 is a normal
   * world: a few regions at a time. Above 1.5 is a rainy world, wet more often.
   */
  raininess: number;
  personality: WeatherPersonality;
  /** The world's type: picks its kinds of severe weather (WeatherEvents). */
  planetType?: string;
}

export interface ClimateInput {
  grid: PlanetGrid;
  planetType: string;
  /** genomeSeed, or the renderer's planetSeed when the planet has none. */
  seed: number;
  /** 0-1 biosphere lushness (IsoDioramaRenderer.lushFor). */
  lush: number;
  extinctionPressure: number;
  oxygenLevel: number;
  civLevel: number;
  inNebula: boolean;
}

/** Test-only switches: the controls weatherCheck runs against. */
export interface ClimateOptions {
  /** Spread every emitter's total evenly over the planet. */
  uniformEmitters?: boolean;
  /** Add a planet-wide ash source (the prototype's lava blanket). */
  ashFloor?: number;
}

interface TypeClimate {
  tScale: number; tShift: number; moist: number;
  waterEvaporates: boolean; storm: number; soot: number; nebula: number;
  /** Vapour from bare frozen land (sublimation), independent of lushness. */
  sublimation: number;
  /** Copied onto ClimateSources.raininess. */
  raininess: number;
}

export const TYPE_CLIMATE: Record<string, TypeClimate> = {
  ocean:   { tScale: 1.00, tShift: 0.00, moist: 1.0, waterEvaporates: true,  storm: 0.00, soot: 0,    nebula: 0,    sublimation: 0,    raininess: 1 },
  rocky:   { tScale: 1.00, tShift: 0.00, moist: 0.8, waterEvaporates: true,  storm: 0.00, soot: 0,    nebula: 0,    sublimation: 0,    raininess: 0.75 },
  storm:   { tScale: 1.00, tShift: 0.05, moist: 1.2, waterEvaporates: true,  storm: 0.60, soot: 0,    nebula: 0,    sublimation: 0,    raininess: 2 },
  toxic:   { tScale: 1.00, tShift: 0.05, moist: 1.0, waterEvaporates: true,  storm: 0.10, soot: 0,    nebula: 0,    sublimation: 0,    raininess: 1 },
  ice:     { tScale: 0.45, tShift: 0.00, moist: 0.6, waterEvaporates: true,  storm: 0.00, soot: 0,    nebula: 0,    sublimation: 0.12, raininess: 0.4 },
  desert:  { tScale: 0.80, tShift: 0.25, moist: 0.3, waterEvaporates: true,  storm: 0.00, soot: 0,    nebula: 0,    sublimation: 0,    raininess: 0 },
  // Magma lakes classify as water biomes. They must not evaporate water.
  lava:    { tScale: 0.50, tShift: 0.50, moist: 0.1, waterEvaporates: false, storm: 0.10, soot: 0,    nebula: 0,    sublimation: 0,    raininess: 0 },
  carbon:  { tScale: 1.00, tShift: 0.00, moist: 0.6, waterEvaporates: true,  storm: 0.00, soot: 0.02, nebula: 0,    sublimation: 0,    raininess: 0.55 },
  crystal: { tScale: 1.00, tShift: 0.00, moist: 0.8, waterEvaporates: true,  storm: 0.00, soot: 0,    nebula: 0.35, sublimation: 0,    raininess: 0.8 },
  gas:     { tScale: 1.00, tShift: 0.00, moist: 1.0, waterEvaporates: true,  storm: 0.00, soot: 0,    nebula: 0,    sublimation: 0,    raininess: 0.3 },
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** mulberry32 — small, seedable, good enough for visuals. */
export function weatherRng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashCell(r: number, c: number, seed: number): number {
  let h = (Math.imul(r, 374761393) + Math.imul(c, 668265263) + Math.imul(seed | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function personalityFor(seed: number): WeatherPersonality {
  const r = weatherRng(seed ^ 0x5eed5eed);
  const rowPhase = new Float32Array(WX_NY);
  for (let j = 0; j < WX_NY; j++) rowPhase[j] = r() * Math.PI * 2;
  return {
    bandGain: [0.75 + r() * 0.5, 0.75 + r() * 0.5, 0.75 + r() * 0.5],
    rowPhase,
    waveNumber: 4 + Math.floor(r() * 4),
    detailOffset: r() * WX_NX,
    anomalySeed: Math.floor(r() * 4294967296) >>> 0,
  };
}

/**
 * A vent: a volcanic cell on a 3x3 local peak at elevation >= 0.70, thinned by
 * hash. Same elevation rule as planVolcanoChimneys; a lava world is ~65%
 * volcanic biome, so "every volcanic cell emits" would blanket the planet.
 */
function isVent(grid: PlanetGrid, r: number, c: number, seed: number): boolean {
  const cell = grid[r][c];
  if (cell.biome !== 'volcanic' && cell.biome !== 'mountain') return false;
  if (cell.elevation < 0.70) return false;
  for (let dr = -1; dr <= 1; dr++) {
    const rr = r + dr;
    if (rr < 0 || rr >= GRID_SIZE) continue;
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const n = grid[rr][(c + dc + GRID_SIZE) % GRID_SIZE];
      if (n.elevation > cell.elevation) return false;
    }
  }
  return hashCell(r, c, seed) < 0.35;
}

export function buildClimate(input: ClimateInput, opts: ClimateOptions = {}): ClimateSources {
  const { grid, planetType } = input;
  const tc = TYPE_CLIMATE[planetType] ?? TYPE_CLIMATE.rocky;
  const water = new Float32Array(WX_N), temp = new Float32Array(WX_N);
  const elev = new Float32Array(WX_N), landMoist = new Float32Array(WX_N);
  const ashEmit = new Float32Array(WX_N), smogEmit = new Float32Array(WX_N);
  const per = CELL_COLS * CELL_ROWS;
  const lushGain = 0.3 + 0.7 * clamp01(input.lush);
  const lava = planetType === 'lava';
  for (let j = 0; j < WX_NY; j++) {
    for (let i = 0; i < WX_NX; i++) {
      let w = 0, t = 0, e = 0, m = 0, land = 0, civ = 0, vents = 0;
      for (let r = j * CELL_ROWS; r < (j + 1) * CELL_ROWS; r++) {
        for (let q = i * CELL_COLS; q < (i + 1) * CELL_COLS; q++) {
          const cell = grid[r][q];
          if (isWater(cell.biome)) w++;
          else { land++; m += cell.moisture; }
          t += cell.temperature;
          e += Math.max(SEA_LEVEL, cell.elevation);
          if (cell.civId) civ++;
          if (lava && isVent(grid, r, q, input.seed)) vents++;
        }
      }
      const k = j * WX_NX + i;
      water[k] = tc.waterEvaporates ? w / per : 0;
      temp[k] = clamp01((t / per) * tc.tScale + tc.tShift);
      elev[k] = e / per;
      landMoist[k] = (land > 0 ? (m / land) * (land / per) * tc.moist * lushGain : 0)
        + tc.sublimation * (land / per);
      ashEmit[k] = Math.min(1, vents * 0.5) + tc.soot;
      // Settlement DENSITY, not territory: squared, so dense cores emit and
      // thin borders barely do (the preview marks 40k of 65k cells as civ).
      const civFrac = civ / per;
      smogEmit[k] = input.civLevel >= 4 ? civFrac * civFrac * (input.civLevel - 3) : 0;
    }
  }
  if (opts.uniformEmitters) {
    for (const f of [ashEmit, smogEmit]) {
      const m = f.reduce((a, b) => a + b, 0) / WX_N;
      f.fill(m);
    }
  }
  if (opts.ashFloor) for (let k = 0; k < WX_N; k++) ashEmit[k] += opts.ashFloor;
  return {
    water, temp, elev, landMoist, ashEmit, smogEmit,
    stormPressure: clamp01(tc.storm + input.extinctionPressure),
    raininess: tc.raininess,
    acid: planetType === 'toxic' ? 1 : clamp01((0.42 - input.oxygenLevel) / 0.42) * 0.6,
    nebula: Math.max(tc.nebula, input.inNebula ? 1 : 0),
    personality: personalityFor(input.seed),
    planetType,
  };
}
