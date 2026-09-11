# Surface Decals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp trees, scrub, cacti and rock onto the habitable diorama's surface, placed from simulation data, so the player's world visibly greens as life advances.

**Architecture:** A new pure module `src/rendering/SurfaceDecals.ts` plans decal sites from the existing bake options plus the biosphere, mirroring the established `planVolcanoChimneys` pattern. The bake stamps them into the `ImageData` the surface painter already builds — no extra canvas, no extra composite, zero per-frame cost. A hard-capped subset is drawn live for sway.

**Tech Stack:** TypeScript, Vite, Canvas 2D `ImageData`. No test framework in this repo: checks are standalone scripts under `tools/`, bundled with esbuild and run under Node, exiting non-zero on failure. Python 3 with Pillow is available for asset work.

**Spec:** `docs/superpowers/specs/2026-09-11-surface-decals-design.md`

## Global Constraints

- **Home world only.** Do not add a second data source for colonised or probed planets.
- **Decal art stores shape and a shading mask, never colour.** Colour is derived from the terrain pixel at stamp time.
- **The animated cap is a COUNT, not a fraction.** Default 32.
- **The placement budget is a target COUNT, not a per-cell probability.**
- **Decal seed is `planet.genomeSeed`.** Never `planet.type` (terraforming mutates it), never the bake seed (per-render).
- **Snow line for decals is `elevation > 0.78`,** mirroring `paintCutawaySurface`'s local reclassification at `> 0.82` (`HabitableCutawayEngine.ts:817-820`). If either constant moves, both move.
- **Baked decals must add zero per-frame cost.** Only bake time may rise.
- **Tools live in `tools/`, never `src/`** — `tsconfig.json` has `include: ["src/**/*"]` and `npm run build` runs `tsc` first, so Node-only scripts under `src/` break the production build.
- **Known-red baseline, do not "fix":** `tools/smokeTest.ts` fails exactly 3 assertions (habitability, wars fired, newborn stars); `tsc --noEmit` reports exactly 2 pre-existing `TS2322 Float32Array` errors in `HabitableCutawayEngine.ts`. The gate is no NEW failures.

---

### Task 1: Does `lifeDensity` actually move in a real run?

The spec names this a prerequisite, not a risk. `lifeDensity` is written in several places and read by the surface painter, but this project has shipped a rate constant sized for the wrong cadence before (`stepLifeSpread` ran once per 2000 ticks with per-tick coefficients, and life never spread). If `lifeDensity` is near-zero during real play, the readout collapses to `fertility * lush` and Task 3's weighting must change. Find out before building on it.

**Files:**
- Create: `tools/lifeDensityCensus.ts`

**Interfaces:**
- Consumes: the DOM stub and engine-driving pattern from `tools/engineSim.ts:14-95`. The real API is `new BigBangEngine(canvas)` then `engine.init(stats, seed)` — NOT an options object — and the player's grid is `runtimeState.playerPlanetGrid` from `src/simulation/GameState.ts:167`, not a field on the planet.
- Produces: a printed census. No exported symbols.

- [ ] **Step 1: Write the census tool**

```ts
/**
 * Does `GridCell.lifeDensity` actually move during real play, or is it another
 * declared-but-unwritten field? Decal density is planned to key off it.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/lifeDensityCensus.ts --bundle --platform=node \
 *     --format=esm --outfile=%TEMP%/life.mjs && node %TEMP%/life.mjs 400000
 */
const TICKS = Number(process.argv[2]) || 400_000;

// Minimal DOM stub, installed BEFORE the engine module is imported. This
// mirrors tools/engineSim.ts — copy its stub verbatim rather than inventing a
// smaller one; the engine touches more of the DOM than you expect.
const noopCtx = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'canvas') return { width: 1200, height: 800 };
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
      return () => ({ addColorStop() {} });
    }
    if (prop === 'getImageData' || prop === 'createImageData') {
      return (...a: number[]) => {
        const w = a.length > 2 ? a[2] : a[0], h = a.length > 2 ? a[3] : a[1];
        return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
      };
    }
    if (prop === 'measureText') return () => ({ width: 10 });
    return () => undefined;
  },
  set() { return true; },
});
function makeCanvas(): any {
  return {
    width: 1200, height: 800, style: {},
    getContext: () => noopCtx,
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
    toDataURL: () => '',
  };
}
const g = globalThis as any;
g.document = {
  createElement: () => makeCanvas(), getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
};
g.window = g;
g.requestAnimationFrame = () => 0;
g.cancelAnimationFrame = () => {};
g.addEventListener = () => {};
g.performance = g.performance ?? { now: () => Date.now() };
g.Image = class { set src(_v: string) {} };
g.eternalSpeed = 1;

const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState, runtimeState } = await import('../src/simulation/GameState');

gameState.playerPlanetName = 'Census';
gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
gameState.playerSpecies = [];

const engine: any = new BigBangEngine(makeCanvas());
engine.init({ life: 14, evolution: 12, hostility: 9, entropy: 10, divine: 12 }, 'census_seed');
engine.onCivEvent = () => {};
engine.onLifeEvent = () => {};
g.eternalSpeed = 60;
for (let i = 0; i < TICKS; i++) engine.update(1 / 60);

const grid = runtimeState.playerPlanetGrid;
if (!grid) { console.error('FAIL: runtimeState.playerPlanetGrid is null'); process.exit(1); }

let land = 0, withLife = 0, sum = 0, max = 0;
const buckets = new Array(10).fill(0);
for (const row of grid) {
  for (const cell of row) {
    if ((cell.fertility ?? 0) <= 0) continue;
    land++;
    const v = cell.lifeDensity ?? 0;
    sum += v; max = Math.max(max, v);
    if (v > 0.02) withLife++;
    buckets[Math.min(9, Math.floor(v * 10))]++;
  }
}
console.log(`
  ticks ${TICKS}  fertile cells ${land}`);
console.log(`  cells with lifeDensity > 0.02 : ${withLife} (${(withLife / Math.max(1, land) * 100).toFixed(1)}%)`);
console.log(`  mean ${(sum / Math.max(1, land)).toFixed(3)}   max ${max.toFixed(3)}`);
console.log('  histogram (0.0-1.0):', buckets.join(' '));

// The decal readout needs SOME spread, not one value everywhere.
const ok = withLife / Math.max(1, land) > 0.05 && max > 0.15;
console.log(ok
  ? '
  USABLE — lifeDensity varies across the grid; keep it as a decal driver.'
  : '
  NOT USABLE — lifeDensity is flat/zero in practice. Task 3 must drop it '
    + 'and weight on fertility * lush alone. Record this in the plan before continuing.');
process.exit(0);
```

