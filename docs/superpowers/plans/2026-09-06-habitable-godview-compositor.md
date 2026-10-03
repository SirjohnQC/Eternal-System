# Habitable God-View Compositor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ocean/rocky dioramas match `diorama_test.html`'s pancake god-view (mockup A) with a thick HTML atmosphere shell, live glitter water, and the current geological crust — while keeping the real `PlanetGrid` on the board.

**Architecture:** `HabitableCutawayEngine` becomes a class that owns habitable geom, bake (crust + land + occupancy + pick), and `frame()` (atmo, fluids, clouds, bob, overlay callbacks). `IsoDioramaRenderer` stays a thin host for lifecycle, overlay data, and the untouched lava/ice/gas path.

**Tech Stack:** Canvas 2D, nearest-neighbour virtual buffer (~480 long edge), existing `PlanetGrid` / `tools/habitableDioramaCheck.ts` (esbuild + node, no Jest).

**Spec:** `docs/superpowers/specs/2026-09-06-habitable-godview-compositor-design.md`

## Global Constraints

- Habitable path only: `planetType === 'ocean' | 'rocky'`. Lava / ice / gas must look unchanged.
- Camera is mockup A pancake: `ry/rx = 0.52`, `rx/R = 0.91`, `cyTop = cyBody − 0.67 R`. Not B/C.
- Atmosphere `T = max(14, round(0.25 * R))`. A 2–4px rim is a bug. HTML 16px-on-R=64 is the picture.
- Water: HTML bands, faster (`t * 3.2` / `t * 1.4`), glint threshold `0.48`. Not the current sleepy `t * 0.55`.
- Real `PlanetGrid` on the tabletop. Do not invent continents.
- Do not import `diorama_test.html` into the game bundle.
- Do not change `PlanetGrid`, authored PNGs, or add meteors / leviathan.
- Smoke command (Windows):  
  `node_modules/.bin/esbuild tools/habitableDioramaCheck.ts --bundle --platform=node --format=esm --outfile=%TEMP%/habcheck.mjs && node %TEMP%/habcheck.mjs`

## File map

| File | Responsibility |
|---|---|
| `src/rendering/HabitableCutawayEngine.ts` | Geom source of truth; class `bake` / `frame` / `hitTest`; crust reshape; land without painted water; occupancy; live atmo + fluids + clouds |
| `src/rendering/IsoDioramaRenderer.ts` | Thin host: habitable `frame`/`bake`/`pickTile` delegate to the engine; legacy lava/ice/gas untouched |
| `tools/habitableDioramaCheck.ts` | Geom ratios, T ≥ 12px, occupancy has land+water, pancake overhang, pick+bob |
| `src/dev/dioramaPreview.ts` | No new flags; `?type=ocean` and `?type=rocky` exercise the path |
| `diorama_test.html` | Reference only |

---

### Task 1: Pancake geometry source of truth

**Files:**
- Modify: `src/rendering/HabitableCutawayEngine.ts` (constants + `habitableGeom`, keep old exports compiling until later tasks delete them)
- Modify: `tools/habitableDioramaCheck.ts` (new geom checks at the top, before canvas work)

**Interfaces:**
- Consumes: nothing new
- Produces:

```ts
export const BOARD_SQUASH = 0.52;
export const BOARD_WIDTH = 0.91;
export const WALL_RATIO = 0.38;
export const ATMO_RATIO = 0.25;
export const ATMO_MIN_PX = 14;
export const CY_TOP_DROP = 0.67; // cyTop = cyBody - 0.67 * R

export interface HabitableGeom {
  cx: number;
  cyBody: number;
  cyTop: number;
  R: number;
  rx: number;
  ry: number;
  wall: number;
  T: number;
}

export function habitableGeom(VW: number, VH: number): HabitableGeom
export function bobOf(elapsed: number, R: number): number
```

- [ ] **Step 1: Write the failing geom checks**

In `tools/habitableDioramaCheck.ts`, *before* the canvas loop, add:

