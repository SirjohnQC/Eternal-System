# Atmosphere Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The home-world dome reads as air: the limb glow wraps the rim with no shelf, the whole dome is on canvas, and each world draws its own rolled atmosphere.

**Architecture:** Three independent fixes in `src/rendering/HabitableCutawayEngine.ts` (`ozoneAt`/`paintAtmosphere` for the rim band, `habitableGeom` for framing) plus a wiring change from `IsoDioramaRenderer` through `HabitableFrameInput.air`. A new pure helper in `src/simulation/PlanetGenome.ts` picks rolled vs legacy air. Every metric is written first and shown to FAIL on today's renderer.

**Tech Stack:** TypeScript, Vite, Canvas 2D/ImageData. Headless checks in `tools/` bundled with esbuild and run under Node — no test framework.

**Spec:** `docs/superpowers/specs/2026-09-25-atmosphere-pass-design.md`

## Global Constraints

- Headless checks live in `tools/`, never `src/` (`npm run build` runs `tsc` over `src`).
- Build + run any check: `node_modules/.bin/esbuild tools/<name>.ts --bundle --platform=node --format=esm --outfile="$TEMP/<name>.mjs" --log-level=error && node "$TEMP/<name>.mjs"`
- Baseline at `39e9c45`: `atmosphereCheck`, `habitableDioramaCheck`, `genomeCheck` all exit 0. `node_modules/.bin/tsc --noEmit -p .` reports exactly **2** errors, both `TS2322 Float32Array<ArrayBufferLike>` in `HabitableCutawayEngine.ts` — pre-existing. Gate is "no NEW errors".
- `paintAtmosphere` is per-frame. Budget: **≤ +10%** over the Task 1 baseline, same machine, same session.
- The frame path must stay readback-free and `putImageData`-only on the atmosphere canvas (`habitableDioramaCheck` asserts this — keep it green).
- The pancake-only line `if (y > cy + ry) return null;` in `ozoneAt` and its comment stay.
- A threshold that fails a legitimate render is a finding to report, not a number to loosen. Look at the pixels before deciding which one is wrong.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `.env`.

## Review Focus

1. **Tiny viewports** — `habitableGeom` now loops shrinking `R`; at e.g. 120×90 it must terminate and return a usable geometry, not hang. Test added in Task 3.
2. **Terraforming mid-session** — the air must follow the live type while keeping the seed's drift; a cache keyed on seed alone would show lava air over an ocean. Test added in Task 4 (genomeCheck: same seed, two types, different hue) plus the renderer cache key includes type.
3. **Pre-genome saves / dev harness with no seed** — `genomeSeed` undefined or NaN must fall back to the shipped per-type air, not throw or paint NaN colours. Test added in Task 4.
4. **Gas giants** — `paintAtmosphere`'s `tint` (band average) must still win on colour once `air` is also passed; only thickness/density come from the roll. Covered by the Task 5 pixel look on `gas`.
5. **Clicks after the layout moves** — moving `cyBody` shifts everything; tile picking must still land on the tile under the cursor. `hitTest centre` stays green, and Task 5 includes a click check in the preview.

---

### Task 1: Baseline instruments — bench and rolled-air distribution

Measure before anything changes. Nothing in `src/` is touched.

**Files:**
- Modify: `tools/atmosphereCheck.ts`

**Interfaces:**
- Produces: `measure(type: string, air?: AtmosphereChannel): Metrics` (hue baseline = `air.hue` when given); flags `--bench` and `--rolled`.

- [ ] **Step 1: Let `measure` take an air channel**

In `tools/atmosphereCheck.ts`, change the import line and `measure`:

```ts
const { genomeFromLegacy, rollPlanetGenome, genomeSeedFor } =
  await import('../src/simulation/PlanetGenome');
type Air = ReturnType<typeof genomeFromLegacy>['atmosphere'];
```

```ts
function measure(type: string, air?: Air): Metrics {
  const img = new FakeImageData(W, H);
  paintAtmosphere(img as any, geom, type as any, 0, 0, 1, undefined, air);
```

and the hue baseline inside it:

```ts
  const baseHue = (air ?? genomeFromLegacy(type, 0).atmosphere).hue;
```

- [ ] **Step 2: Add `--rolled` — the existing four metrics over 12 rolled seeds per type**

After the existing `for (const type of TYPES)` loop and before `process.exit`, add:

```ts
if (ROLLED) {
  console.log('\n  ROLLED — every seed must pass, not the median. 12 seeds per type.');
  for (const type of TYPES) {
    const rows: Metrics[] = [];
    for (let i = 0; i < 12; i++) {
      const air = rollPlanetGenome(genomeSeedFor(100 + i, 0), type, null).atmosphere;
      const m = measure(type, air);
      rows.push(m);
      const bad: string[] = [];
      if (m.seam > WANT_SEAM) bad.push(`seam ${m.seam.toFixed(2)}`);
      if (m.chroma < WANT_CHROMA) bad.push(`chroma ${m.chroma}`);
      if (m.hueDrift > MAX_HUE_DRIFT) bad.push(`hueDrift ${m.hueDrift.toFixed(1)}`);
      if (m.thickSpread <= WANT_THICK) bad.push(`thick ${m.thickSpread.toFixed(2)}`);
      if (m.aerialFall < WANT_FALL) bad.push(`fall ${m.aerialFall.toFixed(2)}`);
      if (m.nearAlpha < MIN_NEAR_ALPHA) bad.push(`near ${m.nearAlpha.toFixed(1)}`);
      if (bad.length) { failed++; console.log(`  FAIL  [${type} seed#${i}] ${bad.join(', ')}  (thickness ${air.thicknessPx}px, density ${air.density.toFixed(2)})`); }
    }
    const span = (k: keyof Metrics) => {
      const v = rows.map(r => r[k] as number).sort((a, b) => a - b);
      return `${v[0].toFixed(2)} / ${v[6].toFixed(2)} / ${v[11].toFixed(2)}`;
    };
    console.log(`  ${type}  min/median/max  seam ${span('seam')}  chroma ${span('chroma')}  hueDrift ${span('hueDrift')}  thick ${span('thickSpread')}  fall ${span('aerialFall')}`);
  }
}
```

and near the top, beside `CONTROL`:

```ts
const ROLLED = process.argv.includes('--rolled');
const BENCH = process.argv.includes('--bench');
```

- [ ] **Step 3: Add `--bench` — median `paintAtmosphere` time at 1200×800**

A fixed geometry literal, so Tasks 2-5 compare like with like even after Task 3 changes `habitableGeom`. Insert right after the flag declarations and the dynamic imports (the bench exits before the metrics run):

```ts
if (BENCH) {
  const BW = 1200, BH = 800;
  const bgeom: any = { cx: 600, cyTop: 255, rx: 262, ry: 136 };
  const img = new FakeImageData(BW, BH);
  const times: number[] = [];
  for (let i = 0; i < 30; i++) {
    img.data.fill(0);
    const t0 = performance.now();
    paintAtmosphere(img as any, bgeom, 'ocean' as any, 0, 0.7, 1);
    const t1 = performance.now();
    if (i >= 5) times.push(t1 - t0);
  }
  times.sort((a, b) => a - b);
  console.log(`  bench paintAtmosphere 1200x800 ocean: median ${times[12].toFixed(2)} ms (p10 ${times[2].toFixed(2)}, p90 ${times[22].toFixed(2)})`);
  process.exit(0);
}
```

- [ ] **Step 4: Run all three modes and record the baseline**

Run:
```
node_modules/.bin/esbuild tools/atmosphereCheck.ts --bundle --platform=node --format=esm --outfile="$TEMP/atmo.mjs" --log-level=error
node "$TEMP/atmo.mjs"; echo exit $?
node "$TEMP/atmo.mjs" --bench
node "$TEMP/atmo.mjs" --bench
node "$TEMP/atmo.mjs" --rolled; echo exit $?
```
Expected: default mode exit 0 (unchanged). Bench prints a median — run it twice and record the larger as **BASELINE_MS**. `--rolled` is measuring code that has never run on screen: record its result whatever it is.

**If `--rolled` fails any seed: stop and report to the user** with the failing seeds and metrics. Task 4 puts rolled air on screen, so either the roll's ranges or a metric is wrong, and choosing which is the user's call. Tasks 2 and 3 do not depend on this and may proceed.

- [ ] **Step 5: Commit**

```bash
git add tools/atmosphereCheck.ts
git commit -m "test(atmosphere): bench and rolled-air distribution modes

Baseline paintAtmosphere 1200x800: <BASELINE_MS> ms median.
Rolled air, 12 seeds x ocean/lava/desert: <PASS | list of failures>.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The limb wraps the rim (no shelf)

**Files:**
- Modify: `tools/atmosphereCheck.ts` (shelf metrics)
- Modify: `src/rendering/HabitableCutawayEngine.ts` — `ozoneAt` (~line 1192), `paintAtmosphere` (~line 1272)

**Interfaces:**
- Produces: `ozoneAt(...)` return gains `rimPx: number` (0 on/above the rim line and on the face; pixel distance outside the rim ellipse below it). Module-private `rimTaper(ddy: number, ry: number): number`.

- [ ] **Step 1: Write the shelf metrics**

Add to `Metrics` in `tools/atmosphereCheck.ts`:

```ts
interface Metrics {
  seam: number; chroma: number; hueDrift: number;
  thickSpread: number; aerialFall: number; nearAlpha: number;
  shelf: number; bandPixels: number; bandStep: number;
}
```

At the end of `measure`, before the `return`:

```ts
  // 5. shelf — does the limb stop dead on the rim line? Just outside the dome
  //    radius on each side, alpha ON the rim row vs the mean of the three rows
  //    below. Today the rows below are 0 (ozoneAt cuts `y > cy && face > 1`),
  //    so the ratio is the full rim alpha. Only samples with a visible rim
  //    count, or a ratio of two near-zero alphas decides the verdict.
  const cy = geom.cyTop;
  let shelf = 1;
  for (const side of [-1, 1]) {
    for (let k = 1; k <= 4; k++) {
      const x = Math.round(geom.cx + side * (geom.rx + k));
      const top = A(x, cy);
      if (top < 6) continue;
      const below = (A(x, cy + 1) + A(x, cy + 2) + A(x, cy + 3)) / 3;
      shelf = Math.max(shelf, top / Math.max(1, below));
    }
  }

  // 6. bandPixels — does the band continue round the rim at all? Visible
  //    pixels outside the face ellipse and below the rim line.
  // 7. bandStep — and when it ends, does it fade or cut? The largest
  //    downward alpha ratio between vertically adjacent band pixels, among
  //    pixels bright enough (>= 8) for a step to be seen.
  let bandPixels = 0, bandStep = 1;
  const outside = (x: number, y: number) => {
    const fx = (x - geom.cx) / geom.rx, fy = (y - cy) / geom.ry;
    return fx * fx + fy * fy > 1;
  };
  for (let y = cy + 1; y <= cy + geom.ry && y < H - 1; y++) {
    for (let x = geom.cx - geom.rx - 40; x <= geom.cx + geom.rx + 40; x++) {
      if (x < 0 || x >= W || !outside(x, y)) continue;
      const a = A(x, y);
      if (a >= 3) bandPixels++;
      if (a >= 8) bandStep = Math.max(bandStep, a / Math.max(1, A(x, y + 1)));
    }
  }

  return { seam, chroma, hueDrift, thickSpread, aerialFall, nearAlpha, shelf, bandPixels, bandStep };
```

