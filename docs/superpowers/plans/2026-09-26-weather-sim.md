# Weather Sim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dead legacy clouds and the tint-only wisps with a visual weather sim on a 64x32 planet field, projected onto the diorama as a pixel-art cloud layer with shadows, precipitation and lightning, whose patterns come from the world.

**Architecture:** Three pure modules under `src/rendering/weather/` — `WeatherClimate` (grid → source maps + per-world personality), `WeatherSim` (seeded 4 Hz field sim with ablation switches), `WeatherPainter` (projection lookup + zero-allocation painting into `ImageData`). `HabitableCutawayEngine` owns sim + painter and composites them; `IsoDioramaRenderer` builds the climate from grid, biosphere, civ and genome seed. Every metric lives in `tools/weatherCheck.ts` and is shown failing on a control first.

**Tech Stack:** TypeScript, Canvas 2D `ImageData`, esbuild-bundled Node checks (no test framework).

**Spec:** `docs/superpowers/specs/2026-09-26-weather-sim-design.md` (amended by this plan's commit — see "Spec amendments" below).

## Prerequisite

The atmosphere pass (`docs/superpowers/plans/2026-09-25-atmosphere-pass.md`) is executed first. This plan assumes its state: `HabitableFrameInput.air` exists, `ozoneAt` returns `rimPx`, `habitableGeom` has the framing loop. **Do not start Task 1 until that plan's Task 5 is complete.**

## Spec amendments (measured while planning, 2026-09-26)

1. **Grid `temperature` and `moisture` do not depend on planet type.** For one seed, ocean/ice/lava/desert grids have identical means (T 0.46, M 0.46 on seed 1). Type shows only in `classifyBiome`. So planet type enters the weather through an explicit `TYPE_CLIMATE` table in `WeatherClimate` (ice cold, desert hot and dry, lava hot with no evaporating water). The spec's "types show up mostly through the grid's own maps" is wrong.
2. **65% of a lava world's cells are `volcanic` biome.** Ash emitters are *vents*: volcanic cells with elevation ≥ 0.70 that are a 3x3 local maximum, hash-thinned — the same elevation rule `planVolcanoChimneys` uses. Chimney screen sites are not passed in (they cover only the visible face; vents cover the planet).
3. **Rain-shadow metric is relative.** Downwind cells are farther from the coast, so they are drier even with no ridge. The metric is the upwind/downwind ratio on a ridge grid divided by the same ratio on an otherwise identical flat grid (and, on real grids, divided by the uplift-ablated run).
4. **Wet-vs-dry control is today's wisps only.** The null model shares the ordering it would be tested on (it sees the same water masks), so it cannot serve as that row's control.
5. **Structure metric is the spread of latitude-band means** (≥ 0.15), plus within-band range. Prototype: band means 0.23-0.32 without vertical motion, 0.23-0.46 with it.

## Global Constraints

- Pure modules (`WeatherClimate`, `WeatherSim`, `WeatherPainter`) import nothing from the DOM and nothing from `IsoDioramaRenderer` / `HabitableCutawayEngine`.
- Field: `WX_NX = 64`, `WX_NY = 32`, over the whole planet; longitude wraps, latitude clamps. Step `WX_DT = 0.25` s. Warm-up 200 steps.
- Visual only: this plan touches no file in `src/simulation/`.
- Budget, measured in the preview at the real ~480 px canvas: painter (prepare + shadows + clouds) ≤ **1.0 ms** median per frame; sim step ≤ **0.5 ms**; heap growth over 1,000 painted frames < **64 KB**.
- Frame path stays readback-free; the weather canvas is `putImageData`-only.
- Gas giants get no weather.
- Checks: `node_modules/.bin/esbuild tools/<name>.ts --bundle --platform=node --format=esm --outfile="$TEMP/<name>.mjs" --log-level=error && node "$TEMP/<name>.mjs"`.
- `node_modules/.bin/tsc --noEmit -p . 2>&1 | grep -c "error TS"` must stay at the pre-existing **2**.
- A threshold that fails a legitimate render is a finding to report, not a number to loosen. Tuning happens against the picture; metrics guard it.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `.env`.

## Review Focus

1. **Tab backgrounded, then refocused** — `dt` can arrive as seconds; the sim must not run hundreds of catch-up steps in one frame (freeze) nor explode. Engine caps at 4 steps per frame; test in Task 5.
2. **Planet change / new game** — the recurring leak: weather from the previous world must not appear on the next. Test in Task 5 (bake A, run, bake B == fresh B).
3. **Surface rebake mid-game** (lushness, civ level change) — must update sources without resetting the sky (clouds must not teleport, as the legacy comment warns). Test in Task 5: `setWeatherClimate` keeps `cloud` field identical.
4. **Pre-life world with no biosphere / no civ** — `biosphere` null, `star` null: climate must build with defaults, no NaN. Test in Task 1.
5. **Window resize** — `bake()` rebuilds the lookup for the new geometry; a stale lookup would paint outside the face. Covered by the bounds invariant in Task 4 plus a resize check in Task 5.

---

### Task 1: Climate sources

**Files:**
- Create: `src/rendering/weather/WeatherClimate.ts`
- Create: `tools/weatherCheck.ts`

**Interfaces:**
- Produces: `WX_NX`, `WX_NY`, `WX_N`, `CELL_COLS`, `CELL_ROWS`; `interface WeatherPersonality`, `interface ClimateSources`, `interface ClimateInput`, `interface ClimateOptions { uniformEmitters?: boolean; ashFloor?: number }`; `TYPE_CLIMATE`; `personalityFor(seed: number): WeatherPersonality`; `buildClimate(input: ClimateInput, opts?: ClimateOptions): ClimateSources`.

- [ ] **Step 1: Write the check skeleton and climate tests**

Create `tools/weatherCheck.ts`:

```ts
/**
 * Does the weather read the world?
 *
 * Every claim has a control that must FAIL: an ablation (the same sim with the
 * term under test switched off) or a stand-in for today's behaviour. A metric
 * that cannot fail on its control is measuring something else.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/weatherCheck.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/wx.mjs" --log-level=error && node --expose-gc "$TEMP/wx.mjs" [--quick]
 */
import { generatePlanetGrid, GRID_SIZE, type PlanetGrid } from '../src/simulation/PlanetGrid';
import {
  WX_NX, WX_NY, WX_N, buildClimate, personalityFor, type ClimateInput,
} from '../src/rendering/weather/WeatherClimate';

const QUICK = process.argv.includes('--quick');
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
  if (!ok) failed++;
}
const SEEDS = QUICK ? [1, 7, 42] : [1, 7, 42, 99, 123, 256, 511, 777, 1001, 2024, 4242, 9001];

function input(grid: PlanetGrid, planetType: string, seed: number, over: Partial<ClimateInput> = {}): ClimateInput {
  return {
    grid, planetType, seed, lush: 0.5, extinctionPressure: 0.1, oxygenLevel: 0.6,
    civLevel: 0, inNebula: false, ...over,
  };
}
const mean = (f: Float32Array) => f.reduce((a, b) => a + b, 0) / f.length;

// ─── 1. Climate sources ────────────────────────────────────────────────────────
console.log('\n  CLIMATE');
{
  const g = generatePlanetGrid('ocean', 7 * 7777, null, null);
  const ocean = buildClimate(input(g, 'ocean', 7));
  const ice = buildClimate(input(g, 'ice', 7));
  const lava = buildClimate(input(generatePlanetGrid('lava', 7 * 7777, null, null), 'lava', 7));
  const desert = buildClimate(input(generatePlanetGrid('desert', 7 * 7777, null, null), 'desert', 7));
  check('ice is colder than ocean', mean(ice.temp) < mean(ocean.temp) - 0.15,
    `ice ${mean(ice.temp).toFixed(2)} ocean ${mean(ocean.temp).toFixed(2)}`);
  check('desert is hotter than ocean', mean(desert.temp) > mean(ocean.temp) + 0.1,
    `desert ${mean(desert.temp).toFixed(2)}`);
  check('magma does not evaporate water', mean(lava.water) === 0, `lava water ${mean(lava.water).toFixed(3)}`);
  check('ocean world has evaporating water', mean(ocean.water) > 0.05, `${mean(ocean.water).toFixed(3)}`);
  const ventCells = lava.ashEmit.filter(v => v > 0).length / WX_N;
  check('lava ash comes from vents, not a floor', ventCells > 0.01 && ventCells < 0.15,
    `${(ventCells * 100).toFixed(1)}% of cells emit`);
  check('no ash on an ocean world', mean(ocean.ashEmit) === 0, `${mean(ocean.ashEmit)}`);
  check('no smog below civ 4', mean(ocean.smogEmit) === 0, `${mean(ocean.smogEmit)}`);
  const a = personalityFor(1), b = personalityFor(2), a2 = personalityFor(1);
  check('personality is deterministic', JSON.stringify(a) === JSON.stringify(a2), '');
  check('personality differs by seed', JSON.stringify(a) !== JSON.stringify(b), '');
  // Review focus 4: pre-life world, nothing known.
  const bare = buildClimate(input(g, 'rocky', 3, { lush: 0, extinctionPressure: 0, oxygenLevel: 0, civLevel: 0 }));
  const finite = [bare.water, bare.temp, bare.elev, bare.landMoist, bare.ashEmit, bare.smogEmit]
    .every(f => f.every(Number.isFinite));
  check('pre-life world builds, all finite', finite && Number.isFinite(bare.stormPressure), '');
}

console.log(failed === 0 ? '\n  all weather checks passed\n' : `\n  ${failed} weather check(s) FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it — it must fail to build**

Run: `node_modules/.bin/esbuild tools/weatherCheck.ts --bundle --platform=node --format=esm --outfile="$TEMP/wx.mjs" --log-level=error`
Expected: error `Could not resolve "../src/rendering/weather/WeatherClimate"`.

- [ ] **Step 3: Implement `WeatherClimate.ts`**

Create `src/rendering/weather/WeatherClimate.ts`:

```ts
/**
 * Climate sources for the weather sim: the 256x256 planet grid collapsed onto
 * the 64x32 weather field, plus the per-world weather personality.
 *
 * Pure — no DOM. Planet type enters HERE, through TYPE_CLIMATE: the grid's
 * temperature and moisture maps do not depend on type (measured 2026-09-26:
 * identical means on ocean, ice, lava and desert for one seed).
 */
import { GRID_SIZE, isWater, SEA_LEVEL, type PlanetGrid } from '../../simulation/PlanetGrid';

export const WX_NX = 64;
export const WX_NY = 32;
export const WX_N = WX_NX * WX_NY;
/** Grid columns / rows per weather cell. */
export const CELL_COLS = GRID_SIZE / WX_NX;
export const CELL_ROWS = GRID_SIZE / WX_NY;

export interface WeatherPersonality {
  /** Multipliers on the trades, westerlies and polar easterlies. */
  bandGain: [number, number, number];
  /** Per-row phase of the band meander. */
  rowPhase: Float32Array;
  /** Mid-latitude waves around the planet, 4-7. */
  waveNumber: number;
  /** Wave phase speed, rad/s. */
  waveSpeed: number;
  /** Offset into the detail-noise texture, in field cells. */
  detailOffset: number;
  /** Seed of the anomaly schedule. */
  anomalySeed: number;
}

export interface ClimateSources {
  /** Fraction of the cell that is evaporating water, 0-1. */
  water: Float32Array;
  /** Effective temperature after TYPE_CLIMATE, 0-1. */
  temp: Float32Array;
  /** Mean ground height, water counted at sea level. */
  elev: Float32Array;
  /** Land moisture x land fraction x lushness — the land's evaporation. */
  landMoist: Float32Array;
  ashEmit: Float32Array;
  smogEmit: Float32Array;
  /** 0-1. Scales convection. */
  stormPressure: number;
  /** 0-1 acid tint of cloud and rain. */
  acid: number;
  /** 0-1 emissive glow on cloud tops. */
  nebula: number;
  personality: WeatherPersonality;
}

export interface ClimateInput {
  grid: PlanetGrid;
  planetType: string;
  /** genomeSeed, or the renderer's planetSeed when the planet has none. */
  seed: number;
  /** 0-1 biosphere lushness (IsoDioramaRenderer.lushFor). */
  lush: number;
  extinctionPressure: number;
  oxygenLevel: number;
  civLevel: number;
  inNebula: boolean;
}

/** Test-only switches: the controls weatherCheck runs against. */
export interface ClimateOptions {
  /** Spread every emitter's total evenly over the planet. */
  uniformEmitters?: boolean;
  /** Add a planet-wide ash source (the prototype's lava blanket). */
  ashFloor?: number;
}

interface TypeClimate {
  tScale: number; tShift: number; moist: number;
  waterEvaporates: boolean; storm: number; soot: number; nebula: number;
}

export const TYPE_CLIMATE: Record<string, TypeClimate> = {
  ocean:   { tScale: 1.00, tShift: 0.00, moist: 1.0, waterEvaporates: true,  storm: 0.00, soot: 0,    nebula: 0 },
  rocky:   { tScale: 1.00, tShift: 0.00, moist: 0.8, waterEvaporates: true,  storm: 0.00, soot: 0,    nebula: 0 },
  storm:   { tScale: 1.00, tShift: 0.05, moist: 1.2, waterEvaporates: true,  storm: 0.60, soot: 0,    nebula: 0 },
  toxic:   { tScale: 1.00, tShift: 0.05, moist: 1.0, waterEvaporates: true,  storm: 0.10, soot: 0,    nebula: 0 },
  ice:     { tScale: 0.45, tShift: 0.00, moist: 0.6, waterEvaporates: true,  storm: 0.00, soot: 0,    nebula: 0 },
  desert:  { tScale: 0.80, tShift: 0.25, moist: 0.3, waterEvaporates: true,  storm: 0.00, soot: 0,    nebula: 0 },
  // Magma lakes classify as water biomes. They must not evaporate water.
  lava:    { tScale: 0.50, tShift: 0.50, moist: 0.1, waterEvaporates: false, storm: 0.10, soot: 0,    nebula: 0 },
  carbon:  { tScale: 1.00, tShift: 0.00, moist: 0.6, waterEvaporates: true,  storm: 0.00, soot: 0.02, nebula: 0 },
  crystal: { tScale: 1.00, tShift: 0.00, moist: 0.8, waterEvaporates: true,  storm: 0.00, soot: 0,    nebula: 0.35 },
  gas:     { tScale: 1.00, tShift: 0.00, moist: 1.0, waterEvaporates: true,  storm: 0.00, soot: 0,    nebula: 0 },
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** mulberry32 — small, seedable, good enough for visuals. */
export function weatherRng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashCell(r: number, c: number, seed: number): number {
  let h = (Math.imul(r, 374761393) + Math.imul(c, 668265263) + Math.imul(seed | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function personalityFor(seed: number): WeatherPersonality {
  const r = weatherRng(seed ^ 0x5eed5eed);
  const rowPhase = new Float32Array(WX_NY);
  for (let j = 0; j < WX_NY; j++) rowPhase[j] = r() * Math.PI * 2;
  return {
    bandGain: [0.75 + r() * 0.5, 0.75 + r() * 0.5, 0.75 + r() * 0.5],
    rowPhase,
    waveNumber: 4 + Math.floor(r() * 4),
    waveSpeed: 0.06 + r() * 0.06,
    detailOffset: r() * WX_NX,
    anomalySeed: Math.floor(r() * 4294967296) >>> 0,
  };
}

/**
 * A vent: a volcanic cell on a 3x3 local peak at elevation >= 0.70, thinned by
 * hash. Same elevation rule as planVolcanoChimneys; a lava world is ~65%
 * volcanic biome, so "every volcanic cell emits" would blanket the planet.
 */
function isVent(grid: PlanetGrid, r: number, c: number, seed: number): boolean {
  const cell = grid[r][c];
  if (cell.biome !== 'volcanic' && cell.biome !== 'mountain') return false;
  if (cell.elevation < 0.70) return false;
  for (let dr = -1; dr <= 1; dr++) {
    const rr = r + dr;
    if (rr < 0 || rr >= GRID_SIZE) continue;
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const n = grid[rr][(c + dc + GRID_SIZE) % GRID_SIZE];
      if (n.elevation > cell.elevation) return false;
    }
  }
  return hashCell(r, c, seed) < 0.35;
}

export function buildClimate(input: ClimateInput, opts: ClimateOptions = {}): ClimateSources {
  const { grid, planetType } = input;
  const tc = TYPE_CLIMATE[planetType] ?? TYPE_CLIMATE.rocky;
  const water = new Float32Array(WX_N), temp = new Float32Array(WX_N);
  const elev = new Float32Array(WX_N), landMoist = new Float32Array(WX_N);
  const ashEmit = new Float32Array(WX_N), smogEmit = new Float32Array(WX_N);
  const per = CELL_COLS * CELL_ROWS;
  const lushGain = 0.3 + 0.7 * clamp01(input.lush);
  const lava = planetType === 'lava';
  for (let j = 0; j < WX_NY; j++) {
    for (let i = 0; i < WX_NX; i++) {
      let w = 0, t = 0, e = 0, m = 0, land = 0, civ = 0, vents = 0;
      for (let r = j * CELL_ROWS; r < (j + 1) * CELL_ROWS; r++) {
        for (let q = i * CELL_COLS; q < (i + 1) * CELL_COLS; q++) {
          const cell = grid[r][q];
          if (isWater(cell.biome)) w++;
          else { land++; m += cell.moisture; }
          t += cell.temperature;
          e += Math.max(SEA_LEVEL, cell.elevation);
          if (cell.civId) civ++;
          if (lava && isVent(grid, r, q, input.seed)) vents++;
        }
      }
      const k = j * WX_NX + i;
      water[k] = tc.waterEvaporates ? w / per : 0;
      temp[k] = clamp01((t / per) * tc.tScale + tc.tShift);
      elev[k] = e / per;
      landMoist[k] = land > 0 ? (m / land) * (land / per) * tc.moist * lushGain : 0;
      ashEmit[k] = Math.min(1, vents * 0.5) + tc.soot;
      // Settlement DENSITY, not territory: squared, so dense cores emit and
      // thin borders barely do (the preview marks 40k of 65k cells as civ).
      const civFrac = civ / per;
      smogEmit[k] = input.civLevel >= 4 ? civFrac * civFrac * (input.civLevel - 3) : 0;
    }
  }
  if (opts.uniformEmitters) {
    for (const f of [ashEmit, smogEmit]) {
      const m = f.reduce((a, b) => a + b, 0) / WX_N;
      f.fill(m);
    }
  }
  if (opts.ashFloor) for (let k = 0; k < WX_N; k++) ashEmit[k] += opts.ashFloor;
  return {
    water, temp, elev, landMoist, ashEmit, smogEmit,
    stormPressure: clamp01(tc.storm + input.extinctionPressure),
    acid: planetType === 'toxic' ? 1 : clamp01((0.42 - input.oxygenLevel) / 0.42) * 0.6,
    nebula: Math.max(tc.nebula, input.inNebula ? 1 : 0),
    personality: personalityFor(input.seed),
  };
}
```

- [ ] **Step 4: Run — all climate checks pass**

Run: `node_modules/.bin/esbuild tools/weatherCheck.ts --bundle --platform=node --format=esm --outfile="$TEMP/wx.mjs" --log-level=error && node --expose-gc "$TEMP/wx.mjs"; echo exit $?`
Expected: exit 0, ten PASS lines. If `lava ash comes from vents` is outside 1-15%, change only the `0.35` hash threshold in `isVent`, record the measured fraction in the commit message, and re-run.

- [ ] **Step 5: Typecheck and commit**

Run: `node_modules/.bin/tsc --noEmit -p . 2>&1 | grep -c "error TS"` → `2`.

```bash
git add src/rendering/weather/WeatherClimate.ts tools/weatherCheck.ts
git commit -m "feat(weather): climate sources — per-type climate table, vents, settlement smog, personality

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The sim — wind, water cycle, particulates, kinds

**Files:**
- Create: `src/rendering/weather/WeatherSim.ts`
- Modify: `tools/weatherCheck.ts`

**Interfaces:**
- Consumes: `ClimateSources`, `WX_NX`, `WX_NY`, `WX_N`, `buildClimate`, `ClimateOptions`.
- Produces: `WX_DT = 0.25`, `WX_WARMUP = 200`, `COLD = 0.3`; `interface SimAblation { uplift?; vertical?; cold?; stress?; wind?; anomalies? }` (all `boolean`); `const WK = { CLEAR: 0, CUMULUS: 1, STORM: 2, ICE: 3, ASH: 4, SMOG: 5 } as const`; `sampleField(f: Float32Array, x: number, y: number): number`; `fieldIndex(x: number, y: number): number`; `latOf(j: number): number`; `class WeatherSim` with public `vapour, cloud, ash, smog, prevCloud, prevAsh, prevSmog, precip, convection: Float32Array`, `snow: Uint8Array`, `time: number`, `anomaly: Anomaly | null`, `anomalyCount: number`, methods `reset()`, `setClimate(c)`, `baseWindU(j)`, `windU(i, j)`, `step(dt?)`, `warmUp(steps?)`; `kindAt(sim: WeatherSim, k: number): number`.

- [ ] **Step 1: Write the physics metrics (with controls)**

Add to `tools/weatherCheck.ts`, after the CLIMATE block and before the final `console.log`. Also add the imports at the top:

```ts
import { SEA_LEVEL } from '../src/simulation/PlanetGrid';
import type { ClimateSources } from '../src/rendering/weather/WeatherClimate';
import {
  WeatherSim, WX_DT, WX_WARMUP, WK, kindAt, latOf, type SimAblation,
} from '../src/rendering/weather/WeatherSim';
```

```ts
// ─── helpers ──────────────────────────────────────────────────────────────────
function run(c: ClimateSources, steps: number, ablate: SimAblation = {}): WeatherSim {
  const s = new WeatherSim(c, ablate);
  s.warmUp(WX_WARMUP);
  for (let n = 0; n < steps; n++) s.step(WX_DT);
  return s;
}
/** Mean precip per cell over `steps`, after warm-up. */
function precipMean(c: ClimateSources, steps: number, ablate: SimAblation = {}): Float32Array {
  const s = new WeatherSim(c, ablate);
  s.warmUp(WX_WARMUP);
  const acc = new Float32Array(WX_N);
  for (let n = 0; n < steps; n++) { s.step(WX_DT); for (let k = 0; k < WX_N; k++) acc[k] += s.precip[k]; }
  for (let k = 0; k < WX_N; k++) acc[k] /= steps;
  return acc;
}
/** Synthetic world: ocean west of i=20, land east, optional ridge at i=34-35. */
function synthGrid(ridge: boolean): PlanetGrid {
  const g: any[] = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    const row: any[] = [];
    const lat = (0.5 - (r + 0.5) / GRID_SIZE) * 180;
    for (let c = 0; c < GRID_SIZE; c++) {
      const i = Math.floor(c / 4);
      const sea = i < 20;
      const onRidge = ridge && (i === 34 || i === 35);
      row.push({
        elevation: sea ? 0.30 : onRidge ? 0.95 : 0.55,
        moisture: 0.5, temperature: Math.max(0, 1 - Math.abs(lat) / 90 * 0.95),
        biome: sea ? 'ocean' : onRidge ? 'mountain' : 'plains',
        fertility: 0.5, lifeDensity: 0, dominantSpeciesId: null, civId: null,
      });
    }
    g.push(row);
  }
  return g as PlanetGrid;
}
const westerlyRows = [...Array(WX_NY).keys()].filter(j => {
  const a = Math.abs(latOf(j)) * 180 / Math.PI; return a > 33 && a < 57;
});
function sideRatio(p: Float32Array): number {
  let up = 0, down = 0;
  for (const j of westerlyRows) for (let i = 28; i <= 33; i++) up += p[j * WX_NX + i];
  for (const j of westerlyRows) for (let i = 36; i <= 41; i++) down += p[j * WX_NX + i];
  return up / Math.max(1e-6, down);
}
/** The null model: climate masks x scrolling noise. No physics. */
function nullPrecip(c: ClimateSources): Float32Array {
  const p = new Float32Array(WX_N);
  for (let k = 0; k < WX_N; k++) {
    const cloud = (c.water[k] * (0.3 + 0.7 * c.temp[k]) + 0.4 * c.landMoist[k]) * 1.2;
    p[k] = Math.max(0, cloud - 0.45);
  }
  return p;
}
const STEPS = QUICK ? 400 : 800;

