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

console.log('\n  IDENTITY (Task 3: sub-cell elevation is the one declared difference)');
{
  const { renderLayers, hashImage, nearestClassMap, boundaryBand, LAYERS } = await import('./zoomHarness');
  const goldens = (await import('./zoomGoldens.json')).default as Record<string, Record<string, string>>;
  // Layers the sub-cell change may touch: the surface and occupancy readers,
  // and the weather (its ground lift). Everything else must hash identical.
  const MAY_DIFFER = new Set(['crust', 'land', 'fluids', 'dayNight', 'weather']);
  const SHARE_MAX = 0.02;

  interface Verdict { ok: boolean; lines: string[] }
  /** Compare `got` to the nearest-cell render `ref` (which must equal the goldens). */
  const judge = (type: string, got: Record<string, Uint8ClampedArray>, ref: Record<string, Uint8ClampedArray>, band: Uint8Array): Verdict => {
    let ok = true; const lines: string[] = [];
    for (const layer of LAYERS) {
      const g = got[layer], r = ref[layer];
      if (hashImage(g) === goldens[type][layer]) { lines.push(`${layer}: identical`); continue; }
      if (!MAY_DIFFER.has(layer) || g.length !== r.length || r.length !== band.length * 4) {
        ok = false; lines.push(`${layer}: DIFFERS (not allowed to)`); continue;
      }
      let nonEmpty = 0, diff = 0, outside = 0;
      for (let i = 0, p = 0; i < r.length; i += 4, p++) {
        if (r[i + 3] > 0) nonEmpty++;
        if (r[i] !== g[i] || r[i + 1] !== g[i + 1] || r[i + 2] !== g[i + 2] || r[i + 3] !== g[i + 3]) {
          diff++; if (!band[p]) outside++;
        }
      }
      const share = nonEmpty ? diff / nonEmpty : Infinity;
      const good = share < SHARE_MAX && outside === 0;
      if (!good) ok = false;
      lines.push(`${layer}: ${diff} px differ = ${(share * 100).toFixed(3)}% of ${nonEmpty} non-empty, ${outside} outside the 2 px boundary band${good ? '' : '  <-- FAIL'}`);
    }
    return { ok, lines };
  };

  for (const type of Object.keys(goldens)) {
    const ref = renderLayers(type, 7, { subCell: false });
    const refSame = LAYERS.filter(l => hashImage(ref[l]) === goldens[type][l]).length;
    check(`${type}: nearest-cell path hashes identical to the goldens`, refSame === LAYERS.length, `${refSame}/${LAYERS.length} layers`);
    const band = boundaryBand(nearestClassMap(type, 7));
    const v = judge(type, renderLayers(type, 7), ref, band);
    check(`${type}: identity render differs only on coast/terrace edges`, v.ok, '');
    for (const l of v.lines) console.log(`          ${l}`);
    if (type !== 'gas') {  // gas never reads rimFalloff
      const c = judge(type, renderLayers(type, 7, { rimPerturb: 0.02 }), ref, band);
      check(`  control: ${type} rimFalloff + 0.02 fails the same bar`, !c.ok, '');
      for (const l of c.lines) console.log(`          ${l}`);
    }
  }
}

console.log(failed === 0 ? '\n  all zoom checks passed\n' : `\n  ${failed} zoom check(s) FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
