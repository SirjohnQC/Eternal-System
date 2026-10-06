import { NationSystem } from './Nations';
import { SeedRNG } from '../utils/SeedRNG';
import {
  UniverseStats, TECH_LEVELS, CIV_COLORS,
  BiologyPhase, BIO_PHASE_SEQUENCE, BIO_PHASE_LABELS, CODEX_MILESTONES,
  DNABranch, DEFAULT_DNA_BRANCH,
  CodexEntry, civLevelToPhase,
  gameState, runtimeState, DEFAULT_PLANET_DNA,
  type PlanetDNA,
} from './GameState';
import { bakePlanetTexture } from './PlanetRenderer';
import { genomeSeedFor } from './PlanetGenome';
import { generateLeader, type Leader } from './Leader';
import { generateFactionFlag, drawFactionFlag, type FactionFlag } from './FactionFlag';
import {
  bakeStarBody, bakeStarCorona, bakeStarGlow, bakePlanetSprite, bakeMoonSprite,
  STAR_BODY_FRAMES, CORONA_BODY_FRAC,
  wrapEquirectToGlobe, starTempBand, starVisualProfile, parseHexColor,
  type PlanetKind as CosmicPlanetKind,
  type MoonKind as CosmicMoonKind,
} from '../rendering/CosmicPixelSprites';
import {
  stepEvolution, shouldStepEvolution, initPlayerSpecies, applyNudgeMutation,
  type EvolutionEvent,
} from './EvolutionEngine';
import { stepLifeSpread, type PlanetGrid } from './PlanetGrid';
import { assignDominantSpecies } from './SpeciesDistribution';
import type { SpeciesGenome, PlanetBiosphere } from './SpeciesGenome';
import { DEFAULT_BIOSPHERE } from './SpeciesGenome';
import {
  branchEffect, generateBranchSet, emptyInvestment, branchesFromIds,
  type BranchDef,
} from './DnaBranches';
import {
  ARCHETYPES, systemHabitability, pickArchetype, rollBioTempo,
  resolveTransition, rollCatastrophe, phaseLabel, survivesFloorCollapse,
  STALL_TIME_PENALTY, PLAYER_STALL_TIME_CAP,
  type LifeArchetype, type PlanetKind,
} from './LifeSystem';
import {
  cultureMultiplier, proceduralCulture, summariseGenome, valuesFromGenome,
  type Civilization, type GenomeSummary,
} from './Civilization';
import { generateCulture } from '../ai/CultureGenerator';
import {
  rollUniverseMutations, lockedTraits, mutationEffect, cardStates, cloneGenome,
  queueReady, applyMutation, genomeDiff,
} from './Mutations';
import { nameForGenome } from './SpeciesNaming';
import {
  type DestinyType, rollDestiny, rollFormationBudget, stageDuration, nextStage,
  lifeEligible, addBoost, LIFE_BOOST, SEED_BOOST, formationFaceType,
  spontaneousLifeChance, ejectaChance, formationFraction,
} from './Formation';
import type { GeminiService } from '../ai/GeminiService';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export type PlanetFormationStage =
  | 'magma' | 'cooling' | 'volcanic' | 'atmosphere' | 'ice_age' | 'primordial';

const FORMATION_SEQUENCE: PlanetFormationStage[] = [
  'magma', 'cooling', 'volcanic', 'atmosphere', 'ice_age', 'primordial',
];
const FORMATION_DURATIONS: Record<PlanetFormationStage, number> = {
  magma:      400,
  cooling:    300,
  volcanic:   500,
  atmosphere: 400,
  ice_age:    300,
  primordial: 500,
};

// Terraform sequences: planet type → (stages to pass through → resulting type)
const TERRAFORM_SEQUENCES: Record<string, { stages: PlanetFormationStage[]; result: Planet['type'] }[]> = {
  lava:  [
    { stages: ['ice_age', 'atmosphere', 'cooling'], result: 'rocky' },
    { stages: ['ice_age', 'atmosphere', 'primordial'], result: 'ocean' },
  ],
  ice:   [
    { stages: ['atmosphere', 'primordial'], result: 'rocky' },
  ],
  rocky: [
    { stages: ['primordial'], result: 'ocean' },
  ],
};
const TERRAFORM_DURATIONS: Record<PlanetFormationStage, number> = {
  magma:      600,
  cooling:    500,
  volcanic:   700,
  atmosphere: 600,
  ice_age:    500,
  primordial: 700,
};

export type PlanetDiscovery = 'none' | 'telescope' | 'probe' | 'landing';

/**
 * A natural satellite (M22k).
 *
 * No moon entity existed anywhere in the engine before this: the diorama drew a
 * single decorative disc in the sky that belonged to nothing, was the same size
 * and colour on every world, and could not be visited or reasoned about.
 */
export interface Moon {
  name: string;
  /** Visual radius in world units. Always smaller than its parent planet. */
  radius: number;
  /** Distance from the planet, in world units. */
  orbitalRadius: number;
  orbitalAngle: number;
  orbitalSpeed: number;
  color: string;
  kind: MoonKind;
  /**
   * How suitable this moon is for settlement, 0–1. Fixed at generation from its
   * composition; a civilisation still has to be advanced enough to act on it.
   */
  habitability: number;
  /** Set once a civilisation has settled here. */
  colonised: boolean;
  /** Tick the colony was founded, for the event log and Codex. */
  colonisedTick: number | null;
}

export type MoonKind = 'rock' | 'ice' | 'iron' | 'volcanic' | 'carbon' | 'ocean';

export interface Planet {
  orbitalAngle: number;
  /** Semi-major axis (mean orbital distance) in world units. */
  orbitalRadius: number;
  orbitalSpeed: number;
  /**
   * Orbit eccentricity 0–~0.55. 0 = circle; higher = elliptical path with the
   * star at one focus.
   */
  eccentricity: number;
  /** Orientation of the ellipse (argument of periapsis), radians. */
  periapsisAngle: number;
  radius: number;
  type: 'rocky' | 'ocean' | 'gas' | 'ice' | 'lava'
      | 'toxic' | 'crystal' | 'desert' | 'storm' | 'carbon';
  hasLife: boolean;
  /** Scorched / frozen husk — no biosphere, drawn as ash/gray. */
  isDead?: boolean;
  biosphere: number;    // 0–1
  color: string;
  discovery: PlanetDiscovery;
  name: string;         // assigned on first telescope-level discovery
  /** Natural satellites. Empty for most planets; gas giants keep the most. */
  moons: Moon[];
  /**
   * Climate / ocean / chaos profile — drives terrain bake so the orrery globe
   * stays close to the diorama / surface map. Rolled per planet at birth;
   * player's home is overwritten from the ritual answers.
   */
  dna?: PlanetDNA;
  /**
   * Seed for this planet's PlanetGenome. Assigned once at creation and never
   * rewritten — terraforming changes `type` but must NOT change identity.
   * Absent on saves written before the genome landed; backfilled on load.
   */
  genomeSeed?: number;
  /**
   * What this world is meant to FINISH as (home world only; see Formation.ts).
   * While it forms, `type` is the face of its current stage — molten, bare
   * rock — and becomes this when the last stage completes.
   */
  destinyType?: DestinyType;
}

// Moved to ./Orbit (pure) so renderers can place planets without the engine.
export { planetOffsetFromStar } from './Orbit';
import { planetOffsetFromStar } from './Orbit';

/**
 * A galaxy: a named clump of stars (M22b).
 *
 * The universe was one undifferentiated disc of stars, so there was nothing for
 * a "galaxy" zoom tier to show. The Big Bang now throws its stars toward a
 * handful of centres instead of scattering them uniformly, which is what makes
 * the opening read as galaxies forming rather than one spray of dots.
 *
 * Morphology (spiral / barred / …) drives both star placement and the pixel-art
 * envelope — soft radial glows read as modern VFX, not the CRT observatory look.
 */
export type GalaxyMorph = 'spiral' | 'barred' | 'lenticular' | 'elliptical' | 'irregular';

/** Compact corpse left after death or primordial burnout. */
export type RemnantKind = 'white_dwarf' | 'neutron' | 'black_hole';

/** How densely a morph tends to pack systems (relative weights). */
export function galaxyMorphWeight(morph: GalaxyMorph): number {
  switch (morph) {
    case 'elliptical': return 1.7;
    case 'lenticular': return 1.45;
    case 'barred':     return 1.05;
    case 'spiral':     return 1.0;
    case 'irregular':  return 0.5;
  }
}

export interface Galaxy {
  id: number;
  name: string;
  /**
   * Drawn envelope centre. Matches the fixed kinematic centre — we do NOT
   * chase the star-mean (that yanked the whole swirl every census at high speed).
   */
  x: number;
  y: number;
  /** Fixed orbit centre — set at birth, never moved by census. */
  cx: number;
  cy: number;
  /** Radius covering most of its stars, in world units. */
  radius: number;
  /** Soft-follow target for envelope radius only. */
  tRadius: number;
  color: string;
  /** Rotation of the disc / spiral pattern, radians. */
  tilt: number;
  starIds: number[];
  /** Hubble-ish class — decides arms, bar, and pixel-art silhouette. */
  morph: GalaxyMorph;
  /** Spiral arm count (2–4). Ignored for elliptical / irregular. */
  armCount: number;
  /** How tightly arms wind (higher = tighter). */
  armPitch: number;
  /** Bar half-length as a fraction of radius (0 if unbarred). */
  barLength: number;
  /** Disc thickness squash (face-on ≈ 1, edge-on ≈ 0.35). */
  discFlat: number;
}

/**
 * How far in the player is looking.
 *
 * Zoom used to be a single continuous scale with no notion of altitude, so the
 * star map and the planet view were disconnected screens rather than ends of one
 * continuum. Tiers give zooming somewhere to arrive at, and give the UI
 * something to name and to jump between.
 */
export type ZoomTier = 'universe' | 'galaxy' | 'system' | 'planet';

/**
 * Closest the system view's camera goes (wheel zoom). Was 5: a planet then
 * filled only a few dozen pixels. At 12 a world reads as a globe you can
 * inspect; its texture is baked larger when it is big on screen.
 */
export const CAMERA_MAX_SCALE = 12;

/** Camera scale at which each tier begins, and the scale a jump lands on. */
export const ZOOM_TIERS: Array<{ tier: ZoomTier; min: number; nominal: number; label: string }> = [
  // Nominal scales drop with the larger WORLD_SIZE so "Universe" still frames
  // the whole disc and "Galaxy" frames one island in the void.
  { tier: 'universe', min: 0.00, nominal: 0.12, label: 'Universe' },
  { tier: 'galaxy',   min: 0.22, nominal: 0.70, label: 'Galaxy'   },
  { tier: 'system',   min: 1.80, nominal: 3.20, label: 'System'   },
  { tier: 'planet',   min: 4.40, nominal: 5.00, label: 'Planet'   },
];

export interface RevelationFlash {
  x: number; y: number;
  startTick: number;
  startAnimTick: number;
}

export interface StarBody {
  id: number;
  x: number; y: number;
  vx: number; vy: number;
  mass: number;         // 1–15 (affects gravity + visual size)
  radius: number;       // visual radius in world units
  temperature: number;  // 3000–30000 K (affects color)
  age: number;          // ticks alive
  hasLife: boolean;
  civLevel: number;     // 0–8 (index into TECH_LEVELS)
  civName: string;
  planets: Planet[];
  explorationRadius: number;
  isPlayerStar: boolean;
  isDead: boolean;
  /**
   * When `isDead`, what the corpse looks like. Primordial burnouts and
   * supernova/merger remnants both keep a visible body + husk planets.
   */
  remnantKind?: RemnantKind;
  asteroidBelt: boolean;
  /** 0–1 rock density when asteroidBelt is true. */
  asteroidBeltDensity: number;
  lastEventTick: number;
  /** Which galaxy this star belongs to (M22b). */
  galaxyId?: number;
  /**
   * Mean orbital radius around the galaxy centre (M25).
   * Stars swirl at this radius with mild eccentricity — they do not fall
   * inward toward heavier neighbours.
   */
  orbitRadius?: number;
  /**
   * Current angle on the galactic orbit (radians). Advanced once per sim tick;
   * render uses this + a fractional tick so high speed stays smooth.
   */
  orbitAngle?: number;
  formationStage: PlanetFormationStage | null;
  /**
   * Condensed out of a supernova remnant during play, rather than existing from
   * the Big Bang (M22g).
   *
   * A new system gets exactly ONE roll for life when its formation completes, at
   * `NEW_SYSTEM_LIFE_CHANCE`, and is held out of ongoing abiogenesis until
   * `newSystemUntil`. Left in the normal pool from the start it picks up life at
   * the ambient rate — measured at 14% — and a late-game universe quietly
   * refills with inhabited worlds, costing the player's own world its
   * significance.
   */
  isNewSystem?: boolean;
  /**
   * Tick after which a new system stops being treated as new.
   *
   * This has to expire. Held out FOREVER, and with hundreds of stars condensing
   * over a long game, an ever-larger share of the cosmos becomes permanently
   * incapable of life — measured, a 400k-tick universe fell to 3 living worlds
   * out of 25. A young system is barren for a good long while; it is not cursed.
   */
  newSystemUntil?: number;
  formationTick: number;
  /**
   * Destiny ladder (home world): set while the world walks the stage ladder for
   * its destiny instead of the generic FORMATION_SEQUENCE. Cleared when done.
   */
  formationDestiny?: DestinyType;
  /** Total formation budget in ticks of progress, rolled once (1-3 player days). */
  formationBudget?: number;
  /** Ticks of progress made in the current stage (advances faster with life). */
  formationProgress?: number;
  /** Rate bonus from life present / seeding events, 0..MAX_BOOST. */
  formationBoost?: number;
  terraformStage: PlanetFormationStage | null;  // active terraform stage, null = idle
  terraformTick: number;                         // tick when current stage started
  terraformTargetType: Planet['type'] | null;    // final planet type after terraforming
  religionName: string;     // '' = no religion yet
  religionDevotion: number; // 0–1
  // ── Phase system ────────────────────────────────────────────
  biologyPhase: BiologyPhase;     // current life-evolution phase
  bioPhaseProgress: number;       // ticks elapsed in current bio phase
  dna: DNABranch;                 // species DNA (player-invested or auto-generated)

  // ── Life model (LifeSystem) ─────────────────────────────────
  // All optional so saves written before this system still load.
  habitability?:   number;         // 0–1, how suitable this system is for life
  bestPlanetIndex?: number;        // planet the habitability score came from
  lifeArchetype?:  LifeArchetype;  // biochemistry of the current biosphere
  bioTempo?:       number;         // per-world evolutionary speed multiplier
  bioStalls?:      number;         // times this world has failed to leave its phase
  extinctions?:    number;         // biospheres this system has lost outright
  lifeFirstTick?:  number;         // tick abiogenesis last happened here
}

export interface NebulaCloud {
  x: number; y: number;
  radius: number;
  maxRadius: number;
  alpha: number;
  r: number; g: number; b: number;
  age: number;
}

export interface Fleet {
  id: number;
  fromStarId: number;
  toStarId: number;
  x: number; y: number;
  progress: number;
  hostile: boolean;
  isPlayerFleet: boolean;
}

export interface OrbitalFleet {
  id: number;
  warId: number;
  starId: number;       // star being orbited (the defender)
  angle: number;        // current angle in radians
  speed: number;        // radians per tick (negative = counter-clockwise)
  orbitRadius: number;  // world-space radius
  civColor: string;     // attacker civilisation color
}

export interface AsteroidBody {
  x: number; y: number;
  vx: number; vy: number;
  radius: number;
  alive: boolean;
}

export type BigBangPhase = 'inflation' | 'gravity' | 'settled';

export type WarPhase = 'skirmish' | 'campaign' | 'siege' | 'resolution';

export interface War {
  id: number;
  attackerStarId: number;
  defenderStarId: number;
  startTick: number;
  duration: number;          // total ticks the war lasts
  phase: WarPhase;
  attackerStrength: number;  // 0–1, shifts over war duration
  defenderStrength: number;  // 0–1
  lastBattleReportTick: number;
  resolved: boolean;
}

export type CosmicEventType = 'supernova' | 'asteroid_impact' | 'void_storm' | 'plague';

export interface CosmicEvent {
  id: number;
  type: CosmicEventType;
  targetStarId: number;
  scheduledTick: number;  // tick when it fires
  warningTick: number;    // tick when warning fires
  resolved: boolean;
  smited: boolean;        // player used Smite Asteroid on this
}

export interface SupernovaFlash {
  x: number; y: number;
  startTick: number;
  startAnimTick: number;
  maxRadius: number;
}

interface CosmicSignal {
  id: number;
  starId: number;
  civName: string;
  startTick: number;
  decodedAt: number;
  message: string;
  fired: boolean;
  decoded: boolean;
}

export interface EngineSnapshot {
  version: 1;
  tick: number;
  phase: BigBangPhase;
  stars: StarBody[];
  nebulae: NebulaCloud[];
  asteroids: AsteroidBody[];
  fleets: Fleet[];
  orbitalFleets: OrbitalFleet[];
  cosmicEvents: CosmicEvent[];
  activeWars: War[];
  exploredAreas: Array<{ x: number; y: number; r: number }>;
  settledSinceTick: number;
  cosmicEventIdCounter: number;
  warIdCounter: number;
  fleetIdCounter: number;
  orbitalFleetIdCounter: number;
  nextCosmicCheckTick: number;
  rngState: number;
  starIdCounter?: number;
  stellarNurseries?: Array<{ x: number; y: number; starsLeft: number; nextSpawnTick: number }>;
  leaders?: Leader[];
  factionFlags?: Record<number, FactionFlag>;
  firstContactFired?: boolean;
  cosmicSignals?: CosmicSignal[];
  playerSpecies?:   SpeciesGenome[];
  playerBiosphere?: PlanetBiosphere;
  civilizations?: Record<number, Civilization>;
}

export interface Camera {
  x: number; y: number;    // world coords at screen center
  scale: number;            // world units per pixel (lower = zoomed in)
  tx: number; ty: number;  // lerp targets
  ts: number;               // scale target
}

// ─── Constants ────────────────────────────────────────────────────────────────
import {
  WORLD_SIZE, INFLATION_TICKS, MAX_SPEED,
  UNIVERSE_RADIUS, INFLATION_DECAY, INFLATION_DRIFT,
  CIV_TICK_RATE, WAR_TICK_RATE, RADIO_TICK_RATE, RADIO_DECODE_TICKS,
  BIO_PHASE_TICKS,
} from '../constants';

// M25 cosmology: stars ORBIT their galaxy — they do not fall into neighbours.
// Pairwise N-body gravity + heavy damping was the old model; everything drifted
// toward the heaviest body and merged. Real galaxies keep systems on long
// orbits, and mergers only happen when two stars pass extremely close.
/** Galactic gravitational parameter (GM). Sets circular-orbit speeds.
 *  Kept tiny so even at 200× the swirl is barely perceptible — a full
 *  revolution takes many minutes of real time at that speed. */
const GALACTIC_MU      = 0.008;
/** Softens the galactic core so stars near the centre are not slingshot. */
const GALACTIC_SOFT    = 50;
/** Hard cap on galactic angular speed (radians per sim tick). At 200×
 *  (~200 ticks/sec) this is ~0.7°/sec — just noticeable, not a blender. */
const MAX_GALACTIC_OMEGA = 0.00006;
/** Eccentricity phase advance per tick — slow radial breathing, not pulsing. */
const ORBIT_ECC_RATE   = 0.00002;
/**
 * Close-approach merge distance (world units). Pure contact `(ra+rb)*k` never
 * fires under co-rotating galactic orbits — systems keep their angular
 * separation forever. A modest absolute floor restores rare mergers without
 * the old N-body cascade into the heaviest neighbour.
 */
const MERGE_DIST       = 22;
/** Soft capture range — gently pull orbit radii together so a future merge
 *  can happen, instead of two near-misses skating past forever. */
const CAPTURE_DIST     = 48;
const NEBULA_EXPAND    = 0.35;
const NEBULA_FADE      = 0.003;
const MAX_ORBITAL_SPEED = 1.35;
/** Minimum target separation (world units) between stars in the same galaxy.
 *  Must exceed 2× a typical outer orbit (~120) plus void, and still hold after
 *  14% galactic eccentricity, or neighbouring solar systems overlap. */
const MIN_STAR_SEPARATION = 360;
/** Radians per animTick (~60/s). Inner year ~100s at 1× so the orrery is
 *  readable; Kepler √(1/a) plus 15% jitter still varies the worlds. */
const PLANET_ORBIT_MU = 0.0012;
const ASTEROID_SPAWN   = 35;      // spawn asteroids more frequently
const PANSPERMIA_DIST  = 80;
const FOG_ALPHA        = 0.93;

// ── Life model tuning (see LifeSystem.ts) ───────────────────────────────────
// Per-star, per-tick chance of abiogenesis at habitability 1.0 and life 20.
// Scaled by habitability² so marginal worlds are usually never, not just slow.
const ABIOGENESIS_BASE = 1 / 46000;
// Per-star, per-tick chance of a biosphere-scale catastrophe at max pressure.
const CATASTROPHE_BASE = 1 / 900000;
// How much a single Divine Nudge softens the next Great Filter roll (0–1).
const NUDGE_ASSISTANCE = 0.45;
/**
 * Combined mass at which a stellar merger detonates instead of settling.
 *
 * Below this two stars simply become a heavier one. At or above it the survivor
 * is past the point where it can hold itself together.
 *
 * Stars are rolled at mass 1–8, so reaching this takes a chain of mergers — a
 * detonation should be the end of a long story, not routine weather. At 13 it
 * was routine: measured, it roughly DOUBLED the number of times the player's own
 * world was knocked back to magma (≈12 per 400k ticks against ≈5.5), and almost
 * no seed ever climbed the biology ladder. See `tools/playerProgressCheck.ts`.
 */
const COLLISION_SUPERNOVA_MASS = 19;
/**
 * Tech tier at which a civilisation can outrun its own star's death.
 *
 * 6 is Interstellar — the first tier with ships that reach another system.
 */
const CIV_EVACUATION_LEVEL = 6;
/**
 * How large an incoming star has to be, relative to the survivor, for a merger
 * to wreck the surviving world rather than simply being absorbed.
 */
const MERGER_CATASTROPHE_RATIO = 0.45;
/** Ticks between moon-colonisation checks. */
const MOON_CHECK_RATE = 1000;
/** Ticks between planet-formation stage checks. */
const FORMATION_CHECK_RATE = 60;
/** DNA granted when the first life appears, so the player has a first choice. */
const FIRST_LIFE_DNA = 6;
/** Chance per evolution step that a free mutation card joins the queue. */
const SPONTANEOUS_MUTATION_CHANCE = 0.06;
/** How far debris from a living neighbour can carry life to a forming world. */
const FORMATION_EJECTA_RANGE = 220;
/** System-view colour of the home planet while it forms (by stage). */
const FORMATION_FACE_COLORS: Partial<Record<PlanetFormationStage, string>> = {
  magma: '#d4521c', cooling: '#8a3a1e', volcanic: '#5a3a30',
  atmosphere: '#7d6f63', ice_age: '#bfd8ea', primordial: '#3d6f9e',
};
/** System-view colour of a finished home world, by destiny. */
const DESTINY_COLORS: Record<DestinyType, string> = {
  ocean: '#2266aa', rocky: '#aa8866', ice: '#cfe6f5', desert: '#d2b07a',
};
/** Where life on a forming world came from (for the feed). */
export type FormationLifeSource = 'spontaneous' | 'ejecta' | 'meteor' | 'divine';
/**
 * Chance that a newly condensed system starts with life already in it.
 *
 * Deliberately tiny. New systems should overwhelmingly be empty rock; a
 * late-game universe that quietly refills with inhabited worlds costs the
 * player's own world its significance.
 */
const NEW_SYSTEM_LIFE_CHANCE = 0.01;
/**
 * How much harder it is for PANSPERMIA to take hold in a young system.
 *
 * The 1% above governs a new system arising with life of its own. Life arriving
 * from outside — on an asteroid, or carried by a visiting civilisation — is a
 * different mechanism and worth keeping. But a freshly condensed system is a
 * young, violent, unsettled place, and without this suppression it inherits the
 * ambient seeding rate: measured, 8.9% of new systems ended up inhabited, against
 * the 1% the design calls for.
 */
const NEW_SYSTEM_PANSPERMIA_MOD = 0.08;
/**
 * How long a freshly condensed system is treated as new.
 *
 * Long enough that it is visibly barren, short enough that the cosmos does not
 * sterilise as more and more of it is recycled.
 */
const NEW_SYSTEM_GRACE = 6000;
// Scales the player's normalised bioResilience effect into filter assistance.
//
// Tuned against what the economy actually pays out: a player who pours every
// point into one branch ends the game around 38 points in it (measured, see
// `tools/dnaEconomyCheck.ts`), i.e. a bioResilience effect near 0.34. At this
// weight that just reaches the 0.5 assistance cap, so investment scales all the
// way up instead of saturating a third of the way through — at 2.2 the ceiling
// was hit by 25 points and every point after that bought nothing, which is a
// poor deal when points also get more expensive.
const DNA_ASSIST_WEIGHT = 1.4;

