/**
 * Technology as a RESPONSE (docs/CORE_LOOP_VISION.md §8, phase 2).
 *
 * A technology is a rule, not an event: what it answers (the pressures that
 * make a people look for it), who leans toward it (culture), what it needs
 * first, and what it does to the nation's state — benefits AND costs
 * (pollution, inequality). Nations choose what to study from what they face
 * and what they are (Nations.ts); nothing here is scheduled.
 *
 * The tree runs through the eras of GameState.TECH_LEVELS (1 Ancient ..
 * 8 Post-Biological) and through the colony ark: the first ship to leave.
 *
 * Pure data + pure functions.
 */
import type { CultureValues } from './Civilization';

/** Pressures a technology can answer (Nations.Pressures keys + curiosity's own pull). */
export type Need = 'hunger' | 'crowding' | 'scarcity' | 'unrest' | 'pollution' | 'curiosity';

/** What a technology does to a nation. Multipliers stack; deltas add. */
export interface TechEffect {
  food?: number;        // x food yield
  housing?: number;     // x people a cell holds
  materials?: number;   // x wood, stone and ore won
  knowledge?: number;   // x research
  cohesion?: number;    // + target cohesion
  pollution?: number;   // + pollution per step while known (negative cleans)
  inequality?: number;  // + inequality, once
}

export interface Tech {
  id: string;
  name: string;
  /** TECH_LEVELS index this belongs to (1..8). */
  era: number;
  requires: string[];
  /** How strongly each pressure draws a people toward this (0..1). */
  answers: Partial<Record<Need, number>>;
  /** Culture leanings: + favours, - shuns. */
  leaning: Partial<Record<keyof CultureValues, number>>;
  effect: TechEffect;
  /** Past tense for the history: "learned to irrigate the fields". */
  deed: string;
  /** The ship: learning it launches the first colony ark. */
  spaceship?: boolean;
}

const T = (id: string, name: string, era: number, requires: string[], answers: Tech['answers'],
  leaning: Tech['leaning'], effect: TechEffect, deed: string, spaceship = false): Tech =>
  ({ id, name, era, requires, answers, leaning, effect, deed, spaceship });

