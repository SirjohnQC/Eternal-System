/**
 * Colonies — civilisations that leave their world (design:
 * docs/plans/2026-10-12-expansion-and-divergence.md, phase P1).
 *
 * Nobody orders a colony. A people that can reach space launches a ship when
 * its pressures push it (crowding, scarcity) and its culture lets it
 * (curiosity), toward the best world it can reach. The ship is an engine
 * fleet; at landfall the settlement takes hold or fails on a poor world, then
 * grows or dies out by how well the world suits it.
 *
 * What a people can do grows with what it knows (`capabilityOf`): Space Age
 * rocketry reaches only its own system and plants small outposts; orbital
 * stations reach other stars; the colony ark founds full colonies. A
 * settlement grows to what its founder can CURRENTLY sustain, so an old
 * outpost fills out once its people learn more.
 *
 * A player colony carries its own copy of the founding species (`lineage`).
 * Phase P2 evolves that copy under the colony world's conditions, so a people
 * that lives there long enough becomes its own variant.
 *
 * Pure: plain JSON state, no engine or DOM. The engine supplies the views and
 * a deterministic random source.
 */
import type { SpeciesGenome } from './SpeciesGenome';
import type { CultureValues } from './Civilization';
import type { PolityPressures } from './StarPolities';
import { reachOf } from './StarPolities';
import {
  type Adaptations, type DivergenceStage, type WorldEnv,
  NO_ADAPTATION, optimumFor, generationStep, distanceFromHome, stageOf, describe,
} from './Divergence';
import { type Occupation, rulerOf } from './Sovereignty';

/** 'independent' and 'occupied' are P3 (Sovereignty.ts). */
export type ColonyStatus = 'outpost' | 'colony' | 'independent' | 'occupied';

export interface Colony {
  id: string;
  /** Where it lives. */
  starId: number;
  planetIndex: number;
  name: string;
  /** Who sent it, and whether that was the player's people. */
  founderStarId: number;
  byPlayer: boolean;
  foundedTick: number;
  /** 0..1 of what the world can hold. */
  population: number;
  /** 0..1 how well the world suits its people (habitability for them). */
  suitability: number;
  status: ColonyStatus;
  /** The colonists' own copy of the founding species (player colonies; P2 evolves it). */
  lineage: SpeciesGenome | null;
  homeLineageId: string | null;
  /** The founder's capability tier last seen (1 outposts … 3 full colonies). */
  tier: CapabilityTier;
  /** Evolution steps lived on the colony world (P2). */
  generations: number;
  /** 0..1 traffic with the founder: gene flow and loyalty (P2/P3). */
  contact: number;
  loyalty: number;
  /** P2 divergence: heritable adaptations to this world (absent in older saves = none). */
  adaptations?: Adaptations;
  /** Tick of the last generation lived here. */
  lastGenTick?: number;
  /** How far the people here have become their own (Divergence.ts). */
  stage?: DivergenceStage;
  /**
   * P3 (Sovereignty.ts): who rules it when that is no longer its founder —
   * another star's people, or SELF_RULED (-1). Absent = its founder.
   */
  rulerStarId?: number;
  rulerIsPlayer?: boolean;
  independentSince?: number;
  /** Set when the record was made by conquest (another people's home world), not by an ark. */
  seizedTick?: number;
  /** A conqueror holds it; the natives remain (Sovereignty.ts). */
  occupation?: Occupation;
}

export interface ColonyState {
  colonies: Colony[];
  /** Tick of each civilisation's last launch, by star id. */
  lastLaunch: Record<number, number>;
  nextId: number;
}

export const emptyColonies = (): ColonyState => ({ colonies: [], lastLaunch: {}, nextId: 1 });

/** A civilisation that might launch, as the engine sees it this step. */
export interface Launcher {
  starId: number;
  x: number; y: number;
  era: number;
  techs: readonly string[];
  pressures: PolityPressures;
  values: CultureValues;
  isPlayer: boolean;
}

/** A world an ark could reach and settle. */
export interface Candidate {
  starId: number;
  planetIndex: number;
  name: string;
  x: number; y: number;
  /** 0..1 habitability of the planet for the settlers. */
  suitability: number;
}

// ── Capability: what a people's knowledge lets it do off-world ──────────────
export type CapabilityTier = 0 | 1 | 2 | 3;
export interface Capability {
  tier: CapabilityTier;
  /** Only its own star system (no interstellar travel yet). */
  ownSystemOnly: boolean;
  landfallMult: number;
  growthMult: number;
  /** Population a settlement can reach, 0..1 of its world's capacity. */
  popCap: number;
  /** Settlements (and ships in flight) it keeps at most. */
  maxSettlements: number;
  /** What its ships are called in the news. */
  ship: string;
}
const NONE: Capability = { tier: 0, ownSystemOnly: true, landfallMult: 0, growthMult: 0, popCap: 0, maxSettlements: 0, ship: '' };
const CAPABILITIES: Array<{ tech: string; cap: Capability }> = [
  { tech: 'colony_ark', cap: { tier: 3, ownSystemOnly: false, landfallMult: 1,    growthMult: 1,   popCap: 1,   maxSettlements: 4, ship: 'colony ark' } },
  { tech: 'orbital',    cap: { tier: 2, ownSystemOnly: false, landfallMult: 0.85, growthMult: 0.7, popCap: 0.6, maxSettlements: 3, ship: 'settler ship' } },
  { tech: 'rocketry',   cap: { tier: 1, ownSystemOnly: true,  landfallMult: 0.7,  growthMult: 0.4, popCap: 0.2, maxSettlements: 2, ship: 'outpost ship' } },
];

