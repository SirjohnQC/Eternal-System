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

const { orbitSky, axialTilt, wrapPi, MAX_TILT } = await import('../src/rendering/sky/OrbitSky');
const { planetOffsetFromStar } = await import('../src/simulation/Orbit');

/** Orbit fixture. speed 0 freezes it at mean anomaly `angle`. */
const P = (r: number, angle: number, e = 0, peri = 0, speed = 0, genomeSeed = 1) =>
  ({ orbitalRadius: r, orbitalAngle: angle, orbitalSpeed: speed, eccentricity: e, periapsisAngle: peri, genomeSeed });
const muSpeed = (r: number) => 0.0012 / Math.sqrt(Math.max(0.5, r / 10));   // PLANET_ORBIT_MU at 60 Hz ticks

// ─── 2. Sky model ─────────────────────────────────────────────────────────────
console.log('\n  SKY MODEL');
{
  // Signed fixture: home at (10, 0), so the sun is due -x from it. A sibling
  // placed due -y of home is +90 deg of longitude from the sun: it sits at
  // sunAz + pi/2 and rises a quarter day after the sun.
  const home = P(10, 0);
  const sib = P(Math.hypot(10, 5), Math.atan2(-5, 10));
  const s = orbitSky({ animTick: 0, home, planets: [home, sib], dayAngle: 0 });
  const off = wrapPi(s.siblings[0].az - s.sun.az);
  const riseAt = orbitSky({ animTick: 0, home, planets: [home, sib], dayAngle: Math.PI / 2 }).siblings[0].az;
  check('sibling at +90 deg sits a quarter turn after the sun', Math.abs(off - Math.PI / 2) < 0.01 && Math.abs(riseAt - Math.PI / 2) < 0.01,
    `offset ${off.toFixed(3)} (want 1.571), az at d=pi/2 ${riseAt.toFixed(3)}`);
  check('  control: mirrored sign', Math.abs(-off - Math.PI / 2) >= 0.01, `mirrored ${(-off).toFixed(3)}`);

  // Random systems, against an independent signed angle from the raw offsets.
  let worst = 0, worstOld = 0, n = 0;
  let rng = 12345;
  const rnd = () => ((rng = Math.imul(rng ^ (rng >>> 15), 2246822519) + 0x6d2b79f5 | 0) >>> 0) / 4294967296;
  for (let trial = 0; trial < 200; trial++) {
    const hr = 20 + rnd() * 60;
    const homeP = P(hr, rnd() * TAU, rnd() * 0.3, rnd() * TAU, muSpeed(hr));
    const sibs = [0, 1, 2].map(() => { const r = 6 + rnd() * 120; return P(r, rnd() * TAU, rnd() * 0.4, rnd() * TAU, muSpeed(r)); });
    const tick = rnd() * 1e6, d = rnd() * TAU;
    const sky = orbitSky({ animTick: tick, home: homeP, planets: [homeP, ...sibs], dayAngle: d });
    const h = planetOffsetFromStar(homeP, tick);
    sky.siblings.forEach((sb, i) => {
      const so = planetOffsetFromStar(sb.planet, tick);
      const vx = so.x - h.x, vy = so.y - h.y, ux = -h.x, uy = -h.y;
      const truth = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);   // signed angle sun -> sibling
      worst = Math.max(worst, Math.abs(wrapPi(sb.az - sky.sun.az - truth)));
      // Control: the pre-2026-09-28 drawSiblings formula, against the same truth.
      const distN = Math.abs(sb.planet.orbitalRadius - hr) / Math.max(hr, 12);
      const oldAz = d + sb.planet.orbitalAngle + (tick / 60) * sb.planet.orbitalSpeed * (3.5 / (1 + distN)) + i * 1.9;
      worstOld = Math.max(worstOld, Math.abs(wrapPi(oldAz - sky.sun.az - truth)));
      n++;
    });
  }
  check('siblings at their real positions (signed)', worst < 0.01, `worst error ${worst.toFixed(4)} rad over ${n}`);
  check('  control: old drawSiblings formula', !(worstOld < 0.01), `worst ${worstOld.toFixed(2)} rad`);
}
{
  // Phases, against the phase angle from the law of cosines.
  const home = P(10, 0);
  const lawAngle = (sib: ReturnType<typeof P>) => {
    const h = planetOffsetFromStar(home, 0), s = planetOffsetFromStar(sib, 0);
    const a = Math.hypot(s.x, s.y), b = Math.hypot(h.x - s.x, h.y - s.y), c = Math.hypot(h.x, h.y);
    return Math.acos(Math.max(-1, Math.min(1, (a * a + b * b - c * c) / (2 * a * b))));
  };
  const litOf = (sib: ReturnType<typeof P>) => orbitSky({ animTick: 0, home, planets: [home, sib], dayAngle: 0 }).siblings[0];
  const inferior = P(5, 0.1), superior = P(5, Math.PI + 0.1);
  const lInf = litOf(inferior), lSup = litOf(superior);
  let outerMin = 1, agree = 0;
  for (let k = 0; k < 72; k++) {
    const o = P(20, (k / 72) * TAU), l = litOf(o);
    outerMin = Math.min(outerMin, l.litFraction);
    agree = Math.max(agree, Math.abs(l.litFraction - (1 + Math.cos(lawAngle(o))) / 2));
  }
  agree = Math.max(agree, Math.abs(lInf.litFraction - (1 + Math.cos(lawAngle(inferior))) / 2));
  check('phases: inner crescent, far side full, outer gibbous',
    lInf.litFraction < 0.2 && lSup.litFraction > 0.8 && outerMin >= 0.9 && agree < 1e-6,
    `inferior ${lInf.litFraction.toFixed(2)}, superior ${lSup.litFraction.toFixed(2)}, outer min ${outerMin.toFixed(2)}`);
  // Control: (1 + cos(elongation)) / 2 — the formula the first spec draft had.
  const elongInf = Math.abs(wrapPi(lInf.az - orbitSky({ animTick: 0, home, planets: [home], dayAngle: 0 }).sun.az));
  check('  control: elongation formula', !((1 + Math.cos(elongInf)) / 2 < 0.2), `gives ${((1 + Math.cos(elongInf)) / 2).toFixed(2)} at inferior conjunction`);
}
{
  // Seasons and size, sanity against Kepler fixtures.
  const e = 0.3, a = 10;
  const peri = orbitSky({ animTick: 0, home: P(a, 0, e), planets: [], dayAngle: 0 }).sun.sizeScale;
  const apo = orbitSky({ animTick: 0, home: P(a, Math.PI, e), planets: [], dayAngle: 0 }).sun.sizeScale;
  check('sun scale follows distance (Kepler fixture)', Math.abs(peri - 1 / (1 - e)) < 0.02 && Math.abs(apo - 1 / (1 + e)) < 0.02,
    `periapsis ${peri.toFixed(3)} (want ${(1 / (1 - e)).toFixed(3)}), apoapsis ${apo.toFixed(3)}`);
  const tilts = [1, 2, 3, 4, 5].map(axialTilt);
  const inRange = tilts.every(t => t >= 0 && t <= MAX_TILT) && axialTilt(3) === axialTilt(3) && new Set(tilts).size === 5;
  const yearHome = P(40, 0, 0.05, 1.0, muSpeed(40), 7);
  const T = TAU / yearHome.orbitalSpeed;
  let dMax = -9, dMin = 9;
  for (let k = 0; k <= 400; k++) {
    const dec = orbitSky({ animTick: (k / 400) * T, home: yearHome, planets: [], dayAngle: 0 }).declination;
    dMax = Math.max(dMax, dec); dMin = Math.min(dMin, dec);
  }
  const tilt = axialTilt(7);
  check('seasons swing +/- the tilt over a year', inRange && dMax > 0.98 * tilt && dMin < -0.98 * tilt && dMax <= tilt + 1e-9,
    `tilt ${(tilt * 180 / Math.PI).toFixed(1)} deg, declination ${(dMin * 180 / Math.PI).toFixed(1)}..${(dMax * 180 / Math.PI).toFixed(1)}`);
}
{
  // Review focus 1, 2, 4: huge clocks, no home, degenerate orbits, identity.
  const home = P(40, 0.3, 0.1, 0.5, muSpeed(40));
  const big = orbitSky({ animTick: 3e8, home, planets: [home, P(70, 1, 0.2, 2, muSpeed(70))], dayAngle: 5 });
  const finite = [big.sun.az, big.sun.sizeScale, big.sunLongitude, big.declination, ...big.siblings.flatMap(s => [s.az, s.litFraction])]
    .every(Number.isFinite);
  const none = orbitSky({ animTick: 5, home: null, planets: [], dayAngle: 1 });
  const flat = orbitSky({ animTick: 0, home: P(0, 0), planets: [], dayAngle: 1 });
  const clone = { ...home };
  const ids = orbitSky({ animTick: 0, home, planets: [home, clone], dayAngle: 0 });
  check('huge clock, no home, zero orbit, identity',
    finite && none.siblings.length === 0 && none.declination === 0 && Number.isFinite(flat.sun.sizeScale)
      && ids.siblings.length === 1 && ids.siblings[0].planet === clone,
    `finite ${finite}, no-home siblings ${none.siblings.length}, zero-orbit scale ${flat.sun.sizeScale}, siblings ${ids.siblings.length}`);
}

