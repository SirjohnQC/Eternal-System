/**
 * PixiBigBangRenderer — Pixi.js v8 rendering backend for the universe view.
 *
 * Architecture:
 *   - BigBangEngine canvas (z-index 2, transparent): fog-of-war + screen-space
 *     effects (beacon, inflation ring).
 *   - Pixi canvas (z-index 1, behind): everything else — background stars,
 *     nebulae, stars, fleets, planets, wars, religions, cosmic effects.
 *
 * Usage (main.ts):
 *   const pixi = new PixiBigBangRenderer();
 *   await pixi.init(container, width, height);
 *   engine.pixiMode = true;
 *   engine.onPixiFrame = (eng) => pixi.renderFrame(eng);
 */

import {
  Application, Container, Graphics, Text, TextStyle,
  Color, Sprite, Texture, TilingSprite, Assets,
} from 'pixi.js';

import type {
  BigBangEngine, StarBody, Fleet, OrbitalFleet, War,
  AsteroidBody, NebulaCloud, SupernovaFlash, RevelationFlash,
  Camera, Galaxy, Planet,
} from '../simulation/BigBangEngine';
import { planetOffsetFromStar } from '../simulation/BigBangEngine';
import { BigBangCinematicOverlay } from './BigBangCinematicOverlay';
import { buildCosmicWeb, threadPoints, flowsToB, webHash, type CosmicWeb } from './CosmicWeb';
import { starfieldTile, nebulaBlob } from './CosmosArt';
import { SECTOR_SIZE, sectorAt, type DormantGalaxy } from '../simulation/Universe';

/** What the universe map colours by (the observatory's overlay buttons). */
export type MapOverlay = 'none' | 'life' | 'civ' | 'conflict' | 'trade' | 'faith';
const isDormant = (g: Galaxy): g is DormantGalaxy => (g as DormantGalaxy).sector !== undefined;
/** Each galaxy's inclination on the universe map (seeded by id): tilt and axis. */
function inclinationOf(id: number): { incl: number; axis: number } {
  return { incl: 0.25 + webHash(id * 977 + 13) * 0.95, axis: webHash(id * 571 + 7) * Math.PI };
}
import { ramp } from '../simulation/BigBangCinematic';
import { WORLD_SIZE } from '../constants';
import { bakeGalaxyHaze, bakeGalaxyStars, GALAXY_EXTENT, STARS_RES, type GalaxyShape, type Raster } from './GalaxyArt';
import type { TradeRoute } from '../simulation/StarPolities';

import { CIV_COLORS, gameState, runtimeState, DEFAULT_PLANET_DNA, TECH_LEVELS, BIO_PHASE_SEQUENCE } from '../simulation/GameState';
import { drawFactionFlag, type FactionFlag } from '../simulation/FactionFlag';
import { bakePlanetTexture } from '../simulation/PlanetRenderer';
import { paintMoon, type MoonKindArt } from './MoonArt';
import { moonViewOrbit, moonViewSize, moonViewMinScale, moonIsIrregular } from '../simulation/MoonSize';
import {
  bakeStarBody, bakeStarCorona, bakeStarGlow, STAR_BODY_FRAMES, CORONA_BODY_FRAC, bakePlanetSprite, bakeMoonSprite,
  wrapEquirectToGlobe, starTempBand, starVisualProfile, parseHexColor,
  bakeSoftNebulaHaze,
  type PlanetKind, type MoonKind,
} from './CosmicPixelSprites';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cssToHex(css: string): number {
  return parseInt(css.replace('#', '0x'), 16);
}

/** Draw N dashes along a straight line using Graphics lineTo segments. */
function dashedLine(
  g: Graphics,
  x1: number, y1: number,
  x2: number, y2: number,
  dashLen: number,
  gapLen: number,
  color: number,
  width: number,
  alpha: number,
): void {
  const dx = x2 - x1, dy = y2 - y1;
  const total = Math.sqrt(dx * dx + dy * dy);
  if (total < 0.5) return;
  const nx = dx / total, ny = dy / total;
  let pos = 0;
  let drawing = true;
  while (pos < total) {
    const segLen = Math.min(drawing ? dashLen : gapLen, total - pos);
    const sx = x1 + nx * pos, sy = y1 + ny * pos;
    const ex = sx + nx * segLen, ey = sy + ny * segLen;
    if (drawing) {
      g.moveTo(sx, sy).lineTo(ex, ey).stroke({ color, width, alpha });
    }
    pos += segLen;
    drawing = !drawing;
  }
}

/** Dotted orbit — discrete pixels; supports elliptical Kepler paths. */
function pixelOrbit(
  g: Graphics,
  cx: number, cy: number, radius: number,
  color: number, alpha: number,
  cameraScale: number,
): void {
  const dot = Math.max(0.45, 0.7 / cameraScale);
  // Coarser step at wide orbits — still reads as a dashed ring, far fewer draws.
  const step = Math.max(0.18, 3.2 / Math.max(radius, 1));
  for (let a = 0; a < Math.PI * 2; a += step) {
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius;
    g.rect(x - dot / 2, y - dot / 2, dot, dot).fill({ color, alpha });
  }
}

function pixelPlanetOrbit(
  g: Graphics,
  cx: number, cy: number,
  planet: Planet,
  color: number, alpha: number,
  cameraScale: number,
): void {
  const a = Math.max(planet.orbitalRadius, 1);
  const e = Math.min(0.72, Math.max(0, planet.eccentricity ?? 0));
  if (e < 0.015) {
    // Near-circular — avoid Kepler solve + temp objects per sample.
    pixelOrbit(g, cx, cy, a, color, alpha, cameraScale);
    return;
  }
  const dot = Math.max(0.45, 0.7 / cameraScale);
  const step = Math.max(0.16, 2.8 / a);
  for (let th = 0; th < Math.PI * 2; th += step) {
    const off = planetOffsetFromStar({ ...planet, orbitalAngle: th, orbitalSpeed: 0 }, 0);
    g.rect(cx + off.x - dot / 2, cy + off.y - dot / 2, dot, dot).fill({ color, alpha });
  }
}

/** Axis-aligned world-space half-extents of the camera frustum (+ padding). */
function viewHalfExtents(camera: Camera, padWorld = 0): { halfW: number; halfH: number } {
  const W = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const H = typeof window !== 'undefined' ? window.innerHeight : 800;
  const sc = Math.max(0.01, camera.scale);
  return {
    halfW: W * 0.5 / sc + padWorld,
    halfH: H * 0.5 / sc + padWorld,
  };
}

function inView(x: number, y: number, camera: Camera, halfW: number, halfH: number): boolean {
  return Math.abs(x - camera.x) <= halfW && Math.abs(y - camera.y) <= halfH;
}

// ─── Renderer ────────────────────────────────────────────────────────────────

export class PixiBigBangRenderer {
  private app!: Application;
  private worldContainer!: Container;

  // Layers — each cleared + redrawn every frame
  private bgLayer!: Graphics;
  private nebulaLayer!: Graphics;
  /** Galactic dust lanes + inter-system debris (world-space). */
  private dustLayer!: Graphics;
  /** Galaxy art: one haze + one star-field sprite per galaxy (GalaxyArt bakes). */
  private galaxyLayer!: Container;
  /** The cosmic web the galaxies sit on, at universe zoom (world-space). */
  private webLayer!: Graphics;
  private cosmicWeb: CosmicWeb | null = null;
  private galaxySkins = new Map<number, { key: string; box: Container; haze: Sprite; stars: Sprite }>();
  /** Universe map depth: parallax starfields (screen) and nebula clouds (world). */
  private parallaxFar: TilingSprite | null = null;
  private parallaxNear: TilingSprite | null = null;
  private cloudLayer!: Container;
  private cloudSprites: Sprite[] = [];
  private cloudKey = '';
  private mapOverlay: MapOverlay = 'none';
  setMapOverlay(mode: MapOverlay): void { this.mapOverlay = mode; }
  private tradeLayer!: Graphics;
  private starLayer!: Graphics;
  private religionLayer!: Graphics;
  private asteroidLayer!: Graphics;
  private fleetLayer!: Graphics;
  private warLayer!: Graphics;
  private planetLayer!: Graphics;
  private cosmicLayer!: Graphics;
  /**
   * Faction flags are Sprites, not Graphics.
   *
   * The Canvas 2D renderer drew real flags via `drawFactionFlag`, but that whole
   * branch is dead under `pixiMode`, so the feature silently regressed to a
   * coloured dot when the Pixi backend landed. Baking each flag once into a
   * texture reuses the existing art code exactly and costs one sprite per civ.
   */
  private flagLayer!: Container;
  private flagTextures = new Map<string, Texture>();
  private flagSprites = new Map<number, Sprite>();

  /** Baked pixel-art star/planet/moon sprites (nearest-neighbour). */
  private bodyLayer!: Container;
  /** Soft radial glows under suns — linear filtered, not pixel art. */
  private glowLayer!: Container;
  private starTextures = new Map<string, Texture>();
  private starGlowTextures = new Map<string, Texture>();
  private starCoronaTextures = new Map<string, Texture>();
  private starSprites = new Map<number, Sprite>();
  private starGlowSprites = new Map<number, Sprite>();
  private starHazeSprites = new Map<number, Sprite>();
  private starCoronaSprites = new Map<number, Sprite>();
  private planetTextures = new Map<string, Texture>();
  private planetSprites = new Map<string, Sprite>();
  private moonTextures = new Map<string, Texture>();
  private moonSprites = new Map<string, Sprite>();

  /** Soft nebula haze drawn OVER the solar system (screen-space). */
  private hazeOverlay!: Container;
  private hazeSprites: Sprite[] = [];
  private hazeTexCache = new Map<string, Texture>();
  private hazeDustGfx!: Graphics;
  /** CodePen-style scrolling star / twinkle / cloud layers. */
  private spaceStars: TilingSprite | null = null;
  private spaceTwinkle: TilingSprite | null = null;
  private spaceClouds: TilingSprite | null = null;
  private spaceLayersReady = false;

  private labelContainer!: Container;
  /** The opening cinematic's overlay (singularity, plasma, web, ignition). */
  private cineOverlay: BigBangCinematicOverlay | null = null;
  /** Player star brightness / planet presence this frame (cinematic; 1 otherwise). */
  private homeLight = 1;
  private homePlanets = 1;

  private bgStarCache: Array<{ x: number; y: number; r: number }> = [];
  /** Skip rebuilding 200 bg rects unless size / tint band changes. */
  private bgLayerKey = '';
  private bgBuiltW = 0;
  private bgBuiltH = 0;
  private bgBuiltKey = '';

  /**
   * Cached galactic dust fields keyed by galaxy id.
   * Local polar coords so the field co-rotates with the disc.
   */
  private galacticDustCache = new Map<number, Array<{
    rFrac: number; a0: number; size: number; tint: number; alpha: number; kind: 'dust' | 'rock';
  }>>();

  /** The Pixi canvas element — insert this into the DOM behind the engine canvas. */
  get canvas(): HTMLCanvasElement { return this.app.canvas as HTMLCanvasElement; }

  async init(width: number, height: number): Promise<void> {
    this.app = new Application();
    await this.app.init({
      width,
      height,
      background: '#000008',
      antialias: false, // pixel art — no soft edges on stars/planets
      // Cap at 1× CSS pixels: retina fill-rate eats the 8ms 120Hz budget.
      // Pixel art already nearest-scales; extra DPR mostly costs bandwidth.
      resolution: Math.min(window.devicePixelRatio || 1, 1),
      autoDensity: true,
      powerPreference: 'high-performance',
    });

    // Stop built-in ticker — we drive rendering from BigBangEngine's RAF loop.
    this.app.ticker.stop();

    // World container — camera transform applied here.
    this.worldContainer = new Container();
    this.app.stage.addChild(this.worldContainer);

    // Fixed (screen-space) background star layer directly on stage.
    this.bgLayer       = new Graphics();
    this.nebulaLayer   = new Graphics();
    this.tradeLayer    = new Graphics();
    this.starLayer     = new Graphics();
    this.religionLayer = new Graphics();
    this.asteroidLayer = new Graphics();
    this.fleetLayer    = new Graphics();
    this.warLayer      = new Graphics();
    this.planetLayer   = new Graphics();
    this.cosmicLayer   = new Graphics();
    this.labelContainer = new Container();

    this.app.stage.addChild(this.bgLayer);          // screen-space bg stars
    // The galaxies themselves (GalaxyArt), beneath everything else in the world.
    this.cloudLayer = new Container();
    this.worldContainer.addChild(this.cloudLayer);
    this.webLayer = new Graphics();
    this.worldContainer.addChild(this.webLayer);
    // Parallax starfields under everything (screen-space, drift slower than the map).
    const far = Texture.from(starfieldTile(512, 0x5eed1, 520, false));
    const near = Texture.from(starfieldTile(512, 0x5eed2, 150, true));
    for (const t of [far, near]) { t.source.scaleMode = 'nearest'; t.source.addressMode = 'repeat'; }
    this.parallaxFar = new TilingSprite({ texture: far, width: width, height: height });
    this.parallaxNear = new TilingSprite({ texture: near, width: width, height: height });
    this.parallaxFar.alpha = this.parallaxNear.alpha = 0;
    this.app.stage.addChildAt(this.parallaxNear, 0);
    this.app.stage.addChildAt(this.parallaxFar, 0);
    this.galaxyLayer = new Container();
    this.worldContainer.addChild(this.galaxyLayer);
    this.worldContainer.addChild(this.nebulaLayer);
    this.dustLayer = new Graphics();
    this.worldContainer.addChild(this.dustLayer);
    this.worldContainer.addChild(this.tradeLayer);
    this.worldContainer.addChild(this.starLayer);
    this.glowLayer = new Container();
    this.glowLayer.sortableChildren = true;
    this.worldContainer.addChild(this.glowLayer);
    this.bodyLayer = new Container();
    this.worldContainer.addChild(this.bodyLayer);
    this.flagLayer = new Container();
    this.worldContainer.addChild(this.flagLayer);
    this.worldContainer.addChild(this.religionLayer);
    this.worldContainer.addChild(this.asteroidLayer);
    this.worldContainer.addChild(this.fleetLayer);
    this.worldContainer.addChild(this.warLayer);
    this.worldContainer.addChild(this.planetLayer);
    this.worldContainer.addChild(this.cosmicLayer);

    // Soft atmospheric haze sits ON TOP of stars/planets (screen-space).
    // Mix: CodePen parallax star/cloud tiles + our soft galaxy-tinted blooms.
    this.hazeOverlay = new Container();
    this.hazeDustGfx = new Graphics();
    this.hazeOverlay.addChild(this.hazeDustGfx);
    this.app.stage.addChild(this.hazeOverlay);
    this.app.stage.addChild(this.labelContainer);   // screen-space labels
    this.cineOverlay = new BigBangCinematicOverlay();
    this.app.stage.addChild(this.cineOverlay.container);

    await this.loadSpaceParallaxLayers(width, height);
  }

