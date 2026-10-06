/**
 * Procedural Faith Cards (docs/CORE_LOOP_VISION.md §10–13, phase 4).
 *
 * A card is not a scripted event. It is a sentence built from parts —
 *   ACTION (what it does)  ·  TARGET (whom, chosen by the world's state when cast)
 *   CONDITION (when it works)  ·  MAGNITUDE  ·  DURATION  ·  COST
 *   SIDE EFFECTS (with it, or after it)  ·  ODDS (whether a people heeds it)
 * — and casting it lays omens on nations (Nations.ts `OmenOp`): operators on
 * their yields, rates, attitudes and temper. What follows emerges.
 *
 * Cards are DISCOVERED (§11): seeking spends DP and offers a few cards drawn
 * from what the world is going through now (famine turns up harvests and
 * exoduses; war turns up truces and war-drums). Cards are BURNED (§12): two go
 * into the crucible and one comes out, built from their parts — fused, refined,
 * or something wild nobody asked for. Every card has a price beyond DP (§13).
 *
 * Pure data + pure functions over a NationSystem. Deterministic per RNG.
 */
import type { NationSystem, Nation, OmenOp, OmenCondition } from './Nations';
import type { SeedRNG } from '../utils/SeedRNG';

// ─── Parts ────────────────────────────────────────────────────────────────────

/** What the world is going through, 0..1 each: what discovery is drawn from. */
export interface WorldSignals {
  hunger: number; crowding: number; scarcity: number; unrest: number; pollution: number;
  war: number; peace: number; trade: number; piety: number; curiosity: number;
  /** How much of all the people the biggest nation holds. */
  dominance: number;
  /** Most advanced nation's era / 8. */
  era: number;
}
type Signal = keyof WorldSignals;

export type ActionId = Exclude<OmenOp, 'smoke' | 'greed' | 'insularity' | 'dependency' | 'unrest' | 'stagnation'>;

interface ActionDef {
  id: ActionId;
  /** "fills the granaries of" — followed by the target, or with it at {t}. */
  verb: string;
  nouns: string[];
  adjectives: string[];
  /** Which world signals bring this card up in a search. */
  drawn: Partial<Record<Signal, number>>;
  /** The side effects it naturally drags along (its shadow). */
  shadow: Array<{ op: OmenOp; when: 'with' | 'after' }>;
  /** DP at magnitude 2, duration 2, one nation, always. */
  base: number;
  /** A curse rather than a blessing (shown in red). */
  bane?: boolean;
  /** Pixel icon (public/assets/pixel/divine/<icon>.png). */
  icon: string;
}

const A = (id: ActionId, verb: string, nouns: string[], adjectives: string[], drawn: ActionDef['drawn'],
  shadow: ActionDef['shadow'], base: number, icon: string, bane = false): ActionDef =>
  ({ id, verb, nouns, adjectives, drawn, shadow, base, icon, bane });

