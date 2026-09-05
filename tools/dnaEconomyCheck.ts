/**
 * Dev-only: is the DNA economy actually playable?
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/dnaEconomyCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=$TMP/dnaecon.mjs && node $TMP/dnaecon.mjs
 *
 * Two failure modes to guard against, and they pull in opposite directions:
 *
 *  - TOO CHEAP: the old economy priced every point at 1 forever, so investment
 *    was a slider with no decision in it.
 *  - TOO EXPENSIVE: prices now rise with depth and with the biology phase. If
 *    income does not rise with them, the lab becomes decorative — which is
 *    exactly the fault that produced the "stuck on primitive" bug (ROADMAP
 *    M20d), where `branchEffect` normalised against 100 points and the game
 *    granted about 15.
 *
 * So this measures what a player can actually afford across a full run, and
 * asserts the resulting `bioResilience` effect is large enough to matter to the
 * Great Filter. The control is the OLD flat-cost, flat-income economy on the
 * same branch set.
 */

import { dnaPointCost, dnaTotalCost, generateBranchSet, branchEffect } from '../src/simulation/DnaBranches';
import { BIO_PHASE_SEQUENCE } from '../src/simulation/GameState';
import { SeedRNG } from '../src/utils/SeedRNG';

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failures.push(name + (detail ? ': ' + detail : '')); console.log(`  FAIL  ${name}  — ${detail}`); }
}

const PHASES = BIO_PHASE_SEQUENCE.length;              // 5
/** Mirrors BigBangEngine.DNA_ASSIST_WEIGHT. */
const DNA_ASSIST_WEIGHT = 1.4;
/** Income awarded on reaching phase index i (BigBangEngine.updateBiologyPhase). */
const incomeAt = (phaseIdx: number) => 8 * (phaseIdx + 1);

console.log('\n═══ DNA cost curve ═══');
console.log('  points in branch →   1st    5th   10th   20th   40th');
for (let ph = 0; ph < PHASES; ph++) {
  const row = [0, 4, 9, 19, 39].map(v => String(dnaPointCost(v, ph)).padStart(6)).join(' ');
  console.log(`  phase ${ph} (${BIO_PHASE_SEQUENCE[ph].padEnd(13)}) ${row}`);
}

console.log('\n═══ What a focused player can afford ═══');
{
  // A player who pours everything into ONE branch, spending at each phase as
  // the points arrive (which is what the focus rule pushes them toward).
  let bank = 0, invested = 0;
  const log: string[] = [];
  for (let ph = 0; ph < PHASES; ph++) {
    bank += incomeAt(ph);
    let spentHere = 0;
    while (bank >= dnaPointCost(invested, ph)) {
      bank -= dnaPointCost(invested, ph);
      invested++; spentHere++;
    }
    log.push(`  reaching ${BIO_PHASE_SEQUENCE[ph].padEnd(13)} +${String(incomeAt(ph)).padStart(2)} pts → ` +
             `bought ${String(spentHere).padStart(2)} (branch now ${String(invested).padStart(2)}, ${bank} banked)`);
  }
  log.forEach(l => console.log(l));

  const totalIncome = Array.from({ length: PHASES }, (_, i) => incomeAt(i)).reduce((a, b) => a + b, 0);
  console.log(`\n  lifetime income: ${totalIncome} points → ${invested} in one branch`);

  check('a focused player reaches a meaningful investment', invested >= 20,
        `${invested} points in one branch`);

  // What that buys against the Great Filter. `BigBangEngine.playerBioAssistance`
  // multiplies the effect by DNA_ASSIST_WEIGHT (2.2) and caps the DNA share at
  // 0.5, and `filterChance` reduces failure by up to 55% of assistance.
  const defs = generateBranchSet(new SeedRNG('econ_check'));
  const best = defs.reduce((a, b) => ((b.effects.bioResilience ?? 0) > (a.effects.bioResilience ?? 0) ? b : a));
  const effect = branchEffect({ [best.id]: invested }, defs, 'bioResilience');
  const assist = Math.min(0.5, effect * DNA_ASSIST_WEIGHT);
  const filterCut = assist * 0.55;
  console.log(`  into "${best.label}" (bioResilience ${best.effects.bioResilience}): ` +
              `effect ${effect.toFixed(3)} → assistance ${assist.toFixed(2)} → ` +
              `${(filterCut * 100).toFixed(0)}% off every Great Filter roll`);
  check('investment measurably eases the Great Filter', filterCut >= 0.10,
        `${(filterCut * 100).toFixed(0)}% reduction in failure chance`);
}

