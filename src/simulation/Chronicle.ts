/**
 * The Chronicle (docs/CORE_LOOP_VISION.md §15): walking the causal history.
 *
 * Every history entry the nations write carries links to the earlier entries
 * that caused it (Nations.HistoryEntry.causes) — a pressure turning acute, the
 * technology it was building on, the trade that taught it, the card the player
 * cast. These helpers walk those links backward (why did this happen?) and
 * forward (what came of it?), and find the player's own hand at the roots:
 * "I caused this 800 years ago".
 *
 * Pure functions over a NationSystem.
 */
import type { NationSystem, HistoryEntry } from './Nations';
import { TECH_LEVELS } from './GameState';

export interface CauseNode {
  entry: HistoryEntry;
  causes: CauseNode[];
  /** Already shown higher in the tree (the walk does not repeat it). */
  seen?: boolean;
}

/**
 * The tree of causes behind `id`, `depth` links deep. An entry reached twice
 * is shown once, then marked `seen`; at most `limit` entries in all.
 */
export function causeTree(ns: NationSystem, id: number, depth = 6, limit = 40): CauseNode | null {
  const root = ns.entry(id);
  if (!root) return null;
  const shown = new Set<number>([id]);
  let count = 1;
  const grow = (e: HistoryEntry, d: number): CauseNode => {
    const node: CauseNode = { entry: e, causes: [] };
    if (d <= 0) return node;
    for (const cid of e.causes) {
      const c = ns.entry(cid);
      if (!c) continue;
      if (shown.has(cid)) { node.causes.push({ entry: c, causes: [], seen: true }); continue; }
      if (count >= limit) break;
      shown.add(cid); count++;
      node.causes.push(grow(c, d - 1));
    }
    return node;
  };
  return grow(root, depth);
}

/** Every entry `id` follows from, however far back (breadth-first, nearest first). */
export function ancestors(ns: NationSystem, id: number, limit = 400): HistoryEntry[] {
  const out: HistoryEntry[] = [], seen = new Set<number>([id]);
  let frontier = [id];
  while (frontier.length && out.length < limit) {
    const next: number[] = [];
    for (const f of frontier) for (const c of ns.entry(f)?.causes ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      const e = ns.entry(c);
      if (e) { out.push(e); next.push(c); }
    }
    frontier = next;
  }
  return out;
}

/** Everything that followed from `id`, however far on (breadth-first, nearest first). */
export function descendants(ns: NationSystem, id: number, limit = 400): HistoryEntry[] {
  const out: HistoryEntry[] = [], seen = new Set<number>([id]);
  // One pass to index children, so the walk is linear in the chronicle.
  const kids = new Map<number, HistoryEntry[]>();
  for (const e of ns.chronicle) for (const c of e.causes) {
    const k = kids.get(c);
    if (k) k.push(e); else kids.set(c, [e]);
  }
  let frontier = [id];
  while (frontier.length && out.length < limit) {
    const next: number[] = [];
    for (const f of frontier) for (const e of kids.get(f) ?? []) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
      next.push(e.id);
    }
    frontier = next;
  }
  return out;
}

/** The player's own acts at the roots of `id` (oldest first). */
export function yourHand(ns: NationSystem, id: number): HistoryEntry[] {
  const self = ns.entry(id);
  const found = ancestors(ns, id).filter(e => e.kind === 'divine');
  if (self?.kind === 'divine') found.push(self);
  return found.sort((a, b) => a.id - b.id);
}

/** "the Medieval age · 1.4 ages ago" (or "just now"). */
export function whenOf(ns: NationSystem, e: HistoryEntry): string {
  const ago = ns.now - e.age;
  const age = TECH_LEVELS[e.era] ? `the ${TECH_LEVELS[e.era]} age` : 'the dawn of the nations';
  return `${age} · ${ago < 0.05 ? 'just now' : ago < 0.95 ? `${Math.round(ago * 10) / 10} of an age ago` : `${ago.toFixed(1)} ages ago`}`;
}
