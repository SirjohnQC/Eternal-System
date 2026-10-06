/**
 * LifeSystem — habitability, biochemistry archetypes, and the Great Filters that
 * make life across the universe genuinely unpredictable.
 *
 * ── The problem this replaces ─────────────────────────────────────────────────
 * Life used to be a boolean on a star that, once set, marched up a fixed ladder
 * (microbial → multicellular → complex → primitive → intelligent) on a fixed
 * clock. Every living world took the same path at the same speed and nothing
 * ever failed, so the universe was completely predictable: you always knew how
 * many worlds would wake up and roughly when.
 *
 * ── The model ────────────────────────────────────────────────────────────────
 * 1. HABITABILITY — a world's planets, the star's temperature, and the orbital
 *    distance produce a 0–1 score. It gates how likely life is to start at all
 *    and how hard the filters bite afterwards.
 *
 * 2. BIOCHEMISTRY — each biosphere gets an archetype (carbon/water, cryogenic
 *    ammonia, silicate thermophile, aerial, endolith). Archetypes shift which
 *    worlds are viable, how fast evolution runs, and how far a lineage can
 *    plausibly climb. A methane biosphere on an ice moon is a real outcome; it
 *    just very rarely reaches intelligence.
 *
 * 3. TEMPO — every biosphere rolls its own speed multiplier from a heavy-tailed
 *    distribution. Two identical worlds can be 10× apart in how fast they climb.
 *
 * 4. GREAT FILTERS — every phase transition is a roll, not a certainty. It can
 *    ADVANCE, BURST (skip a phase outright), STALL (sit in this phase far longer,
 *    permanently — some worlds stay microbial forever), or COLLAPSE (mass
 *    extinction back a phase, or total sterilisation at the bottom).
 *
 * Everything here is a pure function of its arguments plus the injected SeedRNG,
 * so the simulation stays fully deterministic per universe seed.
 */

import type { SeedRNG } from '../utils/SeedRNG';
import type { BiologyPhase } from './GameState';
import { BIO_PHASE_SEQUENCE } from './GameState';

export type PlanetKind =
  | 'rocky' | 'ocean' | 'gas' | 'ice' | 'lava'
  | 'toxic' | 'crystal' | 'desert' | 'storm' | 'carbon';

// ─── Biochemistry archetypes ──────────────────────────────────────────────────

export type LifeArchetype =
  | 'carbon_water'      // the familiar one — fast, versatile, common
  | 'cryo_ammonia'      // liquid ammonia under ice; slow, patient
  | 'silicate_thermo'   // high-temperature mineral metabolism; very slow, very tough
  | 'aerial_float'      // buoyant colonies in a gas envelope; rarely builds anything
  | 'lithic_endolith';  // rock-boring chemoautotrophs; nearly unkillable, nearly static

export interface ArchetypeProfile {
  label: string;
  /** How well this chemistry suits each planet type (also the pick weight). */
  affinity: Record<PlanetKind, number>;
  /** Multiplies evolutionary speed. */
  tempo: number;
  /** Multiplies Great Filter severity — below 1 means it passes filters more easily. */
  filter: number;
  /**
   * The phase beyond which this chemistry struggles. Not a hard ceiling: past it
   * filters get much harsher, so climbing further is rare rather than impossible.
   */
  ceiling: BiologyPhase;
  /** Multiplies the chance of surviving a sterilising catastrophe. */
  resilience: number;
  /** Flavour line used in event text and Codex entries. */
  flavour: string;
}

