/**
 * Landmarks: what a TP card leaves standing (tracker: "using TP should have a
 * direct impact on the diorama: libraries, water canals..."). Playing a card
 * raises one landmark in each nation it acts on (a granary, a library, a
 * temple, a forge, a spaceport...), near that nation's capital, and some
 * cards also mark the land itself (greener fields, new settlements, fouled
 * ground) through the same DivineWorks the Faith cards use.
 *
 * Landmarks are saved (gameState.landmarks) and drawn by the diorama with the
 * towns. Pure, deterministic (placement draws from the engine's SeedRNG).
 */
import { GRID_SIZE, isHabitable, isWater, type PlanetGrid } from './PlanetGrid';
import type { NationSystem, Nation } from './Nations';
import type { WorkId } from './DivineWorks';
import type { SeedRNG } from '../utils/SeedRNG';

export type LandmarkKind =
  | 'granary' | 'library' | 'fort' | 'temple' | 'aqueduct' | 'courthouse' | 'university'
  | 'forge' | 'hospital' | 'factory' | 'printing_house' | 'silo' | 'broadcast_tower' | 'market_hall'
  | 'missile_silo' | 'rocket_pad' | 'observatory' | 'solar_array' | 'data_center' | 'spaceport' | 'laboratory';

export interface Landmark {
  kind: LandmarkKind;
  /** The TP card that raised it. */
  card: string;
  row: number; col: number;
  /** The nation it was raised in (-1: the world). */
  nation: number;
  tick: number;
}

/** What each TP card raises (cards absent here raise nothing: Remake a World, A New World). */
export const LANDMARK_OF: Record<string, LandmarkKind> = {
  granaries: 'granary', libraries: 'library', armies: 'fort', temples: 'temple', roads: 'market_hall',
  canals: 'aqueduct', laws: 'courthouse', universities: 'university', forges: 'forge', quarantine: 'hospital',
  industry: 'factory', eureka: 'printing_house', vaccination: 'hospital', green: 'silo', propaganda: 'broadcast_tower',
  welfare: 'market_hall', deterrent: 'missile_silo', defence: 'rocket_pad', eyes: 'observatory', clean: 'solar_array',
  machines: 'data_center', fleet: 'spaceport', kinship: 'spaceport', ambassadors: 'spaceport', espionage: 'data_center',
  genes: 'laboratory', longevity: 'laboratory', seedships: 'spaceport',
};

/** The mark some cards also leave on the nations' land (DivineWorks). */
export const MARK_OF: Record<string, WorkId> = {
  granaries: 'bounty', canals: 'bounty', green: 'bounty',
  roads: 'spread',
  forges: 'wither', industry: 'wither',
};

/** For the chronicle: "{n} raised great granaries." */
export const LANDMARK_WORDS: Record<LandmarkKind, string> = {
  granary: 'raised great granaries', library: 'built its first library', fort: 'built a fortress for its standing army',
  temple: 'raised a temple city', aqueduct: 'cut great canals and aqueducts', courthouse: 'built a hall of law',
  university: 'founded a university', forge: 'fired great forges', hospital: 'built a house of healing',
  factory: 'built its first great factory', printing_house: 'set up a printing house', silo: 'raised grain silos over new fields',
  broadcast_tower: 'raised a broadcast tower', market_hall: 'built a great market hall', missile_silo: 'sank missile silos',
  rocket_pad: 'built a rocket pad', observatory: 'raised an observatory to the sky', solar_array: 'laid out solar fields',
  data_center: 'built a hall of thinking machines', spaceport: 'built a spaceport', laboratory: 'built a laboratory of life',
};

/** Cells kept between landmarks, so each stands on its own (a landmark is ~2 houses wide). */
export const LANDMARK_SPACING = 5;