const { bakeBackdrop, backdropWidth, backdropOffset } = await import('../src/rendering/sky/Backdrop');

// ─── 3. Backdrop ──────────────────────────────────────────────────────────────
console.log('\n  BACKDROP');
{
  // Seam: the wrap (last column -> first) must look like any other neighbouring
  // pair. Compared with the 99th percentile, not the 90th: every column pair of
  // a seamless panorama is just another neighbour pair, so requiring seam <=
  // p90 on all 5 seeds fails by chance ~41% of the time. The old diagonal
  // layout's seam (a gradient mismatch) is far above star-driven column
  // differences and should still fail p99.
  const seamOf = (periodic: boolean, seed: number) => {
    const vw = 480, vh = 260, W = backdropWidth(vw);
    const img = { width: W, height: vh, data: new Uint8ClampedArray(W * vh * 4) };
    bakeBackdrop(img, { seed, vw, periodic });
    const col = (a: number, b: number) => {
      let s = 0;
      for (let y = 0; y < vh; y++) for (let c = 0; c < 3; c++) s += Math.abs(img.data[(y * W + a) * 4 + c] - img.data[(y * W + b) * 4 + c]);
      return s / vh;
    };
    const diffs: number[] = [];
    for (let x = 0; x < W - 1; x++) diffs.push(col(x, x + 1));
    diffs.sort((p, q) => p - q);
    return { seam: col(W - 1, 0), p99: diffs[Math.floor(diffs.length * 0.99)] };
  };
  const seeds = [1, 2, 3, 4, 5];
  const fresh = seeds.map(s => seamOf(true, s)), old = seeds.map(s => seamOf(false, s));
  check('backdrop wraps with no seam', fresh.every(r => r.seam <= r.p99),
    fresh.map(r => `${r.seam.toFixed(1)}/${r.p99.toFixed(1)}`).join(' '));
  check('  control: old diagonal layout', !old.every(r => r.seam <= r.p99),
    old.map(r => `${r.seam.toFixed(1)}/${r.p99.toFixed(1)}`).join(' '));

  // Turn: one panorama per orbital period, never backwards (offset rises =
  // the panorama moves left). Review focus 1: offset stays in [0, W).
  const W = backdropWidth(480);
  const home = P(40, 0, 0.05, 1.0, muSpeed(40));
  const T = TAU / home.orbitalSpeed;
  const turn = (tickOf: (k: number) => number) => {
    let prev = backdropOffset(orbitSky({ animTick: tickOf(0), home, planets: [], dayAngle: 0 }).sunLongitude, W);
    let sum = 0, back = 0, inRange = true;
    for (let k = 1; k <= 4000; k++) {
      const o = backdropOffset(orbitSky({ animTick: tickOf(k), home, planets: [], dayAngle: 0 }).sunLongitude, W);
      if (!(o >= 0 && o < W)) inRange = false;
      const inc = ((o - prev + W * 1.5) % W) - W / 2;
      if (inc < 0) back++;
      sum += inc; prev = o;
    }
    return { sum, back, inRange };
  };
  const real = turn(k => (k / 4000) * T);
  const huge = backdropOffset(orbitSky({ animTick: 3e8, home, planets: [], dayAngle: 0 }).sunLongitude, W);
  check('backdrop turns once per year, leftward', Math.abs(real.sum - W) <= 2 && real.back === 0 && real.inRange && huge >= 0 && huge < W,
    `advanced ${real.sum} px of ${W}, ${real.back} backward steps`);
  const ctl = turn(() => 0);
  check('  control: frozen clock', !(Math.abs(ctl.sum - W) <= 2), `advances ${ctl.sum} px`);
}