Thresholds, next to the existing ones:

```ts
// Shelf: same ratio scale as `seam`. bandPixels: at least ry visible pixels
// across both sides — a band a few px wide running a fraction of the rim.
// bandStep: a linear fade over >= 3 px never exceeds ~3x between rows at alpha >= 8.
const WANT_SHELF = 2.0, MIN_BAND_PIXELS = geom.ry, MAX_BAND_STEP = 3.0;
```

In the per-type print block:

```ts
  console.log(`    shelf (rim row / rows below)           : ${m.shelf.toFixed(2)}`);
  console.log(`    band below rim: pixels / max step      : ${m.bandPixels} / ${m.bandStep.toFixed(2)}`);
```

In the `CONTROL` branch (comment: *the shelf control passes on renderers before the atmosphere-pass commit; the other four only on 898a4c6 and earlier — run it against the matching old renderer via `git show <sha>:src/rendering/HabitableCutawayEngine.ts`*):

```ts
    assert(type, 'limb stops on the rim line', m.shelf > WANT_SHELF,
      `${m.shelf.toFixed(2)} > ${WANT_SHELF}`);
    assert(type, 'no band below the rim', m.bandPixels < MIN_BAND_PIXELS,
      `${m.bandPixels} < ${MIN_BAND_PIXELS}`);
```

In the default branch:

```ts
    assert(type, 'no shelf at the rim line', m.shelf <= WANT_SHELF,
      `${m.shelf.toFixed(2)} <= ${WANT_SHELF}`);
    assert(type, 'limb continues round the rim', m.bandPixels >= MIN_BAND_PIXELS,
      `${m.bandPixels} >= ${MIN_BAND_PIXELS}`);
    assert(type, 'band fades out, no new cut', m.bandStep <= MAX_BAND_STEP,
      `${m.bandStep.toFixed(2)} <= ${MAX_BAND_STEP}`);
```

Add the same three conditions to the `--rolled` `bad` list:

```ts
      if (m.shelf > WANT_SHELF) bad.push(`shelf ${m.shelf.toFixed(2)}`);
      if (m.bandPixels < MIN_BAND_PIXELS) bad.push(`band ${m.bandPixels}`);
      if (m.bandStep > MAX_BAND_STEP) bad.push(`bandStep ${m.bandStep.toFixed(2)}`);
```

- [ ] **Step 2: Run it — it must FAIL on today's renderer**

Run: `node_modules/.bin/esbuild tools/atmosphereCheck.ts --bundle --platform=node --format=esm --outfile="$TEMP/atmo.mjs" --log-level=error && node "$TEMP/atmo.mjs"; echo exit $?`
Expected: exit 1. On all three types: `no shelf at the rim line` FAIL (shelf well above 2), `limb continues round the rim` FAIL (bandPixels 0). The six older assertions still PASS. **If the shelf assertions pass here, the metric is wrong — stop and fix the metric, not the renderer.** Record the three shelf values.

- [ ] **Step 3: Extend `ozoneAt` with the rim band**

In `src/rendering/HabitableCutawayEngine.ts`, replace `ozoneAt` with:

```ts
/**
 * How much of the air band survives below the rim line, 1 on the line and 0 at
 * the front of the rim. The line of sight through the air shortens toward the
 * front, and the band must reach zero before the pancake-only cut below
 * (`y > cy + ry`) or that cut becomes a new shelf.
 */
function rimTaper(ddy: number, ry: number): number {
  const t = 1 - ddy / ry;
  return t <= 0 ? 0 : t * t;
}

function ozoneAt(
  x: number, y: number, geom: HabitableGeom, bob: number,
  extraPx = 0,
): { dome: number; face: number; dx: number; distPx: number; rimPx: number } | null {
  const { cx, rx, ry } = geom;
  const cy = geom.cyTop + bob;
  const ddx = x - cx, ddy = y - cy;
  const dx = ddx / rx;
  // Math.hypot is precise about overflow/underflow we will never hit at these
  // pixel magnitudes; it cost ~20% of this function's time in profiling.
  const distPx = Math.sqrt(ddx * ddx + ddy * ddy);
  if (distPx > rx + extraPx) return null;
  // PANCAKE-ONLY. The body is a half-dome sitting on a disc, so there is no air
  // below the tabletop. This line is correct for that geometry and WRONG the
  // moment the body becomes a sphere — a sphere has a limb all the way round,
  // and this would shear its lower half off. Delete it with the pancake, not
  // before. (Called out in the 2026-09-08 genome plan's non-goals.)
  if (y > cy + ry) return null;
  const dyr = ddy / ry;
  const face = dx * dx + dyr * dyr;
  // Below the rim line and outside the face: the limb band wrapping round the
  // front of the rim. Measured from the rim ELLIPSE, not the dome circle — on
  // the rim line the two coincide (the ellipse's extreme x is rx), so the band
  // continues the dome's limb with no step. This used to be a hard cut, which
  // drew a horizontal shelf where the glow ended at rim height.
  let rimPx = 0;
  if (y > cy && face > 1) {
    rimPx = distPx * (1 - 1 / Math.sqrt(face));
    if (rimPx >= extraPx * rimTaper(ddy, ry)) return null;
  }
  return { dome: (distPx / rx) * (distPx / rx), face, dx, distPx, rimPx };
}
```

