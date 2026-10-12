/**
 * Sovereignty — who rules a colony world, and how that changes (design:
 * docs/plans/2026-10-12-expansion-and-divergence.md, phase P3).
 *
 * Nobody decrees any of it:
 *
 * - LOYALTY follows contact and kinship. A colony in its founder's own system,
 *   still the same people, stays loyal; a far one whose people have become a
 *   subspecies or a species of their own drifts away and, once loyalty is low
 *   enough, BREAKS AWAY. A colony whose ruler is gone governs itself.
 *   (Owner, 2026-10-12: the player's colonies are the player's until they
 *   break away.)
 * - CONQUEST is an outcome of the wars the polities already wage: a clear
 *   victory can OCCUPY one of the loser's worlds, a colony or (for other
 *   civilisations) its home world. The native people stay: two peoples on one
 *   world. Each generation the occupier's HOLD rises with its advantage and
 *   falls with the natives' numbers; it ends in liberation or, for a colony,
 *   absorption into the conqueror's realm. (Owner: other civilisations
 *   colonise and conquer too, including the player's worlds.)
 *
 * Pure: plain JSON on the colony record, no engine or DOM. Every new field is
 * optional, so older saves load as "ruled by the founder, never occupied".
 */
import type { Colony, ColonyStatus } from './Colonies';
import type { DivergenceStage } from './Divergence';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// ── Who rules ───────────────────────────────────────────────────────────────

/** A world that rules itself: `rulerStarId` sentinel. */
export const SELF_RULED = -1;

/** The star whose people rule the colony now, or null when it rules itself. */
export function rulerOf(c: Colony): number | null {
  if (c.rulerStarId === undefined) return c.founderStarId;
  return c.rulerStarId === SELF_RULED ? null : c.rulerStarId;
}

/** Whether the player's people rule it now (founded, or taken and held). */
export function ruledByPlayer(c: Colony): boolean {
  if (c.rulerStarId === undefined) return c.byPlayer;
  return c.rulerStarId !== SELF_RULED && !!c.rulerIsPlayer;
}

/** Whether the player has a stake in it: theirs now, founded by them, or theirs before it was taken. */
export function concernsPlayer(c: Colony): boolean {
  return c.byPlayer || ruledByPlayer(c) || !!c.occupation?.prevByPlayer;
}

// ── Loyalty and independence ────────────────────────────────────────────────

/** Below this, a colony may break away. */
export const BREAK_AT = 0.25;
/** Share of the gap to its target loyalty closed per generation. */
export const LOYALTY_RATE = 0.08;
/** How much a people's becoming its own costs the tie to its rulers. */
const STAGE_PULL: Record<DivergenceStage, number> = { same: 0, variant: 0.05, subspecies: 0.15, species: 0.35 };

/** The loyalty a colony settles toward: contact with its rulers, less what it has become. */
export function loyaltyTarget(contact: number, stage: DivergenceStage, rulerPresent: boolean): number {
  if (!rulerPresent) return 0;
  return clamp01(0.3 + 0.8 * clamp01(contact) - STAGE_PULL[stage]);
}

/**
 * One generation of loyalty for a ruled colony (not occupied, not already
 * independent). Returns 'independent' when it breaks away. `contact` is with
 * its RULERS (not gene flow); `roll` is 0..1. Outposts are too small to stand
 * alone unless their rulers are gone.
 */
export function stepLoyalty(c: Colony, contact: number, rulerPresent: boolean, tick: number, roll: number): 'independent' | null {
  if (c.occupation || c.status === 'independent' || c.status === 'occupied') return null;
  if (!rulerPresent) { declareIndependence(c, tick); return 'independent'; }
  const target = loyaltyTarget(contact, c.stage ?? 'same', true);
  c.loyalty = clamp01(c.loyalty + (target - c.loyalty) * LOYALTY_RATE);
  if (c.status === 'colony' && c.loyalty < BREAK_AT && roll < (BREAK_AT - c.loyalty) / BREAK_AT) {
    declareIndependence(c, tick);
    return 'independent';
  }
  return null;
}

