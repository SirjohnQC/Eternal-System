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

console.log(failed === 0 ? '\n  all zoom checks passed\n' : `\n  ${failed} zoom check(s) FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