export const ACTIONS: ActionDef[] = [
  A('harvest', 'fills the granaries of', ['HARVEST', 'PLENTY', 'BOUNTY', 'GRANARY'], ['BOUNTIFUL', 'GOLDEN', 'ENDLESS', 'FAT'],
    { hunger: 1.4, crowding: 0.2 }, [{ op: 'dependency', when: 'after' }, { op: 'greed', when: 'with' }, { op: 'fertility', when: 'with' }], 8, 'harvest'),
  A('fertility', 'fills the cradles of', ['CRADLE', 'MULTITUDE', 'SEED', 'HEARTH'], ['FRUITFUL', 'TEEMING', 'WARM'],
    { war: 0.6, dominance: 0.3 }, [{ op: 'pestilence', when: 'after' }, { op: 'unrest', when: 'after' }], 7, 'evolution'),
  A('inspire', 'kindles invention in', ['SPARK', 'INVENTION', 'VISION', 'LANTERN'], ['BRIGHT', 'RESTLESS', 'SUDDEN'],
    { curiosity: 0.9, scarcity: 0.7, pollution: 0.4, era: 0.3 }, [{ op: 'smoke', when: 'with' }, { op: 'greed', when: 'with' }, { op: 'unrest', when: 'after' }], 9, 'sight'),
  A('veins', 'opens hidden veins of ore beneath', ['VEIN', 'ORE', 'QUARRY', 'LODE'], ['HIDDEN', 'SHINING', 'BURIED'],
    { scarcity: 1.4 }, [{ op: 'greed', when: 'with' }, { op: 'smoke', when: 'with' }, { op: 'discord', when: 'with' }], 7, 'terraform'),
  A('cleanse', 'washes the soot from', ['RAIN', 'RIVER', 'BREATH', 'TIDE'], ['CLEANSING', 'CLEAR', 'SILVER'],
    { pollution: 1.8 }, [{ op: 'stagnation', when: 'with' }, { op: 'blight', when: 'with' }], 8, 'harvest'),
  A('concord', 'softens hearts between {t} and its neighbours', ['ACCORD', 'BRIDGE', 'OLIVE', 'HANDSHAKE'], ['OPEN', 'KINDRED', 'GENTLE'],
    { war: 1.0, unrest: 0.4, trade: 0.2 }, [{ op: 'unrest', when: 'with' }, { op: 'greed', when: 'with' }], 8, 'prophet'),
  A('discord', 'sows discord between {t} and its neighbours', ['DISCORD', 'RUMOUR', 'WHISPER', 'SPLINTER'], ['BITTER', 'POISONED', 'CROOKED'],
    { peace: 0.7, trade: 0.6, dominance: 0.6 }, [{ op: 'insularity', when: 'with' }, { op: 'fervor', when: 'with' }], 6, 'smite', true),
  A('zeal', 'sets faith burning in', ['FAITH', 'FLAME', 'CREED', 'VIGIL'], ['BURNING', 'HOLY', 'UNBROKEN'],
    { unrest: 1.1, piety: 0.8 }, [{ op: 'insularity', when: 'with' }, { op: 'stagnation', when: 'with' }, { op: 'fervor', when: 'after' }], 7, 'revelation'),
  A('calm', 'lays a heavy calm over', ['STILLNESS', 'DOVE', 'SABBATH', 'TRUCE'], ['QUIET', 'LONG', 'DEEP'],
    { war: 1.3, unrest: 0.5 }, [{ op: 'stagnation', when: 'with' }, { op: 'unrest', when: 'after' }], 8, 'prophet'),
  A('fervor', 'beats the war-drums in', ['BANNER', 'SPEAR', 'DRUM', 'HOST'], ['IRON', 'RED', 'MARCHING'],
    { war: 1.0, dominance: 0.2 }, [{ op: 'discord', when: 'with' }, { op: 'pestilence', when: 'after' }, { op: 'unrest', when: 'after' }], 7, 'smite'),
  A('exodus', 'sends people out of', ['EXODUS', 'ROAD', 'WANDERING', 'HORIZON'], ['LONG', 'FAR', 'UNCERTAIN'],
    { crowding: 1.4, hunger: 0.6 }, [{ op: 'discord', when: 'with' }, { op: 'insularity', when: 'after' }], 7, 'meteor'),
  A('blight', 'withers the fields of', ['BLIGHT', 'LOCUST', 'ROT', 'DROUGHT'], ['BLACK', 'CREEPING', 'GREY'],
    { dominance: 1.0, war: 0.4 }, [{ op: 'exodus', when: 'with' }, { op: 'unrest', when: 'with' }], 6, 'meteor', true),
  A('pestilence', 'sends fever among', ['PLAGUE', 'FEVER', 'PALLOR', 'MIASMA'], ['PALE', 'CREEPING', 'SILENT'],
    { crowding: 0.8, dominance: 0.8 }, [{ op: 'zeal', when: 'with' }, { op: 'unrest', when: 'with' }], 6, 'smite', true),
];
export const ACTION_BY_ID = Object.fromEntries(ACTIONS.map(a => [a.id, a])) as Record<ActionId, ActionDef>;

/** Plain names for side effects (and actions met as side effects). */
export const OP_LABEL: Record<OmenOp, string> = {
  harvest: 'plenty', blight: 'blight', dependency: 'dependency', fertility: 'more mouths', pestilence: 'fever',
  inspire: 'invention', stagnation: 'learning withers', veins: 'new ore', greed: 'inequality', cleanse: 'cleansing',
  smoke: 'smoke and soot', concord: 'goodwill', discord: 'resentment', insularity: 'closed borders', zeal: 'zealotry',
  calm: 'calm', fervor: 'militarism', exodus: 'emigration', unrest: 'unrest',
};