```ts
const {
  habitableGeom, bobOf, BOARD_SQUASH, BOARD_WIDTH, ATMO_RATIO, ATMO_MIN_PX, CY_TOP_DROP,
} = await import('../src/rendering/HabitableCutawayEngine');

const g480 = habitableGeom(480, 320);
check('pancake squash 0.52', Math.abs(g480.ry / g480.rx - BOARD_SQUASH) < 0.02,
      `ry/rx=${(g480.ry / g480.rx).toFixed(3)}`);
check('board width 0.91 R', Math.abs(g480.rx / g480.R - BOARD_WIDTH) < 0.02,
      `rx/R=${(g480.rx / g480.R).toFixed(3)}`);
check('cyTop drop 0.67 R', Math.abs((g480.cyBody - g480.cyTop) / g480.R - CY_TOP_DROP) < 0.03,
      `drop=${((g480.cyBody - g480.cyTop) / g480.R).toFixed(3)}`);
check('atmo T floor', g480.T >= ATMO_MIN_PX && g480.T >= Math.round(g480.R * ATMO_RATIO) - 1,
      `T=${g480.T} R=${g480.R}`);
const crest = g480.cyBody - g480.R;
const farRim = g480.cyTop - g480.ry;
check('pancake overhangs crest', farRim < crest,
      `farRim=${farRim} crest=${crest}`);
check('bob amplitude at least 1', Math.abs(bobOf(Math.PI / 1.4, g480.R)) >= 1,
      `bob=${bobOf(Math.PI / 1.4, g480.R)}`);
```

Do not implement `habitableGeom` yet. Keep the existing `CUTAWAY_FACE_SQUASH` import so the file still parses until Step 3 — comment that import if it collides.

- [ ] **Step 2: Run the check and confirm the new asserts fail**

Run:

```
node_modules/.bin/esbuild tools/habitableDioramaCheck.ts --bundle --platform=node --format=esm --outfile=%TEMP%/habcheck.mjs && node %TEMP%/habcheck.mjs
```

Expected: FAIL (`habitableGeom` is not exported).

- [ ] **Step 3: Implement geom**

Replace the current `CUTAWAY_FACE_SQUASH` / `CUTAWAY_FACE_DROP` / `cutawayBodyCy` / `cutawayFaceCy` *as the habitable source of truth* with:

```ts
export const BOARD_SQUASH = 0.52;
export const BOARD_WIDTH = 0.91;
export const WALL_RATIO = 0.38;
export const ATMO_RATIO = 0.25;
export const ATMO_MIN_PX = 14;
export const CY_TOP_DROP = 0.67;

export interface HabitableGeom {
  cx: number;
  cyBody: number;
  cyTop: number;
  R: number;
  rx: number;
  ry: number;
  wall: number;
  T: number;
}

export function bobOf(elapsed: number, R: number): number {
  const amp = Math.max(1, Math.round(R / 48));
  return Math.sin(elapsed * 0.7) * amp;
}

export function habitableGeom(VW: number, VH: number): HabitableGeom {
  let R = Math.round(Math.min(VW * 0.40, VH * 0.28));
  const T = Math.max(ATMO_MIN_PX, Math.round(R * ATMO_RATIO));
  // If the shell would clip, shrink R — never shrink T below ATMO_MIN_PX.
  const maxR = Math.floor(Math.min(VW, VH) / 2 - T - 4);
  if (R > maxR) R = Math.max(16, maxR);
  const T2 = Math.max(ATMO_MIN_PX, Math.round(R * ATMO_RATIO));
  const cx = Math.round(VW / 2);
  const cyBody = Math.round(VH * 0.56);
  const rx = Math.max(8, Math.round(R * BOARD_WIDTH));
  const ry = Math.max(6, Math.round(rx * BOARD_SQUASH));
  const cyTop = Math.round(cyBody - CY_TOP_DROP * R);
  const wall = Math.max(4, Math.round(rx * WALL_RATIO));
  return { cx, cyBody, cyTop, R, rx, ry, wall, T: T2 };
}
```

Keep `cutawayBodyCy` / `cutawayFaceCy` as deprecated wrappers that call `habitableGeom` equivalents so Task 7 can delete host usage in one go:

```ts
/** @deprecated Task 7 removes host callers. */
export function cutawayFaceCy(cyBody: number, rx: number, ry: number): number {
  const R = Math.round(rx / BOARD_WIDTH);
  return Math.round(cyBody - CY_TOP_DROP * R);
}
```

- [ ] **Step 4: Re-run the check**

