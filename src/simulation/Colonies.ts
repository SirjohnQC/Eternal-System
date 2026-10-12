/**
 * Colonies — civilisations that leave their world (design:
 * docs/plans/2026-10-12-expansion-and-divergence.md, phase P1).
 *
 * Nobody orders a colony. A people that knows how to build a colony ark
 * launches one when its pressures push it (crowding, scarcity) and its culture
 * lets it (curiosity), toward the best world it can reach. The ark is an
 * engine fleet; at landfall the colony takes hold or fails on a poor world,
 * then grows or dies out by how well the world suits it.
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

export type ColonyStatus = 'outpost' | 'colony';

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
  /** Evolution steps lived on the colony world (P2). */
  generations: number;
  /** 0..1 traffic with the founder: gene flow and loyalty (P2/P3). */
  contact: number;
  loyalty: number;
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

// ── Tuning ──────────────────────────────────────────────────────────────────
/** The technology that launches arks. */
export const ARK_TECH = 'colony_ark';
/** Ticks between one civilisation's launches. */
export const LAUNCH_COOLDOWN = 12_000;
/** Colonies (and arks in flight) one civilisation keeps at most. */
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
  if (!l.techs.includes(ARK_TECH)) return 0;
  const p = l.pressures;
  const push = 0.55 * p.crowding + 0.25 * p.scarcity + 0.1 * p.hunger;
  const pull = 0.35 * l.values.curiosity - 0.1 * l.values.xenophobia;
  return clamp01(push + pull);
}

/**
 * The world an ark from `l` heads for: the best suitability, discounted by
 * distance; within the civilisation's ship reach; never a world that already
 * holds a colony or an ark bound for it.
 */
export function pickTarget(
  l: Launcher, candidates: readonly Candidate[], taken: ReadonlySet<string>,
): Candidate | null {
  const reach = reachOf(l.era);
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
export function coloniesOf(state: ColonyState, founderStarId: number): number {
  return state.colonies.filter(c => c.founderStarId === founderStarId).length;
}

/** Does the ark take hold? A poor world often fails. `roll` is 0..1. */
export function landfallSucceeds(suitability: number, roll: number): boolean {
  return roll < clamp01(0.25 + suitability);
}

/** Found a colony at landfall. */
export function foundColony(
  state: ColonyState,
  site: Candidate,
  founder: { starId: number; isPlayer: boolean; lineage: SpeciesGenome | null },
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
 * One polity step for every colony: growth toward the world's capacity at a
 * rate set by suitability; a world that cannot hold them (suitability under
 * MIN_SUITABILITY) shrinks them. `alive(starId)` is false for a dead star.
 */
export function stepColonies(state: ColonyState, alive: (starId: number) => boolean): ColonyNews[] {
  const news: ColonyNews[] = [];
  for (let i = state.colonies.length - 1; i >= 0; i--) {
    const c = state.colonies[i];
    if (!alive(c.starId)) { state.colonies.splice(i, 1); news.push({ kind: 'died-out', colony: c }); continue; }
    const net = GROWTH * (c.suitability - MIN_SUITABILITY) / (1 - MIN_SUITABILITY);
    c.population = clamp01(c.population + (net >= 0 ? net * (1 - c.population) : net * c.population * 2));
    if (c.status === 'outpost' && c.population >= COLONY_AT) { c.status = 'colony'; news.push({ kind: 'grew', colony: c }); }
    if (c.population < 0.01) { state.colonies.splice(i, 1); news.push({ kind: 'died-out', colony: c }); }
  }
  return news;
}

/** The colony on a planet, if any. */
export function colonyAt(state: ColonyState, starId: number, planetIndex: number): Colony | null {
  return state.colonies.find(c => c.starId === starId && c.planetIndex === planetIndex) ?? null;
}
