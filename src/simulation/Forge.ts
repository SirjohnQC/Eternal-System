/**
 * The Forge: the first minutes of a game, forging the home world out of Fate
 * Cards instead of waiting hours for it to cool.
 *
 * The player never picks "an ocean world". They impose FORCES (cards) on a
 * hidden Planet DNA, and the world that comes out is whatever those forces
 * make together (vision §2: the player disturbs conditions, never controls).
 *
 *   start   — the dice, the planet's name and its star seed the DNA and the
 *             deck: you forge within your roll, never from a blank slate.
 *   draft   — each round deals three cards; pick one, the others burn. Cards
 *             push hidden parameters; some only appear as REACTIONS to what the
 *             world has become (volcanism + minerals → The Molten Treasure);
 *             rare "???" cards hide their force until the end.
 *   harden  — card values add up to FORGE_TARGET. The world visibly walks its
 *             formation stages as it hardens (the engine draws it).
 *   reveal  — the DNA resolves to a destiny, the old PlanetDNA, simulation
 *             modifiers and a line-by-line description, never raw numbers.
 *   cool    — a short wait while the last crust cools and the first rains fall.
 *   spark   — a god who is not yours whispers a sealed golden card; playing it
 *             wakes life, in a cradle chance picks.
 *
 * Pure: no engine, no DOM. State is plain JSON (it lives in gameState, so it
 * saves). Every deal is seeded from the master seed and the round, so a
 * reloaded forge deals the same cards.
 */

import { SeedRNG } from '../utils/SeedRNG';
import type { PlanetDNA, UniverseStats } from './GameState';
import type { DestinyType } from './Formation';

// ─── Hidden Planet DNA ────────────────────────────────────────────────────────

export const FORGE_PARAMS = [
  'heat', 'water', 'cold', 'shield', 'air', 'toxic', 'mass', 'stability', 'minerals', 'fertile', 'mutation',
] as const;
export type ForgeParam = typeof FORGE_PARAMS[number];
/** Each parameter 0..1. Never shown to the player as numbers. */
export type ForgeDNA = Record<ForgeParam, number>;

/** Forging points to finish: about ten picks. */
export const FORGE_TARGET = 90;
/** Rerolls of a whole hand per forge ("let the fire turn"). */
export const FORGE_REROLLS = 2;
/** Wall-clock seconds the crust cools after the forging, before the whisper. */
export const COOLING_SECONDS = 90;

export type ForgeTone = 'fire' | 'water' | 'ice' | 'sky' | 'stone' | 'life' | 'void';

export interface FateCardDef {
  id: string;
  name: string;
  /** The line on the card: what it imposes, in the world's own words. */
  text: string;
  /** Forging points. */
  value: number;
  effects: Partial<Record<ForgeParam, number>>;
  /** Pixel icon under /assets/pixel/divine/cards/. */
  icon: string;
  tone: ForgeTone;
  /** Relative odds of being dealt (before reactions). */
  weight: number;
  /** How many times it can be forged into one world. */
  max: number;
  /** A reaction: only dealt when the world already is this. */
  when?: (d: ForgeDNA) => boolean;
  /** Reaction cards say what they answered. */
  answers?: string;
  /** The Balance: pull every force toward the middle. */
  balance?: number;
  /** "???": hides its force and value until the reveal. */
  unknown?: boolean;
}

const hi = (d: ForgeDNA, k: ForgeParam, v: number) => d[k] >= v;
const lo = (d: ForgeDNA, k: ForgeParam, v: number) => d[k] <= v;