// ─── 2. Physics ───────────────────────────────────────────────────────────────
console.log('\n  PHYSICS');
{
  // Rain shadow, synthetic: ridge ratio relative to the same world with no ridge.
  const cR = buildClimate(input(synthGrid(true), 'ocean', 5));
  const cF = buildClimate(input(synthGrid(false), 'ocean', 5));
  const shadow = sideRatio(precipMean(cR, STEPS)) / Math.max(1e-6, sideRatio(precipMean(cF, STEPS)));
  const shadowAbl = sideRatio(precipMean(cR, STEPS, { uplift: true })) /
                    Math.max(1e-6, sideRatio(precipMean(cF, STEPS, { uplift: true })));
  const shadowNull = sideRatio(nullPrecip(cR)) / Math.max(1e-6, sideRatio(nullPrecip(cF)));
  check('rain shadow (synthetic ridge)', shadow >= 2, `relative ratio ${shadow.toFixed(2)} >= 2`);
  check('  control: uplift ablated has none', shadowAbl < 2, `${shadowAbl.toFixed(2)} < 2`);
  check('  control: null model has none', !(shadowNull >= 2), `${shadowNull.toFixed(2)} < 2`);

  // Rain shadow, real grids: windward vs lee cells, relative to uplift-ablated.
  const rel: number[] = [];
  for (const seed of SEEDS) {
    const c = buildClimate(input(generatePlanetGrid('rocky', seed * 7777, null, null), 'rocky', seed));
    const p = precipMean(c, QUICK ? 200 : 400), pA = precipMean(c, QUICK ? 200 : 400, { uplift: true });
    const probe = new WeatherSim(c);
    let ww = 0, lee = 0, wwA = 0, leeA = 0;
    for (let j = 2; j < WX_NY - 2; j++) {
      const up = probe.baseWindU(j) >= 0 ? 1 : -1;
      for (let i = 0; i < WX_NX; i++) {
        const at = (di: number) => j * WX_NX + ((i + di) % WX_NX + WX_NX) % WX_NX;
        const rise = c.elev[at(up)] - c.elev[at(-up)];
        if (rise > 0.05) { ww += p[at(0)]; wwA += pA[at(0)]; lee += p[at(3 * up)]; leeA += pA[at(3 * up)]; }
      }
    }
    rel.push((ww / Math.max(1e-6, lee)) / Math.max(1e-6, wwA / Math.max(1e-6, leeA)));
  }
  rel.sort((a, b) => a - b);
  const relMed = rel[Math.floor(rel.length / 2)];
  check('rain shadow (real grids, median)', relMed >= 1.5, `${relMed.toFixed(2)} >= 1.5 over ${rel.length} seeds`);

  // Poles snow.
  const cO = buildClimate(input(generatePlanetGrid('ocean', 42 * 7777, null, null), 'ocean', 42));
  const snowShare = (abl: SimAblation) => {
    const s = new WeatherSim(cO, abl); s.warmUp(WX_WARMUP);
    let polS = 0, polP = 0, troS = 0, troP = 0;
    for (let n = 0; n < STEPS; n++) {
      s.step(WX_DT);
      for (let j = 0; j < WX_NY; j++) {
        const a = Math.abs(latOf(j)) * 180 / Math.PI;
        for (let i = 0; i < WX_NX; i++) {
          const k = j * WX_NX + i, p = s.precip[k];
          if (a > 60) { polP += p; if (s.snow[k]) polS += p; }
          if (a < 30) { troP += p; if (s.snow[k]) troS += p; }
        }
      }
    }
    return (polS / Math.max(1e-9, polP)) / Math.max(0.01, troS / Math.max(1e-9, troP));
  };
  const snowR = snowShare({}), snowAbl = snowShare({ cold: true });
  check('poles snow', snowR >= 5, `polar/tropical snow share ${snowR.toFixed(1)} >= 5`);
  check('  control: cold ablated', snowAbl < 5, `${snowAbl.toFixed(1)} < 5`);

  // Storms follow stress.
  const gO = generatePlanetGrid('ocean', 42 * 7777, null, null);
  const stormFrac = (pressure: number, abl: SimAblation) => {
    const s = run(buildClimate(input(gO, 'ocean', 42, { extinctionPressure: pressure })), STEPS, abl);
    let n = 0; for (let k = 0; k < WX_N; k++) if (kindAt(s, k) === WK.STORM) n++;
    return n / WX_N;
  };
  const sHi = stormFrac(0.8, {}), sLo = stormFrac(0, {});
  const aHi = stormFrac(0.8, { stress: true }), aLo = stormFrac(0, { stress: true });
  check('storms follow stress', sHi >= 2 * Math.max(sLo, 0.002), `${(sHi * 100).toFixed(1)}% vs ${(sLo * 100).toFixed(1)}%`);
  check('  control: stress ablated', !(aHi >= 2 * Math.max(aLo, 0.002)), `${(aHi * 100).toFixed(1)}% vs ${(aLo * 100).toFixed(1)}%`);

  // Structure, not uniform grey: spread of latitude-band means.
  const bandSpread = (abl: SimAblation) => {
    const s = run(cO, STEPS, abl);
    const means: number[] = [];
    for (let j = 1; j < WX_NY - 1; j++) {
      let m = 0; for (let i = 0; i < WX_NX; i++) m += s.cloud[j * WX_NX + i];
      means.push(m / WX_NX);
    }
    return Math.max(...means) - Math.min(...means);
  };
  const spread = bandSpread({}), spreadAbl = bandSpread({ vertical: true });
  check('cloud has latitude structure', spread >= 0.15, `band-mean spread ${spread.toFixed(2)} >= 0.15`);
  check('  control: vertical motion ablated', spreadAbl < 0.15, `${spreadAbl.toFixed(2)} < 0.15`);

  // Moves with the wind: row cross-correlation peak between t and t+10 s.
  const drift = (abl: SimAblation) => {
    const s = run(cO, 100, abl);
    const before = s.cloud.slice();
    for (let n = 0; n < 40; n++) s.step(WX_DT);
    let agree = 0, rows = 0;
    for (let j = 2; j < WX_NY - 2; j++) {
      const a = Math.abs(latOf(j)) * 180 / Math.PI;
      if (Math.abs(a - 30) < 5 || Math.abs(a - 60) < 5) continue;   // band edges
      let best = 0, bestShift = 0;
      for (let sh = -8; sh <= 8; sh++) {
        let cc = 0;
        for (let i = 0; i < WX_NX; i++) cc += before[j * WX_NX + i] * s.cloud[j * WX_NX + ((i + sh) % WX_NX + WX_NX) % WX_NX];
        if (cc > best) { best = cc; bestShift = sh; }
      }
      rows++;
      if (bestShift !== 0 && Math.sign(bestShift) === Math.sign(s.baseWindU(j) || 1)) agree++;
    }
    return agree / Math.max(1, rows);
  };
  const dr = drift({}), drAbl = drift({ wind: true });
  check('cloud moves with the band wind', dr >= 0.8, `${(dr * 100).toFixed(0)}% of rows agree`);
  check('  control: zero wind', drAbl < 0.8, `${(drAbl * 100).toFixed(0)}%`);

  // Smog where the cities are.
  const civGrid = generatePlanetGrid('ocean', 7 * 7777, null, null);
  for (const [cr, cc] of [[80, 40], [128, 150], [170, 220]]) {
    for (let r = cr - 20; r <= cr + 20; r++) for (let c = cc - 20; c <= cc + 20; c++) {
      if ((r - cr) ** 2 + (c - cc) ** 2 <= 400) civGrid[r][(c + GRID_SIZE) % GRID_SIZE].civId = 'civ';
    }
  }
  const smogRatio = (opts: object, civLevel: number) => {
    const c = buildClimate(input(civGrid, 'ocean', 7, { civLevel }), opts);
    const s = run(c, STEPS);
    let near = 0, nN = 0, far = 0, nF = 0;
    for (let j = 0; j < WX_NY; j++) for (let i = 0; i < WX_NX; i++) {
      const k = j * WX_NX + i;
      let dist = 99;
      for (let jj = 0; jj < WX_NY; jj++) for (let ii = 0; ii < WX_NX; ii++) {
        if (c.smogEmit[jj * WX_NX + ii] <= 0) continue;
        const di = Math.min(Math.abs(ii - i), WX_NX - Math.abs(ii - i));
        dist = Math.min(dist, Math.max(di, Math.abs(jj - j)));
      }
      if (dist <= 3) { near += s.smog[k]; nN++; } else if (dist >= 10) { far += s.smog[k]; nF++; }
    }
    return { ratio: (near / Math.max(1, nN)) / Math.max(1e-6, far / Math.max(1, nF)), total: s.smog.reduce((a, b) => a + b, 0) };
  };
  const sm = smogRatio({}, 6), smU = smogRatio({ uniformEmitters: true }, 6), sm3 = smogRatio({}, 3);
  check('smog sits over the cities', sm.ratio >= 3, `near/far ${sm.ratio.toFixed(1)} >= 3`);
  check('  control: uniform emitters', !(smU.ratio >= 3), `${smU.ratio.toFixed(1)}`);
  check('no smog below civ 4', sm3.total === 0, `total ${sm3.total}`);

  // Ash where the vents are.
  const ashRatio = (opts: object) => {
    const c = buildClimate(input(generatePlanetGrid('lava', 7 * 7777, null, null), 'lava', 7), opts);
    const s = run(c, STEPS);
    const src = buildClimate(input(generatePlanetGrid('lava', 7 * 7777, null, null), 'lava', 7));
    let near = 0, nN = 0, far = 0, nF = 0;
    for (let j = 0; j < WX_NY; j++) for (let i = 0; i < WX_NX; i++) {
      let dist = 99;
      for (let jj = Math.max(0, j - 12); jj < Math.min(WX_NY, j + 13); jj++) for (let ii = i - 12; ii <= i + 12; ii++) {
        if (src.ashEmit[jj * WX_NX + ((ii % WX_NX) + WX_NX) % WX_NX] <= 0) continue;
        dist = Math.min(dist, Math.max(Math.abs(ii - i), Math.abs(jj - j)));
      }
      const k = j * WX_NX + i;
      if (dist <= 3) { near += s.ash[k]; nN++; } else if (dist >= 8) { far += s.ash[k]; nF++; }
    }
    return (near / Math.max(1, nN)) / Math.max(1e-6, far / Math.max(1, nF));
  };
  const ar = ashRatio({}), arU = ashRatio({ uniformEmitters: true });
  check('ash sits over the vents', ar >= 3, `near/far ${ar.toFixed(1)} >= 3`);
  check('  control: uniform emitters', arU < 3, `${arU.toFixed(1)} < 3`);

  // Per-world personality.
  const corr = (a: Float32Array, b: Float32Array) => {
    const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0;
    for (let k = 0; k < a.length; k++) { n += (a[k] - ma) * (b[k] - mb); da += (a[k] - ma) ** 2; db += (b[k] - mb) ** 2; }
    return n / Math.sqrt(Math.max(1e-12, da * db));
  };
  const pA = run(buildClimate(input(gO, 'ocean', 11)), STEPS).cloud;
  const pB = run(buildClimate(input(gO, 'ocean', 12)), STEPS).cloud;
  const pA2 = run(buildClimate(input(gO, 'ocean', 11)), STEPS).cloud;
  check('two seeds, same grid: different weather', corr(pA, pB) < 0.5, `corr ${corr(pA, pB).toFixed(2)} < 0.5`);
  check('same seed twice: identical', pA.every((v, k) => v === pA2[k]), '');
  check('  control: seed ignored is identical', corr(pA, pA2) >= 0.5, `corr ${corr(pA, pA2).toFixed(2)}`);

  // Stable over hours.
  const TYPES = ['ocean', 'rocky', 'ice', 'lava', 'desert', 'storm', 'toxic', 'carbon', 'crystal'];
  const LONG = QUICK ? 4000 : 20000;
  let worst = '';
  for (const t of TYPES) for (const seed of SEEDS.slice(0, QUICK ? 2 : 6)) {
    const c = buildClimate(input(generatePlanetGrid(t, seed * 7777, null, null), t, seed));
    const s = new WeatherSim(c); s.warmUp(WX_WARMUP);
    let snap = s.cloud.slice(), frozen = 0, samples = 0;
    for (let n = 1; n <= LONG; n++) {
      s.step(WX_DT);
      if (n % 240 !== 0) continue;               // every 60 s
      samples++;
      let cover = 0, bad = false;
      for (let k = 0; k < WX_N; k++) {
        const v = s.cloud[k];
        if (!Number.isFinite(v) || v < 0 || v > 1.4 || !Number.isFinite(s.vapour[k])) bad = true;
        if (v + s.ash[k] > 0.3) cover++;
      }
      cover /= WX_N;
      if (corr(snap, s.cloud) > 0.95) frozen++;
      snap = s.cloud.slice();
      if (bad || cover < 0.02 || cover > 0.75) { worst ||= `${t} seed ${seed} step ${n}: cover ${(cover * 100).toFixed(1)}% ${bad ? 'NaN/range' : ''}`; }
    }
    if (frozen > samples * 0.5) worst ||= `${t} seed ${seed}: frozen in ${frozen}/${samples} samples`;
  }
  check('stable over hours, every type', worst === '', worst || `${TYPES.length} types x ${QUICK ? 2 : 6} seeds x ${LONG} steps`);
}
```

- [ ] **Step 2: Run — must fail to build**

Run the build command. Expected: `Could not resolve "../src/rendering/weather/WeatherSim"`.

- [ ] **Step 3: Implement `WeatherSim.ts`**

Create `src/rendering/weather/WeatherSim.ts`:

```ts
/**
 * The weather sim: a 64x32 field over the whole planet, stepped at 4 Hz.
 *
 * Pure and deterministic. Visual only — nothing here feeds back into the
 * simulation. Every physics term has an ablation switch so tools/weatherCheck
 * can prove each metric measures the term it claims to.
 */