Same command as Step 2. Expected: new geom checks PASS. Old canvas checks may still pass or fail; do not "fix" old wall-area assumptions yet (Task 3). If geom checks fail, fix `habitableGeom` before continuing.

- [ ] **Step 5: Commit**

```
git add src/rendering/HabitableCutawayEngine.ts tools/habitableDioramaCheck.ts
git commit -m "feat(diorama): pancake god-view geometry from diorama_test.html"
```

---

### Task 2: Land bake skips water; occupancy + pick still stamp the board

**Files:**
- Modify: `src/rendering/HabitableCutawayEngine.ts` `paintCutawaySurface`
- Modify: `src/rendering/HabitableCutawayEngine.ts` `CutawayBakeOpts` / `CutawayBakeResult`
- Modify: `tools/habitableDioramaCheck.ts`

**Interfaces:**
- Consumes: `HabitableGeom` from Task 1 (opts still pass `cx, cyTop, rx, ry` — do not require the class yet)
- Produces:

```ts
// CutawayBakeOpts gains:
occupancy?: Uint8Array | null; // length w*h, 1 = fluid on the ellipse

// paintCutawaySurface:
// - water/lake cells: alpha 0 on the land canvas, occupancy[i]=1, pick still written
// - land cells: painted as today, occupancy[i]=0
// - REMOVE the "trim tabletop to body silhouette" continue that clips pancake overhang
```

- [ ] **Step 1: Write the failing occupancy checks**

After `paintCutawaySurface` in the existing per-type loop, add (need to pass an occupancy buffer in `opts`):

```ts
const occupancy = new Uint8Array(VW * VH);
opts.occupancy = occupancy;
paintCutawaySurface(sCtx as unknown as CanvasRenderingContext2D, opts);

let waterPx = 0, landPx = 0, waterPainted = 0;
for (let i = 0; i < occupancy.length; i++) {
  if (occupancy[i]) {
    waterPx++;
    if (sCtx.mask[i]) waterPainted++;
  } else if (sCtx.mask[i]) landPx++;
}
check('occupancy has water', waterPx > faceArea * 0.15, `${waterPx} fluid px`);
check('occupancy has land', landPx > 10, `${landPx} land px`);
check('surface does not paint water', waterPainted === 0, `${waterPainted} water px on land canvas`);
```

Also **delete / invert** any check that requires surface coverage `> faceArea * 0.75` — with water unpainted that will fail for the wrong reason. Change it to `landPx > 10` (already above) and keep pick-buffer coverage on the full face (water still stamps pick).

- [ ] **Step 2: Run check — occupancy asserts fail**

Same esbuild command. Expected: FAIL (`occupancy` unused, water still painted, or `opts.occupancy` ignored).

- [ ] **Step 3: Skip water pixels; stamp occupancy + pick**

In `paintCutawaySurface`:

1. Add `occupancy?: Uint8Array | null` to `CutawayBakeOpts`. Zero it when present, same as `pick`.
2. **Remove** this trim (it fights pancake overhang):

```ts
if (py < cyBody - rx * Math.sqrt(Math.max(0, 1 - dx * dx))) continue;
```

3. When the cell is water (`isWater(biome)` or `elev <= SEA_LEVEL` — use the same branch that currently paints ocean colours):

```ts
if (isWater(biome)) {
  const idx = py * VW + px;
  if (opts.occupancy && idx >= 0 && idx < opts.occupancy.length) opts.occupancy[idx] = 1;
  if (pick) pick[idx] = gp.row * GRID_SIZE + gp.col + 1;
  continue; // do not call put()
}
```

Import `isWater` from `PlanetGrid` if not already. Keep land `put()` unchanged (cliffs, lift, biomes).

4. No-grid fallback: treat as all water (occupancy 1, no paint) so the body is not a hole — fluids will fill it in `frame()`.

- [ ] **Step 4: Re-run check**

Expected: occupancy + "surface does not paint water" PASS. Pick buffer still populated (water stamps pick).

- [ ] **Step 5: Commit**

```
git add src/rendering/HabitableCutawayEngine.ts tools/habitableDioramaCheck.ts
git commit -m "feat(diorama): leave ocean cells empty for live fluids"
```

---

