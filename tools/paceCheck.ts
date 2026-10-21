/**
 * Ages that press (stage-moments plan, P2), headless.
 *
 *   npm run test:pace
 *
 * Two seeds at evolution rolls 10 and 20, from the first age for 200k ticks:
 * 1. the die is a temper, not a skip button: a roll of 20 takes at least
 *    0.6x as long per age as a roll of 10;
 * 2. the people keep up with their knowledge: at each new age they are fed
 *    0.9..1.9x (it was 1.5..4.5x at a roll of 20, so nothing pressed);
 * 3. pressures do turn acute (at least one per two ages), and the turning
 *    points told as moments stay few (at most three per age);
 * 4. necessity paces study: a pressed people learns faster than a sated one.
 *
 * Exits non-zero on any failure.
 */
import { makeCanvas } from './lib/headlessDom';
const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState, runtimeState, createDefaultGameState } = await import('../src/simulation/GameState');
const { needOf } = await import('../src/simulation/Nations');

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(66)} ${detail}`);
  if (!ok) failed++;
};
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN; };

interface Run { perAge: number[]; fed: number[]; acute: number; turns: number; ages: number }
function run(seed: string, evo: number): Run {
  Object.assign(gameState, createDefaultGameState(), { playerPlanetName: 'P', playerSpeciesName: 'V', skipFormation: true, masterSeed: seed, divinePoints: 100 });
  runtimeState.playerNations = null; runtimeState.playerPlanetGrid = null;
  const stats = { life: 18, evolution: evo, hostility: 10, entropy: 10, divine: 10 };
  gameState.stats = stats;
  const e = new BigBangEngine(makeCanvas()) as any;
  e.init(stats, seed);
  for (let i = 0; i < 3000; i++) e.update();
  e.leapToEra(1);
  let turns = 0;
  e.onStageMoment = (m: any) => { if (m.kind === 'turn') turns++; };
  const ps = e.getPlayerStar(), ns = () => runtimeState.playerNations as any;
  const fedNow = () => { let y = 0, d = 0; for (const x of ns()?.nations ?? []) if (!x.fallen) { y += x.state.foodYield; d += x.state.foodNeed; } return y / Math.max(1e-9, d); };
  const out: Run = { perAge: [], fed: [], acute: 0, turns: 0, ages: 0 };
  let era = ps.civLevel, since = e.tick, prev = 0;
  for (let i = 0; i < 200_000; i++) {
    e.update();
    if (ps.civLevel > era) { out.perAge.push(e.tick - since); out.fed.push(fedNow()); since = e.tick; out.ages++; }
    era = ps.civLevel;
    if (i % 2000 === 0 && ns()?.isFounded) {
      let a = 0;
      for (const x of ns().nations) if (!x.fallen) for (const k of ['hunger', 'crowding', 'scarcity', 'unrest']) if (x.pressures[k] >= 0.5) a++;
      if (a > prev) out.acute += a - prev;
      prev = a;
    }
  }
  out.turns = turns;
  return out;
}

console.log('Ages that press');
const runs: Record<number, Run[]> = { 10: [], 20: [] };
for (const evo of [10, 20]) for (const seed of ['pace_a', 'pace_b']) {
  const r = run(seed, evo);
  runs[evo].push(r);
  console.log(`  · evo ${evo} ${seed}: ${r.ages} ages, ${r.perAge.map(t => `${(t / 1000) | 0}k`).join(' ')} ticks, fed ${r.fed.map(f => f.toFixed(2)).join(' ')}, ${r.acute} acute, ${r.turns} turning points`);
}
const per = (evo: number) => median(runs[evo].flatMap(r => r.perAge));
check('a roll of 20 takes at least 0.6x a roll of 10 per age', per(20) / per(10) >= 0.6, `${(per(20) / per(10)).toFixed(2)}x`);
const fed = [...runs[10], ...runs[20]].flatMap(r => r.fed);
check('the people keep up with what they know (fed 0.9..1.9 at a new age)', median(fed) >= 0.9 && median(fed) <= 1.9, `median ${median(fed).toFixed(2)}`);
for (const evo of [10, 20]) for (const [i, r] of runs[evo].entries()) {
  check(`evo ${evo} run ${i + 1}: pressures turn acute (at least one per two ages)`, r.acute >= Math.max(1, r.ages / 2), `${r.acute} for ${r.ages} ages`);
  check(`evo ${evo} run ${i + 1}: turning points stay few (at most three per age)`, r.turns <= Math.max(3, (r.ages + 1) * 3), `${r.turns}`);
}
check('turning points are told somewhere', [...runs[10], ...runs[20]].some(r => r.turns > 0));
const calm = { hunger: 0, crowding: 0, scarcity: 0, unrest: 0, pollution: 0 };
check('necessity paces study', needOf({ ...calm, hunger: 0.8 }) > needOf(calm) && needOf(calm) === 0.7 && needOf({ ...calm, unrest: 1 }) === 1.5);

console.log(failed ? `\n${failed} pace check(s) FAILED` : '\npace checks passed');
if (failed) process.exit(1);