import { WX_NX, WX_NY, WX_N, weatherRng, type ClimateSources } from './WeatherClimate';

export const WX_DT = 0.25;
export const WX_WARMUP = 200;
/** Below this effective temperature, precipitation is snow. */
export const COLD = 0.3;

export interface SimAblation {
  uplift?: boolean; vertical?: boolean; cold?: boolean;
  stress?: boolean; wind?: boolean; anomalies?: boolean;
}

export const WK = { CLEAR: 0, CUMULUS: 1, STORM: 2, ICE: 3, ASH: 4, SMOG: 5 } as const;

export type AnomalyKind = 'supercell' | 'reversal' | 'clearing';
export interface Anomaly { kind: AnomalyKind; i: number; j: number; until: number }

/** Latitude of field row j, radians; row 0 is the north pole. */
export function latOf(j: number): number {
  return (0.5 - (j + 0.5) / WX_NY) * Math.PI;
}

const wrapI = (i: number) => ((i % WX_NX) + WX_NX) % WX_NX;
const clampJ = (j: number) => (j < 0 ? 0 : j > WX_NY - 1 ? WX_NY - 1 : j);

/** Bilinear sample; longitude wraps, latitude clamps. */
export function sampleField(f: Float32Array, x: number, y: number): number {
  const i0 = Math.floor(x), j0 = Math.floor(y);
  const fx = x - i0, fy = y - j0;
  const a = wrapI(i0), b = wrapI(i0 + 1), r0 = clampJ(j0) * WX_NX, r1 = clampJ(j0 + 1) * WX_NX;
  return f[r0 + a] * (1 - fx) * (1 - fy) + f[r0 + b] * fx * (1 - fy)
       + f[r1 + a] * (1 - fx) * fy + f[r1 + b] * fx * fy;
}

