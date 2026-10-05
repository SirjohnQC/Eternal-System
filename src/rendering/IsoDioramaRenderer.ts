/**
 * IsoDioramaRenderer — pixel-art "world under glass" diorama for the player's home planet.
 *
 * Renders the home world as a floating disc-shaped slice of a planet:
 *   • a glass hemisphere dome over the top face (sky, clouds, rim light)
 *   • a flat elliptical top face showing an azimuthal projection of the planet grid,
 *     with a continent in the middle ringed by ocean and a surf line at the rim
 *   • a cut band of ocean water under the rim
 *   • a deep, jagged rock crust below with strata, caves, ore crystals and boulders
 *   • deep space behind: nebula band, star field, parent star bloom, moon, siblings
 *
 * ── Why Canvas 2D and not Pixi ────────────────────────────────────────────────
 * The previous implementation issued tens of thousands of Pixi `Graphics` rect
 * commands *per frame* (per-pixel terrain, per-pixel clouds, per-pixel shimmer),
 * which re-tessellated the whole geometry every tick and locked the tab. Pixel art
 * wants a small pixel buffer, not a huge vector scene graph, so this renderer
 * paints into a low-resolution backbuffer that is upscaled with nearest-neighbour.
 *
 * Everything expensive (terrain, crust, starfield) is baked once into offscreen
 * canvases and blitted; only cheap overlays (clouds, shimmer, city lights, dome
 * highlight, moon) are redrawn each frame. Per-frame cost is a couple hundred
 * canvas ops, comfortably inside the 8 ms render budget.
 *
 * Usage:
 *   const renderer = new IsoDioramaRenderer();
 *   await renderer.init(mountDiv);
 *   renderer.refreshData(grid, biosphere, species, planet, star, planetIndex);
 *   renderer.start();
 *   renderer.pause();   // on overlay close
 *   renderer.resume();  // on overlay re-open
 */

import type { PlanetGrid, BiomeType } from '../simulation/PlanetGrid';
import { formationHeat } from '../simulation/Formation';
import { BIOME_COLORS, isWater, classifyBiome, SEA_LEVEL, GRID_SIZE, tintRiver, inRiverChannel, riverStrength, riverIsFall } from '../simulation/PlanetGrid';
import type { PlanetBiosphere, SpeciesGenome } from '../simulation/SpeciesGenome';
import { inhabitsWater, waterSubmersion } from '../simulation/SpeciesGenome';
import type { Planet, StarBody } from '../simulation/BigBangEngine';
import { dioramaCreatureSprite, bakeSettlementSprite, bakeCreaturePortrait, CREATURE_SIZE_PX } from './SpeciesSprite';
import { planSettlements, emptyPlan, groundAt as townGroundAt, keepClear, eraOf, SQUASH, type SettlementPlan } from './SettlementPlan';
import { paintBuilding, paintConstruction, townStyle, type TownStyle } from './SettlementForge';
import { archGenome, type ArchGenome } from './Architecture';
import { paintMoon, type MoonKindArt } from './MoonArt';
import { forgeCreature } from './CreatureForge';
import {
  HabitableCutawayEngine,
  type HabitableType,
  cutawayWaterSurf,
  habitableGeom,
  volcanoProfile, type VolcanoProfile, type VolcanoState,
} from './HabitableCutawayEngine';
import { decalRebakeNeeded, defaultDecalScale, isMineralKind, isWoody, type DecalAtlas, type DecalKind } from './SurfaceDecals';
import { loadDecalAtlas } from './DecalAtlasLoader';
import { atmosphereForPlanet, type AtmosphereChannel } from '../simulation/PlanetGenome';
import { buildClimate, type ClimateSources } from './weather/WeatherClimate';
import { sunFacing, moonShade } from './sky/SunLight';
import { orbitSky, axialTilt, seasonZero, type SkyState } from './sky/OrbitSky';
import { bakeBackdrop, backdropWidth, backdropOffset } from './sky/Backdrop';
import { paintSky, skyLayout, farLayout, trackX, trackY, BLOOM_CORE, WASH_ALPHA, bloomScale, type SkyLayout } from './sky/SkyPainter';
import { farScale, isIdentity, type Camera } from './ZoomCamera';
import { ZoomController } from './ZoomController';
import { applySettle, type SettleHooks } from './zoomSettle';

// ─── Planet type palettes ──────────────────────────────────────────────────────

/** On-screen size (px, long edge) from which a creature is drawn by CreatureForge. */
/**
 * Creatures are ALWAYS the CreatureForge body (the Evolution Lab's art),
 * rendered at their on-screen size: the old pixel baker made the planet's
 * species look unlike the lab's (play report).
 */
const FORGE_MIN_PX = 4;
/** The shared idle hop (seconds per cycle); the lab specimen uses the same. */
export interface Vent {
  row: number; col: number; dx: number; dy: number;
  /** Cone radius in grid cells. */
  R: number;
  base: number; peak: number;
  state: VolcanoState;
  crater: { x: number; y: number } | null;
  flows: Array<Array<{ x: number; y: number }>>;
}

function hash01(n: number, seed: number): number {
  let h = Math.imul(n ^ seed, 2654435761) ^ (n >>> 7);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** Camera zoom where birds start to fade in over living worlds. */
const BIRD_ZOOM = 1.4;
const CREATURE_HOP_PERIOD = 2.4;
/** New CreatureForge sprites baked per frame at most. */
const FORGE_BAKES_PER_FRAME = 3;

export type PlanetType =
  | 'ocean' | 'rocky' | 'lava' | 'ice' | 'gas'
  | 'toxic' | 'crystal' | 'desert' | 'storm' | 'carbon';

interface RGB { r: number; g: number; b: number }

interface PlanetPalette {
  /** Colour of the atmospheric glow behind the disc */
  halo:        RGB;
  /** Sky colour inside the dome, horizon → zenith */
  skyLow:      RGB;
  skyHigh:     RGB;
  /** Colour of the water seen in the cut band under the rim */
  cutWater:    RGB;
  /** Rock strata, top (just under the surface) → bottom (deep mantle) */
  strata:      RGB[];
  /** Ore / crystal colours embedded in the crust */
  ore:         RGB[];
  /** Whether the world gets a glass dome + clouds */
  hasDome:     boolean;
  /** Warm key-light colour hitting the lit side */
  keyLight:    RGB;
}

const rgb = (r: number, g: number, b: number): RGB => ({ r, g, b });

/**
 * Terrain height is snapped to multiples of this many virtual pixels.
 *
 * The diorama is pixel art upscaled with nearest-neighbour, so a smooth height
 * ramp quantises to a mess of one-pixel steps. Deliberate terracing reads far
 * better and matches the art direction.
 */
const LIFT_STEP = 3;

const PALETTES: Record<PlanetType, PlanetPalette> = {
  ocean: {
    halo:     rgb(60, 130, 210),
    skyLow:   rgb(176, 214, 240),
    skyHigh:  rgb(74, 126, 190),
    cutWater: rgb(28, 74, 128),
    strata: [
      rgb(176, 138, 88), rgb(146, 96, 52), rgb(116, 94, 82),
      rgb(98, 62, 40),   rgb(62, 52, 50),  rgb(32, 24, 22),
    ],
    ore:      [rgb(120, 200, 235), rgb(220, 150, 70), rgb(160, 190, 210)],
    hasDome:  true,
    keyLight: rgb(255, 214, 150),
  },
  rocky: {
    halo:     rgb(150, 145, 130),
    skyLow:   rgb(202, 200, 190),
    skyHigh:  rgb(104, 122, 156),
    cutWater: rgb(40, 82, 116),
    strata: [
      rgb(186, 150, 96), rgb(154, 108, 60), rgb(122, 100, 86),
      rgb(96, 68, 44),   rgb(64, 54, 50),   rgb(36, 28, 26),
    ],
    ore:      [rgb(225, 160, 70), rgb(190, 200, 210), rgb(130, 195, 225)],
    hasDome:  true,
    keyLight: rgb(255, 208, 150),
  },
  ice: {
    halo:     rgb(120, 190, 230),
    skyLow:   rgb(214, 238, 250),
    skyHigh:  rgb(96, 150, 200),
    cutWater: rgb(60, 122, 160),
    strata: [
      rgb(214, 236, 248), rgb(168, 200, 224), rgb(126, 158, 190),
      rgb(90, 118, 152),  rgb(62, 84, 116),   rgb(38, 54, 80),
    ],
    ore:      [rgb(190, 235, 255), rgb(140, 200, 240), rgb(230, 250, 255)],
    hasDome:  true,
    keyLight: rgb(230, 244, 255),
  },
  lava: {
    halo:     rgb(210, 70, 20),
    skyLow:   rgb(120, 46, 26),
    skyHigh:  rgb(48, 18, 20),
    cutWater: rgb(150, 44, 12),
    strata: [
      rgb(96, 40, 26), rgb(140, 52, 22), rgb(72, 28, 20),
      rgb(48, 20, 16), rgb(30, 14, 12),  rgb(18, 8, 8),
    ],
    ore:      [rgb(255, 130, 40), rgb(255, 80, 20), rgb(200, 60, 20)],
    hasDome:  false,
    keyLight: rgb(255, 150, 70),
  },
  gas: {
    halo:     rgb(150, 110, 180),
    skyLow:   rgb(200, 168, 130),
    skyHigh:  rgb(96, 70, 130),
    cutWater: rgb(110, 78, 150),
    strata: [
      rgb(168, 132, 84), rgb(120, 92, 62), rgb(96, 68, 108),
      rgb(70, 48, 84),   rgb(46, 32, 60),  rgb(28, 20, 40),
    ],
    ore:      [rgb(210, 180, 130), rgb(160, 130, 200), rgb(120, 96, 170)],
    hasDome:  false,
    keyLight: rgb(255, 220, 170),
  },
  toxic: {
    halo:     rgb(160, 200, 50),
    skyLow:   rgb(140, 180, 70),
    skyHigh:  rgb(60, 90, 40),
    cutWater: rgb(40, 110, 35),
    strata: [
      rgb(90, 85, 45), rgb(120, 100, 50), rgb(80, 70, 40),
      rgb(50, 60, 40),  rgb(45, 40, 28),   rgb(25, 22, 16),
    ],
    ore:      [rgb(180, 230, 60), rgb(120, 200, 50), rgb(220, 255, 100)],
    hasDome:  true,
    keyLight: rgb(200, 255, 120),
  },
  crystal: {
    halo:     rgb(150, 90, 220),
    skyLow:   rgb(180, 140, 220),
    skyHigh:  rgb(80, 40, 130),
    cutWater: rgb(70, 40, 130),
    strata: [
      rgb(100, 55, 120), rgb(140, 70, 160), rgb(90, 45, 110),
      rgb(60, 40, 80),   rgb(50, 30, 70),   rgb(28, 16, 40),
    ],
    ore:      [rgb(220, 160, 255), rgb(180, 100, 240), rgb(255, 200, 255)],
    hasDome:  true,
    keyLight: rgb(230, 180, 255),
  },
  desert: {
    halo:     rgb(210, 170, 90),
    skyLow:   rgb(230, 200, 140),
    skyHigh:  rgb(140, 110, 70),
    cutWater: rgb(70, 100, 120),
    strata: [
      rgb(200, 160, 100), rgb(160, 120, 75), rgb(120, 90, 55),
      rgb(180, 140, 90),  rgb(80, 55, 35),   rgb(45, 30, 20),
    ],
    ore:      [rgb(230, 180, 80), rgb(200, 150, 70), rgb(255, 210, 120)],
    hasDome:  true,
    keyLight: rgb(255, 220, 150),
  },
  storm: {
    halo:     rgb(100, 90, 130),
    skyLow:   rgb(80, 75, 100),
    skyHigh:  rgb(35, 30, 50),
    cutWater: rgb(30, 38, 60),
    strata: [
      rgb(60, 50, 55), rgb(45, 42, 55), rgb(35, 30, 40),
      rgb(40, 38, 48), rgb(25, 22, 30), rgb(14, 12, 18),
    ],
    ore:      [rgb(140, 120, 180), rgb(100, 90, 140), rgb(180, 160, 200)],
    hasDome:  true,
    keyLight: rgb(180, 170, 210),
  },
  carbon: {
    halo:     rgb(70, 120, 190),
    skyLow:   rgb(50, 60, 80),
    skyHigh:  rgb(20, 25, 40),
    cutWater: rgb(20, 28, 40),
    strata: [
      rgb(45, 42, 40), rgb(35, 34, 36), rgb(25, 24, 26),
      rgb(30, 30, 32), rgb(16, 15, 16), rgb(8, 8, 9),
    ],
    ore:      [rgb(80, 110, 160), rgb(60, 90, 140), rgb(120, 150, 190)],
    hasDome:  true,
    keyLight: rgb(140, 170, 210),
  },
};

// ─── Deterministic noise helpers ──────────────────────────────────────────────

/** Integer hash → [0,1). Same family as PlanetGrid's, kept local to avoid coupling. */
function hash1(n: number, seed: number): number {
  let h = (n * 374761393 + seed * 2654435761) | 0;
  h = ((h ^ (h >>> 13)) * 1540483477) | 0;
  h = h ^ (h >>> 15);
  return ((h >>> 0) & 0xffff) / 0xffff;
}

/** 1-D smooth value noise, used for jagged crust silhouettes and strata waves. */
function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1(i, seed);
  const b = hash1(i + 1, seed);
  return a + (b - a) * u;
}

/** Layered 1-D noise. */
function fbm1(x: number, seed: number, octaves = 4): number {
  let v = 0, amp = 0.5, freq = 1, max = 0;
  for (let i = 0; i < octaves; i++) {
    v += amp * noise1(x * freq, seed + i * 131);
    max += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return v / max;
}

/** Small linear congruential stream for scattering props deterministically. */
class Stream {
  private s: number;
  constructor(seed: number) { this.s = (seed >>> 0) || 1; }
  next(): number {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
  range(a: number, b: number): number { return a + this.next() * (b - a); }
  int(a: number, b: number): number { return Math.floor(this.range(a, b + 1)); }
  pick<T>(arr: T[]): T { return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))]; }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const css = (c: RGB, a = 1) =>
  `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${a})`;
/** Parse a '#rrggbb' string into RGB. Moons carry their tint as hex. */
const hexToRGB = (hex: string): RGB => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3
    ? h.split('').map(c => c + c).join('')
    : h, 16);
  return Number.isNaN(n) ? rgb(190, 200, 220)
    : rgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
};

const shade = (c: RGB, f: number): RGB =>
  rgb(clamp01(c.r * f / 255) * 255, clamp01(c.g * f / 255) * 255, clamp01(c.b * f / 255) * 255);

// ─── Scattered prop types ─────────────────────────────────────────────────────

// ─── Divine powers ────────────────────────────────────────────────────────────

/**
 * A divine act the player can see land on the world.
 *
 * Divine actions used to apply their effect and print a line in the log; nothing
 * was ever drawn, so using a power felt like editing a spreadsheet. Each kind
 * here is styled to read as the thing it does at a glance.
 */
export type DivineEffectKind =
  | 'bless'       // Bless Harvest — warm motes rising off the land
  | 'prophet'     // Send Prophet — a shaft of light onto one place
  | 'revelation'  // Revelation — sky-wide flash and expanding rings
  | 'smite'       // Smite — a lance from above and an impact flash
  | 'nudge'       // Nudge Evolution — green motes spiralling up
  | 'raise'       // Raise Land — dust and upward chevrons
  | 'sink'        // Sink Land — inward collapse
  | 'fertility'   // local fertility — green bloom
  | 'water'       // local water — blue ripple
  | 'sight';      // Divine Sight — a wide ring of light

interface EffectStyle {
  /** Core colour of the effect. */
  color:  RGB;
  /** Seconds the effect lives. */
  life:   number;
  /** Expanding rings drawn from the centre. */
  rings:  number;
  /** Motes emitted; negative values fall inward instead of rising. */
  motes:  number;
  /** A vertical beam from the dome down to the target. */
  beam:   boolean;
  /** A full-face wash of light. */
  wash:   number;
}

const EFFECT_STYLES: Record<DivineEffectKind, EffectStyle> = {
  bless:      { color: rgb(255, 216, 120), life: 1.8, rings: 1, motes:  26, beam: false, wash: 0.05 },
  prophet:    { color: rgb(255, 244, 205), life: 2.2, rings: 2, motes:  14, beam: true,  wash: 0.04 },
  revelation: { color: rgb(255, 238, 190), life: 2.6, rings: 4, motes:  20, beam: false, wash: 0.16 },
  smite:      { color: rgb(255, 150, 90),  life: 1.4, rings: 2, motes:  18, beam: true,  wash: 0.10 },
  nudge:      { color: rgb(130, 245, 160), life: 2.0, rings: 1, motes:  24, beam: false, wash: 0.04 },
  raise:      { color: rgb(214, 180, 120), life: 1.3, rings: 1, motes:  20, beam: false, wash: 0.02 },
  sink:       { color: rgb(120, 150, 190), life: 1.3, rings: 1, motes: -20, beam: false, wash: 0.02 },
  fertility:  { color: rgb(150, 235, 120), life: 1.5, rings: 1, motes:  22, beam: false, wash: 0.03 },
  water:      { color: rgb(120, 200, 255), life: 1.5, rings: 2, motes:  12, beam: false, wash: 0.03 },
  sight:      { color: rgb(190, 220, 255), life: 1.8, rings: 3, motes:   0, beam: false, wash: 0.05 },
};

/** A mote: start position (base-world px) and velocity (base-world px/s). */
interface Mote { x: number; y: number; vx: number; vy: number; born: number; swirl: number }

/**
 * A divine act. Stored in BASE-WORLD units at cast time (spec 3): an act cast
 * while zoomed stays on its world spot when the camera changes; drawing maps
 * it through the active camera (sizes x k, 1-px strokes stay 1 px).
 */
interface DivineEffect {
  kind:  DivineEffectKind;
  /** Centre in base-world virtual pixels. */
  wx: number; wy: number;
  /** Radius the rings expand to, base-world px. */
  reach: number;
  age:   number;
  motes: Mote[];
}

/** An outlying city light: base-world position (lift included) and the cell it stands on. */
interface CityDot { wx: number; wy: number; row: number; col: number; phase: number; rate: number }
interface Ripple  { x: number; y: number; rx: number; phase: number; speed: number }
interface Ember   { x: number; y: number; vy: number; life: number; maxLife: number }

// ─── Renderer ─────────────────────────────────────────────────────────────────

/** Seconds one building takes to go up, and the spread of a town's start times. */
const BUILD_SECONDS = 24;
const BUILD_SPREAD = 30;

/** Repaint rate of the sky layer (sun shimmer, glow); frames between reuse it. */
const SKY_HZ = 30;

export class IsoDioramaRenderer {
  /** Visual day for the fastest orbit in the system view, seconds. */
  private static readonly DAY_FAST = 30;
  /** Visual day for the slowest orbit in the system view, seconds. */
  private static readonly DAY_SLOW = 300;
  /** rad per animTick. Innermost world, fast jitter — see generatePlanets. */
  private static readonly ORBIT_FAST = 0.00162;
  /** rad per animTick. Outermost world, slow jitter. */
  private static readonly ORBIT_SLOW = 0.00028;

  // Display canvas (upscaled) + low-res backbuffer
  private display!:    HTMLCanvasElement;
  private displayCtx!: CanvasRenderingContext2D;
  private buf!:        HTMLCanvasElement;
  private ctx!:        CanvasRenderingContext2D;

  // Baked static layers
  private bgLayer!:      HTMLCanvasElement;   // space, nebula, stars
  /**
   * The backdrop re-baked at `farScale(k)` about a camera's focus (far class):
   * baked on settle by `setCamera`, never per frame; the identity view keeps
   * `bgLayer`. `bgFarFor` is the camera and panorama it was baked for.
   */
  private bgFar: HTMLCanvasElement | null = null;
  private bgFarFor: { zoom: number; fy: number; W: number; H: number; seed: number } | null = null;
  private skyCanvas!:    HTMLCanvasElement;   // sun, arc, siblings (putImageData only)
  private skyImage:      ImageData | null = null;
  /** This frame's sky, from the real orbits. Read by the weather seasons. */
  private sky:           SkyState<Planet> | null = null;
  /** The engine's orbit clock (animTick); null counts nominal 60 Hz frames. */
  private clock:         (() => number) | null = null;
  private crustLayer!:   HTMLCanvasElement;   // rock underside + rim cut band
  private surfaceLayer!: HTMLCanvasElement;   // top face terrain
  private cutaway = new HabitableCutawayEngine();

  private mount:  HTMLElement | null = null;
  private raf = 0;
  private running = false;
  private lastT = 0;
  private elapsed = 0;
  private errorLogged = false;

  // Virtual (pixel-art) resolution
  private VW = 480;
  private VH = 320;

  /**
   * Progressive zoom (spec 5): during a wheel/drag gesture the identity layers
   * are shown under a CSS transform; SETTLE_MS after the last input the frame
   * re-bakes the camera layer set and shows it with no CSS transform. The
   * controller owns zoom and pan; `updateView` applies it once per frame.
   */
  private zoom = new ZoomController({ width: 960, height: 640 }, 480, 320);
  /** Pointer state: down, and whether it has turned into a pan (past the 6 px slop). */
  private drag = { active: false, panning: false, x: 0, y: 0 };
  /** The view state the display's CSS transform was last written for. */
  private cssFor = { zoom: NaN, x: NaN, y: NaN, shown: false };
  /** True once `resize` has sized the layers (a later zero-sized mount is ignored). */
  private sized = false;
  /** The 4 s surface rebake is due this frame (read by the settle hook). */
  private rebakeDue = false;
  /**
   * Camera-bake time budget per frame (ms). Keep this under one 240Hz frame
   * (~4.2 ms) so settle work doesn't steal the whole vsync. Tests set
   * `Infinity` for a one-frame settle.
   */
  bakeBudgetMs = 2;
  /** 0 = uncapped (match display refresh). Otherwise present at most this many fps. */
  private targetFps = 0;
  /** Sky pacing (see drawSky): last paint time and what it was painted for. */
  private skyT = -1;
  private skyKey = { z: 0, fx: 0, fy: 0, w: 0, h: 0 };
  private lastPresentTime = 0;
  /** Settle hooks, allocated once: `updateView` runs every frame. */
  private readonly settleHooks: SettleHooks = {
    // A settle and a due 4 s rebake in one frame merge: the identity rebake
    // (fresh plans) runs first and skips the camera set, which the settle
    // then re-bakes once from those plans.
    beforeCamera: () => {
      if (!this.rebakeDue) return;
      this.rebakeDue = false;
      this.rebakeSurfaceAndPlacement(false);
    },
    afterCamera: (cam) => this.bakeFarBackdrop(cam),
  };
  private unbindView: Array<() => void> = [];
  private lastDecalState: { lush: number; biodiversity: number } | null = null;
  /** Flora size classes, so a lineage growing gigantic regrows its trees. */
  private lastFloraSig = '';

