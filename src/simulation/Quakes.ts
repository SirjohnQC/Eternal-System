/**
 * Earthquakes (#50): the home world's ground slips where its relief says it is
 * under strain. Nothing is scheduled:
 *
 *   - A FAULT is where the ground steps sharply: mountain fronts, scarps,
 *     volcanic flanks. A quake starts at the steepest of a handful of sampled
 *     land cells, and only if that step is steep enough to be a fault at all.
 *   - How often depends on how restless the world is: its Entropy roll, its
 *     own chaos (a storm-tossed world), and volcanism.
 *   - SIZE follows the real law: most quakes are small, few are large
 *     (magnitude 4..9, cubed draw).
 *   - A strong one shakes the land within reach: life there is jolted back a
 *     little, and settled land feels it (news).
 *   - A very strong one may split the land (#50): a rift opens along the
 *     fault, a narrow trench of lowered ground. Where it reaches the coast the
 *     sea comes in and an island or a new inlet is made; inland it is a rift
 *     valley. The land keeps it (saved with the surface).
 *
 * Pure apart from the grid it is handed; deterministic through the SeedRNG it
 * is handed. Headless.
 */
import type { SeedRNG } from '../utils/SeedRNG';
import { GRID_SIZE, SEA_LEVEL, classifyBiome, isHabitable, isWater, type PlanetGrid } from './PlanetGrid';

/** Ticks between chances of a quake. */
export const QUAKE_EVERY = 1000;
/** Steepest step (elevation per cell) that counts as a fault. */
const FAULT_STEP = 0.015;

/** A quake that happened, for the view (shake, dust) and the news. */
export interface Quake {
  tick: number;
  /** Epicentre cell: row * GRID_SIZE + col. */
  at: number;
  /** 4..9. */
  magnitude: number;
  /** Cells the rift lowered (empty: none opened). */
  rift: number[];
  /** Whether the sea came into the rift. */
  flooded: boolean;
  /** Settled cells within the strong shaking. */
  settled: number;
}

/** How restless a world is, 0..1, from what the simulation knows of it. */
export function restlessness(entropy: number, chaos: string | null | undefined, volcanic: boolean): number {
  const e = Math.max(0, Math.min(1, entropy / 20));
  const c = chaos === 'storm' ? 0.3 : chaos === 'turbulent' ? 0.15 : 0;
  return Math.min(1, 0.25 + e * 0.5 + c + (volcanic ? 0.2 : 0));
}

/** The steepest step from a cell to a neighbour, and which way it runs (row, col). */
function stepAt(grid: PlanetGrid, row: number, col: number): { step: number; dr: number; dc: number } {
  let best = 0, br = 0, bc = 1;
  const e = grid[row][col].elevation;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]] as const) {
    const r = row + dr;
    if (r < 0 || r >= GRID_SIZE) continue;
    const d = Math.abs(grid[r][(col + dc + GRID_SIZE) % GRID_SIZE].elevation - e);
    if (d > best) { best = d; br = dr; bc = dc; }
  }
  return { step: best, dr: br, dc: bc };
}

/**
 * Maybe a quake. `chance` is this roll's probability (from restlessness).
 * Returns it, its effects already on the grid, or null.
 */
export function tryQuake(grid: PlanetGrid, rng: SeedRNG, tick: number, chance: number, planetType: string): Quake | null {
  if (rng.next() >= chance) return null;
  return quake(grid, rng, tick, planetType);
}

/**
 * A quake now, on the steepest fault among sampled land cells (null when no
 * step is steep enough). `magnitude` forces the size (the preview and checks);
 * otherwise it is drawn: most small, few large.
 */
