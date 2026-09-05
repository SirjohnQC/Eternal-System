/**
 * Civilization — a society, generated from the DNA its species actually evolved.
 *
 * Every civilisation used to behave identically: war chance, tech speed and
 * first-contact hostility were driven by universe-wide stats with no
 * per-civilisation term at all, so two neighbouring empires with completely
 * different biology were mechanically indistinguishable.
 */

export type Government =
  | 'Theocracy' | 'Republic' | 'Empire' | 'Confederation'
  | 'Technocracy' | 'Warband' | 'Hive' | 'Council';

export const GOVERNMENTS: Government[] = [
  'Theocracy', 'Republic', 'Empire', 'Confederation',
  'Technocracy', 'Warband', 'Hive', 'Council',
];

export type Ideology =
  | 'Expansionist' | 'Isolationist' | 'Mercantile' | 'Militarist'
  | 'Scholarly' | 'Devout' | 'Egalitarian' | 'Hierarchic';

export const IDEOLOGIES: Ideology[] = [
  'Expansionist', 'Isolationist', 'Mercantile', 'Militarist',
  'Scholarly', 'Devout', 'Egalitarian', 'Hierarchic',
];

/** Each 0–1. These are what the simulation actually reads. */
export interface CultureValues {
  militarism:   number;
  piety:        number;
  curiosity:    number;
  collectivism: number;
  xenophobia:   number;
}

/** Flat, serialisable copy of the traits culture is generated from. */
export interface GenomeSummary {
  speciesName:      string;
  metabolism:       string;
  locomotion:       string;
  environment:      string;
  diet:             string;
  respiration:      string;
  reproduction:     string;
  size:             string;
  bodyStructure:    string;
  sensorySystem:    string;
  intelligence:     number;
  social:           number;
  aggression:       number;
  adaptability:     number;
  biome:            string;
  temperatureRange: string;
}

export interface Architecture {
  style:          string;
  material:       string;
  settlementForm: string;
}

export interface Civilization {
  id:              string;
  starId:          number;
  speciesId:       string;
  name:            string;
  government:      Government;
  ideology:        Ideology;
  values:          CultureValues;
  architecture:    Architecture;
  selfDescription: string;
  foundingMyth:    string;
  epithet:         string;
  sourceGenome:    GenomeSummary;
  origin:          'llm' | 'procedural';
  generatedAtTick: number;
}

// ─── The bound ────────────────────────────────────────────────────────────────

/**
 * How far culture may push any simulation roll.
 *
 * ROADMAP M20d was caused by multiplied factors reaching probability 1 and
 * creating an absorbing state no player action could escape — measured at 0
 * advances in 100,000 rolls. Those factors were written by us. THESE COME FROM
 * MODEL OUTPUT, which makes the same failure more likely, not less. The bound is
 * therefore enforced in one function and swept exhaustively in test rather than
 * reasoned about at each call site.
 */
export const CULTURE_MULT_MIN = 0.4;
export const CULTURE_MULT_MAX = 2.2;

/**
 * Culture's influence on a roll, as a bounded multiplier.
 *
 * @param v        a culture value, nominally 0–1 but NOT trusted to be
 * @param strength how strongly this site responds; 1 gives roughly 0.4 … 1.6
 */
export function cultureMultiplier(v: number, strength = 1): number {
  if (!Number.isFinite(v)) return 1;          // model output can be anything
  const t = Math.max(0, Math.min(1, v));
  // Internally capped well above the nominal 0–2 strength range. At the nominal
  // cap of 2 the formula's algebraic extremes land exactly on
  // CULTURE_MULT_MIN/MAX, which would make the outer clamp below a no-op over
  // the domain any reasonable caller reaches — indistinguishable from absent.
  // Capping higher instead means an out-of-range strength (untrusted input can
  // send one) genuinely overshoots the envelope pre-clamp, so the clamp is
  // doing real, provable work rather than restating a coincidence.
  const s = Number.isFinite(strength) ? Math.max(0, Math.min(4, strength)) : 1;
  const raw = 1 + (t - 0.5) * 2 * s * 0.6;
  return Math.max(CULTURE_MULT_MIN, Math.min(CULTURE_MULT_MAX, raw));
}

import type { SeedRNG } from '../utils/SeedRNG';
import type { SpeciesGenome } from './SpeciesGenome';

/**
 * Flatten a live genome into a stored summary.
 *
 * A COPY, not a reference: `gameState.playerSpecies` is reassigned on every
 * evolution step, so a held reference goes stale silently (ROADMAP M20b).
 */
