import { SeedRNG } from '../utils/SeedRNG';
import {
  UniverseStats, TECH_LEVELS, CIV_COLORS,
  BiologyPhase, BIO_PHASE_SEQUENCE, BIO_PHASE_LABELS, CODEX_MILESTONES,
  DNABranch, DEFAULT_DNA_BRANCH,
  CodexEntry, civLevelToPhase,
  gameState, runtimeState, DEFAULT_PLANET_DNA,
} from './GameState';
import { bakePlanetTexture } from './PlanetRenderer';
import { generateLeader, type Leader } from './Leader';
import { generateFactionFlag, drawFactionFlag, type FactionFlag } from './FactionFlag';
import {
  stepEvolution, shouldStepEvolution, initPlayerSpecies, applyNudgeMutation,
  type EvolutionEvent,
} from './EvolutionEngine';
import { stepLifeSpread } from './PlanetGrid';
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
  cultureMultiplier, proceduralCulture, summariseGenome,
  type Civilization, type GenomeSummary,
} from './Civilization';
import { generateCulture } from '../ai/CultureGenerator';
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
  orbitalRadius: number;
  orbitalSpeed: number;
  radius: number;
  type: 'rocky' | 'ocean' | 'gas' | 'ice' | 'lava';
  hasLife: boolean;
  biosphere: number;    // 0–1
  color: string;
  discovery: PlanetDiscovery;
  name: string;         // assigned on first telescope-level discovery
  /** Natural satellites. Empty for most planets; gas giants keep the most. */
  moons: Moon[];
}

/**
 * A galaxy: a named clump of stars (M22b).
 *
 * The universe was one undifferentiated disc of stars, so there was nothing for
 * a "galaxy" zoom tier to show. The Big Bang now throws its stars toward a
 * handful of centres instead of scattering them uniformly, which is what makes
 * the opening read as galaxies forming rather than one spray of dots.
 */