`bakeAirMask` calls `ozoneAt(x, y, geom, 0)` with `extraPx = 0`, so any `rimPx > 0` returns null there: wisps do not spread into the new band.

- [ ] **Step 4: Use the band in `paintAtmosphere`**

Replace these three lines inside the loop:

```ts
      const beyond = hit.distPx - rx;
      const edge = beyond <= 0 ? 1 : Math.max(0, 1 - beyond / localFade);
```

with:

```ts
      // Above the rim line the shell is measured from the dome circle; below
      // it, from the rim ellipse, thinning toward the front (see rimTaper).
      const below = hit.rimPx > 0;
      const beyond = below ? hit.rimPx : hit.distPx - rx;
      const bandFade = below ? Math.max(0.001, localFade * rimTaper(y - cy, ry)) : localFade;
      const edge = beyond <= 0 ? 1 : Math.max(0, 1 - beyond / bandFade);
```

Then fade the band's WHOLE glow with `edge`, not just the limb term. `domeGlow` and `faceGlow` carry an unscaled base (`0.07`, `0.03`) that is cut off hard where `edge < 0.02` — acceptable against space on the dome, but wrapped under the rim it would end as a new cut (and fail `bandStep`). The gain blends in over the first 6 rows below the rim line so the band still meets the dome with no step. Replace:

```ts
      const glow      = faceGlow + (domeGlow - faceGlow) * blend + aerial;
```

with:

```ts
      const bandGain  = below ? 1 + (edge - 1) * Math.min(1, (y - cy) / 6) : 1;
      const glow      = (faceGlow + (domeGlow - faceGlow) * blend + aerial) * bandGain;
```

- [ ] **Step 5: Run the check — it must pass**

Run: `node "$TEMP/atmo.mjs"` after re-bundling (same command as Step 2).
Expected: exit 0, every assertion PASS on ocean, lava, desert. Then `node "$TEMP/atmo.mjs" --rolled` — no NEW failures versus Task 1. If `band fades out, no new cut` fails, render it (Step 7) before touching the threshold: a visible cut is a real defect.

- [ ] **Step 6: Bench and the no-readback gate**

Run: `node "$TEMP/atmo.mjs" --bench` twice; take the larger. Expected: ≤ BASELINE_MS × 1.10.
Run: `node_modules/.bin/esbuild tools/habitableDioramaCheck.ts --bundle --platform=node --format=esm --outfile="$TEMP/hab.mjs" --log-level=error && node "$TEMP/hab.mjs"; echo exit $?`
Expected: exit 0.

- [ ] **Step 7: Look at the pixels**

With `npm run dev` running, open `http://localhost:3000/diorama-preview.html?type=ocean&seed=7`, then `lava`, `storm`. Zoom on the rim at both sides at rim height. Expected: the glow curls round the front of the rim and fades out; no horizontal edge at rim height; no glow under the tabletop. If it reads wrong while the metric passes, the metric is wrong — say so.

- [ ] **Step 8: Commit**