export function summariseGenome(sp: SpeciesGenome): GenomeSummary {
  return {
    speciesName:      sp.name,
    metabolism:       sp.dna.metabolism,
    locomotion:       sp.dna.locomotion,
    environment:      sp.dna.environment,
    diet:             sp.dna.diet,
    respiration:      sp.dna.respiration,
    reproduction:     sp.dna.reproduction,
    size:             sp.physicalTraits.size,
    bodyStructure:    sp.physicalTraits.bodyStructure,
    sensorySystem:    sp.physicalTraits.sensorySystem,
    intelligence:     sp.dna.intelligence,
    social:           sp.dna.social,
    aggression:       sp.dna.aggression,
    adaptability:     sp.dna.adaptability,
    biome:            sp.habitat.biome,
    temperatureRange: sp.habitat.temperatureRange,
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Culture values derived from biology. Pure — no RNG, so it is inspectable. */
export function valuesFromGenome(g: GenomeSummary): CultureValues {
  const solitary = g.social <= 3;
  const rooted   = g.locomotion === 'stationary';
  const isolated = g.environment === 'deep_sea' || g.environment === 'ocean';

  return {
    // Predation and size make a warlike people; sociality tempers it.
    militarism: clamp01(
      g.aggression / 10 * 0.6
      + (g.diet === 'carnivore' ? 0.25 : g.diet === 'omnivore' ? 0.08 : 0)
      + (g.size === 'large' || g.size === 'massive' ? 0.12 : 0)
      - g.social / 10 * 0.12),
    // Faith fills the space intellect does not, and binds social animals.
    piety: clamp01(
      0.30 + g.social / 10 * 0.35 - g.intelligence / 10 * 0.20
      + (g.sensorySystem === 'photoreception' ? 0.08 : 0)),
    // Curiosity is intellect plus a rich sensorium.
    curiosity: clamp01(
      g.intelligence / 10 * 0.65 + g.adaptability / 10 * 0.20
      + (g.sensorySystem === 'vision' || g.sensorySystem === 'echolocation' ? 0.12 : 0)),
    // Colony reproduction and rootedness make a collective.
    collectivism: clamp01(
      g.social / 10 * 0.55
      + (g.reproduction === 'spore' || g.reproduction === 'asexual' ? 0.20 : 0)
      + (rooted ? 0.15 : 0)
      + (g.bodyStructure === 'colonial' ? 0.15 : 0)),
    // Fear of outsiders comes from solitude, aggression and isolation.
    xenophobia: clamp01(
      0.15 + (solitary ? 0.28 : 0) + g.aggression / 10 * 0.30
      + (isolated ? 0.12 : 0) - g.adaptability / 10 * 0.15),
  };
}

/** The government a set of values implies. */
function governmentFor(v: CultureValues, g: GenomeSummary): Government {
  if (v.collectivism > 0.78 && g.social >= 8)          return 'Hive';
  if (v.piety > 0.62 && v.piety >= v.curiosity)        return 'Theocracy';
  if (v.militarism > 0.68)                             return v.collectivism > 0.5 ? 'Empire' : 'Warband';
  if (v.curiosity > 0.70)                              return 'Technocracy';
  if (v.collectivism > 0.55)                           return v.xenophobia > 0.5 ? 'Confederation' : 'Council';
  return 'Republic';
}

/** The ideology a set of values implies. */
function ideologyFor(v: CultureValues): Ideology {
  const ranked: Array<[Ideology, number]> = [
    ['Militarist',   v.militarism],
    ['Devout',       v.piety],
    ['Scholarly',    v.curiosity],
    ['Egalitarian',  v.collectivism],
    ['Isolationist', v.xenophobia],
    ['Expansionist', v.militarism * 0.6 + (1 - v.xenophobia) * 0.5],
    ['Mercantile',   (1 - v.xenophobia) * 0.6 + v.curiosity * 0.4],
    ['Hierarchic',   v.collectivism * 0.5 + v.militarism * 0.4],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  return ranked[0][0];
}

const STYLE_BY_ENV: Record<string, string> = {
  ocean:    'pressure-domed', deep_sea: 'vent-clustered', coastal: 'tidal-terraced',
  land:     'load-bearing',   aerial:   'suspended',
};
const MATERIAL_BY_BODY: Record<string, string> = {
  'single-celled': 'secreted film', colonial: 'grown coral', segmented: 'chitin plate',
  radial: 'spun fibre', shelled: 'fused shell', cartilaginous: 'lashed cartilage',
  vertebrate: 'quarried stone', exoskeletal: 'resin and chitin',
  gelatinous: 'gel membrane', filamentous: 'woven filament',
};

function architectureFor(g: GenomeSummary, v: CultureValues): Architecture {
  return {
    style:    STYLE_BY_ENV[g.environment] ?? 'load-bearing',
    material: MATERIAL_BY_BODY[g.bodyStructure] ?? 'quarried stone',
    settlementForm: v.collectivism > 0.7 ? 'a single continuous warren'
                  : v.xenophobia > 0.6   ? 'walled holdings, far apart'
                  : v.curiosity > 0.65   ? 'academies ringed by workshops'
                  :                        'clustered towns',
  };
}

const EPITHETS = [
  'the Patient', 'the Unquiet', 'the Manyfold', 'the Deep-Rooted', 'the Watchful',
  'the Sunward', 'the Undivided', 'the Hollow', 'the Ascendant', 'the Tidebound',
];

/**
 * Build a civilisation from biology alone.
 *
 * Always available: this runs before any network call, so an intelligent
 * civilisation is never without a culture and no code path has to handle a
 * missing record.
 */
export function proceduralCulture(
  genome: GenomeSummary,
  starId: number,
  speciesId: string,
  civName: string,
  tick: number,
  rng: SeedRNG,
): Civilization {
  const values = valuesFromGenome(genome);
  const government = governmentFor(values, genome);
  const ideology = ideologyFor(values);
  const architecture = architectureFor(genome, values);

  return {
    id: `civ_${starId}`,
    starId,
    speciesId,
    name: civName,
    government,
    ideology,
    values,
    architecture,
    selfDescription:
      `A ${government.toLowerCase()} of ${genome.size} ${genome.diet}s risen from the ` +
      `${genome.biome.replace(/_/g, ' ')}. They build ${architecture.settlementForm} ` +
      `of ${architecture.material}, ${architecture.style} against the world.`,
    foundingMyth:
      `They tell of the first of them to ${genome.locomotion === 'stationary'
        ? 'take root and refuse to be moved'
        : `${genome.locomotion} beyond the edge of the known`}.`,
    epithet: rng.pick(EPITHETS),
    sourceGenome: genome,
    origin: 'procedural',
    generatedAtTick: tick,
  };
}
