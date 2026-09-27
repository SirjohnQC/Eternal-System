/**
 * Does the atmosphere read as air, or as a pasted ring?
 *
 * Runs over SEVERAL planet types, not one. An earlier version hardcoded
 * `ocean`; the lava-pink-sky regression this gate exists to catch therefore
 * never rendered lava, and only a manual look found it.
 *
 * Measurements, each with a control that PASSES on the pre-fix renderer
 * (i.e. confirms the defect is present and measurable):
 *
 *   1. seam        max alpha RATIO between adjacent pixels across the face edge
 *   2. chroma      RGB distance between the sunlit limb and the shadowed limb —
 *                  "the scatter actually varies by wavelength", not a hue angle.
 *                  A prior hueSplit-in-degrees version rewarded rotating hue as
 *                  far as possible, which wrapped warm-hued worlds (lava) into
 *                  magenta. Chroma distance plus a hue-sanity check (default
 *                  mode only — it guards the fix, it is not a defect present
 *                  today) replaces it.
 *   3. equivWidth  p90 - p10 of the shell's equivalent width, swept every 3
 *                  degrees around the limb. A max-minus-min of "last pixel
 *                  above alpha 2" over six discrete angles sat one
 *                  discretization step from flipping its own verdict, which
 *                  invites tuning the renderer's constants at the metric
 *                  instead of at the picture. A density-normalised width over
 *                  ~60 angles moves with the wobble, not with where the samples
 *                  happened to land or how dense the air is.
 *   4. aerialFall  alpha 20% inward DIVIDED BY alpha 35% inward — is there a
 *                  real aerial-perspective gradient, or a flat floor? A ratio,
 *                  not a difference: air of density 0.7 legitimately paints
 *                  ~70% of the alpha of air of density 1.0, so an absolute
 *                  delta demands that thin air be as thick as dense air and
 *                  fails desert and carbon for being thin. Both samples sit
 *                  inside the aerial band on the shadowed side, where `lit` is
 *                  clamped constant — 60% inward had begun climbing the
 *                  day-side lighting gradient instead.
 *
 * The hue baseline is the GENOME's hue for the type, not a rendered pixel: a
 * rendered pixel is already warm/cool blended, so drift measured against one
 * understates how far the air has moved from the planet's own colour.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/atmosphereCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/atmo.mjs && node /tmp/atmo.mjs [--control]
 */
const CONTROL = process.argv.includes('--control');
const ROLLED = process.argv.includes('--rolled');
const BENCH = process.argv.includes('--bench');

/** Cool and dense, hot and dense, warm and thin — three air channels. */
const TYPES = ['ocean', 'lava', 'desert'] as const;

// Minimal ImageData stand-in — the renderer only touches width/height/data.
class FakeImageData {
  data: Uint8ClampedArray;
  constructor(public width: number, public height: number) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}
(globalThis as any).ImageData = FakeImageData;

const { paintAtmosphere } = await import('../src/rendering/HabitableCutawayEngine');
const { genomeFromLegacy, rollPlanetGenome, genomeSeedFor } =
  await import('../src/simulation/PlanetGenome');
type Air = ReturnType<typeof genomeFromLegacy>['atmosphere'];

if (BENCH) {
  // Fixed geometry literal, so later layout changes compare like with like.
  const BW = 1200, BH = 800;
  const bgeom: any = { cx: 600, cyTop: 255, rx: 262, ry: 136 };
  const img = new FakeImageData(BW, BH);
  const times: number[] = [];
  for (let i = 0; i < 30; i++) {
    img.data.fill(0);
    const t0 = performance.now();
    paintAtmosphere(img as any, bgeom, 'ocean' as any, 0, 0.7, 1);
    const t1 = performance.now();
    if (i >= 5) times.push(t1 - t0);
  }
  times.sort((a, b) => a - b);
  console.log(`  bench paintAtmosphere 1200x800 ocean: median ${times[12].toFixed(2)} ms (p10 ${times[2].toFixed(2)}, p90 ${times[22].toFixed(2)})`);
  process.exit(0);
}

const W = 420, H = 320;
const geom: any = { cx: 210, cyTop: 150, rx: 130, ry: 65 };

function hueOf([r, g, b]: number[]): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d === 0) return 0;
  let h: number;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}
