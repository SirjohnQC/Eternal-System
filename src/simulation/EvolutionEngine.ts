// src/simulation/EvolutionEngine.ts
/**
 * EvolutionEngine — heritable variation, selection, and divergence.
 *
 * ── What was wrong with the previous engine ──────────────────────────────────
 * It walked every lineage up the SAME fixed ladder with the same fixed odds:
 * stationary → swimming → crawling → walking → flying, ocean → coastal → land,
 * anaerobic → mixed → aerobic. The player's DNA biases were global, so they
 * pushed every species in the same direction at once. Population never changed,
 * so nothing was ever selected for or against, and speciation copied the parent
 * with ±1 on two stats. The inevitable result was five near-identical species
 * per planet, every game.
 *
 * ── How this one works ───────────────────────────────────────────────────────
 * 1. FOUNDING GENOME is rolled per planet, not a fixed Primordial Microbe.
 * 2. Each lineage carries a private DRIFT vector — a direction in trait space it
 *    tends to mutate along. Two sisters therefore diverge instead of converging.
 * 3. SELECTION: population is driven by how well a genome fits the planet's
 *    actual conditions. Poor fits shrink and die; good fits grow.
 * 4. NICHE COMPETITION: species occupying the same niche suppress each other,
 *    so the cheapest way to succeed is to be different. This is what actually
 *    produces radiation.
 * 5. ANOMALIES: coherence is enforced by default, but a small fraction of
 *    mutations ignore it outright, producing genuinely strange organisms that
 *    then have to survive on their own merits.
 *
 * Determinism is preserved: everything draws from the injected SeedRNG.
 */

import { SeedRNG } from '../utils/SeedRNG';
import { nameForGenome } from './SpeciesNaming';
import {
  type BranchDef, branchEffect, traitBias,
} from './DnaBranches';
import {
  SpeciesGenome, PlanetBiosphere,
  Metabolism, Locomotion, Environment, Respiration, Diet, Reproduction, SpeciesSize,
} from './SpeciesGenome';

export type EvolutionEventType = 'mutation' | 'speciation' | 'extinction' | 'anomaly';

export interface EvolutionEvent {
  type:            EvolutionEventType;
  speciesId:       string;
  speciesName:     string;
  description:     string;
  newSpeciesName?: string;
}

export interface EvolutionResult {
  updatedSpecies:   SpeciesGenome[];
  updatedBiosphere: PlanetBiosphere;
  events:           EvolutionEvent[];
}

export const EVOLUTION_TICK_RATE = 2000;

export function shouldStepEvolution(tick: number): boolean {
  return tick > 0 && tick % EVOLUTION_TICK_RATE === 0;
}

/** Ceiling on living species, to keep the sim and the renderer bounded. */
const MAX_SPECIES = 10;

// ─── Trait spaces ─────────────────────────────────────────────────────────────

const METABOLISMS:  Metabolism[]   = ['photosynthetic', 'chemosynthetic', 'heterotrophic', 'parasitic'];
const LOCOMOTIONS:  Locomotion[]   = ['stationary', 'swimming', 'crawling', 'walking', 'flying'];
const ENVIRONMENTS: Environment[]  = ['ocean', 'coastal', 'land', 'aerial', 'deep_sea'];
const REPRODUCTIONS: Reproduction[] = ['asexual', 'sexual', 'spore'];
const DIETS:        Diet[]         = ['producer', 'herbivore', 'omnivore', 'carnivore', 'decomposer'];
const RESPIRATIONS: Respiration[]  = ['anaerobic', 'aerobic', 'mixed'];
export const SIZE_ORDER: SpeciesSize[] =
  ['microscopic', 'tiny', 'small', 'medium', 'large', 'massive'];