```bash
git add tools/atmosphereCheck.ts src/rendering/HabitableCutawayEngine.ts
git commit -m "fix(atmosphere): wrap the limb round the rim instead of cutting it at rim height

Shelf ratio <before> -> <after>; band pixels 0 -> <n>. paintAtmosphere <ms> ms vs <BASELINE_MS> baseline.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The dome fits the frame

**Files:**
- Modify: `src/simulation/PlanetGenome.ts` (export the thickness cap)
- Modify: `src/rendering/HabitableCutawayEngine.ts` — constants near line 128, `habitableGeom` (~line 152), `paintCutawayCrust` crustH (~line 1051), `paintAtmosphere` fadeMax
- Modify: `tools/habitableDioramaCheck.ts` (framing section)

**Interfaces:**
- Consumes: `paintAtmosphere(img, geom, type, bob, sunAzimuth, intensity, tint?, air?)`, `paintCutawayCrust(g, opts)`.
- Produces: `export const ATMO_THICKNESS_MAX_PX = 13` (PlanetGenome); `export function ozoneFadeMax(thicknessPx: number): number`; `export function crustDepthOf(rx: number): number`; `export function keelBottomOf(g: Pick<HabitableGeom, 'cyTop' | 'rx' | 'ry' | 'wall'>): number` (all HabitableCutawayEngine).

- [ ] **Step 1: Write the framing check**

In `tools/habitableDioramaCheck.ts`, directly after the `bob is disabled` check (before `console.log('');`), add:

```ts
// ─── The dome and keel are on canvas ──────────────────────────────────────────
//
// habitableGeom used to reserve room for T above the body, not for the dome,
// whose top sits at cyTop - rx - fadeMax. With R at its 0.36*VH cap the dome
// top landed at about -0.01*VH before the fade band was even counted.
// Measured on real paint, not on the formula: atmosphere at the THICKEST air
// the roll can produce, crust painted into a canvas taller than the view so a
// keel that overhangs the bottom is seen rather than clipped away.
{
  const { paintAtmosphere: paintAir, paintCutawayCrust: paintCrust } =
    await import('../src/rendering/HabitableCutawayEngine');
  const { ATMO_THICKNESS_MAX_PX } = await import('../src/simulation/PlanetGenome');
  const thickAir = { hue: 210, saturation: 0.8, thicknessPx: ATMO_THICKNESS_MAX_PX, density: 1.6 };
  const SIZES: Array<[number, number]> = [[1200, 800], [1174, 650], [390, 844], [480, 320]];
  for (const [W, H] of SIZES) {
    const gm = habitableGeom(W, H);
    const img = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
    paintAir(img as any, gm, 'ocean', 0, 0, 1, undefined, thickAir);
    let domeTop = -1;
    for (let y = 0; y < H && domeTop < 0; y++) {
      for (let x = 0; x < W; x++) {
        if (img.data[(y * W + x) * 4 + 3] > 2) { domeTop = y; break; }
      }
    }
    check(`dome on canvas ${W}x${H}`, domeTop >= 2, `top alpha row ${domeTop}`);

    let keelBottom = -1;
    for (const seed of [1, 0xbeef, 77]) {
      const tall = makeCanvas(W, H + 400);
      const tctx = tall.getContext() as RecordingCtx;
      paintCrust(tctx as unknown as CanvasRenderingContext2D, {
        w: W, h: H + 400, cx: gm.cx, cyTop: gm.cyTop, rx: gm.rx, ry: gm.ry,
        wall: gm.wall, seed, planetType: 'ocean',
      } as any);
      for (let y = H + 399; y >= 0; y--) {
        let hit = false;
        for (let x = 0; x < W; x++) if (tctx.mask[y * W + x]) { hit = true; break; }
        if (hit) { keelBottom = Math.max(keelBottom, y); break; }
      }
    }
    check(`keel on canvas ${W}x${H}`, keelBottom >= 0 && keelBottom <= H - 3,
          `keel bottom ${keelBottom} of ${H}`);
  }
  // Review focus: the shrink loop must terminate on a tiny view.
  const tiny = habitableGeom(120, 90);
  check('tiny view still lays out', tiny.R >= 16 && Number.isFinite(tiny.cyTop),
        `R=${tiny.R} cyTop=${tiny.cyTop}`);
}
```

- [ ] **Step 2: Export the thickness cap so the check compiles**

In `src/simulation/PlanetGenome.ts`, above `rollPlanetGenome`:

```ts
/**
 * The thickest shell the roll can produce, in native px. The home-world
 * layout reserves room for this much air above the dome, so it must stay the
 * roll's real upper bound.
 */
export const ATMO_THICKNESS_MAX_PX = 13;
```

and in `rollPlanetGenome` replace `thicknessPx: Math.round(rand(seed, 107, 6, 13)),` with:

```ts
      thicknessPx: Math.round(rand(seed, 107, 6, ATMO_THICKNESS_MAX_PX)),
```

(`rand` returns `[lo, hi)`, so `Math.round` never exceeds 13. `genomeCheck` still passes — values are unchanged.)

- [ ] **Step 3: Run it — framing must FAIL today**

Run: `node_modules/.bin/esbuild tools/habitableDioramaCheck.ts --bundle --platform=node --format=esm --outfile="$TEMP/hab.mjs" --log-level=error && node "$TEMP/hab.mjs"; echo exit $?`
Expected: exit 1, with `dome on canvas 1200x800` and `dome on canvas 1174x650` FAIL (top alpha row 0). `390x844` is expected to pass already (the width cap binds there). **If no dome check fails, the metric is wrong — stop.** Record the keel bottoms: they are the headroom the fix will spend.

- [ ] **Step 4: Shared helpers in `HabitableCutawayEngine.ts`**

Change the import at line 37 to:

```ts
import { genomeFromLegacy, ATMO_THICKNESS_MAX_PX, type AtmosphereChannel } from '../simulation/PlanetGenome';
```

After `export const CY_TOP_DROP = 0.67;` add:

```ts
/** Clear space kept above the dome's air and below the keel, in px. */
export const FRAME_MARGIN_PX = 4;

/**
 * How far past the dome the ozone band can reach for a shell of `thicknessPx`:
 * the wobble swings it by up to ±55% (WOBBLE_AMP), plus 2px of feather.
 * paintAtmosphere and the layout both read this, so they cannot disagree.
 */
export function ozoneFadeMax(thicknessPx: number): number {
  return thicknessPx * 1.6 + 2;
}

/** Deepest the hanging keel can drop below the front wall. */
export function crustDepthOf(rx: number): number {
  return Math.max(8, Math.round(rx * 0.88));
}

/** Lowest pixel the crust can reach: rim front + wall + ridge (±2.5) + keel. */
export function keelBottomOf(g: Pick<HabitableGeom, 'cyTop' | 'rx' | 'ry' | 'wall'>): number {
  return g.cyTop + g.ry + g.wall + 3 + crustDepthOf(g.rx);
}
```

In `paintCutawayCrust` replace `const crustH = Math.max(8, Math.round(rx * 0.88));` with `const crustH = crustDepthOf(rx);`.

In `paintAtmosphere` replace `const fadeMax = fade * 1.6 + 2;` with `const fadeMax = ozoneFadeMax(fade);`.

- [ ] **Step 5: Rewrite `habitableGeom` with the framing constraint**

`HabitableGeom` is declared after the constants; the helpers above only use it as a type, which TypeScript hoists. Replace `habitableGeom` with:

```ts
/**
 * Lay the body out for one R. Pushes the whole body down if the dome's air
 * would leave the top of the canvas — there is empty space under the keel in
 * every normal view, so moving is cheaper than shrinking.
 */
