import { SeedRNG } from '../utils/SeedRNG';
import { StarBody, PlanetFormationStage } from './BigBangEngine';
import { TECH_LEVELS, gameState, runtimeState, DEFAULT_PLANET_DNA, PlanetDNA } from './GameState';
import { drawBiosphereTerrainLayer, drawBiosphereHUDLayer } from './BiosphereRenderer';
import type { SpeciesGenome, PlanetBiosphere } from './SpeciesGenome';
import { type PlanetGrid, BIOME_COLORS, sampleGrid, classifyBiome } from './PlanetGrid';

interface Cloud {
  x: number; y: number;
  w: number; h: number;
  speed: number;
  alpha: number;
}

interface City {
  x: number; y: number;
  size: number;
  name: string;
}

/**
 * 2D animated planet surface renderer.
 * Draws a scrollable planet map with procedural terrain, clouds, cities, and events.
 */
export class PlanetRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private terrainCanvas: HTMLCanvasElement;
  private terrainCtx: CanvasRenderingContext2D;

  private rng!: SeedRNG;
  private clouds: Cloud[] = [];
  private cities: City[] = [];
  private star!: StarBody;
  private tick = 0;
  private running = false;
  private animHandle = 0;

  // Camera
  private camX = 0;
  private camY = 0;
  private camScale = 1;
  private isDragging = false;
  private dragStart = { x: 0, y: 0 };
  private dragCamStart = { x: 0, y: 0 };

  private readonly MAP_W = 1200;
  private readonly MAP_H = 600;

  // War occupation state — set externally by main.ts
  warState: {
    warId: number;
    attackerName: string;
    attackerColor: string;
    phase: string;
    progress: number;       // 0–1 through war duration
    attackerStrength: number; // 0–1
    defenderStrength: number; // 0–1
  } | null = null;

  // M17: Biosphere overlay
  bioOverlayVisible = false;
  bioData: { species: SpeciesGenome[]; biosphere: PlanetBiosphere } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.terrainCanvas = document.createElement('canvas');
    this.terrainCanvas.width = this.MAP_W;
    this.terrainCanvas.height = this.MAP_H;
    this.terrainCtx = this.terrainCanvas.getContext('2d')!;
    this.setupInput();
  }

  private planetIndex = 0;

  init(star: StarBody, planetIndex = 0): void {
    this.star = star;
    this.planetIndex = planetIndex;
    this.rng = new SeedRNG('planet_' + star.id + '_' + planetIndex);
    this.tick = 0;
    this.camX = this.MAP_W / 2;
    this.camY = this.MAP_H / 2;
    this.camScale = Math.min(this.canvas.width / this.MAP_W, this.canvas.height / this.MAP_H) * 0.95;

    this.generateTerrain();
    this.generateClouds();
    this.generateCities();
  }

  /**
   * Generate a small terrain texture canvas for this planet, for use as
   * a globe texture in the main universe view. Does NOT include clouds,
   * cities, or grid lines — raw terrain only.
   */
  generateTexture(size = 128): HTMLCanvasElement {
    const offscreen = document.createElement('canvas');
    offscreen.width = size;
    offscreen.height = size / 2; // terrain is 2:1 equirectangular map ratio
    const octx = offscreen.getContext('2d')!;
    const W = offscreen.width, H = offscreen.height;
    const imageData = octx.createImageData(W, H);
    const data = imageData.data;
    const seed = this.star.id * 7777;
    const planet = this.star.planets[this.planetIndex] ?? this.star.planets[0];
    const planetType = planet?.type ?? 'rocky';
    const dna: PlanetDNA = (this.star.isPlayerStar && this.planetIndex === 0)
      ? (gameState.playerPlanetDNA ?? DEFAULT_PLANET_DNA)
      : DEFAULT_PLANET_DNA;

    const grid = (this.star.isPlayerStar && this.planetIndex === 0)
      ? runtimeState.playerPlanetGrid : null;

    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        let r: number, g: number, b: number;

        if (grid) {
          const cell = sampleGrid(grid, px / W, py / H);
          [r, g, b] = BIOME_COLORS[cell.biome];
          if (cell.lifeDensity > 0) {
            const lt = cell.lifeDensity * 0.35;
            r = Math.round(r * (1 - lt) + 40  * lt);
            g = Math.round(g * (1 - lt) + 160 * lt);
            b = Math.round(b * (1 - lt) + 60  * lt);
          }
          if (this.star?.isPlayerStar && this.star.biologyPhase) {
            [r, g, b] = this.applyBioTint([r, g, b], cell.elevation, this.star.biologyPhase);
          }
        } else {
          const nx = px / W * 4;
          const ny = py / H * 2;
          const h = this.fbm(nx, ny, seed, 5);
          [r, g, b] = this.heightToColor(h, planetType, dna);
          if (this.star?.isPlayerStar && this.star.biologyPhase) {
            [r, g, b] = this.applyBioTint([r, g, b], h, this.star.biologyPhase);
          }
        }

        const idx = (py * W + px) * 4;
        data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
      }
    }
    octx.putImageData(imageData, 0, 0);
    return offscreen;
  }

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
    this.tick++;
    this.updateClouds();
    this.render();
    this.animHandle = requestAnimationFrame(this.loop.bind(this));
  }

  // ── Terrain generation ─────────────────────────────────────────────────────

  private generateTerrain(): void {
    const ctx = this.terrainCtx;
    const W = this.MAP_W, H = this.MAP_H;
    const imageData = ctx.createImageData(W, H);
    const data = imageData.data;
    const seed = this.star.id * 7777;

    const planet = this.star.planets[this.planetIndex] ?? this.star.planets[0];
    const planetType = planet?.type ?? 'rocky';
    // Apply PlanetDNA only to the player's home planet (index 0)
    const dna: PlanetDNA = (this.star.isPlayerStar && this.planetIndex === 0)
      ? (gameState.playerPlanetDNA ?? DEFAULT_PLANET_DNA)
      : DEFAULT_PLANET_DNA;

    const grid = (this.star.isPlayerStar && this.planetIndex === 0)
      ? runtimeState.playerPlanetGrid : null;

    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        let r: number, g: number, b: number;

        if (grid) {
          const cell = sampleGrid(grid, px / W, py / H);
          [r, g, b] = BIOME_COLORS[cell.biome];
          if (cell.lifeDensity > 0) {
            const lt = cell.lifeDensity * 0.35;
            r = Math.round(r * (1 - lt) + 40  * lt);
            g = Math.round(g * (1 - lt) + 160 * lt);
            b = Math.round(b * (1 - lt) + 60  * lt);
          }
          if (this.star.biologyPhase) {
            [r, g, b] = this.applyBioTint([r, g, b], cell.elevation, this.star.biologyPhase);
          }
        } else {
          const nx = px / W * 4;
          const ny = py / H * 2;
          const h = this.fbm(nx, ny, seed, 5);
          [r, g, b] = this.heightToColor(h, planetType, dna);
          if (this.star?.isPlayerStar && this.star.biologyPhase) {
            [r, g, b] = this.applyBioTint([r, g, b], h, this.star.biologyPhase);
          }
        }

        const idx = (py * W + px) * 4;
        data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
      }
    }
    ctx.putImageData(imageData, 0, 0);

    // Draw resource deposits
    this.drawResourceDeposits(ctx, W, H, seed);

    // Draw grid lines (very faint) for map feel
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 120) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += 100) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Terminator is handled by the animated drawDayNight — not baked in

    // Border glow (atmospheric limb)
    const limb = ctx.createLinearGradient(0, 0, 0, H);
    limb.addColorStop(0, 'rgba(100,140,255,0.25)');
    limb.addColorStop(0.5, 'rgba(100,140,255,0)');
    limb.addColorStop(1, 'rgba(100,140,255,0.18)');
    ctx.fillStyle = limb;
    ctx.fillRect(0, 0, W, H);
  }

  private drawResourceDeposits(ctx: CanvasRenderingContext2D, W: number, H: number, seed: number): void {
    const rng = new SeedRNG(seed + 99);
    const icons: Record<string, string> = {
      minerals: '◆', rare_metals: '⬟', exotic_matter: '✦',
      energy_crystals: '◎', biological: '❋', dark_energy: '◉',
    };
    const colors: Record<string, string> = {
      minerals: '#aaaaaa', rare_metals: '#ffdd55', exotic_matter: '#ff88ff',
      energy_crystals: '#44ffcc', biological: '#88ff44', dark_energy: '#8844ff',
    };

    const planet = this.star.planets[this.planetIndex] ?? this.star.planets[0];
    const resources = planet ? ['minerals', 'rare_metals'] : ['minerals'];
    // Add exotic resources based on planet type
    if (planet?.type === 'ice') resources.push('energy_crystals');
    if (planet?.type === 'ocean') resources.push('biological');
    if (planet?.type === 'rocky' && rng.chance(0.4)) resources.push('exotic_matter');

    ctx.font = '14px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const res of resources) {
      for (let i = 0; i < 3; i++) {
        const x = rng.nextFloat(30, W - 30);
        const y = rng.nextFloat(30, H - 30);
        ctx.fillStyle = colors[res] ?? '#ffffff';
        ctx.shadowColor = colors[res] ?? '#ffffff';
        ctx.shadowBlur = 6;
        ctx.fillText(icons[res] ?? '·', x, y);
        ctx.shadowBlur = 0;
      }
    }
  }

  private fbm(x: number, y: number, seed: number, octaves: number): number {
    let v = 0, amp = 0.5, freq = 1;
    for (let i = 0; i < octaves; i++) {
      v += this.valueNoise(x * freq, y * freq, seed + i * 997) * amp;
      amp *= 0.5; freq *= 2.1;
    }
    return Math.max(0, Math.min(1, v));
  }

  private valueNoise(x: number, y: number, seed: number): number {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = this.hash2(ix,     iy,     seed);
    const b = this.hash2(ix + 1, iy,     seed);
    const c = this.hash2(ix,     iy + 1, seed);
    const d = this.hash2(ix + 1, iy + 1, seed);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  }

  private hash2(x: number, y: number, seed: number): number {
    let h = seed + x * 374761393 + y * 668265263;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  private applyBioTint(
    color: [number, number, number],
    h: number,
    phase: string,
  ): [number, number, number] {
    // Only tint land areas; ocean stays natural
    if (h <= 0.45) return color;
    let [r, g, b] = color;
    switch (phase) {
      case 'microbial':
        r = Math.round(r * 0.97);
        g = Math.min(255, Math.round(g + 6));
        b = Math.min(255, Math.round(b + 10));
        break;
      case 'multicellular':
        r = Math.round(r * 0.95);
        g = Math.min(255, Math.round(g * 1.05 + 8));
        b = Math.round(b * 0.97);
        break;
      case 'complex':
        r = Math.round(r * 0.92);
        g = Math.min(255, Math.round(g * 1.08 + 12));
        b = Math.round(b * 0.95);
        break;
      case 'primitive':
        r = Math.min(255, Math.round(r * 1.03 + 5));
        g = Math.min(255, Math.round(g * 1.01 + 3));
        b = Math.round(b * 0.94);
        break;
      default:
        break;
    }
    return [
      Math.max(0, Math.min(255, r)),
      Math.max(0, Math.min(255, g)),
      Math.max(0, Math.min(255, b)),
    ];
  }

  private heightToColor(h: number, type: string, dna: PlanetDNA = DEFAULT_PLANET_DNA): [number, number, number] {
    if (type === 'lava') {
      if (h < 0.3) return [20, 10, 10];      // dark rock
      if (h < 0.5) return [100, 20, 10];     // hot rock
      if (h < 0.65) return [200, 60, 10];    // lava flow
      if (h < 0.8) return [255, 140, 20];    // bright lava
      return [255, 220, 100];                  // magma pools
    }
    if (type === 'ice') {
      if (h < 0.3) return [100, 160, 200];   // deep ice water
      if (h < 0.45) return [160, 210, 240];  // ice shelf
      if (h < 0.7) return [220, 240, 255];   // snow plain
      return [255, 255, 255];                  // peak ice
    }
    if (type === 'ocean') {
      if (h < 0.6) return [10, 60, 140];     // deep ocean
      if (h < 0.72) return [20, 100, 180];   // shallow
      if (h < 0.76) return [180, 160, 100];  // tiny beach
      return [40, 100, 50];                    // tiny island
    }
    if (type === 'gas') {
      const bands = [
        [200, 160, 80], [180, 130, 60], [220, 180, 100],
        [160, 120, 60], [240, 200, 120],
      ] as [number, number, number][];
      const band = bands[Math.floor(h * bands.length) % bands.length];
      return band;
    }
    // Default habitable/rocky — modified by PlanetDNA
    // Ocean thresholds: barren=0.05, mixed=0.45, ocean_world=0.78
    const oceanLevel = dna.oceans === 'barren' ? 0.05 : dna.oceans === 'ocean_world' ? 0.78 : 0.42;

    if (dna.climate === 'frozen') {
      // Ice world — blues and whites, minimal green
      if (h < oceanLevel * 0.7) return [10, 30, 90];         // frozen ocean
      if (h < oceanLevel)        return [60, 100, 160];       // ice shelf
      if (h < 0.55)              return [160, 200, 230];      // tundra
      if (h < 0.72)              return [210, 230, 245];      // snow plain
      if (h < 0.88)              return [230, 240, 255];      // ice cliff
      return [255, 255, 255];                                  // peak glacier
    }
    if (dna.climate === 'desert') {
      // Arid world — orange/red tones, minimal water
      if (h < oceanLevel)       return [40, 55, 110];         // brine lake
      if (h < oceanLevel + 0.05) return [160, 130, 80];       // salt flat
      if (h < 0.55)             return [180, 120, 60];        // sand dune
      if (h < 0.68)             return [160, 100, 50];        // red rock
      if (h < 0.82)             return [130, 80, 40];         // canyon wall
      if (h < 0.92)             return [110, 70, 40];         // mesa
      return [200, 180, 160];                                  // pale peak
    }
    // Temperate (default)
    if (h < oceanLevel * 0.75) return [10, 40, 120];          // deep ocean
    if (h < oceanLevel)        return [20, 80, 170];           // ocean
    if (h < oceanLevel + 0.05) return [190, 175, 120];         // beach
    if (h < 0.6)               return [60, 130, 55];           // plains
    if (h < 0.72)              return [35, 100, 35];           // forest
    if (h < 0.85)              return [100, 85, 75];           // mountain
    if (h < 0.93)              return [140, 120, 110];         // high mountain
    return [240, 240, 255];                                    // snow
  }

  // ── Clouds ────────────────────────────────────────────────────────────────

  private generateClouds(): void {
    this.clouds = [];
    const dna: PlanetDNA = (this.star.isPlayerStar && this.planetIndex === 0)
      ? (gameState.playerPlanetDNA ?? DEFAULT_PLANET_DNA)
      : DEFAULT_PLANET_DNA;
    const count = dna.chaos === 'storm' ? 32 : dna.chaos === 'serene' ? 8 : 18;
    const maxAlpha = dna.chaos === 'storm' ? 0.75 : dna.chaos === 'serene' ? 0.3 : 0.55;
    const speed = dna.chaos === 'storm' ? [0.15, 0.45] : dna.chaos === 'serene' ? [0.02, 0.08] : [0.05, 0.2];
    for (let i = 0; i < count; i++) {
      this.clouds.push({
        x: this.rng.nextFloat(0, this.MAP_W),
        y: this.rng.nextFloat(20, this.MAP_H - 20),
        w: this.rng.nextFloat(80, 220),
        h: this.rng.nextFloat(20, 55),
        speed: this.rng.nextFloat(speed[0], speed[1]),
        alpha: this.rng.nextFloat(0.2, maxAlpha),
      });
    }
  }

  private updateClouds(): void {
    for (const cloud of this.clouds) {
      cloud.x += cloud.speed;
      if (cloud.x > this.MAP_W + 250) cloud.x = -250;
    }
  }

  // ── Cities ────────────────────────────────────────────────────────────────

  private generateCities(): void {
    this.cities = [];
    const civLevel = this.star.civLevel;
    if (civLevel < 1) return;

    const cityNames = ['Aethon', 'Voran', 'Keth', 'Solara', 'Nyx', 'Belos', 'Coryn', 'Draxi', 'Ithel', 'Ferox'];
    const count = Math.min(civLevel + 1, 8);

    for (let i = 0; i < count; i++) {
      // Avoid deep ocean (x > MAP_W * 0.47 is roughly land in default palette)
      let cx: number, cy: number;
      let attempts = 0;
      do {
        cx = this.rng.nextFloat(50, this.MAP_W - 50);
        cy = this.rng.nextFloat(50, this.MAP_H - 50);
        attempts++;
      } while (attempts < 20 && this.terrainAlphaAt(cx, cy) < 0.4);

      this.cities.push({
        x: cx, y: cy,
        size: 2 + civLevel * 0.8,
        name: this.rng.pick(cityNames) + (i === 0 ? ' Prime' : `-${i + 1}`),
      });
    }
  }

  private terrainAlphaAt(_x: number, _y: number): number {
    // Simplified check — just use noise
    return this.fbm(_x / this.MAP_W * 4, _y / this.MAP_H * 2, this.star.id * 7777, 1);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  render(): void {
    const { width: W, height: H } = this.canvas;
    const ctx = this.ctx;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(W / 2 - this.camX * this.camScale, H / 2 - this.camY * this.camScale);
    ctx.scale(this.camScale, this.camScale);

    // Terrain
    ctx.drawImage(this.terrainCanvas, 0, 0);

    // Biology phase overlays (pre-intelligent life)
    if (!this.star.formationStage && this.star.biologyPhase !== 'intelligent') {
      this.drawBiologyPhaseOverlay(ctx);
    }

    // Clouds
    this.drawClouds(ctx);

    // Cities (only shown at intelligent/civ phase)
    this.drawCities(ctx);

    // Enemy occupation overlay (active wars)
    if (this.warState && !this.star.formationStage) {
      this.drawWarOccupation(ctx);
    }

    // Slowly drifting day/night terminator (animated)
    this.drawDayNight(ctx);

    // M17: O2 atmosphere haze
    if (this.bioData && this.bioData.biosphere.oxygenLevel > 0.05) {
      this.drawOxygenAtmosphere(ctx, this.bioData.biosphere.oxygenLevel);
    }

    // M17: Biosphere terrain overlay
    if (this.bioOverlayVisible && this.bioData && this.star.isPlayerStar) {
      drawBiosphereTerrainLayer(
        ctx, this.MAP_W, this.MAP_H, this.tick,
        this.bioData.species, this.bioData.biosphere, this.star.id,
      );
    }

    // Planet formation overlay (covers terrain during birth cycle)
    if (this.star.formationStage) {
      this.drawFormationStage(ctx, this.star.formationStage);
    }

    ctx.restore();

    // UI overlay (screen-space)
    this.drawPlanetUI(ctx, W, H);
  }

  private drawClouds(ctx: CanvasRenderingContext2D): void {
    for (const cloud of this.clouds) {
      const grad = ctx.createRadialGradient(
        cloud.x + cloud.w / 2, cloud.y + cloud.h / 2, 0,
        cloud.x + cloud.w / 2, cloud.y + cloud.h / 2, cloud.w / 2
      );
      grad.addColorStop(0, `rgba(255,255,255,${cloud.alpha})`);
      grad.addColorStop(0.5, `rgba(240,240,255,${cloud.alpha * 0.5})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.save();
      ctx.translate(cloud.x + cloud.w / 2, cloud.y + cloud.h / 2);
      ctx.scale(1, cloud.h / cloud.w);
      ctx.beginPath();
      ctx.arc(0, 0, cloud.w / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawCities(ctx: CanvasRenderingContext2D): void {
    for (const city of this.cities) {
      const pulseR = city.size + Math.sin(this.tick * 0.04 + city.x) * 1.5;

      // Glow ring
      ctx.beginPath();
      ctx.arc(city.x, city.y, pulseR * 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(200, 169, 110, 0.15)';
      ctx.fill();

      // City dot
      ctx.beginPath();
      ctx.arc(city.x, city.y, city.size, 0, Math.PI * 2);
      ctx.fillStyle = '#c8a96e';
      ctx.shadowColor = '#ffdd88';
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;

      // City roads (lines to adjacent cities)
      for (const other of this.cities) {
        if (other === city) continue;
        const dx = other.x - city.x, dy = other.y - city.y;
        if (Math.sqrt(dx * dx + dy * dy) < 200) {
          ctx.beginPath();
          ctx.moveTo(city.x, city.y);
          ctx.lineTo(other.x, other.y);
          ctx.strokeStyle = 'rgba(200, 169, 110, 0.12)';
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }

      // City label
      if (this.camScale > 0.6) {
        ctx.fillStyle = 'rgba(200,169,110,0.8)';
        ctx.font = `${9 / this.camScale}px Cinzel, serif`;
        ctx.textAlign = 'center';
        ctx.fillText(city.name, city.x, city.y - city.size - 4);
      }
    }
  }

  private drawBiologyPhaseOverlay(ctx: CanvasRenderingContext2D): void {
    const W = this.MAP_W, H = this.MAP_H;
    const t = this.tick;
    const phase = this.star.biologyPhase;

    if (phase === 'microbial') {
      // Bioluminescent dots in the shallow water zones
      const count = 40;
      ctx.save();
      for (let i = 0; i < count; i++) {
        const x = ((i * 137 + 200) % W);
        const y = H * 0.35 + ((i * 97 + 60) % (H * 0.45));
        const pulse = 0.4 + 0.6 * Math.sin(t * 0.05 + i * 1.3);
        const r = 1 + pulse * 2;
        ctx.globalAlpha = pulse * 0.55;
        ctx.fillStyle = '#00ffcc';
        ctx.shadowColor = '#00ffcc';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      ctx.restore();

    } else if (phase === 'multicellular') {
      // Algae patches — slow-drifting green blobs near water
      const count = 18;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      for (let i = 0; i < count; i++) {
        const bx = (i * 173 + t * 0.04 + i * 8) % W;
        const by = H * 0.38 + (i * 89) % (H * 0.28);
        const rw = 18 + (i % 5) * 8;
        const rh = 8 + (i % 3) * 4;
        const pulse = 0.5 + 0.5 * Math.sin(t * 0.03 + i * 0.7);
        ctx.globalAlpha = 0.18 + pulse * 0.15;
        ctx.fillStyle = `rgb(${20 + i % 40}, ${110 + i % 60}, ${30 + i % 40})`;
        ctx.save();
        ctx.translate(bx + rw / 2, by + rh / 2);
        ctx.scale(1, rh / rw);
        ctx.beginPath();
        ctx.arc(0, 0, rw / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      // Bioluminescence fading from previous phase
      for (let i = 0; i < 15; i++) {
        const x = ((i * 211 + 100) % W);
        const y = H * 0.4 + ((i * 113) % (H * 0.3));
        const pulse = 0.2 + 0.3 * Math.sin(t * 0.04 + i * 1.7);
        ctx.globalAlpha = pulse * 0.25;
        ctx.fillStyle = '#00eebb';
        ctx.shadowColor = '#00eebb';
        ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      ctx.restore();

    } else if (phase === 'complex') {
      // Creature trails near water edges + larger algae mats on land margins
      ctx.save();
      // Algae mats on land
      for (let i = 0; i < 12; i++) {
        const bx = (i * 201 + 80) % W;
        const by = H * 0.52 + (i * 67) % (H * 0.2);
        const rw = 25 + (i % 4) * 12;
        const pulse = 0.5 + 0.5 * Math.sin(t * 0.025 + i * 0.9);
        ctx.globalAlpha = 0.25 + pulse * 0.15;
        ctx.fillStyle = `rgb(${30 + i % 20}, ${80 + i % 50}, ${20 + i % 30})`;
        ctx.save();
        ctx.translate(bx + rw / 2, by + 6);
        ctx.scale(1, 0.4);
        ctx.beginPath();
        ctx.arc(0, 0, rw / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      // Creature movement trails (wiggly dots moving across shallow water)
      for (let i = 0; i < 8; i++) {
        const progress = ((t * (0.2 + i * 0.03) + i * 150) % W);
        const y = H * 0.45 + (i * 37) % (H * 0.2);
        const wave = Math.sin(t * 0.08 + i) * 6;
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = '#88ddaa';
        ctx.beginPath();
        ctx.arc(progress, y + wave, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.restore();

    } else if (phase === 'primitive') {
      // Nomadic camps — scattered firelight dots, no city infrastructure
      const campRng = new (this.rng.constructor as typeof SeedRNG)(this.star.id * 1337 + 42);
      ctx.save();
      const campCount = 6 + Math.floor(this.star.bioPhaseProgress / 200);
      for (let i = 0; i < Math.min(campCount, 12); i++) {
        const cx = campRng.nextFloat(60, W - 60);
        const cy = campRng.nextFloat(H * 0.38, H * 0.82);
        const fireFlicker = 0.6 + 0.4 * Math.sin(t * 0.15 + i * 2.1);
        // Fire glow
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 8 + fireFlicker * 4);
        grad.addColorStop(0, `rgba(255, 160, 40, ${0.7 * fireFlicker})`);
        grad.addColorStop(0.5, `rgba(255, 90, 10, ${0.3 * fireFlicker})`);
        grad.addColorStop(1, 'rgba(255, 60, 0, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, 12 + fireFlicker * 4, 0, Math.PI * 2);
        ctx.fill();
        // Camp dot
        ctx.fillStyle = `rgba(255, 200, 80, ${fireFlicker * 0.9})`;
        ctx.beginPath();
        ctx.arc(cx, cy, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  private drawWarOccupation(ctx: CanvasRenderingContext2D): void {
    const ws = this.warState!;
    const W = this.MAP_W, H = this.MAP_H;
    const t = this.tick;
    const { attackerName: _name, attackerColor, phase, progress, attackerStrength, defenderStrength: _def } = ws;

    // Parse hex color once
    const cr = parseInt(attackerColor.slice(1, 3), 16);
    const cg = parseInt(attackerColor.slice(3, 5), 16);
    const cb = parseInt(attackerColor.slice(5, 7), 16);

    // ── Red danger vignette (all phases) ──────────────────────────────────────
    const vigAlpha = phase === 'siege' ? 0.32 : phase === 'campaign' ? 0.18 : 0.10;
    const vigPulse = vigAlpha + Math.sin(t * 0.04) * 0.03;
    const vig = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.85);
    vig.addColorStop(0, 'rgba(180,0,0,0)');
    vig.addColorStop(1, `rgba(180,0,0,${vigPulse})`);
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, W, H);

    // ── Territory occupation blobs (campaign + siege) ─────────────────────────
    if (phase === 'campaign' || phase === 'siege') {
      const blobCount = phase === 'siege' ? 6 : 3;
      const rng = new SeedRNG(ws.warId * 7331 + 1);
      for (let i = 0; i < blobCount; i++) {
        const bx = rng.nextFloat(W * 0.08, W * 0.92);
        const by = rng.nextFloat(H * 0.18, H * 0.82);
        const baseR = rng.nextFloat(45, 85);
        const growthFactor = Math.min(1, progress * 1.8) * attackerStrength;
        const br = baseR * growthFactor;
        if (br < 5) continue;
        const pulse = 0.5 + 0.5 * Math.sin(t * 0.035 + i * 1.4);
        const alpha = 0.18 + pulse * 0.08;

        // Occupation blob
        const grad = ctx.createRadialGradient(bx, by, 0, bx, by, br);
        grad.addColorStop(0,   `rgba(${cr},${cg},${cb},${alpha * 1.6})`);
        grad.addColorStop(0.5, `rgba(${cr},${cg},${cb},${alpha})`);
        grad.addColorStop(1,   `rgba(${cr},${cg},${cb},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fill();

        // Enemy faction label + flag (campaign: name only; siege: flag + OCCUPIED)
        if (br > 20) {
          ctx.save();
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          if (phase === 'siege') {
            // Flag symbol
            ctx.globalAlpha = 0.55 + pulse * 0.35;
            ctx.fillStyle = attackerColor;
            ctx.font = `${13 / this.camScale}px serif`;
            ctx.fillText('⚑', bx, by - 12 / this.camScale);
            // OCCUPIED pulse text
            const occAlpha = 0.4 + 0.5 * Math.sin(t * 0.06);
            ctx.globalAlpha = occAlpha;
            ctx.fillStyle = '#ff9999';
            ctx.font = `bold ${9 / this.camScale}px Cinzel, serif`;
            ctx.fillText('OCCUPIED', bx, by + 4 / this.camScale);
          }
          // Faction name label (both campaign and siege)
          ctx.globalAlpha = 0.35 + pulse * 0.25;
          ctx.fillStyle = attackerColor;
          ctx.font = `${8 / this.camScale}px Cinzel, serif`;
          ctx.fillText(ws.attackerName.toUpperCase(), bx, by + (phase === 'siege' ? 16 : 4) / this.camScale);
          ctx.globalAlpha = 1;
          ctx.restore();
        }
      }
    }

    // ── Enemy patrol / siege ships orbiting the planet ────────────────────────
    const shipCount = phase === 'siege' ? 5 : phase === 'campaign' ? 3 : 2;
    const orbitRX = W * 0.47;
    const orbitRY = H * 0.42;
    for (let i = 0; i < shipCount; i++) {
      const angle = (t * 0.007 + i * (Math.PI * 2 / shipCount));
      const sx = W / 2 + Math.cos(angle) * orbitRX;
      const sy = H / 2 + Math.sin(angle) * orbitRY;
      const shipPulse = 0.65 + 0.35 * Math.sin(t * 0.05 + i * 1.3);

      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(angle + Math.PI / 2);
      ctx.globalAlpha = shipPulse;
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      ctx.shadowColor = attackerColor;
      ctx.shadowBlur = 10;
      // Ship triangle
      const sz = phase === 'siege' ? 7 : 5;
      ctx.beginPath();
      ctx.moveTo(0, -sz);
      ctx.lineTo(-sz * 0.6, sz * 0.8);
      ctx.lineTo(sz * 0.6, sz * 0.8);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  private drawFormationStage(ctx: CanvasRenderingContext2D, stage: PlanetFormationStage): void {
    const W = this.MAP_W, H = this.MAP_H;
    const t = this.tick;

    const configs: Record<PlanetFormationStage, { base: string; pulse?: string; label: string }> = {
      magma:      { base: 'rgba(160,25,5,0.88)',   pulse: 'rgba(255,120,0,0.18)',  label: 'MOLTEN SURFACE' },
      cooling:    { base: 'rgba(30,15,10,0.82)',   pulse: 'rgba(200,60,10,0.12)',  label: 'COOLING CRUST' },
      volcanic:   { base: 'rgba(45,38,32,0.78)',   pulse: 'rgba(180,90,20,0.14)',  label: 'VOLCANIC ERA' },
      atmosphere: { base: 'rgba(200,215,255,0.72)',                                label: 'ATMOSPHERE FORMING' },
      ice_age:    { base: 'rgba(160,200,255,0.75)',                                label: 'ICE AGE' },
      primordial: { base: 'rgba(15,65,120,0.68)',                                  label: 'PRIMORDIAL OCEAN' },
    };

    const cfg = configs[stage];

    // Base colour fill
    ctx.fillStyle = cfg.base;
    ctx.fillRect(0, 0, W, H);

    // Animated glow blobs for hot stages
    if (cfg.pulse) {
      ctx.fillStyle = cfg.pulse;
      for (let i = 0; i < 12; i++) {
        const bx = ((i * 137 + 50) % W);
        const by = ((i * 97 + 30) % H);
        const r = 30 + Math.sin(t * 0.04 + i) * 15;
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Lava crack lines for magma/cooling
    if (stage === 'magma' || stage === 'cooling') {
      ctx.strokeStyle = stage === 'magma' ? `rgba(255,180,0,${0.5 + Math.sin(t * 0.06) * 0.2})`
                                          : `rgba(200,80,10,${0.2 + Math.sin(t * 0.04) * 0.1})`;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 8; i++) {
        ctx.beginPath();
        ctx.moveTo((i * 180 + 40) % W, 0);
        ctx.lineTo(((i * 180 + 40) + Math.sin(t * 0.02 + i) * 30) % W, H);
        ctx.stroke();
      }
    }

    // Ash particles falling for volcanic
    if (stage === 'volcanic') {
      ctx.fillStyle = 'rgba(80,70,60,0.6)';
      for (let i = 0; i < 30; i++) {
        const ax = (i * 53 + t * 0.8 + i * 7) % W;
        const ay = (i * 37 + t * (0.4 + (i % 3) * 0.3)) % H;
        ctx.fillRect(ax, ay, 2, 2);
      }
    }

    // Stage label (centered, bold)
    ctx.fillStyle = stage === 'atmosphere' || stage === 'ice_age' ? 'rgba(20,10,40,0.8)' : 'rgba(255,220,150,0.9)';
    ctx.font = 'bold 18px Cinzel, serif';
    ctx.textAlign = 'center';
    ctx.fillText(cfg.label, W / 2, H / 2 - 10);
    ctx.font = '11px Cinzel, serif';
    ctx.fillStyle = stage === 'atmosphere' || stage === 'ice_age' ? 'rgba(20,10,40,0.6)' : 'rgba(255,200,100,0.6)';
    ctx.fillText('PLANET FORMATION IN PROGRESS', W / 2, H / 2 + 14);
  }

  private drawDayNight(ctx: CanvasRenderingContext2D): void {
    // Terminator drifts slowly across the map then wraps
    const offset = (this.tick * 0.12) % this.MAP_W;
    const termX = (this.MAP_W * 0.2 + offset) % this.MAP_W;

    const bandW = 180;
    const nightAlpha = 0.42;

    // Soft transition band
    const grad = ctx.createLinearGradient(termX, 0, termX + bandW, 0);
    grad.addColorStop(0, 'rgba(0,0,10,0)');
    grad.addColorStop(1, `rgba(0,0,10,${nightAlpha})`);
    ctx.fillStyle = grad;
    ctx.fillRect(termX, 0, bandW, this.MAP_H);

    // Flat night fill beyond the transition band
    const nightStart = termX + bandW;
    if (nightStart < this.MAP_W) {
      ctx.fillStyle = `rgba(0,0,10,${nightAlpha})`;
      ctx.fillRect(nightStart, 0, this.MAP_W - nightStart, this.MAP_H);
    }
  }

  private drawOxygenAtmosphere(ctx: CanvasRenderingContext2D, o2: number): void {
    const W = this.MAP_W, H = this.MAP_H;
    const alpha = Math.min(0.28, o2 * 0.32);
    const grad  = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0,    `rgba(100,180,255,${alpha})`);
    grad.addColorStop(0.35, 'rgba(80,160,255,0)');
    grad.addColorStop(0.65, 'rgba(80,160,255,0)');
    grad.addColorStop(1,    `rgba(100,180,255,${alpha * 0.6})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  private drawPlanetUI(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const star = this.star;
    const planet = star.planets[0];
    const civLevel = star.civLevel;

    // Top info bar
    ctx.fillStyle = 'rgba(4, 2, 12, 0.82)';
    ctx.fillRect(0, 0, W, 48);
    ctx.strokeStyle = 'rgba(123,94,167,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, W, 48);

    ctx.fillStyle = '#c8a96e';
    ctx.font = '13px Cinzel Decorative, serif';
    ctx.textAlign = 'left';
    ctx.fillText(star.civName.toUpperCase() + ' SYSTEM  —  ' + (planet?.type.replace('_',' ').toUpperCase() ?? 'PLANET'), 20, 30);

    ctx.font = '11px Cinzel, serif';
    let techStr: string;
    if (star.formationStage) {
      const stageLabels: Record<string, string> = {
        magma: 'Molten Surface', cooling: 'Cooling Crust', volcanic: 'Volcanic Era',
        atmosphere: 'Atmosphere Forming', ice_age: 'Ice Age', primordial: 'Primordial Ocean',
      };
      techStr = `  ⟳ ${stageLabels[star.formationStage] ?? star.formationStage}`;
      ctx.fillStyle = '#cc6633';
    } else if (star.biologyPhase !== 'intelligent') {
      // Pre-intelligent: show biology phase with distinct color
      const bioLabels: Record<string, string> = {
        microbial:     '🦠 Microbial Life',
        multicellular: '🌿 Multicellular Life',
        complex:       '🐚 Complex Organisms',
        primitive:     '🔥 Primitive Species',
      };
      techStr = `  ${bioLabels[star.biologyPhase] ?? star.biologyPhase}`;
      ctx.fillStyle = '#44cc88';
    } else {
      techStr = star.hasLife ? `  ${TECH_LEVELS[civLevel]} (Level ${civLevel})` : '  No intelligent life detected';
      ctx.fillStyle = '#7b5ea7';
    }
    ctx.fillText(techStr, W / 2 - 100, 30);

    // Right side stats
    ctx.textAlign = 'right';
    ctx.fillStyle = '#d4c5e8';
    ctx.font = '10px Cinzel, serif';
    if (star.hasLife && !star.formationStage) {
      if (star.biologyPhase !== 'intelligent') {
        ctx.fillStyle = '#44cc88';
        ctx.fillText(`Biosphere: ${Math.round((planet?.biosphere ?? 0) * 100)}%`, W - 20, 20);
        const progressPct = Math.min(100, Math.round((star.bioPhaseProgress / 3000) * 100));
        ctx.fillStyle = '#888';
        ctx.fillText(`Evolution: ${progressPct}%`, W - 20, 34);
      } else {
        const pop = Math.floor(Math.pow(10, civLevel + 3)).toLocaleString();
        ctx.fillText(`Pop: ~${pop}`, W - 20, 20);
        ctx.fillText(`Biosphere: ${Math.round((planet?.biosphere ?? 0) * 100)}%`, W - 20, 34);
      }
    }

    // ── War status banner ───────────────────────────────────────────────────
    if (this.warState) {
      const ws = this.warState;
      const phaseLabel: Record<string, string> = {
        skirmish: '⚔ SKIRMISH', campaign: '⚔ CAMPAIGN',
        siege: '🔴 UNDER SIEGE', resolution: '⚔ RESOLVING',
      };
      const pLabel = phaseLabel[ws.phase] ?? ws.phase.toUpperCase();
      const bannerY = 48;
      const bannerH = 34;
      const cr = parseInt(ws.attackerColor.slice(1, 3), 16);
      const cg = parseInt(ws.attackerColor.slice(3, 5), 16);
      const cb = parseInt(ws.attackerColor.slice(5, 7), 16);

      ctx.fillStyle = `rgba(${cr},${cg},${cb},0.22)`;
      ctx.fillRect(0, bannerY, W, bannerH);
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.6)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, bannerY + bannerH);
      ctx.lineTo(W, bannerY + bannerH);
      ctx.stroke();

      ctx.fillStyle = `rgb(255,150,150)`;
      ctx.font = 'bold 11px Cinzel, serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${ws.attackerName.toUpperCase()} INVASION  —  ${pLabel}`, 16, bannerY + 21);

      // Strength bars
      const barW = 140, barH2 = 5, barX = W - barW - 16, barY2 = bannerY + 8;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(barX, barY2, barW, barH2);
      ctx.fillRect(barX, barY2 + barH2 + 3, barW, barH2);
      ctx.fillStyle = `rgba(${cr},${cg},${cb},0.85)`;
      ctx.fillRect(barX, barY2, barW * ws.attackerStrength, barH2);
      ctx.fillStyle = 'rgba(80,160,255,0.85)';
      ctx.fillRect(barX, barY2 + barH2 + 3, barW * ws.defenderStrength, barH2);
      ctx.font = '8px Cinzel, serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      ctx.fillText('ATK', barX - 4, barY2 + barH2);
      ctx.fillStyle = '#88aaff';
      ctx.fillText('DEF', barX - 4, barY2 + barH2 * 2 + 3);
    }

    // Bottom legend
    ctx.fillStyle = 'rgba(4,2,12,0.8)';
    ctx.fillRect(0, H - 36, W, 36);
    ctx.fillStyle = 'rgba(200,169,110,0.5)';
    ctx.font = '9px Cinzel, serif';
    ctx.textAlign = 'center';
    ctx.fillText('SCROLL/DRAG TO NAVIGATE  ·  SCROLL WHEEL TO ZOOM  ·  [ESC] RETURN TO STAR MAP', W / 2, H - 14);

    // M17: Biosphere HUD overlay
    if (this.bioOverlayVisible && this.bioData) {
      drawBiosphereHUDLayer(ctx, W, H, this.bioData.species, this.bioData.biosphere);
    }
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private setupInput(): void {
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.85 : 1.18;
      this.camScale = Math.max(0.4, Math.min(6, this.camScale * factor));
    }, { passive: false });

    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.dragCamStart = { x: this.camX, y: this.camY };
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      this.camX = this.dragCamStart.x - (e.clientX - this.dragStart.x) / this.camScale;
      this.camY = this.dragCamStart.y - (e.clientY - this.dragStart.y) / this.camScale;
    });

    window.addEventListener('mouseup', () => { this.isDragging = false; });
  }
}

