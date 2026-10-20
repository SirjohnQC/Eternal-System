/**
 * Your people's story (docs/plans/2026-10-19-species-bond-and-cards.md, P1).
 *
 * What the "Your People" panel says about the player's species: what presses
 * on them, as symptoms (never "FAMINE 0.7"); what they are mostly doing; what
 * they believe about their god, from the casts they lived through; what shaped
 * each of their forms; and, later, the consequence beats: what they did, a
 * generation or more after a cast, that links back to it in the Chronicle.
 *
 * Pure functions over the simulation's own records (NationSystem, the
 * biosphere, the species forms). No DOM, no randomness, nothing written.
 */
import type { NationSystem, Nation, HistoryEntry, Pressures } from './Nations';
import type { SpeciesGenome, PlanetBiosphere } from './SpeciesGenome';
import type { SpeciesForm } from './GameState';
import { descendants, yourHand } from './Chronicle';

export type Severity = 1 | 2 | 3;

export interface Symptom {
  /** One line, in words: "the young go hungry in the Brood of Feum". */
  text: string;
  severity: Severity;
  /** What it is, for the "where they are going" line and for icons. */
  kind: keyof Pressures | 'war' | 'extinction' | 'air' | 'crowded_life' | 'none';
  /** The nation it is about (-1: the world). */
  nation: number;
}

export type Activity = 'working' | 'foraging' | 'fighting' | 'sheltering' | 'gathering' | 'praying' | 'spreading' | 'drifting';

/** "Selsul Runner" → "Selsul Runners"; already-plural names are kept. */
export function plural(name: string): string {
  const n = name.trim();
  if (!n) return 'your people';
  if (/s$/i.test(n)) return n;
  if (/[^aeiou]y$/i.test(n)) return n.slice(0, -1) + 'ies';
  if (/(x|ch|sh)$/i.test(n)) return n + 'es';
  return n + 's';
}

const live = (ns: NationSystem | null): Nation[] => ns?.isFounded ? ns.nations.filter(n => !n.fallen) : [];

const sev = (v: number, a: number, b: number, c: number): Severity | 0 => v >= c ? 3 : v >= b ? 2 : v >= a ? 1 : 0;

/** Lines per pressure, mild → severe; {n} is the nation's name. */
const PRESSURE_WORDS: Record<keyof Pressures, [string, string, string]> = {
  hunger: ['bellies go half-full in {n}', 'the young go hungry in {n}', '{n} is starving'],
  crowding: ['{n}\'s towns are filling up', '{n} is packed wall to wall', 'there is no room left to live in {n}'],
  scarcity: ['{n} counts its timber and stone', '{n} runs short of timber and stone', '{n} has nothing left to build with'],
  unrest: ['there is grumbling in {n}', '{n} mutters against its rulers', '{n} is close to revolt'],
  pollution: ['the rivers of {n} run cloudy', 'the air over {n} has turned sour', '{n} is choking on its own smoke'],
};

/** Thresholds per pressure for severity 1/2/3 (pressures are ~0..1+). */
const PRESSURE_BANDS: Record<keyof Pressures, [number, number, number]> = {
  hunger: [0.25, 0.45, 0.7],
  crowding: [0.35, 0.55, 0.8],
  scarcity: [0.3, 0.5, 0.75],
  unrest: [0.3, 0.5, 0.75],
  pollution: [0.3, 0.5, 0.75],
};

/**
 * What presses on the people now, worst first (at most `max`). Before there
 * are nations, it reads the living world instead: the air, the toll, how
 * crowded life has become.
 */
export function symptomsOf(ns: NationSystem | null, bio: PlanetBiosphere | null, max = 4): Symptom[] {
  const out: Symptom[] = [];
  const nations = live(ns);
  if (nations.length && ns) {
    for (const n of nations) {
      for (const k of Object.keys(PRESSURE_WORDS) as Array<keyof Pressures>) {
        const [a, b, c] = PRESSURE_BANDS[k];
        const s = sev(n.pressures[k], a, b, c);
        if (!s) continue;
        out.push({ text: PRESSURE_WORDS[k][s - 1].replace('{n}', n.name), severity: s, kind: k, nation: n.id });
      }
      for (const m of nations) {
        if (m.id <= n.id || !ns.atWar(n.id, m.id)) continue;
        out.push({ text: `${n.name} and ${m.name} are at war`, severity: 3, kind: 'war', nation: n.id });
      }
    }
  } else if (bio) {
    const t = sev(bio.extinctionPressure, 0.3, 0.5, 0.75);
    if (t) out.push({ text: ['life is hard and many die young', 'whole lineages are dying out', 'the world is killing its children'][t - 1], severity: t, kind: 'extinction', nation: -1 });
    const air = bio.oxygenLevel < 0.05 ? 2 : bio.oxygenLevel < 0.12 ? 1 : 0;
    if (air) out.push({ text: air === 2 ? 'there is almost nothing to breathe' : 'the air is thin and poor', severity: air as Severity, kind: 'air', nation: -1 });
    if (bio.biodiversity >= 8 && bio.biosphereDensity > 0.6) out.push({ text: 'every niche is taken; they must compete for each one', severity: 1, kind: 'crowded_life', nation: -1 });
  }
  out.sort((x, y) => y.severity - x.severity);
  return out.slice(0, max);
}