/** Nearest field cell. */
export function fieldIndex(x: number, y: number): number {
  return clampJ(Math.round(y)) * WX_NX + wrapI(Math.round(x));
}

export class WeatherSim {
  vapour = new Float32Array(WX_N);
  cloud = new Float32Array(WX_N);
  ash = new Float32Array(WX_N);
  smog = new Float32Array(WX_N);
  prevCloud = new Float32Array(WX_N);
  prevAsh = new Float32Array(WX_N);
  prevSmog = new Float32Array(WX_N);
  readonly precip = new Float32Array(WX_N);
  readonly convection = new Float32Array(WX_N);
  readonly snow = new Uint8Array(WX_N);
  time = 0;
  anomaly: Anomaly | null = null;
  anomalyCount = 0;

  private nv = new Float32Array(WX_N);
  private nc = new Float32Array(WX_N);
  private na = new Float32Array(WX_N);
  private ns = new Float32Array(WX_N);
  private nextAnomaly = 0;
  private anomalyRng: () => number = Math.random;

  constructor(public climate: ClimateSources, readonly ablate: SimAblation = {}) {
    this.reset();
  }

  /** Back to the state of a freshly baked planet. */
  reset(): void {
    for (const f of [this.cloud, this.ash, this.smog, this.prevCloud, this.prevAsh, this.prevSmog,
                     this.precip, this.convection]) f.fill(0);
    this.snow.fill(0);
    for (let k = 0; k < WX_N; k++) this.vapour[k] = 0.3 * (0.18 + 0.7 * this.climate.temp[k]);
    this.time = 0;
    this.anomaly = null;
    this.anomalyCount = 0;
    this.anomalyRng = weatherRng(this.climate.personality.anomalySeed);
    this.nextAnomaly = 300 + this.anomalyRng() * 300;
  }

  /** New sources (lushness, civ level changed). The sky is kept — no teleport. */
  setClimate(c: ClimateSources): void {
    this.climate = c;
  }

  /** Band wind without meander or anomalies, cells/s; +i is eastward. */
  baseWindU(j: number): number {
    if (this.ablate.wind) return 0;
    const g = this.climate.personality.bandGain;
    const a = Math.abs(latOf(j)) * 180 / Math.PI;
    return a < 30 ? -0.55 * g[0] : a < 60 ? 0.6 * g[1] : -0.35 * g[2];
  }

  windU(i: number, j: number): number {
    if (this.ablate.wind) return 0;
    let u = this.baseWindU(j)
      + 0.3 * Math.sin(this.time * 0.05 + i * 0.25 + this.climate.personality.rowPhase[j]);
    const an = this.anomaly;
    if (an && an.kind === 'reversal' && Math.abs(j - an.j) <= 3) u = -u;
    return u;
  }

  /** Equatorward drift in the tropics, rows/s (+j is southward). */
  private windV(j: number): number {
    if (this.ablate.wind) return 0;
    const lat = latOf(j);
    return Math.abs(lat) < Math.PI / 6 ? Math.sign(lat) * 0.10 : 0;
  }

  /** Rising (+) / sinking (-) air: Hadley/Ferrel cells plus travelling waves. */
  private verticalMotion(i: number, j: number): number {
    if (this.ablate.vertical) return 0;
    const p = this.climate.personality;
    const lat = latOf(j), alat = Math.abs(lat);
    const env = Math.max(0, 1 - Math.abs(alat - 0.95) / 0.4);
    return 0.55 * Math.cos(6 * lat)
      + 0.9 * env * Math.sin(i * Math.PI * 2 / WX_NX * p.waveNumber - this.time * p.waveSpeed + j * 0.35)
      + 0.35 * Math.sin(i * 0.9 + j * 1.3 - this.time * 0.05);
  }

  private near(i: number, j: number, r: number): boolean {
    const an = this.anomaly;
    if (!an) return false;
    const di = Math.min(Math.abs(i - an.i), WX_NX - Math.abs(i - an.i));
    return di <= r && Math.abs(j - an.j) <= r;
  }

  step(dt = WX_DT): void {
    this.time += dt;
    const c = this.climate;
    const { nv, nc, na, ns } = this;

    // Semi-Lagrangian advection: trace back along the wind, sample bilinearly.
    for (let j = 0; j < WX_NY; j++) {
      const v = this.windV(j);
      for (let i = 0; i < WX_NX; i++) {
        const x = i - this.windU(i, j) * dt, y = j - v * dt;
        const k = j * WX_NX + i;
        nv[k] = sampleField(this.vapour, x, y);
        nc[k] = sampleField(this.cloud, x, y);
        na[k] = sampleField(this.ash, x, y);
        ns[k] = sampleField(this.smog, x, y);
      }
    }

    const pressure = this.ablate.stress ? 0 : c.stormPressure;
    for (let j = 0; j < WX_NY; j++) {
      for (let i = 0; i < WX_NX; i++) {
        const k = j * WX_NX + i;
        const T = c.temp[k];
        nv[k] += dt * 0.06 * (c.water[k] * (0.3 + 0.7 * T) + 0.25 * c.landMoist[k]);

        // Orographic lift: air blowing up the elevation gradient.
        const up = this.baseWindU(j) >= 0 ? 1 : -1;
        const slope = (c.elev[j * WX_NX + wrapI(i + up)] - c.elev[j * WX_NX + wrapI(i - up)]) * 0.5;
        const oro = this.ablate.uplift ? 0 : Math.max(0, slope) * 14;

        let conv = T * (0.4 + c.water[k] * 0.6) * 0.5 * (1 + 2.5 * pressure);
        if (this.anomaly?.kind === 'supercell' && this.near(i, j, 2)) conv *= 3;
        this.convection[k] = conv;

        const lift = Math.min(0.8, Math.max(-0.6,
          0.45 * this.verticalMotion(i, j) + oro + conv * 0.3));
        const cap = Math.max(0.05, (0.18 + 0.7 * T) * (1 - lift));
        if (nv[k] > cap) {
          const d = (nv[k] - cap) * Math.min(1, 2 * dt);
          nv[k] -= d; nc[k] += d;
        } else {
          const d = Math.min(nc[k], (cap - nv[k]) * 1.5 * dt);
          nc[k] -= d; nv[k] += d;
        }

        let p = 0;
        if (nc[k] > 0.45) { p = (nc[k] - 0.45) * 0.35 * dt; nc[k] -= p; }
        this.precip[k] = p / dt;
        this.snow[k] = !this.ablate.cold && T < COLD ? 1 : 0;
        if (this.anomaly?.kind === 'clearing' && this.near(i, j, 3)) nc[k] *= 1 - Math.min(1, 0.8 * dt);

        nv[k] = Math.min(2, nv[k] * (1 - 0.01 * dt));
        na[k] = Math.min(1.2, na[k] * (1 - 0.05 * dt) + c.ashEmit[k] * 0.5 * dt);
        ns[k] = Math.min(1, Math.max(0,
          ns[k] * (1 - 0.02 * dt - this.precip[k] * 0.8 * dt) + c.smogEmit[k] * 0.003 * dt));
        nc[k] = Math.min(1.4, nc[k]);
      }
    }

    // Rotate buffers: prev <- current, current <- next, next <- old prev.
    let t = this.prevCloud; this.prevCloud = this.cloud; this.cloud = nc; this.nc = t;
    t = this.prevAsh; this.prevAsh = this.ash; this.ash = na; this.na = t;
    t = this.prevSmog; this.prevSmog = this.smog; this.smog = ns; this.ns = t;
    t = this.vapour; this.vapour = nv; this.nv = t;

    this.scheduleAnomaly();
  }

  private scheduleAnomaly(): void {
    if (this.ablate.anomalies) return;
    if (this.anomaly && this.time >= this.anomaly.until) this.anomaly = null;
    if (this.anomaly || this.time < this.nextAnomaly) return;
    const r = this.anomalyRng;
    const roll = r();
    const kind: AnomalyKind = roll < 0.4 ? 'supercell' : roll < 0.7 ? 'reversal' : 'clearing';
    const dur = kind === 'supercell' ? 60 : kind === 'reversal' ? 30 : 45;
    this.anomaly = { kind, i: Math.floor(r() * WX_NX), j: 6 + Math.floor(r() * (WX_NY - 12)), until: this.time + dur };
    this.anomalyCount++;
    this.nextAnomaly = this.time + 300 + r() * 300;
  }

  warmUp(steps = WX_WARMUP): void {
    for (let n = 0; n < steps; n++) this.step(WX_DT);
  }
}