export type TargetId = 'hungriest' | 'crowded' | 'poorest' | 'restless' | 'strongest' | 'weakest' | 'pious'
  | 'advanced' | 'backward' | 'all' | 'rivals' | 'warring';

interface TargetDef { id: TargetId; text: string; drawn: Partial<Record<Signal, number>>; cost: number; noun: string }
const TARGETS: TargetDef[] = [
  { id: 'hungriest', text: 'the hungriest nation', drawn: { hunger: 1.2 }, cost: 1, noun: 'THE HUNGRY' },
  { id: 'crowded', text: 'the most crowded nation', drawn: { crowding: 1.2 }, cost: 1, noun: 'THE THRONG' },
  { id: 'poorest', text: 'the nation poorest in stone and timber', drawn: { scarcity: 1.2 }, cost: 1, noun: 'THE WANTING' },
  { id: 'restless', text: 'the most restless nation', drawn: { unrest: 1.2 }, cost: 1, noun: 'THE RESTLESS' },
  { id: 'strongest', text: 'the mightiest nation', drawn: { dominance: 1.2, war: 0.3 }, cost: 1.1, noun: 'THE MIGHTY' },
  { id: 'weakest', text: 'the weakest nation', drawn: { dominance: 0.8, war: 0.4 }, cost: 0.9, noun: 'THE MEEK' },
  { id: 'pious', text: 'the most devout nation', drawn: { piety: 0.9 }, cost: 0.9, noun: 'THE FAITHFUL' },
  { id: 'advanced', text: 'the most advanced nation', drawn: { era: 0.6, curiosity: 0.3 }, cost: 1.1, noun: 'THE LEARNED' },
  { id: 'backward', text: 'the most backward nation', drawn: { era: 0.4 }, cost: 0.9, noun: 'THE LAGGARD' },
  { id: 'all', text: 'every nation', drawn: { peace: 0.3, pollution: 0.4 }, cost: 1.9, noun: 'THE WORLD' },
  { id: 'rivals', text: 'the two bitterest rivals', drawn: { war: 0.7, peace: 0.3 }, cost: 1.4, noun: 'THE RIVALS' },
  { id: 'warring', text: 'every nation at war', drawn: { war: 1.2 }, cost: 1.5, noun: 'THE BATTLEFIELD' },
];
const TARGET_BY_ID = Object.fromEntries(TARGETS.map(t => [t.id, t])) as Record<TargetId, TargetDef>;

interface ConditionDef { id: OmenCondition; text: string; drawn: Partial<Record<Signal, number>>; noun: string }
const CONDITIONS: ConditionDef[] = [
  { id: 'always', text: '', drawn: {}, noun: '' },
  { id: 'hunger', text: 'while it goes hungry', drawn: { hunger: 1 }, noun: 'FAMINE' },
  { id: 'scarcity', text: 'while it lacks stone and timber', drawn: { scarcity: 1 }, noun: 'NECESSITY' },
  { id: 'crowding', text: 'while its towns are crowded', drawn: { crowding: 1 }, noun: 'THE MULTITUDE' },
  { id: 'unrest', text: 'while its people quarrel', drawn: { unrest: 1 }, noun: 'DISCONTENT' },
  { id: 'war', text: 'while it is at war', drawn: { war: 1 }, noun: 'WAR' },
  { id: 'peace', text: 'while it is at peace', drawn: { peace: 0.8 }, noun: 'PEACE' },
  { id: 'pious', text: 'if its people are devout', drawn: { piety: 0.8 }, noun: 'THE DEVOUT' },
  { id: 'curious', text: 'if its people are curious', drawn: { curiosity: 0.8 }, noun: 'THE CURIOUS' },
];
const COND_BY_ID = Object.fromEntries(CONDITIONS.map(c => [c.id, c])) as Record<OmenCondition, ConditionDef>;

