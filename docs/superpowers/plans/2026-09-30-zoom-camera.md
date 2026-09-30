# Zoom Camera Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zooming the home-world diorama re-renders the visible region at full resolution (crisp pixel art at every zoom), progressively: today's CSS scaling during a gesture, a sharp re-render ~150 ms after it settles.

**Architecture:** A pure `ZoomCamera` (geometry transform) and a pure `ZoomController` (gesture state machine) drive a second, camera-specific layer set in `HabitableCutawayEngine`; the identity layer set (today's) is shown during gestures. Placement is planned once in world coordinates; terrain samples elevation at fractional grid positions so edges resolve at zoom.

**Tech Stack:** TypeScript, Canvas 2D + ImageData, esbuild-bundled Node checks with a pixel-recording canvas shim.

**Spec:** `docs/superpowers/specs/2026-09-30-zoom-camera-design.md`

**How this plan differs from earlier ones:** new pure modules and every check are written out in full. The engine/renderer edits in Tasks 3-7 touch ~6,000 lines of existing drawing code; for those the plan gives exact rules, interfaces, the inventory rows (Task 1 produces them) and the checks that must pass — the implementer reads the code and applies the rules. Those tasks go to the most capable implementer model.

## Global Constraints

- Canvas stays 480 px on the long edge. Zoom range 1..4; pan limits unchanged.
- Camera: `x' = (x - fx) * zoom + VW/2`, `y' = (y - fy) * zoom + VH/2`; focus snapped so `fx * zoom` and `fy * zoom` are whole numbers. Identity = `{ zoom: 1, fx: VW/2, fy: VH/2 }`.
- Scale classes (k = rendered camera zoom): **world** x k; **sprite** x round(k) nearest-neighbour; **stroke** stays 1 px; **per-pixel** resamples; **world-anchored texture** (per-px frequencies / k, px distances x k, 1-px-line thresholds / k, hashes re-keyed on world coords); **screen** unchanged (vignette); **far** x `farScale(k) = 1 + 0.1 * (k - 1)` (backdrop, sky).
- Settle delay 150 ms after the last wheel/pointer event.
- Identity camera renders exactly today's frame, except the sub-cell elevation change (Task 3), whose differing pixels must be < 2% of each changed layer and on coast/terrace boundaries only.
- Placement (city dots, settlements, creatures, decals, volcano chimneys, divine effects) planned once per planet bake at the identity camera, stored in base-world coordinates, never re-planned on a camera change.
- `setCamera` keeps the weather sim, `elapsed`, day angle, orbit clock, selections; `bake()` (new planet) resets the camera to identity and makes a fresh sim; resize keeps the sim and the camera.
- Every bake and per-frame loop iterates at most canvas area plus the relief margin (`y` up to `VH - 1 + maxLift * k`).
- Checks: `node_modules/.bin/esbuild tools/<name>.ts --bundle --platform=node --format=esm --outfile="$TEMP/<name>.mjs" --log-level=error && node --expose-gc "$TEMP/<name>.mjs"`.
- `node_modules/.bin/tsc --noEmit -p . 2>&1 | grep -c "error TS"` stays at **2**. Known reds unchanged: smokeTest 49/3; surfaceDecalCheck clump 64%.
- Every check has a control that must FAIL, and runs the real code on a broken input — never a hardcoded literal.
- A threshold that fails a legitimate result is a finding to report, not a number to loosen.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `.env`. Scratch in `$TEMP`.

## Review Focus

1. **Zooming fully back out after a settle at 4x** — must return to the identity layers with no leftover camera state. Test: Task 2 controller test "zoom back to 1".
2. **Clicking a tile right after a settle at 4x** — must select the tile under the cursor. Test: Task 7 check "click after settle maps through the camera".
3. **Resizing the window while zoomed** — camera kept (focus re-clamped), weather kept. Test: Task 7 check "resize keeps camera and sim".
4. **Changing planet while zoomed** — camera resets to identity, fresh sim. Test: Task 7 check "new planet resets the camera".
5. **Casting a divine effect while zoomed** — the effect lands where clicked and stays on that spot after zooming. Test: Task 6 check "effect stays on its world spot".

---

### Task 1: Reference fingerprints and the inventory (no source changes)

**Files:**
- Create: `tools/zoomHarness.ts`, `tools/zoomGoldens.ts`, `tools/zoomGoldens.json`
- Create: `docs/superpowers/specs/2026-09-30-zoom-camera-inventory.md`

**Interfaces:**
- Produces: `tools/zoomHarness.ts` exporting `PixelCanvas` (a canvas shim whose 2D context records `fillRect`, `putImageData`, `drawImage` of other `PixelCanvas`es, and `getImageData` into a real RGBA buffer), `installDom()`, `hashImage(data: Uint8ClampedArray): string` (FNV-1a hex), `renderLayers(type: string, seed: number): Record<string, Uint8ClampedArray>` (layer name -> RGBA of the identity render); `tools/zoomGoldens.json` = `{ [type]: { [layer]: hash } }` for `ocean`, `lava`, `gas`.

- [ ] **Step 1: Write the harness**

Create `tools/zoomHarness.ts`:

```ts
/**
 * Headless pixel harness for the zoom camera checks. A minimal canvas shim that
 * RECORDS colours (habitableDioramaCheck's shim records coverage only), so layer
 * images can be hashed and measured.
 */
export class PixelCtx {
  fillStyle: unknown = '#000'; strokeStyle: unknown = '#000'; lineWidth = 1;
  globalAlpha = 1; globalCompositeOperation = 'source-over'; imageSmoothingEnabled = false;
  pathOps = 0;
  constructor(readonly canvas: PixelCanvas) {}
  private parse(c: unknown): [number, number, number, number] {
    if (typeof c !== 'string') return [0, 0, 0, 0];
    let m = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)$/);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    m = c.match(/^#([0-9a-f]{6})$/i);
    if (m) { const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255, 1]; }
    return [0, 0, 0, 0];
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    const [r, g, b, a0] = this.parse(this.fillStyle);
    const a = a0 * this.globalAlpha, W = this.canvas.width, H = this.canvas.height, d = this.canvas.data;
    for (let yy = Math.max(0, Math.round(y)); yy < Math.min(H, Math.round(y + h)); yy++)
      for (let xx = Math.max(0, Math.round(x)); xx < Math.min(W, Math.round(x + w)); xx++) {
        const o = (yy * W + xx) * 4, da = d[o + 3] / 255, oa = a + da * (1 - a);
        if (oa <= 0) continue;
        d[o] = (r * a + d[o] * da * (1 - a)) / oa; d[o + 1] = (g * a + d[o + 1] * da * (1 - a)) / oa;
        d[o + 2] = (b * a + d[o + 2] * da * (1 - a)) / oa; d[o + 3] = oa * 255;
      }
  }
  clearRect(): void { this.canvas.data.fill(0); }
  createImageData(w: number, h: number) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
  getImageData(x = 0, y = 0, w = this.canvas.width, h = this.canvas.height) {
    const out = this.createImageData(w, h), W = this.canvas.width;
    for (let yy = 0; yy < h; yy++) out.data.set(this.canvas.data.subarray(((y + yy) * W + x) * 4, ((y + yy) * W + x + w) * 4), yy * w * 4);
    return out;
  }
  putImageData(img: { width: number; height: number; data: Uint8ClampedArray }, dx: number, dy: number): void {
    const W = this.canvas.width, H = this.canvas.height;
    for (let y = 0; y < img.height; y++) {
      const ty = dy + y; if (ty < 0 || ty >= H) continue;
      for (let x = 0; x < img.width; x++) {
        const tx = dx + x; if (tx < 0 || tx >= W) continue;
        const s = (y * img.width + x) * 4, t = (ty * W + tx) * 4;
        for (let c = 0; c < 4; c++) this.canvas.data[t + c] = img.data[s + c];
      }
    }
  }
  drawImage(src: unknown, dx = 0, dy = 0): void {
    if (!(src instanceof PixelCanvas)) return;
    const img = { width: src.width, height: src.height, data: src.data };
    // Source-over composite of a same-size or smaller canvas.
    const W = this.canvas.width, H = this.canvas.height, d = this.canvas.data;
    for (let y = 0; y < img.height; y++) {
      const ty = Math.round(dy) + y; if (ty < 0 || ty >= H) continue;
      for (let x = 0; x < img.width; x++) {
        const tx = Math.round(dx) + x; if (tx < 0 || tx >= W) continue;
        const s = (y * img.width + x) * 4, o = (ty * W + tx) * 4, a = img.data[s + 3] / 255;
        if (a <= 0) continue;
        const da = d[o + 3] / 255, oa = a + da * (1 - a);
        for (let c = 0; c < 3; c++) d[o + c] = (img.data[s + c] * a + d[o + c] * da * (1 - a)) / oa;
        d[o + 3] = oa * 255;
      }
    }
  }
  save(): void {} restore(): void {} clip(): void {} beginPath(): void {} closePath(): void {}
  moveTo(): void {} lineTo(): void {} arc(): void {} ellipse(): void {} rect(): void {}
  fill(): void { this.pathOps++; } stroke(): void { this.pathOps++; }
  translate(): void {} scale(): void {} rotate(): void {} setTransform(): void {}
  createLinearGradient() { return { addColorStop() {} }; }
  createRadialGradient() { return { addColorStop() {} }; }
}

export class PixelCanvas {
  data: Uint8ClampedArray; style: Record<string, string> = {};
  private ctx: PixelCtx | null = null;
  constructor(private w = 1, private h = 1) { this.data = new Uint8ClampedArray(w * h * 4); }
  get width() { return this.w; } set width(v: number) { this.w = v; this.data = new Uint8ClampedArray(this.w * this.h * 4); }
  get height() { return this.h; } set height(v: number) { this.h = v; this.data = new Uint8ClampedArray(this.w * this.h * 4); }
  getContext(): PixelCtx { return (this.ctx ??= new PixelCtx(this)); }
}

export function installDom(): void {
  (globalThis as any).document = { createElement: () => new PixelCanvas() };
  (globalThis as any).ImageData = class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} };
}

export function hashImage(d: Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
```

Append `renderLayers(type, seed)` to the same file. It must reproduce, headlessly and deterministically, the identity render of each layer as the game draws it at 480x320, using the REAL engine and painters (import them dynamically after `installDom()`): build the grid with `generatePlanetGrid(type, seed * 7777, null, null)`; a projection + `rimFalloff` + `liftOf` + `smoothElevation` copied from `IsoDioramaRenderer` (same formulas as `tools/habitableDioramaCheck.ts` uses, but `liftOf` returning the habitable tiers 3/6/9/13/18 and `maxLift` 18); bake a `HabitableCutawayEngine` with `weather: buildClimate(...)` (skip for `gas`), then call `frame()` once with `elapsed = 10`, `dt = 1/60`, `sunAzimuth = 0.6`, `viewZoom = 1`, no-op overlays and a no-op backdrop, and return these layers (read them from the engine's private canvases/images via `(engine as any)`): `crust`, `land`, `fluids` (the fluid ImageData after `paintFluids`, before day/night — call `paintFluids` directly into a fresh image with the engine's geom/occupancy/shoreDist), `dayNight` (call `paintDayNight` into a fresh image), `atmosphere` (the atmo ImageData after the frame), `weather` (the weather ImageData after the frame; empty for gas), `sky` (call `paintSky` into a fresh image with `skyLayout(geom, 480, 320)` and `orbitSky({ animTick: 1000, home, planets: [home, sibling], dayAngle: 0.6 })` for a fixed home `P(40, 0.3)` and sibling `P(70, 1.2)`), `backdrop` (call `bakeBackdrop` into a 1440x320 image, seed 7). Document in a comment at the top which engine internals it reads.

- [ ] **Step 2: Capture the goldens on the pre-change code**

Create `tools/zoomGoldens.ts` that calls `installDom()`, then for `ocean`, `lava`, `gas` (seed 7) calls `renderLayers` and writes `{ [type]: { [layer]: hashImage(data) } }` to `tools/zoomGoldens.json`, also printing it. Run it twice; the two outputs must be identical (determinism). Commit nothing in `src/`.

- [ ] **Step 3: Write the inventory**

Create `docs/superpowers/specs/2026-09-30-zoom-camera-inventory.md`: one table per file (`HabitableCutawayEngine.ts`, `IsoDioramaRenderer.ts` habitable path only, `SurfaceDecals.ts`, `weather/WeatherPainter.ts`, `sky/SkyPainter.ts`, `sky/Backdrop.ts`), a row for every fixed-pixel constant, per-px frequency, px-keyed hash, and geometry computation that bypasses `HabitableGeom`, with columns `line | symbol | current value | class | conversion | owning task`. Classes and conversions exactly as in the Global Constraints. Owning task: 3 (sub-cell elevation), 4 (crust/surface/shore/pick), 5 (fluids/day-night/atmosphere/weather/vignette/gas rings), 6 (placement/sky/moons/markers/effects). Include every item the spec names in section 2 and its review list; the legacy Canvas path (`usesCutaway` is always true) is out of scope — list it as one "out of scope" row.

- [ ] **Step 4: Commit**

```bash
git add tools/zoomHarness.ts tools/zoomGoldens.ts tools/zoomGoldens.json docs/superpowers/specs/2026-09-30-zoom-camera-inventory.md
git commit -m "test(zoom): headless pixel harness, identity goldens from the pre-change render, constant inventory

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Camera and gesture controller (pure)

**Files:**
- Create: `src/rendering/ZoomCamera.ts`, `src/rendering/ZoomController.ts`, `tools/zoomCheck.ts`

**Interfaces:**
- Produces: `Camera`, `identityCamera(VW, VH)`, `isIdentity(cam, VW, VH)`, `applyCamera(base, cam, VW, VH)`, `worldToScreen(cam, VW, VH, x, y)`, `screenToWorld(cam, VW, VH, x, y)`, `cameraFromView(zoom, panX, panY, rect, VW, VH)`, `farScale(zoom)`, `SETTLE_MS = 150`; `ZoomController` with `wheel(mx, my, deltaY, t)`, `panStart(x, y, t)`, `panMove(x, y, t)`, `panEnd(t)`, `tick(t): Camera | null` (returns a camera to re-bake when a settle is due, once), `settled(cam)`, `resize(rect, VW, VH)`, `reset()`, getters `viewZoom`, `panX`, `panY`, `showCamera: boolean`, `rendered: Camera`, `cssTransform(): string`.

- [ ] **Step 1: Write the checks**

Create `tools/zoomCheck.ts`:

```ts
/**
 * Does zooming re-render crisp pixel art? Every claim against an independent
 * fixture or rendered pixels, each with a control that must FAIL.
 * Build + run: node_modules/.bin/esbuild tools/zoomCheck.ts --bundle --platform=node --format=esm --outfile="$TEMP/zoom.mjs" --log-level=error && node --expose-gc "$TEMP/zoom.mjs"
 */
const { identityCamera, isIdentity, applyCamera, worldToScreen, screenToWorld, cameraFromView, farScale } =
  await import('../src/rendering/ZoomCamera');
const { ZoomController, SETTLE_MS } = await import('../src/rendering/ZoomController');

let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} ${detail}`);
  if (!ok) failed++;
}
const VW = 480, VH = 320;
const base = { cx: 240, cyTop: 150, cyBody: 180, R: 120, rx: 120, ry: 40, wall: 30, T: 12 };

console.log('\n  CAMERA');
{
  const id = identityCamera(VW, VH);
  const g1 = applyCamera(base as any, id, VW, VH);
  check('identity camera returns the base geometry', JSON.stringify(g1) === JSON.stringify(base), JSON.stringify(g1));
  const off = applyCamera(base as any, { zoom: 1.001, fx: VW / 2, fy: VH / 2 }, VW, VH);
  check('  control: zoom 1.001 is not identity', JSON.stringify(off) !== JSON.stringify(base) && !isIdentity({ zoom: 1.001, fx: 240, fy: 160 }, VW, VH), '');
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const cam = { zoom: 1 + Math.random() * 3, fx: Math.random() * VW, fy: Math.random() * VH };
    const x = Math.random() * VW, y = Math.random() * VH, s = worldToScreen(cam, VW, VH, x, y), w = screenToWorld(cam, VW, VH, s.x, s.y);
    worst = Math.max(worst, Math.hypot(w.x - x, w.y - y));
  }
  check('world <-> screen round-trips', worst < 1e-9, `worst ${worst.toExponential(1)}`);
  const cam = { zoom: 4, fx: 200, fy: 150 }, g4 = applyCamera(base as any, cam, VW, VH);
  const cxs = worldToScreen(cam, VW, VH, base.cx, base.cyTop);
  check('applyCamera scales lengths and maps centres', g4.rx === 480 && g4.ry === 160 && g4.wall === 120 && g4.T === 48 && g4.R === 480 && g4.cx === cxs.x && g4.cyTop === cxs.y,
    JSON.stringify(g4));
  check('farScale is mild', farScale(1) === 1 && Math.abs(farScale(4) - 1.3) < 1e-12, `${farScale(4)}`);
  // cameraFromView: the view centre on screen shows the camera focus.
  const rect = { width: 1175, height: 783 };
  const cv = cameraFromView(3, 120, -60, rect, VW, VH);
  const cssPerV = rect.width / VW;
  const centreWorldX = VW / 2 + (-120 / 3) / cssPerV, centreWorldY = VH / 2 + (60 / 3) / (rect.height / VH);
  check('cameraFromView puts the screen centre at the focus', Math.abs(cv.fx - centreWorldX) <= 0.5 / 3 && Math.abs(cv.fy - centreWorldY) <= 0.5 / 3 && cv.zoom === 3,
    `focus ${cv.fx.toFixed(2)},${cv.fy.toFixed(2)} vs ${centreWorldX.toFixed(2)},${centreWorldY.toFixed(2)}`);
  check('focus is snapped to whole screen pixels', Number.isInteger(Math.round(cv.fx * 3 * 1e9) / 1e9) && Number.isInteger(Math.round(cv.fy * 3 * 1e9) / 1e9), '');
}

console.log('\n  CONTROLLER');
{
  const rect = { width: 1175, height: 783 };
  const c = new ZoomController(rect, VW, VH);
  let t = 0;
  c.wheel(100, 50, -1, t);                       // zoom in at a point
  const mid = c.showCamera;
  let rebakes = 0;
  for (t = 10; t < SETTLE_MS - 10; t += 16) { if (c.tick(t)) rebakes++; }
  check('no re-bake during a gesture', rebakes === 0 && mid === false && c.cssTransform() !== 'none', c.cssTransform());
  let cam = null as any;
  for (; t < SETTLE_MS + 100; t += 16) { const r = c.tick(t); if (r) { rebakes++; cam = r; } }
  c.settled(cam);
  check('exactly one re-bake after the settle delay', rebakes === 1 && c.showCamera && c.cssTransform() === 'none', `${rebakes} re-bakes, css ${c.cssTransform()}`);
  // No jump across the settle: the world point shown at a screen pixel by the
  // CSS-scaled identity view (before) and by the camera render (after) agree.
  // CSS: display scaled by viewZoom about its centre, translated by pan (CSS px).
  let worstJump = 0;
  for (const p of [{ x: 30, y: 20 }, { x: 240, y: 160 }, { x: 450, y: 300 }, { x: 300, y: 200 }]) {
    const panVX = c.panX * (VW / rect.width), panVY = c.panY * (VH / rect.height);
    const cssWorld = { x: VW / 2 + (p.x - VW / 2 - panVX) / c.viewZoom, y: VH / 2 + (p.y - VH / 2 - panVY) / c.viewZoom };
    const camScreen = worldToScreen(cam, VW, VH, cssWorld.x, cssWorld.y);
    worstJump = Math.max(worstJump, Math.hypot(camScreen.x - p.x, camScreen.y - p.y));
  }
  check('no jump at settle (<= 0.5 virtual px)', worstJump <= 0.5, `worst ${worstJump.toFixed(3)} px`);
  // Review focus 1: zoom back to 1.
  for (let i = 0; i < 30; i++) c.wheel(0, 0, +1, t += 5);
  let r2 = null; for (let k = 0; k < 20; k++) { const r = c.tick(t += 16); if (r) r2 = r; }
  check('zoom back to 1 returns to identity layers', c.viewZoom === 1 && !c.showCamera && r2 === null && c.cssTransform() === 'none' && isIdentity(c.rendered, VW, VH),
    `zoom ${c.viewZoom}, showCamera ${c.showCamera}`);
  // Control: a controller that ignores the settle delay re-bakes mid-gesture,
  // failing the "no re-bake during a gesture" bar under the same input stream.
  class Eager extends ZoomController { tick(t: number) { return super.tick(t + SETTLE_MS); } }
  const n = new Eager(rect, VW, VH); let naive = 0;
  n.wheel(100, 50, -1, 0);
  for (let tt = 10; tt < SETTLE_MS - 10; tt += 16) { if (n.tick(tt)) naive++; }
  check('  control: no settle delay re-bakes mid-gesture', naive > 0, `${naive} re-bakes`);
}

console.log(failed === 0 ? '\n  all zoom checks passed\n' : `\n  ${failed} zoom check(s) FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run — must fail to build** (`Could not resolve "../src/rendering/ZoomCamera"`).

