/**
 * Wildfire (#51): fires that start, spread and go out on the home world's
 * surface, from the state of the land itself. Nothing is scripted:
 *
 *   - FUEL is vegetation: the biome's woodiness times how much life grows there.
 *   - DRYNESS is the cell's moisture against its warmth: a hot, dry savanna
 *     burns; a wet jungle rarely does; tundra barely; snow, sand and rock never.
 *   - A spark comes from dry lightning (more where it is hot and dry), from a
 *     people's own fires once they have them (clearing land, then industry),
 *     and from lava (volcanic ground next to fuel).
 *   - A fire spreads to its neighbours by their fuel and dryness, faster
 *     downwind, and dies where the land is wet, bare or already burnt.
 *
 * What a fire leaves is a scar (`GridCell.burn`, 0..1): the ground is charred,
 * life there is cut back, and fields on it bear less (Nations reads it) until
 * the scar fades over a few generations. So a dry age with a growing people
 * brings fires, fires bring lean harvests, lean harvests bring hunger.
 *
 * Pure apart from the grid it is handed; deterministic through the SeedRNG it
 * is handed (the engine forks it). Headless.
 */
import type { SeedRNG } from '../utils/SeedRNG';
import { GRID_SIZE, isWater, type GridCell, type PlanetGrid, type BiomeType } from './PlanetGrid';

/** Ticks between spread steps of a burning fire. */
export const FIRE_STEP = 20;
/** Ticks between chances of a new spark. */
export const IGNITE_EVERY = 400;
/** Most cells burning at once (a cap on cost, never reached by a normal fire). */
export const MAX_BURNING = 4000;
/** Spread steps a cell burns before it is spent. */
const BURN_STEPS = 3;
/** Spread steps after which a fire no longer spreads (it tires before then). */
export const FIRE_TIRES = 70;

/** How woody a biome's growth is: what there is to burn per unit of life. */
const WOOD: Partial<Record<BiomeType, number>> = {
  forest: 1, jungle: 0.75, savanna: 0.85, grassland: 0.7, plains: 0.6, tundra: 0.25, beach: 0.1,
};

/** What a cell has to burn, 0..1 (less where it burnt lately). */
export function fuelOf(c: GridCell): number {
  return (WOOD[c.biome] ?? 0) * c.lifeDensity * (1 - (c.burn ?? 0));
}

/** How ready a cell is to burn, 0..1: dry and warm. */
export function drynessOf(c: GridCell): number {
  const dry = Math.max(0, 1 - c.moisture * 1.6);
  return dry * (0.35 + 0.65 * c.temperature);
}

/** The fires on a world. Saved with the engine (optional field). */
export interface FireState {
  /** Burning cells: index row * GRID_SIZE + col. */
  cells: number[];
  /** Spread steps each has left, aligned with `cells`. */
  left: number[];
  /** Prevailing wind for the fires now burning: unit grid step (row, col). */
  wind: [number, number];
  /** Cells burnt by the fire that is burning now (for news), 0 when none. */
  burnt: number;
  /** Settled cells it reached. */
  settled: number;
  /** Spread steps since it caught: a fire tires as it runs (fronts break up, fuel thins). */
  age?: number;
}

export function emptyFire(): FireState {
  return { cells: [], left: [], wind: [0, 1], burnt: 0, settled: 0, age: 0 };
}

export interface SparkContext {
  /** The world's era (0 before the first age): a people's own fires. */
  era: number;
  /** Whether life covers the land yet (no fuel before). */
  living: boolean;
}

/**
 * Maybe start a fire. Samples a handful of land cells; each may catch from
 * dry lightning, from people (settled land, more with era) or from lava next
 * to it. Returns the cell that caught, or -1.
 */
export function trySpark(st: FireState, grid: PlanetGrid, rng: SeedRNG, ctx: SparkContext): number {
  if (!ctx.living || st.cells.length >= MAX_BURNING) return -1;
  const SAMPLES = 48;
  for (let s = 0; s < SAMPLES; s++) {
    const row = 8 + rng.nextInt(0, GRID_SIZE - 17), col = rng.nextInt(0, GRID_SIZE - 1);
    const c = grid[row][col];
    const fuel = fuelOf(c);
    if (fuel < 0.2) continue;
    const dry = drynessOf(c);
    if (dry < 0.12) continue;
    // Dry lightning: a hot, parched cell under a dry sky.
    let p = 0.006 * dry * dry * fuel;
    // People: clearing land with fire, then hearths and engines.
    if (c.civId != null && ctx.era >= 1) p += 0.0015 * dry * fuel * Math.min(3, ctx.era);
    // Lava beside it.
    if (nextToVolcanic(grid, row, col)) p += 0.02 * dry;
    if (rng.next() < p) {
      const idx = row * GRID_SIZE + col;
      st.cells.push(idx); st.left.push(BURN_STEPS);
      // The wind for this fire: one of eight directions.
      const dirs: Array<[number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]];
      st.wind = dirs[rng.nextInt(0, 7)];
      st.burnt = 0; st.settled = 0; st.age = 0;
      c.burn = Math.max(c.burn ?? 0, 0.5);
      return idx;
    }
  }
  return -1;
}