function layoutAt(VW: number, VH: number, R: number): HabitableGeom {
  const T = Math.max(ATMO_MIN_PX, Math.round(R * ATMO_RATIO));
  const cx = Math.round(VW / 2);
  const rx = Math.max(8, Math.round(R * BOARD_WIDTH));
  const ry = Math.max(6, Math.round(rx * BOARD_SQUASH));
  const wall = Math.max(4, Math.round(rx * WALL_RATIO));
  let cyBody = Math.round(VH * 0.56);
  let cyTop = Math.round(cyBody - CY_TOP_DROP * R);
  const domeTop = cyTop - rx - Math.ceil(ozoneFadeMax(ATMO_THICKNESS_MAX_PX));
  if (domeTop < FRAME_MARGIN_PX) {
    const shift = FRAME_MARGIN_PX - domeTop;
    cyBody += shift;
    cyTop += shift;
  }
  return { cx, cyBody, cyTop, R, rx, ry, wall, T };
}

export function habitableGeom(VW: number, VH: number): HabitableGeom {
  let R = Math.round(Math.min(VW * 0.50, VH * 0.36));
  const T = Math.max(ATMO_MIN_PX, Math.round(R * ATMO_RATIO));
  // If the shell would clip, shrink R — never shrink T below ATMO_MIN_PX.
  const maxR = Math.floor(Math.min(VW, VH) / 2 - T - 4);
  if (R > maxR) R = Math.max(16, maxR);
  // The dome must fit above and the keel below. Moving the body down (in
  // layoutAt) spends the space under the keel; only when that runs out does
  // the body shrink. Each step down in R raises the dome top and the keel
  // bottom together, so this terminates well before the 16px floor in any
  // real view — the floor is only a guard for degenerate sizes.
  for (;;) {
    const g = layoutAt(VW, VH, R);
    if (R <= 16 || keelBottomOf(g) <= VH - FRAME_MARGIN_PX) return g;
    R -= 1;
  }
}
```

- [ ] **Step 6: Run the framing check — it must pass, and nothing else regresses**

Run: `node "$TEMP/hab.mjs"` after re-bundling. Expected: exit 0, all four sizes pass both checks, `tiny view still lays out` passes, and the older pancake checks (`cyTop drop 0.67 R`, `pancake overhangs crest`, …) still pass.
Then run `tools/surfaceDecalCheck.ts` and `tools/atmosphereCheck.ts` (default and `--bench`) the same way. Expected: exit 0 each; bench within budget.

If a `keel on canvas` check fails, the measured keel is deeper than `keelBottomOf` claims — fix `keelBottomOf` to match the paint, never the other way round.

- [ ] **Step 7: Look at the pixels and click a tile**

Preview at ocean seed 7 and lava seed 7. Expected: the dome's top and its glow are fully on canvas; the keel is fully on canvas; moons and the sun sprite do not sit on top of the dome (if they do, report — do not move them in this task). Click a tile near the centre of the face: the selected tile must be the one under the cursor.

- [ ] **Step 8: Commit**

```bash
git add src/simulation/PlanetGenome.ts src/rendering/HabitableCutawayEngine.ts tools/habitableDioramaCheck.ts
git commit -m "fix(diorama): lay the body out so the dome's air and the keel both fit the frame

Dome top row at 1200x800: 0 -> <n>; keel bottom <n> of 800.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Each world draws its own air

**Gate:** Task 1's `--rolled` result must be green, or the user must have ruled on its failures. Do not start this task on an unresolved red.

**Files:**
- Modify: `src/simulation/PlanetGenome.ts` (helper + module doc)
- Modify: `tools/genomeCheck.ts`
- Modify: `src/rendering/HabitableCutawayEngine.ts` — `HabitableFrameInput`, `frame()`
- Modify: `tools/habitableDioramaCheck.ts` (genome-reach check)
- Modify: `src/rendering/IsoDioramaRenderer.ts` — field, getter, `frame()` input
- Modify: `src/dev/dioramaPreview.ts` — `makePlanet`

**Interfaces:**
- Consumes: `rollPlanetGenome(seed, type, dna)`, `legacyChannel(type)` (module-private), `paintAtmosphere(..., air?)`.
- Produces: `export function atmosphereForPlanet(genomeSeed: number | undefined, type: string): AtmosphereChannel`; `HabitableFrameInput.air?: AtmosphereChannel`.

- [ ] **Step 1: Write the genomeCheck tests**

Append to `tools/genomeCheck.ts` before its final exit, and add `atmosphereForPlanet` to its import destructure:

```ts
// 5. atmosphereForPlanet — the air the renderer draws.
{
  const legacyLava = JSON.stringify(genomeFromLegacy('lava', 0).atmosphere);
  check('no seed -> shipped per-type air',
    JSON.stringify(atmosphereForPlanet(undefined, 'lava')) === legacyLava);
  check('NaN seed -> shipped per-type air',
    JSON.stringify(atmosphereForPlanet(NaN, 'lava')) === legacyLava);
  check('seeded air is the rolled air',
    JSON.stringify(atmosphereForPlanet(5, 'ocean')) ===
    JSON.stringify(rollPlanetGenome(5, 'ocean', null).atmosphere));
  check('two worlds of one type differ',
    JSON.stringify(atmosphereForPlanet(1, 'ocean')) !==
    JSON.stringify(atmosphereForPlanet(2, 'ocean')));
  // Terraforming: same world, new type — the air follows the type.
  const ocean = atmosphereForPlanet(42, 'ocean'), lava = atmosphereForPlanet(42, 'lava');
  const dHue = Math.min(Math.abs(ocean.hue - lava.hue), 360 - Math.abs(ocean.hue - lava.hue));
  check('air follows a terraformed type', dHue > 60, `hue ${ocean.hue.toFixed(0)} vs ${lava.hue.toFixed(0)}`);
}
```

