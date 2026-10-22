/**
 * Tech cards: what the player's people do with what they know (#40; design in
 * docs/plans/2026-10-14-tech-cards.md).
 *
 * Faith Cards are signs a god sends, and nations may heed them or not. A tech
 * card is spent from TP (the knowledge the people gathered) and always
 * happens, but only where the knowledge is: most act on the nations that know
 * the card's technology, so the same card lifts one nation and leaves its
 * neighbour behind.
 *
 * Every card is benefit + price (vision §13): the same omen operators Faith
 * Cards lay (Nations.OmenOp), a price riding along or following after, and a
 * few engine-level acts (a deflected asteroid, an ark, a stolen technology).
 * What the nations do with it is the story.
 *
 * Pure data + pure functions; the engine plays them (BigBangEngine.playTechCard).
 */
import type { OmenOp, OmenCondition } from './Nations';
import { TECHS, type Tech } from './Technology';

/** Engine-level acts a card can carry beyond omens. */
export type TechSpecial =
  | 'new_world'      // A New World (the relocation UI; BigBangEngine.relocateHome)
  | 'eureka'         // knowers finish what they are studying
  | 'accident'       // a chance one knower suffers an accident (Nuclear Deterrent's price)
  | 'defence'        // asteroids aimed at the home world are turned aside, for a while
  | 'eyes'           // the sky is charted far out
  | 'founding_fleet' // an ark leaves now for the best world in reach
  | 'kinship'        // colonies keep close contact with home, for a while
  | 'ambassadors'    // every known people warms to you; each learns something
  | 'espionage'      // steal a technology from the most advanced people in reach
  | 'terraform'      // the home world starts terraforming (the player picks)
  | 'gene_shaping'   // the species takes evolutionary steps now
  | 'seedships';     // life seeded on the nearest lifeless world

export interface TechOmen { op: OmenOp; m: number; eras: number; cond?: OmenCondition }
export interface TechPrice { op: OmenOp; m: number; when: 'with' | 'after'; eras: number }

export interface TechCardDef {
  id: string;
  name: string;
  /** What unlocks it: a technology any of the nations knows, or an era reached. */
  needs: { tech?: string; era?: number };
  /** Base TP. */
  cost: number;
  /** Who the omens fall on: the nations that know `needs.tech`, every nation, or none (a world act). */
  who: 'knowers' | 'all' | 'world';
  omens?: TechOmen[];
  price?: TechPrice[];
  /** Change to each target nation's inequality, once (laws, welfare). */
  inequality?: number;
  special?: TechSpecial;
  /** Card face: what it does, and what it costs beyond TP. */
  does: string;
  priceText: string;
  /** Icon under /assets/pixel/divine/cards/. */
  icon: string;
  /** A small card, made from its technology's own effect (every node grants a card; owner's model, Oct 22). */
  minor?: boolean;
}

const SEASON = 0.25, GENERATION = 0.5, AGE = 1;

const C = (d: TechCardDef) => d;