  /**
   * Outer Space Background layers (Nazar Azhar CodePen style):
   * tiled stars + scrolling twinkles + scrolling nebula clouds.
   */
  private async loadSpaceParallaxLayers(W: number, H: number): Promise<void> {
    try {
      const [starsTex, twinkleTex, cloudsTex] = await Promise.all([
        Assets.load('/assets/ui/space/stars.png') as Promise<Texture>,
        Assets.load('/assets/ui/space/twinkling.png') as Promise<Texture>,
        Assets.load('/assets/ui/space/clouds.png') as Promise<Texture>,
      ]);
      for (const t of [starsTex, twinkleTex, cloudsTex]) {
        t.source.scaleMode = 'linear';
      }

      this.spaceStars = new TilingSprite({ texture: starsTex, width: W, height: H });
      this.spaceTwinkle = new TilingSprite({ texture: twinkleTex, width: W, height: H });
      this.spaceClouds = new TilingSprite({ texture: cloudsTex, width: W, height: H });

      this.spaceStars.alpha = 0;
      this.spaceTwinkle.alpha = 0;
      this.spaceClouds.alpha = 0;

      // Under soft blooms / dust, above nothing in this overlay.
      this.hazeOverlay.addChildAt(this.spaceStars, 0);
      this.hazeOverlay.addChildAt(this.spaceTwinkle, 1);
      this.hazeOverlay.addChildAt(this.spaceClouds, 2);
      this.spaceLayersReady = true;
    } catch (err) {
      console.warn('[Pixi] space parallax textures failed to load', err);
      this.spaceLayersReady = false;
    }
  }

  /**
   * Bake star body/glow/corona textures for every spectral band so the first
   * inflation frames do not hitch on Texture.from.
   */
  warmStarTextures(): void {
    const bands: Array<'blue' | 'white' | 'yellow' | 'orange' | 'red'> =
      ['blue', 'white', 'yellow', 'orange', 'red'];
    for (const band of bands) {
      for (let f = 0; f < STAR_BODY_FRAMES; f++) {
        this.nearestTex(this.starTextures, `body|${band}|${f}|5`, bakeStarBody(band, 48, f, 5));
      }
      this.nearestTex(this.starCoronaTextures, `corona|${band}|5`, bakeStarCorona(band, 80, 5));
      this.linearTex(this.starGlowTextures, `glow|${band}`, bakeStarGlow(band, 160));
      this.linearTex(this.starGlowTextures, `haze|${band}`, bakeStarGlow(band, 160));
    }
  }

  /** Resize the Pixi renderer to match window size. */
  resize(width: number, height: number): void {
    this.app.renderer.resize(width, height);
    this.bgStarCache = []; // force rebuild
    this.bgLayerKey = '';
    this.bgBuiltW = 0;
    this.bgBuiltH = 0;
    if (this.spaceStars) { this.spaceStars.width = width; this.spaceStars.height = height; }
    for (const t of [this.parallaxFar, this.parallaxNear]) if (t) { t.width = width; t.height = height; }
    if (this.spaceTwinkle) { this.spaceTwinkle.width = width; this.spaceTwinkle.height = height; }
    if (this.spaceClouds) { this.spaceClouds.width = width; this.spaceClouds.height = height; }
  }

  // ─── Main frame render ────────────────────────────────────────────────────

  renderFrame(engine: BigBangEngine): void {
    const camera   = engine.currentCamera;
    const animTick = engine.currentAnimTick;
    const { width: W, height: H } = this.app.renderer;
    // 120Hz ≈ 8.3ms/frame. Drop fill-rate extras when we were over budget.
    const tight = engine.currentFrameMs > 6.5;
    const critical = engine.currentFrameMs > 9;

    // Apply camera transform to world container
    this.worldContainer.x = W / 2 - camera.x * camera.scale;
    this.worldContainer.y = H / 2 - camera.y * camera.scale;
    this.worldContainer.scale.set(camera.scale);

    // Build star lookup map once per frame — avoids O(n) find() inside every draw loop
    const starMap = new Map<number, StarBody>();
    for (const s of engine.stars) starMap.set(s.id, s);

    // Draw each layer
    this.drawBgStars(W, H, engine, camera);
    this.drawCosmosDepth(engine, camera, W, H);
    this.drawCosmicWeb(engine, camera, animTick);
    this.drawGalaxySkins(engine, camera);
    this.drawNebulae(engine.nebulae, animTick);
    if (!critical) {
      this.drawGalacticMedium(engine.currentGalaxies, engine.stars, engine.currentPlayerStarId, animTick, camera);
    } else {
      this.dustLayer.clear();
    }
    this.drawTradeRoutes(engine.visibleTradeRoutes(), starMap, animTick, camera);
    // Out at galaxy and universe zoom the fog is light enough to show the
    // galaxies' light, so worlds the player has not found are not drawn at
    // all (they were only ever hidden by the fog's darkness).
    const settled = engine.phase === 'settled';
    this.homeLight = engine.homeStarLight;
    this.homePlanets = engine.planetsReveal;
    const known = settled && camera.scale < 1.8 && !engine.cinematicActive ? new Set(engine.stars.filter(s => engine.isStarKnownToPlayer(s)).map(s => s.id)) : null;
    const shown = known ? engine.stars.filter(s => known.has(s.id)) : engine.stars;
    const seenFleet = (a: number, b: number) => !known || known.has(a) || known.has(b);
    this.drawStars(shown, engine.currentPlayerStarId, animTick, camera, tight);
    this.drawReligions(shown, engine.currentRevelationFlashes, animTick, camera);
    this.drawAsteroids(engine.asteroids);
    this.drawSystemDebris(shown, engine.currentPlayerStarId, animTick, camera);
    this.drawFleets(known ? engine.fleets.filter(f => seenFleet(f.fromStarId, f.toStarId)) : engine.fleets, starMap, camera);
    this.drawOrbitalFleets(engine.orbitalFleets, starMap, animTick, camera);
    this.drawWars(known ? engine.activeWars.filter(w => seenFleet(w.attackerStarId, w.defenderStarId)) : engine.activeWars, starMap, animTick, camera);
    this.drawPlanets(shown, engine.currentPlayerStarId, animTick, camera);
    this.drawCosmicEffects(engine.currentSupernovaFlashes, animTick, camera, W, H);
    this.drawGalaxyMarkers(engine, shown, camera, W, H, animTick);
    // Haze last among world visuals so color sits over the solar system.
    if (!tight) {
      this.drawSystemHazeOverlay(W, H, engine, camera, animTick);
    } else {
      this.hazeOverlay.visible = false;
    }

    this.cineOverlay?.update(engine, W, H);

    // Render Pixi stage
    this.app.renderer.render(this.app.stage);
  }

  // ─── Background stars (screen-space, static cache) ───────────────────────

  private drawBgStars(W: number, H: number, engine: BigBangEngine, camera: Camera): void {
    if (this.bgStarCache.length === 0 || this.bgBuiltW !== W || this.bgBuiltH !== H) {
      let s = 0xdeadbeef;
      const rand = () => { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff; };
      this.bgStarCache = [];
      // Fewer motes — parallax tiles carry most of the sky once haze is up.
      const count = 96;
      for (let i = 0; i < count; i++) {
        this.bgStarCache.push({ x: rand() * W, y: rand() * H, r: rand() * 0.8 + 0.2 });
      }
      this.bgBuiltW = W;
      this.bgBuiltH = H;
      this.bgLayerKey = '';
    }

    const gal = this.galaxyNearCamera(engine, camera);
    const sc = camera.scale;
    const band = sc >= 1.5 ? 2 : sc >= 0.7 ? 1 : 0;
    const key = `${W}x${H}|${gal?.id ?? -1}|${band}`;
    if (key === this.bgLayerKey) return;

    this.bgLayer.clear();
    for (let i = 0; i < this.bgStarCache.length; i++) {
      const s = this.bgStarCache[i];
      let color = 0xffffff;
      let alpha = 0.45 + s.r * 0.25;
      if (gal && band >= 1) {
        const palette = this.galaxyColorPalette(cssToHex(gal.color));
        color = i % 5 === 0 ? palette.glow : i % 3 === 0 ? palette.cool : 0xffffff;
        alpha *= band >= 2 ? 0.7 : 0.9;
      }
      this.bgLayer.rect(s.x, s.y, Math.max(1, s.r * 2), Math.max(1, s.r * 2))
        .fill({ color, alpha });
    }
    this.bgLayerKey = key;
  }

  private galaxyNearCamera(engine: BigBangEngine, camera: Camera): Galaxy | null {
    const galaxies = engine.currentGalaxies;
    if (!galaxies.length) return null;
    const ps = engine.stars.find(s => s.id === engine.currentPlayerStarId && !s.isDead);
    if (ps) {
      const home = galaxies.find(g => g.id === ps.galaxyId);
      if (home) return home;
    }
    let best: Galaxy | null = null;
    let bestD = Infinity;
    for (const g of galaxies) {
      const d = (g.cx - camera.x) ** 2 + (g.cy - camera.y) ** 2;
      if (d < bestD) { bestD = d; best = g; }
    }
    return best;
  }

  /** Keep the galaxy's base hue; derive deep / warm / cool accents for atmosphere. */
  private galaxyColorPalette(base: number): {
    base: number; deep: number; warm: number; cool: number; glow: number;
  } {
    const r = (base >> 16) & 0xff, g = (base >> 8) & 0xff, b = base & 0xff;
    const deep = ((Math.max(4, r * 0.12) << 16) | (Math.max(4, g * 0.10) << 8) | Math.max(10, b * 0.18)) >>> 0;
    const warm = (
      (Math.min(255, r + 55) << 16) |
      (Math.min(255, g + 25) << 8) |
      Math.max(20, b - 20)
    ) >>> 0;
    const cool = (
      (Math.max(20, r - 15) << 16) |
      (Math.min(255, g + 35) << 8) |
      Math.min(255, b + 70)
    ) >>> 0;
    const glow = (
      (Math.min(255, r + 90) << 16) |
      (Math.min(255, g + 70) << 8) |
      Math.min(255, b + 50)
    ) >>> 0;
    return { base, deep, warm, cool, glow };
  }

  private softHazeTex(kind: 'bloom' | 'veil' | 'streak'): Texture {
    const key = kind;
    let tex = this.hazeTexCache.get(key);
    if (!tex) {
      const cv = bakeSoftNebulaHaze(kind, 256);
      tex = Texture.from(cv);
      // Soft gradients — linear filter (not nearest / pixel art)
      tex.source.scaleMode = 'linear';
      this.hazeTexCache.set(key, tex);
    }
    return tex;
  }

  private ensureHazeSprites(count: number): void {
    const base = this.spaceLayersReady ? 3 : 0;
    while (this.hazeSprites.length < count) {
      const spr = new Sprite(this.softHazeTex('bloom'));
      spr.anchor.set(0.5);
      // Keep soft blooms above parallax tiles, under dust motes.
      this.hazeOverlay.addChildAt(spr, base + this.hazeSprites.length);
      this.hazeSprites.push(spr);
    }
    for (let i = 0; i < this.hazeSprites.length; i++) {
      this.hazeSprites[i].visible = i < count;
    }
    // Dust gfx always on top
    if (this.hazeDustGfx.parent === this.hazeOverlay) {
      this.hazeOverlay.setChildIndex(this.hazeDustGfx, this.hazeOverlay.children.length - 1);
    }
  }

  /**
   * Mix of CodePen Outer Space parallax tiles + soft galaxy-tinted haze,
   * drawn OVER the solar system.
   */
  private drawSystemHazeOverlay(
    W: number, H: number,
    engine: BigBangEngine,
    camera: Camera,
    animTick: number,
  ): void {
    const gal = this.galaxyNearCamera(engine, camera);
    const sc = camera.scale;
    this.hazeDustGfx.clear();

    if (!gal || sc < 0.55 || sc > 5.6) {
      this.hazeOverlay.visible = false;
      return;
    }
    this.hazeOverlay.visible = true;

    let vis = 1;
    if (sc < 1.15) vis = (sc - 0.55) / 0.6;
    else if (sc > 4.8) vis = Math.max(0, 1 - (sc - 4.8) / 0.8);
    if (vis <= 0.02) {
      this.hazeOverlay.visible = false;
      return;
    }

    const palette = this.galaxyColorPalette(cssToHex(gal.color));

    // ── CodePen-style scrolling layers (over the orrery) ──────────────────
    if (this.spaceLayersReady && this.spaceStars && this.spaceTwinkle && this.spaceClouds) {
      this.spaceStars.width = W;
      this.spaceStars.height = H;
      this.spaceTwinkle.width = W;
      this.spaceTwinkle.height = H;
      this.spaceClouds.width = W;
      this.spaceClouds.height = H;

      // Slow drift — same feel as the 200s CSS keyframes, scaled to animTick
      this.spaceStars.tilePosition.x = animTick * 0.015;
      this.spaceStars.tilePosition.y = animTick * 0.008;
      this.spaceTwinkle.tilePosition.x = -animTick * 0.09;
      this.spaceTwinkle.tilePosition.y = animTick * 0.045;
      this.spaceClouds.tilePosition.x = animTick * 0.055;
      this.spaceClouds.tilePosition.y = Math.sin(animTick * 0.0002) * 40;

      this.spaceStars.tint = 0xffffff;
      this.spaceStars.alpha = 0.55 * vis;
      this.spaceStars.blendMode = 'normal';

      this.spaceTwinkle.tint = 0xffffff;
      this.spaceTwinkle.alpha = 0.7 * vis;
      this.spaceTwinkle.blendMode = 'screen';

      // Clouds carry the galaxy hue so it matches our cosmos, not stock purple alone
      this.spaceClouds.tint = palette.base;
      this.spaceClouds.alpha = 0.42 * vis;
      this.spaceClouds.blendMode = 'screen';
      this.spaceStars.visible = true;
      this.spaceTwinkle.visible = true;
      this.spaceClouds.visible = true;
    }

    // ── Soft blooms (ours) — lighter now so tiles read through ────────────
    this.ensureHazeSprites(4);
    const [veil, bloomA, bloomB, streakA] = this.hazeSprites;
    if (this.hazeSprites[4]) this.hazeSprites[4].visible = false;

    veil.texture = this.softHazeTex('veil');
    bloomA.texture = this.softHazeTex('bloom');
    bloomB.texture = this.softHazeTex('bloom');
    streakA.texture = this.softHazeTex('streak');

    const drift = animTick * 0.0004;
    const diag = Math.hypot(W, H);

    veil.tint = palette.deep;
    veil.alpha = 0.28 * vis;
    veil.blendMode = 'normal';
    veil.x = W * 0.5;
    veil.y = H * 0.5;
    veil.width = diag * 1.35;
    veil.height = diag * 1.35;

    bloomA.tint = palette.cool;
    bloomA.alpha = 0.16 * vis;
    bloomA.blendMode = 'screen';
    bloomA.x = W * (0.4 + Math.sin(drift) * 0.03);
    bloomA.y = H * (0.5 + Math.cos(drift * 0.8) * 0.025);
    bloomA.width = diag * 0.9;
    bloomA.height = diag * 0.8;
    bloomA.rotation = drift * 0.12;

    bloomB.tint = palette.warm;
    bloomB.alpha = 0.12 * vis;
    bloomB.blendMode = 'screen';
    bloomB.x = W * (0.65 + Math.cos(drift * 1.1) * 0.04);
    bloomB.y = H * (0.4 + Math.sin(drift * 0.7) * 0.03);
    bloomB.width = diag * 0.7;
    bloomB.height = diag * 0.65;
    bloomB.rotation = -drift * 0.1;

    streakA.tint = palette.glow;
    streakA.alpha = 0.10 * vis;
    streakA.blendMode = 'screen';
    streakA.x = W * 0.5;
    streakA.y = H * 0.48;
    streakA.width = diag * 1.05;
    streakA.height = diag * 0.5;
    streakA.rotation = -0.4 + Math.sin(drift * 0.5) * 0.04;

    // Fine colored dust motes over everything
    const moteN = 18;
    for (let i = 0; i < moteN; i++) {
      const seed = (gal.id * 131 + i * 97) % 1000;
      const px = ((seed * 17 + animTick * (0.02 + (i % 5) * 0.005)) % (W + 40)) - 20;
      const py = ((seed * 29 + i * 13) % H);
      const sz = 1 + (i % 3);
      const col = i % 4 === 0 ? palette.glow : i % 3 === 0 ? 0xffffff : palette.cool;
      this.hazeDustGfx.rect(px, py, sz, sz).fill({
        color: col,
        alpha: (0.22 + (i % 4) * 0.05) * vis,
      });
    }
  }