/** What the sky at field cell k reads as. Kinds fall out of the channels. */
export function kindAt(sim: WeatherSim, k: number): number {
  const c = sim.cloud[k], a = sim.ash[k], s = sim.smog[k];
  if (c + a + s < 0.05) return WK.CLEAR;
  if (a >= c && a >= s) return WK.ASH;
  if (s > 0.25 && s > c * 1.5) return WK.SMOG;
  if (c > 0.75 && sim.convection[k] > 0.45) return WK.STORM;
  if (sim.snow[k]) return WK.ICE;
  return WK.CUMULUS;
}
```

- [ ] **Step 4: Run — every metric passes and every control fails**

Run: `node_modules/.bin/esbuild tools/weatherCheck.ts --bundle --platform=node --format=esm --outfile="$TEMP/wx.mjs" --log-level=error && node --expose-gc "$TEMP/wx.mjs" --quick; echo exit $?`
Expected: exit 0 — every `PASS`, including every `control:` line (a control line PASSES when the control fails its metric). Then run without `--quick` (several minutes) and expect exit 0.

If a physics metric fails: first confirm its control fails too (the metric can bite), then tune the named constant in `WeatherSim.step` that governs it — storm threshold `0.45` in `kindAt`, orographic gain `14`, precip threshold `0.45`, vertical-motion weights — and look at the result in Task 6's preview before committing the value. Record every tuned constant and the before/after metric in the commit message. If a **control** passes its metric, the metric is wrong: stop and fix the metric.

- [ ] **Step 5: Typecheck and commit**

`tsc` count → `2`.

```bash
git add src/rendering/weather/WeatherSim.ts tools/weatherCheck.ts
git commit -m "feat(weather): the sim — band winds, vertical motion, orographic rain, vents, smog, storms

Each metric shown failing on its ablation: <paste the metric/control numbers>.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Rare anomalies are rare and deterministic

The scheduling code shipped in Task 2 (`scheduleAnomaly`); this task proves its contract.

**Files:**
- Modify: `tools/weatherCheck.ts`

- [ ] **Step 1: Write the check**

Before the final `console.log`:

```ts
// ─── 3. Anomalies ─────────────────────────────────────────────────────────────
console.log('\n  ANOMALIES');
{
  const TWO_HOURS = 7200 / WX_DT;
  const counts: number[] = [];
  let deterministic = true;
  for (const seed of SEEDS.slice(0, 3)) {
    const c = buildClimate(input(generatePlanetGrid('ocean', seed * 7777, null, null), 'ocean', seed));
    const a = new WeatherSim(c), b = new WeatherSim(c);
    const kindsA: string[] = [], kindsB: string[] = [];
    for (let n = 0; n < TWO_HOURS; n++) {
      a.step(WX_DT); b.step(WX_DT);
      if (a.anomaly && a.anomaly.until - a.time > 29.9) kindsA.push(`${a.anomaly.kind}@${a.anomaly.i},${a.anomaly.j}`);
      if (b.anomaly && b.anomaly.until - b.time > 29.9) kindsB.push(`${b.anomaly.kind}@${b.anomaly.i},${b.anomaly.j}`);
    }
    counts.push(a.anomalyCount);
    if (kindsA.join('|') !== kindsB.join('|')) deterministic = false;
  }
  check('anomalies: 12-24 per two hours', counts.every(n => n >= 12 && n <= 24), counts.join(', '));
  check('anomalies are deterministic', deterministic, '');
  const off = new WeatherSim(buildClimate(input(generatePlanetGrid('ocean', 7777, null, null), 'ocean', 1)), { anomalies: true });
  for (let n = 0; n < TWO_HOURS; n++) off.step(WX_DT);
  check('  control: ablated schedule fires none', off.anomalyCount === 0, `${off.anomalyCount}`);
}
```

- [ ] **Step 2: Run** — expected exit 0 with three PASS lines (counts near 16). If counts fall outside 12-24, the schedule constants (`300 + r() * 300`) disagree with the spec — report, do not change the range.

- [ ] **Step 3: Commit**

```bash
git add tools/weatherCheck.ts
git commit -m "test(weather): anomalies are rare, bounded and deterministic

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The painter

**Files:**
- Create: `src/rendering/weather/WeatherPainter.ts`
- Modify: `tools/weatherCheck.ts`

**Interfaces:**
- Consumes: `WeatherSim` (fields + `baseWindU`, `time`), `kindAt`, `WK`, `sampleField`, `fieldIndex`, `WX_DT`, `ClimateSources`, `CELL_COLS`, `CELL_ROWS`, `weatherRng`.
- Produces: `interface ImageDataLike { width: number; height: number; data: Uint8ClampedArray }`; `interface WeatherLut { count: number; px: Int16Array; py: Int16Array; ground: Int16Array; fx: Float32Array; fy: Float32Array; dx: Float32Array }`; `buildWeatherLut(geom: { cx: number; cyTop: number; rx: number; ry: number }, project: (dx: number, dy: number) => { row: number; col: number } | null, groundLift: (row: number, col: number, r: number) => number): WeatherLut`; `class WeatherPainter` — `constructor(lut: WeatherLut, climate: ClimateSources, cloudLift: number, seed: number)`, `setClimate(c)`, `onStep(sim)`, `prepare(sim, t: number, dt: number)`, `paintShadows(img, sunAzimuth, intensity)`, `paintClouds(img, sunAzimuth, intensity)`, public read-only `pCount`, `pX`, `pY`, `pGround`, `pSpawn`, `flashesTotal`, `stats: { drawn: number; midOrDense: number }`.

- [ ] **Step 1: Write the painter checks**

Add imports:

```ts
import {
  WeatherPainter, buildWeatherLut, type WeatherLut,
} from '../src/rendering/weather/WeatherPainter';
```

Before the final `console.log`:

```ts
// ─── 4. Painter ───────────────────────────────────────────────────────────────
console.log('\n  PAINTER');
// A 480x260 canvas like the real renderer's, face rx 150 / ry 78, and an
// azimuthal projection centred on the equator (as habitableDioramaCheck does).
const PW = 480, PH = 260;
const pgeom = { cx: 240, cyTop: 140, rx: 150, ry: 78 };
const project = (dx: number, dy: number) => {
  const r = Math.hypot(dx, dy);
  if (r > 1) return null;
  const c = r * (Math.PI / 2), sinC = Math.sin(c), cosC = Math.cos(c);
  const ny = -dy;
  const lat = r < 1e-6 ? 0 : Math.asin(Math.max(-1, Math.min(1, (ny * sinC) / r)));
  const lon = Math.atan2(dx * sinC, r * cosC);
  const v = 0.5 - lat / Math.PI, u = ((lon / (Math.PI * 2)) % 1 + 1) % 1;
  return { row: Math.max(0, Math.min(GRID_SIZE - 1, Math.round(v * (GRID_SIZE - 1)))),
           col: Math.min(GRID_SIZE - 1, Math.floor(u * GRID_SIZE)) };
};
function painterFor(type: string, seed: number, over: Partial<ClimateInput> = {}, opts: object = {}) {
  const grid = generatePlanetGrid(type, seed * 7777, null, null);
  const lift = (row: number, col: number) => grid[row][col].elevation >= SEA_LEVEL ? Math.round((grid[row][col].elevation - SEA_LEVEL) * 30) : 0;
  const lut = buildWeatherLut(pgeom, project, (row, col) => lift(row, col));
  const c = buildClimate(input(grid, type, seed, over), opts);
  const sim = new WeatherSim(c); sim.warmUp(WX_WARMUP);
  const painter = new WeatherPainter(lut, c, 24, seed);
  const img = { width: PW, height: PH, data: new Uint8ClampedArray(PW * PH * 4) };
  const shadow = { width: PW, height: PH, data: new Uint8ClampedArray(PW * PH * 4) };
  let acc = 0;
  const frame = (dt = 1 / 60) => {
    acc += dt;
    while (acc >= WX_DT) { acc -= WX_DT; sim.step(WX_DT); painter.onStep(sim); }
    painter.prepare(sim, acc / WX_DT, dt);
    img.data.fill(0); shadow.data.fill(0);
    painter.paintShadows(shadow, 0.6, 1);
    painter.paintClouds(img, 0.6, 1);
  };
  return { lut, c, sim, painter, img, shadow, frame };
}
{
  // Terrain stays readable.
  const TYPES = ['ocean', 'rocky', 'ice', 'lava', 'desert', 'storm', 'toxic', 'carbon', 'crystal'];
  const shareOf = (type: string, seed: number, opts: object = {}) => {
    const p = painterFor(type, seed, {}, opts);
    let sum = 0;
    for (let f = 0; f < 60; f++) { p.frame(); sum += p.painter.stats.midOrDense / p.lut.count; }
    return sum / 60;
  };
  let readable = true, detail = '';
  for (const t of TYPES) {
    const shares = SEEDS.slice(0, QUICK ? 3 : 12).map(s => shareOf(t, s)).sort((a, b) => a - b);
    const med = shares[Math.floor(shares.length / 2)], max = shares[shares.length - 1];
    detail += `${t} ${(med * 100).toFixed(0)}/${(max * 100).toFixed(0)}% `;
    if (med > 0.55 || max > 0.70) readable = false;
    if (t === 'ocean' && med < 0.10) readable = false;
  }
  check('terrain stays readable (median/max)', readable, detail);
  const blanket = shareOf('lava', 7, { ashFloor: 0.12 });
  check('  control: lava ash floor hides the face', blanket > 0.70, `${(blanket * 100).toFixed(0)}% > 70%`);

  // Storm reads in a still frame.
  const stormStats = (over: Partial<ClimateInput>) => {
    const p = painterFor('storm', 7, over);
    let minLive = Infinity; const f0 = p.painter.flashesTotal;
    for (let f = 0; f < 60 * 60; f++) { p.frame(); if (f % 30 === 0) minLive = Math.min(minLive, p.painter.pCount); }
    return { minLive, flashesPer5s: (p.painter.flashesTotal - f0) / 12 };
  };
  // -0.6 cancels the storm type's +0.6 base, so stormPressure clamps to 0.
  const st = stormStats({}), stCalm = stormStats({ extinctionPressure: -0.6 });
  check('storm world: rain always visible', st.minLive >= 40, `min live particles ${st.minLive} >= 40`);
  check('storm world: lightning every few seconds', st.flashesPer5s >= 1, `${st.flashesPer5s.toFixed(1)} per 5 s`);
  check('  control: calm storm world has no lightning', !(stCalm.flashesPer5s >= 1 && stCalm.minLive >= 40),
    `${stCalm.flashesPer5s.toFixed(1)} per 5 s, min live ${stCalm.minLive}`);

  // Rain lands on the ground; painter stays in bounds.
  const p = painterFor('storm', 42);
  let offGround = 0, outOfBounds = 0;
  const allowed = new Uint8Array(PW * PH);
  for (let n = 0; n < p.lut.count; n++) {
    const x = p.lut.px[n];
    const yTop = p.lut.py[n] - 24 - 4, yBot = Math.max(p.lut.py[n], p.lut.ground[n]) + 1;
    for (let xx = x - 3; xx <= x + 3; xx++) for (let y = yTop; y <= yBot; y++) {
      if (xx >= 0 && y >= 0 && xx < PW && y < PH) allowed[y * PW + xx] = 1;
    }
  }
  for (let f = 0; f < 600; f++) {
    p.frame();
    for (let q = 0; q < p.painter.pCount; q++) {
      if (p.painter.pY[q] > p.painter.pGround[q] || p.painter.pGround[q] !== p.lut.ground[p.painter.pSpawn[q]]) offGround++;
    }
    for (let k = 0; k < PW * PH; k++) {
      if ((p.img.data[k * 4 + 3] || p.shadow.data[k * 4 + 3]) && !allowed[k]) outOfBounds++;
    }
  }
  check('rain lands on the ground under its cloud', offGround === 0, `${offGround} violations`);
  check('painter stays on the face + cloud band', outOfBounds === 0, `${outOfBounds} stray pixels`);

  // No per-frame allocation.
  const gcFn = (globalThis as any).gc as (() => void) | undefined;
  if (!gcFn) {
    check('no per-frame allocation', false, 'run with node --expose-gc');
  } else {
    const q = painterFor('ocean', 7);
    for (let f = 0; f < 100; f++) q.frame();
    gcFn(); const h0 = process.memoryUsage().heapUsed;
    for (let f = 0; f < 1000; f++) q.frame();
    const grew = process.memoryUsage().heapUsed - h0;
    check('no per-frame allocation', grew < 64 * 1024, `heap +${(grew / 1024).toFixed(1)} KB over 1000 frames`);
  }

  // Headless cost (informational — the gate is measured in the preview, Task 6).
  const b = painterFor('ocean', 7);
  const times: number[] = [];
  for (let f = 0; f < 200; f++) { const t0 = performance.now(); b.frame(); times.push(performance.now() - t0); }
  times.sort((x, y) => x - y);
  console.log(`  info  headless frame (sim amortised + paint) median ${times[100].toFixed(2)} ms`);
}
```

- [ ] **Step 2: Run — must fail to build** (`WeatherPainter` does not exist).

- [ ] **Step 3: Implement `WeatherPainter.ts`**

Create `src/rendering/weather/WeatherPainter.ts`:

```ts
/**
 * Paints the weather sim onto the diorama face.
 *
 * Zero allocation per frame: every buffer is created at construction or when
 * the lookup changes. The prototype allocated ~100k small arrays per frame and
 * the frame rate hitched (2026-09-26). tools/weatherCheck measures the heap.
 */