export const TECH_CARDS: TechCardDef[] = [
  // ── Ancient ──
  C({ id: 'granaries', name: 'GREAT GRANARIES', needs: { tech: 'granaries' }, cost: 2, who: 'knowers', icon: 'harvest',
    omens: [{ op: 'harvest', m: 1.25, eras: AGE, cond: 'hunger' }],
    price: [{ op: 'dependency', m: 0.6, when: 'after', eras: GENERATION }],
    does: 'Stores against lean years: the nations that know granaries reap far more while hunger lasts, for an age.',
    priceText: 'Afterward they forget how to go without.' }),
  C({ id: 'libraries', name: 'FIRST LIBRARIES', needs: { tech: 'writing' }, cost: 3, who: 'knowers', icon: 'inspire',
    omens: [{ op: 'inspire', m: 0.6, eras: GENERATION }],
    price: [{ op: 'unrest', m: 0.4, when: 'with', eras: GENERATION }],
    does: 'The nations that can write gather what they know: their study runs much faster for a generation.',
    priceText: 'New ideas, new quarrels.' }),
  C({ id: 'armies', name: 'STANDING ARMIES', needs: { tech: 'bronze' }, cost: 3, who: 'knowers', icon: 'fervor',
    omens: [{ op: 'fervor', m: 1, eras: GENERATION }],
    price: [{ op: 'discord', m: 0.5, when: 'with', eras: GENERATION }, { op: 'greed', m: 0.5, when: 'with', eras: GENERATION }],
    does: 'The nations that cast bronze keep soldiers year-round: far stronger in war, for a generation.',
    priceText: 'A sword looks for a use: they eye their neighbours, and the few grow rich.' }),
  C({ id: 'temples', name: 'TEMPLE CITIES', needs: { tech: 'priesthood' }, cost: 3, who: 'knowers', icon: 'zeal',
    omens: [{ op: 'zeal', m: 1, eras: GENERATION }, { op: 'calm', m: 0.4, eras: GENERATION }],
    price: [{ op: 'stagnation', m: 0.5, when: 'with', eras: GENERATION }],
    does: 'The nations with priests raise great temples: one faith holds them together, for a generation.',
    priceText: 'The priests distrust inquiry; study slows.' }),
  C({ id: 'roads', name: 'ROADS OF STONE', needs: { tech: 'masonry' }, cost: 4, who: 'knowers', icon: 'seafaring',
    omens: [{ op: 'seafaring', m: 1, eras: AGE }, { op: 'concord', m: 0.4, eras: AGE }],
    price: [{ op: 'pestilence', m: 0.5, when: 'after', eras: SEASON }],
    does: 'Paved roads reach every nation: trade and teaching travel from the builders to all, and goodwill with them, for an age.',
    priceText: 'Roads carry fever too.' }),
  // ── Medieval ──
  C({ id: 'canals', name: 'GREAT CANALS', needs: { tech: 'irrigation' }, cost: 4, who: 'knowers', icon: 'rains',
    omens: [{ op: 'harvest', m: 1.75, eras: AGE }, { op: 'fertility', m: 0.8, eras: AGE }],
    price: [{ op: 'blight', m: 0.8, when: 'after', eras: GENERATION }],
    does: 'Canals water every field of the nations that irrigate: harvests and families grow, for an age.',
    priceText: 'Afterward the watered fields turn salt.' }),
  C({ id: 'laws', name: 'THE CODE OF LAWS', needs: { tech: 'law' }, cost: 4, who: 'knowers', icon: 'concord',
    omens: [{ op: 'zeal', m: 0.5, eras: GENERATION }],
    inequality: -0.1,
    price: [{ op: 'insularity', m: 0.6, when: 'with', eras: GENERATION }],
    does: 'One law for great and small in the nations that write their laws: the gap between rich and poor narrows, and they hold together.',
    priceText: 'Outsiders are outsiders: they turn cold to their neighbours.' }),
  C({ id: 'universities', name: 'UNIVERSITIES', needs: { tech: 'scholarship' }, cost: 5, who: 'knowers', icon: 'golden',
    omens: [{ op: 'inspire', m: 1, eras: GENERATION }],
    price: [{ op: 'schism', m: 0.6, when: 'with', eras: GENERATION }],
    does: 'The scholarly nations found universities: their study doubles, for a generation.',
    priceText: 'Doubt erodes faith: the temples split.' }),
  C({ id: 'forges', name: 'THE GREAT FORGES', needs: { tech: 'iron' }, cost: 4, who: 'knowers', icon: 'veins',
    omens: [{ op: 'veins', m: 1, eras: GENERATION }],
    price: [{ op: 'smoke', m: 1, when: 'with', eras: GENERATION }, { op: 'fervor', m: 0.4, when: 'with', eras: GENERATION }],
    does: 'The iron-working nations fire great forges: they win far more metal and stone, for a generation.',
    priceText: 'Smoke over the towns; and iron makes swords.' }),
  C({ id: 'quarantine', name: 'QUARANTINE', needs: { tech: 'sanitation' }, cost: 4, who: 'all', icon: 'cure',
    omens: [{ op: 'cure', m: 1.2, eras: GENERATION }],
    price: [{ op: 'insularity', m: 0.8, when: 'with', eras: GENERATION }],
    does: 'Every nation shuts out fever: far fewer die of disease, for a generation.',
    priceText: 'Borders close: trade and teaching slow.' }),
  // ── Industrial ──
  C({ id: 'industry', name: 'INDUSTRIAL PUSH', needs: { tech: 'factories' }, cost: 5, who: 'knowers', icon: 'volcano',
    omens: [{ op: 'veins', m: 1.5, eras: GENERATION }, { op: 'inspire', m: 0.5, eras: GENERATION }],
    price: [{ op: 'smoke', m: 1.6, when: 'with', eras: GENERATION }, { op: 'greed', m: 1, when: 'with', eras: GENERATION }],
    does: 'The factory nations run their mills day and night: far more materials and faster study, for a generation.',
    priceText: 'Heavy smoke, and the wealth goes to the few.' }),
  C({ id: 'eureka', name: 'EUREKA', needs: { tech: 'printing' }, cost: 5, who: 'knowers', icon: 'awaken', special: 'eureka',
    price: [{ op: 'greed', m: 0.5, when: 'with', eras: SEASON }],
    does: 'Every nation that prints finishes what it is studying now: whatever its own troubles led it to.',
    priceText: 'The new idea has its winners.' }),
  C({ id: 'vaccination', name: 'VACCINATION', needs: { tech: 'medicine' }, cost: 5, who: 'all', icon: 'cure',
    omens: [{ op: 'cure', m: 1.5, eras: AGE }, { op: 'fertility', m: 0.5, eras: AGE }],
    does: 'Every nation is vaccinated: far fewer die and more children live, for an age.',
    priceText: 'Nothing, except every new mouth to feed.' }),
  // ── Atomic ──
  C({ id: 'green', name: 'GREEN REVOLUTION', needs: { tech: 'fertiliser' }, cost: 6, who: 'knowers', icon: 'herds',
    omens: [{ op: 'harvest', m: 1.5, eras: AGE }, { op: 'fertility', m: 0.6, eras: AGE }],
    price: [{ op: 'smoke', m: 1, when: 'with', eras: AGE }, { op: 'dependency', m: 1, when: 'after', eras: AGE }],
    does: 'The nations that make fertiliser double their fields and their families, for an age.',
    priceText: 'Fouled air now, exhausted soil after.' }),
  C({ id: 'propaganda', name: 'PROPAGANDA', needs: { tech: 'mass_media' }, cost: 6, who: 'knowers', icon: 'calm',
    omens: [{ op: 'zeal', m: 1, eras: GENERATION }, { op: 'calm', m: 0.6, eras: GENERATION }],
    price: [{ op: 'unrest', m: 1, when: 'after', eras: GENERATION }],
    does: 'The broadcasting nations speak with one voice: united and quiet, for a generation.',
    priceText: 'When the voice falls silent, the anger it hid comes out.' }),
  C({ id: 'welfare', name: 'SOCIAL CONTRACT', needs: { tech: 'welfare' }, cost: 6, who: 'knowers', icon: 'concord',
    omens: [{ op: 'concord', m: 0.6, eras: GENERATION }],
    inequality: -0.15,
    price: [{ op: 'stagnation', m: 0.4, when: 'with', eras: GENERATION }],
    does: 'The welfare nations share their wealth: the gap between rich and poor closes, and they look kindly on their neighbours.',
    priceText: 'Study slows.' }),
  C({ id: 'deterrent', name: 'NUCLEAR DETERRENT', needs: { tech: 'fission' }, cost: 7, who: 'all', icon: 'foe', special: 'accident',
    omens: [{ op: 'calm', m: 1.4, eras: GENERATION }],
    does: 'Every nation fears what war would bring: wars wind down and new ones hold off, for a generation.',
    priceText: 'One chance in three of an accident: a nation that splits the atom takes fever and fallout.' }),
  // ── Space Age ──
  C({ id: 'defence', name: 'PLANETARY DEFENCE', needs: { tech: 'rocketry' }, cost: 6, who: 'knowers', icon: 'meteor', special: 'defence',
    price: [{ op: 'stagnation', m: 0.4, when: 'with', eras: GENERATION }],
    does: 'Rockets stand ready: every asteroid aimed at your world is turned aside, for an age.',
    priceText: 'The effort comes out of study.' }),
  C({ id: 'new_world', name: 'A NEW WORLD', needs: { era: 5 }, cost: 10, who: 'world', icon: 'exodus', special: 'new_world',
    does: 'Your whole people leaves its world for another in your system (or, from the Interstellar age, under another star). They keep what they know.',
    priceText: 'The old world is left to the wild.' }),
  C({ id: 'eyes', name: 'EYES ON THE SKY', needs: { tech: 'satellites' }, cost: 4, who: 'world', icon: 'sight', special: 'eyes',
    does: 'Your satellites chart the sky far out: the stars and peoples around you come into view.',
    priceText: 'Nothing but what you will find.' }),
  C({ id: 'clean', name: 'CLEAN SKIES', needs: { tech: 'clean_energy' }, cost: 6, who: 'all', icon: 'cleanse',
    omens: [{ op: 'cleanse', m: 1.5, eras: GENERATION }],
    price: [{ op: 'unrest', m: 0.5, when: 'with', eras: SEASON }],
    does: 'Every nation turns to clean power: the air and land clear fast, for a generation.',
    priceText: 'The old industries close; their workers are angry.' }),
  C({ id: 'machines', name: 'THINKING MACHINES', needs: { tech: 'automation' }, cost: 7, who: 'knowers', icon: 'golden',
    omens: [{ op: 'inspire', m: 1, eras: GENERATION }, { op: 'veins', m: 1, eras: GENERATION }],
    price: [{ op: 'greed', m: 1.2, when: 'with', eras: GENERATION }, { op: 'unrest', m: 0.8, when: 'after', eras: GENERATION }],
    does: 'The automated nations let machines think and build: study doubles and materials pour in, for a generation.',
    priceText: 'The machines\' owners grow rich; afterward, the people they replaced.' }),
  // ── Interstellar ──
  C({ id: 'fleet', name: 'FOUNDING FLEET', needs: { tech: 'colony_ark' }, cost: 8, who: 'world', icon: 'seafaring', special: 'founding_fleet',
    price: [{ op: 'unrest', m: 0.4, when: 'with', eras: SEASON }],
    does: 'An ark leaves now for the best world your people can reach.',
    priceText: 'Families split at the docks.' }),
  C({ id: 'kinship', name: 'KINSHIP NETWORK', needs: { tech: 'orbital' }, cost: 5, who: 'world', icon: 'concord', special: 'kinship',
    does: 'Ships and signals tie your colonies to home: they change more slowly and stay loyal, for an age.',
    priceText: 'Nothing on the card.' }),
  C({ id: 'ambassadors', name: 'AMBASSADORS', needs: { tech: 'orbital' }, cost: 6, who: 'world', icon: 'seek', special: 'ambassadors',
    does: 'Envoys go to every people you know: they warm to yours.',
    priceText: 'Each of them learns something from you.' }),
  C({ id: 'espionage', name: 'INDUSTRIAL ESPIONAGE', needs: { tech: 'ai' }, cost: 7, who: 'world', icon: 'theft', special: 'espionage',
    does: 'Your most curious nation steals a technology from the most advanced people in reach.',
    priceText: 'They find out, and remember.' }),
  C({ id: 'terraform', name: 'REMAKE A WORLD', needs: { tech: 'terraforming' }, cost: 12, who: 'world', icon: 'terraform', special: 'terraform',
    does: 'Your home world starts to become a kinder kind of world (you choose).',
    priceText: 'Upheaval while it changes.' }),
  // ── Post-Human and beyond ──
  C({ id: 'genes', name: 'GENE SHAPING', needs: { tech: 'gene_shaping' }, cost: 8, who: 'knowers', icon: 'mutate', special: 'gene_shaping',
    price: [{ op: 'schism', m: 0.6, when: 'with', eras: GENERATION }],
    does: 'Your species takes two evolutionary steps now.',
    priceText: 'Purity debates split the faithful.' }),
  C({ id: 'longevity', name: 'LONG LIFE', needs: { tech: 'longevity' }, cost: 8, who: 'knowers', icon: 'hardy',
    omens: [{ op: 'cure', m: 2, eras: AGE }, { op: 'zeal', m: 0.4, eras: AGE }],
    price: [{ op: 'greed', m: 1, when: 'with', eras: AGE }],
    does: 'The nations that know longevity stop growing old: deaths fall away, for an age.',
    priceText: 'The old hold on to everything; the young wait.' }),
  C({ id: 'seedships', name: 'SEEDSHIPS', needs: { tech: 'seedships' }, cost: 9, who: 'world', icon: 'seed', special: 'seedships',
    does: 'Seedships carry life to the nearest lifeless world.',
    priceText: 'Nothing but what that life becomes.' }),
];