  // Data
  private grid:        PlanetGrid | null = null;
  /** The simulation's grid; `grid` is this with the volcano cones raised in. */
  private rawGrid:     PlanetGrid | null = null;
  private vents: Vent[] = [];
  private ventKey = '';
  private biosphere:   PlanetBiosphere | null = null;
  private species:     SpeciesGenome[] = [];
  private planet:      Planet | null = null;
  /** Rolled air, keyed by seed AND type — a terraformed world must re-roll. */
  private airCache: { key: string; air: AtmosphereChannel } | null = null;
  private planetType:  PlanetType = 'ocean';
  private gasHalo:     RGB = PALETTES.gas.halo;
  private star:        StarBody | null = null;
  private planetIndex  = 0;
  private decalAtlas: DecalAtlas | null = null;

  // Projection focus — lat/lon of the continent the disc is centred on
  private focusLat = 0;
  private focusLon = 0;

  // Props
  private cityDots: CityDot[] = [];
  private ripples:  Ripple[]  = [];
  private embers:   Ember[]   = [];
  /** Divine acts currently playing out on the surface. */
  private effects:  DivineEffect[] = [];

  /**
   * Creatures and settlements standing on the surface, rebuilt with the terrain.
   * Planned at the identity view: `wx, wy` are BASE-WORLD virtual px (the foot
   * of the sprite, lift included) plus the cell; drawing maps them through the
   * active camera and blits the sprite x round(k).
   */
  private inhabitants: Array<{
    wx: number; wy: number; row: number; col: number; sprite: HTMLCanvasElement;
    w: number; h: number; phase: number; sway: number; depth: number;
    /** 0 = fully above the surface, 1 = fully under. See waterSubmersion(). */
    submersion: number;
    /** The genome drawn, for the detailed CreatureForge sprite when big enough. */
    genome: SpeciesGenome;
  }> = [];
  /**
   * CreatureForge sprites for creatures large enough on screen to show a body
   * (zoomed in, or massive species), keyed by genome and on-screen size.
   * `foot` is the transparent margin under the feet, so the anchor stays put.
   */
  private forgeSprites = new Map<string, { cv: HTMLCanvasElement; foot: number }>();
  /** Forge bakes allowed this frame; the pixel sprite stands in until baked. */
  private forgeBudget = 0;
  /** Scratch for compositing a submerged creature without tinting the sea. */
  private subScratch: HTMLCanvasElement | null = null;
  /**
   * Towns, their buildings, farm fields and roads (SettlementPlan), planned
   * before each surface bake so fields and roads are painted into the ground;
   * buildings stand on the lifted ground (`townLift`) in the props layer.
   */
  private townPlan: SettlementPlan = emptyPlan();
  private townLift: number[] = [];
  private townSig = '';
  private townVersion = 0;
  private townStyleOf: TownStyle | null = null;
  /** How the planet's civilisation builds (null before one exists). */
  townArch: ArchGenome | null = null;
  /**
   * When each building's construction started (renderer seconds), aligned
   * with townPlan.buildings; -Infinity = standing. Keyed across re-plans by
   * town and lot, so a growing town builds only what is new.
   */
  private buildingBorn: number[] = [];
  private bornByKey = new Map<string, number>();
  /**
   * Buildings dropped by a re-plan (a new era, a moved lot), left standing
   * until the construction wave reaches them (`until`, renderer seconds).
   */
  private retired: Array<{ b: import('./SettlementPlan').Building; lift: number; st: TownStyle; until: number; sprites: Map<number, { cv: HTMLCanvasElement; fx: number; fy: number }> }> = [];
  /** The planet the towns were planned for: a new planet shows them built. */
  private townPlanet: unknown = null;
  private buildingSprites = new Map<string, { cv: HTMLCanvasElement; fx: number; fy: number }>();
  /** Buildings rendered for one view (camera, size, plan): one blit per frame otherwise. */
  private propsCanvas: HTMLCanvasElement | null = null;
  private propsKey = '';
  private settlements: Array<{
    wx: number; wy: number; row: number; col: number; sprite: HTMLCanvasElement; w: number; h: number; depth: number;
  }> = [];

  /**
   * Per-pixel map from screen position to the grid cell drawn there, written by
   * `bakeSurface` as it paints.
   *
   * Terrain is extruded by elevation, so the pixel a player clicks on a mountain
   * belongs to a cell further back than the flat projection of that pixel would
   * suggest. Picking against the projection alone selects the ground *in front
   * of* the peak. Stored as `row * GRID_SIZE + col + 1`, with 0 meaning "no
   * surface here".
   */
  private pickBuf: Int32Array | null = null;

  /** Grid cell under the cursor, outlined on the surface. */
  private highlight: { row: number; col: number } | null = null;
  /** Grid cell the player has selected, marked more strongly. */
  private selection: { row: number; col: number } | null = null;

