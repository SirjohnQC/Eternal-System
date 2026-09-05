import { SeedRNG } from '../utils/SeedRNG';

export type LeaderRole = 'king' | 'scientist' | 'general' | 'prophet' | 'diplomat';
export type CommunicationStyle = 'formal_ruler' | 'religious_zealot' | 'military_commander' | 'nervous_diplomat' | 'scientific_thinker';
export type AttitudeTowardGod = 'loyal_worshipper' | 'fearful_servant' | 'skeptical_ruler' | 'manipulative_believer' | 'open_atheist';
export type PersonalityTrait = 'fanatic' | 'charismatic' | 'paranoid' | 'rational' | 'manipulative' | 'humble' | 'arrogant' | 'pacifist' | 'militaristic';
export type IdeologyLabel = 'Theocracy' | 'Republic' | 'Empire' | 'Confederation' | 'Technocracy' | 'Warband';

export interface Leader {
  id: string;
  starId: number;
  name: string;
  species: string;
  faction: string;
  role: LeaderRole;
  ideology: IdeologyLabel;
  intelligenceLevel: number;   // 1–10
  ambitionLevel: number;       // 1–10
  faithLevel: number;          // 1–10
  fearLevel: number;           // 1–10, dynamic
  personalityTraits: PersonalityTrait[];  // 2–3 traits
  communicationStyle: CommunicationStyle;
  attitudeTowardGod: AttitudeTowardGod;
  spawnedAtCivLevel: number;
}

export interface LeaderMemory {
  leaderId: string;
  entries: string[];  // max 10 short sentences
}

// ─── Name pools ──────────────────────────────────────────────────────────────

const FIRST_NAMES: string[] = [
  'Arador', 'Vael', 'Keth', 'Sorin', 'Mira', 'Thane', 'Elyn',
  'Zorah', 'Coris', 'Aldun', 'Yeva', 'Drenn', 'Sable', 'Fenix',
  'Osren', 'Lira', 'Gorath', 'Nessa', 'Tyran', 'Cael', 'Vorin',
  'Sera', 'Havel', 'Dax',
];

const NAME_SUFFIXES: string[] = [
  'the Bold', 'the Wise', 'the Just', 'the Conqueror', 'the Fallen',
  'the Eternal', 'the Blind', 'the Unyielding', 'the Forgotten', 'the First',
];

// ─── Ideology pools by civ level ─────────────────────────────────────────────

const IDEOLOGY_BY_LEVEL: Record<number, IdeologyLabel[]> = {
  1: ['Warband', 'Theocracy', 'Empire'],
  2: ['Warband', 'Theocracy', 'Empire', 'Confederation'],
  3: ['Republic', 'Confederation', 'Empire', 'Theocracy'],
  4: ['Republic', 'Confederation', 'Technocracy', 'Empire'],
  5: ['Technocracy', 'Republic', 'Confederation'],
};

// ─── Role → CommunicationStyle mapping ───────────────────────────────────────

const ROLE_TO_COMM_STYLE: Record<LeaderRole, CommunicationStyle> = {
  king:      'formal_ruler',
  scientist: 'scientific_thinker',
  general:   'military_commander',
  prophet:   'religious_zealot',
  diplomat:  'nervous_diplomat',
};

// ─── Attitude scale (ordered low → high) ─────────────────────────────────────

const ATTITUDE_SCALE: AttitudeTowardGod[] = [
  'open_atheist',
  'skeptical_ruler',
  'manipulative_believer',
  'fearful_servant',
  'loyal_worshipper',
];

// ─── Generator ───────────────────────────────────────────────────────────────

/**
 * Generates a Leader for a civilisation at a given star.
 *
 * @param starId           Numeric star id
 * @param civName          Faction / civilisation name
 * @param speciesName      Species name
 * @param civLevel         1–5 tech/civ level
 * @param hostility        Raw hostility value (>10 = high)
 * @param religionDevotion 0–1 devotion score
 * @param rng              Seeded RNG — fork before passing so generation stays independent
 */