// ─── Small cards: one for every technology without an authored card ──────────
//
// Owner's model (Oct 22): the player unlocks the tree itself, so every node
// must grant something. A technology with no authored card grants a small
// one, read from what the technology does (its strongest benefit, pressed
// hard for a generation by the nations that know it) with the price its own
// effect carries (smoke, greed, cracked certainties) or, failing that, the
// unrest of new ways. Lawful, never a flat bonus (vision §13), and cheap:
// 2 TP in the Ancient age to 5 in the Post-Biological.

/** The small card for technology `t`. */
export function minorCardOf(t: Tech): TechCardDef {
  const e = t.effect;
  const [op, m, icon, words]: [OmenOp, number, string, string] =
    (e.food ?? 1) > 1 ? ['harvest', 0.6, 'harvest', 'their fields yield far more']
    : (e.materials ?? 1) > 1 ? ['veins', 0.6, 'veins', 'they win far more wood, stone and ore']
    : (e.knowledge ?? 1) > 1 ? ['inspire', 0.5, 'inspire', 'their study runs faster']
    : (e.housing ?? 1) > 1 ? ['fertility', 0.5, 'fertility', 'their towns grow and more children live']
    : (e.pollution ?? 0) < 0 ? ['cleanse', 1, 'cleanse', 'their land and air clear']
    : (e.cohesion ?? 0) > 0 || (e.inequality ?? 0) < 0 ? ['zeal', 0.5, 'concord', 'they hold together']
    : ['inspire', 0.4, 'awaken', 'curiosity takes hold of them'];
  const [pop, pm, priceText]: [OmenOp, number, string] =
    (e.pollution ?? 0) > 0 ? ['smoke', 0.6, 'Smoke over their towns.']
    : (e.inequality ?? 0) > 0 ? ['greed', 0.5, 'The few grow rich on it.']
    : (e.cohesion ?? 0) < 0 ? ['unrest', 0.5, 'Old certainties crack.']
    : ['unrest', 0.3, 'Not everyone wants the new ways.'];
  return {
    id: `t_${t.id}`, name: t.name.toUpperCase(), needs: { tech: t.id }, cost: 1 + Math.ceil(t.era / 2), who: 'knowers', icon, minor: true,
    omens: [{ op, m, eras: GENERATION }],
    price: [{ op: pop, m: pm, when: 'with', eras: GENERATION }],
    inequality: (e.inequality ?? 0) < 0 ? -0.05 : undefined,
    does: `The nations that know ${t.name} press it hard: ${words}, for a generation.`,
    priceText,
  };
}

