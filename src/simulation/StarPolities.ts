/**
 * Civilisations of other stars as agents (docs/CORE_LOOP_VISION.md §4, §5, §8).
 *
 * Each intelligent world beyond the player's is a POLITY: one people with a
 * state drawn from its own world (biosphere, habitability, planet type, the
 * ore of its asteroid belts), pressures that rise as needs near their limit,
 * and the same technology tree the player's nations climb (Technology.ts):
 * it studies what its pressures and culture favour, so its era is what it
 * has learned, not a clock.
 *
 * Polities within reach of each other (space-age ships, or anywhere once
 * interstellar) hold attitudes from culture, trade and old wrongs. Where one
 * has what another lacks, a TRADE ROUTE opens: grain to the hungry, ore to
 * the poor in stone, knowledge between the curious. Routes move goods, teach
 * technology and warm relations; ill will closes them. A martial, hard-
 * pressed people with a bitter rival may go to war (the engine's fleets
 * carry it out). The player's home world takes part as one polity built
 * from its nations.
 *
 * Pure simulation over plain JSON state (saved with the engine).
 */
import type { CultureValues } from './Civilization';
import { available, appeal, effectOf, eraOf, TECH_BY_ID, TECHS_PER_ERA, studyCost, type Need } from './Technology';

export interface PolityPressures { hunger: number; crowding: number; scarcity: number; unrest: number; pollution: number }

export interface Polity {
  starId: number;
  techs: string[];
  research: { id: string; progress: number } | null;
  /** TECH_LEVELS index from what it knows. */
  era: number;
  population: number;
  pollution: number;
  inequality: number;
  cohesion: number;
  pressures: PolityPressures;
  /** Goods arriving by trade this step, as a share of its own yield. */
  importFood: number; importMaterials: number;
  /** -1..1 toward other polities, by star id. */
  attitude: Record<number, number>;
  /** 0..1 wrongs remembered, by star id. */
  grievance: Record<number, number>;
}

export type Goods = 'grain' | 'ore' | 'knowledge';

export interface TradeRoute {
  /** Star ids (a < b). */
  a: number; b: number;
  /** What flows, and toward whom (the star that lacked it). */
  goods: Goods;
  to: number;
  since: number;
}

/** What the engine tells the polities about a star each step. */
export interface StarView {
  id: number;
  x: number; y: number;
  values: CultureValues;
  /** 0..1 biosphere of its living world. */
  biosphere: number;
  /** 0..1. */
  habitability: number;
  planetType: string;
  /** 0..1 asteroid belt (ore). */
  belt: number;
  /** The engine's era for it (may have been knocked down or raised by events). */
  civLevel: number;
  isPlayer: boolean;
}

/** The player's world, summarised from its nations (when they exist). */
export interface HomeView {
  starId: number;
  techs: string[];
  era: number;
  pressures: PolityPressures;
  values: CultureValues;
}

export interface PolityNews {
  kind: 'learned' | 'era' | 'trade' | 'trade-closed' | 'setback';
  starId: number;
  other?: number;
  text: string;
  tech?: string;
  goods?: Goods;
  /** The flow was toward this star. */
  to?: number;
}

export interface InterstellarState {
  polities: Record<number, Polity>;
  routes: TradeRoute[];
  /** Era-time stepped (sum of `eras`). */
  age: number;
  /** The player's world's own attitudes and remembered wrongs, by star id. */
  home: { attitude: Record<number, number>; grievance: Record<number, number> };
}

export function emptyInterstellar(): InterstellarState {
  return { polities: {}, routes: [], age: 0, home: { attitude: {}, grievance: {} } };
}

const MATERIAL_BY_TYPE: Record<string, number> = {
  rocky: 1.2, lava: 1.4, desert: 1.0, ice: 0.7, ocean: 0.6, toxic: 0.8, crystal: 1.3, carbon: 1.1, storm: 0.6, gas: 0.3,
};

const ramp = (use: number, from: number) => Math.max(0, Math.min(1, (use - from) / (1.25 - from)));
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Reach of a polity's ships: none before the Space Age (5), far in the Space Age, everywhere once Interstellar (6). */
export function reachOf(era: number): number {
  return era >= 6 ? Infinity : era >= 5 ? 1100 : 0;
}

