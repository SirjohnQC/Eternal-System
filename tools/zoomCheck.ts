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

console.log('\n  CONTROLLER — pan, resize, supersede (Ruling 9 fix round 1)');
{
  const rect = { width: 1175, height: 783 };

  // (a) Pan gesture settles once, same as a wheel gesture. Panning only moves
  // the view when zoomed in (clamp() zeroes pan at zoom 1), so zoom in first.
  const cp = new ZoomController(rect, VW, VH);
  let tp = 0;
  cp.wheel(50, 50, -1, tp);
  tp += 5;
  cp.panStart(50, 50, tp);
  let rebakesDuringPan = 0;
  for (const dx of [10, 20, 30]) { tp += 20; cp.panMove(50 + dx, 50, tp); if (cp.tick(tp)) rebakesDuringPan++; }
  tp += SETTLE_MS + 50;                          // pointer still down, well past the settle delay
  const whilePanning = cp.tick(tp);
  cp.panEnd(tp);
  let rebakesAfterEnd = 0; let panCam: any = null;
  for (let k = 0; k < 20; k++) { tp += 16; const r = cp.tick(tp); if (r) { rebakesAfterEnd++; panCam = r; } }
  check('pan gesture settles once', rebakesDuringPan === 0 && whilePanning === null && rebakesAfterEnd === 1 && panCam !== null,
    `duringPan ${rebakesDuringPan}, whilePanning ${whilePanning}, afterEnd ${rebakesAfterEnd}`);
  cp.settled(panCam);
  check('  after pan settle: showCamera and css none', cp.showCamera === true && cp.cssTransform() === 'none',
    `showCamera ${cp.showCamera}, css ${cp.cssTransform()}`);
  // Control: bypassing the panning guard inside tick() re-bakes while the
  // pointer is still down, failing the "no re-bake while panning" bar.
  class NoPanGuard extends ZoomController { tick(t: number) { (this as any).panning = false; return super.tick(t); } }
  const npg = new NoPanGuard(rect, VW, VH);
  let tn = 0;
  npg.wheel(50, 50, -1, tn);
  tn += 5;
  npg.panStart(50, 50, tn);
  npg.panMove(70, 50, tn += 20);
  tn += SETTLE_MS + 50;
  const controlResult = npg.tick(tn);
  check('  control: no panning guard re-bakes while still panning', controlResult !== null, `${JSON.stringify(controlResult)}`);

  // (b) resize() mid-gesture keeps the zoom and re-clamps pan to the new rect;
  // the pending gesture still settles, now for the new size. A huge cursor
  // offset saturates the pan clamp deterministically at every zoom step.
  const rectA = { width: 1175, height: 783 };
  const rectB = { width: 900, height: 600 };
  const cr = new ZoomController(rectA, VW, VH);
  let tr = 0;
  for (let i = 0; i < 6; i++) { cr.wheel(10000, 10000, -1, tr); tr += 5; }
  const zBefore = cr.viewZoom;
  const boundA = (zBefore - 1) * rectA.width * 0.5;
  check('  setup: pan pinned to the rectA clamp bound', Math.abs(Math.abs(cr.panX) - boundA) < 1e-6, `panX ${cr.panX}, boundA ${boundA.toFixed(1)}`);
  cr.resize(rectB, VW, VH);
  const boundB = (zBefore - 1) * rectB.width * 0.5;
  check('resize mid-gesture keeps the zoom and re-clamps pan to the new rect',
    cr.viewZoom === zBefore && Math.abs(Math.abs(cr.panX) - boundB) < 1e-6,
    `zoom ${cr.viewZoom} (was ${zBefore.toFixed(3)}), panX ${cr.panX.toFixed(1)}, boundB ${boundB.toFixed(1)}`);
  let camAfterResize: any = null; let tr2 = tr;
  for (let k = 0; k < 20; k++) { tr2 += 16; const r = cr.tick(tr2); if (r) camAfterResize = r; }
  check('  next settle after resize issues a camera sized for the new rect',
    camAfterResize !== null && camAfterResize.fx >= -1 && camAfterResize.fx <= VW + 1 && camAfterResize.fy >= -1 && camAfterResize.fy <= VH + 1,
    JSON.stringify(camAfterResize));
  // Control: a resize() that forgets to re-clamp leaves pan beyond the new
  // rect's (smaller) bound.
  class NoReclampResize extends ZoomController {
    resize(rect2: { width: number; height: number }, vw: number, vh: number) {
      (this as any).rect = rect2; (this as any).VW = vw; (this as any).VH = vh; (this as any).issued = null; // bug: skips clamp()
    }
  }
  const badR = new NoReclampResize(rectA, VW, VH);
  let tb = 0;
  for (let i = 0; i < 6; i++) { badR.wheel(10000, 10000, -1, tb); tb += 5; }
  badR.resize(rectB, VW, VH);
  const boundBbad = (badR.viewZoom - 1) * rectB.width * 0.5;
  check('  control: resize without re-clamp leaves pan beyond the new rect bound', Math.abs(badR.panX) > boundBbad + 1e-6,
    `panX ${badR.panX.toFixed(1)}, boundB ${boundBbad.toFixed(1)}`);

  // (c) A settle for a superseded camera (a new gesture arrived between
  // tick() issuing it and settled() being called) must be ignored.
  const cs = new ZoomController(rect, VW, VH);
  let ts = 0;
  cs.wheel(50, 50, -1, ts);
  let camA: any = null;
  for (let k = 0; k < 20; k++) { ts += 16; const r = cs.tick(ts); if (r) camA = r; }
  check('  setup: first gesture settles to camera A', camA !== null, JSON.stringify(camA));
  cs.wheel(50, 50, -1, ts += 5);                  // a new gesture arrives before settled(camA) is applied
  cs.settled(camA);                               // stale — must be ignored
  check('superseded settle is ignored', cs.showCamera === false && cs.cssTransform() !== 'none',
    `showCamera ${cs.showCamera}, css ${cs.cssTransform()}`);
  // Control: a settled() that skips the supersede guard applies the stale
  // camera anyway.
  class NoSupersedeGuard extends ZoomController { settled(cam: any) { (this as any).cam = cam; (this as any).camShown = true; } }
  const ns = new NoSupersedeGuard(rect, VW, VH);
  let tn2 = 0;
  ns.wheel(50, 50, -1, tn2);
  let camB: any = null;
  for (let k = 0; k < 20; k++) { tn2 += 16; const r = ns.tick(tn2); if (r) camB = r; }
  ns.wheel(50, 50, -1, tn2 += 5);                 // new gesture supersedes
  ns.settled(camB);                               // bug: applies the stale camera unconditionally
  check('  control: settled() without the supersede guard shows the stale camera', ns.showCamera === true, `showCamera ${ns.showCamera}`);
}

console.log('\n  IDENTITY (Ruling 11: zoom 1 is byte-identical to the pre-change render)');
{
  const { renderLayers, hashImage, LAYERS } = await import('./zoomHarness');
  const goldens = (await import('./zoomGoldens.json')).default as Record<string, Record<string, string>>;
  for (const type of Object.keys(goldens)) {
    const got = renderLayers(type, 7);
    const differ = LAYERS.filter(l => hashImage(got[l]) !== goldens[type][l]);
    check(`${type}: all ${LAYERS.length} layers hash identical to the goldens`, differ.length === 0,
      differ.length ? `differ: ${differ.join(', ')}` : `${LAYERS.length}/${LAYERS.length}`);
    if (type !== 'gas') {  // gas never reads rimFalloff
      const c = renderLayers(type, 7, { rimPerturb: 0.02 });
      const cd = LAYERS.filter(l => hashImage(c[l]) !== goldens[type][l]);
      check(`  control: ${type} rimFalloff + 0.02 differs from the goldens`, cd.length > 0, `differ: ${cd.join(', ')}`);
    }
  }
}

console.log('\n  SUB-CELL (elevationAt is continuous and interpolates the same data)');
{
  const { makeDiscToGrid, makeDiscToGridF, makeElevationAt, makeElevationAtGrid, smoothElevation, computeFocus } = await import('./zoomHarness');
  const { generatePlanetGrid, GRID_SIZE } = await import('../src/simulation/PlanetGrid');
  let s = 12345;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  type Sampler = (dx: number, dy: number) => number | null;
  type ToF = (dx: number, dy: number) => { row: number; col: number } | null;
  const gridDist = (p: { row: number; col: number }, q: { row: number; col: number }) => {
    let dc = Math.abs(p.col - q.col); if (dc > GRID_SIZE / 2) dc = GRID_SIZE - dc;
    return Math.hypot(p.row - q.row, dc);
  };
  /**
   * Largest step between consecutive samples of `a` and of `b` along 200
   * random lines across the face, one sample every 0.25 cell (grid units).
   */
  const walk = (toF: ToF, a: Sampler, b: Sampler, lines = 200, samples = 48) => {
    let maxA = 0, maxB = 0;
    for (let l = 0; l < lines; l++) {
      const r0 = Math.sqrt(rnd()) * 0.8, t0 = rnd() * Math.PI * 2, dir = rnd() * Math.PI * 2;
      let x = r0 * Math.cos(t0), y = r0 * Math.sin(t0);
      const ux = Math.cos(dir), uy = Math.sin(dir);
      let pa: number | null = null, pb: number | null = null;
      for (let k = 0; k < samples; k++) {
        if (Math.hypot(x, y) > 0.97) break;
        const va = a(x, y), vb = b(x, y);
        if (va === null || vb === null) break;
        if (pa !== null && pb !== null) { maxA = Math.max(maxA, Math.abs(va - pa)); maxB = Math.max(maxB, Math.abs(vb - pb)); }
        pa = va; pb = vb;
        // Disc step that moves 0.25 of a cell in grid units, from the local scale.
        const h = 1e-4, p = toF(x, y), q = toF(x + ux * h, y + uy * h);
        if (!p || !q) break;
        const step = 0.25 * h / Math.max(1e-12, gridDist(p, q));
        x += ux * step; y += uy * step;
      }
    }
    return { maxA, maxB };
  };
  for (const type of ['ocean', 'lava']) {
    const grid = generatePlanetGrid(type, 7 * 7777, null, null);
    const f = computeFocus(grid);
    const toF = makeDiscToGridF(f.lat, f.lon), toN = makeDiscToGrid(f.lat, f.lon);
    const sub = makeElevationAt(grid, f.lat, f.lon);
    const nearest: Sampler = (dx, dy) => { const g = toN(dx, dy); return g ? smoothElevation(grid, g.row, g.col) : null; };
    const w = walk(toF, sub, nearest);
    const ratio = w.maxA / w.maxB;
    check(`${type}: largest elevationAt step <= 0.3x nearest-cell step`, ratio <= 0.3,
      `ratio ${ratio.toFixed(3)} (sub-cell ${w.maxA.toFixed(4)}, nearest ${w.maxB.toFixed(4)})`);
    // At cell centres (row i, col j + 0.5) it returns the nearest-cell smoothed value.
    const atGrid = makeElevationAtGrid(grid);
    let worst = 0;
    const at = (i: number, j: number) => { worst = Math.max(worst, Math.abs(atGrid(i, j + 0.5) - smoothElevation(grid, i, j))); };
    for (let i = 0; i < GRID_SIZE; i += 3) for (let j = 0; j < GRID_SIZE; j += 3) at(i, j);
    for (const i of [0, GRID_SIZE - 1]) for (const j of [0, GRID_SIZE - 1]) at(i, j);
    check(`${type}: elevationAt at cell centres equals smoothElevation`, worst <= 1e-9, `worst ${worst.toExponential(1)}`);
    // Control: the nearest-cell sampler measured against itself (ratio 1.0).
    const c = walk(toF, nearest, nearest);
    const cr = c.maxA / c.maxB;
    check(`  control: ${type} nearest vs itself fails the 0.3x bar`, !(cr <= 0.3), `ratio ${cr.toFixed(3)}`);
  }
}