// ─── Standalone planet texture baker ──────────────────────────────────────────
// Used by BigBangEngine to render planet globes without importing PlanetRenderer
// as a full class (avoids circular dependency). Shares the same noise math.

function _hash2(x: number, y: number, seed: number): number {
  let h = seed + x * 374761393 + y * 668265263;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function _valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = _hash2(ix,     iy,     seed);
  const b = _hash2(ix + 1, iy,     seed);
  const c = _hash2(ix,     iy + 1, seed);
  const d = _hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function _fbm(x: number, y: number, seed: number, octaves: number): number {
  let v = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    v += _valueNoise(x * freq, y * freq, seed + i * 997) * amp;
    amp *= 0.5; freq *= 2.1;
  }
  return Math.max(0, Math.min(1, v));
}

function _heightToColor(h: number, type: string, dna: PlanetDNA): [number, number, number] {
  if (type === 'lava') {
    if (h < 0.3)  return [20,  10,  10];
    if (h < 0.5)  return [100, 20,  10];
    if (h < 0.65) return [200, 60,  10];
    if (h < 0.8)  return [255, 140, 20];
    return [255, 220, 100];
  }
  if (type === 'ice') {
    if (h < 0.3)  return [100, 160, 200];
    if (h < 0.45) return [160, 210, 240];
    if (h < 0.7)  return [220, 240, 255];
    return [255, 255, 255];
  }
  if (type === 'ocean') {
    if (h < 0.6)  return [10,  60,  140];
    if (h < 0.72) return [20,  100, 180];
    if (h < 0.76) return [180, 160, 100];
    return [40, 100, 50];
  }
  if (type === 'gas') {
    // Several band families so gas giants aren't all Jupiter-tan
    const families: [number, number, number][][] = [
      [[200,160,80],[180,130,60],[220,180,100],[160,120,60],[240,200,120]], // warm
      [[180,140,160],[140,100,130],[210,170,190],[120,90,110],[230,200,210]], // violet
      [[120,160,190],[90,130,160],[160,190,210],[70,110,140],[190,210,230]],  // blue
      [[160,170,100],[130,140,70],[190,195,120],[100,110,55],[210,215,150]], // olive
      [[200,120,80],[170,90,55],[230,150,100],[140,70,40],[240,180,130]],   // rust
    ];
    const fi = dna.chaos === 'storm' ? 4 : dna.chaos === 'serene' ? 2 : dna.climate === 'frozen' ? 2 : dna.climate === 'desert' ? 0 : 1;
    const bands = families[fi % families.length];
    return bands[Math.floor(h * bands.length) % bands.length];
  }
  // Rocky / temperate with DNA
  const oceanLevel = dna.oceans === 'barren' ? 0.05 : dna.oceans === 'ocean_world' ? 0.78 : 0.42;
  if (dna.climate === 'frozen') {
    if (h < oceanLevel * 0.7) return [10,  30,  90];
    if (h < oceanLevel)        return [60,  100, 160];
    if (h < 0.55)              return [160, 200, 230];
    if (h < 0.72)              return [210, 230, 245];
    if (h < 0.88)              return [230, 240, 255];
    return [255, 255, 255];
  }
  if (dna.climate === 'desert') {
    if (h < oceanLevel)            return [40,  55,  110];
    if (h < oceanLevel + 0.05)     return [160, 130, 80];
    if (h < 0.55)                  return [180, 120, 60];
    if (h < 0.68)                  return [160, 100, 50];
    if (h < 0.82)                  return [130, 80,  40];
    if (h < 0.92)                  return [110, 70,  40];
    return [200, 180, 160];
  }
  if (h < oceanLevel * 0.75)    return [10,  40,  120];
  if (h < oceanLevel)            return [20,  80,  170];
  if (h < oceanLevel + 0.05)    return [190, 175, 120];
  if (h < 0.6)                   return [60,  130, 55];
  if (h < 0.72)                  return [35,  100, 35];
  if (h < 0.85)                  return [100, 85,  75];
  if (h < 0.93)                  return [140, 120, 110];
  return [240, 240, 255];
}