export function generateLeader(
  starId: number,
  civName: string,
  speciesName: string,
  civLevel: number,
  hostility: number,
  religionDevotion: number,
  rng: SeedRNG,
): Leader {
  // Clamp civLevel to keys we have
  const clampedLevel = Math.max(1, Math.min(5, Math.floor(civLevel))) as 1 | 2 | 3 | 4 | 5;

  const highFaith    = religionDevotion > 0.4;
  const highHostility = hostility > 10;

  // ── Name ──────────────────────────────────────────────────────────────────
  const firstName = rng.pick(FIRST_NAMES);
  const useSuffix = rng.chance(0.5);
  const name = useSuffix ? `${firstName} ${rng.pick(NAME_SUFFIXES)}` : firstName;

  // ── Role ──────────────────────────────────────────────────────────────────
  // Build a weighted pool
  const rolePool: LeaderRole[] = [];
  if (highFaith) {
    rolePool.push('prophet', 'prophet', 'king', 'diplomat', 'general', 'scientist');
  } else if (highHostility) {
    rolePool.push('general', 'general', 'king', 'prophet', 'diplomat', 'scientist');
  } else {
    rolePool.push('king', 'diplomat', 'scientist', 'general', 'prophet');
  }
  const role: LeaderRole = rng.pick(rolePool);

  // ── Ideology ──────────────────────────────────────────────────────────────
  let ideologyPool: IdeologyLabel[] = IDEOLOGY_BY_LEVEL[clampedLevel] ?? ['Republic'];
  if (highHostility && clampedLevel <= 2) {
    ideologyPool = ['Empire'];
  }
  const ideology: IdeologyLabel = rng.pick(ideologyPool);

  // ── Personality traits (2–3, no repeats) ─────────────────────────────────
  const ALL_TRAITS: PersonalityTrait[] = [
    'fanatic', 'charismatic', 'paranoid', 'rational', 'manipulative',
    'humble', 'arrogant', 'pacifist', 'militaristic',
  ];
  const traitCount = rng.chance(0.4) ? 3 : 2;
  const traitPool = [...ALL_TRAITS];
  const personalityTraits: PersonalityTrait[] = [];
  for (let i = 0; i < traitCount; i++) {
    const idx = rng.nextInt(0, traitPool.length - 1);
    personalityTraits.push(traitPool[idx]);
    traitPool.splice(idx, 1);
  }

  // ── Numeric stats ─────────────────────────────────────────────────────────
  const intelligenceLevel = rng.nextInt(1, 10);
  const ambitionLevel     = rng.nextInt(1, 10);
  const faithLevel        = Math.max(1, Math.round(religionDevotion * 10));   // 1–10, derived
  const fearLevel         = rng.nextInt(1, 6);                   // starts moderate

  // ── Communication style ───────────────────────────────────────────────────
  const communicationStyle: CommunicationStyle = ROLE_TO_COMM_STYLE[role];

  // ── Attitude toward God ───────────────────────────────────────────────────
  let attitudeTowardGod: AttitudeTowardGod;
  if (religionDevotion > 0.6) {
    attitudeTowardGod = 'loyal_worshipper';
  } else if (religionDevotion > 0.3) {
    attitudeTowardGod = 'fearful_servant';
  } else if (highHostility) {
    attitudeTowardGod = 'manipulative_believer';
  } else {
    attitudeTowardGod = 'skeptical_ruler';
  }

  // ── Unique id ─────────────────────────────────────────────────────────────
  const id = `leader_${starId}_${civLevel}_${rng.nextInt(100000, 999999)}`;

  return {
    id,
    starId,
    name,
    species: speciesName,
    faction: civName,
    role,
    ideology,
    intelligenceLevel,
    ambitionLevel,
    faithLevel,
    fearLevel,
    personalityTraits,
    communicationStyle,
    attitudeTowardGod,
    spawnedAtCivLevel: civLevel,
  };
}

/**
 * Shifts a leader's attitude toward or away from God by one step.
 *
 * @param current Current attitude
 * @param valence +1 shifts toward loyal_worshipper; -1 shifts toward open_atheist
 * @returns New attitude (clamped to ends of scale)
 */
export function shiftLeaderAttitude(current: AttitudeTowardGod, valence: 1 | -1): AttitudeTowardGod {
  const idx = ATTITUDE_SCALE.indexOf(current);
  if (idx === -1) return current; // unknown — no-op
  const next = idx + valence;
  const clamped = Math.max(0, Math.min(ATTITUDE_SCALE.length - 1, next));
  return ATTITUDE_SCALE[clamped];
}