export interface Galaxy {
  id: number;
  name: string;
  /** Centre in world coordinates; tracks the mean position of its stars. */
  x: number;
  y: number;
  /** Radius covering most of its stars, in world units. */
  radius: number;
  color: string;
  /** Rotation of the elliptical envelope, radians. */
  tilt: number;
  starIds: number[];
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

/** Camera scale at which each tier begins, and the scale a jump lands on. */
export const ZOOM_TIERS: Array<{ tier: ZoomTier; min: number; nominal: number; label: string }> = [
  { tier: 'universe', min: 0.00, nominal: 0.28, label: 'Universe' },
  { tier: 'galaxy',   min: 0.45, nominal: 0.95, label: 'Galaxy'   },
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
  asteroidBelt: boolean;
  lastEventTick: number;
  /** Which galaxy this star belongs to (M22b). */
  galaxyId?: number;
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

const GRAVITY_CONSTANT = 0.009;   // weaker gravity → less clustering
// Multiplier of the summed radii at which two stars merge. This was 2.0, which
// with no counter-pressure let the whole cluster coalesce: a long game collapsed
// to a handful of stars and then to one.
const COLLISION_DIST   = 1.15;
const NEBULA_EXPAND    = 0.35;
const NEBULA_FADE      = 0.003;
const DAMPING          = 0.992;
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

  private rng!: SeedRNG;
  private camera: Camera = { x: WORLD_SIZE/2, y: WORLD_SIZE/2, scale: 1.5, tx: WORLD_SIZE/2, ty: WORLD_SIZE/2, ts: 1.5 };
  private playerStarId = -1;
  private fleetIdCounter = 0;
  private running = false;
  private animHandle = 0;
  private exploredAreas: Array<{ x: number; y: number; r: number }> = [];
  private _lastClickTime = 0;
  private _lastClickedStarId = -1;

  // Event callbacks
  onCivEvent: ((msg: string) => void) | null = null;
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
  onWarBattle: ((warId: number, attackerName: string, defenderName: string, attackerDice: number[], attackerColor: string, phase: string) => void) | null = null;
  onLeaderMessage: ((leader: Leader, eventContext: string, starId: number) => void) | null = null;
  // Phase / evolution callbacks
  onBioPhaseAdvance: ((phase: BiologyPhase, starName: string) => void) | null = null;
  onCodexMilestone:  ((entry: Omit<CodexEntry, 'body'>) => void) | null = null;
  onDNAPointEarned:  ((total: number) => void) | null = null;
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
    const mass = this.rng.nextFloat(1, 8);
    return {
      id: this.starIdCounter++,
      x, y, vx: 0, vy: 0,
      mass,
      radius: 2.5 + mass * 0.8,
      temperature: this.rng.nextFloat(3000, 30000),
      age: 0,
      hasLife: false,
      civLevel: 0,
      civName: this.generateCivName(),
      planets: this.generatePlanets(this.stats, mass),
      explorationRadius: 30,
      isPlayerStar: false,
      isDead: false,
      asteroidBelt: this.rng.chance(this.stats.entropy / 30),
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

      // Scatter the newborn away from the collapse site so it doesn't instantly
      // re-merge with whatever is still there.
      const angle = this.rng.nextFloat(0, Math.PI * 2);
      const dist  = this.rng.nextFloat(60, 180);
      let nx = n.x + Math.cos(angle) * dist;
      let ny = n.y + Math.sin(angle) * dist;

      // Keep it inside the disc.
      const cx = WORLD_SIZE / 2, cy = WORLD_SIZE / 2;
      const dr = Math.hypot(nx - cx, ny - cy);
      if (dr > UNIVERSE_RADIUS) {
        nx = cx + (nx - cx) / dr * UNIVERSE_RADIUS * 0.95;
        ny = cy + (ny - cy) / dr * UNIVERSE_RADIUS * 0.95;
      }

      const star = this.createStar(nx, ny);
      // A little orbital motion so it isn't immediately pulled straight back in.
      const tangent = Math.atan2(ny - cy, nx - cx) + Math.PI / 2;
      const orbitalV = this.rng.nextFloat(0.15, 0.5);
      star.vx = Math.cos(tangent) * orbitalV;
      star.vy = Math.sin(tangent) * orbitalV;

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
    this.tick = 0;
    this.phase = 'inflation';
    this.stars = [];
    this.nebulae = [];
    this.asteroids = [];
    this.fleets = [];
    this.exploredAreas = [];
    this.cosmicEvents = [];
    this.activeWars = [];
    this.supernovaFlashes = [];
    this.galaxies = [];
    this.newSystemsFormed = 0;
    this.newSystemsBornAlive = 0;
    this.cosmicEventIdCounter = 0;
    this.warIdCounter = 0;
    this.nextCosmicCheckTick = 2000;
    this.starIdCounter = 0;
    this.stellarNurseries = [];

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

    const starCount = Math.floor(40 + stats.life * 6);   // 46–160 stars
    const cx = WORLD_SIZE / 2, cy = WORLD_SIZE / 2;

    // Size the blast so the universe lands INSIDE its boundary. The old fixed
    // force threw most stars well past the rim at high entropy, so they piled
    // up against the edge instead of spreading — which is what made the cosmos
    // read as a hard-edged shape rather than a galaxy.
    const spreadFrac = 0.42 + (stats.entropy / 20) * 0.50;       // 0.44 … 0.92
    const maxDrift   = UNIVERSE_RADIUS * spreadFrac;

    // ── Galaxies first, stars second ────────────────────────────────────────
    // The Big Bang throws its matter toward a handful of centres rather than
    // scattering it evenly, so what condenses out is galaxies. Without this
    // there is no structure above "star" for a galaxy tier to show.
    // FEW and LARGE. Galaxy radius is really a stellar-density control, and
    // density drives everything downstream: too tight and gravity runs away,
    // mergers cascade and the cosmos ends up with one biochemistry and no
    // civilisations at all (measured). Too loose and the envelopes overlap into
    // a single blob and there are visibly no galaxies. Fewer, bigger galaxies
    // are the way to have both.
    const galaxyCount = this.rng.nextInt(3, 4);
    // Centres ride a ring far enough out to leave room between them.
    const ringR = maxDrift * this.rng.nextFloat(0.50, 0.62);
    // The largest radius that still leaves adjacent galaxies clear of each
    // other, derived from the count rather than guessed — half the arc between
    // neighbours, with a margin. This is what keeps them DISTINCT at any count.
    const spacingLimit = ringR * Math.sin(Math.PI / galaxyCount) * 0.92;

    for (let gi = 0; gi < galaxyCount; gi++) {
      const ga = (gi / galaxyCount) * Math.PI * 2 + this.rng.nextFloat(-0.25, 0.25);
      const gr = ringR * this.rng.nextFloat(0.88, 1.12);
      this.galaxies.push({
        id: gi,
        name: this.generateGalaxyName(),
        x: cx + Math.cos(ga) * gr,
        y: cy + Math.sin(ga) * gr,
        // Bounded three ways: by neighbour spacing, by a hard ceiling that keeps
        // any one galaxy from swallowing the disc, and by the universe rim.
        radius: Math.min(
          spacingLimit,
          maxDrift * 0.42,
          Math.max(60, maxDrift - gr),
        ) * this.rng.nextFloat(0.86, 1.0),
        color: ['#8ea8ff', '#ffc9a0', '#c7a0ff', '#a0ffd8', '#ffa0c8'][gi % 5],
        tilt: this.rng.nextFloat(0, Math.PI),
        starIds: [],
      });
    }

    for (let i = 0; i < starCount; i++) {
      // Weight membership so galaxies differ in size rather than all holding
      // the same share.
      const gal = this.galaxies[this.rng.nextInt(0, this.galaxies.length - 1)];

      // Where in its galaxy this star ends up. sqrt() keeps the distribution
      // roughly area-uniform so the disc fills out instead of bunching.
      const la = this.rng.nextFloat(0, Math.PI * 2);
      const lr = gal.radius * Math.sqrt(this.rng.nextFloat(0.02, 1));
      const tx = gal.x + Math.cos(la) * lr;
      const ty = gal.y + Math.sin(la) * lr;

      // Aim the star at that destination, so inflation resolves into clumps.
      const dx = tx - cx, dy = ty - cy;
      const dist = Math.hypot(dx, dy) || 1;
      const outwardForce = dist / INFLATION_DRIFT;
      const angle = Math.atan2(dy, dx);
      const spinForce = outwardForce * this.rng.nextFloat(0.04, 0.14);

      const star = this.createStar(cx + this.rng.nextFloat(-3, 3), cy + this.rng.nextFloat(-3, 3));
      star.vx = Math.cos(angle) * outwardForce - Math.sin(angle) * spinForce;
      star.vy = Math.sin(angle) * outwardForce + Math.cos(angle) * spinForce;
      star.galaxyId = gal.id;
      gal.starIds.push(star.id);
      this.stars.push(star);
    }

    // Mark player's star (first one)
    this.stars[0].isPlayerStar = true;
    this.stars[0].temperature = 5800; // Sun-like
    this.stars[0].civLevel = 0;
    this.playerStarId = 0;

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
    const wantsOcean = gameState.playerPlanetDNA?.oceans === 'ocean_world';
    const wantsDry   = gameState.playerPlanetDNA?.oceans === 'barren';
    const preferred: Planet['type'] = wantsOcean ? 'ocean' : wantsDry ? 'rocky' : 'ocean';

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
      // The player's world is guaranteed to be a good one — this is the world the
      // whole game is about — but it still gets its own chemistry and tempo, so
      // no two playthroughs climb the ladder at the same speed.
      playerPlanet.orbitalRadius = 12 + (ps0.temperature - 3000) / 27000 * 34;
      ps0.habitability = undefined;
      ps0.bestPlanetIndex = playerIdx;
      this.igniteLife(ps0, playerIdx);
      playerPlanet.biosphere = 0.8;
      playerPlanet.color = '#3a8f3a';
      playerPlanet.discovery = 'landing'; // Home world — fully surveyed
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
    this.animHandle = requestAnimationFrame(this.loop.bind(this));
  }

  stop(): void {
    this.running = false;
    if (this.animHandle) cancelAnimationFrame(this.animHandle);
  }

  private loop(): void {
    if (!this.running) return;
    this.update();
    this.render();
    this.animHandle = requestAnimationFrame(this.loop.bind(this));
  }

  update(): void {
    const speed = (window as unknown as Record<string, unknown>)['eternalSpeed'] as number ?? 1;

    // Big Bang phases (inflation + gravity) always run at 1 tick/frame — animation speed, not game speed.
    // The fractional accumulator only applies once the universe is settled.
    let ticksThisFrame: number;
    if (speed <= 0) {
      // Paused. The Big Bang phases normally run a fixed tick per frame, but an
      // explicit pause has to hold there too or the control lies to the player.
      ticksThisFrame = 0;
    } else if (this.phase !== 'settled') {
      ticksThisFrame = 1;
    } else {
      this.tickAccumulator += speed / 60;
      ticksThisFrame = Math.floor(this.tickAccumulator);
      this.tickAccumulator -= ticksThisFrame;
    }

    for (let s = 0; s < ticksThisFrame; s++) {
      this.tick++;
      this.onTickUpdate?.(this.tick);

      if (this.phase === 'inflation') {
        this.updateInflation();
        if (this.tick >= INFLATION_TICKS) {
          this.phase = 'gravity';
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
            this.camera.ts = 3.5;
            // Punch a large hole in the fog at the player's actual settled position
            this.exploredAreas.push({ x: ps.x, y: ps.y, r: 300 });
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

    // Camera lerp
    this.camera.x += (this.camera.tx - this.camera.x) * 0.06;
    this.camera.y += (this.camera.ty - this.camera.y) * 0.06;
    this.camera.scale += (this.camera.ts - this.camera.scale) * 0.06;
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
      this.camera.ts = 0.22;
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

  private updateGravity(): void {
    const active = this.stars.filter(s => !s.isDead);

    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i], b = active[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist2 = dx * dx + dy * dy;
        const dist = Math.sqrt(dist2);

        if (dist < (a.radius + b.radius) * COLLISION_DIST) {
          this.mergeStars(a, b);
          continue;
        }

        if (dist < 250) {
          const force = GRAVITY_CONSTANT * a.mass * b.mass / dist2;
          const fx = force * dx / dist, fy = force * dy / dist;
          a.vx += fx / a.mass;  a.vy += fy / a.mass;
          b.vx -= fx / b.mass;  b.vy -= fy / b.mass;
        }
      }
    }

    for (const star of active) {
      // Dampen
      star.vx *= DAMPING;
      star.vy *= DAMPING;
      // Clamp speed
      const spd = Math.sqrt(star.vx * star.vx + star.vy * star.vy);
      if (spd > MAX_SPEED) { star.vx *= MAX_SPEED / spd; star.vy *= MAX_SPEED / spd; }
      star.x += star.vx;
      star.y += star.vy;
      this.constrainToUniverse(star);
      star.age++;
    }

    this.checkCollisions();

    // Occasional asteroid spawn from entropy stat
    if (this.tick % ASTEROID_SPAWN === 0 && this.rng.chance(this.stats.entropy / 22)) {
      this.spawnAsteroid();
    }
  }

  private checkCollisions(): void {
    const active = this.stars.filter(s => !s.isDead);
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i], b = active[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < (a.radius + b.radius) * 1.1) {
          this.mergeStars(a, b);
        }
      }
    }
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
          if (!star.hasLife && !star.formationStage) {
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
          if (shouldStepEvolution(this.tick)) {
            const result = stepEvolution(
              star.biologyPhase,
              gameState.playerDNA,
              gameState.playerSpecies,
              gameState.playerBiosphere,
              this.rng,
              this.tick,
              runtimeState.branchDefs,
            );
            gameState.playerSpecies   = result.updatedSpecies;
            gameState.playerBiosphere = result.updatedBiosphere;
            for (const evt of result.events) {
              if (evt.type === 'mutation')    this.onMutationEvent?.(evt);
              if (evt.type === 'speciation')  this.onSpeciationEvent?.(evt);
              if (evt.type === 'extinction')  this.onExtinctionEvent?.(evt);
            }
          }
        }

        continue; // no civilisation advancement until intelligence emerges
      }