function _applyBioTint(
  color: [number, number, number],
  h: number,
  phase: string,
): [number, number, number] {
  if (h <= 0.45) return color;
  let [r, g, b] = color;
  switch (phase) {
    case 'microbial':
      r = Math.round(r * 0.97);
      g = Math.min(255, Math.round(g + 6));
      b = Math.min(255, Math.round(b + 10));
      break;
    case 'multicellular':
      r = Math.round(r * 0.95);
      g = Math.min(255, Math.round(g * 1.05 + 8));
      b = Math.round(b * 0.97);
      break;
    case 'complex':
      r = Math.round(r * 0.92);
      g = Math.min(255, Math.round(g * 1.08 + 12));
      b = Math.round(b * 0.95);
      break;
    case 'primitive':
      r = Math.min(255, Math.round(r * 1.03 + 5));
      g = Math.min(255, Math.round(g * 1.01 + 3));
      b = Math.round(b * 0.94);
      break;
    default:
      break;
  }
  return [
    Math.max(0, Math.min(255, r)),
    Math.max(0, Math.min(255, g)),
    Math.max(0, Math.min(255, b)),
  ];
}

/**
 * Bake a small planet terrain texture. Returns an HTMLCanvasElement (size × size/2).
 * Deterministic from starId + planetIndex. Safe to call from BigBangEngine.
 * Pass biologyPhase (non-null) for the player's planet to get bio tinting.
 */