export const FATE_CARDS: readonly FateCardDef[] = [
  // ── Forces ────────────────────────────────────────────────────────────────
  { id: 'restless_heart', name: 'The Restless Heart', text: 'Something beneath the world refuses to sleep.',
    value: 9, effects: { heat: 0.2, minerals: 0.12, stability: -0.06 }, icon: 'volcano', tone: 'fire', weight: 10, max: 2 },
  { id: 'remembers_water', name: 'The World Remembers Water', text: 'Give the rain somewhere to go.',
    value: 11, effects: { water: 0.22, stability: 0.04 }, icon: 'rains', tone: 'water', weight: 10, max: 2 },
  { id: 'long_winter', name: 'The Long Winter', text: 'Let the cold claim what the sun cannot reach.',
    value: 8, effects: { cold: 0.22, heat: -0.1 }, icon: 'ice_age', tone: 'ice', weight: 8, max: 2 },
  { id: 'burning_sky', name: 'The Burning Sky', text: 'Let the sun lean close.',
    value: 8, effects: { heat: 0.15, cold: -0.15, water: -0.12 }, icon: 'drought', tone: 'fire', weight: 8, max: 2 },
  { id: 'invisible_shield', name: 'The Invisible Shield', text: 'Protect what has not yet been born.',
    value: 9, effects: { shield: 0.24, air: 0.07 }, icon: 'sight', tone: 'sky', weight: 8, max: 2 },
  { id: 'poisoned_gift', name: 'The Poisoned Gift', text: 'Life does not require kindness.',
    value: 7, effects: { toxic: 0.22, mutation: 0.18 }, icon: 'blight', tone: 'void', weight: 6, max: 2 },
  { id: 'balance', name: 'The Balance', text: 'Nothing is given without something being taken.',
    value: 6, effects: { stability: 0.14 }, balance: 0.3, icon: 'calm', tone: 'stone', weight: 5, max: 1 },
  { id: 'chaos', name: 'Chaos', text: 'Let no future be entirely certain.',
    value: 5, effects: { stability: -0.22, mutation: 0.12 }, icon: 'discord', tone: 'void', weight: 3, max: 1 },
  { id: 'crucible', name: 'The Crucible', text: 'Make survival difficult.',
    value: 7, effects: { mutation: 0.2, toxic: 0.05, fertile: -0.04, stability: -0.05 }, icon: 'crucible', tone: 'void', weight: 6, max: 1 },
  { id: 'first_breath', name: 'The First Breath', text: 'Something will one day learn to breathe this.',
    value: 10, effects: { air: 0.18, fertile: 0.12, toxic: -0.08 }, icon: 'awaken', tone: 'life', weight: 8, max: 1 },
  { id: 'green_possibility', name: 'The Green Possibility', text: 'Prepare the world for something that has not yet evolved.',
    value: 11, effects: { fertile: 0.2 }, icon: 'fertility', tone: 'life', weight: 7, max: 1 },
  { id: 'weight_of_stone', name: 'The Weight of Stone', text: 'Make the world heavy, so it holds on to its air.',
    value: 9, effects: { mass: 0.2, air: 0.1, shield: 0.04 }, icon: 'quake', tone: 'stone', weight: 7, max: 2 },
  { id: 'featherweight', name: 'The Featherweight', text: 'Let mountains reach for the sky.',
    value: 7, effects: { mass: -0.2, air: -0.06, minerals: 0.04 }, icon: 'terraform', tone: 'stone', weight: 6, max: 2 },
  { id: 'deep_harvest', name: 'The Deep Harvest', text: 'Bury riches where only patience will find them.',
    value: 7, effects: { minerals: 0.2 }, icon: 'veins', tone: 'stone', weight: 7, max: 2 },
  { id: 'thick_veil', name: 'The Thick Veil', text: 'Wrap the world in heavy air.',
    value: 8, effects: { air: 0.22, heat: 0.03 }, icon: 'cleanse', tone: 'sky', weight: 7, max: 2 },
  { id: 'open_sky', name: 'The Open Sky', text: 'Let the stars look down unhindered.',
    value: 6, effects: { air: -0.18, cold: 0.06, water: -0.05 }, icon: 'comet', tone: 'sky', weight: 5, max: 1 },
  { id: 'comet_rain', name: 'The Comet Rain', text: 'Ice from the dark, falling for a thousand years.',
    value: 10, effects: { water: 0.15, mutation: 0.04, stability: -0.05 }, icon: 'meteor', tone: 'water', weight: 6, max: 1 },
  { id: 'thirsty_wind', name: 'The Thirsty Wind', text: 'Let the wind take every drop it can carry.',
    value: 8, effects: { water: -0.2, air: 0.04 }, icon: 'drought', tone: 'sky', weight: 7, max: 2 },
  { id: 'scoured_stone', name: 'The Scoured Stone', text: 'Let the young seas boil off into the dark.',
    value: 7, effects: { water: -0.14, heat: 0.08, minerals: 0.06 }, icon: 'volcano', tone: 'fire', weight: 5, max: 1 },
  { id: 'pull_of_moons', name: 'The Pull of Moons', text: 'Let something above stir the waters.',
    value: 7, effects: { fertile: 0.08, water: 0.04, stability: -0.03 }, icon: 'seafaring', tone: 'water', weight: 5, max: 1 },
  { id: 'sleeping_core', name: 'The Sleeping Core', text: 'Let the deep fires rest.',
    value: 7, effects: { heat: -0.17, stability: 0.13, shield: -0.08 }, icon: 'calm', tone: 'stone', weight: 6, max: 1 },
  { id: 'tilted_axis', name: 'The Tilted Axis', text: 'Give the world its seasons.',
    value: 7, effects: { stability: -0.07, cold: 0.05, heat: 0.05, fertile: 0.06 }, icon: 'harvest', tone: 'life', weight: 6, max: 1 },
  { id: 'ashen_dawn', name: 'The Ashen Dawn', text: 'Let the first sky be smoke.',
    value: 7, effects: { heat: 0.04, toxic: 0.12, air: 0.12 }, icon: 'pestilence', tone: 'fire', weight: 5, max: 1 },
  { id: 'salt_of_ages', name: 'The Salt of Ages', text: 'Let the seas taste of the stone they cover.',
    value: 6, effects: { minerals: 0.09, water: 0.04, fertile: 0.06 }, icon: 'cure', tone: 'water', weight: 5, max: 1 },

  // ── Reactions: dealt only when the world already leans this way ───────────
  { id: 'molten_treasure', name: 'The Molten Treasure', text: 'The restless heart has filled the veins with fire.',
    answers: 'fire and buried riches', value: 13, effects: { minerals: 0.18, heat: 0.06 }, icon: 'veins', tone: 'fire', weight: 9, max: 1,
    when: d => hi(d, 'heat', 0.62) && hi(d, 'minerals', 0.58) },
  { id: 'breath_of_steam', name: 'The Breath of Steam', text: 'Fire met water, and neither would yield.',
    answers: 'heat and water', value: 12, effects: { air: 0.16, water: 0.05, heat: 0.05, stability: -0.07 }, icon: 'rains', tone: 'fire', weight: 9, max: 1,
    when: d => hi(d, 'heat', 0.6) && hi(d, 'water', 0.6) },
  { id: 'warm_heart_ice', name: 'The Warm Heart Beneath the Ice', text: 'Under the ice, the deep fire keeps a sea alive.',
    answers: 'ice over a living core', value: 12, effects: { fertile: 0.16, water: 0.05 }, icon: 'awaken', tone: 'ice', weight: 9, max: 1,
    when: d => hi(d, 'cold', 0.62) && hi(d, 'heat', 0.55) },
  { id: 'iron_mantle', name: 'The Iron Mantle', text: 'A heavy world, and a shield that will not break.',
    answers: 'weight and a strong field', value: 11, effects: { shield: 0.12, air: 0.1, stability: 0.08 }, icon: 'hardy', tone: 'stone', weight: 9, max: 1,
    when: d => hi(d, 'shield', 0.64) && hi(d, 'mass', 0.58) },
  { id: 'strange_cradle', name: 'The Strange Cradle', text: 'Where the air burns, something odd will learn to love it.',
    answers: 'poison and promise', value: 12, effects: { mutation: 0.16, fertile: 0.08 }, icon: 'mutate', tone: 'void', weight: 9, max: 1,
    when: d => hi(d, 'toxic', 0.62) && hi(d, 'fertile', 0.55) },
  { id: 'endless_ocean', name: 'The Endless Ocean', text: 'No shore in sight, from any shore.',
    answers: 'deep water', value: 10, effects: { water: 0.12, stability: 0.04 }, icon: 'seafaring', tone: 'water', weight: 8, max: 1,
    when: d => hi(d, 'water', 0.72) },
  { id: 'glass_desert', name: 'The Glass Desert', text: 'Sand fused to glass by a patient sun.',
    answers: 'heat without water', value: 10, effects: { heat: 0.08, minerals: 0.1, water: -0.05 }, icon: 'drought', tone: 'fire', weight: 8, max: 1,
    when: d => hi(d, 'heat', 0.66) && lo(d, 'water', 0.36) },
  { id: 'frozen_crown', name: 'The Frozen Crown', text: 'The cold has a king now, and it does not move.',
    answers: 'deep cold', value: 9, effects: { cold: 0.1, stability: 0.1 }, icon: 'ice_age', tone: 'ice', weight: 8, max: 1,
    when: d => hi(d, 'cold', 0.7) },
  { id: 'living_shield', name: 'The Sheltered Garden', text: 'Behind the shield, the air is soft.',
    answers: 'shelter and fertile ground', value: 11, effects: { fertile: 0.12, toxic: -0.08, air: 0.05 }, icon: 'fertility', tone: 'life', weight: 8, max: 1,
    when: d => hi(d, 'shield', 0.62) && hi(d, 'fertile', 0.6) },

  // ── The unknown ───────────────────────────────────────────────────────────
  { id: 'unknown', name: '???', text: 'Something has begun to take shape.',
    value: 0, effects: {}, icon: 'seek', tone: 'void', weight: 2.5, max: 2, unknown: true },
];

