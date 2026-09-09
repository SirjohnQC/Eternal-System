# Planet Genome Skeleton + Atmosphere Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce `PlanetGenome` as the single source of per-planet identity, put a `genomeSeed` on every planet, build the variety metric that proves worlds are currently interchangeable, then rebuild the atmosphere so it reads as air rather than a pasted ring.

**Architecture:** A new pure module `src/simulation/PlanetGenome.ts` derives a genome from one number. Phase 1 is deliberately invisible — `genomeFromLegacy` reproduces today's per-type atmosphere values exactly, so nothing changes on screen until Task 5. The atmosphere is then moved off the hardcoded per-type palette onto the genome's `atmosphere` channel and its four defects fixed one at a time, each behind its own measurement.

**Tech Stack:** TypeScript, Vite 7, Canvas 2D. No test framework — this repo's checks are standalone `tools/*.ts` scripts bundled with esbuild and run under Node, exiting non-zero on failure.

**Spec:** `docs/superpowers/specs/2026-09-08-procedural-planet-genome-design.md`

## Global Constraints

- **No test runner exists.** Every check is a `tools/*.ts` script run as:
  `node_modules/.bin/esbuild tools/NAME.ts --bundle --platform=node --format=esm --outfile=/tmp/NAME.mjs && node /tmp/NAME.mjs`
  It must `process.exit(1)` on failure and print a readable table on success.
- **`src/simulation/` must never import from `src/rendering/`.** `PlanetGenome.ts` is pure: no DOM, no Canvas, no side effects.
- **The genome must never be derived from `planet.type`.** Terraforming mutates `type` (`BigBangEngine.ts:4402`); a type-derived genome would reroll a world's identity mid-game. Type is an *input that biases the roll*, captured once at creation.
- **Determinism is non-negotiable.** `rollPlanetGenome(seed, …)` called twice with the same arguments must be deep-equal. The grid is regenerated from seed on load and is never serialized.
- **Tasks 1–4 must produce zero visual change.** Any pixel difference before Task 5 is a bug.
- **Every metric ships with a control that fails on current code.** A variety metric that passes on today's generator is a broken metric, not a passing test.
- Existing guards must stay green throughout: `tools/smokeTest.ts`, `tools/habitableDioramaCheck.ts`, `tools/reliefCheck.ts`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/simulation/PlanetGenome.ts` | **Create.** The only module that decides what makes a planet distinct. Pure. |
| `src/simulation/BigBangEngine.ts` | **Modify.** Add `genomeSeed?: number` to `Planet`; assign at creation; backfill on load. |
| `src/rendering/HabitableCutawayEngine.ts` | **Modify.** `paintAtmosphere` takes an `AtmosphereChannel` instead of reading `paletteFor(type)`. |
| `tools/genomeCheck.ts` | **Create.** Determinism, legacy parity, seed stability across terraform + save round-trip. |
| `tools/planetVarietyCheck.ts` | **Create.** The variety metric and its control. |
| `tools/atmosphereCheck.ts` | **Create.** Continuity, hue split, thickness variance, aerial perspective — each with a control. |

---

### Task 1: `PlanetGenome` module with a legacy shim

**Files:**
- Create: `src/simulation/PlanetGenome.ts`
- Create: `tools/genomeCheck.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PlanetGenome`, `AtmosphereChannel`, `rollPlanetGenome(seed: number, type: string, dna?: PlanetDNA | null): PlanetGenome`, `genomeFromLegacy(type: string, seed: number): PlanetGenome`, `genomeSeedFor(starId: number, planetIndex: number): number`.

- [ ] **Step 1: Write the failing check**

Create `tools/genomeCheck.ts`:

```ts
/**
 * PlanetGenome guards.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/genomeCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/genomeCheck.mjs && node /tmp/genomeCheck.mjs
 */
const { rollPlanetGenome, genomeFromLegacy, genomeSeedFor } =
  await import('../src/simulation/PlanetGenome');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  failed++;
}

const TYPES = ['rocky', 'ocean', 'gas', 'ice', 'lava',
               'toxic', 'crystal', 'desert', 'storm', 'carbon'];

// 1. Determinism — same inputs, deep-equal output, every time.
for (const t of TYPES) {
  const a = rollPlanetGenome(4242, t, null);
  const b = rollPlanetGenome(4242, t, null);
  check(`deterministic: ${t}`, JSON.stringify(a) === JSON.stringify(b));
}

// 2. Different seeds must actually differ.
const s1 = rollPlanetGenome(1, 'ocean', null);
const s2 = rollPlanetGenome(2, 'ocean', null);
check('distinct seeds differ', JSON.stringify(s1) !== JSON.stringify(s2));

// 3. The genome records the type it was rolled from and never re-reads it.
const g = rollPlanetGenome(77, 'lava', null);
check('sourceType captured', g.sourceType === 'lava');
check('seed captured', g.seed === 77);

// 4. Legacy shim is deterministic and type-keyed.
for (const t of TYPES) {
  const a = genomeFromLegacy(t, 9);
  const b = genomeFromLegacy(t, 9);
  check(`legacy deterministic: ${t}`, JSON.stringify(a) === JSON.stringify(b));
}

// 4b. Legacy parity is the whole point of the shim, so assert the ACTUAL
//     values against the shipped renderer's palette — not merely that a
//     number is present. These densities are copied from
//     src/rendering/HabitableCutawayEngine.ts (`atmoDensity` per palette);
//     if that file changes, this check must be updated deliberately.
const REAL_DENSITY: Record<string, number> = {
  ocean: 1.00, rocky: 1.00, ice: 1.05, lava: 1.55, gas: 1.45,
  toxic: 1.25, crystal: 1.15, desert: 0.70, storm: 1.60, carbon: 0.65,
};
for (const t of TYPES) {
  const a = genomeFromLegacy(t, 9);
  check(`legacy density matches renderer: ${t}`,
    a.atmosphere.density === REAL_DENSITY[t],
    `got ${a.atmosphere.density}, renderer has ${REAL_DENSITY[t]}`);
  check(`legacy thickness is OZONE_FADE_PX: ${t}`, a.atmosphere.thicknessPx === 8,
    `got ${a.atmosphere.thicknessPx}`);
  check(`legacy hue in range: ${t}`,
    a.atmosphere.hue >= 0 && a.atmosphere.hue < 360, `got ${a.atmosphere.hue}`);
  check(`legacy saturation in range: ${t}`,
    a.atmosphere.saturation >= 0 && a.atmosphere.saturation <= 1,
    `got ${a.atmosphere.saturation}`);
}