/** A few pairings the world already has sayings for. */
const PROVERBS: Partial<Record<`${ActionId}:${OmenCondition}`, string[]>> = {
  'inspire:scarcity': ['NECESSITY IS THE MOTHER'],
  'harvest:war': ['BREAD FOR THE BESIEGED'],
  'harvest:hunger': ['MANNA', 'THE LEAN YEAR ENDS'],
  'fervor:hunger': ['HUNGER MARCHES'],
  'zeal:unrest': ['ONE FAITH, ONE PEOPLE'],
  'concord:war': ['THE OLIVE BRANCH'],
  'calm:war': ["THE GODS' TRUCE"],
  'exodus:crowding': ['THE LONG ROAD OUT'],
  'exodus:hunger': ['THE HUNGRY ROAD'],
  'pestilence:crowding': ['THE CROWDED FEVER'],
  'discord:peace': ['A SERPENT IN THE GARDEN'],
  'blight:war': ['SALTED EARTH'],
  'veins:scarcity': ['THE MOUNTAIN PROVIDES'],
  'cleanse:always': ['THE GREAT WASHING'],
  'fertility:war': ['SONS FOR THE FRONT'],
};

export const MAGNITUDES = ['WHISPER', 'SIGN', 'MIRACLE'] as const;
const MAG_STRENGTH = [0.5, 1, 1.7];
const MAG_COST = [0.6, 1, 1.8];
const MAG_ODDS = [0.92, 0.82, 0.68];
/** Era-time each duration lasts, and what it costs. */
export const DURATION_ERAS = [0.25, 0.5, 1];
export const DURATIONS = ['a season', 'a generation', 'an age'] as const;
const DUR_COST = [0.7, 1, 1.5];

// ─── The card ─────────────────────────────────────────────────────────────────

export interface SideEffect { op: OmenOp; when: 'with' | 'after'; /** 1..3 */ mag: number }

export interface FaithCard {
  id: string;
  name: string;
  /** One or two actions (a fused card has two). */
  actions: ActionId[];
  target: TargetId;
  condition: OmenCondition;
  /** 1 whisper .. 3 miracle. */
  magnitude: number;
  /** 1 season .. 3 age. */
  duration: number;
  sides: SideEffect[];
  cost: number;
  /** 0..1: the chance a people heeds it (devout peoples more). */
  odds: number;
  /** Where it came from: "glimpsed in a time of hunger", "forged from X and Y". */
  origin: string;
  /** Times burned through the crucible to make it (0: discovered). */
  forged: number;
}

/** DP to cast a card: action, reach, strength, length; a condition makes it cheaper, side effects too. */
export function priceOf(c: Pick<FaithCard, 'actions' | 'target' | 'condition' | 'magnitude' | 'duration' | 'sides'>): number {
  const base = c.actions.reduce((a, id, i) => a + ACTION_BY_ID[id].base * (i ? 0.7 : 1), 0);
  const cond = c.condition === 'always' ? 1 : 0.7;
  const sides = c.sides.reduce((a, s) => a + (s.when === 'after' ? 0.8 : 1.2) * s.mag, 0);
  return Math.max(2, Math.round(base * MAG_COST[c.magnitude - 1] * DUR_COST[c.duration - 1] * TARGET_BY_ID[c.target].cost * cond - sides));
}

/** Chance a people heeds the card: miracles are harder to accept; two actions are harder still. */
export function oddsOf(c: Pick<FaithCard, 'magnitude' | 'actions'>): number {
  return MAG_ODDS[c.magnitude - 1] - (c.actions.length - 1) * 0.08;
}

