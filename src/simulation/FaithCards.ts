/**
 * Procedural Faith Cards (docs/CORE_LOOP_VISION.md §10–13, phase 4).
 *
 * A card is not a scripted event. It is a sentence built from parts —
 *   ACTION (what it does)  ·  TARGET (whom or where, read from the world when cast)
 *   CONDITION (when it works)  ·  MAGNITUDE  ·  DURATION / REACH  ·  COST
 *   SIDE EFFECTS (with it, or after it)  ·  ODDS (whether a people heeds it)
 *
 * Actions come in four scopes:
 *  - NATION: omens on nations (Nations.ts `OmenOp`), operators on their yields,
 *    rates, attitudes and temper;
 *  - WORLD: works on the land itself (DivineWorks.ts) — rain, drought, quakes,
 *    fire mountains, ice, comets — which the nations then have to live with;
 *  - LIFE: works on living things (herds, murrain, the people's own bodies);
 *  - COSMOS: the heavens (sight, meteors, seeding life, terraforming), done
 *    by the engine through a host.
 * Whatever follows emerges from the state they leave behind.
 *
 * Cards are DISCOVERED (§11): seeking offers cards drawn from what the world
 * is going through. Cards are BURNED (§12): two become one — fused, refined,
 * or wild. Every card has a price beyond DP (§13), and the heavens TIRE: each
 * recent use of a kind of card makes the next one dearer and less heeded.
 *
 * Pure data + pure functions. Deterministic per RNG.
 */
import type { NationSystem, Nation, OmenOp, OmenCondition } from './Nations';
import type { SeedRNG } from '../utils/SeedRNG';
import type { PlanetGrid } from './PlanetGrid';
import { GRID_SIZE, isHabitable, isWater } from './PlanetGrid';
import type { SpeciesGenome } from './SpeciesGenome';
import { work, workLine, WORK_TOLL, type WorkId, type Region } from './DivineWorks';

// ─── World signals ────────────────────────────────────────────────────────────

/** What the world is going through, 0..1 each: what discovery is drawn from. */
export interface WorldSignals {
  hunger: number; crowding: number; scarcity: number; unrest: number; pollution: number;
  war: number; peace: number; trade: number; piety: number; curiosity: number;
  /** How much of all the people the biggest nation holds. */
  dominance: number;
  /** Most advanced nation's era / 8. */
  era: number;
  /** No nations yet (life, or not even that). */
  young: number;
  /** Share of habitable land no one has settled. */
  wild: number;
  /** Share of land that is cold (tundra, snow) or dry (desert). */
  cold: number; dry: number;
  /** A lifeless world within reach for a meteor. */
  lifeless: number;
}
type Signal = keyof WorldSignals;