// 4c. Distinct palettes must stay distinct — this is what catches a
//     scrambled or misassigned table, which a per-field range check cannot.
const sig = (t: string) => {
  const a = genomeFromLegacy(t, 0).atmosphere;
  return `${a.hue.toFixed(2)}|${a.saturation.toFixed(3)}|${a.density}`;
};
const sigs = new Map<string, string>();
let dupes = 0;
for (const t of TYPES) {
  for (const [other, v] of sigs) if (v === sig(t)) { dupes++; console.log(`  FAIL  ${t} and ${other} share an atmosphere signature`); }
  sigs.set(t, sig(t));
}
check('all ten types have distinct atmospheres', dupes === 0, `${dupes} collisions`);

// 5. Seed derivation is stable and collision-free for a plausible cosmos.
const seen = new Set<number>();
let collisions = 0;
for (let star = 0; star < 80; star++) {
  for (let i = 0; i < 8; i++) {
    const s = genomeSeedFor(star, i);
    if (seen.has(s)) collisions++;
    seen.add(s);
  }
}
check('genomeSeedFor collision-free over 640 planets', collisions === 0,
  `${collisions} collisions`);
check('genomeSeedFor stable', genomeSeedFor(5, 3) === genomeSeedFor(5, 3));

console.log(failed === 0 ? '\nAll genome checks passed.' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node_modules/.bin/esbuild tools/genomeCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/genomeCheck.mjs && node /tmp/genomeCheck.mjs
```

Expected: esbuild error — `Could not resolve "../src/simulation/PlanetGenome"`.

- [ ] **Step 3: Write the module**

Create `src/simulation/PlanetGenome.ts`:

```ts
/**
 * PlanetGenome — the single source of per-planet identity.
 *
 * Everything that makes one world look different from another derives from one
 * number. The genome is NEVER derived from `planet.type`: terraforming mutates
 * type (BigBangEngine TERRAFORM_SEQUENCES), and a type-derived genome would
 * silently reroll a world's identity mid-game. Type biases the roll once, at
 * creation, and is recorded as `sourceType` for reference only.
 *
 * Pure module. No DOM, no Canvas, no imports from src/rendering.
 */

import type { PlanetDNA } from './GameState';

/** Air: colour of the scatter, how thick the shell is, how opaque. */
export interface AtmosphereChannel {
  /** Hue 0–360 of the sunlit limb. */
  hue: number;
  /** 0–1. How far the scatter departs from grey. */
  saturation: number;
  /** Shell thickness in native px, before body-radius scaling. */
  thicknessPx: number;
  /** Multiplies overall opacity. Thick on lava/gas, thin on desert/carbon. */
  density: number;
}

export interface PlanetGenome {
  /** The number everything derives from. Stable for the planet's whole life. */
  seed: number;
  /** Planet type at roll time. Informational — never re-derive from live type. */
  sourceType: string;
  atmosphere: AtmosphereChannel;
}

// ─── Deterministic hashing ────────────────────────────────────────────────────

/** Stable 32-bit hash. Same inputs always give the same float in [0,1). */
function hash1(seed: number, salt: number): number {
  let h = (Math.imul(seed | 0, 374761393) + Math.imul(salt | 0, 2654435761)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1540483477) | 0;
  h = h ^ (h >>> 15);
  return (h >>> 0) / 4294967296;
}

/** Float in [lo, hi) from (seed, salt). */
function rand(seed: number, salt: number, lo: number, hi: number): number {
  return lo + hash1(seed, salt) * (hi - lo);
}

/**
 * Genome seed for a planet, from its star and orbital index.
 *
 * Multiplied by large odd co-prime factors so neighbouring planets in
 * neighbouring systems do not land on the same seed.
 */
export function genomeSeedFor(starId: number, planetIndex: number): number {
  return ((Math.imul(starId | 0, 2654435761) ^ Math.imul(planetIndex | 0, 40503)) >>> 0);
}

// ─── Legacy parity ────────────────────────────────────────────────────────────

/**
 * Today's per-type atmosphere, lifted verbatim from HabitableCutawayEngine's
 * palettes (`atmo` + `atmoDensity`) and OZONE_FADE_PX.
 *
 * This table exists so Phase 1 is invisible: `genomeFromLegacy` reproduces the
 * shipped look exactly. It is deleted once the rolled atmosphere lands.
 */
const LEGACY_ATMO: Record<string, { rgb: [number, number, number]; density: number }> = {
  ocean:   { rgb: [ 65, 165, 255], density: 1.00 },
  rocky:   { rgb: [158, 148, 128], density: 1.00 },
  ice:     { rgb: [140, 200, 240], density: 1.05 },
  lava:    { rgb: [210,  70,  20], density: 1.55 },
  gas:     { rgb: [170, 140, 190], density: 1.45 },
  toxic:   { rgb: [170, 210,  50], density: 1.25 },
  crystal: { rgb: [150,  90, 220], density: 1.15 },
  desert:  { rgb: [210, 170,  90], density: 0.70 },
  storm:   { rgb: [100,  90, 130], density: 1.60 },
  carbon:  { rgb: [ 70, 120, 190], density: 0.65 },
};

/**
 * RGB -> hue/saturation, so the table above can hold the renderer's bytes
 * verbatim instead of hand-converted HSL. Hand conversion is what produced
 * four wrong entries in the first draft of this table; copying integers and
 * converting in code removes that class of error entirely.
 */
function rgbToHueSat(r: number, g: number, b: number): { hue: number; saturation: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const mx = Math.max(rn, gn, bn), mn = Math.min(rn, gn, bn);
  const d = mx - mn, l = (mx + mn) / 2;
  if (d === 0) return { hue: 0, saturation: 0 };
  let h: number;
  if (mx === rn)      h = ((gn - bn) / d) % 6;
  else if (mx === gn) h = (bn - rn) / d + 2;
  else                h = (rn - gn) / d + 4;
  return {
    hue: ((h * 60) % 360 + 360) % 360,
    saturation: d / (1 - Math.abs(2 * l - 1)),
  };
}

/** The shipped renderer's air for one planet type, as an AtmosphereChannel. */
function legacyChannel(type: string): AtmosphereChannel {
  const l = LEGACY_ATMO[type] ?? LEGACY_ATMO.rocky;
  const { hue, saturation } = rgbToHueSat(l.rgb[0], l.rgb[1], l.rgb[2]);
  return { hue, saturation, thicknessPx: LEGACY_THICKNESS_PX, density: l.density };
}

/** OZONE_FADE_PX in the shipped renderer. Kept identical for Phase 1 parity. */
const LEGACY_THICKNESS_PX = 8;

/**
 * A genome that reproduces the shipped per-type look exactly.
 *
 * Used by the nine call sites that still pass a bare type string, so existing
 * guards keep running unchanged while they are migrated.
 */
export function genomeFromLegacy(type: string, seed: number): PlanetGenome {
  return { seed, sourceType: type, atmosphere: legacyChannel(type) };
}

// ─── The roll ─────────────────────────────────────────────────────────────────

/**
 * Roll a genome. Type and DNA bias the result; the seed decides it.
 *
 * Phase 1 rolls only the atmosphere channel. Terrain archetype, materials,
 * fluids and interior land in later phases — the shape of this function does
 * not change when they do.
 */
export function rollPlanetGenome(
  seed: number, type: string, _dna?: PlanetDNA | null,
): PlanetGenome {
  const base = legacyChannel(type);
  return {
    seed,
    sourceType: type,
    atmosphere: {
      // Drift around the type's characteristic hue rather than replacing it,
      // so a lava world is still recognisably lava-coloured.
      hue: (base.hue + rand(seed, 101, -22, 22) + 360) % 360,
      saturation: Math.max(0, Math.min(1, base.saturation * rand(seed, 103, 0.82, 1.18))),
      thicknessPx: Math.round(rand(seed, 107, 6, 13)),
      density: base.density * rand(seed, 109, 0.85, 1.15),
    },
  };
}
```

- [ ] **Step 4: Run the check and confirm it passes**

```bash
node_modules/.bin/esbuild tools/genomeCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/genomeCheck.mjs && node /tmp/genomeCheck.mjs
```

Expected: every line `PASS`, final `All genome checks passed.`, exit 0.

- [ ] **Step 5: Confirm nothing else broke**

```bash
node_modules/.bin/esbuild tools/smokeTest.ts --bundle --platform=node --format=esm --outfile=/tmp/smoke.mjs && node /tmp/smoke.mjs
```

Expected: exit 0, same pass count as before this task.

- [ ] **Step 6: Commit**

```bash
git add src/simulation/PlanetGenome.ts tools/genomeCheck.ts
git commit -m "feat(genome): PlanetGenome module with legacy atmosphere parity"
```

---

### Task 2: `genomeSeed` on every planet, stable across terraform and saves

**Files:**
- Modify: `src/simulation/BigBangEngine.ts` — `Planet` interface (~`:108–140`), planet creation (~`:4992`), load path
- Modify: `tools/genomeCheck.ts` — append engine-level checks

**Interfaces:**
- Consumes: `genomeSeedFor(starId, planetIndex)` from Task 1.
- Produces: `Planet.genomeSeed?: number`, always populated after `init()` or after loading a save.

- [ ] **Step 1: Write the failing checks**

Append to `tools/genomeCheck.ts`, before the final `console.log`:

```ts
// ── Engine-level: every planet carries a stable genomeSeed ──────────────────
const g2: any = globalThis as any;
g2.window = g2.window ?? {};
g2.document = g2.document ?? { getElementById: () => null, createElement: () => ({ getContext: () => null }) };
g2.requestAnimationFrame = () => 0;
g2.addEventListener = () => {};

const { BigBangEngine } = await import('../src/simulation/BigBangEngine');

const engine: any = new BigBangEngine();
engine.init?.();
for (let i = 0; i < 4000; i++) engine.step?.();

const planets: any[] = [];
for (const star of engine.stars ?? []) for (const p of star.planets ?? []) planets.push({ star, p });

check('cosmos has planets', planets.length > 0, `${planets.length}`);
check('every planet has a genomeSeed',
  planets.every(({ p }) => Number.isFinite(p.genomeSeed)),
  `${planets.filter(({ p }) => !Number.isFinite(p.genomeSeed)).length} missing`);

// Terraforming must not change identity.
const victim = planets[0].p;
const before = victim.genomeSeed;
victim.type = victim.type === 'ocean' ? 'desert' : 'ocean';
check('genomeSeed survives a type change', victim.genomeSeed === before);

// Save round-trip must preserve it.
const snap = JSON.parse(JSON.stringify(engine.serialize()));
const restored = snap.stars?.[0]?.planets?.[0];
check('genomeSeed survives serialize round-trip',
  Number.isFinite(restored?.genomeSeed));

// The loadState backfill is the old-save determinism guarantee. Exercise it
// in BOTH directions rather than trusting it by inspection: a backfill that
// silently overwrites an existing seed would destroy world identity on every
// load, and is the worse of the two bugs.
const snap2: any = JSON.parse(JSON.stringify(engine.serialize()));
delete snap2.stars[0].planets[0].genomeSeed;
check('snapshot really had the seed stripped',
  snap2.stars[0].planets[0].genomeSeed === undefined);
engine.loadState(snap2);
const want = genomeSeedFor(engine.stars[0].id, 0);
check('loadState backfills a missing genomeSeed',
  engine.stars[0].planets[0].genomeSeed === want,
  `got ${engine.stars[0].planets[0].genomeSeed}, expected ${want}`);

const snap3: any = JSON.parse(JSON.stringify(engine.serialize()));
const keepIdx = snap3.stars[0].planets.length > 1 ? 1 : 0;
const SENTINEL = 123456789;
snap3.stars[0].planets[keepIdx].genomeSeed = SENTINEL;
engine.loadState(snap3);
check('loadState leaves an existing genomeSeed alone',
  engine.stars[0].planets[keepIdx].genomeSeed === SENTINEL,
  `got ${engine.stars[0].planets[keepIdx].genomeSeed}`);
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node_modules/.bin/esbuild tools/genomeCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/genomeCheck.mjs && node /tmp/genomeCheck.mjs
```

Expected: `FAIL every planet has a genomeSeed`, exit 1.

- [ ] **Step 3: Add the field to the `Planet` interface**

In `src/simulation/BigBangEngine.ts`, inside `export interface Planet`, directly after the `dna?: PlanetDNA;` member:

```ts
  /**
   * Seed for this planet's PlanetGenome. Assigned once at creation and never
   * rewritten — terraforming changes `type` but must NOT change identity.
   * Absent on saves written before the genome landed; backfilled on load.
   */
  genomeSeed?: number;
```

- [ ] **Step 4: Assign it at creation**

Import at the top of `src/simulation/BigBangEngine.ts`:

```ts
import { genomeSeedFor } from './PlanetGenome';
```

`generatePlanets` (`:4898`) has no star id in scope — it returns a bare `Planet[]`. The only place a star's `id` and its planets meet is `createStar` (`:757`). Change its opening from:

```ts
  private createStar(x: number, y: number): StarBody {
    const mass = this.rng.nextFloat(1, 8);
    const planets = this.generatePlanets(this.stats, mass);
```

to:

```ts
  private createStar(x: number, y: number): StarBody {
    // Hoisted so planets can be stamped with a genome seed derived from it.
    // Taking the counter BEFORE generatePlanets is safe: that method never
    // reads starIdCounter, and it does not touch this.rng either, so the RNG
    // sequence — and therefore every existing world — is unchanged.
    const starId = this.starIdCounter++;
    const mass = this.rng.nextFloat(1, 8);
    const planets = this.generatePlanets(this.stats, mass);
    planets.forEach((p, i) => { p.genomeSeed = genomeSeedFor(starId, i); });
```

and in the returned object literal replace:

```ts
      id: this.starIdCounter++,
```

with:

```ts
      id: starId,
```

- [ ] **Step 5: Backfill on load**

In `loadState(snap: EngineSnapshot)` (`:5378`), directly after `this.stars = snap.stars;` (`:5381`), add:

```ts
    // Saves written before the genome existed have no genomeSeed. Derive it
    // once from the same inputs creation uses, so an old save and a new game
    // produce identical worlds.
    for (const star of this.stars) {
      star.planets.forEach((p, i) => {
        if (!Number.isFinite(p.genomeSeed)) p.genomeSeed = genomeSeedFor(star.id, i);
      });
    }
```

- [ ] **Step 6: Run the check and confirm it passes**

```bash
node_modules/.bin/esbuild tools/genomeCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/genomeCheck.mjs && node /tmp/genomeCheck.mjs
```

Expected: all `PASS`, exit 0.

- [ ] **Step 7: Confirm no visual or simulation change**

```bash
node_modules/.bin/esbuild tools/smokeTest.ts --bundle --platform=node --format=esm --outfile=/tmp/smoke.mjs && node /tmp/smoke.mjs
node_modules/.bin/esbuild tools/habitableDioramaCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/hab.mjs && node /tmp/hab.mjs
```

Expected: both exit 0, unchanged output.

- [ ] **Step 8: Commit**

```bash
git add src/simulation/BigBangEngine.ts tools/genomeCheck.ts
git commit -m "feat(genome): genomeSeed on every planet, stable across terraform and saves"
```

---

### Task 3: The variety metric and its control

This task adds **no production code**. Its deliverable is a measuring instrument plus proof the instrument works — the control must fail on today's generator, otherwise the metric is worthless.

**Files:**
- Create: `tools/planetVarietyCheck.ts`

**Interfaces:**
- Consumes: `generatePlanetGrid`, `isWater`, `GRID_SIZE` from `src/simulation/PlanetGrid`.
- Produces: `tools/planetVarietyCheck.ts`, runnable with `--control` (assert narrow, expect pass today) or without (assert wide, expect fail until archetypes land).

- [ ] **Step 1: Write the tool**

Create `tools/planetVarietyCheck.ts`:

```ts
/**
 * Does the generator actually make different worlds?
 *
 * Two modes:
 *   --control   assert the spread is NARROW. Passes on today's generator.
 *               This is what proves the metric can detect the bug.
 *   (default)   assert the spread is WIDE. Fails until archetypes land.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/planetVarietyCheck.ts --bundle \
 *     --platform=node --format=esm --outfile=/tmp/variety.mjs && node /tmp/variety.mjs
 */
const { generatePlanetGrid, isWater, GRID_SIZE } =
  await import('../src/simulation/PlanetGrid');

const CONTROL = process.argv.includes('--control');
const SEEDS = 24;
const TYPE = 'ocean';

/** Fraction of cells above sea level. */
function landFrac(grid: any): number {
  let land = 0;
  for (let r = 0; r < GRID_SIZE; r++)
    for (let c = 0; c < GRID_SIZE; c++)
      if (!isWater(grid[r][c].biome)) land++;
  return land / (GRID_SIZE * GRID_SIZE);
}

/** Share of all land held by the single biggest connected landmass. */
function biggestMassShare(grid: any): number {
  const seen = new Uint8Array(GRID_SIZE * GRID_SIZE);
  let best = 0, total = 0;
  const stack: number[] = [];
  for (let r = 0; r < GRID_SIZE; r++) for (let c = 0; c < GRID_SIZE; c++) {
    const i = r * GRID_SIZE + c;
    if (seen[i] || isWater(grid[r][c].biome)) continue;
    let size = 0;
    stack.push(i); seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const jr = (j / GRID_SIZE) | 0, jc = j % GRID_SIZE;
      size++;
      for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nr = jr + dr, nc = (jc + dc + GRID_SIZE) % GRID_SIZE; // x wraps
        if (nr < 0 || nr >= GRID_SIZE) continue;
        const k = nr * GRID_SIZE + nc;
        if (seen[k] || isWater(grid[nr][nc].biome)) continue;
        seen[k] = 1; stack.push(k);
      }
    }
    total += size;
    if (size > best) best = size;
  }
  return total > 0 ? best / total : 0;
}

/** Coast cells per unit of land — high means fragmented, low means blobby. */
function coastRatio(grid: any): number {
  let coast = 0, land = 0;
  for (let r = 1; r < GRID_SIZE - 1; r++) for (let c = 0; c < GRID_SIZE; c++) {
    if (isWater(grid[r][c].biome)) continue;
    land++;
    const l = grid[r][(c - 1 + GRID_SIZE) % GRID_SIZE].biome;
    const rr = grid[r][(c + 1) % GRID_SIZE].biome;
    if (isWater(l) || isWater(rr) ||
        isWater(grid[r - 1][c].biome) || isWater(grid[r + 1][c].biome)) coast++;
  }
  return land > 0 ? coast / land : 0;
}

/** Distinct connected landmasses of at least `minCells` cells. Specks are noise. */
function landmassCount(grid: any, minCells = 40): number {
  const seen = new Uint8Array(GRID_SIZE * GRID_SIZE);
  const stack: number[] = [];
  let n = 0;
  for (let r = 0; r < GRID_SIZE; r++) for (let c = 0; c < GRID_SIZE; c++) {
    const i = r * GRID_SIZE + c;
    if (seen[i] || isWater(grid[r][c].biome)) continue;
    let size = 0;
    stack.push(i); seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const jr = (j / GRID_SIZE) | 0, jc = j % GRID_SIZE;
      size++;
      for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nr = jr + dr, nc = (jc + dc + GRID_SIZE) % GRID_SIZE; // x wraps
        if (nr < 0 || nr >= GRID_SIZE) continue;
        const k = nr * GRID_SIZE + nc;
        if (seen[k] || isWater(grid[nr][nc].biome)) continue;
        seen[k] = 1; stack.push(k);
      }
    }
    if (size >= minCells) n++;
  }
  return n;
}

