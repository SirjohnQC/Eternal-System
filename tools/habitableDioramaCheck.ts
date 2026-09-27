/**
 * Dev-only: does the habitable cutaway bake actually produce a planet?
 *
 * Guards three things the visual bake cannot tell you at a glance:
 *   1. every layer comes back with pixels in it (a silent throw or an off-by-one
 *      in the geometry produces a plausible-looking EMPTY canvas)
 *   2. no crust pixel lands above the pancake or inside the living face, and
 *      the hanging keel actually drops below the sheer wall
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
  blueMask: Uint8Array;
  rectPixels = 0;
  imagePixels = 0;
  putImageDataCalls = 0;
  createImageDataCalls = 0;
  getImageDataCalls = 0;
  clippedOps = 0;
  pathOps = 0;
  lastImage: { width: number; height: number; data: Uint8ClampedArray } | null = null;
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
    this.blueMask = new Uint8Array(W * H);
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
  rect(): void {}
  fill(): void { this.pathOps++; }
  stroke(): void { this.pathOps++; }

  clearRect(): void {}

  fillRect(x: number, y: number, w: number, h: number): void {
    if (this.clipDepth > 0) { this.clippedOps++; return; }
    const x0 = Math.round(x), y0 = Math.round(y);
    const colour = typeof this.fillStyle === 'string'
      ? this.fillStyle.match(/^rgba?\((\d+),(\d+),(\d+)/)
      : null;
    const blue = !!colour && Number(colour[3]) > Number(colour[1]) + 15;
    for (let dy = 0; dy < Math.round(h); dy++) {
      for (let dx = 0; dx < Math.round(w); dx++) {
        this.mark(x0 + dx, y0 + dy);
        if (blue && x0 + dx >= 0 && y0 + dy >= 0 && x0 + dx < this.W && y0 + dy < this.H) {
          this.blueMask[(y0 + dy) * this.W + x0 + dx] = 1;
        }
        this.rectPixels++;
      }
    }
  }

  createImageData(w: number, h: number) {
    this.createImageDataCalls++;
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }

  putImageData(
    img: { width: number; height: number; data: Uint8ClampedArray },
    dx: number, dy: number,
  ): void {
    this.putImageDataCalls++;
    this.lastImage = img;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (img.data[(y * img.width + x) * 4 + 3] === 0) continue;
        this.mark(dx + x, dy + y);
        this.imagePixels++;
      }
    }
  }

  getImageData(x = 0, y = 0, w = this.W, h = this.H) {
    this.getImageDataCalls++;
    if (this.lastImage && x === 0 && y === 0 && w === this.lastImage.width && h === this.lastImage.height) {
      return this.lastImage;
    }
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
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
  bakeShoreDistance, habitableGeom, HabitableCutawayEngine,
  planVolcanoChimneys,
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
check('bob is disabled', bobOf(Math.PI / 1.4, g480.R) === 0,
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
  const liveGets = canvases.reduce((n, c) => n + c.ctx.getImageDataCalls, 0);
  check('frame does not read back pixels', liveGets === 0,
        `${liveGets} getImageData calls`);
  const imageAllocations = frameCtx.createImageDataCalls;
  engine.frame({
    g: frameCtx as unknown as CanvasRenderingContext2D,
    dt: 1 / 60, elapsed: 1.1, bg: makeCanvas(VW, VH),
    drawFarSpace: () => {}, drawOverlays: () => {}, drawNearMoons: () => {},
    weatherMix: [],
  });
  check('frame reuses live ImageData', frameCtx.createImageDataCalls === imageAllocations,
        `${frameCtx.createImageDataCalls - imageAllocations} new frame allocations`);
  const bobBeforeSurfaceRebake = engine.bob;
  engine.rebakeSurface();
  check('surface rebake preserves bob', engine.bob === bobBeforeSurfaceRebake,
        `before=${bobBeforeSurfaceRebake.toFixed(3)} after=${engine.bob.toFixed(3)}`);

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

  let skyCap = 0, limbMax = 0, faceMax = 0, frontBleed = 0, farBleed = 0;
  let fringe = 0, atmoBelow = 0;
  const cy = geom.cyTop + bob;
  const front = cy + geom.ry;
  for (let y = 0; y < VH; y++) {
    for (let x = 0; x < VW; x++) {
      const a = img.data[(y * VW + x) * 4 + 3];
      if (a < 3) continue;
      if (y > front + 2) atmoBelow++;
      const dx = x - geom.cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy) / geom.rx;
      const face = (dx / geom.rx) ** 2 + (dy / geom.ry) ** 2;
      // Below the rim line, air may only sit in the limb band that wraps the
      // rim (atmosphere pass, 2026-09-26): within the legacy shell's reach
      // (8px thickness x 1.6 wobble + 2) of the rim ellipse, tapering to
      // nothing at the front. Anything beyond that is air spilling down the drum.
      if (y > cy && face > 1) {
        const s2 = dy / geom.ry;
        const taper = s2 >= 1 ? 0 : 1 - s2 * s2;
        const distPx = Math.hypot(dx, dy);
        const outsideRim = distPx * (1 - 1 / Math.sqrt(face));
        if (outsideRim >= (8 * 1.6 + 2) * taper) frontBleed++;
      }
      if (r > 1.18) farBleed++;
      else if (r > 1 && y <= cy) fringe++;
      else if (face > 1) {
        skyCap++;
        if (r > 0.85) limbMax = Math.max(limbMax, a);
      } else if (face < 0.45) {
        faceMax = Math.max(faceMax, a);
      }
    }
  }
  check('atmo fills the sky cap', skyCap > 200, `${skyCap} dome px`);
  check('ozone limb reads as a shell', limbMax >= 90, `max limb alpha ${limbMax}`);
  check('tabletop air is thinner than the limb', faceMax < limbMax * 0.55,
        `face ${faceMax} vs limb ${limbMax}`);
  check('ozone limb feathers into space', fringe > 40, `${fringe} fringe px`);
  check('atmo below the rim stays in the limb band', frontBleed === 0, `${frontBleed} front`);
  check('atmo does not bleed far from the dome', farBleed === 0, `${farBleed} far`);
  check('atmo stays above crust', atmoBelow === 0, `${atmoBelow} below pancake`);
  // Colour is measured on RENDERED pixels, not on a palette struct. These two
  // assertions used to read `cutawayAtmoColour(type)`, i.e. `CutawayPalette.atmo`
  // — which paintAtmosphere stopped reading the moment the air moved onto the
  // genome. They passed on hand-maintained data that nothing draws any more, so
  // they would have stayed green no matter what colour the renderer produced.
  // That is the exact shape of the lava-pink-sky bug this suite exists to catch.
  const sunlitLimb = (type: HabitableType): [number, number, number] => {
    const probe = ag.createImageData(VW, VH);
    paintAtmosphere(probe, geom, type, bob, 0, 1);
    const o = ((geom.cyTop + bob) * VW + (geom.cx + geom.rx - 2)) * 4;
    return [probe.data[o], probe.data[o + 1], probe.data[o + 2]];
  };
  const oceanC = sunlitLimb('ocean');
  const rockyC = sunlitLimb('rocky');
  const lavaC = sunlitLimb('lava');
  check('ocean air renders blue', oceanC[2] > oceanC[0] + 40, `rgb ${oceanC.join(',')}`);
  check('rocky air renders dusty', rockyC[0] > 120 && rockyC[0] + 15 > rockyC[2],
        `rgb ${rockyC.join(',')}`);
  // Sampled on the SUNLIT limb, where the warm anchor pulls hardest: a hue that
  // wraps out of the warm family shows up here first.
  check('lava air stays warm, not magenta', lavaC[1] > lavaC[2] + 20,
        `rgb ${lavaC.join(',')}`);
  const gone = ag.createImageData(VW, VH);
  paintAtmosphere(gone, geom, planetType, bob, 0, 0);
  let zoomedPx = 0;
  for (let i = 3; i < gone.data.length; i += 4) if (gone.data[i] > 0) zoomedPx++;
  check('atmo gone when zoomed', zoomedPx === 0, `${zoomedPx} px at intensity 0`);

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
  const shore = bakeShoreDistance(occupancy, geom, VW, VH);
  let coast = 0, deepWater = 0;
  for (let i = 0; i < occupancy.length; i++) {
    if (!occupancy[i]) continue;
    if (shore[i] > 0 && shore[i] < 2.5) coast++;
    if (shore[i] >= 8) deepWater++;
  }
  check('shore dist marks coast', coast > 20, `${coast} coast px`);
  check('shore dist has open water', deepWater > 20, `${deepWater} deep px`);
  let shoreMismatch = 0;
  for (let i = 0; i < occupancy.length; i++) {
    if (occupancy[i] && engine.shoreDist[i] !== shore[i]) shoreMismatch++;
  }
  check('engine baked shore dist', shoreMismatch === 0, `${shoreMismatch} mismatch`);
  const crustCovered = cCtx.mask.reduce((a, b) => a + b, 0);
  check('crust layer has pixels', crustCovered > rx * wall * 0.40,
        `${crustCovered}px covered`);

  // 2 — geometric containment of the crust.
  // Rock hangs under the board; it must not fill the atmospheric sphere, sit
  // above the far rim, or stamp the living pancake (surface owns that).
  let aboveBoard = 0, outsideWidth = 0, insideFace = 0, wallPx = 0, hanging = 0;
  for (let y = 0; y < VH; y++) {
    for (let x = 0; x < VW; x++) {
      if (cCtx.mask[y * VW + x] === 0) continue;
      if (y < cyTop - ry - 2) aboveBoard++;
      if (Math.abs(x - cx) > rx + 2) outsideWidth++;
      const fdx = (x - cx) / rx, fdy = (y - cyTop) / ry;
      if (fdx * fdx + fdy * fdy <= 0.98) insideFace++;
      const front = cyTop + Math.sqrt(Math.max(0, 1 - fdx * fdx)) * ry;
      if (Math.abs(fdx) <= 1 && y >= front && y <= front + wall + 6) wallPx++;
      if (y > front + wall + 8) hanging++;
    }
  }
  check('no crust above pancake', aboveBoard === 0, `${aboveBoard} stray`);
  check('no crust past board width', outsideWidth === 0, `${outsideWidth} stray`);
  check('no crust inside pancake', insideFace === 0, `${insideFace} stray`);
  check('sheer wall has coverage', wallPx > rx * wall * 0.4, `${wallPx} wall px`);
  check('crust hangs below wall', hanging > rx * 4, `${hanging} keel px`);

  // The occupancy cell nearest the front rim controls the wall material. The
  // pixel immediately above it is outside the ellipse near the limb and must
  // not turn this deliberately-water edge into a land cliff.
  const limbX = Math.round(cx + rx * 0.85);
  const limbFaceX = (limbX - cx) / rx;
  const limbY = Math.floor(cyTop + Math.sqrt(1 - limbFaceX * limbFaceX) * ry);
  const limbOccupancy = new Uint8Array(VW * VH);
  limbOccupancy[limbY * VW + limbX] = 1;
  const limbCanvas = makeCanvas(VW, VH);
  const limbCtx = limbCanvas.getContext() as RecordingCtx;
  paintCutawayCrust(limbCtx as unknown as CanvasRenderingContext2D, {
    ...opts, occupancy: limbOccupancy,
  });
  let limbWaterWallPx = 0;
  for (let y = limbY; y <= Math.min(VH - 1, limbY + wall + 6); y++) {
    limbWaterWallPx += limbCtx.blueMask[y * VW + limbX];
  }
  check('limb wall reads in-ellipse occupancy', limbWaterWallPx > 0, `${limbWaterWallPx} water wall px`);

  const dryOcc = new Uint8Array(VW * VH);
  const dryCanvas = makeCanvas(VW, VH);
  const dryCtx = dryCanvas.getContext() as RecordingCtx;
  paintCutawayCrust(dryCtx as unknown as CanvasRenderingContext2D, {
    ...opts, occupancy: dryOcc,
  });
  const midX = cx;
  const midFront = cyTop + ry;
  let lipWater = 0;
  for (let y = Math.ceil(midFront); y < Math.ceil(midFront) + 6; y++) {
    lipWater += dryCtx.blueMask[y * VW + midX];
  }
  check('crust lip is water under land', lipWater > 0, `${lipWater} water lip px`);

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

  const layerBob = 2;
  let waterPixel = -1;
  for (let y = Math.ceil(cyTop - ry + 4); y <= Math.floor(cyTop + ry - 4) && waterPixel < 0; y++) {
    for (let x = Math.ceil(cx - rx + 4); x <= Math.floor(cx + rx - 4); x++) {
      if (occupancy[y * VW + x]) { waterPixel = y * VW + x; break; }
    }
  }
  const singleWater = new Uint8Array(VW * VH);
  singleWater[waterPixel] = 1;
  const fluidImg = ag.createImageData(VW, VH);
  paintFluids(fluidImg, geom, singleWater, planetType, 1.0, layerBob);
  const shiftedWaterPixel = waterPixel + layerBob * VW;
  check('fluids follow bobbed occupancy',
        fluidImg.data[shiftedWaterPixel * 4 + 3] === 255 && fluidImg.data[waterPixel * 4 + 3] === 0,
        `rest=${waterPixel} shifted=${shiftedWaterPixel}`);

  // Quieter open water + coastal detail: deep open should stay mostly mid-blue;
  // glint/foam concentrates near land. Classify by luminance band.
  if (planetType === 'ocean') {
    const caustic = ag.createImageData(VW, VH);
    paintFluids(caustic, geom, occupancy, 'ocean', 2.7, 0, shore);
    const cd = caustic.data;
    const lumAt = (i: number) => cd[i * 4] + cd[i * 4 + 1] + cd[i * 4 + 2];
    const GLINT_L = 620, LIGHT_L = 430;
    let openN = 0, openGlint = 0, openLight = 0;
    let coastN = 0, coastGlint = 0;
    let thinWeb = 0, coastGlintPx = 0;
    for (let y = 1; y < VH - 1; y++) {
      for (let x = 1; x < VW - 1; x++) {
        const i = y * VW + x;
        if (!occupancy[i]) continue;
        const rdx = (x - cx) / rx, rdy = (y - cyTop) / ry;
        if (rdx * rdx + rdy * rdy > 0.94) continue;
        const L = lumAt(i);
        const isGlint = L >= GLINT_L;
        const isLight = L >= LIGHT_L && L < GLINT_L;
        if (shore[i] > 0 && shore[i] < 5) {
          coastN++;
          if (isGlint) {
            coastGlint++;
            coastGlintPx++;
            let darker = 0;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
              const ni = (y + dy) * VW + (x + dx);
              if (occupancy[ni] && lumAt(ni) < L - 50) darker++;
            }
            if (darker >= 3) thinWeb++;
          }
        } else if (shore[i] >= 8) {
          openN++;
          if (isGlint) openGlint++;
          if (isLight) openLight++;
        }
      }
    }
    const openGlintFrac = openGlint / Math.max(1, openN);
    const openLightFrac = openLight / Math.max(1, openN);
    const coastGlintFrac = coastGlint / Math.max(1, coastN);
    const webFrac = thinWeb / Math.max(1, coastGlintPx);
    check('ocean open water stays calm', openGlintFrac < 0.06 && openLightFrac > 0.015 && openLightFrac < 0.20,
          `glint=${openGlintFrac.toFixed(3)} light=${openLightFrac.toFixed(3)}`);
    check('ocean coast keeps caustic/foam', coastGlintFrac > 0.04 && coastGlintFrac < 0.45,
          `coastGlint=${coastGlintFrac.toFixed(3)}`);
    check('ocean caustic web is thin (cell edges)', coastGlintPx === 0 || webFrac > 0.45,
          `web=${webFrac.toFixed(3)} thin=${thinWeb}/${coastGlintPx}`);

    // Far from land the body should read deep navy, not flat mid-blue —
    // but pale whisper lines may lift a minority of pixels above deep.
    let deepOpen = 0, deepN = 0;
    const DEEP_L = 12 + 52 + 118 + 55;
    for (let i = 0; i < occupancy.length; i++) {
      if (!occupancy[i] || shore[i] < 10) continue;
      const y = Math.floor(i / VW), x = i - y * VW;
      const rdx = (x - cx) / rx, rdy = (y - cyTop) / ry;
      if (rdx * rdx + rdy * rdy > 0.94) continue;
      deepN++;
      const L = caustic.data[i * 4] + caustic.data[i * 4 + 1] + caustic.data[i * 4 + 2];
      if (L <= DEEP_L) deepOpen++;
    }
    const deepFrac = deepOpen / Math.max(1, deepN);
    check('ocean deepens far from land', deepFrac > 0.55,
          `deep=${deepFrac.toFixed(3)}`);

    // Shore-directed motion: the swell must travel toward land on every coast,
    // not drift globally. Bin water luminance by shore distance, subtract the
    // period-mean profile (static web), then cross-correlate two frames 0.4 s
    // apart: the later frame must match the earlier one shifted to LARGER shore
    // distance (the crest came from open water) better than the reverse.
    const profileAt = (t: number): Float64Array => {
      const f = ag.createImageData(VW, VH);
      paintFluids(f, geom, occupancy, 'ocean', t, 0, shore);
      const sum = new Float64Array(40), n = new Float64Array(40);
      for (let i = 0; i < occupancy.length; i++) {
        if (!occupancy[i] || f.data[i * 4 + 3] === 0) continue;
        const b = Math.floor(shore[i]);
        if (b < 0 || b >= 40) continue;
        sum[b] += f.data[i * 4] + f.data[i * 4 + 1] + f.data[i * 4 + 2];
        n[b]++;
      }
      return sum.map((s, i) => (n[i] > 0 ? s / n[i] : 0));
    };
    const SWELL_PERIOD = 2 * Math.PI / 1.6;
    const NF = 8;
    const meanP = new Float64Array(40);
    for (let f = 0; f < NF; f++) {
      const p = profileAt(20 + (f * SWELL_PERIOD) / NF);
      for (let i = 0; i < 40; i++) meanP[i] += p[i] / NF;
    }
    const residAt = (t: number) => profileAt(t).map((v, i) => v - meanP[i]);
    const corrAtShift = (p0: Float64Array, p1: Float64Array, s: number): number => {
      const lo = 4, hi = 26; // lo ≥ |s| + 1 so p0[dd + s] stays in range
      let m0 = 0, m1 = 0, k = 0;
      for (let dd = lo; dd < hi; dd++) { m0 += p0[dd + s]; m1 += p1[dd]; k++; }
      m0 /= k; m1 /= k;
      let c = 0, v0 = 0, v1 = 0;
      for (let dd = lo; dd < hi; dd++) {
        const a = p0[dd + s] - m0, b = p1[dd] - m1;
        c += a * b; v0 += a * a; v1 += b * b;
      }
      return c / (Math.sqrt(v0 * v1) || 1);
    };
    let landward = 0, seaward = 0;
    for (const t0 of [0, 1.3, 5.1, 9.7]) {
      const p0 = residAt(t0), p1 = residAt(t0 + 0.4);
      for (let s = 1; s <= 3; s++) {
        landward += corrAtShift(p0, p1, s);
        seaward += corrAtShift(p0, p1, -s);
      }
    }
    check('ocean swell travels toward shore', landward > seaward + 0.5,
          `landward=${landward.toFixed(2)} seaward=${seaward.toFixed(2)}`);
  }

  engine.frame({
    g: frameCtx as unknown as CanvasRenderingContext2D,
    dt: 1 / 60, elapsed: Math.PI / 1.4, bg: makeCanvas(VW, VH),
    drawFarSpace: () => {}, drawOverlays: () => {}, drawNearMoons: () => {},
    weatherMix: [],
  });
  check('hitTest stays on planted surface',
        JSON.stringify(engine.hitTest(engine.geom.cx, engine.geom.cyTop)) === JSON.stringify(classHit)
        && engine.bob === 0,
        `bob=${engine.bob} rest=${JSON.stringify(classHit)}`);

  console.log('');
}

// ─── Smoke: ice / lava / gas (+ wild) cutaway bake ────────────────────────────

const SMOKE_TYPES = [
  'ice', 'lava', 'gas', 'toxic', 'crystal', 'desert', 'storm', 'carbon',
] as const;

for (const planetType of SMOKE_TYPES) {
  console.log(`  ── smoke ${planetType} ──`);
  const grid = generatePlanetGrid(planetType, 4242, null);
  const discToGrid = makeProjection(0.1, 0.7);
  const pick = new Int32Array(VW * VH);
  const occupancy = new Uint8Array(VW * VH);
  const opts = {
    w: VW, h: VH, cx, cyTop, cyBody, R, rx, ry, wall,
    seed: 0xcafe + planetType.length, grid, planetType,
    discToGrid, rimFalloff, liftOf, smoothElevation,
    maxLift: MAX_LIFT, lush: 0.4, pick, occupancy,
  } as unknown as CutawayBakeOpts;

  const engine = new HabitableCutawayEngine();
  engine.bake({
    w: VW, h: VH, seed: opts.seed, grid, planetType,
    discToGrid, rimFalloff, liftOf, smoothElevation,
    maxLift: MAX_LIFT, lush: 0.4,
  });

  const surfaceCanvas = makeCanvas(VW, VH);
  const crustCanvas = makeCanvas(VW, VH);
  const sCtx = surfaceCanvas.getContext() as RecordingCtx;
  const cCtx = crustCanvas.getContext() as RecordingCtx;
  paintCutawaySurface(sCtx as unknown as CanvasRenderingContext2D, opts);
  paintCutawayCrust(cCtx as unknown as CanvasRenderingContext2D, opts);

  const landPx = sCtx.mask.reduce((a, b) => a + b, 0);
  const crustPx = cCtx.mask.reduce((a, b) => a + b, 0);
  check(`${planetType} surface paints`, landPx > faceArea * 0.25, `${landPx} px`);
  check(`${planetType} crust paints`, crustPx > rx * wall * 0.25, `${crustPx} px`);

  const atmoCanvas = makeCanvas(VW, VH);
  const ag = atmoCanvas.getContext() as RecordingCtx;
  const img = ag.createImageData(VW, VH);
  paintAtmosphere(img, geom, planetType, 0);
  ag.putImageData(img, 0, 0);
  let atmoPx = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 0) atmoPx++;
  check(`${planetType} ozone dome`, atmoPx > 200, `${atmoPx} atmo px`);

  // Again on rendered pixels: the brightest thing this type's air actually paints.
  let tintMax = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < 3) continue;
    tintMax = Math.max(tintMax, img.data[i] + img.data[i + 1] + img.data[i + 2]);
  }
  check(`${planetType} air has colour`, tintMax > 40, `brightest painted rgb sum ${tintMax}`);

  const frameCanvas = makeCanvas(VW, VH);
  const frameCtx = frameCanvas.getContext() as RecordingCtx;
  engine.frame({
    g: frameCtx as unknown as CanvasRenderingContext2D,
    dt: 1 / 60, elapsed: 1, bg: makeCanvas(VW, VH),
    drawFarSpace: () => {}, drawOverlays: () => {}, drawNearMoons: () => {},
    weatherMix: [],
  });
  check(`${planetType} frame composites`, frameCtx.putImageDataCalls === 0,
        `${frameCtx.putImageDataCalls} live putImageData`);

  if (planetType === 'gas') {
    // Gas fills the whole disc — no fluid occupancy holes.
    const waterPx = occupancy.reduce((a, b) => a + b, 0);
    check('gas has no water holes', waterPx === 0, `${waterPx} fluid px`);
    check('gas pick stamped', pick.some(v => v > 0), 'pick buffer');
  }

  if (planetType === 'lava' || planetType === 'desert' || planetType === 'ice'
      || planetType === 'carbon' || planetType === 'crystal') {
    const fluidPx = occupancy.reduce((a, b) => a + b, 0);
    const frac = fluidPx / faceArea;
    if (planetType === 'lava') {
      check('lava has magma fluid', frac > 0.08 && frac < 0.55, `frac=${frac.toFixed(3)}`);
    } else if (planetType === 'desert') {
      check('desert has little fluid', frac < 0.08, `frac=${frac.toFixed(3)}`);
    } else if (planetType === 'ice') {
      check('ice has thin seas', frac > 0.04 && frac < 0.35, `frac=${frac.toFixed(3)}`);
    } else if (planetType === 'carbon') {
      check('carbon has sparse fluid', frac < 0.18, `frac=${frac.toFixed(3)}`);
    } else if (planetType === 'crystal') {
      check('crystal has sparse fluid', frac > 0.02 && frac < 0.28, `frac=${frac.toFixed(3)}`);
    }
  }

  if (planetType === 'lava') {
    const sites = planVolcanoChimneys(opts);
    check('lava has volcano chimneys', sites.length >= 3, `${sites.length} chimneys`);
  }

  console.log('');
}

console.log(failures === 0
  ? `  all habitable cutaway checks passed\n`
  : `  ${failures} check(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