/** What can be done at all right now (decides which cards a seek can turn up). */
export interface WorldContext {
  nations: boolean;
  life: boolean;
  grid: boolean;
  intelligent: boolean;
  lifeless: boolean;
  terraform: boolean;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

export type Scope = 'nation' | 'world' | 'life' | 'cosmos';
export type CosmicWork = 'sight' | 'meteor' | 'seed' | 'terraform' | 'mutate';

export type ActionId =
  // nation
  | 'harvest' | 'fertility' | 'inspire' | 'veins' | 'cleanse' | 'concord' | 'discord' | 'zeal' | 'calm'
  | 'fervor' | 'exodus' | 'blight' | 'pestilence' | 'theft' | 'foe' | 'schism' | 'golden' | 'revolt'
  | 'cure' | 'seafaring'
  // world
  | 'rains' | 'drought' | 'quake' | 'volcano' | 'ice_age' | 'comet'
  // life
  | 'hardy' | 'herds' | 'murrain' | 'awaken' | 'mutate'
  // cosmos
  | 'sight' | 'meteor' | 'seed' | 'terraform';

interface ActionDef {
  id: ActionId;
  scope: Scope;
  /** "fills the granaries of" — followed by the target, or with it at {t}. */
  verb: string;
  nouns: string[];
  adjectives: string[];
  /** Which world signals bring this card up in a search. */
  drawn: Partial<Record<Signal, number>>;
  /** The side effects it naturally drags along (its shadow), as omens on nations. */
  shadow: Array<{ op: OmenOp; when: 'with' | 'after' }>;
  /** DP at magnitude 2, duration 2, one nation, always. */
  base: number;
  /** Pixel icon (public/assets/pixel/divine/<icon>.png). */
  icon: string;
  bane?: boolean;
  /** NATION: the omen it lays. */
  omen?: OmenOp;
  /** WORLD / LIFE: what it does to land or life. */
  work?: WorkId;
  /** A strike falls on a capital (or one place) rather than across whole lands. */
  strike?: boolean;
  /** COSMOS (and mutate): what the engine does. */
  cosmic?: CosmicWork;
  /** A lighter omen laid on every nation the work touches (the herds feed them…). */
  echo?: { op: OmenOp; m: number };
  /** Targets it can take (default: any nation target). */
  targets?: TargetId[];
  /** Needs this from the world to turn up at all. */
  needs?: keyof WorldContext;
}

const NATION_T: TargetId[] = ['hungriest', 'crowded', 'poorest', 'restless', 'strongest', 'weakest', 'pious', 'advanced', 'backward', 'all', 'rivals', 'warring'];
const LAND_T: TargetId[] = ['hungriest', 'crowded', 'poorest', 'strongest', 'weakest', 'rivals', 'all', 'wilds', 'driest', 'wettest', 'coldest'];
const STRIKE_T: TargetId[] = ['strongest', 'weakest', 'advanced', 'restless', 'warring', 'wilds', 'driest', 'coldest'];

type Opt = Partial<Pick<ActionDef, 'bane' | 'omen' | 'work' | 'strike' | 'cosmic' | 'echo' | 'targets' | 'needs'>>;
const A = (id: ActionId, scope: Scope, verb: string, nouns: string[], adjectives: string[], drawn: ActionDef['drawn'],
  shadow: ActionDef['shadow'], base: number, icon: string, opt: Opt = {}): ActionDef =>
  ({ id, scope, verb, nouns, adjectives, drawn, shadow, base, icon, ...opt });

export const ACTIONS: ActionDef[] = [
  // ── Nations: omens ──
  A('harvest', 'nation', 'fills the granaries of', ['HARVEST', 'PLENTY', 'BOUNTY', 'GRANARY'], ['BOUNTIFUL', 'GOLDEN', 'ENDLESS', 'FAT'],
    { hunger: 1.4, crowding: 0.2 }, [{ op: 'dependency', when: 'after' }, { op: 'greed', when: 'with' }, { op: 'fertility', when: 'with' }], 8, 'harvest', { omen: 'harvest' }),
  A('fertility', 'nation', 'fills the cradles of', ['CRADLE', 'MULTITUDE', 'SEED', 'HEARTH'], ['FRUITFUL', 'TEEMING', 'WARM'],
    { war: 0.6, dominance: 0.3 }, [{ op: 'pestilence', when: 'after' }, { op: 'unrest', when: 'after' }], 7, 'evolution', { omen: 'fertility' }),
  A('inspire', 'nation', 'kindles invention in', ['SPARK', 'INVENTION', 'VISION', 'LANTERN'], ['BRIGHT', 'RESTLESS', 'SUDDEN'],
    { curiosity: 0.9, scarcity: 0.7, pollution: 0.4, era: 0.3 }, [{ op: 'smoke', when: 'with' }, { op: 'greed', when: 'with' }, { op: 'unrest', when: 'after' }], 9, 'sight', { omen: 'inspire' }),
  A('veins', 'nation', 'opens hidden veins of ore beneath', ['VEIN', 'ORE', 'QUARRY', 'LODE'], ['HIDDEN', 'SHINING', 'BURIED'],
    { scarcity: 1.4 }, [{ op: 'greed', when: 'with' }, { op: 'smoke', when: 'with' }, { op: 'discord', when: 'with' }], 7, 'terraform', { omen: 'veins' }),
  A('cleanse', 'nation', 'washes the soot from', ['RAIN', 'RIVER', 'BREATH', 'TIDE'], ['CLEANSING', 'CLEAR', 'SILVER'],
    { pollution: 1.8 }, [{ op: 'stagnation', when: 'with' }, { op: 'blight', when: 'with' }], 8, 'harvest', { omen: 'cleanse' }),
  A('concord', 'nation', 'softens hearts between {t} and its neighbours', ['ACCORD', 'BRIDGE', 'OLIVE', 'HANDSHAKE'], ['OPEN', 'KINDRED', 'GENTLE'],
    { war: 1.0, unrest: 0.4, trade: 0.2 }, [{ op: 'unrest', when: 'with' }, { op: 'greed', when: 'with' }], 8, 'prophet', { omen: 'concord' }),
  A('discord', 'nation', 'sows discord between {t} and its neighbours', ['DISCORD', 'RUMOUR', 'WHISPER', 'SPLINTER'], ['BITTER', 'POISONED', 'CROOKED'],
    { peace: 0.7, trade: 0.6, dominance: 0.6 }, [{ op: 'insularity', when: 'with' }, { op: 'fervor', when: 'with' }], 6, 'smite', { omen: 'discord', bane: true }),
  A('zeal', 'nation', 'sets faith burning in', ['FAITH', 'FLAME', 'CREED', 'VIGIL'], ['BURNING', 'HOLY', 'UNBROKEN'],
    { unrest: 1.1, piety: 0.8 }, [{ op: 'insularity', when: 'with' }, { op: 'stagnation', when: 'with' }, { op: 'fervor', when: 'after' }], 7, 'revelation', { omen: 'zeal' }),
  A('calm', 'nation', 'lays a heavy calm over', ['STILLNESS', 'DOVE', 'SABBATH', 'TRUCE'], ['QUIET', 'LONG', 'DEEP'],
    { war: 1.3, unrest: 0.5 }, [{ op: 'stagnation', when: 'with' }, { op: 'unrest', when: 'after' }], 8, 'prophet', { omen: 'calm' }),
  A('fervor', 'nation', 'beats the war-drums in', ['BANNER', 'SPEAR', 'DRUM', 'HOST'], ['IRON', 'RED', 'MARCHING'],
    { war: 1.0, dominance: 0.2 }, [{ op: 'discord', when: 'with' }, { op: 'pestilence', when: 'after' }, { op: 'unrest', when: 'after' }], 7, 'smite', { omen: 'fervor' }),
  A('exodus', 'nation', 'sends people out of', ['EXODUS', 'ROAD', 'WANDERING', 'HORIZON'], ['LONG', 'FAR', 'UNCERTAIN'],
    { crowding: 1.4, hunger: 0.6 }, [{ op: 'discord', when: 'with' }, { op: 'insularity', when: 'after' }], 7, 'meteor', { omen: 'exodus' }),
  A('blight', 'nation', 'withers the fields of', ['BLIGHT', 'LOCUST', 'ROT', 'CANKER'], ['BLACK', 'CREEPING', 'GREY'],
    { dominance: 1.0, war: 0.4 }, [{ op: 'exodus', when: 'with' }, { op: 'unrest', when: 'with' }], 6, 'meteor', { omen: 'blight', bane: true }),
  A('pestilence', 'nation', 'sends fever among', ['PLAGUE', 'FEVER', 'PALLOR', 'MIASMA'], ['PALE', 'CREEPING', 'SILENT'],
    { crowding: 0.8, dominance: 0.8 }, [{ op: 'zeal', when: 'with' }, { op: 'unrest', when: 'with' }], 6, 'smite', { omen: 'pestilence', bane: true }),
  A('theft', 'nation', 'steals a rival\'s secrets for', ['CIPHER', 'MASK', 'KEY', 'SHADOW'], ['STOLEN', 'MASKED', 'SILENT'],
    { era: 0.5, dominance: 0.6, curiosity: 0.3 }, [{ op: 'discord', when: 'with' }, { op: 'insularity', when: 'after' }], 10, 'sight', { omen: 'theft', targets: ['weakest', 'backward', 'poorest', 'restless', 'hungriest'] }),
  A('foe', 'nation', 'turns every nation against', ['FOE', 'LEAGUE', 'PACT', 'COALITION'], ['COMMON', 'SWORN', 'GATHERED'],
    { dominance: 1.4, war: 0.3 }, [{ op: 'fervor', when: 'with' }, { op: 'insularity', when: 'after' }], 9, 'smite', { omen: 'foe', bane: true, targets: ['strongest', 'advanced', 'pious', 'restless'] }),
  A('schism', 'nation', 'splits the faith of', ['SCHISM', 'HERESY', 'RIFT', 'SECT'], ['SPLIT', 'HERETIC', 'BROKEN'],
    { piety: 0.9, unrest: 0.5, dominance: 0.3 }, [{ op: 'discord', when: 'with' }, { op: 'zeal', when: 'after' }], 6, 'revelation', { omen: 'schism', bane: true }),
  A('golden', 'nation', 'brings a golden age to', ['AGE', 'SUN', 'CROWN', 'LAUREL'], ['GOLDEN', 'GLORIOUS', 'SHINING'],
    { peace: 0.8, trade: 0.6, curiosity: 0.3 }, [{ op: 'greed', when: 'with' }, { op: 'unrest', when: 'after' }, { op: 'insularity', when: 'after' }], 12, 'revelation', { omen: 'golden' }),
  A('revolt', 'nation', 'raises the people of {t} against their rulers', ['REVOLT', 'TORCH', 'BARRICADE', 'UPRISING'], ['BURNING', 'RAGGED', 'RISING'],
    { unrest: 1.2, hunger: 0.4 }, [{ op: 'unrest', when: 'with' }, { op: 'fervor', when: 'after' }], 8, 'smite', { omen: 'revolt', targets: ['restless', 'strongest', 'hungriest', 'advanced'] }),
  A('cure', 'nation', 'teaches the healers of', ['CURE', 'BALM', 'HEALER', 'REMEDY'], ['HEALING', 'MERCIFUL', 'GENTLE'],
    { crowding: 0.9, war: 0.3 }, [{ op: 'fertility', when: 'after' }, { op: 'greed', when: 'with' }], 7, 'harvest', { omen: 'cure' }),
  A('seafaring', 'nation', 'sends the ships of {t} to far shores', ['SAIL', 'TIDE', 'HARBOUR', 'COMPASS'], ['FAR', 'SALT', 'DISTANT'],
    { crowding: 0.5, scarcity: 0.5, curiosity: 0.5 }, [{ op: 'pestilence', when: 'after' }, { op: 'discord', when: 'with' }], 8, 'meteor', { omen: 'seafaring' }),
  // ── The world: works on the land ──
  A('rains', 'world', 'brings long rains over', ['RAIN', 'MONSOON', 'CLOUD', 'DELUGE'], ['LONG', 'SOFT', 'GREEN'],
    { hunger: 1.0, dry: 1.0, young: 0.4 }, [{ op: 'pestilence', when: 'after' }, { op: 'fertility', when: 'with' }], 9, 'harvest', { work: 'rains', targets: LAND_T, needs: 'grid' }),
  A('drought', 'world', 'parches', ['DROUGHT', 'DUST', 'THIRST', 'SUN'], ['WHITE', 'DRY', 'CRACKED'],
    { dominance: 0.9, war: 0.3 }, [{ op: 'exodus', when: 'with' }, { op: 'unrest', when: 'with' }], 7, 'meteor', { work: 'drought', targets: LAND_T, bane: true, needs: 'grid' }),
  A('quake', 'world', 'heaves the earth along the borders of', ['QUAKE', 'RIDGE', 'FAULT', 'TREMOR'], ['SHAKING', 'BROKEN', 'RISING'],
    { war: 0.9, dominance: 0.4, young: 0.3 }, [{ op: 'zeal', when: 'with' }, { op: 'unrest', when: 'with' }], 10, 'terraform', { work: 'quake', targets: LAND_T, bane: true, needs: 'grid' }),
  A('volcano', 'world', 'raises a mountain of fire in', ['FIRE', 'CALDERA', 'ASH', 'FORGE'], ['MOLTEN', 'SMOKING', 'RED'],
    { dominance: 0.7, young: 0.6 }, [{ op: 'zeal', when: 'with' }, { op: 'exodus', when: 'with' }], 11, 'meteor', { work: 'volcano', strike: true, targets: STRIKE_T, bane: true, needs: 'grid' }),
  A('ice_age', 'world', 'lets the ice creep over', ['ICE', 'WINTER', 'GLACIER', 'FROST'], ['LONG', 'WHITE', 'BITTER'],
    { pollution: 0.6, dominance: 0.4, young: 0.3 }, [{ op: 'exodus', when: 'with' }, { op: 'fervor', when: 'with' }], 16, 'terraform', { work: 'ice_age', targets: ['all'], bane: true, needs: 'grid' }),
  A('comet', 'world', 'sends a fire from the sky upon', ['COMET', 'STAR', 'HAMMER', 'WRATH'], ['FALLING', 'BURNING', 'WANDERING'],
    { dominance: 1.0, young: 0.5 }, [{ op: 'zeal', when: 'with' }, { op: 'unrest', when: 'with' }, { op: 'insularity', when: 'after' }], 14, 'smite', { work: 'comet', strike: true, targets: STRIKE_T, bane: true, needs: 'grid' }),
  // ── Life ──
  A('hardy', 'life', 'lets life take root in the harsh lands of', ['ROOT', 'LICHEN', 'THORN', 'HIDE'], ['HARDY', 'STUBBORN', 'THICK'],
    { cold: 1.2, dry: 1.0, crowding: 0.4 }, [{ op: 'insularity', when: 'with' }], 8, 'evolution', { work: 'hardy', targets: ['coldest', 'driest', 'crowded', 'all'], needs: 'life' }),
  A('herds', 'life', 'drives great herds over', ['HERD', 'FLOCK', 'STAMPEDE', 'HORN'], ['TEEMING', 'THUNDERING', 'WILD'],
    { hunger: 0.8, wild: 0.6, young: 0.5 }, [{ op: 'fertility', when: 'with' }, { op: 'greed', when: 'with' }], 7, 'harvest', { work: 'herds', echo: { op: 'harvest', m: 0.35 }, targets: LAND_T, needs: 'life' }),
  A('murrain', 'life', 'sends a murrain among the herds of', ['MURRAIN', 'CARRION', 'BONES', 'RINDERPEST'], ['SILENT', 'ROTTING', 'PALE'],
    { dominance: 0.8, wild: 0.3 }, [{ op: 'unrest', when: 'with' }, { op: 'exodus', when: 'after' }], 6, 'smite', { work: 'murrain', echo: { op: 'blight', m: 0.35 }, targets: LAND_T, bane: true, needs: 'life' }),
  A('awaken', 'life', 'quickens the minds of', ['MIND', 'EYE', 'WAKING', 'THOUGHT'], ['WAKING', 'RESTLESS', 'CLEVER'],
    { young: 1.2, curiosity: 0.5, era: 0.2 }, [{ op: 'schism', when: 'after' }, { op: 'unrest', when: 'after' }], 12, 'evolution', { work: 'awaken', echo: { op: 'inspire', m: 0.4 }, targets: ['kin'], needs: 'life' }),
  A('mutate', 'life', 'stirs the blood of', ['HELIX', 'BLOOD', 'CHANGE', 'SPIRAL'], ['STRANGE', 'TWISTED', 'NEW'],
    { young: 1.5 }, [], 8, 'evolution', { cosmic: 'mutate', targets: ['kin'], needs: 'life' }),
  // ── The cosmos ──
  A('sight', 'cosmos', 'opens your sight into', ['SIGHT', 'EYE', 'LANTERN', 'BEACON'], ['FAR', 'ALL-SEEING', 'OPEN'],
    { young: 0.6, lifeless: 0.2 }, [], 14, 'sight', { cosmic: 'sight', targets: ['beyond'] }),
  A('meteor', 'cosmos', 'hurls a life-bearing stone at', ['SEED', 'STONE', 'SPORE', 'EMBER'], ['SEEDING', 'WANDERING', 'GREEN'],
    { lifeless: 1.5, young: 0.3 }, [{ op: 'zeal', when: 'with' }], 15, 'meteor', { cosmic: 'meteor', targets: ['lifeless'], needs: 'lifeless' }),
  A('seed', 'cosmos', 'pours life into', ['GARDEN', 'BLOOM', 'BREATH', 'SPRING'], ['FIRST', 'GREEN', 'TEEMING'],
    { young: 1.2, wild: 0.4 }, [{ op: 'pestilence', when: 'after' }], 6, 'harvest', { cosmic: 'seed', targets: ['home'] }),
  A('terraform', 'cosmos', 'remakes', ['REMAKING', 'GENESIS', 'CRUCIBLE', 'SHAPING'], ['NEW', 'SECOND', 'GREAT'],
    { pollution: 0.5, young: 0.3, cold: 0.3, dry: 0.3 }, [{ op: 'exodus', when: 'with' }, { op: 'unrest', when: 'with' }], 40, 'terraform', { cosmic: 'terraform', targets: ['home'], needs: 'terraform' }),
];
export const ACTION_BY_ID = Object.fromEntries(ACTIONS.map(a => [a.id, a])) as Record<ActionId, ActionDef>;

/** Plain names for side effects. */
export const OP_LABEL: Record<OmenOp, string> = {
  harvest: 'plenty', blight: 'blight', dependency: 'dependency', fertility: 'more mouths', pestilence: 'fever',
  inspire: 'invention', stagnation: 'learning withers', veins: 'new ore', greed: 'inequality', cleanse: 'cleansing',
  smoke: 'smoke and soot', concord: 'goodwill', discord: 'resentment', insularity: 'closed borders', zeal: 'zealotry',
  calm: 'calm', fervor: 'militarism', exodus: 'emigration', unrest: 'unrest', theft: 'theft', foe: 'a common foe',
  schism: 'schism', golden: 'a golden age', revolt: 'revolt', cure: 'healing', seafaring: 'seafaring',
};

// ─── Targets, conditions ──────────────────────────────────────────────────────

export type TargetId = 'hungriest' | 'crowded' | 'poorest' | 'restless' | 'strongest' | 'weakest' | 'pious'
  | 'advanced' | 'backward' | 'all' | 'rivals' | 'warring'
  | 'wilds' | 'driest' | 'wettest' | 'coldest' | 'kin' | 'beyond' | 'lifeless' | 'home';

interface TargetDef {
  id: TargetId; text: string; drawn: Partial<Record<Signal, number>>; cost: number; noun: string;
  /** Names nations (needs them to exist), and is plural. */
  nations?: boolean; plural?: boolean;
}
const TARGETS: TargetDef[] = [
  { id: 'hungriest', text: 'the hungriest nation', drawn: { hunger: 1.2 }, cost: 1, noun: 'THE HUNGRY', nations: true },
  { id: 'crowded', text: 'the most crowded nation', drawn: { crowding: 1.2 }, cost: 1, noun: 'THE THRONG', nations: true },
  { id: 'poorest', text: 'the nation poorest in stone and timber', drawn: { scarcity: 1.2 }, cost: 1, noun: 'THE WANTING', nations: true },
  { id: 'restless', text: 'the most restless nation', drawn: { unrest: 1.2 }, cost: 1, noun: 'THE RESTLESS', nations: true },
  { id: 'strongest', text: 'the mightiest nation', drawn: { dominance: 1.2, war: 0.3 }, cost: 1.1, noun: 'THE MIGHTY', nations: true },
  { id: 'weakest', text: 'the weakest nation', drawn: { dominance: 0.8, war: 0.4 }, cost: 0.9, noun: 'THE MEEK', nations: true },
  { id: 'pious', text: 'the most devout nation', drawn: { piety: 0.9 }, cost: 0.9, noun: 'THE FAITHFUL', nations: true },
  { id: 'advanced', text: 'the most advanced nation', drawn: { era: 0.6, curiosity: 0.3 }, cost: 1.1, noun: 'THE LEARNED', nations: true },
  { id: 'backward', text: 'the most backward nation', drawn: { era: 0.4 }, cost: 0.9, noun: 'THE LAGGARD', nations: true },
  { id: 'all', text: 'every nation', drawn: { peace: 0.3, pollution: 0.4 }, cost: 1.9, noun: 'THE WORLD', nations: true, plural: true },
  { id: 'rivals', text: 'the two bitterest rivals', drawn: { war: 0.7, peace: 0.3 }, cost: 1.4, noun: 'THE RIVALS', nations: true, plural: true },
  { id: 'warring', text: 'every nation at war', drawn: { war: 1.2 }, cost: 1.5, noun: 'THE BATTLEFIELD', nations: true, plural: true },
  { id: 'wilds', text: 'the untamed wilds', drawn: { wild: 1, young: 0.8 }, cost: 0.9, noun: 'THE WILDS' },
  { id: 'driest', text: 'the driest land', drawn: { dry: 1, young: 0.3 }, cost: 0.9, noun: 'THE WASTES' },
  { id: 'wettest', text: 'the wettest land', drawn: { young: 0.3 }, cost: 0.9, noun: 'THE MARSHES' },
  { id: 'coldest', text: 'the coldest land', drawn: { cold: 1, young: 0.3 }, cost: 0.9, noun: 'THE NORTH' },
  { id: 'kin', text: 'the cleverest kind of life on your world', drawn: {}, cost: 1, noun: 'THE KIN' },
  { id: 'beyond', text: 'the dark beyond your star', drawn: {}, cost: 1, noun: 'THE DARK' },
  { id: 'lifeless', text: 'the nearest lifeless world', drawn: {}, cost: 1, noun: 'THE BARREN' },
  { id: 'home', text: 'your world', drawn: {}, cost: 1, noun: 'THE WORLD' },
];
const TARGET_BY_ID = Object.fromEntries(TARGETS.map(t => [t.id, t])) as Record<TargetId, TargetDef>;
const targetsOf = (a: ActionDef): TargetId[] => a.targets ?? NATION_T;

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
const PROVERBS: Partial<Record<string, string[]>> = {
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
  'revolt:hunger': ['BREAD OR BLOOD'],
  'golden:peace': ['THE LONG SUMMER'],
  'cure:crowding': ['THE PHYSICIAN\'S HOUR'],
  'theft:always': ['FIRE FROM THE NEIGHBOUR'],
  'foe:always': ['ALL AGAINST ONE'],
  'meteor:always': ['THE SOWER\'S STONE'],
  'ice_age:always': ['THE LONG WINTER'],
  'awaken:always': ['THE FIRST QUESTION'],
};

export const MAGNITUDES = ['WHISPER', 'SIGN', 'MIRACLE'] as const;
const MAG_STRENGTH = [0.5, 1, 1.7];
const MAG_COST = [0.6, 1, 1.8];
const MAG_ODDS = [0.92, 0.82, 0.68];
/** Era-time each duration lasts, and what it costs. */
export const DURATION_ERAS = [0.25, 0.5, 1];
export const DURATIONS = ['a season', 'a generation', 'an age'] as const;
/** For works on the land, "duration" is reach. */
export const REACHES = ['a valley', 'a province', 'a realm'] as const;
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
  /** 1..3: how long an omen lasts (season .. age), or how far a work reaches (valley .. realm). */
  duration: number;
  sides: SideEffect[];
  /** Base DP (before the heavens tire of it: see priceNow). */
  cost: number;
  /** 0..1: the chance a people heeds it (works on land and heavens always happen). */
  odds: number;
  origin: string;
  /** Times burned through the crucible to make it (0: discovered). */
  forged: number;
}

