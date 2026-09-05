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
  // from model output and cannot be assumed to be in range.
  for (let v = -2; v <= 3; v += 0.001) {
    for (const strength of [0, 0.5, 1, 1.5, 2]) {
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
}

console.log(`\n═══ RESULT: ${passed} passed, ${failures.length} failed ═══`);
if (failures.length) { for (const f of failures) console.log('  ✗ ' + f); process.exit(1); }
console.log('All checks passed.\n');