### Task 3: Crust is a sphere + sheer wall, not a water bowl

**Files:**
- Modify: `src/rendering/HabitableCutawayEngine.ts` `paintCutawayCrust`
- Modify: `tools/habitableDioramaCheck.ts`

**Interfaces:**
- Consumes: `habitableGeom` ratios; `opts.cx, cyTop, rx, ry`; `opts.occupancy` (rim ocean vs land for the sheer wall)
- Produces: crust pixels inside circle `R` only; none inside the tabletop ellipse; sheer wall of height `wall` under the front rim; geological strata + ember in the lower sphere; **no** hollow water bowl filling `(cyTop+ry) → (cyBody+R)`

- [ ] **Step 1: Rewrite the crust containment checks**

Replace the old "crust spans the centre column" / `wallArea` water-bowl check. Body radius is `R` from `habitableGeom`, **not** `rx`:

```ts
const geom = habitableGeom(VW, VH);
const { cx, cyBody, cyTop, R, rx, ry, wall } = geom;

let outsideBody = 0, insideFace = 0, wallPx = 0;
for (let y = 0; y < VH; y++) {
  for (let x = 0; x < VW; x++) {
    if (cCtx.mask[y * VW + x] === 0) continue;
    if (Math.hypot(x - cx, y - cyBody) > R + 1.5) outsideBody++;
    const fdx = (x - cx) / rx, fdy = (y - cyTop) / ry;
    if (fdx * fdx + fdy * fdy <= 0.98) insideFace++;
    const front = cyTop + Math.sqrt(Math.max(0, 1 - fdx * fdx)) * ry;
    if (Math.abs(fdx) <= 1 && y >= front && y <= front + wall + 6) wallPx++;
  }
}
check('no crust outside sphere R', outsideBody === 0, `${outsideBody} stray`);
check('no crust inside pancake', insideFace === 0, `${insideFace} stray`);
check('sheer wall exists', wallPx > rx * wall * 0.4, `${wallPx} wall px`);
```

- [ ] **Step 2: Run check — expect FAIL on bowl leftovers**

Old `paintCutawayCrust` fills a water column through the lower hemisphere and uses `R = rx`. Expected: FAIL `no crust inside pancake` and/or `outside sphere R` and/or missing sheer wall.

- [ ] **Step 3: Rewrite `paintCutawayCrust`**

Keep: `quantise`, `KEY_X` / `KEY_Y`, `pal.strata`, ember flecks, `fbm1` jagged seabed.

Change the *shape* to match spec + HTML draw order:

1. Compute `geom` locally if needed: `R` is **body radius**, `rx`/`ry` are the pancake. Today the function uses `R = rx` — stop doing that. Prefer `opts` grown with `R` and `wall`, or call `habitableGeom(opts.w, opts.h)` and ignore the host's old `rx`-as-radius.

   Add to `CutawayBakeOpts`: `R: number; wall: number; cyBody: number` so bake and host share one geom.

2. For every pixel with `distSq <= R*R`:
   - If inside the pancake ellipse (`nx²+ny² <= 1` on `rx,ry,cyTop`), **skip** (surface/fluids own it).
   - If `y` is in the HTML skip band (`y < cyTop + ry * 0.28` and `|dx| <= rx`), **skip** — that is the pancake approach, not far-side dirt.
   - Else paint strata by absolute screen depth (`(y - (cyBody - R)) / (2R)`), key-lit, quantised. Ember near the bottom (`depth > 0.78`).

3. Then paint the **sheer wall** (HTML steps 6–7): for `x` in `[cx-rx, cx+rx]`, `frontY = cyTop + sqrt(1-nx²)*ry`, `bottomY = frontY + wall + ridgeNoise`. For `y` from `frontY` to `bottomY`, if still inside the sphere:
   - If occupancy at the rim pixel is water (or no occupancy): water-facet column (`waterDeep` → `waterLip`, every 14th x a lighter facet).
   - Else: cliff stripes from `pal.strata[1]`.

4. Delete the soil-lip + water-bowl + `CUTAWAY_BOTTOM_ROCK` cage fill. Jagged ridge stays as the wall's bottom, not a second hemisphere of water.

- [ ] **Step 4: Re-run check**

Expected: three new crust checks PASS. If `insideFace` still fires, the ellipse skip is wrong — fix before Task 4.