import { CELL_COLS, CELL_ROWS, WX_NX, WX_NY, WX_N, type ClimateSources } from './WeatherClimate';
import { WeatherSim, WX_DT, WK, kindAt, sampleField, fieldIndex } from './WeatherSim';

export interface ImageDataLike { width: number; height: number; data: Uint8ClampedArray }

/** Per face pixel: where it is, where its ground is, where it sits in the field. */
export interface WeatherLut {
  count: number;
  px: Int16Array; py: Int16Array;
  /** Terrain-top y on screen: py - lift. */
  ground: Int16Array;
  /** Continuous field coordinates. */
  fx: Float32Array; fy: Float32Array;
  /** Disc x, -1..1, for lighting. */
  dx: Float32Array;
}

export function buildWeatherLut(
  geom: { cx: number; cyTop: number; rx: number; ry: number },
  project: (dx: number, dy: number) => { row: number; col: number } | null,
  groundLift: (row: number, col: number, r: number) => number,
): WeatherLut {
  const px: number[] = [], py: number[] = [], ground: number[] = [];
  const fx: number[] = [], fy: number[] = [], ddx: number[] = [];
  const { cx, cyTop, rx, ry } = geom;
  for (let y = Math.floor(cyTop - ry); y <= Math.ceil(cyTop + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx, dy = (y - cyTop) / ry;
      const r = Math.hypot(dx, dy);
      if (r > 1) continue;
      const gp = project(dx, dy);
      if (!gp) continue;
      px.push(x); py.push(y);
      ground.push(y - groundLift(gp.row, gp.col, r));
      fx.push((gp.col + 0.5) / CELL_COLS - 0.5);
      fy.push((gp.row + 0.5) / CELL_ROWS - 0.5);
      ddx.push(dx);
    }
  }
  return {
    count: px.length,
    px: Int16Array.from(px), py: Int16Array.from(py), ground: Int16Array.from(ground),
    fx: Float32Array.from(fx), fy: Float32Array.from(fy), dx: Float32Array.from(ddx),
  };
}

const LEVEL_ALPHA = [0, 0.5, 0.75, 0.95];
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);
/** body rgb, under rgb — per WK kind. Carried over from the legacy CLOUD_PROFILES. */
const PAL = [
  0, 0, 0, 0, 0, 0,                       // CLEAR (unused)
  252, 252, 255, 150, 176, 212,           // CUMULUS
  128, 134, 150, 48, 54, 70,              // STORM
  230, 244, 252, 160, 196, 224,           // ICE
  110, 100, 96, 42, 36, 36,               // ASH
  168, 146, 112, 86, 72, 56,              // SMOG
];
const ACID = [206, 224, 120, 120, 140, 48];
/** Precipitation kinds: rain, acid rain, snow, ash — the legacy PRECIP_STYLE. */
const P_SPEED = [62, 54, 14, 20];
const P_LEN = [3, 3, 1, 1];
const P_RGBA = [150, 190, 232, 0.55, 190, 222, 105, 0.6, 240, 250, 255, 0.8, 64, 56, 54, 0.75];
const PMAX = 320, FMAX = 8;
const RAIN_SPAWN = 1.0;
const FLASH_CHANCE = 0.02;
const DT_W = 128, DT_H = 64, DT_PER_CELL = 2;

function over(d: Uint8ClampedArray, o: number, r: number, g: number, b: number, a: number): void {
  if (a <= 0) return;
  const ea = d[o + 3] / 255, oa = a + ea * (1 - a);
  d[o] = (r * a + d[o] * ea * (1 - a)) / oa;
  d[o + 1] = (g * a + d[o + 1] * ea * (1 - a)) / oa;
  d[o + 2] = (b * a + d[o + 2] * ea * (1 - a)) / oa;
  d[o + 3] = oa * 255;
}

export class WeatherPainter {
  pCount = 0;
  readonly pX = new Float32Array(PMAX);
  readonly pY = new Float32Array(PMAX);
  readonly pGround = new Float32Array(PMAX);
  readonly pSpawn = new Int32Array(PMAX);
  private pPhase = new Float32Array(PMAX);
  private pKind = new Uint8Array(PMAX);
  private fCount = 0;
  private fX = new Float32Array(FMAX);
  private fY = new Float32Array(FMAX);
  private fGround = new Float32Array(FMAX);
  private fLife = new Float32Array(FMAX);
  private fSeed = new Uint32Array(FMAX);
  flashesTotal = 0;
  readonly stats = { drawn: 0, midOrDense: 0 };

  private dens = new Float32Array(WX_N);
  private cloudNow = new Float32Array(WX_N);
  private kind = new Uint8Array(WX_N);
  private shift = new Float32Array(WX_NY);
  private detail = new Float32Array(DT_W * DT_H);
  private rng: number;

  constructor(
    private lut: WeatherLut, private climate: ClimateSources,
    readonly cloudLift: number, seed: number,
  ) {
    this.rng = (seed >>> 0) || 1;
    this.bakeDetail(seed);
  }

  setClimate(c: ClimateSources): void { this.climate = c; }

  private next(): number {
    this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0;
    return this.rng / 4294967296;
  }