export const FATE_BY_ID: Record<string, FateCardDef> = Object.fromEntries(FATE_CARDS.map(c => [c.id, c]));

/** What a "???" card turns out to be. Rolled when dealt, revealed at the end. */
export interface UnknownForce { id: string; title: string; line: string; value: number; effects: Partial<Record<ForgeParam, number>>; }
const UNKNOWN_FORCES: readonly Omit<UnknownForce, 'value'>[] = [
  { id: 'captured_moon', title: 'A captured moon', line: 'A wandering moon was caught, and now it pulls the tides.', effects: { stability: 0.12, fertile: 0.08, water: 0.04 } },
  { id: 'buried_ocean', title: 'A buried ocean', line: 'A sea hid under the crust, and rose when the world was ready.', effects: { water: 0.2, cold: 0.04 } },
  { id: 'rogue_star', title: "A rogue star's passing", line: 'A stranger star passed close once, and shook every certainty loose.', effects: { mutation: 0.2, stability: -0.1 } },
  { id: 'crystal_core', title: 'A crystal core', line: 'The heart of the world grew into one vast, ringing crystal.', effects: { shield: 0.18, minerals: 0.14 } },
  { id: 'heaven_scar', title: 'A scar from the heavens', line: 'Something struck the young world and left its metals behind.', effects: { minerals: 0.18, toxic: 0.08, heat: 0.06 } },
  { id: 'sky_seeds', title: 'A rain of sky-seeds', line: 'Dust from older worlds fell here, and it was not quite dead.', effects: { fertile: 0.22, mutation: 0.06 } },
];

