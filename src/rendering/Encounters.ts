/**
 * Encounters between the creatures drawn on the diorama (#112): hunters
 * chasing what they eat, and neighbours of the same way of life fighting
 * over ground.
 *
 * Who hunts whom comes from the simulation's food web (EvolutionEngine
 * `preysOn`): a grazer never chases, a hunter only runs at animals it can
 * eat, in a realm both live in. Who quarrels comes from what they compete
 * for: the same ground (animals of the same environment). The outcome on screen — caught or escaped,
 * who backs off — follows their bodies (size, flight, aggression). It is the
 * simulation's ecology shown, not a script: the populations themselves are
 * the simulation's (stepEvolution).
 *
 * Pure and deterministic in time: the view asks `poseAt(t)` every frame and
 * gets the same answer for the same t (no state to save or keep in step).
 */
import { preysOn } from '../simulation/EvolutionEngine';
import type { SpeciesGenome } from '../simulation/SpeciesGenome';

/** Seconds per encounter cycle; each pair runs one encounter per cycle. */
export const ENCOUNTER_PERIOD = 16;
/** Within a cycle: [start, chase end) the hunt runs; the clash its own window. */
const HUNT_START = 8.5, HUNT_STRIKE = 11.5, HUNT_DONE = 15;
const CLASH_START = 9.5, CLASH_MEET = 11, CLASH_DONE = 14;

export interface Creature { wx: number; wy: number; genome: SpeciesGenome }

export interface Encounter {
  kind: 'hunt' | 'clash';
  /** The hunter (hunt) or the first rival (clash): an index into the creature list. */
  a: number;
  /** The prey (hunt) or the second rival. */
  b: number;
  /** Desync between pairs, 0..1. */
  offset: number;
}

const mobile = (g: SpeciesGenome) => g.dna.locomotion !== 'stationary';
const sizeRank = (g: SpeciesGenome) => ['microscopic', 'tiny', 'small', 'medium', 'large', 'massive'].indexOf(g.physicalTraits.size);
const hash = (n: number) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

/**
 * Pair the creatures for encounters, each in at most one: every mobile hunter
 * takes the nearest creature within `reach` it can eat; then mobile
 * neighbours of different species that share an environment (animals, not
 * plants) and are not each other's food pair up as rivals for the ground.
 */
export function planEncounters(list: readonly Creature[], reach: number): Encounter[] {
  const out: Encounter[] = [];
  const used = new Set<number>();
  const near = (i: number, j: number) => Math.hypot(list[i].wx - list[j].wx, (list[i].wy - list[j].wy) * 2);
  const hunters = list.map((_, i) => i).filter(i => mobile(list[i].genome) && list[i].genome.dna.diet !== 'producer' && list[i].genome.dna.diet !== 'herbivore');
  for (const h of hunters) {
    if (used.has(h)) continue;
    let best = -1, bd = reach;
    for (let j = 0; j < list.length; j++) {
      if (j === h || used.has(j) || list[j].genome.id === list[h].genome.id) continue;
      if (preysOn(list[h].genome, list[j].genome) <= 0 || list[j].genome.dna.diet === 'producer') continue;
      const d = near(h, j);
      if (d < bd) { bd = d; best = j; }
    }
    if (best < 0) continue;
    used.add(h); used.add(best);
    out.push({ kind: 'hunt', a: h, b: best, offset: hash(h * 31 + best) });
  }
  for (let i = 0; i < list.length; i++) {
    if (used.has(i) || !mobile(list[i].genome)) continue;
    const gi = list[i].genome;
    let best = -1, bd = reach * 0.8;
    for (let j = i + 1; j < list.length; j++) {
      const gj = list[j].genome;
      if (used.has(j) || !mobile(gj) || gj.id === gi.id) continue;
      // Rivals for the same ground: animals of the same environment (any diet but plants).
      if (gi.dna.diet === 'producer' || gj.dna.diet === 'producer' || gj.dna.environment !== gi.dna.environment) continue;
      if (preysOn(gi, gj) > 0 || preysOn(gj, gi) > 0) continue;
      const d = near(i, j);
      if (d < bd) { bd = d; best = j; }
    }
    if (best < 0) continue;
    used.add(i); used.add(best);
    out.push({ kind: 'clash', a: i, b: best, offset: hash(i * 17 + best * 7) });
  }
  return out;
}

/** Whether the hunter catches its prey this cycle: size against size, wings help the prey. */
export function caught(hunter: SpeciesGenome, prey: SpeciesGenome, cycle: number, salt: number): boolean {
  const odds = Math.max(0.15, Math.min(0.85,
    0.5 + (sizeRank(hunter) - sizeRank(prey)) * 0.12 + (hunter.dna.aggression - 5) * 0.03
    - (prey.dna.locomotion === 'flying' ? 0.25 : 0)));
  return hash(cycle * 101 + salt) < odds;
}

/** Who wins a clash: the bigger, then the more aggressive; ties fall by cycle. */
export function clashWinner(a: SpeciesGenome, b: SpeciesGenome, cycle: number, salt: number): 'a' | 'b' {
  const sa = sizeRank(a) * 2 + a.dna.aggression / 5, sb = sizeRank(b) * 2 + b.dna.aggression / 5;
  if (Math.abs(sa - sb) > 0.5) return sa > sb ? 'a' : 'b';
  return hash(cycle * 13 + salt) < 0.5 ? 'a' : 'b';
}