console.log('\n  CAMERA LAYERS (Task 4: crust, surface, shore, pick under a camera)');
{
  const H = await import('./zoomHarness');
  const { bakeEngine, PixelCanvas, liftOf, smoothElevation, MAX_LIFT } = H;
  const Eng = await import('../src/rendering/HabitableCutawayEngine');
  const { classifyBiome, isWater } = await import('../src/simulation/PlanetGrid');
  type PC = InstanceType<typeof PixelCanvas>;
  const alphaAt = (c: PC, x: number, y: number) =>
    (x < 0 || y < 0 || x >= c.width || y >= c.height) ? 0 : c.data[(y * c.width + x) * 4 + 3];
  const rgbaAt = (c: PC, x: number, y: number) => {
    const o = (y * c.width + x) * 4; return `${c.data[o]},${c.data[o + 1]},${c.data[o + 2]},${c.data[o + 3]}`;
  };
  const firstRow = (c: PC, x: number) => { for (let y = 0; y < c.height; y++) if (alphaAt(c, x, y)) return y; return -1; };
  const lastRow = (c: PC, x: number) => { for (let y = c.height - 1; y >= 0; y--) if (alphaAt(c, x, y)) return y; return -1; };
  const camSetOf = (e: any) => e.camSet as { crust: PC; land: PC; geom: any; opts: any; pick: Int32Array };
  const fresh = () => new PixelCanvas(VW, VH);
  const ctx = (c: PC) => c.getContext() as unknown as CanvasRenderingContext2D;
  const tierMin: Record<number, number> = { 18: 0.80, 13: 0.70, 9: 0.62, 6: 0.54 };

  // ── relief scales ────────────────────────────────────────────────────────
  {
    const B = bakeEngine('ocean', 7);
    const e = B.engine as any, g = B.engine.geom, land1 = e.land as PC;
    // Fixture (independent of the painter): nearest-cell tier of each face pixel.
    const faceAt = (gm: any, px: number, py: number) => {
      const dx = (px - gm.cx) / gm.rx, dy = (py - gm.cyTop) / gm.ry, r = Math.hypot(dx, dy);
      return r > 1 ? null : { dx, dy, r };
    };
    const tier1 = (px: number, py: number) => {
      const f = faceAt(g, px, py); if (!f) return -1;
      const gp = B.discToGrid(f.dx, f.dy); if (!gp) return -1;
      const cell = B.grid[gp.row][gp.col];
      if (isWater(classifyBiome(cell.elevation - B.rim(f.r), cell.moisture, cell.temperature, 'ocean'))) return -1;
      return liftOf(smoothElevation(B.grid, gp.row, gp.col) - B.rim(f.r));
    };
    let maxTier = 0;
    for (let py = g.cyTop - g.ry; py <= g.cyTop + g.ry; py++)
      for (let px = g.cx - g.rx; px <= g.cx + g.rx; px++) maxTier = Math.max(maxTier, tier1(px, py));
    let best: { X: number; Yf: number; T: number } | null = null;
    for (let X = g.cx - g.rx; X <= g.cx + g.rx; X++) {
      let Yf = -1;
      for (let py = g.cyTop - g.ry; py <= g.cyTop + g.ry; py++) if (tier1(X, py) === maxTier) { Yf = py; break; }
      if (Yf < 0) continue;
      const T = firstRow(land1, X);
      if (Yf - T === maxTier && (!best || T < best.T)) best = { X, Yf, T };
    }
    if (!best) { check('relief: found a peak column at zoom 1', false, `maxTier ${maxTier}`); }
    else {
      const lift1 = best.Yf - best.T;
      const cam = { zoom: 4, fx: best.X, fy: best.Yf - Math.round(maxTier / 2) };
      B.engine.setCamera(cam);
      const cs = camSetOf(e);
      const measure = (land: PC, gm: any) => {
        const sx = (best!.X - cam.fx) * 4 + VW / 2;
        let Yf4 = -1;
        for (let sy = 0; sy < VH; sy++) {
          const f = faceAt(gm, sx, sy); if (!f) continue;
          const el = B.elevationAt(f.dx, f.dy); if (el === null) continue;
          if (el - B.rim(f.r) > tierMin[maxTier]) { Yf4 = sy; break; }
        }
        return Yf4 - firstRow(land, sx);
      };
      const lift4 = measure(cs.land, cs.geom);
      check('relief: the peak lift at zoom 4 is 4x zoom 1 (+/- 1 px)', Math.abs(lift4 - 4 * lift1) <= 1,
        `peak x ${best.X}: zoom-1 lift ${lift1}, zoom-4 lift ${lift4}, ratio ${(lift4 / lift1).toFixed(3)}`);
      // Control: the same camera bake with the lift wrapper disabled (base liftOf / maxLift).
      const c = fresh();
      Eng.paintCutawaySurface(ctx(c), { ...cs.opts, liftOf, maxLift: MAX_LIFT,
        occupancy: new Uint8Array(VW * VH), pick: new Int32Array(VW * VH) });
      const liftC = measure(c, cs.geom);
      check('  control: unwrapped liftOf fails the 4x bar', !(Math.abs(liftC - 4 * lift1) <= 1), `lift ${liftC}`);
    }
  }

  // ── crust depth scales (the KEEL, at mid-body) ──────────────────────────
  {
    const B = bakeEngine('ocean', 7);
    const e = B.engine as any, g = B.engine.geom, crust1 = e.crust as PC;
    // Mid-body columns, where the keel hangs deepest: 20 columns centred on
    // the body. At zoom 2 a full column (rim -> keel bottom, ~130 px at zoom 1)
    // fits the 320-px canvas.
    const a = g.cx - 10, bEnd = g.cx + 9, z = 2;
    let top = 1e9, bot = -1;
    for (let X = a; X <= bEnd; X++) { top = Math.min(top, firstRow(crust1, X)); bot = Math.max(bot, lastRow(crust1, X)); }
    const cam = { zoom: z, fx: g.cx, fy: Math.round((top + bot) / 2) };
    B.engine.setCamera(cam);
    const cs = camSetOf(e);
    const ext = (c: PC, X: number) => { const f = firstRow(c, X), l = lastRow(c, X); return f < 0 ? 0 : l - f + 1; };
    const run = (c: PC) => {
      let s1 = 0, s2 = 0, worst = 0, n = 0, clipped = 0;
      for (let X = a; X <= bEnd; X++) {
        const sx = (X - cam.fx) * z + VW / 2;
        if (firstRow(c, sx) === 0 || lastRow(c, sx) === VH - 1) clipped++;
        const e1 = ext(crust1, X), e2 = ext(c, sx);
        s1 += e1; s2 += e2; n++; worst = Math.max(worst, Math.abs(e2 - z * e1));
      }
      return { m1: s1 / n, m2: s2 / n, worst, n, clipped };
    };
    const r = run(cs.crust);
    const keel1 = r.m1 - g.wall;
    check('crust: mid-body columns are keel-dominated and wholly in view at zoom 2', keel1 >= 20 && r.clipped === 0,
      `zoom-1 mean depth ${r.m1.toFixed(2)} = wall ${g.wall} + keel/ridge ${keel1.toFixed(2)}, clipped columns ${r.clipped}`);
    check('crust: mean column depth at zoom 2 is 2x zoom 1 (+/- 1 px)', Math.abs(r.m2 - z * r.m1) <= 1,
      `${r.n} columns x ${a}-${bEnd}: zoom-1 ${r.m1.toFixed(2)}, zoom-2 ${r.m2.toFixed(2)}, ratio ${(r.m2 / r.m1).toFixed(3)}, worst column |d| ${r.worst}`);
    // Control: the same camera bake with the keel depth NOT scaled (crustDepthOf(base rx)).
    const c = fresh();
    Eng.paintCutawayCrust(ctx(c), { ...cs.opts, crustDepthPx: Eng.crustDepthOf(g.rx), occupancy: new Uint8Array(VW * VH) });
    const rc = run(c);
    check('  control: unscaled keel depth fails the 2x bar', !(Math.abs(rc.m2 - z * rc.m1) <= 1), `zoom-2 ${rc.m2.toFixed(2)} vs ${(z * rc.m1).toFixed(2)}`);
    // Control: the geometry bypass (no `wall` in the opts -> habitableGeom's base wall).
    const c2 = fresh();
    Eng.paintCutawayCrust(ctx(c2), { ...cs.opts, wall: undefined, occupancy: new Uint8Array(VW * VH) });
    const rw = run(c2);
    check('  control: base-wall fallback fails the 2x bar', !(Math.abs(rw.m2 - z * rw.m1) <= 1), `zoom-2 ${rw.m2.toFixed(2)} vs ${(z * rw.m1).toFixed(2)}`);
  }

  // ── view edges: face rim below the canvas, face wholly above it ─────────
  {
    const B = bakeEngine('ocean', 7);
    const eng = B.engine, e = eng as any, g = eng.geom, land1 = e.land as PC;
    // A camera at zoom 4 whose face top (the far rim, centre column) sits 2 px
    // BELOW the canvas: only lifted ground from below-canvas rows can show.
    // Pick the column whose zoom-1 relief rises highest above the face top.
    let bestX = g.cx, bestT = 1e9;
    for (let X = g.cx - g.rx; X <= g.cx + g.rx; X++) { const t = firstRow(land1, X); if (t >= 0 && t < bestT) { bestT = t; bestX = X; } }
    const z = 4, faceTop = Math.ceil(g.cyTop - g.ry);
    const fy = faceTop - (VH + 2 - VH / 2) / z;
    const camA = { zoom: z, fx: g.cx, fy: g.cyTop };               // a normal view first: fills the pick
    eng.setCamera(camA);
    const pickA = e.camSet.pick.slice();
    const camB = { zoom: z, fx: Math.round(bestX * z) / z, fy };
    eng.setCamera(camB);
    const cs = camSetOf(e);
    const faceTopB = Math.ceil(cs.geom.cyTop - cs.geom.ry);
    let lit = 0;
    for (let i = 3; i < cs.land.data.length; i += 4) if (cs.land.data[i]) lit++;
    check('view edge: face top below the canvas, lifted peaks still show', faceTopB >= VH && lit > 0,
      `zoom-1 highest land row ${bestT} (face top ${faceTop}); camera face top at screen ${faceTopB}; ${lit} land px in view`);
    // Control: the same bake without the relief margin (maxLift 0 -> rows below the canvas unscanned).
    const cm = fresh();
    Eng.paintCutawaySurface(ctx(cm), { ...cs.opts, maxLift: 0, occupancy: new Uint8Array(VW * VH), pick: new Int32Array(VW * VH) });
    let litC = 0;
    for (let i = 3; i < cm.data.length; i += 4) if (cm.data[i]) litC++;
    check('  control: no relief margin shows nothing', litC === 0, `${litC} land px`);
    // Pick holds only what this camera drew: every picked pixel is drawn land or water.
    const stale = (p: Int32Array) => { let n = 0; for (let i = 0; i < p.length; i++) if (p[i] && !cs.land.data[i * 4 + 3] && !cs.occupancy[i]) n++; return n; };
    check('view edge: the pick holds no cell from the previous camera', stale(cs.pick) === 0, `${stale(cs.pick)} stale px`);
    check('  control: the previous camera pick fails the same test', stale(pickA) > 0, `${stale(pickA)} stale px`);
    // Face wholly above the view: no throw (browsers throw on createImageData(w, 0)).
    let threw = '';
    try { eng.setCamera({ zoom: z, fx: g.cx, fy: g.cyTop + g.ry + 45 }); } catch (err) { threw = String(err); }
    const csUp = camSetOf(e);
    const pickedUp = threw ? -1 : csUp.pick.reduce((n: number, v: number) => n + (v ? 1 : 0), 0);
    check('view edge: face wholly above the view bakes without throwing, empty pick', !threw && pickedUp === 0,
      threw || `face bottom at screen ${Math.floor(csUp.geom.cyTop + csUp.geom.ry)}, ${pickedUp} picked px`);
    let shimThrows = false;
    try { ctx(fresh()).createImageData(10, 0); } catch { shimThrows = true; }
    check('  control: the canvas shim throws on an empty image, as browsers do', shimThrows, '');
  }

  // ── world-anchored hashes ────────────────────────────────────────────────
  {
    const B = bakeEngine('ocean', 7);
    const e = B.engine as any, g = B.engine.geom;
    const z = 2;
    const layersAt = (cam: { zoom: number; fx: number; fy: number }, broken: boolean) => {
      B.engine.setCamera(cam);
      const cs = camSetOf(e);
      if (!broken) return { land: cs.land, crust: cs.crust };
      // Control: the camera bake with its world mapping replaced by identity,
      // i.e. hashes keyed on screen px (the pre-change keying).
      const id = { zoom: 1, fx: VW / 2, fy: VH / 2 };
      const land = fresh(), crust = fresh();
      Eng.paintCutawayCrust(ctx(crust), { ...cs.opts, camera: id, occupancy: new Uint8Array(VW * VH) });
      Eng.paintCutawaySurface(ctx(land), { ...cs.opts, camera: id, occupancy: new Uint8Array(VW * VH), pick: new Int32Array(VW * VH) });
      return { land, crust };
    };
    const compare = (layer: 'land' | 'crust', A: any, Bc: any, broken: boolean) => {
      const la = layersAt(A, broken)[layer].data.slice(), lb = layersAt(Bc, broken)[layer].data.slice();
      const ca = { width: VW, height: VH, data: la } as unknown as PC, cb = { width: VW, height: VH, data: lb } as unknown as PC;
      let s = 99, n = 0, same = 0, tries = 0;
      const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
      while (n < 50 && tries++ < 200000) {
        const wx = Math.floor(g.cx - g.rx + rnd() * 2 * g.rx), wy = Math.floor(g.cyTop - g.ry + rnd() * (2 * g.ry + g.wall + 60));
        const pa = worldToScreen(A, VW, VH, wx, wy), pb = worldToScreen(Bc, VW, VH, wx, wy);
        const inb = (p: { x: number; y: number }) => p.x >= 25 && p.y >= 25 && p.x < VW - 25 && p.y < VH - 25;
        if (!inb(pa) || !inb(pb)) continue;
        if (!alphaAt(ca, pa.x, pa.y) || !alphaAt(cb, pb.x, pb.y)) continue;
        n++;
        if (rgbaAt(ca, pa.x, pa.y) === rgbaAt(cb, pb.x, pb.y)) same++;
      }
      return { n, same };
    };
    const Af = { zoom: z, fx: g.cx - 20, fy: g.cyTop }, Bf = { zoom: z, fx: g.cx + 15, fy: g.cyTop + 10 };
    const Ac = { zoom: z, fx: g.cx - 20, fy: g.cyTop + g.ry + 20 }, Bcr = { zoom: z, fx: g.cx + 10, fy: g.cyTop + g.ry + 30 };
    const sf = compare('land', Af, Bf, false), sc = compare('crust', Ac, Bcr, false);
    check('world-anchored: surface colour at 50 world points is the same after a pan', sf.n === 50 && sf.same === sf.n, `${sf.same}/${sf.n} identical`);
    check('world-anchored: crust colour at 50 world points is the same after a pan', sc.n === 50 && sc.same === sc.n, `${sc.same}/${sc.n} identical`);
    const cf = compare('land', Af, Bf, true), cc = compare('crust', Ac, Bcr, true);
    check('  control: px-keyed surface grain differs after a pan', cf.same < cf.n, `${cf.same}/${cf.n} identical`);
    check('  control: px-keyed crust differs after a pan', cc.same < cc.n, `${cc.same}/${cc.n} identical`);
  }

  // ── pick agrees ──────────────────────────────────────────────────────────
  {
    const B = bakeEngine('ocean', 7);
    const eng = B.engine, g = eng.geom;
    const pick1 = eng.pick.slice();
    const id1 = (x: number, y: number) => pick1[y * VW + x];
    // "Ignoring points within 1 px (zoom 1) of a cell boundary". A grid cell is
    // ~1.6 x 0.9 px at zoom 1, so every pixel is within 1 px of a cell-id change
    // in the pick buffer (a literal screen-space filter keeps 0 of ~200k
    // candidates, measured). What a camera legitimately re-resolves is the
    // STRUCTURE boundary in face space: at a terrace lip or a coast, which face
    // row owns a pixel depends on sub-pixel sampling (the zoomed bake samples
    // face rows between the base rows, and sub-cell elevation moves the edge).
    // So a point is a boundary point when the face samples that draw within
    // 1 px of it (rows every 1/4 px, columns +/- 1 px, nearest-cell AND
    // sub-cell) do not all share one land/water class and lift tier.
    const { classifyBiome: cls, isWater: wat } = await import('../src/simulation/PlanetGrid');
    const sample = (x: number, t: number, sub: boolean): string | null => {
      const dx = (x - g.cx) / g.rx, dy = (t - g.cyTop) / g.ry, r = Math.hypot(dx, dy);
      if (r > 1) return null;
      const gp = B.discToGrid(dx, dy); if (!gp) return null;
      const cell = B.grid[gp.row][gp.col], rim = B.rim(r);
      let biome = cls(cell.elevation - rim, cell.moisture, cell.temperature, 'ocean');
      let e = smoothElevation(B.grid, gp.row, gp.col);
      if (sub) {
        const f = B.elevationAt(dx, dy);
        if (f !== null) {
          const bf = cls(f - rim, cell.moisture, cell.temperature, 'ocean');
          if (wat(bf) || wat(biome)) biome = bf;
          e = f;
        }
      }
      return wat(biome) ? 'w' : `l${liftOf(e - rim)}`;
    };
    const nearBoundary = (wx: number, wy: number) => {
      // Samples that draw within 1 px of W, plus every sample up to 1 px in
      // front of the nearest of them (a terrace lip or coast just in front of
      // the owning row decides, at sub-pixel resolution, which row owns W).
      const vals: Array<[number, string, number]> = [];
      let tMax = -Infinity;
      for (let x = wx - 1; x <= wx + 1; x++) for (const sub of [false, true])
        for (let t = wy - 1; t <= wy + MAX_LIFT + 1; t += 0.25) {
          const v = sample(x, t, sub); if (v === null) continue;
          const top = v === 'w' ? t : t - Number(v.slice(1));
          vals.push([t, v, top]);
          if (top <= wy + 1 && v !== 'w') tMax = Math.max(tMax, t);
        }
      const front = Math.max(wy + 1, tMax + 1);
      let seen: string | null = null;
      for (const [t, v, top] of vals) {
        if (top > wy + 1 && t > front) continue;
        if (seen === null) seen = v; else if (v !== seen) return true;
      }
      return false;
    };
    const cellOf = (id: number) => id > 0 ? { row: Math.floor((id - 1) / 256), col: (id - 1) % 256 } : null;
    /**
     * 20 cameras at zoom z (fixed-seed draws). Interiors: 10 points per camera
     * off every relief/coast boundary must match exactly (200). Boundaries
     * (Ruling 16): the first 40 candidates per camera, boundary or not (800);
     * every miss is (a) a face-space boundary point, (b) within `maxLift`
     * expressed in face rows of the zoom-1 cell — at a cliff the exposed
     * terrain can legitimately be up to the lift height behind — and (c) in
     * the same screen column +/- 1 px. The pooled exact rate is printed only.
     * `broken`: the camera surface re-painted with the base (unwrapped) liftOf.
     */
    const toF = H.makeDiscToGridF(B.focus.lat, B.focus.lon);
    /** maxLift (world px; maxLift * k screen px) expressed in face rows at W's column. */
    const liftRows = (wx: number, wy: number) => {
      const dx = (wx - g.cx) / g.rx;
      const at = (t: number) => { const d = Math.hypot(dx, (t - g.cyTop) / g.ry); return d > 1 ? null : toF(dx, (t - g.cyTop) / g.ry); };
      let lo: number | null = null, hi: number | null = null;
      for (let t = wy - 1; t <= wy + MAX_LIFT + 1; t += 0.25) { const f = at(t); if (!f) continue; if (lo === null) lo = f.row; hi = f.row; }
      return lo === null || hi === null ? 0 : Math.ceil(Math.abs(hi - lo));
    };
    const runPick = (z: number, broken: boolean) => {
      let s = 4242 + z;
      const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
      let n = 0, agree = 0, ctrlAgree = 0, skipped = 0, un = 0, unAgree = 0, unBad = 0, worstRows = 0, worstCols = 0, offBoundary = 0;
      let worstRatio = 0, worstBound = 0, outsideFaceCols = 0, overBound = 0;
      for (let camI = 0; camI < 20; camI++) {
        const cam = { zoom: z, fx: Math.round((g.cx + (rnd() - 0.5) * g.rx) * z) / z, fy: Math.round((g.cyTop + (rnd() - 0.5) * g.ry) * z) / z };
        eng.setCamera(cam);
        if (broken) {
          const cs = (eng as any).camSet;
          cs.opts = { ...cs.opts, liftOf, maxLift: MAX_LIFT };
          (eng as any).paintCameraSurface(cs);
        }
        eng.showCamera = true;
        let got = 0, unCam = 0, tries = 0;
        while ((got < 10 || unCam < 40) && tries++ < 100000) {
          const p = { x: Math.floor(rnd() * VW), y: Math.floor(rnd() * VH) };
          const w = screenToWorld(cam, VW, VH, p.x, p.y);
          const wx = Math.round(w.x), wy = Math.round(w.y);
          if (wx < 1 || wy < 1 || wx >= VW - 1 || wy >= VH - 1 || !id1(wx, wy)) continue;
          const sp = worldToScreen(cam, VW, VH, wx, wy);
          if (sp.x < 0 || sp.y < 0 || sp.x >= VW || sp.y >= VH) continue;
          const want = id1(wx, wy), seenId = eng.pick[Math.round(sp.y) * VW + Math.round(sp.x)];
          const nb = nearBoundary(wx, wy);
          if (unCam < 40) {
            unCam++; un++;
            if (seenId === want) unAgree++;
            else {
              const a = cellOf(want)!, c = cellOf(seenId);
              let dc = c ? Math.abs(c.col - a.col) : 999; if (dc > 128) dc = 256 - dc;
              const dr = c ? Math.abs(c.row - a.row) : 999;
              const bound = liftRows(wx, wy);
              worstRows = Math.max(worstRows, dr); worstCols = Math.max(worstCols, dc);
              if (dr / Math.max(1, bound) > worstRatio) { worstRatio = dr / Math.max(1, bound); worstBound = bound; }
              if (!nb) offBoundary++;
              // (c) same SCREEN column +/- 1 px: the cell is one the zoom-1
              // projection samples in face columns wx +/- 1 over the lift span.
              // (The pick is written per screen column; grid columns converge
              // near the grid pole, so +/- 1 GRID column is the wrong measure.)
              const set = new Set<number>();
              for (let x = wx - 1; x <= wx + 1; x++) for (let t = wy - 1; t <= wy + MAX_LIFT + 1; t += 0.25) {
                const gp = B.discToGrid((x - g.cx) / g.rx, (t - g.cyTop) / g.ry); if (gp) set.add(gp.row * 256 + gp.col + 1);
              }
              const inCols = set.has(seenId);
              if (!inCols) outsideFaceCols++;
              if (dr > bound) overBound++;
              if (!(nb && dr <= bound && inCols)) unBad++;
            }
          }
          if (nb) { skipped++; continue; }
          if (got >= 10) continue;
          got++; n++;
          if (JSON.stringify(eng.hitTest(Math.round(sp.x), Math.round(sp.y))) === JSON.stringify(cellOf(want))) agree++;
          // Control: the same point looked up without mapping through the camera.
          if (JSON.stringify(eng.hitTest(wx, wy)) === JSON.stringify(cellOf(want))) ctrlAgree++;
        }
        eng.showCamera = false;
      }
      return { n, agree, ctrlAgree, skipped, un, unAgree, unBad, worstRows, worstCols, offBoundary, worstRatio, worstBound, outsideFaceCols, overBound };
    };
    for (const z of [2, 4]) {
      const r = runPick(z, false);
      check(`pick at zoom ${z} returns the zoom-1 cell at 200 world points`, r.n === 200 && r.agree === r.n,
        `${r.agree}/${r.n} agree (${r.skipped} relief/coast boundary candidates skipped)`);
      const unDetail = (q: typeof r) =>
        `pooled ${q.unAgree}/${q.un} exact (${(100 * q.unAgree / q.un).toFixed(1)}%, info); ${q.un - q.unAgree} misses: ${q.offBoundary} off a boundary, ${q.overBound} beyond the row bound, ${q.outsideFaceCols} outside the screen column +/- 1 px -> ${q.unBad} failing; worst row/bound ${q.worstRatio.toFixed(2)} (bound ${q.worstBound})`;
      check(`pick at zoom ${z}, unfiltered (Ruling 16): every miss on a boundary, within the lift rows, same screen column`,
        r.un === 800 && r.unBad === 0, unDetail(r));
      check(`  control: zoom ${z} pick without the camera mapping disagrees`, r.ctrlAgree < r.n, `${r.ctrlAgree}/${r.n} agree`);
      const b = runPick(z, true);
      check(`  control: zoom ${z} pick with the unwrapped liftOf fails the exact bar`, !(b.n === 200 && b.agree === b.n),
        `${b.agree}/${b.n} agree`);
      check(`  control: zoom ${z} pick with the unwrapped liftOf fails the Ruling 16 bar`,
        !(b.un === 800 && b.unBad === 0), unDetail(b));
    }
  }

  // ── bounded bakes ────────────────────────────────────────────────────────
  {
    const it = ((globalThis as any).__zoomIters = {} as Record<string, number>);
    const B = bakeEngine('ocean', 7);
    const id = { ...it };
    const bound = VW * (VH + MAX_LIFT * 4);
    const g0 = B.engine.geom;
    B.engine.setCamera({ zoom: 4, fx: g0.cx, fy: g0.cyTop + g0.ry + Math.round(g0.wall / 2) });
    const crust4 = it.crust;
    B.engine.setCamera({ zoom: 4, fx: g0.cx, fy: g0.cyTop });
    const z4 = { ...it, crust: crust4 };
    for (const k of ['surface', 'crust', 'shore']) {
      check(`bounded: ${k} iterations at zoom 4 <= VW*(VH+maxLift*4)`, z4[k] > 0 && z4[k] <= bound,
        `zoom 4 ${z4[k]}, bound ${bound}, zoom 1 ${id[k]} (x${(z4[k] / id[k]).toFixed(2)} of zoom 1)`);
    }
    // Control: the same zoom-4 surface bake on a canvas big enough to hold the
    // whole camera geometry — i.e. the loop bounded by the geometry, not the view.
    const cs = camSetOf(B.engine as any), gm = cs.geom;
    const W = Math.ceil(2 * gm.rx) + 1, Hh = Math.ceil(2 * gm.ry) + 1 + cs.opts.maxLift;
    const big = new PixelCanvas(W, Hh);
    Eng.paintCutawaySurface(ctx(big), { ...cs.opts, w: W, h: Hh, cx: gm.rx, cyTop: gm.ry + cs.opts.maxLift,
      occupancy: new Uint8Array(W * Hh), pick: new Int32Array(W * Hh), decalSites: [] });
    check('  control: an unclamped zoom-4 surface loop exceeds the bound', it.surface > bound, `${it.surface} > ${bound}`);
    console.log(`        shore passes at zoom 4: scan ${z4.shoreScan}, BFS ${z4.shoreBfs}, blur ${z4.shoreBlur} per pass (zoom 1: ${id.shoreScan}, ${id.shoreBfs}, ${id.shoreBlur})`);
    // Control: the shore bake with a margin reaching the whole camera geometry
    // instead of FOAM_REACH * k — the view no longer bounds it.
    const m = Math.ceil(Math.max(gm.rx, gm.ry));
    Eng.bakeShoreDistance(cs.occupancy, gm, VW, VH, m, () => false, 4);
    check('  control: an unclamped zoom-4 shore bake exceeds the bound', it.shore > bound, `${it.shore} > ${bound}`);
    delete (globalThis as any).__zoomIters;
  }

  // ── state kept ───────────────────────────────────────────────────────────
  {
    const B = bakeEngine('ocean', 7);
    const e = B.engine as any;
    const noop = () => {};
    const frameC = fresh();
    for (let i = 0; i < 3; i++) B.engine.frame({ g: ctx(frameC), dt: 0.5, elapsed: 10 + i, sunAzimuth: 0.6, viewZoom: 1,
      drawBackdrop: noop, drawFarSpace: noop, drawSurfaceOverlays: noop, drawUiOverlays: noop, drawNearMoons: noop });
    const sim = e.weatherSim, cloud = Float32Array.from(sim.cloud), elapsed = e.elapsed;
    B.engine.setCamera({ zoom: 3, fx: 200, fy: 150 });
    const same = e.weatherSim === sim && e.elapsed === elapsed && sim.cloud.every((v: number, i: number) => v === cloud[i]);
    check('state: setCamera keeps the weather sim, its clouds and elapsed', same && e.camSet !== null, `sim kept ${e.weatherSim === sim}, elapsed ${e.elapsed}`);
    B.engine.bake({ w: VW, h: VH, seed: 7, grid: B.grid, planetType: 'ocean', discToGrid: B.discToGrid, rimFalloff: B.rim,
      liftOf, smoothElevation, elevationAt: B.elevationAt, maxLift: MAX_LIFT, lush: 0.6, decalSeed: 7, decalAtlas: null,
      weather: (e.weatherPainter as any)?.climate ?? null });
    check('  control: bake() replaces the sim and resets the camera', e.weatherSim !== sim && e.camSet === null && isIdentity(B.engine.camera, VW, VH),
      `sim replaced ${e.weatherSim !== sim}, camera ${JSON.stringify(B.engine.camera)}`);
  }
}