  /** Tileable two-octave value noise, isotropic in field space. */
  private bakeDetail(seed: number): void {
    const lattice = (x: number, y: number, period: number) => {
      const xi = ((x % period) + period) % period, yi = ((y % period) + period) % period;
      let h = (Math.imul(xi, 374761393) + Math.imul(yi, 668265263) + Math.imul(seed | 0, 97)) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    const octave = (x: number, y: number, cell: number) => {
      const gx = x / cell, gy = y / cell, i = Math.floor(gx), j = Math.floor(gy);
      const tx = gx - i, ty = gy - j, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const pw = DT_W / cell;
      const a = lattice(i, j, pw), b = lattice(i + 1, j, pw), c = lattice(i, j + 1, pw), d = lattice(i + 1, j + 1, pw);
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    };
    for (let y = 0; y < DT_H; y++) for (let x = 0; x < DT_W; x++) {
      this.detail[y * DT_W + x] = 0.65 * octave(x, y, 8) + 0.35 * octave(x, y, 4);
    }
  }

  private detailAt(x: number, y: number): number {
    const j = y < 0 ? 0 : y > WX_NY - 1 ? WX_NY - 1 : Math.round(y);
    const tx = (x - this.shift[j] + this.climate.personality.detailOffset) * DT_PER_CELL;
    const ty = y * DT_PER_CELL;
    const i0 = Math.floor(tx), j0 = Math.floor(ty), fx = tx - i0, fy = ty - j0;
    const a = ((i0 % DT_W) + DT_W) % DT_W, b = (a + 1) % DT_W;
    const r0 = (((j0 % DT_H) + DT_H) % DT_H) * DT_W, r1 = (((j0 + 1) % DT_H + DT_H) % DT_H) * DT_W;
    const t = this.detail;
    return t[r0 + a] * (1 - fx) * (1 - fy) + t[r0 + b] * fx * (1 - fy) + t[r1 + a] * (1 - fx) * fy + t[r1 + b] * fx * fy;
  }

  private spawn(n: number, kind: number): void {
    const q = this.pCount++;
    this.pX[q] = this.lut.px[n];
    this.pY[q] = this.lut.py[n] - this.cloudLift + 2;
    this.pGround[q] = this.lut.ground[n];
    this.pSpawn[q] = n;
    this.pPhase[q] = this.next() * 6.28;
    this.pKind[q] = kind;
    // A particle already at or below its ground dies on the next prepare().
  }

  /** Once per sim step: spawn precipitation and lightning from the new state. */
  onStep(sim: WeatherSim): void {
    const lut = this.lut;
    const stride = 29;
    for (let n = Math.floor(this.next() * stride); n < lut.count; n += stride) {
      const k = fieldIndex(lut.fx[n], lut.fy[n]);
      const p = sim.precip[k];
      if (p > 0.004 && this.pCount < PMAX && this.next() < p * RAIN_SPAWN * stride / 4) {
        this.spawn(n, sim.snow[k] ? 2 : this.climate.acid > 0.5 ? 1 : 0);
      }
      if (sim.ash[k] > 0.35 && this.pCount < PMAX && this.next() < 0.05) this.spawn(n, 3);
      if (this.fCount < FMAX && (kindAt(sim, k) === WK.STORM || sim.ash[k] > 0.7) && this.next() < FLASH_CHANCE) {
        const f = this.fCount++;
        this.fX[f] = lut.px[n]; this.fY[f] = lut.py[n] - this.cloudLift;
        this.fGround[f] = lut.ground[n]; this.fLife[f] = 0.09;
        this.fSeed[f] = (this.next() * 4294967296) >>> 0;
        this.flashesTotal++;
      }
    }
  }

  /** Once per frame, before painting: interpolate the field, move particles. */
  prepare(sim: WeatherSim, t: number, dt: number): void {
    const simTime = sim.time - (1 - t) * WX_DT;
    for (let k = 0; k < WX_N; k++) {
      const c = sim.prevCloud[k] + (sim.cloud[k] - sim.prevCloud[k]) * t;
      const a = sim.prevAsh[k] + (sim.ash[k] - sim.prevAsh[k]) * t;
      const s = sim.prevSmog[k] + (sim.smog[k] - sim.prevSmog[k]) * t;
      this.cloudNow[k] = c;
      this.dens[k] = c * 1.5 + a * 0.9 + s * 0.8;
      this.kind[k] = kindAt(sim, k);
    }
    for (let j = 0; j < WX_NY; j++) this.shift[j] = sim.baseWindU(j) * simTime;
    for (let q = this.pCount - 1; q >= 0; q--) {
      const kind = this.pKind[q];
      this.pY[q] += P_SPEED[kind] * dt;
      this.pPhase[q] += dt * 2.2;
      if (this.pY[q] >= this.pGround[q]) {
        const last = --this.pCount;
        this.pX[q] = this.pX[last]; this.pY[q] = this.pY[last]; this.pGround[q] = this.pGround[last];
        this.pSpawn[q] = this.pSpawn[last]; this.pPhase[q] = this.pPhase[last]; this.pKind[q] = this.pKind[last];
      }
    }
    for (let f = this.fCount - 1; f >= 0; f--) {
      this.fLife[f] -= dt;
      if (this.fLife[f] <= 0) {
        const last = --this.fCount;
        this.fX[f] = this.fX[last]; this.fY[f] = this.fY[last]; this.fGround[f] = this.fGround[last];
        this.fLife[f] = this.fLife[last]; this.fSeed[f] = this.fSeed[last];
      }
    }
  }

  /** Cloud shadows on the terrain, into the day/night image. Day side only. */
  paintShadows(img: ImageDataLike, sunAzimuth: number, intensity: number): void {
    const lut = this.lut, d = img.data, w = img.width, h = img.height;
    const sunX = Math.cos(sunAzimuth);
    for (let n = 0; n < lut.count; n++) {
      const lit = Math.max(0, Math.min(1, 0.5 + lut.dx[n] * sunX));
      if (lit <= 0.3) continue;
      const dd = sampleField(this.dens, lut.fx[n] - sunX * 0.9, lut.fy[n]) * 0.8;
      if (dd <= 0.3) continue;
      const x = lut.px[n], y = lut.ground[n];
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      over(d, (y * w + x) * 4, 10, 14, 30, 0.22 * Math.min(1, dd) * lit * intensity);
    }
  }

  /** Precipitation, then cloud, then lightning. */
  paintClouds(img: ImageDataLike, sunAzimuth: number, intensity: number): void {
    const lut = this.lut, d = img.data, w = img.width, h = img.height;
    const sunX = Math.cos(sunAzimuth);
    this.stats.drawn = 0; this.stats.midOrDense = 0;

    for (let q = 0; q < this.pCount; q++) {
      const kind = this.pKind[q];
      const drift = kind >= 2 ? Math.sin(this.pPhase[q]) * 1.5 : 0;
      const x = Math.round(this.pX[q] + drift), y0 = Math.round(this.pY[q]);
      const o4 = kind * 4;
      for (let l = 0; l < P_LEN[kind]; l++) {
        const y = y0 + l;
        if (x < 0 || y < 0 || x >= w || y >= h || y > this.pGround[q]) continue;
        over(d, (y * w + x) * 4, P_RGBA[o4], P_RGBA[o4 + 1], P_RGBA[o4 + 2], P_RGBA[o4 + 3] * intensity);
      }
    }

    const acid = this.climate.acid, neb = this.climate.nebula;
    for (let n = 0; n < lut.count; n++) {
      const x = lut.px[n], y = lut.py[n] - this.cloudLift;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const fx = lut.fx[n], fy = lut.fy[n];
      const det = this.detailAt(fx, fy);
      const dd = sampleField(this.dens, fx, fy) * (0.2 + 1.6 * det * det);
      if (dd < 0.34) continue;
      const b = BAYER4[(y & 3) * 4 + (x & 3)];
      const lv = (dd > 0.39 ? 1 : (dd - 0.34) / 0.05 > b ? 1 : 0)
               + (dd > 0.54 ? 1 : dd > 0.5 && (dd - 0.5) / 0.04 > b ? 1 : 0)
               + (dd > 0.74 ? 1 : dd > 0.7 && (dd - 0.7) / 0.04 > b ? 1 : 0);
      if (lv === 0) continue;
      this.stats.drawn++;
      if (lv >= 2) this.stats.midOrDense++;
      const k = fieldIndex(fx, fy), kind = this.kind[k];
      const facing = sampleField(this.cloudNow, fx + sunX * 0.35, fy - 0.15) < this.cloudNow[k];
      let o = kind * 6 + (facing ? 0 : 3);
      let r = PAL[o], g = PAL[o + 1], bl = PAL[o + 2];
      if (acid > 0 && (kind === WK.CUMULUS || kind === WK.STORM)) {
        o = facing ? 0 : 3;
        r += (ACID[o] - r) * acid; g += (ACID[o + 1] - g) * acid; bl += (ACID[o + 2] - bl) * acid;
      }
      const lit = 0.35 + 0.65 * Math.max(0, Math.min(1, 0.5 + lut.dx[n] * sunX));
      r *= lit; g *= lit; bl *= lit;
      if (neb > 0 && facing && kind === WK.CUMULUS) { r += 40 * neb; g += 10 * neb; bl += 60 * neb; }
      over(d, (y * w + x) * 4, r, g, bl, LEVEL_ALPHA[lv] * intensity);
    }

    for (let f = 0; f < this.fCount; f++) {
      let s = this.fSeed[f], bx = this.fX[f];
      const x0 = this.fX[f];
      for (let y = Math.round(this.fY[f]); y < this.fGround[f]; y++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const r = s / 4294967296;
        if (r < 0.15) bx--; else if (r > 0.85) bx++;
        if (bx < x0 - 3) bx = x0 - 3; else if (bx > x0 + 3) bx = x0 + 3;
        if (bx >= 0 && y >= 0 && bx < w && y < h) over(d, (y * w + bx) * 4, 255, 255, 230, 0.95 * intensity);
      }
      const fy = Math.round(this.fY[f]);
      for (let oy = -3; oy <= 3; oy++) for (let ox = -3; ox <= 3; ox++) {
        const x = x0 + ox, y = fy + oy;
        const fall = 1 - Math.hypot(ox / 3, oy / 3);
        if (fall <= 0 || x < 0 || y < 0 || x >= w || y >= h) continue;
        over(d, (y * w + x) * 4, 230, 235, 255, 0.35 * fall * intensity);
      }
    }
  }
}
```

Note: the flash halo is clamped to ±3 px so it stays inside the bounds invariant's ±3 column band.

- [ ] **Step 3b: Remove the `lattice`/`octave` closures from the per-frame path**

They are created only in `bakeDetail` (construction), which is allowed. Confirm no closure or array literal appears in `onStep`, `prepare`, `paintShadows`, `paintClouds`, `detailAt`, `spawn` or `over`.

- [ ] **Step 4: Run — all painter checks pass**

Run: `node_modules/.bin/esbuild tools/weatherCheck.ts --bundle --platform=node --format=esm --outfile="$TEMP/wx.mjs" --log-level=error && node --expose-gc "$TEMP/wx.mjs" --quick; echo exit $?`
Expected: exit 0. If `terrain stays readable` fails for a type, look at the numbers per type and tune the density→level thresholds (`0.34/0.5/0.7`) or the detail contrast (`0.2 + 1.6·det²`) — never the 55/70% gate. If `storm world` fails, tune `RAIN_SPAWN` / `FLASH_CHANCE`. Record tuned values in the commit.

- [ ] **Step 5: Commit**

```bash
git add src/rendering/weather/WeatherPainter.ts tools/weatherCheck.ts
git commit -m "feat(weather): painter — stepped pixel-art cloud layer, shadows, rain that lands, lightning, zero-alloc

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Engine integration — replace the wisps

**Files:**
- Modify: `src/rendering/HabitableCutawayEngine.ts` (imports; `HabitableFrameInput` ~line 1740; `Wisp`, `WISP_COLOURS`, `makeWispSprite` ~1672-1770; class fields ~1777-1802; `bake` ~1814-1849; `frame` ~1872-1930; `resizeLayers`, `bakeAirMask`, `rebuildWisps`, `drawWisps` ~1975-2045)
- Modify: `tools/habitableDioramaCheck.ts` (four `engine.frame` calls; new checks)

**Interfaces:**
- Consumes: `buildClimate`, `ClimateSources`, `WeatherSim`, `WX_DT`, `WX_WARMUP`, `WeatherPainter`, `buildWeatherLut`.
- Produces: `CutawayBakeOpts`-extension `weather?: ClimateSources | null` on `bake()` (replaces `weatherMix`); `HabitableFrameInput` loses `weatherMix` and `drawOverlays`, gains `drawSurfaceOverlays: (g) => void` and `drawUiOverlays: (g) => void`; `setWeatherClimate(c: ClimateSources | null): void`.

- [ ] **Step 1: Write the engine checks**

In `tools/habitableDioramaCheck.ts`, replace each of the four occurrences of

```ts
    drawFarSpace: () => {}, drawOverlays: () => {}, drawNearMoons: () => {},
    weatherMix: [],
```

with

```ts
    drawFarSpace: () => {}, drawSurfaceOverlays: () => {}, drawUiOverlays: () => {}, drawNearMoons: () => {},
```

At the top, add:

```ts
const { buildClimate } = await import('../src/rendering/weather/WeatherClimate');
```

In the `engine.bake({...})` call inside the per-type loop, add after `maxLift: MAX_LIFT, lush: 0.6,`:

```ts
    weather: planetType === 'gas' ? null : buildClimate({
      grid, planetType, seed: 0xbeef, lush: 0.6, extinctionPressure: 0.1,
      oxygenLevel: 0.6, civLevel: 0, inNebula: false,
    }),
```

After the `frame reuses live ImageData` check, add:

```ts
  // Weather replaces the wisps.
  const wx = engine as any;
  if (planetType === 'gas') {
    check('gas giant has no weather', wx.weatherSim === null, '');
  } else {
    check('weather sim built at bake', wx.weatherSim !== null && wx.weatherPainter !== null, '');
    const wImg = wx.weatherImage as { data: Uint8ClampedArray } | null;
    const painted = !!wImg && wImg.data.some((v: number, i: number) => i % 4 === 3 && v > 0);
    check('weather layer paints something', painted || planetType === 'desert', planetType);

    // Review focus 1: a huge dt (tab refocused) runs at most 4 steps.
    const t0 = wx.weatherSim.time;
    engine.frame({ g: frameCtx as unknown as CanvasRenderingContext2D, dt: 30, elapsed: 40, bg: makeCanvas(VW, VH),
      drawFarSpace: () => {}, drawSurfaceOverlays: () => {}, drawUiOverlays: () => {}, drawNearMoons: () => {} } as any);
    const ran = Math.round((wx.weatherSim.time - t0) / 0.25);
    check('refocus runs at most 4 sim steps', ran <= 4, `${ran} steps`);

    // Review focus 3: new sources keep the sky.
    const before = wx.weatherSim.cloud.slice();
    engine.setWeatherClimate(buildClimate({ grid, planetType, seed: 0xbeef, lush: 0.9,
      extinctionPressure: 0.5, oxygenLevel: 0.6, civLevel: 5, inNebula: false }));
    check('climate update keeps the sky', wx.weatherSim.cloud.every((v: number, k: number) => v === before[k]), '');
  }
```

After the per-type loop (before the final summary), add the leak check (review focus 2) and the resize check (review focus 5):

```ts
{
  const grid = generatePlanetGrid('ocean', 0xbeef, null, null);
  const base = {
    discToGrid: makeProjection(0, 0), rimFalloff, liftOf, smoothElevation, maxLift: MAX_LIFT, lush: 0.6,
  };
  const climate = (seed: number) => buildClimate({ grid, planetType: 'ocean', seed, lush: 0.6,
    extinctionPressure: 0.1, oxygenLevel: 0.6, civLevel: 0, inNebula: false });
  const a = new HabitableCutawayEngine();
  a.bake({ w: VW, h: VH, seed: 1, grid, planetType: 'ocean', ...base, weather: climate(1) } as any);
  for (let f = 0; f < 120; f++) a.frame({ g: makeCanvas(VW, VH).getContext() as any, dt: 1 / 60, elapsed: f / 60,
    bg: makeCanvas(VW, VH), drawFarSpace: () => {}, drawSurfaceOverlays: () => {}, drawUiOverlays: () => {}, drawNearMoons: () => {} } as any);
  a.bake({ w: VW, h: VH, seed: 2, grid, planetType: 'ocean', ...base, weather: climate(2) } as any);
  const fresh = new HabitableCutawayEngine();
  fresh.bake({ w: VW, h: VH, seed: 2, grid, planetType: 'ocean', ...base, weather: climate(2) } as any);
  const same = (a as any).weatherSim.cloud.every((v: number, k: number) => v === (fresh as any).weatherSim.cloud[k]);
  check('no weather leaks between planets', same, '');

  const big = new HabitableCutawayEngine();
  big.bake({ w: 640, h: 360, seed: 3, grid, planetType: 'ocean', ...base, weather: climate(3) } as any);
  const lut = (big as any).weatherPainter.lut;
  let outside = 0;
  for (let n = 0; n < lut.count; n++) {
    const dx = (lut.px[n] - big.geom.cx) / big.geom.rx, dy = (lut.py[n] - big.geom.cyTop) / big.geom.ry;
    if (dx * dx + dy * dy > 1.0001) outside++;
  }
  check('resize rebuilds the weather lookup', outside === 0 && lut.count > 0, `${outside} lookup pixels off the face`);
}
```

(`makeProjection`, `rimFalloff`, `liftOf`, `smoothElevation`, `generatePlanetGrid` and `MAX_LIFT` already exist in this file.)

- [ ] **Step 2: Run — must fail**

Run habitableDioramaCheck. Expected: FAIL (`weather sim built at bake` — the engine has no `weatherSim`; the frame calls may throw on the missing `drawOverlays`). Record which.

- [ ] **Step 3: Engine changes**

In `HabitableCutawayEngine.ts`:

1. Imports (top):

```ts
import type { ClimateSources } from './weather/WeatherClimate';
import { WeatherSim, WX_DT, WX_WARMUP } from './weather/WeatherSim';
import { WeatherPainter, buildWeatherLut } from './weather/WeatherPainter';
```

2. Delete the whole `// ─── Wispy clouds ───` section: `makeWispSprite`, the `Wisp` interface and `WISP_COLOURS`.

3. In `HabitableFrameInput`, replace

```ts
  drawOverlays: (g: CanvasRenderingContext2D) => void;
```

with

```ts
  /** Drawn on the ground, under the weather: city lights, inhabitants. */
  drawSurfaceOverlays: (g: CanvasRenderingContext2D) => void;
  /** Drawn over everything but moons: tile markers, divine effects. Never under weather. */
  drawUiOverlays: (g: CanvasRenderingContext2D) => void;
```

and delete the `weatherMix` field.

4. Class fields: delete `wispScratch`, `airMask`, `wispG`, `wisps`, `lastWispSig`. Add:

```ts
  private weatherScratch = document.createElement('canvas');
  private weatherG: CanvasRenderingContext2D | null = null;
  private weatherImage: ImageData | null = null;
  private weatherSim: WeatherSim | null = null;
  private weatherPainter: WeatherPainter | null = null;
  private weatherAcc = 0;
```

5. `bake` signature: replace `weatherMix?: Array<{ kind: string; weight: number }>;` with `weather?: ClimateSources | null;`. Delete `this.wisps = [];` and `this.lastWispSig = '\0';`. Replace the final `this.rebuildWisps(opts.weatherMix ?? []);` with:

```ts
    // Weather: a fresh sim per bake — a new planet must never inherit the last
    // one's sky (the repo's recurring state-leak pattern).
    this.weatherSim = null;
    this.weatherPainter = null;
    this.weatherAcc = 0;
    const grid = opts.grid;
    if (opts.weather && grid && opts.planetType !== 'gas') {
      const lut = buildWeatherLut(this.geom, opts.discToGrid,
        (row, col, r) => opts.liftOf(opts.smoothElevation(grid, row, col) - opts.rimFalloff(r)));
      this.weatherSim = new WeatherSim(opts.weather);
      this.weatherSim.warmUp(WX_WARMUP);
      this.weatherPainter = new WeatherPainter(lut, opts.weather, (opts.maxLift ?? 18) + 6, opts.seed);
    }
```

6. Add the public method after `updateSurfaceOpts`:

```ts
  /** New climate sources (lushness, civ level, stress). Keeps the current sky. */
  setWeatherClimate(c: ClimateSources | null): void {
    if (!c || !this.weatherSim || !this.weatherPainter) return;
    this.weatherSim.setClimate(c);
    this.weatherPainter.setClimate(c);
  }
```

7. `frame()`: delete `this.rebuildWisps(input.weatherMix);`. Inside the `if (fluids)` block, replace

```ts
        paintDayNight(fluids, this.geom, sunAzimuth, layerBob);
```

with

```ts
        paintDayNight(fluids, this.geom, sunAzimuth, layerBob);
        if (this.weatherSim && this.weatherPainter) {
          // At most 4 steps per frame: a refocused tab hands us seconds of dt.
          this.weatherAcc = Math.min(this.weatherAcc + input.dt, WX_DT * 4);
          while (this.weatherAcc >= WX_DT) {
            this.weatherAcc -= WX_DT;
            this.weatherSim.step(WX_DT);
            this.weatherPainter.onStep(this.weatherSim);
          }
          this.weatherPainter.prepare(this.weatherSim, this.weatherAcc / WX_DT, input.dt);
          this.weatherPainter.paintShadows(fluids, sunAzimuth, atmoHazeAmount(input.viewZoom ?? 1));
        }
```

Replace `input.drawOverlays(g);` with:

```ts
    input.drawSurfaceOverlays(g);
    const weatherHaze = atmoHazeAmount(input.viewZoom ?? 1);
    if (this.weatherPainter && this.weatherImage && this.weatherG && weatherHaze > 0.01) {
      this.weatherImage.data.fill(0);
      this.weatherPainter.paintClouds(this.weatherImage, sunAzimuth, weatherHaze);
      this.weatherG.putImageData(this.weatherImage, 0, 0);
      g.drawImage(this.weatherScratch, 0, 0);
    }
```

Delete the whole `const wispG = this.wispG; if (wispG && …) { … }` block. After the atmosphere block (after `g.drawImage(this.atmoScratch, 0, 0); }`) and before the front gas rings, add:

```ts
    input.drawUiOverlays(g);
```

8. `resizeLayers`: replace the `wispScratch` and `airMask` sizing lines and `this.wispG = …` and `this.bakeAirMask();` with:

```ts
    this.weatherScratch.width = w; this.weatherScratch.height = h;
    this.weatherG = this.weatherScratch.getContext('2d');
    this.weatherImage = this.weatherG?.createImageData(w, h) ?? null;
```

9. Delete `bakeAirMask`, `rebuildWisps` and `drawWisps`. Then `grep -n "airMask\|wisp\|Wisp" src/rendering/HabitableCutawayEngine.ts` — expected: no matches except comments you must also update (e.g. the atmosphere-pass comment in `ozoneAt` about `bakeAirMask`: change it to say the weather layer is masked by its lookup, not by `ozoneAt`).

- [ ] **Step 3b: Keep the host compiling (minimal adaptation)**

The frame-input change breaks `IsoDioramaRenderer`. Adapt it minimally here so every commit type-checks; Task 6 wires the real climate.

In `IsoDioramaRenderer.ts` `frame()` (~line 2479), replace

```ts
        drawOverlays: (g) => {
          this.drawCityLights(g, this.elapsed);
          this.drawInhabitants(g, this.elapsed);
          this.drawTileMarkers(g, this.elapsed);
          this.drawDivineEffects(g, dt);
        },
```

with

```ts
        drawSurfaceOverlays: (g) => {
          this.drawCityLights(g, this.elapsed);
          this.drawInhabitants(g, this.elapsed);
        },
        drawUiOverlays: (g) => {
          this.drawTileMarkers(g, this.elapsed);
          this.drawDivineEffects(g, dt);
        },
```

delete `weatherMix: this.cloudMixFor(),` from that object, and in `bakeHabitableCutaway` replace `weatherMix: this.cloudMixFor(),` with `weather: null, // wired in the host task`.

Run: `node_modules/.bin/tsc --noEmit -p . 2>&1 | grep -c "error TS"` → `2`.

- [ ] **Step 4: Run — engine checks pass**

Run habitableDioramaCheck. Expected: exit 0, including every new check. Run `weatherCheck --quick` and `atmosphereCheck` — exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/rendering/HabitableCutawayEngine.ts src/rendering/IsoDioramaRenderer.ts tools/habitableDioramaCheck.ts
git commit -m "feat(weather): engine owns the weather sim; wisps and airMask removed; overlays split around the weather

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Host integration — climate from the real world; the dead legacy clouds go

**Files:**
- Modify: `src/rendering/IsoDioramaRenderer.ts`

**Interfaces:**
- Consumes: `buildClimate`, `ClimateSources`, engine `bake({ weather })`, `setWeatherClimate`, `drawSurfaceOverlays`, `drawUiOverlays`.

- [ ] **Step 1: Build the climate**

Add import:

```ts
import { buildClimate, type ClimateSources } from './weather/WeatherClimate';
```

Add near `lushFor` (~line 1142):

```ts
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
```

In `bakeHabitableCutaway` replace `weather: null, // wired in the host task` with `weather: this.climateFor(),`.

In `rebakeHabitableSurface`, after `this.cutaway.rebakeSurface();` add:

```ts
    // Sources follow the world (industry, stress, lushness); the sky is kept.
    this.cutaway.setWeatherClimate(this.climateFor());
```

- [ ] **Step 2: (done in Task 5 Step 3b — overlays already split)**

Confirm: `grep -n "drawOverlays\|weatherMix" src/rendering/IsoDioramaRenderer.ts` prints nothing.

- [ ] **Step 3: Delete the dead legacy weather**

Delete, and confirm each is gone with grep afterwards:
- the `// ─── Weather ───` section: `CloudKind`, `PrecipKind`, `CloudProfile`, `CLOUD_PROFILES`, `PRECIP_STYLE`, `Drop` (~lines 280-360);
- `interface Cloud` (~line 420);
- fields `clouds` and `lastCloudSig`;
- methods `cloudMixFor`, `cloudMixSignature`, `buildClouds`, `drawClouds`, getter `weatherSummary`;
- the `this.buildClouds();` call in `bakeAll` (~line 1203);
- in the legacy render path, the `const sig = this.cloudMixSignature(); if (sig !== this.lastCloudSig) { … }` block (~2520) and `this.drawClouds(g, dt);` (~2590);
- function `makeCloudSprite` (~line 3272).

Keep `inNebula()` — the climate uses it.

Run: `grep -n "CloudKind\|CLOUD_PROFILES\|PRECIP_STYLE\|cloudMixFor\|buildClouds\|drawClouds\|makeCloudSprite\|weatherSummary\|lastCloudSig\|this\.clouds" src/rendering/IsoDioramaRenderer.ts`
Expected: no output.

- [ ] **Step 4: Typecheck and run everything**

`node_modules/.bin/tsc --noEmit -p . 2>&1 | grep -c "error TS"` → `2`. If higher, read the new errors — the most likely is a missed reference to a deleted symbol.
Run `weatherCheck --quick`, `habitableDioramaCheck`, `atmosphereCheck`, `surfaceDecalCheck` → exit 0 each.

- [ ] **Step 5: Look at it, and measure the budget**

`npm run dev`, open `http://localhost:3000/diorama-preview.html?type=ocean&seed=7`. In the page:

```js
const E = window.__diorama.cutaway, P = E.weatherPainter, S = E.weatherSim;
const img = E.weatherImage, day = new ImageData(img.width, img.height);
const t = [], s = [];
for (let i = 0; i < 60; i++) {
  const a = performance.now();
  P.prepare(S, 0.5, 1 / 60); P.paintShadows(day, 0.6, 1); img.data.fill(0); P.paintClouds(img, 0.6, 1);
  t.push(performance.now() - a);
}
for (let i = 0; i < 20; i++) { const a = performance.now(); S.step(0.25); s.push(performance.now() - a); }
t.sort((a, b) => a - b); s.sort((a, b) => a - b);
`paint median ${t[30].toFixed(2)} ms, step median ${s[10].toFixed(2)} ms`
```

Expected: paint ≤ 1.0 ms, step ≤ 0.5 ms. If paint is over, profile before tuning: the likely costs are `detailAt` and the three `sampleField` calls per pixel.

- [ ] **Step 6: Commit**

```bash
git add src/rendering/IsoDioramaRenderer.ts
git commit -m "feat(weather): climate from grid, stress, civ and genome seed; dead legacy clouds deleted

Preview budget: paint <ms> ms, step <ms> ms.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Whole-pass verification

- [ ] **Step 1: Full checks**

```
for t in weatherCheck habitableDioramaCheck atmosphereCheck genomeCheck surfaceDecalCheck smokeTest; do
  node_modules/.bin/esbuild tools/$t.ts --bundle --platform=node --format=esm --outfile="$TEMP/$t.mjs" --log-level=error && node --expose-gc "$TEMP/$t.mjs" > "$TEMP/$t.out" 2>&1; echo "$t exit $?"; done
node_modules/.bin/tsc --noEmit -p . 2>&1 | grep -c "error TS"
```

Expected: all exit 0 (full `weatherCheck`, not `--quick`); tsc `2`; smokeTest identical assertion-by-assertion to its result before Task 1 (this plan touches no simulation file — any difference is a finding).

- [ ] **Step 2: Pixels**

Preview, two seeds each: `ocean`, `rocky`, `ice`, `lava`, `desert`, `storm`, `toxic`, `carbon`, `crystal`, plus `gas` (no weather). For each: terrain readable; clouds float above the land, not printed on it; the night side is dark; shadows fall on the land on the day side. Specifically:
- a mountainous rocky seed shows wetter windward slopes and a clear lee;
- `ice` snows; `lava` shows plumes from a few vents, not a blanket;
- with the `civ` checkbox on, smog sits over the settlements only;
- `storm` reads as a storm in one screenshot (rain + a flash within a few seconds);
- tile markers and divine effects draw over the clouds; creatures and city lights under them.
Save zoomed screenshots of ocean, storm, lava and rocky for the report. Name anything that passes its metric but looks wrong.

- [ ] **Step 3: Memory**

Update `C:\Users\Sirjohn\.claude\projects\C--Users-Sirjohn-Documents-Eternal-System\memory\atmosphere-clouds-next.md` (weather shipped: commits, budget numbers, tuned constants), add `weatherCheck` to the table in `verification.md`, and record the two planning findings (grid T/M are type-independent; lava is 65% volcanic) in `architecture.md` or a new memory — they will bite anyone who builds on the grid's climate again.

- [ ] **Step 4: Report** to the user with numbers and screenshots.