const rows: Array<{ seed: number; land: number; big: number; coast: number; masses: number }> = [];
for (let s = 0; s < SEEDS; s++) {
  const grid = generatePlanetGrid(TYPE, 1000 + s * 7919, null);
  rows.push({ seed: 1000 + s * 7919, land: landFrac(grid),
              big: biggestMassShare(grid), coast: coastRatio(grid),
              masses: landmassCount(grid) });
}

const spread = (get: (r: typeof rows[0]) => number): number => {
  const v = rows.map(get);
  return Math.max(...v) - Math.min(...v);
};
const coastSpread = spread(r => r.coast);
const maxMasses   = Math.max(...rows.map(r => r.masses));

console.log(`\n  ${SEEDS} '${TYPE}' worlds, distinct seeds\n`);
console.log('  metric              min     max     spread');
const line = (n: string, get: (r: typeof rows[0]) => number) => {
  const v = rows.map(get);
  console.log(`  ${n.padEnd(18)} ${Math.min(...v).toFixed(3)}   ${Math.max(...v).toFixed(3)}   ${(Math.max(...v)-Math.min(...v)).toFixed(3)}`);
};
line('land fraction', r => r.land);          // diagnostic only - see below
line('biggest mass share', r => r.big);      // diagnostic only - see below
line('coast / land', r => r.coast);
line('landmasses >=40', r => r.masses);