const dh = (a: number, b: number) => {
  const d = Math.abs(a - b);
  return d > 180 ? 360 - d : d;
};

interface Metrics {
  seam: number; chroma: number; hueDrift: number; litHue: number; familyDrift: number;
  thickSpread: number; aerialFall: number; nearAlpha: number;
  shelf: number; bandPixels: number; bandStep: number;
}

function measure(type: string, air?: Air): Metrics {
  const img = new FakeImageData(W, H);
  paintAtmosphere(img as any, geom, type as any, 0, 0, 1, undefined, air);
  const A = (x: number, y: number) => img.data[(y * W + x) * 4 + 3];
  const RGB = (x: number, y: number) => {
    const o = (y * W + x) * 4;
    return [img.data[o], img.data[o + 1], img.data[o + 2]];
  };

  // 1. seam — biggest adjacent-pixel alpha RATIO across the face-ellipse edge.
  //    A ratio, not a difference: absolute alphas here are small (~10-20), so a
  //    4x jump is only ~15 in absolute terms and an absolute threshold misses it.
  //    Sampled at four columns because the boundary is an ellipse and the centre
  //    column alone undersamples it.
  let seam = 1;
  for (const frac of [0, 0.3, 0.55, 0.75]) {
    const x = Math.round(geom.cx + geom.rx * frac);
    for (let y = geom.cyTop - geom.ry - 14; y < geom.cyTop + geom.ry + 14; y++) {
      if (y < 1 || y >= H - 1) continue;
      // The seam is the face/dome crossfade. The rim band below the rim line
      // and outside the face has its own fade metric (bandStep); its tail
      // (14, 6, 0) would read here as a ratio on near-zero alphas.
      const fxs = (x - geom.cx) / geom.rx, fyb = (y + 1 - geom.cyTop) / geom.ry;
      if (y + 1 > geom.cyTop && fxs * fxs + fyb * fyb > 1) continue;
      const a = A(x, y), b = A(x, y + 1);
      if (a > 2 && b > 2) seam = Math.max(seam, Math.max(a, b) / Math.min(a, b));
    }
  }

  // 2. chroma — how far apart the lit and shadow limbs are in COLOUR, not in hue
  //    angle. The old hue-split metric rewarded rotating the hue as far as
  //    possible, which wrapped warm worlds into magenta. Distance captures "the
  //    scatter actually varies by wavelength" without demanding a hue rotation.
  const litC = RGB(geom.cx + geom.rx - 2, geom.cyTop);
  const darkC = RGB(geom.cx - geom.rx + 2, geom.cyTop);
  const chroma = Math.round(Math.hypot(
    litC[0] - darkC[0], litC[1] - darkC[1], litC[2] - darkC[2]));

  // 2b. hue sanity — neither limb may wander out of the planet's colour family.
  const baseHue = (air ?? genomeFromLegacy(type, 0).atmosphere).hue;
  const hueDrift = Math.max(dh(hueOf(litC), baseHue), dh(hueOf(darkC), baseHue));
  // 2c. family — the same limbs against the TYPE's hue, not the rolled one.
  //    hueDrift above is measured against this world's own rolled hue, so it
  //    cannot see the roll itself leaving the type's colour family (a lava
  //    world rolled to hue 2 rendered salmon-pink and passed everything).
  const familyHue = genomeFromLegacy(type, 0).atmosphere.hue;
  const familyDrift = Math.max(dh(hueOf(litC), familyHue), dh(hueOf(darkC), familyHue));
  const litHue = hueOf(litC);

  // 3. thickness — the shell's EQUIVALENT WIDTH past the rim: the alpha profile
  //    along an outward ray, integrated and divided by the alpha at the rim.
  //    Swept every 3 degrees and reported as a percentile spread, so no single
  //    unlucky angle decides the verdict.
  //
  //    Not "last pixel above alpha 2": that cutoff moves with density, so dense
  //    air (lava) reads its whole shell out on the flat tail and its angular
  //    variation compresses to near the quantization step. Dividing by the rim
  //    alpha cancels both density and the per-angle lighting term, leaving the
  //    shape of the profile — which is what the wobble actually changes.
  const thick: number[] = [];
  const STEP = 0.25;
  for (let ang = -Math.PI + 0.12; ang <= -0.12; ang += Math.PI / 60) {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const rimA = A(Math.round(geom.cx + ca * geom.rx), Math.round(geom.cyTop + sa * geom.rx));
    if (rimA < 4) continue;
    let sum = 0;
    for (let t = 0; t <= 40; t += STEP) {
      const x = Math.round(geom.cx + ca * (geom.rx + t));
      const y = Math.round(geom.cyTop + sa * (geom.rx + t));
      if (x < 0 || y < 0 || x >= W || y >= H) break;
      sum += A(x, y);
    }
    thick.push((sum * STEP) / rimA);
  }
  thick.sort((a, b) => a - b);
  const pct = (p: number) => thick[Math.min(thick.length - 1,
    Math.max(0, Math.round(p * (thick.length - 1))))];
  const thickSpread = pct(0.90) - pct(0.10);

  // 4. aerialFall — a gradient inside the rim, or a flat floor?
  //    The pre-fix renderer decayed to a constant additive tint a little way in
  //    and then sat on it. That constant is not aerial perspective. Each sample
  //    is the mean of a short vertical run: single pixels here are alphas in the
  //    3-15 range, so integer quantization alone moves a ratio by 30%.
  const at = (fracIn: number) => {
    const x = Math.round(geom.cx - geom.rx + geom.rx * fracIn);
    let sum = 0, n = 0;
    for (let dy = -6; dy <= 6; dy++) { sum += A(x, geom.cyTop + dy); n++; }
    return sum / n;
  };
  const nearAlpha = at(0.20);
  const aerialFall = nearAlpha / Math.max(0.5, at(0.35));

  // 5. shelf — does the limb stop dead on the rim line? Just outside the dome
  //    radius on each side, alpha ON the rim row vs the mean of the three rows
  //    below. Pre-fix the rows below are 0 (ozoneAt cut `y > cy && face > 1`),
  //    so the ratio is the full rim alpha. Only samples with a visible rim
  //    count, or a ratio of two near-zero alphas decides the verdict.
  const cy = geom.cyTop;
  let shelf = 1;
  for (const side of [-1, 1]) {
    for (let k = 1; k <= 4; k++) {
      const x = Math.round(geom.cx + side * (geom.rx + k));
      const top = A(x, cy);
      if (top < 6) continue;
      const below = (A(x, cy + 1) + A(x, cy + 2) + A(x, cy + 3)) / 3;
      shelf = Math.max(shelf, top / Math.max(1, below));
    }
  }

  // 6. bandPixels — does the band continue round the rim at all? Visible
  //    pixels outside the face ellipse and below the rim line.
  // 7. bandStep — and when it ends, does it fade or cut? The largest absolute
  //    alpha drop between vertically adjacent band pixels, RELATIVE to the
  //    sharpest outward drop on the dome's own limb above the rim line. "No
  //    sharper than the edge it continues." A ratio of adjacent alphas was
  //    tried first and is the wrong dimension: at the tail of any linear fade
  //    the last visible pixel over a zero is an unbounded ratio, so a soft
  //    4-px fade (107, 74, 42, 15, 0) scored 15.
  let domeStep = 1;
  for (let y = cy - 30; y < cy; y++) {
    for (const side of [-1, 1]) {
      for (let k = -6; k <= 20; k++) {
        const x = Math.round(geom.cx + side * (geom.rx + k));
        const xn = x + side;
        if (x < 0 || xn < 0 || x >= W || xn >= W) continue;
        domeStep = Math.max(domeStep, A(x, y) - A(xn, y));
      }
    }
  }
  let bandPixels = 0, maxDrop = 0;
  const outside = (x: number, y: number) => {
    const fx = (x - geom.cx) / geom.rx, fy = (y - cy) / geom.ry;
    return fx * fx + fy * fy > 1;
  };
  for (let y = cy + 1; y <= cy + geom.ry && y < H - 1; y++) {
    for (let x = geom.cx - geom.rx - 40; x <= geom.cx + geom.rx + 40; x++) {
      if (x < 0 || x >= W || !outside(x, y)) continue;
      const a = A(x, y);
      if (a >= 3) bandPixels++;
      maxDrop = Math.max(maxDrop, a - A(x, y + 1));
    }
  }
  const bandStep = maxDrop / domeStep;

  return { seam, chroma, hueDrift, litHue, familyDrift, thickSpread, aerialFall, nearAlpha, shelf, bandPixels, bandStep };
}