  /** Surface rebake throttle — life spread / civ growth changes the grid over time. */
  private surfaceDirty = false;
  private lastSurfaceBake = -1e9;
  private static readonly SURFACE_REBAKE_INTERVAL = 4; // seconds

  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    void loadDecalAtlas().then(a => {
      this.decalAtlas = a;
      if (a) this.markSurfaceDirty();
    });
  }

  get canvas(): HTMLCanvasElement { return this.display; }

  // ── Geometry (in virtual pixels) ────────────────────────────────────────────

  /**
   * Does this world bake through {@link HabitableCutawayEngine}?
   *
   * Every planet type uses the pancake cutaway + soft ozone half-dome. Gas
   * giants keep latitude bands and rings inside the cutaway engine rather than
   * the legacy sphere path.
   */
  private get usesCutaway(): boolean {
    return true;
  }

  /** @deprecated Prefer {@link usesCutaway}; kept as the historical name. */
  private get habitable(): boolean {
    return this.usesCutaway;
  }

  // Ruling 7: `cx`, `cy`, `rx`, `ry`, `bodyCy` are the ACTIVE geometry — the
  // camera geometry while a camera layer set is shown — and are for DRAWING
  // only. Anything placed by sampling reads `placeGeom` (the BASE geometry)
  // and stores base-world px; drawing maps those through `wsx` / `wsy`.

  private get cx(): number {
    return this.habitable ? this.cutaway.drawGeom.cx : Math.round(this.VW / 2);
  }

  /**
   * Centre of the top-face ellipse.
   *
   * Habitable path: derived from the body circle with a crest DROP so the
   * tabletop sits into the sphere (3/4 god view), matching `diorama_test`.
   */
  private get cy(): number {
    if (this.habitable) {
      const geom = this.cutaway.drawGeom;
      return geom.cyTop + geom.bob;
    }
    return Math.round(this.VH * 0.46);
  }

  /** Top-face ellipse x-radius; also the body radius / legacy dome radius. */
  private get rx(): number {
    if (this.habitable) return this.cutaway.drawGeom.rx;
    return Math.round(Math.min(this.VW * 0.38, this.VH * 0.48));
  }

  /** Gas-giant sphere radius. Shared by the body bake and its halo. */
  private get gasR(): number {
    return Math.round(Math.min(this.VW * 0.44, this.VH * 0.52));
  }

  /** Top-face ellipse y-radius — flattened for the camera pitch. */
  private get ry(): number {
    if (this.habitable) return this.cutaway.drawGeom.ry;
    return Math.max(6, Math.round(this.rx * 0.30));
  }

  /** Centre of the habitable body's silhouette circle. Meaningless elsewhere. */
  private get bodyCy(): number {
    if (this.habitable) {
      const geom = this.cutaway.drawGeom;
      return geom.cyBody + geom.bob;
    }
    return this.cy;
  }

  /**
   * BASE geometry (the identity view's), for placement: city lights,
   * settlements, creatures and divine effects are planned and stored in these
   * coordinates, never in a camera's.
   */
  private get placeGeom(): { cx: number; cy: number; rx: number; ry: number } {
    if (this.habitable) {
      const g = this.cutaway.geom;
      return { cx: g.cx, cy: g.cyTop + this.cutaway.bob, rx: g.rx, ry: g.ry };
    }
    return { cx: this.cx, cy: this.cy, rx: this.rx, ry: this.ry };
  }

  /** The camera the active layer set was baked for (identity when none is shown). */
  private get cam(): Camera {
    return this.cutaway.activeCamera;
  }

  /** Zoom k of the active camera (1 at identity). */
  private get camZoom(): number {
    return this.cutaway.activeCamera.zoom;
  }

  /** Base-world x -> active screen x. Exactly `x` at identity (no float round trip). */
  private wsx(x: number): number {
    const c = this.cutaway.activeCamera;
    return isIdentity(c, this.VW, this.VH) ? x : (x - c.fx) * c.zoom + this.VW / 2;
  }

  /** Base-world y -> active screen y. Exactly `y` at identity. */
  private wsy(y: number): number {
    const c = this.cutaway.activeCamera;
    return isIdentity(c, this.VW, this.VH) ? y : (y - c.fy) * c.zoom + this.VH / 2;
  }

  /**
   * Seconds for one local day, from this world's orbital speed — the same
   * number the system view uses to walk it around its sun.
   *
   * Innermost worlds (fast Kepler speed) lap in DAY_FAST seconds. The cold
   * fringe takes DAY_SLOW. Endpoints match generatePlanets: MU / sqrt(a/10)
   * with the 0.85–1.15 jitter, a from ~7 to ~130.
   */
  private get dayPeriod(): number {
    const speed = this.planet?.orbitalSpeed ?? 0;
    if (speed <= 0) return (IsoDioramaRenderer.DAY_FAST + IsoDioramaRenderer.DAY_SLOW) / 2;
    const t = (speed - IsoDioramaRenderer.ORBIT_SLOW) / (IsoDioramaRenderer.ORBIT_FAST - IsoDioramaRenderer.ORBIT_SLOW);
    const u = t < 0 ? 0 : t > 1 ? 1 : t;
    return IsoDioramaRenderer.DAY_SLOW + (IsoDioramaRenderer.DAY_FAST - IsoDioramaRenderer.DAY_SLOW) * u;
  }

  /** Local solar azimuth in radians. 0 = sun on the +x limb. */
  private get dayAngle(): number {
    return this.elapsed * (Math.PI * 2 / this.dayPeriod);
  }

  /** Height of the water cut band directly under the rim. */
  private get cutH(): number { return Math.round(this.rx * 0.13); }
  /** Depth of the rock crust below the cut band. */
  private get crustH(): number { return Math.round(this.rx * 0.88); }

  /** This world's air; see `atmosphereForPlanet`. */
  private get air(): AtmosphereChannel {
    const seed = this.planet?.genomeSeed;
    const stage = this.forming ? this.star?.formationStage ?? '' : '';
    const key = `${seed}|${this.planetType}|${stage}`;
    if (!this.airCache || this.airCache.key !== key) {
      let air = atmosphereForPlanet(seed, this.planetType);
      // A forming world's first breath: the air shell is thin and faint until
      // the seas (or ice) arrive.
      if (stage === 'atmosphere') {
        air = { ...air, thicknessPx: air.thicknessPx * 0.55, density: air.density * 0.5, saturation: air.saturation * 0.6 };
      }
      this.airCache = { key, air };
    }
    return this.airCache.air;
  }

  private get planetSeed(): number {
    if (!this.planet) return 9999;
    let h = 2166136261;
    for (let i = 0; i < this.planet.name.length; i++) {
      h ^= this.planet.name.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) || 1;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async init(mount: HTMLElement): Promise<void> {
    this.mount = mount;
    mount.style.position = 'relative';

    this.display = document.createElement('canvas');
    const dctx = this.display.getContext('2d', { alpha: false });
    if (!dctx) throw new Error('IsoDioramaRenderer: 2D context unavailable');
    this.displayCtx = dctx;

    const s = this.display.style;
    s.position = 'absolute';
    s.inset = '0';
    s.width = '100%';
    s.height = '100%';
    s.display = 'block';
    s.imageRendering = 'pixelated';
    s.transformOrigin = '50% 50%';
    mount.style.overflow = 'hidden';
    mount.appendChild(this.display);
    this.bindViewInput(mount);

    this.buf = document.createElement('canvas');
    const bctx = this.buf.getContext('2d', { alpha: false });
    if (!bctx) throw new Error('IsoDioramaRenderer: backbuffer context unavailable');
    this.ctx = bctx;

    this.bgLayer      = document.createElement('canvas');
    this.skyCanvas    = document.createElement('canvas');
    this.crustLayer   = document.createElement('canvas');
    this.surfaceLayer = document.createElement('canvas');

    this.resize();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(mount);
    }
  }

  /**
   * Recompute virtual resolution from the mount size and rebake every layer.
   *
   * Its own path (spec 5, Resize), not a new planet: the base geometry and
   * identity layers are rebuilt (placement re-planned on the new base), the
   * weather sim is KEPT, the controller keeps its zoom and re-clamps the
   * focus, and the camera layers (and far backdrop) are re-baked at the new
   * size at once — so no frame ever shows the camera set over a stale
   * backdrop, and mid-gesture the gesture simply continues.
   */
  private resize(): void {
    if (!this.mount) return;
    // A hidden mount (display:none — e.g. an NPC planet is open) reports a
    // 0x0 box. Once the layers exist, ignore it and keep every layer and the
    // zoom state: a zero rect would make the camera NaN (cameraFromView
    // divides by it). The resize when the mount shows again restores it.
    const box = this.mount.getBoundingClientRect();
    if (this.sized && (!(box.width > 0) || !(box.height > 0))) return;
    const w = Math.max(320, this.mount.clientWidth  || 960);
    const h = Math.max(220, this.mount.clientHeight || 640);

    // Keep the long edge near 480 virtual pixels — chunky enough to read as pixel art.
    const targetLong = 480;
    if (w >= h) {
      this.VW = targetLong;
      this.VH = Math.max(200, Math.round(targetLong * h / w));
    } else {
      this.VH = targetLong;
      this.VW = Math.max(200, Math.round(targetLong * w / h));
    }

    this.display.width  = this.VW;
    this.display.height = this.VH;
    this.displayCtx.imageSmoothingEnabled = false;

    for (const c of [this.buf, this.bgLayer, this.crustLayer, this.surfaceLayer]) {
      c.width = this.VW;
      c.height = this.VH;
    }
    this.ctx.imageSmoothingEnabled = false;

    this.bgLayer.width = backdropWidth(this.VW);          // panorama, see sky/Backdrop
    this.skyCanvas.width = this.VW; this.skyCanvas.height = this.VH;
    this.skyImage = this.skyCanvas.getContext('2d')?.createImageData(this.VW, this.VH) ?? null;

    this.bakeAll(true);
    // First sizing of a hidden mount: the same fallback size the layers use.
    const shown = box.width > 0 && box.height > 0;
    this.zoom.resize(shown ? box : { width: w, height: h }, this.VW, this.VH);
    this.updateView(performance.now());
    this.sized = true;
  }

  /**
   * Wheel and drag forward to the zoom controller; nothing is drawn or baked
   * here. A pointer-down turns into a pan only past a 6 px slop, and a real
   * drag must not also count as a tile click.
   */
  private bindViewInput(mount: HTMLElement): void {
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = mount.getBoundingClientRect();
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;
      this.zoom.wheel(mx, my, e.deltaY, performance.now());
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      this.drag.active = true; this.drag.panning = false;
      this.drag.x = e.clientX; this.drag.y = e.clientY;
      mount.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const d = this.drag;
      if (!d.active) return;
      const now = performance.now();
      if (!d.panning) {
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (dx * dx + dy * dy < 36) return;
        d.panning = true;
        this.zoom.panStart(d.x, d.y, now);
      }
      this.zoom.panMove(e.clientX, e.clientY, now);
    };
    /** `click`: a pointer-up may be followed by a click; a pointercancel never is. */
    const endDrag = (click: boolean) => {
      const d = this.drag;
      if (!d.active) return;
      d.active = false;
      if (!d.panning) return;
      d.panning = false;
      this.zoom.panEnd(performance.now());
      // A real drag must not also count as a tile click. A cancelled pointer
      // gets no click, so arming the once-only swallow there would eat the
      // next real tap.
      if (!click) return;
      const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
      mount.addEventListener('click', swallow, { capture: true, once: true });
    };
    const onUp = () => endDrag(true);
    const onCancel = () => endDrag(false);
    mount.addEventListener('wheel', onWheel, { passive: false });
    mount.addEventListener('pointerdown', onDown);
    mount.addEventListener('pointermove', onMove);
    mount.addEventListener('pointerup', onUp);
    mount.addEventListener('pointercancel', onCancel);
    this.unbindView = [
      () => mount.removeEventListener('wheel', onWheel),
      () => mount.removeEventListener('pointerdown', onDown),
      () => mount.removeEventListener('pointermove', onMove),
      () => mount.removeEventListener('pointerup', onUp),
      () => mount.removeEventListener('pointercancel', onCancel),
    ];
  }

  /** Write the controller's CSS transform to the display, only when the view state changed. */
  private applyViewTransform(): void {
    const z = this.zoom, c = this.cssFor;
    if (c.zoom === z.viewZoom && c.x === z.panX && c.y === z.panY && c.shown === z.showCamera) return;
    c.zoom = z.viewZoom; c.x = z.panX; c.y = z.panY; c.shown = z.showCamera;
    this.display.style.transform = z.cssTransform();
  }

  /**
   * The per-frame view step, before anything is drawn: the settle (re-bake
   * the camera set, show it) and the throttled surface rebake, merged into
   * one camera re-bake when both fall in this frame; then the cached pick
   * buffer is re-read (the active set may have changed) and the CSS transform
   * written, so the CSS reset and the sharp camera frame land together.
   */
  private updateView(now: number): void {
    if (this.habitable) {
      this.rebakeDue = this.surfaceDirty &&
        this.elapsed - this.lastSurfaceBake > IsoDioramaRenderer.SURFACE_REBAKE_INTERVAL;
      applySettle(this.cutaway, this.zoom, now, this.settleHooks, this.bakeBudgetMs);
      if (this.rebakeDue) {
        this.rebakeDue = false;
        this.rebakeSurfaceAndPlacement(true);
      }
      this.pickBuf = this.cutaway.pick;
    }
    this.applyViewTransform();
  }

  private rebakeSurfaceAndPlacement(includeCamera: boolean): void {
    this.rebakeHabitableSurface(includeCamera);
    this.buildCityDots();
    this.buildInhabitants();
  }

  /**
   * The orbit clock. The game passes the engine's animTick through the LIVE
   * module binding — enterUniverse replaces the engine and its clock restarts.
   */
  setClock(fn: (() => number) | null): void { this.clock = fn; }

  private get animTick(): number {
    return this.clock ? this.clock() : this.elapsed * 60;
  }

  private skyNow(): SkyState<Planet> {
    return orbitSky({ animTick: this.animTick, home: this.planet, planets: this.star?.planets ?? [], dayAngle: this.dayAngle });
  }

  refreshData(
    grid: PlanetGrid,
    biosphere: PlanetBiosphere,
    species: SpeciesGenome[],
    planet: Planet,
    star?: StarBody,
    planetIndex = 0,
  ): void {
    this.rawGrid     = grid;
    this.grid        = grid;
    this.biosphere   = biosphere;
    this.species     = species;
    this.planet      = planet;
    this.planetType  = (planet.type ?? 'rocky') as PlanetType;
    this.star        = star ?? null;
    this.planetIndex = planetIndex;
    // A forming world (Formation.ts): the molten face cools stage by stage.
    const forming = this.star?.formationDestiny ? this.star.formationStage : null;
    this.cutaway.magmaHeat = forming ? Math.max(0.2, formationHeat(forming)) : 1;
    // A renderer instance can be reused across planets / a new game. Without
    // this reset, the next passive setLiveData() call would compare the NEW
    // planet's lushness against the PREVIOUS planet's, possibly suppressing
    // a re-bake this world has never actually painted.
    this.lastDecalState = null;
    this.computeFocus();
    // A (re)entered or new planet starts at the identity view: bake() drops
    // the camera layers and the sim, so the controller must not still think
    // it is zoomed (it would show CSS 'none' over identity layers at zoom k).
    this.zoom.reset();
    this.bakeAll();
    this.pickBuf = this.cutaway.pick;
    this.applyViewTransform();
  }

  /**
   * Refresh the live biosphere data without a full `refreshData`.
   *
   * `gameState.playerSpecies` is REASSIGNED on every evolution step, so the
   * array captured at `refreshData` time goes stale within seconds: the species
   * ids stamped on the grid stop matching this renderer's copy, every creature
   * lookup fails silently, and the world renders empty.
   */
  setLiveData(species: SpeciesGenome[], biosphere: PlanetBiosphere): void {
    this.species = species;
    this.biosphere = biosphere;
    // NOTE: `decalRebakeNeeded` only decides whether THIS call should mark the
    // surface dirty on its own — it must never be the sole passive trigger for
    // a re-bake. `surfaceDirty` also drives buildCityDots() and
    // buildInhabitants() (settlements, creatures), which read cell.civId,
    // cell.dominantSpeciesId and star.biologyPhase — none of which are in the
    // (lush, biodiversity) tuple below, and that tuple saturates (biodiversity
    // caps at 10, so lushFor pins at 1.0 on a thriving world and this gate
    // would return false forever). Callers that want passive settlement/
    // creature refresh must call markSurfaceDirty() themselves regardless of
    // what this method decides; see the tick%250 and onBioPhaseAdvance sites
    // in main.ts.
    const nextState = { lush: this.lushFor(biosphere), biodiversity: biosphere?.biodiversity ?? 0 };
    const flora = this.floraSig();
    if (decalRebakeNeeded(this.lastDecalState, nextState) || flora !== this.lastFloraSig) {
      this.lastDecalState = nextState;
      this.lastFloraSig = flora;
      this.markSurfaceDirty();
    }
  }

  /**
   * Ask for a terrain rebake.
   *
   * Passive changes (life spreading, new settlements) go through the throttle so
   * the bake cost stays amortised. A direct player action must repaint at once —
   * waiting seconds to see your own divine intervention land feels broken.
   */
  markSurfaceDirty(immediate = false): void {
    if (immediate) {
      this.bakeSurface();
      this.buildCityDots();
      this.buildInhabitants();
    } else {
      this.surfaceDirty = true;
    }
  }

  /**
   * Cap diorama presents. `0` = Unlimited — every display vsync (the performance
   * target on a 240Hz panel). Soft caps (30/60/120) skip presents to save power.
   */
  setTargetFps(fps: number): void {
    this.targetFps = fps > 0 ? fps : 0;
    // Unlimited: smallest settle slice so rebakes never own a whole high-Hz frame.
    this.bakeBudgetMs = this.targetFps === 0 ? 2 : this.targetFps >= 100 ? 4 : 8;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastT = performance.now();
    this.lastPresentTime = 0;
    const loop = (t: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      // Match BigBangEngine: keep RAF on vsync, skip presents under the cap.
      if (this.targetFps > 0 && this.lastPresentTime > 0) {
        const minDt = 1000 / this.targetFps;
        if (t - this.lastPresentTime < minDt - 0.5) return;
      }
      this.lastPresentTime = t;
      const dt = Math.min(0.1, (t - this.lastT) / 1000);
      this.lastT = t;
      this.elapsed += dt;
      try {
        this.frame(dt, t);
      } catch (err) {
        // A single bad draw call must never blank the planet view — log once,
        // keep whatever was already painted, and carry on.
        if (!this.errorLogged) {
          this.errorLogged = true;
          console.error('[IsoDiorama] frame error', err);
        }
        this.displayCtx.drawImage(this.buf, 0, 0);
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  resume(): void { this.start(); }

  destroy(): void {
    this.pause();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const off of this.unbindView) off();
    this.unbindView = [];
    this.display.remove();
  }

  // ─── Projection ────────────────────────────────────────────────────────────

  /**
   * Pick the lat/lon the disc is centred on: the land cell with the most land
   * around it. This is what turns a cylindrical world map into the reference's
   * "one continent in the middle of a round ocean" composition.
   */
  private computeFocus(): void {
    const grid = this.grid;
    if (!grid) { this.focusLat = 0; this.focusLon = 0; return; }

    const STRIDE = 8;
    const R = 3; // neighbourhood radius, in strided samples
    let bestScore = -1, bestRow = GRID_SIZE >> 1, bestCol = 0;

    for (let row = STRIDE * R; row < GRID_SIZE - STRIDE * R; row += STRIDE) {
      // Weight toward mid-latitudes so the disc isn't centred on a polar ice cap.
      const ny = row / (GRID_SIZE - 1);
      const latWeight = 1 - Math.abs(ny - 0.5) * 1.4;
      if (latWeight <= 0) continue;

      for (let col = 0; col < GRID_SIZE; col += STRIDE) {
        let score = 0;
        for (let dr = -R; dr <= R; dr++) {
          for (let dc = -R; dc <= R; dc++) {
            const r2 = row + dr * STRIDE;
            const c2 = (col + dc * STRIDE + GRID_SIZE) % GRID_SIZE;
            const cell = grid[r2]?.[c2];
            if (!cell) continue;
            if (!isWater(cell.biome)) score += 1 + cell.fertility;
          }
        }
        score *= latWeight;
        if (score > bestScore) { bestScore = score; bestRow = row; bestCol = col; }
      }
    }

    // Grid row 0 = north pole → lat +90°, row N-1 = south pole → lat -90°.
    this.focusLat = (0.5 - bestRow / (GRID_SIZE - 1)) * Math.PI;
    this.focusLon = (bestCol / GRID_SIZE) * Math.PI * 2;
  }

  /**
   * Inverse azimuthal-equidistant projection.
   * Disc coords (dx, dy) in [-1,1] → grid (row, col). The rim of the disc is the
   * great circle 90° away from the focus, so the top face shows one hemisphere.
   */
  private discToGrid(dx: number, dy: number): { row: number; col: number } | null {
    const f = this.discToGridF(dx, dy);
    if (!f) return null;
    return {
      row: Math.max(0, Math.min(GRID_SIZE - 1, Math.round(f.row))),
      col: Math.min(GRID_SIZE - 1, Math.floor(f.col)),
    };
  }

  /**
   * {@link discToGrid} without the rounding: the FRACTIONAL grid position,
   * `row = v * (GRID_SIZE - 1)` (cell i's centre at row i) and
   * `col = u * GRID_SIZE` (cell j's centre at col j + 0.5). Bakes use it to
   * sample elevation BETWEEN cells; picking and placement stay on discToGrid.
   */
  private discToGridF(dx: number, dy: number): { row: number; col: number } | null {
    const r = Math.hypot(dx, dy);
    if (r > 1) return null;

    const c = r * (Math.PI / 2);
    const sinC = Math.sin(c), cosC = Math.cos(c);
    const sinF = Math.sin(this.focusLat), cosF = Math.cos(this.focusLat);

    // dy is screen-down; north is screen-up, so negate.
    const ny = -dy;
    const lat = r < 1e-6
      ? this.focusLat
      : Math.asin(clampAbs(cosC * sinF + (ny * sinC * cosF) / r, 1));
    const lon = this.focusLon + Math.atan2(
      dx * sinC,
      r * cosF * cosC - ny * sinF * sinC,
    );

    const v = 0.5 - lat / Math.PI;                       // 0 = north pole
    const u = ((lon / (Math.PI * 2)) % 1 + 1) % 1;

    return { row: v * (GRID_SIZE - 1), col: u * GRID_SIZE };
  }

  /**
   * Sub-cell elevation: {@link smoothElevation} interpolated bilinearly between
   * the 4 cell centres around the pixel's fractional grid position (columns
   * wrap, rows clamp). Coastlines and terrace edges follow it, so they become
   * curves when the view is re-rendered zoomed in instead of cell-sized stair
   * steps. Bake-time only — never called per frame, and only camera bakes
   * (cameraZoom > 1) use it; the identity bake stays nearest-cell. The caller
   * subtracts rimFalloff as it does for smoothElevation.
   */
  private elevationAt(grid: PlanetGrid, dx: number, dy: number): number | null {
    const f = this.discToGridF(dx, dy);
    return f ? this.elevationAtGrid(grid, f.row, f.col) : null;
  }

  /** {@link elevationAt} at a fractional grid position (discToGridF units). */
  private elevationAtGrid(grid: PlanetGrid, row: number, col: number): number {
    const rr = Math.max(0, Math.min(GRID_SIZE - 1, row));
    const r0 = Math.min(GRID_SIZE - 2, Math.floor(rr)), tr = rr - r0;
    const cc = col - 0.5;
    const c0f = Math.floor(cc), tc = cc - c0f;
    const c0 = ((c0f % GRID_SIZE) + GRID_SIZE) % GRID_SIZE, c1 = (c0 + 1) % GRID_SIZE;
    const e00 = this.smoothElevation(grid, r0, c0), e01 = this.smoothElevation(grid, r0, c1);
    const e10 = this.smoothElevation(grid, r0 + 1, c0), e11 = this.smoothElevation(grid, r0 + 1, c1);
    const top = e00 + (e01 - e00) * tc, bot = e10 + (e11 - e10) * tc;
    return top + (bot - top) * tr;
  }

  /**
   * Forward azimuthal-equidistant projection — the inverse of {@link discToGrid}.
   * Returns null for cells on the far hemisphere, which the disc does not show.
   */
  private gridToDisc(row: number, col: number): { dx: number; dy: number } | null {
    const lat = (0.5 - row / (GRID_SIZE - 1)) * Math.PI;
    const lon = (col / GRID_SIZE) * Math.PI * 2;
    const dlon = lon - this.focusLon;

    const sinF = Math.sin(this.focusLat), cosF = Math.cos(this.focusLat);
    const sinL = Math.sin(lat), cosL = Math.cos(lat);

    const cosC = clampAbs(sinF * sinL + cosF * cosL * Math.cos(dlon), 1);
    const c = Math.acos(cosC);
    if (c > Math.PI / 2) return null;          // behind the horizon

    const sinC = Math.sin(c);
    const k = sinC === 0 ? 1 : c / sinC;
    const X = k * cosL * Math.sin(dlon);
    const Y = k * (cosF * sinL - sinF * cosL * Math.cos(dlon));

    // |(X, Y)| == c for this projection, and the rim is at c = π/2.
    const s = 1 / (Math.PI / 2);
    return { dx: X * s, dy: -Y * s };          // negate: screen y grows downward
  }

  /**
   * Map a viewport point to the grid cell under it.
   *
   * Accounts for the CSS upscale of the low-res backbuffer, so callers can pass
   * raw `clientX`/`clientY` from a pointer event.
   */
  pickTile(clientX: number, clientY: number): { row: number; col: number } | null {
    const rect = this.display.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const px = Math.round((clientX - rect.left) * (this.VW / rect.width));
    const py = Math.round((clientY - rect.top) * (this.VH / rect.height));

    if (this.habitable) return this.cutaway.hitTest(px, py);

    // Prefer what was actually PAINTED at this pixel: terrain is extruded, so a
    // peak covers pixels that the flat projection maps to a different cell.
    if (this.pickBuf && px >= 0 && px < this.VW && py >= 0 && py < this.VH) {
      const id = this.pickBuf[py * this.VW + px];
      if (id > 0) {
        const k = id - 1;
        return { row: Math.floor(k / GRID_SIZE), col: k % GRID_SIZE };
      }
    }

    const dx = (px - this.cx) / this.rx;
    const dy = (py - this.cy) / this.ry;
    if (dx * dx + dy * dy > 1) return null;    // not on the top face

    return this.discToGrid(dx, dy);
  }

  /**
   * A cell as the player SEES it: biome and elevation after the rim
   * falloff the bake applies (near the rim the land sinks into the sea, so
   * the raw grid biome can say savanna where the view shows ocean), and a
   * climate in real units for this kind of world.
   */
  shownCell(row: number, col: number): { biome: BiomeType; elevation: number; tempC: number; humidity: number } | null {
    const cell = this.grid?.[row]?.[col];
    if (!cell) return null;
    const d = this.gridToDisc(row, col);
    const rim = this.habitable && d ? this.rimFalloff(Math.hypot(d.dx, d.dy)) : 0;
    const elevation = cell.elevation - rim;
    const biome = this.habitable ? classifyBiome(elevation, cell.moisture, cell.temperature, this.planetType as HabitableType) : cell.biome;
    // [cold end, hot end] in °C and how much water the air can hold, by world.
    const stage = this.forming ? this.star?.formationStage ?? '' : '';
    const RANGE: Record<string, [number, number, number]> = {
      lava: [180, 900, 0.03], toxic: [60, 460, 0.6], desert: [5, 55, 0.3], ice: [-120, -10, 0.35],
      ocean: [-5, 32, 1], rocky: [-25, 35, 1], storm: [-40, 22, 1], carbon: [-60, 40, 0.5], crystal: [-80, 12, 0.3],
    };
    const STAGE: Record<string, [number, number, number]> = {
      magma: [900, 1600, 0], cooling: [350, 900, 0.02], volcanic: [90, 420, 0.08], atmosphere: [40, 140, 0.4],
    };
    const [lo, hi, wet] = STAGE[stage] ?? RANGE[this.planetType] ?? RANGE.rocky;
    const tempC = Math.round(lo + cell.temperature * (hi - lo));
    // Water can't stay in the air above boiling (pressure aside); ice holds little.
    const humidity = tempC >= 100 ? Math.min(cell.moisture * wet, 0.05) : cell.moisture * wet;
    return { biome, elevation, tempC, humidity };
  }

  /** Cell to outline on the surface, or null. Set by the planet-view UI. */
  setHighlight(cell: { row: number; col: number } | null): void {
    this.highlight = cell;
  }

  /** Cell to mark as the current selection, or null. */
  setSelection(cell: { row: number; col: number } | null): void {
    this.selection = cell;
  }

  /**
   * Elevation penalty applied toward the rim, so the projected hemisphere always
   * reads as "continent, then ocean, then the disc edge" — the reference silhouette.
   */
  private rimFalloff(r: number): number {
    const t = clamp01((r - 0.34) / 0.66);
    return t * t * 0.30;
  }

  /**
   * How far, in virtual pixels, the tallest ground rises off the top face.
   *
   * The face is an ellipse only ~0.30 as tall as it is wide (the ~25° camera
   * pitch), so a lift of a tenth of the x-radius is roughly a third of the face's
   * apparent depth — enough for a mountain to read as a mountain without the
   * silhouette ceasing to look like a disc.
   */
  private get maxLift(): number {
    // Habitable: five tiers to 18px. The previous 2/5/9 was measured to leave
    // the common step at 3px on a board only 210px wide — about 1.4% of the
    // width — so the relief was present in the data and invisible on screen.
    // Legacy keeps its taller disc lift.
    if (this.habitable) return 32;
    return Math.max(LIFT_STEP, Math.round(this.rx * 0.11));
  }

  /**
   * Vertical displacement for a point of ground, in whole pixels.
   *
   * Terrain used to be drawn dead flat: `cell.elevation` reached the renderer but
   * only ever modulated *shading*, so the highest peak and the lowest plain sat on
   * exactly the same scanline and the surface read as a painted disc. This turns
   * the elevation field the grid already carries into actual geometry.
   *
   * Water is never lifted, so coastlines, the surf ring and the disc silhouette
   * are all unchanged — only land rises.
   */
  private liftOf(elev: number): number {
    if (elev < SEA_LEVEL) return 0;
    // Habitable: same three-tier language as diorama_test (all land lifts, so
    // coasts shelf above water and peaks stand clear for life/settlements).
    if (this.habitable) {
      // Five tiers rather than three: with three, ~80% of the visible face sat
      // on one tier and the surface read as a painted disc. Measured inside the
      // rendered disc at 480x320: lift2 16%, lift5 14%, lift9 1.5%.
      // Above 0.92 only volcano cones reach (ventedGrid): their upper terraces.
      if (elev > 1.06) return 32;
      if (elev > 1.0) return 27;
      if (elev > 0.92) return 22;
      if (elev > 0.80) return 18;
      if (elev > 0.70) return 13;
      if (elev > 0.62) return 9;
      if (elev > 0.54) return 6;
      return 3;
    }
    const t = clamp01((elev - SEA_LEVEL) / (1 - SEA_LEVEL));
    // QUANTISED into a few chunky terraces rather than a continuous ramp.
    // Continuous height puts most of the continent one pixel up (measured: the
    // median land cell lifts 1px, see `tools/reliefCheck.ts`), and a landscape
    // of one-pixel steps reads as contour lines, not mountains. Snapping to
    // `LIFT_STEP` gives a handful of clean plateaus with real cliffs between
    // them — which is also the terraced look the diorama's art style wants.
    const raw = this.maxLift * Math.pow(t, 1.15);
    return Math.round(raw / LIFT_STEP) * LIFT_STEP;
  }

  /**
   * Elevation smoothed over the cell's neighbours.
   *
   * Height must vary smoothly across pixels or the extrusion turns to stipple:
   * raw per-cell elevation jumps at every cell boundary, and each jump becomes
   * its own one-pixel cliff. Averaging a 3×3 neighbourhood (wrapping in
   * longitude, clamping at the poles) gives ridges instead of noise.
   */
  private smoothElevation(grid: PlanetGrid, row: number, col: number): number {
    let sum = 0, n = 0;
    for (let dr = -1; dr <= 1; dr++) {
      const r2 = row + dr;
      if (r2 < 0 || r2 >= GRID_SIZE) continue;
      for (let dc = -1; dc <= 1; dc++) {
        const c2 = (col + dc + GRID_SIZE) % GRID_SIZE;
        const cell = grid[r2]?.[c2];
        if (!cell) continue;
        // Weight the centre so ridgelines stay where the data puts them.
        const wt = (dr === 0 && dc === 0) ? 4 : 1;
        sum += cell.elevation * wt; n += wt;
      }
    }
    return n > 0 ? sum / n : 0;
  }

  /** Lift for a grid cell at disc radius `r`, for placing props on the terrain. */
  private liftAtCell(cell: { elevation: number }, r: number): number {
    return this.liftOf(cell.elevation - this.rimFalloff(r));
  }

  // ─── Baking ────────────────────────────────────────────────────────────────

  /**
   * Lushness driving vegetation tint and decal density: 0-1.
   *
   * biodiversity is a SPECIES COUNT on a 0-10 scale, not a 0-1 fraction;
   * treating it as a fraction saturated `lush` as soon as a second species
   * appeared and flattened every continent to the same green. ONE formula,
   * called from every site that needs it, so this scale/fraction distinction
   * cannot drift apart across call sites again.
   */
  private lushFor(bio: PlanetBiosphere | null): number {
    // A world still forming has no cover yet, whatever the biosphere says.
    if (this.forming) return 0;
    return bio ? clamp01((bio.biodiversity / 10) * 0.55 + bio.landLife * 0.45) : 0.3;
  }

  /** A plant lineage, the same test the codex uses for flora. */
  private isFlora(sp: SpeciesGenome): boolean {
    return sp.dna.diet === 'producer'
      || sp.dna.metabolism === 'photosynthetic'
      || sp.dna.locomotion === 'stationary';
  }

  /**
   * How big a decal stamps, as a fraction of the 16px atlas cell.
   * Ordinary cover is a few pixels. A flora genome of size `massive` grows
   * a super tree; `large` is taller than the scrub but still leaves ground.
   */
  private floraScaleFn(): (row: number, col: number, kind: DecalKind) => number {
    const byId = new Map<string, SpeciesGenome>();
    for (const sp of this.species) byId.set(sp.id, sp);
    const grid = this.grid;
    return (row, col, kind) => {
      const sp = byId.get(grid?.[row]?.[col]?.dominantSpeciesId ?? '');
      const flora = !!sp && this.isFlora(sp);
      const size = flora ? sp.physicalTraits.size : '';
      if (isMineralKind(kind)) return defaultDecalScale(kind);
      const woody = isWoody(kind);
      if (size === 'massive' && woody) return 1.15;
      if (size === 'massive') return 0.75;
      if (size === 'large' && woody) return 0.62;
      return defaultDecalScale(kind);
    };
  }

  /** Changes when a living plant lineage changes size class. */
  private floraSig(): string {
    let s = '';
    for (const sp of this.species) {
      if (sp.isExtinct || !this.isFlora(sp)) continue;
      s += sp.id + sp.physicalTraits.size + ';';
    }
    return s;
  }

  /**
   * The weather's view of this world. Every input is real state: grid, biosphere
   * stress and oxygen, civ level, and the planet's own genome seed, so each world
   * has its own weather personality. Null for gas giants and before a grid exists.
   */
  private climateFor(): ClimateSources | null {
    const grid = this.grid;
    if (!grid || this.planetType === 'gas') return null;
    const bio = this.biosphere;
    return buildClimate({
      grid,
      planetType: this.planetType,
      seed: this.planet?.genomeSeed ?? this.planetSeed,
      lush: this.lushFor(bio),
      extinctionPressure: bio?.extinctionPressure ?? 0,
      oxygenLevel: bio?.oxygenLevel ?? 0.5,
      civLevel: this.star?.civLevel ?? 0,
      inNebula: this.inNebula(),
    });
  }

  /**
   * Arguments for the habitable cutaway bake.
   *
   * The engine does not know about `PlanetGrid` focus, elevation terracing or
   * the pick buffer, so the projection and relief helpers are handed to it as
   * callbacks. That keeps ONE implementation of the azimuthal mapping — picking,
   * tile markers, settlements and divine effects all still go through
   * `discToGrid` / `gridToDisc` here, so they stay in register with the terrain.
   */
  private bakeHabitableCutaway(keepSim = false): void {
    // Towns first: their fields and roads are painted by the bake. The
    // geometry is the one the bake is about to lay out.
    if (this.habitable && this.rawGrid) this.grid = this.ventedGrid(this.rawGrid);
    this.planTowns(this.geomForBake());
    this.placeVentFx(this.geomForBake());
    const bio = this.biosphere;
    const grid = this.grid;
    // keepSim: a resize of the same planet (the engine keeps the weather sim).
    const engine = this.cutaway;
    (keepSim ? engine.resize : engine.bake).call(engine, {
      w: this.VW, h: this.VH,
      seed: this.planetSeed,
      grid: this.grid,
      planetType: this.planetType as HabitableType,
      barren: this.forming,
      // Volcanoes are terrain now (ventedGrid), not pasted cones.
      volcanoes: null,
      // No rivers until the rains: only the sea / ice stages carry them.
      noRivers: this.forming && this.star?.formationStage !== 'primordial' && this.star?.formationStage !== 'ice_age',
      discToGrid: (dx, dy) => this.discToGrid(dx, dy),
      discToGridF: (dx, dy) => this.discToGridF(dx, dy),
      rimFalloff: (r) => this.rimFalloff(r),
      liftOf: (elev) => this.liftOf(elev),
      smoothElevation: (grid, row, col) => this.smoothElevation(grid, row, col),
      elevationAt: grid ? (dx, dy) => this.elevationAt(grid, dx, dy) : undefined,
      maxLift: this.maxLift,
      lush: this.lushFor(bio),
      weather: this.climateFor(),
      sunLat: this.skyNow().declination,
      decalSeed: this.planet?.genomeSeed ?? 0,
      decalAtlas: this.decalAtlas,
      decalScale: this.floraScaleFn(),
      groundAt: (x, y, k, r, g, b, water) => townGroundAt(this.townPlan, x, y, k, r, g, b, water, this.season),
      winterSnow: this.season === 3 ? 1 : 0,
      decalBlocked: (x, y) => this.townPlan.towns.length > 0 && keepClear(this.townPlan, x, y),
    });
    this.pickBuf = this.cutaway.pick;
    this.lastSurfaceBake = this.elapsed;
    this.surfaceDirty = false;
  }

  /**
   * Repaint only habitable terrain; animation-owned cutaway state remains live.
   * `includeCamera: false` when a settle re-bakes the camera set this frame.
   */
  private rebakeHabitableSurface(includeCamera = true): void {
    this.planTowns();
    const bio = this.biosphere;
    this.cutaway.updateSurfaceOpts({
      winterSnow: this.season === 3 ? 1 : 0,
      lush: this.lushFor(bio),
      decalSeed: this.planet?.genomeSeed ?? 0,
      decalAtlas: this.decalAtlas,
      decalScale: this.floraScaleFn(),
    });
    this.cutaway.rebakeSurface(includeCamera);
    // Sources follow the world (industry, stress, lushness); the sky is kept.
    this.cutaway.setWeatherClimate(this.climateFor());
    this.pickBuf = this.cutaway.pick;
    this.lastSurfaceBake = this.elapsed;
    this.surfaceDirty = false;
  }

  /** `keepSim`: the resize path (same planet, new size) — see `resize`. */
  private bakeAll(keepSim = false): void {
    this.bakeBackground();
    if (this.habitable) {
      this.bakeHabitableCutaway(keepSim);
      this.buildCityDots();
      this.buildRipples();
      this.buildInhabitants();
      this.embers = [];
      return;
    }
    this.bakeCrust();
    this.bakeSurface();
    this.buildCityDots();
    this.buildRipples();
    this.buildInhabitants();
    this.embers = [];
  }

  // Space backdrop: a tiling panorama (sky/Backdrop) that slides with the year.
  private bakeBackground(): void {
    const g = this.bgLayer.getContext('2d')!;
    const img = g.createImageData(this.bgLayer.width, this.VH);
    bakeBackdrop(img, { seed: this.planetSeed ^ 0x9e3779b9, vw: this.VW });
    g.putImageData(img, 0, 0);
    this.bgFarFor = null;   // a new planet or size: any far panorama is stale
  }

  /**
   * The far panorama for `cam`: the same backdrop re-baked at `farScale(k)`
   * about the focus (stars stay 1 px). Skipped when the one baked already
   * matches. Settle-time only.
   */
  private bakeFarBackdrop(cam: Camera): void {
    const s = farScale(cam.zoom), W = backdropWidth(this.VW), H = this.VH;
    const seed = this.planetSeed ^ 0x9e3779b9;
    const f = this.bgFarFor;
    if (f && f.zoom === cam.zoom && f.fy === cam.fy && f.W === W && f.H === H && f.seed === seed) return;
    if (!this.bgFar) this.bgFar = document.createElement('canvas');
    const Ws = Math.round(W * s);
    this.bgFar.width = Ws; this.bgFar.height = H;
    const g = this.bgFar.getContext('2d');
    if (!g) return;
    const img = g.createImageData(Ws, H);
    bakeBackdrop(img, { seed, vw: this.VW, scale: s, fy: cam.fy });
    g.putImageData(img, 0, 0);
    this.bgFarFor = { zoom: cam.zoom, fy: cam.fy, W, H, seed };
  }

  /**
   * Show the scene through `cam` — the settle step (Task 7's controller calls
   * it; zoomCheck drives it headless). Bakes the engine's camera layer set and
   * shows it (the identity camera drops it), and re-bakes the far backdrop at
   * `farScale(k)`. Never re-plans placement: city lights, settlements,
   * creatures, decals, chimneys and divine effects are stored in base world
   * and only their draw positions follow the camera.
   */
  setCamera(cam: Camera): void {
    if (!this.habitable) return;
    this.cutaway.setCamera(cam);
    const id = isIdentity(cam, this.VW, this.VH);
    this.cutaway.showCamera = !id;
    this.pickBuf = this.cutaway.pick;
    if (!id) this.bakeFarBackdrop(cam);
  }

  /**
   * The rock underside: a jagged silhouette, horizontal strata, caves, ore
   * crystals and lit boulder facets. Also paints the water cut band under the rim.
   */
  private bakeCrust(): void {
    if (this.habitable) {
      this.bakeHabitableCutaway();
      return;
    }
    const g = this.crustLayer.getContext('2d')!;
    const { VW, VH, cx, cy, rx, ry, cutH, crustH } = this;
    g.clearRect(0, 0, VW, VH);

    const pal = PALETTES[this.planetType];
    const seed = this.planetSeed;
    const s = new Stream(seed ^ 0x51ed2701);

    // Gas giants have no crust to slice — they are drawn whole in bakeSurface.
    if (this.planetType === 'gas') return;

    // ── Silhouette profile: for each column, how deep the rock reaches. ────────
    // A smooth bowl reads as a blob; the reference underside is a broken mass of
    // ledges, spurs and fissures. The profile is precomputed per column so it can
    // be smoothed before terracing — without the smoothing pass, single columns
    // of noise become 1px "hairs" dangling off the bottom.
    const left = cx - rx;
    const cols = rx * 2 + 1;
    const raw = new Float32Array(cols);

    for (let i = 0; i < cols; i++) {
      const x = left + i;
      const dxn = (x - cx) / rx;                       // −1 … 1
      // Tapers toward the edges so the mass hangs like a torn-off chunk of world.
      const keel = Math.pow(Math.max(0, 1 - dxn * dxn), 0.78);
      const jag  = fbm1((x - cx) * 0.045, seed, 4) * 0.58
                 + fbm1((x - cx) * 0.155, seed + 77, 3) * 0.28
                 + fbm1((x - cx) * 0.44,  seed + 401, 2) * 0.14;
      // Broad spurs and clefts, modulated smoothly rather than thresholded.
      const spur = Math.sin(fbm1((x - cx) * 0.055, seed + 1234, 2) * Math.PI * 2.4) * 0.16;
      raw[i] = crustH * Math.max(0, 0.14 + keel * 0.80 + (jag - 0.5) * 0.50 + spur);
    }

    // Two box-blur passes kill hair-thin spikes while keeping the crags.
    const prof = new Float32Array(cols);
    for (let pass = 0; pass < 2; pass++) {
      const src = pass === 0 ? raw : prof.slice();
      for (let i = 0; i < cols; i++) {
        const a = src[Math.max(0, i - 1)], b = src[i], c = src[Math.min(cols - 1, i + 1)];
        prof[i] = (a + b * 2 + c) / 4;
      }
    }

    // Terrace into rock ledges — small and irregular, so it reads as broken
    // strata rather than a staircase.
    for (let i = 0; i < cols; i++) {
      const ledge = 2 + Math.round(fbm1(i * 0.035, seed + 909, 2) * 3);
      prof[i] = Math.round(prof[i] / ledge) * ledge;
    }

    // Median-3 pass: terracing can leave a single column rounding a step further
    // than its neighbours, which draws as a 1px spike dangling off the rock.
    // A median removes those outliers without softening the ledges themselves.
    const terr = prof.slice();
    for (let i = 1; i < cols - 1; i++) {
      const a = terr[i - 1], b = terr[i], c = terr[i + 1];
      prof[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
    }

    const depthAt = (x: number): number => {
      const i = Math.round(x) - left;
      if (i < 0 || i >= cols) return 0;
      return prof[i];
    };

    // Worlds with no surface water get no cut band — the rock has to start right
    // at the rim instead, or a slice of empty space shows through.
    const hasWaterCut = this.planetType !== 'lava';
    const cutBand = hasWaterCut ? cutH : 0;

    // Where the top of the rock sits: the front half of the disc ellipse, pushed
    // down by the cut band.
    const rockTopAt = (x: number): number => {
      const dxn = (x - cx) / rx;
      const e = Math.sqrt(Math.max(0, 1 - dxn * dxn));
      return cy + ry * e + cutBand * e;
    };

    // ── Water cut band under the rim ─────────────────────────────────────────
    if (hasWaterCut) {
      for (let x = cx - rx; x <= cx + rx; x++) {
        const dxn = (x - cx) / rx;
        const e = Math.sqrt(Math.max(0, 1 - dxn * dxn));
        const top = cy + ry * e;
        const h = cutH * e;
        if (h < 1) continue;
        for (let y = 0; y < h; y++) {
          const t = y / h;
          const lit = 0.72 + 0.5 * Math.max(0, dxn);         // key light from the right
          const f = (1 - t * 0.55) * lit;
          g.fillStyle = css(shade(pal.cutWater, f));
          g.fillRect(x, Math.round(top + y), 1, 1);
        }
        // Vertical striation for a glassy cut-crystal read.
        if (((x - cx) % 11 + 11) % 11 === 0) {
          g.fillStyle = 'rgba(255,255,255,0.10)';
          g.fillRect(x, Math.round(top), 1, Math.round(h));
        }
      }
    }

    // ── Strata ────────────────────────────────────────────────────────────────
    const bands = pal.strata.length;
    for (let x = cx - rx; x <= cx + rx; x++) {
      const top = rockTopAt(x);
      const depth = depthAt(x);
      if (depth < 2) continue;

      const dxn = (x - cx) / rx;
      // Key light from upper-right, terminator falls to the left.
      const lit = 0.55 + 0.62 * clamp01(dxn * 0.9 + 0.45);

      // Strata are geological layers: they must run horizontally across the whole
      // mass at a fixed screen depth, not follow each column's own silhouette.
      const strataSpan = ry + cutBand + crustH;

      for (let y = 0; y < depth; y++) {
        const absY = top + y;
        const t = y / depth;                             // depth *into this column*
        // Wavy band boundaries so strata don't read as ruler-straight stripes.
        const wave = (fbm1(x * 0.022, seed + 311, 3) - 0.5) * 0.55
                   + (fbm1(x * 0.075, seed + 733, 2) - 0.5) * 0.22;
        const bandPos = clamp01((absY - cy) / strataSpan) * bands + wave;
        const bi = Math.max(0, Math.min(bands - 1, Math.floor(bandPos)));
        const base = pal.strata[bi];

        // Ambient occlusion: darker just under the rim and toward the keel.
        const ao = 1 - t * 0.26 - (y < 3 ? (3 - y) / 3 : 0) * 0.28;
        // Fine rock speckle + horizontal sediment streaking.
        const grain = 0.90 + hash1(x * 733 + y * 13, seed) * 0.20;
        const streak = 0.94 + fbm1(x * 0.09 + y * 1.7, seed + 55, 2) * 0.14;

        let f = lit * ao * grain * streak;
        // Dark seam at each strata boundary, bright lip just below it — this is
        // what makes the layers read as geology instead of a gradient.
        const frac = bandPos - Math.floor(bandPos);
        if (frac < 0.07) f *= 0.68;
        else if (frac < 0.16) f *= 1.12;

        g.fillStyle = css(shade(base, f));
        g.fillRect(x, Math.round(top + y), 1, 1);
      }

      // Warm rim light tracing the crust's lit silhouette edge.
      if (dxn > 0.1) {
        const a = clamp01((dxn - 0.1) / 0.9) * 0.55;
        g.fillStyle = css(pal.keyLight, a * 0.45);
        g.fillRect(x, Math.round(top + depth) - 2, 1, 2);
      }
      // Dark contact shadow on the shadowed edge keeps the silhouette crisp.
      g.fillStyle = 'rgba(2,2,6,0.55)';
      g.fillRect(x, Math.round(top + depth) - 1, 1, 1);
    }

    // ── Caves ─────────────────────────────────────────────────────────────────
    const caveCount = 3 + (seed % 3);
    const cavePlaced: Array<{ x: number; y: number; r: number }> = [];
    for (let i = 0; i < caveCount; i++) {
      const x = Math.round(cx + s.range(-rx * 0.66, rx * 0.66));
      const top = rockTopAt(x);
      const w = s.range(rx * 0.045, rx * 0.10);
      const h = w * s.range(0.5, 0.8);
      // Keep the whole mouth well inside the rock mass — a cave hanging off the
      // silhouette reads as a rendering bug, not a cave. The narrowest column
      // the mouth spans is what limits it, not the column at its centre.
      let depth = Infinity;
      for (let dx = -Math.ceil(w); dx <= Math.ceil(w); dx++) depth = Math.min(depth, depthAt(x + dx));
      if (depth < h * 2 + 14) continue;
      const y = top + s.range(h + 7, depth - h - 7);
      // Don't let two mouths merge into one shapeless blob.
      if (cavePlaced.some(c => Math.hypot(c.x - x, c.y - y) < c.r + w + 6)) continue;
      cavePlaced.push({ x, y, r: w });

      // Mouth with an interior that falls off into darkness.
      const mouth = g.createRadialGradient(x, y - h * 0.15, 0, x, y, Math.max(w, h));
      mouth.addColorStop(0, 'rgba(2,2,5,1)');
      mouth.addColorStop(0.65, 'rgba(10,7,12,0.96)');
      mouth.addColorStop(1, css(shade(pal.strata[4], 0.7), 0.85));
      g.fillStyle = mouth;
      ellipse(g, x, y, w, h);

      // Lit lip along the top edge, shadowed drop along the bottom.
      g.strokeStyle = css(shade(pal.strata[1], 1.25), 0.6);
      g.lineWidth = 1;
      g.beginPath();
      g.ellipse(x, y, w, h, 0, Math.PI * 1.05, Math.PI * 1.95);
      g.stroke();
      g.strokeStyle = 'rgba(0,0,0,0.4)';
      g.beginPath();
      g.ellipse(x, y, w, h, 0, Math.PI * 0.05, Math.PI * 0.95);
      g.stroke();

      // Faint interior glow on molten worlds
      if (this.planetType === 'lava') {
        g.fillStyle = 'rgba(255,110,30,0.35)';
        ellipse(g, x, y + h * 0.25, w * 0.5, h * 0.4);
      }
    }

    // ── Ore crystals ──────────────────────────────────────────────────────────
    const oreCount = 16 + (seed % 10);
    for (let i = 0; i < oreCount; i++) {
      const x = Math.round(cx + s.range(-rx * 0.86, rx * 0.86));
      const top = rockTopAt(x);
      const w = s.range(1.2, 3);
      const h = w * s.range(1.2, 2.2);
      let depth = Infinity;
      for (let dx = -Math.ceil(w); dx <= Math.ceil(w); dx++) depth = Math.min(depth, depthAt(x + dx));
      if (depth < h * 2 + 8) continue;
      const y = top + s.range(h + 4, depth - h - 4);
      const col = s.pick(pal.ore);
      // Facet body
      g.fillStyle = css(shade(col, 0.8));
      g.beginPath();
      g.moveTo(x, y - h);
      g.lineTo(x + w, y);
      g.lineTo(x, y + h * 0.5);
      g.lineTo(x - w, y);
      g.closePath();
      g.fill();
      // Lit facet
      g.fillStyle = css(col, 0.95);
      g.beginPath();
      g.moveTo(x, y - h);
      g.lineTo(x + w, y);
      g.lineTo(x, y + h * 0.5);
      g.closePath();
      g.fill();
      // Spark
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.fillRect(Math.round(x), Math.round(y - h * 0.5), 1, 1);
    }

    // ── Boulder facets on the lit side ────────────────────────────────────────
    const boulders = 10 + (seed % 6);
    for (let i = 0; i < boulders; i++) {
      const x = Math.round(cx + s.range(-rx * 0.86, rx * 0.86));
      const top = rockTopAt(x);
      const w = s.range(3, 8);
      const h = s.range(3, 7);
      let depth = Infinity;
      for (let dx = -Math.ceil(w); dx <= Math.ceil(w); dx++) depth = Math.min(depth, depthAt(x + dx));
      if (depth < h * 2 + 10) continue;
      const y = top + s.range(h + 5, depth - h - 5);
      const dxn = (x - cx) / rx;
      const lit = 0.7 + 0.7 * clamp01(dxn * 0.9 + 0.4);
      const base = pal.strata[s.int(0, 2)];
      g.fillStyle = css(shade(base, lit * 1.12));
      g.beginPath();
      g.moveTo(x - w, y);
      g.lineTo(x - w * 0.4, y - h);
      g.lineTo(x + w * 0.6, y - h * 0.7);
      g.lineTo(x + w, y + h * 0.3);
      g.lineTo(x - w * 0.2, y + h * 0.6);
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.beginPath();
      g.moveTo(x - w, y);
      g.lineTo(x - w * 0.2, y + h * 0.6);
      g.lineTo(x + w, y + h * 0.3);
      g.closePath();
      g.fill();
    }
  }

  /** The top face: azimuthal projection of the grid, shaded and rimmed with surf. */
  private bakeSurface(): void {
    if (this.habitable) {
      this.rebakeHabitableSurface();
      return;
    }
    const g = this.surfaceLayer.getContext('2d')!;
    const { VW, VH, cx, cy, rx, ry } = this;
    g.clearRect(0, 0, VW, VH);
    this.lastSurfaceBake = this.elapsed;
    this.surfaceDirty = false;

    const pal = PALETTES[this.planetType];
    const grid = this.grid;

    // A gas giant has no solid surface, so slicing it into a disc reads as a
    // mistake. Draw the whole banded sphere instead.
    if (this.planetType === 'gas') { this.bakeGasGiant(g); return; }

    const x0 = Math.max(0, cx - rx), x1 = Math.min(VW - 1, cx + rx);
    const y0 = Math.max(0, cy - ry), y1 = Math.min(VH - 1, cy + ry);
    if (x1 <= x0 || y1 <= y0) return;

    // The buffer extends `maxLift` rows ABOVE the ellipse, because raised ground
    // is drawn at a smaller screen y than the point it belongs to and peaks near
    // the far rim must be allowed to break the outline.
    const lift0 = this.maxLift;
    const yTop  = Math.max(0, y0 - lift0);
    if (!this.pickBuf || this.pickBuf.length !== VW * VH) {
      this.pickBuf = new Int32Array(VW * VH);
    } else {
      this.pickBuf.fill(0);
    }
    const pick = this.pickBuf;
    const w = x1 - x0 + 1, h = y1 - yTop + 1;
    const img = g.createImageData(w, h);
    const d = img.data;
    // Painter's order: rows are walked far → near, so nearer ground overwrites
    // the ground behind it and hills correctly occlude the valleys they stand in.
    const put = (
      px: number, py: number, cr: number, cg: number, cb: number, cellId = 0,
    ): void => {
      if (py < yTop || py > y1 || px < x0 || px > x1) return;
      const o = ((py - yTop) * w + (px - x0)) * 4;
      d[o]     = cr < 0 ? 0 : cr > 255 ? 255 : cr;
      d[o + 1] = cg < 0 ? 0 : cg > 255 ? 255 : cg;
      d[o + 2] = cb < 0 ? 0 : cb > 255 ? 255 : cb;
      d[o + 3] = 255;
      if (cellId > 0 && py >= 0 && py < VH && px >= 0 && px < VW) {
        pick[py * VW + px] = cellId;
      }
    };

    const seed = this.planetSeed;
    // Hoisted: the cliff-face blend target is constant for the whole bake, and
    // the fill runs up to `maxLift` times per pixel.
    const strataTop = pal.strata[0];
    // See lushFor() for the biodiversity-scale caveat this formula guards against.
    const lush = this.lushFor(this.biosphere);

    for (let py = y0; py <= y1; py++) {
      const dy = (py - cy) / ry;
      for (let px = x0; px <= x1; px++) {
        const dx = (px - cx) / rx;
        const r = Math.hypot(dx, dy);
        if (r > 1) continue;

        let cr = 0, cg = 0, cb = 0;
        let lift = 0;
        let cellId = 0;
        let fall = false;

        if (!grid) {
          cr = 40; cg = 60; cb = 90;
        } else {
          const gp = this.discToGrid(dx, dy);
          if (!gp) continue;
          const cell = grid[gp.row]?.[gp.col];
          if (!cell) continue;

          // Re-classify with a rim falloff so land sits in the middle of an ocean.
          const elev = cell.elevation - this.rimFalloff(r);
          const biome: BiomeType = this.planetType === 'lava'
            ? cell.biome
            : classifyBiome(elev, cell.moisture, cell.temperature, this.planetType);

          let [br, bg2, bb] = BIOME_COLORS[biome];

          if (this.planetType === 'lava') {
            // Cooled basalt plates broken by molten channels, rather than a
            // single flat volcanic colour across the whole face. Driven by the
            // cell's own elevation/moisture fields, which are continuous across
            // the projection's longitude wrap — indexing by grid column instead
            // draws a hard seam straight down the middle of the disc.
            const crust = cell.elevation * 0.76 + cell.moisture * 0.24;
            const heat  = clamp01((0.52 - crust) / 0.22);
            br = mix(28, 255, heat);
            bg2 = mix(16, 120 + heat * 90, heat * heat);
            bb = mix(14, 30, heat);
          } else if (this.planetType === 'ice') {
            // Frozen sea at the rim, glacier sheet inland, crevasse shading
            // driven by elevation. Vegetation never applies here.
            const frozenSea = elev < SEA_LEVEL;
            const alt = clamp01((elev - (frozenSea ? 0.20 : SEA_LEVEL)) / 0.4);
            const crev = fbm1(cell.elevation * 40 + cell.moisture * 17, seed + 5, 3);
            const shard = 0.92 + crev * 0.16;
            if (frozenSea) {
              br = mix(120, 186, alt) * shard;
              bg2 = mix(158, 214, alt) * shard;
              bb = mix(186, 232, alt) * shard;
            } else {
              br = mix(198, 248, alt) * shard;
              bg2 = mix(216, 252, alt) * shard;
              bb = mix(228, 255, alt) * shard;
            }
          } else if (!isWater(biome) && biome !== 'mountain' && biome !== 'volcanic'
                     && biome !== 'tundra' && biome !== 'snow') {
            // Vegetation response to the living biosphere. Kept gentle and gated
            // on the cell's own fertility so the underlying biomes (desert,
            // savanna, tundra, snow, mountain) still read instead of the whole
            // continent turning one flat green.
            const veg = clamp01(cell.lifeDensity * 0.45 + lush * 0.30)
                      * clamp01(cell.fertility * 1.6) * 0.6;
            br = mix(br, br * 0.78, veg);
            bg2 = mix(bg2, Math.min(255, bg2 * 1.10 + 10), veg);
            bb = mix(bb, bb * 0.80, veg);
          }

          // Shallow-water depth ramp so coasts fade instead of banding.
          if (isWater(biome)) {
            const depth = clamp01((SEA_LEVEL - elev) / 0.20);
            br = mix(br * 1.55, br * 0.55, depth);
            bg2 = mix(bg2 * 1.35, bg2 * 0.60, depth);
            bb = mix(bb * 1.12, bb * 0.80, depth);
          } else if (cell.river > 0 && this.planetType !== 'lava') {
            const fp = this.discToGridF(dx, dy);
            const fr = fp ? fp.row - gp.row + 0.5 : 0.5;
            const fc = fp ? fp.col - gp.col : 0.5;
            const strength = riverStrength(cell.river);
            if (inRiverChannel(fr, fc, cell.riverDir, strength >= 1)) {
              const tinted = tintRiver(br, bg2, bb, strength);
              br = tinted[0]; bg2 = tinted[1]; bb = tinted[2];
              if (riverIsFall(cell.river)) {
                fall = true;
                br = Math.min(255, br * 0.55 + 150);
                bg2 = Math.min(255, bg2 * 0.45 + 190);
                bb = Math.min(255, bb * 0.35 + 230);
              }
            }
          }

          // Relief shading from the elevation gradient (light from upper-right).
          const cE = grid[gp.row]?.[(gp.col + 2) % GRID_SIZE];
          const cN = grid[Math.max(0, gp.row - 2)]?.[gp.col];
          const slope = ((cell.elevation - (cE?.elevation ?? cell.elevation)) * 0.7
                       + (cell.elevation - (cN?.elevation ?? cell.elevation)) * 0.5);
          const relief = 1 + clamp01(slope * 6 + 0.5) * 0.44 - 0.22;

          // Global key light + ambient occlusion toward the rim.
          const key = 0.80 + 0.34 * clamp01(dx * 0.8 - dy * 0.5 + 0.5);
          const ao  = 1 - Math.pow(clamp01((r - 0.62) / 0.38), 2) * 0.42;
          const grain = 0.955 + hash1(px * 911 + py * 31, seed) * 0.09;

          const f = relief * key * ao * grain;
          cr = br * f; cg = bg2 * f; cb = bb * f;

          // Surf line at the disc rim — only where there is actually surf.
          if (r > 0.955 && this.planetType !== 'lava') {
            const t = (r - 0.955) / 0.045;
            cr = mix(cr, 235, t * 0.75);
            cg = mix(cg, 246, t * 0.75);
            cb = mix(cb, 255, t * 0.75);
          }

          lift = this.liftOf(this.smoothElevation(grid, gp.row, gp.col) - this.rimFalloff(r));
          cellId = gp.row * GRID_SIZE + gp.col + 1;
        }

        // Raised ground: the lit surface is drawn at its displaced height and the
        // whole column beneath it is filled down to the point it belongs to.
        //
        // Filling the FULL column matters. Painting only the step up from the row
        // behind leaves descending slopes unfilled, and since this layer is
        // transparent those gaps show deep space through the middle of the
        // continent. Rows are walked far → near, so a nearer column overwrites
        // the one behind it and the only wall left standing is the cliff that
        // genuinely faces the camera.
        const top = py - lift;
        if (lift > 0) {
          const wallShade = 0.62 + hash1(px * 37 + py * 613, seed) * 0.08;
          const fallReach = Math.max(3, Math.round(lift * 0.85));
          for (let k = 1; k <= lift; k++) {
            // A channel that drops a terrace paints water down the cliff
            // instead of rock. The head is the white lip; the rest is the fall.
            if (fall && k <= fallReach) {
              const head = k <= 2;
              put(px, top + k,
                  head ? 240 : 64 + (1 - k / fallReach) * 40,
                  head ? 250 : 156 + (1 - k / fallReach) * 30,
                  head ? 255 : 214,
                  cellId);
              continue;
            }
            // Down the face, blend toward the crust's own top stratum so the
            // extrusion looks like the same rock the underside is made of, and
            // darken with depth for a soft occlusion at the foot of the cliff.
            const t = k / lift;
            const ao2 = 1 - t * 0.34;
            put(px, top + k,
                mix(cr * wallShade, strataTop.r * 0.88, t * 0.72) * ao2,
                mix(cg * wallShade, strataTop.g * 0.88, t * 0.72) * ao2,
                mix(cb * wallShade, strataTop.b * 0.88, t * 0.72) * ao2,
                cellId);
          }
          // A bright lip along the crest catches the key light.
          put(px, top, Math.min(255, cr * 1.12 + 9),
                       Math.min(255, cg * 1.12 + 9),
                       Math.min(255, cb * 1.12 + 9), cellId);
        } else {
          put(px, top, cr, cg, cb, cellId);
        }
      }
    }

    g.putImageData(img, x0, yTop);

    // Coastal foam: a second pass that outlines land against water.
    if (grid && this.planetType !== 'lava') {
      g.save();
      g.beginPath();
      g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      g.clip();
      g.fillStyle = 'rgba(226,244,255,0.30)';
      for (let py = y0; py <= y1; py++) {
        const dy = (py - cy) / ry;
        for (let px = x0; px <= x1; px++) {
          const dx = (px - cx) / rx;
          const r = Math.hypot(dx, dy);
          if (r > 1) continue;
          const gp = this.discToGrid(dx, dy);
          if (!gp) continue;
          const cell = grid[gp.row]?.[gp.col];
          if (!cell) continue;
          const here = cell.elevation - this.rimFalloff(r);
          if (here < SEA_LEVEL - 0.012 || here > SEA_LEVEL + 0.020) continue;
          g.fillRect(px, py, 1, 1);
        }
      }
      g.restore();
    }

    // Molten worlds get a few incandescent lava lakes over the basalt.
    if (this.planetType === 'lava') {
      const s = new Stream(seed ^ 0x2f9a);
      g.save();
      g.beginPath();
      g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      g.clip();
      for (let i = 0; i < 7; i++) {
        const a = s.range(0, Math.PI * 2);
        const rad = Math.sqrt(s.range(0, 0.82));
        const lx = cx + Math.cos(a) * rx * rad;
        const ly = cy + Math.sin(a) * ry * rad;
        const lr = s.range(rx * 0.05, rx * 0.15);
        const lake = g.createRadialGradient(lx, ly, 0, lx, ly, lr);
        lake.addColorStop(0, 'rgba(255,246,190,0.95)');
        lake.addColorStop(0.35, 'rgba(255,150,40,0.85)');
        lake.addColorStop(1, 'rgba(150,40,10,0)');
        g.fillStyle = lake;
        ellipse(g, lx, ly, lr, lr * 0.34);
      }
      g.restore();
    }
  }

  /**
   * A whole gas giant: turbulent latitude bands on a lit sphere, a great storm,
   * polar hoods and a ring system. Baked once, like the other static layers.
   */
  private bakeGasGiant(g: CanvasRenderingContext2D): void {
    const { VW, VH, cx } = this;
    const cyG = Math.round(VH * 0.50);
    const R = this.gasR;
    const seed = this.planetSeed;
    const s = new Stream(seed ^ 0x6a09e667);

    // Per-world band palette so no two gas giants look alike. Values stay
    // high so belts still read after limb darkening — a dim palette plus a
    // 0.72 terminator wash used to paint the whole sphere nearly black.
    const hueBase = s.range(0, 360);
    const bandCount = 8 + s.int(0, 4);
    const bands: RGB[] = [];
    for (let i = 0; i < bandCount; i++) {
      const warm = s.next() > 0.38;
      const hue = (hueBase + (warm ? s.range(-22, 22) : s.range(150, 220))) % 360;
      const sat = warm ? s.range(0.48, 0.78) : s.range(0.32, 0.58);
      const val = warm ? s.range(0.72, 0.96) : s.range(0.58, 0.82);
      bands.push(hsvToRGB(hue, sat, val));
    }
    let sumR = 0, sumG = 0, sumB = 0;
    for (const c of bands) { sumR += c.r; sumG += c.g; sumB += c.b; }
    const n = Math.max(1, bands.length);
    this.gasHalo = {
      r: Math.round(sumR / n), g: Math.round(sumG / n), b: Math.round(sumB / n),
    };

    // ── Ring: the half behind the planet, drawn before the body ──────────────
    const hasRing = ((seed >>> 5) & 3) !== 0;  // ~75% of gas giants
    const ringInner = R * 1.28, ringOuter = R * 1.92, ringRy = 0.20;
    const drawRing = (back: boolean) => {
      if (!hasRing) return;
      g.save();
      g.beginPath();
      g.rect(0, back ? 0 : cyG, VW, back ? cyG : VH - cyG);
      g.clip();
      for (let rr = ringInner; rr < ringOuter; rr += 1) {
        const t = (rr - ringInner) / (ringOuter - ringInner);
        // Cassini-style gaps
        const gap = fbm1(t * 9, seed + 21, 3);
        const a = (0.14 + gap * 0.42) * (1 - Math.abs(t - 0.45) * 0.85);
        if (a <= 0.01) continue;
        const c = bands[Math.floor(t * bands.length) % bands.length];
        g.strokeStyle = css(shade(c, 1.25), a);
        g.lineWidth = 1;
        g.beginPath();
        g.ellipse(cx, cyG, rr, rr * ringRy, -0.12, 0, Math.PI * 2);
        g.stroke();
      }
      g.restore();
    };
    drawRing(true);

    // ── Body ─────────────────────────────────────────────────────────────────
    const x0 = Math.max(0, cx - R), x1 = Math.min(VW - 1, cx + R);
    const y0 = Math.max(0, cyG - R), y1 = Math.min(VH - 1, cyG + R);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w <= 0 || h <= 0) return;

    const img = g.getImageData(x0, y0, w, h);
    const d = img.data;

    for (let py = y0; py <= y1; py++) {
      const dy = (py - cyG) / R;
      for (let px = x0; px <= x1; px++) {
        const dx = (px - cx) / R;
        const rr = dx * dx + dy * dy;
        if (rr > 1) continue;

        // Sphere normal → latitude, so bands compress toward the poles.
        const dz = Math.sqrt(1 - rr);
        const lat = Math.asin(Math.max(-1, Math.min(1, dy)));
        const latN = lat / (Math.PI / 2);                    // −1 … 1

        // Zonal turbulence: enough shear to look like weather, not enough
        // to smear the belts into a muddy gradient.
        const turb = fbm1(latN * 7.5 + dx * 1.6, seed + 3, 4) * 0.28
                   + fbm1(latN * 22 + dx * 4.0, seed + 91, 3) * 0.10;
        const bandF = (latN * 0.5 + 0.5) * bandCount + (turb - 0.38) * 0.55;
        const i0 = Math.max(0, Math.min(bandCount - 1, Math.floor(bandF)));
        const i1 = Math.max(0, Math.min(bandCount - 1, i0 + 1));
        const ft0 = bandF - Math.floor(bandF);
        // Hard belt edges — blend only a sliver so neighbouring colours stay distinct.
        const ft = ft0 < 0.16 ? 0 : ft0 > 0.84 ? 1 : 0.5;
        const c0 = bands[i0], c1 = bands[i1];
        const curl = 0.96 + fbm1(latN * 60 + dx * 9, seed + 707, 2) * 0.10;
        let cr = mix(c0.r, c1.r, ft) * curl;
        let cg = mix(c0.g, c1.g, ft) * curl;
        let cb = mix(c0.b, c1.b, ft) * curl;
        if (ft0 < 0.08) {
          cr *= 0.72; cg *= 0.72; cb *= 0.72;
        }

        // Lighting stays above a floor so the night side still shows belts.
        const lambert = clamp01(-dx * 0.50 - dy * 0.28 + dz * 0.70);
        const limb = Math.pow(Math.max(0.15, dz), 0.18);
        const f = (0.58 + lambert * 0.50) * limb;

        const polar = Math.pow(Math.abs(latN), 6) * 0.22;
        cr = mix(cr * f, 220, polar);
        cg = mix(cg * f, 228, polar);
        cb = mix(cb * f, 240, polar);

        const idx = ((py - y0) * w + (px - x0)) * 4;
        d[idx]     = Math.max(0, Math.min(255, cr));
        d[idx + 1] = Math.max(0, Math.min(255, cg));
        d[idx + 2] = Math.max(0, Math.min(255, cb));
        d[idx + 3] = 255;
      }
    }
    g.putImageData(img, x0, y0);

    // ── Great storm ──────────────────────────────────────────────────────────
    g.save();
    g.beginPath();
    g.arc(cx, cyG, R, 0, Math.PI * 2);
    g.clip();

    const stormLat = s.range(-0.35, 0.35);
    const sx = cx + s.range(-R * 0.28, R * 0.42);
    const sy = cyG + stormLat * R;
    const sr = R * s.range(0.18, 0.28);
    const stormC = s.next() > 0.45
      ? hsvToRGB((hueBase + s.range(-8, 12) + 360) % 360, 0.72, 0.95)
      : shade(bands[s.int(0, bands.length - 1)], 1.35);
    for (let i = 6; i >= 1; i--) {
      g.fillStyle = css(shade(stormC, 0.55 + i * 0.12), 0.72);
      ellipse(g, sx, sy, sr * (i / 6), sr * (i / 6) * 0.42);
    }
    g.fillStyle = css(shade(stormC, 0.35), 0.55);
    ellipse(g, sx - sr * 0.12, sy, sr * 0.28, sr * 0.16);
    g.strokeStyle = css(shade(stormC, 1.55), 0.85);
    g.lineWidth = 1;
    g.beginPath();
    g.ellipse(sx, sy, sr, sr * 0.42, 0, 0, Math.PI * 2);
    g.stroke();

    // Soft terminator — a hint of night, not a black wash over the body.
    const term = g.createRadialGradient(
      cx - R * 0.55, cyG - R * 0.30, R * 0.15,
      cx - R * 0.55, cyG - R * 0.30, R * 1.65,
    );
    term.addColorStop(0, 'rgba(0,0,0,0)');
    term.addColorStop(0.55, 'rgba(8,4,18,0.06)');
    term.addColorStop(1, 'rgba(8,4,18,0.22)');
    g.fillStyle = term;
    g.fillRect(cx - R, cyG - R, R * 2, R * 2);
    g.restore();

    // Atmospheric limb glow
    const glow = g.createRadialGradient(cx, cyG, R * 0.90, cx, cyG, R * 1.22);
    glow.addColorStop(0, css(this.gasHalo, 0));
    glow.addColorStop(0.38, css(this.gasHalo, 0.42));
    glow.addColorStop(1, css(this.gasHalo, 0));
    g.fillStyle = glow;
    g.fillRect(cx - R * 1.2, cyG - R * 1.2, R * 2.4, R * 2.4);

    // ── Ring: the half in front ──────────────────────────────────────────────
    drawRing(false);
  }

  // ─── Prop construction ─────────────────────────────────────────────────────

  /**
   * Is this world bathed in nebula light?
   *
   * Derived from the star's position rather than stored: the background already
   * paints a nebula band across the middle of the universe disc, so a world near
   * the galactic plane is the one that should show it in its sky.
   */
  private inNebula(): boolean {
    const st = this.star;
    if (!st) return false;
    const d = Math.hypot(st.x, st.y);
    return Math.abs(st.y) < 260 && d > 40;
  }

  /**
   * Plan the outlying city lights. Placement samples a screen lattice, so it
   * runs on the BASE geometry only and stores base-world px (spec 3): a camera
   * change never re-plans. `geom` exists for zoomCheck's control (re-planning
   * on a camera's geometry, the pre-Task-6 behaviour); the game never passes it.
   */
  /** True while the shown world is still walking its formation ladder. */
  private get forming(): boolean {
    return !!this.star?.formationDestiny;
  }

  private buildCityDots(geom = this.placeGeom): void {
    this.cityDots = [];
    const grid = this.grid;
    if (!grid || this.planetType === 'gas' || this.forming) return;

    const { cx, cy, rx, ry } = geom;
    const s = new Stream(this.planetSeed ^ 0x1b873593);
    const MAX = 55;   // settlements carry the main read; these are outlying lights
    const step = 2;

    const candidates: Array<{ x: number; y: number; row: number; col: number }> = [];
    for (let py = cy - ry; py <= cy + ry; py += step) {
      const dy = (py - cy) / ry;
      for (let px = cx - rx; px <= cx + rx; px += step) {
        const dx = (px - cx) / rx;
        if (dx * dx + dy * dy > 0.98) continue;
        const gp = this.discToGrid(dx, dy);
        if (!gp) continue;
        const cell = grid[gp.row]?.[gp.col];
        if (!cell || cell.civId == null) continue;
        const rr = Math.hypot(dx, dy);
        if (cell.elevation - this.rimFalloff(rr) < SEA_LEVEL) continue;
        // Sit the light on the raised terrain, not inside it.
        candidates.push({ x: px, y: py - this.liftAtCell(cell, rr), row: gp.row, col: gp.col });
      }
    }

    // Thin out to a readable scatter rather than a solid blanket of dots.
    const stride = Math.max(1, Math.ceil(candidates.length / MAX));
    for (let i = 0; i < candidates.length; i += stride) {
      const c = candidates[i];
      this.cityDots.push({
        wx: c.x, wy: c.y, row: c.row, col: c.col,
        phase: s.range(0, Math.PI * 2),
        rate:  s.range(0.5, 2.2),
      });
    }
  }

  /** Geometry the next bake lays out (the engine's, once it has baked at this size). */
  private geomForBake(): { cx: number; cy: number; rx: number; ry: number } {
    const g = habitableGeom(this.VW, this.VH);
    return { cx: g.cx, cy: g.cyTop, rx: g.rx, ry: g.ry };
  }

  /** Lift (px) of the drawn ground at a base-world face point. */
  private liftAtFace(x: number, y: number, geom = this.placeGeom): number {
    const grid = this.grid;
    if (!grid) return 0;
    const dx = (x - geom.cx) / geom.rx, dy = (y - geom.cy) / geom.ry;
    const r = Math.hypot(dx, dy);
    const e = this.elevationAt(grid, dx, dy);
    if (e === null) return 0;
    return this.liftOf(e - this.rimFalloff(r));
  }

  /**
   * Plan towns, buildings, fields and roads from the civilisation's territory
   * (cells with a civId). Kept while nothing it depends on changes, so towns
   * stay put; a town site is chosen greedily by score, so a growing territory
   * adds towns rather than moving them.
   */
  private planTowns(geom = this.placeGeom): void {
    const grid = this.grid;
    const civLevel = this.star?.civLevel ?? 0;
    if (!grid || this.planetType === 'gas' || this.forming) {
      if (this.townPlan.towns.length) { this.townPlan = emptyPlan(); this.townLift = []; this.townSig = ''; this.townVersion++; }
      return;
    }
    const { cx, cy, rx, ry } = geom;
    const step = 3;
    const land = new Set<string>();
    const key = (px: number, py: number) => `${Math.round(px / step)},${Math.round(py / step)}`;
    const spots: Array<{ x: number; y: number; row: number; col: number; fertility: number }> = [];
    for (let py = cy - ry; py <= cy + ry; py += step) {
      const dy = (py - cy) / ry;
      for (let px = cx - rx; px <= cx + rx; px += step) {
        const dx = (px - cx) / rx;
        const r = Math.hypot(dx, dy);
        if (r > 0.97) continue;
        const gp = this.discToGrid(dx, dy);
        if (!gp) continue;
        const cell = grid[gp.row]?.[gp.col];
        if (!cell) continue;
        if (cell.elevation - this.rimFalloff(r) < SEA_LEVEL) continue;
        land.add(key(px, py));
        if (cell.civId != null) spots.push({ x: px, y: py, row: gp.row, col: gp.col, fertility: cell.fertility });
      }
    }
    const intelligent = this.species.find(sp => !sp.isExtinct && sp.dna.intelligence >= 3) ?? null;
    const env = intelligent?.dna.environment ?? 'land';
    const aquatic = env === 'ocean' || env === 'deep_sea';
    // How this civilisation builds: its body, habitat, ways and world, plus
    // a seeded wildcard (Architecture.ts). Rolled from the species and the
    // planet, so it stays the same through the eras.
    const sp = intelligent;
    const arch: ArchGenome | undefined = sp ? archGenome({
      bodyStructure: sp.physicalTraits.bodyStructure, environment: sp.dna.environment, locomotion: sp.dna.locomotion,
      metabolism: sp.dna.metabolism, social: sp.dna.social, size: sp.physicalTraits.size,
      planetType: this.planetType, seed: this.planetSeed ^ hashStr(sp.id),
    }) : undefined;
    this.townArch = arch ?? null;
    const sig = [spots.length, eraOf(civLevel), Math.round(cx), Math.round(cy), Math.round(rx), Math.round(ry), env,
      intelligent?.physicalTraits.bodyStructure ?? '', this.planetSeed, arch?.summary ?? ''].join('|');
    if (sig === this.townSig) return;
    // Keep the outgoing town standing; anything the new plan does not reuse
    // is torn down in the same outward wave its replacements go up in.
    const oldPlan = this.townPlan, oldLift = this.townLift, oldStyle = this.townStyleOf, oldKeys = [...this.bornByKey.keys()];
    this.townSig = sig;
    this.townVersion++;
    this.buildingSprites.clear();
    if (spots.length === 0) { this.townPlan = emptyPlan(); this.townLift = []; this.buildingBorn = []; this.townPlanet = this.planet; this.pushTownProps(); return; }

    // Inland depth: lattice steps to the nearest water or the rim.
    const coast = (px: number, py: number): number => {
      for (let rad = 0; rad < 24; rad++) {
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2;
          const sx = px + Math.cos(ang) * rad * step, sy = py + Math.sin(ang) * rad * step;
          const dx = (sx - cx) / rx, dy = (sy - cy) / ry;
          if (dx * dx + dy * dy > 0.94 || !land.has(key(sx, sy))) return rad;
        }
      }
      return 24;
    };
    const byCell = new Map<string, { x: number; y: number; score: number }>();
    for (const sp of spots) {
      const inland = Math.min(1, coast(sp.x, sp.y) / 6);
      // A small hash breaks ties so the order never depends on scan order.
      const score = sp.fertility * (0.2 + 0.8 * inland) + ((sp.row * 73 + sp.col * 151) % 97) * 1e-5;
      const k2 = `${sp.row},${sp.col}`;
      const prev = byCell.get(k2);
      if (!prev || score > prev.score) byCell.set(k2, { x: sp.x, y: sp.y, score });
    }
    const ranked = [...byCell.values()].sort((a, b) => b.score - a.score);
    const era = eraOf(civLevel);
    const maxTowns = Math.min(13, 3 + era * 2);
    const minD = Math.max(rx * 0.15, 26);
    const sites: Array<{ x: number; y: number }> = [];
    for (const c of ranked) {
      if (sites.length >= maxTowns) break;
      if (sites.some(s => Math.hypot(s.x - c.x, (s.y - c.y) / SQUASH) < minD)) continue;
      sites.push({ x: c.x, y: c.y });
    }
    const isLand = (x: number, y: number) => {
      const dx = (x - cx) / rx, dy = (y - cy) / ry, r = Math.hypot(dx, dy);
      if (r > 0.95) return false;
      const gp = this.discToGrid(dx, dy);
      const cell = gp ? grid[gp.row]?.[gp.col] : null;
      if (!cell) return false;
      const e = this.elevationAt(grid, dx, dy) ?? cell.elevation;
      if (e - this.rimFalloff(r) < SEA_LEVEL + 0.004) return false;
      return cell.biome !== 'snow' && cell.biome !== 'volcanic';
    };
    const fertileAt = (x: number, y: number) => {
      if (!isLand(x, y)) return 0;
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      const gp = this.discToGrid(dx, dy);
      const cell = gp ? grid[gp.row]?.[gp.col] : null;
      if (!cell || cell.biome === 'mountain' || cell.biome === 'tundra' || cell.biome === 'beach') return 0;
      if (cell.biome === 'desert') return era >= 3 ? 0.3 : 0;
      return Math.max(0.2, cell.fertility);
    };
    this.townPlan = planSettlements({
      sites, civLevel, seed: this.planetSeed, rx, isLand, fertileAt, aquatic,
      aggression: intelligent?.dna.aggression ?? 3, arch,
    });
    this.townLift = this.townPlan.buildings.map(b => this.liftAtFace(b.x, b.y, geom));
    // Construction: buildings new to this planet's plan go up over time,
    // staggered so a town grows outward from its first houses.
    const fresh = this.townPlanet !== this.planet;
    this.townPlanet = this.planet;
    const born = new Map<string, number>();
    this.buildingBorn = this.townPlan.buildings.map(b => {
      const t = this.townPlan.towns[b.town];
      const k = `${Math.round(t.x)},${Math.round(t.y)}|${Math.round(b.x * 2)},${Math.round(b.y * 2)}|${b.kind}`;
      const prev = this.bornByKey.get(k);
      const d = Math.hypot(b.x - t.x, (b.y - t.y) / SQUASH) / Math.max(1, t.r);
      const at = prev ?? (fresh ? -Infinity : this.elapsed + d * BUILD_SPREAD + ((b.seed >>> 3) % 1000) / 1000 * 4);
      born.set(k, at);
      return at;
    });
    this.bornByKey = born;
    this.retired = fresh ? [] : this.retired.filter(r => r.until > this.elapsed);
    if (!fresh && oldStyle) {
      oldPlan.buildings.forEach((b, i) => {
        if (born.has(oldKeys[i] ?? '')) return;
        const t = oldPlan.towns[b.town];
        const d = Math.hypot(b.x - t.x, (b.y - t.y) / SQUASH) / Math.max(1, t.r);
        this.retired.push({ b, lift: oldLift[i] ?? 0, st: oldStyle, until: this.elapsed + d * BUILD_SPREAD + 2, sprites: new Map() });
      });
    }
    this.townStyleOf = townStyle(this.townPlan.era, intelligent?.physicalTraits.bodyStructure ?? 'vertebrate', arch);
    this.pushTownProps();
  }

  /**
   * Hand the towns' buildings (standing, going up, and outgoing ones still
   * standing) to the flora layer, which draws them in its back-to-front pass
   * with the trees. Each draws itself through the layer's view at that
   * view's scale; construction progress is read when drawn.
   */
  private pushTownProps(): void {
    const flora = this.cutaway.flora;
    const list: Array<{ wy: number; draw: (g: CanvasRenderingContext2D, v: import('./FloraLayer').FloraView) => void }> = [];
    const at = (v: import('./FloraLayer').FloraView, x: number, y: number) =>
      [(x - v.fx) * v.K + v.W / 2, (y - v.fy) * v.K + v.H / 2 + v.bob] as const;
    this.townPlan.buildings.forEach((b, i) => {
      const wy = b.y - (this.townLift[i] ?? 0);
      list.push({ wy, draw: (g, v) => {
        const t0 = this.buildingBorn[i] ?? -Infinity;
        const p = t0 === -Infinity ? 1 : (this.elapsed - t0) / BUILD_SECONDS;
        if (p < 0) return;
        const S = Math.max(1, Math.round(v.K));
        const spr = p >= 1 ? this.buildingSprite(i, S) : this.constructionSprite(i, S, p);
        if (!spr) return;
        const [X, Y] = at(v, b.x, wy);
        g.drawImage(spr.cv, Math.round(X - spr.fx), Math.round(Y - spr.fy));
      } });
    });
    for (const r of this.retired) {
      const wy = r.b.y - r.lift;
      list.push({ wy, draw: (g, v) => {
        if (r.until <= this.elapsed) return;
        const S = Math.max(1, Math.round(v.K));
        let spr = r.sprites.get(S);
        if (!spr) {
          const f = paintBuilding(r.b, S, r.st);
          const cv = document.createElement('canvas');
          cv.width = f.width; cv.height = f.height;
          const cg = cv.getContext('2d');
          if (cg) { const img = cg.createImageData(f.width, f.height); img.data.set(f.data); cg.putImageData(img, 0, 0); }
          spr = { cv, fx: f.footX, fy: f.footY };
          r.sprites.set(S, spr);
        }
        const [X, Y] = at(v, r.b.x, wy);
        g.drawImage(spr.cv, Math.round(X - spr.fx), Math.round(Y - spr.fy));
      } });
    }
    flora.setProps(list);
  }

  /** Building `i` under construction, `p` of the way (12 cached steps). */
  private constructionSprite(i: number, S: number, p: number): { cv: HTMLCanvasElement; fx: number; fy: number } | null {
    const step = Math.min(11, Math.floor(p * 12));
    const k = `${i}|${S}|c${step}`;
    const hit = this.buildingSprites.get(k);
    if (hit) return hit;
    const st = this.townStyleOf;
    if (!st) return null;
    const f = paintConstruction(this.townPlan.buildings[i], S, st, (step + 0.5) / 12);
    const cv = document.createElement('canvas');
    cv.width = f.width; cv.height = f.height;
    const cg = cv.getContext('2d');
    if (cg) {
      const img = cg.createImageData(f.width, f.height);
      img.data.set(f.data);
      cg.putImageData(img, 0, 0);
    }
    const e = { cv, fx: f.footX, fy: f.footY };
    if (this.buildingSprites.size > 3000) this.buildingSprites.clear();
    this.buildingSprites.set(k, e);
    return e;
  }

  /** The sprite of building `i` at camera scale S (cached per plan and scale). */
  private buildingSprite(i: number, S: number): { cv: HTMLCanvasElement; fx: number; fy: number } | null {
    const k = `${i}|${S}`;
    const hit = this.buildingSprites.get(k);
    if (hit) return hit;
    const st = this.townStyleOf;
    if (!st) return null;
    const f = paintBuilding(this.townPlan.buildings[i], S, st);
    const cv = document.createElement('canvas');
    cv.width = f.width; cv.height = f.height;
    const cg = cv.getContext('2d');
    if (cg) {
      const img = cg.createImageData(f.width, f.height);
      img.data.set(f.data);
      cg.putImageData(img, 0, 0);
    }
    const e = { cv, fx: f.footX, fy: f.footY };
    if (this.buildingSprites.size > 3000) this.buildingSprites.clear();
    this.buildingSprites.set(k, e);
    return e;
  }

  /**
   * The towns' buildings, standing on the lifted ground, back to front.
   * Rendered into one canvas per view and blitted every other frame.
   */
  private drawBuildings(g: CanvasRenderingContext2D): void {
    const bs = this.townPlan.buildings;
    if (bs.length === 0) return;
    const c = this.cutaway.activeCamera, bob = this.habitable ? Math.round(this.cutaway.drawGeom.bob) : 0;
    // While anything is being built, the layer re-renders a few times a
    // second so construction advances; otherwise only when the view changes.
    let building = this.retired.some(r => r.until > this.elapsed);
    for (const t0 of this.buildingBorn) if (t0 !== -Infinity && this.elapsed - t0 < BUILD_SECONDS) { building = true; break; }
    const tick = building ? Math.floor(this.elapsed * 4) : 0;
    const key = `${c.zoom}|${c.fx}|${c.fy}|${this.VW}|${this.VH}|${bob}|${this.townVersion}|${tick}`;
    if (!this.propsCanvas) this.propsCanvas = document.createElement('canvas');
    const pc = this.propsCanvas;
    if (key !== this.propsKey) {
      this.propsKey = key;
      if (pc.width !== this.VW || pc.height !== this.VH) { pc.width = this.VW; pc.height = this.VH; }
      const pg = pc.getContext('2d');
      if (!pg) return;
      pg.clearRect(0, 0, pc.width, pc.height);
      pg.imageSmoothingEnabled = false;
      const S = Math.max(1, Math.round(this.camZoom));
      // Outgoing buildings still standing (back to front), under the new ones.
      for (const r of this.retired) {
        if (r.until <= this.elapsed) continue;
        let spr = r.sprites.get(S);
        if (!spr) {
          const f = paintBuilding(r.b, S, r.st);
          const cv = document.createElement('canvas');
          cv.width = f.width; cv.height = f.height;
          const cg = cv.getContext('2d');
          if (cg) { const img = cg.createImageData(f.width, f.height); img.data.set(f.data); cg.putImageData(img, 0, 0); }
          spr = { cv, fx: f.footX, fy: f.footY };
          r.sprites.set(S, spr);
        }
        const sx = this.wsx(r.b.x), sy = this.wsy(r.b.y - r.lift) + bob;
        pg.drawImage(spr.cv, Math.round(sx - spr.fx), Math.round(sy - spr.fy));
      }
      for (let i = 0; i < bs.length; i++) {
        const b = bs[i];
        const sx = this.wsx(b.x), sy = this.wsy(b.y - (this.townLift[i] ?? 0)) + bob;
        const reach = (b.h + b.w) * S * 2 + 8;
        if (sx < -reach || sx > this.VW + reach || sy < -8 || sy > this.VH + reach) continue;
        const t0 = this.buildingBorn[i] ?? -Infinity;
        const p = t0 === -Infinity ? 1 : (this.elapsed - t0) / BUILD_SECONDS;
        if (p < 0) continue;                       // not begun yet
        const spr = p >= 1 ? this.buildingSprite(i, S) : this.constructionSprite(i, S, p);
        if (!spr) continue;
        pg.drawImage(spr.cv, Math.round(sx - spr.fx), Math.round(sy - spr.fy));
      }
    }
    g.drawImage(pc, 0, 0);
  }

  /**
   * Populate the surface from the grid: creatures where life lives, settlements
   * where a civilisation has settled.
   *
   * Scatter positions come from the grid itself rather than being sprinkled at
   * random, so what the player sees is what the simulation actually holds —
   * a species only appears where `dominantSpeciesId` says it lives.
   */
  /**
   * Plan creatures and settlements on the BASE geometry, stored in base-world
   * px + cell (spec 3; see `buildCityDots` for `geom`). Sprites are baked at
   * their identity on-screen size; a camera blits them x round(k).
   */
  private buildInhabitants(geom = this.placeGeom): void {
    this.inhabitants = [];
    this.settlements = [];

    const grid = this.grid;
    if (!grid || this.planetType === 'gas') return;

    // Microbial life is not visible at this scale; showing creatures then would
    // misrepresent the simulation.
    const phase = this.star?.biologyPhase;
    if (phase === 'microbial' || this.forming) return;

    const byId = new Map<string, SpeciesGenome>();
    for (const sp of this.species) byId.set(sp.id, sp);

    const { cx, cy, rx, ry } = geom;
    const s = new Stream(this.planetSeed ^ 0x5bf03635);

    // Deliberately sparse. The simulation marks almost every habitable cell as
    // inhabited, so drawing one sprite per qualifying cell tiled the whole
    // continent and read as wallpaper rather than as a living world.
    const MAX_CREATURES = 42;
    const MAX_SETTLEMENTS = 13;

    // On-screen size lives in SpeciesSprite.dioramaCreatureSprite (size class x
    // phase x depth); the sprite is baked at exactly that size and blitted 1:1.

    const creatureSpots: Array<{ x: number; y: number; row: number; col: number; id: string; onWater: boolean }> = [];
    const settlementSpots: Array<{
      x: number; y: number; sx: number; sy: number;
      fertility: number; row: number; col: number;
    }> = [];
    // Coarse land mask for the disc sample lattice — used to score how far a
    // town sits from the *visual* coastline (elev − rimFalloff), not grid water.
    // Fertility alone prefers moist shelves that hug that coastline, so towns
    // never read as sitting in the middle of a landmass.
    const step = 3;
    const landKeys = new Set<string>();
    const sampleKey = (px: number, py: number) =>
      `${Math.round(px / step)},${Math.round(py / step)}`;
    for (let py = cy - ry; py <= cy + ry; py += step) {
      const dy = (py - cy) / ry;
      for (let px = cx - rx; px <= cx + rx; px += step) {
        const dx = (px - cx) / rx;
        const r = Math.hypot(dx, dy);
        if (r > 0.97) continue;

        const gp = this.discToGrid(dx, dy);
        if (!gp) continue;
        const cell = grid[gp.row]?.[gp.col];
        if (!cell) continue;

        // Stand props ON the terrain: the surface is extruded by elevation now,
        // so an unlifted position buries a town inside the hill it sits on.
        const lift = this.liftAtCell(cell, r);
        const onLand = cell.elevation - this.rimFalloff(r) >= SEA_LEVEL;
        if (onLand) landKeys.add(sampleKey(px, py));
        if (cell.civId != null && onLand) {
          settlementSpots.push({
            x: px, y: py - lift, sx: px, sy: py,
            fertility: cell.fertility, row: gp.row, col: gp.col,
          });
        } else if (cell.dominantSpeciesId && cell.lifeDensity > 0.35) {
          // Test the elevation the SURFACE WAS DRAWN FROM, not the grid's own.
          // `rimFalloff` sinks the outer hemisphere so the projection reads as a
          // continent in an ocean, and the cells it sinks keep their land biome
          // and their life density — so a walking animal placed off the raw grid
          // ends up standing on open water, and the whole rim rings with
          // creatures wading in the sea.
          // Ask about HABITAT, not locomotion: kelp and reef are `stationary`
          // and sea-floor grazers `crawling`, and a locomotion test drew neither.
          // See inhabitsWater() in SpeciesGenome.ts.
          const occupant = byId.get(cell.dominantSpeciesId);
          if (this.habitable && !onLand && !(occupant && inhabitsWater(occupant))) continue;
          creatureSpots.push({
            x: px, y: py - lift, row: gp.row, col: gp.col, id: cell.dominantSpeciesId,
            onWater: this.habitable && !onLand,
          });
        }
      }
    }

    /**
     * Thin candidates to a spread-out subset.
     *
     * Taking the first N, or an evenly strided N, still leaves clumps because
     * the candidate list is in scan order. Rejecting anything within `minDist`
     * of an already-accepted point gives separated towns and scattered animals.
     */
    const scatter = <T extends { x: number; y: number }>(
      arr: T[], max: number, minDist: number,
    ): T[] => {
      const out: T[] = [];
      const d2 = minDist * minDist;
      // Walk in a shuffled order so the selection is not biased to the top-left.
      const order = arr.map((_, k) => k);
      for (let k = order.length - 1; k > 0; k--) {
        const j2 = Math.floor(s.next() * (k + 1));
        [order[k], order[j2]] = [order[j2], order[k]];
      }
      for (const k of order) {
        if (out.length >= max) break;
        const cand = arr[k];
        let ok = true;
        for (const got of out) {
          const ddx = got.x - cand.x, ddy = got.y - cand.y;
          if (ddx * ddx + ddy * ddy < d2) { ok = false; break; }
        }
        if (ok) out.push(cand);
      }
      return out;
    };

    for (const spot of scatter(creatureSpots, MAX_CREATURES, rx * 0.075)) {
      const genome = byId.get(spot.id);
      if (!genome) continue;
      // Perspective: things near the front of the disc read slightly larger.
      // The sprite is baked AT its on-screen size (size class x phase x depth)
      // and blitted 1:1 — resampling a bigger bake erased eyes, spines and
      // craniums, and is what tools/speciesSpriteCheck.ts caught.
      const depth = (spot.y - (cy - ry)) / (ry * 2);
      const sprite = dioramaCreatureSprite(genome, phase ?? 'intelligent', depth);
      this.inhabitants.push({
        wx: spot.x, wy: spot.y, row: spot.row, col: spot.col, sprite,
        w: sprite.width,
        h: sprite.height,
        phase: s.range(0, Math.PI * 2),
        sway: s.range(0.4, 1.5),
        depth,
        submersion: spot.onWater ? waterSubmersion(genome) : 0,
        genome,
      });
    }

    // Towns come from the settlement plan (planTowns, made before the bake so
    // their fields and roads are in the ground). The entries here are the
    // town centres; in the diorama their buildings are drawn by drawBuildings,
    // the legacy flat view still blits one small sprite per town.
    if (!this.habitable) this.planTowns(geom);
    const civLevel = this.star?.civLevel ?? 0;
    let idx = 0;
    const genome = this.species.find(sp => !sp.isExtinct && sp.dna.intelligence >= 3) ?? this.species[0] ?? null;
    for (const t of this.townPlan.towns) {
      const sprite = bakeSettlementSprite(genome, civLevel, idx++, 1);
      const ly = t.y - this.liftAtFace(t.x, t.y, geom);
      const depth = (ly - (cy - ry)) / (ry * 2);
      const target = (5 + Math.min(civLevel, 6) * 0.7) * (0.85 + depth * 0.3);
      const aspect = sprite.height / sprite.width;
      const gp = this.discToGrid((t.x - cx) / rx, (t.y - cy) / ry);
      this.settlements.push({
        wx: t.x, wy: ly, row: gp?.row ?? 0, col: gp?.col ?? 0, sprite,
        w: Math.max(3, target),
        h: Math.max(3, target * aspect),
        depth,
      });
    }
    void settlementSpots; void landKeys; void step;

    // Painter's algorithm — back of the disc first.
    this.inhabitants.sort((a, b) => a.depth - b.depth);
    this.settlements.sort((a, b) => a.depth - b.depth);
  }

  /** Blit creatures and settlements onto the top face. */
  /**
   * The CreatureForge sprite for an inhabitant drawn at camera scale `S`, or
   * null while it is too small to carry a body (or still waiting its turn to
   * bake: at most FORGE_BAKES_PER_FRAME new ones per frame, so zooming in on a
   * crowded world does not stall a frame).
   */
  private forgeSpriteFor(c: { w: number; h: number; genome: SpeciesGenome }, S: number): { cv: HTMLCanvasElement; foot: number } | null {
    // Sized from the species' nominal size, not the pixel sprite's box: the
    // speck's outline and minimum anatomy pad it, and a forged body filling
    // that box towered over trees and houses (play feedback).
    const nominal = (CREATURE_SIZE_PX[c.genome.physicalTraits.size] ?? 4) + 1;
    const target = Math.round(Math.min(Math.max(c.w, c.h), nominal) * S);
    if (target < FORGE_MIN_PX) return null;
    const gn = c.genome, d = gn.dna, p = gn.physicalTraits;
    const key = [gn.id, target, d.locomotion, d.metabolism, d.environment, d.diet, d.aggression, d.intelligence,
      p.size, p.bodyStructure, p.mobilityType, p.sensorySystem].join('|');
    const hit = this.forgeSprites.get(key);
    if (hit) return hit;
    if (this.forgeBudget <= 0) return null;
    this.forgeBudget--;
    // Small: the forge rendered straight at the target size (the portrait
    // path renders at least 16 px and would not shrink).
    let cv: HTMLCanvasElement;
    if (target < 16) {
      const f = forgeCreature(gn, target);
      cv = document.createElement('canvas');
      cv.width = f.width; cv.height = f.height;
      const g2 = cv.getContext('2d');
      if (g2) { const img = g2.createImageData(f.width, f.height); img.data.set(f.data); g2.putImageData(img, 0, 0); }
    } else {
      cv = bakeCreaturePortrait(gn, target);
    }
    // Transparent rows under the lowest opaque pixel: the feet sit on the anchor.
    let foot = 0;
    const cg = cv.getContext('2d');
    if (cg) {
      const data = cg.getImageData(0, 0, cv.width, cv.height).data;
      outer: for (let y = cv.height - 1; y >= 0; y--) {
        for (let x = 0; x < cv.width; x++) if (data[(y * cv.width + x) * 4 + 3] > 0) break outer;
        foot++;
      }
    }
    const entry = { cv, foot };
    if (this.forgeSprites.size > 400) this.forgeSprites.clear();
    this.forgeSprites.set(key, entry);
    return entry;
  }

  /**
   * Volcanoes as TERRAIN: pick vent sites on the visible face (highest land,
   * spaced apart), then raise a terraced cone into a copy of the grid so the
   * normal bake draws it — cliffs, terraces, lighting and all. Active cones
   * are fresh basalt with a crater; dormant ones dark rock up top; extinct
   * ones are worn hills that weather to the land around them (trees, snow).
   * The simulation's grid is never touched.
   */
  private ventedGrid(raw: PlanetGrid): PlanetGrid {
    const prof = this.habitable
      ? volcanoProfile(this.planetType, this.planetSeed, this.forming ? this.star?.formationStage ?? null : null)
      : null;
    const key = prof ? `${this.planetSeed}|${this.planetType}|${prof.count}|${prof.scale}|${prof.state}|${this.focusLat.toFixed(3)}|${this.focusLon.toFixed(3)}` : '';
    if (key !== this.ventKey) {
      this.ventKey = key;
      this.vents = prof ? this.planVents(raw, prof) : [];
    }
    if (this.vents.length === 0) return raw;
    const out = raw.slice();
    for (const v of this.vents) {
      const R = Math.ceil(v.R);
      for (let dr = -R; dr <= R; dr++) {
        const row = v.row + dr;
        if (row < 0 || row >= GRID_SIZE) continue;
        if (out[row] === raw[row]) out[row] = raw[row].slice();
        for (let dc = -R; dc <= R; dc++) {
          const col = (v.col + dc + GRID_SIZE) % GRID_SIZE;
          const d = Math.hypot(dr, dc) / v.R;
          if (d >= 1) continue;
          const cell = out[row][col];
          // Concave flanks, steeper near the top; a little noise breaks the
          // perfect circle into ridges.
          const jag = (hash01(row * 131 + col * 17, this.planetSeed) - 0.5) * 0.03;
          let e = v.base + (v.peak - v.base) * Math.pow(1 - d, 1.1) + jag * (1 - d);
          if (v.state !== 'extinct' && d < 0.1) e = v.peak - 0.06;   // crater
          if (e <= cell.elevation && d > 0.1) continue;
          const vent = v.state === 'active' && d < 0.95;
          out[row][col] = {
            ...cell, elevation: e,
            biome: vent ? 'volcanic' : cell.biome,
            fertility: vent ? 0 : cell.fertility,
          };
        }
      }
    }
    return out;
  }

  private planVents(grid: PlanetGrid, prof: VolcanoProfile): Vent[] {
    const cands: Array<{ row: number; col: number; score: number; dx: number; dy: number; e: number }> = [];
    for (let row = 0; row < GRID_SIZE; row += 2) {
      for (let col = 0; col < GRID_SIZE; col += 2) {
        const d = this.gridToDisc(row, col);
        if (!d) continue;
        const r = Math.hypot(d.dx, d.dy);
        if (r > 0.62 || r < 0.08 || d.dy < -0.4) continue;   // keep off the squashed back rim
        const cell = grid[row]?.[col];
        if (!cell || cell.elevation - this.rimFalloff(r) < SEA_LEVEL + 0.03) continue;
        cands.push({ row, col, dx: d.dx, dy: d.dy, e: cell.elevation, score: cell.elevation + hash01(row * 977 + col, this.planetSeed ^ 0x71) * 0.3 });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    const vents: Vent[] = [];
    const R = 12 * prof.scale * (prof.state === 'extinct' ? 1.2 : 1);
    const spacing = R / GRID_SIZE * 3;
    for (const c of cands) {
      if (vents.length >= prof.count) break;
      if (vents.some(v => Math.hypot(v.dx - c.dx, v.dy - c.dy) < spacing)) continue;
      const big = prof.state === 'extinct' ? 0.8 + prof.scale * 0.02 : 0.9 + prof.scale * 0.08;
      vents.push({ row: c.row, col: c.col, dx: c.dx, dy: c.dy, R, base: c.e, peak: Math.max(big, c.e + 0.12), state: prof.state, crater: null, flows: [] });
    }
    return vents;
  }

  /** Screen anchors (base world px) for the crater and the lava flows. */
  private placeVentFx(geom: { cx: number; cy: number; rx: number; ry: number }): void {
    const at = (row: number, col: number): { x: number; y: number } | null => {
      const d = this.gridToDisc(row, col);
      if (!d) return null;
      const x = geom.cx + d.dx * geom.rx, y = geom.cy + d.dy * geom.ry;
      return { x, y: y - this.liftAtFace(x, y, geom) };
    };
    for (const v of this.vents) {
      v.crater = at(v.row, v.col);
      v.flows = [];
      if (v.state !== 'active') continue;
      const n = 2 + Math.floor(hash01(v.row * 7 + v.col, this.planetSeed) * 3);
      for (let f = 0; f < n; f++) {
        // Down the FRONT half of the cone mostly, so the player sees them.
        const a = Math.PI * (0.15 + 0.7 * (f + hash01(f * 31 + v.row, this.planetSeed)) / n);
        const pts: Array<{ x: number; y: number }> = [];
        for (let t = 0.12; t < 1.15; t += 0.04) {
          const w = Math.sin(t * 9 + f * 2) * 0.12;
          const p = at(Math.round(v.row + Math.sin(a + w) * v.R * t), Math.round(v.col + Math.cos(a + w) * v.R * t));
          if (!p) continue;
          // Densify to one point per base pixel: a continuous ribbon of lava.
          const q = pts[pts.length - 1];
          const steps = q ? Math.floor(Math.hypot(p.x - q.x, p.y - q.y)) : 0;
          for (let i = 1; i < steps; i++) pts.push({ x: q.x + (p.x - q.x) * i / steps, y: q.y + (p.y - q.y) * i / steps });
          pts.push(p);
        }
        v.flows.push(pts);
      }
    }
  }

  /** Lava pulsing down the active flanks, crater glow, and smoke. */
  private drawVentFx(g: CanvasRenderingContext2D, t: number): void {
    if (!this.habitable || this.vents.length === 0) return;
    const k = this.camZoom, S = Math.max(1, Math.round(k));
    const bob = this.cutaway.drawGeom.bob;
    g.save();
    for (const v of this.vents) {
      const c = v.crater;
      if (!c) continue;
      const cx = this.wsx(c.x), cy = this.wsy(c.y + bob);
      if (v.state === 'active') {
        v.flows.forEach((pts, fi) => {
          const n = pts.length;
          for (let j = 0; j < n; j++) {
            const p = pts[j];
            // A hot pulse runs down each flow; the rest glows dull red and
            // cools (darker) towards the toe.
            const ph = ((t * 0.45 + fi * 0.37 - j / n) % 1 + 1) % 1;
            const cool = j / n;
            g.fillStyle = ph < 0.12 ? 'rgb(255,214,110)'
              : ph < 0.3 ? 'rgb(255,128,36)'
              : `rgb(${Math.round(210 - cool * 90)},${Math.round(60 - cool * 30)},${Math.round(20 - cool * 8)})`;
            g.fillRect(Math.round(this.wsx(p.x)), Math.round(this.wsy(p.y + bob)), S, S);
          }
        });
        const fl = Math.sin(t * 7 + v.row) > 0;
        g.fillStyle = fl ? 'rgb(255,190,80)' : 'rgb(255,140,40)';
        g.fillRect(Math.round(cx - S), Math.round(cy - S), 3 * S, 2 * S);
        g.fillStyle = 'rgb(255,236,160)';
        g.fillRect(Math.round(cx), Math.round(cy - S), S, S);
      }
      // Smoke: an active vent billows dark ash, a sleeping one breathes a
      // thin white wisp. Puffs rise, drift downwind, swell and fade.
      const puffs = v.state === 'active' ? 22 : v.state === 'dormant' ? 6 : 0;
      for (let i = 0; i < puffs; i++) {
        const age = ((t * (v.state === 'active' ? 0.22 : 0.12) + i / puffs) % 1);
        const px = cx + (Math.sin(age * 4 + i * 1.3) * 2 + age * 14) * k;
        const py = cy - (3 + age * (v.state === 'active' ? 34 : 18)) * k;
        const sz = Math.max(S, Math.round((1 + age * (v.state === 'active' ? 2.2 : 1.2)) * k));
        g.globalAlpha = (v.state === 'active' ? 0.7 : 0.35) * (1 - age);
        const gr = v.state === 'active' ? Math.round(70 + age * 80) : 225;
        g.fillStyle = `rgb(${gr},${gr - 4},${gr - 8})`;
        g.fillRect(Math.round(px - sz / 2), Math.round(py - sz / 2), sz, sz);
      }
      g.globalAlpha = 1;
    }
    g.restore();
  }

  /**
   * Small flocks wheeling over a living world once the camera is close
   * (they fade in from BIRD_ZOOM). Each flock flies a slow loop over the
   * disc in a loose V; every bird flaps on its own two-frame beat, 1 px x S.
   */
  private drawBirds(g: CanvasRenderingContext2D, t: number): void {
    if (!this.habitable || this.inhabitants.length === 0) return;
    const k = this.camZoom, fade = Math.min(1, (k - BIRD_ZOOM) / 0.6);
    if (fade <= 0) return;
    // BASE geometry: wsx / wsy apply the camera, so the active cx/cy/rx/ry
    // here would zoom twice and fling flocks off the disc into space.
    const { cx, cy, rx, ry } = this.placeGeom;
    const S = Math.max(1, Math.round(k));
    g.save();
    g.globalAlpha = 0.85 * fade;
    g.fillStyle = 'rgb(232,234,240)';
    const flocks = 3 + (this.planetSeed % 3);
    for (let f = 0; f < flocks; f++) {
      const h = ((this.planetSeed * 2654435761 + f * 40503) >>> 0) / 4294967296;
      const dir = f % 2 ? 1 : -1, speed = 0.035 + h * 0.03;
      const a = (h + f / flocks) * Math.PI * 2 + dir * t * speed;
      const lr = 0.2 + ((h * 7.31) % 1) * 0.55;
      const fx = cx + Math.cos(a) * rx * lr, fy = cy + Math.sin(a) * ry * lr - 6 - h * 6;
      // Heading along the loop, so the V points the way it flies.
      const hx = -Math.sin(a) * dir * rx, hy = Math.cos(a) * dir * ry, hl = Math.hypot(hx, hy) || 1;
      const ux = hx / hl, uy = hy / hl;
      const n = 3 + Math.floor(h * 4);
      for (let b = 0; b < n; b++) {
        const rank = Math.ceil(b / 2), side = b % 2 ? 1 : -1;
        const bx = fx - ux * rank * 5 + -uy * side * rank * 4 + Math.sin(t * 0.7 + b) * 0.8;
        const by = fy - uy * rank * 5 + ux * side * rank * 4 + Math.cos(t * 0.9 + b * 2) * 0.8;
        const sx = Math.round(this.wsx(bx)), sy = Math.round(this.wsy(by));
        const up = Math.sin(t * 9 + b * 1.7 + f) > 0;
        g.fillRect(sx, sy, S, S);
        g.fillRect(sx - S, sy - (up ? S : 0), S, S);
        g.fillRect(sx + S, sy - (up ? S : 0), S, S);
      }
    }
    g.restore();
  }

  private drawInhabitants(g: CanvasRenderingContext2D, t: number): void {
    if (this.inhabitants.length === 0 && this.settlements.length === 0) return;
    const { cx, cy, rx, ry } = this;
    const layerBob = this.habitable ? this.cutaway.drawGeom.bob : 0;

    const surf = this.habitable ? cutawayWaterSurf(this.planetType as HabitableType) : null;
    // Sprite class: positions through the camera, sprite pixels x round(k),
    // nearest-neighbour (the backbuffer has smoothing off). S = 1 at identity.
    const S = Math.max(1, Math.round(this.camZoom));

    // Clip to an *inflated* face: a tight ellipse sheared species/settlements
    // whose anchors sit near the rim (half the body fell outside the disc).
    // Pad ≈ half a typical sprite so overhang reads, without spilling into the
    // cutaway crust far below the front rim.
    let pad = 14 * S;
    for (const c of this.inhabitants) pad = Math.max(pad, Math.ceil(c.w * S * 0.55), Math.ceil(c.h * S * 0.55));
    for (const st of this.settlements) pad = Math.max(pad, Math.ceil(st.w * S * 0.55), Math.ceil(st.h * S * 0.55));
    g.save();
    g.beginPath();
    g.ellipse(cx, cy + layerBob, rx + pad, ry + pad, 0, 0, Math.PI * 2);
    g.clip();

    this.forgeBudget = FORGE_BAKES_PER_FRAME;
    for (const c of this.inhabitants) {
      // A small idle bob keeps the world alive without implying real movement.
      // The shared idle hop: one pixel (x S) up for the high half of the cycle.
      const bob = Math.sin((t / CREATURE_HOP_PERIOD) * Math.PI * 2 + c.phase) > 0.35 ? -S : 0;
      const ax = this.wsx(c.wx), ay = this.wsy(c.wy);
      // Big enough on screen to show a body: the 3D-built creature at its true
      // screen resolution instead of the speck magnified x S.
      const forged = this.forgeSpriteFor(c, S);
      const spr = forged ? forged.cv : c.sprite;
      const sw = forged ? forged.cv.width : Math.round(c.w) * S;
      const sh = forged ? forged.cv.height : Math.round(c.h) * S;
      const dx = Math.round(ax - sw / 2);
      const dy = Math.round(ay + layerBob - sh + (forged ? forged.foot : 0) + bob);

      if (c.submersion <= 0 || !surf) {
        g.drawImage(spr, dx, dy, sw, sh);
        continue;
      }

      // Sink the body so only the unsubmerged fraction clears the waterline,
      // then tint what is under. The tint is applied INSIDE a scratch with
      // 'source-atop', so it lands on the animal's own pixels and never on the
      // sea — filling a rect straight onto the frame would leave a coloured box.
      const w = Math.max(1, sw), h = Math.max(1, sh);
      if (!this.subScratch) this.subScratch = document.createElement('canvas');
      const sc = this.subScratch;
      if (sc.width < w || sc.height < h) { sc.width = Math.max(sc.width, w); sc.height = Math.max(sc.height, h); }
      const sg = sc.getContext('2d');
      if (!sg) { g.drawImage(spr, dx, dy, w, h); continue; }

      sg.clearRect(0, 0, w, h);
      sg.imageSmoothingEnabled = false;
      sg.globalCompositeOperation = 'source-over';
      sg.drawImage(spr, 0, 0, w, h);

      // Waterline in sprite-local pixels: everything at or below is underwater.
      const line = Math.round(h * (1 - c.submersion));
      sg.globalCompositeOperation = 'source-atop';
      sg.fillStyle = `rgba(${surf.mid.r},${surf.mid.g},${surf.mid.b},0.55)`;
      sg.fillRect(0, line, w, h - line);
      // Deep water swallows more of the body than shallow.
      if (c.submersion > 0.9) {
        sg.fillStyle = `rgba(${surf.deep.r},${surf.deep.g},${surf.deep.b},0.3)`;
        sg.fillRect(0, line, w, h - line);
      }
      sg.globalCompositeOperation = 'source-over';

      // Sunk by the submerged fraction, so the waterline sits where the cell is.
      const sunk = dy + Math.round(h * c.submersion);
      g.save();
      g.globalAlpha = c.submersion >= 1 ? 0.78 : 0.92;
      g.drawImage(sc, 0, 0, w, h, dx, sunk, w, h);
      g.restore();

      // A one-pixel glint where the body breaks the surface sells the meniscus.
      if (c.submersion < 1) {
        g.fillStyle = `rgba(${surf.light.r},${surf.light.g},${surf.light.b},0.5)`;
        g.fillRect(dx, sunk + line, w, 1);
      }
    }

    for (const st of this.habitable ? [] : this.settlements) {
      g.drawImage(st.sprite,
        Math.round(this.wsx(st.wx) - st.w * S / 2), Math.round(this.wsy(st.wy) + layerBob - st.h * S),
        Math.round(st.w) * S, Math.round(st.h) * S);
    }

    g.restore();
  }

  private buildRipples(): void {
    this.ripples = [];
    if (this.planetType === 'lava' || this.planetType === 'gas') return;
    const { cx, cy, rx, ry } = this;
    const s = new Stream(this.planetSeed ^ 0x27d4eb2f);
    for (let i = 0; i < 22; i++) {
      const a = s.range(0, Math.PI * 2);
      const rad = Math.sqrt(s.range(0.30, 0.97));
      this.ripples.push({
        x: cx + Math.cos(a) * rx * rad,
        y: cy + Math.sin(a) * ry * rad,
        rx: s.range(rx * 0.05, rx * 0.16),
        phase: s.range(0, Math.PI * 2),
        speed: s.range(0.5, 1.4),
      });
    }
  }

  // ─── Frame ─────────────────────────────────────────────────────────────────

  private frame(dt: number, now = performance.now()): void {
    if (this.habitable) {
      this.sky = this.skyNow();
      this.updateSeason();
      // Settle + throttled rebake, before drawing (see updateView).
      this.updateView(now);
      this.cutaway.frame({
        g: this.ctx,
        dt,
        elapsed: this.elapsed,
        drawBackdrop: (g) => this.drawBackdropPanorama(g),
        sunAzimuth: this.dayAngle,
        sunLat: this.sky?.declination ?? 0,
        // During a gesture the identity layers are CSS-scaled by this zoom.
        viewZoom: this.zoom.viewZoom,
        air: this.air,
        drawFarSpace: (g) => {
          this.drawSky(g);
          this.drawMoons(g, this.elapsed * (Math.PI * 2 / 60), false);
        },
        // With live flora the buildings are drawn in the flora layer's depth
        // pass (townProps); otherwise as their own layer.
        drawProps: this.cutaway.liveFlora ? undefined : (g) => this.drawBuildings(g),
        drawSurfaceOverlays: (g) => {
          this.drawCityLights(g, this.elapsed);
          this.drawVentFx(g, this.elapsed);
          this.drawInhabitants(g, this.elapsed);
          this.drawBirds(g, this.elapsed);
        },
        drawUiOverlays: (g) => {
          this.drawTileMarkers(g, this.elapsed);
          this.drawDivineEffects(g, dt);
        },
        drawNearMoons: (g) => {
          this.drawMoons(g, this.elapsed * (Math.PI * 2 / 60), true);
        },
      });
      this.displayCtx.drawImage(this.buf, 0, 0);
      return;
    }

    this.sky = this.skyNow();
    this.updateView(now);   // legacy path: CSS zoom only, never a camera
    const g = this.ctx;
    const { VW, VH, cx, cy, rx, ry } = this;
    const t = this.elapsed;
    const pal = PALETTES[this.planetType];

    if (this.surfaceDirty &&
        t - this.lastSurfaceBake > IsoDioramaRenderer.SURFACE_REBAKE_INTERVAL) {
      this.bakeSurface();
      this.buildCityDots();
      this.buildInhabitants();
    }

    // 1 — space backdrop
    this.drawBackdropPanorama(g);

    // 2 — sky: orbit arc, phased siblings and the sun, from the real orbits
    this.drawSky(g);

    // 4 — atmospheric halo behind the body. A gas giant is a full sphere
    // centred in the frame, not a disc, so its halo is centred too.
    //
    // SKIPPED on the habitable path. A 1.45×-radius pulsing glow is the single
    // biggest reason the old earth-like worlds read as "soft blob in space"
    // instead of the mockup's hard-edged planet; those worlds get the thin baked
    // shell at step 12b instead.
    const isGas = this.planetType === 'gas';
    const gasR = this.gasR;
    const haloCy = isGas ? VH * 0.5 : cy + ry * 0.4;
    const haloR = isGas ? gasR * 1.42 : rx * 1.45;
    // For a gas giant the glow must start outside the body, or it washes the
    // whole sphere in atmosphere colour.
    const haloInner = isGas ? gasR * 1.02 : rx * 0.6;
    const haloCol = isGas ? this.gasHalo : pal.halo;
    const halo = g.createRadialGradient(cx, haloCy, haloInner, cx, haloCy, haloR);
    const pulse = (isGas ? 0.24 : 0.16) + (isGas ? 0.05 : 0.05) * Math.sin(t * 0.6);
    halo.addColorStop(0, css(haloCol, pulse));
    halo.addColorStop(0.55, css(haloCol, pulse * 0.50));
    halo.addColorStop(1, css(haloCol, 0));
    g.fillStyle = halo;
    g.fillRect(0, 0, VW, VH);

    // 5 — moons on the far half of their orbits, behind the disc.
    // Each moon decides its own side from its own phase, so a system with
    // several of them has some in front and some behind at the same moment.
    const moonAngle = t * (Math.PI * 2 / 60);
    this.drawMoons(g, moonAngle, false);

    // 6 — rock crust + water cut band
    g.drawImage(this.crustLayer, 0, 0);

    // 7 — top face terrain
    g.drawImage(this.surfaceLayer, 0, 0);

    // 8 — animated ocean shimmer, clipped to the top face
    this.drawOceanShimmer(g, t, dt);

    // 9 — city lights
    this.drawCityLights(g, t);

    // 10 — volcanic embers rising from the crust
    if (this.planetType === 'lava') this.drawEmbers(g, dt);

    // 10b — creatures and settlements standing on the surface
    this.drawInhabitants(g, t);

    // 10c — tile hover / selection markers
    this.drawTileMarkers(g, t);

    // 10d — divine powers landing on the surface
    this.drawDivineEffects(g, dt);

    // 12 — the glass dome itself (gas giants have neither dome nor cut face)
    if (pal.hasDome) this.drawDome(g, t);
    else if (!isGas) this.drawHaze(g, t);

    // 13 — moons on the near half of their orbits, in front of the dome
    this.drawMoons(g, moonAngle, true);

    // 14 — vignette. Centred on the BODY, not the cut face: the habitable
    // silhouette reaches a full radius below the ellipse, and a vignette hung
    // off the face darkens the bottom third of the planet. Gas giants skip it
    // — the same wash used to crush the already-dark sphere into a black disc.
    if (!isGas) {
      const vig = g.createRadialGradient(cx, cy, rx * 0.7, cx, cy, Math.max(VW, VH) * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, 'rgba(0,0,0,0.55)');
      g.fillStyle = vig;
      g.fillRect(0, 0, VW, VH);
    }

    // Blit the low-res buffer to the display canvas at 1:1 virtual pixels.
    this.displayCtx.drawImage(this.buf, 0, 0);
  }

  /**
   * Backdrop panorama, slid left by the sun's true longitude (one turn a year).
   *
   * Under a camera the far panorama (`bgFar`, re-baked at `farScale(k)` about
   * the focus on settle) is drawn instead: a panorama point at identity screen
   * x lands at (x - fx) * s + VW/2, so the scaled image is offset by
   * (off + fx) * s - VW/2. Identity: today's panorama and offset.
   */
  /**
   * The space backdrop, ALWAYS as the panorama seen through the live view's
   * far transform (farScale of its zoom, parallax about its focus).
   *
   * It used to draw the far bake only when the live camera matched the bake
   * exactly and otherwise fell back to the unzoomed panorama, and during the
   * identity CSS gesture it was scaled 1:1 with the planet: every pan or zoom
   * swapped the star field for another and snapped it back on settle (play
   * report: "the stars in the background change position"). Now the nearest
   * bake is drawn stretched to the live far scale, counter-transformed under
   * the CSS gesture, so the stars move continuously at their parallax rate.
   */
  private drawBackdropPanorama(g: CanvasRenderingContext2D): void {
    const W = this.bgLayer.width, H = this.VH, VW = this.VW;
    const off = backdropOffset(this.sky?.sunLongitude ?? 0, W);
    const z = this.zoom;
    const css = this.habitable && !z.showCamera && (z.viewZoom !== 1 || z.panX !== 0 || z.panY !== 0);
    const L = css ? z.liveCamera(this.bgLive) : this.cam;
    if (!css && isIdentity(L, VW, this.VH)) {
      g.drawImage(this.bgLayer, -off, 0);
      if (W - off < VW) g.drawImage(this.bgLayer, W - off, 0);
      return;
    }
    const sL = farScale(L.zoom);
    // Source: the unzoomed panorama or the far bake, whichever scale is nearer.
    let src: HTMLCanvasElement = this.bgLayer, s0 = 1, fy0 = H / 2, sx = 1;
    const far = this.bgFar, ff = this.bgFarFor;
    if (far && ff && ff.W === W && ff.H === H && Math.abs(farScale(ff.zoom) - sL) < Math.abs(1 - sL)) {
      src = far; s0 = farScale(ff.zoom); fy0 = ff.fy; sx = far.width / W;
    }
    g.save();
    if (css) {
      // The canvas is CSS-transformed (scale z about the centre, then the
      // pan): draw in DISPLAYED coordinates through the inverse.
      const zz = z.viewZoom, cx = VW / 2, cy = H / 2;
      const pcx = (VW / 2 - L.fx) * zz, pcy = (H / 2 - L.fy) * zz;
      g.setTransform(1 / zz, 0, 0, 1 / zz, cx - (cx + pcx) / zz, cy - (cy + pcy) / zz);
    }
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#05060f';
    g.fillRect(0, 0, VW, H);
    // World panorama (x, y) -> displayed (X, Y): X = (x - off - fx) sL + VW/2,
    // Y = (y - fy) sL + H/2; the source holds x at x*sx and y at (y - fy0) s0 + H/2.
    const kx = sL / sx, ky = sL / s0;
    const ex = -(off + L.fx) * sL + VW / 2;
    const ey = (fy0 - L.fy) * sL + H / 2 - (H / 2) * ky;
    const period = W * sL, dw = src.width * kx, dh = src.height * ky;
    let x0 = ex % period;
    if (x0 > 0) x0 -= period;
    for (let x = x0; x < VW; x += period) g.drawImage(src, Math.round(x), Math.round(ey), Math.ceil(dw), Math.ceil(dh));
    g.restore();
  }
  private bgLive: Camera = { zoom: 1, fx: 0, fy: 0 };

  /**
   * The season on show: 0 spring, 1 summer, 2 autumn, 3 winter; -1 when the
   * world has (almost) no axial tilt or is still forming. From the same orbit
   * the sky is drawn from (sun longitude past the spring equinox).
   */
  private season = -1;
  private seasonNow(): number {
    const p = this.planet;
    if (!p || this.forming || !this.sky) return -1;
    const seed = p.genomeSeed ?? 0;
    if (Math.sin(axialTilt(seed)) < 0.12) return -1;
    const T = Math.PI * 2;
    const phi = (((this.sky.sunLongitude - seasonZero(seed)) % T) + T) % T;
    return Math.floor(((phi + Math.PI / 4) % T) / (Math.PI / 2));
  }
  /** A new season re-bakes the ground (fields, snow) and recolours the plants. */
  private updateSeason(): void {
    const s = this.seasonNow();
    if (s === this.season) return;
    this.season = s;
    this.cutaway.flora.setSeason(s);
    this.surfaceDirty = true;
  }

  /**
   * The sun's glow, drawn as a canvas radial gradient (GPU-cheap) since the
   * painter only rasterises the bright bloom CORE (`t < BLOOM_CORE`) of
   * `L.bloom * bloomScale(sunSizeScale)`, to keep its per-pixel loop small.
   * This wash is the whole glow's flat BASE level — constant
   * `WASH_ALPHA * fade` from the centre out to BLOOM_CORE, falling to 0 by
   * t = 1 — and the painter draws only the brightness ABOVE that base
   * (`bloomCoreAlpha`), so the two composite into one continuous profile with
   * no seam at BLOOM_CORE. Must use the SAME clamped `bloomScale` as the
   * painter's core, or the wash and core radii drift apart.
   */
  private drawSunWash(g: CanvasRenderingContext2D, L: SkyLayout, sky: SkyState<Planet>, sunRgb: RGB): void {
    if (sky.sun.elev <= 0) return;
    const x = trackX(sky.sun.az, L), y = trackY(sky.sun.az, L);
    const R = L.bloom * bloomScale(sky.sun.sizeScale);
    const fade = Math.min(1, sky.sun.elev / 0.15);
    // The wash is the whole glow's BASE level: a flat alpha from the centre
    // out to BLOOM_CORE, then falling to 0 by the edge. The painter's own
    // core (bloomCoreAlpha) draws only the brightness ABOVE this base, so the
    // two composite into one continuous profile with no seam at BLOOM_CORE —
    // making the start circle solid (a canvas gradient's usual behaviour)
    // is exactly what is wanted here, not a bug to route around.
    const wash = WASH_ALPHA * fade;
    const grad = g.createRadialGradient(x, y, 0, x, y, R);
    grad.addColorStop(0, css(sunRgb, wash));
    grad.addColorStop(BLOOM_CORE, css(sunRgb, wash));
    grad.addColorStop(1, css(sunRgb, 0));
    g.fillStyle = grad;
    const x0 = Math.max(0, x - R), y0 = Math.max(0, y - R);
    const x1 = Math.min(this.VW, x + R), y1 = Math.min(this.VH, y + R);
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }

  /** Orbit arc, sibling planets and the sun, from this frame's sky. */
  private drawSky(g: CanvasRenderingContext2D): void {
    const sky = this.sky, img = this.skyImage;
    if (!sky || !img) return;
    // Far layer: laid out on the BASE geometry, then through the far transform
    // (farScale about the camera focus). Identity returns the base layout.
    const geom = this.habitable ? this.cutaway.geom : { cx: this.cx, cyTop: this.cy, rx: this.rx };
    const homeR = this.planet?.orbitalRadius ?? 40;
    const sun = this.star ? tempToRGB(this.star.temperature) : rgb(255, 236, 180);
    const L = farLayout(skyLayout(geom, this.VW, this.VH), this.cam, this.VW, this.VH);
    const far = L.far ?? 1;
    // Paced like the engine's pixel layers: the sky (sun, glow, siblings)
    // repaints at SKY_HZ, or at once when the camera, the size or the sky
    // changes; frames in between reuse the last paint.
    const c = this.cam, K = this.skyKey;
    const moved = K.z !== c.zoom || K.fx !== c.fx || K.fy !== c.fy || K.w !== this.VW || K.h !== this.VH;
    K.z = c.zoom; K.fx = c.fx; K.fy = c.fy; K.w = this.VW; K.h = this.VH;
    const due = moved || !this.cutaway.paceLayers || this.elapsed < this.skyT || this.elapsed - this.skyT >= 1 / SKY_HZ;
    const sg = this.skyCanvas.getContext('2d');
    if (!sg) return;
    if (!due) {
      this.drawSunWash(g, L, sky, sun);
      g.drawImage(this.skyCanvas, 0, 0);
      return;
    }
    this.skyT = this.elapsed;
    img.data.fill(0);
    paintSky(img, L, {
      sunAz: sky.sun.az, sunElev: sky.sun.elev, sunSizeScale: sky.sun.sizeScale,
      sunRgb: [sun.r, sun.g, sun.b],
      sunTemperature: this.star?.temperature,
      time: this.elapsed,
      sunSeed: this.star?.id ?? 7,
      siblings: sky.siblings.map(s => {
        const distN = Math.abs((s.planet.orbitalRadius ?? homeR) - homeR) / Math.max(homeR, 12);
        const c = planetTypeRGB(s.planet.type);
        return {
          az: s.az, elev: s.elev, litFraction: s.litFraction,
          radiusPx: Math.max(1.2, (2.2 + s.planet.radius * 0.20) / (1 + distN * 0.7)) * far,
          rgb: [c.r, c.g, c.b] as [number, number, number],
        };
      }),
    });
    sg.putImageData(img, 0, 0);
    this.drawSunWash(g, L, sky, sun);
    g.drawImage(this.skyCanvas, 0, 0);
  }

  /**
   * Draw the planet's actual moons.
   *
   * This used to draw ONE hard-coded grey disc, identical on every world and
   * belonging to nothing in the simulation. Each moon now carries its own size,
   * composition, colour and orbit (`Planet.moons`), and a settled one shows the
   * lights of its colony.
   *
   * @param angle global orbit phase, so the moons keep moving with the scene
   * @param front true to draw the half of the orbit in front of the planet
   */
  /**
   * The planet's actual moons, the same ones the system view draws: each on
   * its own orbit at the SAME angle (orbitalAngle + animTick x orbitalSpeed,
   * the system view's clock), so a moon east of the planet there is east of
   * it here, and behind the world for the far half of its orbit. Ordered
   * outward by orbit radius, sized from its radius relative to the planet,
   * drawn by MoonArt (shared with the system view) and lit from the sun.
   * A settled moon carries its colony's domes and lights.
   *
   * @param _angle unused (kept for the call sites; the orbit clock is animTick)
   * @param front true to draw the half of each orbit in front of the planet
   */
  private drawMoons(g: CanvasRenderingContext2D, _angle: number, front: boolean): void {
    const { cx, cy, rx, ry } = this;
    const planet = this.planet, moons = planet?.moons ?? [];
    if (!planet || moons.length === 0) return;
    const rank = moons.map((m, i) => i).sort((a, b) => moons[a].orbitalRadius - moons[b].orbitalRadius);
    const tick = this.animTick;
    const k = this.camZoom;
    // Sun direction on screen (azimuth 0 lights the +x limb), from above.
    const az = this.sky?.sun.az ?? 0;
    const lb = Math.round(Math.cos(az) * 8) / 8;
    for (let o = 0; o < rank.length; o++) {
      const i = rank[o], m = moons[i];
      const a = m.orbitalAngle + tick * m.orbitalSpeed;
      const isFront = Math.sin(a) > 0;
      if (isFront !== front) continue;
      const dist = 1.5 + o * 0.32;
      const x = cx + Math.cos(a) * rx * dist;
      const y = this.habitable
        ? this.cutaway.drawGeom.cyTop - this.cutaway.drawGeom.ry * 1.35
          + Math.sin(a) * this.cutaway.drawGeom.R * 0.38
        : cy + Math.sin(a) * ry * 2.0 - rx * 0.22;
      const rel = planet.radius > 0 ? m.radius / planet.radius : 0.25;
      const d = Math.round(Math.max(6 * k, Math.min(rx * 0.32, rx * 0.5 * rel)));
      const key = `${i}|${d}|${lb}|${m.colonised ? 1 : 0}`;
      let cv = this.moonSprites.get(key);
      if (!cv) {
        const f = paintMoon({
          kind: m.kind as MoonKindArt, rgb: ((c) => [c.r, c.g, c.b] as [number, number, number])(hexToRGB(m.color)), size: d,
          seed: (planet.genomeSeed ?? 1) * 31 + i * 977, lx: lb, ly: -0.45, colonised: m.colonised,
        });
        cv = document.createElement('canvas');
        cv.width = f.width; cv.height = f.height;
        const cg = cv.getContext('2d');
        if (cg) { const img = cg.createImageData(f.width, f.height); img.data.set(f.data); cg.putImageData(img, 0, 0); }
        if (this.moonSprites.size > 200) this.moonSprites.clear();
        this.moonSprites.set(key, cv);
      }
      const prev = g.imageSmoothingEnabled;
      g.imageSmoothingEnabled = false;
      g.drawImage(cv, Math.round(x - d / 2), Math.round(y - d / 2));
      g.imageSmoothingEnabled = prev;
    }
  }
  private moonSprites = new Map<string, HTMLCanvasElement>();

  private drawOceanShimmer(g: CanvasRenderingContext2D, t: number, dt: number): void {
    if (this.planetType === 'lava' || this.planetType === 'gas') return;

    const { cx, cy, rx, ry } = this;

    g.save();
    g.beginPath();
    g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    g.clip();

    // Short wave dashes rather than full rings — closed ellipses read as
    // ripples in a pond, not open ocean.
    g.lineWidth = 1;
    g.lineCap = 'butt';
    for (const rp of this.ripples) {
      rp.phase += dt * rp.speed;
      const a = (Math.sin(rp.phase) * 0.5 + 0.5) * 0.30;
      if (a < 0.04) continue;
      g.strokeStyle = `rgba(220,244,255,${a})`;
      g.beginPath();
      g.ellipse(rp.x, rp.y, rp.rx, rp.rx * 0.30, 0, Math.PI * 1.15, Math.PI * 1.85);
      g.stroke();
      g.beginPath();
      g.ellipse(rp.x + rp.rx * 0.5, rp.y + rp.rx * 0.22, rp.rx * 0.55, rp.rx * 0.18,
                0, Math.PI * 1.15, Math.PI * 1.85);
      g.stroke();
    }

    // Sun glint band sweeping across the water on the lit side.
    const gx = cx + rx * (0.30 + 0.10 * Math.sin(t * 0.35));
    const glint = g.createRadialGradient(gx, cy - ry * 0.25, 0, gx, cy - ry * 0.25, rx * 0.55);
    glint.addColorStop(0, 'rgba(255,250,225,0.16)');
    glint.addColorStop(1, 'rgba(255,250,225,0)');
    g.fillStyle = glint;
    g.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);

    g.restore();
  }

  private drawCityLights(g: CanvasRenderingContext2D, t: number): void {
    if (this.cityDots.length === 0) return;
    const layerBob = this.habitable ? this.cutaway.drawGeom.bob : 0;
    // Night side of the disc — lights read strongest away from the key light.
    // Disc position from the stored base-world point and the BASE geometry;
    // the light itself is a 1-px stroke at its camera position.
    const pg = this.placeGeom;
    for (const dot of this.cityDots) {
      const flicker = 0.55 + 0.45 * Math.sin(t * dot.rate + dot.phase);
      if (flicker < 0.35) continue;
      const dx = (dot.wx - pg.cx) / pg.rx;
      const nightBias = clamp01(0.55 - sunFacing(dx, this.dayAngle) * 0.85);
      const a = flicker * (0.35 + nightBias * 0.65);
      const x = this.wsx(dot.wx), y = this.wsy(dot.wy) + layerBob;
      g.fillStyle = `rgba(255,226,150,${a})`;
      g.fillRect(x, y, 1, 1);
      if (a > 0.75) {
        g.fillStyle = `rgba(255,200,110,${a * 0.25})`;
        g.fillRect(x - 1, y, 3, 1);
        g.fillRect(x, y - 1, 1, 3);
      }
    }
  }

  /**
   * Play a divine power on the world.
   *
   * @param kind which power
   * @param cell where it lands; omitted for world-wide acts, which centre on the
   *   face. A cell is projected through the same azimuthal mapping the terrain
   *   uses and raised onto the extruded surface, so the effect sits on the
   *   ground the player clicked rather than floating over it.
   */
  playDivineEffect(kind: DivineEffectKind, cell?: { row: number; col: number } | null): void {
    const style = EFFECT_STYLES[kind];
    // Cast in BASE-WORLD units (spec 3), whatever the camera: centre, reach,
    // mote positions and velocities. Drawing maps them through the camera.
    const pg = this.placeGeom;
    let x = pg.cx, y = pg.cy, reach = pg.rx * 0.85;

    if (cell) {
      const d = this.gridToDisc(cell.row, cell.col);
      if (d) {
        x = pg.cx + d.dx * pg.rx;
        y = pg.cy + d.dy * pg.ry;
        const gc = this.grid?.[cell.row]?.[cell.col];
        if (gc) y -= this.liftAtCell(gc, Math.hypot(d.dx, d.dy));
        reach = pg.rx * 0.28;
      }
    }

    const s = new Stream((this.planetSeed ^ (this.effects.length * 2654435761)) >>> 0);
    const motes: Mote[] = [];
    const n = Math.abs(style.motes);
    for (let i = 0; i < n; i++) {
      const a = s.range(0, Math.PI * 2);
      const rad = Math.sqrt(s.next()) * reach * 0.8;
      const falling = style.motes < 0;
      motes.push({
        x: x + Math.cos(a) * rad,
        // Falling motes start above and collapse inward; rising ones start on
        // the ground and drift up.
        y: y + Math.sin(a) * rad * 0.34 - (falling ? s.range(10, 34) : 0),
        vx: falling ? -Math.cos(a) * s.range(4, 10) : Math.cos(a) * s.range(1, 4),
        vy: falling ? s.range(10, 24) : -s.range(9, 22),
        born: s.range(0, style.life * 0.35),
        swirl: s.range(-2.4, 2.4),
      });
    }

    this.effects.push({ kind, wx: x, wy: y, reach, age: 0, motes });
    // Bound the queue: spamming a power should not stack unbounded work.
    if (this.effects.length > 6) this.effects.shift();
  }

  /** Divine acts: expanding rings, rising motes, beams and light washes. */
  private drawDivineEffects(g: CanvasRenderingContext2D, dt: number): void {
    if (this.effects.length === 0) return;
    const { cx, cy, rx, ry } = this;
    const bodyRadius = this.habitable ? this.cutaway.drawGeom.R : rx;
    // World class: the stored world centre, reach and mote paths go through
    // the camera (lengths x k); ring and mote strokes stay 1-2 px.
    const k = this.camZoom;

    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      const style = EFFECT_STYLES[fx.kind];
      fx.age += dt;
      if (fx.age > style.life) { this.effects.splice(i, 1); continue; }

      const t = fx.age / style.life;          // 0 → 1 over the effect's life
      const fade = 1 - t * t;                 // holds bright, then drops away
      const ex = this.wsx(fx.wx), ey = this.wsy(fx.wy), reach = fx.reach * k;

      g.save();
      g.beginPath();
      // Confine the act to the world it landed on. On the habitable path the
      // body is the circle below the cut face, so clipping to a circle centred
      // on the FACE would let washes and beams spill into empty space above it.
      if (this.habitable) g.arc(cx, this.bodyCy, bodyRadius - 1, 0, Math.PI * 2);
      else g.arc(cx, cy, rx, 0, Math.PI * 2);
      g.clip();
      g.globalCompositeOperation = 'lighter';

      // A glow centred on where the power landed. A FLAT additive fill over the
      // whole disc at this strength blows the entire dome to white; a radial
      // falloff reads as light spreading from the act instead.
      if (style.wash > 0) {
        const wr = reach * (1 + t * 1.6);
        const wash = g.createRadialGradient(ex, ey, 0, ex, ey, wr);
        wash.addColorStop(0, css(style.color, style.wash * fade));
        wash.addColorStop(0.55, css(style.color, style.wash * fade * 0.45));
        wash.addColorStop(1, css(style.color, 0));
        g.fillStyle = wash;
        g.beginPath(); g.arc(ex, ey, wr, 0, Math.PI * 2); g.fill();
      }

      // A shaft of light from the top of the atmosphere down onto the target.
      // The habitable body has no dome above the face — its ceiling IS the face
      // rim — so the beam has to start there or it hangs in space.
      if (style.beam) {
        const beamW = Math.max(3 * k, reach * 0.28);
        const beamTop = this.habitable ? this.bodyCy - bodyRadius + 1 : cy - rx;
        const grad = g.createLinearGradient(ex, beamTop, ex, ey);
        grad.addColorStop(0, css(style.color, 0));
        grad.addColorStop(1, css(style.color, 0.55 * fade));
        g.fillStyle = grad;
        g.fillRect(ex - beamW / 2, beamTop, beamW, ey - beamTop);
      }

      // Rings expanding outward along the ground plane, so they read as lying on
      // the surface rather than standing up in the air.
      for (let k = 0; k < style.rings; k++) {
        const offset = k / Math.max(1, style.rings) * 0.45;
        const rt = t + offset;
        if (rt > 1) continue;
        const rr = reach * rt;
        g.globalAlpha = (1 - rt) * 0.85 * fade;
        g.strokeStyle = css(style.color, 1);
        g.lineWidth = Math.max(1, 2 * (1 - rt));
        g.beginPath();
        g.ellipse(ex, ey, rr, rr * (ry / rx), 0, 0, Math.PI * 2);
        g.stroke();
      }

      // Motes.
      g.globalAlpha = fade;
      g.fillStyle = css(style.color, 1);
      for (const m of fx.motes) {
        if (fx.age < m.born) continue;
        const mt = fx.age - m.born;
        const px = this.wsx(m.x + m.vx * mt + Math.sin(mt * 3 + m.swirl) * 3);
        const py = this.wsy(m.y + m.vy * mt);
        const a = clamp01(1 - mt / (style.life - m.born)) * fade;
        if (a <= 0.02) continue;
        g.globalAlpha = a;
        g.fillRect(Math.round(px), Math.round(py), 1, 1);
        if (a > 0.6) g.fillRect(Math.round(px), Math.round(py) - 1, 1, 1);
      }

      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      g.restore();
    }
  }

  private drawEmbers(g: CanvasRenderingContext2D, dt: number): void {
    const { cx, cy, rx, ry } = this;
    // Keep a steady population of rising sparks.
    while (this.embers.length < 30) {
      const a = Math.random() * Math.PI * 2;
      this.embers.push({
        x: cx + Math.cos(a) * rx * Math.sqrt(Math.random()),
        y: cy + Math.sin(a) * ry * Math.sqrt(Math.random()),
        vy: 4 + Math.random() * 12,
        life: 0,
        maxLife: 1.4 + Math.random() * 2.2,
      });
    }
    for (let i = this.embers.length - 1; i >= 0; i--) {
      const e = this.embers[i];
      e.life += dt;
      e.y -= e.vy * dt;
      if (e.life > e.maxLife) { this.embers.splice(i, 1); continue; }
      const a = (1 - e.life / e.maxLife) * 0.9;
      g.fillStyle = `rgba(255,${140 + Math.round(a * 80)},60,${a})`;
      g.fillRect(Math.round(e.x), Math.round(e.y), 1, 1);
    }
  }

  /**
   * Hover and selection markers for M20's interactive tiles.
   *
   * Drawn as a small projected diamond rather than a screen-space square, so the
   * marker sits on the surface and follows the disc's curvature.
   */
  private drawTileMarkers(g: CanvasRenderingContext2D, t: number): void {
    const { cx, cy, rx, ry } = this;
    const k = this.camZoom;

    const draw = (cell: { row: number; col: number }, colour: string, width: number) => {
      const p = this.gridToDisc(cell.row, cell.col);
      if (!p) return;
      const px = cx + p.dx * rx;
      const py = cy + p.dy * ry;

      // Size the marker from the projected spacing of neighbouring cells so it
      // stays roughly one tile across wherever it lands on the disc. World
      // class: the span follows the active rx; the floors and cap scale by k.
      const n = this.gridToDisc(cell.row, (cell.col + 3) % GRID_SIZE);
      const span = n ? Math.max(2 * k, Math.abs((n.dx - p.dx) * rx) * 1.2) : 3 * k;
      const w = Math.min(14 * k, Math.max(2.5 * k, span));
      const h = Math.max(1.5 * k, w * 0.42);

      g.strokeStyle = colour;
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(px, py - h);
      g.lineTo(px + w, py);
      g.lineTo(px, py + h);
      g.lineTo(px - w, py);
      g.closePath();
      g.stroke();
    };

    if (this.highlight) draw(this.highlight, 'rgba(255,255,255,0.55)', 1);
    if (this.selection) {
      const pulse = 0.55 + 0.35 * Math.sin(t * 3.2);
      draw(this.selection, `rgba(255,214,140,${pulse.toFixed(2)})`, 1.5);
    }
  }

  /** Glass hemisphere over the top face: sky gradient, rim light, specular sweep. */
  private drawDome(g: CanvasRenderingContext2D, t: number): void {
    const { cx, cy, rx, ry } = this;
    const pal = PALETTES[this.planetType];

    // Sky inside the dome, above the horizon (the top-face ellipse).
    g.save();
    g.beginPath();
    g.arc(cx, cy, rx, 0, Math.PI * 2);
    // Punch out the top face so the sky doesn't wash over the terrain.
    g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2, true);
    g.clip('evenodd');

    const sky = g.createLinearGradient(0, cy - rx, 0, cy);
    sky.addColorStop(0, css(pal.skyHigh, 0.34));
    sky.addColorStop(0.55, css(pal.skyLow, 0.22));
    sky.addColorStop(1, css(pal.skyLow, 0.07));
    g.fillStyle = sky;
    g.fillRect(cx - rx, cy - rx, rx * 2, rx);
    g.restore();

    // Glass body: a faint overall tint plus a broad specular on the upper-left.
    // Clipped to the dome *above* the horizon — the glass must never wash over
    // the rock crust below the disc.
    g.save();
    g.beginPath();
    g.arc(cx, cy, rx, Math.PI, Math.PI * 2);
    g.ellipse(cx, cy, rx, ry, 0, Math.PI * 2, Math.PI, true);
    g.closePath();
    g.clip();

    const glass = g.createRadialGradient(
      cx - rx * 0.42, cy - rx * 0.48, 0,
      cx - rx * 0.42, cy - rx * 0.48, rx * 1.25,
    );
    glass.addColorStop(0, 'rgba(255,255,255,0.14)');
    glass.addColorStop(0.35, 'rgba(220,240,255,0.04)');
    glass.addColorStop(1, 'rgba(180,210,255,0)');
    g.fillStyle = glass;
    g.fillRect(cx - rx, cy - rx, rx * 2, rx * 2);

    // Moving specular streak — sells "glass" more than any static highlight.
    // The sweep travels past both ends, so every stop has to be clamped to [0,1]
    // and kept strictly ascending or addColorStop throws.
    const sweep = ((t * 0.06) % 1) * 2 - 0.5;
    const s0 = clamp01(sweep - 0.10);
    const s1 = clamp01(sweep);
    const s2 = clamp01(sweep + 0.10);
    if (s2 > s0) {
      g.save();
      g.translate(cx, cy);
      g.rotate(-0.7);
      const sg = g.createLinearGradient(-rx, 0, rx, 0);
      sg.addColorStop(s0, 'rgba(255,255,255,0)');
      sg.addColorStop(Math.max(s0, Math.min(s2, s1)), 'rgba(255,255,255,0.13)');
      sg.addColorStop(s2, 'rgba(255,255,255,0)');
      g.fillStyle = sg;
      g.fillRect(-rx, -rx * 0.55, rx * 2, rx * 0.5);
      g.restore();
    }

    g.restore();

    // Rim: only the arc above the horizon exists — the lower half of the sphere
    // is buried in the world, so stroking a full circle would draw a line across
    // the rock. Bright on the lit side, dimmer on the shadowed side.
    g.lineWidth = 1.5;
    g.strokeStyle = 'rgba(255,255,255,0.6)';
    g.beginPath();
    g.arc(cx, cy, rx - 0.5, Math.PI * 1.45, Math.PI * 2.0);
    g.stroke();
    g.strokeStyle = 'rgba(195,225,255,0.28)';
    g.beginPath();
    g.arc(cx, cy, rx - 0.5, Math.PI, Math.PI * 1.45);
    g.stroke();

    // Horizon line where the dome meets the water.
    g.strokeStyle = 'rgba(235,248,255,0.35)';
    g.lineWidth = 1;
    g.beginPath();
    g.ellipse(cx, cy, rx - 1, ry - 0.5, 0, Math.PI, Math.PI * 2);
    g.stroke();
  }

  /** Lava / gas worlds get a turbulent haze instead of clean glass. */
  private drawHaze(g: CanvasRenderingContext2D, t: number): void {
    const { cx, cy, rx, ry } = this;
    const pal = PALETTES[this.planetType];

    // Feathered top edge: a hard elliptical clip shows up as a visible arc in
    // the sky above the world.
    g.save();
    g.beginPath();
    g.ellipse(cx, cy, rx * 1.06, rx * 0.72, 0, Math.PI, Math.PI * 2);
    g.clip();
    g.globalAlpha = 1;
    for (let i = 0; i < 4; i++) {
      const y = cy - ry - i * rx * 0.14 - Math.sin(t * 0.5 + i) * 2;
      const grad = g.createLinearGradient(0, y, 0, y + rx * 0.2);
      grad.addColorStop(0, css(pal.halo, 0));
      grad.addColorStop(0.5, css(pal.halo, 0.28 + 0.08 * Math.sin(t * 0.8 + i * 1.3)));
      grad.addColorStop(1, css(pal.halo, 0));
      g.fillStyle = grad;
      g.fillRect(cx - rx * 1.1, y, rx * 2.2, rx * 0.2);
    }
    g.restore();
  }
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function clampAbs(v: number, m: number): number { return v < -m ? -m : v > m ? m : v; }