- [ ] **Step 5: Commit**

```
git add src/rendering/HabitableCutawayEngine.ts tools/habitableDioramaCheck.ts
git commit -m "feat(diorama): sphere-and-wall crust, drop the water bowl"
```

---

### Task 4: Live thick atmosphere

**Files:**
- Modify: `src/rendering/HabitableCutawayEngine.ts` — add `paintAtmosphere(...)`; stop treating `bakeCutawayAtmosphere` as the habitable look (keep a stub or delete after Task 7)
- Modify: `tools/habitableDioramaCheck.ts`

**Interfaces:**
- Consumes: `HabitableGeom.T`, `HabitableGeom.R`, `HabitableGeom.cx`, `cyBody`
- Produces:

```ts
export function paintAtmosphere(
  img: ImageData, geom: HabitableGeom, planetType: HabitableType, bob: number,
): void
```

Paints into an existing buffer (or a dedicated canvas). Ring `R < dist <= R+T`, falloff `^1.6`, sun-side 0.85 / shadow 0.28. Limb wrap last `max(5, round(0.08*R))` of the sphere at alpha 0.22. Colour from `paletteFor(type).atmo`.

- [ ] **Step 1: Failing T-width check**

After painting atmosphere into a recording canvas via `putImageData`:

```ts
const bob = 0;
const atmoCanvas = makeCanvas(VW, VH);
const ag = atmoCanvas.getContext() as RecordingCtx;
const img = ag.createImageData(VW, VH);
paintAtmosphere(img, geom, planetType, bob);
ag.putImageData(img, 0, 0);

let ringMin = Infinity, ringMax = 0, ringCount = 0;
for (let y = 0; y < VH; y++) {
  for (let x = 0; x < VW; x++) {
    if (!ag.mask[y * VW + x]) continue;
    const d = Math.hypot(x - geom.cx, y - (geom.cyBody + bob));
    if (d > geom.R + 0.5) {
      ringCount++;
      const t = d - geom.R;
      if (t < ringMin) ringMin = t;
      if (t > ringMax) ringMax = t;
    }
  }
}
check('atmo ring exists', ringCount > 200, `${ringCount} ring px`);
check('atmo ring >= 12px', ringMax >= 12, `outer=${ringMax.toFixed(1)} T=${geom.T}`);
```

- [ ] **Step 2: Run — FAIL (`paintAtmosphere` missing)**

- [ ] **Step 3: Implement `paintAtmosphere`**

Port `diorama_test.html` block "Luminous Atmosphere Shell" + limb tint. Use integer pixels, blend into `ImageData` (RGBA). `cy = geom.cyBody + bob`.

```ts
export function paintAtmosphere(
  img: ImageData, geom: HabitableGeom, planetType: HabitableType, bob: number,
): void {
  const { cx, R, T } = geom;
  const cy = geom.cyBody + bob;
  const atmo = paletteFor(planetType).atmo;
  const atmoR = R + T;
  const d = img.data;
  const w = img.width, h = img.height;
  const limb = Math.max(5, Math.round(R * 0.08));
  const y0 = Math.max(0, Math.floor(cy - atmoR));
  const y1 = Math.min(h - 1, Math.ceil(cy + atmoR));
  const x0 = Math.max(0, Math.floor(cx - atmoR));
  const x1 = Math.min(w - 1, Math.ceil(cx + atmoR));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const o = (y * w + x) * 4;
      if (dist > R && dist <= atmoR) {
        const falloff = Math.pow(1 - (dist - R) / T, 1.6);
        const glow = falloff * (dx / atmoR > -0.1 ? 0.85 : 0.28);
        d[o] = atmo.r; d[o + 1] = atmo.g; d[o + 2] = atmo.b;
        d[o + 3] = Math.round(glow * 255);
      } else if (dist <= R && dist > R - limb) {
        d[o] = atmo.r; d[o + 1] = atmo.g; d[o + 2] = atmo.b;
        d[o + 3] = Math.round(0.22 * 255);
      }
    }
  }
}
```

Do **not** use `pal.atmoThickness` (0.045). That constant is dead on this path.

- [ ] **Step 4: Re-run — ring checks PASS**