- [ ] **Step 3: Create `src/rendering/ZoomCamera.ts`**

```ts
/**
 * The zoom camera: which part of the diorama the canvas shows, and at what
 * scale. Pure. Positions are in BASE virtual pixels (the identity render's
 * coordinates); the canvas size never changes, so at zoom z it shows 1/z of the
 * scene at z times the detail. See docs/superpowers/specs/2026-09-30-zoom-camera-design.md.
 */
import type { HabitableGeom } from './HabitableCutawayEngine';

export interface Camera { zoom: number; fx: number; fy: number }

export const FAR_PARALLAX = 0.1;

export function identityCamera(VW: number, VH: number): Camera {
  return { zoom: 1, fx: VW / 2, fy: VH / 2 };
}

export function isIdentity(cam: Camera, VW: number, VH: number): boolean {
  return cam.zoom === 1 && cam.fx === VW / 2 && cam.fy === VH / 2;
}

export function worldToScreen(cam: Camera, VW: number, VH: number, x: number, y: number): { x: number; y: number } {
  return { x: (x - cam.fx) * cam.zoom + VW / 2, y: (y - cam.fy) * cam.zoom + VH / 2 };
}

export function screenToWorld(cam: Camera, VW: number, VH: number, x: number, y: number): { x: number; y: number } {
  return { x: (x - VW / 2) / cam.zoom + cam.fx, y: (y - VH / 2) / cam.zoom + cam.fy };
}

/** Geometry as seen through the camera: lengths x zoom, centres mapped. Identity returns `base` unchanged. */
export function applyCamera(base: HabitableGeom, cam: Camera, VW: number, VH: number): HabitableGeom {
  if (isIdentity(cam, VW, VH)) return base;
  const z = cam.zoom;
  const c = worldToScreen(cam, VW, VH, base.cx, base.cyTop);
  const b = worldToScreen(cam, VW, VH, base.cx, base.cyBody);
  return { ...base, cx: c.x, cyTop: c.y, cyBody: b.y, R: base.R * z, rx: base.rx * z, ry: base.ry * z, wall: base.wall * z, T: base.T * z };
}

/**
 * Today's CSS view state -> camera. The display is scaled about its centre by
 * `zoom` and translated by `pan` (CSS px), so the screen centre shows the virtual
 * point VW/2 - pan/zoom (in virtual px). Snapped so centres land on whole pixels.
 */
export function cameraFromView(
  zoom: number, panX: number, panY: number,
  rect: { width: number; height: number }, VW: number, VH: number,
): Camera {
  const fx = VW / 2 - (panX / zoom) * (VW / rect.width);
  const fy = VH / 2 - (panY / zoom) * (VH / rect.height);
  return { zoom, fx: Math.round(fx * zoom) / zoom, fy: Math.round(fy * zoom) / zoom };
}

/** Far layers (backdrop, sky) scale by this, not by the zoom: a mild parallax. */
export function farScale(zoom: number): number {
  return 1 + FAR_PARALLAX * (zoom - 1);
}
```

