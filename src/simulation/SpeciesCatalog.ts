/**
 * The Species screen's catalogue (playtest Oct 20: "there is no way to tell
 * how many species the planet has, or had"): every lineage the world has
 * held, living and extinct, in words. What kind of life it is, how it stands
 * to the player's own lineage, where it came from, what became of it.
 *
 * Pure functions over gameState.playerSpecies. No DOM, nothing written.
 */
import type { SpeciesGenome } from './SpeciesGenome';
import { nicheOverlap } from './EvolutionEngine';

/** Years per engine tick (the HUD's age). */
export const YEARS_PER_TICK = 10;

export type Relation = 'yours' | 'branch' | 'ancestor' | 'predator' | 'prey' | 'rival' | 'harmless';

export const RELATION_WORDS: Record<Relation, string> = {
  yours: 'your people',
  branch: 'branched from your people',
  ancestor: 'your people\'s ancestors',
  predator: 'hunts your people',
  prey: 'your people hunt it',
  rival: 'competes with your people',
  harmless: 'no threat to your people',
};

const SIZES = ['microscopic', 'tiny', 'small', 'medium', 'large', 'massive'];
const sizeOf = (g: SpeciesGenome) => Math.max(0, SIZES.indexOf(g.physicalTraits.size));

/** What kind of life it is, in a word or two ("a grazer", "a deep-sea hunter"). */
export function kindOf(g: SpeciesGenome): string {
  const d = g.dna;
  if (g.physicalTraits.bodyStructure === 'single-celled') {
    return d.metabolism === 'photosynthetic' ? 'light-eating microbe' : d.metabolism === 'chemosynthetic' ? 'vent microbe' : 'microbe';
  }
  const where = d.environment === 'deep_sea' ? 'deep-sea ' : d.environment === 'ocean' ? 'ocean ' : d.environment === 'aerial' ? 'flying ' : d.environment === 'coastal' ? 'shore ' : '';
  const role = d.diet === 'producer' ? (d.locomotion === 'stationary' ? 'plant' : 'drifting grower')
    : d.diet === 'herbivore' ? 'grazer'
    : d.diet === 'carnivore' ? 'hunter'
    : d.diet === 'decomposer' ? 'scavenger'
    : 'forager';
  return `${where}${role}`;
}

/** Every ancestor id of `g` in the pool, nearest first. */
function ancestry(g: SpeciesGenome, byId: ReadonlyMap<string, SpeciesGenome>): string[] {
  const out: string[] = [];
  let cur = g.ancestorId;
  for (let guard = 0; cur && guard < 64; guard++) {
    out.push(cur);
    cur = byId.get(cur)?.ancestorId ?? null;
  }
  return out;
}

/** How `g` stands to the player's lineage. */
export function relationTo(g: SpeciesGenome, yours: SpeciesGenome | null, pool: readonly SpeciesGenome[]): Relation {
  if (!yours) return 'harmless';
  if (g.id === yours.id) return 'yours';
  const byId = new Map(pool.map(s => [s.id, s]));
  if (ancestry(g, byId).includes(yours.id)) return 'branch';
  if (ancestry(yours, byId).includes(g.id)) return 'ancestor';
  const sameWorld = g.dna.environment === yours.dna.environment
    || (g.dna.environment === 'coastal' || yours.dna.environment === 'coastal');
  if (sameWorld && g.dna.diet === 'carnivore' && sizeOf(g) >= sizeOf(yours)) return 'predator';
  if (sameWorld && (yours.dna.diet === 'carnivore' || yours.dna.diet === 'omnivore')
    && g.dna.diet !== 'carnivore' && g.dna.diet !== 'producer' && sizeOf(g) <= sizeOf(yours)) return 'prey';
  if (nicheOverlap(g, yours) >= 0.55) return 'rival';
  return 'harmless';
}

/** "120K years" from a span of ticks. */
export function yearsSpan(ticks: number): string {
  const y = Math.max(0, ticks) * YEARS_PER_TICK;
  return y >= 1e9 ? `${(y / 1e9).toFixed(1)}B years` : y >= 1e6 ? `${(y / 1e6).toFixed(1)}M years`
    : y >= 1e3 ? `${Math.round(y / 1e3)}K years` : `${Math.round(y)} years`;
}

/** How it died, in words ("outcompeted by the Selsul Runner"); null while it lives. */
export function deathOf(g: SpeciesGenome, pool: readonly SpeciesGenome[], yoursId: string | null): string | null {
  if (!g.isExtinct) return null;
  const e = g.extinct;
  if (!e) return 'lost before anyone kept records';
  if (e.cause === 'catastrophe') return 'lost in the dying times';
  const by = pool.find(s => s.id === e.by);
  if (!by) return 'outcompeted';
  return by.id === yoursId ? `outcompeted by your ${by.name}` : `outcompeted by the ${by.name}`;
}

export interface Census {
  living: number;
  extinct: number;
  /** Living lineages descended from the player's. */
  branches: number;
  /** Lineages the world has ever held. */
  ever: number;
}

export function censusOf(pool: readonly SpeciesGenome[], yoursId: string | null): Census {
  const byId = new Map(pool.map(s => [s.id, s]));
  let living = 0, extinct = 0, branches = 0;
  for (const s of pool) {
    if (s.isExtinct) extinct++; else living++;
    if (!s.isExtinct && yoursId && s.id !== yoursId && ancestry(s, byId).includes(yoursId)) branches++;
  }
  return { living, extinct, branches, ever: pool.length };
}

export interface CatalogRow {
  g: SpeciesGenome;
  /** Indent: 1 when listed under its living parent. */
  depth: 0 | 1;
  /** Share of the world's living population (0..1). */
  share: number;
}

/**
 * The living, in list order: the player's lineage first, then the rest by
 * population, each lineage's living branches right under it.
 */
export function livingRows(pool: readonly SpeciesGenome[], yoursId: string | null): CatalogRow[] {
  const live = pool.filter(s => !s.isExtinct);
  const total = live.reduce((a, s) => a + Math.max(0, s.population), 0) || 1;
  const liveIds = new Set(live.map(s => s.id));
  const roots = live.filter(s => !s.ancestorId || !liveIds.has(s.ancestorId))
    .sort((a, b) => (a.id === yoursId ? -1 : b.id === yoursId ? 1 : b.population - a.population));
  const out: CatalogRow[] = [];
  const placed = new Set<string>();
  const put = (s: SpeciesGenome, depth: 0 | 1) => {
    if (placed.has(s.id)) return;
    placed.add(s.id);
    out.push({ g: s, depth, share: Math.max(0, s.population) / total });
    for (const c of live.filter(k => k.ancestorId === s.id).sort((a, b) => b.population - a.population)) put(c, 1);
  };
  // The player's lineage leads even when it branched from a living parent.
  const yours = live.find(s => s.id === yoursId);
  if (yours) put(yours, 0);
  for (const r of roots) put(r, 0);
  for (const s of live) put(s, 0);
  return out;
}

/** The extinct, most recent loss first. */
export function archiveRows(pool: readonly SpeciesGenome[]): SpeciesGenome[] {
  return pool.filter(s => s.isExtinct).sort((a, b) => (b.extinct?.tick ?? -1) - (a.extinct?.tick ?? -1));
}

/** Lineages that branched from `g` (living or not). */
export function childrenOf(g: SpeciesGenome, pool: readonly SpeciesGenome[]): SpeciesGenome[] {
  return pool.filter(s => s.ancestorId === g.id);
}