If `ringMax` is ~2, you still used the old bake. Delete any call to `bakeCutawayAtmosphere` from the check.

- [ ] **Step 5: Commit**

```
git add src/rendering/HabitableCutawayEngine.ts tools/habitableDioramaCheck.ts
git commit -m "feat(diorama): thick HTML atmosphere shell with 14px floor"
```

---

### Task 5: Live glitter fluids

**Files:**
- Modify: `src/rendering/HabitableCutawayEngine.ts` — `paintFluids`
- Modify: `tools/habitableDioramaCheck.ts` (optional: occupancy-only; visual check is preview)
- Do **not** yet delete `IsoDioramaRenderer.drawHabitableOceanFluid` (Task 7)

**Interfaces:**
- Consumes: occupancy mask, `geom`, `waterSurf` palette, `elapsed`
- Produces:

```ts
export function paintFluids(
  img: ImageData, geom: HabitableGeom, occupancy: Uint8Array,
  planetType: HabitableType, elapsed: number, bob: number,
): void
```

Wave (spec):

```
wave = sin(r2 * 12 - t * 3.2) + cos(px * 0.12 + py * 0.1 + t * 1.4) * 0.4
glint if wave > 0.48; light if > 0.12; deep if < -0.55; else mid
rim foam if r2 > 0.94: +45,+45,+55 clamped
```

`t` is `elapsed` (seconds-ish). Only `occupancy[py*w+px] === 1` inside the pancake at `cyTop + bob`.

- [ ] **Step 1: Failing unit-ish check**

```ts
const fluidImg = ag.createImageData(VW, VH);
paintFluids(fluidImg, geom, occupancy, planetType, 1.0, 0);
let painted = 0;
for (let i = 0; i < occupancy.length; i++) {
  if (occupancy[i] && fluidImg.data[i * 4 + 3] > 0) painted++;
}
check('fluids paint occupancy', painted > waterPx * 0.8, `${painted}/${waterPx}`);
```

- [ ] **Step 2: Run — FAIL missing export**

- [ ] **Step 3: Implement `paintFluids`**

Write opaque RGB into `img` (alpha 255) for occupancy pixels. Skip land. Use `cutawayWaterSurf(planetType)` bands. Apply bob to the ellipse centre only (`cy = geom.cyTop + bob`).

- [ ] **Step 4: Re-run — fluids check PASS**

- [ ] **Step 5: Commit**

```
git add src/rendering/HabitableCutawayEngine.ts tools/habitableDioramaCheck.ts
git commit -m "feat(diorama): live glitter water from diorama_test waves"
```

---

### Task 6: `HabitableCutawayEngine` class — bake, frame, hitTest

**Files:**
- Modify: `src/rendering/HabitableCutawayEngine.ts` — add the class; keep free functions for the smoke tool
- Modify: `tools/habitableDioramaCheck.ts` — one integration bake through the class

**Interfaces:**
- Consumes: `habitableGeom`, `paintCutawayCrust`, `paintCutawaySurface`, `paintAtmosphere`, `paintFluids`, `makeWispSprite`
- Produces:

```ts
export interface HabitableFrameInput {
  g: CanvasRenderingContext2D;
  dt: number;
  elapsed: number;
  bg: HTMLCanvasElement;
  drawFarSpace: (g: CanvasRenderingContext2D) => void;
  drawOverlays: (g: CanvasRenderingContext2D) => void;
  drawNearMoons: (g: CanvasRenderingContext2D) => void;
  weatherMix: Array<{ kind: string; weight: number }>;
}

export class HabitableCutawayEngine {
  geom: HabitableGeom;
  occupancy: Uint8Array;
  pick: Int32Array;
  constructor();
  bake(opts: Omit<CutawayBakeOpts, 'cx'|'cyTop'|'rx'|'ry'> & { w: number; h: number }): void;
  frame(input: HabitableFrameInput): void;
  hitTest(px: number, py: number): { row: number; col: number } | null;
}
```

`bake` fills internal `crust`, `land` canvases, `occupancy`, `pick`, and rebuilds wisps when `weatherMix` signature changes (store last sig).

`frame` draw order (spec):