// Star temperature → color
function tempToColor(t: number): string {
  if (t > 25000) return '#aaccff';  // blue-white
  if (t > 10000) return '#ffffff';  // white
  if (t > 7500)  return '#fff8e0';  // yellow-white
  if (t > 6000)  return '#ffeeaa';  // yellow
  if (t > 5000)  return '#ffcc88';  // orange-yellow
  if (t > 4000)  return '#ff9944';  // orange
  return '#ff6622';                  // red (cool)
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class BigBangEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private fogCanvas: HTMLCanvasElement;
  private fogCtx: CanvasRenderingContext2D;
  /** Skip full fog rebuild when camera/holes haven't moved enough. */
  private fogCacheKey = '';
  private fogCacheValid = false;

  stars: StarBody[] = [];
  nebulae: NebulaCloud[] = [];
  asteroids: AsteroidBody[] = [];
  fleets: Fleet[] = [];
  orbitalFleets: OrbitalFleet[] = [];
  cosmicEvents: CosmicEvent[] = [];
  activeWars: War[] = [];
  private supernovaFlashes: SupernovaFlash[] = [];
  private galaxies: Galaxy[] = [];
  /**
   * How many systems have condensed during play, and how many of those arrived
   * carrying life.
   *
   * Counted because the interesting quantity — the 1% in `IDEA.md` — is whether
   * a system is alive WHEN IT FORMS. Counting how many newborn systems are alive
   * at the end of a run answers a different question: those have also had
   * hundreds of thousands of ticks to evolve life the ordinary way, which they
   * are entitled to do.
   */
  newSystemsFormed = 0;
  newSystemsBornAlive = 0;
  private revelationFlashes: RevelationFlash[] = [];
  private cosmicEventIdCounter = 0;
  private nextCosmicCheckTick = 0;
  /** Next free star id. Star formation keeps allocating past the initial set. */
  private starIdCounter = 0;
  /** Collapsing gas clouds that will condense into new stars. */
  private stellarNurseries: Array<{
    x: number; y: number; starsLeft: number; nextSpawnTick: number;
  }> = [];
  /** Big-Bang landing sites — inflation is visual; orbits snap here. */
  private spawnTargets = new Map<number, { x: number; y: number }>();
  private warIdCounter = 0;
  private orbitalFleetIdCounter = 0;
  private cosmicSignals: CosmicSignal[] = [];
  private _signalIdCounter = 0;
  private planetTextureCache = new Map<string, HTMLCanvasElement>();

  tick = 0;
  phase: BigBangPhase = 'inflation';
  stats!: UniverseStats;

  /** Set to true to make render() skip world-space draws (Pixi handles them). */
  pixiMode = false;
  /** Called at end of each frame when pixiMode is true. */
  onPixiFrame: ((engine: BigBangEngine) => void) | null = null;
  /**
   * When true, advance animTick / fog pacing but skip Pixi + canvas world draws.
   * Used while the planet diorama owns the screen so a 240Hz display isn't
   * paying for two full renderers every vsync.
   */
  suspendWorldDraw = false;
  /** Optional FPS HUD / diagnostics (avg over ~0.5s windows). */
  onFpsSample: ((fps: number, frameMs: number) => void) | null = null;
  private fpsWindowStart = performance.now();
  private fpsFrameCount = 0;
  private fpsFrameMsSum = 0;
  currentFps = 0;
  currentFrameMs = 0;
  /**
   * When false, stars still attract but never merge or detonate.
   * Measurement control for M25 (`tools/playerProgressCheck.ts` collisions-off
   * pass) — not a player-facing setting.
   */
  collisionsEnabled = true;

  private rng!: SeedRNG;
  private camera: Camera = { x: WORLD_SIZE/2, y: WORLD_SIZE/2, scale: 1.5, tx: WORLD_SIZE/2, ty: WORLD_SIZE/2, ts: 1.5 };
  private playerStarId = -1;
  private fleetIdCounter = 0;
  private running = false;
  private animHandle = 0;
  private exploredAreas: Array<{ x: number; y: number; r: number }> = [];
  /** Index of the fog bubble that tracks the player's moving home star. */
  private playerFogIndex = -1;
  /**
   * Soft-follow the home star / galaxy with the camera while zoomed in.
   * Cleared when the player pans; restored by VIEW / focus / clicking home.
   */
  private cameraFollowHome = true;
  private _lastClickTime = 0;
  private _lastClickedStarId = -1;

  // Event callbacks
  onCivEvent: ((msg: string) => void) | null = null;
  /** Hash of the universe seed (init): seeds per-world systems such as the nations. */
  private tick0Seed = 0;
  /** The era stepNations last left the player world in; a lower civLevel since means a setback. */
  private nationEra = 0;
  /**
   * Biology events that are not simple phase advances: stalls, mass extinctions,
   * explosive radiations and biosphere catastrophes.
   */
  onLifeEvent: ((
    msg: string,
    kind: 'stall' | 'collapse' | 'burst' | 'catastrophe',
    isPlayer: boolean,
  ) => void) | null = null;
  onWarEvent: ((attacker: string, defender: string) => void) | null = null;
  onCosmicEvent: ((type: string, system: string) => void) | null = null;
  onTickUpdate: ((tick: number) => void) | null = null;
  onStarSelected: ((star: StarBody) => void) | null = null;
  onBigBangComplete: (() => void) | null = null;
  onPlanetCatastrophe: ((mergedWith: string) => void) | null = null;

  /**
   * The player's civilisation abandoned a doomed star and began again elsewhere.
   * Their home world is now the destination — the UI has to follow them there.
   */
  onPlayerExodus: ((fromName: string, toName: string) => void) | null = null;
  onPlanetFormationProgress: ((stage: PlanetFormationStage) => void) | null = null;
  onPlayerLifeEmerged: (() => void) | null = null;
  onPlayerReligionMoment: (() => void) | null = null;
  onCosmicWarning: ((event: CosmicEvent, star: StarBody) => void) | null = null;
  onCosmicStrike: ((event: CosmicEvent, star: StarBody) => void) | null = null;
  onWarStart:    ((war: War, attacker: StarBody, defender: StarBody) => void) | null = null;
  onWarProgress: ((war: War, attacker: StarBody, defender: StarBody, msg: string) => void) | null = null;
  onWarEnd:      ((war: War, attacker: StarBody, defender: StarBody, attackerWon: boolean) => void) | null = null;
  onReligionEvent: ((msg: string) => void) | null = null;
  onMeteorLifeSeeded: ((planetName: string) => void) | null = null;
  /** The home world finished forming and is now its destiny type. */
  onPlanetFormationComplete: ((destiny: DestinyType) => void) | null = null;
  /** Life reached the home world while it was still forming (dormant until done). */
  onFormationLifeArrived: ((source: FormationLifeSource, from: string) => void) | null = null;
  onWarBattle: ((warId: number, attackerName: string, defenderName: string, attackerDice: number[], attackerColor: string, phase: string) => void) | null = null;
  onLeaderMessage: ((leader: Leader, eventContext: string, starId: number) => void) | null = null;
  // Phase / evolution callbacks
  onBioPhaseAdvance: ((phase: BiologyPhase, starName: string) => void) | null = null;
  onCodexMilestone:  ((entry: Omit<CodexEntry, 'body'>) => void) | null = null;
  onDNAPointEarned:  ((total: number) => void) | null = null;
  /** DNA granted for a visible event, with the reason to show the player. */
  onDNAAward:        ((amount: number, reason: string) => void) | null = null;
  /** Natural drift changed the signature species (an unlocked trait). */
  onSignatureDrift:  ((event: EvolutionEvent) => void) | null = null;
  /** A free card dropped into the evolution queue on its own. */
  onSpontaneousMutation: ((mutationId: string) => void) | null = null;
  /** The signature lineage was lost and a descendant took its place. */
  onSignatureSucceeded:  ((newName: string) => void) | null = null;
  onTechPointEarned: ((total: number) => void) | null = null;
  onTerraformProgress: ((stage: PlanetFormationStage, targetType: Planet['type']) => void) | null = null;
  onTerraformComplete: ((fromType: Planet['type'], toType: Planet['type'], planetName: string) => void) | null = null;
  onFirstContact: ((npcStar: StarBody) => void) | null = null;
  onCosmicSignal:  ((civName: string, starId: number) => void) | null = null;
  onSignalDecoded: ((civName: string, message: string) => void) | null = null;
  onMutationEvent:   ((event: EvolutionEvent) => void) | null = null;
  onSpeciationEvent: ((event: EvolutionEvent) => void) | null = null;
  onExtinctionEvent: ((event: EvolutionEvent) => void) | null = null;
  /** Fired when a Gemini-generated culture replaces the procedural one. */
  onCultureGenerated: ((starId: number, civ: Civilization) => void) | null = null;

  /**
   * Set by the host (main.ts) whenever it (re)creates its GeminiService — e.g.
   * on new game, on load, or when the player saves a new API key in Settings.
   * Left null offline; `ensureCivilization` only ever reads it, so the tick
   * loop never has to know whether it is set.
   */
  geminiService: GeminiService | null = null;

  // Dragging
  private isDragging = false;
  private dragStart = { x: 0, y: 0 };
  private dragCamStart = { x: 0, y: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;

    this.fogCanvas = document.createElement('canvas');
    this.fogCanvas.width = canvas.width;
    this.fogCanvas.height = canvas.height;
    this.fogCtx = this.fogCanvas.getContext('2d')!;

    this.setupInput();
    window.addEventListener('resize', () => this.onResize());
    this.onResize();
  }

  /**
   * Build a fresh star at rest. Used both by the Big Bang and by star formation,
   * so newborn stars are indistinguishable from primordial ones.
   */
  private createStar(x: number, y: number): StarBody {
    // Hoisted so planets can be stamped with a genome seed derived from it.
    // Taking the counter BEFORE generatePlanets is safe: that method never
    // reads starIdCounter, and it does not touch this.rng either, so the RNG
    // sequence — and therefore every existing world — is unchanged.
    const starId = this.starIdCounter++;
    const mass = this.rng.nextFloat(1, 8);
    const planets = this.generatePlanets(this.stats, mass);
    planets.forEach((p, i) => { p.genomeSeed = genomeSeedFor(starId, i); });
    // Belts are optional and density varies — not every system has one.
    const hasBelt = planets.length >= 2 && this.rng.chance(0.22 + this.stats.entropy / 55);
    return {
      id: starId,
      x, y, vx: 0, vy: 0,
      mass,
      radius: 2.5 + mass * 0.8,
      temperature: this.rng.nextFloat(3000, 30000),
      age: 0,
      hasLife: false,
      civLevel: 0,
      civName: this.generateCivName(),
      planets,
      explorationRadius: 30,
      isPlayerStar: false,
      isDead: false,
      asteroidBelt: hasBelt,
      asteroidBeltDensity: hasBelt ? this.rng.nextFloat(0.2, 1.0) : 0,
      lastEventTick: 0,
      formationStage: null,
      formationTick: 0,
      terraformStage: null,
      terraformTick: 0,
      terraformTargetType: null,
      religionName: '',
      religionDevotion: 0,
      biologyPhase: 'microbial',
      bioPhaseProgress: 0,
      dna: { ...DEFAULT_DNA_BRANCH },
    };
  }

  /**
   * Turn a star into a visible remnant with husk planets.
   * Used for primordial burnouts and post-supernova / merger corpses.
   */
  private makeRemnant(star: StarBody, reason: 'primordial' | 'supernova' | 'merger'): void {
    star.isDead = true;
    star.hasLife = false;
    star.civLevel = 0;
    star.biologyPhase = 'microbial';
    star.bioPhaseProgress = 0;
    star.religionName = '';
    star.religionDevotion = 0;
    star.formationStage = null;
    star.isNewSystem = false;

    if (star.mass >= 6) {
      star.remnantKind = this.rng.chance(0.55) ? 'black_hole' : 'neutron';
    } else if (star.mass >= 3.5) {
      star.remnantKind = this.rng.chance(0.4) ? 'neutron' : 'white_dwarf';
    } else {
      star.remnantKind = 'white_dwarf';
    }

    if (star.remnantKind === 'black_hole') {
      star.radius = Math.max(1.1, star.radius * 0.32);
      star.temperature = 1800;
      star.mass = Math.max(star.mass, 8);
    } else if (star.remnantKind === 'neutron') {
      star.radius = Math.max(1.3, star.radius * 0.38);
      star.temperature = 14000;
    } else {
      star.radius = Math.max(1.5, star.radius * 0.42);
      star.temperature = 9500;
    }

    this.huskPlanets(star);
    if (reason !== 'primordial') {
      this.invalidateCulture(star, 'annihilation');
    }
  }

  /** Scorch / freeze every world in a dead system into ash husks. */
  private huskPlanets(star: StarBody): void {
    const huskColors = ['#5a5854', '#6e6a62', '#4a4844', '#7a756c', '#3d3c3a', '#8a8478'];
    for (const p of star.planets) {
      p.isDead = true;
      p.hasLife = false;
      p.biosphere = 0;
      if (p.type === 'gas' || p.type === 'ocean' || p.type === 'lava') {
        p.type = this.rng.chance(0.35) ? 'ice' : 'rocky';
      }
      p.color = this.rng.pick(huskColors);
      p.dna = { climate: 'frozen', oceans: 'barren', chaos: 'serene' };
      p.radius = Math.max(0.35, p.radius * 0.88);
      for (const m of p.moons) {
        // Moons stay, but read as cold rock.
        m.kind = m.kind === 'ice' ? 'ice' : 'rock';
      }
    }
  }

  /**
   * Seed a stellar nursery where a star was lost.
   *
   * Stars were only ever destroyed — by mergers and supernovae — and nothing
   * ever created them, so a long game decayed to a handful of stars and then to
   * one. Returning that gas to the medium and letting it condense again closes
   * the cycle and keeps the cosmos alive, which is rather the point of the game.
   */
  private seedNursery(x: number, y: number, richness: number): void {
    if (this.phase !== 'settled') return;
    const count = Math.max(0, Math.round(richness));
    if (count <= 0) return;
    this.stellarNurseries.push({
      x, y,
      starsLeft: count,
      nextSpawnTick: this.tick + this.rng.nextInt(4000, 14000),
    });
  }

  /** Condense stellar nurseries into new stars over time. */
  private updateStarFormation(): void {
    if (this.phase !== 'settled') return;

    for (let i = this.stellarNurseries.length - 1; i >= 0; i--) {
      const n = this.stellarNurseries[i];
      if (this.tick < n.nextSpawnTick) continue;

      if (n.starsLeft <= 0) { this.stellarNurseries.splice(i, 1); continue; }

      // Scatter far from the collapse site AND away from living neighbours —
      // without a separation check newborns land on top of survivors and either
      // instantly merge or look stacked (especially with larger pixel suns).
      let nx = n.x, ny = n.y;
      let bestX = nx, bestY = ny, bestMin = -1;
      const live = this.stars.filter(s => !s.isDead);
      for (let attempt = 0; attempt < 64; attempt++) {
        const angle = this.rng.nextFloat(0, Math.PI * 2);
        const dist  = this.rng.nextFloat(MIN_STAR_SEPARATION, MIN_STAR_SEPARATION * 2.4);
        let tx = n.x + Math.cos(angle) * dist;
        let ty = n.y + Math.sin(angle) * dist;

        const cx = WORLD_SIZE / 2, cy = WORLD_SIZE / 2;
        const dr = Math.hypot(tx - cx, ty - cy);
        if (dr > UNIVERSE_RADIUS) {
          tx = cx + (tx - cx) / dr * UNIVERSE_RADIUS * 0.95;
          ty = cy + (ty - cy) / dr * UNIVERSE_RADIUS * 0.95;
        }

        let minD = Infinity;
        for (const s of live) {
          const d = Math.hypot(tx - s.x, ty - s.y);
          if (d < minD) minD = d;
        }
        if (minD >= MIN_STAR_SEPARATION) {
          bestX = tx; bestY = ty; bestMin = minD;
          break;
        }
        if (minD > bestMin) {
          bestMin = minD;
          bestX = tx; bestY = ty;
        }
      }
      nx = bestX; ny = bestY;

      const star = this.createStar(nx, ny);

      // Join the nearest galaxy and take up a proper galactic orbit — not a
      // throw toward the universe centre (that was the old "fall inward" path).
      let bestGal = this.galaxies[0];
      let bestD = Infinity;
      for (const g of this.galaxies) {
        const d = Math.hypot(nx - g.x, ny - g.y);
        if (d < bestD) { bestD = d; bestGal = g; }
      }
      if (bestGal) {
        star.galaxyId = bestGal.id;
        bestGal.starIds.push(star.id);
        star.orbitRadius = Math.max(28, Math.min(bestD, bestGal.radius * 0.95));
        star.orbitAngle = Math.atan2(ny - bestGal.cy, nx - bestGal.cx);
        this.setCircularOrbit(star, bestGal, this.rng.nextFloat(0.9, 1.15));
        this.placeStarOnOrbit(star, bestGal, star.orbitAngle, star.age);
      }

      // A system condensed out of a supernova remnant is NEW. It runs the same
      // young-world sequence the player's own planet does — magma, cooling,
      // volcanic, atmosphere, ice age, primordial — rather than appearing
      // fully formed.
      star.formationStage = 'magma';
      star.formationTick = this.tick;
      star.isNewSystem = true;
      star.newSystemUntil = this.tick + NEW_SYSTEM_GRACE;
      star.hasLife = false;

      this.stars.push(star);

      // Ignition glow
      this.nebulae.push({
        x: nx, y: ny, radius: 3, maxRadius: 26, alpha: 0.5,
        r: 200, g: 190, b: 255, age: 0,
      });

      n.starsLeft--;
      n.nextSpawnTick = this.tick + this.rng.nextInt(5000, 16000);

      if (this.isStarKnownToPlayer(star)) {
        this.onCivEvent?.(`A new star has ignited in the ${star.civName} region.`);
      }
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  init(stats: UniverseStats, seed: string): void {
    this.stats = stats;
    this.rng = new SeedRNG(seed);
    this.tick0Seed = SeedRNG.hashString(seed);
    runtimeState.playerNations = null;
    this.nationEra = 0;
    this.tick = 0;
    this.phase = 'inflation';
    this.stars = [];
    this.nebulae = [];
    this.asteroids = [];
    this.fleets = [];
    this.exploredAreas = [];
    this.playerFogIndex = -1;
    this.fogCacheValid = false;
    this.fogCacheKey = '';
    this.cameraFollowHome = true;
    this.cosmicEvents = [];
    this.activeWars = [];
    this.supernovaFlashes = [];
    this.galaxies = [];
    this.galaxySpriteCache.clear();
    this.newSystemsFormed = 0;
    this.newSystemsBornAlive = 0;
    this.cosmicEventIdCounter = 0;
    this.warIdCounter = 0;
    this.nextCosmicCheckTick = 2000;
    this.starIdCounter = 0;
    this.stellarNurseries = [];
    this.spawnTargets.clear();

    // Roll this universe's DNA branches here rather than in the UI layer.
    // They were previously set only by `launchBigBang`, so any engine created
    // another way — a loaded save, a headless run — had NO branches: NPC DNA
    // came out empty and every branch effect read as zero.
    this.ensureBranches(seed);
    // These live on gameState rather than the engine, and nothing was clearing
    // them: starting a second game in the same session inherited the previous
    // universe's leaders and faction flags.
    gameState.leaders = [];
    gameState.leaderMemories = [];
    gameState.factionFlags = {};
    // Culture is per-universe and keyed by starId, so stale entries would attach
    // to whichever star happened to reuse the id (ROADMAP M20b).
    gameState.civilizations = {};
    // The biosphere and species list were likewise never cleared, so a second
    // game in one session inherited the previous world's oxygen, biodiversity
    // and entire species roster.
    gameState.playerSpecies = [];
    gameState.playerBiosphere = { ...DEFAULT_BIOSPHERE };
    // Signature species: nothing yet; this universe's mutation cards rolled now.
    gameState.signatureSpeciesId = null;
    gameState.mutationsOwned = [];
    gameState.mutationQueue = [];
    gameState.mutationGifts = [];
    gameState.speciesForms = [];
    gameState.signatureBiomes = [];
    gameState.offeredMutations = rollUniverseMutations(seed);

    // Denser census now that cull + wall-clock pacing hold 120Hz — life roll
    // still sets the pool; morph weights how that pool splits across galaxies.
    const starCount = Math.floor(18 + stats.life * 2.1);   // 20–60 stars
    const cx = WORLD_SIZE / 2, cy = WORLD_SIZE / 2;

    // Size the blast so the universe lands INSIDE its boundary. Use most of the
    // disc so galaxies can sit far apart with void between them.
    const spreadFrac = 0.58 + (stats.entropy / 20) * 0.36;       // 0.58 … 0.94
    const maxDrift   = UNIVERSE_RADIUS * spreadFrac;

    // ── Galaxies first, stars second ────────────────────────────────────────
    // The Big Bang throws its matter toward a handful of centres rather than
    // scattering it evenly, so what condenses out is galaxies. Without this
    // there is no structure above "star" for a galaxy tier to show.
    // FEW, SMALL, FAR APART. Galaxy radius is a stellar-density control — too
    // tight and gravity cascades; too large and envelopes merge into one blob.
    // After M25 the sim is healthy; this pass makes the *look* match real space:
    // vast empty stretches between galaxies, and sparse systems inside each.
    const galaxyCount = this.rng.nextInt(3, 4);
    // Centres ride a wide ring so neighbours sit across real void.
    const ringR = maxDrift * this.rng.nextFloat(0.72, 0.88);
    // Room for denser census under MIN_STAR_SEPARATION (relax may still grow).
    const envelopeCap = ringR * Math.sin(Math.PI / galaxyCount) * 0.74;

    for (let gi = 0; gi < galaxyCount; gi++) {
      const ga = (gi / galaxyCount) * Math.PI * 2 + this.rng.nextFloat(-0.18, 0.18);
      const gr = ringR * this.rng.nextFloat(0.90, 1.08);
      // Real sky mix, biased toward spirals so the cosmos reads as spiral/barred
      // islands (the look we want) rather than soft elliptical blobs.
      const morphRoll = this.rng.next();
      const morph: GalaxyMorph =
        morphRoll < 0.48 ? 'barred' :
        morphRoll < 0.78 ? 'spiral' :
        morphRoll < 0.88 ? 'lenticular' :
        morphRoll < 0.95 ? 'elliptical' : 'irregular';
      const armCount = morph === 'spiral' || morph === 'barred'
        ? this.rng.nextInt(2, 4) : 0;
      const gx = cx + Math.cos(ga) * gr;
      const gy = cy + Math.sin(ga) * gr;
      const gRadius = Math.min(
        envelopeCap,
        maxDrift * 0.48,
        Math.max(320, maxDrift - gr),
      ) * this.rng.nextFloat(0.92, 1.0);
      this.galaxies.push({
        id: gi,
        name: this.generateGalaxyName(morph),
        x: gx,
        y: gy,
        cx: gx,
        cy: gy,
        radius: gRadius,
        tRadius: gRadius,
        color: ['#8ea8ff', '#ffc9a0', '#c7a0ff', '#a0ffd8', '#ffa0c8'][gi % 5],
        tilt: this.rng.nextFloat(0, Math.PI),
        starIds: [],
        morph,
        armCount,
        armPitch: this.rng.nextFloat(0.18, 0.42),
        barLength: morph === 'barred' ? this.rng.nextFloat(0.35, 0.55) : 0,
        // Mostly face-on-ish with some tilt — pixel spirals read better that way.
        discFlat: morph === 'elliptical' || morph === 'lenticular'
          ? this.rng.nextFloat(0.70, 0.95)
          : this.rng.nextFloat(0.42, 0.72),
      });
    }

    // Targets already chosen in each galaxy — used to enforce MIN_STAR_SEPARATION
    // so the Big Bang does not aim two stars at the same neighbourhood.
    const placedTargets: Array<{ x: number; y: number; galaxyId: number }> = [];
    const morphWeights = this.galaxies.map(g => galaxyMorphWeight(g.morph));
    const weightSum = morphWeights.reduce((a, b) => a + b, 0);

    for (let i = 0; i < starCount; i++) {
      // Morph-weighted membership — ellipticals denser, irregulars sparse.
      let pick = this.rng.next() * weightSum;
      let host = this.galaxies[0];
      for (let gi = 0; gi < this.galaxies.length; gi++) {
        pick -= morphWeights[gi];
        if (pick <= 0) { host = this.galaxies[gi]; break; }
      }
      let pos = this.pickSeparatedPoint(host, placedTargets);
      if (!pos) {
        for (const g of this.galaxies) {
          if (g.id === host.id) continue;
          pos = this.pickSeparatedPoint(g, placedTargets);
          if (pos) { host = g; break; }
        }
      }
      if (!pos) pos = this.sampleGalaxyPoint(host);

      const target = { x: pos.x, y: pos.y, galaxyId: host.id };
      placedTargets.push(target);

      // Aim the star at that destination, so inflation resolves into clumps.
      const dx = target.x - cx, dy = target.y - cy;
      const dist = Math.hypot(dx, dy) || 1;
      const outwardForce = dist / INFLATION_DRIFT;
      const angle = Math.atan2(dy, dx);
      const spinForce = outwardForce * this.rng.nextFloat(0.04, 0.14);

      const star = this.createStar(cx + this.rng.nextFloat(-3, 3), cy + this.rng.nextFloat(-3, 3));
      this.spawnTargets.set(star.id, target);
      star.vx = Math.cos(angle) * outwardForce - Math.sin(angle) * spinForce;
      star.vy = Math.sin(angle) * outwardForce + Math.cos(angle) * spinForce;
      star.galaxyId = host.id;
      host.starIds.push(star.id);
      this.stars.push(star);
    }

    for (const gal of this.galaxies) {
      this.relaxStarTargets(gal, placedTargets, envelopeCap);
    }

    // Mark player's star (first one)
    this.stars[0].isPlayerStar = true;
    this.stars[0].temperature = 5800; // Sun-like
    this.stars[0].civLevel = 0;
    this.playerStarId = 0;

    // Primordial corpses — entropy-weighted (~8–15%). Never the player's sun.
    const remnantChance = 0.08 + (stats.entropy / 20) * 0.07;
    for (const s of this.stars) {
      if (s.isPlayerStar) continue;
      if (this.rng.chance(remnantChance)) this.makeRemnant(s, 'primordial');
    }

    // Pre-seed NPC biospheres. How many, and how far along each one is, are both
    // rolls — the starting universe should not always look the same. Some games
    // begin next door to a spacefaring empire; some begin in near-total silence.
    const seedBudget = this.rng.nextInt(0, Math.max(1, Math.floor(stats.life / 2)));
    const candidates = this.stars.slice(1).filter(s => !s.isDead);
    // Habitable systems are strongly preferred, but not exclusively.
    candidates.sort((a, b) =>
      (this.habitabilityOf(b) + this.rng.nextFloat(0, 0.5)) -
      (this.habitabilityOf(a) + this.rng.nextFloat(0, 0.5)));

    for (let p = 0; p < Math.min(seedBudget, candidates.length); p++) {
      const s = candidates[p];
      if (this.habitabilityOf(s) < 0.15) continue;
      this.igniteLife(s, s.bestPlanetIndex ?? 0);

      // Spread the head start across the whole ladder, weighted toward the
      // early phases — most worlds that have life have only simple life.
      const roll = this.rng.next();
      const startIdx = roll < 0.34 ? 0 : roll < 0.55 ? 1 : roll < 0.70 ? 2
                     : roll < 0.82 ? 3 : 4;
      s.biologyPhase = BIO_PHASE_SEQUENCE[startIdx];

      if (s.biologyPhase === 'intelligent') {
        s.civLevel = this.rng.nextInt(0, 4);
        if (this.rng.chance(0.5)) {
          s.religionName = this.generateReligionName();
          s.religionDevotion = this.rng.nextFloat(0.1, 0.5);
        }
        // Leaders and faction flags were only created on a tech-tier ADVANCE, so
        // civilisations that exist from tick 0 had neither — which is why no
        // flags ever appeared in a fresh universe.
        this.spawnLeaderForStar(s);
        this.ensureCivilization(s);
      }
    }

    // Set up player star's planets — all known via naked eye, home world fully surveyed
    const ps0 = this.stars[0];
    const numerals = ['I','II','III','IV','V'];
    ps0.planets.forEach((p, i) => {
      p.name = `${ps0.civName} ${numerals[i] ?? String(i + 1)}`;
      p.discovery = 'telescope'; // Your civilization already knows its own solar system
    });
    // The home world must be somewhere life can plausibly start — the whole game
    // is watching one world climb. Previously this fell back to planets[0] when
    // the system happened to roll no rocky planet, which could hand the player an
    // ice or gas giant to shepherd. Pick a viable world, or make one.
    //
    // Its DESTINY — what it is meant to finish as — is rolled from the seed
    // (Formation.ts). Setup DNA no longer picks it; only a lab override does.
    const destinyRng = this.rng.fork(`destiny_${seed}`);
    const destiny: DestinyType = gameState.destinyOverride ?? rollDestiny(() => destinyRng.next());
    const preferred: Planet['type'] = destiny;

    let playerIdx = ps0.planets.findIndex(p => p.type === preferred);
    if (playerIdx < 0) playerIdx = ps0.planets.findIndex(p => p.type === 'ocean' || p.type === 'rocky');
    if (playerIdx < 0) {
      // No habitable world in the roster — retype the innermost one.
      playerIdx = 0;
      ps0.planets[0].type = preferred;
      ps0.planets[0].color = preferred === 'ocean' ? '#2266aa' : '#aa8866';
    }
    const playerPlanet = ps0.planets[playerIdx];
    if (playerPlanet) {
      if (gameState.playerPlanetName) playerPlanet.name = gameState.playerPlanetName;
      // Keep orrery / surface / diorama on the same DNA the player answered.
      if (gameState.playerPlanetDNA) playerPlanet.dna = { ...gameState.playerPlanetDNA };
      // The player's world is guaranteed to be a good one — this is the world the
      // whole game is about — but it still gets its own chemistry and tempo, so
      // no two playthroughs climb the ladder at the same speed.
      // Habitable-band semi-major; near-circular so home is easy to read.
      playerPlanet.orbitalRadius = 18 + (ps0.temperature - 3000) / 27000 * 28;
      playerPlanet.eccentricity = this.rng.nextFloat(0, 0.08);
      playerPlanet.periapsisAngle = this.rng.nextFloat(0, Math.PI * 2);
      playerPlanet.type = preferred;
      playerPlanet.destinyType = destiny;
      ps0.habitability = undefined;
      ps0.bestPlanetIndex = playerIdx;
      playerPlanet.discovery = 'landing'; // Home world — fully surveyed
      if (gameState.skipFormation) {
        // Lab / test path: the world starts finished and alive (old behaviour).
        this.igniteLife(ps0, playerIdx);
        playerPlanet.biosphere = 0.8;
        playerPlanet.color = '#3a8f3a';
      } else {
        // Birth: molten rock, no life. The world walks its destiny's ladder
        // over a budget of 1-3 player days before it becomes what it is.
        this.beginHomeFormation(ps0, playerPlanet, destiny,
          rollFormationBudget(() => destinyRng.next()));
      }
      // The player always starts from familiar chemistry; exotic biospheres are
      // something to discover elsewhere, not something to be saddled with.
      ps0.lifeArchetype = 'carbon_water';
      ps0.bioTempo = rollBioTempo(this.rng.fork(`player_tempo_${seed}`), 'carbon_water');
    }

    // Reveal player's start area
    this.exploredAreas.push({ x: cx, y: cy, r: 80 });

    // Big Bang shrapnel burst — debris from the singularity
    const numShrapnel = Math.floor(45 + stats.entropy * 5);
    for (let i = 0; i < numShrapnel; i++) {
      const astAngle = this.rng.nextFloat(0, Math.PI * 2);
      const astSpeed = this.rng.nextFloat(3, 14);
      this.asteroids.push({
        x: cx + this.rng.nextFloat(-3, 3),
        y: cy + this.rng.nextFloat(-3, 3),
        vx: Math.cos(astAngle) * astSpeed,
        vy: Math.sin(astAngle) * astSpeed,
        radius: this.rng.nextFloat(0.3, 1.2),
        alive: true,
      });
    }
  }

  // ── Simulation Loop ────────────────────────────────────────────────────────

  start(): void {
    this.running = true;
    this.paceToWallClock = true;
    this.lastFrameTime = performance.now();
    this.lastPresentTime = 0;
    this.animHandle = requestAnimationFrame(this.loop.bind(this));
  }

  stop(): void {
    this.running = false;
    this.paceToWallClock = false;
    this.lastFrameTime = 0;
    this.lastPresentTime = 0;
    if (this.animHandle) cancelAnimationFrame(this.animHandle);
  }

  /**
   * Cap presented frames per second. `0` = unlimited (match display refresh).
   * RAF still ticks every vsync; update/render are skipped until the interval elapses.
   */
  setTargetFps(fps: number): void {
    this.targetFps = fps > 0 ? fps : 0;
  }

  getTargetFps(): number {
    return this.targetFps;
  }

  /**
   * Bake galaxy envelopes (and anything else that hitchs on first paint)
   * before the inflation loop starts. Safe to call after init(); does not
   * start the sim. Yields between galaxies so a loading screen can paint.
   */
  async warmVisualCaches(
    onProgress?: (done: number, total: number, label: string) => void,
  ): Promise<void> {
    const gals = this.galaxies;
    const total = Math.max(1, gals.length);
    for (let i = 0; i < gals.length; i++) {
      this.getGalaxySprite(gals[i]);
      onProgress?.(i + 1, total, `Mapping ${gals[i].name}`);
      await new Promise<void>(r => setTimeout(r, 0));
    }
    onProgress?.(total, total, 'Cosmos ready');
  }

  private loop(): void {
    if (!this.running) return;

    // Frame-rate cap: keep RAF on vsync, but only present when enough wall time
    // has passed. Skipped frames do not advance sim/anim (wall-clock pacing stays).
    const wake = performance.now();
    if (this.targetFps > 0 && this.lastPresentTime > 0) {
      const minDt = 1000 / this.targetFps;
      if (wake - this.lastPresentTime < minDt - 0.5) {
        this.animHandle = requestAnimationFrame(this.loop.bind(this));
        return;
      }
    }
    this.lastPresentTime = wake;

    const t0 = performance.now();
    const dtMs = this.pullFrameDeltaMs();
    this.update(dtMs);
    this.render(dtMs);
    const frameMs = performance.now() - t0;
    this.fpsFrameMsSum += frameMs;
    this.fpsFrameCount++;
    const now = performance.now();
    if (now - this.fpsWindowStart >= 500) {
      this.currentFps = this.fpsFrameCount / ((now - this.fpsWindowStart) / 1000);
      this.currentFrameMs = this.fpsFrameMsSum / Math.max(1, this.fpsFrameCount);
      this.fpsWindowStart = now;
      this.fpsFrameMsSum = 0;
      this.fpsFrameCount = 0;
      this.onFpsSample?.(this.currentFps, this.currentFrameMs);
    }
    this.animHandle = requestAnimationFrame(this.loop.bind(this));
  }

  /** Wall-clock dt while the RAF loop runs; clamp spikes after tab blurs. */
  private pullFrameDeltaMs(): number {
    const now = performance.now();
    if (!this.lastFrameTime) {
      this.lastFrameTime = now;
      return 1000 / 60;
    }
    const dt = now - this.lastFrameTime;
    this.lastFrameTime = now;
    return Math.min(50, Math.max(0, dt));
  }

  update(dtMs?: number): void {
    const speed = (window as unknown as Record<string, unknown>)['eternalSpeed'] as number ?? 1;

    // Headless tools call update() in a tight loop without start(): treat each
    // call as one 60Hz frame (old contract). The live RAF loop passes real dt.
    const dt = this.paceToWallClock ? (dtMs ?? this.pullFrameDeltaMs()) : (1000 / 60);

    // Big Bang phases run at ~60 ticks/sec wall-clock so a 240Hz display does
    // not finish inflation in one second. Settled 1× is ~1 tick/sec — intentional
    // long-eras pacing (see CIV_TICK_RATE comments).
    // Floor with a tiny epsilon: 240 × (1/240) underflows 1.0 in IEEE float.
    const takeTicks = (): number => {
      const n = Math.floor(this.tickAccumulator + 1e-9);
      this.tickAccumulator -= n;
      return n;
    };
    let ticksThisFrame: number;
    if (speed <= 0) {
      ticksThisFrame = 0;
    } else if (this.phase !== 'settled') {
      this.tickAccumulator += dt / 1000 * 60;
      ticksThisFrame = takeTicks();
    } else if (this.paceToWallClock) {
      this.tickAccumulator += speed * (dt / 1000);
      ticksThisFrame = takeTicks();
    } else {
      this.tickAccumulator += speed / 60;
      ticksThisFrame = takeTicks();
    }

    // Snap orbits to the last committed sim tick before collisions / logic run.
    // (Previous frame may have left positions at a fractional display offset.)
    if (this.phase === 'settled' || this.phase === 'gravity') {
      this.syncOrbitPositions(0);
    }

    for (let s = 0; s < ticksThisFrame; s++) {
      this.tick++;
      this.onTickUpdate?.(this.tick);

      if (this.phase === 'inflation') {
        this.updateInflation();
        if (this.tick >= INFLATION_TICKS) {
          this.phase = 'gravity';
          // Inflation aimed stars at their galaxies; now put them on circular
          // orbits so they swirl instead of falling into each other.
          this.assignGalacticOrbits();
        }
      } else {
        this.updateGravity();
        this.updatePlanetFormation();
        if (this.tick % 600 === 0) this.updateGalaxies();
        this.updateTerraforming();
        if (this.phase === 'gravity' && this.tick >= INFLATION_TICKS + 300) {
          this.phase = 'settled';
          this.settledSinceTick = this.tick;
          this.settledSinceAnimTick = this.animTick;
          this.onBigBangComplete?.();
          // Dramatic zoom in on player's star system + reveal it in fog
          const ps = this.getPlayerStar();
          if (ps) {
            this.camera.tx = ps.x;
            this.camera.ty = ps.y;
            // Close enough that the home world reads as a world (the follow
            // then centres it); the system stays in view around it.
            this.camera.ts = 8.5;
            this.cameraFollowHome = true;
            // Punch a large hole in the fog at the player's actual settled position
            this.exploredAreas.push({ x: ps.x, y: ps.y, r: 300 });
            this.playerFogIndex = this.exploredAreas.length - 1;
          }
        }
      }

      this.updateNebulae();
      this.updateStarFormation();
      this.updateAsteroids();
      this.updateCivilizations();
      this.updateCosmicSignals();
      this.updateFleets();
      this.updateWars();
      this.updateOrbitalFleets();
      this.updateCosmicEvents();
      this.updateReligions();
    }

    // Sub-tick orbit placement — smooth between sim ticks at high game-speed.
    // Galaxy centres stay fixed (census must not drag the kinematic origin).
    if (this.phase === 'settled' || this.phase === 'gravity') {
      this.syncOrbitPositions(this.tickAccumulator);
      this.smoothGalaxyRadii();
      this.updatePlayerSightAndCamera();
    }

    // Camera lerp
    this.camera.x += (this.camera.tx - this.camera.x) * 0.06;
    this.camera.y += (this.camera.ty - this.camera.y) * 0.06;
    this.camera.scale += (this.camera.ts - this.camera.scale) * 0.06;
  }

  /**
   * Keep the home fog bubble on the moving player star, and soft-follow the
   * camera while zoomed into galaxy/system (unless the player has panned away).
   */
  private updatePlayerSightAndCamera(): void {
    const ps = this.getPlayerStar();
    if (!ps || ps.isDead) return;

    const sightR = Math.max(300, ps.explorationRadius);
    if (this.playerFogIndex >= 0 && this.playerFogIndex < this.exploredAreas.length) {
      const hole = this.exploredAreas[this.playerFogIndex];
      hole.x = ps.x;
      hole.y = ps.y;
      hole.r = Math.max(hole.r, sightR);
    } else if (this.phase === 'settled') {
      this.exploredAreas.push({ x: ps.x, y: ps.y, r: sightR });
      this.playerFogIndex = this.exploredAreas.length - 1;
    }

    if (!this.cameraFollowHome || this.isDragging) return;
    // Universe view is a map overview — don't yank the camera there.
    if (this.zoomTier === 'universe') return;

    let tx = ps.x, ty = ps.y;
    if (this.zoomTier === 'galaxy') {
      const gal = this.galaxies.find(g => g.id === ps.galaxyId);
      if (gal) { tx = gal.cx; ty = gal.cy; }
    } else {
      // System and planet zoom follow the home WORLD round its orbit, not
      // its sun (play report: after the Big Bang the view sat on the star).
      const home = this.homeWorld(ps);
      if (home) {
        const o = planetOffsetFromStar(home, this.animTick);
        tx = ps.x + o.x; ty = ps.y + o.y;
      }
    }
    // Snappier than the general camera lerp so the home star doesn't drift
    // into the fog while the galaxy swirls at high speed.
    const k = 0.18;
    this.camera.tx += (tx - this.camera.tx) * k;
    this.camera.ty += (ty - this.camera.ty) * k;
  }

  /**
   * Keep a star inside the universe DISC.
   *
   * The old code clamped x and y independently, which pinned any star that flew
   * far enough to one of four straight walls and made the cosmos spread out into
   * a visible square with dense corners. Here a star that reaches the edge is set
   * back onto the circle and loses only its outward radial velocity — its
   * tangential motion is preserved, so it slides along the rim and settles
   * instead of sticking to a wall.
   */
  private constrainToUniverse(star: StarBody): void {
    const cx = WORLD_SIZE / 2, cy = WORLD_SIZE / 2;
    const dx = star.x - cx, dy = star.y - cy;
    const d = Math.hypot(dx, dy);
    if (d <= UNIVERSE_RADIUS || d === 0) return;

    const nx = dx / d, ny = dy / d;
    star.x = cx + nx * UNIVERSE_RADIUS;
    star.y = cy + ny * UNIVERSE_RADIUS;

    const radialV = star.vx * nx + star.vy * ny;
    if (radialV > 0) {
      star.vx -= radialV * nx;
      star.vy -= radialV * ny;
    }
  }

  private updateInflation(): void {
    // Zoom camera out as the explosion expands: close-up for first 20 ticks, then pull back
    if (this.tick === 20) {
      this.camera.ts = 0.14;
    }

    for (const star of this.stars) {
      star.vx *= INFLATION_DECAY;
      star.vy *= INFLATION_DECAY;
      star.x += star.vx;
      star.y += star.vy;
      this.constrainToUniverse(star);
      star.age++;
    }
    // Skip collision checks during inflation — stars launch from the same point
    // and would instantly cascade-merge into one body. Let them spread first.
  }

  /**
   * Put every living star on a near-circular orbit around its galaxy centre.
   *
   * Called once when inflation ends. Without this, residual Big-Bang radial
   * velocities plus pairwise gravity make every system drift into the heaviest
   * neighbour — the opposite of how a galaxy holds together.
   */
  private assignGalacticOrbits(): void {
    for (const star of this.stars) {
      // Remnants still ride the disc — only skip unbound corpses with no galaxy.
      if (star.galaxyId == null) continue;
      const gal = this.galaxies.find(g => g.id === star.galaxyId);
      if (!gal) continue;
      // Inflation is a visual throw from the origin; land on the spaced target
      // so ballistic spin cannot collapse neighbouring systems.
      const target = this.spawnTargets.get(star.id);
      if (target) {
        star.x = target.x;
        star.y = target.y;
      }
      const r = Math.hypot(star.x - gal.cx, star.y - gal.cy);
      star.orbitRadius = Math.max(28, Math.min(r, gal.radius * 0.95));
      star.orbitAngle = Math.atan2(star.y - gal.cy, star.x - gal.cx);
      this.setCircularOrbit(star, gal, this.rng.nextFloat(0.92, 1.08));
      this.placeStarOnOrbit(star, gal, star.orbitAngle!, star.age);
    }
    this.spawnTargets.clear();
  }

  /** Tangential velocity for a circular orbit at the star's current radius. */
  private setCircularOrbit(star: StarBody, gal: Galaxy, speedScale = 1): void {
    const dx = star.x - gal.cx, dy = star.y - gal.cy;
    const r = Math.hypot(dx, dy) || 1;
    const soft2 = r * r + GALACTIC_SOFT * GALACTIC_SOFT;
    const v = r * Math.sqrt(GALACTIC_MU / (soft2 * Math.sqrt(soft2))) * speedScale;
    const tx = -dy / r, ty = dx / r;
    star.vx = tx * Math.min(v, MAX_ORBITAL_SPEED);
    star.vy = ty * Math.min(v, MAX_ORBITAL_SPEED);
  }

  /** Galactic angular speed for a star at its mean orbit radius. */
  private galacticOmega(star: StarBody): number {
    const r = Math.max(8, star.orbitRadius ?? 28);
    const soft2 = r * r + GALACTIC_SOFT * GALACTIC_SOFT;
    let omega = Math.sqrt(GALACTIC_MU / (soft2 * Math.sqrt(soft2)));
    omega = Math.min(omega, MAX_GALACTIC_OMEGA);
    omega *= 1 + Math.sin(star.id * 12.9898) * 0.018;
    return omega;
  }

  /** Place a star on its galactic ellipse around the fixed kinematic centre. */
  private placeStarOnOrbit(star: StarBody, gal: Galaxy, ang: number, age: number): void {
    const ecc = 0.08;
    const phase = age * ORBIT_ECC_RATE + star.id * 1.73;
    const rNow = (star.orbitRadius ?? 28) * (1 + ecc * Math.sin(phase));
    const omega = this.galacticOmega(star);
    star.x = gal.cx + Math.cos(ang) * rNow;
    star.y = gal.cy + Math.sin(ang) * rNow;
    star.vx = -Math.sin(ang) * rNow * omega;
    star.vy =  Math.cos(ang) * rNow * omega;
  }

  /**
   * Write world positions from committed orbitAngle (+ optional sub-tick fraction
   * so high game-speed still paints smoothly between sim ticks).
   */
  private syncOrbitPositions(fracTick: number): void {
    const galById = new Map(this.galaxies.map(g => [g.id, g]));
    for (const star of this.stars) {
      if (star.galaxyId == null) continue;
      const gal = galById.get(star.galaxyId);
      if (!gal || star.orbitAngle == null || star.orbitRadius == null) continue;
      const ang = star.orbitAngle + this.galacticOmega(star) * fracTick;
      this.placeStarOnOrbit(star, gal, ang, star.age);
      this.constrainToUniverse(star);
    }
  }

  private updateGravity(): void {
    const active = this.stars.filter(s => !s.isDead);
    const galById = new Map(this.galaxies.map(g => [g.id, g]));

    // Rare close-approach mergers (not the old pairwise gravity cascade).
    if (this.collisionsEnabled) {
      this.resolveCloseApproaches(active);
    }

    // Kinematic galactic swirl around a FIXED centre (gal.cx/cy).
    for (const star of active) {
      if (star.isDead) continue;
      const gal = star.galaxyId != null ? galById.get(star.galaxyId) : undefined;
      if (!gal) {
        star.x += star.vx;
        star.y += star.vy;
        this.constrainToUniverse(star);
        star.age++;
        continue;
      }

      if (star.orbitRadius == null || star.orbitRadius < 8) {
        star.orbitRadius = Math.max(28, Math.hypot(star.x - gal.cx, star.y - gal.cy));
      }
      if (star.orbitAngle == null) {
        star.orbitAngle = Math.atan2(star.y - gal.cy, star.x - gal.cx);
      }

      star.orbitAngle += this.galacticOmega(star);
      star.age++;
      this.placeStarOnOrbit(star, gal, star.orbitAngle, star.age);
      this.constrainToUniverse(star);
    }

    this.checkCollisions();

    if (this.tick % ASTEROID_SPAWN === 0 && this.rng.chance(this.stats.entropy / 22)) {
      this.spawnAsteroid();
    }
  }

  /**
   * Merge stars that nearly occupy the same point; softly attract orbit radii
   * of near-misses in the same galaxy so a later pass can finish the job.
   */
  private resolveCloseApproaches(active: StarBody[]): void {
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i], b = active[j];
        if (a.isDead || b.isDead) continue;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const contact = Math.max(MERGE_DIST, (a.radius + b.radius) * 1.15);
        if (dist < contact) {
          this.mergeStars(a, b);
          continue;
        }
        if (
          dist < CAPTURE_DIST &&
          a.galaxyId != null && a.galaxyId === b.galaxyId &&
          a.orbitRadius != null && b.orbitRadius != null
        ) {
          const mid = (a.orbitRadius + b.orbitRadius) * 0.5;
          a.orbitRadius += (mid - a.orbitRadius) * 0.003;
          b.orbitRadius += (mid - b.orbitRadius) * 0.003;
        }
      }
    }
  }

  private checkCollisions(): void {
    if (!this.collisionsEnabled) return;
    this.resolveCloseApproaches(this.stars.filter(s => !s.isDead));
  }

  private mergeStars(a: StarBody, b: StarBody): void {
    if (a.isDead || b.isDead) return;
    const bigger = a.mass >= b.mass ? a : b;
    const smaller = a.mass >= b.mass ? b : a;

    // Create nebula at merge point
    const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
    const temp = (bigger.temperature + smaller.temperature) / 2;
    const [r, g, bl] = this.tempToRGB(temp);
    this.nebulae.push({
      x: midX, y: midY,
      radius: bigger.radius * 2,
      maxRadius: 30 + bigger.radius * 8,
      alpha: 0.7, r, g, b: bl, age: 0,
    });

    // Transfer mass + life
    bigger.mass += smaller.mass * 0.6;
    bigger.radius = 2.5 + bigger.mass * 0.8;
    if (smaller.hasLife) {
      // The surviving star inherits the biosphere wholesale — chemistry, tempo
      // and all — rather than restarting from a blank carbon/water default.
      bigger.hasLife       = true;
      bigger.lifeArchetype = smaller.lifeArchetype ?? bigger.lifeArchetype;
      bigger.bioTempo      = smaller.bioTempo ?? bigger.bioTempo;
      if (BIO_PHASE_SEQUENCE.indexOf(smaller.biologyPhase) >
          BIO_PHASE_SEQUENCE.indexOf(bigger.biologyPhase)) {
        bigger.biologyPhase = smaller.biologyPhase;
      }
    }
    bigger.habitability = undefined;  // the system's planet roster just changed
    if (smaller.civLevel > bigger.civLevel) bigger.civLevel = smaller.civLevel;
    // Inheriting an intelligent biosphere by absorption must not leave the
    // survivor without a culture — `smaller.id`'s record does not transfer,
    // and `smaller` is marked dead below, so nothing else will ever call this.
    if (bigger.biologyPhase === 'intelligent') this.ensureCivilization(bigger);

    // Conserve momentum
    const totalMass = bigger.mass + smaller.mass;
    bigger.vx = (bigger.vx * bigger.mass + smaller.vx * smaller.mass) / totalMass;
    bigger.vy = (bigger.vy * bigger.mass + smaller.vy * smaller.mass) / totalMass;

    // If smaller was player star, transfer identity + planet roster to survivor
    if (smaller.isPlayerStar) {
      bigger.isPlayerStar = true;
      smaller.isPlayerStar = false;
      this.playerStarId = bigger.id;
      // Carry player's planets into the merged star so the home planet isn't lost
      bigger.planets = [...bigger.planets, ...smaller.planets];
    }

    // Player star involved in merger → catastrophe + planet formation cycle.
    //
    // Only a COMPARABLE star does this. Absorbing something much smaller should
    // not sterilise a planet, and treating every capture as a world-ending event
    // meant the player's world was reset to magma every few tens of thousands of
    // ticks and could never climb the biology ladder at all — measured at ≈5.5
    // resets per 400k ticks with only 1 seed in 6 ever getting past microbial,
    // which predates M22g rather than being caused by it.
    const majorImpact = smaller.mass >= bigger.mass * MERGER_CATASTROPHE_RATIO;
    if (bigger.isPlayerStar && !majorImpact) {
      // A minor capture: the survivor keeps its biosphere and its history.
      if (this.isStarKnownToPlayer(bigger)) {
        this.onCivEvent?.(
          `${smaller.civName} has fallen into your star. The sky burns for a season, ` +
          `but your world endures.`);
      }
    }
    if (bigger.isPlayerStar && majorImpact) {
      bigger.hasLife = false;
      bigger.civLevel = 0;
      bigger.biologyPhase = 'microbial';
      bigger.bioPhaseProgress = 0;
      bigger.formationStage = 'magma';
      bigger.formationTick = this.tick;
      // Reset life-bearing planet
      for (const p of bigger.planets) { p.hasLife = false; p.biosphere = 0; }
      this.onPlanetCatastrophe?.(smaller.civName);
    }

    smaller.isDead = true;
    this.makeRemnant(smaller, 'merger');

    // A merger that pushes the survivor past the stability limit does not settle
    // down — it detonates. Two stars falling together and going up as one is the
    // most dramatic thing that can happen in the sky, and the whole cycle of
    // supernova → enriched gas → new system hangs off it.
    if (bigger.mass >= COLLISION_SUPERNOVA_MASS) {
      this.detonateStar(bigger, `${bigger.civName} and ${smaller.civName} have collided`);
      return;
    }

    // Otherwise a merger throws off far less gas than a supernova, but not none.
    this.seedNursery(smaller.x, smaller.y, this.rng.chance(0.45) ? 1 : 0);
  }

  /**
   * Blow a star apart, and let its people leave first if they can.
   *
   * The gas returned here is RICH — a supernova is where the next generation of
   * systems comes from, and `seedNursery` spawns stars that then walk the young
   * -system formation stages (see `updateStarFormation`).
   */
  private detonateStar(star: StarBody, cause: string): void {
    // Anyone advanced enough gets out before the light does.
    const escaped = this.evacuateCivilisation(star, cause);

    // THE PLAYER'S WORLD IS NEVER ANNIHILATED OUTRIGHT.
    //
    // If their people got away, `evacuateCivilisation` has already moved the
    // player's identity to the refuge and this star is just another casualty.
    // If they did not, destroying it leaves `playerStarId` pointing at a dead
    // star: `getPlayerStar()` returns undefined and every caller that assumes a
    // home world throws. The rest of the engine is careful about this already —
    // `rollCatastrophe` refuses to draw a sterilising event for the player — and
    // this path has to be too. It becomes a survivable cataclysm instead: the
    // system is wrecked and reforms from magma.
    if (star.isPlayerStar && !escaped) {
      star.hasLife = false;
      star.civLevel = 0;
      star.biologyPhase = 'microbial';
      this.invalidateCulture(star, 'catastrophe');
      star.bioPhaseProgress = 0;
      star.bioStalls = 0;
      star.formationStage = 'magma';
      star.formationTick = this.tick;
      for (const p of star.planets) { p.hasLife = false; p.biosphere = 0; }
      this.supernovaFlashes.push({
        x: star.x, y: star.y,
        startTick: this.tick, startAnimTick: this.animTick,
        maxRadius: 90 + star.mass * 9,
      });
      this.onPlanetCatastrophe?.(star.civName);
      return;
    }

    this.supernovaFlashes.push({
      x: star.x, y: star.y,
      startTick: this.tick, startAnimTick: this.animTick,
      maxRadius: 90 + star.mass * 9,
    });
    this.nebulae.push({
      x: star.x, y: star.y, radius: star.radius * 3,
      maxRadius: 60 + star.mass * 14, alpha: 0.85,
      r: 255, g: 190, b: 140, age: 0,
    });

    // Shockwave: neighbours lose ground.
    for (const s of this.stars) {
      if (s.isDead || s.id === star.id) continue;
      if (Math.hypot(s.x - star.x, s.y - star.y) > 150) continue;
      if (s.civLevel > 0) s.civLevel = Math.max(0, s.civLevel - 1);
      for (const p of s.planets) p.biosphere = Math.max(0, p.biosphere - 0.3);
    }

    star.isDead = true;
    star.hasLife = false;
    this.makeRemnant(star, 'supernova');
    this.seedNursery(star.x, star.y, this.rng.nextInt(2, 4));
    this.onCosmicEvent?.('supernova', star.civName);
    if (this.isStarKnownToPlayer(star)) {
      this.onCivEvent?.(`${cause}. The blast has lit up this arm of the galaxy.`);
    }
  }

  /**
   * An advanced civilisation abandons a doomed star.
   *
   * Below the Interstellar tier there is nowhere to go and everyone dies with
   * the system. At or above it they reach the nearest viable star and continue
   * there — and if it was the PLAYER's world, that destination becomes their new
   * home, which is the whole point of the mechanic.
   */
  private evacuateCivilisation(star: StarBody, cause: string): boolean {
    if (star.civLevel < CIV_EVACUATION_LEVEL) return false;

    // Nearest surviving star that is not already someone else's capital.
    let best: StarBody | null = null;
    let bestDist = Infinity;
    for (const s of this.stars) {
      if (s.isDead || s.id === star.id) continue;
      if (s.civLevel > 0) continue;                 // already inhabited
      const d = Math.hypot(s.x - star.x, s.y - star.y);
      if (d < bestDist) { bestDist = d; best = s; }
    }
    if (!best) return false;

    // They arrive with their technology, but reduced — an exodus costs.
    best.civLevel      = Math.max(0, star.civLevel - 2);
    best.hasLife       = true;
    best.biologyPhase  = 'intelligent';
    best.lifeArchetype = star.lifeArchetype ?? best.lifeArchetype;
    best.bioTempo      = star.bioTempo ?? best.bioTempo;
    best.civName       = star.civName;
    best.religionName  = star.religionName;
    best.religionDevotion = star.religionDevotion;
    best.habitability  = undefined;

    // Give the refuge a world worth landing on.
    const landing = best.planets.find(p => p.type === 'ocean' || p.type === 'rocky')
                 ?? best.planets[0];
    if (landing) { landing.hasLife = true; landing.biosphere = 0.4; landing.discovery = 'landing'; }

    if (star.isPlayerStar) {
      // The player follows their people. Their world IS wherever they are.
      star.isPlayerStar = false;
      best.isPlayerStar = true;
      this.playerStarId = best.id;
      this.onPlayerExodus?.(star.civName, best.civName);
    } else {
      this.spawnLeaderForStar(best);
      if (this.isStarKnownToPlayer(star) || this.isStarKnownToPlayer(best)) {
        this.onCivEvent?.(
          `${cause} — but ${star.civName} saw it coming. Their fleets reached ` +
          `${best.civName}, and they begin again there.`);
      }
    }

    // Rebuild the refuge's culture LAST, once `best.isPlayerStar` is settled
    // above. `ensureCivilization` branches on it to choose between the player's
    // real evolved genome and a stand-in NPC one, so running this any earlier
    // gave a player who had just fled their homeworld a culture derived from a
    // random NPC species. `best` was set to 'intelligent' further up, bypassing
    // the normal ladder climb, so it carries either a stale record or none —
    // neither belongs to the people who actually arrived.
    this.invalidateCulture(best, 'the exodus');
    return true;
  }

  private updateNebulae(): void {
    for (let i = this.nebulae.length - 1; i >= 0; i--) {
      const n = this.nebulae[i];
      n.age++;
      if (n.radius < n.maxRadius) n.radius += NEBULA_EXPAND;
      n.alpha -= NEBULA_FADE;
      if (n.alpha <= 0) this.nebulae.splice(i, 1);
    }
  }

  private spawnAsteroid(): void {
    if (this.asteroids.length > 100) return;
    // Enter from a point on the universe's rim. Spawning along a square
    // perimeter made intruders arrive preferentially from four corners.
    const cx = WORLD_SIZE / 2, cy = WORLD_SIZE / 2;
    const bearing = this.rng.nextFloat(0, Math.PI * 2);
    const rimR = UNIVERSE_RADIUS * 1.02;
    const x = cx + Math.cos(bearing) * rimR;
    const y = cy + Math.sin(bearing) * rimR;

    const angle = Math.atan2(cy - y, cx - x) + this.rng.nextFloat(-0.5, 0.5);
    const speed = this.rng.nextFloat(1.5, 4);

    this.asteroids.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: this.rng.nextFloat(0.5, 1.5),
      alive: true,
    });
  }

  private updateAsteroids(): void {
    for (let i = this.asteroids.length - 1; i >= 0; i--) {
      const ast = this.asteroids[i];
      if (!ast.alive) { this.asteroids.splice(i, 1); continue; }

      ast.x += ast.vx;
      ast.y += ast.vy;

      // Out of bounds — radial, so debris doesn't linger out to the corners of
      // a square while the star field ends at a circle.
      const bx = ast.x - WORLD_SIZE / 2, by = ast.y - WORLD_SIZE / 2;
      if (bx * bx + by * by > (UNIVERSE_RADIUS + 60) ** 2) {
        this.asteroids.splice(i, 1);
        continue;
      }

      // Panspermia: check if hits a star's planet zone
      for (const star of this.stars) {
        if (star.isDead) continue;
        const dx = star.x - ast.x, dy = star.y - ast.y;
        if (Math.sqrt(dx * dx + dy * dy) < star.radius * 3 + PANSPERMIA_DIST * (this.stats.life / 20)) {
          // Panspermia event — a delivered biosphere still has to be able to
          // survive where it lands, so the roll is weighted by habitability.
          // Nothing survives landing on a world that is still molten, so a
          // system part-way through formation cannot be seeded at all.
          if (star.formationDestiny && star.formationStage
              && lifeEligible(star.formationDestiny, star.formationStage)) {
            // A forming home world whose crust has set: the strike can carry
            // life. It lies dormant and hastens the ladder.
            if (this.rng.chance((this.stats.life / 500) * 0.6)) this.seedFormingWorld(star, 'meteor');
          } else if (!star.hasLife && !star.formationStage) {
            const hab = this.habitabilityOf(star);
            const young = star.isNewSystem ? NEW_SYSTEM_PANSPERMIA_MOD : 1;
            if (this.rng.chance((this.stats.life / 500) * hab * young)) {
              this.igniteLife(star, star.bestPlanetIndex ?? 0);
              if (this.isStarKnownToPlayer(star))
                this.onCivEvent?.(`Panspermia: life seeded on ${star.civName}'s system`);
            }
          }
          ast.alive = false;
          // Small impact nebula
          this.nebulae.push({
            x: star.x + this.rng.nextFloat(-10, 10),
            y: star.y + this.rng.nextFloat(-10, 10),
            radius: 2, maxRadius: 12, alpha: 0.4,
            r: 255, g: 150, b: 80, age: 0,
          });
          break;
        }
      }
    }
  }

  private updateCivilizations(): void {
    if (this.phase === 'inflation') return;

    for (const star of this.stars) {
      if (star.isDead) continue;

      // ── Abiogenesis on dead worlds ──────────────────────────────────────────
      // No global cap any more: whether a system ever wakes up is decided by its
      // own habitability, so how crowded the universe gets is itself a roll.
      if (!star.hasLife && !star.isPlayerStar) {
        this.tryAbiogenesis(star);
        continue;
      }

      star.age++;

      // A world still walking its formation ladder holds any life it has
      // dormant: no catastrophes, no spread, no biology ladder until it is
      // finished ground (Formation.ts).
      if (star.formationDestiny) continue;

      // ── Biosphere catastrophes ──────────────────────────────────────────────
      this.rollBiosphereCatastrophe(star);
      if (!star.hasLife) continue;

      // ── Planet surface: life spread, territory, species ranges ──────────────
      // This used to live inside the pre-intelligence branch, so the moment a
      // world woke up its whole surface froze: no more life spread, no civ
      // territory (`civId` was never stamped, so no settlements or city lights),
      // and species ranges stopped updating — exactly when the player finally
      // had a civilisation worth looking at.
      if (star.isPlayerStar && runtimeState.playerPlanetGrid && shouldStepEvolution(this.tick)) {
        const spreadRate = Math.max(0.1, this.playerEffect('bioResilience'));
        const civIdToStamp = star.civLevel >= 1 ? String(star.id) : null;
        stepLifeSpread(runtimeState.playerPlanetGrid, star.biologyPhase, spreadRate, civIdToStamp);
        // Record WHERE each species lives. Without this, `dominantSpeciesId`
        // stays null forever and nothing can render or inspect the biosphere.
        assignDominantSpecies(runtimeState.playerPlanetGrid, gameState.playerSpecies);
        if (star.biologyPhase !== 'intelligent' && runtimeState.playerNations?.isFounded) {
          // The people who made the nations are gone (a collapse knocked life
          // back down the ladder): the nations go with them. A people that
          // rises again founds its own.
          const names = runtimeState.playerNations.nations.map(n => n.name);
          runtimeState.playerNations = null;
          this.nationEra = 0;
          this.onCivEvent?.(`The nations have fallen silent: ${names.join(', ')}.`);
        } else if (star.civLevel >= 1 || runtimeState.playerNations?.isFounded) {
          this.stepNations(star, runtimeState.playerPlanetGrid);
        }
      }

      // ── Moons: settled once a civilisation can actually reach them ──────
      // Checked periodically, not every tick. Founding a colony is not
      // time-critical, and walking every planet's moon list for every star on
      // every tick is real cost in the hot loop for no gain.
      if (this.tick % MOON_CHECK_RATE === 0) this.updateMoonColonisation(star);

      // ── Biology phase progression (pre-intelligence) ─────────────────────────
      if (star.biologyPhase !== 'intelligent') {
        this.updateBiologyPhase(star);

        // M17: Deterministic evolution for player star only
        if (star.isPlayerStar) {
          if (gameState.playerSpecies.length === 0) {
            gameState.playerSpecies = initPlayerSpecies(
              this.tick, this.rng.fork(`founder_${star.id}`));
          }
          this.ensureSignature();
          if (shouldStepEvolution(this.tick)) {
            const sigId = gameState.signatureSpeciesId;
            const result = stepEvolution(
              star.biologyPhase,
              gameState.playerDNA,
              gameState.playerSpecies,
              gameState.playerBiosphere,
              this.rng,
              this.tick,
              runtimeState.branchDefs,
              sigId ? { id: sigId, locked: lockedTraits(gameState.mutationsOwned) } : null,
            );
            gameState.playerSpecies   = result.updatedSpecies;
            gameState.playerBiosphere = result.updatedBiosphere;
            for (const evt of result.events) {
              if (evt.type === 'mutation')    this.onMutationEvent?.(evt);
              if (evt.type === 'speciation')  this.onSpeciationEvent?.(evt);
              if (evt.type === 'extinction')  this.onExtinctionEvent?.(evt);
            }
            this.afterSignatureStep(result.events, star.biologyPhase);
          }
        }

        continue; // no civilisation advancement until intelligence emerges
      }

      // ── Civilisation tech advancement (post-intelligence) ────────────────────
      // The player's world, once split into nations, climbs the eras through
      // what its nations learn (stepNations, technology as a response); every
      // other civilisation still advances on the clock.
      const playerNations = star.isPlayerStar && runtimeState.playerNations?.isFounded;
      const advanceRate = this.civAdvanceRate(star);
      if (!playerNations && star.age % Math.max(1, Math.floor(advanceRate)) === 0 &&
          star.civLevel < TECH_LEVELS.length - 1) {
        this.advanceCiv(star);
      }

      // Wars — only spacefaring+ civs. Culture decides how readily THIS people
      // reaches for war; the universe stat decides the era's general violence.
      if (star.civLevel >= 3 && star.age % WAR_TICK_RATE === 0) {
        const c = this.cultureFor(star);
        const warChance = Math.min(0.95, (this.stats.hostility / 40)
          * (c ? cultureMultiplier(c.values.militarism, 1) : 1)
          * (c ? cultureMultiplier(c.values.xenophobia, 0.5) : 1));
        if (this.rng.chance(warChance)) this.launchFleet(star);
      }

      // Cosmic radio — Space Age+ NPC civs emit signals periodically
      if (!star.isPlayerStar && star.civLevel >= 5 && star.hasLife &&
          star.age % RADIO_TICK_RATE === 0 &&
          this.rng.chance(0.25)) {
        this.spawnCosmicSignal(star);
      }
    }
  }

  // ─── Biology Phase Logic ──────────────────────────────────────────────────

  /** Ticks (base) to complete each biology phase. Modified by evolution stat. */

  private static readonly SIGNAL_MESSAGES = [
    'We count the stars and find ourselves numbered among them.',
    'This signal has traveled {dist} light-years to reach you.',
    'Greetings from the {civ} Collective. We have been watching.',
    'Our archives record your world\'s first fire. We waited.',
    'The void is not empty. We are proof.',
    'Transmission origin: {civ} Primary. Repeat interval: 1 cycle.',
    'Peaceful contact requested. Response window: open.',
    'We have mapped your star. It is beautiful. Do not destroy it.',
    '{civ} science division reports biological signatures detected.',
    'We heard your broadcasts. Curious creatures.',
    'The silence between stars is not absence — it is patience.',
  ];

  // ─── Life model plumbing (see LifeSystem.ts) ──────────────────────────────

  /**
   * Make sure this universe has a branch set, derived from its seed.
   *
   * Existing investment is preserved when the branch ids already match, so
   * loading a save does not wipe what the player has spent.
   */
  private ensureBranches(seed: string): void {
    const wanted = gameState.branchIds.length > 0
      ? branchesFromIds(gameState.branchIds)
      : generateBranchSet(new SeedRNG(`branches_${seed}`));

    const defs = wanted.length > 0
      ? wanted
      : generateBranchSet(new SeedRNG(`branches_${seed}`));

    runtimeState.branchDefs = defs;
    gameState.branchIds = defs.map(d => d.id);

    const investedKeys = Object.keys(gameState.playerDNA);
    const matches = defs.every(d => investedKeys.includes(d.id));
    if (!matches) gameState.playerDNA = emptyInvestment(defs);
  }

  /**
   * Read a DNA effect for the player.
   *
   * The engine used to reach for named fields (`playerDNA.adaptation`), which
   * only worked because every universe had the same eight branches. Branch sets
   * are now rolled per universe, so the simulation asks for an EFFECT and
   * whichever branches exist contribute to it.
   */
  private playerEffect(kind: Parameters<typeof branchEffect>[2]): number {
    // Older saves invested in branches; new games own mutation cards. Both count.
    return branchEffect(gameState.playerDNA, runtimeState.branchDefs, kind)
         + mutationEffect(gameState.mutationsOwned, kind);
  }

  // ── Signature species (2026-10-04 spec) ─────────────────────────────────

  /** Grant DNA for a visible event and tell the UI why. */
  awardDNA(amount: number, reason: string): void {
    if (amount <= 0) return;
    gameState.dnaPoints += amount;
    this.onDNAAward?.(amount, reason);
    this.onDNAPointEarned?.(gameState.dnaPoints);
  }

  /** The living signature genome, or null. */
  signatureSpecies(): SpeciesGenome | null {
    const id = gameState.signatureSpeciesId;
    return gameState.playerSpecies.find(s => s.id === id && !s.isExtinct) ?? null;
  }

  /**
   * Make sure the player has a signature lineage: the founder when life first
   * appears (with the first DNA grant and Form I), or — if it was ever lost —
   * its most populous descendant, else the most populous living lineage.
   */
  private ensureSignature(): void {
    const living = gameState.playerSpecies.filter(s => !s.isExtinct);
    if (living.length === 0 || this.signatureSpecies()) return;
    const first = gameState.signatureSpeciesId === null;
    let heir: SpeciesGenome | undefined;
    if (!first) {
      const lost = gameState.signatureSpeciesId;
      const descends = (s: SpeciesGenome): boolean => {
        let cur: SpeciesGenome | undefined = s;
        for (let i = 0; i < 40 && cur; i++) {
          if (cur.ancestorId === lost) return true;
          const anc: string | null = cur.ancestorId;
          cur = gameState.playerSpecies.find(x => x.id === anc);
        }
        return false;
      };
      heir = living.filter(descends).sort((a, b) => b.population - a.population)[0];
    }
    heir ??= [...living].sort((a, b) => b.population - a.population)[0];
    gameState.signatureSpeciesId = heir.id;
    if (first) {
      gameState.speciesForms = [{
        form: 1, name: heir.name, tick: this.tick, mutations: [],
        genome: cloneGenome(heir),
      }];
      this.awardDNA(FIRST_LIFE_DNA, 'Life has taken hold: choose its first mutations');
    } else {
      this.onSignatureSucceeded?.(heir.name);
    }
  }

  /**
   * Evolve: apply every queued card to the signature species at once, give the
   * new form a name, and record it in the dex. Returns null when the queue is
   * not enough yet (see Mutations.queueReady) or there is no signature species.
   */
  evolveSignature(): { before: SpeciesGenome; after: SpeciesGenome; diff: string[]; form: number; cards: string[] } | null {
    const sig = this.signatureSpecies();
    const queue = [...gameState.mutationQueue];
    if (!sig || !queueReady(queue)) return null;
    const before = cloneGenome(sig);
    for (const id of queue) applyMutation(sig, id);
    // Every form gets a fresh name that fits what it became.
    const rng = this.rng.fork(`form_${sig.id}_${gameState.speciesForms.length + 1}`);
    let name = nameForGenome(sig, rng);
    for (let i = 0; i < 4 && name === before.name; i++) name = nameForGenome(sig, rng);
    sig.name = name;
    gameState.mutationsOwned.push(...queue);
    gameState.mutationQueue = [];
    const form = gameState.speciesForms.length + 1;
    gameState.speciesForms.push({ form, name, tick: this.tick, genome: cloneGenome(sig), mutations: queue });
    return { before, after: cloneGenome(sig), diff: genomeDiff(before, sig), form, cards: queue };
  }

  /** DNA from the step's events, the biome census, and spontaneous mutations. */
  private afterSignatureStep(events: EvolutionEvent[], phase: BiologyPhase): void {
    const sig = this.signatureSpecies();
    if (!sig) { this.ensureSignature(); return; }
    for (const evt of events) {
      if (evt.type === 'speciation' && evt.speciesId === sig.id) {
        this.awardDNA(2, `${evt.newSpeciesName ?? 'A sub-species'} branched off your species`);
      } else if (evt.type === 'extinction' && evt.speciesId !== sig.id) {
        this.awardDNA(1, `Rival ${evt.speciesName} died out`);
      } else if (evt.type === 'mutation' && evt.speciesId === sig.id) {
        this.onSignatureDrift?.(evt);
      }
    }
    // Dominance trickle.
    this.awardDNA(sig.population > 0.4 ? 2 : 1, 'Your species thrives');
    // New biomes held.
    const grid = runtimeState.playerPlanetGrid;
    if (grid) {
      const held = new Set<string>();
      for (const row of grid) for (const cell of row) {
        if (cell.dominantSpeciesId === sig.id) held.add(cell.biome);
      }
      for (const b of held) {
        if (gameState.signatureBiomes.includes(b)) continue;
        gameState.signatureBiomes.push(b);
        // The first biome is home, not a conquest.
        if (gameState.signatureBiomes.length > 1) {
          this.awardDNA(3, `Your species spread into ${b.replace(/_/g, ' ')}`);
        }
      }
    }
    // A surprise: a free card drops into the queue.
    if (this.rng.chance(SPONTANEOUS_MUTATION_CHANCE)) {
      const open = cardStates({
        genome: sig, phase, owned: gameState.mutationsOwned, queued: gameState.mutationQueue,
        offered: gameState.offeredMutations, points: Infinity,
      }).filter(c => c.status === 'available');
      if (open.length > 0) {
        const pick = open[this.rng.nextInt(0, open.length - 1)].def.id;
        gameState.mutationQueue.push(pick);
        gameState.mutationGifts.push(pick);
        this.onSpontaneousMutation?.(pick);
      }
    }
  }

  /**
   * How much easier the player has made their world's next Great Filter roll.
   *
   * Two contributions, because they are two different kinds of play:
   *  - NUDGES are spent effort. They accumulate across failed rolls and reset
   *    the moment the world makes a jump.
   *  - DNA INVESTMENT is a standing bonus. `branchEffect` is normalised against
   *    100 points in a branch, but the pre-intelligence economy only grants 5
   *    per phase advance — about 15 points by the time a world sits at
   *    'primitive'. Scaling by DNA_ASSIST_WEIGHT makes that realistic budget
   *    worth something instead of rounding to nothing.
   */
  private playerBioAssistance(): number {
    const fromDNA = Math.min(0.5, this.playerEffect('bioResilience') * DNA_ASSIST_WEIGHT);
    return Math.min(0.9, this.bioAssistance + fromDNA);
  }

  /**
   * Cached 0–1 habitability, computed on first use and after terraforming.
   * Public so the UI can display it without waiting for the simulation to
   * happen to touch the star.
   */
  habitabilityOf(star: StarBody): number {
    if (star.habitability == null) {
      const { score, index } = systemHabitability(star.planets.map(p => ({
        planetType:      p.type as PlanetKind,
        orbitalRadius:   p.orbitalRadius,
        starTemperature: star.temperature,
      })));
      star.habitability = score;
      star.bestPlanetIndex = index;
    }
    return star.habitability;
  }

  /** Drop the cached habitability so it is recomputed (planet type changed). */
  invalidateHabitability(star: StarBody): void {
    star.habitability = undefined;
  }

  private archetypeOf(star: StarBody): LifeArchetype {
    return star.lifeArchetype ?? 'carbon_water';
  }

  /** Seed a brand-new biosphere on a star: chemistry, tempo, starting phase. */
  private igniteLife(star: StarBody, planetIndex: number): void {
    const planet = star.planets[planetIndex] ?? star.planets[0];
    const rng = this.rng.fork(`life_${star.id}_${this.tick}`);

    star.hasLife          = true;
    star.biologyPhase     = 'microbial';
    star.bioPhaseProgress = 0;
    star.bioStalls        = 0;
    star.lifeFirstTick    = this.tick;
    star.lifeArchetype    = pickArchetype((planet?.type ?? 'rocky') as PlanetKind, rng);
    star.bioTempo         = rollBioTempo(rng, star.lifeArchetype);
    if (!star.isPlayerStar) star.dna = this.generateNPCDNA();

    if (planet) { planet.hasLife = true; planet.biosphere = 0.2; }
  }

  /**
   * Per-tick abiogenesis roll for a lifeless NPC system.
   * The rate is quadratic in habitability, so marginal worlds are not merely
   * slower — they are usually never.
   */
  private tryAbiogenesis(star: StarBody): void {
    // A system condensed during play gets its one roll when it finishes forming
    // (see `updatePlanetFormation`), not the ambient per-tick rate — but only
    // for a while. Once the grace window passes it is just another old star.
    if (star.isNewSystem) {
      if (this.tick < (star.newSystemUntil ?? 0)) return;
      star.isNewSystem = false;
    }
    const hab = this.habitabilityOf(star);
    if (hab <= 0.08) return;

    // Each failed biosphere leaves the system a little more hostile.
    const attenuation = 1 / (1 + (star.extinctions ?? 0) * 0.8);
    const p = ABIOGENESIS_BASE * hab * hab
            * (0.3 + this.stats.life / 20) * attenuation;

    if (!this.rng.chance(p)) return;

    const index = star.bestPlanetIndex ?? 0;
    this.igniteLife(star, index);

    if (this.isStarKnownToPlayer(star)) {
      const chem = ARCHETYPES[this.archetypeOf(star)].label;
      this.onCivEvent?.(`Life has taken hold in ${star.civName} — a ${chem} biosphere.`);
    }
  }

  /**
   * Rare biosphere-scale disasters, independent of the phase ladder.
   * The player's world is never sterilised outright; it only loses ground.
   */
  private rollBiosphereCatastrophe(star: StarBody): void {
    const pressure = (this.stats.entropy + this.stats.hostility) / 2;
    const p = (pressure / 20) * CATASTROPHE_BASE;
    if (!this.rng.chance(p)) return;

    const rng = this.rng.fork(`cata_${star.id}_${this.tick}`);
    const cat = rollCatastrophe(rng, this.archetypeOf(star), !star.isPlayerStar);
    if (!cat) return;

    star.habitability = Math.max(0.02, this.habitabilityOf(star) * cat.habDamage);
    const name = star.isPlayerStar
      ? (gameState.playerPlanetName || star.civName)
      : star.civName;
    const text = cat.text.replace('{name}', name);

    if (cat.setback >= 99) {
      this.sterilise(star);
      if (this.isStarKnownToPlayer(star)) this.onCivEvent?.(text);
      this.onLifeEvent?.(text, 'catastrophe', false);
      return;
    }

    this.regressPhases(star, cat.setback);
    if (star.isPlayerStar) {
      this.onLifeEvent?.(text, 'catastrophe', true);
    } else if (this.isStarKnownToPlayer(star)) {
      this.onCivEvent?.(text);
    }
  }

  /** Wipe a biosphere out completely. The system may be reseeded much later. */
  private sterilise(star: StarBody): void {
    star.hasLife = false;
    star.civLevel = 0;
    star.biologyPhase = 'microbial';
    star.bioPhaseProgress = 0;
    star.bioStalls = 0;
    star.lifeArchetype = undefined;
    star.bioTempo = undefined;
    star.extinctions = (star.extinctions ?? 0) + 1;
    star.religionName = '';
    star.religionDevotion = 0;
    for (const p of star.planets) { p.hasLife = false; p.biosphere = 0; }
  }

  /** Knock a biosphere back down the ladder. Sterilises NPCs that fall off it. */
  private regressPhases(star: StarBody, steps: number): void {
    const idx = BIO_PHASE_SEQUENCE.indexOf(star.biologyPhase);
    const next = idx - steps;

    if (next < 0) {
      // The player's world always keeps a microbial floor — the game is built
      // around watching one world climb, so it must never simply end.
      // Elsewhere, simple cells usually ride the collapse out; total
      // sterilisation is possible but uncommon.
      const rng = this.rng.fork(`floor_${star.id}_${this.tick}`);
      if (star.isPlayerStar || survivesFloorCollapse(rng, this.archetypeOf(star))) {
        star.biologyPhase = 'microbial';
        star.bioPhaseProgress = 0;
        star.bioStalls = (star.bioStalls ?? 0) + 1;
        return;
      }
      this.sterilise(star);
      return;
    }

    star.biologyPhase = BIO_PHASE_SEQUENCE[next];
    star.bioPhaseProgress = 0;
    if (next < BIO_PHASE_SEQUENCE.indexOf('intelligent')) {
      star.civLevel = 0;
    }
  }

  /**
   * One step of the biology ladder — but each transition is a Great Filter roll,
   * not a guarantee. Worlds can stall here permanently or collapse backwards.
   */
  private updateBiologyPhase(star: StarBody): void {
    const evoMod = (21 - this.stats.evolution) / 10;           // slower = higher stat inverse
    // NPC worlds fast-track (12% of player speed) so the universe feels populated
    const speedMult = star.isPlayerStar ? 1.0 : 0.12;
    // Player DNA adaptation branch slightly accelerates bio progression
    const dnaMod = star.isPlayerStar
      ? Math.max(0.6, 1 - this.playerEffect('bioResilience') * 0.4)
      : 1.0;

    // Per-world tempo is what makes two identical planets wake up centuries apart.
    const tempo  = star.bioTempo ?? 1;
    const stalls = star.bioStalls ?? 0;
    // The player's world caps its stall count: uncapped, the wait between
    // attempts diverges and a world that failed a few times effectively never
    // rolled again. NPC worlds stay uncapped — parking them across the ladder is
    // what makes the universe look inhabited at every stage rather than binary.
    const effStalls = star.isPlayerStar ? Math.min(stalls, PLAYER_STALL_TIME_CAP) : stalls;
    const rate = BIO_PHASE_TICKS[star.biologyPhase] * evoMod * speedMult * dnaMod
               / Math.max(0.15, tempo)
               * (1 + effStalls * STALL_TIME_PENALTY);

    star.bioPhaseProgress++;
    if (star.bioPhaseProgress < rate) return;
    star.bioPhaseProgress = 0;

    const idx = BIO_PHASE_SEQUENCE.indexOf(star.biologyPhase);
    if (idx < 0 || idx >= BIO_PHASE_SEQUENCE.length - 1) return;

    const fromPhase = star.biologyPhase;
    const rng = this.rng.fork(`filter_${star.id}_${this.tick}`);
    const outcome = resolveTransition({
      phase:        fromPhase,
      habitability: this.habitabilityOf(star),
      archetype:    this.archetypeOf(star),
      stalls,
      // Divine nudges AND the DNA lab make the player's next filter roll easier.
      // DNA used to touch only `dnaMod` above, which scales the timer and is
      // capped at 0.6× — so spending points could not change whether the world
      // ever got past a filter, only how often it re-rolled a hopeless one.
      assistance:   star.isPlayerStar ? this.playerBioAssistance() : 0,
    }, rng);

    if (outcome === 'stall') {
      star.bioStalls = stalls + 1;
      const name = star.isPlayerStar
        ? (gameState.playerPlanetName || star.civName) : star.civName;
      const msg = `Evolution has stalled on ${name}. ${phaseLabel(fromPhase)} life persists, and changes no further.`;
      if (star.isPlayerStar) this.onLifeEvent?.(msg, 'stall', true);
      else if (this.isStarKnownToPlayer(star)) this.onCivEvent?.(msg);
      return;
    }

    if (outcome === 'collapse') {
      const name = star.isPlayerStar
        ? (gameState.playerPlanetName || star.civName) : star.civName;
      this.regressPhases(star, 1);
      const survived = star.hasLife;
      const msg = survived
        ? `A mass extinction has swept ${name}. Its biosphere has fallen back to ${phaseLabel(star.biologyPhase)} life.`
        : `The biosphere of ${name} has died out entirely.`;
      if (star.isPlayerStar) this.onLifeEvent?.(msg, 'collapse', true);
      else if (this.isStarKnownToPlayer(star)) this.onCivEvent?.(msg);
      return;
    }

    // advance / burst
    if (star.isPlayerStar) this.bioAssistance = 0;   // the nudge is spent
    star.bioStalls = 0;
    const step = outcome === 'burst' ? 2 : 1;
    const nextIdx = Math.min(BIO_PHASE_SEQUENCE.length - 1, idx + step);
    const nextPhase = BIO_PHASE_SEQUENCE[nextIdx];
    star.biologyPhase = nextPhase;

    if (outcome === 'burst') {
      const name = star.isPlayerStar
        ? (gameState.playerPlanetName || star.civName) : star.civName;
      const msg = `An explosive radiation on ${name} has vaulted its biosphere straight to ${phaseLabel(nextPhase)} life.`;
      if (star.isPlayerStar) this.onLifeEvent?.(msg, 'burst', true);
      else if (this.isStarKnownToPlayer(star)) this.onCivEvent?.(msg);
    }

    if (nextPhase === 'intelligent') {
      // Species emerges — transition to civilisation.
      //
      // This branch fires both on a star's FIRST-EVER arrival at intelligence
      // and on a star RE-reaching it after a regression (a mass extinction
      // knocked biologyPhase back down via `regressPhases`, and it re-climbed).
      // `invalidateCulture` no-ops when there is nothing to clear, so on a
      // first-ever arrival no record exists yet and this is free; it only does
      // real work — dropping a stale record so `ensureCivilization` rebuilds
      // from the species as it is NOW — when one is already sitting there from
      // before the collapse. That is precisely "re-reaching intelligence after
      // a regression" and nothing else, so it cannot double the Gemini call
      // that `ensureCivilization` makes on an ordinary first emergence.
      star.civLevel = 0;
      this.invalidateCulture(star, 're-emergence');
      this.ensureCivilization(star);
      if (!star.isPlayerStar) {
        // Auto-generate NPC DNA
        star.dna = this.generateNPCDNA();
        if (this.rng.chance(0.4)) {
          star.religionName = this.generateReligionName();
          star.religionDevotion = this.rng.nextFloat(0.08, 0.25);
        }
        if (this.isStarKnownToPlayer(star))
          this.onCivEvent?.(`An intelligent species has emerged in ${star.civName}.`);
        this.spawnLeaderForStar(star);
      } else {
        this.onPlayerLifeEmerged?.(); // triggers naming modal
      }
    }

    if (star.isPlayerStar) {
      // DNA income scales with the phase reached, because the COST of a point
      // does too (`dnaPointCost`). A flat +5 against rising prices would make
      // the lab progressively less usable the further a world got — the
      // opposite of the intent, which is that later choices are weightier, not
      // unaffordable.
      gameState.dnaPoints += 8 * (nextIdx + 1);
      this.onDNAPointEarned?.(gameState.dnaPoints);
      // A new phase is a new evolutionary decision: the branch the player is
      // committed to this era is released so another can be chosen.
      gameState.dnaFocusBranch = null;
      this.onBioPhaseAdvance?.(nextPhase, star.civName);
      this.fireCodexMilestone(nextPhase);
    }
  }

  private fireCodexMilestone(key: string): void {
    const def = CODEX_MILESTONES[key];
    if (!def) return;
    this.onCodexMilestone?.({
      id: `${key}_${this.tick}`,
      tick: this.tick,
      title: def.title,
      category: def.category,
    });
  }

  private spawnLeaderForStar(star: StarBody): void {
    // Remove old leader for this star
    gameState.leaders = gameState.leaders.filter(l => l.starId !== star.id);
    if (star.isDead || star.civLevel < 1) return;

    const leaderRng = this.rng.fork(`leader_${star.id}_${star.civLevel}`);
    const leader = generateLeader(
      star.id,
      star.civName,
      star.isPlayerStar ? gameState.playerSpeciesName : star.civName,
      star.civLevel,
      this.stats.hostility,
      star.religionDevotion,
      leaderRng,
    );
    gameState.leaders.push(leader);

    // Generate faction flag if not yet assigned
    if (!gameState.factionFlags[star.id]) {
      gameState.factionFlags[star.id] = generateFactionFlag(this.rng.fork(`flag_${star.id}`));
    }
  }

  /** The culture of a star's civilisation, or null if it has none yet. */
  /**
   * The home world's nations: founded once the civilisation holds enough land
   * (Ancient era on), then stepped with the surface. Their culture drifts from
   * the civilisation's; without one yet, from the intelligent species' genome.
   */
  /**
   * Ticks per era for this civilisation: the universe's evolution stat, the
   * player's DNA and prophet boost, and a curious culture all speed it.
   */
  private civAdvanceRate(star: StarBody, withCulture = true): number {
    let advanceRate = CIV_TICK_RATE * (21 - this.stats.evolution) / 10;
    // DNA intelligence branch speeds up research for player's species
    if (star.isPlayerStar) {
      advanceRate *= Math.max(0.4, 1 - this.playerEffect('techSpeed') * 0.55);
    }
    if (star.isPlayerStar && this.prophetBoostActive) advanceRate *= 0.5;

    // A curious people advances faster. Bounded, so no culture stalls a
    // civilisation outright or races it to the end of the tech tree.
    const civCulture = withCulture ? this.cultureFor(star) : null;
    if (civCulture) advanceRate /= cultureMultiplier(civCulture.values.curiosity, 1);
    return advanceRate;
  }

  /** One era up, with everything an era brings (messages, sight, leaders, first contact). */
  private advanceCiv(star: StarBody): void {
    star.civLevel++;
    if (star.isPlayerStar && this.prophetBoostActive) this.prophetBoostActive = false;
    star.explorationRadius = 30 + star.civLevel * 20;

    if (star.isPlayerStar) {
      // Grow the tracking sight bubble rather than leaving static breadcrumbs
      // at old galactic positions (those would drift into fog as the star orbits).
      const sightR = Math.max(300, star.explorationRadius);
      if (this.playerFogIndex >= 0 && this.playerFogIndex < this.exploredAreas.length) {
        this.exploredAreas[this.playerFogIndex].r = Math.max(
          this.exploredAreas[this.playerFogIndex].r,
          sightR,
        );
      } else {
        this.exploredAreas.push({ x: star.x, y: star.y, r: sightR });
        this.playerFogIndex = this.exploredAreas.length - 1;
      }
      this.onCivEvent?.(`${civLevelToPhase(star.civLevel).replace('_',' ')}: ${TECH_LEVELS[star.civLevel]}`);
      this.advancePlayerPlanetDiscovery(star);
      if (star.civLevel === 1) this.onPlayerReligionMoment?.();
      // TECH points
      gameState.techPoints += 3;
      this.onTechPointEarned?.(gameState.techPoints);
      // Codex milestones
      this.fireCodexMilestone(`civ_${star.civLevel}`);
      // Leader spawning
      this.spawnLeaderForStar(star);
      if (star.civLevel === 1) {
        this.fireLeaderMessage(star, `${gameState.playerSpeciesName} has reached Ancient civilization. Their first leader rises.`);
      } else if (star.civLevel >= 2) {
        this.fireLeaderMessage(star, `Our civilization has advanced to ${TECH_LEVELS[star.civLevel]}.`);
      }
      // First Contact — fires exactly once when player reaches Space Age
      if (star.civLevel === 5 && !gameState.firstContactFired) {
        const knownNPCs = this.stars.filter(s =>
          !s.isPlayerStar && !s.isDead && s.hasLife &&
          s.biologyPhase === 'intelligent' &&
          this.isStarKnownToPlayer(s)
        );
        if (knownNPCs.length > 0) {
          gameState.firstContactFired = true;
          const ps = star;
          knownNPCs.sort((a, b) => {
            const da = (a.x - ps.x) ** 2 + (a.y - ps.y) ** 2;
            const db = (b.x - ps.x) ** 2 + (b.y - ps.y) ** 2;
            return da - db;
          });
          this.onFirstContact?.(knownNPCs[0]);
        }
      }
    } else {
      if (this.rng.chance(0.3) && this.isStarKnownToPlayer(star))
        this.onCivEvent?.(`${star.civName}: ${TECH_LEVELS[star.civLevel]}`);
      const relC = this.cultureFor(star);
      const relChance = Math.min(0.95, 0.65
        * (relC ? cultureMultiplier(relC.values.piety, 0.8) : 1));
      if (star.civLevel === 1 && !star.religionName && this.rng.chance(relChance)) {
        star.religionName = this.generateReligionName();
        star.religionDevotion = (0.1 + this.rng.nextFloat(0, 0.2))
          * (relC ? cultureMultiplier(relC.values.piety, 0.6) : 1);
        if (this.isStarKnownToPlayer(star))
          this.onReligionEvent?.(`The ${star.religionName} has emerged in the ${star.civName} system.`);
      }
      // Leader spawning for NPC stars
      this.spawnLeaderForStar(star);
    }
  }

  private stepNations(star: StarBody, grid: PlanetGrid): void {
    let ns = runtimeState.playerNations;
    if (!ns) ns = runtimeState.playerNations = new NationSystem((star.id * 2654435761 + this.tick0Seed) >>> 0);
    if (!ns.isFounded) {
      const civ = this.cultureFor(star);
      const lead = gameState.playerSpecies.filter(sp => !sp.isExtinct).sort((a, b) => b.dna.intelligence - a.dna.intelligence)[0];
      const genome = civ?.sourceGenome ?? (lead ? summariseGenome(lead) : null);
      if (!genome) return;
      ns.found(grid, civ?.values ?? valuesFromGenome(genome), genome, this.tick);
      if (ns.isFounded) {
        const names = ns.nations.map(n => n.name);
        this.onCivEvent?.(`Your people have split into ${names.length} nations: ${names.join(', ')}.`);
      }
      return;
    }
    // The world was thrown back by something outside the nations (impact,
    // war, a nearby supernova): they lose what they knew past it.
    if (star.civLevel < this.nationEra) ns.setback(this.nationEra - star.civLevel, this.tick, 'a catastrophe threw the world back');
    // Each nation's own curiosity sets its pace, so the culture factor is left out here.
    ns.step(grid, this.tick, this.civAdvanceRate(star, false));
    for (const d of ns.drainDiscoveries()) {
      // The first nation to learn a thing is news; the rest follow quietly.
      if (ns.nations.filter(n => n.techs.includes(d.tech.id)).length !== 1) continue;
      if (d.tech.spaceship) {
        this.onCivEvent?.(`${d.nation.name} has launched a colony ark — the first ship of ${gameState.playerSpeciesName || 'your people'} to leave its world.`);
        this.fireCodexMilestone('colony_ark');
      } else {
        this.onCivEvent?.(`${d.nation.name} ${d.tech.deed}.`);
      }
    }
    // The world stands in the era its most advanced nation has reached.
    while (star.civLevel < Math.min(ns.maxEra, TECH_LEVELS.length - 1)) this.advanceCiv(star);
    this.nationEra = star.civLevel;
  }

  cultureFor(star: StarBody): Civilization | null {
    return gameState.civilizations[star.id] ?? null;
  }

  /**
   * Give a star a culture if it does not have one.
   *
   * The procedural record is written SYNCHRONOUSLY and immediately, so there is
   * never a window where an intelligent civilisation has no culture and no
   * caller has to handle a missing record. The Gemini call, if any, replaces it
   * later and never blocks the tick.
   */
  private ensureCivilization(star: StarBody): void {
    if (gameState.civilizations[star.id]) return;

    const species = star.isPlayerStar
      ? gameState.playerSpecies.filter(s => !s.isExtinct)
          .sort((a, b) => b.population - a.population)[0]
      : undefined;
    const genome = species
      ? summariseGenome(species)
      : this.genomeSummaryForNpc(star);

    const rng = this.rng.fork(`culture_${star.id}`);
    // A COPY, not the summary itself: `proceduralCulture` stores it as
    // `sourceGenome` BY REFERENCE. `gameState.playerSpecies` is REASSIGNED on
    // every evolution step, so a caller that re-derives and reuses a
    // `GenomeSummary` must never be able to reach into an already-built
    // `Civilization` and change what it recorded (ROADMAP M20b pattern).
    const base = proceduralCulture(
      { ...genome }, star.id, species?.id ?? `npc_${star.id}`,
      star.civName, this.tick, rng);
    gameState.civilizations[star.id] = base;

    // Upgrade in the background. A failure leaves the procedural record standing.
    const gemini = this.geminiService;
    if (!gemini || gemini.offlineMode) return;
    // Two guards, because neither is sufficient alone.
    //
    // `gameState.masterSeed` catches a different GAME: the player abandoned this
    // universe and started another whose star at the same id also reached
    // intelligence before this promise resolved.
    //
    // Object IDENTITY catches the same-seed case, which the seed check cannot
    // see. `Civilization.id` is `civ_${starId}` — a pure function of starId with
    // no per-generation nonce — so comparing ids would treat a throwaway record
    // and the real one as interchangeable. That matters because `enterUniverse`
    // and `applyLoadedSave` both re-run the deterministic tick-0 pre-seed on the
    // SAME seed and then restore the real data a line later: a late response
    // from the discarded pre-seed pass would pass a seed check and an id check
    // both, and silently overwrite the record just restored from the save.
    // Comparing against `base` itself fails closed — any replacement, even an
    // identical-looking one, is a different object.
    const seedAtCall = gameState.masterSeed;
    void generateCulture(base, genome, star.civName, TECH_LEVELS[star.civLevel] ?? 'Primitive', gemini)
      .then(result => {
        if (gameState.masterSeed === seedAtCall &&
            gameState.civilizations[star.id] === base) {
          gameState.civilizations[star.id] = result;
          this.onCultureGenerated?.(star.id, result);
        }
      });
  }

  /**
   * Drop a civilisation's culture so it is rebuilt from what the species is NOW.
   *
   * Called only on the four upheaval events named in the spec. The list is
   * closed on purpose: every entry costs a Gemini call, and a rule like "on any
   * civLevel change" would fire constantly.
   */
  private invalidateCulture(star: StarBody, reason: string): void {
    // Clearing and rebuilding are INDEPENDENT. Gating the rebuild on there
    // having been something to clear is what left the exodus refuge — a star
    // that is newly intelligent and so has no prior record — permanently
    // cultureless, the player's own world included.
    if (gameState.civilizations[star.id]) {
      delete gameState.civilizations[star.id];
      if (this.isStarKnownToPlayer(star)) {
        this.onCivEvent?.(`${star.civName} is remade in the wake of ${reason}.`);
      }
    }

    // Rebuild straight away, from what the species is NOW.
    //
    // Dropping the record without rebuilding it would be a regression, not a
    // feature: `ensureCivilization` is only reachable from `init`, a merger and
    // the climb to intelligence, and a war-defeated civilisation stays
    // `intelligent` — so it would never pass through any of them again and its
    // culture would be gone for the rest of the game. That would blank the
    // Culture panel and its Codex record, and silently drop the culture
    // modifiers on war, contact, religion and tech. It would also break the
    // invariant `ensureCivilization` documents: an intelligent civilisation
    // always has a record, so no caller has to handle a missing one.
    //
    // A star that is no longer intelligent is the exception and gets nothing: a
    // sterilised world reforming from magma, or one annihilated outright, has
    // no people to have a culture. Those callers invalidate AFTER demoting the
    // phase so this guard sees the new state.
    if (!star.isDead && star.biologyPhase === 'intelligent') {
      this.ensureCivilization(star);
    }
  }

  /**
   * A stand-in genome for an NPC world.
   *
   * Only the player's world runs the full evolution engine; NPC biospheres are
   * summarised by their archetype and tech tier rather than a real species list.
   */
  private genomeSummaryForNpc(star: StarBody): GenomeSummary {
    const rng = this.rng.fork(`npcgenome_${star.id}`);
    const env = rng.pick(['land', 'ocean', 'coastal', 'deep_sea', 'aerial']);
    return {
      speciesName: star.civName,
      metabolism: rng.pick(['heterotrophic', 'photosynthetic', 'chemosynthetic']),
      locomotion: rng.pick(['walking', 'swimming', 'crawling', 'flying', 'stationary']),
      environment: env,
      diet: rng.pick(['omnivore', 'carnivore', 'herbivore', 'producer']),
      respiration: rng.pick(['aerobic', 'anaerobic', 'mixed']),
      reproduction: rng.pick(['sexual', 'asexual', 'spore']),
      size: rng.pick(['small', 'medium', 'large']),
      bodyStructure: rng.pick(['vertebrate', 'exoskeletal', 'colonial', 'segmented']),
      sensorySystem: rng.pick(['vision', 'echolocation', 'chemoreception']),
      intelligence: rng.nextInt(6, 10),
      social: rng.nextInt(1, 10),
      aggression: rng.nextInt(0, 10),
      adaptability: rng.nextInt(2, 9),
      biome: env === 'ocean' || env === 'deep_sea' ? 'open_ocean' : 'grassland',
      temperatureRange: 'temperate',
    };
  }

  private fireLeaderMessage(star: StarBody, eventContext: string): void {
    const leader = gameState.leaders.find(l => l.starId === star.id);
    if (!leader) return;
    this.onLeaderMessage?.(leader, eventContext, star.id);
  }

  private spawnCosmicSignal(star: StarBody): void {
    if (!this.isStarKnownToPlayer(star)) return;
    const msgs = BigBangEngine.SIGNAL_MESSAGES;
    const raw  = msgs[this.rng.nextInt(0, msgs.length - 1)];
    const message = raw
      .replace('{civ}', star.civName)
      .replace('{dist}', String(this.rng.nextInt(4, 180)));
    this.cosmicSignals.push({
      id:        this._signalIdCounter++,
      starId:    star.id,
      civName:   star.civName,
      startTick: this.tick,
      decodedAt: this.tick + RADIO_DECODE_TICKS,
      message,
      fired:     false,
      decoded:   false,
    });
  }

  private updateCosmicSignals(): void {
    for (const sig of this.cosmicSignals) {
      if (!sig.fired) {
        sig.fired = true;
        this.onCosmicSignal?.(sig.civName, sig.starId);
      }
      if (!sig.decoded && this.tick >= sig.decodedAt) {
        sig.decoded = true;
        this.onSignalDecoded?.(sig.civName, sig.message);
      }
    }
    // Trim old decoded signals to prevent memory growth
    if (this.cosmicSignals.length > 50) {
      this.cosmicSignals = this.cosmicSignals.filter(s => !s.decoded).slice(-50);
    }
  }

  /**
   * Random investment across THIS universe's branches.
   *
   * Previously returned the eight fixed field names, which no longer exist —
   * an NPC civilisation now invests in whatever levers its universe offers.
   */
  private generateNPCDNA(): DNABranch {
    const out: DNABranch = {};
    const defs: BranchDef[] = runtimeState.branchDefs;
    for (const d of defs) out[d.id] = this.rng.nextInt(0, 9);
    return out;
  }

  private launchFleet(attacker: StarBody): void {
    const targets = this.stars.filter(s =>
      !s.isDead && s.id !== attacker.id && s.hasLife &&
      Math.abs(s.x - attacker.x) < 400 && Math.abs(s.y - attacker.y) < 400
    );
    if (targets.length === 0) return;

    const target = this.rng.pick(targets);
    const contactC = this.cultureFor(attacker);
    const hostile = this.rng.chance(Math.min(0.95, (this.stats.hostility / 25)
      * (contactC ? cultureMultiplier(contactC.values.xenophobia, 1) : 1)));

    this.fleets.push({
      id: this.fleetIdCounter++,
      fromStarId: attacker.id,
      toStarId: target.id,
      x: attacker.x, y: attacker.y,
      progress: 0,
      hostile,
      isPlayerFleet: attacker.isPlayerStar,
    });

    const knownAttacker = this.isStarKnownToPlayer(attacker);
    const knownTarget   = this.isStarKnownToPlayer(target);
    if (hostile) {
      if (knownAttacker || knownTarget) this.onWarEvent?.(attacker.civName, target.civName);
    } else {
      if (knownAttacker || knownTarget) this.onCivEvent?.(`${attacker.civName} launches exploration fleet toward ${target.civName}`);
    }

  }

  private updateFleets(): void {
    for (let i = this.fleets.length - 1; i >= 0; i--) {
      const fleet = this.fleets[i];
      fleet.progress += 0.003;

      const from = this.stars.find(s => s.id === fleet.fromStarId);
      const to = this.stars.find(s => s.id === fleet.toStarId);
      if (!from || !to || to.isDead) { this.fleets.splice(i, 1); continue; }

      fleet.x = from.x + (to.x - from.x) * fleet.progress;
      fleet.y = from.y + (to.y - from.y) * fleet.progress;

      if (fleet.progress >= 1) {
        // Arrival
        if (fleet.hostile) {
          // Check if a war with this pair is already active
          const alreadyAtWar = this.activeWars.some(
            w => !w.resolved &&
              ((w.attackerStarId === from.id && w.defenderStarId === to.id) ||
               (w.attackerStarId === to.id   && w.defenderStarId === from.id))
          );
          if (!alreadyAtWar) {
            const duration = Math.floor(
              250 + this.rng.nextFloat(0, 1) * 2250 * (1 + this.stats.hostility / 20)
            );
            const attackStr = Math.min(1, (from.civLevel + 1) / 9 + this.rng.nextFloat(-0.1, 0.1));
            const defendStr = Math.min(1, (to.civLevel   + 1) / 9 + this.rng.nextFloat(-0.1, 0.1));
            const war: War = {
              id: this.warIdCounter++,
              attackerStarId: from.id,
              defenderStarId: to.id,
              startTick: this.tick,
              duration,
              phase: 'skirmish',
              attackerStrength: attackStr,
              defenderStrength: defendStr,
              lastBattleReportTick: this.tick,
              resolved: false,
            };
            this.activeWars.push(war);
            this.exploredAreas.push({ x: to.x, y: to.y, r: 50 });
            this.spawnSiegeFleets(war, from, to);
            const known = this.isStarKnownToPlayer(from) || this.isStarKnownToPlayer(to);
            if (known) this.onWarStart?.(war, from, to);
          }
        } else if (!fleet.hostile) {
          // Exploration fleet reveals target
          this.exploredAreas.push({ x: to.x, y: to.y, r: 60 });
          // Directed panspermia: a visiting civilisation carries its own
          // biochemistry with it, and it still has to survive the destination.
          if (from.hasLife && !to.hasLife && !to.formationStage &&
              this.rng.chance(0.3 * this.habitabilityOf(to) *
                              (to.isNewSystem ? NEW_SYSTEM_PANSPERMIA_MOD : 1))) {
            this.igniteLife(to, to.bestPlanetIndex ?? 0);
            to.lifeArchetype = from.lifeArchetype ?? to.lifeArchetype;
          }
          // Religion spreads via peaceful contact
          if (from.religionName && !to.religionName && to.hasLife && this.rng.chance(0.25)) {
            to.religionName = from.religionName;
            to.religionDevotion = 0.08 + this.rng.nextFloat(0, 0.12);
            const known = this.isStarKnownToPlayer(from) || this.isStarKnownToPlayer(to);
            if (known) this.onReligionEvent?.(`The ${from.religionName} has spread from ${from.civName} to ${to.civName}.`);
          }
        }
        // Any fleet arrival (player or NPC) grants telescope on target planets
        if (fleet.isPlayerFleet) {
          to.planets.forEach(p => {
            if (p.discovery === 'none') p.discovery = 'telescope';
          });
          // High-tech player fleets get better data
          const ps = this.getPlayerStar();
          if (ps && ps.civLevel >= 5) {
            to.planets.forEach(p => {
              if (p.discovery === 'telescope') p.discovery = 'probe';
            });
          }
        }
        this.fleets.splice(i, 1);
      }
    }
  }

  // ── Orbital siege fleets ──────────────────────────────────────────────────

  private spawnSiegeFleets(war: War, attacker: StarBody, defender: StarBody): void {
    const civColor: string = CIV_COLORS[attacker.civLevel] ?? '#ff4444';
    const count = 2 + Math.floor(this.rng.nextFloat(0, 2.99)); // 2–4 ships
    const orbitRadius = defender.radius * 3.5 + 10;
    for (let i = 0; i < count; i++) {
      const startAngle = (i / count) * Math.PI * 2 + this.rng.nextFloat(-0.3, 0.3);
      const dir = this.rng.chance(0.5) ? 1 : -1;
      const speed = dir * this.rng.nextFloat(0.010, 0.018);
      this.orbitalFleets.push({
        id: this.orbitalFleetIdCounter++,
        warId: war.id,
        starId: defender.id,
        angle: startAngle,
        speed,
        orbitRadius,
        civColor,
      });
    }
  }

  private clearSiegeFleets(warId: number): void {
    this.orbitalFleets = this.orbitalFleets.filter(f => f.warId !== warId);
  }

  private updateOrbitalFleets(): void {
    for (const of_ of this.orbitalFleets) {
      of_.angle += of_.speed;
    }
  }

  /** Returns the active war involving the player's star, if any. */
  getPlayerWarState(): { war: War; attacker: StarBody; defender: StarBody } | null {
    const ps = this.getPlayerStar();
    if (!ps) return null;
    for (const war of this.activeWars) {
      if (war.resolved) continue;
      if (war.defenderStarId === ps.id || war.attackerStarId === ps.id) {
        const attacker = this.stars.find(s => s.id === war.attackerStarId);
        const defender = this.stars.find(s => s.id === war.defenderStarId);
        if (attacker && defender) return { war, attacker, defender };
      }
    }
    return null;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  render(dtMs?: number): void {
    // Advance in nominal 60Hz units so orbitalSpeed / VFX stay stable at any Hz.
    const nominalFrames = this.paceToWallClock
      ? (dtMs ?? 1000 / 60) / (1000 / 60)
      : 1;
    this.animTick += nominalFrames;
    if (this.suspendWorldDraw) return;
    const { width: W, height: H } = this.canvas;
    const ctx = this.ctx;

    if (this.pixiMode) {
      // Pixi owns the universe layer — this canvas is transparent except for
      // fog-of-war and screen-space effects drawn below.
      ctx.clearRect(0, 0, W, H);

      // Galaxy envelopes are drawn HERE, not inside the Canvas branch below.
      // `pixiMode` is true in the real game, so that branch never runs — it is
      // how faction flags and `drawStarTrails` silently died. Drawing on this
      // still-live canvas, in world space, keeps the tier visible in both modes.
      ctx.save();
      this.applyCamera(ctx, W, H);
      this.drawGalaxies(ctx);
      ctx.restore();
    } else {
      ctx.fillStyle = '#000008';
      ctx.fillRect(0, 0, W, H);

      // Background micro-stars (fixed to screen)
      this.drawBackgroundStars(ctx, W, H);

      ctx.save();
      this.applyCamera(ctx, W, H);

      this.drawNebulae(ctx);
      this.drawGalaxies(ctx);
      this.drawGalacticMedium(ctx);
      if (this.phase === 'inflation') this.drawStarTrails(ctx);
      this.drawTradeRoutes(ctx);
      this.drawStars(ctx);
      this.drawReligions(ctx);
      this.drawAsteroids(ctx);
      this.drawSystemDebris(ctx);
      this.drawFleets(ctx);
      this.drawOrbitalFleets(ctx);
      this.drawWars(ctx);
      this.drawPlanets(ctx);
      this.drawCosmicEffects(ctx);

      ctx.restore();
    }

    // Fog of war (screen-space) — always on this canvas regardless of pixiMode
    if (this.phase === 'settled') {
      this.drawFog(ctx, W, H);
    }

    // Home world arrival beacon (screen-space, fades after ~7s)
    if (this.phase === 'settled') {
      this.drawHomeWorldBeacon(ctx, W, H);
    }

    // Big Bang phase: draw inflation ring
    if (this.phase === 'inflation') {
      this.drawInflationRing(ctx, W, H);
    }

    // Notify Pixi renderer each frame
    this.onPixiFrame?.(this);
  }

  private applyCamera(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    ctx.translate(W / 2 - this.camera.x * this.camera.scale, H / 2 - this.camera.y * this.camera.scale);
    ctx.scale(this.camera.scale, this.camera.scale);
  }

  private worldToScreen(wx: number, wy: number, W: number, H: number): { x: number; y: number } {
    return {
      x: wx * this.camera.scale + (W / 2 - this.camera.x * this.camera.scale),
      y: wy * this.camera.scale + (H / 2 - this.camera.y * this.camera.scale),
    };
  }

  private settledSinceTick = 0;
  private tickAccumulator = 0;
  private animTick = 0;
  private settledSinceAnimTick = 0;
  /** True only while the RAF loop from start() is active. */
  private paceToWallClock = false;
  private lastFrameTime = 0;
  /** 0 = unlimited (display refresh). Otherwise max presented fps. */
  private targetFps = 0;
  private lastPresentTime = 0;

  private bgStarCache: Array<{ x: number; y: number; r: number }> = [];
  private bgStarCacheW = 0;
  private bgStarCacheH = 0;
  /** Pixel-art galaxy sprites (nearest-neighbour blit). Keyed by galaxy id. */
  private galaxySpriteCache = new Map<number, { canvas: HTMLCanvasElement; key: string }>();

  // ── Public accessors for PixiBigBangRenderer ────────────────────────────────
  get currentAnimTick(): number { return this.animTick; }
  get currentSettledSinceAnimTick(): number { return this.settledSinceAnimTick; }
  get currentCamera(): Camera { return { ...this.camera }; }
  get currentPlayerStarId(): number { return this.playerStarId; }
  get currentExploredAreas(): Array<{ x: number; y: number; r: number }> { return this.exploredAreas; }
  get currentSupernovaFlashes(): SupernovaFlash[] { return this.supernovaFlashes; }
  get currentRevelationFlashes(): RevelationFlash[] { return this.revelationFlashes; }
  get currentBgStarCache(): Array<{ x: number; y: number; r: number }> { return this.bgStarCache; }
  get currentBgStarCacheW(): number { return this.bgStarCacheW; }
  get currentBgStarCacheH(): number { return this.bgStarCacheH; }

  private drawBackgroundStars(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    if (this.bgStarCache.length === 0 || this.bgStarCacheW !== W || this.bgStarCacheH !== H) {
      const rng = new SeedRNG('bgstars');
      this.bgStarCache = [];
      for (let i = 0; i < 200; i++) {
        this.bgStarCache.push({
          x: (rng.next() * 9999 + i * 37) % W,
          y: (rng.next() * 9999 + i * 53) % H,
          r: rng.next() < 0.95 ? 0.5 : 1.2,
        });
      }
      this.bgStarCacheW = W;
      this.bgStarCacheH = H;
    }
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (const s of this.bgStarCache) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Soft elliptical envelopes around each galaxy, with its name.
   *
   * Only drawn at the tiers where a galaxy is the thing you are looking at:
   * fully at 'universe', fading out through 'galaxy', gone once you are down
   * among individual systems.
   *
   * Pixel-art: built on a tiny offscreen buffer (bulge + bar + spiral arms +
   * faint disc + halo speckles) and blitted with nearest-neighbour. No soft
   * radial gradients — those read as modern VFX, not a CRT observatory.
   */
  private drawGalaxies(ctx: CanvasRenderingContext2D): void {
    if (this.galaxies.length === 0) return;

    const sc = this.camera.scale;
    let strength = Math.max(0, Math.min(1, (1.8 - sc) / 1.5));

    if (this.phase === 'inflation') {
      strength = Math.max(strength, Math.min(1, this.tick / 90));
    }
    if (strength <= 0.01) return;

    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const pad = 80 / Math.max(0.01, sc);
    const halfW = (typeof window !== 'undefined' ? window.innerWidth : 1200) * 0.5 / Math.max(0.01, sc) + pad;
    const halfH = (typeof window !== 'undefined' ? window.innerHeight : 800) * 0.5 / Math.max(0.01, sc) + pad;
    for (const gal of this.galaxies) {
      if (gal.starIds.length === 0) continue;
      const size = gal.radius * 2.2;
      // Wider spacing grew envelopes a lot — skip blit if the disc is off-camera.
      if (
        Math.abs(gal.x - this.camera.x) > halfW + size * 0.5 ||
        Math.abs(gal.y - this.camera.y) > halfH + size * 0.5
      ) continue;
      const sprite = this.getGalaxySprite(gal);
      ctx.globalAlpha = Math.min(1, strength * 1.15);
      ctx.save();
      ctx.translate(gal.x, gal.y);
      ctx.rotate(gal.tilt);
      ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
      ctx.restore();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.restore();
    ctx.imageSmoothingEnabled = prevSmooth;

    // Labels, only while the galaxy tier is actually the subject.
    if (strength > 0.45) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = `${Math.max(7, 11 / sc)}px "Courier New", monospace`;
      for (const gal of this.galaxies) {
        if (gal.starIds.length === 0) continue;
        if (
          Math.abs(gal.x - this.camera.x) > halfW + gal.radius ||
          Math.abs(gal.y - this.camera.y) > halfH + gal.radius
        ) continue;
        ctx.fillStyle = this.hexA(gal.color, 0.75 * strength);
        ctx.fillText(gal.name, gal.x, gal.y - gal.radius * 0.72);
        ctx.fillStyle = this.hexA(gal.color, 0.4 * strength);
        ctx.font = `${Math.max(6, 8 / sc)}px "Courier New", monospace`;
        let alive = 0;
        for (const st of this.stars) {
          if (!st.isDead && st.galaxyId === gal.id) alive++;
        }
        ctx.fillText(`${alive} systems`, gal.x, gal.y - gal.radius * 0.72 + 10 / sc);
        ctx.font = `${Math.max(7, 11 / sc)}px "Courier New", monospace`;
      }
      ctx.textAlign = 'start';
      ctx.restore();
    }
  }

  /**
   * Build (or reuse) a chunky pixel sprite for a galaxy.
   * Resolution is fixed so zoom only nearest-neighbour scales it.
   */
  private getGalaxySprite(gal: Galaxy): HTMLCanvasElement {
    const RES = 128;
    // Radius is draw-scale only — baking in unit space. Keying on radius forced a
    // full 128² rebake every time smoothGalaxyRadii eased after a census (worse
    // with the wider M25 spacing), which felt like hitching at 1×.
    const key = `${gal.morph}|${gal.armCount}|${gal.armPitch.toFixed(2)}|${gal.barLength.toFixed(2)}|${gal.discFlat.toFixed(2)}|${gal.color}`;
    const hit = this.galaxySpriteCache.get(gal.id);
    if (hit && hit.key === key) return hit.canvas;

    const canvas = (typeof document !== 'undefined' && document.createElement)
      ? document.createElement('canvas')
      : ({ width: RES, height: RES, getContext: () => null } as unknown as HTMLCanvasElement);
    canvas.width = RES;
    canvas.height = RES;
    const gctx = canvas.getContext('2d');
    if (!gctx) {
      this.galaxySpriteCache.set(gal.id, { canvas, key });
      return canvas;
    }
    gctx.imageSmoothingEnabled = false;
    gctx.clearRect(0, 0, RES, RES);

    const [cr, cg, cb] = this.hexRGB(gal.color);
    // 4-step pixel palette: void dust → disc → arm → bulge core (chunky, high contrast)
    const shades: Array<[number, number, number, number]> = [
      [cr * 0.35, cg * 0.32, cb * 0.45, 0.45],
      [cr * 0.65, cg * 0.58, cb * 0.75, 0.72],
      [Math.min(255, cr * 1.05 + 50), Math.min(255, cg * 0.95 + 40), Math.min(255, cb * 0.85 + 30), 0.92],
      [Math.min(255, cr + 110), Math.min(255, cg + 100), Math.min(255, cb + 90), 1.0],
    ];

    const img = gctx.createImageData(RES, RES);
    const data = img.data;
    const rng = new SeedRNG(`galpx_${gal.id}_${gal.morph}`);

    for (let py = 0; py < RES; py++) {
      for (let px = 0; px < RES; px++) {
        // Local coords in [-1, 1], with disc flattening on Y.
        const u = (px + 0.5) / RES * 2 - 1;
        const v = ((py + 0.5) / RES * 2 - 1) / Math.max(0.25, gal.discFlat);
        const level = this.sampleGalaxyPixel(gal, u, v, rng);
        if (level < 0) continue;
        const [r, g, b, a] = shades[level];
        const i = (py * RES + px) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = Math.floor(a * 255);
      }
    }
    gctx.putImageData(img, 0, 0);
    this.galaxySpriteCache.set(gal.id, { canvas, key });
    return canvas;
  }

  /**
   * Pixel brightness class for one sample in galaxy-local unit space.
   * Returns -1 (empty), 0 dust, 1 disc, 2 arm/bar, 3 bulge.
   */
  private sampleGalaxyPixel(
    gal: Galaxy, u: number, v: number, rng: SeedRNG,
  ): number {
    const r = Math.hypot(u, v);
    if (r > 1.15) return -1;
    const theta = Math.atan2(v, u);

    // Halo — sparse speckles outside the main disc
    if (r > 0.92) {
      return rng.next() < 0.04 * (1.15 - r) * 8 ? 0 : -1;
    }

    // Bulge — dense bright core
    if (r < 0.14) {
      if (r < 0.06) return 3;
      return rng.next() < 0.85 ? 3 : 2;
    }

    // Bar (barred spirals)
    if (gal.barLength > 0 && r < gal.barLength * 1.05) {
      const along = Math.abs(u * Math.cos(0) + v * Math.sin(0)); // bar along local X before tilt
      // Bar is drawn in sprite space before world tilt — along u axis.
      const barHalfW = 0.07 + gal.barLength * 0.04;
      if (Math.abs(v) < barHalfW && along < gal.barLength) {
        return Math.abs(v) < barHalfW * 0.45 ? 3 : 2;
      }
    }

    // Spiral arms — wider, brighter ridges so they survive nearest-neighbour shrink
    if ((gal.morph === 'spiral' || gal.morph === 'barred') && gal.armCount > 0) {
      let bestArm = 99;
      for (let a = 0; a < gal.armCount; a++) {
        const armAng = a * (Math.PI * 2 / gal.armCount);
        const spiralTheta = armAng + Math.log(Math.max(0.08, r)) / Math.max(0.12, gal.armPitch);
        let dAng = theta - spiralTheta;
        dAng = ((dAng + Math.PI) % (Math.PI * 2)) - Math.PI;
        bestArm = Math.min(bestArm, Math.abs(dAng));
      }
      const armWidth = 0.32 + (1 - r) * 0.12;
      if (bestArm < armWidth * 0.42) return 2;
      if (bestArm < armWidth) return rng.next() < 0.7 ? 1 : 0;
    }

    // Lenticular / elliptical: smooth-ish falloff via dithered bands
    if (gal.morph === 'elliptical' || gal.morph === 'lenticular') {
      if (r < 0.35) return rng.next() < 0.7 ? 2 : 1;
      if (r < 0.65) return rng.next() < 0.5 ? 1 : 0;
      return rng.next() < 0.25 ? 0 : -1;
    }

    // Irregular: noisy clumps
    if (gal.morph === 'irregular') {
      const n = Math.sin(u * 9 + gal.id) * Math.cos(v * 11 + gal.id * 0.7);
      if (n > 0.35 && r < 0.85) return 2;
      if (n > 0.05 && r < 0.9) return rng.next() < 0.4 ? 1 : 0;
      return rng.next() < 0.06 ? 0 : -1;
    }

    // Inter-arm disc floor
    if (r < 0.85) return rng.next() < 0.22 * (1 - r) ? 0 : -1;
    return -1;
  }

  /**
   * Morphology sample that already clears MIN_STAR_SEPARATION, or null if this
   * galaxy cannot take another island without overlapping a neighbour.
   */
  private pickSeparatedPoint(
    gal: Galaxy,
    placed: Array<{ x: number; y: number; galaxyId: number }>,
  ): { x: number; y: number } | null {
    const mine = placed.filter(q => q.galaxyId === gal.id);
    if (mine.length === 0) return this.sampleGalaxyPoint(gal);
    for (let attempt = 0; attempt < 120; attempt++) {
      const p = this.sampleGalaxyPoint(gal);
      let minD = Infinity;
      for (const q of mine) {
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < minD) minD = d;
      }
      if (minD >= MIN_STAR_SEPARATION) return p;
    }
    return null;
  }

  /**
   * Push same-galaxy targets apart in world space so solar-system envelopes
   * stay islands. Grows the galaxy disc (capped) when the census needs room.
   */
  private relaxStarTargets(
    gal: Galaxy,
    pts: Array<{ x: number; y: number; galaxyId: number }>,
    envelopeCap: number,
  ): void {
    const mine = pts.filter(p => p.galaxyId === gal.id);
    if (mine.length < 2) return;
    const minSep = MIN_STAR_SEPARATION;
    for (let iter = 0; iter < 80; iter++) {
      let maxOverlap = 0;
      for (let i = 0; i < mine.length; i++) {
        for (let j = i + 1; j < mine.length; j++) {
          const dx = mine[j].x - mine[i].x;
          const dy = mine[j].y - mine[i].y;
          const d = Math.hypot(dx, dy) || 0.01;
          if (d >= minSep) continue;
          maxOverlap = Math.max(maxOverlap, minSep - d);
          const push = (minSep - d) * 0.52 / d;
          mine[i].x -= dx * push;
          mine[i].y -= dy * push;
          mine[j].x += dx * push;
          mine[j].y += dy * push;
        }
      }
      for (const p of mine) {
        const dx = p.x - gal.cx, dy = p.y - gal.cy;
        const r = Math.hypot(dx, dy);
        const cap = gal.radius * 0.95;
        if (r > cap && r > 0) {
          p.x = gal.cx + dx / r * cap;
          p.y = gal.cy + dy / r * cap;
        }
      }
      if (maxOverlap < 0.5) break;
      if (iter % 8 === 7 && maxOverlap > 1) {
        gal.radius = Math.min(envelopeCap, gal.radius * 1.1);
        gal.tRadius = gal.radius;
      }
    }

    let closest = Infinity;
    for (let i = 0; i < mine.length; i++) {
      for (let j = i + 1; j < mine.length; j++) {
        closest = Math.min(closest, Math.hypot(mine[j].x - mine[i].x, mine[j].y - mine[i].y));
      }
    }
    if (closest >= minSep * 0.98) return;

    // Disc was too tight even after growing — sit them on a ring so the floor holds.
    const n = mine.length;
    const needR = (minSep / 2) / Math.sin(Math.PI / n);
    gal.radius = Math.min(envelopeCap, Math.max(gal.radius, needR * 1.15));
    gal.tRadius = gal.radius;
    const polar = mine.map(p => ({
      p,
      a: Math.atan2(p.y - gal.cy, p.x - gal.cx),
    }));
    polar.sort((a, b) => a.a - b.a);
    const ringR = Math.min(gal.radius * 0.92, Math.max(needR, gal.radius * 0.62));
    const slot = (Math.PI * 2) / n;
    const start = polar[0].a;
    for (let i = 0; i < polar.length; i++) {
      polar[i].p.x = gal.cx + Math.cos(start + i * slot) * ringR;
      polar[i].p.y = gal.cy + Math.sin(start + i * slot) * ringR;
    }
  }

  /**
   * Pick a world-space point inside a galaxy following its morphology.
   * Bulge / bar / arms / disc / halo — not area-uniform.
   */
  private sampleGalaxyPoint(gal: Galaxy): { x: number; y: number } {
    const roll = this.rng.next();
    let lx = 0, ly = 0;
    const R = gal.radius;

    const toWorld = (x: number, y: number) => {
      // Apply disc flattening then tilt into world space.
      const fy = y * gal.discFlat;
      const c = Math.cos(gal.tilt), s = Math.sin(gal.tilt);
      return { x: gal.x + x * c - fy * s, y: gal.y + x * s + fy * c };
    };

    if (gal.morph === 'elliptical' || gal.morph === 'lenticular') {
      const t = this.rng.nextFloat(0, Math.PI * 2);
      // Concentrated toward centre
      const rr = R * Math.pow(this.rng.next(), 0.55) * (gal.morph === 'lenticular' ? 0.95 : 0.85);
      return toWorld(Math.cos(t) * rr, Math.sin(t) * rr);
    }

    if (gal.morph === 'irregular') {
      const clump = this.rng.nextInt(0, 3);
      const cx = Math.cos(clump * 1.7 + gal.id) * R * 0.35;
      const cy = Math.sin(clump * 2.1 + gal.id) * R * 0.35;
      const t = this.rng.nextFloat(0, Math.PI * 2);
      const rr = R * this.rng.nextFloat(0.05, 0.4);
      return toWorld(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr);
    }

    // Spiral / barred
    if (roll < 0.14) {
      // Bulge
      const t = this.rng.nextFloat(0, Math.PI * 2);
      const rr = R * 0.14 * Math.sqrt(this.rng.next());
      lx = Math.cos(t) * rr; ly = Math.sin(t) * rr;
    } else if (gal.barLength > 0 && roll < 0.28) {
      // Bar
      const along = this.rng.nextFloat(-gal.barLength, gal.barLength) * R;
      const side = this.rng.nextFloat(-0.06, 0.06) * R;
      lx = along; ly = side;
    } else if (roll < 0.82 && gal.armCount > 0) {
      // Spiral arm
      const arm = this.rng.nextInt(0, gal.armCount - 1);
      const armAng = arm * (Math.PI * 2 / gal.armCount);
      const rr = R * this.rng.nextFloat(0.16, 0.95);
      const spiralTheta = armAng + Math.log(Math.max(0.08, rr / R)) / Math.max(0.12, gal.armPitch);
      const jitter = this.rng.nextFloat(-0.12, 0.12);
      lx = Math.cos(spiralTheta + jitter) * rr;
      ly = Math.sin(spiralTheta + jitter) * rr;
    } else if (roll < 0.93) {
      // Inter-arm disc
      const t = this.rng.nextFloat(0, Math.PI * 2);
      const rr = R * Math.sqrt(this.rng.nextFloat(0.1, 0.85));
      lx = Math.cos(t) * rr; ly = Math.sin(t) * rr;
    } else {
      // Halo
      const t = this.rng.nextFloat(0, Math.PI * 2);
      const rr = R * this.rng.nextFloat(0.9, 1.2);
      lx = Math.cos(t) * rr; ly = Math.sin(t) * rr;
    }

    return toWorld(lx, ly);
  }

  /** '#rrggbb' → [r,g,b]. */
  private hexRGB(hex: string): [number, number, number] {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /** '#rrggbb' + alpha → rgba() string. */
  private hexA(hex: string, a: number): string {
    const [r, g, b] = this.hexRGB(hex);
    return `rgba(${r},${g},${b},${a})`;
  }

  private drawNebulae(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const n of this.nebulae) {
      const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.radius);
      grad.addColorStop(0, `rgba(${n.r},${n.g},${n.b},${n.alpha * 0.8})`);
      grad.addColorStop(0.5, `rgba(${n.r},${n.g},${n.b},${n.alpha * 0.3})`);
      grad.addColorStop(1, `rgba(${n.r},${n.g},${n.b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawTradeRoutes(ctx: CanvasRenderingContext2D): void {
    if (this.phase !== 'settled') return;
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = '#7b5ea7';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([3, 6]);

    const active = this.stars.filter(s => !s.isDead && s.civLevel >= 5);
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i], b = active[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        if (Math.sqrt(dx * dx + dy * dy) < 300) {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawStars(ctx: CanvasRenderingContext2D): void {
    const prevSmooth = ctx.imageSmoothingEnabled;

    for (const star of this.stars) {
      if (star.isDead) {
        const kind = star.remnantKind ?? 'white_dwarf';
        const size = Math.max(star.radius * 2.4, 1.5);
        if (kind === 'black_hole') {
          ctx.beginPath();
          ctx.arc(star.x, star.y, size * 0.9, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,120,60,0.5)';
          ctx.lineWidth = Math.max(0.35, 0.7 / this.camera.scale);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(star.x, star.y, size * 0.42, 0, Math.PI * 2);
          ctx.fillStyle = '#040406';
          ctx.fill();
        } else {
          const band = kind === 'neutron' ? 'blue' : 'white';
          const glow = bakeStarGlow(band, 160);
          const body = bakeStarBody(band, 48);
          const gSize = size * (kind === 'neutron' ? 2.2 : 1.8);
          const bSize = size * (kind === 'neutron' ? 0.7 : 0.85);
          ctx.imageSmoothingEnabled = true;
          ctx.globalAlpha = kind === 'neutron' ? 0.45 : 0.28;
          ctx.drawImage(glow, star.x - gSize / 2, star.y - gSize / 2, gSize, gSize);
          ctx.imageSmoothingEnabled = false;
          ctx.globalAlpha = kind === 'neutron' ? 0.95 : 0.75;
          ctx.drawImage(body, star.x - bSize / 2, star.y - bSize / 2, bSize, bSize);
          ctx.globalAlpha = 1;
        }
        continue;
      }

      const band = starTempBand(star.temperature);
      const profile = starVisualProfile(band);
      const size = Math.max(star.radius * 3.4, 2.2);
      const pulse = 1 + profile.pulseAmp * Math.sin(this.animTick * profile.pulseSpeed + star.id);

      const glow = bakeStarGlow(band, 160);
      ctx.imageSmoothingEnabled = true;
      const hazeSize = size * profile.hazeMul * pulse;
      ctx.globalAlpha = profile.hazeAlpha * (0.85 + 0.15 * pulse);
      ctx.drawImage(glow, star.x - hazeSize / 2, star.y - hazeSize / 2, hazeSize, hazeSize);
      const glowSize = size * profile.glowMul * pulse;
      ctx.globalAlpha = Math.min(1, profile.glowAlpha * pulse) * 0.55;
      ctx.drawImage(glow, star.x - glowSize / 2, star.y - glowSize / 2, glowSize, glowSize);
      ctx.globalAlpha = 1;

      ctx.imageSmoothingEnabled = false;
      const sunSeed = 5 + (star.id % 3);
      const corona = bakeStarCorona(band, 80, sunSeed);
      const coronaSize = size * (0.30 / CORONA_BODY_FRAC) * (1 + 0.05 * Math.sin(this.animTick * profile.pulseSpeed * 1.7 + star.id));
      const spinMul = 0.45 + ((star.id * 47) % 97) / 97 * 1.1;
      const spinDir = (star.id * 13) & 1 ? 1 : -1;
      const rot = this.animTick * profile.coronaSpeed * spinMul * spinDir + star.id * 1.918;
      ctx.save();
      ctx.translate(star.x, star.y);
      ctx.rotate(rot);
      ctx.globalAlpha = 0.85 + 0.15 * Math.sin(
        this.animTick * profile.pulseSpeed * (0.7 + (star.id % 5) * 0.08) + star.id * 0.3,
      );
      ctx.drawImage(corona, -coronaSize / 2, -coronaSize / 2, coronaSize, coronaSize);
      ctx.restore();
      ctx.globalAlpha = 1;

      const spr = bakeStarBody(band, 48, Math.floor(this.animTick / 15 + star.id * 3) % STAR_BODY_FRAMES, sunSeed);
      const bodyPulse = 1 + profile.pulseAmp * 0.35 * Math.sin(this.animTick * profile.pulseSpeed * 0.8);
      const body = size * bodyPulse;
      ctx.drawImage(spr, star.x - body / 2, star.y - body / 2, body, body);

      if (star.isPlayerStar) {
        const alpha = 0.55 + 0.25 * Math.sin(this.animTick * 0.05);
        // Corner brackets outside the corona (matches PixiBigBangRenderer).
        const pad = size * 0.78;
        const t = Math.max(0.5, 0.9 / this.camera.scale);
        const arm = pad * 0.32;
        ctx.fillStyle = `rgba(255,204,68,${alpha})`;
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            const x = star.x + sx * pad, y = star.y + sy * pad;
            ctx.fillRect(sx < 0 ? x : x - arm, sy < 0 ? y : y - t, arm, t);
            ctx.fillRect(sx < 0 ? x : x - t, sy < 0 ? y : y - arm, t, arm);
          }
        }
      }

      if (star.hasLife && star.civLevel > 0 && this.phase === 'settled') {
        const civColor = CIV_COLORS[Math.min(star.civLevel, CIV_COLORS.length - 1)];
        ctx.fillStyle = civColor;
        const ringR = size * 0.38;
        const step = Math.max(0.12, 2.2 / Math.max(ringR, 1));
        const dot = Math.max(0.45, 0.7 / this.camera.scale);
        ctx.globalAlpha = 0.7;
        for (let a = 0; a < Math.PI * 2; a += step) {
          ctx.fillRect(
            star.x + Math.cos(a) * ringR - dot / 2,
            star.y + Math.sin(a) * ringR - dot / 2,
            dot, dot,
          );
        }
        ctx.globalAlpha = 1;
      }

      if (this.phase === 'settled' && star.hasLife && star.civLevel >= 1) {
        const flag = gameState.factionFlags[star.id];
        if (flag && this.camera.scale >= 0.6) {
          drawFactionFlag(ctx, flag, star.x, star.y - star.radius * 5 - 4, 6);
        }
      }
    }
    ctx.imageSmoothingEnabled = prevSmooth;
  }

  private drawAsteroids(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = '#aaaaaa';
    ctx.save();
    ctx.globalAlpha = 0.6;
    for (const ast of this.asteroids) {
      ctx.beginPath();
      ctx.arc(ast.x, ast.y, ast.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Canvas fallback: dust lanes between systems (Pixi owns the live path). */
  private drawGalacticMedium(ctx: CanvasRenderingContext2D): void {
    const sc = this.camera.scale;
    if (sc < 0.18 || sc > 4.2) return;
    let visibility = 1;
    if (sc < 0.45) visibility = (sc - 0.18) / 0.27;
    else if (sc > 2.2) visibility = Math.max(0, 1 - (sc - 2.2) / 2.0);
    if (visibility <= 0.02) return;

    const spin = this.animTick * 0.00035;
    ctx.save();
    for (const gal of this.galaxies) {
      if (gal.radius < 8) continue;
      const [cr, cg, cb] = this.hexRGB(gal.color);
      let s = (gal.id * 2654435761) >>> 0;
      const rand = () => { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff; };
      const flat = Math.max(0.35, gal.discFlat);
      const cosT = Math.cos(gal.tilt), sinT = Math.sin(gal.tilt);
      for (let i = 0; i < 90; i++) {
        const rFrac = 0.18 + Math.pow(rand(), 0.65) * 0.78;
        const a0 = rand() * Math.PI * 2;
        const r = rFrac * gal.radius;
        const ang = a0 + spin * (0.55 + (1 - rFrac) * 0.8);
        const lx = Math.cos(ang) * r;
        const ly = Math.sin(ang) * r * flat;
        const wx = gal.cx + lx * cosT - ly * sinT;
        const wy = gal.cy + lx * sinT + ly * cosT;
        const isRock = i % 5 === 0;
        ctx.globalAlpha = visibility * (isRock ? 0.4 : 0.18);
        ctx.fillStyle = isRock ? '#9a9080' : `rgb(${Math.min(255, cr + 40)},${Math.min(255, cg + 30)},${Math.min(255, cb + 55)})`;
        const sz = isRock ? 0.7 : 0.45;
        ctx.fillRect(wx - sz / 2, wy - sz / 2, sz, sz);
      }
    }
    ctx.restore();
  }

  /** Canvas fallback: per-system belts + outer dust. */
  private drawSystemDebris(ctx: CanvasRenderingContext2D): void {
    if (this.camera.scale < 0.85) return;
    const sc = this.camera.scale;
    ctx.save();
    for (const star of this.stars) {
      if (star.isDead || star.planets.length === 0) continue;
      if (!star.isPlayerStar && sc < 1.15) continue;
      let outer = 0;
      for (const p of star.planets) if (p.orbitalRadius > outer) outer = p.orbitalRadius;
      if (outer < 4) outer = star.radius * 8;

      const dustR = outer * 1.18;
      const dustDots = star.isPlayerStar ? 48 : 28;
      const dustSpin = this.animTick * 0.0011;
      ctx.fillStyle = '#b8a878';
      for (let i = 0; i < dustDots; i++) {
        const a = (i / dustDots) * Math.PI * 2 + dustSpin + star.id * 0.17;
        const jitter = 0.92 + ((i * 37 + star.id * 13) % 11) * 0.012;
        const x = star.x + Math.cos(a) * dustR * jitter;
        const y = star.y + Math.sin(a) * dustR * jitter;
        ctx.globalAlpha = (star.isPlayerStar ? 0.22 : 0.12) * (0.55 + (i % 3) * 0.15);
        const sz = Math.max(0.2 / sc, 0.28);
        ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
      }

      if (!star.asteroidBelt || sc < 1.05) continue;
      const dens = Math.max(0.15, star.asteroidBeltDensity ?? 0.5);
      const beltR = Math.max(outer * 0.55, star.radius * 5);
      const beltW = Math.max(0.8, outer * (0.04 + dens * 0.1));
      const rocks = Math.max(4, Math.floor((star.isPlayerStar ? 28 : 16) * dens));
      const beltSpin = this.animTick * 0.0024;
      for (let i = 0; i < rocks; i++) {
        const a = (i / rocks) * Math.PI * 2 + beltSpin + star.id * 0.31;
        const rr = beltR + Math.sin(i * 2.7 + star.id) * beltW;
        const x = star.x + Math.cos(a) * rr;
        const y = star.y + Math.sin(a) * rr;
        const sz = Math.max(0.35 / sc, 0.4 + (i % 4) * 0.16 * dens);
        ctx.globalAlpha = 0.55 + dens * 0.3;
        ctx.fillStyle = i % 3 === 0 ? '#a89878' : '#887868';
        ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
      }
    }
    ctx.restore();
  }

  private drawFleets(ctx: CanvasRenderingContext2D): void {
    for (const fleet of this.fleets) {
      const from = this.stars.find(s => s.id === fleet.fromStarId);
      const to = this.stars.find(s => s.id === fleet.toStarId);
      if (!from || !to) continue;

      // Draw path line
      ctx.save();
      ctx.globalAlpha = 0.15;
      ctx.strokeStyle = fleet.hostile ? '#ff4422' : '#44ccff';
      ctx.lineWidth = 0.6;
      ctx.setLineDash([4, 8]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw ship triangle
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = fleet.hostile ? '#ff6644' : '#44aaff';
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 4;
      ctx.save();
      ctx.translate(fleet.x, fleet.y);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(3, 0);
      ctx.lineTo(-2, 1.5);
      ctx.lineTo(-2, -1.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.restore();
    }
  }

  private drawOrbitalFleets(ctx: CanvasRenderingContext2D): void {
    if (this.phase !== 'settled') return;

    for (const of_ of this.orbitalFleets) {
      const star = this.stars.find(s => s.id === of_.starId);
      if (!star || !this.isStarKnownToPlayer(star)) continue;

      const sx = star.x, sy = star.y;
      const screenOrbitR = of_.orbitRadius;

      // Faint orbit ring on first fleet for this star
      if (this.orbitalFleets.findIndex(f => f.starId === of_.starId) === this.orbitalFleets.indexOf(of_)) {
        ctx.save();
        ctx.globalAlpha = 0.18;
        ctx.strokeStyle = of_.civColor;
        ctx.lineWidth = 0.8 / this.camera.scale;
        ctx.setLineDash([3 / this.camera.scale, 6 / this.camera.scale]);
        ctx.beginPath();
        ctx.arc(sx, sy, screenOrbitR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      const fx = sx + Math.cos(of_.angle) * screenOrbitR;
      const fy = sy + Math.sin(of_.angle) * screenOrbitR;
      // Ship faces along its orbital tangent
      const tangent = of_.angle + (of_.speed >= 0 ? Math.PI / 2 : -Math.PI / 2);

      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = of_.civColor;
      ctx.shadowColor = of_.civColor;
      ctx.shadowBlur = 6;
      ctx.translate(fx, fy);
      ctx.rotate(tangent);
      ctx.beginPath();
      ctx.moveTo(4 / this.camera.scale, 0);
      ctx.lineTo(-3 / this.camera.scale, 2 / this.camera.scale);
      ctx.lineTo(-3 / this.camera.scale, -2 / this.camera.scale);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  private drawWars(ctx: CanvasRenderingContext2D): void {
    if (this.phase !== 'settled') return;

    for (const war of this.activeWars) {
      if (war.resolved) continue;

      const defender = this.stars.find(s => s.id === war.defenderStarId);
      const attacker = this.stars.find(s => s.id === war.attackerStarId);
      if (!defender || !attacker) continue;

      const dx = defender.x, dy = defender.y;
      const screenR = defender.radius;
      const progress = (this.tick - war.startTick) / war.duration;

      // ── Siege ring: pulsing red ring around the defender ─────────────
      const pulseSpeed = war.phase === 'siege' ? 0.12 : 0.06;
      const pulse = 0.5 + 0.5 * Math.sin(this.animTick * pulseSpeed);
      const ringAlpha = (war.phase === 'siege' ? 0.75 : war.phase === 'campaign' ? 0.5 : 0.3) * pulse;
      const ringR = screenR * (war.phase === 'siege' ? 2.8 : 2.2);

      ctx.save();
      ctx.strokeStyle = `rgba(255, 60, 60, ${ringAlpha})`;
      ctx.lineWidth = (war.phase === 'siege' ? 1.5 : 1.0) / this.camera.scale;
      ctx.shadowColor = 'rgba(255, 80, 40, 0.8)';
      ctx.shadowBlur = war.phase === 'siege' ? 8 : 4;
      ctx.beginPath();
      ctx.arc(dx, dy, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // ── Battle arc: partial arc on the attacker side ──────────────────
      if (war.phase === 'campaign' || war.phase === 'siege') {
        const ax = attacker.x, ay = attacker.y;
        const angleToAttacker = Math.atan2(ay - dy, ax - dx);
        const arcSpread = war.phase === 'siege' ? 1.2 : 0.7;
        const battleAlpha = 0.35 * pulse;
        ctx.save();
        ctx.strokeStyle = `rgba(255, 120, 40, ${battleAlpha})`;
        ctx.lineWidth = 1.2 / this.camera.scale;
        ctx.setLineDash([3 / this.camera.scale, 5 / this.camera.scale]);
        ctx.beginPath();
        ctx.arc(dx, dy, ringR * 1.25, angleToAttacker - arcSpread, angleToAttacker + arcSpread);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // ── War label at low zoom ─────────────────────────────────────────
      if (this.camera.scale > 0.4) {
        const label = war.phase === 'siege' ? '⚔ SIEGE' : war.phase === 'campaign' ? '⚔ WAR' : '⚔';
        ctx.save();
        ctx.fillStyle = `rgba(255, 100, 80, ${0.5 + 0.4 * pulse})`;
        ctx.font = `bold ${Math.max(8, 10 / this.camera.scale)}px Cinzel, serif`;
        ctx.textAlign = 'center';
        ctx.fillText(label, dx, dy - screenR * 2.2 - 6 / this.camera.scale);
        ctx.restore();
      }

      // ── Progress bar below defender (shows war duration progress) ─────
      if (this.camera.scale > 0.8) {
        const barW = screenR * 5;
        const barH = Math.max(2, 2 / this.camera.scale);
        const bx = dx - barW / 2, by = dy + screenR * 2.5;
        ctx.save();
        ctx.fillStyle = 'rgba(60, 60, 60, 0.6)';
        ctx.fillRect(bx, by, barW, barH);
        // Attacker portion (red) vs defender portion (blue)
        const attackFill = barW * war.attackerStrength;
        ctx.fillStyle = `rgba(220, 60, 60, 0.8)`;
        ctx.fillRect(bx, by, attackFill, barH);
        ctx.fillStyle = `rgba(60, 100, 220, 0.8)`;
        ctx.fillRect(bx + attackFill, by, barW - attackFill, barH);
        // Overall progress tick (white line)
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillRect(bx + barW * progress - 0.5 / this.camera.scale, by - 1 / this.camera.scale, 1.5 / this.camera.scale, barH + 2 / this.camera.scale);
        ctx.restore();
      }
    }
  }

  private drawCosmicEffects(ctx: CanvasRenderingContext2D): void {
    const W = this.canvas.width, H = this.canvas.height;
    for (let i = this.supernovaFlashes.length - 1; i >= 0; i--) {
      const flash = this.supernovaFlashes[i];
      const age = this.animTick - flash.startAnimTick;
      const duration = 120;
      if (age > duration) { this.supernovaFlashes.splice(i, 1); continue; }

      const t = age / duration;
      const { x, y } = this.worldToScreen(flash.x, flash.y, W, H);

      // Inner white flash (fast)
      if (t < 0.3) {
        const innerAlpha = (1 - t / 0.3) * 0.9;
        const innerR = flash.maxRadius * this.camera.scale * t * 3;
        const g = ctx.createRadialGradient(x, y, 0, x, y, innerR);
        g.addColorStop(0, `rgba(255,255,240,${innerAlpha})`);
        g.addColorStop(0.4, `rgba(255,200,100,${innerAlpha * 0.6})`);
        g.addColorStop(1, 'rgba(255,100,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, innerR, 0, Math.PI * 2);
        ctx.fill();
      }

      // Expanding shockwave ring
      const ringR = flash.maxRadius * this.camera.scale * t;
      const ringAlpha = Math.max(0, 1 - t * 1.2);
      ctx.save();
      ctx.strokeStyle = `rgba(255,160,60,${ringAlpha * 0.8})`;
      ctx.lineWidth = Math.max(1, (1 - t) * 6);
      ctx.shadowColor = 'rgba(255,120,40,0.9)';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(x, y, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Outer debris ring (slower, fades late)
      const debrisR = flash.maxRadius * this.camera.scale * t * 0.6;
      const debrisAlpha = Math.max(0, (0.7 - t) * 1.4);
      if (debrisAlpha > 0) {
        ctx.save();
        ctx.strokeStyle = `rgba(200,120,60,${debrisAlpha})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 6]);
        ctx.beginPath();
        ctx.arc(x, y, debrisR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
  }

  private drawPlanets(ctx: CanvasRenderingContext2D): void {
    if (this.phase !== 'settled') return;
    if (this.camera.scale < 0.5) return;

    const playerStar = this.getPlayerStar();

    for (const star of this.stars) {
      if (star.planets.length === 0) continue;
      const isPlayer = star === playerStar;
      if (star.isDead) {
        if (this.camera.scale < 1.4) continue;
      } else if (!isPlayer && this.camera.scale < 1.2) {
        continue;
      }

      for (const [i, p] of star.planets.entries()) {
        const off = planetOffsetFromStar(p, this.animTick);
        const px = star.x + off.x;
        const py = star.y + off.y;

        // ── Orbit ring (dotted pixels; elliptical when e > 0) ──────────────
        ctx.save();
        ctx.fillStyle = star.isDead
          ? 'rgba(100, 100, 90, 0.2)'
          : isPlayer
            ? 'rgba(200, 169, 110, 0.45)'
            : 'rgba(180, 200, 255, 0.22)';
        const aMean = Math.max(p.orbitalRadius, 1);
        const step = Math.max(0.1, 2.0 / aMean);
        const dot = Math.max(0.45, 0.7 / this.camera.scale);
        for (let a = 0; a < Math.PI * 2; a += step) {
          const probe = planetOffsetFromStar(
            { ...p, orbitalAngle: a, orbitalSpeed: 0 },
            0,
          );
          ctx.fillRect(
            star.x + probe.x - dot / 2,
            star.y + probe.y - dot / 2,
            dot, dot,
          );
        }
        ctx.restore();

        // ── Minimum visible radius (at least 2px on screen) ────────────────
        const displayR = Math.max(p.radius, 2 / this.camera.scale);
        const body = displayR * 2;

        // ── Planet core — terrain globe when close (matches surface bake) ──
        const screenR = displayR * this.camera.scale;
        const useGlobe = this.camera.scale >= 1.6 || screenR >= 10;
        ctx.save();
        ctx.imageSmoothingEnabled = false;

        const homeIdx = star.isPlayerStar ? (star.bestPlanetIndex ?? 0) : -1;
        const isHome = star.isPlayerStar && i === homeIdx;
        const dna = isHome
          ? (gameState.playerPlanetDNA ?? p.dna ?? DEFAULT_PLANET_DNA)
          : (p.dna ?? DEFAULT_PLANET_DNA);
        const bioPhase = (isHome && p.hasLife)
          ? (star.biologyPhase ?? null) : null;
        const grid = isHome ? runtimeState.playerPlanetGrid : null;
        const formingHome = !!grid && !!star.formationDestiny && !!star.formationStage;
        const kind = (formingHome ? 'lava' : p.type) as CosmicPlanetKind;
        const withRings = kind === 'gas';
        const seed = (star.id * 17 + i * 31) | 0;

        if (useGlobe) {
          const texKey = `globe_${star.id}_${i}_${kind}_${grid ? star.formationStage ?? '' : ''}_${p.hasLife ? 1 : 0}_${dna.climate}_${dna.oceans}_${dna.chaos}_${bioPhase ?? ''}`;
          let globe = this.planetTextureCache.get(texKey);
          if (!globe) {
            const equirect = bakePlanetTexture(star.id, i, kind, dna, 96, bioPhase, grid);
            globe = wrapEquirectToGlobe(equirect, 48, {
              rings: withRings,
              ringTint: parseHexColor(p.color, [200, 190, 160]),
              seed: seed ^ (p.hasLife ? 997 : 0),
            });
            this.planetTextureCache.set(texKey, globe);
          }
          if (withRings) {
            ctx.drawImage(globe, px - body * 0.925, py - body * 0.575, body * 1.85, body * 1.15);
          } else {
            ctx.drawImage(globe, px - body / 2, py - body / 2, body, body);
          }
        } else {
          const spr = bakePlanetSprite(kind, p.hasLife, {
            size: 24, seed, colorHex: p.color, rings: withRings,
          });
          if (withRings) {
            ctx.drawImage(spr, px - body * 0.925, py - body * 0.575, body * 1.85, body * 1.15);
          } else {
            ctx.drawImage(spr, px - body / 2, py - body / 2, body, body);
          }
        }
        ctx.restore();

        // Moons — large moons stay readable earlier (future colony targets).
        if (p.moons.length > 0) {
          for (const moon of p.moons) {
            const large = moon.radius >= p.radius * 0.4;
            if (!large && this.camera.scale < 0.85) continue;
            if (large && this.camera.scale < 0.55) continue;
            const ma = moon.orbitalAngle + this.animTick * moon.orbitalSpeed;
            const orbit = Math.max(moon.orbitalRadius, displayR * (large ? 2.1 : 1.7));
            const mx = px + Math.cos(ma) * orbit;
            const my = py + Math.sin(ma) * orbit;
            const mSpr = bakeMoonSprite(moon.kind as CosmicMoonKind, 8);
            const mSize = Math.max(
              moon.radius * (large ? 3.6 : 2.8),
              (large ? 1.6 : 0.9) / this.camera.scale,
            );
            ctx.drawImage(mSpr, mx - mSize / 2, my - mSize / 2, mSize, mSize);
          }
        }

        // ── Biosphere pulse — dotted pixel ring ────────────────────────────
        if (p.hasLife) {
          const pulse = 0.5 + 0.4 * Math.sin(this.animTick * 0.05);
          ctx.fillStyle = `rgba(60, 220, 100, ${pulse * 0.55})`;
          const ringR = displayR * 1.55;
          const step = Math.max(0.15, 2.4 / Math.max(ringR, 1));
          const dot = Math.max(0.4, 0.65 / this.camera.scale);
          for (let a = 0; a < Math.PI * 2; a += step) {
            ctx.fillRect(
              px + Math.cos(a) * ringR - dot / 2,
              py + Math.sin(a) * ringR - dot / 2,
              dot, dot,
            );
          }
        }

        // ── HOME label (player's living planet, high zoom only) ───────────
        if (isPlayer && p.hasLife && this.camera.scale > 2) {
          ctx.save();
          ctx.fillStyle = 'rgba(180, 255, 200, 0.85)';
          ctx.font = `${8 / this.camera.scale}px Cinzel, serif`;
          ctx.textAlign = 'center';
          ctx.fillText('HOME', px, py - displayR * 3.5);
          ctx.restore();
        }
      }
    }
  }

  private drawStarTrails(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const star of this.stars) {
      if (star.isDead) continue;
      const speed = Math.sqrt(star.vx * star.vx + star.vy * star.vy);
      if (speed < 0.5) continue;
      const alpha = Math.min(speed / 10, 0.45);
      const trailLen = speed * 5;
      ctx.strokeStyle = `rgba(255, 210, 120, ${alpha})`;
      ctx.lineWidth = star.radius * 0.5;
      ctx.beginPath();
      ctx.moveTo(star.x, star.y);
      ctx.lineTo(
        star.x - (star.vx / speed) * trailLen,
        star.y - (star.vy / speed) * trailLen,
      );
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawHomeWorldBeacon(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    if (this.settledSinceAnimTick === 0) return;
    const elapsed = this.animTick - this.settledSinceAnimTick;
    if (elapsed > 420) return;

    // Fade: in over first 60 ticks, hold, fade out over last 60
    const alpha = elapsed < 60 ? elapsed / 60
      : elapsed > 360 ? (420 - elapsed) / 60
      : 1;

    const playerStar = this.getPlayerStar();
    if (!playerStar) return;
    const home = playerStar.planets.find(p => p.hasLife);
    if (!home) return;

    const angleOff = planetOffsetFromStar(home, this.animTick);
    const wx = playerStar.x + angleOff.x;
    const wy = playerStar.y + angleOff.y;
    const { x: sx, y: sy } = this.worldToScreen(wx, wy, W, H);

    ctx.save();
    ctx.globalAlpha = alpha;

    // Pulsing outer ring
    const ringR = 28 + Math.sin(this.animTick * 0.08) * 5;
    ctx.strokeStyle = 'rgba(80, 255, 140, 0.65)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy, ringR, 0, Math.PI * 2);
    ctx.stroke();

    // Inner ring
    ctx.strokeStyle = 'rgba(180, 255, 200, 0.35)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(sx, sy, ringR * 1.6, 0, Math.PI * 2);
    ctx.stroke();

    // Label
    ctx.fillStyle = '#b0ffcc';
    ctx.font = '12px Cinzel, serif';
    ctx.textAlign = 'center';
    ctx.fillText('YOUR WORLD', sx, sy - ringR - 12);

    ctx.restore();
  }

  private drawInflationRing(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const progress = this.tick / INFLATION_TICKS;
    const { x: cx, y: cy } = this.worldToScreen(WORLD_SIZE / 2, WORLD_SIZE / 2, W, H);

    ctx.save();

    // Central flash — bright singularity burst for first 30% of inflation
    if (progress < 0.3) {
      const flashAlpha = (0.3 - progress) / 0.3;
      const flashRadius = 60 + progress * 200;
      ctx.globalCompositeOperation = 'screen';
      const flash = ctx.createRadialGradient(cx, cy, 0, cx, cy, flashRadius);
      flash.addColorStop(0,   `rgba(255, 245, 200, ${flashAlpha * 0.9})`);
      flash.addColorStop(0.3, `rgba(255, 180, 80,  ${flashAlpha * 0.5})`);
      flash.addColorStop(1,   'rgba(0, 0, 0, 0)');
      ctx.fillStyle = flash;
      ctx.beginPath();
      ctx.arc(cx, cy, flashRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }

    // Primary shockwave ring
    const ringRadius = progress * Math.min(W, H) * 0.45;
    ctx.strokeStyle = `rgba(220, 180, 110, ${(1 - progress) * 0.55})`;
    ctx.lineWidth = 2 + (1 - progress) * 5;
    ctx.beginPath();
    ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Secondary trailing ring (offset by 10%)
    if (progress > 0.08) {
      const ring2 = (progress - 0.08) * Math.min(W, H) * 0.45;
      ctx.strokeStyle = `rgba(160, 100, 220, ${(1 - progress) * 0.3})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, ring2, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Phase label
    ctx.fillStyle = 'rgba(200, 169, 110, 0.7)';
    ctx.font = '11px Cinzel, serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      this.phase === 'gravity'
        ? 'GRAVITY PHASE — STRUCTURES FORMING'
        : `INFLATION PHASE  ${this.tick} / ${INFLATION_TICKS}`,
      W / 2, H - 40,
    );

    ctx.restore();
  }

  private drawFog(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const fogCtx = this.fogCtx;
    // Assigning canvas.width every frame reallocates the GPU buffer and was a
    // major hitch source. Only resize when the viewport actually changes.
    if (this.fogCanvas.width !== W || this.fogCanvas.height !== H) {
      this.fogCanvas.width = W;
      this.fogCanvas.height = H;
      this.fogCacheValid = false;
    }

    // Quantize camera so tiny lerps don't force a rebuild every frame.
    const key = [
      W, H,
      Math.round(this.camera.x * 2),
      Math.round(this.camera.y * 2),
      Math.round(this.camera.scale * 40),
      this.exploredAreas.length,
      this.playerFogIndex >= 0 && this.exploredAreas[this.playerFogIndex]
        ? `${Math.round(this.exploredAreas[this.playerFogIndex].x)}:${Math.round(this.exploredAreas[this.playerFogIndex].y)}:${Math.round(this.exploredAreas[this.playerFogIndex].r)}`
        : '',
    ].join('|');

    if (!this.fogCacheValid || key !== this.fogCacheKey) {
      fogCtx.setTransform(1, 0, 0, 1, 0, 0);
      fogCtx.globalCompositeOperation = 'source-over';
      fogCtx.clearRect(0, 0, W, H);
      fogCtx.fillStyle = `rgba(0, 0, 8, ${FOG_ALPHA})`;
      fogCtx.fillRect(0, 0, W, H);

      fogCtx.globalCompositeOperation = 'destination-out';
      for (const area of this.exploredAreas) {
        const { x, y } = this.worldToScreen(area.x, area.y, W, H);
        const r = area.r * this.camera.scale;
        if (r < 1) continue;
        const grad = fogCtx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, 'rgba(0,0,0,1)');
        grad.addColorStop(0.65, 'rgba(0,0,0,0.85)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        fogCtx.fillStyle = grad;
        fogCtx.beginPath();
        fogCtx.arc(x, y, r, 0, Math.PI * 2);
        fogCtx.fill();
      }
      fogCtx.globalCompositeOperation = 'source-over';
      this.fogCacheKey = key;
      this.fogCacheValid = true;
    }

    ctx.drawImage(this.fogCanvas, 0, 0);
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private setupInput(): void {
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.85 : 1.18;
      const prev = this.camera.ts;
      const next = Math.max(0.15, Math.min(CAMERA_MAX_SCALE, prev * factor));
      if (next === prev) return;
      // Zoom toward the cursor: the world point under it stays under it, so
      // the player can zoom straight into a planet rather than the star.
      const r = this.canvas.getBoundingClientRect();
      const mx = (e.clientX - r.left) * (this.canvas.width / Math.max(1, r.width)) - this.canvas.width / 2;
      const my = (e.clientY - r.top) * (this.canvas.height / Math.max(1, r.height)) - this.canvas.height / 2;
      const wx = this.camera.tx + mx / prev, wy = this.camera.ty + my / prev;
      this.camera.tx = wx - mx / next;
      this.camera.ty = wy - my / next;
      this.camera.ts = next;
      // Zooming in away from the centre is a look somewhere else: stop
      // pulling the view back onto the home star.
      if (next > prev && Math.hypot(mx, my) > 60) this.cameraFollowHome = false;
    }, { passive: false });

    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.dragCamStart = { x: this.camera.tx, y: this.camera.ty };
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      const dx = (e.clientX - this.dragStart.x) / this.camera.scale;
      const dy = (e.clientY - this.dragStart.y) / this.camera.scale;
      this.camera.tx = this.dragCamStart.x - dx;
      this.camera.ty = this.dragCamStart.y - dy;
      // Any real pan means the player wants free look — stop auto-follow.
      if (Math.abs(dx) + Math.abs(dy) > 2 / Math.max(this.camera.scale, 0.01)) {
        this.cameraFollowHome = false;
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (!this.isDragging) return;
      const moved = Math.abs(e.clientX - this.dragStart.x) + Math.abs(e.clientY - this.dragStart.y);
      this.isDragging = false;

      // Click (not drag)
      if (moved < 5) {
        const wx = (e.clientX - (this.canvas.width / 2 - this.camera.x * this.camera.scale)) / this.camera.scale;
        const wy = (e.clientY - (this.canvas.height / 2 - this.camera.y * this.camera.scale)) / this.camera.scale;

        // A planet or moon under the cursor (system zoom): its details card.
        if (this.camera.scale >= 1.2 && this.onBodySelected) {
          const hit = this.pickBody(wx, wy);
          if (hit) {
            this.onBodySelected({ ...hit, screenX: e.clientX, screenY: e.clientY });
            return;
          }
        }

        // Find nearest star
        let nearest: StarBody | null = null;
        let minDist = 30 / this.camera.scale;
        for (const star of this.stars) {
          if (star.isDead) continue;
          const d = Math.sqrt((star.x - wx) ** 2 + (star.y - wy) ** 2);
          if (d < minDist) { minDist = d; nearest = star; }
        }
        if (nearest) {
          const now = Date.now();
          const isDoubleClick = (now - this._lastClickTime < 350) && this._lastClickedStarId === nearest.id;
          this._lastClickTime = now;
          this._lastClickedStarId = nearest.id;

          if (isDoubleClick && nearest.isPlayerStar) {
            // Double-click on own star: zoom way in
            this.focusPlayerStar(true);
          } else {
            this.camera.tx = nearest.x;
            this.camera.ty = nearest.y;
            this.camera.ts = nearest.isPlayerStar ? 4.0 : 2.5;
            // Clicking home re-locks follow; other stars are a one-shot look.
            this.cameraFollowHome = !!nearest.isPlayerStar;
          }
          this.onStarSelected?.(nearest);
        }
      } else {
        this.cameraFollowHome = false;
      }
    });

    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.touches[0];
      this.isDragging = true;
      this.dragStart = { x: t.clientX, y: t.clientY };
      this.dragCamStart = { x: this.camera.tx, y: this.camera.ty };
    }, { passive: false });

    this.canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (!this.isDragging) return;
      const t = e.touches[0];
      const dx = (t.clientX - this.dragStart.x) / this.camera.scale;
      const dy = (t.clientY - this.dragStart.y) / this.camera.scale;
      this.camera.tx = this.dragCamStart.x - dx;
      this.camera.ty = this.dragCamStart.y - dy;
      if (Math.abs(dx) + Math.abs(dy) > 2 / Math.max(this.camera.scale, 0.01)) {
        this.cameraFollowHome = false;
      }
    }, { passive: false });

    this.canvas.addEventListener('touchend', () => { this.isDragging = false; });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  getPlayerStar(): StarBody | undefined {
    return this.stars.find(s => s.isPlayerStar && !s.isDead);
  }

  clearPlanetTextureCache(): void {
    this.planetTextureCache.clear();
  }

  getStarById(id: number): StarBody | undefined {
    return this.stars.find(s => s.id === id);
  }

  /**
   * Called when a planet or moon is clicked in the system view. `moonIndex`
   * null means the planet itself.
   */
  onBodySelected?: (hit: { star: StarBody; planetIndex: number; moonIndex: number | null; screenX: number; screenY: number }) => void;

  /**
   * The planet or moon nearest world point (wx, wy) within a click's reach,
   * using the same positions the system view draws (orbit, body size, moon
   * orbit as PixiBigBangRenderer lays them out). Known systems only.
   */
  pickBody(wx: number, wy: number): { star: StarBody; planetIndex: number; moonIndex: number | null } | null {
    const sc = Math.max(0.01, this.camera.scale), reach = 10 / sc;
    let best: { star: StarBody; planetIndex: number; moonIndex: number | null } | null = null, bestD = Infinity;
    for (const star of this.stars) {
      if (!star.isPlayerStar && !this.isStarKnownToPlayer(star)) continue;
      if (Math.hypot(star.x - wx, star.y - wy) > 400) continue;
      star.planets.forEach((planet, i) => {
        const o = planetOffsetFromStar(planet, this.animTick);
        const px = star.x + o.x, py = star.y + o.y;
        const body = Math.max(planet.radius * 3.2, 2.0 / sc);
        const d = Math.hypot(px - wx, py - wy);
        if (d < body / 2 + reach && d < bestD) { bestD = d; best = { star, planetIndex: i, moonIndex: null }; }
        planet.moons.forEach((moon, m) => {
          const large = moon.radius >= planet.radius * 0.4;
          const ma = moon.orbitalAngle + this.animTick * moon.orbitalSpeed;
          const r = Math.max(moon.orbitalRadius, body * (large ? 1.15 : 0.85));
          const dm = Math.hypot(px + Math.cos(ma) * r - wx, py + Math.sin(ma) * r - wy);
          // Moons are small: they win only when the click is right on them.
          if (dm < Math.max(moon.radius * 2, 4 / sc) && dm < bestD) { bestD = dm; best = { star, planetIndex: i, moonIndex: m }; }
        });
      });
    }
    return best;
  }

  /** The player's world in a system: the landed one, else the formation home, else the best orbit. */
  homeWorld(star: StarBody): Planet | undefined {
    return star.planets.find(p => p.discovery === 'landing') ?? this.homePlanetOf(star) ?? star.planets[star.bestPlanetIndex ?? 0];
  }

  focusPlayerStar(deep = false): void {
    const ps = this.getPlayerStar();
    if (ps) {
      // Frame the home WORLD (the follow keeps it centred as it orbits).
      const home = this.homeWorld(ps);
      const o = home ? planetOffsetFromStar(home, this.animTick) : { x: 0, y: 0 };
      this.camera.tx = ps.x + o.x;
      this.camera.ty = ps.y + o.y;
      this.camera.ts = deep ? 11 : 8.5;
      this.cameraFollowHome = true;
    }
  }

  isStarKnownToPlayer(star: StarBody): boolean {
    if (star.isPlayerStar) return true;
    for (const area of this.exploredAreas) {
      const dx = star.x - area.x, dy = star.y - area.y;
      if (dx * dx + dy * dy <= area.r * area.r) return true;
    }
    return false;
  }

  revealArea(x: number, y: number, radius: number): void {
    this.exploredAreas.push({ x, y, r: radius });
    this.fogCacheValid = false;
  }

  spendDPToExplore(directionAngle: number): void {
    const ps = this.getPlayerStar();
    if (!ps) return;
    const dist = 150;
    const ex = ps.x + Math.cos(directionAngle) * dist;
    const ey = ps.y + Math.sin(directionAngle) * dist;
    this.exploredAreas.push({ x: ex, y: ey, r: 80 });
    // Check if we revealed any star
    for (const star of this.stars) {
      if (star.isDead) continue;
      const dx = star.x - ex, dy = star.y - ey;
      if (Math.sqrt(dx * dx + dy * dy) < 80) {
        this.onCivEvent?.(`Divine sight revealed: ${star.civName}`);
      }
    }
  }

  /**
   * Walk every forming system through magma → cooling → volcanic → atmosphere →
   * ice age → primordial.
   *
   * This used to run on the PLAYER's star alone, so a system condensed out of a
   * supernova remnant was stamped 'magma' and stayed molten forever — measured
   * at 766 newborn stars, every one still in its first stage after 600k ticks.
   */
  private updatePlanetFormation(): void {
    // Throttled. This walks EVERY star, and it went from the player's star alone
    // to all of them (see the note above), which put a full scan in the hot loop
    // on every tick. Formation stages last 300-500 ticks, so checking a few
    // times per stage is ample and the cost drops by two orders of magnitude.
    if (this.tick % FORMATION_CHECK_RATE !== 0) return;
    for (const star of this.stars) {
      if (star.isDead || !star.formationStage) continue;
      if (star.formationDestiny) { this.stepHomeFormation(star); continue; }

      const elapsed = this.tick - star.formationTick;
      if (elapsed < FORMATION_DURATIONS[star.formationStage]) continue;

      const idx = FORMATION_SEQUENCE.indexOf(star.formationStage);
      const next = FORMATION_SEQUENCE[idx + 1];

      if (next) {
        star.formationStage = next;
        star.formationTick = this.tick;
        if (star.isPlayerStar) this.onPlanetFormationProgress?.(next);
        continue;
      }

      // ── The world has finished forming ──────────────────────────────────
      star.formationStage = null;
      star.formationTick = 0;
      star.civLevel = 0;

      if (star.isNewSystem) {
        // A brand-new system is overwhelmingly dead rock: ONE roll here, at
        // `NEW_SYSTEM_LIFE_CHANCE`. The flag stays set until `newSystemUntil` so
        // it does not immediately re-enter the ambient abiogenesis pool.
        //
        // After that window it is an ordinary star and may evolve life the slow
        // way like any other. That is deliberate. Holding new systems out
        // forever sterilises the cosmos — most stars in a long game condensed
        // during play — and it is not what the 1% means: the 1% is the chance a
        // system arrives WITH life, not a sentence of eternal barrenness.
        this.newSystemsFormed++;
        if (!this.rng.chance(NEW_SYSTEM_LIFE_CHANCE)) continue;
        this.newSystemsBornAlive++;
        const idx2 = star.planets.findIndex(p => p.type === 'rocky' || p.type === 'ocean');
        this.igniteLife(star, idx2 >= 0 ? idx2 : 0);
        if (this.isStarKnownToPlayer(star)) {
          this.onCivEvent?.(`Against the odds, life has taken hold in the young ${star.civName} system.`);
        }
        continue;
      }

      // An existing world rebuilding after a cataclysm. A fresh biosphere rolls
      // its own tempo — the rebuilt world is not guaranteed to climb as fast as
      // the one that was lost.
      const reIdx = star.planets.findIndex(p => p.type === 'rocky' || p.type === 'ocean');
      this.igniteLife(star, reIdx >= 0 ? reIdx : 0);
      this.onCivEvent?.(`Life has re-emerged in ${star.civName}'s system after the cataclysm.`);
      if (star.isPlayerStar) this.onPlayerLifeEmerged?.();
    }
  }

  // ── Home-world formation lifecycle (Formation.ts) ───────────────────────

  /** Start the home world molten on its destiny's ladder. */
  private beginHomeFormation(star: StarBody, planet: Planet, destiny: DestinyType, budget: number): void {
    star.hasLife = false;
    star.civLevel = 0;
    star.biologyPhase = 'microbial';
    star.bioPhaseProgress = 0;
    star.formationStage = 'magma';
    star.formationTick = this.tick;
    star.formationDestiny = destiny;
    star.formationBudget = budget;
    star.formationProgress = 0;
    star.formationBoost = 0;
    planet.hasLife = false;
    planet.biosphere = 0;
    planet.destinyType = destiny;
    this.applyFormationFace(star, planet);
  }

  /** The home planet of a star walking a destiny ladder. */
  homePlanetOf(star: StarBody): Planet | undefined {
    return star.planets.find(p => p.destinyType && p.discovery === 'landing')
      ?? star.planets[star.bestPlanetIndex ?? 0];
  }

  /** Paint the planet as its current stage (lava while molten, bare rock, ...). */
  private applyFormationFace(star: StarBody, planet: Planet): void {
    if (!star.formationStage || !star.formationDestiny) return;
    const face = formationFaceType(star.formationStage, star.formationDestiny);
    planet.type = face;
    planet.color = FORMATION_FACE_COLORS[star.formationStage] ?? planet.color;
    star.habitability = undefined;
  }

  /** One formation check (every FORMATION_CHECK_RATE ticks) on a destiny ladder. */
  private stepHomeFormation(star: StarBody): void {
    const destiny = star.formationDestiny!;
    const stage = star.formationStage!;
    const budget = star.formationBudget ?? 0;
    const planet = this.homePlanetOf(star);
    const dur = stageDuration(destiny, budget, stage);

    // Life on the path: it can wake on its own or arrive from outside once the
    // crust is solid. It only hastens the ladder; the destiny never changes.
    if (!star.hasLife && lifeEligible(destiny, stage)) {
      if (this.rng.chance(spontaneousLifeChance(dur, FORMATION_CHECK_RATE))) {
        this.seedFormingWorld(star, 'spontaneous');
      } else {
        const donor = this.nearestLivingNeighbour(star, FORMATION_EJECTA_RANGE);
        if (donor && this.rng.chance(ejectaChance(budget, FORMATION_CHECK_RATE,
            Math.hypot(donor.x - star.x, donor.y - star.y), FORMATION_EJECTA_RANGE))) {
          this.seedFormingWorld(star, 'ejecta', donor.civName);
        }
      }
    }

    const rate = 1 + (star.formationBoost ?? 0);
    star.formationProgress = (star.formationProgress ?? 0) + FORMATION_CHECK_RATE * rate;
    if (star.formationProgress < dur) return;

    const next = nextStage(destiny, stage);
    if (next) {
      star.formationStage = next;
      star.formationTick = this.tick;
      // Carry the overshoot so stage boundaries do not add up past the budget.
      star.formationProgress -= dur;
      if (planet) this.applyFormationFace(star, planet);
      if (star.isPlayerStar) this.onPlanetFormationProgress?.(next);
      return;
    }

    // ── Formation complete: the world settles into its destiny ────────────
    star.formationStage = null;
    star.formationTick = 0;
    star.formationDestiny = undefined;
    star.formationProgress = 0;
    star.formationBoost = 0;
    star.habitability = undefined;
    if (planet) {
      planet.type = destiny;
      planet.color = DESTINY_COLORS[destiny];
    }
    const idx = planet ? star.planets.indexOf(planet) : (star.bestPlanetIndex ?? 0);
    const hadLife = star.hasLife;
    if (!hadLife) {
      // The finished world's own roll: its young seas or crust wake up.
      this.igniteHomeLife(star, idx);
    }
    // The biology ladder begins on finished ground, whatever woke first.
    star.biologyPhase = 'microbial';
    star.bioPhaseProgress = 0;
    star.lifeFirstTick = this.tick;
    if (planet) { planet.hasLife = true; planet.biosphere = Math.max(planet.biosphere, 0.3); }
    if (star.isPlayerStar) {
      this.onPlanetFormationComplete?.(destiny);
      // Life climbs from here, whether it woke now or slept through the
      // forming: either way this is when the player meets it.
      this.onPlayerLifeEmerged?.();
    }
  }

  /**
   * Life arrives on a world that is still forming. It lies dormant until the
   * world is finished, but it hastens the ladder (capped: see MAX_BOOST).
   * A second seeding adds a smaller push.
   */
  private seedFormingWorld(star: StarBody, source: FormationLifeSource, from = ''): void {
    if (!star.formationDestiny) return;
    const planet = this.homePlanetOf(star);
    if (star.hasLife) {
      star.formationBoost = addBoost(star.formationBoost ?? 0, SEED_BOOST);
    } else {
      const idx = planet ? star.planets.indexOf(planet) : (star.bestPlanetIndex ?? 0);
      this.igniteHomeLife(star, idx);
      star.formationBoost = addBoost(star.formationBoost ?? 0, LIFE_BOOST);
    }
    if (star.isPlayerStar) this.onFormationLifeArrived?.(source, from);
  }

  /**
   * igniteLife for the home world: it re-rolls biochemistry from the planet's
   * face (lava, mid-formation) and a fresh tempo. The player's world keeps the
   * familiar chemistry and the tempo its seed rolled at birth.
   */
  private igniteHomeLife(star: StarBody, idx: number): void {
    const arch = star.lifeArchetype, tempo = star.bioTempo;
    this.igniteLife(star, idx);
    if (star.isPlayerStar) {
      star.lifeArchetype = arch ?? 'carbon_water';
      if (tempo !== undefined) star.bioTempo = tempo;
    }
  }

  private nearestLivingNeighbour(star: StarBody, range: number): StarBody | null {
    let best: StarBody | null = null, bestD = range;
    for (const s of this.stars) {
      if (s === star || s.isDead || !s.hasLife || s.formationStage) continue;
      const d = Math.hypot(s.x - star.x, s.y - star.y);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /** True while the player's home world is still walking its destiny ladder. */
  isHomeForming(): boolean {
    return !!this.getPlayerStar()?.formationDestiny;
  }

  /** 0..1 through the home world's formation, or 1 when formed. */
  homeFormationFraction(): number {
    const ps = this.getPlayerStar();
    if (!ps?.formationDestiny || !ps.formationStage) return 1;
    return formationFraction(ps.formationDestiny, ps.formationBudget ?? 0, ps.formationStage, ps.formationProgress ?? 0);
  }

  /**
   * Creative mode: place life on the home world by hand. On a forming world it
   * is a seeding event (hastens, never redirects); on a finished lifeless one
   * it starts the biosphere. Returns false if there was nothing to do.
   */
  placeLife(): boolean {
    const ps = this.getPlayerStar();
    if (!ps) return false;
    if (ps.formationDestiny) {
      this.seedFormingWorld(ps, 'divine');
      return true;
    }
    if (ps.hasLife) return false;
    this.igniteLife(ps, ps.bestPlanetIndex ?? 0);
    this.onPlayerLifeEmerged?.();
    return true;
  }

  private updateTerraforming(): void {
    const ps = this.getPlayerStar();
    if (!ps || !ps.terraformStage) return;

    const elapsed = this.tick - ps.terraformTick;
    if (elapsed < TERRAFORM_DURATIONS[ps.terraformStage]) return;

    // Find which sequence we're in by matching targetType
    const seqList = TERRAFORM_SEQUENCES[ps.planets.find(p => p.hasLife || p.discovery === 'landing')?.type ?? ''] ?? [];
    const seq = seqList.find(s => s.result === ps.terraformTargetType);
    if (!seq) { ps.terraformStage = null; return; }

    const idx = seq.stages.indexOf(ps.terraformStage);
    const next = seq.stages[idx + 1] ?? null;

    if (!next) {
      // All stages complete — transform the home planet
      const homePlanet = ps.planets.find(p => p.discovery === 'landing') ?? ps.planets[0];
      const fromType = homePlanet.type;
      homePlanet.type = ps.terraformTargetType!;
      if (ps.terraformTargetType === 'ocean' || ps.terraformTargetType === 'rocky') {
        homePlanet.hasLife = true;
        homePlanet.biosphere = Math.min(1, homePlanet.biosphere + 0.3);
      }
      ps.terraformStage = null;
      ps.terraformTick = 0;
      // The home world is a different kind of planet now, so the cached
      // habitability score no longer describes it.
      ps.habitability = undefined;
      const targetType = ps.terraformTargetType!;
      ps.terraformTargetType = null;
      this.onTerraformComplete?.(fromType, targetType, homePlanet.name);
    } else {
      ps.terraformStage = next;
      ps.terraformTick = this.tick;
      this.onTerraformProgress?.(next, ps.terraformTargetType!);
    }
  }

  /** Returns info about available terraform options for the player's home planet.
   *  Returns null if already terraforming or no valid options. */
  getTerraformInfo(): { options: { label: string; targetType: Planet['type']; stages: PlanetFormationStage[] }[] } | null {
    const ps = this.getPlayerStar();
    if (!ps || ps.terraformStage) return null;
    // Terraforming reshapes a FINISHED world; one still forming has no type yet.
    if (ps.formationDestiny) return null;
    const homePlanet = ps.planets.find(p => p.discovery === 'landing') ?? null;
    if (!homePlanet) return null;
    const seqList = TERRAFORM_SEQUENCES[homePlanet.type];
    if (!seqList || seqList.length === 0) return null;
    return {
      options: seqList.map(s => ({
        label: `${homePlanet.type} → ${s.result}`,
        targetType: s.result,
        stages: s.stages,
      })),
    };
  }

  /** Begin terraforming the player's home planet toward targetType. */
  startTerraform(targetType: Planet['type']): boolean {
    const ps = this.getPlayerStar();
    if (!ps || ps.terraformStage) return false;
    const homePlanet = ps.planets.find(p => p.discovery === 'landing') ?? null;
    if (!homePlanet) return false;
    const seqList = TERRAFORM_SEQUENCES[homePlanet.type];
    const seq = seqList?.find(s => s.result === targetType);
    if (!seq || seq.stages.length === 0) return false;
    ps.terraformStage = seq.stages[0];
    ps.terraformTick = this.tick;
    ps.terraformTargetType = targetType;
    this.onTerraformProgress?.(seq.stages[0], targetType);
    return true;
  }

  /** Nudge evolution:
   *  - Pre-intelligence: forces an immediate mutation on the most-populous species (biased by
   *    the player's highest DNA branch), plus a small bio-phase progress boost.
   *    Returns { outcome: 'bio', mutationDesc } — fires onMutationEvent if a mutation applied.
   *  - Post-intelligence: awards 1 DNA point. Returns { outcome: 'dna' }.
   *  Returns { outcome: 'none' } if no player star exists. */
  nudgePlayerEvolution(): { outcome: 'bio' | 'dna' | 'none'; mutationDesc?: string } {
    const ps = this.getPlayerStar();
    if (!ps) return { outcome: 'none' };

    if (ps.biologyPhase !== 'intelligent') {
      let mutationDesc: string | undefined;
      if (gameState.playerSpecies.length > 0) {
        const result = applyNudgeMutation(
          ps.biologyPhase,
          gameState.playerDNA,
          gameState.playerSpecies,
          gameState.playerBiosphere,
          this.rng,
          this.tick,
          runtimeState.branchDefs,
          gameState.signatureSpeciesId
            ? { id: gameState.signatureSpeciesId, locked: lockedTraits(gameState.mutationsOwned) } : null,
        );
        gameState.playerSpecies   = result.updatedSpecies;
        gameState.playerBiosphere = result.updatedBiosphere;
        for (const evt of result.events) {
          this.onMutationEvent?.(evt);
          mutationDesc = evt.description;
        }
      }
      // Also nudge bio-phase progress so it always feels productive
      const baseRate = BIO_PHASE_TICKS[ps.biologyPhase] ?? 3000;
      ps.bioPhaseProgress += Math.floor(baseRate * 0.08);
      // And stack the odds on the next Great Filter roll. This is the player's
      // real lever against a world that keeps stalling: nudges accumulate until
      // the world successfully makes a jump, then reset.
      this.bioAssistance = Math.min(0.9, this.bioAssistance + NUDGE_ASSISTANCE);
      return { outcome: 'bio', mutationDesc };
    }

    // Post-intelligence: award 1 DNA point for slow accumulation
    gameState.dnaPoints += 1;
    this.onDNAPointEarned?.(gameState.dnaPoints);
    return { outcome: 'dna' };
  }

  /** @deprecated Use nudgePlayerEvolution() */
  nudgePlayerCivLevel(): void {
    const ps = this.getPlayerStar();
    if (ps && ps.civLevel < 8) ps.civLevel++;
  }

  private advancePlayerPlanetDiscovery(star: StarBody): void {
    star.planets.forEach((p, i) => {
      // civLevel 1 (Ancient) → telescope on all own planets
      if (star.civLevel >= 1 && p.discovery === 'none') {
        p.discovery = 'telescope';
        this.onCivEvent?.(`Telescope observation: ${p.name} detected in your system`);
      }
      // civLevel 4 (Atomic) → probe on first two non-home planets
      if (star.civLevel >= 4 && p.discovery === 'telescope' && i > 0) {
        p.discovery = 'probe';
        this.onCivEvent?.(`Probe launched: ${p.name} — surface data incoming`);
      }
      // civLevel 5 (Space Age) → landing on nearest non-home planet (index 1)
      if (star.civLevel >= 5 && p.discovery === 'probe' && i === 1) {
        p.discovery = 'landing';
        this.onCivEvent?.(`Historic landing on ${p.name}!`);
      }
      // civLevel 6 (Interstellar) → all planets get full landing data
      if (star.civLevel >= 6 && p.discovery !== 'landing') {
        p.discovery = 'landing';
      }
    });
  }

  blessHarvest(): void {
    const ps = this.getPlayerStar();
    if (!ps) return;
    const lifePlanet = ps.planets.find(p => p.hasLife) ?? ps.planets[0];
    if (lifePlanet) lifePlanet.biosphere = Math.min(1, lifePlanet.biosphere + 0.25);
    // A world still forming cannot be blessed into life early.
    if (!ps.hasLife && !ps.formationDestiny) this.igniteLife(ps, ps.bestPlanetIndex ?? 0);
  }

  /** Returns the nearest revealed lifeless star that can receive a life-seeding meteor, or null. */
  getMeteorTarget(): StarBody | null {
    const ps = this.getPlayerStar();
    if (!ps) return null;
    let best: StarBody | null = null;
    let bestDist = Infinity;
    for (const s of this.stars) {
      if (s.id === ps.id || s.isDead || s.hasLife) continue;
      if (!this.isStarKnownToPlayer(s)) continue;
      const dx = s.x - ps.x, dy = s.y - ps.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist) { bestDist = d; best = s; }
    }
    return best;
  }

  sendMeteor(): void {
    const target = this.getMeteorTarget();
    if (!target) return;
    // Seed the system's most habitable world rather than the first rocky one —
    // divine intervention should not waste itself on a dead orbit.
    const idx = target.planets.findIndex(p => p.type === 'rocky' || p.type === 'ocean');
    const seedIdx = target.bestPlanetIndex ?? (idx >= 0 ? idx : 0);
    this.igniteLife(target, seedIdx);
    const lifePlanet = target.planets[seedIdx];
    const name = lifePlanet?.name ?? target.civName;
    this.onMeteorLifeSeeded?.(name);
  }

  prophetBoostActive = false;
  /** 0–1 head start on the player's next Great Filter roll, spent on success. */
  private bioAssistance = 0;

  applyBattleResult(warId: number, defenderNetWins: number): void {
    const war = this.activeWars.find(w => w.id === warId);
    if (!war || war.resolved) return;
    // defenderNetWins: positive = defender won more pairs, negative = attacker won more
    const delta = defenderNetWins * 0.10;
    war.attackerStrength = Math.max(0.05, Math.min(0.95, war.attackerStrength - delta));
    war.defenderStrength = Math.max(0.05, Math.min(0.95, war.defenderStrength + delta));
  }

  sendProphet(): void {
    this.prophetBoostActive = true;
  }

  // ── War System ────────────────────────────────────────────────────────────

  private readonly WAR_BATTLE_REPORT_INTERVAL = 400;

  private updateWars(): void {
    if (this.phase !== 'settled') return;

    for (let i = this.activeWars.length - 1; i >= 0; i--) {
      const war = this.activeWars[i];
      if (war.resolved) { this.activeWars.splice(i, 1); continue; }

      const attacker = this.stars.find(s => s.id === war.attackerStarId);
      const defender = this.stars.find(s => s.id === war.defenderStarId);

      if (!attacker || !defender || attacker.isDead || defender.isDead) {
        war.resolved = true;
        this.clearSiegeFleets(war.id);
        continue;
      }

      const elapsed  = this.tick - war.startTick;
      const progress = elapsed / war.duration;

      // ── Phase transitions ─────────────────────────────────────────────
      const newPhase: WarPhase =
        progress < 0.20 ? 'skirmish' :
        progress < 0.70 ? 'campaign' :
        progress < 0.90 ? 'siege'    : 'resolution';

      if (newPhase !== war.phase) {
        war.phase = newPhase;
        const known = this.isStarKnownToPlayer(attacker) || this.isStarKnownToPlayer(defender);
        if (known && newPhase !== 'resolution') {
          this.onWarProgress?.(war, attacker, defender, this.warPhaseMessage(war, attacker, defender, newPhase));
        }
        // Trigger player dice roll on campaign / siege phase entry
        if ((newPhase === 'campaign' || newPhase === 'siege') &&
            (attacker.isPlayerStar || defender.isPlayerStar)) {
          const attackerDice = [
            Math.floor(this.rng.nextFloat(1, 6.99)),
            Math.floor(this.rng.nextFloat(1, 6.99)),
            Math.floor(this.rng.nextFloat(1, 6.99)),
          ].sort((a, b) => b - a);
          const civColor: string = CIV_COLORS[attacker.civLevel] ?? '#ff4444';
          this.onWarBattle?.(war.id, attacker.civName, defender.civName, attackerDice, civColor, newPhase);
        }
      }

      // ── Momentum drift ────────────────────────────────────────────────
      const swing = this.rng.nextFloat(-0.008, 0.008);
      war.attackerStrength = Math.max(0.05, Math.min(0.95, war.attackerStrength + swing));
      war.defenderStrength = Math.max(0.05, Math.min(0.95, war.defenderStrength - swing * 0.8));

      // ── Periodic battle reports ───────────────────────────────────────
      if ((war.phase === 'campaign' || war.phase === 'siege') &&
          this.tick - war.lastBattleReportTick >= this.WAR_BATTLE_REPORT_INTERVAL) {
        war.lastBattleReportTick = this.tick;
        const known = this.isStarKnownToPlayer(attacker) || this.isStarKnownToPlayer(defender);
        if (known && this.rng.chance(0.6)) {
          this.onWarProgress?.(war, attacker, defender, this.warBattleReport(war, attacker, defender));
        }
      }

      // ── Resolution ────────────────────────────────────────────────────
      if (war.phase === 'resolution') {
        war.resolved = true;
        this.clearSiegeFleets(war.id);

        // A collective people defends better than it attacks.
        const defC = this.cultureFor(defender);
        const defBonus = defC ? cultureMultiplier(defC.values.collectivism, 0.4) : 1;
        const attackerWon = war.attackerStrength > war.defenderStrength
          ? this.rng.chance(Math.min(0.95, Math.max(0.05,
              (0.65 + this.stats.hostility / 200) / defBonus)))
          : this.rng.chance(Math.min(0.95, Math.max(0.05,
              (0.35 - this.stats.hostility / 200) / defBonus)));

        if (attackerWon) {
          if (defender.civLevel > 0) {
            defender.civLevel = Math.max(0, defender.civLevel - 1);
            this.invalidateCulture(defender, 'defeat');
          }
          if (war.attackerStrength > 0.75)
            attacker.civLevel = Math.min(TECH_LEVELS.length - 1, attacker.civLevel + 1);
        } else {
          if (attacker.civLevel > 0 && this.rng.chance(0.4))
            attacker.civLevel = Math.max(0, attacker.civLevel - 1);
          if (war.defenderStrength > 0.7 && this.rng.chance(0.3))
            defender.civLevel = Math.min(TECH_LEVELS.length - 1, defender.civLevel + 1);
        }

        const known = this.isStarKnownToPlayer(attacker) || this.isStarKnownToPlayer(defender);
        if (known) this.onWarEnd?.(war, attacker, defender, attackerWon);
      }
    }
  }

  private warPhaseMessage(war: War, attacker: StarBody, defender: StarBody, phase: WarPhase): string {
    const momentum = war.attackerStrength > war.defenderStrength ? attacker.civName : defender.civName;
    const msgs: Record<WarPhase, string[]> = {
      skirmish: [
        `${attacker.civName} forces make first contact with ${defender.civName} border fleets.`,
        `Skirmishes break out in the outer reaches of the ${defender.civName} system.`,
      ],
      campaign: [
        `The war between ${attacker.civName} and ${defender.civName} escalates into full campaign.`,
        `${momentum} seizes the momentum as the campaign intensifies.`,
        `Heavy fighting reported across the ${defender.civName} system.`,
      ],
      siege: [
        `${attacker.civName} forces push deep into ${defender.civName} territory.`,
        `${defender.civName} makes a desperate stand against the ${attacker.civName} siege.`,
        `The siege of ${defender.civName} enters its final phase — ${momentum} holds the advantage.`,
      ],
      resolution: [],
    };
    const opts = msgs[phase];
    return opts[Math.floor(this.rng.nextFloat(0, 1) * opts.length)] ?? '';
  }

  private warBattleReport(war: War, attacker: StarBody, defender: StarBody): string {
    const winning = war.attackerStrength > war.defenderStrength ? attacker.civName : defender.civName;
    const losing  = war.attackerStrength > war.defenderStrength ? defender.civName : attacker.civName;
    const reports = [
      `${winning} forces repel a major offensive in the ${defender.civName} system.`,
      `Casualties mount on both sides as ${attacker.civName} and ${defender.civName} clash.`,
      `${losing} supply lines are disrupted — ${winning} presses the advantage.`,
      `A decisive engagement tips the balance toward ${winning}.`,
      `${defender.civName} civilians evacuate contested orbital zones.`,
      `${attacker.civName} deploys advanced weaponry against ${defender.civName}.`,
    ];
    return reports[Math.floor(this.rng.nextFloat(0, 1) * reports.length)];
  }

  getActiveWarForStar(starId: number): War | undefined {
    return this.activeWars.find(
      w => !w.resolved && (w.attackerStarId === starId || w.defenderStarId === starId)
    );
  }

  // ── Cosmic Event System ───────────────────────────────────────────────────

  private scheduleCosmicEvent(type: CosmicEventType, targetStar: StarBody, delay: number, warnBefore: number): void {
    const scheduledTick = this.tick + delay;
    this.cosmicEvents.push({
      id: this.cosmicEventIdCounter++,
      type,
      targetStarId: targetStar.id,
      scheduledTick,
      warningTick: scheduledTick - warnBefore,
      resolved: false,
      smited: false,
    });
  }

  private updateCosmicEvents(): void {
    if (this.phase !== 'settled') return;

    // Periodically schedule new events
    if (this.tick >= this.nextCosmicCheckTick) {
      this.nextCosmicCheckTick = this.tick + this.rng.nextInt(800, 2000);
      this.scheduleCosmicEvents();
    }

    // Process warnings and strikes
    for (const ev of this.cosmicEvents) {
      if (ev.resolved || ev.smited) continue;
      const target = this.stars.find(s => s.id === ev.targetStarId);
      if (!target) { ev.resolved = true; continue; }

      // Fire warning
      if (!ev.resolved && this.tick >= ev.warningTick && this.tick < ev.scheduledTick) {
        // Only warn once — use warningTick as a flag by setting it to -1 after firing
        if (ev.warningTick > 0) {
          ev.warningTick = -1; // mark warning sent
          if (this.isStarKnownToPlayer(target) || target.isPlayerStar) {
            this.onCosmicWarning?.(ev, target);
          }
        }
        continue;
      }

      // Fire strike
      if (this.tick >= ev.scheduledTick) {
        this.applyCosmicStrike(ev, target);
        ev.resolved = true;
      }
    }

    // Prune old resolved events (keep last 50 for UI display)
    const resolved = this.cosmicEvents.filter(e => e.resolved || e.smited);
    if (resolved.length > 50) {
      const oldest = resolved[0];
      const idx = this.cosmicEvents.indexOf(oldest);
      if (idx !== -1) this.cosmicEvents.splice(idx, 1);
    }
  }

  private scheduleCosmicEvents(): void {
    const liveCivStars = this.stars.filter(s => s.hasLife && !s.isDead);
    if (liveCivStars.length === 0) return;

    // Supernova — rare, based on entropy; targets non-player stars
    if (this.rng.chance(this.stats.entropy / 180)) {
      const candidates = this.stars.filter(s => !s.isDead && !s.isPlayerStar);
      if (candidates.length > 0) {
        this.scheduleCosmicEvent('supernova', this.rng.pick(candidates), this.rng.nextInt(600, 1200), 400);
      }
    }

    // Asteroid impact — moderate, targets life-bearing planets
    if (this.rng.chance(this.stats.hostility / 120)) {
      const candidates = liveCivStars.filter(s => s.planets.some(p => p.hasLife));
      if (candidates.length > 0) {
        this.scheduleCosmicEvent('asteroid_impact', this.rng.pick(candidates), this.rng.nextInt(300, 700), 250);
      }
    }

    // Void storm — moderate, disrupts a region
    if (this.rng.chance(this.stats.entropy / 200)) {
      if (liveCivStars.length > 0) {
        this.scheduleCosmicEvent('void_storm', this.rng.pick(liveCivStars), this.rng.nextInt(500, 900), 350);
      }
    }

    // Plague — targets high-civ systems
    if (this.rng.chance(this.stats.hostility / 150)) {
      const candidates = liveCivStars.filter(s => s.civLevel >= 2);
      if (candidates.length > 0) {
        this.scheduleCosmicEvent('plague', this.rng.pick(candidates), this.rng.nextInt(200, 500), 150);
      }
    }
  }

  private applyCosmicStrike(ev: CosmicEvent, target: StarBody): void {
    const known = this.isStarKnownToPlayer(target) || target.isPlayerStar;

    switch (ev.type) {
      case 'supernova': {
        // Routed through the same path as a collision detonation, so an advanced
        // civilisation gets its chance to evacuate either way.
        this.detonateStar(target, `The star of ${target.civName} has gone supernova`);
        if (known) this.onCosmicStrike?.(ev, target);
        break;
      }

      case 'asteroid_impact': {
        const lifePlanet = target.planets.find(p => p.hasLife) ?? target.planets[0];
        if (lifePlanet) {
          lifePlanet.biosphere = Math.max(0, lifePlanet.biosphere - 0.45);
          if (lifePlanet.biosphere < 0.1) {
            lifePlanet.hasLife = false;
            if (target.civLevel > 0) target.civLevel = Math.max(0, target.civLevel - 2);
          }
        }
        this.onCosmicEvent?.('asteroid_impact', target.civName);
        if (known) this.onCosmicStrike?.(ev, target);
        break;
      }

      case 'void_storm': {
        // Suspend advancement — set lastEventTick far forward to stall age counter briefly
        for (const s of this.stars) {
          const dx = s.x - target.x, dy = s.y - target.y;
          if (Math.sqrt(dx * dx + dy * dy) < 200) {
            s.age = Math.max(0, s.age - 800); // rewind age to stall progress
            for (const p of s.planets) p.biosphere = Math.max(0, p.biosphere - 0.15);
          }
        }
        this.onCosmicEvent?.('void_storm', target.civName);
        if (known) this.onCosmicStrike?.(ev, target);
        break;
      }

      case 'plague': {
        const lifePlanet2 = target.planets.find(p => p.hasLife);
        if (lifePlanet2) lifePlanet2.biosphere = Math.max(0, lifePlanet2.biosphere - 0.3);
        if (target.civLevel > 0) target.civLevel = Math.max(0, target.civLevel - 1);
        this.onCosmicEvent?.('plague', target.civName);
        if (known) this.onCosmicStrike?.(ev, target);
        break;
      }
    }
  }

  smiteAsteroid(): boolean {
    // Cancel the nearest pending asteroid_impact targeting player's star
    const ps = this.getPlayerStar();
    if (!ps) return false;
    const pending = this.cosmicEvents.find(e =>
      e.type === 'asteroid_impact' && e.targetStarId === ps.id && !e.resolved && !e.smited
    );
    if (!pending) return false;
    pending.smited = true;
    this.supernovaFlashes.push({ x: ps.x, y: ps.y, startTick: this.tick, startAnimTick: this.animTick, maxRadius: 40 });
    return true;
  }

  getPendingCosmicEvents(): CosmicEvent[] {
    return this.cosmicEvents.filter(e => !e.resolved && !e.smited);
  }

  private generatePlanets(stats: UniverseStats, starMass = 4): Planet[] {
    // 2–7 worlds; spacing stretches so some systems are compact and others vast.
    const count = this.rng.nextInt(2, 7);
    const COLOR_POOL: Record<Planet['type'], string[]> = {
      rocky:   ['#aa6446', '#997755', '#82644a', '#be8260', '#6e5040', '#c4a070', '#5a4838', '#8b6914'],
      ocean:   ['#2266aa', '#2878be', '#195591', '#2d8ca5', '#3760a0', '#1a7a6e', '#3d5a80', '#0e4d6e'],
      gas:     ['#cc9944', '#b48c5a', '#dcaa64', '#a07846', '#be9b78', '#c9a0c0', '#88aacc', '#d4b896', '#9a6b4a'],
      ice:     ['#aaddee', '#c8e6ff', '#96bede', '#b4dce6', '#e8f4ff', '#90c0d8'],
      lava:    ['#ff4623', '#dc371e', '#ff6428', '#c82d19', '#ff8833', '#a02010'],
      toxic:   ['#5aad28', '#7acc32', '#3d8c20', '#a0d040', '#6bb830', '#90c048'],
      crystal: ['#a050c8', '#c070e0', '#8040b0', '#d090ff', '#7030a0', '#b060d8'],
      desert:  ['#d4a85a', '#c09040', '#e0b870', '#b88838', '#f0c880', '#a07830'],
      storm:   ['#4a4860', '#5a5470', '#3a3850', '#6a6080', '#484860', '#706890'],
      carbon:  ['#2a2a30', '#383840', '#1e1e24', '#44444c', '#323238', '#505058'],
    };
    const chaosLevels: PlanetDNA['chaos'][] = ['serene', 'turbulent', 'storm'];
    const romanNumerals = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
    const planets: Planet[] = [];
    const starRadius = 2.5 + starMass * 0.8;
    // Inner edge clears the corona; outer edge can be quite far (cold fringe).
    const minOrbit = starRadius + 4 + this.rng.nextFloat(0, 4);
    const maxOrbit = starRadius + this.rng.nextFloat(55, 120);
    // Uneven gaps so planets aren't locked to a tight ladder near the sun.
    const slots: number[] = [];
    {
      let cursor = minOrbit;
      for (let i = 0; i < count; i++) {
        const remain = count - i;
        const room = Math.max(6, maxOrbit - cursor);
        const step = this.rng.nextFloat(room * 0.12, room * (0.35 + 0.4 / remain));
        cursor += step;
        slots.push(Math.min(maxOrbit, cursor));
      }
    }

    for (let i = 0; i < count; i++) {
      const a = slots[i];
      // Normalize distance 0 (scorching) → 1 (frozen fringe)
      const heat = Math.max(0, Math.min(1, 1 - (a - minOrbit) / Math.max(8, maxOrbit - minOrbit)));
      const type = this.pickPlanetTypeForDistance(heat);
      let climate: PlanetDNA['climate'] = 'temperate';
      let ocean: PlanetDNA['oceans'] = 'mixed';
      if (type === 'lava') {
        climate = 'desert';
        ocean = 'barren';
      } else if (type === 'ice') {
        climate = 'frozen';
        ocean = this.rng.chance(0.35) ? 'mixed' : 'barren';
      } else if (type === 'ocean' || type === 'toxic') {
        climate = heat > 0.55 ? 'temperate' : 'frozen';
        ocean = this.rng.chance(0.55) ? 'ocean_world' : 'mixed';
      } else if (type === 'rocky' || type === 'crystal' || type === 'carbon') {
        // Far rocky worlds lean volcanic-vent / frozen; near ones scorched.
        climate = heat > 0.7 ? 'desert' : heat < 0.35 ? 'frozen' : this.rng.pick(['desert', 'temperate', 'frozen']);
        ocean = heat < 0.4 ? (this.rng.chance(0.4) ? 'mixed' : 'barren') : this.rng.pick(['barren', 'mixed']);
      } else if (type === 'desert') {
        climate = 'desert';
        ocean = this.rng.chance(0.25) ? 'mixed' : 'barren';
      } else if (type === 'storm') {
        climate = heat > 0.55 ? 'temperate' : 'frozen';
        ocean = this.rng.pick(['mixed', 'ocean_world', 'barren']);
      } else if (type === 'gas') {
        climate = heat > 0.65 ? 'desert' : heat < 0.3 ? 'frozen' : 'temperate';
        ocean = 'barren';
      }
      // Far rocky/volcanic: turbulent DNA reads as vented crust in the bake.
      let chaos = this.rng.pick(chaosLevels);
      if (type === 'rocky' && heat < 0.4 && this.rng.chance(0.55)) chaos = 'turbulent';
      if (type === 'lava') chaos = this.rng.chance(0.7) ? 'storm' : 'turbulent';
      if (type === 'storm') chaos = 'storm';

      const dna: PlanetDNA = { climate, oceans: ocean, chaos };
      const radius = type === 'gas'
        ? this.rng.nextFloat(1.5, 3.2)
        : type === 'ice'
          ? this.rng.nextFloat(0.55, 1.45)
          : this.rng.nextFloat(0.45, 1.6);

      // ~30% of worlds get a noticeable ellipse; most stay near-circular.
      const eccentricity = this.rng.chance(0.32)
        ? this.rng.nextFloat(0.12, 0.48)
        : this.rng.nextFloat(0, 0.06);

      planets.push({
        orbitalAngle: this.rng.nextFloat(0, Math.PI * 2),
        orbitalRadius: a,
        orbitalSpeed: (PLANET_ORBIT_MU / Math.sqrt(Math.max(0.5, a / 10))) * this.rng.nextFloat(0.85, 1.15),
        eccentricity,
        periapsisAngle: this.rng.nextFloat(0, Math.PI * 2),
        radius,
        type,
        hasLife: false,
        biosphere: 0,
        color: this.rng.pick(COLOR_POOL[type]),
        discovery: 'none',
        name: romanNumerals[i] ?? String(i + 1),
        moons: [],
        dna,
      });
      const p = planets[planets.length - 1];
      p.moons = this.generateMoons(p, romanNumerals[i] ?? String(i + 1));
    }
    void stats;
    return planets;
  }

  /** heat 1 = closest to star, 0 = outer system. */
  private pickPlanetTypeForDistance(heat: number): Planet['type'] {
    const r = this.rng.next();
    if (heat > 0.72) {
      // Scorching: magma, hot gas, barren rock, desert, carbon
      if (r < 0.30) return 'lava';
      if (r < 0.48) return 'gas';
      if (r < 0.62) return 'desert';
      if (r < 0.74) return 'carbon';
      return 'rocky';
    }
    if (heat > 0.42) {
      // Temperate band — classic + wild types
      if (r < 0.18) return 'ocean';
      if (r < 0.34) return 'rocky';
      if (r < 0.48) return 'gas';
      if (r < 0.58) return 'toxic';
      if (r < 0.68) return 'crystal';
      if (r < 0.78) return 'desert';
      if (r < 0.88) return 'storm';
      return this.rng.chance(0.5) ? 'rocky' : 'ice';
    }
    // Cold fringe: ice, rocky, gas, storm, carbon, crystal
    if (r < 0.30) return 'ice';
    if (r < 0.48) return 'rocky';
    if (r < 0.62) return 'gas';
    if (r < 0.74) return 'storm';
    if (r < 0.86) return 'carbon';
    if (r < 0.94) return 'crystal';
    return 'ice';
  }

  /**
   * Roll a planet's satellites.
   *
   * Count and composition follow the parent: gas giants keep whole retinues of
   * ice moons, small rocky worlds usually keep none. Habitability is set here
   * rather than derived later, so a moon is a fixed fact about a system that a
   * civilisation may or may not ever be able to use.
   */
  private generateMoons(planet: Planet, label: string): Moon[] {
    const rng = this.rng;
    // Bigger worlds hold more. A gas giant plausibly has a dozen; the sim only
    // needs enough to look and feel right.
    const maxCount = planet.type === 'gas' ? 4
                   : planet.radius > 0.9 ? 2
                   : 1;
    const count = rng.nextInt(0, maxCount);
    if (count === 0) return [];

    // Which compositions are plausible around this kind of planet.
    const POOLS: Record<Planet['type'], MoonKind[]> = {
      gas:     ['ice', 'ice', 'rock', 'ocean', 'carbon'],
      ice:     ['ice', 'ice', 'rock'],
      ocean:   ['rock', 'ice', 'carbon'],
      rocky:   ['rock', 'rock', 'iron', 'carbon'],
      lava:    ['volcanic', 'iron', 'rock'],
      toxic:   ['rock', 'carbon', 'ice'],
      crystal: ['ice', 'rock', 'carbon'],
      desert:  ['rock', 'iron', 'carbon'],
      storm:   ['ice', 'rock', 'ocean'],
      carbon:  ['carbon', 'rock', 'iron'],
    };
    const TINT: Record<MoonKind, string> = {
      rock:     '#b9b2a6',
      ice:      '#d6ecf8',
      iron:     '#8c7f78',
      volcanic: '#c96a44',
      carbon:   '#4c4a52',
      ocean:    '#5f9fd0',
    };
    // A subsurface ocean is the prize; bare iron is nearly worthless.
    const HAB: Record<MoonKind, [number, number]> = {
      ocean:    [0.55, 0.85],
      ice:      [0.30, 0.60],
      carbon:   [0.22, 0.45],
      rock:     [0.15, 0.40],
      volcanic: [0.05, 0.22],
      iron:     [0.04, 0.18],
    };

    const pool = POOLS[planet.type];
    const moons: Moon[] = [];
    for (let i = 0; i < count; i++) {
      const kind = pool[rng.nextInt(0, pool.length - 1)];
      const [hlo, hhi] = HAB[kind];
      // Occasional large moon — readable in system view / future colony target.
      const large = rng.chance(planet.type === 'gas' ? 0.35 : 0.18);
      const radius = large
        ? planet.radius * rng.nextFloat(0.42, 0.62)
        : planet.radius * rng.nextFloat(0.16, 0.36);
      moons.push({
        name: `${label}-${'abcdefgh'[i]}`,
        radius: Math.min(radius, planet.radius * 0.7),
        orbitalRadius: planet.radius * (2.2 + i * 1.5) + rng.nextFloat(0, 1.2) + (large ? 1.5 : 0),
        orbitalAngle: rng.nextFloat(0, Math.PI * 2),
        orbitalSpeed: rng.nextFloat(0.0033, 0.010) / (i + 1),
        color: TINT[kind],
        kind,
        habitability: rng.nextFloat(hlo, hhi) + (large ? 0.08 : 0),
        colonised: false,
        colonisedTick: null,
      });
    }
    return moons;
  }

  /**
   * Settle moons once a civilisation can actually reach them.
   *
   * civLevel 5 is the Space Age — the first tier that plausibly puts people on
   * another body. Better moons are taken first, and a poor one may never be
   * worth the trouble at all.
   */
  private updateMoonColonisation(star: StarBody): void {
    if (star.civLevel < 5) return;
    // How marginal a moon a civilisation will accept rises with its reach.
    const threshold = Math.max(0.15, 0.75 - (star.civLevel - 5) * 0.2);
    for (const planet of star.planets) {
      for (const moon of planet.moons) {
        if (moon.colonised || moon.habitability < threshold) continue;
        moon.colonised = true;
        moon.colonisedTick = this.tick;
        const where = `${moon.name}, a ${moon.kind} moon of ${planet.name}`;
        if (star.isPlayerStar) {
          this.onCivEvent?.(`Your people have founded a colony on ${where}.`);
        } else if (this.isStarKnownToPlayer(star)) {
          this.onCivEvent?.(`${star.civName} has colonised ${where}.`);
        }
      }
    }
  }

  /** Galaxy names read as catalogue designations rather than civ names. */
  private generateGalaxyName(morph: GalaxyMorph): string {
    const shapeLabel: Record<GalaxyMorph, string> = {
      spiral: 'Spiral',
      barred: 'Barred',
      lenticular: 'Lenticular',
      elliptical: 'Elliptical',
      irregular: 'Irregular',
    };
    const greek = this.rng.pick(['Alpha', 'Beta', 'Gamma', 'Delta', 'Sigma', 'Omega', 'Theta']);
    return `${greek} ${shapeLabel[morph]} ${this.rng.nextInt(100, 999)}`;
  }

  /** This universe's galaxies, with their centres kept current. */
  get currentGalaxies(): Galaxy[] { return this.galaxies; }

  /**
   * Refresh envelope radius from living stars. The kinematic centre (cx/cy)
   * stays put — chasing the star-mean dragged every system whenever the census
   * ran (~every 3s at 200×).
   */
  private updateGalaxies(): void {
    if (this.galaxies.length === 0) return;
    for (const gal of this.galaxies) {
      let far = 0;
      let n = 0;
      for (const st of this.stars) {
        if (st.galaxyId !== gal.id) continue;
        n++;
        far = Math.max(far, Math.hypot(st.x - gal.cx, st.y - gal.cy));
      }
      if (n === 0) continue;
      // Eccentric galactic orbits make `far` breathe every census. Ignore small
      // swings so the drawn envelope (and any dependent work) stays put.
      const next = Math.max(30, far * 1.12);
      if (Math.abs(next - gal.tRadius) >= Math.max(18, gal.tRadius * 0.04)) {
        gal.tRadius = next;
      }
      gal.x = gal.cx;
      gal.y = gal.cy;
    }
  }

  /** Ease drawn radius toward the census target (centre never moves). */
  private smoothGalaxyRadii(): void {
    const k = 0.06;
    for (const gal of this.galaxies) {
      gal.radius += (gal.tRadius - gal.radius) * k;
      gal.x = gal.cx;
      gal.y = gal.cy;
    }
  }

  /** How far in the player is currently looking. */
  get zoomTier(): ZoomTier {
    const sc = this.camera.scale;
    let out: ZoomTier = 'universe';
    for (const t of ZOOM_TIERS) if (sc >= t.min) out = t.tier;
    return out;
  }

  /** Jump the camera to a tier. Used by the view switcher. */
  setZoomTier(tier: ZoomTier): void {
    const def = ZOOM_TIERS.find(t => t.tier === tier);
    if (!def) return;
    this.camera.ts = def.nominal;
    // Universe and galaxy tiers frame the whole structure; the closer tiers
    // frame the player, since that is what they are for.
    if (tier === 'universe') {
      this.camera.tx = WORLD_SIZE / 2;
      this.camera.ty = WORLD_SIZE / 2;
      this.cameraFollowHome = false;
    } else {
      this.cameraFollowHome = true;
      const ps = this.getPlayerStar();
      if (ps) {
        if (tier === 'galaxy') {
          const gal = this.galaxies.find(gx => gx.id === ps.galaxyId);
          this.camera.tx = gal ? gal.cx : ps.x;
          this.camera.ty = gal ? gal.cy : ps.y;
        } else {
          this.camera.tx = ps.x;
          this.camera.ty = ps.y;
        }
      }
    }
  }

  private generateCivName(): string {
    const rng = this.rng;
    const pre = ['Vor','Sol','Keth','Aex','Nyx','Zar','Ith','Bel','Cyr','Eth','Fer','Osh'];
    const suf = ['ix','ath','on','ara','ux','iel','os','ova','ax','in','um','al'];
    return rng.pick(pre) + rng.pick(suf);
  }

  private tempToRGB(t: number): [number, number, number] {
    if (t > 15000) return [180, 210, 255];
    if (t > 7500)  return [255, 255, 255];
    if (t > 5000)  return [255, 220, 150];
    if (t > 4000)  return [255, 160, 80];
    return [255, 100, 50];
  }

  private onResize(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.fogCanvas.width = window.innerWidth;
    this.fogCanvas.height = window.innerHeight;
  }

  // ── Religion ────────────────────────────────────────────────────────────────

  private updateReligions(): void {
    if (this.phase !== 'settled') return;

    for (const star of this.stars) {
      if (star.isDead || !star.hasLife || !star.religionName) continue;

      // Slow devotion growth
      if (star.religionDevotion < 1.0) {
        star.religionDevotion = Math.min(1.0, star.religionDevotion + 0.00004);
      }

      // Schism: wars erode faith
      if (this.tick % 200 === 0) {
        const atWar = this.activeWars.some(w =>
          !w.resolved && (w.attackerStarId === star.id || w.defenderStarId === star.id)
        );
        if (atWar && star.religionDevotion > 0.2 && this.rng.chance(0.12)) {
          star.religionDevotion = Math.max(0.05, star.religionDevotion - 0.18);
          if (this.isStarKnownToPlayer(star)) {
            this.onReligionEvent?.(
              `War has fractured the ${star.religionName} in ${star.civName} — a schism divides the faithful.`
            );
          }
        }
      }
    }
  }

  private drawReligions(ctx: CanvasRenderingContext2D): void {
    if (this.phase !== 'settled') return;
    if (this.camera.scale < 0.35) return;

    for (const star of this.stars) {
      if (star.isDead || !star.religionName || star.religionDevotion <= 0) continue;
      const worldR = star.radius;
      const pulse = 0.6 + 0.4 * Math.sin(this.animTick * 0.025 + star.id * 0.8);
      const alpha = star.religionDevotion * 0.38 * pulse;
      const ringR = worldR * 3.2 + star.religionDevotion * (4 / this.camera.scale);

      ctx.save();
      ctx.strokeStyle = `rgba(220, 185, 80, ${alpha})`;
      ctx.lineWidth = 0.8 / this.camera.scale;
      ctx.shadowColor = 'rgba(255, 210, 80, 0.6)';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(star.x, star.y, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Revelation flashes — bright gold burst
    for (let i = this.revelationFlashes.length - 1; i >= 0; i--) {
      const fl = this.revelationFlashes[i];
      const age = this.animTick - fl.startAnimTick;
      if (age > 80) { this.revelationFlashes.splice(i, 1); continue; }
      const t = age / 80;
      const r = (8 + t * 60) / this.camera.scale;
      const alpha = (1 - t) * 0.7;
      ctx.save();
      ctx.strokeStyle = `rgba(255, 220, 80, ${alpha})`;
      ctx.lineWidth = 2 / this.camera.scale;
      ctx.shadowColor = 'rgba(255, 200, 60, 0.9)';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(fl.x, fl.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private generateReligionName(): string {
    const prefix = ['Order of', 'Church of', 'Path of', 'Disciples of', 'Temple of', 'Choir of', 'Children of'];
    const nouns  = ['the Eternal Star', 'the Void', 'the First Light', 'the Pale Sun', 'the Deep Dark',
                    'the Infinite', 'the Wandering God', 'the Ascending', 'the Ember', 'the Silent Sky',
                    'the Sacred Flame', 'the Hollow God', 'the Endless Dark', 'the Shining Eye'];
    return this.rng.pick(prefix) + ' ' + this.rng.pick(nouns);
  }

  setPlayerReligion(name: string): void {
    const ps = this.getPlayerStar();
    if (!ps) return;
    ps.religionName = name;
    ps.religionDevotion = 0.25;
  }

  triggerRevelation(): void {
    const ps = this.getPlayerStar();
    if (!ps || !ps.religionName) return;
    ps.religionDevotion = Math.min(1.0, ps.religionDevotion + 0.3);
    this.revelationFlashes.push({ x: ps.x, y: ps.y, startTick: this.tick, startAnimTick: this.animTick });
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  serialize(): EngineSnapshot {
    return {
      version: 1,
      tick: this.tick,
      phase: this.phase,
      stars: this.stars,
      nebulae: this.nebulae,
      asteroids: this.asteroids,
      fleets: this.fleets,
      orbitalFleets: this.orbitalFleets,
      cosmicEvents: this.cosmicEvents,
      activeWars: this.activeWars,
      exploredAreas: this.exploredAreas,
      settledSinceTick: this.settledSinceTick,
      cosmicEventIdCounter: this.cosmicEventIdCounter,
      warIdCounter: this.warIdCounter,
      fleetIdCounter: this.fleetIdCounter,
      orbitalFleetIdCounter: this.orbitalFleetIdCounter,
      nextCosmicCheckTick: this.nextCosmicCheckTick,
      starIdCounter: this.starIdCounter,
      stellarNurseries: this.stellarNurseries,
      rngState: this.rng.getState(),
      leaders: gameState.leaders,
      factionFlags: gameState.factionFlags,
      firstContactFired: gameState.firstContactFired,
      cosmicSignals: [...this.cosmicSignals],
      playerSpecies:   gameState.playerSpecies.map(s => ({
        ...s, dna: { ...s.dna }, evolutionaryPotential: { ...s.evolutionaryPotential },
        physicalTraits: { ...s.physicalTraits }, habitat: { ...s.habitat },
      })),
      playerBiosphere: { ...gameState.playerBiosphere },
      civilizations: gameState.civilizations,
    };
  }

  loadState(snap: EngineSnapshot): void {
    this.tick = snap.tick;
    this.phase = snap.phase;
    this.stars = snap.stars;
    // Saves written before the genome existed have no genomeSeed. Derive it
    // once from the same inputs creation uses, so an old save and a new game
    // produce identical worlds.
    for (const star of this.stars) {
      star.planets.forEach((p, i) => {
        if (!Number.isFinite(p.genomeSeed)) p.genomeSeed = genomeSeedFor(star.id, i);
      });
    }
    // Migrate older saves missing eccentricity / belt density.
    for (const s of this.stars) {
      if (s.asteroidBeltDensity == null) {
        s.asteroidBeltDensity = s.asteroidBelt ? 0.6 : 0;
      }
      for (const p of s.planets ?? []) {
        if (p.eccentricity == null) p.eccentricity = 0;
        if (p.periapsisAngle == null) p.periapsisAngle = 0;
      }
    }
    this.nebulae = snap.nebulae;
    this.asteroids = snap.asteroids;
    this.fleets = snap.fleets;
    this.orbitalFleets = snap.orbitalFleets ?? [];
    this.cosmicEvents = snap.cosmicEvents;
    this.activeWars = snap.activeWars;
    this.exploredAreas = snap.exploredAreas;
    this.playerFogIndex = -1;
    this.cameraFollowHome = true;
    {
      const ps = this.stars.find(s => s.isPlayerStar && !s.isDead);
      if (ps && this.exploredAreas.length > 0) {
        // Prefer the hole nearest the player star so the tracking bubble
        // resumes after load instead of leaving home in fog mid-orbit.
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < this.exploredAreas.length; i++) {
          const a = this.exploredAreas[i];
          const d = (a.x - ps.x) ** 2 + (a.y - ps.y) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        }
        this.playerFogIndex = best;
        this.exploredAreas[best].x = ps.x;
        this.exploredAreas[best].y = ps.y;
        this.exploredAreas[best].r = Math.max(
          this.exploredAreas[best].r,
          Math.max(300, ps.explorationRadius),
        );
      }
    }
    this.settledSinceTick = snap.settledSinceTick;
    this.cosmicEventIdCounter = snap.cosmicEventIdCounter;
    this.warIdCounter = snap.warIdCounter;
    this.fleetIdCounter = snap.fleetIdCounter;
    this.orbitalFleetIdCounter = snap.orbitalFleetIdCounter ?? 0;
    this.nextCosmicCheckTick = snap.nextCosmicCheckTick;
    this.stellarNurseries = snap.stellarNurseries ?? [];
    // Old saves have no counter — resume past the highest id already in use so
    // newly formed stars can never collide with an existing one.
    this.starIdCounter = snap.starIdCounter
      ?? (this.stars.reduce((m, s2) => Math.max(m, s2.id), -1) + 1);
    this.rng.setState(snap.rngState);
    if (snap.leaders)      gameState.leaders      = snap.leaders;
    if (snap.factionFlags) gameState.factionFlags = snap.factionFlags;
    if (snap.firstContactFired !== undefined) gameState.firstContactFired = snap.firstContactFired;
    if (snap.cosmicSignals) this.cosmicSignals = snap.cosmicSignals;
    if (snap.playerSpecies)   gameState.playerSpecies   = snap.playerSpecies;
    if (snap.playerBiosphere) gameState.playerBiosphere = snap.playerBiosphere;
    // Without this, every civilisation that reached 'intelligent' mid-game was
    // silently discarded on load: init() (called just before this) always
    // resets gameState.civilizations to {}, and ensureCivilization only fires
    // on the intelligent-phase TRANSITION — which, for a restored star, already
    // happened in a past session and will never fire again.
    if (snap.civilizations)  gameState.civilizations   = snap.civilizations;
    // A save written before this field existed restores none, and the
    // transition above will never fire again for those stars — so without this
    // backfill every civilisation in an old save stays cultureless for good.
    // `ensureCivilization` no-ops where a record is already present, so this is
    // idempotent and costs nothing on a current save.
    for (const s of this.stars) {
      if (!s.isDead && s.biologyPhase === 'intelligent') this.ensureCivilization(s);
    }
    this.supernovaFlashes = [];
    this.revelationFlashes = [];
    this.planetTextureCache.clear();
  }
}