/**
 * What most of the people are doing right now, weighted by population: at war
 * they fight, hungry they forage, restless they gather, after a cast the devout
 * pray, otherwise they work. Before nations: they spread, or shelter if the
 * world is killing them.
 */
export function activityOf(ns: NationSystem | null, bio: PlanetBiosphere | null): Activity {
  const nations = live(ns);
  if (!nations.length || !ns) {
    if (bio && bio.extinctionPressure >= 0.5) return 'sheltering';
    return bio && bio.landLife > 0.05 ? 'spreading' : 'drifting';
  }
  const w: Record<Activity, number> = { working: 0.35, foraging: 0, fighting: 0, sheltering: 0, gathering: 0, praying: 0, spreading: 0, drifting: 0 };
  const total = nations.reduce((a, n) => a + Math.max(1, n.state.population), 0);
  const recentCast = ns.chronicle.some(e => e.kind === 'divine' && ns.now - e.age < 0.5);
  for (const n of nations) {
    const share = Math.max(1, n.state.population) / total;
    const atWar = nations.some(m => m.id !== n.id && ns.atWar(n.id, m.id));
    if (atWar) w.fighting += share * 1.2;
    w.foraging += share * Math.max(0, n.pressures.hunger - 0.25) * 1.6;
    w.gathering += share * Math.max(0, n.pressures.unrest - 0.3) * 1.4;
    w.sheltering += share * Math.max(0, n.pressures.pollution - 0.4);
    if (recentCast) w.praying += share * n.values.piety * 0.8;
  }
  return (Object.keys(w) as Activity[]).reduce((a, b) => (w[b] > w[a] ? b : a), 'working');
}

export const ACTIVITY_WORDS: Record<Activity, string> = {
  working: 'working the fields and the workshops',
  foraging: 'out foraging for anything to eat',
  fighting: 'at war',
  sheltering: 'sheltering from a world turned against them',
  gathering: 'gathered in the squares, arguing',
  praying: 'at prayer, watching the sky',
  spreading: 'spreading into new ground',
  drifting: 'drifting where the currents take them',
};

/** Stats as words (pillar C): "clever, wary of strangers, quick to anger". */
export function natureOf(g: SpeciesGenome): string[] {
  const d = g.dna, out: string[] = [];
  out.push(d.intelligence >= 8 ? 'brilliant' : d.intelligence >= 6 ? 'clever' : d.intelligence >= 4 ? 'cunning' : d.intelligence >= 2 ? 'simple' : 'mindless');
  out.push(d.social >= 7 ? 'deeply communal' : d.social >= 4 ? 'loyal to their own' : 'wary of strangers');
  out.push(d.aggression >= 7 ? 'quick to anger' : d.aggression >= 4 ? 'proud' : 'peaceable');
  out.push(d.adaptability >= 7 ? 'at home anywhere' : d.adaptability >= 4 ? 'hardy' : 'set in their ways');
  return out;
}

export interface Belief {
  text: string;
  /** Chronicle id of the cast it remembers (0: none). */
  cast: number;
}

/**
 * What the people believe about their god: how devout they are, and what they
 * remember of the casts they lived through (newest first, at most `max`). A
 * cast is remembered by what came of it, in the people's own history.
 */