1. `g.drawImage(bg, 0, 0)`
2. `drawFarSpace(g)`
3. atmosphere `putImageData` (or blit a temp canvas) with current `bobOf(elapsed, R)`
4. `g.drawImage(crust, 0, bob)` — integer bob
5. `g.drawImage(land, 0, bob)`
6. `paintFluids` into a scratch ImageData then `putImageData` (already bobbed)
7. `drawOverlays(g)` — host already added bob to sprite Y via `engine.geom` + `bobOf`
8. clouds (reuse `makeWispSprite`; clip to `dist <= R+T`; wrap against atmo circle)
9. `drawNearMoons(g)`
10. vignette centred on `cyBody + bob`

`hitTest`: `id = pick[(py - round(bob)) * w + px]`; decode `row/col` as today (`id - 1`).

Pass `bob` out: `get bob() { return bobOf(this.elapsed, this.geom.R); }` set from last `frame` elapsed, default 0 after bake.

- [ ] **Step 1: Failing class check**

```ts
const engine = new HabitableCutawayEngine();
engine.bake({ ...optsWithoutOldGeom, w: VW, h: VH });
check('class bake occupancy', engine.occupancy.some(v => v === 1), 'has water');
const hit = engine.hitTest(geom.cx, geom.cyTop);
check('hitTest centre', hit !== null, JSON.stringify(hit));
```

- [ ] **Step 2: Run — FAIL class missing**

- [ ] **Step 3: Implement the class** wrapping the free functions. Store `w,h,planetType,elapsed`. Clouds: 5–8 wisps from `weatherMix` (if empty, one default cumulus). Clip each cloud pixel by atmosphere circle at `cyBody+bob`.

For overlays, the host is responsible for adding bob to Y. Document that on `geom` access:

```ts
get drawGeom() {
  return { ...this.geom, bob: bobOf(this.elapsed, this.geom.R) };
}
```

- [ ] **Step 4: Re-run — class checks PASS**

- [ ] **Step 5: Commit**

```
git add src/rendering/HabitableCutawayEngine.ts tools/habitableDioramaCheck.ts
git commit -m "feat(diorama): HabitableCutawayEngine compositor class"
```

---

### Task 7: Thin host — `IsoDioramaRenderer` habitable path

**Files:**
- Modify: `src/rendering/IsoDioramaRenderer.ts`

**Interfaces:**
- Consumes: `HabitableCutawayEngine`, `HabitableFrameInput`, `bobOf`
- Produces: habitable `frame()` / `bakeAll` / `pickTile` go through the engine. Legacy lava/ice/gas `frame` body unchanged.

- [ ] **Step 1: Add the engine field and habitable early-return in `frame`**

```ts
private cutaway = new HabitableCutawayEngine();

private frame(dt: number): void {
  if (this.habitable) {
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
  // existing legacy frame() body unchanged
}
```

- [ ] **Step 2: Habitable bake delegates**

In `bakeAll` / `bakeCrust` / `bakeSurface`, when `this.habitable`:

```ts
this.cutaway.bake({
  w: this.VW, h: this.VH,
  seed: this.planetSeed,
  grid: this.grid,
  planetType: this.planetType as HabitableType,
  discToGrid: (dx, dy) => this.discToGrid(dx, dy),
  rimFalloff: (r) => this.rimFalloff(r),
  liftOf: (e) => this.liftOf(e),
  smoothElevation: (grid, row, col) => this.smoothElevation(grid, row, col),
  maxLift: this.maxLift,
  lush: ...,
  pick: this.pickBufFor(),
});
this.pickBuf = this.cutaway.pick;
```

Remove habitable branches that call `paintCutawayCrust`, `paintCutawaySurface`, `bakeCutawayAtmosphere`, `drawHabitableOceanFluid`, habitable halo skip, habitable `drawDome` skip, habitable `buildClouds` extras.

Keep `this.cx` / `this.cy` / `this.rx` / `this.ry` **for overlay placement** by reading `this.cutaway.drawGeom` when habitable:

```ts
private get cx() { return this.habitable ? this.cutaway.drawGeom.cx : Math.round(this.VW / 2); }
private get cy() { return this.habitable ? this.cutaway.drawGeom.cyTop + this.cutaway.drawGeom.bob : ... legacy; }
private get rx() { return this.habitable ? this.cutaway.drawGeom.rx : ... }
private get ry() { return this.habitable ? this.cutaway.drawGeom.ry : ... }
```

