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
import type { Planet, StarBody } from '../simulation/BigBangEngine';
import { bakeCreatureSprite, bakeSettlementSprite } from './SpeciesSprite';
import {
  HabitableCutawayEngine,
  type HabitableType,
} from './HabitableCutawayEngine';

// ─── Planet type palettes ──────────────────────────────────────────────────────

export type PlanetType = 'ocean' | 'rocky' | 'lava' | 'ice' | 'gas';

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

// ─── Weather ──────────────────────────────────────────────────────────────────

/**
 * What kind of cloud is in the sky.
 *
 * The diorama used to have exactly one: a white puff, identical on every world
 * regardless of what that world was actually like. A molten planet and a
 * heavily industrialised one had the same weather. Each kind here is chosen from
 * real planet and biosphere state (see `cloudMixFor`), so the sky reports
 * something true about the world under it.
 */
export type CloudKind =
  | 'cumulus'     // benign fair-weather cloud
  | 'storm'       // dark, heavy, lightning, hard rain
  | 'acid'        // sickly yellow-green; acid rain
  | 'pollution'   // industrial smog — only where a civilisation makes it
  | 'ash'         // volcanic ash plume, falls as dark grit
  | 'nebula'      // luminous exotic vapour on worlds bathed in nebula light
  | 'ice_haze';   // thin frozen veil; falls as snow

export type PrecipKind = 'none' | 'rain' | 'acid_rain' | 'snow' | 'ashfall';

interface CloudProfile {
  /** Body colour of the puff. */
  body:      RGB;
  /** Shaded underside. */
  under:     RGB;
  /** Alpha range for individual clouds of this kind. */
  alphaLo:   number;
  alphaHi:   number;
  precip:    PrecipKind;
  /** Chance per second that a cloud of this kind flashes. */
  lightning: number;
  /** Clouds of this kind glow rather than only occluding. */
  emissive:  boolean;
}

const CLOUD_PROFILES: Record<CloudKind, CloudProfile> = {
  cumulus: {
    body: rgb(255, 255, 255), under: rgb(150, 180, 215),
    alphaLo: 0.50, alphaHi: 0.95, precip: 'none', lightning: 0, emissive: false,
  },
  storm: {
    body: rgb(118, 124, 140), under: rgb(48, 54, 70),
    alphaLo: 0.80, alphaHi: 1.00, precip: 'rain', lightning: 0.5, emissive: false,
  },
  acid: {
    body: rgb(206, 224, 120), under: rgb(120, 140, 48),
    alphaLo: 0.62, alphaHi: 0.92, precip: 'acid_rain', lightning: 0.12, emissive: false,
  },
  pollution: {
    body: rgb(150, 132, 108), under: rgb(84, 70, 56),
    alphaLo: 0.55, alphaHi: 0.88, precip: 'none', lightning: 0, emissive: false,
  },
  ash: {
    body: rgb(96, 88, 86), under: rgb(40, 34, 34),
    alphaLo: 0.70, alphaHi: 0.98, precip: 'ashfall', lightning: 0.30, emissive: false,
  },
  nebula: {
    body: rgb(190, 150, 235), under: rgb(110, 80, 170),
    alphaLo: 0.40, alphaHi: 0.72, precip: 'none', lightning: 0, emissive: true,
  },
  ice_haze: {
    body: rgb(226, 242, 252), under: rgb(160, 196, 224),
    alphaLo: 0.35, alphaHi: 0.66, precip: 'snow', lightning: 0, emissive: false,
  },
};

/** Colour and shape of one falling particle, by precipitation kind. */
const PRECIP_STYLE: Record<Exclude<PrecipKind, 'none'>, {
  color: string; len: number; speed: number; drift: number; count: number;
}> = {
  rain:      { color: 'rgba(150,190,232,0.42)', len: 2, speed: 62, drift: 6,  count: 12 },
  acid_rain: { color: 'rgba(190,222,105,0.50)', len: 2, speed: 54, drift: 5,  count: 11 },
  snow:      { color: 'rgba(240,250,255,0.70)', len: 1, speed: 14, drift: 11, count: 12 },
  ashfall:   { color: 'rgba(64,56,54,0.62)',    len: 1, speed: 20, drift: 8,  count: 12 },
};

interface Drop { x: number; y: number; vy: number; drift: number; phase: number }

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

interface Cloud {
  x: number; y: number; w: number; h: number;
  alpha: number; speed: number; sprite: HTMLCanvasElement;
  kind: CloudKind;
  /** Falling particles under this cloud, empty when it does not precipitate. */
  drops: Drop[];
  /** Seconds remaining on the current lightning flash, 0 when dark. */
  flash: number;
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

