/**
 * The universe beyond the home sector: a SECTOR_GRID × SECTOR_GRID grid of
 * sectors, each holding 2–5 galaxies. The engine's own world (WORLD_SIZE
 * square, origin 0,0) is the HOME sector; the others sit around it in the same
 * world coordinates, so one camera flies across all of them.
 *
 * Everything is rolled from the master seed and the dice (never the engine's
 * RNG, so the home universe is unchanged by what lies outside it):
 *   - which sector is home — any of them, a corner on the rim or the crowded
 *     middle;
 *   - how many galaxies each sector holds (2–5); Entropy makes the cosmos
 *     lumpier (crowded sectors next to empty ones), low Entropy evens it out;
 *   - how tightly they crowd (Hostility) and how rich they are (Life).
 *
 * Only the home sector is simulated. The rest are DORMANT: real galaxies with
 * names, shapes and sizes, seen from afar until the player's people chart them.
 *
 * Pure: no engine, no DOM.
 */

import { SeedRNG } from '../utils/SeedRNG';
import { WORLD_SIZE } from '../constants';
import type { UniverseStats } from './GameState';
import type { Galaxy, GalaxyMorph } from './BigBangEngine';

export const SECTOR_GRID = 3;
export const SECTOR_SIZE = WORLD_SIZE;
export const SECTOR_COUNT = SECTOR_GRID * SECTOR_GRID;

/** A galaxy in a sector that is not simulated: art, a name and a size. */
export interface DormantGalaxy extends Galaxy {
  sector: number;
  /** How many star systems it holds (shown, not simulated). */
  systems: number;
}

export interface Sector {
  index: number;
  ix: number;
  iy: number;
  name: string;
  galaxyCount: number;
  /** World coordinates of the sector's top-left corner (home = 0,0). */
  ox: number;
  oy: number;
  home: boolean;
  /** Dormant galaxies (empty for the home sector: the engine owns those). */
  galaxies: DormantGalaxy[];
}

export interface Cosmos {
  sectors: Sector[];
  home: number;
}

export type SectorState = 'home' | 'charted' | 'glimpsed' | 'unknown';

const PREFIX = ['Orun', 'Kesh', 'Valen', 'Ithra', 'Morrow', 'Sable', 'Auren', 'Thal', 'Nyx', 'Cael', 'Vesh', 'Ombra', 'Iskar', 'Lethe', 'Corvo', 'Halcy'];
const SUFFIX = ['Reach', 'Expanse', 'Deep', 'Marches', 'Drift', 'Veil', 'Hollow', 'Verge', 'Shoals', 'Abyss', 'Strand'];
const GREEK = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Sigma', 'Omega', 'Theta', 'Kappa', 'Lambda', 'Zeta', 'Eta', 'Iota'];
const SHAPE: Record<GalaxyMorph, string> = { spiral: 'Spiral', barred: 'Barred', lenticular: 'Lenticular', elliptical: 'Elliptical', irregular: 'Irregular' };
const COLORS = ['#8ea8ff', '#ffc9a0', '#c7a0ff', '#a0ffd8', '#ffa0c8', '#ffe2a0', '#a0d8ff', '#d8ffa0'];

function rollMorph(rng: SeedRNG): GalaxyMorph {
  const r = rng.next();
  return r < 0.42 ? 'barred' : r < 0.72 ? 'spiral' : r < 0.84 ? 'lenticular' : r < 0.93 ? 'elliptical' : 'irregular';
}

/** Galaxies per sector, 2–5. Entropy widens the spread; a calm roll keeps sectors alike. */
function rollCount(rng: SeedRNG, entropy: number): number {
  const spread = 1.6 + (entropy / 20) * 2.6;
  return Math.max(2, Math.min(5, Math.round(3.5 + (rng.next() - 0.5) * spread)));
}

export function generateCosmos(seed: string, stats: UniverseStats): Cosmos {
  const rng = new SeedRNG(`${seed}_cosmos`);
  const home = rng.nextInt(0, SECTOR_COUNT - 1);
  const hix = home % SECTOR_GRID, hiy = Math.floor(home / SECTOR_GRID);
  const usedNames = new Set<string>();
  const sectors: Sector[] = [];
  for (let i = 0; i < SECTOR_COUNT; i++) {
    const ix = i % SECTOR_GRID, iy = Math.floor(i / SECTOR_GRID);
    let name = '';
    for (let t = 0; t < 20 && (!name || usedNames.has(name)); t++) name = `The ${rng.pick(PREFIX)} ${rng.pick(SUFFIX)}`;
    usedNames.add(name);
    const galaxyCount = rollCount(rng, stats.entropy);
    const sector: Sector = {
      index: i, ix, iy, name, galaxyCount,
      ox: (ix - hix) * SECTOR_SIZE, oy: (iy - hiy) * SECTOR_SIZE,
      home: i === home, galaxies: [],
    };
    if (!sector.home) sector.galaxies = placeGalaxies(sector, rng.fork(`sector_${i}`), stats);
    sectors.push(sector);
  }
  return { sectors, home };
}

