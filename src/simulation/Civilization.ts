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
