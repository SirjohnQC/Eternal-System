/**
 * Rulers who live (stage-moments plan, P3; owner's call: politicians before
 * war). Each nation's Council of State is three people who are born, hold a
 * seat, age and die. Their influence and loyalty move with what the nation
 * lives through (war raises the warlike seat, the god's signs the pious one,
 * new learning the learned one), and when a ruler dies the most trusted
 * councillor takes the throne: the lever a god pulls without commanding.
 *
 * Pure functions over a nation; the caller (NationSystem) owns the clock, the
 * random numbers (its own council stream, so the nations' balance is not
 * disturbed) and the Chronicle.
 */
import type { SeedRNG } from '../utils/SeedRNG';

/** What a seat cares for, and so what raises its holder. */
export type Bent = 'war' | 'faith' | 'lore';

export interface Seat { title: string; icon: string; weight: number; bent: Bent }

/** Three seats per government: who holds power in such a state (moved from NationsOverview). */
export const SEATS: Record<string, Seat[]> = {
  Theocracy:     [{ title: 'High Priest', icon: '✦', weight: 1, bent: 'faith' }, { title: 'Keeper of Rites', icon: '☽', weight: 0.7, bent: 'lore' }, { title: 'Inquisitor', icon: '⚔', weight: 0.6, bent: 'war' }],
  Republic:      [{ title: 'Chancellor', icon: '⚖', weight: 1, bent: 'lore' }, { title: 'Speaker', icon: '❝', weight: 0.75, bent: 'faith' }, { title: 'Marshal', icon: '⚔', weight: 0.6, bent: 'war' }],
  Empire:        [{ title: 'Sovereign', icon: '♛', weight: 1, bent: 'faith' }, { title: 'Grand Vizier', icon: '⚖', weight: 0.7, bent: 'lore' }, { title: 'Warlord', icon: '⚔', weight: 0.75, bent: 'war' }],
  Confederation: [{ title: 'First Delegate', icon: '⚖', weight: 0.85, bent: 'lore' }, { title: 'Treasurer', icon: '⛁', weight: 0.7, bent: 'faith' }, { title: 'Marshal', icon: '⚔', weight: 0.6, bent: 'war' }],
  Technocracy:   [{ title: 'Chief Engineer', icon: '⚙', weight: 1, bent: 'lore' }, { title: 'Archivist', icon: '❖', weight: 0.7, bent: 'faith' }, { title: 'Director of Works', icon: '⚒', weight: 0.65, bent: 'war' }],
  Warband:       [{ title: 'Warchief', icon: '⚔', weight: 1, bent: 'war' }, { title: 'Champion', icon: '⛨', weight: 0.75, bent: 'lore' }, { title: 'Shaman', icon: '✦', weight: 0.6, bent: 'faith' }],
  Hive:          [{ title: 'Voice of the Hive', icon: '⬢', weight: 1, bent: 'faith' }, { title: 'Brood Warden', icon: '⬡', weight: 0.7, bent: 'lore' }, { title: 'Swarm Captain', icon: '⚔', weight: 0.65, bent: 'war' }],
  Council:       [{ title: 'Elder of the Council', icon: '⚖', weight: 0.85, bent: 'lore' }, { title: 'Lawgiver', icon: '❝', weight: 0.75, bent: 'faith' }, { title: 'Warden', icon: '⛨', weight: 0.6, bent: 'war' }],
};

export const seatsOf = (government: string): Seat[] => SEATS[government] ?? SEATS.Council;

/** A member of a Council of State. */
export interface Figure {
  id: number;
  name: string;
  /** 0 the ruler; titles come from SEATS[government][seat]. */
  seat: 0 | 1 | 2;
  /** What they care for (the seat's bent when they took it). */
  bent: Bent;
  /** Era-time (NationSystem.now) they took their seat, and the engine tick. */
  since: number;
  sinceTick: number;
  /** Era-time they die. */
  dies: number;
  /** 0..1: their weight at court. */
  influence: number;
  /** 0..1: how far they hold to the realm and its ruler. */
  loyalty: number;
  /** -0.15..0.15: their own temper, which loyalty eases around. */
  temper: number;
}

/** What a nation lived through this step, for its council. */
export interface CouncilContext {
  eras: number;
  atWar: boolean;
  /** The god's cards that reached it this step (and how many of them hurt). */
  casts: number;
  banes: number;
  /** Technologies it learned this step. */
  learned: number;
  cohesion: number;
  unrest: number;
}

/** A change at the top, for the Chronicle. */
export interface Succession {
  kind: 'death' | 'coup' | 'councillor';
  /** Who left, who came, and the seats concerned. */
  gone: Figure;
  heir: Figure;
  heirSeat: number;
  /** Why the heir, in words. */
  why: string[];
}

const ONSETS = ['Ar', 'Bel', 'Cor', 'Dra', 'El', 'Fen', 'Gal', 'Hal', 'Is', 'Ka', 'Lor', 'Mae', 'Nyr', 'Or', 'Pel', 'Quo', 'Ra', 'Sel', 'Tor', 'Ul', 'Vae', 'Wyn', 'Xa', 'Yl', 'Zor'];
const CODAS = ['an', 'eth', 'ira', 'on', 'us', 'ael', 'ix', 'ora', 'en', 'is', 'ul', 'ane', 'ar', 'yr', 'eus'];

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * A seat is held 1..2.5 units of era-time (NationSystem.now), a life's span at
 * court: about one throne change per nation per age, so councils visibly
 * change without filling the feed.
 */
