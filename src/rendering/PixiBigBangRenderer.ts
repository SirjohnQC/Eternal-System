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

import { CIV_COLORS, gameState, runtimeState, DEFAULT_PLANET_DNA } from '../simulation/GameState';
import { drawFactionFlag, type FactionFlag } from '../simulation/FactionFlag';
import { bakePlanetTexture } from '../simulation/PlanetRenderer';
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
    this.drawNebulae(engine.nebulae, animTick);
    if (!critical) {
      this.drawGalacticMedium(engine.currentGalaxies, engine.stars, engine.currentPlayerStarId, animTick, camera);
    } else {
      this.dustLayer.clear();
    }
    this.drawTradeRoutes(engine.stars, camera);
    this.drawStars(engine.stars, engine.currentPlayerStarId, animTick, camera, tight);
    this.drawReligions(engine.stars, engine.currentRevelationFlashes, animTick, camera);
    this.drawAsteroids(engine.asteroids);
    this.drawSystemDebris(engine.stars, engine.currentPlayerStarId, animTick, camera);
    this.drawFleets(engine.fleets, starMap, camera);
    this.drawOrbitalFleets(engine.orbitalFleets, starMap, animTick, camera);
    this.drawWars(engine.activeWars, starMap, animTick, camera);
    this.drawPlanets(engine.stars, engine.currentPlayerStarId, animTick, camera);
    this.drawCosmicEffects(engine.currentSupernovaFlashes, animTick, camera, W, H);
    // Haze last among world visuals so color sits over the solar system.
    if (!tight) {
      this.drawSystemHazeOverlay(W, H, engine, camera, animTick);
    } else {
      this.hazeOverlay.visible = false;
    }

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
    if (sc < 0.18 || sc > 3.5) return;

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

      if (!star.asteroidBelt || camera.scale < 1.05) continue;
      const dens = Math.max(0.15, star.asteroidBeltDensity ?? 0.5);
      const beltR = Math.max(outer * 0.55, star.radius * 5);
      const beltW = Math.max(0.8, outer * (0.04 + dens * 0.1));
      const rocks = Math.max(4, Math.floor((star.isPlayerStar ? 16 : 10) * dens));
      const beltSpin = animTick * 0.0024;
      for (let i = 0; i < rocks; i++) {
        const a = (i / rocks) * Math.PI * 2 + beltSpin + star.id * 0.31;
        const rr = beltR + Math.sin(i * 2.7 + star.id) * beltW;
        const x = star.x + Math.cos(a) * rr;
        const y = star.y + Math.sin(a) * rr;
        const sz = Math.max(0.35 / camera.scale, 0.4 + (i % 4) * 0.16 * dens);
        this.asteroidLayer.rect(x - sz * 0.5, y - sz * 0.5, sz, sz)
          .fill({ color: i % 3 === 0 ? 0xa89878 : 0x887868, alpha: 0.55 + dens * 0.3 });
      }

      if (camera.scale >= 1.4) {
        this.asteroidLayer.circle(star.x, star.y, beltR).stroke({
          color: 0xc4b090,
          width: Math.max(0.4 / camera.scale, beltW * 0.35),
          alpha: 0.06 + dens * 0.1,
        });
      }
    }
  }

  // ─── Trade routes ─────────────────────────────────────────────────────────

  private drawTradeRoutes(stars: StarBody[], camera: Camera): void {
    this.tradeLayer.clear();
    if (camera.scale < 0.3) return;
    const tradeCivs = stars.filter(s => s.civLevel >= 5 && !s.isDead);
    for (let i = 0; i < tradeCivs.length; i++) {
      for (let j = i + 1; j < tradeCivs.length; j++) {
        const a = tradeCivs[i], b = tradeCivs[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        if (Math.sqrt(dx*dx + dy*dy) > 300) continue;
        dashedLine(
          this.tradeLayer, a.x, a.y, b.x, b.y,
          3 / camera.scale, 6 / camera.scale,
          0x44aaff, 0.6 / camera.scale, 0.12,
        );
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
      const size = Math.max(star.radius * 3.4, 2.2);
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
      // Animated pixel corona (rotates; length/speed by spectral class)
      if (wantCorona) {
        const coronaKey = `corona|${band}|${sunSeed}`;
        const coronaTex = this.nearestTex(
          this.starCoronaTextures, coronaKey, bakeStarCorona(band, 80, sunSeed),
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
      const texKey = `body|${band}|${frame}|${sunSeed}`;
      const tex = this.nearestTex(this.starTextures, texKey, bakeStarBody(band, 48, frame, sunSeed));
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

      if (star.isPlayerStar) {
        // Corner brackets outside the corona, not a box drawn across the sun.
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

      const size = 6;
      sprite.width = size * 1.5;
      sprite.height = size;
      sprite.x = star.x;
      sprite.y = star.y - star.radius * 5 - 4;
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

        if (camera.scale > 1.15 && (star.isPlayerStar || camera.scale > 2.2)) {
          pixelPlanetOrbit(
            this.planetLayer, star.x, star.y, planet,
            star.isDead ? 0x666660 : star.isPlayerStar ? 0xc8a96e : 0xffffff,
            star.isDead ? 0.15 : star.isPlayerStar ? 0.4 : 0.2,
            camera.scale,
          );
        }

        const kind = (planet.type as PlanetKind) || 'rocky';
        const withRings = kind === 'gas' && !planet.isDead;
        const seed = (star.id * 17 + i * 31) | 0;
        const homeIdx = star.isPlayerStar ? (star.bestPlanetIndex ?? 0) : -1;
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
          const texKey = `globe|${star.id}|${i}|${kind}|${lifeKey}|${dnaKey}|${bioPhase ?? ''}|${withRings ? 1 : 0}`;
          let cached = this.planetTextures.get(texKey);
          if (!cached) {
            const equirect = bakePlanetTexture(
              star.id, i, planet.type, dna, 96, bioPhase, grid,
            );
            const ringTint = parseHexColor(planet.color, [200, 190, 160]);
            const globe = wrapEquirectToGlobe(equirect, 48, {
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

        const body = Math.max(planet.radius * 3.2, 2.0 / camera.scale);
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

        if (planet.hasLife) {
          const bp = 0.45 + 0.35 * Math.sin(animTick * 0.05);
          pixelOrbit(this.planetLayer, px, py, body * 0.72, 0x44ff88, bp, camera.scale);
        }

        if (planet.moons.length > 0) {
          for (let m = 0; m < planet.moons.length; m++) {
            const moon = planet.moons[m];
            const large = moon.radius >= planet.radius * 0.4;
            if (!large && camera.scale < 0.85) continue;
            if (large && camera.scale < 0.55) continue;

            const ma = moon.orbitalAngle + animTick * moon.orbitalSpeed;
            const moonOrbit = Math.max(moon.orbitalRadius, body * (large ? 1.15 : 0.85));
            const mx = px + Math.cos(ma) * moonOrbit;
            const my = py + Math.sin(ma) * moonOrbit;

            const mk = (moon.kind as MoonKind) || 'rock';
            const mTexKey = `moon|${mk}`;
            const mTex = this.nearestTex(
              this.moonTextures, mTexKey, bakeMoonSprite(mk, 8),
            );
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

            const mSize = Math.max(
              moon.radius * (large ? 3.6 : 2.8),
              (large ? 1.6 : 0.9) / camera.scale,
            );
            mSprite.width = mSize;
            mSprite.height = mSize;
            mSprite.x = mx;
            mSprite.y = my;
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