// Calibrated from both populations, measured per type. Pre-fix renderer
// (898a4c6) vs today, over ocean / lava / desert:
//
//   seam        2.67 - 2.85   vs  1.17 - 1.25     threshold 2.0
//   chroma      0             vs  121  - 124      threshold 40
//   equivWidth  0.24 - 0.29   vs  2.05 - 3.84     threshold 1.2
//   aerialFall  1.00          vs  2.19 - 2.52     threshold 1.6
//
// The equiv-width threshold sits 4x above the flat-shell floor and 1.7x below
// the tightest passing type, so neither verdict rides on a sampling accident.
const WANT_SEAM = 2.0, WANT_CHROMA = 40, MAX_HUE_DRIFT = 45;
const WANT_THICK = 1.2, WANT_FALL = 1.6, MIN_NEAR_ALPHA = 4;
// Shelf: same ratio scale as `seam`. bandPixels: at least ry visible pixels
// across both sides — a band a few px wide running a fraction of the rim.
// bandStep: the band's sharpest drop may be at most 1.25x the dome limb's own.
const WARM_HUE_MIN = 10;
const WANT_SHELF = 2.0, MIN_BAND_PIXELS = geom.ry, MAX_BAND_STEP = 1.25;

let failed = 0;
const assert = (type: string, n: string, ok: boolean, d: string) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${type}] ${n} — ${d}`);
  if (!ok) failed++;
};

console.log(CONTROL
  ? '\n  CONTROL — asserting the defects ARE present. Passes only on the pre-fix renderer.'
  : '\n  Asserting the atmosphere reads as air, on every type.');

for (const type of TYPES) {
  const m = measure(type);
  console.log(`\n  ${type}`);
  console.log(`    seam (max adjacent alpha ratio)        : ${m.seam.toFixed(2)}`);
  console.log(`    chroma distance (lit vs shadow limb)   : ${m.chroma}`);
  console.log(`    hue drift from genome hue              : ${m.hueDrift.toFixed(1)} deg`);
  console.log(`    equiv-width spread p90-p10 (px)        : ${m.thickSpread.toFixed(2)}`);
  console.log(`    aerial falloff (a@20% / a@35%)         : ${m.aerialFall.toFixed(2)}`
    + `  (a@20% = ${m.nearAlpha.toFixed(1)})`);
  console.log(`    shelf (rim row / rows below)           : ${m.shelf.toFixed(2)}`);
  console.log(`    band below rim: pixels / step vs limb  : ${m.bandPixels} / ${m.bandStep.toFixed(2)}`);
  if (CONTROL) {
    assert(type, 'seam is visible', m.seam > WANT_SEAM,
      `${m.seam.toFixed(2)} > ${WANT_SEAM}`);
    assert(type, 'no chroma split', m.chroma < WANT_CHROMA,
      `${m.chroma} < ${WANT_CHROMA}`);
    assert(type, 'thickness is uniform', m.thickSpread <= WANT_THICK,
      `${m.thickSpread.toFixed(2)} <= ${WANT_THICK}`);
    assert(type, 'inner falloff is flat', m.aerialFall < WANT_FALL,
      `${m.aerialFall.toFixed(2)} < ${WANT_FALL}`);
    // The shelf control passes on renderers before the atmosphere-pass commit;
    // the four above only on 898a4c6 and earlier. Run it against the matching
    // old renderer via `git show <sha>:src/rendering/HabitableCutawayEngine.ts`.
    assert(type, 'limb stops on the rim line', m.shelf > WANT_SHELF,
      `${m.shelf.toFixed(2)} > ${WANT_SHELF}`);
    assert(type, 'no band below the rim', m.bandPixels < MIN_BAND_PIXELS,
      `${m.bandPixels} < ${MIN_BAND_PIXELS}`);
  } else {
    assert(type, 'no visible seam', m.seam <= WANT_SEAM,
      `${m.seam.toFixed(2)} <= ${WANT_SEAM}`);
    assert(type, 'warm/cool chroma split', m.chroma >= WANT_CHROMA,
      `${m.chroma} >= ${WANT_CHROMA}`);
    assert(type, 'air keeps its colour family', m.hueDrift <= MAX_HUE_DRIFT,
      `${m.hueDrift.toFixed(1)} <= ${MAX_HUE_DRIFT}`);
    assert(type, 'thickness varies', m.thickSpread > WANT_THICK,
      `${m.thickSpread.toFixed(2)} > ${WANT_THICK}`);
    assert(type, 'aerial gradient exists', m.aerialFall >= WANT_FALL,
      `${m.aerialFall.toFixed(2)} >= ${WANT_FALL}`);
    // A ratio computed on near-zero alphas would pass on nothing at all.
    assert(type, 'the veil is actually there', m.nearAlpha >= MIN_NEAR_ALPHA,
      `a@20% ${m.nearAlpha.toFixed(1)} >= ${MIN_NEAR_ALPHA}`);
    assert(type, 'no shelf at the rim line', m.shelf <= WANT_SHELF,
      `${m.shelf.toFixed(2)} <= ${WANT_SHELF}`);
    assert(type, 'limb continues round the rim', m.bandPixels >= MIN_BAND_PIXELS,
      `${m.bandPixels} >= ${MIN_BAND_PIXELS}`);
    assert(type, 'band fades out, no new cut', m.bandStep <= MAX_BAND_STEP,
      `${m.bandStep.toFixed(2)} <= ${MAX_BAND_STEP}`);
  }
}

if (ROLLED) {
  console.log('\n  ROLLED — every seed must pass, not the median. 12 seeds per type.');
  for (const type of TYPES) {
    const rows: Metrics[] = [];
    for (let i = 0; i < 12; i++) {
      const air = rollPlanetGenome(genomeSeedFor(100 + i, 0), type, null).atmosphere;
      const m = measure(type, air);
      rows.push(m);
      const bad: string[] = [];
      if (m.seam > WANT_SEAM) bad.push(`seam ${m.seam.toFixed(2)}`);
      if (m.chroma < WANT_CHROMA) bad.push(`chroma ${m.chroma}`);
      if (m.hueDrift > MAX_HUE_DRIFT) bad.push(`hueDrift ${m.hueDrift.toFixed(1)}`);
      if (m.thickSpread <= WANT_THICK) bad.push(`thick ${m.thickSpread.toFixed(2)}`);
      if (m.aerialFall < WANT_FALL) bad.push(`fall ${m.aerialFall.toFixed(2)}`);
      if (m.nearAlpha < MIN_NEAR_ALPHA) bad.push(`near ${m.nearAlpha.toFixed(1)}`);
      // Warm air must stay out of pink: the sunlit limb of a lava or desert
      // world keeps an orange-family hue (the legacy lava limb renders at ~20).
      if ((type === 'lava' || type === 'desert') && (m.litHue < WARM_HUE_MIN || m.litHue > 60)) {
        bad.push(`lit hue ${m.litHue.toFixed(1)} outside warm family [${WARM_HUE_MIN}, 60]`);
      }
      if (m.shelf > WANT_SHELF) bad.push(`shelf ${m.shelf.toFixed(2)}`);
      if (m.bandPixels < MIN_BAND_PIXELS) bad.push(`band ${m.bandPixels}`);
      if (m.bandStep > MAX_BAND_STEP) bad.push(`bandStep ${m.bandStep.toFixed(2)}`);
      if (bad.length) { failed++; console.log(`  FAIL  [${type} seed#${i}] ${bad.join(', ')}  (thickness ${air.thicknessPx}px, density ${air.density.toFixed(2)})`); }
    }
    const span = (k: keyof Metrics) => {
      const v = rows.map(r => r[k] as number).sort((a, b) => a - b);
      return `${v[0].toFixed(2)} / ${v[6].toFixed(2)} / ${v[11].toFixed(2)}`;
    };
    console.log(`  ${type}  litHue ${span('litHue')}  familyDrift ${span('familyDrift')}`);
    console.log(`  ${type}  min/median/max  seam ${span('seam')}  chroma ${span('chroma')}  hueDrift ${span('hueDrift')}  thick ${span('thickSpread')}  fall ${span('aerialFall')}`);
  }
}

process.exit(failed === 0 ? 0 : 1);