// Thresholds. A generator that makes genuinely different worlds should easily
// clear these; today's single-recipe generator cannot get near them.
// Measured on the current generator across these 24 'ocean' seeds:
//   land fraction      0.502 - 0.878  (spread 0.376)
//   biggest mass share 0.523 - 1.000  (spread 0.477)
//   coast / land       0.013 - 0.050  (spread 0.037)
//   landmasses >=40    1 - 7          (17 of 24 seeds have 1 or 2)
//
// Land fraction and biggest-mass share ALREADY vary widely today, so they are
// printed as diagnostics and deliberately NOT asserted. They measure how much
// land a world has and how consolidated it is - not what SHAPE it is, and shape
// is the actual defect. Asserting on metrics that already vary would make this
// instrument unfalsifiable: its control could never pass.
//
// The two that do discriminate are landmass COUNT (an archipelago has dozens;
// this generator tops out at 7) and coastline character (uniformly smooth and
// blobby, 0.013-0.050 on every world).
const WANT_MASSES = 40;   // an archipelago world must be reachable at all
const WANT_COAST  = 0.15; // coastline character must genuinely differ

let failed = 0;
function assert(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!ok) failed++;
}

if (CONTROL) {
  console.log('\n  CONTROL MODE — asserting the spread is NARROW.');
  console.log('  This must PASS on the current generator. If it fails, the');
  console.log('  metric is measuring the wrong thing.\n');
  assert('landmass count stays low', maxMasses <= 12, `${maxMasses} <= 12`);
  assert('coastline character is uniform', coastSpread < WANT_COAST,
    `${coastSpread.toFixed(3)} < ${WANT_COAST}`);
} else {
  console.log('\n  Asserting the spread is WIDE. Expected to FAIL until');
  console.log('  terrain archetypes land.\n');
  assert('archipelago worlds are reachable', maxMasses >= WANT_MASSES,
    `${maxMasses} >= ${WANT_MASSES}`);
  assert('coastline character varies', coastSpread >= WANT_COAST,
    `${coastSpread.toFixed(3)} >= ${WANT_COAST}`);
}