export const ARCHETYPES: Record<LifeArchetype, ArchetypeProfile> = {
  carbon_water: {
    label: 'carbon–water',
    affinity: {
      ocean: 1.0, rocky: 0.85, ice: 0.20, lava: 0.05, gas: 0.10,
      toxic: 0.70, crystal: 0.40, desert: 0.50, storm: 0.45, carbon: 0.30,
    },
    tempo: 1.0, filter: 1.0, ceiling: 'intelligent', resilience: 1.0,
    flavour: 'Carbon chains in liquid water — the common solution.',
  },
  cryo_ammonia: {
    label: 'cryogenic ammonia',
    affinity: {
      ocean: 0.20, rocky: 0.15, ice: 1.0, lava: 0.0, gas: 0.25,
      toxic: 0.10, crystal: 0.20, desert: 0.05, storm: 0.15, carbon: 0.25,
    },
    tempo: 0.42, filter: 1.25, ceiling: 'primitive', resilience: 1.35,
    flavour: 'Slow chemistry in sub-zero ammonia seas beneath the ice.',
  },
  silicate_thermo: {
    label: 'silicate thermophile',
    affinity: {
      ocean: 0.05, rocky: 0.35, ice: 0.0, lava: 1.0, gas: 0.05,
      toxic: 0.20, crystal: 0.30, desert: 0.40, storm: 0.20, carbon: 0.50,
    },
    tempo: 0.30, filter: 1.45, ceiling: 'complex', resilience: 1.8,
    flavour: 'Mineral metabolism that treats molten rock as a solvent.',
  },
  aerial_float: {
    label: 'aerial',
    affinity: {
      ocean: 0.10, rocky: 0.05, ice: 0.10, lava: 0.05, gas: 1.0,
      toxic: 0.35, crystal: 0.10, desert: 0.15, storm: 0.70, carbon: 0.05,
    },
    tempo: 0.75, filter: 1.30, ceiling: 'complex', resilience: 0.8,
    flavour: 'Buoyant colonies drifting in a bottomless atmosphere.',
  },
  lithic_endolith: {
    label: 'endolithic',
    affinity: {
      ocean: 0.15, rocky: 0.55, ice: 0.35, lava: 0.30, gas: 0.0,
      toxic: 0.25, crystal: 0.80, desert: 0.45, storm: 0.20, carbon: 0.90,
    },
    tempo: 0.22, filter: 1.55, ceiling: 'multicellular', resilience: 2.4,
    flavour: 'Chemoautotrophs boring through rock, indifferent to the surface.',
  },
};

// ─── Habitability ─────────────────────────────────────────────────────────────

/** Baseline suitability of each planet type for any biochemistry at all. */
const TYPE_BASE: Record<PlanetKind, number> = {
  ocean:   1.00,
  rocky:   0.86,
  ice:     0.42,
  gas:     0.34,
  lava:    0.26,
  toxic:   0.72,
  crystal: 0.55,
  desert:  0.48,
  storm:   0.40,
  carbon:  0.38,
};

