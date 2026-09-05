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
  Color, Sprite, Texture,
} from 'pixi.js';

import type {
  BigBangEngine, StarBody, Fleet, OrbitalFleet, War,
  AsteroidBody, NebulaCloud, SupernovaFlash, RevelationFlash,
  Camera,
} from '../simulation/BigBangEngine';

import { CIV_COLORS, gameState } from '../simulation/GameState';
import { drawFactionFlag, type FactionFlag } from '../simulation/FactionFlag';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tempToHex(t: number): number {
  if (t > 25000) return 0xaaccff;
  if (t > 10000) return 0xffffff;
  if (t > 7500)  return 0xfff8e0;
  if (t > 6000)  return 0xffeeaa;
  if (t > 5000)  return 0xffcc88;
  if (t > 4000)  return 0xff9944;
  return 0xff6622;
}

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

/** Approximate radial glow with concentric filled circles. */
function glowCircle(
  g: Graphics,
  x: number, y: number, r: number,
  color: number,
  layers = 3,
): void {
  for (let i = layers; i >= 1; i--) {
    const scale = 1 + (i - 1) * 0.7;
    const a = 0.06 * (1 / i);
    g.circle(x, y, r * scale).fill({ color, alpha: a });
  }
  g.circle(x, y, r).fill({ color, alpha: 1 });
}

// ─── Renderer ────────────────────────────────────────────────────────────────

export class PixiBigBangRenderer {
  private app!: Application;
  private worldContainer!: Container;

  // Layers — each cleared + redrawn every frame
  private bgLayer!: Graphics;
  private nebulaLayer!: Graphics;
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

  private labelContainer!: Container;

  private bgStarCache: Array<{ x: number; y: number; r: number }> = [];

  /** The Pixi canvas element — insert this into the DOM behind the engine canvas. */
  get canvas(): HTMLCanvasElement { return this.app.canvas as HTMLCanvasElement; }

