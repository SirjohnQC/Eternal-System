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
    const glintWidth = (eng: any, geom: any, k: number, kPaint: number) => {
      const occ = eng.occupancy as Uint8Array, sd = eng.shoreDist as Float32Array;
      const img = { width: VW, height: VH, data: new Uint8ClampedArray(VW * VH * 4) };
      Eng.paintFluids(img as unknown as ImageData, geom, occ, 'ocean', H.ELAPSED, 0, sd, kPaint);
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
    check('strokes: water glint lines at zoom 4 are 1 px wide (median min run)', w4.n >= 50 && w4.med === 1,
      `zoom 4 median ${w4.med} px, mean ${w4.w.toFixed(2)} px over ${w4.n} open-water glint px; zoom 1 median ${w1.med}, mean ${w1.w.toFixed(2)} over ${w1.n}`);
    // Control: the zoom-1 glints magnified 4x nearest-neighbour (every width x 4).
    check('  control: zoom-1 glints magnified 4x are not 1 px wide', !(w1.n >= 50 && w1.med * 4 === 1),
      `median ${w1.med * 4} px, mean ${(w1.w * 4).toFixed(2)} px`);
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
    check('strokes: a rain streak is 3 px long and 1 px wide at zoom 4', s4.h === 3 && s4.w === 1,
      `${s4.w} x ${s4.h} px (${s4.n} px)`);
    // Control: the zoom-1 streak magnified 4x nearest-neighbour.
    const s1 = streak(id, 200, 100);
    check('  control: the zoom-1 streak magnified 4x is 12 px long, 4 wide', !(s1.h * 4 === 3 && s1.w * 4 === 1),
      `${s1.w * 4} x ${s1.h * 4} px`);

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

console.log(failed === 0 ? '\n  all zoom checks passed\n' : `\n  ${failed} zoom check(s) FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