- [ ] **Step 2: Write the engine genome-reach check**

In `tools/habitableDioramaCheck.ts`, inside the per-type loop, immediately after the `frame reuses live ImageData` check, add:

```ts
  // Genome reach: the air a host passes must be the air that gets painted.
  // Hand-built channels 180 degrees apart, so the verdict depends on the
  // wiring, not on how far two particular seeds happen to drift.
  if (planetType === 'ocean') {
    const limbOf = (air: unknown) => {
      engine.frame({
        g: frameCtx as unknown as CanvasRenderingContext2D,
        dt: 1 / 60, elapsed: 1.2, bg: makeCanvas(VW, VH),
        drawFarSpace: () => {}, drawOverlays: () => {}, drawNearMoons: () => {},
        weatherMix: [], air,
      } as any);
      const img = (engine as any).atmoImage as { width: number; data: Uint8ClampedArray };
      const gm = engine.geom;
      const o = (gm.cyTop * img.width + gm.cx + gm.rx - 2) * 4;
      return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
    };
    const a = limbOf({ hue: 210, saturation: 0.8, thicknessPx: 8, density: 1 });
    const b = limbOf({ hue: 30, saturation: 0.8, thicknessPx: 8, density: 1 });
    const dist = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    check('frame paints the air it is given', a[3] > 0 && dist >= 40,
          `limb colour distance ${dist.toFixed(1)}, alpha ${a[3]}`);
  }
```

- [ ] **Step 3: Run both — they must FAIL today**

Run genomeCheck and habitableDioramaCheck (bundle + run as in Global Constraints).
Expected: genomeCheck fails to bundle or fails with `atmosphereForPlanet is not a function` (the helper does not exist yet). habitableDioramaCheck exits 1 with `frame paints the air it is given` FAIL, distance 0 — today's `frame()` ignores `air`. **If the engine check passes, the metric is wrong — stop.**

- [ ] **Step 4: Add `atmosphereForPlanet` and correct the module doc**

In `src/simulation/PlanetGenome.ts`, after `genomeFromLegacy`:

```ts
/**
 * The air to draw for a planet.
 *
 * Pass the LIVE type. Type sets the colour family and the seed sets the drift
 * around it, so a terraformed world's air follows its new type while its
 * drift — its identity — stays the same. With no usable seed (a dev harness,
 * or anything that bypassed `loadState`'s backfill) this is the shipped
 * per-type air, exactly as before genomes reached the screen.
 */
export function atmosphereForPlanet(
  genomeSeed: number | undefined, type: string,
): AtmosphereChannel {
  return Number.isFinite(genomeSeed)
    ? rollPlanetGenome(genomeSeed as number, type, null).atmosphere
    : legacyChannel(type);
}
```

In the module header, replace the sentence
`The genome is NEVER derived from \`planet.type\`: terraforming mutates type (BigBangEngine TERRAFORM_SEQUENCES), and a type-derived genome would silently reroll a world's identity mid-game. Type biases the roll once, at creation, and is recorded as \`sourceType\` for reference only.`
with:

```
 * The SEED is never derived from `planet.type`: terraforming mutates type
 * (BigBangEngine TERRAFORM_SEQUENCES), and a type-derived seed would silently
 * reroll a world's identity mid-game. Type is an input to the roll — it sets
 * the colour family the seed drifts around — so the air of a terraformed world
 * follows its new type while keeping its own drift. `sourceType` records the
 * type a genome was rolled with.
```

- [ ] **Step 5: Thread `air` through the engine**

In `HabitableFrameInput` (`HabitableCutawayEngine.ts` ~line 1740), after `viewZoom`:

```ts
  /** This world's air. Omitted: the shipped per-type air. */
  air?: AtmosphereChannel;
```

In `frame()`, change the call to:

```ts
      paintAtmosphere(atmo, this.geom, this.planetType, bob, sunAzimuth, haze, gasTint, input.air);
```

- [ ] **Step 6: Run both checks — they must pass**

Expected: genomeCheck exit 0 with the five new PASS lines; habitableDioramaCheck exit 0 with `frame paints the air it is given` PASS.

- [ ] **Step 7: Feed the rolled air from the host**

In `src/rendering/IsoDioramaRenderer.ts`, add to the imports:

```ts
import { atmosphereForPlanet, type AtmosphereChannel } from '../simulation/PlanetGenome';
```

Next to `private planet: Planet | null = null;` (~line 475):

```ts
  /** Rolled air, keyed by seed AND type — a terraformed world must re-roll. */
  private airCache: { key: string; air: AtmosphereChannel } | null = null;
```

Near the `planetSeed` getter (~line 623):

```ts
  /** This world's air; see `atmosphereForPlanet`. */
  private get air(): AtmosphereChannel {
    const seed = this.planet?.genomeSeed;
    const key = `${seed}|${this.planetType}`;
    if (!this.airCache || this.airCache.key !== key) {
      this.airCache = { key, air: atmosphereForPlanet(seed, this.planetType) };
    }
    return this.airCache.air;
  }
```