const BODY_PLANS = [
  'single-celled', 'colonial', 'segmented', 'radial', 'shelled',
  'cartilaginous', 'vertebrate', 'exoskeletal', 'gelatinous', 'filamentous',
];
const SENSORY = [
  'chemoreception', 'photoreception', 'vision', 'compound eyes', 'echolocation',
  'electroreception', 'tactile bristles', 'thermal pits', 'magnetoreception',
];
const MOBILITY_PARTS: Record<Locomotion, string[]> = {
  stationary: ['holdfast', 'anchoring stalk', 'root mat'],
  swimming:   ['fins', 'jet siphon', 'undulating fringe', 'flagella'],
  crawling:   ['tube feet', 'muscular foot', 'many short legs'],
  walking:    ['legs', 'digitigrade limbs', 'columnar limbs'],
  flying:     ['membrane wings', 'feathered wings', 'gas bladders'],
};

function sizeIndex(sz: SpeciesSize): number {
  const i = SIZE_ORDER.indexOf(sz);
  return i < 0 ? 0 : i;
}

// ─── Coherence ────────────────────────────────────────────────────────────────

/**
 * Is this combination of traits a body that could plausibly exist?
 *
 * Used to reject nonsense by default. Anomalies deliberately bypass it — real
 * biology does throw up things that look like mistakes, and a world where those
 * never happen feels authored.
 */
export function isCoherent(g: SpeciesGenome): boolean {
  const d = g.dna;
  const si = sizeIndex(g.physicalTraits.size);

  // Photosynthesis needs light.
  if (d.metabolism === 'photosynthetic' && d.environment === 'deep_sea') return false;
  // Producers do not hunt.
  if (d.metabolism === 'photosynthetic' && (d.diet === 'carnivore' || d.diet === 'omnivore')) return false;
  // Rooted organisms are not aerial or actively predatory.
  if (d.locomotion === 'stationary' && d.environment === 'aerial') return false;
  if (d.locomotion === 'stationary' && d.diet === 'carnivore' && si > 2) return false;
  // Flight has hard mass limits.
  if (d.locomotion === 'flying' && si > 3) return false;
  // Only fliers live in open air.
  if (d.environment === 'aerial' && d.locomotion !== 'flying') return false;
  // Walking requires a body and dry ground.
  if (d.locomotion === 'walking' && (d.environment === 'ocean' || d.environment === 'deep_sea')) return false;
  if (d.locomotion === 'walking' && si < 2) return false;
  // ...and the mirror cases. Without these the engine bred land-swimmers and
  // ocean-fliers, scored them as thriving (`fitness` never reads locomotion),
  // while `archetypeFit` in SpeciesDistribution correctly gave a swimmer on
  // land 0.25 — so they held no ground and the map read as a monoculture.
  if (d.locomotion === 'swimming' && d.environment === 'land') return false;
  if (d.locomotion === 'flying' && (d.environment === 'ocean' || d.environment === 'deep_sea')) return false;
  // Single cells stay microscopic; big bodies need structure.
  if (g.physicalTraits.bodyStructure === 'single-celled' && si > 1) return false;
  if (si >= 4 && (g.physicalTraits.bodyStructure === 'single-celled' ||
                  g.physicalTraits.bodyStructure === 'filamentous')) return false;
  // Minds need brains.
  if (d.intelligence > 5 && g.physicalTraits.bodyStructure === 'single-celled') return false;
  if (d.intelligence > 3 && si === 0) return false;

  return true;
}

