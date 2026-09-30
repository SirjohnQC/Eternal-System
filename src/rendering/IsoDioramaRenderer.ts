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
import { BIOME_COLORS, isWater, classifyBiome, SEA_LEVEL, GRID_SIZE } from '../simulation/PlanetGrid';
import type { PlanetBiosphere, SpeciesGenome } from '../simulation/SpeciesGenome';
import { inhabitsWater, waterSubmersion } from '../simulation/SpeciesGenome';
import type { Planet, StarBody } from '../simulation/BigBangEngine';
import { dioramaCreatureSprite, bakeSettlementSprite } from './SpeciesSprite';
import {
  HabitableCutawayEngine,
  type HabitableType,
  cutawayWaterSurf,
} from './HabitableCutawayEngine';
import { decalRebakeNeeded, type DecalAtlas } from './SurfaceDecals';
import { loadDecalAtlas } from './DecalAtlasLoader';
import { atmosphereForPlanet, type AtmosphereChannel } from '../simulation/PlanetGenome';
import { buildClimate, type ClimateSources } from './weather/WeatherClimate';
import { sunFacing, moonShade } from './sky/SunLight';
import { orbitSky, type SkyState } from './sky/OrbitSky';
import { bakeBackdrop, backdropWidth, backdropOffset } from './sky/Backdrop';
import { paintSky, skyLayout, trackX, trackY, BLOOM_CORE, WASH_ALPHA, type SkyLayout } from './sky/SkyPainter';

// ─── Planet type palettes ──────────────────────────────────────────────────────

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

interface Mote { x: number; y: number; vx: number; vy: number; born: number; swirl: number }

interface DivineEffect {
  kind:  DivineEffectKind;
  /** Centre in virtual pixels. */
  x: number; y: number;
  /** Radius the rings expand to. */
  reach: number;
  age:   number;
  motes: Mote[];
}

interface CityDot { x: number; y: number; phase: number; rate: number }
interface Ripple  { x: number; y: number; rx: number; phase: number; speed: number }
interface Ember   { x: number; y: number; vy: number; life: number; maxLife: number }

// ─── Renderer ─────────────────────────────────────────────────────────────────

export class IsoDioramaRenderer {
  // Display canvas (upscaled) + low-res backbuffer
  private display!:    HTMLCanvasElement;
  private displayCtx!: CanvasRenderingContext2D;
  private buf!:        HTMLCanvasElement;
  private ctx!:        CanvasRenderingContext2D;

  // Baked static layers
  private bgLayer!:      HTMLCanvasElement;   // space, nebula, stars
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

  private viewZoom = 1;
  private viewPanX = 0;
  private viewPanY = 0;
  private isPanning = false;
  private panStart = { x: 0, y: 0, panX: 0, panY: 0 };
  private unbindView: Array<() => void> = [];
  private static readonly MIN_ZOOM = 1;
  private static readonly MAX_ZOOM = 4;
  private lastDecalState: { lush: number; biodiversity: number } | null = null;