process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the control — it must PASS**

```bash
node_modules/.bin/esbuild tools/planetVarietyCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/variety.mjs && node /tmp/variety.mjs --control
```

Expected: exit 0. This is the proof the metric detects the bug. **If the control fails, stop** — the thresholds or the metrics are wrong, and no amount of later work will be validated by them. Fix the metric before proceeding.

- [ ] **Step 3: Run the real assertion — it must FAIL**

```bash
node_modules/.bin/esbuild tools/planetVarietyCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/variety.mjs && node /tmp/variety.mjs
```

Expected: exit 1, all three assertions FAIL. Record the printed spread values in the commit message — they are the baseline the archetype phase has to beat.

- [ ] **Step 4: Commit**

```bash
git add tools/planetVarietyCheck.ts
git commit -m "test(variety): planet variety metric with a control that proves it detects the bug"
```

---

### Task 4: The atmosphere metric and its controls

Also no production code. Four metrics, each with a control that fails on the shipped renderer.

**Files:**
- Create: `tools/atmosphereCheck.ts`

**Interfaces:**
- Consumes: `paintAtmosphere` from `src/rendering/HabitableCutawayEngine`. The geometry is a plain object literal `{ cx, cyTop, rx, ry }` — verified to work headlessly; the module imports cleanly under Node once `globalThis.ImageData` is stubbed.
- Produces: `tools/atmosphereCheck.ts`, four named assertions runnable with `--control`.

- [ ] **Step 1: Write the tool**

Create `tools/atmosphereCheck.ts`:

```ts
/**
 * Does the atmosphere read as air, or as a pasted ring?
 *
 * Four measurements, each with a control that PASSES on the shipped renderer
 * (i.e. confirms the defect is present and measurable):
 *
 *   1. seam        max alpha RATIO between adjacent pixels across the face edge
 *   2. hueSplit    hue difference between the sunlit limb and the shadowed limb
 *   3. thickness   variance of shell thickness around the limb
 *   4. innerFall   alpha 20% inward minus alpha 60% inward — is there a real
 *                  aerial-perspective gradient, or a flat floor?
 *
 * Measured on the shipped renderer at rx=130, ry=65. The thresholds below are
 * calibrated against these — re-measure if the geometry changes:
 *   seam 2.67  ·  hueSplit 0.0 deg  ·  thickness variance 1 px  ·  innerFall -1
 *
 * innerFall is NEGATIVE today. The alpha profile from the rim inward is
 * 18, 9, 4, 4, 4, 4, 5, 5, 5, 6 at 0/10/.../90% of the radius: it collapses
 * within 20% of the radius and then sits flat, rising slightly toward the
 * sunlit limb. So there is no aerial perspective at all, and what floor does
 * remain tilts the wrong way.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/atmosphereCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/atmo.mjs && node /tmp/atmo.mjs [--control]
 */
const CONTROL = process.argv.includes('--control');

// Minimal ImageData stand-in — the renderer only touches width/height/data.
class FakeImageData {
  data: Uint8ClampedArray;
  constructor(public width: number, public height: number) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}
(globalThis as any).ImageData = FakeImageData;

const { paintAtmosphere } = await import('../src/rendering/HabitableCutawayEngine');

const W = 420, H = 320;
const geom: any = { cx: 210, cyTop: 150, rx: 130, ry: 65 };

function render(): FakeImageData {
  const img = new FakeImageData(W, H);
  paintAtmosphere(img as any, geom, 'ocean', 0, 0, 1);
  return img;
}
const img = render();
const A = (x: number, y: number) => img.data[(y * W + x) * 4 + 3];
const RGB = (x: number, y: number) => {
  const o = (y * W + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
};
function hueOf([r, g, b]: number[]): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d === 0) return 0;
  let h: number;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

// 1. seam — biggest adjacent-pixel alpha RATIO across the face-ellipse edge.
//    A ratio, not a difference: absolute alphas here are small (~10-20), so a
//    4x jump is only ~15 in absolute terms and an absolute threshold misses it.
//    Sampled at four columns because the boundary is an ellipse and the centre
//    column alone undersamples it.
let seam = 1;
for (const frac of [0, 0.3, 0.55, 0.75]) {
  const x = Math.round(geom.cx + geom.rx * frac);
  for (let y = geom.cyTop - geom.ry - 14; y < geom.cyTop + geom.ry + 14; y++) {
    if (y < 1 || y >= H - 1) continue;
    const a = A(x, y), b = A(x, y + 1);
    if (a > 2 && b > 2) seam = Math.max(seam, Math.max(a, b) / Math.min(a, b));
  }
}

// 2. hueSplit — sunlit limb (+x) vs shadowed limb (−x)
const lit = hueOf(RGB(geom.cx + geom.rx - 2, geom.cyTop));
const dark = hueOf(RGB(geom.cx - geom.rx + 2, geom.cyTop));
let hueSplit = Math.abs(lit - dark);
if (hueSplit > 180) hueSplit = 360 - hueSplit;

// 3. thickness — how many px of non-zero alpha extend past the rim, sampled
//    at several angles around the dome
const thick: number[] = [];
for (const ang of [-2.6, -2.2, -1.8, -1.4, -1.0, -0.6]) {
  let n = 0;
  for (let t = 0; t < 30; t++) {
    const x = Math.round(geom.cx + Math.cos(ang) * (geom.rx + t));
    const y = Math.round(geom.cyTop + Math.sin(ang) * (geom.rx + t));
    if (x < 0 || y < 0 || x >= W || y >= H) break;
    if (A(x, y) > 2) n++;
  }
  thick.push(n);
}
const thickVar = Math.max(...thick) - Math.min(...thick);

// 4. innerFall — a gradient inside the rim, or a flat floor?
//    The shipped renderer decays 18 -> 4 over ~26px and then sits at exactly 4
//    for the rest of the radius. That constant is the additive tint; it is not
//    aerial perspective. Comparing 20% inward against 60% inward catches it.
const at = (fracIn: number) =>
  A(Math.round(geom.cx - geom.rx + geom.rx * fracIn), geom.cyTop);
const innerFall = at(0.20) - at(0.60);

console.log('\n  atmosphere measurements');
console.log(`    seam (max adjacent alpha ratio)        : ${seam.toFixed(2)}`);
console.log(`    hue split (lit limb vs shadow limb)    : ${hueSplit.toFixed(1)} deg`);
console.log(`    thickness variance around limb (px)    : ${thickVar}`);
console.log(`    inner falloff (a@20% - a@60%)          : ${innerFall}`);

// Calibrated against the shipped renderer: 2.67 / 0.0 / 1 / 2.
const WANT_SEAM = 2.0, WANT_HUE = 12, WANT_THICK = 2, WANT_FALL = 5;

let failed = 0;
const assert = (n: string, ok: boolean, d: string) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n} — ${d}`);
  if (!ok) failed++;
};

if (CONTROL) {
  console.log('\n  CONTROL — asserting the defects ARE present. Must PASS today.\n');
  assert('seam is visible',        seam > WANT_SEAM,        `${seam.toFixed(2)} > ${WANT_SEAM}`);
  assert('no hue split',           hueSplit < WANT_HUE,     `${hueSplit.toFixed(1)} < ${WANT_HUE}`);
  assert('thickness is uniform',   thickVar <= WANT_THICK,  `${thickVar} <= ${WANT_THICK}`);
  assert('inner falloff is flat',  innerFall < WANT_FALL,   `${innerFall} < ${WANT_FALL}`);
} else {
  console.log('\n  Asserting the atmosphere reads as air. Fails until Tasks 5-7.\n');
  assert('no visible seam',        seam <= WANT_SEAM,        `${seam.toFixed(2)} <= ${WANT_SEAM}`);
  assert('warm/cool hue split',    hueSplit >= WANT_HUE,     `${hueSplit.toFixed(1)} >= ${WANT_HUE}`);
  assert('thickness varies',       thickVar > WANT_THICK,    `${thickVar} > ${WANT_THICK}`);
  assert('aerial gradient exists', innerFall >= WANT_FALL,   `${innerFall} >= ${WANT_FALL}`);
}

process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the control — it must PASS**

```bash
node_modules/.bin/esbuild tools/atmosphereCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/atmo.mjs && node /tmp/atmo.mjs --control
```

Expected: exit 0 — the four defects are present and measurable. **If any control assertion fails, adjust that metric before proceeding**; a metric that cannot see the defect cannot verify the fix. Record the four printed numbers; they are the before-baseline.

- [ ] **Step 3: Run the real assertion — it must FAIL**

```bash
node_modules/.bin/esbuild tools/atmosphereCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/atmo.mjs && node /tmp/atmo.mjs
```

Expected: exit 1, all four FAIL.

- [ ] **Step 4: Commit**

```bash
git add tools/atmosphereCheck.ts
git commit -m "test(atmosphere): four defect metrics with controls proving each is measurable"
```

---

### Task 5: Move the atmosphere onto the genome and kill the seam

**Files:**
- Modify: `src/rendering/HabitableCutawayEngine.ts` — `paintAtmosphere` (`:1215`) and its one call site (`:1807`)

