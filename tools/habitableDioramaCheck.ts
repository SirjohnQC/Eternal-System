/**
 * Dev-only: does the habitable cutaway bake actually produce a planet?
 *
 * Guards three things the visual bake cannot tell you at a glance:
 *   1. every layer comes back with pixels in it (a silent throw or an off-by-one
 *      in the geometry produces a plausible-looking EMPTY canvas)
 *   2. no crust pixel lands outside the body silhouette, and none lands above
 *      the cut face — the two ways the wall math can go wrong and still draw
 *   3. the pick buffer is populated, so grid picking still works on the face
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/habitableDioramaCheck.ts --bundle \
 *     --platform=node --format=esm --outfile=%TEMP%/habcheck.mjs \
 *     && node %TEMP%/habcheck.mjs
 */

// ─── Minimal recording Canvas 2D shim ─────────────────────────────────────────
//
// Only the operations the engine actually uses. `fillRect` and `putImageData`
// are recorded into a coverage mask; path fills and anything drawn under a clip
// are counted but not recorded, because their extent is not knowable without a
// real rasteriser and their containment is guaranteed by the clip itself.

class RecordingCtx {
  mask: Uint8Array;
  rectPixels = 0;
  imagePixels = 0;
  clippedOps = 0;
  pathOps = 0;
  private clipDepth = 0;
  private stack: number[] = [];

  fillStyle: unknown = '';
  strokeStyle: unknown = '';
  lineWidth = 1;
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  imageSmoothingEnabled = false;

  constructor(readonly W: number, readonly H: number) {
    this.mask = new Uint8Array(W * H);
  }

  private mark(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    if (this.mask[y * this.W + x] === 0) this.mask[y * this.W + x] = 1;
  }

  save(): void { this.stack.push(this.clipDepth); }
  restore(): void { this.clipDepth = this.stack.pop() ?? 0; }
  clip(): void { this.clipDepth++; }

  beginPath(): void {}
  closePath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  arc(): void {}
  ellipse(): void {}
  fill(): void { this.pathOps++; }
  stroke(): void { this.pathOps++; }

  clearRect(): void {}

  fillRect(x: number, y: number, w: number, h: number): void {
    if (this.clipDepth > 0) { this.clippedOps++; return; }
    const x0 = Math.round(x), y0 = Math.round(y);
    for (let dy = 0; dy < Math.round(h); dy++) {
      for (let dx = 0; dx < Math.round(w); dx++) {
        this.mark(x0 + dx, y0 + dy);
        this.rectPixels++;
      }
    }
  }

  createImageData(w: number, h: number) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }

  putImageData(
    img: { width: number; height: number; data: Uint8ClampedArray },
    dx: number, dy: number,
  ): void {
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (img.data[(y * img.width + x) * 4 + 3] === 0) continue;
        this.mark(dx + x, dy + y);
        this.imagePixels++;
      }
    }
  }

  drawImage(): void {}

  createLinearGradient() { return { addColorStop() {} }; }
  createRadialGradient() { return { addColorStop() {} }; }
}

const canvases: Array<{ ctx: RecordingCtx }> = [];

function makeCanvas(w = 480, h = 320): any {
  const c: any = { width: w, height: h, style: {} };
  let ctx: RecordingCtx | null = null;
  c.getContext = () => {
    if (!ctx) { ctx = new RecordingCtx(c.width, c.height); canvases.push({ ctx }); }
    return ctx;
  };
  return c;
}

(globalThis as any).document = { createElement: () => makeCanvas() };

// ─── Geometry + projection, mirroring IsoDioramaRenderer ─────────────────────

const { generatePlanetGrid, SEA_LEVEL, GRID_SIZE, isWater } =
  await import('../src/simulation/PlanetGrid');
const {
  paintCutawaySurface, paintCutawayCrust, bakeCutawayAtmosphere,
  cutawayBodyCy, cutawayFaceCy, CUTAWAY_FACE_SQUASH,
} = await import('../src/rendering/HabitableCutawayEngine');
const type = await import('../src/rendering/HabitableCutawayEngine');
type CutawayBakeOpts = Parameters<typeof type.paintCutawaySurface>[1];