/** A landmark by name, for the card detail ("Leaves standing: a library"). */
export const LANDMARK_NAMES: Record<LandmarkKind, string> = {
  granary: 'a great granary', library: 'a library', fort: 'a fortress', temple: 'a temple', aqueduct: 'an aqueduct',
  courthouse: 'a hall of law', university: 'a university', forge: 'a forge', hospital: 'a house of healing',
  factory: 'a factory', printing_house: 'a printing house', silo: 'grain silos', broadcast_tower: 'a broadcast tower',
  market_hall: 'a market hall', missile_silo: 'a missile silo', rocket_pad: 'a rocket pad', observatory: 'an observatory',
  solar_array: 'a solar field', data_center: 'a hall of thinking machines', spaceport: 'a spaceport', laboratory: 'a laboratory',
};

/** Landmarks kept at most (the oldest are let go). */
export const LANDMARKS_MAX = 120;

const idx = (r: number, c: number) => r * GRID_SIZE + c;
function dist(r1: number, c1: number, r2: number, c2: number): number {
  let dc = Math.abs(c1 - c2); if (dc > GRID_SIZE / 2) dc = GRID_SIZE - dc;
  return Math.hypot(r1 - r2, dc);
}

/**
 * Where one landmark goes in nation `n`: its own habitable land, near the
 * capital (but not on it), clear of other landmarks. Null if it has no room.
 */
export function siteFor(n: Nation, ns: NationSystem, grid: PlanetGrid, taken: readonly Landmark[], rng: SeedRNG): { row: number; col: number } | null {
  // A crowded nation still finds room, just closer to its other landmarks.
  return siteWithin(n, ns, grid, taken, rng, LANDMARK_SPACING) ?? siteWithin(n, ns, grid, taken, rng, 2);
}

function siteWithin(n: Nation, ns: NationSystem, grid: PlanetGrid, taken: readonly Landmark[], rng: SeedRNG, spacing: number): { row: number; col: number } | null {
  const cands: Array<{ row: number; col: number; d: number }> = [];
  const R = 22;
  for (let dr = -R; dr <= R; dr++) for (let dcol = -R; dcol <= R; dcol++) {
    const row = n.capital.row + dr;
    if (row < 0 || row >= GRID_SIZE) continue;
    const col = (n.capital.col + dcol + GRID_SIZE) % GRID_SIZE;
    if (ns.owner[idx(row, col)] !== n.id) continue;
    const c = grid[row][col];
    if (isWater(c.biome) || !isHabitable(c.biome)) continue;
    const d = dist(row, col, n.capital.row, n.capital.col);
    if (d < 1.5) continue;
    if (taken.some(t => dist(t.row, t.col, row, col) < spacing)) continue;
    cands.push({ row, col, d });
  }
  if (!cands.length) return null;
  // Nearest few, then a seeded pick among them: near the capital, not always the same cell.
  cands.sort((a, b) => a.d - b.d || a.row - b.row || a.col - b.col);
  const pick = cands[rng.nextInt(0, Math.min(5, cands.length) - 1)];
  return { row: pick.row, col: pick.col };
}

/**
 * Raise a card's landmarks: one per nation it acts on, or one in the largest
 * nation for an act on the whole world. Returns the new ones (the caller saves
 * them and writes the chronicle).
 */
export function raiseLandmarks(cardId: string, targets: readonly Nation[], ns: NationSystem, grid: PlanetGrid,
  existing: readonly Landmark[], rng: SeedRNG, tick: number): Landmark[] {
  const kind = LANDMARK_OF[cardId];
  if (!kind || !ns.isFounded) return [];
  const live = ns.nations.filter(n => !n.fallen);
  const out: Landmark[] = [];
  if (targets.length) {
    for (const n of targets) {
      const at = siteFor(n, ns, grid, [...existing, ...out], rng);
      if (at) out.push({ kind, card: cardId, row: at.row, col: at.col, nation: n.id, tick });
    }
    return out;
  }
  // An act on the whole world: one landmark, in the largest nation with room.
  for (const n of [...live].sort((a, b) => b.state.population - a.state.population || a.id - b.id)) {
    const at = siteFor(n, ns, grid, existing, rng);
    if (at) return [{ kind, card: cardId, row: at.row, col: at.col, nation: -1, tick }];
  }
  return out;
}