  // Data
  private grid:        PlanetGrid | null = null;
  private biosphere:   PlanetBiosphere | null = null;
  private species:     SpeciesGenome[] = [];
  private planet:      Planet | null = null;
  private planetType:  PlanetType = 'ocean';
  private star:        StarBody | null = null;
  private planetIndex  = 0;

  // Projection focus — lat/lon of the continent the disc is centred on
  private focusLat = 0;
  private focusLon = 0;

  // Props
  private clouds:   Cloud[]   = [];
  /** Signature of the weather mix the current clouds were built from. */
  private lastCloudSig = '';
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
  }> = [];
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

  get canvas(): HTMLCanvasElement { return this.display; }

  // ── Geometry (in virtual pixels) ────────────────────────────────────────────

  /**
   * Does this world bake through {@link HabitableCutawayEngine}?
   *
   * Ocean and rocky worlds are the ones the mockup describes — a sliced planet
   * with a biome tabletop and a layered crust. Lava, ice and gas keep the legacy
   * floating-disc-under-glass bake until Phase 2 gives each of them its own
   * treatment; switching them over now would leave three worlds looking like a
   * half-finished ocean.
   */
  private get habitable(): boolean {
    return this.planetType === 'ocean' || this.planetType === 'rocky';
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
    return Math.round(Math.min(this.VW * 0.30, this.VH * 0.42));
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

  /** Height of the water cut band directly under the rim. */
  private get cutH(): number { return Math.round(this.rx * 0.13); }
  /** Depth of the rock crust below the cut band. */
  private get crustH(): number { return Math.round(this.rx * 0.88); }

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
    mount.appendChild(this.display);

    this.buf = document.createElement('canvas');
    const bctx = this.buf.getContext('2d', { alpha: false });
    if (!bctx) throw new Error('IsoDioramaRenderer: backbuffer context unavailable');
    this.ctx = bctx;

    this.bgLayer      = document.createElement('canvas');
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

    this.bakeAll();
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
    // Habitable: diorama_test tiers scaled up (1/3/6 → 2/5/9) so height, species
    // and settlements read on the flat board. Legacy keeps its taller disc lift.
    if (this.habitable) return 9;
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
      if (elev > 0.72) return 9;
      if (elev > 0.58) return 5;
      return 2;
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
      lush: bio ? clamp01((bio.biodiversity / 10) * 0.55 + bio.landLife * 0.45) : 0.3,
      weatherMix: this.cloudMixFor(),
    });
    this.pickBuf = this.cutaway.pick;
    this.lastSurfaceBake = this.elapsed;
    this.surfaceDirty = false;
  }

  /** Repaint only habitable terrain; animation-owned cutaway state remains live. */
  private rebakeHabitableSurface(): void {
    this.cutaway.rebakeSurface();
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
    this.buildClouds();
    this.buildCityDots();
    this.buildRipples();
    this.buildInhabitants();
    this.embers = [];
  }

  // Space background: gradient, nebula band, star field.
  private bakeBackground(): void {
    const g = this.bgLayer.getContext('2d')!;
    const { VW, VH } = this;
    g.clearRect(0, 0, VW, VH);

    const grad = g.createLinearGradient(0, 0, VW * 0.4, VH);
    grad.addColorStop(0, '#080a1c');
    grad.addColorStop(0.55, '#050614');
    grad.addColorStop(1, '#02030c');
    g.fillStyle = grad;
    g.fillRect(0, 0, VW, VH);

    // Nebula band sweeping across the frame (matches the reference backdrop).
    const s = new Stream(this.planetSeed ^ 0x9e3779b9);
    const bandAngle = s.range(-0.55, -0.20);
    g.save();
    g.translate(VW * s.range(0.45, 0.75), VH * s.range(0.25, 0.6));
    g.rotate(bandAngle);
    for (let i = 0; i < 5; i++) {
      const w = VW * s.range(0.5, 0.95);
      // Aspect is capped — a very thin ellipse rotates into what looks like a
      // lens-flare beam rather than a nebula.
      const h = w * s.range(0.30, 0.55);
      const cxo = s.range(-VW * 0.2, VW * 0.2);
      const cyo = s.range(-VH * 0.08, VH * 0.08);
      const neb = g.createRadialGradient(cxo, cyo, 0, cxo, cyo, w / 2);
      const tint = s.next() > 0.5 ? '90,110,200' : '120,90,180';
      // Kept faint — a bright band reads as a lens flare streaking the frame.
      neb.addColorStop(0, `rgba(${tint},0.07)`);
      neb.addColorStop(0.5, `rgba(${tint},0.028)`);
      neb.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = neb;
      g.save();
      g.scale(1, h / w);
      g.beginPath();
      g.arc(cxo, cyo * w / h, w / 2, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    g.restore();

    // Star field — three brightness tiers, warm/cool mix.
    const count = Math.round(VW * VH / 900);
    for (let i = 0; i < count; i++) {
      const x = Math.floor(s.next() * VW);
      const y = Math.floor(s.next() * VH);
      const t = s.next();
      if (t > 0.965) {
        // Bright star with a cross flare
        const c = s.next() > 0.5 ? '255,240,210' : '210,230,255';
        g.fillStyle = `rgba(${c},0.95)`;
        g.fillRect(x, y, 1, 1);
        g.fillStyle = `rgba(${c},0.35)`;
        g.fillRect(x - 1, y, 1, 1); g.fillRect(x + 1, y, 1, 1);
        g.fillRect(x, y - 1, 1, 1); g.fillRect(x, y + 1, 1, 1);
      } else if (t > 0.80) {
        g.fillStyle = `rgba(255,250,240,${0.55 + s.next() * 0.35})`;
        g.fillRect(x, y, 1, 1);
      } else {
        g.fillStyle = `rgba(200,215,255,${0.14 + s.next() * 0.28})`;
        g.fillRect(x, y, 1, 1);
      }
    }
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
    const bio = this.biosphere;
    // Higher biodiversity / land colonisation → greener, lusher land.
    // biodiversity is a SPECIES COUNT on a 0–10 scale, not a 0–1 fraction;
    // treating it as a fraction saturated `lush` as soon as a second species
    // appeared and flattened every continent to the same green.
    const lush = bio
      ? clamp01((bio.biodiversity / 10) * 0.55 + bio.landLife * 0.45)
      : 0.3;

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
    const R = Math.round(Math.min(VW * 0.32, VH * 0.42));
    const seed = this.planetSeed;
    const s = new Stream(seed ^ 0x6a09e667);

    // Per-world band palette so no two gas giants look alike.
    const hueBase = s.range(0, 360);
    const bandCount = 9 + s.int(0, 5);
    const bands: RGB[] = [];
    for (let i = 0; i < bandCount; i++) {
      const warm = s.next() > 0.42;
      const hue = (hueBase + (warm ? s.range(-18, 18) : s.range(140, 210))) % 360;
      const sat = warm ? s.range(0.28, 0.55) : s.range(0.18, 0.40);
      const val = s.range(0.34, 0.86);
      bands.push(hsvToRGB(hue, sat, val));
    }

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

        // Zonal turbulence: bands shear along their own latitude.
        const turb = fbm1(latN * 7.5 + dx * 1.6, seed + 3, 4) * 0.55
                   + fbm1(latN * 22 + dx * 4.0, seed + 91, 3) * 0.22;
        // Lerp between adjacent bands rather than snapping to one — hard band
        // indices draw visible contour staircases across the sphere.
        const bandF = (latN * 0.5 + 0.5) * bandCount + (turb - 0.38) * 1.5;
        const i0 = Math.max(0, Math.min(bandCount - 1, Math.floor(bandF)));
        const i1 = Math.max(0, Math.min(bandCount - 1, i0 + 1));
        const ft0 = clamp01(bandF - Math.floor(bandF));
        const ft = ft0 * ft0 * (3 - 2 * ft0);
        const c0 = bands[i0], c1 = bands[i1];
        // Fine curl texture inside each band.
        const curl = 0.94 + fbm1(latN * 60 + dx * 9, seed + 707, 2) * 0.13;
        let cr = mix(c0.r, c1.r, ft) * curl;
        let cg = mix(c0.g, c1.g, ft) * curl;
        let cb = mix(c0.b, c1.b, ft) * curl;

        // Lighting: key from upper-left, limb darkening toward the edge.
        const lambert = clamp01(-dx * 0.62 - dy * 0.42 + dz * 0.66);
        const limb = Math.pow(dz, 0.34);
        const f = (0.22 + lambert * 0.95) * limb;

        // Polar haze
        const polar = Math.pow(Math.abs(latN), 5) * 0.5;
        cr = mix(cr * f, 200, polar);
        cg = mix(cg * f, 210, polar);
        cb = mix(cb * f, 225, polar);

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

    const stormLat = s.range(-0.5, 0.5);
    const sx = cx + s.range(-R * 0.45, R * 0.45);
    const sy = cyG + stormLat * R;
    const sr = R * s.range(0.13, 0.22);
    const stormC = bands[s.int(0, bands.length - 1)];
    for (let i = 5; i >= 1; i--) {
      g.fillStyle = css(shade(stormC, 0.7 + i * 0.12), 0.55);
      ellipse(g, sx, sy, sr * (i / 5), sr * (i / 5) * 0.45);
    }
    g.strokeStyle = css(shade(stormC, 1.5), 0.5);
    g.lineWidth = 1;
    g.beginPath();
    g.ellipse(sx, sy, sr, sr * 0.45, 0, 0, Math.PI * 2);
    g.stroke();

    // Terminator shadow on the unlit limb.
    const term = g.createRadialGradient(
      cx - R * 0.45, cyG - R * 0.35, R * 0.2,
      cx - R * 0.45, cyG - R * 0.35, R * 1.9,
    );
    term.addColorStop(0, 'rgba(0,0,0,0)');
    term.addColorStop(1, 'rgba(0,0,10,0.72)');
    g.fillStyle = term;
    g.fillRect(cx - R, cyG - R, R * 2, R * 2);
    g.restore();

    // Atmospheric limb glow
    const glow = g.createRadialGradient(cx, cyG, R * 0.94, cx, cyG, R * 1.14);
    glow.addColorStop(0, css(PALETTES.gas.halo, 0));
    glow.addColorStop(0.4, css(PALETTES.gas.halo, 0.22));
    glow.addColorStop(1, css(PALETTES.gas.halo, 0));
    g.fillStyle = glow;
    g.fillRect(cx - R * 1.2, cyG - R * 1.2, R * 2.4, R * 2.4);

    // ── Ring: the half in front ──────────────────────────────────────────────
    drawRing(false);
  }

  // ─── Prop construction ─────────────────────────────────────────────────────

  /**
   * The weather this world actually deserves, as weights per cloud kind.
   *
   * Every input here is real simulation state, so the sky changes as the planet
   * does: a world that industrialises grows smog, one whose biosphere is under
   * pressure turns stormy, a molten one throws ash. A world with none of those
   * conditions still just gets fair weather.
   */
  private cloudMixFor(): Array<{ kind: CloudKind; weight: number }> {
    const bio  = this.biosphere;
    const civ  = this.star?.civLevel ?? 0;
    const type = this.planetType;

    const mix: Array<{ kind: CloudKind; weight: number }> = [];
    const add = (kind: CloudKind, weight: number) => {
      if (weight > 0.001) mix.push({ kind, weight });
    };

    if (type === 'lava') {
      add('ash', 3.0);
      add('storm', 0.6);
      add('acid', 0.8);
      return mix;
    }
    if (type === 'ice') {
      add('ice_haze', 3.0);
      add('cumulus', 0.8);
      add('storm', 0.4);
      return mix;
    }

    // Baseline fair weather, scaled by how much ocean there is to evaporate.
    add('cumulus', 1.6 + (bio?.oceanLife ?? 0.4) * 2.0);

    // A biosphere under pressure is a world with a violent climate.
    add('storm', 0.5 + (bio?.extinctionPressure ?? 0) * 2.6);

    // Industry makes smog, and only industry does: no civilisation, no smog.
    // civLevel 4 is the Atomic tier — the first that plausibly pollutes.
    if (civ >= 4) add('pollution', (civ - 3) * 0.75);

    // Thin or unbreathable air reads as an acidic sky.
    const oxy = bio?.oxygenLevel ?? 0.5;
    add('acid', clamp01(0.42 - oxy) * 3.2);

    // Exotic light: only for worlds sitting in a nebula-lit part of the disc.
    if (this.inNebula()) add('nebula', 1.4);

    return mix;
  }

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

  /** Stable string for the current weather mix, to detect real changes. */
  private cloudMixSignature(): string {
    return this.cloudMixFor()
      .map(m => `${m.kind}:${m.weight.toFixed(1)}`)
      .join('|');
  }

  private buildClouds(): void {
    this.clouds = [];
    this.lastCloudSig = this.cloudMixSignature();
    if (this.habitable) return;
    // Gated on the planet TYPE, not on `hasDome`. Ash and acid are properties of
    // an atmosphere, not of the glass: a molten world has the most dramatic sky
    // of any of them and used to render with an empty one, because it is the one
    // planet type that has no dome. Only the gas giant is excluded — it draws a
    // whole banded sphere and already has weather of its own.
    if (this.planetType === 'gas') return;

    const { cx, cy, rx, ry } = this;
    const s = new Stream(this.planetSeed ^ 0x7f4a7c15);
    const bio = this.biosphere;
    const humid = bio ? clamp01(0.35 + bio.oceanLife * 0.4) : 0.5;
    const n = 5 + Math.round(humid * 5);

    const mix = this.cloudMixFor();
    const total = mix.reduce((a, m) => a + m.weight, 0);
    const pickKind = (): CloudKind => {
      if (total <= 0) return 'cumulus';
      let roll = s.next() * total;
      for (const m of mix) { roll -= m.weight; if (roll <= 0) return m.kind; }
      return mix[mix.length - 1].kind;
    };

    for (let i = 0; i < n; i++) {
      const kind = pickKind();
      const prof = CLOUD_PROFILES[kind];
      // Storm and ash heads are bigger and slower; haze is broad and thin.
      const sizeMul = kind === 'storm' || kind === 'ash' ? 1.30
                    : kind === 'ice_haze' ? 1.45 : 1.0;
      const w = s.range(rx * 0.16, rx * 0.42) * sizeMul;
      const h = w * s.range(0.22, 0.36) * (kind === 'ice_haze' ? 0.62 : 1);
      const x = cx + s.range(-rx, rx);
      const y = cy - ry * s.range(0.1, 0.9) - rx * s.range(0.05, 0.42);

      const drops: Drop[] = [];
      if (prof.precip !== 'none') {
        const st = PRECIP_STYLE[prof.precip];
        for (let k = 0; k < st.count; k++) {
          drops.push({
            x: s.range(-w * 0.45, w * 0.45),
            // Stagger the initial fall so it does not start as a single sheet.
            y: s.range(0, ry * 1.9 + rx * 0.42),
            vy: st.speed * s.range(0.82, 1.18),
            drift: st.drift * s.range(-1, 1),
            phase: s.range(0, Math.PI * 2),
          });
        }
      }

      this.clouds.push({
        x, y, w, h,
        alpha: s.range(prof.alphaLo, prof.alphaHi),
        // Heavy weather moves slowly; thin haze streams past.
        speed: s.range(2.5, 7.0) * (kind === 'storm' || kind === 'ash' ? 0.55 : 1),
        sprite: makeCloudSprite(Math.round(w), Math.round(h), s.int(1, 1 << 20), kind),
        kind,
        drops,
        flash: 0,
      });
    }
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

    // On-screen size in virtual pixels, by size class. This is set here rather
    // than taken from the baked sprite: sprite canvases carry margin for fins
    // and wings, and blitting them 1:1 made a "medium" animal 27px wide on a
    // 270px world.
    const SIZE_PX: Record<string, number> = {
      microscopic: 2.5, tiny: 4, small: 5.5, medium: 7.5, large: 10, massive: 13.5,
    };

    const phaseScale = phase === 'multicellular' ? 0.55
                     : phase === 'complex'       ? 0.78
                     : phase === 'primitive'     ? 0.92
                     : 1.0;

    const creatureSpots: Array<{ x: number; y: number; id: string }> = [];
    const settlementSpots: Array<{ x: number; y: number; fertility: number }> = [];

    const step = 3;
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
        if (cell.civId != null && onLand) {
          settlementSpots.push({ x: px, y: py - lift, fertility: cell.fertility });
        } else if (cell.dominantSpeciesId && cell.lifeDensity > 0.35) {
          // Test the elevation the SURFACE WAS DRAWN FROM, not the grid's own.
          // `rimFalloff` sinks the outer hemisphere so the projection reads as a
          // continent in an ocean, and the cells it sinks keep their land biome
          // and their life density — so a walking animal placed off the raw grid
          // ends up standing on open water, and the whole rim rings with
          // creatures wading in the sea.
          const swims = byId.get(cell.dominantSpeciesId)?.dna.locomotion === 'swimming';
          if (this.habitable && !onLand && !swims) continue;
          creatureSpots.push({ x: px, y: py - lift, id: cell.dominantSpeciesId });
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
      const sprite = bakeCreatureSprite(genome, 1);
      // Perspective: things near the front of the disc read slightly larger.
      const depth = (spot.y - (cy - ry)) / (ry * 2);
      const target = (SIZE_PX[genome.physicalTraits.size] ?? 5)
                   * phaseScale * (0.8 + depth * 0.4);
      const aspect = sprite.height / sprite.width;
      this.inhabitants.push({
        x: spot.x, y: spot.y, sprite,
        w: Math.max(2, target),
        h: Math.max(2, target * aspect),
        phase: s.range(0, Math.PI * 2),
        sway: s.range(0.4, 1.5),
        depth,
      });
    }

    // Towns sit on the best ground available.
    settlementSpots.sort((a, b) => b.fertility - a.fertility);
    const townPool = settlementSpots.slice(0, Math.max(60, settlementSpots.length >> 2));
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

    for (const c of this.inhabitants) {
      // A small idle bob keeps the world alive without implying real movement.
      const bob = Math.sin(t * c.sway + c.phase) * 0.6;
      g.drawImage(c.sprite,
        Math.round(c.x - c.w / 2), Math.round(c.y + layerBob - c.h + bob),
        Math.round(c.w), Math.round(c.h));
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
        bg: this.bgLayer,
        drawFarSpace: (g) => {
          this.drawStarBloom(g, this.elapsed);
          this.drawSiblings(g, this.elapsed);
          this.drawMoons(g, this.elapsed * (Math.PI * 2 / 60), false);
        },
        drawOverlays: (g) => {
          this.drawCityLights(g, this.elapsed);
          this.drawInhabitants(g, this.elapsed);
          this.drawTileMarkers(g, this.elapsed);
          this.drawDivineEffects(g, dt);
        },
        drawNearMoons: (g) => {
          this.drawMoons(g, this.elapsed * (Math.PI * 2 / 60), true);
        },
        weatherMix: this.cloudMixFor(),
      });
      this.displayCtx.drawImage(this.buf, 0, 0);
      return;
    }

    const g = this.ctx;
    const { VW, VH, cx, cy, rx, ry } = this;
    const t = this.elapsed;
    const pal = PALETTES[this.planetType];

    if (this.surfaceDirty &&
        t - this.lastSurfaceBake > IsoDioramaRenderer.SURFACE_REBAKE_INTERVAL) {
      this.bakeSurface();
      this.buildCityDots();
      this.buildInhabitants();
      // Weather has to follow the planet too — a world that industrialises
      // should grow smog, one whose biosphere collapses should turn stormy.
      // Rebuilt only when the MIX changes, because an unconditional rebuild
      // teleports every cloud back to a new random position every few seconds.
      const sig = this.cloudMixSignature();
      if (sig !== this.lastCloudSig) {
        this.lastCloudSig = sig;
        this.buildClouds();
      }
    }

    // 1 — space backdrop
    g.drawImage(this.bgLayer, 0, 0);

    // 2 — parent star bloom (slow drift, colour by temperature)
    this.drawStarBloom(g, t);

    // 3 — sibling planets, far behind
    this.drawSiblings(g, t);

    // 4 — atmospheric halo behind the body. A gas giant is a full sphere
    // centred in the frame, not a disc, so its halo is centred too.
    //
    // SKIPPED on the habitable path. A 1.45×-radius pulsing glow is the single
    // biggest reason the old earth-like worlds read as "soft blob in space"
    // instead of the mockup's hard-edged planet; those worlds get the thin baked
    // shell at step 12b instead.
    const isGas = this.planetType === 'gas';
    const haloCy = isGas ? VH * 0.5 : cy + ry * 0.4;
    const haloR = rx * (isGas ? 1.35 : 1.45);
    // For a gas giant the glow must start outside the body, or it washes the
    // whole sphere in atmosphere colour.
    const haloInner = rx * (isGas ? 1.02 : 0.6);
    const halo = g.createRadialGradient(cx, haloCy, haloInner, cx, haloCy, haloR);
    const pulse = (isGas ? 0.05 : 0.16) + (isGas ? 0.02 : 0.05) * Math.sin(t * 0.6);
    halo.addColorStop(0, css(pal.halo, pulse));
    halo.addColorStop(0.55, css(pal.halo, pulse * 0.45));
    halo.addColorStop(1, css(pal.halo, 0));
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

    // 11 — clouds inside the dome
    this.drawClouds(g, dt);

    // 12 — the glass dome itself (gas giants have neither dome nor cut face)
    if (pal.hasDome) this.drawDome(g, t);
    else if (!isGas) this.drawHaze(g, t);

    // 13 — moons on the near half of their orbits, in front of the dome
    this.drawMoons(g, moonAngle, true);

    // 14 — vignette. Centred on the BODY, not the cut face: the habitable
    // silhouette reaches a full radius below the ellipse, and a vignette hung
    // off the face darkens the bottom third of the planet.
    const vig = g.createRadialGradient(cx, cy, rx * 0.7, cx, cy, Math.max(VW, VH) * 0.75);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = vig;
    g.fillRect(0, 0, VW, VH);

    // Blit the low-res buffer to the display canvas at 1:1 virtual pixels.
    this.displayCtx.drawImage(this.buf, 0, 0);
  }

  private drawStarBloom(g: CanvasRenderingContext2D, t: number): void {
    const { VW, VH } = this;
    const col = this.star ? tempToRGB(this.star.temperature) : rgb(255, 236, 180);
    const x = VW * 0.13 + Math.cos(t * 0.05) * VW * 0.02;
    const y = VH * 0.13 + Math.sin(t * 0.05) * VH * 0.02;
    const R = Math.min(VW, VH) * 0.42;

    const grad = g.createRadialGradient(x, y, 0, x, y, R);
    grad.addColorStop(0, css(col, 0.55));
    grad.addColorStop(0.10, css(col, 0.22));
    grad.addColorStop(0.35, css(col, 0.07));
    grad.addColorStop(1, css(col, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, VW, VH);

    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.beginPath(); g.arc(x, y, 2.5, 0, Math.PI * 2); g.fill();
    // Lens flare spikes
    g.strokeStyle = css(col, 0.35);
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x - 12, y); g.lineTo(x + 12, y);
    g.moveTo(x, y - 12); g.lineTo(x, y + 12);
    g.stroke();
  }

  private drawSiblings(g: CanvasRenderingContext2D, t: number): void {
    const planets = this.star?.planets;
    if (!planets || planets.length < 2) return;
    const { VW, VH, cx, cy } = this;

    const siblings = planets.filter((_, i) => i !== this.planetIndex).slice(0, 4);
    // Same reason as the moons: the habitable cut face is not the centre of the
    // frame, so the far half of each orbit has to be measured from the body.
    const baseY = this.habitable ? this.bodyCy : cy;
    for (let i = 0; i < siblings.length; i++) {
      const p = siblings[i];
      const period = 95 + i * 40;
      const angle = t * (Math.PI * 2 / period) + (i / siblings.length) * Math.PI * 2;
      const ox = Math.cos(angle) * VW * (0.30 + i * 0.09);
      const oy = Math.sin(angle) * VH * (0.30 + i * 0.07);
      const x = cx + ox, y = baseY + oy - VH * 0.12;
      if (x < -8 || x > VW + 8 || y < -8 || y > VH + 8) continue;

      const c = planetTypeRGB(p.type);
      const pr = Math.max(1.5, 1.5 + p.radius * 0.22);
      g.fillStyle = css(c, 0.16);
      g.beginPath(); g.arc(x, y, pr + 2, 0, Math.PI * 2); g.fill();
      g.fillStyle = css(c, 0.9);
      g.beginPath(); g.arc(x, y, pr, 0, Math.PI * 2); g.fill();
      // Terminator: the far side is unlit
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.beginPath(); g.arc(x - pr * 0.35, y + pr * 0.2, pr * 0.85, 0, Math.PI * 2); g.fill();
    }
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

      const dist = 1.45 + i * 0.30;
      const x = cx + Math.cos(a) * rx * dist;
      // Orbit the BODY on the habitable path. Hanging the orbit off the cut face
      // (which sits a full radius above the body's centre) threw the far half of
      // every orbit off the top of the frame.
      const y = this.habitable
        ? this.bodyCy + Math.sin(a) * rx * dist * 0.55
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
      // Terminator, lit from the same side as the world below.
      g.fillStyle = css(shade(tint, 0.45), 0.6);
      g.beginPath(); g.arc(x - r * 0.30, y + r * 0.12, r * 0.92, 0, Math.PI * 2); g.fill();

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
      const nightBias = clamp01(0.55 - dx * 0.45);
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

  private drawClouds(g: CanvasRenderingContext2D, dt: number): void {
    if (this.clouds.length === 0) return;
    const { cx, cy, rx, ry } = this;

    g.save();
    // Clouds live inside the atmosphere. On the habitable path that is the body
    // circle, which sits a full radius below the cut face; on the legacy path it
    // is the dome, centred on the face.
    g.beginPath();
    if (this.habitable) g.arc(cx, this.bodyCy, rx - 1, 0, Math.PI * 2);
    else g.arc(cx, cy, rx, 0, Math.PI * 2);
    g.clip();

    // ── Precipitation, drawn under the clouds that produce it ────────────────
    for (const c of this.clouds) {
      const prof = CLOUD_PROFILES[c.kind];
      if (prof.precip === 'none' || c.drops.length === 0) continue;
      const st = PRECIP_STYLE[prof.precip];
      // Fall stops at the ground: the top face is an ellipse, so the surface
      // under a given x sits at cy + ry·sqrt(1-(dx/rx)²) at its nearest.
      g.strokeStyle = st.color;
      g.fillStyle = st.color;
      g.lineWidth = 1;
      for (const drop of c.drops) {
        drop.y += drop.vy * dt;
        drop.phase += dt * 2.2;
        const px = c.x + drop.x + Math.sin(drop.phase) * drop.drift;
        const py = c.y + drop.y;
        const ndx = (px - cx) / rx;
        const ground = cy + (Math.abs(ndx) < 1 ? ry * Math.sqrt(1 - ndx * ndx) : 0);
        if (py > ground || py > cy + ry) {
          // Landed — restart it just under its cloud.
          drop.y = -c.h * 0.3;
          continue;
        }
        if (st.len > 1) {
          g.beginPath();
          g.moveTo(Math.round(px) + 0.5, Math.round(py));
          g.lineTo(Math.round(px) + 0.5, Math.round(py) + st.len);
          g.stroke();
        } else {
          g.fillRect(Math.round(px), Math.round(py), 1, 1);
        }
      }
    }

    // ── The clouds themselves ────────────────────────────────────────────────
    for (const c of this.clouds) {
      const prof = CLOUD_PROFILES[c.kind];
      c.x += c.speed * dt;
      if (c.x - c.w > cx + rx) c.x = cx - rx - c.w;

      // Lightning: a brief bright flash inside the head, plus a wash of light
      // over the ground beneath it.
      if (prof.lightning > 0) {
        if (c.flash > 0) c.flash -= dt;
        else if (Math.random() < prof.lightning * dt) c.flash = 0.09;
      }

      g.globalAlpha = c.alpha;
      if (prof.emissive) g.globalCompositeOperation = 'lighter';
      g.drawImage(c.sprite, Math.round(c.x - c.w / 2), Math.round(c.y - c.h / 2));
      if (prof.emissive) g.globalCompositeOperation = 'source-over';

      if (c.flash > 0) {
        g.globalAlpha = clamp01(c.flash / 0.09) * 0.85;
        g.globalCompositeOperation = 'lighter';
        const fx = c.x, fy = c.y + c.h * 0.1;
        const bolt = g.createRadialGradient(fx, fy, 0, fx, fy, c.w * 0.75);
        bolt.addColorStop(0, 'rgba(255,255,255,0.95)');
        bolt.addColorStop(0.4, 'rgba(200,220,255,0.45)');
        bolt.addColorStop(1, 'rgba(160,190,255,0)');
        g.fillStyle = bolt;
        g.beginPath(); g.arc(fx, fy, c.w * 0.75, 0, Math.PI * 2); g.fill();
        g.globalCompositeOperation = 'source-over';
      }
    }
    g.globalAlpha = 1;
    g.restore();
  }

  /** The weather currently over the world, for the UI to report. */
  get weatherSummary(): Array<{ kind: CloudKind; count: number }> {
    const tally = new Map<CloudKind, number>();
    for (const c of this.clouds) tally.set(c.kind, (tally.get(c.kind) ?? 0) + 1);
    return [...tally.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count);
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
    g.globalAlpha = 0.85;
    for (let i = 0; i < 4; i++) {
      const y = cy - ry - i * rx * 0.14 - Math.sin(t * 0.5 + i) * 2;
      const grad = g.createLinearGradient(0, y, 0, y + rx * 0.2);
      grad.addColorStop(0, css(pal.halo, 0));
      grad.addColorStop(0.5, css(pal.halo, 0.13 + 0.05 * Math.sin(t * 0.8 + i * 1.3)));
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
    case 'lava':  return rgb(200, 70, 30);
    case 'ice':   return rgb(150, 210, 240);
    case 'gas':   return rgb(190, 160, 110);
    case 'ocean': return rgb(70, 140, 210);
    default:      return rgb(150, 130, 95);
  }
}

/**
 * Pre-render a puffy cloud into its own small canvas (drawn once, blitted often).
 *
 * Tinted by `kind`, so a storm head, an ash plume and a fair-weather puff are
 * visibly different objects rather than the same white blob everywhere.
 */
function makeCloudSprite(
  w: number, h: number, seed: number, kind: CloudKind = 'cumulus',
): HTMLCanvasElement {
  w = Math.max(6, w); h = Math.max(3, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  const s = new Stream(seed);
  const prof = CLOUD_PROFILES[kind];
  const B = prof.body;

  // Storm and ash heads are taller and lumpier; haze and nebula are wispier.
  const puffs = kind === 'storm' || kind === 'ash' ? 5 + Math.floor(s.next() * 4)
              : kind === 'ice_haze' || kind === 'nebula' ? 2 + Math.floor(s.next() * 3)
              : 3 + Math.floor(s.next() * 4);

  for (let i = 0; i < puffs; i++) {
    const px = s.range(w * 0.18, w * 0.82);
    const py = s.range(h * 0.42, h * 0.72);
    const pr = s.range(h * 0.32, h * 0.62);
    const grad = g.createRadialGradient(px, py, 0, px, py, pr);
    grad.addColorStop(0,   css(B, 0.95));
    grad.addColorStop(0.6, css(shade(B, 0.90), 0.62));
    grad.addColorStop(1,   css(B, 0));
    g.fillStyle = grad;
    g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2); g.fill();
  }

  // Flat, shaded underside — reads as a cloud rather than a blob. Heavier on
  // storm and ash, which is most of what makes them look laden.
  const underStrength = kind === 'storm' ? 0.68 : kind === 'ash' ? 0.62 : 0.45;
  g.globalCompositeOperation = 'source-atop';
  const under = g.createLinearGradient(0, h * 0.5, 0, h);
  under.addColorStop(0, css(prof.under, 0));
  under.addColorStop(1, css(prof.under, underStrength));
  g.fillStyle = under;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'source-over';

  return c;
}