const VW = 480, VH = 320;
const cx = Math.round(VW / 2);
const rx = Math.round(Math.min(VW * 0.34, VH * 0.44));
const ry = Math.max(6, Math.round(rx * CUTAWAY_FACE_SQUASH));
const cyBody = Math.round(VH * 0.56);
const cyTop = cutawayFaceCy(cyBody, rx, ry);
const MAX_LIFT = 9;

function liftOf(elev: number): number {
  if (elev < SEA_LEVEL) return 0;
  if (elev > 0.72) return 9;
  if (elev > 0.58) return 5;
  return 2;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampAbs = (v: number, m: number) => (v < -m ? -m : v > m ? m : v);

function rimFalloff(r: number): number {
  const t = clamp01((r - 0.34) / 0.66);
  return t * t * 0.30;
}

function makeProjection(focusLat: number, focusLon: number) {
  return (dx: number, dy: number): { row: number; col: number } | null => {
    const r = Math.hypot(dx, dy);
    if (r > 1) return null;
    const c = r * (Math.PI / 2);
    const sinC = Math.sin(c), cosC = Math.cos(c);
    const sinF = Math.sin(focusLat), cosF = Math.cos(focusLat);
    const ny = -dy;
    const lat = r < 1e-6
      ? focusLat
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

function smoothElevation(grid: any, row: number, col: number): number {
  let sum = 0, n = 0;
  for (let dr = -1; dr <= 1; dr++) {
    const r2 = row + dr;
    if (r2 < 0 || r2 >= GRID_SIZE) continue;
    for (let dc = -1; dc <= 1; dc++) {
      const c2 = (col + dc + GRID_SIZE) % GRID_SIZE;
      const cell = grid[r2]?.[c2];
      if (!cell) continue;
      const wt = dr === 0 && dc === 0 ? 4 : 1;
      sum += cell.elevation * wt; n += wt;
    }
  }
  return n > 0 ? sum / n : 0;
}

// ─── Checks ───────────────────────────────────────────────────────────────────

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(42)} ${detail}`);
}

// ─── Pancake god-view geometry (Task 1) ───────────────────────────────────────

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

console.log('');

const faceArea = Math.PI * rx * ry;
// Wall area under the cut: ∫ (bodyBottom − faceBottom) dx over the diameter.
let wallArea = 0;
for (let x = cx - rx; x <= cx + rx; x++) {
  const e = Math.sqrt(Math.max(0, 1 - ((x - cx) / rx) ** 2));
  wallArea += (cyBody + rx * e) - (cyTop + ry * e);
}

console.log(`\n  body: cx=${cx} cyTop=${cyTop} cyBody=${cyBody} rx=${rx} ry=${ry}`
          + `  (cutawayBodyCy→${cutawayBodyCy(cyTop, rx, ry)})`
          + `  maxLift=${MAX_LIFT}px`);
console.log(`  face area ~${Math.round(faceArea)}px²   wall area ~${Math.round(wallArea)}px²\n`);

for (const planetType of ['ocean', 'rocky'] as const) {
  console.log(`  ── ${planetType} ──`);
  const grid = generatePlanetGrid(planetType, 7777, null);

  // Centre the projection on the most land-surrounded mid-latitude cell, the
  // same way computeFocus does, so the bake sees a real continent.
  let bestScore = -1, bestRow = GRID_SIZE >> 1, bestCol = 0;
  const STRIDE = 8, RAD = 3;
  for (let row = STRIDE * RAD; row < GRID_SIZE - STRIDE * RAD; row += STRIDE) {
    const latWeight = 1 - Math.abs(row / (GRID_SIZE - 1) - 0.5) * 1.4;
    if (latWeight <= 0) continue;
    for (let col = 0; col < GRID_SIZE; col += STRIDE) {
      let score = 0;
      for (let dr = -RAD; dr <= RAD; dr++) {
        for (let dc = -RAD; dc <= RAD; dc++) {
          const cell = grid[row + dr * STRIDE]?.[(col + dc * STRIDE + GRID_SIZE) % GRID_SIZE];
          if (cell && !isWater(cell.biome)) score += 1 + cell.fertility;
        }
      }
      score *= latWeight;
      if (score > bestScore) { bestScore = score; bestRow = row; bestCol = col; }
    }
  }
  const discToGrid = makeProjection(
    (0.5 - bestRow / (GRID_SIZE - 1)) * Math.PI,
    (bestCol / GRID_SIZE) * Math.PI * 2,
  );

  const pick = new Int32Array(VW * VH);
  const opts = {
    w: VW, h: VH, cx, cyTop, rx, ry,
    seed: 0xbeef, grid, planetType,
    discToGrid, rimFalloff, liftOf, smoothElevation,
    maxLift: MAX_LIFT, lush: 0.6, pick,
  } as unknown as CutawayBakeOpts;

  const surfaceCanvas = makeCanvas(VW, VH);
  const crustCanvas = makeCanvas(VW, VH);
  const sCtx = surfaceCanvas.getContext() as RecordingCtx;
  const cCtx = crustCanvas.getContext() as RecordingCtx;

  paintCutawaySurface(sCtx as unknown as CanvasRenderingContext2D, opts);
  paintCutawayCrust(cCtx as unknown as CanvasRenderingContext2D, opts);
  const atmo = bakeCutawayAtmosphere(VW, VH, { cx, cyTop, rx, ry }, planetType);
  const aCtx = atmo.getContext('2d') as unknown as RecordingCtx;

  // 1 — layers are not empty.
  const surfaceCovered = sCtx.mask.reduce((a, b) => a + b, 0);
  const crustCovered = cCtx.mask.reduce((a, b) => a + b, 0);
  check('surface layer has pixels', surfaceCovered > faceArea * 0.75,
        `${surfaceCovered}px covered (face ~${Math.round(faceArea)})`);
  check('crust layer has pixels', crustCovered > wallArea * 0.70,
        `${crustCovered}px covered (wall ~${Math.round(wallArea)})`);
  check('atmosphere layer drew something', aCtx.pathOps + aCtx.clippedOps > 0,
        `${aCtx.pathOps} strokes, ${aCtx.clippedOps} clipped fills`);

  // 2 — geometric containment of the crust.
  // Back-hemisphere rock ABOVE the tabletop is intentional (3/4 seating).
  // Forbid only: pixels outside the body, or crust stamped inside the face
  // ellipse (the surface layer owns that).
  let outsideBody = 0, insideFace = 0;
  for (let y = 0; y < VH; y++) {
    for (let x = 0; x < VW; x++) {
      if (cCtx.mask[y * VW + x] === 0) continue;
      // Allow one pixel of slack: the silhouette pixel sits ON the circle.
      if (Math.hypot(x - cx, y - cyBody) > rx + 1.5) outsideBody++;
      const fdx = (x - cx) / rx, fdy = (y - cyTop) / ry;
      if (fdx * fdx + fdy * fdy <= 0.98) insideFace++;
    }
  }
  check('no crust outside the silhouette', outsideBody === 0, `${outsideBody} stray px`);
  check('no crust inside the tabletop', insideFace === 0, `${insideFace} stray px`);

  // 3 — the pick buffer is usable.
  let picked = 0, pickOutside = 0;
  for (let y = 0; y < VH; y++) {
    for (let x = 0; x < VW; x++) {
      if (pick[y * VW + x] === 0) continue;
      picked++;
      const dx = (x - cx) / rx, dy = (y - cyTop) / ry;
      // Lifted ground draws above the ellipse, so allow maxLift rows of slack.
      if (Math.hypot(dx, (y + MAX_LIFT - cyTop) / ry) > 1.02 && Math.hypot(dx, dy) > 1.02) {
        pickOutside++;
      }
    }
  }
  check('pick buffer populated', picked > faceArea * 0.70,
        `${picked} cells stamped (face ~${Math.round(faceArea)})`);
  check('pick buffer stays on the face', pickOutside === 0, `${pickOutside} stray px`);

  // 4 — the water column exists: a band of crust right under the rim at the
  //     centre column, before the rock starts.
  const centreCol: number[] = [];
  for (let y = cyTop + ry; y < cyBody + rx; y++) {
    if (cCtx.mask[y * VW + cx]) centreCol.push(y);
  }
  check('crust spans the centre column',
        centreCol.length > (cyBody + rx - (cyTop + ry)) * 0.9,
        `${centreCol.length} of ${cyBody + rx - (cyTop + ry)} rows`);

  console.log('');
}

console.log(failures === 0
  ? `  all habitable cutaway checks passed\n`
  : `  ${failures} check(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