/** The best off-world capability a set of technologies gives. */
export function capabilityOf(techs: readonly string[]): Capability {
  for (const c of CAPABILITIES) if (techs.includes(c.tech)) return c.cap;
  return NONE;
}
export function capabilityOfTier(tier: CapabilityTier): Capability {
  return CAPABILITIES.find(c => c.cap.tier === tier)?.cap ?? NONE;
}

// ── Tuning ──────────────────────────────────────────────────────────────────
/** The technology that founds full colonies. */
export const ARK_TECH = 'colony_ark';
/** Ticks between one civilisation's launches. */
export const LAUNCH_COOLDOWN = 12_000;
/** Settlements (and ships in flight) one civilisation keeps at most, at its best tier. */
export const MAX_PER_CIV = 4;
/** Colonies in the whole universe at most — keeps the simulation bounded. */
export const MAX_TOTAL = 60;
/** A world below this suitability is not worth an ark. */
export const MIN_SUITABILITY = 0.25;
/** Growth per polity step at suitability 1. */
const GROWTH = 0.06;
/** Population at landfall. */
const FOUNDING_POP = 0.04;
/** Population at which an outpost counts as a colony. */
const COLONY_AT = 0.25;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * How strongly a civilisation wants to send an ark now, 0..1.
 * Zero without the ark technology. Crowding drives it most; scarcity and a
 * curious culture add to it; a xenophobic culture holds it back a little
 * (an empty world is still attractive to a people that dislikes neighbours).
 */
export function launchDrive(l: Launcher): number {
  if (capabilityOf(l.techs).tier === 0) return 0;
  const p = l.pressures;
  const push = 0.55 * p.crowding + 0.25 * p.scarcity + 0.1 * p.hunger;
  const pull = 0.35 * l.values.curiosity - 0.1 * l.values.xenophobia;
  return clamp01(push + pull);
}

/**
 * The world a ship from `l` heads for: the best suitability, discounted by
 * distance; within the civilisation's reach (its own system only before
 * interstellar travel); never a world that already holds a settlement or a
 * ship bound for it.
 */