export function beliefsOf(ns: NationSystem | null, max = 3): Belief[] {
  const nations = live(ns);
  if (!nations.length || !ns) return [];
  const out: Belief[] = [];
  const piety = nations.reduce((a, n) => a + n.values.piety * Math.max(1, n.state.population), 0)
    / nations.reduce((a, n) => a + Math.max(1, n.state.population), 0);
  out.push({ cast: 0, text: piety >= 0.7 ? 'They are devout: they look for you in every storm.'
    : piety >= 0.45 ? 'They believe in you, mostly, when it suits them.'
    : piety >= 0.25 ? 'They doubt you; signs are argued over, not obeyed.'
    : 'They barely think of you at all.' });
  const casts = ns.chronicle.filter(e => e.kind === 'divine').slice(-12).reverse();
  for (const c of casts) {
    if (out.length > max) break;
    const after = descendants(ns, c.id, 40).filter(e => e.nation >= 0);
    const card = castName(c.what);
    if (!after.length) {
      out.push({ cast: c.id, text: ns.now - c.age < 0.3 ? `${card}: they are still watching the sky.` : `${card}: it passed, and they hardly noticed.` });
      continue;
    }
    const ignored = after.filter(e => /few looked up/.test(e.what)).length;
    const mood = ignored > after.length / 2 ? 'Most never saw it.' : ns.now - c.age > 2 ? 'They still tell of it.' : 'They speak of it still.';
    // What came of it furthest on (nearest-first walk), in the history's own
    // words; nation names start it, so it is not lowercased.
    out.push({ cast: c.id, text: `${card}: ${after[after.length - 1].what} ${mood}` });
  }
  return out;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** "You cast THE LONG RAIN." → "The Long Rain" (casts are chronicled in the card's capitals). */
export function castName(what: string): string {
  const raw = what.replace(/^You (cast|spent [\d,.]+ TP on) /, '').replace(/\.$/, '').trim();
  return raw.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase())
    .replace(/ (Of|The|And|In|On|A|An|To)\b/g, m => m.toLowerCase());
}

export interface Shaping {
  /** "your Ice Age" or "the long hunger in Feum", or the mutations' own words. */
  text: string;
  /** Chronicle id to open (0: none). */
  entry: number;
}

/**
 * The one thing that shaped a form (pillar B): the player's act or the hardest
 * pressure the people lived through between the previous form and this one.
 * Before nations, it is what the form gained.
 */
export function shapedBy(form: SpeciesForm, prevTick: number, ns: NationSystem | null, mutationLabel: (id: string) => string): Shaping {
  if (form.form === 1) return { text: 'the first of them', entry: 0 };
  if (ns?.isFounded) {
    const window = ns.chronicle.filter(e => e.tick > prevTick && e.tick <= form.tick);
    const cast = [...window].reverse().find(e => e.kind === 'divine');
    if (cast) {
      return { text: `your ${castName(cast.what).replace(/^The /, '')}`, entry: cast.id };
    }
    const hard = [...window].reverse().find(e => e.nation >= 0 && /starv|hunger|famine|war|plague|revolt|flood|drought|cold|fire|quake/i.test(e.what));
    if (hard) return { text: lower(hard.what.replace(/\.$/, '')), entry: hard.id };
  }
  const gained = form.mutations.map(mutationLabel).filter(Boolean);
  return { text: gained.length ? `they grew ${gained.slice(0, 2).map(g => g.toLowerCase()).join(' and ')}` : 'time, and the world', entry: 0 };
}

/** The pressure most likely to shape the next form, as one line. */
export function headingOf(symptoms: readonly Symptom[]): string {
  const k = symptoms[0]?.kind ?? 'none';
  const WORDS: Record<Symptom['kind'], string> = {
    hunger: 'Hunger is shaping them: those who can eat anything will live to have children.',
    crowding: 'Crowding is shaping them: those who can live close, or leave, will prosper.',
    scarcity: 'Want of stone and timber is shaping them: clever hands will be prized.',
    unrest: 'Strife among them is shaping them: the persuasive and the cohesive will lead.',
    pollution: 'Their own smoke is shaping them: the hardy will outlast the rest.',
    war: 'War is shaping them: the strong and the wary will outlive the trusting.',
    extinction: 'The world is culling them: only the adaptable will remain.',
    air: 'The thin air is shaping them: those who need little of it will spread.',
    crowded_life: 'Competition is shaping them: every edge counts.',
    none: 'Nothing presses hard on them now; they grow as they please.',
  };
  return WORDS[k];
}

export interface Beat {
  /** The consequence: something the people did, in their own history. */
  entry: HistoryEntry;
  /** The cast at its root. */
  cast: HistoryEntry;
}

/**
 * Consequence beats (pillar D, "the answer"): entries in the nations' history
 * that follow from a cast by at least `gap` of an age (a generation or more),
 * not yet in `seen`. The beat is a symptom with a link to the cast, never "your
 * card caused X". Newest first, at most `max`.
 */
export function beatsSince(ns: NationSystem | null, seen: ReadonlySet<number>, gap = 0.5, max = 3): Beat[] {
  if (!ns?.isFounded) return [];
  const out: Beat[] = [];
  for (let i = ns.chronicle.length - 1; i >= 0 && out.length < max; i--) {
    const e = ns.chronicle[i];
    if (e.kind === 'divine' || e.nation < 0 || seen.has(e.id)) continue;
    const roots = yourHand(ns, e.id);
    const cast = roots[roots.length - 1];
    if (!cast || e.age - cast.age < gap) continue;
    out.push({ entry: e, cast });
  }
  return out;
}

/**
 * A card's description, spoken of the player's own people (pillar D.4): the
 * kin target names them, a nation target names the nation it would fall on.
 */
export function personalize(desc: string, targetText: string, peopleName: string, falls: readonly Nation[]): string {
  const ppl = plural(peopleName);
  let who: string | null = null;
  if (targetText === 'the cleverest kind of life on your world') who = `your ${ppl}`;
  else if (targetText === 'every nation') who = `every nation of the ${ppl}`;
  else if (falls.length === 1 && /nation$/.test(targetText)) who = `${falls[0].name} (${targetText})`;
  else if (falls.length === 2 && targetText === 'the two bitterest rivals') who = `${falls[0].name} and ${falls[1].name}`;
  if (!who) return desc;
  const i = desc.toLowerCase().indexOf(targetText.toLowerCase());
  if (i < 0) return desc;
  const out = desc.slice(0, i) + who + desc.slice(i + targetText.length);
  return out.charAt(0).toUpperCase() + out.slice(1);
}