export const TECHS: Tech[] = [
  // ── Ancient ──
  T('agriculture', 'Agriculture', 1, [], { hunger: 1 }, { collectivism: 0.2 },
    { food: 1.35, inequality: 0.03 }, 'sowed the first fields'),
  T('granaries', 'Granaries', 1, [], { hunger: 0.6 }, { collectivism: 0.3 },
    { food: 1.1, cohesion: 0.02 }, 'built granaries against lean years'),
  T('masonry', 'Masonry', 1, [], { crowding: 0.6, scarcity: 0.4 }, {},
    { housing: 1.2, materials: 1.15 }, 'raised walls of cut stone'),
  T('writing', 'Writing', 1, [], { unrest: 0.4, curiosity: 0.7 }, { curiosity: 0.4 },
    { knowledge: 1.25, cohesion: 0.03 }, 'began to write things down'),
  T('bronze', 'Bronze Working', 1, [], { scarcity: 0.7 }, { militarism: 0.4 },
    { materials: 1.25, inequality: 0.04 }, 'learned to cast bronze'),
  T('priesthood', 'Priesthood', 1, [], { unrest: 0.8 }, { piety: 0.6, curiosity: -0.2 },
    { cohesion: 0.08, knowledge: 0.95, inequality: 0.03 }, 'ordained its first priests'),
  // ── Medieval ──
  T('irrigation', 'Irrigation', 2, ['agriculture'], { hunger: 1 }, { collectivism: 0.2 },
    { food: 1.3 }, 'dug canals to water the fields'),
  T('iron', 'Iron Working', 2, ['bronze'], { scarcity: 0.8 }, { militarism: 0.4 },
    { materials: 1.3 }, 'smelted iron'),
  T('law', 'Codified Law', 2, ['writing'], { unrest: 1 }, { collectivism: 0.3 },
    { cohesion: 0.08, inequality: -0.02 }, 'wrote down its laws'),
  T('sanitation', 'Aqueducts', 2, ['masonry'], { crowding: 1 }, {},
    { housing: 1.3 }, 'brought clean water into its towns'),
  T('scholarship', 'Scholarship', 2, ['writing'], { curiosity: 1 }, { curiosity: 0.6, piety: -0.2 },
    { knowledge: 1.35 }, 'founded its first schools'),
  T('estates', 'Feudal Estates', 2, ['agriculture'], { hunger: 0.4, unrest: 0.4 }, { militarism: 0.3, collectivism: -0.3 },
    { food: 1.15, cohesion: 0.05, inequality: 0.12 }, 'parcelled its land among lords'),
  // ── Industrial ──
  T('steam', 'Steam Power', 3, ['iron'], { scarcity: 1 }, { curiosity: 0.2 },
    { materials: 1.5, pollution: 0.004 }, 'harnessed steam'),
  T('mech_farms', 'Mechanised Farms', 3, ['irrigation', 'steam'], { hunger: 1 }, {},
    { food: 1.6, pollution: 0.002, inequality: 0.05 }, 'put machines to the plough'),
  T('factories', 'Factories', 3, ['steam'], { scarcity: 0.6, crowding: 0.3 }, { collectivism: -0.2 },
    { materials: 1.3, housing: 1.2, pollution: 0.005, inequality: 0.1 }, 'built its first factories'),
  T('printing', 'Printing Press', 3, ['scholarship'], { unrest: 0.5, curiosity: 0.8 }, { curiosity: 0.4 },
    { knowledge: 1.3, cohesion: 0.04 }, 'printed books for everyone'),
  T('medicine', 'Medicine', 3, ['sanitation'], { crowding: 0.7 }, { curiosity: 0.2 },
    { housing: 1.25 }, 'learned to fight disease'),
  // ── Atomic ──
  T('electricity', 'Electricity', 4, ['factories'], { scarcity: 0.4, curiosity: 0.6 }, { curiosity: 0.3 },
    { knowledge: 1.2, materials: 1.2 }, 'lit its cities with electricity'),
  T('fertiliser', 'Synthetic Fertiliser', 4, ['mech_farms'], { hunger: 1 }, {},
    { food: 1.5, pollution: 0.004 }, 'fed its fields with chemistry'),
  T('mass_media', 'Mass Media', 4, ['printing', 'electricity'], { unrest: 0.8 }, { collectivism: 0.3 },
    { cohesion: 0.08 }, 'spoke to all its people at once'),
  T('welfare', 'Welfare State', 4, ['law', 'factories'], { unrest: 0.6 }, { collectivism: 0.6, militarism: -0.2 },
    { inequality: -0.15, cohesion: 0.04 }, 'promised care to every citizen'),
  T('fission', 'Nuclear Fission', 4, ['electricity'], { scarcity: 0.7 }, { militarism: 0.4, curiosity: 0.2 },
    { materials: 1.3, pollution: 0.002 }, 'split the atom'),
  // ── Space Age ──
  T('computing', 'Computing', 5, ['electricity'], { curiosity: 1 }, { curiosity: 0.5 },
    { knowledge: 1.5 }, 'built thinking machines'),
  T('rocketry', 'Rocketry', 5, ['fission'], { crowding: 0.3, curiosity: 0.7 }, { militarism: 0.3, curiosity: 0.3 },
    {}, 'reached orbit'),
  T('clean_energy', 'Clean Energy', 5, ['electricity'], { pollution: 1 }, { collectivism: 0.2 },
    { pollution: -0.008 }, 'turned to the sun and wind'),
  T('automation', 'Automation', 5, ['computing', 'factories'], { scarcity: 0.7, hunger: 0.3 }, { collectivism: -0.2 },
    { materials: 1.3, food: 1.2, inequality: 0.12 }, 'let machines do the work'),
  T('arcologies', 'Arcologies', 5, ['medicine', 'electricity'], { crowding: 1 }, { collectivism: 0.3 },
    { housing: 1.6 }, 'raised cities into the sky'),
  // ── Interstellar ──
  T('orbital', 'Orbital Stations', 6, ['rocketry', 'computing'], { crowding: 0.6, curiosity: 0.6 }, { curiosity: 0.3 },
    { housing: 1.1, knowledge: 1.1 }, 'built homes in orbit'),
  T('colony_ark', 'Colony Ark', 6, ['orbital'], { crowding: 1, scarcity: 0.4 }, { curiosity: 0.3, xenophobia: -0.2 },
    { housing: 1.2 }, 'launched a colony ark toward another world', true),
  T('ai', 'Artificial Minds', 6, ['computing', 'automation'], { curiosity: 1 }, { curiosity: 0.5, piety: -0.3 },
    { knowledge: 1.6, inequality: 0.1, cohesion: -0.03 }, 'woke the first artificial minds'),
  T('fusion', 'Fusion', 6, ['clean_energy', 'fission'], { scarcity: 0.8, pollution: 0.6 }, {},
    { materials: 1.5, pollution: -0.006 }, 'lit a star in a bottle'),
  // ── Post-Human ──
  T('gene_shaping', 'Gene Shaping', 7, ['medicine', 'ai'], { crowding: 0.5, hunger: 0.4 }, { piety: -0.4 },
    { housing: 1.3, food: 1.2, cohesion: -0.05 }, 'rewrote its own bodies'),
  T('uploads', 'Mind Uploading', 7, ['ai'], { crowding: 1 }, { curiosity: 0.4, piety: -0.5 },
    { housing: 1.5 }, 'moved minds out of flesh'),
  T('nanoforges', 'Nanoforges', 7, ['fusion', 'ai'], { scarcity: 1 }, {},
    { materials: 2 }, 'built anything from anything'),
  // ── Post-Biological ──
  T('communion', 'Machine Communion', 8, ['uploads'], { unrest: 1 }, { collectivism: 0.5 },
    { cohesion: 0.1, inequality: -0.1 }, 'joined its minds into one'),
  T('stellar', 'Stellar Engineering', 8, ['nanoforges', 'colony_ark'], { scarcity: 0.8, curiosity: 0.8 }, { curiosity: 0.4 },
    { materials: 1.5, knowledge: 1.3 }, 'began to reshape its star'),
];