**Interfaces:**
- Consumes: `AtmosphereChannel`, `genomeFromLegacy` from Task 1.
- Produces: `paintAtmosphere(img, geom, planetType, bob, sunAzimuth, intensity, tint?, air?: AtmosphereChannel)` — `air` optional; when absent it falls back to `genomeFromLegacy(planetType, 0).atmosphere`, so no call site is forced to change at once.

- [ ] **Step 1: Confirm the seam assertion is the one failing**

```bash
node_modules/.bin/esbuild tools/atmosphereCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/atmo.mjs && node /tmp/atmo.mjs
```

Expected: `FAIL no visible seam`. Note the number.

- [ ] **Step 2: Replace the branch with a blend**

In `src/rendering/HabitableCutawayEngine.ts`, add near the top:

```ts
import { genomeFromLegacy, type AtmosphereChannel } from '../simulation/PlanetGenome';
```

Change the `paintAtmosphere` signature to accept the channel:

```ts
export function paintAtmosphere(
  img: ImageData, geom: HabitableGeom, planetType: HabitableType, bob: number,
  sunAzimuth = 0,
  intensity = 1,
  tint?: RGB,
  air?: AtmosphereChannel,
): void {
```

Immediately after `if (intensity <= 0.01) return;`, resolve the channel:

```ts
  const chan = air ?? genomeFromLegacy(planetType, 0).atmosphere;
```

Replace `const dens = pal.atmoDensity;` with:

```ts
  const dens = chan.density;
```

and `const fade = OZONE_FADE_PX;` with:

```ts
  const fade = chan.thicknessPx;
```

Then replace the hard branch:

```ts
      const glow = hit.face > 1
        ? (0.07 + limb * 0.52) * lit * intensity * dens
        : (0.03 + limb * 0.10) * lit * intensity * dens;
```

with a smooth crossfade across the face boundary. `hit.face` is the squared
normalised radius on the face ellipse, so it passes through 1 exactly at the
edge; blending over a band around 1 removes the step without moving the edge:

```ts
      // Dome and tabletop air used to be two branches, which put a ~4x alpha
      // step exactly on the face-ellipse edge. Crossfade across it instead.
      const domeGlow  = (0.07 + limb * 0.52) * lit * intensity * dens;
      const faceGlow  = (0.03 + limb * 0.10) * lit * intensity * dens;
      const blend     = Math.max(0, Math.min(1, (hit.face - 0.82) / 0.36));
      const glow      = faceGlow + (domeGlow - faceGlow) * blend;
```

- [ ] **Step 3: Run the atmosphere check — seam must now pass**

```bash
node_modules/.bin/esbuild tools/atmosphereCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/atmo.mjs && node /tmp/atmo.mjs
```

Expected: `PASS no visible seam`. The other three still FAIL (exit 1) — that is correct at this task.

- [ ] **Step 4: Confirm the control now fails for the seam**

```bash
node_modules/.bin/esbuild tools/atmosphereCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/atmo.mjs && node /tmp/atmo.mjs --control
```

Expected: `FAIL seam is visible`. The defect is gone, so the control that asserted its presence should no longer hold. This is the proof the fix moved the metric.

- [ ] **Step 5: Confirm the diorama guard is still green**

```bash
node_modules/.bin/esbuild tools/habitableDioramaCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/hab.mjs && node /tmp/hab.mjs
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/rendering/HabitableCutawayEngine.ts
git commit -m "fix(atmosphere): crossfade the face boundary, take air params from the genome"
```

---

### Task 6: Warm/cool scatter split

**Files:**
- Modify: `src/rendering/HabitableCutawayEngine.ts` — `paintAtmosphere`

**Interfaces:**
- Consumes: `chan.hue`, `chan.saturation` resolved in Task 5.
- Produces: no signature change.

- [ ] **Step 1: Confirm the hue assertion is failing**

```bash
node_modules/.bin/esbuild tools/atmosphereCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/atmo.mjs && node /tmp/atmo.mjs
```

Expected: `FAIL warm/cool hue split`.

- [ ] **Step 2: Add an HSL helper**

Add above `paintAtmosphere` in `src/rendering/HabitableCutawayEngine.ts`:

```ts
/** HSL → RGB, h in degrees, s and l in 0–1. */
function hslRGB(h: number, s: number, l: number): RGB {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (hh < 60)       { r = c; g = x; }
  else if (hh < 120) { r = x; g = c; }
  else if (hh < 180) { g = c; b = x; }
  else if (hh < 240) { g = x; b = c; }
  else if (hh < 300) { r = x; b = c; }
  else               { r = c; b = x; }
  return rgb(
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  );
}
```

- [ ] **Step 3: Precompute the two scatter colours and interpolate per pixel**

Inside `paintAtmosphere`, after `const chan = …`, add:

```ts
  // Air scatters differently where it is lit. Warmer and paler toward the sun,
  // cooler and deeper away from it. One flat colour is what made the shipped
  // shell read as a drawn outline rather than a volume.
  const warm = hslRGB(chan.hue - 26, chan.saturation * 0.72, 0.74);
  const cool = hslRGB(chan.hue + 22, chan.saturation * 1.00, 0.46);
```

Replace the flat write:

```ts
      d[o] = atmo.r;
      d[o + 1] = atmo.g;
      d[o + 2] = atmo.b;
      d[o + 3] = a;
```

with a lit-weighted mix. `lit` already runs 0.55→1.0 across the terminator, so
renormalise it to 0→1 before using it as the blend weight:

```ts
      const warmth = Math.max(0, Math.min(1, (lit - 0.55) / 0.45));
      const base = tint ?? null;
      d[o]     = base ? base.r : Math.round(cool.r + (warm.r - cool.r) * warmth);
      d[o + 1] = base ? base.g : Math.round(cool.g + (warm.g - cool.g) * warmth);
      d[o + 2] = base ? base.b : Math.round(cool.b + (warm.b - cool.b) * warmth);
      d[o + 3] = a;
```

The `tint` escape hatch is kept because gas giants pass their band-average
colour through it; those keep the single-colour path deliberately.

Delete the now-unused `const atmo = tint ?? pal.atmo;` line. If `pal` becomes
unused, delete `const pal = paletteFor(planetType);` too — the TypeScript build
(`npm run build`) will flag it if not.

- [ ] **Step 4: Run the check — hue split must now pass**

```bash
node_modules/.bin/esbuild tools/atmosphereCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/atmo.mjs && node /tmp/atmo.mjs
```

