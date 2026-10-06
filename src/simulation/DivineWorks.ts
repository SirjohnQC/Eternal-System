/**
 * Divine works on the land and on life (Faith Cards of the WORLD and LIFE
 * scopes, docs/CORE_LOOP_VISION.md §10).
 *
 * These change what the world IS — rain and soil, mountains, ice, craters,
 * herds, the people's own bodies — and nothing else. The nations live on that
 * land (Nations.recompute reads fertility, biome and settlement), so whatever
 * follows a long rain or a comet emerges there: a richer harvest, a frontier
 * that now runs along a new ridge, a nation that lost its capital.
 *
 * Pure functions over a PlanetGrid and species genomes. Deterministic.
 */
import { GRID_SIZE, classifyBiome, isHabitable, isWater, type PlanetGrid, type GridCell } from './PlanetGrid';
import type { NationSystem } from './Nations';
import type { SpeciesGenome } from './SpeciesGenome';

export type WorkId =
  | 'rains' | 'drought' | 'quake' | 'volcano' | 'ice_age' | 'comet'
  | 'hardy' | 'herds' | 'murrain' | 'awaken';

/** Where a work lands: nations' lands, or a place read from the land itself. */
export type Region =
  | { kind: 'nations'; ids: number[] }
  | { kind: 'wilds' } | { kind: 'driest' } | { kind: 'wettest' } | { kind: 'coldest' } | { kind: 'planet' };

const N = GRID_SIZE * GRID_SIZE;
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const at = (grid: PlanetGrid, i: number): GridCell => grid[(i / GRID_SIZE) | 0][i % GRID_SIZE];

/** Wrapped grid distance between two cells. */
function dist(a: number, b: number): number {
  const ar = (a / GRID_SIZE) | 0, ac = a % GRID_SIZE, br = (b / GRID_SIZE) | 0, bc = b % GRID_SIZE;
  let dc = Math.abs(ac - bc); if (dc > GRID_SIZE / 2) dc = GRID_SIZE - dc;
  return Math.hypot(ar - br, dc);
}

/** Cells within `r` of `centre`, with falloff 1 at the centre, 0 at the rim. */
function disc(centre: number, r: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const cr = (centre / GRID_SIZE) | 0, cc = centre % GRID_SIZE, R = Math.ceil(r);
  for (let dr = -R; dr <= R; dr++) {
    const row = cr + dr;
    if (row < 0 || row >= GRID_SIZE) continue;
    for (let dc = -R; dc <= R; dc++) {
      const d = Math.hypot(dr, dc);
      if (d > r) continue;
      out.push([row * GRID_SIZE + ((cc + dc + GRID_SIZE) % GRID_SIZE), 1 - d / r]);
    }
  }
  return out;
}

/** The land cell that best fits `score`, sampled (every 3rd cell) for speed. */
function bestLand(grid: PlanetGrid, score: (c: GridCell) => number): number {
  let best = -1, bs = -Infinity;
  for (let i = 0; i < N; i += 3) {
    const c = at(grid, i);
    if (isWater(c.biome)) continue;
    const s = score(c);
    if (s > bs) { bs = s; best = i; }
  }
  return best;
}

/**
 * The cells a work touches, with a weight each. Nations: their whole land
 * (or, for a strike, a disc on the capital); the land's own extremes: a disc
 * around the driest / wettest / coldest / wildest place; or the whole planet.
 */
export function regionCells(grid: PlanetGrid, ns: NationSystem | null, region: Region, shape: 'land' | 'strike', extent: number): Array<[number, number]> {
  const r = shape === 'strike' ? 4 + extent * 2 : 10 + extent * 6;
  if (region.kind === 'planet') {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < N; i++) out.push([i, 1]);
    return out;
  }
  if (region.kind === 'nations') {
    if (!ns) return [];
    if (shape === 'strike') {
      return region.ids.flatMap(k => {
        const cap = ns.nations[k]?.capital;
        return cap ? disc(cap.row * GRID_SIZE + cap.col, r) : [];
      });
    }
    const out: Array<[number, number]> = [];
    const want = new Set(region.ids);
    for (let i = 0; i < N; i++) if (want.has(ns.owner[i])) out.push([i, 1]);
    return out;
  }
  const centre = region.kind === 'driest' ? bestLand(grid, c => -c.moisture + (isHabitable(c.biome) ? 0.2 : 0))
    : region.kind === 'wettest' ? bestLand(grid, c => c.moisture + (isHabitable(c.biome) ? 0.2 : 0))
    : region.kind === 'coldest' ? bestLand(grid, c => -c.temperature + (isHabitable(c.biome) ? 0.2 : 0))
    : bestLand(grid, c => (isHabitable(c.biome) && c.civId == null ? 1 : 0) + c.fertility * 0.5);
  return centre < 0 ? [] : disc(centre, r);
}

/** Reclassify a cell after its elevation, moisture or temperature changed. */
function settle(c: GridCell, planetType: string): void {
  c.biome = classifyBiome(c.elevation, c.moisture, c.temperature, planetType);
  if (!isHabitable(c.biome)) { c.fertility = 0; c.lifeDensity = 0; }
  if (isWater(c.biome)) c.civId = null;
}

/** What happened, per nation hit, for the history. */
export interface WorkReport { touched: number; nations: Map<number, number>; line: string }

/**
 * Do a work on the land. `m` is strength (~0.5..1.7), `extent` 1..3 its reach.
 * Returns which nations' land was touched (cells per nation) for the history.
 */
