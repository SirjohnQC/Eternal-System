/**
 * Which species is THE people of a world: the one that founds nations,
 * builds the towns and is drawn standing upright. One place decides it, so
 * the engine, the diorama and the portraits never disagree (rule 2).
 *
 * The most intelligent living species; among equals (evolution lets many
 * lineages reach the same mind), the one most able to build: on land, on
 * foot, of some size, then the most numerous. Pure and deterministic.
 */
import type { SpeciesGenome } from './SpeciesGenome';

const SIZE_RANK: Record<string, number> = { microscopic: 0, tiny: 1, small: 2, medium: 3, large: 4, massive: 3 };
const LOCO_RANK: Record<string, number> = { walking: 3, crawling: 1, swimming: 1, flying: 0, stationary: -2 };
const ENV_RANK: Record<string, number> = { land: 2, coastal: 2, ocean: 0, deep_sea: -1, aerial: -1 };

function buildScore(s: SpeciesGenome): number {
  return (LOCO_RANK[s.dna.locomotion] ?? 0) * 4 + (ENV_RANK[s.dna.environment] ?? 0) * 4
    + (SIZE_RANK[s.physicalTraits.size] ?? 0) * 2 + Math.min(1, Math.max(0, s.population));
}

export function peopleOf(species: readonly SpeciesGenome[], minIntelligence = 0): SpeciesGenome | null {
  let best: SpeciesGenome | null = null, bi = -1, bs = -Infinity;
  for (const s of species) {
    if (s.isExtinct || s.dna.intelligence < minIntelligence) continue;
    const i = s.dna.intelligence, sc = buildScore(s);
    if (i > bi || (i === bi && sc > bs)) { best = s; bi = i; bs = sc; }
  }
  return best;
}

/**
 * The player's people: the lineage they named and evolved, once the world is
 * civilised, else the smartest lineage (alpha playtest Oct 20: the named
 * species and the nation-builders read as two different creatures).
 */
export function playerPeopleOf(species: readonly SpeciesGenome[], signatureId: string | null, civilised: boolean): SpeciesGenome | null {
  const sig = civilised && signatureId ? species.find(s => s.id === signatureId && !s.isExtinct) : undefined;
  return sig ?? peopleOf(species, 3);
}