export const scopeOf = (c: Pick<FaithCard, 'actions'>): Scope => ACTION_BY_ID[c.actions[0]].scope;
/** Lays omens that last (a nation card, or an echo): has a duration rather than a reach. */
const lasting = (c: Pick<FaithCard, 'actions'>) => c.actions.every(a => ACTION_BY_ID[a].scope === 'nation');
const fixedTarget = (a: ActionDef) => targetsOf(a).length === 1;

/** DP to cast a card: action, reach, strength, length; a condition makes it cheaper, side effects too. */
export function priceOf(c: Pick<FaithCard, 'actions' | 'target' | 'condition' | 'magnitude' | 'duration' | 'sides'>): number {
  const base = c.actions.reduce((a, id, i) => a + ACTION_BY_ID[id].base * (i ? 0.7 : 1), 0);
  const cond = c.condition === 'always' ? 1 : 0.7;
  const sides = c.sides.reduce((a, s) => a + (s.when === 'after' ? 0.8 : 1.2) * s.mag, 0);
  const cosmic = c.actions.every(a => ACTION_BY_ID[a].scope === 'cosmos');
  const dur = cosmic ? 1 : DUR_COST[c.duration - 1];
  return Math.max(2, Math.round(base * MAG_COST[c.magnitude - 1] * dur * TARGET_BY_ID[c.target].cost * cond - sides));
}