const { skyLayout, trackX, trackY, paintSky, sunDiameter, BLOOM_CORE, bloomCoreAlpha } = await import('../src/rendering/sky/SkyPainter');

// ─── 4. Sky painter ───────────────────────────────────────────────────────────
console.log('\n  SKY PAINTER');
const VW = 480, VH = 320, geom4 = habitableGeom(VW, VH), L = skyLayout(geom4, VW, VH);
const blank = () => ({ width: VW, height: VH, data: new Uint8ClampedArray(VW * VH * 4) });
const drawOf = (sky: ReturnType<typeof orbitSky>) => ({
  sunAz: sky.sun.az, sunElev: sky.sun.elev, sunSizeScale: sky.sun.sizeScale,
  sunRgb: [255, 236, 180] as [number, number, number],
  siblings: sky.siblings.map(s => ({ az: s.az, elev: s.elev, litFraction: s.litFraction, radiusPx: 3, rgb: [70, 140, 210] as [number, number, number] })),
});
/** Centroid and diameter of the fully opaque sun core. */
const sunDisc = (img: ReturnType<typeof blank>) => {
  let n = 0, sx = 0;
  for (let i = 0; i < VW * VH; i++) if (img.data[i * 4 + 3] === 255) { n++; sx += i % VW; }
  return { n, x: n ? sx / n : NaN, diameter: 2 * Math.sqrt(n / Math.PI) };
};
{
  // The sun is where the light comes from: +x side when cos d > 0, up when sin d > 0.
  let bad = 0, pinnedBad = 0, drawnOff = 0;
  // Control fixture: a sun pinned at screen x = 0.13 VW, always above the
  // horizon — solved as an azimuth so it can be rendered for real rather
  // than compared as a bare literal.
  const azPinned = Math.asin((0.13 * VW - L.cx) / L.A), elevPinned = Math.cos(azPinned);
  for (let k = 0; k < 48; k++) {
    const d = (k / 48) * TAU, sky = orbitSky({ animTick: 0, home: null, planets: [], dayAngle: d });
    const x = trackX(sky.sun.az, L), up = sky.sun.elev > 0;
    if (Math.abs(Math.cos(d)) > 0.05 && Math.sign(x - L.cx) !== Math.sign(Math.cos(d))) bad++;
    if (Math.abs(Math.sin(d)) > 0.02 && up !== Math.sin(d) > 0) bad++;
    // Control: render the pinned sun for real and measure its disc centroid.
    if (Math.abs(Math.cos(d)) > 0.05) {
      const pinnedImg = blank();
      paintSky(pinnedImg, L, { ...drawOf(sky), sunAz: azPinned, sunElev: elevPinned });
      const cxPinned = sunDisc(pinnedImg).x;
      if (Math.sign(cxPinned - L.cx) !== Math.sign(Math.cos(d))) pinnedBad++;
    }
    if (sky.sun.elev > 0.2) {
      const img = blank(); paintSky(img, L, drawOf(sky));
      if (Math.abs(sunDisc(img).x - trackX(sky.sun.az, L)) > 1) drawnOff++;
    }
  }
  check('sun sits over the lit side, set at night', bad === 0 && drawnOff === 0, `${bad} mismatches, ${drawnOff} discs off the track`);
  check('  control: pinned top-left sun', pinnedBad > 0, `${pinnedBad} mismatches`);
}
{
  // Rendered sun size: e = 0.3 fixture at periapsis and apoapsis, sun overhead.
  const at = (M: number, e: number, fixed = false) => {
    const home = P(10, M, e);
    const img = blank(); paintSky(img, L, drawOf(orbitSky({ animTick: 0, home, planets: [], dayAngle: Math.PI / 2 })), { fixedSunSize: fixed });
    return sunDisc(img).diameter;
  };
  const e = 0.3, want = (s: number) => sunDiameter(s);
  const peri = at(0, e), apo = at(Math.PI, e), c0 = at(0, 0), c1 = at(Math.PI, 0), fixedPeri = at(0, e, true);
  check('rendered sun grows at periapsis', Math.abs(peri - want(1 / (1 - e))) <= 1 && Math.abs(apo - want(1 / (1 + e))) <= 1 && peri - apo >= 2 && c0 === c1,
    `periapsis ${peri.toFixed(1)} px (want ${want(1 / (1 - e)).toFixed(1)}), apoapsis ${apo.toFixed(1)} (want ${want(1 / (1 + e)).toFixed(1)}), circular ${c0.toFixed(1)}/${c1.toFixed(1)}`);
  check('  control: fixed sun size', !(Math.abs(fixedPeri - want(1 / (1 - e))) <= 1), `${fixedPeri.toFixed(1)} px`);
}
{
  // Review focus 3: portrait. Every visible track point inside the frame.
  let outside = 0;
  for (const vw of [200, 320, 480, 640]) {
    const g = habitableGeom(vw, 360), Lp = skyLayout(g, vw, 360);
    for (let k = 0; k <= 180; k++) {
      const az = -Math.PI / 2 + (k / 180) * Math.PI, x = trackX(az, Lp), y = trackY(az, Lp);
      if (x < 0 || x >= vw || y < 0) outside++;
    }
  }
  check('sky track stays in frame (VW 200-640)', outside === 0, `${outside} points outside`);
}

