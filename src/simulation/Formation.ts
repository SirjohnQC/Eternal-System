/**
 * Planet formation lifecycle for the player's home world
 * (docs/superpowers/specs/2026-10-04-planet-formation-lifecycle-design.md).
 *
 * The seed rolls a DESTINY — what the world is meant to finish as — and a total
 * formation budget. The world is born molten and walks a ladder of stages sized
 * for that destiny; the stages share the budget. Life may arrive part-way and
 * hasten the ladder (capped), but never changes where it ends.
 *
 * Pure: no engine, no DOM. BigBangEngine owns the state on StarBody and calls in.
 */
import type { PlanetFormationStage } from './BigBangEngine';

export type DestinyType = 'ocean' | 'rocky' | 'ice' | 'desert';

/** Ocean and rocky are common; ice and desert are possible at lower weight. */
export const DESTINY_WEIGHTS: Record<DestinyType, number> = {
  ocean: 40, rocky: 36, ice: 12, desert: 12,
};

export const DESTINY_TYPES = Object.keys(DESTINY_WEIGHTS) as DestinyType[];

export function isDestinyType(t: unknown): t is DestinyType {
  return typeof t === 'string' && t in DESTINY_WEIGHTS;
}

/** `next` returns a float in [0, 1). */
export function rollDestiny(next: () => number): DestinyType {
  let total = 0;
  for (const t of DESTINY_TYPES) total += DESTINY_WEIGHTS[t];
  let pick = next() * total;
  for (const t of DESTINY_TYPES) {
    pick -= DESTINY_WEIGHTS[t];
    if (pick < 0) return t;
  }
  return 'ocean';
}

/**
 * Stage ladders per destiny. Weights are each stage's share of the budget.
 * An ocean world cools, grows air, then fills a primordial sea; a rocky world
 * settles into highland crust under thin air; an ice world freezes over.
 */
export const FORMATION_LADDERS: Record<DestinyType, ReadonlyArray<{ stage: PlanetFormationStage; weight: number }>> = {
  ocean:  [{ stage: 'magma', weight: 1.0 }, { stage: 'cooling', weight: 1.0 }, { stage: 'volcanic', weight: 1.2 },
           { stage: 'atmosphere', weight: 1.0 }, { stage: 'primordial', weight: 1.3 }],
  rocky:  [{ stage: 'magma', weight: 1.0 }, { stage: 'cooling', weight: 1.1 }, { stage: 'volcanic', weight: 1.4 },
           { stage: 'atmosphere', weight: 1.2 }],
  ice:    [{ stage: 'magma', weight: 1.0 }, { stage: 'cooling', weight: 1.0 }, { stage: 'atmosphere', weight: 1.0 },
           { stage: 'ice_age', weight: 1.6 }],
  desert: [{ stage: 'magma', weight: 1.0 }, { stage: 'cooling', weight: 1.0 }, { stage: 'volcanic', weight: 1.5 },
           { stage: 'atmosphere', weight: 1.2 }],
};

/**
 * Normal mode's fixed pace, as the engine's speed multiplier (settled ticks
 * per wall-clock second). 2x the old default 1x.
 */
export const NORMAL_PACE = 2;

/**
 * One "player day" of the spec, in sim ticks at Normal pace.
 *
 * Decision 2026-10-04: a player day is one HOUR of play at Normal pace, not
 * 24 real hours (almost no one would ever see a world finish) and not an
 * in-game day (a few minutes — formation would be a loading screen). Time only
 * passes while the game runs, and saves keep it. Retune here.
 */
export const PLAYER_DAY_TICKS = 3600 * NORMAL_PACE;

/** The budget is uniform-random in [MIN, MAX] player days, rolled once. */
export const FORMATION_MIN_DAYS = 1;
export const FORMATION_MAX_DAYS = 3;

export function rollFormationBudget(next: () => number): number {
  const days = FORMATION_MIN_DAYS + next() * (FORMATION_MAX_DAYS - FORMATION_MIN_DAYS);
  return Math.round(days * PLAYER_DAY_TICKS);
}