/** Chance a people heeds the card: miracles are harder to accept; two actions are harder still. Works always happen. */
export function oddsOf(c: Pick<FaithCard, 'magnitude' | 'actions'>): number {
  if (!c.actions.some(a => ACTION_BY_ID[a].scope === 'nation')) return 1;
  return MAG_ODDS[c.magnitude - 1] - (c.actions.length - 1) * 0.08;
}

/** "Fills the granaries of the hungriest nation while it goes hungry, for a generation." */
export function describe(c: FaithCard): string {
  const td = TARGET_BY_ID[c.target], plural = !!td.plural, t = td.text;
  let cond = COND_BY_ID[c.condition].text;
  if (plural) cond = cond.replace('it goes', 'they go').replace('it lacks', 'they lack').replace('it is', 'they are')
    .replace(/\bits\b/g, 'their').replace(/\bpeople are\b/, 'peoples are');
  const say = (verb: string, who: string) => {
    if (!verb.includes('{t}')) return `${verb} ${who}`;
    // The rivals' discord (or concord) is with each other.
    if (c.target === 'rivals' && who === t) return verb.replace('{t} and its neighbours', 'the two bitterest rivals').replace('{t}', who);
    return verb.replace('{t}', who).replace('its neighbours', plural ? 'their neighbours' : 'its neighbours');
  };
  const [a1, a2] = c.actions.map(a => ACTION_BY_ID[a]);
  const second = a2 ? ` and ${say(a2.verb, fixedTarget(a2) && a2.targets![0] !== c.target ? TARGET_BY_ID[a2.targets![0]].text : plural ? 'them' : 'it')}` : '';
  // Omens last; works on open land reach (the whole of a nation's land, or the planet, needs no reach).
  const reaches = !td.nations && c.target !== 'kin' && c.target !== 'all' && c.actions.some(x => ACTION_BY_ID[x].work);
  const tail = lasting(c) ? `, for ${DURATIONS[c.duration - 1]}` : reaches ? `, across ${REACHES[c.duration - 1]}` : '';
  const s = `${say(a1.verb, t)}${second}${cond ? ` ${cond}` : ''}${tail}.`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The short reach/length shown on the card face. */
export function spanOf(c: FaithCard): string {
  const sc = c.actions.map(a => ACTION_BY_ID[a].scope);
  if (sc.every(s => s === 'cosmos')) return 'the heavens';
  if (lasting(c)) return DURATIONS[c.duration - 1].replace(/^an? /, '');
  if (TARGET_BY_ID[c.target].nations || c.target === 'kin') return MAGNITUDES[c.magnitude - 1].toLowerCase();
  return REACHES[c.duration - 1].replace(/^an? /, '');
}

/** The parts of a card, as rows for a tooltip. */
export function anatomy(c: FaithCard): Array<[string, string]> {
  const scopes = [...new Set(c.actions.map(a => ACTION_BY_ID[a].scope))];
  const SCOPE: Record<Scope, string> = { nation: 'nations', world: 'the land', life: 'living things', cosmos: 'the heavens' };
  return [
    ['Action', c.actions.map(a => ACTION_BY_ID[a].nouns[0].toLowerCase()).join(' + ')],
    ['Works on', scopes.map(s => SCOPE[s]).join(' and ')],
    ['Target', TARGET_BY_ID[c.target].text],
    ['Condition', COND_BY_ID[c.condition].text || 'none'],
    ['Magnitude', MAGNITUDES[c.magnitude - 1].toLowerCase()],
    lasting(c) ? ['Duration', DURATIONS[c.duration - 1]]
      : scopes.every(x => x === 'cosmos') || c.target === 'kin' ? ['Reach', 'all of it']
      : TARGET_BY_ID[c.target].nations || c.target === 'all' ? ['Reach', c.actions.some(x => ACTION_BY_ID[x].strike) ? `around the capital, ${REACHES[c.duration - 1].replace(/^an? /, '')}-wide` : TARGET_BY_ID[c.target].plural ? 'their whole lands' : 'its whole land']
      : ['Reach', REACHES[c.duration - 1]],
    ['Odds', c.odds >= 1 ? 'certain' : `${Math.round(c.odds * 100)}% a people heeds it`],
    ['Side effects', c.sides.length ? c.sides.map(s => `${OP_LABEL[s.op]}${s.when === 'after' ? ' (afterward)' : ''}`).join(', ') : 'none foreseen'],
  ];
}

export const isBane = (c: FaithCard): boolean => !!ACTION_BY_ID[c.actions[0]].bane;
/** Pixel icon under /assets/pixel/divine/: each kind has its own (cards/<id>.png, tools/gen_card_icons.py). */
export const iconOf = (c: FaithCard): string => `cards/${c.actions[0]}`;

// ─── The heavens tire ─────────────────────────────────────────────────────────

/** Recent uses per kind of card, with the tick each was last counted. */
export type Wear = Record<string, { n: number; tick: number }>;
/** Ticks for a use to fade to ~37% (about three quarters of an era). */
export const WEAR_LIFE = 30000;
/** Each recent use of a kind adds this much to its price, and takes this much off the odds. */
export const WEAR_PRICE = 0.25, WEAR_ODDS = 0.05;

const decayed = (u: { n: number; tick: number } | undefined, tick: number) => u ? u.n * Math.exp(-Math.max(0, tick - u.tick) / WEAR_LIFE) : 0;

/** How worn a card's kinds are now (recent uses, fading). */
export function wearOf(w: Wear, actions: readonly ActionId[], tick: number): number {
  return actions.reduce((a, id, i) => a + decayed(w[id], tick) * (i ? 0.6 : 1), 0);
}

/** DP a card costs now: its base, marked up by how often its kind was cast lately. */
export function priceNow(c: FaithCard, w: Wear, tick: number): number {
  return Math.round(c.cost * (1 + WEAR_PRICE * wearOf(w, c.actions, tick)));
}

/** Count a cast against each of the card's kinds. */
export function noteUse(w: Wear, actions: readonly ActionId[], tick: number): void {
  for (const id of actions) w[id] = { n: decayed(w[id], tick) + 1, tick };
}

// ─── Reading the world ────────────────────────────────────────────────────────

export function signalsOf(ns: NationSystem | null, grid: PlanetGrid | null = null, ctx: Partial<WorldContext> = {}): WorldSignals {
  const s: WorldSignals = { hunger: 0, crowding: 0, scarcity: 0, unrest: 0, pollution: 0, war: 0, peace: 0, trade: 0, piety: 0, curiosity: 0, dominance: 0, era: 0, young: 0, wild: 0, cold: 0, dry: 0, lifeless: ctx.lifeless ? 1 : 0 };
  if (grid) {
    let land = 0, hab = 0, wild = 0, cold = 0, dry = 0;
    for (let r = 0; r < GRID_SIZE; r += 2) for (let c = 0; c < GRID_SIZE; c += 2) {
      const cell = grid[r][c];
      if (isWater(cell.biome)) continue;
      land++;
      if (cell.biome === 'tundra' || cell.biome === 'snow') cold++;
      if (cell.biome === 'desert') dry++;
      if (isHabitable(cell.biome)) { hab++; if (cell.civId == null) wild++; }
    }
    s.wild = hab ? wild / hab : 0; s.cold = land ? Math.min(1, cold / land * 2) : 0; s.dry = land ? Math.min(1, dry / land * 2) : 0;
  }
  const live = ns?.isFounded ? ns.nations.filter(n => !n.fallen) : [];
  if (!live.length) { s.young = 1; return s; }
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
  const rel = ns!.relations.filter(r => !ns!.nations[r.a].fallen && !ns!.nations[r.b].fallen);
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
    [sig.young * 0.5, 'the youth of the world'],
  ];
  moods.sort((a, b) => b[0] - a[0]);
  return moods[0][0] > 0.15 ? moods[0][1] : 'a quiet time';
}

