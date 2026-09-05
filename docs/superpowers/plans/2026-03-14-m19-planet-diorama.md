# M19: Pixel-Art Isometric Planet Diorama — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Canvas 2D PlanetRenderer for the player's home planet with a fully animated pixel-art isometric diorama rendered in Pixi.js v8.

**Architecture:** A new `IsoDioramaRenderer` class creates its own Pixi.js `Application` targeting a `#diorama-mount` div in `#planet-overlay`. Eight layered Pixi.js `Graphics` containers render back-to-front: starfield background, atmosphere glow, cliff sides, terrain surface, ocean shimmer, clouds, city lights, and bottom formations. All animations run via `app.ticker` with framerate-independent deltas. The existing `PlanetGrid` is upgraded from 128×128 to 256×256 cells simultaneously.

**Tech Stack:** Pixi.js v8 (`Application`, `Graphics`, `Container`, `ColorMatrixFilter`), TypeScript, `PlanetGrid` / `GameState` data structures. No new npm packages required.

**Spec:** `docs/superpowers/specs/2026-03-14-planet-diorama-design.md`

**Note on testing:** This milestone is almost entirely rendering. There are no unit-testable pure functions beyond the grid upgrade. Each task verifies correctness via `npx tsc --noEmit` + manual visual inspection in the browser. Follow the pattern: implement → TypeScript check → open browser → inspect visually → commit.

---

## Chunk 1: Data Layer — PlanetGrid Upgrade & civId Write Path

### Task 1: Upgrade PlanetGrid from 128×128 to 256×256

**Files:**
- Modify: `src/simulation/PlanetGrid.ts`

**Background:** `GRID_SIZE = 128` is a single constant. Changing it cascades to `generatePlanetGrid()`, `sampleGrid()`, and `stepLifeSpread()` automatically — no loop bounds to manually update. The `fbm()` function currently runs 5 octaves; at 256 cells we add 1 more for finer terrain detail.

- [ ] **Step 1: Change GRID_SIZE constant**

In `src/simulation/PlanetGrid.ts`, line 32:
```typescript
// BEFORE
export const GRID_SIZE = 128;
// AFTER
export const GRID_SIZE = 256;
```

- [ ] **Step 2: Add a 7th octave option to fbm for high-res generation**

Change the default octaves in `fbm()` signature and update calls in `generatePlanetGrid()`:
```typescript
// PlanetGrid.ts — fbm signature, line 121
function fbm(x: number, y: number, seed: number, octaves = 7): number {
```

The existing calls in `generatePlanetGrid()` don't pass `octaves` explicitly, so they will automatically use 7 now. This gives finer terrain detail at 256×256.

- [ ] **Step 3: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors. If errors appear they are likely in unrelated files — do not fix them here, investigate and stop.

- [ ] **Step 4: Commit**

```bash
git add src/simulation/PlanetGrid.ts
git commit -m "feat(grid): upgrade PlanetGrid GRID_SIZE 128 → 256, add 7th fbm octave"
```

---

### Task 2: Add civId write path in stepLifeSpread

**Files:**
- Modify: `src/simulation/PlanetGrid.ts`
- Modify: `src/simulation/BigBangEngine.ts`

**Background:** `GridCell.civId` is always `null` — no code stamps it. City lights in the diorama depend on this field. We add an optional `activeCivId` parameter to `stepLifeSpread()`. When provided AND the cell has `lifeDensity > 0.3` AND is habitable land, the cell's `civId` is stamped. The call site in `BigBangEngine.ts` passes `String(star.id)` when `star.civLevel >= 1`.

- [ ] **Step 1: Add optional parameter to stepLifeSpread**

In `src/simulation/PlanetGrid.ts`, replace the `stepLifeSpread` signature (line 286):
```typescript
export function stepLifeSpread(
  grid: PlanetGrid,
  bioPhase: string,
  spreadRate: number,   // 0–1, controlled by DNA adaptability
  activeCivId?: string | null,  // stamp on settled habitable cells when provided
): void {
```

At the end of the function body, after all the existing spread logic, add a civId stamping pass:
```typescript
  // Stamp civId on settled habitable cells when a civ is active
  if (activeCivId != null) {
    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        const cell = grid[row][col];
        if (isHabitable(cell.biome) && cell.lifeDensity > 0.3) {
          cell.civId = activeCivId;
        }
      }
    }
  }
```

- [ ] **Step 2: Update the call site in BigBangEngine.ts**

Find the `stepLifeSpread` call at `src/simulation/BigBangEngine.ts` line ~808:
```typescript
// BEFORE
stepLifeSpread(runtimeState.playerPlanetGrid, star.biologyPhase, spreadRate);

// AFTER
const civIdToStamp = star.civLevel >= 1 ? String(star.id) : null;
stepLifeSpread(runtimeState.playerPlanetGrid, star.biologyPhase, spreadRate, civIdToStamp);
```

- [ ] **Step 3: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/simulation/PlanetGrid.ts src/simulation/BigBangEngine.ts
git commit -m "feat(grid): stamp civId on settled tiles in stepLifeSpread for city lights"
```

---

## Chunk 2: Renderer Scaffold & Background

### Task 3: Create IsoDioramaRenderer scaffold

**Files:**
- Create: `src/rendering/IsoDioramaRenderer.ts`

**Background:** This class follows the same `async init()` pattern as `PixiBigBangRenderer`. It creates its own `Application`, owns 8 `Graphics` layer containers, and exposes `start()`, `pause()`, `resume()`, `refreshData()` methods. The ticker is used (not stopped like in PixiBigBangRenderer). All geometry is derived from canvas `W×H` at render time.

- [ ] **Step 1: Create the file with full scaffold**

Create `src/rendering/IsoDioramaRenderer.ts`:

```typescript
/**
 * IsoDioramaRenderer — pixel-art isometric planet diorama for the player's home planet.
 *
 * Renders a floating cylindrical world-slice: elliptical isometric top surface,
 * rocky cliff sides with geological layers, animated overlays, and a static
 * cosmic backdrop.
 *
 * Usage:
 *   const renderer = new IsoDioramaRenderer();
 *   await renderer.init(mountDiv);
 *   renderer.refreshData(grid, biosphere, species, planet);
 *   renderer.start();
 *   // on overlay close:
 *   renderer.pause();
 *   // on overlay re-open:
 *   renderer.resume();
 *   renderer.refreshData(...);  // pick up any changes
 */

import { Application, Graphics, Container } from 'pixi.js';
import type { PlanetGrid, GridCell } from '../simulation/PlanetGrid';
import { BIOME_COLORS, isWater, isHabitable, GRID_SIZE } from '../simulation/PlanetGrid';
import type { PlanetBiosphere, SpeciesGenome } from '../simulation/SpeciesGenome';
import type { Planet } from '../simulation/BigBangEngine';

// ─── Planet type palettes ──────────────────────────────────────────────────────

export type PlanetType = 'ocean' | 'rocky' | 'lava' | 'ice' | 'gas';