/** A creature's pose from its encounter: an offset from where it would be, hidden, facing, shaking. */
export interface Pose {
  dx: number; dy: number;
  /** Replace the wander (true) or add to it (false). */
  takeover: boolean;
  hidden: boolean;
  left: boolean | null;
  moving: boolean;
  /** 1 px jitter, for a scuffle. */
  shake: boolean;
}

/** A burst to draw where a catch happened, for its first second. */
export interface Puff { x: number; y: number; age: number }

const ease = (u: number) => u * u * (3 - 2 * u);

/**
 * Poses for both sides of an encounter at time t (base px), and a puff if a
 * catch is fresh. `home` is each creature's planned spot.
 */
export function poseAt(e: Encounter, list: readonly Creature[], t: number): { a: Pose; b: Pose; puff: Puff | null } {
  const A = list[e.a], B = list[e.b];
  const tt = t + e.offset * ENCOUNTER_PERIOD;
  const cycle = Math.floor(tt / ENCOUNTER_PERIOD), u = tt - cycle * ENCOUNTER_PERIOD;
  const idle: Pose = { dx: 0, dy: 0, takeover: false, hidden: false, left: null, moving: false, shake: false };
  const vx = B.wx - A.wx, vy = B.wy - A.wy, len = Math.hypot(vx, vy) || 1;
  const ux = vx / len, uy = vy / len;
  if (e.kind === 'hunt') {
    const flee = Math.min(10, len * 0.6);
    const won = caught(A.genome, B.genome, cycle, e.a * 7 + e.b);
    if (u < HUNT_START) return { a: idle, b: idle, puff: null };
    if (u < HUNT_STRIKE) {
      // The chase: the hunter runs at the prey, the prey bolts away from it.
      const s = ease((u - HUNT_START) / (HUNT_STRIKE - HUNT_START));
      const px = ux * flee * s, py = uy * flee * s;
      const hx = vx * s + px * s, hy = vy * s + py * s;
      return {
        a: { dx: hx, dy: hy, takeover: true, hidden: false, left: vx < 0, moving: true, shake: false },
        b: { dx: px, dy: py, takeover: true, hidden: false, left: vx < 0, moving: true, shake: false },
        puff: null,
      };
    }
    const strikeX = vx + ux * flee, strikeY = vy + uy * flee;
    const back = ease(Math.min(1, (u - HUNT_STRIKE) / (HUNT_DONE - HUNT_STRIKE)));
    if (won) {
      // Caught: the prey is gone until the next cycle (its kind fills the
      // spot again), the hunter walks home.
      return {
        a: { dx: strikeX * (1 - back), dy: strikeY * (1 - back), takeover: true, hidden: false, left: !(vx < 0), moving: back < 1, shake: u - HUNT_STRIKE < 0.6 },
        b: { ...idle, takeover: true, hidden: true },
        puff: u - HUNT_STRIKE < 1 ? { x: A.wx + strikeX, y: A.wy + strikeY, age: u - HUNT_STRIKE } : null,
      };
    }
    // Escaped: the prey runs on and circles home; the hunter gives up.
    const run = Math.min(1, (u - HUNT_STRIKE) / 1.2);
    const ret = ease(Math.max(0, (u - HUNT_STRIKE - 1.2) / (HUNT_DONE - HUNT_STRIKE - 1.2)));
    return {
      a: { dx: strikeX * 0.8 * (1 - back), dy: strikeY * 0.8 * (1 - back), takeover: true, hidden: false, left: !(vx < 0), moving: back < 1, shake: false },
      b: { dx: (ux * flee * (1 + run * 0.6)) * (1 - ret), dy: (uy * flee * (1 + run * 0.6)) * (1 - ret), takeover: true, hidden: false, left: ret > 0 ? !(vx < 0) : vx < 0, moving: ret < 1, shake: false },
      puff: null,
    };
  }
  // A clash: both close to just short of the middle, scuffle, and the loser backs off.
  if (u < CLASH_START || u >= CLASH_DONE) return { a: idle, b: idle, puff: null };
  const meet = ease(Math.min(1, (u - CLASH_START) / (CLASH_MEET - CLASH_START)));
  const gap = Math.min(len * 0.42, len * 0.5 - 2);
  if (u < CLASH_MEET + 1.2) {
    const scuffle = u >= CLASH_MEET;
    return {
      a: { dx: ux * gap * meet, dy: uy * gap * meet, takeover: true, hidden: false, left: vx < 0, moving: !scuffle, shake: scuffle },
      b: { dx: -ux * gap * meet, dy: -uy * gap * meet, takeover: true, hidden: false, left: !(vx < 0), moving: !scuffle, shake: scuffle },
      puff: scuffle && u - CLASH_MEET < 0.6 ? { x: A.wx + vx * 0.5, y: A.wy + vy * 0.5, age: (u - CLASH_MEET) * 0.8 } : null,
    };
  }
  const away = ease(Math.min(1, (u - CLASH_MEET - 1.2) / (CLASH_DONE - CLASH_MEET - 1.2)));
  const winA = clashWinner(A.genome, B.genome, cycle, e.a * 3 + e.b) === 'a';
  // The winner holds the middle a moment, then drifts home; the loser bolts back past its own spot.
  const hold = (1 - away) * gap, rout = gap * (1 - away * 1.6);
  return {
    a: { dx: ux * (winA ? hold : rout), dy: uy * (winA ? hold : rout), takeover: true, hidden: false, left: winA ? vx < 0 : !(vx < 0), moving: true, shake: false },
    b: { dx: -ux * (winA ? rout : hold), dy: -uy * (winA ? rout : hold), takeover: true, hidden: false, left: winA ? vx >= 0 : !(vx >= 0), moving: true, shake: false },
    puff: null,
  };
}