  // Data
  private grid:        PlanetGrid | null = null;
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
   * Positions are in virtual pixels, already projected.
   */
  private inhabitants: Array<{
    x: number; y: number; sprite: HTMLCanvasElement;
    w: number; h: number; phase: number; sway: number; depth: number;
    /** 0 = fully above the surface, 1 = fully under. See waterSubmersion(). */
    submersion: number;
  }> = [];
  /** Scratch for compositing a submerged creature without tinting the sea. */
  private subScratch: HTMLCanvasElement | null = null;
  private settlements: Array<{
    x: number; y: number; sprite: HTMLCanvasElement; w: number; h: number; depth: number;
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

  /** Seconds for one local day. Bigger worlds spin slower. */
  private get dayPeriod(): number {
    const r = this.planet?.radius ?? 5;
    return Math.max(16, 18 + r * 5.5);
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
    const key = `${seed}|${this.planetType}`;
    if (!this.airCache || this.airCache.key !== key) {
      this.airCache = { key, air: atmosphereForPlanet(seed, this.planetType) };
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

  /** Recompute virtual resolution from the mount size and rebake every layer. */
  private resize(): void {
    if (!this.mount) return;
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

    this.bakeAll();
    this.clampViewPan(this.mount.getBoundingClientRect());
    this.applyViewTransform();
  }

  private bindViewInput(mount: HTMLElement): void {
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = mount.getBoundingClientRect();
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;
      const prev = this.viewZoom;
      const factor = e.deltaY > 0 ? 0.86 : 1.16;
      const next = Math.max(
        IsoDioramaRenderer.MIN_ZOOM,
        Math.min(IsoDioramaRenderer.MAX_ZOOM, prev * factor),
      );
      if (next === prev) return;
      const wx = (mx - this.viewPanX) / prev;
      const wy = (my - this.viewPanY) / prev;
      this.viewZoom = next;
      this.viewPanX = mx - wx * next;
      this.viewPanY = my - wy * next;
      this.clampViewPan(rect);
      this.applyViewTransform();
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      this.isPanning = true;
      this.panStart = { x: e.clientX, y: e.clientY, panX: this.viewPanX, panY: this.viewPanY };
      mount.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!this.isPanning) return;
      const dx = e.clientX - this.panStart.x;
      const dy = e.clientY - this.panStart.y;
      if (dx * dx + dy * dy < 36) return;
      this.viewPanX = this.panStart.panX + dx;
      this.viewPanY = this.panStart.panY + dy;
      this.clampViewPan(mount.getBoundingClientRect());
      this.applyViewTransform();
    };
    const onUp = (e: PointerEvent) => {
      if (!this.isPanning) return;
      const dx = e.clientX - this.panStart.x;
      const dy = e.clientY - this.panStart.y;
      this.isPanning = false;
      // A real drag must not also count as a tile click.
      if (dx * dx + dy * dy >= 36) {
        const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
        mount.addEventListener('click', swallow, { capture: true, once: true });
      }
    };
    mount.addEventListener('wheel', onWheel, { passive: false });
    mount.addEventListener('pointerdown', onDown);
    mount.addEventListener('pointermove', onMove);
    mount.addEventListener('pointerup', onUp);
    mount.addEventListener('pointercancel', onUp);
    this.unbindView = [
      () => mount.removeEventListener('wheel', onWheel),
      () => mount.removeEventListener('pointerdown', onDown),
      () => mount.removeEventListener('pointermove', onMove),
      () => mount.removeEventListener('pointerup', onUp),
      () => mount.removeEventListener('pointercancel', onUp),
    ];
  }

  private clampViewPan(rect: DOMRect): void {
    if (this.viewZoom <= IsoDioramaRenderer.MIN_ZOOM + 0.001) {
      this.viewZoom = IsoDioramaRenderer.MIN_ZOOM;
      this.viewPanX = 0;
      this.viewPanY = 0;
      return;
    }
    const maxX = (this.viewZoom - 1) * rect.width * 0.5;
    const maxY = (this.viewZoom - 1) * rect.height * 0.5;
    this.viewPanX = Math.max(-maxX, Math.min(maxX, this.viewPanX));
    this.viewPanY = Math.max(-maxY, Math.min(maxY, this.viewPanY));
  }

  private applyViewTransform(): void {
    this.display.style.transform =
      `translate(${this.viewPanX}px, ${this.viewPanY}px) scale(${this.viewZoom})`;
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
    this.grid        = grid;
    this.biosphere   = biosphere;
    this.species     = species;
    this.planet      = planet;
    this.planetType  = (planet.type ?? 'rocky') as PlanetType;
    this.star        = star ?? null;
    this.planetIndex = planetIndex;
    // A renderer instance can be reused across planets / a new game. Without
    // this reset, the next passive setLiveData() call would compare the NEW
    // planet's lushness against the PREVIOUS planet's, possibly suppressing
    // a re-bake this world has never actually painted.
    this.lastDecalState = null;
    this.computeFocus();
    this.bakeAll();
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
    if (decalRebakeNeeded(this.lastDecalState, nextState)) {
      this.lastDecalState = nextState;
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

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastT = performance.now();
    const loop = (t: number) => {
      if (!this.running) return;
      const dt = Math.min(0.1, (t - this.lastT) / 1000);
      this.lastT = t;
      this.elapsed += dt;
      try {
        this.frame(dt);
      } catch (err) {
        // A single bad draw call must never blank the planet view — log once,
        // keep whatever was already painted, and carry on.
        if (!this.errorLogged) {
          this.errorLogged = true;
          console.error('[IsoDiorama] frame error', err);
        }
        this.displayCtx.drawImage(this.buf, 0, 0);
      }
      this.raf = requestAnimationFrame(loop);
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

    return {
      row: Math.max(0, Math.min(GRID_SIZE - 1, Math.round(v * (GRID_SIZE - 1)))),
      col: Math.min(GRID_SIZE - 1, Math.floor(u * GRID_SIZE)),
    };
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
    if (this.habitable) return 18;
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
    return bio ? clamp01((bio.biodiversity / 10) * 0.55 + bio.landLife * 0.45) : 0.3;
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
  private bakeHabitableCutaway(): void {
    const bio = this.biosphere;
    this.cutaway.bake({
      w: this.VW, h: this.VH,
      seed: this.planetSeed,
      grid: this.grid,
      planetType: this.planetType as HabitableType,
      discToGrid: (dx, dy) => this.discToGrid(dx, dy),
      rimFalloff: (r) => this.rimFalloff(r),
      liftOf: (elev) => this.liftOf(elev),
      smoothElevation: (grid, row, col) => this.smoothElevation(grid, row, col),
      maxLift: this.maxLift,
      lush: this.lushFor(bio),
      weather: this.climateFor(),
      sunLat: this.skyNow().declination,
      decalSeed: this.planet?.genomeSeed ?? 0,
      decalAtlas: this.decalAtlas,
    });
    this.pickBuf = this.cutaway.pick;
    this.lastSurfaceBake = this.elapsed;
    this.surfaceDirty = false;
  }

  /** Repaint only habitable terrain; animation-owned cutaway state remains live. */
  private rebakeHabitableSurface(): void {
    const bio = this.biosphere;
    this.cutaway.updateSurfaceOpts({
      lush: this.lushFor(bio),
      decalSeed: this.planet?.genomeSeed ?? 0,
      decalAtlas: this.decalAtlas,
    });
    this.cutaway.rebakeSurface();
    // Sources follow the world (industry, stress, lushness); the sky is kept.
    this.cutaway.setWeatherClimate(this.climateFor());
    this.pickBuf = this.cutaway.pick;
    this.lastSurfaceBake = this.elapsed;
    this.surfaceDirty = false;
  }

  private bakeAll(): void {
    this.bakeBackground();
    if (this.habitable) {
      this.bakeHabitableCutaway();
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
    bakeBackdrop(img, { seed: this.planetSeed ^ 0x9e3779b9, vw: this.VW, vh: this.VH });
    g.putImageData(img, 0, 0);
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
          for (let k = 1; k <= lift; k++) {
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

  private buildCityDots(): void {
    this.cityDots = [];
    const grid = this.grid;
    if (!grid || this.planetType === 'gas') return;

    const { cx, cy, rx, ry } = this;
    const s = new Stream(this.planetSeed ^ 0x1b873593);
    const MAX = 55;   // settlements carry the main read; these are outlying lights
    const step = 2;

    const candidates: Array<{ x: number; y: number }> = [];
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
        candidates.push({ x: px, y: py - this.liftAtCell(cell, rr) });
      }
    }

    // Thin out to a readable scatter rather than a solid blanket of dots.
    const stride = Math.max(1, Math.ceil(candidates.length / MAX));
    for (let i = 0; i < candidates.length; i += stride) {
      const c = candidates[i];
      this.cityDots.push({
        x: c.x, y: c.y,
        phase: s.range(0, Math.PI * 2),
        rate:  s.range(0.5, 2.2),
      });
    }
  }

  /**
   * Populate the surface from the grid: creatures where life lives, settlements
   * where a civilisation has settled.
   *
   * Scatter positions come from the grid itself rather than being sprinkled at
   * random, so what the player sees is what the simulation actually holds —
   * a species only appears where `dominantSpeciesId` says it lives.
   */
  private buildInhabitants(): void {
    this.inhabitants = [];
    this.settlements = [];

    const grid = this.grid;
    if (!grid || this.planetType === 'gas') return;

    // Microbial life is not visible at this scale; showing creatures then would
    // misrepresent the simulation.
    const phase = this.star?.biologyPhase;
    if (phase === 'microbial') return;

    const byId = new Map<string, SpeciesGenome>();
    for (const sp of this.species) byId.set(sp.id, sp);

    const { cx, cy, rx, ry } = this;
    const s = new Stream(this.planetSeed ^ 0x5bf03635);

    // Deliberately sparse. The simulation marks almost every habitable cell as
    // inhabited, so drawing one sprite per qualifying cell tiled the whole
    // continent and read as wallpaper rather than as a living world.
    const MAX_CREATURES = 42;
    const MAX_SETTLEMENTS = 13;

    // On-screen size lives in SpeciesSprite.dioramaCreatureSprite (size class x
    // phase x depth); the sprite is baked at exactly that size and blitted 1:1.

    const creatureSpots: Array<{ x: number; y: number; id: string; onWater: boolean }> = [];
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
            x: px, y: py - lift, id: cell.dominantSpeciesId,
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
        x: spot.x, y: spot.y, sprite,
        w: sprite.width,
        h: sprite.height,
        phase: s.range(0, Math.PI * 2),
        sway: s.range(0.4, 1.5),
        depth,
        submersion: spot.onWater ? waterSubmersion(genome) : 0,
      });
    }

    /** Sample-lattice steps from a town to the nearest visual water / rim. */
    const distToVisualCoast = (px: number, py: number): number => {
      for (let rad = 0; rad < 48; rad++) {
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2;
          const sx = px + Math.cos(ang) * rad * step;
          const sy = py + Math.sin(ang) * rad * step;
          const dx = (sx - cx) / rx;
          const dy = (sy - cy) / ry;
          if (dx * dx + dy * dy > 0.97) return rad;
          if (!landKeys.has(sampleKey(sx, sy))) return rad;
        }
      }
      return 48;
    };

    // One entry per grid cell (screen oversampling otherwise floods the pool
    // with the same coastal shelf pixel), scored for inland depth × fertility.
    const byCell = new Map<string, {
      x: number; y: number; fertility: number; score: number; dCoast: number;
    }>();
    for (const spot of settlementSpots) {
      const dCoast = distToVisualCoast(spot.sx, spot.sy);
      const inland = Math.min(1, dCoast / 6);
      const score = spot.fertility * (0.2 + 0.8 * inland);
      const key = `${spot.row},${spot.col}`;
      const prev = byCell.get(key);
      if (!prev || score > prev.score) {
        byCell.set(key, {
          x: spot.x, y: spot.y, fertility: spot.fertility, score, dCoast,
        });
      }
    }
    const scored = [...byCell.values()].sort((a, b) => b.score - a.score);
    // Prefer sites at least ~2 sample steps inland; fall back if the landmasses
    // are too thin to support that many towns.
    const inlandEnough = scored.filter(s => s.dCoast >= 2);
    const ranked = inlandEnough.length >= MAX_SETTLEMENTS ? inlandEnough : scored;
    const townPool = ranked.slice(0, Math.max(60, ranked.length >> 2));
    const civLevel = this.star?.civLevel ?? 0;
    let idx = 0;
    for (const spot of scatter(townPool, MAX_SETTLEMENTS, rx * 0.13)) {
      const genome = this.species.find(sp => !sp.isExtinct && sp.dna.intelligence >= 3)
                  ?? this.species[0] ?? null;
      const sprite = bakeSettlementSprite(genome, civLevel, idx++, 1);
      const depth = (spot.y - (cy - ry)) / (ry * 2);
      const target = (5 + Math.min(civLevel, 6) * 0.7) * (0.85 + depth * 0.3);
      const aspect = sprite.height / sprite.width;
      this.settlements.push({
        x: spot.x, y: spot.y, sprite,
        w: Math.max(3, target),
        h: Math.max(3, target * aspect),
        depth,
      });
    }

    // Painter's algorithm — back of the disc first.
    this.inhabitants.sort((a, b) => a.depth - b.depth);
    this.settlements.sort((a, b) => a.depth - b.depth);
  }

  /** Blit creatures and settlements onto the top face. */
  private drawInhabitants(g: CanvasRenderingContext2D, t: number): void {
    if (this.inhabitants.length === 0 && this.settlements.length === 0) return;
    const { cx, cy, rx, ry } = this;
    const layerBob = this.habitable ? this.cutaway.drawGeom.bob : 0;

    g.save();
    g.beginPath();
    g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    g.clip();

    const surf = this.habitable ? cutawayWaterSurf(this.planetType as HabitableType) : null;

    for (const c of this.inhabitants) {
      // A small idle bob keeps the world alive without implying real movement.
      const bob = Math.sin(t * c.sway + c.phase) * 0.6;
      const dx = Math.round(c.x - c.w / 2);
      const dy = Math.round(c.y + layerBob - c.h + bob);

      if (c.submersion <= 0 || !surf) {
        g.drawImage(c.sprite, dx, dy, Math.round(c.w), Math.round(c.h));
        continue;
      }

      // Sink the body so only the unsubmerged fraction clears the waterline,
      // then tint what is under. The tint is applied INSIDE a scratch with
      // 'source-atop', so it lands on the animal's own pixels and never on the
      // sea — filling a rect straight onto the frame would leave a coloured box.
      const w = Math.max(1, Math.round(c.w)), h = Math.max(1, Math.round(c.h));
      if (!this.subScratch) this.subScratch = document.createElement('canvas');
      const sc = this.subScratch;
      if (sc.width < w || sc.height < h) { sc.width = Math.max(sc.width, w); sc.height = Math.max(sc.height, h); }
      const sg = sc.getContext('2d');
      if (!sg) { g.drawImage(c.sprite, dx, dy, w, h); continue; }

      sg.clearRect(0, 0, w, h);
      sg.globalCompositeOperation = 'source-over';
      sg.drawImage(c.sprite, 0, 0, w, h);

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

    for (const st of this.settlements) {
      g.drawImage(st.sprite,
        Math.round(st.x - st.w / 2), Math.round(st.y + layerBob - st.h),
        Math.round(st.w), Math.round(st.h));
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

  private frame(dt: number): void {
    if (this.habitable) {
      this.sky = this.skyNow();
      if (this.surfaceDirty &&
          this.elapsed - this.lastSurfaceBake > IsoDioramaRenderer.SURFACE_REBAKE_INTERVAL) {
        this.bakeSurface();
        this.buildCityDots();
        this.buildInhabitants();
      }
      this.cutaway.frame({
        g: this.ctx,
        dt,
        elapsed: this.elapsed,
        drawBackdrop: (g) => this.drawBackdropPanorama(g),
        sunAzimuth: this.dayAngle,
        sunLat: this.sky?.declination ?? 0,
        viewZoom: this.viewZoom,
        air: this.air,
        drawFarSpace: (g) => {
          this.drawSky(g);
          this.drawMoons(g, this.elapsed * (Math.PI * 2 / 60), false);
        },
        drawSurfaceOverlays: (g) => {
          this.drawCityLights(g, this.elapsed);
          this.drawInhabitants(g, this.elapsed);
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

  /** Backdrop panorama, slid left by the sun's true longitude (one turn a year). */
  private drawBackdropPanorama(g: CanvasRenderingContext2D): void {
    const W = this.bgLayer.width;
    const off = backdropOffset(this.sky?.sunLongitude ?? 0, W);
    g.drawImage(this.bgLayer, -off, 0);
    if (W - off < this.VW) g.drawImage(this.bgLayer, W - off, 0);
  }

  /**
   * The sun's faint outer wash beyond the painter's bloom core — a canvas
   * radial gradient, since the painter only rasterises `t < BLOOM_CORE` of
   * `L.bloom * sunSizeScale` to keep its per-pixel loop small. Continues the
   * painter's profile exactly where its core stops (0.07 at t = BLOOM_CORE).
   */
  private drawSunWash(g: CanvasRenderingContext2D, L: SkyLayout, sky: SkyState<Planet>, sunRgb: RGB): void {
    if (sky.sun.elev <= 0) return;
    const x = trackX(sky.sun.az, L), y = trackY(sky.sun.az, L);
    const R = L.bloom * sky.sun.sizeScale;
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
    const geom = this.habitable ? this.cutaway.drawGeom : { cx: this.cx, cyTop: this.cy, rx: this.rx };
    const homeR = this.planet?.orbitalRadius ?? 40;
    const sun = this.star ? tempToRGB(this.star.temperature) : rgb(255, 236, 180);
    const L = skyLayout(geom, this.VW, this.VH);
    img.data.fill(0);
    paintSky(img, L, {
      sunAz: sky.sun.az, sunElev: sky.sun.elev, sunSizeScale: sky.sun.sizeScale,
      sunRgb: [sun.r, sun.g, sun.b],
      siblings: sky.siblings.map(s => {
        const distN = Math.abs((s.planet.orbitalRadius ?? homeR) - homeR) / Math.max(homeR, 12);
        const c = planetTypeRGB(s.planet.type);
        return {
          az: s.az, elev: s.elev, litFraction: s.litFraction,
          radiusPx: Math.max(1.2, (2.2 + s.planet.radius * 0.20) / (1 + distN * 0.7)),
          rgb: [c.r, c.g, c.b] as [number, number, number],
        };
      }),
    });
    const sg = this.skyCanvas.getContext('2d');
    if (!sg) return;
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
  private drawMoons(g: CanvasRenderingContext2D, angle: number, front: boolean): void {
    const { cx, cy, rx, ry } = this;
    const moons = this.planet?.moons ?? [];
    if (moons.length === 0) return;

    for (let i = 0; i < moons.length; i++) {
      const m = moons[i];
      // Each moon runs at its own rate and starts from its own phase, so they
      // separate instead of moving as one rigid body.
      const speedMultiplier = 12;
      const a = m.orbitalAngle + angle * (m.orbitalSpeed * speedMultiplier);
      // Behind the planet for the far half of the orbit.
      const isFront = Math.sin(a) > 0;
      if (isFront !== front) continue;

      const dist = 1.55 + i * 0.34;
      const x = cx + Math.cos(a) * rx * dist;
      const y = this.habitable
        ? this.cutaway.drawGeom.cyTop - this.cutaway.drawGeom.ry * 1.35
          + Math.sin(a) * this.cutaway.drawGeom.R * 0.38
        : cy + Math.sin(a) * ry * 2.0 - rx * 0.22;
      // Scaled off the moon's real radius, floored so the smallest still reads.
      const r = Math.max(2, rx * 0.05 + m.radius * 3.2);
      const tint = hexToRGB(m.color);

      // Halo
      g.fillStyle = css(tint, 0.12);
      g.beginPath(); g.arc(x, y, r * 1.9, 0, Math.PI * 2); g.fill();
      // Body
      g.fillStyle = css(tint, 1);
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      // Terminator: away from the sun, deeper while it is down (sky/SunLight).
      const ms = moonShade(this.dayAngle);
      g.fillStyle = css(shade(tint, 0.45), ms.alpha);
      g.beginPath(); g.arc(x + r * ms.offset, y + r * 0.12, r * 0.92, 0, Math.PI * 2); g.fill();

      // Surface detail: craters on rock and iron, cracks on ice, glow on lava.
      if (m.kind === 'volcanic') {
        g.fillStyle = 'rgba(255,150,60,0.7)';
        for (const [dx, dy] of [[-0.25, -0.2], [0.3, 0.18], [0.05, 0.35]]) {
          g.beginPath(); g.arc(x + dx * r, y + dy * r, Math.max(0.6, r * 0.15), 0, Math.PI * 2); g.fill();
        }
      } else if (m.kind === 'ice' || m.kind === 'ocean') {
        g.strokeStyle = css(shade(tint, 0.7), 0.7);
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x - r * 0.7, y - r * 0.1); g.lineTo(x + r * 0.5, y + r * 0.3);
        g.moveTo(x - r * 0.2, y - r * 0.6); g.lineTo(x + r * 0.3, y + r * 0.6);
        g.stroke();
      } else {
        const craters = [[-0.30, -0.28, 0.19], [0.22, 0.30, 0.14], [-0.06, 0.12, 0.11]];
        for (const [dx, dy, cr] of craters) {
          g.fillStyle = css(shade(tint, 0.6), 0.6);
          g.beginPath(); g.arc(x + dx * r, y + dy * r, Math.max(0.6, cr * r), 0, Math.PI * 2); g.fill();
        }
      }

      // A settled moon carries the lights of its colony.
      if (m.colonised) {
        g.fillStyle = 'rgba(255,226,150,0.95)';
        for (const [dx, dy] of [[-0.35, 0.25], [0.1, -0.3], [0.42, 0.1]]) {
          g.fillRect(Math.round(x + dx * r), Math.round(y + dy * r), 1, 1);
        }
        g.strokeStyle = 'rgba(255,226,150,0.35)';
        g.lineWidth = 1;
        g.beginPath(); g.arc(x, y, r * 1.35, 0, Math.PI * 2); g.stroke();
      }
    }
  }

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
    for (const dot of this.cityDots) {
      const flicker = 0.55 + 0.45 * Math.sin(t * dot.rate + dot.phase);
      if (flicker < 0.35) continue;
      const dx = (dot.x - this.cx) / this.rx;
      const nightBias = clamp01(0.55 - sunFacing(dx, this.dayAngle) * 0.85);
      const a = flicker * (0.35 + nightBias * 0.65);
      g.fillStyle = `rgba(255,226,150,${a})`;
      g.fillRect(dot.x, dot.y + layerBob, 1, 1);
      if (a > 0.75) {
        g.fillStyle = `rgba(255,200,110,${a * 0.25})`;
        g.fillRect(dot.x - 1, dot.y + layerBob, 3, 1);
        g.fillRect(dot.x, dot.y + layerBob - 1, 1, 3);
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
    let x = this.cx, y = this.cy, reach = this.rx * 0.85;

    if (cell) {
      const d = this.gridToDisc(cell.row, cell.col);
      if (d) {
        x = this.cx + d.dx * this.rx;
        y = this.cy + d.dy * this.ry;
        const gc = this.grid?.[cell.row]?.[cell.col];
        if (gc) y -= this.liftAtCell(gc, Math.hypot(d.dx, d.dy));
        reach = this.rx * 0.28;
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

    this.effects.push({ kind, x, y, reach, age: 0, motes });
    // Bound the queue: spamming a power should not stack unbounded work.
    if (this.effects.length > 6) this.effects.shift();
  }

  /** Divine acts: expanding rings, rising motes, beams and light washes. */
  private drawDivineEffects(g: CanvasRenderingContext2D, dt: number): void {
    if (this.effects.length === 0) return;
    const { cx, cy, rx, ry } = this;
    const bodyRadius = this.habitable ? this.cutaway.drawGeom.R : rx;

    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      const style = EFFECT_STYLES[fx.kind];
      fx.age += dt;
      if (fx.age > style.life) { this.effects.splice(i, 1); continue; }

      const t = fx.age / style.life;          // 0 → 1 over the effect's life
      const fade = 1 - t * t;                 // holds bright, then drops away

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
        const wr = fx.reach * (1 + t * 1.6);
        const wash = g.createRadialGradient(fx.x, fx.y, 0, fx.x, fx.y, wr);
        wash.addColorStop(0, css(style.color, style.wash * fade));
        wash.addColorStop(0.55, css(style.color, style.wash * fade * 0.45));
        wash.addColorStop(1, css(style.color, 0));
        g.fillStyle = wash;
        g.beginPath(); g.arc(fx.x, fx.y, wr, 0, Math.PI * 2); g.fill();
      }

      // A shaft of light from the top of the atmosphere down onto the target.
      // The habitable body has no dome above the face — its ceiling IS the face
      // rim — so the beam has to start there or it hangs in space.
      if (style.beam) {
        const beamW = Math.max(3, fx.reach * 0.28);
        const beamTop = this.habitable ? this.bodyCy - bodyRadius + 1 : cy - rx;
        const grad = g.createLinearGradient(fx.x, beamTop, fx.x, fx.y);
        grad.addColorStop(0, css(style.color, 0));
        grad.addColorStop(1, css(style.color, 0.55 * fade));
        g.fillStyle = grad;
        g.fillRect(fx.x - beamW / 2, beamTop, beamW, fx.y - beamTop);
      }

      // Rings expanding outward along the ground plane, so they read as lying on
      // the surface rather than standing up in the air.
      for (let k = 0; k < style.rings; k++) {
        const offset = k / Math.max(1, style.rings) * 0.45;
        const rt = t + offset;
        if (rt > 1) continue;
        const rr = fx.reach * rt;
        g.globalAlpha = (1 - rt) * 0.85 * fade;
        g.strokeStyle = css(style.color, 1);
        g.lineWidth = Math.max(1, 2 * (1 - rt));
        g.beginPath();
        g.ellipse(fx.x, fx.y, rr, rr * (ry / rx), 0, 0, Math.PI * 2);
        g.stroke();
      }

      // Motes.
      g.globalAlpha = fade;
      g.fillStyle = css(style.color, 1);
      for (const m of fx.motes) {
        if (fx.age < m.born) continue;
        const mt = fx.age - m.born;
        const px = m.x + m.vx * mt + Math.sin(mt * 3 + m.swirl) * 3;
        const py = m.y + m.vy * mt;
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

    const draw = (cell: { row: number; col: number }, colour: string, width: number) => {
      const p = this.gridToDisc(cell.row, cell.col);
      if (!p) return;
      const px = cx + p.dx * rx;
      const py = cy + p.dy * ry;

      // Size the marker from the projected spacing of neighbouring cells so it
      // stays roughly one tile across wherever it lands on the disc.
      const n = this.gridToDisc(cell.row, (cell.col + 3) % GRID_SIZE);
      const span = n ? Math.max(2, Math.abs((n.dx - p.dx) * rx) * 1.2) : 3;
      const w = Math.min(14, Math.max(2.5, span));
      const h = Math.max(1.5, w * 0.42);

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