interface PlanetPalette {
  atmosColor: number;      // atmosphere glow hex
  cliffStripes: number[];  // 4 stripe colors top→bottom (or empty for gas)
  cliffShadow: number;     // left-side darkening overlay color
  cliffLight: number;      // right-side highlight overlay color
  bottomColor: number;     // base color for bottom formations
  bottomGlow: number | null; // glow color for lava drips / null if none
}

const PALETTES: Record<PlanetType, PlanetPalette> = {
  ocean: {
    atmosColor: 0x1a5fa8,
    cliffStripes: [0xc8b87a, 0x9e8060, 0x5a4a3a, 0x1a1510],
    cliffShadow: 0x000000,
    cliffLight:  0xffffff,
    bottomColor: 0x2a1e14,
    bottomGlow:  null,
  },
  rocky: {
    atmosColor: 0xa07840,
    cliffStripes: [0x8a6a40, 0x7a5a35, 0x5a4428, 0x2e2018],
    cliffShadow: 0x000000,
    cliffLight:  0xffffff,
    bottomColor: 0x3a2e24,
    bottomGlow:  null,
  },
  lava: {
    atmosColor: 0xcc3300,
    cliffStripes: [0x3a2018, 0x6a1800, 0xaa3300, 0x1a0800],
    cliffShadow: 0x000000,
    cliffLight:  0xff6622,
    bottomColor: 0x1a0800,
    bottomGlow:  0xff5500,
  },
  ice: {
    atmosColor: 0x88ccee,
    cliffStripes: [0xddeeff, 0xaaccdd, 0x8898a8, 0x445566],
    cliffShadow: 0x002244,
    cliffLight:  0xffffff,
    bottomColor: 0x445566,
    bottomGlow:  null,
  },
  gas: {
    atmosColor: 0x886699,
    cliffStripes: [],  // gas: no geological stripes — bands replace cliff
    cliffShadow: 0x000000,
    cliffLight:  0xffffff,
    bottomColor: 0x4a2255,
    bottomGlow:  null,
  },
};

// ─── Renderer ─────────────────────────────────────────────────────────────────

export class IsoDioramaRenderer {
  private app!: Application;

  // Layer containers (back to front)
  private bgLayer!:      Graphics;
  private atmosLayer!:   Graphics;
  private cliffLayer!:   Graphics;
  private surfaceLayer!: Graphics;
  private oceanLayer!:   Graphics;
  private cloudLayer!:   Graphics;
  private cityLayer!:    Graphics;
  private bottomLayer!:  Graphics;

  // Data
  private grid:       PlanetGrid | null = null;
  private biosphere:  PlanetBiosphere | null = null;
  private species:    SpeciesGenome[] = [];
  private planet:     Planet | null = null;
  private planetType: PlanetType = 'ocean';

  // Animation state
  private clouds: Array<{ x: number; y: number; rx: number; ry: number; alpha: number }> = [];
  private stars:  Array<{ x: number; y: number; r: number; twinkle: boolean; phase: number }> = [];
  private cityDots: Array<{ x: number; y: number; nextBlink: number; visible: boolean }> = [];
  private lavaVeins: Array<{ x: number; y1: number; y2: number; phase: number }> = [];
  private lavaDrops: Array<{ x: number; y: number; vy: number; maxY: number }> = [];

  /** Whether the ticker is running */
  private running = false;

  get canvas(): HTMLCanvasElement { return this.app.canvas as HTMLCanvasElement; }

  // ─── Geometry helpers (computed from canvas size) ──────────────────────────

  private get W(): number { return this.app.canvas.width; }
  private get H(): number { return this.app.canvas.height; }

  /** Disc center x */
  private get cx(): number { return Math.round(this.W / 2); }
  /** Disc center y (slightly above vertical center) */
  private get cy(): number { return Math.round(this.H * 0.40); }
  /** Top ellipse x-radius */
  private get rx(): number { return Math.round(this.W * 0.44); }
  /** Top ellipse y-radius (2:1 ratio = isometric look) */
  private get ry(): number { return Math.round(this.W * 0.22); }
  /** Cliff wall height in pixels */
  private get wallH(): number { return Math.round(this.H * 0.30); }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async init(mount: HTMLElement): Promise<void> {
    this.app = new Application();
    await this.app.init({
      width:            mount.clientWidth  || window.innerWidth,
      height:           mount.clientHeight || window.innerHeight,
      antialias:        false,
      backgroundAlpha:  0,
      resolution:       1,
      autoDensity:      false,
    });

    // Pixel-art: nearest-neighbour on all textures
    // (individual textures set texture.source.scaleMode = 'nearest' where needed)
    const canvas = this.app.canvas as HTMLCanvasElement;
    canvas.style.imageRendering = 'pixelated';
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    mount.style.position = 'relative';
    mount.appendChild(canvas);

    // Build layer stack
    this.bgLayer      = new Graphics();
    this.atmosLayer   = new Graphics();
    this.cliffLayer   = new Graphics();
    this.surfaceLayer = new Graphics();
    this.oceanLayer   = new Graphics();
    this.cloudLayer   = new Graphics();
    this.cityLayer    = new Graphics();
    this.bottomLayer  = new Graphics();

    for (const layer of [
      this.bgLayer, this.atmosLayer, this.cliffLayer, this.surfaceLayer,
      this.oceanLayer, this.cloudLayer, this.cityLayer, this.bottomLayer,
    ]) {
      this.app.stage.addChild(layer);
    }

    this._buildStaticLayers();

    // Wire ticker
    this.app.ticker.add(() => this._onTick());
    this.app.ticker.stop(); // start manually via start()
  }

  refreshData(
    grid: PlanetGrid,
    biosphere: PlanetBiosphere,
    species: SpeciesGenome[],
    planet: Planet,
  ): void {
    this.grid      = grid;
    this.biosphere = biosphere;
    this.species   = species;
    this.planet    = planet;
    this.planetType = (planet.type ?? 'rocky') as PlanetType;
    this._buildStaticLayers();
    this._buildCityDots();
  }

  start(): void {
    if (!this.running) {
      this.running = true;
      this.app.ticker.start();
    }
  }

  pause(): void {
    this.running = false;
    this.app.ticker.stop();
  }

  resume(): void {
    this.start();
  }

  // ─── Static layer builders (called once on refreshData) ───────────────────

  private _buildStaticLayers(): void {
    this._drawBackground();
    this._drawAtmosphere();
    this._drawCliff();
    this._drawSurface();
    this._drawBottomFormations();
    this._buildClouds();
  }

  private _buildClouds(): void {
    const { cx, cy, rx, ry } = this;
    this.clouds = [];
    if (this.planetType === 'lava' || this.planetType === 'gas') return;
    const rngBase = this.planet ? this.planet.id * 7919 : 42;
    for (let i = 0; i < 4; i++) {
      const phase = (rngBase * (i + 1) * 1.618) % 1;
      this.clouds.push({
        x:     cx - rx + phase * rx * 2,
        y:     cy - ry * 0.3 + ((rngBase * (i + 3)) % 100) / 100 * ry * 0.5,
        rx:    30 + ((rngBase * (i + 7)) % 40),
        ry:    12 + ((rngBase * (i + 11)) % 14),
        alpha: 0.55 + ((rngBase * (i + 5)) % 30) / 100,
      });
    }
  }