/** Lay a dormant sector's galaxies on a jittered ring, as the engine does for home. */
function placeGalaxies(s: Sector, rng: SeedRNG, stats: UniverseStats): DormantGalaxy[] {
  const n = s.galaxyCount;
  const cx = s.ox + SECTOR_SIZE / 2, cy = s.oy + SECTOR_SIZE / 2;
  // Hostility crowds a sector's galaxies together; a gentle roll spreads them.
  const ringR = SECTOR_SIZE * (0.3 - (stats.hostility / 20) * 0.08) * rng.nextFloat(0.85, 1.1);
  const cap = Math.max(380, ringR * Math.sin(Math.PI / n) * 0.8);
  const out: DormantGalaxy[] = [];
  const start = rng.nextFloat(0, Math.PI * 2);
  for (let k = 0; k < n; k++) {
    const a = start + (k / n) * Math.PI * 2 + rng.nextFloat(-0.25, 0.25);
    const r = ringR * rng.nextFloat(0.75, 1.1);
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    const morph = rollMorph(rng);
    const radius = Math.min(cap, 760) * rng.nextFloat(0.62, 1.0);
    out.push({
      id: 100 + s.index * 10 + k,
      name: `${rng.pick(GREEK)} ${SHAPE[morph]} ${rng.nextInt(100, 999)}`,
      x, y, cx: x, cy: y, radius, tRadius: radius,
      color: COLORS[(s.index * 3 + k) % COLORS.length],
      tilt: rng.nextFloat(0, Math.PI),
      starIds: [],
      morph,
      armCount: morph === 'spiral' || morph === 'barred' ? rng.nextInt(2, 4) : 0,
      armPitch: rng.nextFloat(0.18, 0.42),
      barLength: morph === 'barred' ? rng.nextFloat(0.35, 0.55) : 0,
      discFlat: rng.nextFloat(0.5, 0.9),
      sector: s.index,
      systems: Math.round((9 + stats.life * 0.35) * rng.nextFloat(0.7, 1.4)),
    });
  }
  return out;
}

/** Sector index holding a world point, or -1 outside the grid. */
export function sectorAt(c: Cosmos, x: number, y: number): number {
  for (const s of c.sectors) {
    if (x >= s.ox && x < s.ox + SECTOR_SIZE && y >= s.oy && y < s.oy + SECTOR_SIZE) return s.index;
  }
  return -1;
}

/** Chebyshev distance between two sectors on the grid. */
export function sectorDistance(c: Cosmos, a: number, b: number): number {
  const A = c.sectors[a], B = c.sectors[b];
  return Math.max(Math.abs(A.ix - B.ix), Math.abs(A.iy - B.iy));
}

/**
 * What the player knows of a sector: home; charted (mapped by their people);
 * glimpsed (a neighbour, its galaxies seen as shapes); unknown (a smudge).
 */
export function sectorState(c: Cosmos, index: number, charted: readonly number[]): SectorState {
  if (index === c.home) return 'home';
  if (charted.includes(index)) return 'charted';
  return sectorDistance(c, index, c.home) <= 1 ? 'glimpsed' : 'unknown';
}

/**
 * Sectors a civilisation at `civLevel` has charted: space-age astronomy maps
 * the neighbouring sectors, an interstellar people maps the whole universe.
 * (TECH_LEVELS: 5 = Space Age, 6 = Interstellar.)
 */
export function chartedByTech(c: Cosmos, civLevel: number): number[] {
  if (civLevel >= 6) return c.sectors.filter(s => !s.home).map(s => s.index);
  if (civLevel >= 5) return c.sectors.filter(s => !s.home && sectorDistance(c, s.index, c.home) <= 1).map(s => s.index);
  return [];
}

/** All dormant galaxies, flattened. */
export function dormantGalaxies(c: Cosmos): DormantGalaxy[] {
  return c.sectors.flatMap(s => s.galaxies);
}