{
  const authored = new Set(TECH_CARDS.map(c => c.needs.tech).filter(Boolean));
  for (const t of TECHS) if (!authored.has(t.id)) TECH_CARDS.push(minorCardOf(t));
}

export const TECH_CARD_BY_ID: Record<string, TechCardDef> = Object.fromEntries(TECH_CARDS.map(c => [c.id, c]));

// ─── TP economy ───────────────────────────────────────────────────────────────

/** TP when the home world enters a new age (as before). */
export const TP_PER_ERA = 3;
/** TP when any of the home world's nations learns a technology for the first time. */
export const TP_PER_DISCOVERY = 1;

// ─── Wear: a card played recently costs more ─────────────────────────────────

export type TechWear = Record<string, { n: number; tick: number }>;
/** Each recent use marks the next price up by this share. */
export const TECH_WEAR_PRICE = 0.25;
/** Ticks for a use to fade to 1/e (about two ages of normal play). */
export const TECH_WEAR_LIFE = 120_000;

const decayed = (u: { n: number; tick: number } | undefined, tick: number) =>
  u ? u.n * Math.exp(-Math.max(0, tick - u.tick) / TECH_WEAR_LIFE) : 0;

/** TP a card costs now. */
export function techPrice(card: TechCardDef, wear: TechWear, tick: number): number {
  return Math.round(card.cost * (1 + TECH_WEAR_PRICE * decayed(wear[card.id], tick)));
}