  private _buildCityDots(): void {
    this.cityDots = [];
    if (!this.grid) return;
    const { cx, cy, rx, ry } = this;
    const step = 4; // sample every 4 screen pixels
    const rngBase = ((this.planet ? this.planet.id : 1) * 3571) >>> 0;

    for (let py = cy - ry; py <= cy + ry; py += step) {
      for (let px = cx - rx; px <= cx + rx; px += step) {
        if (!this._inTopEllipse(px, py)) continue;
        const u = (px - (cx - rx)) / (rx * 2);
        const v = (py - (cy - ry)) / (ry * 2);
        const col = Math.min(GRID_SIZE - 1, Math.round(u * (GRID_SIZE - 1)));
        const row = Math.min(GRID_SIZE - 1, Math.round(v * (GRID_SIZE - 1)));
        const cell = this.grid[row]?.[col];
        if (cell?.civId != null) {
          const seed = (row * 256 + col) >>> 0;
          // Use >>> 0 truncation at each step to stay within 32-bit safe range
          const rng = (((rngBase * ((seed * 48271) >>> 0)) >>> 0) / 0xffffffff);
          this.cityDots.push({
            x: px, y: py,
            nextBlink: 1000 + rng * 4000,
            visible:   rng > 0.5,
          });
        }
      }
    }
  }

  // ─── Geometry helpers ─────────────────────────────────────────────────────

  private _inTopEllipse(px: number, py: number): boolean {
    const { cx, cy, rx, ry } = this;
    const dx = (px - cx) / rx;
    const dy = (py - cy) / ry;
    return dx * dx + dy * dy <= 1;
  }

  // ─── Layer draw stubs (filled in subsequent tasks) ────────────────────────

  private _drawBackground():        void { /* Task 4 */ }
  private _drawAtmosphere():        void { /* Task 5 */ }
  private _drawCliff():             void { /* Task 6 */ }
  private _drawSurface():           void { /* Task 7 */ }
  private _drawBottomFormations():  void { /* Task 9 */ }

  // ─── Ticker ───────────────────────────────────────────────────────────────

  private _onTick(): void {
    const t   = this.app.ticker.lastTime / 1000;   // seconds since start
    const dt  = this.app.ticker.deltaMS / 1000;    // frame delta in seconds
    this._animateClouds(dt);
    this._animateCityLights(dt);
    this._redrawAnimatedLayers(t, dt);
  }

  private _animateClouds(dt: number): void {
    const { cx, rx } = this;
    for (const c of this.clouds) {
      c.x += 24 * dt;
      if (c.x - c.rx > cx + rx) c.x = cx - rx - c.rx;
    }
  }

  private _animateCityLights(dt: number): void {
    const dtMs = dt * 1000;
    for (const dot of this.cityDots) {
      dot.nextBlink -= dtMs;
      if (dot.nextBlink <= 0) {
        dot.visible = !dot.visible;
        dot.nextBlink = 1000 + Math.random() * 4000; // visual only — not seeded per-frame
      }
    }
  }

  private _redrawAnimatedLayers(t: number, _dt: number): void {
    this._drawAtmosphere();     // pulses
    this._drawOceanShimmer(t);
    this._drawClouds();
    this._drawCityLights();
    this._animateLavaEffects(t);
    this._animateGasBands(t);
    this._animateStars(t);
  }

  // ─── Animation draw stubs (filled in subsequent tasks) ────────────────────

  private _drawOceanShimmer(_t: number):    void { /* Task 8 */ }
  private _drawClouds():                    void { /* Task 8 */ }
  private _drawCityLights():                void { /* Task 8 */ }
  private _animateLavaEffects(_t: number):  void { /* Task 9 */ }
  private _animateGasBands(_t: number):     void { /* Task 7 */ }
  private _animateStars(_t: number):        void { /* Task 4 */ }
}
```

- [ ] **Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors (stubs are valid empty methods).

- [ ] **Step 3: Commit**

```bash
git add src/rendering/IsoDioramaRenderer.ts
git commit -m "feat(diorama): scaffold IsoDioramaRenderer with layer stack, geometry helpers, ticker"
```

---

### Task 4: Background layer — starfield and moon

**Files:**
- Modify: `src/rendering/IsoDioramaRenderer.ts` — fill `_drawBackground()` and `_animateStars()`

**Background:** The background is static except for star twinkle. Stars are generated once from a seed and stored in `this.stars`. `_drawBackground()` draws the gradient + moon on init. `_animateStars()` redraws only the bgLayer each frame (fast, <50 stars twinkle).

- [ ] **Step 1: Build star array in `_buildStaticLayers`**

Add a star-building step to `_buildStaticLayers()`. Add to the class, called once:

```typescript
private _buildStars(): void {
  this.stars = [];
  const seed = this.planet ? this.planet.id * 1234567 : 9999;
  for (let i = 0; i < 250; i++) {
    const h1 = ((seed * (i + 1) * 48271) >>> 0) / 0xffffffff;
    const h2 = ((seed * (i + 1) * 16807 + 999) >>> 0) / 0xffffffff;
    const h3 = ((seed * (i + 1) * 69621 + 333) >>> 0) / 0xffffffff;
    this.stars.push({
      x:       Math.round(h1 * this.W),
      y:       Math.round(h2 * this.H),
      r:       h3 > 0.85 ? 2 : 1,
      twinkle: h3 > 0.85,   // 15% of stars twinkle
      phase:   h3 * Math.PI * 2,
    });
  }
}
```

Call `this._buildStars()` at the start of `_buildStaticLayers()`.

- [ ] **Step 2: Implement `_drawBackground()`**

Replace the stub:

```typescript
private _drawBackground(): void {
  const g = this.bgLayer;
  g.clear();
  const { W, H } = this;

  // Deep space gradient — fill with near-black, subtle blue-purple at top
  g.rect(0, 0, W, H).fill({ color: 0x03030e });
  // Faint blue tint in upper third
  for (let y = 0; y < H * 0.4; y += 2) {
    const alpha = (1 - y / (H * 0.4)) * 0.06;
    g.rect(0, y, W, 2).fill({ color: 0x1a2a5a, alpha });
  }

  // Draw non-twinkle stars (static — drawn once)
  for (const s of this.stars) {
    if (!s.twinkle) {
      g.circle(s.x, s.y, s.r).fill({ color: 0xffffff, alpha: 0.7 + 0.3 * s.phase });
    }
  }

  // Moon — top-right quadrant, procedural pixel art
  this._drawMoon(g, Math.round(W * 0.82), Math.round(H * 0.14), Math.round(W * 0.07));
}
```

- [ ] **Step 3: Implement `_drawMoon()`**

Add the moon helper:

```typescript
private _drawMoon(g: Graphics, mx: number, my: number, r: number): void {
  // Main moon disc — pale blue-white
  g.circle(mx, my, r).fill({ color: 0xd0dcf0 });
  // Dark hemisphere shadow (left side)
  g.circle(mx - Math.round(r * 0.15), my, r * 0.92).fill({ color: 0x7a8caa, alpha: 0.5 });
  // Craters — seeded positions
  const craterSeed = 77777;
  const craters = [
    { dx: -0.30, dy: -0.25, cr: 0.18 },
    { dx:  0.20, dy:  0.30, cr: 0.13 },
    { dx: -0.10, dy:  0.10, cr: 0.10 },
    { dx:  0.35, dy: -0.10, cr: 0.09 },
  ];
  void craterSeed;
  for (const c of craters) {
    const cx = mx + Math.round(c.dx * r);
    const cy = my + Math.round(c.dy * r);
    const cr = Math.max(2, Math.round(c.cr * r));
    g.circle(cx, cy, cr).fill({ color: 0x8898b8, alpha: 0.6 });
    g.circle(cx, cy, Math.max(1, cr - 1)).fill({ color: 0xaabbd0, alpha: 0.3 });
  }
}
```

- [ ] **Step 4: Implement `_animateStars()`**

Replace the stub. Only the twinkle stars redraw (rest are static on bgLayer):

```typescript
private _animateStars(t: number): void {
  const g = this.bgLayer;
  // Redraw only twinkle stars (cheap — ~35 stars)
  // We can't easily erase individual stars, so we redraw the whole bgLayer every N frames
  // Strategy: redraw bgLayer fully every 30 frames (~2s) to avoid per-frame full redraw
  // The twinkle effect is subtle enough that 2s refresh is fine.
  if (Math.round(t * 2) % 4 !== 0) return; // update ~every 2s
  this._drawBackground();
  // Draw twinkle stars with current alpha
  for (const s of this.stars) {
    if (s.twinkle) {
      const alpha = 0.7 + 0.3 * Math.sin(t * 1.5 + s.phase);
      g.circle(s.x, s.y, s.r).fill({ color: 0xffffff, alpha });
    }
  }
}
```

- [ ] **Step 5: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/rendering/IsoDioramaRenderer.ts
git commit -m "feat(diorama): background layer — starfield, moon, star twinkle"
```