function ellipse(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number): void {
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  g.fill();
}

/** Blackbody-ish star colour from temperature (K). */
function tempToRGB(temp: number): RGB {
  if (temp > 25000) return rgb(170, 200, 255);
  if (temp > 10000) return rgb(210, 225, 255);
  if (temp > 7500)  return rgb(248, 248, 255);
  if (temp > 6000)  return rgb(255, 244, 214);
  if (temp > 5000)  return rgb(255, 220, 160);
  if (temp > 4000)  return rgb(255, 180, 110);
  return rgb(255, 140, 80);
}

/** HSV → RGB, used to give every gas giant its own band palette. */
function hsvToRGB(hDeg: number, s: number, v: number): RGB {
  const h = ((hDeg % 360) + 360) % 360 / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 1)      { r = c; g = x; }
  else if (h < 2) { r = x; g = c; }
  else if (h < 3) { g = c; b = x; }
  else if (h < 4) { g = x; b = c; }
  else if (h < 5) { r = x; b = c; }
  else            { r = c; b = x; }
  return rgb((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

function planetTypeRGB(type: string): RGB {
  switch (type) {
    case 'lava':    return rgb(200, 70, 30);
    case 'ice':     return rgb(150, 210, 240);
    case 'gas':     return rgb(190, 160, 110);
    case 'ocean':   return rgb(70, 140, 210);
    case 'toxic':   return rgb(90, 180, 50);
    case 'crystal': return rgb(160, 80, 200);
    case 'desert':  return rgb(210, 170, 90);
    case 'storm':   return rgb(80, 70, 110);
    case 'carbon':  return rgb(40, 42, 48);
    default:        return rgb(150, 130, 95);
  }
}


function hashStr(t: string): number {
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h | 0;
}
