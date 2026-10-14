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
import { GRID_SIZE, classifyBiome, isHabitable, isWater, faceOf, cellAngle, FACE_VIEW, type PlanetGrid, type GridCell } from './PlanetGrid';
import type { NationSystem } from './Nations';
import type { SpeciesGenome } from './SpeciesGenome';

export type WorkId =
  | 'rains' | 'drought' | 'quake' | 'volcano' | 'ice_age' | 'comet'
  | 'hardy' | 'herds' | 'murrain' | 'awaken'
  // The marks a sign leaves on a nation's own land (#111): every card does
  // something the player can see where it falls.
  | 'bounty' | 'wither' | 'spread';

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

const cellOf = (i: number) => ({ row: (i / GRID_SIZE) | 0, col: i % GRID_SIZE });

/**
 * The land cell that best fits `score`, sampled (every 3rd cell) for speed.
 * Ground on the world's face (the side the god watches, faceOf) is preferred:
 * a sign the player cannot see does nothing for them (#111).
 */
function bestLand(grid: PlanetGrid, score: (c: GridCell) => number, face = faceOf(grid)): number {
  let best = -1, bs = -Infinity;
  for (let i = 0; i < N; i += 3) {
    const c = at(grid, i);
    if (isWater(c.biome)) continue;
    const s = score(c) - Math.max(0, cellAngle(cellOf(i), face) - FACE_VIEW) * 4;
    if (s > bs) { bs = s; best = i; }
  }
  return best;
}