export function bakePlanetTexture(
  starId: number,
  planetIndex: number,
  type: string,
  dna: PlanetDNA,
  size = 128,
  biologyPhase: string | null = null,
  grid: PlanetGrid | null = null,
): HTMLCanvasElement {
  const offscreen = document.createElement('canvas');
  offscreen.width = size;
  offscreen.height = Math.round(size / 2);
  const ctx = offscreen.getContext('2d')!;
  const W = offscreen.width, H = offscreen.height;
  const imageData = ctx.createImageData(W, H);
  const data = imageData.data;
  const seed = starId * 7777;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let r: number, g: number, b: number;

      if (grid) {
        // Data-driven path: sample biome color from simulation grid
        const cell = sampleGrid(grid, px / W, py / H);
        // Classify for THIS world type, as the planet view does: the stored
        // biome can be stale (a formation stage's lava labels on a world that
        // has since become an ocean).
        [r, g, b] = BIOME_COLORS[classifyBiome(cell.elevation, cell.moisture, cell.temperature, type)];
        // Blend in life density as a subtle green tint on land
        if (cell.lifeDensity > 0) {
          const lt = cell.lifeDensity * 0.35;
          r = Math.round(r * (1 - lt) + 40  * lt);
          g = Math.round(g * (1 - lt) + 160 * lt);
          b = Math.round(b * (1 - lt) + 60  * lt);
        }
        if (biologyPhase) {
          const h = cell.elevation;
          [r, g, b] = _applyBioTint([r, g, b], h, biologyPhase);
        }
      } else {
        // Legacy noise-based path (NPC planets, no grid)
        const nx = px / W * 4;
        const ny = py / H * 2;
        const h = _fbm(nx, ny, seed + planetIndex * 131, 5);
        [r, g, b] = _heightToColor(h, type, dna);
        if (biologyPhase) {
          [r, g, b] = _applyBioTint([r, g, b], h, biologyPhase);
        }
      }

      const idx = (py * W + px) * 4;
      data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return offscreen;
}