console.log('\n  FRAME LAYERS (Task 5: water, day/night, atmosphere, weather, vignette, gas rings under the camera)');
{
  const H = await import('./zoomHarness');
  const { bakeEngine, renderLayers, PixelCanvas, PixelCtx, MAX_LIFT } = H;
  const Eng = await import('../src/rendering/HabitableCutawayEngine');
  const WP = await import('../src/rendering/weather/WeatherPainter');
  const { WX_NX } = await import('../src/rendering/weather/WeatherClimate');
  type Img = Uint8ClampedArray;
  const noop = () => {};
  const frameOf = (eng: any, g: any, over: Record<string, unknown> = {}) => eng.frame({
    g, dt: H.DT, elapsed: H.ELAPSED, sunAzimuth: H.SUN_AZ, viewZoom: 1,
    drawBackdrop: noop, drawFarSpace: noop, drawSurfaceOverlays: noop, drawUiOverlays: noop, drawNearMoons: noop, ...over,
  });

  /**
   * Mean length of straight crack runs ("stair steps") of a class image. A
   * crack is the edge between two 4-neighbours of different class (class -1 =
   * not part of the feature, never cracks). Vertical cracks chain along y,
   * horizontal cracks along x; a run is a maximal chain. A crack only counts
   * where one of its two pixels is `keep` (non-empty at zoom 1); runs touching
   * the canvas border are dropped (truncated). A 4x nearest-neighbour
   * magnification can only have runs that are multiples of 4.
   */
  const stairRuns = (cls: (x: number, y: number) => number, keep: (x: number, y: number) => boolean) => {
    const W = VW, Hh = VH;
    const C = new Int8Array(W * Hh), K = new Uint8Array(W * Hh);
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) { C[y * W + x] = cls(x, y); K[y * W + x] = keep(x, y) ? 1 : 0; }
    const crackV = (x: number, y: number) => {   // between (x,y) and (x+1,y)
      const a = C[y * W + x], b = C[y * W + x + 1];
      return a >= 0 && b >= 0 && a !== b && (K[y * W + x] || K[y * W + x + 1]);
    };
    const crackH = (x: number, y: number) => {   // between (x,y) and (x,y+1)
      const a = C[y * W + x], b = C[(y + 1) * W + x];
      return a >= 0 && b >= 0 && a !== b && (K[y * W + x] || K[(y + 1) * W + x]);
    };
    let total = 0, runs = 0;
    for (let x = 0; x < W - 1; x++) {
      let len = 0, start = 0;
      for (let y = 0; y <= Hh; y++) {
        if (y < Hh && crackV(x, y)) { if (len === 0) start = y; len++; continue; }
        if (len > 0 && start > 0 && y < Hh && x > 0 && x < W - 2) { total += len; runs++; }
        len = 0;
      }
    }
    for (let y = 0; y < Hh - 1; y++) {
      let len = 0, start = 0;
      for (let x = 0; x <= W; x++) {
        if (x < W && crackH(x, y)) { if (len === 0) start = x; len++; continue; }
        if (len > 0 && start > 0 && x < W && y > 0 && y < Hh - 2) { total += len; runs++; }
        len = 0;
      }
    }
    return { mean: runs ? total / runs : 0, runs, cracks: total };
  };
  const A = (d: Img, x: number, y: number) => d[(y * VW + x) * 4 + 3];

  // ── crisp, not magnified ─────────────────────────────────────────────────
  {
    const z = 4;
    const g = bakeEngine('ocean', 7).engine.geom;
    const one = renderLayers('ocean', 7, { haze: 1 });
    // Terminator: the night veil ends where 0.38 + 0.9 (dx cos az + 0.65 sin az) = 0.94.
    const dxT = ((0.94 - 0.38) / 0.9 - 0.65 * Math.sin(H.SUN_AZ)) / Math.cos(H.SUN_AZ);
    const cams: Record<string, { zoom: number; fx: number; fy: number }> = {
      // The dome limb up and to the right of the face.
      limb: { zoom: z, fx: Math.round(g.cx + g.rx * 0.62), fy: Math.round(g.cyTop - g.rx * 0.72) },
      // The night veil's edge where the front rim runs diagonally (dx -0.72).
      // The terminator LINE itself is vertical by construction (the veil
      // depends on dx only), so it has no stair steps at any zoom; its
      // crispness is the gradient's, checked below.
      terminator: { zoom: z, fx: Math.round(g.cx - g.rx * 0.72), fy: Math.round(g.cyTop + g.ry * 0.69) },
      coast: { zoom: z, fx: g.cx, fy: g.cyTop },
    };
    const feature: Record<string, { layer: string; cls: (L: Record<string, Img>, x: number, y: number) => number; keep: (L: Record<string, Img>, x: number, y: number) => boolean }> = {
      limb: { layer: 'atmosphere', cls: (L, x, y) => A(L.atmosphere, x, y) > 0 ? 1 : 0, keep: (L, x, y) => A(L.atmosphere, x, y) > 0 },
      terminator: { layer: 'dayNight', cls: (L, x, y) => A(L.dayNight, x, y) > 0 ? 1 : 0, keep: (L, x, y) => A(L.dayNight, x, y) > 0 },
      coast: {
        layer: 'land',
        cls: (L, x, y) => A(L.fluids, x, y) > 0 ? 1 : A(L.land, x, y) > 0 ? 0 : -1,
        keep: (L, x, y) => A(L.fluids, x, y) > 0 || A(L.land, x, y) > 0,
      },
    };
    for (const name of ['limb', 'terminator', 'coast']) {
      const cam = cams[name], f = feature[name];
      const four = renderLayers('ocean', 7, { cam, haze: 1 });
      const w1 = (x: number, y: number) => {
        const w = screenToWorld(cam, VW, VH, x, y);
        return { x: Math.floor(w.x), y: Math.floor(w.y) };
      };
      const keep1 = (x: number, y: number) => { const p = w1(x, y); return p.x >= 0 && p.y >= 0 && p.x < VW && p.y < VH && f.keep(one, p.x, p.y); };
      const r4 = stairRuns((x, y) => f.cls(four, x, y), keep1);
      // Control: the zoom-1 render magnified 4x nearest-neighbour through the same camera.
      const mag = (x: number, y: number) => { const p = w1(x, y); return p.x >= 0 && p.y >= 0 && p.x < VW && p.y < VH ? f.cls(one, p.x, p.y) : -1; };
      const rc = stairRuns(mag, keep1);
      check(`crisp: ${name === 'terminator' ? 'night veil edge' : name} (${f.layer}) at zoom 4, mean stair run <= 2 px`, r4.runs >= 20 && r4.mean <= 2,
        `mean ${r4.mean.toFixed(2)} px over ${r4.runs} runs (${r4.cracks} crack px), camera ${cam.fx},${cam.fy}`);
      check(`  control: ${name === 'terminator' ? 'night veil edge' : name} zoom 1 magnified 4x has runs >= 4 px`, rc.runs >= 20 && rc.mean >= 4,
        `mean ${rc.mean.toFixed(2)} px over ${rc.runs} runs`);
    }
    // The terminator: where it meets the front rim (dx = dxT) the rim is
    // shallow and the terminator a vertical line, so the stair mean there is
    // long for a CORRECT rasterisation too. Printed for the record.
    {
      const cam = { zoom: z, fx: Math.round(g.cx + g.rx * dxT), fy: Math.round(g.cyTop + g.ry * 0.62) };
      const four = renderLayers('ocean', 7, { cam });
      const w1 = (x: number, y: number) => { const w = screenToWorld(cam, VW, VH, x, y); return { x: Math.floor(w.x), y: Math.floor(w.y) }; };
      const keep1 = (x: number, y: number) => { const p = w1(x, y); return p.x >= 0 && p.y >= 0 && p.x < VW && p.y < VH && A(one.dayNight, p.x, p.y) > 0; };
      const r4 = stairRuns((x, y) => A(four.dayNight, x, y) > 0 ? 1 : 0, keep1);
      const rc = stairRuns((x, y) => { const p = w1(x, y); return p.x >= 0 && p.y >= 0 && p.x < VW && p.y < VH ? (A(one.dayNight, p.x, p.y) > 0 ? 1 : 0) : -1; }, keep1);
      console.log(`  info  terminator meets the rim (dx ${dxT.toFixed(3)}, camera ${cam.fx},${cam.fy}): zoom 4 mean stair run ${r4.mean.toFixed(2)} px over ${r4.runs} runs; magnified ${rc.mean.toFixed(2)} over ${rc.runs}`);
      // Terminator gradient: the veil is re-rendered per output pixel, so its
      // alpha steps fall anywhere; a magnified veil steps only on the 4-px
      // block lattice of the camera (fx, fy whole: blocks start at x = 0 mod 4).
      const onLattice = (d: (x: number, y: number) => number) => {
        let on = 0, n = 0;
        for (let y = 0; y < VH; y++) for (let x = 1; x < VW; x++) {
          const a = d(x - 1, y), b = d(x, y);
          if (a <= 0 || b <= 0 || a === b) continue;
          n++; if (x % 4 === 0) on++;
        }
        return { share: n ? on / n : 1, n };
      };
      const lg = onLattice((x, y) => A(four.dayNight, x, y));
      const lc = onLattice((x, y) => { const p = w1(x, y); return p.x >= 0 && p.y >= 0 && p.x < VW && p.y < VH ? A(one.dayNight, p.x, p.y) : 0; });
      check('crisp: terminator gradient steps at zoom 4 are not on the 4-px lattice (<= 50%)', lg.n >= 50 && lg.share <= 0.5,
        `${(100 * lg.share).toFixed(1)}% of ${lg.n} alpha steps on the lattice`);
      check('  control: the zoom-1 veil magnified 4x steps only on the lattice', !(lc.n >= 50 && lc.share <= 0.5),
        `${(100 * lc.share).toFixed(1)}% of ${lc.n} steps`);
    }
  }

  // ── world-anchored water: swell wavelength in world units ────────────────
  {
    /**
     * The swell's phase is SWELL_K * shore distance + omega * t. Demodulate
     * each water pixel's brightness at omega over two periods, sum per world
     * shore-distance bin, and find the spatial wavenumber whose phase ramp
     * best matches (a matched filter over K; no unwrapping). Independent of
     * the painter's constants except omega (1.6 rad/s on ocean).
     */
    const OMEGA = 1.6, PERIODS = 2, PER = 16;
    const measure = (eng: any, geom: any, k: number, kPaint: number) => {
      const occ = eng.occupancy as Uint8Array, sd = eng.shoreDist as Float32Array;
      const BIN = 0.5, NB = 120;
      const re = new Float64Array(NB), im = new Float64Array(NB);
      const img = { width: VW, height: VH, data: new Uint8ClampedArray(VW * VH * 4) };
      const idx: number[] = [];
      for (let i = 0; i < VW * VH; i++) if (occ[i] === 1 && sd[i] > 0 && sd[i] / k < NB * BIN) idx.push(i);
      const T = 2 * Math.PI / OMEGA, N = PERIODS * PER;
      for (let s = 0; s < N; s++) {
        const t = 10 + (s / PER) * T;
        img.data.fill(0);
        Eng.paintFluids(img as unknown as ImageData, geom, occ, 'ocean', t, 0, sd, kPaint);
        const c = Math.cos(OMEGA * t), sn = Math.sin(OMEGA * t);
        for (const i of idx) {
          const o = i * 4, lum = img.data[o] + img.data[o + 1] + img.data[o + 2];
          const b = Math.floor(sd[i] / k / BIN);
          re[b] += lum * c; im[b] += lum * sn;
        }
      }
      let best = 0, bestK = 0;
      const power = (K: number) => {
        let sr = 0, si = 0;
        for (let b = 0; b < NB; b++) {
          const s = (b + 0.5) * BIN, c = Math.cos(K * s), sn = Math.sin(K * s);
          // Sum A(s) e^{-iKs}: brightness(t) ~ f(K s + omega t), demodulated by e^{+i omega t}... sign-agnostic: take both.
          sr += re[b] * c + im[b] * sn; si += im[b] * c - re[b] * sn;
        }
        return sr * sr + si * si;
      };
      const powerAbs = (K: number) => Math.max(power(K), power(-K));
      for (let K = 0.03; K <= 2.5; K += 0.002) { const p = powerAbs(K); if (p > best) { best = p; bestK = K; } }
      return { lambda: 2 * Math.PI / bestK, n: idx.length };
    };
    const B = bakeEngine('ocean', 7), eng = B.engine as any, g = B.engine.geom;
    const m1 = measure(eng, g, 1, 1);
    const cam = { zoom: 4, fx: g.cx - 30, fy: g.cyTop + 10 };
    B.engine.setCamera(cam); B.engine.showCamera = true;
    const m4 = measure(eng, B.engine.activeGeom, 4, 4);
    const ratio = m4.lambda / m1.lambda;
    check('world-anchored water: swell wavelength (world px) at zoom 4 = zoom 1 +/- 10%', Math.abs(ratio - 1) <= 0.10,
      `zoom 1 ${m1.lambda.toFixed(2)} px (${m1.n} px), zoom 4 ${m4.lambda.toFixed(2)} world px (${m4.n} px), ratio ${ratio.toFixed(3)}`);
    // Control: the same camera render with the constants left unconverted (k = 1).
    const mc = measure(eng, B.engine.activeGeom, 4, 1);
    const rc = mc.lambda / m1.lambda;
    check('  control: unconverted SWELL_K (k = 1) gives a ~4x shorter wavelength', Math.abs(rc - 1) > 0.10,
      `zoom 4 unconverted ${mc.lambda.toFixed(2)} world px, ratio ${rc.toFixed(3)}`);
    B.engine.showCamera = false;
  }

  // ── strokes stay 1 px: water glints ──────────────────────────────────────
  {
    const glint = Eng.cutawayWaterSurf('ocean').glint;
    /** Mean over glint pixels in open water (past the foam band) of min(horizontal run, vertical run) through it. */
    const glintWidth = (eng: any, geom: any, k: number, kPaint: number, lineK = kPaint) => {
      const occ = eng.occupancy as Uint8Array, sd = eng.shoreDist as Float32Array;
      const img = { width: VW, height: VH, data: new Uint8ClampedArray(VW * VH * 4) };
      Eng.paintFluids(img as unknown as ImageData, geom, occ, 'ocean', H.ELAPSED, 0, sd, kPaint, lineK);
      const isG = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= VW || y >= VH) return false;
        const o = (y * VW + x) * 4;
        return img.data[o] === glint.r && img.data[o + 1] === glint.g && img.data[o + 2] === glint.b && img.data[o + 3] === 255;
      };
      const ws: number[] = [];
      for (let y = 1; y < VH - 1; y++) for (let x = 1; x < VW - 1; x++) {
        if (!isG(x, y) || !(sd[y * VW + x] / k > 5 * 1.2)) continue;
        let h = 1, v = 1;
        for (let t = x - 1; isG(t, y); t--) h++;
        for (let t = x + 1; isG(t, y); t++) h++;
        for (let t = y - 1; isG(x, t); t--) v++;
        for (let t = y + 1; isG(x, t); t++) v++;
        ws.push(Math.min(h, v));
      }
      ws.sort((a, b) => a - b);
      const n = ws.length;
      return { w: n ? ws.reduce((a, b) => a + b, 0) / n : 0, med: n ? ws[n >> 1] : 0, n };
    };
    const B = bakeEngine('ocean', 7), eng = B.engine as any, g = B.engine.geom;
    const w1 = glintWidth(eng, g, 1, 1);
    B.engine.setCamera({ zoom: 4, fx: g.cx - 30, fy: g.cyTop + 10 }); B.engine.showCamera = true;
    const w4 = glintWidth(eng, B.engine.activeGeom, 4, 4);
    const onePx = (r: { n: number; med: number }) => r.n >= 50 && r.med === 1;
    check('strokes: water glint lines at zoom 4 are 1 px wide (median min run)', onePx(w4),
      `zoom 4 median ${w4.med} px, mean ${w4.w.toFixed(2)} px over ${w4.n} open-water glint px; zoom 1 median ${w1.med}, mean ${w1.w.toFixed(2)} over ${w1.n}`);
    // Control: the same camera render with the line thresholds left unscaled
    // (lineK = 1; world anchoring kept) — the glint grows to world width.
    const wc = glintWidth(eng, B.engine.activeGeom, 4, 4, 1);
    check('  control: glint width unscaled (lineK = 1) fails the 1-px bar', !onePx(wc),
      `median ${wc.med} px, mean ${wc.w.toFixed(2)} px over ${wc.n} glint px`);
    B.engine.showCamera = false;
  }

  // ── weather painter under the camera ─────────────────────────────────────
  {
    const B = bakeEngine('storm', 7), eng = B.engine as any, g = B.engine.geom;
    const id = eng.weatherPainter;
    // A camera that sees the front rim: the face bottom at screen row 240.
    const cam = { zoom: 4, fx: g.cx, fy: g.cyTop + g.ry - 20 };
    B.engine.setCamera(cam);
    const cs = eng.camSet, cp = cs.painter;
    check('weather: the camera set has its own painter', !!cp && cp !== id, `identity lookup ${id.lut.count}, camera lookup ${cp?.lut.count}`);

    // Rain streak: 3 px long, 1 px wide, at zoom 4.
    const streak = (p: any, x: number, y: number) => {
      const img = { width: VW, height: VH, data: new Uint8ClampedArray(VW * VH * 4) };
      p.pCount = 1; p.pX[0] = x; p.pY[0] = y; p.pGround[0] = VH + 100; p.pKind[0] = 0; p.pPhase[0] = 0; p.fCount = 0;
      p.dens.fill(0);
      p.paintClouds(img, H.SUN_AZ, 1);
      let n = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
      for (let yy = 0; yy < VH; yy++) for (let xx = 0; xx < VW; xx++) if (img.data[(yy * VW + xx) * 4 + 3]) {
        n++; x0 = Math.min(x0, xx); x1 = Math.max(x1, xx); y0 = Math.min(y0, yy); y1 = Math.max(y1, yy);
      }
      return { n, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    };
    const s4 = streak(cp, 200, 100);
    const stroke = (r: { w: number; h: number }) => r.h === 3 && r.w === 1;
    check('strokes: a rain streak is 3 px long and 1 px wide at zoom 4', stroke(s4),
      `${s4.w} x ${s4.h} px (${s4.n} px)`);
    // Control: a camera painter whose streak length is scaled x k (P_LEN x 4).
    const sp = new WP.WeatherPainter(cp.lut, eng.weatherClimate, cp.cloudLift, 7, { scale: 4, streakScale: 4 });
    const sc = streak(sp, 200, 100);
    check('  control: a streak scaled x k fails the stroke bar', !stroke(sc), `${sc.w} x ${sc.h} px`);

    // Fall speed is a world distance per second: x k on screen, so a drop's
    // life from cloud base to ground (both x k) is the same at every zoom and
    // spawns per screen px keep the on-screen density (Ruling 4).
    const fall = (p: any) => { p.pCount = 1; p.pY[0] = 0; p.pGround[0] = 1e6; p.pKind[0] = 0; p.prepare(eng.weatherSim, 0.5, 0.1); return p.pY[0] / 0.1; };
    const life = (p: any) => {
      const lut = p.lut; let sum = 0, n = 0;
      for (let i = 0; i < lut.count; i++) { const d = lut.ground[i] - (lut.py[i] - p.cloudLift + p.tune[1]); if (d > 0) { sum += d; n++; } }
      return sum / n / fall(p);
    };
    const v1 = fall(id), v4 = fall(cp), l1 = life(id), l4 = life(cp);
    check('weather: rain falls 4x as many screen px per second at zoom 4', Math.abs(v4 / v1 - 4) < 1e-6,
      `${v1.toFixed(1)} -> ${v4.toFixed(1)} px/s`);
    check('weather: mean drop life (cloud base to ground) equal at zoom 1 and 4 (+/- 15%)', Math.abs(l4 / l1 - 1) <= 0.15,
      `${l1.toFixed(3)} s vs ${l4.toFixed(3)} s, ratio ${(l4 / l1).toFixed(3)}; particle cap ${id.pmax} -> ${cp.pmax}`);
    const unscaled = new WP.WeatherPainter(cp.lut, eng.weatherClimate, cp.cloudLift, 7);
    const lc = life(unscaled);
    check('  control: an unscaled fall speed lives ~4x as long at zoom 4', !(Math.abs(lc / l1 - 1) <= 0.15), `ratio ${(lc / l1).toFixed(3)}`);

    // Cloud lift: bottom of the cloud layer above the bottom of the face, measured in the painted image.
    const liftOfPainter = (p: any) => {
      p.prepare(eng.weatherSim, 0.5, 0);
      p.pCount = 0; p.fCount = 0;
      p.dens.fill(2);
      const img = { width: VW, height: VH, data: new Uint8ClampedArray(VW * VH * 4) };
      p.paintClouds(img, H.SUN_AZ, 1);
      const x = VW / 2;
      let face = -1, cloud = -1;
      for (let i = 0; i < p.lut.count; i++) if (p.lut.px[i] === x) face = Math.max(face, p.lut.py[i]);
      for (let y = VH - 1; y >= 0; y--) if (img.data[(y * VW + x) * 4 + 3]) { cloud = y; break; }
      return face - cloud;
    };
    const L1 = liftOfPainter(id), L4 = liftOfPainter(cp);
    check('weather: cloud layer sits (maxLift + 6) * 4 px above the ground at zoom 4', L4 === (MAX_LIFT + 6) * 4 && L1 === MAX_LIFT + 6,
      `zoom 1 ${L1} px, zoom 4 ${L4} px (want ${(MAX_LIFT + 6) * 4})`);
    const Lc = liftOfPainter(new WP.WeatherPainter(cp.lut, eng.weatherClimate, MAX_LIFT + 6, 7));
    check('  control: a camera painter with the unscaled cloud lift', Lc !== (MAX_LIFT + 6) * 4, `${Lc} px`);

    // Lightning density per screen area (Ruling 4), pooled over storm seeds.
    // The sim steps once; the identity and camera painters both see every
    // step. Bolts per step per 10k lookup px (the sky a painter can flash in).
    {
      const STEPS = 1500;
      const flashRun = (broken: boolean) => {
        let b1 = 0, b4 = 0, a1 = 0, a4 = 0;
        for (const sd of [7, 11, 3]) {
          const Bs = bakeEngine('storm', sd), es = Bs.engine as any, gs = Bs.engine.geom;
          Bs.engine.setCamera({ zoom: 4, fx: gs.cx, fy: gs.cyTop });
          const p1 = es.weatherPainter;
          let p4 = es.camSet.painter;
          if (broken) p4 = new WP.WeatherPainter(p4.lut, es.weatherClimate, p4.cloudLift, sd, { scale: 4, pmax: p4.pmax });
          const sim = es.weatherSim, f1 = p1.flashesTotal, f4 = p4.flashesTotal;
          for (let s = 0; s < STEPS; s++) {
            sim.step(0.25); p1.onStep(sim); p4.onStep(sim);
            p1.prepare(sim, 1, 0.25); p4.prepare(sim, 1, 0.25);
          }
          b1 += p1.flashesTotal - f1; b4 += p4.flashesTotal - f4;
          a1 += p1.lut.count; a4 += p4.lut.count;
        }
        const d1 = b1 / STEPS / (a1 / 3) * 1e4, d4 = b4 / STEPS / (a4 / 3) * 1e4;
        return { d1, d4, ratio: d4 / d1, b1, b4 };
      };
      const r = flashRun(false);
      const ok = (q: { ratio: number }) => q.ratio >= 0.5 && q.ratio <= 2;
      check('weather: lightning per screen area at zoom 4 within 2x of zoom 1 (storm 7/11/3 pooled)', ok(r),
        `bolts per step per 10k px: zoom 1 ${r.d1.toFixed(3)}, zoom 4 ${r.d4.toFixed(3)}, ratio ${r.ratio.toFixed(2)} (${r.b1} vs ${r.b4} bolts)`);
      const c = flashRun(true);
      check('  control: the identity bolt cap (1 per step, FMAX 8) at zoom 4', !ok(c),
        `zoom 4 ${c.d4.toFixed(3)} vs zoom 1 ${c.d1.toFixed(3)}, ratio ${c.ratio.toFixed(2)}`);
    }

    // Bounded lookup (Ruling 13: canvas plus the relief margin, here the cloud lift).
    B.engine.setCamera({ zoom: 4, fx: g.cx, fy: g.cyTop });
    const cq = eng.camSet.painter, bound = VW * (VH + cq.cloudLift);
    check('bounded: weather lookup entries at zoom 4 <= VW*(VH+cloudLift)', cq.lut.count <= bound,
      `${cq.lut.count} entries (canvas area ${VW * VH}, bound ${bound}); identity ${id.lut.count}`);
    const o = eng.camSet.opts;
    const unclamped = WP.buildWeatherLut(eng.camSet.geom, o.discToGrid, () => 0);
    check('  control: an unclamped zoom-4 lookup exceeds the bound (~16x identity)', unclamped.count > bound,
      `${unclamped.count} entries, x${(unclamped.count / id.lut.count).toFixed(1)} identity`);

    // Ruling 3: fractional field coordinates, so clouds do not stair-step per planet cell.
    const treads = (lut: any) => {
      let eq = 0, n = 0;
      for (let i = 1; i < lut.count; i++) {
        if (lut.py[i] !== lut.py[i - 1] || lut.px[i] !== lut.px[i - 1] + 1) continue;
        let d = Math.abs(lut.fx[i] - lut.fx[i - 1]); if (d > WX_NX / 2) d = WX_NX - d;
        n++; if (d === 0 && lut.fy[i] === lut.fy[i - 1]) eq++;
      }
      return { share: eq / n, n };
    };
    const tf = treads(cq.lut);
    check('weather: field coords change between horizontal neighbours (< 1% equal)', tf.share < 0.01,
      `${(100 * tf.share).toFixed(2)}% equal of ${tf.n} pairs`);
    const snapped = WP.buildWeatherLut(eng.camSet.geom, o.discToGrid, () => 0, { bounds: { w: VW, h: VH, below: cq.cloudLift } });
    const ts = treads(snapped);
    check('  control: the nearest-cell lookup stair-steps (most neighbours equal)', !(ts.share < 0.01),
      `${(100 * ts.share).toFixed(2)}% equal of ${ts.n} pairs`);
  }

  // ── haze follows the rendered zoom ───────────────────────────────────────
  {
    const sum = (d: Img) => { let s = 0; for (let i = 3; i < d.length; i += 4) s += d[i]; return s; };
    const B = bakeEngine('ocean', 7), g = B.engine.geom;
    const L = renderLayers('ocean', 7, { cam: { zoom: 3, fx: g.cx, fy: g.cyTop } });
    check('haze: at camera zoom 3 (CSS viewZoom 1) no atmosphere or cloud is drawn', sum(L.atmosphere) === 0 && sum(L.weather) === 0,
      `atmosphere alpha sum ${sum(L.atmosphere)}, weather ${sum(L.weather)}`);
    const C = renderLayers('ocean', 7, { cam: { zoom: 3, fx: g.cx, fy: g.cyTop }, haze: Eng.atmoHazeAmount(1) });
    check('  control: the same frame at the CSS zoom\'s haze draws both', sum(C.atmosphere) > 0 && sum(C.weather) > 0,
      `atmosphere ${sum(C.atmosphere)}, weather ${sum(C.weather)}`);
  }

  // ── vignette is screen-space ─────────────────────────────────────────────
  {
    class Rec extends PixelCtx {
      grads: Array<{ args: number[]; stops: Array<[number, string]> }> = [];
      createRadialGradient(...args: number[]) {
        const gr = { args, stops: [] as Array<[number, string]> };
        this.grads.push(gr);
        return { addColorStop: (o: number, c: string) => { gr.stops.push([o, c]); } } as any;
      }
    }
    const alphaOf = (c: string) => { const m = c.match(/rgba\([^)]*,\s*([\d.]+)\)/); return m ? +m[1] : 1; };
    /** Alpha of a concentric two-circle radial gradient at (x, y) (Canvas spec, pad). */
    const alphaAt = (gr: { args: number[]; stops: Array<[number, string]> }, x: number, y: number) => {
      const [x0, y0, r0, , , r1] = gr.args;
      const d = Math.hypot(x - x0, y - y0);
      const w = Math.max(0, Math.min(1, (d - r0) / (r1 - r0)));
      const a0 = alphaOf(gr.stops[0][1]), a1 = alphaOf(gr.stops[gr.stops.length - 1][1]);
      return a0 + (a1 - a0) * w;
    };
    const B = bakeEngine('ocean', 7), eng = B.engine as any, g = B.engine.geom;
    const got: string[] = [], ctl: string[] = [];
    let worst = 0, ctlDark = Infinity;
    for (let z = 1; z <= 4.0001; z += 0.1) {
      const zz = Math.round(z * 10) / 10;
      const cam = { zoom: zz, fx: g.cx, fy: g.cyTop };
      B.engine.setCamera(cam); B.engine.showCamera = true;
      const rec = new Rec(new PixelCanvas(VW, VH));
      frameOf(B.engine, rec);
      const vig = rec.grads[rec.grads.length - 1];
      const a = alphaAt(vig, VW / 2, VH / 2);
      worst = Math.max(worst, a);
      // Control: the vignette drawn from the CAMERA geometry.
      const rc = new Rec(new PixelCanvas(VW, VH));
      eng.drawVignette(rc, B.engine.activeGeom, 0);
      const ac = alphaAt(rc.grads[0], VW / 2, VH / 2);
      if (ac > 0.01 && zz < ctlDark) ctlDark = zz;
      if ([1, 2, 3, 4].includes(zz)) { got.push(`z${zz} ${a.toFixed(3)}`); ctl.push(`z${zz} ${ac.toFixed(3)}`); }
    }
    B.engine.showCamera = false;
    check('vignette: alpha at the canvas centre is 0 at zoom 1..4', worst === 0, got.join(', '));
    check('  control: a camera-geometry vignette darkens the centre when zoomed', ctlDark <= 4,
      `${ctl.join(', ')}; first > 0.01 at zoom ${ctlDark}`);
  }

  // ── gas rings: per base-space ring, spacing x k, 1-px strokes ────────────
  {
    class Rec extends PixelCtx {
      ell: Array<{ rx: number; ry: number; lw: number }> = [];
      private cur: { rx: number; ry: number } | null = null;
      ellipse(_x: number, _y: number, rx: number, ry: number) { this.cur = { rx, ry }; }
      stroke() { if (this.cur) this.ell.push({ ...this.cur, lw: this.lineWidth }); this.cur = null; }
    }
    // Seed 32: (32 >>> 5) & 3 = 1, a ringed gas giant (seed 7 has none).
    const B = bakeEngine('gas', 32), eng = B.engine as any, g = B.engine.geom;
    const run = (z: number | null) => {
      if (z) { B.engine.setCamera({ zoom: z, fx: g.cx, fy: g.cyTop }); B.engine.showCamera = true; }
      else B.engine.showCamera = false;
      const rec = new Rec(new PixelCanvas(VW, VH));
      frameOf(B.engine, rec);
      return rec.ell;
    };
    const e1 = run(null), e4 = run(4);
    const half1 = e1.length / 2, half4 = e4.length / 2;
    let worstR = 0, worstGap = 0;
    for (let i = 0; i < Math.min(e1.length, e4.length); i++) worstR = Math.max(worstR, Math.abs(e4[i].rx - 4 * e1[i].rx));
    for (let i = 1; i < half4; i++) {
      // Consecutive drawn rings in base space are 1 px apart unless a faint ring was skipped.
      const gap4 = e4[i].rx - e4[i - 1].rx, gap1 = e1[i].rx - e1[i - 1].rx;
      worstGap = Math.max(worstGap, Math.abs(gap4 - 4 * gap1));
    }
    const lw = e4.every(e => e.lw === 1) && e1.every(e => e.lw === 1);
    check('gas rings: same stroke count at zoom 4 as zoom 1, radii and spacing x 4, 1-px strokes',
      e1.length > 0 && e4.length === e1.length && worstR < 1e-9 && worstGap < 1e-9 && lw,
      `${e1.length} -> ${e4.length} strokes; worst radius |r4 - 4 r1| ${worstR.toExponential(1)}, worst spacing |d4 - 4 d1| ${worstGap.toExponential(1)}; 1-px ${lw}; zoom-4 spacing ${(e4[1].rx - e4[0].rx).toFixed(2)} px`);
    // Control: the rings iterated in SCREEN px of the camera geometry (k = 1): 4x the strokes.
    const rc = new Rec(new PixelCanvas(VW, VH));
    eng.drawGasRings(rc, true, 0, B.engine.activeGeom, 1);
    check('  control: rings iterated per screen px at zoom 4 exceed the zoom-1 count', !(rc.ell.length <= half1),
      `${rc.ell.length} strokes in the back pass vs ${half1} at zoom 1 (half4 ${half4})`);
    B.engine.showCamera = false;
  }
}