---

## Chunk 3: Core Disc Geometry — Atmosphere, Cliff, Surface

### Task 5: Atmosphere glow layer

**Files:**
- Modify: `src/rendering/IsoDioramaRenderer.ts` — fill `_drawAtmosphere()`

- [ ] **Step 1: Implement `_drawAtmosphere()`**

Replace the stub:

```typescript
private _drawAtmosphere(): void {
  const g = this.atmosLayer;
  g.clear();
  const { cx, cy, rx, ry } = this;
  const palette = PALETTES[this.planetType];
  const t = this.app.ticker.lastTime / 1000;
  const alpha = 0.35 + 0.1 * Math.sin(t * 0.628);  // ~10s pulse cycle

  // Layered concentric ellipses for soft glow (3 passes, decreasing alpha)
  for (let i = 3; i >= 1; i--) {
    const scale = 1 + i * 0.10;
    const a = (alpha / i) * 0.6;
    g.ellipse(cx, cy + Math.round(this.wallH / 2), rx * scale, (ry + this.wallH / 2) * scale)
      .fill({ color: palette.atmosColor, alpha: a });
  }
}
```

- [ ] **Step 2: TypeScript check + visual preview**

Run: `npx tsc --noEmit` — expected: no errors.

(Visual preview requires the integration in Task 11 — note this for now, verify visually after Task 11.)

- [ ] **Step 3: Commit**

```bash
git add src/rendering/IsoDioramaRenderer.ts
git commit -m "feat(diorama): atmosphere glow layer with 10s pulse animation"
```

---

### Task 6: Cliff layer — geological disc wall

**Files:**
- Modify: `src/rendering/IsoDioramaRenderer.ts` — fill `_drawCliff()`

**Background:** The cliff is the visible side wall of the planet disc. It's the region between the bottom half of the top ellipse and the top half of the bottom ellipse (which is centered `wallH` pixels lower). The shape is filled with a base dark color, then horizontal stripe lines are drawn across it to simulate geological layers. Gas planets replace this with swirling horizontal gas bands.

The cliff shape (simplified polygon approach):
- Left edge: vertical line from `(cx - rx, cy)` down to `(cx - rx, cy + wallH)`
- Right edge: vertical line from `(cx + rx, cy)` down to `(cx + rx, cy + wallH)`
- Bottom arc: bottom ellipse from left to right (drawn as bezier approximation)
- Top arc: bottom of top ellipse from right back to left (drawn as bezier)

- [ ] **Step 1: Add cliff shape draw helper**

Add private helper:

```typescript
/**
 * Draw the cliff disc-wall shape.
 * The cliff is the visible cylindrical side between the top and bottom ellipses.
 */
private _drawCliffShape(g: Graphics, color: number, alpha = 1.0): void {
  const { cx, cy, rx, ry, wallH } = this;
  const k = 0.5523; // bezier approximation constant for ellipse

  // Bottom ellipse control points
  const bcy = cy + wallH; // bottom ellipse center y
  const kx  = rx * k;
  const ky  = ry * k;

  // Build cliff outline: left-edge down → bottom arc → right-edge up → top arc (inverted)
  g.moveTo(cx - rx, cy)
   .lineTo(cx - rx, bcy)
   // Bottom arc: left → bottom → right (going through nadir)
   .bezierCurveTo(cx - rx, bcy + ky, cx - kx, bcy + ry, cx, bcy + ry)
   .bezierCurveTo(cx + kx, bcy + ry, cx + rx, bcy + ky, cx + rx, bcy)
   .lineTo(cx + rx, cy)
   // Top arc (REVERSED — right → bottom → left, closing the shape)
   .bezierCurveTo(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry)
   .bezierCurveTo(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy)
   .fill({ color, alpha });
}
```

- [ ] **Step 2: Implement `_drawCliff()` for non-gas planets**

Replace the stub:

```typescript
private _drawCliff(): void {
  const g = this.cliffLayer;
  g.clear();
  const { cx, cy, rx, ry, wallH } = this;
  const palette = PALETTES[this.planetType];

  if (this.planetType === 'gas') {
    this._drawGasCliff(g);
    return;
  }

  const stripes = palette.cliffStripes;
  if (stripes.length < 4) return;

  // Base cliff shape with darkest stripe color
  this._drawCliffShape(g, stripes[3]);

  // Geological stripes — 4 equal horizontal bands, top stripe lightest
  const stripeH = wallH / stripes.length;
  for (let i = 0; i < stripes.length; i++) {
    const sy = cy + i * stripeH;
    const ey = sy + stripeH;
    // Clip stripe to cliff shape by only drawing the horizontal strip within ellipse bounds
    // Approximate: draw full-width rect and let overdraw be covered by surface layer on top
    // For each y scanline in this stripe, compute x extent along cliff
    for (let scanY = Math.round(sy); scanY < Math.round(ey); scanY += 1) {
      // Compute x extent at this y for both top and bottom ellipses
      // Top ellipse: (x-cx)²/rx² + (scanY-cy)²/ry² = 1
      const dyTop = scanY - cy;
      const dyBot = scanY - (cy + wallH);
      const topXFrac = 1 - (dyTop / ry) * (dyTop / ry);
      const botXFrac = 1 - (dyBot / ry) * (dyBot / ry);

      let xLeft:  number;
      let xRight: number;

      if (topXFrac >= 0 && botXFrac >= 0) {
        // Between both ellipses — use the narrower width
        const topX = rx * Math.sqrt(topXFrac);
        const botX = rx * Math.sqrt(botXFrac);
        xLeft  = cx - Math.min(topX, botX);
        xRight = cx + Math.min(topX, botX);
      } else if (topXFrac >= 0) {
        // Only top ellipse — we're in the very bottom of the cliff
        const topX = rx * Math.sqrt(topXFrac);
        xLeft  = cx - topX;
        xRight = cx + topX;
      } else {
        continue; // above the visible cliff area
      }

      g.rect(Math.round(xLeft), scanY, Math.round(xRight - xLeft), 1)
       .fill({ color: stripes[i] });
    }
  }

  // Shadow (left side) — dark semi-transparent overlay
  const shadowW = Math.round(rx * 0.35);
  for (let scanY = cy; scanY < cy + wallH + ry; scanY++) {
    const t = (scanY - cy) / (wallH + ry);
    const edgeX = cx - rx * Math.sqrt(Math.max(0, 1 - ((scanY - cy) / ry) * ((scanY - cy) / ry)));
    if (isNaN(edgeX)) continue;
    g.rect(Math.round(edgeX), scanY, shadowW, 1)
     .fill({ color: palette.cliffShadow, alpha: 0.45 * (1 - t * 0.5) });
  }

  // Highlight (right side)
  for (let scanY = cy; scanY < cy + Math.round(wallH * 0.3); scanY++) {
    const t = (scanY - cy) / (wallH * 0.3);
    const edgeX = cx + rx * Math.sqrt(Math.max(0, 1 - ((scanY - cy) / ry) * ((scanY - cy) / ry)));
    if (isNaN(edgeX)) continue;
    const highlightW = Math.round(rx * 0.12);
    g.rect(Math.round(edgeX) - highlightW, scanY, highlightW, 1)
     .fill({ color: palette.cliffLight, alpha: 0.15 * (1 - t) });
  }
}
```

- [ ] **Step 3: Add `_drawGasCliff()` for gas planets**

```typescript
private _drawGasCliff(g: Graphics): void {
  const { cx, cy, rx, ry, wallH } = this;
  // Gas planets have swirling horizontal band layers instead of geological stripes
  // Base: draw the cliff shape in dark purple
  this._drawCliffShape(g, 0x1a0a2a);

  // Horizontal gas bands — alternating colors drifting slowly (redrawn in _animateGasBands)
  // (static initial draw — animation in ticker)
  const bands = [
    { color: 0x6644aa, alpha: 0.5 },
    { color: 0x442266, alpha: 0.4 },
    { color: 0x885599, alpha: 0.35 },
    { color: 0x221133, alpha: 0.3 },
    { color: 0x553388, alpha: 0.45 },
  ];
  const bandH = (wallH + ry * 2) / bands.length;
  for (let i = 0; i < bands.length; i++) {
    const bandY = cy + i * bandH;
    g.rect(cx - rx - 4, Math.round(bandY), rx * 2 + 8, Math.round(bandH))
     .fill({ color: bands[i].color, alpha: bands[i].alpha });
  }
  // Re-apply the cliff shape as a mask by overdrawing outside it
  // (draw invisible area around the cliff with stage bg color)
  // Simpler: clip by overdrawing the top ellipse area in surface layer — cliff is behind it
}
```

- [ ] **Step 4: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/rendering/IsoDioramaRenderer.ts
git commit -m "feat(diorama): cliff layer — geological stripes, shadow/highlight, gas bands"
```

---

### Task 7: Surface layer — terrain from grid data + gas planet bands

**Files:**
- Modify: `src/rendering/IsoDioramaRenderer.ts` — fill `_drawSurface()` and `_animateGasBands()`

**Background:** The surface layer covers the top ellipse with terrain colors sampled from the 256×256 grid. Each sample point within the ellipse is mapped to a UV coordinate, grid cell is looked up, and a small colored rectangle is drawn. Sampling at every 3 pixels is a good balance between detail and performance. Gas planets skip the grid entirely and draw animated horizontal gas bands.

- [ ] **Step 1: Implement `_drawSurface()`**

Replace the stub:

```typescript
private _drawSurface(): void {
  const g = this.surfaceLayer;
  g.clear();
  const { cx, cy, rx, ry } = this;

  if (this.planetType === 'gas') {
    this._drawGasSurface(g);
    return;
  }

  if (!this.grid) return;

  const step = 3; // pixels per sample — tune for performance vs. detail
  for (let py = cy - ry; py <= cy + ry; py += step) {
    for (let px = cx - rx; px <= cx + rx; px += step) {
      if (!this._inTopEllipse(px, py)) continue;

      // Map screen pixel to grid UV
      const u = (px - (cx - rx)) / (rx * 2);
      const v = (py - (cy - ry)) / (ry * 2);
      const col = Math.min(GRID_SIZE - 1, Math.round(u * (GRID_SIZE - 1)));
      const row = Math.min(GRID_SIZE - 1, Math.round(v * (GRID_SIZE - 1)));
      const cell = this.grid[row]?.[col];
      if (!cell) continue;

      const [r, gr, b] = BIOME_COLORS[cell.biome];
      const hexColor   = (r << 16) | (gr << 8) | b;

      // Slight elevation tint — lighter at high elevation, darker at deep ocean
      const elvAlpha = cell.elevation > 0.75 ? 1.1 : 1.0;
      void elvAlpha;

      g.rect(px, py, step, step).fill({ color: hexColor });
    }
  }

  // Coastline highlight — draw white 1px line where shallow meets beach
  this._drawCoastline(g);
}
```

- [ ] **Step 2: Add `_drawCoastline()` helper**

```typescript
private _drawCoastline(g: Graphics): void {
  if (!this.grid || this.planetType !== 'ocean') return;
  const { cx, cy, rx, ry } = this;
  const step = 3;
  for (let py = cy - ry; py <= cy + ry; py += step) {
    for (let px = cx - rx; px <= cx + rx; px += step) {
      if (!this._inTopEllipse(px, py)) continue;
      const u = (px - (cx - rx)) / (rx * 2);
      const v = (py - (cy - ry)) / (ry * 2);
      const col = Math.min(GRID_SIZE - 1, Math.round(u * (GRID_SIZE - 1)));
      const row = Math.min(GRID_SIZE - 1, Math.round(v * (GRID_SIZE - 1)));
      const cell = this.grid[row]?.[col];
      if (cell?.biome === 'beach') {
        g.rect(px, py, step, step).fill({ color: 0xffffff, alpha: 0.25 });
      }
    }
  }
}
```

- [ ] **Step 3: Add `_drawGasSurface()` and `_animateGasBands()`**

```typescript
private _drawGasSurface(g: Graphics): void {
  // Initial draw of gas bands on surface — animated in _animateGasBands
  const { cx, cy, rx, ry } = this;
  const bands = [
    { color: 0xcc9955, height: 0.20 },
    { color: 0x886633, height: 0.15 },
    { color: 0xddaa66, height: 0.18 },
    { color: 0x7755aa, height: 0.20 },
    { color: 0xaa8844, height: 0.15 },
    { color: 0x664422, height: 0.12 },
  ];
  let curV = 0;
  for (const band of bands) {
    const bandH = ry * 2 * band.height;
    const bandY = cy - ry + curV;
    for (let py = Math.round(bandY); py < Math.round(bandY + bandH); py++) {
      for (let px = cx - rx; px <= cx + rx; px++) {
        if (this._inTopEllipse(px, py)) {
          g.rect(px, py, 1, 1).fill({ color: band.color });
        }
      }
    }
    curV += bandH;
  }
}