/** "Fills the granaries of the hungriest nation while it goes hungry, for a generation." */
export function describe(c: FaithCard): string {
  const plural = c.target === 'all' || c.target === 'warring' || c.target === 'rivals';
  const t = TARGET_BY_ID[c.target].text;
  let cond = COND_BY_ID[c.condition].text;
  if (plural) cond = cond.replace('it goes', 'they go').replace('it lacks', 'they lack').replace('it is', 'they are')
    .replace(/\bits\b/g, 'their').replace(/\bpeople are\b/, 'peoples are');
  const say = (verb: string, who: string) => {
    if (!verb.includes('{t}')) return `${verb} ${who}`;
    // The rivals' discord (or concord) is with each other.
    if (c.target === 'rivals' && who === t) return verb.replace('{t} and its neighbours', 'the two bitterest rivals');
    return verb.replace('{t}', who).replace('its neighbours', plural ? 'their neighbours' : 'its neighbours');
  };
  const [v1, v2] = c.actions.map(a => ACTION_BY_ID[a].verb);
  const s = `${say(v1, t)}${v2 ? ` and ${say(v2, plural ? 'them' : 'it')}` : ''}${cond ? ` ${cond}` : ''}, for ${DURATIONS[c.duration - 1]}.`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The parts of a card, as rows for a tooltip. */
export function anatomy(c: FaithCard): Array<[string, string]> {
  return [
    ['Action', c.actions.map(a => ACTION_BY_ID[a].nouns[0].toLowerCase()).join(' + ')],
    ['Target', TARGET_BY_ID[c.target].text],
    ['Condition', COND_BY_ID[c.condition].text || 'none'],
    ['Magnitude', MAGNITUDES[c.magnitude - 1].toLowerCase()],
    ['Duration', DURATIONS[c.duration - 1]],
    ['Odds', `${Math.round(c.odds * 100)}% a people heeds it`],
    ['Side effects', c.sides.length ? c.sides.map(s => `${OP_LABEL[s.op]}${s.when === 'after' ? ' (afterward)' : ''}`).join(', ') : 'none foreseen'],
  ];
}

export const isBane = (c: FaithCard): boolean => !!ACTION_BY_ID[c.actions[0]].bane;
export const iconOf = (c: FaithCard): string => ACTION_BY_ID[c.actions[0]].icon;

// ─── Reading the world ────────────────────────────────────────────────────────

export function signalsOf(ns: NationSystem): WorldSignals {
  const live = ns.nations.filter(n => !n.fallen);
  const s: WorldSignals = { hunger: 0, crowding: 0, scarcity: 0, unrest: 0, pollution: 0, war: 0, peace: 0, trade: 0, piety: 0, curiosity: 0, dominance: 0, era: 0 };
  if (!live.length) return s;
  let pop = 0, big = 0;
  for (const n of live) {
    s.hunger = Math.max(s.hunger, n.pressures.hunger);
    s.crowding = Math.max(s.crowding, n.pressures.crowding);
    s.scarcity = Math.max(s.scarcity, n.pressures.scarcity);
    s.unrest = Math.max(s.unrest, n.pressures.unrest);
    s.pollution = Math.max(s.pollution, n.pressures.pollution);
    s.piety += n.values.piety / live.length;
    s.curiosity += n.values.curiosity / live.length;
    s.era = Math.max(s.era, n.era / 8);
    pop += n.state.population; big = Math.max(big, n.state.population);
  }
  const rel = ns.relations.filter(r => !ns.nations[r.a].fallen && !ns.nations[r.b].fallen);
  s.war = rel.some(r => r.war) ? 1 : 0;
  s.peace = live.length > 1 && !s.war ? 1 : 0;
  s.trade = rel.length ? rel.filter(r => r.trade).length / rel.length : 0;
  // 1/n of the people is no dominance; all of them is total.
  s.dominance = live.length > 1 ? Math.max(0, (big / Math.max(1, pop) - 1 / live.length) / (1 - 1 / live.length)) : 1;
  return s;
}

const weigh = (drawn: Partial<Record<Signal, number>>, sig: WorldSignals, base: number): number =>
  base + (Object.entries(drawn) as Array<[Signal, number]>).reduce((a, [k, w]) => a + w * sig[k], 0);

function pickWeighted<T>(rng: SeedRNG, items: T[], w: number[]): T {
  let x = rng.next() * w.reduce((a, b) => a + b, 0), i = 0;
  while (i < items.length - 1 && (x -= w[i]) > 0) i++;
  return items[i];
}

/** The strongest world signal, in words, for a card's origin. */
function moodOf(sig: WorldSignals): string {
  const moods: Array<[number, string]> = [
    [sig.hunger, 'a time of hunger'], [sig.crowding, 'a time of crowded towns'], [sig.scarcity, 'a time of want'],
    [sig.unrest, 'a time of quarrels'], [sig.pollution, 'a time of smoke'], [sig.war * 0.7, 'a time of war'],
    [sig.dominance * 0.6, 'the shadow of one great power'], [sig.peace * 0.3, 'a time of peace'],
  ];
  moods.sort((a, b) => b[0] - a[0]);
  return moods[0][0] > 0.15 ? moods[0][1] : 'a quiet time';
}

// ─── Making cards ─────────────────────────────────────────────────────────────

function nameOf(rng: SeedRNG, actions: ActionId[], target: TargetId, cond: OmenCondition, mag: number): string {
  const a = ACTION_BY_ID[actions[0]];
  const proverb = PROVERBS[`${actions[0]}:${cond}`];
  if (actions.length === 1 && proverb && rng.chance(0.7)) return rng.pick(proverb);
  if (actions.length === 2) {
    const b = ACTION_BY_ID[actions[1]];
    return rng.pick([
      `THE ${rng.pick(a.nouns)} OF THE ${rng.pick(b.nouns)}`,
      `${rng.pick(b.adjectives)} ${rng.pick(a.nouns)}`,
      `${rng.pick(a.nouns)} AND ${rng.pick(b.nouns)}`,
    ]);
  }
  const condNoun = COND_BY_ID[cond].noun;
  const forms = [
    `${rng.pick(a.adjectives)} ${rng.pick(a.nouns)}`,
    `${rng.pick(a.adjectives)} ${rng.pick(a.nouns)}`,
    `THE ${rng.pick(a.nouns)} OF ${TARGET_BY_ID[target].noun}`,
    ...(condNoun ? [`${rng.pick(a.nouns)} IN ${condNoun}`, `THE ${rng.pick(a.nouns)} OF ${condNoun}`] : []),
  ];
  const name = rng.pick(forms);
  return mag === 3 && !name.startsWith('THE ') && rng.chance(0.5) ? `GREAT ${name}` : name;
}

function build(rng: SeedRNG, parts: Omit<FaithCard, 'id' | 'name' | 'cost' | 'odds'>, id: string): FaithCard {
  const name = nameOf(rng, parts.actions, parts.target, parts.condition, parts.magnitude);
  const c: FaithCard = { ...parts, id, name, cost: 0, odds: 0 };
  c.cost = priceOf(c);
  c.odds = oddsOf(c);
  return c;
}

/** Side effects for a fresh card: usually its own shadow, sometimes an unforeseen one too. */
function sidesFor(rng: SeedRNG, action: ActionId, mag: number): SideEffect[] {
  const a = ACTION_BY_ID[action], out: SideEffect[] = [];
  if (rng.chance(0.8)) {
    const s = rng.pick(a.shadow);
    out.push({ op: s.op, when: s.when, mag: Math.max(1, Math.min(3, mag + (rng.chance(0.3) ? 1 : 0) - (rng.chance(0.3) ? 1 : 0))) });
  }
  if (rng.chance(0.25)) {
    const wild = rng.pick(['greed', 'unrest', 'smoke', 'insularity', 'stagnation', 'dependency', 'fertility', 'zeal'] as OmenOp[]);
    if (!out.some(s => s.op === wild) && wild !== action) out.push({ op: wild, when: wild === 'dependency' || rng.chance(0.4) ? 'after' : 'with', mag: rng.nextInt(1, 2) });
  }
  return out;
}

/**
 * Seek (§11): `count` cards drawn from what the world is going through. Each
 * action, target and condition is weighted by the signals that bring it up,
 * so a famine turns up harvests and roads out, a war turns up truces and
 * war-drums — but anything can surface.
 */
export function discover(sig: WorldSignals, rng: SeedRNG, count: number, idBase: string): FaithCard[] {
  const out: FaithCard[] = [];
  const mood = moodOf(sig);
  for (let i = 0; i < count; i++) {
    const pool = ACTIONS.filter(a => !out.some(c => c.actions[0] === a.id));
    const action = pickWeighted(rng, pool, pool.map(a => weigh(a.drawn, sig, 0.15))).id;
    // Targets that fit the action: a curse on the mighty, a blessing on the needy.
    const targets = TARGETS.filter(t => ACTION_BY_ID[action].bane
      ? !['hungriest', 'weakest', 'backward'].includes(t.id)
      : (action === 'concord' || action === 'discord') ? t.id !== 'all' : true);
    const target = pickWeighted(rng, targets, targets.map(t => weigh(t.drawn, sig, 0.1))).id;
    const cond = rng.chance(0.55) ? 'always'
      : pickWeighted(rng, CONDITIONS.slice(1), CONDITIONS.slice(1).map(c => weigh(c.drawn, sig, 0.08))).id;
    const magnitude = pickWeighted(rng, [1, 2, 3], [0.4, 0.45, 0.15]);
    const duration = pickWeighted(rng, [1, 2, 3], [0.35, 0.45, 0.2]);
    out.push(build(rng, { actions: [action], target, condition: cond, magnitude, duration,
      sides: sidesFor(rng, action, magnitude), origin: `Glimpsed in ${mood}.`, forged: 0 }, `${idBase}-${i}`));
  }
  return out;
}

/** How a burning turned out (shown to the player after the fact). */
export type ForgeKind = 'fusion' | 'refinement' | 'wild';

/**
 * Burn (§12): two cards go into the crucible, one comes out, built from their
 * parts. Not predictable:
 *  - fusion: both purposes in one card, and both shadows (a costly, potent card);
 *  - refinement: one purpose made stronger, the weaker card's side effects burned away;
 *  - wild: one purpose bound to something neither card held — unknown potential.
 */
export function forge(a: FaithCard, b: FaithCard, rng: SeedRNG, id: string): { card: FaithCard; kind: ForgeKind } {
  const roll = rng.next();
  const [lead, other] = rng.chance(0.5) ? [a, b] : [b, a];
  const target = rng.chance(0.5) ? a.target : b.target;
  const condition = rng.chance(0.5) ? a.condition : b.condition;
  const forged = Math.max(a.forged, b.forged) + 1;
  const origin = `Forged from ${a.name} and ${b.name}.`;
  const clampMag = (x: number) => Math.max(1, Math.min(3, x));
  const merge = (xs: SideEffect[]): SideEffect[] => {
    const seen = new Map<string, SideEffect>();
    for (const s of xs) {
      const k = `${s.op}:${s.when}`, prev = seen.get(k);
      seen.set(k, prev ? { ...prev, mag: clampMag(prev.mag + 1) } : s);
    }
    return [...seen.values()].slice(0, 3);
  };
  const leadAct = lead.actions[0], otherAct = other.actions.find(x => x !== leadAct) ?? other.actions[0];
  if (roll < 0.45 && otherAct !== leadAct) {
    const card = build(rng, { actions: [leadAct, otherAct], target, condition,
      magnitude: Math.max(a.magnitude, b.magnitude), duration: Math.max(a.duration, b.duration),
      sides: merge([...a.sides, ...b.sides]), origin, forged }, id);
    return { card, kind: 'fusion' };
  }
  if (roll < 0.75) {
    const card = build(rng, { actions: [leadAct], target: lead.target, condition: lead.condition,
      magnitude: clampMag(lead.magnitude + 1), duration: clampMag(Math.max(lead.duration, other.duration)),
      sides: lead.sides.slice(0, 1), origin, forged }, id);
    return { card, kind: 'refinement' };
  }
  // Wild: one purpose kept, bound to an action neither card held, with a new shadow.
  const strangers = ACTIONS.filter(x => !a.actions.includes(x.id) && !b.actions.includes(x.id));
  const stranger = rng.pick(strangers).id;
  const actions: ActionId[] = rng.chance(0.6) ? [leadAct, stranger] : [stranger];
  const target2 = rng.pick(TARGETS).id;
  const card = build(rng, { actions, target: target2, condition: rng.chance(0.5) ? condition : 'always',
    magnitude: rng.nextInt(1, 3), duration: rng.nextInt(1, 3),
    sides: merge([...sidesFor(rng, stranger, 2), ...(rng.chance(0.5) ? lead.sides : [])]), origin, forged }, id);
  return { card, kind: 'wild' };
}

// ─── Casting ──────────────────────────────────────────────────────────────────

/** Which nations a target means, read from the world as it is now. */
export function resolveTarget(ns: NationSystem, target: TargetId): Nation[] {
  const live = ns.nations.filter(n => !n.fallen);
  if (!live.length) return [];
  const by = (f: (n: Nation) => number) => [live.reduce((m, n) => f(n) > f(m) ? n : m)];
  switch (target) {
    case 'hungriest': return by(n => n.pressures.hunger + n.state.foodNeed / Math.max(1e-6, n.state.foodYield) * 0.01);
    case 'crowded': return by(n => n.pressures.crowding + n.state.population / Math.max(1, n.state.land) * 1e-4);
    case 'poorest': return by(n => n.pressures.scarcity - n.state.materials * 1e-5);
    case 'restless': return by(n => n.pressures.unrest + (1 - n.state.cohesion) * 0.01);
    case 'strongest': return by(n => n.state.population * (1 + 0.25 * n.era));
    case 'weakest': return by(n => -n.state.population * (1 + 0.25 * n.era));
    case 'pious': return by(n => n.values.piety);
    case 'advanced': return by(n => n.techs.length);
    case 'backward': return by(n => -n.techs.length);
    case 'all': return live;
    case 'warring': return live.filter(n => ns.relations.some(r => r.war && (r.a === n.id || r.b === n.id)));
    case 'rivals': {
      let worst: { a: number; b: number; attitude: number } | null = null;
      for (const r of ns.relations) {
        if (ns.nations[r.a].fallen || ns.nations[r.b].fallen) continue;
        const score = r.attitude - r.grievance - (r.war ? 1 : 0);
        if (!worst || score < worst.attitude) worst = { a: r.a, b: r.b, attitude: score };
      }
      return worst ? [ns.nations[worst.a], ns.nations[worst.b]] : [];
    }
  }
}

/** What happened when a card was cast. */
export interface CastResult {
  heeded: Nation[];
  ignored: Nation[];
  /** One line for the feed, phrased as what was seen. */
  line: string;
}

/**
 * Cast (§10, §13): each nation the target names may heed the sign or not
 * (odds, raised by devotion). Where it is heeded, the card's actions become
 * omens for its duration, its side effects ride along (or follow after), and
 * the history records the card as the cause.
 */
export function cast(ns: NationSystem, card: FaithCard, rng: SeedRNG, tick: number): CastResult {
  const targets = resolveTarget(ns, card.target);
  const heeded: Nation[] = [], ignored: Nation[] = [];
  const now = ns.now, len = DURATION_ERAS[card.duration - 1], m = MAG_STRENGTH[card.magnitude - 1];
  const label = card.name.toLowerCase().replace(/(^|\s)\S/g, x => x.toUpperCase()).replace(/^The /, '');
  for (const n of targets) {
    const odds = card.odds <= 0 ? 0 : Math.max(0.1, Math.min(0.98, card.odds + 0.3 * (n.values.piety - 0.5)));
    if (!rng.chance(odds)) {
      ignored.push(n);
      ns.record(n.id, tick, `A sign appeared over ${n.name}, and few looked up.`, [`the ${label}`, n.values.piety < 0.4 ? 'a worldly people' : 'chance']);
      continue;
    }
    heeded.push(n);
    card.actions.forEach((op, i) => ns.bless(n.id, { card: label, op, m: m * (i ? 0.7 : 1), cond: card.condition, from: now, until: now + len, aftermath: false, primary: true }));
    for (const s of card.sides) {
      const sm = MAG_STRENGTH[s.mag - 1] * 0.8;
      if (s.when === 'with') ns.bless(n.id, { card: label, op: s.op, m: sm, cond: 'always', from: now, until: now + len, aftermath: false, primary: false });
      else ns.bless(n.id, { card: label, op: s.op, m: sm, cond: 'always', from: now + len, until: now + len * 1.75, aftermath: true, primary: false });
    }
  }
  const names = (xs: Nation[]) => xs.map(n => n.name).join(xs.length === 2 ? ' and ' : ', ');
  const line = !targets.length ? `${card.name}: the sign found no one to fall upon.`
    : !heeded.length ? `${card.name}: a sign blazed over ${names(ignored)}, and few looked up.`
    : `${card.name} falls upon ${names(heeded)}.${ignored.length ? ` ${names(ignored)} paid it no heed.` : ''}`;
  return { heeded, ignored, line };
}