(`HabitableGeom` is `cx, cyBody, cyTop, R, rx, ry, wall, T`. If the type import would create a cycle at runtime it is erased; keep it `import type`.)

- [ ] **Step 4: Create `src/rendering/ZoomController.ts`**

```ts
/**
 * Progressive zoom as a pure state machine. During a gesture the display shows
 * the identity layers under today's CSS transform (instant, no blank areas);
 * SETTLE_MS after the last input it asks once for a camera re-bake, and once the
 * host reports it done, the display shows the camera layers with no CSS transform.
 */
import { cameraFromView, identityCamera, type Camera } from './ZoomCamera';

export const SETTLE_MS = 150;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

export class ZoomController {
  private zoom = 1; private px = 0; private py = 0;
  private lastInput = -Infinity; private panning = false; private pending = false;
  private panOrigin = { x: 0, y: 0, px: 0, py: 0 };
  private cam: Camera; private camShown = false;

  constructor(private rect: { width: number; height: number }, private VW: number, private VH: number) {
    this.cam = identityCamera(VW, VH);
  }

  get viewZoom(): number { return this.zoom; }
  get panX(): number { return this.px; }
  get panY(): number { return this.py; }
  get showCamera(): boolean { return this.camShown; }
  get rendered(): Camera { return this.cam; }

  /** CSS transform for the display canvas right now. */
  cssTransform(): string {
    if (this.camShown || (this.zoom === 1 && this.px === 0 && this.py === 0)) return 'none';
    return `translate(${this.px}px, ${this.py}px) scale(${this.zoom})`;
  }

  private beginInput(t: number): void {
    this.lastInput = t;
    this.pending = true;
    this.camShown = false;      // back to the identity layers + CSS while gesturing
  }

  private clamp(): void {
    if (this.zoom <= MIN_ZOOM + 0.001) { this.zoom = MIN_ZOOM; this.px = 0; this.py = 0; return; }
    const mx = (this.zoom - 1) * this.rect.width * 0.5, my = (this.zoom - 1) * this.rect.height * 0.5;
    this.px = Math.max(-mx, Math.min(mx, this.px));
    this.py = Math.max(-my, Math.min(my, this.py));
  }

  /** mx, my: cursor relative to the mount centre, CSS px. deltaY > 0 zooms out. */
  wheel(mx: number, my: number, deltaY: number, t: number): void {
    const prev = this.zoom;
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev * (deltaY > 0 ? 0.86 : 1.16)));
    if (next === prev) return;
    this.beginInput(t);
    const wx = (mx - this.px) / prev, wy = (my - this.py) / prev;
    this.zoom = next; this.px = mx - wx * next; this.py = my - wy * next;
    this.clamp();
  }

  panStart(x: number, y: number, t: number): void {
    this.panning = true; this.panOrigin = { x, y, px: this.px, py: this.py }; this.beginInput(t);
  }

  panMove(x: number, y: number, t: number): void {
    if (!this.panning) return;
    this.beginInput(t);
    this.px = this.panOrigin.px + (x - this.panOrigin.x);
    this.py = this.panOrigin.py + (y - this.panOrigin.y);
    this.clamp();
  }

  panEnd(t: number): void { if (this.panning) { this.panning = false; this.lastInput = t; } }

  /** Once per frame. Returns a camera to re-bake when a settle is due (at most once per settle). */
  tick(t: number): Camera | null {
    if (!this.pending || this.panning || t - this.lastInput < SETTLE_MS) return null;
    this.pending = false;
    const target = cameraFromView(this.zoom, this.px, this.py, this.rect, this.VW, this.VH);
    if (this.zoom === 1) { this.cam = identityCamera(this.VW, this.VH); this.camShown = false; return null; }
    return target;
  }

  /** The host finished re-baking for `cam`: show the camera layers, CSS identity. */
  settled(cam: Camera): void { this.cam = cam; this.camShown = true; }

  resize(rect: { width: number; height: number }, VW: number, VH: number): void {
    this.rect = rect; this.VW = VW; this.VH = VH; this.clamp();
    if (this.zoom !== 1) { this.pending = true; this.lastInput = -Infinity; this.camShown = false; }
    else this.cam = identityCamera(VW, VH);
  }

  /** New planet: back to identity. */
  reset(): void {
    this.zoom = 1; this.px = 0; this.py = 0; this.pending = false; this.panning = false;
    this.cam = identityCamera(this.VW, this.VH); this.camShown = false;
  }
}
```

