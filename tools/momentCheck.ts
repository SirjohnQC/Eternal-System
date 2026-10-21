/**
 * Great moments and leader voices (stage-moments plan, P1), headless.
 *
 *   npm run test:moments
 *
 * 1. SpeedHold: nested holds come back to the first speed only on the last
 *    release; a moment slows to ▶ and lowers what a hold returns to; the
 *    player's own speed press clears every hold.
 * 2. The engine, from first life to the ages, on fixed seeds: a moment fires
 *    once per new high (each life stage, the first nations, each age), never
 *    again when a world regains a stage or age it lost; every moment names the
 *    player's star; a leader speaks at most once per age high; a Creative leap
 *    is one moment. A save's present counts as already seen.
 *
 * Exits non-zero on any failure.
 */
import { makeCanvas } from './lib/headlessDom';
const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState, runtimeState, createDefaultGameState } = await import('../src/simulation/GameState');
const { SpeedHold } = await import('../src/ui/SpeedHold');
const { paceOf } = await import('../src/simulation/Formation');

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(66)} ${detail}`);
  if (!ok) failed++;
};

console.log('Speed holds');
{
  const h = new SpeedHold();
  let speed = 1000;
  speed = h.hold('dice', speed, 1);
  speed = h.hold('naming', speed, 1);
  check('a second hold does not forget the first speed', h.release('dice') === null && h.release('naming') === 1000);
  speed = 1000;
  speed = h.hold('dice', speed, 1);
  check('a moment under a hold changes nothing now', h.moment(speed, 2) === null);
  check('… but the hold then returns to ▶, not 1000×', h.release('dice') === 2);
  check('a moment slows a fast game to ▶', h.moment(200, 2) === 2 && h.moment(2, 2) === null && h.moment(0, 2) === null);
  h.hold('dice', 1000, 1);
  h.clear();
  check('the player pressing a speed clears every hold', !h.held && h.release('dice') === null);
  check('releasing what was never held does nothing', h.release('ghost') === null);
}

console.log('The pace die (Q2)');
check('a roll of 10 keeps its pace', Math.abs(paceOf(10) - 1.1) < 1e-9);
check('a roll of 20 is only a little quicker', paceOf(20) >= 0.8 && paceOf(20) / paceOf(10) >= 0.7, paceOf(20).toFixed(3));
check('the whole die spans less than 2x', paceOf(1) / paceOf(20) < 2, (paceOf(1) / paceOf(20)).toFixed(2));

function reset(seed: string): any {
  Object.assign(gameState, createDefaultGameState(), {
    playerPlanetName: 'Momentworld', playerSpeciesName: 'Velari', skipFormation: true, masterSeed: seed,
  });
  runtimeState.playerPlanetGrid = null;
  runtimeState.playerNations = null;
  const stats = { life: 18, evolution: 20, hostility: 10, entropy: 12, divine: 10 };
  gameState.stats = stats;
  const e = new BigBangEngine(makeCanvas()) as any;
  e.init(stats, seed);
  return e;
}

console.log('Moments on the player\'s world');
for (const seed of ['moments_a', 'moments_c']) {
  const e = reset(seed);
  const moments: any[] = [], voices: number[] = [];
  e.onStageMoment = (m: any) => moments.push(m);
  e.onLeaderMessage = () => voices.push(e.getPlayerStar()?.civLevel ?? -1);
  let bioHigh = -1, eraHigh = 0, bioLows = 0, eraLows = 0, prevBio = -1, prevEra = 0;
  const seq = ['microbial', 'multicellular', 'complex', 'primitive', 'intelligent'];
  for (let i = 0; i < 200_000; i++) {
    e.update();
    if (i % 50) continue;
    const ps = e.getPlayerStar();
    if (!ps) break;
    const b = ps.hasLife ? seq.indexOf(ps.biologyPhase) : -1, era = ps.civLevel;
    if (b < prevBio) bioLows++;
    if (era < prevEra) eraLows++;
    bioHigh = Math.max(bioHigh, b); eraHigh = Math.max(eraHigh, era);
    prevBio = b; prevEra = era;
  }
  const ps = e.getPlayerStar();
  const bio = moments.filter(m => m.kind === 'bio'), eras = moments.filter(m => m.kind === 'era'), nat = moments.filter(m => m.kind === 'nations');
  const titles = (xs: any[]) => xs.map(m => m.title);
  const label = `${seed}: life ${bioHigh}, age ${eraHigh}${bioLows || eraLows ? `, ${bioLows} life and ${eraLows} age setbacks` : ''}`;
  console.log(`  · ${label} — ${moments.map(m => m.title).join(' → ')}`);
  check(`${seed}: one life moment per new stage, never repeated`, bio.length <= Math.max(0, bioHigh) && new Set(titles(bio)).size === bio.length, titles(bio).join(', '));
  check(`${seed}: one age moment per new age, never repeated`, eras.length === eraHigh && new Set(titles(eras)).size === eras.length, `${eras.length} for ${eraHigh}`);
  check(`${seed}: the first nations are a moment once`, nat.length === (runtimeState.playerNations?.isFounded || gameState.momentHigh?.nations ? 1 : 0), `${nat.length}`);
  check(`${seed}: every moment names the player's star`, moments.every(m => m.starId === ps?.id));
  check(`${seed}: a leader speaks at most once per age`, voices.length <= eraHigh && new Set(voices).size === voices.length, `${voices.length} for ${eraHigh} ages`);
}

console.log('A Creative leap, and a reload');
{
  const e = reset('moments_leap');
  const moments: any[] = [];
  e.onStageMoment = (m: any) => moments.push(m);
  for (let i = 0; i < 3_000; i++) e.update();
  e.leapToEra(4);
  check('a leap of many ages is one moment', moments.filter(m => m.kind !== 'bio').length === 1 && moments[moments.length - 1]?.kind === 'leap',
    moments.map(m => m.kind).join(','));
  // A fall is told as a moment, once, with its cause (alpha round 2).
  const before = moments.length;
  e.shiftEra(e.getPlayerStar(), 2, 'an asteroid struck the world');
  const falls = moments.slice(before).filter(m => m.kind === 'fall');
  check('a fall is a moment that says why', falls.length === 1 && /asteroid/i.test(falls[0].line), falls.map(m => m.line).join(' | '));
  // A save from before the moments: its present is already seen.
  const snap = JSON.parse(JSON.stringify(e.serialize()));
  delete gameState.momentHigh;
  const b = new BigBangEngine(makeCanvas()) as any;
  b.init(gameState.stats, 'moments_leap');
  b.loadState(snap);
  const again: any[] = [];
  b.onStageMoment = (m: any) => again.push(m);
  for (let i = 0; i < 2_000; i++) b.update();
  check('an old save does not replay its past as moments', again.every(m => m.kind === 'turn' || (m.kind === 'era' && m.title !== moments[moments.length - 1].title)),
    again.map(m => m.title).join(',') || 'none');
}

console.log(failed ? `\n${failed} moment check(s) FAILED` : '\nmoment checks passed');
if (failed) process.exit(1);