export function ladderOf(destiny: DestinyType): PlanetFormationStage[] {
  return FORMATION_LADDERS[destiny].map(s => s.stage);
}

/** Ticks of progress the given stage needs, for this destiny and budget. */
export function stageDuration(destiny: DestinyType, budget: number, stage: PlanetFormationStage): number {
  const ladder = FORMATION_LADDERS[destiny];
  let sum = 0, w = 0;
  for (const s of ladder) { sum += s.weight; if (s.stage === stage) w = s.weight; }
  return w > 0 ? Math.max(1, Math.round(budget * w / sum)) : 0;
}

/** Stage after `stage` on this destiny's ladder, or null at the last one. */
export function nextStage(destiny: DestinyType, stage: PlanetFormationStage): PlanetFormationStage | null {
  const l = ladderOf(destiny);
  const i = l.indexOf(stage);
  return i >= 0 && i < l.length - 1 ? l[i + 1] : null;
}

/** 0..1 through the whole ladder, given the current stage and its progress. */
export function formationFraction(
  destiny: DestinyType, budget: number, stage: PlanetFormationStage, progress: number,
): number {
  let done = 0;
  for (const s of ladderOf(destiny)) {
    const d = stageDuration(destiny, budget, s);
    if (s === stage) { done += Math.min(d, progress); break; }
    done += d;
  }
  return budget > 0 ? Math.min(1, done / budget) : 1;
}

/**
 * Life can take hold once the crust is solid and volatile-rich: the third rung
 * onward (volcanic for most ladders, atmosphere for ice). Not on a magma ocean.
 */
export function lifeEligible(destiny: DestinyType, stage: PlanetFormationStage): boolean {
  return ladderOf(destiny).indexOf(stage) >= 2;
}

/**
 * How life hastens formation. Life present = +LIFE_BOOST rate; each further
 * seeding event (a second meteor, more ejecta) adds SEED_BOOST, up to
 * MAX_BOOST. The ladder never runs faster than (1 + MAX_BOOST)x, so a meteor
 * cannot finish a three-day world in minutes — at most it halves what is left.
 */
export const LIFE_BOOST = 0.5;
export const SEED_BOOST = 0.15;
export const MAX_BOOST = 1.0;

export function addBoost(current: number, amount: number): number {
  return Math.min(MAX_BOOST, Math.max(0, current) + amount);
}

/**
 * What the world LOOKS like during a stage — the planet type its surface is
 * drawn as. Molten worlds share one young face; the destiny shows only once
 * the sea (or ice) arrives, and fully when formation ends.
 */
export function formationFaceType(stage: PlanetFormationStage, destiny: DestinyType): DestinyType | 'lava' {
  switch (stage) {
    case 'magma':
    case 'cooling':
    case 'volcanic':
      return 'lava';
    case 'atmosphere':
      return destiny === 'ocean' || destiny === 'ice' ? 'rocky' : destiny;
    case 'ice_age':
      return 'ice';
    case 'primordial':
      return destiny;
  }
}

/**
 * Heat of the molten face for the diorama: 1 = magma ocean, falling as the
 * crust cools and the volcanic era quiets. 0 for every later stage.
 */
export function formationHeat(stage: PlanetFormationStage | null): number {
  return stage === 'magma' ? 1 : stage === 'cooling' ? 0.55 : stage === 'volcanic' ? 0.28 : 0;
}

/** Per-check chance of spontaneous abiogenesis on an eligible world. */
export function spontaneousLifeChance(stageTicks: number, checkEvery: number): number {
  // Expected wait about one and a half stage-lengths, so many worlds wake on
  // their own before formation ends, and some only after.
  return stageTicks > 0 ? Math.min(1, checkEvery / (stageTicks * 1.5)) : 0;
}

/** Per-check chance that debris from a living neighbour within range seeds life. */
export function ejectaChance(budget: number, checkEvery: number, distance: number, range: number): number {
  if (distance >= range || budget <= 0) return 0;
  const near = 1 - distance / range;
  return Math.min(1, (checkEvery / budget) * 1.2 * near * near);
}