export function work(id: WorkId, grid: PlanetGrid, ns: NationSystem | null, region: Region, m: number, extent: number,
  planetType: string, species: SpeciesGenome[]): WorkReport {
  const hit = new Map<number, number>();
  const mark = (i: number) => { const o = ns?.owner[i] ?? -1; if (o >= 0) hit.set(o, (hit.get(o) ?? 0) + 1); };
  let touched = 0;
  const each = (cells: Array<[number, number]>, f: (c: GridCell, w: number) => void) => {
    for (const [i, w] of cells) { if (w <= 0) continue; f(at(grid, i), w); mark(i); touched++; }
  };
  switch (id) {
    case 'rains': each(regionCells(grid, ns, region, 'land', extent), (c, w) => {
      if (isWater(c.biome)) return;
      c.moisture = clamp(c.moisture + 0.12 * m * w);
      if (isHabitable(c.biome)) c.fertility = clamp(c.fertility + 0.15 * m * w);
      settle(c, planetType);
    }); break;
    case 'drought': each(regionCells(grid, ns, region, 'land', extent), (c, w) => {
      if (isWater(c.biome)) return;
      c.moisture = clamp(c.moisture - 0.14 * m * w);
      c.fertility = clamp(c.fertility - 0.18 * m * w);
      settle(c, planetType);
    }); break;
    case 'quake': {
      // The ground heaves along the frontiers (or across the region): new ridges.
      const cells = regionCells(grid, ns, region, 'land', extent);
      const own = ns?.owner;
      const edge = own && region.kind === 'nations'
        ? cells.filter(([i]) => { const c = i % GRID_SIZE, row = i - c, o = own[i];
          return own[row + (c + 1) % GRID_SIZE] !== o || own[row + (c + GRID_SIZE - 1) % GRID_SIZE] !== o
            || (i + GRID_SIZE < N && own[i + GRID_SIZE] !== o) || (i >= GRID_SIZE && own[i - GRID_SIZE] !== o); })
        : cells.filter((_, k) => k % 7 === 0);
      const ridge = new Map<number, number>();
      for (const [i] of edge) for (const [j, w] of disc(i, 1.5 + extent * 0.5)) ridge.set(j, Math.max(ridge.get(j) ?? 0, w));
      each([...ridge], (c, w) => { if (!isWater(c.biome)) { c.elevation = clamp(c.elevation + 0.14 * m * w); settle(c, planetType); } });
      break;
    }
    case 'volcano': each(regionCells(grid, ns, region, 'strike', extent), (c, w) => {
      if (w > 0.65) { c.elevation = clamp(c.elevation + 0.2 * m); c.biome = 'volcanic'; c.fertility = 0; c.lifeDensity = 0; c.civId = null; }
      else if (isHabitable(c.biome)) c.fertility = clamp(c.fertility + 0.25 * m * w);   // ash makes rich soil
    }); break;
    case 'comet': each(regionCells(grid, ns, region, 'strike', extent + 1), (c, w) => {
      c.elevation = clamp(c.elevation - 0.12 * m * w);
      c.lifeDensity = Math.max(0, c.lifeDensity - 0.9 * w);
      if (w > 0.35) c.civId = null;
      settle(c, planetType);
    }); break;
    case 'ice_age': each(regionCells(grid, ns, { kind: 'planet' }, 'land', extent), c => {
      c.temperature = clamp(c.temperature - 0.1 * m * (0.6 + 0.2 * extent));
      if (!isWater(c.biome)) settle(c, planetType);
    }); break;
    case 'hardy': each(regionCells(grid, ns, region, 'land', extent), (c, w) => {
      if (c.biome === 'tundra' || c.biome === 'desert' || c.biome === 'savanna' || c.biome === 'snow') c.fertility = clamp(c.fertility + 0.18 * m * w);
    });
      for (const sp of species) if (!sp.isExtinct) sp.dna.adaptability = Math.min(10, sp.dna.adaptability + 1);
      break;
    case 'herds': each(regionCells(grid, ns, region, 'land', extent), (c, w) => {
      if (isHabitable(c.biome)) c.lifeDensity = clamp(c.lifeDensity + 0.25 * m * w);
    }); break;
    case 'murrain': each(regionCells(grid, ns, region, 'land', extent), (c, w) => {
      c.lifeDensity = Math.max(0, c.lifeDensity - 0.4 * m * w);
    }); break;
    case 'awaken': {
      const kin = species.filter(s => !s.isExtinct).sort((a, b) => b.dna.intelligence - a.dna.intelligence)[0];
      if (kin) {
        kin.dna.intelligence = Math.min(10, kin.dna.intelligence + 1);
        kin.evolutionaryPotential.intelligenceGrowth = Math.min(1, kin.evolutionaryPotential.intelligenceGrowth + 0.1 * m);
      }
      break;
    }
  }
  return { touched, nations: hit, line: '' };
}

/** The history line for a nation whose land a work touched. */
export function workLine(id: WorkId, n: string): string {
  switch (id) {
    case 'rains': return `Long rains greened the fields of ${n}.`;
    case 'drought': return `A drought parched the land of ${n}.`;
    case 'quake': return `The earth heaved along the borders of ${n}, raising new ridges.`;
    case 'volcano': return `A mountain of fire rose in ${n}.`;
    case 'comet': return `A fire from the sky struck ${n}.`;
    case 'ice_age': return `The cold crept south and the ice over ${n} did not melt.`;
    case 'hardy': return `The people of ${n} found they could live where none had lived before.`;
    case 'herds': return `Great herds came down on the lands of ${n}.`;
    case 'murrain': return `A murrain swept the herds of ${n}.`;
    case 'awaken': return `A restless cleverness stirred in the people of ${n}.`;
  }
}

/** Share of a nation's people a work kills, per share of its land struck. */
export const WORK_TOLL: Partial<Record<WorkId, number>> = { quake: 0.15, volcano: 0.6, comet: 0.9 };