export const TECH_BY_ID: Record<string, Tech> = Object.fromEntries(TECHS.map(t => [t.id, t]));

/** Techs of an era a nation must know to stand in that era. */
export const TECHS_PER_ERA = 2;

/** The highest era in which `known` holds TECHS_PER_ERA techs (eras are climbed in order). */
export function eraOf(known: readonly string[]): number {
  const per = new Array(9).fill(0);
  for (const id of known) { const t = TECH_BY_ID[id]; if (t) per[t.era]++; }
  let era = 0;
  for (let e = 1; e <= 8; e++) { if (per[e] >= TECHS_PER_ERA) era = e; else break; }
  return era;
}

/** Techs that can be studied now: not known, every prerequisite known, era at most one past the current. */
export function available(known: readonly string[]): Tech[] {
  const have = new Set(known), era = eraOf(known);
  return TECHS.filter(t => !have.has(t.id) && t.era <= era + 1 && t.requires.every(r => have.has(r)));
}

/**
 * How strongly a people is drawn to `t`: the pressures it answers, weighted by
 * how acute they are, plus the culture's leanings. Always > 0, so even a calm,
 * incurious people eventually tinkers.
 */
export function appeal(t: Tech, pressure: Record<Need, number>, v: CultureValues): number {
  let w = 0.12;
  for (const [k, a] of Object.entries(t.answers) as Array<[Need, number]>) w += a * pressure[k] * 3;
  for (const [k, a] of Object.entries(t.leaning) as Array<[keyof CultureValues, number]>) w += a * (v[k] - 0.5);
  return Math.max(0.03, w);
}

/** The combined effect of everything known (multipliers multiplied, rates summed). */
export function effectOf(known: readonly string[]): Required<Omit<TechEffect, 'inequality'>> {
  const e = { food: 1, housing: 1, materials: 1, knowledge: 1, cohesion: 0, pollution: 0 };
  for (const id of known) {
    const f = TECH_BY_ID[id]?.effect;
    if (!f) continue;
    if (f.food) e.food *= f.food;
    if (f.housing) e.housing *= f.housing;
    if (f.materials) e.materials *= f.materials;
    if (f.knowledge) e.knowledge *= f.knowledge;
    if (f.cohesion) e.cohesion += f.cohesion;
    if (f.pollution) e.pollution += f.pollution;
  }
  return e;
}