      // ── Civilisation tech advancement (post-intelligence) ────────────────────
      let advanceRate = CIV_TICK_RATE * (21 - this.stats.evolution) / 10;
      // DNA intelligence branch speeds up research for player's species
      if (star.isPlayerStar) {
        advanceRate *= Math.max(0.4, 1 - this.playerEffect('techSpeed') * 0.55);
      }
      if (star.isPlayerStar && this.prophetBoostActive) advanceRate *= 0.5;

      // A curious people advances faster. Bounded, so no culture stalls a
      // civilisation outright or races it to the end of the tech tree.
      const civCulture = this.cultureFor(star);
      if (civCulture) advanceRate /= cultureMultiplier(civCulture.values.curiosity, 1);

      if (star.age % Math.max(1, Math.floor(advanceRate)) === 0 &&
          star.civLevel < TECH_LEVELS.length - 1) {
        star.civLevel++;
        if (star.isPlayerStar && this.prophetBoostActive) this.prophetBoostActive = false;
        star.explorationRadius = 30 + star.civLevel * 20;

        if (star.isPlayerStar) {
          this.exploredAreas.push({ x: star.x, y: star.y, r: star.explorationRadius });
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
    return branchEffect(gameState.playerDNA, runtimeState.branchDefs, kind);
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
      // Species emerges — transition to civilisation
      star.civLevel = 0;
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
    // `Civilization.id` is `civ_${starId}` — a pure function of starId alone,
    // with no per-game nonce — while `gameState.civilizations` is a module-level
    // singleton, not scoped to this engine instance. Comparing `.id` alone
    // would only catch "this star died/was replaced within the SAME game";
    // it would not catch "the player abandoned this game and started a new one
    // whose star at the same id also became intelligent" before this promise
    // resolves — that would let a stale response built from the OLD universe's
    // genome and civName silently overwrite the NEW game's live record.
    // `gameState.masterSeed` changes on every new game (launchBigBang /
    // applyLoadedSave both reassign it before this could ever fire), so
    // capturing it now and re-checking it in `.then()` closes that gap too.
    const seedAtCall = gameState.masterSeed;
    void generateCulture(base, genome, star.civName, TECH_LEVELS[star.civLevel] ?? 'Primitive', gemini)
      .then(result => {
        if (gameState.masterSeed === seedAtCall &&
            gameState.civilizations[star.id]?.id === base.id) {
          gameState.civilizations[star.id] = result;
          this.onCultureGenerated?.(star.id, result);
        }
      });
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

  render(): void {
    this.animTick++;
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
      if (this.phase === 'inflation') this.drawStarTrails(ctx);
      this.drawTradeRoutes(ctx);
      this.drawStars(ctx);
      this.drawReligions(ctx);
      this.drawAsteroids(ctx);
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

  private bgStarCache: Array<{ x: number; y: number; r: number }> = [];
  private bgStarCacheW = 0;
  private bgStarCacheH = 0;

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
   */
  private drawGalaxies(ctx: CanvasRenderingContext2D): void {
    if (this.galaxies.length === 0) return;

    const sc = this.camera.scale;
    // 1 at the universe tier, tapering to 0 by the time systems are legible.
    let strength = Math.max(0, Math.min(1, (1.8 - sc) / 1.5));

    // Draw them during INFLATION too, and hardest of all there. This is the
    // moment the universe is being made and the galaxies are the thing being
    // made — gating on 'settled' meant the opening showed a spray of dots with
    // no structure, which is the whole complaint M22b exists to answer.
    if (this.phase === 'inflation') {
      // Fade in over the first stretch of the blast, as the clumps separate.
      strength = Math.max(strength, Math.min(1, this.tick / 90));
    }
    if (strength <= 0.01) return;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const gal of this.galaxies) {
      const live = gal.starIds.length;
      if (live === 0) continue;

      ctx.save();
      ctx.translate(gal.x, gal.y);
      ctx.rotate(gal.tilt);
      // Flattened, because a galaxy seen from anywhere but face-on is an ellipse.
      ctx.scale(1, 0.62);
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, gal.radius);
      const c = gal.color;
      grad.addColorStop(0,    this.hexA(c, 0.58 * strength));
      grad.addColorStop(0.35, this.hexA(c, 0.30 * strength));
      grad.addColorStop(0.70, this.hexA(c, 0.11 * strength));
      grad.addColorStop(1,    this.hexA(c, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, gal.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalCompositeOperation = 'source-over';

    // Labels, only while the galaxy tier is actually the subject.
    if (strength > 0.45) {
      ctx.textAlign = 'center';
      ctx.font = `${Math.max(7, 11 / sc)}px "Courier New", monospace`;
      for (const gal of this.galaxies) {
        if (gal.starIds.length === 0) continue;
        ctx.fillStyle = this.hexA(gal.color, 0.75 * strength);
        ctx.fillText(gal.name, gal.x, gal.y - gal.radius * 0.66);
        ctx.fillStyle = this.hexA(gal.color, 0.4 * strength);
        ctx.font = `${Math.max(6, 8 / sc)}px "Courier New", monospace`;
        const alive = this.stars.filter(st => !st.isDead && st.galaxyId === gal.id).length;
        ctx.fillText(`${alive} systems`, gal.x, gal.y - gal.radius * 0.66 + 10 / sc);
        ctx.font = `${Math.max(7, 11 / sc)}px "Courier New", monospace`;
      }
      ctx.textAlign = 'start';
    }
    ctx.restore();
  }

  /** '#rrggbb' + alpha → rgba() string. */
  private hexA(hex: string, a: number): string {
    const n = parseInt(hex.replace('#', ''), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
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
    const playerStar = this.stars.find(s => s.isPlayerStar) ?? null;
    for (const star of this.stars) {
      if (star.isDead) continue;

      const color = tempToColor(star.temperature);
      const glow = star.radius * (star.isPlayerStar ? 5 : 3);

      // Outer glow
      ctx.save();
      const grad = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, glow);
      grad.addColorStop(0, color);
      grad.addColorStop(0.3, color + '88');
      grad.addColorStop(1, color + '00');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(star.x, star.y, glow, 0, Math.PI * 2);
      ctx.fill();

      // Star core
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = color;
      ctx.shadowBlur = star.radius * 4;
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Player star: golden halo
      if (star.isPlayerStar) {
        ctx.strokeStyle = '#c8a96e';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.5 + 0.3 * Math.sin(this.animTick * 0.05);
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.radius * 3.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Civilization indicator
      if (star.hasLife && star.civLevel > 0 && this.phase === 'settled') {
        const civColor = CIV_COLORS[Math.min(star.civLevel, CIV_COLORS.length - 1)];
        ctx.strokeStyle = civColor;
        ctx.lineWidth = 0.8;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.radius + 3 + star.civLevel * 0.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Diplomatic status ring (only for known non-player stars in settled phase)
      if (!star.isPlayerStar && this.phase === 'settled' && this.isStarKnownToPlayer(star)) {
        if (playerStar) {
          const atWarWithPlayer = this.activeWars.some(
            w => !w.resolved && (
              (w.attackerStarId === star.id && w.defenderStarId === playerStar.id) ||
              (w.defenderStarId === star.id && w.attackerStarId === playerStar.id)
            )
          );
          const ringR = star.radius * 4.5;
          if (atWarWithPlayer) {
            // Hostile: pulsing red ring
            const pulse = 0.6 + 0.4 * Math.sin(this.tick * 0.08 + star.id * 1.3);
            ctx.strokeStyle = '#ff3322';
            ctx.lineWidth = 1.2;
            ctx.globalAlpha = pulse;
            ctx.beginPath();
            ctx.arc(star.x, star.y, ringR, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1;
          } else {
            // Neutral known: faint grey ring
            ctx.strokeStyle = '#667788';
            ctx.lineWidth = 0.6;
            ctx.globalAlpha = 0.3;
            ctx.beginPath();
            ctx.arc(star.x, star.y, ringR, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
      }

      // Faction flag (scale-gated)
      if (this.phase === 'settled' && star.hasLife && star.civLevel >= 1) {
        const flag = gameState.factionFlags[star.id];
        if (flag && this.camera.scale >= 0.6) {
          const flagY = star.y - star.radius * 5 - 4;
          drawFactionFlag(ctx, flag, star.x, flagY, 6);
        }
      }

      ctx.restore();
    }
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
      if (star.isDead || star.planets.length === 0) continue;
      const isPlayer = star === playerStar;
      // Only draw non-player planets when zoomed in enough to matter
      if (!isPlayer && this.camera.scale < 1.2) continue;

      for (const [i, p] of star.planets.entries()) {
        const angle = p.orbitalAngle + this.animTick * p.orbitalSpeed;
        const px = star.x + Math.cos(angle) * p.orbitalRadius;
        const py = star.y + Math.sin(angle) * p.orbitalRadius;

        // ── Orbit ring ─────────────────────────────────────────────────────
        ctx.save();
        ctx.strokeStyle = isPlayer
          ? 'rgba(200, 169, 110, 0.45)'
          : 'rgba(180, 200, 255, 0.22)';
        ctx.lineWidth = 0.8 / this.camera.scale;
        ctx.setLineDash([4 / this.camera.scale, 8 / this.camera.scale]);
        ctx.beginPath();
        ctx.arc(star.x, star.y, p.orbitalRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // ── Minimum visible radius (at least 2px on screen) ────────────────
        const displayR = Math.max(p.radius, 2 / this.camera.scale);

        // ── Atmosphere glow ────────────────────────────────────────────────
        if (this.camera.scale > 1.0) {
          const atmosRGB: Record<string, string> = {
            rocky: '180, 130, 80',
            ocean: '40, 120, 220',
            gas:   '200, 160, 90',
            ice:   '180, 220, 255',
            lava:  '220, 80, 20',
          };
          const rgb = p.hasLife ? '60, 200, 100' : (atmosRGB[p.type] ?? '180, 130, 80');
          const atmosR = displayR * 3;
          const grad = ctx.createRadialGradient(px, py, displayR * 0.5, px, py, atmosR);
          grad.addColorStop(0, `rgba(${rgb}, 0.4)`);
          grad.addColorStop(1, `rgba(${rgb}, 0)`);
          ctx.save();
          ctx.globalCompositeOperation = 'screen';
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(px, py, atmosR, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        // ── Planet core ────────────────────────────────────────────────────
        const screenR = displayR * this.camera.scale;
        ctx.save();
        ctx.beginPath();
        ctx.arc(px, py, displayR, 0, Math.PI * 2);

        if (screenR >= 6) {
          // Draw terrain texture as globe when planet is large enough on screen
          const texKey = `${star.id}_${i}`;
          let tex = this.planetTextureCache.get(texKey);
          if (!tex) {
            const dna = (star.isPlayerStar && i === 0)
              ? (gameState.playerPlanetDNA ?? DEFAULT_PLANET_DNA)
              : DEFAULT_PLANET_DNA;
            const bioPhase = (star.isPlayerStar && i === 0) ? (star.biologyPhase ?? null) : null;
            tex = bakePlanetTexture(star.id, i, p.type, dna, 128, bioPhase);
            this.planetTextureCache.set(texKey, tex);
          }
          ctx.clip();
          // Slow rotation: scroll texture horizontally, wrap via two full-image draws
          const destW = displayR * 2, destH = displayR * 2;
          const scrollFrac = (this.tick * 0.18) % tex.width / tex.width;
          const scrollPx = scrollFrac * destW;
          // First copy (shifted left) + second copy (wraps around right edge)
          ctx.drawImage(tex, 0, 0, tex.width, tex.height, px - displayR - scrollPx, py - displayR, destW, destH);
          ctx.drawImage(tex, 0, 0, tex.width, tex.height, px - displayR - scrollPx + destW, py - displayR, destW, destH);
          // Hemisphere shading overlay — darker on right/bottom, brighter upper-left
          const shade = ctx.createRadialGradient(
            px - displayR * 0.3, py - displayR * 0.3, 0,
            px + displayR * 0.2, py + displayR * 0.2, displayR * 1.6,
          );
          shade.addColorStop(0, 'rgba(255,255,255,0.08)');
          shade.addColorStop(0.5, 'rgba(0,0,0,0)');
          shade.addColorStop(1, 'rgba(0,0,0,0.65)');
          ctx.fillStyle = shade;
          ctx.fill();
        } else {
          // Tiny planets — flat fill
          ctx.fillStyle = p.hasLife ? '#4aaa55' : p.color;
          if (isPlayer && p.hasLife) {
            ctx.shadowColor = '#44ff88';
            ctx.shadowBlur = 8 / this.camera.scale;
          }
          ctx.fill();
          ctx.shadowBlur = 0;
        }
        ctx.restore();

        // ── Biosphere pulse ring ───────────────────────────────────────────
        if (p.hasLife) {
          const pulse = 0.5 + 0.4 * Math.sin(this.animTick * 0.05);
          ctx.beginPath();
          ctx.arc(px, py, displayR * 2.6, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(60, 220, 100, ${pulse * 0.4})`;
          ctx.lineWidth = 0.8 / this.camera.scale;
          ctx.stroke();
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

    const angle = home.orbitalAngle + this.animTick * home.orbitalSpeed;
    const wx = playerStar.x + Math.cos(angle) * home.orbitalRadius;
    const wy = playerStar.y + Math.sin(angle) * home.orbitalRadius;
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
    this.fogCanvas.width = W;
    this.fogCanvas.height = H;

    // Fill fog
    fogCtx.fillStyle = `rgba(0, 0, 8, ${FOG_ALPHA})`;
    fogCtx.fillRect(0, 0, W, H);

    // Punch holes for explored areas
    fogCtx.globalCompositeOperation = 'destination-out';
    for (const area of this.exploredAreas) {
      const { x, y } = this.worldToScreen(area.x, area.y, W, H);
      const r = area.r * this.camera.scale;
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

    ctx.drawImage(this.fogCanvas, 0, 0);
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private setupInput(): void {
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.85 : 1.18;
      this.camera.ts = Math.max(0.15, Math.min(5, this.camera.ts * factor));
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
    });

    window.addEventListener('mouseup', (e) => {
      if (!this.isDragging) return;
      const moved = Math.abs(e.clientX - this.dragStart.x) + Math.abs(e.clientY - this.dragStart.y);
      this.isDragging = false;

      // Click (not drag)
      if (moved < 5) {
        const wx = (e.clientX - (this.canvas.width / 2 - this.camera.x * this.camera.scale)) / this.camera.scale;
        const wy = (e.clientY - (this.canvas.height / 2 - this.camera.y * this.camera.scale)) / this.camera.scale;

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
          }
          this.onStarSelected?.(nearest);
        }
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

  focusPlayerStar(deep = false): void {
    const ps = this.getPlayerStar();
    if (ps) {
      this.camera.tx = ps.x;
      this.camera.ty = ps.y;
      this.camera.ts = deep ? 6.0 : 4.0;
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
    this.exploredAreas.push({ x, y, radius } as unknown as { x: number; y: number; r: number });
    this.exploredAreas[this.exploredAreas.length - 1] = { x, y, r: radius };
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
    if (!ps.hasLife) this.igniteLife(ps, ps.bestPlanetIndex ?? 0);
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
          if (defender.civLevel > 0) defender.civLevel = Math.max(0, defender.civLevel - 1);
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
    const count = this.rng.nextInt(1, 4);
    const types: Planet['type'][] = ['rocky', 'ocean', 'gas', 'ice', 'lava'];
    const colors = { rocky: '#aa8866', ocean: '#2266aa', gas: '#cc9944', ice: '#aaddee', lava: '#cc4422' };
    const romanNumerals = ['I', 'II', 'III', 'IV', 'V', 'VI'];
    const planets: Planet[] = [];
    // Innermost orbit must clear the star's visual radius with a safe buffer
    const starRadius = 2.5 + starMass * 0.8;
    const innerEdge = starRadius + 5; // minimum 5 world-unit clearance
    for (let i = 0; i < count; i++) {
      const type = this.rng.pick(types);
      planets.push({
        orbitalAngle: this.rng.nextFloat(0, Math.PI * 2),
        orbitalRadius: innerEdge + i * 7 + this.rng.nextFloat(0, 5),
        orbitalSpeed: 0.008 / (i + 1),
        radius: type === 'gas' ? this.rng.nextFloat(1.2, 2) : this.rng.nextFloat(0.5, 1.2),
        type,
        hasLife: false,
        biosphere: 0,
        color: colors[type],
        discovery: 'none',
        name: romanNumerals[i] ?? String(i + 1),
        moons: [],
      });
      const p = planets[planets.length - 1];
      p.moons = this.generateMoons(p, romanNumerals[i] ?? String(i + 1));
    }
    return planets;
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
      gas:   ['ice', 'ice', 'rock', 'ocean', 'carbon'],
      ice:   ['ice', 'ice', 'rock'],
      ocean: ['rock', 'ice', 'carbon'],
      rocky: ['rock', 'rock', 'iron', 'carbon'],
      lava:  ['volcanic', 'iron', 'rock'],
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
      moons.push({
        name: `${label}-${'abcdefgh'[i]}`,
        // Always meaningfully smaller than the parent, and varied between moons.
        radius: planet.radius * rng.nextFloat(0.16, 0.38),
        orbitalRadius: planet.radius * (2.1 + i * 1.35) + rng.nextFloat(0, 0.8),
        orbitalAngle: rng.nextFloat(0, Math.PI * 2),
        orbitalSpeed: rng.nextFloat(0.05, 0.14) / (i + 1),
        color: TINT[kind],
        kind,
        habitability: rng.nextFloat(hlo, hhi),
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
  private generateGalaxyName(): string {
    const shape = this.rng.pick(['Spiral', 'Barred', 'Lenticular', 'Irregular', 'Elliptical']);
    const greek = this.rng.pick(['Alpha', 'Beta', 'Gamma', 'Delta', 'Sigma', 'Omega', 'Theta']);
    return `${greek} ${shape} ${this.rng.nextInt(100, 999)}`;
  }

  /** This universe's galaxies, with their centres kept current. */
  get currentGalaxies(): Galaxy[] { return this.galaxies; }

  /**
   * Recompute each galaxy's centre and extent from the stars still in it.
   *
   * Stars drift, merge and die, so a galaxy defined once at the Big Bang
   * gradually stops describing where its stars actually are.
   */
  private updateGalaxies(): void {
    if (this.galaxies.length === 0) return;
    for (const gal of this.galaxies) {
      let n = 0, sx = 0, sy = 0;
      for (const st of this.stars) {
        if (st.isDead || st.galaxyId !== gal.id) continue;
        n++; sx += st.x; sy += st.y;
      }
      if (n === 0) continue;
      gal.x = sx / n; gal.y = sy / n;
      let far = 0;
      for (const st of this.stars) {
        if (st.isDead || st.galaxyId !== gal.id) continue;
        far = Math.max(far, Math.hypot(st.x - gal.x, st.y - gal.y));
      }
      // A little slack so the envelope contains its stars rather than clipping.
      gal.radius = Math.max(30, far * 1.12);
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
    } else {
      const ps = this.getPlayerStar();
      if (ps) {
        if (tier === 'galaxy') {
          const gal = this.galaxies.find(gx => gx.id === ps.galaxyId);
          this.camera.tx = gal ? gal.x : ps.x;
          this.camera.ty = gal ? gal.y : ps.y;
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
    this.nebulae = snap.nebulae;
    this.asteroids = snap.asteroids;
    this.fleets = snap.fleets;
    this.orbitalFleets = snap.orbitalFleets ?? [];
    this.cosmicEvents = snap.cosmicEvents;
    this.activeWars = snap.activeWars;
    this.exploredAreas = snap.exploredAreas;
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
    this.supernovaFlashes = [];
    this.revelationFlashes = [];
    this.planetTextureCache.clear();
  }
}