console.log('\n  PLACEMENT (Task 6: stable placement, effects, far layers, moons, markers, backdrop)');
{
  const H = await import('./zoomHarness');
  const { PixelCanvas, PixelCtx } = H;
  const SkyP = await import('../src/rendering/sky/SkyPainter') as any;
  const Bd = await import('../src/rendering/sky/Backdrop') as any;
  const Eng = await import('../src/rendering/HabitableCutawayEngine') as any;
  const SD = await import('../src/rendering/SurfaceDecals') as any;
  /** The moons' orbit phase the game passes at elapsed = H.ELAPSED. */
  const ELAPSED_MOON = H.ELAPSED * (Math.PI * 2 / 60);
  /**
   * Hash of every overlay drawing call at the identity view (backdrop, sky,
   * moons, city lights, inhabitants, tile markers, two divine effects) plus the
   * sky image, for ocean 3 and lava 4 — captured from the pre-Task-6 code
   * (1c76aa4). Zoom 1 must stay exactly today's.
   */
  const OVERLAY_GOLDEN = '39ae35c0/bd2a126f c0c7e6ed/bd2a126f';

  /** Records every drawing call with its arguments (numbers as given, no rounding). */
  class Rec extends PixelCtx {
    log: Array<any[]> = [];
    private note(name: string, args: unknown[]) {
      this.log.push([name, ...args.map(a => (a && typeof a === 'object' && 'width' in (a as any)) ? `img${(a as any).width}x${(a as any).height}` : a)]);
    }
    fillRect(x: number, y: number, w: number, h: number) { this.note('fillRect', [x, y, w, h, String(this.fillStyle), this.globalAlpha]); }
    drawImage(...a: any[]) { this.note('drawImage', a); }
    arc(...a: number[]) { this.note('arc', [...a, String(this.fillStyle)]); }
    ellipse(...a: number[]) { this.note('ellipse', [...a, this.lineWidth]); }
    moveTo(...a: number[]) { this.note('moveTo', a); }
    lineTo(...a: number[]) { this.note('lineTo', a); }
    rect(...a: number[]) { this.note('rect', a); }
    fill() { this.note('fill', [String(this.fillStyle)]); }
    stroke() { this.note('stroke', [String(this.strokeStyle), this.lineWidth]); }
    clip() { this.note('clip', []); }
    createRadialGradient(...a: number[]) { this.note('radial', a); return { addColorStop: (o: number, c: string) => this.note('stop', [o, c]) } as any; }
    createLinearGradient(...a: number[]) { this.note('linear', a); return { addColorStop: (o: number, c: string) => this.note('stop', [o, c]) } as any; }
  }
  const rec = () => new Rec(new PixelCanvas(VW, VH));
  /** The renderer's settle entry point (Task 6); before it existed, the engine's camera shown directly. */
  const setCam = (r: any, cam: any) => {
    if (typeof r.setCamera === 'function') r.setCamera(cam);
    else { r.cutaway.setCamera(cam); r.cutaway.showCamera = !isIdentity(cam, VW, VH); }
  };
  const ID = identityCamera(VW, VH);
  /** A placement record's stored position (world after Task 6; screen before it). */
  const W = (p: any) => [p.wx ?? p.x, p.wy ?? p.y] as [number, number];
  const key = (a: any[], f: (p: any) => [number, number]) => a.map(f).map(p => `${p[0]},${p[1]}`).sort().join(';');
  const records = (r: any) => ({
    dots: key(r.cityDots, W), creatures: key(r.inhabitants, W), towns: key(r.settlements, W),
    decals: key(r.cutaway.planDecals ?? [], W), chimneys: key(r.cutaway.planChimneys ?? [], W),
  });
  const counts = (r: any) => `${r.cityDots.length} dots, ${r.inhabitants.length} creatures, ${r.settlements.length} towns, ${(r.cutaway.planDecals ?? []).length} decals, ${(r.cutaway.planChimneys ?? []).length} chimneys`;

  const ocean = await H.makeRenderer('ocean', 3), lava = await H.makeRenderer('lava', 4);
  // Materialise the engine's identity plans (Task 4 builds them lazily at the first camera).
  for (const r of [ocean, lava]) { setCam(r, { zoom: 2, fx: 240, fy: 150 }); setCam(r, ID); }

  // ── identity overlays are today's (call-log golden from the pre-Task-6 code) ──
  {
    const overlayLog = (r: any) => {
      const g = rec();
      r.setHighlight(r.discToGrid(0.12, 0.05)); r.setSelection(r.discToGrid(-0.2, 0.1));
      r.effects = [];
      r.playDivineEffect('smite', r.discToGrid(0.1, -0.05)); r.playDivineEffect('revelation', null);
      r.drawBackdropPanorama(g); r.drawSky(g);
      r.drawMoons(g, ELAPSED_MOON, false); r.drawCityLights(g, H.ELAPSED); r.drawInhabitants(g, H.ELAPSED);
      r.drawTileMarkers(g, H.ELAPSED); r.drawDivineEffects(g, 0.3); r.drawMoons(g, ELAPSED_MOON, true);
      r.effects = []; r.setHighlight(null); r.setSelection(null);
      return H.hashImage(new TextEncoder().encode(JSON.stringify(g.log)) as any) + '/' + H.hashImage(r.skyImage.data);
    };
    const got = [overlayLog(ocean), overlayLog(lava)].join(' ');
    check('identity overlays unchanged (call-log golden, pre-Task-6)', got === OVERLAY_GOLDEN, `${got} vs ${OVERLAY_GOLDEN}`);
  }

  // ── stable placement: world positions identical at zoom 1, 2, 4 and after a pan ──
  {
    const g = ocean.cutaway.geom;
    const cams = [{ zoom: 2, fx: g.cx - 20, fy: g.cyTop - 10 }, { zoom: 4, fx: g.cx + 20, fy: g.cyTop }, { zoom: 4, fx: g.cx - 40, fy: g.cyTop + 12 }];
    const lines: string[] = [];
    let ok = true, carry = true;
    for (const r of [ocean, lava]) {
      setCam(r, ID); r.markSurfaceDirty(true);
      const ref = records(r);
      for (const cam of cams) {
        setCam(r, cam); r.markSurfaceDirty(true);   // the game's rebake path, taken under the camera
        const got = records(r);
        const bad = Object.keys(ref).filter(k => (ref as any)[k] !== (got as any)[k]);
        if (bad.length) { ok = false; lines.push(`${r.planetType} z${cam.zoom}@${cam.fx},${cam.fy}: ${bad.join('/')} moved`); }
      }
      const all = [...r.cityDots, ...r.inhabitants, ...r.settlements, ...(r.cutaway.planDecals ?? []), ...(r.cutaway.planChimneys ?? [])];
      carry &&= all.length > 0 && all.every((p: any) => Number.isFinite(p.wx) && Number.isFinite(p.wy) && Number.isInteger(p.row) && Number.isInteger(p.col));
      setCam(r, ID); r.markSurfaceDirty(true);
    }
    check('stable placement: world sets identical at zoom 1, 2, 4 and after a pan', ok,
      lines.length ? lines.join('; ') : `ocean ${counts(ocean)}; lava ${counts(lava)}`);
    check('placement records carry wx, wy (base world) and row, col', carry, '');

    // Control: re-plan AT the camera (the pre-change path: the planners fed the
    // camera geometry), and map the plan back to world through the camera.
    const cam = cams[1];
    const rG = ocean; setCam(rG, cam);
    const ref = records(rG);
    const A = rG.cutaway.activeGeom;
    const act = { cx: A.cx, cy: A.cyTop + rG.cutaway.bob, rx: A.rx, ry: A.ry };
    rG.buildCityDots(act); rG.buildInhabitants(act);
    const back = (p: any) => { const w = screenToWorld(cam, VW, VH, ...W(p)); return [w.x, w.y] as [number, number]; };
    const reDots = key(rG.cityDots, back), reTowns = key(rG.settlements, back);
    const camOpts = rG.cutaway.camSet.opts;
    const reDecals = key(SD.planSurfaceDecals(camOpts, 0.6, camOpts.decalSeed ?? 3), back);
    setCam(lava, cam);
    const reChim = key(Eng.planVolcanoChimneys(lava.cutaway.camSet.opts), back);
    const lref = records(lava);
    check('  control: re-planning at the camera moves dots, towns, decals and chimneys',
      reDots !== ref.dots && reTowns !== ref.towns && reDecals !== ref.decals && reChim !== lref.chimneys,
      `dots ${reDots !== ref.dots}, towns ${reTowns !== ref.towns}, decals ${reDecals !== ref.decals}, chimneys ${reChim !== lref.chimneys}`);
    setCam(rG, ID); rG.markSurfaceDirty(true); setCam(lava, ID); lava.markSurfaceDirty(true);
  }

  // ── overlays draw through the camera: lights 1 px at worldToScreen, sprites x round(k) ──
  {
    const r = ocean, g = r.cutaway.geom, cam = { zoom: 4, fx: g.cx + 12, fy: g.cyTop + 4 }, s = 4;
    setCam(r, cam);
    const gl = rec(); r.drawCityLights(gl, H.ELAPSED);
    const lights = gl.log.filter(e => e[0] === 'fillRect' && e[3] === 1 && e[4] === 1 && String(e[5]).startsWith('rgba(255,226,150'));
    let worstL = 0;
    for (const e of lights) {
      const w = screenToWorld(cam, VW, VH, e[1], e[2]);
      let best = Infinity;
      for (const d of r.cityDots) best = Math.min(best, Math.hypot(W(d)[0] - w.x, W(d)[1] - w.y));
      worstL = Math.max(worstL, best);
    }
    const gi = rec(); r.drawInhabitants(gi, H.ELAPSED);
    const imgs = gi.log.filter(e => e[0] === 'drawImage' && e.length === 6);
    const ents = [...r.inhabitants, ...r.settlements].filter((c: any) => !(c.submersion > 0));
    let worstS = 0, sized = imgs.length === ents.length && imgs.length > 0;
    for (let i = 0; i < Math.min(imgs.length, ents.length); i++) {
      const [, , dx, dy, w, h] = imgs[i];
      const c = ents[i], p = worldToScreen(cam, VW, VH, ...W(c));
      if (w !== Math.round(c.w) * s || h !== Math.round(c.h) * s) sized = false;
      worstS = Math.max(worstS, Math.abs(dx + w / 2 - p.x), Math.abs(dy + h - p.y) - 0.6 * s);
    }
    check('overlays through the camera: lights at worldToScreen, sprites x round(k)', lights.length > 0 && worstL <= 0.5 + 1e-9 && sized && worstS <= 1,
      `${lights.length} lights, worst ${worstL.toFixed(3)} world px; ${imgs.length}/${ents.length} sprites, sized x${s} ${sized}, worst anchor ${worstS.toFixed(2)} px`);
    setCam(r, ID);
  }

  // ── effect stays on its world spot (Review focus 5) ──
  {
    const r = ocean, g = r.cutaway.geom, cam = { zoom: 3, fx: g.cx + 10, fy: g.cyTop + 5 };
    setCam(r, cam);
    const cell = r.discToGrid(0.15, 0.1), d = r.gridToDisc(cell.row, cell.col), gc = r.grid[cell.row][cell.col];
    const A = r.cutaway.activeGeom, bob = r.cutaway.bob;
    const lift = r.liftAtCell(gc, Math.hypot(d.dx, d.dy)) * cam.zoom;
    const sp = { x: A.cx + d.dx * A.rx, y: A.cyTop + bob + d.dy * A.ry - lift };   // where the tile is on screen
    const want = screenToWorld(cam, VW, VH, sp.x, sp.y);
    r.effects = [];
    r.playDivineEffect('water', cell);
    const fx = r.effects[0], stored = W(fx);
    const err = Math.hypot(stored[0] - want.x, stored[1] - want.y);
    const snap = JSON.parse(JSON.stringify(fx));
    const ringAt = (e: any, c: any) => {
      r.effects = [JSON.parse(JSON.stringify(e))]; setCam(r, c);
      const gg = rec(); r.drawDivineEffects(gg, 0.3);
      const ell = gg.log.find(x => x[0] === 'ellipse');
      // A bright mote adds a 1-px stroke on the row above (screen px, not world):
      // keep only each mote's own pixel, the rect not stacked on the one before it.
      const rects = gg.log.filter(x => x[0] === 'fillRect' && x[3] === 1 && x[4] === 1);
      const motes = rects.filter((x, i) => !(i > 0 && rects[i - 1][1] === x[1] && rects[i - 1][2] === x[2] + 1))
        .map(x => [x[1], x[2]] as [number, number]);
      return { ell, motes };
    };
    const z1 = ringAt(snap, ID), z3 = ringAt(snap, cam);
    const at1 = worldToScreen(ID, VW, VH, stored[0], stored[1]);
    const drift = z1.ell ? Math.hypot(z1.ell[1] - at1.x, z1.ell[2] - at1.y) : Infinity;
    check('effect: stored world centre = screenToWorld of its screen point (zoom 3)', err < 1e-6,
      `|stored - want| ${err.toExponential(1)} (stored ${stored.map(v => v.toFixed(2))}, want ${want.x.toFixed(2)},${want.y.toFixed(2)})`);
    check('effect: back at zoom 1 it draws on that world spot (+/- 0.5 px)', drift <= 0.5, `ring centre off by ${drift.toFixed(3)} px`);
    let worstM = 0;
    for (let i = 0; i < Math.min(z1.motes.length, z3.motes.length); i++) {
      const w3 = screenToWorld(cam, VW, VH, z3.motes[i][0], z3.motes[i][1]);
      worstM = Math.max(worstM, Math.hypot(w3.x - z1.motes[i][0], w3.y - z1.motes[i][1]));
    }
    const reach = z1.ell && z3.ell ? z3.ell[3] / z1.ell[3] : NaN;
    check('effect: reach x k, motes on the same world paths (zoom 3 vs 1)',
      Math.abs(reach - 3) < 1e-9 && z1.motes.length > 0 && z1.motes.length === z3.motes.length && worstM <= 0.5 + 0.5 / 3 + 1e-9,
      `ring radius ratio ${reach.toFixed(4)}; ${z1.motes.length}/${z3.motes.length} motes, worst ${worstM.toFixed(3)} world px`);
    // Control: the same effect with its centre stored in SCREEN px (the pre-change record).
    const bad = { ...snap, wx: sp.x, wy: sp.y, x: sp.x, y: sp.y };
    const zb = ringAt(bad, ID);
    const driftB = zb.ell ? Math.hypot(zb.ell[1] - at1.x, zb.ell[2] - at1.y) : Infinity;
    check('  control: a centre stored in screen px drifts at zoom 1', !(driftB <= 0.5), `drift ${driftB.toFixed(2)} px`);
    r.effects = []; setCam(r, ID);
  }

  // ── far layers: the sun sits at the far transform of its zoom-1 position ──
  {
    const r = ocean, g = r.cutaway.geom;
    const sunCentre = (d: Uint8ClampedArray) => {
      let sx = 0, sy = 0, n = 0, x0 = Infinity, x1 = -Infinity;
      for (let i = 0; i < VW * VH; i++) if (d[i * 4 + 3] === 255) { const x = i % VW, y = (i / VW) | 0; sx += x; sy += y; n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
      return { x: sx / n + 0.5, y: sy / n + 0.5, n, w: x1 - x0 + 1 };
    };
    setCam(r, ID); r.drawSky(rec());
    const s1 = sunCentre(r.skyImage.data);
    const cam = { zoom: 4, fx: g.cx + 6, fy: 60 };
    setCam(r, cam); r.drawSky(rec());
    const s4 = sunCentre(r.skyImage.data);
    const f = farScale(4), want = { x: (s1.x - cam.fx) * f + VW / 2, y: (s1.y - cam.fy) * f + VH / 2 };
    const err = Math.hypot(s4.x - want.x, s4.y - want.y);
    check('far layers: sun at zoom 4 = far transform (x1.3 about the focus) of zoom 1 (+/- 1 px)', s1.n > 0 && s4.n > 0 && err <= 1,
      `zoom 1 (${s1.x.toFixed(1)},${s1.y.toFixed(1)}) -> zoom 4 (${s4.x.toFixed(1)},${s4.y.toFixed(1)}), want (${want.x.toFixed(1)},${want.y.toFixed(1)}), err ${err.toFixed(2)}`);
    check('far layers: sun disc x farScale, not x k', s4.w >= Math.round(s1.w * f) - 1 && s4.w <= Math.round(s1.w * f) + 1,
      `${s1.w} -> ${s4.w} px wide (want ~${(s1.w * f).toFixed(1)})`);
    // Control: the pre-change layout, skyLayout(camera geometry).
    const img = { width: VW, height: VH, data: new Uint8ClampedArray(VW * VH * 4) };
    const sky = r.sky;
    SkyP.paintSky(img, SkyP.skyLayout(r.cutaway.activeGeom, VW, VH), { sunAz: sky.sun.az, sunElev: sky.sun.elev, sunSizeScale: sky.sun.sizeScale, sunRgb: [255, 236, 180], siblings: [] });
    const sc = sunCentre(img.data);
    const errC = Math.hypot(sc.x - want.x, sc.y - want.y);
    check('  control: skyLayout(camera geometry) puts the sun elsewhere', !(errC <= 1), `err ${errC.toFixed(1)} px`);
    setCam(r, ID);
  }

  // ── moons: orbit and size x k ──
  {
    const r = ocean, g = r.cutaway.geom;
    const moonsAt = (cam: any) => {
      setCam(r, cam);
      const gg = rec(); r.drawMoons(gg, ELAPSED_MOON, false); r.drawMoons(gg, ELAPSED_MOON, true);
      const arcs = gg.log.filter(e => e[0] === 'arc');
      const out: Array<{ x: number; y: number; r: number }> = [];
      for (let i = 0; i + 1 < arcs.length; i++) {
        const a = arcs[i], b = arcs[i + 1];
        if (a[1] === b[1] && a[2] === b[2] && Math.abs(a[3] - 1.9 * b[3]) < 1e-9) out.push({ x: b[1], y: b[2], r: b[3] });
      }
      const A = r.cutaway.activeGeom;
      return { moons: out, ox: A.cx, oy: A.cyTop - A.ry * 1.35 };
    };
    const m1 = moonsAt(ID), m4 = moonsAt({ zoom: 4, fx: g.cx + 30, fy: g.cyTop - 40 });
    let worstO = 0, worstR = 0;
    for (let i = 0; i < Math.min(m1.moons.length, m4.moons.length); i++) {
      worstO = Math.max(worstO, Math.abs((m4.moons[i].x - m4.ox) - 4 * (m1.moons[i].x - m1.ox)), Math.abs((m4.moons[i].y - m4.oy) - 4 * (m1.moons[i].y - m1.oy)));
      worstR = Math.max(worstR, Math.abs(m4.moons[i].r - 4 * m1.moons[i].r));
    }
    check('moons: orbit radius and moon size on screen x4 at zoom 4 (+/- 1 px)', m1.moons.length === 2 && m4.moons.length === 2 && worstO <= 1 && worstR <= 1,
      `${m1.moons.length}/${m4.moons.length} moons; worst orbit offset ${worstO.toFixed(2)} px, worst radius ${worstR.toFixed(2)} px (r ${m1.moons.map(m => m.r.toFixed(2))} -> ${m4.moons.map(m => m.r.toFixed(2))})`);
    setCam(r, ID);
  }

  // ── tile markers: size cap and floors x k ──
  {
    const r = ocean, g = r.cutaway.geom;
    const markAt = (cam: any) => {
      setCam(r, cam); r.setHighlight(r.discToGrid(0.05, 0.02));
      const gg = rec(); r.drawTileMarkers(gg, H.ELAPSED); r.setHighlight(null);
      const mv = gg.log.find(e => e[0] === 'moveTo')!, ln = gg.log.find(e => e[0] === 'lineTo')!;
      return { cx: mv[1], cy: ln[2], w: ln[1] - mv[1], h: ln[2] - mv[2] };
    };
    const cam = { zoom: 4, fx: g.cx + 8, fy: g.cyTop + 2 };
    const a = markAt(ID), b = markAt(cam), c = worldToScreen(cam, VW, VH, a.cx, a.cy);
    const off = Math.hypot(b.cx - c.x, b.cy - c.y);
    check('tile marker: size x k (cap and floors), centre through the camera', Math.abs(b.w - 4 * a.w) < 1e-6 && Math.abs(b.h - 4 * a.h) < 1e-6 && off < 1e-6,
      `w ${a.w.toFixed(2)} -> ${b.w.toFixed(2)}, h ${a.h.toFixed(2)} -> ${b.h.toFixed(2)}, centre off ${off.toFixed(3)}`);
    setCam(r, ID);
  }

  // ── backdrop: re-baked at the far scale, stars stay 1 px ──
  {
    const Wp = Bd.backdropWidth(VW), f = farScale(4), Ws = Math.round(Wp * f);
    const A = { width: Wp, height: VH, data: new Uint8ClampedArray(Wp * VH * 4) };
    Bd.bakeBackdrop(A, { seed: 7, vw: VW });
    const B = { width: Ws, height: VH, data: new Uint8ClampedArray(Ws * VH * 4) };
    Bd.bakeBackdrop(B, { seed: 7, vw: VW, scale: f, fy: VH / 2 });
    /** Star pixels: brighter than the median of their 8 neighbours by > 25. */
    const stars = (img: { width: number; height: number; data: Uint8ClampedArray }) => {
      const w = img.width, h = img.height, d = img.data, L = new Float32Array(w * h), S = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) L[i] = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
      const nb = new Float32Array(8);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        let n = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (i || j) nb[n++] = L[(y + j) * w + x + i];
        nb.sort();
        if (L[y * w + x] > (nb[3] + nb[4]) / 2 + 25) S[y * w + x] = 1;
      }
      return S;
    };
    const adj = (S: Uint8Array, w: number) => { let n = 0, a = 0; for (let i = 0; i < S.length; i++) if (S[i]) { n++; if (S[i - 1] || S[i + 1] || S[i - w] || S[i + w]) a++; } return { n, frac: a / Math.max(1, n) }; };
    const SA = stars(A), SB = stars(B), aA = adj(SA, Wp), aB = adj(SB, Ws);
    // Every zoom-1 star whose far-transformed spot is on the scaled image finds a star there (+/- 1 px).
    let tot = 0, hit = 0;
    for (let y = 1; y < VH - 1; y++) for (let x = 1; x < Wp - 1; x++) {
      if (!SA[y * Wp + x]) continue;
      const X = Math.round(x * Ws / Wp), Y = Math.round((y - VH / 2) * f + VH / 2);
      if (Y < 2 || Y >= VH - 2 || X < 2 || X >= Ws - 2) continue;
      tot++;
      let found = false;
      for (let j = -1; j <= 1 && !found; j++) for (let i = -1; i <= 1; i++) if (SB[(Y + j) * Ws + X + i]) { found = true; break; }
      if (found) hit++;
    }
    check('backdrop: far-scaled bake keeps the stars at far-transformed spots, 1 px',
      tot > 50 && hit / tot >= 0.95 && aB.frac <= aA.frac + 0.02,
      `${hit}/${tot} stars found; adjacent-star-pixel share ${aA.frac.toFixed(3)} (zoom 1) -> ${aB.frac.toFixed(3)} (x${f})`);
    // Control: the zoom-1 panorama drawImage-scaled (nearest neighbour) by the far scale.
    const C = { width: Ws, height: VH, data: new Uint8ClampedArray(Ws * VH * 4) };
    for (let Y = 0; Y < VH; Y++) for (let X = 0; X < Ws; X++) {
      const x = Math.min(Wp - 1, Math.floor(X * Wp / Ws)), y = Math.max(0, Math.min(VH - 1, Math.floor((Y - VH / 2) / f + VH / 2)));
      for (let c = 0; c < 4; c++) C.data[(Y * Ws + X) * 4 + c] = A.data[(y * Wp + x) * 4 + c];
    }
    const aC = adj(stars(C), Ws);
    check('  control: a magnified panorama grows its stars past 1 px', !(aC.frac <= aA.frac + 0.02), `adjacent share ${aC.frac.toFixed(3)}`);
    // The renderer draws the far panorama about the focus.
    const r = ocean, g = r.cutaway.geom, cam = { zoom: 4, fx: g.cx - 30, fy: g.cyTop };
    setCam(r, cam);
    const gg = rec(); r.drawBackdropPanorama(gg);
    const first = gg.log.find(e => e[0] === 'drawImage');
    const off = Bd.backdropOffset(r.sky?.sunLongitude ?? 0, Wp);
    const dxWant = -((((off + cam.fx) * f - VW / 2) % Ws + Ws) % Ws);
    check('backdrop: panorama drawn at the far scale about the focus', !!first && first[1] === `img${Ws}x${VH}` && Math.abs(first[2] - dxWant) <= 1,
      `drew ${first?.[1]} at ${first?.[2]} (want img${Ws}x${VH} at ${dxWant.toFixed(1)})`);
    setCam(r, ID);
  }

  // ── decals partly on screen are stamped (clip, don't cull by anchor) ──
  {
    const r = ocean, e = r.cutaway, g = e.geom, k = 4, reachPx = 6 * k;
    setCam(r, ID);
    const plan: any[] = e.planDecals ?? [];
    // A camera whose left edge cuts through decals that were stamped at identity.
    let cam: any = null, edge: any[] = [];
    for (let fx = g.cx - 90; fx <= g.cx + 90 && !cam; fx += 0.25) {
      const c = { zoom: k, fx, fy: g.cyTop };
      const es = plan.filter(s => { const p = worldToScreen(c, VW, VH, ...W(s)); return p.x < 1 && p.x > -reachPx && p.y > 0 && p.y < VH && (s.foot === undefined || s.foot >= 0); });
      if (es.length >= 3) { cam = c; edge = es; }
    }
    /** How many of `edgeSites` change the camera land layer when present in the plan. */
    const stampedEdge = (sites: any[], edgeSites: any[]) => {
      e.planDecals = sites; e.setCamera(cam);
      const withD = e.camSet.land.data.slice();
      e.planDecals = sites.filter(s => !edgeSites.includes(s)); e.setCamera(cam);
      const without = e.camSet.land.data;
      let drawn = 0;
      for (const s of edgeSites) {
        const p = worldToScreen(cam, VW, VH, ...W(s));
        let diff = 0;
        for (let y = Math.max(0, Math.round(p.y) - 16 * k); y <= Math.min(VH - 1, Math.round(p.y) + 2 * k); y++)
          for (let x = 0; x < Math.min(VW, Math.round(p.x) + reachPx); x++) { const o = (y * VW + x) * 4; if (withD[o] !== without[o] || withD[o + 3] !== without[o + 3]) diff++; }
        if (diff > 0) drawn++;
      }
      e.planDecals = plan;
      return drawn;
    };
    const drawn = cam ? stampedEdge(plan, edge) : 0;
    check('decals whose anchor is just off the canvas are stamped (clipped)', !!cam && drawn === edge.length,
      cam ? `${drawn}/${edge.length} edge decals stamped at zoom ${k}, fx ${cam.fx}` : 'no camera with edge decals found');
    // Control: the same sites without their identity footing (the pre-change record shape) are culled.
    const bare = edge.map(s => { const c = { ...s }; delete c.foot; return c; });
    const ctl = cam ? stampedEdge(plan.map(s => (edge.includes(s) ? bare[edge.indexOf(s)] : s)), bare) : 0;
    check('  control: sites without identity footing are culled at the edge', !(cam && ctl === edge.length), `${ctl}/${edge.length}`);
    e.planDecals = plan; setCam(r, ID);
  }
}