In `frame()`'s `this.cutaway.frame({ ... })` object (~line 2479), after `viewZoom: this.viewZoom,`:

```ts
        air: this.air,
```

- [ ] **Step 8: Give the preview planet a genome seed**

In `src/dev/dioramaPreview.ts` `makePlanet()`, after `name: \`Preview-${seed}\`,`:

```ts
    genomeSeed: seed,
```

- [ ] **Step 9: Typecheck and look**

Run: `node_modules/.bin/tsc --noEmit -p . 2>&1 | grep -c "error TS"`. Expected: `2` (the pre-existing pair).
In the preview, load `?type=ocean&seed=3`, then `seed=4`, and in the page run:

```js
const d = window.__diorama, g = d.cutaway.drawGeom, c = document.querySelector('canvas');
const p = c.getContext('2d').getImageData(Math.round(g.cx + g.rx + 3), Math.round(g.cyTop - 6), 1, 1).data;
[...p]
```

Expected: the limb pixel differs between the two seeds, both reading as the ocean colour family (blue). Repeat for `lava` 3/4 (both orange-red, not pink). If the canvas lookup returns the wrong canvas, read `document.querySelectorAll('canvas')` and pick the display canvas. If `__diorama.cutaway` is undefined, find the renderer's field name with `Object.keys(window.__diorama)`.

- [ ] **Step 10: Commit**

```bash
git add src/simulation/PlanetGenome.ts src/rendering/HabitableCutawayEngine.ts src/rendering/IsoDioramaRenderer.ts src/dev/dioramaPreview.ts tools/genomeCheck.ts tools/habitableDioramaCheck.ts
git commit -m "feat(atmosphere): each world draws its own rolled air

rollPlanetGenome was called nowhere in src/, so every world of a type drew
genomeFromLegacy(type, 0). The renderer now rolls per (genomeSeed, type).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Whole-pass verification

No new code unless a check fails; a failure goes back to the task that owns it.

**Files:** none (memory update at the end)

- [ ] **Step 1: Run every check**

```
for t in atmosphereCheck habitableDioramaCheck genomeCheck surfaceDecalCheck smokeTest; do
  node_modules/.bin/esbuild tools/$t.ts --bundle --platform=node --format=esm --outfile="$TEMP/$t.mjs" --log-level=error && node "$TEMP/$t.mjs" > "$TEMP/$t.out" 2>&1; echo "$t exit $?"; done
node "$TEMP/atmosphereCheck.mjs" --rolled; echo rolled exit $?
node "$TEMP/atmosphereCheck.mjs" --bench
node_modules/.bin/tsc --noEmit -p . 2>&1 | grep -c "error TS"
```

Expected: atmosphereCheck, habitableDioramaCheck, genomeCheck, surfaceDecalCheck exit 0; `--rolled` exit 0; bench ≤ BASELINE_MS × 1.10; tsc `2`. smokeTest must match its result at `39e9c45` — run it there first (`git stash` is not needed; use `git worktree add "$TEMP/wt-base" 39e9c45` and run it in the worktree) and compare assertion-by-assertion. This pass touches no simulation code, so any difference is a finding.

- [ ] **Step 2: Control against the old renderer**

Prove the shelf metric sees the bug on the code that had it:

```
git show 39e9c45:src/rendering/HabitableCutawayEngine.ts > "$TEMP/old-engine.ts"
cp src/rendering/HabitableCutawayEngine.ts "$TEMP/new-engine.ts"
cp "$TEMP/old-engine.ts" src/rendering/HabitableCutawayEngine.ts
node_modules/.bin/esbuild tools/atmosphereCheck.ts --bundle --platform=node --format=esm --outfile="$TEMP/atmo-old.mjs" --log-level=error; node "$TEMP/atmo-old.mjs"; echo old exit $?
cp "$TEMP/new-engine.ts" src/rendering/HabitableCutawayEngine.ts
git diff --stat src/rendering/HabitableCutawayEngine.ts
```

Expected: old exit 1 with the shelf assertions failing on all three types. The final `git diff --stat` must show nothing (the file is restored). The old engine lacks `ozoneFadeMax`, but atmosphereCheck does not import it, so it bundles.

- [ ] **Step 3: Pixel look, every case**

Preview, two seeds each: `ocean`, `lava`, `desert`, `storm`, `gas`. For each: dome fully on canvas; limb wraps the rim and fades, no shelf; no air under the tabletop; the air is in the type's colour family (lava is orange-red, never pink); the two seeds differ; gas keeps its band-tinted air. Click one tile per type — the selection lands under the cursor. Save a zoomed screenshot of ocean and lava rims for the report.

- [ ] **Step 4: Update memory**

In `C:\Users\Sirjohn\.claude\projects\C--Users-Sirjohn-Documents-Eternal-System\memory\atmosphere-clouds-next.md`, record: sub-project 1 shipped (commits), bench before/after, the `--rolled` outcome, and that sub-project 2 (weather sim, visual-only, grid-driven) is next. In `verification.md`, add rows for `atmosphereCheck --rolled/--bench` and the framing section of `habitableDioramaCheck`.

- [ ] **Step 5: Report**

Report to the user with numbers (shelf before/after, dome top row before/after per size, bench before/after, rolled result) and the two screenshots. Name anything that passed the metric but looked wrong.