export interface HabitabilityInput {
  planetType: PlanetKind;
  orbitalRadius: number;
  starTemperature: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 0–1 habitability for a single planet.
 *
 * Three independent factors: what the planet is made of, whether it sits in its
 * star's liquid-water zone, and whether that star will live long enough for
 * anything to happen (hot blue stars burn out too fast; cold dwarfs flare).
 */
/** The goldilocks orbit for a star of this temperature (12 … 46). One formula for scoring and for placing the home world. */
export function idealOrbitRadius(starTemperature: number): number {
  return 12 + clamp01((starTemperature - 3000) / 27000) * 34;
}

export function planetHabitability(p: HabitabilityInput): number {
  const base = TYPE_BASE[p.planetType] ?? 0.3;

  // Goldilocks orbit scales with how much the star radiates.
  const idealR = idealOrbitRadius(p.starTemperature);
  const deviation = Math.abs(p.orbitalRadius - idealR) / idealR;
  const zone = clamp01(1 - deviation * 1.35);

  // Main-sequence lifetime: very hot stars die young, very cool ones are unstable.
  const stability = p.starTemperature > 15000 ? 0.42
                  : p.starTemperature > 10000 ? 0.72
                  : p.starTemperature < 3500  ? 0.68
                  : 1.0;

  return clamp01(base * (0.22 + 0.78 * zone) * stability);
}

/** Habitability of a star system = its most promising planet. */
export function systemHabitability(
  planets: HabitabilityInput[],
): { score: number; index: number } {
  let best = 0, index = 0;
  for (let i = 0; i < planets.length; i++) {
    const h = planetHabitability(planets[i]);
    if (h > best) { best = h; index = i; }
  }
  return { score: best, index };
}

// ─── Biochemistry selection ───────────────────────────────────────────────────

/** Weighted pick of the biochemistry that took hold on a given planet type. */
export function pickArchetype(planetType: PlanetKind, rng: SeedRNG): LifeArchetype {
  const keys = Object.keys(ARCHETYPES) as LifeArchetype[];
  let total = 0;
  const weights = keys.map(k => {
    const w = ARCHETYPES[k].affinity[planetType] ?? 0;
    total += w;
    return w;
  });
  if (total <= 0) return 'lithic_endolith';

  let roll = rng.next() * total;
  for (let i = 0; i < keys.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return keys[i];
  }
  return keys[keys.length - 1];
}

/**
 * Evolutionary tempo for a new biosphere.
 *
 * Heavy-tailed on purpose: most worlds cluster near 1×, but a meaningful slice
 * are 3–4× faster or slower. This is the single biggest source of "why did that
 * world wake up before mine?".
 */
export function rollBioTempo(rng: SeedRNG, archetype: LifeArchetype): number {
  const u = rng.next();
  // Log-uniform over roughly [0.28, 3.6]
  const raw = Math.exp((u - 0.5) * 2.55);
  return raw * ARCHETYPES[archetype].tempo;
}

// ─── Great Filters ────────────────────────────────────────────────────────────

/** How hard each step up the ladder is, before any modifiers. */
const BASE_FILTER: Record<BiologyPhase, number> = {
  // Getting past simple cells is the hardest early step.
  microbial:     0.46,
  multicellular: 0.36,
  complex:       0.38,
  // And then whether anything ever starts asking questions. Minds should be
  // rare enough that finding another one is an event, not a formality.
  primitive:     0.62,
  intelligent:   0,
};

export type FilterOutcome = 'advance' | 'burst' | 'stall' | 'collapse';

/** Fraction of filter failures that are mass extinctions rather than plain stalls. */
export const COLLAPSE_SHARE = 0.24;

/**
 * How much each accumulated stall lengthens the next attempt.
 *
 * This is what actually parks worlds at intermediate phases. A stall does not
 * forbid the jump, it just makes the world wait much longer for its next roll —
 * so at any moment the universe holds biospheres spread all across the ladder
 * rather than everything having either died or woken up.
 */
export const STALL_TIME_PENALTY = 1.5;

/**
 * Beyond this many stalls, waiting longer stops meaning anything.
 *
 * `STALL_TIME_PENALTY` is applied to an UNBOUNDED stall count, so each failure
 * stretches the next attempt further with no ceiling: a world on its tenth stall
 * waits 16× its base phase duration, on its twentieth 31×. For NPC worlds that
 * is the point — it is what parks biospheres across the whole ladder instead of
 * every world eventually waking up.
 *
 * For the PLAYER's world it is not acceptable: a diverging delay is a silent
 * game over. The player's world caps its stall count here, so the wait between
 * attempts plateaus at 7× instead of growing forever. NPC worlds are left
 * uncapped and keep their intended long tail.
 */
export const PLAYER_STALL_TIME_CAP = 4;

/**
 * Hard ceiling on the probability that a phase transition fails.
 *
 * `filterChance` multiplies five independent penalties together. Nothing bounded
 * the product below 1, and `resolveTransition` compares `rng.next()` (which is
 * always < 1) against it — so a world whose penalties multiplied out to 1.0
 * entered an ABSORBING state: every future roll was a stall or a collapse, for
 * the rest of the game, with no player lever able to escape it. Four of the five
 * biochemistries hit that state at the primitive→intelligent step at ordinary
 * habitability, which is the "stuck on primitive forever" bug.
 *
 * Capping here keeps every documented intent — hostile worlds are still brutally
 * unlikely to wake up — while guaranteeing the ladder always has a way up.
 */
export const MAX_FILTER_CHANCE = 0.985;

/**
 * Whether a biosphere survives a collapse that would push it below microbial.
 *
 * Simple cells are extraordinarily hard to eradicate — they live in rock, brine
 * and boiling vents. Treating every microbial-phase collapse as sterilisation
 * left the universe almost entirely dead, which is neither believable nor
 * interesting to play in. Total sterilisation stays possible but uncommon.
 */
export function survivesFloorCollapse(rng: SeedRNG, archetype: LifeArchetype): boolean {
  const base = 0.86 + (ARCHETYPES[archetype].resilience - 1) * 0.06;
  return rng.next() < Math.min(0.97, base);
}

export interface FilterContext {
  phase:        BiologyPhase;
  habitability: number;
  archetype:    LifeArchetype;
  /** How many times this world has already stalled here. */
  stalls:       number;
  /**
   * 0–1, reduces filter severity. The player's divine nudges feed in here, and
   * so does their DNA investment — see `BigBangEngine.updateBiologyPhase`.
   */
  assistance:   number;
}

/** Probability that a transition attempt fails in some way. */
export function filterChance(ctx: FilterContext): number {
  const profile = ARCHETYPES[ctx.archetype];
  let p = BASE_FILTER[ctx.phase] ?? 0.3;

  // Marginal worlds filter far harder than comfortable ones.
  p *= 0.55 + (1 - ctx.habitability) * 1.15;
  p *= profile.filter;

  // Past the chemistry's plausible ceiling, climbing further is rare.
  const ceilingIdx = BIO_PHASE_SEQUENCE.indexOf(profile.ceiling);
  const phaseIdx   = BIO_PHASE_SEQUENCE.indexOf(ctx.phase);
  if (phaseIdx >= ceilingIdx) p *= 2.3;

  // Repeated stalls represent a lineage that is genuinely stuck.
  p *= 1 + Math.min(ctx.stalls, 6) * 0.08;

  // Assistance is applied LAST and against the capped value, so a player who has
  // invested is always better off than one who has not — before the cap it could
  // be swallowed whole by a product that was already over 1.
  const capped = Math.min(p, MAX_FILTER_CHANCE);
  return clamp01(capped * (1 - clamp01(ctx.assistance) * 0.55));
}

/**
 * Resolve one attempt at the next phase.
 *
 * A failure is split between STALL (the common case: the world simply doesn't
 * make the jump and tries again much later) and COLLAPSE (a mass extinction that
 * costs the world a phase).
 */
export function resolveTransition(ctx: FilterContext, rng: SeedRNG): FilterOutcome {
  const p = filterChance(ctx);
  const roll = rng.next();

  if (roll < p * COLLAPSE_SHARE) return 'collapse';
  if (roll < p)                  return 'stall';

  // Punctuated equilibrium: an adaptive radiation that skips a whole phase.
  const profile = ARCHETYPES[ctx.archetype];
  const burstChance = 0.05 * ctx.habitability / profile.filter;
  if (rng.next() < burstChance) return 'burst';

  return 'advance';
}

// ─── Biosphere catastrophes ───────────────────────────────────────────────────

export type CatastropheKind =
  | 'gamma_burst' | 'impact_winter' | 'runaway_greenhouse'
  | 'snowball' | 'anoxic_event' | 'stellar_flare';

export interface Catastrophe {
  kind:      CatastropheKind;
  /** How many phases the biosphere loses. 99 = sterilised. */
  setback:   number;
  /** Permanent multiplier applied to the world's habitability. */
  habDamage: number;
  text:      string;
}

const CATASTROPHES: Catastrophe[] = [
  { kind: 'gamma_burst',        setback: 99, habDamage: 1.00,
    text: 'A gamma-ray burst stripped {name} to bare rock. Nothing survived.' },
  { kind: 'stellar_flare',      setback: 99, habDamage: 0.85,
    text: 'A superflare boiled the atmosphere off {name}. The biosphere is gone.' },
  { kind: 'impact_winter',      setback: 1,  habDamage: 0.96,
    text: 'An impact winter has collapsed the food web on {name}.' },
  { kind: 'runaway_greenhouse', setback: 1,  habDamage: 0.80,
    text: 'Runaway greenhouse warming has cooked the surface of {name}.' },
  { kind: 'snowball',           setback: 1,  habDamage: 0.90,
    text: '{name} has frozen over. Life clings on beneath the ice.' },
  { kind: 'anoxic_event',       setback: 2,  habDamage: 0.94,
    text: 'The oceans of {name} went anoxic. Most complex lineages died out.' },
];

/**
 * Roll a biosphere catastrophe. Returns null most of the time.
 *
 * @param sterilising  when false, only setbacks are drawn — used for the player's
 *                     world, which must never be silently wiped out from under them.
 */
export function rollCatastrophe(
  rng: SeedRNG,
  archetype: LifeArchetype,
  sterilising: boolean,
): Catastrophe | null {
  const pool = sterilising ? CATASTROPHES : CATASTROPHES.filter(c => c.setback < 99);
  const pick = pool[rng.nextInt(0, pool.length - 1)];

  // Tough chemistries shrug off events that would end a fragile biosphere.
  if (pick.setback === 99 && rng.next() < (ARCHETYPES[archetype].resilience - 1) * 0.35) {
    return { ...pick, kind: pick.kind, setback: 1, habDamage: pick.habDamage,
             text: `Life on {name} survived a ${pick.kind.replace('_', ' ')} that should have ended it.` };
  }
  return pick;
}

/** Human-readable phase name for event text. */
export function phaseLabel(phase: BiologyPhase): string {
  switch (phase) {
    case 'microbial':     return 'microbial';
    case 'multicellular': return 'multicellular';
    case 'complex':       return 'complex';
    case 'primitive':     return 'primitive';
    case 'intelligent':   return 'intelligent';
  }
}