console.log('\n  RENDERER (Task 7: progressive zoom in the renderer, resize, planet change)');
{
  const H = await import('./zoomHarness');
  const { applySettle } = await import('../src/rendering/zoomSettle');
  const { isWater, GRID_SIZE } = await import('../src/simulation/PlanetGrid');
  const { backdropWidth } = await import('../src/rendering/sky/Backdrop') as any;
  /** A check whose body may throw on code that does not exist yet: a throw is a FAIL, not a crash. */
  const tryCheck = (name: string, fn: () => [boolean, string]) => {
    try { const [ok, d] = fn(); check(name, ok, d); } catch (err) { check(name, false, `threw: ${(err as Error).message}`); }
  };
  const rectOf = (w: number, h: number) => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h, x: 0, y: 0 });
  /** Resize the stub mount (CSS px). The display fills the mount, as in the game. */
  const sizeMount = (r: any, w: number, h: number) => {
    r.mount.clientWidth = w; r.mount.clientHeight = h;
    r.mount.getBoundingClientRect = () => rectOf(w, h);
    r.display.getBoundingClientRect = () => rectOf(w, h);
  };
  /** Recorder: the first drawImage of the backdrop (what, where). */
  class BgRec extends H.PixelCtx {
    first: any[] | null = null;
    drawImage(src: any, dx = 0, dy = 0) { if (!this.first) this.first = [`img${src.width}x${src.height}`, dx, dy]; }
  }
  const idOf = (c: { row: number; col: number } | null) => c ? c.row * GRID_SIZE + c.col + 1 : 0;
  const T0 = 1e6;
  let t = T0;
  /** n wheel notches (deltaY < 0 zooms in) at CSS offset (mx, my) from the mount centre. */
  const wheel = (r: any, n: number, dir: number, mx = 60, my = 30) => { for (let i = 0; i < n; i++) r.zoom.wheel(mx, my, dir, t += 4); };
  /** One renderer frame's view step, SETTLE_MS after the last input. */
  const settleFrame = (r: any) => { r.updateView(t += SETTLE_MS + 1); };

  const r: any = await H.makeRenderer('ocean', 3);
  sizeMount(r, 960, 640);

  // ── click after settle maps through the camera (Review focus 2) ──────────
  let stalePick: Int32Array | null = null;
  tryCheck('settle: one frame step shows the camera set with CSS identity', () => {
    stalePick = r.pickBuf;           // what a renderer that never re-reads its cached buffer would hold
    wheel(r, 10, -1, -220, 20);      // 1.16^10 > 4: clamped to MAX_ZOOM; toward the rim's open sea
    settleFrame(r);
    const cam = r.cutaway.activeCamera;
    const ok = r.zoom.viewZoom === 4 && cam.zoom === 4 && r.zoom.showCamera && r.cutaway.showCamera
      && r.display.style.transform === 'none' && JSON.stringify(cam) === JSON.stringify(r.zoom.rendered);
    return [ok, `zoom ${r.zoom.viewZoom}, camera ${JSON.stringify(cam)}, shown ${r.cutaway.showCamera}, css ${r.display.style.transform}`];
  });
  {
    // Fixture: the harness's own projection (copied verbatim from the renderer).
    const D = H.makeDiscToGrid(r.focusLat, r.focusLon);
    const e = r.cutaway, g = e.geom, cam = e.activeCamera, bob = Math.round(e.bob);
    const flat = (x: number, y: number) => idOf(D((x - g.cx) / g.rx, (y - g.cyTop) / g.ry));
    const waterAround = (id: number) => {
      const row = Math.floor((id - 1) / GRID_SIZE), col = (id - 1) % GRID_SIZE;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        const c = r.grid[row + dr]?.[(col + dc + GRID_SIZE) % GRID_SIZE];
        if (!c || !isWater(c.biome)) return false;
      }
      return true;
    };
    const lookup = (buf: Int32Array | null, sx: number, sy: number) => buf ? buf[sy * VW + sx] ?? 0 : -1;
    let n = 0, viaTile = 0, viaCache = 0, viaStale = 0, cands = 0;
    const rej = { bnd: 0, water: 0 };
    const misses: string[] = [];
    // Integer world points; at zoom 4 with a 1/4-px focus each maps to a whole screen pixel.
    for (let wy = 1; wy < VH - 1 && n < 200; wy += 1) for (let wx = 1; wx < VW - 1 && n < 200; wx += 3) {
      const sp = worldToScreen(cam, VW, VH, wx, wy);
      if (sp.x < 0 || sp.y < 0 || sp.x >= VW || sp.y >= VH || !Number.isInteger(sp.x) || !Number.isInteger(sp.y)) continue;
      const want = flat(wx, wy);
      if (!want) continue;
      cands++;
      // Open sea (the cell and two rings around it are water, so the
      // sub-cell elevation is water too): the bake writes a water face
      // pixel's own cell to the pick whatever stands in front, so the flat
      // projection is the exact answer there. Off a cell boundary by a
      // float-rounding margin only.
      if (!waterAround(want)) continue;
      rej.water++;
      const q = 1e-3;
      if (flat(wx - q, wy) !== want || flat(wx + q, wy) !== want || flat(wx, wy - q) !== want || flat(wx, wy + q) !== want) continue;
      rej.bnd++;
      n++;
      // A real click: client px of the screen virtual pixel (CSS none after settle), bob included.
      const got = idOf(r.pickTile(sp.x * 960 / VW, (sp.y + bob) * 640 / VH));
      if (got === want) viaTile++; else if (misses.length < 3) misses.push(`w${wx},${wy}->s${sp.x},${sp.y}: ${got} vs ${want}`);
      if (lookup(r.pickBuf, sp.x, sp.y) === want) viaCache++;
      if (lookup(stalePick, sp.x, sp.y) === want) viaStale++;
    }
    check('click after settle at zoom 4 picks discToGrid(screenToWorld(p)) (200 pts)', n === 200 && viaTile === n,
      `${viaTile}/${n} agree (${cands} candidates, ${rej.water} in open sea, ${rej.bnd} of them off a boundary) ${misses.join('; ')}`);
    check('  the renderer\'s cached pick buffer is the active one after settle', n === 200 && viaCache === n && r.pickBuf === e.pick,
      `${viaCache}/${n} via the cached buffer`);
    check('  control: a stale cached (pre-settle) buffer resolves elsewhere', !(n === 200 && viaStale === n), `${viaStale}/${n} agree`);
  }

  // ── resize keeps camera and sim (Review focus 3) ─────────────────────────
  {
    const e = r.cutaway;
    let sim: any = null, cloud: Float32Array | null = null;
    tryCheck('resize: setup — pan saturated at the 960x640 clamp, camera shown', () => {
      r.zoom.panStart(0, 0, t += 4); r.zoom.panMove(0, 5000, t += 4); r.zoom.panEnd(t += 4);
      settleFrame(r);
      sim = e.weatherSim; cloud = Float32Array.from(sim.cloud);
      return [Math.abs(r.zoom.panY - 3 * 640 / 2) < 1e-9 && e.showCamera && !!sim, `panY ${r.zoom.panY}, shown ${e.showCamera}`];
    });
    tryCheck('resize while zoomed keeps the zoom, re-clamps the focus, keeps the sim', () => {
      sizeMount(r, 960, 400);
      r.resize();
      const z = r.zoom.viewZoom, bound = (z - 1) * 400 / 2, cam = e.activeCamera, half = r.VH / (2 * z);
      const simKept = e.weatherSim === sim && sim.cloud.every((v: number, i: number) => v === cloud![i]);
      const ok = z === 4 && r.VH === 200 && Math.abs(Math.abs(r.zoom.panY) - bound) < 1e-9
        && cam.zoom === 4 && cam.fy >= half - 1e-9 && cam.fy <= r.VH - half + 1e-9 && simKept;
      return [ok, `zoom ${z}, VH ${r.VH}, panY ${r.zoom.panY} (bound ${bound}), focus ${cam.fx},${cam.fy} (fy in [${half}, ${r.VH - half}]), sim kept ${simKept}`];
    });
    tryCheck('  after resize the camera layers are re-baked at the new size and shown', () => {
      const cs = e.camSet, cam = e.activeCamera;
      const want = applyCamera(e.geom, cam, r.VW, r.VH);
      const ok = !!cs && e.showCamera && cs.crust.width === r.VW && cs.crust.height === r.VH && cs.land.height === r.VH
        && cs.pick.length === r.VW * r.VH && JSON.stringify(cam) === JSON.stringify(r.zoom.rendered) && JSON.stringify(cs.geom) === JSON.stringify(want)
        && r.zoom.cssTransform() === 'none' && r.display.style.transform === 'none' && r.pickBuf === e.pick;
      return [ok, `camSet ${cs ? `${cs.crust.width}x${cs.crust.height}` : 'none'}, shown ${e.showCamera}, css ${r.display.style.transform}`];
    });
    const farDrawn = () => {
      const gg = new BgRec(new H.PixelCanvas(r.VW, r.VH));
      r.drawBackdropPanorama(gg);
      const Ws = Math.round(backdropWidth(r.VW) * farScale(e.activeCamera.zoom));
      return { ok: !!gg.first && gg.first[0] === `img${Ws}x${r.VH}`, got: gg.first?.[0], want: `img${Ws}x${r.VH}` };
    };
    tryCheck('  after resize the backdrop is the far panorama for this camera and size', () => {
      const f = farDrawn(), b = r.bgFarFor, cam = e.activeCamera;
      const ok = f.ok && !!b && b.zoom === cam.zoom && b.fy === cam.fy && b.H === r.VH;
      return [ok, `drew ${f.got} (want ${f.want}), baked for ${JSON.stringify(b)}`];
    });
    tryCheck('  control: the pre-change resize backdrop step alone draws the identity panorama', () => {
      r.bakeBackground();              // clears bgFarFor; nothing re-settles
      const f = farDrawn();
      return [!f.ok, `drew ${f.got}`];
    });
    tryCheck('  control: the pre-change resize path (bake()) replaces the sim', () => {
      r.bakeAll();
      return [e.weatherSim !== sim, `sim replaced ${e.weatherSim !== sim}`];
    });
  }

  // ── new planet resets the camera (Review focus 4) ───────────────────────
  {
    const e = r.cutaway;
    sizeMount(r, 960, 640); r.resize();
    r.refreshData(r.grid, r.biosphere, r.species, r.planet, r.star, 0);   // a clean start for this block
    const other: any = await H.makeRenderer('lava', 4);
    let sim0: any = null;
    tryCheck('new planet: setup — zoomed and settled', () => {
      wheel(r, 10, -1); settleFrame(r);
      sim0 = e.weatherSim;
      return [e.showCamera && r.zoom.viewZoom === 4 && !!sim0, `shown ${e.showCamera}, zoom ${r.zoom.viewZoom}`];
    });
    tryCheck('refreshData for a new planet while zoomed resets the camera, fresh sim', () => {
      r.refreshData(other.grid, other.biosphere, other.species, other.planet, other.star, 0);
      const ok = r.zoom.viewZoom === 1 && !r.zoom.showCamera && r.zoom.cssTransform() === 'none'
        && r.display.style.transform === 'none' && e.showCamera === false && isIdentity(e.camera, r.VW, r.VH)
        && e.camSet === null && !!e.weatherSim && e.weatherSim !== sim0 && r.planetType === 'lava';
      return [ok, `zoom ${r.zoom.viewZoom}, shown ${e.showCamera}, camera ${JSON.stringify(e.camera)}, css ${r.display.style.transform}, fresh sim ${e.weatherSim !== sim0}`];
    });
    tryCheck('  control: the pre-change refresh (bake only) leaves the view zoomed', () => {
      wheel(r, 10, -1); settleFrame(r);
      r.bakeAll();
      return [!(r.zoom.viewZoom === 1 && !r.zoom.showCamera), `zoom ${r.zoom.viewZoom}, controller shows camera ${r.zoom.showCamera}`];
    });
    r.refreshData(r.grid, r.biosphere, r.species, r.planet, r.star, 0);
  }

  // ── merged rebake: the 4 s surface rebake and a due settle, one frame ────
  {
    const e = r.cutaway;
    const order: string[] = [];
    const origCam = e.paintCameraSurface, origPlan = e.planIdentity;
    e.paintCameraSurface = function (this: any, s: any) { order.push('cam'); return origCam.call(this, s); };
    e.planIdentity = function (this: any) { order.push('id'); return origPlan.call(this); };
    /** Zoomed + settled, then a new gesture with the rebake due at the settle frame. */
    const arm = () => {
      wheel(r, 10, -1); settleFrame(r);
      wheel(r, 1, +1);                       // a new gesture (zoom out one notch)
      r.updateView(t += 1);                  // a mid-gesture frame: identity layers + CSS
      r.surfaceDirty = true; r.lastSurfaceBake = r.elapsed - 10;
      order.length = 0;
    };
    tryCheck('mid-gesture frame shows the identity layers under CSS', () => {
      wheel(r, 10, -1); settleFrame(r);
      wheel(r, 1, +1); r.updateView(t += 1);
      return [!e.showCamera && r.display.style.transform !== 'none' && r.pickBuf === e.pick,
        `shown ${e.showCamera}, css ${r.display.style.transform}`];
    });
    tryCheck('rebake + settle in one frame: one camera re-bake, after the identity re-plan', () => {
      arm();
      settleFrame(r);
      const ok = order.join(',') === 'id,cam' && !r.surfaceDirty && e.showCamera;
      return [ok, `paints [${order.join(',')}], dirty ${r.surfaceDirty}, shown ${e.showCamera}`];
    });
    tryCheck('  control: rebake then settle as separate steps re-bakes the camera set twice', () => {
      arm();
      r.bakeSurface();                       // the 4 s rebake on its own
      applySettle(e, r.zoom, t += SETTLE_MS + 1);
      const cams = order.filter(o => o === 'cam').length;
      return [!(cams === 1), `paints [${order.join(',')}]`];
    });
    e.paintCameraSurface = origCam; e.planIdentity = origPlan;
  }

  // ── the identity weather painter re-primes on return to identity ─────────
  {
    // Engine + controller only, driven exactly as the renderer drives them.
    const runRet = (bypass: boolean) => {
      const B = H.bakeEngine('ocean', 7);
      const e: any = B.engine, c = new ZoomController({ width: 960, height: 640 }, VW, VH);
      const g = new H.PixelCanvas(VW, VH).getContext() as unknown as CanvasRenderingContext2D;
      const noop = () => {};
      let el = 10;
      const frame = () => e.frame({ g, dt: 0.25, elapsed: el += 0.25, sunAzimuth: 0.6, sunLat: 0, viewZoom: c.viewZoom,
        drawBackdrop: noop, drawFarSpace: noop, drawSurfaceOverlays: noop, drawUiOverlays: noop, drawNearMoons: noop });
      let tt = T0;
      for (let i = 0; i < 8; i++) frame();
      for (let i = 0; i < 10; i++) c.wheel(0, 0, -1, tt += 4);
      applySettle(e, c, tt += SETTLE_MS + 1);
      const idp = e.weatherPainter;
      const frozen = new Set<string>();
      for (let q = 0; q < idp.pCount; q++) frozen.add(`${idp.pX[q]},${idp.pY[q]}`);
      for (let i = 0; i < 12; i++) frame();         // 3 s under the camera: the identity painter is frozen
      const frozenN = frozen.size;
      for (let i = 0; i < 40; i++) c.wheel(0, 0, +1, tt += 4);
      // Control: the same return with the painter's re-prime disabled (the pre-change painter).
      if (bypass) idp.reprime = () => {};
      applySettle(e, c, tt += SETTLE_MS + 1);
      let survivors = 0;
      for (let q = 0; q < idp.pCount; q++) if (frozen.has(`${idp.pX[q]},${idp.pY[q]}`)) survivors++;
      return { frozenN, survivors, live: idp.pCount, shown: e.showCamera, zoom: c.viewZoom, same: e.weatherPainter === idp };
    };
    tryCheck('back at zoom 1 the identity painter re-primes: no frozen drop survives', () => {
      const a = runRet(false);
      return [a.frozenN >= 20 && a.survivors === 0 && a.live > 0 && !a.shown && a.zoom === 1 && a.same,
        `${a.frozenN} frozen drops, ${a.survivors} survive, ${a.live} live after re-prime`];
    });
    tryCheck('  control: without the re-prime the frozen drops show again', () => {
      const b = runRet(true);
      return [!(b.frozenN >= 20 && b.survivors === 0), `${b.frozenN} frozen, ${b.survivors} survive`];
    });
  }

  // ── settle churn: 50 settles retain no camera set ────────────────────────
  {
    const gc = (globalThis as any).gc as (() => void) | undefined;
    const churn = (leak: unknown[] | null) => {
      const B = H.bakeEngine('ocean', 7);
      const e: any = B.engine, c = new ZoomController({ width: 960, height: 640 }, VW, VH);
      let tt = T0;
      const one = (i: number) => {
        c.wheel(0, 0, +1, tt += 4);
        for (let k = 0; k < 12; k++) c.wheel((i % 5) * 40 - 80, (i % 3) * 30 - 30, -1, tt += 4);
        applySettle(e, c, tt += SETTLE_MS + 1);
        if (leak) leak.push(e.camSet);
      };
      one(0); one(1);
      // Typed-array backing stores live outside the JS heap: count both.
      const mem = () => { const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
      gc?.(); const h0 = mem();
      for (let i = 2; i < 52; i++) one(i);
      gc?.(); const h1 = mem();
      const cs = e.camSet, p = cs.painter;
      // One camera set's own typed arrays: what leaking a single settle would retain.
      const arrays = [cs.occupancy, cs.pick, cs.shoreDist, p?.pX, p?.pY, p?.pGround, p?.pSpawn, p?.lut?.px, p?.lut?.py,
        p?.lut?.ground, p?.lut?.fx, p?.lut?.fy, p?.cell].filter(Boolean) as ArrayBufferView[];
      const setBytes = arrays.reduce((s, a) => s + a.byteLength, 0);
      return { grew: h1 - h0, setBytes, pmax: p?.pmax ?? 0, zoom: cs.camera.zoom };
    };
    tryCheck('settle churn: heap retained over 50 settles < one camera set', () => {
      if (!gc) return [false, 'run with node --expose-gc'];
      const a = churn(null);
      return [a.grew < a.setBytes, `+${(a.grew / 1048576).toFixed(2)} MB over 50 settles; one camera set ${(a.setBytes / 1048576).toFixed(2)} MB (pmax ${a.pmax}, zoom ${a.zoom.toFixed(2)})`];
    });
    tryCheck('  control: keeping every camera set exceeds it', () => {
      if (!gc) return [false, 'run with node --expose-gc'];
      const leak: unknown[] = [];
      const b = churn(leak);
      return [!(b.grew < b.setBytes), `+${(b.grew / 1048576).toFixed(2)} MB retained`];
    });
  }

  // ── the per-frame view step allocates nothing ────────────────────────────
  {
    const gc = (globalThis as any).gc as (() => void) | undefined;
    sizeMount(r, 960, 640);
    r.refreshData(r.grid, r.biosphere, r.species, r.planet, r.star, 0);
    wheel(r, 10, -1); settleFrame(r);
    const sink: unknown[] = [];
    const measure = (extra: boolean) => {
      let best = Infinity;
      for (let rep = 0; rep < 3; rep++) {
        gc?.(); const h0 = process.memoryUsage().heapUsed;
        for (let i = 0; i < 1000; i++) { r.updateView(t += 16); if (extra) sink.push(new Float64Array(8)); }
        best = Math.min(best, process.memoryUsage().heapUsed - h0);
        sink.length = 0;
      }
      return best;
    };
    tryCheck('view step: no per-frame allocation while settled', () => {
      if (!gc) return [false, 'run with node --expose-gc'];
      measure(false);   // warm-up
      const g0 = measure(false);
      return [g0 < 64 * 1024, `heap +${(g0 / 1024).toFixed(1)} KB per 1000 frames, best of 3`];
    });
    tryCheck('  control: one small array per frame is detected', () => {
      if (!gc) return [false, 'run with node --expose-gc'];
      const g1 = measure(true);
      return [g1 >= 64 * 1024, `heap +${(g1 / 1024).toFixed(1)} KB`];
    });
  }
}

console.log(failed === 0 ? '\n  all zoom checks passed\n' : `\n  ${failed} zoom check(s) FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