/** Whether an action can turn up (and be cast) in this world. */
export function possible(a: ActionDef, ctx: Partial<WorldContext>): boolean {
  if (a.scope === 'nation' && !ctx.nations) return false;
  if (a.needs && !ctx[a.needs]) return false;
  if ((a.scope === 'world' || a.scope === 'life') && !ctx.grid) return false;
  return true;
}

/** Targets an action can take in this world (nation targets need nations). */
function targetsFor(a: ActionDef, ctx: Partial<WorldContext>): TargetDef[] {
  return targetsOf(a).map(t => TARGET_BY_ID[t]).filter(t => !t.nations || ctx.nations);
}

// ─── Making cards ─────────────────────────────────────────────────────────────

function nameOf(rng: SeedRNG, actions: ActionId[], target: TargetId, cond: OmenCondition, mag: number): string {
  const a = ACTION_BY_ID[actions[0]];
  const proverb = PROVERBS[`${actions[0]}:${cond}`];
  if (actions.length === 1 && proverb && rng.chance(0.6)) return rng.pick(proverb);
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
function sidesFor(rng: SeedRNG, action: ActionId, mag: number, ctx: Partial<WorldContext>): SideEffect[] {
  const a = ACTION_BY_ID[action], out: SideEffect[] = [];
  // Prices are paid by nations: a world without them has none to pay.
  if (!ctx.nations) return out;
  if (a.shadow.length && rng.chance(0.8)) {
    const s = rng.pick(a.shadow);
    out.push({ op: s.op, when: s.when, mag: Math.max(1, Math.min(3, mag + (rng.chance(0.3) ? 1 : 0) - (rng.chance(0.3) ? 1 : 0))) });
  }
  if (rng.chance(0.25)) {
    const wild = rng.pick(['greed', 'unrest', 'smoke', 'insularity', 'stagnation', 'dependency', 'fertility', 'zeal'] as OmenOp[]);
    if (!out.some(s => s.op === wild) && wild !== a.omen) out.push({ op: wild, when: wild === 'dependency' || rng.chance(0.4) ? 'after' : 'with', mag: rng.nextInt(1, 2) });
  }
  return out;
}

/**
 * Seek (§11): `count` cards drawn from what the world is going through. Each
 * action, target and condition is weighted by the signals that bring it up,
 * so a famine turns up harvests, rains and roads out, a war turns up truces
 * and war-drums, a young world turns up seeds, herds and minds quickened —
 * but anything the world allows can surface. `ctx` says what it allows.
 */
export function discover(sig: WorldSignals, rng: SeedRNG, count: number, idBase: string,
  ctx: Partial<WorldContext> = { nations: true, life: true, grid: true }): FaithCard[] {
  const out: FaithCard[] = [];
  const mood = moodOf(sig);
  for (let i = 0; i < count; i++) {
    const pool = ACTIONS.filter(a => possible(a, ctx) && targetsFor(a, ctx).length && !out.some(c => c.actions[0] === a.id));
    if (!pool.length) break;
    const a = pickWeighted(rng, pool, pool.map(x => weigh(x.drawn, sig, 0.15)));
    const ts = targetsFor(a, ctx).filter(t => !a.bane || !['hungriest', 'weakest', 'backward'].includes(t.id));
    const tpool = ts.length ? ts : targetsFor(a, ctx);
    const target = pickWeighted(rng, tpool, tpool.map(t => weigh(t.drawn, sig, 0.1))).id;
    const cond = a.scope !== 'nation' || rng.chance(0.55) ? 'always'
      : pickWeighted(rng, CONDITIONS.slice(1), CONDITIONS.slice(1).map(c => weigh(c.drawn, sig, 0.08))).id;
    const magnitude = pickWeighted(rng, [1, 2, 3], [0.4, 0.45, 0.15]);
    const duration = pickWeighted(rng, [1, 2, 3], [0.35, 0.45, 0.2]);
    out.push(build(rng, { actions: [a.id], target, condition: cond, magnitude, duration,
      sides: sidesFor(rng, a.id, magnitude, ctx), origin: `Glimpsed in ${mood}.`, forged: 0 }, `${idBase}-${i}`));
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
 * A fusion needs a target both purposes can take; otherwise the fire refines.
 */
export function forge(a: FaithCard, b: FaithCard, rng: SeedRNG, id: string, ctx: Partial<WorldContext> = { nations: true, life: true, grid: true }): { card: FaithCard; kind: ForgeKind } {
  const roll = rng.next();
  const [lead, other] = rng.chance(0.5) ? [a, b] : [b, a];
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
  const LA = ACTION_BY_ID[leadAct], OA = ACTION_BY_ID[otherAct];
  const shared = [a.target, b.target].find(t => targetsOf(LA).includes(t) && (targetsOf(OA).includes(t) || fixedTarget(OA)));
  const condFor = (acts: ActionId[], c: OmenCondition) => acts.some(x => ACTION_BY_ID[x].scope === 'nation') ? c : 'always';
  if (roll < 0.45 && otherAct !== leadAct && shared) {
    const actions = [leadAct, otherAct];
    const card = build(rng, { actions, target: shared, condition: condFor(actions, rng.chance(0.5) ? a.condition : b.condition),
      magnitude: Math.max(a.magnitude, b.magnitude), duration: Math.max(a.duration, b.duration),
      sides: merge([...a.sides, ...b.sides]), origin, forged }, id);
    return { card, kind: 'fusion' };
  }
  if (roll < 0.75 || !ACTIONS.some(x => possible(x, ctx) && !a.actions.includes(x.id) && !b.actions.includes(x.id))) {
    const card = build(rng, { actions: [leadAct], target: lead.target, condition: lead.condition,
      magnitude: clampMag(lead.magnitude + 1), duration: clampMag(Math.max(lead.duration, other.duration)),
      sides: lead.sides.slice(0, 1), origin, forged }, id);
    return { card, kind: 'refinement' };
  }
  // Wild: a purpose neither card held, sometimes bound to one that was kept, with a new shadow.
  const strangers = ACTIONS.filter(x => possible(x, ctx) && targetsFor(x, ctx).length && !a.actions.includes(x.id) && !b.actions.includes(x.id));
  const stranger = rng.pick(strangers);
  const keep = targetsFor(stranger, ctx).find(t => targetsOf(LA).includes(t.id));
  const actions: ActionId[] = keep && rng.chance(0.6) ? [leadAct, stranger.id] : [stranger.id];
  const target = actions.length === 2 ? keep!.id : rng.pick(targetsFor(stranger, ctx)).id;
  const card = build(rng, { actions, target, condition: condFor(actions, rng.chance(0.5) ? lead.condition : 'always'),
    magnitude: rng.nextInt(1, 3), duration: rng.nextInt(1, 3),
    sides: merge([...sidesFor(rng, stranger.id, 2, ctx), ...(rng.chance(0.5) ? lead.sides : [])]), origin, forged }, id);
  return { card, kind: 'wild' };
}

// ─── Casting ──────────────────────────────────────────────────────────────────

/** Which nations a nation target means, read from the world as it is now. */
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
    default: return [];
  }
}

/** What the engine does for the heavens (implemented by the game; a no-op host in tests). */
export interface DivineHost {
  grid: PlanetGrid | null;
  planetType: string;
  species: SpeciesGenome[];
  /** Whether a cosmic work can happen now (a lifeless world in reach, terraforming possible…). */
  canCosmic(w: CosmicWork): boolean;
  /** Do it (magnitude 1..3); returns a line for the feed, or null if it could not. */
  cosmic(w: CosmicWork, rng: SeedRNG, magnitude: number): string | null;
  /** The surface changed: redraw it. */
  surfaceChanged(): void;
}

/** Whether a card can be cast in this world right now (and why not). */
export function castable(card: FaithCard, ns: NationSystem | null, host: DivineHost | null): string | null {
  for (const id of card.actions) {
    const a = ACTION_BY_ID[id];
    if (a.scope === 'nation' && !ns?.isFounded) return 'There are no nations yet for this sign to fall upon.';
    if ((a.scope === 'world' || a.scope === 'life') && !host?.grid) return 'Open your world first.';
    if (a.cosmic && !host?.canCosmic(a.cosmic)) return a.cosmic === 'meteor' ? 'No lifeless world within reach. Look further first.'
      : a.cosmic === 'terraform' ? 'Your world cannot be remade now.' : 'The heavens do not answer now.';
  }
  if (TARGET_BY_ID[card.target].nations && !ns?.isFounded) return 'There are no nations yet for this sign to fall upon.';
  return null;
}

/** What happened when a card was cast. */
export interface CastResult {
  heeded: Nation[];
  ignored: Nation[];
  /** One line for the feed, phrased as what was seen. */
  line: string;
  /** A place to show it (a capital, or the centre of a work). */
  where: { row: number; col: number } | null;
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s)\S/g, x => x.toUpperCase()).replace(/^The /, '');