{
  // Ruling 8: the renderer's wash (flat WASH_ALPHA*fade out to BLOOM_CORE,
  // then linear to 0 at t=1 — IsoDioramaRenderer.drawSunWash) and the
  // painter's own bloomCoreAlpha must composite, source-over same colour,
  // into one continuous glow profile with no seam at t = BLOOM_CORE.
  // washAt and pAt are written independently of the implementation (not the
  // exported WASH_ALPHA / coreProfile) so this actually checks the contract.
  const WASH_ALPHA = 0.07;
  const pAt = (t: number): number =>
    t < 0.10 ? 0.55 + (0.22 - 0.55) * (t / 0.10)
      : t < BLOOM_CORE ? 0.22 + (0.07 - 0.22) * ((t - 0.10) / 0.25)
      : 0.07 * (1 - (t - 0.35) / 0.65);
  const washAt = (t: number, fade: number): number => {
    const w = WASH_ALPHA * fade;
    return t <= BLOOM_CORE ? w : w * (1 - (t - BLOOM_CORE) / (1 - BLOOM_CORE));
  };
  const composite = (core: number, wash: number): number => 1 - (1 - core) * (1 - wash);

  let worst = 0;
  for (const fade of [1, 0.6, 0.2]) {
    for (let t = 0; t <= 0.5; t += 0.005) {
      const got = composite(bloomCoreAlpha(t, fade), washAt(t, fade));
      worst = Math.max(worst, Math.abs(got - pAt(t) * fade));
    }
  }
  const seam = bloomCoreAlpha(BLOOM_CORE - 1e-6, 1);
  check('sun glow composites without a seam', worst <= 0.002 && seam < 0.002,
    `worst mismatch ${worst.toFixed(4)}, seam alpha ${seam.toFixed(4)}`);

  // Control: the pre-Ruling-8 painter alpha (plain pAt(t)*fade for
  // t < BLOOM_CORE, 0 beyond) composited over the same wash double-counts
  // the core and must fail the match.
  let worstCtl = 0;
  for (const fade of [1, 0.6, 0.2]) {
    for (let t = 0; t <= 0.5; t += 0.005) {
      const oldAlpha = t < BLOOM_CORE ? pAt(t) * fade : 0;
      const got = composite(oldAlpha, washAt(t, fade));
      worstCtl = Math.max(worstCtl, Math.abs(got - pAt(t) * fade));
    }
  }
  check('  control: core drawn over the wash unadjusted', !(worstCtl <= 0.002), `worst mismatch ${worstCtl.toFixed(4)}`);
}

console.log(failed === 0 ? '\n  all sky checks passed\n' : `\n  ${failed} sky check(s) FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