Call `this.cutaway.bake` once from `resize`/`refreshData` before overlays `buildInhabitants` so `drawGeom` is valid.

- [ ] **Step 3: `pickTile` subtracts bob**

```ts
pickTile(clientX: number, clientY: number) {
  // ... map to px, py as today ...
  if (this.habitable) return this.cutaway.hitTest(px, py);
  // legacy pickBuf path unchanged
}
```

- [ ] **Step 4: Smoke + TypeScript**

Run habitable check (must still compile against new `CutawayBakeOpts` — if the check still calls free `paintCutaway*` directly, keep those functions).

Run the project's typecheck if present (`npx tsc --noEmit` or `npm run build`). Expected: no errors on the habitable path.

Manually: `npm run dev` → `/diorama-preview.html?type=ocean` and `?type=lava`. Lava must look like today's disc. Ocean must be pancake + fat atmo + moving water.

- [ ] **Step 5: Commit**

```
git add src/rendering/IsoDioramaRenderer.ts src/rendering/HabitableCutawayEngine.ts
git commit -m "feat(diorama): thin host, habitable frame owned by cutaway engine"
```

---

### Task 8: Preview verification + leftover deletion

**Files:**
- Modify: `tools/habitableDioramaCheck.ts` if any leftover snow-globe asserts remain
- Modify: `src/rendering/HabitableCutawayEngine.ts` — delete `bakeCutawayAtmosphere` if unused, or leave a one-line re-export that throws in smoke
- Modify: `src/rendering/IsoDioramaRenderer.ts` — delete `drawHabitableOceanFluid` if Task 7 left it
- Visual: `/diorama-preview.html?type=ocean`, `?type=rocky`, `?type=lava`

**Interfaces:** none new

- [ ] **Step 1: Delete dead habitable code**

Search `IsoDioramaRenderer.ts` for: `bakeCutawayAtmosphere`, `drawHabitableOceanFluid`, `CUTAWAY_FACE_SQUASH`, `cutawayFaceCy`, habitable halo comments. Remove unused imports.

Search `HabitableCutawayEngine.ts` for `CUTAWAY_FACE_DROP`, `CUTAWAY_BOTTOM_ROCK`, `atmoThickness: 0.045`. Remove if unreferenced.

- [ ] **Step 2: Run full smoke**

Same esbuild command. Expected: `all habitable cutaway checks passed`.

- [ ] **Step 3: Visual pass (required)**

Open `/diorama-preview.html?type=ocean`:

- You look **straight down** at a flat board (mockup A), not a 3/4 globe.
- Atmosphere is a **fat** luminous ring (HTML 16-on-64), not a hairline.
- Water glitter-moves; continents stay put.
- Crust is layered rock under a sheer wall, not a dirt/water bowl.
- 1–2px bob; clicking a cell (in-game) still hits after bob.

Then `?type=rocky` (lakes animate) and `?type=lava` (unchanged legacy).

If atmosphere looks like mockup A’s thin rim: `T` is wrong — do not "ship" Task 8.

- [ ] **Step 4: Commit**

```
git add src/rendering/HabitableCutawayEngine.ts src/rendering/IsoDioramaRenderer.ts tools/habitableDioramaCheck.ts
git commit -m "chore(diorama): drop snow-globe leftovers, verify god-view smoke"
```

---

## Self-review (plan vs spec)

| Spec section | Task |
|---|---|
| Pancake camera A, ratios, overhang | 1 |
| Thin host / overlay callbacks | 6–7 |
| Layer stack + bob blit | 6 |
| Crust sphere + sheer wall, no bowl | 3 |
| Tabletop real grid, no painted water | 2 |
| Atmosphere T floor, HTML shell | 4 |
| Faster glitter fluids | 5 |
| Clouds clipped to shell | 6 |
| Picking subtracts bob | 6–7 |
| Preview + smoke + lava unchanged | 7–8 |
| Non-goals (lava rewrite, meteors, PlanetGrid) | Global constraints |

No TBDs. Names `HabitableGeom`, `habitableGeom`, `paintAtmosphere`, `paintFluids`, `HabitableCutawayEngine.frame/hitTest/bake` are consistent across tasks.