function hashPair(a: number, b: number): number {
  let h = Math.imul(Math.min(a, b) + 1, 374761393) ^ Math.imul(Math.max(a, b) + 7, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A polity founded on a world that woke up: it already knows what its era implies. */
export function foundPolity(v: StarView, rand: () => number): Polity {
  const p: Polity = {
    starId: v.id, techs: [], research: null, era: 0, population: 0, pollution: 0, inequality: 0, cohesion: 0.75,
    pressures: { hunger: 0, crowding: 0, scarcity: 0, unrest: 0, pollution: 0 }, importFood: 0, importMaterials: 0,
    attitude: {}, grievance: {},
  };
  catchUp(p, v, rand);
  return p;
}

/** Learn (by the polity's own leanings) until it stands in the engine's era for it. */
function catchUp(p: Polity, v: StarView, rand: () => number): string[] {
  const learned: string[] = [];
  for (let guard = 0; guard < 60 && eraOf(p.techs) < v.civLevel; guard++) {
    const opts = available(p.techs);
    if (!opts.length) break;
    const need: Record<Need, number> = { ...p.pressures, curiosity: v.values.curiosity * 0.5 };
    const w = opts.map(t => appeal(t, need, v.values));
    let x = rand() * w.reduce((a, b) => a + b, 0), i = 0;
    while (i < opts.length - 1 && (x -= w[i]) > 0) i++;
    p.techs.push(opts[i].id);
    learned.push(opts[i].id);
  }
  p.era = eraOf(p.techs);
  return learned;
}

/**
 * One step of `eras` of era-time for every polity: their state and pressures
 * from their worlds and trade, study, the engine's own changes to their era
 * (setbacks, spoils of war) reconciled, then relations and trade routes.
 * Returns what happened, for the engine to announce and act on.
 */
export function stepInterstellar(st: InterstellarState, stars: StarView[], home: HomeView | null, eras: number,
  rand: () => number): PolityNews[] {
  const news: PolityNews[] = [];
  st.age += eras;
  const byId = new Map(stars.map(s => [s.id, s]));
  // Polities come and go with intelligent life.
  for (const v of stars) if (!v.isPlayer && !st.polities[v.id]) st.polities[v.id] = foundPolity(v, rand);
  for (const k of Object.keys(st.polities)) if (!byId.has(Number(k)) || byId.get(Number(k))!.isPlayer) delete st.polities[Number(k)];
  st.routes = st.routes.filter(r => (byId.has(r.a) || r.a === home?.starId) && (byId.has(r.b) || r.b === home?.starId));

  // ── Each polity's own life ──
  for (const v of stars) {
    if (v.isPlayer) continue;
    const p = st.polities[v.id];
    // The engine changed its era (a war won or lost, a catastrophe): knowledge follows.
    if (v.civLevel < p.era) {
      const lost = p.techs.filter(id => TECH_BY_ID[id].era > v.civLevel);
      p.techs = p.techs.filter(id => TECH_BY_ID[id].era <= v.civLevel);
      p.era = eraOf(p.techs); p.research = null;
      if (lost.length) news.push({ kind: 'setback', starId: v.id, text: `lost the knowledge of ${lost.slice(-2).map(id => TECH_BY_ID[id].name).join(' and ')}` });
    } else if (v.civLevel > p.era) catchUp(p, v, rand);

    const fx = effectOf(p.techs);
    // What its world carries: food from the biosphere, room from habitability,
    // ore from the rock and its belts — all multiplied by what it knows.
    const food = 4000 * (0.25 + v.biosphere) * (0.4 + v.habitability) * fx.food * (1 + p.importFood);
    const room = 5200 * (0.4 + v.habitability) * fx.housing;
    const ore = 3200 * (MATERIAL_BY_TYPE[v.planetType] ?? 0.8) * (1 + v.belt * 0.8) * fx.materials * (1 + p.importMaterials);
    // A people that has lived on its world for ages stands at its limits.
    if (p.population <= 0) p.population = Math.min(food, room * 1.1);
    const cap = Math.min(food, room * 1.1);
    p.population = Math.max(10, p.population * (1 + Math.max(-0.4, 2.4 * eras * (1 - p.population / cap))));
    p.pollution = clamp01(p.pollution * (1 - 0.6 * eras) + fx.pollution * 60 * eras);
    p.inequality = clamp01(p.inequality * (1 - 0.1 * eras));
    const pr = p.pressures;
    pr.hunger = ramp(p.population / food, 0.88);
    pr.crowding = ramp(p.population / room, 0.8);
    pr.scarcity = ramp(p.population / ore, 0.7);
    pr.pollution = p.pollution;
    const target = clamp01(0.55 + 0.3 * v.values.collectivism + 0.15 * v.values.piety - 0.4 * pr.hunger - 0.15 * pr.crowding
      - 0.35 * p.inequality - 0.15 * p.pollution + fx.cohesion);
    p.cohesion += (target - p.cohesion) * Math.min(1, eras * 2);
    pr.unrest = clamp01((0.6 - p.cohesion) / 0.6);

    // Study, as the nations do: by pressure and temper, faster with a teacher.
    if (!p.research) {
      const opts = available(p.techs);
      if (opts.length) {
        const need: Record<Need, number> = { ...pr, curiosity: v.values.curiosity * 0.5 };
        const w = opts.map(t => appeal(t, need, v.values) + (teacherOf(st, home, v.id, t.id) ? 0.25 : 0));
        let x = rand() * w.reduce((a, b) => a + b, 0), i = 0;
        while (i < opts.length - 1 && (x -= w[i]) > 0) i++;
        p.research = { id: opts[i].id, progress: 0 };
      }
    }
    if (p.research) {
      const t = TECH_BY_ID[p.research.id];
      const taught = teacherOf(st, home, v.id, t.id) ? 1.6 : 1;
      const pace = Math.max(0.35, Math.min(1.9, (0.7 + 0.6 * v.values.curiosity) * Math.sqrt(fx.knowledge) * (1 - 0.6 * pr.unrest)));
      p.research.progress += eras * TECHS_PER_ERA * pace * taught / studyCost(t, p.era);
      if (p.research.progress >= 1) {
        p.techs.push(t.id);
        p.inequality = clamp01(p.inequality + (t.effect.inequality ?? 0));
        p.research = null;
        const was = p.era;
        p.era = eraOf(p.techs);
        news.push({ kind: 'learned', starId: v.id, tech: t.id, text: t.deed });
        if (p.era > was) news.push({ kind: 'era', starId: v.id, text: `entered a new age` });
      }
    }
    p.importFood = 0; p.importMaterials = 0;
  }

  // ── Relations and trade ──
  type Party = { id: number; x: number; y: number; era: number; values: CultureValues; pr: PolityPressures; att: Record<number, number>; grv: Record<number, number> };
  const parties: Party[] = stars.filter(v => !v.isPlayer).map(v => {
    const p = st.polities[v.id];
    return { id: v.id, x: v.x, y: v.y, era: p.era, values: v.values, pr: p.pressures, att: p.attitude, grv: p.grievance };
  });
  const homeStar = home ? stars.find(s => s.id === home.starId) : undefined;
  if (home && homeStar) {
    st.home ??= { attitude: {}, grievance: {} };
    parties.push({ id: home.starId, x: homeStar.x, y: homeStar.y, era: home.era, values: home.values, pr: home.pressures, att: st.home.attitude, grv: st.home.grievance });
  }
  const k = Math.min(1, eras * 3);
  for (let i = 0; i < parties.length; i++) for (let j = i + 1; j < parties.length; j++) {
    const A = parties[i], B = parties[j];
    const d = Math.hypot(A.x - B.x, A.y - B.y);
    const contact = d <= Math.max(reachOf(A.era), reachOf(B.era));
    const a = Math.min(A.id, B.id), b = Math.max(A.id, B.id);
    let route = st.routes.find(r => r.a === a && r.b === b);
    for (const [X, Y] of [[A, B], [B, A]] as const) X.grv[Y.id] = Math.max(0, (X.grv[Y.id] ?? 0) * (1 - 0.3 * eras));
    if (!contact) {
      if (route) st.routes = st.routes.filter(r => r !== route);
      continue;
    }
    const va = A.values, vb = B.values;
    const similarity = 1 - (Math.abs(va.militarism - vb.militarism) + Math.abs(va.piety - vb.piety)
      + Math.abs(va.curiosity - vb.curiosity) + Math.abs(va.collectivism - vb.collectivism)) / 4;
    const insular = (va.xenophobia + vb.xenophobia) / 2;
    const feud = (hashPair(A.id, B.id) - 0.5) * 0.6;
    for (const [X, Y] of [[A, B], [B, A]] as const) {
      const tgt = feud + (similarity - 0.7) * 1.6 - insular * 0.6 + (route ? 0.2 : 0) - (X.grv[Y.id] ?? 0) * 0.9;
      X.att[Y.id] = Math.max(-1, Math.min(1, (X.att[Y.id] ?? 0) + (tgt - (X.att[Y.id] ?? 0)) * k));
    }
    const mutual = ((A.att[B.id] ?? 0) + (B.att[A.id] ?? 0)) / 2;
    // What one lacks and the other can spare.
    const lacks = (P: Party, g: Goods) => g === 'grain' ? P.pr.hunger : g === 'ore' ? P.pr.scarcity : 0;
    const spares = (P: Party, g: Goods) => g === 'knowledge' ? P.values.curiosity > 0.5 : lacks(P, g) < 0.15;
    const want = (['grain', 'ore'] as Goods[]).map(g => [g, A, B, lacks(A, g)] as const)
      .concat((['grain', 'ore'] as Goods[]).map(g => [g, B, A, lacks(B, g)] as const))
      .filter(([g, needy, rich, l]) => l > 0.2 && spares(rich, g))
      .sort((x, y) => y[3] - x[3])[0];
    const knowledge = !want && A.values.curiosity > 0.55 && B.values.curiosity > 0.55;
    if (!route && mutual > 0.05 && (want || knowledge)) {
      const goods: Goods = want ? want[0] : 'knowledge';
      const to = want ? want[1].id : (A.era <= B.era ? A.id : B.id);
      route = { a, b, goods, to, since: st.age };
      st.routes.push(route);
      news.push({ kind: 'trade', starId: a, other: b, goods, to, text: goods === 'knowledge' ? 'scholars began to travel' : `${goods} began to flow` });
    } else if (route && mutual < -0.1) {
      st.routes = st.routes.filter(r => r !== route);
      news.push({ kind: 'trade-closed', starId: a, other: b, text: 'trade dried up' });
      route = undefined;
    } else if (route) {
      // Needs change: the route carries whatever is lacked now. Once no one
      // is short of anything, two curious peoples send scholars instead (a
      // route opened in a lean year does not carry only grain forever), and
      // a new shortage turns it back to goods.
      if (want && (want[0] !== route.goods || want[1].id !== route.to)) { route.goods = want[0]; route.to = want[1].id; }
      else if (!want && knowledge && route.goods !== 'knowledge') {
        route.goods = 'knowledge';
        route.to = A.era <= B.era ? A.id : B.id;
        news.push({ kind: 'trade', starId: a, other: b, goods: 'knowledge', to: route.to, text: 'scholars began to travel' });
      }
    }
    if (route) {
      const recv = st.polities[route.to];
      if (recv && route.goods === 'grain') recv.importFood += 0.25;
      if (recv && route.goods === 'ore') recv.importMaterials += 0.3;
    }
  }
  return news;
}

/** Goods flowing to the player's world by trade, as shares (for its nations). */
export function homeImports(st: InterstellarState, homeId: number): { food: number; materials: number; partners: number[] } {
  let food = 0, materials = 0;
  const partners: number[] = [];
  for (const r of st.routes) {
    if (r.a !== homeId && r.b !== homeId) continue;
    partners.push(r.a === homeId ? r.b : r.a);
    if (r.to !== homeId) continue;
    if (r.goods === 'grain') food += 0.25;
    if (r.goods === 'ore') materials += 0.3;
  }
  return { food, materials, partners };
}

/** A trading partner (or the home world) that already knows `tech`, teaching polity `id`. */
function teacherOf(st: InterstellarState, home: HomeView | null, id: number, tech: string): boolean {
  for (const r of st.routes) {
    if (r.a !== id && r.b !== id) continue;
    const o = r.a === id ? r.b : r.a;
    if (home && o === home.starId) { if (home.techs.includes(tech)) return true; continue; }
    if (st.polities[o]?.techs.includes(tech)) return true;
  }
  return false;
}

/**
 * Whether polity `id` goes to war now, and against whom: a martial people,
 * hard pressed, with a bitter rival in reach. Probability for this check
 * (the engine rolls it on its war cadence).
 */
export function warDrive(st: InterstellarState, id: number, values: CultureValues): { target: number; chance: number } | null {
  const p = st.polities[id];
  if (!p) return null;
  let worst: number | null = null, worstAtt = 0;
  for (const [o, a] of Object.entries(p.attitude)) if (a < worstAtt) { worstAtt = a; worst = Number(o); }
  if (worst == null || worstAtt > -0.25) return null;
  const need = Math.max(p.pressures.hunger, p.pressures.crowding, p.pressures.scarcity, p.pressures.unrest * 0.6, 0.15);
  return { target: worst, chance: Math.min(0.9, values.militarism * need * -worstAtt * 2.2) };
}

/** A war between two stars leaves wrongs remembered on both sides, and closes their trade. */
export function grieve(st: InterstellarState, a: number, b: number, amount: number, homeId = -1): void {
  for (const [x, y] of [[a, b], [b, a]]) {
    const rec = st.polities[x]?.grievance ?? (x === homeId ? st.home?.grievance : undefined);
    if (rec) rec[y] = Math.min(1, (rec[y] ?? 0) + amount);
  }
  st.routes = st.routes.filter(r => !((r.a === Math.min(a, b)) && r.b === Math.max(a, b)));
}