/**
 * Cast (§10, §13). Nation actions: each nation named may heed the sign or not
 * (odds, raised by devotion, lowered as the heavens tire); where heeded, the
 * actions become omens for the card's duration, side effects ride along or
 * follow after, and the history records the card as the cause. Works on land
 * and life always happen; the nations whose land they touch remember them,
 * pay their side effects, and lose people to the violent ones. Cosmic works
 * go through the host.
 */
export function cast(ns: NationSystem | null, card: FaithCard, rng: SeedRNG, tick: number, host: DivineHost | null = null, wear = 0): CastResult {
  const label = titleCase(card.name);
  const now = ns?.now ?? 0, len = DURATION_ERAS[card.duration - 1], m = MAG_STRENGTH[card.magnitude - 1];
  const td = TARGET_BY_ID[card.target];
  const named = td.nations && ns?.isFounded ? resolveTarget(ns, card.target) : [];
  const heeded: Nation[] = [], ignored: Nation[] = [];
  const lines: string[] = [];
  let where: CastResult['where'] = named[0]?.capital ?? null;
  const touched = new Set<number>();
  const sideOn = (k: number) => {
    for (const s of card.sides) {
      const sm = MAG_STRENGTH[s.mag - 1] * 0.8;
      if (s.when === 'with') ns!.bless(k, { card: label, op: s.op, m: sm, cond: 'always', from: now, until: now + len, aftermath: false, primary: false });
      else ns!.bless(k, { card: label, op: s.op, m: sm, cond: 'always', from: now + len, until: now + len * 1.75, aftermath: true, primary: false });
    }
  };

  // Nation omens: each named nation may heed them.
  const omens = card.actions.map(id => ACTION_BY_ID[id]).filter(a => a.omen);
  if (omens.length && ns) {
    for (const n of named) {
      const odds = card.odds <= 0 ? 0 : Math.max(0.1, Math.min(0.98, card.odds + 0.3 * (n.values.piety - 0.5) - Math.min(0.3, WEAR_ODDS * wear)));
      if (!rng.chance(odds)) {
        ignored.push(n);
        ns.record(n.id, tick, `A sign appeared over ${n.name}, and few looked up.`,
          [`the ${label}`, wear >= 1.5 ? 'the people had grown used to miracles' : n.values.piety < 0.4 ? 'a worldly people' : 'chance']);
        continue;
      }
      heeded.push(n);
      omens.forEach((a, i) => ns.bless(n.id, { card: label, op: a.omen!, m: m * (i ? 0.7 : 1), cond: card.condition, from: now, until: now + len, aftermath: false, primary: true }));
      touched.add(n.id);
    }
  }

  // Works on land and life: they happen.
  for (const a of card.actions.map(id => ACTION_BY_ID[id])) {
    if (!a.work || !host?.grid) continue;
    const region: Region = td.nations ? { kind: 'nations', ids: named.map(n => n.id) }
      : card.target === 'kin' || card.target === 'all' ? { kind: 'planet' }
      : { kind: card.target as 'wilds' | 'driest' | 'wettest' | 'coldest' };
    const rep = work(a.work, host.grid, ns, region, m, card.duration, host.planetType, host.species);
    host.surfaceChanged();
    if (ns?.isFounded) {
      for (const [k, cells] of rep.nations) {
        const n = ns.nations[k];
        if (!n || n.fallen) continue;
        touched.add(k);
        ns.record(k, tick, workLine(a.work, n.name), [`the ${label}`]);
        const toll = WORK_TOLL[a.work];
        // A strike on a capital kills beyond the land it covers (that is where the people are).
        const share = Math.min(1, cells / Math.max(1, n.state.land));
        if (toll) ns.harm(k, toll * m * (a.strike ? 0.1 + share : share));
        if (a.echo) ns.bless(k, { card: label, op: a.echo.op, m: a.echo.m * m, cond: 'always', from: now, until: now + len, aftermath: false, primary: false });
      }
      if (a.work === 'awaken' || a.work === 'hardy') for (const n of ns.nations) if (!n.fallen && !touched.has(n.id)) {
        touched.add(n.id);
        ns.record(n.id, tick, workLine(a.work, n.name), [`the ${label}`]);
        if (a.echo) ns.bless(n.id, { card: label, op: a.echo.op, m: a.echo.m * m, cond: 'always', from: now, until: now + len, aftermath: false, primary: false });
      }
      if (!where) { const k = [...rep.nations.keys()][0]; if (k != null) where = ns.nations[k].capital; }
    }
    lines.push(rep.touched ? '' : 'the land did not answer');
  }

  // The heavens: through the host.
  for (const a of card.actions.map(id => ACTION_BY_ID[id])) {
    if (!a.cosmic) continue;
    const said = host?.cosmic(a.cosmic, rng, card.magnitude);
    if (said) lines.push(said);
  }

  // Prices fall on every nation the card touched.
  if (ns?.isFounded) for (const k of touched) sideOn(k);

  const names = (xs: Nation[]) => xs.map(n => n.name).join(xs.length === 2 ? ' and ' : ', ');
  const said = lines.filter(Boolean).join(' ');
  let line: string;
  if (omens.length) {
    line = !named.length ? `${card.name}: the sign found no one to fall upon.`
      : !heeded.length ? `${card.name}: a sign blazed over ${names(ignored)}, and few looked up.`
      : `${card.name} falls upon ${names(heeded)}.${ignored.length ? ` ${names(ignored)} paid it no heed.` : ''}`;
    if (said) line += ` ${said}`;
  } else {
    const where2 = td.nations && named.length ? names(named) : td.text;
    line = `${card.name}: ${said || `it is done upon ${where2}.`}`;
  }
  return { heeded, ignored, line, where };
}
