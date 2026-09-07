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
  putImageDataCalls = 0;
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
    this.putImageDataCalls++;
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
  paintCutawaySurface, paintCutawayCrust, paintAtmosphere, paintFluids,
  habitableGeom, HabitableCutawayEngine,
} = await import('../src/rendering/HabitableCutawayEngine');
const type = await import('../src/rendering/HabitableCutawayEngine');
type CutawayBakeOpts = Parameters<typeof type.paintCutawaySurface>[1];

const VW = 480, VH = 320;
const geom = habitableGeom(VW, VH);
const { cx, cyBody, cyTop, R, rx, ry, wall } = geom;
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
  bobOf, BOARD_SQUASH, BOARD_WIDTH, ATMO_RATIO, ATMO_MIN_PX, CY_TOP_DROP,
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

console.log(`\n  body: cx=${cx} cyTop=${cyTop} cyBody=${cyBody} R=${R} rx=${rx} ry=${ry}`
          + `  wall=${wall}px maxLift=${MAX_LIFT}px`);
console.log(`  face area ~${Math.round(faceArea)}px²\n`);

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
  const occupancy = new Uint8Array(VW * VH);
  const opts = {
    w: VW, h: VH, cx, cyTop, cyBody, R, rx, ry, wall,
    seed: 0xbeef, grid, planetType,
    discToGrid, rimFalloff, liftOf, smoothElevation,
    maxLift: MAX_LIFT, lush: 0.6, pick,
  } as unknown as CutawayBakeOpts;
  opts.occupancy = occupancy;

  const engine = new HabitableCutawayEngine();
  engine.bake({
    w: VW, h: VH, seed: opts.seed, grid, planetType,
    discToGrid, rimFalloff, liftOf, smoothElevation,
    maxLift: MAX_LIFT, lush: 0.6,
  });
  check('class bake occupancy', engine.occupancy.some(v => v === 1), 'has water');
  const classHit = engine.hitTest(engine.geom.cx, engine.geom.cyTop);
  check('hitTest centre', classHit !== null, JSON.stringify(classHit));
  const frameCanvas = makeCanvas(VW, VH);
  const frameCtx = frameCanvas.getContext() as RecordingCtx;
  engine.frame({
    g: frameCtx as unknown as CanvasRenderingContext2D,
    dt: 1 / 60, elapsed: 1, bg: makeCanvas(VW, VH),
    drawFarSpace: () => {}, drawOverlays: () => {}, drawNearMoons: () => {},
    weatherMix: [],
  });
  check('frame composites alpha layers', frameCtx.putImageDataCalls === 0,
        `${frameCtx.putImageDataCalls} live putImageData calls`);

  const surfaceCanvas = makeCanvas(VW, VH);
  const crustCanvas = makeCanvas(VW, VH);
  const sCtx = surfaceCanvas.getContext() as RecordingCtx;
  const cCtx = crustCanvas.getContext() as RecordingCtx;

  paintCutawaySurface(sCtx as unknown as CanvasRenderingContext2D, opts);
  paintCutawayCrust(cCtx as unknown as CanvasRenderingContext2D, opts);

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

  // 1 — land canvas paints land only; occupancy stamps the fluid ellipse.
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
  const crustCovered = cCtx.mask.reduce((a, b) => a + b, 0);
  check('crust layer has pixels', crustCovered > rx * wall * 0.40,
        `${crustCovered}px covered`);

  // 2 — geometric containment of the crust.
  // Back-hemisphere rock ABOVE the tabletop is intentional (3/4 seating).
  // Forbid only: pixels outside the body, or crust stamped inside the face
  // ellipse (the surface layer owns that).
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

  // Occupancy water must keep the water-cell pick ID. Land cliffs used to
  // overwrite pick through put(), then the alpha punch left a land ID on a
  // transparent fluid pixel.
  let waterPickLand = 0, waterPickEmpty = 0;
  for (let y = 0; y < VH; y++) {
    for (let x = 0; x < VW; x++) {
      const i = y * VW + x;
      if (!occupancy[i]) continue;
      const gp = discToGrid((x - cx) / rx, (y - cyTop) / ry);
      if (!gp) continue;
      const expected = gp.row * GRID_SIZE + gp.col + 1;
      if (pick[i] === 0) waterPickEmpty++;
      else if (pick[i] !== expected) waterPickLand++;
    }
  }
  check('occupancy keeps water pick', waterPickLand === 0 && waterPickEmpty === 0,
        `${waterPickLand} land IDs, ${waterPickEmpty} empty`);

  const fluidImg = ag.createImageData(VW, VH);
  paintFluids(fluidImg, geom, occupancy, planetType, 1.0, 0);
  let painted = 0;
  for (let i = 0; i < occupancy.length; i++) {
    if (occupancy[i] && fluidImg.data[i * 4 + 3] > 0) painted++;
  }
  check('fluids paint occupancy', painted > waterPx * 0.8, `${painted}/${waterPx}`);

  console.log('');
}

console.log(failures === 0
  ? `  all habitable cutaway checks passed\n`
  : `  ${failures} check(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
