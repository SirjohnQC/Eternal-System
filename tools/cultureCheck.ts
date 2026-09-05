/**
 * Dev-only: culture generation, validation and the bounds that keep untrusted
 * model output from breaking the simulation.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/cultureCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=$TMP/culture.mjs && node $TMP/culture.mjs
 */
import {
  cultureMultiplier, CULTURE_MULT_MIN, CULTURE_MULT_MAX,
} from '../src/simulation/Civilization';

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failures.push(name + (detail ? ': ' + detail : '')); console.log(`  FAIL  ${name}  — ${detail}`); }
}

console.log('\n═══ Culture multiplier bounds ═══');
{
  let lo = Infinity, hi = -Infinity;
  // Sweep the whole legal value space, plus values outside it — the input comes
  // from model output and cannot be assumed to be in range. Strength is swept
  // past its nominal 0–2 range too: at exactly strength=2 the formula's raw
  // (pre-clamp) extreme lands exactly on CULTURE_MULT_MIN/MAX, which would make
  // the bounds check pass even with the clamp deleted. Sweeping further out
  // forces a genuine overshoot pre-clamp, so a deleted clamp is actually caught.
  for (let v = -2; v <= 3; v += 0.001) {
    for (const strength of [0, 0.5, 1, 1.5, 2, 3, 4, 5]) {
      const m = cultureMultiplier(v, strength);
      if (!Number.isFinite(m)) { failures.push(`non-finite at v=${v} s=${strength}`); }
      lo = Math.min(lo, m); hi = Math.max(hi, m);
    }
  }
  check('multiplier stays inside its declared bounds',
        lo >= CULTURE_MULT_MIN - 1e-9 && hi <= CULTURE_MULT_MAX + 1e-9,
        `observed ${lo.toFixed(3)} … ${hi.toFixed(3)}, declared ${CULTURE_MULT_MIN} … ${CULTURE_MULT_MAX}`);
  check('multiplier is never zero', lo > 0, `min ${lo.toFixed(3)}`);
  check('NaN input yields a neutral multiplier', cultureMultiplier(NaN) === 1);
  check('a mid value is neutral', Math.abs(cultureMultiplier(0.5) - 1) < 1e-9);

  // Pin the actual safe numbers rather than deriving the assertion from the
  // constants under test — a future widening of the envelope (e.g. MAX to 5.0)
  // must fail this check even though the multiplier would still be internally
  // "consistent" with its own (now-unsafe) bounds.
  check('safety envelope is pinned to the agreed values, not just self-consistent',
        CULTURE_MULT_MIN === 0.4 && CULTURE_MULT_MAX === 2.2,
        `MIN=${CULTURE_MULT_MIN} MAX=${CULTURE_MULT_MAX}`);

  // Prove the ceiling clamp is load-bearing: at an extreme, out-of-range
  // culture value and strength, the pre-clamp value overshoots CULTURE_MULT_MAX
  // (1 + 0.5*2*4*0.6 = 3.4), so the returned value can only equal the exact
  // bound if the outer Math.min actually fired. Deleting the ceiling clamp
  // would make this return 3.4, failing the check.
  check('ceiling clamp is load-bearing for extreme culture input',
        cultureMultiplier(3, 5) === CULTURE_MULT_MAX,
        `cultureMultiplier(3, 5) = ${cultureMultiplier(3, 5)}, expected ${CULTURE_MULT_MAX}`);
  // Same proof for the floor, for symmetry (pre-clamp: 1 - 0.5*2*4*0.6 = -1.4).
  check('floor clamp is load-bearing for extreme culture input',
        cultureMultiplier(-2, 5) === CULTURE_MULT_MIN,
        `cultureMultiplier(-2, 5) = ${cultureMultiplier(-2, 5)}, expected ${CULTURE_MULT_MIN}`);
}

console.log(`\n═══ RESULT: ${passed} passed, ${failures.length} failed ═══`);
if (failures.length) { for (const f of failures) console.log('  ✗ ' + f); process.exit(1); }
console.log('All checks passed.\n');