function nextToVolcanic(grid: PlanetGrid, row: number, col: number): boolean {
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const r = row + dr;
    if (r < 0 || r >= GRID_SIZE) continue;
    if (grid[r][(col + dc + GRID_SIZE) % GRID_SIZE].biome === 'volcanic') return true;
  }
  return false;
}

/**
 * One spread step: every burning cell may light its neighbours (by their
 * fuel and dryness, more downwind), then burns down a step; a spent cell is
 * left scarred, its life cut back. Returns how many cells caught this step.
 */
export function stepFire(st: FireState, grid: PlanetGrid, rng: SeedRNG): number {
  if (!st.cells.length) return 0;
  const burning = new Set(st.cells);
  const nextCells: number[] = [], nextLeft: number[] = [];
  let caught = 0;
  const [wr, wc] = st.wind;
  const age = st.age = (st.age ?? 0) + 1;
  // A fire tires: fronts break up, gusts drop, the fuel left is the damp kind.
  const vigour = Math.max(0, 1 - (age / FIRE_TIRES) ** 2);
  for (let k = 0; k < st.cells.length; k++) {
    const idx = st.cells[k];
    const row = (idx / GRID_SIZE) | 0, col = idx % GRID_SIZE;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = row + dr;
      if (r < 0 || r >= GRID_SIZE) continue;
      const cc = (col + dc + GRID_SIZE) % GRID_SIZE, n = r * GRID_SIZE + cc;
      if (burning.has(n)) continue;
      const cell = grid[r][cc];
      if (isWater(cell.biome) || (cell.burn ?? 0) > 0.4) continue;
      const fuel = fuelOf(cell);
      if (fuel < 0.08) continue;
      // Downwind it runs, upwind it creeps; diagonals a little less.
      const along = (dr * wr + dc * wc) / (Math.hypot(dr, dc) || 1);
      const wind = 1 + 0.9 * along;
      const p = 0.75 * fuel * drynessOf(cell) * wind * (dr && dc ? 0.75 : 1) * vigour;
      if (rng.next() < p && burning.size < MAX_BURNING) {
        burning.add(n);
        nextCells.push(n); nextLeft.push(BURN_STEPS);
        cell.burn = Math.max(cell.burn ?? 0, 0.5);
        caught++;
      }
    }
    // This cell burns down a step; spent, it is a scar.
    const left = st.left[k] - 1;
    const cell = grid[row][col];
    if (left > 0) { nextCells.push(idx); nextLeft.push(left); }
    else {
      cell.burn = 1;
      cell.lifeDensity *= 0.15;
      st.burnt++;
      if (cell.civId != null) st.settled++;
    }
  }
  st.cells = nextCells; st.left = nextLeft;
  return caught;
}

/** Scars fade: called once a generation (EVOLUTION_TICK_RATE). */
export function healScars(grid: PlanetGrid): void {
  for (let r = 0; r < GRID_SIZE; r++) {
    const row = grid[r];
    for (let c = 0; c < GRID_SIZE; c++) {
      const b = row[c].burn;
      if (b) row[c].burn = b < 0.06 ? 0 : b * 0.82;
    }
  }
}

/** Where on the world a cell lies, in words, for the news ("the southern plains"). */
export function placeWords(grid: PlanetGrid, idx: number): string {
  const row = (idx / GRID_SIZE) | 0, col = idx % GRID_SIZE;
  const lat = row < GRID_SIZE * 0.35 ? 'northern ' : row > GRID_SIZE * 0.65 ? 'southern ' : '';
  const b = grid[row][col].biome;
  const land: Partial<Record<BiomeType, string>> = {
    forest: 'forests', jungle: 'jungles', savanna: 'savanna', grassland: 'grasslands', plains: 'plains', tundra: 'tundra',
  };
  return `the ${lat}${land[b] ?? 'wilds'}`;
}