/** Nudge a genome back into coherence, or report that it cannot be. */
function repair(g: SpeciesGenome): boolean {
  for (let attempt = 0; attempt < 6 && !isCoherent(g); attempt++) {
    const d = g.dna;
    const si = sizeIndex(g.physicalTraits.size);

    if (d.metabolism === 'photosynthetic' && d.environment === 'deep_sea') d.environment = 'ocean';
    else if (d.metabolism === 'photosynthetic' && d.diet !== 'producer') d.diet = 'producer';
    else if (d.environment === 'aerial' && d.locomotion !== 'flying') d.environment = 'land';
    else if (d.locomotion === 'flying' && si > 3) g.physicalTraits.size = SIZE_ORDER[3];
    else if (d.locomotion === 'walking' && (d.environment === 'ocean' || d.environment === 'deep_sea')) d.environment = 'coastal';
    else if (d.locomotion === 'walking' && si < 2) g.physicalTraits.size = SIZE_ORDER[2];
    // Fix the animal, not the habitat: a lineage that reached land keeps the
    // land. Small bodies crawl, bodies with a frame walk.
    else if (d.locomotion === 'swimming' && d.environment === 'land') d.locomotion = si >= 2 ? 'walking' : 'crawling';
    else if (d.locomotion === 'flying' && (d.environment === 'ocean' || d.environment === 'deep_sea')) d.locomotion = 'swimming';
    else if (g.physicalTraits.bodyStructure === 'single-celled' && si > 1) g.physicalTraits.bodyStructure = 'colonial';
    else if (si >= 4 && (g.physicalTraits.bodyStructure === 'single-celled' ||
                         g.physicalTraits.bodyStructure === 'filamentous')) g.physicalTraits.bodyStructure = 'vertebrate';
    else if (d.intelligence > 5 && g.physicalTraits.bodyStructure === 'single-celled') g.physicalTraits.bodyStructure = 'segmented';
    else if (d.intelligence > 3 && si === 0) g.physicalTraits.size = SIZE_ORDER[1];
    else if (d.locomotion === 'stationary' && d.diet === 'carnivore' && si > 2) d.diet = 'omnivore';
    else break;
  }
  return isCoherent(g);
}

/** Keep derived descriptive traits in step with the DNA that implies them. */
function syncDescriptors(g: SpeciesGenome, rng: SeedRNG): void {
  const parts = MOBILITY_PARTS[g.dna.locomotion];
  if (parts && !parts.includes(g.physicalTraits.mobilityType)) {
    g.physicalTraits.mobilityType = parts[rng.nextInt(0, parts.length - 1)];
  }
  if (g.dna.intelligence > 6 && g.physicalTraits.sensorySystem === 'chemoreception') {
    g.physicalTraits.sensorySystem = 'vision';
  }
}

// ─── Founding genome ──────────────────────────────────────────────────────────

/**
 * Roll the first organism on a planet.
 *
 * Every world previously began with the identical hard-coded "Primordial
 * Microbe", so every biosphere started from the same point and tended to the
 * same place. First life is now itself a roll — chemistry, habitat and body plan
 * all vary — which is where divergence between playthroughs begins.
 */
export function createFoundingSpecies(tick: number, rng: SeedRNG): SpeciesGenome {
  const metabolism: Metabolism = rng.chance(0.55) ? 'chemosynthetic'
                               : rng.chance(0.7)  ? 'photosynthetic'
                               :                    'heterotrophic';
  const environment: Environment = rng.chance(0.45) ? 'deep_sea'
                                 : rng.chance(0.7)  ? 'ocean'
                                 :                    'coastal';
  const g: SpeciesGenome = {
    id:         `species_founder_${tick}_${rng.nextInt(1000, 9999)}`,
    name:       'Founding Organism',
    originTick: tick,
    population: 1.0,
    isExtinct:  false,
    ancestorId: null,
    dna: {
      metabolism,
      locomotion:   rng.chance(0.6) ? 'stationary' : 'swimming',
      environment,
      reproduction: rng.chance(0.8) ? 'asexual' : 'spore',
      diet:         metabolism === 'heterotrophic' ? 'decomposer' : 'producer',
      respiration:  rng.chance(0.75) ? 'anaerobic' : 'mixed',
      intelligence: 0,
      social:       rng.nextInt(0, 1),
      aggression:   rng.nextInt(0, 2),
      adaptability: rng.nextInt(1, 4),
    },
    physicalTraits: {
      size:          'microscopic',
      bodyStructure: rng.chance(0.75) ? 'single-celled' : 'filamentous',
      mobilityType:  'flagella',
      sensorySystem: rng.chance(0.7) ? 'chemoreception' : 'photoreception',
    },
    habitat: {
      biome:            environment === 'deep_sea' ? 'hydrothermal_vent'
                      : environment === 'coastal'  ? 'tidal_shallows' : 'open_ocean',
      temperatureRange: rng.chance(0.4) ? 'extreme_heat' : 'temperate',
    },
    evolutionaryPotential: {
      landTransition:     0,
      intelligenceGrowth: rng.nextFloat(0, 0.15),
      toolUse:            0,
    },
  };
  // The founding roll picks metabolism and habitat independently, so it could
  // birth a photosynthetic organism in the deep sea — 13.4% of 5000 seeds, a
  // plant living where no light reaches. `isCoherent` has always rejected that
  // combination; nothing was checking it here. Every later path repairs, so
  // this was the one genome that could start the whole biosphere broken.
  repair(g);
  syncDescriptors(g, rng);
  g.name = nameForGenome(g, rng);
  return g;
}

