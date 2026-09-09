/**
 * Does the atmosphere read as air, or as a pasted ring?
 *
 * Four measurements, each with a control that PASSES on the shipped renderer
 * (i.e. confirms the defect is present and measurable):
 *
 *   1. seam        max alpha RATIO between adjacent pixels across the face edge
 *   2. hueSplit    hue difference between the sunlit limb and the shadowed limb
 *   3. thickness   variance of shell thickness around the limb
 *   4. innerFall   alpha 20% inward minus alpha 60% inward — is there a real
 *                  aerial-perspective gradient, or a flat floor?
 *
 * Measured on the shipped renderer at rx=130, ry=65. The thresholds below are
 * calibrated against these — re-measure if the geometry changes:
 *   seam 2.67  ·  hueSplit 0.0 deg  ·  thickness variance 1 px  ·  innerFall 2
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/atmosphereCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/atmo.mjs && node /tmp/atmo.mjs [--control]
 */
const CONTROL = process.argv.includes('--control');

// Minimal ImageData stand-in — the renderer only touches width/height/data.
class FakeImageData {
  data: Uint8ClampedArray;
  constructor(public width: number, public height: number) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}
(globalThis as any).ImageData = FakeImageData;

const { paintAtmosphere } = await import('../src/rendering/HabitableCutawayEngine');

const W = 420, H = 320;
const geom: any = { cx: 210, cyTop: 150, rx: 130, ry: 65 };

function render(): FakeImageData {
  const img = new FakeImageData(W, H);
  paintAtmosphere(img as any, geom, 'ocean', 0, 0, 1);
  return img;
}
const img = render();
const A = (x: number, y: number) => img.data[(y * W + x) * 4 + 3];
const RGB = (x: number, y: number) => {
  const o = (y * W + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
};
function hueOf([r, g, b]: number[]): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d === 0) return 0;
  let h: number;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

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
    const a = A(x, y), b = A(x, y + 1);
    if (a > 2 && b > 2) seam = Math.max(seam, Math.max(a, b) / Math.min(a, b));
  }
}

// 2. hueSplit — sunlit limb (+x) vs shadowed limb (−x)
const lit = hueOf(RGB(geom.cx + geom.rx - 2, geom.cyTop));
const dark = hueOf(RGB(geom.cx - geom.rx + 2, geom.cyTop));
let hueSplit = Math.abs(lit - dark);
if (hueSplit > 180) hueSplit = 360 - hueSplit;

// 3. thickness — how many px of non-zero alpha extend past the rim, sampled
//    at several angles around the dome
const thick: number[] = [];
for (const ang of [-2.6, -2.2, -1.8, -1.4, -1.0, -0.6]) {
  let n = 0;
  for (let t = 0; t < 30; t++) {
    const x = Math.round(geom.cx + Math.cos(ang) * (geom.rx + t));
    const y = Math.round(geom.cyTop + Math.sin(ang) * (geom.rx + t));
    if (x < 0 || y < 0 || x >= W || y >= H) break;
    if (A(x, y) > 2) n++;
  }
  thick.push(n);
}
const thickVar = Math.max(...thick) - Math.min(...thick);

// 4. innerFall — a gradient inside the rim, or a flat floor?
//    The shipped renderer decays 18 -> 4 over ~26px and then sits at exactly 4
//    for the rest of the radius. That constant is the additive tint; it is not
//    aerial perspective. Comparing 20% inward against 60% inward catches it.
const at = (fracIn: number) =>
  A(Math.round(geom.cx - geom.rx + geom.rx * fracIn), geom.cyTop);
const innerFall = at(0.20) - at(0.60);

console.log('\n  atmosphere measurements');
console.log(`    seam (max adjacent alpha ratio)        : ${seam.toFixed(2)}`);
console.log(`    hue split (lit limb vs shadow limb)    : ${hueSplit.toFixed(1)} deg`);
console.log(`    thickness variance around limb (px)    : ${thickVar}`);
console.log(`    inner falloff (a@20% - a@60%)          : ${innerFall}`);

// Calibrated against the shipped renderer: 2.67 / 0.0 / 1 / 2.
const WANT_SEAM = 2.0, WANT_HUE = 12, WANT_THICK = 2, WANT_FALL = 5;

let failed = 0;
const assert = (n: string, ok: boolean, d: string) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n} — ${d}`);
  if (!ok) failed++;
};

if (CONTROL) {
  console.log('\n  CONTROL — asserting the defects ARE present. Must PASS today.\n');
  assert('seam is visible',        seam > WANT_SEAM,        `${seam.toFixed(2)} > ${WANT_SEAM}`);
  assert('no hue split',           hueSplit < WANT_HUE,     `${hueSplit.toFixed(1)} < ${WANT_HUE}`);
  assert('thickness is uniform',   thickVar <= WANT_THICK,  `${thickVar} <= ${WANT_THICK}`);
  assert('inner falloff is flat',  innerFall < WANT_FALL,   `${innerFall} < ${WANT_FALL}`);
} else {
  console.log('\n  Asserting the atmosphere reads as air. Fails until Tasks 5-7.\n');
  assert('no visible seam',        seam <= WANT_SEAM,        `${seam.toFixed(2)} <= ${WANT_SEAM}`);
  assert('warm/cool hue split',    hueSplit >= WANT_HUE,     `${hueSplit.toFixed(1)} >= ${WANT_HUE}`);
  assert('thickness varies',       thickVar > WANT_THICK,    `${thickVar} > ${WANT_THICK}`);
  assert('aerial gradient exists', innerFall >= WANT_FALL,   `${innerFall} >= ${WANT_FALL}`);
}

process.exit(failed === 0 ? 0 : 1);