  // ─── Nebulae ──────────────────────────────────────────────────────────────

  private drawNebulae(nebulae: NebulaCloud[], animTick: number): void {
    this.nebulaLayer.clear();
    for (const n of nebulae) {
      if (n.alpha <= 0) continue;
      const pulse = 1 + 0.03 * Math.sin(animTick * 0.01 + n.x);
      const color = (Math.round(n.r) << 16) | (Math.round(n.g) << 8) | Math.round(n.b);
      // Three concentric circles approximate a radial gradient
      this.nebulaLayer.circle(n.x, n.y, n.radius * pulse * 1.5).fill({ color, alpha: n.alpha * 0.05 });
      this.nebulaLayer.circle(n.x, n.y, n.radius * pulse).fill({ color, alpha: n.alpha * 0.09 });
      this.nebulaLayer.circle(n.x, n.y, n.radius * pulse * 0.5).fill({ color, alpha: n.alpha * 0.13 });
    }
  }

  // ─── Galactic dust / debris (mid-zoom medium) ──────────────────────────────

  private ensureGalacticDust(gal: Galaxy): Array<{
    rFrac: number; a0: number; size: number; tint: number; alpha: number; kind: 'dust' | 'rock';
  }> {
    let cached = this.galacticDustCache.get(gal.id);
    if (cached) return cached;

    let s = (gal.id * 2654435761) >>> 0;
    const rand = () => {
      s ^= s << 13; s ^= s >> 17; s ^= s << 5;
      return (s >>> 0) / 0xffffffff;
    };
    const base = cssToHex(gal.color);
    const palette = this.galaxyColorPalette(base);
    const tints = [palette.base, palette.warm, palette.cool, palette.glow];
    cached = [];
    const count = 110 + Math.floor(rand() * 50);
    for (let i = 0; i < count; i++) {
      const isRock = rand() < 0.22;
      // Bias toward mid-disc (arm lanes), sparse core + rim.
      const u = rand();
      const rFrac = 0.18 + Math.pow(u, 0.65) * 0.78;
      const armBias = gal.morph === 'elliptical' || gal.morph === 'irregular'
        ? 0
        : Math.sin(rand() * Math.PI * 2) * 0.35;
      const a0 = rand() * Math.PI * 2 + armBias;
      const tint = isRock ? 0x9a9080 : tints[i % tints.length];
      cached.push({
        rFrac,
        a0,
        size: isRock ? 0.55 + rand() * 0.9 : 0.35 + rand() * 0.7,
        tint,
        alpha: isRock ? 0.35 + rand() * 0.35 : 0.12 + rand() * 0.28,
        kind: isRock ? 'rock' : 'dust',
      });
    }
    this.galacticDustCache.set(gal.id, cached);
    return cached;
  }

  /**
   * Dust flecks between systems (no hard disc washes — those live in the overlay).
   */
  private drawGalacticMedium(
    galaxies: Galaxy[],
    _stars: StarBody[],
    _playerStarId: number,
    animTick: number,
    camera: Camera,
  ): void {
    this.dustLayer.clear();
    const sc = camera.scale;
    // The galaxy tier is drawn by the galaxy art (face-on, matching the
    // systems' circular orbits); this flattened dust only adds ambience close in.
    if (sc < 1.5 || sc > 3.5) return;

    let dustVis = 1;
    if (sc < 0.45) dustVis = (sc - 0.18) / 0.27;
    else if (sc > 1.8) dustVis = Math.max(0, 1 - (sc - 1.8) / 1.6);
    if (dustVis <= 0.02) return;

    const spin = animTick * 0.00035;
    const { halfW, halfH } = viewHalfExtents(camera, 40 / sc);

    for (const gal of galaxies) {
      if (gal.radius < 8) continue;
      // Whole envelope off-screen — skip (wider galaxies after spacing made
      // drawing every dust fleck for distant discs a real cost).
      if (!inView(gal.cx, gal.cy, camera, halfW + gal.radius, halfH + gal.radius)) continue;
      const cosT = Math.cos(gal.tilt);
      const sinT = Math.sin(gal.tilt);
      const flat = Math.max(0.35, gal.discFlat);
      const field = this.ensureGalacticDust(gal);
      for (const p of field) {
        const r = p.rFrac * gal.radius;
        const ang = p.a0 + spin * (0.55 + (1 - p.rFrac) * 0.8);
        const lx = Math.cos(ang) * r;
        const ly = Math.sin(ang) * r * flat;
        const wx = gal.cx + lx * cosT - ly * sinT;
        const wy = gal.cy + lx * sinT + ly * cosT;
        if (!inView(wx, wy, camera, halfW, halfH)) continue;
        const sz = Math.max(0.25 / sc, p.size);
        const a = p.alpha * dustVis * (p.kind === 'dust' ? 1 : 0.9);
        if (p.kind === 'dust') {
          this.dustLayer.circle(wx, wy, sz * 1.8).fill({ color: p.tint, alpha: a * 0.35 });
          this.dustLayer.rect(wx - sz * 0.5, wy - sz * 0.5, sz, sz)
            .fill({ color: p.tint, alpha: a });
        } else {
          this.dustLayer.rect(wx - sz * 0.5, wy - sz * 0.5, sz, sz)
            .fill({ color: p.tint, alpha: a });
        }
      }
    }
  }

  /**
   * Per-system asteroid belts + outer dust rings (visible with planets).
   */
  private drawSystemDebris(
    stars: StarBody[],
    _playerStarId: number,
    animTick: number,
    camera: Camera,
  ): void {
    if (camera.scale < 0.85) return;

    const { halfW, halfH } = viewHalfExtents(camera, 120 / Math.max(0.01, camera.scale));

    for (const star of stars) {
      if (star.isDead || star.planets.length === 0) continue;
      if (!star.isPlayerStar && camera.scale < 1.15) continue;
      if (!inView(star.x, star.y, camera, halfW, halfH)) continue;

      let outer = 0;
      for (const p of star.planets) {
        if (p.orbitalRadius > outer) outer = p.orbitalRadius;
      }
      if (outer < 4) outer = star.radius * 8;

      // Faint dust ring just outside the planetary system
      const dustR = outer * 1.18;
      const dustAlpha = star.isPlayerStar ? 0.22 : 0.12;
      const dustDots = star.isPlayerStar ? 28 : 14;
      const dustStep = (Math.PI * 2) / dustDots;
      const dustSpin = animTick * 0.0011;
      for (let i = 0; i < dustDots; i++) {
        const a = i * dustStep + dustSpin + star.id * 0.17;
        const jitter = 0.92 + ((i * 37 + star.id * 13) % 11) * 0.012;
        const x = star.x + Math.cos(a) * dustR * jitter;
        const y = star.y + Math.sin(a) * dustR * jitter;
        const sz = Math.max(0.2 / camera.scale, 0.28);
        this.asteroidLayer.rect(x - sz * 0.5, y - sz * 0.5, sz, sz)
          .fill({ color: 0xb8a878, alpha: dustAlpha * (0.55 + (i % 3) * 0.15) });
      }

      // Drifting rocks and the odd comet crossing the system (every system
      // with planets, belt or not).
      this.drawSystemDrifters(star, outer, animTick, camera);

      if (!star.asteroidBelt || camera.scale < 1.05) continue;
      this.drawBelt(star, animTick, camera);
    }
  }

  /**
   * Per-star belt field, built once: the belt sits in the widest gap between
   * planet orbits (rocks never sweep through a planet), and every rock keeps
   * its own orbit radius, phase, size class and tint. Rocks move on Kepler's
   * clock (angular speed ~ r^-1.5), so the inner edge visibly outruns the
   * outer edge and the belt shears instead of turning like a wheel.
   */
  private beltCache = new Map<number, {
    key: string; r0: number; w: number;
    rf: Float32Array; a0: Float32Array; sp: Float32Array; sz: Uint8Array; tint: Uint8Array;
  }>();

