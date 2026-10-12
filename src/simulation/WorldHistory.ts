/**
 * World history — what happened on each planet other than the home world
 * (expansion P4; issue #17: a world your people settled or conquered showed no
 * overview, name or history).
 *
 * The home world has its causal Chronicle (Chronicle.ts, from its nations).
 * Every other world keeps a short log here, keyed by star and planet: ships
 * that set out for it, landfall, growth, its people changing, breaking away,
 * conquest and liberation. It outlives the colony record, so a world that was
 * lost still remembers who lived there.
 *
 * Pure, plain JSON (saved with the engine; absent in older saves = empty).
 */
import { EVOLUTION_TICK_RATE } from './EvolutionEngine';

export interface WorldEvent {
  tick: number;
  text: string;
  /** Why, in a few words (the same cause the feed and Chronicle get). */
  cause?: string;
}

export type WorldHistoryState = Record<string, WorldEvent[]>;

/** Oldest entries are dropped past this, per world. */
export const WORLD_HISTORY_CAP = 60;

export const worldKey = (starId: number, planetIndex: number) => `${starId}:${planetIndex}`;

export function recordWorldEvent(state: WorldHistoryState, starId: number, planetIndex: number, e: WorldEvent): void {
  const k = worldKey(starId, planetIndex);
  const log = state[k] ?? (state[k] = []);
  log.push(e);
  if (log.length > WORLD_HISTORY_CAP) log.splice(0, log.length - WORLD_HISTORY_CAP);
}

export function worldEvents(state: WorldHistoryState, starId: number, planetIndex: number): readonly WorldEvent[] {
  return state[worldKey(starId, planetIndex)] ?? [];
}

/** "this generation", "1 generation ago", "12 generations ago" (one generation = one evolution step). */
export function generationsAgo(tick: number, now: number): string {
  const g = Math.floor(Math.max(0, now - tick) / EVOLUTION_TICK_RATE);
  return g === 0 ? 'this generation' : g === 1 ? '1 generation ago' : `${g} generations ago`;
}