private _lastGasBandT = 0;

private _animateGasBands(t: number): void {
  if (this.planetType !== 'gas') return;
  // Gas bands drift — redraw surface layer with time offset, but only every 3s (expensive)
  if (t - this._lastGasBandT < 3) return;
  this._lastGasBandT = t;
  this._drawSurface();
}
```

**Note:** Gas band animation at full fidelity requires per-pixel redraw — expensive. The `_animateGasBands` stub above triggers a redraw every 3s. For a smoother effect consider drawing at step=6 for gas planets in `_drawGasSurface`.

- [ ] **Step 4: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/rendering/IsoDioramaRenderer.ts
git commit -m "feat(diorama): surface layer — terrain grid sampling, biome colors, gas bands"
```

---

## Chunk 4: Animation Overlays — Ocean, Clouds, City, Lava, Bottom

### Task 8: Ocean shimmer + cloud layer animations

**Files:**
- Modify: `src/rendering/IsoDioramaRenderer.ts` — fill `_drawOceanShimmer()` and `_drawClouds()`

- [ ] **Step 1: Implement `_drawOceanShimmer()`**

Replace the stub:

```typescript
private _drawOceanShimmer(t: number): void {
  const g = this.oceanLayer;
  g.clear();
  if (this.planetType === 'lava' || this.planetType === 'gas' || this.planetType === 'ice') return;
  if (!this.grid) return;

  const { cx, cy, rx, ry } = this;
  const step = 6; // coarser than surface for perf

  for (let py = cy - ry; py <= cy + ry; py += step) {
    for (let px = cx - rx; px <= cx + rx; px += step) {
      if (!this._inTopEllipse(px, py)) continue;
      const u = (px - (cx - rx)) / (rx * 2);
      const v = (py - (cy - ry)) / (ry * 2);
      const col = Math.min(GRID_SIZE - 1, Math.round(u * (GRID_SIZE - 1)));
      const row = Math.min(GRID_SIZE - 1, Math.round(v * (GRID_SIZE - 1)));
      const cell = this.grid[row]?.[col];
      if (!cell || !isWater(cell.biome)) continue;

      const alpha = 0.6 + 0.2 * Math.sin(t * 0.05 + px * 0.1);
      g.rect(px, py, step, step).fill({ color: 0x88ccff, alpha: alpha * 0.18 });
    }
  }
}
```

- [ ] **Step 2: Implement `_drawClouds()`**

Replace the stub:

```typescript
private _drawClouds(): void {
  const g = this.cloudLayer;
  g.clear();
  if (this.planetType === 'lava' || this.planetType === 'gas') return;

  const { cx, cy, rx, ry } = this;

  for (const cloud of this.clouds) {
    // Only draw if cloud center is within/near the top ellipse
    if (!this._inTopEllipse(cloud.x, cloud.y) &&
        !this._inTopEllipse(cloud.x - cloud.rx, cloud.y) &&
        !this._inTopEllipse(cloud.x + cloud.rx, cloud.y)) continue;

    // Draw cloud as soft filled ellipse — clipped by only drawing pixels inside top ellipse
    // Use a fast rectangular draw approach clipped to ellipse
    for (let dy = -cloud.ry; dy <= cloud.ry; dy++) {
      const cloudRowW = cloud.rx * Math.sqrt(Math.max(0, 1 - (dy / cloud.ry) ** 2));
      for (let dx = -cloudRowW; dx <= cloudRowW; dx++) {
        const px = Math.round(cloud.x + dx);
        const py = Math.round(cloud.y + dy);
        if (!this._inTopEllipse(px, py)) continue;
        const distFrac = Math.sqrt((dx / cloud.rx) ** 2 + (dy / cloud.ry) ** 2);
        const a = cloud.alpha * (1 - distFrac) * 0.7;
        if (a < 0.05) continue;
        g.rect(px, py, 1, 1).fill({ color: 0xffffff, alpha: a });
      }
    }
    void cx; void cy; void rx; void ry;
  }
}
```

**Note:** The cloud draw loop above is pixel-by-pixel — visually accurate but may be slow for large clouds. If performance is poor during integration testing, increase the inner `dx` step to 2 and `dy` step to 2.

- [ ] **Step 3: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/rendering/IsoDioramaRenderer.ts
git commit -m "feat(diorama): ocean shimmer and cloud drift animations"
```

---

### Task 9: City lights layer

**Files:**
- Modify: `src/rendering/IsoDioramaRenderer.ts` — fill `_drawCityLights()`

- [ ] **Step 1: Implement `_drawCityLights()`**

Replace the stub:

```typescript
private _drawCityLights(): void {
  const g = this.cityLayer;
  g.clear();
  for (const dot of this.cityDots) {
    if (!dot.visible) continue;
    // 1×1 bright warm-white pixel; occasionally 2×2 for brighter city centers
    g.rect(dot.x, dot.y, 1, 1).fill({ color: 0xffeeaa, alpha: 0.9 });
  }
}
```

- [ ] **Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/rendering/IsoDioramaRenderer.ts
git commit -m "feat(diorama): city lights layer with seeded blink animation"
```

---

### Task 10: Bottom formations + lava effects

**Files:**
- Modify: `src/rendering/IsoDioramaRenderer.ts` — fill `_drawBottomFormations()` and `_animateLavaEffects()`

**Background:** The bottom layer renders jagged rocky shapes below the disc's bottom ellipse. Each planet type has a distinct geometry. Lava adds animated glowing drips. Ice adds downward icicle spires.

- [ ] **Step 1: Implement `_drawBottomFormations()`**

Replace the stub:

```typescript
private _drawBottomFormations(): void {
  const g = this.bottomLayer;
  g.clear();
  const { cx, cy, rx, ry, wallH } = this;
  const palette = PALETTES[this.planetType];

  const baseY = cy + wallH + ry; // bottom of the disc
  const seed  = this.planet ? this.planet.id * 2187 : 42;

  // Generate spike positions from seed
  const spikes: Array<{ x: number; h: number; w: number }> = [];
  const numSpikes = 14;
  for (let i = 0; i < numSpikes; i++) {
    const t   = i / numSpikes;
    const h1  = ((seed * (i + 1) * 48271) >>> 0) / 0xffffffff;
    const h2  = ((seed * (i + 1) * 16807) >>> 0) / 0xffffffff;
    // Distribute spikes along the bottom ellipse perimeter
    const angle  = t * Math.PI; // 0 to π (left to right along bottom)
    const spX    = cx + Math.round(rx * 0.85 * Math.cos(Math.PI - angle));
    const spH    = Math.round((30 + h1 * 60) * (1 - Math.abs(t - 0.5) * 0.5));
    const spW    = Math.round(8 + h2 * 16);
    spikes.push({ x: spX, h: spH, w: spW });
  }

  for (const sp of spikes) {
    if (this.planetType === 'ice') {
      // Icicle: thin tapered spike, blue-white
      g.moveTo(sp.x - sp.w / 3, baseY)
       .lineTo(sp.x, baseY + sp.h)
       .lineTo(sp.x + sp.w / 3, baseY)
       .fill({ color: 0xaaddff });
      // Inner highlight
      g.moveTo(sp.x - 1, baseY)
       .lineTo(sp.x, baseY + sp.h * 0.7)
       .lineTo(sp.x + 1, baseY)
       .fill({ color: 0xffffff, alpha: 0.5 });
    } else if (this.planetType === 'lava') {
      // Lava stalactite: dark basalt with glowing core
      g.moveTo(sp.x - sp.w / 2, baseY)
       .lineTo(sp.x, baseY + sp.h)
       .lineTo(sp.x + sp.w / 2, baseY)
       .fill({ color: 0x1a0800 });
      // Store drip positions for animation
    } else if (this.planetType === 'gas') {
      // Gas: wispy vertical gradients
      for (let dy = 0; dy < sp.h; dy++) {
        const a = (1 - dy / sp.h) * 0.4;
        g.rect(sp.x - 2, baseY + dy, 4, 1).fill({ color: palette.atmosColor, alpha: a });
      }
    } else {
      // Rocky/ocean: stone spires
      g.moveTo(sp.x - sp.w / 2, baseY)
       .lineTo(sp.x, baseY + sp.h)
       .lineTo(sp.x + sp.w / 2, baseY)
       .fill({ color: palette.bottomColor });
      // Dark shadow on left face
      g.moveTo(sp.x - sp.w / 2, baseY)
       .lineTo(sp.x, baseY + sp.h)
       .lineTo(sp.x, baseY)
       .fill({ color: 0x000000, alpha: 0.3 });
    }
  }

  // Initialize lava drips for animation
  if (this.planetType === 'lava') {
    this.lavaDrops = spikes.slice(0, 6).map((sp, i) => ({
      x:    sp.x,
      y:    baseY,
      vy:   1.5 + i * 0.3,
      maxY: baseY + sp.h * 0.6,
    }));
  }
}
```

- [ ] **Step 2: Implement `_animateLavaEffects()`**

Replace the stub:

```typescript
private _animateLavaEffects(t: number): void {
  if (this.planetType !== 'lava') return;

  // Animate cliff lava veins (pulse glow on cliffLayer — redraw cliff partially)
  // Strategy: draw lava vein overlays on top of the cliff
  const g = this.cliffLayer;
  const { cx, cy, rx, ry, wallH } = this;

  // Vein glow pulses — draw horizontal glowing lines in the lava stripe area
  const stripeH = wallH / 4;
  const veinY   = cy + stripeH * 2; // lava vein stripe is stripe index 2
  for (let i = 0; i < 4; i++) {
    const alpha = 0.4 + 0.3 * Math.sin(t * 0.08 + i * 0.7);
    const vx    = cx - rx * 0.7 + i * rx * 0.45;
    g.rect(Math.round(vx), Math.round(veinY), 3, Math.round(stripeH))
     .fill({ color: 0xff4400, alpha });
  }

  // Lava drips — animate on bottomLayer (clear first to avoid unbounded accumulation)
  const bg = this.bottomLayer;
  bg.clear();
  // Re-draw static bottom formations before drips
  this._drawBottomFormations();
  const baseY = cy + wallH + ry;
  for (const drop of this.lavaDrops) {
    drop.y += drop.vy;
    if (drop.y > drop.maxY) drop.y = baseY; // reset to disc bottom
    bg.circle(drop.x, Math.round(drop.y), 2).fill({ color: 0xff6600, alpha: 0.8 });
    // Glow
    bg.circle(drop.x, Math.round(drop.y), 4).fill({ color: 0xff3300, alpha: 0.2 });
  }
}
```

- [ ] **Step 3: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/rendering/IsoDioramaRenderer.ts
git commit -m "feat(diorama): bottom formations (stone/icicle/lava/gas) + lava drip animation"
```

---

## Chunk 5: Integration — Wire into index.html and main.ts

### Task 11: Update index.html

**Files:**
- Modify: `index.html`

**Background:** The current `#planet-overlay-body` contains `<canvas id="planet-canvas">`. We keep that canvas for NPC planet views (star-info-panel). We add `<div id="diorama-mount">` as a sibling, shown/hidden based on whether we're viewing the player's own planet. Note: `#bio-toggle-btn` does not exist as an HTML element (CSS only) — no action needed.

- [ ] **Step 1: Add diorama-mount div**

Find in `index.html` (around line 2520):
```html
<!-- BEFORE -->
  <div id="planet-overlay-body">
    <canvas id="planet-canvas"></canvas>
```

```html
<!-- AFTER -->
  <div id="planet-overlay-body">
    <canvas id="planet-canvas" style="display:none;"></canvas>
    <div id="diorama-mount" style="flex:1;min-width:0;position:relative;display:none;"></div>
```

Both start hidden — `openPlanetView()` will show the correct one.

- [ ] **Step 2: Add CSS for diorama-mount**

Find the `#planet-canvas` rule in `index.html` CSS (around line 1722):
```css
/* BEFORE */
#planet-canvas{display:block;flex:1;min-width:0;}
```

```css
/* AFTER */
#planet-canvas{display:block;flex:1;min-width:0;}
#diorama-mount{flex:1;min-width:0;overflow:hidden;}
```

- [ ] **Step 3: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors (HTML change has no TS impact).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(diorama): add #diorama-mount to planet overlay, hide #planet-canvas by default"
```

---

### Task 12: Wire IsoDioramaRenderer into main.ts

**Files:**
- Modify: `src/main.ts`

**Background:** `openPlanetView()` currently creates a new `PlanetRenderer` on every open. We replace this with `IsoDioramaRenderer` for the player's own star (lazy-init, never recreated). NPC planet views continue to use `PlanetRenderer` with `#planet-canvas`.

- [ ] **Step 1: Add import and module-level variable**

Near line 2 of `src/main.ts` (after existing imports):
```typescript
import { IsoDioramaRenderer } from './rendering/IsoDioramaRenderer';
```

Near line 30 (after `let planetRenderer: PlanetRenderer | null = null;`):
```typescript
let _dioramaRenderer: IsoDioramaRenderer | null = null;
```

- [ ] **Step 2: Update `openPlanetView()` — player planet path**

Find the section in `openPlanetView()` (around lines 776–809) that creates and starts the PlanetRenderer. Replace for the player planet branch:

```typescript
// ── AFTER: overlay is visible, canvas/mount sized ──────────────

const isPlayerPlanet = target.isPlayerStar;
const diMount = document.getElementById('diorama-mount') as HTMLDivElement;
const pCanvas = document.getElementById('planet-canvas') as HTMLCanvasElement;

if (isPlayerPlanet) {
  // Show diorama, hide old canvas
  diMount.style.display = 'block';
  pCanvas.style.display  = 'none';

  // Lazy-init once
  if (!_dioramaRenderer) {
    _dioramaRenderer = new IsoDioramaRenderer();
    await _dioramaRenderer.init(diMount);
  }

  if (runtimeState.playerPlanetGrid) {
    _dioramaRenderer.refreshData(
      runtimeState.playerPlanetGrid,
      gameState.playerBiosphere,
      gameState.playerSpecies,
      planet,
    );
  }
  _dioramaRenderer.resume();

} else {
  // NPC planet — use existing PlanetRenderer + planet-canvas
  diMount.style.display = 'none';
  pCanvas.style.display  = 'block';
  pCanvas.width  = Math.max(400, window.innerWidth - PANEL_W);
  pCanvas.height = window.innerHeight - 56;

  planetRenderer?.stop();
  planetRenderer = new PlanetRenderer(pCanvas);
  planetRenderer.init(target, planetIndex);

  // Apply war state
  if (engine && target) {
    const warStateRaw = engine.getPlayerWarState();
    if (warStateRaw && (warStateRaw.defender.id === target.id || warStateRaw.attacker.id === target.id)) {
      const { war, attacker } = warStateRaw;
      planetRenderer.warState = {
        warId: war.id,
        attackerName: attacker.civName,
        attackerColor: CIV_COLORS[attacker.civLevel] ?? '#ff4444',
        phase: war.phase,
        attackerStrength: war.attackerStrength,
        defenderStrength: war.defenderStrength,
      };
    }
  }
  planetRenderer.start();
  planetRenderer.bioOverlayVisible = false;
  planetRenderer.bioData = null;
}
```

**Important:** `openPlanetView` must now be `async` if it isn't already (because of `await _dioramaRenderer.init()`). Check its signature and add `async` if needed.

- [ ] **Step 3: Update `closePlanetView()`**

Find `closePlanetView()` (around line 1316):
```typescript
// BEFORE
function closePlanetView(): void {
  document.getElementById('planet-overlay')!.style.display = 'none';
  planetRenderer?.stop();
}

// AFTER
function closePlanetView(): void {
  document.getElementById('planet-overlay')!.style.display = 'none';
  planetRenderer?.stop();
  _dioramaRenderer?.pause();
}
```

- [ ] **Step 4: Update the panel expand/collapse canvas resize handler**

Find the expand button handler (around line 1044):
```typescript
// BEFORE
const canvas = document.getElementById('planet-canvas') as HTMLCanvasElement;
canvas.width = Math.max(400, window.innerWidth - PANEL_W);

// AFTER — only resize planet-canvas when it is visible
const canvas = document.getElementById('planet-canvas') as HTMLCanvasElement;
if (canvas.style.display !== 'none') {
  canvas.width = Math.max(400, window.innerWidth - PANEL_W);
}
// Note: diorama canvas fills via CSS, no resize needed
```

- [ ] **Step 5: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors. Fix any type errors before proceeding.

- [ ] **Step 6: Open browser and verify basic rendering**

Start the dev server (`npm run dev`), load the game, start a new universe, wait for game HUD, click "VIEW MY WORLD". Expected:
- Planet overlay opens
- Diorama canvas is visible (not blank)
- Starfield background visible
- Disc shape visible (cliff + surface)
- No console errors

- [ ] **Step 7: Verify NPC planet view still works**

Click any NPC star → "VIEW SURFACE" (if available). Expected: old PlanetRenderer still renders correctly for NPC planets.

- [ ] **Step 8: Commit**

```bash
git add src/main.ts
git commit -m "feat(diorama): wire IsoDioramaRenderer into openPlanetView for player planet"
```

---

## Chunk 6: Per-Type Visual Pass & Exit Criteria Verification

### Task 13: Visual pass — all 5 planet types

**Files:**
- Modify: `src/rendering/IsoDioramaRenderer.ts` — palette and geometry tuning as needed

**Background:** Load the game with different planet types and verify each type looks correct. The player's starting planet type is set by universe DNA — use the `continue` button with existing saves that have different types, or temporarily force `planetType` in `refreshData()` for each test.

- [ ] **Step 1: Test ocean planet**

Visually verify:
- Blue ocean surface with green landmasses and sandy coastlines visible
- Sand/rock/dark cliff stripes visible
- Ocean shimmer animation on water tiles
- 4 clouds drifting across surface
- Atmosphere glow is blue
- Stone spire formations below disc

- [ ] **Step 2: Test rocky planet**

Visually verify:
- Brown/tan desert terrain visible
- Brown/sandstone/granite cliff stripes
- Warm tan atmosphere glow
- Stone spire formations

- [ ] **Step 3: Test lava planet**

Visually verify:
- Black/dark red terrain
- Basalt/magma/lava-vein cliff stripes with animated orange glow pulses
- Orange-red atmosphere glow
- Glowing lava drips animating on bottom formations
- No clouds

- [ ] **Step 4: Test ice planet**

Visually verify:
- White/pale blue glacier terrain
- Permafrost/ice-rock cliff stripes
- Cyan atmosphere glow
- Icicle spires below disc
- Clouds present

- [ ] **Step 5: Test gas planet**

Visually verify:
- Swirling horizontal band pattern for surface (no terrain grid sampling)
- Gas band layers in cliff area (no geological stripes)
- Purple-tan atmosphere glow
- Gas tendril formations below disc
- No clouds

- [ ] **Step 6: Test city lights**

In a game where the player's civilization has reached Ancient tier (`civLevel >= 1`), open the planet overlay and verify small yellow/white dots blink on the surface.

- [ ] **Step 7: Final TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Final commit**

```bash
git add src/rendering/IsoDioramaRenderer.ts
git commit -m "feat(diorama): M19 complete — pixel-art isometric planet diorama, all 5 planet types"
```

---

## Exit Criteria Checklist

- [ ] Clicking "VIEW MY WORLD" shows the diorama (not the old PlanetRenderer canvas)
- [ ] All 5 planet types render with correct palette, cliff stripes, bottom formations, and atmosphere glow
- [ ] Ocean shimmer, cloud drift, lava glow, city lights, and star twinkle all animate
- [ ] City lights appear only when the player's civilization has settled tiles (`civId` present)
- [ ] 256×256 grid generates correctly; no regression in life spread or biosphere systems
- [ ] `npx tsc --noEmit` passes clean
- [ ] NPC planet view (star-info-panel) still uses old PlanetRenderer unaffected

---

## Known Limitations & Notes for M20

- BIO toggle and `BiosphereRenderer` overlay deferred — button hidden in M19
- Interactive tile clicks (inspect / divine action per tile) deferred to M20
- Subterranean layer deferred to M20+
- Gas band animation is currently on a 3s redraw cycle — M20 can improve with a dedicated Graphics layer driven per-frame at coarser resolution
- Cloud pixel-by-pixel loop may be slow for large cloud patches — profile in browser and increase step size if needed
- `_animateStars()` redraws bgLayer every 2s — this is intentional to avoid per-frame full redraws
- Alien and mechanical planet type reserved slots exist in `PALETTES` (not declared) — add when planet types ship