export function declareIndependence(c: Colony, tick: number): void {
  c.rulerStarId = SELF_RULED;
  c.rulerIsPlayer = false;
  c.status = 'independent';
  c.independentSince = tick;
  c.loyalty = 0;
  delete c.occupation;
}

// ── Occupation ──────────────────────────────────────────────────────────────

export interface Occupation {
  byStarId: number;
  byPlayer: boolean;
  since: number;
  /** 0..1 the occupier's grip: 0 → liberated, 1 → absorbed (colonies only). */
  hold: number;
  /** Who ruled it before (null: itself), and its standing then. */
  prevRulerStarId: number | null;
  prevByPlayer: boolean;
  prevStatus: ColonyStatus;
  /** The natives' own home world (a civilisation's world, not a colony). Never absorbed. */
  homeWorld: boolean;
}

export const HOLD_START = 0.5;
/** A home world's people are never absorbed: the grip tops out here. */
export const HOME_HOLD_MAX = 0.95;

/** Occupy an existing colony: its people stay, a conqueror rules them. */
export function occupyColony(c: Colony, by: { starId: number; isPlayer: boolean }, tick: number): void {
  c.occupation = {
    byStarId: by.starId, byPlayer: by.isPlayer, since: tick, hold: HOLD_START,
    prevRulerStarId: rulerOf(c), prevByPlayer: ruledByPlayer(c),
    prevStatus: c.status === 'occupied' ? (c.occupation?.prevStatus ?? 'colony') : c.status,
    homeWorld: false,
  };
  c.rulerStarId = by.starId;
  c.rulerIsPlayer = by.isPlayer;
  c.status = 'occupied';
}

/** What the engine knows about an occupation this generation. */
export interface OccupationInputs {
  /** -1..1 the occupier's edge over the natives (eras apart / 3). */
  advantage: number;
  /** The occupier still exists and can reach the world. */
  occupierPresent: boolean;
}

/** Per generation: the drift of the hold. */
const HOLD_BASE = 0.06, HOLD_ADVANTAGE = 0.12, HOLD_RESIST = 0.16, HOLD_NOISE = 0.04, HOLD_GONE = 0.3;

/**
 * One generation of occupation. The natives resist by their numbers (a whole
 * home world resists fully); an occupier with an edge tightens its grip, one
 * that is gone loses it. Returns how it ended, if it did.
 */
export function stepOccupation(c: Colony, f: OccupationInputs, roll: number): 'liberated' | 'absorbed' | null {
  const o = c.occupation;
  if (!o) return null;
  const resist = o.homeWorld ? 1 : clamp01(c.population);
  const drift = HOLD_BASE + HOLD_ADVANTAGE * Math.max(-1, Math.min(1, f.advantage))
    - HOLD_RESIST * resist - (f.occupierPresent ? 0 : HOLD_GONE) + (roll - 0.5) * 2 * HOLD_NOISE;
  o.hold = Math.min(o.homeWorld ? HOME_HOLD_MAX : 1, Math.max(0, o.hold + drift));
  if (o.hold <= 0) return 'liberated';
  if (o.hold >= 1 && !o.homeWorld) return 'absorbed';
  return null;
}

/**
 * Ending an occupation. Liberated: back to its former rulers if they still
 * exist (`prevRulerAlive`), else it rules itself; a home world's record is
 * simply dropped by the caller. Absorbed: the conqueror's colony now.
 */
export function endOccupation(c: Colony, how: 'liberated' | 'absorbed', prevRulerAlive: boolean, tick: number): void {
  const o = c.occupation;
  if (!o) return;
  delete c.occupation;
  if (how === 'absorbed') {
    c.status = 'colony';
    c.loyalty = 0.4;
    return;
  }
  if (o.prevRulerStarId == null || !prevRulerAlive) { declareIndependence(c, tick); return; }
  c.rulerStarId = o.prevRulerStarId;
  c.rulerIsPlayer = o.prevByPlayer;
  c.status = o.prevStatus === 'outpost' ? 'outpost' : 'colony';
  c.loyalty = Math.max(c.loyalty, 0.7);
}

/** How likely a won war takes a world: by the victory's margin. 0..0.85. */
export function conquestChance(margin: number): number {
  return Math.max(0, Math.min(0.85, (margin + 0.1) * 1.5));
}