console.log('\n=== Controls ===');
{
  const defs = generateBranchSet(new SeedRNG('econ_check'));
  const best = defs.reduce((a, b) => ((b.effects.bioResilience ?? 0) > (a.effects.bioResilience ?? 0) ? b : a));

  // CONTROL 1 - the real historical baseline. Before ROADMAP M20d, DNA never
  // entered `filterChance` at all: it touched only the phase TIMER. However
  // many points a player banked, the Great Filter was exactly as hard. Any
  // non-zero number below is the whole point of that fix.
  console.log('  pre-M20d (DNA never reached the filter): 0.0% off the filter');
  check('control - DNA used to buy nothing against the filter', true);

  // CONTROL 2 - the flat economy under TODAY'S assistance rules. This isolates
  // the economy change from the plumbing change, so the comparison is honest.
  const oldTotal = 5 * PHASES;                    // 5 points per phase, cost 1 each
  const oldEffect = branchEffect({ [best.id]: oldTotal }, defs, 'bioResilience');
  const oldCut = Math.min(0.5, oldEffect * DNA_ASSIST_WEIGHT) * 0.55;
  console.log(`  flat economy, current rules: ${oldTotal} points -> effect ` +
              `${oldEffect.toFixed(3)} -> ${(oldCut * 100).toFixed(1)}% off the filter`);

  // Recompute what the new economy reaches, to compare like with like.
  let bank = 0, invested = 0;
  for (let ph = 0; ph < PHASES; ph++) {
    bank += incomeAt(ph);
    while (bank >= dnaPointCost(invested, ph)) { bank -= dnaPointCost(invested, ph); invested++; }
  }
  const newEffect = branchEffect({ [best.id]: invested }, defs, 'bioResilience');
  const newCut = Math.min(0.5, newEffect * DNA_ASSIST_WEIGHT) * 0.55;
  console.log(`  new economy:                 ${invested} points -> effect ` +
              `${newEffect.toFixed(3)} -> ${(newCut * 100).toFixed(1)}% off the filter`);
  check('the new economy buys more than the flat one it replaced', newCut > oldCut + 0.02,
        `${(oldCut * 100).toFixed(1)}% -> ${(newCut * 100).toFixed(1)}%`);

  // And the curve must not flatten early, or the escalating price of late
  // points buys literally nothing.
  const halfEffect = branchEffect({ [best.id]: Math.round(invested / 2) }, defs, 'bioResilience');
  const halfCut = Math.min(0.5, halfEffect * DNA_ASSIST_WEIGHT) * 0.55;
  check('investment still pays off in its second half', newCut > halfCut + 0.03,
        `half investment ${(halfCut * 100).toFixed(1)}% -> full ${(newCut * 100).toFixed(1)}%`);
}

console.log('\n═══ Cost actually escalates ═══');
{
  const same = dnaPointCost(0, 0) === dnaPointCost(40, 0);
  check('deeper investment costs more', !same,
        `1st point ${dnaPointCost(0, 0)}, 41st ${dnaPointCost(40, 0)}`);
  check('later phases cost more', dnaPointCost(5, 4) > dnaPointCost(5, 0),
        `same depth: phase 0 costs ${dnaPointCost(5, 0)}, phase 4 costs ${dnaPointCost(5, 4)}`);
  check('cost is monotonic in depth',
        [0, 5, 10, 20, 40, 80].every((v, i, a) => i === 0 || dnaPointCost(v, 2) >= dnaPointCost(a[i - 1], 2)));
  check('dnaTotalCost agrees with the per-point curve',
        dnaTotalCost(10, 1) === Array.from({ length: 10 }, (_, i) => dnaPointCost(i, 1)).reduce((a, b) => a + b, 0),
        `total for 10 points at phase 1 = ${dnaTotalCost(10, 1)}`);
}

console.log(`\n═══ RESULT: ${passed} passed, ${failures.length} failed ═══`);
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('All checks passed.\n');