/** Seed the player's biosphere. Kept for the engine's existing call site. */
export function initPlayerSpecies(tick: number, rng?: SeedRNG): SpeciesGenome[] {
  return [createFoundingSpecies(tick, rng ?? new SeedRNG(`founder_${tick}`))];
}

// ─── Per-lineage drift ────────────────────────────────────────────────────────

/**
 * Each lineage's private direction in trait space.
 *
 * This is the single biggest reason species now diverge. Mutation picks a trait
 * weighted by this vector, so a lineage that starts drifting toward size and
 * aggression keeps doing so while its sister drifts toward intellect and
 * sociality — even under identical global conditions.
 *
 * Stored as a stable hash of the species id rather than a field, so it needs no
 * change to the genome shape and survives serialisation for free.
 */
const DRIFT_TRAITS = [
  'intelligence', 'social', 'aggression', 'adaptability', 'size',
  'locomotion', 'environment', 'metabolism', 'diet', 'respiration',
] as const;
type DriftTrait = typeof DRIFT_TRAITS[number];

function driftOf(speciesId: string): Record<DriftTrait, number> {
  let h = 2166136261;
  for (let i = 0; i < speciesId.length; i++) {
    h ^= speciesId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out = {} as Record<DriftTrait, number>;
  for (let i = 0; i < DRIFT_TRAITS.length; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    // Skewed so most traits are near-neutral and a couple dominate.
    const u = ((h >>> 0) % 1000) / 1000;
    out[DRIFT_TRAITS[i]] = u * u * 3;
  }
  return out;
}

// ─── Fitness and selection ────────────────────────────────────────────────────

/**
 * How well this genome suits the planet right now, 0–2.
 *
 * Nothing used to compute this at all: population was static, so no genome was
 * ever better or worse than another and the biosphere could not sort itself.
 */
function fitness(g: SpeciesGenome, bio: PlanetBiosphere, bioPhase: string): number {
  let f = 1;
  const d = g.dna;

  // Oxygen: aerobes need it, anaerobes are poisoned by it.
  if (d.respiration === 'aerobic')   f *= 0.45 + bio.oxygenLevel * 1.2;
  if (d.respiration === 'anaerobic') f *= 1.25 - bio.oxygenLevel * 0.75;

  // Producers underpin everything early; consumers need something to eat.
  const preyBase = bio.biosphereDensity;
  if (d.diet === 'carnivore') f *= 0.4 + preyBase * 1.3;
  if (d.diet === 'herbivore') f *= 0.55 + preyBase * 1.0;
  if (d.diet === 'producer')  f *= 1.15 - preyBase * 0.2;

  // Land is only worth colonising once there is land life to exploit.
  if (d.environment === 'land' || d.environment === 'aerial') {
    f *= 0.5 + bio.landLife * 0.9;
  } else {
    f *= 0.75 + bio.oceanLife * 0.5;
  }

  // Big bodies are expensive early and advantageous later.
  const si = sizeIndex(g.physicalTraits.size);
  const phaseIdx = ['microbial', 'multicellular', 'complex', 'primitive', 'intelligent'].indexOf(bioPhase);
  f *= 1 - Math.abs(si - phaseIdx) * 0.09;

  // Adaptability is a hedge against everything above.
  f *= 0.85 + (d.adaptability / 10) * 0.35;

  // A hostile world punishes the fragile.
  f *= 1 - bio.extinctionPressure * 0.35 * (1 - d.adaptability / 12);

  return Math.max(0.05, f);
}

/** Two species overlap when they want the same living. */
function nicheOverlap(a: SpeciesGenome, b: SpeciesGenome): number {
  let o = 0;
  if (a.dna.environment === b.dna.environment) o += 0.45;
  if (a.dna.diet === b.dna.diet)               o += 0.35;
  if (a.dna.locomotion === b.dna.locomotion)   o += 0.10;
  if (Math.abs(sizeIndex(a.physicalTraits.size) - sizeIndex(b.physicalTraits.size)) <= 1) o += 0.10;
  return o;
}

// ─── Mutation ─────────────────────────────────────────────────────────────────

function stepEnum<T>(list: T[], current: T, rng: SeedRNG): T {
  const i = list.indexOf(current);
  const candidates = list.filter((_, k) => k !== i);
  return candidates[rng.nextInt(0, candidates.length - 1)];
}

/**
 * Mutate one trait, chosen by the lineage's drift plus the player's branch bias.
 *
 * @param anomaly when true, coherence is not enforced — the organism keeps
 *   whatever strange combination it landed on.
 */
function mutate(
  g: SpeciesGenome, rng: SeedRNG, defs: BranchDef[], dnaInv: Record<string, number>,
  bioPhase: string, anomaly: boolean,
): EvolutionEvent | null {
  const drift = driftOf(g.id);

  // Weight each trait by lineage drift and the player's investments.
  const weights = DRIFT_TRAITS.map(t =>
    Math.max(0.02, drift[t] + Math.max(0, traitBias(dnaInv, defs, t)) * 1.5));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng.next() * total;
  let trait: DriftTrait = DRIFT_TRAITS[0];
  for (let i = 0; i < DRIFT_TRAITS.length; i++) {
    roll -= weights[i];
    if (roll <= 0) { trait = DRIFT_TRAITS[i]; break; }
  }

  const before = { ...g.dna, size: g.physicalTraits.size };
  const d = g.dna;

  switch (trait) {
    case 'intelligence': {
      // The ceiling follows the biology phase: a microbial world cannot host a
      // mind, and a primitive one should be able to. A flat cap made every
      // species on every planet stop at the same value.
      const PHASE_CEILING: Record<string, number> = {
        microbial: 1, multicellular: 3, complex: 6, primitive: 9, intelligent: 10,
      };
      const ceiling = (PHASE_CEILING[bioPhase] ?? 5)
                    + branchEffect(dnaInv, defs, 'intellectGrowth') * 2
                    + g.evolutionaryPotential.intelligenceGrowth * 2;
      if (d.intelligence >= Math.min(10, ceiling)) return null;
      d.intelligence = Math.min(10, d.intelligence + 1);
      if (d.intelligence > 5) {
        g.evolutionaryPotential.toolUse = Math.min(1, g.evolutionaryPotential.toolUse + 0.08);
      }
      break;
    }
    case 'social':       d.social       = Math.min(10, d.social + 1); break;
    case 'aggression':   d.aggression   = Math.max(0, Math.min(10, d.aggression + (rng.chance(0.75) ? 1 : -1))); break;
    case 'adaptability': d.adaptability = Math.max(0, Math.min(10, d.adaptability + (rng.chance(0.7) ? 1 : -1))); break;
    case 'size': {
      const up = rng.chance(0.5 + branchEffect(dnaInv, defs, 'bodySize') * 0.35);
      const si = sizeIndex(g.physicalTraits.size);
      const next = Math.max(0, Math.min(SIZE_ORDER.length - 1, si + (up ? 1 : -1)));
      g.physicalTraits.size = SIZE_ORDER[next];
      break;
    }
    case 'locomotion':  d.locomotion  = stepEnum(LOCOMOTIONS, d.locomotion, rng); break;
    case 'environment': d.environment = stepEnum(ENVIRONMENTS, d.environment, rng); break;
    case 'metabolism':  d.metabolism  = stepEnum(METABOLISMS, d.metabolism, rng); break;
    case 'diet':        d.diet        = stepEnum(DIETS, d.diet, rng); break;
    case 'respiration': d.respiration = stepEnum(RESPIRATIONS, d.respiration, rng); break;
  }

  if (!anomaly && !repair(g)) {
    // Unrepairable: revert rather than leave a broken organism standing.
    Object.assign(g.dna, {
      metabolism: before.metabolism, locomotion: before.locomotion,
      environment: before.environment, reproduction: before.reproduction,
      diet: before.diet, respiration: before.respiration,
      intelligence: before.intelligence, social: before.social,
      aggression: before.aggression, adaptability: before.adaptability,
    });
    g.physicalTraits.size = before.size;
    return null;
  }

  if (d.environment === 'land' || d.environment === 'aerial') {
    g.evolutionaryPotential.landTransition = Math.min(1, g.evolutionaryPotential.landTransition + 0.25);
  }
  syncDescriptors(g, rng);

  const oldVal = String((before as unknown as Record<string, unknown>)[trait] ?? '');
  const newVal = trait === 'size'
    ? g.physicalTraits.size
    : String((d as unknown as Record<string, unknown>)[trait]);
  if (oldVal === newVal) return null;

  // A lineage that has changed enough deserves a name that fits what it is now.
  if (trait === 'locomotion' || trait === 'environment' || trait === 'metabolism' || trait === 'size') {
    g.name = nameForGenome(g, rng);
  }

  return {
    type:        anomaly ? 'anomaly' : 'mutation',
    speciesId:   g.id,
    speciesName: g.name,
    description: anomaly
      ? `${g.name} developed something that should not work: ${trait} ${oldVal} → ${newVal}.`
      : `${g.name} evolved: ${trait} ${oldVal} → ${newVal}.`,
  };
}

// ─── Speciation ───────────────────────────────────────────────────────────────

/**
 * Split a lineage.
 *
 * The child gets a NEW id, and therefore a new drift vector, plus a couple of
 * immediate divergent mutations. Previously a child was a near-copy of its
 * parent, which is why populations stayed homogeneous.
 */
function branchSpecies(
  parent: SpeciesGenome, tick: number, rng: SeedRNG,
  defs: BranchDef[], dnaInv: Record<string, number>, bioPhase: string,
): SpeciesGenome {
  const child: SpeciesGenome = {
    ...parent,
    id:         `species_${tick}_${rng.nextInt(100000, 999999)}`,
    name:       parent.name,
    originTick: tick,
    population: Math.max(0.22, Math.min(0.45, parent.population * 0.45)),
    isExtinct:  false,
    ancestorId: parent.id,
    dna:        { ...parent.dna },
    physicalTraits: { ...parent.physicalTraits },
    habitat:    { ...parent.habitat },
    evolutionaryPotential: { ...parent.evolutionaryPotential },
  };

  // Immediate divergence, so sisters are visibly different from birth.
  const jumps = 1 + rng.nextInt(0, 2);
  for (let i = 0; i < jumps; i++) {
    mutate(child, rng, defs, dnaInv, bioPhase, false);
  }
  if (rng.chance(0.35)) {
    child.physicalTraits.bodyStructure = BODY_PLANS[rng.nextInt(0, BODY_PLANS.length - 1)];
    repair(child);
  }
  if (rng.chance(0.3)) {
    child.physicalTraits.sensorySystem = SENSORY[rng.nextInt(0, SENSORY.length - 1)];
  }

  child.name = nameForGenome(child, rng);
  return child;
}

// ─── Biosphere ────────────────────────────────────────────────────────────────

function updateBiosphere(
  species: SpeciesGenome[], bio: PlanetBiosphere, bioPhase: string,
): PlanetBiosphere {
  const active = species.filter(s => !s.isExtinct);
  const photo   = active.filter(s => s.dna.metabolism  === 'photosynthetic').length;
  const aerobic = active.filter(s => s.dna.respiration === 'aerobic').length;
  const land    = active.filter(s => s.dna.environment === 'land' || s.dna.environment === 'coastal' || s.dna.environment === 'aerial').length;
  const ocean   = active.filter(s => s.dna.environment === 'ocean' || s.dna.environment === 'deep_sea').length;
  const totalPop = active.reduce((sum, s) => sum + s.population, 0);
  const avgAgg = active.length > 0
    ? active.reduce((sum, s) => sum + s.dna.aggression, 0) / active.length : 0;

  const density = Math.min(1, totalPop * 0.3 + (bioPhase === 'primitive' || bioPhase === 'intelligent' ? 0.3 : 0));

  return {
    oxygenLevel:        Math.min(1, bio.oxygenLevel + photo * 0.004 + aerobic * 0.001),
    biosphereDensity:   density,
    oceanLife:          Math.min(1, bio.oceanLife + ocean * 0.012),
    landLife:           Math.min(1, bio.landLife  + land  * 0.012),
    biodiversity:       Math.min(10, active.length),
    extinctionPressure: Math.max(0, Math.min(1,
      bio.extinctionPressure * 0.985 + avgAgg * 0.006 - density * 0.004)),
  };
}

// ─── Main step ────────────────────────────────────────────────────────────────

/**
 * Advance the biosphere by one evolution step.
 *
 * @param defs   this universe's DNA branch definitions
 * @param dnaInv the player's investment in those branches
 */
export function stepEvolution(
  bioPhase:  string,
  dnaInv:    Record<string, number>,
  species:   SpeciesGenome[],
  biosphere: PlanetBiosphere,
  rng:       SeedRNG,
  tick:      number,
  defs:      BranchDef[] = [],
): EvolutionResult {
  const events: EvolutionEvent[] = [];
  const pool = species.map(s => ({
    ...s,
    dna: { ...s.dna },
    physicalTraits: { ...s.physicalTraits },
    habitat: { ...s.habitat },
    evolutionaryPotential: { ...s.evolutionaryPotential },
  }));
  const live = () => pool.filter(s => !s.isExtinct);

  // ── 1. Selection ──────────────────────────────────────────────────────────
  const active = live();
  for (const sp of active) {
    const f = fitness(sp, biosphere, bioPhase);

    // Competition from anyone sharing this way of life. Averaged rather than
    // summed: summing meant every species shrank as soon as the planet held a
    // few of them, so biospheres thrashed between mass extinction and refill
    // (133 speciations against 128 extinctions in one measured run).
    let pressure = 0;
    for (const other of active) {
      if (other.id === sp.id) continue;
      pressure += nicheOverlap(sp, other) * other.population;
    }
    if (active.length > 1) pressure /= (active.length - 1);

    const growth = (f - 0.78) * 0.14 - pressure * 0.05;
    sp.population = Math.max(0, Math.min(1.4, sp.population + growth));
  }

  // Normalise so total population stays bounded and relative dominance is real.
  const total = live().reduce((s, x) => s + x.population, 0);
  if (total > 1.6) for (const sp of live()) sp.population *= 1.6 / total;

  // ── 2. Extinction ─────────────────────────────────────────────────────────
  for (const sp of live()) {
    const doomed = sp.population < 0.02
      || (biosphere.extinctionPressure > 0.8 && rng.chance(0.02 * (1 - sp.dna.adaptability / 14)));
    // Never drop below two lineages on a living world: a planet that keeps
    // collapsing to a single species has no ecology to look at.
    if (doomed && live().length > 2) {
      sp.isExtinct = true;
      events.push({
        type: 'extinction', speciesId: sp.id, speciesName: sp.name,
        description: `${sp.name} has gone extinct.`,
      });
    }
  }

  // ── 3. Mutation ───────────────────────────────────────────────────────────
  const mutability = 0.30 + branchEffect(dnaInv, defs, 'mutability') * 0.5;
  for (const sp of live()) {
    const chance = mutability * (0.5 + sp.dna.adaptability / 12);
    if (!rng.chance(chance)) continue;
    // Roughly one mutation in thirty ignores coherence entirely. Anomalies are
    // permanent — nothing repairs them later — so they accumulate, and a higher
    // rate turns the whole biosphere into oddities rather than a few.
    const anomaly = rng.chance(0.033);
    const evt = mutate(sp, rng, defs, dnaInv, bioPhase, anomaly);
    if (evt) events.push(evt);
  }

  // ── 4. Speciation ─────────────────────────────────────────────────────────
  // At most one split per step. Allowing every lineage to split every step
  // produced churn rather than radiation.
  const divergence = 0.07 + branchEffect(dnaInv, defs, 'divergence') * 0.16;
  if (live().length < MAX_SPECIES) {
    const candidates = live().filter(sp => sp.population > 0.18);
    if (candidates.length > 0) {
      const sp = candidates[rng.nextInt(0, candidates.length - 1)];
      // Successful, adaptable lineages radiate; struggling ones do not.
      const chance = divergence * sp.population * (0.5 + sp.dna.adaptability / 12);
      if (rng.chance(chance)) {

      const child = branchSpecies(sp, tick, rng, defs, dnaInv, bioPhase);
      sp.population = Math.max(0.15, sp.population - child.population * 0.4);
      pool.push(child);
      events.push({
        type: 'speciation', speciesId: sp.id, speciesName: sp.name,
        description: `${sp.name} diverged into ${child.name}.`,
        newSpeciesName: child.name,
      });
      }
    }
  }

  return {
    updatedSpecies:   pool,
    updatedBiosphere: updateBiosphere(pool, biosphere, bioPhase),
    events,
  };
}

/**
 * Force an immediate mutation on the most-populous species.
 * Used by the player's Nudge Evolution action, which must always do something.
 */
export function applyNudgeMutation(
  bioPhase:  string,
  dnaInv:    Record<string, number>,
  species:   SpeciesGenome[],
  biosphere: PlanetBiosphere,
  rng:       SeedRNG,
  _tick:     number,
  defs:      BranchDef[] = [],
): EvolutionResult {
  const pool = species.map(s => ({
    ...s,
    dna: { ...s.dna },
    physicalTraits: { ...s.physicalTraits },
    habitat: { ...s.habitat },
    evolutionaryPotential: { ...s.evolutionaryPotential },
  }));
  const active = pool.filter(s => !s.isExtinct);
  if (active.length === 0) {
    return { updatedSpecies: pool, updatedBiosphere: biosphere, events: [] };
  }

  active.sort((a, b) => b.population - a.population);
  const target = active[0];

  // Try a few times — a nudge that silently does nothing feels broken.
  let evt: EvolutionEvent | null = null;
  for (let i = 0; i < 8 && !evt; i++) {
    evt = mutate(target, rng, defs, dnaInv, bioPhase, false);
  }

  return {
    updatedSpecies:   pool,
    updatedBiosphere: updateBiosphere(pool, biosphere, bioPhase),
    events:           evt ? [evt] : [],
  };
}