/** Where a strike on a nation falls: its capital if the god can see it, else its land nearest the face. */
function strikeCell(grid: PlanetGrid, ns: NationSystem, k: number, face: { row: number; col: number }): number {
  const cap = ns.nations[k]?.capital;
  if (cap && cellAngle(cap, face) <= FACE_VIEW) return cap.row * GRID_SIZE + cap.col;
  let best = cap ? cap.row * GRID_SIZE + cap.col : -1, ba = cap ? cellAngle(cap, face) : Infinity;
  for (let i = 0; i < N; i += 3) {
    if (ns.owner[i] !== k || isWater(at(grid, i).biome)) continue;
    const a = cellAngle(cellOf(i), face);
    if (a < ba) { ba = a; best = i; }
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
      const face = faceOf(grid);
      return region.ids.flatMap(k => {
        const at0 = strikeCell(grid, ns, k, face);
        return at0 >= 0 ? disc(at0, r) : [];
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
export interface WorkReport {
  touched: number;
  nations: Map<number, number>;
  line: string;
  /** Where it fell (the middle of the cells it changed), for the view to show it there. */
  centre: { row: number; col: number } | null;
  /** Cells whose land visibly changed: a new biome, height, life or settlement (#111). */
  changed: number;
}

/** How far a cell's water reaches up into the land around it when rains overflow it. */
const FLOOD_DEPTH = 0.035;

/** The cell (and the height) of the lowest water beside a land cell, if any. */
function waterBeside(grid: PlanetGrid, i: number): GridCell | null {
  const r = (i / GRID_SIZE) | 0, c = i % GRID_SIZE;
  let best: GridCell | null = null;
  for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const rr = r + dr;
    if (rr < 0 || rr >= GRID_SIZE) continue;
    const n = grid[rr][(c + dc + GRID_SIZE) % GRID_SIZE];
    if (isWater(n.biome) && (!best || n.elevation > best.elevation)) best = n;
  }
  return best;
}

/**
 * Do a work on the land. `m` is strength (~0.5..1.7), `extent` 1..3 its reach.
 * Returns which nations' land was touched (cells per nation) for the history.
 */
export function work(id: WorkId, grid: PlanetGrid, ns: NationSystem | null, region: Region, m: number, extent: number,
  planetType: string, species: SpeciesGenome[]): WorkReport {
  const hit = new Map<number, number>();
  const mark = (i: number) => { const o = ns?.owner[i] ?? -1; if (o >= 0) hit.set(o, (hit.get(o) ?? 0) + 1); };
  let touched = 0, changed = 0, sumR = 0, sumX = 0, sumY = 0;
  const look = (c: GridCell) => `${c.biome}|${c.elevation.toFixed(3)}|${c.lifeDensity.toFixed(2)}|${c.civId ?? ''}`;
  const each = (cells: Array<[number, number]>, f: (c: GridCell, w: number, i: number) => void) => {
    for (const [i, w] of cells) {
      if (w <= 0) continue;
      const c = at(grid, i), before = look(c);
      f(c, w, i); mark(i); touched++;
      if (look(c) !== before) {
        changed++;
        // Mean position on the wrapped grid (columns as an angle).
        const a = ((i % GRID_SIZE) / GRID_SIZE) * Math.PI * 2;
        sumR += (i / GRID_SIZE) | 0; sumX += Math.cos(a); sumY += Math.sin(a);
      }
    }
  };
  switch (id) {
    case 'rains': {
      // Long rains: the land drinks (drier biomes turn green), life spreads,
      // and where it is low beside water the water overflows onto it.
      const cells = regionCells(grid, ns, region, 'land', extent);
      each(cells, (c, w) => {
        if (isWater(c.biome)) return;
        c.moisture = clamp(c.moisture + 0.4 * m * w);
        settle(c, planetType);
        if (isHabitable(c.biome)) {
          c.fertility = clamp(c.fertility + 0.25 * m * w);
          c.lifeDensity = clamp(c.lifeDensity + 0.35 * m * w);
        }
      });
      // The overflow is decided against the shore as it was before the rain,
      // so it reaches one step inland, not across every lowland in turn.
      const floods: Array<[number, number, number]> = [];
      for (const [i, w] of cells) {
        if (w <= 0.25) continue;
        const c = at(grid, i);
        if (isWater(c.biome)) continue;
        const water = waterBeside(grid, i);
        if (water && c.elevation - water.elevation <= FLOOD_DEPTH * m * (0.5 + w)) floods.push([i, w, water.elevation]);
      }
      const level = new Map(floods.map(([i, , e]) => [i, e]));
      each(floods.map(([i, w]) => [i, w] as [number, number]), (c, _w, i) => {
        c.elevation = level.get(i)!;
        settle(c, planetType);
      });
      break;
    }
    case 'drought': each(regionCells(grid, ns, region, 'land', extent), (c, w) => {
      if (isWater(c.biome)) return;
      c.moisture = clamp(c.moisture - 0.3 * m * w);
      c.fertility = clamp(c.fertility - 0.25 * m * w);
      c.lifeDensity = Math.max(0, c.lifeDensity - 0.35 * m * w);
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
      each([...ridge], (c, w) => { if (!isWater(c.biome)) { c.elevation = clamp(c.elevation + 0.24 * m * w); settle(c, planetType); } });
      break;
    }
    case 'volcano': {
      // A mountain of fire: a cone rises around each strike, out of the sea if
      // it falls there (an island), with an open vent at its top. Ash makes
      // the ground around it rich. The view draws it as a volcano (a volcanic
      // peak in the grid), and its ash rises into the weather.
      const cells = regionCells(grid, ns, region, 'strike', extent);
      const peak = Math.min(0.95, VOLCANO_PEAK + 0.06 * m);
      each(cells, (c, w) => {
        const rise = peak * Math.pow(w, 1.35) + c.elevation * (1 - Math.pow(w, 1.35));
        if (rise > c.elevation) c.elevation = clamp(rise);
        if (w > 0.82) {
          c.biome = 'volcanic'; c.fertility = 0; c.lifeDensity = 0; c.civId = null; c.dominantSpeciesId = null;
          return;
        }
        settle(c, planetType);
        if (w < 0.6 && isHabitable(c.biome)) c.fertility = clamp(c.fertility + 0.3 * m * (1 - w));   // ash makes rich soil
      });
      break;
    }
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
      if (c.biome === 'tundra' || c.biome === 'desert' || c.biome === 'savanna' || c.biome === 'snow') {
        c.fertility = clamp(c.fertility + 0.18 * m * w);
        c.lifeDensity = clamp(c.lifeDensity + 0.3 * m * w);   // lichen, thorn and hide: life you can see
      }
    });
      for (const sp of species) if (!sp.isExtinct) sp.dna.adaptability = Math.min(10, sp.dna.adaptability + 1);
      break;
    case 'herds': each(regionCells(grid, ns, region, 'land', extent), (c, w) => {
      if (isHabitable(c.biome)) c.lifeDensity = clamp(c.lifeDensity + 0.25 * m * w);
    }); break;
    case 'murrain': each(regionCells(grid, ns, region, 'land', extent), (c, w) => {
      c.lifeDensity = Math.max(0, c.lifeDensity - 0.4 * m * w);
    }); break;
    case 'bounty': each(regionCells(grid, ns, region, 'land', extent), (c, w) => {
      // The sign's blessing shows in the fields: greener, fuller land.
      if (!isHabitable(c.biome)) return;
      c.moisture = clamp(c.moisture + 0.1 * m * w);
      settle(c, planetType);
      if (!isHabitable(c.biome)) return;
      c.fertility = clamp(c.fertility + 0.2 * m * w);
      c.lifeDensity = clamp(c.lifeDensity + 0.3 * m * w);
    }); break;
    case 'wither': each(regionCells(grid, ns, region, 'land', extent), (c, w) => {
      // Blight and fever: the land browns and empties.
      if (isWater(c.biome)) return;
      c.fertility = clamp(c.fertility - 0.25 * m * w);
      c.lifeDensity = Math.max(0, c.lifeDensity - 0.4 * m * w);
    }); break;
    case 'spread': {
      // Its people go out: new settlements on the open land along its borders
      // (the nations then claim them as they do any settled ground).
      if (!ns || region.kind !== 'nations') break;
      const want = new Set(region.ids);
      const civ = new Map<number, string>();
      const from: number[] = [];
      for (let i = 0; i < N; i++) {
        if (!want.has(ns.owner[i])) continue;
        const id = at(grid, i).civId;
        if (id != null) { from.push(i); if (!civ.has(ns.owner[i])) civ.set(ns.owner[i], id); }
      }
      const budget = Math.round(SPREAD_CELLS * m * extent);
      const seen = new Uint8Array(N);
      for (const i of from) seen[i] = 1;
      let frontier = from, made = 0;
      const out: Array<[number, number]> = [];
      for (let ring = 0; ring < 3 + extent && made < budget && frontier.length; ring++) {
        const next: number[] = [];
        for (const i of frontier) {
          const r = (i / GRID_SIZE) | 0, cc = i % GRID_SIZE;
          for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const rr = r + dr;
            if (rr < 0 || rr >= GRID_SIZE) continue;
            const j = rr * GRID_SIZE + (cc + dc + GRID_SIZE) % GRID_SIZE;
            if (seen[j]) continue;
            seen[j] = 1;
            const cell = at(grid, j);
            if (!isHabitable(cell.biome)) continue;
            next.push(j);
            if (cell.civId == null && made < budget) { out.push([j, 1]); made++; }
          }
        }
        frontier = next;
      }
      const owner0 = region.ids.find(k => civ.has(k));
      const id0 = owner0 != null ? civ.get(owner0)! : null;
      if (id0 != null) each(out, c => { c.civId = id0; c.lifeDensity = Math.max(c.lifeDensity, 0.4); });
      break;
    }
    case 'awaken': {
      const kin = species.filter(s => !s.isExtinct).sort((a, b) => b.dna.intelligence - a.dna.intelligence)[0];
      if (kin) {
        kin.dna.intelligence = Math.min(10, kin.dna.intelligence + 1);
        kin.evolutionaryPotential.intelligenceGrowth = Math.min(1, kin.evolutionaryPotential.intelligenceGrowth + 0.1 * m);
      }
      break;
    }
  }
  const centre = changed
    ? { row: Math.round(sumR / changed), col: Math.round(((Math.atan2(sumY, sumX) / (Math.PI * 2) + 1) % 1) * GRID_SIZE) % GRID_SIZE }
    : null;
  return { touched, nations: hit, line: '', centre, changed };
}

/** Height of a volcano's peak a card raises (above the 0.70 a vent needs). */
export const VOLCANO_PEAK = 0.82;
/** New settlements a "spread" mark makes per unit of strength and reach. */
const SPREAD_CELLS = 26;

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
    case 'bounty': return `The fields of ${n} grew green and heavy.`;
    case 'wither': return `The fields of ${n} browned and emptied.`;
    case 'spread': return `The people of ${n} went out and built on new ground.`;
  }
}

/** Share of a nation's people a work kills, per share of its land struck. */
export const WORK_TOLL: Partial<Record<WorkId, number>> = { quake: 0.15, volcano: 0.6, comet: 0.9 };
