import type { Leader, LeaderMemory } from './Leader';
import type { FactionFlag } from './FactionFlag';
import type { SpeciesGenome, PlanetBiosphere } from './SpeciesGenome';
import { DEFAULT_BIOSPHERE } from './SpeciesGenome';
import type { PlanetGrid } from './PlanetGrid';

export interface PlanetDNA {
  climate: 'desert' | 'temperate' | 'frozen';
  oceans:  'barren' | 'mixed' | 'ocean_world';
  chaos:   'serene' | 'turbulent' | 'storm';
}

export const DEFAULT_PLANET_DNA: PlanetDNA = {
  climate: 'temperate',
  oceans:  'mixed',
  chaos:   'turbulent',
};

export interface UniverseStats {
  life: number;           // 1-20: star count, life emergence, panspermia
  evolution: number;      // 1-20: civ tech progression speed
  hostility: number;      // 1-20: war frequency, asteroid frequency
  entropy: number;        // 1-20: asteroid belt size, star death rate
  divine: number;         // 1-20: AI God intervention frequency + power
}

export type GameScreen = 'menu' | 'rolling' | 'bigbang' | 'game' | 'planet';

// ─── Biology / Civilisation Phase System ──────────────────────────────────────

/** Ordered life phases — cannot skip. */
export type BiologyPhase =
  | 'microbial' | 'multicellular' | 'complex' | 'primitive' | 'intelligent';

/** Ordered civilisation phases — begin once intelligence emerges. */
export type CivPhase =
  | 'early' | 'industrial' | 'spacefaring' | 'interstellar' | 'transcendent';

export const BIO_PHASE_SEQUENCE: BiologyPhase[] =
  ['microbial', 'multicellular', 'complex', 'primitive', 'intelligent'];

export const CIV_PHASE_SEQUENCE: CivPhase[] =
  ['early', 'industrial', 'spacefaring', 'interstellar', 'transcendent'];

export const BIO_PHASE_LABELS: Record<BiologyPhase, string> = {
  microbial:     'Microbial Life',
  multicellular: 'Multicellular Life',
  complex:       'Complex Life',
  primitive:     'Primitive Species',
  intelligent:   'Intelligent Species',
};

export const CIV_PHASE_LABELS: Record<CivPhase, string> = {
  early:         'Early Civilisation',
  industrial:    'Industrial Civilisation',
  spacefaring:   'Spacefaring Civilisation',
  interstellar:  'Interstellar Civilisation',
  transcendent:  'Transcendent Civilisation',
};

/** Maps civLevel (0-8) to the matching CivPhase for display. */
export function civLevelToPhase(civLevel: number): CivPhase {
  if (civLevel <= 2) return 'early';
  if (civLevel <= 4) return 'industrial';
  if (civLevel === 5) return 'spacefaring';
  if (civLevel === 6) return 'interstellar';
  return 'transcendent';
}

// ─── DNA Branch System ────────────────────────────────────────────────────────

/**
 * Investment in this universe's DNA branches, keyed by branch id.
 *
 * This was eight hard-coded fields, which meant every universe offered exactly
 * the same eight choices. Branch identities are now rolled per universe (see
 * `DnaBranches.ts`), so this is an open record and the simulation reads it by
 * EFFECT rather than by field name.
 */
export type DNABranch = Record<string, number>;

/** No investment yet. Real branch ids are filled in when a universe is created. */
export const DEFAULT_DNA_BRANCH: DNABranch = {};

/**
 * Resolved branch definitions for the current universe.
 *
 * Kept on `runtimeState` rather than in the save: saves store only `branchIds`,
 * so wording or colour changes to a branch do not invalidate an old save.
 */
export function activeBranchDefs(): import('./DnaBranches').BranchDef[] {
  return runtimeState.branchDefs;
}

// ─── Codex ────────────────────────────────────────────────────────────────────

export interface CodexEntry {
  id: string;
  tick: number;
  title: string;
  body: string;
  category: 'biology' | 'civilisation' | 'war' | 'extinction' | 'divine';
}