  private ensureBelt(star: StarBody): {
    key: string; r0: number; w: number;
    rf: Float32Array; a0: Float32Array; sp: Float32Array; sz: Uint8Array; tint: Uint8Array;
  } {
    const dens = Math.max(0.15, star.asteroidBeltDensity ?? 0.5);
    const key = `${star.planets.length}|${dens.toFixed(2)}|${star.isPlayerStar ? 1 : 0}`;
    const hit = this.beltCache.get(star.id);
    if (hit && hit.key === key) return hit;
    // Widest gap between orbits, from just outside the star to the outermost.
    const radii = star.planets.map(p => p.orbitalRadius).sort((x, y) => x - y);
    let lo = star.radius * 3, best = 0, r0 = Math.max(star.radius * 5, (radii[radii.length - 1] ?? 20) * 0.55), w = 3;
    for (const r of radii) {
      const gap = r - lo;
      if (gap > best) { best = gap; r0 = (lo + r) / 2; w = gap * 0.2; }
      lo = r;
    }
    w = Math.max(1.4, Math.min(w, r0 * 0.16)) * (0.8 + dens * 0.3);
    let sd = (star.id * 2654435761 ^ 0x9e3779b9) >>> 0;
    const rand = () => { sd ^= sd << 13; sd ^= sd >>> 17; sd ^= sd << 5; return (sd >>> 0) / 4294967296; };
    // 200..560 bodies for the home system, ~65% elsewhere; over half of
    // them are 1-px dust that only shows up close.
    const n = Math.round((140 + 420 * dens) * (star.isPlayerStar ? 1 : 0.65));
    const rf = new Float32Array(n), a0 = new Float32Array(n), sp = new Float32Array(n);
    const sz = new Uint8Array(n), tint = new Uint8Array(n);
    // A belt has a few clumps (Kirkwood-like gaps between them): angle bias.
    const clumps = 3 + Math.floor(rand() * 3), cph = rand() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      // Radius: bell-shaped, dense in the middle, thin at the edges.
      const u = (rand() + rand() + rand()) / 1.5 - 1;
      rf[i] = u;
      let a = rand() * Math.PI * 2;
      if (rand() < 0.45) a += Math.sin(a * clumps + cph) * 0.25;
      a0[i] = a;
      const r = r0 + u * w;
      sp[i] = 0.0042 * Math.pow(Math.max(1, r) / 20, -1.5);
      const q = rand();
      sz[i] = q < 0.55 ? 0 : q < 0.84 ? 1 : q < 0.96 ? 2 : 3;   // dust, pebble, rock, boulder
      tint[i] = Math.floor(rand() * 4);
    }
    const out = { key, r0, w, rf, a0, sp, sz, tint };
    this.beltCache.set(star.id, out);
    return out;
  }

  /** Belt rock palette: [body, lit] per tint; 0-1 grey-brown stone, 2 rust, 3 pale ice/stone. */
  // Fill styles built once and reused every frame (no per-rock allocation).
  private static readonly BELT_DARK = [0x4a423c, 0x5a4e42, 0x5a3c2c, 0x5c6066].map(color => ({ color, alpha: 1 }));
  private static readonly BELT_BODY = [0x8a7e70, 0xa08c74, 0x9a6e50, 0xa4a8ae].map(color => ({ color, alpha: 1 }));
  private static readonly BELT_LIT  = [0xd0c2aa, 0xe4d0ac, 0xe0a678, 0xe4ecf4].map(color => ({ color, alpha: 1 }));
  private static readonly BELT_DUST = [0x8a7e70, 0xa08c74, 0x9a6e50, 0xa4a8ae].map(color => ({ color, alpha: 0.75 }));

  private drawBelt(star: StarBody, animTick: number, camera: Camera): void {
    const B = this.ensureBelt(star);
    const sc = camera.scale, px = 1 / sc;
    const dens = Math.max(0.15, star.asteroidBeltDensity ?? 0.5);
    const L = this.asteroidLayer;
    const { halfW, halfH } = viewHalfExtents(camera, 4 / sc);
    const n = B.rf.length;
    // Far out, fewer specks (still a belt, not noise).
    const step = sc < 1.4 ? 2 : 1;
    for (let i = 0; i < n; i += step) {
      const s = B.sz[i];
      if (s === 0 && sc < 1.25) continue;
      const r = B.r0 + B.rf[i] * B.w;
      const a = B.a0[i] + animTick * B.sp[i];
      const ca = Math.cos(a), sa = Math.sin(a);
      const x = star.x + ca * r, y = star.y + sa * r;
      if (!inView(x, y, camera, halfW, halfH)) continue;
      const t = B.tint[i];
      if (s === 0) {
        L.rect(x, y, px, px).fill(PixiBigBangRenderer.BELT_DUST[t]);
        continue;
      }
      // Pebble 2px, rock 3px, boulder 4px across (screen px, or the world
      // size up close), snapped to the screen grid; shaded as a lumpy pixel
      // body: lit pixels toward the star, a dark rim away from it.
      const n = Math.max(s + 1, Math.round((s + 1) * 0.3 * sc));
      const x0 = Math.round(x * sc - n / 2) / sc, y0 = Math.round(y * sc - n / 2) / sc;
      const d = n * px;
      L.rect(x0, y0 + (n > 2 ? px : 0), d, d - (n > 2 ? 2 * px : 0)).fill(PixiBigBangRenderer.BELT_BODY[t]);
      if (n > 2) L.rect(x0 + px, y0, d - 2 * px, d).fill(PixiBigBangRenderer.BELT_BODY[t]);
      // Star sits at (-ca, -sa) from the rock: light that side, shade the other.
      const sx = ca > 0.35 ? 0 : ca < -0.35 ? 2 : 1, sy = sa > 0.35 ? 0 : sa < -0.35 ? 2 : 1;
      const lx = x0 + (sx === 0 ? 0 : sx === 2 ? d - px * (n > 2 ? 2 : 1) : d / 2 - px);
      const ly = y0 + (sy === 0 ? px * (n > 2 ? 1 : 0) : sy === 2 ? d - px * 2 : d / 2 - px);
      L.rect(lx, ly, n > 2 ? 2 * px : px, px).fill(PixiBigBangRenderer.BELT_LIT[t]);
      if (n > 2) {
        const dx = x0 + (sx === 2 ? px : sx === 0 ? d - 2 * px : d / 2 - px);
        const dy = y0 + (sy === 2 ? px : sy === 0 ? d - 2 * px : d / 2);
        L.rect(dx, dy, 2 * px, px).fill(PixiBigBangRenderer.BELT_DARK[t]);
      }
    }
  }

  /**
   * Rocks drifting across a system on straight paths, and now and then a
   * comet. Stateless: each body's position is a pure function of animTick and
   * a per-star hash, so nothing is allocated or stored per frame, and the same
   * system shows the same traffic whenever it is looked at.
   */
  private drawSystemDrifters(star: StarBody, outer: number, animTick: number, camera: Camera): void {
    const sc = camera.scale;
    if (sc < 1.15) return;
    const px = 1 / sc, L = this.asteroidLayer;
    const span = outer * 1.5;
    const h = (k: number) => {
      let v = Math.imul((star.id + 1) * 374761393 + k * 668265263, 1274126177);
      v ^= v >>> 15; v = Math.imul(v, 2246822519); v ^= v >>> 13;
      return (v >>> 0) / 4294967296;
    };
    // Drifting rocks: 4 for the home system, 2 elsewhere.
    const nRocks = star.isPlayerStar ? 4 : 2;
    for (let i = 0; i < nRocks; i++) {
      const period = 2400 + h(i * 7 + 1) * 3600;
      const ph = ((animTick / period) + h(i * 7 + 2)) % 1;
      const dir = h(i * 7 + 3) * Math.PI * 2, off = (h(i * 7 + 4) - 0.5) * span * 1.4;
      const dx = Math.cos(dir), dy = Math.sin(dir);
      const along = (ph * 2 - 1) * span;
      const x = star.x + dx * along - dy * off, y = star.y + dy * along + dx * off;
      const d = (h(i * 7 + 5) < 0.4 ? 2 : 1) * px;
      const a = Math.min(1, (1 - Math.abs(ph * 2 - 1)) * 4) * 0.85;
      L.rect(x - d / 2, y - d / 2, d, d).fill({ color: 0x9a8e80, alpha: a });
      if (d > px) L.rect(x - d / 2, y - d / 2, px, px).fill({ color: 0xd0c4b0, alpha: a });
    }
    // Comets: at most one visible per system at a time. Each cycle, a comet
    // crosses on a chord passing near the star for ~45% of the cycle.
    const cycle = star.isPlayerStar ? 3600 : 6000;
    const k = Math.floor(animTick / cycle);
    const ph = (animTick / cycle) - k;
    const pass = 0.45;
    if (ph > pass || h(k * 13 + 99) > (star.isPlayerStar ? 0.85 : 0.5)) return;
    const u = ph / pass;                              // 0..1 across the pass
    const dir = h(k * 13 + 100) * Math.PI * 2;
    const miss = (0.18 + h(k * 13 + 101) * 0.5) * outer * (h(k * 13 + 102) < 0.5 ? -1 : 1);
    const dx = Math.cos(dir), dy = Math.sin(dir);
    // Faster near the star: ease the parameter through the middle.
    const e = u - 0.5, along = (e * 2 + Math.sin(e * Math.PI * 2) * -0.25) * span;
    const cx = star.x + dx * along - dy * miss, cy = star.y + dy * along + dx * miss;
    const rx = cx - star.x, ry = cy - star.y, rr = Math.max(1, Math.hypot(rx, ry));
    const ax = rx / rr, ay = ry / rr;                 // tail points away from the star
    const fade = Math.min(1, Math.min(u, 1 - u) * 8);
    // Tail grows as it nears the star.
    const heat = Math.min(1, outer * 0.45 / rr);
    const tailLen = (6 + heat * 26) * px * Math.max(1, sc * 0.35);
    const seg = Math.max(6, Math.round(tailLen / px / 2));
    for (let j = seg; j >= 1; j--) {
      const f = j / seg;
      const tx = cx + ax * tailLen * f, ty = cy + ay * tailLen * f;
      const w = (f < 0.35 ? 2 : 1) * px;
      // Ion tail (blue-white, straight) with a fainter dust tail curving off.
      L.rect(tx - w / 2, ty - w / 2, w, w).fill({ color: f < 0.4 ? 0xe6f4ff : 0x9cc8f0, alpha: (1 - f) * 0.75 * fade });
      const bend = f * f * tailLen * 0.35;
      L.rect(tx - ay * bend - px / 2, ty + ax * bend - px / 2, px, px).fill({ color: 0xe8d0a0, alpha: (1 - f) * 0.35 * fade });
    }
    // Coma and nucleus.
    L.circle(cx, cy, 2.6 * px).fill({ color: 0xbfe0ff, alpha: 0.18 * fade });
    L.rect(cx - px, cy - px, 2 * px, 2 * px).fill({ color: 0xffffff, alpha: fade });
  }

  // ─── Galaxies ─────────────────────────────────────────────────────────────

  private static galaxyShape(gal: Galaxy): GalaxyShape {
    return { id: gal.id, morph: gal.morph, armCount: gal.armCount, armPitch: gal.armPitch, barLength: gal.barLength, color: gal.color };
  }
  private static galaxyKey(gal: Galaxy): string {
    return `${gal.morph}|${gal.armCount}|${gal.armPitch.toFixed(2)}|${gal.barLength.toFixed(2)}|${gal.color}`;
  }

  private rasterTexture(r: Raster, linear: boolean): Texture {
    const cv = document.createElement('canvas');
    cv.width = r.size; cv.height = r.size;
    const g = cv.getContext('2d');
    if (g) { const img = g.createImageData(r.size, r.size); img.data.set(r.data); g.putImageData(img, 0, 0); }
    const tex = Texture.from(cv);
    tex.source.scaleMode = linear ? 'linear' : 'nearest';
    return tex;
  }

  /** Bake (or re-bake) one galaxy's art (lighter for dormant galaxies, seen from afar). */
  private bakeGalaxySkin(gal: Galaxy): { key: string; box: Container; haze: Sprite; stars: Sprite } {
    const old = this.galaxySkins.get(gal.id);
    if (old) { old.box.destroy({ children: true, texture: true, textureSource: true }); }
    const shape = PixiBigBangRenderer.galaxyShape(gal);
    const far = isDormant(gal);
    const haze = new Sprite(this.rasterTexture(bakeGalaxyHaze(shape, far ? 128 : undefined), true));
    const stars = new Sprite(this.rasterTexture(bakeGalaxyStars(shape, far ? 512 : undefined), false));
    const box = new Container();
    box.visible = false;
    for (const sp of [haze, stars]) { sp.anchor.set(0.5); box.addChild(sp); }
    stars.blendMode = 'add';
    this.galaxyLayer.addChild(box);
    const skin = { key: PixiBigBangRenderer.galaxyKey(gal), box, haze, stars };
    this.galaxySkins.set(gal.id, skin);
    return skin;
  }

  /** Bake every galaxy's art up front (behind the loading screen). */
  async warmGalaxyArt(galaxies: Galaxy[], onProgress?: (done: number, total: number, label: string) => void): Promise<void> {
    const total = Math.max(1, galaxies.length);
    for (let i = 0; i < galaxies.length; i++) {
      const gal = galaxies[i];
      const skin = this.galaxySkins.get(gal.id);
      if (!skin || skin.key !== PixiBigBangRenderer.galaxyKey(gal)) this.bakeGalaxySkin(gal);
      onProgress?.(i + 1, total, `Mapping ${gal.name}`);
      await new Promise<void>(r => setTimeout(r, 0));
    }
  }

  /**
   * The galaxies as star clouds (GalaxyArt): a soft haze and a crisp field
   * of thousands of stars per galaxy, face-on like the systems' orbits, the
   * arm pattern turning with the galaxy. Shown at universe and galaxy zoom
   * (and through the Big Bang), fading out toward system zoom.
   */
  private drawGalaxySkins(engine: BigBangEngine, camera: Camera): void {
    const strength = engine.galaxyTierStrength, sc = camera.scale;
    const seen = new Set<number>();
    // On the universe map each galaxy shows its own inclination (seeded), as
    // in a real sky; closer in they turn face-on, like their systems' orbits.
    const tiltK = Math.max(0, Math.min(1, (0.075 - sc) / 0.035));
    if (strength > 0.01) {
      const { halfW, halfH } = viewHalfExtents(camera, 40 / Math.max(0.01, sc));
      let baked = 0;
      for (const gal of [...engine.currentGalaxies, ...engine.dormantGalaxies]) {
        const far = isDormant(gal);
        if (!far && gal.starIds.length === 0) continue;
        const size = gal.radius * 2 * GALAXY_EXTENT;
        if (!inView(gal.x, gal.y, camera, halfW + size / 2, halfH + size / 2)) continue;
        let skin = this.galaxySkins.get(gal.id);
        if (!skin || skin.key !== PixiBigBangRenderer.galaxyKey(gal)) {
          if (baked >= 1 && skin) { /* keep the old art one more frame */ }
          else if (baked >= 1) continue;                  // at most one bake per frame
          else { skin = this.bakeGalaxySkin(gal); baked++; }
        }
        seen.add(gal.id);
        // How well the player knows it: home and charted sharp, a glimpsed
        // neighbour a shape, an unknown sector only a smudge of light.
        const st = far ? engine.sectorStateOf(gal.sector) : 'home';
        const [hv, sv] = st === 'home' || st === 'charted' ? [1, 1] : st === 'glimpsed' ? [0.85, 0.5] : [0.55, 0.12];
        const { incl, axis } = inclinationOf(gal.id);
        const rot = engine.galaxyPatternAngle(gal);
        const box = skin.box;
        box.x = gal.x; box.y = gal.y; box.rotation = axis; box.visible = true;
        box.scale.set(1, 1 - (1 - Math.cos(incl)) * tiltK);
        for (const sp of [skin.haze, skin.stars]) { sp.x = 0; sp.y = 0; sp.width = size; sp.height = size; sp.rotation = rot - axis; }
        skin.haze.alpha = Math.min(1, strength * 1.35) * hv;
        // Stars: full from galaxy zoom; softer at universe zoom, where each is sub-pixel.
        const near = Math.max(0, Math.min(1, (sc - 0.16) / 0.2));
        skin.stars.alpha = Math.min(1, strength * 1.1) * (0.45 + 0.55 * near) * sv;
        // Crisp pixels when magnified, smooth when minified (no shimmer while zooming).
        const res = far ? 512 : STARS_RES;
        const want = size * sc >= res ? 'nearest' : 'linear';
        if (skin.stars.texture.source.scaleMode !== want) skin.stars.texture.source.scaleMode = want;
      }
    }
    for (const [id, skin] of this.galaxySkins) if (!seen.has(id)) skin.box.visible = false;
  }

  // ─── Galaxy-zoom markers and names (screen space) ─────────────────────────

  private markerGfx: Graphics | null = null;
  private labelPool = new Map<string, Text>();
  private labelsUsed = new Set<string>();

  private labelFontReady = false;

  /** A pooled screen-space label (Pixelify Sans), shown this frame. */
  private label(key: string, text: string, x: number, y: number, color: number, size: number, alpha = 1): void {
    // Labels made before the pixel font loaded fell back to monospace: remake them once it is in.
    if (!this.labelFontReady && typeof document !== 'undefined' && document.fonts?.check('12px "Pixelify Sans"')) {
      this.labelFontReady = true;
      for (const t of this.labelPool.values()) t.destroy();
      this.labelPool.clear();
    }
    let t = this.labelPool.get(key);
    if (!t) {
      t = new Text({ text, style: new TextStyle({ fontFamily: 'Pixelify Sans, monospace', fontSize: size, fill: color, letterSpacing: 1,
        dropShadow: { color: 0x000000, alpha: 0.9, blur: 0, distance: 1, angle: Math.PI / 2 } }) });
      t.anchor.set(0.5, 0);
      this.labelContainer.addChild(t);
      this.labelPool.set(key, t);
    }
    if (t.text !== text) t.text = text;
    if ((t.style.fill as unknown) !== color) t.style.fill = color;
    t.x = Math.round(x); t.y = Math.round(y); t.alpha = alpha; t.visible = true;
    this.labelsUsed.add(key);
  }

  /**
   * Out at galaxy and universe zoom, constant-size markers: your world (gold
   * frame, YOUR WORLD), the civilisations you know (a ring in their flag's
   * colour, their name and age), living worlds (a green pip); and each
   * galaxy's name with how many of its systems you know.
   */
  /**
   * The cosmic web at universe zoom: faint gas threads between the galaxies and
   * dwarf knots, matter drifting along them toward the galaxies they feed.
   * Gone by galaxy zoom. During the opening cinematic it fades in as the
   * cinematic's own (brighter) web fades out, so the two hand over.
   */
  /** 0..1: how known a world point is (its sector's state), for the map's layers. */
  private knownAt(engine: BigBangEngine, x: number, y: number): number {
    const c = engine.cosmos;
    if (!c) return 1;
    const si = sectorAt(c, x, y);
    if (si < 0) return 0.35;
    const st = engine.sectorStateOf(si);
    return st === 'home' || st === 'charted' ? 1 : st === 'glimpsed' ? 0.7 : 0.4;
  }

  /**
   * The cosmic web at universe zoom and on the universe map: faint gas threads
   * between the galaxies (every sector's) and dwarf knots, matter drifting
   * along them toward the galaxies they feed. Gone by galaxy zoom. During the
   * opening cinematic it fades in as the cinematic's own web fades out.
   */
  private drawCosmicWeb(engine: BigBangEngine, camera: Camera, animTick: number): void {
    const g = this.webLayer;
    g.clear();
    const sc = camera.scale;
    let a = Math.max(0, Math.min(1, (0.5 - sc) / 0.28));
    // On the universe map the web is the backdrop, not the subject.
    a *= 1 - 0.45 * Math.max(0, Math.min(1, (0.07 - sc) / 0.025));
    const cine = engine.cinematic;
    if (cine && !cine.finished) a *= ramp(cine.since('galaxies'), 0.5, 4.0);
    if (a <= 0.003 || engine.currentGalaxies.length === 0) return;
    const dormant = engine.dormantGalaxies;
    this.cosmicWeb = buildCosmicWeb([...engine.currentGalaxies, ...dormant], WORLD_SIZE / 2, this.cosmicWeb, dormant.length ? 80 : 26);
    const web = this.cosmicWeb;
    const px = 1 / sc;
    const flow = animTick / 60;
    const SEG = sc < 0.06 ? 12 : 22;
    const { halfW, halfH } = viewHalfExtents(camera, 0);
    const vis = web.nodes.map(nd => this.knownAt(engine, nd.x, nd.y));
    for (const edge of web.edges) {
      const [i, j] = edge;
      const A = web.nodes[i], B = web.nodes[j];
      // Off-screen threads are skipped (the universe map has hundreds).
      if (Math.max(A.x, B.x) < camera.x - halfW * 1.2 || Math.min(A.x, B.x) > camera.x + halfW * 1.2 ||
          Math.max(A.y, B.y) < camera.y - halfH * 1.2 || Math.min(A.y, B.y) > camera.y + halfH * 1.2) continue;
      const ea = a * Math.min(vis[i], vis[j]);
      const strong = !!(A.real || B.real);
      const pts = threadPoints(web, edge, flow, SEG);
      for (const [w, al] of [[10, 0.04], [3.5, 0.07], [1.2, strong ? 0.34 : 0.2]] as const) {
        g.moveTo(pts[0][0], pts[0][1]);
        for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]);
        g.stroke({ color: 0x8f9cff, width: w * px, alpha: al * ea });
      }
      const toB = flowsToB(web, edge);
      for (let k = 0; k < 3; k++) {
        let u = (flow * 0.04 + k / 3 + webHash(i * 7 + j * 13)) % 1;
        if (!toB) u = 1 - u;
        const idx = Math.min(SEG - 1, Math.floor(u * SEG)), f = u * SEG - idx;
        const x = pts[idx][0] + (pts[idx + 1][0] - pts[idx][0]) * f;
        const y = pts[idx][1] + (pts[idx + 1][1] - pts[idx][1]) * f;
        g.rect(x - px, y - px, 2 * px, 2 * px).fill({ color: 0xdfe4ff, alpha: 0.6 * ea });
      }
    }
    web.nodes.forEach((nd, i) => {
      if (nd.real) return;
      g.circle(nd.x, nd.y, 9 * px).fill({ color: 0x8f9cff, alpha: 0.07 * a * vis[i] });
      g.rect(nd.x - px, nd.y - px, 2 * px, 2 * px).fill({ color: 0xe8ecff, alpha: 0.7 * a * vis[i] });
    });
  }

  /**
   * The universe map's depth: two parallax starfields that drift slower than
   * the map as it pans (far slower than near), and great soft nebula clouds
   * hanging between the sectors. They fade in as the view pulls out past the
   * galaxies.
   */
  private drawCosmosDepth(engine: BigBangEngine, camera: Camera, W: number, H: number): void {
    const sc = camera.scale;
    const k = Math.max(0, Math.min(1, (0.4 - sc) / 0.3));
    const cine = engine.cinematic && !engine.cinematic.finished ? 0.3 : 1;
    if (this.parallaxFar && this.parallaxNear) {
      this.parallaxFar.alpha = 0.55 * k * cine;
      this.parallaxNear.alpha = 0.7 * k * cine;
      this.parallaxFar.tilePosition.set(-camera.x * sc * 0.18 + W / 2, -camera.y * sc * 0.18 + H / 2);
      this.parallaxNear.tilePosition.set(-camera.x * sc * 0.42 + W / 2, -camera.y * sc * 0.42 + H / 2);
    }
    const c = engine.cosmos;
    if (!c) { this.cloudLayer.visible = false; return; }
    const key = c.sectors.map(s => s.name).join('|');
    if (key !== this.cloudKey) {
      this.cloudKey = key;
      for (const sp of this.cloudSprites) sp.destroy();
      this.cloudSprites = [];
      const tints = [0x6a4cb0, 0x2f6f8a, 0x8a3a6a, 0x9a6a2a, 0x3a4a9a, 0x5a8a6a];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of c.sectors) { minX = Math.min(minX, s.ox); minY = Math.min(minY, s.oy); maxX = Math.max(maxX, s.ox + SECTOR_SIZE); maxY = Math.max(maxY, s.oy + SECTOR_SIZE); }
      const texs = [0, 1, 2].map(i => { const t = Texture.from(nebulaBlob(192, 0xc10d + i * 31 + c.home)); t.source.scaleMode = 'linear'; return t; });
      for (let i = 0; i < 16; i++) {
        const h = (n: number) => webHash(c.home * 1000 + i * 37 + n);
        const sp = new Sprite(texs[i % texs.length]);
        sp.anchor.set(0.5);
        sp.x = minX + h(1) * (maxX - minX);
        sp.y = minY + h(2) * (maxY - minY);
        sp.width = SECTOR_SIZE * (0.6 + h(3) * 1.1);
        sp.height = sp.width * (0.5 + h(4) * 0.6);
        sp.rotation = h(5) * Math.PI;
        sp.tint = tints[Math.floor(h(6) * tints.length)];
        sp.blendMode = 'add';
        this.cloudLayer.addChild(sp);
        this.cloudSprites.push(sp);
      }
    }
    const ck = Math.max(0, Math.min(1, (0.3 - sc) / 0.22)) * cine;
    this.cloudLayer.visible = ck > 0.01;
    this.cloudLayer.alpha = 0.32 * ck;
  }

  // ─── The universe map: sectors and overlays ──────────────────────────────

  /**
   * On the universe map: each sector's frame, its name, and what the player
   * knows of it. Home is marked YOUR SECTOR; a gold pip is the home world.
   */
  private drawSectorGrid(engine: BigBangEngine, shown: StarBody[], toScreen: (x: number, y: number) => readonly [number, number], sc: number, animTick: number): void {
    const c = engine.cosmos;
    const k = Math.max(0, Math.min(1, (0.07 - sc) / 0.025));
    if (!c || k <= 0.01) return;
    const g = this.markerGfx!;
    for (const sec of c.sectors) {
      const st = engine.sectorStateOf(sec.index);
      const inset = SECTOR_SIZE * 0.02;
      const [x0, y0] = toScreen(sec.ox + inset, sec.oy + inset);
      const [x1, y1] = toScreen(sec.ox + SECTOR_SIZE - inset, sec.oy + SECTOR_SIZE - inset);
      const home = st === 'home';
      const col = home ? 0xffcc44 : st === 'charted' ? 0xa9a2ff : 0x5a5070;
      const al = (home ? 0.75 : st === 'unknown' ? 0.25 : 0.4) * k;
      // Dotted frame: pixel dashes along each edge.
      const dash = 6, gap = 6;
      for (let x = x0; x < x1; x += dash + gap) {
        g.rect(Math.round(x), Math.round(y0), Math.min(dash, x1 - x), 1).fill({ color: col, alpha: al });
        g.rect(Math.round(x), Math.round(y1), Math.min(dash, x1 - x), 1).fill({ color: col, alpha: al });
      }
      for (let y = y0; y < y1; y += dash + gap) {
        g.rect(Math.round(x0), Math.round(y), 1, Math.min(dash, y1 - y)).fill({ color: col, alpha: al });
        g.rect(Math.round(x1), Math.round(y), 1, Math.min(dash, y1 - y)).fill({ color: col, alpha: al });
      }
      if (home) {
        const pulse = 0.65 + 0.35 * Math.sin(animTick * 0.05), arm = 12;
        for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]] as const) {
          g.rect(sx > 0 ? cx : cx - arm, sy > 0 ? cy : cy - 2, arm, 2).fill({ color: 0xffcc44, alpha: pulse * k });
          g.rect(sx > 0 ? cx : cx - 2, sy > 0 ? cy : cy - arm, 2, arm).fill({ color: 0xffcc44, alpha: pulse * k });
        }
      }
      const mid = (x0 + x1) / 2;
      const nameCol = home ? 0xffd27a : st === 'charted' ? 0xd8d0ff : st === 'glimpsed' ? 0xa79cc0 : 0x6f6688;
      this.label(`sec${sec.index}`, st === 'unknown' ? 'UNCHARTED SECTOR' : sec.name.toUpperCase(), mid, y0 + 8, nameCol, 12, k);
      const n = home ? engine.currentGalaxies.filter(q => q.starIds.length).length : sec.galaxyCount;
      const sub = home ? `YOUR SECTOR · ${n} galaxies`
        : st === 'charted' ? `charted · ${n} galaxies`
        : st === 'glimpsed' ? `glimpsed · ${n} galaxies` : 'beyond sight';
      this.label(`secs${sec.index}`, sub, mid, y0 + 24, home ? 0xffcc44 : 0x8a80a0, 10, k * 0.9);
      if (home && this.mapOverlay !== 'none') {
        const ov = this.overlayCount(engine, shown, null);
        if (ov) this.label(`seco${sec.index}`, ov, mid, y0 + 38, this.overlayColor(), 10, k);
      }
    }
    // Each galaxy as a point of light: at this scale its art is a few pixels,
    // so a soft glow and a bright core say "a galaxy is here".
    for (const gal of [...engine.currentGalaxies.filter(q => q.starIds.length), ...engine.dormantGalaxies]) {
      const st = (gal as DormantGalaxy).sector !== undefined ? engine.sectorStateOf((gal as DormantGalaxy).sector) : 'home';
      const v = st === 'home' || st === 'charted' ? 1 : st === 'glimpsed' ? 0.75 : 0.4;
      const [x, y] = toScreen(gal.cx, gal.cy);
      const r = Math.max(6, gal.radius * sc);
      const col = cssToHex(gal.color);
      g.circle(x, y, r * 1.25).fill({ color: col, alpha: 0.05 * v * k });
      g.circle(x, y, r * 0.75).fill({ color: col, alpha: 0.08 * v * k });
      g.circle(x, y, r * 0.38).fill({ color: col, alpha: 0.14 * v * k });
      g.rect(Math.round(x) - 1, Math.round(y) - 1, 2, 2).fill({ color: 0xfff6e8, alpha: 0.9 * v * k });
    }
    const ps = engine.getPlayerStar();
    if (ps) {
      const [x, y] = toScreen(ps.x, ps.y);
      g.rect(Math.round(x) - 1, Math.round(y) - 1, 3, 3).fill({ color: 0xffd27a, alpha: k });
    }
  }

  private overlayColor(): number {
    return ({ none: 0xffffff, life: 0x5dcc8a, civ: 0xffcc66, conflict: 0xff5a4a, trade: 0xe8c066, faith: 0xc890ff } as const)[this.mapOverlay];
  }

  /** Stars the overlay is about (known to the player), in a galaxy or everywhere (null). */
  private overlayStars(engine: BigBangEngine, shown: StarBody[], galaxyId: number | null): StarBody[] {
    const faith = gameState.playerReligionName;
    const warring = new Set<number>();
    if (this.mapOverlay === 'conflict') for (const w of engine.activeWars) { warring.add(w.attackerStarId); warring.add(w.defenderStarId); }
    const traders = new Set<number>();
    if (this.mapOverlay === 'trade') for (const r of engine.visibleTradeRoutes()) { traders.add(r.a); traders.add(r.b); }
    return shown.filter(st => !st.isDead && (galaxyId === null || st.galaxyId === galaxyId) && (
      this.mapOverlay === 'life' ? st.hasLife
      : this.mapOverlay === 'civ' ? st.biologyPhase === 'intelligent' && st.civLevel >= 1
      : this.mapOverlay === 'conflict' ? warring.has(st.id)
      : this.mapOverlay === 'trade' ? traders.has(st.id)
      : this.mapOverlay === 'faith' ? !!faith && st.religionName === faith
      : false));
  }

  /** "life: 3 known worlds" — the overlay's count for a galaxy (or everywhere). */
  private overlayCount(engine: BigBangEngine, shown: StarBody[], galaxyId: number | null): string {
    if (this.mapOverlay === 'none') return '';
    const n = this.overlayStars(engine, shown, galaxyId).length;
    const what = ({ life: ['living world', 'living worlds'], civ: ['civilisation', 'civilisations'], conflict: ['world at war', 'worlds at war'],
      trade: ['trading world', 'trading worlds'], faith: ['world of your faith', 'worlds of your faith'], none: ['', ''] } as const)[this.mapOverlay];
    if (this.mapOverlay === 'faith' && !gameState.playerReligionName) return 'no faith yet';
    return n ? `${n} ${n === 1 ? what[0] : what[1]}` : `no ${what[1]} known`;
  }

  /**
   * The observatory's overlay on the map: the known worlds that match it,
   * pips at their stars (sector zoom) or a halo on their galaxy (universe map);
   * wars and trade drawn as the lines between.
   */
  private drawOverlay(engine: BigBangEngine, shown: StarBody[], toScreen: (x: number, y: number) => readonly [number, number], sc: number, animTick: number, W: number, H: number): void {
    const g = this.markerGfx!;
    const col = this.overlayColor();
    const stars = this.overlayStars(engine, shown, null);
    const pulse = 0.6 + 0.4 * Math.sin(animTick * 0.08);
    if (this.mapOverlay === 'conflict') {
      for (const w of engine.activeWars) {
        const a = engine.stars.find(q => q.id === w.attackerStarId), b = engine.stars.find(q => q.id === w.defenderStarId);
        if (!a || !b || (!shown.includes(a) && !shown.includes(b))) continue;
        const [ax, ay] = toScreen(a.x, a.y), [bx, by] = toScreen(b.x, b.y);
        g.moveTo(ax, ay).lineTo(bx, by).stroke({ color: col, width: 1.5, alpha: 0.75 * pulse });
      }
    }
    if (this.mapOverlay === 'trade') {
      const goods: Record<string, number> = { grain: 0xe8c066, ore: 0xd08850, knowledge: 0x6cc8ff };
      for (const r of engine.visibleTradeRoutes()) {
        const a = engine.stars.find(q => q.id === r.a), b = engine.stars.find(q => q.id === r.b);
        if (!a || !b) continue;
        const [ax, ay] = toScreen(a.x, a.y), [bx, by] = toScreen(b.x, b.y);
        g.moveTo(ax, ay).lineTo(bx, by).stroke({ color: goods[r.goods] ?? col, width: 1.5, alpha: 0.85 });
      }
    }
    if (sc >= 0.05) {
      for (const st of stars) {
        const [x, y] = toScreen(st.x, st.y);
        if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
        const size = this.mapOverlay === 'life' ? 2 + Math.max(0, BIO_PHASE_SEQUENCE.indexOf(st.biologyPhase)) : 4;
        const flag = this.mapOverlay === 'civ' ? gameState.factionFlags[st.id] : undefined;
        const c = flag ? cssToHex(flag.primaryColor) : col;
        g.circle(x, y, size + 3).stroke({ color: c, width: 1.5, alpha: 0.85 * (this.mapOverlay === 'conflict' ? pulse : 1) });
        g.rect(Math.round(x) - 1, Math.round(y) - 1, 2, 2).fill({ color: c, alpha: 1 });
      }
    } else {
      // Universe map: a halo on each galaxy, brighter with more matching worlds.
      for (const gal of engine.currentGalaxies) {
        const n = stars.filter(st => st.galaxyId === gal.id).length;
        if (!n) continue;
        const [x, y] = toScreen(gal.cx, gal.cy);
        const r = gal.radius * 1.15 * sc + 4;
        g.circle(x, y, r).stroke({ color: col, width: 2, alpha: Math.min(0.9, 0.3 + n * 0.12) * pulse });
        this.label(`ovh${gal.id}`, String(n), x + r * 0.75, y - r * 0.75 - 8, col, 11, 1);
      }
    }
  }

  private drawGalaxyMarkers(engine: BigBangEngine, shown: StarBody[], camera: Camera, W: number, H: number, animTick: number): void {
    if (!this.markerGfx) { this.markerGfx = new Graphics(); this.labelContainer.addChildAt(this.markerGfx, 0); }
    const g = this.markerGfx;
    g.clear();
    this.labelsUsed.clear();
    const sc = camera.scale;
    const toScreen = (x: number, y: number) => [W / 2 + (x - camera.x) * sc, H / 2 + (y - camera.y) * sc] as const;
    const settled = engine.phase === 'settled' && !engine.cinematicActive;
    // Galaxy names, while the galaxy tier is the subject (on the universe
    // map the sectors carry the names instead).
    const strength = engine.galaxyTierStrength;
    const nameFade = Math.max(0, Math.min(1, (sc - 0.05) / 0.02));
    if (strength > 0.45 && nameFade > 0.01) {
      const knownIn = new Map<number, number>();
      const civsIn = new Map<number, number>();
      if (settled) for (const st of shown) {
        if (st.galaxyId == null) continue;
        knownIn.set(st.galaxyId, (knownIn.get(st.galaxyId) ?? 0) + 1);
        if (!st.isDead && !st.isPlayerStar && st.biologyPhase === 'intelligent' && st.civLevel >= 1) civsIn.set(st.galaxyId, (civsIn.get(st.galaxyId) ?? 0) + 1);
      }
      const homeId = sc < 0.3 ? engine.getPlayerStar()?.galaxyId : undefined;
      for (const gal of engine.currentGalaxies) {
        if (gal.starIds.length === 0) continue;
        let [x, y] = toScreen(gal.x, gal.y - gal.radius * 1.02);
        // The home galaxy wears the YOUR GALAXY brackets out here: name above them.
        if (settled && gal.id === homeId) y = Math.min(y, toScreen(gal.cx, gal.cy)[1] - (gal.radius * 1.12 * sc + 13) - 6);
        if (x < -200 || x > W + 200 || y < -60 || y > H + 60) continue;
        const col = cssToHex(gal.color), a = Math.min(1, (strength - 0.45) / 0.3) * nameFade;
        let alive = 0;
        for (const id of gal.starIds) { const st = engine.stars.find(q => q.id === id); if (st && !st.isDead) alive++; }
        this.label(`gal${gal.id}`, gal.name.toUpperCase(), x, y - 26, col, 13, a);
        const civs = civsIn.get(gal.id) ?? 0;
        const count = settled ? `${alive} systems · ${knownIn.get(gal.id) ?? 0} known${civs ? ` · ${civs} civ${civs > 1 ? 's' : ''}` : ''}` : `${alive} systems`;
        this.label(`galn${gal.id}`, count, x, y - 10, 0x9a8db0, 10, a * 0.9);
        const ov = settled ? this.overlayCount(engine, shown, gal.id) : '';
        if (ov) this.label(`galo${gal.id}`, ov, x, y + 4, this.overlayColor(), 10, a);
      }
      // Dormant galaxies in the other sectors: named as far as they are known
      // (not during the opening cinematic, which is about this sector's birth).
      if (settled) for (const gal of engine.dormantGalaxies) {
        const [x, y] = toScreen(gal.x, gal.y - gal.radius * 1.02);
        if (x < -200 || x > W + 200 || y < -60 || y > H + 60) continue;
        const st = engine.sectorStateOf(gal.sector);
        const a = Math.min(1, (strength - 0.45) / 0.3) * nameFade * (st === 'unknown' ? 0.6 : 1);
        const known = st === 'charted' || st === 'glimpsed';
        this.label(`gal${gal.id}`, known ? gal.name.toUpperCase() : '???', x, y - 26, known ? cssToHex(gal.color) : 0x8a80a0, 13, a);
        this.label(`galn${gal.id}`, st === 'charted' ? `~${gal.systems} systems · dormant` : st === 'glimpsed' ? 'glimpsed · not yet charted' : 'uncharted', x, y - 10, 0x7f7498, 10, a * 0.9);
      }
    }
    if (settled) this.drawSectorGrid(engine, shown, toScreen, sc, animTick);
    if (settled && this.mapOverlay !== 'none' && sc < 1.6) this.drawOverlay(engine, shown, toScreen, sc, animTick, W, H);
    // Out at universe zoom the home WORLD is a speck: mark the home GALAXY.
    // (On the universe map YOUR SECTOR takes over.)
    const ps = settled && sc < 0.3 && sc >= 0.05 ? engine.getPlayerStar() : undefined;
    const homeGal = ps ? engine.currentGalaxies.find(q => q.id === ps.galaxyId) : undefined;
    if (ps && homeGal) {
      const a = Math.min(1, (0.3 - sc) / 0.08);
      const [x, y] = toScreen(homeGal.cx, homeGal.cy);
      const r = homeGal.radius * 1.12 * sc + 6;
      const pulse = 0.7 + 0.3 * Math.sin(animTick * 0.05);
      const n = Math.max(24, Math.round(r * 0.55));
      for (let i = 0; i < n; i++) {
        const th = i / n * Math.PI * 2 + animTick * 0.002;
        g.rect(Math.round(x + Math.cos(th) * r) - 1, Math.round(y + Math.sin(th) * r) - 1, 2, 2).fill({ color: 0xffcc44, alpha: 0.6 * a * pulse });
      }
      const p = r + 7, arm = 8;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        const bx = x + sx * p, by = y + sy * p;
        g.rect(sx < 0 ? bx : bx - arm, sy < 0 ? by : by - 2, arm, 2).fill({ color: 0xffcc44, alpha: a * pulse });
        g.rect(sx < 0 ? bx : bx - 2, sy < 0 ? by : by - arm, 2, arm).fill({ color: 0xffcc44, alpha: a * pulse });
      }
      this.label('yourgal', 'YOUR GALAXY', x, y + p + 12, 0xffd27a, 11, a);
      // Your world inside it: one gold pixel pip.
      const [wx, wy] = toScreen(ps.x, ps.y);
      g.rect(Math.round(wx) - 1, Math.round(wy) - 1, 3, 3).fill({ color: 0xffd27a, alpha: 0.95 });
    }
    // Radio signals still being decoded: ripples spreading from their source.
    if (settled && sc < 1.6) {
      const now = engine.currentTick;
      for (const sig of engine.currentCosmicSignals) {
        if (sig.decoded) continue;
        const src = engine.stars.find(q => q.id === sig.starId);
        if (!src || src.isDead) continue;
        const [x, y] = toScreen(src.x, src.y);
        if (x < -80 || x > W + 80 || y < -80 || y > H + 80) continue;
        for (let k = 0; k < 3; k++) {
          const f = ((animTick / 110) + k / 3) % 1;
          g.circle(x, y, 7 + 46 * f).stroke({ color: 0x6cf0ff, width: 1.5, alpha: 0.65 * (1 - f) });
        }
        if (sc >= 0.3) {
          const pct = Math.max(0, Math.min(99, Math.floor((now - sig.startTick) / Math.max(1, sig.decodedAt - sig.startTick) * 100)));
          this.label(`sig${sig.starId}`, `SIGNAL · DECODING ${pct}%`, x, y - 22, 0x8ff4ff, 10, 0.95);
        }
      }
    }
    if (settled && sc < 1.6) {
      const pulse = 0.6 + 0.3 * Math.sin(animTick * 0.05);
      const labels = sc >= 0.3;
      for (const st of shown) {
        if (st.isDead) continue;
        const [x, y] = toScreen(st.x, st.y);
        if (x < -40 || x > W + 40 || y < -40 || y > H + 40) continue;
        if (st.isPlayerStar) {
          if (sc < 0.3) continue;   // the YOUR GALAXY marker covers it out here
          const p = 13, arm = 5;
          for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
            const cx = x + sx * p, cy = y + sy * p;
            g.rect(sx < 0 ? cx : cx - arm, sy < 0 ? cy : cy - 1.5, arm, 1.5).fill({ color: 0xffcc44, alpha: pulse });
            g.rect(sx < 0 ? cx : cx - 1.5, sy < 0 ? cy : cy - arm, 1.5, arm).fill({ color: 0xffcc44, alpha: pulse });
          }
          this.label('you', 'YOUR WORLD', x, y + 17, 0xffd27a, 11);
          continue;
        }
        if (st.biologyPhase === 'intelligent' && st.civLevel >= 1) {
          const flag = gameState.factionFlags[st.id];
          const col = flag ? cssToHex(flag.primaryColor) : cssToHex(CIV_COLORS[Math.min(st.civLevel, CIV_COLORS.length - 1)]);
          g.circle(x, y, 9).stroke({ color: col, width: 1.5, alpha: 0.85 });
          if (labels) this.label(`civ${st.id}`, `${st.civName} · ${engine.eraNameOf(st)}`, x, y + 12, 0xd8ccf0, 10, 0.95);
        } else if (st.hasLife) {
          g.rect(Math.round(x + 6), Math.round(y - 7), 2, 2).fill({ color: 0x5dcc8a, alpha: 0.9 });
        }
      }
    }
    for (const [k, t] of this.labelPool) if (!this.labelsUsed.has(k)) t.visible = false;
  }

  // ─── Trade routes ─────────────────────────────────────────────────────────

  /**
   * The trade routes the civilisations opened (StarPolities): a dotted lane in
   * the colour of what it carries — gold grain, copper ore, blue knowledge —
   * with cargo ships plying it, laden toward the people that lacked it.
   */
  private drawTradeRoutes(routes: TradeRoute[], starMap: Map<number, StarBody>, animTick: number, camera: Camera): void {
    this.tradeLayer.clear();
    if (camera.scale < 0.3) return;
    const COLOR: Record<string, number> = { grain: 0xe8c066, ore: 0xd08850, knowledge: 0x6cc8ff };
    const px = 1 / camera.scale;
    for (const r of routes) {
      const a = starMap.get(r.a), b = starMap.get(r.b);
      if (!a || !b) continue;
      const color = COLOR[r.goods] ?? 0xe8c066;
      dashedLine(this.tradeLayer, a.x, a.y, b.x, b.y, 2 * px, 5 * px, color, 0.8 * px, 0.35);
      // Ships: three on the lane, the laden ones heading for the receiver.
      const [from, to] = r.to === r.a ? [b, a] : [a, b];
      const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
      const ux = (to.x - from.x) / len, uy = (to.y - from.y) / len;
      for (let k = 0; k < 3; k++) {
        const outbound = k !== 1;            // two laden ships toward the receiver, one coming back
        let t = ((animTick * 0.0016 * (240 / Math.max(120, len)) + k / 3 + (r.a * 0.137)) % 1);
        if (!outbound) t = 1 - t;
        const x = from.x + (to.x - from.x) * t, y = from.y + (to.y - from.y) * t;
        const sx = outbound ? ux : -ux, sy = outbound ? uy : -uy;
        const sz = (outbound ? 2.4 : 1.8) * px;
        // A small hull: nose forward, square stern.
        this.tradeLayer
          .moveTo(x + sx * sz * 1.6, y + sy * sz * 1.6)
          .lineTo(x - sx * sz - sy * sz * 0.8, y - sy * sz + sx * sz * 0.8)
          .lineTo(x - sx * sz + sy * sz * 0.8, y - sy * sz - sx * sz * 0.8)
          .closePath()
          .fill({ color: outbound ? color : 0xcfd6e6, alpha: 0.95 });
      }
    }
  }

  // ─── Stars ────────────────────────────────────────────────────────────────

  /** Nearest-neighbour texture from a baked canvas (shared across sprites). */
  private nearestTex(
    cache: Map<string, Texture>,
    key: string,
    canvas: HTMLCanvasElement,
  ): Texture {
    const hit = cache.get(key);
    if (hit) return hit;
    const tex = Texture.from(canvas);
    tex.source.scaleMode = 'nearest';
    cache.set(key, tex);
    return tex;
  }

  /** Soft (linear) texture — for real glow under pixel suns. */
  private linearTex(
    cache: Map<string, Texture>,
    key: string,
    canvas: HTMLCanvasElement,
  ): Texture {
    const hit = cache.get(key);
    if (hit) return hit;
    const tex = Texture.from(canvas);
    tex.source.scaleMode = 'linear';
    cache.set(key, tex);
    return tex;
  }

  private drawStars(
    stars: StarBody[], playerStarId: number,
    animTick: number, camera: Camera,
    budgetTight = false,
  ): void {
    this.starLayer.clear();
    for (const sprite of this.starSprites.values()) sprite.visible = false;
    for (const sprite of this.starGlowSprites.values()) sprite.visible = false;
    for (const sprite of this.starHazeSprites.values()) sprite.visible = false;
    for (const sprite of this.starCoronaSprites.values()) sprite.visible = false;

    const { halfW, halfH } = viewHalfExtents(camera, 80 / Math.max(0.01, camera.scale));

    for (const star of stars) {
      if (!inView(star.x, star.y, camera, halfW, halfH)) continue;

      // Dead remnants stay visible as compact corpses (not skipped).
      if (star.isDead) {
        const kind = star.remnantKind ?? 'white_dwarf';
        const size = Math.max(star.radius * 2.4, 1.5);
        if (kind === 'black_hole') {
          const ringW = Math.max(0.35, 0.7 / Math.max(0.01, camera.scale));
          this.starLayer.circle(star.x, star.y, size * 0.9).stroke({
            color: 0xff7744, width: ringW, alpha: 0.5,
          });
          this.starLayer.circle(star.x, star.y, size * 0.42).fill({ color: 0x040406, alpha: 0.98 });
          this.starLayer.circle(star.x, star.y, size * 0.18).fill({ color: 0x1a1018, alpha: 0.9 });
        } else {
          const band = kind === 'neutron' ? 'blue' : 'white';
          const glowKey = `glow|${band}`;
          const glowTex = this.linearTex(
            this.starGlowTextures, glowKey, bakeStarGlow(band, 160),
          );
          let glow = this.starGlowSprites.get(star.id);
          if (!glow) {
            glow = new Sprite(glowTex);
            glow.anchor.set(0.5);
            this.glowLayer.addChild(glow);
            this.starGlowSprites.set(star.id, glow);
          } else if (glow.texture !== glowTex) {
            glow.texture = glowTex;
          }
          glow.width = size * (kind === 'neutron' ? 2.2 : 1.8);
          glow.height = glow.width;
          glow.x = star.x;
          glow.y = star.y;
          glow.alpha = kind === 'neutron' ? 0.45 : 0.28;
          glow.zIndex = 1;
          glow.visible = true;

          const texKey = `body|${band}`;
          const tex = this.nearestTex(this.starTextures, texKey, bakeStarBody(band, 48));
          let sprite = this.starSprites.get(star.id);
          if (!sprite) {
            sprite = new Sprite(tex);
            sprite.anchor.set(0.5);
            this.bodyLayer.addChild(sprite);
            this.starSprites.set(star.id, sprite);
          } else if (sprite.texture !== tex) {
            sprite.texture = tex;
          }
          sprite.width = size * (kind === 'neutron' ? 0.7 : 0.85);
          sprite.height = sprite.width;
          sprite.x = star.x;
          sprite.y = star.y;
          sprite.alpha = kind === 'neutron' ? 0.95 : 0.75;
          sprite.visible = true;
        }
        continue;
      }

      const band = starTempBand(star.temperature);
      const profile = starVisualProfile(band);
      // At least a few screen pixels out at galaxy zoom, so a known world never vanishes into the galaxy's light.
      const size = Math.max(star.radius * 3.4, 2.2, camera.scale < 1.6 ? 5 / camera.scale : 0);
      const pulse = 1 + profile.pulseAmp * Math.sin(animTick * profile.pulseSpeed + star.id);
      const sc = camera.scale;
      // Far zoom: body + glow only. Corona/haze are fill-rate heavy across a galaxy.
      // Under a tight 120Hz budget, keep bloom on the focused sun only.
      const wantHaze = sc >= 0.35 && (!budgetTight || star.isPlayerStar);
      const wantCorona = (sc >= 0.85 || star.isPlayerStar) && (!budgetTight || star.isPlayerStar);

      // Outer soft haze (wider, dimmer) — type-scaled
      if (wantHaze) {
        const hazeKey = `haze|${band}`;
        const hazeTex = this.linearTex(
          this.starGlowTextures, hazeKey, bakeStarGlow(band, 160),
        );
        let haze = this.starHazeSprites.get(star.id);
        if (!haze) {
          haze = new Sprite(hazeTex);
          haze.anchor.set(0.5);
          this.glowLayer.addChild(haze);
          this.starHazeSprites.set(star.id, haze);
        } else if (haze.texture !== hazeTex) {
          haze.texture = hazeTex;
        }
        const hazeSize = size * profile.hazeMul * pulse;
        haze.width = hazeSize;
        haze.height = hazeSize;
        haze.x = star.x;
        haze.y = star.y;
        haze.alpha = profile.hazeAlpha * (0.85 + 0.15 * pulse);
        haze.zIndex = 0;
        haze.visible = true;
      }

      // Inner soft bloom
      const glowKey = `glow|${band}`;
      const glowTex = this.linearTex(
        this.starGlowTextures, glowKey, bakeStarGlow(band, 160),
      );
      let glow = this.starGlowSprites.get(star.id);
      if (!glow) {
        glow = new Sprite(glowTex);
        glow.anchor.set(0.5);
        this.glowLayer.addChild(glow);
        this.starGlowSprites.set(star.id, glow);
      } else if (glow.texture !== glowTex) {
        glow.texture = glowTex;
      }
      const glowSize = size * profile.glowMul * pulse;
      glow.width = glowSize;
      glow.height = glowSize;
      glow.x = star.x;
      glow.y = star.y;
      // Held back so the pixel corona's rays still read on top of it.
      glow.alpha = Math.min(1, profile.glowAlpha * pulse) * (wantCorona ? 0.55 : 1);
      glow.zIndex = 1;
      glow.visible = true;

      // Each star keeps one of a few surface layouts (spots, ray pattern).
      const sunSeed = 5 + (star.id % 3);
      // Zoomed in close (the system view goes to scale 12): bake at twice the
      // resolution so the sun keeps its pixel detail instead of 5x blocks.
      const big = size * camera.scale > 150;
      const bodyPx = big ? 96 : 48, coronaPx = big ? 160 : 80;
      // Animated pixel corona (rotates; length/speed by spectral class)
      if (wantCorona) {
        const coronaKey = big ? `corona|${band}|${sunSeed}|${coronaPx}` : `corona|${band}|${sunSeed}`;
        const coronaTex = this.nearestTex(
          this.starCoronaTextures, coronaKey, bakeStarCorona(band, coronaPx, sunSeed),
        );
        let corona = this.starCoronaSprites.get(star.id);
        if (!corona) {
          corona = new Sprite(coronaTex);
          corona.anchor.set(0.5);
          this.glowLayer.addChild(corona);
          this.starCoronaSprites.set(star.id, corona);
        } else if (corona.texture !== coronaTex) {
          corona.texture = coronaTex;
        }
        // Body is 0.30 of its sprite, the corona's disc CORONA_BODY_FRAC of its own.
        const coronaSize = size * (0.30 / CORONA_BODY_FRAC) * (1 + 0.05 * Math.sin(animTick * profile.pulseSpeed * 1.7 + star.id));
        // Per-star rate + direction so neighbouring suns don't lock-step.
        const spinMul = 0.45 + ((star.id * 47) % 97) / 97 * 1.1; // ~0.45–1.55
        const spinDir = (star.id * 13) & 1 ? 1 : -1;
        corona.width = coronaSize;
        corona.height = coronaSize;
        corona.x = star.x;
        corona.y = star.y;
        corona.rotation = animTick * profile.coronaSpeed * spinMul * spinDir + star.id * 1.918;
        corona.alpha = 0.85 + 0.15 * Math.sin(animTick * profile.pulseSpeed * (0.7 + (star.id % 5) * 0.08) + star.id * 0.3);
        corona.zIndex = 2;
        corona.visible = true;
      }

      // Pixel body on top; its granulation boils through a short frame loop.
      const frame = Math.floor(animTick / 15 + star.id * 3) % STAR_BODY_FRAMES;
      const texKey = big ? `body|${band}|${frame}|${sunSeed}|${bodyPx}` : `body|${band}|${frame}|${sunSeed}`;
      const tex = this.nearestTex(this.starTextures, texKey, bakeStarBody(band, bodyPx, frame, sunSeed));
      let sprite = this.starSprites.get(star.id);
      if (!sprite) {
        sprite = new Sprite(tex);
        sprite.anchor.set(0.5);
        this.bodyLayer.addChild(sprite);
        this.starSprites.set(star.id, sprite);
      } else if (sprite.texture !== tex) {
        sprite.texture = tex;
      }

      const bodyPulse = 1 + profile.pulseAmp * 0.35 * Math.sin(animTick * profile.pulseSpeed * 0.8);
      sprite.width = size * bodyPulse;
      sprite.height = size * bodyPulse;
      sprite.x = star.x;
      sprite.y = star.y;
      sprite.visible = true;
      // The opening cinematic keeps the player's sun a dim protostar until it ignites.
      const L = star.isPlayerStar ? this.homeLight : 1;
      sprite.tint = L < 1 ? Math.round(0x80 + 0x7f * L) << 16 | Math.round(0x30 + 0xcf * L) << 8 | Math.round(0x20 + 0xdf * L) : 0xffffff;
      sprite.alpha = L < 1 ? 0.55 + 0.45 * L : 1;
      if (L < 1) {
        glow.alpha *= L;
        const hz = this.starHazeSprites.get(star.id); if (hz && hz.visible) hz.alpha *= L;
        const co = this.starCoronaSprites.get(star.id); if (co && co.visible) co.alpha *= L * L;
      }

      if (star.isPlayerStar && camera.scale < 1.6 && camera.scale >= 1.2) {
        // Corner brackets outside the corona, not a box drawn across the sun.
        // (Closer in, the brackets frame the home WORLD instead.)
        const alpha = 0.55 + 0.25 * Math.sin(animTick * 0.05);
        const pad = size * 0.78;
        const t = Math.max(0.5, 0.9 / camera.scale);
        const arm = pad * 0.32;
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            const x = star.x + sx * pad, y = star.y + sy * pad;
            this.starLayer.rect(sx < 0 ? x : x - arm, sy < 0 ? y : y - t, arm, t).fill({ color: 0xffcc44, alpha });
            this.starLayer.rect(sx < 0 ? x : x - t, sy < 0 ? y : y - arm, t, arm).fill({ color: 0xffcc44, alpha });
          }
        }
      }

      if (star.civLevel > 0) {
        const civColor = cssToHex(CIV_COLORS[Math.min(star.civLevel, CIV_COLORS.length - 1)]);
        pixelOrbit(this.starLayer, star.x, star.y, size * 0.38, civColor, 0.7, camera.scale);
      }
    }

    void playerStarId;
    this.drawFactionFlags(stars, camera);
  }

  /** Cache key — flags with identical appearance share one texture. */
  private flagKey(f: FactionFlag): string {
    return f.primaryColor + '|' + f.secondaryColor + '|' + f.symbol;
  }

  /** Bake a flag into a texture using the same Canvas 2D routine as before. */
  private flagTexture(flag: FactionFlag): Texture {
    const key = this.flagKey(flag);
    const cached = this.flagTextures.get(key);
    if (cached) return cached;

    const W = 48, H = 32;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (ctx) drawFactionFlag(ctx, flag, W / 2, H / 2, H);

    const tex = Texture.from(canvas);
    tex.source.scaleMode = 'nearest';
    this.flagTextures.set(key, tex);
    return tex;
  }

  private drawFactionFlags(stars: StarBody[], camera: Camera): void {
    const show = camera.scale >= 0.6;

    // Hide everything first; only qualifying stars get switched back on. Sprites
    // are kept alive between frames so this stays allocation-free.
    for (const sprite of this.flagSprites.values()) sprite.visible = false;
    if (!show) return;

    for (const star of stars) {
      if (star.isDead || !star.hasLife || star.civLevel < 1) continue;
      const flag = gameState.factionFlags[star.id];
      if (!flag) continue;

      let sprite = this.flagSprites.get(star.id);
      if (!sprite) {
        sprite = new Sprite(this.flagTexture(flag));
        sprite.anchor.set(0.5);
        this.flagLayer.addChild(sprite);
        this.flagSprites.set(star.id, sprite);
      }

      // A readable flag out at galaxy zoom (constant on screen), world-sized close in.
      const k = camera.scale < 1.6 ? 1 / camera.scale : 1;
      const size = camera.scale < 1.6 ? 9 : 6;
      sprite.width = size * 1.5 * k;
      sprite.height = size * k;
      sprite.x = star.x;
      sprite.y = camera.scale < 1.6 ? star.y - 17 * k : star.y - star.radius * 5 - 4;
      sprite.visible = true;
    }
  }

  // ─── Religions ────────────────────────────────────────────────────────────

  private drawReligions(
    stars: StarBody[],
    revelationFlashes: RevelationFlash[],
    animTick: number,
    camera: Camera,
  ): void {
    this.religionLayer.clear();
    if (camera.scale < 0.35) return;

    for (const star of stars) {
      if (!star.religionName || star.religionDevotion <= 0 || star.isDead) continue;
      const pulse = 0.6 + 0.4 * Math.sin(animTick * 0.025 + star.id * 0.8);
      const outer = star.radius * (2.5 + star.religionDevotion * 2);
      this.religionLayer.circle(star.x, star.y, outer).stroke({
        color: 0xffcc44, width: 0.8 / camera.scale, alpha: pulse * star.religionDevotion,
      });
    }

    // Revelation flashes
    for (const fl of revelationFlashes) {
      const age = animTick - fl.startAnimTick;
      if (age > 60) continue;
      const t = age / 60;
      const fr = 20 + t * 80;
      this.religionLayer.circle(fl.x, fl.y, fr).stroke({ color: 0xffcc44, width: 2 / camera.scale, alpha: (1 - t) * 0.8 });
    }
  }

  // ─── Asteroids ────────────────────────────────────────────────────────────

  private drawAsteroids(asteroids: AsteroidBody[]): void {
    this.asteroidLayer.clear();
    for (const a of asteroids) {
      if (!a.alive) continue;
      this.asteroidLayer.rect(a.x - a.radius, a.y - a.radius, a.radius * 2, a.radius * 2)
        .fill({ color: 0x888888, alpha: 0.75 });
    }
  }

  // ─── Fleets ───────────────────────────────────────────────────────────────

  private drawFleets(fleets: Fleet[], starMap: Map<number, StarBody>, camera: Camera): void {
    this.fleetLayer.clear();

    for (const fleet of fleets) {
      const from = starMap.get(fleet.fromStarId);
      const to   = starMap.get(fleet.toStarId);
      if (!from || !to) continue;

      const color = fleet.hostile ? 0xff6644 : 0x44aaff;

      // Dashed trail line
      dashedLine(
        this.fleetLayer,
        from.x, from.y, to.x, to.y,
        4 / camera.scale, 8 / camera.scale,
        color, 0.8 / camera.scale, 0.3,
      );

      // Ship triangle at fleet position
      const dx = to.x - from.x, dy = to.y - from.y;
      const angle = Math.atan2(dy, dx);
      const ts = 4 / camera.scale;
      const tx = fleet.x, ty = fleet.y;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const p1x = tx + cos * ts * 2,          p1y = ty + sin * ts * 2;
      const p2x = tx - cos * ts + sin * ts,   p2y = ty - sin * ts - cos * ts;
      const p3x = tx - cos * ts - sin * ts,   p3y = ty - sin * ts + cos * ts;

      this.fleetLayer
        .moveTo(p1x, p1y).lineTo(p2x, p2y).lineTo(p3x, p3y).closePath()
        .fill({ color, alpha: 0.9 });
    }
  }

  // ─── Orbital fleets ───────────────────────────────────────────────────────

  private drawOrbitalFleets(
    orbitalFleets: OrbitalFleet[],
    starMap: Map<number, StarBody>,
    animTick: number,
    camera: Camera,
  ): void {
    // Only render first orbital fleet per star (orbit ring + ship)
    const seen = new Set<number>();
    for (const of_ of orbitalFleets) {
      const star = starMap.get(of_.starId);
      if (!star) continue;

      if (!seen.has(of_.starId)) {
        // Orbit ring (circle)
        this.fleetLayer
          .circle(star.x, star.y, of_.orbitRadius)
          .stroke({ color: cssToHex(of_.civColor), width: 0.6 / camera.scale, alpha: 0.3 });
        seen.add(of_.starId);
      }

      // Ship at orbital position
      const angle = of_.angle + animTick * of_.speed * 0.016;
      const sx = star.x + Math.cos(angle) * of_.orbitRadius;
      const sy = star.y + Math.sin(angle) * of_.orbitRadius;
      const tangent = angle + Math.PI / 2;
      const ts = 3 / camera.scale;
      const cos = Math.cos(tangent), sin = Math.sin(tangent);
      this.fleetLayer
        .moveTo(sx + cos * ts * 2, sy + sin * ts * 2)
        .lineTo(sx - cos * ts + sin * ts, sy - sin * ts - cos * ts)
        .lineTo(sx - cos * ts - sin * ts, sy - sin * ts + cos * ts)
        .closePath()
        .fill({ color: cssToHex(of_.civColor), alpha: 0.85 });
    }
  }

  // ─── Wars ─────────────────────────────────────────────────────────────────

  private drawWars(
    wars: War[], starMap: Map<number, StarBody>, animTick: number, camera: Camera,
  ): void {
    this.warLayer.clear();

    for (const war of wars) {
      if (war.resolved) continue;
      const def = starMap.get(war.defenderStarId);
      if (!def) continue;

      const pulseSpeed = war.phase === 'siege' ? 0.12
                       : war.phase === 'campaign' ? 0.07 : 0.04;
      const pulse = 0.5 + 0.5 * Math.sin(animTick * pulseSpeed);
      const ringR = def.radius * 3 + pulse * def.radius;

      this.warLayer.circle(def.x, def.y, ringR).stroke({
        color: 0xff2222, width: 1 / camera.scale, alpha: 0.5 + pulse * 0.4,
      });

      // Strength bars (screen-space would be better but world-space is simpler for prototype)
      if (camera.scale >= 0.4) {
        const barW = 20 / camera.scale;
        const barH = 2.5 / camera.scale;
        const bx = def.x - barW / 2;
        const by = def.y + def.radius * 4;
        this.warLayer.rect(bx, by, barW, barH).fill({ color: 0x333333 });
        this.warLayer.rect(bx, by, barW * war.attackerStrength, barH).fill({ color: 0xff4444 });
        this.warLayer.rect(bx + barW * war.attackerStrength, by, barW * war.defenderStrength, barH).fill({ color: 0x4488ff });
      }
    }
  }

  // ─── Planets ──────────────────────────────────────────────────────────────

  private drawPlanets(
    stars: StarBody[], playerStarId: number, animTick: number, camera: Camera,
  ): void {
    this.planetLayer.clear();
    for (const sprite of this.planetSprites.values()) sprite.visible = false;
    for (const sprite of this.moonSprites.values()) sprite.visible = false;

    if (camera.scale < 0.5) return;

    // System zoom and closer: terrain globes (same bake as surface/diorama).
    // Farther out: compact pixel orbs so galaxies stay readable.
    const useGlobe = camera.scale >= 1.6;
    const { halfW, halfH } = viewHalfExtents(camera, 140 / Math.max(0.01, camera.scale));

    for (const star of stars) {
      // Remnant husks only at system zoom; living systems earlier.
      if (star.isDead) {
        if (camera.scale < 1.4) continue;
      } else if (!star.isPlayerStar && camera.scale < 1.2) {
        continue;
      }
      // System zoom used to draw every planet in the cosmos — with wider
      // spacing that meant dozens of off-screen Kepler orbit polylines/frame.
      if (!inView(star.x, star.y, camera, halfW, halfH)) continue;

      for (let i = 0; i < star.planets.length; i++) {
        const planet = star.planets[i];
        const off = planetOffsetFromStar(planet, animTick);
        const px = star.x + off.x;
        const py = star.y + off.y;

        // The opening cinematic: the player's worlds condense out of the disc.
        const reveal = star.isPlayerStar ? this.homePlanets : 1;
        if (reveal <= 0.01) continue;
        if (camera.scale > 1.15 && (star.isPlayerStar || camera.scale > 2.2) && reveal > 0.6) {
          pixelPlanetOrbit(
            this.planetLayer, star.x, star.y, planet,
            star.isDead ? 0x666660 : star.isPlayerStar ? 0xc8a96e : 0xffffff,
            star.isDead ? 0.15 : star.isPlayerStar ? 0.4 : 0.2,
            camera.scale,
          );
        }

        // A forming home world shows its molten stage, like the planet view.
        const formingHome = star.isPlayerStar && !!star.formationDestiny && !!star.formationStage;
        const kind = formingHome ? 'lava' as PlanetKind : (planet.type as PlanetKind) || 'rocky';
        const withRings = kind === 'gas' && !planet.isDead;
        const seed = (star.id * 17 + i * 31) | 0;
        const landedIdx = star.planets.findIndex(p => p.discovery === 'landing');
        const homeIdx = star.isPlayerStar ? (landedIdx >= 0 ? landedIdx : (star.bestPlanetIndex ?? 0)) : -1;
        const isHome = star.isPlayerStar && i === homeIdx && !planet.isDead;
        const dna = isHome
          ? (gameState.playerPlanetDNA ?? planet.dna ?? DEFAULT_PLANET_DNA)
          : (planet.dna ?? DEFAULT_PLANET_DNA);
        const bioPhase = (isHome && planet.hasLife)
          ? (star.biologyPhase ?? null) : null;
        const grid = isHome ? runtimeState.playerPlanetGrid : null;

        let tex: Texture;
        if (useGlobe && !planet.isDead) {
          const lifeKey = planet.hasLife ? 1 : 0;
          const dnaKey = `${dna.climate}|${dna.oceans}|${dna.chaos}`;
          // Big on screen (zoomed in close): bake the globe at twice the
          // resolution so it stays crisp pixel art instead of 3x blocks.
          const onScreen = Math.max(planet.radius * 3.2, 2.0 / camera.scale) * camera.scale;
          const gs = onScreen > 80 ? 96 : 48;
          const texKey = `globe|${star.id}|${i}|${kind}|${isHome ? star.formationStage ?? '' : ''}|${lifeKey}|${dnaKey}|${bioPhase ?? ''}|${withRings ? 1 : 0}|${gs}`;
          let cached = this.planetTextures.get(texKey);
          if (!cached) {
            const equirect = bakePlanetTexture(
              star.id, i, kind, dna, gs * 2, bioPhase, grid,
            );
            const ringTint = parseHexColor(planet.color, [200, 190, 160]);
            const globe = wrapEquirectToGlobe(equirect, gs, {
              rings: withRings,
              ringTint,
              seed: seed ^ (lifeKey * 997) ^ (bioPhase ? 13 : 0),
            });
            cached = this.nearestTex(this.planetTextures, texKey, globe);
          }
          tex = cached;
        } else {
          const deadKey = planet.isDead ? 1 : 0;
          const texKey = `p|${kind}|${planet.hasLife ? 1 : 0}|${deadKey}|${seed}|${planet.color}|${withRings ? 1 : 0}`;
          tex = this.nearestTex(
            this.planetTextures,
            texKey,
            bakePlanetSprite(kind, planet.hasLife, {
              size: 24, seed, colorHex: planet.color, rings: withRings,
            }),
          );
        }

        const spriteKey = `${star.id}:${i}`;
        let sprite = this.planetSprites.get(spriteKey);
        if (!sprite) {
          sprite = new Sprite(tex);
          sprite.anchor.set(0.5);
          this.bodyLayer.addChild(sprite);
          this.planetSprites.set(spriteKey, sprite);
        } else if (sprite.texture !== tex) {
          sprite.texture = tex;
        }

        const body = Math.max(planet.radius * 3.2, 2.0 / camera.scale) * (0.35 + 0.65 * reveal);
        sprite.alpha = reveal;
        if (withRings) {
          sprite.width = body * 1.85;
          sprite.height = body * 1.15;
        } else {
          sprite.width = body;
          sprite.height = body;
        }
        sprite.x = px;
        sprite.y = py;
        sprite.visible = true;

        if (isHome && camera.scale >= 1.6 && reveal >= 1) {
          // The player's world: gold corner brackets, pulsing.
          const alpha = 0.6 + 0.3 * Math.sin(animTick * 0.05);
          const pad = body * 0.85 + 2 / camera.scale, t = Math.max(0.3, 1 / camera.scale), arm = pad * 0.45;
          for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
            const x = px + sx * pad, y = py + sy * pad;
            this.planetLayer.rect(sx < 0 ? x : x - arm, sy < 0 ? y : y - t, arm, t).fill({ color: 0xffcc44, alpha });
            this.planetLayer.rect(sx < 0 ? x : x - t, sy < 0 ? y : y - arm, t, arm).fill({ color: 0xffcc44, alpha });
          }
        }
        if (planet.hasLife) {
          const bp = 0.45 + 0.35 * Math.sin(animTick * 0.05);
          pixelOrbit(this.planetLayer, px, py, body * 0.72, 0x44ff88, bp, camera.scale);
        }

        if (planet.moons.length > 0) {
          for (let m = 0; m < planet.moons.length; m++) {
            const moon = planet.moons[m];
            // Size by class (MoonSize): giants show from further out, captured
            // rocks only up close; each keeps its own orbit radius.
            if (camera.scale < moonViewMinScale(moon, planet)) continue;
            const mSize = moonViewSize(moon, planet, camera.scale);
            const ma = moon.orbitalAngle + animTick * moon.orbitalSpeed;
            const moonOrbit = moonViewOrbit(moon, m, body);
            const mx = px + Math.cos(ma) * moonOrbit;
            const my = py + Math.sin(ma) * moonOrbit;

            const mk = (moon.kind as MoonKind) || 'rock';
            // Big enough on screen: the shared MoonArt moon (the planet view
            // draws the same one), lit from its star, colony and all.
            const mOnScreen = mSize * camera.scale;
            const irr = moonIsIrregular(moon, planet);
            let mTex: Texture;
            if (mOnScreen >= 6 || irr) {
              const px = mOnScreen >= 28 ? 32 : mOnScreen >= 12 ? 16 : 8;
              const la = Math.round(Math.atan2(star.y - my, star.x - mx) / (Math.PI / 8));
              const mTexKey = `moonart|${star.id}|${i}|${m}|${px}|${la}|${moon.colonised ? 1 : 0}|${irr ? 1 : 0}`;
              mTex = this.moonTextures.get(mTexKey) ?? this.nearestTex(this.moonTextures, mTexKey, (() => {
                const f = paintMoon({
                  kind: mk as MoonKindArt, rgb: parseHexColor(moon.color, [180, 176, 168]) as [number, number, number],
                  size: px, seed: (planet.genomeSeed ?? 1) * 31 + m * 977,
                  lx: Math.cos(la * Math.PI / 8), ly: Math.sin(la * Math.PI / 8), colonised: moon.colonised,
                  irregular: irr,
                });
                const cv = document.createElement('canvas');
                cv.width = f.width; cv.height = f.height;
                const cg = cv.getContext('2d');
                if (cg) { const img = cg.createImageData(f.width, f.height); img.data.set(f.data); cg.putImageData(img, 0, 0); }
                return cv;
              })());
            } else {
              mTex = this.nearestTex(this.moonTextures, `moon|${mk}`, bakeMoonSprite(mk, 8));
            }
            const mKey = `${star.id}:${i}:m${m}`;
            let mSprite = this.moonSprites.get(mKey);
            if (!mSprite) {
              mSprite = new Sprite(mTex);
              mSprite.anchor.set(0.5);
              this.bodyLayer.addChild(mSprite);
              this.moonSprites.set(mKey, mSprite);
            } else if (mSprite.texture !== mTex) {
              mSprite.texture = mTex;
            }

            // A lumpy body fills ~3/4 of its texture box: draw the box larger
            // so its silhouette, not its box, matches the size class.
            const mBox = irr ? mSize * 1.3 : mSize;
            mSprite.width = mBox;
            mSprite.height = mBox;
            mSprite.x = mx;
            mSprite.y = my;
            mSprite.alpha = reveal;
            mSprite.visible = true;
          }
        }
      }
    }

    void playerStarId;
  }

  // ─── Cosmic effects (supernovas) ──────────────────────────────────────────

  private drawCosmicEffects(
    flashes: SupernovaFlash[],
    animTick: number,
    camera: Camera,
    W: number, H: number,
  ): void {
    this.cosmicLayer.clear();

    for (const fl of flashes) {
      const age = animTick - fl.startAnimTick;
      if (age > 120) continue;
      const t = age / 120;

      // Convert world to screen for screen-space effect
      const sx = fl.x * camera.scale + (W / 2 - camera.x * camera.scale);
      const sy = fl.y * camera.scale + (H / 2 - camera.y * camera.scale);

      // Inner flash (fades fast)
      if (t < 0.3) {
        const ft = t / 0.3;
        const fr = fl.maxRadius * ft * 0.4;
        this.cosmicLayer.circle(sx, sy, fr).fill({ color: 0xffffff, alpha: (1 - ft) * 0.9 });
      }

      // Expanding shockwave ring
      const ringR = fl.maxRadius * t;
      const ringW = Math.max(0.5, 2 * (1 - t));
      this.cosmicLayer.circle(sx, sy, ringR).stroke({ color: 0xffcc66, width: ringW, alpha: 1 - t });

      // Outer debris ring (slower)
      const debrisR = fl.maxRadius * t * 0.7;
      this.cosmicLayer.circle(sx, sy, debrisR).stroke({ color: 0xff8844, width: 0.5, alpha: (1 - t) * 0.4 });
    }
  }
}