export function quake(grid: PlanetGrid, rng: SeedRNG, tick: number, planetType: string, magnitude?: number,
  where?: (row: number, col: number) => boolean): Quake | null {
  // The steepest of a few land cells: a fault, if it is steep enough.
  let at = -1, best = FAULT_STEP, dir = { dr: 0, dc: 1 };
  for (let s = 0; s < 40; s++) {
    const row = rng.nextInt(12, GRID_SIZE - 13), col = rng.nextInt(0, GRID_SIZE - 1);
    if (isWater(grid[row][col].biome) || (where && !where(row, col))) continue;
    const st = stepAt(grid, row, col);
    if (st.step > best) { best = st.step; at = row * GRID_SIZE + col; dir = st; }
  }
  if (at < 0) return null;
  magnitude ??= Math.round((4 + 5 * rng.next() ** 3) * 10) / 10;
  const row = (at / GRID_SIZE) | 0, col = at % GRID_SIZE;

  // Strong shaking: life jolted back, settled land counted for the news.
  let settled = 0;
  const reach = Math.max(0, Math.round((magnitude - 5.5) * 7));
  for (let dr = -reach; dr <= reach; dr++) {
    const r = row + dr;
    if (r < 0 || r >= GRID_SIZE) continue;
    for (let dc = -reach; dc <= reach; dc++) {
      if (dr * dr + dc * dc > reach * reach) continue;
      const c = grid[r][(col + dc + GRID_SIZE) % GRID_SIZE];
      if (!isHabitable(c.biome)) continue;
      c.lifeDensity *= 0.93;
      if (c.civId != null) settled++;
    }
  }

  // A great quake may split the land along its fault.
  let rift: number[] = [], flooded = false;
  if (magnitude >= 7.8 && rng.next() < 0.45) ({ rift, flooded } = openRift(grid, row, col, dir, magnitude, rng, planetType));
  return { tick, at, magnitude, rift, flooded, settled };
}

/**
 * A rift along the fault: the fault runs across the steepest step (the scarp
 * face), so the trench runs perpendicular to it, wobbling a little, as long
 * as the quake is great. Lowered ground is reclassified; below the sea it is sea.
 */
function openRift(grid: PlanetGrid, row: number, col: number, dir: { dr: number; dc: number },
  magnitude: number, rng: SeedRNG, planetType: string): { rift: number[]; flooded: boolean } {
  // Along the fault: perpendicular to the steepest step. The trench is two
  // cells wide (the second one a step across, toward the scarp).
  const ar = -dir.dc, ac = dir.dr;
  const len = Math.round(18 + (magnitude - 7.8) * 22);
  const drop = 0.1 + (magnitude - 7.8) * 0.08;
  const touched = new Set<number>();
  let flooded = false;
  const lower = (r: number, c: number, depth: number) => {
    if (r < 1 || r >= GRID_SIZE - 1) return;
    const cc = ((c % GRID_SIZE) + GRID_SIZE) % GRID_SIZE, idx = r * GRID_SIZE + cc;
    if (touched.has(idx)) return;
    touched.add(idx);
    const cell = grid[r][cc];
    if (isWater(cell.biome)) return;
    cell.elevation = Math.max(0, cell.elevation - depth);
    cell.biome = classifyBiome(cell.elevation, cell.moisture, cell.temperature, planetType);
    if (cell.elevation <= SEA_LEVEL) { flooded = true; cell.civId = null; cell.lifeDensity = 0; }
    if (!isHabitable(cell.biome)) cell.fertility = 0;
  };
  for (const sign of [1, -1]) {
    let r = row, c = col;
    for (let i = 0; i < len / 2; i++) {
      // Deepest at the epicentre, shallower toward the ends.
      const depth = drop * (1 - (2 * i) / len * 0.6);
      lower(r, c, depth);
      lower(r + dir.dr, c + dir.dc, depth * 0.7);
      r += ar * sign; c += ac * sign;
      // A fault wanders: now and then the line steps sideways.
      if (rng.next() < 0.2) { const side = rng.next() < 0.5 ? 1 : -1; r += dir.dr * side; c += dir.dc * side; }
    }
  }
  return { rift: [...touched], flooded };
}

/** "the eastern highlands": where on the world a cell lies, in words. */
export function quakePlace(grid: PlanetGrid, idx: number): string {
  const row = (idx / GRID_SIZE) | 0;
  const lat = row < GRID_SIZE * 0.35 ? 'northern ' : row > GRID_SIZE * 0.65 ? 'southern ' : '';
  const b = grid[row][idx % GRID_SIZE].biome;
  const ground = b === 'mountain' || b === 'snow' ? 'mountains' : b === 'volcanic' ? 'fire-mountains'
    : b === 'desert' ? 'deserts' : b === 'tundra' ? 'tundra' : b === 'forest' || b === 'jungle' ? 'forests' : 'lowlands';
  return `the ${lat}${ground}`;
}