export const LIFE_MIN = 1, LIFE_MAX = 2.5;

export function rollFigure(rng: SeedRNG, id: number, seat: 0 | 1 | 2, government: string, now: number, tick: number, cohesion: number): Figure {
  const s = seatsOf(government)[seat];
  const first = rng.pick(ONSETS) + rng.pick(CODAS);
  const last = rng.pick(ONSETS) + rng.pick(CODAS).toLowerCase();
  const temper = (rng.next() - 0.5) * 0.3;
  return {
    id, name: `${first} ${last}`, seat, bent: s.bent, since: now, sinceTick: tick,
    dies: now + LIFE_MIN + rng.next() * (LIFE_MAX - LIFE_MIN),
    influence: clamp01(s.weight * 0.6 + rng.next() * 0.15),
    loyalty: clamp01(cohesion * 0.9 + 0.1 + temper),
    temper,
  };
}

/** A fresh council of three (a new nation, or a new order after a revolt). */
export function newCouncil(rng: SeedRNG, nextId: () => number, government: string, now: number, tick: number, cohesion: number): Figure[] {
  return ([0, 1, 2] as const).map(seat => rollFigure(rng, nextId(), seat, government, now, tick, cohesion));
}

/** Why `f` stood out at court, in words (for the Chronicle). */
function standing(f: Figure, ctx: CouncilContext, title: string): string[] {
  const out = [`${title} ${f.name} was the most trusted at court`];
  if (f.bent === 'war' && ctx.atWar) out.push('the war had raised the warlike');
  if (f.bent === 'faith' && f.influence > 0.6) out.push('the signs of the god had raised the devout');
  if (f.bent === 'lore' && f.influence > 0.6) out.push('new learning had raised the learned');
  return out;
}

/**
 * One step of a council: influence and loyalty drift, then deaths and coups.
 * Mutates `council`; returns what changed at the top.
 */
export function stepCouncil(council: Figure[], government: string, ctx: CouncilContext, rng: SeedRNG,
  nextId: () => number, now: number, tick: number): Succession[] {
  const seats = seatsOf(government);
  const out: Succession[] = [];
  const e = Math.max(0, ctx.eras);
  for (const f of council) {
    const base = seats[f.seat].weight * 0.6;
    let inf = f.influence + (base - f.influence) * Math.min(1, 0.25 * e * 4);
    if (f.bent === 'war' && ctx.atWar) inf += 0.4 * e;
    if (f.bent === 'faith') inf += 0.15 * ctx.casts + 0.1 * ctx.banes;
    if (f.bent === 'lore') inf += 0.12 * ctx.learned;
    f.influence = clamp01(inf);
    const target = clamp01(ctx.cohesion * 0.9 + 0.1 + f.temper - 0.3 * ctx.unrest);
    f.loyalty = clamp01(f.loyalty + (target - f.loyalty) * Math.min(1, e * 2));
  }
  const ruler = () => council.find(f => f.seat === 0)!;
  const heirOf = () => council.filter(f => f.seat !== 0).reduce((a, b) => (b.influence * b.loyalty > a.influence * a.loyalty ? b : a));
  const raise = (heir: Figure, gone: Figure, kind: Succession['kind']) => {
    const heirSeat = heir.seat;
    const why = kind === 'coup'
      ? [`${seats[heirSeat].title} ${heir.name} had grown stronger than the throne`, 'the realm was restless', `${gone.name} had lost the court`]
      : standing(heir, ctx, seats[heirSeat].title);
    council.splice(council.indexOf(gone), 1);
    heir.seat = 0;
    heir.since = now; heir.sinceTick = tick;
    // The throne is a new span: a reign of its own length.
    heir.dies = now + LIFE_MIN + rng.next() * (LIFE_MAX - LIFE_MIN);
    council.push(rollFigure(rng, nextId(), heirSeat as 1 | 2, government, now, tick, ctx.cohesion));
    out.push({ kind, gone, heir, heirSeat, why });
  };
  // The ruler dies: the most trusted councillor takes the throne.
  const r = ruler();
  if (now >= r.dies) raise(heirOf(), r, 'death');
  // A councillor dies: someone new takes the seat.
  for (const f of [...council]) {
    if (f.seat === 0 || now < f.dies) continue;
    const next = rollFigure(rng, nextId(), f.seat, government, now, tick, ctx.cohesion);
    council.splice(council.indexOf(f), 1, next);
    out.push({ kind: 'councillor', gone: f, heir: next, heirSeat: f.seat, why: [`${f.name} died`] });
  }
  // A coup: in a restless realm, a disloyal councillor stronger than the ruler takes power.
  const now0 = ruler();
  const rival = council.filter(f => f.seat !== 0).reduce((a, b) => (b.influence > a.influence ? b : a));
  if (ctx.unrest >= 0.6 && rival.loyalty < 0.35 && rival.influence > now0.influence + 0.15) raise(rival, now0, 'coup');
  council.sort((a, b) => a.seat - b.seat);
  return out;
}