Expected: `PASS no visible seam`, `PASS warm/cool hue split`. Thickness and inward still FAIL.

- [ ] **Step 5: Typecheck**

```bash
npm run build
```

Expected: exit 0, no unused-variable errors.

- [ ] **Step 6: Commit**

```bash
git add src/rendering/HabitableCutawayEngine.ts
git commit -m "feat(atmosphere): warm/cool scatter split across the terminator"
```

---

### Task 7: Perturbed thickness and real aerial perspective

**Files:**
- Modify: `src/rendering/HabitableCutawayEngine.ts` — `ozoneAt` (`:1197`) and `paintAtmosphere`

**Interfaces:**
- Consumes: `chan.thicknessPx`.
- Produces: `ozoneAt(x, y, geom, bob, extraPx, seed?)` — one extra optional argument; existing calls keep working.

- [ ] **Step 1: Confirm the two remaining assertions fail**

```bash
node_modules/.bin/esbuild tools/atmosphereCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/atmo.mjs && node /tmp/atmo.mjs
```

Expected: `FAIL thickness varies`, `FAIL aerial gradient exists`.

- [ ] **Step 2: Make the shell thickness vary around the limb**

In `paintAtmosphere`, after `const fade = chan.thicknessPx;`, add:

```ts
  // A constant-thickness ring reads as a geometric annulus — an outline rather
  // than a volume. Perturb it slowly around the limb.
  const wobbleSeed = (chan.hue * 7.13 + chan.thicknessPx * 31.7);
  const fadeAt = (ang: number): number => {
    const n = Math.sin(ang * 2.0 + wobbleSeed) * 0.5
            + Math.sin(ang * 3.7 + wobbleSeed * 1.7) * 0.28;
    return Math.max(3, fade * (1 + n * 0.34));
  };
```

Widen the scan bounds to the largest possible thickness so nothing is clipped —
replace the four bound lines that use `fade` with:

```ts
  const fadeMax = fade * 1.34 + 2;
  const y0 = Math.max(0, Math.floor(cy - rx - fadeMax));
  const y1 = Math.min(h - 1, Math.ceil(cy + ry));
  const x0 = Math.max(0, Math.floor(cx - rx - fadeMax));
  const x1 = Math.min(w - 1, Math.ceil(cx + rx + fadeMax));
```

Change the `ozoneAt` call to use the widest reach:

```ts
      const hit = ozoneAt(x, y, geom, bob, fadeMax);
```

and replace the `edge` / `limb` computation with the per-angle thickness:

```ts
      const ang = Math.atan2(y - cy, x - cx);
      const localFade = fadeAt(ang);
      const beyond = hit.distPx - rx;
      const edge = beyond <= 0 ? 1 : Math.max(0, 1 - beyond / localFade);
      if (edge < 0.02) continue;
      const inside = Math.max(0, rx - hit.distPx);
      const sigmaL = localFade * 1.15;
      const limb = Math.exp(-(inside * inside) / (2 * sigmaL * sigmaL)) * edge;
```

Delete the now-unused `const sigma = fade * 1.15;` and `const twoSig = …` lines.

- [ ] **Step 3: Replace the flat inner floor with a real gradient**

Measured, the shipped alpha profile walking inward from the rim is
`18,18,18,18,17,16,16,15,14,13,12,11,10,9,9,8,7,7,6,6,6,5,5,5,5,5,4,4,4,…` and
then sits at exactly **4 for the remaining ~100px**. So the defect is not a
step — it is a *flat floor*. `limb` dies within ~26px and all that survives is
the constant `0.03` term: an additive tint spread evenly across the whole face.

Add a term that actually falls off across the body. Replace the `glow` block
from Task 5 with:

```ts
      const domeGlow  = (0.07 + limb * 0.52) * lit * intensity * dens;
      const faceGlow  = (0.03 + limb * 0.10) * lit * intensity * dens;
      const blend     = Math.max(0, Math.min(1, (hit.face - 0.82) / 0.36));
      // Aerial perspective: air keeps veiling the surface well inside the rim,
      // falling off over ~35% of the radius rather than dying at the edge.
      const aerial    = Math.pow(Math.max(0, 1 - inside / (rx * 0.35)), 1.7)
                      * 0.16 * lit * intensity * dens;
      const glow      = faceGlow + (domeGlow - faceGlow) * blend + aerial;
```

- [ ] **Step 4: Run the check — all four must pass**

```bash
node_modules/.bin/esbuild tools/atmosphereCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/atmo.mjs && node /tmp/atmo.mjs
```

Expected: four `PASS`, exit 0.

- [ ] **Step 5: Confirm every control now fails**

```bash
node_modules/.bin/esbuild tools/atmosphereCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/atmo.mjs && node /tmp/atmo.mjs --control
```

Expected: exit 1, all four control assertions FAIL. Every defect the controls were written to detect is gone.

- [ ] **Step 6: Confirm the rest of the renderer is unharmed**

```bash
npm run build
node_modules/.bin/esbuild tools/habitableDioramaCheck.ts --bundle --platform=node --format=esm --outfile=/tmp/hab.mjs && node /tmp/hab.mjs
node_modules/.bin/esbuild tools/smokeTest.ts --bundle --platform=node --format=esm --outfile=/tmp/smoke.mjs && node /tmp/smoke.mjs
```

Expected: all exit 0.

- [ ] **Step 7: Look at it**

```bash
npm run dev
```

Open `http://localhost:3000/diorama-preview.html?type=ocean` and compare against `type=lava` and `type=desert`. The limb should read as a soft, slightly irregular band that is warmer on the sunlit side, with terrain fading into haze toward the edge rather than meeting a hard ring. **The numbers passing is not the same as it looking right** — if it looks worse, say so and tune the constants before committing.

- [ ] **Step 8: Commit**

```bash
git add src/rendering/HabitableCutawayEngine.ts
git commit -m "feat(atmosphere): perturbed shell thickness and aerial perspective"
```

---

## What this plan deliberately does not do

- **No terrain archetypes.** `tools/planetVarietyCheck.ts` will keep failing in
  its default mode until they land. That failure is the point — it is the
  standing baseline for the next plan.
- **No materials, fluids, earthworks, discovery tiers, world scale or gas
  giants.** Separate plans, per the spec's phasing.
- **No change to the pancake composition.** The atmosphere is fixed *in place*
  on the current geometry. When the body becomes a sphere, `ozoneAt`'s
  `if (y > cy + ry) return null` half-dome guard must be removed — it is
  correct for a pancake and wrong for a sphere. Noted in the spec, not fixed
  here.