- [ ] **Step 2: Run it**

```bash
node_modules/.bin/esbuild tools/lifeDensityCensus.ts --bundle --platform=node --format=esm --outfile=$TEMP/life.mjs && node $TEMP/life.mjs 400000
```

Expected: a census. Either verdict is a valid outcome — this task's deliverable is the ANSWER, not a green light.

- [ ] **Step 3: Record the answer in the spec**

Append the measured numbers to the Risks section of `docs/superpowers/specs/2026-09-11-surface-decals-design.md`, replacing the "not yet established" wording with what was measured. If the verdict is NOT USABLE, also edit Task 3 Step 3 below: drop the `lifeDensity` term from `life` and use `fertility * lush` scaled to the same range.

- [ ] **Step 4: Commit**

```bash
git add tools/lifeDensityCensus.ts docs/superpowers/specs/2026-09-11-surface-decals-design.md
git commit -m "test(life): census lifeDensity across a real run before decals depend on it"
```

---

### Task 2: The clumping metric, and a control that proves it works

Write the metric BEFORE the thing it measures, and prove it fails on a deliberately even placement. "It looks clumped" is exactly the class of claim that has passed on the wrong measurement in this codebase three times (land area vs land shape; hue angle vs colour family; ocean-only rendering of a lava bug).

**Files:**
- Create: `tools/surfaceDecalCheck.ts`

**Interfaces:**
- Consumes: nothing yet — this task's metric runs on synthetic point sets.
- Produces: `export interface Pt { x: number; y: number }` and `export function clumpiness(pts: Pt[]): number`, used by this tool only. Later tasks extend this same file.

- [ ] **Step 1: Write the metric and both controls**

```ts
/**
 * Do surface decals cluster into groves and clearings, or scatter evenly?
 *
 * The metric is nearest-neighbour distance dispersion: for each point, the
 * distance to its closest neighbour; clumpiness is the coefficient of variation
 * (stdev / mean) of those distances. An even lattice has near-zero dispersion;
 * clustered points have high dispersion because within-grove neighbours are
 * close and isolated points are far.
 *
 * Two controls run first and MUST both behave as stated, or the metric is
 * wrong and nothing downstream can be trusted:
 *   even   — a jittered lattice, must score LOW
 *   clumpy — gaussian blobs, must score HIGH
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/surfaceDecalCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=%TEMP%/decal.mjs && node %TEMP%/decal.mjs
 */
export interface Pt { x: number; y: number; }

export function clumpiness(pts: Pt[]): number {
  if (pts.length < 8) return 0;
  const nn: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    let best = Infinity;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
    nn.push(Math.sqrt(best));
  }
  const mean = nn.reduce((a, b) => a + b, 0) / nn.length;
  if (mean <= 0) return 0;
  const varr = nn.reduce((a, b) => a + (b - mean) * (b - mean), 0) / nn.length;
  return Math.sqrt(varr) / mean;
}

let failed = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
  if (!ok) failed++;
}

// Deterministic PRNG so the controls do not flake.
let s = 12345;
const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// CONTROL A — jittered lattice: what "even scatter" looks like.
const even: Pt[] = [];
for (let y = 0; y < 20; y++) {
  for (let x = 0; x < 20; x++) {
    even.push({ x: x * 12 + rnd() * 3, y: y * 12 + rnd() * 3 });
  }
}
// CONTROL B — gaussian blobs: what "groves and clearings" looks like.
const clumpy: Pt[] = [];
for (let g = 0; g < 12; g++) {
  const gx = rnd() * 240, gy = rnd() * 240;
  for (let i = 0; i < 33; i++) {
    const a = rnd() * Math.PI * 2, r = (rnd() + rnd() + rnd()) * 5;
    clumpy.push({ x: gx + Math.cos(a) * r, y: gy + Math.sin(a) * r });
  }
}

const CLUMP_MIN = 0.45;
const cEven = clumpiness(even), cClump = clumpiness(clumpy);
console.log(`\n  clumpiness: even ${cEven.toFixed(3)}   clumpy ${cClump.toFixed(3)}`
  + `   threshold ${CLUMP_MIN}\n`);
check('control: even scatter scores LOW', cEven < CLUMP_MIN, `${cEven.toFixed(3)} < ${CLUMP_MIN}`);
check('control: clustered scores HIGH', cClump >= CLUMP_MIN, `${cClump.toFixed(3)} >= ${CLUMP_MIN}`);
check('metric separates them', cClump > cEven * 1.8,
      `${cClump.toFixed(3)} > ${(cEven * 1.8).toFixed(3)}`);

console.log(failed === 0 ? '\n  all decal checks passed' : `\n  ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it**

```bash
node_modules/.bin/esbuild tools/surfaceDecalCheck.ts --bundle --platform=node --format=esm --outfile=$TEMP/decal.mjs && node $TEMP/decal.mjs
```

Expected: all three PASS. If `even` scores above the threshold, the metric is wrong — **fix the metric, do not raise the threshold.** A metric that cannot tell a lattice from a blob field cannot tell wallpaper from a forest.

- [ ] **Step 3: Commit**

```bash
git add tools/surfaceDecalCheck.ts
git commit -m "test(decals): clumpiness metric with controls proving it detects even scatter"
```

---

### Task 3: `planSurfaceDecals` — the pure placement function

**Files:**
- Create: `src/rendering/SurfaceDecals.ts`
- Modify: `tools/surfaceDecalCheck.ts` — append placement invariants

**Interfaces:**
- Consumes: `CutawayBakeOpts` (`HabitableCutawayEngine.ts:168`), `PlanetBiosphere` (`src/simulation/SpeciesGenome.ts:51`), `GridCell` fields `biome`, `elevation`, `fertility`, `lifeDensity`.
- Produces:
  - `export type DecalKind = 'conifer' | 'broadleaf' | 'scrub' | 'cactus' | 'rock'`
  - `export interface DecalSite { x: number; y: number; kind: DecalKind; scale: number; row: number; col: number }`
  - `export function planSurfaceDecals(opts: CutawayBakeOpts, lush: number, decalSeed: number, budget?: number): DecalSite[]`
  - `export const DECAL_SNOW_LINE = 0.78`
  - `export const DECAL_BUDGET = 900`

- [ ] **Step 1: Write the failing invariant checks**

Append to `tools/surfaceDecalCheck.ts`, before the final `console.log`/`process.exit`:

```ts
// ─── placement invariants, against the real engine ───────────────────────────
const { generatePlanetGrid, SEA_LEVEL, GRID_SIZE } =
  await import('../src/simulation/PlanetGrid');
const { habitableGeom } = await import('../src/rendering/HabitableCutawayEngine');
const { planSurfaceDecals, DECAL_SNOW_LINE, DECAL_BUDGET } =
  await import('../src/rendering/SurfaceDecals');

const VW = 1200, VH = 800;
const geom: any = habitableGeom(VW, VH);
const grid = generatePlanetGrid('ocean', 7777, null);

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampAbs = (v: number, m: number) => (v < -m ? -m : v > m ? m : v);
const liftOf = (e: number) => (e < SEA_LEVEL ? 0 : e > 0.72 ? 9 : e > 0.58 ? 5 : 2);
const rimFalloff = (r: number) => { const t = clamp01((r - 0.34) / 0.66); return t * t * 0.30; };
function smoothElevation(g2: any, row: number, col: number): number {
  let sum = 0, n = 0;
  for (let dr = -1; dr <= 1; dr++) {
    const r2 = row + dr;
    if (r2 < 0 || r2 >= GRID_SIZE) continue;
    for (let dc = -1; dc <= 1; dc++) {
      const cell = g2[r2]?.[(col + dc + GRID_SIZE) % GRID_SIZE];
      if (!cell) continue;
      const wt = dr === 0 && dc === 0 ? 4 : 1;
      sum += cell.elevation * wt; n += wt;
    }
  }
  return n > 0 ? sum / n : 0;
}
function makeProjection(focusLat: number, focusLon: number) {
  return (dx: number, dy: number): { row: number; col: number } | null => {
    const r = Math.hypot(dx, dy);
    if (r > 1) return null;
    const c = r * (Math.PI / 2);
    const sinC = Math.sin(c), cosC = Math.cos(c);
    const sinF = Math.sin(focusLat), cosF = Math.cos(focusLat);
    const ny = -dy;
    const lat = r < 1e-6 ? focusLat
      : Math.asin(clampAbs(cosC * sinF + (ny * sinC * cosF) / r, 1));
    const lon = focusLon + Math.atan2(dx * sinC, r * cosF * cosC - ny * sinF * sinC);
    const v = 0.5 - lat / Math.PI;
    const u = ((lon / (Math.PI * 2)) % 1 + 1) % 1;
    return {
      row: Math.max(0, Math.min(GRID_SIZE - 1, Math.round(v * (GRID_SIZE - 1)))),
      col: Math.min(GRID_SIZE - 1, Math.floor(u * GRID_SIZE)),
    };
  };
}
const opts: any = {
  w: VW, h: VH, cx: geom.cx, cyTop: geom.cyTop, cyBody: geom.cyBody,
  R: geom.R, rx: geom.rx, ry: geom.ry, wall: geom.wall,
  seed: 0xbeef, grid, planetType: 'ocean',
  discToGrid: makeProjection(0.2, 1.1), rimFalloff, liftOf, smoothElevation,
  maxLift: 9,
};

const dead = planSurfaceDecals(opts, 0.04, 0xC0FFEE);
const mid  = planSurfaceDecals(opts, 0.45, 0xC0FFEE);
const lush = planSurfaceDecals(opts, 0.92, 0xC0FFEE);
console.log(`\n  sites: dead ${dead.length}  mid ${mid.length}  lush ${lush.length}\n`);

check('dead world has no decals', dead.length === 0, `${dead.length}`);
check('readout is monotonic', mid.length > 0 && lush.length > mid.length,
      `${dead.length} < ${mid.length} < ${lush.length}`);

const woody = (a: any[]) =>
  a.filter(s => s.kind === 'conifer' || s.kind === 'broadleaf').length / Math.max(1, a.length);
check('ground cover precedes woodland', woody(mid) < 0.15, `mid woody ${woody(mid).toFixed(2)}`);
check('woodland dominates a lush world', woody(lush) > 0.50, `lush woody ${woody(lush).toFixed(2)}`);

let offFace = 0, aboveSnow = 0, inWater = 0;
for (const s of lush) {
  const dx = (s.x - geom.cx) / geom.rx, dy = (s.y - geom.cyTop) / geom.ry;
  if (Math.hypot(dx, dy) > 1) offFace++;
  const cell = grid[s.row]?.[s.col];
  if (!cell) continue;
  if (cell.elevation > DECAL_SNOW_LINE) aboveSnow++;
  if (cell.elevation < SEA_LEVEL) inWater++;
}
check('no decals off the face', offFace === 0, `${offFace}`);
check('no decals above the snow line', aboveSnow === 0, `${aboveSnow}`);
check('no decals on water cells', inWater === 0, `${inWater}`);
check('budget is respected', lush.length <= DECAL_BUDGET, `${lush.length} <= ${DECAL_BUDGET}`);

const again = planSurfaceDecals(opts, 0.92, 0xC0FFEE);
check('placement is deterministic', JSON.stringify(again) === JSON.stringify(lush),
      `${again.length} vs ${lush.length}`);
const other = planSurfaceDecals(opts, 0.92, 0xBADF00D);
check('a different genome is a different forest',
      JSON.stringify(other) !== JSON.stringify(lush), `${other.length} sites`);

const cl = clumpiness(lush.map(s => ({ x: s.x, y: s.y })));
check('real placement clumps', cl >= CLUMP_MIN, `${cl.toFixed(3)} >= ${CLUMP_MIN}`);
```

- [ ] **Step 2: Run it — expect failure**

```bash
node_modules/.bin/esbuild tools/surfaceDecalCheck.ts --bundle --platform=node --format=esm --outfile=$TEMP/decal.mjs && node $TEMP/decal.mjs
```

Expected: the build fails to resolve `../src/rendering/SurfaceDecals`. That is the failing state.

- [ ] **Step 3: Write the module**

Create `src/rendering/SurfaceDecals.ts`:

```ts
/**
 * Surface decals: trees, scrub, cacti and rock stamped onto the diorama's
 * land, placed from simulation data so the surface reads as HOW ALIVE the
 * world is rather than as decoration.
 *
 * Pure. No canvas, no DOM, no time — the same inputs always produce the same
 * forest, which is what lets a save reload into the world the player left.
 * Mirrors `planVolcanoChimneys` in HabitableCutawayEngine.ts, the established
 * pattern for deterministic prop placement.
 */
import type { CutawayBakeOpts } from './HabitableCutawayEngine';
import { isWater } from '../simulation/PlanetGrid';

export type DecalKind = 'conifer' | 'broadleaf' | 'scrub' | 'cactus' | 'rock';

export interface DecalSite {
  /** Screen x, in virtual pixels. */
  x: number;
  /** Screen y, ALREADY raised by the cell's terrace lift. */
  y: number;
  kind: DecalKind;
  /** Size multiplier, larger toward the centre of the face. */
  scale: number;
  row: number;
  col: number;
}

/**
 * Decals stop below this elevation.
 *
 * COUPLED CONSTANT: `paintCutawaySurface` re-classifies `mountain` cells above
 * elevation 0.82 as snow LOCALLY, without touching `cell.biome`
 * (HabitableCutawayEngine.ts:817-820). A planner reading `cell.biome` alone
 * therefore stamps scrub across the white cap. This sits a little below that
 * line so nothing creeps onto snow. If either constant moves, both move.
 */
export const DECAL_SNOW_LINE = 0.78;

/** Target site count at full lushness. A COUNT, not a per-cell probability. */
export const DECAL_BUDGET = 900;

/** Spacing bucket in virtual pixels — see the note on rejection cost below. */
const BUCKET = 11;

function hash1(n: number, seed: number): number {
  let h = (n | 0) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise, bilinear over a coarse lattice. Groves and clearings. */
function vnoise(x: number, y: number, cellPx: number, seed: number): number {
  const fx = x / cellPx, fy = y / cellPx;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const c = (a: number, b: number) => hash1(a * 73856093 + b * 19349663, seed);
  const n00 = c(ix, iy), n10 = c(ix + 1, iy);
  const n01 = c(ix, iy + 1), n11 = c(ix + 1, iy + 1);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sy) + (n01 * (1 - sx) + n11 * sx) * sy;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Plan every decal on the face.
 *
 * `lush` is the planet-wide biosphere term already computed by the host
 * (IsoDioramaRenderer.ts:1109). `decalSeed` must be `planet.genomeSeed` — not
 * the planet type, which terraforming mutates, and not the bake seed, which
 * changes per render.
 */
export function planSurfaceDecals(
  opts: CutawayBakeOpts,
  lush: number,
  decalSeed: number,
  budget = DECAL_BUDGET,
): DecalSite[] {
  const { cx, cyTop, rx, ry, grid } = opts;
  if (!grid) return [];
  const seed = decalSeed | 0;
  const cand: Array<DecalSite & { w: number }> = [];

  for (let py = cyTop - ry; py <= cyTop + ry; py += 2) {
    const dy = (py - cyTop) / ry;
    for (let px = cx - rx; px <= cx + rx; px += 2) {
      const dx = (px - cx) / rx;
      const r = Math.hypot(dx, dy);
      if (r > 0.94) continue;                      // keep decals off the coast rim
      const gp = opts.discToGrid(dx, dy);
      if (!gp) continue;
      const cell = grid[gp.row]?.[gp.col];
      if (!cell) continue;

      const biome = cell.biome as string;
      if (biome === 'volcanic' || biome === 'snow' || biome === 'beach') continue;
      if (isWater(cell.biome)) continue;                  // measured: see below
      if (cell.elevation > DECAL_SNOW_LINE) continue;     // see DECAL_SNOW_LINE
      const fert = cell.fertility ?? 0;
      // NOT `if (fert <= 0) continue` as a water guard. Measured on a real
      // grid: water cells carry fertility > 0 (shallow 4983/4983, ocean
      // 1701/1701), contradicting the field's own doc comment, while EVERY
      // mountain cell has fertility 0 (3309/3309). A fertility guard here
      // would let water through and silently delete the mountain branch below.

      // Carrying capacity. A world with no life has no decals however fertile
      // its rock is — this is what makes the surface a readout.
      // MEASURED (Task 1): on a world that has not passed the microbial phase —
      // per this project's own multi-seed check, the common case — land cells
      // carry lifeDensity EXACTLY 0; only shallow/ocean cells are ever written.
      // So `fert * lush` is what actually drives land placement, and the
      // lifeDensity term enriches the picture later rather than carrying it.
      // The prototype's dead/mid/lush progression was produced with
      // lifeDensity 0 everywhere, so this is the proven path, not a fallback.
      const life = clamp01((cell.lifeDensity ?? 0) * 0.55 + fert * lush * 0.85);
      if (biome !== 'mountain' && life < 0.12) continue;

      // Woodland and ground cover clump on DIFFERENT scales. Sharing one field
      // made scrub carpet wherever trees thinned, the opposite of the intent.
      const grove = vnoise(px, py, 52, seed) * 0.7 + vnoise(px, py, 19, seed ^ 0x9e) * 0.3;
      const sward = vnoise(px, py, 88, seed ^ 0x5bd1) * 0.75
                  + vnoise(px, py, 27, seed ^ 0x31af) * 0.25;
      const canopy = biome === 'forest' || biome === 'jungle';
      if (grove < (canopy ? 0.34 : 0.52) - life * 0.12 && sward < 0.62 - life * 0.10) continue;

      let kind: DecalKind;
      if (biome === 'mountain') {
        // Bare rock: no fertility, and none needed — this is the one kind that
        // is not life. Gate it on lushness only so a dead world still has crags.
        kind = hash1(px * 31 + py, seed) < 0.62 ? 'rock' : 'scrub';
      } else if (fert <= 0) {
        continue;                                        // dead ground, not rock
      } else if (biome === 'desert') {
        if (fert < 0.22) continue;                  // dry land stays visibly dry
        kind = hash1(px * 7 + py, seed) < 0.45 ? 'cactus' : 'rock';
      } else if (biome === 'tundra') {
        kind = hash1(px + py * 17, seed) < 0.30 ? 'conifer' : 'scrub';
      } else if (biome === 'jungle') {
        kind = 'broadleaf';
      } else if (biome === 'forest') {
        kind = hash1(px * 13 + py * 5, seed) < 0.62 ? 'conifer' : 'broadleaf';
      } else {
        kind = hash1(px * 5 + py * 11, seed) < 0.18 + life * 0.22 ? 'conifer' : 'scrub';
      }
      // Ground cover spreads before woodland. This is the evolutionary read and
      // it falls out of the rule rather than being scripted.
      if ((kind === 'conifer' || kind === 'broadleaf') && life < 0.30) kind = 'scrub';

      const woody = kind === 'conifer' || kind === 'broadleaf';
      if (!woody && sward < 0.58 - life * 0.10) continue;

      const lift = opts.liftOf(
        opts.smoothElevation(grid, gp.row, gp.col) - opts.rimFalloff(r));
      cand.push({
        x: px, y: py - lift, kind, scale: 0.75 + (1 - r) * 0.45,
        row: gp.row, col: gp.col,
        w: life * (woody ? grove : sward) * (0.6 + hash1(px * 977 + py * 31, seed) * 0.8),
      });
    }
  }

  // Strongest candidates first, then spacing rejection. A bucket grid, NOT the
  // pairwise `sites.some(...)` that planVolcanoChimneys uses — that is O(n^2)
  // and fine for a dozen cones, quadratic for several hundred decals.
  cand.sort((a, b) => b.w - a.w);
  const taken = new Set<number>();
  const sites: DecalSite[] = [];
  for (const c of cand) {
    if (sites.length >= budget) break;
    const key = ((c.x / BUCKET) | 0) * 4096 + ((c.y / BUCKET) | 0);
    if (taken.has(key)) continue;
    taken.add(key);
    sites.push({ x: c.x, y: c.y, kind: c.kind, scale: c.scale, row: c.row, col: c.col });
  }
  sites.sort((a, b) => a.y - b.y);        // back to front, for correct overlap
  return sites;
}
```