export function pickTarget(
  l: Launcher, candidates: readonly Candidate[], taken: ReadonlySet<string>,
): Candidate | null {
  const cap = capabilityOf(l.techs);
  if (cap.tier === 0) return null;
  const reach = cap.ownSystemOnly ? 0 : reachOf(l.era);
  let best: Candidate | null = null, bestScore = 0;
  for (const c of candidates) {
    if (c.suitability < MIN_SUITABILITY || taken.has(siteKey(c.starId, c.planetIndex))) continue;
    const d = Math.hypot(c.x - l.x, c.y - l.y);
    if (d > reach && c.starId !== l.starId) continue;
    // Near worlds first; a curious people discounts distance less.
    const score = c.suitability / (1 + d / (600 + 900 * l.values.curiosity));
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

export const siteKey = (starId: number, planetIndex: number) => `${starId}:${planetIndex}`;

/** Sites already settled. Callers add the targets of arks in flight. */
export function takenSites(state: ColonyState): Set<string> {
  return new Set(state.colonies.map(c => siteKey(c.starId, c.planetIndex)));
}

/** How many colonies a civilisation has (by its star). */
/** Settlements a civilisation founded by ship (not worlds it seized from another people). */
export function coloniesOf(state: ColonyState, founderStarId: number): number {
  return state.colonies.filter(c => c.founderStarId === founderStarId && c.seizedTick == null).length;
}

/** Does the ship take hold? A poor world often fails, and early ships more often. `roll` is 0..1. */
export function landfallSucceeds(suitability: number, roll: number, cap: Capability = capabilityOfTier(3)): boolean {
  return roll < clamp01((0.25 + suitability) * cap.landfallMult);
}

/** Found a colony at landfall. */
export function foundColony(
  state: ColonyState,
  site: Candidate,
  founder: { starId: number; isPlayer: boolean; lineage: SpeciesGenome | null; tier?: CapabilityTier },
  tick: number,
): Colony {
  const lineage = founder.lineage ? JSON.parse(JSON.stringify(founder.lineage)) as SpeciesGenome : null;
  const c: Colony = {
    id: `col${state.nextId++}`,
    starId: site.starId, planetIndex: site.planetIndex, name: site.name,
    founderStarId: founder.starId, byPlayer: founder.isPlayer,
    foundedTick: tick,
    population: FOUNDING_POP,
    suitability: clamp01(site.suitability),
    status: 'outpost',
    tier: founder.tier ?? 3,
    lineage,
    homeLineageId: founder.lineage?.id ?? null,
    generations: 0,
    contact: 1,
    loyalty: 1,
  };
  state.colonies.push(c);
  return c;
}

export type ColonyNews =
  | { kind: 'grew'; colony: Colony }
  | { kind: 'died-out'; colony: Colony };

/**
 * One polity step for every settlement: growth toward what its founder can
 * sustain (the founder's CURRENT capability, else the tier it last had), at a
 * rate set by suitability; a world that cannot hold them shrinks them.
 * `alive(starId)` is false for a dead star; `founderTier` is null when the
 * founder is not an active civilisation this step.
 */
export function stepColonies(
  state: ColonyState,
  alive: (starId: number) => boolean,
  founderTier: (founderStarId: number) => CapabilityTier | null = () => null,
): ColonyNews[] {
  const news: ColonyNews[] = [];
  for (let i = state.colonies.length - 1; i >= 0; i--) {
    const c = state.colonies[i];
    if (!alive(c.starId)) { state.colonies.splice(i, 1); news.push({ kind: 'died-out', colony: c }); continue; }
    // An occupied home world's record is the occupiers' hold, not a settlement that grows.
    if (c.occupation?.homeWorld) continue;
    // Grows to what its RULERS can sustain; one ruling itself keeps what it had.
    const ruler = rulerOf(c);
    const t = ruler == null ? null : founderTier(ruler);
    if (t != null && t > 0) c.tier = t;
    const cap = capabilityOfTier(c.tier ?? 3);
    const net = GROWTH * cap.growthMult * (c.suitability - MIN_SUITABILITY) / (1 - MIN_SUITABILITY);
    const room = cap.popCap - c.population;
    c.population = clamp01(net >= 0
      ? c.population + Math.max(0, net * room / Math.max(0.01, cap.popCap))
      : c.population + net * c.population * 2);
    if (c.population > cap.popCap) c.population = Math.max(cap.popCap, c.population - GROWTH * 0.5);
    if (c.status === 'outpost' && c.population >= COLONY_AT) { c.status = 'colony'; news.push({ kind: 'grew', colony: c }); }
    if (c.population < 0.01) { state.colonies.splice(i, 1); news.push({ kind: 'died-out', colony: c }); }
  }
  return news;
}

/** The colony on a planet, if any. */
export function colonyAt(state: ColonyState, starId: number, planetIndex: number): Colony | null {
  return state.colonies.find(c => c.starId === starId && c.planetIndex === planetIndex) ?? null;
}

// ── Divergence (P2) ─────────────────────────────────────────────────────────

export interface StageNews { colony: Colony; from: DivergenceStage; to: DivergenceStage; words: string[] }

/**
 * Live one generation on the colony world: adaptations step toward what the
 * world selects for, slowed and pulled home by contact. Mirrors the result onto
 * the colony's own species copy (so its creatures are drawn changed). Returns a
 * stage change, if one happened.
 */
export function liveGeneration(c: Colony, env: WorldEnv, contact: number, tick: number, rand: () => number): StageNews | null {
  c.contact = Math.max(0, Math.min(1, contact));
  c.adaptations = generationStep(c.adaptations ?? { ...NO_ADAPTATION }, optimumFor(env), c.contact, rand);
  c.generations++;
  c.lastGenTick = tick;
  if (c.lineage) c.lineage.adaptations = { ...c.adaptations };
  const from = c.stage ?? 'same';
  const to = stageOf(distanceFromHome(c.adaptations), c.contact);
  if (to === from) return null;
  // Stages only move forward: a people that has become its own does not
  // un-become it when contact resumes (it can still drift back in its traits).
  const order: DivergenceStage[] = ['same', 'variant', 'subspecies', 'species'];
  if (order.indexOf(to) < order.indexOf(from)) return null;
  c.stage = to;
  return { colony: c, from, to, words: describe(c.adaptations) };
}

/** "pale, great" — the visible changes of a colony people, for the views. */
export function colonyLook(c: Colony): string {
  return describe(c.adaptations).slice(0, 2).join(', ');
}

/**
 * The player's peoples that descend from a home species, living on other
 * worlds (P4: the lineage in the Codex), most changed first. Includes colonies
 * that broke away or were taken: they are still its descendants.
 */
export function offshootsOf(state: ColonyState, homeLineageId: string): Colony[] {
  return state.colonies
    .filter(c => c.byPlayer && c.lineage && c.homeLineageId === homeLineageId)
    .sort((a, b) => distanceFromHome(b.adaptations) - distanceFromHome(a.adaptations) || a.foundedTick - b.foundedTick);
}