- [ ] **Step 5: Run — all pass, controls fail; tsc 2; commit**

```bash
git add src/rendering/ZoomCamera.ts src/rendering/ZoomController.ts tools/zoomCheck.ts
git commit -m "feat(zoom): pure camera transform and progressive gesture controller

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Sub-cell elevation

**Files:**
- Modify: `src/rendering/IsoDioramaRenderer.ts` (add `discToGridF`, `elevationAt`; pass `elevationAt` in the bake options)
- Modify: `src/rendering/HabitableCutawayEngine.ts` (`CutawayBakeOpts.elevationAt?`; `paintCutawaySurface` land/water test and lift use it when present; the weather lookup's ground lift uses it)
- Modify: `tools/zoomHarness.ts` (pass the same `elevationAt`), `tools/zoomCheck.ts`

**Interfaces:**
- Produces: `CutawayBakeOpts.elevationAt?: (dx: number, dy: number) => number | null` — the smoothed elevation (same weights as `smoothElevation`) interpolated bilinearly at the pixel's FRACTIONAL grid position, minus nothing (the caller subtracts `rimFalloff(r)` as today). Biome colour and every placement keep using the nearest cell (`discToGrid`); picking keeps `discToGrid`.

- [ ] **Step 1: Write the check** — add to `tools/zoomCheck.ts` an IDENTITY block: install the harness DOM, import `renderLayers`, `hashImage` and `tools/zoomGoldens.json`; for each type and layer compare the hash to the golden. Layers `land`, `crust` (it reads occupancy) and `fluids`/`dayNight`/`weather` (they read occupancy/ground lift) may differ, but only by < 2% of the layer's non-empty pixels, and every differing pixel must lie within 2 px of a pixel where the zoom-1 nearest-cell land/water classification changes between horizontal or vertical neighbours (a coast or terrace boundary; compute that boundary mask from the golden-path render by re-running `renderLayers` with `elevationAt` disabled). All other layers must hash identical. Control: the same comparison against a render with `rimFalloff` perturbed by 0.02 must exceed 2% or leave the boundary band.
- [ ] **Step 2: Run** — before implementing, every layer hashes identical (the check passes trivially on unchanged code; record that).
- [ ] **Step 3: Implement** `discToGridF` (same projection as `discToGrid`, returning fractional `row = v * (GRID_SIZE - 1)`, `col = u * GRID_SIZE` without rounding) and `elevationAt(dx, dy)`: bilinear over the 4 cells around (row, col) of `smoothElevation` (columns wrap, rows clamp). In `paintCutawaySurface` use `opts.elevationAt(dx, dy) ?? nearest` for the elevation that decides water vs land and for `liftOf(... - rimFalloff(r))`; keep `cell.biome`/moisture/decals from the nearest cell. Use it in the weather lookup's `groundLift` too. Zoom-1 performance: cache nothing new per frame; `elevationAt` is only called in bakes.
- [ ] **Step 4: Run** — identity block passes (changed layers within 2%, on boundaries), control fails; `habitableDioramaCheck`, `atmosphereCheck`, `surfaceDecalCheck` (64% baseline), `weatherCheck --quick` exit 0 (or unchanged baseline); tsc 2.
- [ ] **Step 5: Commit** — `feat(zoom): sample elevation between grid cells so edges resolve at zoom` + measured differing-pixel shares per type.

---

### Task 4: Engine camera layers — crust, surface, shore, pick, bounded bakes

**Files:**
- Modify: `src/rendering/HabitableCutawayEngine.ts` (class + `paintCutawayCrust`, `paintCutawaySurface`, `bakeShoreDistance`, `planVolcanoChimneys`/`paintVolcanoChimneys` bounds, `rebakeSurface`)
- Modify: `tools/zoomHarness.ts` (`renderLayers(type, seed, cam?)`), `tools/zoomCheck.ts`

**Interfaces:**
- Consumes: `Camera`, `applyCamera`, `worldToScreen`, `screenToWorld`, `identityCamera`, `isIdentity` (Task 2); `elevationAt` (Task 3); the inventory rows owned by Task 4.
- Produces: `HabitableCutawayEngine.setCamera(cam: Camera): void`; `engine.showCamera: boolean` (set by the host; selects which layer set the frame draws and which geometry `drawGeom`/`hitTest` expose); `engine.camera: Camera`; `CutawayBakeOpts.cameraZoom?: number` (k; defaults 1) read by the painters for world-scaled constants; the bake options' `liftOf` is wrapped so returned lifts are multiplied by k and `maxLift` by k.

- [ ] **Step 1: Write the checks** (zoomCheck, CAMERA LAYERS block), using `renderLayers(type, 7, cam)`:
  - **relief scales:** for the tallest peak pixel column on `ocean` (found at zoom 1), its rendered lift (rows between terrain top and the face) at a camera `{ zoom: 4, fx, fy }` centred on it is 4x the zoom-1 lift +/- 1 px. Control: with the lift wrapper disabled (k not applied) it fails.
  - **crust depth scales** by 4 +/- 1 px at the same camera.
  - **world-anchored hashes:** sample 50 world points inside the face; the surface and crust colours at those points (via `worldToScreen`) under two cameras with the same zoom 2 and different focus are identical. Control: px-keyed grain (the pre-change keying) differs.
  - **pick agrees:** 200 world points: `engine.hitTest` under zoom 2 and 4 (random focus) returns the same cell as zoom 1, ignoring points within 1 px (zoom 1) of a cell boundary.
  - **bounded bakes:** instrument (via a counter the harness reads, e.g. `(globalThis as any).__zoomIters`) the surface, crust and shore loops: iterations at zoom 4 <= (VW * (VH + maxLift*4)) and <= 1.5x zoom 1. Control: an unclamped surface loop at zoom 4 (bounding box of the full geometry) exceeds it.
  - **state kept:** `setCamera` leaves `engine.weatherSim` (same object, same `cloud` array contents) and `elapsed` untouched; `bake()` replaces the sim (control).
- [ ] **Step 2: Run — must fail** (`setCamera` does not exist).
- [ ] **Step 3: Implement.** Keep today's canvases as the identity set; add a camera set (crust, land, occupancy, shoreDist, pick, surfaceBakeOpts, weather painter). `setCamera(cam)`: if identity, drop the camera set; else build the camera geometry `applyCamera(this.geom, cam, w, h)`, copy the stored bake options with that geometry and `cameraZoom: cam.zoom`, then in order: zero occupancy, crust, surface, shore distance (with a margin of `FOAM_REACH * k` px beyond the canvas — bake the BFS on the enlarged region and crop), pick; stamp the STORED decals/chimneys (Task 6 stores them; until then they are re-stamped from the identity plan mapped through the camera — do NOT re-plan). Apply every Task-4 inventory row (world x k, texture frequencies / k, hashes on world coords via `screenToWorld` floored at base resolution). Clamp every loop to the canvas plus the relief margin; replace the O(lift) cliff fill with a per-column near-to-far pass that writes each pixel once. `rebakeSurface()` repaints both sets from their own stored options. `bake()` resets `camera` to identity and drops the camera set. `drawGeom`, `hitTest`, `occupancy`, `shoreDist`, `pick` expose the ACTIVE set (`showCamera`). Identity rendering must stay byte-identical (the Task 3 identity block keeps passing).
- [ ] **Step 4: Run** — CAMERA LAYERS and IDENTITY blocks pass, controls fail; `habitableDioramaCheck`, `surfaceDecalCheck` (baseline), `atmosphereCheck`, `skyCheck`, `weatherCheck --quick` exit 0; tsc 2.
- [ ] **Step 5: Commit** — `feat(zoom): camera layer set for crust, surface, shore and pick — world-scaled, bounded to the view` + the relief/crust ratios and iteration counts.

---

### Task 5: Per-frame layers under the camera — water, day/night, atmosphere, weather, vignette, gas rings

**Files:**
- Modify: `src/rendering/HabitableCutawayEngine.ts` (`paintFluids` + water constants, `paintDayNight`, `paintAtmosphere`, `frame()`, vignette, `drawGasRings`), `src/rendering/weather/WeatherPainter.ts` (`buildWeatherLut` clamp; painter constructed per layer set with `cloudLift * k`), `tools/zoomCheck.ts`

**Interfaces:**
- Consumes: Task 4's `showCamera`, `camera`, camera set, `cameraZoom`.
- Produces: `frame()` draws the active set; `atmoHazeAmount(activeZoom)` where activeZoom is `camera.zoom` when `showCamera` else the frame input `viewZoom` (identity layers during a gesture are CSS-scaled, so haze follows the CSS zoom exactly as today).

- [ ] **Step 1: Write the checks** (zoomCheck, FRAME LAYERS block):
  - **crisp, not magnified:** at zoom 4 (atmosphere intensity forced to 1 via a test hook), along the limb, the day/night terminator and the coastline — traced as the pixels where alpha (limb/terminator) or land/water (coast) changes between neighbours, restricted to pixels non-empty at zoom 1 — the mean straight run length is <= 2 px. Control: the zoom-1 render magnified 4x nearest-neighbour has runs >= 4 px.
  - **world-anchored water:** the swell wavelength measured in world units along a shore normal is equal at zoom 1 and 4 (+/- 10%). Control: unconverted `SWELL_K` gives ~4x shorter.
  - **strokes stay 1 px:** water glint lines are 1 px wide at zoom 4; a rain streak is 3 px long at zoom 4 (from the painter's particle drawing).
  - **cloud lift scales:** the weather painter's cloud layer sits `(maxLift + 6) * 4` px above the ground at zoom 4.
  - **bounded:** weather lookup entries at zoom 4 <= canvas area. Control: an unclamped lookup has ~16x.
  - **vignette is screen-space:** the vignette alpha at the canvas centre is 0 at zoom 1, 2, 3, 4. Control: a vignette whose inner radius is `rx * 0.7` from the camera geometry darkens the centre at zoom >= 2.1.
- [ ] **Step 2: Run — must fail.**
- [ ] **Step 3: Implement** the Task-5 inventory rows (fluid and atmosphere constants, `chan.thicknessPx * k` with the unscaled wobble seed, glint/halo thresholds / k, weather lookup clamp + new painter per set with cloud lift x k, rain speeds x k with streak length unchanged, vignette in canvas coordinates, gas rings drawn per base-space ring). Identity rendering byte-identical except Task 3's declared change.
- [ ] **Step 4: Run** — FRAME LAYERS, IDENTITY and CAMERA LAYERS pass; `weatherCheck --quick` (including allocation), `atmosphereCheck`, `habitableDioramaCheck`, `skyCheck` exit 0; tsc 2.
- [ ] **Step 5: Commit** — `feat(zoom): water, day/night, atmosphere, weather under the camera — crisp strokes, world-anchored texture` + run lengths and wavelength ratios.

---

### Task 6: Stable placement, far layers, moons, markers, effects

**Files:**
- Modify: `src/rendering/IsoDioramaRenderer.ts` (`buildCityDots`, `buildInhabitants`, divine effects, `drawMoons`, `drawTileMarkers`, `drawSky`, `drawBackdropPanorama`, `bakeBackground`), `src/rendering/HabitableCutawayEngine.ts` (store planned decals/chimneys in world coords), `src/rendering/SurfaceDecals.ts` (plan at identity, stamp through a camera), `src/rendering/sky/SkyPainter.ts` (a far transform), `src/rendering/sky/Backdrop.ts` (bake at a far scale), `tools/zoomCheck.ts`

**Interfaces:**
- Consumes: `worldToScreen`, `farScale`, the active camera.
- Produces: placement records carry `wx, wy` (base-world px) and `row, col`; `skyLayout` unchanged, plus `farLayout(L: SkyLayout, cam: Camera, VW, VH): SkyLayout` (scales `A, B, bloom` by `farScale` and maps `cx, horizonY` through the far transform about the focus); `bakeBackdrop` gains `scale?: number` (feature sizes and spacing x scale, stars stay 1 px).

- [ ] **Step 1: Write the checks** (zoomCheck, PLACEMENT block):
  - **stable placement:** the sets of world positions of city dots, settlements, creatures, decals and chimneys are identical at zoom 1, 2 and 4 and after a pan (compare sorted `wx,wy` lists). Control: re-planning at the camera (the pre-change code path, invoked explicitly) changes them.
  - **effect stays on its world spot (Review focus 5):** cast an effect at a screen point under a zoom-3 camera; its stored world centre equals `screenToWorld` of that point; after switching to zoom 1 it draws at `worldToScreen(identity)` of that centre (+/- 0.5 px). Control: storing screen px drifts.
  - **far layers:** the sun's track position at zoom 4 equals the far transform of its zoom-1 position (scale `farScale(4) = 1.3` about the focus), not x4. Control: `skyLayout(cameraGeom)` differs.
  - **moons scale:** a moon's orbit radius on screen at zoom 4 is 4x zoom 1 (+/- 1 px).
- [ ] **Step 2: Run — must fail.**
- [ ] **Step 3: Implement** the Task-6 inventory rows: plan everything once in `bake()` at identity and store world coordinates; draw/stamp through the active camera (sprites x round(k)); divine effects store world centre, reach, mote offsets and velocities; sky via `farLayout`; backdrop re-baked at `farScale(k)` on settle (identity keeps today's panorama); moons world-scaled; tile marker size cap x k.
- [ ] **Step 4: Run** — PLACEMENT and all earlier blocks pass; `skyCheck`, `habitableDioramaCheck`, `surfaceDecalCheck` (baseline) exit 0; tsc 2.
- [ ] **Step 5: Commit** — `feat(zoom): placement planned once in world coordinates; sky and backdrop far-scaled; moons and markers through the camera`.

---

### Task 7: Progressive zoom in the renderer, resize and planet change

**Files:**
- Modify: `src/rendering/IsoDioramaRenderer.ts` (`bindViewInput`, `clampViewPan`, `applyViewTransform`, `resize`, `refreshData`/`bakeAll`, `frame`, the 4-second rebake), `src/rendering/HabitableCutawayEngine.ts` (a resize path that keeps the weather sim), `tools/zoomCheck.ts`

**Interfaces:**
- Consumes: `ZoomController`, `SETTLE_MS`, engine `setCamera`/`showCamera`.

- [ ] **Step 1: Write the checks** (zoomCheck, RENDERER block — drive the engine + controller headlessly as the renderer would, through a small exported helper `applySettle(engine, controller, t)` that the renderer also uses):
  - **click after settle maps through the camera (Review focus 2):** after a settle at zoom 4, a click at screen virtual pixel p resolves (via the engine's active pick) to the same cell as `discToGrid` of `screenToWorld(p)` at identity.
  - **resize keeps camera and sim (Review focus 3):** a resize while zoomed keeps `controller.viewZoom`, re-clamps the focus, keeps the weather sim object and fields, and the next settle re-bakes the camera layers at the new size. Control: the pre-change resize path (via `bake()`) replaces the sim.
  - **new planet resets the camera (Review focus 4):** `refreshData` for a new planet while zoomed: controller reset, `engine.showCamera === false`, camera identity, fresh sim.
  - **merged rebake:** the 4-second surface rebake and a due settle in the same frame produce one re-bake.
- [ ] **Step 2: Run — must fail.**
- [ ] **Step 3: Implement:** the renderer owns a `ZoomController` (replacing `viewZoom/viewPanX/viewPanY` state; keep the wheel/pointer handlers and the drag-swallows-click rule, forwarding to the controller); each frame `controller.tick(performance.now())` -> if a camera is returned, `engine.setCamera(cam)`, rebuild placement draw positions (not plans), then `controller.settled(cam)` and `engine.showCamera = true` — all before drawing, so the CSS reset and the sharp frame land together; `display.style.transform = controller.cssTransform()` every frame it changes; `frame()` passes `viewZoom: controller.viewZoom` for haze during gestures. Resize: new identity base, `controller.resize(...)`, engine resize path keeps the sim. `refreshData` with a new planet: `controller.reset()`, `bake()`.
- [ ] **Step 4: Run** — RENDERER and all earlier blocks pass; every suite exit 0 (weatherCheck quick); tsc 2.
- [ ] **Step 5: Commit** — `feat(zoom): progressive zoom — CSS during gestures, sharp re-render on settle; resize and planet change`.

---

### Task 8: Whole-pass verification

- [ ] **Step 1: Suites** — zoomCheck, skyCheck, habitableDioramaCheck, atmosphereCheck, genomeCheck, surfaceDecalCheck (64% baseline), smokeTest (49/3, identical assertion by assertion), weatherCheck full and `--quick --solstice`; tsc 2.
- [ ] **Step 2: Live preview** (controller-run; automated tabs are backgrounded): `diorama-preview.html` ocean, storm, lava, gas at zoom 1 (indistinguishable from today — screenshot diff against a pre-branch screenshot), 2 and 4 with a pan: smooth coasts and terraces, crisp water/clouds/sky; nothing appears or moves on zoom; no jump at settle; no blank area mid-gesture; clicks select the right tile; per-frame time at zoom 4 within 1.2x zoom 1 and settle re-bake time measured.
- [ ] **Step 3: Memory** — `planet-diorama.md` (zoom camera), `zoom-detail-next.md` (sub-project 1 done, next is 2), `verification.md` (zoomCheck).
- [ ] **Step 4: Report** to Sirjohn with screenshots at zoom 1/2/4 and numbers.
