/**
 * Does the sky tell the truth about the orbit?
 *
 * Every claim is checked against an independent fixture or rendered pixels,
 * never against the value it was computed from, and has a control that must
 * FAIL. A metric that cannot fail on its control is measuring something else.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/skyCheck.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/sky.mjs" --log-level=error && node "$TEMP/sky.mjs"
 */
// HabitableCutawayEngine creates canvases at module scope in some paths.
(globalThis as any).document = { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => null }) };
const { paintDayNight, habitableGeom } = await import('../src/rendering/HabitableCutawayEngine');
const { moonShade, NIGHT_MAX } = await import('../src/rendering/sky/SunLight');

let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(48)} ${detail}`);
  if (!ok) failed++;
}
function corr(a: number[], b: number[]): number {
  const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(Math.max(1e-12, da * db));
}
const TAU = Math.PI * 2;
const DAY = [...Array(24).keys()].map(i => (i / 24) * TAU);

// ─── 1. Light ─────────────────────────────────────────────────────────────────
console.log('\n  LIGHT');
{
  const W = 480, H = 320, geom = habitableGeom(W, H);
  const img = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  const veil: number[] = [], oldVeil: number[] = [];
  let maxA = 0;
  for (const d of DAY) {
    img.data.fill(0);
    paintDayNight(img as any, geom, d, 0);
    let sum = 0, oSum = 0, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = (x - geom.cx) / geom.rx, dy = (y - geom.cyTop) / geom.ry;
      if (dx * dx + dy * dy > 1) continue;
      n++;
      const a = img.data[(y * W + x) * 4 + 3];
      sum += a / 255; if (a > maxA) maxA = a;
      // Control: the pre-2026-09-28 veil, cos only.
      const day = Math.min(1, Math.max(0, 0.38 + dx * Math.cos(d) * 0.9)), night = 1 - day;
      oSum += night < 0.06 ? 0 : night * 0.58;
    }
    veil.push(sum / n); oldVeil.push(oSum / n);
  }
  const elev = DAY.map(d => Math.sin(d));
  const r = corr(veil.map(v => -v), elev), rOld = corr(oldVeil.map(v => -v), elev);
  check('disc brightens with the sun elevation', r >= 0.9, `r ${r.toFixed(2)} >= 0.9`);
  check('  control: cos-only veil', !(rOld >= 0.9), `r ${rOld.toFixed(2)}`);
  const noon = veil[6], midnight = veil[18];
  check('midnight clearly darker than noon', midnight - noon >= 0.25,
    `mean veil noon ${noon.toFixed(2)} midnight ${midnight.toFixed(2)}`);
  check('soft night: veil never past NIGHT_MAX', maxA <= Math.round(NIGHT_MAX * 255) + 1,
    `max alpha ${maxA} <= ${Math.round(NIGHT_MAX * 255)}`);
}
{
  // Moons: the dark side faces away from the sun, deeper at night.
  let bad = 0, ctrlBad = 0;
  for (const d of DAY) {
    const c = Math.cos(d);
    if (Math.abs(c) < 0.2) continue;
    if (Math.sign(moonShade(d).offset) !== -Math.sign(c)) bad++;
    if (Math.sign(-0.3) !== -Math.sign(c)) ctrlBad++;          // control: fixed -x shadow
  }
  const deeper = moonShade(1.5 * Math.PI).alpha > moonShade(0.5 * Math.PI).alpha;
  check('moons shaded away from the sun', bad === 0 && deeper, `${bad} wrong sides, night deeper ${deeper}`);
  check('  control: fixed -x shadow', ctrlBad > 0, `${ctrlBad} wrong sides`);

  // Terminator must be identical to the pre-2026-09-28 fixed picture at
  // sunrise, sunset and all night: alpha 0.6, offset -0.3. Math.sin(Math.PI)
  // is ~1.2e-16, not exactly 0, so compare with a tight epsilon rather than
  // strict ===.
  const sunrise = moonShade(0), sunset = moonShade(Math.PI);
  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  const terminatorOk = eq(sunrise.alpha, 0.6) && eq(sunset.alpha, 0.6) && eq(sunrise.offset, -0.3);
  check('moon terminator matches pre-change picture at d=0/pi', terminatorOk,
    `sunrise alpha ${sunrise.alpha} offset ${sunrise.offset}, sunset alpha ${sunset.alpha}`);
}

console.log(failed === 0 ? '\n  all sky checks passed\n' : `\n  ${failed} sky check(s) FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