- [ ] **Step 4: Run the check**

```bash
node_modules/.bin/esbuild tools/surfaceDecalCheck.ts --bundle --platform=node --format=esm --outfile=$TEMP/decal.mjs && node $TEMP/decal.mjs
```

Expected: all checks PASS. Reference numbers from the prototype at these inputs: dead 0, mid ~185 (woody ~0.02), lush ~483 (woody ~0.66).

If `real placement clumps` fails, the noise thresholds need work — **do not lower `CLUMP_MIN`.** The controls in Task 2 fix what the number means.

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -v "Float32Array"
```

Expected: no output beyond the two known `Float32Array` errors.

- [ ] **Step 6: Commit**

```bash
git add src/rendering/SurfaceDecals.ts tools/surfaceDecalCheck.ts
git commit -m "feat(decals): deterministic surface decal placement from biosphere data"
```

---

### Task 4: Decal art — shapes and shading masks, no colour

**Files:**
- Create: `tools/genDecalAtlas.py`
- Create: `assets/pixel/decals/decals.png`, `assets/pixel/decals/decals.json` (generated)
- Create: `public/assets/pixel/decals/decals.png`, `public/assets/pixel/decals/decals.json` (mirrored)

**Interfaces:**
- Consumes: `DecalKind` from Task 3 — entry names must match those five strings exactly.
- Produces: an atlas whose JSON manifest is
  `{ "atlas": "decals.png", "cell": 16, "kinds": { "<DecalKind>": { "row": N, "variants": M } } }`,
  and a PNG where each cell is RGBA with **R = shading mask** (0 shadow, 255 lit), **A = coverage**. G and B are unused and written 0. Colour comes from the terrain at stamp time — the atlas never stores hue.

- [ ] **Step 1: Write the generator**

```python
"""Generate the surface-decal atlas.

Cells are 16x16 RGBA. R carries a SHADING MASK (0 = shadow side, 255 = lit
side), A carries coverage. No colour: `stampDecals` derives hue from the
terrain pixel under each decal, which is what keeps decals inside the planet's
palette on every planet type without re-authoring them.

Run:  python tools/genDecalAtlas.py
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "pixel" / "decals"
PUB = ROOT / "public" / "assets" / "pixel" / "decals"
CELL = 16
KINDS = ["conifer", "broadleaf", "scrub", "cactus", "rock"]
VARIANTS = 3


def put(px, x: int, y: int, lit: int, a: int = 255) -> None:
    if 0 <= x < CELL and 0 <= y < CELL:
        px[x, y] = (lit, 0, 0, a)


def conifer(px, ox: int, oy: int, v: int) -> None:
    h = 12 + v
    for i in range(h):
        t = i / h
        half = max(0, int((1 - t) * h * 0.42))
        for dx in range(-half, half + 1):
            put(px, ox + dx, oy - 3 - i, 70 if dx >= 0 else 210)
    for i in range(3):
        put(px, ox, oy - i, 110)


def broadleaf(px, ox: int, oy: int, v: int) -> None:
    import math
    h = 11 + v
    for i in range(h):
        t = i / h
        half = int(math.sin((0.25 + t * 0.75) * math.pi) * h * 0.38)
        for dx in range(-half, half + 1):
            put(px, ox + dx, oy - 3 - i, 70 if dx >= 0 else 210)
    for i in range(3):
        put(px, ox, oy - i, 110)


def scrub(px, ox: int, oy: int, v: int) -> None:
    h = 4 + (v % 2)
    for i in range(h):
        w = max(0, 2 - abs(i - h // 2))
        for dx in range(-w, w + 1):
            put(px, ox + dx, oy - i, 90 if dx >= 0 else 190)


def cactus(px, ox: int, oy: int, v: int) -> None:
    h = 8 + v
    for i in range(h):
        put(px, ox, oy - i, 200 if i % 3 else 120)
        put(px, ox - 1, oy - i, 200)
    arm = int(h * 0.45)
    if v != 1:
        for i in range(3):
            put(px, ox + 1 + i, oy - arm, 150)
    if v != 2:
        for i in range(3):
            put(px, ox - 2 - i, oy - arm + 1, 150)


def rock(px, ox: int, oy: int, v: int) -> None:
    h = 4 + v
    for i in range(h):
        w = max(0, int((1 - i / h) * h * 0.7))
        for dx in range(-w, w + 1):
            put(px, ox + dx, oy - i, 60 if dx >= 0 else 235)


DRAW = {"conifer": conifer, "broadleaf": broadleaf, "scrub": scrub,
        "cactus": cactus, "rock": rock}


def main() -> None:
    img = Image.new("RGBA", (CELL * VARIANTS, CELL * len(KINDS)), (0, 0, 0, 0))
    px = img.load()
    for row, kind in enumerate(KINDS):
        for v in range(VARIANTS):
            # local origin: bottom-centre of the cell
            ox = v * CELL + CELL // 2
            oy = row * CELL + CELL - 2
            sub = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
            spx = sub.load()
            DRAW[kind](spx, CELL // 2, CELL - 2, v)
            img.paste(sub, (v * CELL, row * CELL))
    OUT.mkdir(parents=True, exist_ok=True)
    PUB.mkdir(parents=True, exist_ok=True)
    img.save(OUT / "decals.png")
    manifest = {
        "atlas": "decals.png",
        "cell": CELL,
        "kinds": {k: {"row": i, "variants": VARIANTS} for i, k in enumerate(KINDS)},
    }
    (OUT / "decals.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    shutil.copy(OUT / "decals.png", PUB / "decals.png")
    shutil.copy(OUT / "decals.json", PUB / "decals.json")
    print(f"wrote {img.size[0]}x{img.size[1]} atlas, {len(KINDS)} kinds x {VARIANTS} variants")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Generate and eyeball the atlas**

```bash
python tools/genDecalAtlas.py
```

Expected: `wrote 48x80 atlas, 5 kinds x 3 variants`. Open `assets/pixel/decals/decals.png` — it will look like faint red-on-transparent shapes, which is correct: R is a shading mask, not a colour.

- [ ] **Step 3: Commit**

```bash
git add tools/genDecalAtlas.py assets/pixel/decals public/assets/pixel/decals
git commit -m "feat(decals): shape+shading-mask atlas, colour derived at stamp time"
```

---

### Task 5: `stampDecals` — draw them into the surface bake

**Files:**
- Modify: `src/rendering/SurfaceDecals.ts`
- Modify: `src/rendering/HabitableCutawayEngine.ts:918-920` (end of `paintCutawaySurface`, just before `g.putImageData(img, x0, yTop)`)
- Modify: `tools/surfaceDecalCheck.ts`

**Interfaces:**
- Consumes: `DecalSite[]` from Task 3; the atlas from Task 4.
- Produces:
  - `export interface DecalAtlas { cell: number; rows: Record<DecalKind, number>; variants: number; data: Uint8ClampedArray; width: number; height: number }`
  - `export function stampDecals(d: Uint8ClampedArray, bw: number, bh: number, x0: number, yTop: number, sites: DecalSite[], atlas: DecalAtlas | null): number` — returns how many were drawn.

- [ ] **Step 1: Write the failing stamp checks**

Append to `tools/surfaceDecalCheck.ts` before the final summary:

```ts
const { stampDecals } = await import('../src/rendering/SurfaceDecals');

// A fake land buffer: fully painted, mid-green, so every site has ground.
const bw = 200, bh = 120;
const buf = new Uint8ClampedArray(bw * bh * 4);
for (let i = 0; i < bw * bh; i++) {
  buf[i * 4] = 60; buf[i * 4 + 1] = 120; buf[i * 4 + 2] = 55; buf[i * 4 + 3] = 255;
}
const before = buf.slice();
const fakeSites: any[] = [
  { x: 50, y: 60, kind: 'conifer', scale: 1, row: 0, col: 0 },
  { x: 90, y: 70, kind: 'scrub',   scale: 1, row: 0, col: 0 },
];
const drawn = stampDecals(buf, bw, bh, 0, 0, fakeSites, null);
check('stamps without an atlas (procedural fallback)', drawn === 2, `${drawn} drawn`);
let changed = 0;
for (let i = 0; i < buf.length; i += 4) if (buf[i] !== before[i]) changed++;
check('stamping changes pixels', changed > 20, `${changed} px changed`);

// Transparent ground must be left alone: no decal may invent land.
const hole = new Uint8ClampedArray(bw * bh * 4);
const drawnHole = stampDecals(hole, bw, bh, 0, 0, fakeSites, null);
check('never draws on unpainted pixels', drawnHole === 0, `${drawnHole} drawn on a hole`);
```

- [ ] **Step 2: Run — expect failure**

Expected: build error, `stampDecals` is not exported.

- [ ] **Step 3: Implement `stampDecals`**

Append to `src/rendering/SurfaceDecals.ts`:

```ts
export interface DecalAtlas {
  cell: number;
  rows: Record<DecalKind, number>;
  variants: number;
  /** RGBA, R = shading mask, A = coverage. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Stamp decals into the surface bake's ImageData.
 *
 * Colour is NEVER taken from the atlas. Each decal samples the terrain pixel
 * it stands on and shades relative to it, which is what keeps decals inside the
 * planet's own palette on every planet type and under any terrain tint. The
 * atlas supplies shape (alpha) and a lit/shadow mask (red channel) only.
 *
 * `d` is the sub-rect buffer the surface painter builds; `x0`/`yTop` are its
 * offset on screen, so site coordinates convert with `x - x0`, `y - yTop`.
 *
 * Returns the number of decals actually drawn.
 */
export function stampDecals(
  d: Uint8ClampedArray, bw: number, bh: number,
  x0: number, yTop: number,
  sites: DecalSite[], atlas: DecalAtlas | null,
): number {
  let drawn = 0;
  for (const s of sites) {
    const bx = Math.round(s.x) - x0, by = Math.round(s.y) - yTop;
    if (bx < 1 || by < 1 || bx >= bw - 1 || by >= bh) continue;
    const foot = (by * bw + bx) * 4;
    // Its own footprint must stand on painted land, or decals hang off coasts.
    if (d[foot + 3] === 0) continue;
    if (d[((by * bw) + bx - 1) * 4 + 3] === 0) continue;
    if (d[((by * bw) + bx + 1) * 4 + 3] === 0) continue;
    const ur = d[foot], ug = d[foot + 1], ub = d[foot + 2];

    // lit 0..255 from the atlas mask -> a multiplier plus a small hue push, so
    // foliage reads greener than the ground without leaving its family.
    const shade = (lit: number): [number, number, number] => {
      const t = lit / 255;
      const m = 0.45 + t * 0.42;
      const push = s.kind === 'rock' ? 0 : 1;
      return [
        Math.max(0, Math.min(255, ur * m + (push ? -12 : 8))),
        Math.max(0, Math.min(255, ug * m + (push ? 34 : 8))),
        Math.max(0, Math.min(255, ub * m + (push ? -10 : 10))),
      ];
    };
    const px = (x: number, y: number, c: [number, number, number]) => {
      if (x < 0 || y < 0 || x >= bw || y >= bh) return;
      const o = (y * bw + x) * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    };

    if (atlas) {
      const row = atlas.rows[s.kind] ?? 0;
      const variant = Math.abs((s.row * 31 + s.col * 17)) % Math.max(1, atlas.variants);
      const sx0 = variant * atlas.cell, sy0 = row * atlas.cell;
      for (let ay = 0; ay < atlas.cell; ay++) {
        for (let ax = 0; ax < atlas.cell; ax++) {
          const ao = ((sy0 + ay) * atlas.width + (sx0 + ax)) * 4;
          if (atlas.data[ao + 3] === 0) continue;
          const tx = bx + ax - (atlas.cell >> 1);
          const ty = by + ay - (atlas.cell - 2);
          px(tx, ty, shade(atlas.data[ao]));
        }
      }
    } else {
      // Procedural fallback so the renderer degrades gracefully if the atlas
      // has not loaded yet. Deliberately crude: a marker, not art.
      const h = Math.round((s.kind === 'scrub' || s.kind === 'rock' ? 4 : 10) * s.scale);
      for (let i = 0; i < h; i++) {
        const half = Math.max(0, Math.round((1 - i / h) * h * 0.4));
        for (let dx = -half; dx <= half; dx++) px(bx + dx, by - i, shade(dx < 0 ? 210 : 70));
      }
    }
    drawn++;
  }
  return drawn;
}
```

- [ ] **Step 4: Run the check**

Expected: the three new checks PASS along with everything from Tasks 2-3.

- [ ] **Step 5: Wire it into the surface bake**

In `src/rendering/HabitableCutawayEngine.ts`, add to the imports at the top:

```ts
import { planSurfaceDecals, stampDecals, type DecalAtlas } from './SurfaceDecals';
```

Add two optional fields to `CutawayBakeOpts` (after `lush?: number;` at `:194`):

```ts
  /** `planet.genomeSeed`. Decals are stable across saves and re-bakes. */
  decalSeed?: number;
  /** Loaded decal atlas, or null to use the procedural fallback. */
  decalAtlas?: DecalAtlas | null;
```

Then in `paintCutawaySurface`, immediately BEFORE `g.putImageData(img, x0, yTop);` at `:920`:

```ts
  // Decals last: they must stand on finished terrain, and the cliff-punch above
  // has already cleared water pixels back to alpha 0 so nothing lands in the sea.
  if (opts.decalSeed !== undefined) {
    const sites = planSurfaceDecals(opts, clamp01(opts.lush ?? 0.3), opts.decalSeed);
    stampDecals(d, bw, bh, x0, yTop, sites, opts.decalAtlas ?? null);
  }
```

- [ ] **Step 6: Confirm the existing diorama guard is still green**

```bash
node_modules/.bin/esbuild tools/habitableDioramaCheck.ts --bundle --platform=node --format=esm --outfile=$TEMP/hab.mjs && node $TEMP/hab.mjs
```

Expected: exit 0. Decals are off unless `decalSeed` is supplied, so this guard's output must not move at all.

- [ ] **Step 7: Commit**

```bash
git add src/rendering/SurfaceDecals.ts src/rendering/HabitableCutawayEngine.ts tools/surfaceDecalCheck.ts
git commit -m "feat(decals): stamp decals into the surface bake, colour derived from terrain"
```

---

### Task 6: Load the atlas and turn decals on for the home world

**Files:**
- Create: `src/rendering/DecalAtlasLoader.ts`
- Modify: `src/rendering/IsoDioramaRenderer.ts:1098-1111` (the `bakeSurface` opts) and the class fields near `:468`

**Interfaces:**
- Consumes: `DecalAtlas` from Task 5; `public/assets/pixel/decals/decals.json` from Task 4.
- Produces: `export async function loadDecalAtlas(base?: string): Promise<DecalAtlas | null>`

- [ ] **Step 1: Write the loader**

```ts
/**
 * Loads the decal atlas from public/assets. Returns null on any failure — the
 * renderer falls back to procedural markers rather than breaking the bake, so
 * a missing or corrupt asset degrades the picture instead of the game.
 */
import type { DecalAtlas, DecalKind } from './SurfaceDecals';

export async function loadDecalAtlas(
  base = 'assets/pixel/decals',
): Promise<DecalAtlas | null> {
  try {
    const manifest = await fetch(`${base}/decals.json`).then(r => r.json());
    const img = new Image();
    img.src = `${base}/${manifest.atlas}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
    const rows = {} as Record<DecalKind, number>;
    let variants = 1;
    for (const [kind, entry] of Object.entries(manifest.kinds) as Array<[DecalKind, any]>) {
      rows[kind] = entry.row;
      variants = Math.max(variants, entry.variants ?? 1);
    }
    return {
      cell: manifest.cell, rows, variants,
      data, width: canvas.width, height: canvas.height,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Hold the atlas on the renderer**

In `src/rendering/IsoDioramaRenderer.ts`, add near the other private fields (around `:468`):

```ts
  private decalAtlas: DecalAtlas | null = null;
```

with imports:

```ts
import type { DecalAtlas } from './SurfaceDecals';
import { loadDecalAtlas } from './DecalAtlasLoader';
```

and kick the load off in the constructor (fire and forget — the first bake uses
the fallback, and the next re-bake picks up the real atlas):

```ts
    void loadDecalAtlas().then(a => {
      this.decalAtlas = a;
      if (a) this.markSurfaceDirty();
    });
```

- [ ] **Step 3: Pass the seed and atlas into the bake**

In `bakeSurface`, in the object literal at `:1098-1111`, after the `lush:` line:

```ts
      decalSeed: this.planet?.genomeSeed ?? 0,
      decalAtlas: this.decalAtlas,
```

- [ ] **Step 4: Typecheck and run the guards**

```bash
npx tsc --noEmit 2>&1 | grep -v "Float32Array"
node_modules/.bin/esbuild tools/habitableDioramaCheck.ts --bundle --platform=node --format=esm --outfile=$TEMP/hab.mjs && node $TEMP/hab.mjs
node_modules/.bin/esbuild tools/surfaceDecalCheck.ts --bundle --platform=node --format=esm --outfile=$TEMP/decal.mjs && node $TEMP/decal.mjs
```

Expected: no new type errors; both guards exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/rendering/DecalAtlasLoader.ts src/rendering/IsoDioramaRenderer.ts
git commit -m "feat(decals): load the atlas and enable decals on the home world"
```

---

### Task 7: Re-bake threshold, so the biosphere does not thrash the bake

**Files:**
- Modify: `src/rendering/IsoDioramaRenderer.ts` — `setLiveData` (`:794-797`) and class fields near `:468`
- Modify: `tools/surfaceDecalCheck.ts`

**Interfaces:**
- Consumes: `PlanetBiosphere`.
- Produces: `export function decalRebakeNeeded(prev: {lush: number; biodiversity: number} | null, next: {lush: number; biodiversity: number}): boolean` in `src/rendering/SurfaceDecals.ts`.

- [ ] **Step 1: Write the failing threshold checks**

Append to `tools/surfaceDecalCheck.ts`:

```ts
const { decalRebakeNeeded } = await import('../src/rendering/SurfaceDecals');
check('first bake always needed', decalRebakeNeeded(null, { lush: 0.2, biodiversity: 1 }), 'null prev');
check('tiny lush drift does not re-bake',
      !decalRebakeNeeded({ lush: 0.400, biodiversity: 3 }, { lush: 0.430, biodiversity: 3 }), '0.03');
check('material lush change re-bakes',
      decalRebakeNeeded({ lush: 0.40, biodiversity: 3 }, { lush: 0.48, biodiversity: 3 }), '0.08');
check('a new species re-bakes',
      decalRebakeNeeded({ lush: 0.40, biodiversity: 3 }, { lush: 0.405, biodiversity: 4 }), 'biodiversity 3->4');
```

- [ ] **Step 2: Run — expect failure** (`decalRebakeNeeded` is not exported)

- [ ] **Step 3: Implement it**

Append to `src/rendering/SurfaceDecals.ts`:

```ts
/**
 * Should the surface re-bake for decals?
 *
 * The biosphere nudges every tick; re-baking on each would repaint the world
 * continuously for changes nobody can see. Re-bake on a material move in
 * lushness, or whenever the species count crosses an integer — that is the
 * event a player actually notices, because it is when new decal kinds unlock.
 */
export function decalRebakeNeeded(
  prev: { lush: number; biodiversity: number } | null,
  next: { lush: number; biodiversity: number },
): boolean {
  if (!prev) return true;
  if (Math.abs(next.lush - prev.lush) > 0.05) return true;
  return Math.floor(next.biodiversity) !== Math.floor(prev.biodiversity);
}
```

- [ ] **Step 4: Wire it into the host**

In `IsoDioramaRenderer.ts`, add a field near `:468`:

```ts
  private lastDecalState: { lush: number; biodiversity: number } | null = null;
```

and in `setLiveData` (`:794`), after `this.biosphere = biosphere;`:

```ts
    const lush = bio ? clamp01((bio.biodiversity / 10) * 0.55 + bio.landLife * 0.45) : 0.3;
    const nextState = { lush, biodiversity: bio?.biodiversity ?? 0 };
    if (decalRebakeNeeded(this.lastDecalState, nextState)) {
      this.lastDecalState = nextState;
      this.markSurfaceDirty();
    }
```

with `decalRebakeNeeded` added to the `SurfaceDecals` import.

- [ ] **Step 5: Run the check and typecheck**

```bash
node_modules/.bin/esbuild tools/surfaceDecalCheck.ts --bundle --platform=node --format=esm --outfile=$TEMP/decal.mjs && node $TEMP/decal.mjs
npx tsc --noEmit 2>&1 | grep -v "Float32Array"
```

Expected: all PASS; no new type errors.

- [ ] **Step 6: Commit**

```bash
git add src/rendering/SurfaceDecals.ts src/rendering/IsoDioramaRenderer.ts tools/surfaceDecalCheck.ts
git commit -m "feat(decals): re-bake only on material biosphere change"
```

---

### Task 8: Prove the per-frame cost did not move, and look at it

The spec's headline constraint is that baked decals cost nothing per frame. Assert it rather than assume it, then look at the pixels — this project has shipped four green atmosphere metrics over a lava world with a pink sky.

**Files:**
- Modify: `tools/surfaceDecalCheck.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: no new exports.

- [ ] **Step 1: Write the cost check**

Append to `tools/surfaceDecalCheck.ts`:

```ts
// Bake cost may rise; per-frame cost may not. Decals live in the baked land
// canvas, so `frame()` must not know they exist.
const t0 = performance.now();
for (let i = 0; i < 30; i++) planSurfaceDecals(opts, 0.92, 0xC0FFEE);
const planMs = (performance.now() - t0) / 30;
console.log(`\n  planning cost ${planMs.toFixed(1)}ms (bake-time only)`);
check('planning stays off the frame budget', planMs < 25, `${planMs.toFixed(1)}ms < 25ms`);
```

- [ ] **Step 2: Run the full check plus the neighbouring guards**

```bash
node_modules/.bin/esbuild tools/surfaceDecalCheck.ts --bundle --platform=node --format=esm --outfile=$TEMP/decal.mjs && node $TEMP/decal.mjs
node_modules/.bin/esbuild tools/habitableDioramaCheck.ts --bundle --platform=node --format=esm --outfile=$TEMP/hab.mjs && node $TEMP/hab.mjs
node_modules/.bin/esbuild tools/framePacingCheck.ts --bundle --platform=node --format=esm --outfile=$TEMP/pace.mjs && node $TEMP/pace.mjs
node_modules/.bin/esbuild tools/smokeTest.ts --bundle --platform=node --format=esm --outfile=$TEMP/smoke.mjs && node $TEMP/smoke.mjs
```

Expected: decal and diorama checks exit 0; `smokeTest` still 49/52 with exactly the three known failures and no others.

- [ ] **Step 3: Look at it (required)**

```bash
npm run dev
```

Open `http://localhost:3000/diorama-preview.html`. Compare against `?type=desert` and `?type=lava`.

What to check, and what to do about it:
- Decals sit ON the terraces, not floating above or buried in them. If they float, the `lift` term in Task 3 is being applied twice — the site `y` is already lifted.
- The snowcap is bare. If scrub appears on white, `DECAL_SNOW_LINE` is above the painter's local snow rule — see the coupled-constant note.
- Nothing overhangs a coastline into empty space.
- A desert world reads dry; a lava world has no vegetation at all.
- At full zoom-out decals must not turn to mush. If they do, that is the zoom
  response the spec leaves open — record what you saw and stop; do not invent a
  zoom rule here.

**Numbers passing is not the same as it looking right.** If it looks worse than the flat bands, say so and stop.

- [ ] **Step 4: Commit**

```bash
git add tools/surfaceDecalCheck.ts
git commit -m "test(decals): assert planning stays off the frame budget"
```

---

## Deferred to a later plan

- **The animated sway layer.** `animatedDecals(sites, focus, cap)` and the live draw are specced but not built here: the baked layer must prove itself visually first, and a live layer on a renderer that is already the bottleneck deserves its own measured budget.
- **Zoom response.** Task 8 Step 3 records what zoom-out looks like; the rule is designed once there is an observation to design against.
- **Colonised and probed planets.** The second data source stays unbuilt until the home world looks right.

## Self-review notes

- Spec coverage: architecture (Tasks 3, 5), placement rules (Task 3), art pipeline (Task 4), re-bake threshold (Task 7), measurement 1-2 and 4-6 (Task 3), measurement 3 (Task 2), measurement 7 (Task 8), `lifeDensity` prerequisite (Task 1). Spec's animated layer and zoom response are explicitly deferred above rather than silently dropped.
- Type consistency: `DecalKind`, `DecalSite`, `DecalAtlas`, `planSurfaceDecals`, `stampDecals`, `decalRebakeNeeded`, `loadDecalAtlas`, `DECAL_SNOW_LINE`, `DECAL_BUDGET` are used with identical names and signatures in every task that references them, and the atlas JSON key names match `DecalKind` exactly.