// Milestones that trigger Codex entries
export const CODEX_MILESTONES: Record<string, { title: string; category: CodexEntry['category'] }> = {
  multicellular: { title: 'First Eyes',              category: 'biology'      },
  complex:       { title: 'First Senses',            category: 'biology'      },
  primitive:     { title: 'First Language',          category: 'biology'      },
  intelligent:   { title: 'First Fire',              category: 'civilisation' },
  civ_2:         { title: 'First City',              category: 'civilisation' },
  civ_5:         { title: 'First Orbit',             category: 'civilisation' },
  civ_6:         { title: 'First Interstellar Mission', category: 'civilisation' },
};

// ─── Game State ───────────────────────────────────────────────────────────────

export interface GameStateData {
  screen: GameScreen;
  stats: UniverseStats | null;
  tick: number;
  divinePoints: number;
  techPoints: number;
  dnaPoints: number;
  playerDNA: DNABranch;
  /**
   * The one branch the player is committed to this biology phase, or null if
   * they have not chosen yet.
   *
   * Evolution advances one thing at a time: spending the first point of a phase
   * locks the direction until the world reaches the next phase, which is where
   * `BigBangEngine.updateBiologyPhase` clears it. Without this the lab lets you
   * feed every branch at once, which is neither a decision nor how a lineage
   * actually specialises.
   */
  dnaFocusBranch: string | null;
  /** Ids of this universe's DNA branches, in display order. Saved; defs are rebuilt from them. */
  branchIds: string[];
  universeName: string;
  masterSeed: string;
  godName: string;
  godMood: string;
  playerPlanetName: string;
  playerSpeciesName: string;
  playerReligionName: string;
  playerStarId: number;
  bigBangComplete: boolean;
  speed: number;  // 0=pause, 1, 10, 100, 1000
  playerPlanetDNA: PlanetDNA | null;
  codexEntries: CodexEntry[];
  playerSpeciesTraits: Record<string, string>;   // category → chosen value from traits modal
  playerSpeciesDescription: string;              // Gemini-generated species description
  // M16: AI Leaders
  leaders: Leader[];
  leaderMemories: LeaderMemory[];
  factionFlags: Record<number, FactionFlag>;  // starId → flag
  firstContactFired: boolean;
  // M17: Living Biosphere
  playerSpecies:   SpeciesGenome[];
  playerBiosphere: PlanetBiosphere;
}

/** Runtime-only planet grid — NOT serialized. Regenerated on load from seed. */
export const runtimeState = {
  /** This universe's DNA branch definitions, rebuilt from `gameState.branchIds`. */
  branchDefs: [] as import('./DnaBranches').BranchDef[],
  playerPlanetGrid: null as PlanetGrid | null,
};

export const gameState: GameStateData = {
  screen: 'menu',
  stats: null,
  tick: 0,
  divinePoints: 0,
  techPoints: 0,
  dnaPoints: 0,
  playerDNA: { ...DEFAULT_DNA_BRANCH },
  dnaFocusBranch: null,
  branchIds: [],
  universeName: '',
  masterSeed: '',
  godName: 'AWAITING GENESIS...',
  godMood: 'dormant',
  playerPlanetName: '—',
  playerSpeciesName: '',
  playerReligionName: '',
  playerStarId: -1,
  bigBangComplete: false,
  speed: 1,
  playerPlanetDNA: null,
  codexEntries: [],
  playerSpeciesTraits: {},
  playerSpeciesDescription: '',
  leaders: [],
  leaderMemories: [],
  factionFlags: {},
  firstContactFired: false,
  playerSpecies:   [],
  playerBiosphere: { ...DEFAULT_BIOSPHERE },
};

// Tech level names
export const TECH_LEVELS = [
  'Primitive',
  'Ancient',
  'Medieval',
  'Industrial',
  'Atomic',
  'Space Age',
  'Interstellar',
  'Post-Human',
  'Post-Biological',
];

export const CIV_COLORS = [
  '#886644', // Primitive - brown
  '#aa8855', // Ancient - tan
  '#cc9966', // Medieval - gold-tan
  '#aaaaaa', // Industrial - gray
  '#88aacc', // Atomic - blue-gray
  '#44aaff', // Space Age - blue
  '#44ffcc', // Interstellar - teal
  '#ff88ff', // Post-Human - magenta
  '#ffffff', // Post-Biological - white
];