  async init(width: number, height: number): Promise<void> {
    this.app = new Application();
    await this.app.init({
      width,
      height,
      background: '#000008',
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
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
    this.worldContainer.addChild(this.tradeLayer);
    this.worldContainer.addChild(this.starLayer);
    this.flagLayer = new Container();
    this.worldContainer.addChild(this.flagLayer);
    this.worldContainer.addChild(this.religionLayer);
    this.worldContainer.addChild(this.asteroidLayer);
    this.worldContainer.addChild(this.fleetLayer);
    this.worldContainer.addChild(this.warLayer);
    this.worldContainer.addChild(this.planetLayer);
    this.worldContainer.addChild(this.cosmicLayer);
    this.app.stage.addChild(this.labelContainer);   // screen-space labels
  }

  /** Resize the Pixi renderer to match window size. */
  resize(width: number, height: number): void {
    this.app.renderer.resize(width, height);
    this.bgStarCache = []; // force rebuild
  }

  // ─── Main frame render ────────────────────────────────────────────────────

  renderFrame(engine: BigBangEngine): void {
    const camera   = engine.currentCamera;
    const animTick = engine.currentAnimTick;
    const { width: W, height: H } = this.app.renderer;

    // Apply camera transform to world container
    this.worldContainer.x = W / 2 - camera.x * camera.scale;
    this.worldContainer.y = H / 2 - camera.y * camera.scale;
    this.worldContainer.scale.set(camera.scale);

    // Build star lookup map once per frame — avoids O(n) find() inside every draw loop
    const starMap = new Map<number, StarBody>();
    for (const s of engine.stars) starMap.set(s.id, s);

    // Draw each layer
    this.drawBgStars(W, H);
    this.drawNebulae(engine.nebulae, animTick);
    this.drawTradeRoutes(engine.stars, camera);
    this.drawStars(engine.stars, engine.currentPlayerStarId, animTick, camera);
    this.drawReligions(engine.stars, engine.currentRevelationFlashes, animTick, camera);
    this.drawAsteroids(engine.asteroids);
    this.drawFleets(engine.fleets, starMap, camera);
    this.drawOrbitalFleets(engine.orbitalFleets, starMap, animTick, camera);
    this.drawWars(engine.activeWars, starMap, animTick, camera);
    this.drawPlanets(engine.stars, engine.currentPlayerStarId, animTick, camera);
    this.drawCosmicEffects(engine.currentSupernovaFlashes, animTick, camera, W, H);

    // Render Pixi stage
    this.app.renderer.render(this.app.stage);
  }

  // ─── Background stars (screen-space, static cache) ───────────────────────

  private drawBgStars(W: number, H: number): void {
    this.bgLayer.clear();

    if (this.bgStarCache.length === 0) {
      // Rebuild with deterministic-ish positions (same algo as Canvas version)
      let s = 0xdeadbeef;
      const rand = () => { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff; };
      this.bgStarCache = [];
      for (let i = 0; i < 200; i++) {
        this.bgStarCache.push({ x: rand() * W, y: rand() * H, r: rand() * 0.8 + 0.2 });
      }
    }

    for (const s of this.bgStarCache) {
      this.bgLayer.circle(s.x, s.y, s.r).fill({ color: 0xffffff, alpha: 0.5 + s.r * 0.3 });
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

  private drawStars(
    stars: StarBody[], playerStarId: number,
    animTick: number, camera: Camera,
  ): void {
    this.starLayer.clear();

    for (const star of stars) {
      if (star.isDead) continue;

      const color = tempToHex(star.temperature);
      const r = star.radius;

      // Outer glow (3 layers)
      glowCircle(this.starLayer, star.x, star.y, r, color, 3);

      // Player star: golden animated halo
      if (star.isPlayerStar) {
        const alpha = 0.5 + 0.3 * Math.sin(animTick * 0.05);
        this.starLayer.circle(star.x, star.y, r * 2.5).stroke({ color: 0xffcc44, width: 1.2 / camera.scale, alpha });
      }

      // Civ indicator ring
      if (star.civLevel > 0) {
        const civColor = cssToHex(CIV_COLORS[Math.min(star.civLevel, CIV_COLORS.length - 1)]);
        this.starLayer.circle(star.x, star.y, r * 1.8).stroke({ color: civColor, width: 0.8 / camera.scale, alpha: 0.6 });
      }

      // War pulsing red ring (diplomatic indicator — handled separately in drawWars,
      // but small "at war" dot shown here for far-zoom legibility)
      const atWar = star.civLevel > 0; // wars handled in drawWars layer
      void atWar; // suppress unused warning; detailed war rings are in drawWars

    }

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
      this.asteroidLayer.circle(a.x, a.y, a.radius).fill({ color: 0x888888, alpha: 0.6 });
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

    if (camera.scale < 0.5) return;

    const PLANET_COLORS: Record<string, number> = {
      rocky: 0x997755, ocean: 0x336699, gas: 0xcc8833,
      ice:   0xaaddff, lava:  0xff4422,
    };

    for (const star of stars) {
      if (star.isDead) continue;
      if (!star.isPlayerStar && camera.scale < 1.2) continue;

      for (const planet of star.planets) {
        const angle = planet.orbitalAngle + animTick * planet.orbitalSpeed;
        const px = star.x + Math.cos(angle) * planet.orbitalRadius;
        const py = star.y + Math.sin(angle) * planet.orbitalRadius;

        const screenR = planet.radius * camera.scale;

        // Orbit ring (circle)
        if (camera.scale > 0.6) {
          this.planetLayer
            .circle(star.x, star.y, planet.orbitalRadius)
            .stroke({ color: 0xffffff, width: 0.4 / camera.scale, alpha: 0.18 });
        }

        // Atmosphere glow
        if (screenR >= 4) {
          const col = planet.hasLife ? 0x44ff88 : (PLANET_COLORS[planet.type] ?? 0x888888);
          this.planetLayer.circle(px, py, planet.radius * 2.5).fill({ color: col, alpha: 0.07 });
          this.planetLayer.circle(px, py, planet.radius * 1.5).fill({ color: col, alpha: 0.12 });
        }

        // Planet body
        const col = planet.hasLife ? 0x2a9e5f : (PLANET_COLORS[planet.type] ?? 0x888888);
        this.planetLayer.circle(px, py, planet.radius).fill({ color: col });

        // Hemisphere shading (dark crescent on right)
        this.planetLayer.circle(px + planet.radius * 0.2, py - planet.radius * 0.2, planet.radius * 0.85)
          .fill({ color: 0x000000, alpha: 0.35 });

        // Biosphere pulse
        if (planet.hasLife) {
          const bp = 0.5 + 0.4 * Math.sin(animTick * 0.05);
          this.planetLayer.circle(px, py, planet.radius * 1.7)
            .stroke({ color: 0x44ff88, width: 0.8 / camera.scale, alpha: bp * 0.6 });
        }

        // HOME label
        if (star.id === playerStarId && camera.scale > 2) {
          // Labels handled separately via HTML overlay; skip here
        }
      }
    }
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