export function noteTechUse(wear: TechWear, id: string, tick: number): void {
  wear[id] = { n: decayed(wear[id], tick) + 1, tick };
}

// ─── The owner's model (Oct 22): TP unlock the tree, an unlock grants cards ───
//
// TP are spent on technologies in the tree, not on cards. Unlocking a
// technology is the god inspiring the nations (the neediest nation that could
// study it learns it at once) and puts that technology's card(s) into the TP
// hand; a card in hand is burned (played) for free, and leaves the hand. A
// burned card comes back by unlocking its node again (a recall), at the
// card's price marked up by wear. Every technology grants a card (an authored
// one, or its small card, minorCardOf). A New World is no technology: it
// stays a standing card from the Space Age, paid in TP when played.
// Design: docs/plans/2026-10-14-tech-cards.md, "Owner's model, Oct 22".

/** The cards each technology grants when unlocked. */
export const CARDS_OF_TECH: Record<string, TechCardDef[]> = (() => {
  const out: Record<string, TechCardDef[]> = {};
  for (const c of TECH_CARDS) if (c.needs.tech) (out[c.needs.tech] ??= []).push(c);
  return out;
})();

/** A node a nation already knows costs this share (rounded up): they did the work, the god only names it. */
export const KNOWN_NODE_SHARE = 0.5;

/**
 * TP a technology node costs now. First unlock: its cards' base costs (2 in the
 * Ancient age .. 12 for Remake a World), halved when a nation already knows it.
 * Recall (`recall`: the node is unlocked and `missing` cards were burned): those
 * cards' prices marked up by wear.
 */
export function nodePrice(tech: string, wear: TechWear, tick: number, knownAlready: boolean, recall: readonly string[] | null): number {
  const cards = CARDS_OF_TECH[tech] ?? [];
  if (recall) return cards.filter(c => recall.includes(c.id)).reduce((s, c) => s + techPrice(c, wear, tick), 0);
  const base = cards.reduce((s, c) => s + c.cost, 0);
  return knownAlready ? Math.ceil(base * KNOWN_NODE_SHARE) : base;
}

/** Whether `known` (every tech any home nation knows) and `era` unlock the card. */
export function techCardUnlocked(card: TechCardDef, known: ReadonlySet<string>, era: number): boolean {
  if (card.needs.era != null && era < card.needs.era) return false;
  if (card.needs.tech && !known.has(card.needs.tech)) return false;
  return true;
}