// ─── State ────────────────────────────────────────────────────────────────────

export interface ForgedCard {
  id: string;
  /** For "???": the hidden force (revealed at the end). */
  hidden?: UnknownForce;
}

export interface ForgeOutcome {
  destiny: DestinyType;
  planetDNA: PlanetDNA;
  /** Multipliers / offsets the simulation reads (gameState.forgeMods). */
  mods: ForgeMods;
  /** Reveal lines, in order: [label, value]. */
  traits: Array<[string, string]>;
  /** Shown last, alone, when the world has something strange about it. */
  unusual: string | null;
  /** "???" cards, now named. */
  unveiled: UnknownForce[];
}

export interface ForgeMods {
  /** × the home world's evolutionary tempo. */
  tempo: number;
  /** × the home world's biosphere-catastrophe odds. */
  catastrophe: number;
  /** + filter assistance (negative = harder Great Filters). */
  assist: number;
}

export type ForgePhase = 'draft' | 'reveal' | 'cooling' | 'whisper' | 'done';

export interface ForgeState {
  phase: ForgePhase;
  seed: string;
  dna: ForgeDNA;
  points: number;
  round: number;
  rerolls: number;
  hand: ForgedCard[];
  played: ForgedCard[];
  /** The roll's fixed sign, shown at the start ("Your star burns red..."). */
  omen: string;
  outcome: ForgeOutcome | null;
  /** Date.now() when cooling began (wall clock; survives a reload roughly). */
  coolingStart: number;
  /** Cooling seconds already spent before a reload. */
  coolingDone: number;
  whisperer: string;
  /** Where life woke (after the spark). */
  cradle: string | null;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * The forge's starting DNA: the dice, the name (through the seed) and the star.
 * Returns the DNA and the omen line that names the strongest pull.
 */
export function startingDNA(seed: string, stats: UniverseStats, starTemperature: number): { dna: ForgeDNA; omen: string } {
  const rng = new SeedRNG(`${seed}_forge_dna`);
  const dna = {} as ForgeDNA;
  for (const k of FORGE_PARAMS) dna[k] = 0.5 + rng.nextFloat(-0.08, 0.08);
  const d = (v: number) => (v - 10.5) / 9.5;               // a d20 stat → -1..1
  dna.fertile += d(stats.life) * 0.12;
  dna.mutation += d(stats.evolution) * 0.12;
  dna.toxic += d(stats.hostility) * 0.1;
  dna.heat += d(stats.hostility) * 0.05;
  dna.stability -= d(stats.entropy) * 0.12;
  // The star: a cool red sun leaves the world cold, a hot blue one bakes it.
  const t = Math.max(-1, Math.min(1, (starTemperature - 9000) / 9000));
  dna.heat += t * 0.1;
  dna.cold -= t * 0.1;
  dna.shield -= Math.max(0, t) * 0.06;                       // hot stars are harsh
  for (const k of FORGE_PARAMS) dna[k] = clamp01(dna[k]);
  const omen = starTemperature < 4500 ? 'Your star burns red and dim. The world will start cold.'
    : starTemperature > 15000 ? 'Your star burns blue and fierce. Its light is not gentle.'
    : stats.life >= 15 ? 'The dice favoured life. The ground is already eager.'
    : stats.entropy >= 15 ? 'The dice favoured chaos. Nothing here will hold still for long.'
    : stats.hostility >= 15 ? 'The dice were cruel. The world begins harsh.'
    : stats.evolution >= 15 ? 'The dice favoured change. Whatever lives here will not stay the same.'
    : 'Your star is steady and yellow. The world could become anything.';
  return { dna, omen };
}

export function newForge(seed: string, stats: UniverseStats, starTemperature: number, whisperer: string): ForgeState {
  const { dna, omen } = startingDNA(seed, stats, starTemperature);
  const s: ForgeState = {
    phase: 'draft', seed, dna, points: 0, round: 0, rerolls: FORGE_REROLLS,
    hand: [], played: [], omen, outcome: null, coolingStart: 0, coolingDone: 0, whisperer, cradle: null,
  };
  s.hand = deal(s);
  return s;
}

function timesPlayed(s: ForgeState, id: string): number {
  return s.played.filter(c => c.id === id).length;
}

/** Three cards, weighted, distinct; reactions surface as the world leans their way. */
export function deal(s: ForgeState): ForgedCard[] {
  const rng = new SeedRNG(`${s.seed}_forge_deal_${s.round}_${FORGE_REROLLS - s.rerolls}`);
  const pool = FATE_CARDS
    .filter(c => timesPlayed(s, c.id) < c.max)
    .map(c => ({ c, w: c.when ? (c.when(s.dna) ? c.weight : 0) : c.weight }))
    .filter(o => o.w > 0);
  const hand: ForgedCard[] = [];
  let unknownDealt = false;
  while (hand.length < 3 && pool.length) {
    let total = 0;
    for (const o of pool) total += o.w;
    let pick = rng.next() * total, idx = 0;
    for (; idx < pool.length - 1; idx++) { pick -= pool[idx].w; if (pick < 0) break; }
    const { c } = pool.splice(idx, 1)[0];
    if (c.unknown) {
      if (unknownDealt || s.round === 0) continue;   // never in the first hand, one per hand
      unknownDealt = true;
      const f = UNKNOWN_FORCES[rng.nextInt(0, UNKNOWN_FORCES.length - 1)];
      hand.push({ id: c.id, hidden: { ...f, value: rng.nextInt(6, 13) } });
    } else {
      hand.push({ id: c.id });
    }
  }
  return hand;
}

const HINTS: Record<ForgeParam, [string, string]> = {
  heat: ['Deep fires stir under the crust.', 'The deep fires settle.'],
  water: ['Clouds gather over the cooling rock.', 'The sky dries out.'],
  cold: ['A chill settles on the young crust.', 'The cold loosens its grip.'],
  shield: ['Something invisible closes around the world.', 'The world feels more exposed.'],
  air: ['The air thickens.', 'The air thins.'],
  toxic: ['The fumes turn sharp.', 'The fumes clear a little.'],
  mass: ['The world grows heavier.', 'The world grows lighter.'],
  stability: ['The crust grows calmer.', 'The ground will not keep still.'],
  minerals: ['Metal veins spread through the stone.', 'The stone runs thin of metal.'],
  fertile: ['The world feels ready for something.', 'The world grows less welcoming.'],
  mutation: ['Nothing here will stay the same for long.', 'The world grows steadier in its ways.'],
};

/** One line on how the world answered a card: its strongest push. */
export function forceHint(card: ForgedCard): string {
  const def = FATE_BY_ID[card.id];
  if (!def || card.hidden) return 'Something has begun to take shape. You cannot tell what.';
  if (def.balance) return 'Every extreme softens a little.';
  let best: [ForgeParam, number] | null = null;
  for (const [k, v] of Object.entries(def.effects) as Array<[ForgeParam, number]>) if (!best || Math.abs(v) > Math.abs(best[1])) best = [k, v];
  return best ? HINTS[best[0]][best[1] >= 0 ? 0 : 1] : 'The world shifts.';
}

/** The visible forging value of a dealt card (unknowns show "?"). */
export function valueOf(card: ForgedCard): number {
  return card.hidden ? card.hidden.value : FATE_BY_ID[card.id]?.value ?? 0;
}

function applyEffects(dna: ForgeDNA, effects: Partial<Record<ForgeParam, number>>): void {
  for (const [k, v] of Object.entries(effects) as Array<[ForgeParam, number]>) dna[k] = clamp01(dna[k] + v);
}

/** Forge one card from the hand. Unknowns add their points now, their force at the reveal. */
export function forgeCard(s: ForgeState, handIndex: number): void {
  if (s.phase !== 'draft') return;
  const card = s.hand[handIndex];
  if (!card) return;
  const def = FATE_BY_ID[card.id];
  if (def.balance) for (const k of FORGE_PARAMS) s.dna[k] = s.dna[k] + (0.5 - s.dna[k]) * def.balance;
  if (!card.hidden) applyEffects(s.dna, def.effects);
  s.played.push(card);
  s.points += valueOf(card);
  s.round++;
  if (s.points >= FORGE_TARGET) {
    s.hand = [];
    for (const c of s.played) if (c.hidden) applyEffects(s.dna, c.hidden.effects);
    s.outcome = resolveForge(s);
    s.phase = 'reveal';
  } else {
    s.hand = deal(s);
  }
}

/** Burn the whole hand for a new one (twice per forge). The fire turning stirs chaos. */
export function rerollHand(s: ForgeState): boolean {
  if (s.phase !== 'draft' || s.rerolls <= 0) return false;
  s.rerolls--;
  s.dna.stability = clamp01(s.dna.stability - 0.03);
  s.hand = deal(s);
  return true;
}

/** 0..1 through the forging. */
export function forgeProgress(s: ForgeState): number {
  return Math.max(0, Math.min(1, s.points / FORGE_TARGET));
}

// ─── Interaction rules: DNA → the world ──────────────────────────────────────

/** The world as the forces make it right now (also used live while forging). */
export function destinyOf(d: ForgeDNA): DestinyType {
  // Each destiny is a pull; the strongest wins, and a world pulled nowhere
  // in particular settles as rock. A wet world freezes only when the cold
  // outweighs the water, and a deep fire keeps ice from closing over it.
  const ocean = d.water - 0.62;
  const ice = d.cold - 0.64 - Math.max(0, d.heat - 0.5) * 0.6;
  const desert = (0.38 - d.water) + (d.heat - 0.6) * 0.6;
  const best = Math.max(ocean, ice, desert);
  if (best < 0.05) return 'rocky';
  return best === ocean ? 'ocean' : best === ice ? 'ice' : 'desert';
}

export function planetDNAOf(d: ForgeDNA): PlanetDNA {
  const climate: PlanetDNA['climate'] = d.cold >= 0.6 ? 'frozen'
    : (d.heat - d.cold > 0.2 || (d.water < 0.32 && d.heat > 0.5)) ? 'desert' : 'temperate';
  const oceans: PlanetDNA['oceans'] = d.water >= 0.66 ? 'ocean_world' : d.water <= 0.34 ? 'barren' : 'mixed';
  const unrest = (1 - d.stability) + d.heat * 0.2 + d.toxic * 0.1;
  const chaos: PlanetDNA['chaos'] = unrest >= 0.78 ? 'storm' : unrest >= 0.5 ? 'turbulent' : 'serene';
  return { climate, oceans, chaos };
}

export function modsOf(d: ForgeDNA): ForgeMods {
  const tempo = 0.75 + d.mutation * 0.7 + (1 - d.stability) * 0.2;
  const catastrophe = Math.max(0.3, Math.min(2, 0.55 + (1 - d.stability) * 0.9 + d.toxic * 0.4 + d.heat * 0.25 - d.shield * 0.45));
  const assist = Math.max(-0.15, Math.min(0.35, d.fertile * 0.35 + d.shield * 0.12 + d.air * 0.06 - d.toxic * 0.16 - 0.17));
  return { tempo: +tempo.toFixed(3), catastrophe: +catastrophe.toFixed(3), assist: +assist.toFixed(3) };
}

/** 0..1: how good a cradle for life the forces made. */
export function lifePotential(d: ForgeDNA): number {
  return clamp01(d.fertile * 0.55 + d.water * 0.15 + d.shield * 0.15 + d.air * 0.1 - d.toxic * 0.25 - Math.abs(d.heat - d.cold) * 0.1 + 0.1);
}

function band<T>(v: number, cuts: number[], words: T[]): T {
  for (let i = 0; i < cuts.length; i++) if (v < cuts[i]) return words[i];
  return words[words.length - 1];
}

export function resolveForge(s: ForgeState): ForgeOutcome {
  const d = s.dna;
  const destiny = destinyOf(d);
  const unveiled = s.played.filter(c => c.hidden).map(c => c.hidden!);
  const gravity = band(d.mass, [0.3, 0.45, 0.6, 0.75], ['Feather-light', 'Gentle', 'Familiar', 'Heavy', 'Crushing']);
  const airWord = band(d.air, [0.3, 0.45, 0.65, 0.8], ['Thin', 'Light', 'Breathable-thick', 'Dense', 'Smothering']);
  const airTaste = d.toxic >= 0.66 ? 'and poisonous' : d.toxic >= 0.5 ? 'and sharp' : 'and clean';
  const shieldWord = band(d.shield, [0.35, 0.55, 0.72], ['Weak', 'Steady', 'Strong', 'Unbreakable']);
  const volcanic = d.heat >= 0.62;
  const surface = destiny === 'ocean'
    ? (d.water >= 0.74 ? 'A world-ocean, a few islands rising out of it' : volcanic ? 'Vast oceans broken by volcanic continents' : 'Wide seas around old continents')
    : destiny === 'ice'
      ? (d.heat >= 0.55 ? 'Ice sheets over a hidden, warm sea' : 'Glaciers from pole to pole')
      : destiny === 'desert'
        ? (d.minerals >= 0.62 ? 'Dunes and glassy plains over metal-rich rock' : 'Endless dunes under a hard sky')
        : (volcanic ? 'Raw highlands, split by lava fields' : d.mass <= 0.4 ? 'Towering mountains on a light world' : 'Stone plains and shallow, scattered seas');
  const climate = d.cold >= 0.66 ? (d.stability >= 0.55 ? 'Frozen and still' : 'Frozen, with savage storms')
    : d.heat - d.cold > 0.25 ? (d.water >= 0.55 ? 'Hot and steaming' : 'Searing')
    : d.stability < 0.38 ? 'Unstable, but habitable'
    : d.stability > 0.62 ? 'Mild and steady'
    : 'Restless seasons';
  const geology = band(d.heat * 0.7 + (1 - d.stability) * 0.3, [0.35, 0.55, 0.7], ['Quiet', 'Active', 'Very active', 'Extremely active'])
    + (d.minerals >= 0.66 ? ', rich in metals' : '');
  const lp = lifePotential(d);
  const life = band(lp, [0.32, 0.48, 0.64], ['Faint', 'Possible', 'Promising', 'Exceptional']);
  const traits: Array<[string, string]> = [
    ['Gravity', gravity],
    ['Atmosphere', `${airWord} ${airTaste}`],
    ['Sky shield', shieldWord],
    ['Surface', surface],
    ['Climate', climate],
    ['Geology', geology],
    ['Life potential', life],
  ];
  let unusual: string | null = null;
  if (unveiled.length) unusual = 'Something about this world is... unusual.';
  else if (d.mutation >= 0.74) unusual = 'Whatever lives here will not stay the same for long.';
  else if (d.toxic >= 0.7 && lp >= 0.45) unusual = 'Life here will have to become strange.';
  else if (d.stability <= 0.25) unusual = 'Nothing about this world is settled. Not yet.';
  return { destiny, planetDNA: planetDNAOf(d), mods: modsOf(d), traits, unusual, unveiled };
}

// ─── Cooling and the spark ────────────────────────────────────────────────────

export function beginCooling(s: ForgeState, now: number): void {
  if (s.phase !== 'reveal') return;
  s.phase = 'cooling';
  s.coolingStart = now;
  s.coolingDone = 0;
}

/** Seconds of cooling left (0 when the whisper is due). */
export function coolingLeft(s: ForgeState, now: number): number {
  if (s.phase !== 'cooling') return 0;
  return Math.max(0, COOLING_SECONDS - s.coolingDone - (now - s.coolingStart) / 1000);
}

/** Where the spark wakes life: chance, leaning on what the world is. */
export function rollCradle(s: ForgeState, rng: SeedRNG): string {
  const d = s.dna;
  const cradles: Array<[string, number]> = [
    ['in the deep vents, where the core still breathes', 1 + d.heat * 3],
    ['in warm tidal pools, under a pull of tides', 1 + d.water * 2 + d.fertile],
    ['in a sea hidden beneath the ice', d.cold * 3],
    ['in the shallow seas along the first shores', 1 + d.water * 2],
    ['in films of clay, wet and warm', 0.6 + d.minerals * 1.5],
    ['high in the clouds, on drops of acid rain', d.air * d.toxic * 3],
    ['inside the dust of a fallen comet', 0.4 + d.mutation],
  ];
  let total = 0;
  for (const [, w] of cradles) total += w;
  let pick = rng.next() * total;
  for (const [c, w] of cradles) { pick -= w; if (pick < 0) return c; }
  return cradles[0][0];
}

/**
 * Bio tempo for the life the spark wakes: pure chance (~0.45..2.2). The forged
 * mutation pressure rides on top as ForgeMods.tempo, applied by the engine.
 */
export function sparkTempo(rng: SeedRNG): number {
  return +Math.exp((rng.next() - 0.5) * 1.6).toFixed(3);
}
